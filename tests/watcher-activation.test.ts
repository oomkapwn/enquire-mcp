import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmbedDb } from "../src/embed-db.js";
import { embedSingleNote } from "../src/embed-pipeline.js";
import type { Embedder } from "../src/embeddings.js";
import { FtsIndex } from "../src/fts5.js";
import type { HnswIndex } from "../src/hnsw.js";
import { Vault } from "../src/vault.js";
import { type HnswRowMeta, statsMtimeMsFromNs, VaultWatcher } from "../src/watcher.js";
import { makePdf } from "./helpers/make-pdf.js";

type NativeEventKind = "add" | "change" | "unlink";

interface ActivationFixture {
  vault: Vault;
  fts: FtsIndex;
  embedDb: EmbedDb;
  watcher: VaultWatcher;
  hnswIndex: HnswIndex;
  hnswLabels: Set<number>;
  hnswRowsByLabel: Map<number, HnswRowMeta>;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

let sandboxRoot: string;
let vaultRoot: string;
let dbRoot: string;
let fixtures: ActivationFixture[];

const deterministicEmbedder = {
  model: {
    alias: "watcher-activation-test",
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

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value: T): void {
      if (!resolvePromise) throw new Error("deferred resolver was not initialized");
      resolvePromise(value);
    }
  };
}

function emit(watcher: VaultWatcher, absPath: string, kind: NativeEventKind): void {
  (
    watcher as unknown as {
      onFsEvent(pathToFile: string, eventKind: NativeEventKind): void;
    }
  ).onFsEvent(absPath, kind);
}

function enqueue(watcher: VaultWatcher, absPath: string, kind: NativeEventKind): Promise<void> {
  return (
    watcher as unknown as {
      enqueueFileEvent(pathToFile: string, eventKind: NativeEventKind): Promise<void>;
    }
  ).enqueueFileEvent(absPath, kind);
}

async function writeWithLaterMtime(absPath: string, content: string | Uint8Array): Promise<void> {
  const before = await fs.stat(absPath);
  await fs.writeFile(absPath, content);
  const nextMtime = new Date(Math.max(Date.now(), before.mtimeMs) + 60_000);
  await fs.utimes(absPath, nextMtime, nextMtime);
}

function capturedPathCount(watcher: VaultWatcher): number {
  return (
    watcher as unknown as {
      activationPaths: ReadonlySet<string>;
    }
  ).activationPaths.size;
}

function capturedStoredIdentities(watcher: VaultWatcher): Array<readonly [string, "md" | "pdf"]> {
  return [
    ...(
      watcher as unknown as {
        activationStoredIdentities: ReadonlyMap<string, "md" | "pdf">;
      }
    ).activationStoredIdentities.entries()
  ];
}

function markerPathsInFts(fts: FtsIndex, marker: string): string[] {
  return [...new Set(fts.search(marker, { limit: 50 }).map((hit) => hit.rel_path))].sort();
}

function markerPathsInEmbedDb(embedDb: EmbedDb, marker: string): string[] {
  return [
    ...new Set(
      embedDb
        .getAllVectors()
        .filter((row) => row.text_preview.includes(marker))
        .map((row) => row.rel_path)
    )
  ].sort();
}

function markerPathsInHnsw(rowsByLabel: ReadonlyMap<number, HnswRowMeta>, marker: string): string[] {
  return [
    ...new Set([...rowsByLabel.values()].filter((row) => row.text_preview.includes(marker)).map((row) => row.rel_path))
  ].sort();
}

function expectHnswMatchesEmbedDb(fixture: ActivationFixture): void {
  const embedRows = fixture.embedDb
    .getAllVectors()
    .map((row) => ({
      label: row.label,
      relPath: row.rel_path,
      chunkIndex: row.chunk_index,
      lineStart: row.line_start,
      lineEnd: row.line_end,
      textPreview: row.text_preview,
      kind: row.kind
    }))
    .sort((a, b) => a.label - b.label);
  const hnswRows = [...fixture.hnswRowsByLabel]
    .map(([label, row]) => ({
      label,
      relPath: row.rel_path,
      chunkIndex: row.chunk_index,
      lineStart: row.line_start,
      lineEnd: row.line_end,
      textPreview: row.text_preview,
      kind: row.kind
    }))
    .sort((a, b) => a.label - b.label);

  expect([...fixture.hnswLabels].sort((a, b) => a - b)).toEqual(embedRows.map((row) => row.label));
  expect(hnswRows).toEqual(embedRows);
}

async function seedNote(
  vault: Vault,
  fts: FtsIndex,
  embedDb: EmbedDb,
  relPath: string,
  content: string
): Promise<string> {
  const absPath = path.join(vault.root, ...relPath.split("/"));
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, content);
  const stat = await fs.stat(absPath);
  fts.reindexFile(relPath, stat.mtimeMs, content);
  const embedded = await embedSingleNote(
    vault,
    deterministicEmbedder,
    { relPath, absPath, mtimeMs: stat.mtimeMs },
    { lateChunkContext: 0 }
  );
  if (!embedded) throw new Error(`activation fixture note produced no chunks: ${relPath}`);
  embedDb.upsertNote(relPath, stat.mtimeMs, embedded.rows);
  return absPath;
}

