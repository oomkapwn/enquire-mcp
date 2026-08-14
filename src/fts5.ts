// SQLite FTS5 inverted index for indexed BM25-ranked search. Opt-in via
// `--persistent-index`.
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
import { lookupFoldedKey } from "./name-fold.js";
import { optionalDepDetail } from "./optional-dep.js";
import { FTS_SCHEMA_VERSION } from "./schema-contract.js";
import { iterateContentLines } from "./structure.js";
import type { Vault } from "./vault.js";
import { countLineBreaks, stripTrailingSlashes } from "./wildcard-match.js";

// v3.11.6-rc.6 (competitive-study C-3) — FTS5 column weights for BM25. The
// chunks table indexes `content` (col 0), `title` (col 1), `aliases` (col 2);
// bm25(chunks, ...) takes a weight per column in definition order. A note whose
// TITLE or a frontmatter ALIAS matches the query should outrank a note that only
// mentions the term in its body — mirrors OHS's title-10× / alias-5× / content-1×
// weighting, tunable against the eval harness (`enquire eval` + `eval:compare`).
const BM25_WEIGHT_CONTENT = 1.0;
const BM25_WEIGHT_TITLE = 10.0;
const BM25_WEIGHT_ALIASES = 5.0;
const MAX_SOURCE_REVISION = Number.MAX_SAFE_INTEGER;
const MAX_SOURCE_RECEIPT_BATCH = 512;

/**
 * Extract the searchable alias strings from a note's frontmatter. Obsidian
 * accepts `aliases: [a, b]`, `aliases: a`, or the singular `alias: a`. Values
 * are coerced to trimmed non-empty strings; non-string entries are dropped.
 * (v3.11.6-rc.6 — used to populate the FTS5 `aliases` column.)
 */
// v3.11.6-rc.6 re-sweep fix — bound the alias blob that gets FTS5-tokenized.
// Frontmatter is note-content (an --enable-write agent or a paste can author a
// pathological `aliases:` array); cap the count + per-alias length so the always-on
// index build can't be amplified by a single note. Mirrors the MAX_* input-cap convention.
const MAX_ALIASES = 64;
const MAX_ALIAS_LEN = 256;
const MAX_FTS_TITLE_LEN = 512;

export function extractAliases(frontmatter: Record<string, unknown> | undefined | null): string[] {
  if (!frontmatter) return [];
  const out: string[] = [];
  const push = (v: unknown) => {
    if (out.length >= MAX_ALIASES) return;
    if (typeof v === "string") {
      const t = v.trim();
      if (t.length > 0) out.push(t.length > MAX_ALIAS_LEN ? t.slice(0, MAX_ALIAS_LEN) : t);
    }
  };
  for (const key of ["aliases", "alias"]) {
    // v3.11.6-rc.12 (re-sweep) — FOLDED key lookup. rc.6 read the keys raw
    // (exact-string), a direct recursion of the v3.11.0-rc.13 AUD-03
    // frontmatter-key-PRODUCER class: Obsidian properties are case-insensitive,
    // so a note with `Aliases:` / `Alias:` silently got NO alias indexing —
    // the rc.6 feature was dead for those notes.
    const raw = lookupFoldedKey(frontmatter, key).value;
    if (Array.isArray(raw)) for (const v of raw) push(v);
    else push(raw);
  }
  return out;
}

/**
 * The searchable title for a note = its basename with the `.md` extension
 * stripped (the note's canonical Obsidian identity). Populates the weighted
 * FTS5 `title` column. (v3.11.6-rc.6.)
 */
export function deriveFtsTitle(relPath: string): string {
  const title = path.basename(relPath).replace(/\.md$/i, "");
  return title.length > MAX_FTS_TITLE_LEN ? title.slice(0, MAX_FTS_TITLE_LEN) : title;
}
// v2 added the `tags` UNINDEXED column for tag-filtered search.
// v3 added `raw_content` UNINDEXED so the chunk resource can return the
// original note text, while FTS5's `content` column keeps the enriched
// version (with appended wikilink_targets) for recall.
// v4 added the `kind` UNINDEXED column ("md" | "pdf") so PDF chunks live
// in the same index as markdown — `obsidian_search` returns blended hits
// with the kind flag exposed to agents. Schema bump auto-rebuilds.
// v5 (v3.11.6-rc.6) added the INDEXED `title` (col 1) + `aliases` (col 2)
// columns after `content`, with bm25 positional weights 1.0/10.0/5.0 so a
// title/alias match outranks a body-only mention. title/aliases are stored
// ONLY on chunk 0 of each note (not every chunk) to avoid one note's
// title-match flooding the BM25 candidate set. Schema bump auto-rebuilds.
// v6 (v3.12.0-rc.18) added the INDEXED `scope_tokens` column (col 3).
// Collision-free encoded path tokens let FTS5 prune replacement
// deletes and folder-scoped searches inside its inverted index instead of
// scanning the UNINDEXED `rel_path` column. Its BM25 weight is zero, so scope
// constraints select the corpus without contributing relevance.
const BM25_WEIGHT_SCOPE = 0.0;

/**
 * Stable FTS-safe token for one exact vault-relative source path.
 *
 * UTF-8 hex keeps every legal filename inert in MATCH expressions and is
 * prefix-preserving: a folder token can select descendants with FTS5's indexed
 * prefix operator. One token per chunk covers both exact-path and ancestor
 * folder lookup, avoiding repeated ancestor postings in large/deep vaults.
 *
 * @param relPath - Vault-relative source path.
 * @returns One collision-free alphanumeric token.
 */
export function ftsPathToken(relPath: string): string {
  return `s${Buffer.from(relPath, "utf8").toString("hex")}`;
}

/**
 * Stable FTS-safe prefix token for one vault-relative folder scope.
 *
 * @param folder - Vault-relative folder, with or without trailing slashes.
 * @returns One alphanumeric path prefix plus FTS5's suffix wildcard.
 */
export function ftsFolderToken(folder: string): string {
  const prefix = `${stripTrailingSlashes(folder)}/`;
  return `${ftsPathToken(prefix)}*`;
}

/**
 * Build the indexed scope token for one source.
 *
 * The original `rel_path` stays UNINDEXED and is retained as a residual
 * equality/prefix check for defense-in-depth.
 *
 * @param relPath - Vault-relative source path.
 * @returns One FTS-safe, prefix-preserving path token.
 */
export function ftsScopeTokens(relPath: string): string {
  return ftsPathToken(relPath);
}

/**
 * FTS5 tokenizer mode. `unicode61` (default) tokenizes on Unicode word
 * boundaries with diacritic folding — good fit for natural-language
 * markdown. `trigram` indexes every 3-char substring — slower to build
 * but better recall on CJK / agglutinative scripts.
 */
export type TokenizeMode = "unicode61" | "trigram";

/** Content-source kind. v2.7.0 added `pdf`; v2.8.0 indexes them. */
export type ChunkKind = "md" | "pdf";

function isChunkKind(value: unknown): value is ChunkKind {
  return value === "md" || value === "pdf";
}

/**
 * Provenance receipt consumed by {@link FtsIndex.currentSourceReceiptMask}.
 *
 * @example
 * ```ts
 * const [hit] = index.searchWithReceipts("retrieval", { limit: 1 });
 * if (hit) index.currentSourceReceiptMask([hit]);
 * ```
 */
export interface FtsSourceReceipt {
  /** Vault-relative path of the indexed source. */
  rel_path: string;
  /** Content-source kind. */
  kind: ChunkKind;
  /** Source mtime selected in the same snapshot as the indexed bytes. */
  indexed_mtime_ms: number;
  /** Monotonic ledger revision selected in that snapshot. */
  indexed_revision: number;
}

/** A single hit from {@link FtsIndex.search}. `snippet` carries the
 *  FTS5 `snippet(...)` output (matched terms wrapped in `«»`). */
export interface FtsSearchHit {
  /** Vault-relative path of the source note / PDF. */
  rel_path: string;
  /** 0-based chunk position within the source. */
  chunk_index: number;
  /** 1-based starting line in the source. */
  line_start: number;
  /** 1-based ending line in the source (inclusive). */
  line_end: number;
  /** Excerpt with matched tokens wrapped in `«»` and `…` truncation markers. */
  snippet: string;
  /** Flipped BM25 score — higher = better (the underlying FTS5 score is
   *  negative; we negate so callers can sort descending). */
  score: number;
  /** v2.8.0 — content-source kind. Defaults to "md" for backward compat. */
  kind: ChunkKind;
}

/**
 * Internal-authority FTS hit returned by {@link FtsIndex.searchWithReceipts}.
 * It extends the legacy {@link FtsSearchHit} shape with the source receipt
 * required for a caller-owned live-vault admission check.
 *
 * @example
 * ```ts
 * const [hit] = index.searchWithReceipts("retrieval", { limit: 1 });
 * if (hit) index.currentSourceReceiptMask([hit]);
 * ```
 */
export type FtsReceiptSearchHit = FtsSearchHit & FtsSourceReceipt;

/**
 * Raw FTS chunk plus the source receipt selected with the same persisted bytes.
 *
 * @example
 * ```ts
 * const chunk = index.getChunkWithReceipt("Projects/plan.md", 0);
 * if (chunk) index.currentSourceReceiptMask([chunk]);
 * ```
 */
