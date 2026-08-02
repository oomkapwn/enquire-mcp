#!/usr/bin/env node
// Release preflight shared by release.yml and unit tests.
//
// Two properties are deliberately fail-closed:
//   1. the trigger tag must identify the package version checked out from main;
//   2. every exact required context must have one successful maximum-attempt
//      job execution in the exact ci.yml main-push workflow run.
//
// Counting matching jobs is insufficient: names can collide across workflows,
// and reruns retain old executions. The caller supplies `filter=all`; this
// evaluator validates every identity before selecting the unique maximum
// run_attempt per required name.

import { readFileSync } from "node:fs";
import { isEntrypoint } from "./lib/entrypoint.mjs";

/** Exact GitHub Actions job names required before npm publication. */
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

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveSafeInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function isExactSha1(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/u.test(value);
}

function isExactSha256DigestOrNull(value) {
  return value === null || (typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value));
}

function assertPaginatedFieldItem(item, field) {
  if (!isRecord(item)) throw new Error(`paginated ${String(field)} element must be an object`);
  if (field === "workflow_runs") {
    if (
      !isPositiveSafeInteger(item.id) ||
      !isNonEmptyString(item.name) ||
      !isNonEmptyString(item.path) ||
      !isNonEmptyString(item.event) ||
      !isNonEmptyString(item.head_branch) ||
      !isExactSha1(item.head_sha) ||
      !isPositiveSafeInteger(item.run_attempt) ||
      !isNonEmptyString(item.status)
    ) {
      throw new Error("paginated workflow_runs element has an invalid identity");
    }
    return;
  }
  if (field === "jobs") {
    if (
      !isPositiveSafeInteger(item.id) ||
      !isNonEmptyString(item.name) ||
      !isPositiveSafeInteger(item.run_id) ||
      !isPositiveSafeInteger(item.run_attempt) ||
      !isExactSha1(item.head_sha) ||
      !isNonEmptyString(item.workflow_name) ||
      !isNonEmptyString(item.status) ||
      (item.conclusion !== null && typeof item.conclusion !== "string")
    ) {
      throw new Error("paginated jobs element has an invalid identity");
    }
    return;
  }
  if (
    !isPositiveSafeInteger(item.id) ||
    !isNonEmptyString(item.name) ||
    typeof item.expired !== "boolean" ||
    !isExactSha256DigestOrNull(item.digest)
  ) {
    throw new Error("paginated artifacts element has an invalid identity");
  }
}

function assertTrustedCiWorkflowRun(workflowRun, expectedSourceSha) {
  if (typeof expectedSourceSha !== "string" || !/^[0-9a-f]{40}$/u.test(expectedSourceSha)) {
    throw new Error("expected release source SHA must be one exact lowercase SHA-1");
  }
  if (
    !isRecord(workflowRun) ||
    !isPositiveSafeInteger(workflowRun.id) ||
    workflowRun.name !== "CI" ||
    workflowRun.path !== ".github/workflows/ci.yml" ||
    workflowRun.event !== "push" ||
    workflowRun.head_branch !== "main" ||
    workflowRun.head_sha !== expectedSourceSha ||
    !isPositiveSafeInteger(workflowRun.run_attempt) ||
    typeof workflowRun.status !== "string" ||
    workflowRun.status.length === 0
  ) {
    throw new Error("trusted CI workflow run identity diverged from the exact ci.yml main-push source");
  }
  return workflowRun;
}

function assertTrustedWorkflowJob(job, trustedRun, expectedSourceSha, label) {
  if (
    !isRecord(job) ||
    !isPositiveSafeInteger(job.id) ||
    !isNonEmptyString(job.name) ||
    !isPositiveSafeInteger(job.run_id) ||
    job.run_id !== trustedRun.id ||
    !isPositiveSafeInteger(job.run_attempt) ||
    job.run_attempt > trustedRun.run_attempt ||
    job.head_sha !== expectedSourceSha ||
    job.workflow_name !== trustedRun.name ||
    !isNonEmptyString(job.status) ||
    (job.conclusion !== null && typeof job.conclusion !== "string")
  ) {
    throw new Error(`${label} ${String(job?.name)} diverged from the exact workflow-run identity`);
  }
  return job;
}

/**
 * Flatten `gh api --paginate --slurp` pages whose pages are arrays.
 *
 * An outer empty page list is not an authoritative empty collection. A single
 * empty page (`[[]]`) is. Release and asset elements are shape-checked before
 * any caller can interpret a count of zero.
 *
 * @param {unknown} pages - Slurped GitHub REST pages.
 * @param {unknown} kind - `release` or `asset`.
 * @returns {Record<string, unknown>[]} Strictly decoded collection elements.
 */
