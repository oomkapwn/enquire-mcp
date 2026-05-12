// SQLite FTS5 inverted index for sub-100ms BM25-ranked search on
// multi-thousand-note vaults. Opt-in via `--persistent-index`.
//
// Architecture credit: external user feedback in issue #10 — concrete schema,
// tokenize choice (`unicode61 remove_diacritics 2`), source_state mtime-tracking
// pattern, paragraph-level chunking with `\n\n → \n → hardcut` fallback,
// `_safeFts5Query` escaping for hyphenated identifiers. Their reference Python
// implementation handles a 1771-chunk / 368-file corpus in 50–100ms BM25 top-10.
//
// `better-sqlite3` is an OPTIONAL dependency; if it failed to compile the user
// can still use enquire-mcp without `--persistent-index` (the in-memory parallel
// scan path remains).

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const SCHEMA_VERSION = 4;
// v2 added the `tags` UNINDEXED column for tag-filtered search.
// v3 added `raw_content` UNINDEXED so the chunk resource can return the
// original note text, while FTS5's `content` column keeps the enriched
// version (with appended wikilink_targets) for recall.
// v4 added the `kind` UNINDEXED column ("md" | "pdf") so PDF chunks live
// in the same index as markdown — `obsidian_search` returns blended hits
// with the kind flag exposed to agents. Schema bump auto-rebuilds.

export type TokenizeMode = "unicode61" | "trigram";

/** Content-source kind. v2.7.0 added `pdf`; v2.8.0 indexes them. */
export type ChunkKind = "md" | "pdf";

export interface FtsSearchHit {
  rel_path: string;
  chunk_index: number;
  line_start: number;
  line_end: number;
  snippet: string;
  score: number;
  /** v2.8.0 — content-source kind. Defaults to "md" for backward compat. */
  kind: ChunkKind;
}

export interface FtsSyncReport {
  added: number;
  updated: number;
  deleted: number;
  unchanged: number;
  total_chunks: number;
}

interface SourceStateRow {
  rel_path: string;
  mtime_ms: number;
}

