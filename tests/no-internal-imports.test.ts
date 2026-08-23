import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { load } from "js-yaml";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  firstPartyVitestFocusSourceFiles,
  inspectRepositoryVitestFocusControls,
  inspectStaticVitestFocusControls
} from "../scripts/lib/oia-vitest-focus.mjs";
import { replaceExactly } from "./helpers/exact-source-mutation.js";

// Class A invariant (v3.6.0-rc.4) — closes the "hardcoded paths to
// internal-only modules" drift class observed during the rc.1+rc.2
// monolith split.
//
// Background. The sprint discovered 4 separate test-import drift
// incidents:
//   - rc.1 split: 15 test files imported from `../src/tools.js`
//     (no longer existed) → bulk path-rewrite
//   - rc.2 split: docs-consistency.test.ts regex-parsed
//     `../src/index.ts` for `registerTool(` patterns that had
//     moved to `tool-registry.ts`
//   - rc.2 split: coverage exclude list hardcoded `src/index.ts`
//     when reality moved to 6 files
//   - rc.2 split: STABILITY.md hardcoded src/index.ts for
//     symbols that now live in src/{cli,server,tool-registry}.ts
//
// Common root cause: code OUTSIDE `package.json#exports` ssylaetsja
// at internal source paths by exact filename. Any structural refactor
// breaks all of them simultaneously.
//
// This invariant catches the FIRST CLASS of those — test imports
// pulling values from "registration boilerplate" modules. Those
// modules are integration-tested through the MCP surface, never
// directly. If a future refactor moves their contents, no test should
// be broken by the move; this invariant blocks the regression at
// introduction time.
//
// Allowed:
//   - import paths under `src/tools/index.js` (the tools barrel)
//   - import paths under any `src/{vault,fts5,embed-db,embed-pipeline,
//     embed-sync,hnsw,bases,communities,dql,embeddings,eval,ocr,pdf,periodic,rrf,parser,
//     doctor,watcher,http-transport,cli-help,tool-manifest}.js`
//     (infrastructure + manifest + constants modules)
//   - `src/index.js` (the slim re-export barrel — its only purpose
//     is to be a stable import path)
//
// Restricted (no VALUE imports allowed):
//   - `src/cli.js`         — commander program internals
//   - `src/server.js`      — MCP server construction internals
//   - `src/tool-registry.js` — registerTool loops
//   - `src/prompts.js`     — prompt registration
//
// Exception: `docs-consistency.test.ts` reads these as text via
// `fs.readFile()` (not `import`). That's allowed — the invariant
// only checks `import ... from "..."` statements.
//
// Class B invariant (post-v4.0.0-rc.2 hardening) — two repository-integrity
// tests are intentionally omitted only from the redundant V8-instrumented
// rerun. They remain mandatory in both unfiltered Node test legs. The exact
// package command, workflow prerequisites, same-run coverage evidence handoff,
// production coverage set, timeout ceilings and reviewed direct-loader
// value-import closure are one fail-closed contract:
// a wildcard, third omission, filtered prerequisite or production import
// makes this lightweight test fail before the coverage job can qualify.
//
// Class C invariant (post-PR #518 sibling sweep) — Vitest focus controls are
// enforced by OIA Check 12c in a separate Node process. The analyzer scans the
// complete first-party JavaScript/TypeScript executable-source census,
// including this oracle file, so focus alone cannot skip the detector after
// OIA starts.

const repoRoot = path.resolve(__dirname, "..");
const EXECUTABLE_SOURCE_EXTENSIONS = new Set([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);
const GENERATED_EXECUTABLE_ROOTS = new Set([".git", "coverage", "dist", "node_modules"]);
const RESTRICTED_MODULES = ["cli", "server", "tool-registry", "prompts"];
const COVERAGE_ONLY_TEST_EXCLUSIONS = [
  "tests/meta-invariant-coverage.test.ts",
  "tests/release-integrity.test.ts"
] as const;
const EXPECTED_COVERAGE_SCRIPT =
  "vitest run --coverage --exclude tests/meta-invariant-coverage.test.ts " +
  "--exclude tests/release-integrity.test.ts";
const EXPECTED_OIA_SCRIPT = "node scripts/oia-walk.mjs";
const OIA_FOCUS_IMPORT = 'import { inspectRepositoryVitestFocusControls } from "./lib/oia-vitest-focus.mjs";';
const OIA_FOCUS_CALL = "for (const finding of inspectRepositoryVitestFocusControls(repoRoot))";
const EXPECTED_PREPUBLISH_ONLY_SCRIPT =
  "npm run lint && npm run build && npm test && node scripts/check-version-consistency.mjs && " +
  "node scripts/check-audit.mjs && npm run test:coverage --silent && " +
  "node scripts/check-changelog-coverage.mjs && node scripts/check-per-file-coverage.mjs";
const EXPECTED_CHECKOUT_ACTION = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
const EXPECTED_SETUP_NODE_ACTION = "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020";
const EXPECTED_UPLOAD_ARTIFACT_ACTION = "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";
const EXPECTED_DOWNLOAD_ARTIFACT_ACTION = "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c";
const EXPECTED_COVERAGE_CLOSURE_FILES = [
  "scripts/check-release-integrity.mjs",
  "scripts/lib/entrypoint.mjs",
  "scripts/lib/mcpb-safety.mjs",
  "scripts/mcpb-consumer.mjs",
  "scripts/npm-ci-with-retry.mjs",
  "tests/helpers/exact-source-mutation.ts",
  "tests/meta-invariant-coverage.test.ts",
  "tests/npm-ci-workflow-contract-fixtures.ts",
  "tests/release-integrity.test.ts",
  "tests/release-mutation-identity-audit.ts",
  "tests/release-mutation-plan.ts",
  "tests/release-mutation-transition-audit.ts",
  "tests/release-mutation-transition-plan.ts",
  "tests/release-mutation-transition.ts",
  "tests/release-split-contract-fixtures.ts"
] as const;
const EXPECTED_COVERAGE_EXTERNAL_MODULES = new Set([
  "@modelcontextprotocol/client",
  "@modelcontextprotocol/client/stdio",
  "fflate",
  "js-yaml",
  "node:assert",
  "node:buffer",
  "node:child_process",
  "node:crypto",
  "node:fs",
  "node:os",
  "node:path",
  "node:url",
  "node:util",
  "typescript",
  "vitest"
]);

async function independentExecutableSourceCensus(root: string, relativeDirectory = ""): Promise<string[]> {
  const absoluteDirectory = relativeDirectory === "" ? root : path.join(root, relativeDirectory);
  const files: string[] = [];
  for (const entry of await fs.readdir(absoluteDirectory, { withFileTypes: true })) {
    const relativeEntry = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
    if (relativeDirectory === "" && GENERATED_EXECUTABLE_ROOTS.has(entry.name)) continue;
    if (entry.isSymbolicLink()) {
      throw new Error(`independent executable-source census refuses symbolic link ${relativeEntry}`);
    }
    if (entry.isDirectory()) {
      files.push(...(await independentExecutableSourceCensus(root, relativeEntry)));
    } else if (entry.isFile() && EXECUTABLE_SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(relativeEntry);
    }
  }
  return files.sort();
}

const VITEST_RUNTIME_LOADERS = new Set(["doMock", "importActual", "importMock", "mock"]);
const EXPECTED_VITEST_CONFIG_FILES = ["vitest.config.ts"] as const;
// Canonical JSON SHA-256 pins keep every reviewed step exact without copying
// multiline shell bodies into this invariant a second time.
const EXPECTED_TEST_STEP_FINGERPRINTS = [
  "3ef4af68ef144f12dd555f182fb78c286413a5c20503a3491c8a1a7ea3554af7",
  "edca7cfed3ff243cb4a555e1d498c0aaf00c3beea661e07b0a4b29201526d909",
  "d6afccf6f68cf1593c09c268ca358cc0def948d0f8b14ee047128a5a6e366627",
  "338e29c470a015d92698b8184b65ee481976a1a24ad813eab912c20460a2a937",
  "44d96178c110e1ceeaa809d554c1bc392079517800a7a155792ee34206ef2c0e",
  "dbaf53cd3dfd2d8bc4d6f741915bc861d1ac27b5cf842aee668e9bef8e011843",
  "59d90db08cea0405ca3033ef2e00b11406b56244d0007ed5c0423684052640bc"
] as const;
const EXPECTED_COVERAGE_STEP_FINGERPRINTS = [
  "3ef4af68ef144f12dd555f182fb78c286413a5c20503a3491c8a1a7ea3554af7",
  "2873c30795c24c8e23b779c04f85e269a194d6d7f89baddd3888d1f619855563",
  "338e29c470a015d92698b8184b65ee481976a1a24ad813eab912c20460a2a937",
  "44d96178c110e1ceeaa809d554c1bc392079517800a7a155792ee34206ef2c0e",
  "3bfd312da192922a8ddd4c6e7e5e3473d3ddc2743dbc73e40281975dd9848268",
  "e69e201d4b1395014e59ae019d60395c73b33f3fe3dd112653fb524f5d34fd55",
  "0effe396ca2ba4507989894b9b011d618cef92a4ce40fe0db03fd898590475d9",
  "3cf86138c09850122bcbb0ecd64eedbc3f69b03dbd552b6ee7ac16f6974cc875"
] as const;
const EXPECTED_OIA_STEP_FINGERPRINTS = [
  "3ef4af68ef144f12dd555f182fb78c286413a5c20503a3491c8a1a7ea3554af7",
  "2873c30795c24c8e23b779c04f85e269a194d6d7f89baddd3888d1f619855563",
  "338e29c470a015d92698b8184b65ee481976a1a24ad813eab912c20460a2a937",
  "1b0717ee04319d167e0837f827d565e709c377f5f7f126c52e74eb84391653ff",
  "6d17292384f49a212eddf1e626f36f87d22853089bdbd2218692cebbf0e84056"
] as const;
const FORBIDDEN_TEST_LIFECYCLE_SCRIPTS = ["pretest", "posttest", "pretest:coverage", "posttest:coverage"] as const;
const FORBIDDEN_OIA_LIFECYCLE_SCRIPTS = ["precheck:oia", "postcheck:oia"] as const;

type UnknownRecord = Record<string, unknown>;

interface CoverageIsolationInputs {
  readonly packageJson: string;
  readonly ciWorkflow: string;
  readonly vitestConfig: string;
  readonly vitestConfigFiles: readonly string[];
  readonly docsConsistencySource: string;
  readonly k1ClassSource: string;
  readonly releaseMutationTransitionSource: string;
  readonly closureSources: ReadonlyMap<string, string>;
}

function asRecord(value: unknown): UnknownRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as UnknownRecord) : undefined;
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  const record = asRecord(value);
  if (record === undefined) return value;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, canonicalJsonValue(record[key])])
  );
}

function workflowStepFingerprints(steps: readonly UnknownRecord[] | undefined): string[] {
  if (steps === undefined) return [];
  return steps.map((step) => {
    const encoded = JSON.stringify(canonicalJsonValue(step));
    if (encoded === undefined) throw new Error("workflow step must remain JSON-serializable");
    return createHash("sha256").update(encoded).digest("hex");
  });
}

function propertyNameText(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

function objectProperty(object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  const matches = object.properties.filter(
    (property): property is ts.PropertyAssignment =>
      ts.isPropertyAssignment(property) && propertyNameText(property.name) === name
  );
  return matches.length === 1 ? matches[0]?.initializer : undefined;
}

function objectHasDynamicProperty(object: ts.ObjectLiteralExpression): boolean {
  return object.properties.some(
    (property) => !ts.isPropertyAssignment(property) || propertyNameText(property.name) === undefined
  );
}

function objectHasExactStaticKeys(object: ts.ObjectLiteralExpression, expected: readonly string[]): boolean {
  if (objectHasDynamicProperty(object)) return false;
  const actual = object.properties
    .map((property) => (ts.isPropertyAssignment(property) ? propertyNameText(property.name) : undefined))
    .filter((value): value is string => value !== undefined)
    .sort();
  return actual.length === object.properties.length && isDeepStrictEqual(actual, [...expected].sort());
}

function recordHasExactKeys(record: UnknownRecord, expected: readonly string[]): boolean {
  return isDeepStrictEqual(Object.keys(record).sort(), [...expected].sort());
}

function stringLiteralValue(expression: ts.Expression | undefined): string | undefined {
  return expression !== undefined && ts.isStringLiteralLike(expression) ? expression.text : undefined;
}

function stringLiteralArray(expression: ts.Expression | undefined): string[] | undefined {
  if (expression === undefined || !ts.isArrayLiteralExpression(expression)) return undefined;
  const values: string[] = [];
  for (const element of expression.elements) {
    if (!ts.isStringLiteralLike(element)) return undefined;
    values.push(element.text);
  }
  return values;
}

function hasExactDefineConfigImport(statement: ts.Statement | undefined): boolean {
  if (statement === undefined || !ts.isImportDeclaration(statement)) return false;
  if (stringLiteralValue(statement.moduleSpecifier) !== "vitest/config" || statement.attributes !== undefined) {
    return false;
  }
  const clause = statement.importClause;
  if (
    clause === undefined ||
    clause.isTypeOnly ||
    clause.name !== undefined ||
    clause.namedBindings === undefined ||
    !ts.isNamedImports(clause.namedBindings) ||
    clause.namedBindings.elements.length !== 1
  ) {
    return false;
  }
  const binding = clause.namedBindings.elements[0];
  return (
    binding !== undefined &&
    !binding.isTypeOnly &&
    binding.propertyName === undefined &&
    binding.name.text === "defineConfig"
  );
}

function hasExactCoveragePolicyImport(statement: ts.Statement | undefined): boolean {
  if (statement === undefined || !ts.isImportDeclaration(statement)) return false;
  if (
    stringLiteralValue(statement.moduleSpecifier) !== "./scripts/lib/coverage-policy.mjs" ||
    statement.attributes !== undefined
  ) {
    return false;
  }
  const clause = statement.importClause;
  if (
    clause === undefined ||
    clause.isTypeOnly ||
    clause.name !== undefined ||
    clause.namedBindings === undefined ||
    !ts.isNamedImports(clause.namedBindings) ||
    clause.namedBindings.elements.length !== 1
  ) {
    return false;
  }
  const binding = clause.namedBindings.elements[0];
  return (
    binding !== undefined &&
    !binding.isTypeOnly &&
    binding.propertyName === undefined &&
    binding.name.text === "COVERAGE_EXCLUDE_PATTERNS"
  );
}

function isExactCoveragePolicySpread(expression: ts.Expression | undefined): boolean {
  if (expression === undefined || !ts.isArrayLiteralExpression(expression) || expression.elements.length !== 1) {
    return false;
  }
  const element = expression.elements[0];
  return (
    element !== undefined &&
    ts.isSpreadElement(element) &&
    ts.isIdentifier(element.expression) &&
    element.expression.text === "COVERAGE_EXCLUDE_PATTERNS"
  );
}

function packageCoverageProblems(source: string): string[] {
  const problems: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return ["package.json must remain valid JSON"];
  }
  const scripts = asRecord(asRecord(parsed)?.scripts);
  if (scripts?.test !== "vitest run") {
    problems.push("package scripts.test must remain the exact unfiltered vitest run");
  }
  if (scripts?.["test:coverage"] !== EXPECTED_COVERAGE_SCRIPT) {
    problems.push("package scripts.test:coverage must retain the exact two-file coverage-only exclusion");
  }
  if (scripts?.["check:oia"] !== EXPECTED_OIA_SCRIPT) {
    problems.push("package scripts.check:oia must retain the exact independent Node entrypoint");
  }
  if (FORBIDDEN_TEST_LIFECYCLE_SCRIPTS.some((name) => Object.hasOwn(scripts ?? {}, name))) {
    problems.push("package test lifecycle hooks must remain absent");
  }
  if (FORBIDDEN_OIA_LIFECYCLE_SCRIPTS.some((name) => Object.hasOwn(scripts ?? {}, name))) {
    problems.push("package check:oia lifecycle hooks must remain absent");
  }

  const prepublishOnly = scripts?.prepublishOnly;
  if (typeof prepublishOnly !== "string") {
    problems.push("prepublishOnly must remain a static script");
    return problems;
  }
  if (prepublishOnly !== EXPECTED_PREPUBLISH_ONLY_SCRIPT) {
    problems.push("prepublishOnly must retain the exact reviewed gate sequence");
  }
  const stages = prepublishOnly.split("&&").map((stage) => stage.trim());
  const ordinaryTestStages = stages.filter((stage) => stage === "npm test" || stage.startsWith("npm test "));
  const coverageStages = stages.filter(
    (stage) => stage === "npm run test:coverage" || stage.startsWith("npm run test:coverage ")
  );
  if (!isDeepStrictEqual(ordinaryTestStages, ["npm test"])) {
    problems.push("prepublishOnly must retain one exact unfiltered npm test stage");
  }
  if (!isDeepStrictEqual(coverageStages, ["npm run test:coverage --silent"])) {
    problems.push("prepublishOnly must retain one exact coverage stage");
  }
  if (
    stages.indexOf("npm test") === -1 ||
    stages.indexOf("npm run test:coverage --silent") === -1 ||
    stages.indexOf("npm test") >= stages.indexOf("npm run test:coverage --silent")
  ) {
    problems.push("prepublishOnly must run the unfiltered suite before coverage isolation");
  }
  return problems;
}

