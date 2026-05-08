// Persistent embedding store (v2.0 alpha). SQLite-backed Float32 vectors,
// brute-force cosine top-K retrieval. Same chunking as FTS5 (paragraph-level
// via fts5.chunkContent) so chunk identity matches across BM25 and embeddings —
// foundation for the v2.0 beta hybrid RRF scorer.
//
// Architecture mirrors fts5.ts:
//   - Lazy-loaded better-sqlite3 (optional dep)
//   - 0600 chmod on db + WAL/SHM sidecars
//   - meta-table cross-vault contamination guard (vault_root, model alias, dim)
//   - source_state mtime tracking for incremental rebuilds
//
// Brute-force cosine is fast enough for vaults up to ~50K chunks (~50ms top-10
// on 50K × 384 floats). HNSW comes in v2.1 if real users hit that ceiling.

import { promises as fs } from "node:fs";
import * as path from "node:path";

const SCHEMA_VERSION = 2;
// v2 added the `kind` column ("md" | "pdf") so PDF chunks live in the same
// embedding index as markdown — `obsidian_search` returns blended hits with
// the kind flag exposed to agents. Schema bump auto-rebuilds.

/** Content-source kind. Mirrors ChunkKind in src/fts5.ts. */
export type EmbedChunkKind = "md" | "pdf";

export interface EmbedSearchHit {
  rel_path: string;
  chunk_index: number;
  line_start: number;
  line_end: number;
  /** Raw chunk text — caller can render snippets. */
  text_preview: string;
  /** Cosine similarity (since vectors are L2-normalized at insert time). */
  score: number;
  /** v2.8.0 — content-source kind. Defaults to "md" for backward compat. */
  kind: EmbedChunkKind;
}

