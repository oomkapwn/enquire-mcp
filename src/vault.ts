import { createHash, randomBytes } from "node:crypto";
import { promises as fs, constants as fsConstants } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { foldName } from "./name-fold.js";
import { type ParsedNote, parseNote } from "./parser.js";
import { loadPeriodicConfig, type PeriodicConfig } from "./periodic.js";
import {
  acquirePersistenceFamilyLease,
  acquirePersistenceFamilyLeaseInScopes,
  type PersistenceFamilyLeaseHandle,
  type PersistenceFamilyScopes
} from "./persistence-coordination.js";
import { revalidatePersistenceLeaseScope } from "./persistence-lease.js";
import { assertCacheFilePath } from "./persistence-path.js";
import {
  preflightSensitiveArtifactTemps,
  publishSensitiveArtifact,
  readSensitiveArtifactText,
  removeSensitiveArtifactTemps
} from "./sensitive-artifact.js";
import { type RestrictedVaultPathReason, restrictedVaultPathReason } from "./vault-path-policy.js";
import { compileGlobTokens, matchWildcardTokens } from "./wildcard-match.js";
import { windowsRelativePathProblem } from "./windows-path.js";

/** Stable reason returned when a path is outside the public vault surface. */
export type VaultExclusionReason =
  | RestrictedVaultPathReason
  | "--read-paths allowlist (path doesn't match any allow-glob)"
  | "--exclude-glob denylist";

interface RenameEntryReceipt {
  realRel: string;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  mode: number;
}

type RenameDestinationClassification =
  | { kind: "missing"; canonicalRel: string }
  | { kind: "same-canonical-case-alias"; canonicalRel: string }
  | { kind: "distinct"; canonicalRel: string; receipt: RenameEntryReceipt }
  | { kind: "distinct-hardlink"; canonicalRel: string; receipt: RenameEntryReceipt }
  | { kind: "unproven"; canonicalRel: string; reason: string };

interface RenameFileOptions {
  overwrite?: boolean;
  /** Planning receipt supplied by the backlink-rewrite orchestrator. @internal */
  expectedDestination?: RenameDestinationClassification;
}

class RenameDestinationChangedError extends Error {
  constructor(relPath: string) {
    super(`Refusing to rename — destination changed after planning: ${relPath}`);
    this.name = "RenameDestinationChangedError";
  }
}

class RenamePrecommitError extends Error {
  constructor(relPath: string, cause: unknown) {
    super(`Refusing to rename — precommit validation failed after planning: ${relPath}`, { cause });
    this.name = "RenamePrecommitError";
  }
}

function vaultRelative(root: string, abs: string): string {
  const rel = path.relative(root, abs);
  return path.sep === "\\" ? rel.replaceAll("\\", "/") : rel;
}

function renameEntryReceipt(root: string, realAbs: string, stat: import("node:fs").Stats): RenameEntryReceipt {
  return {
    realRel: vaultRelative(root, realAbs),
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    mode: stat.mode
  };
}

function renameEntryReceiptsEqual(left: RenameEntryReceipt, right: RenameEntryReceipt): boolean {
  return (
    left.realRel === right.realRel &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.mode === right.mode
  );
}

function renameDestinationMatches(
  expected: RenameDestinationClassification,
  current: RenameDestinationClassification
): boolean {
  if (expected.canonicalRel !== current.canonicalRel) return false;
  switch (expected.kind) {
    case "missing":
      return current.kind === "missing";
    case "same-canonical-case-alias":
      // Rewriting source self-links uses atomic replacement and may therefore
      // change the shared entry's inode before the physical case-only rename.
      return current.kind === "same-canonical-case-alias";
    case "distinct":
      return current.kind === "distinct" && renameEntryReceiptsEqual(expected.receipt, current.receipt);
    case "distinct-hardlink":
    case "unproven":
      return false;
  }
}

// v3.11.7-rc.2 (post-merge re-sweep A10-F1) — serialize append size-check
// + write by physical file identity across EVERY Vault instance in this
// process. rc.1 keyed the canonical absolute path, so two hardlink aliases
// for the same inode acquired different queues and jointly exceeded the cap.
// On filesystems exposing a stable inode, dev+ino closes both path-alias and
// multi-instance forms. When Node reports ino=0, all appends share one
// conservative fallback lane: correctness wins over parallelism because a
// pathname fallback would knowingly reopen the hardlink-alias race. Entries
// self-evict after the final waiter releases.
const APPEND_IDENTITY_TAILS = new Map<string, Promise<void>>();

function appendIdentityKey(stat: import("node:fs").Stats): string {
  return stat.ino !== 0 ? `inode:${stat.dev}:${stat.ino}` : "inode-unavailable";
}

async function withAppendIdentityLock<T>(identityKey: string, fn: () => Promise<T>): Promise<T> {
  const previous = APPEND_IDENTITY_TAILS.get(identityKey) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => {}).then(() => gate);
  APPEND_IDENTITY_TAILS.set(identityKey, tail);
  await previous.catch(() => {});
  try {
    return await fn();
  } finally {
    release?.();
    if (APPEND_IDENTITY_TAILS.get(identityKey) === tail) APPEND_IDENTITY_TAILS.delete(identityKey);
  }
}

/** Maximum file size {@link Vault.readNote} / {@link Vault.writeNote} will
 *  process by default. 5 MB — large enough for any realistic note, small
 *  enough that a runaway file (e.g. a multi-GB log mistakenly placed in
 *  the vault) doesn't OOM the server. */
export const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
/** Maximum in-memory parsed-note cache size (LRU eviction past this). */
export const DEFAULT_MAX_CACHE_ENTRIES = 1024;
/** Maximum source-file metadata entries retained by one exact legacy listing. */
export const MAX_EXACT_LIST_FILES = 100_000;
/** Maximum filesystem directory entries inspected by one exact legacy listing. */
export const MAX_EXACT_LIST_VISITED_ENTRIES = 1_000_000;
/** Maximum source-file metadata entries retained by one exact bulk index synchronization. */
export const MAX_INDEX_SYNC_FILES = MAX_EXACT_LIST_FILES;
/** Maximum filesystem directory entries inspected by one exact bulk index synchronization. */
export const MAX_INDEX_SYNC_VISITED_ENTRIES = MAX_EXACT_LIST_VISITED_ENTRIES;
/** Hard upper bound for persisted-cache candidates inspected during one load. */
const MAX_PERSISTED_CACHE_ENTRY_INSPECTIONS = 100_000;
/** Bound filesystem probes issued concurrently while admitting persisted entries. */
const PERSISTED_CACHE_VALIDATION_CONCURRENCY = 32;
/** Defensive bound for each parsed-note collection restored from untrusted JSON. */
const MAX_PERSISTED_PARSED_COLLECTION_ITEMS = 100_000;
/** Maximum depth of one JSON-compatible entry admitted to the disk-cache serializer. */
const MAX_DISK_CACHE_JSON_DEPTH = 64;
/** Maximum primitive/container values traversed in one persisted cache entry. */
const MAX_DISK_CACHE_JSON_VALUES = 100_000;
/** Maximum accepted disk-cache save requests retained behind the publication lane. */
const MAX_PENDING_DISK_CACHE_SAVES = 8;
/** Maximum historical cache targets whose exact lifetimes one Vault may retain. */
const MAX_PERSISTENT_CACHE_TARGETS = 64;
/** Semantic lease family for the v2 parse-cache format and its temp artifacts. */
const PARSE_CACHE_PERSISTENCE_FAMILY = "parse-cache-v2";

/** Bumped on ParsedNote or source-receipt changes — invalidates incompatible persisted caches. */
const DISK_CACHE_VERSION = 2;
/** Maximum size of the on-disk parse cache file (`~/.cache/enquire/<hash>.json`).
 *  Refuse to read or write a larger file — defensive limit so a corrupted
 *  cache can't balloon. */
export const DEFAULT_MAX_DISK_CACHE_BYTES = 50 * 1024 * 1024;

/**
 * A markdown file discovered by {@link Vault.listMarkdown}. Carries both
 * absolute and vault-relative paths so callers can chose whichever fits
 * their downstream API.
 */
export interface FileEntry {
  /** Absolute filesystem path. */
  absPath: string;
  /** Vault-relative path (forward-slash separated on all platforms). */
  relPath: string;
  /** Basename including the `.md` extension. */
  basename: string;
  /** Modification time, ms since epoch. */
  mtimeMs: number;
  /** Source size captured by the directory walk. Optional for compatibility
   *  with programmatic callers that construct synthetic {@link FileEntry}s. */
  sizeBytes?: number;
  /** Opaque filesystem-generation receipt captured with `mtimeMs`. Production
   *  vault walkers always populate it; callers must compare it as a whole and
   *  must not parse its representation. */
  sourceRevision?: string;
}

/** Current regular-file state returned by {@link Vault.sourceState}.
 *
 * `sourceRevision` binds the physical entry, byte size, and filesystem change
 * timestamps. It is an opaque equality receipt, not a content-authenticity
 * proof; callers that expose bytes across an await should additionally bind
 * those bytes (for example with a digest) and re-check this receipt last.
 */
export interface FileSourceState {
  /** Opaque filesystem-generation receipt; compare only for exact equality. */
  sourceRevision: string;
  /** File size in bytes at the same stat generation. */
  sizeBytes: number;
  /** Modification time in milliseconds at the same stat generation. */
  mtimeMs: number;
}

/** Result of one resource-bounded vault directory walk. */
export interface BoundedFileListing {
  /** Admitted regular files, never more than the requested file limit. */
  entries: FileEntry[];
  /** Number of directory entries inspected before the walk stopped. */
  visitedEntries: number;
  /** True only when the entire requested subtree was inspected without an I/O or budget refusal. */
  complete: boolean;
}

/**
 * Filesystem generation receipt used to reject accidental stale parsed-note
 * cache hits. It binds source metadata, not the authenticity of persisted
 * cache bytes: a same-account actor able to rewrite both cache content and its
 * receipt remains outside this hint-cache trust boundary.
 */
interface CacheSourceReceipt {
  /** Device identifier reported by the filesystem. */
  readonly dev: number;
  /** Inode/file identifier reported by the filesystem (may be zero when unavailable). */
  readonly ino: number;
  /** File size in bytes. */
  readonly size: number;
  /** Modification time in milliseconds. */
  readonly mtimeMs: number;
  /** Metadata-change time in milliseconds. */
  readonly ctimeMs: number;
}

/** A detached parse-cached note returned to callers. */
export interface CachedNote {
  /** Raw file content (UTF-8). */
  content: string;
  /** Parsed structure — see `ParsedNote`. */
  parsed: ParsedNote;
  /** mtime at parse time. Retained for stable callers and display metadata. */
  mtimeMs: number;
}

/** Internal cache authority that never crosses the public read boundary. */
interface CachedNoteRecord extends CachedNote {
  readonly sourceReceipt: CacheSourceReceipt;
}

/**
 * Options accepted by the {@link Vault} constructor. Every field is
 * optional; omit to accept the documented default.
 */
export interface VaultOptions {
  /** Per-file size cap. Default {@link DEFAULT_MAX_FILE_BYTES}. */
  maxFileBytes?: number;
  /** In-memory parsed-note cache size cap. Default {@link DEFAULT_MAX_CACHE_ENTRIES}. */
  maxCacheEntries?: number;
  /** Allow `writeNote` / `appendNote` / `renameFile`. Default false (read-only). */
  enableWrite?: boolean;
  /** Persist the parse cache across server restarts. Default false. */
  persistentCache?: boolean;
  /** Override with an exact `.json` cache-file path outside the reserved
   * `.feedback.json` / `.hnsw.meta.json` subclasses. Default:
   * ~/.cache/enquire/<vault-hash>.json. */
  cacheFile?: string;
  /** Refuse to read/write a cache file larger than this (default 50 MB). */
  maxDiskCacheBytes?: number;
  /** Glob patterns matched against vault-relative paths. Excluded paths never appear in
   *  listMarkdown(), and reads/writes against them throw. Privacy filter for users who
   *  point an LLM at a vault but want `02_Personal/**` invisible. */
  excludeGlobs?: string[];
  /** Glob patterns matched against vault-relative paths. When set, ONLY paths matching
   *  one of these patterns are visible — strict allowlist mode. Complement to
   *  excludeGlobs (cyanheads OBSIDIAN_READ_PATHS pattern). If both are set, a path
   *  must match an allow-glob AND not match any exclude-glob. */
  readPaths?: string[];
}

/**
 * Vault — the central read-and-cache layer over the user's Obsidian
 * directory. Handles path safety (no escapes via `..` or symlinks),
 * intrinsic hidden/reserved path policy plus user privacy filtering
 * (`--read-paths` allowlist + `--exclude-glob` denylist),
 * parsed-note caching (in-memory LRU + optional persistent JSON file),
 * and write gating (opt-in via `--enable-write`).
 *
 * Construct once at server start, then share across all tool calls.
 * Methods are async because filesystem IO; the in-memory cache makes
 * repeated reads of the same note ~free.
 *
 * @param root - Configured vault root.
 * @param opts - Optional visibility, mutation, size, and persistence settings.
 * @throws {TypeError} If `opts.cacheFile` is outside the exact parse-cache namespace.
 * @throws {Error} If supplied visibility patterns are empty after normalization.
 * @example
 * ```ts
 * const vault = new Vault("/home/me/Vault", { enableWrite: false });
 * await vault.ensureExists();
 * const md = await vault.listMarkdown();
 * const note = await vault.readNote(md[0].absPath);
 * ```
 */
export class Vault {
  root: string;
  private readonly configuredRoot: string;
  readonly maxFileBytes: number;
  readonly maxCacheEntries: number;
  readonly writeEnabled: boolean;
  readonly persistentCacheEnabled: boolean;
  readonly maxDiskCacheBytes: number;
  readonly excludeGlobs: readonly string[];
  readonly readPaths: readonly string[];
  private excludeMatchers: Array<{ test(path: string): boolean }>;
  private readPathMatchers: Array<{ test(path: string): boolean }>;
  private cacheFileValue: string | null;
  private cache = new Map<string, CachedNoteRecord>();
  private cacheGeneration = 0;
  private cacheDirty = false;
  private cacheEpoch = 0;
  private cachePublishChain: Promise<void> = Promise.resolve();
  private pendingCacheSaveRequests = 0;
  private pendingCacheClears = new Map<string, DiskCacheClearBarrier>();
  private persistenceLifecycle: "open" | "closing" | "closed" = "open";
  private persistenceClosePromise: Promise<void> | undefined;
  private persistenceTargets = new Map<string, DiskCachePersistenceTarget>();
  private persistenceTargetAcquisitions = new Map<string, Promise<DiskCachePersistenceTarget>>();
  private persistenceReleaseDebt = new Set<PersistenceFamilyLeaseHandle>();
  private pendingPersistenceOperations = new Set<Promise<unknown>>();
  private ready = false;
  private readyPromise: Promise<void> | null = null;
  /** Lazily loaded periodic-notes config (.obsidian/daily-notes.json + Periodic
   *  Notes plugin). Cached forever after first read — users restart the server
   *  if they reconfigure plugins. */
  private periodicConfig: PeriodicConfig | null = null;