function workflowSteps(job: UnknownRecord | undefined): UnknownRecord[] | undefined {
  const steps = job?.steps;
  if (!Array.isArray(steps) || steps.some((value) => asRecord(value) === undefined)) return undefined;
  return steps as UnknownRecord[];
}

function jobHasOverride(job: UnknownRecord): boolean {
  return Object.hasOwn(job, "if") || Object.hasOwn(job, "continue-on-error");
}

function ciCoverageProblems(source: string): string[] {
  const problems: string[] = [];
  let parsed: unknown;
  try {
    parsed = load(source);
  } catch {
    return ["CI workflow must remain valid YAML"];
  }
  const workflow = asRecord(parsed);
  if (workflow === undefined) return ["CI workflow must remain an object"];
  if (Object.hasOwn(workflow, "env") || Object.hasOwn(workflow, "defaults")) {
    problems.push("CI root may not override the test or coverage execution environment");
  }
  const jobs = asRecord(workflow.jobs);
  const testJob = asRecord(jobs?.test);
  const testMacosJob = asRecord(jobs?.["test-macos"]);
  const coverageJob = asRecord(jobs?.coverage);
  const oiaJob = asRecord(jobs?.oia);
  if (testJob === undefined) {
    problems.push("CI must retain the blocking test matrix job");
  } else {
    if (
      !recordHasExactKeys(testJob, ["name", "runs-on", "timeout-minutes", "env", "strategy", "steps"]) ||
      testJob.name !== `test (\${{ matrix.label }})` ||
      testJob["runs-on"] !== "ubuntu-latest" ||
      testJob["timeout-minutes"] !== 20 ||
      !isDeepStrictEqual(asRecord(testJob.env), { NPM_CONFIG_ENGINE_STRICT: "true" })
    ) {
      problems.push("CI test matrix must retain its exact fail-capable job boundary");
    }
    const strategy = asRecord(testJob.strategy);
    const matrix = asRecord(strategy?.matrix);
    const expectedMatrix = [
      { label: "22", "node-version": "22.13.0", floor: true },
      { label: "24", "node-version": "24", floor: false }
    ];
    if (
      strategy === undefined ||
      !recordHasExactKeys(strategy, ["fail-fast", "matrix"]) ||
      strategy?.["fail-fast"] !== false ||
      !isDeepStrictEqual(Object.keys(matrix ?? {}).sort(), ["include"]) ||
      !isDeepStrictEqual(matrix?.include, expectedMatrix)
    ) {
      problems.push("CI test matrix must retain exact unfiltered Node 22.13 and Node 24 legs");
    }
    const steps = workflowSteps(testJob);
    if (!isDeepStrictEqual(workflowStepFingerprints(steps), EXPECTED_TEST_STEP_FINGERPRINTS)) {
      problems.push("CI test matrix must retain the exact reviewed step sequence");
    }
    const checkoutStep = steps?.[0];
    if (
      checkoutStep === undefined ||
      !recordHasExactKeys(checkoutStep, ["uses"]) ||
      checkoutStep.uses !== EXPECTED_CHECKOUT_ACTION
    ) {
      problems.push("CI test matrix must begin with the exact pinned checkout step");
    }
    const setupNodeStep = steps?.[1];
    if (
      setupNodeStep === undefined ||
      !recordHasExactKeys(setupNodeStep, ["uses", "with"]) ||
      setupNodeStep.uses !== EXPECTED_SETUP_NODE_ACTION ||
      !isDeepStrictEqual(asRecord(setupNodeStep.with), {
        "node-version": `\${{ matrix.node-version }}`,
        cache: "npm",
        "cache-dependency-path": "package-lock.json"
      })
    ) {
      problems.push("CI test matrix must bind the exact pinned setup-node step to each matrix runtime");
    }
    const testSteps =
      steps?.filter(
        (step) => typeof step.run === "string" && (step.run === "npm test" || step.run.startsWith("npm test "))
      ) ?? [];
    const finalStep = steps === undefined ? undefined : steps[steps.length - 1];
    if (
      testSteps.length !== 1 ||
      testSteps[0]?.run !== "npm test" ||
      testSteps[0] !== finalStep ||
      finalStep === undefined ||
      !recordHasExactKeys(finalStep, ["run", "env"]) ||
      !isDeepStrictEqual(asRecord(finalStep.env), { GH_TOKEN: `\${{ github.token }}` })
    ) {
      problems.push("each CI Node leg must end with one exact unfiltered fail-capable npm test");
    }
  }

  if (testMacosJob === undefined || testMacosJob["timeout-minutes"] !== 20) {
    problems.push("CI macOS full suite must retain its exact advisory 20-minute job boundary");
  }

  if (coverageJob === undefined) {
    problems.push("CI must retain the blocking coverage job");
  } else {
    if (
      !recordHasExactKeys(coverageJob, ["runs-on", "timeout-minutes", "needs", "steps"]) ||
      coverageJob["runs-on"] !== "ubuntu-latest" ||
      coverageJob["timeout-minutes"] !== 10 ||
      coverageJob.needs !== "test"
    ) {
      problems.push("CI coverage must retain its exact prerequisite-bound 10-minute job boundary");
    }
    const steps = workflowSteps(coverageJob);
    if (!isDeepStrictEqual(workflowStepFingerprints(steps), EXPECTED_COVERAGE_STEP_FINGERPRINTS)) {
      problems.push("CI coverage must retain the exact reviewed step sequence");
    }
    const checkoutStep = steps?.[0];
    if (
      checkoutStep === undefined ||
      !recordHasExactKeys(checkoutStep, ["uses"]) ||
      checkoutStep.uses !== EXPECTED_CHECKOUT_ACTION
    ) {
      problems.push("CI coverage must begin with the exact pinned checkout step");
    }
    const setupNodeStep = steps?.[1];
    if (
      setupNodeStep === undefined ||
      !recordHasExactKeys(setupNodeStep, ["uses", "with"]) ||
      setupNodeStep.uses !== EXPECTED_SETUP_NODE_ACTION ||
      !isDeepStrictEqual(asRecord(setupNodeStep.with), { "node-version": 22, cache: "npm" })
    ) {
      problems.push("CI coverage must retain the exact pinned Node 22 setup step");
    }
    const coverageSteps =
      steps?.filter(
        (step) =>
          typeof step.run === "string" &&
          (step.run === "npm run test:coverage" || step.run.startsWith("npm run test:coverage "))
      ) ?? [];
    if (
      coverageSteps.length !== 1 ||
      coverageSteps[0]?.run !== "npm run test:coverage" ||
      (coverageSteps[0] !== undefined && jobHasOverride(coverageSteps[0]))
    ) {
      problems.push("CI coverage must execute one exact unconditional npm run test:coverage");
    }
    const runCommands = steps?.flatMap((step) => (typeof step.run === "string" ? [step.run] : [])) ?? [];
    const requiredOrder = [
      "npm run build",
      "npm run test:coverage",
      "npm run check:changelog-coverage",
      "npm run check:per-file-coverage"
    ];
    const exactOnce = requiredOrder.every(
      (command) => runCommands.filter((candidate) => candidate === command).length === 1
    );
    const gateStart = steps?.findIndex((step) => step.run === requiredOrder[0]) ?? -1;
    const contiguousGateSteps = gateStart >= 0 ? steps?.slice(gateStart, gateStart + requiredOrder.length) : [];
    const exactGateShapes =
      contiguousGateSteps?.length === requiredOrder.length &&
      contiguousGateSteps.every(
        (step, index) => recordHasExactKeys(step, ["run"]) && step.run === requiredOrder[index]
      );
    if (!exactOnce || !exactGateShapes) {
      problems.push("CI coverage must retain contiguous fail-capable build, coverage and floor gates");
    }
    const measurementIndex = steps?.findIndex((step) => step.run === "npm run test:coverage") ?? -1;
    const uploadIndexes =
      steps
        ?.map((step, index) => (step.uses === EXPECTED_UPLOAD_ARTIFACT_ACTION ? index : -1))
        .filter((index) => index >= 0) ?? [];
    const uploadIndex = uploadIndexes.length === 1 ? uploadIndexes[0] : undefined;
    const uploadStep = uploadIndex === undefined ? undefined : steps?.[uploadIndex];
    const uploadWith = asRecord(uploadStep?.with);
    if (
      uploadIndex === undefined ||
      uploadStep === undefined ||
      !recordHasExactKeys(uploadStep, ["uses", "with"]) ||
      !isDeepStrictEqual(uploadWith, {
        name: "coverage-report",
        path: "coverage/",
        "if-no-files-found": "error"
      }) ||
      measurementIndex < 0 ||
      uploadIndex <= measurementIndex ||
      jobHasOverride(uploadStep)
    ) {
      problems.push("CI coverage must publish one non-empty pinned same-run coverage-report after measurement");
    }
  }

  if (oiaJob === undefined) {
    problems.push("CI must retain the blocking OIA job");
  } else {
    if (
      !recordHasExactKeys(oiaJob, ["runs-on", "timeout-minutes", "needs", "steps"]) ||
      oiaJob["runs-on"] !== "ubuntu-latest" ||
      oiaJob["timeout-minutes"] !== 10 ||
      oiaJob.needs !== "coverage"
    ) {
      problems.push("CI OIA must retain its exact coverage-dependent 10-minute job boundary");
    }
    const steps = workflowSteps(oiaJob);
    if (!isDeepStrictEqual(workflowStepFingerprints(steps), EXPECTED_OIA_STEP_FINGERPRINTS)) {
      problems.push("CI OIA must retain the exact reviewed step sequence");
    }
    const downloadIndexes =
      steps
        ?.map((step, index) => (step.uses === EXPECTED_DOWNLOAD_ARTIFACT_ACTION ? index : -1))
        .filter((index) => index >= 0) ?? [];
    const downloadIndex = downloadIndexes.length === 1 ? downloadIndexes[0] : undefined;
    const downloadStep = downloadIndex === undefined ? undefined : steps?.[downloadIndex];
    const downloadWith = asRecord(downloadStep?.with);
    const checkIndexes =
      steps?.map((step, index) => (step.run === "npm run check:oia" ? index : -1)).filter((index) => index >= 0) ?? [];
    const checkIndex = checkIndexes.length === 1 ? checkIndexes[0] : undefined;
    const checkStep = checkIndex === undefined ? undefined : steps?.[checkIndex];
    if (
      oiaJob.needs !== "coverage" ||
      downloadIndex === undefined ||
      downloadStep === undefined ||
      !recordHasExactKeys(downloadStep, ["name", "uses", "with"]) ||
      !isDeepStrictEqual(downloadWith, {
        name: "coverage-report",
        path: "coverage",
        "digest-mismatch": "error"
      }) ||
      checkIndex === undefined ||
      checkStep === undefined ||
      !recordHasExactKeys(checkStep, ["run"]) ||
      downloadIndex >= checkIndex ||
      jobHasOverride(downloadStep) ||
      jobHasOverride(checkStep)
    ) {
      problems.push("CI OIA must consume the exact pinned current-run coverage-report before checking");
    }
  }
  return problems;
}

function vitestCoverageProblems(source: string, configFiles: readonly string[]): string[] {
  const problems: string[] = [];
  if (!isDeepStrictEqual([...configFiles].sort(), [...EXPECTED_VITEST_CONFIG_FILES])) {
    problems.push("the repository must retain one canonical vitest.config.ts");
  }
  const sourceFile = ts.createSourceFile("vitest.config.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (!hasExactDefineConfigImport(sourceFile.statements[0])) {
    problems.push("vitest config must retain the exact unaliased defineConfig import");
  }
  if (sourceFile.statements.length !== 3 || !hasExactCoveragePolicyImport(sourceFile.statements[1])) {
    problems.push("vitest config must retain the exact centralized coverage-policy import");
  }
  const exportAssignments = sourceFile.statements.filter(ts.isExportAssignment);
  const exportAssignment = exportAssignments.length === 1 ? exportAssignments[0] : undefined;
  const exported = exportAssignment?.expression;
  const configArgument = exported !== undefined && ts.isCallExpression(exported) ? exported.arguments[0] : undefined;
  if (
    exportAssignment?.isExportEquals === true ||
    exported === undefined ||
    !ts.isCallExpression(exported) ||
    !ts.isIdentifier(exported.expression) ||
    exported.expression.text !== "defineConfig" ||
    exported.arguments.length !== 1 ||
    configArgument === undefined ||
    !ts.isObjectLiteralExpression(configArgument)
  ) {
    return [...problems, "vitest config must remain one static default defineConfig object"];
  }
  const config = configArgument;
  if (!objectHasExactStaticKeys(config, ["test"])) {
    problems.push("vitest root config must retain the exact static test-only shape");
  }
  const testExpression = objectProperty(config, "test");
  if (testExpression === undefined || !ts.isObjectLiteralExpression(testExpression)) {
    return [...problems, "vitest config must retain one static test object"];
  }
  const testConfig = testExpression;
  if (!objectHasExactStaticKeys(testConfig, ["include", "environment", "testTimeout", "setupFiles", "coverage"])) {
    problems.push("vitest test config must retain its exact reviewed static key set");
  }
  if (!isDeepStrictEqual(stringLiteralArray(objectProperty(testConfig, "include")), ["tests/**/*.test.ts"])) {
    problems.push("vitest test.include must remain the exact full test-file glob");
  }
  if (stringLiteralValue(objectProperty(testConfig, "environment")) !== "node") {
    problems.push("vitest test.environment must remain node");
  }
  if (objectProperty(testConfig, "testTimeout")?.getText(sourceFile) !== "15_000") {
    problems.push("vitest testTimeout must remain 15_000");
  }
  if (!isDeepStrictEqual(stringLiteralArray(objectProperty(testConfig, "setupFiles")), ["./tests/setup.ts"])) {
    problems.push("vitest setupFiles must retain the exact tests/setup.ts bootstrap");
  }

  const coverageExpression = objectProperty(testConfig, "coverage");
  if (coverageExpression === undefined || !ts.isObjectLiteralExpression(coverageExpression)) {
    return [...problems, "vitest config must retain one static coverage object"];
  }
  const coverage = coverageExpression;
  if (!objectHasExactStaticKeys(coverage, ["provider", "reporter", "include", "exclude", "thresholds"])) {
    problems.push("vitest coverage config must retain its exact reviewed static key set");
  }
  if (stringLiteralValue(objectProperty(coverage, "provider")) !== "v8") {
    problems.push("vitest coverage provider must remain v8");
  }
  if (
    !isDeepStrictEqual(stringLiteralArray(objectProperty(coverage, "reporter")), [
      "text",
      "html",
      "lcov",
      "json-summary"
    ])
  ) {
    problems.push("vitest coverage reporters must retain text, html, lcov and json-summary");
  }
  if (!isDeepStrictEqual(stringLiteralArray(objectProperty(coverage, "include")), ["src/**/*.ts"])) {
    problems.push("vitest coverage.include must remain exact src/**/*.ts");
  }
  if (!isExactCoveragePolicySpread(objectProperty(coverage, "exclude"))) {
    problems.push("vitest production coverage exclusions must use the exact centralized policy spread");
  }
  const thresholdsExpression = objectProperty(coverage, "thresholds");
  if (thresholdsExpression === undefined || !ts.isObjectLiteralExpression(thresholdsExpression)) {
    problems.push("vitest coverage thresholds must remain a static object");
  } else {
    const expectedThresholds: Readonly<Record<string, string>> = {
      lines: "86",
      statements: "82",
      functions: "75",
      branches: "74"
    };
    if (!objectHasExactStaticKeys(thresholdsExpression, Object.keys(expectedThresholds))) {
      problems.push("vitest coverage thresholds must retain the exact four global floors");
    }
    for (const [name, value] of Object.entries(expectedThresholds)) {
      if (objectProperty(thresholdsExpression, name)?.getText(sourceFile) !== value) {
        problems.push(`vitest coverage threshold ${name} must remain ${value}`);
      }
    }
  }
  return problems;
}

