// v3.11.6-rc.15 (external rc.14 audit M-1) — strict benchmark-write contract.
//
// Pre-rc.15 `npm run bench:retrieval` (the advertised reproduction command for
// the published +15.5 NDCG@10 / +24.7 MRR reranker delta) caught embedder/
// reranker load failures, converted them to `skipped` rows, exited 0, AND
// overwrote the tracked canonical `bench/benchmarks.json` — i.e. it did not
// fail when it had failed to reproduce the measurement, and a partial run could
// replace the canonical evidence. The write decision is now the pure
// `resolveBenchWrite`; these tests pin its strict contract without a full
// model-loading run. The core invariant (NEGATIVE control): a run missing a
// required arm can NEVER resolve to a write of the canonical artifact.

import * as path from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error — .mjs build script, no type declarations (CLI guarded by isEntrypoint).
import {
  applyBenchmarkGraphTieBreak,
  benchmarkEmbeddingSyncComplete,
  parseBenchArgs,
  resolveBenchWrite
} from "../scripts/run-benchmarks.mjs";

const CANON = "/repo/bench/benchmarks.json";

// v3.11.6-rc.16 (post-rc.15 re-sweep, RC15-TESTINFRA-1) — this very import is the
// regression: pre-rc.16 the module ran a dist-preflight `process.exit(1)` + loaded
// the whole app graph (tools/fts5/vault/rrf/eval/server) UNCONDITIONALLY at load,
// so importing it for the two pure exports above could hard-abort the file / drag
// in the runtime. The dist load now lives behind the CLI entry. This describe
// proves the import is side-effect-free by simply having succeeded (the two pure
// exports are callable and no process.exit fired) AND pins the structural close.
describe("run-benchmarks.mjs import isolation (rc.16 RC15-TESTINFRA-1)", () => {
  it("imports pure helpers without dist side effects and mirrors the product graph tie-break", () => {
    // If the module still process.exit'd or failed a top-level dist import, this
    // file wouldn't have loaded at all. Reaching here + calling the pure fn proves it.
    expect(typeof parseBenchArgs).toBe("function");
    expect(typeof resolveBenchWrite).toBe("function");
    expect(typeof applyBenchmarkGraphTieBreak).toBe("function");
    expect(parseBenchArgs([])).toEqual({ allowPartial: false, output: null });

    // Equal RRF scores may be reordered by in-degree. This fixture also pins
    // the path contract: only the trailing numeric chunk id is stripped, a
    // literal `#` in the filename survives, and NFD/case variants match NFC.
    const accentedChunk = "Folder/Cafe\u0301# Notes.md#2";
    const tied = [
      { id: "Neutral.md", score: 0.1 },
      { id: accentedChunk, score: 0.1 },
      { id: "Other.md", score: 0.05 }
    ];
    expect(applyBenchmarkGraphTieBreak(tied, new Map([["Other.md", new Set(["folder/CAFÉ# NOTES"])]]))).toEqual([
      { id: accentedChunk, score: 0.1 },
      { id: "Neutral.md", score: 0.1 },
      { id: "Other.md", score: 0.05 }
    ]);

    // NEGATIVE control for the former benchmark-only alpha mutation: even
    // thirty inbound links cannot overtake a genuinely stronger RRF score,
    // and the fused scores themselves remain byte-for-byte unchanged.
    const unequal = [
      { id: "Strong.md", score: 0.2 },
      { id: "Linked.md", score: 0.1 },
      ...Array.from({ length: 30 }, (_, i) => ({ id: `Source-${i}.md`, score: 0.01 }))
    ];
    const manyLinks = new Map(Array.from({ length: 30 }, (_, i) => [`Source-${i}.md`, new Set(["Linked"])]));
    const originalScores = new Map(unequal.map((candidate) => [candidate.id, candidate.score]));
    const unequalRanked = applyBenchmarkGraphTieBreak(unequal, manyLinks);
    expect(unequalRanked.slice(0, 2)).toEqual([
      { id: "Strong.md", score: 0.2 },
      { id: "Linked.md", score: 0.1 }
    ]);
    expect(new Map(unequalRanked.map((candidate) => [candidate.id, candidate.score]))).toEqual(originalScores);

    // A link donor outside the fused candidate set cannot affect the tie.
    // This pins the caller boundary behind product `topK=max(limit*4, 30)`:
    // a rank-41+ donor is absent when the benchmark result limit is 10.
    const boundaryTie = [
      { id: "B.md", score: 0.1 },
      { id: "A.md", score: 0.1 }
    ];
    expect(applyBenchmarkGraphTieBreak(boundaryTie, new Map([["LateSource.md", new Set(["A"])]]))).toEqual([
      { id: "B.md", score: 0.1 },
      { id: "A.md", score: 0.1 }
    ]);
  });
});

describe("parseBenchArgs (rc.15 M-1)", () => {
  it("defaults to strict (no partial, no output)", () => {
    expect(parseBenchArgs([])).toEqual({ allowPartial: false, output: null });
  });
  it("parses --allow-partial and --output", () => {
    expect(parseBenchArgs(["--allow-partial", "--output", "/tmp/x.json"])).toEqual({
      allowPartial: true,
      output: "/tmp/x.json"
    });
  });
});

