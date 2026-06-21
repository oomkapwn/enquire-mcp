import * as path from "node:path";
import type { Vault } from "../vault.js";
import { findBestMatch } from "./meta.js";

// ─── obsidian_list_canvases (v1.7) ──────────────────────────────────────────
// Lists `.canvas` files (Obsidian's whiteboard format — JSON nodes + edges).
// Green-field per the v1.5 competitive audit: only obscure forks support
// canvas, and we now do it natively without coupling to the Obsidian app.

/**
 * Lightweight summary of a `.canvas` file in the vault.
 *
 * Includes node and edge counts so an agent can pick which canvas to dive
 * into without parsing each file in full.
 */
export interface CanvasSummary {
  /** Vault-relative path. */
  path: string;
  /** `.canvas`-stripped basename. */
  name: string;
  /** File size in bytes (0 if the file failed to parse). */
  size_bytes: number;
  /** ISO-8601 modification timestamp. */
  mtime: string;
  /** Total nodes in the canvas. 0 on parse failure. */
  node_count: number;
  /** Total edges in the canvas. 0 on parse failure. */
  edge_count: number;
}

/**
 * List Obsidian `.canvas` files (whiteboards) in the vault.
 *
 * Canvas is Obsidian's JSON-format whiteboard with positional nodes (text /
 * file embeds / external URLs / groups) and labeled edges. Per the v1.5
 * competitive audit, no other Obsidian-MCP indexes them; we parse them
 * natively without coupling to the Obsidian app. Malformed JSON canvases
 * surface with `node_count: 0` and `edge_count: 0` rather than poisoning
 * the listing.
 *
 * @param vault - The vault to scan.
 * @param args - All optional. `folder` restricts the scan. `limit`
 *   defaults to 100.
 * @returns A {@link CanvasSummary} array sorted by mtime desc.
 * @throws {VaultPathError} If `folder` resolves outside the vault.
 * @example
 * ```ts
 * const boards = await listCanvases(vault, { folder: "Whiteboards", limit: 20 });
 * for (const c of boards) console.log(c.path, c.node_count, "nodes");
 * ```
 */
export async function listCanvases(vault: Vault, args: { folder?: string; limit?: number }): Promise<CanvasSummary[]> {
  await vault.ensureExists();
  const limit = args.limit ?? 100;
  const all = await vault.listFilesByExtension(".canvas", args.folder);
  // v3.10.0-rc.76 (full-audit MEDIUM) — sort by mtime DESC BEFORE truncating to `limit`.
  // `listFilesByExtension` returns readdir/walk order, so truncating first and sorting the
  // already-cut subset returned an arbitrary (not-newest) set on vaults with > limit files,
  // violating the documented "newest first" contract. Sort-then-truncate (mirrors read.ts
  // listNotes/getRecentEdits) makes the first `limit` walked the genuinely newest.
  all.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const out: CanvasSummary[] = [];
  for (const e of all) {
    if (out.length >= limit) break;
    let nodeCount = 0;
    let edgeCount = 0;
    // v3.7.12 M3 — initialize to 0 (not mtime). On the error path below
    // (readBinaryFile failure / JSON parse failure) `size` is returned as
    // `size_bytes`, so the previous `e.mtimeMs` placeholder leaked mtime
    // values into a bytes field. 0 is the honest "unknown" value here.
    let size = 0;
    try {
      const buf = await vault.readBinaryFile(e.absPath);
      size = buf.byteLength;
      const txt = buf.toString("utf8");
      const parsed = JSON.parse(txt) as { nodes?: unknown[]; edges?: unknown[] };
      nodeCount = Array.isArray(parsed.nodes) ? parsed.nodes.length : 0;
      edgeCount = Array.isArray(parsed.edges) ? parsed.edges.length : 0;
    } catch {
      // Malformed canvas — fall through with 0 counts. Don't poison the listing.
    }
    out.push({
      path: e.relPath,
      name: e.basename.replace(/\.canvas$/i, ""),
      size_bytes: size,
      mtime: new Date(e.mtimeMs).toISOString(),
      node_count: nodeCount,
      edge_count: edgeCount
    });
  }
  out.sort((a, b) => b.mtime.localeCompare(a.mtime));
  return out;
}

