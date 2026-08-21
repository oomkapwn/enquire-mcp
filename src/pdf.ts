// PDF text extraction for enquire-mcp.
//
// v2.7.0 — adds PDF as a first-class indexable content type alongside
// markdown. In the 2026-07-24 pinned peer snapshot, enquire is the only
// compared server with a direct first-party PDF extraction/index path
// (cyanheads can expose PDF/OCR indirectly through Obsidian plugins).
// Indexing papers, scans, and downloaded references unlocks search /
// hybrid retrieval / context-pack across that content class.
//
// Implementation notes:
//
//   • pdfjs-dist (Mozilla's PDF.js) is the parser. Pure JS, no native
//     deps, Apache-2.0. ~35MB unpacked but pinned to
//     `optionalDependencies` so users on Node 20 / `--omit=optional`
//     keep a fully functional markdown-only path.
//
//   • We extract page text via `page.streamTextContent()` — fast (~50-200ms
//     per page on M1 cold; ~10-30ms warm), no rendering, no canvas. Streaming
//     lets the decompression budget stop PDF.js before it materializes an
//     unbounded page-wide item array. Text items are joined with spaces;
//     sentence/paragraph reconstruction is lossy but adequate for full-text +
//     semantic search recall (the chunker further normalizes).
//
//   • Image-only PDFs (scans without OCR) return explicitly empty pages.
//     A page that failed to load/extract is a different, explicit `failed`
//     result and can never be mistaken for a genuine blank/image-only page.
//
//   • The API is identical regardless of PDF version (1.x → 1.7 → 2.0).
//     Encrypted PDFs without a password throw a clean error rather
//     than partial extraction.
//
//   • We pass `useSystemFonts: false, isEvalSupported: false` to
//     pdfjs.getDocument so the worker doesn't try to fetch from the
//     network or eval inline scripts. Server-side, offline-safe.

import { Buffer } from "node:buffer";
import { optionalDepDetail } from "./optional-dep.js";

/** Stable per-page PDF extraction outcome. */
export type PdfPageStatus = "ok" | "empty" | "failed";

/** Bounded, path-free evidence for a failed page extraction. */
export interface PdfPageFailure {
  /** Stable machine-readable phase code. */
  code: "PDF_PAGE_LOAD_FAILED" | "PDF_TEXT_EXTRACTION_FAILED" | "PDF_TEXT_BUDGET_EXCEEDED";
  /** Stable bounded explanation; never contains the caught error message. */
  detail: string;
}

const PDF_FAILURE_DETAIL_BY_CODE: Readonly<Record<PdfPageFailure["code"], string>> = {
  PDF_PAGE_LOAD_FAILED: "PDF page could not be loaded",
  PDF_TEXT_EXTRACTION_FAILED: "PDF page text could not be extracted",
  PDF_TEXT_BUDGET_EXCEEDED: "PDF page text exceeded the extraction safety budget"
};

function pdfPageFailure(code: PdfPageFailure["code"]): PdfPageFailure {
  return { code, detail: PDF_FAILURE_DETAIL_BY_CODE[code] };
}

/** Error raised when an indexing caller refuses incomplete PDF page evidence. */
export class PdfPageExtractionError extends Error {
  /** Failed 1-based page numbers, preserved for programmatic diagnostics. */
  readonly failedPages: readonly number[];

  /**
   * @param failedPages - Pages whose load or text extraction failed.
   */
  constructor(failedPages: readonly number[]) {
    const sample = failedPages.slice(0, 8).join(", ");
    const suffix = failedPages.length > 8 ? `, ... (${failedPages.length} total)` : "";
    super(`enquire PDF: incomplete page evidence; failed page(s): ${sample}${suffix}`);
    this.name = "PdfPageExtractionError";
    this.failedPages = [...failedPages];
  }
}

/**
 * Per-page extraction result. `lineStart` / `lineEnd` are placeholders
 * for downstream chunking compatibility — we use page index as the
 * unit of structure, so they map onto the page's `index` and `index+1`
 * for the chunker.
 */
