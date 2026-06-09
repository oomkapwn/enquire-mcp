// v3.9.0-rc.25 — DURABLE defense for the ReDoS-detector class.
//
// The `obsidian_open_questions` ReDoS guard (`isCatastrophicRegex`) is a
// best-effort denylist, and the project's history shows the class RECURS: rc.21
// (overlapping alternation), rc.24 (case-fold + escape alias), rc.25 (optional
// leading atom + nullable body + variable-length body) each shipped a guard that
// a later audit/fuzz proved still under-flagged. Unit tests of known shapes can't
// catch the NEXT missed shape — only fuzzing can. So this test is the structural
// safety net the class actually needs (CLAUDE.md "fuzz your own detector"):
//
//   Generate many ReDoS-prone patterns. For every one the guard classifies SAFE,
//   actually RUN it (in a worker, with a timeout) against an adversarial input.
//   If a SAFE-classified pattern HANGS, that is an under-flag → fail loudly.
//
// Deterministic (seeded PRNG, fixed input) so a failure is reproducible. Only the
// SAFE-classified candidates spawn a worker (flagged ones cost a microsecond), so
// the wall-clock is bounded by the handful near the safe/catastrophic boundary.

import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { isCatastrophicRegex } from "../src/tools/index.js";

// Deterministic LCG — no Math.random, so the corpus (and any failure) is fixed.
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}
const LIT = ["a", "b", "c"];
const QUANT = ["", "", "?", "*", "+", "{0,3}", "{2,5}", "{0,}", "??", "*?"];
function genPattern(rnd: () => number): string {
  const pick = <T>(a: T[]): T => a[Math.floor(rnd() * a.length)] as T;
  const atom = (depth: number): string => {
    const r = rnd();
    if (depth < 2 && r < 0.25) {
      const branches = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => seq(depth + 1));
      return `(${branches.join("|")})${pick(QUANT)}`;
    }
    if (r < 0.4) return `[${pick(LIT)}${pick(LIT)}]${pick(QUANT)}`;
    if (r < 0.5) return `\\${pick(["d", "w", "s", ".", "x61"])}${pick(QUANT)}`;
    if (r < 0.55) return `.${pick(QUANT)}`;
    return `${pick(LIT)}${pick(QUANT)}`;
  };
  const seq = (depth: number): string => Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => atom(depth)).join("");
  const branches = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => seq(1));
  // v3.10.0-rc.36: ~40% of patterns are a BARE top-level concatenation (NO wrapping
  // quantified group) so the corpus exercises the adjacent-quantifier shape
  // (`a*a*$`, `\w*\w*…$`, `(a)*(a)*$`) that rc.21–rc.25 — and, until rc.36, this very
  // generator — were blind to. The rc.36 CRITICAL (top-level `\w*\w*…$`, 16s hang)
  // lived exactly in this gap: every prior pattern was a quantified GROUP.
  if (rnd() < 0.4) return `${seq(1)}${seq(1)}$`;
  return `(${branches.join("|")})${pick(["+", "*", "+", "{0,20}", "{2,}"])}$`;
}

// Run `new RegExp(pattern,"i").exec(input)` over ALL `inputs` in a SINGLE worker
// (one spawn per pattern, not per input), resolving "timeout" if the whole batch
// doesn't finish within `ms`. A catastrophic pattern never returns on a
// triggering input → "timeout"; a linear one finishes the batch in <1ms.
function execAll(pattern: string, inputs: string[], ms: number): Promise<"ok" | "err" | "timeout"> {
  return new Promise((resolve) => {
    const w = new Worker(
      "const{parentPort,workerData}=require('worker_threads');try{for(const i of workerData.inputs){new RegExp(workerData.p,'i').exec(i)}parentPort.postMessage('ok')}catch(e){parentPort.postMessage('err')}",
      { eval: true, workerData: { p: pattern, inputs } }
    );
    const t = setTimeout(() => {
      void w.terminate();
      resolve("timeout");
    }, ms);
    w.on("message", (m: "ok" | "err") => {
      clearTimeout(t);
      void w.terminate();
      resolve(m);
    });
    w.on("error", () => {
      clearTimeout(t);
      void w.terminate();
      resolve("err");
    });
  });
}

