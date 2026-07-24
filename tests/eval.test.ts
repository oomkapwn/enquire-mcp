// v2.12.0 — retrieval-quality eval harness tests.
//
// Coverage:
//   • Pure-function metrics: ndcgAtK, recallAtK, reciprocalRank — exact
//     numeric checks against hand-computed expected values
//   • Edge cases: empty relevant set, no overlap, perfect ranking,
//     reverse ranking, partial overlap
//   • readQueriesJsonl: tolerates blank lines + comments, throws on
//     malformed JSON, throws on missing required fields
//   • runEval end-to-end against a real FtsIndex with synthetic queries
//   • formatEvalResult + formatEvalMatrix produce non-empty output

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  allRelevantAtK,
  type CategoryScore,
  classifyFailureBucket,
  compareEvalResults,
  type EvalQuery,
  type EvalQueryScore,
  type EvalResult,
  evalQuerySetFingerprint,
  FAILURE_BUCKETS,
  type FailureBucket,
  formatEvalComparison,
  formatEvalMatrix,
  formatEvalResult,
  groupByCategory,
  hitAtK,
  MEANINGFUL_DELTA,
  missedPaths,
  ndcgAtK,
  readQueriesJsonl,
  recallAtK,
  reciprocalRank,
  runEval,
  tallyFailureBuckets
} from "../src/eval.js";
import { FtsIndex } from "../src/fts5.js";
import { Vault } from "../src/vault.js";

describe("ndcgAtK (v2.12.0)", () => {
  it("returns 0 when relevant set is empty", () => {
    expect(ndcgAtK(["a.md", "b.md"], new Set(), 10)).toBe(0);
  });

  it("returns 0 when no retrieved doc is relevant", () => {
    expect(ndcgAtK(["a.md", "b.md"], new Set(["c.md"]), 10)).toBe(0);
  });

  it("returns 1.0 for a perfect ranking (all relevant docs at the top in order)", () => {
    // 3 relevant docs, all retrieved at positions 1, 2, 3.
    // DCG = 1/log2(2) + 1/log2(3) + 1/log2(4)
    // IdealDCG = same = 1/log2(2) + 1/log2(3) + 1/log2(4)
    // NDCG = 1.0
    const ndcg = ndcgAtK(["a.md", "b.md", "c.md"], new Set(["a.md", "b.md", "c.md"]), 10);
    expect(ndcg).toBeCloseTo(1.0, 5);
  });

  it("returns < 1.0 when relevant docs are ranked low", () => {
    // 1 relevant doc, retrieved at position 5 (rank 5, i=4).
    // DCG = 1/log2(6)
    // IdealDCG = 1/log2(2) (relevant doc would be at top)
    // NDCG = log2(2) / log2(6) = 1 / log2(6) ≈ 0.387
    const ndcg = ndcgAtK(["x.md", "y.md", "z.md", "w.md", "a.md"], new Set(["a.md"]), 10);
    expect(ndcg).toBeCloseTo(1 / Math.log2(6), 4);
  });

  it("respects the K cutoff — relevant doc beyond K is invisible", () => {
    // 1 relevant doc at position 11, K = 10 → no contribution → 0.
    const retrieved = ["x.md", "x.md", "x.md", "x.md", "x.md", "x.md", "x.md", "x.md", "x.md", "x.md", "a.md"];
    expect(ndcgAtK(retrieved, new Set(["a.md"]), 10)).toBe(0);
  });

  it("credits a duplicated relevant path once — never exceeds the ideal (v3.10.0-rc.33)", () => {
    // a.md is relevant and appears at rank 1 AND rank 2; only the rank-1 credit
    // counts, so NDCG = 1.0 (not the inflated >1 the old double-count produced).
    expect(ndcgAtK(["a.md", "a.md"], new Set(["a.md"]), 10)).toBeCloseTo(1.0, 5);
  });
});

describe("recallAtK (v2.12.0)", () => {
  it("returns 0 when relevant set is empty", () => {
    expect(recallAtK(["a.md"], new Set(), 10)).toBe(0);
  });

  it("returns 1.0 when all relevant docs are in the top-K", () => {
    expect(recallAtK(["a.md", "b.md", "c.md"], new Set(["a.md", "b.md"]), 10)).toBe(1);
  });

  it("returns 0.5 when half of relevant docs are in top-K", () => {
    expect(recallAtK(["a.md"], new Set(["a.md", "b.md"]), 10)).toBe(0.5);
  });

  it("respects the K cutoff", () => {
    // a.md is at position 1, b.md at position 2; K=1 → only a.md visible.
    // 1 relevant in top-1 / 2 total relevant = 0.5
    expect(recallAtK(["a.md", "b.md"], new Set(["a.md", "b.md"]), 1)).toBe(0.5);
  });

  it("counts a duplicated relevant path once — recall never exceeds 1.0 (v3.10.0-rc.33)", () => {
    // a.md relevant + duplicated in the result list → recall must be 1/1 = 1,
    // not the 2/1 = 2 the old hits++ produced.
    expect(recallAtK(["a.md", "a.md"], new Set(["a.md"]), 10)).toBe(1);
    expect(recallAtK(["a.md", "a.md", "b.md"], new Set(["a.md", "b.md"]), 10)).toBe(1);
  });
});

