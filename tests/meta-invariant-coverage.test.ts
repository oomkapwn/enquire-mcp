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
  "meta-invariant-coverage.test.ts"
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
function checkInvariantHasNegativeCoverage(filename: string, content: string): string | null {
  // Path (a): an INLINE negative-control TEST — the token inside an
  // it()/test()/describe() title. Repo convention is mixed-case
  // ("NEGATIVE" / "negative-control"); accept both. A bare comment/TODO
  // containing the token no longer counts.
  const inlineNegControl = /\b(?:it|test|describe)\s*\(\s*(["'`])[^"'`]*(?:NEGATIVE|negative[-_]control)/.test(content);
  if (inlineNegControl) return null;

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
      "expected ≥ 9 structural-invariant files (5 *-invariant.test.ts + curated EXTRA_STRUCTURAL_FILES)"
    ).toBeGreaterThanOrEqual(9);

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

  it("NEGATIVE: checkInvariantHasNegativeCoverage accepts file with NEGATIVE token (uppercase)", () => {
    const goodContent = `// has coverage\nit("NEGATIVE: catches drift", () => {});`;
    expect(checkInvariantHasNegativeCoverage("good-invariant.test.ts", goodContent)).toBeNull();
  });

  it("NEGATIVE: checkInvariantHasNegativeCoverage accepts file with negative-control (hyphenated)", () => {
    const goodContent = `// has coverage\ndescribe("foo — negative-control via fixtures", () => {});`;
    expect(checkInvariantHasNegativeCoverage("good-invariant.test.ts", goodContent)).toBeNull();
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
