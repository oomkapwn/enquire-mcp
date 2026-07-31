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
  "package-consumer",
  "mcpb-basic"
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

/**
 * Reject SemVer build metadata for GitHub-release asset names.
 *
 * GitHub may normalize `+` in uploaded filenames, which would break the exact
 * six-asset identity contract used by resumable MCPB publication.
 *
 * @param {unknown} version - Version read from package.json.
 * @returns {string} The version when it is safe to embed in an asset name.
 */
export function assertMcpbAssetVersion(version) {
  if (typeof version !== "string" || version.length === 0) {
    throw new Error("MCPB asset version is missing");
  }
  if (version.includes("+")) {
    throw new Error("MCPB GitHub release assets do not support SemVer build metadata");
  }
  return version;
}

/**
 * Prevent an npm dist-tag from moving backwards under SemVer precedence.
 *
 * @param {unknown} candidate - Candidate version for publication.
 * @param {unknown} current - Current channel version, or `-` when absent.
 * @param {unknown} channel - Expected npm channel derived from the candidate.
 * @returns {string} The validated candidate version.
 */
export function assertChannelVersionAdvance(candidate, current, channel) {
  const parse = (value, label) => {
    if (typeof value !== "string") throw new Error(`${label} version is missing`);
    const match =
      /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u.exec(value);
    if (!match) throw new Error(`${label} must be strict SemVer without build metadata`);
    const prerelease = match[4]?.split(".") ?? [];
    if (prerelease.some((identifier) => /^\d+$/u.test(identifier) && identifier.length > 1 && identifier[0] === "0")) {
      throw new Error(`${label} has a numeric prerelease identifier with a leading zero`);
    }
    return {
      core: [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])],
      prerelease,
      channel: prerelease[0] ?? "latest"
    };
  };
  const next = parse(candidate, "candidate");
  if (next.channel !== channel || channel === "") {
    throw new Error(`candidate ${candidate} resolves to ${next.channel}, not npm channel ${channel}`);
  }
  if (current === "" || current === "-") return candidate;
  const previous = parse(current, "current channel");
  if (previous.channel !== channel) {
    throw new Error(`current ${current} resolves to ${previous.channel}, not npm channel ${channel}`);
  }
  const compareIdentifiers = (left, right) => {
    const leftNumeric = /^\d+$/u.test(left);
    const rightNumeric = /^\d+$/u.test(right);
    if (leftNumeric && rightNumeric) {
      const leftNumber = BigInt(left);
      const rightNumber = BigInt(right);
      return leftNumber < rightNumber ? -1 : leftNumber > rightNumber ? 1 : 0;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return left < right ? -1 : left > right ? 1 : 0;
  };
  let comparison = 0;
  for (let index = 0; index < next.core.length; index++) {
    comparison = next.core[index] < previous.core[index] ? -1 : next.core[index] > previous.core[index] ? 1 : 0;
    if (comparison !== 0) break;
  }
  if (comparison === 0) {
    if (next.prerelease.length === 0 || previous.prerelease.length === 0) {
      comparison = next.prerelease.length === previous.prerelease.length ? 0 : next.prerelease.length === 0 ? 1 : -1;
    } else {
      const length = Math.max(next.prerelease.length, previous.prerelease.length);
      for (let index = 0; index < length; index++) {
        const left = next.prerelease[index];
        const right = previous.prerelease[index];
        if (left === undefined || right === undefined) {
          comparison = left === right ? 0 : left === undefined ? -1 : 1;
        } else {
          comparison = compareIdentifiers(left, right);
        }
        if (comparison !== 0) break;
      }
    }
  }
  if (comparison > 0) return candidate;
  if (comparison < 0) throw new Error(`${candidate} would roll ${channel} back from ${current}`);
  throw new Error(`${candidate} does not advance ${channel} beyond ${current}`);
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

/**
 * Classify an npm version lookup without allowing an existing identity or
 * dist-tag to drift.
 *
 * @param {unknown} state - Registry lookup state for the exact version and channel.
 * @param {unknown} expectedSha - Git commit expected in npm's `gitHead`.
 * @param {unknown} expectedVersion - Exact package version being released.
 * @param {unknown} expectedChannel - npm dist-tag derived from that version.
 * @returns {{action:"publish"|"reuse"|"reuse_superseded",channelVersion?:string}} Safe next action.
 */
export function evaluateNpmPublication(state, expectedSha, expectedVersion, expectedChannel) {
  assertChannelVersionAdvance(expectedVersion, "-", expectedChannel);
  if (state?.exists === false) return { action: "publish" };
  if (state?.exists !== true) throw new Error("npm publication state must be explicitly present or absent");
  if (state.gitHead !== expectedSha) {
    throw new Error(`npm gitHead ${JSON.stringify(state.gitHead)} does not match ${JSON.stringify(expectedSha)}`);
  }
  if (state.channelVersion === expectedVersion) return { action: "reuse" };
  if (expectedChannel === "latest") {
    throw new Error(
      `npm dist-tag version ${JSON.stringify(state.channelVersion)} does not match ${JSON.stringify(expectedVersion)}`
    );
  }
  assertChannelVersionAdvance(state.channelVersion, expectedVersion, expectedChannel);
  return { action: "reuse_superseded", channelVersion: state.channelVersion };
}

/**
 * Classify an absent, draft, or published GitHub release against the exact
 * Basic asset-name contract.
 *
 * @param {unknown} input - GitHub release and asset snapshot.
 * @param {unknown} expected - Expected tag, channel, and asset names.
 * @returns {{action:"create_draft"|"resume_draft"|"publish_draft"|"reuse_published",missing:string[]}}
 *   Safe next action and the exact missing asset names.
 */
export function evaluateMcpbReleaseState(input, expected) {
  const expectedNames = Array.isArray(expected?.assetNames) ? expected.assetNames : [];
  if (expectedNames.length === 0 || new Set(expectedNames).size !== expectedNames.length) {
    throw new Error("expected Basic release asset names must be a non-empty unique list");
  }
  const release = input?.release ?? null;
  const assets = Array.isArray(input?.assets) ? input.assets : [];
  if (release === null) {
    if (assets.length !== 0) throw new Error("absent release cannot have assets");
    return { action: "create_draft", missing: [...expectedNames] };
  }
  if (
    release.tag_name !== expected.tag ||
    release.prerelease !== expected.prerelease ||
    typeof release.draft !== "boolean"
  ) {
    throw new Error("GitHub release tag, channel, or draft identity diverged");
  }
  const counts = new Map();
  for (const asset of assets) {
    if (typeof asset?.name !== "string") throw new Error("GitHub release asset is missing a name");
    counts.set(asset.name, (counts.get(asset.name) ?? 0) + 1);
  }
  for (const [name, count] of counts) {
    if (!expectedNames.includes(name)) throw new Error(`unexpected GitHub release asset: ${name}`);
    if (count !== 1) throw new Error(`duplicate GitHub release asset: ${name}`);
  }
  const missing = expectedNames.filter((name) => !counts.has(name));
  if (!release.draft && missing.length > 0) {
    throw new Error(`published GitHub release is partial: ${missing.join(", ")}`);
  }
  if (!release.draft) return { action: "reuse_published", missing: [] };
  return { action: missing.length === 0 ? "publish_draft" : "resume_draft", missing };
}

/**
 * Return exact-source workflow runs in stable oldest-first order.
 *
 * @param {unknown} runs - GitHub Actions workflow-run snapshots.
 * @param {unknown} sourceSha - Exact source commit required for publication.
 * @returns {string[]} Positive decimal workflow-run IDs.
 */
export function candidateRunIds(runs, sourceSha) {
  if (!Array.isArray(runs)) throw new Error("Actions workflow runs must be an array");
  const matching = runs.filter(
    (run) => run?.head_sha === sourceSha && run?.head_branch === "main" && run?.event === "push"
  );
  const seen = new Set();
  for (const run of matching) {
    const id = String(run?.id ?? "");
    if (!/^[1-9]\d*$/u.test(id)) throw new Error("candidate workflow run has an invalid positive decimal id");
    if (seen.has(id)) throw new Error(`duplicate candidate workflow run id: ${id}`);
    seen.add(id);
  }
  return matching
    .sort((left, right) => (idOf(left) < idOf(right) ? -1 : idOf(left) > idOf(right) ? 1 : 0))
    .map((run) => String(run.id));
}

/**
 * Classify one Actions run and bind a unique live artifact ID and digest.
 *
 * @param {unknown} input - Jobs, artifacts, and optional provenance pins for one run.
 * @returns {{state:"skip"}|{state:"selected",artifactId:string,digest:string,runAttempt:number}}
 *   Selection state and immutable candidate identity when selected.
 */
export function evaluateMcpbCandidateRun(input) {
  const jobs = Array.isArray(input?.jobs) ? input.jobs : [];
  const artifacts = Array.isArray(input?.artifacts) ? input.artifacts : [];
  const latestNamedJob = (name) => {
    const named = jobs.filter(
      (job) => job?.name === name && Number.isInteger(job?.run_attempt) && job.run_attempt > 0
    );
    const latestAttempt = named.length > 0 ? Math.max(...named.map((job) => job.run_attempt)) : 0;
    const latest = named.filter((job) => job.run_attempt === latestAttempt);
    if (latest.length > 1) throw new Error(`duplicate latest-attempt ${name} jobs`);
    return latest[0];
  };
  const aggregate = latestNamedJob("mcpb-basic");
  if (
    aggregate?.status !== "completed" ||
    aggregate?.conclusion !== "success"
  ) {
    return { state: "skip" };
  }
  const producer = latestNamedJob("mcpb-basic-package");
  if (producer?.status !== "completed" || producer?.conclusion !== "success") {
    return { state: "skip" };
  }
  const producerAttempt = producer.run_attempt;
  if (aggregate.run_attempt < producerAttempt) return { state: "skip" };
  if (input?.pinnedRunAttempt && Number(input.pinnedRunAttempt) !== producerAttempt) {
    throw new Error("canonical Actions artifact producer attempt differs from release provenance");
  }
  const expectedName = `mcpb-basic-candidate-${producerAttempt}`;
  const live = artifacts.filter((artifact) => artifact?.name === expectedName && artifact?.expired === false);
  if (live.length > 1) throw new Error(`duplicate live ${expectedName} artifacts`);
  if (live.length === 0) return { state: "skip" };
  const artifact = live[0];
  const artifactId = String(artifact?.id ?? "");
  const digest = artifact?.digest;
  if (!/^\d+$/u.test(artifactId) || typeof digest !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(digest)) {
    throw new Error("canonical Actions artifact lacks an exact id or SHA-256 digest");
  }
  if (input?.pinnedArtifactId && String(input.pinnedArtifactId) !== artifactId) {
    throw new Error("canonical Actions artifact id differs from release provenance");
  }
  if (input?.pinnedDigest && input.pinnedDigest !== digest) {
    throw new Error("canonical Actions artifact digest differs from release provenance");
  }
  return { state: "selected", artifactId, digest, runAttempt: producerAttempt };
}

function usage() {
  return [
    "Usage: check-release-integrity.mjs",
    "assert-tag <tag> <version> | asset-version <version> | channel-advance <candidate> <current> <channel> |",
    "checks | npm-state |",
    "release-state | candidate-runs | candidate"
  ].join(" ");
}

if (isEntrypoint(import.meta.url)) {
  const [mode, first, second] = process.argv.slice(2);
  try {
    if (mode === "assert-tag") {
      assertReleaseTagMatchesVersion(first, second);
      console.log(`Release identity verified: ${first}`);
    } else if (mode === "asset-version") {
      console.log(assertMcpbAssetVersion(first));
    } else if (mode === "channel-advance") {
      console.log(assertChannelVersionAdvance(first, second, process.argv[5]));
    } else if (mode === "checks") {
      const payload = JSON.parse(readFileSync(0, "utf8"));
      console.log(JSON.stringify(evaluateReleaseChecks(payload?.check_runs)));
    } else if (mode === "npm-state") {
      const payload = JSON.parse(readFileSync(0, "utf8"));
      console.log(JSON.stringify(evaluateNpmPublication(payload, first, second, process.argv[5])));
    } else if (mode === "release-state") {
      const [tag, prerelease, ...assetNames] = process.argv.slice(3);
      const payload = JSON.parse(readFileSync(0, "utf8"));
      console.log(
        JSON.stringify(
          evaluateMcpbReleaseState(payload, {
            tag,
            prerelease: prerelease === "true",
            assetNames
          })
        )
      );
    } else if (mode === "candidate-runs") {
      const payload = JSON.parse(readFileSync(0, "utf8"));
      console.log(JSON.stringify(candidateRunIds(payload, first)));
    } else if (mode === "candidate") {
      const payload = JSON.parse(readFileSync(0, "utf8"));
      console.log(
        JSON.stringify(
          evaluateMcpbCandidateRun({
            ...payload,
            pinnedRunAttempt: second === "-" ? "" : second,
            pinnedArtifactId: process.argv[5] === "-" ? "" : process.argv[5],
            pinnedDigest: process.argv[6] === "-" ? "" : process.argv[6]
          })
        )
      );
    } else {
      throw new Error(usage());
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
