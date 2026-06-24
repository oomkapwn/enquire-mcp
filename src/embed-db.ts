// Persistent embedding store (v2.0 alpha). SQLite-backed Float32 vectors,
// brute-force cosine top-K retrieval. Paragraph-level chunking via
// fts5.chunkContent — but NB embeddings chunk the frontmatter-stripped BODY (to
// keep YAML out of the vectors) while the FTS5 index chunks the FULL note
// content. For notes WITHOUT frontmatter the two chunkings are identical; the
// embedding pipeline shifts its chunk line numbers to FILE-absolute (v3.10.0-rc.17,
// audit M1) so `line_start`/`line_end` match FTS5 regardless. In `block`
// granularity the per-note chunk INDEX can still differ for frontmatter'd notes;
// the default `note` granularity fuses by path and is unaffected. Foundation for
// the hybrid RRF scorer.
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
import { optionalDepDetail } from "./optional-dep.js";
import { stripTrailingSlashes } from "./wildcard-match.js";

const SCHEMA_VERSION = 3;
// v2 added the `kind` column ("md" | "pdf") so PDF chunks live in the same
// embedding index as markdown — `obsidian_search` returns blended hits with
// the kind flag exposed to agents. Schema bump auto-rebuilds.
// v3 (v2.17.0) added int8 vector quantization. The `quantization` meta key
// records the BLOB encoding. When "f32" (default), each vector is stored
// as `dim × 4` bytes Float32. When "int8", each vector is stored as
// `dim × 1` bytes int8 + 8 bytes (Float32 vMin + Float32 scale) for
// per-vector dequantization. ~4× storage reduction, ~1-2% recall@10 loss.
// Mode is per-database; mixing rows is unsupported (a mode change
// triggers full rebuild via the bootstrap-schema check).

/** Content-source kind. Mirrors ChunkKind in src/fts5.ts. */
export type EmbedChunkKind = "md" | "pdf";

/** v2.17.0 — vector storage encoding. */
export type EmbedQuantization = "f32" | "int8";

/**
 * A single hit from {@link EmbedDb.search}. Mirrors the {@link FtsSearchHit}
 * shape so the RRF fusion layer can blend them by id (rel_path + chunk_index).
 */
export interface EmbedSearchHit {
  /** Vault-relative path of the source note / PDF. */
  rel_path: string;
  /** 0-based chunk position within the source. */
  chunk_index: number;
  /** 1-based starting line in the source. */
  line_start: number;
  /** 1-based ending line in the source (inclusive). */
  line_end: number;
  /** Raw chunk text — caller can render snippets. */
  text_preview: string;
  /** Cosine similarity (since vectors are L2-normalized at insert time). */
  score: number;
  /** v2.8.0 — content-source kind. Defaults to "md" for backward compat. */
  kind: EmbedChunkKind;
}