describe("reciprocalRank (v2.12.0)", () => {
  it("returns 1.0 when first retrieved is relevant", () => {
    expect(reciprocalRank(["a.md", "b.md"], new Set(["a.md"]), 10)).toBe(1);
  });

  it("returns 0.5 when relevant doc is at rank 2", () => {
    expect(reciprocalRank(["x.md", "a.md"], new Set(["a.md"]), 10)).toBe(0.5);
  });

  it("returns 0 when no relevant doc is in top-K", () => {
    expect(reciprocalRank(["x.md", "y.md"], new Set(["a.md"]), 10)).toBe(0);
  });

  it("returns the FIRST relevant rank (not nth)", () => {
    // First relevant is at rank 2 (index 1). MRR = 1/2 = 0.5
    expect(reciprocalRank(["x.md", "a.md", "b.md"], new Set(["a.md", "b.md"]), 10)).toBe(0.5);
  });
});

describe("readQueriesJsonl (v2.12.0)", () => {
  let tmpFile: string;

  it("parses valid JSONL with all fields", async () => {
    tmpFile = path.join(os.tmpdir(), `enquire-eval-${Date.now()}.jsonl`);
    await fs.writeFile(
      tmpFile,
      [
        '{"id":"q1","query":"first query","relevant":["a.md","b.md"]}',
        '{"id":"q2","query":"second query","relevant":["c.md"]}'
      ].join("\n")
    );
    const queries = await readQueriesJsonl(tmpFile);
    expect(queries).toHaveLength(2);
    expect(queries[0]).toMatchObject({ id: "q1", query: "first query" });
    expect(queries[1]?.relevant).toEqual(["c.md"]);
    expect(evalQuerySetFingerprint(queries)).toBe(evalQuerySetFingerprint([...queries].reverse()));

    await fs.writeFile(
      tmpFile,
      '{"id":"duplicate","query":"first","relevant":["a.md"]}\n' +
        '{"id":"duplicate","query":"second","relevant":["b.md"]}\n'
    );
    await expect(readQueriesJsonl(tmpFile)).rejects.toThrow(/duplicate query id 'duplicate'/);
    await fs.writeFile(
      tmpFile,
      '{"query":"implicit q1","relevant":["a.md"]}\n' + '{"id":"q1","query":"explicit q1","relevant":["b.md"]}\n'
    );
    await expect(readQueriesJsonl(tmpFile)).rejects.toThrow(/duplicate effective query id 'q1'/);
    await fs.rm(tmpFile, { force: true });
  });

  it("tolerates blank lines and comments", async () => {
    tmpFile = path.join(os.tmpdir(), `enquire-eval-${Date.now()}.jsonl`);
    await fs.writeFile(
      tmpFile,
      [
        "// this is a comment",
        "",
        '{"query":"first","relevant":["a.md"]}',
        "  // another comment",
        '{"query":"second","relevant":["b.md"]}',
        ""
      ].join("\n")
    );
    const queries = await readQueriesJsonl(tmpFile);
    expect(queries).toHaveLength(2);
    await fs.rm(tmpFile, { force: true });
  });

  it("rejects an empty effective cohort while accepting comments around a real query", async () => {
    tmpFile = path.join(os.tmpdir(), `enquire-eval-${Date.now()}.jsonl`);
    await fs.writeFile(tmpFile, "\n  // no queries follow\n\t\n");
    await expect(readQueriesJsonl(tmpFile)).rejects.toThrow(/at least one query/);

    await fs.writeFile(tmpFile, '// cohort note\n{"query":"real query","relevant":["a.md"]}\n');
    await expect(readQueriesJsonl(tmpFile)).resolves.toHaveLength(1);
    await fs.rm(tmpFile, { force: true });
  });

  it("throws with line number on malformed JSON", async () => {
    tmpFile = path.join(os.tmpdir(), `enquire-eval-${Date.now()}.jsonl`);
    await fs.writeFile(tmpFile, '{"query":"ok","relevant":["a.md"]}\nthis is not json');
    await expect(readQueriesJsonl(tmpFile)).rejects.toThrow(/line 2/);
    await fs.rm(tmpFile, { force: true });
  });

  it("throws when required fields are missing", async () => {
    tmpFile = path.join(os.tmpdir(), `enquire-eval-${Date.now()}.jsonl`);
    await fs.writeFile(tmpFile, '{"query":"ok"}');
    await expect(readQueriesJsonl(tmpFile)).rejects.toThrow(/relevant/);
    await fs.rm(tmpFile, { force: true });

    tmpFile = path.join(os.tmpdir(), `enquire-eval-${Date.now()}.jsonl`);
    await fs.writeFile(tmpFile, '{"relevant":["a.md"]}');
    await expect(readQueriesJsonl(tmpFile)).rejects.toThrow(/query/);

    for (const invalid of [
      '{"id":42,"query":"ok","relevant":["a.md"]}',
      '{"category":false,"query":"ok","relevant":["a.md"]}',
      '{"query":"   ","relevant":["a.md"]}',
      '{"query":"ok","relevant":["   "]}'
    ]) {
      await fs.writeFile(tmpFile, invalid);
      await expect(readQueriesJsonl(tmpFile), invalid).rejects.toThrow();
    }
    await fs.rm(tmpFile, { force: true });
  });

  it("throws when relevant is not an array of strings", async () => {
    tmpFile = path.join(os.tmpdir(), `enquire-eval-${Date.now()}.jsonl`);
    await fs.writeFile(tmpFile, '{"query":"ok","relevant":[1,2,3]}');
    await expect(readQueriesJsonl(tmpFile)).rejects.toThrow(/relevant/);
    await fs.rm(tmpFile, { force: true });
  });
});

