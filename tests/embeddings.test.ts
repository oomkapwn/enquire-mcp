// Unit tests for the embeddings catalog + math helpers. These don't load any
// ONNX runtime — they only verify the synchronous bits (model resolution,
// cosine math). Loading the full embedder is tested out-of-band via
// `enquire-mcp install-model multilingual` + the build-embeddings pipeline.

import { describe, expect, it } from "vitest";
import { cosineSim, DEFAULT_MODEL_ALIAS, EMBEDDING_MODELS, resolveModel } from "../src/embeddings.js";

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
