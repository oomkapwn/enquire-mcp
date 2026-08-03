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

import { Buffer } from "node:buffer";
import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
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

const PROVENANCE_CONTEXT_FIELDS = Object.freeze([
  "eventName",
  "sha",
  "ref",
  "refName",
  "refType",
  "repository",
  "repositoryId",
  "repositoryOwnerId",
  "serverUrl",
  "workflowRef",
  "workflowSha",
  "runId",
  "runAttempt",
  "runnerEnvironment"
]);

const PROVENANCE_ENVIRONMENT_BINDINGS = Object.freeze({
  eventName: ["PROVENANCE_EVENT_NAME", "GITHUB_EVENT_NAME"],
  sha: ["PROVENANCE_SHA", "GITHUB_SHA"],
  ref: ["PROVENANCE_REF", "GITHUB_REF"],
  refName: ["PROVENANCE_REF_NAME", "GITHUB_REF_NAME"],
  refType: ["PROVENANCE_REF_TYPE", "GITHUB_REF_TYPE"],
  repository: ["PROVENANCE_REPOSITORY", "GITHUB_REPOSITORY"],
  repositoryId: ["PROVENANCE_REPOSITORY_ID", "GITHUB_REPOSITORY_ID"],
  repositoryOwnerId: ["PROVENANCE_REPOSITORY_OWNER_ID", "GITHUB_REPOSITORY_OWNER_ID"],
  serverUrl: ["PROVENANCE_SERVER_URL", "GITHUB_SERVER_URL"],
  workflowRef: ["PROVENANCE_WORKFLOW_REF", "GITHUB_WORKFLOW_REF"],
  workflowSha: ["PROVENANCE_WORKFLOW_SHA", "GITHUB_WORKFLOW_SHA"],
  runId: ["PROVENANCE_RUN_ID", "GITHUB_RUN_ID"],
  runAttempt: ["PROVENANCE_RUN_ATTEMPT", "GITHUB_RUN_ATTEMPT"],
  runnerEnvironment: ["PROVENANCE_RUNNER_ENVIRONMENT", "RUNNER_ENVIRONMENT"]
});

const NPM_PROVENANCE_IDENTITY = Object.freeze({
  packageName: "@oomkapwn/enquire-mcp",
  repository: "oomkapwn/enquire-mcp",
  repositoryId: "1227411427",
  repositoryOwnerId: "274092130",
  serverUrl: "https://github.com",
  runnerEnvironment: "github-hosted",
  workflowPath: ".github/workflows/release.yml",
  registry: "https://registry.npmjs.org/",
  publishRegistry: "https://registry.npmjs.org",
  attestationBaseUrl: "https://registry.npmjs.org/-/npm/v1/attestations/",
  bundleMediaType: "application/vnd.dev.sigstore.bundle+json;version=0.2",
  payloadType: "application/vnd.in-toto+json",
  publishPredicateType: "https://github.com/npm/attestation/tree/main/specs/publish/v0.1",
  slsaPredicateType: "https://slsa.dev/provenance/v1",
  slsaBuildType: "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1"
});

const FULCIO_GITHUB_ACTIONS_ISSUER = "https://token.actions.githubusercontent.com";
const FULCIO_ISSUER_OID_LEGACY = Buffer.from("2b0601040183bf300101", "hex");
const FULCIO_ISSUER_OID_V2 = Buffer.from("2b0601040183bf300108", "hex");
const MCP_REGISTRY_IDENTITY = Object.freeze({
  apiBase: "https://registry.modelcontextprotocol.io/v0.1/servers",
  mcpName: "io.github.oomkapwn/enquire-mcp",
  packageName: "@oomkapwn/enquire-mcp",
  repositoryUrl: "https://github.com/oomkapwn/enquire-mcp",
  schema: "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json"
});
const MCP_REGISTRY_OFFICIAL_META = "io.modelcontextprotocol.registry/official";

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

function isCanonicalSha512Sri(value) {
  if (typeof value !== "string" || !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(value)) return false;
  const encoded = value.slice("sha512-".length);
  const decoded = Buffer.from(encoded, "base64");
  return decoded.length === 64 && decoded.toString("base64") === encoded;
}

function assertExactRecord(value, expectedKeys, label) {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const actualKeys = Object.keys(value);
  const expected = new Set(expectedKeys);
  if (actualKeys.length !== expected.size || actualKeys.some((key) => !expected.has(key))) {
    throw new Error(`${label} must contain exactly ${expectedKeys.join(", ")}`);
  }
  return value;
}

function assertAllowedRecord(value, allowedKeys, label) {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const allowed = new Set(allowedKeys);
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) throw new Error(`${label} has unexpected fields: ${unexpected.join(", ")}`);
  return value;
}

function assertCanonicalPositiveDecimal(value, label) {
  if (typeof value !== "string" || !/^[1-9]\d*$/u.test(value)) {
    throw new Error(`${label} must be one canonical positive decimal string`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || String(parsed) !== value) {
    throw new Error(`${label} must be one canonical positive safe-integer string`);
  }
  return value;
}

function assertCanonicalReleaseTag(tag) {
  if (typeof tag !== "string") throw new Error("release tag must be one canonical SemVer tag");
  const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u.exec(tag);
  if (!match) throw new Error("release tag must be one canonical SemVer tag without build metadata");
  const prerelease = match[4]?.split(".") ?? [];
  if (prerelease.some((identifier) => /^\d+$/u.test(identifier) && identifier.length > 1 && identifier[0] === "0")) {
    throw new Error("release tag has a numeric prerelease identifier with a leading zero");
  }
  return tag;
}

function decodeCanonicalBase64(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
  ) {
    throw new Error(`${label} must be canonical base64`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 0 || decoded.toString("base64") !== value) {
    throw new Error(`${label} must be canonical base64`);
  }
  return decoded;
}

function decodeCanonicalBase64Json(value, label) {
  const decoded = decodeCanonicalBase64(value, label);
  const json = decoded.toString("utf8");
  if (!Buffer.from(json, "utf8").equals(decoded)) {
    throw new Error(`${label} must contain valid UTF-8 JSON`);
  }
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(`${label} must contain valid JSON`);
  }
  if (!isRecord(parsed)) throw new Error(`${label} JSON must be an object`);
  return parsed;
}

function readDerElement(bytes, offset, limit, label) {
  if (!Buffer.isBuffer(bytes) || !Number.isSafeInteger(offset) || !Number.isSafeInteger(limit)) {
    throw new Error(`${label} has an invalid DER reader boundary`);
  }
  if (offset < 0 || limit > bytes.length || offset >= limit || limit - offset < 2) {
    throw new Error(`${label} has a truncated DER element`);
  }
  const tag = bytes[offset];
  if (tag === undefined || (tag & 0x1f) === 0x1f) {
    throw new Error(`${label} uses an unsupported DER tag`);
  }
  const firstLength = bytes[offset + 1];
  if (firstLength === undefined) throw new Error(`${label} has a truncated DER length`);
  let contentStart = offset + 2;
  let contentLength = firstLength;
  if ((firstLength & 0x80) !== 0) {
    const lengthOctets = firstLength & 0x7f;
    if (lengthOctets === 0 || lengthOctets > 4 || contentStart + lengthOctets > limit) {
      throw new Error(`${label} has an invalid DER long-form length`);
    }
    if (bytes[contentStart] === 0) throw new Error(`${label} has a non-canonical DER length`);
    contentLength = 0;
    for (let index = 0; index < lengthOctets; index++) {
      const octet = bytes[contentStart + index];
      if (octet === undefined) throw new Error(`${label} has a truncated DER length`);
      contentLength = contentLength * 256 + octet;
    }
    if (contentLength < 128) throw new Error(`${label} has a non-canonical DER long-form length`);
    contentStart += lengthOctets;
  }
  const contentEnd = contentStart + contentLength;
  if (!Number.isSafeInteger(contentEnd) || contentEnd > limit) {
    throw new Error(`${label} has a DER element outside its parent boundary`);
  }
  return { tag, contentStart, contentEnd, next: contentEnd };
}

