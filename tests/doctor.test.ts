// Tier-aware, byte-preserving diagnostics for enquire-mcp.
//
// The key safety contract is behavioral: doctor may read vault/index/cache
// state, but it must never invoke a migration-capable database opener or
// create SQLite sidecars beside an index. Tests snapshot bytes + metadata +
// directory entries around current, legacy, foreign-root, corrupt, and active
// WAL fixtures. A negative control runs the real migration primitive against
// the same legacy shape and proves the fixture detects mutation.

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  candidateModelCacheRoots,
  type DoctorCheck,
  type DoctorResult,
  formatCheck,
  formatDoctorResult,
  type RunDoctorOptions,
  runDoctor
} from "../src/doctor.js";
import { EmbedDb } from "../src/embed-db.js";
import {
  DEFAULT_MODEL_ALIAS,
  DEFAULT_RERANKER_ALIAS,
  resolveModel,
  resolveRerankerModel,
  resolveTransformersCacheDir
} from "../src/embeddings.js";
import { defaultIndexFile, FtsIndex } from "../src/fts5.js";
import { EMBED_DB_SCHEMA_VERSION, FTS_SCHEMA_VERSION } from "../src/schema-contract.js";
import { Vault } from "../src/vault.js";
import { watcherActivationGuardPath } from "../src/watcher-activation-guard.js";

let root: string;
let cacheRoot: string;
let canRunSqlite = true;

const embeddingModel = resolveModel(DEFAULT_MODEL_ALIAS);
const rerankerModel = resolveRerankerModel(DEFAULT_RERANKER_ALIAS);

beforeAll(async () => {
  try {
    await import("better-sqlite3");
  } catch {
    canRunSqlite = false;
  }
});

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-doctor-vault-"));
  cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-doctor-cache-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(cacheRoot, { recursive: true, force: true });
});

function diagnose(overrides: Partial<RunDoctorOptions> = {}) {
  return runDoctor({
    vault: root,
    tier: "hybrid",
    modelCacheRoot: cacheRoot,
    modelEntry: embeddingModel,
    dependencyProbe: async () => true,
    ...overrides
  });
}

async function cacheModel(
  model: { hfId: string },
  onnxFile = "model_quantized.onnx",
  targetRoot = cacheRoot
): Promise<void> {
  const dir = path.join(targetRoot, ...model.hfId.split("/"));
  await fs.mkdir(path.join(dir, "onnx"), { recursive: true });
  await fs.writeFile(path.join(dir, "config.json"), '{"model_type":"bert"}');
  await fs.writeFile(path.join(dir, "tokenizer_config.json"), "{}");
  await fs.writeFile(path.join(dir, "tokenizer.json"), "{}");
  await fs.writeFile(path.join(dir, "onnx", onnxFile), Buffer.alloc(1024));
}

async function createFts(file: string, vaultRoot?: string, withRow = false): Promise<void> {
  const resolvedRoot = vaultRoot ?? (await fs.realpath(root));
  const index = new FtsIndex({ file, vaultRoot: resolvedRoot });
  await index.open();
  if (withRow) index.reindexFile("sentinel.md", 1, "sentinel content");
  index.close();
}

async function createEmbed(
  file: string,
  vaultRoot?: string,
  quantization: "f32" | "int8" = "f32",
  withRow = false
): Promise<void> {
  const resolvedRoot = vaultRoot ?? (await fs.realpath(root));
  const db = new EmbedDb({
    file,
    vaultRoot: resolvedRoot,
    modelAlias: embeddingModel.alias,
    dim: embeddingModel.dim,
    quantization
  });
  await db.open();
  if (withRow) {
    db.upsertNote("sentinel.md", 1, [
      {
        chunkIndex: 0,
        lineStart: 1,
        lineEnd: 1,
        textPreview: "sentinel",
        vector: new Float32Array(embeddingModel.dim).fill(1 / Math.sqrt(embeddingModel.dim))
      }
    ]);
  }
  db.close();
}

async function updateMeta(file: string, key: string, value: string): Promise<void> {
  const Database = (await import("better-sqlite3")).default;
  const db = new Database(file);
  db.prepare("UPDATE meta SET value = ? WHERE key = ?").run(value, key);
  db.close();
}

interface FileSnapshot {
  names: string[];
  files: Record<
    string,
    {
      size: number;
      mode: number;
      mtimeMs: number;
      ctimeMs: number;
      ino: number;
      uid: number;
      gid: number;
      nlink: number;
      sha256: string;
    }
  >;
}

async function snapshotDir(dir: string): Promise<FileSnapshot> {
  const names = (await fs.readdir(dir)).sort();
  const files: FileSnapshot["files"] = {};
  for (const name of names) {
    const file = path.join(dir, name);
    const stat = await fs.stat(file);
    if (!stat.isFile()) continue;
    files[name] = {
      size: stat.size,
      mode: stat.mode,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      ino: stat.ino,
      uid: stat.uid,
      gid: stat.gid,
      nlink: stat.nlink,
      sha256: createHash("sha256")
        .update(await fs.readFile(file))
        .digest("hex")
    };
  }
  return { names, files };
}

async function createReadyHybridFixture(): Promise<{ indexFile: string; embedFile: string }> {
  const indexFile = path.join(cacheRoot, "ready.fts5.db");
  const embedFile = path.join(cacheRoot, "ready.embed.db");
  await createFts(indexFile, await fs.realpath(root), true);
  await createEmbed(embedFile, undefined, "f32", true);
  await cacheModel(embeddingModel);
  await cacheModel(rerankerModel, "model_quantized.onnx");
  return { indexFile, embedFile };
}