// End-to-end runEval against a real FtsIndex.
describe("runEval (v2.12.0)", () => {
  let root: string;
  let idx: FtsIndex;
  const dbFile = path.join(os.tmpdir(), `enquire-eval-${Date.now()}.fts5.db`);

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-eval-vault-"));
    // 4 notes — apollo.md and saturn.md are about the Apollo program;
    // pasta.md and trees.md are unrelated.
    await fs.writeFile(path.join(root, "apollo.md"), "Apollo program guidance computer engineering team.\n");
    await fs.writeFile(path.join(root, "saturn.md"), "Saturn V rocket launch architecture for Apollo program.\n");
    await fs.writeFile(path.join(root, "pasta.md"), "Carbonara recipe with pancetta and pecorino.\n");
    await fs.writeFile(path.join(root, "trees.md"), "Photosynthesis biochemistry and forest ecology.\n");
    idx = new FtsIndex({ file: dbFile, vaultRoot: root, tokenize: "unicode61" });
    await idx.open();
    idx.reindexFile("apollo.md", Date.now(), "Apollo program guidance computer engineering team.");
    idx.reindexFile("saturn.md", Date.now(), "Saturn V rocket launch architecture for Apollo program.");
    idx.reindexFile("pasta.md", Date.now(), "Carbonara recipe with pancetta and pecorino.");
    idx.reindexFile("trees.md", Date.now(), "Photosynthesis biochemistry and forest ecology.");
  });

  afterAll(async () => {
    idx?.close();
    await fs.rm(root, { recursive: true, force: true });
    for (const suffix of ["", "-wal", "-shm"]) {
      await fs.rm(`${dbFile}${suffix}`, { force: true });
    }
  });

  it("rejects a direct empty cohort before retrieval while accepting one query", async () => {
    const v = new Vault(root);
    const common = {
      vault: v,
      ftsIndex: idx,
      embedFile: path.join(root, "nonexistent.embed.db"),
      k: 10
    };
    await expect(runEval({ ...common, queries: [] })).rejects.toThrow(/at least one query/);
    await expect(
      runEval({
        ...common,
        queries: [{ id: "control", query: "Apollo", relevant: ["apollo.md"] }]
      })
    ).resolves.toMatchObject({ query_count: 1, query_errors: 0 });
  });

  it("scores a single query with known-relevant docs", async () => {
    const v = new Vault(root);
    const queries: EvalQuery[] = [
      { id: "apollo", query: "Apollo program rocket", relevant: ["apollo.md", "saturn.md"] }
    ];
    const result = await runEval({
      vault: v,
      queries,
      ftsIndex: idx,
      embedFile: path.join(root, "nonexistent.embed.db"),
      k: 10,
      label: "test"
    });
    expect(result.query_count).toBe(1);
    expect(result.per_query).toHaveLength(1);
    // Apollo + Saturn should both be in top-10 (only 4 docs total).
    expect(result.per_query[0]?.recall_at_k).toBe(1);
    expect(result.per_query[0]?.ndcg_at_k).toBeGreaterThan(0.9);
    // First hit should be relevant → MRR = 1.0
    expect(result.per_query[0]?.mrr).toBe(1);
    expect(result.label).toBe("test");
    expect(result.query_set_fingerprint).toBe(evalQuerySetFingerprint(queries));
    // v3.10.0-rc.31 — Apollo is the rank-1 hit → failure_bucket "hit_rank_1",
    // and the aggregate diagnostics counter is populated by runEval.
    expect(result.per_query[0]?.failure_bucket).toBe("hit_rank_1");
    expect(result.diagnostics?.failure_buckets.hit_rank_1).toBe(1);
  });

  it("aggregates across multiple queries", async () => {
    const v = new Vault(root);
    const queries: EvalQuery[] = [
      { id: "q1", query: "Apollo", relevant: ["apollo.md", "saturn.md"] },
      { id: "q2", query: "carbonara", relevant: ["pasta.md"] }
    ];
    const result = await runEval({
      vault: v,
      queries,
      ftsIndex: idx,
      embedFile: path.join(root, "nonexistent.embed.db"),
      k: 10
    });
    expect(result.query_count).toBe(2);
    expect(result.mean_recall).toBeGreaterThan(0);
    expect(result.mean_ndcg).toBeGreaterThan(0);
  });

  it("flags thrown and gracefully-degraded retrieval as eval errors — per-query isolation", async () => {
    const v = new Vault(root);
    await v.ensureExists();
    const realEnsureExists = v.ensureExists.bind(v);
    const ensureExists = vi.spyOn(v, "ensureExists");
    ensureExists
      .mockRejectedValueOnce(new Error("synthetic per-query runtime failure"))
      .mockImplementation(realEnsureExists);
    const queries: EvalQuery[] = [
      { id: "blowup", query: "carbonara", relevant: ["pasta.md"] },
      { id: "ok", query: "Apollo", relevant: ["apollo.md"] }
    ];
    const result = await runEval({
      vault: v,
      queries,
      ftsIndex: idx,
      embedFile: path.join(root, "nonexistent.embed.db"),
      k: 10
    });
    ensureExists.mockRestore();
    // Both queries scored; the first has 0 metrics and the loop continues.
    expect(result.query_count).toBe(2);
    expect(result.per_query[0]?.ndcg_at_k).toBe(0);
    expect(result.per_query[0]?.recall_at_k).toBe(0);
    // v3.9.0-rc.16 — the errored query is COUNTED + FLAGGED, not silently
    // conflated with a genuine zero-relevance retrieval.
    expect(result.query_errors).toBe(1);
    expect(result.per_query[0]?.error).toBe(true);
    // v3.10.0-rc.32 (audit LOW) — the errored query's bucket is "error" end-to-end
    // (runEval wires `errored` into classifyFailureBucket + the aggregate counter).
    expect(result.per_query[0]?.failure_bucket).toBe("error");
    expect(result.diagnostics?.failure_buckets.error).toBe(1);
    // NEGATIVE control: the successful query carries no error flag.
    expect(result.per_query[1]?.error).toBeUndefined();
    // The human-readable banner surfaces the deflation warning.
    expect(formatEvalResult(result)).toContain("errored");

    // NEGATIVE control for benchmark labels: searchHybrid normally degrades
    // gracefully when a requested reranker fails. Eval must not publish those
    // fallback hits as if the "+reranker" configuration actually ran.
    const degraded = await runEval({
      vault: v,
      queries: [{ id: "reranker-failure", query: "Apollo", relevant: ["apollo.md"] }],
      ftsIndex: idx,
      embedFile: path.join(root, "nonexistent.embed.db"),
      reranker: { alias: "rerank-bge" },
      rerankerOverride: {
        async score() {
          throw new Error("synthetic reranker load failure");
        }
      },
      k: 10
    });
    expect(degraded.query_errors).toBe(1);
    expect(degraded.per_query[0]).toMatchObject({
      error: true,
      ndcg_at_k: 0,
      recall_at_k: 0,
      failure_bucket: "error"
    });
    expect(formatEvalResult(degraded)).toContain("errored");
  });

  it("query_errors is 0 + no banner warning when every query succeeds (v3.9.0-rc.16 NEGATIVE control)", async () => {
    const v = new Vault(root);
    const queries: EvalQuery[] = [{ id: "ok", query: "Apollo", relevant: ["apollo.md"] }];
    const result = await runEval({
      vault: v,
      queries,
      ftsIndex: idx,
      embedFile: path.join(root, "nonexistent.embed.db"),
      k: 10
    });
    expect(result.query_errors).toBe(0);
    expect(result.per_query[0]?.error).toBeUndefined();
    expect(formatEvalResult(result)).not.toContain("errored");
  });
});

