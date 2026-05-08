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
        `Install with: npm install pdfjs-dist@^4.10.38\nUnderlying error: ${msg}`
    );
  }
}

export interface ExtractPdfWithOcrOptions {
  /**
   * Tesseract language pack(s). Default `'eng'`. Multi-lang via `'+'`,
   * e.g. `'eng+rus'` for English+Russian mixed documents. The trained-data
   * file for each language downloads on first use into Tesseract's cache.
   */
  langs?: string;
  /**
   * Page range (1-indexed inclusive). Default: all pages. Useful for
   * partial OCR of long documents — OCR is the slowest step in the
   * pipeline (~1-2s per page), so a 100-page paper takes minutes.
   */
  pages?: [number, number];
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

/**
 * Extract text from an image-only / scanned PDF via Tesseract OCR.
 *
 * Caller has already loaded the file into a Buffer (use
 * `vault.readBinaryFile(relPath)` for vault-aware reading with
 * privacy-filter + max-bytes guards applied).
 *
 * Throws on encrypted PDFs, hard-corrupt files, or missing optional deps.
 * Returns empty pages (with `isEmpty: true`) for pages where Tesseract
 * found nothing.
 */
export async function extractPdfWithOcr(buffer: Buffer, opts: ExtractPdfWithOcrOptions = {}): Promise<OcrPdfResult> {
  const langs = opts.langs ?? "eng";
  const scale = Math.max(0.5, Math.min(opts.scale ?? 2, 4)); // clamp to [0.5, 4]

  // Load all three lazy deps in parallel — they're independent.
  const [pdfjs, canvasMod, tesseract] = await Promise.all([loadPdfjs(), loadCanvas(), loadTesseract()]);
  const { createCanvas } = canvasMod;

  // Initialize the PDF document.
  const data = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const loadingTask = pdfjs.getDocument({
    data,
    isEvalSupported: false,
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

        await page.render({
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
