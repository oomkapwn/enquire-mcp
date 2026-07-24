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

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectEmbeddingsOfflineGuards } from "../scripts/lib/oia-offline-guard.mjs";
import {
  applyOfflineEnv,
  isEmbeddingsOffline,
  offlineModelLoadError,
  setEmbeddingsOffline
} from "../src/embeddings.js";

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
    const rerankerPolicyAtLoad: boolean[] = [];
    vi.resetModules();
    vi.doMock("@huggingface/transformers", () => ({
      env,
      pipeline: async () => {
        remotePolicyAtLoad.push(env.allowRemoteModels);
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