  constructor(root: string, opts: VaultOptions = {}) {
    if (typeof root !== "string" || root.trim().length === 0) {
      throw new TypeError("Vault root must be a non-empty path string");
    }
    if (typeof opts !== "object" || opts === null || Array.isArray(opts)) {
      throw new TypeError("Vault options must be an object");
    }
    const allowedOptionNames = new Set([
      "maxFileBytes",
      "maxCacheEntries",
      "enableWrite",
      "persistentCache",
      "cacheFile",
      "maxDiskCacheBytes",
      "excludeGlobs",
      "readPaths"
    ]);
    const unknownOptionName = Object.keys(opts).find((name) => !allowedOptionNames.has(name));
    if (unknownOptionName !== undefined) {
      throw new TypeError(`Unknown Vault option ${unknownOptionName}`);
    }
    for (const [name, value] of [
      ["enableWrite", opts.enableWrite],
      ["persistentCache", opts.persistentCache]
    ] as const) {
      if (value !== undefined && typeof value !== "boolean") {
        throw new TypeError(`Vault option ${name} must be a boolean`);
      }
    }
    for (const [name, value] of [
      ["maxFileBytes", opts.maxFileBytes],
      ["maxCacheEntries", opts.maxCacheEntries],
      ["maxDiskCacheBytes", opts.maxDiskCacheBytes]
    ] as const) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
        throw new TypeError(`Vault option ${name} must be a positive safe integer`);
      }
    }
    for (const [name, value] of [
      ["excludeGlobs", opts.excludeGlobs],
      ["readPaths", opts.readPaths]
    ] as const) {
      if (value !== undefined && (!Array.isArray(value) || !value.every((pattern) => typeof pattern === "string"))) {
        throw new TypeError(`Vault option ${name} must be an array of strings`);
      }
    }
    if (opts.readPaths !== undefined && opts.readPaths.length === 0) {
      throw new TypeError("Vault option readPaths must not be an empty allowlist");
    }
    if (opts.cacheFile !== undefined) assertCacheFilePath(opts.cacheFile);
    this.root = path.resolve(root);
    this.configuredRoot = this.root;
    this.maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.maxCacheEntries = opts.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES;
    this.writeEnabled = opts.enableWrite ?? false;
    this.persistentCacheEnabled = opts.persistentCache ?? false;
    this.maxDiskCacheBytes = opts.maxDiskCacheBytes ?? DEFAULT_MAX_DISK_CACHE_BYTES;
    this.cacheFileValue = opts.cacheFile === undefined ? null : path.resolve(opts.cacheFile);
    // v2.0.0-beta.2 P1 sec DiD: refuse to start if the user passed exclusion
    // flags that, after stripping empty / whitespace-only entries, produced
    // 0 working patterns. Pre-fix, e.g. `--read-paths ""` (empty after shell
    // interpolation of an unset variable) survived as an array of one empty
    // string. compileGlob("") produces a matcher that matches NO real paths —
    // the user's intent was "filter to nothing" but functionally that meant
    // the readPaths predicate matched nothing → every path treated as
    // excluded. The opposite mistake (whitespace-only) silently disabled.
    // Either way: fail closed with a clear error.
    const cleanExcludeGlobs = (opts.excludeGlobs ?? []).filter((g) => g && g.trim().length > 0);
    const cleanReadPaths = (opts.readPaths ?? []).filter((g) => g && g.trim().length > 0);
    if (opts.excludeGlobs !== undefined && opts.excludeGlobs.length > 0 && cleanExcludeGlobs.length === 0) {
      throw new Error(
        "--exclude-glob was passed but contained only empty / whitespace-only patterns; refusing to start to avoid silent privacy disable"
      );
    }
    if (opts.readPaths !== undefined && opts.readPaths.length > 0 && cleanReadPaths.length === 0) {
      throw new Error(
        "--read-paths was passed but contained only empty / whitespace-only patterns; refusing to start to avoid silent privacy disable"
      );
    }
    this.excludeGlobs = Object.freeze([...cleanExcludeGlobs]);
    this.excludeMatchers = this.excludeGlobs.map(compileGlob);
    this.readPaths = Object.freeze([...cleanReadPaths]);
    this.readPathMatchers = this.readPaths.map(compileGlob);
  }

  /** Exact `.json` path of the configured persistent cache, or `null` before default resolution. */
  get cacheFile(): string | null {
    return this.cacheFileValue;
  }

  /** Retarget future cache operations to an exact admitted path.
   * @param file - Exact `.json` main outside reserved feedback/HNSW-meta subclasses, or `null`.
   * @throws {TypeError} If a non-null path is outside the exact parse-cache namespace. */
  set cacheFile(file: string | null) {
    if (file !== null) assertCacheFilePath(file);
    const normalized = file === null ? null : path.resolve(file);
    if (normalized === this.cacheFileValue) return;
    this.cacheFileValue = normalized;
    // `cacheFile` is a historical writable programmatic surface. Retargeting
    // must create a new persistence generation: an older in-flight save may
    // finish at its invocation-bound path, but it must not clear the dirty bit
    // and make the next save to this new path a no-op.
    this.cacheEpoch += 1;
    this.cacheGeneration += 1;
    this.cacheDirty = true;
  }

  private runPersistenceOperation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.persistenceLifecycle !== "open") {
      return Promise.reject(new Error("Vault persistence is closing or closed"));
    }
    let pending: Promise<T>;
    try {
      pending = operation();
    } catch (error) {
      return Promise.reject(error);
    }
    this.pendingPersistenceOperations.add(pending);
    void pending.then(
      () => this.pendingPersistenceOperations.delete(pending),
      () => this.pendingPersistenceOperations.delete(pending)
    );
    return pending;
  }

  private async persistenceTargetFor(requestedFile: string): Promise<DiskCachePersistenceTarget> {
    const retained = this.persistenceTargets.get(requestedFile);
    if (retained) return retained;
    const acquiring = this.persistenceTargetAcquisitions.get(requestedFile);
    if (acquiring) return acquiring;
    if (this.persistenceTargets.size + this.persistenceTargetAcquisitions.size >= MAX_PERSISTENT_CACHE_TARGETS) {
      throw new Error(`Too many persistent-cache targets (limit ${MAX_PERSISTENT_CACHE_TARGETS})`);
    }
    const acquisition = (async (): Promise<DiskCachePersistenceTarget> => {
      const lifetime = await acquirePersistenceFamilyLease({
        targetPath: requestedFile,
        familyKey: PARSE_CACHE_PERSISTENCE_FAMILY,
        role: "shared"
      });
      const canonicalFile = path.join(lifetime.scopes.family.canonicalParent, lifetime.scopes.family.targetName);
      const target = { requestedFile, canonicalFile, lifetime };
      this.persistenceTargets.set(requestedFile, target);
      return target;
    })();
    this.persistenceTargetAcquisitions.set(requestedFile, acquisition);
    try {
      return await acquisition;
    } finally {
      if (this.persistenceTargetAcquisitions.get(requestedFile) === acquisition) {
        this.persistenceTargetAcquisitions.delete(requestedFile);
      }
    }
  }

  private samePersistenceFamily(left: PersistenceFamilyScopes, right: PersistenceFamilyScopes): boolean {
    return (
      left.family.canonicalParent === right.family.canonicalParent &&
      left.family.parentIdentity.dev === right.family.parentIdentity.dev &&
      left.family.parentIdentity.ino === right.family.parentIdentity.ino &&
      left.family.familyKey === right.family.familyKey &&
      left.family.digest === right.family.digest &&
      left.family.directory === right.family.directory
    );
  }

  private async releasePersistenceHandle(handle: PersistenceFamilyLeaseHandle): Promise<void> {
    try {
      await handle.release();
      this.persistenceReleaseDebt.delete(handle);
    } catch (error) {
      this.persistenceReleaseDebt.add(handle);
      throw error;
    }
  }

  private async retirePersistenceFamily(scopes: PersistenceFamilyScopes): Promise<void> {
    const matching = [...this.persistenceTargets.entries()].filter(([, target]) =>
      this.samePersistenceFamily(target.lifetime.scopes, scopes)
    );
    const failures: unknown[] = [];
    for (const [requestedFile, target] of matching) {
      try {
        await this.releasePersistenceHandle(target.lifetime);
        if (this.persistenceTargets.get(requestedFile) === target) this.persistenceTargets.delete(requestedFile);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "Persistent-cache lifetime release was incomplete before erasure");
    }
  }

  private async acquirePersistenceEraser(requestedFile: string): Promise<PersistenceFamilyLeaseHandle> {
    const target = await this.persistenceTargetFor(requestedFile);
    const scopes = target.lifetime.scopes;
    await this.retirePersistenceFamily(scopes);
    return acquirePersistenceFamilyLeaseInScopes(scopes, { role: "eraser" });
  }

  private async releaseAllPersistenceHandles(): Promise<void> {
    const failures: unknown[] = [];
    const releasedHandles = new Set<PersistenceFamilyLeaseHandle>();
    for (const handle of [...this.persistenceReleaseDebt]) {
      try {
        await this.releasePersistenceHandle(handle);
        releasedHandles.add(handle);
      } catch (error) {
        failures.push(error);
      }
    }
    for (const [requestedFile, target] of [...this.persistenceTargets]) {
      if (releasedHandles.has(target.lifetime)) {
        if (this.persistenceTargets.get(requestedFile) === target) this.persistenceTargets.delete(requestedFile);
        continue;
      }
      try {
        await this.releasePersistenceHandle(target.lifetime);
        if (this.persistenceTargets.get(requestedFile) === target) this.persistenceTargets.delete(requestedFile);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "Vault persistence lifetime release was incomplete");
    }
  }

  /**
   * Stop admitting disk-cache work, join all accepted loads, saves, and clears,
   * then release every exact historical cache-target lifetime. A failed marker
   * cleanup remains retryable through a later call; no target is re-resolved.
   *
   * @returns A promise that settles only after all retained persistence markers are gone.
   */
  closePersistence(): Promise<void> {
    if (this.persistenceLifecycle === "closed") return Promise.resolve();
    if (this.persistenceClosePromise !== undefined) return this.persistenceClosePromise;
    this.persistenceLifecycle = "closing";
    const close = async (): Promise<void> => {
      const ready = this.readyPromise;
      if (ready) await ready.catch(() => {});
      await Promise.allSettled([...this.pendingPersistenceOperations]);
      await this.cachePublishChain.catch(() => {});
      await Promise.allSettled([...this.persistenceTargetAcquisitions.values()]);
      await this.releaseAllPersistenceHandles();
      this.persistenceLifecycle = "closed";
    };
    const attempt = close();
    this.persistenceClosePromise = attempt;
    void attempt.then(
      () => undefined,
      () => {
        if (this.persistenceClosePromise === attempt) this.persistenceClosePromise = undefined;
      }
    );
    return attempt;
  }

  /** Return why a path is outside the public vault surface, or `null` when admitted. */
  exclusionReason(relPath: string): VaultExclusionReason | null {
    const norm = relPath.replace(/\\/g, "/");
    const restricted = restrictedVaultPathReason(norm);
    if (restricted) return restricted;
    return this.userExclusionReason(norm);
  }

  /** User-configured filters only. Trusted internal `.obsidian` config reads use this path. */
  private userExclusionReason(relPath: string): Exclude<VaultExclusionReason, "hidden or reserved vault path"> | null {
    if (this.excludeMatchers.length === 0 && this.readPathMatchers.length === 0) return null;
    const norm = relPath.replace(/\\/g, "/");
    if (this.readPathMatchers.length > 0 && !this.readPathMatchers.some((re) => re.test(norm))) {
      return "--read-paths allowlist (path doesn't match any allow-glob)";
    }
    if (this.excludeMatchers.length === 0) return null;
    if (this.excludeMatchers.some((re) => re.test(norm))) {
      return "--exclude-glob denylist";
    }
    return null;
  }

  /** True when a path is hidden/reserved or rejected by a configured privacy filter. */
  isExcluded(relPath: string): boolean {
    return this.exclusionReason(relPath) !== null;
  }

  /**
   * Verify the vault root exists, is a directory, and resolve through any
   * symlinks. Idempotent — safe to call before every operation; the
   * underlying state is cached after the first successful call.
   *
   * Also (when persistent cache is enabled) loads the on-disk parse cache.
   * The first disk target is canonicalized through a two-level persistence
   * lease; its shared lifetime remains held until {@link closePersistence} or
   * an explicit same-family clear retires it.
   *
   * @throws {Error} If the vault root doesn't exist or isn't a directory.
   */
  async ensureExists(): Promise<void> {
    if (this.ready) return;
    if (!this.readyPromise) {
      const initialization = (async (): Promise<void> => {
        let stat: import("node:fs").Stats;
        try {
          stat = await this.statSafe(this.root);
        } catch {
          throw new Error(`Vault not found: ${this.root}`);
        }
        if (!stat.isDirectory()) {
          throw new Error(`Vault path is not a directory: ${this.root}`);
        }
        this.root = await this.realpathSafe(this.root);
        if (this.persistentCacheEnabled && !this.cacheFile) {
          this.cacheFileValue = defaultCacheFile(this.root);
        }
        if (this.persistentCacheEnabled) {
          await this.enqueueDiskCacheLoad({
            requestedFile: this.cacheFile,
            acceptedGeneration: this.cacheGeneration
          });
        }
        this.ready = true;
      })();
      this.readyPromise = initialization;
    }
    const pending = this.readyPromise;
    try {
      await pending;
    } catch (error) {
      if (this.readyPromise === pending) this.readyPromise = null;
      throw error;
    }
    if (this.readyPromise === pending) this.readyPromise = null;
  }

  /**
   * Read the on-disk parse cache (`.cache/enquire/<hash>.json`) into the
   * in-memory LRU. Drops entries whose source file is missing, oversized,
   * or path-traverses outside the vault. Re-runs the realpath check to
   * guard against symlink-based escape attempts in a tampered cache file.
   *
   * v3.7.16 P1-4 — ALSO drops entries that violate the LIVE privacy
   * filter state (`--exclude-glob` / `--read-paths`). Pre-3.7.16, if a
   * user filled the cache with all notes and then added a new exclusion
   * pattern on the next start, the excluded note bodies were silently
   * restored into the in-memory cache (and rewritten on the next save).
   * Privacy-driven drops mark `cacheDirty` so the next `saveDiskCache`
   * persists the pruned snapshot, and emit a stderr disclosure line.
   *
   * Idempotent — entries already in memory aren't duplicated.
   * Reads use only the canonical file captured by the retained family scope;
   * later retargeting of a lexical parent alias cannot redirect the load.
   *
   * @returns Number of entries loaded into memory.
   * @internal called automatically by {@link ensureExists} when persistent
   *           cache is enabled.
   */
  loadDiskCache(): Promise<number> {
    return this.runPersistenceOperation(() =>
      this.enqueueDiskCacheLoad({
        requestedFile: this.cacheFile,
        acceptedGeneration: this.cacheGeneration
      })
    );
  }

  private enqueueDiskCacheLoad(request: DiskCacheLoadRequest): Promise<number> {
    const load = this.cachePublishChain.then(() => this.loadDiskCacheOnce(request));
    this.cachePublishChain = load.then(
      () => undefined,
      () => undefined
    );
    return load;
  }

  private async loadDiskCacheOnce(request: DiskCacheLoadRequest): Promise<number> {
    const { requestedFile, acceptedGeneration } = request;
    if (!requestedFile) return 0;
    const pendingClear = this.pendingCacheClears.get(requestedFile);
    if (pendingClear) {
      await pendingClear.promise;
      if (this.cacheGeneration !== acceptedGeneration || this.cacheFile !== requestedFile) return 0;
    }
    const target = await this.persistenceTargetFor(requestedFile);
    const file = target.canonicalFile;
    try {
      const stat = await this.statSafe(file);
      if (stat.size > this.maxDiskCacheBytes) {
        process.stderr.write(
          `enquire: ignoring cache file (${stat.size} bytes > limit ${this.maxDiskCacheBytes}): ${file}\n`
        );
        return 0;
      }
    } catch {
      return 0;
    }
    let raw: string;
    try {
      raw = await readSensitiveArtifactText(file, this.maxDiskCacheBytes);
    } catch {
      return 0;
    }
    let data: unknown;
    try {
      data = JSON.parse(raw) as unknown;
    } catch {
      return 0;
    }
    if (!isRecord(data)) return 0;
    if (data.version !== DISK_CACHE_VERSION || data.root !== this.root) return 0;
    if (!Array.isArray(data.entries)) return 0;

    const rawEntries = data.entries;
    const candidates = rawEntries.slice(0, MAX_PERSISTED_CACHE_ENTRY_INSPECTIONS);
    const checks: DiskCacheCandidateResult[] = [];
    const inspectCandidate = async (rawEntry: unknown): Promise<DiskCacheCandidateResult> => {
      if (!isBoundedDiskCacheJsonTree(rawEntry)) return { kind: "drop" };
      if (!isRecord(rawEntry)) return { kind: "drop" };
      const entry = rawEntry;
      if (
        typeof entry.relPath !== "string" ||
        typeof entry.mtimeMs !== "number" ||
        !isCacheSourceReceipt(entry.sourceReceipt) ||
        entry.mtimeMs !== entry.sourceReceipt.mtimeMs
      ) {
        return { kind: "drop" };
      }
      if (typeof entry.content !== "string" || !isPersistedParsedNote(entry.parsed)) return { kind: "drop" };
      if (Buffer.byteLength(entry.content, "utf8") > this.maxFileBytes) return { kind: "drop" } as const;
      // Reject relative paths that escape the vault root after resolution.
      // A crafted cache file with relPath like "../../../etc/hosts" would
      // otherwise pollute the in-memory cache with a key pointing outside
      // the vault. The orphaned entry would never be served (resolveSafePath
      // blocks reads), but it would persist back to disk on next save.
      let abs: string;
      try {
        abs = this.resolveInside(entry.relPath);
      } catch {
        return { kind: "drop" } as const;
      }
      const relCheck = path.relative(this.root, abs);
      // v3.7.16 P1-4 — drop entries that violate the current privacy
      // filters (--exclude-glob / --read-paths). Pre-3.7.16, loadDiskCache
      // happily restored full note bodies even after the user added a new
      // exclude/allowlist pattern on this run. Direct reads were blocked
      // by resolveSafePath, but the excluded body remained in the parse
      // cache + got rewritten to disk by the next saveDiskCache call —
      // breaking the at-rest privacy boundary across filter changes.
      // Now we check isExcluded() using the live filter state for every
      // candidate and drop misses. The drop also marks the cache dirty,
      // so the next saveDiskCache writes the pruned snapshot back to disk.
      if (this.isExcluded(relCheck.replace(/\\/g, "/"))) {
        return { kind: "drop", excludedByPrivacy: true } as const;
      }
      try {
        const s = await this.statSafe(abs);
        if (!s.isFile() || !cacheSourceReceiptsEqual(cacheSourceReceipt(s), entry.sourceReceipt)) {
          return { kind: "drop" } as const;
        }
        // Belt-and-braces: realpath check in case the path includes a symlink
        // chain that resolves outside the vault.
        const real = await this.realpathSafe(abs);
        const realRel = path.relative(this.root, real);
        if (realRel.startsWith("..") || path.isAbsolute(realRel)) return { kind: "drop" } as const;
        const canonicalRel = vaultRelative(this.root, real);
        // The lexical fast-path above is insufficient on case-insensitive
        // filesystems and for in-vault symlink aliases: the cache key may say
        // `private/Secret.md` while realpath resolves to excluded
        // `Private/Secret.md`. Re-apply privacy to the physical identity
        // before any note body enters memory.
        if (this.isExcluded(canonicalRel)) {
          return { kind: "drop", excludedByPrivacy: true } as const;
        }
        return {
          kind: "hit",
          abs: real,
          entry: {
            relPath: entry.relPath,
            mtimeMs: entry.mtimeMs,
            sourceReceipt: entry.sourceReceipt,
            content: entry.content,
            parsed: entry.parsed
          },
          needsMigration: entry.relPath !== canonicalRel
        } as const;
      } catch {
        // Source file gone — drop and force a clean rewrite on next save.
        return { kind: "drop" } as const;
      }
    };
    // A bounded batch avoids both a fully sequential startup and one Promise/
    // filesystem probe per attacker-controlled JSON element.
    for (let offset = 0; offset < candidates.length; offset += PERSISTED_CACHE_VALIDATION_CONCURRENCY) {
      const batch = candidates.slice(offset, offset + PERSISTED_CACHE_VALIDATION_CONCURRENCY);
      checks.push(...(await Promise.all(batch.map((entry) => inspectCandidate(entry)))));
      if (this.cacheGeneration !== acceptedGeneration || this.cacheFile !== requestedFile) return 0;
    }
    if (this.cacheGeneration !== acceptedGeneration || this.cacheFile !== requestedFile) return 0;
    let loaded = 0;
    let dropped = rawEntries.length - candidates.length;
    let droppedByPrivacy = 0;
    const migrationNeeded = checks.some((result) => result.kind === "hit" && result.needsMigration);
    for (const result of checks) {
      if (result.kind === "drop") {
        dropped += 1;
        if ("excludedByPrivacy" in result && result.excludedByPrivacy === true) {
          droppedByPrivacy += 1;
        }
        continue;
      }
      // Keep scanning after the in-memory LRU reaches capacity: later entries
      // can still be stale, deleted, or newly excluded and must mark the
      // persisted snapshot dirty even though they will not be loaded.
      if (this.cache.size >= this.maxCacheEntries) continue;
      this.cache.set(result.abs, {
        content: result.entry.content,
        parsed: result.entry.parsed,
        mtimeMs: result.entry.mtimeMs,
        sourceReceipt: result.entry.sourceReceipt
      });
      this.cacheEpoch += 1;
      loaded += 1;
    }
    // If we silently dropped any persisted entries (deleted, oversized,
    // mtime-stale, private) or accepted a legacy identity for migration, mark
    // the cache dirty so the next save rewrites only canonical admitted hits.
    // Closes both deleted-note retention and case-variant privacy rehydration.
    if (dropped > 0 || migrationNeeded) this.markCacheDirty();
    // v3.7.16 P1-4 — when entries were dropped specifically because a new
    // privacy filter excluded them, surface that to stderr so operators
    // see the privacy-boundary correction (e.g., adding --exclude-glob
    // "Personal/**" after running for weeks with no filter). The pruned
    // snapshot will be written to disk by the next saveDiskCache() call
    // via the cacheDirty flag above.
    if (droppedByPrivacy > 0) {
      process.stderr.write(
        `enquire: persistent cache — dropped ${droppedByPrivacy} entries now excluded by vault visibility policy. ` +
          `Cache will be rewritten without them on the next save.\n`
      );
    }
    return loaded;
  }

  /**
   * Once target admission completes, retire the current in-memory generation
   * synchronously and delete the captured on-disk cache family in publication
   * order. An already-known target has no pre-admission suspension; resolving
   * the default target may await filesystem identity first. Reads and saves
   * accepted after rotation belong to the new generation; a save waits for the
   * disk-erasure barrier before it may publish those newer entries. Async reads
   * or loads accepted before the rotation cannot repopulate the new map.
   * Disk inspection/deletion failures reject the returned promise.
   * Resolves the default cache path through normal initialization when
   * persistence is enabled; otherwise it is a no-op when no cache path exists.
   * Before deletion it retires every own shared handle for the physical family
   * and acquires its exclusive eraser role. A conflicting external lifetime
   * rejects before any cache byte is removed.
   *
   * @returns `true` if any stable, legacy-temp, or generated cache artifact was removed.
   */
  clearDiskCache(): Promise<boolean> {
    return this.runPersistenceOperation(() => this.clearDiskCacheOperation());
  }

  private async clearDiskCacheOperation(): Promise<boolean> {
    // Preserve synchronous admission for an already-known target. Calling the
    // async resolver unconditionally would yield even when it immediately
    // returned `this.cacheFile`, allowing a retarget or clean save to overtake
    // the clear before its generation rotation/barrier was registered.
    let file = this.cacheFile;
    if (!file) file = await this.cacheFileForErasure();
    if (!file) return false;
    // Linearize the memory erasure at admission, before any queued publisher
    // can suspend. Async reads/loads carry `cacheGeneration` receipts and
    // therefore cannot rehydrate this retired Map after the rotation.
    this.cache = new Map();
    this.cacheGeneration += 1;
    this.cacheEpoch += 1;
    this.cacheDirty = false;
    const request: DiskCacheClearRequest = { requestedFile: file };
    const clear = this.cachePublishChain.then(() => this.clearDiskCacheCoordinated(request));
    this.pendingCacheClears.set(file, { request, promise: clear });
    this.cachePublishChain = clear.then(
      () => {
        if (this.pendingCacheClears.get(file)?.request === request) this.pendingCacheClears.delete(file);
      },
      () => {
        // Keep the rejected barrier as a fail-closed tombstone. A later load
        // or save of this family must inherit the erasure failure until an
        // explicit retry succeeds and removes every same-family tombstone.
      }
    );
    return clear;
  }

  private async cacheFileForErasure(): Promise<string | null> {
    if (this.cacheFile) return this.cacheFile;
    if (!this.persistentCacheEnabled) return null;
    let identityRoot = this.configuredRoot;
    try {
      const stat = await this.statSafe(identityRoot);
      if (stat.isDirectory()) identityRoot = await this.realpathSafe(identityRoot);
    } catch {
      // Erasure must remain possible after the vault was removed/unmounted.
      // The lexical configured root is the only remaining default identity;
      // callers with a former symlink spelling can pass the exact cache path.
    }
    const file = defaultCacheFile(identityRoot);
    if (this.cacheFileValue !== null) return this.cacheFileValue;
    this.cacheFileValue = file;
    return file;
  }

  private async clearDiskCacheCoordinated(request: DiskCacheClearRequest): Promise<boolean> {
    const eraser = await this.acquirePersistenceEraser(request.requestedFile);
    const file = path.join(eraser.scopes.family.canonicalParent, eraser.scopes.family.targetName);
    let bodyError: unknown;
    let removed = false;
    try {
      await revalidatePersistenceLeaseScope(eraser.scopes.namespace);
      await revalidatePersistenceLeaseScope(eraser.scopes.family);
      removed = await this.clearDiskCacheOnce({ file });
      await revalidatePersistenceLeaseScope(eraser.scopes.family);
      await revalidatePersistenceLeaseScope(eraser.scopes.namespace);
    } catch (error) {
      bodyError = error;
    }
    try {
      await this.releasePersistenceHandle(eraser);
    } catch (releaseError) {
      if (bodyError !== undefined) {
        throw new AggregateError([bodyError, releaseError], "Persistent-cache erasure and lease release both failed");
      }
      throw releaseError;
    }
    if (bodyError !== undefined) throw bodyError;
    return removed;
  }

  private async clearDiskCacheOnce(request: DiskCachePhysicalClearRequest): Promise<boolean> {
    const { file } = request;
    // rc.36 F-2 (P-2 erasure-completeness sibling) — erase BOTH the cache file
    // AND any leftover atomic-write temp. A crash between `saveDiskCache`'s
    // `writeFile(tmp)` and `rename` (or an EXDEV cross-device rename) leaves
    // `${cacheFile}.tmp` holding full note bodies on disk; clearing only the
    // main file would leave raw vault text behind — a right-to-erasure gap,
    // the parse-cache analogue of the rc.34 HNSW `.meta.json` sidecar fix.
    await preflightSensitiveArtifactTemps(file);
    for (const target of [file, `${file}.tmp`]) {
      const entry = await this.lstatIfExistsSafe(target);
      if (entry && !entry.isFile() && !entry.isSymbolicLink()) {
        throw new Error("Refusing to clear an unsafe persistent-cache artifact");
      }
    }
    let removed = false;
    for (const target of [file, `${file}.tmp`]) {
      try {
        await this.unlinkSafe(target);
        removed = true;
      } catch (err) {
        if (!(isErrnoException(err) && err.code === "ENOENT")) throw err;
      }
    }
    removed = (await removeSensitiveArtifactTemps(file)) > 0 || removed;
    return removed;
  }

  /**
   * Flush the in-memory parse cache to disk. Serializes into an unpredictable
   * exclusive same-parent sibling, applies mode `0600` and fsyncs its held
   * descriptor before rename publication. The published leaf is never chmod'd;
   * a missing parent is requested via recursive mode-`0700` mkdir (subject to
   * a more-restrictive umask), while an existing/custom parent is never path-
   * chmod'd. The parent directory is not fsync'd, so
   * this is atomic leaf replacement rather than a power-loss durability claim.
   *
   * No-op when persistent cache wasn't configured or the cache hasn't
   * been modified since the last save (`cacheDirty` flag). Even a clean-cache
   * call joins any already-accepted clear of the same target and inherits its
   * failure rather than reporting an early false success.
   * Rejects after erasing any older on-disk generation when the admitted
   * snapshot exceeds the configured byte cap; an oversized replacement must
   * never leave stale or newly excluded note bodies behind while reporting
   * success.
   * Every publication acquires a serialized publisher from the target's pinned
   * scopes and writes only the canonical file captured by its shared lifetime.
   *
   * @throws {Error} If validation/publication fails, the snapshot exceeds the
   *   configured on-disk byte cap, or eight save requests are already pending.
   */
  saveDiskCache(): Promise<void> {
    return this.runPersistenceOperation(() => this.saveDiskCacheOperation());
  }

  private async saveDiskCacheOperation(): Promise<void> {
    if (!this.persistentCacheEnabled) return;
    // Normalise the public direct-call path before binding a snapshot. Without
    // this join, an unready save can enqueue a worker whose path validation
    // recursively waits for the same initialization while a later clear is
    // queued behind that worker.
    if (!this.ready) await this.ensureExists();
    const file = this.cacheFile;
    if (!file) return;
    const pendingClear = this.pendingCacheClears.get(file);
    if (!this.cacheDirty) {
      if (pendingClear) await pendingClear.promise;
      return;
    }
    if (this.pendingCacheSaveRequests >= MAX_PENDING_DISK_CACHE_SAVES) {
      throw new Error(`Too many pending persistent-cache saves (limit ${MAX_PENDING_DISK_CACHE_SAVES})`);
    }
    const publishedEpoch = this.cacheEpoch;
    const cacheSnapshot: DiskCacheSnapshotEntry[] = Array.from(this.cache, ([abs, source]) => ({ abs, source }));
    this.pendingCacheSaveRequests += 1;
    const write = this.cachePublishChain.then(async () => {
      if (pendingClear) await pendingClear.promise;
      await this.saveDiskCacheOnce({ requestedFile: file, publishedEpoch, cacheSnapshot });
    });
    const trackedWrite = write.finally(() => {
      this.pendingCacheSaveRequests -= 1;
    });
    this.cachePublishChain = trackedWrite.catch(() => {});
    return trackedWrite;
  }

  private async saveDiskCacheOnce(request: DiskCacheSaveRequest): Promise<void> {
    if (!this.persistentCacheEnabled) return;
    const { requestedFile, publishedEpoch, cacheSnapshot } = request;
    // A previous queued save of this exact generation may already have made
    // this invocation redundant. A retarget or cache mutation advances the
    // epoch, so an older request remains bound to its captured path/snapshot
    // and cannot read a newer generation while it waits in the queue.
    if (!this.cacheDirty && this.cacheFile === requestedFile && this.cacheEpoch === publishedEpoch) return;
    const target = await this.persistenceTargetFor(requestedFile);
    const file = target.canonicalFile;
    const writtenAt = new Date().toISOString();
    const prefix =
      `{"version":${DISK_CACHE_VERSION},"root":${JSON.stringify(this.root)},` +
      `"writtenAt":${JSON.stringify(writtenAt)},"entries":[`;
    const suffix = "]}";
    const fragments: string[] = [prefix];
    let serializedBytes = Buffer.byteLength(prefix, "utf8") + Buffer.byteLength(suffix, "utf8");
    let oversized = serializedBytes > this.maxDiskCacheBytes;
    let firstEntry = true;
    for (const { abs, source } of cacheSnapshot) {
      const cached = source;
      const deleteIfStillCurrent = (): void => {
        if (this.cache.get(abs) === source) this.deleteCacheEntry(abs);
      };
      const relPath = vaultRelative(this.root, abs);
      if (this.isExcluded(relPath)) {
        deleteIfStillCurrent();
        continue;
      }
      try {
        const liveAbs = await this.resolveSafePath(abs);
        const liveStat = await this.statSafe(liveAbs);
        if (!liveStat.isFile() || !cacheSourceReceiptsEqual(cacheSourceReceipt(liveStat), cached.sourceReceipt)) {
          deleteIfStillCurrent();
          continue;
        }
      } catch {
        deleteIfStillCurrent();
        continue;
      }
      const entry: DiskCacheEntry = {
        relPath,
        mtimeMs: cached.mtimeMs,
        sourceReceipt: cached.sourceReceipt,
        content: cached.content,
        parsed: cached.parsed
      };
      if (oversized) continue;
      const delimiter = firstEntry ? "" : ",";
      const delimiterBytes = Buffer.byteLength(delimiter, "utf8");
      const measurement = measureBoundedDiskCacheJson(entry, this.maxDiskCacheBytes - serializedBytes - delimiterBytes);
      if (measurement.kind === "invalid") continue;
      if (measurement.kind === "over-budget") {
        oversized = true;
        continue;
      }
      const fragment = JSON.stringify(entry);
      const measuredFragmentBytes = Buffer.byteLength(fragment, "utf8");
      if (measuredFragmentBytes !== measurement.bytes) {
        throw new Error("Persistent cache JSON byte measurement disagreed with serialization");
      }
      const fragmentBytes = delimiterBytes + measuredFragmentBytes;
      if (serializedBytes + fragmentBytes > this.maxDiskCacheBytes) {
        oversized = true;
        continue;
      }
      fragments.push(delimiter, fragment);
      serializedBytes += fragmentBytes;
      firstEntry = false;
    }
    if (oversized) {
      // This worker owns the publication lane. Remove the older generation
      // before rejecting so a privacy-driven drop cannot leave its raw body
      // parked on disk merely because the replacement became too large.
      await this.clearDiskCacheCoordinated({ requestedFile });
      throw new Error(`Persistent cache snapshot exceeds the configured byte cap (> ${this.maxDiskCacheBytes})`);
    }
    fragments.push(suffix);
    const serialized = fragments.join("");
    const publisher = await acquirePersistenceFamilyLeaseInScopes(target.lifetime.scopes, { role: "publisher" });
    let bodyError: unknown;
    try {
      await revalidatePersistenceLeaseScope(publisher.scopes.namespace);
      await revalidatePersistenceLeaseScope(publisher.scopes.family);
      const cacheDir = publisher.scopes.family.canonicalParent;
      // Recursive mkdir applies 0700 (subject only to a more-restrictive umask)
      // to directories this call creates and leaves an existing/custom parent
      // untouched. Never infer ownership from a pre-stat and then path-chmod:
      // another creator can legitimately win between those two operations.
      await this.mkdirSafe(cacheDir, { recursive: true, mode: 0o700 });
      // The shared publisher owns an unpredictable exclusive mode-0600 sibling
      // and promotes it by rename. A final symlink leaf is replaced, never
      // followed; there is no post-publish chmod(final) race.
      await publishSensitiveArtifact(file, serialized, this.maxDiskCacheBytes);
      await revalidatePersistenceLeaseScope(publisher.scopes.family);
      await revalidatePersistenceLeaseScope(publisher.scopes.namespace);
    } catch (error) {
      bodyError = error;
    }
    try {
      await this.releasePersistenceHandle(publisher);
    } catch (releaseError) {
      if (bodyError !== undefined) {
        throw new AggregateError(
          [bodyError, releaseError],
          "Persistent-cache publication and lease release both failed"
        );
      }
      throw releaseError;
    }
    if (bodyError !== undefined) throw bodyError;
    if (this.cacheFile === requestedFile && this.cacheEpoch === publishedEpoch) this.cacheDirty = false;
  }

  /**
   * Resolve a vault-relative or absolute path to an absolute path, after
   * asserting the result stays inside the vault root. This is the
   * lexical guard; `resolveSafePath` additionally walks symlinks.
   *
   * @param p - Path string (relative or absolute).
   * @returns Absolute path.
   * @throws {Error} If the resolved path escapes the vault root.
   */
  resolveInside(p: string): string {
    if (process.platform === "win32") {
      if (/^[a-z]:(?:[^\\/]|$)/iu.test(p)) {
        throw new Error(`Refusing Windows drive-relative vault path: ${JSON.stringify(p)}`);
      }
      if (/^(?:\\\\|\/\/)[?.][\\/]/u.test(p)) {
        throw new Error(`Refusing Windows device-namespace vault path: ${JSON.stringify(p)}`);
      }
    }

    let abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(this.root, p);
    let rel = path.relative(this.root, abs);
    let contained = !rel.startsWith("..") && !path.isAbsolute(rel);
    if (!contained && path.isAbsolute(p) && this.configuredRoot !== this.root) {
      rel = path.relative(this.configuredRoot, abs);
      contained = !rel.startsWith("..") && !path.isAbsolute(rel);
      if (contained) {
        // Map an accepted configured-root alias onto the canonical root. This
        // preserves absolute-path compatibility without letting downstream
        // relPath/error/cache consumers observe an escaping alias identity.
        abs = path.resolve(this.root, rel);
      }
    }
    if (!contained) {
      throw new Error(`Path escapes vault root: ${p}`);
    }
    if (process.platform === "win32") {
      const problem = windowsRelativePathProblem(rel);
      if (problem) {
        throw new Error(`Refusing Windows-unsafe vault path: ${problem}`);
      }
    }
    return abs;
  }

  /**
   * List every markdown file under the vault root (or a subfolder).
   * Skips every hidden or reserved segment recognized by the central vault
   * path policy and refuses to traverse symlinks. Applies the privacy filter
   * (`--exclude-glob` / `--read-paths`) before returning.
   *
   * @param folder - Optional vault-relative subfolder. When set, scan
   *   only under that folder. Returns `[]` if the folder doesn't exist,
   *   is a symlink, or is itself excluded.
   * @returns Complete discovered inventory sorted by vault-relative path.
   * @throws {Error} If the exact inventory exceeds the hard file/traversal
   *   envelope or a subtree cannot be inspected completely.
   */
  async listMarkdown(folder?: string): Promise<FileEntry[]> {
    const listing = await this.listFilesByExtensionsBounded(
      [".md"],
      MAX_EXACT_LIST_FILES,
      MAX_EXACT_LIST_VISITED_ENTRIES,
      folder
    );
    if (!listing.complete) {
      throw new Error(
        `Markdown inventory is incomplete within ${MAX_EXACT_LIST_FILES} files / ` +
          `${MAX_EXACT_LIST_VISITED_ENTRIES} visited entries`
      );
    }
    return listing.entries;
  }

  /** Walk the vault and return a complete, path-sorted inventory ending with
   *  the given extension (e.g. ".canvas", ".pdf"). Honors --exclude-glob +
   *  --read-paths and fails if the exact inventory exceeds the hard envelope. */
  async listFilesByExtension(ext: string, folder?: string): Promise<FileEntry[]> {
    const listing = await this.listFilesByExtensionsBounded(
      [ext],
      MAX_EXACT_LIST_FILES,
      MAX_EXACT_LIST_VISITED_ENTRIES,
      folder
    );
    if (!listing.complete) {
      throw new Error(
        `${ext} inventory is incomplete within ${MAX_EXACT_LIST_FILES} files / ` +
          `${MAX_EXACT_LIST_VISITED_ENTRIES} visited entries`
      );
    }
    return listing.entries;
  }

  /**
   * Walk the vault incrementally for a closed set of file extensions.
   *
   * This is the common bounded primitive used by the exact legacy listing
   * wrappers and by callers with tighter, operation-specific budgets. It stops
   * at the first `maxFiles + 1` admitted
   * match, after `maxVisitedEntries` directory entries, on an unreadable/racy
   * subtree, or when the real-directory depth envelope is exceeded. In each of
   * those cases `complete` is false so an exhaustive caller can fail closed.
   *
   * @param extensions - Non-empty lowercase-or-mixed extensions beginning with
   *   `.`, for example `[".md", ".pdf"]`.
   * @param maxFiles - Maximum admitted files retained in `entries`.
   * @param maxVisitedEntries - Maximum directory entries inspected, including
   *   directories and non-matching files.
   * @param folder - Optional vault-relative subtree.
   * @returns A bounded listing sorted by vault-relative path and an explicit completeness receipt.
   */
  async listFilesByExtensionsBounded(
    extensions: readonly string[],
    maxFiles: number,
    maxVisitedEntries: number,
    folder?: string
  ): Promise<BoundedFileListing> {
    if (!Number.isSafeInteger(maxFiles) || maxFiles < 1) {
      throw new TypeError("maxFiles must be a positive safe integer");
    }
    if (!Number.isSafeInteger(maxVisitedEntries) || maxVisitedEntries < 1) {
      throw new TypeError("maxVisitedEntries must be a positive safe integer");
    }
    if (extensions.length === 0) throw new TypeError("extensions must contain at least one file extension");
    const normalizedExtensions = new Set<string>();
    for (const extension of extensions) {
      if (typeof extension !== "string" || !/^\.[a-z0-9]+$/iu.test(extension)) {
        throw new TypeError("each extension must begin with '.' and contain only letters or digits");
      }
      normalizedExtensions.add(extension.toLowerCase());
    }

    if (!this.ready) await this.ensureExists();
    let start = folder ? this.resolveInside(folder) : this.root;
    if (folder) {
      if (this.isExcluded(vaultRelative(this.root, start))) {
        return { entries: [], visitedEntries: 0, complete: true };
      }
      const lstat = await fs.lstat(start).catch(() => null);
      if (!lstat) return { entries: [], visitedEntries: 0, complete: true };
      if (lstat.isSymbolicLink()) return { entries: [], visitedEntries: 0, complete: true };
      const real = await fs.realpath(start).catch(() => null);
      if (!real) return { entries: [], visitedEntries: 0, complete: false };
      const rel = path.relative(this.root, real);
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        return { entries: [], visitedEntries: 0, complete: false };
      }
      if (this.isExcluded(rel)) return { entries: [], visitedEntries: 0, complete: true };
      start = real;
    }

    const state: BoundedWalkState = { entries: [], visitedEntries: 0, complete: true };
    await walkBoundedExtensions(
      start,
      this.root,
      normalizedExtensions,
      maxFiles,
      maxVisitedEntries,
      (relPath) => this.isExcluded(relPath),
      state
    );
    state.entries.sort((left, right) => (left.relPath === right.relPath ? 0 : left.relPath < right.relPath ? -1 : 1));
    return state;
  }

  /**
   * Admit feedback identities against the same live public-path authority as
   * note and PDF reads. Every input must be a vault-relative path to an
   * existing regular `.md` or `.pdf` file; traversal, absolute paths,
   * symlinks escaping the vault, hidden/reserved paths, and configured privacy
   * exclusions reject the entire batch. Returned paths use the filesystem's
   * canonical vault-relative spelling and forward separators.
   *
   * @param relPaths - Candidate paths copied from current search hits.
   * @returns Deduplicated canonical public identities in input order.
   * @throws {Error} If any candidate is not a current public searchable file.
   */
  async canonicalFeedbackPaths(relPaths: readonly string[]): Promise<string[]> {
    if (!Array.isArray(relPaths) || relPaths.some((relPath) => typeof relPath !== "string")) {
      throw new TypeError("Feedback paths must be an array of strings");
    }
    if (!this.ready) await this.ensureExists();
    const admitted: string[] = [];
    const seen = new Set<string>();
    for (const relPath of relPaths) {
      const components = relPath.split("/");
      if (
        relPath.length === 0 ||
        path.isAbsolute(relPath) ||
        relPath.includes("\\") ||
        /^[a-z]:/iu.test(relPath) ||
        components.some((component: string) => component === "" || component === "." || component === "..")
      ) {
        throw new Error(`Feedback path must be vault-relative: ${JSON.stringify(relPath)}`);
      }
      const real = await this.resolveSafePath(relPath);
      const stat = await this.statSafe(real);
      if (!stat.isFile()) throw new Error(`Feedback path is not a regular file: ${relPath}`);
      const canonicalRel = vaultRelative(this.root, real);
      const extension = path.extname(canonicalRel).toLowerCase();
      if (extension !== ".md" && extension !== ".pdf") {
        throw new Error(`Feedback path must name a Markdown or PDF search result: ${canonicalRel}`);
      }
      if (!seen.has(canonicalRel)) {
        seen.add(canonicalRel);
        admitted.push(canonicalRel);
      }
    }
    return admitted;
  }

  /** Read a non-markdown file (e.g. `.canvas` JSON). Same path-safety + size
   *  cap as readFile/readNote, but returns Buffer so callers can decide on
   *  encoding. */
  /** v3.10.0-rc.45 (abs-path-leak class) — strip the vault root from an fs error so a
   *  CLIENT-facing message never reveals the host's absolute path / home dir, while
   *  PRESERVING `err.code` and the ENOENT-shaped message text some callers regex-match
   *  (e.g. resolveTarget's periodic fallback). Mutates + returns the same error object. */
  private sanitizeFsError(err: unknown): unknown {
    if (err instanceof Error) {
      const roots = [...new Set([this.root, this.configuredRoot])].sort((a, b) => b.length - a.length);
      const strip = (value: string): string =>
        roots.reduce((sanitized, root) => sanitized.split(`${root}${path.sep}`).join("").split(root).join(""), value);
      if (typeof err.message === "string" && roots.some((root) => err.message.includes(root))) {
        err.message = strip(err.message);
      }
      const rec = err as unknown as Record<string, unknown>;
      for (const k of ["path", "dest"] as const) {
        const v = rec[k];
        if (typeof v === "string" && roots.some((root) => v.includes(root))) rec[k] = strip(v);
      }
    }
    return err;
  }

  // v3.10.0-rc.49 (abs-path-leak class — TRUE root closure) — sanitizing wrappers
  // for the leaking fs SINK ops. rc.45 only wrapped readFile/readBinaryFile/stat;
  // the re-audit found the write path (writeNote/renameFile/appendNote — HIGH) and
  // readNote (the read funnel — MED) still leaked the host abs path to MCP clients.
  // Routing every raw fs sink through these centralizes the strip, and the
  // `tests/abs-path-leak-invariant.test.ts` inventory invariant fails CI if a NEW
  // raw `fs.<sink>(` appears in a method that doesn't sanitize — so the next sink
  // physically cannot escape. err.code is preserved, so EEXIST/EXDEV callers still work.
  private async statSafe(p: string): Promise<import("node:fs").Stats> {
    try {
      return await fs.stat(p);
    } catch (err) {
      throw this.sanitizeFsError(err);
    }
  }
  private async lstatIfExistsSafe(p: string): Promise<import("node:fs").Stats | null> {
    try {
      return await fs.lstat(p);
    } catch (err) {
      if (isErrnoException(err) && err.code === "ENOENT") return null;
      throw this.sanitizeFsError(err);
    }
  }
  private async assertMutationLeafNotSymlink(
    p: string,
    operation: "write" | "rename"
  ): Promise<import("node:fs").Stats | null> {
    const leaf = await this.lstatIfExistsSafe(p);
    if (leaf?.isSymbolicLink()) {
      const role = operation === "write" ? "target" : "destination";
      throw new Error(`Refusing to ${operation} — ${role} is a symlink: ${vaultRelative(this.root, p)}`);
    }
    return leaf;
  }
  private async realpathSafe(p: string): Promise<string> {
    try {
      return await fs.realpath(p);
    } catch (err) {
      throw this.sanitizeFsError(err);
    }
  }
  private async readFileSafe(p: string): Promise<Buffer>;
  private async readFileSafe(p: string, enc: BufferEncoding): Promise<string>;
  private async readFileSafe(p: string, enc?: BufferEncoding): Promise<string | Buffer> {
    try {
      return enc ? await fs.readFile(p, enc) : await fs.readFile(p);
    } catch (err) {
      throw this.sanitizeFsError(err);
    }
  }
  private async mkdirSafe(p: string, opts: Parameters<typeof fs.mkdir>[1]): Promise<void> {
    try {
      await fs.mkdir(p, opts);
    } catch (err) {
      throw this.sanitizeFsError(err);
    }
  }
  private async openSafe(
    p: string,
    flags: string | number,
    mode?: number
  ): Promise<import("node:fs/promises").FileHandle> {
    try {
      return mode === undefined ? await fs.open(p, flags) : await fs.open(p, flags, mode);
    } catch (err) {
      throw this.sanitizeFsError(err);
    }
  }
  private async renameSafe(src: string, dest: string): Promise<void> {
    try {
      await fs.rename(src, dest);
    } catch (err) {
      throw this.sanitizeFsError(err);
    }
  }
  private async linkSafe(src: string, dest: string): Promise<void> {
    try {
      await fs.link(src, dest);
    } catch (err) {
      throw this.sanitizeFsError(err);
    }
  }
  private async copyFileSafe(src: string, dest: string, mode?: number): Promise<void> {
    try {
      await fs.copyFile(src, dest, mode);
    } catch (err) {
      throw this.sanitizeFsError(err);
    }
  }
  private async unlinkSafe(p: string): Promise<void> {
    try {
      await fs.unlink(p);
    } catch (err) {
      throw this.sanitizeFsError(err);
    }
  }

  async readBinaryFile(relOrAbs: string): Promise<Buffer> {
    const abs = await this.resolveSafePath(relOrAbs);
    try {
      await this.assertSize(abs);
      return await this.readFileSafe(abs);
    } catch (err) {
      throw this.sanitizeFsError(err);
    }
  }

  /**
   * Read a text file (UTF-8) from the vault. Same path-safety and size
   * cap as {@link readNote}, but doesn't parse — useful for non-markdown
   * text files where the caller wants the raw bytes.
   *
   * @param relOrAbs - Vault-relative or absolute path.
   * @returns File content as UTF-8 string.
   * @throws {Error} If the path escapes the vault, is excluded by privacy
   *   filter, or the file exceeds the size cap.
   */
  async readFile(relOrAbs: string): Promise<string> {
    const abs = await this.resolveSafePath(relOrAbs);
    try {
      await this.assertSize(abs);
      return await this.readFileSafe(abs, "utf8");
    } catch (err) {
      throw this.sanitizeFsError(err); // rc.45 — vault-relative, no host path leak
    }
  }

  /**
   * Read and parse a markdown note. Returns the cached entry when the
   * file's full filesystem receipt hasn't changed; otherwise reads from disk, parses via
   * `parseNote`, and caches the result (LRU-evicting the oldest
   * entry when at capacity).
   *
   * @param relOrAbs - Vault-relative or absolute path to a `.md` file.
   * @param knownMtimeMs - Optional pre-listing mtime hint retained for API
   *   compatibility. Cache admission always checks a fresh full receipt.
   * @returns A detached note snapshot including parsed structure. Mutating the
   *   returned object cannot alter the Vault's internal cache generation.
   * @throws {Error} If the path escapes the vault, is excluded, or
   *   exceeds the size cap.
   */
  async readNote(relOrAbs: string, knownMtimeMs?: number): Promise<CachedNote> {
    return this.readNoteWithCachePolicy(relOrAbs, knownMtimeMs, true);
  }

  /**
   * Read and parse one markdown generation without consulting or mutating the
   * shared parsed-note cache.
   *
   * This is intended for multi-stage callers that must not publish a candidate
   * into separately visible cache state before their own final receipt commits.
   * It performs the same path, size, and before/after source-receipt checks as
   * {@link readNote} and returns the same detached public shape.
   *
   * @param relOrAbs - Vault-relative or absolute path to a `.md` file.
   * @param knownMtimeMs - Optional finite listing hint retained for parity with
   *   {@link readNote}; authority always comes from a fresh full receipt.
   * @returns A detached parsed note that was never inserted into the Vault cache.
   */
  async readNoteUncached(relOrAbs: string, knownMtimeMs?: number): Promise<CachedNote> {
    return this.readNoteWithCachePolicy(relOrAbs, knownMtimeMs, false);
  }

  /** Shared receipt-bound implementation for cached and staging-only reads. */
  private async readNoteWithCachePolicy(
    relOrAbs: string,
    knownMtimeMs: number | undefined,
    useCache: boolean
  ): Promise<CachedNote> {
    if (knownMtimeMs !== undefined && !Number.isFinite(knownMtimeMs)) {
      throw new TypeError("knownMtimeMs must be finite when provided");
    }
    const acceptedGeneration = this.cacheGeneration;
    const abs = await this.resolveSafePath(relOrAbs);
    // v3.10.0-rc.49 (abs-path-leak class — re-audit CODE-1) — readNote is the
    // primary list-then-read funnel (getNoteNeighbors / semanticSearch / etc.
    // loop it over listMarkdown()); rc.45 sanitized readFile/readBinaryFile/stat
    // but MISSED this method, so a TOCTOU delete / EACCES / file→dir between the
    // list and the per-entry read leaked the host absolute path to MCP clients.
    // Wrap the disk ops; sanitizeFsError is a no-op on the (relative) deliberate
    // errors, so only raw fs errors get the root stripped.
    try {
      const beforeStat = await this.statSafe(abs);
      const sourceReceipt = cacheSourceReceipt(beforeStat);
      const cached = useCache ? this.cache.get(abs) : undefined;
      if (useCache && cached && cacheSourceReceiptsEqual(cached.sourceReceipt, sourceReceipt)) {
        // LRU bump: re-insert so this entry is "freshest"
        this.cache.delete(abs);
        this.cache.set(abs, cached);
        return cloneCachedNote(cached);
      }
      if (beforeStat.size > this.maxFileBytes) {
        throw new Error(
          `File too large (${beforeStat.size} bytes > limit ${this.maxFileBytes}): ${vaultRelative(this.root, abs)}`
        );
      }
      const content = await this.readFileSafe(abs, "utf8");
      const afterStat = await this.statSafe(abs);
      if (!afterStat.isFile() || !cacheSourceReceiptsEqual(sourceReceipt, cacheSourceReceipt(afterStat))) {
        throw new Error(`File changed while being read: ${vaultRelative(this.root, abs)}`);
      }
      const parsed = parseNote(content);
      const entry = { content, parsed, mtimeMs: sourceReceipt.mtimeMs, sourceReceipt };
      const detached = cloneCachedNote(entry);
      if (useCache && this.cacheGeneration === acceptedGeneration) this.cacheSet(abs, entry);
      return detached;
    } catch (err) {
      throw this.sanitizeFsError(err);
    }
  }

  /**
   * Create or overwrite a markdown note. Requires `enableWrite: true` at
   * construction. Honors the intrinsic vault visibility policy and configured
   * privacy filters. Refuses to write through symlinks. Auto-creates parent
   * directories.
   *
   * v3.7.13 M2 — `overwrite=false` uses the `wx` open flag for atomic
   * exclusive create (closes stat-then-write TOCTOU race).
   *
   * v3.7.16 P1-6 — privacy filter runs on the canonical-case relative
   * path (resolved via `realpath` against the nearest existing parent)
   * rather than the lexical user input. Closes the case-insensitive-FS
   * bypass on default macOS HFS+/APFS and Windows NTFS where
   * `personal/secret.md` and `Personal/secret.md` resolve to the same
   * physical file but used to bypass `--exclude-glob "Personal/**"`.
   *
   * @param relPath - Vault-relative target path. `.md` suffix is added
   *   if absent. Must not be empty / `.` / `.md`.
   * @param content - File body (UTF-8). Must be under the size cap.
   * @param opts.overwrite - If true, replace an existing file; otherwise
   *   throw when the target exists. Default false.
   * @returns Metadata about the written file.
   * @throws {Error} If the vault is read-only, the destination is
   *   excluded, the target is a symlink, content exceeds the cap, or
   *   the file exists and `overwrite` is false.
   */
  async writeNote(
    relPath: string,
    content: string,
    opts: { overwrite?: boolean } = {}
  ): Promise<{ absPath: string; relPath: string; mtimeMs: number; bytes: number }> {
    return this.writeNoteContent(relPath, content, opts);
  }

  /**
   * Restore the exact bytes of a markdown file during an internal rollback.
   *
   * This uses the same write gate, path/privacy validation, size cap, symlink
   * refusal, and atomic-overwrite path as {@link writeNote}, but deliberately
   * avoids a UTF-8 decode/encode round trip.
   *
   * @param relPath - Vault-relative markdown path to restore.
   * @param content - Exact file bytes captured before the forward mutation.
   * @returns Metadata about the restored file.
   * @throws {Error} Under the same conditions as {@link writeNote}.
   * @internal
   */
  async restoreFileBytesPublic(
    relPath: string,
    content: Buffer
  ): Promise<{ absPath: string; relPath: string; mtimeMs: number; bytes: number }> {
    return this.writeNoteContent(relPath, content, { overwrite: true });
  }

  private async writeNoteContent(
    relPath: string,
    content: string | Buffer,
    opts: { overwrite?: boolean }
  ): Promise<{ absPath: string; relPath: string; mtimeMs: number; bytes: number }> {
    if (!this.writeEnabled) {
      throw new Error("Vault is read-only — start the server with --enable-write to allow note creation");
    }
    if (!this.ready) await this.ensureExists();
    const contentBytes = Buffer.isBuffer(content) ? content.length : Buffer.byteLength(content, "utf8");
    if (contentBytes > this.maxFileBytes) {
      throw new Error(`Refusing to write ${contentBytes} bytes (limit ${this.maxFileBytes})`);
    }
    if (process.platform === "win32") {
      const rawProblem = windowsRelativePathProblem(relPath);
      if (rawProblem) {
        throw new Error(`Refusing Windows-unsafe vault path: ${rawProblem}`);
      }
    }
    // v2.0.0-beta.1 audit fix: reject empty / whitespace-only / dot-only note
    // names before they normalize into bare `.md` (which the walker hides as a
    // dotfile — silent footgun). The schema enforces `min(1)` upstream too.
    const trimmed = relPath.trim();
    if (!trimmed || trimmed === "." || trimmed === ".md") {
      throw new Error(`Refusing to create note with empty or dot-only name: "${relPath}"`);
    }
    const targetRel = trimmed.toLowerCase().endsWith(".md") ? trimmed : `${trimmed}.md`;
    const abs = this.resolveInside(targetRel);
    const lexicalRel = vaultRelative(this.root, abs);
    const lexicalExclusion = this.exclusionReason(lexicalRel);
    if (lexicalExclusion) {
      throw new Error(`Refusing to write — destination is excluded by ${lexicalExclusion}: ${lexicalRel}`);
    }
    await this.assertParentInsideVault(abs);
    // Preserve the explicit leaf-symlink refusal before canonical privacy
    // validation follows the target. Unexpected lstat failures fail closed;
    // only a genuinely absent leaf is allowed to continue.
    await this.assertMutationLeafNotSymlink(abs, "write");
    // v2.0.0-beta.1 P0 fix: enforce --read-paths / --exclude-glob on writes.
    // Pre-fix, `writeNote()` used `resolveInside()` (path-traversal only) and
    // never called `isExcluded()`, so `--read-paths "Public/**"` allowed
    // `obsidian_create_note({ path: "Private/secret.md" })` — a clear violation
    // of the SECURITY.md privacy contract. We now match the predicate from
    // `resolveSafePath()` and surface the same allowlist-vs-denylist reason.
    //
    // v3.7.16 P1-6 — case-insensitive write privacy bypass on macOS / Windows.
    // Pre-3.7.16 the predicate ran on `path.relative(this.root, abs)`, which
    // is the LEXICAL form of the user's input. On default macOS HFS+/APFS
    // (case-insensitive) and Windows NTFS, `personal/secret.md` resolves to
    // the same physical file as `Personal/secret.md`. If the user configured
    // `--exclude-glob "Personal/**"` (case-sensitive glob), the lexical
    // predicate would MISS the lowercase variant, but the actual write would
    // land in the excluded directory. The fix is to canonicalize against the
    // nearest existing parent's realpath, then re-derive the relative form,
    // before running the exclusion check. Linux ext4/btrfs (case-sensitive)
    // is unaffected; the realpath operation is a no-op there.
    const targetRelNorm = await this.canonicalRelForPrivacyCheck(abs);
    const targetExclusion = this.exclusionReason(targetRelNorm);
    if (targetExclusion) {
      throw new Error(`Refusing to write — destination is excluded by ${targetExclusion}: ${targetRelNorm}`);
    }
    await this.mkdirSafe(path.dirname(abs), { recursive: true });
    await this.assertParentInsideVault(abs);
    // Refuse to write through a symlink. fs.writeFile follows the link and would
    // write to wherever it points — possibly outside the vault. assertParentInsideVault
    // only guards parent dirs; the leaf target itself is checked here.
    //
    // v3.7.13 M2 — symlink check is BEFORE the write. For `overwrite=false`
    // we ALSO do an exclusive-create write (`flag: "wx"`) so the stat-then-
    // write race is closed: between an `await fs.stat()` returning ENOENT
    // and a follow-up `fs.writeFile`, another process could create the file
    // and then `overwrite=false` would silently overwrite it. With `wx`,
    // the kernel atomically refuses to open the file if it exists. The
    // legacy stat-based check stays as a no-op (the exclusive `wx` open throws
    // EEXIST on an existing destination, which we translate to the same
    // user-facing "Note already exists" error for back-compat).
    const targetLstat = await this.assertMutationLeafNotSymlink(abs, "write");
    await this.assertMutationPathPublic(abs, "write", "destination");
    if (opts.overwrite) {
      // v3.11.0-rc.12 (rc.11-audit L-7) — atomic overwrite: write a sibling tmp then
      // rename(2) over the target, so a crash/SIGKILL mid-write can never truncate the
      // note (never a half-written file). The tmp sits in the same already-validated
      // parent dir so the rename is same-filesystem + atomic. A plain writeFile keeps
      // the existing inode's perms; tmp+rename makes a NEW inode, so copy the dest's
      // mode forward on overwrite (default perms for a brand-new path).
      //
      // v3.11.0-rc.13 (rc.12-audit AUD-01, symlink-escape) — the tmp leaf MUST be a
      // RANDOM, unpredictable name opened EXCLUSIVE-create (`wx` → O_CREAT|O_EXCL). The
      // rc.12 fix used a deterministic `${abs}.tmp` written with plain writeFile, which
      // FOLLOWS a symlink at that path (writeNote only lstat-checks the final target
      // `abs`, never the tmp leaf). An attacker who can drop `victim.md.tmp` as a symlink
      // to an out-of-vault file would redirect the write outside the vault AND leave the
      // note as a symlink. O_EXCL refuses to open an existing path (incl. a symlink), and
      // the random suffix means the path can't be pre-planted; together they close it.
      // (The random name also fixes the rc.12 stale-`.tmp` footgun — a leftover tmp from a
      // crashed write no longer blocks future overwrites under a fixed `wx` name.)
      const tmpMode = targetLstat ? targetLstat.mode & 0o777 : 0o666;
      const tmp = `${abs}.${randomBytes(8).toString("hex")}.tmp`;
      let fh: import("node:fs/promises").FileHandle | undefined;
      try {
        fh = await this.openSafe(tmp, "wx", tmpMode); // O_EXCL — never follows a pre-planted symlink
        await this.assertMutationPathPublic(tmp, "write", "temporary destination");
        if (Buffer.isBuffer(content)) await fh.writeFile(content);
        else await fh.writeFile(content, "utf8");
        await fh.close();
        fh = undefined;
        await this.assertMutationLeafNotSymlink(abs, "write");
        await this.assertMutationPathPublic(tmp, "write", "temporary source");
        await this.assertMutationPathPublic(abs, "write", "destination");
        await this.renameSafe(tmp, abs);
      } catch (err) {
        if (fh) await fh.close().catch(() => {});
        await this.unlinkSafe(tmp).catch(() => {});
        throw err;
      }
    } else {
      let fh: import("node:fs/promises").FileHandle | undefined;
      try {
        fh = await this.openSafe(abs, "wx");
        await this.assertMutationPathPublic(abs, "write", "destination");
        if (Buffer.isBuffer(content)) await fh.writeFile(content);
        else await fh.writeFile(content, "utf8");
      } catch (err) {
        if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "EEXIST") {
          throw new Error(`Note already exists: ${targetRel} (pass overwrite=true to replace)`);
        }
        throw err;
      } finally {
        await fh?.close().catch(() => {});
      }
    }
    this.deleteCacheEntry(abs);
    const stat = await this.statSafe(abs);
    return {
      absPath: abs,
      relPath: vaultRelative(this.root, abs),
      mtimeMs: stat.mtimeMs,
      bytes: stat.size
    };
  }

  private async assertParentInsideVault(abs: string): Promise<void> {
    let current = path.dirname(abs);
    while (current !== this.root && current !== path.dirname(current)) {
      try {
        const real = await this.realpathSafe(current);
        const rel = path.relative(this.root, real);
        if (rel.startsWith("..") || path.isAbsolute(rel)) {
          // rc.36 F-3 (P-3 / ν-class sibling) — echo the path RELATIVE to the
          // vault root, never the absolute server path. `current` is a
          // server-computed absolute dir; leaking it to an MCP client over
          // serve-http discloses the host filesystem layout. Mirrors the
          // sibling symlink throw above (`path.relative(this.root, abs)`).
          throw new Error(
            `Refusing to write — parent directory resolves outside vault: ${vaultRelative(this.root, current)}`
          );
        }
        break;
      } catch (err) {
        if (!isErrnoException(err) || (err.code !== "ENOENT" && err.code !== "ENOTDIR")) {
          throw err;
        }
      }
      current = path.dirname(current);
    }
  }

  private async assertMutationPathPublic(
    abs: string,
    operation: "write" | "rename" | "append",
    role: string
  ): Promise<string> {
    const rel = await this.canonicalRelForPrivacyCheck(abs);
    const reason = this.exclusionReason(rel);
    if (reason) {
      throw new Error(`Refusing to ${operation} — ${role} is excluded by ${reason}: ${rel}`);
    }
    return rel;
  }

  /**
   * v3.7.16 P1-6 — return the relative path used for privacy-filter
   * matching, canonicalized against the filesystem's actual case
   * convention. On case-insensitive filesystems (default macOS HFS+/APFS,
   * default Windows NTFS), `personal/Note.md` and `Personal/Note.md`
   * resolve to the same physical file. Pre-3.7.16 the privacy check ran
   * on the LEXICAL relative path (whatever the caller typed), so a
   * case-variant of an excluded folder bypassed `--exclude-glob` /
   * `--read-paths`.
   *
   * Strategy: walk UP from the target until we hit an existing parent,
   * resolve its real (on-disk) path via `fs.realpath`, then re-join the
   * not-yet-existing tail segments AS-TYPED. This yields a path whose
   * EXISTING prefix uses the filesystem's canonical case and whose TAIL
   * uses the caller's case (which is fine — the tail doesn't exist yet,
   * so it has no canonical case). Linux ext4/btrfs (case-sensitive)
   * filesystems treat realpath as a no-op, so this is portable.
   *
   * Any unexpected stat/realpath failure or physical escape fails closed.
   */
  /**
   * Public alias for `canonicalRelForPrivacyCheck`. v3.7.16 P1-6 —
   * used by `renameNote` wrapper in `src/tools/write.ts` to fail-fast on
   * case-insensitive-FS variants before doing O(N) backlink-rewrite work.
   * The inner `renameFile` also does this check; this public surface lets
   * orchestrators pre-check without duplicating the realpath logic.
   */
  async canonicalRelForPrivacyCheckPublic(abs: string): Promise<string> {
    return this.canonicalRelForPrivacyCheck(this.resolveInside(abs));
  }

  /**
   * Refuse a rename destination leaf symlink before canonical privacy
   * resolution follows it, then return the canonical relative identity used
   * by the privacy filter.
   *
   * @param abs - Destination path under the configured or canonical vault root.
   * @returns Canonical vault-relative destination identity.
   * @example
   * ```ts
   * await vault.canonicalRenameDestinationRelPublic(vault.resolveInside("Archive/Note.md"));
   * ```
   * @internal
   */
  async canonicalRenameDestinationRelPublic(abs: string): Promise<string> {
    const resolved = this.resolveInside(abs);
    await this.assertMutationLeafNotSymlink(resolved, "rename");
    return this.canonicalRelForPrivacyCheck(resolved);
  }

  /**
   * Classify a rename destination by canonical directory-entry identity.
   *
   * Exact canonical realpath equality identifies one directory entry reached
   * through different case spellings; matching `dev` + `ino` confirms that
   * both spellings still address the same physical file. Equal `dev` + `ino`
   * with different realpaths is instead a distinct hardlink entry. An
   * unprovable identity fails closed rather than granting overwrite authority.
   * Source and destination both pass the same lexical and canonical privacy
   * admission used by the read/write funnels before any classification is
   * returned to the orchestrator.
   *
   * @param fromAbs - Existing source path inside the vault.
   * @param toAbs - Requested destination path inside the vault.
   * @returns The destination classification and its canonical relative path.
   * @example
   * ```ts
   * const state = await vault.classifyRenameDestinationPublic(
   *   vault.resolveInside("Foo.md"),
   *   vault.resolveInside("foo.md")
   * );
   * ```
   * @internal
   */
  async classifyRenameDestinationPublic(fromAbs: string, toAbs: string): Promise<RenameDestinationClassification> {
    const resolvedFrom = await this.resolveSafePath(fromAbs);
    const resolvedTo = this.resolveInside(toAbs);
    const lexicalRel = vaultRelative(this.root, resolvedTo);
    const lexicalExclusion = this.exclusionReason(lexicalRel);
    if (lexicalExclusion) {
      throw new Error(`Path is excluded by ${lexicalExclusion}: ${lexicalRel}`);
    }
    const canonicalRel = await this.canonicalRenameDestinationRelPublic(resolvedTo);
    const physicalExclusion = this.exclusionReason(canonicalRel);
    if (physicalExclusion) {
      throw new Error(`Path is excluded by ${physicalExclusion}: ${canonicalRel}`);
    }
    return this.classifyRenameDestination(resolvedFrom, resolvedTo, canonicalRel);
  }

  private async canonicalRelForPrivacyCheck(abs: string): Promise<string> {
    let existing = abs;
    const tail: string[] = [];
    // Walk UP until we find an existing path (or hit vault root).
    while (true) {
      try {
        await this.statSafe(existing);
        break;
      } catch (err) {
        if (!isErrnoException(err) || (err.code !== "ENOENT" && err.code !== "ENOTDIR")) {
          throw err;
        }
        const parent = path.dirname(existing);
        if (parent === existing) {
          throw new Error("Refusing path whose existing parent cannot be resolved inside the vault");
        }
        tail.unshift(path.basename(existing));
        existing = parent;
        const canonicalRel = path.relative(this.root, existing);
        const configuredRel = path.relative(this.configuredRoot, existing);
        const insideCanonical = !canonicalRel.startsWith("..") && !path.isAbsolute(canonicalRel);
        const insideConfigured = !configuredRel.startsWith("..") && !path.isAbsolute(configuredRel);
        if (!insideCanonical && !insideConfigured) {
          throw new Error("Refusing path whose existing parent escapes the vault");
        }
      }
    }
    // Resolve realpath on the existing prefix → canonical case from disk.
    const realExisting = await this.realpathSafe(existing);
    // Re-join the not-yet-existing tail (caller's case is fine for non-
    // existent segments).
    const canonicalAbs = tail.length === 0 ? realExisting : path.join(realExisting, ...tail);
    const rel = vaultRelative(this.root, canonicalAbs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error("Refusing path whose canonical form escapes the vault");
    }
    return rel;
  }

  private async classifyRenameDestination(
    fromAbs: string,
    toAbs: string,
    canonicalRel: string
  ): Promise<RenameDestinationClassification> {
    // canonicalRenameDestinationRelPublic performs the first non-following
    // leaf probe before realpath. Repeat it after canonicalization so an entry
    // that appeared or became a symlink during that await cannot be trusted.
    const destinationLeaf = await this.assertMutationLeafNotSymlink(toAbs, "rename");
    if (!destinationLeaf) return { kind: "missing", canonicalRel };
    if (!destinationLeaf.isFile()) {
      return { kind: "unproven", canonicalRel, reason: "destination is not a regular file" };
    }

    let fromReal: string;
    let toReal: string;
    let fromStat: import("node:fs").Stats;
    let toStat: import("node:fs").Stats;
    try {
      [fromReal, toReal] = await Promise.all([this.realpathSafe(fromAbs), this.realpathSafe(toAbs)]);
      [fromStat, toStat] = await Promise.all([this.statSafe(fromReal), this.statSafe(toReal)]);
    } catch (err) {
      if (isErrnoException(err) && (err.code === "ENOENT" || err.code === "ENOTDIR")) {
        return { kind: "unproven", canonicalRel, reason: "source or destination changed during classification" };
      }
      throw err;
    }

    if (!fromStat.isFile() || !toStat.isFile()) {
      return { kind: "unproven", canonicalRel, reason: "source or destination is not a regular file" };
    }
    const fromRealRel = vaultRelative(this.root, fromReal);
    const toRealRel = vaultRelative(this.root, toReal);
    if (
      fromRealRel.startsWith("..") ||
      path.isAbsolute(fromRealRel) ||
      toRealRel.startsWith("..") ||
      path.isAbsolute(toRealRel)
    ) {
      return { kind: "unproven", canonicalRel, reason: "canonical identity escapes the vault" };
    }
    if (canonicalRel !== toRealRel) {
      return { kind: "unproven", canonicalRel, reason: "canonical destination changed during classification" };
    }
    if (fromStat.ino === 0 || toStat.ino === 0) {
      return { kind: "unproven", canonicalRel, reason: "inode identity is unavailable" };
    }

    const sameCanonicalEntry = fromReal === toReal;
    const samePhysicalFile = fromStat.dev === toStat.dev && fromStat.ino === toStat.ino;
    if (sameCanonicalEntry && !samePhysicalFile) {
      return { kind: "unproven", canonicalRel, reason: "canonical entry and physical identity disagree" };
    }
    const requestedCaseAlias = fromAbs !== toAbs && fromAbs.toLowerCase() === toAbs.toLowerCase();
    if (sameCanonicalEntry) {
      return requestedCaseAlias
        ? { kind: "same-canonical-case-alias", canonicalRel }
        : {
            kind: "unproven",
            canonicalRel,
            reason: "same canonical entry is not a supported case-only spelling"
          };
    }

    const receipt = renameEntryReceipt(this.root, toReal, toStat);
    return samePhysicalFile
      ? { kind: "distinct-hardlink", canonicalRel, receipt }
      : { kind: "distinct", canonicalRel, receipt };
  }

  /**
   * Rename a markdown file inside the vault.
   *
   * A move to a classified-missing destination uses `link` + `unlink`, with
   * an exclusive-copy cross-device fallback, regardless of `overwrite`. Thus
   * an unsnapshotted destination appearing in the final check/use gap cannot
   * be replaced. Plain rename is reserved for a supported case-only spelling
   * of the same canonical directory entry, confirmed by exact realpath plus
   * `dev` + `ino`, or a classified-distinct destination with `overwrite`.
   * A distinct hardlink destination fails closed even with `overwrite`;
   * byte rollback cannot restore link topology.
   *
   * For non-identical path requests, the optional planning receipt is
   * reclassified after the final mutation path guards and immediately before
   * the filesystem syscall. It narrows but cannot eliminate an out-of-process
   * check/use or ABA race. Exact-same-path direct calls retain their legacy
   * overwrite/no-op behavior; `renameNote` rejects that request.
   *
   * @param fromRel - Existing vault-relative source path.
   * @param toRel - Requested vault-relative destination path.
   * @param opts - Overwrite choice and optional orchestrator planning receipt.
   * @returns Vault-relative source/destination paths and destination mtime.
   * @throws {Error} If a path is excluded or unsafe, a distinct destination
   *   exists without overwrite, destination identity is unproven or changed,
   *   or the destination is a distinct hardlink entry.
   * @example
   * ```ts
   * await vault.renameFile("Inbox/Draft.md", "Archive/Draft.md");
   * ```
   */
  async renameFile(
    fromRel: string,
    toRel: string,
    opts: RenameFileOptions = {}
  ): Promise<{ from: string; to: string; mtimeMs: number }> {
    if (!this.writeEnabled) {
      throw new Error("Vault is read-only — start the server with --enable-write to allow rename");
    }
    if (!this.ready) await this.ensureExists();
    const toRelNorm = toRel.toLowerCase().endsWith(".md") ? toRel : `${toRel}.md`;
    const toAbs = this.resolveInside(toRelNorm);
    const lexicalToRel = vaultRelative(this.root, toAbs);
    let fromAbs: string;
    let exactSamePath = false;
    let currentDestination: RenameDestinationClassification | null = null;
    try {
      fromAbs = await this.resolveSafePath(fromRel);
      const lexicalDestinationExclusion = this.exclusionReason(lexicalToRel);
      if (lexicalDestinationExclusion) {
        throw new Error(
          `Refusing to rename — destination is excluded by ${lexicalDestinationExclusion}: ${lexicalToRel}`
        );
      }
      await this.assertParentInsideVault(toAbs);
      // v2.0.0-beta.2 P1 fix: distinguish allowlist-vs-denylist same as
      // writeNote does, so users with --read-paths see the actual reason.
      // v3.7.16 P1-6 — case-insensitive bypass closure (same as writeNote).
      const toRelForFilter = await this.canonicalRenameDestinationRelPublic(toAbs);
      const destinationExclusion = this.exclusionReason(toRelForFilter);
      if (destinationExclusion) {
        throw new Error(`Refusing to rename — destination is excluded by ${destinationExclusion}: ${toRelNorm}`);
      }
      await this.mkdirSafe(path.dirname(toAbs), { recursive: true });
      await this.assertParentInsideVault(toAbs);
      // Recheck beside the mutation after awaits in validation/mkdir. This
      // narrows the stable-pre-state validation window; the non-following/atomic
      // rename/link operations remain authoritative if the leaf changes later.
      await this.assertMutationLeafNotSymlink(toAbs, "rename");
      await this.assertMutationPathPublic(fromAbs, "rename", "source");
      await this.assertMutationPathPublic(toAbs, "rename", "destination");
      exactSamePath = fromAbs === toAbs;
      currentDestination = exactSamePath ? null : await this.classifyRenameDestination(fromAbs, toAbs, toRelForFilter);
      if (
        currentDestination &&
        opts.expectedDestination &&
        !renameDestinationMatches(opts.expectedDestination, currentDestination)
      ) {
        throw new RenameDestinationChangedError(toRelNorm);
      }
      if (currentDestination?.kind === "distinct-hardlink") {
        throw new Error(`Refusing to rename — destination is a distinct hardlink entry: ${toRelNorm}`);
      }
      if (currentDestination?.kind === "unproven") {
        throw new Error(
          `Refusing to rename — destination identity is unproven (${currentDestination.reason}): ${toRelNorm}`
        );
      }
    } catch (err) {
      if (opts.expectedDestination && !(err instanceof RenameDestinationChangedError)) {
        throw new RenamePrecommitError(toRelNorm, err);
      }
      throw err;
    }
    const destinationWasPlannedMissing = opts.expectedDestination?.kind === "missing";
    // v3.7.14 F2 — exclusive-destination move (parity with v3.7.13 M2).
    // Pre-3.7.14 we did `stat(toAbs)`-then-`rename(fromAbs, toAbs)`. POSIX
    // rename(2) silently REPLACES the destination if it exists, so between
    // a stat() returning ENOENT and the follow-up rename(), another process
    // could create the destination and our rename would clobber it without
    // honoring overwrite=false. Closes the same class of TOCTOU race that
    // M2 fixed for writeNote.
    //
    // The fix uses link()+unlink() whenever the classified destination is
    // missing. link(2) fails atomically with EEXIST when the destination
    // exists — no stat-then-act replacement window. After successful link the source path is removed, leaving the
    // file at the new path with identical contents. A destination classified
    // as missing stays on this exclusive path even with overwrite=true: no
    // rollback snapshot exists for an entry that appears after classification.
    // Plain rename is reserved for confirmed case aliases and for a distinct
    // destination that already existed when overwrite authority was planned.
    let needsExclusiveMove = false;
    if (exactSamePath) {
      if (!opts.overwrite) {
        throw new Error(`Destination already exists: ${toRelNorm} (pass overwrite=true to replace)`);
      }
      await this.renameSafe(fromAbs, toAbs);
    } else if (currentDestination?.kind === "same-canonical-case-alias") {
      await this.renameSafe(fromAbs, toAbs);
    } else if (currentDestination?.kind === "distinct") {
      if (!opts.overwrite) {
        throw new Error(`Destination already exists: ${toRelNorm} (pass overwrite=true to replace)`);
      }
      await this.renameSafe(fromAbs, toAbs);
    } else {
      needsExclusiveMove = true;
    }
    if (needsExclusiveMove) {
      try {
        await this.linkSafe(fromAbs, toAbs);
      } catch (err) {
        if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "EEXIST") {
          if (destinationWasPlannedMissing) throw new RenameDestinationChangedError(toRelNorm);
          if (opts.overwrite) {
            throw new Error(`Destination appeared during rename: ${toRelNorm} (retry to replace)`);
          }
          throw new Error(`Destination already exists: ${toRelNorm} (pass overwrite=true to replace)`);
        }
        // EXDEV (cross-device link) is the realistic fallback: vault on a
        // bind-mount, source on the underlying fs. Fall back to an exclusive
        // copy followed by unlink; this preserves destination admission but
        // does not claim the two-step move itself is atomic.
        if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "EXDEV") {
          try {
            await this.copyFileSafe(fromAbs, toAbs, fsConstants.COPYFILE_EXCL);
          } catch (copyErr) {
            if (copyErr instanceof Error && "code" in copyErr && (copyErr as NodeJS.ErrnoException).code === "EEXIST") {
              if (destinationWasPlannedMissing) throw new RenameDestinationChangedError(toRelNorm);
              if (opts.overwrite) {
                throw new Error(`Destination appeared during rename: ${toRelNorm} (retry to replace)`);
              }
              throw new Error(`Destination already exists: ${toRelNorm} (pass overwrite=true to replace)`);
            }
            throw copyErr;
          }
          await this.unlinkSafe(fromAbs);
        } else {
          throw err;
        }
      }
      // link() succeeded — source still exists at fromAbs as a hard link.
      // Unlink it to complete the move semantic. If unlink fails the user
      // sees a still-present fromAbs alongside the new toAbs (hard-linked,
      // same inode on POSIX); re-running renameFile will see toAbs exists
      // and reject — but the duplicate is a recoverable state, not data
      // loss, which is the v3.7.13 M1 recovery posture.
      await fs.unlink(fromAbs).catch(() => {
        // Best-effort cleanup; toAbs is the canonical truth.
      });
    }
    this.deleteCacheEntry(fromAbs);
    this.deleteCacheEntry(toAbs);
    const stat = await this.statSafe(toAbs);
    return {
      from: vaultRelative(this.root, fromAbs),
      to: vaultRelative(this.root, toAbs),
      mtimeMs: stat.mtimeMs
    };
  }

  /**
   * Append text to an existing note. Requires `enableWrite: true`.
   * Refuses if the resulting file would exceed the size cap.
   *
   * v3.11.7-rc.2 — opens without `O_CREAT`, so append can never turn a
   * missing path into a new file, and serializes the descriptor
   * size-check + write by physical file identity across all `Vault`
   * instances in this process. `O_APPEND` makes placement atomic; the
   * dev+ino queue also coordinates distinct hardlink paths for one file.
   * Writers in other processes remain outside the `Vault` API contract.
   *
   * @param relOrAbs - Vault-relative or absolute target path.
   * @param addition - Text to append (UTF-8). Caller is responsible for
   *   including any leading newline.
   * @returns Metadata about the file after the append.
   * @throws {Error} If the vault is read-only, the target does not exist
   *   as a regular in-vault file, is privacy-excluded, changes identity
   *   during validation, or the append would exceed `maxFileBytes`.
   */
  async appendNote(
    relOrAbs: string,
    addition: string
  ): Promise<{ absPath: string; relPath: string; mtimeMs: number; appended_bytes: number }> {
    if (!this.writeEnabled) {
      throw new Error("Vault is read-only — start the server with --enable-write to allow note appends");
    }
    const initialAbs = await this.resolveSafePath(relOrAbs);
    await this.assertParentInsideVault(initialAbs);
    // Type-only preflight preserves the normal deliberate error for special
    // files. It is never used as identity evidence: a swap can happen after
    // lstat, so every security decision below is re-derived from a descriptor.
    const initialType = await this.lstatIfExistsSafe(initialAbs);
    if (initialType && !initialType.isFile()) {
      throw new Error(`Refusing to append — target is not a regular file: ${vaultRelative(this.root, initialAbs)}`);
    }
    // Deliberately omit O_CREAT: append is an existing-note operation.
    // The pre-fix string flag "a" included O_CREAT, so resolveSafePath's
    // ENOENT fallback plus an out-of-vault parent symlink created and wrote
    // an arbitrary missing leaf outside the vault.
    // O_NONBLOCK prevents a special-file replacement from hanging the server;
    // it does not change ordinary regular-file append semantics.
    const posixSafeOpen = process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;
    const appendFlags = fsConstants.O_WRONLY | fsConstants.O_APPEND | posixSafeOpen;
    const identityHandle = await this.openSafe(initialAbs, appendFlags);
    let initialStat: import("node:fs").Stats;
    try {
      initialStat = await identityHandle.stat();
    } finally {
      await identityHandle.close();
    }
    if (!initialStat.isFile()) {
      throw new Error(`Refusing to append — target is not a regular file: ${vaultRelative(this.root, initialAbs)}`);
    }
    const lockKey = appendIdentityKey(initialStat);
    return withAppendIdentityLock(lockKey, async () => {
      // Re-resolve after waiting: a rename/symlink swap while queued must not
      // silently redirect the append to a different inode or escape the lock.
      const abs = await this.resolveSafePath(relOrAbs);
      if (abs !== initialAbs) {
        throw new Error(`Refusing to append — target changed while waiting: ${vaultRelative(this.root, initialAbs)}`);
      }
      await this.assertParentInsideVault(abs);
      const relForFilter = await this.canonicalRelForPrivacyCheck(abs);
      const targetExclusion = this.exclusionReason(relForFilter);
      if (targetExclusion) {
        throw new Error(`Refusing to append — target is excluded by ${targetExclusion}: ${relForFilter}`);
      }

      const handle = await this.openSafe(abs, appendFlags);
      const additionBytes = Buffer.byteLength(addition, "utf8");
      let after: import("node:fs").Stats;
      try {
        const before = await handle.stat();
        if (!before.isFile()) {
          throw new Error(`Refusing to append — target is not a regular file: ${vaultRelative(this.root, abs)}`);
        }
        if (appendIdentityKey(before) !== lockKey) {
          throw new Error(`Refusing to append — target changed while waiting: ${relForFilter}`);
        }

        // Verify the descriptor still names the in-vault path we validated.
        // Identity is derived only from FileHandle.stat(): path stat and
        // descriptor stat travel through different Win32/libuv surfaces and
        // cannot be assumed to expose an interchangeable dev+ino token.
        const realAfterOpen = await this.realpathSafe(abs);
        const relAfterOpen = path.relative(this.root, realAfterOpen);
        if (relAfterOpen.startsWith("..") || path.isAbsolute(relAfterOpen)) {
          throw new Error(`Resolved path escapes vault root: ${relOrAbs}`);
        }
        await this.assertMutationPathPublic(realAfterOpen, "append", "physical target");
        const validationHandle = await this.openSafe(realAfterOpen, appendFlags);
        try {
          const pathIdentity = await validationHandle.stat();
          if (appendIdentityKey(pathIdentity) !== appendIdentityKey(before)) {
            throw new Error(`Refusing to append — target changed during validation: ${relForFilter}`);
          }
        } finally {
          await validationHandle.close();
        }
        if (before.size + additionBytes > this.maxFileBytes) {
          throw new Error(`Refusing to grow ${vaultRelative(this.root, abs)} past ${this.maxFileBytes} bytes`);
        }
        await handle.writeFile(addition, "utf8");
        after = await handle.stat();
      } finally {
        await handle.close();
      }
      this.deleteCacheEntry(abs);
      return {
        absPath: abs,
        relPath: vaultRelative(this.root, abs),
        mtimeMs: after.mtimeMs,
        appended_bytes: additionBytes
      };
    });
  }

  /** Drop every entry from the in-memory parse cache. Used after bulk
   *  changes (e.g. a full vault rebuild). Does NOT delete the on-disk
   *  cache file — call {@link clearDiskCache} for that. */
  invalidateCache(): void {
    if (this.cache.size === 0) return;
    this.cache.clear();
    this.markCacheDirty();
  }

  /** Drop a single cached note by absolute path. Used by the watcher when one
   *  file changes — full-cache clear would be wasteful for a 5k-note vault. */
  invalidateOne(absPath: string): void {
    this.deleteCacheEntry(absPath);
  }

  /**
   * Stat a vault file. Same path-safety as the read methods but no
   * size-cap check (callers may want to inspect oversized files'
   * metadata).
   *
   * @param relOrAbs - Vault-relative or absolute path.
   * @returns Modification time, byte size, and whether the target is a regular file.
   */
  async stat(relOrAbs: string): Promise<{ mtimeMs: number; size: number; isFile: boolean }> {
    const abs = await this.resolveSafePath(relOrAbs);
    try {
      const s = await this.statSafe(abs);
      return { mtimeMs: s.mtimeMs, size: s.size, isFile: s.isFile() };
    } catch (err) {
      throw this.sanitizeFsError(err); // rc.45 — M3: raw fs ENOENT embedded the abs path
    }
  }

  /**
   * Return an opaque generation receipt for one current public regular file.
   *
   * The path is admitted through the same canonical containment, symlink, and
   * privacy checks as reads. The receipt includes physical identity, size,
   * modification time, and metadata-change time; callers compare the complete
   * string and do not depend on its internal encoding.
   *
   * @param relOrAbs - Vault-relative or accepted absolute file path.
   * @returns Current regular-file generation state.
   * @throws {Error} If the path is missing, excluded, escapes the vault, or is
   *   not a regular file.
   * @example
   * ```ts
   * const before = await vault.sourceState("Notes/A.md");
   * const after = await vault.sourceState("Notes/A.md");
   * if (before.sourceRevision !== after.sourceRevision) throw new Error("changed");
   * ```
   */
  async sourceState(relOrAbs: string): Promise<FileSourceState> {
    const abs = await this.resolveSafePath(relOrAbs);
    try {
      const stat = await this.statSafe(abs);
      if (!stat.isFile()) {
        throw new Error(`Path is not a regular file: ${vaultRelative(this.root, abs)}`);
      }
      return {
        sourceRevision: fileSourceRevision(stat),
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs
      };
    } catch (err) {
      throw this.sanitizeFsError(err);
    }
  }

  /** Convert an absolute path under the vault to a vault-relative one
   *  (POSIX-separated on all platforms). Does not verify the result
   *  stays inside the vault; callers needing that should use
   *  {@link resolveInside}. */
  toRel(abs: string): string {
    return vaultRelative(this.root, abs);
  }

  /**
   * Find a markdown note by title (basename without `.md`, case-insensitive).
   * Returns the first match in walk order — vaults with duplicate titles
   * across folders silently pick one.
   *
   * v3.7.16 P2-13 — WRITE callers should use {@link findAllByTitle} +
   * fail-on-ambiguity instead of this method (silent first-match
   * selection here is fine for read paths but causes silent data
   * corruption when used as the write-target resolver). The
   * `resolveTarget` helper in `src/tools/write.ts` has an
   * `opts.strictOnAmbiguousTitle` flag for the write/read distinction.
   *
   * @param title - Note title with or without `.md` suffix.
   * @returns The matching file entry, or `null` if no note matches.
   */
  async findByTitle(title: string): Promise<FileEntry | null> {
    const norm = foldName(stripMdExt(title));
    const all = await this.listMarkdown();
    return all.find((e) => foldName(stripMdExt(e.basename)) === norm) ?? null;
  }

  /**
   * v3.7.16 P2-13 — find ALL notes with a given title (basename match).
   * Used by write tools to FAIL LOUDLY when multiple files share a
   * basename instead of silently mutating the first walk-order match.
   *
   * Pre-3.7.16, `appendToNote({ title: "Daily" })` would mutate
   * `Work/Daily.md` or `Personal/Daily.md` depending on directory walk
   * order — a silent-data-corruption footgun. Write surfaces now use
   * this method, fail on `.length > 1`, and surface the candidate paths
   * to the caller so they can disambiguate by `path`.
   *
   * @param title - Title without `.md` (case-insensitive basename match).
   * @returns All matching file entries (empty array if no match).
   */
  async findAllByTitle(title: string): Promise<FileEntry[]> {
    const norm = foldName(stripMdExt(title));
    const all = await this.listMarkdown();
    return all.filter((e) => foldName(stripMdExt(e.basename)) === norm);
  }

  /** Periodic Notes plugin config (`.obsidian/daily-notes.json` + Periodic
   *  Notes plugin's `data.json`). Lazy-loaded, then cached for the process
   *  lifetime. Returns an empty config when no plugin files exist. */
  async getPeriodicConfig(): Promise<PeriodicConfig> {
    if (this.periodicConfig) return this.periodicConfig;
    if (!this.ready) await this.ensureExists();
    // The built-in policy deliberately keeps `.obsidian` outside the public
    // surface. These two trusted config reads are the narrow exception, but
    // they still obey explicit --read-paths / --exclude-glob preferences and
    // fall back to hard-coded defaults when the user filters them.
    this.periodicConfig = await loadPeriodicConfig(this.root, (rel) => this.userExclusionReason(rel) !== null);
    return this.periodicConfig;
  }

  private async resolveSafePath(relOrAbs: string): Promise<string> {
    if (!this.ready) await this.ensureExists();
    // Root initialization may stat/realpath the configured vault itself.
    // Candidate-path I/O begins only after lexical containment and Windows
    // component validation; absolute paths through the configured root alias
    // remain accepted after `this.root` is canonicalized.
    const abs = this.resolveInside(relOrAbs);
    const lexicalNorm = vaultRelative(this.root, abs);
    const lexicalExclusion = this.exclusionReason(lexicalNorm);
    if (lexicalExclusion) {
      throw new Error(`Path is excluded by ${lexicalExclusion}: ${lexicalNorm}`);
    }
    try {
      const real = await this.realpathSafe(abs);
      const rel = path.relative(this.root, real);
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        // v3.7.20 ν class — error message previously interpolated `${abs}`,
        // which leaked the vault's absolute path to MCP clients (over HTTP,
        // that goes to anyone with a valid bearer token). The leak isn't
        // a security boundary (vault paths aren't secrets) but it's
        // unnecessary information disclosure. Use the resolved relative
        // form (which shows the user's intent) instead.
        throw new Error(`Resolved path escapes vault root: ${relOrAbs}`);
      }
      // Privacy filter — refuse to surface excluded content even via direct
      // read/write. Combined with listMarkdown filtering, the LLM has no
      // path into excluded files. v1.8.1: distinguish allowlist-miss from
      // explicit exclude-glob match in the error message so the user can
      // tell which flag is rejecting the path.
      const norm = rel.replace(/\\/g, "/");
      const physicalExclusion = this.exclusionReason(norm);
      if (physicalExclusion) {
        throw new Error(`Path is excluded by ${physicalExclusion}: ${norm}`);
      }
      return real;
    } catch (err) {
      if (isErrnoException(err) && err.code === "ENOENT") {
        const canonicalRel = await this.canonicalRelForPrivacyCheck(abs);
        const physicalExclusion = this.exclusionReason(canonicalRel);
        if (physicalExclusion) {
          throw new Error(`Path is excluded by ${physicalExclusion}: ${canonicalRel}`);
        }
        return abs;
      }
      throw err;
    }
  }

  private async assertSize(abs: string): Promise<void> {
    // v3.10.0-rc.49 (abs-path-leak class) — statSafe sanitizes the stat error at
    // the source, so every caller (readNote/readFile/readBinaryFile + watcher)
    // inherits a vault-relative error instead of a raw ENOENT embedding the abs path.
    const stat = await this.statSafe(abs);
    if (stat.size > this.maxFileBytes) {
      throw new Error(
        `File too large (${stat.size} bytes > limit ${this.maxFileBytes}): ${vaultRelative(this.root, abs)}`
      );
    }
  }

  private cacheSet(key: string, value: CachedNoteRecord): void {
    if (this.cache.size >= this.maxCacheEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, value);
    this.markCacheDirty();
  }

  private deleteCacheEntry(key: string): void {
    if (this.cache.delete(key)) this.markCacheDirty();
  }

  private markCacheDirty(): void {
    this.cacheEpoch += 1;
    this.cacheDirty = true;
  }
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

