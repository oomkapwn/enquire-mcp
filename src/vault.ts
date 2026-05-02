import { promises as fs } from "node:fs";
import * as path from "node:path";
import { parseNote, ParsedNote } from "./parser.js";

const SKIP_DIRS = new Set([
  ".git",
  ".obsidian",
  ".trash",
  "node_modules",
  ".DS_Store"
]);

export const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
export const DEFAULT_MAX_CACHE_ENTRIES = 1024;

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
}

export class Vault {
  root: string;
  readonly maxFileBytes: number;
  readonly maxCacheEntries: number;
  readonly writeEnabled: boolean;
  private cache = new Map<string, CachedNote>();
  private ready = false;

  constructor(root: string, opts: VaultOptions = {}) {
    this.root = path.resolve(root);
    this.maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.maxCacheEntries = opts.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES;
    this.writeEnabled = opts.enableWrite ?? false;
  }

  async ensureExists(): Promise<void> {
    let stat;
    try {
      stat = await fs.stat(this.root);
    } catch {
      throw new Error(`Vault not found: ${this.root}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`Vault path is not a directory: ${this.root}`);
    }
    this.root = await fs.realpath(this.root);
    this.ready = true;
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
    if (cached && cached.mtimeMs === mtimeMs) return cached;
    await this.assertSize(abs);
    const content = await fs.readFile(abs, "utf8");
    const parsed = parseNote(content);
    const entry = { content, parsed, mtimeMs };
    this.cacheSet(abs, entry);
    return entry;
  }

  async writeNote(relPath: string, content: string, opts: { overwrite?: boolean } = {}): Promise<{ absPath: string; relPath: string; mtimeMs: number; bytes: number }> {
    if (!this.writeEnabled) {
      throw new Error("Vault is read-only — start the server with --enable-write to allow note creation");
    }
    if (Buffer.byteLength(content, "utf8") > this.maxFileBytes) {
      throw new Error(`Refusing to write ${Buffer.byteLength(content, "utf8")} bytes (limit ${this.maxFileBytes})`);
    }
    const targetRel = relPath.toLowerCase().endsWith(".md") ? relPath : `${relPath}.md`;
    const abs = this.resolveInside(targetRel);
    if (!opts.overwrite) {
      const exists = await fs.stat(abs).then(() => true).catch(() => false);
      if (exists) throw new Error(`Note already exists: ${targetRel} (pass overwrite=true to replace)`);
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
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

  async appendNote(relOrAbs: string, addition: string): Promise<{ absPath: string; relPath: string; mtimeMs: number; appended_bytes: number }> {
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
    return all.find(e => stripMdExt(e.basename).toLowerCase() === norm) ?? null;
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
    } catch (err: any) {
      if (err && err.code === "ENOENT") return abs;
      throw err;
    }
  }

  private async assertSize(abs: string): Promise<void> {
    const stat = await fs.stat(abs);
    if (stat.size > this.maxFileBytes) {
      throw new Error(`File too large (${stat.size} bytes > limit ${this.maxFileBytes}): ${path.relative(this.root, abs)}`);
    }
  }

  private cacheSet(key: string, value: CachedNote): void {
    if (this.cache.size >= this.maxCacheEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, value);
  }

  private assertInside(abs: string): string {
    const rel = path.relative(this.root, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`Path escapes vault root: ${abs}`);
    }
    return abs;
  }
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