describe("classifyFailureBucket + tallyFailureBuckets (v3.10.0-rc.31)", () => {
  const rel = new Set(["a.md", "b.md"]);

  it("classifies an errored query as 'error' (takes precedence)", () => {
    // even with a perfect rank-1 hit, the error flag wins.
    expect(classifyFailureBucket(["a.md"], rel, 10, true)).toBe("error");
  });

  it("classifies a query with no ground truth as 'no_labels'", () => {
    expect(classifyFailureBucket(["a.md", "b.md"], new Set(), 10)).toBe("no_labels");
  });

  it("classifies a rank-1 relevant hit as 'hit_rank_1'", () => {
    expect(classifyFailureBucket(["a.md", "x.md"], rel, 10)).toBe("hit_rank_1");
  });

  it("classifies a relevant hit below rank 1 as 'hit_top_k'", () => {
    expect(classifyFailureBucket(["x.md", "y.md", "b.md"], rel, 10)).toBe("hit_top_k");
  });

  it("classifies no relevant doc in top-K as 'miss'", () => {
    expect(classifyFailureBucket(["x.md", "y.md"], rel, 10)).toBe("miss");
  });

  it("NEGATIVE: a relevant doc beyond K is NOT a hit (counts as 'miss')", () => {
    // a.md is relevant but at index 2; k=2 excludes it.
    expect(classifyFailureBucket(["x.md", "y.md", "a.md"], rel, 2)).toBe("miss");
  });

  it("NEGATIVE: a relevant doc at rank 2 yields 'hit_top_k', never 'hit_rank_1'", () => {
    expect(classifyFailureBucket(["x.md", "b.md"], rel, 10)).not.toBe("hit_rank_1");
    expect(classifyFailureBucket(["x.md", "b.md"], rel, 10)).toBe("hit_top_k");
  });

  it("NEGATIVE: an empty result set with labels is a 'miss', not a hit", () => {
    expect(classifyFailureBucket([], rel, 10)).toBe("miss");
  });

  it("tallyFailureBuckets returns a complete counter with all keys (zeros included)", () => {
    const counts = tallyFailureBuckets(["hit_rank_1", "hit_rank_1", "miss"] as FailureBucket[]);
    expect(counts).toEqual({ hit_rank_1: 2, hit_top_k: 0, miss: 1, no_labels: 0, error: 0 });
    for (const b of FAILURE_BUCKETS) expect(counts[b]).toBeGreaterThanOrEqual(0);
  });

  it("NEGATIVE: tallyFailureBuckets of an empty list is all-zero (not missing keys)", () => {
    const counts = tallyFailureBuckets([]);
    const total = (Object.values(counts) as number[]).reduce((a, b) => a + b, 0);
    expect(total).toBe(0);
    expect(Object.keys(counts).sort()).toEqual([...FAILURE_BUCKETS].sort());
  });
});

