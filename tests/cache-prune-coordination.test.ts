import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeCachePrune, MAX_CACHE_PRUNE_ENTRIES, previewCachePrune } from "../src/cache-prune.js";
import { PersistenceLeaseIntegrityError } from "../src/persistence-lease.js";

const KEEP = "aaaaaaaaaaaa";
const OTHER = "bbbbbbbbbbbb";
const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-prune-coordination-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("namespace-exclusive cache prune", () => {
  it("rejects a canonical-parent rename/replacement before deletion and leaves replacement bytes untouched", async () => {
    const root = await makeRoot();
    const cacheDir = path.join(root, "enquire");
    const originalDir = path.join(root, "enquire-original");
    const replacementDir = path.join(root, "enquire-replacement");
    await fs.mkdir(cacheDir);
    const artifact = path.join(cacheDir, `${OTHER}.json`);
    await fs.writeFile(artifact, "ORIGINAL_BYTES", { mode: 0o600 });
    const canonicalDir = await fs.realpath(cacheDir);
    const canonicalArtifact = path.join(canonicalDir, `${OTHER}.json`);

    const realLstat = fs.lstat.bind(fs);
    let swapped = false;
    let restored = false;
    const lstatSpy = vi.spyOn(fs, "lstat").mockImplementation(async (candidate, ...args) => {
      if (!swapped && String(candidate) === canonicalArtifact) {
        const originalStat = await realLstat(candidate, ...args);
        await fs.rename(cacheDir, originalDir);
        await fs.mkdir(cacheDir);
        await fs.writeFile(path.join(cacheDir, `${OTHER}.json`), "REPLACEMENT_BYTES", { mode: 0o600 });
        swapped = true;
        return originalStat;
      }
      if (swapped && !restored && String(candidate) === canonicalDir) {
        const replacementStat = await realLstat(candidate, ...args);
        await fs.rename(cacheDir, replacementDir);
        await fs.rename(originalDir, cacheDir);
        restored = true;
        return replacementStat;
      }
      return realLstat(candidate, ...args);
    });
    try {
      await expect(executeCachePrune(cacheDir, KEEP)).rejects.toBeInstanceOf(PersistenceLeaseIntegrityError);
    } finally {
      lstatSpy.mockRestore();
    }
    expect(swapped).toBe(true);
    expect(restored).toBe(true);
    expect(await fs.readFile(path.join(cacheDir, `${OTHER}.json`), "utf8")).toBe("ORIGINAL_BYTES");
    expect(await fs.readFile(path.join(replacementDir, `${OTHER}.json`), "utf8")).toBe("REPLACEMENT_BYTES");
  });

  it("keeps using the canonical parent when the caller's directory symlink is retargeted", async (ctx) => {
    const root = await makeRoot();
    const first = path.join(root, "first");
    const second = path.join(root, "second");
    const alias = path.join(root, "cache-alias");
    await Promise.all([fs.mkdir(first), fs.mkdir(second)]);
    try {
      await fs.symlink(first, alias, "dir");
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
      if (code === "EPERM" || code === "EACCES") return ctx.skip("filesystem cannot create directory symlinks");
      throw error;
    }
    const originalArtifact = path.join(first, `${OTHER}.json`);
    const replacementArtifact = path.join(second, `${OTHER}.json`);
    await fs.writeFile(originalArtifact, "ORIGINAL_BYTES", { mode: 0o600 });
    await fs.writeFile(replacementArtifact, "REPLACEMENT_BYTES", { mode: 0o600 });
    const canonicalArtifact = path.join(await fs.realpath(first), `${OTHER}.json`);

    const realLstat = fs.lstat.bind(fs);
    let retargeted = false;
    const lstatSpy = vi.spyOn(fs, "lstat").mockImplementation(async (candidate, ...args) => {
      const stat = await realLstat(candidate, ...args);
      if (!retargeted && String(candidate) === canonicalArtifact) {
        await fs.unlink(alias);
        await fs.symlink(second, alias, "dir");
        retargeted = true;
      }
      return stat;
    });
    try {
      const result = await executeCachePrune(alias, KEEP);
      expect(result.removed).toBe(1);
    } finally {
      lstatSpy.mockRestore();
    }
    expect(retargeted).toBe(true);
    await expect(fs.lstat(originalArtifact)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(replacementArtifact, "utf8")).toBe("REPLACEMENT_BYTES");
  });

  it.each(["overflow", "read failure"] as const)(
    "rejects an incomplete bounded directory census on %s before deleting",
    async (failure) => {
      const root = await makeRoot();
      const cacheDir = path.join(root, "enquire");
      await fs.mkdir(cacheDir);
      const sentinel = path.join(cacheDir, `${OTHER}.json`);
      await fs.writeFile(sentinel, "CENSUS_SENTINEL", { mode: 0o600 });
      const canonicalDir = await fs.realpath(cacheDir);
      const realOpendir = fs.opendir.bind(fs);
      let reads = 0;
      let closed = false;
      const opendirSpy = vi.spyOn(fs, "opendir").mockImplementation(async (directory, ...args) => {
        if (String(directory) !== canonicalDir) return realOpendir(directory, ...args);
        return {
          read: async () => {
            reads += 1;
            if (failure === "read failure") throw new Error("injected census read failure");
            return { name: `fake-${reads}` };
          },
          close: async () => {
            closed = true;
          }
        } as unknown as Awaited<ReturnType<typeof fs.opendir>>;
      });
      try {
        const attempt = executeCachePrune(cacheDir, KEEP);
        if (failure === "overflow") {
          await expect(attempt).rejects.toThrow(`directory exceeds ${MAX_CACHE_PRUNE_ENTRIES} entries`);
          expect(reads).toBe(MAX_CACHE_PRUNE_ENTRIES + 1);
        } else {
          await expect(attempt).rejects.toThrow("injected census read failure");
          expect(reads).toBe(1);
        }
      } finally {
        opendirSpy.mockRestore();
      }
      expect(closed).toBe(true);
      expect(await fs.readFile(sentinel, "utf8")).toBe("CENSUS_SENTINEL");
    }
  );

  it("applies the same bounded complete census to read-only preview without creating lease state", async () => {
    const root = await makeRoot();
    const cacheDir = path.join(root, "enquire");
    await fs.mkdir(cacheDir);
    const sentinel = path.join(cacheDir, `${OTHER}.json`);
    await fs.writeFile(sentinel, "PREVIEW_SENTINEL", { mode: 0o600 });
    const canonicalDir = await fs.realpath(cacheDir);
    const realOpendir = fs.opendir.bind(fs);
    let reads = 0;
    let closed = false;
    const opendirSpy = vi.spyOn(fs, "opendir").mockImplementation(async (directory, ...args) => {
      if (String(directory) !== canonicalDir) return realOpendir(directory, ...args);
      return {
        read: async () => {
          reads += 1;
          return { name: `fake-${reads}` };
        },
        close: async () => {
          closed = true;
        }
      } as unknown as Awaited<ReturnType<typeof fs.opendir>>;
    });
    try {
      await expect(previewCachePrune(cacheDir, KEEP)).rejects.toThrow(
        `directory exceeds ${MAX_CACHE_PRUNE_ENTRIES} entries`
      );
    } finally {
      opendirSpy.mockRestore();
    }
    expect(reads).toBe(MAX_CACHE_PRUNE_ENTRIES + 1);
    expect(closed).toBe(true);
    expect(await fs.readFile(sentinel, "utf8")).toBe("PREVIEW_SENTINEL");
    await expect(fs.lstat(path.join(cacheDir, ".enquire-mcp-leases"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