export function flattenPaginatedArrays(pages, kind) {
  if (kind !== "release" && kind !== "asset") throw new Error("unknown paginated collection kind");
  if (!Array.isArray(pages) || pages.length === 0) throw new Error("paginated response must contain a page");
  const flattened = [];
  const seenIds = new Set();
  for (const page of pages) {
    if (!Array.isArray(page)) throw new Error("paginated collection page must be an array");
    for (const item of page) {
      if (!isRecord(item)) throw new Error(`paginated ${kind} element must be an object`);
      if (kind === "release") {
        if (
          !isPositiveSafeInteger(item.id) ||
          typeof item.tag_name !== "string" ||
          item.tag_name.length === 0 ||
          typeof item.draft !== "boolean" ||
          typeof item.prerelease !== "boolean"
        ) {
          throw new Error("paginated release element has an invalid identity");
        }
      } else if (
        !isPositiveSafeInteger(item.id) ||
        typeof item.name !== "string" ||
        item.name.length === 0 ||
        typeof item.state !== "string" ||
        item.state.length === 0 ||
        typeof item.content_type !== "string" ||
        item.content_type.length === 0 ||
        !Number.isSafeInteger(item.size) ||
        item.size < 0 ||
        (item.digest !== null && (typeof item.digest !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(item.digest)))
      ) {
        throw new Error("paginated asset element has an invalid identity");
      }
      if (seenIds.has(item.id)) throw new Error(`paginated ${kind} collection contains a duplicate id`);
      seenIds.add(item.id);
      flattened.push(item);
    }
  }
  return flattened;
}

/**
 * Flatten object-envelope pages returned by GitHub Actions list endpoints.
 *
 * @param {unknown} pages - Slurped GitHub REST pages.
 * @param {unknown} field - One supported collection field.
 * @returns {Record<string, unknown>[]} Strictly decoded collection elements.
 */
export function flattenPaginatedField(pages, field) {
  if (!new Set(["workflow_runs", "jobs", "artifacts"]).has(field)) {
    throw new Error("unknown paginated envelope field");
  }
  if (!Array.isArray(pages) || pages.length === 0) throw new Error("paginated response must contain a page");
  const flattened = [];
  const seenIds = new Set();
  let totalCount;
  for (const page of pages) {
    if (!isRecord(page) || !isNonNegativeSafeInteger(page.total_count) || !Array.isArray(page[field])) {
      throw new Error(`paginated ${String(field)} page has an invalid envelope`);
    }
    if (totalCount === undefined) totalCount = page.total_count;
    else if (page.total_count !== totalCount) {
      throw new Error(`paginated ${String(field)} pages disagree on total_count`);
    }
    for (const item of page[field]) {
      assertPaginatedFieldItem(item, field);
      if (seenIds.has(item.id)) {
        throw new Error(`paginated ${String(field)} collection contains a duplicate id`);
      }
      seenIds.add(item.id);
      flattened.push(item);
    }
  }
  if (flattened.length !== totalCount) {
    throw new Error(`paginated ${String(field)} collection length does not match total_count`);
  }
  return flattened;
}

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
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u.exec(value);
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

/**
 * Evaluate all job executions from one trusted `ci.yml` main-push run.
 *
 * Callers obtain jobs from GitHub's exact-run endpoint with `filter=all`.
 * Every required-name job must independently repeat the exact run, source,
 * workflow, positive-safe job ID, and bounded attempt identity. The unique
 * greatest attempt per name is authoritative; duplicate maximum executions
 * fail closed while older executions remain rerun history.
 *
 * @param {unknown} jobs - GitHub REST `jobs` array for the exact workflow run.
 * @param {unknown} workflowRun - Exact `ci.yml` main-push workflow run.
 * @param {unknown} expectedSourceSha - Checked-out release source SHA.
 * @param {readonly string[]} required - Exact required job names.
 * @returns {{
 *   state:"ready"|"pending"|"failed",
 *   succeeded:string[],
 *   missing:string[],
 *   pending:string[],
 *   failed:Array<{name:string,conclusion:string}>
 * }} Release readiness.
 */