describe("formatEvalResult + formatEvalMatrix (v2.12.0)", () => {
  function makeResult(over: Partial<EvalResult> = {}): EvalResult {
    return {
      label: "test",
      k: 10,
      query_count: 1,
      query_errors: 0,
      per_query: [
        {
          id: "q1",
          query: "test query",
          ndcg_at_k: 0.85,
          recall_at_k: 0.5,
          mrr: 1.0,
          hits_relevant: 1,
          hits_total_relevant: 2,
          latency_ms: 42,
          failure_bucket: "hit_rank_1"
        }
      ],
      mean_ndcg: 0.85,
      mean_recall: 0.5,
      mean_mrr: 1.0,
      mean_latency_ms: 42,
      total_wall_ms: 50,
      diagnostics: { failure_buckets: { hit_rank_1: 1, hit_top_k: 0, miss: 0, no_labels: 0, error: 0 } },
      ...over
    };
  }

  it("formatEvalResult produces a non-empty multi-line banner", () => {
    const out = formatEvalResult(makeResult());
    expect(out.length).toBeGreaterThan(0);
    expect(out).toContain("NDCG@10");
    expect(out).toContain("0.8500");
  });

  it("formatEvalResult renders the failure-bucket breakdown when diagnostics present (rc.31)", () => {
    const out = formatEvalResult(
      makeResult({
        diagnostics: { failure_buckets: { hit_rank_1: 3, hit_top_k: 1, miss: 2, no_labels: 0, error: 1 } }
      })
    );
    expect(out).toContain("failure buckets:");
    expect(out).toContain("hit@1");
    expect(out).toContain("=3");
    expect(out).toContain("miss");
  });

  it("NEGATIVE: formatEvalResult omits the failure-bucket line when diagnostics absent", () => {
    const out = formatEvalResult(makeResult({ diagnostics: undefined }));
    expect(out).not.toContain("failure buckets:");
  });

  it("per-query table stays aligned for ids longer than 15 chars (v3.10.0-rc.33)", () => {
    const longId = "a-very-long-query-id-23"; // 23 chars > the old fixed 15-pad
    const out = formatEvalResult(
      makeResult({
        per_query: [
          {
            id: longId,
            query: "q",
            ndcg_at_k: 0.5,
            recall_at_k: 0.5,
            mrr: 0.5,
            hits_relevant: 1,
            hits_total_relevant: 1,
            latency_ms: 1,
            failure_bucket: "hit_rank_1"
          }
        ]
      }),
      { perQuery: true }
    );
    const lines = out.split("\n");
    const header = lines.find((l) => l.includes("ndcg@k")) ?? "";
    const row = lines.find((l) => l.includes(longId)) ?? "";
    // With the dynamic id-column width, the header's "ndcg@k" and the row's
    // first score column start at the SAME offset (pre-fix the 23-char id
    // overflowed the 15-pad and shifted every following column right).
    expect(header.indexOf("ndcg@k")).toBe(row.indexOf("0.5000"));
  });

  it("formatEvalResult --per-query mode includes the per-query table", () => {
    const out = formatEvalResult(makeResult(), { perQuery: true });
    expect(out).toContain("per query");
    expect(out).toContain("q1");
  });

  it("formatEvalMatrix highlights the best-NDCG config", () => {
    const a = makeResult({ label: "baseline", mean_ndcg: 0.5 });
    const b = makeResult({ label: "+reranker", mean_ndcg: 0.8 });
    const invalid = makeResult({ label: "broken-high-score", mean_ndcg: 0.99, query_errors: 1 });
    const out = formatEvalMatrix([a, b, invalid]);
    expect(out).toContain("baseline");
    expect(out).toContain("+reranker");
    expect(out).toMatch(/broken-high-score.*1 INVALID/);
    // The "best NDCG" line should call out the higher-scoring config.
    expect(out).toMatch(/best NDCG@10:.*\+reranker/);
    expect(out).not.toMatch(/best NDCG@10:.*broken-high-score/);
    expect(formatEvalMatrix([invalid])).toContain("all configurations are INVALID");
  });

  it("formatEvalMatrix handles empty input gracefully", () => {
    expect(formatEvalMatrix([])).toBe("(no results)");
  });
});

