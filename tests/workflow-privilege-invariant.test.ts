import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";
// @ts-expect-error — dependency-free .mjs workflow helper has no declaration file.
import {
  assertMaintenanceTargetsAbsent,
  classifyMaintenanceTargets,
  DIST_TAG_MAINTENANCE_TARGETS,
  parseDistTagsJson
} from "../scripts/npm-dist-tag-policy.mjs";

type YamlRecord = Record<string, unknown>;

const repoRoot = resolve(__dirname, "..");
const cleanupPath = resolve(repoRoot, ".github/workflows/dist-tag-cleanup.yml");
const publishDocsPath = resolve(repoRoot, ".github/workflows/publish-docs.yml");
const releasePath = resolve(repoRoot, ".github/workflows/release.yml");
const policyScriptPath = resolve(repoRoot, "scripts/npm-dist-tag-policy.mjs");
const MAIN_REF_GUARD = `\${{ github.ref == 'refs/heads/main' }}`;
const CLEANUP_GUARD = `\${{ github.ref == 'refs/heads/main' && inputs.confirm == 'REMOVE' }}`;
const CONFIRM_ONLY_GUARD = `\${{ inputs.confirm == 'REMOVE' }}`;
const RUNNER_TEMP = `\${{ runner.temp }}`;
const NPM_TOKEN_SECRET = `\${{ secrets.NPM_TOKEN }}`;
const PAGES_URL = `\${{ steps.deployment.outputs.page_url }}`;
const SHA_ARTIFACT_NAME = `pages-\${{ github.sha }}`;

function fileSha256(relativePath: string): string {
  return createHash("sha256")
    .update(readFileSync(resolve(repoRoot, relativePath)))
    .digest("hex");
}

function record(value: unknown): YamlRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as YamlRecord) : null;
}

function steps(job: YamlRecord | null): YamlRecord[] {
  const value = job?.steps;
  if (!Array.isArray(value)) return [];
  return value.map(record).filter((step): step is YamlRecord => step !== null);
}

function exactRecord(value: unknown, expected: Readonly<Record<string, unknown>>): boolean {
  const actual = record(value);
  if (actual === null) return false;
  const keys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return (
    JSON.stringify(keys) === JSON.stringify(expectedKeys) && expectedKeys.every((key) => actual[key] === expected[key])
  );
}

function workflow(source: string): YamlRecord | null {
  try {
    return record(load(source));
  } catch {
    return null;
  }
}

function namedStep(jobSteps: readonly YamlRecord[], name: string): YamlRecord | undefined {
  return jobSteps.find((step) => step.name === name);
}

function run(step: YamlRecord | undefined): string {
  return typeof step?.run === "string" ? step.run.trimEnd() : "";
}

function pinnedAction(step: YamlRecord, action: string): boolean {
  return typeof step.uses === "string" && new RegExp(`^${action}@[0-9a-f]{40}$`, "u").test(step.uses);
}

