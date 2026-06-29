// v3.11.2 — context-savings harness pure-function tests.
//
// Covers the deterministic, I/O-free helpers of scripts/bench-context.mjs
// (token estimation + the savings ratio). The full benchmark run builds a
// synthetic vault + embeddings and PRINTS a number, but no figure is published
// without a reference-vault run + sign-off (docs/EVALUATION_PLAN.md), so main()
// is intentionally NOT exercised here — only the measurement math is, with
// NEGATIVE controls so a mis-stated savings number can't ship.

import { describe, expect, it } from "vitest";
// @ts-expect-error — .mjs build script, no type declarations (CLI guarded by isEntrypoint).
import { estimateTokens, savingsRatio } from "../scripts/bench-context.mjs";

describe("estimateTokens (v3.11.2 — ~4 chars/token heuristic)", () => {
  it("is ceil(chars/4) and applied symmetrically to both paths", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2); // 5/4 → ceil = 2
    expect(estimateTokens("x".repeat(4000))).toBe(1000);
  });
  it("handles nullish without throwing (NEGATIVE control)", () => {
    expect(estimateTokens(undefined)).toBe(0);
    expect(estimateTokens(null)).toBe(0);
  });
});

describe("savingsRatio (v3.11.2 — baseline_tokens / pack_tokens)", () => {
  it("reports real savings when the pack is smaller", () => {
    expect(savingsRatio(12000, 1500)).toBe(8); // 8× less context
    expect(savingsRatio(18900, 1506)).toBeCloseTo(12.55, 1);
  });
  it("never claims savings when the pack is NOT smaller (NEGATIVE control — no inflated ratio)", () => {
    expect(savingsRatio(1000, 1000)).toBe(1); // equal → no savings
    expect(savingsRatio(500, 1000)).toBe(1); // pack bigger → still 1, never <1 or a fake win
  });
  it("never divides by zero (NEGATIVE control)", () => {
    expect(savingsRatio(5000, 0)).toBe(0);
    expect(savingsRatio(0, 0)).toBe(0);
  });
});
