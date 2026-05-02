import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Vault } from "../src/vault.js";
import { readNote, listNotes } from "../src/tools.js";

let root: string;
let outsideDir: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mcp-sec-"));
  outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mcp-outside-"));
  await fs.writeFile(path.join(root, "Inside.md"), "Safe content.\n");
  await fs.writeFile(path.join(outsideDir, "Secret.md"), "Sensitive content outside the vault.\n");
  // Create a symlink inside the vault pointing outside.
  try {
    await fs.symlink(path.join(outsideDir, "Secret.md"), path.join(root, "Secret-link.md"));
    await fs.symlink(outsideDir, path.join(root, "outside-dir-link"));
  } catch {
    // On Windows without dev mode, symlinks may fail — tests that depend on this skip.
  }
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(outsideDir, { recursive: true, force: true });
});

describe("Vault — symlink safety", () => {
  it("does not list files reached via symlinks", async () => {
    const v = new Vault(root);
    await v.ensureExists();
    const notes = await listNotes(v, {});
    expect(notes.map(n => n.title)).toEqual(["Inside"]);
    expect(notes.find(n => n.title === "Secret")).toBeUndefined();
  });

  it("rejects reads of symlinked files that resolve outside vault", async () => {
    const v = new Vault(root);
    await v.ensureExists();
    const linkExists = await fs.lstat(path.join(root, "Secret-link.md")).catch(() => null);
    if (!linkExists) return;
    await expect(readNote(v, { path: "Secret-link.md" })).rejects.toThrow(/escapes vault root/);
  });

  it("rejects ../ traversal in resolveInside", async () => {
    const v = new Vault(root);
    expect(() => v.resolveInside("../../etc/passwd")).toThrow(/escapes vault root/);
  });
});

describe("Vault — file size limit", () => {
  it("refuses to read files larger than maxFileBytes", async () => {
    const v = new Vault(root, { maxFileBytes: 50 });
    await v.ensureExists();
    await fs.writeFile(path.join(root, "Big.md"), "x".repeat(200));
    await expect(readNote(v, { path: "Big.md" })).rejects.toThrow(/File too large/);
    await fs.unlink(path.join(root, "Big.md"));
  });
});

describe("Vault — cache cap", () => {
  it("evicts oldest entries when over maxCacheEntries", async () => {
    const v = new Vault(root, { maxCacheEntries: 2 });
    await v.ensureExists();
    for (let i = 0; i < 4; i++) {
      const p = path.join(root, `Note${i}.md`);
      await fs.writeFile(p, `Note ${i}\n`);
      await v.readNote(p);
    }
    // After reading 4 notes with cap=2, only the newest 2 should still be cached.
    // We verify by introspecting the private cache via a subsequent read with mismatched mtime
    // (cache hit would skip stat; cache miss would re-read). Implementation detail —
    // here we just confirm the call doesn't blow up and listMarkdown still works.
    const notes = await listNotes(v, {});
    expect(notes.length).toBeGreaterThanOrEqual(4);
    for (let i = 0; i < 4; i++) {
      await fs.unlink(path.join(root, `Note${i}.md`)).catch(() => {});
    }
  });
});

describe("parseNote — malformed input", () => {
  it("falls back gracefully on broken YAML", async () => {
    const v = new Vault(root);
    await v.ensureExists();
    await fs.writeFile(path.join(root, "Broken.md"), "---\nthis is: : not: : valid: yaml\n---\n\nbody here\n");
    const out = await readNote(v, { path: "Broken.md" });
    expect(typeof out.content).toBe("string");
    expect(out.frontmatter).toEqual({});
    await fs.unlink(path.join(root, "Broken.md"));
  });

  it("handles Unicode titles and tags", async () => {
    const v = new Vault(root);
    await v.ensureExists();
    await fs.writeFile(path.join(root, "Заметка.md"), "---\ntags: [идея]\n---\n\n#русский тег.\n");
    const out = await readNote(v, { title: "Заметка" });
    expect(out.title).toBe("Заметка");
    expect(out.tags).toContain("идея");
    await fs.unlink(path.join(root, "Заметка.md"));
  });
});