// Lazy-loaded better-sqlite3 binding so missing native module surfaces only
// when --persistent-index is actually used.
//
// v2.0.0-beta.1 P2 fix: import-success is not enough. The JS package can
// resolve while the native `*.node` binding fails to load (e.g. user ran
// `npm ci --ignore-scripts`, prebuilds are unavailable for their platform,
// or compile failed). Pre-fix, the user got a raw `bindings` search-path
// stack trace at first `new Database(...)` call. Now we probe the
// constructor against `:memory:` once at load time and wrap any failure
// with the same clean error users get from import failure.
let BetterSqliteCtor: (new (file: string) => unknown) | null = null;
async function loadBetterSqlite(): Promise<new (file: string) => unknown> {
  if (BetterSqliteCtor) return BetterSqliteCtor;
  try {
    const mod = (await import("better-sqlite3")) as { default?: new (file: string) => unknown };
    const ctor = mod.default;
    if (!ctor) throw new Error("better-sqlite3 has no default export");
    // Probe the native binding by opening + closing an in-memory DB. Catches
    // the "JS package present but *.node binary missing" failure mode that a
    // bare import doesn't.
    try {
      const probe = new ctor(":memory:") as { close?: () => void };
      probe.close?.();
    } catch (probeErr) {
      throw new Error(
        `better-sqlite3 native binding failed to load (try: \`npm rebuild better-sqlite3\` or reinstall without --omit=optional / --ignore-scripts). ${probeErr instanceof Error ? probeErr.message : String(probeErr)}`
      );
    }
    BetterSqliteCtor = ctor;
    return ctor;
  } catch (err) {
    throw new Error(
      `Persistent index requires the optional 'better-sqlite3' dependency; install failed or the binding could not be loaded. ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

// Minimal type alias over better-sqlite3 — keeps the rest of this file off
// `any` without forcing a full @types/better-sqlite3 dep up the chain.
interface Db {
  prepare(sql: string): Stmt;
  exec(sql: string): void;
  close(): void;
  pragma(query: string): unknown;
}
interface Stmt {
  run(...params: unknown[]): { changes: number };
  all<T = unknown>(...params: unknown[]): T[];
  get<T = unknown>(...params: unknown[]): T | undefined;
}

export class FtsIndex {
  private db: Db | null = null;
  private readonly file: string;
  private readonly tokenize: TokenizeMode;
  private readonly vaultRoot: string;

  constructor(opts: { file: string; vaultRoot: string; tokenize?: TokenizeMode }) {
    this.file = opts.file;
    this.vaultRoot = opts.vaultRoot;
    this.tokenize = opts.tokenize ?? "unicode61";
  }

  async open(): Promise<void> {
    if (this.db) return;
    const Ctor = await loadBetterSqlite();
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    await fs.chmod(path.dirname(this.file), 0o700).catch(() => {});
    this.db = new Ctor(this.file) as Db;
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.bootstrapSchema();
    // Best-effort: tighten perms on the DB and its WAL/SHM sidecar files to
    // 0600. The index stores chunked note content so it deserves the same
    // privacy posture as the persistent parse cache (see SECURITY.md).
    await Promise.all(
      [this.file, `${this.file}-wal`, `${this.file}-shm`].map((p) => fs.chmod(p, 0o600).catch(() => {}))
    );
  }

  /** Remove the index file + WAL/SHM sidecar files. Idempotent. */
  async clearOnDisk(): Promise<boolean> {
    this.close();
    let removed = false;
    for (const p of [this.file, `${this.file}-wal`, `${this.file}-shm`]) {
      try {
        await fs.unlink(p);
        removed = true;
      } catch {
        // missing files are fine
      }
    }
    return removed;
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  private bootstrapSchema(): void {
    const db = this.requireDb();
    const tokenizeArg = this.tokenize === "trigram" ? "trigram" : "unicode61 remove_diacritics 2";

    // Meta is always present so we can read it before deciding on rebuilds.
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    const meta = this.readMeta();
    const tokenizeMatch = meta.tokenize_mode === undefined || meta.tokenize_mode === this.tokenize;
    const rootMatch = meta.vault_root === undefined || meta.vault_root === this.vaultRoot;
    const versionMatch = meta.schema_version === undefined || meta.schema_version === String(SCHEMA_VERSION);
    if (!tokenizeMatch || !rootMatch || !versionMatch) {
      const reason: string[] = [];
      if (!tokenizeMatch) reason.push(`tokenize ${meta.tokenize_mode} → ${this.tokenize}`);
      if (!rootMatch) reason.push(`vault_root ${meta.vault_root} → ${this.vaultRoot}`);
      if (!versionMatch) reason.push(`schema_version ${meta.schema_version} → ${SCHEMA_VERSION}`);
      process.stderr.write(`enquire: rebuilding fts5 index (${reason.join("; ")})\n`);
      // DROP rather than DELETE — schema may have changed (e.g. v1 → v2 added
      // the `tags` column). DROP IF EXISTS handles a fresh DB too.
      db.exec("DROP TABLE IF EXISTS chunks; DROP TABLE IF EXISTS source_state;");
    }

    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
        content,
        rel_path UNINDEXED,
        chunk_index UNINDEXED,
        line_start UNINDEXED,
        line_end UNINDEXED,
        tags UNINDEXED,
        raw_content UNINDEXED,
        kind UNINDEXED,
        tokenize='${tokenizeArg}'
      );
      CREATE TABLE IF NOT EXISTS source_state (
        rel_path TEXT PRIMARY KEY,
        mtime_ms INTEGER NOT NULL,
        n_chunks INTEGER NOT NULL,
        kind TEXT NOT NULL DEFAULT 'md',
        indexed_at TEXT NOT NULL
      );
    `);

    this.writeMeta({
      schema_version: String(SCHEMA_VERSION),
      vault_root: this.vaultRoot,
      tokenize_mode: this.tokenize
    });
  }

  private readMeta(): Record<string, string> {
    const db = this.requireDb();
    const rows = db.prepare("SELECT key, value FROM meta").all<{ key: string; value: string }>();
    const out: Record<string, string> = {};
    for (const r of rows) out[r.key] = r.value;
    return out;
  }

  private writeMeta(kv: Record<string, string>): void {
    const db = this.requireDb();
    const stmt = db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)");
    for (const [k, v] of Object.entries(kv)) stmt.run(k, v);
  }

  private requireDb(): Db {
    if (!this.db) throw new Error("FtsIndex.open() must be called before use");
    return this.db;
  }

  /**
   * Diff the on-disk source_state against the live vault snapshot. Returns
   * categorized lists; caller is expected to feed `added` + `updated` paths
   * back into reindexFile() and pass `deleted` to dropFile().
   *
   * v2.8.0: optional `kind` filter — when set, the diff only considers
   * source_state rows of that kind. Lets the markdown-sync and PDF-sync
   * paths run independently against the same DB without one's "missing
   * files" being mistakenly deleted by the other. Default `undefined`
   * means "all kinds" (used by older callers + diff queries that want
   * a global view).
   */
  diff(
    liveEntries: Array<{ relPath: string; mtimeMs: number }>,
    kind?: ChunkKind
  ): {
    added: string[];
    updated: string[];
    deleted: string[];
    unchanged: string[];
  } {
    const db = this.requireDb();
    const stored =
      kind !== undefined
        ? db.prepare("SELECT rel_path, mtime_ms FROM source_state WHERE kind = ?").all<SourceStateRow>(kind)
        : db.prepare("SELECT rel_path, mtime_ms FROM source_state").all<SourceStateRow>();
    const storedMap = new Map<string, number>();
    for (const r of stored) storedMap.set(r.rel_path, r.mtime_ms);
    const live = new Map<string, number>();
    for (const e of liveEntries) live.set(e.relPath, e.mtimeMs);

    const added: string[] = [];
    const updated: string[] = [];
    const unchanged: string[] = [];
    for (const [relPath, mtimeMs] of live) {
      const prev = storedMap.get(relPath);
      if (prev === undefined) added.push(relPath);
      else if (prev !== mtimeMs) updated.push(relPath);
      else unchanged.push(relPath);
    }
    const deleted: string[] = [];
    for (const relPath of storedMap.keys()) if (!live.has(relPath)) deleted.push(relPath);

    return { added, updated, deleted, unchanged };
  }

  /** Drop a file's chunks + state row. Idempotent. */
  dropFile(relPath: string): void {
    const db = this.requireDb();
    db.prepare("DELETE FROM chunks WHERE rel_path = ?").run(relPath);
    db.prepare("DELETE FROM source_state WHERE rel_path = ?").run(relPath);
  }

  /** Re-chunk a single markdown file, replacing its existing chunks atomically. */
  reindexFile(
    relPath: string,
    mtimeMs: number,
    content: string,
    wikilinkTargets: string[] = [],
    tags: string[] = []
  ): number {
    const db = this.requireDb();
    const chunks = chunkContent(content);
    db.prepare("DELETE FROM chunks WHERE rel_path = ?").run(relPath);
    const insert = db.prepare(
      "INSERT INTO chunks (content, rel_path, chunk_index, line_start, line_end, tags, raw_content, kind) VALUES (?, ?, ?, ?, ?, ?, ?, 'md')"
    );
    // `tags` is a comma-delimited list so the filter LIKE pattern can wrap it
    // with leading/trailing commas for exact-tag matching at query time.
    const tagsSerialized = tags.length ? tags.join(",") : "";
    chunks.forEach((c, i) => {
      // FTS5 column `content` carries an enriched form: original text + a
      // synthetic `[wikilink_targets: …]` meta-line so a search for a link
      // target name recalls notes that link out without naming it inline.
      // v2.1.0: also prepend the heading breadcrumb so BM25 search hits
      // notes where the section heading matches a query term even when the
      // body doesn't repeat it. The unindexed `raw_content` keeps the
      // *original* chunk so the `obsidian://chunk/{n}/{path}` resource
      // can return verbatim text.
      const breadcrumbPrefix = c.breadcrumb ? `[section: ${c.breadcrumb}]\n` : "";
      const linksSuffix = wikilinkTargets.length ? `\n[wikilink_targets: ${wikilinkTargets.join(", ")}]` : "";
      const enriched = `${breadcrumbPrefix}${c.text}${linksSuffix}`;
      insert.run(enriched, relPath, i, c.lineStart, c.lineEnd, tagsSerialized, c.text);
    });
    db.prepare(
      "INSERT OR REPLACE INTO source_state (rel_path, mtime_ms, n_chunks, kind, indexed_at) VALUES (?, ?, ?, 'md', ?)"
    ).run(relPath, mtimeMs, chunks.length, new Date().toISOString());
    return chunks.length;
  }

  /**
   * v2.8.0 — re-chunk a single PDF, replacing its existing chunks atomically.
   * Caller pre-extracts page text via `extractPdfText` (src/pdf.ts) so this
   * method stays decoupled from pdfjs-dist (which is an optionalDependency).
   *
   * Page boundaries are preserved as `[page: N]` markers in the joined text
   * before chunking — the chunker may split a page across chunks or merge
   * short pages, but the markers travel with the text so search snippets
   * carry page citations. Same `chunkContent` pipeline as markdown so chunk
   * IDs match across the BM25 / TF-IDF / embeddings rankers (RRF requires
   * stable IDs).
   */
  reindexPdfFile(relPath: string, mtimeMs: number, pages: ReadonlyArray<{ pageNumber: number; text: string }>): number {
    const db = this.requireDb();
    // Join pages with explicit `[page: N]` markers so the chunker can carry
    // page provenance through. Empty pages (image-only / scanned) still get
    // a marker so chunks downstream of them can still cite the right page.
    const joined = pages.map((p) => `[page: ${p.pageNumber}]\n${p.text}`).join("\n\n");
    const chunks = chunkContent(joined);
    db.prepare("DELETE FROM chunks WHERE rel_path = ?").run(relPath);
    const insert = db.prepare(
      "INSERT INTO chunks (content, rel_path, chunk_index, line_start, line_end, tags, raw_content, kind) VALUES (?, ?, ?, ?, ?, '', ?, 'pdf')"
    );
    chunks.forEach((c, i) => {
      // No wikilink/tag enrichment for PDFs (they don't have either). The
      // page marker is already in c.text so it shows up in snippets.
      insert.run(c.text, relPath, i, c.lineStart, c.lineEnd, c.text);
    });
    db.prepare(
      "INSERT OR REPLACE INTO source_state (rel_path, mtime_ms, n_chunks, kind, indexed_at) VALUES (?, ?, ?, 'pdf', ?)"
    ).run(relPath, mtimeMs, chunks.length, new Date().toISOString());
    return chunks.length;
  }

  search(
    rawQuery: string,
    opts: { limit?: number; folder?: string; tag?: string; sinceMtimeMs?: number } = {}
  ): FtsSearchHit[] {
    const db = this.requireDb();
    const limit = opts.limit ?? 25;
    const safe = safeFts5Query(rawQuery);
    if (!safe) return [];
    const where: string[] = ["chunks MATCH ?"];
    const params: unknown[] = [safe];
    if (opts.folder) {
      // Prefix-equality via substr — avoids GLOB pattern semantics so folder
      // names containing `*`, `?`, `[`, `]` (rare but possible in Obsidian)
      // don't expand into wider matches.
      // CodeQL js/polynomial-redos flags `\/+$` here as polynomial. False
      // positive: the `$` anchor forces the engine to match from end-of-
      // string, and `\/+` consumes only `/` chars greedily. Worst-case input
      // is O(n) (a single trailing run of slashes), not O(n²).
      const prefix = `${opts.folder.replace(/\/+$/, "")}/`;
      where.push("substr(chunks.rel_path, 1, ?) = ?");
      params.push(prefix.length, prefix);
    }
    if (opts.tag) {
      // Exact-tag membership inside the comma-separated `tags` column —
      // wrap both sides with commas so "core" doesn't match "core-team".
      where.push("(',' || chunks.tags || ',') LIKE ?");
      params.push(`%,${opts.tag},%`);
    }
    let join = "";
    if (opts.sinceMtimeMs !== undefined) {
      join = "JOIN source_state ON chunks.rel_path = source_state.rel_path";
      where.push("source_state.mtime_ms >= ?");
      params.push(opts.sinceMtimeMs);
    }
    const sql = `
      SELECT chunks.rel_path AS rel_path, chunks.chunk_index AS chunk_index,
             chunks.line_start AS line_start, chunks.line_end AS line_end,
             chunks.kind AS kind,
             snippet(chunks, 0, '«', '»', '…', 25) AS snippet,
             bm25(chunks) AS score
      FROM chunks
      ${join}
      WHERE ${where.join(" AND ")}
      ORDER BY score
      LIMIT ?
    `;
    params.push(limit);
    const rows = db.prepare(sql).all<{
      rel_path: string;
      chunk_index: number;
      line_start: number;
      line_end: number;
      kind: string | null;
      snippet: string;
      score: number;
    }>(...params);
    return rows.map((r) => ({
      rel_path: r.rel_path,
      chunk_index: r.chunk_index,
      line_start: r.line_start,
      line_end: r.line_end,
      // v2.8.0: kind defaults to "md" for chunks indexed before the schema
      // bump (legacy DBs auto-rebuild via SCHEMA_VERSION mismatch, but the
      // null fallback is defense-in-depth).
      kind: (r.kind === "pdf" ? "pdf" : "md") as ChunkKind,
      snippet: r.snippet,
      score: -r.score // BM25 is negative; flip so higher = better for callers
    }));
  }

  /**
   * Fetch a single chunk by (rel_path, chunk_index). Backs the
   * `obsidian://chunk/{chunkIndex}/{+notePath}` resource so MCP clients can
   * deep-link into specific chunks returned by a prior search. Returns the
   * RAW chunk text (the unenriched original); the FTS5 `content` column
   * additionally carries a synthetic wikilink-targets meta-line for recall,
   * which would otherwise pollute resource responses (audit v0.10.4 P1).
   */
  getChunk(relPath: string, chunkIndex: number): { content: string; line_start: number; line_end: number } | null {
    const db = this.requireDb();
    const sql =
      "SELECT raw_content AS content, line_start, line_end FROM chunks WHERE rel_path = ? AND chunk_index = ?";
    const row = db.prepare(sql).get<{ content: string; line_start: number; line_end: number }>(relPath, chunkIndex);
    return row ?? null;
  }

  totalChunks(): number {
    const db = this.requireDb();
    const row = db.prepare("SELECT COUNT(*) AS c FROM chunks").get<{ c: number }>();
    return row?.c ?? 0;
  }

  totalFiles(): number {
    const db = this.requireDb();
    const row = db.prepare("SELECT COUNT(*) AS c FROM source_state").get<{ c: number }>();
    return row?.c ?? 0;
  }
}

