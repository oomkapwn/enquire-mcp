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
import { foldName, foldTag, lookupFoldedKey, nfc } from "../src/name-fold.js";
import { extractInlineTags } from "../src/parser.js";

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

/**
 * v3.11.0-rc.9 (external re-audit L-TAG-1) — the TAG sibling of the detector above.
 * The rc.46 inventory invariant was scoped to the NOTE-NAME signature
 * (extension-strip / stripMd then `.toLowerCase()`); TAG normalization uses a
 * DIFFERENT shape — a leading-`#` strip then `.toLowerCase()` (either ordering) —
 * so the whole tag identity surface (~13 sites) was structurally invisible to it,
 * which is exactly why an external auditor (not a gate) had to find the NFC-blind
 * tag comparisons. This detector flags the `#`-strip-then-lowercase tag-fold
 * signature lacking NFC; every tag comparison must route through `foldTag`
 * (which adds `.normalize("NFC")`). NB: the parser PRODUCER (`nfc(t.replace(/^#+/,""))`,
 * NFC without lowercase — display case preserved) is intentionally NOT this shape.
 */
function findUnfoldedTagComparisons(source: string): string[] {
  const code = stripLineComments(source);
  const hits: string[] = [];
  // A: `#`-strip then lowercase — `.replace(/^#+/, "").toLowerCase()`.
  const stripThenLower = /\.replace\(\s*\/\^#\+?\/[a-z]*\s*,\s*""\s*\)\s*\.toLowerCase\(\)/g;
  // B: lowercase then `#`-strip — `.toLowerCase().replace(/^#/, "")` (the bases ordering).
  const lowerThenStrip = /\.toLowerCase\(\)\s*\.replace\(\s*\/\^#\+?\/[a-z]*\s*,\s*""\s*\)/g;
  for (const re of [stripThenLower, lowerThenStrip]) {
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

  // v3.10.0-rc.66 (round-3 audit) — the graph-boost in-degree membership test in searchHybrid was
  // the ONE name-comparison site the rc.46 detector couldn't catch: it used `stripMd(wl.target)`
  // WITHOUT `.toLowerCase()` (a case-SENSITIVE raw compare), so the strip+lowercase signature
  // never matched it, yet it still mis-resolved accented names (NFC wikilink vs NFD candidate path
  // on macOS). Now folded through `foldName`. Pin that specific block (separate assertion, mirrors
  // the resource-bound queryBase/buildWikilinkGraph pattern) so a regression dropping the fold
  // there fails CI even though the generic detector's signature doesn't reach it.
  it("searchHybrid graph-boost folds wikilink targets + candidate keys through foldName (rc.66)", () => {
    const src = stripLineComments(readFileSync(path.join(srcDir, "tools/search.ts"), "utf8"));
    // The folded membership shape MUST be present on both the build side and the lookup side.
    expect(src, "graph-boost must fold wikilink targets").toContain("foldName(stripMd(wl.target))");
    expect(src, "graph-boost must fold the candidate path key").toContain("foldName(stripMd(fPath))");
    // NEGATIVE: the pre-rc.66 unfolded membership shapes must be GONE.
    expect(src, "no unfolded targets.add(stripMd(wl.target))").not.toMatch(/targets\.add\(stripMd\(wl\.target\)\)/);
    expect(src, "no unfolded targets.has(stripMd(fPath))").not.toMatch(/targets\.has\(stripMd\(fPath\)\)/);
  });
});

describe("name-fold — foldTag / nfc Unicode correctness (rc.9, L-TAG-1)", () => {
  const nfc4 = `caf${String.fromCodePoint(0xe9)}`; // precomposed é (NFC)
  const nfd4 = `cafe${String.fromCodePoint(0x301)}`; // e + combining acute (NFD)

  it("foldTag strips `#`, NFC-folds, and case-folds — NFC and NFD tag forms collapse to one key (POSITIVE)", () => {
    expect(nfc4).not.toBe(nfd4);
    expect(`#${nfc4}`.replace(/^#+/, "").toLowerCase()).not.toBe(`${nfd4}`.toLowerCase()); // strip+lower alone fails
    expect(foldTag(`#${nfc4}`)).toBe(foldTag(nfd4)); // foldTag resolves them
    expect(foldTag("#Draft")).toBe("draft"); // strips # + lowercases (ASCII regression)
    expect(foldTag("##Idea")).toBe("idea"); // multiple leading #
  });

  it("foldTag does NOT strip diacritics — accented tag folds to NFC, not ASCII (NEGATIVE control on over-folding)", () => {
    expect(foldTag(`#${nfd4}`)).not.toBe("cafe");
    expect(foldTag(`#${nfd4}`)).toBe(nfc4.toLowerCase());
  });

  it("nfc normalizes Unicode form but PRESERVES case (for Bases case-sensitive value compares)", () => {
    expect(nfc(nfd4)).toBe(nfc4); // NFD → NFC
    expect(nfc("Café")).not.toBe(nfc("café")); // case preserved — Café ≠ café
  });
});

describe("name-fold inventory invariant — TAG surface (rc.9, L-TAG-1)", () => {
  it("no src/ site folds a tag via `#`-strip + lowercase WITHOUT NFC (POSITIVE — the class gate)", () => {
    const offenders: string[] = [];
    for (const file of collectTsFiles(srcDir)) {
      const hits = findUnfoldedTagComparisons(readFileSync(file, "utf8"));
      for (const h of hits) offenders.push(`${path.relative(repoRoot, file)}: ${h}`);
    }
    expect(offenders, `Unfolded tag comparisons (route through foldTag):\n${offenders.join("\n")}`).toEqual([]);
  });

  it("tag detector flags the bug signature in both orderings so the gate is not vacuous (NEGATIVE control)", () => {
    // The exact pre-rc.9 shapes (parser/meta/read/write/bases) — each MUST be caught.
    expect(findUnfoldedTagComparisons(`return t.replace(/^#+/, "").toLowerCase();`)).toHaveLength(1);
    expect(findUnfoldedTagComparisons(`const tag = (x ?? "").toLowerCase().replace(/^#/, "");`)).toHaveLength(1);
    // The CORRECT, folded form must NOT be flagged (no false positive).
    expect(findUnfoldedTagComparisons(`return foldTag(t);`)).toHaveLength(0);
    // The parser PRODUCER (NFC without lowercase, display case preserved) must NOT be flagged.
    expect(findUnfoldedTagComparisons(`return nfc(t.replace(/^#+/, ""));`)).toHaveLength(0);
  });
});

describe("M1 — tag PRODUCER recovers NFD / accented / non-Latin tags (rc.10, external audit)", () => {
  // The rc.9 consumer-side foldTag/nfc could not recover a combining mark the
  // EXTRACTION regex never captured. rc.10 NFC-normalizes the body before matching.
  const nfc4 = `caf${String.fromCodePoint(0xe9)}`; // precomposed é (NFC)
  const nfd4 = `cafe${String.fromCodePoint(0x301)}`; // e + combining acute (NFD on macOS APFS)

  it("extractInlineTags recovers an NFD inline tag instead of truncating at the mark (POSITIVE — the bug)", () => {
    expect(nfc4).not.toBe(nfd4);
    expect(extractInlineTags(`see #${nfd4} here`), "NFD #café must extract café, not cafe").toEqual([nfc4]);
    expect(extractInlineTags(`see #${nfc4} here`)).toEqual([nfc4]); // NFC unchanged
  });

  it("extractInlineTags extracts non-Latin inline tags (POSITIVE)", () => {
    expect(extractInlineTags("topic #日本語 end")).toEqual(["日本語"]);
    expect(extractInlineTags("see #naïve note".normalize("NFD"))).toEqual(["naïve"]); // NFD ï recovered
  });

  it("no src/ tag-extraction regex is ASCII-only `#[A-Za-z]` (POSITIVE — the producer class gate)", () => {
    // An ASCII-only tag lead drops EVERY non-ASCII inline tag (the pre-rc.10 bases bug).
    // Every tag producer must use `\\p{L}` + the `u` flag (and callers NFC-normalize first).
    const offenders: string[] = [];
    for (const file of collectTsFiles(srcDir)) {
      const code = stripLineComments(readFileSync(file, "utf8"));
      for (const m of code.matchAll(/#\[A-Za-z\]/g)) offenders.push(`${path.relative(repoRoot, file)}: ${m[0]}`);
    }
    expect(offenders, `ASCII-only tag regex (use #[\\p{L}] + u flag):\n${offenders.join("\n")}`).toEqual([]);
  });

  it("the ASCII-only-tag detector fires on the pre-rc.10 shape (NEGATIVE control)", () => {
    const bad = String.raw`for (const m of line.matchAll(/(?:^|\s)(#[A-Za-z][\w/-]*)/g)) {`;
    expect(/#\[A-Za-z\]/.test(bad)).toBe(true);
    expect(/#\[A-Za-z\]/.test(String.raw`/(?:^|[\s([{>])#([\p{L}][\p{L}\p{N}_/-]*)/gu`)).toBe(false);
  });
});

describe("H1 — frontmatter KEY lookup is case/NFC-insensitive (rc.10, external audit)", () => {
  const nfc4 = `Caf${String.fromCodePoint(0xe9)}`; // NFC key
  const nfd4 = `Cafe${String.fromCodePoint(0x301)}`; // NFD key (macOS)

  it("lookupFoldedKey resolves a case-different filter key (POSITIVE)", () => {
    expect(lookupFoldedKey({ status: "active" }, "Status")).toEqual({ present: true, value: "active" });
    expect(lookupFoldedKey({ Status: "active" }, "status")).toEqual({ present: true, value: "active" });
  });

  it("lookupFoldedKey resolves an NFC vs NFD key (POSITIVE)", () => {
    expect(nfc4).not.toBe(nfd4);
    expect(lookupFoldedKey({ [nfd4]: 1 }, nfc4)).toEqual({ present: true, value: 1 });
  });

  it("an EXACT own-key wins; FIRST own-key wins on a fold collision (precedence)", () => {
    // exact match returns the exact key's value even when a fold-sibling exists
    expect(lookupFoldedKey({ Status: "X", status: "y" }, "status")).toEqual({ present: true, value: "y" });
    // neither exact → first own key (insertion order) whose fold matches
    expect(lookupFoldedKey({ Status: "X", status: "y" }, "STATUS")).toEqual({ present: true, value: "X" });
  });

  it("a genuinely-absent key is not present (NEGATIVE control)", () => {
    expect(lookupFoldedKey({ status: "active" }, "author")).toEqual({ present: false, value: undefined });
  });

  // rc.12 (rc.11-audit H-2) — the rc.10 H1 fix wired 6 key-lookup sites but missed a
  // 7th: the `lint_vault_wiki` stale pass read `frontmatter.last_reviewed` by RAW exact
  // string, so a case-variant `Last_Reviewed` key fell back to mtime (wrong staleness).
  // Narrow regression guard (precise — NOT a broad `frontmatter.<ident>` detector, which
  // would over-flag legitimate raw reads; see rc.11-audit L-4 verdict): the stale-pass
  // key read in meta.ts must route through `lookupFoldedKey`, never raw `.last_reviewed`.
  // The regex targets the `parsed.frontmatter?.<key>` ACCESS shape (the actual bug),
  // NOT the bare label string `"frontmatter.last_reviewed"` the tool emits in its output
  // (no `parsed.` prefix), so the legit output label doesn't false-positive.
  const RAW_REVIEW_ACCESS = /parsed\.frontmatter\??\.\s*last_reviewed/;
  const RAW_REVIEW_BRACKET = /parsed\.frontmatter\??\.\s*\[\s*["']last-reviewed["']\s*\]/;
  it("meta.ts reads the staleness key via lookupFoldedKey, not a raw frontmatter.last_reviewed (POSITIVE)", () => {
    const meta = readFileSync(path.join(repoRoot, "src/tools/meta.ts"), "utf8");
    expect(meta).not.toMatch(RAW_REVIEW_ACCESS);
    expect(meta).not.toMatch(RAW_REVIEW_BRACKET);
    // …and the folded helper must be the path used for the review key.
    expect(meta).toMatch(/lookupFoldedKey\([^)]*"last_reviewed"\)/);
  });

  it("the raw-read regression detector actually fires on the pre-rc.12 anti-pattern (NEGATIVE control)", () => {
    const buggy = 'const x = parsed.frontmatter?.last_reviewed ?? parsed.frontmatter?.["last-reviewed"];';
    expect(buggy).toMatch(RAW_REVIEW_ACCESS);
    expect(buggy).toMatch(RAW_REVIEW_BRACKET);
    // the bare output-label string must NOT trip the detector (it has no `parsed.` access)
    expect('source: "frontmatter.last_reviewed"').not.toMatch(RAW_REVIEW_ACCESS);
  });
});

describe("frontmatter-key PRODUCER fold guard (rc.13, rc.12-audit AUD-03 + embed-title sibling)", () => {
  // rc.10/rc.12 folded the CONSUMER (query) frontmatter-key reads; the dual rc.12 audit
  // found the PRODUCER side still read the identity keys raw — `fm.tags ?? fm.tag` (parser/
  // meta/write), `fm.tags` (bases), `frontmatter?.title` (embed-pipeline) — so a case/NFC
  // -variant `Tags:`/`Title:` was invisible to tag retrieval / embedding context. rc.13
  // routes every producer through `lookupFoldedAny`. Narrow static guard (precise anti-
  // pattern strings, NOT a broad `frontmatter.<ident>` detector that would over-flag, per
  // the rc.39 don't-chase-EDA rule): the raw producer shapes must not reappear.
  const PRODUCER_FILES = [
    "src/parser.ts",
    "src/bases.ts",
    "src/tools/meta.ts",
    "src/tools/write.ts",
    "src/embed-pipeline.ts"
  ];
  // `fm.tags ?? fm.tag`, `fmData.tags ?? fmData.tag`, bare `fm.tags;`, `frontmatter?.title`
  const RAW_TAG_OR = /\b[\w.]+\.tags\s*\?\?\s*[\w.]+\.tag\b/;
  const RAW_TITLE = /\bfrontmatter\?\.\s*title\b/;

  it("no producer reads the tags/tag/title KEY raw — all route through lookupFoldedAny (POSITIVE)", () => {
    const offenders: string[] = [];
    for (const rel of PRODUCER_FILES) {
      const src = stripLineComments(readFileSync(path.join(repoRoot, rel), "utf8"));
      if (RAW_TAG_OR.test(src)) offenders.push(`${rel}: raw \`fm.tags ?? fm.tag\``);
      if (RAW_TITLE.test(src)) offenders.push(`${rel}: raw \`frontmatter?.title\``);
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("the raw-producer detector actually fires on the pre-rc.13 shapes (NEGATIVE control)", () => {
    expect("const raw = fm.tags ?? fm.tag;").toMatch(RAW_TAG_OR);
    expect("const t = note.parsed.frontmatter?.title || base;").toMatch(RAW_TITLE);
    // a folded read does NOT trip either detector
    expect('const raw = lookupFoldedAny(fm, ["tags", "tag"]);').not.toMatch(RAW_TAG_OR);
  });
});
