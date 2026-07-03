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
import { optionalDepDetail } from "./optional-dep.js";
import { iterateContentLines } from "./structure.js";
import { countLineBreaks, stripTrailingSlashes } from "./wildcard-match.js";

const SCHEMA_VERSION = 4;
// v2 added the `tags` UNINDEXED column for tag-filtered search.
// v3 added `raw_content` UNINDEXED so the chunk resource can return the
// original note text, while FTS5's `content` column keeps the enriched
// version (with appended wikilink_targets) for recall.
// v4 added the `kind` UNINDEXED column ("md" | "pdf") so PDF chunks live
// in the same index as markdown — `obsidian_search` returns blended hits
// with the kind flag exposed to agents. Schema bump auto-rebuilds.

/**
 * FTS5 tokenizer mode. `unicode61` (default) tokenizes on Unicode word
 * boundaries with diacritic folding — good fit for natural-language
 * markdown. `trigram` indexes every 3-char substring — slower to build
 * but better recall on CJK / agglutinative scripts.
 */
export type TokenizeMode = "unicode61" | "trigram";

/** Content-source kind. v2.7.0 added `pdf`; v2.8.0 indexes them. */
export type ChunkKind = "md" | "pdf";

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

/** Counter summary returned by the FTS5 sync routine in `server.ts`. */
export interface FtsSyncReport {
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
}

/**
 * SQLite FTS5 inverted index over chunked note content. Opt-in via
 * `--persistent-index`. Provides sub-100ms BM25-ranked search on
 * multi-thousand-note vaults; falls back transparently to the in-memory
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
    const versionMatch = meta.schema_version === undefined || meta.schema_version === String(SCHEMA_VERSION);
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

      // writeMeta inside the same transaction — keeps meta + schema
      // atomically in sync. (writeMeta opens its own nested transaction,
      // but better-sqlite3 handles nesting via savepoints.)
      this.writeMeta({
        schema_version: String(SCHEMA_VERSION),
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

  /** Drop a file's chunks + state row. Idempotent.
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
      db.prepare("DELETE FROM chunks WHERE rel_path = ?").run(relPath);
      db.prepare("DELETE FROM source_state WHERE rel_path = ?").run(relPath);
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
    tags: string[] = []
  ): number {
    const db = this.requireDb();
    const chunks = chunkContent(content);
    const tagsSerialized = tags.length ? tags.join(",") : "";
    const txn = db.transaction(() => {
      db.prepare("DELETE FROM chunks WHERE rel_path = ?").run(relPath);
      const insert = db.prepare(
        "INSERT INTO chunks (content, rel_path, chunk_index, line_start, line_end, tags, raw_content, kind) VALUES (?, ?, ?, ?, ?, ?, ?, 'md')"
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
        insert.run(enriched, relPath, i, c.lineStart, c.lineEnd, tagsSerialized, c.text);
      });
      db.prepare(
        "INSERT OR REPLACE INTO source_state (rel_path, mtime_ms, n_chunks, kind, indexed_at) VALUES (?, ?, ?, 'md', ?)"
      ).run(relPath, mtimeMs, chunks.length, new Date().toISOString());
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
    // v3.7.10 (external audit #10) — same transaction wrapper as
    // reindexFile(). See its TSDoc for rationale.
    const txn = db.transaction(() => {
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
    });
    txn();
    return chunks.length;
  }

  /**
   * BM25-ranked search over chunk content. Folder + tag + recency filters
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
   * @returns Sorted hits (score desc). Empty array if no usable query
   *   tokens or no matches.
   */
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
