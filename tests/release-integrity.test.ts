import { existsSync, readFileSync } from "node:fs";
import { load } from "js-yaml";
import ts from "typescript";
import { describe, expect, it } from "vitest";
// @ts-expect-error — .mjs release script has no declaration file; tests exercise its pure core.
import {
  assertChannelVersionAdvance,
  assertMcpbAssetVersion,
  assertReleaseTagMatchesVersion,
  candidateRunIds,
  evaluateMcpbCandidateRun,
  evaluateMcpbReleaseState,
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

const TRUSTED_SOURCE_SHA = "252c54c0e0d4939c9f7b93470a4a2d7c7a0ac78c";
const RELEASE_JOB_REMAINING = "local remaining=$((RELEASE_JOB_DEADLINE_EPOCH - $(date +%s)))";
const MUTATED_RELEASE_JOB_REMAINING = "local remaining=$((RELEASE_JOB_DEADLINE_EPOCH - RELEASE_JOB_DEADLINE_EPOCH))";
const GH_READ_DEADLINE_GUARD = `${RELEASE_JOB_REMAINING}\n  if [ "$remaining" -le 10 ]; then`;
const NPM_RESERVE_DEADLINE_GUARD = `${RELEASE_JOB_REMAINING}\n  if [ "$remaining" -lt "$required" ]; then`;
const RAW_GH_READ_DEADLINE_GUARD = `            ${RELEASE_JOB_REMAINING}\n            if [ "$remaining" -le 10 ]; then`;
const RAW_NPM_RESERVE_DEADLINE_GUARD = `            ${RELEASE_JOB_REMAINING}\n            if [ "$remaining" -lt "$required" ]; then`;
const MUTATED_RAW_GH_READ_DEADLINE_GUARD = `            ${MUTATED_RELEASE_JOB_REMAINING}\n            if [ "$remaining" -le 10 ]; then`;
const MUTATED_RAW_NPM_RESERVE_DEADLINE_GUARD = `            ${MUTATED_RELEASE_JOB_REMAINING}\n            if [ "$remaining" -lt "$required" ]; then`;
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
  const deadline = namedStep(steps, "Establish global release deadline");
  const gate = namedStep(steps, "Assert tag is on main and required CI checks passed");
  const body = runBody(gate);
  if (
    Number(publish?.["timeout-minutes"] ?? 0) !== 240 ||
    steps[0] !== deadline ||
    runBody(deadline) !== 'echo "RELEASE_JOB_DEADLINE_EPOCH=$(($(date +%s) + 13800))" >> "$GITHUB_ENV"' ||
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
  const globalReadBodies = [
    runBody(namedStep(steps, "Download exact CI-gated Basic MCPB release asset")),
    runBody(namedStep(steps, "Preflight existing GitHub release and every Basic asset before npm")),
    runBody(namedStep(steps, "Prepare draft GitHub Release")),
    runBody(namedStep(steps, "Upload Basic MCPB asset, checksum, and provenance"))
  ];
  const ghReadMutationArgs =
    "graphql|--method|--method=*|-X*|--input|--input=*|-f*|-F*|--field|--field=*|--raw-field|--raw-field=*";
  const rawGhApiLines = workflow
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /(?:^|\$\()gh api(?:\s|$)/u.test(line));
  if (
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
    (workflow.match(/gh_read\(\) \{/g) ?? []).length !== 5 ||
    (workflow.match(/gh_read rejects mutation-capable gh api arguments/g) ?? []).length !== 5 ||
    mutationMatchCount(workflow, ghReadMutationArgs) !== 5 ||
    (workflow.match(/gh_read api/g) ?? []).length !== 30 ||
    workflow.includes("gh() {") ||
    workflow.includes("gh_read api --method") ||
    rawGhApiLines.length !== 2 ||
    rawGhApiLines.some(
      (line) => line !== `gh api --method PATCH "repos/\${{ github.repository }}/releases/$RELEASE_ID" \\`
    )
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
    [paginationBinding("REMOTE_ASSETS", "ASSET_PAGES", "flatten-pages asset"), 5],
    [paginationBinding("CURRENT_ASSETS", "CURRENT_ASSET_PAGES", "flatten-pages asset"), 1],
    [paginationBinding("FINAL_ASSETS", "ASSET_PAGES", "flatten-pages asset"), 1],
    [paginationBinding("PUBLISH_ASSETS", "PUBLISH_ASSET_PAGES", "flatten-pages asset"), 1]
  ];
  if (
    strictPaginationBindings.some(
      ([binding, expected]) => mutationMatchCount(normalizedWorkflow, binding) !== expected
    ) ||
    (workflow.match(/flatten-pages release/g) ?? []).length !== 5 ||
    (workflow.match(/flatten-pages asset/g) ?? []).length !== 9 ||
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
  '            "$TIMEOUT_BIN" --kill-after=10s 600s npm publish "$PACKAGE_TARBALL"' +
  ' --provenance --access public --tag "$CHANNEL" --ignore-scripts';
const MCPB_EXACT_NPM_PUBLISH_RUN =
  '"$TIMEOUT_BIN" --kill-after=10s 600s npm publish "$PACKAGE_TARBALL"' +
  ' --provenance --access public --tag "$CHANNEL" --ignore-scripts';
const MCPB_NPM_TARBALL_SRI =
  'process.stdout.write(`sha512-${createHash("sha512").update(readFileSync(process.argv[1]))' + '.digest("base64")}`);';
const MCPB_ACTIONS_ARTIFACT_DOWNLOAD =
  '          gh_read api -H "Accept: application/vnd.github+json" \\\n' +
  `            "repos/\${{ github.repository }}/actions/artifacts/$PINNED_ARTIFACT_ID/zip" > "$CANDIDATE_ZIP"`;
const MCPB_RELEASE_VISIBILITY_POLL =
  "          for (( release_attempt=1; release_attempt<=12; release_attempt++ )); do";
const MCPB_RELEASE_VISIBILITY_REFRESH = "            RELEASE_PAGES=$(gh_read api --paginate --slurp";
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
    problems.push(
      "release state machine must preflight all deterministic assets before npm, then draft/upload/publish"
    );
  }
  const npmPublishStep = namedStep(releaseSteps, "Publish with provenance or verify an exact prior publication");
  const npmPublishRun = runBody(npmPublishStep);
  const npmPublishEnv = yamlRecord(npmPublishStep?.env);
  const npmStateInvocation = 'npm-state "$SOURCE_SHA" "$EXPECTED_INTEGRITY" "$VERSION" "$CHANNEL"';
  const npmReserveIndex = npmPublishRun.indexOf('require_job_reserve 2100 "npm publish"');
  const npmPrewriteTagIndex = npmPublishRun.indexOf("\n  assert_remote_tag_identity", npmReserveIndex);
  const npmPrewriteReadIndex = npmPublishRun.indexOf("if ! registry_read; then", npmPrewriteTagIndex);
  const npmRehashIndex = npmPublishRun.indexOf(
    'PRE_PUBLISH_INTEGRITY=$(tarball_sri "$PACKAGE_TARBALL")',
    npmPrewriteReadIndex
  );
  const npmAttemptedIndex = npmPublishRun.indexOf("NPM_PUBLISH_ATTEMPTED=true", npmRehashIndex);
  const npmNonfatalIndex = npmPublishRun.indexOf("set +e", npmAttemptedIndex);
  const npmPublishIndex = npmPublishRun.indexOf(MCPB_EXACT_NPM_PUBLISH_RUN, npmNonfatalIndex);
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
    npmNonfatalIndex > npmAttemptedIndex &&
    npmPublishIndex > npmNonfatalIndex &&
    npmExitCaptureIndex > npmPublishIndex &&
    npmFatalIndex > npmExitCaptureIndex &&
    npmReadbackIndex > npmFatalIndex &&
    npmFinalTagIndex > npmReadbackIndex;
  const npmReserveTiming = exactPositiveIntegerCaptures(
    npmPublishRun,
    /require_job_reserve ([0-9]+) "npm publish"/gu,
    1
  );
  const npmTagTiming = exactPositiveIntegerCaptures(
    npmPublishRun,
    /"\$TIMEOUT_BIN" --kill-after=([0-9]+)s ([0-9]+)s git ls-remote --tags origin/gu,
    2
  );
  const npmRegistryTiming = exactPositiveIntegerCaptures(
    npmPublishRun,
    /"\$TIMEOUT_BIN" --kill-after=([0-9]+)s ([0-9]+)s "\$CURL_BIN"/gu,
    2
  );
  const npmPublishTiming = exactPositiveIntegerCaptures(
    npmPublishRun,
    /"\$TIMEOUT_BIN" --kill-after=([0-9]+)s ([0-9]+)s npm publish "\$PACKAGE_TARBALL"/gu,
    2
  );
  const npmReadbackTiming = exactPositiveIntegerCaptures(
    npmPublishRun,
    /for \(\( attempt=1; attempt<=([0-9]+); attempt\+\+ \)\); do/gu,
    1
  );
  const npmSleepTiming = exactPositiveIntegerCaptures(npmPublishRun, /^\s*sleep ([0-9]+)$/gmu, 1);
  const [npmReserveSeconds = 0] = npmReserveTiming ?? [];
  const [npmTagKillSeconds = 0, npmTagTimeoutSeconds = 0] = npmTagTiming ?? [];
  const [npmRegistryKillSeconds = 0, npmRegistryTimeoutSeconds = 0] = npmRegistryTiming ?? [];
  const [npmPublishKillSeconds = 0, npmPublishTimeoutSeconds = 0] = npmPublishTiming ?? [];
  const [npmReadbackAttempts = 0] = npmReadbackTiming ?? [];
  const [npmSleepSeconds = 0] = npmSleepTiming ?? [];
  const npmTimingContractIsExact =
    npmReserveTiming !== null &&
    npmTagTiming !== null &&
    npmRegistryTiming !== null &&
    npmPublishTiming !== null &&
    npmReadbackTiming !== null &&
    npmSleepTiming !== null &&
    (npmPublishRun.match(/^\s*assert_remote_tag_identity$/gmu) ?? []).length === 2;
  const npmReserveCoversWorstCase =
    npmTimingContractIsExact &&
    npmReserveSeconds >=
      2 * (npmTagTimeoutSeconds + npmTagKillSeconds) +
        (npmRegistryTimeoutSeconds + npmRegistryKillSeconds) +
        (npmPublishTimeoutSeconds + npmPublishKillSeconds) +
        npmReadbackAttempts * (npmRegistryTimeoutSeconds + npmRegistryKillSeconds) +
        (npmReadbackAttempts - 1) * npmSleepSeconds +
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
    'require_job_reserve 2100 "npm publish"',
    MCPB_EXACT_NPM_PUBLISH_RUN,
    'echo "::warning::npm publish exited $NPM_PUBLISH_EXIT, but exact tarball SRI, channel, and tag postconditions prove publication completed"'
  ];
  const npmCommandSurfaceIsClosed =
    npmPackPublishSurface.length === npmPackPublishExpectedTail.length + 1 &&
    npmPackPublishSurface[0]?.startsWith(`PACK_JSON=$(${MCPB_EXACT_NPM_PACK}`) === true &&
    npmPackPublishSurface[0]?.endsWith("\\") === true &&
    JSON.stringify(npmPackPublishSurface.slice(1)) === JSON.stringify(npmPackPublishExpectedTail) &&
    (npmPublishRun.match(/\bnpm\b/gu) ?? []).length === 31 &&
    (npmPublishRun.match(/\bNPM_BIN\b/gu) ?? []).length === 2;
  const npmPublicationIsByteBound =
    npmPublishEnv?.NODE_AUTH_TOKEN === `\${{ secrets.NPM_TOKEN }}` &&
    npmPublishEnv?.NPM_CONFIG_FETCH_TIMEOUT === "60000" &&
    npmPublishEnv?.NPM_CONFIG_FETCH_RETRIES === "0" &&
    npmPublishRun.includes('PACKAGE_URL="https://registry.npmjs.org/%40oomkapwn%2Fenquire-mcp"') &&
    npmPublishRun.includes('PACKUMENT=$(mktemp "$RUNNER_TEMP/enquire-npm-packument.XXXXXX")') &&
    npmPublishRun.includes("registry_read() {") &&
    npmPublishRun.includes('"$TIMEOUT_BIN" --kill-after=5s 35s "$CURL_BIN"') &&
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
    (
      npmPublishRun.match(
        /npm publish "\$PACKAGE_TARBALL" --provenance --access public --tag "\$CHANNEL" --ignore-scripts/g
      ) ?? []
    ).length === 1 &&
    npmPublishRun.includes(MCPB_EXACT_NPM_PUBLISH_RUN) &&
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
    !inputs.consumer.includes('hono: "^4.12.31"') ||
    !inputs.consumer.includes('archivedPackageVersions.get("@hono/node-server")') ||
    !inputs.consumer.includes('["2.0.11"]') ||
    !inputs.consumer.includes('archivedPackageVersions.get("hono")') ||
    !inputs.consumer.includes('["4.12.31"]') ||
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
  const freshUploadClassifier = "CURRENT_ACTION=$(printf '%s' \"$CURRENT_STATE\" | release_state | jq -r '.action')";
  const freshUploadRefusal = 'if [ "$CURRENT_ACTION" != "resume_draft" ] || [ "$CURRENT_NAME_COUNT" -ne 0 ]; then';
  const uploadPost = "curl --fail-with-body --silent --show-error --request POST";
  const freshUploadTagProof = `              assert_remote_tag_identity\n              ${uploadPost}`;
  const publicationTagProof =
    '          assert_remote_tag_identity\n          if [ "$FINAL_ACTION" = "publish_draft" ]; then';
  const finalPostconditionTagProof =
    "          assert_remote_tag_identity\n          FINAL_PRERELEASE=$(printf '%s' \"$RELEASE_JSON\" | jq -r '.prerelease')";
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
    !inputs.integrity.includes("isExactSha256DigestOrNull") ||
    !inputs.integrity.includes("paginated asset element has an invalid identity") ||
    !inputs.integrity.includes("export function candidateRunIds") ||
    !inputs.integrity.includes("export function evaluateMcpbCandidateRun") ||
    !inputs.integrity.includes("export function assertMcpbAssetVersion") ||
    !inputs.integrity.includes("export function assertChannelVersionAdvance") ||
    inputs.integrity.includes("release.target_commitish") ||
    !inputs.release.includes('node scripts/check-release-integrity.mjs asset-version "$VERSION"') ||
    !inputs.release.includes("node scripts/check-release-integrity.mjs candidate-runs") ||
    !inputs.release.includes('candidate "$SOURCE_SHA"') ||
    !inputs.release.includes("{workflow_run: $workflow_run, jobs: $jobs, artifacts: $artifacts}") ||
    !/node scripts\/check-release-integrity\.mjs \\\s+candidate/u.test(inputs.release) ||
    (inputs.release.match(/node scripts\/check-release-integrity\.mjs release-state/g) ?? []).length !== 3 ||
    (inputs.release.match(/release-state "\$TAG" "\$EXPECTED_PRERELEASE"/g) ?? []).length !== 3 ||
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
    !inputs.release.includes("Existing release asset $NAME differs before npm publication") ||
    (inputs.release.match(/git ls-remote --tags origin/g) ?? []).length !== 4 ||
    (inputs.release.match(/assert_remote_tag_identity\(\) \{/g) ?? []).length !== 4 ||
    (inputs.release.match(/^\s+assert_remote_tag_identity$/gmu) ?? []).length !== 8 ||
    (inputs.release.match(/"\$RAW_TAG_COUNT" -ne 1/g) ?? []).length !== 4 ||
    (inputs.release.match(/"\$PEELED_TAG_COUNT" -ne 1/g) ?? []).length !== 4 ||
    (inputs.release.match(/"\$PEELED_TAG_SHA" != "\$SOURCE_SHA"/g) ?? []).length !== 4 ||
    inputs.release.includes("target_commitish") ||
    inputs.release.includes("--target") ||
    !inputs.release.includes("--verify-tag") ||
    !inputs.release.includes("--draft") ||
    !inputs.release.includes("Published release $TAG is partial") ||
    !inputs.release.includes("Final release contains unexpected asset") ||
    !inputs.release.includes("Final release does not contain exactly one $NAME") ||
    !inputs.release.includes(`gh api --method PATCH "repos/\${{ github.repository }}/releases/$RELEASE_ID"`) ||
    !inputs.release.includes("group: release-publication") ||
    !inputs.release.includes("cancel-in-progress: false") ||
    !inputs.release.includes("CURRENT_UPLOAD_URL=$(printf '%s' \"$CURRENT_RELEASE\" | jq -r '.upload_url')") ||
    !inputs.release.includes(
      `https://uploads.github.com/repos/\${{ github.repository }}/releases/$RELEASE_ID/assets`
    ) ||
    !inputs.release.includes("ENCODED_NAME=$(printf '%s' \"$NAME\" | jq -sRr @uri)") ||
    !inputs.release.includes(uploadPost) ||
    !inputs.release.includes('--data-binary "@$LOCAL_ASSET" "$UPLOAD_BASE?name=$ENCODED_NAME"') ||
    inputs.release.includes("--hostname uploads.github.com") ||
    !freshUploadOrderIsSafe ||
    !inputs.release.includes(publicationTagProof) ||
    !inputs.release.includes(finalPostconditionTagProof) ||
    !inputs.release.includes(`PUBLISH_RELEASE=$(gh_read api "repos/\${{ github.repository }}/releases/$RELEASE_ID")`) ||
    (inputs.release.match(/node scripts\/check-release-integrity\.mjs channel-advance/g) ?? []).length !== 3 ||
    inputs.release.lastIndexOf("node scripts/check-release-integrity.mjs channel-advance") >
      inputs.release.indexOf(MCPB_EXACT_NPM_PUBLISH) ||
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
    (inputs.release.match(/cmp -s "\$LOCAL_ASSET"/g) ?? []).length !== 3 ||
    (inputs.release.includes("gh release upload") && inputs.release.includes("--clobber")) ||
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

  it("keeps release.yml wired to the shared evaluator and an exact mirrored inventory", () => {
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

    const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
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
      assetNames: ["a", "b"]
    };
    const draftRelease = {
      id: 100,
      tag_name: releaseExpected.tag,
      target_commitish: "main",
      prerelease: releaseExpected.prerelease,
      draft: true
    };
    const assetA = releaseAsset("a", 101);
    const assetB = releaseAsset("b", 102);
    expect(evaluateMcpbReleaseState({ release: null, assets: [] }, releaseExpected)).toEqual({
      action: "create_draft",
      missing: ["a", "b"]
    });
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
    for (const malformedState of [
      {},
      { release: null },
      { release: null, assets: null },
      { release: undefined, assets: [] },
      { release: { ...draftRelease, id: 0 }, assets: [] },
      { release: { ...draftRelease, id: 1.5 }, assets: [] },
      { release: { ...draftRelease, id: Number.MAX_SAFE_INTEGER + 1 }, assets: [] },
      { release: draftRelease, assets: [{ ...assetA, id: 0 }] }
    ]) {
      expect(() => evaluateMcpbReleaseState(malformedState, releaseExpected)).toThrow();
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
          'echo "RELEASE_JOB_DEADLINE_EPOCH=$(($(date +%s) + 13800))" >> "$GITHUB_ENV"',
          'echo "RELEASE_JOB_DEADLINE_EPOCH=$(($(date +%s) + 138000))" >> "$GITHUB_ENV"'
        )
      )
    ).toContain("release polling must outlive the blocking package-consumer matrix and leave publication headroom");
    expect(
      releasePollProblems(replaceExactly(workflow, RAW_GH_READ_DEADLINE_GUARD, MUTATED_RAW_GH_READ_DEADLINE_GUARD, 4))
    ).toContain("all post-gate GitHub reads must consume the global deadline without shadowing release writes");
    expect(releasePollProblems(replaceExactly(workflow, "--raw-field|--raw-field=*", "--raw-field", 5))).toContain(
      "all post-gate GitHub reads must consume the global deadline without shadowing release writes"
    );
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
      releasePollProblems(
        replaceExactly(
          workflow,
          `gh api --method PATCH "repos/\${{ github.repository }}/releases/$RELEASE_ID"`,
          `gh_read api --method PATCH "repos/\${{ github.repository }}/releases/$RELEASE_ID"`,
          2
        )
      )
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
    expect(releasePollProblems(replaceExactly(workflow, "flatten-pages release", "jq 'add // []'", 5))).toContain(
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
        release: replaceExactly(mcpbInputs.release, 'cmp -s "$LOCAL_ASSET" "$REMOTE_ASSET"', "true")
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
      replaceExactly(mcpbInputs.release, 'createHash("sha512")', 'createHash("sha256")'),
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
        replaceExactly(MCPB_EXACT_NPM_PUBLISH, " --kill-after=10s", "")
      ),
      replaceExactly(
        mcpbInputs.release,
        MCPB_EXACT_NPM_PUBLISH,
        replaceExactly(MCPB_EXACT_NPM_PUBLISH, " --ignore-scripts", "")
      ),
      replaceExactly(mcpbInputs.release, 'NPM_CONFIG_FETCH_RETRIES: "0"', 'NPM_CONFIG_FETCH_RETRIES: "1"'),
      replaceExactly(mcpbInputs.release, "--max-filesize 67108864 --retry 0", "--max-filesize 67108864 --retry 1"),
      replaceExactly(mcpbInputs.release, '[ "$status" != "200" ]', '[ "$status" = "500" ]'),
      replaceExactly(mcpbInputs.release, "Accept: application/json", "Accept: application/vnd.npm.install-v1+json"),
      replaceExactly(mcpbInputs.release, "(.versions | has($version))", "(.versions[$version] != null)"),
      replaceExactly(mcpbInputs.release, '($channelPresent and ($channelVersion == "-"))', "false"),
      replaceExactly(mcpbInputs.release, "integrity: $published.dist.integrity", "integrity: $published.dist.shasum"),
      replaceExactly(mcpbInputs.release, RAW_NPM_RESERVE_DEADLINE_GUARD, MUTATED_RAW_NPM_RESERVE_DEADLINE_GUARD),
      replaceExactly(mcpbInputs.release, 'require_job_reserve 2100 "npm publish"', "true"),
      replaceExactly(mcpbInputs.release, "              sleep 10", "              sleep 200"),
      replaceAllExactly(
        mcpbInputs.release,
        '"$TIMEOUT_BIN" --kill-after=10s 60s git ls-remote --tags origin',
        '"$TIMEOUT_BIN" --kill-after=10s 600s git ls-remote --tags origin',
        4
      ),
      replaceExactly(
        mcpbInputs.release,
        '            require_job_reserve 2100 "npm publish"\n            assert_remote_tag_identity',
        '            assert_remote_tag_identity\n            require_job_reserve 2100 "npm publish"'
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
    const freshUploadClassifier = "CURRENT_ACTION=$(printf '%s' \"$CURRENT_STATE\" | release_state | jq -r '.action')";
    const releaseWithoutFreshUploadClassifier = replaceExactly(
      mcpbInputs.release,
      freshUploadClassifier,
      'CURRENT_ACTION="resume_draft"'
    );
    const classifierAfterUpload = replaceExactly(
      releaseWithoutFreshUploadClassifier,
      "curl --fail-with-body --silent --show-error --request POST",
      `curl --fail-with-body --silent --show-error --request POST\n              ${freshUploadClassifier}`
    );
    expect(mcpbContractProblems({ ...mcpbInputs, release: classifierAfterUpload })).toContain(
      "release must reuse exact CI-gated MCPB bytes, re-verify them, and attach transparency records with checkout provenance"
    );
    const uploadTagProof =
      "              assert_remote_tag_identity\n              curl --fail-with-body --silent --show-error --request POST";
    const releaseWithoutUploadTagProof = replaceExactly(
      mcpbInputs.release,
      uploadTagProof,
      "              curl --fail-with-body --silent --show-error --request POST"
    );
    const relocatedUploadTagProof = replaceExactly(
      releaseWithoutUploadTagProof,
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
        release: replaceExactly(
          mcpbInputs.release,
          '          assert_remote_tag_identity\n          if [ "$FINAL_ACTION" = "publish_draft" ]; then',
          '          if [ "$FINAL_ACTION" = "publish_draft" ]; then'
        )
      })
    ).toContain(
      "release must reuse exact CI-gated MCPB bytes, re-verify them, and attach transparency records with checkout provenance"
    );
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
    for (const [guard, weakenedGuard] of [
      ['[ "$RAW_TAG_COUNT" -ne 1 ]', '[ "$RAW_TAG_COUNT" -lt 0 ]'],
      ['[ "$PEELED_TAG_COUNT" -ne 1 ]', '[ "$PEELED_TAG_COUNT" -lt 0 ]'],
      ['[ "$PEELED_TAG_SHA" != "$SOURCE_SHA" ]', '[ "$PEELED_TAG_SHA" = "$SOURCE_SHA" ]']
    ] as const) {
      expect(
        mcpbContractProblems({
          ...mcpbInputs,
          release: replaceAllExactly(mcpbInputs.release, guard, weakenedGuard, 4)
        })
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
          5
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
  });
});