function decodeCanonicalDerUtf8String(bytes, label) {
  const value = readDerElement(bytes, 0, bytes.length, label);
  if (value.tag !== 0x0c || value.next !== bytes.length) {
    throw new Error(`${label} must contain exactly one DER UTF8String`);
  }
  const encoded = bytes.subarray(value.contentStart, value.contentEnd);
  const decoded = encoded.toString("utf8");
  if (!Buffer.from(decoded, "utf8").equals(encoded)) {
    throw new Error(`${label} must contain canonical UTF-8`);
  }
  return decoded;
}

function assertExactFulcioOidcIssuer(certificateDer, label) {
  const certificate = readDerElement(certificateDer, 0, certificateDer.length, `${label} certificate`);
  if (certificate.tag !== 0x30 || certificate.next !== certificateDer.length) {
    throw new Error(`${label} certificate must be one exact DER sequence`);
  }
  let outerCursor = certificate.contentStart;
  const tbs = readDerElement(certificateDer, outerCursor, certificate.contentEnd, `${label} TBSCertificate`);
  if (tbs.tag !== 0x30) throw new Error(`${label} lacks an exact TBSCertificate sequence`);
  outerCursor = tbs.next;
  const signatureAlgorithm = readDerElement(
    certificateDer,
    outerCursor,
    certificate.contentEnd,
    `${label} signature algorithm`
  );
  outerCursor = signatureAlgorithm.next;
  const signatureValue = readDerElement(
    certificateDer,
    outerCursor,
    certificate.contentEnd,
    `${label} signature value`
  );
  if (
    signatureAlgorithm.tag !== 0x30 ||
    signatureValue.tag !== 0x03 ||
    signatureValue.next !== certificate.contentEnd
  ) {
    throw new Error(`${label} certificate has an invalid outer DER structure`);
  }

  let cursor = tbs.contentStart;
  let field = readDerElement(certificateDer, cursor, tbs.contentEnd, `${label} certificate version`);
  if (field.tag === 0xa0) {
    cursor = field.next;
  }
  const requiredTags = [0x02, 0x30, 0x30, 0x30, 0x30, 0x30];
  for (const expectedTag of requiredTags) {
    field = readDerElement(certificateDer, cursor, tbs.contentEnd, `${label} TBSCertificate field`);
    if (field.tag !== expectedTag) throw new Error(`${label} has an invalid TBSCertificate field order`);
    cursor = field.next;
  }
  while (cursor < tbs.contentEnd) {
    field = readDerElement(certificateDer, cursor, tbs.contentEnd, `${label} TBSCertificate optional field`);
    if (field.tag === 0x81 || field.tag === 0x82) {
      cursor = field.next;
      continue;
    }
    break;
  }
  if (field.tag !== 0xa3 || field.next !== tbs.contentEnd) {
    throw new Error(`${label} certificate must contain one final extensions field`);
  }
  const extensions = readDerElement(certificateDer, field.contentStart, field.contentEnd, `${label} extensions`);
  if (extensions.tag !== 0x30 || extensions.next !== field.contentEnd) {
    throw new Error(`${label} certificate extensions must be one exact DER sequence`);
  }

  let legacyIssuerCount = 0;
  let v2IssuerCount = 0;
  cursor = extensions.contentStart;
  while (cursor < extensions.contentEnd) {
    const extension = readDerElement(certificateDer, cursor, extensions.contentEnd, `${label} extension`);
    if (extension.tag !== 0x30) throw new Error(`${label} has a malformed certificate extension`);
    let extensionCursor = extension.contentStart;
    const oid = readDerElement(certificateDer, extensionCursor, extension.contentEnd, `${label} extension OID`);
    if (oid.tag !== 0x06) throw new Error(`${label} certificate extension lacks an OID`);
    extensionCursor = oid.next;
    let value = readDerElement(certificateDer, extensionCursor, extension.contentEnd, `${label} extension value`);
    if (value.tag === 0x01) {
      if (
        value.contentEnd - value.contentStart !== 1 ||
        (certificateDer[value.contentStart] !== 0x00 && certificateDer[value.contentStart] !== 0xff)
      ) {
        throw new Error(`${label} certificate extension has a malformed critical flag`);
      }
      extensionCursor = value.next;
      value = readDerElement(certificateDer, extensionCursor, extension.contentEnd, `${label} extension value`);
    }
    if (value.tag !== 0x04 || value.next !== extension.contentEnd) {
      throw new Error(`${label} certificate extension must end in one OCTET STRING`);
    }

    const oidBytes = certificateDer.subarray(oid.contentStart, oid.contentEnd);
    const valueBytes = certificateDer.subarray(value.contentStart, value.contentEnd);
    if (oidBytes.equals(FULCIO_ISSUER_OID_LEGACY)) {
      legacyIssuerCount++;
      if (legacyIssuerCount > 1) {
        throw new Error(`${label} certificate contains duplicate Fulcio legacy OIDC issuer extensions`);
      }
      if (
        valueBytes.toString("utf8") !== FULCIO_GITHUB_ACTIONS_ISSUER ||
        !Buffer.from(FULCIO_GITHUB_ACTIONS_ISSUER, "utf8").equals(valueBytes)
      ) {
        throw new Error(`${label} Fulcio legacy OIDC issuer is not GitHub Actions`);
      }
    } else if (oidBytes.equals(FULCIO_ISSUER_OID_V2)) {
      v2IssuerCount++;
      if (v2IssuerCount > 1) {
        throw new Error(`${label} certificate contains duplicate Fulcio v2 OIDC issuer extensions`);
      }
      if (decodeCanonicalDerUtf8String(valueBytes, `${label} Fulcio v2 OIDC issuer`) !== FULCIO_GITHUB_ACTIONS_ISSUER) {
        throw new Error(`${label} Fulcio v2 OIDC issuer is not GitHub Actions`);
      }
    }
    cursor = extension.next;
  }
  if (legacyIssuerCount + v2IssuerCount === 0) {
    throw new Error(`${label} certificate lacks a supported Fulcio OIDC issuer extension`);
  }
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
 * @param {unknown} expectedIntegrity - Exact SHA-512 SRI of the canonical tarball.
 * @param {unknown} expectedVersion - Exact package version being released.
 * @param {unknown} expectedChannel - npm dist-tag derived from that version.
 * @returns {{action:"publish"|"reuse"|"reuse_superseded",channelVersion?:string}} Safe next action.
 */
export function evaluateNpmPublication(state, expectedSha, expectedIntegrity, expectedVersion, expectedChannel) {
  assertChannelVersionAdvance(expectedVersion, "-", expectedChannel);
  if (!isExactSha1(expectedSha)) {
    throw new Error("expected npm source SHA must be one exact lowercase SHA-1");
  }
  if (!isCanonicalSha512Sri(expectedIntegrity)) {
    throw new Error("expected npm tarball integrity must be one canonical SHA-512 SRI");
  }
  if (!isRecord(state) || typeof state.exists !== "boolean") {
    throw new Error("npm publication state must be explicitly present or absent");
  }
  if (state.exists === false) return { action: "publish" };
  if (Object.hasOwn(state, "gitHead") && state.gitHead !== null && !isExactSha1(state.gitHead)) {
    throw new Error(`npm gitHead ${JSON.stringify(state.gitHead)} is present but malformed`);
  }
  if (Object.hasOwn(state, "gitHead") && state.gitHead !== null && state.gitHead !== expectedSha) {
    throw new Error(`npm gitHead ${JSON.stringify(state.gitHead)} does not match ${JSON.stringify(expectedSha)}`);
  }
  if (state.integrity !== expectedIntegrity) {
    throw new Error(
      `npm tarball integrity ${JSON.stringify(state.integrity)} does not match ${JSON.stringify(expectedIntegrity)}`
    );
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
 * Bind npm's declared provenance inputs to the immutable GitHub tag-push
 * runtime before the first registry write.
 *
 * The two copies deliberately come from different trust surfaces: `declared`
 * is populated from workflow-expression aliases while `runtime` is populated
 * from GitHub's default runtime environment. Both must be complete and
 * byte-equal before their values are compared with the release identity.
 *
 * @param {unknown} context - Declared and runtime GitHub provenance fields.
 * @param {unknown} expectedSourceSha - Exact checked-out release source SHA.
 * @param {unknown} expectedTag - Exact `v<version>` release tag.
 * @returns {{runId:string,runAttempt:string}} Canonical invocation identity.
 * @example
 * evaluateNpmProvenanceContext({ declared, runtime }, sourceSha, "v4.0.0-rc.3");
 */
export function evaluateNpmProvenanceContext(context, expectedSourceSha, expectedTag) {
  assertExactRecord(context, ["declared", "runtime"], "npm provenance context");
  const declared = assertExactRecord(context.declared, PROVENANCE_CONTEXT_FIELDS, "declared npm provenance context");
  const runtime = assertExactRecord(context.runtime, PROVENANCE_CONTEXT_FIELDS, "runtime npm provenance context");
  if (!isExactSha1(expectedSourceSha)) {
    throw new Error("expected npm provenance source SHA must be one exact lowercase SHA-1");
  }
  assertCanonicalReleaseTag(expectedTag);

  for (const field of PROVENANCE_CONTEXT_FIELDS) {
    if (typeof declared[field] !== "string" || typeof runtime[field] !== "string") {
      throw new Error(`npm provenance ${field} must be declared and observed as strings`);
    }
    if (declared[field] !== runtime[field]) {
      throw new Error(`declared npm provenance ${field} differs from the GitHub runtime`);
    }
  }

  const expectedRef = `refs/tags/${expectedTag}`;
  const expectedWorkflowRef = `${NPM_PROVENANCE_IDENTITY.repository}/${NPM_PROVENANCE_IDENTITY.workflowPath}@${expectedRef}`;
  const fixed = {
    eventName: "push",
    sha: expectedSourceSha,
    ref: expectedRef,
    refName: expectedTag,
    refType: "tag",
    repository: NPM_PROVENANCE_IDENTITY.repository,
    repositoryId: NPM_PROVENANCE_IDENTITY.repositoryId,
    repositoryOwnerId: NPM_PROVENANCE_IDENTITY.repositoryOwnerId,
    serverUrl: NPM_PROVENANCE_IDENTITY.serverUrl,
    workflowRef: expectedWorkflowRef,
    workflowSha: expectedSourceSha,
    runnerEnvironment: NPM_PROVENANCE_IDENTITY.runnerEnvironment
  };
  for (const [field, expected] of Object.entries(fixed)) {
    if (declared[field] !== expected) {
      throw new Error(`npm provenance ${field} does not match the exact tag-push release identity`);
    }
  }

  return {
    runId: assertCanonicalPositiveDecimal(declared.runId, "npm provenance run id"),
    runAttempt: assertCanonicalPositiveDecimal(declared.runAttempt, "npm provenance run attempt")
  };
}

function assertExactNpmSubject(statement, expectedPurl, expectedSha512, label) {
  if (!Array.isArray(statement.subject) || statement.subject.length !== 1) {
    throw new Error(`${label} must contain exactly one subject`);
  }
  const subject = assertExactRecord(statement.subject[0], ["name", "digest"], `${label} subject`);
  const digest = assertExactRecord(subject.digest, ["sha512"], `${label} subject digest`);
  if (subject.name !== expectedPurl || digest.sha512 !== expectedSha512) {
    throw new Error(`${label} subject does not match the exact npm PURL and SHA-512 tarball`);
  }
}

function assertExactNpmVerificationMaterial(predicateType, material, keyid, expectedSignerUri, label) {
  const publish = predicateType === NPM_PROVENANCE_IDENTITY.publishPredicateType;
  const exactKeys = publish
    ? ["publicKey", "tlogEntries", "timestampVerificationData"]
    : ["x509CertificateChain", "tlogEntries", "timestampVerificationData"];
  const verified = assertExactRecord(material, exactKeys, `${label} verification material`);
  if (
    !Array.isArray(verified.tlogEntries) ||
    verified.tlogEntries.length === 0 ||
    verified.tlogEntries.some((entry) => !isRecord(entry)) ||
    !isRecord(verified.timestampVerificationData)
  ) {
    throw new Error(`${label} verification material lacks verified transparency evidence`);
  }

  if (publish) {
    const publicKey = assertExactRecord(verified.publicKey, ["hint"], `${label} publish public key`);
    if (typeof publicKey.hint !== "string" || !/^SHA256:[A-Za-z0-9+/]{43}$/u.test(publicKey.hint)) {
      throw new Error(`${label} publish public-key hint is not canonical`);
    }
    const encodedHint = publicKey.hint.slice("SHA256:".length);
    const hintDigest = Buffer.from(encodedHint, "base64");
    if (
      hintDigest.length !== 32 ||
      hintDigest.toString("base64").replace(/=+$/u, "") !== encodedHint ||
      keyid !== publicKey.hint
    ) {
      throw new Error(`${label} publish DSSE key id does not match the exact SHA-256 public-key hint`);
    }
    return;
  }

  const chain = assertExactRecord(verified.x509CertificateChain, ["certificates"], `${label} SLSA certificate chain`);
  if (!Array.isArray(chain.certificates) || chain.certificates.length !== 1) {
    throw new Error(`${label} SLSA verification material must contain exactly one signing certificate`);
  }
  const certificate = assertExactRecord(chain.certificates[0], ["rawBytes"], `${label} SLSA signing certificate`);
  const certificateDer = decodeCanonicalBase64(certificate.rawBytes, `${label} SLSA signing certificate`);
  if (keyid !== "") {
    throw new Error(`${label} SLSA DSSE key id must be empty for keyless Fulcio signing`);
  }
  let leafCertificate;
  try {
    leafCertificate = new X509Certificate(certificateDer);
  } catch {
    throw new Error(`${label} SLSA signing certificate must be valid DER X.509`);
  }
  if (leafCertificate.subjectAltName !== `URI:${expectedSignerUri}`) {
    throw new Error(`${label} SLSA certificate SAN does not match the exact tagged workflow signer`);
  }
  assertExactFulcioOidcIssuer(certificateDer, label);
}

function decodeNpmAttestationWrapper(item, index, expectedSignerUri) {
  const label = `npm attestation bundle ${index + 1}`;
  if (!isRecord(item)) throw new Error(`${label} must be an object`);
  const hasSignedAccessUrl = Object.hasOwn(item, "signedAccessSignatureUrl");
  assertExactRecord(
    item,
    hasSignedAccessUrl ? ["predicateType", "bundle", "signedAccessSignatureUrl"] : ["predicateType", "bundle"],
    label
  );
  if (hasSignedAccessUrl && item.signedAccessSignatureUrl !== "") {
    throw new Error(`${label} has an unexpected signed-access URL`);
  }
  if (
    item.predicateType !== NPM_PROVENANCE_IDENTITY.publishPredicateType &&
    item.predicateType !== NPM_PROVENANCE_IDENTITY.slsaPredicateType
  ) {
    throw new Error(`${label} has an unknown predicate type`);
  }

  const bundle = assertExactRecord(
    item.bundle,
    ["mediaType", "verificationMaterial", "dsseEnvelope"],
    `${label} Sigstore bundle`
  );
  if (bundle.mediaType !== NPM_PROVENANCE_IDENTITY.bundleMediaType || !isRecord(bundle.verificationMaterial)) {
    throw new Error(`${label} has an invalid Sigstore bundle identity`);
  }
  const envelope = assertExactRecord(
    bundle.dsseEnvelope,
    ["payload", "payloadType", "signatures"],
    `${label} DSSE envelope`
  );
  if (envelope.payloadType !== NPM_PROVENANCE_IDENTITY.payloadType) {
    throw new Error(`${label} has an invalid DSSE payload type`);
  }
  if (!Array.isArray(envelope.signatures) || envelope.signatures.length !== 1) {
    throw new Error(`${label} must contain exactly one verified DSSE signature`);
  }
  const signature = assertExactRecord(envelope.signatures[0], ["sig", "keyid"], `${label} DSSE signature`);
  if (!isNonEmptyString(signature.sig) || typeof signature.keyid !== "string") {
    throw new Error(`${label} has an invalid DSSE signature identity`);
  }
  assertExactNpmVerificationMaterial(
    item.predicateType,
    bundle.verificationMaterial,
    signature.keyid,
    expectedSignerUri,
    label
  );

  const statement = decodeCanonicalBase64Json(envelope.payload, `${label} DSSE payload`);
  assertExactRecord(statement, ["_type", "subject", "predicateType", "predicate"], `${label} statement`);
  if (statement.predicateType !== item.predicateType) {
    throw new Error(`${label} wrapper and signed predicate types differ`);
  }
  return { predicateType: item.predicateType, statement };
}

function assertExactNpmPublishStatement(statement, expected) {
  if (statement._type !== "https://in-toto.io/Statement/v0.1") {
    throw new Error("npm publish attestation has an invalid statement type");
  }
  assertExactNpmSubject(statement, expected.purl, expected.sha512, "npm publish attestation");
  const predicate = assertExactRecord(
    statement.predicate,
    ["name", "version", "registry"],
    "npm publish attestation predicate"
  );
  if (
    predicate.name !== expected.name ||
    predicate.version !== expected.version ||
    predicate.registry !== NPM_PROVENANCE_IDENTITY.publishRegistry
  ) {
    throw new Error("npm publish attestation predicate does not match the exact registry package identity");
  }
}

function assertExactNpmSlsaStatement(statement, expected) {
  if (statement._type !== "https://in-toto.io/Statement/v1") {
    throw new Error("npm SLSA attestation has an invalid statement type");
  }
  assertExactNpmSubject(statement, expected.purl, expected.sha512, "npm SLSA attestation");
  const predicate = assertExactRecord(
    statement.predicate,
    ["buildDefinition", "runDetails"],
    "npm SLSA attestation predicate"
  );
  const buildDefinition = assertExactRecord(
    predicate.buildDefinition,
    ["buildType", "externalParameters", "internalParameters", "resolvedDependencies"],
    "npm SLSA build definition"
  );
  if (buildDefinition.buildType !== NPM_PROVENANCE_IDENTITY.slsaBuildType) {
    throw new Error("npm SLSA build type does not match the GitHub Actions workflow contract");
  }

  const externalParameters = assertExactRecord(
    buildDefinition.externalParameters,
    ["workflow"],
    "npm SLSA external parameters"
  );
  const workflow = assertExactRecord(
    externalParameters.workflow,
    ["ref", "repository", "path"],
    "npm SLSA workflow identity"
  );
  const expectedRef = `refs/tags/${expected.tag}`;
  const repositoryUrl = `${NPM_PROVENANCE_IDENTITY.serverUrl}/${NPM_PROVENANCE_IDENTITY.repository}`;
  if (
    workflow.ref !== expectedRef ||
    workflow.repository !== repositoryUrl ||
    workflow.path !== NPM_PROVENANCE_IDENTITY.workflowPath
  ) {
    throw new Error("npm SLSA workflow does not match the exact tagged release workflow");
  }

  const internalParameters = assertExactRecord(
    buildDefinition.internalParameters,
    ["github"],
    "npm SLSA internal parameters"
  );
  const github = assertExactRecord(
    internalParameters.github,
    ["event_name", "repository_id", "repository_owner_id"],
    "npm SLSA GitHub identity"
  );
  if (
    github.event_name !== "push" ||
    github.repository_id !== NPM_PROVENANCE_IDENTITY.repositoryId ||
    github.repository_owner_id !== NPM_PROVENANCE_IDENTITY.repositoryOwnerId
  ) {
    throw new Error("npm SLSA GitHub identity does not match the exact tag-push repository");
  }

  if (!Array.isArray(buildDefinition.resolvedDependencies) || buildDefinition.resolvedDependencies.length !== 1) {
    throw new Error("npm SLSA provenance must contain exactly one resolved source dependency");
  }
  const dependency = assertExactRecord(
    buildDefinition.resolvedDependencies[0],
    ["uri", "digest"],
    "npm SLSA resolved source dependency"
  );
  const dependencyDigest = assertExactRecord(dependency.digest, ["gitCommit"], "npm SLSA resolved source digest");
  if (dependency.uri !== `git+${repositoryUrl}@${expectedRef}` || dependencyDigest.gitCommit !== expected.sourceSha) {
    throw new Error("npm SLSA resolved dependency does not match the exact tagged source SHA");
  }

  const runDetails = assertExactRecord(predicate.runDetails, ["builder", "metadata"], "npm SLSA run details");
  const builder = assertExactRecord(runDetails.builder, ["id"], "npm SLSA builder identity");
  if (builder.id !== `${NPM_PROVENANCE_IDENTITY.serverUrl}/actions/runner/github-hosted`) {
    throw new Error("npm SLSA builder is not the exact GitHub-hosted runner identity");
  }
  const metadata = assertExactRecord(runDetails.metadata, ["invocationId"], "npm SLSA invocation metadata");
  if (typeof metadata.invocationId !== "string") {
    throw new Error("npm SLSA invocation id must be a string");
  }
  const invocationMatch =
    /^https:\/\/github\.com\/oomkapwn\/enquire-mcp\/actions\/runs\/([1-9]\d*)\/attempts\/([1-9]\d*)$/u.exec(
      metadata.invocationId
    );
  if (!invocationMatch) throw new Error("npm SLSA invocation id is not canonical for this repository");
  const runId = assertCanonicalPositiveDecimal(invocationMatch[1], "signed npm provenance run id");
  const runAttempt = assertCanonicalPositiveDecimal(invocationMatch[2], "signed npm provenance run attempt");
  if (expected.publishAttempted && (runId !== expected.currentRunId || runAttempt !== expected.currentRunAttempt)) {
    throw new Error("fresh npm publication provenance does not match the current workflow invocation");
  }
  return { runId, runAttempt };
}

/**
 * Validate the exact npm target entry and the semantic identity of its two
 * already-cryptographically-verified Sigstore attestations.
 *
 * A fresh publication binds the signed invocation to the current run. A reuse
 * accepts a prior canonical invocation so recovery can reconcile an existing
 * immutable version without replaying `npm publish`; every source, workflow,
 * repository, event, PURL and byte identity remains exact in both modes. The
 * SLSA leaf certificate SAN is independently bound to the expected tagged
 * workflow URI and its Fulcio extension to the GitHub Actions OIDC issuer,
 * rather than trusting the signed payload to name its own signer.
 *
 * @param {unknown} report - JSON from `npm audit signatures --json --include-attestations`.
 * @param {unknown} expected - Exact package, tarball, source, tag, and invocation identity.
 * @returns {{runId:string,runAttempt:string}} Signed provenance invocation identity.
 * @example
 * evaluateNpmProvenanceAttestations(report, expected);
 */
export function evaluateNpmProvenanceAttestations(report, expected) {
  assertExactRecord(
    expected,
    ["name", "version", "integrity", "sourceSha", "tag", "publishAttempted", "currentRunId", "currentRunAttempt"],
    "expected npm provenance identity"
  );
  if (expected.name !== NPM_PROVENANCE_IDENTITY.packageName) {
    throw new Error("expected npm provenance package name is not the release package");
  }
  assertCanonicalReleaseTag(expected.tag);
  assertReleaseTagMatchesVersion(expected.tag, expected.version);
  if (!isCanonicalSha512Sri(expected.integrity)) {
    throw new Error("expected npm provenance integrity must be one canonical SHA-512 SRI");
  }
  if (!isExactSha1(expected.sourceSha)) {
    throw new Error("expected npm provenance source SHA must be one exact lowercase SHA-1");
  }
  if (typeof expected.publishAttempted !== "boolean") {
    throw new Error("expected npm provenance publication mode must be a boolean");
  }
  assertCanonicalPositiveDecimal(expected.currentRunId, "current npm provenance run id");
  assertCanonicalPositiveDecimal(expected.currentRunAttempt, "current npm provenance run attempt");

  assertExactRecord(report, ["invalid", "missing", "verified"], "npm signature audit report");
  if (!Array.isArray(report.invalid) || report.invalid.length !== 0) {
    throw new Error("npm signature audit report contains invalid packages");
  }
  if (!Array.isArray(report.missing) || report.missing.length !== 0) {
    throw new Error("npm signature audit report contains packages with missing signatures");
  }
  if (!Array.isArray(report.verified)) throw new Error("npm signature audit verified entries must be an array");
  for (const entry of report.verified) {
    if (
      !isRecord(entry) ||
      !isNonEmptyString(entry.name) ||
      !isNonEmptyString(entry.version) ||
      !isNonEmptyString(entry.location) ||
      !isNonEmptyString(entry.registry)
    ) {
      throw new Error("npm signature audit contains a malformed verified package identity");
    }
  }
  const targets = report.verified.filter((entry) => entry.name === expected.name);
  if (targets.length !== 1) {
    throw new Error("npm signature audit must contain exactly one verified release-package entry");
  }
  const target = assertExactRecord(
    targets[0],
    ["name", "version", "location", "registry", "attestations", "attestationBundles"],
    "verified npm release-package entry"
  );
  if (
    target.version !== expected.version ||
    target.location !== `node_modules/${expected.name}` ||
    target.registry !== NPM_PROVENANCE_IDENTITY.registry
  ) {
    throw new Error("verified npm release-package entry does not match the exact installed target");
  }

  const attestationUrl = `${NPM_PROVENANCE_IDENTITY.attestationBaseUrl}@oomkapwn%2fenquire-mcp@${expected.version}`;
  const attestations = assertExactRecord(target.attestations, ["url", "provenance"], "npm attestation locator");
  const provenance = assertExactRecord(
    attestations.provenance,
    ["predicateType"],
    "npm attestation provenance locator"
  );
  if (attestations.url !== attestationUrl || provenance.predicateType !== NPM_PROVENANCE_IDENTITY.slsaPredicateType) {
    throw new Error("npm attestation locator does not match the exact registry target");
  }
  if (!Array.isArray(target.attestationBundles) || target.attestationBundles.length !== 2) {
    throw new Error("verified npm release package must contain exactly two attestation bundles");
  }

  const expectedSignerUri =
    `${NPM_PROVENANCE_IDENTITY.serverUrl}/${NPM_PROVENANCE_IDENTITY.repository}/` +
    `${NPM_PROVENANCE_IDENTITY.workflowPath}@refs/tags/${expected.tag}`;
  const statements = new Map();
  for (let index = 0; index < target.attestationBundles.length; index++) {
    const decoded = decodeNpmAttestationWrapper(target.attestationBundles[index], index, expectedSignerUri);
    if (statements.has(decoded.predicateType)) {
      throw new Error(`duplicate npm attestation predicate type: ${decoded.predicateType}`);
    }
    statements.set(decoded.predicateType, decoded.statement);
  }
  const publishStatement = statements.get(NPM_PROVENANCE_IDENTITY.publishPredicateType);
  const slsaStatement = statements.get(NPM_PROVENANCE_IDENTITY.slsaPredicateType);
  if (!publishStatement || !slsaStatement || statements.size !== 2) {
    throw new Error("verified npm release package lacks the exact publish and SLSA attestations");
  }

  const expectedSubject = {
    name: expected.name,
    version: expected.version,
    sourceSha: expected.sourceSha,
    tag: expected.tag,
    publishAttempted: expected.publishAttempted,
    currentRunId: expected.currentRunId,
    currentRunAttempt: expected.currentRunAttempt,
    purl: `pkg:npm/%40oomkapwn/enquire-mcp@${expected.version}`,
    sha512: Buffer.from(expected.integrity.slice("sha512-".length), "base64").toString("hex")
  };
  assertExactNpmPublishStatement(publishStatement, expectedSubject);
  return assertExactNpmSlsaStatement(slsaStatement, expectedSubject);
}

function assertStableMcpRegistryVersion(value, label) {
  if (typeof value !== "string") throw new Error(`${label} must be stable SemVer`);
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(value);
  if (!match) throw new Error(`${label} must be stable SemVer without prerelease or build metadata`);
  return [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])];
}

function compareStableMcpRegistryVersions(left, right) {
  const leftParts = assertStableMcpRegistryVersion(left, "observed MCP Registry version");
  const rightParts = assertStableMcpRegistryVersion(right, "expected MCP Registry version");
  for (let index = 0; index < leftParts.length; index++) {
    if (leftParts[index] < rightParts[index]) return -1;
    if (leftParts[index] > rightParts[index]) return 1;
  }
  return 0;
}

function assertRfc3339Timestamp(value, label) {
  if (typeof value !== "string") throw new Error(`${label} must be an RFC 3339 timestamp`);
  const match =
    /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u.exec(
      value
    );
  if (!match || match[1] === "0000") throw new Error(`${label} must be an RFC 3339 timestamp`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (day > new Date(Date.UTC(year, month, 0)).getUTCDate()) {
    throw new Error(`${label} must contain a real calendar date`);
  }
  return value;
}

function assertMcpRegistryServerShape(value, label) {
  const server = assertAllowedRecord(
    value,
    [
      "$schema",
      "_meta",
      "description",
      "icons",
      "name",
      "packages",
      "remotes",
      "repository",
      "title",
      "version",
      "websiteUrl"
    ],
    label
  );
  if (!isNonEmptyString(server.$schema)) throw new Error(`${label} must name its JSON schema`);
  if (
    typeof server.name !== "string" ||
    Array.from(server.name).length > 200 ||
    !/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/u.test(server.name)
  ) {
    throw new Error(`${label} has an invalid MCP server name`);
  }
  if (
    typeof server.description !== "string" ||
    Array.from(server.description).length < 1 ||
    Array.from(server.description).length > 100
  ) {
    throw new Error(`${label} description must contain 1 to 100 Unicode characters`);
  }
  if (typeof server.version !== "string" || server.version.length < 1 || server.version.length > 255) {
    throw new Error(`${label} has an invalid version`);
  }
  if (server.title !== undefined && (!isNonEmptyString(server.title) || Array.from(server.title).length > 100)) {
    throw new Error(`${label} has an invalid title`);
  }
  if (server.websiteUrl !== undefined && !isNonEmptyString(server.websiteUrl)) {
    throw new Error(`${label} has an invalid website URL`);
  }
  for (const field of ["icons", "packages", "remotes"]) {
    if (server[field] !== undefined && server[field] !== null && !Array.isArray(server[field])) {
      throw new Error(`${label}.${field} must be an array or null`);
    }
  }
  if (server.repository !== undefined && !isRecord(server.repository)) {
    throw new Error(`${label}.repository must be an object`);
  }
  if (server._meta !== undefined && !isRecord(server._meta)) {
    throw new Error(`${label}._meta must be an object`);
  }
  return server;
}

function assertObservedMcpRegistryServerSchema(server, label) {
  if (server.$schema !== MCP_REGISTRY_IDENTITY.schema) {
    throw new Error(`${label} uses an unsupported MCP Registry schema`);
  }
  const inputKeys = [
    "choices",
    "default",
    "description",
    "format",
    "isRequired",
    "isSecret",
    "placeholder",
    "value"
  ];
  const inputWithVariablesKeys = [...inputKeys, "variables"];
  const assertOptionalArray = (value, fieldLabel, assertElement) => {
    if (value === undefined) return;
    if (!Array.isArray(value)) throw new Error(`${fieldLabel} must be an array`);
    for (let index = 0; index < value.length; index++) {
      assertElement(value[index], `${fieldLabel}[${index}]`);
    }
  };
  const assertOptionalStrings = (record, fields, recordLabel) => {
    for (const field of fields) {
      if (record[field] !== undefined && typeof record[field] !== "string") {
        throw new Error(`${recordLabel}.${field} must be a string`);
      }
    }
  };
  const assertOptionalBooleans = (record, fields, recordLabel) => {
    for (const field of fields) {
      if (record[field] !== undefined && typeof record[field] !== "boolean") {
        throw new Error(`${recordLabel}.${field} must be boolean`);
      }
    }
  };
  const assertInputFields = (input, inputLabel) => {
    assertOptionalStrings(input, ["default", "description", "placeholder", "value"], inputLabel);
    assertOptionalBooleans(input, ["isRequired", "isSecret"], inputLabel);
    if (
      input.format !== undefined &&
      input.format !== "string" &&
      input.format !== "number" &&
      input.format !== "boolean" &&
      input.format !== "filepath"
    ) {
      throw new Error(`${inputLabel}.format must be string, number, boolean, or filepath`);
    }
    assertOptionalArray(input.choices, `${inputLabel}.choices`, (choice, choiceLabel) => {
      if (typeof choice !== "string") throw new Error(`${choiceLabel} must be a string`);
    });
  };
  const assertInput = (value, inputLabel) => {
    const input = assertAllowedRecord(value, inputKeys, inputLabel);
    assertInputFields(input, inputLabel);
  };
  const assertVariables = (input, inputLabel) => {
    if (input.variables === undefined) return;
    if (!isRecord(input.variables)) throw new Error(`${inputLabel}.variables must be an object`);
    for (const [name, value] of Object.entries(input.variables)) {
      assertInput(value, `${inputLabel}.variables.${name}`);
    }
  };
  const assertArgument = (value, argumentLabel) => {
    const argument = assertAllowedRecord(
      value,
      [...inputWithVariablesKeys, "isRepeated", "name", "type", "valueHint"],
      argumentLabel
    );
    if (argument.type !== "named" && argument.type !== "positional") {
      throw new Error(`${argumentLabel}.type must be named or positional`);
    }
    assertAllowedRecord(
      argument,
      argument.type === "named"
        ? [...inputWithVariablesKeys, "isRepeated", "name", "type"]
        : [...inputWithVariablesKeys, "isRepeated", "type", "valueHint"],
      argumentLabel
    );
    assertInputFields(argument, argumentLabel);
    assertVariables(argument, argumentLabel);
    if (argument.isRepeated !== undefined && typeof argument.isRepeated !== "boolean") {
      throw new Error(`${argumentLabel}.isRepeated must be boolean`);
    }
    if (argument.type === "named" && !isNonEmptyString(argument.name)) {
      throw new Error(`${argumentLabel}.name must be a non-empty string for a named argument`);
    }
    if (argument.valueHint !== undefined && typeof argument.valueHint !== "string") {
      throw new Error(`${argumentLabel}.valueHint must be a string`);
    }
    if (
      argument.type === "positional" &&
      !isNonEmptyString(argument.valueHint) &&
      !isNonEmptyString(argument.value)
    ) {
      throw new Error(`${argumentLabel} must name a non-empty valueHint or value string for a positional argument`);
    }
  };
  const assertEnvironmentVariable = (value, variableLabel) => {
    const variable = assertAllowedRecord(value, [...inputWithVariablesKeys, "name"], variableLabel);
    assertInputFields(variable, variableLabel);
    assertVariables(variable, variableLabel);
    if (!isNonEmptyString(variable.name)) throw new Error(`${variableLabel}.name must be a non-empty string`);
  };

  assertOptionalArray(server.icons, `${label}.icons`, (value, iconLabel) => {
    const icon = assertAllowedRecord(value, ["mimeType", "sizes", "src", "theme"], iconLabel);
    if (!isNonEmptyString(icon.src) || Array.from(icon.src).length > 255) {
      throw new Error(`${iconLabel}.src must be a non-empty string of at most 255 Unicode characters`);
    }
    if (
      icon.mimeType !== undefined &&
      icon.mimeType !== "image/png" &&
      icon.mimeType !== "image/jpeg" &&
      icon.mimeType !== "image/jpg" &&
      icon.mimeType !== "image/svg+xml" &&
      icon.mimeType !== "image/webp"
    ) {
      throw new Error(`${iconLabel}.mimeType is not an allowed image media type`);
    }
    assertOptionalArray(icon.sizes, `${iconLabel}.sizes`, (size, sizeLabel) => {
      if (typeof size !== "string" || !/^(?:\d+x\d+|any)$/u.test(size)) {
        throw new Error(`${sizeLabel} must be an icon size or any`);
      }
    });
    if (icon.theme !== undefined && icon.theme !== "light" && icon.theme !== "dark") {
      throw new Error(`${iconLabel}.theme must be light or dark`);
    }
  });
  if (server.remotes !== undefined && !Array.isArray(server.remotes)) {
    throw new Error(`${label}.remotes must be an array`);
  }
  assertOptionalArray(server.packages, `${label}.packages`, (value, packageLabel) => {
    const packageEntry = assertAllowedRecord(
      value,
      [
        "environmentVariables",
        "fileSha256",
        "identifier",
        "packageArguments",
        "registryBaseUrl",
        "registryType",
        "runtimeArguments",
        "runtimeHint",
        "transport",
        "version"
      ],
      packageLabel
    );
    if (
      packageEntry.fileSha256 !== undefined &&
      (typeof packageEntry.fileSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(packageEntry.fileSha256))
    ) {
      throw new Error(`${packageLabel}.fileSha256 must be 64 lowercase hexadecimal characters`);
    }
    for (const field of ["registryBaseUrl", "runtimeHint"]) {
      if (packageEntry[field] !== undefined && typeof packageEntry[field] !== "string") {
        throw new Error(`${packageLabel}.${field} must be a string`);
      }
    }
    for (const field of ["runtimeArguments", "packageArguments"]) {
      assertOptionalArray(packageEntry[field], `${packageLabel}.${field}`, assertArgument);
    }
    assertOptionalArray(
      packageEntry.environmentVariables,
      `${packageLabel}.environmentVariables`,
      assertEnvironmentVariable
    );
  });
  return server;
}

function assertMcpRegistryProjectLineage(server, expectedPackage, label) {
  if (server.name !== expectedPackage.mcpName) throw new Error(`${label} has a different MCP server name`);
  assertStableMcpRegistryVersion(server.version, `${label} version`);
  const repository = assertExactRecord(server.repository, ["url", "source"], `${label} repository`);
  if (repository.url !== MCP_REGISTRY_IDENTITY.repositoryUrl || repository.source !== "github") {
    throw new Error(`${label} has a different source repository`);
  }
  if (!Array.isArray(server.packages) || server.packages.length !== 1) {
    throw new Error(`${label} must contain exactly one npm package`);
  }
  const packageEntry = assertAllowedRecord(
    server.packages[0],
    [
      "environmentVariables",
      "fileSha256",
      "identifier",
      "packageArguments",
      "registryBaseUrl",
      "registryType",
      "runtimeArguments",
      "runtimeHint",
      "transport",
      "version"
    ],
    `${label} package`
  );
  if (
    packageEntry.registryType !== "npm" ||
    packageEntry.identifier !== expectedPackage.name ||
    packageEntry.version !== server.version
  ) {
    throw new Error(`${label} has a different npm package identity or version`);
  }
  const transport = assertExactRecord(packageEntry.transport, ["type"], `${label} package transport`);
  if (transport.type !== "stdio") throw new Error(`${label} package transport must be stdio`);
  if (server.remotes !== undefined && server.remotes !== null && server.remotes.length !== 0) {
    throw new Error(`${label} unexpectedly declares remote transports`);
  }
  return server;
}

function assertCanonicalExpectedMcpRegistryManifest(server, label) {
  assertExactRecord(
    server,
    ["$schema", "name", "title", "description", "websiteUrl", "repository", "version", "packages"],
    label
  );
  if (!isNonEmptyString(server.title) || Array.from(server.title).length > 100) {
    throw new Error(`${label} title must contain 1 to 100 Unicode characters`);
  }
  const packageEntry = assertExactRecord(
    server.packages[0],
    ["registryType", "identifier", "version", "transport", "runtimeArguments"],
    `${label} package`
  );
  if (!Array.isArray(packageEntry.runtimeArguments) || packageEntry.runtimeArguments.length !== 2) {
    throw new Error(`${label} package must contain the two canonical runtime arguments`);
  }
  const positional = assertExactRecord(
    packageEntry.runtimeArguments[0],
    ["type", "valueHint", "value", "description", "isRequired", "format"],
    `${label} positional runtime argument`
  );
  if (
    positional.type !== "positional" ||
    positional.valueHint !== "subcommand" ||
    positional.value !== "serve" ||
    !isNonEmptyString(positional.description) ||
    positional.isRequired !== true ||
    positional.format !== "string"
  ) {
    throw new Error(`${label} positional runtime argument diverged from the canonical serve contract`);
  }
  const vault = assertExactRecord(
    packageEntry.runtimeArguments[1],
    ["type", "name", "description", "isRequired", "format"],
    `${label} vault runtime argument`
  );
  if (
    vault.type !== "named" ||
    vault.name !== "--vault" ||
    !isNonEmptyString(vault.description) ||
    vault.isRequired !== true ||
    vault.format !== "string"
  ) {
    throw new Error(`${label} vault runtime argument diverged from the canonical stdio contract`);
  }
  return server;
}

function assertExpectedMcpRegistryState(input) {
  const state = assertExactRecord(input, ["expected", "exact", "latest"], "MCP Registry state");
  const expected = assertExactRecord(state.expected, ["server", "package"], "expected MCP Registry identity");
  const expectedPackage = assertExactRecord(
    expected.package,
    ["name", "version", "mcpName"],
    "expected local package identity"
  );
  if (
    expectedPackage.name !== MCP_REGISTRY_IDENTITY.packageName ||
    expectedPackage.mcpName !== MCP_REGISTRY_IDENTITY.mcpName
  ) {
    throw new Error("expected local package identity does not match enquire-mcp");
  }
  assertStableMcpRegistryVersion(expectedPackage.version, "expected local package version");
  const server = assertMcpRegistryProjectLineage(
    assertMcpRegistryServerShape(expected.server, "expected local server manifest"),
    expectedPackage,
    "expected local server manifest"
  );
  assertCanonicalExpectedMcpRegistryManifest(server, "expected local server manifest");
  if (
    server.$schema !== MCP_REGISTRY_IDENTITY.schema ||
    server.version !== expectedPackage.version ||
    server.websiteUrl !== MCP_REGISTRY_IDENTITY.repositoryUrl
  ) {
    throw new Error("expected local server schema, version, or project URL diverged");
  }
  return { state, expected: { server, package: expectedPackage } };
}

function assertMcpRegistryOfficialMetadata(value, label) {
  const metadata = assertAllowedRecord(
    value,
    ["isLatest", "publishedAt", "status", "statusChangedAt", "statusMessage", "updatedAt"],
    label
  );
  for (const field of ["isLatest", "publishedAt", "status", "statusChangedAt"]) {
    if (!Object.hasOwn(metadata, field)) throw new Error(`${label} is missing ${field}`);
  }
  if (!new Set(["active", "deprecated", "deleted"]).has(metadata.status)) {
    throw new Error(`${label} has an invalid lifecycle status`);
  }
  if (typeof metadata.isLatest !== "boolean") throw new Error(`${label}.isLatest must be boolean`);
  assertRfc3339Timestamp(metadata.publishedAt, `${label}.publishedAt`);
  assertRfc3339Timestamp(metadata.statusChangedAt, `${label}.statusChangedAt`);
  if (metadata.updatedAt !== undefined) assertRfc3339Timestamp(metadata.updatedAt, `${label}.updatedAt`);
  if (
    metadata.statusMessage !== undefined &&
    (typeof metadata.statusMessage !== "string" || Array.from(metadata.statusMessage).length > 500)
  ) {
    throw new Error(`${label}.statusMessage must be a string of at most 500 Unicode characters`);
  }
  return metadata;
}

function parseMcpRegistryBody(body, label) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`${label} body must contain exactly one valid JSON value`);
  }
  return parsed;
}

