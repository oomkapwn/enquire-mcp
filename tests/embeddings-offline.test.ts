// v3.10.0-rc.42 (audit F1, HIGH) — the serve-mode offline ENFORCEMENT that turns the
// "zero cloud calls during serve" claim into a real code guard (mirrors OCR's
// `assertOcrLangsInstalled`, overclaim #16). Pre-rc.42 the claim was ASPIRATIONAL: a
// missing local model cache let transformers.js silently CDN-fetch (~120MB) on a
// runtime query. Now serve/serve-http/query/eval call setEmbeddingsOffline() →
// `env.allowRemoteModels=false` → a model-load failure fails CLOSED with a repair hint.
//
// These tests exercise the PURE surface (flag + fail-closed error helper) so they run
// in CI WITHOUT the optional `@huggingface/transformers` dep or any model download. The
// WIRING (all four CLI runtime/read actions calling setEmbeddingsOffline) is
// regression-proofed structurally by OIA Check 4f. Positive + NEGATIVE controls per the
// CLAUDE.md rule since v3.6.4.

import { promises as fs, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectEmbeddingsOfflineGuards } from "../scripts/lib/oia-offline-guard.mjs";
import {
  applyOfflineEnv,
  isEmbeddingsOffline,
  offlineModelLoadError,
  setEmbeddingsOffline
} from "../src/embeddings.js";
import { defaultIndexFile } from "../src/fts5.js";
import {
  armWatcherActivationGuard,
  releaseWatcherActivationGuard,
  watcherActivationGuardPath
} from "../src/watcher-activation-guard.js";

afterEach(() => {
  setEmbeddingsOffline(false); // module-global flag — reset so it can't leak across tests
});

