import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discoverEmbedDbConfig, EmbedDb, hnswPersistBase } from "../src/embed-db.js";
import { embedConfigurationNeedsReplacement, replaceEmbeddingIndex } from "../src/embed-replacement.js";
import { syncEmbedDb } from "../src/embed-sync.js";
import type { Embedder, EmbeddingModel } from "../src/embeddings.js";
import { acquirePersistenceFamilyLease } from "../src/persistence-coordination.js";
import {
  drainProcessPersistenceLeaseDebts,
  getProcessPersistenceLeaseDebtStatus,
  inspectPersistenceLeases
} from "../src/persistence-lease.js";
import { EMBED_REPLACEMENT_STAGE_FAMILY_KEY, SEMANTIC_PERSISTENCE_FAMILY_KEY } from "../src/semantic-persistence.js";
import { Vault } from "../src/vault.js";

const OLD_MODEL: EmbeddingModel = Object.freeze({
  alias: "old-model",
  hfId: "test/old-model",
  dim: 4,
  approxSizeMB: 0,
  dtype: "q8",
  multilingual: true,
  maxTokens: 128
});

const NEW_MODEL: EmbeddingModel = Object.freeze({
  ...OLD_MODEL,
  alias: "new-model",
  hfId: "test/new-model"
});

let root: string;
let vaultRoot: string;
let embedFile: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-embed-replacement-"));
  vaultRoot = path.join(root, "vault");
  embedFile = path.join(root, "cache", "vault.embed.db");
  await fs.mkdir(vaultRoot, { recursive: true });
  await fs.mkdir(path.dirname(embedFile), { recursive: true });
  vaultRoot = await fs.realpath(vaultRoot);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await drainProcessPersistenceLeaseDebts();
  await fs.rm(root, { recursive: true, force: true });
});

function deterministicEmbedder(model: EmbeddingModel, failNeedle?: string): Embedder {
  return {
    model,
    async embed(texts: readonly string[]): Promise<Float32Array[]> {
      if (failNeedle && texts.some((text) => text.includes(failNeedle))) {
        throw new Error(`synthetic corpus inference failure for ${failNeedle}`);
      }
      return texts.map((text, batchIndex) => {
        const seed = [...text].reduce((sum, char) => sum + (char.codePointAt(0) ?? 0), batchIndex + 1);
        const vector = new Float32Array([1, (seed % 7) + 1, (seed % 11) + 1, (seed % 13) + 1]);
        const norm = Math.sqrt([...vector].reduce((sum, value) => sum + value * value, 0));
        for (let index = 0; index < vector.length; index += 1) {
          vector[index] = (vector[index] ?? 0) / norm;
        }
        return vector;
      });
    }
  };
}

async function seedOldGeneration(relPath = "Legacy.md"): Promise<void> {
  const db = new EmbedDb({
    file: embedFile,
    vaultRoot,
    modelAlias: OLD_MODEL.alias,
    dim: OLD_MODEL.dim,
    quantization: "f32"
  });
  await db.open();
  try {
    db.upsertNote(relPath, 1, [
      {
        chunkIndex: 0,
        lineStart: 1,
        lineEnd: 1,
        textPreview: "OLD_USABLE_VECTOR_SENTINEL",
        vector: new Float32Array([1, 0, 0, 0])
      }
    ]);
  } finally {
    await db.closeAndRelease();
  }
}

async function exactLogicalSnapshot(): Promise<unknown> {
  const Database = (await import("better-sqlite3")).default;
  const db = new Database(embedFile, { readonly: true, fileMustExist: true });
  try {
    return {
      schema: db
        .prepare(
          `SELECT type, name, tbl_name, sql
           FROM sqlite_master
           WHERE name NOT GLOB 'sqlite_*'
           ORDER BY type, name`
        )
        .all(),
      meta: db.prepare("SELECT key, value FROM meta ORDER BY key").all(),
      embeddings: db
        .prepare(
          `SELECT id, rel_path, chunk_index, line_start, line_end, text_preview,
                  hex(vector) AS vector_hex, kind
           FROM embeddings
           ORDER BY id`
        )
        .all(),
      sourceState: db.prepare("SELECT * FROM source_state ORDER BY rel_path, kind").all(),
      sourceQuarantine: db.prepare("SELECT * FROM source_quarantine ORDER BY rel_path, kind").all(),
      sourceRevision: db.prepare("SELECT * FROM source_revision ORDER BY rel_path, kind").all()
    };
  } finally {
    db.close();
  }
}

