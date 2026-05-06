import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type ParsedNote, parseNote } from "./parser.js";

const SKIP_DIRS = new Set([".git", ".obsidian", ".trash", "node_modules", ".DS_Store"]);

export const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
export const DEFAULT_MAX_CACHE_ENTRIES = 1024;

/** Bumped on any change to ParsedNote shape — invalidates persisted caches that don't match. */
const DISK_CACHE_VERSION = 1;
export const DEFAULT_MAX_DISK_CACHE_BYTES = 50 * 1024 * 1024;

export interface FileEntry {
  absPath: string;
  relPath: string;
  basename: string;
  mtimeMs: number;
}

export interface CachedNote {
  content: string;
  parsed: ParsedNote;
  mtimeMs: number;
}

export interface VaultOptions {
  maxFileBytes?: number;
  maxCacheEntries?: number;
  enableWrite?: boolean;
  persistentCache?: boolean;
  /** Override the cache file location. Default: ~/.cache/enquire/<vault-hash>.json. */
  cacheFile?: string;
  /** Refuse to read/write a cache file larger than this (default 50 MB). */
  maxDiskCacheBytes?: number;
  /** Glob patterns matched against vault-relative paths. Excluded paths never appear in
   *  listMarkdown(), and reads/writes against them throw. Privacy filter for users who
   *  point an LLM at a vault but want `02_Personal/**` invisible. */
  excludeGlobs?: string[];
}

export class Vault {
  root: string;
  readonly maxFileBytes: number;
  readonly maxCacheEntries: number;
  readonly writeEnabled: boolean;
  readonly persistentCacheEnabled: boolean;
  readonly maxDiskCacheBytes: number;
  readonly excludeGlobs: readonly string[];
  private excludeRegexes: RegExp[];
  cacheFile: string | null;
  private cache = new Map<string, CachedNote>();
  private cacheDirty = false;
  private ready = false;

  constructor(root: string, opts: VaultOptions = {}) {
    this.root = path.resolve(root);
    this.maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.maxCacheEntries = opts.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES;
    this.writeEnabled = opts.enableWrite ?? false;
    this.persistentCacheEnabled = opts.persistentCache ?? false;
    this.maxDiskCacheBytes = opts.maxDiskCacheBytes ?? DEFAULT_MAX_DISK_CACHE_BYTES;
    this.cacheFile = opts.cacheFile ?? null;
    this.excludeGlobs = Object.freeze([...(opts.excludeGlobs ?? [])]);
    this.excludeRegexes = this.excludeGlobs.map(globToRegex);
  }

  /** True if a vault-relative path matches any --exclude-glob pattern. */
  isExcluded(relPath: string): boolean {
    if (this.excludeRegexes.length === 0) return false;
    const norm = relPath.replace(/\\/g, "/");
    return this.excludeRegexes.some((re) => re.test(norm));
  }

