import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmbedDb } from "../src/embed-db.js";
import { embedSingleNote } from "../src/embed-pipeline.js";
import type { Embedder } from "../src/embeddings.js";
import { FtsIndex } from "../src/fts5.js";
import type { HnswIndex } from "../src/hnsw.js";
import {
  assertCacheFilePath,
  assertEmbedDbFilePath,
  assertFeedbackFilePath,
  assertFtsIndexFilePath,
  assertHnswFilePath
} from "../src/persistence-path.js";
import { renameNote } from "../src/tools/write.js";
import { Vault } from "../src/vault.js";
import { type HnswRowMeta, VaultWatcher } from "../src/watcher.js";
import { windowsRelativePathProblem } from "../src/windows-path.js";

let root: string;
let outside: string;

const WATCHER_STATE_TIMEOUT_MS = 10_000;
const WATCHER_STABLE_WINDOW_MS = 1_200;
const WATCHER_POLL_MS = 75;
const DEFERRED_BARRIER_TIMEOUT_MS = 5_000;

const watcherEmbedder = {
  model: {
    alias: "windows-watcher-mock",
    hfId: "local/test-only",
    dim: 4,
    approxSizeMB: 0,
    dtype: "q8",
    multilingual: true,
    maxTokens: 128
  },
  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    return texts.map(() => new Float32Array([1, 0, 0, 0]));
  }
} satisfies Embedder;

interface WindowsWatcherFixture {
  vault: Vault;
  fts: FtsIndex;
  embedDb: EmbedDb;
  watcher: VaultWatcher;
  reindexedPaths: string[];
  hnswLabels: Set<number>;
  hnswRowsByLabel: Map<number, HnswRowMeta>;
}

interface WindowsWatcherSnapshot {
  diskNames: string[];
  ftsByMarker: Record<string, string[]>;
  embedByMarker: Record<string, string[]>;
  embedPaths: string[];
  embedRows: Array<{ label: number; relPath: string; textPreview: string }>;
  hnswLabels: number[];
  hnswRows: Array<{ label: number; relPath: string; textPreview: string }>;
  ftsAudit: ReturnType<FtsIndex["auditKind"]>;
  embedAudit: ReturnType<EmbedDb["auditKind"]>;
}

async function seedWindowsWatcherFixture(
  notes: Record<string, string>,
  options: { activationPathLimit?: number; configuredRoot?: string } = {}
): Promise<WindowsWatcherFixture> {
  const vault = new Vault(options.configuredRoot ?? root);
  await vault.ensureExists();
  const fts = new FtsIndex({ file: path.join(outside, "watcher.fts5.db"), vaultRoot: vault.root });
  const embedDb = new EmbedDb({
    file: path.join(outside, "watcher.embed.db"),
    vaultRoot: vault.root,
    modelAlias: watcherEmbedder.model.alias,
    dim: watcherEmbedder.model.dim,
    quantization: "f32"
  });
  try {
    await fts.open();
    await embedDb.open();

    for (const [relPath, content] of Object.entries(notes)) {
      const absPath = vault.resolveInside(relPath);
      await fs.mkdir(path.dirname(absPath), { recursive: true });
      await fs.writeFile(absPath, content);
      const stat = await fs.stat(absPath);
      fts.reindexFile(relPath, stat.mtimeMs, content);
      const embedded = await embedSingleNote(
        vault,
        watcherEmbedder,
        { relPath, absPath, mtimeMs: stat.mtimeMs },
        { lateChunkContext: 0 }
      );
      if (!embedded) throw new Error(`test fixture note unexpectedly produced no chunks: ${relPath}`);
      embedDb.upsertNote(relPath, stat.mtimeMs, embedded.rows);
    }

    const reindexedPaths: string[] = [];
    const originalReindexFile = fts.reindexFile.bind(fts);
    fts.reindexFile = (...args: Parameters<FtsIndex["reindexFile"]>) => {
      reindexedPaths.push(args[0]);
      return originalReindexFile(...args);
    };
    const seededRows = embedDb.getAllVectors();
    const hnswLabels = new Set(seededRows.map((row) => row.label));
    const hnswRowsByLabel = new Map<number, HnswRowMeta>(
      seededRows.map((row) => [
        row.label,
        {
          rel_path: row.rel_path,
          chunk_index: row.chunk_index,
          line_start: row.line_start,
          line_end: row.line_end,
          text_preview: row.text_preview,
          kind: row.kind
        }
      ])
    );
    const hnsw: HnswIndex = {
      dim: watcherEmbedder.model.dim,
      get size() {
        return hnswLabels.size;
      },
      searchKnn: () => ({ labels: [], distances: [] }),
      saveTo: async () => true,
      applyDiff(removeLabels, addPoints) {
        let removed = 0;
        for (const label of removeLabels) {
          if (hnswLabels.delete(label)) removed += 1;
        }
        for (const point of addPoints) hnswLabels.add(point.label);
        return { removed, added: addPoints.length };
      },
      resize: () => {},
      capacity: () => ({ currentCount: hnswLabels.size, maxElements: Number.MAX_SAFE_INTEGER })
    };
    const watcher = new VaultWatcher({
      vault,
      ftsIndex: fts,
      silent: true,
      ...(options.activationPathLimit !== undefined ? { activationPathLimit: options.activationPathLimit } : {})
    });
    watcher.attachEmbed(embedDb, watcherEmbedder, 0);
    watcher.attachHnsw(hnsw, hnswRowsByLabel);
    return { vault, fts, embedDb, watcher, reindexedPaths, hnswLabels, hnswRowsByLabel };
  } catch (error) {
    try {
      embedDb.close();
    } finally {
      fts.close();
    }
    throw error;
  }
}

async function snapshotWindowsWatcherState(
  fixture: WindowsWatcherFixture,
  markers: readonly string[]
): Promise<WindowsWatcherSnapshot> {
  const ftsByMarker: Record<string, string[]> = {};
  const embedByMarker: Record<string, string[]> = {};
  const embedRows = fixture.embedDb.getAllVectors();
  for (const marker of markers) {
    ftsByMarker[marker] = [
      ...new Set(fixture.fts.search(marker, { limit: 50 }).map((result) => result.rel_path))
    ].sort();
    embedByMarker[marker] = [
      ...new Set(embedRows.filter((row) => row.text_preview.includes(marker)).map((row) => row.rel_path))
    ].sort();
  }
  return {
    diskNames: (await fs.readdir(root)).sort(),
    ftsByMarker,
    embedByMarker,
    embedPaths: [...new Set(fixture.embedDb.getSourceStates("md").map((state) => state.rel_path))].sort(),
    embedRows: embedRows
      .map((row) => ({ label: row.label, relPath: row.rel_path, textPreview: row.text_preview }))
      .sort((a, b) => a.label - b.label),
    hnswLabels: [...fixture.hnswLabels].sort((a, b) => a - b),
    hnswRows: [...fixture.hnswRowsByLabel]
      .map(([label, row]) => ({ label, relPath: row.rel_path, textPreview: row.text_preview }))
      .sort((a, b) => a.label - b.label),
    ftsAudit: fixture.fts.auditKind("md"),
    embedAudit: fixture.embedDb.auditKind("md")
  };
}

function markerPaths(paths: Record<string, string[]>, marker: string): string[] {
  return paths[marker] ?? [];
}

function markerPathsInHnsw(snapshot: WindowsWatcherSnapshot, marker: string): string[] {
  return [
    ...new Set(snapshot.hnswRows.filter((row) => row.textPreview.includes(marker)).map((row) => row.relPath))
  ].sort();
}

function expectMarkerPaths(snapshot: WindowsWatcherSnapshot, marker: string, expected: readonly string[]): void {
  expect(markerPaths(snapshot.ftsByMarker, marker), `FTS paths for ${marker}`).toEqual(expected);
  expect(markerPaths(snapshot.embedByMarker, marker), `EmbedDb paths for ${marker}`).toEqual(expected);
  expect(markerPathsInHnsw(snapshot, marker), `HNSW paths for ${marker}`).toEqual(expected);
}

async function waitForStableWindowsWatcherState(
  observe: () => Promise<WindowsWatcherSnapshot>,
  expected: (snapshot: WindowsWatcherSnapshot) => boolean
): Promise<WindowsWatcherSnapshot> {
  const deadline = Date.now() + WATCHER_STATE_TIMEOUT_MS;
  let stableSince: number | null = null;
  let last: WindowsWatcherSnapshot | undefined;
  while (Date.now() < deadline) {
    last = await observe();
    if (expected(last)) {
      stableSince ??= Date.now();
      if (Date.now() - stableSince >= WATCHER_STABLE_WINDOW_MS) return last;
    } else {
      stableSince = null;
    }
    await new Promise((resolve) => setTimeout(resolve, WATCHER_POLL_MS));
  }
  throw new Error(`watcher state did not converge and remain stable: ${JSON.stringify(last)}`);
}

function watcherAuditsMatch(snapshot: WindowsWatcherSnapshot, expectedFiles: number): boolean {
  return (
    snapshot.ftsAudit.declared_files === expectedFiles &&
    snapshot.ftsAudit.indexed_files === expectedFiles &&
    snapshot.ftsAudit.mismatched_files === 0 &&
    snapshot.embedAudit.indexed_files === expectedFiles &&
    snapshot.embedAudit.mismatched_files === 0 &&
    JSON.stringify(snapshot.hnswLabels) === JSON.stringify(snapshot.embedRows.map((row) => row.label)) &&
    JSON.stringify(snapshot.hnswRows) === JSON.stringify(snapshot.embedRows)
  );
}

