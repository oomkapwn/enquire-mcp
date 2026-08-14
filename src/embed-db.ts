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
// The default dense path is brute-force cosine. HNSW provides an approximate
// nearest-neighbor path when corpus-scale measurements justify the index.

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { optionalDepDetail } from "./optional-dep.js";
import { EMBED_DB_SCHEMA_VERSION } from "./schema-contract.js";
import { clearWatcherActivationGuard, preflightWatcherActivationGuardRecovery } from "./watcher-activation-guard.js";
import { stripTrailingSlashes } from "./wildcard-match.js";

function errnoCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null || !("code" in err)) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

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
// v4 (v3.12.0-rc.19) pins q8 inference weights. Even though the stored BLOB
// layout is unchanged, every vector must be rebuilt in the new model space.

/** Content-source kind. Mirrors ChunkKind in src/fts5.ts. */
export type EmbedChunkKind = "md" | "pdf";

/** v2.17.0 — vector storage encoding. */
export type EmbedQuantization = "f32" | "int8";

/**
 * A single hit from {@link EmbedDb.search}. Mirrors the `FtsSearchHit`
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

/**
 * Exact persisted-source authority tuple used by final egress validation.
 *
 * @example
 * ```ts
 * const [hit] = db.searchWithReceipts(queryVector, 1);
 * if (hit) db.currentSourceReceiptMask([hit]);
 * ```
 */
export interface EmbedSourceReceipt {
  /** Vault-relative source path. */
  rel_path: string;
  /** Content-source kind. */
  kind: EmbedChunkKind;
  /** Source-state mtime selected with the persisted bytes. */
  indexed_mtime_ms: number;
  /** Monotonic source authority revision selected with the persisted bytes. */
  indexed_revision: number;
}

/**
 * Receipt-bearing embedding hit for callers that expose persisted previews.
 * The legacy {@link EmbedSearchHit} shape remains receipt-free; MCP egress
 * paths use this intersection and validate its authority tuple after their
 * final awaited live-source check.
 *
 * @example
 * ```ts
 * const hits: EmbedReceiptSearchHit[] = db.searchWithReceipts(queryVector, 10);
 * ```
 */
export type EmbedReceiptSearchHit = EmbedSearchHit & EmbedSourceReceipt;

/** Historical counter summary returned by the bulk embedding-sync routines. */
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

/** Read-only completeness summary for one embedding content kind. */
export interface EmbedKindAudit {
  /** Files declared as indexed in `source_state` for the requested kind. */
  indexed_files: number;
  /** Sum of the per-file chunk counts declared in `source_state`. */
  declared_chunks: number;
  /** Actual embedding rows stored for the requested kind. */
  indexed_chunks: number;
  /**
   * Unique paths whose declaration, row structure, vector encoding, or
   * contiguous index range is invalid, plus embedding-only paths and invalid
   * content-kind rows.
   */
  mismatched_files: number;
}

/** Numerical-health summary for stored embedding vectors of one kind. */
export interface EmbedVectorAudit {
  /** Rows containing non-finite, zero-length, or materially non-unit vectors. */
  invalid_vectors: number;
}

interface SourceStateRow {
  rel_path: string;
  mtime_ms: number;
}

// v2.0.0-beta.1 P2 fix: probe the native binding via :memory: open so the
// "JS package present but *.node binary missing" failure mode produces a
// clean error pointing at `npm rebuild`, not a raw bindings stack trace.
interface BetterSqliteOptions {
  readonly?: boolean;
  fileMustExist?: boolean;
}

type BetterSqliteConstructor = new (file: string, options?: BetterSqliteOptions) => unknown;