function cleanupWorkflowProblems(source: string): string[] {
  const document = workflow(source);
  if (document === null) return ["cleanup-invalid-yaml"];
  const problems: string[] = [];
  const trigger = record(document.on);
  const dispatch = record(trigger?.workflow_dispatch);
  const inputs = record(dispatch?.inputs);
  const confirm = record(inputs?.confirm);
  if (
    trigger === null ||
    JSON.stringify(Object.keys(trigger).sort()) !== JSON.stringify(["workflow_dispatch"]) ||
    !exactRecord(confirm, {
      description: 'Type "REMOVE" to confirm dist-tag deletion',
      required: true,
      type: "string"
    })
  ) {
    problems.push("cleanup-trigger");
  }
  if (!exactRecord(document.permissions, {})) problems.push("cleanup-root-permissions");

  const cleanup = record(record(document.jobs)?.cleanup);
  if (cleanup === null) return [...problems, "cleanup-job-missing"];
  if (cleanup.if !== CLEANUP_GUARD) problems.push("cleanup-main-ref-guard");
  if (!exactRecord(cleanup.permissions, { contents: "read" })) problems.push("cleanup-job-permissions");
  if (!exactRecord(cleanup.environment, { name: "npm-maintenance" })) {
    problems.push("cleanup-protected-environment");
  }
  if (cleanup["runs-on"] !== "ubuntu-latest" || cleanup["timeout-minutes"] !== 5) {
    problems.push("cleanup-execution-boundary");
  }
  if (cleanup.defaults !== undefined || cleanup.container !== undefined || cleanup.services !== undefined) {
    problems.push("cleanup-execution-expansion");
  }

  const jobSteps = steps(cleanup);
  if (jobSteps.length !== 6) problems.push("cleanup-step-inventory");
  const checkout = jobSteps[0];
  if (
    checkout === undefined ||
    !pinnedAction(checkout, "actions/checkout") ||
    !exactRecord(checkout.with, { "persist-credentials": false })
  ) {
    problems.push("cleanup-checkout-credentials");
  }
  const setup = jobSteps[1];
  if (
    setup === undefined ||
    !pinnedAction(setup, "actions/setup-node") ||
    !exactRecord(setup.with, {
      "node-version": 22,
      "registry-url": "https://registry.npmjs.org"
    })
  ) {
    problems.push("cleanup-node-setup");
  }
  if (jobSteps.some((step) => typeof step.uses === "string" && !/@[0-9a-f]{40}$/u.test(step.uses))) {
    problems.push("cleanup-unpinned-action");
  }

  const preflight = namedStep(jobSteps, "Classify current dist-tags");
  const expectedPreflight = [
    "set -euo pipefail",
    "npm view @oomkapwn/enquire-mcp dist-tags --json --registry=https://registry.npmjs.org/ \\",
    "  --prefer-online --fetch-retries=0 --fetch-timeout=60000 \\",
    '  --cache="$RUNNER_TEMP/npm-dist-tag-preflight-cache" |',
    '  node "$GITHUB_WORKSPACE/scripts/npm-dist-tag-policy.mjs" classify >> "$GITHUB_OUTPUT"'
  ].join("\n");
  if (
    preflight?.id !== "preflight" ||
    preflight.shell !== "bash" ||
    preflight["working-directory"] !== RUNNER_TEMP ||
    run(preflight) !== expectedPreflight
  ) {
    problems.push("cleanup-strict-preflight");
  }

  for (const tag of DIST_TAG_MAINTENANCE_TARGETS as readonly string[]) {
    const title = `Remove stale ${tag} dist-tag`;
    const removal = namedStep(jobSteps, title);
    if (
      removal?.if !== `\${{ steps.preflight.outputs.${tag}_present == 'true' }}` ||
      removal?.["working-directory"] !== RUNNER_TEMP ||
      !exactRecord(removal?.env, { NODE_AUTH_TOKEN: NPM_TOKEN_SECRET }) ||
      run(removal) !==
        `npm dist-tag rm @oomkapwn/enquire-mcp ${tag} --registry=https://registry.npmjs.org/ --fetch-retries=0 --fetch-timeout=60000`
    ) {
      problems.push(`cleanup-exact-${tag}-removal`);
    }
  }

  const postcondition = namedStep(jobSteps, "Verify stale dist-tags are absent");
  const expectedPostcondition = [
    "set -euo pipefail",
    "npm view @oomkapwn/enquire-mcp dist-tags --json --registry=https://registry.npmjs.org/ \\",
    "  --prefer-online --fetch-retries=0 --fetch-timeout=60000 \\",
    '  --cache="$RUNNER_TEMP/npm-dist-tag-postcondition-cache" |',
    '  node "$GITHUB_WORKSPACE/scripts/npm-dist-tag-policy.mjs" assert-absent'
  ].join("\n");
  if (
    postcondition?.shell !== "bash" ||
    postcondition?.["working-directory"] !== RUNNER_TEMP ||
    run(postcondition) !== expectedPostcondition
  ) {
    problems.push("cleanup-parsed-postcondition");
  }

  const allRuns = jobSteps
    .map((step) => run(step))
    .filter(Boolean)
    .join("\n");
  if (allRuns.includes("|| true")) problems.push("cleanup-masked-failure");
  const mutations = [...allRuns.matchAll(/npm dist-tag rm @oomkapwn\/enquire-mcp ([^ ]+)/gu)].map((match) => match[1]);
  if (JSON.stringify(mutations) !== JSON.stringify(["alpha", "beta"])) {
    problems.push("cleanup-mutation-scope");
  }
  return problems;
}

