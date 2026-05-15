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

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const SRC_ROOT = "src";
// K-1 invariant comments look like `// vX.Y.Z K-1 closure` or
// `// vX.Y.Z K-1 invariant` or `// SAFE BY DESIGN (vX.Y.Z K-1 invariant)`.
// We anchor on "K-1" to filter; the version is the immediately-preceding
// vX.Y.Z token.
const K1_VERSION_RE = /\bv(\d+\.\d+\.\d+)\s+K-1\b/g;

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

describe("K-1 version-stamp consistency invariant (v3.7.2)", () => {
  it("every `vX.Y.Z K-1 ...` comment in src/ uses the same version stamp", async () => {
    const files = await collectTs(SRC_ROOT);
    const stamps = new Map<string, { file: string; line: number }[]>();
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
    // Anchor against the canonical version: v3.6.4 was when K-1 structurally
    // closed (peek-everywhere + grep invariant). v3.7.0 added the AST sibling
    // test but didn't change the K-1 closure version. If a future v3.X.Y
    // legitimately re-closes K-1 (e.g. after a major refactor), update this
    // constant + every stamp + CHANGELOG entry in one batch.
    const CANONICAL = "3.6.4";
    const files = await collectTs(SRC_ROOT);
    const violations: string[] = [];
    for (const file of files) {
      const text = await fs.readFile(file, "utf8");
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        for (const m of line.matchAll(K1_VERSION_RE)) {
          const version = m[1] ?? "";
          if (version !== CANONICAL) {
            violations.push(`${path.relative(process.cwd(), file)}:${i + 1} uses v${version}, expected v${CANONICAL}`);
          }
        }
      }
    }
    if (violations.length > 0) {
      expect.fail(
        `Found ${violations.length} K-1 inline-comment(s) NOT using the canonical version v${CANONICAL}:\n` +
          violations.map((v) => `  ${v}`).join("\n") +
          `\n\nFix: either update each comment to v${CANONICAL}, OR if K-1 was legitimately re-closed ` +
          `in a newer version, update the CANONICAL constant in this test file + every stamp + CHANGELOG ` +
          `in a single commit (per the v3.7.2 methodology rule).`
      );
    }
  });
});
