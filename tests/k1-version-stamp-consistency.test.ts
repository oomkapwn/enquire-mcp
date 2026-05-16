// v3.7.2 — structural invariant against the K-1 version-attribution drift
// class (4th instance audit response).
//
// Background. Inline `// vX.Y.Z K-1 ...` comments and TSDoc class-closure-
// timeline blocks have drifted FOUR times in the K-1 saga:
//   #1: v3.6.1 "CRIT-1 closed" — 1 of 10 callsites fixed (overclaim)
//   #2: v3.6.2 "all 10 callsites" — 4 of 10 fixed (overclaim)
//   #3: v3.6.4 SECURITY.md HN-2 doc-lag — fixed in v3.7.1
//   #4: v3.6.3 K-1 attribution — 13+ comments mis-stamped (fixed in v3.7.2)
//
// The root cause: comments written during a sprint that gets split (v3.6.3
// originally scoped K-1 + marketing; deferred K-1 to v3.6.4 mid-sprint) keep
// the wrong version stamp because find-and-replace wasn't done.
//
// Structural mitigation: this invariant test asserts that every K-1
// invariant comment in `src/` uses ONE consistent version stamp. If a
// future sprint introduces a new K-1 comment with a different version,
// the test fails — forcing the author to either:
//   (a) align the stamp with existing comments (the common case), or
//   (b) document the version-bump explicitly + update ALL existing stamps
//       in one batch (the architectural-change case).
//
// This is the 5th-level structural guard for the K-1 class (after grep
// invariant, AST def-use trace, caller-pattern integration, fixture-based
// negative-control). The class is now closed at FIVE levels.
//
// v3.7.3 — added negative-control fixture coverage. Per the CLAUDE.md
// anti-pattern "Invariant test without negative-control — Rule since
// v3.6.4", the v3.7.2 invariant lacked a sibling test that would FAIL
// when the invariant was violated. v3.7.3 closes that compliance gap by
// extracting the scanning logic + adding fixture-based negative control
// at `tests/fixtures/k1-version-stamps/drift-mixed.ts`.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const SRC_ROOT = "src";
const NEGATIVE_FIXTURE_ROOT = "tests/fixtures/k1-version-stamps";
// K-1 invariant comments look like `// vX.Y.Z K-1 closure` or
// `// vX.Y.Z K-1 invariant` or `// SAFE BY DESIGN (vX.Y.Z K-1 invariant)`.
// We anchor on "K-1" to filter; the version is the immediately-preceding
// vX.Y.Z token.
const K1_VERSION_RE = /\bv(\d+\.\d+\.\d+)\s+K-1\b/g;
// Canonical: v3.6.4 was when K-1 structurally closed (peek-everywhere +
// grep invariant). v3.7.0 added the AST sibling test but didn't change the
// K-1 closure version. If a future v3.X.Y legitimately re-closes K-1
// (e.g. after a major refactor), update this constant + every stamp +
// CHANGELOG in one batch.
const CANONICAL_VERSION = "3.6.4";

async function collectTs(root: string): Promise<string[]> {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur) continue;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name.startsWith(".")) continue;
        stack.push(path.join(cur, e.name));
        continue;
      }
      if (!e.isFile() || !e.name.endsWith(".ts") || e.name.endsWith(".d.ts")) continue;
      out.push(path.join(cur, e.name));
    }
  }
  return out;
}

/**
 * Extract the K-1 version-stamp scanning logic into a pure function so
 * negative-control fixture tests can call it on a known-bad input. Returns
 * a Map keyed by version string with the list of file:line sites where
 * each version was found.
 *
 * Added in v3.7.3 to close the negative-control compliance gap.
 */
async function scanK1Stamps(rootDir: string): Promise<Map<string, { file: string; line: number }[]>> {
  const stamps = new Map<string, { file: string; line: number }[]>();
  const files = await collectTs(rootDir);
  for (const file of files) {
    const text = await fs.readFile(file, "utf8");
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      for (const m of line.matchAll(K1_VERSION_RE)) {
        const version = m[1] ?? "";
        const list = stamps.get(version) ?? [];
        list.push({ file, line: i + 1 });
        stamps.set(version, list);
      }
    }
  }
  return stamps;
}