interface DiskCacheEntry {
  relPath: string;
  mtimeMs: number;
  sourceReceipt: CacheSourceReceipt;
  content: string;
  parsed: ParsedNote;
}

type DiskCacheCandidateResult =
  | { kind: "drop"; excludedByPrivacy?: true }
  | { kind: "hit"; abs: string; entry: DiskCacheEntry; needsMigration: boolean };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cacheSourceReceipt(stat: import("node:fs").Stats): CacheSourceReceipt {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs
  };
}

/** Opaque v1 regular-file generation receipt shared by listings and point
 *  admission. Delimiters and field order are deliberately private. */
function fileSourceRevision(stat: import("node:fs").Stats): string {
  const encoded = [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.mode].join("\0");
  return `fs-v1:${createHash("sha256").update(encoded, "utf8").digest("hex")}`;
}

function cloneCachedNote(entry: CachedNoteRecord): CachedNote {
  return {
    content: entry.content,
    parsed: cloneBoundedParsedNote(entry.parsed),
    mtimeMs: entry.mtimeMs
  };
}

function cloneBoundedParsedNote(parsed: ParsedNote): ParsedNote {
  const clones = new WeakMap<object, object>();
  const active = new WeakSet<object>();
  let inspectedValues = 0;
  const cloneValue = (value: unknown, depth: number): unknown => {
    inspectedValues += 1;
    if (inspectedValues > MAX_DISK_CACHE_JSON_VALUES) {
      throw new Error("Parsed note exceeds the detached-value limit");
    }
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new Error("Parsed note contains a non-finite number");
      return value;
    }
    if (typeof value !== "object" || depth > MAX_DISK_CACHE_JSON_DEPTH) {
      throw new Error("Parsed note contains an unsupported or over-deep value");
    }
    if (active.has(value)) throw new Error("Parsed note contains a cyclic value");
    const prior = clones.get(value);
    if (prior) return prior;
    active.add(value);
    if (Array.isArray(value)) {
      if (Object.hasOwn(value, "toJSON") || Object.getOwnPropertySymbols(value).length > 0) {
        throw new Error("Parsed note contains an unsupported array value");
      }
      if (value.length > MAX_DISK_CACHE_JSON_VALUES - inspectedValues) {
        throw new Error("Parsed note exceeds the detached-value limit");
      }
      const cloned: unknown[] = new Array(value.length);
      clones.set(value, cloned);
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          throw new Error("Parsed note contains a sparse or accessor-backed array");
        }
        cloned[index] = cloneValue(descriptor.value, depth + 1);
      }
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue;
        const index = Number(key);
        if (!Number.isSafeInteger(index) || index < 0 || index >= value.length || String(index) !== key) {
          throw new Error("Parsed note contains a custom array property");
        }
      }
      active.delete(value);
      return cloned;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("Parsed note contains a non-plain object");
    }
    if (Object.hasOwn(value, "toJSON") || Object.getOwnPropertySymbols(value).length > 0) {
      throw new Error("Parsed note contains an unsupported object value");
    }
    const cloned = Object.create(prototype) as Record<string, unknown>;
    clones.set(value, cloned);
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        throw new Error("Parsed note contains an accessor-backed object");
      }
      if (inspectedValues >= MAX_DISK_CACHE_JSON_VALUES) {
        throw new Error("Parsed note exceeds the detached-value limit");
      }
      Object.defineProperty(cloned, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: cloneValue(descriptor.value, depth + 1)
      });
    }
    active.delete(value);
    return cloned;
  };
  return cloneValue(parsed, 0) as ParsedNote;
}

