#!/usr/bin/env node
// Structural release gate for the one-build/three-consumer npm artifact chain.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
import { isEntrypoint } from "./lib/entrypoint.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const UPLOAD_ARTIFACT = "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";
const DOWNLOAD_ARTIFACT = "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c";
const githubExpression = (expression) => `$${`{{ ${expression} }}`}`;
const CONSUMER_COMMAND = [
  "node scripts/package-consumer.mjs \\",
  "  --tarball artifacts/npm-package/enquire-mcp-npm.tgz \\",
  "  --manifest artifacts/npm-package/npm-package-manifest.json \\",
  '  --source-sha "$SOURCE_SHA" --run-id "$SOURCE_RUN_ID" --run-attempt "$SOURCE_RUN_ATTEMPT"'
].join("\n");

function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}

function steps(job) {
  return Array.isArray(job?.steps) ? job.steps.map(record).filter(Boolean) : [];
}

function namedStep(jobSteps, name) {
  return jobSteps.find((step) => step.name === name);
}

function runBody(step) {
  return typeof step?.run === "string" ? step.run.trimEnd() : "";
}

function parseWorkflow(source, label, problems) {
  try {
    return record(load(source));
  } catch {
    problems.push(`${label} must be valid YAML`);
    return null;
  }
}

function countMatches(source, pattern) {
  return [...source.matchAll(pattern)].length;
}

/**
 * Check the complete static npm artifact producer/consumer/publisher chain.
 *
 * @param {{ci:string,release:string,consumer:string,artifact:string}} inputs Tracked source texts.
 * @returns {string[]} Fail-closed structural problems.
 */