async function pathExistsWithoutSuppressingErrors(absPath: string): Promise<boolean> {
  try {
    await fs.stat(absPath);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function enqueueWatcherEvent(
  watcher: VaultWatcher,
  absPath: string,
  kind: "add" | "change" | "unlink"
): Promise<void> {
  await (
    watcher as unknown as {
      enqueueFileEvent(pathToFile: string, eventKind: "add" | "change" | "unlink"): Promise<void>;
    }
  ).enqueueFileEvent(absPath, kind);
}

async function writeWithLaterMtime(absPath: string, content: string): Promise<void> {
  const before = await fs.stat(absPath);
  await fs.writeFile(absPath, content);
  const nextMtime = new Date(Math.max(Date.now(), before.mtimeMs) + 60_000);
  await fs.utimes(absPath, nextMtime, nextMtime);
}

async function awaitDeferredBarrier(barrier: Promise<void>, label: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      barrier,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out waiting for deterministic test barrier: ${label}`)),
          DEFERRED_BARRIER_TIMEOUT_MS
        );
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function closeWindowsWatcherFixture(
  fixture: WindowsWatcherFixture,
  junctions: readonly string[] = []
): Promise<void> {
  try {
    await fixture.watcher.close();
  } finally {
    try {
      for (const junction of junctions) {
        if ((await fs.lstat(junction).catch(() => null))?.isSymbolicLink()) await fs.unlink(junction);
      }
    } finally {
      fixture.embedDb.close();
      fixture.fts.close();
    }
  }
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-win-vault-"));
  outside = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-win-outside-"));
});

afterEach(async () => {
  for (const junction of [
    path.join(root, "Outside"),
    path.join(root, "Incoming", "Outside"),
    path.join(outside, "Incoming.staging", "Outside")
  ]) {
    const junctionStat = await fs.lstat(junction).catch(() => null);
    if (junctionStat?.isSymbolicLink()) {
      await fs.unlink(junction);
    }
  }
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});

describe("VaultWatcher physical-alias convergence (S-8e)", () => {
  it("fans out a hardlink event, unlinks one name, and separates a replacement inode", async (ctx) => {
    const probeSource = path.join(root, ".hardlink-probe-source");
    const probeAlias = path.join(root, ".hardlink-probe-alias");
    await fs.writeFile(probeSource, "probe");
    try {
      await fs.link(probeSource, probeAlias);
    } catch (error) {
      if (process.env.CI && process.platform === "linux") {
        throw new Error(`mandatory Linux hardlink precondition failed: ${String(error)}`);
      }
      return ctx.skip();
    } finally {
      await fs.unlink(probeAlias).catch(() => {});
      await fs.unlink(probeSource).catch(() => {});
    }

    const configuredRootAlias = path.join(outside, "ConfiguredWatcherVault");
    await fs.symlink(root, configuredRootAlias, "junction");
    const fixture = await seedWindowsWatcherFixture(
      {
        "Primary.md": "# Shared\n\nhardlinkoldmarker\n",
        "Alias.md": "# Shared\n\nhardlinkoldmarker\n",
        "Keep.md": "# Keep\n\nhardlinkkeepmarker\n"
      },
      { configuredRoot: configuredRootAlias }
    );
    const primaryPath = path.join(root, "Primary.md");
    const aliasPath = path.join(root, "Alias.md");
    const configuredPrimaryPath = path.join(configuredRootAlias, "Primary.md");
    const configuredAliasPath = path.join(configuredRootAlias, "Alias.md");
    const outsideEventPath = path.join(outside, "Outside.md");
    const markers = [
      "hardlinkoldmarker",
      "hardlinknewmarker",
      "hardlinklatestmarker",
      "hardlinkreplacementmarker",
      "hardlinkkeepmarker",
      "hardlinkoutsidemarker"
    ] as const;
    const watcherInternals = fixture.watcher as unknown as {
      enqueueFileTask(
        absPath: string,
        context: string,
        task: () => Promise<void>,
        propagateFailure?: boolean
      ): Promise<void>;
    };
    const enqueueSpy = vi.spyOn(watcherInternals, "enqueueFileTask");

    try {
      await fs.unlink(aliasPath);
      await fs.link(primaryPath, aliasPath);
      const [primaryStat, aliasStat] = await Promise.all([
        fs.lstat(primaryPath, { bigint: true }),
        fs.lstat(aliasPath, { bigint: true })
      ]);
      expect(primaryStat.isFile()).toBe(true);
      expect(aliasStat.isFile()).toBe(true);
      expect(primaryStat.isSymbolicLink()).toBe(false);
      expect(aliasStat.isSymbolicLink()).toBe(false);
      expect(aliasStat.dev).toBe(primaryStat.dev);
      expect(aliasStat.ino).toBe(primaryStat.ino);
      expect(primaryStat.nlink).toBeGreaterThanOrEqual(2n);
      if (process.platform === "linux") expect(primaryStat.ino).not.toBe(0n);

      await writeWithLaterMtime(primaryPath, "# Shared\n\nhardlinknewmarker is visible through both physical names.\n");
      await expect(fs.readFile(aliasPath, "utf8")).resolves.toContain("hardlinknewmarker");

      // NEGATIVE setup: both paths already expose the new bytes, but no watcher
      // event has run, so every derived sink must still hold the old generation.
      const beforeEvent = await snapshotWindowsWatcherState(fixture, markers);
      expectMarkerPaths(beforeEvent, "hardlinkoldmarker", ["Alias.md", "Primary.md"]);
      expectMarkerPaths(beforeEvent, "hardlinknewmarker", []);
      expect(watcherAuditsMatch(beforeEvent, 3)).toBe(true);

      // NEGATIVE control: an outside path is rejected before it can acquire a
      // per-file queue key or surface content in any derived sink.
      await fs.writeFile(outsideEventPath, "# Outside\n\nhardlinkoutsidemarker\n");
      const queueCallsBeforeOutside = enqueueSpy.mock.calls.length;
      await enqueueWatcherEvent(fixture.watcher, outsideEventPath, "change");
      expect(enqueueSpy.mock.calls).toHaveLength(queueCallsBeforeOutside);
      expectMarkerPaths(await snapshotWindowsWatcherState(fixture, markers), "hardlinkoutsidemarker", []);
      expect(fixture.reindexedPaths).toEqual([]);

      // POSITIVE control: the event arrives through the configured junction,
      // while queueing and every searchable identity use the canonical root.
      await enqueueWatcherEvent(fixture.watcher, configuredPrimaryPath, "change");
      expect(enqueueSpy.mock.calls.at(-1)?.[0]).toBe(fixture.vault.resolveInside("Primary.md"));
      if (process.platform === "win32") {
        const rootPrefix = path.parse(fixture.vault.root).root;
        const rootRemainder = fixture.vault.root.slice(rootPrefix.length);
        const caseVariantRoot = `${rootPrefix}${rootRemainder.replace(/[A-Za-z]/u, (letter) =>
          letter === letter.toUpperCase() ? letter.toLowerCase() : letter.toUpperCase()
        )}`;
        expect(caseVariantRoot).not.toBe(fixture.vault.root);
        const queueCallsBeforeCaseVariant = enqueueSpy.mock.calls.length;
        await enqueueWatcherEvent(fixture.watcher, path.join(caseVariantRoot, "Primary.md"), "change");
        expect(enqueueSpy.mock.calls).toHaveLength(queueCallsBeforeCaseVariant + 1);
        expect(enqueueSpy.mock.calls.at(-1)?.[0]).toBe(fixture.vault.resolveInside("Primary.md"));
      }

      const afterSharedChange = await snapshotWindowsWatcherState(fixture, markers);
      expectMarkerPaths(afterSharedChange, "hardlinkoldmarker", []);
      expectMarkerPaths(afterSharedChange, "hardlinknewmarker", ["Alias.md", "Primary.md"]);
      expectMarkerPaths(afterSharedChange, "hardlinkkeepmarker", ["Keep.md"]);
      const [currentPrimaryStat, currentAliasStat, keepStat] = await Promise.all(
        [primaryPath, aliasPath, path.join(root, "Keep.md")].map((p) => fs.lstat(p, { bigint: true }))
      );
      const identityNarrowsToHardlinks =
        [currentPrimaryStat, currentAliasStat, keepStat].every((stat) => stat.dev !== 0n && stat.ino !== 0n) &&
        (keepStat.dev !== currentPrimaryStat.dev || keepStat.ino !== currentPrimaryStat.ino);
      expect([...new Set(fixture.reindexedPaths)].sort()).toEqual(
        identityNarrowsToHardlinks ? ["Alias.md", "Primary.md"] : ["Alias.md", "Keep.md", "Primary.md"]
      );
      expect(watcherAuditsMatch(afterSharedChange, 3)).toBe(true);

      await fs.unlink(primaryPath);
      await enqueueWatcherEvent(fixture.watcher, configuredPrimaryPath, "unlink");

      const afterPrimaryUnlink = await snapshotWindowsWatcherState(fixture, markers);
      expect(afterPrimaryUnlink.diskNames).not.toContain("Primary.md");
      expectMarkerPaths(afterPrimaryUnlink, "hardlinknewmarker", ["Alias.md"]);
      expect(afterPrimaryUnlink.embedPaths).toEqual(["Alias.md", "Keep.md"]);
      expect(watcherAuditsMatch(afterPrimaryUnlink, 2)).toBe(true);

      // Reusing the exact pathname creates a new inode. The old Alias.md group
      // must not pull this replacement into later physical-alias fan-out.
      await fs.writeFile(
        primaryPath,
        "# Replacement\n\nhardlinkreplacementmarker belongs only to the replacement inode.\n"
      );
      await enqueueWatcherEvent(fixture.watcher, configuredPrimaryPath, "add");
      await writeWithLaterMtime(
        aliasPath,
        "# Shared\n\nhardlinklatestmarker belongs only to the surviving hardlink inode.\n"
      );
      await enqueueWatcherEvent(fixture.watcher, configuredAliasPath, "change");

      const afterReplacement = await snapshotWindowsWatcherState(fixture, markers);
      expectMarkerPaths(afterReplacement, "hardlinknewmarker", []);
      expectMarkerPaths(afterReplacement, "hardlinklatestmarker", ["Alias.md"]);
      expectMarkerPaths(afterReplacement, "hardlinkreplacementmarker", ["Primary.md"]);
      expectMarkerPaths(afterReplacement, "hardlinkkeepmarker", ["Keep.md"]);
      expect(afterReplacement.embedPaths).toEqual(["Alias.md", "Keep.md", "Primary.md"]);
      expect(watcherAuditsMatch(afterReplacement, 3)).toBe(true);
    } finally {
      enqueueSpy.mockRestore();
      await closeWindowsWatcherFixture(fixture, [configuredRootAlias]);
    }
  });

  it("refreshes the surviving alias when the first observed event is unlink", async (ctx) => {
    const probeSource = path.join(root, ".unlink-first-probe-source");
    const probeAlias = path.join(root, ".unlink-first-probe-alias");
    await fs.writeFile(probeSource, "probe");
    try {
      await fs.link(probeSource, probeAlias);
    } catch (error) {
      if (process.env.CI && process.platform === "linux") {
        throw new Error(`mandatory Linux hardlink precondition failed: ${String(error)}`);
      }
      return ctx.skip();
    } finally {
      await fs.unlink(probeAlias).catch(() => {});
      await fs.unlink(probeSource).catch(() => {});
    }

    const fixture = await seedWindowsWatcherFixture({
      "A.md": "# Shared\n\nunlinkfirstoldmarker\n",
      "B.md": "# Shared\n\nunlinkfirstoldmarker\n"
    });
    const aPath = path.join(root, "A.md");
    const bPath = path.join(root, "B.md");
    const markers = ["unlinkfirstoldmarker", "unlinkfirstnewmarker"] as const;

    try {
      await fs.unlink(bPath);
      await fs.link(aPath, bPath);
      await writeWithLaterMtime(aPath, "# Shared\n\nunlinkfirstnewmarker survives through B.\n");
      await fs.unlink(aPath);
      await expect(fs.readFile(bPath, "utf8")).resolves.toContain("unlinkfirstnewmarker");

      // NEGATIVE control: the only surviving directory entry already exposes
      // the new bytes, while all three derived sinks still expose both old rows.
      const beforeEvent = await snapshotWindowsWatcherState(fixture, markers);
      expect(beforeEvent.diskNames).toEqual(["B.md"]);
      expectMarkerPaths(beforeEvent, "unlinkfirstoldmarker", ["A.md", "B.md"]);
      expectMarkerPaths(beforeEvent, "unlinkfirstnewmarker", []);

      // Model a coalesced native stream whose first and only observation is the
      // unlink. No earlier change event may prime the physical-alias registry.
      await enqueueWatcherEvent(fixture.watcher, aPath, "unlink");

      const reconciled = await snapshotWindowsWatcherState(fixture, markers);
      expectMarkerPaths(reconciled, "unlinkfirstoldmarker", []);
      expectMarkerPaths(reconciled, "unlinkfirstnewmarker", ["B.md"]);
      expect(reconciled.embedPaths).toEqual(["B.md"]);
      expect([...new Set(fixture.reindexedPaths)]).toEqual(["B.md"]);
      expect(watcherAuditsMatch(reconciled, 1)).toBe(true);
    } finally {
      await closeWindowsWatcherFixture(fixture);
    }
  });

  it("replans when a new hardlink appears after missing-origin inventory", async (ctx) => {
    const probeSource = path.join(root, ".post-inventory-link-probe-source");
    const probeAlias = path.join(root, ".post-inventory-link-probe-alias");
    await fs.writeFile(probeSource, "probe");
    try {
      await fs.link(probeSource, probeAlias);
    } catch (error) {
      if (process.env.CI && process.platform === "linux") {
        throw new Error(`mandatory Linux hardlink precondition failed: ${String(error)}`);
      }
      return ctx.skip();
    } finally {
      await fs.unlink(probeAlias).catch(() => {});
      await fs.unlink(probeSource).catch(() => {});
    }

    const fixture = await seedWindowsWatcherFixture({
      "A.md": "# Shared\n\npostinventoryoldmarker\n",
      "B.md": "# Shared\n\npostinventoryoldmarker\n"
    });
    const aPath = path.join(root, "A.md");
    const bPath = path.join(root, "B.md");
    const cPath = path.join(root, "C.md");
    const markers = ["postinventoryoldmarker", "postinventorynewmarker"] as const;
    const watcherInternals = fixture.watcher as unknown as {
      inspectVisibleAliasInventoryInLane(): Promise<unknown>;
    };
    const originalInventory = watcherInternals.inspectVisibleAliasInventoryInLane.bind(fixture.watcher);
    let createdC = false;
    const inventorySpy = vi
      .spyOn(watcherInternals, "inspectVisibleAliasInventoryInLane")
      .mockImplementation(async () => {
        const inventory = await originalInventory();
        if (!createdC) {
          await fs.link(bPath, cPath);
          createdC = true;
        }
        return inventory;
      });

    try {
      await fs.unlink(bPath);
      await fs.link(aPath, bPath);
      await writeWithLaterMtime(aPath, "# Shared\n\npostinventorynewmarker\n");
      await fs.unlink(aPath);

      // NEGATIVE control: the first missing-origin inventory can only observe
      // B. C does not exist until that exact snapshot has resolved, while the
      // sinks still retain the old A/B generation.
      expect(await fs.stat(cPath).catch(() => null)).toBeNull();
      const beforeEvent = await snapshotWindowsWatcherState(fixture, markers);
      expect(beforeEvent.diskNames).toEqual(["B.md"]);
      expectMarkerPaths(beforeEvent, "postinventoryoldmarker", ["A.md", "B.md"]);
      expectMarkerPaths(beforeEvent, "postinventorynewmarker", []);

      await enqueueWatcherEvent(fixture.watcher, aPath, "unlink");

      expect(createdC, "C must be created after the first inventory snapshot and before path locks").toBe(true);
      expect(inventorySpy.mock.calls.length).toBeGreaterThanOrEqual(2);
      const [bStat, cStat] = await Promise.all([fs.lstat(bPath, { bigint: true }), fs.lstat(cPath, { bigint: true })]);
      expect(bStat.dev).toBe(cStat.dev);
      expect(bStat.ino).toBe(cStat.ino);
      expect(bStat.nlink).toBeGreaterThanOrEqual(2n);

      const reconciled = await snapshotWindowsWatcherState(fixture, markers);
      expectMarkerPaths(reconciled, "postinventoryoldmarker", []);
      expectMarkerPaths(reconciled, "postinventorynewmarker", ["B.md", "C.md"]);
      expect(reconciled.embedPaths).toEqual(["B.md", "C.md"]);
      expect([...new Set(fixture.reindexedPaths)].sort()).toEqual(["B.md", "C.md"]);
      expect(watcherAuditsMatch(reconciled, 2)).toBe(true);
    } finally {
      inventorySpy.mockRestore();
      await closeWindowsWatcherFixture(fixture);
    }
  });

  it("upserts a missing origin recreated while its surviving alias is staged", async (ctx) => {
    const probeSource = path.join(root, ".recreated-origin-probe-source");
    const probeAlias = path.join(root, ".recreated-origin-probe-alias");
    await fs.writeFile(probeSource, "probe");
    try {
      await fs.link(probeSource, probeAlias);
    } catch (error) {
      if (process.env.CI && process.platform === "linux") {
        throw new Error(`mandatory Linux hardlink precondition failed: ${String(error)}`);
      }
      return ctx.skip();
    } finally {
      await fs.unlink(probeAlias).catch(() => {});
      await fs.unlink(probeSource).catch(() => {});
    }

    const fixture = await seedWindowsWatcherFixture({
      "A.md": "# Shared\n\nrecreatedoriginoldmarker\n",
      "B.md": "# Shared\n\nrecreatedoriginoldmarker\n"
    });
    const aPath = path.join(root, "A.md");
    const bPath = path.join(root, "B.md");
    const markers = ["recreatedoriginoldmarker", "recreatedoriginnewmarker"] as const;
    const watcherInternals = fixture.watcher as unknown as {
      stageAliasPath(live: { absPath: string; relPath: string }): Promise<unknown>;
    };

    try {
      await fs.unlink(bPath);
      await fs.link(aPath, bPath);
      // Prime the physical group before A disappears. The tested event below
      // remains a single unlink whose plan includes surviving B.
      await enqueueWatcherEvent(fixture.watcher, aPath, "change");
      fixture.reindexedPaths.length = 0;
      await fs.unlink(aPath);

      // NEGATIVE control: A is absent on disk but still present in every sink;
      // the replacement generation does not exist before the unlink handler.
      const beforeEvent = await snapshotWindowsWatcherState(fixture, markers);
      expect(beforeEvent.diskNames).toEqual(["B.md"]);
      expectMarkerPaths(beforeEvent, "recreatedoriginoldmarker", ["A.md", "B.md"]);
      expectMarkerPaths(beforeEvent, "recreatedoriginnewmarker", []);

      const originalStageAliasPath = watcherInternals.stageAliasPath.bind(fixture.watcher);
      let recreated = false;
      const stageSpy = vi.spyOn(watcherInternals, "stageAliasPath").mockImplementation(async (live) => {
        const staged = await originalStageAliasPath(live);
        if (!recreated && live.relPath === "B.md") {
          const survivingStat = await fs.stat(bPath);
          await fs.writeFile(aPath, "# Replacement\n\nrecreatedoriginnewmarker\n");
          const replacementMtime = new Date(Math.max(Date.now(), survivingStat.mtimeMs) + 180_000);
          await fs.utimes(aPath, replacementMtime, replacementMtime);
          recreated = true;
        }
        return staged;
      });
      try {
        await enqueueWatcherEvent(fixture.watcher, aPath, "unlink");
      } finally {
        stageSpy.mockRestore();
      }

      expect(recreated, "the controlled origin recreation must execute during B staging").toBe(true);
      const [aStat, bStat] = await Promise.all([fs.lstat(aPath, { bigint: true }), fs.lstat(bPath, { bigint: true })]);
      expect(`${aStat.dev}:${aStat.ino}`).not.toBe(`${bStat.dev}:${bStat.ino}`);

      const reconciled = await snapshotWindowsWatcherState(fixture, markers);
      expectMarkerPaths(reconciled, "recreatedoriginoldmarker", ["B.md"]);
      expectMarkerPaths(reconciled, "recreatedoriginnewmarker", ["A.md"]);
      expect(reconciled.embedPaths).toEqual(["A.md", "B.md"]);
      expect(fixture.reindexedPaths).toContain("A.md");
      expect(watcherAuditsMatch(reconciled, 2)).toBe(true);
    } finally {
      await closeWindowsWatcherFixture(fixture);
    }
  });

  it("replans when alias membership changes before the plan lock", async (ctx) => {
    const probeSource = path.join(root, ".prelock-race-probe-source");
    const probeAlias = path.join(root, ".prelock-race-probe-alias");
    await fs.writeFile(probeSource, "probe");
    try {
      await fs.link(probeSource, probeAlias);
    } catch (error) {
      if (process.env.CI && process.platform === "linux") {
        throw new Error(`mandatory Linux hardlink precondition failed: ${String(error)}`);
      }
      return ctx.skip();
    } finally {
      await fs.unlink(probeAlias).catch(() => {});
      await fs.unlink(probeSource).catch(() => {});
    }

    const fixture = await seedWindowsWatcherFixture({
      "A.md": "# Shared\n\nprelockraceoldmarker\n",
      "B.md": "# Shared\n\nprelockraceoldmarker\n"
    });
    const aPath = path.join(root, "A.md");
    const bPath = path.join(root, "B.md");
    const markers = ["prelockraceoldmarker", "prelockracegroupmarker", "prelockracereplacementmarker"] as const;
    const watcherInternals = fixture.watcher as unknown as {
      inspectVisibleAliasInventoryInLane(): Promise<unknown>;
    };
    const originalInventory = watcherInternals.inspectVisibleAliasInventoryInLane.bind(fixture.watcher);
    let replaced = false;
    const inventorySpy = vi
      .spyOn(watcherInternals, "inspectVisibleAliasInventoryInLane")
      .mockImplementation(async () => {
        if (!replaced) {
          const oldBStat = await fs.stat(bPath);
          await fs.unlink(bPath);
          await fs.writeFile(bPath, "# Replacement\n\nprelockracereplacementmarker\n");
          const replacementMtime = new Date(Math.max(Date.now(), oldBStat.mtimeMs) + 120_000);
          await fs.utimes(bPath, replacementMtime, replacementMtime);
          replaced = true;
        }
        return originalInventory();
      });

    try {
      await fs.unlink(bPath);
      await fs.link(aPath, bPath);
      await writeWithLaterMtime(aPath, "# Shared\n\nprelockracegroupmarker\n");
      await expect(fs.readFile(bPath, "utf8")).resolves.toContain("prelockracegroupmarker");

      // NEGATIVE control: origin inspection will observe the two-link
      // generation, while every sink still holds the old bytes. The spy changes
      // B only after handle() enters the pre-lock inventory seam.
      const beforeEvent = await snapshotWindowsWatcherState(fixture, markers);
      expectMarkerPaths(beforeEvent, "prelockraceoldmarker", ["A.md", "B.md"]);
      expectMarkerPaths(beforeEvent, "prelockracegroupmarker", []);
      expectMarkerPaths(beforeEvent, "prelockracereplacementmarker", []);

      await enqueueWatcherEvent(fixture.watcher, aPath, "change");

      expect(inventorySpy).toHaveBeenCalled();
      expect(replaced, "the controlled membership change must execute inside pre-lock planning").toBe(true);
      const [aStat, bStat] = await Promise.all([fs.lstat(aPath, { bigint: true }), fs.lstat(bPath, { bigint: true })]);
      expect(`${aStat.dev}:${aStat.ino}`).not.toBe(`${bStat.dev}:${bStat.ino}`);

      const reconciled = await snapshotWindowsWatcherState(fixture, markers);
      expectMarkerPaths(reconciled, "prelockraceoldmarker", []);
      expectMarkerPaths(reconciled, "prelockracegroupmarker", ["A.md"]);
      expectMarkerPaths(reconciled, "prelockracereplacementmarker", ["B.md"]);
      expect(reconciled.embedPaths).toEqual(["A.md", "B.md"]);
      expect([...new Set(fixture.reindexedPaths)].sort()).toEqual(["A.md", "B.md"]);
      expect(watcherAuditsMatch(reconciled, 2)).toBe(true);
    } finally {
      inventorySpy.mockRestore();
      await closeWindowsWatcherFixture(fixture);
    }
  });

  it("reconciles a non-origin alias replaced during fan-out", async (ctx) => {
    const probeSource = path.join(root, ".replacement-race-probe-source");
    const probeAlias = path.join(root, ".replacement-race-probe-alias");
    await fs.writeFile(probeSource, "probe");
    try {
      await fs.link(probeSource, probeAlias);
    } catch (error) {
      if (process.env.CI && process.platform === "linux") {
        throw new Error(`mandatory Linux hardlink precondition failed: ${String(error)}`);
      }
      return ctx.skip();
    } finally {
      await fs.unlink(probeAlias).catch(() => {});
      await fs.unlink(probeSource).catch(() => {});
    }

    const fixture = await seedWindowsWatcherFixture({
      "A.md": "# Shared\n\nreplacementraceoldmarker\n",
      "B.md": "# Shared\n\nreplacementraceoldmarker\n"
    });
    const aPath = path.join(root, "A.md");
    const bPath = path.join(root, "B.md");
    const markers = [
      "replacementraceoldmarker",
      "replacementracegroupmarker",
      "replacementracenewinodemarker"
    ] as const;
    const watcherInternals = fixture.watcher as unknown as {
      stageAliasPath(live: { absPath: string; relPath: string }): Promise<unknown>;
    };
    const originalStageAliasPath = watcherInternals.stageAliasPath.bind(fixture.watcher);
    let replaced = false;
    const stageSpy = vi.spyOn(watcherInternals, "stageAliasPath").mockImplementation(async (live) => {
      const staged = await originalStageAliasPath(live);
      if (!replaced && live.relPath === "A.md") {
        const oldBStat = await fs.stat(bPath);
        await fs.unlink(bPath);
        await fs.writeFile(bPath, "# Replacement\n\nreplacementracenewinodemarker\n");
        const replacementMtime = new Date(Math.max(Date.now(), oldBStat.mtimeMs) + 120_000);
        await fs.utimes(bPath, replacementMtime, replacementMtime);
        replaced = true;
      }
      return staged;
    });

    try {
      await fs.unlink(bPath);
      await fs.link(aPath, bPath);
      await writeWithLaterMtime(aPath, "# Shared\n\nreplacementracegroupmarker\n");
      await expect(fs.readFile(bPath, "utf8")).resolves.toContain("replacementracegroupmarker");

      // NEGATIVE control: both physical names expose the changed hardlink
      // generation, but every sink still holds the old generation.
      const beforeEvent = await snapshotWindowsWatcherState(fixture, markers);
      expectMarkerPaths(beforeEvent, "replacementraceoldmarker", ["A.md", "B.md"]);
      expectMarkerPaths(beforeEvent, "replacementracegroupmarker", []);
      expectMarkerPaths(beforeEvent, "replacementracenewinodemarker", []);

      await enqueueWatcherEvent(fixture.watcher, aPath, "change");

      expect(replaced, "the controlled non-origin replacement must execute during fan-out").toBe(true);
      const [aStat, bStat] = await Promise.all([fs.lstat(aPath, { bigint: true }), fs.lstat(bPath, { bigint: true })]);
      expect(aStat.isFile() && !aStat.isSymbolicLink()).toBe(true);
      expect(bStat.isFile() && !bStat.isSymbolicLink()).toBe(true);
      expect(`${aStat.dev}:${aStat.ino}`).not.toBe(`${bStat.dev}:${bStat.ino}`);

      const reconciled = await snapshotWindowsWatcherState(fixture, markers);
      expect(markerPaths(reconciled.ftsByMarker, "replacementraceoldmarker")).toEqual([]);
      expect(markerPaths(reconciled.embedByMarker, "replacementraceoldmarker")).toEqual([]);
      expect(markerPaths(reconciled.ftsByMarker, "replacementracegroupmarker")).toEqual(["A.md"]);
      expect(markerPaths(reconciled.embedByMarker, "replacementracegroupmarker")).toEqual(["A.md"]);
      expect(markerPaths(reconciled.ftsByMarker, "replacementracenewinodemarker")).toEqual(["B.md"]);
      expect(markerPaths(reconciled.embedByMarker, "replacementracenewinodemarker")).toEqual(["B.md"]);
      // The first plan observed a physical-membership drift after staging A.
      // SQLite is fully replanned and authoritative, while the process-local
      // graph is deliberately quarantined until restart rather than adopting
      // a piecemeal generation. Its retained metadata cannot be an egress while
      // hnswUsable is false.
      expect(markerPathsInHnsw(reconciled, "replacementraceoldmarker")).toEqual(["A.md", "B.md"]);
      expect(markerPathsInHnsw(reconciled, "replacementracegroupmarker")).toEqual([]);
      expect(markerPathsInHnsw(reconciled, "replacementracenewinodemarker")).toEqual([]);
      expect(fixture.watcher.searchHealth.hnswUsable).toBe(false);
      expect(reconciled.embedPaths).toEqual(["A.md", "B.md"]);
      expect([...new Set(fixture.reindexedPaths)].sort()).toEqual(["A.md", "B.md"]);
      expect(reconciled.ftsAudit).toMatchObject({ declared_files: 2, indexed_files: 2, mismatched_files: 0 });
      expect(reconciled.embedAudit).toMatchObject({ indexed_files: 2, mismatched_files: 0 });
      expect(watcherAuditsMatch(reconciled, 2)).toBe(false);
    } finally {
      stageSpy.mockRestore();
      await closeWindowsWatcherFixture(fixture);
    }
  });

  it("serializes overlapping alias events and makes close drain the locked work", async (ctx) => {
    const probeSource = path.join(root, ".alias-lock-probe-source");
    const probeAlias = path.join(root, ".alias-lock-probe-alias");
    await fs.writeFile(probeSource, "probe");
    try {
      await fs.link(probeSource, probeAlias);
    } catch (error) {
      if (process.env.CI && process.platform === "linux") {
        throw new Error(`mandatory Linux hardlink precondition failed: ${String(error)}`);
      }
      return ctx.skip();
    } finally {
      await fs.unlink(probeAlias).catch(() => {});
      await fs.unlink(probeSource).catch(() => {});
    }

    const fixture = await seedWindowsWatcherFixture({
      "A.md": "# Shared\n\naliaslockoldmarker\n",
      "B.md": "# Shared\n\naliaslockoldmarker\n"
    });
    const aPath = path.join(root, "A.md");
    const bPath = path.join(root, "B.md");
    const markers = ["aliaslockoldmarker", "aliaslocknewmarker"] as const;
    const watcherInternals = fixture.watcher as unknown as {
      stageAliasPath(live: { absPath: string; relPath: string }): Promise<unknown>;
      withPhysicalAliasLocks(keys: ReadonlyArray<string>, task: () => Promise<unknown>): Promise<unknown>;
      physicalAliasLockTails: Map<string, Promise<void>>;
      physicalIdentityByPath: Map<string, string>;
      physicalPathsByIdentity: Map<string, Set<string>>;
      physicalKnownPaths: Set<string>;
    };

    let markFirstStageEntered: (() => void) | undefined;
    const firstStageEntered = new Promise<void>((resolve) => {
      markFirstStageEntered = resolve;
    });
    let releaseFirstStage: (() => void) | undefined;
    const firstStageRelease = new Promise<void>((resolve) => {
      releaseFirstStage = resolve;
    });
    let markSecondLockAttempted: (() => void) | undefined;
    const secondLockAttempted = new Promise<void>((resolve) => {
      markSecondLockAttempted = resolve;
    });

    const originalStageAliasPath = watcherInternals.stageAliasPath.bind(fixture.watcher);
    const originalWithPhysicalAliasLocks = watcherInternals.withPhysicalAliasLocks.bind(fixture.watcher);
    const stageCalls: string[] = [];
    let firstStageBlocked = false;
    let aliasPlanLockAttempts = 0;
    let protectedPlansStarted = 0;
    let activeProtectedPlans = 0;
    let protectedPlansOverlapped = false;
    const stageSpy = vi.spyOn(watcherInternals, "stageAliasPath").mockImplementation(async (live) => {
      stageCalls.push(live.relPath);
      if (!firstStageBlocked) {
        firstStageBlocked = true;
        markFirstStageEntered?.();
        await firstStageRelease;
      }
      return originalStageAliasPath(live);
    });
    const lockSpy = vi.spyOn(watcherInternals, "withPhysicalAliasLocks").mockImplementation(async (keys, task) => {
      const isAliasPlan = keys.some((key) => key.startsWith("path:"));
      if (!isAliasPlan) return originalWithPhysicalAliasLocks(keys, task);

      aliasPlanLockAttempts += 1;
      if (aliasPlanLockAttempts === 2) markSecondLockAttempted?.();
      return originalWithPhysicalAliasLocks(keys, async () => {
        protectedPlansStarted += 1;
        if (activeProtectedPlans > 0) protectedPlansOverlapped = true;
        activeProtectedPlans += 1;
        try {
          return await task();
        } finally {
          activeProtectedPlans -= 1;
        }
      });
    });

    let eventA: Promise<void> | undefined;
    let eventB: Promise<void> | undefined;
    let closeTask: Promise<void> | undefined;
    try {
      await fs.unlink(bPath);
      await fs.link(aPath, bPath);
      await writeWithLaterMtime(aPath, "# Shared\n\naliaslocknewmarker\n");
      await expect(fs.readFile(bPath, "utf8")).resolves.toContain("aliaslocknewmarker");

      // NEGATIVE setup: both aliases expose the changed bytes, but all sinks
      // still hold the old generation before either concurrent event commits.
      const beforeEvents = await snapshotWindowsWatcherState(fixture, markers);
      expectMarkerPaths(beforeEvents, "aliaslockoldmarker", ["A.md", "B.md"]);
      expectMarkerPaths(beforeEvents, "aliaslocknewmarker", []);

      eventA = enqueueWatcherEvent(fixture.watcher, aPath, "change");
      await awaitDeferredBarrier(firstStageEntered, "first alias stage");
      eventB = enqueueWatcherEvent(fixture.watcher, bPath, "change");
      await awaitDeferredBarrier(secondLockAttempted, "second overlapping alias-lock attempt");

      // NEGATIVE control: the second handler has demonstrably reached lock
      // reservation, but its protected task/stage cannot enter while the first
      // plan owns the overlapping physical/path locks.
      expect(aliasPlanLockAttempts).toBe(2);
      expect(protectedPlansStarted).toBe(1);
      expect(activeProtectedPlans).toBe(1);
      expect(protectedPlansOverlapped).toBe(false);
      expect(stageCalls).toHaveLength(1);
      expect(stageCalls[0]).toMatch(/^(?:A|B)\.md$/);
      expect(watcherInternals.physicalAliasLockTails.size).toBeGreaterThan(0);

      let closeSettled = false;
      closeTask = fixture.watcher.close().then(() => {
        closeSettled = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(closeSettled, "close must remain pending while accepted alias work holds the barrier").toBe(false);

      releaseFirstStage?.();
      await Promise.all([eventA, eventB, closeTask]);

      expect(protectedPlansOverlapped).toBe(false);
      expect(activeProtectedPlans).toBe(0);
      expect(protectedPlansStarted).toBeGreaterThanOrEqual(2);
      const reconciled = await snapshotWindowsWatcherState(fixture, markers);
      expectMarkerPaths(reconciled, "aliaslockoldmarker", []);
      expectMarkerPaths(reconciled, "aliaslocknewmarker", ["A.md", "B.md"]);
      expect(reconciled.embedPaths).toEqual(["A.md", "B.md"]);
      expect([...new Set(fixture.reindexedPaths)].sort()).toEqual(["A.md", "B.md"]);
      expect(watcherAuditsMatch(reconciled, 2)).toBe(true);
      expect(watcherInternals.physicalAliasLockTails.size).toBe(0);
      expect(watcherInternals.physicalIdentityByPath.size).toBe(0);
      expect(watcherInternals.physicalPathsByIdentity.size).toBe(0);
      expect(watcherInternals.physicalKnownPaths.size).toBe(0);
    } finally {
      releaseFirstStage?.();
      if (eventA) await eventA.catch(() => {});
      if (eventB) await eventB.catch(() => {});
      if (closeTask) await closeTask.catch(() => {});
      stageSpy.mockRestore();
      lockSpy.mockRestore();
      await closeWindowsWatcherFixture(fixture);
    }
  });

  it("makes close drain a tracked physical-alias seed", async () => {
    const fixture = await seedWindowsWatcherFixture({
      "Seeded.md": "# Seeded\n\ntrackedseedmarker\n"
    });
    const markers = ["trackedseedmarker"] as const;
    const watcherInternals = fixture.watcher as unknown as {
      runTrackedPhysicalAliasSeed(): Promise<void>;
      inspectVisibleAliasInventoryInLane(): Promise<unknown>;
      physicalAliasLockTails: Map<string, Promise<void>>;
      physicalIdentityByPath: Map<string, string>;
      physicalPathsByIdentity: Map<string, Set<string>>;
      physicalKnownPaths: Set<string>;
    };

    let markInventoryEntered: (() => void) | undefined;
    const inventoryEntered = new Promise<void>((resolve) => {
      markInventoryEntered = resolve;
    });
    let releaseInventory: (() => void) | undefined;
    const inventoryRelease = new Promise<void>((resolve) => {
      releaseInventory = resolve;
    });
    const originalInventory = watcherInternals.inspectVisibleAliasInventoryInLane.bind(fixture.watcher);
    const inventorySpy = vi
      .spyOn(watcherInternals, "inspectVisibleAliasInventoryInLane")
      .mockImplementation(async () => {
        markInventoryEntered?.();
        await inventoryRelease;
        return originalInventory();
      });

    let seedTask: Promise<void> | undefined;
    let closeTask: Promise<void> | undefined;
    try {
      const beforeSeed = await snapshotWindowsWatcherState(fixture, markers);
      seedTask = watcherInternals.runTrackedPhysicalAliasSeed();
      await awaitDeferredBarrier(inventoryEntered, "tracked seed inventory");

      // NEGATIVE control: the tracked seed is accepted and demonstrably blocked
      // inside inventory. close must not resolve or clear ownership underneath
      // it; otherwise the released seed could repopulate registries post-close.
      expect(watcherInternals.physicalIdentityByPath.size).toBe(0);
      let closeSettled = false;
      closeTask = fixture.watcher.close().then(() => {
        closeSettled = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(closeSettled, "close must remain pending while the tracked seed holds inventory").toBe(false);

      releaseInventory?.();
      await Promise.all([seedTask, closeTask]);

      const afterClose = await snapshotWindowsWatcherState(fixture, markers);
      expect(afterClose.embedRows).toEqual(beforeSeed.embedRows);
      expect(afterClose.hnswRows).toEqual(beforeSeed.hnswRows);
      expectMarkerPaths(afterClose, "trackedseedmarker", ["Seeded.md"]);
      expect(watcherInternals.physicalAliasLockTails.size).toBe(0);
      expect(watcherInternals.physicalIdentityByPath.size).toBe(0);
      expect(watcherInternals.physicalPathsByIdentity.size).toBe(0);
      expect(watcherInternals.physicalKnownPaths.size).toBe(0);
    } finally {
      releaseInventory?.();
      if (seedTask) await seedTask.catch(() => {});
      if (closeTask) await closeTask.catch(() => {});
      inventorySpy.mockRestore();
      await closeWindowsWatcherFixture(fixture);
    }
  });

  it("uses seeded identity to narrow a missing-origin commit without touching unrelated notes", async () => {
    const fixture = await seedWindowsWatcherFixture({
      "A.md": "# A\n\nseedunlinkamarker\n",
      "Keep.md": "# Keep\n\nseedkeepmarker\n"
    });
    const aPath = path.join(root, "A.md");
    const canonicalAPath = fixture.vault.resolveInside("A.md");
    const canonicalKeepPath = fixture.vault.resolveInside("Keep.md");
    const markers = ["seedunlinkamarker", "seedkeepmarker"] as const;
    const watcherInternals = fixture.watcher as unknown as {
      seedPhysicalAliasRegistry(): Promise<void>;
      inspectVisibleAliasInventoryInLane(): Promise<unknown>;
      physicalAliasIdentity(absPath: string): Promise<string | null>;
      physicalIdentityByPath: Map<string, string>;
    };
    const identitySpy = vi.spyOn(watcherInternals, "physicalAliasIdentity").mockImplementation(async (absPath) => {
      if (absPath === canonicalAPath) return "inode:fixture:a";
      if (absPath === canonicalKeepPath) return "inode:fixture:keep";
      return null;
    });
    const inventorySpy = vi.spyOn(watcherInternals, "inspectVisibleAliasInventoryInLane");
    const embedSpy = vi.spyOn(watcherEmbedder, "embed");

    try {
      const beforeSeed = await snapshotWindowsWatcherState(fixture, markers);
      await watcherInternals.seedPhysicalAliasRegistry();

      // Identity-only means no lexical/semantic publication during seed.
      expect(inventorySpy).toHaveBeenCalled();
      expect(watcherInternals.physicalIdentityByPath.has(canonicalAPath)).toBe(true);
      expect(watcherInternals.physicalIdentityByPath.has(canonicalKeepPath)).toBe(true);
      expect(fixture.reindexedPaths).toEqual([]);
      expect(embedSpy).not.toHaveBeenCalled();
      const afterSeed = await snapshotWindowsWatcherState(fixture, markers);
      expect(afterSeed.embedRows).toEqual(beforeSeed.embedRows);
      expect(afterSeed.hnswRows).toEqual(beforeSeed.hnswRows);

      inventorySpy.mockClear();
      embedSpy.mockClear();
      await fs.unlink(aPath);

      // NEGATIVE control: missing-origin handling must inventory before it can
      // trust prior membership. The seeded identity is only a commit-group hint:
      // planning may see Keep.md, but must not reindex or re-embed it.
      await enqueueWatcherEvent(fixture.watcher, aPath, "unlink");

      expect(inventorySpy).toHaveBeenCalled();
      expect(embedSpy).not.toHaveBeenCalled();
      expect(fixture.reindexedPaths).toEqual([]);
      const reconciled = await snapshotWindowsWatcherState(fixture, markers);
      expectMarkerPaths(reconciled, "seedunlinkamarker", []);
      expectMarkerPaths(reconciled, "seedkeepmarker", ["Keep.md"]);
      expect(reconciled.embedPaths).toEqual(["Keep.md"]);
      expect(reconciled.embedRows.filter((row) => row.relPath === "Keep.md")).toEqual(
        beforeSeed.embedRows.filter((row) => row.relPath === "Keep.md")
      );
      expect(reconciled.hnswRows.filter((row) => row.relPath === "Keep.md")).toEqual(
        beforeSeed.hnswRows.filter((row) => row.relPath === "Keep.md")
      );
      expect(watcherAuditsMatch(reconciled, 1)).toBe(true);
    } finally {
      identitySpy.mockRestore();
      inventorySpy.mockRestore();
      embedSpy.mockRestore();
      await closeWindowsWatcherFixture(fixture);
    }
  });

  it("purges the exact missing origin when live inventory exceeds its bound", async () => {
    const fixture = await seedWindowsWatcherFixture(
      {
        "A.md": "# A\n\noverflowaoldmarker\n",
        "Keep.md": "# Keep\n\noverflowkeepmarker\n"
      },
      { activationPathLimit: 1 }
    );
    const aPath = path.join(root, "A.md");
    const keepPath = path.join(root, "Keep.md");
    const unseenPath = path.join(root, "Unseen.md");
    const markers = ["overflowaoldmarker", "overflowkeepmarker", "overflowunseenmarker"] as const;
    const watcherInternals = fixture.watcher as unknown as {
      inspectVisibleAliasInventoryInLane(): Promise<unknown>;
    };
    const inventorySpy = vi.spyOn(watcherInternals, "inspectVisibleAliasInventoryInLane");
    const embedSpy = vi.spyOn(watcherEmbedder, "embed");

    try {
      const beforeUnlink = await snapshotWindowsWatcherState(fixture, markers);
      const keepBytes = await fs.readFile(keepPath);
      expectMarkerPaths(beforeUnlink, "overflowaoldmarker", ["A.md"]);
      expectMarkerPaths(beforeUnlink, "overflowkeepmarker", ["Keep.md"]);
      expectMarkerPaths(beforeUnlink, "overflowunseenmarker", []);

      inventorySpy.mockClear();
      embedSpy.mockClear();
      await fs.writeFile(unseenPath, "# Unseen\n\noverflowunseenmarker\n");
      await fs.unlink(aPath);

      // Keep + Unseen exceed the one-path live-inventory bound. The fallback
      // must still purge the exact missing origin, while refusing to publish
      // either the prior unrelated row or the newly appeared unseen path.
      await enqueueWatcherEvent(fixture.watcher, aPath, "unlink");

      expect(inventorySpy).toHaveBeenCalled();
      expect(embedSpy).not.toHaveBeenCalled();
      expect(fixture.reindexedPaths).toEqual([]);
      expect(await fs.readFile(keepPath)).toEqual(keepBytes);

      const reconciled = await snapshotWindowsWatcherState(fixture, markers);
      expectMarkerPaths(reconciled, "overflowaoldmarker", []);
      expectMarkerPaths(reconciled, "overflowkeepmarker", ["Keep.md"]);
      expectMarkerPaths(reconciled, "overflowunseenmarker", []);
      expect(reconciled.embedPaths).toEqual(["Keep.md"]);
      expect(reconciled.embedRows.filter((row) => row.relPath === "Keep.md")).toEqual(
        beforeUnlink.embedRows.filter((row) => row.relPath === "Keep.md")
      );
      expect(reconciled.hnswRows.filter((row) => row.relPath === "Keep.md")).toEqual(
        beforeUnlink.hnswRows.filter((row) => row.relPath === "Keep.md")
      );
      expect(watcherAuditsMatch(reconciled, 1)).toBe(true);
    } finally {
      inventorySpy.mockRestore();
      embedSpy.mockRestore();
      await closeWindowsWatcherFixture(fixture);
    }
  });

  it("uses one bounded global reconciliation when physical identity is unavailable", async () => {
    const fixture = await seedWindowsWatcherFixture({
      "A.md": "# A\n\nunavailableaoldmarker\n",
      "B.md": "# B\n\nunavailableboldmarker\n"
    });
    const watcherInternals = fixture.watcher as unknown as {
      physicalAliasIdentity(absPath: string): Promise<unknown>;
    };
    const identitySpy = vi.spyOn(watcherInternals, "physicalAliasIdentity").mockResolvedValue(null);
    const markers = [
      "unavailableaoldmarker",
      "unavailableboldmarker",
      "unavailableanewmarker",
      "unavailablebnewmarker"
    ] as const;

    try {
      await writeWithLaterMtime(path.join(root, "A.md"), "# A\n\nunavailableanewmarker\n");
      await writeWithLaterMtime(path.join(root, "B.md"), "# B\n\nunavailablebnewmarker\n");

      const beforeEvent = await snapshotWindowsWatcherState(fixture, markers);
      expectMarkerPaths(beforeEvent, "unavailableaoldmarker", ["A.md"]);
      expectMarkerPaths(beforeEvent, "unavailableboldmarker", ["B.md"]);
      expectMarkerPaths(beforeEvent, "unavailableanewmarker", []);
      expectMarkerPaths(beforeEvent, "unavailablebnewmarker", []);

      // Only A receives a native event. With no trustworthy inode identity,
      // correctness requires a bounded reconciliation of all known regular
      // paths; an exact-path-only fallback would leave B stale.
      await enqueueWatcherEvent(fixture.watcher, path.join(root, "A.md"), "change");

      const reconciled = await snapshotWindowsWatcherState(fixture, markers);
      expectMarkerPaths(reconciled, "unavailableaoldmarker", []);
      expectMarkerPaths(reconciled, "unavailableboldmarker", []);
      expectMarkerPaths(reconciled, "unavailableanewmarker", ["A.md"]);
      expectMarkerPaths(reconciled, "unavailablebnewmarker", ["B.md"]);
      expect(reconciled.embedPaths).toEqual(["A.md", "B.md"]);
      expect([...new Set(fixture.reindexedPaths)].sort()).toEqual(["A.md", "B.md"]);
      expect(watcherAuditsMatch(reconciled, 2)).toBe(true);
    } finally {
      identitySpy.mockRestore();
      await closeWindowsWatcherFixture(fixture);
    }
  });

  it("purges a previously known missing path during unknown-identity fallback", async () => {
    const fixture = await seedWindowsWatcherFixture({
      "A.md": "# A\n\nunknownknownaoldmarker\n",
      "B.md": "# B\n\nunknownknownbmarker\n"
    });
    const aPath = path.join(root, "A.md");
    const bPath = path.join(root, "B.md");
    const markers = ["unknownknownaoldmarker", "unknownknownanewmarker", "unknownknownbmarker"] as const;
    const watcherInternals = fixture.watcher as unknown as {
      physicalAliasIdentity(absPath: string): Promise<unknown>;
    };

    try {
      // Establish B as a path observed by the physical-identity machinery,
      // then remove it without delivering its unlink event.
      await enqueueWatcherEvent(fixture.watcher, bPath, "change");
      fixture.reindexedPaths.length = 0;
      await fs.unlink(bPath);
      await writeWithLaterMtime(aPath, "# A\n\nunknownknownanewmarker\n");

      // NEGATIVE control: B is gone and A has new bytes, but the sinks still
      // retain B and A's old generation until the one global fallback event.
      const beforeEvent = await snapshotWindowsWatcherState(fixture, markers);
      expect(beforeEvent.diskNames).toEqual(["A.md"]);
      expectMarkerPaths(beforeEvent, "unknownknownaoldmarker", ["A.md"]);
      expectMarkerPaths(beforeEvent, "unknownknownanewmarker", []);
      expectMarkerPaths(beforeEvent, "unknownknownbmarker", ["B.md"]);

      const identitySpy = vi.spyOn(watcherInternals, "physicalAliasIdentity").mockResolvedValue(null);
      try {
        await enqueueWatcherEvent(fixture.watcher, aPath, "change");
        expect(identitySpy).toHaveBeenCalled();
      } finally {
        identitySpy.mockRestore();
      }

      const reconciled = await snapshotWindowsWatcherState(fixture, markers);
      expectMarkerPaths(reconciled, "unknownknownaoldmarker", []);
      expectMarkerPaths(reconciled, "unknownknownanewmarker", ["A.md"]);
      expectMarkerPaths(reconciled, "unknownknownbmarker", []);
      expect(reconciled.embedPaths).toEqual(["A.md"]);
      expect([...new Set(fixture.reindexedPaths)]).toEqual(["A.md"]);
      expect(watcherAuditsMatch(reconciled, 1)).toBe(true);
    } finally {
      await closeWindowsWatcherFixture(fixture);
    }
  });

  it("retains but quarantines prior rows when admission is transiently unavailable", async () => {
    const fixture = await seedWindowsWatcherFixture({
      "Protected.md": "# Protected\n\nadmissionoldmarker\n",
      "Gone.md": "# Gone\n\nadmissiongonemarker\n"
    });
    const protectedPath = path.join(root, "Protected.md");
    const canonicalProtectedPath = fixture.vault.resolveInside("Protected.md");
    const gonePath = path.join(root, "Gone.md");
    const markers = ["admissionoldmarker", "admissionnewmarker", "admissiongonemarker"] as const;
    const watcherInternals = fixture.watcher as unknown as {
      captureFileGeneration(absPath: string): Promise<unknown>;
    };

    try {
      // Prime both exact paths, then prove a genuinely missing path still takes
      // the destructive unlink branch. The unavailable-admission case below
      // must not inherit that classification merely because lstat failed.
      await enqueueWatcherEvent(fixture.watcher, protectedPath, "change");
      await enqueueWatcherEvent(fixture.watcher, gonePath, "change");
      await fs.unlink(gonePath);
      await enqueueWatcherEvent(fixture.watcher, gonePath, "unlink");
      const afterRealUnlink = await snapshotWindowsWatcherState(fixture, markers);
      expectMarkerPaths(afterRealUnlink, "admissiongonemarker", []);
      expectMarkerPaths(afterRealUnlink, "admissionoldmarker", ["Protected.md"]);
      expect(watcherAuditsMatch(afterRealUnlink, 1)).toBe(true);
      fixture.reindexedPaths.length = 0;

      await writeWithLaterMtime(protectedPath, "# Protected\n\nadmissionnewmarker\n");

      // NEGATIVE control: disk already has the new generation, while every
      // derived sink still holds the prior one before admission starts failing.
      const beforeFailure = await snapshotWindowsWatcherState(fixture, markers);
      await expect(fs.readFile(protectedPath, "utf8")).resolves.toContain("admissionnewmarker");
      expectMarkerPaths(beforeFailure, "admissionoldmarker", ["Protected.md"]);
      expectMarkerPaths(beforeFailure, "admissionnewmarker", []);

      const originalCaptureFileGeneration = watcherInternals.captureFileGeneration.bind(fixture.watcher);
      let admissionAttempts = 0;
      const admissionSpy = vi.spyOn(watcherInternals, "captureFileGeneration").mockImplementation(async (absPath) => {
        if (absPath === canonicalProtectedPath) {
          admissionAttempts += 1;
          throw Object.assign(new Error("synthetic transient admission failure"), { code: "EACCES" });
        }
        return originalCaptureFileGeneration(absPath);
      });
      try {
        await enqueueWatcherEvent(fixture.watcher, protectedPath, "change");
      } finally {
        admissionSpy.mockRestore();
      }

      expect(admissionAttempts).toBeGreaterThan(0);
      expect(admissionAttempts).toBeLessThanOrEqual(8);
      const retained = await snapshotWindowsWatcherState(fixture, markers);
      // Physical source_state/sidecar rows are retained for recovery, but the
      // source-scoped DB quarantine hides both lexical and semantic egress.
      // The sidecar snapshot is deliberately not an output authority.
      expect(markerPaths(retained.ftsByMarker, "admissionoldmarker")).toEqual([]);
      expect(markerPaths(retained.embedByMarker, "admissionoldmarker")).toEqual([]);
      expect(markerPathsInHnsw(retained, "admissionoldmarker")).toEqual(["Protected.md"]);
      expect(markerPaths(retained.ftsByMarker, "admissionnewmarker")).toEqual([]);
      expect(markerPaths(retained.embedByMarker, "admissionnewmarker")).toEqual([]);
      expect(markerPaths(retained.ftsByMarker, "admissiongonemarker")).toEqual([]);
      expect(markerPaths(retained.embedByMarker, "admissiongonemarker")).toEqual([]);
      expect(retained.embedPaths).toEqual(["Protected.md"]);
      expect(fixture.reindexedPaths).toEqual([]);
      expect(retained.ftsAudit).toMatchObject({
        declared_files: 1,
        indexed_files: 1,
        mismatched_files: 1
      });
      expect(retained.embedAudit).toMatchObject({ indexed_files: 1, mismatched_files: 1 });
      expect(watcherAuditsMatch(retained, 1)).toBe(false);
    } finally {
      await closeWindowsWatcherFixture(fixture);
    }
  });

  it("never folds distinct case or NFC/NFD storage identities on a case-sensitive filesystem", async (ctx) => {
    if (process.platform !== "linux") return ctx.skip();

    const nfcName = `Caf${String.fromCodePoint(0xe9)}.md`;
    const nfdName = `Cafe${String.fromCodePoint(0x301)}.md`;
    expect(nfcName).not.toBe(nfdName);
    const fixture = await seedWindowsWatcherFixture({
      "Case.md": "# Upper\n\ncaseupperoldmarker\n",
      "case.md": "# Lower\n\ncaseloweroldmarker\n",
      [nfcName]: "# NFC\n\nnfcoldmarker\n",
      [nfdName]: "# NFD\n\nnfdoldmarker\n"
    });
    const markers = [
      "caseupperoldmarker",
      "caseuppernewmarker",
      "caseloweroldmarker",
      "nfcoldmarker",
      "nfcnewmarker",
      "nfdoldmarker"
    ] as const;

    try {
      const diskNames = await fs.readdir(root);
      for (const exactName of ["Case.md", "case.md", nfcName, nfdName]) {
        expect(diskNames).toContain(exactName);
      }
      const stats = await Promise.all(
        ["Case.md", "case.md", nfcName, nfdName].map((name) => fs.lstat(path.join(root, name), { bigint: true }))
      );
      expect(stats.every((stat) => stat.isFile() && !stat.isSymbolicLink() && stat.ino !== 0n)).toBe(true);
      expect(new Set(stats.map((stat) => `${stat.dev}:${stat.ino}`)).size).toBe(4);

      await writeWithLaterMtime(path.join(root, "Case.md"), "# Upper\n\ncaseuppernewmarker\n");
      await enqueueWatcherEvent(fixture.watcher, path.join(root, "Case.md"), "change");

      const afterCase = await snapshotWindowsWatcherState(fixture, markers);
      expectMarkerPaths(afterCase, "caseupperoldmarker", []);
      expectMarkerPaths(afterCase, "caseuppernewmarker", ["Case.md"]);
      expectMarkerPaths(afterCase, "caseloweroldmarker", ["case.md"]);
      expect(watcherAuditsMatch(afterCase, 4)).toBe(true);

      await writeWithLaterMtime(path.join(root, nfcName), "# NFC\n\nnfcnewmarker\n");
      await enqueueWatcherEvent(fixture.watcher, path.join(root, nfcName), "change");

      const afterUnicode = await snapshotWindowsWatcherState(fixture, markers);
      expectMarkerPaths(afterUnicode, "nfcoldmarker", []);
      expectMarkerPaths(afterUnicode, "nfcnewmarker", [nfcName]);
      expectMarkerPaths(afterUnicode, "nfdoldmarker", [nfdName]);
      expect(afterUnicode.embedPaths).toEqual(["Case.md", nfcName, nfdName, "case.md"].sort());
      expect([...new Set(fixture.reindexedPaths)].sort()).toEqual(["Case.md", nfcName].sort());
      expect(watcherAuditsMatch(afterUnicode, 4)).toBe(true);
    } finally {
      await closeWindowsWatcherFixture(fixture);
    }
  });

  it("does not follow a junction or accept an outside event during unavailable-identity fallback", async () => {
    const fixture = await seedWindowsWatcherFixture({
      "Visible.md": "# Visible\n\njunctionvisibleoldmarker\n"
    });
    const watcherInternals = fixture.watcher as unknown as {
      physicalAliasIdentity(absPath: string): Promise<unknown>;
    };
    const identitySpy = vi.spyOn(watcherInternals, "physicalAliasIdentity").mockResolvedValue(null);
    const junction = path.join(root, "Outside");
    const secretPath = path.join(outside, "Secret.md");
    const junctionSecretPath = path.join(junction, "Secret.md");
    const secretBytes = "# Secret\n\njunctionsecretmarker must remain outside every index.\n";
    const markers = ["junctionvisibleoldmarker", "junctionvisiblenewmarker", "junctionsecretmarker"] as const;

    try {
      await fs.writeFile(secretPath, secretBytes);
      await fs.symlink(outside, junction, process.platform === "win32" ? "junction" : "dir");
      await expect(fs.readFile(junctionSecretPath, "utf8")).resolves.toBe(secretBytes);

      await writeWithLaterMtime(path.join(root, "Visible.md"), "# Visible\n\njunctionvisiblenewmarker\n");
      await enqueueWatcherEvent(fixture.watcher, path.join(root, "Visible.md"), "change");
      await enqueueWatcherEvent(fixture.watcher, secretPath, "change");
      await enqueueWatcherEvent(fixture.watcher, junctionSecretPath, "change");

      const reconciled = await snapshotWindowsWatcherState(fixture, markers);
      expectMarkerPaths(reconciled, "junctionvisibleoldmarker", []);
      expectMarkerPaths(reconciled, "junctionvisiblenewmarker", ["Visible.md"]);
      expectMarkerPaths(reconciled, "junctionsecretmarker", []);
      expect(reconciled.embedPaths).toEqual(["Visible.md"]);
      expect(await fs.readFile(secretPath, "utf8")).toBe(secretBytes);
      expect(watcherAuditsMatch(reconciled, 1)).toBe(true);
    } finally {
      identitySpy.mockRestore();
      await closeWindowsWatcherFixture(fixture, [junction]);
    }
  });
});

describe("renameNote native case-insensitive filesystem contracts", () => {
  it("renames casing in place while rewriting the source self-link and an external backlink", async (ctx) => {
    const sourceSentinel = "case-only-source-sentinel";
    await fs.writeFile(path.join(root, "Foo.md"), `# Foo\n\n${sourceSentinel}\n\nSelf [[Foo]].\n`);
    await fs.writeFile(path.join(root, "Hub.md"), "See [[Foo]].\n");

    const caseInsensitive = await pathExistsWithoutSuppressingErrors(path.join(root, "foo.md"));
    if (!caseInsensitive) {
      if (process.platform === "win32") {
        throw new Error("mandatory Windows case-insensitive filesystem precondition failed for Foo.md/foo.md");
      }
      return ctx.skip();
    }

    const vault = new Vault(root, { enableWrite: true });
    await vault.ensureExists();
    const renamed = await renameNote(vault, { from: "Foo.md", to: "foo.md" });

    expect(renamed.total_links_rewritten).toBe(2);
    const foldedNames = (await fs.readdir(root)).filter((name) => name.toLowerCase() === "foo.md");
    expect(foldedNames, "the rename must leave one entry with the requested exact casing").toEqual(["foo.md"]);
    const source = await fs.readFile(path.join(root, "foo.md"), "utf8");
    const hub = await fs.readFile(path.join(root, "Hub.md"), "utf8");
    expect(source).toContain(sourceSentinel);
    expect(source).toContain("[[foo]]");
    expect(source).not.toContain("[[Foo]]");
    expect(hub).toContain("[[foo]]");
    expect(hub).not.toContain("[[Foo]]");
  });

  it("preserves the source across overwrite of a case-variant destination that backlinks it", async (ctx) => {
    const sourceSentinel = "case-variant-source-sentinel";
    const oldDestinationSentinel = "case-variant-old-destination-sentinel";
    const oldDestinationBacklink = "See [[src]] for details.";
    await fs.writeFile(path.join(root, "src.md"), `# Source\n\n${sourceSentinel}\n`);
    await fs.writeFile(
      path.join(root, "dest.md"),
      `# Destination\n\n${oldDestinationSentinel}\n\n${oldDestinationBacklink}\n`
    );

    const caseInsensitive = await pathExistsWithoutSuppressingErrors(path.join(root, "DEST.md"));
    if (!caseInsensitive) {
      if (process.platform === "win32") {
        throw new Error("mandatory Windows case-insensitive filesystem precondition failed for dest.md/DEST.md");
      }
      return ctx.skip();
    }

    const vault = new Vault(root, { enableWrite: true });
    await vault.ensureExists();
    await renameNote(vault, { from: "src.md", to: "Dest.md", overwrite: true });

    expect(await pathExistsWithoutSuppressingErrors(path.join(root, "src.md")), "the source path must be gone").toBe(
      false
    );
    const foldedDestinations = (await fs.readdir(root)).filter((name) => name.toLowerCase() === "dest.md");
    expect(foldedDestinations, "the overwrite must leave exactly one folded destination").toHaveLength(1);
    const destination = await fs.readFile(path.join(root, foldedDestinations[0] as string), "utf8");
    expect(destination).toContain(sourceSentinel);
    expect(destination).not.toContain(oldDestinationSentinel);
    expect(destination).not.toContain(oldDestinationBacklink);
  });
});

