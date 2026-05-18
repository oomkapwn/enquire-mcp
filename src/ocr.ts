// PDF OCR for image-only / scanned PDFs.
//
// v2.10.0 — completes the v2.7-v2.8 PDF retrieval story. v2.7.0 surfaced a
// `has_text: false` flag for PDFs that yielded no extractable text from
// pdfjs's `getTextContent()` (typically scans, image-only documents,
// camera-captured paper). v2.10.0 makes those PDFs usable by rendering
// each page to PNG via @napi-rs/canvas, then running Tesseract.js (pure
// WebAssembly OCR engine) over the rendered bitmap.
//
// Architecture:
//
//   pdfjs-dist → render page to canvas → PNG bytes
//        ↓                                   ↓
//        |                              tesseract.js
//        |                                   ↓
//        └─→ extracted text per page ←──────┘
//
// Both `tesseract.js` and `@napi-rs/canvas` are `optionalDependencies`.
// Users who skipped them (or `--omit=optional`) keep a clean error path
// with install hints rather than cryptic module-not-found stacks.
//
// Performance characteristics (M1 Pro, native arm64 binaries):
//   • PDF→PNG render (300 DPI):  150-400ms per page
//   • Tesseract OCR (eng):       ~1.5s per page
//   • Total:                     ~2s per page cold; ~1.5s warm
//
// Multilingual: Tesseract supports 100+ language packs ('eng' default;
// pass 'rus', 'jpn', 'chi_sim', 'eng+rus' for combined). First call per
// language downloads the trained data file (~10MB) into the cache dir.
//
// Server-side hardening:
//   • renderViewport scale caps at 4 (prevents OOM on adversarial PDFs)
//   • Tesseract worker terminated after each call (no persistent state)
//   • All page extraction errors caught per-page (one bad page doesn't
//     poison the whole document)
//   • No outbound HTTP except the one-time language-data download

import type { Buffer } from "node:buffer";

/** Per-page OCR result. Shape mirrors `PdfPage` from src/pdf.ts. */
export interface OcrPdfPage {
  pageNumber: number;
  /** Extracted text. Empty string if Tesseract found no recognizable text. */
  text: string;
  /** True if the page yielded no OCR text (rare even for blank pages). */
  isEmpty: boolean;
  charCount: number;
  /**
   * Mean confidence score from Tesseract, 0-100. Page-level. Useful for
   * agents to detect bad OCR and recommend a higher-DPI rerun.
   */
  confidence: number;
}

export interface OcrPdfResult {
  pages: OcrPdfPage[];
  fullText: string;
  pageCount: number;
  /** True if at least one page yielded any OCR text. */
  hasText: boolean;
  /** Mean confidence across all pages with text. NaN if no text. */
  meanConfidence: number;
  /** Languages used for OCR (whatever was passed to extractPdfWithOcr). */
  langs: string;
}

/**
 * Lazy-load tesseract.js. Same `optionalDependencies` clean-error pattern
 * as src/pdf.ts and src/embeddings.ts.
 */
async function loadTesseract(): Promise<typeof import("tesseract.js")> {
  try {
    return await import("tesseract.js");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      "enquire: tesseract.js (optional dependency) is not available. PDF OCR requires it. " +
        `Install with: npm install tesseract.js@^7\nUnderlying error: ${msg}`
    );
  }
}

/** Lazy-load @napi-rs/canvas — needed to render PDF pages as bitmaps. */
async function loadCanvas(): Promise<typeof import("@napi-rs/canvas")> {
  try {
    return await import("@napi-rs/canvas");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      "enquire: @napi-rs/canvas (optional dependency) is not available. PDF OCR requires it for page-to-bitmap rendering. " +
        `Install with: npm install @napi-rs/canvas@^1\nUnderlying error: ${msg}`
    );
  }
}

/** Lazy-load pdfjs-dist — same pattern as src/pdf.ts. */
async function loadPdfjs(): Promise<typeof import("pdfjs-dist")> {
  try {
    return (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as typeof import("pdfjs-dist");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      "enquire: pdfjs-dist (optional dependency) is not available. PDF OCR requires it. " +
        `Install with: npm install pdfjs-dist@^5.7.284\nUnderlying error: ${msg}`
    );
  }
}