/** Counter summary returned by the embed-sync routine in `server.ts`. */
export interface EmbedSyncReport {
  /** Files newly embedded (no prior source_state row). */
  added: number;
  /** Files re-embedded due to mtime change. */
  updated: number;
  /** Files dropped because the source vanished from the vault. */
  deleted: number;
  /** Files whose mtime matched the stored row — no work needed. */
  unchanged: number;
  /** Total chunks in the index after the sync. */
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
      // rc.57 (OPTDEP-SQLITE-PATH-LEAK-EMBEDDB) — code only; the raw message can embed an abs path.
      throw new Error(
        `better-sqlite3 native binding failed to load (try: \`npm rebuild better-sqlite3\` or reinstall without --omit=optional / --ignore-scripts). (${optionalDepDetail(probeErr)})`
      );
    }
    BetterSqliteCtor = ctor;
    return ctor;
  } catch (err) {
    // rc.57 (OPTDEP-SQLITE-PATH-LEAK-EMBEDDB) — Node's ERR_MODULE_NOT_FOUND message embeds the
    // importing file's ABSOLUTE path ("imported from /Users/.../dist/embed-db.js"); this error
    // reaches bearer-auth serve-http clients via signal_errors.embeddings. Surface only the code.
    throw new Error(
      `Persistent embeddings require the optional 'better-sqlite3' dependency; install failed or the binding could not be loaded. (${optionalDepDetail(err)})`
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
  // better-sqlite3's `run` returns `{ changes, lastInsertRowid }`. We type
  // `lastInsertRowid` as `bigint | number` because better-sqlite3 returns
  // bigint by default (and number when `safeIntegers(false)` is set). The
  // single use site in v3.9.0-rc.2 (`upsertNote`) coerces via `Number(...)`.
  run(...params: unknown[]): { changes: number; lastInsertRowid: bigint | number };
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
  /**
   * v2.17.0 — vector storage encoding.
   * - `"f32"` (default) — Float32 BLOB, 4 bytes per dim.
   * - `"int8"` — int8 BLOB + per-vector Float32 min + Float32 scale,
   *   ~1 byte per dim + 8 bytes overhead. ~4× storage reduction at
   *   ~1-2% recall@10 cost.
   *
   * Mode is per-database; switching modes triggers a full rebuild
   * via the schema-mismatch path in `bootstrapSchema`.
   */
  quantization?: EmbedQuantization;
}

/**
 * v2.17.0 — encode a Float32 vector for storage as int8 + (vMin, scale).
 * Asymmetric scalar quantization: the smallest Float32 component maps
 * to int8 0; the largest maps to int8 255; intermediate values are
 * linearly interpolated. Dequantization: `f[i] ≈ q[i] * scale + vMin`.
 *
 * BLOB layout (dim × 1 + 8 bytes):
 *   bytes [0 .. dim)         int8 quantized values
 *   bytes [dim .. dim+4)     Float32 vMin (little-endian)
 *   bytes [dim+4 .. dim+8)   Float32 scale (little-endian)
 *
 * For a 384-dim vector this is 392 bytes vs 1536 for Float32 — a
 * 3.92× reduction at the storage layer.
 */
export function encodeInt8Vector(vec: Float32Array): Buffer {
  let vMin = Infinity;
  let vMax = -Infinity;
  for (let i = 0; i < vec.length; i++) {
    const x = vec[i] ?? 0;
    if (x < vMin) vMin = x;
    if (x > vMax) vMax = x;
  }
  // Edge case: all-equal vector (e.g. all zeros). vMax === vMin, scale=0
  // would div-zero in dequant. Force scale to 1 and rely on the int8 0s
  // representing the constant.
  const range = vMax - vMin;
  const scale = range > 0 ? range / 255 : 1;
  const buf = Buffer.allocUnsafe(vec.length + 8);
  for (let i = 0; i < vec.length; i++) {
    const x = vec[i] ?? 0;
    const q = scale > 0 ? Math.round((x - vMin) / scale) : 0;
    // Clamp into [0, 255] so floating-point round-up at the boundary
    // doesn't escape the byte range.
    buf[i] = q < 0 ? 0 : q > 255 ? 255 : q;
  }
  buf.writeFloatLE(vMin, vec.length);
  buf.writeFloatLE(scale, vec.length + 4);
  return buf;
}

/**
 * v2.17.0 — decode an int8-quantized vector buffer back to Float32.
 * Inverse of `encodeInt8Vector`. Caller passes `dim` so we know how
 * many bytes are int8 vs the trailing min/scale tuple.
 */
export function decodeInt8Vector(buf: Buffer, dim: number): Float32Array {
  if (buf.byteLength !== dim + 8) {
    throw new Error(`decodeInt8Vector: buf has ${buf.byteLength}B, expected ${dim + 8}B (dim=${dim})`);
  }
  const vMin = buf.readFloatLE(dim);
  const scale = buf.readFloatLE(dim + 4);
  const out = new Float32Array(dim);
  for (let i = 0; i < dim; i++) {
    out[i] = (buf[i] ?? 0) * scale + vMin;
  }
  return out;
}

/**
 * Persistent embedding index backed by SQLite (one row per chunk + meta
 * table for cross-vault contamination guards). Vectors are stored as
 * Float32 BLOBs (default) or int8-quantized BLOBs (`quantization: "int8"`,
 * ~4× storage reduction at ~1-2% recall@10 cost). Brute-force cosine
 * top-K via {@link EmbedDb.search} or wrap with HNSW (see `src/hnsw.ts`)
 * for sub-10ms queries at million-chunk scale.
 *
 * Schema is bootstrapped on `open()` and auto-rebuilt on any meta
 * mismatch (vault root, model alias, dim, quantization, schema version).
 *
 * @example
 * ```ts
 * const db = new EmbedDb({ file, vaultRoot, modelAlias: "multilingual", dim: 384 });
 * await db.open();
 * db.upsertNote(relPath, mtimeMs, chunks);
 * const hits = db.search(queryVec, 10);
 * db.close();
 * ```
 */
export class EmbedDb {
  private db: Db | null = null;
  private readonly file: string;
  private readonly vaultRoot: string;
  private readonly modelAlias: string;
  private readonly dim: number;
  /** v2.17.0 — vector storage encoding. */
  private readonly quantization: EmbedQuantization;
  /** Bytes per encoded vector — pre-computed once for hot-path checks. */
  private readonly encodedBytes: number;

  constructor(opts: EmbedDbOptions) {
    this.file = opts.file;
    this.vaultRoot = opts.vaultRoot;
    this.modelAlias = opts.modelAlias;
    this.dim = opts.dim;
    this.quantization = opts.quantization ?? "f32";
    this.encodedBytes = this.quantization === "int8" ? this.dim + 8 : this.dim * 4;
  }

  /**
   * Open the SQLite database, bootstrap the schema, and tighten file perms
   * to 0o600 on the db + WAL/SHM sidecars (note bodies live here — same
   * privacy posture as `vault.ts`'s persistent parse cache). Idempotent —
   * a second call after an open is a no-op.
   *
   * @throws {Error} If `better-sqlite3` (an optional dependency) fails to
   *   load or its native binding can't be loaded.
   */
  async open(): Promise<void> {
    if (this.db) return;
    const Ctor = await loadBetterSqlite();
    // v3.7.6 M-9 (external audit) — only chmod the parent directory if WE
    // created it. See src/fts5.ts:open() for the rationale.
    const parentDir = path.dirname(this.file);
    const parentExisted = await fs
      .stat(parentDir)
      .then(() => true)
      .catch(() => false);
    await fs.mkdir(parentDir, { recursive: true, mode: 0o700 });
    if (!parentExisted) {
      await fs.chmod(parentDir, 0o700).catch(() => {});
    }
    this.db = new Ctor(this.file) as Db;
    // v3.10.0-rc.70 (round-3 re-sweep, reserve-before-try) — close-on-throw. `this.db` holds the
    // live SQLite handle BEFORE pragma + bootstrapSchema run; on a corrupt/legacy/locked file
    // those throw, and a caller that opened outside its own try/finally (e.g. server.ts's HNSW
    // path) would otherwise leak the handle + its WAL/SHM locks for the whole serve lifetime.
    // Self-cleaning here protects EVERY caller regardless of its own discipline (the rc.45/rc.49
    // "fix the source every caller funnels through" lesson).
    try {
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = NORMAL");
      this.bootstrapSchema();
    } catch (e) {
      this.close();
      throw e;
    }
    await Promise.all(
      [this.file, `${this.file}-wal`, `${this.file}-shm`].map((p) => fs.chmod(p, 0o600).catch(() => {}))
    );
  }

  /**
   * Remove the embed db + WAL/SHM sidecars AND the HNSW persistence sidecars
   * (`<base>.hnsw.bin` + `<base>.hnsw.meta.json`, where `<base>` is the embed
   * file with its `.embed.db` suffix stripped — mirrors the persist path in
   * server.ts). Idempotent.
   *
   * v3.9.0-rc.34 (deep-audit P-2) — the HNSW sidecars were previously NOT
   * removed by `clear-embeddings`, so a `--use-hnsw` user's vault content
   * persisted on disk after "clearing" — and the `.hnsw.meta.json` carries
   * `text_preview` (raw chunk text), so this was a right-to-erasure / data-
   * cleanup gap, not just stale-index hygiene. Now the single file-deletion
   * authority for an embed-db also erases its HNSW companions.
   */
  async clearOnDisk(): Promise<boolean> {
    this.close();
    let removed = false;
    // v3.10.0-rc.20 (audit M7) — derive the HNSW persist base via the SHARED
    // `hnswPersistBase` helper (same one server.ts's writer uses), so the eraser
    // and the writer can never drift. The index writes `<base>.bin` + the
    // metadata writes `<base>.meta.json` (sidecars carry raw text_preview).
    const hnswBase = hnswPersistBase(this.file);
    const targets = [this.file, `${this.file}-wal`, `${this.file}-shm`, `${hnswBase}.bin`, `${hnswBase}.meta.json`];
    for (const p of targets) {
      try {
        await fs.unlink(p);
        removed = true;
      } catch {
        // missing is fine
      }
    }
    return removed;
  }

  /** Close the underlying SQLite handle. Idempotent — calling close
   *  twice is safe. Call before process exit to flush WAL. */
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
    // v2.17.0 — quantization mode is part of the contamination guard.
    // Existing pre-v2.17 dbs have no `quantization` meta key; treat as
    // "f32" (the only mode v2.16- supported) for backward compatibility.
    const existingQuant = meta.quantization ?? "f32";
    const quantMatch = existingQuant === this.quantization;
    // v3.7.19 γ4 / R-6 — wrap DROP+CREATE+writeMeta in one transaction.
    // Same rationale as fts5.ts bootstrapSchema fix. Closes the auditor's
    // round-20 R-6 finding (deferred from that release).
    const txn = db.transaction(() => {
      if (!versionMatch || !rootMatch || !modelMatch || !dimMatch || !quantMatch) {
        const reason: string[] = [];
        if (!versionMatch) reason.push(`schema_version ${meta.schema_version} → ${SCHEMA_VERSION}`);
        if (!rootMatch) reason.push(`vault_root ${meta.vault_root} → ${this.vaultRoot}`);
        if (!modelMatch) reason.push(`model ${meta.model_alias} → ${this.modelAlias}`);
        if (!dimMatch) reason.push(`dim ${meta.dim} → ${this.dim}`);
        if (!quantMatch) reason.push(`quantization ${existingQuant} → ${this.quantization}`);
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
        dim: String(this.dim),
        quantization: this.quantization
      });
    });
    txn();
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
    // v3.7.19 γ2 — same fix as fts5.ts:writeMeta. Crash mid-loop could
    // leave model/dim/quantization meta partially-updated, triggering
    // K-1-style "embedder model mismatch" on next open. Class γ.
    const txn = db.transaction(() => {
      for (const [k, v] of Object.entries(kv)) stmt.run(k, v);
    });
    txn();
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
  /**
   * @returns v3.9.0-rc.2 — `{ oldIds, newIds }`. `oldIds` is the set of
   *   `embeddings.id` values that were deleted (the file's previous
   *   chunks, before this upsert); `newIds` is the set of fresh ids
   *   assigned by AUTOINCREMENT, in the same order as the input `chunks`
   *   array. Callers maintaining a parallel in-memory index (HNSW) use
   *   these to `markDelete(oldIds)` + `addPoint(vectors, newIds)` so the
   *   index stays in sync with the embed-db without rebuilding. Pre-3.9.0
   *   the method returned `void`; existing callers that ignore the
   *   return value continue working unchanged.
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
  ): { oldIds: number[]; newIds: number[] } {
    const db = this.requireDb();
    const dim = this.dim;
    const out = { oldIds: [] as number[], newIds: [] as number[] };
    const tx = db.transaction((...args: unknown[]) => {
      const rows = args[0] as typeof chunks;
      // v3.9.0-rc.2 — capture the old ids BEFORE the DELETE so the
      // watcher can markDelete them in HNSW. Sorted ascending so callers
      // get stable ordering for snapshot diffing.
      const oldRows = db
        .prepare("SELECT id FROM embeddings WHERE rel_path = ? ORDER BY id")
        .all<{ id: number }>(relPath);
      out.oldIds = oldRows.map((r) => r.id);
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
        // v2.17.0 — encode per the configured quantization mode.
        // f32: zero-copy slice over the source buffer (matches v2.16- behavior).
        // int8: per-vector quantize + 8-byte (vMin, scale) tuple.
        const blob =
          this.quantization === "int8"
            ? encodeInt8Vector(c.vector)
            : Buffer.from(c.vector.buffer, c.vector.byteOffset, c.vector.byteLength);
        const result = insert.run(relPath, c.chunkIndex, c.lineStart, c.lineEnd, c.textPreview, blob, kind);
        // v3.9.0-rc.2 — capture the AUTOINCREMENT id assigned to this row.
        // better-sqlite3 returns `lastInsertRowid` as bigint or number; cast
        // to number since embedding ids are within Number.MAX_SAFE_INTEGER
        // for all realistic vault sizes (~10^15 chunks).
        out.newIds.push(Number(result.lastInsertRowid));
      }
      db.prepare(
        `INSERT OR REPLACE INTO source_state (rel_path, mtime_ms, n_chunks, kind, indexed_at)
         VALUES (?, ?, ?, ?, datetime('now'))`
      ).run(relPath, mtimeMs, rows.length, kind);
    });
    tx(chunks);
    return out;
  }

  /** Drop a note's embeddings entirely (used on file deletion).
   *
   * v3.7.11 (round-13 audit, sibling of v3.7.10 #10) — wrapped DELETE
   * embeddings + DELETE source_state in a single transaction. Pre-fix
   * a crash between the two statements left an orphaned source_state
   * row pointing at no chunks. Less critical than upsertNote (both
   * statements are idempotent DELETEs) but for consistency with
   * upsertNote (already transactional) + reindexFile (v3.7.10) +
   * reindexPdfFile (v3.7.10), this completes the atomicity class fix.
   */
  /**
   * @returns v3.9.0-rc.2 — the set of `embeddings.id` values that were
   *   deleted (empty if the file had no embed-db rows). Callers use this
   *   to `markDelete(deletedIds)` on a parallel HNSW index. Pre-3.9.0
   *   the method returned `void`; existing callers that ignore the
   *   return value continue working unchanged.
   */
  deleteNote(relPath: string): number[] {
    const db = this.requireDb();
    const deletedIds: number[] = [];
    const txn = db.transaction(() => {
      // v3.9.0-rc.2 — capture deleted ids BEFORE the DELETE for HNSW sync.
      const rows = db.prepare("SELECT id FROM embeddings WHERE rel_path = ? ORDER BY id").all<{ id: number }>(relPath);
      for (const r of rows) deletedIds.push(r.id);
      db.prepare("DELETE FROM embeddings WHERE rel_path = ?").run(relPath);
      db.prepare("DELETE FROM source_state WHERE rel_path = ?").run(relPath);
    });
    txn();
    return deletedIds;
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
    // CodeQL js/polynomial-redos flags `\/+$` here as polynomial. False
    // positive: the `$` anchor forces match from end-of-string, and `\/+`
    // consumes only `/` chars greedily. Worst-case input (long trailing
    // run of slashes) is O(n), not O(n²).
    const folderPrefix = opts.folder ? `${stripTrailingSlashes(opts.folder)}/` : null;

    // v2.0.0-beta.1 P2 fix: prefix-equality via substr — avoids LIKE pattern
    // semantics so folder names containing `%` / `_` (rare but possible in
    // Obsidian) don't expand into wider matches. Matches the pattern used by
    // FtsIndex.search() in fts5.ts.
    const rows = db
      .prepare(
        folderPrefix
          ? // rc.43 M1 — length(?) counts CHARACTERS (like substr), not JS UTF-16 code
            // units; otherwise an astral-char folder name (emoji) matched ZERO rows.
            // Mirrors FtsIndex.search() in fts5.ts.
            `SELECT rel_path, chunk_index, line_start, line_end, text_preview, vector, kind
             FROM embeddings WHERE substr(rel_path, 1, length(?)) = ?`
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
      }>(...(folderPrefix ? [folderPrefix, folderPrefix] : [])); // rc.43 M1 — bind prefix twice (length(?) + substr=?)

    const expectedBytes = this.encodedBytes;
    const heap: EmbedSearchHit[] = [];
    for (const r of rows) {
      // v2.0.0-beta.1 P2 fix: assert byteLength before wrapping. A truncated
      // / corrupt BLOB (e.g. from an aborted upsert mid-transaction) would
      // produce a Float32Array that reads past the source buffer's end and
      // emits garbage scores. Skip + warn rather than poison results.
      if (r.vector.byteLength !== expectedBytes) {
        process.stderr.write(
          `enquire: skipping ${r.rel_path}#${r.chunk_index} — vector has ${r.vector.byteLength}B, expected ${expectedBytes}B (dim=${this.dim}, mode=${this.quantization}). Run \`enquire-mcp clear-embeddings\` and rebuild.\n`
        );
        continue;
      }
      // v2.17.0 — decode per the configured quantization mode.
      const vec =
        this.quantization === "int8"
          ? decodeInt8Vector(r.vector, this.dim)
          : new Float32Array(r.vector.buffer, r.vector.byteOffset, this.dim);
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

  /**
   * v2.16.0 — compute a tractable signature of the embedding index for
   * HNSW staleness detection. Format: `dim=<n>;rows=<n>;maxId=<n>;model=<alias>`.
   *
   * Why this composite (vs full content hash)?
   *   • Full hash would require reading every BLOB on every serve start —
   *     wastes the I/O savings the persisted HNSW is supposed to give us.
   *   • Rowcount + max-id catches every common change pattern: insert
   *     (max-id moves up), delete (rowcount drops), update (max-id moves
   *     up because we DELETE+INSERT). Edge case: updating in-place
   *     without changing max-id (rare in our codebase — upsertNote always
   *     deletes+reinserts so max-id always advances).
   *   • dim + model alias guard against a model swap that re-embeds with
   *     a different vector space.
   */
  computeSignature(): string {
    const db = this.requireDb();
    const row = db.prepare("SELECT COUNT(*) AS n, MAX(id) AS maxId FROM embeddings").get<{
      n: number;
      maxId: number | null;
    }>();
    const rows = row?.n ?? 0;
    const maxId = row?.maxId ?? 0;
    // v3.7.6 M-10 (external audit) — include `quantization` in the
    // signature. Pre-fix: signature was only `dim;rows;maxId;model` — if a
    // user re-built with `--quantize-embeddings int8` (vs the previous
    // `f32` build) while rowcount/maxId/dim/model stayed the same, the
    // persisted HNSW sidecar was considered "fresh" but its float32
    // vectors no longer matched the int8 bytes in the new embed-db rows.
    // Including `quantization` in the signature forces a rebuild on
    // encoding switch.
    return `dim=${this.dim};rows=${rows};maxId=${maxId};model=${this.modelAlias};quant=${this.quantization}`;
  }

  /**
   * v2.13.0 — return every (vector, row) pair for HNSW build. Caller
   * is responsible for assigning sequential integer labels (we use
   * `embeddings.id` since it's already a stable AUTOINCREMENT PK).
   *
   * Memory footprint: ~1.5 KB per row (384-dim Float32 + path string +
   * preview). For 50K chunks: ~75 MB peak during build. Caller should
   * release the array after building HNSW (we intentionally don't
   * stream — HNSW build is 30s on 50K chunks anyway, the 75 MB is
   * insignificant compared to the ONNX runtime + FTS5 working set).
   */
  getAllVectors(): Array<{
    label: number;
    vector: Float32Array;
    rel_path: string;
    chunk_index: number;
    line_start: number;
    line_end: number;
    text_preview: string;
    kind: EmbedChunkKind;
  }> {
    const db = this.requireDb();
    const rows = db
      .prepare("SELECT id, rel_path, chunk_index, line_start, line_end, text_preview, vector, kind FROM embeddings")
      .all<{
        id: number;
        rel_path: string;
        chunk_index: number;
        line_start: number;
        line_end: number;
        text_preview: string;
        vector: Buffer;
        kind: string | null;
      }>();
    const expectedBytes = this.encodedBytes;
    const out: ReturnType<EmbedDb["getAllVectors"]> = [];
    for (const r of rows) {
      // Match the corruption guard from search() — skip rows with
      // mis-sized vectors so a partial DB doesn't poison the HNSW build.
      if (r.vector.byteLength !== expectedBytes) {
        process.stderr.write(
          `enquire: skipping ${r.rel_path}#${r.chunk_index} during getAllVectors — vector has ${r.vector.byteLength}B, expected ${expectedBytes}B (dim=${this.dim}, mode=${this.quantization}). Run \`enquire-mcp clear-embeddings\` and rebuild.\n`
        );
        continue;
      }
      // v2.17.0 — decode + always copy. HNSW takes ownership of the
      // Float32Array slice for the lifetime of the index; sharing the
      // SQLite row buffer would risk use-after-free if the row is GC'd
      // or the cursor advances. For int8, decode produces a fresh
      // Float32Array already. For f32, copy from the SQLite buffer.
      const vec =
        this.quantization === "int8"
          ? decodeInt8Vector(r.vector, this.dim)
          : (() => {
              const v = new Float32Array(this.dim);
              v.set(new Float32Array(r.vector.buffer, r.vector.byteOffset, this.dim));
              return v;
            })();
      out.push({
        label: r.id,
        vector: vec,
        rel_path: r.rel_path,
        chunk_index: r.chunk_index,
        line_start: r.line_start,
        line_end: r.line_end,
        text_preview: r.text_preview,
        kind: (r.kind === "pdf" ? "pdf" : "md") as EmbedChunkKind
      });
    }
    return out;
  }
}

/** Default location for the embed db, alongside the FTS5 db + parse cache. */
export function defaultEmbedDbFile(vaultHashPrefix: string): string {
  // Caller is expected to compose the prefix with `~/.cache/enquire/<hash>` —
  // we just append the .embed.db extension for consistency with .fts5.db.
  return `${vaultHashPrefix}.embed.db`;
}

/**
 * v3.10.0-rc.20 (audit M7) — derive the HNSW persistence base for an embed-db
 * file. `<dir>/<x>.embed.db` → `<dir>/<x>.hnsw`; the index writes `<base>.bin`
 * and the metadata writes `<base>.meta.json` (see {@link import("./hnsw.js")}).
 *
 * SINGLE SOURCE OF TRUTH for the base so the WRITER (server.ts `persistFile`,
 * passed to `saveTo`/`loadHnswFromDisk`) and the ERASER ({@link EmbedDb.clearOnDisk})
 * can NEVER drift. If they computed the base independently and one changed (the
 * strip regex or the `.hnsw` suffix), `clear-embeddings` would leave the HNSW
 * sidecars on disk — and `.hnsw.meta.json` carries raw `text_preview`, so that's
 * a right-to-erasure (GDPR) gap (the rc.34 P-2 class). The erasure-completeness
 * invariant asserts both call sites route through this helper.
 */
export function hnswPersistBase(embedDbFile: string): string {
  return `${embedDbFile.replace(/\.embed\.db$/, "")}.hnsw`;
}

/**
 * v3.6.1 CRIT-1 — non-destructive peek at an existing embed-db's meta row.
 *
 * Reads `model_alias`, `dim`, `quantization`, `vault_root`, `schema_version`
 * from a SQLite file WITHOUT opening it via `EmbedDb` (which would trigger
 * `bootstrapSchema()` and DROP TABLE on any mismatch with the caller's
 * declared model). This lets a caller like `prepareServerDeps()`
 * pre-discover what model the embed-db was built with, then open it with
 * the matching model — avoiding the data-destruction class of bug the
 * external (anonymous) v3.6.0 audit caught.
 *
 * **Class-closure timeline (retroactive correction batch — see also
 * v3.7.2 audit response for the 4th drift instance: this TSDoc itself
 * previously mis-attributed the closure to v3.6.3):**
 * - v3.6.1 fixed 1 callsite (`server.ts` HNSW path) and claimed "CRIT-1
 *   closed" — overclaim; 9 callsites stayed vulnerable.
 * - v3.6.2 fixed `server.ts:254` (serve), `src/tools/search.ts:917`
 *   (hot path) plus the K-1b sibling for FtsIndex; CHANGELOG claimed
 *   "all 10 callsites" — still an overclaim; cli.ts had 5 residual.
 * - v3.6.3 was deferred to a marketing-only patch ("memory for AI
 *   agents" positioning); K-1 work was pushed to v3.6.4.
 * - v3.6.4 fixed the cli.ts residual: `cli.ts:398` (build-embeddings),
 *   `cli.ts:554` (setup step 3), `cli.ts:311` (index), `cli.ts:638`
 *   (eval). `clear-*` paths marked `// SAFE BY DESIGN`. Added
 *   `tests/k1-class-invariant.test.ts` (grep gate).
 * - v3.7.0 added `tests/k1-ast-invariant.test.ts` (TypeScript compiler
 *   API def-use trace) catching the "peek called but result discarded"
 *   bypass that grep would miss. Plus `peekEmbedDbMetaCached` for
 *   ~20× speedup on the search hot path.
 *
 * Enforced by `tests/k1-class-invariant.test.ts` (grep, 40-line window)
 * and `tests/k1-ast-invariant.test.ts` (AST def-use trace).
 *
 * Returns null if the file doesn't exist OR doesn't have a `meta` table
 * yet (fresh db). v3.11.0-rc.9 (audit re-verify) — TSDoc corrected: this NEVER
 * throws (rc.34 wrapped `new Database()` + the meta queries in a catch that maps
 * ANY failure — corrupt / unreadable / not-a-DB / directory / missing dep — to
 * null), since it runs unguarded on the search hot path + in CLI subcommands.
 *
 * The opened SQLite handle is read-only and closed before return — no
 * lock contention with a subsequent `EmbedDb.open()`.
 *
 * @param file - Absolute path to a `.embed.db` file.
 * @returns Meta dict if the file is a populated embed-db, null otherwise.
 * @example
 * ```ts
 * const meta = await peekEmbedDbMeta(embedFile);
 * if (meta?.model_alias) {
 *   const model = resolveModel(meta.model_alias); // honor what was built
 * }
 * ```
 */
export async function peekEmbedDbMeta(file: string): Promise<{
  schema_version?: string;
  vault_root?: string;
  model_alias?: string;
  dim?: string;
  quantization?: string;
} | null> {
  const fsMod = await import("node:fs");
  if (!fsMod.existsSync(file)) return null;
  // Lazy-import better-sqlite3 (optionalDependency).
  let Database: typeof import("better-sqlite3");
  try {
    Database = (await import("better-sqlite3")).default as unknown as typeof import("better-sqlite3");
  } catch {
    // No better-sqlite3 installed; embed-db doesn't work anyway. Return null.
    return null;
  }
  // v3.10.0-rc.34 (post-rc.33 RCA — sibling of the peekFtsMetaSafe class fixed
  // in rc.33) — `new Database()` + the meta queries are now INSIDE the try: a
  // corrupt / unreadable / not-a-DB / directory `.embed.db` must NOT throw out
  // of this peek. It is called UNGUARDED on the `embeddings_search` hot path
  // (tools/search.ts, before that function's own try) and in CLI subcommands,
  // so a throw here would error the search / crash the CLI instead of degrading.
  // Any failure → null (treated as "no embed-db" — the existing graceful path).
  type PeekDb = { prepare(sql: string): { get(): unknown; all(): unknown }; close(): void };
  let db: PeekDb | null = null;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true }) as unknown as PeekDb;
    // Confirm meta table exists before SELECT — avoid throwing on fresh dbs.
    const tableCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'").get();
    if (!tableCheck) return null;
    const rows = db.prepare("SELECT key, value FROM meta").all() as { key: string; value: string }[];
    const meta: Record<string, string> = {};
    for (const row of rows) meta[row.key] = row.value;
    return meta;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/**
 * v3.7.0 L-1 — cached variant of {@link peekEmbedDbMeta} for hot paths.
 *
 * `peekEmbedDbMeta()` opens a SQLite handle (read-only) and closes it.
 * That's ~5-10ms per call on a typical SSD — affordable at server-start
 * (one call), but a 2-20% overhead on every `embeddingsSearch` /
 * `obsidian_search` invocation since v3.6.4's K-1 fix added the call
 * to `src/tools/search.ts:917`.
 *
 * This wrapper caches the peek result keyed by `file` path. Cache entries
 * are invalidated when the file's `mtimeMs` changes — covering the
 * `clear-embeddings` + `build-embeddings` rebuild flow without requiring
 * manual cache invalidation. On `stat` failure (file removed), the cache
 * entry is also dropped so subsequent calls return `null` (matching
 * non-cached semantics).
 *
 * **Thread/race notes**: the cache is module-level state. In a multi-
 * worker context (none in this codebase today) each worker has its own
 * cache. A race between `stat` and `peekEmbedDbMeta` is harmless — the
 * worst case is one stale peek before the next call sees the new mtime.
 *
 * @param file - Absolute path to a `.embed.db` file.
 * @returns Same shape as `peekEmbedDbMeta` (cached when file mtime unchanged).
 */
const peekCache = new Map<string, { mtimeMs: number; meta: PeekEmbedDbMetaResult }>();
type PeekEmbedDbMetaResult = Awaited<ReturnType<typeof peekEmbedDbMeta>>;

/**
 * v3.9.0-rc.28 (external-audit M-6) — cap on `peekCache`. A long-running `serve`
 * over a vault with many distinct `.embed.db` paths would otherwise grow the
 * cache without bound (one entry per file path forever). 512 covers any
 * realistic single-vault session with comfortable headroom.
 */
export const MAX_PEEK_CACHE_ENTRIES = 512;

/**
 * Insert `key→value` into an insertion-ordered `Map` used as an LRU cache, then
 * evict the oldest entries until `size <= max`. Pure + exported so the eviction
 * is unit-testable directly (the `peekEmbedDbMetaCached` path needs real files).
 * Mirrors the `boundedSetAdd` helper (bases.ts, rc.15). On a re-set of an
 * existing key the caller should `delete` first so recency is refreshed.
 * @internal exported for unit tests.
 */
export function lruMapSet<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.delete(key); // refresh recency: re-inserting moves the key to the newest slot
  map.set(key, value);
  while (map.size > max) {
    const oldest = map.keys().next().value as K | undefined;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

export async function peekEmbedDbMetaCached(file: string): Promise<PeekEmbedDbMetaResult> {
  const fsMod = await import("node:fs/promises");
  let mtimeMs: number;
  try {
    const stat = await fsMod.stat(file);
    mtimeMs = stat.mtimeMs;
  } catch {
    // File missing/inaccessible — drop any stale cache and delegate to
    // the non-cached peek (which itself returns null for missing files).
    peekCache.delete(file);
    return peekEmbedDbMeta(file);
  }
  const cached = peekCache.get(file);
  if (cached && cached.mtimeMs === mtimeMs) {
    // LRU recency bump: move this key to the newest slot so it isn't evicted
    // ahead of genuinely-older entries.
    peekCache.delete(file);
    peekCache.set(file, cached);
    return cached.meta;
  }
  const meta = await peekEmbedDbMeta(file);
  lruMapSet(peekCache, file, { mtimeMs, meta }, MAX_PEEK_CACHE_ENTRIES);
  return meta;
}

/**
 * v3.7.0 L-1 — test-only. Clear the module-level peek cache. Used in
 * unit tests to isolate per-test state; in production the cache lives
 * as long as the process.
 */
export function clearPeekCache(): void {
  peekCache.clear();
}
