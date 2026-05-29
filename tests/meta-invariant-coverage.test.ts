// v3.8.0-rc.16 — META-invariant: every `*-invariant.test.ts` file MUST
// have NEGATIVE control coverage.
//
// Background. CLAUDE.md rule since v3.6.4:
//   "Invariant test without negative-control — a test that ALWAYS passes
//   proves nothing. Every new invariant test must have a sibling test
//   that fails when the invariant is violated."
//
// Through the v3.6.x → v3.8.0 cascade I documented 10 overclaim instances,
// of which 6 specifically violated this rule (v3.6.2 K-1 "all 10 callsites"
// without sibling fixture, v3.7.10 D4 examples/ claim, v3.7.14 F1+F2 TSDoc
// drift within same patch, v3.8.0-rc.14 M-2 — 7 invariants without
// NEGATIVE controls). Each time I rediscovered the rule and re-applied it
// manually. The cycle repeats because the rule has no STRUCTURAL ENFORCER.
//
// This META-invariant is the structural enforcer. It scans every file
// matching `tests/*-invariant.test.ts` (the naming convention for true
// structural invariants in this repo) and asserts at least one of:
//   (a) the file contains the literal token `NEGATIVE` (case-sensitive,
//       per the existing convention used in 4 of 4 invariant files that
//       have NEGATIVE coverage)
//   (b) the file has a `// META-INVARIANT-EXEMPT: <reason>` marker at
//       the top, citing the sibling file(s) that provide the negative
//       control coverage
//
// Without this, the recursion class (rule violated inside the patch that
// implements the rule's class fix) is structurally impossible going
// forward — adding a new `*-invariant.test.ts` file without NEGATIVE
// coverage fails CI before merge.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "..");

// v3.9.0-rc.23 (full-audit batch 3) — STRUCTURAL invariant files that aren't
// named `*-invariant.test.ts`. The rc.21 audit found the `*-invariant.test.ts`
// glob silently excluded real structural invariants (no-internal-imports, lint
// — 0 negative controls), and even excluded this meta file itself. They're now
// scanned too, so a structural invariant can't dodge the rule by its filename.
const EXTRA_STRUCTURAL_FILES = [
  "docs-consistency.test.ts",
  "cli-parity.test.ts",
  "lint.test.ts",
  "no-internal-imports.test.ts",
  "meta-invariant-coverage.test.ts",
  // v3.9.0-rc.26 (rc.25-audit LOW-1) — two more invariant-SHAPED tests that
  // assert source/state against a canonical value but aren't named
  // `*-invariant.test.ts`, so they escaped the glob. Both already carry a real
  // NEGATIVE control (k1-version-stamp drives `scanK1Stamps` on a bad fixture;
  // jsonld has an empty-answer control) — listing them keeps the meta-invariant
  // watching that those controls don't rot.
  "k1-version-stamp-consistency.test.ts",
  "jsonld.test.ts"
];

/** Discover all structural-invariant test files: every `*-invariant.test.ts`
 *  (recursive) plus the curated EXTRA_STRUCTURAL_FILES. */
async function collectInvariantTestFiles(): Promise<string[]> {
  const out = new Set<string>();
  async function walk(dir: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.name.endsWith("-invariant.test.ts")) out.add(full);
    }
  }
  await walk(path.join(repoRoot, "tests"));
  for (const name of EXTRA_STRUCTURAL_FILES) {
    const full = path.join(repoRoot, "tests", name);
    try {
      await fs.access(full);
      out.add(full);
    } catch {
      // file renamed/removed — the main test's count assertion will notice.
    }
  }
  return [...out].sort();
}

/** Pure check: invariant file has NEGATIVE coverage OR explicit exemption.
 *  Returns null on OK, error string on violation.
 *
 *  v3.9.0-rc.23: path (a) now requires the NEGATIVE token inside an actual
 *  test DECLARATION (`it`/`test`/`describe` title) — a real inline negative
 *  control — NOT merely anywhere in the file. The rc.21 audit reproduced the
 *  old bypass: a file whose only token was a comment/TODO (e.g.
 *  `// TODO: add negative-control later`) trivially satisfied "token anywhere".
 *  Files whose coverage genuinely lives in sibling files, or that delegate to
 *  an external tool (lint→biome), use the explicit EXEMPT marker (path b). */
