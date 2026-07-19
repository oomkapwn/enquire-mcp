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
import { parseBenchArgs, resolveBenchWrite } from "../scripts/run-benchmarks.mjs";

const CANON = "/repo/bench/benchmarks.json";

// v3.11.6-rc.16 (post-rc.15 re-sweep, RC15-TESTINFRA-1) — this very import is the
// regression: pre-rc.16 the module ran a dist-preflight `process.exit(1)` + loaded
// the whole app graph (tools/fts5/vault/rrf/eval/server) UNCONDITIONALLY at load,
// so importing it for the two pure exports above could hard-abort the file / drag
// in the runtime. The dist load now lives behind the CLI entry. This describe
// proves the import is side-effect-free by simply having succeeded (the two pure
// exports are callable and no process.exit fired) AND pins the structural close.
describe("run-benchmarks.mjs import isolation (rc.16 RC15-TESTINFRA-1)", () => {
  it("importing for pure exports has no dist-load side effect (both exports usable)", () => {
    // If the module still process.exit'd or failed a top-level dist import, this
    // file wouldn't have loaded at all. Reaching here + calling the pure fn proves it.
    expect(typeof parseBenchArgs).toBe("function");
    expect(typeof resolveBenchWrite).toBe("function");
    expect(parseBenchArgs([])).toEqual({ allowPartial: false, output: null });
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
