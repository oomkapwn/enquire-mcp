// v3.11.0-rc.9 (external re-audit T-MED-1 re-verify) — HNSW SHARED-STATE MUTATION
// MUST STAY A SYNCHRONOUS CRITICAL SECTION.
//
// The auditor flagged a cross-file watcher interleave as MEDIUM ("two different-file
// events interleave markDelete↔addPoint on the shared hnswlib index, leaving a
// partial apply"). Per-item re-verification (3/3 adversarial skeptics) found it a
// FALSE POSITIVE: `HnswIndex.applyDiff` and the watcher's `syncHnswForFile` are
// FULLY SYNCHRONOUS — there is no `await` between markDelete and addPoint, nor
// around the shared `hnswRowsByLabel` delete/set. On Node's single-threaded,
// run-to-completion event loop that makes the whole block atomic with respect to
// every OTHER task, so two different-file `handle()` chains can only context-switch
// at their `await`ed embed steps (which don't touch shared state). The synchronicity
// IS the cross-file serialization; an explicit mutation queue would be redundant.
//
// So the auditor's *fix* (a queue) is rejected, but the underlying property is
// LOAD-BEARING and was only implicit — a future refactor that makes either method
// async (e.g. to back a remote vector store) WOULD open a real interleave window and
// pass every drift/claim CI gate silently. This invariant converts the implicit
// "no await in the shared-HNSW critical section" assumption into a self-checking
// gate (the rc.36 transform: an undecidable "did we keep it atomic?" → an empirical
// CI assertion). Behavioral concurrency is exactly the class the internal apparatus
// is structurally blind to (CLAUDE.md rc.36 meta-audit).

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "..");

/** Strip `//` line comments so a comment mentioning "await" can't trip the check. */
function stripLineComments(source: string): string {
  return source
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("//");
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join("\n");
}

/**
 * Pure: the code slice between two unique in-body anchors (inclusive of `end`).
 * Anchors are real statements inside the critical section, so this sidesteps the
 * brace-balancing hazard of method signatures whose params/return types contain `{`.
 */
function sliceBetween(source: string, start: string, end: string): string {
  const a = source.indexOf(start);
  if (a < 0) throw new Error(`critical-section anchor not found: ${start}`);
  const b = source.indexOf(end, a);
  if (b < 0) throw new Error(`critical-section anchor not found: ${end}`);
  return source.slice(a, b + end.length);
}

/** Pure detector — does a code slice contain an `await` token? */
function containsAwait(slice: string): boolean {
  return /\bawait\b/.test(slice);
}

describe("HNSW shared-state critical section is synchronous (rc.9, T-MED-1)", () => {
  const hnswSrc = stripLineComments(readFileSync(path.join(repoRoot, "src/hnsw.ts"), "utf8"));
  const watcherSrc = stripLineComments(readFileSync(path.join(repoRoot, "src/watcher.ts"), "utf8"));

  it("HnswIndex.applyDiff has NO await between markDelete and addPoint (POSITIVE — the class gate)", () => {
    // markDelete loop → resize → addPoint loop → return. Any await here would let
    // another file's applyDiff interleave a partial mutation on the shared index.
    const core = sliceBetween(hnswSrc, "for (const label of removeLabels)", "return { removed, added }");
    expect(containsAwait(core), "applyDiff critical section must be synchronous").toBe(false);
    // applyDiff must not be declared async.
    expect(hnswSrc).not.toMatch(/async\s+applyDiff\b/);
  });

  it("watcher.syncHnswForFile has NO await around the applyDiff + shared rowsByLabel mutation (POSITIVE)", () => {
    // applyDiff call → hnswDirty=true → rowsByLabel delete/set loops → return result.
    const core = sliceBetween(watcherSrc, "const result = this.hnsw.applyDiff(", "return result;");
    expect(containsAwait(core), "syncHnswForFile critical section must be synchronous").toBe(false);
    // syncHnswForFile must not be declared async.
    expect(watcherSrc).not.toMatch(/private\s+async\s+syncHnswForFile\b/);
  });

  it("detector fires on an await inside the critical section so the gate is not vacuous (NEGATIVE control)", () => {
    // A synthetic applyDiff body with an await BETWEEN markDelete and addPoint — the
    // exact regression that would open the cross-file interleave window.
    const bad = [
      "for (const label of removeLabels) ctor.markDelete(label);",
      "await somethingAsync();",
      "for (const pt of addPoints) ctor.addPoint(pt);",
      "return { removed, added };"
    ].join("\n");
    const core = sliceBetween(bad, "for (const label of removeLabels)", "return { removed, added }");
    expect(containsAwait(core)).toBe(true);
    // POSITIVE control: the same body without the await is clean.
    const good = bad.replace("await somethingAsync();", "ctor.resizeIndex(n);");
    expect(containsAwait(sliceBetween(good, "for (const label of removeLabels)", "return { removed, added }"))).toBe(
      false
    );
  });
});
