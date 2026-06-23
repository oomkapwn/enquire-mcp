import { createHash, randomBytes } from "node:crypto";
import { promises as fs, constants as fsConstants } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { foldName } from "./name-fold.js";
import { type ParsedNote, parseNote } from "./parser.js";
import { loadPeriodicConfig, type PeriodicConfig } from "./periodic.js";
import { compileGlobTokens, matchWildcardTokens } from "./wildcard-match.js";

const SKIP_DIRS = new Set([".git", ".obsidian", ".trash", "node_modules", ".DS_Store"]);

/** Maximum file size {@link Vault.readNote} / {@link Vault.writeNote} will
 *  process by default. 5 MB — large enough for any realistic note, small
 *  enough that a runaway file (e.g. a multi-GB log mistakenly placed in
 *  the vault) doesn't OOM the server. */
export const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
/** Maximum in-memory parsed-note cache size (LRU eviction past this). */
export const DEFAULT_MAX_CACHE_ENTRIES = 1024;

/** Bumped on any change to ParsedNote shape — invalidates persisted caches that don't match. */
const DISK_CACHE_VERSION = 1;
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
}

/** A parse-cached note (post-frontmatter body + parsed structure + the
 *  mtime at parse time, for cache freshness). */
export interface CachedNote {
  /** Raw file content (UTF-8). */
  content: string;
  /** Parsed structure — see {@link ParsedNote}. */
  parsed: ParsedNote;
  /** mtime at parse time. Used to detect stale cache entries. */
  mtimeMs: number;
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
  /** Override the cache file location. Default: ~/.cache/enquire/<vault-hash>.json. */
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
 * privacy filtering (`--read-paths` allowlist + `--exclude-glob` denylist),
 * parsed-note caching (in-memory LRU + optional persistent JSON file),
 * and write gating (opt-in via `--enable-write`).
 *
 * Construct once at server start, then share across all tool calls.
 * Methods are async because filesystem IO; the in-memory cache makes
 * repeated reads of the same note ~free.
 *
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
  readonly maxFileBytes: number;
  readonly maxCacheEntries: number;
  readonly writeEnabled: boolean;
  readonly persistentCacheEnabled: boolean;
  readonly maxDiskCacheBytes: number;
  readonly excludeGlobs: readonly string[];
  readonly readPaths: readonly string[];
  private excludeMatchers: Array<{ test(path: string): boolean }>;
  private readPathMatchers: Array<{ test(path: string): boolean }>;
  cacheFile: string | null;
  private cache = new Map<string, CachedNote>();
  private cacheDirty = false;
  private ready = false;
  /** Lazily loaded periodic-notes config (.obsidian/daily-notes.json + Periodic
   *  Notes plugin). Cached forever after first read — users restart the server
   *  if they reconfigure plugins. */
  private periodicConfig: PeriodicConfig | null = null;

