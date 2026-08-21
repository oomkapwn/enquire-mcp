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
// pass 'rus', 'jpn', 'chi_sim', 'eng+rus' for combined). Each `<lang>.traineddata`
// pack (~10MB) must be PRE-INSTALLED out-of-band via `enquire-mcp install-ocr-lang
// <code>` (the explicit, opt-in download). serve/OCR itself makes NO runtime
// download: `assertOcrLangsInstalled` throws fail-closed BEFORE any optional dep
// or worker loads if a pack is missing, and the worker is pinned to the local
// cache (`langPath` + `cacheMethod: "readOnly"`) — see v3.9.0-rc.10 offline
// enforcement, regression-proofed by OIA Check 4e.
//
// Server-side hardening:
//   • renderViewport scale caps at 4 + an absolute canvas-dimension clamp
//     (MAX_OCR_CANVAS_DIM) — prevents OOM on adversarial PDFs
//   • one process-wide OCR pipeline at a time + a bounded wait queue + a
//     finite wall-clock budget (including queue wait) — prevents
//     concurrent worker/canvas exhaustion and retained-buffer queue growth
//   • Tesseract worker terminated after each call (no persistent state)
//   • All page extraction errors are explicit per-page `failed` evidence;
//     they never masquerade as a genuine blank OCR result
//   • ZERO outbound HTTP in serve mode: no runtime CDN/trained-data fetch;
//     a missing language pack fails closed with an install hint

import { Buffer } from "node:buffer";
import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DEFAULT_OCR_TIMEOUT_MS,
  MAX_CONCURRENT_OCR_CALLS,
  OcrAdmissionController,
  throwIfOcrAborted
} from "./ocr-admission.js";
import { optionalDepDetail } from "./optional-dep.js";

/** Stable per-page OCR outcome. */
export type OcrPageStatus = "ok" | "empty" | "failed";

/** Bounded, path-free evidence for a failed OCR page phase. */
export interface OcrPageFailure {
  /** Stable machine-readable phase code. */
  code:
    | "OCR_PAGE_LOAD_FAILED"
    | "OCR_PAGE_RENDER_FAILED"
    | "OCR_PAGE_ENCODE_FAILED"
    | "OCR_PAGE_RECOGNITION_FAILED"
    | "OCR_TEXT_BUDGET_EXCEEDED";
  /** Stable bounded explanation; never contains the caught error message. */
  detail: string;
}

const OCR_FAILURE_DETAIL_BY_CODE: Readonly<Record<OcrPageFailure["code"], string>> = {
  OCR_PAGE_LOAD_FAILED: "OCR source page could not be loaded",
  OCR_PAGE_RENDER_FAILED: "OCR source page could not be rendered",
  OCR_PAGE_ENCODE_FAILED: "OCR page bitmap could not be encoded",
  OCR_PAGE_RECOGNITION_FAILED: "OCR recognition failed for the page",
  OCR_TEXT_BUDGET_EXCEEDED: "OCR page text exceeded the extraction safety budget"
};

function ocrPageFailure(code: OcrPageFailure["code"]): OcrPageFailure {
  return { code, detail: OCR_FAILURE_DETAIL_BY_CODE[code] };
}

/** Error raised when an indexing caller refuses incomplete OCR page evidence. */
export class OcrPageExtractionError extends Error {
  /** Failed 1-based page numbers, preserved for programmatic diagnostics. */
  readonly failedPages: readonly number[];

  /**
   * @param failedPages - Pages whose load, render, encode, or recognition failed.
   */
  constructor(failedPages: readonly number[]) {
    const sample = failedPages.slice(0, 8).join(", ");
    const suffix = failedPages.length > 8 ? `, ... (${failedPages.length} total)` : "";
    super(`enquire OCR: incomplete page evidence; failed page(s): ${sample}${suffix}`);
    this.name = "OcrPageExtractionError";
    this.failedPages = [...failedPages];
  }
}

/** Per-page OCR result. Shape mirrors `PdfPage` from src/pdf.ts. */
export interface OcrPdfPage {
  pageNumber: number;
  /** Extracted text. Empty string if Tesseract found no recognizable text. */
  text: string;
  /** Explicit OCR outcome; indexing callers must reject `failed`. */
  status: OcrPageStatus;
  /** True if the page has no text. Inspect `status` to distinguish `empty` from `failed`. */
  isEmpty: boolean;
  charCount: number;
  /**
   * Finite confidence score from Tesseract, 0-100, or null when the engine
   * returned no valid score. Useful for agents to detect bad OCR and recommend
   * a higher-DPI rerun.
   */
  confidence: number | null;
  /** Present only when {@link status} is `failed`. */
  failure?: OcrPageFailure;
}