const windowsDescribe = process.platform === "win32" ? describe : describe.skip;

windowsDescribe("Windows hostile-filesystem contracts", () => {
  type PersistencePathAdmitter = (file: unknown) => void;

  const persistencePathFamilies: ReadonlyArray<{
    namespace: "cache" | "embed" | "feedback" | "fts" | "hnsw";
    suffix: string;
    admit: PersistencePathAdmitter;
  }> = [
    { namespace: "cache", suffix: ".json", admit: assertCacheFilePath },
    { namespace: "embed", suffix: ".embed.db", admit: assertEmbedDbFilePath },
    { namespace: "feedback", suffix: ".feedback.json", admit: assertFeedbackFilePath },
    { namespace: "fts", suffix: ".fts5.db", admit: assertFtsIndexFilePath },
    { namespace: "hnsw", suffix: ".hnsw", admit: assertHnswFilePath }
  ];

  const portablePersistencePaths = persistencePathFamilies.flatMap(({ namespace, suffix, admit }) => [
    { namespace, admit, boundary: "ordinary component", file: `C:\\Enquire\\Vault${suffix}` },
    { namespace, admit, boundary: "non-device COM10 component", file: `C:\\Enquire\\COM10${suffix}` },
    { namespace, admit, boundary: "UNC root", file: `\\\\server\\share\\Vault${suffix}` }
  ]);

  const rejectedPersistencePaths = persistencePathFamilies.flatMap(({ namespace, suffix, admit }) =>
    [
      {
        hazard: "alternate data stream",
        file: `C:\\Enquire\\Vault${suffix}:stream${suffix}`,
        error: /alternate data stream/
      },
      {
        hazard: "drive-relative path",
        file: `C:Vault${suffix}`,
        error: /device namespace or drive-relative path/
      },
      {
        hazard: "device namespace",
        file: `\\\\?\\C:\\Enquire\\Vault${suffix}`,
        error: /device namespace or drive-relative path/
      },
      {
        hazard: "mixed-separator GLOBALROOT device namespace",
        file: `/\\?/GLOBALROOT/Device/HarddiskVolume1/Vault${suffix}`,
        error: /device namespace or drive-relative path/
      },
      {
        hazard: "mixed-separator pipe device namespace",
        file: `\\/./pipe/Vault${suffix}`,
        error: /device namespace or drive-relative path/
      },
      {
        hazard: "DOS device basename",
        file: `C:\\Enquire\\CON${suffix}`,
        error: /reserved Windows device basename/
      },
      {
        hazard: "DOS device basename with an ignored trailing space",
        file: `C:\\Enquire\\CON ${suffix}`,
        error: /reserved Windows device basename/
      },
      {
        hazard: "numbered DOS device basename with an ignored trailing space",
        file: `C:\\Enquire\\COM1 ${suffix}`,
        error: /reserved Windows device basename/
      },
      {
        hazard: "trailing-dot component",
        file: `C:\\Enquire.\\Vault${suffix}`,
        error: /trailing-dot or trailing-space path component/
      },
      {
        hazard: "trailing-space component",
        file: `C:\\Enquire \\Vault${suffix}`,
        error: /trailing-dot or trailing-space path component/
      },
      {
        hazard: "forbidden-character component",
        file: `C:\\Bad?\\Vault${suffix}`,
        error: /portable Windows path/
      },
      {
        hazard: "control-character component",
        file: `C:\\Bad\u001f\\Vault${suffix}`,
        error: /portable Windows path/
      },
      {
        hazard: "current-directory alias",
        file: `C:\\Enquire\\.\\Vault${suffix}`,
        error: /portable Windows path/
      },
      {
        hazard: "parent-directory alias",
        file: `C:\\Enquire\\..\\Vault${suffix}`,
        error: /portable Windows path/
      },
      {
        hazard: "repeated mixed-separator alias",
        file: `C:\\Enquire\\/Vault${suffix}`,
        error: /portable Windows path/
      },
      {
        hazard: "zero-index DOS device basename",
        file: `C:\\Enquire\\COM0${suffix}`,
        error: /reserved Windows device basename/
      }
    ].map((testCase) => ({ namespace, admit, ...testCase }))
  );

  function expectPersistenceAdmissionBeforeFilesystem(
    admit: PersistencePathAdmitter,
    file: string,
    expectedError?: RegExp
  ): void {
    const accessSpy = vi.spyOn(fs, "access");
    const lstatSpy = vi.spyOn(fs, "lstat");
    const openSpy = vi.spyOn(fs, "open");
    const readFileSpy = vi.spyOn(fs, "readFile");
    const statSpy = vi.spyOn(fs, "stat");
    try {
      if (expectedError) expect(() => admit(file)).toThrow(expectedError);
      else expect(() => admit(file)).not.toThrow();
      expect(accessSpy).not.toHaveBeenCalled();
      expect(lstatSpy).not.toHaveBeenCalled();
      expect(openSpy).not.toHaveBeenCalled();
      expect(readFileSpy).not.toHaveBeenCalled();
      expect(statSpy).not.toHaveBeenCalled();
    } finally {
      accessSpy.mockRestore();
      lstatSpy.mockRestore();
      openSpy.mockRestore();
      readFileSpy.mockRestore();
      statSpy.mockRestore();
    }
  }

  it.for(portablePersistencePaths)(
    "$namespace persistence admission accepts a $boundary before filesystem I/O",
    ({ admit, file }) => {
      expectPersistenceAdmissionBeforeFilesystem(admit, file);
    }
  );

  it.for(rejectedPersistencePaths)(
    "$namespace persistence admission rejects a $hazard before filesystem I/O",
    ({ admit, file, error }) => {
      expectPersistenceAdmissionBeforeFilesystem(admit, file, error);
    }
  );

  it("rejects reserved names, ADS, forbidden components, and traversal before filesystem I/O", async () => {
    const rejected = [
      "CON",
      "con.md",
      "PRN.txt",
      "AUX.tar.gz",
      "NUL.tar.gz",
      "COM0.md",
      "COM9",
      "COM¹.md",
      "COM².tar",
      "COM³",
      "LPT0",
      "LPT9.md",
      "LPT¹.ext",
      "LPT².ext",
      "LPT³.ext",
      "CONIN$",
      "conout$.md",
      "CON .txt",
      "NUL...txt",
      "COM1 .md",
      "Folder/NUL.md",
      "bad<.md",
      "bad>.md",
      'bad".md',
      "note:stream.md",
      "a|b.md",
      "a?b.md",
      "a*b.md",
      "x\u0000.md",
      "x\u0001.md",
      "x\u001f.md",
      "Folder./n.md",
      "Folder /n.md",
      "n.md.",
      "n.md "
    ];
    for (const candidate of rejected) {
      expect(windowsRelativePathProblem(candidate), candidate).not.toBeNull();
    }

    const accepted = [
      "",
      "Note.md",
      "Folder/Note.md",
      ".hidden.md",
      "CONTEXT.md",
      "AUXILIARY.md",
      "NULL.md",
      "NULish.md",
      "COM10.md",
      "LPT10.md",
      "COM0x.md",
      "CONINbox.md",
      "CON text.md",
      "name.with.dots.md",
      "café.md",
      "emoji-🧠.md"
    ];
    for (const candidate of accepted) {
      expect(windowsRelativePathProblem(candidate), candidate).toBeNull();
    }

    const vault = new Vault(root, { enableWrite: true });
    expect(() => vault.resolveInside("CON.md")).toThrow(/reserved Windows device name/);
    await vault.ensureExists();
    const absoluteGood = path.join(root, "Folder", "Good.md");
    expect(vault.resolveInside(absoluteGood)).toBe(path.join(vault.root, "Folder", "Good.md"));
    expect(() => vault.resolveInside(path.join(root, "NUL.md"))).toThrow(/reserved Windows device name/);
    await expect(vault.writeNote("CON.md", "must not exist")).rejects.toThrow(/Windows-unsafe vault path/);
    await expect(vault.writeNote("n.md ", "must not be trimmed into existence")).rejects.toThrow(
      /ends with a dot or space/
    );
    expect(await fs.stat(path.join(root, "n.md")).catch(() => null)).toBeNull();

    const realpathSpy = vi
      .spyOn(fs, "realpath")
      .mockRejectedValueOnce(Object.assign(new Error("canonical realpath denied"), { code: "EACCES" }));
    try {
      await expect(vault.canonicalRelForPrivacyCheckPublic(absoluteGood)).rejects.toThrow(/canonical realpath denied/);
    } finally {
      realpathSpy.mockRestore();
    }

    const drive = path.parse(root).root.slice(0, 2);
    const escapes = [
      "../escape.md",
      "..\\escape.md",
      path.join(outside, "escape.md"),
      drive,
      `${drive}escape.md`,
      "\\\\server\\share\\escape.md",
      `\\\\?\\${path.join(outside, "escape.md")}`
    ];
    for (const candidate of escapes) {
      expect(() => vault.resolveInside(candidate), candidate).toThrow();
    }

    for (const candidate of ["CONTEXT.md", "COM10.md", "LPT10.md"]) {
      await vault.writeNote(candidate, `positive control: ${candidate}`);
    }
    expect(await fs.readdir(root)).toEqual(expect.arrayContaining(["CONTEXT.md", "COM10.md", "LPT10.md"]));
  });

  it("does not traverse a real directory junction for list, read, create, append, or rename", async () => {
    const sentinel = path.join(outside, "Secret.md");
    await fs.writeFile(sentinel, "external sentinel");
    await fs.symlink(outside, path.join(root, "Outside"), "junction");
    expect(await fs.readFile(path.join(root, "Outside", "Secret.md"), "utf8")).toBe("external sentinel");

    await fs.mkdir(path.join(root, "Real"), { recursive: true });
    await fs.writeFile(path.join(root, "Real", "Visible.md"), "visible");
    await fs.writeFile(path.join(root, "Inside.md"), "inside");

    const vault = new Vault(root, { enableWrite: true });
    await vault.ensureExists();
    const listed = (await vault.listMarkdown()).map((entry) => entry.relPath);
    expect(listed).toContain("Real/Visible.md");
    expect(listed).not.toContain("Outside/Secret.md");

    await expect(vault.readFile("Outside/Secret.md")).rejects.toThrow(/escapes vault root/);
    await expect(vault.writeNote("Outside/New.md", "attack")).rejects.toThrow(/outside vault/);
    await expect(vault.appendNote("Outside/Secret.md", "\nattack")).rejects.toThrow(/escapes vault root/);
    await expect(vault.renameFile("Inside.md", "Outside/Moved.md")).rejects.toThrow(/outside vault/);

    expect(await fs.readFile(sentinel, "utf8")).toBe("external sentinel");
    expect(await fs.stat(path.join(outside, "New.md")).catch(() => null)).toBeNull();
    expect(await fs.stat(path.join(outside, "Moved.md")).catch(() => null)).toBeNull();
    expect(await fs.readFile(path.join(root, "Inside.md"), "utf8")).toBe("inside");

    const created = await vault.writeNote("Real/New.md", "local");
    expect(created.relPath).toBe("Real/New.md");
    const appended = await vault.appendNote("Real/New.md", "\nappend");
    expect(appended.relPath).toBe("Real/New.md");

    const configuredAlias = path.join(outside, "ConfiguredVault");
    await fs.mkdir(path.join(root, "Scope", "Private"), { recursive: true });
    await fs.writeFile(path.join(root, "Scope", "Public.md"), "public");
    await fs.writeFile(path.join(root, "Scope", "Public.canvas"), "{}");
    await fs.writeFile(path.join(root, "Scope", "Private", "Hidden.md"), "hidden");
    await fs.writeFile(path.join(root, "Scope", "Private", "Hidden.canvas"), "{}");
    await fs.symlink(root, configuredAlias, "junction");
    try {
      const aliasVault = new Vault(configuredAlias, { excludeGlobs: ["Scope/Private/**"] });
      await aliasVault.ensureExists();
      const throughConfiguredAlias = path.join(configuredAlias, "Real", "Visible.md");
      expect(aliasVault.resolveInside(throughConfiguredAlias)).toBe(path.join(aliasVault.root, "Real", "Visible.md"));
      expect(aliasVault.toRel(aliasVault.resolveInside(throughConfiguredAlias))).toBe("Real/Visible.md");
      expect(await aliasVault.readFile(throughConfiguredAlias)).toBe("visible");
      expect(await aliasVault.readFile(path.join(aliasVault.root, "Real", "Visible.md"))).toBe("visible");

      const aliasMarkdown = await aliasVault.listMarkdown(path.join(configuredAlias, "Scope"));
      expect(aliasMarkdown.map((entry) => entry.relPath)).toContain("Scope/Public.md");
      expect(aliasMarkdown.map((entry) => entry.relPath)).not.toContain("Scope/Private/Hidden.md");
      expect(aliasMarkdown.every((entry) => !entry.relPath.startsWith(".."))).toBe(true);
      const aliasCanvases = await aliasVault.listFilesByExtension(".canvas", path.join(configuredAlias, "Scope"));
      expect(aliasCanvases.map((entry) => entry.relPath)).toEqual(["Scope/Public.canvas"]);

      const aliasRealpathSpy = vi.spyOn(fs, "realpath").mockRejectedValueOnce(
        Object.assign(new Error(`EACCES: cannot resolve '${throughConfiguredAlias}'`), {
          code: "EACCES",
          path: throughConfiguredAlias
        })
      );
      try {
        const sanitized = await aliasVault.readFile(throughConfiguredAlias).then(
          () => null,
          (error: unknown) => error
        );
        expect(sanitized).toBeInstanceOf(Error);
        expect((sanitized as Error).message).not.toContain(configuredAlias);
        expect((sanitized as NodeJS.ErrnoException).path).not.toContain(configuredAlias);
      } finally {
        aliasRealpathSpy.mockRestore();
      }
    } finally {
      await fs.unlink(configuredAlias);
    }
  });

  it("uses forward-slash identities and keeps case-folded privacy fail-closed", async () => {
    await fs.mkdir(path.join(root, "Folder"), { recursive: true });
    await fs.writeFile(path.join(root, "Folder", "Note.md"), "note");
    await fs.writeFile(path.join(root, "Folder", "Second.md"), "second");
    await fs.writeFile(path.join(root, "Folder", "Board.canvas"), "{}");

    const cacheFile = path.join(outside, "parse-cache.json");
    const vault = new Vault(root, { enableWrite: true, persistentCache: true, cacheFile });
    await vault.ensureExists();
    const markdown = await vault.listMarkdown();
    const noteEntry = markdown.find((entry) => entry.basename === "Note.md");
    expect(noteEntry?.relPath).toBe("Folder/Note.md");
    if (!noteEntry) throw new Error("Windows walker did not return the positive-control note");
    const canvases = await vault.listFilesByExtension(".canvas");
    expect(canvases[0]?.relPath).toBe("Folder/Board.canvas");
    expect(vault.toRel(path.join(vault.root, "Folder", "Note.md"))).toBe("Folder/Note.md");

    const folderFts = new FtsIndex({ file: path.join(outside, "folder-filter.fts5.db"), vaultRoot: root });
    await folderFts.open();
    try {
      folderFts.reindexFile(noteEntry.relPath, noteEntry.mtimeMs, "portablefoldermarker");
      folderFts.reindexFile("Elsewhere/Other.md", noteEntry.mtimeMs, "portablefoldermarker");
      expect(folderFts.search("portablefoldermarker", { folder: "Folder" }).map((hit) => hit.rel_path)).toEqual([
        "Folder/Note.md"
      ]);
      expect(folderFts.search("portablefoldermarker", { folder: "Missing" })).toEqual([]);
    } finally {
      folderFts.close();
    }

    await vault.readNote("Folder/Note.md");
    await vault.readNote("Folder/Second.md");
    await vault.saveDiskCache();
    const persisted = JSON.parse(await fs.readFile(cacheFile, "utf8")) as {
      entries?: Array<{ relPath?: string; content?: string }>;
    };
    expect(persisted.entries?.[0]?.relPath).toBe("Folder/Note.md");
    const legacyEntry = persisted.entries?.find((entry) => entry.relPath === "Folder/Second.md");
    if (!legacyEntry) throw new Error("persistent cache did not contain the migration-control note");
    legacyEntry.relPath = "folder\\Second.md";
    legacyEntry.content = "legacy-cache-sentinel";
    await fs.writeFile(cacheFile, JSON.stringify(persisted));
    const legacyCacheVault = new Vault(root, { persistentCache: true, cacheFile, maxCacheEntries: 2 });
    await legacyCacheVault.ensureExists();
    expect((await legacyCacheVault.readNote("Folder/Second.md")).content).toBe("legacy-cache-sentinel");
    await legacyCacheVault.saveDiskCache();
    const migrated = JSON.parse(await fs.readFile(cacheFile, "utf8")) as {
      entries?: Array<{ relPath?: string }>;
    };
    expect(migrated.entries?.map((entry) => entry.relPath)).toEqual(["Folder/Note.md", "Folder/Second.md"]);

    await fs.mkdir(path.join(root, "Private"), { recursive: true });
    await fs.writeFile(path.join(root, "Private", "Secret.md"), "private-cache-sentinel");

    const caseCacheFile = path.join(outside, "case-privacy-cache.json");
    const caseCacheSource = new Vault(root, { persistentCache: true, cacheFile: caseCacheFile });
    await caseCacheSource.ensureExists();
    await caseCacheSource.readNote("Private/Secret.md");
    await caseCacheSource.saveDiskCache();
    const caseCache = JSON.parse(await fs.readFile(caseCacheFile, "utf8")) as {
      entries?: Array<{ relPath?: string; content?: string }>;
    };
    const caseVariantSecret = caseCache.entries?.[0];
    if (!caseVariantSecret) throw new Error("persistent cache did not contain the privacy-control note");
    caseVariantSecret.relPath = "private\\Secret.md";
    await fs.writeFile(caseCacheFile, JSON.stringify(caseCache));
    const caseFilteredVault = new Vault(root, {
      persistentCache: true,
      cacheFile: caseCacheFile,
      excludeGlobs: ["Private/**"]
    });
    await caseFilteredVault.ensureExists();
    await caseFilteredVault.saveDiskCache();
    const casePruned = await fs.readFile(caseCacheFile, "utf8");
    expect((JSON.parse(casePruned) as { entries?: unknown[] }).entries).toEqual([]);
    expect(casePruned).not.toContain("private-cache-sentinel");

    const tailCacheFile = path.join(outside, "tail-privacy-cache.json");
    const tailCacheSource = new Vault(root, { persistentCache: true, cacheFile: tailCacheFile });
    await tailCacheSource.ensureExists();
    await tailCacheSource.readNote("Folder/Note.md");
    await tailCacheSource.readNote("Folder/Second.md");
    await tailCacheSource.readNote("Private/Secret.md");
    await tailCacheSource.saveDiskCache();
    const tailFilteredVault = new Vault(root, {
      persistentCache: true,
      cacheFile: tailCacheFile,
      maxCacheEntries: 1,
      excludeGlobs: ["Private/**"]
    });
    await tailFilteredVault.ensureExists();
    await tailFilteredVault.saveDiskCache();
    const tailPruned = await fs.readFile(tailCacheFile, "utf8");
    expect(
      (JSON.parse(tailPruned) as { entries?: Array<{ relPath?: string }> }).entries?.map((entry) => entry.relPath)
    ).toEqual(["Folder/Note.md"]);
    expect(tailPruned).not.toContain("private-cache-sentinel");

    const written = await vault.writeNote("Folder/New.md", "new");
    expect(written.relPath).toBe("Folder/New.md");
    const appended = await vault.appendNote("Folder/New.md", "\nmore");
    expect(appended.relPath).toBe("Folder/New.md");
    const renamed = await vault.renameFile("Folder/New.md", "Archive/Renamed.md");
    expect(renamed).toMatchObject({ from: "Folder/New.md", to: "Archive/Renamed.md" });

    const droppedPaths: string[] = [];
    const ftsStub = {
      dropFile: (relPath: string) => {
        droppedPaths.push(relPath);
      }
    } as unknown as FtsIndex;
    const watcher = new VaultWatcher({ vault, ftsIndex: ftsStub, silent: true });
    const handle = (
      watcher as unknown as {
        handle(absPath: string, kind: "add" | "change" | "unlink"): Promise<void>;
      }
    ).handle.bind(watcher);
    await handle(path.join(vault.root, "Folder", "Deleted.md"), "unlink");
    expect(droppedPaths).toEqual(["Folder/Deleted.md"]);

    await fs.writeFile(path.join(root, "Private", "Secret.md"), "private");
    const filtered = new Vault(root, { enableWrite: true, excludeGlobs: ["Private/**"] });
    await filtered.ensureExists();
    expect((await filtered.listMarkdown()).map((entry) => entry.relPath)).not.toContain("Private/Secret.md");
    await expect(filtered.readFile("private/secret.md")).rejects.toThrow(/excluded.*Private\/Secret\.md/);
    await expect(filtered.writeNote("private/new.md", "blocked")).rejects.toThrow(/excluded/);
    expect(await fs.stat(path.join(root, "Private", "new.md")).catch(() => null)).toBeNull();
  });

  it("canonicalizes a case-variant rename source before rewriting self-links and backlinks", async () => {
    await fs.writeFile(path.join(root, "Foo.md"), "# Foo\n\nSelf [[Foo]].\n");
    await fs.writeFile(path.join(root, "Hub.md"), "See [[Foo]].\n");
    const vault = new Vault(root, { enableWrite: true });
    await vault.ensureExists();

    const mixedCase = await renameNote(vault, { from: "foo.md", to: "Bar.md" });
    expect(mixedCase.total_links_rewritten).toBe(2);
    expect(await fs.readFile(path.join(root, "Bar.md"), "utf8")).toContain("[[Bar]]");
    expect(await fs.readFile(path.join(root, "Hub.md"), "utf8")).toContain("[[Bar]]");
    expect(await fs.stat(path.join(root, "Foo.md")).catch(() => null)).toBeNull();

    await fs.writeFile(path.join(root, "Exact.md"), "# Exact\n\nSelf [[Exact]].\n");
    await fs.writeFile(path.join(root, "ExactHub.md"), "See [[Exact]].\n");
    const exactCase = await renameNote(vault, { from: "Exact.md", to: "ExactNew.md" });
    expect(exactCase.total_links_rewritten).toBe(2);
    expect(await fs.readFile(path.join(root, "ExactNew.md"), "utf8")).toContain("[[ExactNew]]");
    expect(await fs.readFile(path.join(root, "ExactHub.md"), "utf8")).toContain("[[ExactNew]]");
  });

  it("watcher converges after an ordinary rename without stale FTS or embedding paths", async () => {
    const fixture = await seedWindowsWatcherFixture({
      "Old.md": "# Old\n\nordinarywatchermarker\n",
      "Keep.md": "# Keep\n\nkeepwatchermarker\n"
    });
    const markers = ["ordinarywatchermarker", "keepwatchermarker"] as const;
    const expected = (snapshot: WindowsWatcherSnapshot): boolean =>
      snapshot.diskNames.includes("New.md") &&
      !snapshot.diskNames.includes("Old.md") &&
      markerPaths(snapshot.ftsByMarker, markers[0]).join() === "New.md" &&
      markerPaths(snapshot.embedByMarker, markers[0]).join() === "New.md" &&
      markerPaths(snapshot.ftsByMarker, markers[1]).join() === "Keep.md" &&
      markerPaths(snapshot.embedByMarker, markers[1]).join() === "Keep.md" &&
      snapshot.embedPaths.join() === "Keep.md,New.md" &&
      watcherAuditsMatch(snapshot, 2);

    try {
      await fixture.watcher.start();
      await new Promise((resolve) => setTimeout(resolve, 50));
      const before = await snapshotWindowsWatcherState(fixture, markers);
      expect(expected(before), "NEGATIVE control: pre-rename state must not satisfy the final predicate").toBe(false);
      expect(markerPaths(before.ftsByMarker, markers[0])).toEqual(["Old.md"]);
      expect(markerPaths(before.embedByMarker, markers[0])).toEqual(["Old.md"]);

      await fs.rename(path.join(root, "Old.md"), path.join(root, "New.md"));

      const stable = await waitForStableWindowsWatcherState(
        () => snapshotWindowsWatcherState(fixture, markers),
        expected
      );
      expect(expected(stable)).toBe(true);
      await fixture.watcher.close();
      expect(expected(await snapshotWindowsWatcherState(fixture, markers))).toBe(true);
    } finally {
      await closeWindowsWatcherFixture(fixture);
    }
  });

  it("watcher converges to the exact on-disk casing after a case-only rename", async () => {
    const fixture = await seedWindowsWatcherFixture({
      "Foo.md": "# Foo\n\ncasewatchermarker\n"
    });
    const markers = ["casewatchermarker"] as const;
    const expected = (snapshot: WindowsWatcherSnapshot): boolean =>
      snapshot.diskNames.filter((name) => name.toLowerCase() === "foo.md").join() === "foo.md" &&
      markerPaths(snapshot.ftsByMarker, markers[0]).join() === "foo.md" &&
      markerPaths(snapshot.embedByMarker, markers[0]).join() === "foo.md" &&
      snapshot.embedPaths.join() === "foo.md" &&
      watcherAuditsMatch(snapshot, 1);

    try {
      await fixture.watcher.start();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await fs.readFile(path.join(root, "foo.md"), "utf8")).toContain("casewatchermarker");
      const before = await snapshotWindowsWatcherState(fixture, markers);
      expect(expected(before), "NEGATIVE control: pre-rename casing must not satisfy the final predicate").toBe(false);
      expect(markerPaths(before.ftsByMarker, markers[0])).toEqual(["Foo.md"]);
      expect(markerPaths(before.embedByMarker, markers[0])).toEqual(["Foo.md"]);

      await fs.rename(path.join(root, "Foo.md"), path.join(root, "foo.md"));

      const stable = await waitForStableWindowsWatcherState(
        () => snapshotWindowsWatcherState(fixture, markers),
        expected
      );
      expect(expected(stable)).toBe(true);
      await fixture.watcher.close();
      expect(expected(await snapshotWindowsWatcherState(fixture, markers))).toBe(true);
    } finally {
      await closeWindowsWatcherFixture(fixture);
    }
  });

  it("watcher converges after one same-path atomic replacement without stale content", async () => {
    const fixture = await seedWindowsWatcherFixture({
      "Atomic.md": "# Atomic\n\noldatomicwatchermarker\n"
    });
    const replacement = path.join(root, "Atomic.swap");
    const replacementContent = "# Atomic\n\nnewatomicwatchermarker\n";
    const markers = ["oldatomicwatchermarker", "newatomicwatchermarker"] as const;
    const expected = (snapshot: WindowsWatcherSnapshot): boolean =>
      !snapshot.diskNames.includes("Atomic.swap") &&
      snapshot.diskNames.includes("Atomic.md") &&
      markerPaths(snapshot.ftsByMarker, markers[0]).length === 0 &&
      markerPaths(snapshot.embedByMarker, markers[0]).length === 0 &&
      markerPaths(snapshot.ftsByMarker, markers[1]).join() === "Atomic.md" &&
      markerPaths(snapshot.embedByMarker, markers[1]).join() === "Atomic.md" &&
      snapshot.embedPaths.join() === "Atomic.md" &&
      watcherAuditsMatch(snapshot, 1);

    try {
      await fs.writeFile(replacement, replacementContent);
      await fixture.watcher.start();
      await new Promise((resolve) => setTimeout(resolve, 50));
      const before = await snapshotWindowsWatcherState(fixture, markers);
      expect(expected(before), "NEGATIVE control: old bytes must not satisfy the replacement predicate").toBe(false);
      expect(markerPaths(before.ftsByMarker, markers[0])).toEqual(["Atomic.md"]);
      expect(markerPaths(before.embedByMarker, markers[0])).toEqual(["Atomic.md"]);

      await fs.rename(replacement, path.join(root, "Atomic.md"));

      const stable = await waitForStableWindowsWatcherState(
        () => snapshotWindowsWatcherState(fixture, markers),
        expected
      );
      expect(expected(stable)).toBe(true);
      expect(await fs.readFile(path.join(root, "Atomic.md"), "utf8")).toBe(replacementContent);
      await fixture.watcher.close();
      expect(expected(await snapshotWindowsWatcherState(fixture, markers))).toBe(true);
    } finally {
      await closeWindowsWatcherFixture(fixture);
    }
  });

  it("watcher indexes a moved-in directory but never follows its junction", async () => {
    const fixture = await seedWindowsWatcherFixture({});
    const sentinelDir = path.join(outside, "sentinel");
    const sentinel = path.join(sentinelDir, "Secret.md");
    const staging = path.join(outside, "Incoming.staging");
    const sentinelContent = "# Secret\n\njunctionsecretwatchermarker\n";
    const markers = ["junctionvisiblewatchermarker", "junctionsecretwatchermarker"] as const;
    const expected = (snapshot: WindowsWatcherSnapshot): boolean =>
      snapshot.diskNames.includes("Incoming") &&
      markerPaths(snapshot.ftsByMarker, markers[0]).join() === "Incoming/Visible.md" &&
      markerPaths(snapshot.embedByMarker, markers[0]).join() === "Incoming/Visible.md" &&
      markerPaths(snapshot.ftsByMarker, markers[1]).length === 0 &&
      markerPaths(snapshot.embedByMarker, markers[1]).length === 0 &&
      snapshot.embedPaths.join() === "Incoming/Visible.md" &&
      watcherAuditsMatch(snapshot, 1);

    try {
      await fs.mkdir(sentinelDir, { recursive: true });
      await fs.writeFile(sentinel, sentinelContent);
      await fs.mkdir(staging, { recursive: true });
      await fs.writeFile(path.join(staging, "Visible.md"), "# Visible\n\njunctionvisiblewatchermarker\n");
      await fs.symlink(sentinelDir, path.join(staging, "Outside"), "junction");
      await fixture.watcher.start();
      await new Promise((resolve) => setTimeout(resolve, 50));
      const before = await snapshotWindowsWatcherState(fixture, markers);
      expect(expected(before), "NEGATIVE control: the empty index must not satisfy the moved-tree predicate").toBe(
        false
      );

      await fs.rename(staging, path.join(root, "Incoming"));

      const stable = await waitForStableWindowsWatcherState(
        () => snapshotWindowsWatcherState(fixture, markers),
        expected
      );
      expect(expected(stable)).toBe(true);
      expect(await fs.readFile(path.join(root, "Incoming", "Outside", "Secret.md"), "utf8")).toBe(sentinelContent);
      expect(await fs.readFile(sentinel, "utf8")).toBe(sentinelContent);
      await fixture.watcher.close();
      expect(expected(await snapshotWindowsWatcherState(fixture, markers))).toBe(true);
      expect([...new Set(fixture.reindexedPaths)]).toEqual(["Incoming/Visible.md"]);
    } finally {
      await closeWindowsWatcherFixture(fixture, [
        path.join(root, "Incoming", "Outside"),
        path.join(outside, "Incoming.staging", "Outside")
      ]);
    }
  });
});