// ─── v3.11.6-rc.5 eval overhaul (competitive-study C-1) ────────────────────

describe("hitAtK (v3.11.6-rc.5)", () => {
  it("true when a relevant doc is within k", () => {
    expect(hitAtK(["a", "b", "c"], new Set(["c"]), 3)).toBe(true);
  });
  it("false when the only relevant doc is beyond k (Hit@1 vs Hit@3)", () => {
    expect(hitAtK(["a", "b", "c"], new Set(["c"]), 1)).toBe(false);
    expect(hitAtK(["a", "b", "c"], new Set(["c"]), 3)).toBe(true);
  });
  it("NEGATIVE control — false when there is no ground truth", () => {
    expect(hitAtK(["a", "b"], new Set(), 5)).toBe(false);
  });
});

describe("allRelevantAtK (v3.11.6-rc.5)", () => {
  it("true only when EVERY relevant doc is in top-k", () => {
    expect(allRelevantAtK(["a", "b", "c"], new Set(["a", "c"]), 3)).toBe(true);
  });
  it("false when one required evidence doc is missing (the AllRel signal)", () => {
    expect(allRelevantAtK(["a", "b", "c"], new Set(["a", "z"]), 3)).toBe(false);
  });
  it("false when a required doc is beyond k even though another is in top-k", () => {
    expect(allRelevantAtK(["a", "b", "c"], new Set(["a", "c"]), 2)).toBe(false);
  });
  it("NEGATIVE control — false when there is no ground truth", () => {
    expect(allRelevantAtK(["a"], new Set(), 5)).toBe(false);
  });
});