function publishDocsWorkflowProblems(source: string): string[] {
  const document = workflow(source);
  if (document === null) return ["docs-invalid-yaml"];
  const problems: string[] = [];
  const trigger = record(document.on);
  const push = record(trigger?.push);
  if (
    trigger === null ||
    JSON.stringify(Object.keys(trigger).sort()) !== JSON.stringify(["push", "workflow_dispatch"]) ||
    !Array.isArray(push?.branches) ||
    JSON.stringify(push.branches) !== JSON.stringify(["main"])
  ) {
    problems.push("docs-trigger");
  }
  if (!exactRecord(document.permissions, {})) problems.push("docs-root-permissions");
  if (document.env !== undefined || document.defaults !== undefined) problems.push("docs-root-execution-expansion");

  const jobs = record(document.jobs);
  const build = record(jobs?.build);
  const deploy = record(jobs?.deploy);
  if (build === null || deploy === null) return [...problems, "docs-job-inventory"];
  if (build.if !== MAIN_REF_GUARD || deploy.if !== MAIN_REF_GUARD) problems.push("docs-main-ref-guards");
  if (!exactRecord(build.permissions, { contents: "read" })) problems.push("docs-build-least-privilege");
  if (!exactRecord(deploy.permissions, { pages: "write", "id-token": "write" })) {
    problems.push("docs-deploy-privilege");
  }
  if (build.environment !== undefined) problems.push("docs-build-environment");
  if (
    !exactRecord(deploy.environment, {
      name: "github-pages",
      url: PAGES_URL
    })
  ) {
    problems.push("docs-protected-environment");
  }
  if (deploy.needs !== "build") problems.push("docs-deploy-dependency");

  const buildSteps = steps(build);
  const deploySteps = steps(deploy);
  const checkout = buildSteps.find(
    (step) => typeof step.uses === "string" && step.uses.startsWith("actions/checkout@")
  );
  if (
    checkout === undefined ||
    !pinnedAction(checkout, "actions/checkout") ||
    !exactRecord(checkout.with, { "persist-credentials": false })
  ) {
    problems.push("docs-checkout-credentials");
  }
  const allSteps = [...buildSteps, ...deploySteps];
  if (allSteps.some((step) => typeof step.uses === "string" && !/@[0-9a-f]{40}$/u.test(step.uses))) {
    problems.push("docs-unpinned-action");
  }

  const upload = buildSteps.find(
    (step) => typeof step.uses === "string" && step.uses.startsWith("actions/upload-pages-artifact@")
  );
  if (
    upload === undefined ||
    !pinnedAction(upload, "actions/upload-pages-artifact") ||
    !exactRecord(upload.with, { name: SHA_ARTIFACT_NAME, path: ".pages-dist", "retention-days": 1 })
  ) {
    problems.push("docs-exact-upload-artifact");
  }
  const configureSteps = allSteps.filter(
    (step) => typeof step.uses === "string" && step.uses.startsWith("actions/configure-pages@")
  );
  if (
    configureSteps.length !== 1 ||
    !buildSteps.includes(configureSteps[0] as YamlRecord) ||
    !pinnedAction(configureSteps[0] as YamlRecord, "actions/configure-pages")
  ) {
    problems.push("docs-configure-build-boundary");
  }
  const deployment = deploySteps.find((step) => step.id === "deployment");
  if (
    deployment === undefined ||
    !pinnedAction(deployment, "actions/deploy-pages") ||
    !exactRecord(deployment.with, { artifact_name: SHA_ARTIFACT_NAME })
  ) {
    problems.push("docs-exact-deploy-artifact");
  }
  if (deploySteps.some((step) => typeof step.run === "string") || deploySteps.length !== 1) {
    problems.push("docs-privileged-code-execution");
  }
  return problems;
}