function decodeMcpRegistryObservation(value, expectedUrl, phase, label) {
  const envelope = assertExactRecord(
    value,
    ["requestUrl", "curlExit", "httpStatus", "contentType", "body"],
    `${label} HTTP envelope`
  );
  if (envelope.requestUrl !== expectedUrl) throw new Error(`${label} request URL differs from the exact pinned URL`);
  if (!isNonNegativeSafeInteger(envelope.curlExit) || envelope.curlExit > 255) {
    throw new Error(`${label} curl exit must be an integer from 0 through 255`);
  }
  if (typeof envelope.httpStatus !== "string" || !/^(?:000|[1-5]\d{2})$/u.test(envelope.httpStatus)) {
    throw new Error(`${label} HTTP status must be one canonical three-digit string`);
  }
  if (typeof envelope.contentType !== "string" || typeof envelope.body !== "string") {
    throw new Error(`${label} content type and body must be strings`);
  }
  if (envelope.curlExit !== 0) {
    if (phase === "convergence") return { kind: "retry" };
    throw new Error(`${label} transport failed during publication preflight`);
  }
  if (envelope.httpStatus === "200") {
    if (envelope.contentType !== "application/json") {
      throw new Error(`${label} 200 response must use application/json`);
    }
    const response = assertExactRecord(
      parseMcpRegistryBody(envelope.body, label),
      ["server", "_meta"],
      `${label} 200 response`
    );
    const responseMeta = assertExactRecord(
      response._meta,
      [MCP_REGISTRY_OFFICIAL_META],
      `${label} registry-managed metadata`
    );
    const official = assertMcpRegistryOfficialMetadata(
      responseMeta[MCP_REGISTRY_OFFICIAL_META],
      `${label} official metadata`
    );
    const server = assertObservedMcpRegistryServerSchema(
      assertMcpRegistryServerShape(response.server, `${label} server`),
      `${label} server`
    );
    return { kind: "record", response, server, official };
  }
  if (envelope.httpStatus === "404") {
    if (envelope.contentType !== "application/problem+json") {
      throw new Error(`${label} 404 response must use application/problem+json`);
    }
    const problem = assertExactRecord(
      parseMcpRegistryBody(envelope.body, label),
      ["detail", "status", "title"],
      `${label} production 404 problem`
    );
    if (problem.detail !== "Server not found" || problem.status !== 404 || problem.title !== "Not Found") {
      throw new Error(`${label} 404 response differs from the authoritative production problem`);
    }
    return { kind: "absent" };
  }
  const status = Number(envelope.httpStatus);
  if (phase === "convergence" && (status === 429 || status >= 500)) return { kind: "retry" };
  throw new Error(`${label} returned non-authoritative HTTP status ${envelope.httpStatus}`);
}

