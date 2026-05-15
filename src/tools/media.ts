import * as path from "node:path";
import type { Vault } from "../vault.js";
import { findBestMatch } from "./meta.js";

// ─── obsidian_list_canvases (v1.7) ──────────────────────────────────────────
// Lists `.canvas` files (Obsidian's whiteboard format — JSON nodes + edges).
// Green-field per the v1.5 competitive audit: only obscure forks support
// canvas, and we now do it natively without coupling to the Obsidian app.

export interface CanvasSummary {
  path: string;
  name: string;
  size_bytes: number;
  mtime: string;
  node_count: number;
  edge_count: number;
}

export async function listCanvases(vault: Vault, args: { folder?: string; limit?: number }): Promise<CanvasSummary[]> {
  await vault.ensureExists();
  const limit = args.limit ?? 100;
  const all = await vault.listFilesByExtension(".canvas", args.folder);
  const out: CanvasSummary[] = [];
  for (const e of all) {
    if (out.length >= limit) break;
    let nodeCount = 0;
    let edgeCount = 0;
    let size = e.mtimeMs; // placeholder; replaced below
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

export interface CanvasEdge {
  id: string;
  from_node: string;
  from_side?: string;
  to_node: string;
  to_side?: string;
  label?: string;
  color?: string;
}

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
          // vault-relative path, so try direct match first. Fall through to
          // findBestMatch (basename) for the path-stripped case.
          const direct =
            cleaned.length > 0 ? allMarkdown.find((m) => m.relPath.replace(/\\/g, "/") === cleaned) : undefined;
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

export async function listPdfs(vault: Vault, args: { folder?: string; limit?: number }): Promise<PdfSummary[]> {
  await vault.ensureExists();
  const limit = args.limit ?? 100;
  const all = await vault.listFilesByExtension(".pdf", args.folder);
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

export interface ReadPdfArgs {
  /** Vault-relative path to the .pdf file. */
  path: string;
  /** Optional 1-indexed inclusive page range: `[2, 5]` reads pages 2..5. */
  pages?: [number, number];
  /** When true, include doc-level metadata (title/author/etc) in the result. Default true. */
  include_metadata?: boolean;
}

export interface ReadPdfPage {
  page_number: number;
  text: string;
  is_empty: boolean;
  char_count: number;
}

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
  const result = await extractPdfText(buf);

  // Optional page-range slice (1-indexed inclusive). Validated lightly —
  // out-of-range bounds clamp rather than throw, matching how `slice()`
  // behaves elsewhere in the toolkit.
  let pages = result.pages;
  if (args.pages && args.pages.length === 2) {
    const [from, to] = args.pages;
    if (typeof from === "number" && typeof to === "number" && from > 0 && to >= from) {
      pages = result.pages.slice(from - 1, to);
    }
  }

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

export interface OcrPdfPage {
  page_number: number;
  text: string;
  is_empty: boolean;
  char_count: number;
  /** Tesseract's mean confidence for this page, 0-100. */
  confidence: number;
}

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