type RegistrationVitestBinding = "beforeAll" | "describe" | "it";

function registrationVitestBindingProblems(
  sourceFile: ts.SourceFile,
  filename: string,
  requiredBindings: readonly RegistrationVitestBinding[]
): string[] {
  // A matching identifier is not registration authority: an alias plus a local
  // wrapper can keep the reviewed literal while changing or suppressing the test.
  const directCounts = new Map<RegistrationVitestBinding, number>();
  const otherCounts = new Map<RegistrationVitestBinding, number>();
  for (const binding of requiredBindings) {
    directCounts.set(binding, 0);
    otherCounts.set(binding, 0);
  }
  const recordOtherBinding = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) {
      const binding = requiredBindings.find((candidate) => candidate === name.text);
      if (binding !== undefined) {
        otherCounts.set(binding, (otherCounts.get(binding) ?? 0) + 1);
      }
      return;
    }
    for (const element of name.elements) {
      if (ts.isBindingElement(element)) recordOtherBinding(element.name);
    }
  };
  const visitRuntimeBindings = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const moduleName = stringLiteralValue(node.moduleSpecifier);
      const clause = node.importClause;
      if (clause === undefined || clause.isTypeOnly) return;
      if (clause.name !== undefined) recordOtherBinding(clause.name);
      const bindings = clause.namedBindings;
      if (bindings === undefined) return;
      if (ts.isNamespaceImport(bindings)) {
        recordOtherBinding(bindings.name);
        return;
      }
      for (const element of bindings.elements) {
        if (element.isTypeOnly) continue;
        const binding = requiredBindings.find((candidate) => candidate === element.name.text);
        if (moduleName === "vitest" && element.propertyName === undefined && binding !== undefined) {
          directCounts.set(binding, (directCounts.get(binding) ?? 0) + 1);
        } else {
          recordOtherBinding(element.name);
        }
      }
      return;
    }
    if (ts.isImportEqualsDeclaration(node)) {
      if (!node.isTypeOnly) recordOtherBinding(node.name);
      return;
    }
    if (ts.isVariableDeclaration(node) || ts.isParameter(node)) {
      recordOtherBinding(node.name);
    } else if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node) ||
      ts.isEnumDeclaration(node)
    ) {
      if (node.name !== undefined) recordOtherBinding(node.name);
    } else if (ts.isModuleDeclaration(node) && ts.isIdentifier(node.name)) {
      recordOtherBinding(node.name);
    }
    ts.forEachChild(node, visitRuntimeBindings);
  };
  visitRuntimeBindings(sourceFile);
  return requiredBindings.flatMap((binding) => {
    const direct = directCounts.get(binding) ?? 0;
    const other = otherCounts.get(binding) ?? 0;
    return direct === 1 && other === 0
      ? []
      : [
          `${filename} must bind ${binding} through one direct unaliased vitest named import and no other runtime bindings; found direct ${direct}, other ${other}`
        ];
  });
}

function registrationTimeoutProblems(
  source: string,
  filename: string,
  suiteTitle: string,
  callee: "beforeAll" | "it",
  title: string | undefined,
  expectedTimeout: string
): string[] {
  const sourceFile = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const bindingProblems = registrationVitestBindingProblems(sourceFile, filename, ["describe", callee]);
  const suites = sourceFile.statements.flatMap((statement) => {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return [];
    const call = statement.expression;
    if (
      !ts.isIdentifier(call.expression) ||
      call.expression.text !== "describe" ||
      stringLiteralValue(call.arguments[0]) !== suiteTitle
    ) {
      return [];
    }
    return [call];
  });
  const suite = suites.length === 1 ? suites[0] : undefined;
  const suiteCallback = suite?.arguments[1];
  if (
    suite === undefined ||
    suite.arguments.length !== 2 ||
    suiteCallback === undefined ||
    !ts.isArrowFunction(suiteCallback) ||
    suiteCallback.parameters.length !== 0 ||
    !ts.isBlock(suiteCallback.body)
  ) {
    return [...bindingProblems, `${filename} must retain one direct top-level suite ${suiteTitle}`];
  }
  const registrations = suiteCallback.body.statements.flatMap((statement, statementIndex) => {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return [];
    const call = statement.expression;
    if (!ts.isIdentifier(call.expression) || call.expression.text !== callee) return [];
    if (title !== undefined && stringLiteralValue(call.arguments[0]) !== title) return [];
    return [{ call, statementIndex }];
  });
  const registrationEntry = registrations.length === 1 ? registrations[0] : undefined;
  const registration = registrationEntry?.call;
  const shadowsTargetCallee = suiteCallback.body.statements.some(
    (statement) => ts.isFunctionDeclaration(statement) && statement.name !== undefined && statement.name.text === callee
  );
  const inertPrefixRegistration = (statement: ts.Statement): boolean => {
    if (ts.isFunctionDeclaration(statement)) return true;
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return false;
    const call = statement.expression;
    if (
      !ts.isIdentifier(call.expression) ||
      call.expression.text !== callee ||
      call.questionDotToken !== undefined ||
      call.typeArguments !== undefined
    ) {
      return false;
    }
    const callbackIndex = callee === "beforeAll" ? 0 : 1;
    const timeoutIndex = callee === "beforeAll" ? 1 : 2;
    const callback = call.arguments[callbackIndex];
    const timeout = call.arguments[timeoutIndex];
    const minimumArgumentCount = callee === "beforeAll" ? 1 : 2;
    return (
      (call.arguments.length === minimumArgumentCount || call.arguments.length === minimumArgumentCount + 1) &&
      (callee === "beforeAll" || stringLiteralValue(call.arguments[0]) !== undefined) &&
      callback !== undefined &&
      ts.isArrowFunction(callback) &&
      callback.parameters.length === 0 &&
      ts.isBlock(callback.body) &&
      (timeout === undefined || ts.isNumericLiteral(timeout))
    );
  };
  const registrationIsReachable =
    registrationEntry !== undefined &&
    !shadowsTargetCallee &&
    suiteCallback.body.statements.slice(0, registrationEntry.statementIndex).every(inertPrefixRegistration);
  const callbackIndex = title === undefined ? 0 : 1;
  const timeoutIndex = title === undefined ? 1 : 2;
  const callback = registration?.arguments[callbackIndex];
  const timeout = registration?.arguments[timeoutIndex];
  const expectedArgumentCount = title === undefined ? 2 : 3;
  const timeouts =
    registration !== undefined &&
    registrationIsReachable &&
    registration.arguments.length === expectedArgumentCount &&
    callback !== undefined &&
    ts.isArrowFunction(callback) &&
    callback.parameters.length === 0 &&
    timeout !== undefined
      ? [timeout.getText(sourceFile)]
      : ["<invalid-registration>"];
  const timeoutProblems = isDeepStrictEqual(timeouts, [expectedTimeout])
    ? []
    : [`${filename} must retain one direct ${callee} registration with timeout ${expectedTimeout}`];
  return [...bindingProblems, ...timeoutProblems];
}

function importClauseHasRuntimeValue(clause: ts.ImportClause | undefined): boolean {
  if (clause === undefined) return true;
  if (clause.isTypeOnly) return false;
  if (clause.name !== undefined) return true;
  if (clause.namedBindings === undefined) return false;
  if (ts.isNamespaceImport(clause.namedBindings)) return true;
  return (
    clause.namedBindings.elements.length === 0 || clause.namedBindings.elements.some((element) => !element.isTypeOnly)
  );
}

function exportDeclarationHasRuntimeValue(declaration: ts.ExportDeclaration): boolean {
  if (declaration.isTypeOnly) return false;
  if (declaration.exportClause === undefined || ts.isNamespaceExport(declaration.exportClause)) return true;
  return (
    declaration.exportClause.elements.length === 0 ||
    declaration.exportClause.elements.some((element) => !element.isTypeOnly)
  );
}

interface RuntimeModuleEdges {
  readonly specifiers: readonly string[];
  readonly problems: readonly string[];
}

function runtimeModuleEdges(filename: string, source: string): RuntimeModuleEdges {
  const scriptKind = filename.endsWith(".mjs") || filename.endsWith(".cjs") ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, scriptKind);
  const specifiers: string[] = [];
  const problems: string[] = [];
  const addLiteral = (expression: ts.Expression | undefined, kind: string): void => {
    const specifier = stringLiteralValue(expression);
    if (specifier === undefined) {
      problems.push(`${filename} uses a nonliteral ${kind} loader`);
    } else {
      specifiers.push(specifier);
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && importClauseHasRuntimeValue(node.importClause)) {
      addLiteral(node.moduleSpecifier, "import");
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      exportDeclarationHasRuntimeValue(node)
    ) {
      addLiteral(node.moduleSpecifier, "export");
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      !node.isTypeOnly &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      addLiteral(node.moduleReference.expression, "import-equals");
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        addLiteral(node.arguments[0], "dynamic import");
      } else if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
        addLiteral(node.arguments[0], "require");
      } else if (
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "module" &&
        node.expression.name.text === "require"
      ) {
        addLiteral(node.arguments[0], "module.require");
      } else if (
        ts.isElementAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "module" &&
        stringLiteralValue(node.expression.argumentExpression) === "require"
      ) {
        addLiteral(node.arguments[0], "module[require]");
      } else if (
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "vi" &&
        VITEST_RUNTIME_LOADERS.has(node.expression.name.text)
      ) {
        addLiteral(node.arguments[0], `vi.${node.expression.name.text}`);
      } else if (
        (ts.isIdentifier(node.expression) && node.expression.text === "createRequire") ||
        (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "createRequire")
      ) {
        problems.push(`${filename} uses createRequire outside the reviewed static import graph`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { specifiers, problems };
}

function isProductionPath(relativePath: string): boolean {
  return (
    relativePath === "src" ||
    relativePath.startsWith("src/") ||
    relativePath === "dist" ||
    relativePath.startsWith("dist/")
  );
}

function resolveClosureTarget(
  importer: string,
  specifier: string,
  sources: ReadonlyMap<string, string>
): { readonly target?: string; readonly problem?: string } {
  if (specifier === "@oomkapwn/enquire-mcp" || specifier.startsWith("@oomkapwn/enquire-mcp/")) {
    return { problem: `${importer} value-imports the enquire-mcp package surface` };
  }
  if (!specifier.startsWith(".")) {
    if (path.posix.isAbsolute(specifier) || specifier.startsWith("file:")) {
      return { problem: `${importer} uses an absolute runtime module specifier ${specifier}` };
    }
    return EXPECTED_COVERAGE_EXTERNAL_MODULES.has(specifier)
      ? {}
      : { problem: `${importer} uses an unreviewed external runtime module ${specifier}` };
  }

  const base = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
  if (base === ".." || base.startsWith("../") || path.posix.isAbsolute(base)) {
    return { problem: `${importer} runtime import escapes the repository: ${specifier}` };
  }
  if (isProductionPath(base)) {
    return { problem: `${importer} value-imports production path ${base}` };
  }
  const extension = path.posix.extname(base);
  const stem = extension === "" ? base : base.slice(0, -extension.length);
  const candidates = [base];
  if (extension === ".js") candidates.push(`${stem}.ts`, `${stem}.tsx`);
  if (extension === ".mjs") candidates.push(`${stem}.mts`);
  if (extension === ".cjs") candidates.push(`${stem}.cts`);
  if (extension === "") {
    candidates.push(`${base}.ts`, `${base}.tsx`, `${base}.mjs`, `${base}.mts`, `${base}/index.ts`);
  }
  const target = candidates.find((candidate) => sources.has(candidate));
  return target === undefined ? { problem: `${importer} has unresolved runtime import ${specifier}` } : { target };
}

interface ResolvedRuntimeModuleEdges {
  readonly targets: readonly string[];
  readonly problems: readonly string[];
}

function resolvedRuntimeModuleEdges(
  filename: string,
  source: string,
  sources: ReadonlyMap<string, string>
): ResolvedRuntimeModuleEdges {
  const edges = runtimeModuleEdges(filename, source);
  const targets: string[] = [];
  const problems = [...edges.problems];
  for (const specifier of edges.specifiers) {
    const resolved = resolveClosureTarget(filename, specifier, sources);
    if (resolved.problem !== undefined) problems.push(resolved.problem);
    if (resolved.target !== undefined) targets.push(resolved.target);
  }
  return { targets, problems };
}

function coverageImportClosureProblems(sources: ReadonlyMap<string, string>): string[] {
  const problems: string[] = [];
  const actualFiles = [...sources.keys()].sort();
  if (!isDeepStrictEqual(actualFiles, [...EXPECTED_COVERAGE_CLOSURE_FILES].sort())) {
    problems.push("coverage-only import closure source census must remain exact");
  }
  const pending: string[] = [...COVERAGE_ONLY_TEST_EXCLUSIONS];
  const visited = new Set<string>();
  for (let index = 0; index < pending.length; index++) {
    const filename = pending[index];
    if (filename === undefined || visited.has(filename)) continue;
    visited.add(filename);
    const source = sources.get(filename);
    if (source === undefined) {
      problems.push(`coverage-only import closure is missing ${filename}`);
      continue;
    }
    const edges = resolvedRuntimeModuleEdges(filename, source, sources);
    problems.push(...edges.problems);
    pending.push(...edges.targets);
  }
  const unreachable = actualFiles.filter((filename) => !visited.has(filename));
  if (unreachable.length > 0) {
    problems.push(`coverage-only import closure has unreachable reviewed files: ${unreachable.join(", ")}`);
  }
  return problems;
}

function requiredClosureSource(sources: ReadonlyMap<string, string>, filename: string): string {
  const source = sources.get(filename);
  if (source === undefined) throw new Error(`missing reviewed closure source ${filename}`);
  return source;
}

function reviewedClosurePathProblem(filename: string, relativeRealpath: string): string | undefined {
  const normalized = relativeRealpath.split(path.sep).join("/");
  return normalized === filename
    ? undefined
    : `reviewed coverage closure path ${filename} resolves to unexpected ${normalized}`;
}

function coverageIsolationProblems(input: CoverageIsolationInputs): string[] {
  return [
    ...packageCoverageProblems(input.packageJson),
    ...ciCoverageProblems(input.ciWorkflow),
    ...vitestCoverageProblems(input.vitestConfig, input.vitestConfigFiles),
    ...registrationTimeoutProblems(
      requiredClosureSource(input.closureSources, "tests/meta-invariant-coverage.test.ts"),
      "tests/meta-invariant-coverage.test.ts",
      "META-invariant: exact structural census + NEGATIVE control coverage",
      "beforeAll",
      undefined,
      "720_000"
    ),
    ...registrationTimeoutProblems(
      requiredClosureSource(input.closureSources, "tests/release-integrity.test.ts"),
      "tests/release-integrity.test.ts",
      "release identity and exact required-job gate",
      "it",
      "keeps release.yml wired to the shared evaluator and an exact mirrored inventory",
      "330_000"
    ),
    ...registrationTimeoutProblems(
      input.k1ClassSource,
      "tests/k1-class-invariant.test.ts",
      "K-1 class invariant (v3.6.3 methodological guard; recursive scan since v3.7.0 M-3)",
      "it",
      "every `new EmbedDb` / `new FtsIndex` in src/ is preceded by discovery or // SAFE BY DESIGN",
      "30_000"
    ),
    ...registrationTimeoutProblems(
      input.releaseMutationTransitionSource,
      "tests/release-mutation-transition.test.ts",
      "release mutation schema-v3 transition authority",
      "it",
      "audits the frozen current matrix through the exact versioned authority",
      "60_000"
    ),
    ...registrationTimeoutProblems(
      input.docsConsistencySource,
      "tests/docs-consistency.test.ts",
      "docs/code consistency — numeric claims (v3.5.1 audit-driven)",
      "it",
      "OIA check count is consistent across oia-walk.mjs, AGENTS.md, ROADMAP.md (rc.22)",
      "60_000"
    ),
    ...coverageImportClosureProblems(input.closureSources)
  ];
}

async function readCoverageIsolationInputs(): Promise<CoverageIsolationInputs> {
  const realRoot = await fs.realpath(repoRoot);
  const closureSources = new Map<string, string>();
  for (const filename of EXPECTED_COVERAGE_CLOSURE_FILES) {
    const candidate = path.join(repoRoot, ...filename.split("/"));
    const realCandidate = await fs.realpath(candidate);
    const relative = path.relative(realRoot, realCandidate);
    if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`reviewed coverage closure path escapes repository: ${filename}`);
    }
    const identityProblem = reviewedClosurePathProblem(filename, relative);
    if (identityProblem !== undefined) throw new Error(identityProblem);
    closureSources.set(filename, await fs.readFile(realCandidate, "utf8"));
  }
  const rootEntries = await fs.readdir(repoRoot);
  const vitestConfigFiles = rootEntries.filter((name) => /^vitest\.(?:config|workspace)\./u.test(name)).sort();
  const [packageJson, ciWorkflow, vitestConfig, docsConsistencySource, k1ClassSource, releaseMutationTransitionSource] =
    await Promise.all([
      fs.readFile(path.join(repoRoot, "package.json"), "utf8"),
      fs.readFile(path.join(repoRoot, ".github", "workflows", "ci.yml"), "utf8"),
      fs.readFile(path.join(repoRoot, "vitest.config.ts"), "utf8"),
      fs.readFile(path.join(repoRoot, "tests", "docs-consistency.test.ts"), "utf8"),
      fs.readFile(path.join(repoRoot, "tests", "k1-class-invariant.test.ts"), "utf8"),
      fs.readFile(path.join(repoRoot, "tests", "release-mutation-transition.test.ts"), "utf8")
    ]);
  return {
    packageJson,
    ciWorkflow,
    vitestConfig,
    vitestConfigFiles,
    docsConsistencySource,
    k1ClassSource,
    releaseMutationTransitionSource,
    closureSources
  };
}