function releaseWorkflowProblems(source: string): string[] {
  const document = workflow(source);
  if (document === null) return ["release-invalid-yaml"];
  const problems: string[] = [];
  const trigger = record(document.on);
  const push = record(trigger?.push);
  if (
    trigger === null ||
    JSON.stringify(Object.keys(trigger)) !== JSON.stringify(["push"]) ||
    !Array.isArray(push?.tags) ||
    JSON.stringify(push.tags) !== JSON.stringify(["v*"])
  ) {
    problems.push("release-tag-trigger");
  }
  if (!exactRecord(document.permissions, {})) problems.push("release-root-permissions");

  const jobs = record(document.jobs);
  const jobIds = jobs === null ? [] : Object.keys(jobs).sort();
  if (JSON.stringify(jobIds) !== JSON.stringify(["github_release", "mcp_registry", "npm_publish", "verify"])) {
    return [...problems, "release-job-inventory"];
  }
  const verify = record(jobs?.verify);
  const npmPublish = record(jobs?.npm_publish);
  const githubRelease = record(jobs?.github_release);
  const mcpRegistry = record(jobs?.mcp_registry);
  if (verify === null || npmPublish === null || githubRelease === null || mcpRegistry === null) {
    return [...problems, "release-job-inventory"];
  }
  if (!exactRecord(verify.permissions, { actions: "read", contents: "read" }) || verify.environment !== undefined) {
    problems.push("release-verify-read-only");
  }
  if (
    !exactRecord(npmPublish.permissions, { actions: "read", contents: "read", "id-token": "write" }) ||
    !exactRecord(npmPublish.environment, { name: "npm-publish" })
  ) {
    problems.push("release-npm-oidc-boundary");
  }
  if (
    !exactRecord(githubRelease.permissions, { actions: "read", contents: "write" }) ||
    !exactRecord(githubRelease.environment, { name: "github-release" }) ||
    githubRelease["timeout-minutes"] !== 120
  ) {
    problems.push("release-github-write-boundary");
  }
  if (
    !exactRecord(mcpRegistry.permissions, { actions: "read", contents: "read", "id-token": "write" }) ||
    !exactRecord(mcpRegistry.environment, { name: "mcp-registry" })
  ) {
    problems.push("release-mcp-oidc-boundary");
  }
  if (
    JSON.stringify(npmPublish.needs) !== JSON.stringify(["verify"]) ||
    JSON.stringify(githubRelease.needs) !== JSON.stringify(["verify", "npm_publish"]) ||
    JSON.stringify(mcpRegistry.needs) !== JSON.stringify(["verify", "npm_publish", "github_release"])
  ) {
    problems.push("release-publication-order");
  }
  if (
    npmPublish.if !== undefined ||
    githubRelease.if !== undefined ||
    mcpRegistry.if !== `\${{ needs.verify.outputs.channel == 'latest' }}`
  ) {
    problems.push("release-channel-boundary");
  }

  const verifySteps = steps(verify);
  const npmSteps = steps(npmPublish);
  const githubSteps = steps(githubRelease);
  const mcpSteps = steps(mcpRegistry);
  const privilegedSteps = [...npmSteps, ...githubSteps, ...mcpSteps];
  const checkout = verifySteps.find(
    (step) => typeof step.uses === "string" && step.uses.startsWith("actions/checkout@")
  );
  if (
    checkout === undefined ||
    !pinnedAction(checkout, "actions/checkout") ||
    !exactRecord(checkout.with, { "fetch-depth": 0, "persist-credentials": false, ref: `\${{ github.ref }}` })
  ) {
    problems.push("release-verify-exact-checkout");
  }
  const upload = namedStep(verifySteps, "Upload exact verified release handoff");
  const uploadWith = record(upload?.with);
  if (
    upload === undefined ||
    !pinnedAction(upload, "actions/upload-artifact") ||
    upload?.id !== "handoff_upload" ||
    uploadWith?.name !== `release-handoff-\${{ github.sha }}-\${{ github.run_attempt }}` ||
    uploadWith?.path !== `\${{ runner.temp }}/release-handoff` ||
    uploadWith?.["compression-level"] !== 0 ||
    uploadWith?.["include-hidden-files"] !== true ||
    uploadWith?.["if-no-files-found"] !== "error"
  ) {
    problems.push("release-exact-handoff-upload");
  }
  const verifyRuns = verifySteps.map((step) => run(step)).join("\n");
  if (
    !verifyRuns.includes('candidate "$SOURCE_SHA"') ||
    !verifyRuns.includes('npm-candidate "$SOURCE_SHA"') ||
    !verifyRuns.includes('"$ACTUAL_ARTIFACT_DIGEST" != "$PINNED_ARTIFACT_DIGEST"') ||
    !verifyRuns.includes('"$ACTUAL_NPM_ARTIFACT_DIGEST" != "$PINNED_NPM_ARTIFACT_DIGEST"')
  ) {
    problems.push("release-canonical-ci-artifacts");
  }

  const privilegedSource = JSON.stringify({ githubRelease, mcpRegistry, npmPublish });
  if (
    privilegedSource.includes("$GITHUB_WORKSPACE") ||
    privilegedSteps.some(
      (step) =>
        (typeof step.uses === "string" && (step.uses.startsWith("actions/checkout@") || step.uses.startsWith("./"))) ||
        run(step).includes("npm ci") ||
        run(step).includes("npm run ")
    )
  ) {
    problems.push("release-privileged-untrusted-code");
  }
  const tokenEnvExposed = [npmPublish, githubRelease, mcpRegistry, ...privilegedSteps].some((owner) => {
    const env = record(owner.env);
    return ["NPM_TOKEN", "NODE_AUTH_TOKEN"].some((key) => env?.[key] !== undefined && env[key] !== "");
  });
  if (privilegedSource.includes("secrets.") || tokenEnvExposed) {
    problems.push("release-long-lived-secret");
  }
  const setupNode = npmSteps.find(
    (step) => typeof step.uses === "string" && step.uses.startsWith("actions/setup-node@")
  );
  const setupNodeWith = record(setupNode?.with);
  const npmPublication = namedStep(npmSteps, "Publish exact npm tarball with Trusted Publishing or verify rerun");
  const npmPublicationEnv = record(npmPublication.env);
  const npmRun = run(npmPublication);
  const provenanceIdentityCarriers = ["NPM_ID_TOKEN", "SIGSTORE_ID_TOKEN", "GITLAB_CI"] as const;
  if (
    setupNode === undefined ||
    !pinnedAction(setupNode, "actions/setup-node") ||
    setupNodeWith?.["node-version"] !== 24 ||
    typeof npmPublish["timeout-minutes"] !== "number" ||
    npmPublish["timeout-minutes"] < 90 ||
    !npmRun.includes("11.5.1") ||
    !npmRun.includes('PACKAGE_TARBALL="$PWD/npm-package/enquire-mcp-npm.tgz"') ||
    [...npmRun.matchAll(/"\$NPM_BIN"\s+publish\s+"\$PACKAGE_TARBALL"/gu)].length !== 1 ||
    [...npmRun.matchAll(/--ignore-scripts/gu)].length !== 1 ||
    [...npmRun.matchAll(/(?:^|\s)--provenance(?=\s|$)/gu)].length !== 1 ||
    [...npmRun.matchAll(/\bNPM_CONFIG_PROVENANCE=true\b/gu)].length !== 1 ||
    !npmRun.includes("npm_config_provenance|npm_config_provenance_file") ||
    provenanceIdentityCarriers.some(
      (carrier) => npmPublicationEnv?.[carrier] !== "" || npmRun.split(`--unset=${carrier}`).length !== 2
    ) ||
    npmRun.includes("--provenance-file") ||
    !npmRun.includes('--provenance --access public --tag "$CHANNEL" --ignore-scripts')
  ) {
    problems.push("release-npm-trusted-publishing");
  }
  const mcpRun = run(namedStep(mcpSteps, "Publish exact stable manifest to MCP Registry with OIDC"));
  if (
    !mcpRun.includes("mcp-publisher_linux_amd64.tar.gz") ||
    !mcpRun.includes("login github-oidc --registry=https://registry.modelcontextprotocol.io") ||
    !mcpRun.includes("ab128162b0616090b47cf245afe0a23f3ef08936fdce19074f5ba0a4469281ac")
  ) {
    problems.push("release-mcp-publisher-identity");
  }

  const expectedReviewedCode = {
    npm: new Map([
      ["scripts/check-release-integrity.mjs", fileSha256("scripts/check-release-integrity.mjs")],
      ["scripts/npm-package-artifact.mjs", fileSha256("scripts/npm-package-artifact.mjs")],
      ["scripts/lib/entrypoint.mjs", fileSha256("scripts/lib/entrypoint.mjs")]
    ]),
    github: new Map([
      [
        ".github/scripts/release-mcpb-github-transaction.sh",
        fileSha256(".github/scripts/release-mcpb-github-transaction.sh")
      ],
      ["scripts/check-release-integrity.mjs", fileSha256("scripts/check-release-integrity.mjs")],
      ["scripts/lib/entrypoint.mjs", fileSha256("scripts/lib/entrypoint.mjs")]
    ]),
    mcp: new Map([
      ["scripts/check-release-integrity.mjs", fileSha256("scripts/check-release-integrity.mjs")],
      ["scripts/lib/entrypoint.mjs", fileSha256("scripts/lib/entrypoint.mjs")]
    ])
  } as const;
  for (const [label, jobSteps] of [
    ["npm", npmSteps],
    ["github", githubSteps],
    ["mcp", mcpSteps]
  ] as const) {
    const handoff = namedStep(jobSteps, "Download and verify exact release handoff");
    const handoffRun = run(handoff);
    if (
      !handoffRun.includes("actions/artifacts/$HANDOFF_ARTIFACT_ID/zip") ||
      !handoffRun.includes('[[ ! "$EXPECTED_HANDOFF_DIGEST" =~ ^[0-9a-f]{64}$ ]]') ||
      !handoffRun.includes('ACTUAL_HANDOFF_DIGEST="$(sha256sum "$HANDOFF_ZIP"') ||
      handoffRun.includes('ACTUAL_HANDOFF_DIGEST="sha256:$(sha256sum "$HANDOFF_ZIP"') ||
      !handoffRun.includes('"$ACTUAL_HANDOFF_DIGEST" != "$EXPECTED_HANDOFF_DIGEST"') ||
      !handoffRun.includes("unexpected release handoff inventory") ||
      !handoffRun.includes("sha256sum -c release-files.sha256")
    ) {
      problems.push(`release-${label}-exact-handoff`);
    }
    const codeIdentity = run(namedStep(jobSteps, "Assert reviewed privileged code identity"));
    const reviewedEntries = [...codeIdentity.matchAll(/printf '%s {2}%s\\n' '([0-9a-f]{64})' '([^']+)'/gu)].map(
      (match) => [match[2], match[1]] as const
    );
    const expectedEntries = [...expectedReviewedCode[label].entries()];
    if (
      !codeIdentity.includes("{\n") ||
      !codeIdentity.includes("} | sha256sum -c -") ||
      JSON.stringify(reviewedEntries) !== JSON.stringify(expectedEntries)
    ) {
      problems.push(`release-${label}-reviewed-code`);
    }
  }
  if (privilegedSteps.some((step) => typeof step.uses === "string" && !/@[0-9a-f]{40}$/u.test(step.uses))) {
    problems.push("release-unpinned-action");
  }
  return problems;
}

