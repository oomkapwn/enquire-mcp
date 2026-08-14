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
//   - best-effort 0600 chmod on db + WAL/SHM sidecars
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
 * Exact metadata exposed after full readonly embedding-store admission.
 * Historical schema versions 1 and 2 did not persist `quantization`; those
 * stores are necessarily `f32` and production callers normalize that absence
 * through `resolveStoredEmbeddingConfiguration()` in `src/embeddings.ts`.
 *
 * @example
 * ```ts
 * const meta: EmbedDbOwnedMeta = {
 *   schema_version: "4",
 *   vault_root: "/vault",
 *   model_alias: "multilingual",
 *   dim: "384",
 *   quantization: "f32"
 * };
 * ```
 */
export interface EmbedDbOwnedMeta {
  /** Supported historical on-disk schema version. */
  readonly schema_version: string;
  /** Exact stored vault root proven equal to the expected canonical root. */
  readonly vault_root: string;
  /** Stored embedding-model alias. Production callers validate it against their catalog. */
  readonly model_alias: string;
  /** Stored positive vector dimension, serialized canonically as a decimal string. */
  readonly dim: string;
  /** Stored vector encoding; absent only for historical schema versions 1 and 2. */
  readonly quantization?: EmbedQuantization;
}

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
  transaction<F extends (...args: never[]) => unknown>(fn: F): F & { immediate: F };
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
  let normalized = "";
  let inLiteral = false;
  let omitsFollowingSpace = false;
  let pendingSpace = false;
  for (let index = 0; index < sql.length; index++) {
    const char = sql[index];
    if (char === undefined) break;
    if (inLiteral) {
      normalized += char;
      if (char === "'") {
        if (sql[index + 1] === "'") {
          normalized += "'";
          index += 1;
        } else {
          inLiteral = false;
        }
      }
      continue;
    }
    if (/\s/u.test(char)) {
      pendingSpace = normalized.length > 0;
      continue;
    }
    // Parenthesis/comma spacing is not part of SQLite DDL identity. Keep the
    // comparison strict on every token and literal byte while admitting the
    // compact formatting SQLite preserves from historical CREATE statements.
    const punctuation = char === "(" || char === ")" || char === ",";
    if (pendingSpace && !punctuation && !omitsFollowingSpace) normalized += " ";
    pendingSpace = false;
    if (char === "'") {
      normalized += char;
      inLiteral = true;
      omitsFollowingSpace = false;
    } else {
      normalized += char.toLowerCase();
      omitsFollowingSpace = char === "(" || char === ",";
    }
  }
  if (normalized.endsWith(";")) normalized = normalized.slice(0, -1).trimEnd();
  return normalized;
}

function normalizeCreateTableSql(sql: string): string {
  return normalizeSql(sql).replace(/^create table if not exists /, "create table ");
}

function normalizeCreateIndexSql(sql: string): string {
  return normalizeSql(sql).replace(/^create index if not exists /, "create index ");
}

const META_TABLE_SQL = `CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
)`;
const EMBEDDINGS_V1_TABLE_SQL = `CREATE TABLE IF NOT EXISTS embeddings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rel_path TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  line_start INTEGER NOT NULL,
  line_end INTEGER NOT NULL,
  text_preview TEXT NOT NULL,
  vector BLOB NOT NULL,
  UNIQUE(rel_path, chunk_index)
)`;
const EMBEDDINGS_V2_TABLE_SQL = `CREATE TABLE IF NOT EXISTS embeddings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rel_path TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  line_start INTEGER NOT NULL,
  line_end INTEGER NOT NULL,
  text_preview TEXT NOT NULL,
  vector BLOB NOT NULL,
  kind TEXT NOT NULL DEFAULT 'md',
  UNIQUE(rel_path, chunk_index)
)`;
const EMBEDDINGS_REL_PATH_INDEX_SQL = "CREATE INDEX IF NOT EXISTS embeddings_rel_path ON embeddings(rel_path)";
const SOURCE_STATE_V1_TABLE_SQL = `CREATE TABLE IF NOT EXISTS source_state (
  rel_path TEXT PRIMARY KEY,
  mtime_ms INTEGER NOT NULL,
  n_chunks INTEGER NOT NULL,
  indexed_at TEXT NOT NULL
)`;
const SOURCE_STATE_V2_TABLE_SQL = `CREATE TABLE IF NOT EXISTS source_state (
  rel_path TEXT PRIMARY KEY,
  mtime_ms INTEGER NOT NULL,
  n_chunks INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'md',
  indexed_at TEXT NOT NULL
)`;
const SOURCE_QUARANTINE_TABLE_SQL = `CREATE TABLE IF NOT EXISTS source_quarantine (
  rel_path TEXT NOT NULL,
  kind TEXT NOT NULL,
  PRIMARY KEY (rel_path, kind)
) WITHOUT ROWID`;
const SOURCE_REVISION_TABLE_SQL = `CREATE TABLE IF NOT EXISTS source_revision (
  rel_path TEXT NOT NULL,
  kind TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (
    typeof(revision) = 'integer'
      AND revision BETWEEN 1 AND 9007199254740991
  ),
  PRIMARY KEY (rel_path, kind)
) WITHOUT ROWID`;

const MAX_EMBED_ADMISSION_OBJECTS = 32;
const MAX_EMBED_ADMISSION_INDEXES = 8;
const MAX_EMBED_ADMISSION_NAME_CHARS = 128;
const MAX_EMBED_ADMISSION_SQL_CHARS = 32_768;
const MAX_EMBED_META_VALUE_CHARS = 8_192;
const EMBED_ADMISSION_OBJECT_TYPES = new Map<string, string>([
  ["meta", "table"],
  ["embeddings", "table"],
  ["source_state", "table"],
  ["source_quarantine", "table"],
  ["source_revision", "table"],
  ["embeddings_rel_path", "index"],
  ...SOURCE_REVISION_TRIGGER_NAMES.map((name) => [name, "trigger"] as const)
]);
const EMBED_META_KEYS = new Set(["schema_version", "vault_root", "model_alias", "dim", "quantization"]);