let coverageInputsPromise: Promise<CoverageIsolationInputs> | undefined;

function currentCoverageIsolationInputs(): Promise<CoverageIsolationInputs> {
  if (coverageInputsPromise === undefined) coverageInputsPromise = readCoverageIsolationInputs();
  return coverageInputsPromise;
}

function mutableWorkflow(source: string, mutate: (workflow: UnknownRecord) => void): string {
  const parsed = load(source);
  const clone: unknown = JSON.parse(JSON.stringify(parsed));
  const workflow = asRecord(clone);
  if (workflow === undefined) throw new Error("expected workflow object");
  mutate(workflow);
  return JSON.stringify(workflow);
}

function mutableWorkflowJob(workflow: UnknownRecord, name: string): UnknownRecord {
  const job = asRecord(asRecord(workflow.jobs)?.[name]);
  if (job === undefined) throw new Error(`expected workflow job ${name}`);
  return job;
}

function mutableRunStep(job: UnknownRecord, run: string): UnknownRecord {
  const step = workflowSteps(job)?.find((candidate) => candidate.run === run);
  if (step === undefined) throw new Error(`expected workflow run step ${run}`);
  return step;
}

function mutableUsesStep(job: UnknownRecord, uses: string): UnknownRecord {
  const step = workflowSteps(job)?.find((candidate) => candidate.uses === uses);
  if (step === undefined) throw new Error(`expected workflow action step ${uses}`);
  return step;
}

/** v3.9.0-rc.23 — extracted pure matcher so the invariant has a real inline
 *  NEGATIVE control (it previously had none; flagged by the rc.21 audit). Given
 *  a test file's `relFile` + source text, return the restricted-import
 *  violations it contains. */
function restrictedImportViolations(relFile: string, src: string): string[] {
  const out: string[] = [];
  for (const mod of RESTRICTED_MODULES) {
    // Match: import ... from "../src/MOD.js" or "../src/MOD/index.js"
    // (including type-only imports — those would still break under a refactor
    // that moves the type to a sibling module).
    const importRe = new RegExp(`^\\s*import\\b[^;]*\\bfrom\\s+["']\\.\\./src/${mod}(?:/index)?\\.js["']`, "m");
    if (importRe.test(src)) {
      out.push(`${relFile} imports from src/${mod}.js (restricted — registration boilerplate)`);
    }
  }
  return out;
}

function oiaFocusWiringProblems(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    "scripts/oia-walk.mjs",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS
  );
  const problems: string[] = [];
  const bindingNameContains = (name: ts.BindingName, target: string): boolean => {
    if (ts.isIdentifier(name)) return name.text === target;
    return name.elements.some((element) => ts.isBindingElement(element) && bindingNameContains(element.name, target));
  };
  const isExactImport = (node: ts.Node): node is ts.ImportDeclaration => {
    if (
      !ts.isImportDeclaration(node) ||
      !ts.isStringLiteral(node.moduleSpecifier) ||
      node.moduleSpecifier.text !== "./lib/oia-vitest-focus.mjs"
    ) {
      return false;
    }
    const clause = node.importClause;
    if (
      clause === undefined ||
      clause.isTypeOnly ||
      clause.name !== undefined ||
      clause.namedBindings === undefined ||
      !ts.isNamedImports(clause.namedBindings) ||
      clause.namedBindings.elements.length !== 1
    ) {
      return false;
    }
    const binding = clause.namedBindings.elements[0];
    return (
      binding !== undefined &&
      !binding.isTypeOnly &&
      binding.propertyName === undefined &&
      binding.name.text === "inspectRepositoryVitestFocusControls"
    );
  };
  const exactImports = sourceFile.statements.filter(isExactImport);
  let competingBindings = 0;
  const recordImportBindings = (clause: ts.ImportClause | undefined): void => {
    if (clause === undefined || clause.isTypeOnly) return;
    if (clause.name?.text === "inspectRepositoryVitestFocusControls") competingBindings += 1;
    const bindings = clause.namedBindings;
    if (bindings === undefined) return;
    if (ts.isNamespaceImport(bindings)) {
      if (bindings.name.text === "inspectRepositoryVitestFocusControls") competingBindings += 1;
      return;
    }
    for (const binding of bindings.elements) {
      if (!binding.isTypeOnly && binding.name.text === "inspectRepositoryVitestFocusControls") {
        competingBindings += 1;
      }
    }
  };
  const visitBindings = (node: ts.Node): void => {
    if (isExactImport(node)) return;
    if (ts.isImportDeclaration(node)) {
      recordImportBindings(node.importClause);
      return;
    }
    if (ts.isImportEqualsDeclaration(node)) {
      if (!node.isTypeOnly && node.name.text === "inspectRepositoryVitestFocusControls") competingBindings += 1;
      return;
    }
    if (
      (ts.isVariableDeclaration(node) || ts.isParameter(node)) &&
      bindingNameContains(node.name, "inspectRepositoryVitestFocusControls")
    ) {
      competingBindings += 1;
    } else if (
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isClassDeclaration(node) ||
        ts.isClassExpression(node) ||
        ts.isEnumDeclaration(node)) &&
      node.name?.text === "inspectRepositoryVitestFocusControls"
    ) {
      competingBindings += 1;
    } else if (
      ts.isModuleDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "inspectRepositoryVitestFocusControls"
    ) {
      competingBindings += 1;
    }
    ts.forEachChild(node, visitBindings);
  };
  visitBindings(sourceFile);
  if (exactImports.length !== 1 || competingBindings !== 0) {
    problems.push("OIA must retain one exact independent focus-control analyzer import");
  }

  const calls: ts.CallExpression[] = [];
  const visitCalls = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "inspectRepositoryVitestFocusControls"
    ) {
      calls.push(node);
    }
    ts.forEachChild(node, visitCalls);
  };
  visitCalls(sourceFile);
  const loopEntries = sourceFile.statements.flatMap((statement) => {
    const candidate = ts.isTryStatement(statement) ? statement.tryBlock.statements[0] : undefined;
    if (
      !ts.isTryStatement(statement) ||
      statement.tryBlock.statements.length !== 1 ||
      candidate === undefined ||
      !ts.isForOfStatement(candidate)
    ) {
      return [];
    }
    const loop = candidate;
    const initializer = loop.initializer;
    const declaration =
      ts.isVariableDeclarationList(initializer) && initializer.declarations.length === 1
        ? initializer.declarations[0]
        : undefined;
    if (
      !ts.isVariableDeclarationList(initializer) ||
      (initializer.flags & ts.NodeFlags.Const) === 0 ||
      declaration === undefined ||
      !ts.isIdentifier(declaration.name) ||
      declaration.name.text !== "finding" ||
      declaration.initializer !== undefined
    ) {
      return [];
    }
    return [{ loop, statement }];
  });
  const loopEntry = loopEntries.length === 1 ? loopEntries[0] : undefined;
  const iterable = loopEntry?.loop.expression;
  const analyzerArgument =
    iterable !== undefined && ts.isCallExpression(iterable) && iterable.arguments.length === 1
      ? iterable.arguments[0]
      : undefined;
  const directAnalyzerCall =
    iterable !== undefined &&
    ts.isCallExpression(iterable) &&
    ts.isIdentifier(iterable.expression) &&
    iterable.expression.text === "inspectRepositoryVitestFocusControls" &&
    analyzerArgument !== undefined &&
    ts.isIdentifier(analyzerArgument) &&
    analyzerArgument.text === "repoRoot";
  if (!directAnalyzerCall || calls.length !== 1 || calls[0] !== iterable) {
    problems.push("OIA must retain one exact independent focus-control analyzer call");
  }

  const isFindingProperty = (expression: ts.Expression | undefined, name: string): boolean =>
    expression !== undefined &&
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "finding" &&
    expression.name.text === name;
  const loopBody = loopEntry?.loop.statement;
  const sinkStatement =
    loopBody !== undefined && ts.isBlock(loopBody) && loopBody.statements.length === 1
      ? loopBody.statements[0]
      : undefined;
  const sinkCall =
    sinkStatement !== undefined &&
    ts.isExpressionStatement(sinkStatement) &&
    ts.isCallExpression(sinkStatement.expression)
      ? sinkStatement.expression
      : undefined;
  if (
    sinkCall === undefined ||
    !ts.isIdentifier(sinkCall.expression) ||
    sinkCall.expression.text !== "record" ||
    sinkCall.arguments.length !== 5 ||
    !isFindingProperty(sinkCall.arguments[0], "kind") ||
    !isFindingProperty(sinkCall.arguments[1], "file") ||
    !isFindingProperty(sinkCall.arguments[2], "line") ||
    !isFindingProperty(sinkCall.arguments[3], "evidence") ||
    !isFindingProperty(sinkCall.arguments[4], "hint")
  ) {
    problems.push("OIA focus-control analyzer findings must flow into the exact record sink");
  }

  const focusTry = loopEntry?.statement;
  const catchClause = focusTry?.catchClause;
  const catchStatement =
    catchClause !== undefined && catchClause.block.statements.length === 1
      ? catchClause.block.statements[0]
      : undefined;
  const catchCall =
    catchStatement !== undefined &&
    ts.isExpressionStatement(catchStatement) &&
    ts.isCallExpression(catchStatement.expression)
      ? catchStatement.expression
      : undefined;
  if (
    focusTry === undefined ||
    focusTry.finallyBlock !== undefined ||
    catchClause?.variableDeclaration === undefined ||
    !ts.isIdentifier(catchClause.variableDeclaration.name) ||
    catchClause.variableDeclaration.name.text !== "error" ||
    catchCall === undefined ||
    !ts.isIdentifier(catchCall.expression) ||
    catchCall.expression.text !== "record" ||
    catchCall.arguments.length !== 5 ||
    stringLiteralValue(catchCall.arguments[0]) !== "VITEST-FOCUS-SCAN-ERROR"
  ) {
    problems.push("OIA focus-control analyzer errors must flow into the fail-closed record sink");
  }
  return problems;
}

function oiaMarkedCheckInventoryProblems(source: string): string[] {
  const problems: string[] = [];
  const declarations = [...source.matchAll(/so (\d+) explicitly/gmu)].map((match) => Number(match[1]));
  const markerIds = [...source.matchAll(/^\/\/ ─── Check (\d+[a-z]?):/gmu)].map((match) => match[1]);
  const proseIds = [...source.matchAll(/^\/\/ {3}(\d+[a-z]?)\.\s/gmu)].map((match) => match[1]);
  if (declarations.length !== 1 || declarations[0] !== markerIds.length) {
    problems.push("OIA declared marked-check count must equal the executable marker census");
  }
  if (!isDeepStrictEqual(proseIds, markerIds)) {
    problems.push("OIA prose check inventory must match executable marker IDs and order");
  }
  return problems;
}