export interface PdfPage {
  /** 1-based page number as displayed in PDF readers. */
  pageNumber: number;
  /** Extracted plain text. Joined item.str values with spaces. */
  text: string;
  /** Explicit extraction outcome; indexing callers must reject `failed`. */
  status: PdfPageStatus;
  /** True if the page has no text. Inspect `status` to distinguish `empty` from `failed`. */
  isEmpty: boolean;
  /** Character count of `text` (cheap recall metric for surfaces). */
  charCount: number;
  /** Present only when {@link status} is `failed`. */
  failure?: PdfPageFailure;
}

export interface PdfExtractionResult {
  /** All extracted pages. Order matches the document. */
  pages: PdfPage[];
  /** Single bounded document aggregate (joined with `\n\n` between non-empty pages). */
  fullText: string;
  /** Total page count from the document. May exceed `pages.length` when a
   *  requested range covers only part of the document. */
  pageCount: number;
  /** True if at least one page yielded text. False for image-only scans. */
  hasText: boolean;
  /** True only when every requested page produced `ok` or `empty` evidence. */
  complete: boolean;
  /** Doc-level metadata if the PDF carries it. Best-effort. */
  metadata: {
    title?: string;
    author?: string;
    subject?: string;
    keywords?: string;
    creator?: string;
    producer?: string;
    creationDate?: string;
    modDate?: string;
  };
}

/**
 * Lazy-load pdfjs-dist. We import dynamically because:
 *   1. It's an `optionalDependency` — users who skipped it shouldn't
 *      pay an import cost on the markdown-only path.
 *   2. Loading the lib at server-startup time would slow boot for
 *      vaults with no PDFs.
 *   3. The clean error on missing dep is much better thrown here than
 *      at server-startup.
 */
