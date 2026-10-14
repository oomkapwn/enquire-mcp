// P02 — `bump-test-count --check` verified digit equality, not canonical form.
// The anchors (package.json + AGENTS.md) and the census could both say 100
// while a SCOPED surface held different digits in a claim slot — the
// changelog's `### Tests (N)` heading or the CLAUDE current bullet's
// `→ N source tests` arrow. The bump would have rewritten those slots, so the
// plan carried changes at EQUAL counts, and the old check returned "already
// agree" without ever looking at them. These controls build a synthetic repo
// so the rejection is proven causally, without mutating the real tree.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error — .mjs script, no types; we exercise the pure exported core.
import { buildBumpPlan, bumpTestCount } from "../scripts/bump-test-count.mjs";

/** The synthetic census: one file, exactly 100 `it(` registrations. */
const COUNT = 100;
/** The synthetic package.json version, for CLAUDE's current-bullet scoping. */
const VERSION = "1.2.3-rc.4";

/** Every plain surface needs exactly one occurrence of the declared token. */
const PLAIN_SURFACES = [
  "AGENTS.md",
  "README.ar.md",
  "README.de.md",
  "README.es.md",
  "README.fr.md",
  "README.hi.md",
  "README.ja.md",
  "README.ko.md",
  "README.md",
  "README.pt.md",
  "README.ru.md",
  "README.zh.md",
  "ROADMAP.md",
  "assets/social-preview.svg",
  "docs/COMPARISON.md",
  "llms-ctx.txt",
  "llms.txt",
  "site/index.html"
];

/**
 * Build a minimal synthetic repository the script accepts: both anchors, every
 * surface in its canonical form, the two excluded machine pins, and a tests/
 * directory whose census equals COUNT. Scoped surfaces take their digits from
 * `changelogTests` and `claudeTests` so a control can drift JUST the scoped
 * slots while the anchors stay canonical.
 */
function writeSyntheticRepo(root: string, changelogTests: number, claudeTests: number): void {
  mkdirSync(path.join(root, "tests"), { recursive: true });
  mkdirSync(path.join(root, "tests", "fixtures"), { recursive: true });
  mkdirSync(path.join(root, "assets"), { recursive: true });
  mkdirSync(path.join(root, "docs"), { recursive: true });
  writeFileSync(
    path.join(root, "tests", "synthetic.test.ts"),
    Array.from({ length: COUNT }, (_, i) => `  it("case ${i}", () => {});`).join("\n"),
    "utf8"
  );
  // The excluded machine-generated pins must exist; their digits are reported,
  // never rewritten. One digit run each keeps the report non-vacuous.
  writeFileSync(path.join(root, "tests", "fixtures", "release-mutation-identity.v2.json"), '{"pin": 7}', "utf8");
  writeFileSync(path.join(root, "tests", "fixtures", "release-mutation-transition.v3.json"), '{"pin": 8}', "utf8");
  // package.json is BOTH an anchor and a plain surface.
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ version: VERSION, description: `Local-first memory: ${COUNT}+ tests` }),
    "utf8"
  );
  for (const relativePath of PLAIN_SURFACES) {
    const full = path.join(root, relativePath);
    mkdirSync(path.dirname(full), { recursive: true });
    // AGENTS.md is the second anchor and needs the declared form; every other
    // plain surface just needs the token in its canonical notation.
    const line = relativePath === "AGENTS.md" ? `Tests: ${COUNT}+ tests, strict.` : `proven: ${COUNT}+ tests`;
    writeFileSync(full, `${line}\n`, "utf8");
  }
  // The two scoped surfaces, with the current section/claim at the given digits.
  writeFileSync(
    path.join(root, "CHANGELOG.md"),
    [
      "# Changelog",
      "",
      `## [${VERSION}] — 2026-01-01`,
      "",
      `### Tests (${changelogTests})`,
      "",
      `**0 → ${changelogTests} source tests.**`,
      "",
      "## [1.0.0] — 2025-01-01",
      "",
      "### Tests (3)",
      "",
      "**0 → 3 source tests.**",
      ""
    ].join("\n"),
    "utf8"
  );
  writeFileSync(
    path.join(root, "CLAUDE.md"),
    [
      `**Current state**: enquire-mcp · ${claudeTests} tests · 11 languages · one clone.`,
      `- **v${VERSION} (2026-01-01): heading. **0 → ${claudeTests} source tests.** tail.`,
      `- **v1.0.0 (2025-01-01): history. **0 → 3 source tests.** untouched.`,
      ""
    ].join("\n"),
    "utf8"
  );
}

describe("P02: --check rejects partial scoped drift even when anchors equal the census", () => {
  let root = "";

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "enquire-p02-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("passes the canonical tree and the plan carries no changes at equal counts", () => {
    writeSyntheticRepo(root, COUNT, COUNT);
    // Positive control: the synthetic tree is canonical by construction.
    const plan = buildBumpPlan(root);
    expect(plan.declared).toBe(COUNT);
    expect(plan.actual).toBe(COUNT);
    expect(plan.changes, "a canonical tree produces no rewrite plan").toEqual([]);
    const result = bumpTestCount({ repoRoot: root, check: true });
    expect(result.changedFiles).toEqual([]);
    expect(result.messages.join("\n")).toContain("surfaces already agree with the census");
  });

  it("rejects scoped claim slots that disagree with the anchors (changelog + CLAUDE)", () => {
    // Anchors (package.json, AGENTS.md) say 100; the census counts 100; the
    // scoped CHANGELOG heading and the CLAUDE current bullet claim 99. The
    // OLD check answered "already agree" here — this is the P02 defect.
    writeSyntheticRepo(root, COUNT - 1, COUNT - 1);
    const plan = buildBumpPlan(root);
    expect(plan.declared).toBe(COUNT);
    expect(plan.actual).toBe(COUNT);
    expect(plan.changes.map((change: { relativePath: string }) => change.relativePath)).toEqual([
      "CHANGELOG.md",
      "CLAUDE.md"
    ]);
    let message = "";
    try {
      bumpTestCount({ repoRoot: root, check: true });
      expect.unreachable("--check must reject partial scoped drift at equal counts");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain(`anchors equal the census (${COUNT})`);
    expect(message).toContain("drifted CHANGELOG.md (2 slot(s))");
    expect(message).toContain("drifted CLAUDE.md (2 slot(s))");
  });

  it("the dry-run still reports the drift without failing", () => {
    writeSyntheticRepo(root, COUNT - 1, COUNT - 1);
    const result = bumpTestCount({ repoRoot: root, dryRun: true });
    expect(result.changedFiles).toEqual([]);
    const joined = result.messages.join("\n");
    expect(joined).toContain("drifted CHANGELOG.md");
    expect(joined).toContain("drifted CLAUDE.md");
    expect(joined).not.toContain("surfaces already agree with the census");
  });
});