function isCacheSourceReceipt(value: unknown): value is CacheSourceReceipt {
  if (!isRecord(value)) return false;
  return (
    typeof value.dev === "number" &&
    // Node exposes ordinary Stats.dev/ino as numbers even when a native
    // Windows file identifier is wider than JavaScript's exact-integer range.
    // JSON still round-trips that already-materialized value as the same
    // JavaScript number,
    // and this receipt is a freshness hint rather than an authenticity proof.
    // Reject fractions/non-finite values, but do not discard a legitimate
    // Windows cache generation merely because its opaque identity is wide.
    Number.isInteger(value.dev) &&
    value.dev >= 0 &&
    typeof value.ino === "number" &&
    Number.isInteger(value.ino) &&
    value.ino >= 0 &&
    typeof value.size === "number" &&
    Number.isSafeInteger(value.size) &&
    value.size >= 0 &&
    typeof value.mtimeMs === "number" &&
    Number.isFinite(value.mtimeMs) &&
    typeof value.ctimeMs === "number" &&
    Number.isFinite(value.ctimeMs)
  );
}

function cacheSourceReceiptsEqual(left: CacheSourceReceipt, right: CacheSourceReceipt): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function isPersistedLink(value: unknown): boolean {
  if (!isRecord(value) || typeof value.raw !== "string" || typeof value.target !== "string") return false;
  if (
    !Number.isSafeInteger(value.sourceStart) ||
    !Number.isSafeInteger(value.sourceEnd) ||
    (value.sourceStart as number) < 0 ||
    (value.sourceEnd as number) <= (value.sourceStart as number)
  ) {
    return false;
  }
  for (const optional of ["section", "block", "alias"] as const) {
    if (Object.hasOwn(value, optional) && typeof value[optional] !== "string") return false;
  }
  return true;
}