describe("missedPaths (v3.11.6-rc.5)", () => {
  it("returns the relevant paths NOT in top-k", () => {
    expect(missedPaths(["a", "b"], new Set(["a", "z"]), 5).sort()).toEqual(["z"]);
  });
  it("empty when all relevant retrieved (NEGATIVE control)", () => {
    expect(missedPaths(["a", "b"], new Set(["a", "b"]), 5)).toEqual([]);
  });
  it("respects k — a relevant doc beyond k counts as missed", () => {
    expect(missedPaths(["a", "b", "c"], new Set(["c"]), 2)).toEqual(["c"]);
  });
});

describe("groupByCategory (v3.11.6-rc.5)", () => {
  const row = (over: Partial<EvalQueryScore>): EvalQueryScore => ({
    id: "q",
    query: "q",
    ndcg_at_k: 1,
    recall_at_k: 1,
    mrr: 1,
    hits_relevant: 1,
    hits_total_relevant: 1,
    latency_ms: 1,
    failure_bucket: "hit_rank_1",
    hit_at_1: true,
    hit_at_k: true,
    all_relevant_at_k: true,
    ...over
  });
  it("groups per-query rows by category and averages each group", () => {
    const g = groupByCategory([
      row({ category: "keyword", ndcg_at_k: 1.0 }),
      row({ category: "keyword", ndcg_at_k: 0.5 }),
      row({ category: "conceptual", ndcg_at_k: 0.2, hit_at_1: false }),
      row({ category: "__proto__", ndcg_at_k: 0.4 })
    ]);
    expect(g.keyword?.query_count).toBe(2);
    expect(g.keyword?.mean_ndcg).toBeCloseTo(0.75, 4);
    expect(g.conceptual?.mean_ndcg).toBeCloseTo(0.2, 4);
    expect(g.conceptual?.mean_hit_at_1).toBe(0); // the one conceptual row missed rank-1
    expect(Object.hasOwn(g, "__proto__")).toBe(true);
    const prototypeCategory = Object.getOwnPropertyDescriptor(g, "__proto__")?.value as CategoryScore | undefined;
    expect(prototypeCategory?.mean_ndcg).toBeCloseTo(0.4, 4);
    const serialized = JSON.parse(JSON.stringify(g)) as Record<string, CategoryScore>;
    const serializedCategory = Object.getOwnPropertyDescriptor(serialized, "__proto__")?.value as
      | CategoryScore
      | undefined;
    expect(serializedCategory?.query_count).toBe(1);
  });
  it("uncategorized bucket when no category is set (NEGATIVE control — no phantom categories)", () => {
    const g = groupByCategory([row({}), row({})]);
    expect(Object.keys(g)).toEqual(["uncategorized"]);
    expect(g.uncategorized?.query_count).toBe(2);
  });
});

