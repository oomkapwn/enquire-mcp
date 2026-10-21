import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { load } from "js-yaml";
import { REQUIRED_RELEASE_CHECKS } from "../scripts/check-release-integrity.mjs";

// A8-1 — the required-check contexts live in FOUR places: the classic branch
// protection, the `main-protection` ruleset, `REQUIRED_RELEASE_CHECKS` (the
// release gate's canon) and the mirror in `release.yml`. The two in-repo
// copies are pinned by tests, but the two LIVE copies were pinned by nothing:
// a job renamed in `ci.yml` (with the in-repo lists updated) would leave the
// live list demanding a context that no longer exists — a merge blocked
// forever — and the other way round, a live list that dropped a context
// would quietly stop protecting the merge.
//
// This gate compares the live list with the canon, in both directions.
//
// The canonical list lives in `scripts/check-release-integrity.mjs` because
// that is the list the RELEASE gate waits for: a context the merge requires
// but the release does not is a context the release can pass without.
//
// WHAT THIS GATE CAN SEE — frozen, and checked against the CHANGELOG claim:
//
//   * the `main-protection` RULESET: read ANONYMOUSLY from the public GitHub
//     API, with no credential. A workflow token cannot read it either: the
//     GITHUB_TOKEN has no `administration` scope, and an installation token
//     that lacks the scope gets 403 where an anonymous read gets 200.
//
//   * the CLASSIC branch protection: NOT readable by any workflow token
//     ("gh: Resource not accessible by integration (HTTP 403)"), so it is
//     UNAUDITED here. If it still exists, a dead context in it still blocks
//     merges forever. The recorded direction is to make the ruleset the
//     single live source.
//
//   * the `ci.yml` job inventory: read statically, so a renamed job is caught
//     in the pull request itself, deterministically, without a network round
//     trip.

const repoRoot = path.resolve(__dirname, "..");
const REPO = "oomkapwn/enquire-mcp";
const RULESET_NAME = "main-protection";
const API_ROOT = "https://api.github.com";

/** What this gate can and cannot see. The CHANGELOG claim is checked against it. */
const PROBE_COVERAGE = Object.freeze({
  classic: "unaudited: no workflow token can read branch protection",
  ruleset: "live: read anonymously from the public GitHub API"
});

/**
 * Contexts the workflow may define BEYOND the canon.
 *
 * Every extra context is a deliberate, recorded decision: a new job must be
 * added here, so a context can never appear in the workflow without somebody
 * stating that it is not a merge gate.
 */
const ALLOWED_EXTRA_CONTEXTS = Object.freeze([
  "mcpb-basic (linux)",
  "mcpb-basic (macos)",
  "mcpb-basic (windows)",
  "mcpb-basic-package",
  "npm-package",
  "package-consumer (linux)",
  "package-consumer (macos)",
  "package-consumer (windows)",
  "protocol-conformance (linux)",
  "protocol-conformance (windows)",
  "test-macos",
  "test-windows"
]);

interface WorkflowJob {
  readonly name?: string;
  readonly strategy?: { readonly matrix?: { readonly include?: readonly { readonly label?: string }[] } };
}

/** The check-run names the workflow defines, with every matrix label expanded. */
function workflowContexts(source: string): string[] {
  const workflow = load(source) as { readonly jobs?: Readonly<Record<string, WorkflowJob>> };
  const contexts: string[] = [];
  for (const [key, job] of Object.entries(workflow.jobs ?? {})) {
    const template = job.name ?? key;
    const include = job.strategy?.matrix?.include ?? [];
    if (include.length === 0) {
      contexts.push(template);
      continue;
    }
    for (const entry of include) {
      contexts.push(template.replaceAll("${{ matrix.label }}", String(entry.label ?? "")));
    }
  }
  return contexts.sort();
}

/** Read a public GitHub API endpoint with no credential of any kind. */
async function anonymousApi(endpoint: string): Promise<unknown> {
  const response = await fetch(`${API_ROOT}${endpoint}`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "enquire-mcp-required-checks-probe" }
  });
  if (!response.ok) {
    throw new Error(`required-checks probe: GET ${endpoint} returned ${response.status}`);
  }
  return (await response.json()) as unknown;
}