function isBoundedArray(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length <= MAX_PERSISTED_PARSED_COLLECTION_ITEMS;
}

function isPersistedParsedNote(value: unknown): value is ParsedNote {
  if (!isRecord(value) || !isRecord(value.frontmatter) || typeof value.body !== "string") return false;
  if (!Number.isSafeInteger(value.bodyStartLine) || (value.bodyStartLine as number) < 1) return false;
  if (!isBoundedArray(value.wikilinks) || !value.wikilinks.every(isPersistedLink)) return false;
  if (!isBoundedArray(value.embeds) || !value.embeds.every(isPersistedLink)) return false;
  return isBoundedArray(value.tags) && value.tags.every((tag) => typeof tag === "string");
}

type DiskCacheJsonMeasurement = { kind: "ok"; bytes: number } | { kind: "invalid" } | { kind: "over-budget" };

function measureJsonStringBytes(value: string, maxBytes: number): number | null {
  let bytes = 2;
  if (bytes > maxBytes) return null;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    let additional: number;
    if (code === 0x22 || code === 0x5c || [0x08, 0x09, 0x0a, 0x0c, 0x0d].includes(code)) {
      additional = 2;
    } else if (code <= 0x1f) {
      additional = 6;
    } else if (code <= 0x7f) {
      additional = 1;
    } else if (code <= 0x7ff) {
      additional = 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        additional = 4;
        index += 1;
      } else {
        additional = 6;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      additional = 6;
    } else {
      additional = 3;
    }
    if (additional > maxBytes - bytes) return null;
    bytes += additional;
  }
  return bytes;
}