  constructor(root: string, opts: VaultOptions = {}) {
    this.root = path.resolve(root);
    this.maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.maxCacheEntries = opts.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES;
    this.writeEnabled = opts.enableWrite ?? false;
    this.persistentCacheEnabled = opts.persistentCache ?? false;
    this.maxDiskCacheBytes = opts.maxDiskCacheBytes ?? DEFAULT_MAX_DISK_CACHE_BYTES;
    this.cacheFile = opts.cacheFile ?? null;
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

  /** v2.0.0-beta.2: helper that returns the reason a path was excluded, or
   *  null if not excluded. Lets call sites surface the right CLI flag in
   *  user-facing error messages without duplicating the regex predicates. */
  exclusionReason(
    relPath: string
  ): "--read-paths allowlist (path doesn't match any allow-glob)" | "--exclude-glob denylist" | null {
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

  /** True if a vault-relative path is filtered out by either --read-paths
   *  (strict allowlist) or --exclude-glob (denylist). When --read-paths is set
   *  but the path doesn't match any allow-glob, the file is treated as
   *  excluded — no list/read/write/watch event surfaces it.
   *  When BOTH are set: must match an allow-glob AND not match an exclude. */
  isExcluded(relPath: string): boolean {
    if (this.excludeMatchers.length === 0 && this.readPathMatchers.length === 0) return false;
    const norm = relPath.replace(/\\/g, "/");
    if (this.readPathMatchers.length > 0 && !this.readPathMatchers.some((re) => re.test(norm))) {
      return true; // not in allowlist → excluded
    }
    if (this.excludeMatchers.length === 0) return false;
    return this.excludeMatchers.some((re) => re.test(norm));
  }

  /**
   * Verify the vault root exists, is a directory, and resolve through any
   * symlinks. Idempotent — safe to call before every operation; the
   * underlying state is cached after the first successful call.
   *
   * Also (when persistent cache is enabled) loads the on-disk parse cache.
   *
   * @throws {Error} If the vault root doesn't exist or isn't a directory.
   */
  async ensureExists(): Promise<void> {
    if (this.ready) return;
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
      this.cacheFile = defaultCacheFile(this.root);
    }
    this.ready = true;
    if (this.persistentCacheEnabled) {
      await this.loadDiskCache();
    }
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
   *
   * @returns Number of entries loaded into memory.
   * @internal called automatically by {@link ensureExists} when persistent
   *           cache is enabled.
   */
  async loadDiskCache(): Promise<number> {
    if (!this.cacheFile) return 0;
    try {
      const stat = await this.statSafe(this.cacheFile);
      if (stat.size > this.maxDiskCacheBytes) {
        process.stderr.write(
          `enquire: ignoring cache file (${stat.size} bytes > limit ${this.maxDiskCacheBytes}): ${this.cacheFile}\n`
        );
        return 0;
      }
    } catch {
      return 0;
    }
    let raw: string;
    try {
      raw = await this.readFileSafe(this.cacheFile, "utf8");
    } catch {
      return 0;
    }
    let data: DiskCacheFile;
    try {
      data = JSON.parse(raw) as DiskCacheFile;
    } catch {
      return 0;
    }
    if (data.version !== DISK_CACHE_VERSION || data.root !== this.root) return 0;
    if (!Array.isArray(data.entries)) return 0;

    // Stat every candidate in parallel — sequential blocked on big caches.
    const checks = await Promise.all(
      data.entries.map(async (entry) => {
        if (typeof entry.relPath !== "string" || typeof entry.mtimeMs !== "number") return { kind: "drop" } as const;
        if (typeof entry.content !== "string") return { kind: "drop" } as const;
        if (Buffer.byteLength(entry.content, "utf8") > this.maxFileBytes) return { kind: "drop" } as const;
        // Reject relative paths that escape the vault root after resolution.
        // A crafted cache file with relPath like "../../../etc/hosts" would
        // otherwise pollute the in-memory cache with a key pointing outside
        // the vault. The orphaned entry would never be served (resolveSafePath
        // blocks reads), but it would persist back to disk on next save.
        const abs = path.resolve(this.root, entry.relPath);
        const relCheck = path.relative(this.root, abs);
        if (relCheck.startsWith("..") || path.isAbsolute(relCheck)) return { kind: "drop" } as const;
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
          if (s.mtimeMs !== entry.mtimeMs) return { kind: "drop" } as const;
          // Belt-and-braces: realpath check in case the path includes a symlink
          // chain that resolves outside the vault.
          const real = await fs.realpath(abs).catch(() => abs);
          const realRel = path.relative(this.root, real);
          if (realRel.startsWith("..") || path.isAbsolute(realRel)) return { kind: "drop" } as const;
          return { kind: "hit", abs, entry } as const;
        } catch {
          // Source file gone — drop and force a clean rewrite on next save.
          return { kind: "drop" } as const;
        }
      })
    );
    let loaded = 0;
    let dropped = 0;
    let droppedByPrivacy = 0;
    for (const result of checks) {
      if (result.kind === "drop") {
        dropped += 1;
        if ("excludedByPrivacy" in result && result.excludedByPrivacy === true) {
          droppedByPrivacy += 1;
        }
        continue;
      }
      if (this.cache.size >= this.maxCacheEntries) break;
      this.cache.set(result.abs, {
        content: result.entry.content,
        parsed: result.entry.parsed,
        mtimeMs: result.entry.mtimeMs
      });
      loaded += 1;
    }
    // If we silently dropped any persisted entries (deleted notes, oversized,
    // mtime-stale), mark the cache dirty so the next save rewrites WITHOUT
    // those entries. Closes the audit finding about deleted-note content
    // lingering on disk after the source note is removed from the vault.
    if (dropped > 0) this.cacheDirty = true;
    // v3.7.16 P1-4 — when entries were dropped specifically because a new
    // privacy filter excluded them, surface that to stderr so operators
    // see the privacy-boundary correction (e.g., adding --exclude-glob
    // "Personal/**" after running for weeks with no filter). The pruned
    // snapshot will be written to disk by the next saveDiskCache() call
    // via the cacheDirty flag above.
    if (droppedByPrivacy > 0) {
      process.stderr.write(
        `enquire: persistent cache — dropped ${droppedByPrivacy} entries now excluded by --exclude-glob / --read-paths. ` +
          `Cache will be rewritten without them on the next save.\n`
      );
    }
    return loaded;
  }

  /**
   * Delete the on-disk parse cache file and reset the in-memory cache.
   * No-op when persistent cache wasn't configured.
   *
   * @returns `true` if a cache file was removed, `false` if no file existed.
   */
  async clearDiskCache(): Promise<boolean> {
    if (!this.cacheFile) return false;
    // rc.36 F-2 (P-2 erasure-completeness sibling) — erase BOTH the cache file
    // AND any leftover atomic-write temp. A crash between `saveDiskCache`'s
    // `writeFile(tmp)` and `rename` (or an EXDEV cross-device rename) leaves
    // `${cacheFile}.tmp` holding full note bodies on disk; clearing only the
    // main file would leave raw vault text behind — a right-to-erasure gap,
    // the parse-cache analogue of the rc.34 HNSW `.meta.json` sidecar fix.
    const file = this.cacheFile;
    let removed = false;
    for (const target of [file, `${file}.tmp`]) {
      try {
        await this.unlinkSafe(target);
        removed = true;
      } catch (err) {
        if (!(isErrnoException(err) && err.code === "ENOENT")) throw err;
      }
    }
    this.cache.clear();
    this.cacheDirty = false;
    return removed;
  }

  /**
   * Flush the in-memory parse cache to disk. Writes to a temp file then
   * atomically renames over the target so a crash mid-flush can't
   * corrupt the cache. Sets mode 0o600 on the cache file and 0o700 on
   * its directory to keep note bodies private to the user account.
   *
   * No-op when persistent cache wasn't configured or the cache hasn't
   * been modified since the last save (`cacheDirty` flag).
   */
  async saveDiskCache(): Promise<void> {
    if (!this.persistentCacheEnabled || !this.cacheFile || !this.cacheDirty) return;
    const entries: DiskCacheEntry[] = [];
    for (const [abs, cached] of this.cache) {
      entries.push({
        relPath: path.relative(this.root, abs),
        mtimeMs: cached.mtimeMs,
        content: cached.content,
        parsed: cached.parsed
      });
    }
    const payload: DiskCacheFile = {
      version: DISK_CACHE_VERSION,
      root: this.root,
      writtenAt: new Date().toISOString(),
      entries
    };
    const serialized = JSON.stringify(payload);
    if (Buffer.byteLength(serialized, "utf8") > this.maxDiskCacheBytes) {
      process.stderr.write(
        `enquire: refusing to write cache (${Buffer.byteLength(serialized, "utf8")} bytes > limit ${this.maxDiskCacheBytes}): ${this.cacheFile}\n`
      );
      return;
    }
    const cacheDir = path.dirname(this.cacheFile);
    // v3.7.13 M9 — only chmod the cache dir to 0700 if we CREATED it.
    // Pre-3.7.13 we always chmod'd, which clobbered perms on a custom
    // `--cache-file` parent (e.g. ~/.local/share/, a shared Dropbox folder,
    // an NFS mount with group-readable defaults). FtsIndex / EmbedDb
    // already use this `parentExisted` gate (src/fts5.ts, src/embed-db.ts);
    // applying the same pattern here closes the inconsistency.
    const parentExisted = await fs
      .stat(cacheDir)
      .then(() => true)
      .catch(() => false);
    await this.mkdirSafe(cacheDir, { recursive: true, mode: 0o700 });
    if (!parentExisted) {
      // Directory didn't exist before this call — we own it, lock perms.
      await fs.chmod(cacheDir, 0o700).catch(() => {});
    }
    const tmp = `${this.cacheFile}.tmp`;
    // mode 0o600 — full note bodies live here, treat as private to the user account.
    await this.writeFileSafe(tmp, serialized, { encoding: "utf8", mode: 0o600 });
    await this.renameSafe(tmp, this.cacheFile);
    // Defensive: rename preserves original mode if file existed; chmod ensures 0o600 either way.
    await fs.chmod(this.cacheFile, 0o600).catch(() => {});
    this.cacheDirty = false;
  }

  /**
   * Resolve a vault-relative or absolute path to an absolute path, after
   * asserting the result stays inside the vault root. This is the
   * lexical guard; {@link resolveSafePath} additionally walks symlinks.
   *
   * @param p - Path string (relative or absolute).
   * @returns Absolute path.
   * @throws {Error} If the resolved path escapes the vault root.
   */
  resolveInside(p: string): string {
    const abs = path.resolve(this.root, p);
    const rel = path.relative(this.root, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`Path escapes vault root: ${p}`);
    }
    return abs;
  }