  async ensureExists(): Promise<void> {
    if (this.ready) return;
    let stat: import("node:fs").Stats;
    try {
      stat = await fs.stat(this.root);
    } catch {
      throw new Error(`Vault not found: ${this.root}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`Vault path is not a directory: ${this.root}`);
    }
    this.root = await fs.realpath(this.root);
    if (this.persistentCacheEnabled && !this.cacheFile) {
      this.cacheFile = defaultCacheFile(this.root);
    }
    this.ready = true;
    if (this.persistentCacheEnabled) {
      await this.loadDiskCache();
    }
  }

  async loadDiskCache(): Promise<number> {
    if (!this.cacheFile) return 0;
    try {
      const stat = await fs.stat(this.cacheFile);
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
      raw = await fs.readFile(this.cacheFile, "utf8");
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
        try {
          const s = await fs.stat(abs);
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
    for (const result of checks) {
      if (result.kind === "drop") {
        dropped += 1;
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
    return loaded;
  }

  async clearDiskCache(): Promise<boolean> {
    if (!this.cacheFile) return false;
    try {
      await fs.unlink(this.cacheFile);
      this.cache.clear();
      this.cacheDirty = false;
      return true;
    } catch (err) {
      if (isErrnoException(err) && err.code === "ENOENT") return false;
      throw err;
    }
  }

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
    await fs.mkdir(cacheDir, { recursive: true, mode: 0o700 });
    // mkdir's mode option only applies on creation. If the directory already
    // existed (e.g. from a prior run with looser perms, or a custom --cache-file
    // path under XDG_CACHE_HOME), chmod brings it down to 0700 — matching the
    // privacy guarantee documented in README/SECURITY.md.
    await fs.chmod(cacheDir, 0o700).catch(() => {});
    const tmp = `${this.cacheFile}.tmp`;
    // mode 0o600 — full note bodies live here, treat as private to the user account.
    await fs.writeFile(tmp, serialized, { encoding: "utf8", mode: 0o600 });
    await fs.rename(tmp, this.cacheFile);
    // Defensive: rename preserves original mode if file existed; chmod ensures 0o600 either way.
    await fs.chmod(this.cacheFile, 0o600).catch(() => {});
    this.cacheDirty = false;
  }

  resolveInside(p: string): string {
    const abs = path.resolve(this.root, p);
    const rel = path.relative(this.root, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`Path escapes vault root: ${p}`);
    }
    return abs;
  }

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
    // Apply privacy filter — paths matching any --exclude-glob pattern are
    // omitted from the listing entirely. resolveSafePath also rejects them on
    // direct read/write, so the LLM has no way to reach excluded content.
    if (this.excludeRegexes.length > 0) {
      return out.filter((e) => !this.isExcluded(e.relPath.replace(/\\/g, "/")));
    }
    return out;
  }

  async readFile(relOrAbs: string): Promise<string> {
    const abs = await this.resolveSafePath(relOrAbs);
    await this.assertSize(abs);
    return fs.readFile(abs, "utf8");
  }

  async readNote(relOrAbs: string, knownMtimeMs?: number): Promise<CachedNote> {
    const abs = await this.resolveSafePath(relOrAbs);
    const mtimeMs = knownMtimeMs ?? (await fs.stat(abs)).mtimeMs;
    const cached = this.cache.get(abs);
    if (cached && cached.mtimeMs === mtimeMs) {
      // LRU bump: re-insert so this entry is "freshest"
      this.cache.delete(abs);
      this.cache.set(abs, cached);
      return cached;
    }
    await this.assertSize(abs);
    const content = await fs.readFile(abs, "utf8");
    const parsed = parseNote(content);
    const entry = { content, parsed, mtimeMs };
    this.cacheSet(abs, entry);
    return entry;
  }

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
    const targetRel = relPath.toLowerCase().endsWith(".md") ? relPath : `${relPath}.md`;
    const abs = this.resolveInside(targetRel);
    await this.assertParentInsideVault(abs);
    if (!opts.overwrite) {
      const exists = await fs
        .stat(abs)
        .then(() => true)
        .catch(() => false);
      if (exists) throw new Error(`Note already exists: ${targetRel} (pass overwrite=true to replace)`);
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await this.assertParentInsideVault(abs);
    // Refuse to write through a symlink. fs.writeFile follows the link and would
    // write to wherever it points — possibly outside the vault. assertParentInsideVault
    // only guards parent dirs; the leaf target itself is checked here.
    const targetLstat = await fs.lstat(abs).catch(() => null);
    if (targetLstat?.isSymbolicLink()) {
      throw new Error(`Refusing to write — target is a symlink: ${path.relative(this.root, abs)}`);
    }
    await fs.writeFile(abs, content, "utf8");
    this.cache.delete(abs);
    const stat = await fs.stat(abs);
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
          throw new Error(`Refusing to write — parent directory resolves outside vault: ${current}`);
        }
        break;
      }
      current = path.dirname(current);
    }
  }

  /** Rename a markdown file inside the vault. Atomic via fs.rename. Refuses if
   *  source missing, target exists (unless overwrite), either path traverses,
   *  or the target sits behind a symlink that points outside the vault. Caller
   *  is responsible for rewriting wikilinks pointing at the old name. */
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
    if (this.isExcluded(path.relative(this.root, toAbs))) {
      throw new Error(`Refusing to rename — destination matches an --exclude-glob pattern: ${toRelNorm}`);
    }
    if (!opts.overwrite) {
      const exists = await fs
        .stat(toAbs)
        .then(() => true)
        .catch(() => false);
      if (exists) throw new Error(`Destination already exists: ${toRelNorm} (pass overwrite=true to replace)`);
    }
    const targetLstat = await fs.lstat(toAbs).catch(() => null);
    if (targetLstat?.isSymbolicLink()) {
      throw new Error(`Refusing to rename — destination is a symlink: ${path.relative(this.root, toAbs)}`);
    }
    await fs.mkdir(path.dirname(toAbs), { recursive: true });
    await fs.rename(fromAbs, toAbs);
    this.cache.delete(fromAbs);
    this.cache.delete(toAbs);
    const stat = await fs.stat(toAbs);
    return {
      from: path.relative(this.root, fromAbs),
      to: path.relative(this.root, toAbs),
      mtimeMs: stat.mtimeMs
    };
  }

  async appendNote(
    relOrAbs: string,
    addition: string
  ): Promise<{ absPath: string; relPath: string; mtimeMs: number; appended_bytes: number }> {
    if (!this.writeEnabled) {
      throw new Error("Vault is read-only — start the server with --enable-write to allow note appends");
    }
    const abs = await this.resolveSafePath(relOrAbs);
    const before = await fs.stat(abs);
    if (before.size + Buffer.byteLength(addition, "utf8") > this.maxFileBytes) {
      throw new Error(`Refusing to grow ${path.relative(this.root, abs)} past ${this.maxFileBytes} bytes`);
    }
    await fs.appendFile(abs, addition, "utf8");
    this.cache.delete(abs);
    const after = await fs.stat(abs);
    return {
      absPath: abs,
      relPath: path.relative(this.root, abs),
      mtimeMs: after.mtimeMs,
      appended_bytes: after.size - before.size
    };
  }

  invalidateCache(): void {
    this.cache.clear();
  }

  async stat(relOrAbs: string): Promise<{ mtimeMs: number; size: number }> {
    const abs = await this.resolveSafePath(relOrAbs);
    const s = await fs.stat(abs);
    return { mtimeMs: s.mtimeMs, size: s.size };
  }

  toRel(abs: string): string {
    return path.relative(this.root, abs);
  }

  async findByTitle(title: string): Promise<FileEntry | null> {
    const norm = stripMdExt(title).toLowerCase();
    const all = await this.listMarkdown();
    return all.find((e) => stripMdExt(e.basename).toLowerCase() === norm) ?? null;
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
      const real = await fs.realpath(abs);
      const rel = path.relative(this.root, real);
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        throw new Error(`Resolved path escapes vault root: ${abs}`);
      }
      // Privacy filter — refuse to surface excluded content even via direct
      // read/write. Combined with listMarkdown filtering, the LLM has no
      // path into excluded files.
      if (this.isExcluded(rel.replace(/\\/g, "/"))) {
        throw new Error(`Path is excluded by --exclude-glob: ${rel}`);
      }
      return real;
    } catch (err) {
      if (isErrnoException(err) && err.code === "ENOENT") return abs;
      throw err;
    }
  }

  private async assertSize(abs: string): Promise<void> {
    const stat = await fs.stat(abs);
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

async function walk(dir: string, root: string, out: FileEntry[]): Promise<void> {
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
      await walk(full, root, out);
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

/**
 * Convert a minimal glob pattern to a RegExp anchored against vault-relative
 * paths (forward-slash separated). Supports:
 *   `*`   — any run of non-slash characters
 *   `**`  — any run of characters including slashes (globstar)
 *   `?`   — exactly one non-slash character
 * No bracket sets, no `!` negation, no `{a,b}` alternation. Patterns are
 * matched against the full vault-relative path (e.g. `02_Personal/Inbox/x.md`).
 */
export function globToRegex(glob: string): RegExp {
  let i = 0;
  let out = "^";
  while (i < glob.length) {
    const ch = glob[i];
    if (ch === "*") {
      // `**` means cross-segment (any chars), `*` means within-segment.
      if (glob[i + 1] === "*") {
        out += ".*";
        i += 2;
        // Eat a trailing `/` after `**` so `a/**/b` matches `a/b` too.
        if (glob[i] === "/") i += 1;
        continue;
      }
      out += "[^/]*";
      i += 1;
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      i += 1;
      continue;
    }
    // Escape regex specials.
    if (ch && /[.+^${}()|[\]\\]/.test(ch)) {
      out += `\\${ch}`;
      i += 1;
      continue;
    }
    out += ch ?? "";
    i += 1;
  }
  out += "$";
  return new RegExp(out);
}

function stripMdExt(name: string): string {
  return name.replace(/\.md$/i, "");
}