export interface OcrPdfResult {
  pages: OcrPdfPage[];
  /** Single bounded aggregate joined from non-empty page text. */
  fullText: string;
  pageCount: number;
  /** True if at least one page yielded any OCR text. */
  hasText: boolean;
  /** True only when every requested page produced `ok` or `empty` evidence. */
  complete: boolean;
  /** Mean finite 0-100 confidence across text pages, or null when unavailable. */
  meanConfidence: number | null;
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
        `Install with: npm install pdfjs-dist@^6.2.108 (${optionalDepDetail(err)})`
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
   * inputs. Caller can process more only by raising `maxPages`; explicit
   * ranges remain subject to the same cap.
   */
  pages?: [number, number];
  /**
   * v3.7.16 P1-2 — defense-in-depth safety cap. Even when the caller
   * doesn't pass `pages`, refuse to process more than this many pages
   * in one call to bound CPU/memory on adversarial PDFs. Default 200
   * (~5-10 min on M1 CPU; longer than any realistic interactive use).
   * Pass an explicit positive safe integer to raise the cap.
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
  /**
   * Wall-clock budget for the complete OCR call, including queue wait.
   * Defaults to `DEFAULT_OCR_TIMEOUT_MS`, sized to the documented upper
   * estimate for the default 200-page cap. Must be finite and positive.
   */
  timeoutMs?: number;
  /**
   * Optional caller cancellation signal. MCP tool requests pass the SDK
   * signal so client cancellation tears down the active render/worker path.
   */
  signal?: AbortSignal;
  /**
   * Optional OCR text-output limits. Every override may only narrow
   * {@link DEFAULT_OCR_TEXT_EXTRACTION_LIMITS}; page/input byte counts do not
   * expand the production decompression envelope.
   */
  textLimits?: Partial<OcrTextExtractionLimits>;
}

/** v3.7.16 P1-2 — default safety cap on per-call OCR work. See
 *  {@link ExtractPdfWithOcrOptions.maxPages}. */
export const DEFAULT_OCR_MAX_PAGES = 200;

/** Independent limits for decompressed Tesseract text output. */
export interface OcrTextExtractionLimits {
  /** Maximum UTF-8 bytes in one recognition text item. */
  maxTextItemUtf8Bytes: number;
  /** Maximum recognition text nodes admitted for one page (currently exactly one). */
  maxTextItemsPerPage: number;
  /** Maximum recognition text nodes across the request. */
  maxTextItemsTotal: number;
  /** Maximum retained per-page result nodes, including empty/failed pages. */
  maxPageResults: number;
  /** Maximum raw or normalized UTF-8 text bytes for one page. */
  maxPageTextUtf8Bytes: number;
  /** Maximum raw or public aggregate UTF-8 text bytes across the request. */
  maxAggregateTextUtf8Bytes: number;
}

/** Production OCR text-decompression envelope. */
export const DEFAULT_OCR_TEXT_EXTRACTION_LIMITS: Readonly<OcrTextExtractionLimits> = Object.freeze({
  maxTextItemUtf8Bytes: 8 * 1024 * 1024,
  maxTextItemsPerPage: 1,
  maxTextItemsTotal: 1000,
  maxPageResults: 1000,
  maxPageTextUtf8Bytes: 8 * 1024 * 1024,
  maxAggregateTextUtf8Bytes: 64 * 1024 * 1024
});

// Pin Tesseract to its single bounded text output. Node-rich blocks/layout,
// markup, images, and PDF outputs are neither used nor allowed to amplify the
// recognition result retained by this pipeline.
const OCR_TEXT_ONLY_OUTPUT = Object.freeze({
  text: true,
  blocks: false,
  layoutBlocks: false,
  hocr: false,
  tsv: false,
  box: false,
  unlv: false,
  osd: false,
  pdf: false,
  imageColor: false,
  imageGrey: false,
  imageBinary: false,
  debug: false
});

class OcrTextBudgetExceededError extends Error {
  constructor() {
    super("OCR text extraction safety budget exceeded");
    this.name = "OcrTextBudgetExceededError";
  }
}

