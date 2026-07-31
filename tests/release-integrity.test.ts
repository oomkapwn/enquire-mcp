import { existsSync, readFileSync } from "node:fs";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";
// @ts-expect-error — .mjs release script has no declaration file; tests exercise its pure core.
import {
  assertMcpbAssetVersion,
  assertReleaseTagMatchesVersion,
  assertChannelVersionAdvance,
  candidateRunIds,
  evaluateMcpbCandidateRun,
  evaluateMcpbReleaseState,
  evaluateNpmPublication,
  evaluateReleaseChecks,
  REQUIRED_RELEASE_CHECKS
} from "../scripts/check-release-integrity.mjs";
// @ts-expect-error — .mjs consumer helpers have no declaration file; the release invariant exercises cleanup behavior.
import { createOwnedScratch, removeOwnedScratch } from "../scripts/mcpb-consumer.mjs";
// @ts-expect-error — .mjs safety helpers have no declaration file; the release invariant exercises their pure contract.
import {
  nativeBinaryReason,
  portableArchiveKey,
  portableArchivePath,
  resolveRequiredDependencyRefs
} from "../scripts/lib/mcpb-safety.mjs";

interface CheckRun {
  id: number;
  name: string;
  status: "completed" | "in_progress";
  conclusion: string | null;
  started_at: string;
}

function run(
  name: string,
  id: number,
  conclusion: string | null = "success",
  status: CheckRun["status"] = "completed"
): CheckRun {
  return {
    id,
    name,
    status,
    conclusion,
    started_at: new Date(Date.UTC(2026, 6, 25, 0, 0, id)).toISOString()
  };
}