/** The contexts the live ruleset demands, sorted. */
async function liveRulesetContexts(): Promise<string[]> {
  const rulesets = (await anonymousApi(`/repos/${REPO}/rulesets`)) as {
    readonly name?: string;
    readonly id?: number;
  }[];
  const ruleset = rulesets.find((candidate) => candidate.name === RULESET_NAME);
  if (ruleset === undefined || ruleset.id === undefined) {
    throw new Error(`required-checks probe: the ${RULESET_NAME} ruleset does not exist`);
  }
  const detail = (await anonymousApi(`/repos/${REPO}/rulesets/${ruleset.id}`)) as {
    readonly rules?: {
      readonly type?: string;
      readonly parameters?: { readonly required_status_checks?: { readonly context?: string }[] };
    }[];
  };
  const rule = (detail.rules ?? []).find((candidate) => candidate.type === "required_status_checks");
  if (rule === undefined) {
    throw new Error(`required-checks probe: the ${RULESET_NAME} ruleset demands no status checks`);
  }
  return (rule.parameters?.required_status_checks ?? [])
    .map((check) => check.context ?? "")
    .filter((context) => context.length > 0)
    .sort();
}

let liveProbe: Promise<string[]> | undefined;

/** One live read per process: the probe and its guard must see the same list. */
function liveRulesetContextsOnce(): Promise<string[]> {
  liveProbe ??= liveRulesetContexts();
  return liveProbe;
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

/** The A8-1 section of the CHANGELOG, whose claim must state the real coverage. */
function changelogClaim(): string {
  const changelog = readFileSync(path.join(repoRoot, "CHANGELOG.md"), "utf8");
  const start = changelog.indexOf("### The live required-check lists");
  if (start < 0) return "";
  const rest = changelog.slice(start + 1);
  const end = rest.indexOf("\n### ");
  return end < 0 ? rest : rest.slice(0, end);
}

describe("live required-checks lists against the canonical release gate (A8-1)", () => {
  it("the ci.yml job inventory defines every canonical context", () => {
    const contexts = workflowContexts(readFileSync(path.join(repoRoot, ".github/workflows/ci.yml"), "utf8"));
    const missing = REQUIRED_RELEASE_CHECKS.filter((context) => !contexts.includes(context));
    expect(
      missing,
      "ci.yml must define every context the merge requires: " + JSON.stringify(missing)
    ).toEqual([]);
  });

  it("the workflow defines no context beyond the canon and the recorded extras", () => {
    const contexts = workflowContexts(readFileSync(path.join(repoRoot, ".github/workflows/ci.yml"), "utf8"));
    const extras = contexts.filter((context) => !REQUIRED_RELEASE_CHECKS.includes(context));
    expect(
      extras,
      "every context beyond the canon must be a recorded, deliberate extra"
    ).toEqual([...ALLOWED_EXTRA_CONTEXTS]);
  });

  it("the main-protection ruleset requires exactly the canonical contexts", async () => {
    if (!process.env.CI) {
      console.warn(
        "[required-checks-live] the live ruleset probe runs in CI only; skipping the live assertion locally"
      );
      return;
    }
    const drift = findRequiredChecksDrift(await liveRulesetContextsOnce(), REQUIRED_RELEASE_CHECKS);
    expect(
      drift,
      "the main-protection ruleset and the release gate's canonical list must be the same set: " +
        `missing ${JSON.stringify(drift.missing)}, unexpected ${JSON.stringify(drift.unexpected)}`
    ).toEqual({ missing: [], unexpected: [] });
  });

  it("CI GUARD — the live ruleset probe ran, and it matched the canon exactly", async () => {
    if (!process.env.CI) {
      console.warn("[required-checks-live] the CI GUARD runs in CI only; skipping locally");
      return;
    }
    const live = await liveRulesetContextsOnce();
    expect(live.length).toBeGreaterThan(0);
    expect(live).toEqual([...REQUIRED_RELEASE_CHECKS].sort());
  });

  it("the CHANGELOG claim states the gate's real coverage", () => {
    const claim = changelogClaim();
    expect(claim, "the A8-1 CHANGELOG section must exist").not.toEqual("");
    expect(claim).toContain(PROBE_COVERAGE.classic);
    expect(claim).toContain(PROBE_COVERAGE.ruleset);
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

  it("NEGATIVE: a workflow job renamed away from the canon is reported missing", () => {
    const contexts = workflowContexts(
      ["jobs:", "  lint:", "    name: lint", "  test:", "    name: test (${{ matrix.label }})", "    strategy:", "      matrix:", "        include:", "          - label: \"22\"", "          - label: \"24\""].join(
        "\n"
      )
    );
    expect(contexts).toEqual(["lint", "test (22)", "test (24)"]);
    const drift = findRequiredChecksDrift(contexts, ["lint", "test (22)", "test (24)", "smoke"]);
    expect(drift.missing).toEqual(["smoke"]);
  });
});
