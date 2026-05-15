// Unit tests for the embeddings catalog + math helpers. These don't load any
// ONNX runtime — they only verify the synchronous bits (model resolution,
// cosine math). Loading the full embedder is tested out-of-band via
// `enquire-mcp install-model multilingual` + the build-embeddings pipeline.

import { describe, expect, it } from "vitest";
import {
  cosineSim,
  DEFAULT_MODEL_ALIAS,
  DEFAULT_RERANKER_ALIAS,
  EMBEDDING_MODELS,
  RERANKER_MODELS,
  resolveModel,
  resolveRerankerModel
} from "../src/embeddings.js";

describe("EMBEDDING_MODELS catalog (v2.0 alpha)", () => {
  it("includes multilingual and bge with expected dim=384", () => {
    expect(EMBEDDING_MODELS.multilingual?.dim).toBe(384);
    expect(EMBEDDING_MODELS.bge?.dim).toBe(384);
  });

  it("default alias points at the multilingual model (v2.0 covers Russian/EN dogfood vault)", () => {
    expect(DEFAULT_MODEL_ALIAS).toBe("multilingual");
    expect(EMBEDDING_MODELS[DEFAULT_MODEL_ALIAS]?.multilingual).toBe(true);
  });

  it("each model declares an HF id under Xenova org (Xenova ships ONNX-converted weights)", () => {
    for (const m of Object.values(EMBEDDING_MODELS)) {
      expect(m.hfId.startsWith("Xenova/")).toBe(true);
    }
  });
});

describe("resolveModel", () => {
  it("returns the named model when alias is known", () => {
    const m = resolveModel("bge");
    expect(m.alias).toBe("bge");
    expect(m.dim).toBe(384);
  });

  it("returns the default model when alias is undefined", () => {
    const m = resolveModel(undefined);
    expect(m.alias).toBe(DEFAULT_MODEL_ALIAS);
  });

  it("throws on unknown alias with a list of known ones", () => {
    expect(() => resolveModel("not-a-real-model")).toThrow(/Unknown embedding model alias/);
    expect(() => resolveModel("not-a-real-model")).toThrow(/multilingual/);
  });
});

describe("cosineSim", () => {
  it("returns 1 for identical L2-normed vectors", () => {
    const v = new Float32Array([1, 0, 0, 0]);
    expect(cosineSim(v, v)).toBeCloseTo(1, 5);
  });

  it("returns 0 for orthogonal vectors", () => {
    const a = new Float32Array([1, 0, 0, 0]);
    const b = new Float32Array([0, 1, 0, 0]);
    expect(cosineSim(a, b)).toBeCloseTo(0, 5);
  });

  it("returns -1 for antiparallel L2-normed vectors", () => {
    const a = new Float32Array([1, 0, 0, 0]);
    const b = new Float32Array([-1, 0, 0, 0]);
    expect(cosineSim(a, b)).toBeCloseTo(-1, 5);
  });

  it("throws on dim mismatch (catches catalog drift between query model and stored vectors)", () => {
    const a = new Float32Array([1, 0, 0, 0]);
    const b = new Float32Array([1, 0, 0]);
    expect(() => cosineSim(a, b)).toThrow(/dim mismatch/);
  });
});

// v3.6 — branches coverage uplift. resolveRerankerModel was uncovered;
// exercise each branch of the same alias/default/throw pattern that
// resolveModel uses for the embedding catalog.
describe("RERANKER_MODELS catalog (v2.9.0)", () => {
  it("includes the documented set of reranker aliases", () => {
    // Lock in the catalog shape so a typo'd alias regresses loudly.
    const aliases = Object.keys(RERANKER_MODELS).sort();
    expect(aliases).toContain("rerank-bge");
    expect(aliases).toContain("rerank-multilingual");
    expect(aliases).toContain("rerank-bge-large");
    expect(aliases).toContain("rerank-jina-tiny");
    expect(aliases).toContain("rerank-multilingual-large");
  });

  // v3.6.1 CRIT-2 — was "rerank-multilingual" but that alias is the
  // broken-at-AutoTokenizer one per v3.6.0 CHANGELOG. Switched to the
  // verified-working "rerank-bge" (English-only). Multilingual property
  // assertion removed since rerank-bge is English-only.
  it("default reranker alias points at rerank-bge (v3.6.1)", () => {
    expect(DEFAULT_RERANKER_ALIAS).toBe("rerank-bge");
    // rerank-bge is English-only — multilingual users wait for v3.7 fix.
    expect(RERANKER_MODELS[DEFAULT_RERANKER_ALIAS]?.multilingual).toBe(false);
  });

  it("each reranker declares Xenova-hosted HF id + maxTokens 512", () => {
    for (const m of Object.values(RERANKER_MODELS)) {
      expect(m.hfId.startsWith("Xenova/")).toBe(true);
      expect(m.maxTokens).toBe(512);
    }
  });
});

describe("resolveRerankerModel", () => {
  it("returns the named reranker when alias is known", () => {
    const m = resolveRerankerModel("rerank-bge");
    expect(m.alias).toBe("rerank-bge");
    expect(m.multilingual).toBe(false);
  });

  it("returns the default reranker when alias is undefined", () => {
    const m = resolveRerankerModel(undefined);
    expect(m.alias).toBe(DEFAULT_RERANKER_ALIAS);
  });

  it("throws on unknown alias with a list of known ones (catches typos)", () => {
    expect(() => resolveRerankerModel("not-a-real-reranker")).toThrow(/Unknown reranker model alias/);
    expect(() => resolveRerankerModel("not-a-real-reranker")).toThrow(/rerank-bge/);
  });

  it("resolves all catalog aliases without throwing", () => {
    // Smoke over the full catalog so add-an-alias regressions in
    // resolveRerankerModel surface here.
    for (const alias of Object.keys(RERANKER_MODELS)) {
      const m = resolveRerankerModel(alias);
      expect(m.alias).toBe(alias);
    }
  });
});
