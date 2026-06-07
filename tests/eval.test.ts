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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  classifyFailureBucket,
  type EvalQuery,
  type EvalResult,
  FAILURE_BUCKETS,
  type FailureBucket,
  formatEvalMatrix,
  formatEvalResult,
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

  it("survives a query that throws — per-query isolation", async () => {
    const v = new Vault(root);
    const queries: EvalQuery[] = [
      { id: "ok", query: "Apollo", relevant: ["apollo.md"] },
      { id: "blowup", query: "", relevant: ["apollo.md"] } // empty query throws inside searchHybrid
    ];
    const result = await runEval({
      vault: v,
      queries,
      ftsIndex: idx,
      embedFile: path.join(root, "nonexistent.embed.db"),
      k: 10
    });
    // Both queries scored; the second has 0 metrics across the board.
    expect(result.query_count).toBe(2);
    expect(result.per_query[1]?.ndcg_at_k).toBe(0);
    expect(result.per_query[1]?.recall_at_k).toBe(0);
    // v3.9.0-rc.16 — the errored query is COUNTED + FLAGGED, not silently
    // conflated with a genuine zero-relevance retrieval.
    expect(result.query_errors).toBe(1);
    expect(result.per_query[1]?.error).toBe(true);
    // v3.10.0-rc.32 (audit LOW) — the errored query's bucket is "error" end-to-end
    // (runEval wires `errored` into classifyFailureBucket + the aggregate counter).
    expect(result.per_query[1]?.failure_bucket).toBe("error");
    expect(result.diagnostics?.failure_buckets.error).toBe(1);
    // NEGATIVE control: the successful query carries no error flag.
    expect(result.per_query[0]?.error).toBeUndefined();
    // The human-readable banner surfaces the deflation warning.
    expect(formatEvalResult(result)).toContain("errored");
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
    const out = formatEvalMatrix([a, b]);
    expect(out).toContain("baseline");
    expect(out).toContain("+reranker");
    // The "best NDCG" line should call out the higher-scoring config.
    expect(out).toMatch(/best NDCG@10:.*\+reranker/);
  });

  it("formatEvalMatrix handles empty input gracefully", () => {
    expect(formatEvalMatrix([])).toBe("(no results)");
  });
});
