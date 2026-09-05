// SQLite FTS5 inverted index for indexed BM25-ranked search. Opt-in via
// `--persistent-index`.
//
// Architecture credit: external user feedback in issue #10 — concrete schema,
// tokenize choice (`unicode61 remove_diacritics 2`), source_state mtime-tracking
// pattern, paragraph-level chunking with `blank logical line → logical line → hardcut` fallback,
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
import { foldName, lookupFoldedKey } from "./name-fold.js";
import { optionalDepDetail } from "./optional-dep.js";
import {
  acquirePersistenceFamilyLease,
  acquirePersistenceFamilyLeaseInScopes,
  type PersistenceFamilyLeaseHandle,
  type PersistenceFamilyScopes
} from "./persistence-coordination.js";
import { revalidatePersistenceLeaseScope } from "./persistence-lease.js";
import { assertFtsIndexFilePath } from "./persistence-path.js";
import { FTS_SCHEMA_VERSION } from "./schema-contract.js";
import {
  preflightSensitiveArtifactTempEntry,
  preflightSqliteArtifactFamily,
  sameCanonicalDirectoryEntry,
  sensitiveArtifactFinalBasename
} from "./sensitive-artifact.js";
import { iterateContentLines } from "./structure.js";
import { MAX_INDEX_SYNC_FILES, MAX_INDEX_SYNC_VISITED_ENTRIES, type Vault } from "./vault.js";
import { stripTrailingSlashes } from "./wildcard-match.js";

/**
 * AH-5 — an erasure receipt is only truthful when the entry is gone. Re-stat
 * after a successful unlink; anything but ENOENT (still present, or a parent
 * that cannot be inspected any more) is a visible failure naming the artifact.
 */
async function assertArtifactAbsent(target: string, label: string): Promise<void> {
  try {
    await fs.lstat(target);
  } catch (err) {
    if (errnoCode(err) === "ENOENT") return;
    throw new Error(`Unable to confirm removal of ${label}: ${path.basename(target)}`, { cause: err });
  }
  throw new Error(`${label} still present after removal: ${path.basename(target)}`);
}

function errnoCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null || !("code" in err)) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

// v3.11.6-rc.6 (competitive-study C-3) — FTS5 column weights for BM25. The
// chunks table indexes `content` (col 0), `title` (col 1), `aliases` (col 2);
// bm25(chunks, ...) takes a weight per column in definition order. A note whose
// TITLE or a frontmatter ALIAS matches the query should outrank a note that only
// mentions the term in its body — mirrors OHS's title-10× / alias-5× / content-1×
// weighting, tunable against the eval harness (`enquire eval` + `eval:compare`).
const BM25_WEIGHT_CONTENT = 1.0;
const BM25_WEIGHT_TITLE = 10.0;
const BM25_WEIGHT_ALIASES = 5.0;
// v7 (SBS-D2') — the words a compound identifier is spelled from live in the
// sibling FTS5 table `chunk_parts`, NOT in a column of `chunks`. FTS5's bm25()
// normalises term frequency by the length of the WHOLE row, so even a weight-0
// column lengthens every identifier-bearing row and moves its rank for every
// query (the #577 class again; CI measured 1.03 vs 1.16 for twins whose bodies
// tokenize identically). A table of its own leaves `chunks` scoring
// byte-identical to v6; parts matches are found, never ranked — see
// `searchWithReceipts`.
const MAX_SOURCE_REVISION = Number.MAX_SAFE_INTEGER;
const MAX_SOURCE_RECEIPT_BATCH = 512;
const FTS_PERSISTENCE_FAMILY = "fts5-v1";
const FTS_LEASE_GATE_TIMEOUT_MS = 2_000;
const FTS_LEASE_GATE_POLL_MS = 10;

function ftsPersistenceLeaseTarget(file: string): string {
  const absolute = path.resolve(file);
  // The lease is keyed by an ABSENT synthetic sibling, not by the SQLite main
  // leaf. That keeps clear-index able to unlink an admitted symlink leaf
  // without making the coordination layer follow it. The folded basename hash
  // deliberately over-coordinates case/NFC variants on case-sensitive hosts
  // and necessarily converges aliases that address one entry on APFS/NTFS.
  const basenameDigest = createHash("sha256")
    .update(`fts5-v1\0${foldName(path.basename(absolute))}`, "utf8")
    .digest("hex");
  return path.join(path.dirname(absolute), `.enquire-mcp-fts5-${basenameDigest}`);
}

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
// Note-derived metadata is multiplied by the chunk count when stored beside
// every FTS row. Keep that multiplier independent of the source-file size:
// link targets are indexed once (chunk 0), while the tag filter blob is capped
// to 4 KiB before it is repeated. The occurrence cap also rejects a caller
// that hands the public `reindexFile()` API an already-materialized huge array
// of duplicates without walking it first.
const MAX_FTS_LINK_OCCURRENCES = 4096;
const MAX_FTS_LINK_TARGETS = 256;
const MAX_FTS_LINK_TARGET_BYTES = 1024;
const MAX_FTS_LINK_BYTES = 32 * 1024;
const MAX_FTS_TAG_OCCURRENCES = 1024;
const MAX_FTS_TAGS = 128;
const MAX_FTS_TAG_BYTES = 256;
const MAX_FTS_TAG_BLOB_BYTES = 4 * 1024;

function admitFtsMetadata(
  values: readonly string[],
  options: Readonly<{
    label: string;
    maxOccurrences: number;
    maxUnique: number;
    maxItemBytes: number;
    maxTotalBytes: number;
  }>
): string[] {
  if (!Array.isArray(values)) throw new TypeError(`${options.label} must be an array of strings`);
  if (values.length > options.maxOccurrences) {
    throw new RangeError(`${options.label} exceeds the ${options.maxOccurrences}-occurrence admission limit`);
  }
  const admitted: string[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const value of values) {
    if (typeof value !== "string") throw new TypeError(`${options.label} must contain only strings`);
    if (value.length === 0 || seen.has(value)) continue;
    const bytes = Buffer.byteLength(value, "utf8");
    if (bytes > options.maxItemBytes) {
      throw new RangeError(`${options.label} contains an item larger than ${options.maxItemBytes} UTF-8 bytes`);
    }
    if (admitted.length >= options.maxUnique) {
      throw new RangeError(`${options.label} exceeds the ${options.maxUnique}-unique-item admission limit`);
    }
    if (totalBytes + bytes > options.maxTotalBytes) {
      throw new RangeError(`${options.label} exceeds the ${options.maxTotalBytes}-byte admission limit`);
    }
    seen.add(value);
    admitted.push(value);
    totalBytes += bytes;
  }
  return admitted;
}

/** Upper bounds applied INSIDE the splitter, by truncation. A note with more
 *  identifiers than this still indexes — it simply stops earning parts. The
 *  first attempt (closed #577) routed parts through the throwing metadata
 *  admission, and 513 identifiers made a valid note vanish from the index. */
const MAX_FTS_IDENTIFIER_PARTS_PER_CHUNK = 256;
const MAX_FTS_IDENTIFIER_PART_CODE_POINTS = 64;

/**
 * The words a compound identifier is spelled from, for the v7 `chunk_parts`
 * column. Case boundaries only: the tokenizer already splits `_`, `-` and `.`,
 * so `pool_day_data` is reachable by its parts without help; `poolDayData` was
 * one opaque token no reader could reach by the words it is made of.
 *
 * Boundaries: lower→Upper (`poolDay` → pool, day), an upper-case RUN followed by
 * a capitalised word (`parseHTTPResponse` → parse, http, response), and letter↔
 * digit (`sha256Hash` → sha, 256, hash). Input is NFC-normalised first so a
 * decomposed accent cannot split a letter from its mark, and lengths count code
 * points, not UTF-16 units. Only identifiers that split into two or more
 * segments emit parts; single words are already tokens.
 *
 * @param text - Chunk text to scan.
 * @returns Lower-cased, de-duplicated parts; at most 256 per chunk, each at
 *   most 64 code points — truncated, never refused.
 * @example
 * splitIdentifierParts("call parseHTTPResponse(sha256Hash)");
 * // ["parse", "http", "response", "sha", "256", "hash"]
 */
export function splitIdentifierParts(text: string): string[] {
  const seen = new Set<string>();
  const parts: string[] = [];
  const normalized = text.normalize("NFC");
  for (const match of normalized.matchAll(/[\p{L}\p{N}]+/gu)) {
    const segments = match[0]
      .split(/(?<=\p{Ll})(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll})|(?<=\p{L})(?=\p{N})|(?<=\p{N})(?=\p{L})/gu)
      .filter((segment) => segment.length > 0);
    if (segments.length < 2) continue;
    for (const segment of segments) {
      const part = segment.toLowerCase();
      const codePoints = [...part];
      if (codePoints.length < 2 || codePoints.length > MAX_FTS_IDENTIFIER_PART_CODE_POINTS || seen.has(part)) continue;
      seen.add(part);
      parts.push(part);
      if (parts.length >= MAX_FTS_IDENTIFIER_PARTS_PER_CHUNK) return parts;
    }
  }
  return parts;
}

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

/**
 * Exact metadata returned only after full readonly FTS class admission.
 *
 * @example
 * ```ts
 * const meta: FtsIndexOwnedMeta = {
 *   schema_version: "6",
 *   vault_root: "/vault",
 *   tokenize_mode: "unicode61"
 * };
 * ```
 */
export interface FtsIndexOwnedMeta {
  /** Supported historical on-disk schema version. */
  readonly schema_version: string;
  /** Exact stored vault root proven equal to the expected canonical root. */
  readonly vault_root: string;
  /** Stored tokenizer proven to match the physical FTS5 definition. */
  readonly tokenize_mode: TokenizeMode;
}

/**
 * Readonly classification of a configured FTS index path.
 * Only `missing` and genuinely schema-`empty` paths may select a requested or
 * default tokenizer. `owned` must use its returned tokenizer; every other
 * existing file is `refused` without exposing native or path details.
 *
 * @example
 * ```ts
 * const discovery: FtsIndexDiscovery = { kind: "empty" };
 * if (discovery.kind === "empty") {
 *   // A caller may initialize with its requested tokenizer.
 * }
 * ```
 */
export type FtsIndexDiscovery =
  | { /** No filesystem entry exists at the configured path. */ readonly kind: "missing" }
  | { /** SQLite contains no non-internal logical schema objects. */ readonly kind: "empty" }
  | {
      /** Same-root, fully admitted FTS class and exact stored config. */
      readonly kind: "owned";
      readonly meta: Readonly<FtsIndexOwnedMeta>;
    }
  | { /** Existing path could not prove the exact same-root FTS class. */ readonly kind: "refused" };

const FTS_DISCOVERY_CHANGED_ERROR = "FTS index configuration changed before open";

function cloneFtsIndexDiscovery(expected: FtsIndexDiscovery | undefined): FtsIndexDiscovery | null {
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
    const tokenizeMode = meta?.tokenize_mode;
    if (
      kind === "owned" &&
      typeof schemaVersion === "string" &&
      typeof vaultRoot === "string" &&
      (tokenizeMode === "unicode61" || tokenizeMode === "trigram")
    ) {
      return Object.freeze({
        kind: "owned",
        meta: Object.freeze({
          schema_version: schemaVersion,
          vault_root: vaultRoot,
          tokenize_mode: tokenizeMode
        })
      });
    }
  } catch {
    // Treat malformed/getter-backed runtime input exactly like a refused
    // discovery without reflecting its values in the public diagnostic.
  }
  return Object.freeze({ kind: "refused" });
}

function assertExpectedFtsDiscovery(
  expected: FtsIndexDiscovery | null,
  fileExisted: boolean,
  admission: FtsAdmission
): void {
  if (expected === null) return;
  const matches =
    (expected.kind === "missing" && !fileExisted && admission.kind === "empty") ||
    (expected.kind === "empty" && fileExisted && admission.kind === "empty") ||
    (expected.kind === "owned" &&
      admission.kind === "owned" &&
      expected.meta.schema_version === admission.meta.schema_version &&
      expected.meta.vault_root === admission.meta.vault_root &&
      expected.meta.tokenize_mode === admission.meta.tokenize_mode);
  if (!matches) throw new Error(FTS_DISCOVERY_CHANGED_ERROR);
}

