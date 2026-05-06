// Reciprocal Rank Fusion math tests. Pure unit tests — no SQLite, no model,
// no vault. Verifies: (1) the math matches Cormack et al's formula, (2) the
// fusion is union-safe (missing signals don't penalize), (3) per-signal
// contributions are recorded for observability, (4) rank numbering errors
// are caught.

import { describe, expect, it } from "vitest";
import { RRF_K, reciprocalRankFusion, toRanked } from "../src/rrf.js";

describe("reciprocalRankFusion (v2.0 beta)", () => {
  it("RRF_K is 60 (Cormack et al's recommendation)", () => {
    expect(RRF_K).toBe(60);
  });

  it("single signal: order matches the input ranker", () => {
    const fused = reciprocalRankFusion({
      bm25: [
        { id: "a.md", rank: 1, score: 5.0 },
        { id: "b.md", rank: 2, score: 3.0 },
        { id: "c.md", rank: 3, score: 1.0 }
      ]
    });
    expect(fused.map((f) => f.id)).toEqual(["a.md", "b.md", "c.md"]);
    expect(fused[0]?.score).toBeCloseTo(1 / (60 + 1), 6);
    expect(fused[1]?.score).toBeCloseTo(1 / (60 + 2), 6);
  });

  it("two signals: doc ranked high in both wins over doc ranked high in one", () => {
    const fused = reciprocalRankFusion({
      bm25: [
        { id: "consensus.md", rank: 1, score: 5.0 },
        { id: "bm25-only.md", rank: 2, score: 3.0 }
      ],
      tfidf: [
        { id: "consensus.md", rank: 1, score: 0.9 },
        { id: "tfidf-only.md", rank: 2, score: 0.5 }
      ]
    });
    // consensus.md gets 1/(60+1) twice; the others get it once. consensus
    // wins.
    expect(fused[0]?.id).toBe("consensus.md");
    expect(fused[0]?.score).toBeCloseTo(2 / 61, 6);
    expect(fused[1]?.score).toBeCloseTo(1 / 62, 6);
  });

  it("union-safe: docs missing from a signal contribute 0 from that signal (no penalty)", () => {
    const fused = reciprocalRankFusion({
      bm25: [{ id: "a.md", rank: 1, score: 5.0 }],
      tfidf: [{ id: "b.md", rank: 1, score: 0.9 }]
    });
    // a.md and b.md should tie — each gets 1/(60+1) from exactly one signal.
    expect(fused.length).toBe(2);
    expect(fused[0]?.score).toBeCloseTo(1 / 61, 6);
    expect(fused[1]?.score).toBeCloseTo(1 / 61, 6);
    // Both should have only one per_signal entry.
    expect(Object.keys(fused[0]?.per_signal ?? {}).length).toBe(1);
    expect(Object.keys(fused[1]?.per_signal ?? {}).length).toBe(1);
  });

  it("per_signal records original rank + score + rrf_term for each contributing signal", () => {
    const fused = reciprocalRankFusion({
      bm25: [{ id: "a.md", rank: 1, score: 5.0 }],
      tfidf: [{ id: "a.md", rank: 3, score: 0.42 }]
    });
    const hit = fused.find((f) => f.id === "a.md");
    expect(hit?.per_signal.bm25?.rank).toBe(1);
    expect(hit?.per_signal.bm25?.score).toBe(5.0);
    expect(hit?.per_signal.bm25?.rrf_term).toBeCloseTo(1 / 61, 6);
    expect(hit?.per_signal.tfidf?.rank).toBe(3);
    expect(hit?.per_signal.tfidf?.score).toBe(0.42);
    expect(hit?.per_signal.tfidf?.rrf_term).toBeCloseTo(1 / 63, 6);
  });

  it("three signals fuse correctly (BM25 + TF-IDF + embeddings — the v2.0 hot path)", () => {
    const fused = reciprocalRankFusion({
      bm25: [
        { id: "auth.md", rank: 1, score: 8.5 },
        { id: "login.md", rank: 5, score: 2.1 }
      ],
      tfidf: [
        { id: "auth.md", rank: 2, score: 0.7 },
        { id: "oauth.md", rank: 1, score: 0.85 }
      ],
      embeddings: [
        { id: "auth.md", rank: 1, score: 0.92 },
        { id: "jwt.md", rank: 3, score: 0.71 }
      ]
    });
    // auth.md hits all three rankers — must rank #1.
    expect(fused[0]?.id).toBe("auth.md");
    expect(fused[0]?.score).toBeCloseTo(1 / 61 + 1 / 62 + 1 / 61, 6);
    expect(Object.keys(fused[0]?.per_signal ?? {}).sort()).toEqual(["bm25", "embeddings", "tfidf"]);
  });

  it("topK truncates the output", () => {
    const fused = reciprocalRankFusion(
      {
        bm25: [
          { id: "a.md", rank: 1, score: 5 },
          { id: "b.md", rank: 2, score: 3 },
          { id: "c.md", rank: 3, score: 1 },
          { id: "d.md", rank: 4, score: 0.5 }
        ]
      },
      { topK: 2 }
    );
    expect(fused.length).toBe(2);
    expect(fused.map((f) => f.id)).toEqual(["a.md", "b.md"]);
  });

  it("custom k changes the smoothing", () => {
    const k = 1;
    const fused = reciprocalRankFusion(
      {
        bm25: [{ id: "a.md", rank: 1, score: 5 }]
      },
      { k }
    );
    expect(fused[0]?.score).toBeCloseTo(1 / (k + 1), 6);
  });

  it("rejects non-positive k", () => {
    expect(() => reciprocalRankFusion({}, { k: 0 })).toThrow(/k must be positive/);
    expect(() => reciprocalRankFusion({}, { k: -1 })).toThrow(/k must be positive/);
  });

  it("rejects 0-based or negative ranks (RRF expects 1-based)", () => {
    expect(() => reciprocalRankFusion({ bm25: [{ id: "a.md", rank: 0, score: 1 }] })).toThrow(/1-based ranks/);
    expect(() => reciprocalRankFusion({ bm25: [{ id: "a.md", rank: -3, score: 1 }] })).toThrow(/1-based ranks/);
  });

  it("undefined / missing signals are silently ignored (graceful degradation)", () => {
    // The hot-path scenario: user has FTS5 but no embeddings index. We pass
    // `embeddings: undefined` and the fusion just uses the available signals.
    const fused = reciprocalRankFusion({
      bm25: [{ id: "a.md", rank: 1, score: 5 }],
      tfidf: [{ id: "a.md", rank: 1, score: 0.9 }],
      embeddings: undefined
    });
    expect(fused.length).toBe(1);
    expect(fused[0]?.id).toBe("a.md");
    expect(Object.keys(fused[0]?.per_signal ?? {}).sort()).toEqual(["bm25", "tfidf"]);
  });

  it("all-empty input returns []", () => {
    expect(reciprocalRankFusion({})).toEqual([]);
    expect(reciprocalRankFusion({ bm25: [], tfidf: [] })).toEqual([]);
  });
});

describe("toRanked", () => {
  it("converts a sorted hit list into 1-based RankedHit entries", () => {
    interface Hit {
      path: string;
      score: number;
    }
    const hits: Hit[] = [
      { path: "a.md", score: 5.0 },
      { path: "b.md", score: 3.0 }
    ];
    const ranked = toRanked(hits, { idOf: (h) => h.path, scoreOf: (h) => h.score });
    expect(ranked).toEqual([
      { id: "a.md", rank: 1, score: 5.0 },
      { id: "b.md", rank: 2, score: 3.0 }
    ]);
  });
});
