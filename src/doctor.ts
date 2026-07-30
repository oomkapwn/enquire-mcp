// Tier-aware, source-state-preserving project health diagnostics for enquire-mcp.
//
// `doctor` classifies prerequisites for basic, hybrid, or hybrid-live and
// returns structured checks plus a tier-relative readiness verdict. SQLite
// sources are copied into memory and inspected there: the diagnostic never
// invokes migration-capable index openers and never lets SQLite touch a source
// path. Readiness is structural/runtime capability, not proof that an index is
// fresh or that every current vault document was indexed.

import { Buffer } from "node:buffer";
import { constants, type Dirent, promises as fs, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import * as path from "node:path";
import {
  DEFAULT_MODEL_ALIAS,
  DEFAULT_RERANKER_ALIAS,
  EMBEDDING_MODELS,
  type EmbeddingModel,
  type RerankerModel,
  resolveModel,
  resolveRerankerModel,
  resolveTransformersCacheDir
} from "./embeddings.js";
import { defaultIndexFile, type TokenizeMode } from "./fts5.js";
import { buildPrivacyArgs, CONFIG_TIERS, type ConfigTier, isConfigTier, shellQuote } from "./mcp-config.js";
import { EMBED_DB_SCHEMA_VERSION, FTS_SCHEMA_VERSION } from "./schema-contract.js";
import { Vault } from "./vault.js";
import { watcherActivationGuardPath } from "./watcher-activation-guard.js";

/** Severity buckets surfaced in the diagnostic UI. */
export type CheckStatus = "ok" | "warn" | "missing" | "error" | "unverified";

/** Capability profile whose prerequisites `doctor` evaluates. */
export type DoctorTier = ConfigTier;

/** One independently actionable diagnostic result. */
export interface DoctorCheck {
  /** Stable id for programmatic consumers (e.g. JSON output). */
  id: string;
  /** Human-readable label (rendered next to the status icon). */
  label: string;
  /** Tier-aware result severity. */
  status: CheckStatus;
  /** Whether this check blocks readiness for the selected tier. */
  required: boolean;
  /** Optional detail line printed below the label. */
  detail?: string;
  /** Optional hint — usually the command that fixes it. */
  hint?: string;
}

/** Complete machine-readable result returned by {@link runDoctor}. */
export interface DoctorResult {
  /** Vault path as supplied by the caller. */
  vault: string;
  /** Capability profile evaluated by this run. */
  tier: DoctorTier;
  /** Readiness is limited to structural/runtime prerequisites. */
  scope: "structural-runtime";
  /** Important properties this diagnostic deliberately cannot certify. */
  limitations: string[];
  /** True iff every check required by the selected tier has status `ok`. */
  ready: boolean;
  /** Ordered diagnostic checks. */
  checks: DoctorCheck[];
  /** Tally for quick consumer reporting. */
  summary: { ok: number; warn: number; missing: number; error: number; unverified: number };
}

/** Simple ANSI color helpers — autodetect TTY so piped output stays clean. */
const isTty = process.stdout.isTTY === true;
const c = {
  green: (s: string) => (isTty ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: (s: string) => (isTty ? `\x1b[33m${s}\x1b[0m` : s),
  red: (s: string) => (isTty ? `\x1b[31m${s}\x1b[0m` : s),
  dim: (s: string) => (isTty ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s: string) => (isTty ? `\x1b[1m${s}\x1b[0m` : s)
};

/** Render one DoctorCheck to a multi-line string. */
export function formatCheck(check: DoctorCheck): string {
  const icon =
    check.status === "ok"
      ? c.green("✓")
      : check.status === "warn"
        ? c.yellow("⚠")
        : check.status === "missing"
          ? c.red("✗")
          : check.status === "unverified"
            ? c.yellow("?")
            : c.red("✗");
  const lines: string[] = [`${icon}  ${check.label}`];
  if (check.detail) lines.push(c.dim(`   ${check.detail}`));
  if (check.hint && check.status !== "ok") lines.push(c.dim(`   → ${check.hint}`));
  return lines.join("\n");
}

/** Render a full DoctorResult to a banner string. */
export function formatDoctorResult(result: DoctorResult): string {
  const lines: string[] = [];
  lines.push(c.bold(`enquire-mcp doctor (${result.tier}) — ${result.vault}`));
  lines.push("");
  for (const check of result.checks) lines.push(formatCheck(check));
  lines.push("");
  const { ok, warn, missing, error, unverified } = result.summary;
  const verdict = result.ready
    ? c.green(
        `READY for ${result.tier} — all required checks pass (${ok} ok, ${unverified} unverified, ${warn} warnings)`
      )
    : c.red(
        `NOT READY for ${result.tier} — ${missing + error} missing/error, ${unverified} unverified, ${warn} warnings, ${ok} ok`
      );
  lines.push(verdict);
  lines.push(c.dim(`Scope: ${result.scope}; does not verify ${result.limitations.join(", ")}.`));
  return lines.join("\n");
}

/**
 * Resolve the cache root that this installed transformers.js instance actually
 * uses. Legacy Hugging Face Python paths and unrelated cwd copies are excluded:
 * finding weights where the runtime will never read them would be a false READY.
 *
 * @returns Zero or one runtime cache roots.
 */
export function candidateModelCacheRoots(): string[] {
  const pkgCache = resolveTransformersCacheDir();
  return pkgCache ? [pkgCache] : [];
}

/**
 * Default `.embed.db` location for a given vault root — same convention as
 * the rest of the codebase. Mirrors `embedDbPath` in src/index.ts.
 */
function defaultEmbedDbFile(vaultRoot: string): string {
  return defaultIndexFile(vaultRoot).replace(/\.fts5\.db$/, ".embed.db");
}

const MAX_SQLITE_SNAPSHOT_BYTES = 256 * 1024 * 1024;
const MAX_MODEL_CACHE_ENTRIES = 4096;

/**
 * Probe whether an optional dep is loadable in this process. Uses a
 * dynamic import inside a try/catch so we never crash the diagnostic
 * on a missing or broken native binding.
 */
async function probeOptionalDep(spec: string): Promise<boolean> {
  try {
    const mod = await import(spec);
    if (spec === "better-sqlite3") {
      const Database = (mod as { default?: new (file: string) => SnapshotDb }).default;
      if (!Database) return false;
      const db = new Database(":memory:");
      try {
        const row = db.prepare("SELECT 1 AS ok").get() as { ok?: unknown } | undefined;
        return row?.ok === 1;
      } finally {
        db.close();
      }
    }
    if (spec === "@huggingface/transformers") {
      const shaped = mod as {
        pipeline?: unknown;
        AutoTokenizer?: { from_pretrained?: unknown };
        AutoModelForSequenceClassification?: { from_pretrained?: unknown };
      };
      return (
        typeof shaped.pipeline === "function" &&
        typeof shaped.AutoTokenizer?.from_pretrained === "function" &&
        typeof shaped.AutoModelForSequenceClassification?.from_pretrained === "function"
      );
    }
    if (spec === "hnswlib-node") {
      const direct = mod as { HierarchicalNSW?: unknown; default?: unknown };
      const nested =
        typeof direct.default === "object" && direct.default !== null
          ? (direct.default as { HierarchicalNSW?: unknown })
          : undefined;
      return typeof (direct.HierarchicalNSW ?? nested?.HierarchicalNSW) === "function";
    }
    if (spec === "pdfjs-dist/legacy/build/pdf.mjs") {
      return typeof (mod as { getDocument?: unknown }).getDocument === "function";
    }
    if (spec === "tesseract.js") {
      return typeof (mod as { createWorker?: unknown }).createWorker === "function";
    }
    if (spec === "@napi-rs/canvas") {
      return typeof (mod as { createCanvas?: unknown }).createCanvas === "function";
    }
    return true;
  } catch {
    return false;
  }
}

type DependencyProbe = (specifier: string) => Promise<boolean>;

interface SnapshotDb {
  prepare(sql: string): {
    all(): unknown[];
    get(...params: unknown[]): unknown;
  };
  pragma(query: string): unknown;
  close(): void;
}

interface SnapshotDatabaseConstructor {
  new (source: Buffer, options?: { readonly?: boolean }): SnapshotDb;
}

interface TableColumnInfo {
  name?: unknown;
  type?: unknown;
  notnull?: unknown;
  pk?: unknown;
}

interface SourceVersion {
  isFile: boolean;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: number;
  dev: number;
  mode: number;
  uid: number;
  gid: number;
  walSize: number | null;
  shmSize: number | null;
  journalSize: number | null;
}

type SnapshotResult<T> =
  | { ok: true; value: T; bytes: number }
  | { ok: false; kind: "missing" | "invalid" | "unverified"; issue: string };

interface FtsSnapshot {
  schemaVersion?: string;
  vaultRoot?: string;
  tokenizeMode?: TokenizeMode;
  totalFiles: number;
  totalChunks: number;
}

interface EmbedSnapshot {
  schemaVersion?: string;
  vaultRoot?: string;
  modelAlias?: string;
  dim?: string;
  quantization?: string;
  totalFiles: number;
  totalChunks: number;
}

interface ModelCacheInspection {
  root: string;
  files: number;
  bytes: number;
  complete: boolean;
  missingArtifacts: string[];
  issue?: string;
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT"
  );
}

async function optionalFileSize(file: string): Promise<number | null> {
  try {
    return (await fs.stat(file)).size;
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw error;
  }
}

async function captureSourceVersion(file: string): Promise<SourceVersion> {
  const stat = await fs.stat(file);
  return sourceVersionFromStat(file, stat);
}

async function captureOpenedSourceVersion(file: string, handle: FileHandle): Promise<SourceVersion> {
  const stat = await handle.stat();
  return sourceVersionFromStat(file, stat);
}

async function sourceVersionFromStat(file: string, stat: Stats): Promise<SourceVersion> {
  const [walSize, shmSize, journalSize] = await Promise.all([
    optionalFileSize(`${file}-wal`),
    optionalFileSize(`${file}-shm`),
    optionalFileSize(`${file}-journal`)
  ]);
  return {
    isFile: stat.isFile(),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    ino: stat.ino,
    dev: stat.dev,
    mode: stat.mode,
    uid: stat.uid,
    gid: stat.gid,
    walSize,
    shmSize,
    journalSize
  };
}

function sameSourceVersion(left: SourceVersion, right: SourceVersion): boolean {
  return (
    left.isFile === right.isFile &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.ino === right.ino &&
    left.dev === right.dev &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.walSize === right.walSize &&
    left.shmSize === right.shmSize &&
    left.journalSize === right.journalSize
  );
}

/**
 * Inspect a SQLite database from an in-memory byte snapshot.
 *
 * `better-sqlite3({readonly:true})` is not sufficient here: opening a WAL-mode
 * database can create `-wal`/`-shm` beside the source file. We instead read the
 * main database bytes, reject active WAL/rollback-journal state, convert the
 * cloned header to rollback mode, deserialize it into memory, and enable
 * SQLite `query_only` before running fixed read queries. The source database
 * and its directory are never opened by SQLite.
 */
async function inspectSqliteSnapshot<T>(file: string, inspect: (db: SnapshotDb) => T): Promise<SnapshotResult<T>> {
  let sourceFile: string;
  try {
    sourceFile = await fs.realpath(file);
  } catch (error) {
    return {
      ok: false,
      kind: isMissingPathError(error) ? "missing" : "unverified",
      issue: isMissingPathError(error)
        ? "file does not exist"
        : `cannot resolve file: ${error instanceof Error ? error.message : String(error)}`
    };
  }

  let before: SourceVersion;
  try {
    before = await captureSourceVersion(sourceFile);
  } catch (error) {
    return {
      ok: false,
      kind: isMissingPathError(error) ? "missing" : "unverified",
      issue: isMissingPathError(error)
        ? "file does not exist"
        : `cannot stat file: ${error instanceof Error ? error.message : String(error)}`
    };
  }
  if (!before.isFile) {
    return {
      ok: false,
      kind: "unverified",
      issue: "snapshot source is not a regular file"
    };
  }
  if (before.size > MAX_SQLITE_SNAPSHOT_BYTES) {
    return {
      ok: false,
      kind: "unverified",
      issue: `file is ${Math.round(before.size / 1024 / 1024)} MB; immutable inspection is capped at ${
        MAX_SQLITE_SNAPSHOT_BYTES / 1024 / 1024
      } MB`
    };
  }
  if ((before.walSize ?? 0) > 0 || (before.journalSize ?? 0) > 0) {
    return {
      ok: false,
      kind: "unverified",
      issue: "active SQLite WAL/journal state prevents a side-effect-free snapshot; stop active writers and retry"
    };
  }

  let sourceBytes: Buffer | undefined;
  let handle: FileHandle | null = null;
  try {
    // O_NONBLOCK prevents a path-replacement race from hanging on a FIFO.
    // The opened descriptor is then re-validated as the same regular inode.
    handle = await fs.open(sourceFile, constants.O_RDONLY | constants.O_NONBLOCK);
    const openedBefore = await captureOpenedSourceVersion(sourceFile, handle);
    if (!openedBefore.isFile || !sameSourceVersion(before, openedBefore)) {
      return {
        ok: false,
        kind: "unverified",
        issue: "file changed before its bounded snapshot could be read; retry after active writers stop"
      };
    }
    if (openedBefore.size > MAX_SQLITE_SNAPSHOT_BYTES) {
      return {
        ok: false,
        kind: "unverified",
        issue: `file is ${Math.round(openedBefore.size / 1024 / 1024)} MB; immutable inspection is capped at ${
          MAX_SQLITE_SNAPSHOT_BYTES / 1024 / 1024
        } MB`
      };
    }

    sourceBytes = Buffer.allocUnsafe(openedBefore.size);
    let offset = 0;
    while (offset < sourceBytes.length) {
      const { bytesRead } = await handle.read(sourceBytes, offset, sourceBytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const [openedAfter, pathAfter] = await Promise.all([
      captureOpenedSourceVersion(sourceFile, handle),
      captureSourceVersion(sourceFile)
    ]);
    if (
      offset !== sourceBytes.length ||
      !sameSourceVersion(openedBefore, openedAfter) ||
      !sameSourceVersion(openedBefore, pathAfter)
    ) {
      return {
        ok: false,
        kind: "unverified",
        issue: "file changed while it was being inspected; retry after active writers stop"
      };
    }
  } catch (error) {
    return {
      ok: false,
      kind: "unverified",
      issue: `cannot read a stable snapshot: ${error instanceof Error ? error.message : String(error)}`
    };
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }

  if (!sourceBytes) {
    return { ok: false, kind: "unverified", issue: "bounded snapshot read returned no data" };
  }
  if (sourceBytes.length < 100 || sourceBytes.subarray(0, 16).toString("binary") !== "SQLite format 3\u0000") {
    return { ok: false, kind: "invalid", issue: "file is not a valid SQLite database" };
  }

  // SQLite stores WAL read/write mode in header bytes 18/19. Deserializing a
  // WAL-marked buffer without a filesystem path fails because there is nowhere
  // to open shared memory. The bounded descriptor read returned a private
  // in-memory buffer, so mutate that copy directly; better-sqlite3 makes its own
  // deserialization copy. Avoiding a redundant Buffer.from keeps the bounded
  // 256 MB path to two full copies instead of three.
  if (sourceBytes[18] === 2) sourceBytes[18] = 1;
  if (sourceBytes[19] === 2) sourceBytes[19] = 1;

  let Database: SnapshotDatabaseConstructor;
  try {
    const mod = await import("better-sqlite3");
    Database = mod.default as unknown as SnapshotDatabaseConstructor;
  } catch (error) {
    return {
      ok: false,
      kind: "unverified",
      issue: `SQLite inspector could not load: ${error instanceof Error ? error.message : String(error)}`
    };
  }

  let db: SnapshotDb | null = null;
  try {
    db = new Database(sourceBytes, { readonly: true });
    db.pragma("query_only = ON");
  } catch (error) {
    try {
      db?.close();
    } catch {
      // Preserve the constructor/pragma failure classification.
    }
    db = null;
    const message = error instanceof Error ? error.message : String(error);
    const code =
      typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : "";
    const confirmedInvalid =
      code === "SQLITE_NOTADB" ||
      code === "SQLITE_CORRUPT" ||
      /not a database|database disk image is malformed/i.test(message);
    return {
      ok: false,
      kind: confirmedInvalid ? "invalid" : "unverified",
      issue: confirmedInvalid
        ? `invalid SQLite database: ${message}`
        : `snapshot could not be opened safely: ${message}`
    };
  }

  try {
    return { ok: true, value: inspect(db), bytes: before.size };
  } catch (error) {
    return {
      ok: false,
      kind: "invalid",
      issue: `invalid or incomplete SQLite schema: ${error instanceof Error ? error.message : String(error)}`
    };
  } finally {
    db?.close();
  }
}

function readSnapshotMeta(db: SnapshotDb): Record<string, string> {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'").get();
  if (!table) throw new Error("meta table is missing");
  requireTableColumns(db, "meta", ["key", "value"]);
  requireColumnContract(db, "meta", {
    key: { type: "TEXT", pk: true },
    value: { type: "TEXT", notNull: true }
  });
  requireSingleColumnPrimaryKey(db, "meta", "key");
  const rows = db.prepare("SELECT key, value FROM meta").all() as Array<{ key?: unknown; value?: unknown }>;
  const meta: Record<string, string> = {};
  for (const row of rows) {
    if (typeof row.key === "string" && typeof row.value === "string") meta[row.key] = row.value;
  }
  return meta;
}

function requireTableColumns(db: SnapshotDb, table: string, expected: readonly string[]): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as TableColumnInfo[];
  const names = rows.flatMap((row) => (typeof row.name === "string" ? [row.name] : []));
  const nameSet = new Set(names);
  const expectedSet = new Set(expected);
  const missing = expected.filter((column) => !nameSet.has(column));
  if (missing.length > 0) throw new Error(`${table} is missing column(s): ${missing.join(", ")}`);
  const unexpected = names.filter((column) => !expectedSet.has(column));
  if (unexpected.length > 0) throw new Error(`${table} has unexpected column(s): ${unexpected.join(", ")}`);
  if (names.some((column, index) => column !== expected[index])) {
    throw new Error(`${table} column order is incompatible`);
  }
}

function requireColumnContract(
  db: SnapshotDb,
  table: string,
  expected: Readonly<Record<string, { type?: "BLOB" | "INTEGER" | "TEXT"; notNull?: boolean; pk?: boolean }>>
): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as TableColumnInfo[];
  const byName = new Map(rows.flatMap((row) => (typeof row.name === "string" ? [[row.name, row] as const] : [])));
  for (const [name, contract] of Object.entries(expected)) {
    const row = byName.get(name);
    if (!row) throw new Error(`${table} is missing column: ${name}`);
    if (contract.type && (typeof row.type !== "string" || row.type.trim().toUpperCase() !== contract.type)) {
      throw new Error(`${table}.${name} must have declared type ${contract.type}`);
    }
    if (contract.notNull && row.notnull !== 1) throw new Error(`${table}.${name} must be NOT NULL`);
    if (contract.pk && row.pk !== 1) throw new Error(`${table}.${name} must be the primary key`);
  }
}

function requireSingleColumnPrimaryKey(db: SnapshotDb, table: string, column: string): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as TableColumnInfo[];
  const primaryKey = rows.filter((row) => typeof row.pk === "number" && row.pk > 0);
  if (primaryKey.length !== 1 || primaryKey[0]?.name !== column || primaryKey[0]?.pk !== 1) {
    throw new Error(`${table} must have exactly one primary-key column: ${column}`);
  }
}