async function loadPdfjs(): Promise<typeof import("pdfjs-dist")> {
  try {
    // We access `pdfjs-dist/legacy/build/pdf.mjs` to get the build
    // that doesn't require browser-only globals (workers via web
    // standards APIs). The legacy bundle runs on Node 20+.
    return (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as typeof import("pdfjs-dist");
  } catch (err) {
    // rc.55 (OPTDEP-MODULE-PATH-LEAK-02) — code only; err.message embeds the importing file's abs path.
    throw new Error(
      `enquire: pdfjs-dist (optional dependency) is not available. PDF tools require it. ` +
        `Install with: npm install pdfjs-dist@^6.2.108 (${optionalDepDetail(err)})`
    );
  }
}

/**
 * Optional options for {@link extractPdfText}.
 *
 * v3.7.13 H1 — `pageRange` lets callers limit which pages get loaded by
 * pdfjs. Pre-3.7.13, `extractPdfText` ALWAYS iterated `pageCount` pages
 * even when the caller only wanted pages 1-3 of a 1000-page PDF, then
 * `obsidian_read_pdf` sliced down to the requested window post-hoc. That
 * was wasted CPU/memory and a bearer-token DoS vector in `serve-http`
 * (a client with a valid token could request small page ranges of huge
 * PDFs to peg the server). Passing the range down to `doc.getPage()`
 * means we only deserialize the pages we need.
 */
export interface ExtractPdfTextOptions {
  /** 1-indexed inclusive page range. `to >= from > 0`. Values are clamped
   *  to the document's actual `pageCount` if out-of-range. When `undefined`,
   *  every page is extracted (legacy behavior, subject to `maxPages` cap
   *  below). Both values must be positive safe integers. */
  pageRange?: { from: number; to: number };
  /**
   * v3.7.16 (Class F sibling of P1-2) — defense-in-depth page cap. Even
   * when the caller doesn't pass `pageRange`, refuse to process more than
   * this many pages in one call to bound CPU on adversarial / runaway
   * inputs. Default 500 (~50-100s on M1 CPU at default extraction speed
   * for text-only PDFs; far below the OCR pipeline's 200-page cap because
   * text extraction is ~10x faster per page). Pass
   * an explicit positive safe integer to raise the cap. Explicit ranges are
   * still capped so a caller cannot bypass the resource bound.
   */
  maxPages?: number;
  /**
   * Optional resource limits for extracted text. Every override may only
   * narrow {@link DEFAULT_PDF_TEXT_EXTRACTION_LIMITS}; callers cannot expand
   * the production decompression envelope.
   */
  textLimits?: Partial<PdfTextExtractionLimits>;
}

/** v3.7.16 (Class F sibling of P1-2) — default safety cap on per-call
 *  PDF text extraction. See {@link ExtractPdfTextOptions.maxPages}. */
export const DEFAULT_PDF_MAX_PAGES = 500;

/**
 * Independent PDF text-decompression limits.
 *
 * Input byte size and page count do not bound the number or size of decoded
 * PDF.js text items. These limits are therefore charged per streamed
 * text-content chunk before retaining fragments or joining page/document
 * strings; an overflow cancels the page's PDF.js stream.
 */
export interface PdfTextExtractionLimits {
  /** Maximum UTF-8 bytes in one PDF.js text item. */
  maxTextItemUtf8Bytes: number;
  /** Maximum PDF.js text/structural nodes on one page. */
  maxTextItemsPerPage: number;
  /** Maximum PDF.js text/structural nodes across the request. */
  maxTextItemsTotal: number;
  /** Maximum retained per-page result nodes, including empty/failed pages. */
  maxPageResults: number;
  /** Maximum raw or normalized UTF-8 text bytes for one page. */
  maxPageTextUtf8Bytes: number;
  /** Maximum raw or public aggregate UTF-8 text bytes across the request. */
  maxAggregateTextUtf8Bytes: number;
}

/** Production PDF text-decompression envelope. */
export const DEFAULT_PDF_TEXT_EXTRACTION_LIMITS: Readonly<PdfTextExtractionLimits> = Object.freeze({
  maxTextItemUtf8Bytes: 1024 * 1024,
  maxTextItemsPerPage: 100_000,
  maxTextItemsTotal: 1_000_000,
  maxPageResults: 5000,
  maxPageTextUtf8Bytes: 8 * 1024 * 1024,
  maxAggregateTextUtf8Bytes: 64 * 1024 * 1024
});

class PdfTextBudgetExceededError extends Error {
  constructor() {
    super("PDF text extraction safety budget exceeded");
    this.name = "PdfTextBudgetExceededError";
  }
}

function narrowPdfTextLimit(
  value: number | undefined,
  production: number,
  name: keyof PdfTextExtractionLimits
): number {
  if (value === undefined) return production;
  if (!Number.isSafeInteger(value) || value < 1 || value > production) {
    throw new RangeError(`enquire PDF: ${name} must be a positive safe integer no greater than ${production}`);
  }
  return value;
}

function normalizePdfTextLimits(overrides: Partial<PdfTextExtractionLimits> | undefined): PdfTextExtractionLimits {
  const defaults = DEFAULT_PDF_TEXT_EXTRACTION_LIMITS;
  return {
    maxTextItemUtf8Bytes: narrowPdfTextLimit(
      overrides?.maxTextItemUtf8Bytes,
      defaults.maxTextItemUtf8Bytes,
      "maxTextItemUtf8Bytes"
    ),
    maxTextItemsPerPage: narrowPdfTextLimit(
      overrides?.maxTextItemsPerPage,
      defaults.maxTextItemsPerPage,
      "maxTextItemsPerPage"
    ),
    maxTextItemsTotal: narrowPdfTextLimit(
      overrides?.maxTextItemsTotal,
      defaults.maxTextItemsTotal,
      "maxTextItemsTotal"
    ),
    maxPageResults: narrowPdfTextLimit(overrides?.maxPageResults, defaults.maxPageResults, "maxPageResults"),
    maxPageTextUtf8Bytes: narrowPdfTextLimit(
      overrides?.maxPageTextUtf8Bytes,
      defaults.maxPageTextUtf8Bytes,
      "maxPageTextUtf8Bytes"
    ),
    maxAggregateTextUtf8Bytes: narrowPdfTextLimit(
      overrides?.maxAggregateTextUtf8Bytes,
      defaults.maxAggregateTextUtf8Bytes,
      "maxAggregateTextUtf8Bytes"
    )
  };
}

function addPdfTextBytes(used: number, amount: number, limit: number): number {
  if (!Number.isSafeInteger(amount) || amount < 0 || used > limit - amount) {
    throw new PdfTextBudgetExceededError();
  }
  return used + amount;
}

function pdfTextChunkItems(chunk: unknown): readonly unknown[] {
  if (typeof chunk !== "object" || chunk === null || !("items" in chunk) || !Array.isArray(chunk.items)) {
    throw new Error("PDF.js returned an invalid text-content chunk");
  }
  return chunk.items;
}

function pdfTextItemFragment(item: unknown): string {
  if (typeof item !== "object" || item === null) {
    throw new Error("PDF.js returned an invalid text-content item");
  }
  if (!("str" in item)) return "";
  const itemText = item.str;
  return typeof itemText === "string" ? itemText : "";
}

interface PureXfaTraversalHooks {
  chargeNode(): void;
  admitFragment(fragment: string): void;
}

interface PureXfaTraversalFrame {
  readonly node: Readonly<Record<string, unknown>>;
  children: readonly unknown[] | null;
  nextChildIndex: number;
  entered: boolean;
}

const PURE_XFA_NON_TEXT_SUBTREES = new Set(["textarea", "input", "option", "select"]);

/**
 * Reproduce PDF.js's pure-XFA text order without calling `getTextContent()`.
 * PDF.js special-cases XFA there by materializing a page-wide item array, while
 * `streamTextContent()` skips that special case entirely. This iterative walk
 * consumes the already-public `getXfa()` tree one bounded node at a time.
 */
function traversePureXfaText(root: unknown, hooks: PureXfaTraversalHooks): void {
  if (root === null) return;
  hooks.chargeNode();
  if (typeof root !== "object" || Array.isArray(root)) {
    throw new Error("PDF.js returned an invalid pure-XFA text tree");
  }

  const seen = new WeakSet<object>();
  const stack: PureXfaTraversalFrame[] = [
    {
      node: root as Readonly<Record<string, unknown>>,
      children: null,
      nextChildIndex: 0,
      entered: false
    }
  ];

  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (!frame) throw new Error("PDF.js pure-XFA traversal lost its active frame");
    if (!frame.entered) {
      if (seen.has(frame.node)) throw new Error("PDF.js returned a cyclic pure-XFA text tree");
      seen.add(frame.node);
      frame.entered = true;

      const name = frame.node.name;
      if (typeof name !== "string") throw new Error("PDF.js returned an invalid pure-XFA text node");
      if (PURE_XFA_NON_TEXT_SUBTREES.has(name)) {
        stack.pop();
        continue;
      }

      let fragment: unknown = null;
      if (name === "#text") {
        fragment = frame.node.value;
      } else {
        const attributes = frame.node.attributes;
        if (attributes !== undefined && attributes !== null) {
          if (typeof attributes !== "object" || Array.isArray(attributes)) {
            throw new Error("PDF.js returned invalid pure-XFA text attributes");
          }
          const attributeText = (attributes as Readonly<Record<string, unknown>>).textContent;
          if (attributeText) fragment = attributeText;
        }
        if (fragment === null && frame.node.value) fragment = frame.node.value;
      }
      if (fragment !== null) {
        if (typeof fragment !== "string") throw new Error("PDF.js returned invalid pure-XFA text");
        hooks.admitFragment(fragment);
      }

      const children = frame.node.children;
      if (children === undefined || children === null) {
        stack.pop();
        continue;
      }
      if (!Array.isArray(children)) throw new Error("PDF.js returned invalid pure-XFA text children");
      frame.children = children;
    }

    const children = frame.children;
    if (children === null || frame.nextChildIndex >= children.length) {
      stack.pop();
      continue;
    }

    // Reserve the node budget before even reading the next array slot. A
    // hostile accessor beyond cap therefore cannot run as part of rejection.
    hooks.chargeNode();
    const child = children[frame.nextChildIndex];
    frame.nextChildIndex += 1;
    if (typeof child !== "object" || child === null || Array.isArray(child)) {
      throw new Error("PDF.js returned an invalid pure-XFA text child");
    }
    stack.push({
      node: child as Readonly<Record<string, unknown>>,
      children: null,
      nextChildIndex: 0,
      entered: false
    });
  }
}