export function evaluateReleaseChecks(jobs, workflowRun, expectedSourceSha, required = REQUIRED_RELEASE_CHECKS) {
  const trustedRun = assertTrustedCiWorkflowRun(workflowRun, expectedSourceSha);
  if (!Array.isArray(jobs)) throw new Error("exact workflow-run all-execution jobs must be an array");
  const requiredSet = new Set(required);
  const executionsByName = new Map();
  const jobIds = new Set();
  for (const job of jobs) {
    const trustedJob = assertTrustedWorkflowJob(job, trustedRun, expectedSourceSha, "CI job");
    if (jobIds.has(trustedJob.id)) throw new Error(`duplicate CI job id: ${trustedJob.id}`);
    jobIds.add(trustedJob.id);
    const name = trustedJob.name;
    if (!requiredSet.has(name)) continue;
    const executions = executionsByName.get(name) ?? [];
    executions.push(trustedJob);
    executionsByName.set(name, executions);
  }
  const authoritative = new Map();
  for (const [name, executions] of executionsByName) {
    const maximumAttempt = Math.max(...executions.map((job) => job.run_attempt));
    const maximumExecutions = executions.filter((job) => job.run_attempt === maximumAttempt);
    if (maximumExecutions.length !== 1) {
      throw new Error(`duplicate required CI job in exact workflow-run attempt ${maximumAttempt}: ${name}`);
    }
    authoritative.set(name, maximumExecutions[0]);
  }

  const succeeded = [];
  const missing = [];
  const pending = [];
  const failed = [];
  for (const name of required) {
    const job = authoritative.get(name);
    if (!job) {
      missing.push(name);
      continue;
    }
    if (job.status !== "completed" || job.conclusion == null) {
      pending.push(name);
      continue;
    }
    if (job.conclusion !== "success") {
      failed.push({ name, conclusion: String(job.conclusion) });
      continue;
    }
    succeeded.push(name);
  }

  const workflowPending = trustedRun.status !== "completed";
  return {
    state: workflowPending
      ? "pending"
      : failed.length > 0
        ? "failed"
        : missing.length > 0 || pending.length > 0
          ? "pending"
          : "ready",
    succeeded,
    missing,
    pending: workflowPending ? ["CI workflow run", ...pending] : pending,
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
  if (
    expectedNames.length === 0 ||
    expectedNames.some((name) => typeof name !== "string" || name.length === 0) ||
    new Set(expectedNames).size !== expectedNames.length
  ) {
    throw new Error("expected Basic release asset names must be a non-empty unique list");
  }
  if (!isRecord(input) || !Object.hasOwn(input, "release") || !Array.isArray(input.assets)) {
    throw new Error("GitHub release state must explicitly contain release and assets");
  }
  const release = input.release;
  const assets = input.assets;
  if (release === null) {
    if (assets.length !== 0) throw new Error("absent release cannot have assets");
    return { action: "create_draft", missing: [...expectedNames] };
  }
  if (
    !isRecord(release) ||
    !isPositiveSafeInteger(release.id) ||
    release.tag_name !== expected.tag ||
    release.prerelease !== expected.prerelease ||
    typeof release.draft !== "boolean"
  ) {
    throw new Error("GitHub release id, tag, channel, or draft identity diverged");
  }
  const counts = new Map();
  const assetIds = new Set();
  for (const asset of assets) {
    if (!isRecord(asset) || typeof asset.name !== "string" || asset.name.length === 0) {
      throw new Error("GitHub release asset is missing a name");
    }
    if (!isPositiveSafeInteger(asset.id)) {
      throw new Error(`GitHub release asset ${asset.name} is missing a positive safe-integer id`);
    }
    if (assetIds.has(asset.id)) throw new Error(`duplicate GitHub release asset id: ${String(asset.id)}`);
    assetIds.add(asset.id);
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
  if (typeof sourceSha !== "string" || !/^[0-9a-f]{40}$/u.test(sourceSha)) {
    throw new Error("candidate source SHA must be one exact lowercase SHA-1");
  }
  const seen = new Set();
  for (const run of runs) {
    const trustedRun = assertTrustedCiWorkflowRun(run, sourceSha);
    const id = String(trustedRun.id);
    if (seen.has(id)) throw new Error(`duplicate candidate workflow run id: ${id}`);
    seen.add(id);
  }
  return [...runs].sort((left, right) => left.id - right.id).map((run) => String(run.id));
}

function optionalPositiveSafeIntegerPin(value, label) {
  if (value === undefined || value === null || value === "") return null;
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text !== "string" || !/^[1-9]\d*$/u.test(text)) {
    throw new Error(`${label} must be one canonical positive safe integer`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || String(parsed) !== text) {
    throw new Error(`${label} must be one canonical positive safe integer`);
  }
  return parsed;
}

function optionalExactSha256DigestPin(value, label) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`${label} must be one exact lowercase SHA-256 digest`);
  }
  return value;
}

/**
 * Classify one Actions run and bind a unique live artifact ID and digest.
 *
 * @param {unknown} input - Jobs, artifacts, and optional provenance pins for one run.
 * @returns {{state:"skip"}|{state:"selected",artifactId:string,digest:string,runAttempt:number}}
 *   Selection state and immutable candidate identity when selected.
 */