function fakeHnswFrom(embedDb: EmbedDb | null): {
  index: HnswIndex;
  labels: Set<number>;
  rowsByLabel: Map<number, HnswRowMeta>;
} {
  const rows = embedDb?.getAllVectors() ?? [];
  const labels = new Set(rows.map((row) => row.label));
  const rowsByLabel = new Map<number, HnswRowMeta>(
    rows.map((row) => [
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
  const index: HnswIndex = {
    dim: deterministicEmbedder.model.dim,
    get size() {
      return labels.size;
    },
    searchKnn: () => ({ labels: [], distances: [] }),
    saveTo: async () => true,
    applyDiff(removeLabels, addPoints) {
      let removed = 0;
      for (const label of removeLabels) {
        if (labels.delete(label)) removed += 1;
      }
      for (const point of addPoints) labels.add(point.label);
      return { removed, added: addPoints.length };
    },
    resize: () => {},
    capacity: () => ({ currentCount: labels.size, maxElements: Number.MAX_SAFE_INTEGER })
  };
  return { index, labels, rowsByLabel };
}

async function createFixture(
  notes: Readonly<Record<string, string>>,
  opts: {
    attachSinks?: boolean;
    activationPathLimit?: number;
    embedder?: Embedder;
    deferHnswSnapshot?: boolean;
    deferActivation?: boolean;
    includePdfs?: boolean;
  } = {}
): Promise<ActivationFixture> {
  const vault = new Vault(vaultRoot);
  await vault.ensureExists();
  const fts = new FtsIndex({
    file: path.join(dbRoot, `activation-${fixtures.length}.fts5.db`),
    vaultRoot: vault.root
  });
  const embedDb = new EmbedDb({
    file: path.join(dbRoot, `activation-${fixtures.length}.embed.db`),
    vaultRoot: vault.root,
    modelAlias: deterministicEmbedder.model.alias,
    dim: deterministicEmbedder.model.dim,
    quantization: "f32"
  });

  try {
    await fts.open();
    await embedDb.open();
    for (const [relPath, content] of Object.entries(notes)) {
      await seedNote(vault, fts, embedDb, relPath, content);
    }

    const hnsw = fakeHnswFrom(opts.deferHnswSnapshot === true ? null : embedDb);
    const watcher = new VaultWatcher({
      vault,
      ftsIndex: fts,
      silent: true,
      deferActivation: opts.deferActivation ?? true,
      includePdfs: opts.includePdfs ?? false,
      ...(opts.activationPathLimit === undefined ? {} : { activationPathLimit: opts.activationPathLimit })
    });
    if (opts.attachSinks !== false) {
      watcher.attachEmbed(embedDb, opts.embedder ?? deterministicEmbedder, 0);
      watcher.attachHnsw(hnsw.index, hnsw.rowsByLabel);
    }
    const fixture = {
      vault,
      fts,
      embedDb,
      watcher,
      hnswIndex: hnsw.index,
      hnswLabels: hnsw.labels,
      hnswRowsByLabel: hnsw.rowsByLabel
    };
    fixtures.push(fixture);
    return fixture;
  } catch (error) {
    await embedDb.closeAndRelease().catch(() => {});
    await fts.closeAndRelease().catch(() => {});
    throw error;
  }
}

beforeEach(async () => {
  sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-watcher-activation-"));
  vaultRoot = path.join(sandboxRoot, "vault");
  dbRoot = path.join(sandboxRoot, "db");
  await fs.mkdir(vaultRoot, { recursive: true });
  await fs.mkdir(dbRoot, { recursive: true });
  fixtures = [];
});

afterEach(async () => {
  for (const fixture of fixtures) {
    await fixture.watcher.close().catch(() => {});
    await fixture.embedDb.closeAndRelease().catch(() => {});
    await fixture.fts.closeAndRelease().catch(() => {});
  }
  await fs.rm(sandboxRoot, { recursive: true, force: true });
});

describe("VaultWatcher startup activation barrier", () => {
  it("converges delayed sinks, then freezes only deferred watcher attachments", async () => {
    const fixture = await createFixture(
      { "Boot.md": "# Boot\n\nbootoldmarker is the original indexed state.\n" },
      { attachSinks: false }
    );
    const absPath = path.join(fixture.vault.root, "Boot.md");

    await fs.writeFile(absPath, "# Boot\n\nbootnewmarker is the final on-disk state.\n");
    emit(fixture.watcher, absPath, "change");
    emit(fixture.watcher, absPath, "change");

    expect(capturedPathCount(fixture.watcher)).toBe(1);
    expect(markerPathsInFts(fixture.fts, "bootoldmarker")).toEqual(["Boot.md"]);
    expect(markerPathsInFts(fixture.fts, "bootnewmarker")).toEqual([]);
    expect(markerPathsInEmbedDb(fixture.embedDb, "bootoldmarker")).toEqual(["Boot.md"]);
    expect(markerPathsInEmbedDb(fixture.embedDb, "bootnewmarker")).toEqual([]);
    expect(markerPathsInHnsw(fixture.hnswRowsByLabel, "bootoldmarker")).toEqual(["Boot.md"]);
    expect(markerPathsInHnsw(fixture.hnswRowsByLabel, "bootnewmarker")).toEqual([]);

    fixture.watcher.attachEmbed(fixture.embedDb, deterministicEmbedder, 0);
    fixture.watcher.attachHnsw(fixture.hnswIndex, fixture.hnswRowsByLabel);
    await fixture.watcher.activate();

    expect(markerPathsInFts(fixture.fts, "bootoldmarker")).toEqual([]);
    expect(markerPathsInFts(fixture.fts, "bootnewmarker")).toEqual(["Boot.md"]);
    expect(markerPathsInEmbedDb(fixture.embedDb, "bootoldmarker")).toEqual([]);
    expect(markerPathsInEmbedDb(fixture.embedDb, "bootnewmarker")).toEqual(["Boot.md"]);
    expect(markerPathsInHnsw(fixture.hnswRowsByLabel, "bootoldmarker")).toEqual([]);
    expect(markerPathsInHnsw(fixture.hnswRowsByLabel, "bootnewmarker")).toEqual(["Boot.md"]);
    expectHnswMatchesEmbedDb(fixture);

    expect(() => fixture.watcher.attachEmbed(fixture.embedDb, deterministicEmbedder, 0)).toThrow(
      /deferred attachments are closed/
    );
    expect(() => fixture.watcher.attachHnsw(fixture.hnswIndex, fixture.hnswRowsByLabel)).toThrow(
      /deferred attachments are closed/
    );
    expect(() => fixture.watcher.setOcrPdfs(false)).toThrow(/deferred attachments are closed/);

    const compatible = await createFixture({}, { attachSinks: false, deferActivation: false });
    await compatible.watcher.activate();
    expect(() => compatible.watcher.attachEmbed(compatible.embedDb, deterministicEmbedder, 0)).not.toThrow();
    expect(() => compatible.watcher.attachHnsw(compatible.hnswIndex, compatible.hnswRowsByLabel)).not.toThrow();
    expect(() => compatible.watcher.setOcrPdfs(false)).not.toThrow();
  });

  it("captures attached EmbedDb drift before the HNSW snapshot and restores final parity", async () => {
    const fixture = await createFixture(
      {
        "DeletedWithoutEvent.md":
          "# Deleted without event\n\ndriftdeletedoldmarker must be purged without chokidar help.\n",
        "MutatedWithoutEvent.md":
          "# Mutated without event\n\ndriftmutatedoldmarker must be replaced without chokidar help.\n",
        "Stable.md": "# Stable\n\ndriftstablemarker must remain unchanged.\n"
      },
      { attachSinks: false, deferHnswSnapshot: true }
    );
    const legacyStableIdentity = "A/../Stable.md";
    const stablePath = path.join(fixture.vault.root, "Stable.md");
    const stableContent = await fs.readFile(stablePath, "utf8");
    const stableStat = await fs.stat(stablePath);
    const legacyStableEmbedding = await embedSingleNote(
      fixture.vault,
      deterministicEmbedder,
      {
        relPath: legacyStableIdentity,
        absPath: stablePath,
        mtimeMs: stableStat.mtimeMs
      },
      { lateChunkContext: 0 }
    );
    if (!legacyStableEmbedding) throw new Error("legacy activation identity produced no chunks");
    fixture.fts.reindexFile(legacyStableIdentity, stableStat.mtimeMs, stableContent);
    fixture.embedDb.upsertNote(legacyStableIdentity, stableStat.mtimeMs, legacyStableEmbedding.rows);
    expect(markerPathsInFts(fixture.fts, "driftstablemarker")).toEqual([legacyStableIdentity, "Stable.md"]);
    expect(markerPathsInEmbedDb(fixture.embedDb, "driftstablemarker")).toEqual([legacyStableIdentity, "Stable.md"]);

    fixture.watcher.attachEmbed(fixture.embedDb, deterministicEmbedder, 0);
    const deletedPath = path.join(fixture.vault.root, "DeletedWithoutEvent.md");
    const mutatedPath = path.join(fixture.vault.root, "MutatedWithoutEvent.md");
    const addedPath = path.join(fixture.vault.root, "AddedWithoutEvent.md");

    // Deliberately do not emit any watcher event. This models ignoreInitial
    // swallowing source changes made while chokidar performs its first scan.
    await fs.unlink(deletedPath);
    await fs.writeFile(mutatedPath, "# Mutated without event\n\ndriftmutatedfinalmarker is the final source state.\n");
    const forcedMtime = new Date(Date.now() + 60_000);
    await fs.utimes(mutatedPath, forcedMtime, forcedMtime);
    await fs.writeFile(addedPath, "# Added without event\n\ndriftaddedfinalmarker is the final source state.\n");

    await fixture.watcher.captureAttachedSinkDrift();
    expect(capturedPathCount(fixture.watcher)).toBe(2);
    expect(capturedStoredIdentities(fixture.watcher).sort(([left], [right]) => left.localeCompare(right))).toEqual(
      [
        ["DeletedWithoutEvent.md", "md"],
        [legacyStableIdentity, "md"]
      ].sort(([left], [right]) => left.localeCompare(right))
    );

    // Production snapshots HNSW only after this drift capture. At this point
    // EmbedDb is deliberately stale; activation must apply the captured final
    // states to FTS, EmbedDb, and this exact stale HNSW snapshot together.
    const hnsw = fakeHnswFrom(fixture.embedDb);
    fixture.hnswIndex = hnsw.index;
    fixture.hnswLabels = hnsw.labels;
    fixture.hnswRowsByLabel = hnsw.rowsByLabel;
    fixture.watcher.attachHnsw(hnsw.index, hnsw.rowsByLabel);
    await fixture.watcher.activate();

    for (const marker of ["driftdeletedoldmarker", "driftmutatedoldmarker"]) {
      expect(markerPathsInFts(fixture.fts, marker)).toEqual([]);
      expect(markerPathsInEmbedDb(fixture.embedDb, marker)).toEqual([]);
      expect(markerPathsInHnsw(fixture.hnswRowsByLabel, marker)).toEqual([]);
    }
    for (const [marker, relPath] of [
      ["driftmutatedfinalmarker", "MutatedWithoutEvent.md"],
      ["driftaddedfinalmarker", "AddedWithoutEvent.md"],
      ["driftstablemarker", "Stable.md"]
    ] as const) {
      expect(markerPathsInFts(fixture.fts, marker)).toEqual([relPath]);
      expect(markerPathsInEmbedDb(fixture.embedDb, marker)).toEqual([relPath]);
      expect(markerPathsInHnsw(fixture.hnswRowsByLabel, marker)).toEqual([relPath]);
    }
    expect(fixture.embedDb.getSourceStates("md").map((state) => state.rel_path)).not.toContain(legacyStableIdentity);
    expectHnswMatchesEmbedDb(fixture);
  });

  it("coalesces noisy events and derives every result from final disk state", async () => {
    const fixture = await createFixture({
      "Deleted.md": "# Deleted\n\ndeletedoldmarker must be purged.\n",
      "ExplicitUnlink.md": "# Explicit unlink\n\nexplicitunlinkoldmarker must be replaced.\n",
      "Recreated.md": "# Recreated\n\nrecreatedoldmarker must be replaced.\n"
    });
    const deletedPath = path.join(fixture.vault.root, "Deleted.md");
    const explicitUnlinkPath = path.join(fixture.vault.root, "ExplicitUnlink.md");
    const recreatedPath = path.join(fixture.vault.root, "Recreated.md");

    await fs.writeFile(deletedPath, "# Deleted\n\nintermediatemarker should never be indexed.\n");
    emit(fixture.watcher, deletedPath, "change");
    emit(fixture.watcher, deletedPath, "unlink");
    await fs.unlink(deletedPath);
    emit(fixture.watcher, deletedPath, "add");

    await fs.unlink(recreatedPath);
    emit(fixture.watcher, recreatedPath, "unlink");
    await fs.writeFile(recreatedPath, "# Recreated\n\nrecreatedfinalmarker is authoritative.\n");
    emit(fixture.watcher, recreatedPath, "add");
    emit(fixture.watcher, recreatedPath, "change");

    // Native event order is only a wake-up signal. The final regular file is
    // authoritative even when the last event delivered for it was `unlink`
    // (for example, an editor's unlink-before-replace sequence).
    await fs.writeFile(
      explicitUnlinkPath,
      "# Explicit unlink\n\nexplicitunlinkfinalmarker is the final on-disk state.\n"
    );
    emit(fixture.watcher, explicitUnlinkPath, "change");
    emit(fixture.watcher, explicitUnlinkPath, "unlink");

    expect(capturedPathCount(fixture.watcher)).toBe(3);
    await fixture.watcher.activate();
    await expect(fs.stat(explicitUnlinkPath)).resolves.toBeDefined();

    for (const marker of ["deletedoldmarker", "explicitunlinkoldmarker", "intermediatemarker", "recreatedoldmarker"]) {
      expect(markerPathsInFts(fixture.fts, marker)).toEqual([]);
      expect(markerPathsInEmbedDb(fixture.embedDb, marker)).toEqual([]);
      expect(markerPathsInHnsw(fixture.hnswRowsByLabel, marker)).toEqual([]);
    }
    expect(markerPathsInFts(fixture.fts, "recreatedfinalmarker")).toEqual(["Recreated.md"]);
    expect(markerPathsInEmbedDb(fixture.embedDb, "recreatedfinalmarker")).toEqual(["Recreated.md"]);
    expect(markerPathsInHnsw(fixture.hnswRowsByLabel, "recreatedfinalmarker")).toEqual(["Recreated.md"]);
    expect(markerPathsInFts(fixture.fts, "explicitunlinkfinalmarker")).toEqual(["ExplicitUnlink.md"]);
    expect(markerPathsInEmbedDb(fixture.embedDb, "explicitunlinkfinalmarker")).toEqual(["ExplicitUnlink.md"]);
    expect(markerPathsInHnsw(fixture.hnswRowsByLabel, "explicitunlinkfinalmarker")).toEqual(["ExplicitUnlink.md"]);
    expectHnswMatchesEmbedDb(fixture);
  });

  it("bounds activation planning and replay to four concurrent paths", async () => {
    const planningEntered = deferred<void>();
    const releasePlanning = deferred<void>();
    const replayEntered = deferred<void>();
    const releaseReplay = deferred<void>();
    let activePlans = 0;
    let maxActivePlans = 0;
    let activeReplays = 0;
    let maxActiveReplays = 0;
    const boundedEmbedder: Embedder = {
      model: deterministicEmbedder.model,
      async embed(texts: readonly string[]): Promise<Float32Array[]> {
        activeReplays += 1;
        maxActiveReplays = Math.max(maxActiveReplays, activeReplays);
        replayEntered.resolve(undefined);
        try {
          await releaseReplay.promise;
          return await deterministicEmbedder.embed(texts);
        } finally {
          activeReplays -= 1;
        }
      }
    };
    const relPaths = Array.from({ length: 9 }, (_, index) => `Concurrent-${index}.md`);
    const fixture = await createFixture(
      Object.fromEntries(
        relPaths.map((relPath) => [relPath, `# Concurrent\n\nconcurrentoldmarker ${relPath} must be replaced.\n`])
      ),
      { embedder: boundedEmbedder }
    );
    const canonicalize = fixture.vault.canonicalRelForPrivacyCheckPublic.bind(fixture.vault);
    const canonicalizeSpy = vi
      .spyOn(fixture.vault, "canonicalRelForPrivacyCheckPublic")
      .mockImplementation(async (absPath: string) => {
        activePlans += 1;
        maxActivePlans = Math.max(maxActivePlans, activePlans);
        planningEntered.resolve(undefined);
        try {
          await releasePlanning.promise;
          return await canonicalize(absPath);
        } finally {
          activePlans -= 1;
        }
      });

    for (const relPath of relPaths) {
      const absPath = path.join(fixture.vault.root, relPath);
      await fs.writeFile(absPath, `# Concurrent\n\nconcurrentfinalmarker ${relPath} is authoritative.\n`);
      emit(fixture.watcher, absPath, "change");
    }

    const activation = fixture.watcher.activate();
    try {
      await planningEntered.promise;
      // Every over-admitted task remains blocked, so a short observation turn
      // exposes unbounded Promise.all fan-out instead of sampling a transient.
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      expect(maxActivePlans).toBeGreaterThan(0);
      expect(maxActivePlans).toBeLessThanOrEqual(4);
      releasePlanning.resolve(undefined);

      await replayEntered.promise;
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      expect(maxActiveReplays).toBeGreaterThan(0);
      expect(maxActiveReplays).toBeLessThanOrEqual(4);
      releaseReplay.resolve(undefined);
      await activation;
    } finally {
      // Never strand activation/afterEach behind a failed assertion.
      releasePlanning.resolve(undefined);
      releaseReplay.resolve(undefined);
      await activation.catch(() => {});
      canonicalizeSpy.mockRestore();
    }

    expect(markerPathsInFts(fixture.fts, "concurrentoldmarker")).toEqual([]);
    expect(markerPathsInEmbedDb(fixture.embedDb, "concurrentoldmarker")).toEqual([]);
    expect(markerPathsInHnsw(fixture.hnswRowsByLabel, "concurrentoldmarker")).toEqual([]);
    expect(markerPathsInFts(fixture.fts, "concurrentfinalmarker")).toEqual(relPaths);
    expect(markerPathsInEmbedDb(fixture.embedDb, "concurrentfinalmarker")).toEqual(relPaths);
    expect(markerPathsInHnsw(fixture.hnswRowsByLabel, "concurrentfinalmarker")).toEqual(relPaths);
    expectHnswMatchesEmbedDb(fixture);
  });

  it("(NEGATIVE control) fails closed before replay when the distinct-path cap overflows", async () => {
    const fixture = await createFixture(
      {
        "One.md": "# One\n\noneoldmarker remains until a complete restart.\n",
        "Two.md": "# Two\n\ntwooldmarker remains until a complete restart.\n"
      },
      { activationPathLimit: 1 }
    );
    const onePath = path.join(fixture.vault.root, "One.md");
    const twoPath = path.join(fixture.vault.root, "Two.md");

    await fs.writeFile(onePath, "# One\n\nonenewmarker must not replay partially.\n");
    await fs.writeFile(twoPath, "# Two\n\ntwonewmarker must not replay partially.\n");
    emit(fixture.watcher, onePath, "change");
    emit(fixture.watcher, twoPath, "change");

    expect(capturedPathCount(fixture.watcher)).toBe(1);
    await expect(fixture.watcher.activate()).rejects.toThrow(/more than 1 distinct paths/);
    await expect(fixture.watcher.close()).rejects.toThrow(/more than 1 distinct paths/);

    expect(markerPathsInFts(fixture.fts, "oneoldmarker")).toEqual(["One.md"]);
    expect(markerPathsInFts(fixture.fts, "twooldmarker")).toEqual(["Two.md"]);
    expect(markerPathsInFts(fixture.fts, "onenewmarker")).toEqual([]);
    expect(markerPathsInFts(fixture.fts, "twonewmarker")).toEqual([]);
    expect(markerPathsInEmbedDb(fixture.embedDb, "oneoldmarker")).toEqual(["One.md"]);
    expect(markerPathsInEmbedDb(fixture.embedDb, "twooldmarker")).toEqual(["Two.md"]);
    expect(markerPathsInEmbedDb(fixture.embedDb, "onenewmarker")).toEqual([]);
    expect(markerPathsInEmbedDb(fixture.embedDb, "twonewmarker")).toEqual([]);
    expectHnswMatchesEmbedDb(fixture);
  });

  it("close before explicit activation drains startup capture and rejects later events", async () => {
    const fixture = await createFixture({
      "Close.md": "# Close\n\ncloseoldmarker is the initial state.\n"
    });
    const absPath = path.join(fixture.vault.root, "Close.md");

    await fs.writeFile(absPath, "# Close\n\nclosefinalmarker was captured before shutdown.\n");
    emit(fixture.watcher, absPath, "change");
    await fixture.watcher.close();

    // D-46: close owns every path accepted before shutdown began. It starts
    // activation synchronously and resolves only after final-state replay.
    expect(markerPathsInFts(fixture.fts, "closeoldmarker")).toEqual([]);
    expect(markerPathsInFts(fixture.fts, "closefinalmarker")).toEqual(["Close.md"]);
    expect(markerPathsInEmbedDb(fixture.embedDb, "closeoldmarker")).toEqual([]);
    expect(markerPathsInEmbedDb(fixture.embedDb, "closefinalmarker")).toEqual(["Close.md"]);
    expect(markerPathsInHnsw(fixture.hnswRowsByLabel, "closeoldmarker")).toEqual([]);
    expect(markerPathsInHnsw(fixture.hnswRowsByLabel, "closefinalmarker")).toEqual(["Close.md"]);
    expectHnswMatchesEmbedDb(fixture);

    await fs.writeFile(absPath, "# Close\n\npostclosemarker must stay unprocessed.\n");
    emit(fixture.watcher, absPath, "change");
    expect(markerPathsInFts(fixture.fts, "postclosemarker")).toEqual([]);
    expect(markerPathsInEmbedDb(fixture.embedDb, "postclosemarker")).toEqual([]);
    await expect(fixture.watcher.activate()).rejects.toThrow(/closed/);
  });

  it("close during activation drains a stale markdown stage, its retry, and a subsequent generation", async () => {
    const replayEntered = deferred<void>();
    const releaseReplay = deferred<void>();
    const embedCalls: string[][] = [];
    const blockingEmbedder: Embedder = {
      model: deterministicEmbedder.model,
      async embed(texts: readonly string[]): Promise<Float32Array[]> {
        embedCalls.push([...texts]);
        if (embedCalls.length === 1) {
          replayEntered.resolve(undefined);
          await releaseReplay.promise;
        }
        return deterministicEmbedder.embed(texts);
      }
    };
    const fixture = await createFixture(
      { "During.md": "# During\n\nduringoldmarker is the initial state.\n" },
      { embedder: blockingEmbedder }
    );
    const watcherInternals = fixture.watcher as unknown as {
      inspectVisibleAliasInventoryInLane(): Promise<unknown>;
    };
    const inventorySpy = vi.spyOn(watcherInternals, "inspectVisibleAliasInventoryInLane");
    const readNoteSpy = vi.spyOn(fixture.vault, "readNoteUncached");
    let readNoteCalls = 0;
    let inventoryCalls = 0;
    const duringPath = path.join(fixture.vault.root, "During.md");
    const acceptedPath = path.join(fixture.vault.root, "Accepted.md");
    const ignoredPath = path.join(fixture.vault.root, "Ignored.md");

    await fs.writeFile(duringPath, "# During\n\nduringcandidate marker is staged but must never be published.\n");
    emit(fixture.watcher, duringPath, "change");
    const activation = fixture.watcher.activate();
    let close: Promise<void> | null = null;
    try {
      await replayEntered.promise;

      // S-8d POSITIVE + old-failure NEGATIVE control: the async embedding
      // barrier is still preparation. No configured sink may publish the
      // candidate before every awaited stage has completed.
      expect(markerPathsInFts(fixture.fts, "duringoldmarker")).toEqual(["During.md"]);
      expect(markerPathsInEmbedDb(fixture.embedDb, "duringoldmarker")).toEqual(["During.md"]);
      expect(markerPathsInHnsw(fixture.hnswRowsByLabel, "duringoldmarker")).toEqual(["During.md"]);
      expect(markerPathsInFts(fixture.fts, "duringcandidate")).toEqual([]);
      expect(markerPathsInEmbedDb(fixture.embedDb, "duringcandidate")).toEqual([]);
      expect(markerPathsInHnsw(fixture.hnswRowsByLabel, "duringcandidate")).toEqual([]);

      // Mutate the SAME path while its first embed is blocked, without a second
      // native event. Revalidation must discard the candidate and spend the one
      // bounded retry on this latest physical generation.
      await writeWithLaterMtime(
        duringPath,
        "# During\n\nduringlatestmarker is the authoritative generation that close must drain.\n"
      );

      await fs.writeFile(acceptedPath, "# Accepted\n\nacceptedwhileactivatingmarker must drain before close.\n");
      emit(fixture.watcher, acceptedPath, "add");
      expect(capturedPathCount(fixture.watcher)).toBe(1);
      close = fixture.watcher.close();
      let closeSettled = false;
      void close.then(
        () => {
          closeSettled = true;
        },
        () => {
          closeSettled = true;
        }
      );
      await Promise.resolve();
      expect(closeSettled).toBe(false);

      await fs.writeFile(ignoredPath, "# Ignored\n\nafterclosingmarker must never enter a sink.\n");
      emit(fixture.watcher, ignoredPath, "add");
      releaseReplay.resolve(undefined);
      await Promise.all([activation, close]);
    } finally {
      // A deliberately failing pre-release assertion must never strand the
      // activation queue or afterEach behind the controlled embed barrier.
      releaseReplay.resolve(undefined);
      await activation.catch(() => {});
      if (close) await close.catch(() => {});
      readNoteCalls = readNoteSpy.mock.calls.length;
      inventoryCalls = inventorySpy.mock.calls.length;
      readNoteSpy.mockRestore();
      inventorySpy.mockRestore();
    }

    expect(markerPathsInFts(fixture.fts, "duringoldmarker")).toEqual([]);
    expect(markerPathsInFts(fixture.fts, "duringcandidate")).toEqual([]);
    expect(markerPathsInFts(fixture.fts, "duringlatestmarker")).toEqual(["During.md"]);
    expect(markerPathsInEmbedDb(fixture.embedDb, "duringoldmarker")).toEqual([]);
    expect(markerPathsInEmbedDb(fixture.embedDb, "duringcandidate")).toEqual([]);
    expect(markerPathsInEmbedDb(fixture.embedDb, "duringlatestmarker")).toEqual(["During.md"]);
    expect(markerPathsInHnsw(fixture.hnswRowsByLabel, "duringcandidate")).toEqual([]);
    expect(markerPathsInHnsw(fixture.hnswRowsByLabel, "duringlatestmarker")).toEqual(["During.md"]);
    expect(markerPathsInFts(fixture.fts, "acceptedwhileactivatingmarker")).toEqual(["Accepted.md"]);
    expect(markerPathsInEmbedDb(fixture.embedDb, "acceptedwhileactivatingmarker")).toEqual(["Accepted.md"]);
    expect(markerPathsInHnsw(fixture.hnswRowsByLabel, "acceptedwhileactivatingmarker")).toEqual(["Accepted.md"]);
    expect(markerPathsInFts(fixture.fts, "afterclosingmarker")).toEqual([]);
    expect(markerPathsInEmbedDb(fixture.embedDb, "afterclosingmarker")).toEqual([]);
    expect(markerPathsInHnsw(fixture.hnswRowsByLabel, "afterclosingmarker")).toEqual([]);
    expect(embedCalls).toHaveLength(3);
    expect(embedCalls[0]?.join("\n")).toContain("duringcandidate");
    expect(embedCalls[1]?.join("\n")).toContain("duringlatestmarker");
    expect(embedCalls[2]?.join("\n")).toContain("acceptedwhileactivatingmarker");
    // One source read per attempt: stale During, its retry, then Accepted.
    // The pre-rc.26 embed helper re-read every Markdown path and would record 6.
    expect(readNoteCalls).toBe(3);
    // Content-only drift keeps its bounded exact-path retry. The pre-fix
    // membership classification forced a whole-vault inventory after close
    // began and admitted the otherwise-rejected Ignored.md.
    expect(inventoryCalls).toBe(0);
    expectHnswMatchesEmbedDb(fixture);
  });
});

describe("VaultWatcher single-generation staging", () => {
  it("(NEGATIVE control) reuses one PDF snapshot per attempt and commits only the revalidated retry", async () => {
    const epochScaleNs = 2_000_000_000_111_222_333n;
    expect(statsMtimeMsFromNs(epochScaleNs)).toBe(2_000_000_000_111.2224);
    expect(statsMtimeMsFromNs(epochScaleNs)).not.toBe(Number(epochScaleNs) / 1_000_000);

    const embedCalls: string[][] = [];
    const recordingEmbedder: Embedder = {
      model: deterministicEmbedder.model,
      async embed(texts: readonly string[]): Promise<Float32Array[]> {
        embedCalls.push([...texts]);
        return deterministicEmbedder.embed(texts);
      }
    };
    const fixture = await createFixture({}, { embedder: recordingEmbedder, includePdfs: true });
    const pdfPath = path.join(fixture.vault.root, "Generation.pdf");
    const capturedPdf = makePdf({ pages: ["pdfcapturemarker belongs only to the discarded snapshot"] });
    const latestPdf = makePdf({ pages: ["pdflatestmarker is the only generation safe to publish"] });
    await fs.writeFile(pdfPath, capturedPdf);

    const readBinaryFile = fixture.vault.readBinaryFile.bind(fixture.vault);
    let binaryReads = 0;
    const readSpy = vi.spyOn(fixture.vault, "readBinaryFile").mockImplementation(async (relOrAbs: string) => {
      const captured = await readBinaryFile(relOrAbs);
      binaryReads += 1;
      if (binaryReads === 1) {
        // The first attempt has already captured PDF-A. Replace the physical
        // file before returning those bytes so a second independent read inside
        // the same attempt would see PDF-B (the historical FTS=A/embed=B bug).
        await writeWithLaterMtime(pdfPath, latestPdf);
      }
      return captured;
    });

    emit(fixture.watcher, pdfPath, "add");
    const activation = fixture.watcher.activate();
    try {
      await activation;
    } finally {
      readSpy.mockRestore();
      await activation.catch(() => {});
    }

    // Exactly one binary read + one embed call per physical attempt: discarded
    // PDF-A, then the bounded latest-state retry over PDF-B.
    expect(binaryReads).toBe(2);
    expect(embedCalls).toHaveLength(2);
    expect(embedCalls[0]?.join("\n")).toContain("pdfcapturemarker");
    expect(embedCalls[1]?.join("\n")).toContain("pdflatestmarker");
    expect(markerPathsInFts(fixture.fts, "pdfcapturemarker")).toEqual([]);
    expect(markerPathsInEmbedDb(fixture.embedDb, "pdfcapturemarker")).toEqual([]);
    expect(markerPathsInHnsw(fixture.hnswRowsByLabel, "pdfcapturemarker")).toEqual([]);
    expect(markerPathsInFts(fixture.fts, "pdflatestmarker")).toEqual(["Generation.pdf"]);
    expect(markerPathsInEmbedDb(fixture.embedDb, "pdflatestmarker")).toEqual(["Generation.pdf"]);
    expect(markerPathsInHnsw(fixture.hnswRowsByLabel, "pdflatestmarker")).toEqual(["Generation.pdf"]);
    expectHnswMatchesEmbedDb(fixture);
  });

  it("(NEGATIVE control) bounds one live event and lets a later event recover authoritative stores", async () => {
    let churnPath = "";
    let embedCalls = 0;
    const churningEmbedder: Embedder = {
      model: deterministicEmbedder.model,
      async embed(texts: readonly string[]): Promise<Float32Array[]> {
        embedCalls += 1;
        if (embedCalls === 1) {
          await writeWithLaterMtime(
            churnPath,
            "# Churn\n\nchurnsecondmarker replaces the first staged generation during embed.\n"
          );
        } else if (embedCalls === 2) {
          await writeWithLaterMtime(
            churnPath,
            "# Churn\n\nchurnthirdmarker changes again and exhausts this event's retry budget.\n"
          );
        }
        return deterministicEmbedder.embed(texts);
      }
    };
    const fixture = await createFixture(
      { "Churn.md": "# Churn\n\nchurnoldmarker is the last successfully indexed generation.\n" },
      { embedder: churningEmbedder, deferActivation: false }
    );
    churnPath = path.join(fixture.vault.root, "Churn.md");
    await writeWithLaterMtime(churnPath, "# Churn\n\nchurncandidate marker begins the continuously changing event.\n");

    await enqueue(fixture.watcher, churnPath, "change");

    // Both allowed attempts observed a different post-embed generation, so the
    // event must stop without publishing any of its three transient states.
    expect(embedCalls).toBe(2);
    // The prior rows stay physically recoverable but the observed failed
    // generation durably quarantines both DB authorities. HNSW metadata may
    // retain the old label, but search rehydrates labels from EmbedDb and
    // therefore cannot treat this sidecar text as output authority.
    expect(markerPathsInFts(fixture.fts, "churnoldmarker")).toEqual([]);
    expect(markerPathsInEmbedDb(fixture.embedDb, "churnoldmarker")).toEqual([]);
    expect(markerPathsInHnsw(fixture.hnswRowsByLabel, "churnoldmarker")).toEqual(["Churn.md"]);
    expect(fixture.fts.auditKind("md").mismatched_files).toBe(1);
    expect(fixture.embedDb.auditKind("md").mismatched_files).toBe(1);
    for (const marker of ["churncandidate", "churnsecondmarker", "churnthirdmarker"]) {
      expect(markerPathsInFts(fixture.fts, marker)).toEqual([]);
      expect(markerPathsInEmbedDb(fixture.embedDb, marker)).toEqual([]);
      expect(markerPathsInHnsw(fixture.hnswRowsByLabel, marker)).toEqual([]);
    }

    // Retry exhaustion is per accepted event, not a permanent poison pill for
    // the authoritative SQLite stores. The process-local native graph remains
    // quarantined until restart: its retained metadata is not output authority
    // once hnswUsable is false, and advancing it piecemeal after a missed DB
    // generation would risk blessing an incomplete graph.
    await enqueue(fixture.watcher, churnPath, "change");
    await fixture.watcher.close();
    expect(embedCalls).toBe(3);
    expect(markerPathsInFts(fixture.fts, "churnoldmarker")).toEqual([]);
    expect(markerPathsInEmbedDb(fixture.embedDb, "churnoldmarker")).toEqual([]);
    expect(markerPathsInHnsw(fixture.hnswRowsByLabel, "churnoldmarker")).toEqual(["Churn.md"]);
    expect(markerPathsInFts(fixture.fts, "churnthirdmarker")).toEqual(["Churn.md"]);
    expect(markerPathsInEmbedDb(fixture.embedDb, "churnthirdmarker")).toEqual(["Churn.md"]);
    expect(markerPathsInHnsw(fixture.hnswRowsByLabel, "churnthirdmarker")).toEqual([]);
    expect(fixture.watcher.searchHealth.hnswUsable).toBe(false);
  });
});