function measureBoundedDiskCacheJson(root: unknown, maxBytes: number): DiskCacheJsonMeasurement {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) return { kind: "over-budget" };
  const seen = new WeakSet<object>();
  let inspectedValues = 0;
  let bytes = 0;
  const addBytes = (additional: number): boolean => {
    if (additional > maxBytes - bytes) return false;
    bytes += additional;
    return true;
  };
  const visit = (value: unknown, depth: number): "ok" | "invalid" | "over-budget" => {
    inspectedValues += 1;
    if (inspectedValues > MAX_DISK_CACHE_JSON_VALUES) return "invalid";
    if (value === null) return addBytes(4) ? "ok" : "over-budget";
    if (typeof value === "string") {
      const measured = measureJsonStringBytes(value, maxBytes - bytes);
      if (measured === null) return "over-budget";
      bytes += measured;
      return "ok";
    }
    if (typeof value === "boolean") return addBytes(value ? 4 : 5) ? "ok" : "over-budget";
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return "invalid";
      return addBytes(String(value).length) ? "ok" : "over-budget";
    }
    if (typeof value !== "object" || depth > MAX_DISK_CACHE_JSON_DEPTH) return "invalid";
    if (seen.has(value)) return "invalid";
    seen.add(value);

    if (Array.isArray(value)) {
      if (Object.hasOwn(value, "toJSON") || Object.getOwnPropertySymbols(value).length > 0) return "invalid";
      if (value.length > MAX_DISK_CACHE_JSON_VALUES - inspectedValues) return "invalid";
      if (!addBytes(1)) return "over-budget";
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return "invalid";
        if (index > 0 && !addBytes(1)) return "over-budget";
        const child = visit(descriptor.value, depth + 1);
        if (child !== "ok") return child;
      }
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue;
        const index = Number(key);
        if (!Number.isSafeInteger(index) || index < 0 || index >= value.length || String(index) !== key) {
          return "invalid";
        }
      }
      return addBytes(1) ? "ok" : "over-budget";
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return "invalid";
    if (Object.hasOwn(value, "toJSON") || Object.getOwnPropertySymbols(value).length > 0) return "invalid";
    if (!addBytes(1)) return "over-budget";
    let first = true;
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return "invalid";
      if (inspectedValues >= MAX_DISK_CACHE_JSON_VALUES) return "invalid";
      if (!first && !addBytes(1)) return "over-budget";
      const keyBytes = measureJsonStringBytes(key, maxBytes - bytes);
      if (keyBytes === null) return "over-budget";
      bytes += keyBytes;
      if (!addBytes(1)) return "over-budget";
      const child = visit(descriptor.value, depth + 1);
      if (child !== "ok") return child;
      first = false;
    }
    return addBytes(1) ? "ok" : "over-budget";
  };
  const outcome = visit(root, 0);
  return outcome === "ok" ? { kind: "ok", bytes } : { kind: outcome };
}

