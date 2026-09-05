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

import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { removeArtifact } from "./erasure-receipt.js";
import { clearHnswPersistedArtifactsWithEraser, preflightHnswPersistedArtifacts } from "./hnsw.js";
import { optionalDepDetail } from "./optional-dep.js";
import {
  acquirePersistenceFamilyLease,
  acquirePersistenceFamilyLeaseInScopes,
  type PersistenceFamilyLeaseHandle,
  type PersistenceFamilyScopes
} from "./persistence-coordination.js";
import {
  PersistenceLeaseDebtCapacityError,
  PersistenceLeaseError,
  PersistenceLeaseIntegrityError,
  PersistenceLeaseOwnershipError,
  revalidatePersistenceLeaseScope
} from "./persistence-lease.js";
import { assertEmbedDbFilePath, embedDbFileStem } from "./persistence-path.js";
import { EMBED_DB_SCHEMA_VERSION } from "./schema-contract.js";
import {
  type ActiveSemanticPersistenceEraser,
  embedDbPathInSemanticScopes,
  SEMANTIC_PERSISTENCE_FAMILY_KEY,
  scopesFromActiveSemanticEraser,
  withEmbedReplacementStageEraser,
  withSemanticPersistenceEraser
} from "./semantic-persistence.js";
import {
  preflightSensitiveArtifactTemps,
  preflightSqliteArtifactFamily,
  removeSensitiveArtifactTemps
} from "./sensitive-artifact.js";
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
// v5 gives every physical EmbedDb generation a cryptographic instance UUID and
// installs exact table-level mutation triggers that advance one durable epoch.
// A same-config v2/v3/v4 store keeps its vectors through that metadata upgrade;
// v1 still rebuilds because its embeddings table has no `kind` column.

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
 *   schema_version: "5",
 *   vault_root: "/vault",
 *   model_alias: "multilingual",
 *   dim: "384",
 *   quantization: "f32",
 *   instance_uuid: "0123456789abcdef0123456789abcdef",
 *   mutation_epoch: "1"
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
  /** Durable database-generation UUID; present only for the current schema. */
  readonly instance_uuid?: string;
  /** Canonical positive safe-integer durable mutation epoch; current schema only. */
  readonly mutation_epoch?: string;
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

/** Metadata for one embedding row admitted into an HNSW generation. */
export interface HnswPersistenceRow {
  /** Vault-relative source path. */
  readonly rel_path: string;
  /** Zero-based chunk index within the source. */
  readonly chunk_index: number;
  /** One-based inclusive source line range start. */
  readonly line_start: number;
  /** One-based inclusive source line range end. */
  readonly line_end: number;
  /** Bounded persisted preview associated with the vector. */
  readonly text_preview: string;
  /** Source kind admitted by the embedding schema. */
  readonly kind: EmbedChunkKind;
}

/** Exact SQLite-generation authority used to admit a persisted HNSW graph. */
export interface HnswPersistenceReceipt {
  /** Receipt schema version. */
  readonly version: 3;
  /** Human-readable composite containing both cryptographic manifests. */
  readonly signature: string;
  /** Cryptographic identity of the physical EmbedDb generation. */
  readonly dbInstanceUuid: string;
  /** Monotonic durable mutation epoch captured with every other receipt field. */
  readonly dbMutationEpoch: number;
  /** Trusted embedding dimension. */
  readonly dim: number;
  /** Number of fully admitted, non-quarantined embedding rows. */
  readonly activeRows: number;
  /** Largest admitted native label, or zero for an empty snapshot. */
  readonly maxLabel: number;
  /** SHA-256 over the ordered live-label manifest. */
  readonly liveLabelSha256: string;
  /** SHA-256 over configuration, source receipts, row metadata, and raw vector bytes. */
  readonly dbPayloadSha256: string;
}

/** Cheap transactional identity of one physical EmbedDb generation. */
export interface EmbedDbGenerationIdentity {
  /** Cryptographic identity rotated whenever the physical database is rebuilt. */
  readonly dbInstanceUuid: string;
  /** Monotonic durable epoch advanced by every admitted semantic mutation. */
  readonly dbMutationEpoch: number;
}

/**
 * Result of a mutation admitted against one exact EmbedDb generation.
 *
 * A drift result proves that the callback performed no DML. Callers may then
 * quarantine any derived in-memory graph before applying an authoritative
 * database-only mutation.
 */
export type EmbedConditionalMutationResult<T> =
  | {
      /** The expected generation still owned the write lock and committed. */
      readonly kind: "committed";
      /** Mutation-specific result captured by the same transaction. */
      readonly value: T;
      /** Exact UUID/epoch after every trigger fired and before commit. */
      readonly committedGeneration: EmbedDbGenerationIdentity;
    }
  | {
      /** Another writer advanced or replaced the physical database first. */
      readonly kind: "generation-drift";
      /** Current authority observed under the write lock; never graph authority. */
      readonly observedGeneration: EmbedDbGenerationIdentity;
    };

/** One transactionally consistent HNSW receipt and trusted label map. */
export interface HnswReceiptSnapshot {
  /** Exact generation receipt. */
  readonly receipt: HnswPersistenceReceipt;
  /** Current database-owned metadata keyed by native label. */
  readonly rowsByLabel: Map<number, HnswPersistenceRow>;
}

/**
 * One transactionally consistent persisted-graph load authority.
 *
 * @example
 * ```ts
 * const snapshot = db.captureHnswLoadSnapshot();
 * snapshot.vectorsByLabel.get(42);
 * ```
 */
export interface HnswLoadSnapshot extends HnswReceiptSnapshot {
  /** DB-canonical decoded vectors keyed by the same native labels. */
  readonly vectorsByLabel: Map<number, Float32Array>;
}

/** One transactionally consistent HNSW build input. */
export interface HnswBuildSnapshot extends HnswReceiptSnapshot {
  /** Admitted vectors and their database labels from the same SQLite snapshot. */
  readonly vectors: Array<{
    readonly label: number;
    readonly vector: Float32Array;
    readonly rel_path: string;
    readonly chunk_index: number;
    readonly line_start: number;
    readonly line_end: number;
    readonly text_preview: string;
    readonly kind: EmbedChunkKind;
  }>;
}

/**
 * A durable embedding generation failed its internal source, row, or vector
 * integrity contract. Callers must not downgrade this error to partial
 * semantic results.
 */
export class EmbedSnapshotIntegrityError extends Error {
  /** Create one fail-closed embedding-generation integrity error. */
  constructor(message: string) {
    super(message);
    this.name = "EmbedSnapshotIntegrityError";
  }
}

/**
 * A complete embedding generation cannot be materialized within the bounded
 * semantic/HNSW snapshot resource envelope.
 */
export class EmbedSnapshotCapacityError extends RangeError {
  /** Create one fail-closed snapshot-capacity error. */
  constructor(message: string) {
    super(message);
    this.name = "EmbedSnapshotCapacityError";
  }
}

/** Result of one atomic source replacement in the embedding store. */
export interface EmbedUpsertResult {
  /** Native labels retired by the replacement. */
  oldIds: number[];
  /** Fresh AUTOINCREMENT labels, in input-row order. */
  newIds: number[];
  /**
   * DB-canonical vectors in the same order as {@link newIds}. For int8
   * storage these are decoded from the exact quantized BLOB, so a live HNSW
   * update and a restart rebuild consume identical numeric input.
   */
  newVectors: Float32Array[];
}

/** Compare every authority field of two HNSW persistence receipts. */
export function sameHnswPersistenceReceipt(left: HnswPersistenceReceipt, right: HnswPersistenceReceipt): boolean {
  return (
    left.version === right.version &&
    left.signature === right.signature &&
    left.dbInstanceUuid === right.dbInstanceUuid &&
    left.dbMutationEpoch === right.dbMutationEpoch &&
    left.dim === right.dim &&
    left.activeRows === right.activeRows &&
    left.maxLabel === right.maxLabel &&
    left.liveLabelSha256 === right.liveLabelSha256 &&
    left.dbPayloadSha256 === right.dbPayloadSha256
  );
}

/** Compare the complete cheap identity of two physical EmbedDb generations. */
export function sameEmbedDbGenerationIdentity(
  left: EmbedDbGenerationIdentity,
  right: EmbedDbGenerationIdentity
): boolean {
  return left.dbInstanceUuid === right.dbInstanceUuid && left.dbMutationEpoch === right.dbMutationEpoch;
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
const MAX_EMBED_MUTATION_EPOCH = Number.MAX_SAFE_INTEGER;
const EMBED_INSTANCE_UUID_PATTERN = /^[0-9a-f]{32}$/;
const MAX_SOURCE_RECEIPT_BATCH = 512;
const MAX_HNSW_NATIVE_LABEL = 0xffff_ffff;
const HNSW_RECEIPT_VERSION = 3 as const;
const HNSW_VECTOR_NORM_SQUARED_MIN = 0.81;
const HNSW_VECTOR_NORM_SQUARED_MAX = 1.21;
const MAX_HNSW_SNAPSHOT_ROWS = 250_000;
const MAX_HNSW_SNAPSHOT_TEXT_BYTES = 64 * 1024 * 1024;
const MAX_HNSW_SNAPSHOT_PATH_BYTES = 4096;
const MAX_HNSW_SNAPSHOT_PREVIEW_BYTES = 64 * 1024;
const MAX_HNSW_COMBINED_WORKING_SET_BYTES = 1024 * 1024 * 1024;
const HNSW_COMBINED_FIXED_HEADROOM_BYTES = 64 * 1024 * 1024;
const HNSW_SNAPSHOT_DEFAULT_M = 16;
const HNSW_SNAPSHOT_NATIVE_PER_ELEMENT_HEADROOM_BYTES = 256;
const HNSW_SNAPSHOT_METADATA_PER_ROW_BYTES = 512;
const HNSW_SNAPSHOT_MIN_NATIVE_CAPACITY = 1024;
const MAX_EMBED_SEARCH_K = 10_000;

function isCanonicalMutationEpoch(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const epoch = Number(value);
  return Number.isSafeInteger(epoch) && epoch >= 1 && epoch <= MAX_EMBED_MUTATION_EPOCH && String(epoch) === value;
}

function assertEmbedDbGenerationIdentity(value: EmbedDbGenerationIdentity): void {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof value.dbInstanceUuid !== "string" ||
    !EMBED_INSTANCE_UUID_PATTERN.test(value.dbInstanceUuid) ||
    !Number.isSafeInteger(value.dbMutationEpoch) ||
    value.dbMutationEpoch < 1 ||
    value.dbMutationEpoch > MAX_EMBED_MUTATION_EPOCH
  ) {
    throw new TypeError("Expected embedding generation must contain a lowercase 128-bit UUID and safe epoch");
  }
}

function captureEmbedDbGenerationIdentity(db: Db): EmbedDbGenerationIdentity {
  const rows = db
    .prepare("SELECT key, value FROM meta WHERE key IN ('instance_uuid', 'mutation_epoch') ORDER BY key LIMIT 3")
    .all<{ key: unknown; value: unknown }>();
  const meta = new Map<string, string>();
  for (const row of rows) {
    if (typeof row.key !== "string" || typeof row.value !== "string" || meta.has(row.key)) {
      throw new EmbedSnapshotIntegrityError("Embedding generation identity is malformed");
    }
    meta.set(row.key, row.value);
  }
  const dbInstanceUuid = meta.get("instance_uuid");
  const mutationEpoch = meta.get("mutation_epoch");
  if (
    rows.length !== 2 ||
    dbInstanceUuid === undefined ||
    !EMBED_INSTANCE_UUID_PATTERN.test(dbInstanceUuid) ||
    !isCanonicalMutationEpoch(mutationEpoch)
  ) {
    throw new EmbedSnapshotIntegrityError("Embedding generation identity is malformed");
  }
  return {
    dbInstanceUuid,
    dbMutationEpoch: Number(mutationEpoch)
  };
}

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