export function evaluateMcpbCandidateRun(input) {
  if (!isRecord(input) || !Array.isArray(input.jobs) || !Array.isArray(input.artifacts)) {
    throw new Error("Actions candidate state must explicitly contain jobs and artifacts");
  }
  const trustedRun = assertTrustedCiWorkflowRun(input.workflowRun, input.expectedSourceSha);
  const jobs = input.jobs;
  const artifacts = input.artifacts;
  const jobIds = new Set();
  for (const job of jobs) {
    const trustedJob = assertTrustedWorkflowJob(job, trustedRun, input.expectedSourceSha, "candidate CI job");
    if (jobIds.has(trustedJob.id)) throw new Error(`duplicate candidate CI job id: ${trustedJob.id}`);
    jobIds.add(trustedJob.id);
  }
  const latestNamedJob = (name) => {
    const named = jobs.filter((job) => job?.name === name);
    const latestAttempt = named.length > 0 ? Math.max(...named.map((job) => job.run_attempt)) : 0;
    const latest = named.filter((job) => job.run_attempt === latestAttempt);
    if (latest.length > 1) throw new Error(`duplicate latest-attempt ${name} jobs`);
    return latest[0];
  };
  const aggregate = latestNamedJob("mcpb-basic");
  if (aggregate?.status !== "completed" || aggregate?.conclusion !== "success") {
    return { state: "skip" };
  }
  const producer = latestNamedJob("mcpb-basic-package");
  if (producer?.status !== "completed" || producer?.conclusion !== "success") {
    return { state: "skip" };
  }
  const producerAttempt = producer.run_attempt;
  if (aggregate.run_attempt < producerAttempt) return { state: "skip" };
  const pinnedRunAttempt = optionalPositiveSafeIntegerPin(input.pinnedRunAttempt, "pinned producer attempt");
  if (pinnedRunAttempt !== null && pinnedRunAttempt !== producerAttempt) {
    throw new Error("canonical Actions artifact producer attempt differs from release provenance");
  }
  const artifactIds = new Set();
  for (const artifact of artifacts) {
    if (
      !isRecord(artifact) ||
      !isPositiveSafeInteger(artifact.id) ||
      typeof artifact.name !== "string" ||
      artifact.name.length === 0 ||
      typeof artifact.expired !== "boolean" ||
      (artifact.digest !== null &&
        (typeof artifact.digest !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(artifact.digest)))
    ) {
      throw new Error("Actions artifact collection contains an invalid identity");
    }
    if (artifactIds.has(artifact.id)) throw new Error(`duplicate Actions artifact id: ${String(artifact.id)}`);
    artifactIds.add(artifact.id);
  }
  const expectedName = `mcpb-basic-candidate-${producerAttempt}`;
  const live = artifacts.filter((artifact) => artifact?.name === expectedName && artifact?.expired === false);
  if (live.length > 1) throw new Error(`duplicate live ${expectedName} artifacts`);
  if (live.length === 0) return { state: "skip" };
  const artifact = live[0];
  const artifactId = String(artifact.id);
  const digest = artifact?.digest;
  if (typeof digest !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(digest)) {
    throw new Error("canonical Actions artifact lacks an exact id or SHA-256 digest");
  }
  const pinnedArtifactId = optionalPositiveSafeIntegerPin(input.pinnedArtifactId, "pinned artifact id");
  if (pinnedArtifactId !== null && pinnedArtifactId !== artifact.id) {
    throw new Error("canonical Actions artifact id differs from release provenance");
  }
  const pinnedDigest = optionalExactSha256DigestPin(input.pinnedDigest, "pinned artifact digest");
  if (pinnedDigest !== null && pinnedDigest !== digest) {
    throw new Error("canonical Actions artifact digest differs from release provenance");
  }
  return { state: "selected", artifactId, digest, runAttempt: producerAttempt };
}

function usage() {
  return [
    "Usage: check-release-integrity.mjs",
    "assert-tag <tag> <version> | asset-version <version> | channel-advance <candidate> <current> <channel> |",
    "checks <source-sha> | flatten-pages <release|asset> | flatten-field <workflow_runs|jobs|artifacts> |",
    "npm-state | release-state | candidate-runs <source-sha> | candidate <source-sha>"
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
      console.log(JSON.stringify(evaluateReleaseChecks(payload?.jobs, payload?.workflow_run, first)));
    } else if (mode === "flatten-pages") {
      const payload = JSON.parse(readFileSync(0, "utf8"));
      console.log(JSON.stringify(flattenPaginatedArrays(payload, first)));
    } else if (mode === "flatten-field") {
      const payload = JSON.parse(readFileSync(0, "utf8"));
      console.log(JSON.stringify(flattenPaginatedField(payload, first)));
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
            workflowRun: payload?.workflow_run,
            expectedSourceSha: first,
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
