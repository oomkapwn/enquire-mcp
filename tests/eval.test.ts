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
  type EvalQuery,
  type EvalResult,
  formatEvalMatrix,
  formatEvalResult,
  ndcgAtK,
  readQueriesJsonl,
  recallAtK,
  reciprocalRank,
  runEval
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
  });
});

describe("formatEvalResult + formatEvalMatrix (v2.12.0)", () => {
  function makeResult(over: Partial<EvalResult> = {}): EvalResult {
    return {
      label: "test",
      k: 10,
      query_count: 1,
      per_query: [
        {
          id: "q1",
          query: "test query",
          ndcg_at_k: 0.85,
          recall_at_k: 0.5,
          mrr: 1.0,
          hits_relevant: 1,
          hits_total_relevant: 2,
          latency_ms: 42
        }
      ],
      mean_ndcg: 0.85,
      mean_recall: 0.5,
      mean_mrr: 1.0,
      mean_latency_ms: 42,
      total_wall_ms: 50,
      ...over
    };
  }

  it("formatEvalResult produces a non-empty multi-line banner", () => {
    const out = formatEvalResult(makeResult());
    expect(out.length).toBeGreaterThan(0);
    expect(out).toContain("NDCG@10");
    expect(out).toContain("0.8500");
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