function requireAutoincrementPrimaryKey(db: SnapshotDb, table: string, column: string): void {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as
    | { sql?: unknown }
    | undefined;
  if (typeof row?.sql !== "string") throw new Error(`${table} table definition is missing`);
  const normalized = row.sql.replace(/["`[\]]/g, "").replace(/\s+/g, " ");
  const escapedColumn = column.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const declaration = new RegExp(`\\(\\s*${escapedColumn}\\s+INTEGER\\s+PRIMARY\\s+KEY\\s+AUTOINCREMENT(?:\\s|,)`, "i");
  if (!declaration.test(normalized)) {
    throw new Error(`${table}.${column} must be INTEGER PRIMARY KEY AUTOINCREMENT`);
  }
}

function requireFtsDefinition(sql: string, tokenizeMode: unknown): void {
  if (tokenizeMode !== "unicode61" && tokenizeMode !== "trigram") {
    throw new Error("tokenize_mode metadata is missing or invalid");
  }
  const normalized = sql.replace(/["`[\]]/g, "").replace(/\s+/g, " ");
  if (!/\(\s*content\s*,\s*title\s*,\s*aliases\s*,\s*scope_tokens\s*,/i.test(normalized)) {
    throw new Error("chunks indexed-column order is incompatible");
  }
  for (const column of ["rel_path", "chunk_index", "line_start", "line_end", "tags", "raw_content", "kind"]) {
    const declaration = new RegExp(`(?:\\(|,)\\s*${column}\\s+UNINDEXED(?:\\s*,|\\s*\\))`, "i");
    if (!declaration.test(normalized)) throw new Error(`chunks.${column} must be UNINDEXED`);
  }
  const tokenizer = tokenizeMode === "trigram" ? "trigram" : "unicode61 remove_diacritics 2";
  const escapedTokenizer = tokenizer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!new RegExp(`\\btokenize\\s*=\\s*['"]${escapedTokenizer}['"]`, "i").test(normalized)) {
    throw new Error(`chunks tokenizer does not match tokenize_mode=${tokenizeMode}`);
  }
  const options = [...normalized.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*=/g)].map(
    (match) => match[1]?.toLowerCase() ?? ""
  );
  const unsupported = options.filter((option) => option !== "tokenize");
  if (unsupported.length > 0) {
    throw new Error(`chunks has unsupported FTS5 option(s): ${[...new Set(unsupported)].join(", ")}`);
  }
  if (options.filter((option) => option === "tokenize").length !== 1) {
    throw new Error("chunks must declare exactly one tokenize option");
  }
}

function readIndexColumns(db: SnapshotDb, index: string): string[] {
  if (!/^[A-Za-z0-9_]+$/.test(index)) throw new Error(`unsafe SQLite index name: ${index}`);
  const rows = db.prepare(`PRAGMA index_info(${index})`).all() as Array<{ name?: unknown; seqno?: unknown }>;
  return rows
    .filter((row): row is { name: string; seqno?: unknown } => typeof row.name === "string")
    .sort((left, right) => Number(left.seqno) - Number(right.seqno))
    .map((row) => row.name);
}

function requireEmbedIndexes(db: SnapshotDb): void {
  const indexes = db.prepare("PRAGMA index_list(embeddings)").all() as Array<{
    name?: unknown;
    unique?: unknown;
    partial?: unknown;
  }>;
  const hasRelPathIndex = indexes.some(
    (row) =>
      row.unique === 0 &&
      row.partial === 0 &&
      row.name === "embeddings_rel_path" &&
      readIndexColumns(db, row.name).join(",") === "rel_path"
  );
  if (!hasRelPathIndex) throw new Error("embeddings_rel_path index is missing or incompatible");
  const hasChunkIdentity = indexes.some(
    (row) =>
      row.unique === 1 &&
      row.partial === 0 &&
      typeof row.name === "string" &&
      readIndexColumns(db, row.name).join(",") === "rel_path,chunk_index"
  );
  if (!hasChunkIdentity) throw new Error("embeddings UNIQUE(rel_path, chunk_index) constraint is missing");
}

function readSnapshotCount(db: SnapshotDb, table: "chunks" | "embeddings" | "source_state"): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count?: unknown } | undefined;
  if (typeof row?.count !== "number" || !Number.isSafeInteger(row.count) || row.count < 0) {
    throw new Error(`invalid ${table} row count`);
  }
  return row.count;
}

async function inspectFtsSnapshot(file: string): Promise<SnapshotResult<FtsSnapshot>> {
  return inspectSqliteSnapshot(file, (db) => {
    const meta = readSnapshotMeta(db);
    const table = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='chunks'").get() as
      | { sql?: unknown }
      | undefined;
    if (typeof table?.sql !== "string" || !/\bCREATE\s+VIRTUAL\s+TABLE\b[\s\S]*\bUSING\s+fts5\b/i.test(table.sql)) {
      throw new Error("chunks is not an FTS5 virtual table");
    }
    requireTableColumns(db, "chunks", [
      "content",
      "title",
      "aliases",
      "scope_tokens",
      "rel_path",
      "chunk_index",
      "line_start",
      "line_end",
      "tags",
      "raw_content",
      "kind"
    ]);
    requireFtsDefinition(table.sql, meta.tokenize_mode);
    requireTableColumns(db, "source_state", ["rel_path", "mtime_ms", "n_chunks", "kind", "indexed_at"]);
    requireColumnContract(db, "source_state", {
      rel_path: { type: "TEXT", pk: true },
      mtime_ms: { type: "INTEGER", notNull: true },
      n_chunks: { type: "INTEGER", notNull: true },
      kind: { type: "TEXT", notNull: true },
      indexed_at: { type: "TEXT", notNull: true }
    });
    requireSingleColumnPrimaryKey(db, "source_state", "rel_path");
    const invalidKinds = db
      .prepare("SELECT COUNT(*) AS count FROM source_state WHERE kind IS NULL OR kind NOT IN ('md', 'pdf')")
      .get() as { count?: unknown } | undefined;
    if (invalidKinds?.count !== 0) throw new Error("source_state contains invalid kind values");
    return {
      ...(meta.schema_version !== undefined ? { schemaVersion: meta.schema_version } : {}),
      ...(meta.vault_root !== undefined ? { vaultRoot: meta.vault_root } : {}),
      ...(meta.tokenize_mode === "unicode61" || meta.tokenize_mode === "trigram"
        ? { tokenizeMode: meta.tokenize_mode }
        : {}),
      totalFiles: readSnapshotCount(db, "source_state"),
      totalChunks: readSnapshotCount(db, "chunks")
    };
  });
}

async function inspectEmbedSnapshot(file: string): Promise<SnapshotResult<EmbedSnapshot>> {
  return inspectSqliteSnapshot(file, (db) => {
    const meta = readSnapshotMeta(db);
    requireTableColumns(db, "embeddings", [
      "id",
      "rel_path",
      "chunk_index",
      "line_start",
      "line_end",
      "text_preview",
      "vector",
      "kind"
    ]);
    requireTableColumns(db, "source_state", ["rel_path", "mtime_ms", "n_chunks", "kind", "indexed_at"]);
    requireColumnContract(db, "embeddings", {
      id: { type: "INTEGER", pk: true },
      rel_path: { type: "TEXT", notNull: true },
      chunk_index: { type: "INTEGER", notNull: true },
      line_start: { type: "INTEGER", notNull: true },
      line_end: { type: "INTEGER", notNull: true },
      text_preview: { type: "TEXT", notNull: true },
      vector: { type: "BLOB", notNull: true },
      kind: { type: "TEXT", notNull: true }
    });
    requireSingleColumnPrimaryKey(db, "embeddings", "id");
    requireAutoincrementPrimaryKey(db, "embeddings", "id");
    requireColumnContract(db, "source_state", {
      rel_path: { type: "TEXT", pk: true },
      mtime_ms: { type: "INTEGER", notNull: true },
      n_chunks: { type: "INTEGER", notNull: true },
      kind: { type: "TEXT", notNull: true },
      indexed_at: { type: "TEXT", notNull: true }
    });
    requireSingleColumnPrimaryKey(db, "source_state", "rel_path");
    requireEmbedIndexes(db);
    const invalidKinds = db
      .prepare(
        "SELECT (SELECT COUNT(*) FROM embeddings WHERE kind IS NULL OR kind NOT IN ('md', 'pdf')) + " +
          "(SELECT COUNT(*) FROM source_state WHERE kind IS NULL OR kind NOT IN ('md', 'pdf')) AS count"
      )
      .get() as { count?: unknown } | undefined;
    if (invalidKinds?.count !== 0) throw new Error("embedding tables contain invalid kind values");
    const dim = Number(meta.dim);
    if (Number.isSafeInteger(dim) && dim > 0 && (meta.quantization === "f32" || meta.quantization === "int8")) {
      const expectedBytes = meta.quantization === "int8" ? dim + 8 : dim * 4;
      const invalidVectors = db
        .prepare("SELECT COUNT(*) AS count FROM embeddings WHERE typeof(vector) <> 'blob' OR length(vector) <> ?")
        .get(expectedBytes) as { count?: unknown } | undefined;
      if (invalidVectors?.count !== 0) {
        throw new Error("embedding vector BLOB length does not match dim/quantization metadata");
      }
    }
    return {
      ...(meta.schema_version !== undefined ? { schemaVersion: meta.schema_version } : {}),
      ...(meta.vault_root !== undefined ? { vaultRoot: meta.vault_root } : {}),
      ...(meta.model_alias !== undefined ? { modelAlias: meta.model_alias } : {}),
      ...(meta.dim !== undefined ? { dim: meta.dim } : {}),
      ...(meta.quantization !== undefined ? { quantization: meta.quantization } : {}),
      totalFiles: readSnapshotCount(db, "source_state"),
      totalChunks: readSnapshotCount(db, "embeddings")
    };
  });
}

async function exactDescendant(root: string, segments: readonly string[]): Promise<string | null> {
  let current = root;
  for (const segment of segments) {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      if (isMissingPathError(error)) return null;
      throw error;
    }
    if (!entries.some((entry) => entry.name === segment)) return null;
    current = path.join(current, segment);
  }
  return current;
}