let BetterSqliteCtor: BetterSqliteConstructor | null = null;
async function loadBetterSqlite(): Promise<BetterSqliteConstructor> {
  if (BetterSqliteCtor) return BetterSqliteCtor;
  try {
    const mod = (await import("better-sqlite3")) as { default?: BetterSqliteConstructor };
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
  iterate<T = unknown>(...params: unknown[]): IterableIterator<T>;
}

const MAX_SOURCE_REVISION = Number.MAX_SAFE_INTEGER;
const MAX_SOURCE_RECEIPT_BATCH = 512;
const SOURCE_REVISION_TRIGGER_DEFINITIONS = [
  {
    name: "embed_source_state_revision_insert",
    sql: `CREATE TRIGGER embed_source_state_revision_insert
      AFTER INSERT ON source_state
      BEGIN
        INSERT INTO source_revision (rel_path, kind, revision)
        VALUES (NEW.rel_path, NEW.kind, 1)
        ON CONFLICT (rel_path, kind) DO UPDATE
        SET revision = source_revision.revision + 1;
      END`
  },
  {
    name: "embed_source_state_revision_update",
    sql: `CREATE TRIGGER embed_source_state_revision_update
      AFTER UPDATE ON source_state
      BEGIN
        INSERT INTO source_revision (rel_path, kind, revision)
        VALUES (OLD.rel_path, OLD.kind, 1)
        ON CONFLICT (rel_path, kind) DO UPDATE
        SET revision = source_revision.revision + 1;
        INSERT INTO source_revision (rel_path, kind, revision)
        SELECT NEW.rel_path, NEW.kind, 1
        WHERE NEW.rel_path <> OLD.rel_path OR NEW.kind <> OLD.kind
        ON CONFLICT (rel_path, kind) DO UPDATE
        SET revision = source_revision.revision + 1;
      END`
  },
  {
    name: "embed_source_state_revision_delete",
    sql: `CREATE TRIGGER embed_source_state_revision_delete
      AFTER DELETE ON source_state
      BEGIN
        INSERT INTO source_revision (rel_path, kind, revision)
        VALUES (OLD.rel_path, OLD.kind, 1)
        ON CONFLICT (rel_path, kind) DO UPDATE
        SET revision = source_revision.revision + 1;
      END`
  },
  {
    name: "embed_source_quarantine_revision_insert",
    sql: `CREATE TRIGGER embed_source_quarantine_revision_insert
      AFTER INSERT ON source_quarantine
      BEGIN
        INSERT INTO source_revision (rel_path, kind, revision)
        VALUES (NEW.rel_path, NEW.kind, 1)
        ON CONFLICT (rel_path, kind) DO UPDATE
        SET revision = source_revision.revision + 1;
      END`
  },
  {
    name: "embed_source_quarantine_revision_update",
    sql: `CREATE TRIGGER embed_source_quarantine_revision_update
      AFTER UPDATE ON source_quarantine
      BEGIN
        INSERT INTO source_revision (rel_path, kind, revision)
        VALUES (OLD.rel_path, OLD.kind, 1)
        ON CONFLICT (rel_path, kind) DO UPDATE
        SET revision = source_revision.revision + 1;
        INSERT INTO source_revision (rel_path, kind, revision)
        SELECT NEW.rel_path, NEW.kind, 1
        WHERE NEW.rel_path <> OLD.rel_path OR NEW.kind <> OLD.kind
        ON CONFLICT (rel_path, kind) DO UPDATE
        SET revision = source_revision.revision + 1;
      END`
  },
  {
    name: "embed_source_quarantine_revision_delete",
    sql: `CREATE TRIGGER embed_source_quarantine_revision_delete
      AFTER DELETE ON source_quarantine
      BEGIN
        INSERT INTO source_revision (rel_path, kind, revision)
        VALUES (OLD.rel_path, OLD.kind, 1)
        ON CONFLICT (rel_path, kind) DO UPDATE
        SET revision = source_revision.revision + 1;
      END`
  }
] as const;
const SOURCE_REVISION_TRIGGER_NAMES = SOURCE_REVISION_TRIGGER_DEFINITIONS.map(({ name }) => name);

const CURRENT_SOURCE_RECEIPT_SQL = `SELECT 1 AS current
  FROM source_state s
  JOIN source_revision r ON r.rel_path = s.rel_path AND r.kind = s.kind
  WHERE s.rel_path = ? AND s.kind = ? AND s.kind IN ('md', 'pdf')
    AND s.mtime_ms = ? AND r.revision = ? AND typeof(r.revision) = 'integer'
    AND r.revision BETWEEN 1 AND 9007199254740991
    AND NOT EXISTS (
      SELECT 1
      FROM source_quarantine q
      WHERE q.rel_path = s.rel_path AND q.kind = s.kind
    )
  LIMIT 1`;

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().replace(/;$/, "").toLowerCase();
}

function isValidSourceReceipt(receipt: EmbedSourceReceipt): boolean {
  return (
    typeof receipt === "object" &&
    receipt !== null &&
    typeof receipt.rel_path === "string" &&
    receipt.rel_path.length > 0 &&
    (receipt.kind === "md" || receipt.kind === "pdf") &&
    Number.isFinite(receipt.indexed_mtime_ms) &&
    Number.isSafeInteger(receipt.indexed_revision) &&
    receipt.indexed_revision >= 1 &&
    receipt.indexed_revision <= MAX_SOURCE_REVISION
  );
}

function currentSourceReceiptMaskFromDb(db: Db, receipts: readonly EmbedSourceReceipt[]): boolean[] {
  if (!Array.isArray(receipts)) return [];
  if (receipts.length === 0) return [];
  if (receipts.length > MAX_SOURCE_RECEIPT_BATCH) {
    throw new RangeError(`Embedding source receipt batch exceeds ${MAX_SOURCE_RECEIPT_BATCH} entries`);
  }
  const statement = db.prepare(CURRENT_SOURCE_RECEIPT_SQL);
  db.exec("BEGIN");
  try {
    const mask = receipts.map(
      (receipt) =>
        isValidSourceReceipt(receipt) &&
        statement.get<{ current: number }>(
          receipt.rel_path,
          receipt.kind,
          receipt.indexed_mtime_ms,
          receipt.indexed_revision
        )?.current === 1
    );
    db.exec("COMMIT");
    return mask;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original validation error.
    }
    throw error;
  }
}

function currentSourceReceipt(
  db: Db,
  relPath: string,
  kind: EmbedChunkKind,
  indexedMtimeMs: number,
  indexedRevision: number
): boolean {
  return (
    currentSourceReceiptMaskFromDb(db, [
      {
        rel_path: relPath,
        kind,
        indexed_mtime_ms: indexedMtimeMs,
        indexed_revision: indexedRevision
      }
    ])[0] ?? false
  );
}

function updateManifestValue(hash: ReturnType<typeof createHash>, value: string | number | Buffer): void {
  const type = Buffer.isBuffer(value) ? "b" : typeof value === "number" ? "n" : "s";
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
  hash.update(type);
  hash.update(String(bytes.byteLength));
  hash.update(":");
  hash.update(bytes);
  hash.update(";");
}

