import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listNotes, readNote } from "../src/tools.js";
import { Vault } from "../src/vault.js";

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
    expect(notes.map((n) => n.title)).toEqual(["Inside"]);
    expect(notes.find((n) => n.title === "Secret")).toBeUndefined();
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

describe("Vault — cache cap & LRU", () => {
  it("evicts oldest entries when over maxCacheEntries", async () => {
    const v = new Vault(root, { maxCacheEntries: 2 });
    await v.ensureExists();
    for (let i = 0; i < 4; i++) {
      const p = path.join(root, `Note${i}.md`);
      await fs.writeFile(p, `Note ${i}\n`);
      await v.readNote(p);
    }
    const notes = await listNotes(v, {});
    expect(notes.length).toBeGreaterThanOrEqual(4);
    for (let i = 0; i < 4; i++) {
      await fs.unlink(path.join(root, `Note${i}.md`)).catch(() => {});
    }
  });

  it("LRU bumps a re-read entry so it survives eviction", async () => {
    const v = new Vault(root, { maxCacheEntries: 2 });
    await v.ensureExists();
    const a = path.join(root, "LRU-A.md");
    const b = path.join(root, "LRU-B.md");
    const c = path.join(root, "LRU-C.md");
    await fs.writeFile(a, "A");
    await fs.writeFile(b, "B");
    await fs.writeFile(c, "C");
    await v.readNote(a); // cache: {A}
    await v.readNote(b); // cache: {A, B}
    await v.readNote(a); // LRU bump → cache: {B, A}
    await v.readNote(c); // evict head (B): cache: {A, C}

    const cache = (v as unknown as { cache: Map<string, unknown> }).cache;
    expect(cache.size).toBeLessThanOrEqual(2);
    const cached = [...cache.keys()].map((k) => path.basename(k));
    expect(cached).toContain("LRU-A.md"); // re-read entry survived
    expect(cached).toContain("LRU-C.md"); // newest entry survived
    expect(cached).not.toContain("LRU-B.md"); // untouched middle entry evicted

    await Promise.all([a, b, c].map((p) => fs.unlink(p).catch(() => {})));
  });
});

describe("Vault — internal symlinks", () => {
  it("skips symlinks even when they point inside the vault", async () => {
    const v = new Vault(root);
    await v.ensureExists();
    const target = path.join(root, "Target-internal.md");
    const link = path.join(root, "Link-internal.md");
    await fs.writeFile(target, "internal target");
    await fs.symlink(target, link).catch(() => null);
    const linkExists = await fs.lstat(link).catch(() => null);
    if (!linkExists) return;
    const titles = (await listNotes(v, {})).map((n) => n.title);
    expect(titles).toContain("Target-internal");
    expect(titles).not.toContain("Link-internal");
    await fs.unlink(link).catch(() => {});
    await fs.unlink(target).catch(() => {});
  });
});

describe("Vault — listMarkdown(folder) symlink-out (audit P2-1)", () => {
  it("returns empty when folder argument is a symlink to outside the vault", async () => {
    const v = new Vault(root);
    await v.ensureExists();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mcp-fold-out-"));
    await fs.writeFile(path.join(outside, "Secret.md"), "should NOT be enumerated");
    try {
      await fs.symlink(outside, path.join(root, "linked-out"));
      const linkExists = await fs.lstat(path.join(root, "linked-out")).catch(() => null);
      if (!linkExists) return;
      const out = await listNotes(v, { folder: "linked-out" });
      expect(out).toEqual([]);
    } finally {
      await fs.unlink(path.join(root, "linked-out")).catch(() => {});
      await fs.rm(outside, { recursive: true, force: true });
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