/**
 * Strip comments so a COMMENTED-OUT negative control can't satisfy the rule.
 * Removes block comments, then any line whose first non-whitespace is `//`
 * (conservative — a trailing `// ...` after code, or `//` inside a string, is
 * left alone; the bypass we close is a full-line `// it("NEGATIVE"…)`).
 * @internal v3.9.0-rc.26 (closes the rc.25-audit HIGH-1 commented-out bypass).
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

/**
 * From the `it(`/`test(`/`describe(` whose token is at `startIndex`, return the
 * source of its callback body (balanced braces from the first `{` after the
 * opening). Empty string if no `{` body is found (an arrow with an expression
 * body, e.g. `it("x", () => expect(...))`, returns "" — handled by the caller's
 * fallback assertion scan).
 * @internal v3.9.0-rc.26.
 */
function callbackBody(code: string, startIndex: number): string {
  const open = code.indexOf("{", startIndex);
  if (open === -1) return "";
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return code.slice(open, i + 1);
    }
  }
  return code.slice(open); // unbalanced (truncated) — return the rest
}

const ASSERTION_RE =
  /\b(?:expect|assert)\s*\(|\.(?:toBe|toEqual|toStrictEqual|toThrow|toMatch|toContain|toHaveLength|toBeGreaterThan|toBeLessThan|toBeNull|toBeDefined|rejects|resolves|fail)\b/;

function checkInvariantHasNegativeCoverage(filename: string, content: string): string | null {
  // Path (a): an INLINE negative-control TEST — the token inside an
  // it()/test()/describe() title, whose CALLBACK BODY actually asserts. Repo
  // convention is mixed-case ("NEGATIVE" / "negative-control"); accept both.
  // v3.9.0-rc.26 (rc.25-audit HIGH-1): comments are stripped first (a
  // commented-out test no longer counts) AND the matched test's body must
  // contain an assertion (an empty-body `it("NEGATIVE", () => {})` no longer
  // counts — that vacuity is exactly what this META-invariant exists to forbid).
  const code = stripComments(content);
  const titleRe = /\b(?:it|test|describe)\s*\(\s*(["'`])[^"'`]*(?:NEGATIVE|negative[-_]control)[^"'`]*\1/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard exec-loop idiom
  while ((m = titleRe.exec(code)) !== null) {
    const body = callbackBody(code, m.index);
    // A `{ }` body must assert; an expression-bodied arrow (no `{`) is accepted
    // (it IS an assertion, e.g. `() => expect(fn()).toThrow()`).
    if (body === "" || ASSERTION_RE.test(body)) return null;
  }

  // Path (b): explicit exempt marker citing siblings / delegation. Format:
  //   // META-INVARIANT-EXEMPT: <reason>
  // Must appear in the first 50 lines (header section).
  const headerLines = content.split("\n").slice(0, 50).join("\n");
  if (/\/\/\s*META-INVARIANT-EXEMPT:/.test(headerLines)) return null;

  return (
    `${filename} has no INLINE NEGATIVE control test and no META-INVARIANT-EXEMPT marker. ` +
    `Add either: (a) a negative-control test whose it()/describe() TITLE contains "NEGATIVE" ` +
    `(a test that drives the invariant logic with intentionally-drifted input and asserts the ` +
    `violation IS detected), OR (b) a "// META-INVARIANT-EXEMPT: <reason>" comment in the first ` +
    `50 lines citing the sibling file(s) that provide coverage (a bare comment mentioning ` +
    `"negative" no longer counts — see the rc.21 audit).`
  );
}

describe("META-invariant: NEGATIVE control coverage for every *-invariant.test.ts (v3.8.0-rc.16)", () => {
  it("every *-invariant.test.ts file has NEGATIVE control OR explicit exempt marker", async () => {
    const files = await collectInvariantTestFiles();
    expect(
      files.length,
      "expected ≥ 11 structural-invariant files (*-invariant.test.ts + curated EXTRA_STRUCTURAL_FILES)"
    ).toBeGreaterThanOrEqual(11);

    const violations: string[] = [];
    for (const file of files) {
      const rel = path.relative(repoRoot, file);
      const content = await fs.readFile(file, "utf8");
      const err = checkInvariantHasNegativeCoverage(rel, content);
      if (err) violations.push(err);
    }
    expect(violations, violations.join("\n\n")).toEqual([]);
  });

  // NEGATIVE control for the META-invariant itself (eats its own dog food).
  // Without these, the check above could trivially pass against a regex bug.

  it("NEGATIVE: checkInvariantHasNegativeCoverage detects file with no coverage", () => {
    const fakeContent = `// just regular code\nimport { describe } from "vitest";\ndescribe("foo", () => {});`;
    const err = checkInvariantHasNegativeCoverage("fake-invariant.test.ts", fakeContent);
    expect(err).toMatch(/no INLINE NEGATIVE control test/);
  });

  it("NEGATIVE: a comment/TODO token with no inline test is REJECTED (rc.23 — closes the audit bypass)", () => {
    // The exact bypass the rc.21 audit reproduced: token only in an aspirational
    // comment, plus a vacuous test. Must NOT satisfy the rule anymore.
    const todoOnly = `// TODO: add a negative-control test later\nit("does a thing", () => { expect(1).toBeGreaterThan(0); });`;
    expect(checkInvariantHasNegativeCoverage("x-invariant.test.ts", todoOnly)).toMatch(
      /no INLINE NEGATIVE control test/
    );
    // And a "covered by sibling" prose comment alone (no inline test, no marker) is also rejected —
    // such files must use the explicit EXEMPT marker (path b), which is unambiguous.
    const proseOnly = `// NEGATIVE control coverage lives in a sibling file\nit("checks", () => { expect(2).toBe(2); });`;
    expect(checkInvariantHasNegativeCoverage("y-invariant.test.ts", proseOnly)).toMatch(/META-INVARIANT-EXEMPT/);
  });

  it("NEGATIVE: checkInvariantHasNegativeCoverage accepts file with NEGATIVE token + asserting body (uppercase)", () => {
    const goodContent = `// has coverage\nit("NEGATIVE: catches drift", () => { expect(check("bad")).toMatch(/x/); });`;
    expect(checkInvariantHasNegativeCoverage("good-invariant.test.ts", goodContent)).toBeNull();
  });

  it("NEGATIVE: checkInvariantHasNegativeCoverage accepts negative-control describe with asserting nested test (hyphenated)", () => {
    const goodContent = `// has coverage\ndescribe("foo — negative-control via fixtures", () => { it("flags drift", () => { expect(run()).toBe(false); }); });`;
    expect(checkInvariantHasNegativeCoverage("good-invariant.test.ts", goodContent)).toBeNull();
  });

  it("NEGATIVE: an EMPTY-body negative control is REJECTED (rc.26 — closes the vacuity bypass)", () => {
    // The HIGH-1 gap the rc.25 audit found: a title with the token but a body
    // that asserts NOTHING is vacuous — the exact thing this META-invariant forbids.
    const emptyBody = `// header\nit("NEGATIVE: catches drift", () => {});`;
    expect(checkInvariantHasNegativeCoverage("empty-invariant.test.ts", emptyBody)).toMatch(
      /no INLINE NEGATIVE control test/
    );
  });

  it("NEGATIVE: a COMMENTED-OUT negative control is REJECTED (rc.26 — comments stripped first)", () => {
    // A full-line-commented test must not satisfy the rule even though its text
    // contains both the token and an assertion.
    const commentedOut = `// it("NEGATIVE: catches drift", () => { expect(x).toBe(1); });\nit("real", () => { expect(2).toBe(2); });`;
    expect(checkInvariantHasNegativeCoverage("commented-invariant.test.ts", commentedOut)).toMatch(
      /no INLINE NEGATIVE control test/
    );
  });

  it("NEGATIVE: an expression-bodied arrow negative control is accepted (no `{` body)", () => {
    // `() => expect(...)` IS an assertion — accept it (don't require a brace body).
    const exprBody = `// header\nit("NEGATIVE: rejects bad input", () => expect(() => parse("bad")).toThrow());`;
    expect(checkInvariantHasNegativeCoverage("expr-invariant.test.ts", exprBody)).toBeNull();
  });

  it("NEGATIVE: checkInvariantHasNegativeCoverage accepts explicit exempt marker", () => {
    const exemptContent = `// header\n// META-INVARIANT-EXEMPT: covered by sibling file foo-invariant.test.ts\nimport ...`;
    expect(checkInvariantHasNegativeCoverage("exempt-invariant.test.ts", exemptContent)).toBeNull();
  });

  it("NEGATIVE: exempt marker outside first 50 lines does NOT count", () => {
    const tooLate = `${Array(55).fill("// filler").join("\n")}\n// META-INVARIANT-EXEMPT: too late\n`;
    const err = checkInvariantHasNegativeCoverage("late-marker-invariant.test.ts", tooLate);
    expect(err).toMatch(/no INLINE NEGATIVE control test/);
  });
});
