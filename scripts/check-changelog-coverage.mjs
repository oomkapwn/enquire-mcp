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
import { parseJsonStrict } from "./check-version-consistency.mjs";
import { isEntrypoint } from "./lib/entrypoint.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");

const SUMMARY_PATH = resolve(repoRoot, "coverage/coverage-summary.json");
const CHANGELOG_PATH = resolve(repoRoot, "CHANGELOG.md");
const TOLERANCE_PP = 0.5;
const COVERAGE_METRICS = ["lines", "statements", "functions", "branches"];
const OWN = Object.prototype.hasOwnProperty;
const CLAIM_RE = /(lines|statements|functions|branches)\s+([^\s%]+)%/gi;
const CANONICAL_PERCENT_RE = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate the exact coverage-summary metrics consumed by this release gate.
 *
 * @param {unknown} summary Parsed coverage-summary.json value.
 * @returns {Record<string, number>} Validated percentages by metric.
 */
export function validateCoverageSummary(summary) {
  if (!isRecord(summary)) throw new Error("coverage-summary.json root must be an object");
  if (!OWN.call(summary, "total") || !isRecord(summary.total)) {
    throw new Error("coverage-summary.json must contain an object `total` field");
  }

  const actual = Object.create(null);
  for (const metric of COVERAGE_METRICS) {
    const metricValue = summary.total[metric];
    if (!OWN.call(summary.total, metric) || !isRecord(metricValue)) {
      throw new Error(`coverage-summary.json total.${metric} must be an object`);
    }
    if (!OWN.call(metricValue, "pct")) {
      throw new Error(`coverage-summary.json total.${metric}.pct is missing`);
    }
    const percentage = metricValue.pct;
    if (typeof percentage !== "number" || !Number.isFinite(percentage)) {
      throw new Error(`coverage-summary.json total.${metric}.pct must be a finite number`);
    }
    if (percentage < 0 || percentage > 100) {
      throw new Error(`coverage-summary.json total.${metric}.pct must be within 0..100`);
    }
    actual[metric] = percentage;
  }
  return actual;
}

/**
 * Extract strict, unique metric claims from the latest semantic-version section.
 *
 * @param {string} changelog CHANGELOG source.
 * @returns {{ foundSection: boolean, claims: Map<string, number> }} Parsed claims.
 */
export function parseCoverageClaims(changelog) {
  if (typeof changelog !== "string") throw new TypeError("CHANGELOG source must be a string");
  const sectionStart = changelog.search(SEMVER_BRACKET_RE);
  if (sectionStart < 0) return { foundSection: false, claims: new Map() };

  const afterFirst = changelog.slice(sectionStart);
  const nextMatch = NEXT_SEMVER_BRACKET_RE.exec(afterFirst);
  const latestSection = nextMatch ? afterFirst.slice(0, nextMatch.index) : afterFirst;
  const claims = new Map();

  for (const claim of latestSection.matchAll(CLAIM_RE)) {
    const metric = claim[1]?.toLowerCase();
    const token = claim[2] ?? "";
    if (!metric || !CANONICAL_PERCENT_RE.test(token)) {
      throw new Error(
        `CHANGELOG coverage claim ${metric ?? "(unknown)"} has a non-canonical percentage ${JSON.stringify(token)}`
      );
    }
    const percentage = Number(token);
    if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) {
      throw new Error(`CHANGELOG coverage claim ${metric} must be a finite number within 0..100`);
    }
    if (claims.has(metric)) throw new Error(`CHANGELOG coverage claim ${metric} is duplicated in the latest section`);
    claims.set(metric, percentage);
  }
  return { foundSection: true, claims };
}

/**
 * Compare validated coverage data with the latest CHANGELOG claims.
 *
 * @param {unknown} summary Parsed coverage summary.
 * @param {string} changelog CHANGELOG source.
 * @param {number} tolerancePp Allowed absolute percentage-point difference.
 * @returns {{ actual: Record<string, number>, claims: Map<string, number>, foundSection: boolean, errors: string[] }} Result.
 */
export function evaluateChangelogCoverage(summary, changelog, tolerancePp = TOLERANCE_PP) {
  if (typeof tolerancePp !== "number" || !Number.isFinite(tolerancePp) || tolerancePp < 0) {
    throw new TypeError("coverage tolerance must be a finite non-negative number");
  }
  const actual = validateCoverageSummary(summary);
  const { claims, foundSection } = parseCoverageClaims(changelog);
  const errors = [];
  for (const [metric, claimed] of claims) {
    const real = actual[metric];
    const difference = Math.abs(claimed - real);
    if (difference > tolerancePp) {
      errors.push(
        `${metric}: CHANGELOG says ${claimed}%, actual ${real}% (diff ${difference.toFixed(2)}pp > tolerance ${tolerancePp}pp)`
      );
    }
  }
  return { actual, claims, foundSection, errors };
}

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

function main() {
  if (!existsSync(SUMMARY_PATH)) {
    console.warn(
      `[changelog-coverage] coverage-summary.json not found at ${SUMMARY_PATH}. ` +
        "Run `npm run test:coverage` first. Skipping check."
    );
    return 2;
  }

  try {
    const summarySource = readFileSync(SUMMARY_PATH, "utf8");
    const summary = parseJsonStrict(summarySource, "coverage-summary.json").value;
    const changelog = readFileSync(CHANGELOG_PATH, "utf8");
    const result = evaluateChangelogCoverage(summary, changelog);
    const { actual, claims } = result;
    console.log(
      `[changelog-coverage] actual: lines ${actual.lines}% · statements ${actual.statements}% · functions ${actual.functions}% · branches ${actual.branches}%`
    );

    if (!result.foundSection) {
      console.warn("[changelog-coverage] no `## [X.Y.Z]` section found in CHANGELOG. Skipping.");
      return 0;
    }
    if (claims.size === 0) {
      console.log("[changelog-coverage] latest CHANGELOG section makes no coverage claims. Nothing to check.");
      return 0;
    }

    console.log(
      `[changelog-coverage] CHANGELOG claims: ${[...claims.entries()].map(([metric, value]) => `${metric} ${value}%`).join(" · ")}`
    );
    if (result.errors.length > 0) {
      for (const error of result.errors) console.error(`[changelog-coverage] ERROR — ${error}`);
      console.error(
        "\n[changelog-coverage] CHANGELOG coverage stats drift from reality. Fix the numbers in the latest section before publishing."
      );
      return 1;
    }

    console.log(`[changelog-coverage] OK — all claims within ${TOLERANCE_PP}pp of actual.`);
    return 0;
  } catch (error) {
    console.error(`[changelog-coverage] ERROR — ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (isEntrypoint(import.meta.url)) process.exitCode = main();
