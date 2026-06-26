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
  // v3.11.0-rc.20 — these wall-clock timing tests flaked the rc.19 release (a loaded CI
  // runner missed a tight absolute `<150ms` budget). Hardened: the big-input POSITIVE uses a
  // GENEROUS absolute ceiling (the op is ~14 ms; the quadratic would be ~8 s, so a 2000 ms
  // ceiling can't be tripped by load yet still fails on a re-introduced O(n²)), and the
  // NEGATIVE control is a RATIO (old/new ≥ N×) — environment-INDEPENDENT, since both run on
  // the same runner so absolute speed cancels out (the rc.25 generative-fuzz robustness move).
  it("scanWikilinkInners stays O(n) on a 2 MB unclosed `[[`-run (POSITIVE — generous ceiling)", () => {
    const evil = "[".repeat(2_000_000); // no closing `]]` → the worst case
    let res: string[] = [];
    const t = ms(() => {
      res = scanWikilinkInners(evil, false);
    });
    expect(res).toEqual([]);
    expect(t).toBeLessThan(2000); // ~sub-ms actual; an O(n²) regression would be many seconds
  });

  it("the OLD regex IS quadratic on the same shape (NEGATIVE control — FLOOR on the old time)", () => {
    const evil = `${"[".repeat(40_000)}x`;
    const quad = ms(() => oldInners(evil, false));
    // v3.11.0-rc.22 — absolute FLOOR on the OLD catastrophic time, NOT a ratio. The rc.20
    // `quad/linear > 8` form flaked on CI (measured 7.50 < 8) because the `linear` denominator
    // is a sub-ms op whose wall-clock is noise-dominated on a contended runner (read ~43 ms vs
    // ~2.5 ms locally). The OLD lazy-quantifier regex is ~430 ms here on a dev laptop and a CI
    // runner is only SLOWER — so a 50 ms floor can only fail if the runner ran the quadratic 8×
    // FASTER than a laptop (impossible). Load pushes the quad UP, never below the floor.
    expect(quad).toBeGreaterThan(50);
  });
});

// The pre-rc.18 scanner bounded the `]`/`[[` scans but used an UNBOUNDED
// `text.indexOf("\n", innerStart)` — so on a DENSE run of closed `[[a]]` links
// with no newline (a real single-line MOC/index note), the `\n` search rescanned
// to EOF every iteration → O(n²) (400k links = 8.2s; ~50s at the 5 MB cap,
// bearer-reachable via the always-on obsidian_read_note → parseNote). The rc.17
// timing test only exercised the UNCLOSED-`[[`-run shape, so this regression slipped
// through (the recurring rc.36/rc.54 "the corpus can't produce the failing shape").
// Inlined as the NEGATIVE control to prove the new bounded-window scan discriminates.
function rc17UnboundedNlScan(text: string): number {
  let from = 0;
  let count = 0;
  for (;;) {
    const open = text.indexOf("[[", from);
    if (open < 0) break;
    const innerStart = open + 2;
    const bracket = text.indexOf("]", innerStart);
    if (bracket < 0) break;
    const nl = text.indexOf("\n", innerStart); // UNBOUNDED — the rc.17 regression
    if (nl >= 0 && nl < bracket) {
      from = nl + 1;
      continue;
    }
    if (bracket === innerStart) {
      from = open + 1;
      continue;
    }
    if (text.charCodeAt(bracket + 1) === 93) {
      count += 1;
      from = bracket + 2;
    } else {
      from = bracket + 1;
    }
  }
  return count;
}

describe("wikilink scanner (rc.18) — linear on a DENSE closed `[[a]]`-run (the rc.17 regression)", () => {
  // rc.20 — generous absolute ceiling for the big POSITIVE + RATIO NEGATIVE (see the rc.17 note above).
  it("scanWikilinkInners stays O(n) on a 2 MB dense `[[a]]` run, no newlines (POSITIVE — generous ceiling)", () => {
    const evil = "[[a]]".repeat(400_000); // 2 MB, 400k closed links, no `\n` — MOC/index-note shape
    let res: string[] = [];
    const t = ms(() => {
      res = scanWikilinkInners(evil, false);
    });
    expect(res).toHaveLength(400_000);
    expect(t).toBeLessThan(2000); // ~14 ms actual; the pre-rc.18 unbounded-`\n` form was ~8 s here
  });

  it("the pre-rc.18 unbounded-`\\n` scan IS quadratic on the same shape (NEGATIVE control — FLOOR)", () => {
    const evil = "[[a]]".repeat(80_000); // 400k chars; the unbounded form is quadratic here
    const quad = ms(() => rc17UnboundedNlScan(evil));
    // rc.22 — absolute floor, not a ratio (see the rc.17 NEGATIVE note above). The unbounded-`\n`
    // scan is ~325 ms here on a laptop; CI is slower, so 50 ms can only fail at 6× laptop speed.
    expect(quad).toBeGreaterThan(50);
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