/**
 * Reject page results that contain any failed extraction evidence.
 *
 * Interactive PDF reads may return partial evidence so a caller can inspect
 * which page failed. Indexing and synchronization paths call this guard before
 * mutating a durable generation.
 *
 * @param pages - Per-page results returned by {@link extractPdfText}.
 * @throws {PdfPageExtractionError} If one or more pages have `status: "failed"`.
 */
export function assertPdfPagesComplete(pages: readonly PdfPage[]): void {
  const failedPages = pages.filter((page) => page.status === "failed").map((page) => page.pageNumber);
  if (failedPages.length > 0) throw new PdfPageExtractionError(failedPages);
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    const prefix = label.startsWith("pageRange.") ? "invalid page range — " : "";
    throw new TypeError(`enquire PDF: ${prefix}${label} must be a positive safe integer`);
  }
}

/**
 * Extract text from a PDF buffer. Memory-mode — caller has already
 * loaded the file. Use `vault.readBinaryFile(relPath)` to get the
 * buffer with the standard privacy-filter + max-bytes guards
 * applied.
 *
 * Throws on encrypted PDFs without a password or on hard-corrupt files.
 * Returns `status: "empty"` for genuine blank/image-only pages and
 * `status: "failed"` with bounded failure evidence for isolated page errors.
 * Text item, node, page, and aggregate limits are independent of compressed
 * input/page counts. A capacity overflow emits one terminal
 * `PDF_TEXT_BUDGET_EXCEEDED` page and stops before any later page.
 *
 * @param buffer - Complete PDF bytes already admitted by the vault layer.
 * @param opts - Page-range, page-count, and narrowing text limits.
 * @returns Bounded per-page evidence plus one bounded aggregate string.
 */
