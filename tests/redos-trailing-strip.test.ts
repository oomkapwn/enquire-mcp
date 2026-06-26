// v3.11.0-rc.14 — regression guard for the polynomial-ReDoS class CodeQL flagged
// (js/polynomial-redos #13, HIGH) and the team had been wrongly dismissing as
// "false positive". The `s.replace(/<class>+$/, "")` idiom (trailing slash / newline /
// whitespace / ATX-hash strip) is O(n²) on `<class>×n + <one non-class char>` — the
// anchored `+$` retries from EVERY run position. A 4 MB bearer-reachable `folder` arg
// hung V8 for minutes. The fix is a linear (non-backtracking) strip in wildcard-match.ts.
//
// POSITIVE: the helper is O(n) on the worst-case shape + byte-identical to the old regex.
// NEGATIVE control: an INLINED copy of the old regex is provably slow on the same shape
// (proving the timing assertion is not vacuous).

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  stripSurroundingSlashes,
  stripTrailingHashes,
  stripTrailingNewlines,
  stripTrailingSlashes
} from "../src/wildcard-match.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function ms(fn: () => void): number {
  const a = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - a) / 1e6;
}

describe("ReDoS — trailing-run strips are linear (CodeQL js/polynomial-redos #13)", () => {
  it("stripTrailingSlashes is byte-identical to the old /\\/+$/ regex (POSITIVE — correctness parity)", () => {
    for (const c of ["a/b/", "x///", "////", "", "no-slash", "/lead/trail///", "深/路径//"]) {
      expect(stripTrailingSlashes(c)).toBe(c.replace(/\/+$/, ""));
    }
    expect(stripSurroundingSlashes("///a/b///")).toBe("a/b");
    expect(stripTrailingNewlines("x\n\n\n")).toBe("x");
    expect(stripTrailingHashes("Heading ##")).toBe("Heading ");
  });

  it("stripTrailingSlashes stays O(n) on the catastrophic `/`×n + non-slash shape (POSITIVE — <100ms at 4 MB)", () => {
    const evil = `${"/".repeat(4_000_000)}x`; // the exact shape that hung the regex for minutes
    expect(ms(() => stripTrailingSlashes(evil))).toBeLessThan(100);
  });

  it("the old /\\/+$/ regex IS catastrophic on the same shape (NEGATIVE control — proves the timing test discriminates)", () => {
    const evil = `${"/".repeat(20_000)}x`;
    const linear = ms(() => stripTrailingSlashes(evil));
    const regex = ms(() => evil.replace(/\/+$/, ""));
    expect(linear).toBeLessThan(10); // the fix is fast …
    expect(regex).toBeGreaterThan(40); // … while the old regex is quadratic-slow even at 20k
  });

  it("no folder/body sink still uses a trailing-run `replace(/<class>+$/)` regex (static guard)", () => {
    // The polynomial anti-pattern, scoped to the sinks that were fixed. Doc-comment prose
    // in wildcard-match.ts legitimately names the old pattern, so that file is excluded.
    const SINK_FILES = [
      "src/fts5.ts",
      "src/embed-db.ts",
      "src/periodic.ts",
      "src/tools/search.ts",
      "src/tools/write.ts",
      "src/tools/read.ts"
    ];
    // The polynomial shape is a SINGLE char-class run anchored at end-of-string:
    // `.replace(/<class>+$/...)`. (A leading `^<class>+` is start-anchored → linear; a
    // two-part `#\d+$` fails fast; a global `\s+/g` has no `$` → linear. None match.)
    const ANTI = /\.replace\(\/(?:\\\/|\\n|\\s|#)\+\$\/[gimsuy]*\s*,/;
    const offenders: string[] = [];
    for (const rel of SINK_FILES) {
      const src = readFileSync(path.join(repoRoot, rel), "utf8");
      for (const [i, line] of src.split("\n").entries()) {
        if (line.trimStart().startsWith("//")) continue; // skip comment lines
        if (ANTI.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("the static guard's detector actually fires on the pre-rc.14 anti-pattern (NEGATIVE control)", () => {
    // The polynomial shape is a SINGLE char-class run anchored at end-of-string:
    // `.replace(/<class>+$/...)`. (A leading `^<class>+` is start-anchored → linear; a
    // two-part `#\d+$` fails fast; a global `\s+/g` has no `$` → linear. None match.)
    const ANTI = /\.replace\(\/(?:\\\/|\\n|\\s|#)\+\$\/[gimsuy]*\s*,/;
    // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional — a SAMPLE of source code (a real `${…}` line) matched against the ANTI regex.
    expect('const p = `${opts.folder.replace(/\\/+$/, "")}/`;').toMatch(ANTI);
    expect('body.replace(/\\n+$/, "")').toMatch(ANTI);
    expect("stripTrailingSlashes(opts.folder)").not.toMatch(ANTI); // the fixed form is clean
  });
});

describe("ReDoS — heading-regex class split to fts5's safe form (rc.16, sibling of CodeQL #13)", () => {
  // read.ts:extractHeadings + meta.ts:getOpenQuestions used the SAME combined
  // `/^(#{1,6})\s+(.+?)\s*#*\s*$/` capture that fts5.ts:796 already split for CodeQL
  // js/polynomial-redos. Empirically the combined form is only mildly super-linear in
  // V8 (~12 ms at a 500 KB line, bounded by maxFileBytes — NOT a multi-second DoS),
  // but leaving two siblings unsplit after fts5 split the identical regex is the
  // project's signature "instance fixed, sibling missed". rc.16 split both to
  // `^(#{1,6})\s+(.+)$` + stripTrailingHashes. This guard fails CI if any heading
  // sink reintroduces the combined capture.
  const HEADING_SINKS = ["src/tools/read.ts", "src/tools/meta.ts", "src/fts5.ts"];
  // matches the literal `(.+?)\s*#*\s*$` trailing-strip-inside-the-capture shape
  const COMBINED = /\(\.\+\?\)\\s\*#\*\\s\*\$/;

  it("no heading sink retains the combined (.+?)\\s*#*\\s*$ capture (static guard)", () => {
    const offenders: string[] = [];
    for (const rel of HEADING_SINKS) {
      const src = readFileSync(path.join(repoRoot, rel), "utf8");
      for (const [i, line] of src.split("\n").entries()) {
        if (line.trimStart().startsWith("//") || line.trimStart().startsWith("*")) continue;
        if (COMBINED.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("the static detector fires on the pre-rc.16 combined shape (NEGATIVE control)", () => {
    expect("const m = /^(#{1,6})\\s+(.+?)\\s*#*\\s*$/.exec(line);").toMatch(COMBINED);
    expect("const m = /^(#{1,6})\\s+(.+)$/.exec(ln);").not.toMatch(COMBINED); // the split form is clean
  });

  it("split form is byte-identical to the old combined capture on normal headings (POSITIVE)", () => {
    const OLD = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
    const splitText = (line: string): string => {
      const m = /^(#{1,6})\s+(.+)$/.exec(line);
      return m?.[2] ? stripTrailingHashes(m[2].trim()).trim() : "";
    };
    const oldText = (line: string): string => OLD.exec(line)?.[2] ?? "";
    for (const h of ["# Foo", "## Bar baz", "### a b c", "#### Title ###", "# trailing   ", "## with#hash mid"]) {
      expect(splitText(h), `heading: ${JSON.stringify(h)}`).toBe(oldText(h));
    }
  });

  it("a degenerate ATX-close-only heading yields empty text → skipped (matches fts5; documented edge)", () => {
    const splitText = (line: string): string => {
      const m = /^(#{1,6})\s+(.+)$/.exec(line);
      return m?.[2] ? stripTrailingHashes(m[2].trim()).trim() : "";
    };
    expect(splitText("# ###")).toBe(""); // all-# ATX close → no real text → not emitted
  });
});