  /**
   * List every markdown file under the vault root (or a subfolder).
   * Skips `.git` / `.obsidian` / `.trash` / `node_modules` directories,
   * follows the standard hidden-file rule (no dotfiles), refuses to
   * traverse symlinks. Applies the privacy filter (`--exclude-glob` /
   * `--read-paths`) before returning.
   *
   * @param folder - Optional vault-relative subfolder. When set, scan
   *   only under that folder. Returns `[]` if the folder doesn't exist,
   *   is a symlink, or is itself excluded.
   * @returns Discovered files in walk order (depth-first, alphabetical).
   */
  async listMarkdown(folder?: string): Promise<FileEntry[]> {
    if (!this.ready) await this.ensureExists();
    const start = folder ? this.resolveInside(folder) : this.root;
    if (folder) {
      const lstat = await fs.lstat(start).catch(() => null);
      if (!lstat) return [];
      if (lstat.isSymbolicLink()) return [];
      const real = await fs.realpath(start).catch(() => null);
      if (!real) return [];
      const rel = path.relative(this.root, real);
      if (rel.startsWith("..") || path.isAbsolute(rel)) return [];
      // If the requested folder itself matches an exclude glob, treat as empty.
      if (this.isExcluded(rel)) return [];
    }
    const out: FileEntry[] = [];
    await walk(start, this.root, out);
    // Apply privacy filter — paths matching any --exclude-glob OR not matching
    // any --read-paths allowlist pattern are omitted from the listing entirely.
    // resolveSafePath also rejects them on direct read/write, so the LLM has
    // no way to reach excluded content.
    if (this.excludeMatchers.length > 0 || this.readPathMatchers.length > 0) {
      return out.filter((e) => !this.isExcluded(e.relPath.replace(/\\/g, "/")));
    }
    return out;
  }