function isBoundedDiskCacheJsonTree(root: unknown): boolean {
  return measureBoundedDiskCacheJson(root, Number.MAX_SAFE_INTEGER).kind === "ok";
}

interface DiskCacheSnapshotEntry {
  abs: string;
  source: CachedNoteRecord;
}

interface DiskCachePersistenceTarget {
  requestedFile: string;
  canonicalFile: string;
  lifetime: PersistenceFamilyLeaseHandle;
}

interface DiskCacheLoadRequest {
  requestedFile: string | null;
  acceptedGeneration: number;
}

interface DiskCacheSaveRequest {
  requestedFile: string;
  publishedEpoch: number;
  cacheSnapshot: readonly DiskCacheSnapshotEntry[];
}

interface DiskCacheClearRequest {
  requestedFile: string;
}

interface DiskCachePhysicalClearRequest {
  file: string;
}

interface DiskCacheClearBarrier {
  request: DiskCacheClearRequest;
  promise: Promise<boolean>;
}

function defaultCacheFile(root: string): string {
  const base =
    process.env.XDG_CACHE_HOME ??
    (process.platform === "darwin" ? path.join(os.homedir(), "Library", "Caches") : path.join(os.homedir(), ".cache"));
  const hash = createHash("sha1").update(root).digest("hex").slice(0, 12);
  return path.join(base, "enquire", `${hash}.json`);
}