// ─── obsidian_read_canvas (v1.7) ────────────────────────────────────────────
// Parses one .canvas file into typed nodes + edges. The agent gets a graph
// representation it can reason about: which notes are pinned where, what
// connects them, what's textual vs file-embed vs URL.

/**
 * Discriminated union of canvas node kinds.
 *
 * Five variants: `text` (free-form markdown), `file` (vault note embed —
 * carries `file_resolved` with the post-`findBestMatch` vault-relative path
 * or null on broken reference), `link` (external URL), `group` (labeled
 * container), and `unknown` (preserves the raw `type` and full object for
 * forward compatibility with future Obsidian canvas extensions).
 */
export type CanvasNode =
  | {
      kind: "text";
      id: string;
      x: number;
      y: number;
      width: number;
      height: number;
      text: string;
      color?: string;
    }
  | {
      kind: "file";
      id: string;
      x: number;
      y: number;
      width: number;
      height: number;
      file: string;
      file_resolved: string | null; // vault-relative path that findBestMatch resolved to (or null)
      subpath?: string;
      color?: string;
    }
  | {
      kind: "link";
      id: string;
      x: number;
      y: number;
      width: number;
      height: number;
      url: string;
      color?: string;
    }
  | {
      kind: "group";
      id: string;
      x: number;
      y: number;
      width: number;
      height: number;
      label?: string;
      color?: string;
    }
  | {
      kind: "unknown";
      id: string;
      raw_type: string;
      raw: Record<string, unknown>;
    };

/**
 * A directed canvas edge between two nodes.
 *
 * `from_side` / `to_side` are Obsidian's `"top" | "right" | "bottom" | "left"`
 * anchor specifiers (passed through as strings — no validation, forward-
 * compatible with new variants).
 */
export interface CanvasEdge {
  /** Canvas-internal edge ID. */
  id: string;
  /** Source node ID. */
  from_node: string;
  /** Source node anchor side (e.g. `"right"`). Omitted if absent. */
  from_side?: string;
  /** Destination node ID. */
  to_node: string;
  /** Destination node anchor side. Omitted if absent. */
  to_side?: string;
  /** Edge label string. Omitted if absent. */
  label?: string;
  /** Hex / named color. Omitted if absent. */
  color?: string;
}

/**
 * Full canvas read result returned by {@link readCanvas}.
 *
 * `broken_file_refs` lists `file:` node targets that didn't resolve against
 * the live vault index — the canvas equivalent of {@link getUnresolvedWikilinks}.
 */
export interface ReadCanvasResult {
  path: string;
  name: string;
  size_bytes: number;
  mtime: string;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  /** Convenience summary: # of each node kind. */
  summary: { text: number; file: number; link: number; group: number; unknown: number };
  /** Embedded files that didn't resolve to anything in the vault — broken
   *  canvas references. Empty when all files resolve cleanly. */
  broken_file_refs: string[];
}

/**
 * Parse a single `.canvas` file into typed nodes + edges.
 *
 * Returns a graph representation the agent can reason about: which notes
 * are pinned where, what's textual vs file-embed vs URL, what edges
 * connect what. File-node references (`file:` kind) are resolved against
 * the live vault — `file_resolved` carries the post-`findBestMatch`
 * path or null on a broken reference. Forward-compatible: unknown
 * `type` values become `kind: "unknown"` rather than throwing.
 *
 * @param vault - The vault.
 * @param args - `path` is the vault-relative path to the canvas
 *   (with or without `.canvas` extension).
 * @returns A {@link ReadCanvasResult} with nodes, edges, summary, and
 *   broken-reference list.
 * @throws {Error} If `path` is empty, the file is missing, or the JSON
 *   is malformed.
 * @throws {VaultPathError} If `path` resolves outside the vault.
 * @example
 * ```ts
 * const c = await readCanvas(vault, { path: "Whiteboards/research.canvas" });
 * console.log("Files:", c.summary.file, "Broken:", c.broken_file_refs);
 * ```
 */