/**
 * Validate an untrusted FTS tokenizer value without silently selecting a
 * fallback. This is intentionally synchronous so callers can reject invalid
 * CLI, config, or programmatic input before preparing any index path.
 *
 * @param value - Candidate tokenizer value.
 * @param label - Safe, caller-facing name for the input surface.
 * @returns The exact supported tokenizer mode.
 * @throws {Error} If `value` is not exactly `unicode61` or `trigram`.
 * @example
 * ```ts
 * const tokenize = assertTokenizeMode(rawTokenize, "--tokenize");
 * ```
 */
export function assertTokenizeMode(value: unknown, label = "tokenize mode"): TokenizeMode {
  if (value === "unicode61" || value === "trigram") return value;
  const subject = typeof label === "string" && /^[a-z0-9 _-]{1,64}$/i.test(label) ? label : "tokenize mode";
  const received =
    typeof value === "string" && /^[a-z0-9_-]{1,32}$/i.test(value) ? JSON.stringify(value) : `type ${typeof value}`;
  throw new Error(`${subject} must be exactly "unicode61" or "trigram"; received ${received}`);
}

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
  transaction<F extends (...args: never[]) => unknown>(fn: F): F & { immediate: F };
}
interface Stmt {
  run(...params: unknown[]): { changes: number };
  all<T = unknown>(...params: unknown[]): T[];
  get<T = unknown>(...params: unknown[]): T | undefined;
  iterate<T = unknown>(...params: unknown[]): IterableIterator<T>;
}

interface SqliteColumnInfo {
  cid: unknown;
  dflt_value: unknown;
  name: unknown;
  notnull: unknown;
  pk: unknown;
  type: unknown;
}

interface SqliteXColumnInfo extends SqliteColumnInfo {
  hidden: unknown;
}

interface ExpectedSqliteColumn {
  dflt_value: string | null;
  name: string;
  notnull: number;
  pk: number;
  type: string;
}

interface ExpectedSqliteXColumn extends ExpectedSqliteColumn {
  hidden: number;
}

type FtsAdmission =
  | { kind: "empty"; rebuildReasons: []; signature: "empty" }
  | { kind: "owned"; meta: FtsIndexOwnedMeta; rebuildReasons: string[]; signature: string };

const FTS_CHUNK_COLUMNS_BY_SCHEMA = new Map<number, readonly string[]>([
  [1, ["content", "rel_path", "chunk_index", "line_start", "line_end"]],
  [2, ["content", "rel_path", "chunk_index", "line_start", "line_end", "tags"]],
  [3, ["content", "rel_path", "chunk_index", "line_start", "line_end", "tags", "raw_content"]],
  [4, ["content", "rel_path", "chunk_index", "line_start", "line_end", "tags", "raw_content", "kind"]],
  [
    5,
    ["content", "title", "aliases", "rel_path", "chunk_index", "line_start", "line_end", "tags", "raw_content", "kind"]
  ],
  [
    6,
    [
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
    ]
  ],
  [
    7,
    [
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
    ]
  ]
]);
// v7 — the sibling identifier-parts table. `content` is repeated for the chunks
// that carry an identifier so a query mixing body words with identifier words
// still has one row to AND against; `parts` is the split; `scope_tokens` keeps
// folder scoping and the indexed per-path delete identical to `chunks`.
const FTS_CHUNK_PARTS_COLUMNS = [
  "content",
  "parts",
  "scope_tokens",
  "rel_path",
  "chunk_index",
  "line_start",
  "line_end",
  "tags",
  "kind"
] as const;
const FTS_CHUNK_PARTS_MIN_SCHEMA = 7;
const FTS_CHUNK_PARTS_INSERT_SQL =
  "INSERT INTO chunk_parts (content, parts, scope_tokens, rel_path, chunk_index, line_start, line_end, tags, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)";

function ftsChunkPartsCreateSql(tokenizeArg: string): string {
  const declared = FTS_CHUNK_PARTS_COLUMNS.map((name, index) => (index < 3 ? name : `${name} UNINDEXED`)).join(",\n  ");
  return `CREATE VIRTUAL TABLE IF NOT EXISTS chunk_parts USING fts5(
  ${declared},
  tokenize='${tokenizeArg}'
)`;
}

const FTS_SOURCE_REVISION_TRIGGER_NAMES = [
  "source_state_revision_insert",
  "source_state_revision_update",
  "source_state_revision_delete",
  "source_quarantine_revision_insert",
  "source_quarantine_revision_update",
  "source_quarantine_revision_delete"
] as const;
const FTS_ADMISSION_OBJECT_TYPES = new Map<string, string>([
  ["meta", "table"],
  ["chunks", "table"],
  ["chunks_data", "table"],
  ["chunks_idx", "table"],
  ["chunks_content", "table"],
  ["chunks_docsize", "table"],
  ["chunks_config", "table"],
  ["chunk_parts", "table"],
  ["chunk_parts_data", "table"],
  ["chunk_parts_idx", "table"],
  ["chunk_parts_content", "table"],
  ["chunk_parts_docsize", "table"],
  ["chunk_parts_config", "table"],
  ["source_state", "table"],
  ["source_quarantine", "table"],
  ["source_revision", "table"],
  ...FTS_SOURCE_REVISION_TRIGGER_NAMES.map((name) => [name, "trigger"] as const)
]);
const FTS_REQUIRED_OBJECT_NAMES = [
  "meta",
  "chunks",
  "chunks_data",
  "chunks_idx",
  "chunks_content",
  "chunks_docsize",
  "chunks_config",
  "source_state"
] as const;
const MAX_FTS_ADMISSION_OBJECTS = FTS_ADMISSION_OBJECT_TYPES.size;
const MAX_FTS_ADMISSION_NAME_CHARS = 128;
const MAX_FTS_ADMISSION_SQL_CHARS = 32_768;
const MAX_FTS_META_VALUE_CHARS = 8_192;
const MAX_FTS_ADMISSION_COLUMN_CHARS = 128;
const FTS_META_CREATE_SQL = `CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
)`;
const FTS_SOURCE_STATE_LEGACY_CREATE_SQL = `CREATE TABLE IF NOT EXISTS source_state (
  rel_path TEXT PRIMARY KEY,
  mtime_ms INTEGER NOT NULL,
  n_chunks INTEGER NOT NULL,
  indexed_at TEXT NOT NULL
)`;
const FTS_SOURCE_STATE_CURRENT_CREATE_SQL = `CREATE TABLE IF NOT EXISTS source_state (
  rel_path TEXT PRIMARY KEY,
  mtime_ms INTEGER NOT NULL,
  n_chunks INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'md',
  indexed_at TEXT NOT NULL
)`;
const FTS_SOURCE_STATE_CREATE_SQL_BY_SCHEMA = new Map<number, string>([
  [1, FTS_SOURCE_STATE_LEGACY_CREATE_SQL],
  [2, FTS_SOURCE_STATE_LEGACY_CREATE_SQL],
  [3, FTS_SOURCE_STATE_LEGACY_CREATE_SQL],
  [4, FTS_SOURCE_STATE_CURRENT_CREATE_SQL],
  [5, FTS_SOURCE_STATE_CURRENT_CREATE_SQL],
  [6, FTS_SOURCE_STATE_CURRENT_CREATE_SQL],
  [7, FTS_SOURCE_STATE_CURRENT_CREATE_SQL]
]);
const FTS_SOURCE_QUARANTINE_COLUMNS: readonly ExpectedSqliteColumn[] = [
  { name: "rel_path", type: "TEXT", notnull: 1, dflt_value: null, pk: 1 },
  { name: "kind", type: "TEXT", notnull: 1, dflt_value: null, pk: 2 }
];
const FTS_SOURCE_REVISION_COLUMNS: readonly ExpectedSqliteColumn[] = [
  { name: "rel_path", type: "TEXT", notnull: 1, dflt_value: null, pk: 1 },
  { name: "kind", type: "TEXT", notnull: 1, dflt_value: null, pk: 2 },
  { name: "revision", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 }
];
const FTS_SOURCE_QUARANTINE_CREATE_SQL = `CREATE TABLE IF NOT EXISTS source_quarantine (
  rel_path TEXT NOT NULL,
  kind TEXT NOT NULL,
  PRIMARY KEY (rel_path, kind)
) WITHOUT ROWID`;
const FTS_SOURCE_REVISION_CREATE_SQL = `CREATE TABLE IF NOT EXISTS source_revision (
  rel_path TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('md', 'pdf')),
  revision INTEGER NOT NULL CHECK (
    typeof(revision) = 'integer'
    AND revision BETWEEN 1 AND ${MAX_SOURCE_REVISION}
  ),
  PRIMARY KEY (rel_path, kind)
) WITHOUT ROWID`;

function normalizeFtsAdmissionSql(sql: string): string {
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
    // Parenthesis/comma spacing is not part of SQLite DDL identity. The
    // separate state keeps punctuation inside a literal semantically opaque.
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
  return normalized
    .replace(/^create table if not exists /i, "create table ")
    .replace(/^create virtual table if not exists /i, "create virtual table ");
}

// FTS5 emits its five shadow tables with quoted table identifiers, while
// SQLite versions are free to vary harmless whitespace and identifier quote
// style. These CREATE statements contain no string literals, so a deliberately
// small lexer can compare the complete token stream without conflating a
// semantic literal (the reason normalizeFtsAdmissionSql is quote-aware).
function tokenizeFtsShadowSql(sql: string): string[] | null {
  const tokens: string[] = [];
  let index = 0;
  while (index < sql.length) {
    const char = sql[index];
    if (char === undefined) return null;
    if (/\s/u.test(char)) {
      index += 1;
      continue;
    }
    if (char === ";") {
      index += 1;
      while (index < sql.length && /\s/u.test(sql[index] ?? "")) index += 1;
      return index === sql.length ? tokens : null;
    }
    if (char === "(" || char === ")" || char === ",") {
      tokens.push(char);
      index += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === "`" || char === "[") {
      const closing = char === "[" ? "]" : char;
      let identifier = "";
      index += 1;
      let closed = false;
      while (index < sql.length) {
        const quoted = sql[index];
        if (quoted === undefined) return null;
        if (quoted === closing) {
          if (sql[index + 1] === closing) {
            identifier += closing;
            index += 2;
            continue;
          }
          index += 1;
          closed = true;
          break;
        }
        identifier += quoted;
        index += 1;
      }
      if (!closed || identifier.length === 0) return null;
      tokens.push(identifier.toLowerCase());
      continue;
    }
    if (/[a-z0-9_]/iu.test(char)) {
      const start = index;
      index += 1;
      while (index < sql.length && /[a-z0-9_]/iu.test(sql[index] ?? "")) index += 1;
      tokens.push(sql.slice(start, index).toLowerCase());
      continue;
    }
    return null;
  }
  return tokens;
}

function hasExactFtsShadowSql(actualSql: string, expectedSql: string): boolean {
  const actual = tokenizeFtsShadowSql(actualSql);
  const expected = tokenizeFtsShadowSql(expectedSql);
  return (
    actual !== null &&
    expected !== null &&
    actual.length === expected.length &&
    actual.every((token, index) => token === expected[index])
  );
}