describe("embeddings serve-offline enforcement (rc.42 F1)", () => {
  it("default is ONLINE so build-embeddings / install-model can download (NEGATIVE control)", () => {
    // If this defaulted to offline, the one-time model download (build-embeddings /
    // install-model) would fail closed — defeating setup. Serve must OPT IN.
    expect(isEmbeddingsOffline()).toBe(false);
  });

  it("setEmbeddingsOffline toggles and both programmatic server boundaries enforce it (POSITIVE)", async () => {
    setEmbeddingsOffline();
    expect(isEmbeddingsOffline()).toBe(true);
    setEmbeddingsOffline(false);
    expect(isEmbeddingsOffline()).toBe(false);

    const { buildMcpServer, prepareServerDeps } = await import("../src/server.js");
    await expect(
      prepareServerDeps({
        vault: "/not-opened-because-validation-fails",
        feedbackWeight: "not-a-number"
      })
    ).rejects.toThrow();
    expect(isEmbeddingsOffline()).toBe(true);

    // NEGATIVE control for the sibling public boundary: callers may construct
    // ServerDeps themselves and invoke buildMcpServer without preparation.
    setEmbeddingsOffline(false);
    const { Vault } = await import("../src/vault.js");
    const server = buildMcpServer(
      {
        vault: new Vault("/not-opened-by-build"),
        ftsIndex: null,
        watcher: null,
        watcherEmbedDb: null,
        feedbackStore: null,
        disabledTools: new Set(),
        enabledTools: new Set(),
        warningTracker: { printed: false },
        hnswContext: null
      },
      { vault: "/not-opened-by-build" }
    );
    expect(isEmbeddingsOffline()).toBe(true);
    await server.close();

    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-basic-embedding-isolation-"));
    const previousCacheHome = process.env.XDG_CACHE_HOME;
    try {
      const vault = path.join(scratch, "vault");
      const cache = path.join(scratch, "cache");
      await fs.mkdir(vault);
      process.env.XDG_CACHE_HOME = cache;
      // Vault canonicalizes its root with realpath before deriving cache
      // identities. macOS exposes the temp root through both /var and
      // /private/var, so hash the same canonical path the server will use.
      const canonicalVault = await fs.realpath(vault);
      const embedFile = defaultIndexFile(canonicalVault).replace(/\.fts5\.db$/u, ".embed.db");
      await fs.mkdir(path.dirname(embedFile), { recursive: true });

      // A valid index owned by another vault must be refused before watcher
      // activation is armed. This lives in the existing programmatic-boundary
      // registration so the behavior cannot drift away from the offline gate.
      let sqliteAvailable = false;
      try {
        const Database = (await import("better-sqlite3")).default;
        const probe = new Database(":memory:");
        probe.close();
        sqliteAvailable = true;
      } catch {
        // Optional native dependency absent: the structural order gate still
        // runs, while this native integration phase is exercised in CI.
      }
      if (sqliteAvailable) {
        const Database = (await import("better-sqlite3")).default;
        const foreignVault = path.join(scratch, "foreign-vault");
        await fs.mkdir(foreignVault);
        const canonicalForeignVault = await fs.realpath(foreignVault);
        const { EmbedDb, peekEmbedDbMeta } = await import("../src/embed-db.js");
        const seed = new EmbedDb({
          file: embedFile,
          vaultRoot: canonicalForeignVault,
          modelAlias: "multilingual",
          dim: 2
        });
        await seed.open();
        seed.upsertNote("Foreign.md", 1, [
          {
            chunkIndex: 0,
            lineStart: 1,
            lineEnd: 1,
            textPreview: "foreign-owner-marker",
            vector: new Float32Array([1, 0])
          }
        ]);
        seed.close();
        expect((await peekEmbedDbMeta(embedFile, canonicalForeignVault))?.vault_root).toBe(canonicalForeignVault);
        expect(await peekEmbedDbMeta(embedFile, canonicalVault)).toBeNull();
        const logicalSnapshot = () => {
          const inspect = new Database(embedFile, { readonly: true, fileMustExist: true });
          try {
            return {
              schema: inspect
                .prepare(
                  `SELECT type, name, sql
                   FROM sqlite_master
                   WHERE name NOT GLOB 'sqlite_*'
                   ORDER BY type, name`
                )
                .all(),
              meta: inspect.prepare("SELECT key, value FROM meta ORDER BY key").all(),
              rows: inspect
                .prepare(
                  `SELECT id, rel_path, chunk_index, line_start, line_end, text_preview,
                          hex(vector) AS vector_hex, kind
                   FROM embeddings
                   ORDER BY id`
                )
                .all(),
              sourceState: inspect.prepare("SELECT * FROM source_state ORDER BY rel_path, kind").all()
            };
          } finally {
            inspect.close();
          }
        };
        const logicalBeforeForeignRefusal = logicalSnapshot();
        const guardPath = watcherActivationGuardPath(embedFile);
        await expect(fs.lstat(guardPath)).rejects.toThrow();

        let foreignRefusal: unknown;
        try {
          const unexpected = await prepareServerDeps({ vault, watch: true });
          await unexpected.watcher?.close();
          unexpected.watcherEmbedDb?.close();
        } catch (error) {
          foreignRefusal = error;
        }
        expect(foreignRefusal).toBeInstanceOf(Error);
        const foreignMessage = foreignRefusal instanceof Error ? foreignRefusal.message : String(foreignRefusal);
        expect(foreignMessage).toMatch(/configuration could not be verified/i);
        expect(foreignMessage).not.toMatch(/clear-embeddings|embedding-derived indexes are quarantined/i);
        for (const sensitivePath of [vault, canonicalVault, foreignVault, canonicalForeignVault, embedFile]) {
          expect(foreignMessage).not.toContain(sensitivePath);
        }
        expect(logicalSnapshot()).toEqual(logicalBeforeForeignRefusal);
        await expect(fs.lstat(guardPath)).rejects.toThrow();

        const combinedGuard = await armWatcherActivationGuard(embedFile);
        try {
          let combinedRefusal: unknown;
          try {
            await prepareServerDeps({ vault, watch: true });
          } catch (error) {
            combinedRefusal = error;
          }
          expect(combinedRefusal).toBeInstanceOf(Error);
          const combinedMessage = combinedRefusal instanceof Error ? combinedRefusal.message : String(combinedRefusal);
          expect(combinedMessage).toBe("Embedding index ownership could not be verified");
          expect(combinedMessage).not.toMatch(/clear-embeddings|quarantined|recovery/i);
          for (const sensitivePath of [vault, canonicalVault, foreignVault, canonicalForeignVault, embedFile]) {
            expect(combinedMessage).not.toContain(sensitivePath);
          }
          expect(logicalSnapshot()).toEqual(logicalBeforeForeignRefusal);
          expect((await fs.lstat(guardPath)).isDirectory()).toBe(true);
        } finally {
          await releaseWatcherActivationGuard(combinedGuard);
        }

        const verify = new EmbedDb({
          file: embedFile,
          vaultRoot: canonicalForeignVault,
          modelAlias: "multilingual",
          dim: 2
        });
        await verify.open();
        try {
          expect(verify.totalChunks()).toBe(1);
          expect(verify.search(new Float32Array([1, 0]), 1)[0]?.text_preview).toBe("foreign-owner-marker");
        } finally {
          verify.close();
        }
        await Promise.all(
          [embedFile, `${embedFile}-wal`, `${embedFile}-shm`].map((artifact) => fs.rm(artifact, { force: true }))
        );

        // A low-level same-root EmbedDb may legitimately store a custom
        // alias/dim tuple, but the server can only load catalog models. Prove
        // its caller-local projection refuses a path-like alias before
        // watcher open/arm/start without echoing the stored value.
        const pathLikeAlias = "../../private/server-model-secret";
        const customSeed = new EmbedDb({
          file: embedFile,
          vaultRoot: canonicalVault,
          modelAlias: pathLikeAlias,
          dim: 384,
          quantization: "f32"
        });
        await customSeed.open();
        const customVector = new Float32Array(384);
        customVector[0] = 1;
        customSeed.upsertNote("Custom.md", 1, [
          {
            chunkIndex: 0,
            lineStart: 1,
            lineEnd: 1,
            textPreview: "same-root-server-class-marker",
            vector: customVector
          }
        ]);
        customSeed.close();
        expect((await peekEmbedDbMeta(embedFile, canonicalVault))?.model_alias).toBe(pathLikeAlias);
        const customLogicalBefore = logicalSnapshot();
        let customConfigRefusal: unknown;
        try {
          await prepareServerDeps({ vault, watch: true });
        } catch (error) {
          customConfigRefusal = error;
        }
        expect(customConfigRefusal).toBeInstanceOf(Error);
        const customConfigMessage =
          customConfigRefusal instanceof Error ? customConfigRefusal.message : String(customConfigRefusal);
        expect(customConfigMessage).toBe("Embedding index configuration could not be verified");
        expect(customConfigMessage).not.toMatch(/clear-embeddings|quarantined|unknown embedding model/i);
        for (const sensitiveValue of [vault, canonicalVault, embedFile, pathLikeAlias]) {
          expect(customConfigMessage).not.toContain(sensitiveValue);
        }
        expect(logicalSnapshot()).toEqual(customLogicalBefore);
        await expect(fs.lstat(watcherActivationGuardPath(embedFile))).rejects.toThrow();
        await Promise.all(
          [embedFile, `${embedFile}-wal`, `${embedFile}-shm`].map((artifact) => fs.rm(artifact, { force: true }))
        );
      }

      // NEGATIVE control: a guard beside a present malformed artifact cannot
      // authorize recovery guidance or deletion. Preserve both logical bytes
      // and the interlock, and return only the stable path-free refusal.
      await fs.writeFile(embedFile, "stranded full-edition embedding index");
      const malformedGuard = await armWatcherActivationGuard(embedFile);
      await expect(prepareServerDeps({ vault })).rejects.toThrow("Embedding index ownership could not be verified");
      await expect(fs.readFile(embedFile, "utf8")).resolves.toBe("stranded full-edition embedding index");
      expect((await fs.lstat(watcherActivationGuardPath(embedFile))).isDirectory()).toBe(true);
      await releaseWatcherActivationGuard(malformedGuard);
      await fs.rm(embedFile, { force: true });

      // POSITIVE recovery case: a stranded guard with no database has no
      // foreign/malformed contents to adopt, so exact quarantine guidance is
      // safe while the guard remains durable until explicit recovery.
      await armWatcherActivationGuard(embedFile);
      await expect(prepareServerDeps({ vault })).rejects.toThrow(/embedding-derived indexes are quarantined/);
      const isolated = await prepareServerDeps({ vault, embeddingIndex: false });
      expect(isolated.embedDbFile).toBeNull();
      await expect(fs.lstat(embedFile)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await fs.lstat(watcherActivationGuardPath(embedFile))).isDirectory()).toBe(true);
    } finally {
      if (previousCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = previousCacheHome;
      await fs.rm(scratch, { recursive: true, force: true });
    }
  });

  it("offlineModelLoadError is a fail-closed error naming the model without misclassifying corruption (POSITIVE)", () => {
    const err = offlineModelLoadError(
      "multilingual",
      "Xenova/multilingual-e5-small",
      new Error("invalid ONNX protobuf")
    );
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/multilingual/);
    expect(err.message).toMatch(/Xenova\/multilingual-e5-small/);
    expect(err.message).toMatch(/missing, incomplete, incompatible, or corrupt/i);
    expect(err.message).not.toMatch(/is not in the local model cache/i);
    expect(err.message).toMatch(/zero outbound network calls/i); // restates the privacy guarantee
    expect(err.message).toMatch(/install-model multilingual/); // actionable: how to repair the exact cache
    expect(err.message).toMatch(/doctor.*cache/i);
    expect(err.message).toMatch(/remove only the affected/i);
    // rc.45 (abs-path-leak class) — the raw transformers.js cause is NOT surfaced: it can
    // embed the absolute model-cache path (host home dir). The message must NOT echo it
    // (the hfId itself legitimately contains a '/', so we assert on the cause text, not '/').
    expect(err.message).not.toMatch(/invalid ONNX protobuf/);
  });

  it("offlineModelLoadError does NOT leak the underlying cause / a path (rc.45 NEGATIVE control)", () => {
    const err = offlineModelLoadError("bge", "Xenova-bge", "/Users/secret/.cache/huggingface/blob fail");
    expect(err.message).not.toMatch(/raw string failure|secret|huggingface|\.cache/);
    expect(err.message).toMatch(/Xenova-bge/); // the model id (no slash) is still named
  });

  // rc.12 (rc.11-audit L-2) — the tests above cover the FLAG; this covers the WIRE-UP:
  // applyOfflineEnv must actually mutate a transformers.js-shaped `{ env }` so a
  // model-load failure fails closed (no CDN fetch). Closes the "flag set but not wired" gap the
  // auditor flagged in the project's own claimed-guarantee-vs-code-guard class.
  it("applyOfflineEnv sets allowRemoteModels=false on the transformers env when offline (POSITIVE)", () => {
    setEmbeddingsOffline(true);
    const mod = { env: { allowRemoteModels: true, allowLocalModels: false } };
    applyOfflineEnv(mod);
    expect(mod.env.allowRemoteModels).toBe(false); // CDN fetch blocked
    expect(mod.env.allowLocalModels).toBe(true); // local cache still allowed
  });

  it("applyOfflineEnv is a NO-OP when ONLINE so build-embeddings/install-model can fetch (NEGATIVE control)", () => {
    // default is online (afterEach resets); do NOT toggle offline here.
    const mod = { env: { allowRemoteModels: true, allowLocalModels: true } };
    applyOfflineEnv(mod);
    expect(mod.env.allowRemoteModels).toBe(true); // untouched — download path intact
  });

  it("cached constructors reapply offline guards and OIA rejects comment-only / late guards", async () => {
    const env = { allowRemoteModels: true, allowLocalModels: true };
    const remotePolicyAtLoad: boolean[] = [];
    const embeddingDtypesAtLoad: unknown[] = [];
    const rerankerPolicyAtLoad: boolean[] = [];
    vi.resetModules();
    vi.doMock("@huggingface/transformers", () => ({
      env,
      pipeline: async (_task: string, _model: string, options: { dtype?: unknown }) => {
        remotePolicyAtLoad.push(env.allowRemoteModels);
        embeddingDtypesAtLoad.push(options.dtype);
        return async () => ({
          data: new Float32Array(384),
          dims: [1, 384] as const
        });
      },
      AutoTokenizer: {
        from_pretrained: async () => {
          rerankerPolicyAtLoad.push(env.allowRemoteModels);
          return () => ({});
        }
      },
      AutoModelForSequenceClassification: {
        from_pretrained: async () => async () => ({
          logits: { data: new Float32Array([0]), dims: [1, 1] as const }
        })
      }
    }));

    try {
      const isolated = await import("../src/embeddings.js");
      await isolated.loadEmbedder("multilingual");
      expect(remotePolicyAtLoad).toEqual([true]);

      isolated.setEmbeddingsOffline(true);
      await isolated.loadEmbedder("bge");
      expect(remotePolicyAtLoad).toEqual([true, false]);
      expect(embeddingDtypesAtLoad).toEqual(["q8", "q8"]);
      expect(embeddingDtypesAtLoad).not.toContain("fp32"); // NEGATIVE: never silently load the 470 MB artifact.
      expect(env.allowRemoteModels).toBe(false);
      expect(env.allowLocalModels).toBe(true);

      // Exercise the sibling cached-constructor branch. The first alias loads
      // the constructors online; the second must reapply applyOfflineEnv()
      // before either from_pretrained call sees the transformers env.
      isolated.setEmbeddingsOffline(false);
      await isolated.loadReranker("rerank-bge");
      expect(rerankerPolicyAtLoad).toEqual([true]);
      isolated.setEmbeddingsOffline(true);
      await isolated.loadReranker("rerank-jina-tiny");
      expect(rerankerPolicyAtLoad).toEqual([true, false]);
      expect(env.allowRemoteModels).toBe(false);
      expect(env.allowLocalModels).toBe(true);
      isolated.setEmbeddingsOffline(false);
      expect(env.allowRemoteModels).toBe(true);
      expect(env.allowLocalModels).toBe(true);

      // Behavior-discriminating structural controls for OIA 4f. These are the
      // exact false-greens the old text regex admitted: a call in a comment, a
      // real call placed after the query, and a commented cached-reranker guard.
      const sources = {
        embSrc: readFileSync(new URL("../src/embeddings.ts", import.meta.url), "utf8"),
        cliSrc: readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8"),
        serverSrc: readFileSync(new URL("../src/server.ts", import.meta.url), "utf8")
      };
      expect(inspectEmbeddingsOfflineGuards(sources).missingRuntimeActions).toEqual([]);

      const queryGuard = "      setEmbeddingsOffline();\n      const v = new Vault(opts.vault);";
      expect(sources.cliSrc).toContain(queryGuard);
      const commentOnlyCli = sources.cliSrc.replace(
        queryGuard,
        "      // setEmbeddingsOffline();\n      const v = new Vault(opts.vault);"
      );
      expect(inspectEmbeddingsOfflineGuards({ ...sources, cliSrc: commentOnlyCli }).missingRuntimeActions).toContain(
        "query"
      );

      const conditionalCli = sources.cliSrc.replace(
        queryGuard,
        "      if (false) {\n        setEmbeddingsOffline();\n      }\n      const v = new Vault(opts.vault);"
      );
      expect(inspectEmbeddingsOfflineGuards({ ...sources, cliSrc: conditionalCli }).missingRuntimeActions).toContain(
        "query"
      );

      const disabledCli = sources.cliSrc.replace(queryGuard, queryGuard.replace("();", "(false);"));
      expect(inspectEmbeddingsOfflineGuards({ ...sources, cliSrc: disabledCli }).missingRuntimeActions).toContain(
        "query"
      );

      const resetBeforeQueryCli = sources.cliSrc.replace(
        queryGuard,
        `${queryGuard.split("\n")[0]}\n      setEmbeddingsOffline(false);\n      const v = new Vault(opts.vault);`
      );
      expect(
        inspectEmbeddingsOfflineGuards({ ...sources, cliSrc: resetBeforeQueryCli }).missingRuntimeActions
      ).toContain("query");

      const shadowedCli = sources.cliSrc.replace(
        queryGuard,
        `      const setEmbeddingsOffline = () => {};\n${queryGuard}`
      );
      expect(inspectEmbeddingsOfflineGuards({ ...sources, cliSrc: shadowedCli }).missingRuntimeActions).toContain(
        "query"
      );

      const mainScopeShadowedCli = sources.cliSrc.replace(
        "  const program = new Command();",
        "  const setEmbeddingsOffline = () => {};\n  const program = new Command();"
      );
      expect(
        inspectEmbeddingsOfflineGuards({ ...sources, cliSrc: mainScopeShadowedCli }).missingRuntimeActions
      ).toContain("query");

      const lateCli = sources.cliSrc
        .replace(queryGuard, "      const v = new Vault(opts.vault);")
        .replace(/( {8}const result = await searchHybrid\([^\n]+\);\n)/, "$1        setEmbeddingsOffline();\n");
      expect(inspectEmbeddingsOfflineGuards({ ...sources, cliSrc: lateCli }).missingRuntimeActions).toContain("query");

      const rerankerGuard =
        "  if (autoTokenizerCtor && autoModelForSeqClsCtor) {\n" +
        "    if (transformersModule) applyOfflineEnv(transformersModule);";
      expect(sources.embSrc).toContain(rerankerGuard);
      const commentOnlyReranker = sources.embSrc.replace(
        rerankerGuard,
        "  if (autoTokenizerCtor && autoModelForSeqClsCtor) {\n" +
          "    // if (transformersModule) applyOfflineEnv(transformersModule);"
      );
      const rerankerInspection = inspectEmbeddingsOfflineGuards({
        ...sources,
        embSrc: commentOnlyReranker
      });
      expect(rerankerInspection.cachedPipelineGuard).toBe(true);
      expect(rerankerInspection.cachedRerankerGuard).toBe(false);

      const wrongRerankerCondition = sources.embSrc.replace(
        rerankerGuard,
        "  if (autoTokenizerCtor && autoModelForSeqClsCtor) {\n" + "    if (false) applyOfflineEnv(transformersModule);"
      );
      expect(inspectEmbeddingsOfflineGuards({ ...sources, embSrc: wrongRerankerCondition }).cachedRerankerGuard).toBe(
        false
      );

      const restoredCachedPipeline = sources.embSrc.replace(
        "    if (transformersModule) applyOfflineEnv(transformersModule);\n    return pipelineCtor;",
        "    if (transformersModule) applyOfflineEnv(transformersModule);\n" +
          "    if (transformersModule) restoreOnlineEnv(transformersModule);\n" +
          "    return pipelineCtor;"
      );
      expect(inspectEmbeddingsOfflineGuards({ ...sources, embSrc: restoredCachedPipeline }).cachedPipelineGuard).toBe(
        false
      );

      const prepareBoundary = "  setEmbeddingsOffline();\n  // v3.11.5-rc.1 CRL-1";
      expect(sources.serverSrc).toContain(prepareBoundary);
      const resetServer = sources.serverSrc.replace(
        prepareBoundary,
        "  setEmbeddingsOffline();\n  setEmbeddingsOffline(false);\n  // v3.11.5-rc.1 CRL-1"
      );
      expect(inspectEmbeddingsOfflineGuards({ ...sources, serverSrc: resetServer }).serverBoundary).toBe(false);
    } finally {
      vi.doUnmock("@huggingface/transformers");
      vi.resetModules();
    }
  });
});