export async function readCanvas(vault: Vault, args: { path: string }): Promise<ReadCanvasResult> {
  await vault.ensureExists();
  if (!args.path) throw new Error("path is required");
  const normalized = args.path.toLowerCase().endsWith(".canvas") ? args.path : `${args.path}.canvas`;
  const abs = vault.resolveInside(normalized);
  await vault.stat(abs); // throws if missing or excluded — fail fast
  const rel = vault.toRel(abs);

  const buf = await vault.readBinaryFile(abs);
  let parsed: { nodes?: unknown[]; edges?: unknown[] };
  try {
    parsed = JSON.parse(buf.toString("utf8")) as { nodes?: unknown[]; edges?: unknown[] };
  } catch (err) {
    throw new Error(`Canvas file is not valid JSON: ${rel} — ${err instanceof Error ? err.message : String(err)}`);
  }

  // Resolve each `file:` node's reference against the vault's current
  // markdown index — surfaces broken canvas links the same way
  // get_unresolved_wikilinks does for note bodies.
  const allMarkdown = await vault.listMarkdown();
  // v3.10.0-rc.65 (round-3 audit, resource-DoS) — index relPaths ONCE so each file-node's
  // exact-path match is an O(1) Map lookup, not an O(N) linear array scan per node.
  // Pre-rc.65 a canvas with K file-nodes in an N-note vault cost O(K×N) on the single event
  // loop (K is attacker/user-controlled up to the 5 MB file cap → tens of thousands of minimal
  // file-nodes), pinning serve-http for all clients. The `findBestMatch` basename fallback below
  // already resolves path-qualified targets via its own cached index.
  const byRelPath = new Map<string, (typeof allMarkdown)[number]>();
  for (const m of allMarkdown) byRelPath.set(m.relPath.replace(/\\/g, "/"), m);
  const nodes: CanvasNode[] = [];
  const summary = { text: 0, file: 0, link: 0, group: 0, unknown: 0 };
  const brokenRefs: string[] = [];
  if (Array.isArray(parsed.nodes)) {
    for (const raw of parsed.nodes) {
      if (!raw || typeof raw !== "object") continue;
      const n = raw as Record<string, unknown>;
      const id = typeof n.id === "string" ? n.id : "";
      const x = typeof n.x === "number" ? n.x : 0;
      const y = typeof n.y === "number" ? n.y : 0;
      const width = typeof n.width === "number" ? n.width : 0;
      const height = typeof n.height === "number" ? n.height : 0;
      const color = typeof n.color === "string" ? n.color : undefined;
      const type = typeof n.type === "string" ? n.type : "unknown";
      switch (type) {
        case "text":
          nodes.push({
            kind: "text",
            id,
            x,
            y,
            width,
            height,
            text: typeof n.text === "string" ? n.text : "",
            ...(color !== undefined ? { color } : {})
          });
          summary.text += 1;
          break;
        case "file": {
          const fileRef = typeof n.file === "string" ? n.file : "";
          // Strip leading slash so `findBestMatch` treats it as relative.
          const cleaned = fileRef.replace(/^\/+/, "");
          // findBestMatch only looks at the basename; for canvases we have a full
          // vault-relative path, so try the O(1) exact-relPath lookup first (rc.65),
          // then fall through to findBestMatch (basename) for the path-stripped case.
          const direct = cleaned.length > 0 ? byRelPath.get(cleaned) : undefined;
          const resolved = direct ?? (cleaned ? findBestMatch(allMarkdown, cleaned) : null);
          if (cleaned && !resolved) brokenRefs.push(cleaned);
          nodes.push({
            kind: "file",
            id,
            x,
            y,
            width,
            height,
            file: fileRef,
            file_resolved: resolved ? resolved.relPath : null,
            ...(typeof n.subpath === "string" ? { subpath: n.subpath } : {}),
            ...(color !== undefined ? { color } : {})
          });
          summary.file += 1;
          break;
        }
        case "link":
          nodes.push({
            kind: "link",
            id,
            x,
            y,
            width,
            height,
            url: typeof n.url === "string" ? n.url : "",
            ...(color !== undefined ? { color } : {})
          });
          summary.link += 1;
          break;
        case "group":
          nodes.push({
            kind: "group",
            id,
            x,
            y,
            width,
            height,
            ...(typeof n.label === "string" ? { label: n.label } : {}),
            ...(color !== undefined ? { color } : {})
          });
          summary.group += 1;
          break;
        default:
          nodes.push({ kind: "unknown", id, raw_type: type, raw: n });
          summary.unknown += 1;
      }
    }
  }

  const edges: CanvasEdge[] = [];
  if (Array.isArray(parsed.edges)) {
    for (const raw of parsed.edges) {
      if (!raw || typeof raw !== "object") continue;
      const e = raw as Record<string, unknown>;
      const id = typeof e.id === "string" ? e.id : "";
      const fromNode = typeof e.fromNode === "string" ? e.fromNode : "";
      const toNode = typeof e.toNode === "string" ? e.toNode : "";
      if (!fromNode || !toNode) continue;
      edges.push({
        id,
        from_node: fromNode,
        ...(typeof e.fromSide === "string" ? { from_side: e.fromSide } : {}),
        to_node: toNode,
        ...(typeof e.toSide === "string" ? { to_side: e.toSide } : {}),
        ...(typeof e.label === "string" ? { label: e.label } : {}),
        ...(typeof e.color === "string" ? { color: e.color } : {})
      });
    }
  }

  const stat = await vault.stat(abs);
  return {
    path: rel,
    name: path.basename(rel).replace(/\.canvas$/i, ""),
    size_bytes: stat.size,
    mtime: new Date(stat.mtimeMs).toISOString(),
    nodes,
    edges,
    summary,
    broken_file_refs: brokenRefs
  };
}

