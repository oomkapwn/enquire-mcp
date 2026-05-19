#!/usr/bin/env node
/**
 * v3.5.12 — CHANGELOG coverage drift guard.
 *
 * Background: v3.5.10 release notes claimed `lines 91.81% / statements 87.61%`
 * but the actual coverage was `lines 89.53% / statements 86.06%`. The wrong
 * numbers were copy-pasted from a sub-agent's report rather than measured
 * against the final committed state. The external re-audit caught it.
 *
 * This script gates the class of bug: every CHANGELOG section that claims
 * coverage stats must match what `npm run test:coverage` actually produces,
 * within 0.5 percentage points (tolerance for rounding + minor reordering).
 *
 * Usage:
 *   1. Run `npm run test:coverage` first — generates `coverage/coverage-summary.json`.
 *   2. Run `node scripts/check-changelog-coverage.mjs` — compares with the
 *      latest CHANGELOG section's stated numbers.
 *
 * Exit codes:
 *   0 — match (within tolerance) OR latest section makes no coverage claim
 *   1 — mismatch (prints the diff)
 *   2 — coverage-summary.json missing (skip, with a warning)
 *
 * Integration:
 *   - CI `coverage` job runs both, fails on exit 1.
 *   - Local: `npm run check:changelog-coverage` (NOT `coverage-drift` — the
 *     latter never existed; round-19 audit caught the stale reference).
 *     Run after `npm run test:coverage` to refresh `coverage-summary.json`.
 *   - `prepublishOnly` adds it to the safety net (so we never publish a
 *     release tag whose CHANGELOG has wrong stats).
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");

const SUMMARY_PATH = resolve(repoRoot, "coverage/coverage-summary.json");
const CHANGELOG_PATH = resolve(repoRoot, "CHANGELOG.md");
const TOLERANCE_PP = 0.5;

if (!existsSync(SUMMARY_PATH)) {
  console.warn(
    `[changelog-coverage] coverage-summary.json not found at ${SUMMARY_PATH}. ` +
      "Run `npm run test:coverage` first. Skipping check."
  );
  process.exit(2);
}

const summary = JSON.parse(readFileSync(SUMMARY_PATH, "utf8"));
const total = summary.total;
if (!total) {
  console.error("[changelog-coverage] coverage-summary.json has no `total` field. Aborting.");
  process.exit(1);
}

// Actual coverage from this run.
const actual = {
  lines: Number(total.lines.pct),
  statements: Number(total.statements.pct),
  functions: Number(total.functions.pct),
  branches: Number(total.branches.pct)
};

console.log(
  `[changelog-coverage] actual: lines ${actual.lines}% · statements ${actual.statements}% · functions ${actual.functions}% · branches ${actual.branches}%`
);

// Find the LATEST changelog section (from first `## [X.Y.Z]` or
// `## [X.Y.Z-prerelease]` to either the next one or end of file).
//
// v3.6.0-rc.4 fix: original regex `\[\d+\.\d+\.\d+\]` did NOT match
// pre-release versions like `[3.6.0-rc.4]` — the closing bracket
// after the third digit fails when there's a `-rc.N` suffix. Result:
// during the v3.6.0 RC sequence, the script silently fell through to
// reading `[3.5.14]`'s coverage claim (the most recent matching
// stable-semver section), validating CHANGELOG against STALE numbers.
// Gate always passed because the v3.5.14 stats were fixed at write
// time. Class: regex assumes stricter format than spec allows.
const SEMVER_BRACKET_RE = /^## \[\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\]/m;
const NEXT_SEMVER_BRACKET_RE = /\n## \[\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\]/;
const changelog = readFileSync(CHANGELOG_PATH, "utf8");
const sectionStart = changelog.search(SEMVER_BRACKET_RE);
if (sectionStart < 0) {
  console.warn("[changelog-coverage] no `## [X.Y.Z]` section found in CHANGELOG. Skipping.");
  process.exit(0);
}
const afterFirst = changelog.slice(sectionStart);
const nextMatch = NEXT_SEMVER_BRACKET_RE.exec(afterFirst);
const latestSection = nextMatch ? afterFirst.slice(0, nextMatch.index) : afterFirst;

// Parse claimed numbers — match patterns like `branches 75.29%` or
// `lines 89.53%` anywhere in the section (case-insensitive).
const claimRe = /(lines|statements|functions|branches)\s+(\d+(?:\.\d+)?)%/gi;
const claims = new Map();
for (const claim of latestSection.matchAll(claimRe)) {
  const metric = claim[1].toLowerCase();
  const pct = Number(claim[2]);
  // If the same metric appears multiple times in the section, last claim wins.
  claims.set(metric, pct);
}

if (claims.size === 0) {
  console.log("[changelog-coverage] latest CHANGELOG section makes no coverage claims. Nothing to check.");
  process.exit(0);
}

console.log(
  `[changelog-coverage] CHANGELOG claims: ${[...claims.entries()].map(([k, v]) => `${k} ${v}%`).join(" · ")}`
);

let hasError = false;
for (const [metric, claimed] of claims) {
  const real = actual[metric];
  if (typeof real !== "number") {
    console.warn(`[changelog-coverage] WARN — claim "${metric}" has no counterpart in coverage-summary.json`);
    continue;
  }
  const diff = Math.abs(claimed - real);
  if (diff > TOLERANCE_PP) {
    console.error(
      `[changelog-coverage] ERROR — ${metric}: CHANGELOG says ${claimed}%, actual ${real}% (diff ${diff.toFixed(2)}pp > tolerance ${TOLERANCE_PP}pp)`
    );
    hasError = true;
  }
}

if (hasError) {
  console.error(
    "\n[changelog-coverage] CHANGELOG coverage stats drift from reality. Fix the numbers in the latest section before publishing."
  );
  process.exit(1);
}

console.log(`[changelog-coverage] OK — all claims within ${TOLERANCE_PP}pp of actual.`);
process.exit(0);
