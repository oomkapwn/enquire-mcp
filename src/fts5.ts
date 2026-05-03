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

const SCHEMA_VERSION = 1;

export type TokenizeMode = "unicode61" | "trigram";

export interface FtsSearchHit {
  rel_path: string;
  chunk_index: number;
  line_start: number;
  line_end: number;
  snippet: string;
  score: number;
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
let BetterSqliteCtor: (new (file: string) => unknown) | null = null;
async function loadBetterSqlite(): Promise<new (file: string) => unknown> {
  if (BetterSqliteCtor) return BetterSqliteCtor;
  try {
    const mod = (await import("better-sqlite3")) as { default?: new (file: string) => unknown };
    const ctor = mod.default;
    if (!ctor) throw new Error("better-sqlite3 has no default export");
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
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
        content,
        rel_path UNINDEXED,
        chunk_index UNINDEXED,
        line_start UNINDEXED,
        line_end UNINDEXED,
        tokenize='${tokenizeArg}'
      );
      CREATE TABLE IF NOT EXISTS source_state (
        rel_path TEXT PRIMARY KEY,
        mtime_ms INTEGER NOT NULL,
        n_chunks INTEGER NOT NULL,
        indexed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    // Detect cross-vault contamination + tokenize-mode flips → require rebuild
    // by clearing the index when the vault root or tokenize choice changed.
    // Stderr warning so the user knows why the next sync takes longer than usual.
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
      db.exec("DELETE FROM chunks; DELETE FROM source_state;");
    }
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
   */
  diff(liveEntries: Array<{ relPath: string; mtimeMs: number }>): {
    added: string[];
    updated: string[];
    deleted: string[];
    unchanged: string[];
  } {
    const db = this.requireDb();
    const stored = db.prepare("SELECT rel_path, mtime_ms FROM source_state").all<SourceStateRow>();
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

  /** Re-chunk a single file, replacing its existing chunks atomically. */
  reindexFile(relPath: string, mtimeMs: number, content: string, wikilinkTargets: string[] = []): number {
    const db = this.requireDb();
    const chunks = chunkContent(content);
    db.prepare("DELETE FROM chunks WHERE rel_path = ?").run(relPath);
    const insert = db.prepare(
      "INSERT INTO chunks (content, rel_path, chunk_index, line_start, line_end) VALUES (?, ?, ?, ?, ?)"
    );
    chunks.forEach((c, i) => {
      // Append wikilink targets as a meta-line so notes that link out are
      // recalled on a search for the link target — pattern from issue #10.
      const enriched = wikilinkTargets.length ? `${c.text}\n[wikilink_targets: ${wikilinkTargets.join(", ")}]` : c.text;
      insert.run(enriched, relPath, i, c.lineStart, c.lineEnd);
    });
    db.prepare(
      "INSERT OR REPLACE INTO source_state (rel_path, mtime_ms, n_chunks, indexed_at) VALUES (?, ?, ?, ?)"
    ).run(relPath, mtimeMs, chunks.length, new Date().toISOString());
    return chunks.length;
  }

  search(rawQuery: string, opts: { limit?: number; folder?: string } = {}): FtsSearchHit[] {
    const db = this.requireDb();
    const limit = opts.limit ?? 25;
    const safe = safeFts5Query(rawQuery);
    if (!safe) return [];
    const folderClause = opts.folder ? "AND rel_path GLOB ?" : "";
    const sql = `
      SELECT rel_path, chunk_index, line_start, line_end,
             snippet(chunks, 0, '«', '»', '…', 25) AS snippet,
             bm25(chunks) AS score
      FROM chunks
      WHERE chunks MATCH ?
      ${folderClause}
      ORDER BY score
      LIMIT ?
    `;
    const params: unknown[] = [safe];
    if (opts.folder) params.push(`${opts.folder.replace(/\/+$/, "")}/*`);
    params.push(limit);
    const rows = db.prepare(sql).all<{
      rel_path: string;
      chunk_index: number;
      line_start: number;
      line_end: number;
      snippet: string;
      score: number;
    }>(...params);
    return rows.map((r) => ({
      rel_path: r.rel_path,
      chunk_index: r.chunk_index,
      line_start: r.line_start,
      line_end: r.line_end,
      snippet: r.snippet,
      score: -r.score // BM25 is negative; flip so higher = better for callers
    }));
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
}

const MAX_CHUNK_CHARS = 4096;

/**
 * Paragraph-first chunker with `\n\n → \n → hardcut` fallback. Each chunk
 * carries 1-based line offsets so callers can quote precise locations.
 */
export function chunkContent(content: string, maxChars = MAX_CHUNK_CHARS): ContentChunk[] {
  if (!content) return [];
  const paragraphs = splitWithLines(content, /\n{2,}/);
  const chunks: ContentChunk[] = [];
  for (const p of paragraphs) {
    if (p.text.length <= maxChars) {
      chunks.push(p);
      continue;
    }
    // Paragraph too big — try line splits.
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
            lineEnd: ln.lineEnd
          });
        }
        continue;
      }
      if (!buf) {
        buf = { text: ln.text, lineStart: ln.lineStart, lineEnd: ln.lineEnd };
        continue;
      }
      const tentative = `${buf.text}\n${ln.text}`;
      if (tentative.length > maxChars) {
        chunks.push(buf);
        buf = { text: ln.text, lineStart: ln.lineStart, lineEnd: ln.lineEnd };
      } else {
        buf.text = tentative;
        buf.lineEnd = ln.lineEnd;
      }
    }
    if (buf) chunks.push(buf);
  }
  return chunks.filter((c) => c.text.trim().length > 0);
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
    out.push({ text: slice, lineStart: lastLine, lineEnd: lastLine + linesInSlice });
    lastLine += linesInSlice + (match[0].match(/\n/g) ?? []).length;
    lastIndex = start + match[0].length;
  }
  const tail = text.slice(lastIndex);
  if (tail) {
    const linesInTail = (tail.match(/\n/g) ?? []).length;
    out.push({ text: tail, lineStart: lastLine, lineEnd: lastLine + linesInTail });
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