// ─── obsidian_list_pdfs (v2.7.0) ────────────────────────────────────────────
// PDFs are the #1 non-markdown content kind in real research vaults. No other
// Obsidian-MCP indexes them — `serve` (stdio) and `serve-http` (remote) both
// surface the same list/read tools when pdfjs-dist is installed. Same privacy
// filter (--exclude-glob / --read-paths) as listFilesByExtension applies.

export interface PdfSummary {
  /** Vault-relative path. */
  path: string;
  /** Filename minus the `.pdf` extension. */
  name: string;
  /** File size in bytes. */
  size_bytes: number;
  /** Last-modified ISO timestamp. */
  mtime: string;
}

/**
 * List `.pdf` files in the vault — companion to {@link listCanvases} /
 * {@link listNotes}.
 *
 * PDFs are the #1 non-markdown content kind in real research vaults. Same
 * privacy filter (`--exclude-glob` / `--read-paths`) applies. Returns
 * lightweight metadata only — for full text extraction call {@link readPdf}.
 * Unreadable PDFs are skipped without poisoning the listing.
 *
 * @param vault - The vault.
 * @param args - All optional. `folder` restricts the scan. `limit`
 *   defaults to 100.
 * @returns A {@link PdfSummary} array sorted by mtime desc.
 * @throws {VaultPathError} If `folder` resolves outside the vault.
 * @example
 * ```ts
 * const pdfs = await listPdfs(vault, { folder: "Papers", limit: 50 });
 * ```
 */
export async function listPdfs(vault: Vault, args: { folder?: string; limit?: number }): Promise<PdfSummary[]> {
  await vault.ensureExists();
  const limit = args.limit ?? 100;
  const all = await vault.listFilesByExtension(".pdf", args.folder);
  // v3.10.0-rc.76 (full-audit MEDIUM) — sort by mtime DESC BEFORE truncating to `limit`; see
  // listCanvases. Walk order != mtime order, so truncate-then-sort returned a not-newest subset
  // on vaults with > limit PDFs, breaking the documented "newest first" contract.
  all.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const out: PdfSummary[] = [];
  for (const e of all) {
    if (out.length >= limit) break;
    let size = 0;
    try {
      const buf = await vault.readBinaryFile(e.absPath);
      size = buf.byteLength;
    } catch {
      // Unreadable PDF — skip without poisoning the listing.
      continue;
    }
    out.push({
      path: e.relPath,
      name: e.basename.replace(/\.pdf$/i, ""),
      size_bytes: size,
      mtime: new Date(e.mtimeMs).toISOString()
    });
  }
  out.sort((a, b) => b.mtime.localeCompare(a.mtime));
  return out;
}