function narrowOcrTextLimit(
  value: number | undefined,
  production: number,
  name: keyof OcrTextExtractionLimits
): number {
  if (value === undefined) return production;
  if (!Number.isSafeInteger(value) || value < 1 || value > production) {
    throw new RangeError(`enquire OCR: ${name} must be a positive safe integer no greater than ${production}`);
  }
  return value;
}

function normalizeOcrTextLimits(overrides: Partial<OcrTextExtractionLimits> | undefined): OcrTextExtractionLimits {
  const defaults = DEFAULT_OCR_TEXT_EXTRACTION_LIMITS;
  return {
    maxTextItemUtf8Bytes: narrowOcrTextLimit(
      overrides?.maxTextItemUtf8Bytes,
      defaults.maxTextItemUtf8Bytes,
      "maxTextItemUtf8Bytes"
    ),
    maxTextItemsPerPage: narrowOcrTextLimit(
      overrides?.maxTextItemsPerPage,
      defaults.maxTextItemsPerPage,
      "maxTextItemsPerPage"
    ),
    maxTextItemsTotal: narrowOcrTextLimit(
      overrides?.maxTextItemsTotal,
      defaults.maxTextItemsTotal,
      "maxTextItemsTotal"
    ),
    maxPageResults: narrowOcrTextLimit(overrides?.maxPageResults, defaults.maxPageResults, "maxPageResults"),
    maxPageTextUtf8Bytes: narrowOcrTextLimit(
      overrides?.maxPageTextUtf8Bytes,
      defaults.maxPageTextUtf8Bytes,
      "maxPageTextUtf8Bytes"
    ),
    maxAggregateTextUtf8Bytes: narrowOcrTextLimit(
      overrides?.maxAggregateTextUtf8Bytes,
      defaults.maxAggregateTextUtf8Bytes,
      "maxAggregateTextUtf8Bytes"
    )
  };
}

function addOcrTextBytes(used: number, amount: number, limit: number): number {
  if (!Number.isSafeInteger(amount) || amount < 0 || used > limit - amount) {
    throw new OcrTextBudgetExceededError();
  }
  return used + amount;
}

/**
 * Reject OCR page results that contain any failed extraction evidence.
 *
 * @param pages - Per-page results returned by {@link extractPdfWithOcr}.
 * @throws {OcrPageExtractionError} If one or more pages have `status: "failed"`.
 */
export function assertOcrPagesComplete(pages: readonly OcrPdfPage[]): void {
  const failedPages = pages.filter((page) => page.status === "failed").map((page) => page.pageNumber);
  if (failedPages.length > 0) throw new OcrPageExtractionError(failedPages);
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    const prefix = label.startsWith("pages[") ? "invalid page range — " : "";
    throw new TypeError(`enquire OCR: ${prefix}${label} must be a positive safe integer`);
  }
}

function assertFinitePositiveNumber(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`enquire OCR: ${label} must be a finite positive number`);
  }
}