async function stagedEntries(): Promise<string[]> {
  const prefix = `${path.basename(embedFile)}.enquire-stage-`;
  return (await fs.readdir(path.dirname(embedFile))).filter((entry) => entry.startsWith(prefix)).sort();
}

async function seedHnswFamily(): Promise<string[]> {
  const base = hnswPersistBase(embedFile);
  const artifacts = [`${base}.bin`, `${base}.meta.json`, `${base}.${"a".repeat(48)}.bin`];
  for (const [index, artifact] of artifacts.entries()) {
    await fs.writeFile(artifact, `STALE_HNSW_${index}`, { mode: 0o600 });
  }
  return artifacts;
}

describe("staged embedding replacement", () => {
  it("publishes a model switch and serializes both clear/replacement interleavings", async () => {
    await seedOldGeneration();
    await fs.writeFile(path.join(vaultRoot, "Current.md"), "Replacement generation corpus text.\n");
    const expected = await discoverEmbedDbConfig(embedFile, vaultRoot);
    const oldUuid = expected.kind === "owned" ? expected.meta.instance_uuid : undefined;
    const hnswArtifacts = await seedHnswFamily();
    const liveBeforeStage = await exactLogicalSnapshot();
    const hnswBeforeStage = await Promise.all(hnswArtifacts.map((artifact) => fs.readFile(artifact)));
    const baseEmbedder = deterministicEmbedder(NEW_MODEL);
    let announceStage!: () => void;
    const stageEntered = new Promise<void>((resolve) => {
      announceStage = resolve;
    });
    let resumeStage!: () => void;
    const stageMayContinue = new Promise<void>((resolve) => {
      resumeStage = resolve;
    });
    let stagedInferenceCalls = 0;
    const pausedEmbedder: Embedder = {
      model: NEW_MODEL,
      async embed(texts: readonly string[]): Promise<Float32Array[]> {
        if (stagedInferenceCalls === 0) {
          stagedInferenceCalls += 1;
          announceStage();
          await stageMayContinue;
        }
        return baseEmbedder.embed(texts);
      }
    };

    const replacement = replaceEmbeddingIndex({
      file: embedFile,
      vault: new Vault(vaultRoot),
      expectedDiscovery: expected,
      model: NEW_MODEL,
      quantization: "int8",
      embedder: pausedEmbedder
    });
    await stageEntered;
    const barrierDuringStage = await inspectPersistenceLeases({
      targetPath: embedFile,
      familyKey: EMBED_REPLACEMENT_STAGE_FAMILY_KEY
    });
    const clearerDuringStage = new EmbedDb({
      file: embedFile,
      vaultRoot,
      modelAlias: OLD_MODEL.alias,
      dim: OLD_MODEL.dim
    });
    let clearDuringStageError: unknown;
    try {
      await clearerDuringStage.clearOnDisk();
    } catch (error) {
      clearDuringStageError = error;
    }
    let liveDuringStage: unknown;
    try {
      liveDuringStage = await exactLogicalSnapshot();
    } catch (error) {
      liveDuringStage = error;
    }
    const hnswDuringStage = await Promise.all(
      hnswArtifacts.map((artifact) => fs.readFile(artifact).catch((error: unknown) => error))
    );
    const stagesDuringBuild = await stagedEntries();
    resumeStage();
    let report: Awaited<ReturnType<typeof replaceEmbeddingIndex>> | undefined;
    let replacementError: unknown;
    try {
      report = await replacement;
    } catch (error) {
      replacementError = error;
    }

    expect(barrierDuringStage.leases.map((lease) => lease.role)).toEqual(["publisher"]);
    expect(clearDuringStageError).toMatchObject({ name: "PersistenceLeaseConflictError" });
    expect(liveDuringStage).toEqual(liveBeforeStage);
    expect(hnswDuringStage).toEqual(hnswBeforeStage);
    expect(stagesDuringBuild).toHaveLength(1);
    expect(replacementError).toBeUndefined();
    expect(report?.markdown).toMatchObject({ mode: "replacement", complete: true, failed: 0, total_files: 1 });
    const admitted = await discoverEmbedDbConfig(embedFile, vaultRoot);
    expect(admitted).toMatchObject({
      kind: "owned",
      meta: { model_alias: NEW_MODEL.alias, dim: "4", quantization: "int8" }
    });
    expect(admitted.kind === "owned" ? admitted.meta.instance_uuid : undefined).not.toBe(oldUuid);
    const replacementDb = new EmbedDb({
      file: embedFile,
      vaultRoot,
      modelAlias: NEW_MODEL.alias,
      dim: NEW_MODEL.dim,
      quantization: "int8"
    });
    await replacementDb.open(admitted);
    try {
      expect(replacementDb.getSourceStates("md").map((row) => row.rel_path)).toEqual(["Current.md"]);
      expect(replacementDb.search(new Float32Array([1, 0, 0, 0]), 10).some((row) => row.rel_path === "Legacy.md")).toBe(
        false
      );
      expect(replacementDb.totalChunks()).toBeGreaterThan(0);
    } finally {
      await replacementDb.closeAndRelease();
    }
    for (const artifact of hnswArtifacts) {
      await expect(fs.lstat(artifact)).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(await stagedEntries()).toEqual([]);

    const realUnlink = fs.unlink.bind(fs);
    let announceLiveUnlink!: () => void;
    const liveUnlinkEntered = new Promise<void>((resolve) => {
      announceLiveUnlink = resolve;
    });
    let resumeLiveUnlink!: () => void;
    const liveUnlinkMayContinue = new Promise<void>((resolve) => {
      resumeLiveUnlink = resolve;
    });
    let liveUnlinkPaused = false;
    const unlinkSpy = vi.spyOn(fs, "unlink").mockImplementation(async (candidate) => {
      if (!liveUnlinkPaused && String(candidate) === embedFile) {
        liveUnlinkPaused = true;
        announceLiveUnlink();
        await liveUnlinkMayContinue;
      }
      return realUnlink(candidate);
    });
    const clearerHoldingBarrier = new EmbedDb({
      file: embedFile,
      vaultRoot,
      modelAlias: NEW_MODEL.alias,
      dim: NEW_MODEL.dim,
      quantization: "int8"
    });
    const clearHoldingBarrier = clearerHoldingBarrier.clearOnDisk();
    await liveUnlinkEntered;

    let announceForbiddenStage!: () => void;
    const forbiddenStageEntered = new Promise<void>((resolve) => {
      announceForbiddenStage = resolve;
    });
    let resumeForbiddenStage!: () => void;
    const forbiddenStageMayContinue = new Promise<void>((resolve) => {
      resumeForbiddenStage = resolve;
    });
    const forbiddenEmbedder: Embedder = {
      model: OLD_MODEL,
      async embed(texts: readonly string[]): Promise<Float32Array[]> {
        announceForbiddenStage();
        await forbiddenStageMayContinue;
        return deterministicEmbedder(OLD_MODEL).embed(texts);
      }
    };
    const replacementDuringClear = replaceEmbeddingIndex({
      file: embedFile,
      vault: new Vault(vaultRoot),
      expectedDiscovery: admitted,
      model: OLD_MODEL,
      quantization: "f32",
      embedder: forbiddenEmbedder
    });
    const firstReplacementOutcome = await Promise.race([
      replacementDuringClear.then(
        () => ({ kind: "resolved" as const }),
        (error: unknown) => ({ kind: "rejected" as const, error })
      ),
      forbiddenStageEntered.then(() => ({ kind: "staged" as const }))
    ]);
    const stagesWhileClearHeld = await stagedEntries();
    resumeForbiddenStage();
    const finalReplacementOutcome = await replacementDuringClear.then(
      () => ({ kind: "resolved" as const }),
      (error: unknown) => ({ kind: "rejected" as const, error })
    );
    resumeLiveUnlink();
    const clearHoldingBarrierOutcome = await clearHoldingBarrier.then(
      (removed) => ({ kind: "resolved" as const, removed }),
      (error: unknown) => ({ kind: "rejected" as const, error })
    );
    unlinkSpy.mockRestore();

    expect(firstReplacementOutcome).toMatchObject({
      kind: "rejected",
      error: { name: "PersistenceLeaseConflictError" }
    });
    expect(finalReplacementOutcome).toMatchObject({
      kind: "rejected",
      error: { name: "PersistenceLeaseConflictError" }
    });
    expect(stagesWhileClearHeld).toEqual([]);
    expect(clearHoldingBarrierOutcome).toEqual({ kind: "resolved", removed: true });
    await expect(fs.lstat(embedFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports a committed replacement as success after either transient postcommit release fault", async () => {
    await seedOldGeneration();
    await fs.writeFile(path.join(vaultRoot, "Current.md"), "Committed replacement must not invite a retry.\n");
    const phases = [
      { markerRole: "eraser", targetModel: NEW_MODEL },
      { markerRole: "publisher", targetModel: OLD_MODEL }
    ] as const;

    for (const phase of phases) {
      const expected = await discoverEmbedDbConfig(embedFile, vaultRoot);
      const realRename = fs.rename.bind(fs);
      const realUnlink = fs.unlink.bind(fs);
      let commitObserved = false;
      let releaseFaults = 0;
      const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (oldPath, newPath) => {
        await realRename(oldPath, newPath);
        if (
          path.basename(String(newPath)) === path.basename(embedFile) &&
          String(oldPath).includes(".enquire-stage-")
        ) {
          commitObserved = true;
        }
      });
      const unlinkSpy = vi.spyOn(fs, "unlink").mockImplementation(async (candidate) => {
        const marker = path.basename(String(candidate));
        if (commitObserved && releaseFaults === 0 && marker.startsWith(`lease.${phase.markerRole}.`)) {
          releaseFaults += 1;
          throw Object.assign(new Error("synthetic post-commit lease release failure"), { code: "EIO" });
        }
        return realUnlink(candidate);
      });

      let result: Awaited<ReturnType<typeof replaceEmbeddingIndex>> | undefined;
      let failure: unknown;
      let debtAfterCall: ReturnType<typeof getProcessPersistenceLeaseDebtStatus> | undefined;
      try {
        result = await replaceEmbeddingIndex({
          file: embedFile,
          vault: new Vault(vaultRoot),
          expectedDiscovery: expected,
          model: phase.targetModel,
          quantization: "f32",
          embedder: deterministicEmbedder(phase.targetModel)
        });
        debtAfterCall = getProcessPersistenceLeaseDebtStatus();
      } catch (error) {
        failure = error;
      } finally {
        renameSpy.mockRestore();
        unlinkSpy.mockRestore();
        await drainProcessPersistenceLeaseDebts();
      }

      expect(commitObserved).toBe(true);
      expect(releaseFaults).toBe(1);
      expect(failure).toBeUndefined();
      expect(result?.markdown).toMatchObject({ mode: "replacement", complete: true, failed: 0 });
      expect(debtAfterCall).toMatchObject({ ownerCount: 0, artifactCount: 0, saturated: false });
      await expect(discoverEmbedDbConfig(embedFile, vaultRoot)).resolves.toMatchObject({
        kind: "owned",
        meta: { model_alias: phase.targetModel.alias }
      });
    }
    expect(await stagedEntries()).toEqual([]);
  });

  it("reports persistent post-commit cleanup failure without hiding the published generation", async () => {
    await seedOldGeneration();
    await fs.writeFile(path.join(vaultRoot, "Current.md"), "A committed replacement with retained cleanup debt.\n");
    const expected = await discoverEmbedDbConfig(embedFile, vaultRoot);
    const realRename = fs.rename.bind(fs);
    const realUnlink = fs.unlink.bind(fs);
    let commitObserved = false;
    let releaseFaults = 0;
    vi.spyOn(fs, "rename").mockImplementation(async (oldPath, newPath) => {
      await realRename(oldPath, newPath);
      if (path.basename(String(newPath)) === path.basename(embedFile) && String(oldPath).includes(".enquire-stage-")) {
        commitObserved = true;
      }
    });
    vi.spyOn(fs, "unlink").mockImplementation(async (candidate) => {
      if (commitObserved && releaseFaults < 2 && path.basename(String(candidate)).startsWith("lease.eraser.")) {
        releaseFaults += 1;
        throw Object.assign(new Error("synthetic persistent post-commit release failure"), { code: "EIO" });
      }
      return realUnlink(candidate);
    });

    let failure: unknown;
    let debtAfterCall: ReturnType<typeof getProcessPersistenceLeaseDebtStatus> | undefined;
    try {
      await replaceEmbeddingIndex({
        file: embedFile,
        vault: new Vault(vaultRoot),
        expectedDiscovery: expected,
        model: NEW_MODEL,
        quantization: "f32",
        embedder: deterministicEmbedder(NEW_MODEL)
      });
    } catch (error) {
      failure = error;
      debtAfterCall = getProcessPersistenceLeaseDebtStatus();
    } finally {
      vi.restoreAllMocks();
      await drainProcessPersistenceLeaseDebts();
    }

    expect(commitObserved).toBe(true);
    expect(releaseFaults).toBe(2);
    expect(failure).toMatchObject({
      message:
        "Embedding replacement committed, but persistence coordination cleanup remains incomplete; " +
        "do not retry it as an uncommitted build"
    });
    expect(debtAfterCall).toMatchObject({ ownerCount: 1, artifactCount: 2, saturated: false });
    await expect(discoverEmbedDbConfig(embedFile, vaultRoot)).resolves.toMatchObject({
      kind: "owned",
      meta: { model_alias: NEW_MODEL.alias }
    });
    expect(await stagedEntries()).toEqual([]);
  });

  it("keeps the old generation and HNSW bytes exact when corpus inference fails", async () => {
    await seedOldGeneration();
    await fs.writeFile(path.join(vaultRoot, "Failing.md"), "CORPUS_FAIL must fail after the model smoke probe.\n");
    const expected = await discoverEmbedDbConfig(embedFile, vaultRoot);
    const before = await exactLogicalSnapshot();
    const hnswArtifacts = await seedHnswFamily();
    const hnswBefore = await Promise.all(hnswArtifacts.map((artifact) => fs.readFile(artifact)));

    await expect(
      replaceEmbeddingIndex({
        file: embedFile,
        vault: new Vault(vaultRoot),
        expectedDiscovery: expected,
        model: NEW_MODEL,
        quantization: "f32",
        embedder: deterministicEmbedder(NEW_MODEL, "CORPUS_FAIL")
      })
    ).rejects.toThrow(/replacement Markdown embed sync rejected Failing\.md/);

    expect(await exactLogicalSnapshot()).toEqual(before);
    await expect(discoverEmbedDbConfig(embedFile, vaultRoot)).resolves.toEqual(expected);
    for (const [index, artifact] of hnswArtifacts.entries()) {
      expect(await fs.readFile(artifact)).toEqual(hnswBefore[index]);
    }
    expect(await stagedEntries()).toEqual([]);
  });

  it("refuses a stale expected generation before staging or replacing current rows", async () => {
    await seedOldGeneration();
    await fs.writeFile(path.join(vaultRoot, "Current.md"), "A replacement candidate that must not start.\n");
    const staleExpected = await discoverEmbedDbConfig(embedFile, vaultRoot);
    const currentDb = new EmbedDb({
      file: embedFile,
      vaultRoot,
      modelAlias: OLD_MODEL.alias,
      dim: OLD_MODEL.dim
    });
    await currentDb.open(staleExpected);
    try {
      currentDb.upsertNote("Newer.md", 2, [
        {
          chunkIndex: 0,
          lineStart: 1,
          lineEnd: 1,
          textPreview: "NEWER_LIVE_GENERATION_SENTINEL",
          vector: new Float32Array([0, 1, 0, 0])
        }
      ]);
    } finally {
      await currentDb.closeAndRelease();
    }
    const currentBefore = await exactLogicalSnapshot();

    await expect(
      replaceEmbeddingIndex({
        file: embedFile,
        vault: new Vault(vaultRoot),
        expectedDiscovery: staleExpected,
        model: NEW_MODEL,
        quantization: "f32",
        embedder: deterministicEmbedder(NEW_MODEL)
      })
    ).rejects.toThrow(/configuration changed before staged replacement/);

    expect(await exactLogicalSnapshot()).toEqual(currentBefore);
    expect(await stagedEntries()).toEqual([]);
  });

  it("rejects a live mutation during staged sync and preserves the newer DB plus HNSW generation", async () => {
    await seedOldGeneration();
    await fs.writeFile(path.join(vaultRoot, "Current.md"), "Long replacement sync race corpus.\n");
    const expected = await discoverEmbedDbConfig(embedFile, vaultRoot);
    const hnswArtifacts = await seedHnswFamily();
    const hnswBefore = await Promise.all(hnswArtifacts.map((artifact) => fs.readFile(artifact)));
    const baseEmbedder = deterministicEmbedder(NEW_MODEL);
    let mutationCount = 0;
    let newerSnapshot: unknown;
    const racingEmbedder: Embedder = {
      model: NEW_MODEL,
      async embed(texts: readonly string[]): Promise<Float32Array[]> {
        if (mutationCount === 0) {
          mutationCount += 1;
          const liveDiscovery = await discoverEmbedDbConfig(embedFile, vaultRoot);
          const liveDb = new EmbedDb({
            file: embedFile,
            vaultRoot,
            modelAlias: OLD_MODEL.alias,
            dim: OLD_MODEL.dim
          });
          await liveDb.open(liveDiscovery);
          try {
            liveDb.upsertNote("NewerDuringStage.md", 3, [
              {
                chunkIndex: 0,
                lineStart: 1,
                lineEnd: 1,
                textPreview: "NEWER_DURING_STAGE_SENTINEL",
                vector: new Float32Array([0, 0, 1, 0])
              }
            ]);
          } finally {
            await liveDb.closeAndRelease();
          }
          newerSnapshot = await exactLogicalSnapshot();
        }
        return baseEmbedder.embed(texts);
      }
    };

    await expect(
      replaceEmbeddingIndex({
        file: embedFile,
        vault: new Vault(vaultRoot),
        expectedDiscovery: expected,
        model: NEW_MODEL,
        quantization: "f32",
        embedder: racingEmbedder
      })
    ).rejects.toThrow(/configuration changed before open/);

    expect(mutationCount).toBe(1);
    expect(newerSnapshot).toBeDefined();
    expect(await exactLogicalSnapshot()).toEqual(newerSnapshot);
    for (const [index, artifact] of hnswArtifacts.entries()) {
      expect(await fs.readFile(artifact)).toEqual(hnswBefore[index]);
    }
    expect(await stagedEntries()).toEqual([]);
  });

  it.each(["busy lease", "unsafe HNSW leaf"] as const)(
    "does not replace the live generation when final promotion meets a %s",
    async (failureKind) => {
      await seedOldGeneration();
      await fs.writeFile(path.join(vaultRoot, "Current.md"), "Complete staged candidate.\n");
      const expected = await discoverEmbedDbConfig(embedFile, vaultRoot);
      const before = await exactLogicalSnapshot();
      const hnswLegacy = `${hnswPersistBase(embedFile)}.bin`;
      let sharedLease: Awaited<ReturnType<typeof acquirePersistenceFamilyLease>> | null = null;
      if (failureKind === "busy lease") {
        sharedLease = await acquirePersistenceFamilyLease({
          targetPath: embedFile,
          familyKey: SEMANTIC_PERSISTENCE_FAMILY_KEY,
          role: "shared"
        });
      } else {
        await fs.mkdir(hnswLegacy);
      }

      try {
        await expect(
          replaceEmbeddingIndex({
            file: embedFile,
            vault: new Vault(vaultRoot),
            expectedDiscovery: expected,
            model: NEW_MODEL,
            quantization: "f32",
            embedder: deterministicEmbedder(NEW_MODEL)
          })
        ).rejects.toThrow(failureKind === "busy lease" ? /lease|busy|conflict/i : /not a regular file|unsafe/i);
      } finally {
        await sharedLease?.release();
      }

      expect(await exactLogicalSnapshot()).toEqual(before);
      await expect(discoverEmbedDbConfig(embedFile, vaultRoot)).resolves.toEqual(expected);
      expect(await stagedEntries()).toEqual([]);
      if (failureKind === "unsafe HNSW leaf") expect((await fs.lstat(hnswLegacy)).isDirectory()).toBe(true);
    }
  );

  it("keeps the old DB usable when the final rename fails after HNSW invalidation", async () => {
    await seedOldGeneration();
    await fs.writeFile(path.join(vaultRoot, "Current.md"), "Complete candidate whose rename must fail.\n");
    const expected = await discoverEmbedDbConfig(embedFile, vaultRoot);
    const before = await exactLogicalSnapshot();
    const hnswArtifacts = await seedHnswFamily();
    const realRename = fs.rename.bind(fs);
    let renameFaults = 0;
    vi.spyOn(fs, "rename").mockImplementation(async (oldPath, newPath) => {
      if (
        renameFaults === 0 &&
        path.basename(String(newPath)) === path.basename(embedFile) &&
        String(oldPath).includes(".enquire-stage-")
      ) {
        renameFaults += 1;
        throw Object.assign(new Error("synthetic staged promotion rename failure"), { code: "EIO" });
      }
      return realRename(oldPath, newPath);
    });

    try {
      await expect(
        replaceEmbeddingIndex({
          file: embedFile,
          vault: new Vault(vaultRoot),
          expectedDiscovery: expected,
          model: NEW_MODEL,
          quantization: "f32",
          embedder: deterministicEmbedder(NEW_MODEL)
        })
      ).rejects.toThrow(/synthetic staged promotion rename failure/);
    } finally {
      vi.restoreAllMocks();
    }

    expect(renameFaults).toBe(1);
    expect(await exactLogicalSnapshot()).toEqual(before);
    await expect(discoverEmbedDbConfig(embedFile, vaultRoot)).resolves.toEqual(expected);
    const oldDb = new EmbedDb({
      file: embedFile,
      vaultRoot,
      modelAlias: OLD_MODEL.alias,
      dim: OLD_MODEL.dim,
      quantization: "f32"
    });
    await oldDb.open(expected);
    try {
      expect(oldDb.search(new Float32Array([1, 0, 0, 0]), 10).map((row) => row.rel_path)).toContain("Legacy.md");
    } finally {
      await oldDb.closeAndRelease();
    }
    for (const artifact of hnswArtifacts) {
      await expect(fs.lstat(artifact)).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(await stagedEntries()).toEqual([]);
  });

  it("keeps a same-configuration refresh fail-soft and in place", async () => {
    await seedOldGeneration("Failing.md");
    await fs.writeFile(path.join(vaultRoot, "Failing.md"), "SAME_CONFIG_FAIL remains a fail-soft refresh.\n");
    await fs.writeFile(path.join(vaultRoot, "Sibling.md"), "A sibling still indexes successfully.\n");
    const discovered = await discoverEmbedDbConfig(embedFile, vaultRoot);
    const beforeInode = (await fs.stat(embedFile)).ino;
    const beforeUuid = discovered.kind === "owned" ? discovered.meta.instance_uuid : undefined;
    expect(embedConfigurationNeedsReplacement(discovered, OLD_MODEL, "f32")).toBe(false);

    const db = new EmbedDb({
      file: embedFile,
      vaultRoot,
      modelAlias: OLD_MODEL.alias,
      dim: OLD_MODEL.dim,
      quantization: "f32"
    });
    await db.open(discovered);
    try {
      const report = await syncEmbedDb(new Vault(vaultRoot), db, deterministicEmbedder(OLD_MODEL, "SAME_CONFIG_FAIL"));
      expect(report).toMatchObject({ mode: "fail-soft", failed: 1, added: 1 });
      expect(db.getQuarantinedPaths("md")).toContain("Failing.md");
      expect(db.getSourceStates("md").map((row) => row.rel_path)).toContain("Sibling.md");
    } finally {
      await db.closeAndRelease();
    }

    const after = await discoverEmbedDbConfig(embedFile, vaultRoot);
    expect(after.kind === "owned" ? after.meta.instance_uuid : undefined).toBe(beforeUuid);
    expect(after.kind === "owned" ? after.meta.model_alias : undefined).toBe(OLD_MODEL.alias);
    expect((await fs.stat(embedFile)).ino).toBe(beforeInode);
    expect(await stagedEntries()).toEqual([]);
  });
});