function vectorNormSquared(vector: Float32Array): number {
  let normSquared = 0;
  for (const value of vector) {
    if (!Number.isFinite(value)) return Number.NaN;
    normSquared += value * value;
  }
  return normSquared;
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
 * top-K is available via {@link EmbedDb.search}; wrap with HNSW (see
 * `src/hnsw.ts`) for approximate nearest-neighbor retrieval.
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
   * Remove the embed db + WAL/SHM sidecars, HNSW persistence sidecars, and the
   * process-restart watcher interlock (`<embed-db>.watcher-activation.guard`).
   * The guard contains no vault content, but `clear-embeddings` is the explicit
   * recovery operation after a failed startup and therefore owns its removal.
   * Idempotent.
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
    // Validate any stranded interlock BEFORE deleting the first artifact.
    // Foreign files/symlinks/special objects and unexpected directory entries
    // therefore fail closed without turning recovery into an unnecessary
    // partial erase. The guard is validated again and removed last below.
    await preflightWatcherActivationGuardRecovery(this.file);
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
      } catch (err) {
        if (errnoCode(err) !== "ENOENT") {
          // Recovery must never report success while a permission/type/race
          // error leaves a derived-data sidecar behind.
          throw new Error(`Unable to remove embedding-index artifact: ${path.basename(p)}`, { cause: err });
        }
      }
    }
    // Remove the guard LAST. If any derived artifact could not be removed, the
    // still-present guard keeps the next serve fail-closed. The helper accepts
    // only its narrow directory shape and never recursively deletes content.
    removed = (await clearWatcherActivationGuard(this.file)) || removed;
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
    const uninitialized = Object.keys(meta).length === 0;
    // A genuinely new database has no metadata yet. Any populated legacy
    // database without a schema version is unknown provenance and must rebuild;
    // accepting it here could preserve pre-rc.19 fp32-model vectors.
    const versionMatch = uninitialized || meta.schema_version === String(EMBED_DB_SCHEMA_VERSION);
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
        if (!versionMatch) {
          reason.push(`schema_version ${meta.schema_version} → ${EMBED_DB_SCHEMA_VERSION}`);
        }
        if (!rootMatch) reason.push(`vault_root ${meta.vault_root} → ${this.vaultRoot}`);
        if (!modelMatch) reason.push(`model ${meta.model_alias} → ${this.modelAlias}`);
        if (!dimMatch) reason.push(`dim ${meta.dim} → ${this.dim}`);
        if (!quantMatch) reason.push(`quantization ${existingQuant} → ${this.quantization}`);
        process.stderr.write(`enquire: rebuilding embed index (${reason.join("; ")})\n`);
        db.exec(`
          DROP TABLE IF EXISTS embeddings;
          DROP TABLE IF EXISTS source_state;
          DROP TABLE IF EXISTS source_quarantine;
          DROP TABLE IF EXISTS source_revision;
        `);
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
        CREATE TABLE IF NOT EXISTS source_quarantine (
          rel_path TEXT NOT NULL,
          kind TEXT NOT NULL,
          PRIMARY KEY (rel_path, kind)
        ) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS source_revision (
          rel_path TEXT NOT NULL,
          kind TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK (
            typeof(revision) = 'integer'
              AND revision BETWEEN 1 AND 9007199254740991
          ),
          PRIMARY KEY (rel_path, kind)
        ) WITHOUT ROWID;

        INSERT OR IGNORE INTO source_revision (rel_path, kind, revision)
        SELECT rel_path, kind, 1
        FROM source_state
        WHERE kind IN ('md', 'pdf');
        INSERT OR IGNORE INTO source_revision (rel_path, kind, revision)
        SELECT rel_path, kind, 1
        FROM source_quarantine
        WHERE kind IN ('md', 'pdf');

      `);

      // Canonical recreation closes the same-name no-op trigger bypass. The
      // whole install remains inside the bootstrap transaction, so readers
      // observe either the previous complete contract or the new one.
      for (const name of SOURCE_REVISION_TRIGGER_NAMES) {
        db.exec(`DROP TRIGGER IF EXISTS ${name}`);
      }
      for (const definition of SOURCE_REVISION_TRIGGER_DEFINITIONS) {
        db.exec(definition.sql);
      }

      this.writeMeta({
        schema_version: String(EMBED_DB_SCHEMA_VERSION),
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
        const normSquared = vectorNormSquared(c.vector);
        if (
          !Number.isFinite(normSquared) ||
          normSquared <= Number.EPSILON ||
          normSquared < 0.998 ||
          normSquared > 1.002
        ) {
          throw new Error(
            `invalid vector for ${relPath} chunk ${c.chunkIndex}: components must be finite and L2-normalized`
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
      db.prepare("DELETE FROM source_quarantine WHERE rel_path = ?").run(relPath);
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
      db.prepare("DELETE FROM source_quarantine WHERE rel_path = ?").run(relPath);
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

  /**
   * Persistently quarantine one source after an uncertain embedding attempt.
   * Physical rows remain available for a later successful replacement, but
   * every retrieval API excludes them immediately.
   *
   * @param relPath Vault-relative source path.
   * @param kind Content-source kind.
   * @returns Nothing.
   * @example
   * ```ts
   * db.quarantineSource("Private/rotated.md", "md");
   * ```
   */
  quarantineSource(relPath: string, kind: EmbedChunkKind): void {
    this.requireDb()
      .prepare("INSERT OR IGNORE INTO source_quarantine (rel_path, kind) VALUES (?, ?)")
      .run(relPath, kind);
  }

  /**
   * Return quarantined source paths in deterministic order.
   *
   * @param kind Optional content-kind filter.
   * @returns Vault-relative paths that must be retried and withheld.
   * @example
   * ```ts
   * const markdownPaths = db.getQuarantinedPaths("md");
   * ```
   */
  getQuarantinedPaths(kind?: EmbedChunkKind): string[] {
    const db = this.requireDb();
    const rows =
      kind === undefined
        ? db.prepare("SELECT DISTINCT rel_path FROM source_quarantine ORDER BY rel_path").all<{ rel_path: string }>()
        : db
            .prepare("SELECT rel_path FROM source_quarantine WHERE kind = ? ORDER BY rel_path")
            .all<{ rel_path: string }>(kind);
    return rows.map((row) => row.rel_path);
  }

  /**
   * Confirm that a persisted hit still names the exact current source
   * generation. This check is synchronous so callers can run it immediately
   * after their final awaited live-vault stat, leaving no await-sized race.
   *
   * @param relPath Vault-relative source path from the persisted hit.
   * @param kind Content-source kind from the persisted hit.
   * @param indexedMtimeMs Source mtime selected with the persisted bytes.
   * @param indexedRevision Source authority revision selected with the bytes.
   * @returns True only for the exact current state and ledger revision when no quarantine marker exists.
   * @example
   * ```ts
   * if (!db.isCurrentSourceReceipt(hit.rel_path, hit.kind, hit.indexed_mtime_ms, hit.indexed_revision)) {
   *   return [];
   * }
   * ```
   */
  isCurrentSourceReceipt(
    relPath: string,
    kind: EmbedChunkKind,
    indexedMtimeMs: number,
    indexedRevision: number
  ): boolean {
    return currentSourceReceipt(this.requireDb(), relPath, kind, indexedMtimeMs, indexedRevision);
  }

  /**
   * Validate multiple source receipts atomically in one synchronous SQLite
   * read snapshot. Output indices correspond exactly to input indices.
   *
   * @param receipts Persisted authority tuples to validate.
   * @returns A current/stale mask captured from one database snapshot.
   * @throws {RangeError} If more than 512 receipts are supplied.
   * @example
   * ```ts
   * const current = db.currentSourceReceiptMask(db.searchWithReceipts(queryVector, 10));
   * ```
   */
  currentSourceReceiptMask(receipts: readonly EmbedSourceReceipt[]): boolean[] {
    return currentSourceReceiptMaskFromDb(this.requireDb(), receipts);
  }

  /**
   * Hydrate HNSW labels from current, receipt-bound database rows.
   * Missing, orphaned, kind-mismatched, and quarantined labels are omitted.
   * Scores are deliberately absent because callers obtain them from the HNSW
   * query that produced the labels.
   *
   * @param ids Embedding row ids returned by HNSW.
   * @returns Current rows keyed by their embedding id.
   * @example
   * ```ts
   * const currentRows = db.getSearchRowsByIds([17, 42]);
   * ```
   */
  getSearchRowsByIds(ids: number[]): Map<number, Omit<EmbedReceiptSearchHit, "score">> {
    if (ids.length === 0) return new Map();
    const db = this.requireDb();
    const out = new Map<number, Omit<EmbedReceiptSearchHit, "score">>();
    const uniqueIds = [...new Set(ids)];
    // Stay below SQLite's build-dependent bind-variable limit. Adaptive HNSW
    // refill can legitimately hydrate tens of thousands of labels in a vault
    // with a broad privacy filter.
    for (let offset = 0; offset < uniqueIds.length; offset += 500) {
      const batch = uniqueIds.slice(offset, offset + 500);
      const placeholders = batch.map(() => "?").join(", ");
      const rows = db
        .prepare(
          `SELECT e.id, e.rel_path, e.chunk_index, e.line_start, e.line_end,
                  e.text_preview, e.kind, s.mtime_ms AS indexed_mtime_ms,
                  r.revision AS indexed_revision
           FROM embeddings e
           JOIN source_state s ON s.rel_path = e.rel_path AND s.kind = e.kind
           JOIN source_revision r ON r.rel_path = e.rel_path AND r.kind = e.kind
           LEFT JOIN source_quarantine q ON q.rel_path = e.rel_path AND q.kind = e.kind
           WHERE e.id IN (${placeholders}) AND q.rel_path IS NULL
             AND e.kind IN ('md', 'pdf')
             AND typeof(r.revision) = 'integer'
             AND r.revision BETWEEN 1 AND 9007199254740991
           ORDER BY e.id`
        )
        .all<{
          id: number;
          rel_path: string;
          chunk_index: number;
          line_start: number;
          line_end: number;
          text_preview: string;
          kind: EmbedChunkKind;
          indexed_mtime_ms: number;
          indexed_revision: number;
        }>(...batch);
      for (const row of rows) {
        out.set(row.id, {
          rel_path: row.rel_path,
          chunk_index: row.chunk_index,
          line_start: row.line_start,
          line_end: row.line_end,
          text_preview: row.text_preview,
          kind: row.kind,
          indexed_mtime_ms: row.indexed_mtime_ms,
          indexed_revision: row.indexed_revision
        });
      }
    }
    return out;
  }

  /**
   * Audit one content kind without mutating the index.
   *
   * A declared file is complete only when its actual rows have the declared
   * count and occupy the contiguous chunk-index range `0..n_chunks - 1`.
   * Embedding-only paths and quarantine markers are also mismatches. Both
   * sides are filtered by `kind`, so independent markdown and PDF syncs
   * cannot contaminate one another's result.
   *
   * @param kind Content-source kind to audit.
   * @returns Aggregate counts and the number of unique mismatched paths.
   * @example
   * const audit = db.auditKind("md");
   * if (audit.mismatched_files > 0) throw new Error("embedding index is incomplete");
   */
  auditKind(kind: EmbedChunkKind): EmbedKindAudit {
    const db = this.requireDb();
    const row = db
      .prepare(
        `WITH declared AS (
           SELECT rel_path, n_chunks
           FROM source_state
           WHERE kind = ?
         ),
         actual AS (
           SELECT
             rel_path,
             COUNT(*) AS actual_count,
             MIN(chunk_index) AS min_index,
             MAX(chunk_index) AS max_index,
             SUM(
               CASE
                 WHEN typeof(chunk_index) <> 'integer'
                   OR chunk_index < 0
                   OR typeof(line_start) <> 'integer'
                   OR typeof(line_end) <> 'integer'
                   OR line_start < 1
                   OR line_end < line_start
                   OR typeof(text_preview) <> 'text'
                   OR typeof(vector) <> 'blob'
                   OR length(vector) <> ?
                 THEN 1
                 ELSE 0
               END
             ) AS invalid_row_count
           FROM embeddings
           WHERE kind = ?
           GROUP BY rel_path
         ),
         mismatched AS (
           SELECT d.rel_path
           FROM declared AS d
           LEFT JOIN actual AS a ON a.rel_path = d.rel_path
           WHERE
             typeof(d.n_chunks) <> 'integer'
             OR d.n_chunks <= 0
             OR COALESCE(a.actual_count, 0) <> d.n_chunks
             OR COALESCE(a.invalid_row_count, 0) <> 0
             OR (d.n_chunks > 0 AND (a.min_index <> 0 OR a.max_index <> d.n_chunks - 1))
           UNION
           SELECT a.rel_path
           FROM actual AS a
           LEFT JOIN declared AS d ON d.rel_path = a.rel_path
           WHERE d.rel_path IS NULL
           UNION
           SELECT e.rel_path
           FROM embeddings AS e
           INNER JOIN declared AS d ON d.rel_path = e.rel_path
           WHERE e.kind <> ?
           UNION
           SELECT rel_path
           FROM embeddings
           WHERE kind NOT IN ('md', 'pdf')
           UNION
           SELECT rel_path
           FROM source_state
           WHERE kind NOT IN ('md', 'pdf')
           UNION
           SELECT rel_path
           FROM source_quarantine
           WHERE kind = ? OR typeof(kind) <> 'text' OR kind NOT IN ('md', 'pdf')
           UNION
           SELECT s.rel_path
           FROM source_state AS s
           LEFT JOIN source_revision AS r
             ON r.rel_path = s.rel_path AND r.kind = s.kind
           WHERE s.kind = ?
             AND (
               r.rel_path IS NULL
               OR typeof(r.revision) <> 'integer'
               OR r.revision < 1
               OR r.revision > 9007199254740991
             )
           UNION
           SELECT rel_path
           FROM source_revision
           WHERE (kind = ? AND (
             typeof(revision) <> 'integer'
             OR revision < 1
             OR revision > 9007199254740991
           ))
             OR typeof(kind) <> 'text'
             OR kind NOT IN ('md', 'pdf')
         )
         SELECT
           (SELECT COUNT(*) FROM declared) AS indexed_files,
           COALESCE((SELECT SUM(n_chunks) FROM declared), 0) AS declared_chunks,
           COALESCE((SELECT SUM(actual_count) FROM actual), 0) AS indexed_chunks,
           (SELECT COUNT(*) FROM mismatched) AS mismatched_files`
      )
      .get<EmbedKindAudit>(kind, this.encodedBytes, kind, kind, kind, kind, kind);
    return (
      row ?? {
        indexed_files: 0,
        declared_chunks: 0,
        indexed_chunks: 0,
        mismatched_files: 0
      }
    );
  }

  /**
   * Validate numerical health of every stored vector for one content kind.
   *
   * Evidence-grade embeddings must be finite, non-zero, and approximately
   * L2-normalized. The wider tolerance accounts for optional int8 storage
   * quantization while still rejecting zero/NaN/Infinity and arbitrary-scale
   * payloads that would invalidate cosine-as-dot-product search.
   *
   * @param kind Content-source kind to inspect.
   * @returns Count of invalid physical vector rows.
   */
  auditVectorHealth(kind: EmbedChunkKind): EmbedVectorAudit {
    const db = this.requireDb();
    let invalidVectors = 0;
    for (const row of db
      .prepare("SELECT vector FROM embeddings WHERE kind = ? ORDER BY rel_path, chunk_index, id")
      .iterate<{ vector: Buffer }>(kind)) {
      if (!Buffer.isBuffer(row.vector) || row.vector.byteLength !== this.encodedBytes) {
        invalidVectors += 1;
        continue;
      }
      let vector: Float32Array;
      try {
        vector =
          this.quantization === "int8"
            ? decodeInt8Vector(row.vector, this.dim)
            : new Float32Array(row.vector.buffer, row.vector.byteOffset, this.dim);
      } catch {
        invalidVectors += 1;
        continue;
      }
      const normSquared = vectorNormSquared(vector);
      if (!Number.isFinite(normSquared) || normSquared < 0.81 || normSquared > 1.21) {
        invalidVectors += 1;
      }
    }
    return { invalid_vectors: invalidVectors };
  }

  /**
   * Hash the exact kind-scoped source declarations and embedding payload.
   *
   * Rows, quarantine markers, and durable source revisions are streamed in
   * deterministic order so strict before/after evidence detects same-shape
   * in-place mutations without loading the vector corpus into memory.
   *
   * @param kind Content-source kind to fingerprint.
   * @returns Lowercase SHA-256 digest of all ordered physical fields.
   */
  fingerprintKind(kind: EmbedChunkKind): string {
    const db = this.requireDb();
    const hash = createHash("sha256");
    hash.update("enquire-embed-kind-manifest-v1;");
    for (const row of db
      .prepare(
        `SELECT rel_path, mtime_ms, n_chunks, kind, indexed_at
         FROM source_state
         WHERE kind = ?
         ORDER BY rel_path`
      )
      .iterate<{
        rel_path: string;
        mtime_ms: number;
        n_chunks: number;
        kind: string;
        indexed_at: string;
      }>(kind)) {
      hash.update("source;");
      updateManifestValue(hash, row.rel_path);
      updateManifestValue(hash, row.mtime_ms);
      updateManifestValue(hash, row.n_chunks);
      updateManifestValue(hash, row.kind);
      updateManifestValue(hash, row.indexed_at);
    }
    for (const row of db
      .prepare("SELECT rel_path, kind FROM source_quarantine WHERE kind = ? ORDER BY rel_path")
      .iterate<{ rel_path: string; kind: string }>(kind)) {
      hash.update("quarantine;");
      updateManifestValue(hash, row.rel_path);
      updateManifestValue(hash, row.kind);
    }
    for (const row of db
      .prepare("SELECT rel_path, kind, revision FROM source_revision WHERE kind = ? ORDER BY rel_path")
      .iterate<{ rel_path: string; kind: string; revision: number }>(kind)) {
      hash.update("revision;");
      updateManifestValue(hash, row.rel_path);
      updateManifestValue(hash, row.kind);
      updateManifestValue(hash, row.revision);
    }
    for (const row of db
      .prepare(
        `SELECT rel_path, chunk_index, line_start, line_end, text_preview, vector, kind
         FROM embeddings
         WHERE kind = ?
         ORDER BY rel_path, chunk_index, id`
      )
      .iterate<{
        rel_path: string;
        chunk_index: number;
        line_start: number;
        line_end: number;
        text_preview: string;
        vector: Buffer;
        kind: string;
      }>(kind)) {
      hash.update("embedding;");
      updateManifestValue(hash, row.rel_path);
      updateManifestValue(hash, row.chunk_index);
      updateManifestValue(hash, row.line_start);
      updateManifestValue(hash, row.line_end);
      updateManifestValue(hash, row.text_preview);
      updateManifestValue(hash, row.vector);
      updateManifestValue(hash, row.kind);
    }
    return hash.digest("hex");
  }

  /**
   * Brute-force cosine top-K over current, non-quarantined database rows.
   * Vectors are L2-normalized at insert time so cosine equals dot product.
   * This legacy-compatible surface intentionally omits internal source
   * receipts; persisted-content egress callers use {@link searchWithReceipts}.
   * Acceptable up to roughly 50K chunks; larger corpora use HNSW.
   *
   * @param queryVec L2-normalized query vector with the database dimension.
   * @param k Maximum number of ranked hits to return.
   * @param opts Optional folder prefix and minimum cosine score.
   * @returns Current, non-quarantined hits in descending cosine order.
   */
  search(queryVec: Float32Array, k: number, opts: { folder?: string; minScore?: number } = {}): EmbedSearchHit[] {
    return this.searchReceiptRows(queryVec, k, opts).map((hit) => ({
      rel_path: hit.rel_path,
      chunk_index: hit.chunk_index,
      line_start: hit.line_start,
      line_end: hit.line_end,
      text_preview: hit.text_preview,
      score: hit.score,
      kind: hit.kind
    }));
  }

  /**
   * Brute-force cosine top-K with the exact persisted source receipt selected
   * alongside every preview. Callers must validate the receipt after their
   * final awaited live-source check before exposing persisted bytes.
   *
   * @param queryVec L2-normalized query vector with the database dimension.
   * @param k Maximum number of ranked hits to return.
   * @param opts Optional folder prefix and minimum cosine score.
   * @returns Current, non-quarantined receipt-bearing hits in cosine order.
   * @example
   * ```ts
   * const hits = db.searchWithReceipts(queryVector, 10);
   * const current = db.currentSourceReceiptMask(hits);
   * ```
   */
  searchWithReceipts(
    queryVec: Float32Array,
    k: number,
    opts: { folder?: string; minScore?: number } = {}
  ): EmbedReceiptSearchHit[] {
    return this.searchReceiptRows(queryVec, k, opts);
  }

  private searchReceiptRows(
    queryVec: Float32Array,
    k: number,
    opts: { folder?: string; minScore?: number }
  ): EmbedReceiptSearchHit[] {
    const db = this.requireDb();
    if (queryVec.length !== this.dim) {
      throw new Error(`query vector dim mismatch: got ${queryVec.length}, expected ${this.dim}`);
    }
    const queryNormSquared = vectorNormSquared(queryVec);
    if (
      !Number.isFinite(queryNormSquared) ||
      queryNormSquared <= Number.EPSILON ||
      queryNormSquared < 0.998 ||
      queryNormSquared > 1.002
    ) {
      throw new Error("query vector must contain finite components and be L2-normalized");
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
            `SELECT e.rel_path, e.chunk_index, e.line_start, e.line_end, e.text_preview, e.vector, e.kind,
                    s.mtime_ms AS indexed_mtime_ms, r.revision AS indexed_revision
             FROM embeddings e
             JOIN source_state s ON s.rel_path = e.rel_path AND s.kind = e.kind
             JOIN source_revision r ON r.rel_path = e.rel_path AND r.kind = e.kind
             LEFT JOIN source_quarantine q ON q.rel_path = e.rel_path AND q.kind = e.kind
             WHERE q.rel_path IS NULL AND e.kind IN ('md', 'pdf')
               AND typeof(r.revision) = 'integer'
               AND r.revision BETWEEN 1 AND 9007199254740991
               AND substr(e.rel_path, 1, length(?)) = ?`
          : `SELECT e.rel_path, e.chunk_index, e.line_start, e.line_end, e.text_preview, e.vector, e.kind,
                    s.mtime_ms AS indexed_mtime_ms, r.revision AS indexed_revision
             FROM embeddings e
             JOIN source_state s ON s.rel_path = e.rel_path AND s.kind = e.kind
             JOIN source_revision r ON r.rel_path = e.rel_path AND r.kind = e.kind
             LEFT JOIN source_quarantine q ON q.rel_path = e.rel_path AND q.kind = e.kind
             WHERE q.rel_path IS NULL AND e.kind IN ('md', 'pdf')
               AND typeof(r.revision) = 'integer'
               AND r.revision BETWEEN 1 AND 9007199254740991`
      )
      .all<{
        rel_path: string;
        chunk_index: number;
        line_start: number;
        line_end: number;
        text_preview: string;
        vector: Buffer;
        kind: string | null;
        indexed_mtime_ms: number;
        indexed_revision: number;
      }>(...(folderPrefix ? [folderPrefix, folderPrefix] : [])); // rc.43 M1 — bind prefix twice (length(?) + substr=?)

    const expectedBytes = this.encodedBytes;
    const heap: EmbedReceiptSearchHit[] = [];
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
        kind: (r.kind === "pdf" ? "pdf" : "md") as EmbedChunkKind,
        indexed_mtime_ms: r.indexed_mtime_ms,
        indexed_revision: r.indexed_revision
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
   * v2.16.0 — compute a tractable signature of the current, non-quarantined
   * embedding index for HNSW staleness detection. The stable prefix binds
   * dimension, receipt-backed row count, maximum id, model, quantization, and
   * embedding-schema version. A deterministic quarantine digest is appended
   * only while markers exist, preserving the legacy empty-quarantine string.
   *
   * Why this composite (vs full content hash)?
   *   • Full hash would require reading every BLOB on every serve start —
   *     wastes the I/O savings the persisted HNSW is supposed to give us.
   *   • Current rowcount + max-id catches every common change pattern: insert
   *     (max-id moves up), delete (rowcount drops), update (max-id moves
   *     up because we DELETE+INSERT). Edge case: updating in-place
   *     without changing max-id (rare in our codebase — upsertNote always
   *     deletes+reinserts so max-id always advances).
   *   • dim + model alias guard against a model swap that re-embeds with
   *     a different vector space.
   *   • Embedding schema guards inference-contract migrations (for example,
   *     fp32 → q8 model weights) even when rowcount, ids and dimensions match.
   *   • The optional quarantine digest invalidates a sidecar immediately when
   *     retained rows become ineligible, without changing the HNSW file format.
   *   • Source revisions are re-hydrated from the database at public egress;
   *     their numeric value is deliberately not part of this graph signature.
   */
  computeSignature(): string {
    const db = this.requireDb();
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n, MAX(e.id) AS maxId
         FROM embeddings e
         JOIN source_state s ON s.rel_path = e.rel_path AND s.kind = e.kind
         JOIN source_revision r ON r.rel_path = e.rel_path AND r.kind = e.kind
         LEFT JOIN source_quarantine q ON q.rel_path = e.rel_path AND q.kind = e.kind
         WHERE q.rel_path IS NULL AND e.kind IN ('md', 'pdf')
           AND typeof(r.revision) = 'integer'
           AND r.revision BETWEEN 1 AND 9007199254740991`
      )
      .get<{ n: number; maxId: number | null }>();
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
    const quarantined = db
      .prepare("SELECT rel_path, kind FROM source_quarantine ORDER BY kind, rel_path")
      .all<{ rel_path: string; kind: string }>();
    const baseSignature =
      `dim=${this.dim};rows=${rows};maxId=${maxId};model=${this.modelAlias};quant=${this.quantization};` +
      `embedSchema=${EMBED_DB_SCHEMA_VERSION}`;
    if (quarantined.length === 0) return baseSignature;
    const quarantineHash = createHash("sha256");
    for (const source of quarantined) {
      updateManifestValue(quarantineHash, source.kind);
      updateManifestValue(quarantineHash, source.rel_path);
    }
    return `${baseSignature};quarantine=${quarantineHash.digest("hex")}`;
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
   * insignificant compared to the ONNX runtime + FTS5 working set). Rows are
   * source-state-bound and non-quarantined, but this legacy bootstrap shape
   * carries no receipt; public HNSW egress must hydrate labels through
   * {@link getSearchRowsByIds}.
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
      .prepare(
        `SELECT e.id, e.rel_path, e.chunk_index, e.line_start, e.line_end, e.text_preview, e.vector, e.kind
         FROM embeddings e
         JOIN source_state s ON s.rel_path = e.rel_path AND s.kind = e.kind
         JOIN source_revision r ON r.rel_path = e.rel_path AND r.kind = e.kind
         LEFT JOIN source_quarantine q ON q.rel_path = e.rel_path AND q.kind = e.kind
         WHERE q.rel_path IS NULL AND e.kind IN ('md', 'pdf')
           AND typeof(r.revision) = 'integer'
           AND r.revision BETWEEN 1 AND 9007199254740991`
      )
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
 * and the metadata writes `<base>.meta.json` (see `src/hnsw.ts`).
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
 * Non-mutating authority check over an existing embedding database.
 * Implementations are safe to keep open across awaited vault reads: each
 * validation call starts a fresh read transaction, while every receipt in one
 * batch shares that transaction's SQLite snapshot.
 *
 * @example
 * ```ts
 * const reader = await openEmbedReceiptReader(file, vault.root);
 * try {
 *   reader.currentSourceReceiptMask(receipts);
 * } finally {
 *   reader.close();
 * }
 * ```
 */