async function inspectModelCache(
  cacheRoots: readonly string[],
  model: EmbeddingModel | RerankerModel,
  expectedOnnxArtifact: "onnx/model.onnx" | "onnx/model_quantized.onnx"
): Promise<ModelCacheInspection | null> {
  const segments = model.hfId.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) return null;

  let partial: ModelCacheInspection | null = null;
  for (const root of [...new Set(cacheRoots)]) {
    const requestedModelDir = path.join(root, ...segments);
    let modelDir = requestedModelDir;
    try {
      const exactModelDir = await exactDescendant(root, segments);
      if (!exactModelDir) continue;
      modelDir = exactModelDir;
      if (!(await fs.stat(modelDir)).isDirectory()) continue;
    } catch (error) {
      if (isMissingPathError(error)) continue;
      partial ??= {
        root,
        files: 0,
        bytes: 0,
        complete: false,
        missingArtifacts: [],
        issue: `cannot inspect ${requestedModelDir}: ${error instanceof Error ? error.message : String(error)}`
      };
      continue;
    }

    let files = 0;
    let bytes = 0;
    let visited = 0;
    const pending = [modelDir];
    while (pending.length > 0 && visited < MAX_MODEL_CACHE_ENTRIES) {
      const current = pending.pop();
      if (!current) break;
      let entries: Dirent[];
      try {
        entries = await fs.readdir(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (visited >= MAX_MODEL_CACHE_ENTRIES) break;
        visited += 1;
        const entryPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          pending.push(entryPath);
        } else if (entry.isFile()) {
          files += 1;
          try {
            const size = (await fs.stat(entryPath)).size;
            bytes += size;
          } catch {
            // A concurrently-removed cache file makes this candidate partial.
          }
        }
      }
    }

    const artifactSize = async (relative: string): Promise<number> => {
      const exactArtifact = await exactDescendant(modelDir, relative.split("/"));
      if (!exactArtifact) return 0;
      const stat = await fs.stat(exactArtifact);
      return stat.isFile() ? stat.size : 0;
    };
    let missingArtifacts: string[] = [];
    let issue: string | undefined;
    try {
      const [configSize, tokenizerConfigSize, tokenizerSize, onnxSize] = await Promise.all([
        artifactSize("config.json").catch((error) => (isMissingPathError(error) ? 0 : Promise.reject(error))),
        artifactSize("tokenizer_config.json").catch((error) => (isMissingPathError(error) ? 0 : Promise.reject(error))),
        artifactSize("tokenizer.json").catch((error) => (isMissingPathError(error) ? 0 : Promise.reject(error))),
        artifactSize(expectedOnnxArtifact).catch((error) => (isMissingPathError(error) ? 0 : Promise.reject(error)))
      ]);
      missingArtifacts = [
        ...(configSize > 0 ? [] : ["config.json"]),
        ...(tokenizerConfigSize > 0 ? [] : ["tokenizer_config.json"]),
        ...(tokenizerSize > 0 ? [] : ["tokenizer.json"]),
        ...(onnxSize > 0 ? [] : [expectedOnnxArtifact])
      ];
    } catch (error) {
      issue = `cannot verify exact cache artifacts: ${error instanceof Error ? error.message : String(error)}`;
    }
    const result = {
      root,
      files,
      bytes,
      complete: issue === undefined && missingArtifacts.length === 0,
      missingArtifacts,
      ...(issue ? { issue } : {})
    };
    if (result.complete) return result;
    partial ??= result;
  }
  return partial;
}