  /** Walk the vault and return files ending with the given extension (e.g.
   *  ".canvas", ".pdf"). Honors --exclude-glob + --read-paths. Used by the
   *  v1.7 canvas tools and any future file-format-specific tools. */
  async listFilesByExtension(ext: string, folder?: string): Promise<FileEntry[]> {
    if (!this.ready) await this.ensureExists();
    const start = folder ? this.resolveInside(folder) : this.root;
    if (folder) {
      const lstat = await fs.lstat(start).catch(() => null);
      if (!lstat || lstat.isSymbolicLink()) return [];
      const real = await fs.realpath(start).catch(() => null);
      if (!real) return [];
      const rel = path.relative(this.root, real);
      if (rel.startsWith("..") || path.isAbsolute(rel)) return [];
      if (this.isExcluded(rel)) return [];
    }
    const out: FileEntry[] = [];
    await walkAnyExt(start, this.root, out, ext.toLowerCase());
    if (this.excludeMatchers.length > 0 || this.readPathMatchers.length > 0) {
      return out.filter((e) => !this.isExcluded(e.relPath.replace(/\\/g, "/")));
    }
    return out;
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
      const root = this.root;
      const strip = (s: string): string => s.split(`${root}${path.sep}`).join("").split(root).join("");
      if (typeof err.message === "string" && err.message.includes(root)) err.message = strip(err.message);
      const rec = err as unknown as Record<string, unknown>;
      for (const k of ["path", "dest"] as const) {
        const v = rec[k];
        if (typeof v === "string" && v.includes(root)) rec[k] = strip(v);
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
  private async writeFileSafe(p: string, data: string, opts: Parameters<typeof fs.writeFile>[2]): Promise<void> {
    try {
      await fs.writeFile(p, data, opts);
    } catch (err) {
      throw this.sanitizeFsError(err);
    }
  }
  private async openSafe(p: string, flags: string, mode?: number): Promise<import("node:fs/promises").FileHandle> {
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
   * file's mtime hasn't changed; otherwise reads from disk, parses via
   * {@link parseNote}, and caches the result (LRU-evicting the oldest
   * entry when at capacity).
   *
   * @param relOrAbs - Vault-relative or absolute path to a `.md` file.
   * @param knownMtimeMs - Optional pre-stat'd mtime (saves a `fs.stat`
   *   call when the caller already has it, e.g. straight after `listMarkdown`).
   * @returns Cached note including parsed structure.
   * @throws {Error} If the path escapes the vault, is excluded, or
   *   exceeds the size cap.
   */
  async readNote(relOrAbs: string, knownMtimeMs?: number): Promise<CachedNote> {
    const abs = await this.resolveSafePath(relOrAbs);
    // v3.10.0-rc.49 (abs-path-leak class — re-audit CODE-1) — readNote is the
    // primary list-then-read funnel (getNoteNeighbors / semanticSearch / etc.
    // loop it over listMarkdown()); rc.45 sanitized readFile/readBinaryFile/stat
    // but MISSED this method, so a TOCTOU delete / EACCES / file→dir between the
    // list and the per-entry read leaked the host absolute path to MCP clients.
    // Wrap the disk ops; sanitizeFsError is a no-op on the (relative) deliberate
    // errors, so only raw fs errors get the root stripped.
    try {
      const mtimeMs = knownMtimeMs ?? (await this.statSafe(abs)).mtimeMs;
      const cached = this.cache.get(abs);
      if (cached && cached.mtimeMs === mtimeMs) {
        // LRU bump: re-insert so this entry is "freshest"
        this.cache.delete(abs);
        this.cache.set(abs, cached);
        return cached;
      }
      await this.assertSize(abs);
      const content = await this.readFileSafe(abs, "utf8");
      const parsed = parseNote(content);
      const entry = { content, parsed, mtimeMs };
      this.cacheSet(abs, entry);
      return entry;
    } catch (err) {
      throw this.sanitizeFsError(err);
    }
  }

  /**
   * Create or overwrite a markdown note. Requires `enableWrite: true` at
   * construction. Honors privacy filters — refuses to write to a path
   * excluded by `--read-paths` / `--exclude-glob`. Refuses to write
   * through symlinks. Auto-creates parent directories.
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
    if (!this.writeEnabled) {
      throw new Error("Vault is read-only — start the server with --enable-write to allow note creation");
    }
    if (!this.ready) await this.ensureExists();
    if (Buffer.byteLength(content, "utf8") > this.maxFileBytes) {
      throw new Error(`Refusing to write ${Buffer.byteLength(content, "utf8")} bytes (limit ${this.maxFileBytes})`);
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
    await this.assertParentInsideVault(abs);
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
    if (this.isExcluded(targetRelNorm)) {
      const reason =
        this.readPathMatchers.length > 0 && !this.readPathMatchers.some((re) => re.test(targetRelNorm))
          ? "--read-paths allowlist (path doesn't match any allow-glob)"
          : "--exclude-glob denylist";
      throw new Error(`Refusing to write — destination is excluded by ${reason}: ${targetRelNorm}`);
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
    // legacy stat-based check stays as a no-op (writeFile-with-`wx` throws
    // EEXIST on existing destination, which we translate to the same
    // user-facing "Note already exists" error for back-compat).
    const targetLstat = await fs.lstat(abs).catch(() => null);
    if (targetLstat?.isSymbolicLink()) {
      throw new Error(`Refusing to write — target is a symlink: ${path.relative(this.root, abs)}`);
    }
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
      const existing = await this.statSafe(abs).catch(() => null);
      const tmpMode = existing ? existing.mode & 0o777 : 0o666;
      const tmp = `${abs}.${randomBytes(8).toString("hex")}.tmp`;
      let fh: import("node:fs/promises").FileHandle | undefined;
      try {
        fh = await this.openSafe(tmp, "wx", tmpMode); // O_EXCL — never follows a pre-planted symlink
        await fh.writeFile(content, "utf8");
        await fh.close();
        fh = undefined;
        await this.renameSafe(tmp, abs);
      } catch (err) {
        if (fh) await fh.close().catch(() => {});
        await this.unlinkSafe(tmp).catch(() => {});
        throw err;
      }
    } else {
      try {
        await this.writeFileSafe(abs, content, { encoding: "utf8", flag: "wx" });
      } catch (err) {
        if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "EEXIST") {
          throw new Error(`Note already exists: ${targetRel} (pass overwrite=true to replace)`);
        }
        throw err;
      }
    }
    this.cache.delete(abs);
    const stat = await this.statSafe(abs);
    return {
      absPath: abs,
      relPath: path.relative(this.root, abs),
      mtimeMs: stat.mtimeMs,
      bytes: stat.size
    };
  }

  private async assertParentInsideVault(abs: string): Promise<void> {
    let current = path.dirname(abs);
    while (current !== this.root && current !== path.dirname(current)) {
      const real = await fs.realpath(current).catch(() => null);
      if (real) {
        const rel = path.relative(this.root, real);
        if (rel.startsWith("..") || path.isAbsolute(rel)) {
          // rc.36 F-3 (P-3 / ν-class sibling) — echo the path RELATIVE to the
          // vault root, never the absolute server path. `current` is a
          // server-computed absolute dir; leaking it to an MCP client over
          // serve-http discloses the host filesystem layout. Mirrors the
          // sibling symlink throw above (`path.relative(this.root, abs)`).
          throw new Error(
            `Refusing to write — parent directory resolves outside vault: ${path.relative(this.root, current)}`
          );
        }
        break;
      }
      current = path.dirname(current);
    }
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
   * Falls back to the lexical form if no parent exists (vault root
   * missing — handled by the broader `ensureExists` startup check).
   */
  /**
   * Public alias for {@link canonicalRelForPrivacyCheck}. v3.7.16 P1-6 —
   * used by `renameNote` wrapper in `src/tools/write.ts` to fail-fast on
   * case-insensitive-FS variants before doing O(N) backlink-rewrite work.
   * The inner `renameFile` also does this check; this public surface lets
   * orchestrators pre-check without duplicating the realpath logic.
   */
  async canonicalRelForPrivacyCheckPublic(abs: string): Promise<string> {
    return this.canonicalRelForPrivacyCheck(abs);
  }

  private async canonicalRelForPrivacyCheck(abs: string): Promise<string> {
    const lexical = path.relative(this.root, abs).replace(/\\/g, "/");
    let existing = abs;
    const tail: string[] = [];
    // Walk UP until we find an existing path (or hit vault root).
    while (true) {
      try {
        await this.statSafe(existing);
        break;
      } catch {
        const parent = path.dirname(existing);
        if (parent === existing) return lexical; // hit FS root unexpectedly
        tail.unshift(path.basename(existing));
        existing = parent;
        if (existing.length < this.root.length) return lexical; // walked past vault root
      }
    }
    // Resolve realpath on the existing prefix → canonical case from disk.
    const realExisting = await fs.realpath(existing).catch(() => existing);
    // Re-join the not-yet-existing tail (caller's case is fine for non-
    // existent segments).
    const canonicalAbs = tail.length === 0 ? realExisting : path.join(realExisting, ...tail);
    const rel = path.relative(this.root, canonicalAbs).replace(/\\/g, "/");
    // If the canonical-form path escapes the vault, fall back to the
    // lexical form — the broader path-traversal check will catch it.
    if (rel.startsWith("..") || path.isAbsolute(rel)) return lexical;
    return rel;
  }

  /** Rename a markdown file inside the vault. v3.7.14 F2 — atomic destination
   *  guard via `fs.link(fromAbs, toAbs)` + `fs.unlink(fromAbs)` for the
   *  non-overwrite path (link(2) fails atomically with EEXIST, closing the
   *  stat-then-rename TOCTOU race that POSIX rename(2) silently lost by
   *  replacing destinations). Cross-device fallback (`EXDEV`) uses
   *  `fs.copyFile(..., COPYFILE_EXCL)` + `fs.unlink` for the same atomic
   *  guarantee. The overwrite=true path keeps plain `fs.rename` since the
   *  caller opted into replacement. Refuses if source missing, target exists
   *  (unless overwrite), either path traverses, or the target sits behind a
   *  symlink that points outside the vault. Caller is responsible for
   *  rewriting wikilinks pointing at the old name (see {@link renameNote}
   *  in `src/tools/write.ts` for the orchestration).
   *
   *  v3.7.16 P1-6 — destination privacy filter uses
   *  {@link canonicalRelForPrivacyCheck} (case-insensitive-FS bypass
   *  closure; parity with `writeNote`). */
  /**
   * v3.10.0-rc.61 (WRITE-3) — true iff `fromAbs`/`toAbs` differ only in case AND resolve to the
   * SAME physical file (same inode) — i.e. a case-only rename on a case-INSENSITIVE filesystem.
   * On a case-SENSITIVE FS the two are distinct files (toAbs is a different inode or absent) → false.
   */
  private async isSameInodeCaseRename(fromAbs: string, toAbs: string): Promise<boolean> {
    if (fromAbs === toAbs || fromAbs.toLowerCase() !== toAbs.toLowerCase()) return false;
    try {
      const [a, b] = await Promise.all([this.statSafe(fromAbs), this.statSafe(toAbs)]);
      return a.ino !== 0 && a.ino === b.ino;
    } catch {
      return false; // toAbs absent → a genuine new destination, not a same-file case rename
    }
  }

  async renameFile(
    fromRel: string,
    toRel: string,
    opts: { overwrite?: boolean } = {}
  ): Promise<{ from: string; to: string; mtimeMs: number }> {
    if (!this.writeEnabled) {
      throw new Error("Vault is read-only — start the server with --enable-write to allow rename");
    }
    if (!this.ready) await this.ensureExists();
    const fromAbs = await this.resolveSafePath(fromRel);
    const toRelNorm = toRel.toLowerCase().endsWith(".md") ? toRel : `${toRel}.md`;
    const toAbs = this.resolveInside(toRelNorm);
    await this.assertParentInsideVault(toAbs);
    // v2.0.0-beta.2 P1 fix: distinguish allowlist-vs-denylist same as
    // writeNote does, so users with --read-paths see the actual reason.
    // v3.7.16 P1-6 — case-insensitive bypass closure (same as writeNote).
    const toRelForFilter = await this.canonicalRelForPrivacyCheck(toAbs);
    if (this.isExcluded(toRelForFilter)) {
      const reason =
        this.readPathMatchers.length > 0 && !this.readPathMatchers.some((re) => re.test(toRelForFilter))
          ? "--read-paths allowlist (path doesn't match any allow-glob)"
          : "--exclude-glob denylist";
      throw new Error(`Refusing to rename — destination is excluded by ${reason}: ${toRelNorm}`);
    }
    const targetLstat = await fs.lstat(toAbs).catch(() => null);
    if (targetLstat?.isSymbolicLink()) {
      throw new Error(`Refusing to rename — destination is a symlink: ${path.relative(this.root, toAbs)}`);
    }
    await this.mkdirSafe(path.dirname(toAbs), { recursive: true });
    // v3.7.14 F2 — atomic exclusive-destination rename (parity with v3.7.13 M2).
    // Pre-3.7.14 we did `stat(toAbs)`-then-`rename(fromAbs, toAbs)`. POSIX
    // rename(2) silently REPLACES the destination if it exists, so between
    // a stat() returning ENOENT and the follow-up rename(), another process
    // could create the destination and our rename would clobber it without
    // honoring overwrite=false. Closes the same class of TOCTOU race that
    // M2 fixed for writeNote.
    //
    // The fix uses link()+unlink() for the non-overwrite path. link(2) fails
    // atomically with EEXIST when the destination exists — no stat-then-act
    // window. After successful link the source path is removed, leaving the
    // file at the new path with identical contents. For the overwrite path
    // we keep plain rename() since the user opted into replacement.
    if (opts.overwrite) {
      await this.renameSafe(fromAbs, toAbs);
    } else if (await this.isSameInodeCaseRename(fromAbs, toAbs)) {
      // v3.10.0-rc.61 (WRITE-3) — a case-only rename (Foo.md → foo.md) on a case-INSENSITIVE
      // FS (macOS APFS/HFS+, Windows NTFS) targets the SAME physical inode, so the linkSafe
      // path below would throw EEXIST → a misleading "Destination already exists". Use plain
      // rename, which performs the case change. (On a case-SENSITIVE FS this branch is never
      // taken — foo.md is a distinct file; absent → linkSafe creates it, present → real EEXIST.)
      await this.renameSafe(fromAbs, toAbs);
    } else {
      try {
        await this.linkSafe(fromAbs, toAbs);
      } catch (err) {
        if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "EEXIST") {
          throw new Error(`Destination already exists: ${toRelNorm} (pass overwrite=true to replace)`);
        }
        // EXDEV (cross-device link) is the realistic fallback: vault on a
        // bind-mount, source on the underlying fs. Fall back to atomic
        // copy-then-unlink with the wx flag.
        if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "EXDEV") {
          await this.copyFileSafe(fromAbs, toAbs, fsConstants.COPYFILE_EXCL);
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
    this.cache.delete(fromAbs);
    this.cache.delete(toAbs);
    const stat = await this.statSafe(toAbs);
    return {
      from: path.relative(this.root, fromAbs),
      to: path.relative(this.root, toAbs),
      mtimeMs: stat.mtimeMs
    };
  }

  /**
   * Append text to an existing note. Requires `enableWrite: true`.
   * Refuses if the resulting file would exceed the size cap.
   *
   * v3.7.14 F3 — the size-cap check is performed against the OPEN file
   * descriptor's `fstat`, not a separate `fs.stat(abs)` call before
   * `fs.appendFile`. Pre-3.7.14 the two-call pattern let parallel
   * writers race the cap: stat says `before.size + addition <= max`,
   * another process appends size Y between stat and our append, our
   * append takes the file past `max`. The post-3.7.14 single-fd pattern
   * keeps stat→write inside one kernel handle that another process
   * can't reposition.
   *
   * @param relOrAbs - Vault-relative or absolute target path.
   * @param addition - Text to append (UTF-8). Caller is responsible for
   *   including any leading newline.
   * @returns Metadata about the file after the append.
   * @throws {Error} If the vault is read-only or the appended file
   *   would exceed `maxFileBytes`.
   */
  async appendNote(
    relOrAbs: string,
    addition: string
  ): Promise<{ absPath: string; relPath: string; mtimeMs: number; appended_bytes: number }> {
    if (!this.writeEnabled) {
      throw new Error("Vault is read-only — start the server with --enable-write to allow note appends");
    }
    const abs = await this.resolveSafePath(relOrAbs);
    // v3.7.14 F3 — close the stat-then-append size-cap race. Pre-3.7.14
    // we did `stat(abs)` → check `before.size + addition <= maxFileBytes` →
    // `appendFile(abs, addition)`. Under parallel writes, the stat could
    // report size X, another process appended size Y between stat and our
    // appendFile, and our append took the file to X+Y+addition, possibly
    // past `maxFileBytes`. Now we open with `O_APPEND` ourselves, fstat
    // the open handle to get the current size, check the cap, write, and
    // close — keeping the stat→write window inside a single kernel-held
    // fd that another process can't reposition. fs.appendFile + open with
    // O_APPEND means subsequent writes are always atomic at the end of
    // file (POSIX append guarantee).
    const handle = await this.openSafe(abs, "a");
    let beforeSize = 0;
    try {
      const before = await handle.stat();
      beforeSize = before.size;
      if (before.size + Buffer.byteLength(addition, "utf8") > this.maxFileBytes) {
        throw new Error(`Refusing to grow ${path.relative(this.root, abs)} past ${this.maxFileBytes} bytes`);
      }
      await handle.write(addition, null, "utf8");
    } finally {
      await handle.close();
    }
    this.cache.delete(abs);
    const after = await this.statSafe(abs);
    return {
      absPath: abs,
      relPath: path.relative(this.root, abs),
      mtimeMs: after.mtimeMs,
      appended_bytes: after.size - beforeSize
    };
  }

  /** Drop every entry from the in-memory parse cache. Used after bulk
   *  changes (e.g. a full vault rebuild). Does NOT delete the on-disk
   *  cache file — call {@link clearDiskCache} for that. */
  invalidateCache(): void {
    this.cache.clear();
  }

  /** Drop a single cached note by absolute path. Used by the watcher when one
   *  file changes — full-cache clear would be wasteful for a 5k-note vault. */
  invalidateOne(absPath: string): void {
    this.cache.delete(absPath);
  }

  /**
   * Stat a vault file. Same path-safety as the read methods but no
   * size-cap check (callers may want to inspect oversized files'
   * metadata).
   *
   * @param relOrAbs - Vault-relative or absolute path.
   * @returns Modification time and byte size.
   */
  async stat(relOrAbs: string): Promise<{ mtimeMs: number; size: number }> {
    const abs = await this.resolveSafePath(relOrAbs);
    try {
      const s = await this.statSafe(abs);
      return { mtimeMs: s.mtimeMs, size: s.size };
    } catch (err) {
      throw this.sanitizeFsError(err); // rc.45 — M3: raw fs ENOENT embedded the abs path
    }
  }

  /** Convert an absolute path under the vault to a vault-relative one
   *  (POSIX-separated on all platforms). Does not verify the result
   *  stays inside the vault; callers needing that should use
   *  {@link resolveInside}. */
  toRel(abs: string): string {
    return path.relative(this.root, abs);
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
    // v2.0.0-beta.2 P1 sec DiD: pass `isExcluded` so a user with --read-paths
    // / --exclude-glob covering `.obsidian/**` doesn't get their plugin
    // config read against their wishes. Falls back to hard-coded defaults.
    this.periodicConfig = await loadPeriodicConfig(this.root, (rel) => this.isExcluded(rel));
    return this.periodicConfig;
  }

  private async resolveSafePath(relOrAbs: string): Promise<string> {
    if (!this.ready) await this.ensureExists();
    let abs: string;
    if (path.isAbsolute(relOrAbs)) {
      const realIn = await fs.realpath(relOrAbs).catch(() => relOrAbs);
      abs = realIn;
      const rel = path.relative(this.root, abs);
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        throw new Error(`Path escapes vault root: ${relOrAbs}`);
      }
    } else {
      abs = this.resolveInside(relOrAbs);
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
      if (this.isExcluded(norm)) {
        const reason =
          this.readPathMatchers.length > 0 && !this.readPathMatchers.some((re) => re.test(norm))
            ? "--read-paths allowlist (path doesn't match any allow-glob)"
            : "--exclude-glob denylist";
        throw new Error(`Path is excluded by ${reason}: ${rel}`);
      }
      return real;
    } catch (err) {
      if (isErrnoException(err) && err.code === "ENOENT") return abs;
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
        `File too large (${stat.size} bytes > limit ${this.maxFileBytes}): ${path.relative(this.root, abs)}`
      );
    }
  }

  private cacheSet(key: string, value: CachedNote): void {
    if (this.cache.size >= this.maxCacheEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, value);
    this.cacheDirty = true;
  }
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

interface DiskCacheEntry {
  relPath: string;
  mtimeMs: number;
  content: string;
  parsed: ParsedNote;
}

interface DiskCacheFile {
  version: number;
  root: string;
  writtenAt: string;
  entries: DiskCacheEntry[];
}

function defaultCacheFile(root: string): string {
  const base =
    process.env.XDG_CACHE_HOME ??
    (process.platform === "darwin" ? path.join(os.homedir(), "Library", "Caches") : path.join(os.homedir(), ".cache"));
  const hash = createHash("sha1").update(root).digest("hex").slice(0, 12);
  return path.join(base, "enquire", `${hash}.json`);
}

// v3.10.0-rc.44 (G2) — recursion-DEPTH bound for the vault walkers. Symlinks are already
// skipped (no cycle risk), but a pathologically deep REAL directory tree would drive
// unbounded recursion + readdir I/O BEFORE capScanEntries(MAX_SCAN_NOTES) — which only
// caps the RESULT array after the full tree is traversed — ever applies. 64 is far below
// any real vault's nesting yet bounds a hostile/accidental deep tree.
const MAX_WALK_DEPTH = 64;

async function walk(dir: string, root: string, out: FileEntry[], depth = 0): Promise<void> {
  if (depth > MAX_WALK_DEPTH) return;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    if (e.name.startsWith(".")) continue;
    if (e.isSymbolicLink()) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      const real = await fs.realpath(full).catch(() => null);
      if (!real) continue;
      const rel = path.relative(root, real);
      if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
      await walk(full, root, out, depth + 1);
    } else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) {
      const stat = await fs.stat(full).catch(() => null);
      if (!stat) continue;
      out.push({
        absPath: full,
        relPath: path.relative(root, full),
        basename: e.name,
        mtimeMs: stat.mtimeMs
      });
    }
  }
}

/** Generic walker — same skip rules as the markdown walker, but matches any
 *  file extension (lowercase). Used by listFilesByExtension(".canvas") etc. */
async function walkAnyExt(dir: string, root: string, out: FileEntry[], ext: string, depth = 0): Promise<void> {
  if (depth > MAX_WALK_DEPTH) return; // rc.44 G2 — bound recursion depth (see walk())
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    if (e.name.startsWith(".")) continue;
    if (e.isSymbolicLink()) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      const real = await fs.realpath(full).catch(() => null);
      if (!real) continue;
      const rel = path.relative(root, real);
      if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
      await walkAnyExt(full, root, out, ext, depth + 1);
    } else if (e.isFile() && e.name.toLowerCase().endsWith(ext)) {
      const stat = await fs.stat(full).catch(() => null);
      if (!stat) continue;
      out.push({
        absPath: full,
        relPath: path.relative(root, full),
        basename: e.name,
        mtimeMs: stat.mtimeMs
      });
    }
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
 * is now a NON-backtracking DP ({@link matchWildcardTokens}), NOT a `RegExp`. The
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