describe("runDoctor — tiers and readiness", () => {
  it("returns the expected tier-aware result shape", async () => {
    const result = await diagnose();
    expect(result.vault).toBe(root);
    expect(result.tier).toBe("hybrid");
    expect(result.scope).toBe("structural-runtime");
    expect(result.limitations).toContain("index freshness");
    expect(result.limitations).toContain("complete PDF corpus coverage");
    expect(result.limitations).toContain("privacy filters are not an at-rest purge or index-membership audit");
    expect(typeof result.ready).toBe("boolean");
    expect(result.checks.length).toBeGreaterThan(0);
    const total =
      result.summary.ok +
      result.summary.warn +
      result.summary.missing +
      result.summary.error +
      result.summary.unverified;
    expect(total).toBe(result.checks.length);
  });

  it("basic is ready without optional dependencies, models, or indexes", async () => {
    const result = await diagnose({ tier: "basic", dependencyProbe: async () => false });
    expect(result.ready).toBe(true);
    expect(result.summary.missing).toBe(0);
    expect(result.checks.find((check) => check.id === "watcher:activation-guard")).toMatchObject({
      status: "ok",
      required: true
    });
    expect(result.checks.find((check) => check.id === "dep:better-sqlite3")?.status).toBe("warn");
    expect(result.checks.find((check) => check.id === "index:fts5")?.status).toBe("warn");
    expect(result.checks.find((check) => check.id === "model:embedding-cache")?.status).toBe("warn");
  });

  it("basic treats an invalid hybrid-only model selection as advisory", async () => {
    const result = await diagnose({
      tier: "basic",
      modelEntry: undefined,
      modelAlias: "not-a-model",
      dependencyProbe: async () => false
    });
    expect(result.checks.find((check) => check.id === "model:selection")).toMatchObject({
      status: "warn",
      required: false
    });
    expect(result.ready).toBe(true);

    const hybrid = await diagnose({
      tier: "hybrid",
      modelEntry: undefined,
      modelAlias: "not-a-model",
      dependencyProbe: async () => false
    });
    expect(hybrid.checks.find((check) => check.id === "model:selection")).toMatchObject({
      status: "missing",
      required: true
    });
    expect(hybrid.ready).toBe(false);
  });

  it("rejects an unknown tier at the programmatic boundary", async () => {
    await expect(runDoctor({ vault: root, tier: "bogus" as never })).rejects.toThrow(
      /Unknown doctor tier 'bogus'.*basic \| hybrid \| hybrid-live/
    );
  });

  it.each([
    {
      family: "custom embed path",
      options: () => ({ embedFile: path.join(root, "unadmitted-embed-index") }),
      error: "Embedding index file must end exactly in '.embed.db'"
    },
    {
      family: "custom FTS path",
      options: () => ({ indexFile: path.join(root, "unadmitted-fts-index") }),
      error: "FTS index file must end exactly in '.fts5.db'"
    }
  ])("rejects an invalid $family before dependency or Vault work", async ({ options, error }) => {
    const dependencyProbe = vi.fn(async () => true);
    await expect(
      runDoctor({
        vault: path.join(root, "unread-vault"),
        tier: "hybrid",
        ...options(),
        dependencyProbe
      })
    ).rejects.toThrowError(new TypeError(error));
    expect(dependencyProbe).not.toHaveBeenCalled();
  });

  it("publishes the exact required-check set for each tier", async () => {
    const basic = await diagnose({ tier: "basic", dependencyProbe: async () => false });
    const hybrid = await diagnose({ tier: "hybrid", dependencyProbe: async () => false });
    const live = await diagnose({ tier: "hybrid-live", dependencyProbe: async () => false });
    const requiredIds = (result: DoctorResult) =>
      result.checks
        .filter((check) => check.required)
        .map((check) => check.id)
        .sort();

    expect(requiredIds(basic)).toEqual(["vault", "watcher:activation-guard"]);
    expect(requiredIds(hybrid)).toEqual([
      "dep:better-sqlite3",
      "dep:hnsw",
      "dep:transformers",
      "index:embed",
      "index:fts5",
      "model:embedding-cache",
      "model:reranker-cache",
      "vault",
      "watcher:activation-guard"
    ]);
    expect(requiredIds(live)).toEqual([...requiredIds(hybrid), "dep:pdfjs"].sort());

    for (const result of [basic, hybrid, live]) {
      expect(result.checks.find((check) => check.id === "watcher:activation-guard")).toMatchObject({
        status: "ok",
        required: true
      });
    }

    const guardedEmbedFile = defaultIndexFile(await fs.realpath(root)).replace(/\.fts5\.db$/, ".embed.db");
    const guardPath = watcherActivationGuardPath(guardedEmbedFile);
    await fs.mkdir(path.dirname(guardPath), { recursive: true });
    const assertBlockedForEveryTier = async () => {
      for (const tier of ["basic", "hybrid", "hybrid-live"] as const) {
        const result = await diagnose({
          tier,
          dependencyProbe: async () => false
        });
        expect(
          result.checks.find((check) => check.id === "watcher:activation-guard"),
          tier
        ).toMatchObject({
          status: "error",
          required: true
        });
        expect(result.ready, tier).toBe(false);
      }
    };
    const removeExactGuardObject = async () => {
      let stat: import("node:fs").Stats;
      try {
        stat = await fs.lstat(guardPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        await fs.rmdir(guardPath);
      } else {
        await fs.unlink(guardPath);
      }
    };

    // NEGATIVE controls: an authentic-shape directory, a foreign regular
    // object, and a dangling symlink all fail closed. Doctor must not inspect
    // through or remove any of them.
    try {
      await fs.mkdir(guardPath);
      await assertBlockedForEveryTier();
      const directoryResult = await diagnose({
        tier: "hybrid",
        dependencyProbe: async () => false
      });
      const directoryHint = directoryResult.checks.find((check) => check.id === "watcher:activation-guard")?.hint;
      expect(directoryHint).toContain("clear-embeddings");
      expect(directoryHint).toMatch(/strict recovery preflights/i);
      expect(directoryHint).toMatch(/manual ownership audit/i);
      expect((await fs.lstat(guardPath)).isDirectory()).toBe(true);

      const assertManualOwnershipHint = async () => {
        const result = await diagnose({
          tier: "hybrid",
          dependencyProbe: async () => false
        });
        const hint = result.checks.find((check) => check.id === "watcher:activation-guard")?.hint;
        expect(hint).toMatch(/manual ownership inspection/i);
        expect(hint).not.toContain("clear-embeddings");
        expect(hint).not.toContain(guardedEmbedFile);
        expect(hint).not.toContain(guardPath);
        expect((await fs.lstat(guardPath)).isDirectory()).toBe(true);
      };

      // Causal NEGATIVE controls: the same recoverable guard may suggest the
      // cleanup command only while its database is missing or exact-owned.
      // An exactly schema-empty container and a malformed/foreign database
      // receive a path-free manual-ownership hint and leave both artifacts in
      // place. Removing the ownership call would make these cases regress to
      // the missing-database command asserted immediately above.
      await fs.writeFile(guardedEmbedFile, "");
      await assertManualOwnershipHint();
      expect((await fs.stat(guardedEmbedFile)).size).toBe(0);

      const malformedBytes = Buffer.from("not an enquire sqlite database");
      await fs.writeFile(guardedEmbedFile, malformedBytes);
      await assertManualOwnershipHint();
      expect(await fs.readFile(guardedEmbedFile)).toEqual(malformedBytes);
      await fs.unlink(guardedEmbedFile);

      if (canRunSqlite) {
        await createEmbed(guardedEmbedFile, path.join(cacheRoot, "foreign-vault"));
        const foreignBytes = await fs.readFile(guardedEmbedFile);
        await assertManualOwnershipHint();
        expect(await fs.readFile(guardedEmbedFile)).toEqual(foreignBytes);
        await Promise.all(
          [guardedEmbedFile, `${guardedEmbedFile}-wal`, `${guardedEmbedFile}-shm`].map((file) =>
            fs.rm(file, { force: true })
          )
        );

        // Paired positive control: the same present guard and exact supported
        // store for the canonical vault restore the bounded recovery command.
        await createEmbed(guardedEmbedFile);
        const ownedResult = await diagnose({
          tier: "hybrid",
          dependencyProbe: async () => false
        });
        const ownedHint = ownedResult.checks.find((check) => check.id === "watcher:activation-guard")?.hint;
        expect(ownedHint).toContain("clear-embeddings");
        expect(ownedHint).toMatch(/strict recovery preflights/i);
        expect((await fs.lstat(guardPath)).isDirectory()).toBe(true);
      }
      await fs.rmdir(guardPath);

      await fs.writeFile(guardPath, "foreign guard object");
      await assertBlockedForEveryTier();
      expect(await fs.readFile(guardPath, "utf8")).toBe("foreign guard object");
      await fs.unlink(guardPath);

      if (process.platform !== "win32") {
        const missingTarget = path.join(cacheRoot, "missing-guard-target");
        await fs.symlink(missingTarget, guardPath);
        await assertBlockedForEveryTier();
        expect((await fs.lstat(guardPath)).isSymbolicLink()).toBe(true);
        await fs.unlink(guardPath);
      }
    } finally {
      await removeExactGuardObject();
    }

    // A selected custom embedding DB has its own guard. It is advisory for
    // basic, required for both hybrid tiers, and its recovery hint must retain
    // the exact --embed-file override. The default guard check remains present
    // and required because server startup always checks it too.
    const customEmbedFile = path.join(cacheRoot, "selected custom.embed.db");
    const customGuardPath = watcherActivationGuardPath(customEmbedFile);
    await fs.mkdir(customGuardPath);
    try {
      for (const tier of ["basic", "hybrid", "hybrid-live"] as const) {
        const result = await diagnose({
          tier,
          embedFile: customEmbedFile,
          dependencyProbe: async () => false
        });
        expect(
          result.checks.find((check) => check.id === "watcher:activation-guard"),
          tier
        ).toMatchObject({
          required: true,
          status: "ok"
        });
        const customCheck = result.checks.find((check) => check.id === "watcher:selected-activation-guard");
        expect(customCheck, tier).toMatchObject({
          required: tier !== "basic",
          status: tier === "basic" ? "warn" : "error"
        });
        expect(customCheck?.hint, tier).toContain("--embed-file");
        expect(customCheck?.hint, tier).toContain(customEmbedFile);
        expect(customCheck?.hint, tier).toMatch(/strict recovery preflights/i);
        expect(customCheck?.hint, tier).toMatch(/manual ownership audit/i);
        expect(result.ready, tier).toBe(tier === "basic");
      }
      expect((await fs.lstat(customGuardPath)).isDirectory()).toBe(true);
    } finally {
      await fs.rmdir(customGuardPath);
    }

    // Positive control: the conditional custom check still exists and clears
    // when the exact custom guard is absent.
    const clearCustom = await diagnose({
      tier: "hybrid",
      embedFile: customEmbedFile,
      dependencyProbe: async () => false
    });
    expect(clearCustom.checks.find((check) => check.id === "watcher:selected-activation-guard")).toMatchObject({
      status: "ok",
      required: true
    });
  });

  it("NEGATIVE control — hybrid is not ready without its models and indexes", async () => {
    const result = await diagnose({ tier: "hybrid", dependencyProbe: async () => false });
    expect(result.ready).toBe(false);
    expect(result.summary.missing).toBeGreaterThan(0);
    expect(result.checks.find((check) => check.id === "dep:hnsw")?.status).toBe("missing");
  });

  it("hybrid is ready when exact models, dependencies, and both indexes are valid", async (ctx) => {
    if (!canRunSqlite) return ctx.skip();
    const paths = await createReadyHybridFixture();
    const result = await diagnose(paths);
    expect(result.ready).toBe(true);
    expect(result.checks.find((check) => check.id === "index:fts5")?.status).toBe("ok");
    expect(result.checks.find((check) => check.id === "index:embed")?.status).toBe("ok");
    expect(result.checks.find((check) => check.id === "model:reranker-cache")?.status).toBe("ok");
  });

  it("each hybrid prerequisite independently blocks readiness", async (ctx) => {
    if (!canRunSqlite) return ctx.skip();
    const paths = await createReadyHybridFixture();

    for (const [id, specifier] of [
      ["dep:better-sqlite3", "better-sqlite3"],
      ["dep:transformers", "@huggingface/transformers"],
      ["dep:hnsw", "hnswlib-node"]
    ] as const) {
      const result = await diagnose({
        ...paths,
        dependencyProbe: async (candidate) => candidate !== specifier
      });
      const check = result.checks.find((candidate) => candidate.id === id);
      expect(check, id).toMatchObject({ status: "missing", required: true });
      expect(result.ready, id).toBe(false);
    }

    for (const [id, overrides] of [
      ["index:fts5", { ...paths, indexFile: path.join(cacheRoot, "absent.fts5.db") }],
      ["index:embed", { ...paths, embedFile: path.join(cacheRoot, "absent.embed.db") }]
    ] as const) {
      const result = await diagnose(overrides);
      const check = result.checks.find((candidate) => candidate.id === id);
      expect(check, id).toMatchObject({ status: "missing", required: true });
      expect(result.ready, id).toBe(false);
    }

    const rerankerOnly = path.join(cacheRoot, "reranker-only");
    await cacheModel(rerankerModel, "model_quantized.onnx", rerankerOnly);
    const missingEmbedder = await diagnose({ ...paths, modelCacheRoot: rerankerOnly });
    expect(missingEmbedder.checks.find((check) => check.id === "model:embedding-cache")).toMatchObject({
      status: "missing",
      required: true
    });
    expect(missingEmbedder.checks.find((check) => check.id === "model:reranker-cache")?.status).toBe("ok");
    expect(missingEmbedder.ready).toBe(false);

    const embedderOnly = path.join(cacheRoot, "embedder-only");
    await cacheModel(embeddingModel, "model_quantized.onnx", embedderOnly);
    const missingReranker = await diagnose({ ...paths, modelCacheRoot: embedderOnly });
    expect(missingReranker.checks.find((check) => check.id === "model:embedding-cache")?.status).toBe("ok");
    expect(missingReranker.checks.find((check) => check.id === "model:reranker-cache")).toMatchObject({
      status: "missing",
      required: true
    });
    expect(missingReranker.ready).toBe(false);
  });

  it("hybrid-live requires pdfjs while hybrid treats it as advisory", async (ctx) => {
    if (!canRunSqlite) return ctx.skip();
    const paths = await createReadyHybridFixture();
    const withoutPdf = async (specifier: string) => specifier !== "pdfjs-dist/legacy/build/pdf.mjs";
    const hybrid = await diagnose({ ...paths, tier: "hybrid", dependencyProbe: withoutPdf });
    const live = await diagnose({ ...paths, tier: "hybrid-live", dependencyProbe: withoutPdf });
    expect(hybrid.ready).toBe(true);
    expect(hybrid.checks.find((check) => check.id === "dep:pdfjs")?.status).toBe("warn");
    expect(live.ready).toBe(false);
    expect(live.checks.find((check) => check.id === "dep:pdfjs")?.status).toBe("missing");
  });

  it("OCR remains advisory for a fully ready hybrid-live tier", async (ctx) => {
    if (!canRunSqlite) return ctx.skip();
    const paths = await createReadyHybridFixture();
    for (const missing of ["tesseract.js", "@napi-rs/canvas"]) {
      const result = await diagnose({
        ...paths,
        tier: "hybrid-live",
        dependencyProbe: async (specifier) => specifier !== missing
      });
      expect(result.checks.find((check) => check.id === "dep:ocr")).toMatchObject({
        status: "warn",
        required: false
      });
      expect(result.ready, missing).toBe(true);
    }
  });

  it("vault check is ok for a real directory and errors for a nonexistent path", async () => {
    await fs.writeFile(path.join(root, "note.md"), "# Hello\n");
    const good = await diagnose({ tier: "basic" });
    expect(good.checks.find((check) => check.id === "vault")?.detail).toContain("1 markdown");

    const bad = await diagnose({ vault: path.join(root, "missing"), tier: "basic" });
    expect(bad.checks.find((check) => check.id === "vault")?.status).toBe("error");
    expect(bad.ready).toBe(false);

    const alias = `${root}-alias`;
    await fs.symlink(root, alias);
    try {
      const canonical = await fs.realpath(root);
      const throughAlias = await diagnose({
        vault: alias,
        repairCommandPrefix: "/usr/bin/node /opt/enquire/dist/index.js"
      });
      const indexHint = throughAlias.checks.find((check) => check.id === "index:fts5")?.hint ?? "";
      const embeddingsHint = throughAlias.checks.find((check) => check.id === "index:embed")?.hint ?? "";
      expect(indexHint).toContain(`--vault ${canonical}`);
      expect(embeddingsHint).toContain(`--vault ${canonical}`);
      expect(indexHint).not.toContain(alias);
      expect(embeddingsHint).not.toContain(alias);

      const windowsVault = path.join(root, "O'Brien & Notes");
      await fs.mkdir(windowsVault);
      const windowsCanonical = await fs.realpath(windowsVault);
      const windowsPrefix =
        "& 'C:\\Program Files\\nodejs\\node.exe' 'C:\\Program Files\\enquire''s runtime\\dist\\index.js'";
      const windowsResult = await diagnose({
        vault: windowsVault,
        repairCommandPrefix: windowsPrefix,
        repairCommandPlatform: "win32"
      });
      const windowsHint = windowsResult.checks.find((check) => check.id === "index:fts5")?.hint ?? "";
      expect(windowsHint).toBe(`${windowsPrefix} index --vault '${windowsCanonical.replace(/'/g, "''")}'`);
      expect(windowsHint).not.toContain(`'"'"'`); // NEGATIVE: POSIX escaping is invalid for this PowerShell hint.
    } finally {
      await fs.rm(alias, { force: true });
    }
  });

  it("dependency probe failures are contained instead of crashing doctor", async () => {
    const result = await diagnose({
      tier: "basic",
      dependencyProbe: async () => {
        throw new Error("probe failed");
      }
    });
    expect(result.ready).toBe(true);
    expect(result.checks.find((check) => check.id === "dep:transformers")?.status).toBe("warn");
  });
});

describe("runDoctor — exact model cache", () => {
  it("accepts the exact selected embedding and reranker cache entries", async () => {
    await cacheModel(embeddingModel);
    await cacheModel(rerankerModel, "model_quantized.onnx");
    const result = await diagnose({ tier: "basic" });
    expect(result.checks.find((check) => check.id === "model:embedding-cache")?.status).toBe("ok");
    expect(result.checks.find((check) => check.id === "model:reranker-cache")?.status).toBe("ok");
  });

  it("NEGATIVE control — an unrelated Xenova model cannot satisfy the selected model", async () => {
    await cacheModel({ hfId: "Xenova/some-other-model" });
    const physicalPrefix = "/usr/bin/node '/opt/enquire mcp/dist/index.js'";
    const result = await diagnose({ repairCommandPrefix: physicalPrefix });
    const model = result.checks.find((check) => check.id === "model:embedding-cache");
    expect(model?.status).toBe("missing");
    expect(model?.detail).toContain(embeddingModel.hfId);
    expect(model?.detail).toContain(cacheRoot);
    expect(model?.detail).toContain("searched package-local cache root");
    expect(model?.hint).toBe(
      `${physicalPrefix} install-model ${embeddingModel.alias}  (~${embeddingModel.approxSizeMB} MB)`
    );

    const programmaticFallback = await diagnose();
    expect(programmaticFallback.checks.find((check) => check.id === "model:embedding-cache")?.hint).toMatch(
      /^<same-enquire-package-invocation> install-model /
    );
  });

  it("an exact but incomplete cache entry is not reported ready", async () => {
    const dir = path.join(cacheRoot, ...embeddingModel.hfId.split("/"));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "config.json"), "{}");
    const result = await diagnose();
    const model = result.checks.find((check) => check.id === "model:embedding-cache");
    expect(model?.status).toBe("missing");
    expect(model?.detail).toContain("incomplete");
  });

  it("zero-byte required cache artifacts do not satisfy readiness", async () => {
    const dir = path.join(cacheRoot, ...embeddingModel.hfId.split("/"));
    await fs.mkdir(path.join(dir, "onnx"), { recursive: true });
    await fs.writeFile(path.join(dir, "config.json"), "{}");
    await fs.writeFile(path.join(dir, "tokenizer_config.json"), "{}");
    await fs.writeFile(path.join(dir, "tokenizer.json"), "{}");
    await fs.writeFile(path.join(dir, "onnx", "model_quantized.onnx"), "");
    const result = await diagnose();
    const model = result.checks.find((check) => check.id === "model:embedding-cache");
    expect(model?.status).toBe("missing");
    expect(model?.detail).toContain("onnx/model_quantized.onnx");
  });

  it("requires every exact non-empty embedding cache artifact", async () => {
    for (const [name, mutate, expected] of [
      ["config", (dir: string) => fs.rm(path.join(dir, "config.json")), "config.json"],
      ["tokenizer-config", (dir: string) => fs.rm(path.join(dir, "tokenizer_config.json")), "tokenizer_config.json"],
      [
        "tokenizer",
        async (dir: string) => {
          await fs.rm(path.join(dir, "tokenizer.json"));
          await fs.writeFile(path.join(dir, "vocab.txt"), "legacy-looking alternative");
        },
        "tokenizer.json"
      ],
      [
        "onnx-path",
        async (dir: string) => {
          await fs.rename(path.join(dir, "onnx", "model_quantized.onnx"), path.join(dir, "model_quantized.onnx"));
        },
        "onnx/model_quantized.onnx"
      ],
      ["zero-byte-config", (dir: string) => fs.truncate(path.join(dir, "config.json"), 0), "config.json"],
      [
        "case-mismatch",
        (dir: string) => fs.rename(path.join(dir, "config.json"), path.join(dir, "CONFIG.JSON")),
        "config.json"
      ]
    ] as const) {
      const targetRoot = path.join(cacheRoot, name);
      await cacheModel(embeddingModel, "model_quantized.onnx", targetRoot);
      const modelDir = path.join(targetRoot, ...embeddingModel.hfId.split("/"));
      await mutate(modelDir);
      const result = await diagnose({ modelCacheRoot: targetRoot });
      const check = result.checks.find((candidate) => candidate.id === "model:embedding-cache");
      expect(check?.status, name).toBe("missing");
      expect(check?.detail, name).toContain(expected);
    }
  });

  it("requires q8 artifacts rather than arbitrary cached fp32 graphs", async () => {
    for (const [kind, model, checkId] of [
      ["embedding", embeddingModel, "model:embedding-cache"],
      ["reranker", rerankerModel, "model:reranker-cache"]
    ] as const) {
      const targetRoot = path.join(cacheRoot, `wrong-${kind}-dtype`);
      await cacheModel(model, "model.onnx", targetRoot);
      const result = await diagnose({ modelCacheRoot: targetRoot });
      const check = result.checks.find((candidate) => candidate.id === checkId);
      expect(check?.status, kind).toBe("missing");
      expect(check?.detail, kind).toContain("onnx/model_quantized.onnx");
    }
  });

  it("surfaces an invalid programmatic model alias as a required hybrid check", async () => {
    const result = await diagnose({ modelEntry: undefined, modelAlias: "does-not-exist", tier: "hybrid" });
    expect(result.checks.find((check) => check.id === "model:selection")?.status).toBe("missing");
    expect(result.ready).toBe(false);
  });

  it("honors an explicit programmatic model selection instead of silently replacing it from embed metadata", async (ctx) => {
    if (!canRunSqlite) return ctx.skip();
    const embedFile = path.join(cacheRoot, "explicit-model.embed.db");
    const bge = resolveModel("bge");
    await createEmbed(embedFile);
    await cacheModel(embeddingModel);
    await cacheModel(bge);

    const explicit = await diagnose({
      tier: "basic",
      embedFile,
      indexFile: path.join(cacheRoot, "missing.fts5.db"),
      modelEntry: bge
    });
    const explicitIndex = explicit.checks.find((check) => check.id === "index:embed");
    const explicitCache = explicit.checks.find((check) => check.id === "model:embedding-cache");
    expect(explicitIndex?.status).toBe("warn");
    expect(explicitIndex?.detail).toContain(`model alias ${embeddingModel.alias} ≠ selected ${bge.alias}`);
    expect(explicitCache?.label).toContain(`(${bge.alias})`);
    expect(explicitCache?.status).toBe("ok");

    // NEGATIVE control: without an explicit selection, honoring the valid
    // persisted alias is intentional and keeps the index compatible.
    const inferred = await diagnose({
      tier: "basic",
      embedFile,
      indexFile: path.join(cacheRoot, "missing.fts5.db"),
      modelEntry: undefined,
      modelAlias: undefined
    });
    expect(inferred.checks.find((check) => check.id === "index:embed")?.status).toBe("ok");
    expect(inferred.checks.find((check) => check.id === "model:embedding-cache")?.label).toContain(
      `(${embeddingModel.alias})`
    );
  });

  it("candidate roots ignore legacy HF env paths that this runtime does not use", () => {
    const oldHf = process.env.HF_HOME;
    const oldTransformers = process.env.TRANSFORMERS_CACHE;
    process.env.HF_HOME = path.join(cacheRoot, "hf-home");
    process.env.TRANSFORMERS_CACHE = path.join(cacheRoot, "transformers");
    try {
      const roots = candidateModelCacheRoots();
      const runtimeRoot = resolveTransformersCacheDir();
      expect(roots).toEqual(runtimeRoot ? [runtimeRoot] : []);
      expect(roots).not.toContain(path.join(cacheRoot, "hf-home", "hub"));
      expect(roots).not.toContain(path.join(cacheRoot, "transformers"));
    } finally {
      if (oldHf === undefined) delete process.env.HF_HOME;
      else process.env.HF_HOME = oldHf;
      if (oldTransformers === undefined) delete process.env.TRANSFORMERS_CACHE;
      else process.env.TRANSFORMERS_CACHE = oldTransformers;
    }
  });
});