describe("K-1 version-stamp consistency invariant (v3.7.2 + v3.7.3 negative-control)", () => {
  it("every `vX.Y.Z K-1 ...` comment in src/ uses the same version stamp", async () => {
    const stamps = await scanK1Stamps(SRC_ROOT);
    if (stamps.size <= 1) {
      // Either zero K-1 comments (file deleted?) or all consistent.
      // We don't require a minimum count here — the existence-side is
      // guarded by k1-class-invariant.test.ts ("≥6 sites tracked").
      return;
    }
    // Multiple distinct version stamps found — surface them all.
    const detail = [...stamps.entries()]
      .map(
        ([v, sites]) =>
          `  v${v} (${sites.length}×):\n${sites.map((s) => `    ${path.relative(process.cwd(), s.file)}:${s.line}`).join("\n")}`
      )
      .join("\n");
    expect.fail(
      `K-1 invariant comments use ${stamps.size} different version stamps. ` +
        `All K-1 inline-comment stamps in src/ should agree on a single version ` +
        `(typically the version that closed the K-1 class structurally). ` +
        `Found:\n${detail}\n\nFix: pick the canonical version (likely the most recent one) ` +
        `and update all stamps in a single commit. See v3.7.2 CHANGELOG for the methodology rule.`
    );
  });

  it("the K-1 version stamp matches the version that closed the class (v3.6.4)", async () => {
    const stamps = await scanK1Stamps(SRC_ROOT);
    const violations: string[] = [];
    for (const [version, sites] of stamps) {
      if (version === CANONICAL_VERSION) continue;
      for (const s of sites) {
        violations.push(
          `${path.relative(process.cwd(), s.file)}:${s.line} uses v${version}, expected v${CANONICAL_VERSION}`
        );
      }
    }
    if (violations.length > 0) {
      expect.fail(
        `Found ${violations.length} K-1 inline-comment(s) NOT using the canonical version v${CANONICAL_VERSION}:\n` +
          violations.map((v) => `  ${v}`).join("\n") +
          `\n\nFix: either update each comment to v${CANONICAL_VERSION}, OR if K-1 was legitimately re-closed ` +
          `in a newer version, update the CANONICAL constant in this test file + every stamp + CHANGELOG ` +
          `in a single commit (per the v3.7.2 methodology rule).`
      );
    }
  });

  // v3.7.3 negative-control sibling. Without these, the v3.7.2 invariant
  // tests above would silently pass even if the analyzer regex / scanner
  // logic regressed (since there are no offending stamps in current src/).
  // The fixture at `tests/fixtures/k1-version-stamps/drift-mixed.ts`
  // intentionally has 3 different K-1 stamps; the analyzer MUST detect
  // them all — that proves the production-side analyzer works.
  describe("NEGATIVE-CONTROL: scanK1Stamps detects drift on known-bad fixture (v3.7.3)", () => {
    it("detects ALL distinct version stamps in drift-mixed.ts (consistency-test counterpart)", async () => {
      const stamps = await scanK1Stamps(NEGATIVE_FIXTURE_ROOT);
      // Fixture has v3.6.3, v3.6.4, v3.6.5 — analyzer must find all 3.
      expect(stamps.size).toBe(3);
      expect(stamps.has("3.6.3")).toBe(true);
      expect(stamps.has("3.6.4")).toBe(true);
      expect(stamps.has("3.6.5")).toBe(true);
    });

    it("flags violations for non-canonical stamps in drift-mixed.ts (canonical-anchor counterpart)", async () => {
      const stamps = await scanK1Stamps(NEGATIVE_FIXTURE_ROOT);
      const violations: string[] = [];
      for (const [version, sites] of stamps) {
        if (version === CANONICAL_VERSION) continue;
        for (const _s of sites) violations.push(version);
      }
      // Fixture has 2 non-canonical stamps (v3.6.3 and v3.6.5).
      expect(violations.length).toBe(2);
      expect(violations).toContain("3.6.3");
      expect(violations).toContain("3.6.5");
    });
  });
});