// ─── obsidian_read_pdf (v2.7.0) ─────────────────────────────────────────────
// Extract text from a single PDF, page-by-page. Image-only / scanned PDFs
// surface `has_text: false` so agents can detect-and-recommend OCR (deferred
// to v2.8+). Supports an optional `pages` slice (1-indexed inclusive range)
// for partial reads of long documents.

/**
 * Arguments for {@link readPdf}.
 */
export interface ReadPdfArgs {
  /** Vault-relative path to the .pdf file. */
  path: string;
  /** Optional 1-indexed inclusive page range: `[2, 5]` reads pages 2..5. */
  pages?: [number, number];
  /** When true, include doc-level metadata (title/author/etc) in the result. Default true. */
  include_metadata?: boolean;
}

/**
 * One page of extracted PDF text.
 *
 * `is_empty` true indicates either a blank page or — more commonly — an
 * image-only page that needs OCR. Drives the `has_text` aggregate on the
 * envelope.
 */
export interface ReadPdfPage {
  /** 1-indexed page number. */
  page_number: number;
  /** Extracted text content (may be empty for image-only pages). */
  text: string;
  /** True when no text could be extracted (likely needs OCR). */
  is_empty: boolean;
  /** Character count of `text` (post-extraction, post-trim). */
  char_count: number;
}

/**
 * Envelope returned by {@link readPdf}.
 *
 * `has_text` is the OR across pages — false for image-only scans, which
 * agents should detect and route through {@link ocrPdf}. `metadata` is
 * present when `args.include_metadata` is not explicitly false AND the
 * PDF carries any doc-level metadata.
 */
export interface ReadPdfResult {
  path: string;
  name: string;
  size_bytes: number;
  mtime: string;
  page_count: number;
  has_text: boolean;
  pages: ReadPdfPage[];
  full_text: string;
  metadata?: {
    title?: string;
    author?: string;
    subject?: string;
    keywords?: string;
    creator?: string;
    producer?: string;
    creation_date?: string;
    mod_date?: string;
  };
  /** When `pages` slicing was applied, this carries the original page count
   *  for callers that need to know how much they didn't read. */
  total_page_count: number;
}

/**
 * Extract text from a PDF page-by-page, with optional page-range slicing
 * and metadata.
 *
 * Image-only / scanned PDFs surface `has_text: false` — agents should
 * detect this and route through {@link ocrPdf} for OCR. Lazy-loads
 * `pdfjs-dist` (optional dep) so markdown-only users pay zero cost.
 * Out-of-range `pages` slice arguments are clamped rather than thrown
 * (matches `Array.prototype.slice` semantics).
 *
 * @param vault - The vault.
 * @param args - {@link ReadPdfArgs}. `path` required.
 * @returns A {@link ReadPdfResult} with per-page text, full-text join,
 *   metadata, and original `total_page_count`.
 * @throws {Error} If `path` is empty, the file is missing or excluded,
 *   or `pdfjs-dist` is not installed.
 * @throws {VaultPathError} If `path` resolves outside the vault.
 * @example
 * ```ts
 * // Read pages 1-5 of a long paper
 * const r = await readPdf(vault, {
 *   path: "Papers/2024-rag-survey.pdf",
 *   pages: [1, 5],
 *   include_metadata: true
 * });
 * if (!r.has_text) console.log("Scanned PDF — try ocrPdf()");
 * console.log(r.metadata?.title, r.full_text.slice(0, 200));
 * ```
 */
