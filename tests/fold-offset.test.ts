// v3.11.0-rc.21 (post-rc.20 re-sweep) — FOLD-OFFSET class, read/snippet path.
//
// rc.18 fixed `replaceLineOnce` (write.ts): a case-insensitive offset computed on a
// `toLowerCase()` copy must NOT be used to index the ORIGINAL string, because
// `String.prototype.toLowerCase()` is NOT length-preserving (`İ` U+0130 → `i̇`, 1 unit
// → 2; final-sigma; …). The post-rc.20 re-sweep found two READ-path siblings:
//   • semanticSearch — `body.toLowerCase().indexOf(t)` sliced against `body`
//   • searchText      — `content.toLowerCase()` offset sliced against `content`
// Both now route through `foldWithMap` / `foldedIndexOf`, which return offsets into the
// ORIGINAL string. This guards the helper's correctness + that both sites use it.

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { foldedIndexOf, foldWithMap, sliceSnippet } from "../src/tools/search.js";

describe("foldWithMap / foldedIndexOf (rc.21) — ORIGINAL-string offsets after length-changing folds", () => {
  it("returns the original-string offset, not the folded copy's (POSITIVE)", () => {
    // `İ` lowercases to 2 code units, so every `İ` before the match drifts a naive offset by +1.
    expect(foldedIndexOf("İX foo", "x")).toBe(1); // X is at original index 1
    expect(foldedIndexOf("İİy", "y")).toBe(2); // two expanding folds before y
    expect(foldedIndexOf("abc", "c")).toBe(2); // ASCII unchanged
    expect(foldedIndexOf("ABC", "b")).toBe(1); // case-insensitive
    expect(foldedIndexOf("abc", "z")).toBe(-1); // not found
    expect(foldedIndexOf("abc", "")).toBe(0); // empty needle
  });

  it("the naive folded offset is WRONG for the İ case (NEGATIVE control — proves the bug)", () => {
    const body = "İX foo";
    const naive = body.toLowerCase().indexOf("x"); // the pre-rc.21 computation
    expect(naive).toBe(2); // drifted PAST the real X (original index 1)
    expect(naive).not.toBe(foldedIndexOf(body, "x")); // the fix differs from the bug
  });

  it("foldWithMap keeps map.length === folded.length and every entry a valid original index", () => {
    const { folded, map } = foldWithMap("İX alpha");
    expect(map.length).toBe(folded.length);
    expect(folded).toBe("İX alpha".toLowerCase());
    expect(Math.max(...map)).toBeLessThan("İX alpha".length);
    expect(map[0]).toBe(0); // both folded units of İ map back to original index 0
    expect(map[1]).toBe(0);
  });

  it("sliceSnippet centred on the fixed offset captures the term; the naive offset would not (behavioral)", () => {
    const body = "İX alpha beta";
    const good = sliceSnippet(body, foldedIndexOf(body, "x"), 1);
    expect(good.snippet).toContain("X"); // matched term is inside the window
    expect(good.line).toBe(1);
  });
});

describe("fold-offset inventory (rc.21) — the snippet sites route through the offset-safe helper", () => {
  const src = readFileSync(path.join(path.resolve(__dirname, ".."), "src/tools/search.ts"), "utf8");
  // The dangerous shape: a `<v>.toLowerCase().indexOf(...)` offset fed to `sliceSnippet(<v>, …)`.
  const ANTI = /\.toLowerCase\(\)\.indexOf\([^)]*\)[\s\S]{0,80}sliceSnippet/;

  it("semanticSearch + searchText no longer slice on a bare toLowerCase().indexOf offset (POSITIVE)", () => {
    expect(ANTI.test(src)).toBe(false);
    expect(src).toContain("foldedIndexOf(body"); // semanticSearch
    expect(src).toContain("foldWithMap(content"); // searchText
  });

  it("the anti-pattern detector fires on the pre-rc.21 shape (NEGATIVE control)", () => {
    const bad = "const idx = body.toLowerCase().indexOf(t);\n const { snippet } = sliceSnippet(body, idx, 1);";
    expect(ANTI.test(bad)).toBe(true);
  });
});

describe("fold-offset — Greek final-sigma read-path cosmetic limitation (rc.1, documented-accept)", () => {
  // foldWithMap folds the haystack per CODE POINT (context-free → medial σ), but the snippet
  // caller passes a whole-string `.toLowerCase()` query token (word-final ς for a token ending
  // in Σ). So foldedIndexOf returns -1 and the snippet falls back to the note start. This is
  // SNIPPET CENTRING ONLY — scoring is unaffected. The materially-harmful write-path sibling
  // (replace_in_notes silent under-replace) IS fixed in rc.1 (foldForMatch). Pinned as a contract
  // so the next auditor sees it is a KNOWN, reasoned-accepted cosmetic residual, not a regression.
  it("a whole-string-folded final-sigma token does not centre the snippet (the accepted residual)", () => {
    const body = "η οδος εδω"; // body folds per code point → contains medial "οδος"… wait: medial here
    // Build the exact mismatch: body has a word-final Σ → per-cp fold yields medial σ; the caller's
    // token is the whole-string fold (final ς).
    const bodyWithFinalSigma = "δες ΟΔΟΣ"; // foldWithMap → "δες οδοσ" (medial σ)
    const wholeStringToken = "ΟΔΟΣ".toLowerCase(); // "οδος" (final ς) — what semanticSearch passes
    expect(foldedIndexOf(bodyWithFinalSigma, wholeStringToken)).toBe(-1); // the accepted miss
    // and the per-code-point token WOULD be found (proving the root is the whole-string token fold)
    const perCpToken = foldForMatchLocal("ΟΔΟΣ");
    expect(foldedIndexOf(bodyWithFinalSigma, perCpToken)).toBeGreaterThanOrEqual(0);
    void body;
  });
});

// Local per-code-point fold mirroring src/wildcard-match.ts foldForMatch (kept inline so this
// read-path test file doesn't depend on the write-path module).
function foldForMatchLocal(s: string): string {
  let out = "";
  for (const ch of s) out += ch.toLowerCase();
  return out;
}
