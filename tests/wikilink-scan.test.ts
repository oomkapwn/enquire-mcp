// v3.11.0-rc.17 (rc.16 re-audit, HIGH ReDoS) — the wikilink/embed extraction
// regexes /(?<!!)\[\[([^\]\n]+?)\]\]/g and /!\[\[([^\]\n]+?)\]\]/g were O(n²) on
// an unclosed `[[`-run (the lazy `[^\]\n]+?` rescans to EOF for `]]` at every
// `[[` start). Reachable via the always-on `obsidian_read_note` → `parseNote`
// over adversarial note CONTENT = a bearer-reachable serve-http event-loop hang.
// Replaced by the linear non-backtracking `scanWikilinkInners` (parser.ts).
//
// DIFFERENTIAL: the scanner is byte-equivalent to the old regexes' `m[1]` sequence
// over a broad corpus (the rc.71 method — prove behavior-preservation vs the
// incumbent before trusting the replacement).
// TIMING: linear on the catastrophic shape; a NEGATIVE control proves the OLD
// regex is quadratic on the same input (so the timing assertion discriminates).
// STATIC GUARD: no src/ code reintroduces the lazy `[^\]\n]+?]]` wikilink shape.

import { readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractEmbeds, extractWikilinks, scanWikilinkInners } from "../src/parser.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function ms(fn: () => void): number {
  const a = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - a) / 1e6;
}

// Inlined copies of the PRE-rc.17 regexes — the differential reference.
function oldInners(text: string, embed: boolean): string[] {
  const re = embed ? /!\[\[([^\]\n]+?)\]\]/g : /(?<!!)\[\[([^\]\n]+?)\]\]/g;
  const out: string[] = [];
  for (const m of text.matchAll(re)) if (m[1] !== undefined) out.push(m[1]);
  return out;
}

const CORPUS = [
  "",
  "no links here",
  "[[Simple]]",
  "[[A]] and [[B]] and [[C]]",
  "[[Note|alias]]",
  "[[Note#Section]]",
  "[[Note^block]]",
  "[[Note#Sec|Alias]]",
  "![[embed.png]]",
  "text ![[a]] then [[b]] mixed",
  "!![[x]]", // preceding `!` → embed, not wikilink
  "[[[triple]]", // inner becomes `[triple`
  "[[[]]", // inner `[`
  "[[]]", // empty inner → no match
  "[[]x", // empty + lone bracket
  "[[unclosed run [[ [[ [[", // no closing — must be O(n) AND yield nothing
  "[[a]b]]", // lone `]` inside → no valid close at the first `]`
  "[[a]]b]]", // first closes at `a`
  "[[multi\nline]]", // newline inside → no match (inner excludes \n)
  "line1 [[ok]]\n[[ok2]] line2",
  "trailing [[",
  "]] orphan close",
  "[[a]][[b]]", // adjacent
  "中文 [[笔记]] кириллица [[Заметка]] 😀 [[Emoji]]",
  "[[ spaced inner ]]",
  "![[a]]![[b]]" // adjacent embeds
];

describe("wikilink/embed scanner (rc.17) — differential vs the pre-rc.17 regexes", () => {
  it("scanWikilinkInners(false) ≡ old wikilink regex m[1] over the corpus (POSITIVE)", () => {
    for (const t of CORPUS) {
      expect(scanWikilinkInners(t, false), `wikilink mismatch for ${JSON.stringify(t)}`).toEqual(oldInners(t, false));
    }
  });

  it("scanWikilinkInners(true) ≡ old embed regex m[1] over the corpus (POSITIVE)", () => {
    for (const t of CORPUS) {
      expect(scanWikilinkInners(t, true), `embed mismatch for ${JSON.stringify(t)}`).toEqual(oldInners(t, true));
    }
  });

  it("extractWikilinks / extractEmbeds still parse alias/section/block (downstream unchanged)", () => {
    const wl = extractWikilinks("[[Note#Sec|Alias]] and ![[skip]]");
    expect(wl).toHaveLength(1);
    expect(wl[0]).toMatchObject({ target: "Note", section: "Sec", alias: "Alias" });
    const em = extractEmbeds("![[image.png]] and [[skip]]");
    expect(em.map((e) => e.target)).toEqual(["image.png"]);
  });
});

describe("wikilink scanner (rc.17) — linear time on the catastrophic shape", () => {
  it("scanWikilinkInners stays O(n) on a 2 MB unclosed `[[`-run (POSITIVE — <100 ms)", () => {
    const evil = "[".repeat(2_000_000); // no closing `]]` → the worst case
    let res: string[] = [];
    const t = ms(() => {
      res = scanWikilinkInners(evil, false);
    });
    expect(res).toEqual([]);
    expect(t).toBeLessThan(100);
  });

  it("the OLD regex IS quadratic on the same shape (NEGATIVE control — proves the timing test discriminates)", () => {
    const evil = "[".repeat(40_000) + "x";
    const linear = ms(() => scanWikilinkInners(evil, false));
    const quad = ms(() => oldInners(evil, false));
    expect(linear).toBeLessThan(20); // the fix is fast …
    expect(quad).toBeGreaterThan(150); // … while the old lazy-quantifier regex is quadratic even at 40k
  });
});

describe("wikilink scanner (rc.17) — class guard: no lazy `[^\\]\\n]+?]]` wikilink regex in src/", () => {
  // The polynomial shape, scoped to src/ CODE (doc-comments in parser.ts legitimately
  // name the old regex). The de-dup also closes the rc.10 INLINE_TAG_RE copy-class
  // (the byte-identical hand-copy formerly at meta.ts:179).
  const LAZY = /\[\^\\\]\\n\]\+\?/; // matches the literal `[^\]\n]+?` token in source

  function tsFiles(dir: string): string[] {
    const out: string[] = [];
    for (const e of readdirSync(dir)) {
      const p = path.join(dir, e);
      if (statSync(p).isDirectory()) out.push(...tsFiles(p));
      else if (e.endsWith(".ts")) out.push(p);
    }
    return out;
  }

  it("no src/ code line reintroduces the lazy wikilink/embed quantifier (POSITIVE)", () => {
    const offenders: string[] = [];
    for (const f of tsFiles(path.join(repoRoot, "src"))) {
      for (const [i, line] of readFileSync(f, "utf8").split("\n").entries()) {
        const t = line.trimStart();
        if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue; // skip comments
        if (LAZY.test(line)) offenders.push(`${path.relative(repoRoot, f)}:${i + 1}: ${line.trim()}`);
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("the class detector actually fires on the pre-rc.17 shape (NEGATIVE control)", () => {
    expect("const WIKILINK_RE = /(?<!!)\\[\\[([^\\]\\n]+?)\\]\\]/g;").toMatch(LAZY);
    expect("scanWikilinkInners(text, false)").not.toMatch(LAZY);
  });
});
