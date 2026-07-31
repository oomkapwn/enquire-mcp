#!/usr/bin/env node
// Release preflight shared by release.yml and unit tests.
//
// Two properties are deliberately fail-closed:
//   1. the trigger tag must identify the package version checked out from main;
//   2. every exact required context must have a successful latest check-run.
//
// Counting matching check-runs is insufficient: reruns can create duplicates,
// allowing one missing context to be hidden by a second run of another context.

import { readFileSync } from "node:fs";
import { isEntrypoint } from "./lib/entrypoint.mjs";

/** Exact GitHub check-run names required before npm publication. */
export const REQUIRED_RELEASE_CHECKS = Object.freeze([
  "lint",
  "test (22)",
  "test (24)",
  "smoke",
  "audit",
  "coverage",
  "version-consistency",
  "docs",
  "oia",
  "protocol-conformance",
  "package-consumer"
]);

/**
 * Assert that the release trigger tag and checked-out package version are the
 * same identity.
 *
 * @param {unknown} tag - Trigger tag, without a `refs/tags/` prefix.
 * @param {unknown} version - Version read from package.json.
 * @returns {string} The validated tag.
 */
export function assertReleaseTagMatchesVersion(tag, version) {
  if (typeof tag !== "string" || tag.length === 0) {
    throw new Error("Release tag is missing");
  }
  if (typeof version !== "string" || version.length === 0) {
    throw new Error("package.json version is missing");
  }
  const expected = `v${version}`;
  if (tag !== expected) {
    throw new Error(`Release tag ${JSON.stringify(tag)} does not match package version ${JSON.stringify(expected)}`);
  }
  return tag;
}

function timestampOf(run) {
  for (const field of ["started_at", "completed_at", "created_at"]) {
    const value = run?.[field];
    if (typeof value !== "string") continue;
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return 0;
}

function idOf(run) {
  try {
    return BigInt(typeof run?.id === "number" || typeof run?.id === "string" ? run.id : 0);
  } catch {
    return 0n;
  }
}

function isLater(candidate, current) {
  const candidateTime = timestampOf(candidate);
  const currentTime = timestampOf(current);
  if (candidateTime !== currentTime) return candidateTime > currentTime;
  return idOf(candidate) > idOf(current);
}

/**
 * Evaluate GitHub check-runs by exact context name, selecting only the latest
 * run for each required context.
 *
 * @param {unknown} checkRuns - GitHub REST `check_runs` array.
 * @param {readonly string[]} required - Exact required context names.
 * @returns {{
 *   state:"ready"|"pending"|"failed",
 *   succeeded:string[],
 *   missing:string[],
 *   pending:string[],
 *   failed:Array<{name:string,conclusion:string}>
 * }} Release readiness.
 */
export function evaluateReleaseChecks(checkRuns, required = REQUIRED_RELEASE_CHECKS) {
  const requiredSet = new Set(required);
  const latest = new Map();
  if (Array.isArray(checkRuns)) {
    for (const run of checkRuns) {
      const name = run?.name;
      if (typeof name !== "string" || !requiredSet.has(name)) continue;
      const current = latest.get(name);
      if (!current || isLater(run, current)) latest.set(name, run);
    }
  }

  const succeeded = [];
  const missing = [];
  const pending = [];
  const failed = [];
  for (const name of required) {
    const run = latest.get(name);
    if (!run) {
      missing.push(name);
      continue;
    }
    if (run.status !== "completed" || run.conclusion == null) {
      pending.push(name);
      continue;
    }
    if (run.conclusion !== "success") {
      failed.push({ name, conclusion: String(run.conclusion) });
      continue;
    }
    succeeded.push(name);
  }

  return {
    state: failed.length > 0 ? "failed" : missing.length > 0 || pending.length > 0 ? "pending" : "ready",
    succeeded,
    missing,
    pending,
    failed
  };
}

function usage() {
  return "Usage: check-release-integrity.mjs assert-tag <tag> <version> | checks";
}

if (isEntrypoint(import.meta.url)) {
  const [mode, first, second] = process.argv.slice(2);
  try {
    if (mode === "assert-tag") {
      assertReleaseTagMatchesVersion(first, second);
      console.log(`Release identity verified: ${first}`);
    } else if (mode === "checks") {
      const payload = JSON.parse(readFileSync(0, "utf8"));
      console.log(JSON.stringify(evaluateReleaseChecks(payload?.check_runs)));
    } else {
      throw new Error(usage());
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