export async function readPdf(vault: Vault, args: ReadPdfArgs): Promise<ReadPdfResult> {
  await vault.ensureExists();
  if (!args.path) throw new Error("path is required");
  const normalized = args.path.toLowerCase().endsWith(".pdf") ? args.path : `${args.path}.pdf`;
  const abs = vault.resolveInside(normalized);
  const stat = await vault.stat(abs); // throws if missing or excluded
  const rel = vault.toRel(abs);

  const buf = await vault.readBinaryFile(abs);
  // Lazy import — keeps the markdown-only path zero-cost when pdfjs-dist
  // isn't installed (--omit=optional users).
  const { extractPdfText } = await import("../pdf.js");

  // v3.7.13 H1 — push the page range INTO extractPdfText so doc.getPage()
  // only fires for requested pages. Pre-3.7.13 we extracted the entire
  // PDF then sliced; that was wasted work and a bearer-token DoS vector
  // in serve-http. Note: `result.pageCount` still reports the document
  // total (read from pdfjs's metadata, not from page count returned),
  // so callers can paginate. Range validation: `to >= from > 0`; an
  // invalid range silently falls back to "all pages" via the undefined
  // branch (kept for backward compatibility — schema-level rejection of
  // invalid ranges is L2 territory).
  let pageRange: { from: number; to: number } | undefined;
  if (args.pages && args.pages.length === 2) {
    const [from, to] = args.pages;
    if (typeof from === "number" && typeof to === "number" && from > 0 && to >= from) {
      pageRange = { from, to };
    }
  }
  const result = await extractPdfText(buf, pageRange ? { pageRange } : {});

  // The pages array already reflects the requested window (or all pages
  // if no range was passed).
  const pages = result.pages;

  const out: ReadPdfResult = {
    path: rel,
    name:
      rel
        .split("/")
        .pop()
        ?.replace(/\.pdf$/i, "") ?? rel,
    size_bytes: buf.byteLength,
    mtime: new Date(stat.mtimeMs).toISOString(),
    page_count: pages.length,
    has_text: pages.some((p) => !p.isEmpty),
    pages: pages.map((p) => ({
      page_number: p.pageNumber,
      text: p.text,
      is_empty: p.isEmpty,
      char_count: p.charCount
    })),
    full_text: pages
      .map((p) => p.text)
      .filter((t) => t.length > 0)
      .join("\n\n"),
    total_page_count: result.pageCount
  };

  if (args.include_metadata !== false && Object.keys(result.metadata).length > 0) {
    out.metadata = {
      title: result.metadata.title,
      author: result.metadata.author,
      subject: result.metadata.subject,
      keywords: result.metadata.keywords,
      creator: result.metadata.creator,
      producer: result.metadata.producer,
      creation_date: result.metadata.creationDate,
      mod_date: result.metadata.modDate
    };
  }

  return out;
}

// ─── obsidian_ocr_pdf (v2.10.0) ─────────────────────────────────────────────
// Image-only / scanned PDFs return `has_text: false` from obsidian_read_pdf
// (v2.7.0+). This tool runs Tesseract OCR over each page bitmap, completing
// the PDF retrieval story. Tesseract.js + @napi-rs/canvas are
// optionalDependencies — clean install-hint error if missing.

/**
 * Arguments for {@link ocrPdf}.
 *
 * `lang` supports Tesseract's `+`-joined multi-language packs for mixed
 * scans. `scale` is the render DPI multiplier — higher gives better
 * accuracy on small text but uses more memory and is slower.
 */
export interface OcrPdfArgs {
  /** Vault-relative path to the .pdf file. */
  path: string;
  /**
   * Tesseract language pack(s). Default `'eng'`. Multi-lang via `'+'`,
   * e.g. `'eng+rus'` for English+Russian mixed scans.
   */
  lang?: string;
  /** Optional 1-indexed inclusive page range, e.g. [2, 5] runs OCR on pages 2..5. */
  pages?: [number, number];
  /**
   * Render scale (DPI multiplier). Higher = better OCR accuracy on small
   * text but more memory + slower render. Default 2 (~150 DPI). Capped at
   * 4 server-side.
   */
  scale?: number;
}

/**
 * One OCR'd page of a PDF.
 *
 * `confidence` is Tesseract's mean per-word confidence for this page,
 * 0-100. Low confidence (<60) typically indicates a rough render — try
 * increasing `scale` or providing a better-matched `lang`.
 */
