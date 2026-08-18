import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  const invalidCacheAdmissionCases = [
    ["missing suffix", "cache.txt", /must end exactly in '\.json'/],
    ["uppercase suffix", "cache.JSON", /must end exactly in '\.json'/],
    ["trailing LF", "cache.json\n", /must end exactly in '\.json'/],
    ["feedback subclass", "cache.feedback.json", /reserved feedback or HNSW metadata namespace/],
    ["HNSW-meta subclass", "cache.hnsw.meta.json", /reserved feedback or HNSW metadata namespace/]
  ] as const;
  const cacheAdmissionRoutes = [
    {
      route: "constructor",
      admit: (file: string) => {
        new Vault(root, { cacheFile: file });
      }
    },
    {
      route: "writable cacheFile setter",
      admit: (file: string) => {
        const vault = new Vault(root);
        vault.cacheFile = file;
      }
    }
  ].flatMap(({ route, admit }) =>
    invalidCacheAdmissionCases.map(([shape, basename, message]) => ({ route, admit, shape, basename, message }))
  );

  it.each(cacheAdmissionRoutes)(
    "$route rejects $shape before filesystem work",
    async ({ admit, basename, message }) => {
      const absentParent = path.join(path.dirname(cacheFile), `invalid-${Buffer.from(basename).toString("hex")}`);
      expect(() => admit(path.join(absentParent, basename))).toThrow(message);
      await expect(fs.lstat(absentParent)).rejects.toMatchObject({ code: "ENOENT" });
    }
  );

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

  it("publishes a coherent cache generation without following a planted legacy temp symlink", async (ctx) => {
    const v = new Vault(root, { persistentCache: true, cacheFile });
    await v.ensureExists();
    await v.readNote(path.join(root, "Hello.md"));
    await v.readNote(path.join(root, "World.md"));

    // Causal symlink control: the historical deterministic `${cacheFile}.tmp`
    // publisher followed this leaf and overwrote the sentinel before renaming
    // the symlink onto the final cache path. The exclusive random publisher
    // must leave both the external bytes and final leaf identity untouched.
    const sentinel = path.join(path.dirname(cacheFile), "attacker-owned-sentinel.txt");
    await fs.writeFile(sentinel, "ATTACKER_SENTINEL");
    let plantedLegacyTempSymlink = false;
    try {
      await fs.symlink(sentinel, `${cacheFile}.tmp`, "file");
      plantedLegacyTempSymlink = true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES" || code === "ENOSYS") {
        return ctx.skip(`filesystem cannot create the symlink control (${code})`);
      }
      throw err;
    }

    await v.saveDiskCache();
    const stat = await fs.stat(cacheFile);
    expect(stat.size).toBeGreaterThan(0);
    const data = JSON.parse(await fs.readFile(cacheFile, "utf8"));
    expect(data.version).toBe(1);
    expect(data.entries.map((e: { relPath: string }) => e.relPath).sort()).toEqual(["Hello.md", "World.md"]);
    if (plantedLegacyTempSymlink) {
      expect(await fs.readFile(sentinel, "utf8")).toBe("ATTACKER_SENTINEL");
      expect((await fs.lstat(cacheFile)).isSymbolicLink()).toBe(false);
    }
  });

  it.each(["mid-snapshot invalidation"])("keeps the cache dirty after %s", async () => {
    const v = new Vault(root, { persistentCache: true, cacheFile });
    await v.ensureExists();
    const helloPath = path.join(root, "Hello.md");
    const canonicalHelloPath = await fs.realpath(helloPath);
    await v.readNote(helloPath);
    await v.readNote(path.join(root, "World.md"));

    // Capture must precede the first awaited snapshot proof. Otherwise this
    // invalidation is mistaken for part of the saved generation and a repair
    // save becomes a no-op.
    const realRealpath = fs.realpath.bind(fs);
    let releaseRealpath = (): void => {};
    let observeRealpath = (): void => {};
    const realpathGate = new Promise<void>((resolve) => {
      releaseRealpath = resolve;
    });
    const realpathObserved = new Promise<void>((resolve) => {
      observeRealpath = resolve;
    });
    let realpathBlocked = false;
    const realpathSpy = vi.spyOn(fs, "realpath").mockImplementation(async (candidate) => {
      if (!realpathBlocked && String(candidate) === canonicalHelloPath) {
        realpathBlocked = true;
        observeRealpath();
        await realpathGate;
      }
      return realRealpath(candidate);
    });
    try {
      const firstSave = v.saveDiskCache();
      await realpathObserved;
      v.invalidateOne(canonicalHelloPath);
      releaseRealpath();
      await firstSave;
    } finally {
      releaseRealpath();
      realpathSpy.mockRestore();
    }

    const firstGeneration = JSON.parse(await fs.readFile(cacheFile, "utf8"));
    expect(firstGeneration.entries.map((e: { relPath: string }) => e.relPath)).toContain("Hello.md");
    await v.saveDiskCache();
    const repairedGeneration = JSON.parse(await fs.readFile(cacheFile, "utf8"));
    expect(repairedGeneration.entries.map((e: { relPath: string }) => e.relPath)).toEqual(["World.md"]);
  });

  it.each(["older rename blocked"])("serializes concurrent cache generations with %s", async () => {
    const v = new Vault(root, { persistentCache: true, cacheFile });
    await v.ensureExists();
    await v.readNote(path.join(root, "Hello.md"));
    await v.readNote(path.join(root, "World.md"));

    const realRename = fs.rename.bind(fs);
    let releaseRename = (): void => {};
    let observeRename = (): void => {};
    const renameGate = new Promise<void>((resolve) => {
      releaseRename = resolve;
    });
    const renameObserved = new Promise<void>((resolve) => {
      observeRename = resolve;
    });
    let finalRenameCount = 0;
    const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(to) === cacheFile) {
        finalRenameCount += 1;
        if (finalRenameCount === 1) {
          observeRename();
          await renameGate;
        }
      }
      await realRename(from, to);
    });
    const internals = v as unknown as { saveDiskCacheOnce(file: string): Promise<void> };
    const realSaveOnce = internals.saveDiskCacheOnce.bind(v);
    let saveOnceStarts = 0;
    const saveOnceSpy = vi.spyOn(internals, "saveDiskCacheOnce").mockImplementation(async (file) => {
      saveOnceStarts += 1;
      await realSaveOnce(file);
    });
    try {
      const older = v.saveDiskCache();
      await renameObserved;
      const latePath = path.join(root, "Late.md");
      await fs.writeFile(latePath, "late generation body\n");
      await v.readNote(latePath);
      const newer = v.saveDiskCache();
      await Promise.resolve();
      expect(saveOnceStarts, "newer cache generation must wait behind the blocked older rename").toBe(1);
      releaseRename();
      await Promise.all([older, newer]);
    } finally {
      releaseRename();
      renameSpy.mockRestore();
      saveOnceSpy.mockRestore();
    }

    expect(finalRenameCount).toBe(2);
    const data = JSON.parse(await fs.readFile(cacheFile, "utf8"));
    expect(data.entries.map((e: { relPath: string }) => e.relPath).sort()).toEqual(["Hello.md", "Late.md", "World.md"]);
  });

  it.each(["retarget while the snapshot is blocked"])(
    "binds an in-flight save and its queued clear to cache A across %s",
    async () => {
      const cacheA = cacheFile;
      const cacheB = path.join(path.dirname(cacheA), "retarget-b.json");
      await fs.writeFile(cacheB, "CACHE_B_SENTINEL");
      const v = new Vault(root, { persistentCache: true, cacheFile: cacheA });
      await v.ensureExists();
      const hello = await fs.realpath(path.join(root, "Hello.md"));
      await v.readNote(hello);

      const realRealpath = fs.realpath.bind(fs);
      let releaseSnapshot = (): void => {};
      let observeSnapshot = (): void => {};
      const snapshotGate = new Promise<void>((resolve) => {
        releaseSnapshot = resolve;
      });
      const snapshotObserved = new Promise<void>((resolve) => {
        observeSnapshot = resolve;
      });
      let blocked = false;
      const renameTargets: string[] = [];
      const unlinkTargets: string[] = [];
      const realRename = fs.rename.bind(fs);
      const realUnlink = fs.unlink.bind(fs);
      const realpathSpy = vi.spyOn(fs, "realpath").mockImplementation(async (candidate) => {
        if (!blocked && String(candidate) === hello) {
          blocked = true;
          observeSnapshot();
          await snapshotGate;
        }
        return realRealpath(candidate);
      });
      const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
        renameTargets.push(String(to));
        await realRename(from, to);
      });
      const unlinkSpy = vi.spyOn(fs, "unlink").mockImplementation(async (candidate) => {
        unlinkTargets.push(String(candidate));
        await realUnlink(candidate);
      });
      try {
        const saveA = v.saveDiskCache();
        await snapshotObserved;
        const clearA = v.clearDiskCache();
        v.cacheFile = cacheB;
        releaseSnapshot();
        await Promise.all([saveA, clearA]);

        expect(renameTargets).toContain(cacheA);
        expect(renameTargets).not.toContain(cacheB);
        expect(unlinkTargets).toContain(cacheA);
        expect(unlinkTargets).not.toContain(cacheB);
        await expect(fs.lstat(cacheA)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await fs.readFile(cacheB, "utf8")).toBe("CACHE_B_SENTINEL");

        await v.saveDiskCache();
        expect(renameTargets).toContain(cacheB);
        const publishedB = JSON.parse(await fs.readFile(cacheB, "utf8"));
        expect(publishedB.entries.map((entry: { relPath: string }) => entry.relPath)).toEqual(["Hello.md"]);
      } finally {
        releaseSnapshot();
        realpathSpy.mockRestore();
        renameSpy.mockRestore();
        unlinkSpy.mockRestore();
      }
    }
  );

  it.each(["retarget away, mutate, and retarget back"])(
    "does not let a queued clear erase a newer cache epoch after %s",
    async () => {
      const cacheA = cacheFile;
      const cacheB = path.join(path.dirname(cacheA), "retarget-epoch-b.json");
      const v = new Vault(root, { persistentCache: true, cacheFile: cacheA });
      await v.ensureExists();
      const hello = await fs.realpath(path.join(root, "Hello.md"));
      await v.readNote(hello);

      const realRealpath = fs.realpath.bind(fs);
      let releaseSnapshot = (): void => {};
      let observeSnapshot = (): void => {};
      const snapshotGate = new Promise<void>((resolve) => {
        releaseSnapshot = resolve;
      });
      const snapshotObserved = new Promise<void>((resolve) => {
        observeSnapshot = resolve;
      });
      let blocked = false;
      const realpathSpy = vi.spyOn(fs, "realpath").mockImplementation(async (candidate) => {
        if (!blocked && String(candidate) === hello) {
          blocked = true;
          observeSnapshot();
          await snapshotGate;
        }
        return realRealpath(candidate);
      });
      try {
        const saveA = v.saveDiskCache();
        await snapshotObserved;
        const clearA = v.clearDiskCache();
        v.cacheFile = cacheB;
        const late = path.join(root, "Late.md");
        await fs.writeFile(late, "late generation body\n");
        await v.readNote(late);
        v.cacheFile = cacheA;
        releaseSnapshot();
        await Promise.all([saveA, clearA]);

        await expect(fs.lstat(cacheA)).rejects.toMatchObject({ code: "ENOENT" });
        await v.saveDiskCache();
        const repairedA = JSON.parse(await fs.readFile(cacheA, "utf8"));
        expect(repairedA.entries.map((entry: { relPath: string }) => entry.relPath).sort()).toEqual([
          "Hello.md",
          "Late.md"
        ]);
        await expect(fs.lstat(cacheB)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        releaseSnapshot();
        realpathSpy.mockRestore();
      }
    }
  );

  it.each(["cached LRU hit during clear preflight"])("clears the prior memory generation after a %s", async () => {
    const v = new Vault(root, { persistentCache: true, cacheFile });
    await v.ensureExists();
    const hello = await fs.realpath(path.join(root, "Hello.md"));
    await v.readNote(hello);
    await v.saveDiskCache();
    const internals = v as unknown as { cache: Map<string, unknown>; cacheDirty: boolean };
    expect(internals.cache.size).toBe(1);
    expect(internals.cacheDirty).toBe(false);

    const realLstat = fs.lstat.bind(fs);
    let releasePreflight = (): void => {};
    let observePreflight = (): void => {};
    const preflightGate = new Promise<void>((resolve) => {
      releasePreflight = resolve;
    });
    const preflightObserved = new Promise<void>((resolve) => {
      observePreflight = resolve;
    });
    let blocked = false;
    const lstatSpy = vi.spyOn(fs, "lstat").mockImplementation(async (candidate) => {
      if (!blocked && String(candidate) === cacheFile) {
        blocked = true;
        observePreflight();
        await preflightGate;
      }
      return realLstat(candidate);
    });
    let removed = false;
    try {
      const clear = v.clearDiskCache();
      await preflightObserved;
      await v.readNote(hello);
      releasePreflight();
      removed = await clear;
    } finally {
      releasePreflight();
      lstatSpy.mockRestore();
    }

    expect(removed).toBe(true);
    expect(internals.cache.size).toBe(0);
    expect(internals.cacheDirty).toBe(false);
    await expect(fs.lstat(cacheFile)).rejects.toMatchObject({ code: "ENOENT" });

    await v.readNote(hello);
    expect(internals.cacheDirty).toBe(true);
    await v.saveDiskCache();
    const republished = JSON.parse(await fs.readFile(cacheFile, "utf8"));
    expect(republished.entries.map((entry: { relPath: string }) => entry.relPath)).toEqual(["Hello.md"]);
  });

  it.each(["same exact path"])("does not create a cache generation when the setter receives the %s", async () => {
    const v = new Vault(root, { persistentCache: true, cacheFile });
    await v.ensureExists();
    await v.readNote(path.join(root, "Hello.md"));
    await v.saveDiskCache();
    const before = await fs.readFile(cacheFile, "utf8");
    const internals = v as unknown as { saveDiskCacheOnce(file: string): Promise<void> };
    const saveOnceSpy = vi.spyOn(internals, "saveDiskCacheOnce");
    try {
      v.cacheFile = cacheFile;
      await v.saveDiskCache();
      expect(saveOnceSpy).not.toHaveBeenCalled();
      expect(await fs.readFile(cacheFile, "utf8")).toBe(before);
    } finally {
      saveOnceSpy.mockRestore();
    }
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

  it("requests a private fresh parent, preserves an existing 0750 parent, and publishes cache mode 0600", async () => {
    const freshFile = path.join(path.dirname(cacheFile), "fresh", "nested", "cache.json");
    const fresh = new Vault(root, { persistentCache: true, cacheFile: freshFile });
    await fresh.ensureExists();
    await fresh.readNote(path.join(root, "Hello.md"));
    await fresh.saveDiskCache();
    expect((await fs.stat(path.dirname(freshFile))).mode & 0o077).toBe(0); // umask may tighten 0700
    expect((await fs.stat(freshFile)).mode & 0o777).toBe(0o600);

    const existingParent = path.join(path.dirname(cacheFile), "operator-managed-cache-parent");
    await fs.mkdir(existingParent, { mode: 0o750 });
    await fs.chmod(existingParent, 0o750);
    const existingFile = path.join(existingParent, "cache.json");
    const existing = new Vault(root, { persistentCache: true, cacheFile: existingFile });
    await existing.ensureExists();
    await existing.readNote(path.join(root, "World.md"));
    await existing.saveDiskCache();
    expect((await fs.stat(existingParent)).mode & 0o777).toBe(0o750);
    expect((await fs.stat(existingFile)).mode & 0o777).toBe(0o600);
  });

  it("re-saves cache after deleted or restricted entries are dropped on load (audit P2-2)", async () => {
    // Seed cache with three entries.
    const v1 = new Vault(root, { persistentCache: true, cacheFile });
    await v1.ensureExists();
    await v1.readNote(path.join(root, "Hello.md"));
    await v1.readNote(path.join(root, "World.md"));
    const directoryReplacementPath = path.join(root, "Directory.md");
    await fs.writeFile(directoryReplacementPath, "directory-shaped stale body");
    await v1.readNote(directoryReplacementPath);
    await v1.saveDiskCache();
    const beforeBody = await fs.readFile(cacheFile, "utf8");
    expect(beforeBody).toContain("Hello body");

    // A body that was public when read must not be persisted after the source
    // is moved under a hidden name before the next flush.
    const transientPath = path.join(root, "Transient.md");
    await fs.writeFile(transientPath, "transient body must be dropped");
    await v1.readNote(transientPath);
    await fs.rename(transientPath, path.join(root, ".Transient.md"));
    await v1.saveDiskCache();
    expect(await fs.readFile(cacheFile, "utf8")).not.toContain("transient body must be dropped");
    const liveCache = v1 as unknown as { cache: Map<string, unknown> };
    expect([...liveCache.cache.keys()].some((key) => key.endsWith("Transient.md"))).toBe(false);

    // Simulate a cache written by an older release that admitted a hidden
    // path. The source exists and every cache field is otherwise valid, so
    // only the central vault visibility policy can reject this entry.
    const hiddenPath = path.join(root, ".secret.md");
    await fs.writeFile(hiddenPath, "hidden cached body");
    const hiddenStat = await fs.stat(hiddenPath);
    const crafted = JSON.parse(beforeBody);
    await fs.unlink(directoryReplacementPath);
    await fs.mkdir(directoryReplacementPath);
    const replacementDirectoryStat = await fs.stat(directoryReplacementPath);
    const directoryEntry = crafted.entries.find((entry: { relPath: string }) => entry.relPath === "Directory.md");
    if (!directoryEntry) throw new Error("Directory.md cache fixture is missing");
    directoryEntry.mtimeMs = replacementDirectoryStat.mtimeMs;
    crafted.entries.push({
      relPath: ".secret.md",
      mtimeMs: hiddenStat.mtimeMs,
      content: "hidden cached body",
      parsed: { frontmatter: {}, body: "hidden cached body", wikilinks: [], embeds: [], tags: [] }
    });
    await fs.writeFile(cacheFile, JSON.stringify(crafted));

    // Delete World.md from the vault.
    await fs.unlink(path.join(root, "World.md"));

    // New Vault loads cache, should drop World.md entry AND mark dirty.
    const v2 = new Vault(root, { persistentCache: true, cacheFile });
    await v2.ensureExists();
    await v2.saveDiskCache();
    const afterBody = await fs.readFile(cacheFile, "utf8");
    expect(afterBody).not.toContain("World note");
    expect(afterBody).not.toContain("hidden cached body");
    expect(afterBody).not.toContain("directory-shaped stale body");
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