function replaceOnce(source: string, needle: string, replacement: string): string {
  const first = source.indexOf(needle);
  if (first < 0 || source.indexOf(needle, first + needle.length) >= 0) {
    throw new Error(`test mutation target must occur exactly once: ${needle}`);
  }
  const mutated = `${source.slice(0, first)}${replacement}${source.slice(first + needle.length)}`;
  if (mutated === source) throw new Error("test mutation did not change its source");
  return mutated;
}

function replaceOccurrence(
  source: string,
  needle: string,
  replacement: string,
  occurrence: number,
  expectedOccurrences: number
): string {
  if (needle.length === 0) throw new Error("test mutation target must not be empty");
  if (!Number.isSafeInteger(occurrence) || occurrence < 1) {
    throw new Error(`test mutation occurrence must be a positive safe integer: ${occurrence}`);
  }
  if (!Number.isSafeInteger(expectedOccurrences) || expectedOccurrences < 1) {
    throw new Error(`test mutation expected occurrences must be a positive safe integer: ${expectedOccurrences}`);
  }
  if (occurrence > expectedOccurrences) {
    throw new Error(`test mutation occurrence ${occurrence} exceeds expected census ${expectedOccurrences}`);
  }
  const offsets: number[] = [];
  let searchFrom = 0;
  while (searchFrom <= source.length) {
    const offset = source.indexOf(needle, searchFrom);
    if (offset < 0) break;
    offsets.push(offset);
    searchFrom = offset + needle.length;
  }
  if (offsets.length !== expectedOccurrences) {
    throw new Error(
      `test mutation target expected ${expectedOccurrences} occurrence(s), found ${offsets.length}: ${needle}`
    );
  }
  const offset = offsets[occurrence - 1];
  if (offset === undefined) throw new Error(`test mutation occurrence ${occurrence} is missing: ${needle}`);
  const mutated = `${source.slice(0, offset)}${replacement}${source.slice(offset + needle.length)}`;
  if (mutated === source) throw new Error(`test mutation occurrence ${occurrence} did not change its source`);
  return mutated;
}