function ftsShadowAdmissionTables(
  contentColumnCount: number,
  table = "chunks"
): ReadonlyArray<{
  columns: readonly ExpectedSqliteXColumn[];
  name: string;
  sql: string;
}> {
  const column = (name: string, type: string, notnull: number, pk: number): ExpectedSqliteXColumn => ({
    name,
    type,
    notnull,
    dflt_value: null,
    pk,
    hidden: 0
  });
  const contentColumns = Array.from({ length: contentColumnCount }, (_, index) => `c${index}`);
  return [
    {
      name: `${table}_data`,
      sql: `CREATE TABLE ${table}_data(id INTEGER PRIMARY KEY, block BLOB)`,
      columns: [column("id", "INTEGER", 0, 1), column("block", "BLOB", 0, 0)]
    },
    {
      name: `${table}_idx`,
      sql: `CREATE TABLE ${table}_idx(segid, term, pgno, PRIMARY KEY(segid, term)) WITHOUT ROWID`,
      columns: [column("segid", "", 1, 1), column("term", "", 1, 2), column("pgno", "", 0, 0)]
    },
    {
      name: `${table}_content`,
      sql: `CREATE TABLE ${table}_content(id INTEGER PRIMARY KEY${contentColumns.map((name) => `, ${name}`).join("")})`,
      columns: [column("id", "INTEGER", 0, 1), ...contentColumns.map((name) => column(name, "", 0, 0))]
    },
    {
      name: `${table}_docsize`,
      sql: `CREATE TABLE ${table}_docsize(id INTEGER PRIMARY KEY, sz BLOB)`,
      columns: [column("id", "INTEGER", 0, 1), column("sz", "BLOB", 0, 0)]
    },
    {
      name: `${table}_config`,
      sql: `CREATE TABLE ${table}_config(k PRIMARY KEY, v) WITHOUT ROWID`,
      columns: [column("k", "", 1, 1), column("v", "", 0, 0)]
    }
  ];
}

function readExactFtsShadowTable(
  db: Db,
  actualSql: string,
  expectedSql: string,
  table: string,
  expectedColumns: readonly ExpectedSqliteXColumn[]
): SqliteXColumnInfo[] | null {
  if (!hasExactFtsShadowSql(actualSql, expectedSql)) return null;
  const columns = db
    .prepare(
      `SELECT cid,
              substr(name, 1, ?) AS name,
              substr(type, 1, ?) AS type,
              "notnull",
              CASE WHEN dflt_value IS NULL THEN NULL ELSE substr(CAST(dflt_value AS TEXT), 1, ?) END AS dflt_value,
              pk,
              hidden
       FROM pragma_table_xinfo(?)
       ORDER BY cid
       LIMIT ?`
    )
    .all<SqliteXColumnInfo>(
      MAX_FTS_ADMISSION_COLUMN_CHARS + 1,
      MAX_FTS_ADMISSION_COLUMN_CHARS + 1,
      MAX_FTS_ADMISSION_COLUMN_CHARS + 1,
      table,
      expectedColumns.length + 1
    );
  if (columns.length !== expectedColumns.length) return null;
  return columns.every((column, index) => {
    const expected = expectedColumns[index];
    return (
      expected !== undefined &&
      column.cid === index &&
      typeof column.name === "string" &&
      column.name.length <= MAX_FTS_ADMISSION_COLUMN_CHARS &&
      column.name === expected.name &&
      typeof column.type === "string" &&
      column.type.length <= MAX_FTS_ADMISSION_COLUMN_CHARS &&
      column.type === expected.type &&
      column.notnull === expected.notnull &&
      column.dflt_value === expected.dflt_value &&
      column.pk === expected.pk &&
      column.hidden === expected.hidden
    );
  })
    ? columns
    : null;
}