function capabilityRequired(tier: DoctorTier, capability: "hybrid" | "pdf"): boolean {
  return capability === "pdf" ? tier === "hybrid-live" : tier !== "basic";
}

function requiredFailureStatus(tier: DoctorTier, capability: "hybrid" | "pdf"): CheckStatus {
  return capabilityRequired(tier, capability) ? "missing" : "warn";
}

function unverifiedStatus(): CheckStatus {
  return "unverified";
}

/** Options accepted by the source-state-preserving project health diagnostic. */
export interface RunDoctorOptions {
  /** Path to the Obsidian vault root. */
  vault: string;
  /** Capability profile to evaluate. Defaults to `hybrid`. */
  tier?: DoctorTier;
  /** Override default cache root (mostly for tests). */
  modelCacheRoot?: string;
  /** Override default embed-db location. */
  embedFile?: string;
  /** Override default FTS5 index location. */
  indexFile?: string;
  /** Default model alias to check for (matches DEFAULT_MODEL_ALIAS). */
  modelAlias?: string;
  /** Explicit embedding-model catalog entry to evaluate. */
  modelEntry?: EmbeddingModel;
  /** Explicit reranker catalog entry to evaluate. */
  rerankerEntry?: RerankerModel;
  /**
   * Shell-safe prefix for repair commands (for example the physical Node +
   * package entrypoint used by the CLI). Programmatic callers may omit it; in
   * that case hints explain that the same package invocation must be reused.
   */
  repairCommandPrefix?: string;
  /**
   * Platform syntax used by `repairCommandPrefix`. `win32` selects PowerShell
   * argument quoting for paths appended to the prefix.
   */
  repairCommandPlatform?: NodeJS.Platform;
  /** Optional deterministic dependency probe for embedded/test consumers. */
  dependencyProbe?: DependencyProbe;
  /**
   * v3.9.0-rc.16 (P2-12) — privacy denylist, same semantics as `serve`'s
   * `--exclude-glob`. When set, the doctor walks the vault WITH the filter so
   * its counts + "privacy filter" claim reflect reality (pre-rc.16 it always
   * walked unfiltered yet labeled the count "privacy filter applied").
   */
  excludeGlobs?: string[];
  /**
   * v3.9.0-rc.16 (P2-12) — privacy allowlist, same semantics as `serve`'s
   * `--read-paths`.
   */
  readPaths?: string[];
}