export interface FtsReceiptChunk extends FtsSourceReceipt {
  /** Verbatim source chunk without synthetic FTS enrichment. */
  content: string;
  /** One-based first source line represented by the chunk. */
  line_start: number;
  /** One-based final source line represented by the chunk. */
  line_end: number;
}

/** Error-handling mode for the Markdown-to-FTS sync routine. */
export type FtsSyncMode = "fail-soft" | "strict";

/** Raw counter and physical-integrity evidence returned by FTS5 sync. */
export interface FtsSyncReport {
  /** Requested error policy. Product startup defaults to fail-soft; evidence runs use strict. */
  mode: FtsSyncMode;
  /** Whether the expensive physical-row audit and manifest were computed. */
  audited: boolean;
  /** Files newly indexed (no prior source_state row). */
  added: number;
  /** Files re-indexed due to mtime change. */
  updated: number;
  /** Files dropped because the source vanished from the vault. */
  deleted: number;
  /** Files whose mtime matched the stored row — no work needed. */
  unchanged: number;
  /** Total chunks in the index after the sync. */
  total_chunks: number;
  /** Live Markdown source files observed at sync start. */
  total_files: number;
  /** Live files either indexed, classified empty/failed, or verified unchanged. */
  processed_files: number;
  /** Live files that produced no indexable chunks. */
  empty: number;
  /** Per-file read/index failures caught in fail-soft mode. */
  failed: number;
  /** Files declared in `source_state` by the final physical audit. */
  declared_files: number;
  /** Distinct physical chunk paths found by the final physical audit. */
  indexed_files: number;
  /** Sum of declared per-file chunk counts. */
  declared_chunks: number;
  /** Actual physical Markdown chunk rows. */
  indexed_chunks: number;
  /** Unique paths rejected by the physical audit. */
  mismatched_files: number;
  /** SHA-256 over the exact kind-scoped state, revision ledger, quarantine, and chunks; null when unaudited. */
  manifest_sha256: string | null;
  /** Derived raw-equation result; publication guards recompute it independently. */
  complete: boolean;
}