type EmbedAdmission =
  | { kind: "empty"; signature: "empty" }
  | { kind: "owned"; meta: EmbedDbOwnedMeta; signature: string }
  | { kind: "refused"; reason: "foreign" | "future" | "malformed" };

interface EmbedAdmissionColumn {
  name: string;
  type: string;
  notnull: number;
  pk: number;
}

// Persisted class signatures: v1 is the original markdown-only schema; v2
// adds `kind`; v3 keeps v2 columns and adds exact quantization metadata; v4
// keeps the core shape and adds the repairable quarantine/revision ledger.
const EMBED_V1_COLUMNS: readonly EmbedAdmissionColumn[] = [
  { name: "id", type: "INTEGER", notnull: 0, pk: 1 },
  { name: "rel_path", type: "TEXT", notnull: 1, pk: 0 },
  { name: "chunk_index", type: "INTEGER", notnull: 1, pk: 0 },
  { name: "line_start", type: "INTEGER", notnull: 1, pk: 0 },
  { name: "line_end", type: "INTEGER", notnull: 1, pk: 0 },
  { name: "text_preview", type: "TEXT", notnull: 1, pk: 0 },
  { name: "vector", type: "BLOB", notnull: 1, pk: 0 }
];
const EMBED_V2_COLUMNS: readonly EmbedAdmissionColumn[] = [
  ...EMBED_V1_COLUMNS,
  { name: "kind", type: "TEXT", notnull: 1, pk: 0 }
];
const SOURCE_STATE_V1_COLUMNS: readonly EmbedAdmissionColumn[] = [
  { name: "rel_path", type: "TEXT", notnull: 0, pk: 1 },
  { name: "mtime_ms", type: "INTEGER", notnull: 1, pk: 0 },
  { name: "n_chunks", type: "INTEGER", notnull: 1, pk: 0 },
  { name: "indexed_at", type: "TEXT", notnull: 1, pk: 0 }
];
const SOURCE_STATE_V2_COLUMNS: readonly EmbedAdmissionColumn[] = [
  { name: "rel_path", type: "TEXT", notnull: 0, pk: 1 },
  { name: "mtime_ms", type: "INTEGER", notnull: 1, pk: 0 },
  { name: "n_chunks", type: "INTEGER", notnull: 1, pk: 0 },
  { name: "kind", type: "TEXT", notnull: 1, pk: 0 },
  { name: "indexed_at", type: "TEXT", notnull: 1, pk: 0 }
];
const SOURCE_QUARANTINE_COLUMNS: readonly EmbedAdmissionColumn[] = [
  { name: "rel_path", type: "TEXT", notnull: 1, pk: 1 },
  { name: "kind", type: "TEXT", notnull: 1, pk: 2 }
];
const SOURCE_REVISION_COLUMNS: readonly EmbedAdmissionColumn[] = [
  { name: "rel_path", type: "TEXT", notnull: 1, pk: 1 },
  { name: "kind", type: "TEXT", notnull: 1, pk: 2 },
  { name: "revision", type: "INTEGER", notnull: 1, pk: 0 }
];

function hasExactAdmissionColumns(
  db: Db,
  table: "embeddings" | "source_state" | "source_quarantine" | "source_revision",
  expected: readonly EmbedAdmissionColumn[]
): boolean {
  const columns = db
    .prepare('SELECT cid, name, type, "notnull", dflt_value, pk FROM pragma_table_info(?) ORDER BY cid LIMIT ?')
    .all<EmbedAdmissionColumn & { cid: number; dflt_value: string | null }>(table, expected.length + 1);
  return (
    columns.length === expected.length &&
    columns.every((column, index) => {
      const wanted = expected[index];
      return (
        wanted !== undefined &&
        column.cid === index &&
        column.name === wanted.name &&
        column.type.toUpperCase() === wanted.type &&
        column.notnull === wanted.notnull &&
        column.dflt_value ===
          ((table === "embeddings" || table === "source_state") && wanted.name === "kind" ? "'md'" : null) &&
        column.pk === wanted.pk
      );
    })
  );
}