function allSuccessful(): CheckRun[] {
  return REQUIRED_RELEASE_CHECKS.map((name: string, index: number) => run(name, index + 1));
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

function hasRunLine(step: YamlRecord | undefined, command: string): boolean {
  return runBody(step)
    .split("\n")
    .some((line) => line.trim() === command);
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
    const setup = jobSteps.find(
      (step) => typeof step.uses === "string" && step.uses.startsWith("actions/setup-node@")
    );
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
    const exportStep = namedStep(
      packageSteps,
      "Export inspectable canonical MCPB candidate and transparency records"
    );
    const exportWith = yamlRecord(exportStep?.with);
    const exportPath = typeof exportWith?.path === "string" ? exportWith.path : "";
    if (
      mcpbPackageJob.name !== "mcpb-basic-package" ||
      mcpbPackageJob["runs-on"] !== "ubuntu-latest" ||
      mcpbPackageJob["timeout-minutes"] !== 30 ||
      "needs" in mcpbPackageJob ||
      "if" in mcpbPackageJob ||
      "continue-on-error" in mcpbPackageJob ||
      yamlRecord(mcpbPackageJob.env)?.NPM_CONFIG_ENGINE_STRICT !== "true" ||
      yamlRecord(mcpbPackageJob.env)?.NPM_CONFIG_SCRIPT_SHELL !== "/bin/bash" ||
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
  }
  const mcpbSteps = yamlSteps(mcpbMatrixJob);
  const mcpbDownload = namedStep(mcpbSteps, "Download canonical Linux MCPB candidate");
  const mcpbDownloadWith = yamlRecord(mcpbDownload?.with);
  if (
    mcpbDownload?.uses !== "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093" ||
    mcpbDownloadWith?.name !== `\${{ needs['mcpb-basic-package'].outputs.artifact_name }}` ||
    mcpbDownloadWith?.path !== "artifacts" ||
    "if" in (mcpbDownload ?? {}) ||
    "continue-on-error" in (mcpbDownload ?? {})
  ) {
    problems.push("mcpb-basic matrix must consume the exact pinned canonical Linux artifact on every OS");
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
  if (yamlRecord(document?.permissions)?.actions !== "read") {
    return ["release must grant read-only Actions API access for the exact-SHA MCPB artifact"];
  }
  const publish = yamlRecord(yamlRecord(document?.jobs)?.publish);
  const gate = namedStep(yamlSteps(publish ?? {}), "Assert tag is on main and required CI checks passed");
  const body = runBody(gate);
  if (
    Number(publish?.["timeout-minutes"] ?? 0) < 90 ||
    !body.includes("attempt<=120") ||
    !body.includes('"$attempt" -eq 120') ||
    !body.includes("after 60 minutes")
  ) {
    return ["release polling must outlive the blocking package-consumer matrix and leave publication headroom"];
  }
  return [];
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
  versionCheck: string;
  versionSync: string;
}): string[] {
  const problems: string[] = [];
  let manifest: Record<string, unknown>;
  let lock: Record<string, unknown>;
  let pkg: Record<string, unknown>;
  let releaseSteps: Array<Record<string, unknown>>;
  try {
    manifest = JSON.parse(inputs.manifest) as Record<string, unknown>;
    lock = JSON.parse(inputs.packageLock) as Record<string, unknown>;
    pkg = JSON.parse(inputs.packageJson) as Record<string, unknown>;
    const releaseDocument = yamlRecord(load(inputs.release));
    const releaseJob = yamlRecord(yamlRecord(releaseDocument?.jobs)?.publish);
    releaseSteps = yamlSteps(releaseJob ?? {});
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
    "Prepare draft GitHub Release",
    "Upload Basic MCPB asset, checksum, and provenance"
  ];
  const releaseStateIndices = releaseStateSteps.map((name) => releaseSteps.findIndex((step) => step.name === name));
  if (
    releaseStateIndices.some((index) => index < 0) ||
    releaseStateIndices.some((index, position) => position > 0 && index <= (releaseStateIndices[position - 1] ?? -1))
  ) {
    problems.push("release state machine must preflight all deterministic assets before npm, then draft/upload/publish");
  }
  if (
    JSON.stringify(toolNames) !== JSON.stringify(BASIC_MCPB_TOOLS) ||
    JSON.stringify(manifest.prompts) !== "[]" ||
    manifest.tools_generated !== false ||
    manifest.prompts_generated !== false
  ) {
    problems.push("MCPB Basic must expose exactly 13 approved read-only tools and zero prompts");
  }
  const expectedPrefix = [
    "${__dirname}/server/dist/index.js",
    "serve",
    "--vault",
    "${user_config.vault}",
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
  if (overrides?.tmp !== "0.2.6" || lockedTmp?.version !== "0.2.6" || lockPackages?.["node_modules/os-tmpdir"]) {
    problems.push("MCPB dev graph must override tmp to patched 0.2.6 without the orphaned legacy helper");
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
    !inputs.build.includes('writeFileSync(\n    path.join(STAGE, "third-party-licenses.json"),') ||
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
    !inputs.consumer.includes('template.uriTemplate), ["obsidian://note/{+notePath}"]') ||
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
    !inputs.consumer.includes('type: "directory"') ||
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
    !inputs.consumer.includes('hono: "^4.12.31"') ||
    !inputs.consumer.includes('archivedPackageVersions.get("@hono/node-server")') ||
    !inputs.consumer.includes('["2.0.11"]') ||
    !inputs.consumer.includes('archivedPackageVersions.get("hono")') ||
    !inputs.consumer.includes('["4.12.31"]') ||
    !inputs.consumer.includes("stranded embedding index and activation guard") ||
    !inputs.consumer.includes("Basic session changed isolated cache sentinel paths") ||
    !inputs.consumer.includes("XDG_CACHE_HOME") ||
    !inputs.consumer.includes("/Projects\\/Hermes\\.md|MCPB-basic-search-target/") ||
    !inputs.consumer.includes("server died after negative controls")
  ) {
    problems.push(
      "MCPB consumer must prove exact inventory, transparency records, resources, omitted deps, negatives, and post-refusal liveness"
    );
  }
  const freshUploadClassifier = 'CURRENT_ACTION=$(printf \'%s\' "$CURRENT_STATE" | release_state | jq -r \'.action\')';
  const freshUploadRefusal =
    'if [ "$CURRENT_ACTION" != "resume_draft" ] || [ "$CURRENT_NAME_COUNT" -ne 0 ]; then';
  const uploadPost = "curl --fail-with-body --silent --show-error --request POST";
  const freshUploadTagProof = `              assert_remote_tag_identity\n              ${uploadPost}`;
  const publicationTagProof =
    '          assert_remote_tag_identity\n          if [ "$FINAL_ACTION" = "publish_draft" ]; then';
  const finalPostconditionTagProof =
    "          assert_remote_tag_identity\n          FINAL_PRERELEASE=$(printf '%s' \"$RELEASE_JSON\" | jq -r '.prerelease')";
  const freshUploadClassifierIndex = inputs.release.indexOf(freshUploadClassifier);
  const freshUploadRefusalIndex = inputs.release.indexOf(freshUploadRefusal);
  const freshUploadTagProofIndex = inputs.release.indexOf(freshUploadTagProof);
  const uploadPostIndex = inputs.release.indexOf(uploadPost);
  const freshUploadOrderIsSafe =
    freshUploadClassifierIndex >= 0 &&
    freshUploadRefusalIndex > freshUploadClassifierIndex &&
    freshUploadTagProofIndex > freshUploadRefusalIndex &&
    uploadPostIndex > freshUploadTagProofIndex;
  if (
    inputs.release.includes("npm run mcpb:build") ||
    !inputs.release.includes("Download exact CI-gated Basic MCPB release asset") ||
    !inputs.release.includes("actions: read") ||
    !inputs.release.includes("checks: read") ||
    !inputs.release.includes('node-version: "22.13.0"') ||
    !inputs.release.includes("actions/workflows/ci.yml/runs?branch=main&event=push&head_sha=$SOURCE_SHA&per_page=100") ||
    inputs.release.includes("--status success") ||
    !inputs.integrity.includes("export function evaluateNpmPublication") ||
    !inputs.integrity.includes("export function evaluateMcpbReleaseState") ||
    !inputs.integrity.includes("export function candidateRunIds") ||
    !inputs.integrity.includes("export function evaluateMcpbCandidateRun") ||
    !inputs.integrity.includes("export function assertMcpbAssetVersion") ||
    !inputs.integrity.includes("export function assertChannelVersionAdvance") ||
    inputs.integrity.includes("release.target_commitish") ||
    !inputs.release.includes('node scripts/check-release-integrity.mjs asset-version "$VERSION"') ||
    !inputs.release.includes("node scripts/check-release-integrity.mjs candidate-runs") ||
    !/node scripts\/check-release-integrity\.mjs \\\s+candidate/u.test(inputs.release) ||
    (inputs.release.match(/node scripts\/check-release-integrity\.mjs release-state/g) ?? []).length !== 3 ||
    (inputs.release.match(/release-state "\$TAG" "\$EXPECTED_PRERELEASE"/g) ?? []).length !== 3 ||
    inputs.release.includes('release-state "$TAG" "$SOURCE_SHA"') ||
    (inputs.release.match(/node scripts\/check-release-integrity\.mjs \\\s+npm-state/gu) ?? []).length !== 3 ||
    !inputs.release.includes("build_artifact_id:") ||
    !inputs.release.includes("build_artifact_digest:") ||
    !inputs.release.includes("build_run_attempt:") ||
    !inputs.release.includes('echo "build_run_attempt=$PINNED_RUN_ATTEMPT" >> "$GITHUB_OUTPUT"') ||
    !inputs.release.includes('echo "artifact_id=$PINNED_ARTIFACT_ID" >> "$GITHUB_OUTPUT"') ||
    !inputs.release.includes('echo "artifact_digest=$PINNED_ARTIFACT_DIGEST" >> "$GITHUB_OUTPUT"') ||
    !inputs.release.includes("jobs?filter=all&per_page=100") ||
    !inputs.release.includes("actions/runs/$CANDIDATE_RUN_ID/artifacts?per_page=100") ||
    !inputs.release.includes("CHECK_PAGES=$(gh api --paginate --slurp") ||
    !inputs.release.includes("RUN_PAGES=$(gh api --paginate --slurp") ||
    !inputs.release.includes("JOB_PAGES=$(gh api --paginate --slurp") ||
    !inputs.release.includes("ARTIFACT_PAGES=$(gh api --paginate --slurp") ||
    !inputs.release.includes("actions/artifacts/$PINNED_ARTIFACT_ID/zip") ||
    !inputs.release.includes('ACTUAL_ARTIFACT_DIGEST="sha256:$(sha256sum "$CANDIDATE_ZIP"') ||
    !inputs.release.includes("Downloaded Actions artifact digest differs from the selected API identity") ||
    !inputs.release.includes('import { portableArchivePath } from "./scripts/lib/mcpb-safety.mjs"') ||
    !inputs.release.includes('echo "build_run_id=$CI_RUN_ID" >> "$GITHUB_OUTPUT"') ||
    !inputs.release.includes('CI_RUN_ID=""') ||
    !inputs.release.includes('PROVENANCE_RUN_ID=""') ||
    !inputs.release.includes('"${PINNED_RUN_ATTEMPT:--}"') ||
    !inputs.release.includes('"$CANDIDATE_RUN_ID" != "$PROVENANCE_RUN_ID"') ||
    !inputs.release.includes("npm run mcpb:verify") ||
    !inputs.release.includes("Existing release provenance does not identify this source/artifact") ||
    !inputs.integrity.includes("mcpb-basic-candidate-${producerAttempt}") ||
    !inputs.release.includes('npm view "@oomkapwn/enquire-mcp@$VERSION" gitHead --json') ||
    (inputs.release.match(/npm-state "\$SOURCE_SHA" "\$VERSION" "\$CHANNEL"/g) ?? []).length !== 3 ||
    !inputs.release.includes("authoritative not-found response") ||
    !inputs.release.includes("npm did not expose the exact published gitHead after 12 checks") ||
    !inputs.release.includes("npm dist-tag $CHANNEL does not resolve to expected $EXPECTED_CHANNEL_VERSION") ||
    !inputs.release.includes("Existing release $TAG has incompatible tag, channel, or draft identity") ||
    (inputs.release.match(/releases\?per_page=100/g) ?? []).length < 4 ||
    !inputs.release.includes("assets?per_page=100") ||
    inputs.release.includes("/releases/tags/") ||
    inputs.release.includes("gh release download") ||
    !inputs.release.includes("Existing release asset $NAME differs before npm publication") ||
    !inputs.release.includes('git ls-remote --tags origin "refs/tags/$TAG" "refs/tags/$TAG^{}"') ||
    (inputs.release.match(/assert_remote_tag_identity\(\) \{/g) ?? []).length !== 3 ||
    (inputs.release.match(/^\s+assert_remote_tag_identity$/gmu) ?? []).length !== 6 ||
    (inputs.release.match(/"\$RAW_TAG_COUNT" -ne 1/g) ?? []).length !== 3 ||
    (inputs.release.match(/"\$PEELED_TAG_COUNT" -ne 1/g) ?? []).length !== 3 ||
    (inputs.release.match(/"\$PEELED_TAG_SHA" != "\$SOURCE_SHA"/g) ?? []).length !== 3 ||
    inputs.release.includes("target_commitish") ||
    inputs.release.includes("--target") ||
    !inputs.release.includes("--verify-tag") ||
    !inputs.release.includes("--draft") ||
    !inputs.release.includes("Published release $TAG is partial") ||
    !inputs.release.includes("Final release contains unexpected asset") ||
    !inputs.release.includes("Final release does not contain exactly one $NAME") ||
    !inputs.release.includes('gh api --method PATCH "repos/${{ github.repository }}/releases/$RELEASE_ID"') ||
    !inputs.release.includes("group: release-publication") ||
    !inputs.release.includes("cancel-in-progress: false") ||
    !inputs.release.includes('CURRENT_UPLOAD_URL=$(printf \'%s\' "$CURRENT_RELEASE" | jq -r \'.upload_url\')') ||
    !inputs.release.includes("https://uploads.github.com/repos/${{ github.repository }}/releases/$RELEASE_ID/assets") ||
    !inputs.release.includes('ENCODED_NAME=$(printf \'%s\' "$NAME" | jq -sRr @uri)') ||
    !inputs.release.includes(uploadPost) ||
    !inputs.release.includes('--data-binary "@$LOCAL_ASSET" "$UPLOAD_BASE?name=$ENCODED_NAME"') ||
    inputs.release.includes("--hostname uploads.github.com") ||
    !freshUploadOrderIsSafe ||
    !inputs.release.includes(publicationTagProof) ||
    !inputs.release.includes(finalPostconditionTagProof) ||
    !inputs.release.includes('PUBLISH_RELEASE=$(gh api "repos/${{ github.repository }}/releases/$RELEASE_ID")') ||
    (inputs.release.match(/node scripts\/check-release-integrity\.mjs channel-advance/g) ?? []).length !== 2 ||
    inputs.release.lastIndexOf("node scripts/check-release-integrity.mjs channel-advance") >
      inputs.release.indexOf("npm publish --provenance") ||
    !inputs.release.includes("assert_stable_github_advance") ||
    !inputs.release.includes("is not GitHub's latest release before npm publication") ||
    !inputs.release.includes('CURRENT_CHANNEL_VERSION="-"') ||
    !inputs.release.includes('npm view "@oomkapwn/enquire-mcp" dist-tags --json') ||
    !inputs.release.includes('"$VERSION" "$CURRENT_CHANNEL_VERSION" "$CHANNEL"') ||
    !inputs.release.includes('NPM_ACTION" = "reuse_superseded"') ||
    !inputs.release.includes('EXPECTED_CHANNEL_VERSION="$PUBLISHED_CHANNEL_VERSION"') ||
    !inputs.release.includes('EXPECTED_POST_ACTION="reuse_superseded"') ||
    !inputs.release.includes('"$CONFIRMED_CHANNEL_VERSION" != "$EXPECTED_CHANNEL_VERSION"') ||
    !inputs.release.includes('"$NPM_POST_ACTION" != "$EXPECTED_POST_ACTION"') ||
    !inputs.release.includes(
      '            fi\n            node scripts/check-release-integrity.mjs channel-advance \\\n'
    ) ||
    (inputs.release.match(/cmp -s "\$LOCAL_ASSET"/g) ?? []).length !== 3 ||
    (inputs.release.includes("gh release upload") && inputs.release.includes("--clobber")) ||
    !inputs.release.includes("SOURCE_SHA=$(git rev-parse HEAD)") ||
    !inputs.release.includes("source_sha: process.env.SOURCE_SHA") ||
    !inputs.release.includes("build_workflow_run:") ||
    !inputs.release.includes("process.env.BUILD_CI_RUN_ID") ||
    inputs.release.includes("release_workflow_run:") ||
    !inputs.release.includes("release: `${process.env.GITHUB_SERVER_URL}") ||
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

describe("release identity and exact required-check gate", () => {
  it("accepts only the tag derived from package.json version", () => {
    expect(assertReleaseTagMatchesVersion("v3.12.0-rc.10", "3.12.0-rc.10")).toBe("v3.12.0-rc.10");
  });

  it("rejects a different or missing trigger tag (NEGATIVE control)", () => {
    expect(() => assertReleaseTagMatchesVersion("v3.12.0-rc.9", "3.12.0-rc.10")).toThrow(
      /does not match package version/
    );
    expect(() => assertReleaseTagMatchesVersion("", "3.12.0-rc.10")).toThrow(/tag is missing/);
  });

  it("requires one successful run for every exact context", () => {
    expect(evaluateReleaseChecks(allSuccessful())).toEqual({
      state: "ready",
      succeeded: REQUIRED_RELEASE_CHECKS,
      missing: [],
      pending: [],
      failed: []
    });
  });

  it("does not let a duplicate run hide a missing context (NEGATIVE control)", () => {
    const checks = allSuccessful().filter((item) => item.name !== "oia");
    checks.push(run("lint", 20), run("lint", 21), run("lint-extra", 22));
    const result = evaluateReleaseChecks(checks);
    expect(result.state).toBe("pending");
    expect(result.succeeded).toHaveLength(REQUIRED_RELEASE_CHECKS.length - 1);
    expect(result.missing).toEqual(["oia"]);
  });

  it("uses the latest rerun for each context", () => {
    const recovered = [...allSuccessful(), run("audit", 30, "failure"), run("audit", 31, "success")];
    expect(evaluateReleaseChecks(recovered).state).toBe("ready");

    const regressed = [...allSuccessful(), run("coverage", 40, "success"), run("coverage", 41, "failure")];
    expect(evaluateReleaseChecks(regressed)).toMatchObject({
      state: "failed",
      failed: [{ name: "coverage", conclusion: "failure" }]
    });
  });

  it("distinguishes in-progress from completed non-success checks", () => {
    const pending = [...allSuccessful(), run("docs", 50, null, "in_progress")];
    expect(evaluateReleaseChecks(pending)).toMatchObject({ state: "pending", pending: ["docs"] });

    const skipped = [...allSuccessful(), run("smoke", 51, "skipped")];
    expect(evaluateReleaseChecks(skipped)).toMatchObject({
      state: "failed",
      failed: [{ name: "smoke", conclusion: "skipped" }]
    });
  });

  it("keeps release.yml wired to the shared evaluator and an exact mirrored inventory", () => {
    const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
    expect(workflow).toContain('node scripts/check-release-integrity.mjs assert-tag "$TAG" "$VERSION"');
    expect(workflow).toContain("node scripts/check-release-integrity.mjs checks");
    expect(workflow).toMatch(/RELEASE_TAG:\s*\$\{\{\s*github\.event\.inputs\.tag \|\| github\.ref_name\s*\}\}/);
    expect(workflow).not.toMatch(/TAG="\$\{\{/);
    const mirror = /REQUIRED="([^"]+)"/.exec(workflow)?.[1];
    expect(mirror, "release.yml must retain the public gate-count mirror").toBeTruthy();
    expect((mirror ?? "").split("|").map((name) => name.replaceAll("\\(", "(").replaceAll("\\)", ")"))).toEqual(
      REQUIRED_RELEASE_CHECKS
    );

    const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
    const packageConsumer = readFileSync(new URL("../scripts/package-consumer.mjs", import.meta.url), "utf8");
    const protocolConformance = readFileSync(new URL("../scripts/protocol-conformance.mjs", import.meta.url), "utf8");
    const packageJson = readFileSync(new URL("../package.json", import.meta.url), "utf8");
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
      versionCheck: readFileSync(new URL("../scripts/check-version-consistency.mjs", import.meta.url), "utf8"),
      versionSync: readFileSync(new URL("../scripts/sync-version.mjs", import.meta.url), "utf8")
    };
    const pkg = JSON.parse(packageJson) as {
      engines?: { node?: unknown };
    };
    expect(nodeFloorCiProblems(ci, pkg.engines?.node)).toEqual([]);
    expect(remoteGateScriptProblems(packageConsumer, protocolConformance)).toEqual([]);
    expect(releasePollProblems(workflow)).toEqual([]);
    expect(mcpbContractProblems(mcpbInputs)).toEqual([]);

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

    expect(evaluateNpmPublication({ exists: false }, "source", "4.0.0-rc.2", "rc")).toEqual({
      action: "publish"
    });
    expect(
      evaluateNpmPublication(
        { exists: true, gitHead: "source", channelVersion: "4.0.0-rc.2" },
        "source",
        "4.0.0-rc.2",
        "rc"
      )
    ).toEqual({ action: "reuse" });
    expect(() =>
      evaluateNpmPublication(
        { exists: true, gitHead: "other", channelVersion: "4.0.0-rc.2" },
        "source",
        "4.0.0-rc.2",
        "rc"
      )
    ).toThrow(/gitHead/);
    expect(() =>
      evaluateNpmPublication(
        { exists: true, gitHead: "source", channelVersion: "4.0.0-rc.1" },
        "source",
        "4.0.0-rc.2",
        "rc"
      )
    ).toThrow(/roll rc back/);
    expect(
      evaluateNpmPublication(
        { exists: true, gitHead: "source", channelVersion: "4.0.0-rc.3" },
        "source",
        "4.0.0-rc.2",
        "rc"
      )
    ).toEqual({ action: "reuse_superseded", channelVersion: "4.0.0-rc.3" });
    expect(() =>
      evaluateNpmPublication(
        { exists: true, gitHead: "source", channelVersion: "4.0.1" },
        "source",
        "4.0.0",
        "latest"
      )
    ).toThrow(/dist-tag/);
    expect(() =>
      evaluateNpmPublication(
        { exists: true, gitHead: "source", channelVersion: "4.0.0-beta.9" },
        "source",
        "4.0.0-rc.2",
        "rc"
      )
    ).toThrow(/resolves to beta/);
    expect(() =>
      evaluateNpmPublication(
        { exists: true, gitHead: "source", channelVersion: "4.0.0-rc.2" },
        "source",
        "4.0.0-rc.2",
        undefined
      )
    ).toThrow(/not npm channel/);
    expect(() =>
      evaluateNpmPublication(
        { exists: true, gitHead: "source", channelVersion: "4.0.0-rc.2" },
        "source",
        "4.0.0-rc.2",
        "beta"
      )
    ).toThrow(/not npm channel beta/);

    const releaseExpected = {
      tag: "v4.0.0-rc.2",
      prerelease: true,
      assetNames: ["a", "b"]
    };
    const draftRelease = {
      tag_name: releaseExpected.tag,
      target_commitish: "main",
      prerelease: releaseExpected.prerelease,
      draft: true
    };
    expect(evaluateMcpbReleaseState({ release: null, assets: [] }, releaseExpected)).toEqual({
      action: "create_draft",
      missing: ["a", "b"]
    });
    expect(evaluateMcpbReleaseState({ release: draftRelease, assets: [{ name: "a" }] }, releaseExpected)).toEqual({
      action: "resume_draft",
      missing: ["b"]
    });
    expect(
      evaluateMcpbReleaseState({ release: draftRelease, assets: [{ name: "a" }, { name: "b" }] }, releaseExpected)
    ).toEqual({ action: "publish_draft", missing: [] });
    expect(
      evaluateMcpbReleaseState(
        { release: { ...draftRelease, draft: false, immutable: true }, assets: [{ name: "a" }, { name: "b" }] },
        releaseExpected
      )
    ).toEqual({ action: "reuse_published", missing: [] });
    expect(() =>
      evaluateMcpbReleaseState(
        { release: { ...draftRelease, draft: false, immutable: true }, assets: [{ name: "a" }] },
        releaseExpected
      )
    ).toThrow(/partial/);
    expect(() =>
      evaluateMcpbReleaseState({ release: { ...draftRelease, tag_name: "v4.0.0-rc.1" }, assets: [] }, releaseExpected)
    ).toThrow(/identity diverged/);
    expect(() =>
      evaluateMcpbReleaseState({ release: draftRelease, assets: [{ name: "unexpected" }] }, releaseExpected)
    ).toThrow(/unexpected/);
    expect(() =>
      evaluateMcpbReleaseState({ release: draftRelease, assets: [{ name: "a" }, { name: "a" }] }, releaseExpected)
    ).toThrow(/duplicate/);

    expect(
      candidateRunIds(
        [
          { id: 20, head_sha: "source", head_branch: "main", event: "push" },
          { id: 10, head_sha: "source", head_branch: "main", event: "push" },
          { id: 5, head_sha: "other", head_branch: "main", event: "push" },
          { id: 6, head_sha: "source", head_branch: "topic", event: "push" },
          { id: 7, head_sha: "source", head_branch: "main", event: "workflow_dispatch" }
        ],
        "source"
      )
    ).toEqual(["10", "20"]);
    expect(() =>
      candidateRunIds([{ id: "not-a-run", head_sha: "source", head_branch: "main", event: "push" }], "source")
    ).toThrow(/invalid positive decimal id/);
    expect(() =>
      candidateRunIds(
        [
          { id: 10, head_sha: "source", head_branch: "main", event: "push" },
          { id: "10", head_sha: "source", head_branch: "main", event: "push" }
        ],
        "source"
      )
    ).toThrow(/duplicate candidate workflow run id/);
    const digest = `sha256:${"a".repeat(64)}`;
    const candidate = {
      jobs: [
        { name: "unrelated", run_attempt: 99, status: "completed", conclusion: "success" },
        { name: "mcpb-basic-package", run_attempt: 1, status: "completed", conclusion: "success" },
        { name: "mcpb-basic", run_attempt: 2, status: "completed", conclusion: "success" }
      ],
      artifacts: [{ name: "mcpb-basic-candidate-1", expired: false, id: 42, digest }]
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
        jobs: [
          ...candidate.jobs,
          { name: "mcpb-basic", run_attempt: 3, status: "completed", conclusion: "failure" }
        ]
      })
    ).toEqual({ state: "skip" });
    expect(
      evaluateMcpbCandidateRun({
        ...candidate,
        jobs: [
          { name: "mcpb-basic-package", run_attempt: 2, status: "completed", conclusion: "success" },
          { name: "mcpb-basic", run_attempt: 1, status: "completed", conclusion: "success" }
        ],
        artifacts: [{ name: "mcpb-basic-candidate-2", expired: false, id: 42, digest }]
      })
    ).toEqual({ state: "skip" });
    expect(() =>
      evaluateMcpbCandidateRun({
        ...candidate,
        jobs: [...candidate.jobs, candidate.jobs[2]]
      })
    ).toThrow(/duplicate latest-attempt/);
    expect(() =>
      evaluateMcpbCandidateRun({
        ...candidate,
        jobs: [...candidate.jobs, candidate.jobs[1]]
      })
    ).toThrow(/duplicate latest-attempt mcpb-basic-package/);
    expect(() =>
      evaluateMcpbCandidateRun({
        ...candidate,
        artifacts: [...candidate.artifacts, { ...candidate.artifacts[0], id: 43 }]
      })
    ).toThrow(/duplicate live/);
    expect(() => evaluateMcpbCandidateRun({ ...candidate, pinnedArtifactId: "43" })).toThrow(/artifact id/);
    expect(() => evaluateMcpbCandidateRun({ ...candidate, pinnedRunAttempt: "2" })).toThrow(/producer attempt/);
    expect(() => evaluateMcpbCandidateRun({ ...candidate, pinnedDigest: `sha256:${"b".repeat(64)}` })).toThrow(
      /artifact digest/
    );
    expect(() =>
      evaluateMcpbCandidateRun({ ...candidate, artifacts: [{ ...candidate.artifacts[0], digest: "sha256:no" }] })
    ).toThrow(/lacks an exact id or SHA-256 digest/);
    expect(
      evaluateMcpbCandidateRun({ ...candidate, artifacts: [{ ...candidate.artifacts[0], expired: true }] })
    ).toEqual({ state: "skip" });

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
      resolveRequiredDependencyRefs(
        { name: "root", version: "1.0.0", dependencies: { missing: "1.0.0" } },
        () => null
      )
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
        packageConsumer.replace("Object.keys(rootPackage.optionalDependencies ?? {})", '["better-sqlite3"]'),
        protocolConformance
      )
    ).toContain("package-consumer omit lane must derive the complete optional dependency inventory");
    expect(
      remoteGateScriptProblems(
        packageConsumer,
        protocolConformance.replace("server was not live after traversal refusal", "traversal refusal finished")
      )
    ).toContain("protocol-conformance traversal negative must distinguish refusal from crash and prove liveness");
    expect(
      remoteGateScriptProblems(
        packageConsumer,
        protocolConformance.replace(
          'inventory.resources.includes("obsidian://note/01_Projects/Hermes.md")',
          'inventory.resources.includes("obsidian://note/01_Projects%2FHermes.md")'
        )
      )
    ).toContain("protocol-conformance must pin slash-preserving note resource URIs on every host");
    expect(releasePollProblems(workflow.replace("timeout-minutes: 90", "timeout-minutes: 15"))).toContain(
      "release polling must outlive the blocking package-consumer matrix and leave publication headroom"
    );
    expect(releasePollProblems(workflow.replace("  actions: read", "  actions: none"))).toContain(
      "release must grant read-only Actions API access for the exact-SHA MCPB artifact"
    );
    expect(
      mcpbContractProblems({
        ...mcpbInputs,
        manifest: mcpbInputs.manifest.replace('"name": "obsidian_stats"', '"name": "obsidian_create_note"')
      })
    ).toContain("MCPB Basic must expose exactly 13 approved read-only tools and zero prompts");
    expect(
      mcpbContractProblems({
        ...mcpbInputs,
        manifest: mcpbInputs.manifest.replace('"--no-prompts",', '"--watch",')
      })
    ).toContain("MCPB launch args must be the exact fail-closed Basic allowlist");
    expect(
      mcpbContractProblems({
        ...mcpbInputs,
        build: mcpbInputs.build.replace('"--omit=optional"', '"--include=optional"')
      })
    ).toContain(
      "MCPB builder must pin upstream, omit unsafe feature deps, two-pass inventory official bytes, ship transparency records, and guard owned cleanup"
    );
    expect(
      mcpbContractProblems({
        ...mcpbInputs,
        versionSync: mcpbInputs.versionSync.replace("mcpbManifest.version = version", "void version")
      })
    ).toContain("version lifecycle must synchronize and stage all eight published version surfaces");
    expect(
      mcpbContractProblems({
        ...mcpbInputs,
        build: mcpbInputs.build.replace("non-portable archive path", "unchecked archive path")
      })
    ).toContain(
      "MCPB builder must pin upstream, omit unsafe feature deps, two-pass inventory official bytes, ship transparency records, and guard owned cleanup"
    );
    expect(
      mcpbContractProblems({
        ...mcpbInputs,
        consumer: mcpbInputs.consumer.replace("ownership token changed", "scratch cleanup continued")
      })
    ).toContain(
      "MCPB consumer must prove exact inventory, transparency records, resources, omitted deps, negatives, and post-refusal liveness"
    );
    expect(
      mcpbContractProblems({
        ...mcpbInputs,
        consumer: mcpbInputs.consumer.replace('type: "directory"', 'type: "entry"')
      })
    ).toContain(
      "MCPB consumer must prove exact inventory, transparency records, resources, omitted deps, negatives, and post-refusal liveness"
    );
    expect(
      mcpbContractProblems({
        ...mcpbInputs,
        release: mcpbInputs.release.replace('cmp -s "$LOCAL_ASSET" "$REMOTE_ASSET"', "true")
      })
    ).toContain(
      "release must reuse exact CI-gated MCPB bytes, re-verify them, and attach transparency records with checkout provenance"
    );
    expect(
      mcpbContractProblems({
        ...mcpbInputs,
        release: mcpbInputs.release.replace(
          "Preflight existing GitHub release and every Basic asset before npm",
          "Preflight removed"
        )
      })
    ).toContain("release state machine must preflight all deterministic assets before npm, then draft/upload/publish");
    const reorderedRelease = mcpbInputs.release
      .replace("Prepare deterministic Basic release records", "__MCPB_RELEASE_ORDER_SENTINEL__")
      .replace(
        "Publish with provenance or verify an exact prior publication",
        "Prepare deterministic Basic release records"
      )
      .replace("__MCPB_RELEASE_ORDER_SENTINEL__", "Publish with provenance or verify an exact prior publication");
    expect(mcpbContractProblems({ ...mcpbInputs, release: reorderedRelease })).toContain(
      "release state machine must preflight all deterministic assets before npm, then draft/upload/publish"
    );
    expect(
      mcpbContractProblems({
        ...mcpbInputs,
        integrity: mcpbInputs.integrity.replace(
          "mcpb-basic-candidate-${producerAttempt}",
          "mcpb-basic-candidate-unbound"
        )
      })
    ).toContain(
      "release must reuse exact CI-gated MCPB bytes, re-verify them, and attach transparency records with checkout provenance"
    );
    for (const pagination of ["CHECK_PAGES", "RUN_PAGES", "JOB_PAGES", "ARTIFACT_PAGES"]) {
      expect(
        mcpbContractProblems({
          ...mcpbInputs,
          release: mcpbInputs.release.replace(`${pagination}=$(gh api --paginate --slurp`, `${pagination}=$(gh api`)
        })
      ).toContain(
        "release must reuse exact CI-gated MCPB bytes, re-verify them, and attach transparency records with checkout provenance"
      );
    }
    expect(
      mcpbContractProblems({
        ...mcpbInputs,
        release: mcpbInputs.release.replace("https://uploads.github.com/repos/", "https://api.uploads.github.com/repos/")
      })
    ).toContain(
      "release must reuse exact CI-gated MCPB bytes, re-verify them, and attach transparency records with checkout provenance"
    );
    expect(
      mcpbContractProblems({
        ...mcpbInputs,
        release: mcpbInputs.release.replace("group: release-publication", "group: release-$TAG")
      })
    ).toContain(
      "release must reuse exact CI-gated MCPB bytes, re-verify them, and attach transparency records with checkout provenance"
    );
    expect(
      mcpbContractProblems({
        ...mcpbInputs,
        release: mcpbInputs.release.replace("checks: read", "checks: none")
      })
    ).toContain(
      "release must reuse exact CI-gated MCPB bytes, re-verify them, and attach transparency records with checkout provenance"
    );
    expect(
      mcpbContractProblems({
        ...mcpbInputs,
        release: mcpbInputs.release.replace(
          'npm-state "$SOURCE_SHA" "$VERSION" "$CHANNEL"',
          'npm-state "$PUBLISHED_SHA" "$VERSION" "$CHANNEL"'
        )
      })
    ).toContain(
      "release must reuse exact CI-gated MCPB bytes, re-verify them, and attach transparency records with checkout provenance"
    );
    const freshUploadClassifier =
      'CURRENT_ACTION=$(printf \'%s\' "$CURRENT_STATE" | release_state | jq -r \'.action\')';
    const classifierAfterUpload = mcpbInputs.release
      .replace(freshUploadClassifier, 'CURRENT_ACTION="resume_draft"')
      .replace(
        "curl --fail-with-body --silent --show-error --request POST",
        `curl --fail-with-body --silent --show-error --request POST\n              ${freshUploadClassifier}`
      );
    expect(mcpbContractProblems({ ...mcpbInputs, release: classifierAfterUpload })).toContain(
      "release must reuse exact CI-gated MCPB bytes, re-verify them, and attach transparency records with checkout provenance"
    );
    const uploadTagProof =
      "              assert_remote_tag_identity\n              curl --fail-with-body --silent --show-error --request POST";
    const relocatedUploadTagProof = mcpbInputs.release
      .replace(uploadTagProof, "              curl --fail-with-body --silent --show-error --request POST")
      .replace(
        '                --data-binary "@$LOCAL_ASSET" "$UPLOAD_BASE?name=$ENCODED_NAME" >/dev/null',
        '                --data-binary "@$LOCAL_ASSET" "$UPLOAD_BASE?name=$ENCODED_NAME" >/dev/null\n' +
          "              assert_remote_tag_identity"
      );
    expect(mcpbContractProblems({ ...mcpbInputs, release: relocatedUploadTagProof })).toContain(
      "release must reuse exact CI-gated MCPB bytes, re-verify them, and attach transparency records with checkout provenance"
    );
    expect(
      mcpbContractProblems({
        ...mcpbInputs,
        release: mcpbInputs.release.replace(
          '          assert_remote_tag_identity\n          if [ "$FINAL_ACTION" = "publish_draft" ]; then',
          '          if [ "$FINAL_ACTION" = "publish_draft" ]; then'
        )
      })
    ).toContain(
      "release must reuse exact CI-gated MCPB bytes, re-verify them, and attach transparency records with checkout provenance"
    );
    const lateChannelGuard = mcpbInputs.release
      .replace("node scripts/check-release-integrity.mjs channel-advance", "node scripts/check-release-integrity.mjs channel_disabled")
      .replace(
        'npm publish --provenance --access public --tag "$CHANNEL"',
        'npm publish --provenance --access public --tag "$CHANNEL"\n' +
          '              node scripts/check-release-integrity.mjs channel-advance "$VERSION" "-" latest'
      );
    expect(mcpbContractProblems({ ...mcpbInputs, release: lateChannelGuard })).toContain(
      "release must reuse exact CI-gated MCPB bytes, re-verify them, and attach transparency records with checkout provenance"
    );
    const latestOnlyChannelGuard = mcpbInputs.release.replace(
      '            fi\n            node scripts/check-release-integrity.mjs channel-advance \\\n',
      '            fi\n            if [ "${{ steps.dist_tag.outputs.tag }}" = "latest" ]; then\n' +
        '              node scripts/check-release-integrity.mjs channel-advance \\\n' +
        '                "$VERSION" "$CURRENT_CHANNEL_VERSION" "$CHANNEL"\n' +
        "            fi\n"
    );
    expect(mcpbContractProblems({ ...mcpbInputs, release: latestOnlyChannelGuard })).toContain(
      "release must reuse exact CI-gated MCPB bytes, re-verify them, and attach transparency records with checkout provenance"
    );
    expect(
      mcpbContractProblems({
        ...mcpbInputs,
        release: mcpbInputs.release.replace(
          'NPM_ACTION" = "reuse_superseded"',
          'NPM_ACTION" = "reuse"'
        )
      })
    ).toContain(
      "release must reuse exact CI-gated MCPB bytes, re-verify them, and attach transparency records with checkout provenance"
    );
    expect(
      mcpbContractProblems({
        ...mcpbInputs,
        release: mcpbInputs.release.replace(
          "is not GitHub's latest release before npm publication",
          "latest release checked after npm"
        )
      })
    ).toContain(
      "release must reuse exact CI-gated MCPB bytes, re-verify them, and attach transparency records with checkout provenance"
    );
    for (const [guard, weakenedGuard] of [
      ['[ "$RAW_TAG_COUNT" -ne 1 ]', '[ "$RAW_TAG_COUNT" -lt 0 ]'],
      ['[ "$PEELED_TAG_COUNT" -ne 1 ]', '[ "$PEELED_TAG_COUNT" -lt 0 ]'],
      ['[ "$PEELED_TAG_SHA" != "$SOURCE_SHA" ]', '[ "$PEELED_TAG_SHA" = "$SOURCE_SHA" ]']
    ] as const) {
      expect(
        mcpbContractProblems({
          ...mcpbInputs,
          release: mcpbInputs.release.replaceAll(guard, weakenedGuard)
        })
      ).toContain(
        "release must reuse exact CI-gated MCPB bytes, re-verify them, and attach transparency records with checkout provenance"
      );
    }
    expect(
      mcpbContractProblems({
        ...mcpbInputs,
        release: mcpbInputs.release.replace(
          '"repos/${{ github.repository }}/releases?per_page=100"',
          '"repos/${{ github.repository }}/releases/tags/$TAG"'
        )
      })
    ).toContain(
      "release must reuse exact CI-gated MCPB bytes, re-verify them, and attach transparency records with checkout provenance"
    );
    expect(
      mcpbContractProblems({
        ...mcpbInputs,
        release: mcpbInputs.release.replace(
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
        release: mcpbInputs.release.replace("Final release contains unexpected asset", "Final asset accepted")
      })
    ).toContain(
      "release must reuse exact CI-gated MCPB bytes, re-verify them, and attach transparency records with checkout provenance"
    );
    expect(
      mcpbContractProblems({
        ...mcpbInputs,
        packageJson: mcpbInputs.packageJson.replace('"tmp": "0.2.6"', '"tmp": "0.0.33"')
      })
    ).toContain("MCPB dev graph must override tmp to patched 0.2.6 without the orphaned legacy helper");
    expect(
      mcpbContractProblems({
        ...mcpbInputs,
        docsApi: mcpbInputs.docsApi.replace("| `--no-prompts`", "| `--prompts-hidden`")
      })
    ).toContain("Basic isolation flags must be shared by stdio/HTTP, documented, and preserve full defaults");
    expect(
      mcpbContractProblems({
        ...mcpbInputs,
        consumer: mcpbInputs.consumer.replace('["2.0.11"]', '["1.19.9"]')
      })
    ).toContain(
      "MCPB consumer must prove exact inventory, transparency records, resources, omitted deps, negatives, and post-refusal liveness"
    );
    expect(
      mcpbContractProblems({
        ...mcpbInputs,
        server: mcpbInputs.server.replace("const embeddingIndexEnabled = opts.embeddingIndex !== false", "true")
      })
    ).toContain("Basic isolation flags must be shared by stdio/HTTP, documented, and preserve full defaults");
    expect(
      mcpbContractProblems({
        ...mcpbInputs,
        build: mcpbInputs.build.replace('path.join(STAGE, "sbom.cdx.json")', 'path.join(STAGE, "sbom-disabled.json")')
      })
    ).toContain(
      "MCPB builder must pin upstream, omit unsafe feature deps, two-pass inventory official bytes, ship transparency records, and guard owned cleanup"
    );

    // NEGATIVE controls: the invariant rejects both the old floating-22 leg
    // and a floor that no longer matches package.json.
    expect(nodeFloorCiProblems(ci.replace('node-version: "22.13.0"', "node-version: 22"), pkg.engines?.node)).toContain(
      "test (22) must run exact engines.node floor 22.13.0"
    );
    expect(nodeFloorCiProblems(ci, ">=22.14.0")).toContain("test (22) must run exact engines.node floor 22.14.0");
    expect(nodeFloorCiProblems(ci, "22.13.0")).toEqual(["engines.node must be one exact >=X.Y.Z floor"]);
    expect(
      nodeFloorCiProblems(
        ci.replace('      NPM_CONFIG_ENGINE_STRICT: "true"', '      NPM_CONFIG_ENGINE_STRICT: "false"'),
        pkg.engines?.node
      )
    ).toContain("test job must enforce npm engine-strict");
    expect(nodeFloorCiProblems(ci.replace("if (declared !== expected)", "if (false)"), pkg.engines?.node)).toContain(
      "test floor runtime assertion is missing"
    );
    expect(
      nodeFloorCiProblems(
        ci.replace(
          "- name: Probe native SQLite and FTS5 at declared floor\n        if: matrix.floor",
          "- name: Probe native SQLite and FTS5 at declared floor\n        if: false"
        ),
        pkg.engines?.node
      )
    ).toContain("test floor native SQLite/FTS probe is missing");
    expect(
      nodeFloorCiProblems(
        ci.replace("      - run: npm test\n        env:", "      - run: echo npm test\n        env:"),
        pkg.engines?.node
      )
    ).toContain("test floor job missing npm test");
    expect(
      nodeFloorCiProblems(
        ci.replace(
          "    timeout-minutes: 10\n    env:",
          "    timeout-minutes: 10\n    continue-on-error: true\n    env:"
        ),
        pkg.engines?.node
      )
    ).toContain("test job must not declare continue-on-error");
    expect(
      nodeFloorCiProblems(
        ci.replace(/(\n {2}smoke:[\s\S]*?node-version:) "22\.13\.0"/, (_match, prefix: string) => `${prefix} 22`),
        pkg.engines?.node
      )
    ).toContain("smoke must run exact engines.node floor 22.13.0");
    expect(
      nodeFloorCiProblems(
        ci.replace(
          /(\n {2}test-windows:[\s\S]*?runs-on:) windows-2025/,
          (_match, prefix: string) => `${prefix} ubuntu-latest`
        ),
        pkg.engines?.node
      )
    ).toContain("test-windows must preserve its exact name and pinned windows-2025 runner");
    expect(
      nodeFloorCiProblems(
        ci.replace(
          /(\n {2}test-windows:[\s\S]*?node-version:) "22\.13\.0"/,
          (_match, prefix: string) => `${prefix} 22`
        ),
        pkg.engines?.node
      )
    ).toContain("test-windows must run exact engines.node floor 22.13.0");
    expect(
      nodeFloorCiProblems(
        ci.replace("      NPM_CONFIG_SCRIPT_SHELL: 'C:\\Program Files\\Git\\bin\\bash.exe'\n", ""),
        pkg.engines?.node
      )
    ).toContain("test-windows must run npm lifecycle scripts through pinned Git Bash");
    expect(nodeFloorCiProblems(ci.replace('"caseprobe.md"', '"CaseProbe.md"'), pkg.engines?.node)).toContain(
      "test-windows platform and case-insensitive filesystem assertion is missing"
    );
    expect(
      nodeFloorCiProblems(
        ci.replace(
          "      - name: Probe native SQLite and FTS5 on Windows\n",
          "      - name: Probe native SQLite and FTS5 on Windows\n        if: false\n"
        ),
        pkg.engines?.node
      )
    ).toContain("test-windows steps must be unconditional and must not declare continue-on-error");
    expect(
      nodeFloorCiProblems(
        ci.replace(
          '              throw new Error("Windows filesystem probe is not case-insensitive");',
          "              return;"
        ),
        pkg.engines?.node
      )
    ).toContain("test-windows platform and case-insensitive filesystem assertion is missing");
    expect(
      nodeFloorCiProblems(
        ci.replace('if (row?.body !== "windows probe")', 'if (row?.body === "windows probe")'),
        pkg.engines?.node
      )
    ).toContain("test-windows native SQLite/FTS probe is missing");
    expect(
      nodeFloorCiProblems(
        ci.replace(
          "      - run: npm test -- tests/windows-path-safety.test.ts",
          "      - run: echo npm test -- tests/windows-path-safety.test.ts"
        ),
        pkg.engines?.node
      )
    ).toContain("test-windows missing the executable hostile-filesystem suite");
    expect(
      nodeFloorCiProblems(
        ci.replace(
          "        run: npm test -- tests/watcher-activation-guard.test.ts",
          "        run: echo npm test -- tests/watcher-activation-guard.test.ts"
        ),
        pkg.engines?.node
      )
    ).toContain("test-windows missing the exact watcher activation-guard suite");
    expect(
      nodeFloorCiProblems(
        ci.replace("        run: npm run render:preview", "        run: echo npm run render:preview"),
        pkg.engines?.node
      )
    ).toContain("docs job must regenerate and fail closed on social-preview byte drift");
    expect(
      nodeFloorCiProblems(
        ci.replace("  docs:\n    runs-on: ubuntu-latest", "  docs:\n    if: false\n    runs-on: ubuntu-latest"),
        pkg.engines?.node
      )
    ).toContain("docs job must regenerate and fail closed on social-preview byte drift");
    expect(
      nodeFloorCiProblems(
        ci
          .replace("      - id: preview_render\n        run: npm run render:preview\n", "")
          .replace(
            "        run: git diff --exit-code -- assets/social-preview.png\n",
            "        run: git diff --exit-code -- assets/social-preview.png\n" +
              "      - id: preview_render\n" +
              "        run: npm run render:preview\n"
          ),
        pkg.engines?.node
      )
    ).toContain("docs job must regenerate and fail closed on social-preview byte drift");
    expect(
      nodeFloorCiProblems(
        ci.replace(
          "      - name: Require committed social-preview bytes\n",
          "      - name: Require committed social-preview bytes\n        if: false\n"
        ),
        pkg.engines?.node
      )
    ).toContain("docs job must regenerate and fail closed on social-preview byte drift");
    expect(
      nodeFloorCiProblems(
        ci.replace(/ {6}- name: Export remotely rendered social preview\n[\s\S]*? {10}compression-level: 0\n/, ""),
        pkg.engines?.node
      )
    ).toContain("docs job must export the remotely rendered social preview before byte-drift enforcement");
    expect(
      nodeFloorCiProblems(
        ci.replace("          path: assets/social-preview.png", "          path: assets/stale-preview.png"),
        pkg.engines?.node
      )
    ).toContain("docs job must export the remotely rendered social preview before byte-drift enforcement");
    expect(
      nodeFloorCiProblems(
        ci.replace(
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
    expect(
      nodeFloorCiProblems(
        ci
          .replace(/ {6}- name: Export remotely rendered social preview\n[\s\S]*? {10}compression-level: 0\n/, "")
          .replace(
            "        run: git diff --exit-code -- assets/social-preview.png\n",
            "        run: git diff --exit-code -- assets/social-preview.png\n" +
              "      - name: Export remotely rendered social preview\n" +
              "        id: preview_artifact\n" +
              "        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7\n" +
              "        with:\n" +
              "          name: rendered-social-preview\n" +
              "          path: assets/social-preview.png\n" +
              "          if-no-files-found: error\n" +
              "          retention-days: 3\n" +
              "          compression-level: 0\n"
          ),
        pkg.engines?.node
      )
    ).toContain("docs job must export the remotely rendered social preview before byte-drift enforcement");
    expect(
      nodeFloorCiProblems(ci.replace("    needs: [test, test-windows]", "    needs: [test]"), pkg.engines?.node)
    ).toContain("smoke must wait for exactly the Linux matrix and blocking Windows job");
    expect(
      nodeFloorCiProblems(ci.replace(`    if: \${{ always() }}`, "    if: success()"), pkg.engines?.node)
    ).toContain("smoke must run its prerequisite gate even after an upstream failure");
    expect(nodeFloorCiProblems(ci.replace(' ] || [ "', ' ] && [ "'), pkg.engines?.node)).toContain(
      "smoke prerequisite gate must fail closed on either Linux or Windows failure"
    );
    expect(
      nodeFloorCiProblems(
        ci.replace(
          "      - name: Require Linux and Windows test prerequisites\n",
          "      - name: Require Linux and Windows test prerequisites\n        if: false\n"
        ),
        pkg.engines?.node
      )
    ).toContain("smoke prerequisite gate must fail closed on either Linux or Windows failure");
    expect(
      nodeFloorCiProblems(
        ci.replace(
          "      - name: JSON-RPC smoke test (scan path)\n",
          "      - name: JSON-RPC smoke test (scan path)\n        if: false\n"
        ),
        pkg.engines?.node
      )
    ).toContain("smoke functional steps must be unconditional and fail-capable");
    expect(
      nodeFloorCiProblems(
        ci.replace(
          "            exit 1\n          fi\n      - uses: actions/checkout@",
          "            exit 0\n          fi\n      - uses: actions/checkout@"
        ),
        pkg.engines?.node
      )
    ).toContain("smoke prerequisite gate must fail closed on either Linux or Windows failure");
    expect(
      nodeFloorCiProblems(
        ci.replace(
          "          - label: windows\n            os: windows-2025\n            script_shell: 'C:\\Program Files\\Git\\bin\\bash.exe'",
          "          - label: windows\n            os: ubuntu-latest\n            script_shell: /bin/bash"
        ),
        pkg.engines?.node
      )
    ).toContain("protocol-conformance matrix must preserve its exact blocking platform inventory");
    expect(
      nodeFloorCiProblems(
        ci.replace(
          "          - label: macos\n            os: macos-latest",
          "          - label: macos\n            os: ubuntu-latest"
        ),
        pkg.engines?.node
      )
    ).toContain("package-consumer matrix must preserve its exact blocking platform inventory");
    expect(
      nodeFloorCiProblems(ci.replace("    needs: protocol-conformance-matrix", "    needs: test"), pkg.engines?.node)
    ).toContain("protocol-conformance aggregate must fail closed over every matrix lane");
    expect(
      nodeFloorCiProblems(
        ci.replace("npm run schema:inventory -- --write", "echo schema inventory disabled"),
        pkg.engines?.node
      )
    ).toContain("docs job must export and fail closed on remotely captured MCP schema drift");
    expect(
      nodeFloorCiProblems(
        ci.replace("        run: node scripts/package-consumer.mjs", "        run: echo package-consumer-disabled"),
        pkg.engines?.node
      )
    ).toContain("package-consumer matrix must be exact-floor, unconditional, fail-capable, built, and executable");
    expect(
      nodeFloorCiProblems(
        ci.replace(
          "      - name: Verify canonical MCPB content and official-client contract\n        run: npm run mcpb:verify",
          "      - name: Verify canonical MCPB content and official-client contract\n        run: echo mcpb-verification-disabled"
        ),
        pkg.engines?.node
      )
    ).toContain("mcpb-basic matrix must be exact-floor, unconditional, fail-capable, and consume the canonical artifact");
    expect(
      nodeFloorCiProblems(ci.replace("    needs: mcpb-basic-matrix", "    needs: test"), pkg.engines?.node)
    ).toContain("mcpb-basic aggregate must fail closed over every matrix lane");
    expect(
      nodeFloorCiProblems(
        ci.replace(
          "      - name: Export inspectable canonical MCPB candidate and transparency records\n        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7",
          "      - name: Export inspectable canonical MCPB candidate and transparency records\n        uses: actions/upload-artifact@v7"
        ),
        pkg.engines?.node
      )
    ).toContain(
      "mcpb-basic package job must build, verify, and export one fail-closed canonical Linux bundle with inventory, SBOM, and notices"
    );
    expect(
      nodeFloorCiProblems(
        ci.replace(
          "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093 # v4.3.0",
          "actions/download-artifact@v4"
        ),
        pkg.engines?.node
      )
    ).toContain("mcpb-basic matrix must consume the exact pinned canonical Linux artifact on every OS");
    expect(
      nodeFloorCiProblems(ci.replace("          path: artifacts", "          path: ."), pkg.engines?.node)
    ).toContain("mcpb-basic matrix must consume the exact pinned canonical Linux artifact on every OS");
    expect(REQUIRED_RELEASE_CHECKS).not.toContain("test-windows");
  });
});