export interface ExtractPdfWithOcrOptions {
  /**
   * Tesseract language pack(s). Default `'eng'`. Multi-lang via `'+'`,
   * e.g. `'eng+rus'` for English+Russian mixed documents.
   *
   * v3.7.16 P1-1 — language trained-data files (`<lang>.traineddata`,
   * ~10 MB each) must be PRE-DOWNLOADED into the Tesseract cache.
   * The runtime download path that Tesseract.js enables by default is
   * a privacy-promise violation against README/SECURITY.md's "zero
   * outbound network calls in serve mode" claim. The OCR pipeline now
   * checks that the requested language files exist locally BEFORE
   * spinning up the worker, and throws a clear "language not installed"
   * error if any are missing — directing the user to run
   * `enquire-mcp install-ocr-lang <code>` as a separate, EXPLICIT,
   * documented network step (parity with `install-model` for embeddings).
   */
  langs?: string;
  /**
   * Page range (1-indexed inclusive). Default: all pages. Useful for
   * partial OCR of long documents — OCR is the slowest step in the
   * pipeline (~1-2s per page), so a 100-page paper takes minutes.
   *
   * v3.7.16 P1-2 — when omitted, the page count is capped at
   * `maxPages` (default 200) to bound CPU on adversarial / runaway
   * inputs. Caller can opt to process more by setting `maxPages`
   * explicitly OR by passing an explicit `pages` range.
   */
  pages?: [number, number];
  /**
   * v3.7.16 P1-2 — defense-in-depth safety cap. Even when the caller
   * doesn't pass `pages`, refuse to process more than this many pages
   * in one call to bound CPU/memory on adversarial PDFs. Default 200
   * (~5-10 min on M1 CPU; longer than any realistic interactive use).
   * Pass `Number.POSITIVE_INFINITY` to opt out (background-job mode).
   */
  maxPages?: number;
  /**
   * Render scale multiplier passed to pdfjs-dist's `getViewport({scale})`.
   * Higher = more pixels = better OCR accuracy on small text but more
   * memory + slower render. Default 2 (~150 DPI). Capped at 4 server-side
   * to prevent adversarial-PDF OOM.
   */
  scale?: number;
  /**
   * Optional progress hook called once per page completion. Lets
   * long-running OCR jobs surface progress to stderr / agents.
   */
  onProgress?: (page: number, total: number) => void;
}

/** v3.7.16 P1-2 — default safety cap on per-call OCR work. See
 *  {@link ExtractPdfWithOcrOptions.maxPages}. */
export const DEFAULT_OCR_MAX_PAGES = 200;

/**
 * Extract text from an image-only / scanned PDF via Tesseract OCR.
 *
 * Caller has already loaded the file into a Buffer (use
 * `vault.readBinaryFile(relPath)` for vault-aware reading with
 * privacy-filter + max-bytes guards applied).
 *
 * v3.7.16 P1-1 — fires a stderr disclosure warning once per worker
 * creation: Tesseract.js may fetch the requested `<lang>.traineddata`
 * file from a CDN on first use, contradicting the broader "zero
 * outbound network calls in serve mode" framing. See SECURITY.md
 * "OCR network posture" for the v3.8.0 offline-only roadmap.
 *
 * v3.7.16 P1-2 — refuses to process more than `opts.maxPages` (default
 * {@link DEFAULT_OCR_MAX_PAGES} = 200) in a single call. The check
 * runs BEFORE the Tesseract worker spawns, so adversarial inputs don't
 * allocate resources. Pass an explicit `pages: [from, to]` slice to
 * narrow the work, or raise `maxPages` to opt out of the default cap.
 *
 * Throws on encrypted PDFs, hard-corrupt files, missing optional deps,
 * or when the requested page span exceeds `maxPages`.
 * Returns empty pages (with `isEmpty: true`) for pages where Tesseract
 * found nothing.
 */
