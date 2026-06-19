// PDF text extraction for enquire-mcp.
//
// v2.7.0 — adds PDF as a first-class indexable content type alongside
// markdown. No other Obsidian-MCP currently does this. PDFs are the #1
// non-markdown content kind in real research vaults (papers, scanned
// notes, downloaded references), and indexing them unlocks search /
// hybrid retrieval / context-pack across an entire content class
// the rest of the ecosystem ignores.
//
// Implementation notes:
//
//   • pdfjs-dist (Mozilla's PDF.js) is the parser. Pure JS, no native
//     deps, Apache-2.0. ~35MB unpacked but pinned to
//     `optionalDependencies` so users on Node 20 / `--omit=optional`
//     keep a fully functional markdown-only path.
//
//   • We extract page text via `page.getTextContent()` — fast (~50-200ms
//     per page on M1 cold; ~10-30ms warm), no rendering, no canvas. The
//     text-item array is joined with spaces; sentence/paragraph
//     reconstruction is lossy but adequate for full-text + semantic
//     search recall (the chunker further normalizes).
//
//   • Image-only PDFs (scans without OCR) return empty pages. We
//     surface this with a per-page `isEmpty` flag and a doc-level
//     `hasText` boolean so callers can detect-and-recommend OCR.
//     OCR itself is tracked for v2.8+ (Tesseract.js or Whisper-OCR).
//
//   • The API is identical regardless of PDF version (1.x → 1.7 → 2.0).
//     Encrypted PDFs without a password throw a clean error rather
//     than partial extraction.
//
//   • We pass `useSystemFonts: false, isEvalSupported: false` to
//     pdfjs.getDocument so the worker doesn't try to fetch from the
//     network or eval inline scripts. Server-side, offline-safe.

import type { Buffer } from "node:buffer";
import { optionalDepDetail } from "./optional-dep.js";

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
  /** True if the page yielded no text (image-only / scanned scan). */
  isEmpty: boolean;
  /** Character count of `text` (cheap recall metric for surfaces). */
  charCount: number;
}

export interface PdfExtractionResult {
  /** All extracted pages. Order matches the document. */
  pages: PdfPage[];
  /** Total document text (joined with `\n\n` between pages). */
  fullText: string;
  /** Page count from the doc itself (may differ from `pages.length` if a
   *  page failed extraction; we still attempt every page). */
  pageCount: number;
  /** True if at least one page yielded text. False for image-only scans. */
  hasText: boolean;
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
        `Install with: npm install pdfjs-dist@^6.0.227 (${optionalDepDetail(err)})`
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
   *  below). */
  pageRange?: { from: number; to: number };
  /**
   * v3.7.16 (Class F sibling of P1-2) — defense-in-depth page cap. Even
   * when the caller doesn't pass `pageRange`, refuse to process more than
   * this many pages in one call to bound CPU on adversarial / runaway
   * inputs. Default 500 (~50-100s on M1 CPU at default extraction speed
   * for text-only PDFs; far below the OCR pipeline's 200-page cap because
   * text extraction is ~10x faster per page). Pass
   * `Number.POSITIVE_INFINITY` to opt out (background-job mode), or pass
   * an explicit `pageRange` to bypass the default cap.
   */
  maxPages?: number;
}

/** v3.7.16 (Class F sibling of P1-2) — default safety cap on per-call
 *  PDF text extraction. See {@link ExtractPdfTextOptions.maxPages}. */
export const DEFAULT_PDF_MAX_PAGES = 500;

/**
 * Extract text from a PDF buffer. Memory-mode — caller has already
 * loaded the file. Use `vault.readBinaryFile(relPath)` to get the
 * buffer with the standard privacy-filter + max-bytes guards
 * applied.
 *
 * Throws on encrypted PDFs without a password or on hard-corrupt files.
 * Returns empty pages (with `isEmpty: true`) for image-only scans.
 */