function assertActiveMcpRegistryRecord(observation, label) {
  if (observation.official.status === "deleted") {
    throw new Error(`${label} is deleted and must never be treated as absent`);
  }
  if (observation.official.status === "deprecated") {
    throw new Error(`${label} is deprecated and requires manual resolution`);
  }
}

/**
 * Reconcile exact-version and latest MCP Registry reads without performing a write.
 *
 * @param {unknown} input - Expected local identity plus raw exact/latest HTTP envelopes.
 * @param {unknown} phase - `preflight` before the one allowed write, or `convergence` afterwards.
 * @returns {{action:"publish"|"reuse"|"retry"|"confirmed"}} The only safe next transaction action.
 * @example
 * evaluateMcpRegistryState(registrySnapshot, "preflight");
 */
export function evaluateMcpRegistryState(input, phase) {
  if (phase !== "preflight" && phase !== "convergence") {
    throw new Error("MCP Registry phase must be exactly preflight or convergence");
  }
  const { state, expected } = assertExpectedMcpRegistryState(input);
  const encodedName = encodeURIComponent(expected.package.mcpName);
  const exactUrl =
    `${MCP_REGISTRY_IDENTITY.apiBase}/${encodedName}/versions/${encodeURIComponent(expected.package.version)}` +
    "?include_deleted=true";
  const latestUrl = `${MCP_REGISTRY_IDENTITY.apiBase}/${encodedName}/versions/latest?include_deleted=true`;
  const exact = decodeMcpRegistryObservation(state.exact, exactUrl, phase, "exact-version MCP Registry read");
  const latest = decodeMcpRegistryObservation(state.latest, latestUrl, phase, "latest MCP Registry read");

  if (exact.kind === "record") {
    assertActiveMcpRegistryRecord(exact, "exact MCP Registry version");
    assertMcpRegistryProjectLineage(exact.server, expected.package, "exact MCP Registry version");
    if (!isDeepStrictEqual(exact.server, expected.server)) {
      throw new Error("exact MCP Registry version diverges from the local server manifest");
    }
  }
  if (latest.kind === "record") {
    assertActiveMcpRegistryRecord(latest, "latest MCP Registry version");
    assertMcpRegistryProjectLineage(latest.server, expected.package, "latest MCP Registry version");
    const comparison = compareStableMcpRegistryVersions(latest.server.version, expected.package.version);
    if (comparison === 0 && !isDeepStrictEqual(latest.server, expected.server)) {
      throw new Error("latest MCP Registry version diverges from the local server manifest");
    }
    if (comparison > 0) throw new Error("MCP Registry latest version is newer than the release candidate");
  }

  if (phase === "preflight") {
    if (exact.kind === "absent") {
      if (latest.kind === "absent") return { action: "publish" };
      if (latest.kind !== "record" || latest.official.isLatest !== true) {
        throw new Error("MCP Registry absence is ambiguous during publication preflight");
      }
      if (latest.server.version === expected.package.version) {
        throw new Error("MCP Registry exact and latest reads disagree about candidate absence");
      }
      return { action: "publish" };
    }
    if (
      exact.kind !== "record" ||
      latest.kind !== "record" ||
      exact.official.isLatest !== true ||
      latest.official.isLatest !== true ||
      latest.server.version !== expected.package.version ||
      !isDeepStrictEqual(exact.response, latest.response)
    ) {
      throw new Error("MCP Registry exact and latest reads do not prove one reusable active latest version");
    }
    return { action: "reuse" };
  }

  if (exact.kind !== "record" || latest.kind !== "record") return { action: "retry" };
  if (
    exact.official.isLatest !== true ||
    latest.official.isLatest !== true ||
    latest.server.version !== expected.package.version
  ) {
    return { action: "retry" };
  }
  if (!isDeepStrictEqual(exact.response, latest.response)) {
    throw new Error("MCP Registry exact and latest candidate records disagree after publication");
  }
  return { action: "confirmed" };
}