export async function extractPdfText(buffer: Buffer, opts: ExtractPdfTextOptions = {}): Promise<PdfExtractionResult> {
  if (opts.pageRange !== undefined) {
    assertPositiveSafeInteger(opts.pageRange.from, "pageRange.from");
    assertPositiveSafeInteger(opts.pageRange.to, "pageRange.to");
    if (opts.pageRange.to < opts.pageRange.from) {
      throw new TypeError("enquire PDF: invalid page range — from must be ≤ to");
    }
  }
  if (opts.maxPages !== undefined) assertPositiveSafeInteger(opts.maxPages, "maxPages");
  const textLimits = normalizePdfTextLimits(opts.textLimits);
  const pdfjs = await loadPdfjs();
  // Convert Buffer → Uint8Array (pdfjs accepts both, but the typed-array
  // path skips a copy in some Node builds).
  const data = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const loadingTask = pdfjs.getDocument({
    data,
    // Server-side hardening — no network, no system fonts. pdfjs v5+
    // removed `isEvalSupported` (eval is unconditionally disabled).
    useSystemFonts: false,
    // Quiet pdfjs's own warnings; we'll surface real errors via throw.
    verbosity: 0
  });
  type PdfDocument = Awaited<typeof loadingTask.promise>;
  type PdfPageProxy = Awaited<ReturnType<PdfDocument["getPage"]>>;
  let doc: PdfDocument | undefined;
  let pageCount = 0;
  const pages: PdfPage[] = [];
  const fullTextParts: string[] = [];
  let textItemsTotal = 0;
  let extractedTextBytes = 0;
  let fullTextBytes = 0;
  let hasText = false;
  let complete = true;
  // v3.10.0-rc.74 (post-rc.70 re-sweep, reserve-before-try sibling of the rc.70 SQLite class):
  // doc/loadingTask are acquired ABOVE, but the page-range + maxPages guards below throw
  // post-acquisition and pre-rc.74 the cleanup was plain trailing code (NO finally) — so a
  // throw leaked the pdfjs document + its worker port. Wrap the whole lifecycle so the
  // finally always releases them on every exit path.
  let metadata: PdfExtractionResult["metadata"] = {};
  try {
    doc = await loadingTask.promise;
    pageCount = doc.numPages;
    assertPositiveSafeInteger(pageCount, "document page count");
    // v3.7.13 H1 — restrict the iteration to the requested window so
    // doc.getPage() / streamTextContent() only fire on pages the caller asked
    // for. `pageRange.from / to` are clamped against the actual pageCount.
    // v3.9.0-rc.33 (external-audit H-3) — an explicit but inverted/out-of-range
    // `pageRange` (e.g. `{from:50,to:10}`) previously clamped to an EMPTY window
    // and returned `pages:[]` with NO error — a silent caller-error sink and a
    // parity gap with the OCR path (`resolveOcrPageRange` throws on inverted).
    // Now fail-closed with a clear message, matching the OCR sibling, so an
    // agent passing a bad range gets actionable feedback instead of "no pages".
    const fromPage = opts.pageRange ? Math.max(1, opts.pageRange.from) : 1;
    const toPage = opts.pageRange ? Math.min(pageCount, opts.pageRange.to) : pageCount;
    if (toPage < fromPage) {
      throw new RangeError(`enquire PDF: page range starts at ${fromPage}, beyond the document's ${pageCount} page(s)`);
    }

    // v3.7.16 Class F (sibling of P1-2 OCR cap) — refuse runaway extractions.
    // Pre-3.7.16 a bearer-authenticated HTTP request against a 5MB text-only
    // PDF with ~2000 pages could peg CPU for 5+ minutes. The check fires
    // BEFORE the page loop, so adversarial inputs don't deserialize pages.
    // Explicit `pageRange` caller opted in; an explicit `maxPages` opts to
    // raise the cap; otherwise the default 500-page cap applies.
    const maxPages = opts.maxPages ?? DEFAULT_PDF_MAX_PAGES;
    const requestedSpan = toPage - fromPage + 1;
    if (requestedSpan > maxPages) {
      throw new Error(
        `enquire PDF: refusing to extract ${requestedSpan} pages in a single call ` +
          `(maxPages=${maxPages}). Pass an explicit narrower 'pages: [from, to]' range or raise maxPages.`
      );
    }

    let lastPageToExtract = toPage;
    if (requestedSpan > textLimits.maxPageResults) {
      complete = false;
      pages.push({
        pageNumber: fromPage,
        text: "",
        status: "failed",
        isEmpty: true,
        charCount: 0,
        failure: pdfPageFailure("PDF_TEXT_BUDGET_EXCEEDED")
      });
      lastPageToExtract = fromPage - 1;
    }

    for (let i = fromPage; i <= lastPageToExtract; i++) {
      let page: PdfPageProxy;
      try {
        page = await doc.getPage(i);
      } catch {
        complete = false;
        pages.push({
          pageNumber: i,
          text: "",
          status: "failed",
          isEmpty: true,
          charCount: 0,
          failure: pdfPageFailure("PDF_PAGE_LOAD_FAILED")
        });
        continue;
      }
      let stopAfterPage = false;
      try {
        const fragments: string[] = [];
        let pageJoinedBytes = 0;
        let pageTextItems = 0;
        const chargeTextNodes = (count: number): void => {
          if (
            !Number.isSafeInteger(count) ||
            count < 0 ||
            pageTextItems > textLimits.maxTextItemsPerPage - count ||
            textItemsTotal > textLimits.maxTextItemsTotal - count
          ) {
            throw new PdfTextBudgetExceededError();
          }
          pageTextItems += count;
          textItemsTotal += count;
        };
        const admitFragment = (fragment: string): void => {
          const fragmentBytes = Buffer.byteLength(fragment, "utf8");
          if (fragmentBytes > textLimits.maxTextItemUtf8Bytes) throw new PdfTextBudgetExceededError();
          const separatorBytes = fragments.length === 0 ? 0 : 1;
          pageJoinedBytes = addPdfTextBytes(
            pageJoinedBytes,
            separatorBytes + fragmentBytes,
            textLimits.maxPageTextUtf8Bytes
          );
          extractedTextBytes = addPdfTextBytes(
            extractedTextBytes,
            separatorBytes + fragmentBytes,
            textLimits.maxAggregateTextUtf8Bytes
          );
          fragments.push(fragment);
        };

        if (page.isPureXfa) {
          // `getTextContent()` has a private pure-XFA fallback, but it builds an
          // unbounded page-wide array. `streamTextContent()` omits that fallback.
          // Walk the public XFA tree directly so supported XFA text is preserved
          // without reopening the original materialization class.
          const xfa = await page.getXfa();
          traversePureXfaText(xfa, {
            chargeNode: () => chargeTextNodes(1),
            admitFragment
          });
        } else {
          const textReader = page.streamTextContent().getReader();
          let streamFinished = false;
          try {
            while (true) {
              const readResult = await textReader.read();
              if (readResult.done) {
                streamFinished = true;
                break;
              }

              // Charge every PDF.js chunk before visiting any of its items. This
              // bounds decompressed-node work without first materializing the
              // complete page-wide TextContent array.
              const items = pdfTextChunkItems(readResult.value as unknown);
              chargeTextNodes(items.length);

              for (const item of items) admitFragment(pdfTextItemFragment(item));
            }
          } catch (error) {
            // Reader cancellation propagates to PDF.js's worker message stream,
            // so a budget failure does not keep decoding unseen chunks. Preserve
            // the original extraction/budget error if cancellation itself fails.
            if (!streamFinished) await textReader.cancel(error).catch(() => {});
            throw error;
          } finally {
            textReader.releaseLock();
          }
        }

        // Budgets were charged before fragment retention and before either
        // join. Whitespace normalization can only reduce this admitted UTF-8
        // envelope, and avoids the former map-array + raw aggregate copies.
        const text = fragments.join(" ").replace(/\s+/g, " ").trim();
        const normalizedBytes = Buffer.byteLength(text, "utf8");
        if (normalizedBytes > textLimits.maxPageTextUtf8Bytes) throw new PdfTextBudgetExceededError();
        if (text.length > 0) {
          const separatorBytes = fullTextParts.length === 0 ? 0 : 2;
          fullTextBytes = addPdfTextBytes(
            fullTextBytes,
            separatorBytes + normalizedBytes,
            textLimits.maxAggregateTextUtf8Bytes
          );
          if (separatorBytes > 0) fullTextParts.push("\n\n");
          fullTextParts.push(text);
          hasText = true;
        }
        pages.push({
          pageNumber: i,
          text,
          status: text.length === 0 ? "empty" : "ok",
          isEmpty: text.length === 0,
          charCount: text.length
        });
      } catch (error) {
        complete = false;
        const budgetExceeded = error instanceof PdfTextBudgetExceededError;
        pages.push({
          pageNumber: i,
          text: "",
          status: "failed",
          isEmpty: true,
          charCount: 0,
          failure: pdfPageFailure(budgetExceeded ? "PDF_TEXT_BUDGET_EXCEEDED" : "PDF_TEXT_EXTRACTION_FAILED")
        });
        // A capacity failure proves the aggregate is no longer safely
        // enumerable. Stop immediately; later pages must not be touched and
        // durable callers will reject this explicit failed evidence.
        stopAfterPage = budgetExceeded;
      } finally {
        // Free per-page resources even when streamTextContent() rejects. Cleanup
        // itself is best-effort and never rewrites otherwise valid evidence.
        try {
          page.cleanup();
        } catch {
          // Document/loading-task cleanup below remains authoritative.
        }
      }
      if (stopAfterPage) break;
    }

    // Doc-level metadata — best-effort, optional in PDFs.
    try {
      const meta = await doc.getMetadata();
      const info = (meta?.info ?? {}) as Record<string, unknown>;
      metadata = {
        ...(typeof info.Title === "string" ? { title: info.Title } : {}),
        ...(typeof info.Author === "string" ? { author: info.Author } : {}),
        ...(typeof info.Subject === "string" ? { subject: info.Subject } : {}),
        ...(typeof info.Keywords === "string" ? { keywords: info.Keywords } : {}),
        ...(typeof info.Creator === "string" ? { creator: info.Creator } : {}),
        ...(typeof info.Producer === "string" ? { producer: info.Producer } : {}),
        ...(typeof info.CreationDate === "string" ? { creationDate: info.CreationDate } : {}),
        ...(typeof info.ModDate === "string" ? { modDate: info.ModDate } : {})
      };
    } catch {
      // Metadata is optional; absence is fine.
    }
  } finally {
    // Always release the pdfjs document + worker port, even on a post-acquisition throw
    // (invalid range / maxPages). Guarded so a cleanup error never masks the real one.
    if (doc) await doc.cleanup().catch(() => {});
    await loadingTask.destroy().catch(() => {});
  }

  // One bounded aggregate allocation. `fullTextParts` contains only bounded
  // references plus two-byte separators; no map/filter intermediate arrays.
  const fullText = fullTextParts.join("");

  return { pages, fullText, pageCount, hasText, complete, metadata };
}

/**
 * Returns true if pdfjs-dist is loadable in this process. Used by
 * tool-registration code to decide whether to advertise PDF tools.
 * Cached after first call — module-level dynamic import is one-shot.
 */
let pdfjsAvailableCache: boolean | undefined;
export async function isPdfjsAvailable(): Promise<boolean> {
  if (pdfjsAvailableCache !== undefined) return pdfjsAvailableCache;
  try {
    await loadPdfjs();
    pdfjsAvailableCache = true;
  } catch {
    pdfjsAvailableCache = false;
  }
  return pdfjsAvailableCache;
}