function normalizeOcrConfidence(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

/**
 * v3.9.0-rc.10 — absolute cap on a rendered OCR page's largest pixel side.
 * The `scale` clamp ([0.5, 4]) bounds the MULTIPLIER, not the absolute pixel
 * count: a PDF MediaBox can be up to 14400×14400 pt (per the PDF spec), which
 * even at scale 1 renders to a multi-GB canvas → OOM. `extractPdfWithOcr`
 * lowers the per-page scale so the larger rendered side never exceeds this.
 */
export const MAX_OCR_CANVAS_DIM = 5000;

const OCR_ADMISSION = new OcrAdmissionController(MAX_CONCURRENT_OCR_CALLS);

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
  assertFinitePositiveNumber(baseWidth, "page width");
  assertFinitePositiveNumber(baseHeight, "page height");
  assertFinitePositiveNumber(requestedScale, "scale");
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
  assertPositiveSafeInteger(pageCount, "document page count");
  if (pages === undefined) return [1, pageCount];
  if (!Array.isArray(pages) || pages.length !== 2) {
    throw new TypeError("enquire OCR: pages must be a two-item [from, to] range");
  }
  const from = pages[0];
  const requestedTo = pages[1];
  assertPositiveSafeInteger(from, "pages[0]");
  assertPositiveSafeInteger(requestedTo, "pages[1]");
  if (requestedTo < from) {
    throw new RangeError("enquire OCR: invalid page range — pages[1] must be greater than or equal to pages[0]");
  }
  if (from > pageCount) {
    throw new RangeError(`enquire OCR: page range starts at ${from}, beyond the document's ${pageCount} page(s)`);
  }
  return [from, Math.min(pageCount, requestedTo)];
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
 * v3.12.0-rc.8 — every invocation enters one process-wide FIFO admission
 * lane with a bounded waiting queue and has a finite wall-clock budget that
 * includes queue wait. Timeout/client cancellation is surfaced immediately,
 * while the occupied slot remains leased until active render/PDF/Tesseract
 * cleanup actually settles; a stalled worker can never make the concurrency
 * cap lie.
 *
 * Throws on encrypted PDFs, hard-corrupt files, missing optional deps, an
 * uninstalled language pack, an invalid page range, or when the requested page
 * span exceeds `maxPages`, times out, or is cancelled. Returns `status:
 * "empty"` where Tesseract genuinely found nothing and `status: "failed"`
 * with bounded phase evidence for isolated page errors. Text/item/page-result
 * limits are independent of compressed input/page counts; capacity overflow
 * emits terminal `OCR_TEXT_BUDGET_EXCEEDED` evidence and skips later pages.
 *
 * @param buffer - Complete PDF bytes.
 * @param opts - OCR language, range, rendering, progress, timeout,
 *   cancellation, and narrowing text-output limits.
 * @returns Bounded per-page OCR text, one bounded aggregate, and finite/null confidence.
 */
export async function extractPdfWithOcr(buffer: Buffer, opts: ExtractPdfWithOcrOptions = {}): Promise<OcrPdfResult> {
  if (opts.maxPages !== undefined) assertPositiveSafeInteger(opts.maxPages, "maxPages");
  if (opts.scale !== undefined) assertFinitePositiveNumber(opts.scale, "scale");
  if (opts.pages !== undefined) {
    if (!Array.isArray(opts.pages) || opts.pages.length !== 2) {
      throw new TypeError("enquire OCR: pages must be a two-item [from, to] range");
    }
    assertPositiveSafeInteger(opts.pages[0], "pages[0]");
    assertPositiveSafeInteger(opts.pages[1], "pages[1]");
    if (opts.pages[1] < opts.pages[0]) {
      throw new RangeError("enquire OCR: invalid page range — pages[1] must be greater than or equal to pages[0]");
    }
  }
  const textLimits = normalizeOcrTextLimits(opts.textLimits);
  const admittedOptions = { ...opts, textLimits };
  return OCR_ADMISSION.run(
    (signal) => extractPdfWithOcrAdmitted(buffer, admittedOptions, signal),
    opts.timeoutMs ?? DEFAULT_OCR_TIMEOUT_MS,
    opts.signal
  );
}

async function extractPdfWithOcrAdmitted(
  buffer: Buffer,
  opts: ExtractPdfWithOcrOptions & { textLimits: OcrTextExtractionLimits },
  signal: AbortSignal
): Promise<OcrPdfResult> {
  const langs = opts.langs ?? "eng";
  const scale = Math.max(0.5, Math.min(opts.scale ?? 2, 4)); // validated, then clamped to [0.5, 4]
  const maxPages = opts.maxPages ?? DEFAULT_OCR_MAX_PAGES;
  const langPath = opts.langPath ?? resolveTessdataDir();
  const textLimits = opts.textLimits;

  throwIfOcrAborted(signal);

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
  throwIfOcrAborted(signal);
  const { createCanvas } = canvasMod;

  // Initialize the PDF document.
  const data = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const loadingTask = pdfjs.getDocument({
    data,
    // pdfjs v5+ removed `isEvalSupported` (eval is unconditionally disabled).
    useSystemFonts: false,
    verbosity: 0
  });
  type OcrPdfDocument = Awaited<typeof loadingTask.promise>;
  type OcrPdfPageProxy = Awaited<ReturnType<OcrPdfDocument["getPage"]>>;
  let doc: OcrPdfDocument | undefined;
  let worker: Awaited<ReturnType<typeof tesseract.createWorker>> | undefined;
  let activeRenderCancel: (() => void) | undefined;
  let workerTermination: Promise<void> | undefined;
  let loadingTaskDestruction: Promise<void> | undefined;
  let pageCount = 0;
  const pages: OcrPdfPage[] = [];
  const fullTextParts: string[] = [];
  let textItemsTotal = 0;
  let extractedTextBytes = 0;
  let fullTextBytes = 0;
  let hasText = false;
  let complete = true;
  let confidenceSum = 0;
  let confidenceCount = 0;

  const terminateWorker = (): Promise<void> => {
    if (!worker) return Promise.resolve();
    if (!workerTermination) {
      workerTermination = worker.terminate().then(
        () => {},
        () => {}
      );
    }
    return workerTermination;
  };
  const destroyLoadingTask = (): Promise<void> => {
    if (!loadingTaskDestruction) loadingTaskDestruction = loadingTask.destroy().catch(() => {});
    return loadingTaskDestruction;
  };
  const abortActiveResources = (): void => {
    try {
      activeRenderCancel?.();
    } catch {
      // Cleanup is best-effort here; the awaited finally below is authoritative.
    }
    void terminateWorker();
    void destroyLoadingTask();
  };
  signal.addEventListener("abort", abortActiveResources, { once: true });

  try {
    // The try starts BEFORE document acquisition. Pre-rc.8 an invalid/cancelled
    // loadingTask rejected outside the cleanup scope and could retain its pdfjs
    // worker port; every acquisition path is now paired with destroy().
    doc = await loadingTask.promise;
    throwIfOcrAborted(signal);
    pageCount = doc.numPages;
    assertPositiveSafeInteger(pageCount, "document page count");

    // Page range (1-indexed inclusive). v3.9.0-rc.10 — resolveOcrPageRange clamps
    // to [1, pageCount] and throws on an inverted/empty range rather than
    // silently returning zero pages.
    const [from, to] = resolveOcrPageRange(opts.pages, pageCount);

    // v3.7.16 P1-2 — refuse to OCR more than `maxPages` in a single call.
    // The cap applies to both default-all and explicit ranges; otherwise a
    // bearer client could bypass it with `pages:[1,10000]`.
    // Throws BEFORE the Tesseract worker spins up, so no resources allocated.
    const requestedSpan = to - from + 1;
    if (requestedSpan > maxPages) {
      throw new Error(
        `enquire OCR: refusing to process ${requestedSpan} pages in a single call ` +
          `(maxPages=${maxPages}). Pass an explicit narrower 'pages: [from, to]' range ` +
          `or let a trusted host integration raise maxPages explicitly.`
      );
    }
    if (requestedSpan > textLimits.maxPageResults) {
      pages.push({
        pageNumber: from,
        text: "",
        status: "failed",
        isEmpty: true,
        charCount: 0,
        confidence: null,
        failure: ocrPageFailure("OCR_TEXT_BUDGET_EXCEEDED")
      });
      complete = false;
      return {
        pages,
        fullText: "",
        pageCount,
        hasText: false,
        complete,
        meanConfidence: null,
        langs
      };
    }
    throwIfOcrAborted(signal);

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
    throwIfOcrAborted(signal);

    const totalToProcess = to - from + 1;
    let processed = 0;
    for (let pageNum = from; pageNum <= to; pageNum++) {
      throwIfOcrAborted(signal);
      // Each successful recognition produces exactly one requested text node
      // (all richer output formats are disabled). Refuse before loading,
      // rendering, or recognizing another page once the aggregate node budget
      // is exhausted.
      if (textItemsTotal >= textLimits.maxTextItemsTotal) {
        complete = false;
        pages.push({
          pageNumber: pageNum,
          text: "",
          status: "failed",
          isEmpty: true,
          charCount: 0,
          confidence: null,
          failure: ocrPageFailure("OCR_TEXT_BUDGET_EXCEEDED")
        });
        processed += 1;
        if (opts.onProgress) opts.onProgress(processed, totalToProcess);
        break;
      }
      let page: OcrPdfPageProxy;
      try {
        page = await doc.getPage(pageNum);
      } catch {
        throwIfOcrAborted(signal);
        complete = false;
        pages.push({
          pageNumber: pageNum,
          text: "",
          status: "failed",
          isEmpty: true,
          charCount: 0,
          confidence: null,
          failure: ocrPageFailure("OCR_PAGE_LOAD_FAILED")
        });
        processed += 1;
        if (opts.onProgress) opts.onProgress(processed, totalToProcess);
        continue;
      }
      let failureCode: OcrPageFailure["code"] = "OCR_PAGE_RENDER_FAILED";
      let stopAfterPage = false;
      try {
        throwIfOcrAborted(signal);
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
        // legacy code path.
        const renderTask = page.render({
          canvas: canvas as unknown as HTMLCanvasElement,
          canvasContext: context as unknown as CanvasRenderingContext2D,
          viewport
        });
        activeRenderCancel = () => renderTask.cancel();
        try {
          await renderTask.promise;
        } finally {
          activeRenderCancel = undefined;
        }
        throwIfOcrAborted(signal);

        // Encode to PNG buffer for Tesseract consumption. encode() is
        // async — encodeSync() exists but blocks the event loop on
        // larger canvases (a 300DPI A4 page is ~5MB PNG, ~30ms encode).
        failureCode = "OCR_PAGE_ENCODE_FAILED";
        const png = await canvas.encode("png");
        throwIfOcrAborted(signal);

        failureCode = "OCR_PAGE_RECOGNITION_FAILED";
        const { data: ocrData } = await worker.recognize(png, {}, OCR_TEXT_ONLY_OUTPUT);
        throwIfOcrAborted(signal);
        if (textLimits.maxTextItemsPerPage < 1) throw new OcrTextBudgetExceededError();
        textItemsTotal += 1;
        if (typeof ocrData.text !== "string") throw new Error("Tesseract returned invalid text output");
        const rawTextBytes = Buffer.byteLength(ocrData.text, "utf8");
        if (rawTextBytes > textLimits.maxTextItemUtf8Bytes || rawTextBytes > textLimits.maxPageTextUtf8Bytes) {
          throw new OcrTextBudgetExceededError();
        }
        extractedTextBytes = addOcrTextBytes(extractedTextBytes, rawTextBytes, textLimits.maxAggregateTextUtf8Bytes);
        const text = ocrData.text.replace(/\s+/g, " ").trim();
        const normalizedBytes = Buffer.byteLength(text, "utf8");
        if (normalizedBytes > textLimits.maxPageTextUtf8Bytes) throw new OcrTextBudgetExceededError();
        const confidence = normalizeOcrConfidence(ocrData.confidence);
        if (text.length > 0) {
          const separatorBytes = fullTextParts.length === 0 ? 0 : 2;
          fullTextBytes = addOcrTextBytes(
            fullTextBytes,
            separatorBytes + normalizedBytes,
            textLimits.maxAggregateTextUtf8Bytes
          );
          if (separatorBytes > 0) fullTextParts.push("\n\n");
          fullTextParts.push(text);
          hasText = true;
        }
        pages.push({
          pageNumber: pageNum,
          text,
          status: text.length === 0 ? "empty" : "ok",
          isEmpty: text.length === 0,
          charCount: text.length,
          confidence
        });
        if (text.length > 0 && confidence !== null) {
          confidenceSum += confidence;
          confidenceCount += 1;
        }
      } catch (error) {
        // Cancellation/timeout is a call-level outcome, never a blank page.
        throwIfOcrAborted(signal);
        complete = false;
        const budgetExceeded = error instanceof OcrTextBudgetExceededError;
        pages.push({
          pageNumber: pageNum,
          text: "",
          status: "failed",
          isEmpty: true,
          charCount: 0,
          confidence: null,
          failure: ocrPageFailure(budgetExceeded ? "OCR_TEXT_BUDGET_EXCEEDED" : failureCode)
        });
        // Capacity overflow invalidates exhaustive evidence. Stop before the
        // next page; durable callers reject this failed page and retain their
        // prior coherent generation.
        stopAfterPage = budgetExceeded;
      } finally {
        try {
          page.cleanup();
        } catch {
          // Page cleanup is best-effort and must not duplicate or erase an
          // otherwise successful OCR result. Document/loading-task cleanup
          // below remains the authoritative lifecycle boundary.
        }
      }
      processed += 1;
      throwIfOcrAborted(signal);
      if (opts.onProgress) opts.onProgress(processed, totalToProcess);
      if (stopAfterPage) break;
    }
  } finally {
    signal.removeEventListener("abort", abortActiveResources);
    try {
      activeRenderCancel?.();
    } catch {
      // The render promise already owns the authoritative error.
    }
    await terminateWorker();
    if (doc) await doc.cleanup().catch(() => {});
    await destroyLoadingTask();
  }

  // One bounded aggregate allocation; no page-array map/filter copies.
  const fullText = fullTextParts.join("");

  // Mean confidence over text pages with valid Tesseract evidence. JSON-safe
  // null represents genuine absence or an invalid/non-finite source score.
  const computedMean = confidenceCount > 0 ? confidenceSum / confidenceCount : null;
  const meanConfidence = computedMean !== null && Number.isFinite(computedMean) ? computedMean : null;

  return { pages, fullText, pageCount, hasText, complete, meanConfidence, langs };
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