describe("compareEvalResults + formatEvalComparison (v3.11.6-rc.5)", () => {
  const cohort = `sha256:${"a".repeat(64)}`;
  const row: EvalQueryScore = {
    id: "q1",
    query: "query",
    ndcg_at_k: 0.6,
    recall_at_k: 0.7,
    mrr: 0.65,
    hits_relevant: 1,
    hits_total_relevant: 1,
    latency_ms: 10,
    failure_bucket: "hit_rank_1",
    hit_at_1: true,
    hit_at_k: true,
    all_relevant_at_k: true
  };
  const res = (over: Partial<EvalResult>): EvalResult => {
    const errorCount = over.query_errors ?? 0;
    const derivedRow: EvalQueryScore =
      errorCount > 0
        ? {
            ...row,
            ndcg_at_k: 0,
            recall_at_k: 0,
            mrr: 0,
            hits_relevant: 0,
            hit_at_1: false,
            hit_at_k: false,
            all_relevant_at_k: false,
            failure_bucket: "error",
            error: true
          }
        : {
            ...row,
            ndcg_at_k: over.mean_ndcg ?? row.ndcg_at_k,
            recall_at_k: over.mean_recall ?? row.recall_at_k,
            mrr: over.mean_mrr ?? row.mrr
          };
    const selectedRows = over.per_query ?? [derivedRow];
    const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
    return {
      label: "x",
      k: 10,
      query_count: selectedRows.length,
      query_errors: errorCount,
      query_set_fingerprint: cohort,
      per_query: selectedRows,
      mean_ndcg: average(selectedRows.map((item) => item.ndcg_at_k)),
      mean_recall: average(selectedRows.map((item) => item.recall_at_k)),
      mean_mrr: average(selectedRows.map((item) => item.mrr)),
      mean_latency_ms: Math.round(average(selectedRows.map((item) => item.latency_ms))),
      total_wall_ms: 1,
      mean_hit_at_1: average(selectedRows.map((item) => (item.hit_at_1 ? 1 : 0))),
      mean_hit_at_k: average(selectedRows.map((item) => (item.hit_at_k ? 1 : 0))),
      all_rel_at_k: average(selectedRows.map((item) => (item.all_relevant_at_k ? 1 : 0))),
      ...over
    };
  };

  it("marks a delta ≥ MEANINGFUL_DELTA as material and rejects invalid comparisons", () => {
    const cmp = compareEvalResults(res({ label: "before", mean_ndcg: 0.6 }), res({ label: "after", mean_ndcg: 0.65 }));
    const ndcg = cmp.deltas.find((d) => d.metric === "nDCG@k");
    expect(ndcg?.delta).toBeCloseTo(0.05, 4);
    expect(ndcg?.meaningful).toBe(true);
    expect(() =>
      compareEvalResults(res({ label: "broken", query_errors: 1 }), res({ label: "after", query_errors: 0 }))
    ).toThrow(/Cannot compare eval results with retrieval errors/);
    expect(() => compareEvalResults(res({ k: 5 }), res({ k: 10 }))).toThrow(/different k/);
    expect(() =>
      compareEvalResults(res({ query_count: 2, per_query: [row, { ...row, id: "q2" }] }), res({ query_count: 1 }))
    ).toThrow(/different query counts/);
    expect(() => compareEvalResults(res({ query_set_fingerprint: `sha256:${"b".repeat(64)}` }), res({}))).toThrow(
      /different query cohorts/
    );
    expect(() => compareEvalResults(res({ query_set_fingerprint: undefined }), res({}))).toThrow(
      /query_set_fingerprint/
    );
    expect(() => compareEvalResults(res({ mean_recall: Number.NaN, per_query: [row] }), res({}))).toThrow(
      /mean_recall must be a finite number/
    );
    expect(() => compareEvalResults(res({ mean_ndcg: 2 }), res({}))).toThrow(/ndcg_at_k.*between 0 and 1/);
    expect(() => compareEvalResults(res({ mean_ndcg: 0.61, per_query: [row] }), res({}))).toThrow(
      /mean_ndcg=.*does not match per_query/
    );
    expect(() =>
      compareEvalResults(
        res({
          query_count: 2,
          per_query: [row, { ...row }]
        }),
        res({})
      )
    ).toThrow(/duplicate id/);
    expect(() =>
      compareEvalResults(
        res({
          query_errors: 0,
          per_query: [
            {
              ...row,
              ndcg_at_k: 0,
              recall_at_k: 0,
              mrr: 0,
              hits_relevant: 0,
              hit_at_1: false,
              hit_at_k: false,
              all_relevant_at_k: false,
              failure_bucket: "error",
              error: true
            }
          ]
        }),
        res({})
      )
    ).toThrow(/query_errors=0.*1 error row/);
    expect(() =>
      compareEvalResults(
        res({
          diagnostics: {
            failure_buckets: { hit_rank_1: 0, hit_top_k: 0, miss: 0, no_labels: 0, error: 1 }
          }
        }),
        res({})
      )
    ).toThrow(/failure_buckets.hit_rank_1=.*does not match/);
  });
  it("NEGATIVE control — a sub-threshold delta is NOT meaningful", () => {
    const cmp = compareEvalResults(res({ mean_ndcg: 0.6 }), res({ mean_ndcg: 0.6 + MEANINGFUL_DELTA / 2 }));
    expect(cmp.deltas.find((d) => d.metric === "nDCG@k")?.meaningful).toBe(false);
  });
  it("formatEvalComparison flags a meaningful regression as such", () => {
    const cmp = compareEvalResults(res({ label: "before", mean_mrr: 0.7 }), res({ label: "after", mean_mrr: 0.6 }));
    const out = formatEvalComparison(cmp);
    expect(out).toMatch(/regression/);
  });
});

describe("readQueriesJsonl category parsing (v3.11.6-rc.5)", () => {
  it("parses an optional category field", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eval-cat-"));
    const file = path.join(dir, "q.jsonl");
    await fs.writeFile(
      file,
      `{"query":"a","relevant":["x.md"],"category":"keyword"}\n{"query":"b","relevant":["y.md"]}\n`
    );
    const qs = await readQueriesJsonl(file);
    expect(qs[0]?.category).toBe("keyword");
    expect(qs[1]?.category).toBeUndefined(); // NEGATIVE control — absent category stays undefined
    await fs.rm(dir, { recursive: true, force: true });
  });
});