export function npmPackagePipelineProblems(inputs) {
  const problems = [];
  if (
    !record(inputs) ||
    typeof inputs.ci !== "string" ||
    typeof inputs.release !== "string" ||
    typeof inputs.consumer !== "string" ||
    typeof inputs.artifact !== "string"
  ) {
    return ["npm artifact pipeline inputs must contain ci, release, consumer, and artifact source strings"];
  }
  const ci = parseWorkflow(inputs.ci, "ci.yml", problems);
  const release = parseWorkflow(inputs.release, "release.yml", problems);
  if (!ci || !release) return problems;

  const ciJobs = record(ci.jobs);
  const producer = record(ciJobs?.["npm-package"]);
  const matrix = record(ciJobs?.["package-consumer-matrix"]);
  const aggregate = record(ciJobs?.["package-consumer"]);
  const producerSteps = steps(producer);
  const matrixSteps = steps(matrix);
  const identity = namedStep(producerSteps, "Bind npm artifact identity to the producer attempt");
  const build = namedStep(producerSteps, "Build one canonical npm tarball and source receipt");
  const upload = namedStep(producerSteps, "Export canonical npm tarball and source receipt");
  const uploadWith = record(upload?.with);
  const producerOutputs = record(producer?.outputs);
  const producerEnv = record(producer?.env);
  const expectedUploadPath = "npm-package/enquire-mcp-npm.tgz\nnpm-package/npm-package-manifest.json\n";
  if (
    producer?.name !== "npm-package" ||
    producer?.["runs-on"] !== "ubuntu-latest" ||
    producer?.["timeout-minutes"] !== 20 ||
    "needs" in (producer ?? {}) ||
    "if" in (producer ?? {}) ||
    "continue-on-error" in (producer ?? {}) ||
    producerEnv?.NPM_CONFIG_ENGINE_STRICT !== "true" ||
    producerEnv?.NPM_CONFIG_SCRIPT_SHELL !== "/bin/bash" ||
    producerOutputs?.artifact_name !== githubExpression("steps.artifact_identity.outputs.name") ||
    producerOutputs?.artifact_id !== githubExpression("steps.npm_export.outputs.artifact-id") ||
    producerOutputs?.artifact_digest !== githubExpression("steps.npm_export.outputs.artifact-digest") ||
    producerOutputs?.producer_attempt !== githubExpression("steps.artifact_identity.outputs.run_attempt") ||
    identity?.id !== "artifact_identity" ||
    runBody(identity) !==
      'echo "name=npm-package-candidate-$GITHUB_RUN_ATTEMPT" >> "$GITHUB_OUTPUT"\n' +
        'echo "run_attempt=$GITHUB_RUN_ATTEMPT" >> "$GITHUB_OUTPUT"' ||
    !runBody(build).includes("npm pack --json --ignore-scripts --pack-destination") ||
    !runBody(build).includes("node scripts/npm-package-artifact.mjs create") ||
    !runBody(build).includes("node scripts/npm-package-artifact.mjs verify") ||
    upload?.id !== "npm_export" ||
    upload?.uses !== UPLOAD_ARTIFACT ||
    uploadWith?.name !== githubExpression("steps.artifact_identity.outputs.name") ||
    uploadWith?.path !== expectedUploadPath ||
    uploadWith?.["if-no-files-found"] !== "error" ||
    uploadWith?.["retention-days"] !== 7 ||
    uploadWith?.["compression-level"] !== 0 ||
    producerSteps.some((step) => "if" in step || "continue-on-error" in step) ||
    countMatches(inputs.ci, /\bnpm\s+pack\b/gu) !== 1
  ) {
    problems.push("CI must build and export exactly one source-bound canonical npm artifact");
  }
  if (
    !inputs.artifact.includes("export function inspectNpmTarballInventory(tarballBytes)") ||
    !inputs.artifact.includes("const tarEntries = inspectNpmTarEntries(tarballBytes);") ||
    !inputs.artifact.includes("const actualInventory = tarEntries.files;") ||
    !inputs.artifact.includes("assertActualTarballInventory(tarballBytes, declaredInventory, source.allowlist)") ||
    !inputs.artifact.includes(
      "assertActualTarballInventory(tarballBytes, manifestInventory, sourcePackage.allowlist)"
    ) ||
    !inputs.artifact.includes("actual npm tarball inventory differs from declared file metadata") ||
    !inputs.artifact.includes("uses forbidden type")
  ) {
    problems.push("canonical receipt must bind the actual tar entries to the declared package allowlist");
  }

  const matrixRows = record(record(matrix?.strategy)?.matrix)?.include;
  const expectedRows = [
    { label: "linux", os: "ubuntu-latest", arch: "x64", script_shell: "/bin/bash" },
    {
      label: "windows",
      os: "windows-2025",
      arch: "x64",
      script_shell: "C:\\Program Files\\Git\\bin\\bash.exe"
    },
    { label: "macos", os: "macos-latest", arch: "arm64", script_shell: "/bin/bash" }
  ];
  const download = namedStep(matrixSteps, "Download exact canonical npm candidate");
  const downloadWith = record(download?.with);
  const consume = namedStep(matrixSteps, "Verify canonical consumers with and without optional dependencies");
  const consumeEnv = record(consume?.env);
  if (
    matrix?.needs !== "npm-package" ||
    JSON.stringify(matrixRows) !== JSON.stringify(expectedRows) ||
    download?.uses !== DOWNLOAD_ARTIFACT ||
    downloadWith?.name !== githubExpression("needs.npm-package.outputs.artifact_name") ||
    downloadWith?.path !== "artifacts/npm-package" ||
    downloadWith?.["digest-mismatch"] !== "error" ||
    runBody(consume) !== CONSUMER_COMMAND ||
    consumeEnv?.SOURCE_SHA !== githubExpression("github.sha") ||
    consumeEnv?.SOURCE_RUN_ID !== githubExpression("github.run_id") ||
    consumeEnv?.SOURCE_RUN_ATTEMPT !== githubExpression("needs.npm-package.outputs.producer_attempt") ||
    matrixSteps.some((step) => runBody(step).includes("npm pack")) ||
    matrixSteps.some((step) => "if" in step || "continue-on-error" in step) ||
    aggregate?.needs !== "package-consumer-matrix" ||
    aggregate?.if !== githubExpression("always()")
  ) {
    problems.push("all package-consumer OS lanes must consume the same explicit canonical tarball bytes");
  }

  const releaseJobs = record(release.jobs);
  const verify = record(releaseJobs?.verify);
  const npmPublish = record(releaseJobs?.npm_publish);
  const verifySteps = steps(verify);
  const npmPublishSteps = steps(npmPublish);
  const candidate = namedStep(verifySteps, "Download exact CI-gated Basic MCPB release asset");
  const candidateRun = runBody(candidate);
  const handoff = namedStep(verifySteps, "Assemble exact verified release handoff");
  const handoffRun = runBody(handoff);
  const handoffDownload = namedStep(npmPublishSteps, "Download and verify exact release handoff");
  const handoffDownloadRun = runBody(handoffDownload);
  const publication = namedStep(npmPublishSteps, "Publish exact npm tarball with Trusted Publishing or verify rerun");
  const publicationRun = runBody(publication);
  const publicationEnv = record(publication?.env);
  const provenanceIdentityCarriers = ["NPM_ID_TOKEN", "SIGSTORE_ID_TOKEN", "GITLAB_CI"];
  const verifyIndex = publicationRun.indexOf("scripts/npm-package-artifact.mjs verify");
  const rehashIndex = publicationRun.indexOf('PRE_PUBLISH_INTEGRITY=$(tarball_sri "$PACKAGE_TARBALL")');
  const publishIndex = publicationRun.indexOf('"$NPM_BIN" publish "$PACKAGE_TARBALL"');
  if (
    countMatches(inputs.release, /\bnpm\s+pack\b/gu) !== 0 ||
    !candidateRun.includes('npm-candidate "$SOURCE_SHA"') ||
    !candidateRun.includes(
      `"repos/${githubExpression("github.repository")}/actions/artifacts/$PINNED_NPM_ARTIFACT_ID/zip"`
    ) ||
    !candidateRun.includes('"$ACTUAL_NPM_ARTIFACT_DIGEST" != "$PINNED_NPM_ARTIFACT_DIGEST"') ||
    !candidateRun.includes('NPM_CANDIDATE_ZIP_SIZE=$(/usr/bin/stat --format=%s "$NPM_CANDIDATE_ZIP")') ||
    !candidateRun.includes('[ "$NPM_CANDIDATE_ZIP_SIZE" -gt 68157440 ]') ||
    !candidateRun.includes('new Set(["enquire-mcp-npm.tgz", "npm-package-manifest.json"])') ||
    !candidateRun.includes("node scripts/npm-package-artifact.mjs verify") ||
    !candidateRun.includes('echo "npm_build_run_attempt=$PINNED_NPM_RUN_ATTEMPT"') ||
    !handoffRun.includes(
      'cp -- npm-package/enquire-mcp-npm.tgz npm-package/npm-package-manifest.json "$HANDOFF_ROOT/npm-package/"'
    ) ||
    !handoffRun.includes("sha256sum -c release-files.sha256") ||
    !handoffDownloadRun.includes("actions/artifacts/$HANDOFF_ARTIFACT_ID/zip") ||
    !handoffDownloadRun.includes('"$ACTUAL_HANDOFF_DIGEST" != "$EXPECTED_HANDOFF_DIGEST"') ||
    !handoffDownloadRun.includes("unexpected release handoff inventory") ||
    !handoffDownloadRun.includes("sha256sum -c release-files.sha256") ||
    publicationEnv?.NPM_ARTIFACT_RUN_ID !== githubExpression("needs.verify.outputs.build_run_id") ||
    publicationEnv?.NPM_ARTIFACT_RUN_ATTEMPT !== githubExpression("needs.verify.outputs.npm_build_run_attempt") ||
    !publicationRun.includes('PACKAGE_TARBALL="$PWD/npm-package/enquire-mcp-npm.tgz"') ||
    !publicationRun.includes('PACKAGE_MANIFEST="npm-package/npm-package-manifest.json"') ||
    verifyIndex < 0 ||
    rehashIndex <= verifyIndex ||
    publishIndex <= rehashIndex ||
    countMatches(publicationRun, /"\$NPM_BIN"\s+publish\s+"\$PACKAGE_TARBALL"/gu) !== 1 ||
    countMatches(publicationRun, /--ignore-scripts/gu) !== 1 ||
    countMatches(publicationRun, /(?:^|\s)--provenance(?=\s|$)/gu) !== 1 ||
    countMatches(publicationRun, /\bNPM_CONFIG_PROVENANCE=true\b/gu) !== 1 ||
    !publicationRun.includes("npm_config_provenance|npm_config_provenance_file") ||
    provenanceIdentityCarriers.some(
      (carrier) => publicationEnv?.[carrier] !== "" || publicationRun.split(`--unset=${carrier}`).length !== 2
    ) ||
    publicationRun.includes("--provenance-file") ||
    !publicationRun.includes('--provenance --access public --tag "$CHANNEL" --ignore-scripts') ||
    JSON.stringify(npmPublish?.needs) !== JSON.stringify(["verify"]) ||
    record(npmPublish?.permissions)?.["id-token"] !== "write" ||
    record(npmPublish?.environment)?.name !== "npm-publish" ||
    npmPublishSteps.some((step) => typeof step.uses === "string" && step.uses.startsWith("actions/checkout@")) ||
    publicationRun.includes("--pack-destination")
  ) {
    problems.push("release must select, reverify, rehash, and publish the exact CI-gated npm artifact");
  }

  const explicitBranch = inputs.consumer.indexOf("if (canonicalArtifact !== null)");
  const explicitReturn = inputs.consumer.indexOf("return;", explicitBranch);
  const localPack = inputs.consumer.indexOf('runNpm(["pack"', explicitReturn);
  if (
    !inputs.consumer.includes("parsePackageConsumerArgs(process.argv.slice(2))") &&
    !inputs.consumer.includes("runPackageConsumer(process.argv.slice(2))")
  ) {
    problems.push("package-consumer entrypoint must pass its explicit canonical-artifact arguments");
  } else if (
    explicitBranch < 0 ||
    explicitReturn <= explicitBranch ||
    localPack <= explicitReturn ||
    !inputs.consumer.includes("verifyNpmPackageArtifactManifest(manifest, tarballBytes")
  ) {
    problems.push("package-consumer explicit artifact mode must verify and return before local npm pack");
  }
  if (
    !inputs.consumer.includes("export function packageCliProcessSpec(") ||
    !inputs.consumer.includes('const binDirectory = path.join(consumerDir, "node_modules", ".bin")') ||
    !inputs.consumer.includes('args: ["/d", "/s", "/c", "enquire-mcp.cmd --version"]') ||
    !inputs.consumer.includes('const shim = path.join(binDirectory, "enquire-mcp")') ||
    !inputs.consumer.includes("verifyPackagedCli(consumerDir, packageRoot, rootPackage.version, mode)") ||
    inputs.consumer.includes('spawnSync(process.execPath, [path.join(packageRoot, "dist", "index.js")')
  ) {
    problems.push("package-consumer must execute the installed cross-platform npm bin shim");
  }
  if (
    countMatches(inputs.consumer, /Object\.keys\(rootPackage\.optionalDependencies \?\? \{\}\)/gu) !== 1 ||
    !inputs.consumer.includes("export const OPTIONAL_DEPENDENCY_PROBES = Object.freeze([") ||
    !inputs.consumer.includes(
      '{ packageName: "pdfjs-dist", specifier: "pdfjs-dist/legacy/build/pdf.mjs", exportPaths: [["getDocument"]] }'
    ) ||
    !inputs.consumer.includes("function writeOptionalLoadabilityProbe(consumerDir, optionalProbes)") ||
    !inputs.consumer.includes("optional dependency probe inventory differs from package.json") ||
    !inputs.consumer.includes("const resolved = import.meta.resolve(importSpecifier)") ||
    !inputs.consumer.includes('const expectedPackageRoot = path.join(nodeModulesRoot, ...packageName.split("/"))') ||
    !inputs.consumer.includes("const loaded = await import(importSpecifier)") ||
    !inputs.consumer.includes('assert.equal(typeof capability, "function"') ||
    !inputs.consumer.includes('database.prepare("SELECT 1 AS ok").get().ok') ||
    !inputs.consumer.includes(
      'run(process.execPath, [path.join(consumerDir, "optional-loadability.mjs")], { cwd: consumerDir })'
    )
  ) {
    problems.push("package-consumer full lane must resolve and load every exact optional dependency");
  }
  return problems;
}

export function checkTrackedNpmPackagePipeline(root = ROOT) {
  return npmPackagePipelineProblems({
    ci: readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8"),
    release: readFileSync(resolve(root, ".github/workflows/release.yml"), "utf8"),
    consumer: readFileSync(resolve(root, "scripts/package-consumer.mjs"), "utf8"),
    artifact: readFileSync(resolve(root, "scripts/npm-package-artifact.mjs"), "utf8")
  });
}

if (isEntrypoint(import.meta.url)) {
  const problems = checkTrackedNpmPackagePipeline();
  if (problems.length === 0) {
    console.log("npm package pipeline: exact canonical artifact chain verified");
  } else {
    for (const problem of problems) console.error(`npm package pipeline: ${problem}`);
    process.exitCode = 1;
  }
}
