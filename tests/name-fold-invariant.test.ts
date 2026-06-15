// v3.10.0-rc.46 — NFC NAME-RESOLUTION INVENTORY INVARIANT (P0 structural defense).
//
// Closes the Unicode NFC/NFD name-resolution class. rc.43's `foldKey()` fixed ONE
// instance (wikilink/find_path resolution); an RCA re-sweep then found the SAME
// bug live in 14 name-comparison sites across 5 files (communities.ts graph,
// vault.ts findByTitle/findAllByTitle, bases.ts linksTo + file.name==,
// tools/meta.ts lint_vault_wiki titleSet, tools/search.ts title 3-grams,
// tools/write.ts suggestSimilar). The bug: macOS APFS returns filenames in NFD
// while wikilinks/titles are usually NFC, so the cafe-with-acute name in NFC form
// !== the same name in NFD form even after `.toLowerCase()` — accented names
// silently fail to resolve.
//
// WHY THE INTERNAL APPARATUS MISSED THIS (meta-audit, this session): the OIA +
// invariant suite is drift/claim-driven; it has no behavioral lens for "is this
// name comparison Unicode-correct?". rc.43 fixed the one instance an external
// critic named; the siblings were found only by a follow-up RCA, not a gate.
// This invariant ends that recursion the same way the rc.25 ReDoS fuzz and the
// rc.36 resource-bound manifest did: convert "did we remember to NFC-fold every
// name comparison?" (recursion-prone) into a self-checking CI gate.
//
// The detector flags the precise signature of the class: an extension-strip
// (`.replace(/\.md$/i,"")` / `.replace(/\.base$/i,"")`) OR a `stripMd`/`stripMdExt`
// call, immediately followed by `.toLowerCase()` — i.e. a note NAME folded for
// comparison WITHOUT going through `foldName`/`foldKey` (which add the required
// `.normalize("NFC")`). A new such site fails CI; the author must route it
// through `foldName`.

import { readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { foldName } from "../src/name-fold.js";

const repoRoot = path.resolve(__dirname, "..");
const srcDir = path.join(repoRoot, "src");

/** Recursively collect every `.ts` file under src/. */
function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collectTsFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** Strip `//` line comments (cheap; avoids flagging examples in comments). */
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
 * Pure detector — returns the unfolded-name-comparison sites in a source string.
 * Kept as a standalone function so the NEGATIVE control can prove it isn't vacuous.
 */
function findUnfoldedNameComparisons(source: string): string[] {
  const code = stripLineComments(source);
  const hits: string[] = [];
  // A: extension-strip then lowercase (no NFC in the chain).
  const extStrip = /\.replace\(\s*\/\\\.(?:md|base)\$\/i\s*,\s*""\s*\)\s*\.toLowerCase\(\)/g;
  // B: stripMd / stripMdExt then lowercase.
  const stripFn = /stripMd(?:Ext)?\([^)]*\)\s*\.toLowerCase\(\)/g;
  for (const re of [extStrip, stripFn]) {
    for (const m of code.matchAll(re)) hits.push(m[0]);
  }
  return hits;
}

describe("name-fold — foldName Unicode correctness (rc.46)", () => {
  // Built with explicit \u escapes so the bytes are deterministic regardless of
  // how this file is saved/normalized on disk. The name is "cafe" + acute accent.
  const nfc = `caf${String.fromCodePoint(0xe9)}`; // precomposed e-acute (U+00E9), NFC
  const nfd = `cafe${String.fromCodePoint(0x301)}`; // e + combining acute (U+0301), NFD (macOS APFS)

  it("folds NFC and NFD forms of the same accented name to one key (POSITIVE)", () => {
    expect(nfc).not.toBe(nfd); // raw strings differ
    expect(nfc.toLowerCase()).not.toBe(nfd.toLowerCase()); // .toLowerCase() alone does NOT fix it
    expect(foldName(nfc)).toBe(foldName(nfd)); // foldName resolves them
  });

  it("case-folds and preserves ASCII (POSITIVE/regression)", () => {
    expect(foldName("README")).toBe("readme");
    expect(foldName("My Note")).toBe("my note");
  });

  it("normalizes Unicode form WITHOUT stripping diacritics (NEGATIVE control on over-folding)", () => {
    // We want NFC==NFD, NOT accent-insensitivity: the accented name must NOT fold to ASCII "cafe".
    expect(foldName(nfd)).not.toBe("cafe");
    expect(foldName(nfd)).toBe(nfc); // NFD input → NFC precomposed output
  });
});

describe("name-fold inventory invariant (rc.46)", () => {
  it("no src/ site strips a note extension + lowercases WITHOUT NFC folding (POSITIVE — the class gate)", () => {
    const offenders: string[] = [];
    for (const file of collectTsFiles(srcDir)) {
      const hits = findUnfoldedNameComparisons(readFileSync(file, "utf8"));
      for (const h of hits) offenders.push(`${path.relative(repoRoot, file)}: ${h}`);
    }
    expect(offenders, `Unfolded name comparisons (route through foldName/foldKey):\n${offenders.join("\n")}`).toEqual(
      []
    );
  });

  it("detector flags the bug signature so the gate is not vacuous (NEGATIVE control)", () => {
    // The exact shapes rc.46 fixed — each MUST be caught by the detector.
    expect(findUnfoldedNameComparisons(`const k = e.basename.replace(/\\.md$/i, "").toLowerCase();`)).toHaveLength(1);
    expect(findUnfoldedNameComparisons(`const k = stripMd(e.basename).toLowerCase();`)).toHaveLength(1);
    expect(findUnfoldedNameComparisons(`const k = stripMdExt(title).toLowerCase();`)).toHaveLength(1);
    // The CORRECT, folded form must NOT be flagged (no false positive).
    expect(findUnfoldedNameComparisons(`const k = foldName(stripMd(e.basename));`)).toHaveLength(0);
    expect(findUnfoldedNameComparisons(`const k = foldName(e.basename.replace(/\\.md$/i, ""));`)).toHaveLength(0);
  });
});