export interface EmbedSyncReport {
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

// v2.0.0-beta.1 P2 fix: probe the native binding via :memory: open so the
// "JS package present but *.node binary missing" failure mode produces a
// clean error pointing at `npm rebuild`, not a raw bindings stack trace.
let BetterSqliteCtor: (new (file: string) => unknown) | null = null;
async function loadBetterSqlite(): Promise<new (file: string) => unknown> {
  if (BetterSqliteCtor) return BetterSqliteCtor;
  try {
    const mod = (await import("better-sqlite3")) as { default?: new (file: string) => unknown };
    const ctor = mod.default;
    if (!ctor) throw new Error("better-sqlite3 has no default export");
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
      `Persistent embeddings require the optional 'better-sqlite3' dependency; install failed or the binding could not be loaded. ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

// better-sqlite3 transaction signature uses `any` in its real types because
// the generic threads through user-supplied function shapes; we mirror that
// shape (typed as `unknown[]` here) and cast at the single use-site.
interface Db {
  prepare(sql: string): Stmt;
  exec(sql: string): void;
  close(): void;
  pragma(query: string): unknown;
  transaction(fn: (...args: unknown[]) => unknown): (...args: unknown[]) => unknown;
}
interface Stmt {
  run(...params: unknown[]): { changes: number };
  all<T = unknown>(...params: unknown[]): T[];
  get<T = unknown>(...params: unknown[]): T | undefined;
}

export interface EmbedDbOptions {
  /** Absolute path to the .embed.db file. */
  file: string;
  /** Vault root for cross-vault contamination guard. */
  vaultRoot: string;
  /** Model alias the user built this index with (e.g. "multilingual"). */
  modelAlias: string;
  /** Vector dimensionality (must match the model). */
  dim: number;
}

export class EmbedDb {
  private db: Db | null = null;
  private readonly file: string;
  private readonly vaultRoot: string;
  private readonly modelAlias: string;
  private readonly dim: number;

  constructor(opts: EmbedDbOptions) {
    this.file = opts.file;
    this.vaultRoot = opts.vaultRoot;
    this.modelAlias = opts.modelAlias;
    this.dim = opts.dim;
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
    await Promise.all(
      [this.file, `${this.file}-wal`, `${this.file}-shm`].map((p) => fs.chmod(p, 0o600).catch(() => {}))
    );
  }

  /** Remove the embed db + WAL/SHM sidecars. Idempotent. */
  async clearOnDisk(): Promise<boolean> {
    this.close();
    let removed = false;
    for (const p of [this.file, `${this.file}-wal`, `${this.file}-shm`]) {
      try {
        await fs.unlink(p);
        removed = true;
      } catch {
        // missing is fine
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

    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    const meta = this.readMeta();
    const versionMatch = meta.schema_version === undefined || meta.schema_version === String(SCHEMA_VERSION);
    const rootMatch = meta.vault_root === undefined || meta.vault_root === this.vaultRoot;
    const modelMatch = meta.model_alias === undefined || meta.model_alias === this.modelAlias;
    const dimMatch = meta.dim === undefined || meta.dim === String(this.dim);
    if (!versionMatch || !rootMatch || !modelMatch || !dimMatch) {
      const reason: string[] = [];
      if (!versionMatch) reason.push(`schema_version ${meta.schema_version} → ${SCHEMA_VERSION}`);
      if (!rootMatch) reason.push(`vault_root ${meta.vault_root} → ${this.vaultRoot}`);
      if (!modelMatch) reason.push(`model ${meta.model_alias} → ${this.modelAlias}`);
      if (!dimMatch) reason.push(`dim ${meta.dim} → ${this.dim}`);
      process.stderr.write(`enquire: rebuilding embed index (${reason.join("; ")})\n`);
      db.exec("DROP TABLE IF EXISTS embeddings; DROP TABLE IF EXISTS source_state;");
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS embeddings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rel_path TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        line_start INTEGER NOT NULL,
        line_end INTEGER NOT NULL,
        text_preview TEXT NOT NULL,
        vector BLOB NOT NULL,
        kind TEXT NOT NULL DEFAULT 'md',
        UNIQUE(rel_path, chunk_index)
      );
      CREATE INDEX IF NOT EXISTS embeddings_rel_path ON embeddings(rel_path);
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
      model_alias: this.modelAlias,
      dim: String(this.dim)
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
    if (!this.db) throw new Error("EmbedDb is not open — call .open() first");
    return this.db;
  }

  /**
   * Replace all embeddings for a single note. Caller computes vectors.
   * v2.8.0: optional `kind` parameter ("md" | "pdf"); defaults to "md" so
   * existing callers (markdown indexing path) need no changes.
   */
  upsertNote(
    relPath: string,
    mtimeMs: number,
    chunks: ReadonlyArray<{
      chunkIndex: number;
      lineStart: number;
      lineEnd: number;
      textPreview: string;
      vector: Float32Array;
    }>,
    kind: EmbedChunkKind = "md"
  ): void {
    const db = this.requireDb();
    const dim = this.dim;
    const tx = db.transaction((...args: unknown[]) => {
      const rows = args[0] as typeof chunks;
      db.prepare("DELETE FROM embeddings WHERE rel_path = ?").run(relPath);
      const insert = db.prepare(
        `INSERT INTO embeddings (rel_path, chunk_index, line_start, line_end, text_preview, vector, kind)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      for (const c of rows) {
        if (c.vector.length !== dim) {
          throw new Error(
            `vector dim mismatch for ${relPath} chunk ${c.chunkIndex}: got ${c.vector.length}, expected ${dim}`
          );
        }
        insert.run(
          relPath,
          c.chunkIndex,
          c.lineStart,
          c.lineEnd,
          c.textPreview,
          Buffer.from(c.vector.buffer, c.vector.byteOffset, c.vector.byteLength),
          kind
        );
      }
      db.prepare(
        `INSERT OR REPLACE INTO source_state (rel_path, mtime_ms, n_chunks, kind, indexed_at)
         VALUES (?, ?, ?, ?, datetime('now'))`
      ).run(relPath, mtimeMs, rows.length, kind);
    });
    tx(chunks);
  }

  /** Drop a note's embeddings entirely (used on file deletion). */
  deleteNote(relPath: string): void {
    const db = this.requireDb();
    db.prepare("DELETE FROM embeddings WHERE rel_path = ?").run(relPath);
    db.prepare("DELETE FROM source_state WHERE rel_path = ?").run(relPath);
  }

  /**
   * Read the source-state table — caller compares mtimes to decide what to
   * re-embed. v2.8.0: optional `kind` filter — when set, only rows of that
   * kind are returned. Lets the markdown-sync and PDF-sync paths run
   * independently without one's "missing files" being deleted by the other.
   */
  getSourceStates(kind?: EmbedChunkKind): SourceStateRow[] {
    const db = this.requireDb();
    if (kind !== undefined) {
      return db.prepare("SELECT rel_path, mtime_ms FROM source_state WHERE kind = ?").all<SourceStateRow>(kind);
    }
    return db.prepare("SELECT rel_path, mtime_ms FROM source_state").all<SourceStateRow>();
  }

  /** Brute-force cosine top-K. Vectors are L2-normalized at insert time so
   *  cosine == dot product. Acceptable up to ~50K chunks; v2.1 will swap to
   *  HNSW if real vaults hit that ceiling. */
  search(queryVec: Float32Array, k: number, opts: { folder?: string; minScore?: number } = {}): EmbedSearchHit[] {
    const db = this.requireDb();
    if (queryVec.length !== this.dim) {
      throw new Error(`query vector dim mismatch: got ${queryVec.length}, expected ${this.dim}`);
    }
    const minScore = opts.minScore ?? -Infinity;
    const folderPrefix = opts.folder ? `${opts.folder.replace(/\/+$/, "")}/` : null;

    // v2.0.0-beta.1 P2 fix: prefix-equality via substr — avoids LIKE pattern
    // semantics so folder names containing `%` / `_` (rare but possible in
    // Obsidian) don't expand into wider matches. Matches the pattern used by
    // FtsIndex.search() in fts5.ts.
    const rows = db
      .prepare(
        folderPrefix
          ? `SELECT rel_path, chunk_index, line_start, line_end, text_preview, vector, kind
             FROM embeddings WHERE substr(rel_path, 1, ?) = ?`
          : `SELECT rel_path, chunk_index, line_start, line_end, text_preview, vector, kind FROM embeddings`
      )
      .all<{
        rel_path: string;
        chunk_index: number;
        line_start: number;
        line_end: number;
        text_preview: string;
        vector: Buffer;
        kind: string | null;
      }>(...(folderPrefix ? [folderPrefix.length, folderPrefix] : []));

    const expectedBytes = this.dim * 4; // Float32 = 4 bytes
    const heap: EmbedSearchHit[] = [];
    for (const r of rows) {
      // v2.0.0-beta.1 P2 fix: assert byteLength before wrapping. A truncated
      // / corrupt BLOB (e.g. from an aborted upsert mid-transaction) would
      // produce a Float32Array that reads past the source buffer's end and
      // emits garbage scores. Skip + warn rather than poison results.
      if (r.vector.byteLength !== expectedBytes) {
        process.stderr.write(
          `enquire: skipping ${r.rel_path}#${r.chunk_index} — vector has ${r.vector.byteLength}B, expected ${expectedBytes}B (dim=${this.dim}). Run \`enquire-mcp clear-embeddings\` and rebuild.\n`
        );
        continue;
      }
      const vec = new Float32Array(r.vector.buffer, r.vector.byteOffset, this.dim);
      let score = 0;
      for (let i = 0; i < this.dim; i++) {
        score += (queryVec[i] ?? 0) * (vec[i] ?? 0);
      }
      if (score < minScore) continue;
      heap.push({
        rel_path: r.rel_path,
        chunk_index: r.chunk_index,
        line_start: r.line_start,
        line_end: r.line_end,
        text_preview: r.text_preview,
        score,
        kind: (r.kind === "pdf" ? "pdf" : "md") as EmbedChunkKind
      });
    }
    heap.sort((a, b) => b.score - a.score);
    return heap.slice(0, k);
  }

  /** Total embedded chunks — used by stats / UI. */
  totalChunks(): number {
    const db = this.requireDb();
    const row = db.prepare("SELECT COUNT(*) AS n FROM embeddings").get<{ n: number }>();
    return row?.n ?? 0;
  }
}

/** Default location for the embed db, alongside the FTS5 db + parse cache. */
export function defaultEmbedDbFile(vaultHashPrefix: string): string {
  // Caller is expected to compose the prefix with `~/.cache/enquire/<hash>` —
  // we just append the .embed.db extension for consistency with .fts5.db.
  return `${vaultHashPrefix}.embed.db`;
}
