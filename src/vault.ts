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
  /** Override the cache file location. Default: ~/.cache/obsidian-mcp/<vault-hash>.json. */
  cacheFile?: string;
}

export class Vault {
  root: string;
  readonly maxFileBytes: number;
  readonly maxCacheEntries: number;
  readonly writeEnabled: boolean;
  readonly persistentCacheEnabled: boolean;
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
    this.cacheFile = opts.cacheFile ?? null;
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
      const raw = await fs.readFile(this.cacheFile, "utf8");
      const data = JSON.parse(raw) as DiskCacheFile;
      if (data.version !== DISK_CACHE_VERSION || data.root !== this.root) return 0;
      let loaded = 0;
      for (const entry of data.entries) {
        if (this.cache.size >= this.maxCacheEntries) break;
        const abs = path.resolve(this.root, entry.relPath);
        try {
          const stat = await fs.stat(abs);
          if (stat.mtimeMs !== entry.mtimeMs) continue;
          this.cache.set(abs, { content: entry.content, parsed: entry.parsed, mtimeMs: entry.mtimeMs });
          loaded += 1;
        } catch {
          // File gone — skip.
        }
      }
      return loaded;
    } catch {
      return 0;
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
    await fs.mkdir(path.dirname(this.cacheFile), { recursive: true });
    const tmp = `${this.cacheFile}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(payload), "utf8");
    await fs.rename(tmp, this.cacheFile);
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
    }
    const out: FileEntry[] = [];
    await walk(start, this.root, out);
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
  return path.join(base, "obsidian-mcp", `${hash}.json`);
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

function stripMdExt(name: string): string {
  return name.replace(/\.md$/i, "");
}