// Recursion-depth bound for the common incremental vault walker. Symlinks are
// skipped (no cycle risk), while a pathologically deep real directory tree is
// reported as an incomplete inventory rather than silently accepted as exact.
const MAX_WALK_DEPTH = 64;

interface BoundedWalkState extends BoundedFileListing {}

async function walkBoundedExtensions(
  dir: string,
  root: string,
  extensions: ReadonlySet<string>,
  maxFiles: number,
  maxVisitedEntries: number,
  isExcluded: (relPath: string) => boolean,
  state: BoundedWalkState,
  depth = 0
): Promise<void> {
  let directory: import("node:fs").Dir;
  try {
    directory = await fs.opendir(dir);
  } catch {
    state.complete = false;
    return;
  }

  for await (const entry of directory) {
    state.visitedEntries += 1;
    if (state.visitedEntries > maxVisitedEntries) {
      state.complete = false;
      return;
    }

    const full = path.join(dir, entry.name);
    const relPath = vaultRelative(root, full);
    if (restrictedVaultPathReason(relPath) || entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (depth >= MAX_WALK_DEPTH) {
        state.complete = false;
        return;
      }
      const real = await fs.realpath(full).catch(() => null);
      if (!real) {
        state.complete = false;
        return;
      }
      const rel = path.relative(root, real);
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        state.complete = false;
        return;
      }
      await walkBoundedExtensions(real, root, extensions, maxFiles, maxVisitedEntries, isExcluded, state, depth + 1);
      if (!state.complete) return;
      continue;
    }
    if (!entry.isFile() || !extensions.has(path.extname(entry.name).toLowerCase())) continue;
    const normalizedRelPath = relPath.replace(/\\/g, "/");
    if (isExcluded(normalizedRelPath)) continue;
    if (state.entries.length >= maxFiles) {
      state.complete = false;
      return;
    }
    const stat = await fs.stat(full).catch(() => null);
    if (!stat?.isFile()) {
      state.complete = false;
      return;
    }
    state.entries.push({
      absPath: full,
      relPath,
      basename: entry.name,
      mtimeMs: stat.mtimeMs,
      sizeBytes: stat.size,
      sourceRevision: fileSourceRevision(stat)
    });
  }
}

/**
 * Defensive cap on a glob pattern length (v3.10.0-rc.68, round-3 re-sweep). Bounds the
 * tokenize/match work on an absurd operator-supplied glob from `--exclude-glob` /
 * `--read-paths`. As of v3.10.0-rc.71 the catastrophic-backtracking guard is structural —
 * {@link compileGlob} matches via a NON-backtracking DP, not a `RegExp` — so this is a
 * cheap secondary bound, not the ReDoS guard.
 */
export const MAX_GLOB_PATTERN_LEN = 1024;

/**
 * Compile a minimal glob into a NON-backtracking matcher anchored against
 * vault-relative paths (forward-slash separated). Supports:
 *   `*`   — any run of non-slash characters
 *   `**`  — any run of characters including slashes (globstar)
 *   `?`   — exactly one non-slash character
 * No bracket sets, no `!` negation, no `{a,b}` alternation. Patterns are matched
 * against the full vault-relative path (e.g. `02_Personal/Inbox/x.md`). The
 * returned object exposes `.test(path)` so call sites read like the old
 * `globToRegex(...).test(...)`.
 *
 * v3.10.0-rc.71 (post-rc.66 re-sweep, ReDoS class — closes the rc.68 sibling): matching
 * is now a NON-backtracking DP (`matchWildcardTokens`), NOT a `RegExp`. The
 * pre-rc.71 `globToRegex` compiled `*`→`[^/]*` / `**`→`.*` and (rc.68) collapsed only
 * ADJACENT unbounded quantifiers. A glob with wildcards SEPARATED BY LITERALS
 * (`*a*a*…` → `^[^/]*a[^/]*a…$`, or `**a**a…`) was still catastrophic — the rc.68
 * adjacency-collapse cannot touch a literal-separated run, and its structural guard
 * (asserting "no adjacent quantifiers") gave false confidence against this shape. The
 * catastrophe scales with the matched PATH length (paths can be 100+ chars deep), so a
 * wildcard count cap is not structurally safe. This filter runs via `.test()` on EVERY
 * path of EVERY vault scan, so one fat-fingered `--exclude-glob` / `--read-paths` froze
 * every scan; the linear matcher removes the backtracking engine entirely.
 */
export function compileGlob(glob: string): { test(path: string): boolean } {
  if (glob.length > MAX_GLOB_PATTERN_LEN) {
    throw new Error(`glob pattern too long (${glob.length} > ${MAX_GLOB_PATTERN_LEN} chars).`);
  }
  const tokens = compileGlobTokens(glob);
  return { test: (p: string): boolean => matchWildcardTokens(tokens, p) };
}

function stripMdExt(name: string): string {
  return name.replace(/\.md$/i, "");
}