describe("benchmarkEmbeddingSyncComplete", () => {
  const complete = {
    mode: "strict",
    complete: true,
    added: 2,
    updated: 0,
    deleted: 0,
    unchanged: 0,
    total_chunks: 4,
    total_files: 2,
    processed_files: 2,
    empty: 0,
    failed: 0,
    indexed_files: 2,
    declared_chunks: 4,
    indexed_chunks: 4,
    mismatched_files: 0
  };

  it("accepts a strict fresh-vault report whose raw counters and physical audit agree", () => {
    expect(benchmarkEmbeddingSyncComplete(complete, 2)).toBe(true);
  });

  it("rejects forged complete=true when any load-bearing raw field is inconsistent", () => {
    expect(benchmarkEmbeddingSyncComplete({ ...complete, mode: "fail-soft" }, 2)).toBe(false);
    expect(benchmarkEmbeddingSyncComplete({ ...complete, processed_files: 1 }, 2)).toBe(false);
    expect(benchmarkEmbeddingSyncComplete({ ...complete, added: 1, unchanged: 1 }, 2)).toBe(false);
    expect(benchmarkEmbeddingSyncComplete({ ...complete, failed: 1 }, 2)).toBe(false);
    expect(benchmarkEmbeddingSyncComplete({ ...complete, declared_chunks: 5 }, 2)).toBe(false);
    expect(benchmarkEmbeddingSyncComplete({ ...complete, mismatched_files: 1 }, 2)).toBe(false);
    expect(benchmarkEmbeddingSyncComplete({ ...complete, indexed_chunks: -1 }, 2)).toBe(false);
  });
});

describe("resolveBenchWrite (rc.15 M-1)", () => {
  it("writes the canonical artifact ONLY on a full run (both required arms ran)", () => {
    const d = resolveBenchWrite({
      embedReady: true,
      rerankerReady: true,
      allowPartial: false,
      output: null,
      canonicalFile: CANON
    });
    expect(d).toEqual({ mode: "write", file: CANON, partial: false });
  });

  it("a full run may redirect to --output", () => {
    const d = resolveBenchWrite({
      embedReady: true,
      rerankerReady: true,
      allowPartial: false,
      output: "/tmp/full.json",
      canonicalFile: CANON
    });
    expect(d.mode).toBe("write");
    expect(d.file).toBe(path.resolve("/tmp/full.json"));
    expect(d.partial).toBe(false);
  });

  // NEGATIVE control — THE bug the auditor found: a skipped required arm used to
  // exit 0 and overwrite the canonical artifact. Strict mode must refuse.
  it("STRICT-FAILS (no write) when a required arm skipped and --allow-partial is absent", () => {
    expect(
      resolveBenchWrite({
        embedReady: false,
        rerankerReady: true,
        allowPartial: false,
        output: null,
        canonicalFile: CANON
      })
    ).toEqual({ mode: "strict-fail" });
    expect(
      resolveBenchWrite({
        embedReady: true,
        rerankerReady: false,
        allowPartial: false,
        output: null,
        canonicalFile: CANON
      })
    ).toEqual({ mode: "strict-fail" });
    expect(
      resolveBenchWrite({
        embedReady: false,
        rerankerReady: false,
        allowPartial: false,
        output: null,
        canonicalFile: CANON
      })
    ).toEqual({ mode: "strict-fail" });
  });

  it("requires --output for a degraded --allow-partial run (can't fall back to canonical)", () => {
    expect(
      resolveBenchWrite({
        embedReady: false,
        rerankerReady: true,
        allowPartial: true,
        output: null,
        canonicalFile: CANON
      })
    ).toEqual({ mode: "need-output" });
  });

  it("a degraded --allow-partial run writes ONLY to the explicit --output, flagged partial", () => {
    const d = resolveBenchWrite({
      embedReady: false,
      rerankerReady: false,
      allowPartial: true,
      output: "/tmp/degraded.json",
      canonicalFile: CANON
    });
    expect(d.mode).toBe("write");
    expect(d.file).toBe(path.resolve("/tmp/degraded.json"));
    expect(d.partial).toBe(true);
  });

  // The load-bearing invariant: across EVERY input where a required arm skipped,
  // the decision never resolves to writing the canonical artifact.
  it("NEGATIVE control — no degraded run can ever target the canonical artifact", () => {
    for (const embedReady of [true, false]) {
      for (const rerankerReady of [true, false]) {
        for (const allowPartial of [true, false]) {
          for (const output of [null, "/tmp/o.json", CANON]) {
            const d = resolveBenchWrite({ embedReady, rerankerReady, allowPartial, output, canonicalFile: CANON });
            const degraded = !(embedReady && rerankerReady);
            if (degraded && d.mode === "write") {
              // A degraded run may only write when the caller explicitly aimed
              // at a NON-canonical --output path.
              expect(output).not.toBeNull();
              expect(path.resolve(String(output))).not.toBe(CANON);
            }
          }
        }
      }
    }
  });
});
