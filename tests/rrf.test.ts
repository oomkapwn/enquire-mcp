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

  it("deduplicates each signal by best rank independent of duplicate order", () => {
    const worse = { id: "same.md", rank: 5, score: 50 };
    const best = { id: "same.md", rank: 1, score: 1 };

    const worseFirst = reciprocalRankFusion({ bm25: [worse, best] });
    const bestFirst = reciprocalRankFusion({ bm25: [best, worse] });

    expect(worseFirst).toEqual(bestFirst);
    expect(worseFirst[0]?.score).toBeCloseTo(1 / 61, 6);
    expect(worseFirst[0]?.per_signal.bm25).toMatchObject({ rank: 1, score: 1 });
  });

  it("uses the higher finite score as a deterministic tie-break for equal-rank duplicates", () => {
    const lowerScore = { id: "same.md", rank: 2, score: 1 };
    const higherScore = { id: "same.md", rank: 2, score: 9 };

    const forward = reciprocalRankFusion({ bm25: [lowerScore, higherScore] });
    const reverse = reciprocalRankFusion({ bm25: [higherScore, lowerScore] });

    expect(forward).toEqual(reverse);
    expect(forward[0]?.per_signal.bm25?.score).toBe(9);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1.5, 2 ** 53])(
    "rejects k outside the positive-safe-integer domain: %s",
    (k) => {
      expect(() => reciprocalRankFusion({}, { k })).toThrow(/k must be a positive safe integer/);
    }
  );

  it.each([0, -3, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1.5, 2 ** 53])(
    "rejects rank outside the positive-safe-integer domain: %s",
    (rank) => {
      expect(() => reciprocalRankFusion({ bm25: [{ id: "a.md", rank, score: 1 }] })).toThrow(
        /rank must be a positive safe integer/
      );
    }
  );

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1.5, 2 ** 53])(
    "rejects topK outside the positive-safe-integer domain: %s",
    (topK) => {
      expect(() => reciprocalRankFusion({}, { topK })).toThrow(/topK must be a positive safe integer/);
    }
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects non-finite original scores: %s",
    (score) => {
      expect(() => reciprocalRankFusion({ bm25: [{ id: "a.md", rank: 1, score }] })).toThrow(/score must be finite/);
    }
  );

  it("validates later duplicates instead of hiding malformed records behind deduplication", () => {
    expect(() =>
      reciprocalRankFusion({
        bm25: [
          { id: "a.md", rank: 1, score: 1 },
          { id: "a.md", rank: 2, score: Number.NaN }
        ]
      })
    ).toThrow(/score must be finite/);
  });

  it("rejects empty and oversized IDs while admitting the documented byte boundary", () => {
    const atLimit = "é".repeat(2048);
    expect(reciprocalRankFusion({ bm25: [{ id: atLimit, rank: 1, score: Number.MAX_VALUE }] })[0]?.id).toBe(atLimit);
    expect(() => reciprocalRankFusion({ bm25: [{ id: "", rank: 1, score: 1 }] })).toThrow(/1\.\.4096/);
    expect(() => reciprocalRankFusion({ bm25: [{ id: `${atLimit}a`, rank: 1, score: 1 }] })).toThrow(/1\.\.4096/);
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

  it("rejects invalid extracted IDs and scores", () => {
    expect(() => toRanked([1], { idOf: () => "", scoreOf: () => 1 })).toThrow(/1\.\.4096/);
    expect(() => toRanked([1], { idOf: () => "a.md", scoreOf: () => Number.NaN })).toThrow(/score must be finite/);
  });
});