function inspectEmbedAdmission(db: Db, expectedVaultRoot: string): EmbedAdmission {
  try {
    const objects = db
      .prepare(
        `SELECT type,
                substr(name, 1, ?) AS name,
                substr(sql, 1, ?) AS sql
         FROM sqlite_master
         WHERE name NOT GLOB 'sqlite_*'
         LIMIT ?`
      )
      .all<{
        type: string;
        name: string;
        sql: string | null;
      }>(MAX_EMBED_ADMISSION_NAME_CHARS + 1, MAX_EMBED_ADMISSION_SQL_CHARS + 1, MAX_EMBED_ADMISSION_OBJECTS + 1);
    if (objects.length === 0) return { kind: "empty", signature: "empty" };
    if (objects.length > MAX_EMBED_ADMISSION_OBJECTS) return { kind: "refused", reason: "malformed" };
    objects.sort((left, right) => left.type.localeCompare(right.type) || left.name.localeCompare(right.name));

    const objectTypes = new Map(objects.map((object) => [object.name, object.type]));
    const objectSql = new Map(objects.map((object) => [object.name, object.sql]));
    for (const object of objects) {
      if (
        object.name.length > MAX_EMBED_ADMISSION_NAME_CHARS ||
        object.sql === null ||
        object.sql.length > MAX_EMBED_ADMISSION_SQL_CHARS ||
        EMBED_ADMISSION_OBJECT_TYPES.get(object.name) !== object.type
      ) {
        return { kind: "refused", reason: "malformed" };
      }
    }
    if (
      objectTypes.get("meta") !== "table" ||
      objectTypes.get("embeddings") !== "table" ||
      objectTypes.get("source_state") !== "table"
    ) {
      return { kind: "refused", reason: "malformed" };
    }

    const metaColumns = db
      .prepare(
        "SELECT cid, name, type, \"notnull\", dflt_value, pk FROM pragma_table_info('meta') ORDER BY cid LIMIT 3"
      )
      .all<{
        cid: number;
        dflt_value: string | null;
        name: string;
        type: string;
        notnull: number;
        pk: number;
      }>();
    if (
      metaColumns.length !== 2 ||
      metaColumns[0]?.cid !== 0 ||
      metaColumns[0]?.name !== "key" ||
      metaColumns[0]?.type.toUpperCase() !== "TEXT" ||
      metaColumns[0]?.notnull !== 0 ||
      metaColumns[0]?.dflt_value !== null ||
      metaColumns[0]?.pk !== 1 ||
      metaColumns[1]?.cid !== 1 ||
      metaColumns[1]?.name !== "value" ||
      metaColumns[1]?.type.toUpperCase() !== "TEXT" ||
      metaColumns[1]?.notnull !== 1 ||
      metaColumns[1]?.dflt_value !== null ||
      metaColumns[1]?.pk !== 0
    ) {
      return { kind: "refused", reason: "malformed" };
    }

    const rows = db
      .prepare(
        `SELECT substr(key, 1, ?) AS key,
                substr(value, 1, ?) AS value
         FROM meta
         LIMIT ?`
      )
      .all<{ key: unknown; value: unknown }>(
        MAX_EMBED_ADMISSION_NAME_CHARS + 1,
        MAX_EMBED_META_VALUE_CHARS + 1,
        EMBED_META_KEYS.size + 1
      );
    if (rows.length < 4 || rows.length > EMBED_META_KEYS.size) {
      return { kind: "refused", reason: "malformed" };
    }
    const meta: Record<string, string> = {};
    for (const row of rows) {
      if (
        typeof row.key !== "string" ||
        row.key.length > MAX_EMBED_ADMISSION_NAME_CHARS ||
        typeof row.value !== "string" ||
        row.value.length > MAX_EMBED_META_VALUE_CHARS ||
        !EMBED_META_KEYS.has(row.key) ||
        Object.hasOwn(meta, row.key)
      ) {
        return { kind: "refused", reason: "malformed" };
      }
      meta[row.key] = row.value;
    }
    rows.sort((left, right) => String(left.key).localeCompare(String(right.key)));

    const storedSchemaVersion = meta.schema_version;
    const storedRoot = meta.vault_root;
    const storedModelAlias = meta.model_alias;
    const storedDim = meta.dim;
    const storedQuantization = meta.quantization;
    const schemaVersion = Number(storedSchemaVersion);
    const dim = Number(storedDim);
    if (
      typeof storedSchemaVersion !== "string" ||
      !Number.isSafeInteger(schemaVersion) ||
      schemaVersion < 1 ||
      String(schemaVersion) !== storedSchemaVersion ||
      typeof storedDim !== "string" ||
      !Number.isSafeInteger(dim) ||
      dim < 1 ||
      String(dim) !== storedDim ||
      typeof storedRoot !== "string" ||
      storedRoot.length === 0 ||
      typeof storedModelAlias !== "string" ||
      storedModelAlias.length === 0 ||
      (storedQuantization !== undefined && storedQuantization !== "f32" && storedQuantization !== "int8") ||
      (schemaVersion >= 3 && storedQuantization === undefined) ||
      (schemaVersion < 3 && storedQuantization !== undefined)
    ) {
      return { kind: "refused", reason: "malformed" };
    }
    const expectedEmbedColumns = schemaVersion === 1 ? EMBED_V1_COLUMNS : EMBED_V2_COLUMNS;
    const expectedSourceColumns = schemaVersion === 1 ? SOURCE_STATE_V1_COLUMNS : SOURCE_STATE_V2_COLUMNS;
    const expectedEmbedSql = schemaVersion === 1 ? EMBEDDINGS_V1_TABLE_SQL : EMBEDDINGS_V2_TABLE_SQL;
    const expectedSourceSql = schemaVersion === 1 ? SOURCE_STATE_V1_TABLE_SQL : SOURCE_STATE_V2_TABLE_SQL;
    if (
      objectTypes.get("embeddings_rel_path") !== "index" ||
      normalizeCreateTableSql(objectSql.get("meta") ?? "") !== normalizeCreateTableSql(META_TABLE_SQL) ||
      normalizeCreateTableSql(objectSql.get("embeddings") ?? "") !== normalizeCreateTableSql(expectedEmbedSql) ||
      normalizeCreateTableSql(objectSql.get("source_state") ?? "") !== normalizeCreateTableSql(expectedSourceSql) ||
      normalizeCreateIndexSql(objectSql.get("embeddings_rel_path") ?? "") !==
        normalizeCreateIndexSql(EMBEDDINGS_REL_PATH_INDEX_SQL) ||
      !hasExactAdmissionColumns(db, "embeddings", expectedEmbedColumns) ||
      !hasExactAdmissionColumns(db, "source_state", expectedSourceColumns)
    ) {
      return { kind: "refused", reason: "malformed" };
    }
    if (
      (objectTypes.has("source_quarantine") &&
        (!hasExactAdmissionColumns(db, "source_quarantine", SOURCE_QUARANTINE_COLUMNS) ||
          normalizeCreateTableSql(objectSql.get("source_quarantine") ?? "") !==
            normalizeCreateTableSql(SOURCE_QUARANTINE_TABLE_SQL))) ||
      (objectTypes.has("source_revision") &&
        (!hasExactAdmissionColumns(db, "source_revision", SOURCE_REVISION_COLUMNS) ||
          normalizeCreateTableSql(objectSql.get("source_revision") ?? "") !==
            normalizeCreateTableSql(SOURCE_REVISION_TABLE_SQL)))
    ) {
      return { kind: "refused", reason: "malformed" };
    }
    const relPathIndex = db
      .prepare("SELECT seqno, name FROM pragma_index_info(?) ORDER BY seqno LIMIT 2")
      .all<{ seqno: number; name: string }>("embeddings_rel_path");
    const embeddingIndexes = db
      .prepare(
        `SELECT name, "unique" AS is_unique, origin, partial
         FROM pragma_index_list('embeddings')
         LIMIT ?`
      )
      .all<{ name: string; is_unique: number; origin: string; partial: number }>(MAX_EMBED_ADMISSION_INDEXES + 1);
    embeddingIndexes.sort((left, right) => left.name.localeCompare(right.name));
    if (embeddingIndexes.length !== 2) {
      return { kind: "refused", reason: "malformed" };
    }
    const relPathIndexDefinition = embeddingIndexes.find((index) => index.name === "embeddings_rel_path");
    const uniquePathChunkIndex = embeddingIndexes.some((index) => {
      if (index.is_unique !== 1 || index.origin !== "u" || index.partial !== 0) return false;
      const columns = db
        .prepare("SELECT seqno, name FROM pragma_index_info(?) ORDER BY seqno LIMIT 3")
        .all<{ seqno: number; name: string }>(index.name);
      return (
        columns.length === 2 &&
        columns[0]?.seqno === 0 &&
        columns[0]?.name === "rel_path" &&
        columns[1]?.seqno === 1 &&
        columns[1]?.name === "chunk_index"
      );
    });
    if (
      relPathIndexDefinition === undefined ||
      relPathIndexDefinition.is_unique !== 0 ||
      relPathIndexDefinition.origin !== "c" ||
      relPathIndexDefinition.partial !== 0 ||
      relPathIndex.length !== 1 ||
      relPathIndex[0]?.seqno !== 0 ||
      relPathIndex[0]?.name !== "rel_path" ||
      !uniquePathChunkIndex
    ) {
      return { kind: "refused", reason: "malformed" };
    }
    if (schemaVersion > EMBED_DB_SCHEMA_VERSION) return { kind: "refused", reason: "future" };
    if (storedRoot !== expectedVaultRoot) return { kind: "refused", reason: "foreign" };
    const ownedMeta: EmbedDbOwnedMeta = {
      schema_version: storedSchemaVersion,
      vault_root: storedRoot,
      model_alias: storedModelAlias,
      dim: storedDim,
      ...(storedQuantization === undefined ? {} : { quantization: storedQuantization })
    };
    return {
      kind: "owned",
      meta: ownedMeta,
      signature: JSON.stringify([objects, metaColumns, rows, embeddingIndexes])
    };
  } catch {
    return { kind: "refused", reason: "malformed" };
  }
}