describe("npm dist-tag maintenance policy", () => {
  it("classifies only the two fixed maintenance targets and treats absence as idempotent", () => {
    expect(DIST_TAG_MAINTENANCE_TARGETS).toEqual(["alpha", "beta"]);
    expect(classifyMaintenanceTargets('{"latest":"4.0.0","alpha":"2.0.0-alpha.0"}')).toEqual({
      alphaPresent: true,
      betaPresent: false
    });
    expect(classifyMaintenanceTargets('{"latest":"4.0.0"}')).toEqual({
      alphaPresent: false,
      betaPresent: false
    });
    expect(() => assertMaintenanceTargetsAbsent('{"latest":"4.0.0"}')).not.toThrow();
  });

  it("fails closed on malformed, non-object, non-string and oversized registry responses", () => {
    for (const source of [
      "",
      "not-json",
      "null",
      "[]",
      '{"alpha":1}',
      '{"alpha":" 2.0.0-alpha.0"}',
      '{"bad tag":"1.0.0"}',
      JSON.stringify({ latest: "x".repeat(65_536) })
    ]) {
      expect(() => parseDistTagsJson(source), source.slice(0, 80)).toThrow(/dist-tag-policy/u);
    }
  });

  it("fails the parsed postcondition when either removed tag is still published", () => {
    expect(() => assertMaintenanceTargetsAbsent('{"latest":"4.0.0","alpha":"2.0.0-alpha.0"}')).toThrow(
      /tags still present: alpha/u
    );
    expect(() => assertMaintenanceTargetsAbsent('{"beta":"2.0.0-beta.4","alpha":"2.0.0-alpha.0"}')).toThrow(
      /tags still present: alpha, beta/u
    );
  });

  it("keeps CLI output fixed and returns non-zero for malformed and failed post-state input", () => {
    const classify = spawnSync(process.execPath, [policyScriptPath, "classify"], {
      encoding: "utf8",
      input: '{"latest":"4.0.0","beta":"2.0.0-beta.4"}'
    });
    expect(classify.status).toBe(0);
    expect(classify.stdout).toBe("alpha_present=false\nbeta_present=true\n");

    const malformed = spawnSync(process.execPath, [policyScriptPath, "classify"], {
      encoding: "utf8",
      input: "{"
    });
    expect(malformed.status).not.toBe(0);
    expect(malformed.stderr).toContain("not valid JSON");

    const stillPresent = spawnSync(process.execPath, [policyScriptPath, "assert-absent"], {
      encoding: "utf8",
      input: '{"alpha":"2.0.0-alpha.0"}'
    });
    expect(stillPresent.status).not.toBe(0);
    expect(stillPresent.stderr).toContain("postcondition failed");
  });

  it("propagates an upstream registry failure even when it emitted parseable JSON", () => {
    const command =
      '"$DIST_TAG_TEST_NODE" -e "$DIST_TAG_TEST_PRODUCER" | ' +
      '"$DIST_TAG_TEST_NODE" "$DIST_TAG_TEST_POLICY" classify';
    const env = {
      ...process.env,
      DIST_TAG_TEST_NODE: process.execPath,
      DIST_TAG_TEST_POLICY: policyScriptPath,
      DIST_TAG_TEST_PRODUCER: 'process.stdout.write(JSON.stringify({latest:"4.0.0"})); process.exitCode = 23;'
    };
    const masked = spawnSync("/bin/bash", ["--noprofile", "--norc", "-e", "-c", command], {
      encoding: "utf8",
      env
    });
    const failClosed = spawnSync("/bin/bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", command], {
      encoding: "utf8",
      env
    });
    expect(masked.status, "negative control: a plain pipeline masks the producer failure").toBe(0);
    expect(failClosed.status, "the workflow pipefail boundary must propagate the registry exit").toBe(23);
  });
});