// The adversarial input must MATCH the pattern's alphabet to trigger its worst
// case (an all-`a` string can't make a `b`-based pattern backtrack). The
// generator's alphabet is {a,b,c}, so probe a few uniform/repeating runs + a
// forcing-fail tail. A pattern that hangs on ANY of these is an under-flag.
const ADVERSARIAL = [`${"a".repeat(40)}!`, `${"b".repeat(40)}!`, `${"ab".repeat(20)}!`, `${"abc".repeat(14)}!`];

// A genuine catastrophic hang runs for many seconds (2^40-ish on these inputs); a
// linear pattern finishes in <1ms. Under full-suite parallel load a worker can be
// CPU-starved, so a single short timeout would FLAKE. We RE-CONFIRM any timeout
// with a calm 5s budget: a real hang survives it, a starved-linear pattern
// completes. Only a double-timeout counts as an under-flag.
async function patternHangs(pattern: string): Promise<boolean> {
  if ((await execAll(pattern, ADVERSARIAL, 1200)) !== "timeout") return false; // fast path: completed
  return (await execAll(pattern, ADVERSARIAL, 5000)) === "timeout"; // re-confirm: genuine hang or load?
}

describe("ReDoS guard fuzz — no SAFE-classified pattern may hang", () => {
  it("every isCatastrophicRegex-SAFE pattern completes quickly on an adversarial input (no under-flag)", async () => {
    const rnd = makeRng(0x5eed1234);
    const N = 2000;
    const MAX_SAFE_EXEC = 150; // bound wall-clock (one worker per safe pattern)
    const offenders: string[] = [];
    let safeChecked = 0;
    let bareTopLevelSafe = 0; // v3.10.0-rc.36: SAFE patterns that are a BARE top-level
    // concatenation (the rc.36 adjacency shape), not a wrapping quantified group.
    for (let k = 0; k < N && safeChecked < MAX_SAFE_EXEC; k++) {
      const p = genPattern(rnd);
      if (p.length > 200) continue; // mirror MAX_QUESTION_PATTERN_LEN
      try {
        new RegExp(p, "i"); // skip invalid patterns — not the guard's concern
      } catch {
        continue;
      }
      if (isCatastrophicRegex(p)) continue; // flagged → never compiled by the tool
      safeChecked++;
      if (!p.startsWith("(")) bareTopLevelSafe++;
      if (await patternHangs(p)) offenders.push(p);
    }
    expect(offenders).toEqual([]); // any offender is an under-flag the guard must catch
    // v3.10.0-rc.36 (finding #10): the corpus must EXERCISE a healthy number of SAFE
    // verdicts. Pre-rc.36 the generator emitted ONLY quantified groups, starving the
    // SAFE corpus to ~43 trivially-linear patterns far from the boundary — so a future
    // under-flag near the boundary would rarely be generated. Assert the worker sees a
    // substantial SAFE set, INCLUDING the bare top-level adjacency shape (`a*b*$`,
    // `\w*\s*…$`) where the rc.36 CRITICAL lived.
    expect(safeChecked).toBeGreaterThan(80);
    expect(bareTopLevelSafe).toBeGreaterThan(20);
  }, 120_000);

  it("NEGATIVE control — the fuzz harness DOES detect a hang (known catastrophic pattern times out)", async () => {
    // If this DIDN'T hang, the harness would be vacuous (it could never catch
    // an under-flag). `(a?b|b)+$` is the rc.25 C-1 repro — its worst case is a
    // run of `b`s (each `b` matches two ways → 2^n). `patternHangs` probes the
    // alphabet (incl. "bbbb…!"), proving the timer fires on a real hang.
    expect(await patternHangs("(a?b|b)+$")).toBe(true);
  }, 30_000);
});