function assertEmbedAdmission(
  admission: EmbedAdmission
): asserts admission is Exclude<EmbedAdmission, { kind: "refused" }> {
  if (admission.kind !== "refused") return;
  if (admission.reason === "future") {
    throw new Error("Embedding index uses a newer unsupported schema");
  }
  throw new Error("Embedding index ownership could not be verified");
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
 * `open()` admits only a truly schema-empty file or a structurally recognized
 * embedding index for the exact vault root. A recognized same-root index is
 * rebuilt for supported legacy-schema or model/dim/quantization mismatches;
 * foreign, malformed, and future-schema databases are refused without
 * Enquire-issued persistent PRAGMA, DDL, DML, chmod, or HNSW actions.
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

  /**
   * Create a lazy embedding-index handle after validating all runtime options.
   *
   * @param opts - Database path plus exact vault/model/vector authority tuple.
   * @throws {TypeError} If a string or quantization option is invalid.
   * @throws {RangeError} If `dim` is not a positive safe integer.
   */
  constructor(opts: EmbedDbOptions) {
    if (typeof opts.file !== "string" || opts.file.length === 0) {
      throw new TypeError("Embedding index file must be a non-empty string");
    }
    if (typeof opts.vaultRoot !== "string" || opts.vaultRoot.length === 0) {
      throw new TypeError("Embedding index vault root must be a non-empty string");
    }
    if (typeof opts.modelAlias !== "string" || opts.modelAlias.length === 0) {
      throw new TypeError("Embedding model alias must be a non-empty string");
    }
    if (!Number.isSafeInteger(opts.dim) || opts.dim < 1) {
      throw new RangeError("Embedding vector dimension must be a positive safe integer");
    }
    const quantization = opts.quantization ?? "f32";
    if (quantization !== "f32" && quantization !== "int8") {
      throw new TypeError("Embedding quantization must be 'f32' or 'int8'");
    }
    this.file = opts.file;
    this.vaultRoot = opts.vaultRoot;
    this.modelAlias = opts.modelAlias;
    this.dim = opts.dim;
    this.quantization = quantization;
    this.encodedBytes = this.quantization === "int8" ? this.dim + 8 : this.dim * 4;
  }

  /**
   * Open the SQLite database, verify ownership on the live handle, bootstrap
   * only an admitted schema, then enable WAL and best-effort tighten file permissions.
   * Refusal preserves logical schema and cell/BLOB values. SQLite itself may
   * still take locks, recover/checkpoint an existing journal, or touch physical
   * container/sidecar bytes while opening and closing; this API does not claim
   * byte-identical DB/WAL/SHM or directory state. Idempotent after success.
   *
   * @param expectedDiscovery - Optional readonly preflight result to bind this
   *   mutating open to. No argument preserves the low-level intentional-rebuild
   *   contract; a supplied stale result is refused before bootstrap.
   * @throws {Error} If `better-sqlite3` (an optional dependency) fails to
   *   load, its native binding is unavailable, or a populated database cannot
   *   prove same-vault EmbedDb ownership under a supported non-future schema.
   */
  async open(expectedDiscovery?: EmbedDbConfigDiscovery): Promise<void> {
    if (this.db) return;
    // Snapshot before the first await so retained/mutable caller objects cannot
    // change authority while lstat/native loading is in flight.
    const expected = cloneEmbedDbOpenDiscovery(expectedDiscovery);
    let fileExisted = true;
    try {
      const artifact = await fs.lstat(this.file);
      if (!artifact.isFile()) throw new Error("not a regular file");
    } catch (err) {
      if (errnoCode(err) === "ENOENT") fileExisted = false;
      else throw new Error("Embedding index could not be inspected");
    }
    const Ctor = await loadBetterSqlite();
    if (!fileExisted) {
      // Directory preparation is needed only for a new, schema-empty index.
      // Existing paths reach same-handle admission without any chmod/mkdir.
      const parentDir = path.dirname(this.file);
      const parentExisted = await fs
        .stat(parentDir)
        .then(() => true)
        .catch(() => false);
      await fs.mkdir(parentDir, { recursive: true, mode: 0o700 });
      if (!parentExisted) {
        await fs.chmod(parentDir, 0o700).catch(() => {});
      }
    }
    try {
      this.db = new Ctor(this.file) as Db;
    } catch {
      throw new Error("Embedding index could not be opened");
    }
    try {
      const admission = inspectEmbedAdmission(this.db, this.vaultRoot);
      assertEmbedAdmission(admission);
      assertExpectedEmbedDiscovery(expected, fileExisted, admission);
      this.bootstrapSchema(admission.kind, admission.signature);
      // Persistent connection policy is deliberately after the bootstrap
      // commit. No refused file receives an Enquire-issued journal/sync mode.
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = NORMAL");
    } catch (e) {
      // Detach before native close: a close-time exception must neither
      // replace the original path-free refusal nor leave a stale non-null
      // handle that turns the next open() into an idempotent no-op.
      const failedDb = this.db;
      this.db = null;
      try {
        failedDb?.close();
      } catch {
        // Preserve the original admission/bootstrap/pragma error.
      }
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

  private bootstrapSchema(initialKind: "empty" | "owned", initialSignature: string): void {
    const db = this.requireDb();
    const txn = db.transaction(() => {
      // First callback action: close the gap between the initial inspection
      // and the write transaction on this same live handle. A fresh-to-owned
      // or owned-to-empty transition is refused rather than adopted.
      const admission = inspectEmbedAdmission(db, this.vaultRoot);
      assertEmbedAdmission(admission);
      if (admission.kind !== initialKind || admission.signature !== initialSignature) {
        throw new Error("Embedding index ownership changed during admission");
      }
      // Canonicalize every whitelisted trigger before any backfill can fire.
      // A same-name hostile trigger may target source_revision itself, so
      // dropping only after INSERT ... SELECT would be too late.
      for (const name of SOURCE_REVISION_TRIGGER_NAMES) {
        db.exec(`DROP TRIGGER IF EXISTS ${name}`);
      }
      const meta = admission.kind === "owned" ? admission.meta : undefined;
      const uninitialized = admission.kind === "empty";
      const versionMatch = uninitialized || meta?.schema_version === String(EMBED_DB_SCHEMA_VERSION);
      const modelMatch = uninitialized || meta?.model_alias === this.modelAlias;
      const dimMatch = uninitialized || meta?.dim === String(this.dim);
      // Pre-v3 indexes have no quantization key and are necessarily f32.
      const existingQuant = meta?.quantization ?? "f32";
      const quantMatch = uninitialized || existingQuant === this.quantization;

      if (!versionMatch || !modelMatch || !dimMatch || !quantMatch) {
        const reason: string[] = [];
        if (!versionMatch) reason.push("supported schema upgrade");
        if (!modelMatch) reason.push("model configuration changed");
        if (!dimMatch) reason.push("vector dimension changed");
        if (!quantMatch) reason.push("quantization changed");
        process.stderr.write(`enquire: rebuilding embed index (${reason.join("; ")})\n`);
        db.exec(`
          DROP TABLE IF EXISTS embeddings;
          DROP TABLE IF EXISTS source_state;
          DROP TABLE IF EXISTS source_quarantine;
          DROP TABLE IF EXISTS source_revision;
        `);
      }

      db.exec(`
        ${META_TABLE_SQL};
        ${EMBEDDINGS_V2_TABLE_SQL};
        ${EMBEDDINGS_REL_PATH_INDEX_SQL};
        ${SOURCE_STATE_V2_TABLE_SQL};
        ${SOURCE_QUARANTINE_TABLE_SQL};
        ${SOURCE_REVISION_TABLE_SQL};

        INSERT OR IGNORE INTO source_revision (rel_path, kind, revision)
        SELECT rel_path, kind, 1
        FROM source_state
        WHERE kind IN ('md', 'pdf');
        INSERT OR IGNORE INTO source_revision (rel_path, kind, revision)
        SELECT rel_path, kind, 1
        FROM source_quarantine
        WHERE kind IN ('md', 'pdf');

      `);

      // Recreate only after schema/backfill is complete. The whole install
      // remains inside the bootstrap transaction, so readers observe either
      // the previous complete contract or the new one.
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
    txn.immediate();
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

const EMBED_RECOVERY_OWNERSHIP_ERROR = "Embedding index ownership could not be verified";

/**
 * Bounded, root-scoped discovery result for production embedding configuration.
 * `empty` is reserved for a present SQLite file whose logical schema inventory
 * is exactly empty; it is never used for a malformed, foreign, future, or
 * unreadable artifact. Metadata is exposed only after full class/root admission.
 *
 * @example
 * ```ts
 * const discovery = await discoverEmbedDbConfig(embedFile, vault.root);
 * if (discovery.kind === "owned") useStoredConfig(discovery.meta);
 * if (discovery.kind === "empty" || discovery.kind === "missing") useRequestedConfig();
 * ```
 */
export type EmbedDbConfigDiscovery =
  | { readonly kind: "missing" }
  | { readonly kind: "empty" }
  | { readonly kind: "refused" }
  | { readonly kind: "owned"; readonly meta: Readonly<EmbedDbOwnedMeta> };

const EMBED_DISCOVERY_CHANGED_ERROR = "Embedding index configuration changed before open";

function cloneEmbedDbOpenDiscovery(expected: EmbedDbConfigDiscovery | undefined): EmbedDbConfigDiscovery | null {
  if (expected === undefined) return null;
  try {
    const kind = (expected as { readonly kind?: unknown }).kind;
    if (kind === "missing") return Object.freeze({ kind: "missing" });
    if (kind === "empty") return Object.freeze({ kind: "empty" });
    if (kind === "refused") return Object.freeze({ kind: "refused" });
    const candidateMeta = (expected as { readonly meta?: unknown }).meta;
    const meta =
      typeof candidateMeta === "object" && candidateMeta !== null
        ? (candidateMeta as Readonly<Record<string, unknown>>)
        : null;
    const schemaVersion = meta?.schema_version;
    const vaultRoot = meta?.vault_root;
    const modelAlias = meta?.model_alias;
    const dim = meta?.dim;
    const quantization = meta?.quantization;
    if (
      kind === "owned" &&
      typeof schemaVersion === "string" &&
      typeof vaultRoot === "string" &&
      typeof modelAlias === "string" &&
      typeof dim === "string" &&
      (quantization === undefined || quantization === "f32" || quantization === "int8")
    ) {
      return Object.freeze({
        kind: "owned",
        meta: Object.freeze({
          schema_version: schemaVersion,
          vault_root: vaultRoot,
          model_alias: modelAlias,
          dim,
          ...(quantization === undefined ? {} : { quantization })
        })
      });
    }
  } catch {
    // Getter-backed or malformed runtime input receives only the generic,
    // path-free stale-discovery refusal below.
  }
  return Object.freeze({ kind: "refused" });
}

function assertExpectedEmbedDiscovery(
  expected: EmbedDbConfigDiscovery | null,
  fileExisted: boolean,
  admission: Exclude<EmbedAdmission, { kind: "refused" }>
): void {
  if (expected === null) return;
  const matches =
    (expected.kind === "missing" && !fileExisted && admission.kind === "empty") ||
    (expected.kind === "empty" && fileExisted && admission.kind === "empty") ||
    (expected.kind === "owned" &&
      admission.kind === "owned" &&
      expected.meta.schema_version === admission.meta.schema_version &&
      expected.meta.vault_root === admission.meta.vault_root &&
      expected.meta.model_alias === admission.meta.model_alias &&
      expected.meta.dim === admission.meta.dim &&
      expected.meta.quantization === admission.meta.quantization);
  if (!matches) throw new Error(EMBED_DISCOVERY_CHANGED_ERROR);
}

/**
 * Discover whether an embedding database is missing, exactly schema-empty,
 * fully owned by the expected vault, or refused. Existing files are opened
 * through a read-only handle and inspected with the same bounded
 * class/schema/root admission used by `EmbedDb.open()`. Open, read, dependency,
 * and close failures collapse to `refused`; this function does not throw
 * expected discovery errors. SQLite/VFS lock, recovery, and WAL/SHM
 * bookkeeping remain outside this logical guarantee.
 *
 * This is a bounded pre-open configuration snapshot. Pass it to
 * {@link EmbedDb.open} to bind the mutating open to that observed state; open
 * independently repeats admission on its own live handle and again inside its
 * immediate transaction.
 *
 * @param file - Absolute path to the candidate embedding database.
 * @param expectedVaultRoot - Exact vault root allowed to own a populated file.
 * @returns A discriminated, path-free discovery result. Only `owned` carries metadata.
 * @example
 * ```ts
 * const discovery = await discoverEmbedDbConfig(embedFile, canonicalVaultRoot);
 * switch (discovery.kind) {
 *   case "owned":
 *     configureFrom(discovery.meta);
 *     break;
 *   case "missing":
 *   case "empty":
 *     configureFromRequest();
 *     break;
 *   case "refused":
 *     throw new Error("Embedding index configuration could not be verified");
 * }
 * ```
 */
export async function discoverEmbedDbConfig(file: string, expectedVaultRoot: string): Promise<EmbedDbConfigDiscovery> {
  try {
    const artifact = await fs.lstat(file);
    if (!artifact.isFile()) return { kind: "refused" };
  } catch (error) {
    return errnoCode(error) === "ENOENT" ? { kind: "missing" } : { kind: "refused" };
  }

  let Ctor: BetterSqliteConstructor;
  try {
    Ctor = await loadBetterSqlite();
  } catch {
    return { kind: "refused" };
  }

  let db: Db | null = null;
  let discovery: EmbedDbConfigDiscovery = { kind: "refused" };
  try {
    db = new Ctor(file, { readonly: true, fileMustExist: true }) as Db;
    const admission = inspectEmbedAdmission(db, expectedVaultRoot);
    if (admission.kind === "empty") {
      discovery = { kind: "empty" };
    } else if (admission.kind === "owned") {
      discovery = { kind: "owned", meta: { ...admission.meta } };
    }
  } catch {
    discovery = { kind: "refused" };
  } finally {
    try {
      db?.close();
    } catch {
      discovery = { kind: "refused" };
    }
  }
  return discovery;
}

/**
 * Validate a pre-existing embedding database before recovery guidance may
 * describe or clear its associated watcher guard. A missing database is the
 * expected stranded-guard case and succeeds. A present file must prove the
 * exact supported EmbedDb class and requested vault root on one read-only
 * handle; foreign, malformed, future, unreadable, and close-failing files are
 * refused with one stable path-free error.
 *
 * This is a read-only guidance snapshot, not bootstrap authority. A later
 * mutating operation must perform its own same-handle transactional admission.
 *
 * @param file - Absolute path to the embedding database associated with recovery.
 * @param expectedVaultRoot - Exact vault root allowed to own a present database.
 * @returns A promise that resolves for a missing or exact-owned supported database.
 * @throws {Error} If a present database cannot prove recovery ownership.
 * @example
 * ```ts
 * await assertEmbedDbRecoveryOwnership(embedFile, canonicalVaultRoot);
 * ```
 */
export async function assertEmbedDbRecoveryOwnership(file: string, expectedVaultRoot: string): Promise<void> {
  const discovery = await discoverEmbedDbConfig(file, expectedVaultRoot);
  if (discovery.kind === "missing" || discovery.kind === "owned") return;
  throw new Error(EMBED_RECOVERY_OWNERSHIP_ERROR);
}

type PeekEmbedDbMetaResult = {
  schema_version?: string;
  vault_root?: string;
  model_alias?: string;
  dim?: string;
  quantization?: string;
} | null;

/**
 * Legacy fail-soft diagnostic peek at bounded EmbedDb metadata.
 *
 * Production configuration decisions use {@link discoverEmbedDbConfig} (or
 * its cached sibling), whose discriminated result distinguishes missing and
 * exactly schema-empty files from full-class, exact-root ownership and generic
 * refusal. This compatibility helper never authorizes an open or rebuild.
 * Without an expected root it may expose only bounded known raw keys; with an
 * expected root it returns metadata only after the complete readonly
 * class/schema/root admission. Missing dependencies, unreadable/corrupt files,
 * malformed rows and query failures collapse to `null`. A close failure never
 * escapes; this legacy diagnostic may still return metadata already read.
 *
 * @param file - Absolute path to a `.embed.db` file.
 * @param expectedVaultRoot - Optional exact root plus full-class filter for
 *   configuration discovery. Omit only for bounded raw diagnostics.
 * @returns Bounded metadata when readable and root-compatible, otherwise `null`.
 * @example
 * ```ts
 * const meta = await peekEmbedDbMeta(embedFile, canonicalVaultRoot);
 * console.log(meta?.schema_version); // diagnostic only
 * ```
 */
export async function peekEmbedDbMeta(file: string, expectedVaultRoot?: string): Promise<PeekEmbedDbMetaResult> {
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
  // corrupt / unreadable / not-a-DB / directory `.embed.db` must NOT escape
  // this legacy diagnostic. Any failure maps to null.
  type PeekDb = {
    prepare(sql: string): { get(...params: unknown[]): unknown; all(...params: unknown[]): unknown };
    close(): void;
  };
  let db: PeekDb | null = null;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true }) as unknown as PeekDb;
    if (expectedVaultRoot !== undefined) {
      const admission = inspectEmbedAdmission(db as unknown as Db, expectedVaultRoot);
      return admission.kind === "owned" ? admission.meta : null;
    }
    // Confirm meta table exists before SELECT — avoid throwing on fresh dbs.
    const tableCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'").get();
    if (!tableCheck) return null;
    const rows = db
      .prepare(
        `SELECT substr(key, 1, ?) AS key,
                substr(value, 1, ?) AS value
         FROM meta
         LIMIT ?`
      )
      .all(MAX_EMBED_ADMISSION_NAME_CHARS + 1, MAX_EMBED_META_VALUE_CHARS + 1, EMBED_META_KEYS.size + 1) as {
      key: unknown;
      value: unknown;
    }[];
    if (rows.length > EMBED_META_KEYS.size) return null;
    const meta: Record<string, string> = {};
    for (const row of rows) {
      if (
        typeof row.key !== "string" ||
        row.key.length > MAX_EMBED_ADMISSION_NAME_CHARS ||
        typeof row.value !== "string" ||
        row.value.length > MAX_EMBED_META_VALUE_CHARS ||
        !EMBED_META_KEYS.has(row.key) ||
        Object.hasOwn(meta, row.key)
      ) {
        return null;
      }
      meta[row.key] = row.value;
    }
    return meta;
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // Fail-soft discovery includes close-time native/IO failures.
    }
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
 * This wrapper caches raw and exact-root/full-class results under distinct
 * composite keys. Cache entries are invalidated when the file's `mtimeMs`
 * changes — covering the `clear-embeddings` + `build-embeddings` rebuild flow
 * without requiring
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
const peekCache = new Map<string, { file: string; mtimeMs: number; meta: PeekEmbedDbMetaResult }>();
const embedConfigDiscoveryCache = new Map<
  string,
  {
    file: string;
    mtimeMs: number;
    size: number;
    walMtimeMs: number | null;
    walSize: number | null;
    discovery: EmbedDbConfigDiscovery;
  }
>();

interface EmbedConfigDiscoveryFingerprint {
  mtimeMs: number;
  size: number;
  walMtimeMs: number | null;
  walSize: number | null;
}

function peekCacheKey(file: string, expectedVaultRoot: string | undefined): string {
  return JSON.stringify([file, expectedVaultRoot ?? null]);
}

function deletePeekCacheFile(file: string): void {
  for (const [key, entry] of peekCache) {
    if (entry.file === file) peekCache.delete(key);
  }
}

function embedConfigDiscoveryCacheKey(file: string, expectedVaultRoot: string): string {
  return JSON.stringify([file, expectedVaultRoot]);
}

function deleteEmbedConfigDiscoveryCacheFile(file: string): void {
  for (const [key, entry] of embedConfigDiscoveryCache) {
    if (entry.file === file) embedConfigDiscoveryCache.delete(key);
  }
}

async function readEmbedConfigDiscoveryFingerprint(file: string): Promise<EmbedConfigDiscoveryFingerprint | null> {
  let main: { isFile(): boolean; mtimeMs: number; size: number };
  try {
    main = await fs.lstat(file);
  } catch {
    return null;
  }
  if (!main.isFile()) return null;

  let walMtimeMs: number | null = null;
  let walSize: number | null = null;
  try {
    const wal = await fs.lstat(`${file}-wal`);
    if (!wal.isFile()) return null;
    walMtimeMs = wal.mtimeMs;
    walSize = wal.size;
  } catch (error) {
    if (errnoCode(error) !== "ENOENT") return null;
  }
  return { mtimeMs: main.mtimeMs, size: main.size, walMtimeMs, walSize };
}

function cloneEmbedDbConfigDiscovery(discovery: EmbedDbConfigDiscovery): EmbedDbConfigDiscovery {
  switch (discovery.kind) {
    case "owned":
      return { kind: "owned", meta: { ...discovery.meta } };
    case "missing":
      return { kind: "missing" };
    case "empty":
      return { kind: "empty" };
    case "refused":
      return { kind: "refused" };
  }
}

/**
 * v3.9.0-rc.28 (external-audit M-6) — per-cache cap for raw metadata and
 * discriminated configuration discovery. A long-running `serve` over many
 * distinct file/root tuples would otherwise retain entries forever. 512
 * covers any realistic single-vault session with comfortable headroom.
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

/**
 * Read the discriminated, root-scoped embedding configuration discovery
 * through a bounded LRU cache. Entries are isolated by exact file/root tuple
 * and invalidated when the main file's `mtimeMs`/size or the WAL sidecar's
 * presence/`mtimeMs`/size changes. The returned owned metadata is cloned so
 * callers cannot mutate a cached authority snapshot. Raw peek entries and
 * other roots never share this cache keyspace. `refused` is never cached:
 * transient open/read/close/permission uncertainty is re-probed on every call.
 *
 * This remains pre-open guidance rather than bootstrap authority; every
 * writable `EmbedDb.open()` repeats same-handle transactional admission.
 *
 * @param file - Absolute path to the candidate embedding database.
 * @param expectedVaultRoot - Exact vault root allowed to own a populated file.
 * @returns The same four-state result as {@link discoverEmbedDbConfig}.
 * @example
 * ```ts
 * const discovery = await discoverEmbedDbConfigCached(embedFile, vault.root);
 * if (discovery.kind !== "owned") return [];
 * useStoredConfig(discovery.meta);
 * ```
 */
export async function discoverEmbedDbConfigCached(
  file: string,
  expectedVaultRoot: string
): Promise<EmbedDbConfigDiscovery> {
  const cacheKey = embedConfigDiscoveryCacheKey(file, expectedVaultRoot);
  const before = await readEmbedConfigDiscoveryFingerprint(file);
  if (before === null) {
    deleteEmbedConfigDiscoveryCacheFile(file);
    return discoverEmbedDbConfig(file, expectedVaultRoot);
  }

  const cached = embedConfigDiscoveryCache.get(cacheKey);
  if (
    cached &&
    cached.mtimeMs === before.mtimeMs &&
    cached.size === before.size &&
    cached.walMtimeMs === before.walMtimeMs &&
    cached.walSize === before.walSize
  ) {
    if (cached.discovery.kind !== "refused") {
      embedConfigDiscoveryCache.delete(cacheKey);
      embedConfigDiscoveryCache.set(cacheKey, cached);
      return cloneEmbedDbConfigDiscovery(cached.discovery);
    }
    // A refusal may come from a transient open/read/close/permission failure;
    // never let an unchanged file fingerprint make that uncertainty sticky.
    embedConfigDiscoveryCache.delete(cacheKey);
  }

  const discovery = await discoverEmbedDbConfig(file, expectedVaultRoot);
  if (discovery.kind === "refused") {
    embedConfigDiscoveryCache.delete(cacheKey);
    return { kind: "refused" };
  }
  const after = await readEmbedConfigDiscoveryFingerprint(file);
  if (after === null) {
    deleteEmbedConfigDiscoveryCacheFile(file);
    return discoverEmbedDbConfig(file, expectedVaultRoot);
  }
  if (
    after.mtimeMs !== before.mtimeMs ||
    after.size !== before.size ||
    after.walMtimeMs !== before.walMtimeMs ||
    after.walSize !== before.walSize
  ) {
    // Do not cache a snapshot that raced a file replacement or mutation.
    deleteEmbedConfigDiscoveryCacheFile(file);
    return discoverEmbedDbConfig(file, expectedVaultRoot);
  }

  lruMapSet(
    embedConfigDiscoveryCache,
    cacheKey,
    {
      file,
      mtimeMs: after.mtimeMs,
      size: after.size,
      walMtimeMs: after.walMtimeMs,
      walSize: after.walSize,
      discovery
    },
    MAX_PEEK_CACHE_ENTRIES
  );
  return cloneEmbedDbConfigDiscovery(discovery);
}

/**
 * Read bounded embedding metadata through the mtime-keyed cache. Raw discovery
 * and each expected-root/full-class result use distinct composite keys, so a
 * foreign or diagnostic lookup cannot poison a later owning-root lookup.
 *
 * @param file - Absolute path to a `.embed.db` file.
 * @param expectedVaultRoot - Optional exact root plus full-class filter; omit
 *   for raw bounded diagnostics.
 * @returns Cached bounded metadata when class/root-compatible, null otherwise.
 * @example
 * ```ts
 * const meta = await peekEmbedDbMetaCached(embedFile, canonicalVaultRoot);
 * ```
 */
export async function peekEmbedDbMetaCached(file: string, expectedVaultRoot?: string): Promise<PeekEmbedDbMetaResult> {
  const fsMod = await import("node:fs/promises");
  const cacheKey = peekCacheKey(file, expectedVaultRoot);
  let mtimeMs: number;
  try {
    const stat = await fsMod.stat(file);
    mtimeMs = stat.mtimeMs;
  } catch {
    // File missing/inaccessible — drop any stale cache and delegate to
    // the non-cached peek (which itself returns null for missing files).
    deletePeekCacheFile(file);
    return peekEmbedDbMeta(file, expectedVaultRoot);
  }
  const cached = peekCache.get(cacheKey);
  if (cached && cached.mtimeMs === mtimeMs) {
    // LRU recency bump: move this key to the newest slot so it isn't evicted
    // ahead of genuinely-older entries.
    peekCache.delete(cacheKey);
    peekCache.set(cacheKey, cached);
    return cached.meta;
  }
  const meta = await peekEmbedDbMeta(file, expectedVaultRoot);
  lruMapSet(peekCache, cacheKey, { file, mtimeMs, meta }, MAX_PEEK_CACHE_ENTRIES);
  return meta;
}

/**
 * v3.7.0 L-1 — test-only. Clear the module-level raw-peek and discriminated
 * discovery caches. Used in unit tests to isolate state; in production the
 * bounded caches live as long as the process.
 */
export function clearPeekCache(): void {
  peekCache.clear();
  embedConfigDiscoveryCache.clear();
}
