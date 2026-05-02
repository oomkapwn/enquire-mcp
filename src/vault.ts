import { promises as fs } from "node:fs";
import * as path from "node:path";

const SKIP_DIRS = new Set([
  ".git",
  ".obsidian",
  ".trash",
  "node_modules",
  ".DS_Store"
]);

export interface FileEntry {
  absPath: string;
  relPath: string;
  basename: string;
  mtimeMs: number;
}

export class Vault {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  async ensureExists(): Promise<void> {
    const stat = await fs.stat(this.root).catch(() => null);
    if (!stat || !stat.isDirectory()) {
      throw new Error(`Vault not found or not a directory: ${this.root}`);
    }
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
    const start = folder ? this.resolveInside(folder) : this.root;
    const out: FileEntry[] = [];
    await walk(start, this.root, out);
    return out;
  }

  async readFile(relOrAbs: string): Promise<string> {
    const abs = path.isAbsolute(relOrAbs) ? this.assertInside(relOrAbs) : this.resolveInside(relOrAbs);
    return fs.readFile(abs, "utf8");
  }

  async stat(relOrAbs: string): Promise<{ mtimeMs: number; size: number }> {
    const abs = path.isAbsolute(relOrAbs) ? this.assertInside(relOrAbs) : this.resolveInside(relOrAbs);
    const s = await fs.stat(abs);
    return { mtimeMs: s.mtimeMs, size: s.size };
  }

  private assertInside(abs: string): string {
    const rel = path.relative(this.root, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`Path escapes vault root: ${abs}`);
    }
    return abs;
  }

  toRel(abs: string): string {
    return path.relative(this.root, abs);
  }

  async findByTitle(title: string): Promise<FileEntry | null> {
    const norm = stripMdExt(title).toLowerCase();
    const all = await this.listMarkdown();
    return all.find(e => stripMdExt(e.basename).toLowerCase() === norm) ?? null;
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
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
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