describe("runDoctor — strict source-state preservation", () => {
  it("reads a current FTS index without changing bytes, metadata, or directory entries", async (ctx) => {
    if (!canRunSqlite) return ctx.skip();
    const dir = path.join(cacheRoot, "current");
    await fs.mkdir(dir);
    const indexFile = path.join(dir, "current.fts5.db");
    await createFts(indexFile, await fs.realpath(root), true);
    const before = await snapshotDir(dir);
    const result = await diagnose({
      tier: "basic",
      indexFile,
      embedFile: path.join(dir, "missing.embed.db")
    });
    const after = await snapshotDir(dir);
    expect(result.checks.find((check) => check.id === "index:fts5")?.status).toBe("ok");
    expect(after).toEqual(before);
    expect(after.names).toEqual(["current.fts5.db"]);
  });

  it("validates non-empty f32 and int8 embed indexes without changing their source state", async (ctx) => {
    if (!canRunSqlite) return ctx.skip();
    for (const quantization of ["f32", "int8"] as const) {
      const dir = path.join(cacheRoot, `current-embed-${quantization}`);
      await fs.mkdir(dir);
      const embedFile = path.join(dir, `current-${quantization}.embed.db`);
      await createEmbed(embedFile, undefined, quantization, true);
      const before = await snapshotDir(dir);
      const result = await diagnose({
        tier: "basic",
        indexFile: path.join(dir, "missing.fts5.db"),
        embedFile
      });
      expect(result.checks.find((check) => check.id === "index:embed")?.status, quantization).toBe("ok");
      expect(await snapshotDir(dir), quantization).toEqual(before);
    }
  });

  it("treats every incompatible FTS/embed metadata field as an independent hybrid blocker", async (ctx) => {
    if (!canRunSqlite) return ctx.skip();
    const paths = await createReadyHybridFixture();
    const canonicalRoot = await fs.realpath(root);

    for (const [key, invalid, valid, expected] of [
      ["schema_version", "0", String(FTS_SCHEMA_VERSION), "schema 0"],
      ["vault_root", "/foreign/vault", canonicalRoot, "vault root"],
      ["tokenize_mode", "invalid", "unicode61", "tokenize_mode"]
    ] as const) {
      await updateMeta(paths.indexFile, key, invalid);
      const before = await snapshotDir(cacheRoot);
      const result = await diagnose(paths);
      expect(result.checks.find((check) => check.id === "index:fts5")).toMatchObject({
        status: "missing",
        required: true
      });
      expect(result.checks.find((check) => check.id === "index:fts5")?.detail).toContain(expected);
      expect(await snapshotDir(cacheRoot)).toEqual(before);
      await updateMeta(paths.indexFile, key, valid);
    }

    for (const [key, invalid, valid, expected] of [
      ["schema_version", "0", String(EMBED_DB_SCHEMA_VERSION), "schema 0"],
      ["vault_root", "/foreign/vault", canonicalRoot, "vault root"],
      ["model_alias", "unknown-model", embeddingModel.alias, "unknown"],
      ["dim", "not-a-number", String(embeddingModel.dim), "dim not-a-number"],
      ["quantization", "invalid", "f32", "quantization invalid"]
    ] as const) {
      await updateMeta(paths.embedFile, key, invalid);
      const before = await snapshotDir(cacheRoot);
      const result = await diagnose(paths);
      expect(result.checks.find((check) => check.id === "index:embed")).toMatchObject({
        status: "missing",
        required: true
      });
      expect(result.checks.find((check) => check.id === "index:embed")?.detail).toContain(expected);
      expect(await snapshotDir(cacheRoot)).toEqual(before);
      await updateMeta(paths.embedFile, key, valid);
    }
  });

  it("preserves every legacy-schema row and reports incompatibility instead of migrating", async (ctx) => {
    if (!canRunSqlite) return ctx.skip();
    const dir = path.join(cacheRoot, "legacy");
    await fs.mkdir(dir);
    const indexFile = path.join(dir, "legacy.fts5.db");
    await createFts(indexFile, await fs.realpath(root), true);
    await updateMeta(indexFile, "schema_version", "0");
    const before = await snapshotDir(dir);
    const result = await diagnose({
      indexFile,
      embedFile: path.join(dir, "missing.embed.db")
    });
    const after = await snapshotDir(dir);
    const fts = result.checks.find((check) => check.id === "index:fts5");
    expect(fts?.status).toBe("missing");
    expect(fts?.detail).toContain("schema 0");
    expect(after).toEqual(before);

    const Database = (await import("better-sqlite3")).default;
    const db = new Database(indexFile, { readonly: true });
    expect((db.prepare("SELECT COUNT(*) AS count FROM chunks").get() as { count: number }).count).toBe(1);
    db.close();
  });

  it("NEGATIVE control — FtsIndex.open intentionally rebuilds a same-root tokenizer mismatch", async (ctx) => {
    if (!canRunSqlite) return ctx.skip();
    const dir = path.join(cacheRoot, "legacy-negative");
    await fs.mkdir(dir);
    const indexFile = path.join(dir, "legacy.fts5.db");
    const vaultRoot = await fs.realpath(root);
    const trigramIndex = new FtsIndex({ file: indexFile, vaultRoot, tokenize: "trigram" });
    await trigramIndex.open();
    trigramIndex.reindexFile("sentinel.md", 1, "sentinel content");
    trigramIndex.close();
    const before = await snapshotDir(dir);

    // A low-level no-argument open deliberately retains same-root rebuild
    // authority. Unlike doctor(), changing the requested tokenizer therefore
    // mutates this admitted store and removes its old row.
    const mutatingPrimitive = new FtsIndex({ file: indexFile, vaultRoot });
    await mutatingPrimitive.open();
    expect(mutatingPrimitive.totalChunks()).toBe(0);
    mutatingPrimitive.close();

    const after = await snapshotDir(dir);
    expect(after).not.toEqual(before);
  });

  it("preserves a foreign-root index when a symlinked vault canonicalizes elsewhere", async (ctx) => {
    if (!canRunSqlite) return ctx.skip();
    if (process.platform === "win32") return ctx.skip();
    const dir = path.join(cacheRoot, "foreign");
    await fs.mkdir(dir);
    const alias = path.join(cacheRoot, "vault-alias");
    await fs.symlink(root, alias, "dir");
    const indexFile = path.join(dir, "foreign.fts5.db");
    await createFts(indexFile, alias, true);
    const before = await snapshotDir(dir);
    const result = await diagnose({
      vault: alias,
      tier: "basic",
      indexFile,
      embedFile: path.join(dir, "missing.embed.db")
    });
    const after = await snapshotDir(dir);
    expect(result.checks.find((check) => check.id === "index:fts5")?.detail).toContain("vault root");
    expect(after).toEqual(before);
  });

  it("preserves a corrupt database and reports it without creating sidecars", async () => {
    const dir = path.join(cacheRoot, "corrupt");
    await fs.mkdir(dir);
    const indexFile = path.join(dir, "corrupt.fts5.db");
    await fs.writeFile(indexFile, "not a sqlite database");
    const before = await snapshotDir(dir);
    const result = await diagnose({
      tier: "basic",
      indexFile,
      embedFile: path.join(dir, "missing.embed.db")
    });
    const after = await snapshotDir(dir);
    expect(result.checks.find((check) => check.id === "index:fts5")?.detail).toContain("not a valid SQLite");
    expect(after).toEqual(before);

    const directoryPath = path.join(dir, "directory.fts5.db");
    await fs.mkdir(directoryPath);
    const directoryBefore = await snapshotDir(dir);
    const directoryResult = await diagnose({
      tier: "basic",
      indexFile: directoryPath,
      embedFile: path.join(dir, "missing.embed.db")
    });
    expect(directoryResult.checks.find((check) => check.id === "index:fts5")?.detail).toContain("not a regular file");
    expect(await snapshotDir(dir)).toEqual(directoryBefore);
  });

  it("rejects ordinary and semantically incompatible FTS5 look-alike schemas", async (ctx) => {
    if (!canRunSqlite) return ctx.skip();
    const dir = path.join(cacheRoot, "fake-fts");
    await fs.mkdir(dir);
    const indexFile = path.join(dir, "fake.fts5.db");
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(indexFile);
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE chunks (
        content TEXT, title TEXT, aliases TEXT, rel_path TEXT, chunk_index INTEGER,
        line_start INTEGER, line_end INTEGER, tags TEXT, raw_content TEXT, kind TEXT
      );
      CREATE TABLE source_state (
        rel_path TEXT PRIMARY KEY, mtime_ms INTEGER, n_chunks INTEGER, kind TEXT, indexed_at TEXT
      );
    `);
    const insert = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
    insert.run("schema_version", "5");
    insert.run("vault_root", await fs.realpath(root));
    insert.run("tokenize_mode", "unicode61");
    db.close();
    const before = await snapshotDir(dir);
    const result = await diagnose({
      tier: "basic",
      indexFile,
      embedFile: path.join(dir, "missing.embed.db")
    });
    const after = await snapshotDir(dir);
    expect(result.checks.find((check) => check.id === "index:fts5")?.detail).toContain("not an FTS5 virtual table");
    expect(after).toEqual(before);

    for (const { slug, columns, tokenizer, expected } of [
      {
        slug: "reordered",
        columns:
          "title, content, aliases, scope_tokens, rel_path UNINDEXED, chunk_index UNINDEXED, line_start UNINDEXED, " +
          "line_end UNINDEXED, tags UNINDEXED, raw_content UNINDEXED, kind UNINDEXED",
        tokenizer: "unicode61 remove_diacritics 2",
        expected: "column order is incompatible"
      },
      {
        slug: "missing-scope-token",
        columns:
          "content, title, aliases, rel_path UNINDEXED, chunk_index UNINDEXED, line_start UNINDEXED, " +
          "line_end UNINDEXED, tags UNINDEXED, raw_content UNINDEXED, kind UNINDEXED",
        tokenizer: "unicode61 remove_diacritics 2",
        expected: "missing column(s): scope_tokens"
      },
      {
        slug: "indexed-rel-path",
        columns:
          "content, title, aliases, scope_tokens, rel_path, chunk_index UNINDEXED, line_start UNINDEXED, " +
          "line_end UNINDEXED, tags UNINDEXED, raw_content UNINDEXED, kind UNINDEXED",
        tokenizer: "unicode61 remove_diacritics 2",
        expected: "rel_path must be UNINDEXED"
      },
      {
        slug: "tokenizer-mismatch",
        columns:
          "content, title, aliases, scope_tokens, rel_path UNINDEXED, chunk_index UNINDEXED, line_start UNINDEXED, " +
          "line_end UNINDEXED, tags UNINDEXED, raw_content UNINDEXED, kind UNINDEXED",
        tokenizer: "trigram",
        expected: "tokenizer does not match"
      }
    ] as const) {
      const candidateFile = path.join(dir, `${slug}.fts5.db`);
      const candidate = new Database(candidateFile);
      candidate.exec(`
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE VIRTUAL TABLE chunks USING fts5(${columns}, tokenize='${tokenizer}');
        CREATE TABLE source_state (
          rel_path TEXT PRIMARY KEY,
          mtime_ms INTEGER NOT NULL,
          n_chunks INTEGER NOT NULL,
          kind TEXT NOT NULL DEFAULT 'md',
          indexed_at TEXT NOT NULL
        );
      `);
      const candidateInsert = candidate.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
      candidateInsert.run("schema_version", String(FTS_SCHEMA_VERSION));
      candidateInsert.run("vault_root", await fs.realpath(root));
      candidateInsert.run("tokenize_mode", "unicode61");
      candidate.close();
      const candidateBefore = await snapshotDir(dir);
      const candidateResult = await diagnose({
        tier: "basic",
        indexFile: candidateFile,
        embedFile: path.join(dir, "missing.embed.db")
      });
      expect(candidateResult.checks.find((check) => check.id === "index:fts5")?.detail, slug).toContain(expected);
      expect(await snapshotDir(dir)).toEqual(candidateBefore);
    }

    const compositeFile = path.join(dir, "composite-source-pk.fts5.db");
    const composite = new Database(compositeFile);
    composite.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE VIRTUAL TABLE chunks USING fts5(
        content, title, aliases, scope_tokens, rel_path UNINDEXED, chunk_index UNINDEXED,
        line_start UNINDEXED, line_end UNINDEXED, tags UNINDEXED,
        raw_content UNINDEXED, kind UNINDEXED,
        tokenize='unicode61 remove_diacritics 2'
      );
      CREATE TABLE source_state (
        rel_path TEXT NOT NULL,
        mtime_ms INTEGER NOT NULL,
        n_chunks INTEGER NOT NULL,
        kind TEXT NOT NULL DEFAULT 'md',
        indexed_at TEXT NOT NULL,
        PRIMARY KEY(rel_path, mtime_ms)
      );
    `);
    const compositeInsert = composite.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
    compositeInsert.run("schema_version", String(FTS_SCHEMA_VERSION));
    compositeInsert.run("vault_root", await fs.realpath(root));
    compositeInsert.run("tokenize_mode", "unicode61");
    composite.close();
    const compositeBefore = await snapshotDir(dir);
    const compositeResult = await diagnose({
      tier: "basic",
      indexFile: compositeFile,
      embedFile: path.join(dir, "missing.embed.db")
    });
    expect(compositeResult.checks.find((check) => check.id === "index:fts5")?.detail).toContain(
      "exactly one primary-key column"
    );
    expect(await snapshotDir(dir)).toEqual(compositeBefore);

    const contentlessFile = path.join(dir, "contentless.fts5.db");
    const contentless = new Database(contentlessFile);
    contentless.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE VIRTUAL TABLE chunks USING fts5(
        content, title, aliases, scope_tokens, rel_path UNINDEXED, chunk_index UNINDEXED,
        line_start UNINDEXED, line_end UNINDEXED, tags UNINDEXED,
        raw_content UNINDEXED, kind UNINDEXED,
        tokenize='unicode61 remove_diacritics 2',
        content=''
      );
      CREATE TABLE source_state (
        rel_path TEXT PRIMARY KEY,
        mtime_ms INTEGER NOT NULL,
        n_chunks INTEGER NOT NULL,
        kind TEXT NOT NULL DEFAULT 'md',
        indexed_at TEXT NOT NULL
      );
    `);
    const contentlessInsert = contentless.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
    contentlessInsert.run("schema_version", String(FTS_SCHEMA_VERSION));
    contentlessInsert.run("vault_root", await fs.realpath(root));
    contentlessInsert.run("tokenize_mode", "unicode61");
    contentless.close();
    const contentlessBefore = await snapshotDir(dir);
    const contentlessResult = await diagnose({
      tier: "basic",
      indexFile: contentlessFile,
      embedFile: path.join(dir, "missing.embed.db")
    });
    expect(contentlessResult.checks.find((check) => check.id === "index:fts5")?.detail).toContain(
      "unsupported FTS5 option"
    );
    expect(await snapshotDir(dir)).toEqual(contentlessBefore);

    const compositeMetaFile = path.join(dir, "composite-meta-pk.fts5.db");
    const compositeMeta = new Database(compositeMetaFile);
    compositeMeta.exec(`
      CREATE TABLE meta (
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY(key, value)
      );
      CREATE VIRTUAL TABLE chunks USING fts5(
        content, title, aliases, scope_tokens, rel_path UNINDEXED, chunk_index UNINDEXED,
        line_start UNINDEXED, line_end UNINDEXED, tags UNINDEXED,
        raw_content UNINDEXED, kind UNINDEXED,
        tokenize='unicode61 remove_diacritics 2'
      );
      CREATE TABLE source_state (
        rel_path TEXT PRIMARY KEY,
        mtime_ms INTEGER NOT NULL,
        n_chunks INTEGER NOT NULL,
        kind TEXT NOT NULL DEFAULT 'md',
        indexed_at TEXT NOT NULL
      );
    `);
    const compositeMetaInsert = compositeMeta.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
    compositeMetaInsert.run("schema_version", String(FTS_SCHEMA_VERSION));
    compositeMetaInsert.run("vault_root", await fs.realpath(root));
    compositeMetaInsert.run("tokenize_mode", "unicode61");
    compositeMeta.close();
    const compositeMetaBefore = await snapshotDir(dir);
    const compositeMetaResult = await diagnose({
      tier: "basic",
      indexFile: compositeMetaFile,
      embedFile: path.join(dir, "missing.embed.db")
    });
    expect(compositeMetaResult.checks.find((check) => check.id === "index:fts5")?.detail).toContain(
      "exactly one primary-key column"
    );
    expect(await snapshotDir(dir)).toEqual(compositeMetaBefore);
  });

  it("rejects a look-alike embed schema without required constraints and indexes", async (ctx) => {
    if (!canRunSqlite) return ctx.skip();
    const dir = path.join(cacheRoot, "fake-embed");
    await fs.mkdir(dir);
    const embedFile = path.join(dir, "fake.embed.db");
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(embedFile);
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE embeddings (
        id INTEGER PRIMARY KEY, rel_path TEXT, chunk_index INTEGER, line_start INTEGER,
        line_end INTEGER, text_preview TEXT, vector BLOB, kind TEXT
      );
      CREATE TABLE source_state (
        rel_path TEXT PRIMARY KEY, mtime_ms INTEGER, n_chunks INTEGER, kind TEXT, indexed_at TEXT
      );
    `);
    const insert = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
    for (const [key, value] of [
      ["schema_version", String(EMBED_DB_SCHEMA_VERSION)],
      ["vault_root", await fs.realpath(root)],
      ["model_alias", embeddingModel.alias],
      ["dim", String(embeddingModel.dim)],
      ["quantization", "f32"]
    ]) {
      insert.run(key, value);
    }
    db.close();
    const before = await snapshotDir(dir);
    const result = await diagnose({
      tier: "basic",
      indexFile: path.join(dir, "missing.fts5.db"),
      embedFile
    });
    const check = result.checks.find((candidate) => candidate.id === "index:embed");
    expect(check?.status).toBe("warn");
    expect(check?.detail).toContain("must be NOT NULL");
    expect(await snapshotDir(dir)).toEqual(before);
  });

  it("rejects runtime-incompatible embed schema look-alikes after a current-schema positive control", async (ctx) => {
    if (!canRunSqlite) return ctx.skip();
    const ready = await createReadyHybridFixture();
    expect((await diagnose(ready)).ready).toBe(true);
    const Database = (await import("better-sqlite3")).default;

    for (const { slug, idDeclaration, extraColumn, relPathIndexTable, expected } of [
      {
        slug: "wrong-id-type",
        idDeclaration: "TEXT PRIMARY KEY NOT NULL",
        extraColumn: "",
        relPathIndexTable: "embeddings",
        expected: "declared type INTEGER"
      },
      {
        slug: "missing-autoincrement",
        idDeclaration: "INTEGER PRIMARY KEY",
        extraColumn: "",
        relPathIndexTable: "embeddings",
        expected: "INTEGER PRIMARY KEY AUTOINCREMENT"
      },
      {
        slug: "extra-required-column",
        idDeclaration: "INTEGER PRIMARY KEY AUTOINCREMENT",
        extraColumn: "must_fill TEXT NOT NULL,",
        relPathIndexTable: "embeddings",
        expected: "unexpected column"
      },
      {
        slug: "misplaced-rel-path-index",
        idDeclaration: "INTEGER PRIMARY KEY AUTOINCREMENT",
        extraColumn: "",
        relPathIndexTable: "source_state",
        expected: "embeddings_rel_path index is missing"
      }
    ] as const) {
      const embedFile = path.join(cacheRoot, `${slug}.embed.db`);
      const db = new Database(embedFile);
      db.exec(`
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE embeddings (
          id ${idDeclaration},
          rel_path TEXT NOT NULL,
          chunk_index INTEGER NOT NULL,
          line_start INTEGER NOT NULL,
          line_end INTEGER NOT NULL,
          text_preview TEXT NOT NULL,
          vector BLOB NOT NULL,
          kind TEXT NOT NULL DEFAULT 'md',
          ${extraColumn}
          UNIQUE(rel_path, chunk_index)
        );
        CREATE TABLE source_state (
          rel_path TEXT PRIMARY KEY,
          mtime_ms INTEGER NOT NULL,
          n_chunks INTEGER NOT NULL,
          kind TEXT NOT NULL DEFAULT 'md',
          indexed_at TEXT NOT NULL
        );
        CREATE INDEX embeddings_rel_path ON ${relPathIndexTable}(rel_path);
      `);
      const insert = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
      for (const [key, value] of [
        ["schema_version", String(EMBED_DB_SCHEMA_VERSION)],
        ["vault_root", await fs.realpath(root)],
        ["model_alias", embeddingModel.alias],
        ["dim", String(embeddingModel.dim)],
        ["quantization", "f32"]
      ]) {
        insert.run(key, value);
      }
      db.close();

      const before = await snapshotDir(cacheRoot);
      const result = await diagnose({ indexFile: ready.indexFile, embedFile });
      const check = result.checks.find((candidate) => candidate.id === "index:embed");
      expect(check).toMatchObject({ status: "missing", required: true });
      expect(check?.detail).toContain(expected);
      expect(result.ready).toBe(false);
      expect(await snapshotDir(cacheRoot)).toEqual(before);
    }

    const partialFile = path.join(cacheRoot, "partial-identity.embed.db");
    const partial = new Database(partialFile);
    partial.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE embeddings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rel_path TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        line_start INTEGER NOT NULL,
        line_end INTEGER NOT NULL,
        text_preview TEXT NOT NULL,
        vector BLOB NOT NULL,
        kind TEXT NOT NULL DEFAULT 'md'
      );
      CREATE INDEX embeddings_rel_path ON embeddings(rel_path);
      CREATE UNIQUE INDEX embeddings_chunk_identity
        ON embeddings(rel_path, chunk_index) WHERE kind = 'md';
      CREATE TABLE source_state (
        rel_path TEXT PRIMARY KEY,
        mtime_ms INTEGER NOT NULL,
        n_chunks INTEGER NOT NULL,
        kind TEXT NOT NULL DEFAULT 'md',
        indexed_at TEXT NOT NULL
      );
    `);
    const partialInsert = partial.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
    for (const [key, value] of [
      ["schema_version", String(EMBED_DB_SCHEMA_VERSION)],
      ["vault_root", await fs.realpath(root)],
      ["model_alias", embeddingModel.alias],
      ["dim", String(embeddingModel.dim)],
      ["quantization", "f32"]
    ]) {
      partialInsert.run(key, value);
    }
    partial.close();
    const partialBefore = await snapshotDir(cacheRoot);
    const partialResult = await diagnose({ indexFile: ready.indexFile, embedFile: partialFile });
    expect(partialResult.checks.find((candidate) => candidate.id === "index:embed")?.detail).toContain(
      "UNIQUE(rel_path, chunk_index)"
    );
    expect(partialResult.ready).toBe(false);
    expect(await snapshotDir(cacheRoot)).toEqual(partialBefore);
  });

  it("refuses a live non-empty WAL snapshot without touching the source files", async (ctx) => {
    if (!canRunSqlite) return ctx.skip();
    const dir = path.join(cacheRoot, "active");
    await fs.mkdir(dir);
    const indexFile = path.join(dir, "active.fts5.db");
    const index = new FtsIndex({ file: indexFile, vaultRoot: await fs.realpath(root) });
    await index.open();
    index.reindexFile("active.md", 1, "uncheckpointed row");
    const before = await snapshotDir(dir);
    try {
      const result = await diagnose({
        tier: "hybrid",
        indexFile,
        embedFile: path.join(dir, "missing.embed.db")
      });
      const after = await snapshotDir(dir);
      const fts = result.checks.find((check) => check.id === "index:fts5");
      expect(fts?.status).toBe("unverified");
      expect(fts?.required).toBe(true);
      expect(fts?.detail).toContain("active SQLite");
      expect(result.ready).toBe(false);
      expect(after).toEqual(before);
    } finally {
      index.close();
    }
  });

  it("treats a non-empty rollback journal as unverified and preserves it", async (ctx) => {
    if (!canRunSqlite) return ctx.skip();
    const dir = path.join(cacheRoot, "journal");
    await fs.mkdir(dir);
    const indexFile = path.join(dir, "journal.fts5.db");
    await createFts(indexFile, await fs.realpath(root), true);
    await fs.writeFile(`${indexFile}-journal`, Buffer.alloc(64, 1));
    const before = await snapshotDir(dir);
    const result = await diagnose({
      tier: "hybrid",
      indexFile,
      embedFile: path.join(dir, "missing.embed.db")
    });
    expect(result.checks.find((check) => check.id === "index:fts5")).toMatchObject({
      status: "unverified",
      required: true
    });
    expect(result.ready).toBe(false);
    expect(await snapshotDir(dir)).toEqual(before);
  });

  it("resolves a symlinked database before checking its target-side WAL", async (ctx) => {
    if (!canRunSqlite) return ctx.skip();
    if (process.platform === "win32") return ctx.skip();
    const targetDir = path.join(cacheRoot, "symlink-target");
    const aliasDir = path.join(cacheRoot, "symlink-alias");
    await fs.mkdir(targetDir);
    await fs.mkdir(aliasDir);
    const target = path.join(targetDir, "target.fts5.db");
    const alias = path.join(aliasDir, "alias.fts5.db");
    await createFts(target, await fs.realpath(root), true);
    await fs.symlink(target, alias);
    await fs.writeFile(`${target}-wal`, Buffer.alloc(64, 1));
    const beforeTarget = await snapshotDir(targetDir);
    const beforeAlias = (await fs.readdir(aliasDir)).sort();
    const result = await diagnose({
      tier: "hybrid",
      indexFile: alias,
      embedFile: path.join(aliasDir, "missing.embed.db")
    });
    expect(result.checks.find((check) => check.id === "index:fts5")?.status).toBe("unverified");
    expect(await snapshotDir(targetDir)).toEqual(beforeTarget);
    expect((await fs.readdir(aliasDir)).sort()).toEqual(beforeAlias);
  });

  it("reports an oversized immutable snapshot as unverified, never missing", async (ctx) => {
    if (!canRunSqlite) return ctx.skip();
    const dir = path.join(cacheRoot, "oversized");
    await fs.mkdir(dir);
    const indexFile = path.join(dir, "oversized.fts5.db");
    await createFts(indexFile, await fs.realpath(root), true);
    await fs.truncate(indexFile, 256 * 1024 * 1024 + 1);
    const beforeStat = await fs.stat(indexFile);
    const beforeNames = (await fs.readdir(dir)).sort();

    const hybrid = await diagnose({
      tier: "hybrid",
      indexFile,
      embedFile: path.join(dir, "missing.embed.db")
    });
    const basic = await diagnose({
      tier: "basic",
      indexFile,
      embedFile: path.join(dir, "missing.embed.db")
    });
    const afterStat = await fs.stat(indexFile);
    expect(hybrid.checks.find((check) => check.id === "index:fts5")?.status).toBe("unverified");
    expect(basic.checks.find((check) => check.id === "index:fts5")?.status).toBe("unverified");
    expect(afterStat.size).toBe(beforeStat.size);
    expect(afterStat.mode).toBe(beforeStat.mode);
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
    expect(afterStat.ctimeMs).toBe(beforeStat.ctimeMs);
    expect((await fs.readdir(dir)).sort()).toEqual(beforeNames);
  });

  it("validates embed metadata from a snapshot and preserves incompatible files", async (ctx) => {
    if (!canRunSqlite) return ctx.skip();
    const dir = path.join(cacheRoot, "embed");
    await fs.mkdir(dir);
    const embedFile = path.join(dir, "legacy.embed.db");
    await createEmbed(embedFile);
    await updateMeta(embedFile, "schema_version", "0");
    const before = await snapshotDir(dir);
    const result = await diagnose({
      tier: "basic",
      indexFile: path.join(dir, "missing.fts5.db"),
      embedFile
    });
    const after = await snapshotDir(dir);
    const embed = result.checks.find((check) => check.id === "index:embed");
    expect(embed?.status).toBe("warn");
    expect(embed?.detail).toContain("schema 0");
    expect(after).toEqual(before);
  });

  it("rejects an embedding row whose BLOB length contradicts metadata", async (ctx) => {
    if (!canRunSqlite) return ctx.skip();
    const dir = path.join(cacheRoot, "embed-vector");
    await fs.mkdir(dir);
    const embedFile = path.join(dir, "bad-vector.embed.db");
    const vaultRoot = await fs.realpath(root);
    const embed = new EmbedDb({
      file: embedFile,
      vaultRoot,
      modelAlias: embeddingModel.alias,
      dim: embeddingModel.dim
    });
    await embed.open();
    embed.upsertNote(
      "note.md",
      1,
      [0, 1].map((chunkIndex) => ({
        chunkIndex,
        lineStart: chunkIndex + 1,
        lineEnd: chunkIndex + 1,
        textPreview: `vector ${chunkIndex}`,
        vector: Float32Array.from({ length: embeddingModel.dim }, (_value, index) => (index === 0 ? 1 : 0))
      }))
    );
    embed.close();
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(embedFile);
    db.prepare("UPDATE embeddings SET vector = ? WHERE chunk_index = 1").run(Buffer.alloc(1));
    db.close();
    const before = await snapshotDir(dir);
    const result = await diagnose({
      tier: "basic",
      indexFile: path.join(dir, "missing.fts5.db"),
      embedFile
    });
    const after = await snapshotDir(dir);
    expect(result.checks.find((check) => check.id === "index:embed")?.detail).toContain("vector BLOB length");
    expect(after).toEqual(before);
  });
});

describe("runDoctor — privacy", () => {
  it("reports an active filter and counts only visible notes", async () => {
    await fs.writeFile(path.join(root, "public.md"), "# Public\n");
    await fs.writeFile(path.join(root, "secret.md"), "# Secret\n");
    const result = await diagnose({ tier: "basic", excludeGlobs: ["secret.md"] });
    expect(result.checks.find((check) => check.id === "privacy")?.status).toBe("ok");
    expect(result.checks.find((check) => check.id === "vault")?.detail).toContain("1 markdown");
    expect(result.checks.find((check) => check.id === "vault")?.detail).toContain("after privacy filter");
  });

  it("NEGATIVE control — does not claim a privacy filter when none is set", async () => {
    await fs.writeFile(path.join(root, "note.md"), "# Hi\n");
    const result = await diagnose({ tier: "basic" });
    expect(result.checks.find((check) => check.id === "privacy")).toBeUndefined();
    expect(result.checks.find((check) => check.id === "vault")?.detail).not.toContain("privacy filter");
  });

  it("surfaces an empty-after-trim privacy pattern as an error", async () => {
    await fs.writeFile(path.join(root, "must-not-be-enumerated.md"), "# Private\n");
    const enumerate = vi.spyOn(Vault.prototype, "listMarkdown");
    try {
      const result = await diagnose({ tier: "basic", excludeGlobs: ["   "] });
      expect(result.checks.find((check) => check.id === "privacy")?.status).toBe("error");
      expect(result.checks.find((check) => check.id === "vault")?.detail).toContain("enumeration skipped");
      expect(enumerate).not.toHaveBeenCalled();
      expect(result.ready).toBe(false);
      expect(result.checks.find((check) => check.id === "index:fts5")?.hint).toBeUndefined();
      expect(result.checks.find((check) => check.id === "index:embed")?.hint).toBeUndefined();
    } finally {
      enumerate.mockRestore();
    }
  });

  it("repair hints preserve privacy filters and custom index locations", async () => {
    const indexFile = path.join(cacheRoot, "custom fts.fts5.db");
    const embedFile = path.join(cacheRoot, "custom embed.embed.db");
    const result = await diagnose({
      indexFile,
      embedFile,
      excludeGlobs: ["Private/**", "semi;colon/**"],
      readPaths: ["Projects/**"],
      repairCommandPrefix: "/usr/bin/node '/opt/enquire mcp/dist/index.js'"
    });
    const indexHint = result.checks.find((check) => check.id === "index:fts5")?.hint ?? "";
    const embedHint = result.checks.find((check) => check.id === "index:embed")?.hint ?? "";
    const privacy = "--exclude-glob 'Private/**' 'semi;colon/**' --read-paths 'Projects/**'";
    const canonicalRoot = await fs.realpath(root);
    expect(indexHint).toContain(`index --vault ${canonicalRoot} --index-file '${indexFile}' ${privacy}`);
    expect(embedHint).toContain(`build-embeddings --vault ${canonicalRoot} --embed-file '${embedFile}' ${privacy}`);
    // NEGATIVE control: each repair command carries only its own storage override.
    expect(indexHint).not.toContain("--embed-file");
    expect(embedHint).not.toContain("--index-file");
  });
});

describe("formatCheck + formatDoctorResult", () => {
  function makeCheck(overrides: Partial<DoctorCheck> = {}): DoctorCheck {
    return { id: "test", label: "Test check", status: "ok", required: true, ...overrides };
  }

  it("renders every status and includes actionable detail/hints", () => {
    for (const status of ["ok", "warn", "missing", "error", "unverified"] as const) {
      const output = formatCheck(makeCheck({ status, label: `${status} test`, detail: "DETAIL", hint: "HINT" }));
      expect(output).toContain(`${status} test`);
      expect(output).toContain("DETAIL");
      if (status === "ok") expect(output).not.toContain("HINT");
      else expect(output).toContain("HINT");
      if (status === "unverified") expect(output).toContain("?");
    }
  });

  it("renders the tier in READY and NOT READY verdicts", () => {
    const ready: DoctorResult = {
      vault: "/test/vault",
      tier: "basic",
      scope: "structural-runtime",
      limitations: ["index freshness"],
      ready: true,
      checks: [makeCheck()],
      summary: { ok: 1, warn: 0, missing: 0, error: 0, unverified: 0 }
    };
    expect(formatDoctorResult(ready)).toContain("READY for basic");
    expect(formatDoctorResult(ready)).toContain("0 unverified");
    expect(
      formatDoctorResult({
        ...ready,
        tier: "hybrid",
        ready: false,
        checks: [makeCheck({ status: "missing", label: "fail" })],
        summary: { ok: 0, warn: 0, missing: 1, error: 0, unverified: 0 }
      })
    ).toContain("NOT READY for hybrid");
    expect(
      formatDoctorResult({
        ...ready,
        tier: "hybrid",
        ready: false,
        checks: [makeCheck({ status: "unverified", label: "busy" })],
        summary: { ok: 0, warn: 0, missing: 0, error: 0, unverified: 1 }
      })
    ).toContain("1 unverified");
    expect(formatDoctorResult(ready)).toContain("does not verify index freshness");
  });
});