const MUTATION_EPOCH_TABLES = ["embeddings", "source_state", "source_quarantine", "source_revision"] as const;
const MUTATION_EPOCH_OPERATIONS = ["INSERT", "UPDATE", "DELETE"] as const;
const MUTATION_EPOCH_TRIGGER_DEFINITIONS = MUTATION_EPOCH_TABLES.flatMap((table) =>
  MUTATION_EPOCH_OPERATIONS.map((operation) => {
    const name = `embed_mutation_epoch_${table}_${operation.toLowerCase()}`;
    return {
      name,
      sql: `CREATE TRIGGER ${name}
        BEFORE ${operation} ON ${table}
        BEGIN
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1
            FROM meta
            WHERE key = 'mutation_epoch'
              AND typeof(value) = 'text'
              AND value = CAST(CAST(value AS INTEGER) AS TEXT)
              AND CAST(value AS INTEGER) BETWEEN 1 AND ${MAX_EMBED_MUTATION_EPOCH - 1}
          ) THEN RAISE(ABORT, 'embedding mutation epoch is invalid or exhausted') END;
          UPDATE meta
          SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)
          WHERE key = 'mutation_epoch';
        END`
    } as const;
  })
);
const MUTATION_EPOCH_TRIGGER_NAMES = MUTATION_EPOCH_TRIGGER_DEFINITIONS.map(({ name }) => name);

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
  ...SOURCE_REVISION_TRIGGER_NAMES.map((name) => [name, "trigger"] as const),
  ...MUTATION_EPOCH_TRIGGER_NAMES.map((name) => [name, "trigger"] as const)
]);
const HISTORICAL_EMBED_DB_SCHEMA_VERSIONS = new Set([1, 2, 3, 4]);
const EMBED_META_KEYS = new Set([
  "schema_version",
  "vault_root",
  "model_alias",
  "dim",
  "quantization",
  "instance_uuid",
  "mutation_epoch"
]);

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
// keeps the core shape and adds the repairable quarantine/revision ledger; v5
// requires the complete ledger plus instance/epoch mutation authority.
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
    const storedInstanceUuid = meta.instance_uuid;
    const storedMutationEpoch = meta.mutation_epoch;
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
    if (schemaVersion > EMBED_DB_SCHEMA_VERSION) return { kind: "refused", reason: "future" };
    const currentSchema = schemaVersion === EMBED_DB_SCHEMA_VERSION;
    if (!currentSchema && !HISTORICAL_EMBED_DB_SCHEMA_VERSIONS.has(schemaVersion)) {
      return { kind: "refused", reason: "malformed" };
    }
    const expectedMetaKeys =
      schemaVersion < 3
        ? ["schema_version", "vault_root", "model_alias", "dim"]
        : currentSchema
          ? ["schema_version", "vault_root", "model_alias", "dim", "quantization", "instance_uuid", "mutation_epoch"]
          : ["schema_version", "vault_root", "model_alias", "dim", "quantization"];
    if (
      rows.length !== expectedMetaKeys.length ||
      expectedMetaKeys.some((key) => !Object.hasOwn(meta, key)) ||
      (!currentSchema && (storedInstanceUuid !== undefined || storedMutationEpoch !== undefined)) ||
      (currentSchema &&
        (typeof storedInstanceUuid !== "string" ||
          !EMBED_INSTANCE_UUID_PATTERN.test(storedInstanceUuid) ||
          !isCanonicalMutationEpoch(storedMutationEpoch)))
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
    const triggerSql = new Map(
      objects.filter((object) => object.type === "trigger").map((object) => [object.name, object.sql ?? ""])
    );
    const hasExactTriggerDefinitions = (definitions: ReadonlyArray<Readonly<{ name: string; sql: string }>>): boolean =>
      definitions.every(({ name, sql }) => {
        const storedSql = triggerSql.get(name);
        return storedSql !== undefined && normalizeSql(storedSql) === normalizeSql(sql);
      });
    if (
      SOURCE_REVISION_TRIGGER_DEFINITIONS.some(({ name }) => objectTypes.has(name)) &&
      !hasExactTriggerDefinitions(SOURCE_REVISION_TRIGGER_DEFINITIONS)
    ) {
      return { kind: "refused", reason: "malformed" };
    }
    if (currentSchema) {
      const requiredCurrentObjects = [
        "meta",
        "embeddings",
        "source_state",
        "source_quarantine",
        "source_revision",
        "embeddings_rel_path",
        ...SOURCE_REVISION_TRIGGER_NAMES,
        ...MUTATION_EPOCH_TRIGGER_NAMES
      ];
      if (
        objects.length !== requiredCurrentObjects.length ||
        requiredCurrentObjects.some((name) => !objectTypes.has(name)) ||
        !hasExactTriggerDefinitions(SOURCE_REVISION_TRIGGER_DEFINITIONS) ||
        !hasExactTriggerDefinitions(MUTATION_EPOCH_TRIGGER_DEFINITIONS)
      ) {
        return { kind: "refused", reason: "malformed" };
      }
    } else if (MUTATION_EPOCH_TRIGGER_NAMES.some((name) => objectTypes.has(name))) {
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
    if (storedRoot !== expectedVaultRoot) return { kind: "refused", reason: "foreign" };
    const ownedMeta: EmbedDbOwnedMeta = {
      schema_version: storedSchemaVersion,
      vault_root: storedRoot,
      model_alias: storedModelAlias,
      dim: storedDim,
      ...(storedQuantization === undefined ? {} : { quantization: storedQuantization }),
      ...(storedInstanceUuid === undefined ? {} : { instance_uuid: storedInstanceUuid }),
      ...(storedMutationEpoch === undefined ? {} : { mutation_epoch: storedMutationEpoch })
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
  /** Absolute path whose basename ends exactly in `.embed.db`. */
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
 * upgraded in place when the vector table already matches the current v2 shape
 * and only schema metadata is behind; rebuilt for v1 table-shape or
 * model/dim/quantization mismatches; foreign, malformed, and future-schema
 * databases are refused without Enquire-issued persistent PRAGMA, DDL, DML,
 * chmod, or HNSW actions.
 *
 * @example
 * ```ts
 * const db = new EmbedDb({ file, vaultRoot, modelAlias: "multilingual", dim: 384 });
 * await db.open();
 * db.upsertNote(relPath, mtimeMs, chunks);
 * const hits = db.search(queryVec, 10);
 * await db.closeAndRelease();
 * ```
 */
export class EmbedDb {
  private db: Db | null = null;
  private file: string;
  private persistenceScopes: PersistenceFamilyScopes | null = null;
  private persistenceLifetime: PersistenceFamilyLeaseHandle | null = null;
  private persistenceReleasePromise: Promise<void> | null = null;
  private openAttempt: Promise<void> | null = null;
  private closeAttempt: Promise<void> | null = null;
  private closeAttemptFailed = false;
  private closeRequestToken: object = {};
  private closeRequested = false;
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
   * @throws {TypeError} If a string or quantization option is invalid, including
   *   a file without the exact `.embed.db` suffix.
   * @throws {RangeError} If `dim` is not a positive safe integer.
   */
  constructor(opts: EmbedDbOptions) {
    if (typeof opts.file !== "string" || opts.file.length === 0) {
      throw new TypeError("Embedding index file must be a non-empty string");
    }
    assertEmbedDbFilePath(opts.file);
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

  private async acquireSharedPersistenceRole(): Promise<PersistenceFamilyLeaseHandle> {
    const lease = this.persistenceScopes
      ? await acquirePersistenceFamilyLeaseInScopes(this.persistenceScopes, { role: "shared" })
      : await acquirePersistenceFamilyLease({
          targetPath: this.file,
          familyKey: SEMANTIC_PERSISTENCE_FAMILY_KEY,
          role: "shared"
        });
    this.persistenceScopes ??= lease.scopes;
    this.file = embedDbPathInSemanticScopes(this.persistenceScopes);
    return lease;
  }

  private releasePersistenceLifetime(): Promise<void> {
    const lifetime = this.persistenceLifetime;
    if (!lifetime) return Promise.resolve();
    if (this.persistenceReleasePromise) return this.persistenceReleasePromise;
    const attempt = lifetime.release();
    const tracked = attempt.then(
      () => {
        if (this.persistenceLifetime === lifetime) this.persistenceLifetime = null;
        if (this.persistenceReleasePromise === tracked) this.persistenceReleasePromise = null;
      },
      (error: unknown) => {
        if (this.persistenceReleasePromise === tracked) this.persistenceReleasePromise = null;
        throw error;
      }
    );
    this.persistenceReleasePromise = tracked;
    return tracked;
  }

  private closeDbHandle(): void {
    const db = this.db;
    this.db = null;
    db?.close();
  }

  private async revalidatePersistenceScopes(): Promise<void> {
    const scopes = this.persistenceScopes;
    if (!scopes) throw new Error("EmbedDb persistence scopes are unavailable");
    await revalidatePersistenceLeaseScope(scopes.namespace);
    await revalidatePersistenceLeaseScope(scopes.family);
    this.file = embedDbPathInSemanticScopes(scopes);
  }

  /**
   * Open the SQLite database, verify ownership on the live handle, bootstrap
   * only an admitted schema, then enable WAL and best-effort tighten file permissions.
   * Refusal preserves logical schema and cell/BLOB values. SQLite itself may
   * still take locks, recover/checkpoint an existing journal, or touch physical
   * container/sidecar bytes while opening and closing; this API does not claim
   * byte-identical DB/WAL/SHM or directory state. Before dependency loading and
   * again immediately before native open, the main, WAL, SHM, and rollback-
   * journal leaves must be wholly absent or every present leaf must be a singly
   * linked regular file; orphan sidecars refuse. Idempotent after success.
   *
   * @param expectedDiscovery - Optional readonly preflight result to bind this
   *   mutating open to. No argument preserves the low-level intentional-rebuild
   *   contract; a supplied stale result is refused before bootstrap.
   * @throws {Error} If `better-sqlite3` (an optional dependency) fails to
   *   load, its native binding is unavailable, or a populated database cannot
   *   prove same-vault EmbedDb ownership under a supported non-future schema.
   */
  async open(expectedDiscovery?: EmbedDbConfigDiscovery): Promise<void> {
    if (this.db && !this.closeRequested) return;
    if (this.openAttempt && !this.closeRequested && !this.closeAttempt) return this.openAttempt;
    // A new attempt is now known to be necessary. Snapshot caller-owned
    // authority before the possible close await so retained objects cannot
    // mutate while prior resources drain. Idempotent/join fast paths above do
    // not inspect irrelevant caller input or invoke hostile getters.
    const expected = cloneEmbedDbOpenDiscovery(expectedDiscovery);
    if (this.closeRequested || this.closeAttempt) {
      const observedCloseRequest = this.closeRequestToken;
      await this.finishCloseAndRelease();
      if (this.closeRequestToken !== observedCloseRequest) {
        throw new Error("Embedding index reopen was superseded by a later close request");
      }
      this.closeAttempt = null;
      this.closeAttemptFailed = false;
      this.closeRequested = false;
    }
    if (this.openAttempt) return this.openAttempt;
    const attempt = this.openOnce(expected);
    this.openAttempt = attempt;
    try {
      await attempt;
    } finally {
      if (this.openAttempt === attempt) this.openAttempt = null;
    }
  }

  private async openOnce(expected: EmbedDbConfigDiscovery | null): Promise<void> {
    // A previous synchronous close may still be releasing (or retrying) its
    // exact shared marker. Never overlap it with a second lifetime.
    await this.releasePersistenceLifetime();
    let lifetime: PersistenceFamilyLeaseHandle;
    try {
      lifetime = await this.acquireSharedPersistenceRole();
    } catch (error) {
      if (error instanceof PersistenceLeaseIntegrityError) {
        throw new Error("Embedding index artifact family could not be admitted");
      }
      throw error;
    }
    this.persistenceLifetime = lifetime;
    try {
      if (this.closeRequested) {
        throw new Error("Embedding index close was requested while open was in progress");
      }
      let fileExisted: boolean;
      try {
        fileExisted = await preflightSqliteArtifactFamily(this.file);
      } catch {
        throw new Error("Embedding index artifact family could not be admitted");
      }
      const Ctor = await loadBetterSqlite();
      if (this.closeRequested) {
        throw new Error("Embedding index close was requested while open was in progress");
      }
      if (!fileExisted) {
        // The coordinated acquisition already created and pinned a missing
        // parent privately. Retain this check for compatibility with a custom
        // existing parent while never operating through its lexical alias.
        await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      }
      try {
        fileExisted = await preflightSqliteArtifactFamily(this.file);
        this.db = new Ctor(this.file) as Db;
      } catch {
        throw new Error("Embedding index could not be opened");
      }
      const admission = inspectEmbedAdmission(this.db, this.vaultRoot);
      assertEmbedAdmission(admission);
      assertExpectedEmbedDiscovery(expected, fileExisted, admission);
      this.bootstrapSchema(admission.kind, admission.signature);
      // Persistent connection policy is deliberately after the bootstrap
      // commit. No refused file receives an Enquire-issued journal/sync mode.
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = NORMAL");
      await Promise.all(
        [this.file, `${this.file}-wal`, `${this.file}-shm`].map((p) => fs.chmod(p, 0o600).catch(() => {}))
      );
      if (this.closeRequested) {
        throw new Error("Embedding index close was requested while open was in progress");
      }
    } catch (error) {
      const rollbackErrors: unknown[] = [error];
      try {
        this.closeDbHandle();
      } catch {
        // Preserve the original path-free admission/open error. Native close
        // may report after the handle has already become unusable.
      }
      try {
        await this.releasePersistenceLifetime();
      } catch (releaseError) {
        rollbackErrors.push(releaseError);
      }
      if (rollbackErrors.length > 1) {
        throw new AggregateError(rollbackErrors, "Embedding index open failed and coordinated rollback was incomplete");
      }
      throw error;
    }
  }

  /**
   * Remove the embed db + WAL/SHM/rollback-journal sidecars, HNSW persistence sidecars, and the
   * process-restart watcher interlock (`<embed-db>.watcher-activation.guard`).
   * The guard contains no vault content, but `clear-embeddings` is the explicit
   * recovery operation after a failed startup and therefore owns its removal.
   * Idempotent.
   *
   * v3.9.0-rc.34 (deep-audit P-2) — the HNSW sidecars were previously NOT
   * removed by `clear-embeddings`, so a `--use-hnsw` user's vault content
   * persisted on disk after "clearing" — and the historical format-2
   * `.hnsw.meta.json` carried `text_preview` (raw chunk text), so this was a
   * right-to-erasure / data-cleanup gap, not just stale-index hygiene. Current
   * compact pointers omit previews, but native vector generations remain
   * sensitive and the same erasure authority still owns the whole family.
   */
  async clearOnDisk(): Promise<boolean> {
    // An instance must never deadlock against its own shared lifetime. Await
    // the exact retryable release before requesting the exclusive family role.
    await this.closeAndRelease();
    // The stage-family eraser is deliberately outermost. A cooperating
    // replacement holds the conflicting publisher role from before its first
    // staging mkdir through commit or callback cleanup, so no new stage can
    // cross the preflight-to-unlink boundary below.
    return withEmbedReplacementStageEraser(this.file, () =>
      withSemanticPersistenceEraser(this.file, this.persistenceScopes ?? undefined, async (eraserCapability) => {
        this.persistenceScopes ??= eraserCapability.scopes;
        this.file = embedDbPathInSemanticScopes(this.persistenceScopes);
        let removed = false;
        await this.revalidatePersistenceScopes();
        // Validate any stranded interlock BEFORE deleting the first artifact.
        // Foreign files/symlinks/special objects and unexpected directory entries
        // therefore fail closed without turning recovery into an unnecessary
        // partial erase. The guard is validated again and removed last below.
        await preflightWatcherActivationGuardRecovery(this.file);
        // v3.10.0-rc.20 (audit M7) — derive the HNSW persist base via the SHARED
        // `hnswPersistBase` helper (same one server.ts's writer uses), then delegate
        // the complete legacy/generation/temp family to the HNSW eraser.
        const hnswBase = hnswPersistBase(this.file);
        await preflightHnswPersistedArtifacts(hnswBase);
        // Staged model-switch generations contain the same raw text_preview and
        // vector material as the live EmbedDb. Admit their complete bounded
        // namespace before deleting anything so clear-embeddings never reports
        // success while a released stage survives, and never partially erases
        // the live family when a stage is still active or malformed.
        await preflightSensitiveArtifactTemps(this.file);
        const targets = [this.file, `${this.file}-wal`, `${this.file}-shm`, `${this.file}-journal`];
        for (const target of targets) {
          let entry: import("node:fs").Stats;
          try {
            entry = await fs.lstat(target);
          } catch (err) {
            if (errnoCode(err) === "ENOENT") continue;
            throw new Error("Unable to inspect embedding-index artifacts before clearing", { cause: err });
          }
          if (!entry.isFile() && !entry.isSymbolicLink()) {
            throw new Error("Refusing to clear an unsafe embedding-index artifact");
          }
        }
        await this.revalidatePersistenceScopes();
        for (const p of targets) {
          // Recovery must never report success while a permission/type/race
          // error leaves a derived-data sidecar behind, and a removal is
          // believed only once the entry is re-statted absent.
          removed = (await removeArtifact(p, "embedding-index artifact")) || removed;
        }
        await this.revalidatePersistenceScopes();
        removed = (await clearHnswPersistedArtifactsWithEraser(hnswBase, eraserCapability)) || removed;
        removed = (await removeSensitiveArtifactTemps(this.file)) > 0 || removed;
        // Remove the guard LAST. If any derived artifact could not be removed, the
        // still-present guard keeps the next serve fail-closed. The helper accepts
        // only its narrow directory shape and never recursively deletes content.
        removed = (await clearWatcherActivationGuard(this.file)) || removed;
        await this.revalidatePersistenceScopes();
        return removed;
      })
    );
  }

  /**
   * Drain this open database's WAL and switch it to self-contained DELETE
   * journaling before a staged generation is admitted for atomic publication.
   * Logical tables, metadata, vectors, and the mutation epoch are unchanged.
   *
   * @returns Nothing after SQLite confirms a complete checkpoint and journal-mode switch.
   * @throws If the database is not open, a WAL reader is still busy, or SQLite
   *   cannot prove the requested standalone state.
   * @example
   * ```ts
   * await db.open();
   * db.checkpointForReplacement();
   * await db.closeAndRelease();
   * ```
   * @internal
   */
  checkpointForReplacement(): void {
    checkpointOpenEmbedDbForReplacement(this.requireDb());
  }

  /**
   * Return the exact pinned semantic-family scopes while this database is open.
   * HNSW publishers must use these scopes instead of re-resolving a pathname.
   *
   * @returns Pinned namespace and primary EmbedDb family scopes.
   * @throws {Error} If this EmbedDb does not hold an open shared lifetime.
   */
  getPersistenceFamilyScopes(): PersistenceFamilyScopes {
    this.requireDb();
    if (!this.persistenceScopes || !this.persistenceLifetime) {
      throw new Error("EmbedDb persistence lifetime is unavailable");
    }
    return this.persistenceScopes;
  }

  /**
   * Acquire an additional shared semantic-family lifetime in the already
   * pinned scopes. A prepared in-memory HNSW context owns this after its
   * short-lived SQLite snapshot handle closes.
   *
   * @returns Caller-owned shared family lifetime.
   * @throws {Error} If the EmbedDb is not open or its pinned scopes changed.
   */
  async acquireSharedPersistenceLifetime(): Promise<PersistenceFamilyLeaseHandle> {
    const scopes = this.getPersistenceFamilyScopes();
    return acquirePersistenceFamilyLeaseInScopes(scopes, { role: "shared" });
  }

  /**
   * Close the SQLite handle synchronously and begin releasing its shared
   * persistence lifetime. Release failures are retained for an awaited retry
   * through {@link closeAndRelease}; no rejection escapes unobserved.
   */
  close(): void {
    this.requestClose();
    let closeError: unknown;
    try {
      this.closeDbHandle();
    } catch (error) {
      closeError = error;
    }
    const attempt = this.beginCloseAttempt();
    void attempt.catch(() => {});
    if (closeError !== undefined) throw closeError;
  }

  /**
   * Close SQLite and await exact shared-lifetime release. A failed release
   * remains retryable: a later invocation reuses the same core handle rather
   * than silently acquiring or forgetting a second marker.
   *
   * @returns After both the native handle and shared lease are released.
   */
  async closeAndRelease(): Promise<void> {
    this.requestClose();
    await this.finishCloseAndRelease();
  }

  private requestClose(): void {
    this.closeRequested = true;
    this.closeRequestToken = {};
  }

  private async finishCloseAndRelease(): Promise<void> {
    const errors: unknown[] = [];
    try {
      this.closeDbHandle();
    } catch (error) {
      errors.push(error);
    }
    if (this.closeAttempt && this.closeAttemptFailed) {
      this.closeAttempt = null;
      this.closeAttemptFailed = false;
    }
    try {
      await this.beginCloseAttempt();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, "Embedding index close and persistence release both failed");
    }
  }

  private beginCloseAttempt(): Promise<void> {
    if (this.closeAttempt) return this.closeAttempt;
    const opening = this.openAttempt;
    const close = async (): Promise<void> => {
      if (opening) {
        try {
          await opening;
        } catch {
          // openOnce owns its primary failure and rollback. Continue so an
          // incomplete lifetime release remains retryable through this close.
        }
      }
      const errors: unknown[] = [];
      try {
        this.closeDbHandle();
      } catch (error) {
        errors.push(error);
      }
      try {
        await this.releasePersistenceLifetime();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(errors, "Embedding index close and persistence release both failed");
      }
    };
    const attempt = close();
    this.closeAttempt = attempt;
    this.closeAttemptFailed = false;
    void attempt.then(
      () => undefined,
      () => {
        if (this.closeAttempt === attempt) this.closeAttemptFailed = true;
      }
    );
    return attempt;
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
      const meta = admission.kind === "owned" ? admission.meta : undefined;
      const uninitialized = admission.kind === "empty";
      const versionMatch = uninitialized || meta?.schema_version === String(EMBED_DB_SCHEMA_VERSION);
      const modelMatch = uninitialized || meta?.model_alias === this.modelAlias;
      const dimMatch = uninitialized || meta?.dim === String(this.dim);
      // Pre-v3 indexes have no quantization key and are necessarily f32.
      const existingQuant = meta?.quantization ?? "f32";
      const quantMatch = uninitialized || existingQuant === this.quantization;
      const requiresBootstrap = uninitialized || !versionMatch || !modelMatch || !dimMatch || !quantMatch;
      // Only schema 4 may keep its vectors. v4 (v3.12.0-rc.19) pinned the q8
      // inference weights, so 4→5 is a pure metadata upgrade (UUID/epoch) over
      // vectors already produced in the current model space. Schemas 2 and 3
      // predate that pin: `v3.11.6:src/embeddings.ts` called `pipeline()` with
      // no `dtype`, so their vectors came from the FP32 graph and must be
      // rebuilt — `quantization` records the on-disk BLOB encoding, not the
      // inference dtype, so `schema_version` is the only carrier of that
      // distinction. Retaining them would mix two model spaces against q8 query
      // vectors: silent score corruption, strictly worse than the empty index
      // this guard exists to prevent (BACKLOG §1.CC A5, §1.CL CL-A5). v1
      // additionally lacks the `kind` column.
      const keepCompatibleVectors =
        !uninitialized && !versionMatch && modelMatch && dimMatch && quantMatch && Number(meta?.schema_version) >= 4;

      // Exact current schema + configuration is already a complete durable
      // generation. Reopening it must not rewrite metadata, rotate identity,
      // or advance the mutation epoch merely for observation.
      if (!requiresBootstrap) return;

      if (!versionMatch || !modelMatch || !dimMatch || !quantMatch) {
        const reason: string[] = [];
        if (!versionMatch) reason.push("supported schema upgrade");
        if (!modelMatch) reason.push("model configuration changed");
        if (!dimMatch) reason.push("vector dimension changed");
        if (!quantMatch) reason.push("quantization changed");
        process.stderr.write(
          keepCompatibleVectors
            ? `enquire: upgrading embed index schema in place (${reason.join("; ")})\n`
            : `enquire: rebuilding embed index (${reason.join("; ")})\n`
        );
      }

      // Remove every admitted mutation surface before dropping tables. Current
      // definitions are exact; historical recognized names are still removed
      // before any rebuild DML can fire.
      for (const name of [...SOURCE_REVISION_TRIGGER_NAMES, ...MUTATION_EPOCH_TRIGGER_NAMES]) {
        db.exec(`DROP TRIGGER IF EXISTS ${name}`);
      }
      if (!uninitialized && !keepCompatibleVectors) {
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

      // Identity metadata exists before the epoch triggers are installed. A
      // new physical database, a destructive rebuild, or a same-config
      // metadata upgrade always receives a fresh cryptographic UUID and starts
      // at epoch 1.
      this.writeMeta({
        schema_version: String(EMBED_DB_SCHEMA_VERSION),
        vault_root: this.vaultRoot,
        model_alias: this.modelAlias,
        dim: String(this.dim),
        quantization: this.quantization,
        instance_uuid: randomBytes(16).toString("hex"),
        mutation_epoch: "1"
      });

      // Recreate only after schema/backfill/metadata are complete. The whole
      // install remains inside the bootstrap transaction, so readers observe
      // either the previous complete contract or the new one.
      for (const definition of SOURCE_REVISION_TRIGGER_DEFINITIONS) {
        db.exec(definition.sql);
      }
      for (const definition of MUTATION_EPOCH_TRIGGER_DEFINITIONS) {
        db.exec(definition.sql);
      }
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

  /** Run DML only while one exact generation owns SQLite's write lock. */
  private mutateIfGeneration<T>(
    expected: EmbedDbGenerationIdentity,
    mutate: () => T
  ): EmbedConditionalMutationResult<T> {
    assertEmbedDbGenerationIdentity(expected);
    const db = this.requireDb();
    const transaction = db.transaction((): EmbedConditionalMutationResult<T> => {
      const observedGeneration = captureEmbedDbGenerationIdentity(db);
      if (!sameEmbedDbGenerationIdentity(expected, observedGeneration)) {
        return { kind: "generation-drift", observedGeneration };
      }
      const value = mutate();
      return {
        kind: "committed",
        value,
        committedGeneration: captureEmbedDbGenerationIdentity(db)
      };
    });
    // The expected-generation check must run only after SQLite has excluded
    // every competing writer. A deferred transaction would leave a gap
    // between observation and the first DML statement.
    return transaction.immediate();
  }

  /**
   * Replace all embeddings for a single note. Caller computes vectors.
   * v2.8.0: optional `kind` parameter ("md" | "pdf"); defaults to "md" so
   * existing callers (markdown indexing path) need no changes.
   *
   * @returns The legacy semver-bound `{ oldIds, newIds }` result. Internal
   *   HNSW maintainers that also need DB-canonical decoded vectors use
   *   {@link upsertNoteWithCanonicalVectors}; keeping that additive sibling
   *   avoids changing the public method's exact return shape.
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
    const { oldIds, newIds } = this.upsertNoteWithCanonicalVectors(relPath, mtimeMs, chunks, kind);
    return { oldIds, newIds };
  }

  /**
   * Replace one source generation and return the exact decoded vectors stored
   * by the same SQLite transaction.
   *
   * @returns `{ oldIds, newIds, newVectors }`, where `newVectors` are decoded
   *   from the committed BLOBs in `newIds` order. Watcher HNSW updates must use
   *   this sibling so int8 live search and restart rebuilds consume identical
   *   numeric input.
   */
  upsertNoteWithCanonicalVectors(
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
  ): EmbedUpsertResult {
    const db = this.requireDb();
    const transaction = db.transaction(() => this.upsertNoteInCurrentTransaction(relPath, mtimeMs, chunks, kind));
    return transaction();
  }

  /**
   * Replace one source only if an in-memory HNSW graph still names the exact
   * current database generation.
   *
   * The comparison and every mutation run under one `BEGIN IMMEDIATE`
   * transaction. A drift result performs no DML, allowing the watcher to
   * quarantine its stale graph before retrying through the authoritative
   * database-only path.
   *
   * @param expected - UUID/epoch currently owned by the in-memory graph.
   * @param relPath - Exact vault-relative source path.
   * @param mtimeMs - Revalidated source modification time.
   * @param chunks - Fully prepared, normalized embedding chunks.
   * @param kind - Markdown or PDF source kind.
   * @returns Either the committed row diff plus its new generation, or a
   *   no-write drift receipt.
   */
  upsertNoteWithCanonicalVectorsIfGeneration(
    expected: EmbedDbGenerationIdentity,
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
  ): EmbedConditionalMutationResult<EmbedUpsertResult> {
    return this.mutateIfGeneration(expected, () => this.upsertNoteInCurrentTransaction(relPath, mtimeMs, chunks, kind));
  }

  /** Perform a source replacement inside the caller-owned transaction. */
  private upsertNoteInCurrentTransaction(
    relPath: string,
    mtimeMs: number,
    chunks: ReadonlyArray<{
      chunkIndex: number;
      lineStart: number;
      lineEnd: number;
      textPreview: string;
      vector: Float32Array;
    }>,
    kind: EmbedChunkKind
  ): EmbedUpsertResult {
    const db = this.requireDb();
    const dim = this.dim;
    const out: EmbedUpsertResult = { oldIds: [], newIds: [], newVectors: [] };
    // v3.9.0-rc.2 — capture the old ids BEFORE the DELETE so the
    // watcher can markDelete them in HNSW. Sorted ascending so callers
    // get stable ordering for snapshot diffing.
    const oldRows = db.prepare("SELECT id FROM embeddings WHERE rel_path = ? ORDER BY id").all<{ id: number }>(relPath);
    out.oldIds = oldRows.map((r) => r.id);
    db.prepare("DELETE FROM embeddings WHERE rel_path = ?").run(relPath);
    const insert = db.prepare(
      `INSERT INTO embeddings (rel_path, chunk_index, line_start, line_end, text_preview, vector, kind)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (const c of chunks) {
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
      if (this.quantization === "int8") {
        out.newVectors.push(decodeInt8Vector(blob, dim));
      } else {
        const persistedVector = new Float32Array(dim);
        for (let index = 0; index < dim; index += 1) {
          persistedVector[index] = blob.readFloatLE(index * 4);
        }
        out.newVectors.push(persistedVector);
      }
    }
    db.prepare(
      `INSERT OR REPLACE INTO source_state (rel_path, mtime_ms, n_chunks, kind, indexed_at)
       VALUES (?, ?, ?, ?, datetime('now'))`
    ).run(relPath, mtimeMs, chunks.length, kind);
    db.prepare("DELETE FROM source_quarantine WHERE rel_path = ?").run(relPath);
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
    const transaction = db.transaction(() => this.deleteNoteInCurrentTransaction(relPath));
    return transaction();
  }

  /**
   * Delete one source only while a derived HNSW graph still owns the expected
   * physical generation.
   *
   * @param expected - UUID/epoch currently owned by the in-memory graph.
   * @param relPath - Exact vault-relative source path.
   * @returns A committed deleted-label list and post-trigger generation, or a
   *   drift receipt proving no delete ran.
   */
  deleteNoteIfGeneration(
    expected: EmbedDbGenerationIdentity,
    relPath: string
  ): EmbedConditionalMutationResult<number[]> {
    return this.mutateIfGeneration(expected, () => this.deleteNoteInCurrentTransaction(relPath));
  }

  /** Delete one source inside the caller-owned transaction. */
  private deleteNoteInCurrentTransaction(relPath: string): number[] {
    const db = this.requireDb();
    const deletedIds: number[] = [];
    // v3.9.0-rc.2 — capture deleted ids BEFORE the DELETE for HNSW sync.
    const rows = db.prepare("SELECT id FROM embeddings WHERE rel_path = ? ORDER BY id").all<{ id: number }>(relPath);
    for (const r of rows) deletedIds.push(r.id);
    db.prepare("DELETE FROM embeddings WHERE rel_path = ?").run(relPath);
    db.prepare("DELETE FROM source_state WHERE rel_path = ?").run(relPath);
    db.prepare("DELETE FROM source_quarantine WHERE rel_path = ?").run(relPath);
    return deletedIds;
  }

  /**
   * Read the source-state table — caller compares mtimes to decide what to
   * re-embed. v2.8.0: optional `kind` filter — when set, only rows of that
   * kind are returned. Lets the markdown-sync and PDF-sync paths run
   * independently without one's "missing files" being deleted by the other.
   *
   * @param kind Optional source kind.
   * @param limit Optional positive safe row cap applied by SQLite before JS
   *   materialization. Callers that need an overflow receipt should request
   *   their policy limit plus one.
   * @returns Source-state rows in deterministic path order.
   */
  getSourceStates(kind?: EmbedChunkKind, limit?: number): SourceStateRow[] {
    const db = this.requireDb();
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
      throw new TypeError("source-state limit must be a positive safe integer");
    }
    if (kind !== undefined) {
      return limit === undefined
        ? db
            .prepare("SELECT rel_path, mtime_ms FROM source_state WHERE kind = ? ORDER BY rel_path")
            .all<SourceStateRow>(kind)
        : db
            .prepare("SELECT rel_path, mtime_ms FROM source_state WHERE kind = ? ORDER BY rel_path LIMIT ?")
            .all<SourceStateRow>(kind, limit);
    }
    return limit === undefined
      ? db.prepare("SELECT rel_path, mtime_ms FROM source_state ORDER BY rel_path").all<SourceStateRow>()
      : db.prepare("SELECT rel_path, mtime_ms FROM source_state ORDER BY rel_path LIMIT ?").all<SourceStateRow>(limit);
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
    const db = this.requireDb();
    const transaction = db.transaction(() => this.quarantineSourceInCurrentTransaction(relPath, kind));
    transaction();
  }

  /**
   * Quarantine one source only while a derived HNSW graph still owns the expected
   * physical generation.
   *
   * The comparison and the marker insert run under one `BEGIN IMMEDIATE`
   * transaction. A drift result performs no DML, allowing the watcher to
   * process-quarantine its stale graph before writing the marker DB-only.
   *
   * @param expected - UUID/epoch currently owned by the in-memory graph.
   * @param relPath - Exact vault-relative source path.
   * @param kind - Content-source kind.
   * @returns A committed post-trigger generation, or a drift receipt proving no
   *   marker write ran.
   */
  quarantineSourceIfGeneration(
    expected: EmbedDbGenerationIdentity,
    relPath: string,
    kind: EmbedChunkKind
  ): EmbedConditionalMutationResult<void> {
    return this.mutateIfGeneration(expected, () => this.quarantineSourceInCurrentTransaction(relPath, kind));
  }

  /** Insert one quarantine marker inside the caller-owned transaction. */
  private quarantineSourceInCurrentTransaction(relPath: string, kind: EmbedChunkKind): void {
    this.requireDb()
      .prepare("INSERT OR IGNORE INTO source_quarantine (rel_path, kind) VALUES (?, ?)")
      .run(relPath, kind);
  }

  /**
   * Return quarantined source paths in deterministic order.
   *
   * @param kind Optional content-kind filter.
   * @param limit Optional positive safe SQLite row cap. Callers that need an
   *   overflow receipt should request their policy limit plus one.
   * @returns Vault-relative paths that must be retried and withheld.
   * @example
   * ```ts
   * const markdownPaths = db.getQuarantinedPaths("md");
   * ```
   */
  getQuarantinedPaths(kind?: EmbedChunkKind, limit?: number): string[] {
    const db = this.requireDb();
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
      throw new TypeError("quarantine-path limit must be a positive safe integer");
    }
    const rows =
      kind === undefined
        ? limit === undefined
          ? db.prepare("SELECT DISTINCT rel_path FROM source_quarantine ORDER BY rel_path").all<{ rel_path: string }>()
          : db
              .prepare("SELECT DISTINCT rel_path FROM source_quarantine ORDER BY rel_path LIMIT ?")
              .all<{ rel_path: string }>(limit)
        : limit === undefined
          ? db
              .prepare("SELECT rel_path FROM source_quarantine WHERE kind = ? ORDER BY rel_path")
              .all<{ rel_path: string }>(kind)
          : db
              .prepare("SELECT rel_path FROM source_quarantine WHERE kind = ? ORDER BY rel_path LIMIT ?")
              .all<{ rel_path: string }>(kind, limit);
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
    if (!Number.isSafeInteger(k) || k < 1 || k > MAX_EMBED_SEARCH_K) {
      throw new RangeError(`embedding search k must be a safe integer in [1, ${MAX_EMBED_SEARCH_K}]`);
    }
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
    if (opts.minScore !== undefined && (!Number.isFinite(opts.minScore) || opts.minScore < -1 || opts.minScore > 1)) {
      throw new RangeError("embedding search minScore must be finite and in [-1, 1]");
    }
    const minScore = opts.minScore ?? -Infinity;
    // CodeQL js/polynomial-redos flags `\/+$` here as polynomial. False
    // positive: the `$` anchor forces match from end-of-string, and `\/+`
    // consumes only `/` chars greedily. Worst-case input (long trailing
    // run of slashes) is O(n), not O(n²).
    const folderPrefix = opts.folder ? `${stripTrailingSlashes(opts.folder)}/` : null;

    const search = db.transaction((): EmbedReceiptSearchHit[] => {
      // Ranking uses one SQLite snapshot. Complete-generation HNSW envelope
      // admission belongs to captureHnswReceiptSnapshot (graph build/load),
      // not brute-force cosine. Mixed-generation after awaited filesystem work
      // is refused by embeddingsSearch via the physical UUID plus ranked
      // source receipts, not the whole-database mutation epoch.

      // v2.0.0-beta.1 P2 fix: prefix-equality via substr — avoids LIKE pattern
      // semantics so folder names containing `%` / `_` don't expand into
      // wider matches. Stream rows and retain only the best k candidates;
      // item-count limits must bound memory, not merely the final slice.
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
        .iterate<{
          rel_path: unknown;
          chunk_index: unknown;
          line_start: unknown;
          line_end: unknown;
          text_preview: unknown;
          vector: unknown;
          kind: unknown;
          indexed_mtime_ms: unknown;
          indexed_revision: unknown;
        }>(...(folderPrefix ? [folderPrefix, folderPrefix] : [])); // rc.43 M1 — bind prefix twice (length(?) + substr=?)

      type RankedHit = { hit: EmbedReceiptSearchHit; ordinal: number };
      const heap: RankedHit[] = [];
      const compareWorstFirst = (left: RankedHit, right: RankedHit): number =>
        left.hit.score !== right.hit.score ? left.hit.score - right.hit.score : right.ordinal - left.ordinal;
      const siftUp = (start: number): void => {
        let index = start;
        while (index > 0) {
          const parent = Math.floor((index - 1) / 2);
          const child = heap[index];
          const parentValue = heap[parent];
          if (!child || !parentValue || compareWorstFirst(child, parentValue) >= 0) break;
          heap[index] = parentValue;
          heap[parent] = child;
          index = parent;
        }
      };
      const siftDown = (): void => {
        let index = 0;
        while (true) {
          const left = index * 2 + 1;
          const right = left + 1;
          let worst = index;
          const leftValue = heap[left];
          const currentWorst = heap[worst];
          if (leftValue && currentWorst && compareWorstFirst(leftValue, currentWorst) < 0) worst = left;
          const rightValue = heap[right];
          const nextWorst = heap[worst];
          if (rightValue && nextWorst && compareWorstFirst(rightValue, nextWorst) < 0) worst = right;
          if (worst === index) return;
          const current = heap[index];
          const replacement = heap[worst];
          if (!current || !replacement) return;
          heap[index] = replacement;
          heap[worst] = current;
          index = worst;
        }
      };

      let ordinal = 0;
      for (const row of rows) {
        if (
          typeof row.rel_path !== "string" ||
          row.rel_path.length === 0 ||
          Buffer.byteLength(row.rel_path, "utf8") > MAX_HNSW_SNAPSHOT_PATH_BYTES ||
          !Number.isSafeInteger(row.chunk_index) ||
          (row.chunk_index as number) < 0 ||
          !Number.isSafeInteger(row.line_start) ||
          (row.line_start as number) < 1 ||
          !Number.isSafeInteger(row.line_end) ||
          (row.line_end as number) < (row.line_start as number) ||
          typeof row.text_preview !== "string" ||
          Buffer.byteLength(row.text_preview, "utf8") > MAX_HNSW_SNAPSHOT_PREVIEW_BYTES ||
          !Buffer.isBuffer(row.vector) ||
          row.vector.byteLength !== this.encodedBytes ||
          (row.kind !== "md" && row.kind !== "pdf") ||
          typeof row.indexed_mtime_ms !== "number" ||
          !Number.isFinite(row.indexed_mtime_ms) ||
          !Number.isSafeInteger(row.indexed_revision) ||
          (row.indexed_revision as number) < 1 ||
          (row.indexed_revision as number) > MAX_SOURCE_REVISION
        ) {
          throw new EmbedSnapshotIntegrityError("Embedding search row is outside the admitted durable generation");
        }
        const vec =
          this.quantization === "int8"
            ? decodeInt8Vector(row.vector, this.dim)
            : new Float32Array(row.vector.buffer, row.vector.byteOffset, this.dim);
        let score = 0;
        for (let i = 0; i < this.dim; i++) {
          score += (queryVec[i] ?? 0) * (vec[i] ?? 0);
        }
        if (!Number.isFinite(score)) {
          throw new EmbedSnapshotIntegrityError("Embedding search produced a non-finite persisted score");
        }
        if (score < minScore) {
          ordinal += 1;
          continue;
        }
        const ranked: RankedHit = {
          ordinal,
          hit: {
            rel_path: row.rel_path,
            chunk_index: row.chunk_index as number,
            line_start: row.line_start as number,
            line_end: row.line_end as number,
            text_preview: row.text_preview,
            score,
            kind: row.kind,
            indexed_mtime_ms: row.indexed_mtime_ms,
            indexed_revision: row.indexed_revision as number
          }
        };
        ordinal += 1;
        if (heap.length < k) {
          heap.push(ranked);
          siftUp(heap.length - 1);
        } else if (heap[0] && compareWorstFirst(ranked, heap[0]) > 0) {
          heap[0] = ranked;
          siftDown();
        }
      }
      return heap
        .sort((left, right) => right.hit.score - left.hit.score || left.ordinal - right.ordinal)
        .map(({ hit }) => hit);
    });
    return search();
  }

  /** Total embedded chunks — used by stats / UI. */
  totalChunks(): number {
    const db = this.requireDb();
    const row = db.prepare("SELECT COUNT(*) AS n FROM embeddings").get<{ n: number }>();
    return row?.n ?? 0;
  }

  /**
   * Capture the cheap physical-generation identity from one SQLite snapshot.
   *
   * Unlike a full HNSW receipt this reads only the immutable instance UUID and
   * mutation epoch, so request-time callers can verify graph authority before
   * and after awaited filesystem validation without hashing every vector.
   *
   * @returns Exact database instance UUID and durable mutation epoch.
   * @throws {EmbedSnapshotIntegrityError} If either identity cell is malformed.
   * @example
   * ```ts
   * const before = db.captureGenerationIdentity();
   * // ... perform bounded read work ...
   * const after = db.captureGenerationIdentity();
   * ```
   */
  captureGenerationIdentity(): EmbedDbGenerationIdentity {
    const db = this.requireDb();
    const capture = db.transaction(() => captureEmbedDbGenerationIdentity(db));
    return capture();
  }

  /**
   * Capture one transactionally consistent, fully admitted HNSW receipt.
   *
   * Every configuration cell, quarantine marker, source receipt, row field,
   * and raw vector BLOB is read inside one synchronous better-sqlite3
   * transaction. A malformed non-quarantined row refuses the complete HNSW
   * snapshot instead of silently creating a partial-recall graph.
   *
   * @returns Exact database-generation receipt plus current label metadata.
   */
  captureHnswReceiptSnapshot(): HnswReceiptSnapshot {
    return this.captureHnswSnapshot("receipt");
  }

  /**
   * Capture the complete trusted authority needed to load a native HNSW graph.
   * Row metadata and DB-canonical decoded vectors come from the same synchronous
   * SQLite snapshot as the persistence receipt.
   *
   * @returns Exact receipt plus detached row and vector maps keyed by label.
   * @example
   * ```ts
   * const snapshot = db.captureHnswLoadSnapshot();
   * ```
   */
  captureHnswLoadSnapshot(): HnswLoadSnapshot {
    return this.captureHnswSnapshot("load");
  }

  /**
   * Capture HNSW build vectors and their receipt from one SQLite snapshot.
   *
   * @returns Exact receipt, label metadata, and detached decoded vectors.
   */
  captureHnswBuildSnapshot(): HnswBuildSnapshot {
    return this.captureHnswSnapshot("build");
  }

  /** Return the receipt portion of {@link captureHnswReceiptSnapshot}. */
  computeHnswPersistenceReceipt(): HnswPersistenceReceipt {
    return this.captureHnswReceiptSnapshot().receipt;
  }

  /**
   * Compute the legacy string-only HNSW staleness signature.
   *
   * @returns Signature from the same receipt-backed snapshot used by
   *   {@link computeHnswPersistenceReceipt}.
   */
  computeSignature(): string {
    return this.computeHnswPersistenceReceipt().signature;
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
    return this.captureHnswBuildSnapshot().vectors;
  }

  private captureHnswSnapshot(mode: "receipt"): HnswReceiptSnapshot;
  private captureHnswSnapshot(mode: "load"): HnswLoadSnapshot;
  private captureHnswSnapshot(mode: "build"): HnswBuildSnapshot;
  private captureHnswSnapshot(
    mode: "receipt" | "load" | "build"
  ): HnswReceiptSnapshot | HnswLoadSnapshot | HnswBuildSnapshot {
    const db = this.requireDb();
    const capture = db.transaction((): HnswReceiptSnapshot | HnswLoadSnapshot | HnswBuildSnapshot => {
      const metaRows = db
        .prepare("SELECT key, value FROM meta ORDER BY key LIMIT 8")
        .all<{ key: unknown; value: unknown }>();
      const meta = new Map<string, string>();
      for (const row of metaRows) {
        if (typeof row.key !== "string" || typeof row.value !== "string" || meta.has(row.key)) {
          throw new EmbedSnapshotIntegrityError(
            "Embedding index configuration is malformed during HNSW snapshot capture"
          );
        }
        meta.set(row.key, row.value);
      }
      if (
        metaRows.length !== 7 ||
        meta.get("schema_version") !== String(EMBED_DB_SCHEMA_VERSION) ||
        meta.get("vault_root") !== this.vaultRoot ||
        meta.get("model_alias") !== this.modelAlias ||
        meta.get("dim") !== String(this.dim) ||
        meta.get("quantization") !== this.quantization ||
        !EMBED_INSTANCE_UUID_PATTERN.test(meta.get("instance_uuid") ?? "") ||
        !isCanonicalMutationEpoch(meta.get("mutation_epoch"))
      ) {
        throw new EmbedSnapshotIntegrityError("Embedding index configuration changed before HNSW snapshot capture");
      }
      const dbInstanceUuid = meta.get("instance_uuid") as string;
      const dbMutationEpoch = Number(meta.get("mutation_epoch"));

      // Bound authority-table cardinality and UTF-8 path material before any
      // iterator exposes caller-controlled cells to JS or the receipt hashes.
      // Quarantined sources are deliberately included: exclusion from the
      // graph must not let a malformed quarantine/state manifest bypass the
      // snapshot resource envelope.
      const authorityEnvelope = db
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM source_quarantine) AS quarantine_count,
             (SELECT COALESCE(SUM(length(CAST(rel_path AS BLOB))), 0)
                FROM source_quarantine) AS quarantine_path_bytes,
             (SELECT COALESCE(MAX(length(CAST(rel_path AS BLOB))), 0)
                FROM source_quarantine) AS quarantine_max_path_bytes,
             (SELECT COALESCE(SUM(CASE
                WHEN typeof(rel_path) <> 'text'
                  OR length(CAST(rel_path AS BLOB)) NOT BETWEEN 1 AND ${MAX_HNSW_SNAPSHOT_PATH_BYTES}
                  OR typeof(kind) <> 'text' OR kind NOT IN ('md', 'pdf')
                THEN 1 ELSE 0 END), 0)
                FROM source_quarantine) AS quarantine_invalid_count,
             (SELECT COUNT(*) FROM source_state) AS state_count,
             (SELECT COALESCE(SUM(length(CAST(rel_path AS BLOB))), 0)
                FROM source_state) AS state_path_bytes,
             (SELECT COALESCE(MAX(length(CAST(rel_path AS BLOB))), 0)
                FROM source_state) AS state_max_path_bytes,
             (SELECT COALESCE(SUM(CASE
                WHEN typeof(rel_path) <> 'text'
                  OR length(CAST(rel_path AS BLOB)) NOT BETWEEN 1 AND ${MAX_HNSW_SNAPSHOT_PATH_BYTES}
                  OR typeof(kind) <> 'text' OR kind NOT IN ('md', 'pdf')
                  OR typeof(mtime_ms) NOT IN ('integer', 'real')
                  OR mtime_ms NOT BETWEEN -${MAX_SOURCE_REVISION} AND ${MAX_SOURCE_REVISION}
                  OR typeof(n_chunks) <> 'integer'
                  OR n_chunks NOT BETWEEN 1 AND ${MAX_HNSW_SNAPSHOT_ROWS}
                THEN 1 ELSE 0 END), 0)
                FROM source_state) AS state_invalid_count,
             (SELECT COUNT(*) FROM source_revision) AS revision_count,
             (SELECT COALESCE(SUM(length(CAST(rel_path AS BLOB))), 0)
                FROM source_revision) AS revision_path_bytes,
             (SELECT COALESCE(MAX(length(CAST(rel_path AS BLOB))), 0)
                FROM source_revision) AS revision_max_path_bytes,
             (SELECT COALESCE(SUM(CASE
                WHEN typeof(rel_path) <> 'text'
                  OR length(CAST(rel_path AS BLOB)) NOT BETWEEN 1 AND ${MAX_HNSW_SNAPSHOT_PATH_BYTES}
                  OR typeof(kind) <> 'text' OR kind NOT IN ('md', 'pdf')
                  OR typeof(revision) <> 'integer'
                  OR revision NOT BETWEEN 1 AND ${MAX_SOURCE_REVISION}
                THEN 1 ELSE 0 END), 0)
                FROM source_revision) AS revision_invalid_count`
        )
        .get<{
          quarantine_count: unknown;
          quarantine_path_bytes: unknown;
          quarantine_max_path_bytes: unknown;
          quarantine_invalid_count: unknown;
          state_count: unknown;
          state_path_bytes: unknown;
          state_max_path_bytes: unknown;
          state_invalid_count: unknown;
          revision_count: unknown;
          revision_path_bytes: unknown;
          revision_max_path_bytes: unknown;
          revision_invalid_count: unknown;
        }>();
      const authorityCounts = [
        authorityEnvelope?.quarantine_count,
        authorityEnvelope?.state_count,
        authorityEnvelope?.revision_count
      ];
      const authorityPathBytes = [
        authorityEnvelope?.quarantine_path_bytes,
        authorityEnvelope?.state_path_bytes,
        authorityEnvelope?.revision_path_bytes
      ];
      const authorityMaxPathBytes = [
        authorityEnvelope?.quarantine_max_path_bytes,
        authorityEnvelope?.state_max_path_bytes,
        authorityEnvelope?.revision_max_path_bytes
      ];
      const authorityInvalidCounts = [
        authorityEnvelope?.quarantine_invalid_count,
        authorityEnvelope?.state_invalid_count,
        authorityEnvelope?.revision_invalid_count
      ];
      if (
        !authorityEnvelope ||
        authorityCounts.some((value) => !Number.isSafeInteger(value) || (value as number) < 0) ||
        authorityPathBytes.some((value) => !Number.isSafeInteger(value) || (value as number) < 0) ||
        authorityMaxPathBytes.some((value) => !Number.isSafeInteger(value) || (value as number) < 0) ||
        authorityInvalidCounts.some((value) => value !== 0)
      ) {
        throw new EmbedSnapshotIntegrityError("Embedding authority manifests are malformed during HNSW capture");
      }
      if (
        authorityCounts.some((value) => (value as number) > MAX_HNSW_SNAPSHOT_ROWS) ||
        authorityPathBytes.some((value) => (value as number) > MAX_HNSW_SNAPSHOT_TEXT_BYTES) ||
        authorityMaxPathBytes.some((value) => (value as number) > MAX_HNSW_SNAPSHOT_PATH_BYTES)
      ) {
        throw new EmbedSnapshotCapacityError(
          "Embedding authority manifests exceed the bounded HNSW snapshot admission envelope"
        );
      }

      const liveLabelHash = createHash("sha256");
      liveLabelHash.update("enquire-hnsw-live-labels-v2;");
      const payloadHash = createHash("sha256");
      payloadHash.update("enquire-hnsw-db-payload-v2;");
      updateManifestValue(payloadHash, EMBED_DB_SCHEMA_VERSION);
      updateManifestValue(payloadHash, this.modelAlias);
      updateManifestValue(payloadHash, this.dim);
      updateManifestValue(payloadHash, this.quantization);

      const quarantineHash = createHash("sha256");
      quarantineHash.update("enquire-hnsw-quarantine-v2;");
      let quarantineCount = 0;
      for (const row of db
        .prepare("SELECT rel_path, kind FROM source_quarantine ORDER BY kind, rel_path")
        .iterate<{ rel_path: unknown; kind: unknown }>()) {
        if (
          typeof row.rel_path !== "string" ||
          row.rel_path.length === 0 ||
          (row.kind !== "md" && row.kind !== "pdf")
        ) {
          throw new EmbedSnapshotIntegrityError(
            "Embedding quarantine manifest is malformed during HNSW snapshot capture"
          );
        }
        quarantineCount += 1;
        updateManifestValue(quarantineHash, row.kind);
        updateManifestValue(quarantineHash, row.rel_path);
        payloadHash.update("quarantine;");
        updateManifestValue(payloadHash, row.kind);
        updateManifestValue(payloadHash, row.rel_path);
      }

      // A row-by-row validator alone cannot prove that the declared source
      // generation is complete: deleting one otherwise-valid chunk would
      // leave every surviving row admissible. Validate the live (that is,
      // non-quarantined) source-state envelope inside this same SQLite
      // snapshot before deriving a graph receipt. This binds HNSW admission to
      // the exact declared cardinality and contiguous 0..n-1 chunk range,
      // including sources whose physical embedding set vanished entirely.
      for (const state of db
        .prepare(
          `SELECT s.rel_path, s.kind, s.mtime_ms, s.n_chunks,
                  r.rel_path AS revision_rel_path, r.kind AS revision_kind,
                  r.revision,
                  COUNT(e.id) AS actual_count,
                  MIN(e.chunk_index) AS min_chunk_index,
                  MAX(e.chunk_index) AS max_chunk_index
           FROM source_state AS s
           LEFT JOIN source_quarantine AS q
             ON q.rel_path = s.rel_path AND q.kind = s.kind
           LEFT JOIN source_revision AS r
             ON r.rel_path = s.rel_path AND r.kind = s.kind
           LEFT JOIN embeddings AS e
             ON e.rel_path = s.rel_path AND e.kind = s.kind
           WHERE q.rel_path IS NULL
           GROUP BY s.rel_path, s.kind, s.mtime_ms, s.n_chunks,
                    r.rel_path, r.kind, r.revision
           ORDER BY s.kind, s.rel_path`
        )
        .iterate<{
          rel_path: unknown;
          kind: unknown;
          mtime_ms: unknown;
          n_chunks: unknown;
          revision_rel_path: unknown;
          revision_kind: unknown;
          revision: unknown;
          actual_count: unknown;
          min_chunk_index: unknown;
          max_chunk_index: unknown;
        }>()) {
        if (
          typeof state.rel_path !== "string" ||
          state.rel_path.length === 0 ||
          (state.kind !== "md" && state.kind !== "pdf") ||
          typeof state.mtime_ms !== "number" ||
          !Number.isFinite(state.mtime_ms) ||
          !Number.isSafeInteger(state.n_chunks) ||
          (state.n_chunks as number) < 1 ||
          state.revision_rel_path !== state.rel_path ||
          state.revision_kind !== state.kind ||
          !Number.isSafeInteger(state.revision) ||
          (state.revision as number) < 1 ||
          (state.revision as number) > MAX_SOURCE_REVISION ||
          !Number.isSafeInteger(state.actual_count) ||
          state.actual_count !== state.n_chunks ||
          state.min_chunk_index !== 0 ||
          state.max_chunk_index !== (state.n_chunks as number) - 1
        ) {
          throw new EmbedSnapshotIntegrityError("Embedding source state is incomplete during HNSW snapshot capture");
        }
        payloadHash.update("source-state;");
        updateManifestValue(payloadHash, state.kind);
        updateManifestValue(payloadHash, state.rel_path);
        updateManifestValue(payloadHash, state.mtime_ms);
        updateManifestValue(payloadHash, state.n_chunks as number);
        updateManifestValue(payloadHash, state.revision as number);
      }

      const aggregate = db
        .prepare(
          `SELECT COUNT(*) AS row_count,
                  COALESCE(SUM(
                    length(CAST(e.rel_path AS BLOB)) + length(CAST(e.text_preview AS BLOB))
                  ), 0) AS text_bytes,
                  COALESCE(MAX(length(CAST(e.rel_path AS BLOB))), 0) AS max_path_bytes,
                  COALESCE(MAX(length(CAST(e.text_preview AS BLOB))), 0) AS max_preview_bytes,
                  COALESCE(SUM(length(e.vector)), 0) AS vector_bytes,
                  COALESCE(SUM(
                    CASE WHEN typeof(e.vector) <> 'blob' OR length(e.vector) <> ? THEN 1 ELSE 0 END
                  ), 0) AS invalid_vector_count,
                  COALESCE(SUM(CASE
                    WHEN typeof(e.id) <> 'integer' OR e.id NOT BETWEEN 0 AND ${MAX_HNSW_NATIVE_LABEL}
                      OR typeof(e.rel_path) <> 'text'
                      OR length(CAST(e.rel_path AS BLOB)) NOT BETWEEN 1 AND ${MAX_HNSW_SNAPSHOT_PATH_BYTES}
                      OR typeof(e.chunk_index) <> 'integer' OR e.chunk_index < 0
                      OR typeof(e.line_start) <> 'integer' OR e.line_start < 1
                      OR typeof(e.line_end) <> 'integer' OR e.line_end < e.line_start
                      OR typeof(e.text_preview) <> 'text'
                      OR length(CAST(e.text_preview AS BLOB)) > ${MAX_HNSW_SNAPSHOT_PREVIEW_BYTES}
                      OR typeof(e.kind) <> 'text' OR e.kind NOT IN ('md', 'pdf')
                    THEN 1 ELSE 0 END), 0) AS invalid_scalar_count
           FROM embeddings AS e
           LEFT JOIN source_quarantine AS q
             ON q.rel_path = e.rel_path AND q.kind = e.kind
           WHERE q.rel_path IS NULL`
        )
        .get<{
          row_count: unknown;
          text_bytes: unknown;
          max_path_bytes: unknown;
          max_preview_bytes: unknown;
          vector_bytes: unknown;
          invalid_vector_count: unknown;
          invalid_scalar_count: unknown;
        }>(this.encodedBytes);
      if (
        !aggregate ||
        !Number.isSafeInteger(aggregate.row_count) ||
        (aggregate.row_count as number) < 0 ||
        !Number.isSafeInteger(aggregate.text_bytes) ||
        (aggregate.text_bytes as number) < 0 ||
        !Number.isSafeInteger(aggregate.max_path_bytes) ||
        (aggregate.max_path_bytes as number) < 0 ||
        !Number.isSafeInteger(aggregate.max_preview_bytes) ||
        (aggregate.max_preview_bytes as number) < 0 ||
        !Number.isSafeInteger(aggregate.vector_bytes) ||
        (aggregate.vector_bytes as number) < 0 ||
        aggregate.invalid_vector_count !== 0 ||
        aggregate.invalid_scalar_count !== 0 ||
        aggregate.vector_bytes !== (aggregate.row_count as number) * this.encodedBytes
      ) {
        throw new EmbedSnapshotIntegrityError("Embedding rows are malformed during HNSW snapshot admission");
      }

      const rowCount = aggregate.row_count as number;
      if (
        rowCount > MAX_HNSW_SNAPSHOT_ROWS ||
        (aggregate.text_bytes as number) > MAX_HNSW_SNAPSHOT_TEXT_BYTES ||
        (aggregate.max_path_bytes as number) > MAX_HNSW_SNAPSHOT_PATH_BYTES ||
        (aggregate.max_preview_bytes as number) > MAX_HNSW_SNAPSHOT_PREVIEW_BYTES
      ) {
        throw new EmbedSnapshotCapacityError(
          "Embedding rows exceed the bounded combined HNSW working-set admission envelope"
        );
      }
      const nativeCapacity = Math.max(HNSW_SNAPSHOT_MIN_NATIVE_CAPACITY, rowCount * 2);
      const nativeBytesPerElement =
        this.dim * 4 + HNSW_SNAPSHOT_DEFAULT_M * 2 * 4 + 4 + 8 + HNSW_SNAPSHOT_NATIVE_PER_ELEMENT_HEADROOM_BYTES;
      const authorityManifestPathBytes = authorityPathBytes.reduce<number>(
        (total, value) => total + (value as number),
        0
      );
      // One fail-closed envelope covers resources that coexist during an HNSW
      // boot: the worst admitted native capacity, all decoded Float32 vectors,
      // all encoded SQLite BLOB bytes, detached JS row/map metadata, bounded
      // text/path material, and fixed native/runtime headroom. Keeping each
      // component below an independent cap is insufficient because their sum
      // is the actual process working set.
      const combinedWorkingSetBytes =
        BigInt(HNSW_COMBINED_FIXED_HEADROOM_BYTES) +
        BigInt(nativeCapacity) * BigInt(nativeBytesPerElement) +
        // The caller-owned load snapshot and loadHnswFromDisk's detached
        // authority copy coexist across native preflight/readIndex.
        BigInt(rowCount) * BigInt(this.dim * 4) * 2n +
        BigInt(aggregate.vector_bytes as number) +
        // Build/load authority plus post-operation receipt recheck can keep
        // three detached metadata projections live at one boot boundary.
        BigInt(rowCount) * BigInt(HNSW_SNAPSHOT_METADATA_PER_ROW_BYTES) * 3n +
        // SQLite reports UTF-8 bytes; charge the three live row-text
        // projections, while authority paths retain the UTF-16 expansion
        // allowance used by their single manifest projection.
        BigInt(aggregate.text_bytes as number) * 3n +
        BigInt(authorityManifestPathBytes) * 2n;
      if (combinedWorkingSetBytes > BigInt(MAX_HNSW_COMBINED_WORKING_SET_BYTES)) {
        throw new EmbedSnapshotCapacityError(
          "Embedding rows exceed the bounded combined HNSW working-set admission envelope"
        );
      }

      const rowsByLabel = new Map<number, HnswPersistenceRow>();
      const vectorsByLabel = new Map<number, Float32Array>();
      const vectors: HnswBuildSnapshot["vectors"] = [];
      let maxLabel = 0;
      const rows = db
        .prepare(
          `SELECT e.id AS label, e.rel_path, e.chunk_index, e.line_start, e.line_end,
                  e.text_preview, e.vector, e.kind,
                  s.rel_path AS state_rel_path, s.kind AS state_kind,
                  s.mtime_ms AS indexed_mtime_ms,
                  r.rel_path AS revision_rel_path, r.kind AS revision_kind,
                  r.revision AS indexed_revision,
                  q.rel_path AS quarantine_rel_path
           FROM embeddings e
           LEFT JOIN source_state s ON s.rel_path = e.rel_path AND s.kind = e.kind
           LEFT JOIN source_revision r ON r.rel_path = e.rel_path AND r.kind = e.kind
           LEFT JOIN source_quarantine q ON q.rel_path = e.rel_path AND q.kind = e.kind
           WHERE q.rel_path IS NULL
           ORDER BY e.id`
        )
        .iterate<{
          label: unknown;
          rel_path: unknown;
          chunk_index: unknown;
          line_start: unknown;
          line_end: unknown;
          text_preview: unknown;
          vector: unknown;
          kind: unknown;
          state_rel_path: unknown;
          state_kind: unknown;
          indexed_mtime_ms: unknown;
          revision_rel_path: unknown;
          revision_kind: unknown;
          indexed_revision: unknown;
          quarantine_rel_path: unknown;
        }>();
      for (const row of rows) {
        if (
          !Number.isSafeInteger(row.label) ||
          (row.label as number) < 0 ||
          (row.label as number) > MAX_HNSW_NATIVE_LABEL ||
          rowsByLabel.has(row.label as number) ||
          typeof row.rel_path !== "string" ||
          row.rel_path.length === 0 ||
          (row.kind !== "md" && row.kind !== "pdf") ||
          row.state_rel_path !== row.rel_path ||
          row.state_kind !== row.kind ||
          row.revision_rel_path !== row.rel_path ||
          row.revision_kind !== row.kind ||
          typeof row.indexed_mtime_ms !== "number" ||
          !Number.isFinite(row.indexed_mtime_ms) ||
          !Number.isSafeInteger(row.indexed_revision) ||
          (row.indexed_revision as number) < 1 ||
          (row.indexed_revision as number) > MAX_SOURCE_REVISION ||
          !Number.isSafeInteger(row.chunk_index) ||
          (row.chunk_index as number) < 0 ||
          !Number.isSafeInteger(row.line_start) ||
          (row.line_start as number) < 1 ||
          !Number.isSafeInteger(row.line_end) ||
          (row.line_end as number) < (row.line_start as number) ||
          typeof row.text_preview !== "string" ||
          !Buffer.isBuffer(row.vector) ||
          row.vector.byteLength !== this.encodedBytes
        ) {
          throw new EmbedSnapshotIntegrityError("Embedding row is not admissible for a complete HNSW snapshot");
        }

        let vector: Float32Array;
        try {
          if (this.quantization === "int8") {
            const vMin = row.vector.readFloatLE(this.dim);
            const scale = row.vector.readFloatLE(this.dim + 4);
            if (!Number.isFinite(vMin) || !Number.isFinite(scale) || scale <= 0) {
              throw new Error("invalid quantization trailer");
            }
            vector = decodeInt8Vector(row.vector, this.dim);
          } else {
            vector = new Float32Array(this.dim);
            for (let index = 0; index < this.dim; index += 1) {
              vector[index] = row.vector.readFloatLE(index * 4);
            }
          }
        } catch {
          throw new EmbedSnapshotIntegrityError("Embedding vector cannot be decoded for HNSW snapshot capture");
        }
        const normSquared = vectorNormSquared(vector);
        if (
          !Number.isFinite(normSquared) ||
          normSquared < HNSW_VECTOR_NORM_SQUARED_MIN ||
          normSquared > HNSW_VECTOR_NORM_SQUARED_MAX
        ) {
          throw new EmbedSnapshotIntegrityError(
            "Embedding vector is not finite, non-zero, and normalized for HNSW snapshot capture"
          );
        }

        const label = row.label as number;
        const kind = row.kind as EmbedChunkKind;
        const metadata: HnswPersistenceRow = {
          rel_path: row.rel_path,
          chunk_index: row.chunk_index as number,
          line_start: row.line_start as number,
          line_end: row.line_end as number,
          text_preview: row.text_preview,
          kind
        };
        rowsByLabel.set(label, metadata);
        maxLabel = label;
        updateManifestValue(liveLabelHash, label);
        payloadHash.update("embedding;");
        updateManifestValue(payloadHash, label);
        updateManifestValue(payloadHash, metadata.rel_path);
        updateManifestValue(payloadHash, metadata.kind);
        updateManifestValue(payloadHash, metadata.chunk_index);
        updateManifestValue(payloadHash, metadata.line_start);
        updateManifestValue(payloadHash, metadata.line_end);
        updateManifestValue(payloadHash, metadata.text_preview);
        updateManifestValue(payloadHash, row.indexed_mtime_ms);
        updateManifestValue(payloadHash, row.indexed_revision as number);
        updateManifestValue(payloadHash, row.vector);
        if (mode === "load") vectorsByLabel.set(label, vector);
        if (mode === "build") vectors.push({ label, vector, ...metadata });
      }

      const liveLabelSha256 = liveLabelHash.digest("hex");
      const dbPayloadSha256 = payloadHash.digest("hex");
      const quarantineSuffix = quarantineCount > 0 ? `;quarantine=${quarantineHash.digest("hex")}` : "";
      const receipt: HnswPersistenceReceipt = {
        version: HNSW_RECEIPT_VERSION,
        signature:
          `instance=${dbInstanceUuid};epoch=${dbMutationEpoch};dim=${this.dim};rows=${rowsByLabel.size};` +
          `maxId=${maxLabel};model=${this.modelAlias};` +
          `quant=${this.quantization};embedSchema=${EMBED_DB_SCHEMA_VERSION};labels=${liveLabelSha256};` +
          `payload=${dbPayloadSha256}${quarantineSuffix}`,
        dbInstanceUuid,
        dbMutationEpoch,
        dim: this.dim,
        activeRows: rowsByLabel.size,
        maxLabel,
        liveLabelSha256,
        dbPayloadSha256
      };
      const snapshot: HnswReceiptSnapshot = { receipt, rowsByLabel };
      if (mode === "load") return { ...snapshot, vectorsByLabel };
      if (mode === "build") return { ...snapshot, vectors };
      return snapshot;
    });
    return capture();
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
 * file. `<dir>/<x>.embed.db` → `<dir>/<x>.hnsw`; the index writes immutable
 * `<base>.<nonce>.bin` generations and a stable `<base>.meta.json` pointer.
 *
 * SINGLE SOURCE OF TRUTH for the base so the WRITER (server.ts `persistFile`,
 * passed to `saveTo`/`loadHnswFromDisk`) and the ERASER ({@link EmbedDb.clearOnDisk})
 * can NEVER drift. If they computed the base independently and one changed (the
 * strip regex or the `.hnsw` suffix), `clear-embeddings` would leave the HNSW
 * sidecars on disk — historical format-2 metadata carried raw `text_preview`
 * and current native generations still contain reversible vector material,
 * so that remains a right-to-erasure gap (the rc.34 P-2 class). The
 * erasure-completeness invariant asserts both call sites route through this helper.
 *
 * @param embedDbFile - Configured embedding-database path.
 * @returns Same-directory HNSW persistence base for that exact path.
 * @throws {TypeError} If the configured path does not end exactly in `.embed.db`.
 * @example
 * hnswPersistBase("/tmp/aaaaaaaaaaaa.embed.db"); // "/tmp/aaaaaaaaaaaa.hnsw"
 */
export function hnswPersistBase(embedDbFile: string): string {
  return `${embedDbFileStem(embedDbFile)}.hnsw`;
}

/**
 * Database-content-non-mutating authority check over an existing embedding
 * database. Opening and closing do publish then remove private persistence
 * coordination markers; the configured SQLite family remains read-only.
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
   * Close the read-only SQLite handle and begin releasing its exact shared
   * semantic-family lifetime. Idempotent. Release rejection is observed
   * internally and retained by the persistence debt registry; callers that
   * need teardown completion or an explicit retry use {@link closeAndRelease}.
   *
   * @returns Nothing.
   * @example
   * ```ts
   * reader.close();
   * ```
   */
  close(): void;
  /**
   * Close SQLite and await exact shared-lifetime release. A failed release
   * remains retryable through a later invocation against the same ownership
   * handle.
   *
   * @returns After both the native handle and shared lease are released.
   * @example
   * ```ts
   * await reader.closeAndRelease();
   * ```
   */
  closeAndRelease(): Promise<void>;
}

/**
 * Open an existing embedding database strictly read-only for final receipt
 * validation. This function never bootstraps, rebuilds, migrates, or writes the
 * configured SQLite family: missing files and legacy/incompatible authority
 * schemas are rejected. It does hold private shared coordination markers for
 * the reader lifetime. The main/WAL/SHM/rollback-journal family is checked
 * before dependency loading and again immediately before native open; every
 * present leaf must be a singly linked regular file and the main must exist.
 *
 * @param file Absolute path to an existing `.embed.db` file.
 * @param expectedVaultRoot Exact vault root the database must declare.
 * @returns A synchronous receipt validator backed by a read-only SQLite handle.
 * @throws {TypeError} If `file` is outside the exact `.embed.db` namespace;
 *   this is checked before dependency loading or filesystem I/O.
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
  assertEmbedDbFilePath(file);
  let db: Db | null = null;
  let lifetime: PersistenceFamilyLeaseHandle | null = null;
  try {
    if (!(await preflightSqliteArtifactFamily(file))) throw new Error("missing embedding receipt database");
    lifetime = await acquirePersistenceFamilyLease({
      targetPath: file,
      familyKey: SEMANTIC_PERSISTENCE_FAMILY_KEY,
      role: "shared"
    });
    file = embedDbPathInSemanticScopes(lifetime.scopes);
    const Ctor = await loadBetterSqlite();
    if (!(await preflightSqliteArtifactFamily(file))) throw new Error("missing embedding receipt database");
    db = new Ctor(file, { readonly: true, fileMustExist: true }) as Db;
    const admission = inspectEmbedAdmission(db, expectedVaultRoot);
    if (admission.kind !== "owned" || admission.meta.schema_version !== String(EMBED_DB_SCHEMA_VERSION)) {
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
    const activeLifetime = lifetime;
    let lifetimeReleased = false;
    let releaseAttempt: Promise<void> | null = null;
    db = null;
    lifetime = null;

    const releaseLifetime = (): Promise<void> => {
      if (lifetimeReleased) return Promise.resolve();
      if (releaseAttempt) return releaseAttempt;
      const attempt = activeLifetime.release();
      const tracked = attempt.then(
        () => {
          lifetimeReleased = true;
          if (releaseAttempt === tracked) releaseAttempt = null;
        },
        (error: unknown) => {
          if (releaseAttempt === tracked) releaseAttempt = null;
          throw error;
        }
      );
      releaseAttempt = tracked;
      // `close()` is intentionally synchronous for terminal egress paths.
      // Observe a failed background release while the lease layer retains its
      // exact retryable ownership debt for `closeAndRelease()` or shutdown.
      void tracked.catch(() => {});
      return tracked;
    };

    const closeDb = (): void => {
      const closingDb = activeDb;
      activeDb = null;
      closingDb?.close();
    };

    const closeAndRelease = async (): Promise<void> => {
      const errors: unknown[] = [];
      try {
        closeDb();
      } catch (error) {
        errors.push(error);
      }
      try {
        await releaseLifetime();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(errors, "Embedding receipt reader close and persistence release both failed");
      }
    };

    return {
      isCurrentSourceReceipt(relPath, kind, indexedMtimeMs, indexedRevision) {
        return activeDb ? currentSourceReceipt(activeDb, relPath, kind, indexedMtimeMs, indexedRevision) : false;
      },
      currentSourceReceiptMask(receipts) {
        return activeDb ? currentSourceReceiptMaskFromDb(activeDb, receipts) : receipts.map(() => false);
      },
      close() {
        let closeError: unknown;
        try {
          closeDb();
        } catch (error) {
          closeError = error;
        }
        void releaseLifetime();
        if (closeError !== undefined) throw closeError;
      },
      closeAndRelease
    };
  } catch (openError) {
    // Ownership and debt-capacity are specialized IntegrityErrors, but they
    // carry current-process cleanup authority or a latched capacity refusal
    // that must remain visible to the caller. Only an ordinary untrusted-
    // namespace IntegrityError is laundered into the path-free compatibility
    // diagnostic used by this read-only admission boundary.
    const passthroughOpenError =
      openError instanceof PersistenceLeaseOwnershipError ||
      openError instanceof PersistenceLeaseDebtCapacityError ||
      (openError instanceof PersistenceLeaseError && !(openError instanceof PersistenceLeaseIntegrityError))
        ? openError
        : null;
    const rollbackErrors: unknown[] = [];
    try {
      db?.close();
    } catch (error) {
      rollbackErrors.push(error);
    }
    try {
      await lifetime?.release();
    } catch (error) {
      rollbackErrors.push(error);
    }
    if (rollbackErrors.length > 0) {
      const stableOpenError =
        passthroughOpenError ??
        new Error("Embedding receipt reader requires an existing compatible index for the expected vault");
      throw new AggregateError(
        [stableOpenError, ...rollbackErrors],
        "Embedding receipt reader open failed and coordinated rollback was incomplete"
      );
    }
    if (passthroughOpenError) throw passthroughOpenError;
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

function sameOwnedEmbedMeta(left: Readonly<EmbedDbOwnedMeta>, right: Readonly<EmbedDbOwnedMeta>): boolean {
  return (
    left.schema_version === right.schema_version &&
    left.vault_root === right.vault_root &&
    left.model_alias === right.model_alias &&
    left.dim === right.dim &&
    left.quantization === right.quantization &&
    left.instance_uuid === right.instance_uuid &&
    left.mutation_epoch === right.mutation_epoch
  );
}

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
    const instanceUuid = meta?.instance_uuid;
    const mutationEpoch = meta?.mutation_epoch;
    if (
      kind === "owned" &&
      typeof schemaVersion === "string" &&
      typeof vaultRoot === "string" &&
      typeof modelAlias === "string" &&
      typeof dim === "string" &&
      (quantization === undefined || quantization === "f32" || quantization === "int8") &&
      (instanceUuid === undefined || typeof instanceUuid === "string") &&
      (mutationEpoch === undefined || typeof mutationEpoch === "string")
    ) {
      return Object.freeze({
        kind: "owned",
        meta: Object.freeze({
          schema_version: schemaVersion,
          vault_root: vaultRoot,
          model_alias: modelAlias,
          dim,
          ...(quantization === undefined ? {} : { quantization }),
          ...(instanceUuid === undefined ? {} : { instance_uuid: instanceUuid }),
          ...(mutationEpoch === undefined ? {} : { mutation_epoch: mutationEpoch })
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
      expected.meta.quantization === admission.meta.quantization &&
      expected.meta.instance_uuid === admission.meta.instance_uuid &&
      expected.meta.mutation_epoch === admission.meta.mutation_epoch);
  if (!matches) throw new Error(EMBED_DISCOVERY_CHANGED_ERROR);
}

/**
 * Discover whether an embedding database is missing, exactly schema-empty,
 * fully owned by the expected vault, or refused. Existing files are opened
 * through a read-only handle and inspected with the same bounded
 * class/schema/root admission used by `EmbedDb.open()`. Open, read, dependency,
 * and close failures collapse to `refused`; this function does not throw
 * expected discovery errors. SQLite/VFS lock, recovery, and WAL/SHM
 * bookkeeping remain outside this logical guarantee. The complete main/WAL/
 * SHM/rollback-journal family is checked before dependency loading and again
 * immediately before native open; unsafe, hardlinked, or orphaned leaves
 * collapse to `refused` under the stable-parent boundary.
 *
 * This is a bounded pre-open configuration snapshot. Pass it to
 * {@link EmbedDb.open} to bind the mutating open to that observed state; open
 * independently repeats admission on its own live handle and again inside its
 * immediate transaction.
 *
 * @param file - Absolute path to the candidate embedding database.
 * @param expectedVaultRoot - Exact vault root allowed to own a populated file.
 * @returns A discriminated, path-free discovery result. Only `owned` carries metadata.
 * @throws {TypeError} If `file` does not end exactly in `.embed.db`; expected
 *   discovery failures are fail-soft only after this pure namespace admission.
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
  assertEmbedDbFilePath(file);
  let fileExisted: boolean;
  try {
    fileExisted = await preflightSqliteArtifactFamily(file);
  } catch {
    return { kind: "refused" };
  }
  if (!fileExisted) return { kind: "missing" };

  let Ctor: BetterSqliteConstructor;
  try {
    Ctor = await loadBetterSqlite();
  } catch {
    return { kind: "refused" };
  }

  let db: Db | null = null;
  let discovery: EmbedDbConfigDiscovery = { kind: "refused" };
  try {
    if (!(await preflightSqliteArtifactFamily(file))) return { kind: "missing" };
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

function pragmaJournalMode(value: unknown): string | null {
  if (!Array.isArray(value) || value.length !== 1) return null;
  const row = value[0];
  if (typeof row !== "object" || row === null || Array.isArray(row)) return null;
  const mode = (row as Record<string, unknown>).journal_mode;
  return typeof mode === "string" ? mode.toLowerCase() : null;
}

function checkpointWasComplete(value: unknown): boolean {
  if (!Array.isArray(value) || value.length !== 1) return false;
  const row = value[0];
  if (typeof row !== "object" || row === null || Array.isArray(row)) return false;
  const busy = (row as Record<string, unknown>).busy;
  const log = (row as Record<string, unknown>).log;
  const checkpointed = (row as Record<string, unknown>).checkpointed;
  return (
    typeof busy === "number" &&
    typeof log === "number" &&
    typeof checkpointed === "number" &&
    Number.isSafeInteger(busy) &&
    Number.isSafeInteger(log) &&
    Number.isSafeInteger(checkpointed) &&
    busy === 0 &&
    log >= 0 &&
    checkpointed === log
  );
}

function checkpointOpenEmbedDbForReplacement(db: Db): void {
  const currentMode = pragmaJournalMode(db.pragma("journal_mode"));
  if (currentMode === null) throw new Error("Embedding index journal mode could not be verified");
  if (currentMode === "wal" && !checkpointWasComplete(db.pragma("wal_checkpoint(TRUNCATE)"))) {
    throw new Error("Embedding index WAL could not be checkpointed completely");
  }
  if (pragmaJournalMode(db.pragma("journal_mode = DELETE")) !== "delete") {
    throw new Error("Embedding index could not enter standalone journal mode");
  }
}

async function assertStandaloneSqliteMain(file: string): Promise<void> {
  if (!(await preflightSqliteArtifactFamily(file))) {
    throw new Error("Embedding index disappeared while preparing replacement");
  }
  for (const sidecar of [`${file}-wal`, `${file}-shm`, `${file}-journal`]) {
    try {
      await fs.lstat(sidecar);
    } catch (error) {
      if (errnoCode(error) === "ENOENT") continue;
      throw new Error("Embedding index sidecar state could not be verified before replacement", { cause: error });
    }
    throw new Error("Embedding index is not a standalone SQLite generation for replacement");
  }
}

/**
 * Checkpoint an existing owned EmbedDb into one self-contained main file while
 * the caller holds the exact semantic-family eraser. This operation never runs
 * schema bootstrap or changes model/vector metadata: it only drains an admitted
 * WAL and switches SQLite to DELETE journaling so a later atomic main-file
 * replacement cannot inherit stale WAL/SHM bytes.
 *
 * The expected discovery is re-proved on the same writable handle before the
 * checkpoint and again after close. A watcher mutation during a long staged
 * rebuild therefore refuses promotion instead of replacing the newer live
 * generation.
 *
 * @param expectedVaultRoot - Exact canonical vault root allowed to own it.
 * @param expectedDiscovery - Owned generation observed before staged work began.
 * @param eraser - Active exclusive semantic-family capability.
 * @returns After the unchanged logical generation is standalone and re-admitted.
 * @throws If authority changed, checkpointing was busy/incomplete, sidecars
 *   remain, or the capability does not bind the requested target.
 * @example
 * ```ts
 * await withSemanticPersistenceEraser(file, undefined, async (eraser) => {
 *   await checkpointEmbedDbForReplacement(vaultRoot, discovery, eraser);
 * });
 * ```
 * @internal
 */
export async function checkpointEmbedDbForReplacement(
  expectedVaultRoot: string,
  expectedDiscovery: EmbedDbConfigDiscovery,
  eraser: ActiveSemanticPersistenceEraser
): Promise<void> {
  const expected = cloneEmbedDbOpenDiscovery(expectedDiscovery);
  if (expected?.kind !== "owned") {
    throw new Error("Embedding replacement requires one previously owned generation");
  }
  const scopes = scopesFromActiveSemanticEraser(eraser);
  const canonicalFile = embedDbPathInSemanticScopes(scopes);
  await revalidatePersistenceLeaseScope(scopes.namespace);
  await revalidatePersistenceLeaseScope(scopes.family);
  if (!(await preflightSqliteArtifactFamily(canonicalFile))) {
    throw new Error("Embedding index configuration changed before replacement");
  }

  const Ctor = await loadBetterSqlite();
  let db: Db | null = null;
  let operationError: unknown;
  try {
    if (!(await preflightSqliteArtifactFamily(canonicalFile))) {
      throw new Error("Embedding index configuration changed before replacement");
    }
    db = new Ctor(canonicalFile, { fileMustExist: true }) as Db;
    const admission = inspectEmbedAdmission(db, expectedVaultRoot);
    assertEmbedAdmission(admission);
    assertExpectedEmbedDiscovery(expected, true, admission);
    checkpointOpenEmbedDbForReplacement(db);
  } catch (error) {
    operationError = error;
  }
  let closeError: unknown;
  try {
    db?.close();
  } catch (error) {
    closeError = error;
  }
  if (operationError !== undefined && closeError !== undefined) {
    throw new AggregateError(
      [operationError, closeError],
      "Embedding replacement checkpoint failed and its SQLite handle did not close"
    );
  }
  if (operationError !== undefined) throw operationError;
  if (closeError !== undefined) throw closeError;

  await assertStandaloneSqliteMain(canonicalFile);
  await revalidatePersistenceLeaseScope(scopes.namespace);
  await revalidatePersistenceLeaseScope(scopes.family);
  const after = await discoverEmbedDbConfig(canonicalFile, expectedVaultRoot);
  if (after.kind !== "owned" || !sameOwnedEmbedMeta(expected.meta, after.meta)) {
    throw new Error("Embedding index configuration changed while preparing replacement");
  }
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
 * @throws {TypeError} If `file` does not end exactly in `.embed.db`.
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
 * malformed rows and query failures collapse to `null` after exact namespace
 * admission. An invalid suffix throws before I/O. A close failure never escapes;
 * this legacy diagnostic may still return metadata already read. The complete
 * main/WAL/SHM/rollback-journal family receives the same two-stage singly
 * linked regular-file preflight as production discovery; an unsafe or orphaned
 * leaf returns `null` before native open.
 *
 * @param file - Absolute path to a `.embed.db` file.
 * @param expectedVaultRoot - Optional exact root plus full-class filter for
 *   configuration discovery. Omit only for bounded raw diagnostics.
 * @returns Bounded metadata when readable and root-compatible, otherwise `null`.
 * @throws {TypeError} If `file` does not end exactly in `.embed.db`.
 * @example
 * ```ts
 * const meta = await peekEmbedDbMeta(embedFile, canonicalVaultRoot);
 * console.log(meta?.schema_version); // diagnostic only
 * ```
 */
export async function peekEmbedDbMeta(file: string, expectedVaultRoot?: string): Promise<PeekEmbedDbMetaResult> {
  assertEmbedDbFilePath(file);
  try {
    if (!(await preflightSqliteArtifactFamily(file))) return null;
  } catch {
    return null;
  }
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
    if (!(await preflightSqliteArtifactFamily(file))) return null;
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
 * @throws {TypeError} If `file` does not end exactly in `.embed.db`.
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
  assertEmbedDbFilePath(file);
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
 * @throws {TypeError} If `file` does not end exactly in `.embed.db`.
 * @example
 * ```ts
 * const meta = await peekEmbedDbMetaCached(embedFile, canonicalVaultRoot);
 * ```
 */
export async function peekEmbedDbMetaCached(file: string, expectedVaultRoot?: string): Promise<PeekEmbedDbMetaResult> {
  assertEmbedDbFilePath(file);
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
