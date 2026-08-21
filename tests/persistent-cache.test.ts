import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Vault } from "../src/vault.js";

let root: string;
let cacheFile: string;
const openedVaults = new Set<Vault>();
const SOURCE_RECEIPT_FIELDS = ["dev", "ino", "size", "mtimeMs", "ctimeMs"] as const;
type SourceReceiptField = (typeof SOURCE_RECEIPT_FIELDS)[number];

function trackedVault(...args: ConstructorParameters<typeof Vault>): Vault {
  const vault = new Vault(...args);
  openedVaults.add(vault);
  return vault;
}

function persistedSourceReceipt(stat: import("node:fs").Stats): Record<string, number> {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs
  };
}

function differentReceiptValue(value: number): number {
  return value === 0 ? 1 : value - 1;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mcp-disk-cache-"));
  const cacheDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mcp-cache-"));
  cacheFile = path.join(await fs.realpath(cacheDirectory), "cache.json");
  await fs.writeFile(path.join(root, "Hello.md"), "---\ntags: [persistent]\n---\n\nHello body.\n");
  await fs.writeFile(path.join(root, "World.md"), "World note with [[Hello]].\n");
});

afterEach(async () => {
  await Promise.allSettled([...openedVaults].map((vault) => vault.closePersistence()));
  openedVaults.clear();
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
        trackedVault(root, { cacheFile: file });
      }
    },
    {
      route: "writable cacheFile setter",
      admit: (file: string) => {
        const vault = trackedVault(root);
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
    const v = trackedVault(root, { cacheFile });
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
    const v = trackedVault(root, { persistentCache: true, cacheFile });
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
    expect(data.version).toBe(2);
    expect(data.entries.map((e: { relPath: string }) => e.relPath).sort()).toEqual(["Hello.md", "World.md"]);
    if (plantedLegacyTempSymlink) {
      expect(await fs.readFile(sentinel, "utf8")).toBe("ATTACKER_SENTINEL");
      expect((await fs.lstat(cacheFile)).isSymbolicLink()).toBe(false);
    }
  });

  it("erases the older disk generation and rejects when a replacement exceeds the byte cap", async () => {
    const vault = trackedVault(root, { persistentCache: true, cacheFile });
    await vault.ensureExists();
    await vault.readNote(path.join(root, "Hello.md"));
    await vault.saveDiskCache();
    expect(await fs.readFile(cacheFile, "utf8")).toContain("Hello body.");

    await vault.readNote(path.join(root, "World.md"));
    const byteLengthSpy = vi.spyOn(Buffer, "byteLength").mockImplementationOnce(() => 50 * 1024 * 1024 + 1);
    try {
      await expect(vault.saveDiskCache()).rejects.toThrow(/snapshot exceeds the configured byte cap/i);
    } finally {
      byteLengthSpy.mockRestore();
    }

    await expect(fs.lstat(cacheFile)).rejects.toMatchObject({ code: "ENOENT" });
    const internals = vault as unknown as { cacheDirty: boolean; cache: Map<string, unknown> };
    expect(internals.cacheDirty).toBe(true);
    expect([...internals.cache.keys()].map((entry) => path.basename(entry)).sort()).toEqual(["Hello.md", "World.md"]);
  });

  it("captures cache entry identities without cloning the full parsed graph at save admission", async () => {
    const vault = trackedVault(root, { persistentCache: true, cacheFile });
    await vault.ensureExists();
    await vault.readNote(path.join(root, "Hello.md"));
    const cloneSpy = vi.spyOn(globalThis, "structuredClone");
    try {
      await vault.saveDiskCache();
      expect(cloneSpy).not.toHaveBeenCalled();
    } finally {
      cloneSpy.mockRestore();
    }
  });

  it("bounds cache-save requests retained behind a blocked publisher", async () => {
    const vault = trackedVault(root, { persistentCache: true, cacheFile });
    await vault.ensureExists();
    await vault.readNote(path.join(root, "Hello.md"));
    const internals = vault as unknown as {
      pendingCacheSaveRequests: number;
      saveDiskCacheOnce(request: unknown): Promise<void>;
    };
    const realSaveOnce = internals.saveDiskCacheOnce.bind(vault);
    let releaseFirst = (): void => {};
    let observeFirst = (): void => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstObserved = new Promise<void>((resolve) => {
      observeFirst = resolve;
    });
    let calls = 0;
    const saveSpy = vi.spyOn(internals, "saveDiskCacheOnce").mockImplementation(async (request) => {
      calls += 1;
      if (calls === 1) {
        observeFirst();
        await firstGate;
      }
      await realSaveOnce(request);
    });
    const accepted: Array<Promise<void>> = [];
    try {
      accepted.push(vault.saveDiskCache());
      await firstObserved;
      for (let index = 1; index < 8; index += 1) accepted.push(vault.saveDiskCache());
      expect(internals.pendingCacheSaveRequests).toBe(8);
      await expect(vault.saveDiskCache()).rejects.toThrow(/too many pending persistent-cache saves.*limit 8/i);
      expect(internals.pendingCacheSaveRequests).toBe(8);
      releaseFirst();
      await Promise.all(accepted);
      expect(internals.pendingCacheSaveRequests).toBe(0);
    } finally {
      releaseFirst();
      await Promise.allSettled(accepted);
      saveSpy.mockRestore();
    }
  });

  it("persists deep-equal but identity-distinct frontmatter objects", async () => {
    const vault = trackedVault(root, { persistentCache: true, cacheFile });
    await vault.ensureExists();
    await vault.readNote(path.join(root, "Hello.md"));
    const internals = vault as unknown as {
      cache: Map<string, { parsed: { frontmatter: Record<string, unknown> } }>;
    };
    const cached = [...internals.cache.values()][0];
    if (!cached) throw new Error("frontmatter identity fixture is missing");
    cached.parsed.frontmatter = { left: { marker: "DISTINCT_OK" }, right: { marker: "DISTINCT_OK" } };

    await vault.saveDiskCache();
    const raw = await fs.readFile(cacheFile, "utf8");
    expect(raw.match(/DISTINCT_OK/g)).toHaveLength(2);
  });

  it.each(["shared alias DAG", "self-cycle"] as const)("omits a %s instead of expanding or throwing", async (shape) => {
    const vault = trackedVault(root, { persistentCache: true, cacheFile });
    await vault.ensureExists();
    await vault.readNote(path.join(root, "Hello.md"));
    const internals = vault as unknown as {
      cache: Map<string, { parsed: { frontmatter: Record<string, unknown> } }>;
    };
    const cached = [...internals.cache.values()][0];
    if (!cached) throw new Error("frontmatter graph fixture is missing");
    const shared: Record<string, unknown> = { marker: "UNSAFE_GRAPH_MARKER" };
    cached.parsed.frontmatter =
      shape === "shared alias DAG" ? { left: shared, right: shared } : Object.assign(shared, { self: shared });

    await expect(vault.saveDiskCache()).resolves.toBeUndefined();
    const raw = await fs.readFile(cacheFile, "utf8");
    expect(raw).not.toContain("UNSAFE_GRAPH_MARKER");
    expect((JSON.parse(raw) as { entries: unknown[] }).entries).toEqual([]);
  });

  it.each([
    [63, true],
    [64, false]
  ] as const)(
    "admits exactly the bounded JSON object-depth side of %i nested frontmatter objects",
    async (objects, admitted) => {
      const vault = trackedVault(root, { persistentCache: true, cacheFile });
      await vault.ensureExists();
      await vault.readNote(path.join(root, "Hello.md"));
      const internals = vault as unknown as {
        cache: Map<string, { parsed: { frontmatter: Record<string, unknown> } }>;
      };
      const cached = [...internals.cache.values()][0];
      if (!cached) throw new Error("frontmatter depth fixture is missing");
      let nested: Record<string, unknown> = { marker: "DEPTH_BOUNDARY" };
      for (let index = 1; index < objects; index += 1) nested = { child: nested };
      cached.parsed.frontmatter = nested;

      await vault.saveDiskCache();
      const raw = await fs.readFile(cacheFile, "utf8");
      expect(raw.includes("DEPTH_BOUNDARY")).toBe(admitted);
    }
  );

  it("enforces the disk-cache cap in exact UTF-8 bytes at N and N-1", async () => {
    const unicodeFile = path.join(root, "Unicode.md");
    await fs.writeFile(unicodeFile, 'Привет 🙂 "\\\n\t\u0001\n');
    const seedFile = path.join(path.dirname(cacheFile), "utf8-seed.json");
    const seed = trackedVault(root, { persistentCache: true, cacheFile: seedFile });
    await seed.ensureExists();
    await seed.readNote(unicodeFile);
    await seed.saveDiskCache();
    const exactBytes = (await fs.stat(seedFile)).size;

    const exactFile = path.join(path.dirname(cacheFile), "utf8-exact.json");
    const exact = trackedVault(root, { persistentCache: true, cacheFile: exactFile, maxDiskCacheBytes: exactBytes });
    await exact.ensureExists();
    await exact.readNote(unicodeFile);
    await expect(exact.saveDiskCache()).resolves.toBeUndefined();
    expect((await fs.stat(exactFile)).size).toBe(exactBytes);

    const shortFile = path.join(path.dirname(cacheFile), "utf8-short.json");
    await fs.writeFile(shortFile, "OLD UTF8 CACHE SENTINEL");
    const short = trackedVault(root, {
      persistentCache: true,
      cacheFile: shortFile,
      maxDiskCacheBytes: exactBytes - 1
    });
    await short.ensureExists();
    await short.readNote(unicodeFile);
    const stringifySpy = vi.spyOn(JSON, "stringify");
    try {
      await expect(short.saveDiskCache()).rejects.toThrow(/snapshot exceeds the configured byte cap/i);
      expect(
        stringifySpy.mock.calls.some(([value]) =>
          typeof value === "object" && value !== null ? Object.hasOwn(value, "relPath") : false
        )
      ).toBe(false);
    } finally {
      stringifySpy.mockRestore();
    }
    await expect(fs.lstat(shortFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("continues stale-entry cleanup after an earlier entry crosses the byte cap", async () => {
    const files = ["Cap-A.md", "Cap-B.md", "Cap-C.md"].map((name) => path.join(root, name));
    for (const [index, file] of files.entries()) await fs.writeFile(file, `${String(index).repeat(160)}\n`);
    const seed = trackedVault(root, { persistentCache: true, cacheFile });
    await seed.ensureExists();
    for (const file of files) await seed.readNote(file);
    await seed.saveDiskCache();
    const allEntries = JSON.parse(await fs.readFile(cacheFile, "utf8")) as {
      version: number;
      root: string;
      writtenAt: string;
      entries: unknown[];
    };
    const oneEntryBytes = Buffer.byteLength(
      JSON.stringify({ ...allEntries, writtenAt: new Date().toISOString(), entries: allEntries.entries.slice(0, 1) }),
      "utf8"
    );
    await seed.closePersistence();

    const vault = trackedVault(root, { persistentCache: true, cacheFile, maxDiskCacheBytes: oneEntryBytes });
    await vault.ensureExists();
    for (const file of files) await vault.readNote(file);
    await fs.unlink(files[2] as string);
    await expect(vault.saveDiskCache()).rejects.toThrow(/snapshot exceeds the configured byte cap/i);
    const internals = vault as unknown as { cache: Map<string, unknown> };
    expect([...internals.cache.keys()].some((entry) => path.basename(entry) === "Cap-C.md")).toBe(false);
    await expect(fs.lstat(cacheFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["mid-snapshot invalidation"])("keeps the cache dirty after %s", async () => {
    const v = trackedVault(root, { persistentCache: true, cacheFile });
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
    const v = trackedVault(root, { persistentCache: true, cacheFile });
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
    const internals = v as unknown as { saveDiskCacheOnce(request: unknown): Promise<void> };
    const realSaveOnce = internals.saveDiskCacheOnce.bind(v);
    let saveOnceStarts = 0;
    const saveOnceSpy = vi.spyOn(internals, "saveDiskCacheOnce").mockImplementation(async (request) => {
      saveOnceStarts += 1;
      await realSaveOnce(request);
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
      const v = trackedVault(root, { persistentCache: true, cacheFile: cacheA });
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
        expect(publishedB.entries).toEqual([]);
        expect(await fs.readFile(cacheB, "utf8")).not.toContain("Hello body");
      } finally {
        releaseSnapshot();
        realpathSpy.mockRestore();
        renameSpy.mockRestore();
        unlinkSpy.mockRestore();
      }
    }
  );

  it.each(["a queued save captured before retarget"])(
    "does not publish post-retarget cache entries to the retired path after %s",
    async () => {
      const cacheA = cacheFile;
      const cacheB = path.join(path.dirname(cacheA), "retarget-queued-b.json");
      const v = trackedVault(root, { persistentCache: true, cacheFile: cacheA });
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
        const firstSaveA = v.saveDiskCache();
        await snapshotObserved;
        const queuedSaveA = v.saveDiskCache();
        v.cacheFile = cacheB;
        const late = path.join(root, "Late.md");
        await fs.writeFile(late, "late generation body\n");
        await v.readNote(late);
        releaseSnapshot();
        await Promise.all([firstSaveA, queuedSaveA]);

        const publishedA = JSON.parse(await fs.readFile(cacheA, "utf8"));
        expect(publishedA.entries.map((entry: { relPath: string }) => entry.relPath)).toEqual(["Hello.md"]);
        expect(await fs.readFile(cacheA, "utf8")).not.toContain("late generation body");

        await v.saveDiskCache();
        const publishedB = JSON.parse(await fs.readFile(cacheB, "utf8"));
        expect(publishedB.entries.map((entry: { relPath: string }) => entry.relPath).sort()).toEqual([
          "Hello.md",
          "Late.md"
        ]);
      } finally {
        releaseSnapshot();
        realpathSpy.mockRestore();
      }
    }
  );

  it.each(["a save invoked behind a queued clear"])(
    "does not resurrect the pre-clear cache generation after %s",
    async () => {
      const v = trackedVault(root, { persistentCache: true, cacheFile });
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
      const internals = v as unknown as { cache: Map<string, unknown>; cacheDirty: boolean };
      try {
        const olderSave = v.saveDiskCache();
        await snapshotObserved;
        const clear = v.clearDiskCache();
        const postClearSave = v.saveDiskCache();
        releaseSnapshot();
        await Promise.all([olderSave, clear, postClearSave]);

        expect(internals.cache.size).toBe(0);
        expect(internals.cacheDirty).toBe(false);
        await expect(fs.lstat(cacheFile)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        releaseSnapshot();
        realpathSpy.mockRestore();
      }
    }
  );

  it("does not let cleanup from an older save preserve or erase the post-clear generation", async () => {
    const v = trackedVault(root, { persistentCache: true, cacheFile });
    await v.ensureExists();
    const hello = await fs.realpath(path.join(root, "Hello.md"));
    await v.readNote(hello);
    await v.readNote(path.join(root, "World.md"));

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
    const internals = v as unknown as { cache: Map<string, { content: string }>; cacheDirty: boolean };
    try {
      const oldSave = v.saveDiskCache();
      await snapshotObserved;
      const clear = v.clearDiskCache();
      const late = path.join(root, "Late.md");
      await fs.writeFile(late, "post-clear generation body\n");
      await v.readNote(late);
      await fs.unlink(hello);
      releaseSnapshot();
      await Promise.all([oldSave, clear]);

      expect([...internals.cache.values()].map((entry) => entry.content)).toEqual(["post-clear generation body\n"]);
      expect(internals.cacheDirty).toBe(true);
      await expect(fs.lstat(cacheFile)).rejects.toMatchObject({ code: "ENOENT" });
      await v.saveDiskCache();
      const published = JSON.parse(await fs.readFile(cacheFile, "utf8"));
      expect(published.entries.map((entry: { relPath: string }) => entry.relPath)).toEqual(["Late.md"]);
      expect(await fs.readFile(cacheFile, "utf8")).not.toContain("World note");
    } finally {
      releaseSnapshot();
      realpathSpy.mockRestore();
    }
  });

  it("does not report a joined save as successful when its pending clear fails", async () => {
    const v = trackedVault(root, { persistentCache: true, cacheFile });
    await v.ensureExists();
    await v.readNote(path.join(root, "Hello.md"));
    await v.saveDiskCache();
    const denied = Object.assign(new Error("simulated cache clear denial"), { code: "EACCES" });
    const internals = v as unknown as {
      cacheDirty: boolean;
      unlinkSafe(target: string): Promise<void>;
    };
    const unlinkSpy = vi.spyOn(internals, "unlinkSafe").mockRejectedValueOnce(denied);
    try {
      const clear = v.clearDiskCache();
      const joinedSave = v.saveDiskCache();
      const [clearResult, saveResult] = await Promise.allSettled([clear, joinedSave]);

      expect(clearResult).toMatchObject({ status: "rejected", reason: denied });
      expect(saveResult).toMatchObject({ status: "rejected", reason: denied });
      expect(internals.cacheDirty).toBe(false);
    } finally {
      unlinkSpy.mockRestore();
    }

    await expect(v.loadDiskCache()).rejects.toBe(denied);
    await expect(v.saveDiskCache()).rejects.toBe(denied);
    await expect(v.clearDiskCache()).resolves.toBe(true);
    await expect(fs.lstat(cacheFile)).rejects.toMatchObject({ code: "ENOENT" });
    await v.readNote(path.join(root, "Hello.md"));
    expect(internals.cacheDirty).toBe(true);
    await v.saveDiskCache();
    const recovered = JSON.parse(await fs.readFile(cacheFile, "utf8"));
    expect(recovered.entries.map((entry: { relPath: string }) => entry.relPath)).toEqual(["Hello.md"]);
  });

  it("keeps a later same-family clear barrier when an earlier clear succeeds", async () => {
    const vault = trackedVault(root, { persistentCache: true, cacheFile });
    await vault.ensureExists();
    const denied = new Error("later clear failed");
    const internals = vault as unknown as {
      pendingCacheClears: Map<string, unknown>;
      clearDiskCacheOnce(request: unknown): Promise<boolean>;
    };
    const realClearOnce = internals.clearDiskCacheOnce.bind(vault);
    let releaseFirst = (): void => {};
    let observeFirst = (): void => {};
    let releaseSecond = (): void => {};
    let observeSecond = (): void => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstObserved = new Promise<void>((resolve) => {
      observeFirst = resolve;
    });
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const secondObserved = new Promise<void>((resolve) => {
      observeSecond = resolve;
    });
    let calls = 0;
    const clearSpy = vi.spyOn(internals, "clearDiskCacheOnce").mockImplementation(async (request) => {
      calls += 1;
      if (calls === 1) {
        observeFirst();
        await firstGate;
        return true;
      }
      if (calls === 2) {
        observeSecond();
        await secondGate;
        throw denied;
      }
      return realClearOnce(request);
    });
    try {
      const earlier = vault.clearDiskCache();
      await firstObserved;
      const later = vault.clearDiskCache();
      expect(internals.pendingCacheClears.size).toBe(1);
      releaseFirst();
      await expect(earlier).resolves.toBe(true);
      await secondObserved;
      expect(internals.pendingCacheClears.size).toBe(1);
      const load = vault.loadDiskCache();
      releaseSecond();
      await expect(later).rejects.toBe(denied);
      await expect(load).rejects.toBe(denied);
      expect(internals.pendingCacheClears.size).toBe(1);
    } finally {
      releaseFirst();
      releaseSecond();
      clearSpy.mockRestore();
    }
    await expect(vault.clearDiskCache()).resolves.toBe(false);
    expect(internals.pendingCacheClears.size).toBe(0);
  });

  it.each(["a same-key cache replacement during old-snapshot validation"])(
    "does not let an old save delete the newer in-memory generation after %s",
    async () => {
      const v = trackedVault(root, { persistentCache: true, cacheFile });
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
      const internals = v as unknown as { cache: Map<string, { content: string }> };
      try {
        const oldSave = v.saveDiskCache();
        await snapshotObserved;
        v.invalidateOne(hello);
        await fs.writeFile(hello, "new same-key generation\n");
        const currentStat = await fs.stat(hello);
        const advanced = new Date(currentStat.mtimeMs + 2_000);
        await fs.utimes(hello, advanced, advanced);
        await v.readNote(hello);
        expect(internals.cache.get(hello)?.content).toBe("new same-key generation\n");
        releaseSnapshot();
        await oldSave;

        expect(internals.cache.get(hello)?.content).toBe("new same-key generation\n");
        await v.saveDiskCache();
        const repaired = JSON.parse(await fs.readFile(cacheFile, "utf8"));
        expect(repaired.entries).toHaveLength(1);
        expect(repaired.entries[0]?.content).toBe("new same-key generation\n");
      } finally {
        releaseSnapshot();
        realpathSpy.mockRestore();
      }
    }
  );

  it.each(["retarget away, mutate, and retarget back"])(
    "does not let a queued clear erase a newer cache epoch after %s",
    async () => {
      const cacheA = cacheFile;
      const cacheB = path.join(path.dirname(cacheA), "retarget-epoch-b.json");
      const v = trackedVault(root, { persistentCache: true, cacheFile: cacheA });
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
        expect(repairedA.entries.map((entry: { relPath: string }) => entry.relPath)).toEqual(["Late.md"]);
        expect(await fs.readFile(cacheA, "utf8")).not.toContain("Hello body");
        await expect(fs.lstat(cacheB)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        releaseSnapshot();
        realpathSpy.mockRestore();
      }
    }
  );

  it.each(["cached read during clear preflight"])(
    "preserves only the post-clear memory generation after a %s",
    async () => {
      const v = trackedVault(root, { persistentCache: true, cacheFile });
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
      const lstatSpy = vi.spyOn(fs, "lstat").mockImplementation(async (candidate, ...args) => {
        if (!blocked && String(candidate) === cacheFile) {
          blocked = true;
          observePreflight();
          await preflightGate;
        }
        return realLstat(candidate, ...args);
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
      expect(internals.cache.size).toBe(1);
      expect(internals.cacheDirty).toBe(true);
      await expect(fs.lstat(cacheFile)).rejects.toMatchObject({ code: "ENOENT" });

      await v.saveDiskCache();
      const republished = JSON.parse(await fs.readFile(cacheFile, "utf8"));
      expect(republished.entries.map((entry: { relPath: string }) => entry.relPath)).toEqual(["Hello.md"]);
    }
  );

  it.each(["same exact path"])("does not create a cache generation when the setter receives the %s", async () => {
    const v = trackedVault(root, { persistentCache: true, cacheFile });
    await v.ensureExists();
    await v.readNote(path.join(root, "Hello.md"));
    await v.saveDiskCache();
    const before = await fs.readFile(cacheFile, "utf8");
    const internals = v as unknown as { saveDiskCacheOnce(request: unknown): Promise<void> };
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
    const v1 = trackedVault(root, { persistentCache: true, cacheFile });
    await v1.ensureExists();
    await v1.readNote(path.join(root, "Hello.md"));
    await v1.saveDiskCache();

    const v2 = trackedVault(root, { persistentCache: true, cacheFile });
    await v2.ensureExists();
    const internal = v2 as unknown as { cache: Map<string, unknown> };
    expect(internal.cache.size).toBe(1);
    expect([...internal.cache.keys()].map((entry) => path.basename(entry))).toEqual(["Hello.md"]);
  });

  it("invalidates an entry whose mtime changed since cache write", async () => {
    const v1 = trackedVault(root, { persistentCache: true, cacheFile });
    await v1.ensureExists();
    await v1.readNote(path.join(root, "Hello.md"));
    await v1.saveDiskCache();

    // Change the file content + mtime.
    await new Promise((r) => setTimeout(r, 10));
    await fs.writeFile(path.join(root, "Hello.md"), "different content");

    const v2 = trackedVault(root, { persistentCache: true, cacheFile });
    await v2.ensureExists();
    const internal = v2 as unknown as { cache: Map<string, unknown> };
    // Hello should NOT be in the cache (mtime mismatch).
    const helloKey = [...internal.cache.keys()].find((k) => String(k).endsWith("Hello.md"));
    expect(helloKey).toBeUndefined();
  });

  it("rejects an in-memory hit after a same-size overwrite with restored mtime", async () => {
    const file = path.join(root, "Same.md");
    const fixedTime = new Date("2020-01-02T03:04:05.000Z");
    await fs.writeFile(file, "AAAA");
    await fs.utimes(file, fixedTime, fixedTime);
    const vault = trackedVault(root, { persistentCache: true, cacheFile });
    await vault.ensureExists();
    await expect(vault.readNote(file)).resolves.toMatchObject({ content: "AAAA" });

    await new Promise((resolve) => setTimeout(resolve, 10));
    await fs.writeFile(file, "BBBB");
    await fs.utimes(file, fixedTime, fixedTime);
    await expect(vault.readNote(file)).resolves.toMatchObject({ content: "BBBB" });
  });

  it("does not rehydrate a same-size restored-mtime generation after restart", async () => {
    const file = path.join(root, "Restart.md");
    const fixedTime = new Date("2020-02-03T04:05:06.000Z");
    await fs.writeFile(file, "OLD!");
    await fs.utimes(file, fixedTime, fixedTime);
    const seed = trackedVault(root, { persistentCache: true, cacheFile });
    await seed.ensureExists();
    await seed.readNote(file);
    await seed.saveDiskCache();

    await new Promise((resolve) => setTimeout(resolve, 10));
    await fs.writeFile(file, "NEW!");
    await fs.utimes(file, fixedTime, fixedTime);
    const reopened = trackedVault(root, { persistentCache: true, cacheFile });
    await reopened.ensureExists();
    const internals = reopened as unknown as { cache: Map<string, unknown> };
    expect([...internals.cache.keys()].some((entry) => path.basename(entry) === "Restart.md")).toBe(false);
    await expect(reopened.readNote(file)).resolves.toMatchObject({ content: "NEW!" });
  });

  it("drops an old same-mtime snapshot instead of publishing it after source replacement", async () => {
    const file = path.join(root, "Queued.md");
    const fixedTime = new Date("2020-03-04T05:06:07.000Z");
    await fs.writeFile(file, "OLD?");
    await fs.utimes(file, fixedTime, fixedTime);
    const vault = trackedVault(root, { persistentCache: true, cacheFile });
    await vault.ensureExists();
    await vault.readNote(file);

    await new Promise((resolve) => setTimeout(resolve, 10));
    await fs.writeFile(file, "NEW?");
    await fs.utimes(file, fixedTime, fixedTime);
    await vault.saveDiskCache();

    const persisted = JSON.parse(await fs.readFile(cacheFile, "utf8")) as {
      entries: Array<{ relPath: string; content: string }>;
    };
    expect(persisted.entries.some((entry) => entry.relPath === "Queued.md")).toBe(false);
    expect(JSON.stringify(persisted)).not.toContain("OLD?");
  });

  it.each(SOURCE_RECEIPT_FIELDS)("rejects a persisted hit when only receipt.%s differs", async (field) => {
    const seed = trackedVault(root, { persistentCache: true, cacheFile });
    await seed.ensureExists();
    await seed.readNote(path.join(root, "Hello.md"));
    await seed.saveDiskCache();

    const persisted = JSON.parse(await fs.readFile(cacheFile, "utf8")) as {
      entries: Array<{ mtimeMs: number; sourceReceipt: Record<SourceReceiptField, number> }>;
    };
    const entry = persisted.entries[0];
    if (!entry) throw new Error("persisted receipt fixture is missing");
    const changed = differentReceiptValue(entry.sourceReceipt[field]);
    entry.sourceReceipt[field] = changed;
    if (field === "mtimeMs") entry.mtimeMs = changed;
    await fs.writeFile(cacheFile, JSON.stringify(persisted));

    const reopened = trackedVault(root, { persistentCache: true, cacheFile });
    await expect(reopened.loadDiskCache()).resolves.toBe(0);
    const internals = reopened as unknown as { cache: Map<string, unknown> };
    expect(internals.cache.size).toBe(0);
  });

  it.each(SOURCE_RECEIPT_FIELDS)("rejects an in-memory hit when only receipt.%s differs", async (field) => {
    const vault = trackedVault(root, { persistentCache: true, cacheFile });
    await vault.ensureExists();
    const file = await fs.realpath(path.join(root, "Hello.md"));
    await vault.readNote(file);
    const internals = vault as unknown as {
      cache: Map<string, { content: string; sourceReceipt: Record<SourceReceiptField, number> }>;
    };
    const cached = internals.cache.get(file);
    if (!cached) throw new Error("memory receipt fixture is missing");
    cached.content = "POISONED MEMORY HIT";
    cached.sourceReceipt[field] = differentReceiptValue(cached.sourceReceipt[field]);

    const reread = await vault.readNote(file);
    expect(reread.content).toContain("Hello body.");
    expect(reread.content).not.toBe("POISONED MEMORY HIT");
  });

  it("does not expose the mutable internal cache entry through readNote", async () => {
    const vault = trackedVault(root, { persistentCache: true, cacheFile });
    await vault.ensureExists();
    const file = path.join(root, "Hello.md");
    const first = (await vault.readNote(file)) as unknown as {
      content: string;
      parsed: { body: string; tags: string[] };
    };
    expect(first).not.toHaveProperty("sourceReceipt");
    first.content = "CALLER-POISONED CONTENT";
    first.parsed.body = "CALLER-POISONED BODY";
    first.parsed.tags.push("caller-poisoned-tag");
    expect(first.content).toBe("CALLER-POISONED CONTENT");
    expect(first.parsed.tags).toContain("caller-poisoned-tag");

    const second = (await vault.readNote(file)) as unknown as typeof first;
    expect(second.content).toContain("Hello body.");
    expect(second.parsed.body).toContain("Hello body.");
    expect(second.parsed.tags).not.toContain("caller-poisoned-tag");
    expect(second).not.toHaveProperty("sourceReceipt");
    second.content = "CALLER-POISONED CACHE HIT";
    second.parsed.tags.push("hit-poison");
    expect(second.content).toBe("CALLER-POISONED CACHE HIT");

    const third = await vault.readNote(file);
    expect(third.content).toContain("Hello body.");
    expect(third.parsed.tags).not.toContain("hit-poison");
    await vault.saveDiskCache();
    const raw = await fs.readFile(cacheFile, "utf8");
    expect(raw).not.toContain("CALLER-POISONED");
    expect(raw).not.toContain("hit-poison");
  });

  it("detaches repeated YAML scalar aliases without structured-clone expansion", async () => {
    const file = path.join(root, "Scalar-Aliases.md");
    const scalar = "S".repeat(4096);
    const aliases = Array.from({ length: 256 }, (_, index) => `alias_${index}: *shared`).join("\n");
    await fs.writeFile(file, `---\nshared: &shared "${scalar}"\n${aliases}\n---\nAlias body\n`);
    const vault = trackedVault(root, { persistentCache: true, cacheFile });
    await vault.ensureExists();
    const cloneSpy = vi.spyOn(globalThis, "structuredClone");
    try {
      const fresh = await vault.readNote(file);
      expect(fresh.parsed.frontmatter.alias_255).toBe(scalar);
      const hit = await vault.readNote(file);
      expect(hit.parsed.frontmatter.alias_0).toBe(scalar);
      expect(cloneSpy).not.toHaveBeenCalled();
    } finally {
      cloneSpy.mockRestore();
    }
  });

  it("preserves YAML object-alias identity inside each detached snapshot without exposing the cached graph", async () => {
    const file = path.join(root, "Object-Aliases.md");
    await fs.writeFile(
      file,
      "---\nshared: &shared\n  nested: ORIGINAL\nleft: *shared\nright: *shared\n---\nAlias object body\n"
    );
    const vault = trackedVault(root, { persistentCache: true, cacheFile });
    await vault.ensureExists();
    const first = await vault.readNote(file);
    const firstLeft = first.parsed.frontmatter.left as { nested: string };
    const firstRight = first.parsed.frontmatter.right as { nested: string };
    expect(firstLeft).toBe(firstRight);
    firstLeft.nested = "CALLER_MUTATION";
    expect(firstRight.nested).toBe("CALLER_MUTATION");

    const second = await vault.readNote(file);
    const secondLeft = second.parsed.frontmatter.left as { nested: string };
    const secondRight = second.parsed.frontmatter.right as { nested: string };
    expect(secondLeft).toBe(secondRight);
    expect(secondLeft.nested).toBe("ORIGINAL");
    expect(secondLeft).not.toBe(firstLeft);
  });

  it("rejects a cyclic YAML alias before it can enter or escape the cache", async () => {
    const file = path.join(root, "Cyclic-Alias.md");
    await fs.writeFile(file, "---\nloop: &loop\n  self: *loop\n---\nCycle body\n");
    const vault = trackedVault(root, { persistentCache: true, cacheFile });
    await vault.ensureExists();
    await expect(vault.readNote(file)).rejects.toThrow(/parsed note contains a cyclic value/i);
    const canonical = await fs.realpath(file);
    const internals = vault as unknown as { cache: Map<string, unknown> };
    expect(internals.cache.has(canonical)).toBe(false);
  });

  it.each(SOURCE_RECEIPT_FIELDS)("does not publish a snapshot when only receipt.%s differs", async (field) => {
    const vault = trackedVault(root, { persistentCache: true, cacheFile });
    await vault.ensureExists();
    const file = await fs.realpath(path.join(root, "Hello.md"));
    await vault.readNote(file);
    const internals = vault as unknown as {
      cache: Map<string, { content: string; sourceReceipt: Record<SourceReceiptField, number> }>;
    };
    const cached = internals.cache.get(file);
    if (!cached) throw new Error("save receipt fixture is missing");
    cached.content = "POISONED DISK SNAPSHOT";
    cached.sourceReceipt[field] = differentReceiptValue(cached.sourceReceipt[field]);

    await vault.saveDiskCache();
    const persisted = JSON.parse(await fs.readFile(cacheFile, "utf8")) as { entries: unknown[] };
    expect(persisted.entries).toEqual([]);
    expect(JSON.stringify(persisted)).not.toContain("POISONED DISK SNAPSHOT");
  });

  it("rejects cache file written for a different vault root", async () => {
    const v1 = trackedVault(root, { persistentCache: true, cacheFile });
    await v1.ensureExists();
    await v1.readNote(path.join(root, "Hello.md"));
    await v1.saveDiskCache();

    // Hand-edit the cache file to claim a different root.
    const data = JSON.parse(await fs.readFile(cacheFile, "utf8"));
    data.root = "/some/other/vault";
    await fs.writeFile(cacheFile, JSON.stringify(data));

    const v2 = trackedVault(root, { persistentCache: true, cacheFile });
    const loaded = await v2.loadDiskCache();
    expect(loaded).toBe(0);
  });

  it("rejects cache file with mismatched version", async () => {
    const v1 = trackedVault(root, { persistentCache: true, cacheFile });
    await v1.ensureExists();
    await v1.readNote(path.join(root, "Hello.md"));
    await v1.saveDiskCache();

    const data = JSON.parse(await fs.readFile(cacheFile, "utf8"));
    data.version = 999;
    await fs.writeFile(cacheFile, JSON.stringify(data));

    const v2 = trackedVault(root, { persistentCache: true, cacheFile });
    const loaded = await v2.loadDiskCache();
    expect(loaded).toBe(0);
  });

  it("ignores corrupt cache file gracefully", async () => {
    await fs.mkdir(path.dirname(cacheFile), { recursive: true });
    await fs.writeFile(cacheFile, "{not json");

    const v = trackedVault(root, { persistentCache: true, cacheFile });
    const loaded = await v.loadDiskCache();
    expect(loaded).toBe(0);
    // Subsequent reads should still work fresh.
    await v.ensureExists();
    const note = await v.readNote(path.join(root, "Hello.md"));
    expect(note.content).toContain("Hello body");
    for (const validButNonObjectJson of ["null", "[]", "7"]) {
      await fs.writeFile(cacheFile, validButNonObjectJson);
      await expect(v.loadDiskCache()).resolves.toBe(0);
    }
    await expect(v.clearDiskCache()).resolves.toBe(true);
  });

  it.each([
    ["null entry", async () => null],
    ["array entry", async () => []],
    ["primitive entry", async () => 7],
    [
      "malformed parsed note",
      async () => {
        const stat = await fs.stat(path.join(root, "Hello.md"));
        return {
          relPath: "Hello.md",
          mtimeMs: stat.mtimeMs,
          sourceReceipt: persistedSourceReceipt(stat),
          content: "Hello body.",
          parsed: null
        };
      }
    ]
  ] as const)("drops a %s from untrusted persisted JSON without failing startup", async (_shape, makeEntry) => {
    await fs.mkdir(path.dirname(cacheFile), { recursive: true });
    const vault = trackedVault(root, { persistentCache: true, cacheFile });
    await vault.ensureExists();
    await fs.writeFile(
      cacheFile,
      JSON.stringify({
        version: 2,
        root: vault.root,
        writtenAt: new Date().toISOString(),
        entries: [await makeEntry()]
      })
    );

    await expect(vault.loadDiskCache()).resolves.toBe(0);
    const internals = vault as unknown as { cache: Map<string, unknown>; cacheDirty: boolean };
    expect(internals.cache.size).toBe(0);
    expect(internals.cacheDirty).toBe(true);
  });

  it.each([1])("keeps scanning after malformed candidates until the %i-entry cache can be filled", async (limit) => {
    await fs.mkdir(path.dirname(cacheFile), { recursive: true });
    const vault = trackedVault(root, { persistentCache: true, cacheFile, maxCacheEntries: limit });
    await vault.ensureExists();
    const hello = await fs.realpath(path.join(root, "Hello.md"));
    const helloStat = await fs.stat(hello);
    await fs.writeFile(
      cacheFile,
      JSON.stringify({
        version: 2,
        root: vault.root,
        writtenAt: new Date().toISOString(),
        entries: [
          null,
          {
            relPath: "Hello.md",
            mtimeMs: helloStat.mtimeMs,
            sourceReceipt: persistedSourceReceipt(helloStat),
            content: "Hello body.",
            parsed: { frontmatter: {}, body: "Hello body.", bodyStartLine: 1, wikilinks: [], embeds: [], tags: [] }
          }
        ]
      })
    );
    const realStat = fs.stat.bind(fs);
    let helloStatCalls = 0;
    const statSpy = vi.spyOn(fs, "stat").mockImplementation(async (candidate) => {
      if (String(candidate) === hello) helloStatCalls += 1;
      return realStat(candidate);
    });
    try {
      await expect(vault.loadDiskCache()).resolves.toBe(1);
    } finally {
      statSpy.mockRestore();
    }
    expect(helloStatCalls).toBe(1);
    const internals = vault as unknown as { cacheDirty: boolean };
    expect(internals.cacheDirty).toBe(true);
  });

  it.each([100_000])("does not inspect persisted candidate %i+1 beyond the hard startup-work cap", async (limit) => {
    await fs.mkdir(path.dirname(cacheFile), { recursive: true });
    const vault = trackedVault(root, { persistentCache: true, cacheFile, maxCacheEntries: 1 });
    await vault.ensureExists();
    const hello = await fs.realpath(path.join(root, "Hello.md"));
    const helloStat = await fs.stat(hello);
    const entries: unknown[] = Array.from({ length: limit }, () => null);
    entries.push({
      relPath: "Hello.md",
      mtimeMs: helloStat.mtimeMs,
      sourceReceipt: persistedSourceReceipt(helloStat),
      content: "candidate beyond hard cap",
      parsed: {
        frontmatter: {},
        body: "candidate beyond hard cap",
        bodyStartLine: 1,
        wikilinks: [],
        embeds: [],
        tags: []
      }
    });
    await fs.writeFile(
      cacheFile,
      JSON.stringify({ version: 2, root: vault.root, writtenAt: new Date().toISOString(), entries })
    );
    const realStat = fs.stat.bind(fs);
    let helloStatCalls = 0;
    const statSpy = vi.spyOn(fs, "stat").mockImplementation(async (candidate) => {
      if (String(candidate) === hello) helloStatCalls += 1;
      return realStat(candidate);
    });
    try {
      await expect(vault.loadDiskCache()).resolves.toBe(0);
    } finally {
      statSpy.mockRestore();
    }
    expect(helloStatCalls).toBe(0);
    const internals = vault as unknown as { cacheDirty: boolean };
    expect(internals.cacheDirty).toBe(true);
  });

  it.each([40])("validates %i persisted hits with bounded filesystem concurrency", async (entryCount) => {
    await fs.mkdir(path.dirname(cacheFile), { recursive: true });
    const vault = trackedVault(root, { persistentCache: true, cacheFile, maxCacheEntries: entryCount });
    await vault.ensureExists();
    const hello = await fs.realpath(path.join(root, "Hello.md"));
    const helloStat = await fs.stat(hello);
    const entry = {
      relPath: "Hello.md",
      mtimeMs: helloStat.mtimeMs,
      sourceReceipt: persistedSourceReceipt(helloStat),
      content: "Hello body.",
      parsed: { frontmatter: {}, body: "Hello body.", bodyStartLine: 1, wikilinks: [], embeds: [], tags: [] }
    };
    await fs.writeFile(
      cacheFile,
      JSON.stringify({
        version: 2,
        root: vault.root,
        writtenAt: new Date().toISOString(),
        entries: Array.from({ length: entryCount }, () => entry)
      })
    );

    const realStat = fs.stat.bind(fs);
    let active = 0;
    let maximumActive = 0;
    let started = 0;
    let release = (): void => {};
    let observeFullBatch = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fullBatchObserved = new Promise<void>((resolve) => {
      observeFullBatch = resolve;
    });
    const statSpy = vi.spyOn(fs, "stat").mockImplementation(async (candidate) => {
      if (String(candidate) !== hello) return realStat(candidate);
      active += 1;
      started += 1;
      maximumActive = Math.max(maximumActive, active);
      if (started === 32) observeFullBatch();
      await gate;
      try {
        return await realStat(candidate);
      } finally {
        active -= 1;
      }
    });
    try {
      const loading = vault.loadDiskCache();
      await fullBatchObserved;
      expect(maximumActive).toBe(32);
      release();
      await expect(loading).resolves.toBe(entryCount);
      expect(maximumActive).toBeLessThanOrEqual(32);
    } finally {
      release();
      statSpy.mockRestore();
    }
  });

  it("does not let an accepted pre-clear disk load rehydrate the retired generation", async () => {
    const seed = trackedVault(root, { persistentCache: true, cacheFile });
    await seed.ensureExists();
    const hello = await fs.realpath(path.join(root, "Hello.md"));
    await seed.readNote(hello);
    await seed.readNote(path.join(root, "World.md"));
    await seed.saveDiskCache();
    await seed.closePersistence();

    const loadingVault = trackedVault(root, { persistentCache: true, cacheFile });
    const realStat = fs.stat.bind(fs);
    let releaseCandidate = (): void => {};
    let observeCandidate = (): void => {};
    const candidateGate = new Promise<void>((resolve) => {
      releaseCandidate = resolve;
    });
    const candidateObserved = new Promise<void>((resolve) => {
      observeCandidate = resolve;
    });
    let blocked = false;
    const statSpy = vi.spyOn(fs, "stat").mockImplementation(async (candidate) => {
      if (!blocked && String(candidate) === hello) {
        blocked = true;
        observeCandidate();
        await candidateGate;
      }
      return realStat(candidate);
    });
    const internals = loadingVault as unknown as { cache: Map<string, unknown>; cacheDirty: boolean };
    try {
      const initialization = loadingVault.ensureExists();
      await candidateObserved;
      const clear = loadingVault.clearDiskCache();
      releaseCandidate();
      await Promise.all([initialization, clear]);

      expect(internals.cache.size).toBe(0);
      expect(internals.cacheDirty).toBe(false);
      await expect(fs.lstat(cacheFile)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      releaseCandidate();
      statSpy.mockRestore();
    }
  });

  it("makes a disk load accepted after clear admission join the erasure barrier", async () => {
    const seed = trackedVault(root, { persistentCache: true, cacheFile });
    await seed.ensureExists();
    await seed.readNote(path.join(root, "Hello.md"));
    await seed.saveDiskCache();
    await seed.closePersistence();

    const canonicalRoot = await fs.realpath(root);
    const vault = trackedVault(canonicalRoot, { persistentCache: true, cacheFile });
    await vault.ensureExists();
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
    const lstatSpy = vi.spyOn(fs, "lstat").mockImplementation(async (candidate, ...args) => {
      if (!blocked && String(candidate) === cacheFile) {
        blocked = true;
        observePreflight();
        await preflightGate;
      }
      return realLstat(candidate, ...args);
    });
    const realStat = fs.stat.bind(fs);
    let cacheStatCalls = 0;
    const statSpy = vi.spyOn(fs, "stat").mockImplementation(async (candidate, ...args) => {
      if (String(candidate) === cacheFile) cacheStatCalls += 1;
      return realStat(candidate, ...args);
    });
    const internals = vault as unknown as { cache: Map<string, unknown>; cacheDirty: boolean };
    try {
      const clear = vault.clearDiskCache();
      await preflightObserved;
      const lexicalAlias = `${path.dirname(cacheFile)}${path.sep}.${path.sep}${path.basename(cacheFile)}`;
      vault.cacheFile = lexicalAlias;
      expect(vault.cacheFile).toBe(cacheFile);
      let loadSettled = false;
      const load = vault.loadDiskCache().finally(() => {
        loadSettled = true;
      });
      expect(cacheStatCalls).toBe(0);
      expect(loadSettled).toBe(false);
      releasePreflight();
      await expect(clear).resolves.toBe(true);
      await expect(load).resolves.toBe(0);

      expect(internals.cache.size).toBe(0);
      expect(internals.cacheDirty).toBe(false);
      await expect(fs.lstat(cacheFile)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      releasePreflight();
      lstatSpy.mockRestore();
      statSpy.mockRestore();
    }
  });

  it("initializes an unready save before enqueue so a following clear cannot deadlock", async () => {
    const seed = trackedVault(root, { persistentCache: true, cacheFile });
    await seed.ensureExists();
    await seed.readNote(path.join(root, "Hello.md"));
    await seed.saveDiskCache();

    const canonicalRoot = await fs.realpath(root);
    const vault = trackedVault(canonicalRoot, { persistentCache: true, cacheFile });
    await expect(vault.loadDiskCache()).resolves.toBe(1);
    const retargetFile = path.join(path.dirname(cacheFile), "retarget.json");
    vault.cacheFile = retargetFile;

    const realStat = fs.stat.bind(fs);
    let releaseRootStat = (): void => {};
    let observeRootStat = (): void => {};
    const rootStatGate = new Promise<void>((resolve) => {
      releaseRootStat = resolve;
    });
    const rootStatObserved = new Promise<void>((resolve) => {
      observeRootStat = resolve;
    });
    let blockedRoot = false;
    const statSpy = vi.spyOn(fs, "stat").mockImplementation(async (candidate, ...args) => {
      if (!blockedRoot && String(candidate) === canonicalRoot) {
        blockedRoot = true;
        observeRootStat();
        await rootStatGate;
      }
      return realStat(candidate, ...args);
    });
    const realLstat = fs.lstat.bind(fs);
    let observeClearPreflight = (): void => {};
    const clearPreflightObserved = new Promise<void>((resolve) => {
      observeClearPreflight = resolve;
    });
    let observedClear = false;
    const lstatSpy = vi.spyOn(fs, "lstat").mockImplementation(async (candidate, ...args) => {
      if (!observedClear && String(candidate) === retargetFile) {
        observedClear = true;
        observeClearPreflight();
      }
      return realLstat(candidate, ...args);
    });
    const internals = vault as unknown as { cache: Map<string, unknown>; cacheDirty: boolean };
    try {
      const save = vault.saveDiskCache();
      await rootStatObserved;
      const clear = vault.clearDiskCache();
      await clearPreflightObserved;
      releaseRootStat();
      await expect(clear).resolves.toBe(false);
      await expect(save).resolves.toBeUndefined();
      expect(internals.cache.size).toBe(0);
      expect(internals.cacheDirty).toBe(false);
      await expect(fs.lstat(retargetFile)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      releaseRootStat();
      statSpy.mockRestore();
      lstatSpy.mockRestore();
    }
  });

  it("resolves and erases the default cache path when clear is the first public operation", async () => {
    const previousXdg = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = path.join(path.dirname(cacheFile), "default-cache-root");
    try {
      const seed = trackedVault(root, { persistentCache: true });
      await seed.ensureExists();
      await seed.readNote(path.join(root, "Hello.md"));
      await seed.saveDiskCache();
      const defaultFile = seed.cacheFile;
      expect(defaultFile).not.toBeNull();
      if (!defaultFile) throw new Error("default cache path was not resolved");
      await expect(fs.lstat(defaultFile)).resolves.toMatchObject({ isFile: expect.any(Function) });
      await seed.closePersistence();

      const eraser = trackedVault(root, { persistentCache: true });
      await expect(eraser.clearDiskCache()).resolves.toBe(true);
      expect(eraser.cacheFile).toBe(defaultFile);
      await expect(fs.lstat(defaultFile)).rejects.toMatchObject({ code: "ENOENT" });
      const internals = eraser as unknown as { cache: Map<string, unknown>; cacheDirty: boolean };
      expect(internals.cache.size).toBe(0);
      expect(internals.cacheDirty).toBe(false);
    } finally {
      if (previousXdg === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = previousXdg;
    }
  });

  it("preserves an explicit retarget that wins while the default clear path is resolving", async () => {
    const previousXdg = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = path.join(path.dirname(cacheFile), "retargeted-default-cache-root");
    const explicitFile = path.join(path.dirname(cacheFile), "resolver-winner.json");
    await fs.writeFile(explicitFile, "RETARGET_WINNER");
    const vault = trackedVault(root, { persistentCache: true });
    const realStat = fs.stat.bind(fs);
    let releaseRootStat = (): void => {};
    let observeRootStat = (): void => {};
    const rootStatGate = new Promise<void>((resolve) => {
      releaseRootStat = resolve;
    });
    const rootStatObserved = new Promise<void>((resolve) => {
      observeRootStat = resolve;
    });
    let blocked = false;
    const statSpy = vi.spyOn(fs, "stat").mockImplementation(async (candidate, ...args) => {
      if (!blocked && String(candidate) === path.resolve(root)) {
        blocked = true;
        observeRootStat();
        await rootStatGate;
      }
      return realStat(candidate, ...args);
    });
    try {
      const clear = vault.clearDiskCache();
      await rootStatObserved;
      vault.cacheFile = explicitFile;
      releaseRootStat();
      await expect(clear).resolves.toBe(true);
      expect(vault.cacheFile).toBe(explicitFile);
      await expect(fs.lstat(explicitFile)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      releaseRootStat();
      statSpy.mockRestore();
      if (previousXdg === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = previousXdg;
    }
  });

  it("erases an explicit cache path even after the configured vault root disappeared", async () => {
    const seed = trackedVault(root, { persistentCache: true, cacheFile });
    await seed.ensureExists();
    await seed.readNote(path.join(root, "Hello.md"));
    await seed.saveDiskCache();
    expect(await fs.readFile(cacheFile, "utf8")).toContain("Hello body.");
    await seed.closePersistence();

    await fs.rm(root, { recursive: true, force: true });
    const eraser = trackedVault(root, { persistentCache: true, cacheFile });
    await expect(eraser.clearDiskCache()).resolves.toBe(true);
    await expect(fs.lstat(cacheFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requests a private fresh parent, preserves an existing 0750 parent, and publishes cache mode 0600", async () => {
    const freshFile = path.join(path.dirname(cacheFile), "fresh", "nested", "cache.json");
    const fresh = trackedVault(root, { persistentCache: true, cacheFile: freshFile });
    await fresh.ensureExists();
    await fresh.readNote(path.join(root, "Hello.md"));
    await fresh.saveDiskCache();
    expect((await fs.stat(path.dirname(freshFile))).mode & 0o077).toBe(0); // umask may tighten 0700
    expect((await fs.stat(freshFile)).mode & 0o777).toBe(0o600);

    const existingParent = path.join(path.dirname(cacheFile), "operator-managed-cache-parent");
    await fs.mkdir(existingParent, { mode: 0o750 });
    await fs.chmod(existingParent, 0o750);
    const existingFile = path.join(existingParent, "cache.json");
    const existing = trackedVault(root, { persistentCache: true, cacheFile: existingFile });
    await existing.ensureExists();
    await existing.readNote(path.join(root, "World.md"));
    await existing.saveDiskCache();
    expect((await fs.stat(existingParent)).mode & 0o777).toBe(0o750);
    expect((await fs.stat(existingFile)).mode & 0o777).toBe(0o600);
  });

  it("re-saves cache after deleted or restricted entries are dropped on load (audit P2-2)", async () => {
    // Seed cache with three entries.
    const v1 = trackedVault(root, { persistentCache: true, cacheFile });
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
    directoryEntry.sourceReceipt = persistedSourceReceipt(replacementDirectoryStat);
    crafted.entries.push({
      relPath: ".secret.md",
      mtimeMs: hiddenStat.mtimeMs,
      sourceReceipt: persistedSourceReceipt(hiddenStat),
      content: "hidden cached body",
      parsed: { frontmatter: {}, body: "hidden cached body", bodyStartLine: 1, wikilinks: [], embeds: [], tags: [] }
    });
    await fs.writeFile(cacheFile, JSON.stringify(crafted));

    // Delete World.md from the vault.
    await fs.unlink(path.join(root, "World.md"));

    // New Vault loads cache, should drop World.md entry AND mark dirty.
    const v2 = trackedVault(root, { persistentCache: true, cacheFile });
    await v2.ensureExists();
    await v2.saveDiskCache();
    const afterBody = await fs.readFile(cacheFile, "utf8");
    expect(afterBody).not.toContain("World note");
    expect(afterBody).not.toContain("hidden cached body");
    expect(afterBody).not.toContain("directory-shaped stale body");
    expect(afterBody).toContain("Hello body");
  });

  it("clearDiskCache removes the cache file and in-memory cache", async () => {
    const v = trackedVault(root, { persistentCache: true, cacheFile });
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
    const v1 = trackedVault(root, { persistentCache: true, cacheFile });
    await v1.ensureExists();
    const realRoot = v1.root;
    const hostsStat = await fs.stat("/etc/hosts").catch(() => null);
    if (!hostsStat) return; // /etc/hosts not readable on this CI
    const relToHosts = path.relative(realRoot, "/etc/hosts");
    const data = {
      version: 2,
      root: realRoot,
      writtenAt: new Date().toISOString(),
      entries: [
        {
          relPath: relToHosts,
          mtimeMs: hostsStat.mtimeMs,
          sourceReceipt: persistedSourceReceipt(hostsStat),
          content: "INJECTED FROM /etc/hosts",
          parsed: { frontmatter: {}, body: "INJECTED", bodyStartLine: 1, wikilinks: [], embeds: [], tags: [] }
        }
      ]
    };
    await fs.writeFile(cacheFile, JSON.stringify(data));

    const v2 = trackedVault(root, { persistentCache: true, cacheFile });
    const loaded = await v2.loadDiskCache();
    expect(loaded).toBe(0);
    const internal = v2 as unknown as { cache: Map<string, unknown> };
    expect(internal.cache.size).toBe(0);
  });

  it("rejects absolute-path entries in cache (audit v0.7.2 P1)", async () => {
    await fs.mkdir(path.dirname(cacheFile), { recursive: true });
    const v1 = trackedVault(root, { persistentCache: true, cacheFile });
    await v1.ensureExists();
    const outsidePath = path.join(path.dirname(cacheFile), "outside.md");
    await fs.writeFile(outsidePath, "outside sentinel");
    const outsideStat = await fs.stat(outsidePath);
    const data = {
      version: 2,
      root: v1.root,
      writtenAt: new Date().toISOString(),
      entries: [
        {
          relPath: outsidePath,
          mtimeMs: outsideStat.mtimeMs,
          sourceReceipt: persistedSourceReceipt(outsideStat),
          content: "INJECTED",
          parsed: { frontmatter: {}, body: "x", bodyStartLine: 1, wikilinks: [], embeds: [], tags: [] }
        }
      ]
    };
    await fs.writeFile(cacheFile, JSON.stringify(data));

    const v2 = trackedVault(root, { persistentCache: true, cacheFile });
    const loaded = await v2.loadDiskCache();
    expect(loaded).toBe(0);
  });

  it("rejects oversized cached content on load (audit P2-1)", async () => {
    // Write a cache file with a fake oversized entry.
    const big = "x".repeat(200);
    await fs.mkdir(path.dirname(cacheFile), { recursive: true });
    const v1 = trackedVault(root, { persistentCache: true, cacheFile });
    await v1.ensureExists();
    const helloStat = await fs.stat(path.join(root, "Hello.md"));
    const data = {
      version: 2,
      root: v1.root,
      writtenAt: new Date().toISOString(),
      entries: [
        {
          relPath: "Hello.md",
          mtimeMs: helloStat.mtimeMs,
          sourceReceipt: persistedSourceReceipt(helloStat),
          content: big,
          parsed: { frontmatter: {}, body: big, bodyStartLine: 1, wikilinks: [], embeds: [], tags: [] }
        }
      ]
    };
    await fs.writeFile(cacheFile, JSON.stringify(data));

    // Load with stricter limit — entry must be dropped.
    const v2 = trackedVault(root, { persistentCache: true, cacheFile, maxFileBytes: 50 });
    const loaded = await v2.loadDiskCache();
    expect(loaded).toBe(0);
  });
});