/**
 * Run all the diagnostic checks. Pure data — caller decides how to
 * render (CLI banner, JSON, MCP tool response).
 */
export async function runDoctor(opts: RunDoctorOptions): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];
  const requestedTier: string = opts.tier ?? "hybrid";
  if (!isConfigTier(requestedTier)) {
    throw new Error(`Unknown doctor tier '${requestedTier}'. Use ${CONFIG_TIERS.join(" | ")}.`);
  }
  const tier = requestedTier;
  const repairPrefix = opts.repairCommandPrefix ?? "<same-enquire-package-invocation>";
  const dependencyProbe = opts.dependencyProbe ?? probeOptionalDep;
  const safeProbe = async (specifier: string): Promise<boolean> => {
    try {
      return await dependencyProbe(specifier);
    } catch {
      return false;
    }
  };

  // v3.9.0-rc.16 (P2-12) — build the Vault WITH the user's privacy filters so
  // the counts below reflect what tools actually see. The constructor fails
  // closed on invalid globs; catch that so a bad pattern surfaces as a doctor
  // error instead of crashing the whole diagnostic. The unfiltered fallback
  // may validate only the root itself — it must not enumerate vault content.
  const wantsPrivacy = (opts.excludeGlobs?.length ?? 0) > 0 || (opts.readPaths?.length ?? 0) > 0;
  let vault: Vault;
  let privacyActive = false;
  let privacyConfigValid = true;
  try {
    vault = new Vault(opts.vault, {
      ...(opts.excludeGlobs ? { excludeGlobs: opts.excludeGlobs } : {}),
      ...(opts.readPaths ? { readPaths: opts.readPaths } : {})
    });
    privacyActive = wantsPrivacy;
  } catch (err) {
    privacyConfigValid = false;
    const msg = err instanceof Error ? err.message : String(err);
    checks.push({
      id: "privacy",
      label: "Privacy filter configuration",
      status: "error",
      required: true,
      detail: msg,
      hint: "Fix or remove the offending --exclude-glob / --read-paths pattern"
    });
    vault = new Vault(opts.vault);
  }
  if (privacyActive) {
    checks.push({
      id: "privacy",
      label: "Privacy filter active",
      status: "ok",
      required: true,
      detail: `${opts.excludeGlobs?.length ?? 0} exclude-glob denylist · ${opts.readPaths?.length ?? 0} read-path allowlist pattern(s)`
    });
  }
  const renderRepairHint = (
    subcommand: "index" | "build-embeddings",
    fileFlag: "--index-file" | "--embed-file",
    fileOverride?: string
  ): string | undefined => {
    if (!privacyConfigValid) return undefined;
    const args = [
      subcommand,
      "--vault",
      vault.root,
      ...(fileOverride !== undefined ? [fileFlag, path.resolve(fileOverride)] : []),
      ...buildPrivacyArgs({
        ...(opts.excludeGlobs ? { excludeGlobs: opts.excludeGlobs } : {}),
        ...(opts.readPaths ? { readPaths: opts.readPaths } : {})
      })
    ];
    return `${repairPrefix} ${args.map((arg) => shellQuote(arg, opts.repairCommandPlatform)).join(" ")}`;
  };

  // 1. Vault path exists + is readable.
  let vaultExists = false;
  try {
    await vault.ensureExists();
    vaultExists = true;
    const detail = privacyConfigValid
      ? `${(await vault.listMarkdown()).length} markdown · ${
          (await vault.listFilesByExtension(".pdf")).length
        } pdf · ${(await vault.listFilesByExtension(".canvas")).length} canvas${
          privacyActive ? " (after privacy filter)" : ""
        }`
      : "vault root is accessible; content enumeration skipped because the privacy configuration is invalid";
    checks.push({
      id: "vault",
      label: `Vault accessible at ${opts.vault}`,
      status: "ok",
      required: true,
      detail
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    checks.push({
      id: "vault",
      label: `Vault path ${opts.vault}`,
      status: "error",
      required: true,
      detail: msg,
      hint: "Check the path exists and is a directory"
    });
  }

  // Every serve path checks the default embedding database even when the
  // caller selected a custom file: prepareServerDeps enforces that default
  // restart interlock before registering tools. A custom embedding file owns
  // an independent guard as well, so doctor reports a second, tier-aware check
  // whenever the resolved override differs from the default.
  if (vaultExists) {
    const defaultEmbedFile = defaultEmbedDbFile(vault.root);
    const selectedEmbedFile = opts.embedFile !== undefined ? path.resolve(opts.embedFile) : defaultEmbedFile;
    const appendWatcherActivationGuardCheck = async ({
      embedFile,
      id,
      label,
      required,
      blockedDetail
    }: {
      embedFile: string;
      id: string;
      label: string;
      required: boolean;
      blockedDetail: string;
    }): Promise<void> => {
      const guardPath = watcherActivationGuardPath(embedFile);
      const recoveryArgs = [
        "clear-embeddings",
        "--vault",
        vault.root,
        ...(embedFile === defaultEmbedFile ? [] : ["--embed-file", embedFile])
      ];
      const recoveryCommand =
        `${repairPrefix} ` + recoveryArgs.map((arg) => shellQuote(arg, opts.repairCommandPlatform)).join(" ");
      const manualAudit =
        `The strict recovery preflights the interlock before deleting indexes and refuses unsafe or foreign ` +
        `shapes. If it refuses, inspect ${shellQuote(guardPath, opts.repairCommandPlatform)} without following ` +
        "it and remove it only after a manual ownership audit; then rerun the same recovery command and rebuild " +
        "with the same model, quantization, late-chunk, privacy and PDF settings.";

      try {
        const guardStat = await fs.lstat(guardPath);
        const objectKind = guardStat.isSymbolicLink()
          ? "symlink"
          : guardStat.isDirectory()
            ? "directory"
            : guardStat.isFile()
              ? "file"
              : "special object";
        checks.push({
          id,
          label,
          status: required ? "error" : "warn",
          required,
          detail: `stranded ${objectKind} ${blockedDetail}`,
          hint: `Stop every enquire-mcp process using this vault; run ${recoveryCommand}. ${manualAudit}`
        });
      } catch (error) {
        if (isMissingPathError(error)) {
          checks.push({
            id,
            label,
            status: "ok",
            required,
            detail: "no incomplete watcher generation is quarantined"
          });
        } else {
          checks.push({
            id,
            label,
            status: required ? "error" : "warn",
            required,
            detail: `cannot verify interlock state: ${error instanceof Error ? error.message : String(error)}`,
            hint:
              `Inspect ${shellQuote(guardPath, opts.repairCommandPlatform)} without following or deleting it. ` +
              "Do not run destructive recovery until permissions and ownership have been audited manually."
          });
        }
      }
    };

    await appendWatcherActivationGuardCheck({
      embedFile: defaultEmbedFile,
      id: "watcher:activation-guard",
      label: "Watcher startup interlock clear",
      required: true,
      blockedDetail: "blocks every server start"
    });
    if (selectedEmbedFile !== defaultEmbedFile) {
      await appendWatcherActivationGuardCheck({
        embedFile: selectedEmbedFile,
        id: "watcher:selected-activation-guard",
        label: "Selected embedding interlock clear",
        required: capabilityRequired(tier, "hybrid"),
        blockedDetail: "quarantines the selected embedding index"
      });
    }
  }

  // 2. Capability dependencies. Probe concurrently: transformers.js and the
  // native bindings are the slowest part of a cold doctor invocation.
  const [hasSqlite, hasTransformers, hasHnsw, hasPdfjs, hasTesseract, hasCanvas] = await Promise.all([
    safeProbe("better-sqlite3"),
    safeProbe("@huggingface/transformers"),
    safeProbe("hnswlib-node"),
    safeProbe("pdfjs-dist/legacy/build/pdf.mjs"),
    safeProbe("tesseract.js"),
    safeProbe("@napi-rs/canvas")
  ]);
  checks.push({
    id: "dep:better-sqlite3",
    label: "better-sqlite3 (FTS5 BM25 + embedding store)",
    status: hasSqlite ? "ok" : requiredFailureStatus(tier, "hybrid"),
    required: capabilityRequired(tier, "hybrid"),
    detail: hasSqlite ? "module and native binding probe succeeded" : undefined,
    hint: hasSqlite
      ? undefined
      : "Reinstall this exact enquire-mcp package copy without --omit=optional (missing better-sqlite3)"
  });
  checks.push({
    id: "dep:transformers",
    label: "@huggingface/transformers (ML embeddings + cross-encoder reranker)",
    status: hasTransformers ? "ok" : requiredFailureStatus(tier, "hybrid"),
    required: capabilityRequired(tier, "hybrid"),
    detail: hasTransformers ? "module and required loader exports are available" : undefined,
    hint: hasTransformers
      ? undefined
      : "Reinstall this exact enquire-mcp package copy without --omit=optional (missing @huggingface/transformers)"
  });
  checks.push({
    id: "dep:hnsw",
    label: "hnswlib-node (accelerated vector retrieval)",
    status: hasHnsw ? "ok" : requiredFailureStatus(tier, "hybrid"),
    required: capabilityRequired(tier, "hybrid"),
    detail: hasHnsw ? "module and native HierarchicalNSW export are available" : undefined,
    hint: hasHnsw
      ? undefined
      : "Reinstall this exact enquire-mcp package copy without --omit=optional (missing hnswlib-node)"
  });
  checks.push({
    id: "dep:pdfjs",
    label: "pdfjs-dist (PDF read + indexing)",
    status: hasPdfjs ? "ok" : requiredFailureStatus(tier, "pdf"),
    required: capabilityRequired(tier, "pdf"),
    detail: hasPdfjs ? "loaded" : "PDFs in vault won't be indexable",
    hint: hasPdfjs
      ? undefined
      : "Reinstall this exact enquire-mcp package copy without --omit=optional (missing pdfjs-dist; skip if you have no PDFs)"
  });

  // OCR remains optional for every current tier: hybrid-live includes text
  // PDFs, while scanned-document OCR is a separate explicit feature.
  if (hasTesseract && hasCanvas) {
    checks.push({
      id: "dep:ocr",
      label: "tesseract.js + @napi-rs/canvas (OCR for scanned PDFs)",
      status: "ok",
      required: false,
      detail: "both loaded; PDF OCR ready"
    });
  } else {
    checks.push({
      id: "dep:ocr",
      label: "tesseract.js + @napi-rs/canvas (OCR for scanned PDFs)",
      status: "warn",
      required: false,
      detail: `tesseract.js=${hasTesseract ? "ok" : "missing"} · canvas=${hasCanvas ? "ok" : "missing"}`,
      hint: "Reinstall this exact enquire-mcp package copy without --omit=optional (missing OCR optional dependencies; skip if you have no scanned PDFs)"
    });
  }

  const explicitModelSelection = opts.modelEntry !== undefined || opts.modelAlias !== undefined;
  let fallbackModel: EmbeddingModel;
  try {
    fallbackModel = opts.modelEntry ?? resolveModel(opts.modelAlias ?? DEFAULT_MODEL_ALIAS);
  } catch (error) {
    checks.push({
      id: "model:selection",
      label: "Embedding model selection",
      status: requiredFailureStatus(tier, "hybrid"),
      required: capabilityRequired(tier, "hybrid"),
      detail: error instanceof Error ? error.message : String(error),
      hint: `Use one of: ${Object.keys(EMBEDDING_MODELS).join(", ")}`
    });
    fallbackModel = resolveModel(DEFAULT_MODEL_ALIAS);
  }

  let selectedModel = fallbackModel;

  // 3. FTS5 index — inspect an immutable in-memory byte snapshot. Never call
  // FtsIndex.open(): that method is a migration/write primitive by design.
  if (vaultExists) {
    const indexFile = opts.indexFile ?? defaultIndexFile(vault.root);
    if (hasSqlite) {
      const inspection = await inspectFtsSnapshot(indexFile);
      if (inspection.ok) {
        const problems: string[] = [];
        if (inspection.value.schemaVersion !== String(FTS_SCHEMA_VERSION)) {
          problems.push(`schema ${inspection.value.schemaVersion ?? "missing"} ≠ ${FTS_SCHEMA_VERSION}`);
        }
        if (inspection.value.vaultRoot !== vault.root) {
          problems.push(`vault root ${inspection.value.vaultRoot ?? "missing"} ≠ ${vault.root}`);
        }
        if (!inspection.value.tokenizeMode) problems.push("tokenize_mode missing or invalid");
        if (problems.length === 0) {
          checks.push({
            id: "index:fts5",
            label: "FTS5 BM25 index",
            status: "ok",
            required: capabilityRequired(tier, "hybrid"),
            detail: `${indexFile} — ${inspection.value.totalFiles} files / ${inspection.value.totalChunks} chunks`
          });
        } else {
          checks.push({
            id: "index:fts5",
            label: "FTS5 BM25 index",
            status: requiredFailureStatus(tier, "hybrid"),
            required: capabilityRequired(tier, "hybrid"),
            detail: `${indexFile} is incompatible: ${problems.join("; ")}`,
            hint: renderRepairHint("index", "--index-file", opts.indexFile)
          });
        }
      } else {
        checks.push({
          id: "index:fts5",
          label: "FTS5 BM25 index",
          status: inspection.kind === "unverified" ? unverifiedStatus() : requiredFailureStatus(tier, "hybrid"),
          required: capabilityRequired(tier, "hybrid"),
          detail: `${indexFile}: ${inspection.issue}`,
          hint:
            inspection.kind === "unverified"
              ? inspection.issue.includes("active SQLite")
                ? "Stop active enquire-mcp processes, then run doctor again"
                : "The source was left untouched; inspect it separately or retry when it is stable"
              : renderRepairHint("index", "--index-file", opts.indexFile)
        });
      }
    } else {
      checks.push({
        id: "index:fts5",
        label: "FTS5 BM25 index",
        status: requiredFailureStatus(tier, "hybrid"),
        required: capabilityRequired(tier, "hybrid"),
        detail: "cannot inspect without better-sqlite3",
        hint: "Reinstall this exact enquire-mcp package copy without --omit=optional (missing better-sqlite3)"
      });
    }
  }

  // 4. Embedding index — validate schema + vault/model/quantization metadata
  // from the same immutable snapshot mechanism.
  if (vaultExists) {
    const embedFile = opts.embedFile !== undefined ? path.resolve(opts.embedFile) : defaultEmbedDbFile(vault.root);
    if (hasSqlite) {
      const inspection = await inspectEmbedSnapshot(embedFile);
      if (inspection.ok) {
        const indexedModel =
          inspection.value.modelAlias !== undefined ? EMBEDDING_MODELS[inspection.value.modelAlias] : undefined;
        if (!explicitModelSelection && indexedModel) selectedModel = indexedModel;
        const problems: string[] = [];
        if (inspection.value.schemaVersion !== String(EMBED_DB_SCHEMA_VERSION)) {
          problems.push(`schema ${inspection.value.schemaVersion ?? "missing"} ≠ ${EMBED_DB_SCHEMA_VERSION}`);
        }
        if (inspection.value.vaultRoot !== vault.root) {
          problems.push(`vault root ${inspection.value.vaultRoot ?? "missing"} ≠ ${vault.root}`);
        }
        if (!indexedModel) {
          problems.push(`model alias ${inspection.value.modelAlias ?? "missing"} is unknown`);
        } else {
          if (explicitModelSelection && indexedModel.alias !== selectedModel.alias) {
            problems.push(`model alias ${indexedModel.alias} ≠ selected ${selectedModel.alias}`);
          }
          if (inspection.value.dim !== String(indexedModel.dim)) {
            problems.push(`dim ${inspection.value.dim ?? "missing"} ≠ ${indexedModel.dim}`);
          }
        }
        if (inspection.value.quantization !== "f32" && inspection.value.quantization !== "int8") {
          problems.push(`quantization ${inspection.value.quantization ?? "missing"} is invalid`);
        }
        if (problems.length === 0) {
          checks.push({
            id: "index:embed",
            label: "Embedding index (.embed.db)",
            status: "ok",
            required: capabilityRequired(tier, "hybrid"),
            detail: `${embedFile} — ${(inspection.bytes / 1024 / 1024).toFixed(1)} MB · ${
              inspection.value.totalFiles
            } files / ${inspection.value.totalChunks} chunks · model=${inspection.value.modelAlias} · quantization=${
              inspection.value.quantization
            }`
          });
        } else {
          checks.push({
            id: "index:embed",
            label: "Embedding index (.embed.db)",
            status: requiredFailureStatus(tier, "hybrid"),
            required: capabilityRequired(tier, "hybrid"),
            detail: `${embedFile} is incompatible: ${problems.join("; ")}`,
            hint: renderRepairHint("build-embeddings", "--embed-file", opts.embedFile)
          });
        }
      } else {
        checks.push({
          id: "index:embed",
          label: "Embedding index (.embed.db)",
          status: inspection.kind === "unverified" ? unverifiedStatus() : requiredFailureStatus(tier, "hybrid"),
          required: capabilityRequired(tier, "hybrid"),
          detail: `${embedFile}: ${inspection.issue}`,
          hint:
            inspection.kind === "unverified"
              ? inspection.issue.includes("active SQLite")
                ? "Stop active enquire-mcp processes, then run doctor again"
                : "The source was left untouched; inspect it separately or retry when it is stable"
              : renderRepairHint("build-embeddings", "--embed-file", opts.embedFile)
        });
      }
    } else {
      checks.push({
        id: "index:embed",
        label: "Embedding index (.embed.db)",
        status: requiredFailureStatus(tier, "hybrid"),
        required: capabilityRequired(tier, "hybrid"),
        detail: "cannot inspect without better-sqlite3",
        hint: "Reinstall this exact enquire-mcp package copy without --omit=optional (missing better-sqlite3)"
      });
    }
  }

  // 5. Exact model-cache checks. An unrelated `Xenova/*` directory no longer
  // makes the selected profile READY: require JSON metadata + ONNX weights for
  // the embedding model and, for hybrid tiers, the default reranker.
  const cacheRoots = opts.modelCacheRoot ? [opts.modelCacheRoot] : candidateModelCacheRoots();
  const searchedCacheRoots =
    cacheRoots.length > 0 ? cacheRoots.join(", ") : "no runtime package-local cache root could be resolved";
  const modelCache = await inspectModelCache(cacheRoots, selectedModel, "onnx/model_quantized.onnx");
  checks.push({
    id: "model:embedding-cache",
    label: `Embedding model cache (${selectedModel.alias})`,
    status: modelCache?.complete
      ? "ok"
      : modelCache?.issue
        ? unverifiedStatus()
        : requiredFailureStatus(tier, "hybrid"),
    required: capabilityRequired(tier, "hybrid"),
    detail: modelCache?.complete
      ? `${selectedModel.hfId} — exact non-empty artifact paths present; not inference-tested · ${
          modelCache.files
        } files / ~${Math.round(modelCache.bytes / 1024 / 1024)} MB under ${modelCache.root}`
      : modelCache?.issue
        ? `${selectedModel.hfId} cache could not be verified under ${modelCache.root}: ${modelCache.issue}`
        : modelCache
          ? `${selectedModel.hfId} cache is incomplete (missing: ${modelCache.missingArtifacts.join(
              ", "
            )}; ${modelCache.files} files under ${modelCache.root})`
          : `${selectedModel.hfId} not found; searched package-local cache root(s): ${searchedCacheRoots}`,
    hint: modelCache?.complete
      ? undefined
      : `${repairPrefix} install-model ${selectedModel.alias}  (~${selectedModel.approxSizeMB} MB)`
  });

  const reranker = opts.rerankerEntry ?? resolveRerankerModel(DEFAULT_RERANKER_ALIAS);
  const rerankerCache = await inspectModelCache(cacheRoots, reranker, "onnx/model_quantized.onnx");
  checks.push({
    id: "model:reranker-cache",
    label: `Reranker model cache (${reranker.alias})`,
    status: rerankerCache?.complete
      ? "ok"
      : rerankerCache?.issue
        ? unverifiedStatus()
        : requiredFailureStatus(tier, "hybrid"),
    required: capabilityRequired(tier, "hybrid"),
    detail: rerankerCache?.complete
      ? `${reranker.hfId} — exact non-empty q8 artifact paths present; not inference-tested · ${
          rerankerCache.files
        } files / ~${Math.round(rerankerCache.bytes / 1024 / 1024)} MB under ${rerankerCache.root}`
      : rerankerCache?.issue
        ? `${reranker.hfId} cache could not be verified under ${rerankerCache.root}: ${rerankerCache.issue}`
        : rerankerCache
          ? `${reranker.hfId} cache is incomplete (missing: ${rerankerCache.missingArtifacts.join(
              ", "
            )}; ${rerankerCache.files} files under ${rerankerCache.root})`
          : `${reranker.hfId} not found; searched package-local cache root(s): ${searchedCacheRoots}`,
    hint: rerankerCache?.complete
      ? undefined
      : `${repairPrefix} install-model ${reranker.alias}  (~${reranker.approxSizeMB} MB)`
  });

  // Tally the summary.
  const summary = { ok: 0, warn: 0, missing: 0, error: 0, unverified: 0 };
  for (const ch of checks) summary[ch.status] += 1;
  // Statuses are tier-aware for human output, while `required` is the
  // machine-readable contract and therefore the source of truth for READY.
  const ready = checks.every((check) => !check.required || check.status === "ok");

  return {
    vault: opts.vault,
    tier,
    scope: "structural-runtime",
    limitations: [
      "index freshness",
      "complete PDF corpus coverage",
      "watcher event delivery",
      "OCR language packs",
      "model artifact integrity or inference loadability",
      "privacy filters are not an at-rest purge or index-membership audit"
    ],
    ready,
    checks,
    summary
  };
}