export interface EmbedReceiptReader {
  /**
   * Confirm an exact, non-quarantined source receipt.
   *
   * @param relPath Vault-relative source path.
   * @param kind Content-source kind.
   * @param indexedMtimeMs Source mtime selected with the persisted bytes.
   * @param indexedRevision Source authority revision selected with the bytes.
   * @returns True only while that exact receipt remains current; false after close.
   * @example
   * ```ts
   * const current = reader.isCurrentSourceReceipt(path, kind, mtimeMs, revision);
   * ```
   */
  isCurrentSourceReceipt(
    relPath: string,
    kind: EmbedChunkKind,
    indexedMtimeMs: number,
    indexedRevision: number
  ): boolean;
  /**
   * Validate a batch in one synchronous SQLite read snapshot.
   *
   * @param receipts Persisted authority tuples to validate.
   * @returns A current/stale mask captured atomically, or all false after close.
   * @throws {RangeError} If more than 512 receipts are supplied while open.
   * @example
   * ```ts
   * const current = reader.currentSourceReceiptMask(receipts);
   * ```
   */
  currentSourceReceiptMask(receipts: readonly EmbedSourceReceipt[]): boolean[];
  /**
   * Close the read-only SQLite handle. Idempotent.
   *
   * @returns Nothing.
   * @example
   * ```ts
   * reader.close();
   * ```
   */
  close(): void;
}