describe("Class A invariant — no test imports value from registration boilerplate", () => {
  it("keeps test imports and the exact coverage-only isolation boundary closed", async () => {
    const testFiles = await collectTestFiles(path.join(repoRoot, "tests"));
    const violations: string[] = [];
    for (const file of testFiles) {
      const src = await fs.readFile(file, "utf8");
      violations.push(...restrictedImportViolations(path.relative(repoRoot, file), src));
    }
    expect(violations, "Test files must not import values from registration-boilerplate modules").toEqual([]);
    expect(
      coverageIsolationProblems(await currentCoverageIsolationInputs()),
      "Coverage isolation must remain exact, prerequisite-bound and production-import-free"
    ).toEqual([]);
    const focusSourceFiles = firstPartyVitestFocusSourceFiles(repoRoot);
    expect(focusSourceFiles).toEqual(await independentExecutableSourceCensus(repoRoot));
    expect(focusSourceFiles).toContain("site/site.js");
    expect(focusSourceFiles).toContain("tests/fixtures/k1-invariant/good.ts");
    expect(inspectRepositoryVitestFocusControls(repoRoot), "OIA focus-control source census must stay clean").toEqual(
      []
    );
    const oiaSource = await fs.readFile(path.join(repoRoot, "scripts/oia-walk.mjs"), "utf8");
    expect(oiaFocusWiringProblems(oiaSource)).toEqual([]);
    expect(oiaMarkedCheckInventoryProblems(oiaSource)).toEqual([]);
  });

  it("NEGATIVE control: restricted imports and coverage isolation drift are rejected", async () => {
    // Drift the input on purpose — a synthetic test importing from a restricted
    // module MUST be flagged; an allowed barrel/infra import MUST NOT be.
    const bad = `import { buildMcpServer } from "../src/server.js";\nimport { x } from "../src/tool-registry.js";`;
    const flagged = restrictedImportViolations("tests/synthetic.test.ts", bad);
    expect(flagged.length).toBe(2);
    expect(flagged.join(" ")).toMatch(/server\.js.*restricted|restricted.*server\.js/);
    const good = `import { searchHybrid } from "../src/tools/index.js";\nimport { Vault } from "../src/vault.js";`;
    expect(restrictedImportViolations("tests/synthetic.test.ts", good)).toEqual([]);

    const findingKindsAndLines = (source: string, filename = "tests/synthetic-focus.test.ts") =>
      inspectStaticVitestFocusControls(source, filename).map(({ kind, line }) => [kind, line]);
    const combinedFocusBypass = [
      'import { it, vi } from "vitest";',
      "vi.setConfig({ allowOnly: true });",
      'it.only("passing decoy", () => {});'
    ].join("\n");
    expect(findingKindsAndLines(combinedFocusBypass)).toEqual([
      ["VITEST-ALLOW-ONLY", 2],
      ["VITEST-RUNTIME-CONFIG", 2],
      ["VITEST-FOCUS-ONLY", 3]
    ]);
    expect(findingKindsAndLines('it.only("passing decoy", () => {});')).toEqual([["VITEST-FOCUS-ONLY", 1]]);
    expect(findingKindsAndLines("vi.setConfig({ allowOnly: true });")).toEqual([
      ["VITEST-ALLOW-ONLY", 1],
      ["VITEST-RUNTIME-CONFIG", 1]
    ]);
    expect(
      findingKindsAndLines('registrar?.["only"]("decoy", () => {}); runtime?.["setConfig"]({ ["allowOnly"]: true });')
    ).toEqual([
      ["VITEST-ALLOW-ONLY", 1],
      ["VITEST-FOCUS-ONLY", 1],
      ["VITEST-RUNTIME-CONFIG", 1]
    ]);

    const literalTemplateEvasion = [
      "const focusKey = `on$" + '{"ly"}`;',
      "const configKey = `set$" + '{"Config"}`;',
      "const optionKey = `allow$" + '{"Only"}`;',
      'registrar?.[focusKey]("passing decoy", () => {});',
      "runtime[configKey]({ [optionKey]: true });"
    ].join("\n");
    expect(findingKindsAndLines(literalTemplateEvasion)).toEqual([
      ["VITEST-FOCUS-ONLY", 1],
      ["VITEST-RUNTIME-CONFIG", 2],
      ["VITEST-ALLOW-ONLY", 3]
    ]);
    const concatenatedStaticEvasion =
      'it["on" + "ly"]("decoy", () => {}); vi["set" + "Config"]({ ["allow" + "Only"]: true });';
    expect(findingKindsAndLines(concatenatedStaticEvasion)).toEqual([
      ["VITEST-ALLOW-ONLY", 1],
      ["VITEST-FOCUS-ONLY", 1],
      ["VITEST-RUNTIME-CONFIG", 1]
    ]);
    const memoizedStaticEvasion = `const focusKey = ${Array.from({ length: 128 }, () => '""').join(" + ")} + "on" + "ly";`;
    expect(findingKindsAndLines(memoizedStaticEvasion)).toEqual([["VITEST-FOCUS-ONLY", 1]]);
    expect(findingKindsAndLines('const inertKey = "0123456789" + "on" + "ly";')).toEqual([]);
    expect(findingKindsAndLines('const mixedKey = "0123456789" + "only";')).toEqual([["VITEST-FOCUS-ONLY", 1]]);
    const inertOverlengthTemplate = "const inertTemplate = `0123456789$" + '{"on"}$' + '{"ly"}`;';
    expect(findingKindsAndLines(inertOverlengthTemplate)).toEqual([]);
    const mixedOverlengthTemplate = "const mixedTemplate = `0123456789$" + '{"only"}`;';
    expect(findingKindsAndLines(mixedOverlengthTemplate)).toEqual([["VITEST-FOCUS-ONLY", 1]]);

    const crossFileStaticKeyExports = [
      'export const focusKey = "only";',
      'export const configKey = "setConfig";',
      'export const optionKey = "allowOnly";'
    ].join("\n");
    expect(findingKindsAndLines(crossFileStaticKeyExports, "tests/focus-keys.ts")).toEqual([
      ["VITEST-FOCUS-ONLY", 1],
      ["VITEST-RUNTIME-CONFIG", 2],
      ["VITEST-ALLOW-ONLY", 3]
    ]);
    const runtimeImportCarriers =
      'import { focused as only, configure as setConfig, enabled as allowOnly } from "./adapter.js";';
    expect(findingKindsAndLines(runtimeImportCarriers)).toEqual([
      ["VITEST-ALLOW-ONLY", 1],
      ["VITEST-FOCUS-ONLY", 1],
      ["VITEST-RUNTIME-CONFIG", 1]
    ]);
    const runtimeImportAttributeCarriers =
      'import Adapter from "./adapter.json" with { only: "allowOnly", setConfig: "json" }; void Adapter;';
    expect(findingKindsAndLines(runtimeImportAttributeCarriers)).toEqual([
      ["VITEST-ALLOW-ONLY", 1],
      ["VITEST-FOCUS-ONLY", 1],
      ["VITEST-RUNTIME-CONFIG", 1]
    ]);
    const runtimeExportCarriers = [
      "export const allowOnly = true;",
      "export { focused as only, configure as setConfig };"
    ].join("\n");
    expect(findingKindsAndLines(runtimeExportCarriers)).toEqual([
      ["VITEST-ALLOW-ONLY", 1],
      ["VITEST-FOCUS-ONLY", 2],
      ["VITEST-RUNTIME-CONFIG", 2]
    ]);
    const runtimeClassCarriers = "class Adapter { only = focused; setConfig = configure; allowOnly = true; }";
    expect(findingKindsAndLines(runtimeClassCarriers)).toEqual([
      ["VITEST-ALLOW-ONLY", 1],
      ["VITEST-FOCUS-ONLY", 1],
      ["VITEST-RUNTIME-CONFIG", 1]
    ]);
    const runtimeParameterPropertyCarriers =
      "class Adapter { constructor(public only = focused, public setConfig = configure, public allowOnly = true) {} }";
    expect(findingKindsAndLines(runtimeParameterPropertyCarriers)).toEqual([
      ["VITEST-ALLOW-ONLY", 1],
      ["VITEST-FOCUS-ONLY", 1],
      ["VITEST-RUNTIME-CONFIG", 1]
    ]);
    const runtimeJsxCarriers = "const view = <Focus only allowOnly setConfig />; void view;";
    expect(findingKindsAndLines(runtimeJsxCarriers, "tests/focus-carriers.tsx")).toEqual([
      ["VITEST-ALLOW-ONLY", 1],
      ["VITEST-FOCUS-ONLY", 1],
      ["VITEST-RUNTIME-CONFIG", 1]
    ]);
    const runtimeJsxTextCarriers =
      "const view = <Keys><Key>only</Key><Key>allowOnly</Key><Key>setConfig</Key></Keys>; void view;";
    expect(findingKindsAndLines(runtimeJsxTextCarriers, "tests/focus-text.tsx")).toEqual([
      ["VITEST-ALLOW-ONLY", 1],
      ["VITEST-FOCUS-ONLY", 1],
      ["VITEST-RUNTIME-CONFIG", 1]
    ]);
    const multilineJsxTextCarriers = [
      "const view = <Keys>",
      "  <Key>",
      "    only",
      "  </Key>",
      "  <Key>",
      "    allowOnly",
      "  </Key>",
      "  <Key>",
      "    setConfig",
      "  </Key>",
      "</Keys>; void view;"
    ].join("\n");
    expect(findingKindsAndLines(multilineJsxTextCarriers, "tests/focus-multiline.tsx")).toEqual([
      ["VITEST-FOCUS-ONLY", 3],
      ["VITEST-ALLOW-ONLY", 6],
      ["VITEST-RUNTIME-CONFIG", 9]
    ]);
    const entityJsxTextCarriers = [
      "const view = <Keys>",
      "  <Key>on&#108;y</Key>",
      "  <Key>allow&#x4f;nly</Key>",
      "  <Key>set&#67;onfig</Key>",
      "</Keys>; void view;"
    ].join("\n");
    expect(findingKindsAndLines(entityJsxTextCarriers, "tests/focus-entities.tsx")).toEqual([
      ["VITEST-FOCUS-ONLY", 2],
      ["VITEST-ALLOW-ONLY", 3],
      ["VITEST-RUNTIME-CONFIG", 4]
    ]);
    const entityJsxAttributeCarriers =
      'const view = <Keys focus="&#111;nly" option="allow&#x4f;nly" config="set&#x43;onfig" />; void view;';
    expect(findingKindsAndLines(entityJsxAttributeCarriers, "tests/focus-attributes.tsx")).toEqual([
      ["VITEST-ALLOW-ONLY", 1],
      ["VITEST-FOCUS-ONLY", 1],
      ["VITEST-RUNTIME-CONFIG", 1]
    ]);
    const unicodeLineBreakJsx = "const view = <Key>\u2028\t only \u2029</Key>; void view;";
    const unicodeLineBreakFindings = inspectStaticVitestFocusControls(
      unicodeLineBreakJsx,
      "tests/focus-unicode-lines.tsx"
    );
    expect(unicodeLineBreakFindings.map(({ kind, line }) => [kind, line])).toEqual([["VITEST-FOCUS-ONLY", 2]]);
    expect(unicodeLineBreakFindings[0]?.evidence).toBe(["on", "ly"].join(""));
    const extendedWhitespaceJsx = [
      "const view = <Key>",
      "\t\v\f\u0085\u00a0\u1680\u200b only \t\v\f\u0085\u00a0\u1680\u200b",
      "</Key>; void view;"
    ].join("\n");
    expect(findingKindsAndLines(extendedWhitespaceJsx, "tests/focus-whitespace.tsx")).toEqual([
      ["VITEST-FOCUS-ONLY", 2]
    ]);
    expect(findingKindsAndLines("const view = <Key> only </Key>; void view;", "tests/inert-text.tsx")).toEqual([]);
    expect(findingKindsAndLines("const view = <Key> only\n</Key>; void view;", "tests/inert-leading-text.tsx")).toEqual(
      []
    );
    expect(
      findingKindsAndLines("const view = <Key>\nonly </Key>; void view;", "tests/inert-trailing-text.tsx")
    ).toEqual([]);
    const inertJsxEntities =
      "const view = <Keys><Key>&nbsp;only</Key><Key>&#X6f;nly</Key><Key>&unknown;only</Key></Keys>;";
    expect(findingKindsAndLines(inertJsxEntities, "tests/inert-entities.tsx")).toEqual([]);
    const inertJsxAttributeEntities = 'const view = <Keys first="&#32;only" second="&nbsp;only" third="&#X6f;nly" />;';
    expect(findingKindsAndLines(inertJsxAttributeEntities, "tests/inert-attribute-entities.tsx")).toEqual([]);
    const decoratedDeclareFieldBypass =
      'class FocusDecoy { @observe(vi.setConfig({ allowOnly: true }), it.only("decoy", () => {})) declare field: string; }';
    expect(findingKindsAndLines(decoratedDeclareFieldBypass)).toEqual([
      ["VITEST-ALLOW-ONLY", 1],
      ["VITEST-FOCUS-ONLY", 1],
      ["VITEST-RUNTIME-CONFIG", 1]
    ]);
    const runtimeClassExtendsBypass =
      'class FocusDecoy extends (vi.setConfig({ allowOnly: true }), it.only("passing decoy", () => {}), class {}) {}';
    expect(findingKindsAndLines(runtimeClassExtendsBypass)).toEqual([
      ["VITEST-ALLOW-ONLY", 1],
      ["VITEST-FOCUS-ONLY", 1],
      ["VITEST-RUNTIME-CONFIG", 1]
    ]);
    const runtimeInstantiationCarriers = [
      "const focus = (it as unknown as { only<T>(): void }).only<void>;",
      "const configure = (vi as unknown as { setConfig<T>(): void }).setConfig<void>;",
      "const option = (config as unknown as { allowOnly<T>(): void }).allowOnly<void>;",
      "focus(); configure(); option();"
    ].join("\n");
    expect(findingKindsAndLines(runtimeInstantiationCarriers)).toEqual([
      ["VITEST-FOCUS-ONLY", 1],
      ["VITEST-RUNTIME-CONFIG", 2],
      ["VITEST-ALLOW-ONLY", 3]
    ]);
    const inertInstantiationTypes = [
      "type only = unknown;",
      "const typed = adapter<only>;",
      "class Derived extends Adapter<only> {}",
      "class Implemented implements Adapter<only> {}",
      "interface Extended extends Adapter<only> {}",
      "void typed;"
    ].join("\n");
    expect(findingKindsAndLines(inertInstantiationTypes)).toEqual([]);
    const staticContainerEvasion =
      'const keys = { focus: "only", config: "setConfig", option: "allowOnly" } as const; ' +
      'vi[keys.config]({ [keys.option]: true }); it[keys.focus]("decoy", () => {});';
    expect(findingKindsAndLines(staticContainerEvasion)).toEqual([
      ["VITEST-ALLOW-ONLY", 1],
      ["VITEST-FOCUS-ONLY", 1],
      ["VITEST-RUNTIME-CONFIG", 1]
    ]);
    const reservedObjectKeys =
      "const adapter = { only: focused, setConfig: configure, allowOnly: true }; void adapter;";
    expect(findingKindsAndLines(reservedObjectKeys)).toEqual([
      ["VITEST-ALLOW-ONLY", 1],
      ["VITEST-FOCUS-ONLY", 1],
      ["VITEST-RUNTIME-CONFIG", 1]
    ]);
    const concatenatedContainerEvasion =
      'const keys = { focus: "on" + "ly", config: "set" + "Config", option: "allow" + "Only" } as const; ' +
      'vi[keys.config]({ [keys.option]: true }); it[keys.focus]("decoy", () => {});';
    expect(findingKindsAndLines(concatenatedContainerEvasion)).toEqual([
      ["VITEST-ALLOW-ONLY", 1],
      ["VITEST-FOCUS-ONLY", 1],
      ["VITEST-RUNTIME-CONFIG", 1]
    ]);

    const aliasAndReflectionEvasion = [
      "const { only: focused } = registrar;",
      "const { setConfig: configure } = runtime;",
      'Reflect.set(config, "allowOnly", true);',
      "void focused;",
      "void configure;"
    ].join("\n");
    expect(findingKindsAndLines(aliasAndReflectionEvasion)).toEqual([
      ["VITEST-FOCUS-ONLY", 1],
      ["VITEST-RUNTIME-CONFIG", 2],
      ["VITEST-ALLOW-ONLY", 3]
    ]);
    expect(
      findingKindsAndLines(
        "let focused; let configure; let option; " +
          "({ only: focused, setConfig: configure, allowOnly: option } = runtime);"
      )
    ).toEqual([
      ["VITEST-ALLOW-ONLY", 1],
      ["VITEST-FOCUS-ONLY", 1],
      ["VITEST-RUNTIME-CONFIG", 1]
    ]);
    const aliasedReflectionEvasion = [
      "const get = Reflect.get;",
      'const set = globalThis.Reflect["set"];',
      'set(config, "allowOnly", true);',
      'get(runtime, "setConfig")(config);',
      'get(registrar, "only")("passing decoy", () => {});'
    ].join("\n");
    expect(findingKindsAndLines(aliasedReflectionEvasion)).toEqual([
      ["VITEST-ALLOW-ONLY", 3],
      ["VITEST-RUNTIME-CONFIG", 4],
      ["VITEST-FOCUS-ONLY", 5]
    ]);
    expect(findingKindsAndLines('it("passing decoy", { only: true }, () => {});')).toEqual([["VITEST-FOCUS-ONLY", 1]]);
    expect(findingKindsAndLines('describe("passing decoy", { ["only"]: true }, () => {});')).toEqual([
      ["VITEST-FOCUS-ONLY", 1]
    ]);
    expect(
      findingKindsAndLines(
        'const view = <button onClick={() => it?.["only"]("decoy", () => {})} />; void view;',
        "tests/synthetic-focus.tsx"
      )
    ).toEqual([["VITEST-FOCUS-ONLY", 1]]);

    const inertFocusText = [
      "// vi.setConfig({ allowOnly: true }); it.only is documentation",
      'const documentation = "vi.setConfig({ allowOnly: true }); it.only";',
      "type FocusShape = { only: true; allowOnly: true; setConfig(): void };",
      'import type { Config as setConfig } from "vitest";',
      'export type { Config as allowOnly } from "vitest";',
      'import type only = require("./focus-types.js");',
      'import Adapter from "only"; export { Adapter } from "setConfig";',
      "function identity<only>(value: only): only { return value; }",
      "abstract class AbstractOptions { abstract allowOnly: boolean; }",
      "class IndexedShape { [only: string]: unknown }",
      "interface TypeLineage extends only, setConfig, allowOnly {}",
      "class ImplementedShape implements only, setConfig, allowOnly {}",
      "function overload(only: string): void; function overload(value: string): void {}",
      "class Overloaded { constructor(allowOnly: string); constructor(value: string) {} }",
      "class DeclaredFields { declare only: true; declare allowOnly: true; declare setConfig: () => void; }",
      "declare class TypeOnlyAdapter { only: true; setConfig(): void; allowOnly: true }",
      'log("mode=only"); expect(mode).toBe("setConfig documentation"); it("allowOnly example", () => {});',
      'it("ordinary test", () => {});'
    ].join("\n");
    expect(findingKindsAndLines(inertFocusText)).toEqual([]);
    expect(findingKindsAndLines("export const only: true;", "types/focus-controls.d.ts")).toEqual([]);
    expect(inspectStaticVitestFocusControls("const broken = ;", "types/malformed.d.ts")).toEqual([]);
    expect(() => inspectStaticVitestFocusControls("const broken = ;", "tests/fixtures/malformed-source.ts")).toThrow(
      /focus-control parse failure in tests\/fixtures\/malformed-source\.ts:1:\d+: TS\d+: .+/u
    );
    expect(findingKindsAndLines('void import("only"); require("setConfig");')).toEqual([
      ["VITEST-FOCUS-ONLY", 1],
      ["VITEST-RUNTIME-CONFIG", 1]
    ]);
    const reservedTokenBoundary = [
      'const mode = "only";',
      'function format(mode = "setConfig"): string { return mode; }',
      'translate(label, "allowOnly");'
    ].join("\n");
    expect(findingKindsAndLines(reservedTokenBoundary)).toEqual([
      ["VITEST-FOCUS-ONLY", 1],
      ["VITEST-RUNTIME-CONFIG", 2],
      ["VITEST-ALLOW-ONLY", 3]
    ]);
    const symlinkScratch = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-focus-census-"));
    try {
      const realDirectory = path.join(symlinkScratch, "real");
      await fs.mkdir(realDirectory);
      await fs.symlink(
        realDirectory,
        path.join(symlinkScratch, "linked"),
        process.platform === "win32" ? "junction" : "dir"
      );
      expect(() => firstPartyVitestFocusSourceFiles(symlinkScratch)).toThrow(
        "focus-control source census refuses symbolic link linked"
      );
    } finally {
      await fs.rm(symlinkScratch, { recursive: true, force: true });
    }

    const parseScratch = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-focus-parse-"));
    try {
      const fixtureDirectory = path.join(parseScratch, "tests", "fixtures");
      await fs.mkdir(fixtureDirectory, { recursive: true });
      await fs.writeFile(path.join(fixtureDirectory, "valid.ts"), "export const value = 1;\n");
      expect(inspectRepositoryVitestFocusControls(parseScratch)).toEqual([]);
      await fs.writeFile(path.join(fixtureDirectory, "malformed.ts"), "const broken = ;\n");
      expect(() => inspectRepositoryVitestFocusControls(parseScratch)).toThrow(
        /focus-control parse failure in tests\/fixtures\/malformed\.ts:1:\d+: TS\d+: .+/u
      );
    } finally {
      await fs.rm(parseScratch, { recursive: true, force: true });
    }

    const currentOiaSource = await fs.readFile(path.join(repoRoot, "scripts/oia-walk.mjs"), "utf8");
    const oiaWithoutFocusCall = replaceExactly(
      currentOiaSource,
      OIA_FOCUS_CALL,
      "for (const finding of inspectRepositoryVitestFocusControlsSkipped(repoRoot))"
    );
    expect(oiaFocusWiringProblems(oiaWithoutFocusCall)).toContain(
      "OIA must retain one exact independent focus-control analyzer call"
    );
    const oiaWithoutFindingSink = replaceExactly(
      currentOiaSource,
      "    record(finding.kind, finding.file, finding.line, finding.evidence, finding.hint);",
      "    void finding;"
    );
    expect(oiaFocusWiringProblems(oiaWithoutFindingSink)).toContain(
      "OIA focus-control analyzer findings must flow into the exact record sink"
    );
    const oiaWithFailOpenCatch = replaceExactly(
      currentOiaSource,
      '    "VITEST-FOCUS-SCAN-ERROR",',
      '    "VITEST-FOCUS-SCAN-IGNORED",'
    );
    expect(oiaFocusWiringProblems(oiaWithFailOpenCatch)).toContain(
      "OIA focus-control analyzer errors must flow into the fail-closed record sink"
    );
    const commentAndStringDecoys = [
      `// ${OIA_FOCUS_IMPORT}`,
      `const focusCallDocumentation = ${JSON.stringify(OIA_FOCUS_CALL)};`
    ].join("\n");
    expect(oiaFocusWiringProblems(commentAndStringDecoys)).toEqual(
      expect.arrayContaining([
        "OIA must retain one exact independent focus-control analyzer import",
        "OIA must retain one exact independent focus-control analyzer call"
      ])
    );
    const declaredMarkedCount = /so (\d+) explicitly/u.exec(currentOiaSource)?.[1];
    if (declaredMarkedCount === undefined) throw new Error("expected OIA marked-check count declaration");
    const staleMarkedCount = replaceExactly(
      currentOiaSource,
      `so ${declaredMarkedCount} explicitly`,
      `so ${Number(declaredMarkedCount) - 1} explicitly`
    );
    expect(oiaMarkedCheckInventoryProblems(staleMarkedCount)).toContain(
      "OIA declared marked-check count must equal the executable marker census"
    );
    const missingProseInventoryEntry = replaceExactly(
      currentOiaSource,
      "//   11b. NPM RC DRIFT — npm `@rc` must not trail the current main RC line.\n",
      ""
    );
    expect(oiaMarkedCheckInventoryProblems(missingProseInventoryEntry)).toContain(
      "OIA prose check inventory must match executable marker IDs and order"
    );

    const current = await currentCoverageIsolationInputs();
    const currentVitestProblems = (source: string): string[] =>
      vitestCoverageProblems(source, current.vitestConfigFiles);
    const exactCoverageEntry = `"test:coverage": "${EXPECTED_COVERAGE_SCRIPT}"`;
    const packageWithThirdExclusion = replaceExactly(
      current.packageJson,
      exactCoverageEntry,
      `"test:coverage": "${EXPECTED_COVERAGE_SCRIPT} --exclude tests/other.test.ts"`
    );
    expect(packageCoverageProblems(packageWithThirdExclusion)).toContain(
      "package scripts.test:coverage must retain the exact two-file coverage-only exclusion"
    );
    const packageWithDisabledOia = replaceExactly(
      current.packageJson,
      `"check:oia": "${EXPECTED_OIA_SCRIPT}"`,
      '"check:oia": "true"'
    );
    expect(packageCoverageProblems(packageWithDisabledOia)).toContain(
      "package scripts.check:oia must retain the exact independent Node entrypoint"
    );
    for (const lifecycle of FORBIDDEN_OIA_LIFECYCLE_SCRIPTS) {
      const packageWithOiaLifecycleHook = replaceExactly(
        current.packageJson,
        `"check:oia": "${EXPECTED_OIA_SCRIPT}",`,
        `"${lifecycle}": "true",\n    "check:oia": "${EXPECTED_OIA_SCRIPT}",`
      );
      expect(packageCoverageProblems(packageWithOiaLifecycleHook)).toContain(
        "package check:oia lifecycle hooks must remain absent"
      );
    }
    for (const lifecycle of FORBIDDEN_TEST_LIFECYCLE_SCRIPTS) {
      const packageWithLifecycleHook = replaceExactly(
        current.packageJson,
        '    "test": "vitest run",',
        `    "${lifecycle}": "printf fail-open",\n    "test": "vitest run",`
      );
      expect(packageCoverageProblems(packageWithLifecycleHook)).toContain(
        "package test lifecycle hooks must remain absent"
      );
    }
    const packageWithWildcard = replaceExactly(
      current.packageJson,
      exactCoverageEntry,
      '"test:coverage": "vitest run --coverage --exclude tests/*invariant*.test.ts"'
    );
    expect(packageCoverageProblems(packageWithWildcard)).toContain(
      "package scripts.test:coverage must retain the exact two-file coverage-only exclusion"
    );
    const packageWithMissingExclusion = replaceExactly(
      current.packageJson,
      exactCoverageEntry,
      '"test:coverage": "vitest run --coverage --exclude tests/meta-invariant-coverage.test.ts"'
    );
    expect(packageCoverageProblems(packageWithMissingExclusion)).toContain(
      "package scripts.test:coverage must retain the exact two-file coverage-only exclusion"
    );
    const packageWithFilteredTest = replaceExactly(
      current.packageJson,
      '"test": "vitest run"',
      '"test": "vitest run tests/unit.test.ts"'
    );
    expect(packageCoverageProblems(packageWithFilteredTest)).toContain(
      "package scripts.test must remain the exact unfiltered vitest run"
    );
    const packageWithCoverageBeforeTest = replaceExactly(
      current.packageJson,
      "npm test && node scripts/check-version-consistency.mjs && node scripts/check-audit.mjs && " +
        "npm run test:coverage --silent",
      "npm run test:coverage --silent && node scripts/check-version-consistency.mjs && " +
        "node scripts/check-audit.mjs && npm test"
    );
    expect(packageCoverageProblems(packageWithCoverageBeforeTest)).toContain(
      "prepublishOnly must run the unfiltered suite before coverage isolation"
    );
    const packageWithInsertedPrepublishStage = replaceExactly(
      current.packageJson,
      "node scripts/check-audit.mjs && npm run test:coverage --silent",
      "node scripts/check-audit.mjs && printf fail-open && npm run test:coverage --silent"
    );
    expect(packageCoverageProblems(packageWithInsertedPrepublishStage)).toContain(
      "prepublishOnly must retain the exact reviewed gate sequence"
    );
    const packageWithFailOpenTest = replaceExactly(
      current.packageJson,
      "npm test && node scripts/check-version-consistency.mjs",
      "npm test || true && node scripts/check-version-consistency.mjs"
    );
    expect(packageCoverageProblems(packageWithFailOpenTest)).toContain(
      "prepublishOnly must retain one exact unfiltered npm test stage"
    );

    const ciWithFilteredTest = mutableWorkflow(current.ciWorkflow, (workflow) => {
      mutableRunStep(mutableWorkflowJob(workflow, "test"), "npm test").run =
        "npm test -- tests/no-internal-imports.test.ts";
    });
    expect(ciCoverageProblems(ciWithFilteredTest)).toContain(
      "each CI Node leg must end with one exact unfiltered fail-capable npm test"
    );
    const ciWithInsertedTestStep = mutableWorkflow(current.ciWorkflow, (workflow) => {
      const steps = workflowSteps(mutableWorkflowJob(workflow, "test"));
      if (steps === undefined) throw new Error("expected test steps");
      steps.splice(2, 0, { run: "true" });
    });
    expect(ciCoverageProblems(ciWithInsertedTestStep)).toContain(
      "CI test matrix must retain the exact reviewed step sequence"
    );
    const ciWithMutatedInstallStep = mutableWorkflow(current.ciWorkflow, (workflow) => {
      const steps = workflowSteps(mutableWorkflowJob(workflow, "test"));
      const install = steps?.[3];
      if (install === undefined) throw new Error("expected test install step");
      install.run = "true";
    });
    expect(ciCoverageProblems(ciWithMutatedInstallStep)).toContain(
      "CI test matrix must retain the exact reviewed step sequence"
    );
    const ciWithoutNode24 = mutableWorkflow(current.ciWorkflow, (workflow) => {
      const testJob = mutableWorkflowJob(workflow, "test");
      const include = asRecord(asRecord(testJob.strategy)?.matrix)?.include;
      if (!Array.isArray(include)) throw new Error("expected test matrix include");
      include.pop();
    });
    expect(ciCoverageProblems(ciWithoutNode24)).toContain(
      "CI test matrix must retain exact unfiltered Node 22.13 and Node 24 legs"
    );
    const ciWithMatrixExclude = mutableWorkflow(current.ciWorkflow, (workflow) => {
      const testJob = mutableWorkflowJob(workflow, "test");
      const matrix = asRecord(asRecord(testJob.strategy)?.matrix);
      if (matrix === undefined) throw new Error("expected test matrix");
      matrix.exclude = [{ label: "22" }];
    });
    expect(ciCoverageProblems(ciWithMatrixExclude)).toContain(
      "CI test matrix must retain exact unfiltered Node 22.13 and Node 24 legs"
    );
    const ciWithHardcodedTestNode = mutableWorkflow(current.ciWorkflow, (workflow) => {
      const setup = mutableUsesStep(mutableWorkflowJob(workflow, "test"), EXPECTED_SETUP_NODE_ACTION);
      const setupWith = asRecord(setup.with);
      if (setupWith === undefined) throw new Error("expected test setup-node inputs");
      setupWith["node-version"] = "22";
    });
    expect(ciCoverageProblems(ciWithHardcodedTestNode)).toContain(
      "CI test matrix must bind the exact pinned setup-node step to each matrix runtime"
    );
    const ciWithCheckoutRef = mutableWorkflow(current.ciWorkflow, (workflow) => {
      mutableUsesStep(mutableWorkflowJob(workflow, "test"), EXPECTED_CHECKOUT_ACTION).with = { ref: "main" };
    });
    expect(ciCoverageProblems(ciWithCheckoutRef)).toContain(
      "CI test matrix must begin with the exact pinned checkout step"
    );
    const ciWithoutCoverageNeed = mutableWorkflow(current.ciWorkflow, (workflow) => {
      mutableWorkflowJob(workflow, "coverage").needs = "lint";
    });
    expect(ciCoverageProblems(ciWithoutCoverageNeed)).toContain(
      "CI coverage must retain its exact prerequisite-bound 10-minute job boundary"
    );
    const ciWithFailOpenTest = mutableWorkflow(current.ciWorkflow, (workflow) => {
      mutableWorkflowJob(workflow, "test")["continue-on-error"] = true;
    });
    expect(ciCoverageProblems(ciWithFailOpenTest)).toContain(
      "CI test matrix must retain its exact fail-capable job boundary"
    );
    const ciWithStaleTestBreaker = mutableWorkflow(current.ciWorkflow, (workflow) => {
      mutableWorkflowJob(workflow, "test")["timeout-minutes"] = 10;
    });
    expect(ciCoverageProblems(ciWithStaleTestBreaker)).toContain(
      "CI test matrix must retain its exact fail-capable job boundary"
    );
    const ciWithRaisedTestBreaker = mutableWorkflow(current.ciWorkflow, (workflow) => {
      mutableWorkflowJob(workflow, "test")["timeout-minutes"] = 21;
    });
    expect(ciCoverageProblems(ciWithRaisedTestBreaker)).toContain(
      "CI test matrix must retain its exact fail-capable job boundary"
    );
    const ciWithStaleMacosBreaker = mutableWorkflow(current.ciWorkflow, (workflow) => {
      mutableWorkflowJob(workflow, "test-macos")["timeout-minutes"] = 15;
    });
    expect(ciCoverageProblems(ciWithStaleMacosBreaker)).toContain(
      "CI macOS full suite must retain its exact advisory 20-minute job boundary"
    );
    const ciWithRaisedMacosBreaker = mutableWorkflow(current.ciWorkflow, (workflow) => {
      mutableWorkflowJob(workflow, "test-macos")["timeout-minutes"] = 21;
    });
    expect(ciCoverageProblems(ciWithRaisedMacosBreaker)).toContain(
      "CI macOS full suite must retain its exact advisory 20-minute job boundary"
    );
    const ciWithNoopTestShell = mutableWorkflow(current.ciWorkflow, (workflow) => {
      mutableRunStep(mutableWorkflowJob(workflow, "test"), "npm test").shell = "echo {0}";
    });
    expect(ciCoverageProblems(ciWithNoopTestShell)).toContain(
      "each CI Node leg must end with one exact unfiltered fail-capable npm test"
    );
    const ciWithRootDefaults = mutableWorkflow(current.ciWorkflow, (workflow) => {
      workflow.defaults = { run: { "working-directory": "/tmp" } };
    });
    expect(ciCoverageProblems(ciWithRootDefaults)).toContain(
      "CI root may not override the test or coverage execution environment"
    );
    const ciWithRaisedBreaker = mutableWorkflow(current.ciWorkflow, (workflow) => {
      mutableWorkflowJob(workflow, "coverage")["timeout-minutes"] = 11;
    });
    expect(ciCoverageProblems(ciWithRaisedBreaker)).toContain(
      "CI coverage must retain its exact prerequisite-bound 10-minute job boundary"
    );
    const ciWithWrongCoverageNode = mutableWorkflow(current.ciWorkflow, (workflow) => {
      const setup = mutableUsesStep(mutableWorkflowJob(workflow, "coverage"), EXPECTED_SETUP_NODE_ACTION);
      const setupWith = asRecord(setup.with);
      if (setupWith === undefined) throw new Error("expected coverage setup-node inputs");
      setupWith["node-version"] = 24;
    });
    expect(ciCoverageProblems(ciWithWrongCoverageNode)).toContain(
      "CI coverage must retain the exact pinned Node 22 setup step"
    );
    const ciWithSkippedPerFileGate = mutableWorkflow(current.ciWorkflow, (workflow) => {
      mutableRunStep(mutableWorkflowJob(workflow, "coverage"), "npm run check:per-file-coverage").if = "false";
    });
    expect(ciCoverageProblems(ciWithSkippedPerFileGate)).toContain(
      "CI coverage must retain contiguous fail-capable build, coverage and floor gates"
    );
    const ciWithFailOpenBuild = mutableWorkflow(current.ciWorkflow, (workflow) => {
      mutableRunStep(mutableWorkflowJob(workflow, "coverage"), "npm run build")["continue-on-error"] = true;
    });
    expect(ciCoverageProblems(ciWithFailOpenBuild)).toContain(
      "CI coverage must retain contiguous fail-capable build, coverage and floor gates"
    );
    const ciWithInsertedGateStep = mutableWorkflow(current.ciWorkflow, (workflow) => {
      const coverageJob = mutableWorkflowJob(workflow, "coverage");
      const steps = workflowSteps(coverageJob);
      if (steps === undefined) throw new Error("expected coverage steps");
      const insertion = steps.findIndex((step) => step.run === "npm run check:changelog-coverage");
      if (insertion < 0) throw new Error("expected changelog coverage gate");
      steps.splice(insertion, 0, { run: "true" });
    });
    expect(ciCoverageProblems(ciWithInsertedGateStep)).toContain(
      "CI coverage must retain contiguous fail-capable build, coverage and floor gates"
    );
    const ciWithPrependedCoverageStep = mutableWorkflow(current.ciWorkflow, (workflow) => {
      const steps = workflowSteps(mutableWorkflowJob(workflow, "coverage"));
      if (steps === undefined) throw new Error("expected coverage steps");
      steps.splice(2, 0, { run: "true" });
    });
    expect(ciCoverageProblems(ciWithPrependedCoverageStep)).toContain(
      "CI coverage must retain the exact reviewed step sequence"
    );
    const ciWithoutFailClosedCoverageUpload = mutableWorkflow(current.ciWorkflow, (workflow) => {
      const upload = mutableUsesStep(mutableWorkflowJob(workflow, "coverage"), EXPECTED_UPLOAD_ARTIFACT_ACTION);
      const uploadWith = asRecord(upload.with);
      if (uploadWith === undefined) throw new Error("expected coverage artifact upload inputs");
      delete uploadWith["if-no-files-found"];
    });
    expect(ciCoverageProblems(ciWithoutFailClosedCoverageUpload)).toContain(
      "CI coverage must publish one non-empty pinned same-run coverage-report after measurement"
    );
    const ciWithoutFreshOiaPrerequisite = mutableWorkflow(current.ciWorkflow, (workflow) => {
      mutableWorkflowJob(workflow, "oia").needs = "test";
    });
    expect(ciCoverageProblems(ciWithoutFreshOiaPrerequisite)).toContain(
      "CI OIA must consume the exact pinned current-run coverage-report before checking"
    );
    const ciWithoutFailClosedOiaDownload = mutableWorkflow(current.ciWorkflow, (workflow) => {
      const download = mutableUsesStep(mutableWorkflowJob(workflow, "oia"), EXPECTED_DOWNLOAD_ARTIFACT_ACTION);
      const downloadWith = asRecord(download.with);
      if (downloadWith === undefined) throw new Error("expected OIA artifact download inputs");
      delete downloadWith["digest-mismatch"];
    });
    expect(ciCoverageProblems(ciWithoutFailClosedOiaDownload)).toContain(
      "CI OIA must consume the exact pinned current-run coverage-report before checking"
    );
    const ciWithCrossRunOiaDownload = mutableWorkflow(current.ciWorkflow, (workflow) => {
      const download = mutableUsesStep(mutableWorkflowJob(workflow, "oia"), EXPECTED_DOWNLOAD_ARTIFACT_ACTION);
      const downloadWith = asRecord(download.with);
      if (downloadWith === undefined) throw new Error("expected OIA artifact download inputs");
      downloadWith["run-id"] = 123;
    });
    expect(ciCoverageProblems(ciWithCrossRunOiaDownload)).toContain(
      "CI OIA must consume the exact pinned current-run coverage-report before checking"
    );

    const vitestWithGlobalExclusion = replaceExactly(
      current.vitestConfig,
      '    include: ["tests/**/*.test.ts"],\n',
      '    include: ["tests/**/*.test.ts"],\n    exclude: ["tests/release-integrity.test.ts"],\n'
    );
    const vitestProblems = vitestCoverageProblems(vitestWithGlobalExclusion, [
      ...current.vitestConfigFiles,
      "vitest.workspace.ts"
    ]);
    expect(vitestProblems).toContain("vitest test config must retain its exact reviewed static key set");
    expect(vitestProblems).toContain("the repository must retain one canonical vitest.config.ts");
    const vitestWithBrowserEnvironment = replaceExactly(
      current.vitestConfig,
      '    environment: "node",',
      '    environment: "jsdom",'
    );
    expect(currentVitestProblems(vitestWithBrowserEnvironment)).toContain("vitest test.environment must remain node");
    const vitestWithRaisedGlobalTimeout = replaceExactly(
      current.vitestConfig,
      "    testTimeout: 15_000,",
      "    testTimeout: 15_001,"
    );
    expect(currentVitestProblems(vitestWithRaisedGlobalTimeout)).toContain("vitest testTimeout must remain 15_000");
    const vitestWithoutSetup = replaceExactly(
      current.vitestConfig,
      '    setupFiles: ["./tests/setup.ts"],',
      "    setupFiles: [],"
    );
    expect(currentVitestProblems(vitestWithoutSetup)).toContain(
      "vitest setupFiles must retain the exact tests/setup.ts bootstrap"
    );
    const vitestWithHiddenExclusion = replaceExactly(
      current.vitestConfig,
      '    include: ["tests/**/*.test.ts"],\n',
      '    include: ["tests/**/*.test.ts"],\n    ...{ exclude: ["tests/release-integrity.test.ts"] },\n'
    );
    expect(currentVitestProblems(vitestWithHiddenExclusion)).toContain(
      "vitest test config must retain its exact reviewed static key set"
    );
    const vitestWithAliasedDefineConfig = replaceExactly(
      replaceExactly(
        current.vitestConfig,
        'import { defineConfig } from "vitest/config";',
        'import { defineConfig as configure } from "vitest/config";'
      ),
      "export default defineConfig(",
      "export default configure("
    );
    expect(currentVitestProblems(vitestWithAliasedDefineConfig)).toContain(
      "vitest config must retain the exact unaliased defineConfig import"
    );
    const vitestWithAliasedCoveragePolicy = replaceExactly(
      replaceExactly(
        current.vitestConfig,
        'import { COVERAGE_EXCLUDE_PATTERNS } from "./scripts/lib/coverage-policy.mjs";',
        'import { COVERAGE_EXCLUDE_PATTERNS as hidden } from "./scripts/lib/coverage-policy.mjs";'
      ),
      "exclude: [...COVERAGE_EXCLUDE_PATTERNS]",
      "exclude: [...hidden]"
    );
    expect(currentVitestProblems(vitestWithAliasedCoveragePolicy)).toContain(
      "vitest config must retain the exact centralized coverage-policy import"
    );
    expect(currentVitestProblems(vitestWithAliasedCoveragePolicy)).toContain(
      "vitest production coverage exclusions must use the exact centralized policy spread"
    );
    const vitestWithExtraCoverageExclusion = replaceExactly(
      current.vitestConfig,
      "exclude: [...COVERAGE_EXCLUDE_PATTERNS]",
      'exclude: [...COVERAGE_EXCLUDE_PATTERNS, "src/vault.ts"]'
    );
    expect(currentVitestProblems(vitestWithExtraCoverageExclusion)).toContain(
      "vitest production coverage exclusions must use the exact centralized policy spread"
    );
    const vitestWithExportEquals = replaceExactly(
      current.vitestConfig,
      "export default defineConfig(",
      "export = defineConfig("
    );
    expect(currentVitestProblems(vitestWithExportEquals)).toContain(
      "vitest config must remain one static default defineConfig object"
    );
    const vitestWithRootOverride = replaceExactly(
      current.vitestConfig,
      "export default defineConfig({\n  test:",
      'export default defineConfig({\n  root: "./empty",\n  test:'
    );
    expect(currentVitestProblems(vitestWithRootOverride)).toContain(
      "vitest root config must retain the exact static test-only shape"
    );
    const vitestWithComputedExclusion = replaceExactly(
      current.vitestConfig,
      '    include: ["tests/**/*.test.ts"],\n',
      '    include: ["tests/**/*.test.ts"],\n    ["exclude"]: ["tests/release-integrity.test.ts"],\n'
    );
    expect(currentVitestProblems(vitestWithComputedExclusion)).toContain(
      "vitest test config must retain its exact reviewed static key set"
    );
    const vitestWithCoverageSpread = replaceExactly(
      current.vitestConfig,
      "      thresholds: {\n",
      '      ...{ include: ["src/vault.ts"] },\n      thresholds: {\n'
    );
    expect(currentVitestProblems(vitestWithCoverageSpread)).toContain(
      "vitest coverage config must retain its exact reviewed static key set"
    );
    const vitestWithThresholdSpread = replaceExactly(
      current.vitestConfig,
      "        branches: 74\n",
      "        branches: 74,\n        ...{ branches: 0 }\n"
    );
    expect(currentVitestProblems(vitestWithThresholdSpread)).toContain(
      "vitest coverage thresholds must retain the exact four global floors"
    );
    const vitestWithNarrowSource = replaceExactly(
      current.vitestConfig,
      '      include: ["src/**/*.ts"],',
      '      include: ["src/vault.ts"],'
    );
    expect(currentVitestProblems(vitestWithNarrowSource)).toContain(
      "vitest coverage.include must remain exact src/**/*.ts"
    );
    const vitestWithWrongProvider = replaceExactly(
      current.vitestConfig,
      '      provider: "v8",',
      '      provider: "istanbul",'
    );
    expect(currentVitestProblems(vitestWithWrongProvider)).toContain("vitest coverage provider must remain v8");
    const vitestWithLowerFloor = replaceExactly(current.vitestConfig, "        branches: 74", "        branches: 73");
    expect(currentVitestProblems(vitestWithLowerFloor)).toContain("vitest coverage threshold branches must remain 74");
    expect(
      vitestCoverageProblems(current.vitestConfig, [...current.vitestConfigFiles, "vitest.workspace.ts"])
    ).toContain("the repository must retain one canonical vitest.config.ts");

    const metaSource = requiredClosureSource(current.closureSources, "tests/meta-invariant-coverage.test.ts");
    const raisedMetaTimeout = replaceExactly(
      metaSource,
      '  }, 720_000);\n\n  it("every *-invariant.test.ts file has NEGATIVE control OR explicit exempt marker",',
      '  }, 721_000);\n\n  it("every *-invariant.test.ts file has NEGATIVE control OR explicit exempt marker",'
    );
    const staleMetaTimeout = replaceExactly(
      metaSource,
      '  }, 720_000);\n\n  it("every *-invariant.test.ts file has NEGATIVE control OR explicit exempt marker",',
      '  }, 480_000);\n\n  it("every *-invariant.test.ts file has NEGATIVE control OR explicit exempt marker",'
    );
    const supersededMetaTimeout = replaceExactly(
      metaSource,
      '  }, 720_000);\n\n  it("every *-invariant.test.ts file has NEGATIVE control OR explicit exempt marker",',
      '  }, 540_000);\n\n  it("every *-invariant.test.ts file has NEGATIVE control OR explicit exempt marker",'
    );
    const syntheticRaisedMetaRegistration =
      'describe("META-invariant: exact structural census + NEGATIVE control coverage", () => {\n' +
      "  beforeAll(() => {}, 721_000);\n" +
      "});";
    const metaTimeoutProblems = (source: string): string[] =>
      registrationTimeoutProblems(
        source,
        "tests/meta-invariant-coverage.test.ts",
        "META-invariant: exact structural census + NEGATIVE control coverage",
        "beforeAll",
        undefined,
        "720_000"
      );
    const metaTimeoutDiagnostic =
      "tests/meta-invariant-coverage.test.ts must retain one direct beforeAll registration with timeout 720_000";
    const metaBindingDiagnostic =
      "tests/meta-invariant-coverage.test.ts must bind beforeAll through one direct unaliased vitest named import and no other runtime bindings; found direct 0, other 1";
    const aliasedMetaCallee = replaceExactly(
      metaSource,
      'import { beforeAll, describe, expect, it } from "vitest";',
      'import { beforeAll as authenticBeforeAll, describe, expect, it } from "vitest";\n' +
        "const beforeAll = (callback: () => void, _timeout: number): void => {\n" +
        "  authenticBeforeAll(callback, 86_400_000);\n" +
        "};"
    );
    const shadowedMetaRegistration =
      'describe("META-invariant: exact structural census + NEGATIVE control coverage", () => {\n' +
      "  beforeAll(() => {}, 720_000);\n" +
      "  function beforeAll(..._args: unknown[]): void {}\n" +
      "});";
    expect(metaTimeoutProblems(aliasedMetaCallee)).toContain(metaBindingDiagnostic);
    expect(metaTimeoutProblems(syntheticRaisedMetaRegistration)).toContain(metaTimeoutDiagnostic);
    expect(metaTimeoutProblems(shadowedMetaRegistration)).toContain(metaTimeoutDiagnostic);
    expect(metaTimeoutProblems(staleMetaTimeout)).toContain(metaTimeoutDiagnostic);
    expect(metaTimeoutProblems(supersededMetaTimeout)).toContain(metaTimeoutDiagnostic);
    const releaseSource = requiredClosureSource(current.closureSources, "tests/release-integrity.test.ts");
    const releaseTimeoutProblems = (source: string): string[] =>
      registrationTimeoutProblems(
        source,
        "tests/release-integrity.test.ts",
        "release identity and exact required-job gate",
        "it",
        "keeps release.yml wired to the shared evaluator and an exact mirrored inventory",
        "330_000"
      );
    const moduleProblems = (filename: string, source: string): readonly string[] =>
      resolvedRuntimeModuleEdges(filename, source, current.closureSources).problems;
    const raisedReleaseTimeout = replaceExactly(releaseSource, "  }, 330_000);\n});\n", "  }, 331_000);\n});\n");
    const syntheticRaisedReleaseRegistration =
      'describe("release identity and exact required-job gate", () => {\n' +
      '  it("keeps release.yml wired to the shared evaluator and an exact mirrored inventory", () => {}, 331_000);\n' +
      "});";
    expect(releaseTimeoutProblems(syntheticRaisedReleaseRegistration)).toContain(
      "tests/release-integrity.test.ts must retain one direct it registration with timeout 330_000"
    );
    const unreachableReleaseRegistration =
      'describe("release identity and exact required-job gate", () => {\n' +
      "  return;\n" +
      '  it("keeps release.yml wired to the shared evaluator and an exact mirrored inventory", () => {}, 330_000);\n' +
      "});";
    expect(releaseTimeoutProblems(unreachableReleaseRegistration)).toContain(
      "tests/release-integrity.test.ts must retain one direct it registration with timeout 330_000"
    );
    const k1TimeoutProblems = (source: string): string[] =>
      registrationTimeoutProblems(
        source,
        "tests/k1-class-invariant.test.ts",
        "K-1 class invariant (v3.6.3 methodological guard; recursive scan since v3.7.0 M-3)",
        "it",
        "every `new EmbedDb` / `new FtsIndex` in src/ is preceded by discovery or // SAFE BY DESIGN",
        "30_000"
      );
    const k1TimeoutDiagnostic =
      "tests/k1-class-invariant.test.ts must retain one direct it registration with timeout 30_000";
    const staleK1Timeout = replaceExactly(
      current.k1ClassSource,
      "  }, 30_000);\n\n  it.for([",
      "  }, 15_000);\n\n  it.for(["
    );
    const missingK1Timeout = replaceExactly(
      current.k1ClassSource,
      "  }, 30_000);\n\n  it.for([",
      "  });\n\n  it.for(["
    );
    const raisedK1Timeout = replaceExactly(
      current.k1ClassSource,
      "  }, 30_000);\n\n  it.for([",
      "  }, 30_001);\n\n  it.for(["
    );
    expect(k1TimeoutProblems(staleK1Timeout)).toContain(k1TimeoutDiagnostic);
    expect(k1TimeoutProblems(missingK1Timeout)).toContain(k1TimeoutDiagnostic);
    expect(k1TimeoutProblems(raisedK1Timeout)).toContain(k1TimeoutDiagnostic);
    const transitionTimeoutProblems = (source: string): string[] =>
      registrationTimeoutProblems(
        source,
        "tests/release-mutation-transition.test.ts",
        "release mutation schema-v3 transition authority",
        "it",
        "audits the frozen current matrix through the exact versioned authority",
        "60_000"
      );
    const transitionTimeoutDiagnostic =
      "tests/release-mutation-transition.test.ts must retain one direct it registration with timeout 60_000";
    const transitionTimeoutNeedle =
      '  }, 60_000);\n\n  it("keeps the META positive baseline wired to v3 and legacy checks differential-only"';
    const staleTransitionTimeout = replaceExactly(
      current.releaseMutationTransitionSource,
      transitionTimeoutNeedle,
      transitionTimeoutNeedle.replace("60_000", "35_000")
    );
    const missingTransitionTimeout = replaceExactly(
      current.releaseMutationTransitionSource,
      transitionTimeoutNeedle,
      transitionTimeoutNeedle.replace("}, 60_000);", "});")
    );
    const raisedTransitionTimeout = replaceExactly(
      current.releaseMutationTransitionSource,
      transitionTimeoutNeedle,
      transitionTimeoutNeedle.replace("60_000", "60_001")
    );
    const unreachableTransitionRegistration =
      'describe("release mutation schema-v3 transition authority", () => {\n' +
      "  return;\n" +
      '  it("audits the frozen current matrix through the exact versioned authority", () => {}, 60_000);\n' +
      "});";
    expect(transitionTimeoutProblems(staleTransitionTimeout)).toContain(transitionTimeoutDiagnostic);
    expect(transitionTimeoutProblems(missingTransitionTimeout)).toContain(transitionTimeoutDiagnostic);
    expect(transitionTimeoutProblems(raisedTransitionTimeout)).toContain(transitionTimeoutDiagnostic);
    expect(transitionTimeoutProblems(unreachableTransitionRegistration)).toContain(transitionTimeoutDiagnostic);
    const docsTimeoutProblems = (source: string): string[] =>
      registrationTimeoutProblems(
        source,
        "tests/docs-consistency.test.ts",
        "docs/code consistency — numeric claims (v3.5.1 audit-driven)",
        "it",
        "OIA check count is consistent across oia-walk.mjs, AGENTS.md, ROADMAP.md (rc.22)",
        "60_000"
      );
    const docsTimeoutDiagnostic =
      "tests/docs-consistency.test.ts must retain one direct it registration with timeout 60_000";
    const docsItBindingDiagnostic =
      "tests/docs-consistency.test.ts must bind it through one direct unaliased vitest named import and no other runtime bindings; found direct 0, other 1";
    const docsDescribeBindingDiagnostic =
      "tests/docs-consistency.test.ts must bind describe through one direct unaliased vitest named import and no other runtime bindings; found direct 0, other 1";
    const exactDocsRegistration =
      'import { describe, it } from "vitest";\n' +
      'describe("docs/code consistency — numeric claims (v3.5.1 audit-driven)", () => {\n' +
      '  it("sibling registration remains inert", () => {});\n' +
      '  it("OIA check count is consistent across oia-walk.mjs, AGENTS.md, ROADMAP.md (rc.22)", () => {}, 60_000);\n' +
      "});";
    expect(docsTimeoutProblems(exactDocsRegistration)).toEqual([]);
    const aliasedDocsCallee = replaceExactly(
      current.docsConsistencySource,
      'import { describe, expect, it } from "vitest";',
      'import { describe, expect, it as authenticIt } from "vitest";\n' +
        "const it = (name: string, callback: () => void, _timeout: number): void => {\n" +
        "  authenticIt(name, callback, 86_400_000);\n" +
        "};"
    );
    const aliasedDocsSuite = replaceExactly(
      current.docsConsistencySource,
      'import { describe, expect, it } from "vitest";',
      'import { describe as authenticDescribe, expect, it } from "vitest";\n' +
        "void authenticDescribe;\n" +
        "const describe = (_name: string, _callback: () => void): void => undefined;"
    );
    const suiteLocalOptionalVarShadow =
      'import { describe, it } from "vitest";\n' +
      "const authenticIt = it;\n" +
      'describe("docs/code consistency — numeric claims (v3.5.1 audit-driven)", () => {\n' +
      '  it?.("OIA check count is consistent across oia-walk.mjs, AGENTS.md, ROADMAP.md (rc.22)", () => {}, 60_000);\n' +
      "  var it = authenticIt;\n" +
      '  it("sibling remains registered", () => {}, 60_000);\n' +
      "});";
    const localPrefixRegistrar =
      'import { describe, it } from "vitest";\n' +
      'const beforeEach = (): void => { throw new Error("abort collection"); };\n' +
      'describe("docs/code consistency — numeric claims (v3.5.1 audit-driven)", () => {\n' +
      "  beforeEach();\n" +
      '  it("OIA check count is consistent across oia-walk.mjs, AGENTS.md, ROADMAP.md (rc.22)", () => {}, 60_000);\n' +
      "});";
    const eagerPrefixArgument =
      'import { describe, it } from "vitest";\n' +
      'describe("docs/code consistency — numeric claims (v3.5.1 audit-driven)", () => {\n' +
      '  it("sibling", (() => { throw new Error("abort collection"); })());\n' +
      '  it("OIA check count is consistent across oia-walk.mjs, AGENTS.md, ROADMAP.md (rc.22)", () => {}, 60_000);\n' +
      "});";
    expect(docsTimeoutProblems(aliasedDocsCallee)).toContain(docsItBindingDiagnostic);
    expect(docsTimeoutProblems(aliasedDocsSuite)).toContain(docsDescribeBindingDiagnostic);
    expect(docsTimeoutProblems(suiteLocalOptionalVarShadow)).toContain(
      docsItBindingDiagnostic.replace("found direct 0, other 1", "found direct 1, other 1")
    );
    expect(docsTimeoutProblems(localPrefixRegistrar)).toContain(docsTimeoutDiagnostic);
    expect(docsTimeoutProblems(eagerPrefixArgument)).toContain(docsTimeoutDiagnostic);
    const docsTimeoutNeedle = '  }, 60_000);\n\n  it("package.json description tool-count matches actual count"';
    const inheritedDocsTimeout = replaceExactly(
      current.docsConsistencySource,
      docsTimeoutNeedle,
      docsTimeoutNeedle.replace("60_000", "15_000")
    );
    const provenInsufficientDocsTimeout = replaceExactly(
      current.docsConsistencySource,
      docsTimeoutNeedle,
      docsTimeoutNeedle.replace("60_000", "25_000")
    );
    const underBufferedDocsTimeout = replaceExactly(
      current.docsConsistencySource,
      docsTimeoutNeedle,
      docsTimeoutNeedle.replace("60_000", "45_000")
    );
    const missingDocsTimeout = replaceExactly(
      current.docsConsistencySource,
      docsTimeoutNeedle,
      docsTimeoutNeedle.replace("}, 60_000);", "});")
    );
    const raisedDocsTimeout = replaceExactly(
      current.docsConsistencySource,
      docsTimeoutNeedle,
      docsTimeoutNeedle.replace("60_000", "60_001")
    );
    const unreachableDocsRegistration =
      'describe("docs/code consistency — numeric claims (v3.5.1 audit-driven)", () => {\n' +
      "  function declarationIsSafe(): void {}\n" +
      "  return;\n" +
      '  it("OIA check count is consistent across oia-walk.mjs, AGENTS.md, ROADMAP.md (rc.22)", () => {}, 60_000);\n' +
      "});";
    const shadowedDocsRegistration =
      'describe("docs/code consistency — numeric claims (v3.5.1 audit-driven)", () => {\n' +
      '  it("OIA check count is consistent across oia-walk.mjs, AGENTS.md, ROADMAP.md (rc.22)", () => {}, 60_000);\n' +
      "  function it(..._args: unknown[]): void {}\n" +
      "});";
    expect(docsTimeoutProblems(inheritedDocsTimeout)).toContain(docsTimeoutDiagnostic);
    expect(docsTimeoutProblems(provenInsufficientDocsTimeout)).toContain(docsTimeoutDiagnostic);
    expect(docsTimeoutProblems(underBufferedDocsTimeout)).toContain(docsTimeoutDiagnostic);
    expect(docsTimeoutProblems(missingDocsTimeout)).toContain(docsTimeoutDiagnostic);
    expect(docsTimeoutProblems(raisedDocsTimeout)).toContain(docsTimeoutDiagnostic);
    expect(docsTimeoutProblems(unreachableDocsRegistration)).toContain(docsTimeoutDiagnostic);
    expect(docsTimeoutProblems(shadowedDocsRegistration)).toContain(docsTimeoutDiagnostic);

    const directProductionImport = 'import { Vault } from "../src/vault.js";';
    expect(moduleProblems("tests/release-integrity.test.ts", directProductionImport)).toContain(
      "tests/release-integrity.test.ts value-imports production path src/vault.js"
    );
    const helperSource = requiredClosureSource(current.closureSources, "tests/helpers/exact-source-mutation.ts");
    const transitiveProductionImport = 'import "../../dist/index.js";';
    expect(moduleProblems("tests/helpers/exact-source-mutation.ts", transitiveProductionImport)).toContain(
      "tests/helpers/exact-source-mutation.ts value-imports production path dist/index.js"
    );

    const aggregateClosureSources = new Map(current.closureSources);
    aggregateClosureSources.set("tests/meta-invariant-coverage.test.ts", raisedMetaTimeout);
    aggregateClosureSources.set(
      "tests/release-integrity.test.ts",
      `${directProductionImport}\n${raisedReleaseTimeout}`
    );
    aggregateClosureSources.set(
      "tests/helpers/exact-source-mutation.ts",
      `${transitiveProductionImport}\n${helperSource}`
    );
    const aggregateProblems = coverageIsolationProblems({
      packageJson: packageWithThirdExclusion,
      ciWorkflow: ciWithFilteredTest,
      vitestConfig: vitestWithGlobalExclusion,
      vitestConfigFiles: [...current.vitestConfigFiles, "vitest.workspace.ts"],
      docsConsistencySource: underBufferedDocsTimeout,
      k1ClassSource: staleK1Timeout,
      releaseMutationTransitionSource: staleTransitionTimeout,
      closureSources: aggregateClosureSources
    });
    expect(aggregateProblems).toEqual([
      "package scripts.test:coverage must retain the exact two-file coverage-only exclusion",
      "CI test matrix must retain the exact reviewed step sequence",
      "each CI Node leg must end with one exact unfiltered fail-capable npm test",
      "the repository must retain one canonical vitest.config.ts",
      "vitest test config must retain its exact reviewed static key set",
      "tests/meta-invariant-coverage.test.ts must retain one direct beforeAll registration with timeout 720_000",
      "tests/release-integrity.test.ts must retain one direct it registration with timeout 330_000",
      "tests/k1-class-invariant.test.ts must retain one direct it registration with timeout 30_000",
      "tests/release-mutation-transition.test.ts must retain one direct it registration with timeout 60_000",
      "tests/docs-consistency.test.ts must retain one direct it registration with timeout 60_000",
      "tests/release-integrity.test.ts value-imports production path src/vault.js",
      "tests/helpers/exact-source-mutation.ts value-imports production path dist/index.js"
    ]);

    const vitestProductionImport = 'import { vi } from "vitest";\nvoid vi.importActual("../src/vault.js");';
    expect(moduleProblems("tests/release-integrity.test.ts", vitestProductionImport)).toContain(
      "tests/release-integrity.test.ts value-imports production path src/vault.js"
    );
    const createRequireLoader =
      'import { createRequire } from "node:module";\n' + "const loadCoverageModule = createRequire(import.meta.url);";
    expect(moduleProblems("tests/release-integrity.test.ts", createRequireLoader)).toContain(
      "tests/release-integrity.test.ts uses createRequire outside the reviewed static import graph"
    );
    const emptyNamedProductionImport = 'import {} from "../src/vault.js";';
    expect(moduleProblems("tests/release-integrity.test.ts", emptyNamedProductionImport)).toContain(
      "tests/release-integrity.test.ts value-imports production path src/vault.js"
    );
    const selfPackageImport = 'import "@oomkapwn/enquire-mcp";';
    expect(moduleProblems("tests/release-integrity.test.ts", selfPackageImport)).toContain(
      "tests/release-integrity.test.ts value-imports the enquire-mcp package surface"
    );
    const unresolvedImport = 'import "./missing-coverage-helper.js";';
    expect(moduleProblems("tests/meta-invariant-coverage.test.ts", unresolvedImport)).toContain(
      "tests/meta-invariant-coverage.test.ts has unresolved runtime import ./missing-coverage-helper.js"
    );
    const computedImport = 'const hiddenModule = "./helpers/exact-source-mutation.js";\nvoid import(hiddenModule);';
    expect(moduleProblems("tests/meta-invariant-coverage.test.ts", computedImport)).toContain(
      "tests/meta-invariant-coverage.test.ts uses a nonliteral dynamic import loader"
    );
    const unreviewedAliasImport = 'import "#production-alias";';
    expect(moduleProblems("tests/release-integrity.test.ts", unreviewedAliasImport)).toContain(
      "tests/release-integrity.test.ts uses an unreviewed external runtime module #production-alias"
    );
    expect(reviewedClosurePathProblem("tests/helpers/exact-source-mutation.ts", "src/vault.ts")).toBe(
      "reviewed coverage closure path tests/helpers/exact-source-mutation.ts resolves to unexpected src/vault.ts"
    );

    const typeOnlyProductionImport = 'import type { Vault } from "../src/vault.js";';
    expect(moduleProblems("tests/release-integrity.test.ts", typeOnlyProductionImport)).toEqual([]);
  });
});

async function collectTestFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await collectTestFiles(full)));
    } else if (e.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}