export async function extractPdfText(buffer: Buffer, opts: ExtractPdfTextOptions = {}): Promise<PdfExtractionResult> {
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
  const doc = await loadingTask.promise;
  const pageCount = doc.numPages;
  const pages: PdfPage[] = [];
  // v3.10.0-rc.74 (post-rc.70 re-sweep, reserve-before-try sibling of the rc.70 SQLite class):
  // doc/loadingTask are acquired ABOVE, but the page-range + maxPages guards below throw
  // post-acquisition and pre-rc.74 the cleanup was plain trailing code (NO finally) — so a
  // throw leaked the pdfjs document + its worker port. Wrap the whole lifecycle so the
  // finally always releases them on every exit path.
  let metadata: PdfExtractionResult["metadata"] = {};
  try {
    // v3.7.13 H1 — restrict the iteration to the requested window so
    // doc.getPage() / getTextContent() only fire on pages the caller asked
    // for. `pageRange.from / to` are clamped against the actual pageCount.
    // v3.9.0-rc.33 (external-audit H-3) — an explicit but inverted/out-of-range
    // `pageRange` (e.g. `{from:50,to:10}`) previously clamped to an EMPTY window
    // and returned `pages:[]` with NO error — a silent caller-error sink and a
    // parity gap with the OCR path (`resolveOcrPageRange` throws on inverted).
    // Now fail-closed with a clear message, matching the OCR sibling, so an
    // agent passing a bad range gets actionable feedback instead of "no pages".
    if (opts.pageRange) {
      const { from, to } = opts.pageRange;
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) {
        throw new Error(
          `enquire PDF: invalid page range — 'from' (${from}) must be an integer ≥ 1 and ≤ 'to' (${to}). ` +
            "Pass pages as [from, to] with from ≤ to (1-indexed, inclusive)."
        );
      }
    }
    const fromPage = opts.pageRange ? Math.max(1, opts.pageRange.from) : 1;
    const toPage = opts.pageRange ? Math.min(pageCount, opts.pageRange.to) : pageCount;

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

    for (let i = fromPage; i <= toPage; i++) {
      try {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        // Each item has `.str` (the text run); some have `.hasEOL` flags
        // we could use to insert newlines, but agents do better with
        // space-joined text + downstream normalization.
        // pdfjs v5 widened TextContent.items to include TextMarkedContent
        // (structural items without a `.str`). Use the in-operator guard to
        // narrow the union; TS infers `item.str` as string inside the guard.
        const text = content.items
          .map((item) => ("str" in item ? item.str : ""))
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        pages.push({
          pageNumber: i,
          text,
          isEmpty: text.length === 0,
          charCount: text.length
        });
        // Free per-page resources eagerly — pdfjs caches operator lists
        // and bitmaps that we don't need after text extraction.
        page.cleanup();
      } catch {
        // Don't fail the whole document on a single bad page. Surface as
        // empty but keep going. Real callers see this in `isEmpty: true`.
        pages.push({
          pageNumber: i,
          text: "",
          isEmpty: true,
          charCount: 0
        });
      }
    }

    // Doc-level metadata — best-effort, optional in PDFs.
    try {
      const meta = await doc.getMetadata();
      const info = (meta?.info ?? {}) as Record<string, unknown>;
      metadata = {
        title: typeof info.Title === "string" ? info.Title : undefined,
        author: typeof info.Author === "string" ? info.Author : undefined,
        subject: typeof info.Subject === "string" ? info.Subject : undefined,
        keywords: typeof info.Keywords === "string" ? info.Keywords : undefined,
        creator: typeof info.Creator === "string" ? info.Creator : undefined,
        producer: typeof info.Producer === "string" ? info.Producer : undefined,
        creationDate: typeof info.CreationDate === "string" ? info.CreationDate : undefined,
        modDate: typeof info.ModDate === "string" ? info.ModDate : undefined
      };
    } catch {
      // Metadata is optional; absence is fine.
    }
  } finally {
    // Always release the pdfjs document + worker port, even on a post-acquisition throw
    // (invalid range / maxPages). Guarded so a cleanup error never masks the real one.
    await doc.cleanup().catch(() => {});
    await loadingTask.destroy().catch(() => {});
  }

  const fullText = pages
    .map((p) => p.text)
    .filter((t) => t.length > 0)
    .join("\n\n");
  const hasText = pages.some((p) => !p.isEmpty);

  return { pages, fullText, pageCount, hasText, metadata };
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
