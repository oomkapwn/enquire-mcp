import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { REQUIRED_RELEASE_CHECKS } from "../scripts/check-release-integrity.mjs";

// A8-1 — the required-check lists live in FOUR places: the classic branch
// protection, the `main-protection` ruleset, `REQUIRED_RELEASE_CHECKS` (the
// release gate's canon) and the mirror in `release.yml`. The two in-repo
// copies are pinned by tests, but the two LIVE copies were pinned by nothing:
// a job renamed in `ci.yml` (with the in-repo lists updated) would leave the
// live list demanding a context that no longer exists — a merge blocked
// forever — and the other way round, a live list that dropped a context
// would quietly stop protecting the merge.
//
// This gate compares the live lists with the canon, in both directions.
//
// The canonical list lives in `scripts/check-release-integrity.mjs` because
// that is the list the RELEASE gate waits for: a context the merge requires
// but the release does not is a context the release can pass without.

const REPO = "oomkapwn/enquire-mcp";
const RULESET_NAME = "main-protection";

function hasGhToken(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return Boolean(env.GH_TOKEN || env.GITHUB_TOKEN);
}

function ghApi(path: string): unknown {
  const stdout = execFileSync("gh", ["api", path], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return JSON.parse(stdout);
}

/** The contexts the live list demands, sorted. */
function liveContexts(list: "classic" | "ruleset"): string[] {
  if (list === "classic") {
    const protection = ghApi(`repos/${REPO}/branches/main/protection`) as {
      required_status_checks?: { checks?: { context?: string }[] };
    };
    return (protection.required_status_checks?.checks ?? [])
      .map((check) => check.context ?? "")
      .filter((context) => context.length > 0)
      .sort();
  }
  const rulesets = ghApi(`repos/${REPO}/rulesets`) as {
    name?: string;
    rules?: { type?: string; parameters?: { required_status_checks?: { context?: string }[] } }[];
  }[];
  const ruleset = rulesets.find((candidate) => candidate.name === RULESET_NAME);
  if (!ruleset) throw new Error(`required-checks gate: the ${RULESET_NAME} ruleset does not exist`);
  const rule = (ruleset.rules ?? []).find((candidate) => candidate.type === "required_status_checks");
  return (rule?.parameters?.required_status_checks ?? [])
    .map((check) => check.context ?? "")
    .filter((context) => context.length > 0)
    .sort();
}

/**
 * The contexts the live list is missing from the canon, and the ones it
 * demands that the canon does not.
 */
function findRequiredChecksDrift(
  live: readonly string[],
  canon: readonly string[]
): { missing: string[]; unexpected: string[] } {
  const liveSet = new Set(live);
  const canonSet = new Set(canon);
  return {
    missing: canon.filter((context) => !liveSet.has(context)).sort(),
    unexpected: live.filter((context) => !canonSet.has(context)).sort()
  };
}

describe("live required-checks lists against the canonical release gate (A8-1)", () => {
  it("the classic branch protection requires exactly the canonical contexts", () => {
    if (!process.env.CI || !hasGhToken()) return;
    const drift = findRequiredChecksDrift(liveContexts("classic"), REQUIRED_RELEASE_CHECKS);
    expect(
      drift,
      "the classic branch protection and the release gate's canonical list must be the same set: " +
        `missing ${JSON.stringify(drift.missing)}, unexpected ${JSON.stringify(drift.unexpected)}`
    ).toEqual({ missing: [], unexpected: [] });
  });

  it("the main-protection ruleset requires exactly the canonical contexts", () => {
    if (!process.env.CI || !hasGhToken()) return;
    const drift = findRequiredChecksDrift(liveContexts("ruleset"), REQUIRED_RELEASE_CHECKS);
    expect(
      drift,
      "the main-protection ruleset and the release gate's canonical list must be the same set: " +
        `missing ${JSON.stringify(drift.missing)}, unexpected ${JSON.stringify(drift.unexpected)}`
    ).toEqual({ missing: [], unexpected: [] });
  });

  it("CI GUARD — when CI provides a token, the live required-checks probes succeed", () => {
    if (!process.env.CI || !hasGhToken()) return;
    // A probe that silently failed would make the two gates above no-ops.
    expect(liveContexts("classic").length).toBeGreaterThan(0);
    expect(liveContexts("ruleset").length).toBeGreaterThan(0);
  });

  it("NEGATIVE: a renamed job is reported as missing from the live list", () => {
    // The failure mode this gate exists for: the canon moved on, the live list
    // did not. The context the merge demands no longer exists.
    const drift = findRequiredChecksDrift(["lint", "test (22)"], ["lint", "test (22)", "renamed-job"]);
    expect(drift.missing).toEqual(["renamed-job"]);
    expect(drift.unexpected).toEqual([]);
  });

  it("NEGATIVE: a live list that dropped a context is reported as unexpected", () => {
    // The other direction: the live list demands a context the release gate
    // does not wait for, so a merge is protected by a check the release does
    // not run.
    const drift = findRequiredChecksDrift(["lint", "ghost-job"], ["lint"]);
    expect(drift.missing).toEqual([]);
    expect(drift.unexpected).toEqual(["ghost-job"]);
  });

  it("POSITIVE: the same set in any order is no drift", () => {
    const drift = findRequiredChecksDrift(["b", "a"], ["a", "b"]);
    expect(drift).toEqual({ missing: [], unexpected: [] });
  });
});