/**
 * Classify an absent, draft, or published GitHub release against the exact
 * Basic asset-name contract.
 *
 * @param {unknown} input - GitHub release and asset snapshot.
 * @param {unknown} expected - Expected tag, channel, public metadata, and asset names.
 * @returns {{action:"create_draft"|"resume_draft"|"publish_draft"|"reuse_published",missing:string[]}}
 *   Safe next action and the exact missing asset names.
 */
export function evaluateMcpbReleaseState(input, expected) {
  const expectedNames = Array.isArray(expected?.assetNames) ? expected.assetNames : [];
  if (
    typeof expected?.tag !== "string" ||
    expected.tag.length === 0 ||
    typeof expected?.prerelease !== "boolean" ||
    typeof expected?.name !== "string" ||
    expected.name.length === 0 ||
    typeof expected?.body !== "string" ||
    expected.body.length === 0 ||
    expectedNames.length === 0 ||
    expectedNames.some((name) => typeof name !== "string" || name.length === 0) ||
    new Set(expectedNames).size !== expectedNames.length
  ) {
    throw new Error("expected Basic release identity and asset names must be complete and canonical");
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
    release.name !== expected.name ||
    release.body !== expected.body ||
    release.prerelease !== expected.prerelease ||
    typeof release.draft !== "boolean"
  ) {
    throw new Error("GitHub release id, tag, public metadata, channel, or draft identity diverged");
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
    if (asset.state !== "uploaded") {
      throw new Error(
        `GitHub release asset ${asset.name} is not uploaded (state ${String(asset.state)}); ` +
          `manual recovery is required for asset id ${String(asset.id)}`
      );
    }
    if (asset.content_type !== "application/octet-stream") {
      throw new Error(`GitHub release asset ${asset.name} has an unexpected content type`);
    }
    if (!Number.isSafeInteger(asset.size) || asset.size <= 0) {
      throw new Error(`GitHub release asset ${asset.name} has an invalid uploaded size`);
    }
    if (typeof asset.digest !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(asset.digest)) {
      throw new Error(`GitHub release asset ${asset.name} lacks an exact SHA-256 digest`);
    }
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
 * Classify one observation in a bounded eventually-consistent count transition.
 *
 * @param {unknown} observed - Current authoritative collection count.
 * @param {unknown} expected - Exact count required by the postcondition.
 * @param {unknown} attempt - One-based current observation number.
 * @param {unknown} maxAttempts - Positive bounded observation count.
 * @param {unknown} label - Human-readable external identity.
 * @returns {{action:"ready"|"retry",attempt:number}} The only safe next action.
 * @example
 * evaluateConvergentCount(0, 1, 1, 12, "draft release"); // { action: "retry", attempt: 1 }
 */
export function evaluateConvergentCount(observed, expected, attempt, maxAttempts, label) {
  if (
    !Number.isSafeInteger(observed) ||
    !Number.isSafeInteger(expected) ||
    !Number.isSafeInteger(attempt) ||
    !Number.isSafeInteger(maxAttempts) ||
    observed < 0 ||
    expected < 1 ||
    attempt < 1 ||
    maxAttempts < 1 ||
    attempt > maxAttempts ||
    typeof label !== "string" ||
    label.length === 0
  ) {
    throw new Error("external visibility observation is invalid");
  }
  if (observed > expected) {
    throw new Error(`${label} has ${observed} objects; expected exactly ${expected}`);
  }
  if (observed === expected) return { action: "ready", attempt };
  if (attempt === maxAttempts) {
    throw new Error(`${label} did not converge to ${expected} objects after ${maxAttempts} observations`);
  }
  return { action: "retry", attempt };
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

function npmProvenanceContextFromEnvironment() {
  const declared = {};
  const runtime = {};
  for (const field of PROVENANCE_CONTEXT_FIELDS) {
    const [declaredName, runtimeName] = PROVENANCE_ENVIRONMENT_BINDINGS[field];
    declared[field] = process.env[declaredName];
    runtime[field] = process.env[runtimeName];
  }
  return { declared, runtime };
}

function usage() {
  return [
    "Usage: check-release-integrity.mjs",
    "assert-tag <tag> <version> | asset-version <version> | channel-advance <candidate> <current> <channel> |",
    "checks <source-sha> | flatten-pages <release|asset> | flatten-field <workflow_runs|jobs|artifacts> |",
    "npm-state <source-sha> <sha512-sri> <version> <channel> | release-state | visibility |",
    "npm-provenance-context <source-sha> <tag> |",
    "npm-provenance <name> <version> <sha512-sri> <source-sha> <tag> <publish-attempted> <run-id> <run-attempt> |",
    "mcp-registry-state <preflight|convergence> | candidate-runs <source-sha> | candidate <source-sha>"
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
      console.log(JSON.stringify(evaluateNpmPublication(payload, first, second, process.argv[5], process.argv[6])));
    } else if (mode === "npm-provenance-context") {
      console.log(JSON.stringify(evaluateNpmProvenanceContext(npmProvenanceContextFromEnvironment(), first, second)));
    } else if (mode === "npm-provenance") {
      const [name, version, integrity, sourceSha, tag, publishAttempted, currentRunId, currentRunAttempt] =
        process.argv.slice(3);
      if (publishAttempted !== "true" && publishAttempted !== "false") {
        throw new Error("npm provenance publish-attempted state must be exactly true or false");
      }
      const payload = JSON.parse(readFileSync(0, "utf8"));
      console.log(
        JSON.stringify(
          evaluateNpmProvenanceAttestations(payload, {
            name,
            version,
            integrity,
            sourceSha,
            tag,
            publishAttempted: publishAttempted === "true",
            currentRunId,
            currentRunAttempt
          })
        )
      );
    } else if (mode === "release-state") {
      const [tag, prerelease, ...assetNames] = process.argv.slice(3);
      if (prerelease !== "true" && prerelease !== "false") {
        throw new Error("expected GitHub prerelease state must be exactly true or false");
      }
      const payload = JSON.parse(readFileSync(0, "utf8"));
      console.log(
        JSON.stringify(
          evaluateMcpbReleaseState(payload, {
            tag,
            prerelease: prerelease === "true",
            name: process.env.EXPECTED_RELEASE_NAME,
            body: process.env.EXPECTED_RELEASE_BODY,
            assetNames
          })
        )
      );
    } else if (mode === "mcp-registry-state") {
      const payload = JSON.parse(readFileSync(0, "utf8"));
      console.log(JSON.stringify(evaluateMcpRegistryState(payload, first)));
    } else if (mode === "visibility") {
      const parseCanonicalInteger = (value, label) => {
        if (typeof value !== "string" || !/^(0|[1-9]\d*)$/u.test(value)) {
          throw new Error(`${label} must be one canonical non-negative integer`);
        }
        const parsed = Number(value);
        if (!Number.isSafeInteger(parsed)) {
          throw new Error(`${label} must be one canonical non-negative integer`);
        }
        return parsed;
      };
      console.log(
        JSON.stringify(
          evaluateConvergentCount(
            parseCanonicalInteger(first, "observed visibility count"),
            parseCanonicalInteger(second, "expected visibility count"),
            parseCanonicalInteger(process.argv[5], "visibility attempt"),
            parseCanonicalInteger(process.argv[6], "maximum visibility attempts"),
            process.argv[7]
          )
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