/** Read-only physical-completeness summary for one FTS content kind. */
export interface FtsKindAudit {
  /** Files declared in `source_state` for the requested kind. */
  declared_files: number;
  /** Distinct physical chunk paths stored for the requested kind. */
  indexed_files: number;
  /** Sum of the per-file chunk counts declared in `source_state`. */
  declared_chunks: number;
  /** Actual physical chunk rows stored for the requested kind. */
  indexed_chunks: number;
  /**
   * Unique paths whose declaration, revision, row shape, kind, or contiguous
   * chunk range is invalid, including chunk-only paths and globally invalid kinds.
   */
  mismatched_files: number;
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
      // rc.57 (OPTDEP-SQLITE-PATH-LEAK-EMBEDDB) — code only; the raw message can embed an abs path.
      throw new Error(
        `better-sqlite3 native binding failed to load (try: \`npm rebuild better-sqlite3\` or reinstall without --omit=optional / --ignore-scripts). (${optionalDepDetail(probeErr)})`
      );
    }
    BetterSqliteCtor = ctor;
    return ctor;
  } catch (err) {
    // rc.57 (OPTDEP-SQLITE-PATH-LEAK-EMBEDDB) — Node's ERR_MODULE_NOT_FOUND message embeds the
    // importing file's ABSOLUTE path; surface only the code (sibling of the embed-db.ts loader).
    throw new Error(
      `Persistent index requires the optional 'better-sqlite3' dependency; install failed or the binding could not be loaded. (${optionalDepDetail(err)})`
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
  // v3.7.10 (external audit #10) — added for transactional reindexFile().
  // better-sqlite3 wraps the passed function in a SAVEPOINT and rolls back
  // on throw. Returns a callable that re-uses the prepared transaction.
  transaction<F extends (...args: never[]) => unknown>(fn: F): F;
}
interface Stmt {
  run(...params: unknown[]): { changes: number };
  all<T = unknown>(...params: unknown[]): T[];
  get<T = unknown>(...params: unknown[]): T | undefined;
  iterate<T = unknown>(...params: unknown[]): IterableIterator<T>;
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

/**
 * SQLite FTS5 inverted index over chunked note content. Opt-in via
 * `--persistent-index`. The production evidence linked in this module reports
 * 50–100ms BM25 top-10 at 1,771 chunks / 368 files; other corpora and hardware
 * must be measured independently. Falls back transparently to the in-memory
 * parallel-scan path when `better-sqlite3` isn't installed.
 *
 * Construct, then call `open()`, then drive incremental sync via
 * {@link diff} + {@link reindexFile} / {@link reindexPdfFile} / {@link dropFile}.
 * Query with {@link search}; deep-link to individual chunks with
 * {@link getChunk}.
 *
 * @example
 * ```ts
 * const idx = new FtsIndex({ file, vaultRoot, tokenize: "unicode61" });
 * await idx.open();
 * idx.reindexFile(relPath, mtimeMs, content, wikilinkTargets, tags);
 * const hits = idx.search("vector retrieval", { limit: 25 });
 * idx.close();
 * ```
 */
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

  /**
   * Open the SQLite database, bootstrap the FTS5 virtual table + helpers,
   * and tighten file perms to 0o600 on the db + WAL/SHM sidecars. Idempotent —
   * a second `open()` call is a no-op.
   *
   * @throws {Error} If `better-sqlite3` (optional dep) fails to load or
   *   the native binding can't be loaded.
   */
  async open(): Promise<void> {
    if (this.db) return;
    const Ctor = await loadBetterSqlite();
    // v3.7.6 M-9 (external audit) — only chmod the parent directory if WE
    // created it (parent didn't exist before mkdir). For user-supplied
    // custom paths like `--index-file /existing/shared/path.fts5.db`, the
    // pre-fix code would tighten the existing parent to 0o700 — surprising
    // and potentially breaking for shared parent directories (Dropbox,
    // shared NFS mounts, etc.). Now: existence check before mkdir; chmod
    // only when we just created the dir.
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
    // v3.10.0-rc.70 (round-3 re-sweep, reserve-before-try) — close-on-throw: release the handle if
    // pragma/bootstrapSchema throws on a corrupt/legacy index, so no caller can leak it (mirrors
    // EmbedDb.open()). The serve call site already wraps this in a catch, but self-cleaning here
    // makes the contract hold for every caller (CLI build paths, future ones).
    try {
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = NORMAL");
      this.bootstrapSchema();
    } catch (e) {
      this.close();
      throw e;
    }
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

  /** Close the underlying SQLite handle. Idempotent. Call before process
   *  exit to flush WAL. */
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
    const versionMatch = meta.schema_version === undefined || meta.schema_version === String(FTS_SCHEMA_VERSION);
    // v3.7.19 γ3 / R-6 from round-20 — wrap the DROP+CREATE+writeMeta
    // sequence in a single db.transaction(). Pre-3.7.19 the steps ran
    // independently; while the existing code IS self-healing on next open
    // via CREATE IF NOT EXISTS + DROP IF EXISTS + readMeta idempotency,
    // a transaction makes the failure mode explicit: either the rebuild
    // completes fully OR it rolls back to the pre-rebuild state with
    // chunks/source_state still intact. Defensive programming + removes
    // the auditor's concern. FTS5 virtual table CREATE is supported
    // inside transactions on SQLite >= 3.7 (better-sqlite3 ships 3.40+).
    const txn = db.transaction(() => {
      if (!tokenizeMatch || !rootMatch || !versionMatch) {
        const reason: string[] = [];
        if (!tokenizeMatch) reason.push(`tokenize ${meta.tokenize_mode} → ${this.tokenize}`);
        if (!rootMatch) reason.push(`vault_root ${meta.vault_root} → ${this.vaultRoot}`);
        if (!versionMatch) reason.push(`schema_version ${meta.schema_version} → ${FTS_SCHEMA_VERSION}`);
        process.stderr.write(`enquire: rebuilding fts5 index (${reason.join("; ")})\n`);
        // DROP rather than DELETE — schema may have changed (e.g. v1 → v2 added
        // the `tags` column). DROP IF EXISTS handles a fresh DB too.
        db.exec(`
          DROP TABLE IF EXISTS chunks;
          DROP TABLE IF EXISTS source_state;
          DROP TABLE IF EXISTS source_quarantine;
          DROP TABLE IF EXISTS source_revision;
        `);
      }

      // Trigger names are additive-schema authority. Recreate them on every
      // open inside this transaction so a legacy, partial, or no-op same-name
      // definition cannot silently survive CREATE TRIGGER IF NOT EXISTS.
      db.exec(`
        DROP TRIGGER IF EXISTS source_state_revision_insert;
        DROP TRIGGER IF EXISTS source_state_revision_update;
        DROP TRIGGER IF EXISTS source_state_revision_delete;
        DROP TRIGGER IF EXISTS source_quarantine_revision_insert;
        DROP TRIGGER IF EXISTS source_quarantine_revision_update;
        DROP TRIGGER IF EXISTS source_quarantine_revision_delete;
      `);

      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
          content,
          title,
          aliases,
          scope_tokens,
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
        CREATE TABLE IF NOT EXISTS source_quarantine (
          rel_path TEXT NOT NULL,
          kind TEXT NOT NULL,
          PRIMARY KEY (rel_path, kind)
        ) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS source_revision (
          rel_path TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('md', 'pdf')),
          revision INTEGER NOT NULL CHECK (
            typeof(revision) = 'integer'
            AND revision BETWEEN 1 AND ${MAX_SOURCE_REVISION}
          ),
          PRIMARY KEY (rel_path, kind)
        ) WITHOUT ROWID;

        INSERT OR IGNORE INTO source_revision (rel_path, kind, revision)
        SELECT rel_path, kind, 1
        FROM source_state
        WHERE kind IN ('md', 'pdf')
        UNION
        SELECT rel_path, kind, 1
        FROM source_quarantine
        WHERE kind IN ('md', 'pdf');

        CREATE TRIGGER IF NOT EXISTS source_state_revision_insert
        AFTER INSERT ON source_state
        WHEN NEW.kind IN ('md', 'pdf')
        BEGIN
          INSERT INTO source_revision (rel_path, kind, revision)
          VALUES (NEW.rel_path, NEW.kind, 1)
          ON CONFLICT(rel_path, kind) DO UPDATE
          SET revision = source_revision.revision + 1;
        END;

        CREATE TRIGGER IF NOT EXISTS source_state_revision_update
        AFTER UPDATE ON source_state
        BEGIN
          INSERT INTO source_revision (rel_path, kind, revision)
          SELECT OLD.rel_path, OLD.kind, 1
          WHERE OLD.kind IN ('md', 'pdf')
            AND (OLD.rel_path <> NEW.rel_path OR OLD.kind <> NEW.kind)
          ON CONFLICT(rel_path, kind) DO UPDATE
          SET revision = source_revision.revision + 1;

          INSERT INTO source_revision (rel_path, kind, revision)
          SELECT NEW.rel_path, NEW.kind, 1
          WHERE NEW.kind IN ('md', 'pdf')
          ON CONFLICT(rel_path, kind) DO UPDATE
          SET revision = source_revision.revision + 1;
        END;

        CREATE TRIGGER IF NOT EXISTS source_state_revision_delete
        AFTER DELETE ON source_state
        WHEN OLD.kind IN ('md', 'pdf')
        BEGIN
          INSERT INTO source_revision (rel_path, kind, revision)
          VALUES (OLD.rel_path, OLD.kind, 1)
          ON CONFLICT(rel_path, kind) DO UPDATE
          SET revision = source_revision.revision + 1;
        END;

        CREATE TRIGGER IF NOT EXISTS source_quarantine_revision_insert
        AFTER INSERT ON source_quarantine
        WHEN NEW.kind IN ('md', 'pdf')
        BEGIN
          INSERT INTO source_revision (rel_path, kind, revision)
          VALUES (NEW.rel_path, NEW.kind, 1)
          ON CONFLICT(rel_path, kind) DO UPDATE
          SET revision = source_revision.revision + 1;
        END;

        CREATE TRIGGER IF NOT EXISTS source_quarantine_revision_update
        AFTER UPDATE ON source_quarantine
        BEGIN
          INSERT INTO source_revision (rel_path, kind, revision)
          SELECT OLD.rel_path, OLD.kind, 1
          WHERE OLD.kind IN ('md', 'pdf')
            AND (OLD.rel_path <> NEW.rel_path OR OLD.kind <> NEW.kind)
          ON CONFLICT(rel_path, kind) DO UPDATE
          SET revision = source_revision.revision + 1;

          INSERT INTO source_revision (rel_path, kind, revision)
          SELECT NEW.rel_path, NEW.kind, 1
          WHERE NEW.kind IN ('md', 'pdf')
          ON CONFLICT(rel_path, kind) DO UPDATE
          SET revision = source_revision.revision + 1;
        END;

        CREATE TRIGGER IF NOT EXISTS source_quarantine_revision_delete
        AFTER DELETE ON source_quarantine
        WHEN OLD.kind IN ('md', 'pdf')
        BEGIN
          INSERT INTO source_revision (rel_path, kind, revision)
          VALUES (OLD.rel_path, OLD.kind, 1)
          ON CONFLICT(rel_path, kind) DO UPDATE
          SET revision = source_revision.revision + 1;
        END;
      `);

      // writeMeta inside the same transaction — keeps meta + schema
      // atomically in sync. (writeMeta opens its own nested transaction,
      // but better-sqlite3 handles nesting via savepoints.)
      this.writeMeta({
        schema_version: String(FTS_SCHEMA_VERSION),
        vault_root: this.vaultRoot,
        tokenize_mode: this.tokenize
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
    // v3.7.19 γ1 — wrap multi-key INSERT in db.transaction(). Pre-3.7.19
    // the loop ran N independent INSERTs; a crash / SIGKILL between them
    // left meta partially-updated, causing the next open to see e.g.
    // schema_version bumped but tokenize_mode stale — bootstrapSchema
    // would then drift on the inconsistent state. Sibling of v3.7.18 R-8
    // (same class — non-transactional DB ops).
    const txn = db.transaction(() => {
      for (const [k, v] of Object.entries(kv)) stmt.run(k, v);
    });
    txn();
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
    const quarantinedRows =
      kind !== undefined
        ? db.prepare("SELECT rel_path FROM source_quarantine WHERE kind = ?").all<{ rel_path: string }>(kind)
        : db.prepare("SELECT rel_path FROM source_quarantine").all<{ rel_path: string }>();
    const quarantined = new Set(quarantinedRows.map((row) => row.rel_path));
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
      else if (prev !== mtimeMs || quarantined.has(relPath)) updated.push(relPath);
      else unchanged.push(relPath);
    }
    const deleted = new Set<string>();
    for (const relPath of storedMap.keys()) if (!live.has(relPath)) deleted.add(relPath);
    for (const relPath of quarantined) if (!live.has(relPath)) deleted.add(relPath);

    return { added, updated, deleted: [...deleted], unchanged };
  }

  /**
   * Hide a source's retained rows from every public FTS read until the same
   * source is successfully reindexed or dropped. The marker is durable so a
   * failed refresh cannot become visible again after process restart.
   *
   * @param relPath - Vault-relative source path whose indexed bytes are stale.
   * @param kind - Content-source kind; defaults to Markdown for watcher/sync callers.
   * @returns Nothing.
   * @example
   * ```ts
   * index.quarantineFile("Private/rotated.md");
   * ```
   */
  quarantineFile(relPath: string, kind: ChunkKind = "md"): void {
    if (!isChunkKind(kind)) throw new Error(`Unsupported FTS source kind: ${String(kind)}`);
    const db = this.requireDb();
    db.prepare("INSERT OR IGNORE INTO source_quarantine (rel_path, kind) VALUES (?, ?)").run(relPath, kind);
  }

  /**
   * Verify a bounded receipt batch in one synchronous SQLite read snapshot.
   * Empty input returns immediately. Oversized input is rejected before any
   * allocation or SQLite work; malformed entries receive false verdicts while
   * preserving positional association for the accepted batch.
   *
   * @param receipts - Persisted source receipts to verify, in caller order.
   * @returns One current/not-current verdict per accepted input receipt.
   * @throws {RangeError} If more than 512 receipts are supplied.
   * @example
   * ```ts
   * const current = index.currentSourceReceiptMask(index.searchWithReceipts("retrieval"));
   * ```
   */
  currentSourceReceiptMask(receipts: readonly FtsSourceReceipt[]): boolean[] {
    if (!Array.isArray(receipts)) return [];
    if (receipts.length === 0) return [];
    if (receipts.length > MAX_SOURCE_RECEIPT_BATCH) {
      throw new RangeError(`FTS source receipt batch exceeds ${MAX_SOURCE_RECEIPT_BATCH} entries`);
    }
    const db = this.requireDb();
    const current = db.prepare(
      `SELECT 1 AS current
       FROM source_state AS state
       JOIN source_revision AS ledger
         ON ledger.rel_path = state.rel_path
        AND ledger.kind = state.kind
       WHERE state.rel_path = ?
         AND state.kind = ?
         AND state.kind IN ('md', 'pdf')
         AND typeof(state.mtime_ms) IN ('integer', 'real')
         AND state.mtime_ms = ?
         AND typeof(ledger.revision) = 'integer'
         AND ledger.revision BETWEEN 1 AND ${MAX_SOURCE_REVISION}
         AND ledger.revision = ?
         AND NOT EXISTS (
           SELECT 1
           FROM source_quarantine AS quarantined
           WHERE quarantined.rel_path = state.rel_path
             AND quarantined.kind = state.kind
         )
       LIMIT 1`
    );
    const readSnapshot = db.transaction((): boolean[] =>
      receipts.map((receipt) => {
        if (
          typeof receipt !== "object" ||
          receipt === null ||
          typeof receipt.rel_path !== "string" ||
          receipt.rel_path.length === 0 ||
          !isChunkKind(receipt.kind) ||
          !Number.isFinite(receipt.indexed_mtime_ms) ||
          Math.abs(receipt.indexed_mtime_ms) > MAX_SOURCE_REVISION ||
          !Number.isSafeInteger(receipt.indexed_revision) ||
          receipt.indexed_revision < 1
        ) {
          return false;
        }
        return (
          current.get<{ current: 1 }>(
            receipt.rel_path,
            receipt.kind,
            receipt.indexed_mtime_ms,
            receipt.indexed_revision
          )?.current === 1
        );
      })
    );
    return readSnapshot();
  }

  /**
   * Verify that one internal FTS receipt still names the source generation
   * currently eligible for egress. The monotonic revision closes same-mtime
   * replacement and delete/re-add ABA gaps that an mtime-only comparison
   * cannot distinguish. This convenience wrapper uses the same atomic batch
   * verifier as multi-hit callers.
   *
   * @param relPath - Vault-relative source path carried by the hit.
   * @param kind - Content-source kind carried by the hit.
   * @param indexedMtimeMs - Source mtime committed with the indexed bytes.
   * @param indexedRevision - Monotonic revision committed with the indexed bytes.
   * @returns True only for a finite, safe, non-quarantined current receipt.
   * @example
   * ```ts
   * const hit = index.searchWithReceipts("retrieval", { limit: 1 })[0];
   * const current = hit
   *   ? index.isCurrentSourceReceipt(hit.rel_path, hit.kind, hit.indexed_mtime_ms, hit.indexed_revision)
   *   : false;
   * ```
   */
  isCurrentSourceReceipt(relPath: string, kind: ChunkKind, indexedMtimeMs: number, indexedRevision: number): boolean {
    return (
      this.currentSourceReceiptMask([
        {
          rel_path: relPath,
          kind,
          indexed_mtime_ms: indexedMtimeMs,
          indexed_revision: indexedRevision
        }
      ])[0] === true
    );
  }

  /**
   * Audit the physical FTS rows for one content kind without mutating them.
   *
   * A declared file is complete only when it has a positive integer
   * `n_chunks`, the same number of physical rows, and one valid row at every
   * integer index in `0..n_chunks - 1`. The audit also rejects invalid line
   * ranges or raw-content storage, chunk-only paths, a different kind on a
   * declared path, missing/invalid source revisions, quarantine markers for
   * the requested kind, and invalid kinds anywhere in the index. Those global
   * checks deliberately fail closed so a scoped markdown or PDF audit cannot
   * certify an index whose other rows have unknown provenance.
   *
   * @param kind - Content-source kind to audit.
   * @returns Declared and physical file/chunk counts plus the number of
   *   unique mismatched paths.
   * @example
   * ```ts
   * const audit = idx.auditKind("md");
   * if (audit.mismatched_files > 0) {
   *   throw new Error("FTS index is physically incomplete");
   * }
   * ```
   */
  auditKind(kind: ChunkKind): FtsKindAudit {
    if (!isChunkKind(kind)) throw new Error(`Unsupported FTS source kind: ${String(kind)}`);
    const db = this.requireDb();
    const row = db
      .prepare(
        `WITH declared AS (
           SELECT state.rel_path, state.mtime_ms, state.n_chunks, ledger.revision
           FROM source_state AS state
           LEFT JOIN source_revision AS ledger
             ON ledger.rel_path = state.rel_path
            AND ledger.kind = state.kind
           WHERE state.kind = ?
         ),
         actual AS (
           SELECT
             rel_path,
             COUNT(*) AS actual_count,
             COUNT(DISTINCT chunk_index) AS distinct_index_count,
             MIN(chunk_index) AS min_index,
             MAX(chunk_index) AS max_index,
             SUM(
               CASE
                 WHEN typeof(rel_path) <> 'text'
                   OR rel_path = ''
                   OR typeof(content) <> 'text'
                   OR length(content) = 0
                   OR typeof(title) <> 'text'
                   OR typeof(aliases) <> 'text'
                   OR typeof(scope_tokens) <> 'text'
                   OR scope_tokens <> ('s' || lower(hex(CAST(rel_path AS BLOB))))
                   OR typeof(chunk_index) NOT IN ('integer', 'real')
                   OR chunk_index <> CAST(chunk_index AS INTEGER)
                   OR chunk_index < 0
                   OR typeof(line_start) NOT IN ('integer', 'real')
                   OR line_start <> CAST(line_start AS INTEGER)
                   OR typeof(line_end) NOT IN ('integer', 'real')
                   OR line_end <> CAST(line_end AS INTEGER)
                   OR line_start < 1
                   OR line_end < line_start
                   OR typeof(tags) <> 'text'
                   OR typeof(raw_content) <> 'text'
                   OR length(raw_content) = 0
                 THEN 1
                 ELSE 0
               END
             ) AS invalid_row_count
           FROM chunks
           WHERE kind = ?
           GROUP BY rel_path
         ),
         mismatched AS (
           SELECT d.rel_path
           FROM declared AS d
           LEFT JOIN actual AS a ON a.rel_path = d.rel_path
           WHERE
             typeof(d.rel_path) <> 'text'
             OR d.rel_path = ''
             OR typeof(d.mtime_ms) NOT IN ('integer', 'real')
             OR d.mtime_ms NOT BETWEEN -${MAX_SOURCE_REVISION} AND ${MAX_SOURCE_REVISION}
             OR typeof(d.n_chunks) <> 'integer'
             OR d.n_chunks <= 0
             OR typeof(d.revision) <> 'integer'
             OR d.revision NOT BETWEEN 1 AND ${MAX_SOURCE_REVISION}
             OR COALESCE(a.actual_count, 0) <> d.n_chunks
             OR COALESCE(a.distinct_index_count, 0) <> d.n_chunks
             OR COALESCE(a.invalid_row_count, 0) <> 0
             OR (d.n_chunks > 0 AND (a.min_index <> 0 OR a.max_index <> d.n_chunks - 1))
           UNION
           SELECT a.rel_path
           FROM actual AS a
           LEFT JOIN declared AS d ON d.rel_path = a.rel_path
           WHERE d.rel_path IS NULL
           UNION
           SELECT c.rel_path
           FROM chunks AS c
           INNER JOIN declared AS d ON d.rel_path = c.rel_path
           WHERE c.kind <> ?
           UNION
           SELECT rel_path
           FROM chunks
           WHERE typeof(kind) <> 'text' OR kind NOT IN ('md', 'pdf')
           UNION
           SELECT rel_path
           FROM source_state
           WHERE typeof(kind) <> 'text' OR kind NOT IN ('md', 'pdf')
           UNION
           SELECT rel_path
           FROM source_quarantine
           WHERE kind = ?
              OR typeof(kind) <> 'text'
              OR kind NOT IN ('md', 'pdf')
           UNION
           SELECT rel_path
           FROM source_revision
           WHERE (kind = ? AND (
                typeof(rel_path) <> 'text'
                OR rel_path = ''
                OR typeof(revision) <> 'integer'
                OR revision NOT BETWEEN 1 AND ${MAX_SOURCE_REVISION}
              ))
              OR typeof(kind) <> 'text'
              OR kind NOT IN ('md', 'pdf')
         )
         SELECT
           (SELECT COUNT(*) FROM declared) AS declared_files,
           (SELECT COUNT(*) FROM actual) AS indexed_files,
           COALESCE((SELECT SUM(n_chunks) FROM declared), 0) AS declared_chunks,
           COALESCE((SELECT SUM(actual_count) FROM actual), 0) AS indexed_chunks,
           (SELECT COUNT(*) FROM mismatched) AS mismatched_files`
      )
      .get<FtsKindAudit>(kind, kind, kind, kind, kind);
    return (
      row ?? {
        declared_files: 0,
        indexed_files: 0,
        declared_chunks: 0,
        indexed_chunks: 0,
        mismatched_files: 0
      }
    );
  }

  /**
   * Hash the exact physical source declarations and FTS chunk payload for one
   * content kind without materializing all rows in memory.
   *
   * The manifest is intended for before/after integrity checks in strict
   * evidence runs. It includes source mtimes, monotonic revision tombstones,
   * timestamps, every stored searchable/metadata column, and durable
   * quarantine markers, so an in-place mutation that keeps aggregate counts
   * unchanged still changes the digest.
   *
   * @param kind - Content-source kind to fingerprint.
   * @returns Lowercase SHA-256 digest of the ordered physical rows.
   */
  fingerprintKind(kind: ChunkKind): string {
    if (!isChunkKind(kind)) throw new Error(`Unsupported FTS source kind: ${String(kind)}`);
    const db = this.requireDb();
    const hash = createHash("sha256");
    hash.update("enquire-fts-kind-manifest-v2;");
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
      .prepare(
        `SELECT rel_path, kind, revision
         FROM source_revision
         WHERE kind = ?
         ORDER BY rel_path`
      )
      .iterate<{ rel_path: string; kind: string; revision: number }>(kind)) {
      hash.update("revision;");
      updateManifestValue(hash, row.rel_path);
      updateManifestValue(hash, row.kind);
      updateManifestValue(hash, row.revision);
    }
    for (const row of db
      .prepare(
        `SELECT rel_path, kind
         FROM source_quarantine
         WHERE kind = ?
         ORDER BY rel_path`
      )
      .iterate<{ rel_path: string; kind: string }>(kind)) {
      hash.update("quarantine;");
      updateManifestValue(hash, row.rel_path);
      updateManifestValue(hash, row.kind);
    }
    for (const row of db
      .prepare(
        `SELECT content, title, aliases, scope_tokens, rel_path, chunk_index,
                line_start, line_end, tags, raw_content, kind
         FROM chunks
         WHERE kind = ?
         ORDER BY rel_path, chunk_index, rowid`
      )
      .iterate<{
        content: string;
        title: string;
        aliases: string;
        scope_tokens: string;
        rel_path: string;
        chunk_index: number;
        line_start: number;
        line_end: number;
        tags: string;
        raw_content: string;
        kind: string;
      }>(kind)) {
      hash.update("chunk;");
      updateManifestValue(hash, row.content);
      updateManifestValue(hash, row.title);
      updateManifestValue(hash, row.aliases);
      updateManifestValue(hash, row.scope_tokens);
      updateManifestValue(hash, row.rel_path);
      updateManifestValue(hash, row.chunk_index);
      updateManifestValue(hash, row.line_start);
      updateManifestValue(hash, row.line_end);
      updateManifestValue(hash, row.tags);
      updateManifestValue(hash, row.raw_content);
      updateManifestValue(hash, row.kind);
    }
    return hash.digest("hex");
  }

  /** Drop a file's chunks, state row, and quarantine marker. Idempotent.
   *
   * v3.7.18 R-8 — wrapped in `db.transaction()` for atomicity. Pre-3.7.18
   * the two DELETE statements ran independently; a crash / SIGKILL / DB
   * lock contention between them could leave `source_state` saying "this
   * file is indexed at mtime X" while `chunks` had no rows — causing the
   * next watcher event to skip re-indexing (state matches) but search to
   * miss the file (no chunks). Sibling of v3.7.10 audit #10 fix that
   * wrapped `reindexFile` / `reindexPdfFile` / source_state in a txn for
   * the same reason. Caught by round-20 external audit.
   */
  dropFile(relPath: string): void {
    const db = this.requireDb();
    const txn = db.transaction(() => {
      db.prepare("DELETE FROM chunks WHERE chunks MATCH ? AND rel_path = ?").run(
        `scope_tokens : ${ftsPathToken(relPath)}`,
        relPath
      );
      db.prepare("DELETE FROM source_state WHERE rel_path = ?").run(relPath);
      db.prepare("DELETE FROM source_quarantine WHERE rel_path = ?").run(relPath);
    });
    txn();
  }

  /** Re-chunk a single markdown file, replacing its existing chunks atomically.
   *
   * v3.7.10 (external audit #10) — wrapped DELETE + N×INSERT + source_state
   * UPDATE in a single SQLite transaction. Pre-fix a crash/error between
   * statements could leave partially-updated chunks (some new, some stale)
   * with a stale source_state row pointing at the wrong chunk count. The
   * transaction guarantees all-or-nothing atomicity. better-sqlite3
   * `db.transaction()` wraps + auto-rolls back on throw.
   */
  reindexFile(
    relPath: string,
    mtimeMs: number,
    content: string,
    wikilinkTargets: string[] = [],
    tags: string[] = [],
    // v3.11.6-rc.6 (C-3) — the note's title + frontmatter aliases, stored in the
    // weighted FTS5 `title`/`aliases` columns so a title/alias match outranks a
    // body-only match. Default "" / [] keeps older callers valid (they simply get
    // no title/alias boost until they pass them).
    title = "",
    aliases: string[] = []
  ): number {
    const db = this.requireDb();
    const chunks = chunkContent(content);
    const tagsSerialized = tags.length ? tags.join(",") : "";
    const aliasesSerialized = aliases.length ? aliases.join(" ") : "";
    const scopeTokens = ftsScopeTokens(relPath);
    const txn = db.transaction(() => {
      db.prepare("DELETE FROM chunks WHERE chunks MATCH ? AND rel_path = ?").run(
        `scope_tokens : ${ftsPathToken(relPath)}`,
        relPath
      );
      const insert = db.prepare(
        "INSERT INTO chunks (content, title, aliases, scope_tokens, rel_path, chunk_index, line_start, line_end, tags, raw_content, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'md')"
      );
      // `tags` is a comma-delimited list so the filter LIKE pattern can wrap it
      // with leading/trailing commas for exact-tag matching at query time.
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
        // v3.11.6-rc.6 re-sweep fix: store title/aliases ONLY on chunk 0, not
        // every chunk. Repeating them per-chunk made a title/alias-matching query
        // score ALL of a note's chunks high (10×/5× weight) — a single large note
        // could then flood the fixed BM25 candidate set (fanOutK) and evict other
        // notes' body chunks. One title-boosted chunk per note surfaces the note
        // for a title/alias match (best-chunk-per-note collapse picks it) without
        // the saturation, and also removes the per-chunk IDF dilution + storage cost.
        insert.run(
          enriched,
          i === 0 ? title : "",
          i === 0 ? aliasesSerialized : "",
          scopeTokens,
          relPath,
          i,
          c.lineStart,
          c.lineEnd,
          tagsSerialized,
          c.text
        );
      });
      db.prepare(
        `INSERT INTO source_state (rel_path, mtime_ms, n_chunks, kind, indexed_at)
         VALUES (?, ?, ?, 'md', ?)
         ON CONFLICT(rel_path) DO UPDATE SET
           mtime_ms = excluded.mtime_ms,
           n_chunks = excluded.n_chunks,
           kind = excluded.kind,
           indexed_at = excluded.indexed_at`
      ).run(relPath, mtimeMs, chunks.length, new Date().toISOString());
      db.prepare("DELETE FROM source_quarantine WHERE rel_path = ?").run(relPath);
    });
    txn();
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
    // v3.11.6-rc.6 (C-3) — a PDF has no frontmatter aliases, but its filename IS
    // its title; index it in the weighted `title` column so a PDF is findable by
    // name even when the query terms aren't in the extracted page text.
    const pdfTitle = path.basename(relPath).replace(/\.pdf$/i, "");
    const scopeTokens = ftsScopeTokens(relPath);
    // v3.7.10 (external audit #10) — same transaction wrapper as
    // reindexFile(). See its TSDoc for rationale.
    const txn = db.transaction(() => {
      db.prepare("DELETE FROM chunks WHERE chunks MATCH ? AND rel_path = ?").run(
        `scope_tokens : ${ftsPathToken(relPath)}`,
        relPath
      );
      const insert = db.prepare(
        "INSERT INTO chunks (content, title, aliases, scope_tokens, rel_path, chunk_index, line_start, line_end, tags, raw_content, kind) VALUES (?, ?, '', ?, ?, ?, ?, ?, '', ?, 'pdf')"
      );
      chunks.forEach((c, i) => {
        // No wikilink/tag enrichment for PDFs (they don't have either). The
        // page marker is already in c.text so it shows up in snippets.
        // rc.6 re-sweep: title on chunk 0 only (see reindexFile) to avoid the
        // per-chunk title-match candidate-set saturation.
        insert.run(c.text, i === 0 ? pdfTitle : "", scopeTokens, relPath, i, c.lineStart, c.lineEnd, c.text);
      });
      db.prepare(
        `INSERT INTO source_state (rel_path, mtime_ms, n_chunks, kind, indexed_at)
         VALUES (?, ?, ?, 'pdf', ?)
         ON CONFLICT(rel_path) DO UPDATE SET
           mtime_ms = excluded.mtime_ms,
           n_chunks = excluded.n_chunks,
           kind = excluded.kind,
           indexed_at = excluded.indexed_at`
      ).run(relPath, mtimeMs, chunks.length, new Date().toISOString());
      db.prepare("DELETE FROM source_quarantine WHERE rel_path = ?").run(relPath);
    });
    txn();
    return chunks.length;
  }

  /**
   * BM25-ranked search with the stable, receipt-free public result shape.
   * This compatibility wrapper applies the same provenance and quarantine
   * joins as {@link searchWithReceipts}, then strips internal receipt fields.
   *
   * @param rawQuery - User query string. Whitespace-only returns `[]`.
   * @param opts.limit - Max results. Default 25.
   * @param opts.folder - Vault-relative prefix filter.
   * @param opts.tag - Exact-tag membership filter.
   * @param opts.sinceMtimeMs - Recency filter in source mtime milliseconds.
   * @returns Receipt-free hits sorted by descending score.
   * @example
   * ```ts
   * const hits = index.search("vector retrieval", { limit: 25 });
   * ```
   */
  search(
    rawQuery: string,
    opts: { limit?: number; folder?: string; tag?: string; sinceMtimeMs?: number } = {}
  ): FtsSearchHit[] {
    return this.searchWithReceipts(rawQuery, opts).map((hit) => ({
      rel_path: hit.rel_path,
      chunk_index: hit.chunk_index,
      line_start: hit.line_start,
      line_end: hit.line_end,
      snippet: hit.snippet,
      score: hit.score,
      kind: hit.kind
    }));
  }

  /**
   * BM25-ranked search over chunk content with persisted source receipts.
   * Folder + tag + recency filters
   * are pushed down to the SQL layer. Hyphenated identifiers (e.g.
   * `"claude-telegram"`) are quote-escaped via {@link safeFts5Query} so
   * FTS5 doesn't interpret `-` as the `NOT` operator.
   *
   * @param rawQuery - User query string. Whitespace-only returns `[]`.
   * @param opts.limit - Max results. Default 25.
   * @param opts.folder - Vault-relative prefix filter.
   * @param opts.tag - Exact-tag membership filter (only matches the full
   *   tag, not `core-team` for `core`).
   * @param opts.sinceMtimeMs - Recency filter — only return chunks from
   *   files modified at or after this mtime.
   * @returns Provenance-bound, non-quarantined hits sorted by descending
   *   score. Each hit carries the `source_state` mtime and monotonic revision
   *   committed with its indexed bytes; callers that own a live {@link Vault}
   *   must compare both before exposing persisted text. Empty array if no
   *   usable query tokens or no matches.
   * @example
   * ```ts
   * const hits = index.searchWithReceipts("vector retrieval", { limit: 25 });
   * const current = index.currentSourceReceiptMask(hits);
   * ```
   */
  searchWithReceipts(
    rawQuery: string,
    opts: { limit?: number; folder?: string; tag?: string; sinceMtimeMs?: number } = {}
  ): FtsReceiptSearchHit[] {
    const db = this.requireDb();
    const limit = opts.limit ?? 25;
    const safe = safeFts5Query(rawQuery);
    if (!safe) return [];
    let matchQuery = `{content title aliases} : (${safe})`;
    const where: string[] = [
      "chunks MATCH ?",
      "chunks.kind IN ('md', 'pdf')",
      "typeof(source_state.mtime_ms) IN ('integer', 'real')",
      `source_state.mtime_ms BETWEEN -${MAX_SOURCE_REVISION} AND ${MAX_SOURCE_REVISION}`,
      "typeof(source_revision.revision) = 'integer'",
      `source_revision.revision BETWEEN 1 AND ${MAX_SOURCE_REVISION}`,
      `NOT EXISTS (
        SELECT 1
        FROM source_quarantine AS quarantined
        WHERE quarantined.rel_path = chunks.rel_path
          AND quarantined.kind = chunks.kind
      )`
    ];
    const params: unknown[] = [matchQuery];
    if (opts.folder) {
      // Prefix-equality via substr — avoids GLOB pattern semantics so folder
      // names containing `*`, `?`, `[`, `]` (rare but possible in Obsidian)
      // don't expand into wider matches.
      // v3.11.0-rc.14 (CodeQL js/polynomial-redos #13, HIGH) — linear strip. The old
      // `replace(/\/+$/, "")` WAS exploitable: O(n²) on `/`×n + a non-slash char via the
      // bearer-reachable `folder` arg (measured a multi-second V8 hang). The prior
      // "$ anchor ⇒ O(n)" note was wrong — it held only for all-slash input.
      const prefix = `${stripTrailingSlashes(opts.folder)}/`;
      // rc.43 M1 — let SQLite compute the prefix length via length() (which counts
      // CHARACTERS, exactly like substr's 3rd arg). Binding JS `prefix.length` (UTF-16
      // code UNITS) diverged for any folder name with an astral-plane char (emoji): e.g.
      // "📚Books/" has JS length 8 but occupies 7 code points, so substr(rel_path,1,8)
      // over-read by one and matched ZERO rows. Bind the prefix string twice instead.
      // v6: intersect the content query with an indexed ancestor-folder token.
      // The residual rel_path predicate preserves exact path semantics; the
      // token makes FTS5 visit only the requested subtree's term hits.
      matchQuery = `(${matchQuery}) AND scope_tokens : ${ftsFolderToken(opts.folder)}`;
      params[0] = matchQuery;
      where.push("substr(chunks.rel_path, 1, length(?)) = ?");
      params.push(prefix, prefix);
    }
    if (opts.tag) {
      // Exact-tag membership inside the comma-separated `tags` column —
      // wrap both sides with commas so "core" doesn't match "core-team".
      //
      // v3.7.16 P2-15 — escape `%` and `_` (SQL LIKE wildcards) so a
      // user-supplied tag with those characters matches LITERALLY. Pre-
      // 3.7.16 a tag like `core_team` would match `coreXteam` (and any
      // other 1-char-substituted variant) because `_` is the LIKE 1-char
      // wildcard; `%` was even worse — `tag: "%"` matched every chunk.
      // ESCAPE clause uses backslash, matching SQLite's standard form.
      const literalTag = opts.tag.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
      where.push("(',' || chunks.tags || ',') LIKE ? ESCAPE '\\'");
      params.push(`%,${literalTag},%`);
    }
    const join = `JOIN source_state
                    ON chunks.rel_path = source_state.rel_path
                   AND chunks.kind = source_state.kind
                  JOIN source_revision
                    ON chunks.rel_path = source_revision.rel_path
                   AND chunks.kind = source_revision.kind`;
    if (opts.sinceMtimeMs !== undefined) {
      where.push("source_state.mtime_ms >= ?");
      params.push(opts.sinceMtimeMs);
    }
    const sql = `
      SELECT chunks.rel_path AS rel_path, chunks.chunk_index AS chunk_index,
             chunks.line_start AS line_start, chunks.line_end AS line_end,
             chunks.kind AS kind,
             source_state.mtime_ms AS indexed_mtime_ms,
             source_revision.revision AS indexed_revision,
             snippet(chunks, 0, '«', '»', '…', 25) AS snippet,
             bm25(chunks, ${BM25_WEIGHT_CONTENT}, ${BM25_WEIGHT_TITLE}, ${BM25_WEIGHT_ALIASES}, ${BM25_WEIGHT_SCOPE}) AS score
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
      indexed_mtime_ms: number;
      indexed_revision: number;
      snippet: string;
      score: number;
    }>(...params);
    return rows.map((r) => ({
      rel_path: r.rel_path,
      chunk_index: r.chunk_index,
      line_start: r.line_start,
      line_end: r.line_end,
      // v2.8.0: kind defaults to "md" for chunks indexed before the schema
      // bump (legacy DBs auto-rebuild via a schema-version mismatch, but the
      // null fallback is defense-in-depth).
      kind: (r.kind === "pdf" ? "pdf" : "md") as ChunkKind,
      indexed_mtime_ms: r.indexed_mtime_ms,
      indexed_revision: r.indexed_revision,
      snippet: r.snippet,
      score: -r.score // BM25 is negative; flip so higher = better for callers
    }));
  }

  /**
   * Fetch a single raw chunk with the stable receipt-free public shape.
   * This compatibility wrapper delegates to {@link getChunkWithReceipt} and
   * strips the internal authority fields.
   *
   * @param relPath - Exact vault-relative source path from a prior FTS hit.
   * @param chunkIndex - Zero-based chunk index within that source.
   * @returns Verbatim chunk content and line bounds, or null when unavailable.
   * @example
   * ```ts
   * const chunk = index.getChunk("Projects/plan.md", 0);
   * ```
   */
  getChunk(relPath: string, chunkIndex: number): { content: string; line_start: number; line_end: number } | null {
    const chunk = this.getChunkWithReceipt(relPath, chunkIndex);
    return chunk
      ? {
          content: chunk.content,
          line_start: chunk.line_start,
          line_end: chunk.line_end
        }
      : null;
  }

  /**
   * Fetch a receipt-bound chunk by (rel_path, chunk_index). Backs the
   * `obsidian://chunk/{chunkIndex}/{+notePath}` resource so MCP clients can
   * deep-link into specific chunks returned by a prior search. Returns the
   * RAW chunk text (the unenriched original); the FTS5 `content` column
   * additionally carries a synthetic wikilink-targets meta-line for recall,
   * which would otherwise pollute resource responses (audit v0.10.4 P1). The
   * returned source mtime and monotonic revision are selected in the same SQL
   * snapshot as the bytes; callers that own a live {@link Vault} must compare
   * both before exposing persisted content.
   *
   * @param relPath - Exact vault-relative source path from a prior FTS hit.
   * @param chunkIndex - Zero-based chunk index within that source.
   * @returns Receipt-bound raw content, or null when the row is absent,
   *   orphaned, invalid-kind, or quarantined.
   * @example
   * ```ts
   * const chunk = index.getChunkWithReceipt("Projects/plan.md", 0);
   * ```
   */
  getChunkWithReceipt(relPath: string, chunkIndex: number): FtsReceiptChunk | null {
    const db = this.requireDb();
    const sql = `
      SELECT chunks.rel_path AS rel_path, chunks.raw_content AS content, chunks.line_start AS line_start,
             chunks.line_end AS line_end, chunks.kind AS kind,
             source_state.mtime_ms AS indexed_mtime_ms,
             source_revision.revision AS indexed_revision
      FROM chunks
      JOIN source_state
        ON chunks.rel_path = source_state.rel_path
       AND chunks.kind = source_state.kind
      JOIN source_revision
        ON chunks.rel_path = source_revision.rel_path
       AND chunks.kind = source_revision.kind
      WHERE chunks MATCH ?
        AND chunks.rel_path = ?
        AND chunks.chunk_index = ?
        AND chunks.kind IN ('md', 'pdf')
        AND typeof(source_state.mtime_ms) IN ('integer', 'real')
        AND source_state.mtime_ms BETWEEN -${MAX_SOURCE_REVISION} AND ${MAX_SOURCE_REVISION}
        AND typeof(source_revision.revision) = 'integer'
        AND source_revision.revision BETWEEN 1 AND ${MAX_SOURCE_REVISION}
        AND NOT EXISTS (
          SELECT 1
          FROM source_quarantine AS quarantined
          WHERE quarantined.rel_path = chunks.rel_path
            AND quarantined.kind = chunks.kind
        )`;
    const row = db.prepare(sql).get<{
      rel_path: string;
      content: string;
      line_start: number;
      line_end: number;
      kind: ChunkKind;
      indexed_mtime_ms: number;
      indexed_revision: number;
    }>(`scope_tokens : ${ftsPathToken(relPath)}`, relPath, chunkIndex);
    return row ?? null;
  }

  /** Total chunks across the index. Used by stats / banner / UI. */
  totalChunks(): number {
    const db = this.requireDb();
    const row = db.prepare("SELECT COUNT(*) AS c FROM chunks").get<{ c: number }>();
    return row?.c ?? 0;
  }

  /** Total source files (notes + PDFs) tracked in `source_state`. Used by
   *  the ready banner so users can verify the index actually built. */
  totalFiles(): number {
    const db = this.requireDb();
    const row = db.prepare("SELECT COUNT(*) AS c FROM source_state").get<{ c: number }>();
    return row?.c ?? 0;
  }
}

/**
 * Incrementally synchronize Markdown notes into an opened FTS5 index.
 *
 * Product startup uses the default fail-soft mode so one unreadable note does
 * not take down the server. Evidence-producing benchmarks pass `strict`,
 * which aborts on the first read/index failure or zero-chunk note and verifies
 * the final `source_state`/physical-row equations before returning.
 *
 * @param vault - Vault whose visible Markdown notes form the live source set.
 * @param idx - Open FTS index to update and, in strict mode, physically audit.
 * @param opts.mode - Error policy; defaults to `"fail-soft"`.
 * @returns Raw counters. Strict mode also returns the full physical audit and
 *   manifest; fail-soft mode marks `audited:false`, leaves audit counters at
 *   zero, and returns a null manifest to avoid an O(all rows) startup scan.
 * @throws {Error} In strict mode when a file cannot be indexed or the final
 *   audit is incomplete.
 * @example
 * ```ts
 * const report = await syncFtsIndex(vault, index, { mode: "strict" });
 * if (!report.complete) throw new Error("incomplete FTS index");
 * ```
 */
export async function syncFtsIndex(
  vault: Vault,
  idx: FtsIndex,
  opts: { mode?: FtsSyncMode } = {}
): Promise<FtsSyncReport> {
  const mode = opts.mode ?? "fail-soft";
  const entries = await vault.listMarkdown();
  const live = entries.map((entry) => ({ relPath: entry.relPath, mtimeMs: entry.mtimeMs }));
  const diff = idx.diff(live, "md");
  const entriesByPath = new Map(entries.map((entry) => [entry.relPath, entry]));
  const addedPaths = new Set(diff.added);
  let added = 0;
  let updated = 0;
  let empty = 0;
  let failed = 0;
  let processed = diff.unchanged.length;
  for (const relPath of [...diff.added, ...diff.updated]) {
    const entry = entriesByPath.get(relPath);
    if (!entry) continue;
    try {
      const note = await vault.readNote(entry.absPath, entry.mtimeMs);
      if (chunkContent(note.content).length === 0) {
        empty += 1;
        processed += 1;
        if (mode === "strict") throw new Error(`${relPath} produced zero FTS chunks`);
        idx.dropFile(relPath);
        continue;
      }
      const wikilinkTargets = note.parsed.wikilinks
        .map((wikilink) => wikilink.target)
        .filter((target) => target.length > 0);
      const indexedChunks = idx.reindexFile(
        relPath,
        entry.mtimeMs,
        note.content,
        wikilinkTargets,
        note.parsed.tags,
        deriveFtsTitle(relPath),
        extractAliases(note.parsed.frontmatter)
      );
      if (indexedChunks <= 0) throw new Error(`${relPath} produced zero FTS chunks after validation`);
      processed += 1;
      if (addedPaths.has(relPath)) added += 1;
      else updated += 1;
    } catch (error) {
      idx.quarantineFile(relPath, "md");
      if (mode === "strict") throw error;
      failed += 1;
      processed += 1;
      process.stderr.write(
        `enquire: skipping ${relPath} during fts5 sync — ${error instanceof Error ? error.message : String(error)}\n`
      );
    }
  }
  for (const relPath of diff.deleted) idx.dropFile(relPath);
  const audited = mode === "strict";
  const audit: FtsKindAudit = audited
    ? idx.auditKind("md")
    : {
        declared_files: 0,
        indexed_files: 0,
        declared_chunks: 0,
        indexed_chunks: 0,
        mismatched_files: 0
      };
  const manifestSha256 = audited ? idx.fingerprintKind("md") : null;
  const complete =
    audited &&
    processed === entries.length &&
    failed === 0 &&
    empty === 0 &&
    audit.declared_files === entries.length &&
    audit.indexed_files === entries.length &&
    audit.declared_chunks === audit.indexed_chunks &&
    audit.mismatched_files === 0 &&
    (entries.length === 0 || audit.indexed_chunks > 0);
  const report: FtsSyncReport = {
    mode,
    audited,
    added,
    updated,
    deleted: diff.deleted.length,
    unchanged: diff.unchanged.length,
    total_chunks: idx.totalChunks(),
    total_files: entries.length,
    processed_files: processed,
    empty,
    failed,
    ...audit,
    manifest_sha256: manifestSha256,
    complete
  };
  if (mode === "strict" && !complete) {
    throw new Error(
      `FTS sync incomplete (${audit.declared_files}/${entries.length} files, ${audit.indexed_chunks}/${audit.declared_chunks} chunks, ${audit.mismatched_files} mismatches)`
    );
  }
  return report;
}

/**
 * Sanitize a user query for FTS5. Quote-wraps any token containing
 * non-alphanumerics so hyphens / colons / dots are treated literally
 * (without this, `"claude-telegram"` would parse as `claude NOT telegram`).
 *
 * v3.7.16 P3-28 — reserved keywords (`AND`, `OR`, `NOT`, `NEAR`) are
 * QUOTED as literals instead of stripped. Pre-3.7.16 the strip-path
 * silently dropped real query terms ("operating systems AND databases"
 * lost the connective AND user couldn't search for the literal word
 * "AND"). Quoting makes both cases work: FTS5 treats `"AND"` as the
 * literal token rather than the boolean operator.
 *
 * @param q - User query string.
 * @returns Sanitized query ready to pass to FTS5's `MATCH` operator.
 *   Empty string when input is empty / whitespace-only.
 */
export function safeFts5Query(q: string): string {
  const RESERVED = new Set(["AND", "OR", "NOT", "NEAR"]);
  const parts = q.trim().split(/\s+/);
  const out: string[] = [];
  for (const p of parts) {
    if (!p) continue;
    // v3.7.16 P3-28 — quote reserved keywords as literals instead of
    // stripping. Pre-3.7.16 a user searching "operating systems AND
    // databases" got their AND dropped silently AND the unrelated tokens
    // OR'd implicitly — but they ALSO couldn't search literally for the
    // word "AND" (the SQL boolean conjunction). Now we wrap reserved
    // words in double-quotes so FTS5 treats them as the literal token,
    // matching how we handle any token with non-alphanumerics below.
    if (RESERVED.has(p.toUpperCase())) {
      out.push(`"${p}"`);
      continue;
    }
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
        // v3.10.0-rc.55 (CHUNK-SURROGATE-SPLIT) — `slice` works on UTF-16 code
        // UNITS, so a cut landing between a surrogate pair (e.g. mid-emoji) emits a
        // lone surrogate → a corrupt code point in the indexed chunk. If the unit at
        // the boundary is a high surrogate, back the cut off by one so the whole pair
        // moves to the next chunk (a chunk may end up maxChars-1 units in that case).
        for (let i = 0; i < ln.text.length; ) {
          let end = Math.min(i + maxChars, ln.text.length);
          if (end < ln.text.length) {
            const code = ln.text.charCodeAt(end - 1);
            if (code >= 0xd800 && code <= 0xdbff && end - 1 > i) end -= 1;
          }
          chunks.push({
            text: ln.text.slice(i, end),
            lineStart: ln.lineStart,
            lineEnd: ln.lineEnd,
            breadcrumb: p.breadcrumb
          });
          i = end;
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
 *
 * Exported for the v3.11.5-rc.2 inline-span regression test (the fence-toggle
 * sibling of the rc.1 write-path MED).
 */
export function computeBreadcrumbsByLine(content: string): string[] {
  // v3.11.6-rc.2 — delegates to the canonical structure iterator (src/structure.ts), the single
  // fence-walk + heading-parse authority. `breadcrumb` carries fts5's exact heading-stack semantics
  // (a heading line includes itself; a degenerate `# ###` pushes empty), so this is byte-identical
  // to the former hand-rolled walk — pinned by the fence-toggle + breadcrumb behavioral tests.
  return [...iterateContentLines(content)].map((l) => l.breadcrumb.join(" > "));
}

function splitWithLines(text: string, separator: RegExp, baseLine = 1): ContentChunk[] {
  const out: ContentChunk[] = [];
  const re = new RegExp(separator.source, separator.flags.includes("g") ? separator.flags : `${separator.flags}g`);
  let lastIndex = 0;
  let lastLine = baseLine;
  for (const match of text.matchAll(re)) {
    const start = match.index ?? 0;
    const slice = text.slice(lastIndex, start);
    const linesInSlice = countLineBreaks(slice);
    out.push({ text: slice, lineStart: lastLine, lineEnd: lastLine + linesInSlice, breadcrumb: "" });
    lastLine += linesInSlice + countLineBreaks(match[0]);
    lastIndex = start + match[0].length;
  }
  const tail = text.slice(lastIndex);
  if (tail) {
    const linesInTail = countLineBreaks(tail);
    out.push({ text: tail, lineStart: lastLine, lineEnd: lastLine + linesInTail, breadcrumb: "" });
  }
  return out;
}

/**
 * Default location for the FTS5 index file — `~/.cache/enquire/<hash>.fts5.db`
 * (or `$XDG_CACHE_HOME` on Linux). The hash is the first 12 chars of
 * sha1(vaultRoot) so each vault gets its own database.
 *
 * @param vaultRoot - Absolute path to the vault root.
 * @returns Absolute path to the index file.
 */
export function defaultIndexFile(vaultRoot: string): string {
  const base =
    process.env.XDG_CACHE_HOME ??
    (process.platform === "darwin" ? path.join(os.homedir(), "Library", "Caches") : path.join(os.homedir(), ".cache"));
  const hash = createHash("sha1").update(vaultRoot).digest("hex").slice(0, 12);
  return path.join(base, "enquire", `${hash}.fts5.db`);
}

/**
 * Strict filename pattern for enquire's own per-vault cache artifacts:
 * `<12-hex-sha1>.{json,fts5.db,embed.db,hnsw.bin,hnsw.meta.json}` plus the SQLite
 * `-wal`/`-shm` sidecars and the `.tmp` atomic-write leftover. Anchored +
 * exhaustively enumerated so a prune can NEVER select a file enquire didn't
 * create (a user note, another app's cache sharing the dir, etc.) — the safety
 * property of `planCachePrune`.
 *
 * v3.10.0-rc.37 (audit #3 — right-to-erasure) — the `json` family is the
 * `defaultCacheFile` parse cache (`<hash>.json`, written by `saveDiskCache`),
 * which holds the FULL raw body of every note in its vault. It was missing here,
 * so a cross-vault `prune` deleted a decommissioned vault's `.fts5.db`/`.embed.db`/
 * HNSW sidecars but LEFT its `<hash>.json` (+ any `<hash>.json.tmp`) full-text
 * cache on disk forever. Now covered (writers ⊆ erasers — the erasure invariant
 * pins this so a future writer family can't silently escape prune again).
 *
 * v3.11.0 — the `feedback\.json` family is the closed-loop feedback store
 * (`<hash>.feedback.json`, written by `FeedbackStore`; relative note paths +
 * usefulness counts). Listed so a cross-vault `prune` erases a decommissioned
 * vault's feedback (right-to-erasure), like every other per-vault artifact.
 * (`feedback\.json` is listed before `json` for readability; ordering is NOT
 * load-bearing — the alternation is anchored right after the `\.` following the
 * 12-hex hash, so for `<hash>.feedback.json` the `json` alternative is tried at
 * the `f` and can't match the `json` tail; either order matches correctly.)
 */
const ENQUIRE_CACHE_ARTIFACT =
  /^[0-9a-f]{12}\.(feedback\.json|json|fts5\.db|embed\.db|hnsw\.bin|hnsw\.meta\.json)(-wal|-shm|\.tmp)?$/;

/**
 * Plan a cache prune: given the filenames present in enquire's cache directory
 * and the 12-hex hash of the vault to KEEP, return the subset safe to delete —
 * enquire-owned artifacts belonging to OTHER vaults. Pure and side-effect-free,
 * so the destructive `prune` CLI can preview before touching disk and the
 * safety invariant (never selects a non-enquire file, never the kept vault) is
 * unit-testable.
 *
 * @param entries Filenames (basenames) present in the cache directory.
 * @param keepHash The 12-hex vault hash to preserve (from `defaultIndexFile`).
 * @returns Basenames safe to remove — strictly enquire artifacts, never `keepHash`.
 * @example planCachePrune(["aaaaaaaaaaaa.fts5.db", "bbbbbbbbbbbb.fts5.db", "notes.md"], "aaaaaaaaaaaa")
 *   // → ["bbbbbbbbbbbb.fts5.db"]   (keeps aaaa…, ignores notes.md)
 */
export function planCachePrune(entries: readonly string[], keepHash: string): string[] {
  return entries.filter((e) => ENQUIRE_CACHE_ARTIFACT.test(e) && !e.startsWith(`${keepHash}.`));
}

/**
 * v3.6.2 K-1b — non-destructive peek at an existing fts5 index's meta row.
 *
 * Mirror of `peekEmbedDbMeta()` in `src/embed-db.ts`. Reads `tokenize_mode`,
 * `vault_root`, `schema_version` from a SQLite file WITHOUT opening it via
 * `FtsIndex` (which would trigger `bootstrapSchema()` and DROP TABLE on any
 * tokenize-mode mismatch with the caller's declared mode).
 *
 * **Why this exists (audit class K-1b):** the original v3.6.1 CRIT-1 fix
 * (peek-before-open) was applied ONLY to the `serve --use-hnsw` embed-db
 * path. The SAME bootstrap-schema-DROP class affects FtsIndex on
 * `tokenize_mode` mismatch.
 *
 * **Class-closure timeline (retroactive correction batch — see also
 * v3.7.2 audit response for the 4th drift instance: this TSDoc itself
 * previously mis-attributed the closure to v3.6.3):**
 * - v3.6.1 fixed 1 callsite (`server.ts` HNSW path), claimed "CRIT-1
 *   closed". External audit caught 9 residual.
 * - v3.6.2 fixed `server.ts:174` (serve start) + `doctor.ts:328` +
 *   `src/tools/search.ts:917` (3 callsites total). The v3.6.2 CHANGELOG
 *   TL;DR + this TSDoc previously claimed "all 10 callsites" — that
 *   was an overclaim. cli.ts had 5 residual sites.
 * - v3.6.3 was deferred to a marketing-only patch ("memory for AI
 *   agents" positioning); K-1 work was pushed to v3.6.4.
 * - v3.6.4 closes the cli.ts class: `cli.ts:638` (eval, diagnostic class
 *   like doctor), `cli.ts:514,554` (setup, idempotent class), and
 *   `cli.ts:311,398` (index, build-embeddings — peek-and-honor when
 *   user did NOT explicitly pass `--tokenize` / `--embedding-model`).
 *   `clear-index` and `clear-embeddings` call only `.clearOnDisk()` and
 *   never trigger bootstrapSchema — marked `// SAFE BY DESIGN`. Added
 *   `tests/k1-class-invariant.test.ts` (grep gate, 40-line window).
 * - v3.7.0 added `tests/k1-ast-invariant.test.ts` (TypeScript compiler
 *   API def-use trace) catching the "peek called but result discarded"
 *   bypass that grep would miss.
 *
 * **K-1 class is structurally enforced at v3.6.4 (grep) + v3.7.0 (AST).**
 * `tests/k1-class-invariant.test.ts` enforces the grep rule: every
 * `new EmbedDb(...)` / `new FtsIndex(...)` must be preceded by a
 * `peek*Meta` call OR an explicit `// SAFE BY DESIGN` comment within
 * 40 lines. `tests/k1-ast-invariant.test.ts` enforces the deeper rule:
 * the peek result must trace to one of the constructor's K-1-relevant
 * args (modelAlias / dim / tokenize / quantization).
 *
 * Returns null if the file doesn't exist OR doesn't have a `meta` table
 * yet. v3.11.0-rc.9 (audit re-verify) — TSDoc corrected: this NEVER throws
 * (rc.33 wrapped `new Database()` + the meta queries in a catch that maps ANY
 * failure — corrupt / unreadable / not-a-DB / directory / missing dep — to null);
 * it is the pre-open peek on the serve boot path, so a throw would crash serve.
 *
 * @param file - Absolute path to a `.fts5.db` file.
 * @returns Meta dict if the file is a populated fts5 index, null otherwise.
 * @example
 * ```ts
 * const meta = await peekFtsMetaSafe(indexFile);
 * if (meta?.tokenize_mode) {
 *   const idx = new FtsIndex({ file: indexFile, vaultRoot, tokenize: meta.tokenize_mode });
 * }
 * ```
 */
export async function peekFtsMetaSafe(file: string): Promise<{
  schema_version?: string;
  vault_root?: string;
  tokenize_mode?: TokenizeMode;
} | null> {
  const fsMod = await import("node:fs");
  if (!fsMod.existsSync(file)) return null;
  let Database: typeof import("better-sqlite3");
  try {
    Database = (await import("better-sqlite3")).default as unknown as typeof import("better-sqlite3");
  } catch {
    return null;
  }
  // v3.10.0-rc.33 (post-rc.31 audit) — `new Database()` + the meta queries are
  // now INSIDE the try: a "Safe" peek must NEVER throw. Previously a corrupt /
  // unreadable / not-a-DB index file (or a path that is a directory) made
  // `new Database(file)` throw and crashed serve startup at the `--persistent-
  // index` pre-open peek — before the open() fail-soft could catch it. Any
  // failure now → null ("no usable meta"), and the caller degrades to TF-IDF.
  let db: Db | null = null;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true }) as unknown as Db;
    const tableCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'").get();
    if (!tableCheck) return null;
    const rows = db.prepare("SELECT key, value FROM meta").all() as { key: string; value: string }[];
    const meta: { schema_version?: string; vault_root?: string; tokenize_mode?: TokenizeMode } = {};
    for (const row of rows) {
      if (row.key === "schema_version") meta.schema_version = row.value;
      else if (row.key === "vault_root") meta.vault_root = row.value;
      else if (row.key === "tokenize_mode") {
        meta.tokenize_mode = row.value === "trigram" ? "trigram" : "unicode61";
      }
    }
    return meta;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}