export interface OcrPdfPage {
  /** 1-indexed page number. */
  page_number: number;
  /** OCR'd text content. */
  text: string;
  /** True when OCR returned no text (blank page or render failure). */
  is_empty: boolean;
  /** Character count of `text`. */
  char_count: number;
  /** Tesseract's mean confidence for this page, 0-100. */
  confidence: number;
}

/**
 * Envelope returned by {@link ocrPdf}.
 *
 * `mean_confidence` is the average across pages with text (NaN if all
 * empty). `langs` echoes the language(s) used so the caller can audit
 * what was actually tried (especially relevant when defaulting to `'eng'`).
 */
export interface OcrPdfResult {
  path: string;
  name: string;
  size_bytes: number;
  mtime: string;
  page_count: number;
  total_page_count: number;
  has_text: boolean;
  pages: OcrPdfPage[];
  full_text: string;
  /** Mean confidence across pages with text. NaN if all pages empty. */
  mean_confidence: number;
  /** Languages used for OCR (whatever the caller passed). */
  langs: string;
}

/**
 * Run Tesseract OCR over a PDF's page bitmaps — the image-only / scanned
 * counterpart to {@link readPdf}.
 *
 * When {@link readPdf} returns `has_text: false`, the PDF is image-only;
 * this function renders each page via `@napi-rs/canvas` and runs Tesseract
 * over the bitmap. Tesseract.js + @napi-rs/canvas are `optionalDependencies`
 * — without them the function surfaces a clean install-hint error rather
 * than crashing. Costs ~1-3s/page on a modern laptop at default scale.
 *
 * @param vault - The vault.
 * @param args - {@link OcrPdfArgs}. `path` required.
 * @returns An {@link OcrPdfResult} with per-page text, confidence scores,
 *   and aggregate statistics.
 * @throws {Error} If `path` is empty / missing / excluded, or the OCR
 *   optional deps aren't installed.
 * @throws {VaultPathError} If `path` resolves outside the vault.
 * @example
 * ```ts
 * const r = await ocrPdf(vault, {
 *   path: "Papers/scanned-1978.pdf",
 *   lang: "eng+fra",
 *   pages: [1, 10],
 *   scale: 3
 * });
 * console.log(`OCR confidence: ${r.mean_confidence}/100`);
 * ```
 */
export async function ocrPdf(vault: Vault, args: OcrPdfArgs): Promise<OcrPdfResult> {
  await vault.ensureExists();
  if (!args.path) throw new Error("path is required");
  const normalized = args.path.toLowerCase().endsWith(".pdf") ? args.path : `${args.path}.pdf`;
  const abs = vault.resolveInside(normalized);
  const stat = await vault.stat(abs); // throws if missing or excluded
  const rel = vault.toRel(abs);

  const buf = await vault.readBinaryFile(abs);
  // Lazy import — keeps the markdown-only path zero-cost when tesseract /
  // canvas optionalDeps aren't installed.
  const { extractPdfWithOcr } = await import("../ocr.js");
  const result = await extractPdfWithOcr(buf, {
    ...(args.lang ? { langs: args.lang } : {}),
    ...(args.pages ? { pages: args.pages } : {}),
    ...(typeof args.scale === "number" ? { scale: args.scale } : {})
  });

  return {
    path: rel,
    name:
      rel
        .split("/")
        .pop()
        ?.replace(/\.pdf$/i, "") ?? rel,
    size_bytes: buf.byteLength,
    mtime: new Date(stat.mtimeMs).toISOString(),
    page_count: result.pages.length,
    total_page_count: result.pageCount,
    has_text: result.hasText,
    pages: result.pages.map((p) => ({
      page_number: p.pageNumber,
      text: p.text,
      is_empty: p.isEmpty,
      char_count: p.charCount,
      confidence: Math.round(p.confidence * 10) / 10
    })),
    full_text: result.fullText,
    mean_confidence: Number.isFinite(result.meanConfidence) ? Math.round(result.meanConfidence * 10) / 10 : Number.NaN,
    langs: result.langs
  };
}