describe("privileged maintenance workflow invariants", () => {
  const cleanup = readFileSync(cleanupPath, "utf8");
  const docs = readFileSync(publishDocsPath, "utf8");
  const release = readFileSync(releasePath, "utf8");

  it("keeps cleanup on protected main with strict pre/post observations and exact mutations", () => {
    expect(cleanupWorkflowProblems(cleanup)).toEqual([]);
  });

  it("NEGATIVE: detects cleanup privilege, failure-masking, mutation-scope and postcondition regressions", () => {
    expect(
      cleanupWorkflowProblems(replaceOnce(cleanup, "      name: npm-maintenance", "      name: unprotected"))
    ).toContain("cleanup-protected-environment");
    expect(
      cleanupWorkflowProblems(replaceOnce(cleanup, `if: ${CLEANUP_GUARD}`, `if: ${CONFIRM_ONLY_GUARD}`))
    ).toContain("cleanup-main-ref-guard");
    expect(
      cleanupWorkflowProblems(
        replaceOnce(
          cleanup,
          "npm dist-tag rm @oomkapwn/enquire-mcp alpha --registry=https://registry.npmjs.org/\n          --fetch-retries=0 --fetch-timeout=60000",
          "npm dist-tag rm @oomkapwn/enquire-mcp alpha --registry=https://registry.npmjs.org/\n          --fetch-retries=0 --fetch-timeout=60000 || true"
        )
      )
    ).toContain("cleanup-masked-failure");
    expect(
      cleanupWorkflowProblems(
        replaceOnce(
          cleanup,
          'node "$GITHUB_WORKSPACE/scripts/npm-dist-tag-policy.mjs" assert-absent',
          "npm view @oomkapwn/enquire-mcp dist-tags"
        )
      )
    ).toContain("cleanup-parsed-postcondition");
    expect(
      cleanupWorkflowProblems(
        replaceOnce(
          cleanup,
          "npm dist-tag rm @oomkapwn/enquire-mcp beta",
          "npm dist-tag rm @oomkapwn/enquire-mcp gamma"
        )
      )
    ).toContain("cleanup-mutation-scope");
  });

  it("keeps source execution read-only and Pages/OIDC authority in the protected deploy job", () => {
    expect(publishDocsWorkflowProblems(docs)).toEqual([]);
  });

  it("detects docs ref, credential, privilege and exact-artifact regressions", () => {
    expect(
      publishDocsWorkflowProblems(
        replaceOnce(
          docs,
          `  build:\n    runs-on: ubuntu-latest\n    timeout-minutes: 10\n    if: ${MAIN_REF_GUARD}\n`,
          "  build:\n    runs-on: ubuntu-latest\n    timeout-minutes: 10\n"
        )
      )
    ).toContain("docs-main-ref-guards");
    expect(
      publishDocsWorkflowProblems(
        replaceOnce(docs, "          persist-credentials: false", "          persist-credentials: true")
      )
    ).toContain("docs-checkout-credentials");
    expect(
      publishDocsWorkflowProblems(
        replaceOnce(docs, "      contents: read", "      contents: read\n      id-token: write")
      )
    ).toContain("docs-build-least-privilege");
    expect(
      publishDocsWorkflowProblems(
        replaceOnce(docs, `          artifact_name: ${SHA_ARTIFACT_NAME}`, "          artifact_name: github-pages")
      )
    ).toContain("docs-exact-deploy-artifact");
    expect(
      publishDocsWorkflowProblems(
        replaceOnce(docs, "      - uses: actions/configure-pages@45bfe0192ca1faeb007ade9deae92b16b8254a0d # v6\n", "")
      )
    ).toContain("docs-configure-build-boundary");
  });

  it("splits release verification, npm, GitHub Release and MCP Registry authority around one exact handoff", () => {
    expect(releaseWorkflowProblems(release)).toEqual([]);
  });

  it("detects release privilege, secret and unreviewed-code regressions", () => {
    expect(() => replaceOnce("alpha", "alpha", "alpha")).toThrow(/did not change its source/);
    expect(() => replaceOccurrence("alpha", "alpha", "alpha", 1, 1)).toThrow(/did not change its source/);
    expect(() => replaceOccurrence("alpha", "alpha", "omega", 0, 1)).toThrow(/positive safe integer/);
    expect(() => replaceOccurrence("alpha", "alpha", "omega", 1, 0)).toThrow(/positive safe integer/);
    expect(() => replaceOccurrence("alpha alpha", "alpha", "omega", 1, 1)).toThrow(
      /expected 1 occurrence\(s\), found 2/
    );
    expect(() => replaceOccurrence("alpha", "alpha", "omega", 1, 2)).toThrow(
      /expected 2 occurrence\(s\), found 1/
    );
    expect(
      releaseWorkflowProblems(replaceOnce(release, "permissions: {}", "permissions:\n  contents: write"))
    ).toContain("release-root-permissions");
    expect(
      releaseWorkflowProblems(
        replaceOnce(
          release,
          "    environment:\n      name: npm-publish",
          `    environment:\n      name: npm-publish\n    env:\n      NODE_AUTH_TOKEN: ${NPM_TOKEN_SECRET}`
        )
      )
    ).toContain("release-long-lived-secret");
    expect(
      releaseWorkflowProblems(
        replaceOccurrence(
          release,
          "      - name: Assert reviewed privileged code identity",
          "      - name: Assert reviewed privileged code identity\n        env:\n          SOURCE: $GITHUB_WORKSPACE",
          1,
          3
        )
      )
    ).toContain("release-privileged-untrusted-code");
    expect(
      releaseWorkflowProblems(
        replaceOnce(
          release,
          '--provenance --access public --tag "$CHANNEL" --ignore-scripts',
          '--provenance --access public --tag "$CHANNEL"'
        )
      )
    ).toContain("release-npm-trusted-publishing");
    expect(
      releaseWorkflowProblems(
        replaceOnce(
          release,
          '--provenance --access public --tag "$CHANNEL" --ignore-scripts',
          '--access public --tag "$CHANNEL" --ignore-scripts'
        )
      )
    ).toContain("release-npm-trusted-publishing");
    expect(
      releaseWorkflowProblems(replaceOnce(release, "NPM_CONFIG_PROVENANCE=true", "NPM_CONFIG_PROVENANCE=false"))
    ).toContain("release-npm-trusted-publishing");
    for (const carrier of ["NPM_ID_TOKEN", "SIGSTORE_ID_TOKEN", "GITLAB_CI"] as const) {
      expect(releaseWorkflowProblems(replaceOnce(release, `--unset=${carrier}`, ""))).toContain(
        "release-npm-trusted-publishing"
      );
      expect(
        releaseWorkflowProblems(replaceOnce(release, `          ${carrier}: ''`, `          ${carrier}: inherited`))
      ).toContain("release-npm-trusted-publishing");
    }
    expect(
      releaseWorkflowProblems(
        replaceOnce(release, "|npm_config_provenance|npm_config_provenance_file)", "|npm_config_provenance_file)")
      )
    ).toContain("release-npm-trusted-publishing");
    expect(
      releaseWorkflowProblems(
        replaceOnce(release, "|npm_config_provenance|npm_config_provenance_file)", "|npm_config_provenance)")
      )
    ).toContain("release-npm-trusted-publishing");
    const npmArtifactDigest = fileSha256("scripts/npm-package-artifact.mjs");
    const npmArtifactIdentity = `'${npmArtifactDigest}' 'scripts/npm-package-artifact.mjs'`;
    expect(
      releaseWorkflowProblems(
        replaceOnce(release, npmArtifactIdentity, `'${"0".repeat(64)}' 'scripts/npm-package-artifact.mjs'`)
      )
    ).toContain("release-npm-reviewed-code");
    expect(releaseWorkflowProblems(replaceOnce(release, npmArtifactIdentity, ""))).toContain(
      "release-npm-reviewed-code"
    );
  });

  it("detects release environment, dependency, OIDC and artifact-digest regressions", () => {
    expect(
      releaseWorkflowProblems(replaceOnce(release, "      name: npm-publish", "      name: unprotected-npm"))
    ).toContain("release-npm-oidc-boundary");
    expect(releaseWorkflowProblems(replaceOnce(release, "          include-hidden-files: true\n", ""))).toContain(
      "release-exact-handoff-upload"
    );
    expect(
      releaseWorkflowProblems(
        replaceOccurrence(
          release,
          '"$ACTUAL_HANDOFF_DIGEST" != "$EXPECTED_HANDOFF_DIGEST"',
          '"$ACTUAL_HANDOFF_DIGEST" = "$EXPECTED_HANDOFF_DIGEST"',
          1,
          3
        )
      )
    ).toContain("release-npm-exact-handoff");
    expect(
      releaseWorkflowProblems(
        replaceOccurrence(
          release,
          'ACTUAL_HANDOFF_DIGEST="$(sha256sum "$HANDOFF_ZIP"',
          'ACTUAL_HANDOFF_DIGEST="sha256:$(sha256sum "$HANDOFF_ZIP"',
          1,
          3
        )
      )
    ).toContain("release-npm-exact-handoff");
    expect(
      releaseWorkflowProblems(
        replaceOccurrence(
          release,
          '[[ ! "$EXPECTED_HANDOFF_DIGEST" =~ ^[0-9a-f]{64}$ ]]',
          '[[ -z "$EXPECTED_HANDOFF_DIGEST" ]]',
          1,
          3
        )
      )
    ).toContain("release-npm-exact-handoff");
    expect(
      releaseWorkflowProblems(
        replaceOnce(
          release,
          "    needs:\n      - verify\n      - npm_publish\n      - github_release",
          "    needs:\n      - verify\n      - github_release"
        )
      )
    ).toContain("release-publication-order");
    expect(
      releaseWorkflowProblems(replaceOnce(release, `    if: \${{ needs.verify.outputs.channel == 'latest' }}\n`, ""))
    ).toContain("release-channel-boundary");
    expect(
      releaseWorkflowProblems(
        replaceOnce(
          release,
          "  npm_publish:\n    name:",
          `  npm_publish:\n    if: \${{ needs.verify.outputs.channel == 'latest' }}\n    name:`
        )
      )
    ).toContain("release-channel-boundary");
    expect(
      releaseWorkflowProblems(
        replaceOnce(
          release,
          "      id-token: write\n    environment:\n      name: mcp-registry",
          "    environment:\n      name: mcp-registry"
        )
      )
    ).toContain("release-mcp-oidc-boundary");
    expect(
      releaseWorkflowProblems(
        replaceOccurrence(release, "    timeout-minutes: 120", "    timeout-minutes: 60", 1, 2)
      )
    ).toContain("release-npm-trusted-publishing");
    expect(
      releaseWorkflowProblems(
        replaceOccurrence(release, "    timeout-minutes: 120", "    timeout-minutes: 60", 2, 2)
      )
    ).toContain("release-github-write-boundary");
    expect(
      releaseWorkflowProblems(
        replaceOnce(
          release,
          'PACKAGE_TARBALL="$PWD/npm-package/enquire-mcp-npm.tgz"',
          'PACKAGE_TARBALL="npm-package/enquire-mcp-npm.tgz"'
        )
      )
    ).toContain("release-npm-trusted-publishing");
  });
});