function hasExactFtsAdmissionTable(
  db: Db,
  table: string,
  expectedColumns: readonly ExpectedSqliteColumn[],
  actualSql: string,
  expectedSql: string
): boolean {
  if (normalizeFtsAdmissionSql(actualSql) !== normalizeFtsAdmissionSql(expectedSql)) return false;
  const columns = db
    .prepare('SELECT cid, name, type, "notnull", dflt_value, pk FROM pragma_table_info(?) ORDER BY cid LIMIT ?')
    .all<SqliteColumnInfo>(table, expectedColumns.length + 1);
  return (
    columns.length === expectedColumns.length &&
    columns.every((column, index) => {
      const expected = expectedColumns[index];
      return (
        expected !== undefined &&
        column.cid === index &&
        column.name === expected.name &&
        column.type === expected.type &&
        column.notnull === expected.notnull &&
        column.dflt_value === expected.dflt_value &&
        column.pk === expected.pk
      );
    })
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
 * await idx.closeAndRelease();
 * ```
 */
export class FtsIndex {
  private db: Db | null = null;
  private closeAttempt: Promise<void> | undefined;
  private closeAttemptFailed = false;
  private closeRequestToken: object = {};
  private closeRequested = false;
  private file: string;
  private readonly indexBasename: string;
  private readonly leaseTarget: string;
  private lifetime: PersistenceFamilyLeaseHandle | null = null;
  private openAttempt: Promise<void> | undefined;
  private pinnedScopes: PersistenceFamilyScopes | null = null;
  private readonly requestedFile: string;
  private readonly tokenize: TokenizeMode;
  private readonly vaultRoot: string;

  /**
   * @param opts - Exact `.fts5.db` file, owning vault root, and optional tokenizer.
   * @throws {TypeError} If `opts.file` is outside the exact FTS namespace.
   * @throws {Error} If the tokenizer is not exactly `unicode61` or `trigram`.
   */
  constructor(opts: { file: string; vaultRoot: string; tokenize?: TokenizeMode }) {
    assertFtsIndexFilePath(opts.file);
    this.file = opts.file;
    this.indexBasename = path.basename(path.resolve(opts.file));
    this.leaseTarget = ftsPersistenceLeaseTarget(opts.file);
    this.requestedFile = opts.file;
    this.vaultRoot = opts.vaultRoot;
    this.tokenize = assertTokenizeMode(opts.tokenize === undefined ? "unicode61" : opts.tokenize);
  }

  /**
   * Open the SQLite database, admit only a fresh or same-vault FTS schema,
   * bootstrap the FTS5 virtual table + helpers, then enable WAL and best-effort
   * tighten file perms to 0o600 on the db + sidecars. A populated foreign, malformed,
   * or newer-schema database is refused before Enquire issues persistent
   * PRAGMA, DDL, DML, or chmod operations. SQLite itself may still take locks
   * or perform recovery while the live handle reads ownership metadata. Before
   * dependency loading and again immediately before native open, the main,
   * WAL, SHM, and rollback-journal leaves must be wholly absent or every
   * present leaf must be a singly linked regular file; orphan sidecars refuse.
   * Idempotent — a second `open()` call is a no-op.
   *
   * @param expectedDiscovery - Optional readonly preflight result to bind this
   *   mutating open to. No argument preserves the low-level intentional-rebuild
   *   contract; a supplied stale result is refused before bootstrap.
   * @throws {Error} If `better-sqlite3` fails to load, the native binding is
   *   unavailable, or a populated database cannot prove same-vault FTS
   *   ownership with a supported non-future schema.
   */
  async open(expectedDiscovery?: FtsIndexDiscovery): Promise<void> {
    if (this.db && !this.closeRequested) return;
    if (this.openAttempt !== undefined && !this.closeRequested && this.closeAttempt === undefined) {
      return this.openAttempt;
    }
    // A genuinely new attempt may have to wait for a prior close. Snapshot
    // caller-owned authority before that first await: the retained discovery
    // object must not be mutable while the old lifetime drains.
    const expected = cloneFtsIndexDiscovery(expectedDiscovery);
    if (this.closeRequested || this.closeAttempt !== undefined) {
      const observedCloseRequest = this.closeRequestToken;
      await this.finishCloseAndRelease();
      if (this.closeRequestToken !== observedCloseRequest) {
        throw new Error("FTS index reopen was superseded by a later close request");
      }
      this.closeAttempt = undefined;
      this.closeAttemptFailed = false;
      this.closeRequested = false;
    }
    // Multiple reopen callers can join the same close attempt. The first one
    // to resume installs the new single-flight open; every later continuation
    // must join it instead of acquiring a second shared lifetime.
    if (this.openAttempt !== undefined) return this.openAttempt;
    const attempt = this.openOnce(expected);
    this.openAttempt = attempt;
    try {
      await attempt;
    } finally {
      if (this.openAttempt === attempt) this.openAttempt = undefined;
    }
  }

  private async openOnce(expected: FtsIndexDiscovery | null): Promise<void> {
    let acquired: PersistenceFamilyLeaseHandle | null = null;
    try {
      acquired = await acquirePersistenceFamilyLease({
        targetPath: this.leaseTarget,
        familyKey: FTS_PERSISTENCE_FAMILY,
        role: "shared",
        gateTimeoutMs: FTS_LEASE_GATE_TIMEOUT_MS,
        gatePollMs: FTS_LEASE_GATE_POLL_MS
      });
      this.lifetime = acquired;
      this.pinnedScopes = acquired.scopes;
      this.file = path.join(acquired.scopes.family.canonicalParent, this.indexBasename);

      let fileExisted: boolean;
      try {
        fileExisted = await preflightSqliteArtifactFamily(this.file);
      } catch {
        throw new Error("FTS index artifact family could not be admitted");
      }
      const Ctor = await loadBetterSqlite();
      if (!fileExisted) {
        // Parent creation is the narrow fresh-file exception. Recursive mkdir
        // applies 0700 subject only to a more-restrictive umask and never chmods
        // an existing/custom parent after a racy ownership probe.
        const parentDir = path.dirname(this.file);
        await fs.mkdir(parentDir, { recursive: true, mode: 0o700 });
      }
      try {
        fileExisted = await preflightSqliteArtifactFamily(this.file);
        this.db = new Ctor(this.file) as Db;
      } catch {
        throw new Error("FTS index could not be opened");
      }
      // v3.10.0-rc.70 (round-3 re-sweep, reserve-before-try) — close-on-throw: release the handle if
      // admission/bootstrap/pragma throws on a corrupt or unowned index, so no caller can leak it (mirrors
      // EmbedDb.open()). The serve call site already wraps this in a catch, but self-cleaning here
      // makes the contract hold for every caller (CLI build paths, future ones).
      try {
        // AH-2: this same-handle read is authoritative admission, not the
        // caller-level fail-soft peek. bootstrapSchema repeats it as the first
        // action inside its IMMEDIATE transaction before any schema mutation.
        const initialAdmission = this.inspectAdmission();
        assertExpectedFtsDiscovery(expected, fileExisted, initialAdmission);
        this.bootstrapSchema(initialAdmission);
        this.db.pragma("journal_mode = WAL");
        this.db.pragma("synchronous = NORMAL");
      } catch (e) {
        // Preserve the admission/bootstrap failure as the public error. A
        // native close failure must neither replace that bounded diagnostic nor
        // leave a closed handle installed so the next open() becomes a stale
        // no-op.
        const failedDb = this.db;
        this.db = null;
        try {
          failedDb?.close();
        } catch {
          // best-effort cleanup; the original failure remains authoritative
        }
        throw e;
      }
      // Best-effort: tighten perms on the DB and its WAL/SHM sidecar files to
      // 0600. The index stores chunked note content so it deserves the same
      // privacy posture as the persistent parse cache (see SECURITY.md).
      await Promise.all(
        [this.file, `${this.file}-wal`, `${this.file}-shm`].map((p) => fs.chmod(p, 0o600).catch(() => {}))
      );
    } catch (error) {
      const failedDb = this.db;
      this.db = null;
      try {
        failedDb?.close();
      } catch {
        // The admission/open failure remains authoritative; the lifetime
        // rollback below still prevents a destructive peer from proceeding.
      }
      if (acquired !== null) {
        try {
          await acquired.release();
          if (this.lifetime === acquired) this.lifetime = null;
        } catch (rollbackError) {
          // Do not let a second open overwrite the exact lifetime whose
          // rollback failed. The next open is forced through
          // closeAndRelease(), which retries this same core handle and remains
          // fail-closed if the core reports a terminal integrity failure.
          this.closeRequested = true;
          throw new AggregateError([error, rollbackError], "FTS open failed and lifetime rollback was incomplete");
        }
      }
      throw error;
    }
  }

  /**
   * Remove the index file + WAL/SHM/rollback-journal sidecars after validating
   * every present leaf. Missing files are idempotent; directories, special
   * objects, and non-ENOENT inspection/deletion failures refuse the operation.
   *
   * @returns `true` when at least one artifact was removed.
   * @throws {Error} If any main/WAL/SHM/rollback-journal leaf is unsafe or a non-ENOENT operation fails.
   */
  async clearOnDisk(): Promise<boolean> {
    const pinnedScopes = this.pinnedScopes;
    await this.closeAndRelease();

    if (pinnedScopes === null) {
      try {
        await fs.lstat(path.dirname(path.resolve(this.requestedFile)));
      } catch (error) {
        if (errnoCode(error) === "ENOENT") return false;
        throw new Error("Unable to inspect the FTS index parent before clearing", { cause: error });
      }
    }

    const eraser =
      pinnedScopes === null
        ? await acquirePersistenceFamilyLease({
            targetPath: this.leaseTarget,
            familyKey: FTS_PERSISTENCE_FAMILY,
            role: "eraser",
            gateTimeoutMs: FTS_LEASE_GATE_TIMEOUT_MS,
            gatePollMs: FTS_LEASE_GATE_POLL_MS
          })
        : await acquirePersistenceFamilyLeaseInScopes(pinnedScopes, {
            role: "eraser",
            gateTimeoutMs: FTS_LEASE_GATE_TIMEOUT_MS,
            gatePollMs: FTS_LEASE_GATE_POLL_MS
          });
    let operationError: unknown;
    let removed = false;
    try {
      const canonicalFile = path.join(eraser.scopes.family.canonicalParent, this.indexBasename);
      const targets = [canonicalFile, `${canonicalFile}-wal`, `${canonicalFile}-shm`, `${canonicalFile}-journal`];
      for (const target of targets) {
        await this.revalidateEraser(eraser.scopes);
        let entry: import("node:fs").Stats;
        try {
          entry = await fs.lstat(target);
        } catch (err) {
          if (errnoCode(err) === "ENOENT") continue;
          throw new Error(`Unable to inspect FTS index artifacts before clearing: ${path.basename(target)}`, {
            cause: err
          });
        }
        if (!entry.isFile() && !entry.isSymbolicLink()) {
          throw new Error(`Refusing to clear an unsafe FTS index artifact: ${path.basename(target)}`);
        }
      }
      await this.revalidateEraser(eraser.scopes);
      for (const target of targets) {
        await this.revalidateEraser(eraser.scopes);
        // AH-5 — erasure truth. Only ENOENT is idempotent success; every other
        // failure names the exact artifact, and a removal is believed only once
        // the entry is re-statted absent, so the CLI receipt never says
        // "removed" for a file that is still there.
        try {
          await fs.unlink(target);
          removed = true;
        } catch (err) {
          if (errnoCode(err) !== "ENOENT") {
            throw new Error(`Unable to remove FTS index artifact: ${path.basename(target)}`, { cause: err });
          }
          continue;
        }
        await assertArtifactAbsent(target, "FTS index artifact");
      }
      await this.revalidateEraser(eraser.scopes);
    } catch (error) {
      operationError = error;
    }
    let releaseError: unknown;
    try {
      await eraser.release();
    } catch (error) {
      releaseError = error;
    }
    if (operationError !== undefined && releaseError !== undefined) {
      throw new AggregateError([operationError, releaseError], "FTS clear failed and eraser release was incomplete");
    }
    if (operationError !== undefined) throw operationError;
    if (releaseError !== undefined) throw releaseError;
    return removed;
  }

  /**
   * Close the underlying SQLite handle synchronously and begin best-effort
   * asynchronous lifetime release. This preserves the historical synchronous
   * API; callers that own process shutdown must await {@link closeAndRelease}
   * to prove both lease markers are gone. A release rejection is observed here
   * (never unhandled), retained, and retried by a later awaited close.
   */
  close(): void {
    this.requestClose();
    let closeError: unknown;
    try {
      this.closeDatabase();
    } catch (error) {
      closeError = error;
    }
    const attempt = this.beginCloseAttempt();
    void attempt.catch(() => {});
    if (closeError !== undefined) throw closeError;
  }

  /**
   * Close SQLite without reopening it and await exact family-then-namespace
   * lifetime release. If a previous best-effort close failed, this call makes
   * one new attempt through the same core handle; terminal integrity failures
   * remain fail-closed while retryable failures can complete.
   *
   * @returns Only after the SQLite handle is closed and both markers are gone.
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
      this.closeDatabase();
    } catch (error) {
      errors.push(error);
    }
    if (this.closeAttempt !== undefined && this.closeAttemptFailed) {
      this.closeAttempt = undefined;
      this.closeAttemptFailed = false;
    }
    try {
      await this.beginCloseAttempt();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, "FTS native close and persistence release both failed");
    }
  }

  private beginCloseAttempt(): Promise<void> {
    if (this.closeAttempt !== undefined) return this.closeAttempt;
    const opening = this.openAttempt;
    const close = async (): Promise<void> => {
      if (opening !== undefined) {
        try {
          await opening;
        } catch {
          // openOnce owns its rollback and error. Close still retries any
          // exact lifetime handle retained by an incomplete rollback.
        }
      }
      const errors: unknown[] = [];
      try {
        this.closeDatabase();
      } catch (error) {
        errors.push(error);
      }
      const lifetime = this.lifetime;
      if (lifetime !== null) {
        try {
          await lifetime.release();
          if (this.lifetime === lifetime) this.lifetime = null;
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(errors, "FTS native close and persistence release both failed");
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

  private closeDatabase(): void {
    if (this.db === null) return;
    const db = this.db;
    this.db = null;
    db.close();
  }

  private async revalidateEraser(scopes: PersistenceFamilyScopes): Promise<void> {
    await revalidatePersistenceLeaseScope(scopes.namespace);
    await revalidatePersistenceLeaseScope(scopes.family);
  }

  private bootstrapSchema(initialAdmission: FtsAdmission): void {
    const db = this.requireDb();
    const tokenizeArg = this.tokenize === "trigram" ? "trigram" : "unicode61 remove_diacritics 2";
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
      // AH-2 race closure: this MUST remain the first callback action. The
      // IMMEDIATE wrapper acquires SQLite's write reservation before this
      // second same-handle proof, closing the preflight-to-bootstrap window.
      const admission = this.inspectAdmission();
      if (admission.kind !== initialAdmission.kind || admission.signature !== initialAdmission.signature) {
        throw new Error("FTS index ownership changed during admission");
      }
      if (admission.rebuildReasons.length > 0) {
        process.stderr.write(`enquire: rebuilding fts5 index (${admission.rebuildReasons.join("; ")})\n`);
        // DROP rather than DELETE — schema may have changed (e.g. v1 → v2 added
        // the `tags` column). DROP IF EXISTS handles a fresh DB too.
        db.exec(`
          DROP TABLE IF EXISTS chunks;
          DROP TABLE IF EXISTS chunk_parts;
          DROP TABLE IF EXISTS source_state;
          DROP TABLE IF EXISTS source_quarantine;
          DROP TABLE IF EXISTS source_revision;
        `);
      }

      // A genuinely schema-empty database is the only populated-without-meta
      // case admitted. Create ownership metadata only after the second guard.
      db.exec(`
        ${FTS_META_CREATE_SQL};
      `);

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
        ${ftsChunkPartsCreateSql(tokenizeArg)};
        ${FTS_SOURCE_STATE_CURRENT_CREATE_SQL};
        ${FTS_SOURCE_QUARANTINE_CREATE_SQL};
        ${FTS_SOURCE_REVISION_CREATE_SQL};

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
    txn.immediate();
  }

  /**
   * Inspect logical ownership on the already-open live handle without writing.
   * A populated database must prove FTS class, exact vault ownership, a known
   * tokenizer, and an exact historically shipped core shape through
   * {@link FTS_SCHEMA_VERSION}. Legacy/config mismatches for the same vault are
   * returned as intentional rebuild reasons.
   * The bounded signature covers the complete non-SQLite inventory: the core
   * tables, all five engine-owned FTS5 shadows with exact CREATE tokens and
   * bounded `pragma_table_xinfo` shapes, and only the optional additive
   * revision/quarantine tables plus their six canonical trigger names.
   *
   * @internal Shared with the module-local readonly discovery adapter.
   */
  protected inspectAdmission(
    db: Db = this.requireDb(),
    configuredTokenize: TokenizeMode | null = this.tokenize
  ): FtsAdmission {
    let schemaRows: Array<{
      name: string;
      sql: string | null;
      type: string;
    }>;
    try {
      schemaRows = db
        .prepare(
          `SELECT type,
                  substr(name, 1, ?) AS name,
                  substr(sql, 1, ?) AS sql
           FROM sqlite_master
           WHERE name NOT GLOB 'sqlite_*'
           LIMIT ?`
        )
        .all<{
          name: string;
          sql: string | null;
          type: string;
        }>(MAX_FTS_ADMISSION_NAME_CHARS + 1, MAX_FTS_ADMISSION_SQL_CHARS + 1, MAX_FTS_ADMISSION_OBJECTS + 1);
    } catch {
      throw new Error("Refusing to open a populated SQLite database without valid FTS ownership metadata");
    }
    if (schemaRows.length === 0) return { kind: "empty", rebuildReasons: [], signature: "empty" };
    if (schemaRows.length > MAX_FTS_ADMISSION_OBJECTS) {
      throw new Error("Refusing to open a populated SQLite database without valid FTS ownership metadata");
    }
    for (const object of schemaRows) {
      if (
        typeof object.name !== "string" ||
        object.name.length > MAX_FTS_ADMISSION_NAME_CHARS ||
        typeof object.sql !== "string" ||
        object.sql.length > MAX_FTS_ADMISSION_SQL_CHARS ||
        FTS_ADMISSION_OBJECT_TYPES.get(object.name) !== object.type
      ) {
        throw new Error("Refusing to open a populated SQLite database without valid FTS ownership metadata");
      }
    }
    schemaRows.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));

    const objects = new Map(schemaRows.map((row) => [row.name, row]));
    if (FTS_REQUIRED_OBJECT_NAMES.some((name) => objects.get(name)?.type !== "table")) {
      throw new Error("Refusing to open a populated SQLite database without valid FTS ownership metadata");
    }
    const chunksSql = objects.get("chunks")?.sql;
    const metaSql = objects.get("meta")?.sql;
    const sourceStateSql = objects.get("source_state")?.sql;
    if (
      typeof metaSql !== "string" ||
      typeof chunksSql !== "string" ||
      typeof sourceStateSql !== "string" ||
      normalizeFtsAdmissionSql(metaSql) !== normalizeFtsAdmissionSql(FTS_META_CREATE_SQL)
    ) {
      throw new Error("Refusing to open a populated SQLite database without valid FTS ownership metadata");
    }

    let metaColumns: SqliteColumnInfo[];
    let rows: Array<{ key: unknown; value: unknown }>;
    try {
      metaColumns = db
        .prepare(
          "SELECT cid, name, type, \"notnull\", dflt_value, pk FROM pragma_table_info('meta') ORDER BY cid LIMIT 3"
        )
        .all<SqliteColumnInfo>();
      rows = db.prepare("SELECT substr(key, 1, ?) AS key, substr(value, 1, ?) AS value FROM meta LIMIT 4").all<{
        key: unknown;
        value: unknown;
      }>(MAX_FTS_ADMISSION_NAME_CHARS + 1, MAX_FTS_META_VALUE_CHARS + 1);
    } catch {
      throw new Error("Refusing to open a populated SQLite database without valid FTS ownership metadata");
    }
    const exactMetaShape =
      metaColumns.length === 2 &&
      metaColumns[0]?.cid === 0 &&
      metaColumns[0]?.name === "key" &&
      metaColumns[0]?.type === "TEXT" &&
      metaColumns[0]?.notnull === 0 &&
      metaColumns[0]?.dflt_value === null &&
      metaColumns[0]?.pk === 1 &&
      metaColumns[1]?.cid === 1 &&
      metaColumns[1]?.name === "value" &&
      metaColumns[1]?.type === "TEXT" &&
      metaColumns[1]?.notnull === 1 &&
      metaColumns[1]?.dflt_value === null &&
      metaColumns[1]?.pk === 0;
    if (!exactMetaShape || rows.length !== 3) {
      throw new Error("Refusing to open a populated SQLite database without valid FTS ownership metadata");
    }
    const meta = new Map<string, string>();
    for (const row of rows) {
      if (
        typeof row.key !== "string" ||
        row.key.length > MAX_FTS_ADMISSION_NAME_CHARS ||
        typeof row.value !== "string" ||
        row.value.length > MAX_FTS_META_VALUE_CHARS ||
        meta.has(row.key)
      ) {
        throw new Error("Refusing to open a populated SQLite database without valid FTS ownership metadata");
      }
      meta.set(row.key, row.value);
    }

    const storedRoot = meta.get("vault_root");
    const storedVersion = meta.get("schema_version");
    const storedTokenize = meta.get("tokenize_mode");
    if (storedRoot === undefined || storedVersion === undefined || storedTokenize === undefined) {
      throw new Error("Refusing to open a populated SQLite database without valid FTS ownership metadata");
    }
    if (storedRoot !== this.vaultRoot) {
      throw new Error("Refusing to open an FTS index owned by a different vault root");
    }
    let exactStoredTokenize: TokenizeMode;
    try {
      exactStoredTokenize = assertTokenizeMode(storedTokenize, "stored FTS tokenizer");
    } catch {
      throw new Error("Refusing to open an FTS index with an unsupported stored tokenizer");
    }
    if (!/^[1-9]\d*(?![\s\S])/.test(storedVersion)) {
      throw new Error("Refusing to open an FTS index with malformed ownership metadata");
    }
    const numericVersion = Number(storedVersion);
    if (!Number.isSafeInteger(numericVersion)) {
      throw new Error("Refusing to open an FTS index with malformed ownership metadata");
    }
    if (numericVersion > FTS_SCHEMA_VERSION) {
      throw new Error("Refusing to open an FTS index with a newer schema version");
    }

    const expectedChunkColumns = FTS_CHUNK_COLUMNS_BY_SCHEMA.get(numericVersion);
    const expectedSourceStateSql = FTS_SOURCE_STATE_CREATE_SQL_BY_SCHEMA.get(numericVersion);
    if (!expectedChunkColumns || expectedSourceStateSql === undefined) {
      throw new Error("Refusing to open an FTS index with an unsupported legacy schema version");
    }
    if (normalizeFtsAdmissionSql(sourceStateSql) !== normalizeFtsAdmissionSql(expectedSourceStateSql)) {
      throw new Error("Refusing to open a populated SQLite database without valid FTS ownership metadata");
    }
    const unindexedColumns = new Set([
      "rel_path",
      "chunk_index",
      "line_start",
      "line_end",
      "tags",
      "raw_content",
      "kind"
    ]);
    const declaredColumns = expectedChunkColumns
      .map((name) => `${name}${unindexedColumns.has(name) ? " UNINDEXED" : ""}`)
      .join(",\n  ");
    const declaredTokenizer = exactStoredTokenize === "trigram" ? "trigram" : "unicode61 remove_diacritics 2";
    const expectedChunksSql = `CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
  ${declaredColumns},
  tokenize='${declaredTokenizer}'
)`;
    if (normalizeFtsAdmissionSql(chunksSql) !== normalizeFtsAdmissionSql(expectedChunksSql)) {
      throw new Error("Refusing to open an FTS index whose physical tokenizer or schema contradicts metadata");
    }
    let shadowColumns: Array<{ columns: SqliteXColumnInfo[]; name: string }>;
    try {
      shadowColumns = ftsShadowAdmissionTables(expectedChunkColumns.length).map((shadow) => {
        const actualSql = objects.get(shadow.name)?.sql;
        if (typeof actualSql !== "string") throw new Error("missing FTS shadow table");
        const columns = readExactFtsShadowTable(db, actualSql, shadow.sql, shadow.name, shadow.columns);
        if (columns === null) throw new Error("invalid FTS shadow table");
        return { name: shadow.name, columns };
      });
    } catch {
      throw new Error("Refusing to open a populated SQLite database without valid FTS ownership metadata");
    }
    if (numericVersion >= FTS_CHUNK_PARTS_MIN_SCHEMA) {
      // v7 — the sibling identifier-parts table is admitted with the same
      // exactness as `chunks`: declared DDL and every FTS5 shadow table.
      const chunkPartsSql = objects.get("chunk_parts")?.sql;
      if (
        typeof chunkPartsSql !== "string" ||
        normalizeFtsAdmissionSql(chunkPartsSql) !== normalizeFtsAdmissionSql(ftsChunkPartsCreateSql(declaredTokenizer))
      ) {
        throw new Error("Refusing to open an FTS index whose physical tokenizer or schema contradicts metadata");
      }
      try {
        for (const shadow of ftsShadowAdmissionTables(FTS_CHUNK_PARTS_COLUMNS.length, "chunk_parts")) {
          const actualSql = objects.get(shadow.name)?.sql;
          if (typeof actualSql !== "string") throw new Error("missing FTS shadow table");
          if (readExactFtsShadowTable(db, actualSql, shadow.sql, shadow.name, shadow.columns) === null) {
            throw new Error("invalid FTS shadow table");
          }
        }
      } catch {
        throw new Error("Refusing to open a populated SQLite database without valid FTS ownership metadata");
      }
    }
    let chunkColumns: SqliteColumnInfo[];
    let sourceStateColumns: SqliteColumnInfo[];
    try {
      chunkColumns = db
        .prepare(
          "SELECT cid, name, type, \"notnull\", dflt_value, pk FROM pragma_table_info('chunks') ORDER BY cid LIMIT 12"
        )
        .all<SqliteColumnInfo>();
      sourceStateColumns = db
        .prepare(
          'SELECT cid, name, type, "notnull", dflt_value, pk ' +
            "FROM pragma_table_info('source_state') ORDER BY cid LIMIT 6"
        )
        .all<SqliteColumnInfo>();
    } catch {
      throw new Error("Refusing to open a populated SQLite database without valid FTS ownership metadata");
    }
    const exactChunkShape =
      chunkColumns.length === expectedChunkColumns.length &&
      chunkColumns.every(
        (column, index) =>
          column.cid === index &&
          column.name === expectedChunkColumns[index] &&
          column.type === "" &&
          column.notnull === 0 &&
          column.dflt_value === null &&
          column.pk === 0
      );
    const expectedSourceStateColumns =
      numericVersion >= 4
        ? [
            ["rel_path", "TEXT", 0, null, 1],
            ["mtime_ms", "INTEGER", 1, null, 0],
            ["n_chunks", "INTEGER", 1, null, 0],
            ["kind", "TEXT", 1, "'md'", 0],
            ["indexed_at", "TEXT", 1, null, 0]
          ]
        : [
            ["rel_path", "TEXT", 0, null, 1],
            ["mtime_ms", "INTEGER", 1, null, 0],
            ["n_chunks", "INTEGER", 1, null, 0],
            ["indexed_at", "TEXT", 1, null, 0]
          ];
    const exactSourceStateShape =
      sourceStateColumns.length === expectedSourceStateColumns.length &&
      sourceStateColumns.every(
        (column, index) =>
          column.cid === index &&
          column.name === expectedSourceStateColumns[index]?.[0] &&
          column.type === expectedSourceStateColumns[index]?.[1] &&
          column.notnull === expectedSourceStateColumns[index]?.[2] &&
          column.dflt_value === expectedSourceStateColumns[index]?.[3] &&
          column.pk === expectedSourceStateColumns[index]?.[4]
      );
    if (!exactChunkShape || !exactSourceStateShape) {
      throw new Error("Refusing to open a populated SQLite database without valid FTS ownership metadata");
    }

    try {
      const quarantineSql = objects.get("source_quarantine")?.sql;
      if (
        quarantineSql !== undefined &&
        (typeof quarantineSql !== "string" ||
          !hasExactFtsAdmissionTable(
            db,
            "source_quarantine",
            FTS_SOURCE_QUARANTINE_COLUMNS,
            quarantineSql,
            FTS_SOURCE_QUARANTINE_CREATE_SQL
          ))
      ) {
        throw new Error("invalid optional FTS table");
      }
      const revisionSql = objects.get("source_revision")?.sql;
      if (
        revisionSql !== undefined &&
        (typeof revisionSql !== "string" ||
          !hasExactFtsAdmissionTable(
            db,
            "source_revision",
            FTS_SOURCE_REVISION_COLUMNS,
            revisionSql,
            FTS_SOURCE_REVISION_CREATE_SQL
          ))
      ) {
        throw new Error("invalid optional FTS table");
      }
    } catch {
      throw new Error("Refusing to open a populated SQLite database without valid FTS ownership metadata");
    }

    const rebuildReasons: string[] = [];
    if (configuredTokenize !== null && exactStoredTokenize !== configuredTokenize) {
      rebuildReasons.push(`tokenize ${exactStoredTokenize} → ${configuredTokenize}`);
    }
    if (numericVersion < FTS_SCHEMA_VERSION) {
      rebuildReasons.push(`schema_version ${numericVersion} → ${FTS_SCHEMA_VERSION}`);
    }
    return {
      kind: "owned",
      meta: {
        schema_version: storedVersion,
        vault_root: storedRoot,
        tokenize_mode: exactStoredTokenize
      },
      rebuildReasons,
      signature: JSON.stringify([
        schemaRows,
        shadowColumns,
        chunkColumns,
        sourceStateColumns,
        [...meta.entries()].sort(([a], [b]) => a.localeCompare(b))
      ])
    };
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
      db.prepare("DELETE FROM chunk_parts WHERE chunk_parts MATCH ? AND rel_path = ?").run(
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
    const admittedLinkTargets = admitFtsMetadata(wikilinkTargets, {
      label: "wikilinkTargets",
      maxOccurrences: MAX_FTS_LINK_OCCURRENCES,
      maxUnique: MAX_FTS_LINK_TARGETS,
      maxItemBytes: MAX_FTS_LINK_TARGET_BYTES,
      maxTotalBytes: MAX_FTS_LINK_BYTES
    });
    const admittedTags = admitFtsMetadata(tags, {
      label: "tags",
      maxOccurrences: MAX_FTS_TAG_OCCURRENCES,
      maxUnique: MAX_FTS_TAGS,
      maxItemBytes: MAX_FTS_TAG_BYTES,
      maxTotalBytes: MAX_FTS_TAG_BLOB_BYTES
    });
    const chunks = chunkContent(content);
    const tagsSerialized = admittedTags.length ? admittedTags.join(",") : "";
    const aliasesSerialized = aliases.length ? aliases.join(" ") : "";
    const scopeTokens = ftsScopeTokens(relPath);
    const txn = db.transaction(() => {
      db.prepare("DELETE FROM chunks WHERE chunks MATCH ? AND rel_path = ?").run(
        `scope_tokens : ${ftsPathToken(relPath)}`,
        relPath
      );
      db.prepare("DELETE FROM chunk_parts WHERE chunk_parts MATCH ? AND rel_path = ?").run(
        `scope_tokens : ${ftsPathToken(relPath)}`,
        relPath
      );
      const insert = db.prepare(
        "INSERT INTO chunks (content, title, aliases, scope_tokens, rel_path, chunk_index, line_start, line_end, tags, raw_content, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'md')"
      );
      const partsInsert = db.prepare(FTS_CHUNK_PARTS_INSERT_SQL);
      // `tags` is a comma-delimited list so the filter LIKE pattern can wrap it
      // with leading/trailing commas for exact-tag matching at query time. It is
      // repeated because filtering is row-local, but admission above bounds the
      // blob to 4 KiB independently of source size and chunk count.
      chunks.forEach((c, i) => {
        // FTS5 column `content` carries an enriched form: original text + a
        // synthetic `[wikilink_targets: …]` meta-line on chunk 0 so a search for
        // a link target name recalls notes that link out without multiplying the
        // same metadata across every chunk.
        // v2.1.0: also prepend the heading breadcrumb so BM25 search hits
        // notes where the section heading matches a query term even when the
        // body doesn't repeat it. The unindexed `raw_content` keeps the
        // *original* chunk so the `obsidian://chunk/{n}/{path}` resource
        // can return verbatim text.
        const breadcrumbPrefix = c.breadcrumb ? `[section: ${c.breadcrumb}]\n` : "";
        const linksSuffix =
          i === 0 && admittedLinkTargets.length ? `\n[wikilink_targets: ${admittedLinkTargets.join(", ")}]` : "";
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
        // v7 (SBS-D2') — the words each compound identifier in THIS chunk is
        // spelled from go to the sibling `chunk_parts` table, attributed to
        // this chunk so a hit cites the section that carries the identifier.
        // Only identifier-bearing chunks get a row; the splitter bounds the
        // parts by truncation, never by refusing the note.
        const parts = splitIdentifierParts(c.text);
        if (parts.length > 0) {
          partsInsert.run(
            enriched,
            parts.join(" "),
            scopeTokens,
            relPath,
            i,
            c.lineStart,
            c.lineEnd,
            tagsSerialized,
            "md"
          );
        }
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
      db.prepare("DELETE FROM chunk_parts WHERE chunk_parts MATCH ? AND rel_path = ?").run(
        `scope_tokens : ${ftsPathToken(relPath)}`,
        relPath
      );
      const insert = db.prepare(
        "INSERT INTO chunks (content, title, aliases, scope_tokens, rel_path, chunk_index, line_start, line_end, tags, raw_content, kind) VALUES (?, ?, '', ?, ?, ?, ?, ?, '', ?, 'pdf')"
      );
      const partsInsert = db.prepare(FTS_CHUNK_PARTS_INSERT_SQL);
      chunks.forEach((c, i) => {
        // No wikilink/tag enrichment for PDFs (they don't have either). The
        // page marker is already in c.text so it shows up in snippets.
        // rc.6 re-sweep: title on chunk 0 only (see reindexFile) to avoid the
        // per-chunk title-match candidate-set saturation.
        insert.run(c.text, i === 0 ? pdfTitle : "", scopeTokens, relPath, i, c.lineStart, c.lineEnd, c.text);
        // v7 (SBS-D2') — see reindexFile: identifier parts of this chunk.
        const parts = splitIdentifierParts(c.text);
        if (parts.length > 0) {
          partsInsert.run(c.text, parts.join(" "), scopeTokens, relPath, i, c.lineStart, c.lineEnd, "", "pdf");
        }
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
    // Every filter is written once against a `{t}` placeholder so the v7
    // `chunk_parts` pass below runs under exactly the admission `chunks` gets.
    const whereTemplates: string[] = [
      "{t} MATCH ?",
      "{t}.kind IN ('md', 'pdf')",
      "typeof(source_state.mtime_ms) IN ('integer', 'real')",
      `source_state.mtime_ms BETWEEN -${MAX_SOURCE_REVISION} AND ${MAX_SOURCE_REVISION}`,
      "typeof(source_revision.revision) = 'integer'",
      `source_revision.revision BETWEEN 1 AND ${MAX_SOURCE_REVISION}`,
      `NOT EXISTS (
        SELECT 1
        FROM source_quarantine AS quarantined
        WHERE quarantined.rel_path = {t}.rel_path
          AND quarantined.kind = {t}.kind
      )`
    ];
    const filterParams: unknown[] = [];
    const scoped = (base: string): string =>
      opts.folder ? `(${base}) AND scope_tokens : ${ftsFolderToken(opts.folder)}` : base;
    if (opts.folder) {
      // Prefix-equality via substr — avoids GLOB pattern semantics so folder
      // names containing `*`, `?`, `[`, `]` (rare but possible in Obsidian)
      // don't expand into wider matches.
      // v3.11.0-rc.14 (CodeQL js/polynomial-redos #13, HIGH) — linear strip. The old
      // `replace(/\/+$/, "")` WAS exploitable: O(n²) on `/`×n + a non-slash char via the
      // bearer-reachable `folder` arg (measured a multi-second V8 hang). The prior
      // "$ anchor ⇒ O(n)" note was wrong — it held only for all-slash input.
      const prefix = `${stripTrailingSlashes(opts.folder)}/`;
      whereTemplates.push("substr({t}.rel_path, 1, length(?)) = ?");
      filterParams.push(prefix, prefix);
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
      whereTemplates.push("(',' || {t}.tags || ',') LIKE ? ESCAPE '\\'");
      filterParams.push(`%,${literalTag},%`);
    }
    if (opts.sinceMtimeMs !== undefined) {
      whereTemplates.push("source_state.mtime_ms >= ?");
      filterParams.push(opts.sinceMtimeMs);
    }
    type ReceiptRow = {
      rel_path: string;
      chunk_index: number;
      line_start: number;
      line_end: number;
      kind: string | null;
      indexed_mtime_ms: number;
      indexed_revision: number;
      snippet: string;
      score: number;
    };
    const selectFor = (t: string, score: string): string => `
      SELECT ${t}.rel_path AS rel_path, ${t}.chunk_index AS chunk_index,
             ${t}.line_start AS line_start, ${t}.line_end AS line_end,
             ${t}.kind AS kind,
             source_state.mtime_ms AS indexed_mtime_ms,
             source_revision.revision AS indexed_revision,
             snippet(${t}, 0, '«', '»', '…', 25) AS snippet,
             ${score} AS score
      FROM ${t}
      JOIN source_state
        ON ${t}.rel_path = source_state.rel_path
       AND ${t}.kind = source_state.kind
      JOIN source_revision
        ON ${t}.rel_path = source_revision.rel_path
       AND ${t}.kind = source_revision.kind
      WHERE ${whereTemplates.map((clause) => clause.split("{t}").join(t)).join(" AND ")}
      ORDER BY score
      LIMIT ?
    `;
    const toHit = (r: ReceiptRow, score: number): FtsReceiptSearchHit => ({
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
      score
    });
    const rows = db
      .prepare(
        selectFor(
          "chunks",
          `bm25(chunks, ${BM25_WEIGHT_CONTENT}, ${BM25_WEIGHT_TITLE}, ${BM25_WEIGHT_ALIASES}, ${BM25_WEIGHT_SCOPE})`
        )
      )
      .all<ReceiptRow>(scoped(`{content title aliases} : (${safe})`), ...filterParams, limit);
    // BM25 is negative; flip so higher = better for callers.
    const hits = rows.map((r) => toHit(r, -r.score));
    if (hits.length >= limit) return hits;
    // v7 (SBS-D2') — found, not ranked. A chunk reachable only through the
    // words its identifiers are spelled from is appended after every ranked
    // `chunks` hit with score 0, so the pass changes what is FOUND and never
    // how anything above it RANKS. `bm25(chunk_parts)` only makes the order of
    // the appended tail deterministic. A chunk the ranked pass already returned
    // is skipped; the tail may therefore under-fill the limit.
    const seen = new Set(hits.map((hit) => `${hit.rel_path}\u0000${hit.chunk_index}`));
    const partsRows = db
      .prepare(selectFor("chunk_parts", "bm25(chunk_parts)"))
      .all<ReceiptRow>(scoped(`{content parts} : (${safe})`), ...filterParams, limit);
    for (const r of partsRows) {
      if (hits.length >= limit) break;
      const key = `${r.rel_path}\u0000${r.chunk_index}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push(toHit(r, 0));
    }
    return hits;
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

// Keeps the authoritative admission implementation single-sourced while the
// exported discovery function supplies a readonly handle instead of opening or
// mutating through FtsIndex.open().
class ReadonlyFtsAdmissionInspector extends FtsIndex {
  inspectReadonlyHandle(db: Db): FtsAdmission {
    return this.inspectAdmission(db, null);
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
  const listing = await vault.listFilesByExtensionsBounded(
    [".md"],
    MAX_INDEX_SYNC_FILES,
    MAX_INDEX_SYNC_VISITED_ENTRIES
  );
  if (!listing.complete) {
    throw new Error(
      `FTS Markdown source inventory is incomplete within ${MAX_INDEX_SYNC_FILES} files / ${MAX_INDEX_SYNC_VISITED_ENTRIES} visited entries; refusing to infer deletions`
    );
  }
  const entries = listing.entries;
  const live = entries.map((entry) => ({ relPath: entry.relPath, mtimeMs: entry.mtimeMs }));
  const diff = idx.diff(live, "md");
  const entriesByPath = new Map(entries.map((entry) => [entry.relPath, entry]));
  const addedPaths = new Set(diff.added);
  const changedEntries = [...diff.added, ...diff.updated].map((relPath) => {
    const entry = entriesByPath.get(relPath);
    if (!entry) throw new Error(`FTS diff returned a path outside the admitted Markdown inventory: ${relPath}`);
    return { relPath, entry };
  });
  let added = 0;
  let updated = 0;
  let empty = 0;
  let failed = 0;
  let processed = diff.unchanged.length;
  for (const { relPath, entry } of changedEntries) {
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
  let deleted = 0;
  for (const relPath of diff.deleted) {
    idx.dropFile(relPath);
    deleted += 1;
  }
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
    deleted,
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

/** Evidence-bearing counters from one PDF-to-FTS synchronization. */
export interface PdfFtsSyncReport {
  /** Newly indexed PDF sources whose replacement transaction committed. */
  added: number;
  /** Previously known PDF sources whose replacement transaction committed. */
  updated: number;
  /** Missing PDF sources whose retained rows were actually dropped. */
  deleted: number;
  /** Live PDF sources whose admitted mtime matched their retained generation. */
  unchanged: number;
  /** Complete, readable PDFs with no extractable text; no indexed generation was retained. */
  skipped: number;
  /** PDF sources whose read, extraction, page admission, or indexing failed. */
  failed: number;
  /** Total physical chunks across Markdown and PDF kinds after this sync. */
  total_chunks: number;
  /** True when the inventory was complete and every changed source either committed or was authoritatively empty. */
  complete: boolean;
}

/**
 * Synchronize PDF chunks into an opened FTS5 index.
 *
 * The complete bounded PDF inventory is diffed against retained PDF source
 * state. Each changed source is extracted and admitted independently; failed
 * or partial page evidence quarantines that source while preserving its prior
 * coherent generation. A complete textless PDF authoritatively clears stale
 * rows. The optional PDF module is resolved before any destructive diff work.
 *
 * @param vault - Vault whose complete admitted PDF inventory is synchronized.
 * @param idx - Open FTS index receiving committed PDF generations.
 * @returns Counters for actual commits, authoritative textless skips, and failures.
 * @throws {Error} When the bounded source inventory is incomplete, the
 *   optional extraction module cannot load, or deletion itself fails.
 * @example
 * ```ts
 * const report = await syncPdfFtsIndex(vault, index);
 * if (!report.complete) process.stderr.write(`PDF failures: ${report.failed}\n`);
 * ```
 */
export async function syncPdfFtsIndex(vault: Vault, idx: FtsIndex): Promise<PdfFtsSyncReport> {
  const listing = await vault.listFilesByExtensionsBounded(
    [".pdf"],
    MAX_INDEX_SYNC_FILES,
    MAX_INDEX_SYNC_VISITED_ENTRIES
  );
  if (!listing.complete) {
    throw new Error(
      `FTS PDF source inventory is incomplete within ${MAX_INDEX_SYNC_FILES} files / ${MAX_INDEX_SYNC_VISITED_ENTRIES} visited entries; refusing to infer deletions`
    );
  }
  const pdfEntries = listing.entries;
  const live = pdfEntries.map((entry) => ({ relPath: entry.relPath, mtimeMs: entry.mtimeMs }));
  const diff = idx.diff(live, "pdf");
  const entriesByPath = new Map(pdfEntries.map((entry) => [entry.relPath, entry]));
  const updatedSet = new Set(diff.updated);
  const addedSet = new Set(diff.added);
  const changedEntries = [...diff.added, ...diff.updated].map((relPath) => {
    const entry = entriesByPath.get(relPath);
    if (!entry) throw new Error(`FTS diff returned a path outside the admitted PDF inventory: ${relPath}`);
    return { relPath, entry };
  });
  const pdfModule = changedEntries.length > 0 ? await import("./pdf.js") : null;
  let added = 0;
  let updated = 0;
  let deleted = 0;
  let skipped = 0;
  let failed = 0;
  for (const relPath of diff.deleted) {
    idx.dropFile(relPath);
    deleted += 1;
  }
  for (const { relPath, entry } of changedEntries) {
    try {
      if (!pdfModule) throw new Error("PDF extraction module was not loaded for a changed source");
      const buf = await vault.readBinaryFile(entry.absPath);
      const result = await pdfModule.extractPdfText(buf);
      pdfModule.assertPdfPagesComplete(result.pages);
      if (!result.hasText) {
        idx.dropFile(relPath);
        skipped += 1;
        if (updatedSet.has(relPath)) {
          process.stderr.write(
            `enquire: dropping stale rows for ${relPath} during pdf-fts5 sync — PDF is now image-only / scanned (previous text-extracted chunks removed)\n`
          );
        } else {
          process.stderr.write(
            `enquire: skipping ${relPath} during pdf-fts5 sync — image-only / scanned (no extractable text; use OCR via v2.9+)\n`
          );
        }
        continue;
      }
      const indexedChunks = idx.reindexPdfFile(relPath, entry.mtimeMs, result.pages);
      if (indexedChunks <= 0) throw new Error(`${relPath} produced zero PDF FTS chunks after validation`);
      if (addedSet.has(relPath)) added += 1;
      else updated += 1;
    } catch (error) {
      idx.quarantineFile(relPath, "pdf");
      failed += 1;
      process.stderr.write(
        `enquire: skipping ${relPath} during pdf-fts5 sync — ${error instanceof Error ? error.message : String(error)}\n`
      );
    }
  }
  return {
    added,
    updated,
    deleted,
    unchanged: diff.unchanged.length,
    skipped,
    failed,
    total_chunks: idx.totalChunks(),
    complete: failed === 0
  };
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

interface ChunkLogicalLine {
  text: string;
  end: string;
  line: number;
  breadcrumb: string;
  textEndOffset: number;
  endOffset: number;
}

interface ChunkParagraphSpan {
  startOffset: number;
  endOffset: number;
  startLineIndex: number;
  endLineIndex: number;
}

function chunkLogicalLines(content: string): ChunkLogicalLine[] {
  const lines: ChunkLogicalLine[] = [];
  let offset = 0;
  for (const logical of iterateContentLines(content)) {
    const startOffset = offset;
    const textEndOffset = startOffset + logical.text.length;
    const endOffset = textEndOffset + logical.end.length;
    lines.push({
      text: logical.text,
      end: logical.end,
      line: logical.line,
      breadcrumb: logical.breadcrumb.join(" > "),
      textEndOffset,
      endOffset
    });
    offset = endOffset;
  }
  if (offset !== content.length) throw new Error("Logical-line iterator did not consume the complete FTS source");
  return lines;
}

function chunkParagraphSpans(content: string, lines: readonly ChunkLogicalLine[]): ChunkParagraphSpan[] {
  const spans: ChunkParagraphSpan[] = [];
  let paragraphStartOffset = 0;
  let paragraphStartLineIndex = 0;
  let lineIndex = 0;
  while (lineIndex < lines.length) {
    const first = lines[lineIndex];
    if (!first || first.end === "") {
      lineIndex += 1;
      continue;
    }

    // A paragraph delimiter is two or more ADJACENT logical terminators.
    // The first terminator belongs to `first`; every continuation appears as
    // an empty logical line with its own terminator. This treats CRLF as one
    // terminator and supports mixed LF/CRLF/CR/LS/PS runs without a regex
    // rescan or byte normalization.
    let runEnd = lineIndex;
    while (true) {
      const next = lines[runEnd + 1];
      if (next?.text !== "" || next.end === "") break;
      runEnd += 1;
    }
    if (runEnd === lineIndex) {
      lineIndex += 1;
      continue;
    }

    spans.push({
      startOffset: paragraphStartOffset,
      endOffset: first.textEndOffset,
      startLineIndex: paragraphStartLineIndex,
      endLineIndex: lineIndex
    });
    const lastDelimiterLine = lines[runEnd];
    if (!lastDelimiterLine) throw new Error("Logical paragraph delimiter ended outside the FTS source");
    paragraphStartOffset = lastDelimiterLine.endOffset;
    paragraphStartLineIndex = runEnd + 1;
    lineIndex = runEnd + 1;
  }

  if (paragraphStartOffset < content.length) {
    spans.push({
      startOffset: paragraphStartOffset,
      endOffset: content.length,
      startLineIndex: paragraphStartLineIndex,
      endLineIndex: lines.length - 1
    });
  }
  return spans;
}

function hardCutChunkLine(line: ChunkLogicalLine, maxChars: number, chunks: ContentChunk[]): void {
  for (let start = 0; start < line.text.length; ) {
    let end = Math.min(start + maxChars, line.text.length);
    if (end < line.text.length) {
      const code = line.text.charCodeAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff && end - 1 > start) end -= 1;
    }
    chunks.push({
      text: line.text.slice(start, end),
      lineStart: line.line,
      lineEnd: line.line,
      breadcrumb: line.breadcrumb
    });
    start = end;
  }
}

/**
 * Paragraph-first chunker with `blank logical line → logical line → hardcut`
 * fallback. The canonical line authority treats LF, CRLF, CR, U+2028, and
 * U+2029 as terminators. Returned chunk text is always an exact source slice
 * or exact concatenation across the source's own unchanged terminators; no
 * newline spelling is synthesized. Each chunk carries 1-based line offsets so
 * callers can quote precise locations.
 *
 * v2.1.0: also attaches a heading breadcrumb to each chunk (the H1>H2>H3
 * path in effect at chunk start). Preserves Obsidian markdown structure
 * for downstream retrievers without a custom parser. ATX headings only —
 * fenced code blocks (where `#` is shell prompt, not heading) are skipped.
 *
 * @param content - Markdown content to split.
 * @param maxChars - Positive safe-integer UTF-16-unit target per chunk.
 * @returns Non-empty chunks with source-line and breadcrumb metadata.
 * @throws {RangeError} If `maxChars` is not a positive safe integer.
 */
export function chunkContent(content: string, maxChars = MAX_CHUNK_CHARS): ContentChunk[] {
  if (!Number.isSafeInteger(maxChars) || maxChars <= 0) {
    throw new RangeError("maxChars must be a positive safe integer");
  }
  if (!content) return [];

  // One canonical structure walk supplies exact terminators, absolute logical
  // line numbers, fence-aware headings, and breadcrumbs. Paragraph and line
  // fallback stages consume this same authority rather than rescanning with
  // LF-only regular expressions.
  const lines = chunkLogicalLines(content);
  const paragraphs = chunkParagraphSpans(content, lines);
  const chunks: ContentChunk[] = [];
  for (const p of paragraphs) {
    const firstLine = lines[p.startLineIndex];
    const lastLine = lines[p.endLineIndex];
    if (!firstLine || !lastLine) throw new Error("FTS paragraph span refers to a missing logical line");
    if (p.endOffset - p.startOffset <= maxChars) {
      chunks.push({
        text: content.slice(p.startOffset, p.endOffset),
        lineStart: firstLine.line,
        lineEnd: lastLine.line,
        breadcrumb: firstLine.breadcrumb
      });
      continue;
    }

    // Paragraph too big — pack exact logical lines. A new buffer receives the
    // breadcrumb in scope at ITS start line, so a heading change inside one
    // oversize no-blank-line paragraph cannot leave later chunks stale.
    let buf: (ContentChunk & { lastLineIndex: number }) | null = null;
    for (let currentIndex = p.startLineIndex; currentIndex <= p.endLineIndex; currentIndex += 1) {
      const line = lines[currentIndex];
      if (!line) throw new Error("FTS paragraph line range escaped the logical-line inventory");
      if (line.text.length > maxChars) {
        if (buf) {
          chunks.push(buf);
          buf = null;
        }
        hardCutChunkLine(line, maxChars, chunks);
        continue;
      }
      if (!buf) {
        buf = {
          text: line.text,
          lineStart: line.line,
          lineEnd: line.line,
          breadcrumb: line.breadcrumb,
          lastLineIndex: currentIndex
        };
        continue;
      }
      const prior = lines[buf.lastLineIndex];
      if (!prior) throw new Error("FTS line buffer lost its preceding logical line");
      if (buf.text.length + prior.end.length + line.text.length > maxChars) {
        chunks.push(buf);
        buf = {
          text: line.text,
          lineStart: line.line,
          lineEnd: line.line,
          breadcrumb: line.breadcrumb,
          lastLineIndex: currentIndex
        };
      } else {
        buf.text += prior.end + line.text;
        buf.lineEnd = line.line;
        buf.lastLineIndex = currentIndex;
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

/**
 * Default location for the FTS5 index file — `~/.cache/enquire/<hash>.fts5.db`
 * (or `$XDG_CACHE_HOME/enquire/<hash>.fts5.db` when that env value is an
 * absolute path). The hash is the first 12 chars of sha1(vaultRoot), retained
 * as a legacy routing key. Non-colliding roots get distinct default paths; the
 * truncated key is not collision-proof vault identity. Collision handling and
 * a root-bound migration are deferred to AH-9e.
 *
 * A relative or empty `XDG_CACHE_HOME` is ignored so the result does not
 * depend on this process's CWD. `doctor` and `serve` then share the same
 * default FTS/embed file even when they are launched from different
 * directories. Parse-cache, feedback, and tessdata resolvers are separate
 * formulas and are not this function.
 *
 * @param vaultRoot - Absolute path to the vault root.
 * @returns Absolute path to the index file.
 */
export function defaultIndexFile(vaultRoot: string): string {
  const raw = process.env.XDG_CACHE_HOME;
  const base =
    raw !== undefined && path.isAbsolute(raw)
      ? raw
      : process.platform === "darwin"
        ? path.join(os.homedir(), "Library", "Caches")
        : path.join(os.homedir(), ".cache");
  const hash = createHash("sha1").update(vaultRoot).digest("hex").slice(0, 12);
  return path.join(base, "enquire", `${hash}.fts5.db`);
}

/**
 * Strict reserved filename namespace for legacy routing-key-scoped cache artifacts:
 * `<12-hex-sha1>.{json,fts5.db,embed.db,hnsw.meta.json}` plus legacy/fixed and
 * immutable HNSW binaries, SQLite sidecars, and recognized publisher temps.
 * Anchored +
 * exhaustively enumerated so prune cannot select a name outside these families
 * (for example `notes.md`). This is filename recognition, not creation
 * provenance: a same-account writer that deliberately impersonates an exact
 * reserved name is inside the local-filesystem trust boundary.
 *
 * v3.10.0-rc.37 (audit #3 — right-to-erasure) — the `json` family is the
 * `defaultCacheFile` parse cache (`<hash>.json`, written by `saveDiskCache`),
 * which holds the FULL raw body of every note in its vault. It was missing here,
 * so a cross-stem `prune` deleted a non-colliding decommissioned root's `.fts5.db`/`.embed.db`/
 * HNSW sidecars but LEFT its `<hash>.json` (+ any `<hash>.json.tmp`) full-text
 * cache on disk forever. Now covered (writers ⊆ erasers — the erasure invariant
 * pins this so a future writer family can't silently escape prune again).
 *
 * v3.11.0 — the `feedback\.json` family is the closed-loop feedback store
 * (`<hash>.feedback.json`, written by `FeedbackStore`; relative note paths +
 * usefulness counts). Listed so a cross-stem `prune` recognizes a non-colliding
 * decommissioned root's feedback, like every other routing-key-scoped artifact.
 * (`feedback\.json` is listed before `json` for readability; ordering is NOT
 * load-bearing — the alternation is anchored right after the `\.` following the
 * 12-hex hash, so for `<hash>.feedback.json` the `json` alternative is tried at
 * the `f` and can't match the `json` tail; either order matches correctly.)
 */
const ENQUIRE_CACHE_ARTIFACT =
  /^[0-9a-f]{12}\.(?:(?:feedback\.json|json)(?:\.tmp)?|(?:fts5|embed)\.db(?:-wal|-shm|-journal)?|hnsw\.bin|hnsw\.meta\.json|hnsw\.[0-9a-f]{48}\.bin)(?![\s\S])/;
const VAULT_ROUTING_KEY = /^[0-9a-f]{12}(?![\s\S])/;
const WATCHER_ACTIVATION_GUARD = /^([0-9a-f]{12})\.embed\.db\.watcher-activation\.guard(?![\s\S])/;

function canonicalCacheArtifactBasename(entry: string): string | null {
  const ownedFinal = sensitiveArtifactFinalBasename(entry) ?? entry;
  if (!ENQUIRE_CACHE_ARTIFACT.test(ownedFinal.toLowerCase())) return null;
  return entry.toLowerCase();
}

/**
 * Plan a cache prune: given the filenames present in enquire's cache directory
 * and the 12-hex legacy routing key to KEEP, return the canonically spelled
 * reserved-name subset under OTHER routing keys. Pure and side-effect-free,
 * so the destructive `prune` CLI can preview before touching disk and the
 * safety invariant (never selects outside the reserved namespace or the kept
 * routing key) is unit-testable. A visible watcher-activation guard for any
 * selected stem vetoes the whole plan; pruning around an in-progress derived
 * generation would make the plan's commit truth unknowable. It does not prove
 * who created a matching entry or distinguish roots that collide on the
 * truncated key.
 *
 * @param entries Filenames (basenames) present in the cache directory.
 * @param keepHash The 12-hex legacy routing key to preserve (from `defaultIndexFile`).
 * @returns Recognized reserved basenames eligible for removal, never `keepHash`.
 * @throws {TypeError} If `keepHash` is not exactly 12 lowercase hexadecimal characters.
 * @throws {Error} If a selected stem has a visible watcher-activation guard.
 * @example planCachePrune(["aaaaaaaaaaaa.fts5.db", "bbbbbbbbbbbb.fts5.db", "notes.md"], "aaaaaaaaaaaa")
 *   // → ["bbbbbbbbbbbb.fts5.db"]   (keeps aaaa…, ignores notes.md)
 */
export function planCachePrune(entries: readonly string[], keepHash: string): string[] {
  if (!VAULT_ROUTING_KEY.test(keepHash)) {
    throw new TypeError("Cache prune keep key must be exactly 12 lowercase hexadecimal characters");
  }
  for (const entry of entries) {
    const guard = WATCHER_ACTIVATION_GUARD.exec(entry);
    if (guard?.[1] !== undefined && guard[1] !== keepHash) {
      throw new Error(
        `Refusing cache prune: watcher activation guard is present for selected routing stem ${guard[1]}`
      );
    }
  }
  return entries.filter((entry) => {
    // Random publisher temps/stages encode their exact final basename. Unwrap
    // one layer, then apply the same strict artifact whitelist; this admits
    // crash leftovers without broadening prune to arbitrary random names.
    const ownedFinal = sensitiveArtifactFinalBasename(entry) ?? entry;
    return (
      entry === canonicalCacheArtifactBasename(entry) &&
      ENQUIRE_CACHE_ARTIFACT.test(ownedFinal) &&
      !ownedFinal.startsWith(`${keepHash}.`)
    );
  });
}

/**
 * Plan an on-disk prune while distinguishing a native spelling alias from a
 * distinct folded-looking entry on a case-sensitive filesystem.
 *
 * Canonically spelled reserved-namespace entries come from {@link planCachePrune}.
 * A non-canonical spelling is admitted only when a canonical-parent directory
 * snapshot contains at most one supplied spelling and BigInt device/inode
 * identity proves that spelling names the expected entry. A folded but distinct
 * entry refuses the whole plan instead of becoming deletion authority.
 * This binds the observed directory snapshot, not an active post-plan ABA;
 * callers must keep the parent stable through deletion.
 *
 * @param cacheDir - Existing cache directory containing `entries`.
 * @param entries - Exact basenames returned by `readdir(cacheDir)`.
 * @param keepHash - Lowercase 12-hex legacy routing key to preserve.
 * @returns Basenames safe to remove from this exact directory snapshot.
 * @throws {TypeError} If `keepHash` is not exactly 12 lowercase hexadecimal characters.
 * @example
 * await planCachePruneOnDisk("/tmp/enquire", ["bbbbbbbbbbbb.json"], "aaaaaaaaaaaa");
 * @internal
 */
export async function planCachePruneOnDisk(
  cacheDir: string,
  entries: readonly string[],
  keepHash: string
): Promise<string[]> {
  const exact = new Set(planCachePrune(entries, keepHash));
  const plan = [...exact];
  for (const entry of entries) {
    if (exact.has(entry)) continue;
    const canonicalEntry = canonicalCacheArtifactBasename(entry);
    if (!canonicalEntry || canonicalEntry === entry) continue;
    const canonicalFinal = sensitiveArtifactFinalBasename(canonicalEntry) ?? canonicalEntry;
    if (canonicalFinal.startsWith(`${keepHash}.`)) continue;
    if (await sameCanonicalDirectoryEntry(path.join(cacheDir, entry), path.join(cacheDir, canonicalEntry))) {
      plan.push(entry);
      continue;
    }
    throw new Error("Refusing cache prune: a reserved artifact has ambiguous path spelling");
  }
  for (const entry of plan) {
    const entryPath = path.join(cacheDir, entry);
    if (sensitiveArtifactFinalBasename(entry)) {
      await preflightSensitiveArtifactTempEntry(entryPath);
      continue;
    }
    let stat: import("node:fs").Stats;
    try {
      stat = await fs.lstat(entryPath);
    } catch (err) {
      throw new Error("Refusing cache prune: an artifact changed after the directory snapshot", { cause: err });
    }
    if (!stat.isFile() && !stat.isSymbolicLink()) {
      throw new Error("Refusing cache prune: an artifact is not a regular file or symlink leaf");
    }
  }
  return plan;
}

/**
 * Classify a configured FTS path through the same exact admission logic used
 * by {@link FtsIndex.open}, but on one readonly handle and without Enquire
 * bootstrap, persistent PRAGMA mutation, DDL, DML, or chmod. SQLite/VFS lock,
 * recovery, and WAL/SHM bookkeeping remain outside this logical guarantee.
 * The main/WAL/SHM/rollback-journal family is checked before dependency load
 * and again immediately before native open; unsafe, hardlinked, or orphaned
 * leaves collapse to `refused` under the stable-parent boundary.
 *
 * @param file - Configured `.fts5.db` path.
 * @param expectedVaultRoot - Exact canonical vault root expected to own it.
 * @returns `missing` or genuinely schema-`empty` when caller defaults are safe,
 *   `owned` with the physically proven stored tokenizer, or generic `refused`.
 * @throws {TypeError} If `file` is outside the exact `.fts5.db` namespace.
 * @example
 * ```ts
 * const discovery = await discoverFtsIndexConfig(indexFile, vaultRoot);
 * const tokenize = discovery.kind === "owned" ? discovery.meta.tokenize_mode : "unicode61";
 * const index = new FtsIndex({ file: indexFile, vaultRoot, tokenize });
 * await index.open(discovery);
 * ```
 */
export async function discoverFtsIndexConfig(file: string, expectedVaultRoot: string): Promise<FtsIndexDiscovery> {
  assertFtsIndexFilePath(file);
  let fileExisted: boolean;
  try {
    fileExisted = await preflightSqliteArtifactFamily(file);
  } catch {
    return { kind: "refused" };
  }
  if (!fileExisted) return { kind: "missing" };

  let Database: typeof import("better-sqlite3");
  try {
    Database = (await import("better-sqlite3")).default as unknown as typeof import("better-sqlite3");
  } catch {
    return { kind: "refused" };
  }

  let db: Db | null = null;
  let discovery: FtsIndexDiscovery = { kind: "refused" };
  try {
    if (!(await preflightSqliteArtifactFamily(file))) return { kind: "missing" };
    db = new Database(file, { readonly: true, fileMustExist: true }) as unknown as Db;
    const inspector = new ReadonlyFtsAdmissionInspector({
      file,
      vaultRoot: expectedVaultRoot
    });
    const admission = inspector.inspectReadonlyHandle(db);
    discovery = admission.kind === "empty" ? { kind: "empty" } : { kind: "owned", meta: admission.meta };
  } catch {
    discovery = { kind: "refused" };
  } finally {
    try {
      db?.close();
    } catch {
      // A native close failure invalidates even a previously admitted result;
      // never expose the error or a path it may carry.
      discovery = { kind: "refused" };
    }
  }
  return discovery;
}

/**
 * Legacy fail-soft diagnostic peek at bounded FTS metadata.
 *
 * Production configuration decisions use {@link discoverFtsIndexConfig}, whose
 * discriminated result distinguishes missing and exactly schema-empty files
 * from full-class, exact-root ownership and generic refusal. This compatibility
 * helper never authorizes an open or rebuild. Missing dependencies,
 * unreadable/corrupt files, malformed rows, unsupported tokenizer values, and
 * query failures collapse to `null`. A close failure never escapes; this
 * legacy diagnostic may still return metadata already read. The complete
 * main/WAL/SHM/rollback-journal family receives the same two-stage singly
 * linked regular-file preflight as production discovery; an unsafe or orphaned
 * leaf returns `null` before native open.
 *
 * @param file - Absolute path to a `.fts5.db` file.
 * @param expectedVaultRoot - When supplied, return metadata only when its
 *   exact stored owner matches this vault root.
 * @returns Bounded metadata when readable and root-compatible, otherwise
 *   `null`. This is not a substitute for {@link FtsIndex.open}'s admission.
 * @throws {TypeError} If `file` is outside the exact `.fts5.db` namespace.
 * @example
 * ```ts
 * const meta = await peekFtsMetaSafe(indexFile, vaultRoot);
 * console.log(meta?.schema_version); // diagnostic only
 * ```
 */
export async function peekFtsMetaSafe(
  file: string,
  expectedVaultRoot?: string
): Promise<{
  schema_version?: string;
  vault_root?: string;
  tokenize_mode?: TokenizeMode;
} | null> {
  assertFtsIndexFilePath(file);
  try {
    if (!(await preflightSqliteArtifactFamily(file))) return null;
  } catch {
    return null;
  }
  let Database: typeof import("better-sqlite3");
  try {
    Database = (await import("better-sqlite3")).default as unknown as typeof import("better-sqlite3");
  } catch {
    return null;
  }
  // v3.10.0-rc.33 (post-rc.31 audit) — `new Database()` + the meta queries are
  // now INSIDE the try: a "Safe" peek must NEVER throw. Previously a corrupt /
  // unreadable / not-a-DB index file (or a path that is a directory) must not
  // escape this legacy diagnostic. Any failure maps to null.
  let db: Db | null = null;
  try {
    if (!(await preflightSqliteArtifactFamily(file))) return null;
    db = new Database(file, { readonly: true, fileMustExist: true }) as unknown as Db;
    const tableCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'").get();
    if (!tableCheck) return null;
    const rows = db
      .prepare("SELECT substr(key, 1, ?) AS key, substr(value, 1, ?) AS value FROM meta LIMIT 4")
      .all<{ key: unknown; value: unknown }>(MAX_FTS_ADMISSION_NAME_CHARS + 1, MAX_FTS_META_VALUE_CHARS + 1);
    if (rows.length !== 3) return null;
    const meta: { schema_version?: string; vault_root?: string; tokenize_mode?: TokenizeMode } = {};
    for (const row of rows) {
      if (
        typeof row.key !== "string" ||
        row.key.length > MAX_FTS_ADMISSION_NAME_CHARS ||
        typeof row.value !== "string" ||
        row.value.length > MAX_FTS_META_VALUE_CHARS
      ) {
        return null;
      }
      if (row.key === "schema_version" && meta.schema_version === undefined) meta.schema_version = row.value;
      else if (row.key === "vault_root" && meta.vault_root === undefined) meta.vault_root = row.value;
      else if (row.key === "tokenize_mode") {
        // Discovery is fail-soft, never authoritative: an unsupported stored
        // value must not be laundered into unicode61 and then used by a caller.
        if (meta.tokenize_mode !== undefined || (row.value !== "unicode61" && row.value !== "trigram")) return null;
        meta.tokenize_mode = row.value;
      } else return null;
    }
    if (meta.schema_version === undefined || meta.vault_root === undefined || meta.tokenize_mode === undefined) {
      return null;
    }
    if (expectedVaultRoot !== undefined && meta.vault_root !== expectedVaultRoot) return null;
    return meta;
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // Discovery is fail-soft even if the optional native handle reports a
      // close failure; never replace the bounded result with a pathful error.
    }
  }
}
