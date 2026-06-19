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
import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { optionalDepDetail } from "./optional-dep.js";

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
    // rc.55 (OPTDEP-MODULE-PATH-LEAK-02) — code only; err.message embeds the importing file's abs path.
    throw new Error(
      "enquire: tesseract.js (optional dependency) is not available. PDF OCR requires it. " +
        `Install with: npm install tesseract.js@^7 (${optionalDepDetail(err)})`
    );
  }
}

/** Lazy-load @napi-rs/canvas — needed to render PDF pages as bitmaps. */
async function loadCanvas(): Promise<typeof import("@napi-rs/canvas")> {
  try {
    return await import("@napi-rs/canvas");
  } catch (err) {
    // rc.55 (OPTDEP-MODULE-PATH-LEAK-02) — code only; err.message embeds the importing file's abs path.
    throw new Error(
      "enquire: @napi-rs/canvas (optional dependency) is not available. PDF OCR requires it for page-to-bitmap rendering. " +
        `Install with: npm install @napi-rs/canvas@^1 (${optionalDepDetail(err)})`
    );
  }
}

/** Lazy-load pdfjs-dist — same pattern as src/pdf.ts. */
async function loadPdfjs(): Promise<typeof import("pdfjs-dist")> {
  try {
    return (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as typeof import("pdfjs-dist");
  } catch (err) {
    // rc.55 (OPTDEP-MODULE-PATH-LEAK-02) — code only; err.message embeds the importing file's abs path.
    throw new Error(
      "enquire: pdfjs-dist (optional dependency) is not available. PDF OCR requires it. " +
        `Install with: npm install pdfjs-dist@^6.0.227 (${optionalDepDetail(err)})`
    );
  }
}

export interface ExtractPdfWithOcrOptions {
  /**
   * Tesseract language pack(s). Default `'eng'`. Multi-lang via `'+'`,
   * e.g. `'eng+rus'` for English+Russian mixed documents.
   *
   * v3.9.0-rc.10 (overclaim #16, ENFORCED) — language trained-data files
   * (`<lang>.traineddata`, ~10 MB each) must be PRE-DOWNLOADED into the local
   * tessdata cache ({@link resolveTessdataDir}). Tesseract.js would otherwise
   * silently CDN-fetch them on first use, violating README/SECURITY.md's "zero
   * outbound network calls in serve mode" guarantee. {@link assertOcrLangsInstalled}
   * verifies every requested pack exists locally BEFORE the worker is created
   * and throws (fail-closed) if any are missing — directing the user to run
   * `enquire-mcp install-ocr-lang <code>` (an explicit, opt-in network step,
   * parity with `install-model` for embeddings). The worker is additionally
   * pinned to the local cache (`langPath` + `cacheMethod: "readOnly"`), so no
   * runtime download path remains.
   */
  langs?: string;
  /**
   * Directory holding the Tesseract `<lang>.traineddata` packs. Defaults to
   * {@link resolveTessdataDir}. Overriding it points both the pre-flight
   * existence check and the worker's `langPath` at a custom location (used by
   * the env-gated offline test).
   */
  langPath?: string;
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
 * v3.9.0-rc.10 — absolute cap on a rendered OCR page's largest pixel side.
 * The `scale` clamp ([0.5, 4]) bounds the MULTIPLIER, not the absolute pixel
 * count: a PDF MediaBox can be up to 14400×14400 pt (per the PDF spec), which
 * even at scale 1 renders to a multi-GB canvas → OOM. `extractPdfWithOcr`
 * lowers the per-page scale so the larger rendered side never exceeds this.
 */
export const MAX_OCR_CANVAS_DIM = 5000;

/**
 * v3.9.0-rc.10 — compute the effective render scale so the LARGER rendered page
 * side never exceeds {@link MAX_OCR_CANVAS_DIM}. The `scale` clamp ([0.5, 4])
 * bounds only the multiplier; this bounds the absolute pixel count, preventing
 * an OOM on an adversarially huge PDF MediaBox. Returns the requested scale
 * unchanged for normal-size pages.
 *
 * @param baseWidth - Page width in pt at scale 1.
 * @param baseHeight - Page height in pt at scale 1.
 * @param requestedScale - The caller's (already [0.5,4]-clamped) scale.
 * @returns The effective scale to render at (≤ requestedScale).
 */
export function clampOcrScale(baseWidth: number, baseHeight: number, requestedScale: number): number {
  const maxBaseDim = Math.max(baseWidth, baseHeight, 1);
  // v3.10.0-rc.44 (M2) — NO lower floor. The prior `Math.max(0.1, …)` floor OVERRODE the
  // cap for a huge MediaBox: once 5000/maxBaseDim < 0.1 (any side > 50,000pt) it forced
  // the scale back up to 0.1, so a 1,000,000pt page rendered at 100,000px → a ~40GB RGBA
  // canvas → OOM (the exact failure the cap exists to stop; pdfjs does NOT enforce the
  // PDF spec's 14,400pt MediaBox limit). The cap-derived ratio IS the safe ceiling, and
  // requestedScale is already [0.5,4]-clamped upstream so it can't be ≤0. The call site
  // additionally hard-caps the final pixel dims (belt + braces).
  return Math.min(requestedScale, MAX_OCR_CANVAS_DIM / maxBaseDim);
}

/**
 * v3.9.0-rc.10 — resolve + validate a 1-indexed inclusive OCR page range
 * against the document's page count. Clamps to `[1, pageCount]`; throws on an
 * inverted/empty range (e.g. `pages:[5,2]`) instead of silently returning zero
 * pages (which a caller could misread as "image-only scan, no text").
 *
 * @param pages - Optional `[from, to]` request (1-indexed inclusive).
 * @param pageCount - Total pages in the document.
 * @returns The clamped `[from, to]` range.
 * @throws {Error} If the resolved range is empty/inverted.
 */
export function resolveOcrPageRange(pages: [number, number] | undefined, pageCount: number): [number, number] {
  const from = pages && pages.length === 2 ? Math.max(1, pages[0]) : 1;
  const to = pages && pages.length === 2 ? Math.min(pageCount, pages[1]) : pageCount;
  if (to - from + 1 < 1) {
    throw new Error(
      `enquire OCR: invalid page range — resolved to [${from}, ${to}]. 'from' must be ≤ 'to' and within the document.`
    );
  }
  return [from, to];
}

/**
 * Resolve the local directory that holds Tesseract `<lang>.traineddata` packs
 * (v3.9.0-rc.10 — overclaim #16 offline enforcement). Precedence:
 *   1. `$ENQUIRE_TESSDATA_DIR` (explicit override),
 *   2. `$XDG_CACHE_HOME/enquire-mcp/tessdata`,
 *   3. `~/.cache/enquire-mcp/tessdata`.
 * This is where `enquire-mcp install-ocr-lang <code>` downloads packs and where
 * `extractPdfWithOcr` reads them — so `serve` makes no runtime CDN fetch.
 *
 * @returns Absolute path to the tessdata cache directory.
 */
export function resolveTessdataDir(): string {
  const override = process.env.ENQUIRE_TESSDATA_DIR;
  if (override && override.trim().length > 0) return override.trim();
  const xdg = process.env.XDG_CACHE_HOME;
  const base = xdg && xdg.trim().length > 0 ? xdg.trim() : path.join(os.homedir(), ".cache");
  return path.join(base, "enquire-mcp", "tessdata");
}

/**
 * True iff an UNCOMPRESSED Tesseract language pack `<lang>.traineddata` exists under `dir`.
 *
 * v3.10.0-rc.44 — require the uncompressed form ONLY. The worker is created with
 * `gzip:false` + `cacheMethod:"readOnly"` pinned to `dir`, so it reads exactly
 * `<lang>.traineddata` (no `.gz`). Accepting a `.gz`-only install made this pre-flight
 * PASS while `createWorker` then failed to load the pack — a false "installed" verdict.
 * `install-ocr-lang` always writes the uncompressed form, so this matches reality.
 */
export function ocrLangIsInstalled(lang: string, dir: string = resolveTessdataDir()): boolean {
  return existsSync(path.join(dir, `${lang}.traineddata`));
}

/**
 * Offline-enforcement guard (v3.9.0-rc.10 — overclaim #16). Throws, FAIL-CLOSED,
 * if any requested language in `langs` (a `+`-joined Tesseract spec, e.g.
 * `"eng+rus"`) has no locally-cached trained-data under `dir`. Runs BEFORE the
 * Tesseract worker is created, so a missing pack never triggers the silent CDN
 * download that would violate the "zero outbound network calls in serve mode"
 * guarantee. The error names the exact `install-ocr-lang` command to run.
 *
 * @param langs - `+`-joined Tesseract language spec.
 * @param dir - Tessdata cache dir (defaults to {@link resolveTessdataDir}).
 * @throws {Error} If any requested language pack is not installed locally.
 */
export function assertOcrLangsInstalled(langs: string, dir: string = resolveTessdataDir()): void {
  const requested = langs
    .split("+")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const missing = requested.filter((lang) => !ocrLangIsInstalled(lang, dir));
  if (missing.length > 0) {
    const installCmds = missing.map((l) => `enquire-mcp install-ocr-lang ${l}`).join("  &&  ");
    throw new Error(
      `enquire OCR: language pack(s) not installed locally: ${missing.join(", ")}. ` +
        "enquire serve makes ZERO outbound network calls, so Tesseract trained-data must be pre-cached. " +
        // rc.45 (abs-path-leak class) — do NOT interpolate ${dir} (resolveTessdataDir() =
        // $HOME/.cache/... ) into this client-reachable throw; it leaks the host home dir.
        // The `install-ocr-lang <code>` command is the actionable remediation.
        `Install (explicit, opt-in network): ${installCmds}. ` +
        'See SECURITY.md "OCR network posture".'
    );
  }
}

/**
 * Extract text from an image-only / scanned PDF via Tesseract OCR.
 *
 * Caller has already loaded the file into a Buffer (use
 * `vault.readBinaryFile(relPath)` for vault-aware reading with
 * privacy-filter + max-bytes guards applied).
 *
 * v3.9.0-rc.10 (overclaim #16, ENFORCED) — offline guarantee. Calls
 * {@link assertOcrLangsInstalled} BEFORE loading any optional dep or creating
 * the worker, throwing (fail-closed) if a requested `<lang>.traineddata` isn't
 * cached locally — Tesseract.js would otherwise silently CDN-fetch it, the one
 * thing that could violate "zero outbound network calls in serve mode". The
 * worker is additionally pinned to the local cache (`langPath` +
 * `cacheMethod: "readOnly"`). Install packs via `enquire-mcp install-ocr-lang`.
 *
 * v3.7.16 P1-2 — refuses to process more than `opts.maxPages` (default
 * {@link DEFAULT_OCR_MAX_PAGES} = 200) in a single call. The check
 * runs BEFORE the Tesseract worker spawns, so adversarial inputs don't
 * allocate resources. Pass an explicit `pages: [from, to]` slice to
 * narrow the work, or raise `maxPages` to opt out of the default cap.
 *
 * v3.9.0-rc.10 — additionally clamps each rendered page's ABSOLUTE pixel
 * dimensions to {@link MAX_OCR_CANVAS_DIM} (the `scale` clamp alone doesn't
 * bound a giant-MediaBox OOM) and rejects an inverted/empty page range.
 *
 * Throws on encrypted PDFs, hard-corrupt files, missing optional deps, an
 * uninstalled language pack, an invalid page range, or when the requested page
 * span exceeds `maxPages`. Returns empty pages (`isEmpty: true`) where
 * Tesseract found nothing.
 */
export async function extractPdfWithOcr(buffer: Buffer, opts: ExtractPdfWithOcrOptions = {}): Promise<OcrPdfResult> {
  const langs = opts.langs ?? "eng";
  const scale = Math.max(0.5, Math.min(opts.scale ?? 2, 4)); // clamp to [0.5, 4]
  const maxPages = opts.maxPages ?? DEFAULT_OCR_MAX_PAGES;
  const langPath = opts.langPath ?? resolveTessdataDir();

  // v3.9.0-rc.10 (overclaim #16, ENFORCED) — offline pre-flight. Verify every
  // requested language pack is cached LOCALLY before doing anything else.
  // Tesseract.js's default behavior is to CDN-fetch a missing `<lang>.traineddata`
  // on first use, which would be the only outbound network call in serve mode and
  // would break the "zero outbound network calls" guarantee. This throws (fail-
  // closed) with the exact `install-ocr-lang` command if a pack is missing. It
  // runs BEFORE the optional deps load, so the guarantee holds even on hosts
  // where tesseract.js / canvas aren't installed.
  assertOcrLangsInstalled(langs, langPath);

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
  // v3.10.0-rc.74 (post-rc.70 re-sweep, reserve-before-try sibling of the rc.70 SQLite class):
  // doc/loadingTask are acquired ABOVE; resolveOcrPageRange + the maxPages guard below throw
  // post-acquisition but BEFORE the worker exists, and pre-rc.74 they sat OUTSIDE the try, so a
  // throw leaked the pdfjs document + worker port. Open the try here so the finally always
  // releases doc/loadingTask (and terminates the worker IF it was created) on every path.
  let worker: Awaited<ReturnType<typeof tesseract.createWorker>> | undefined;
  const pages: OcrPdfPage[] = [];
  try {
    // Page range (1-indexed inclusive). v3.9.0-rc.10 — resolveOcrPageRange clamps
    // to [1, pageCount] and throws on an inverted/empty range rather than
    // silently returning zero pages.
    const [from, to] = resolveOcrPageRange(opts.pages, pageCount);

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
    worker = await tesseract.createWorker(langs, undefined, {
      // v3.9.0-rc.10 — pin the worker to the LOCAL tessdata cache, read-only, so
      // it never writes or CDN-fetches. assertOcrLangsInstalled above already
      // guaranteed the packs exist here; this is defense-in-depth on the offline
      // guarantee. gzip:false — install-ocr-lang stores uncompressed
      // `<lang>.traineddata` (tessdata_fast format).
      langPath,
      cachePath: langPath,
      cacheMethod: "readOnly",
      gzip: false,
      // Quiet — Tesseract is chatty by default. Real errors still throw.
      logger: () => {}
    });

    const totalToProcess = to - from + 1;
    let processed = 0;
    for (let pageNum = from; pageNum <= to; pageNum++) {
      try {
        const page = await doc.getPage(pageNum);
        // v3.9.0-rc.10 — clamp ABSOLUTE canvas dimensions (OOM DoS guard). The
        // `scale` clamp bounds the multiplier, not the pixel count; a giant
        // MediaBox (the PDF spec allows up to 14400×14400 pt) would OOM the
        // process at any scale. Lower the effective scale so the larger
        // rendered side never exceeds MAX_OCR_CANVAS_DIM.
        const baseVp = page.getViewport({ scale: 1 });
        const effScale = clampOcrScale(baseVp.width, baseVp.height, scale);
        const viewport = page.getViewport({ scale: effScale });
        // rc.44 M2 — hard-cap the final canvas pixels at MAX_OCR_CANVAS_DIM (defense-in-
        // depth vs any clampOcrScale rounding edge): a huge MediaBox can NEVER allocate an
        // OOM canvas. A normal page is unaffected (its dims are far below the cap).
        const canvas = createCanvas(
          Math.min(Math.ceil(viewport.width), MAX_OCR_CANVAS_DIM),
          Math.min(Math.ceil(viewport.height), MAX_OCR_CANVAS_DIM)
        );
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
    if (worker) await worker.terminate().catch(() => {});
    await doc.cleanup().catch(() => {});
    await loadingTask.destroy().catch(() => {});
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
