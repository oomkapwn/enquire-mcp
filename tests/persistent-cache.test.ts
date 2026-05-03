import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Vault } from "../src/vault.js";

let root: string;
let cacheFile: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mcp-disk-cache-"));
  cacheFile = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mcp-cache-")), "cache.json");
  await fs.writeFile(path.join(root, "Hello.md"), "---\ntags: [persistent]\n---\n\nHello body.\n");
  await fs.writeFile(path.join(root, "World.md"), "World note with [[Hello]].\n");
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(path.dirname(cacheFile), { recursive: true, force: true });
});

describe("persistent cache", () => {
  it("does nothing when persistentCache flag is off", async () => {
    const v = new Vault(root, { cacheFile });
    await v.ensureExists();
    await v.readNote(path.join(root, "Hello.md"));
    await v.saveDiskCache();
    const exists = await fs
      .stat(cacheFile)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  });

  it("writes cache to disk on saveDiskCache when enabled", async () => {
    const v = new Vault(root, { persistentCache: true, cacheFile });
    await v.ensureExists();
    await v.readNote(path.join(root, "Hello.md"));
    await v.readNote(path.join(root, "World.md"));
    await v.saveDiskCache();
    const stat = await fs.stat(cacheFile);
    expect(stat.size).toBeGreaterThan(0);
    const data = JSON.parse(await fs.readFile(cacheFile, "utf8"));
    expect(data.version).toBe(1);
    expect(data.entries.length).toBe(2);
    expect(data.entries.map((e: { relPath: string }) => e.relPath).sort()).toEqual(["Hello.md", "World.md"]);
  });

  it("reloads cache on next ensureExists when files unchanged", async () => {
    const v1 = new Vault(root, { persistentCache: true, cacheFile });
    await v1.ensureExists();
    await v1.readNote(path.join(root, "Hello.md"));
    await v1.saveDiskCache();

    const v2 = new Vault(root, { persistentCache: true, cacheFile });
    const loaded = await v2.loadDiskCache();
    // ensureExists is needed to set this.root to realpath; loadDiskCache called manually for assertion clarity.
    await v2.ensureExists();
    expect(loaded).toBeGreaterThanOrEqual(0);
    const internal = v2 as unknown as { cache: Map<string, unknown> };
    expect(internal.cache.size).toBeGreaterThanOrEqual(1);
  });

  it("invalidates an entry whose mtime changed since cache write", async () => {
    const v1 = new Vault(root, { persistentCache: true, cacheFile });
    await v1.ensureExists();
    await v1.readNote(path.join(root, "Hello.md"));
    await v1.saveDiskCache();

    // Change the file content + mtime.
    await new Promise((r) => setTimeout(r, 10));
    await fs.writeFile(path.join(root, "Hello.md"), "different content");

    const v2 = new Vault(root, { persistentCache: true, cacheFile });
    await v2.ensureExists();
    const internal = v2 as unknown as { cache: Map<string, unknown> };
    // Hello should NOT be in the cache (mtime mismatch).
    const helloKey = [...internal.cache.keys()].find((k) => String(k).endsWith("Hello.md"));
    expect(helloKey).toBeUndefined();
  });

  it("rejects cache file written for a different vault root", async () => {
    const v1 = new Vault(root, { persistentCache: true, cacheFile });
    await v1.ensureExists();
    await v1.readNote(path.join(root, "Hello.md"));
    await v1.saveDiskCache();

    // Hand-edit the cache file to claim a different root.
    const data = JSON.parse(await fs.readFile(cacheFile, "utf8"));
    data.root = "/some/other/vault";
    await fs.writeFile(cacheFile, JSON.stringify(data));

    const v2 = new Vault(root, { persistentCache: true, cacheFile });
    const loaded = await v2.loadDiskCache();
    expect(loaded).toBe(0);
  });

  it("rejects cache file with mismatched version", async () => {
    const v1 = new Vault(root, { persistentCache: true, cacheFile });
    await v1.ensureExists();
    await v1.readNote(path.join(root, "Hello.md"));
    await v1.saveDiskCache();

    const data = JSON.parse(await fs.readFile(cacheFile, "utf8"));
    data.version = 999;
    await fs.writeFile(cacheFile, JSON.stringify(data));

    const v2 = new Vault(root, { persistentCache: true, cacheFile });
    const loaded = await v2.loadDiskCache();
    expect(loaded).toBe(0);
  });

  it("ignores corrupt cache file gracefully", async () => {
    await fs.mkdir(path.dirname(cacheFile), { recursive: true });
    await fs.writeFile(cacheFile, "{not json");

    const v = new Vault(root, { persistentCache: true, cacheFile });
    const loaded = await v.loadDiskCache();
    expect(loaded).toBe(0);
    // Subsequent reads should still work fresh.
    await v.ensureExists();
    const note = await v.readNote(path.join(root, "Hello.md"));
    expect(note.content).toContain("Hello body");
  });

  it("writes cache file with 0600 mode (audit P2-2 privacy)", async () => {
    const v = new Vault(root, { persistentCache: true, cacheFile });
    await v.ensureExists();
    await v.readNote(path.join(root, "Hello.md"));
    await v.saveDiskCache();
    const stat = await fs.stat(cacheFile);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("re-saves cache after deleted-note entries are dropped on load (audit P2-2)", async () => {
    // Seed cache with 2 entries.
    const v1 = new Vault(root, { persistentCache: true, cacheFile });
    await v1.ensureExists();
    await v1.readNote(path.join(root, "Hello.md"));
    await v1.readNote(path.join(root, "World.md"));
    await v1.saveDiskCache();
    const beforeBody = await fs.readFile(cacheFile, "utf8");
    expect(beforeBody).toContain("Hello body");

    // Delete World.md from the vault.
    await fs.unlink(path.join(root, "World.md"));

    // New Vault loads cache, should drop World.md entry AND mark dirty.
    const v2 = new Vault(root, { persistentCache: true, cacheFile });
    await v2.ensureExists();
    await v2.saveDiskCache();
    const afterBody = await fs.readFile(cacheFile, "utf8");
    expect(afterBody).not.toContain("World note");
    expect(afterBody).toContain("Hello body");
  });

  it("clearDiskCache removes the cache file and in-memory cache", async () => {
    const v = new Vault(root, { persistentCache: true, cacheFile });
    await v.ensureExists();
    await v.readNote(path.join(root, "Hello.md"));
    await v.saveDiskCache();
    expect(
      await fs
        .stat(cacheFile)
        .then(() => true)
        .catch(() => false)
    ).toBe(true);
    const removed = await v.clearDiskCache();
    expect(removed).toBe(true);
    expect(
      await fs
        .stat(cacheFile)
        .then(() => true)
        .catch(() => false)
    ).toBe(false);
  });

  it("rejects relative-path traversal in cache entries (audit v0.7.2 P1)", async () => {
    // Craft a cache file with a relPath that escapes the vault. Even with a
    // valid mtime for the target, the entry must not pollute the in-memory cache.
    await fs.mkdir(path.dirname(cacheFile), { recursive: true });
    const v1 = new Vault(root, { persistentCache: true, cacheFile });
    await v1.ensureExists();
    const realRoot = v1.root;
    const hostsStat = await fs.stat("/etc/hosts").catch(() => null);
    if (!hostsStat) return; // /etc/hosts not readable on this CI
    const relToHosts = path.relative(realRoot, "/etc/hosts");
    const data = {
      version: 1,
      root: realRoot,
      writtenAt: new Date().toISOString(),
      entries: [
        {
          relPath: relToHosts,
          mtimeMs: hostsStat.mtimeMs,
          content: "INJECTED FROM /etc/hosts",
          parsed: { frontmatter: {}, body: "INJECTED", wikilinks: [], embeds: [], tags: [] }
        }
      ]
    };
    await fs.writeFile(cacheFile, JSON.stringify(data));

    const v2 = new Vault(root, { persistentCache: true, cacheFile });
    const loaded = await v2.loadDiskCache();
    expect(loaded).toBe(0);
    const internal = v2 as unknown as { cache: Map<string, unknown> };
    expect(internal.cache.size).toBe(0);
  });

  it("rejects absolute-path entries in cache (audit v0.7.2 P1)", async () => {
    await fs.mkdir(path.dirname(cacheFile), { recursive: true });
    const v1 = new Vault(root, { persistentCache: true, cacheFile });
    await v1.ensureExists();
    const data = {
      version: 1,
      root: v1.root,
      writtenAt: new Date().toISOString(),
      entries: [
        {
          relPath: "/etc/hosts",
          mtimeMs: 1,
          content: "INJECTED",
          parsed: { frontmatter: {}, body: "x", wikilinks: [], embeds: [], tags: [] }
        }
      ]
    };
    await fs.writeFile(cacheFile, JSON.stringify(data));

    const v2 = new Vault(root, { persistentCache: true, cacheFile });
    const loaded = await v2.loadDiskCache();
    expect(loaded).toBe(0);
  });

  it("rejects oversized cached content on load (audit P2-1)", async () => {
    // Write a cache file with a fake oversized entry.
    const big = "x".repeat(200);
    await fs.mkdir(path.dirname(cacheFile), { recursive: true });
    const v1 = new Vault(root, { persistentCache: true, cacheFile });
    await v1.ensureExists();
    const data = {
      version: 1,
      root: v1.root,
      writtenAt: new Date().toISOString(),
      entries: [
        {
          relPath: "Hello.md",
          mtimeMs: (await fs.stat(path.join(root, "Hello.md"))).mtimeMs,
          content: big,
          parsed: { frontmatter: {}, body: big, wikilinks: [], embeds: [], tags: [] }
        }
      ]
    };
    await fs.writeFile(cacheFile, JSON.stringify(data));

    // Load with stricter limit — entry must be dropped.
    const v2 = new Vault(root, { persistentCache: true, cacheFile, maxFileBytes: 50 });
    const loaded = await v2.loadDiskCache();
    expect(loaded).toBe(0);
  });
});