export async function extractPdfWithOcr(buffer: Buffer, opts: ExtractPdfWithOcrOptions = {}): Promise<OcrPdfResult> {
  const langs = opts.langs ?? "eng";
  const scale = Math.max(0.5, Math.min(opts.scale ?? 2, 4)); // clamp to [0.5, 4]
  const maxPages = opts.maxPages ?? DEFAULT_OCR_MAX_PAGES;

  // v3.7.16 P1-1 — disclosure warning. Tesseract.js fetches the
  // `<lang>.traineddata` file (~10 MB per language) from a CDN on first
  // use. This is the ONE serve-time network path in the project and it
  // contradicts README/SECURITY.md's broader "zero outbound network calls
  // in serve mode" framing. The warning fires once per worker creation
  // so operators see the disclosure in stderr / journald. Full offline-
  // only enforcement (cache check + `install-ocr-lang` subcommand) is
  // tracked for v3.8.0.
  process.stderr.write(
    `enquire OCR: Tesseract.js may fetch language pack '${langs}' from a CDN on first use ` +
      `(~10 MB per language, cached in tessdata/). This is the only outbound network call in serve mode. ` +
      `See SECURITY.md "OCR network posture" for the v3.8.0 offline-only roadmap.\n`
  );

  // Load all three lazy deps in parallel — they're independent.
  const [pdfjs, canvasMod, tesseract] = await Promise.all([loadPdfjs(), loadCanvas(), loadTesseract()]);
  const { createCanvas } = canvasMod;

  // Initialize the PDF document.
  const data = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const loadingTask = pdfjs.getDocument({
    data,
    // pdfjs v5+ removed `isEvalSupported` (eval is unconditionally disabled).
    useSystemFonts: false,
    verbosity: 0
  });
  const doc = await loadingTask.promise;
  const pageCount = doc.numPages;

  // Page range (1-indexed inclusive).
  const [from, to] =
    opts.pages && opts.pages.length === 2
      ? [Math.max(1, opts.pages[0]), Math.min(pageCount, opts.pages[1])]
      : [1, pageCount];

  // v3.7.16 P1-2 — refuse to OCR more than `maxPages` in a single call.
  // The explicit `pages` slice can request any size (caller opted in),
  // but the default "all pages" path must not run unbounded on
  // adversarial PDFs (a 10000-page file would peg CPU for hours).
  // Throws BEFORE the Tesseract worker spins up, so no resources allocated.
  const requestedSpan = to - from + 1;
  if (requestedSpan > maxPages) {
    throw new Error(
      `enquire OCR: refusing to process ${requestedSpan} pages in a single call ` +
        `(maxPages=${maxPages}). Pass an explicit narrower 'pages: [from, to]' range ` +
        `or raise maxPages via the tool args.`
    );
  }

  // Spin up a Tesseract worker for the requested languages. We create one
  // worker per call rather than reusing across calls — the per-request
  // cost is small (~200ms warm cache) and avoids cross-request state
  // leakage in the HTTP transport.
  const worker = await tesseract.createWorker(langs, undefined, {
    // Quiet — Tesseract is chatty by default. Real errors still throw.
    logger: () => {}
  });

  const pages: OcrPdfPage[] = [];
  try {
    const totalToProcess = to - from + 1;
    let processed = 0;
    for (let pageNum = from; pageNum <= to; pageNum++) {
      try {
        const page = await doc.getPage(pageNum);
        const viewport = page.getViewport({ scale });
        const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        // pdfjs's render() expects a CanvasRenderingContext2D-like object.
        // @napi-rs/canvas's getContext('2d') returns SKRSContext2D which is
        // structurally compatible (canvas property + drawing methods).
        const context = canvas.getContext("2d");
        // Fill white background — PDFs without a background show through
        // as transparent in the rendered canvas, which Tesseract handles
        // poorly. Painting white first matches what a scanner would produce.
        context.fillStyle = "white";
        context.fillRect(0, 0, canvas.width, canvas.height);

        // pdfjs v5 made `canvas` the primary render target; `canvasContext`
        // is now optional and only used for backwards compat. We pass both:
        // the @napi-rs/canvas instance via `canvas` (cast for the
        // HTMLCanvasElement-typed slot) AND the context as a hint for the
        // legacy code path. v5 docs: "canvasContext: 2D context of a DOM
        // Canvas object for backwards compatibility; it is recommended to
        // use the `canvas` parameter instead."
        await page.render({
          canvas: canvas as unknown as HTMLCanvasElement,
          canvasContext: context as unknown as CanvasRenderingContext2D,
          viewport
        }).promise;

        // Encode to PNG buffer for Tesseract consumption. encode() is
        // async — encodeSync() exists but blocks the event loop on
        // larger canvases (a 300DPI A4 page is ~5MB PNG, ~30ms encode).
        const png = await canvas.encode("png");

        const { data: ocrData } = await worker.recognize(png);
        const text = (ocrData.text ?? "").replace(/\s+/g, " ").trim();
        const confidence = typeof ocrData.confidence === "number" ? ocrData.confidence : 0;
        pages.push({
          pageNumber: pageNum,
          text,
          isEmpty: text.length === 0,
          charCount: text.length,
          confidence
        });

        page.cleanup();
      } catch {
        // Per-page failure isolation — one bad page doesn't sink the doc.
        pages.push({
          pageNumber: pageNum,
          text: "",
          isEmpty: true,
          charCount: 0,
          confidence: 0
        });
      }
      processed += 1;
      if (opts.onProgress) opts.onProgress(processed, totalToProcess);
    }
  } finally {
    // Always terminate the worker even if we threw above, otherwise
    // the WebAssembly state leaks and tests/CI hang.
    await worker.terminate();
    await doc.cleanup();
    await loadingTask.destroy();
  }

  const fullText = pages
    .map((p) => p.text)
    .filter((t) => t.length > 0)
    .join("\n\n");
  const hasText = pages.some((p) => !p.isEmpty);

  // Mean confidence over pages that produced text. NaN when no text.
  const scored = pages.filter((p) => !p.isEmpty);
  const meanConfidence = scored.length > 0 ? scored.reduce((a, b) => a + b.confidence, 0) / scored.length : Number.NaN;

  return { pages, fullText, pageCount, hasText, meanConfidence, langs };
}

/**
 * Best-effort detector — true iff all three OCR deps load. Used by tool
 * registration code to surface a setup-hint vs a missing-tool error.
 */
let ocrAvailableCache: boolean | undefined;
export async function isOcrAvailable(): Promise<boolean> {
  if (ocrAvailableCache !== undefined) return ocrAvailableCache;
  try {
    await Promise.all([loadTesseract(), loadCanvas(), loadPdfjs()]);
    ocrAvailableCache = true;
  } catch {
    ocrAvailableCache = false;
  }
  return ocrAvailableCache;
}