/**
 * Open an existing embedding database strictly read-only for final receipt
 * validation. This function never bootstraps, rebuilds, migrates, or writes:
 * missing files and legacy/incompatible authority schemas are rejected.
 *
 * @param file Absolute path to an existing `.embed.db` file.
 * @param expectedVaultRoot Exact vault root the database must declare.
 * @returns A synchronous receipt validator backed by a read-only SQLite handle.
 * @throws {Error} If the file is absent, belongs to another vault, or lacks the current revision ledger contract.
 * @example
 * ```ts
 * const reader = await openEmbedReceiptReader(file, vault.root);
 * try {
 *   if (!reader.isCurrentSourceReceipt(path, kind, mtimeMs, revision)) return [];
 * } finally {
 *   reader.close();
 * }
 * ```
 */
export async function openEmbedReceiptReader(file: string, expectedVaultRoot: string): Promise<EmbedReceiptReader> {
  const Ctor = await loadBetterSqlite();
  let db: Db | null = null;
  try {
    db = new Ctor(file, { readonly: true, fileMustExist: true }) as Db;
    const metaRows = db
      .prepare("SELECT key, value FROM meta WHERE key IN ('schema_version', 'vault_root')")
      .all<{ key: string; value: string }>();
    const meta = new Map(metaRows.map((row) => [row.key, row.value]));
    if (
      meta.get("vault_root") !== expectedVaultRoot ||
      meta.get("schema_version") !== String(EMBED_DB_SCHEMA_VERSION)
    ) {
      throw new Error("incompatible embedding metadata");
    }

    const columns = db.prepare("PRAGMA table_info(source_revision)").all<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>();
    const exactColumns = [
      { name: "rel_path", type: "TEXT", notnull: 1, pk: 1 },
      { name: "kind", type: "TEXT", notnull: 1, pk: 2 },
      { name: "revision", type: "INTEGER", notnull: 1, pk: 0 }
    ];
    if (
      columns.length !== exactColumns.length ||
      columns.some((column, index) => {
        const expected = exactColumns[index];
        return (
          expected === undefined ||
          column.name !== expected.name ||
          column.type.toUpperCase() !== expected.type ||
          column.notnull !== expected.notnull ||
          column.pk !== expected.pk
        );
      })
    ) {
      throw new Error("incompatible embedding revision schema");
    }

    const triggerPlaceholders = SOURCE_REVISION_TRIGGER_NAMES.map(() => "?").join(", ");
    const triggerRows = db
      .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name IN (${triggerPlaceholders})`)
      .all<{ name: string; sql: string | null }>(...SOURCE_REVISION_TRIGGER_NAMES);
    const triggerSql = new Map(triggerRows.map((row) => [row.name, row.sql]));
    if (
      SOURCE_REVISION_TRIGGER_DEFINITIONS.some(({ name, sql }) => {
        const storedSql = triggerSql.get(name);
        return storedSql === null || normalizeSql(storedSql ?? "") !== normalizeSql(sql);
      })
    ) {
      throw new Error("incompatible embedding revision triggers");
    }

    // Compilation validates the dependent authority-table shape without
    // starting a transaction or writing to the target database.
    db.prepare(CURRENT_SOURCE_RECEIPT_SQL);
    let activeDb: Db | null = db;
    db = null;
    return {
      isCurrentSourceReceipt(relPath, kind, indexedMtimeMs, indexedRevision) {
        return activeDb ? currentSourceReceipt(activeDb, relPath, kind, indexedMtimeMs, indexedRevision) : false;
      },
      currentSourceReceiptMask(receipts) {
        return activeDb ? currentSourceReceiptMaskFromDb(activeDb, receipts) : receipts.map(() => false);
      },
      close() {
        const closingDb = activeDb;
        activeDb = null;
        closingDb?.close();
      }
    };
  } catch {
    try {
      db?.close();
    } catch {
      // Preserve the stable, path-free compatibility error below.
    }
    throw new Error("Embedding receipt reader requires an existing compatible index for the expected vault");
  }
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