// Quote-wrap any token containing non-alphanumerics so FTS5 doesn't interpret
// hyphens / colons / dots as operators (`claude-telegram` would otherwise
// parse as `claude NOT telegram`). Strip reserved keywords. Returns "" if the
// query has no usable tokens.
export function safeFts5Query(q: string): string {
  const RESERVED = new Set(["AND", "OR", "NOT", "NEAR"]);
  const parts = q.trim().split(/\s+/);
  const out: string[] = [];
  for (const p of parts) {
    if (RESERVED.has(p.toUpperCase())) continue;
    if (!p) continue;
    if (/[^A-Za-z0-9_]/.test(p)) {
      const escaped = p.replace(/"/g, '""');
      out.push(`"${escaped}"`);
    } else {
      out.push(p);
    }
  }
  return out.join(" ");
}

interface ContentChunk {
  text: string;
  lineStart: number;
  lineEnd: number;
  /** v2.1.0: heading breadcrumb (e.g. "## Setup > ### Install") in effect at
   *  chunk start. Empty if chunk is in the preamble (before first heading).
   *  Callers concerned with retrieval quality can prepend this to chunk.text
   *  before embedding/indexing — Chroma 2024 + NAACL 2025 both show
   *  structural breadcrumbs lift NDCG@10 by 2-5 points at near-zero cost. */
  breadcrumb: string;
}

const MAX_CHUNK_CHARS = 4096;

/**
 * Paragraph-first chunker with `\n\n → \n → hardcut` fallback. Each chunk
 * carries 1-based line offsets so callers can quote precise locations.
 *
 * v2.1.0: also attaches a heading breadcrumb to each chunk (the H1>H2>H3
 * path in effect at chunk start). Preserves Obsidian markdown structure
 * for downstream retrievers without a custom parser. ATX headings only —
 * fenced code blocks (where `#` is shell prompt, not heading) are skipped.
 */
export function chunkContent(content: string, maxChars = MAX_CHUNK_CHARS): ContentChunk[] {
  if (!content) return [];

  // v2.1.0: pre-compute heading hierarchy per line. Walk the source once,
  // tracking ATX headings and code-fence state, so each line gets the
  // "Section > Subsection" breadcrumb in scope at that line.
  const breadcrumbByLine = computeBreadcrumbsByLine(content);

  const paragraphs = splitWithLines(content, /\n{2,}/);
  const chunks: ContentChunk[] = [];
  for (const p of paragraphs) {
    if (!p.breadcrumb) {
      p.breadcrumb = breadcrumbByLine[p.lineStart - 1] ?? "";
    }
    if (p.text.length <= maxChars) {
      chunks.push(p);
      continue;
    }
    // Paragraph too big — try line splits. Each split inherits the
    // paragraph's breadcrumb (a single oversize paragraph stays under one
    // section by definition — paragraph boundaries don't span headings).
    const lines = splitWithLines(p.text, /\n/, p.lineStart);
    let buf: ContentChunk | null = null;
    for (const ln of lines) {
      if (ln.text.length > maxChars) {
        if (buf) {
          chunks.push(buf);
          buf = null;
        }
        // Single line too long: hard-cut at maxChars boundaries.
        for (let i = 0; i < ln.text.length; i += maxChars) {
          chunks.push({
            text: ln.text.slice(i, i + maxChars),
            lineStart: ln.lineStart,
            lineEnd: ln.lineEnd,
            breadcrumb: p.breadcrumb
          });
        }
        continue;
      }
      if (!buf) {
        buf = { text: ln.text, lineStart: ln.lineStart, lineEnd: ln.lineEnd, breadcrumb: p.breadcrumb };
        continue;
      }
      const tentative = `${buf.text}\n${ln.text}`;
      if (tentative.length > maxChars) {
        chunks.push(buf);
        buf = { text: ln.text, lineStart: ln.lineStart, lineEnd: ln.lineEnd, breadcrumb: p.breadcrumb };
      } else {
        buf.text = tentative;
        buf.lineEnd = ln.lineEnd;
      }
    }
    if (buf) chunks.push(buf);
  }
  return chunks.filter((c) => c.text.trim().length > 0);
}

/**
 * v2.1.0: walk content line-by-line, tracking the H1>H2>H3 stack at each
 * point. Returns a per-line breadcrumb (joined with " > ") in effect AT
 * that line — i.e., the heading the line lives under.
 *
 * Skips heading-style chars inside fenced code blocks (``` and ~~~).
 */
function computeBreadcrumbsByLine(content: string): string[] {
  const lines = content.split("\n");
  const out: string[] = new Array(lines.length).fill("");
  const stack: string[] = []; // index = depth-1, value = heading text
  let inFence = false;
  let fenceMarker = "";
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i] ?? "";
    const fenceMatch = /^(```|~~~)/.exec(ln);
    if (fenceMatch?.[1]) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fenceMatch[1];
      } else if (fenceMatch[1] === fenceMarker) {
        inFence = false;
        fenceMarker = "";
      }
      out[i] = stack.join(" > ");
      continue;
    }
    if (inFence) {
      out[i] = stack.join(" > ");
      continue;
    }
    // v3.5.8 — split the heading parse into a single anchored capture +
    // two linear trailing-trim ops, instead of one combined regex with
    // `(.+?)\s*#*\s*$` (CodeQL js/polynomial-redos: O(n²) on pathological
    // input like `## h<spaces×100000>####`). Each replace below is
    // anchored at `$` so engine matches from the end — strictly linear.
    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(ln);
    if (headingMatch?.[1] && headingMatch[2]) {
      const depth = headingMatch[1].length;
      const text = headingMatch[2].replace(/\s+$/, "").replace(/#+$/, "").trim();
      // Trim stack to current depth - 1, then push at depth.
      stack.length = depth - 1;
      stack.push(text);
      // Heading line itself gets its OWN breadcrumb (the heading is part of
      // its section's identity).
      out[i] = stack.join(" > ");
      continue;
    }
    out[i] = stack.join(" > ");
  }
  return out;
}

function splitWithLines(text: string, separator: RegExp, baseLine = 1): ContentChunk[] {
  const out: ContentChunk[] = [];
  const re = new RegExp(separator.source, separator.flags.includes("g") ? separator.flags : `${separator.flags}g`);
  let lastIndex = 0;
  let lastLine = baseLine;
  for (const match of text.matchAll(re)) {
    const start = match.index ?? 0;
    const slice = text.slice(lastIndex, start);
    const linesInSlice = (slice.match(/\n/g) ?? []).length;
    out.push({ text: slice, lineStart: lastLine, lineEnd: lastLine + linesInSlice, breadcrumb: "" });
    lastLine += linesInSlice + (match[0].match(/\n/g) ?? []).length;
    lastIndex = start + match[0].length;
  }
  const tail = text.slice(lastIndex);
  if (tail) {
    const linesInTail = (tail.match(/\n/g) ?? []).length;
    out.push({ text: tail, lineStart: lastLine, lineEnd: lastLine + linesInTail, breadcrumb: "" });
  }
  return out;
}

export function defaultIndexFile(vaultRoot: string): string {
  const base =
    process.env.XDG_CACHE_HOME ??
    (process.platform === "darwin" ? path.join(os.homedir(), "Library", "Caches") : path.join(os.homedir(), ".cache"));
  const hash = createHash("sha1").update(vaultRoot).digest("hex").slice(0, 12);
  return path.join(base, "enquire", `${hash}.fts5.db`);
}
