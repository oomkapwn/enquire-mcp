import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { load } from "js-yaml";
import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";
import {
  ciWorkflowReceiptDigest,
  EXPECTED_VITEST_BOOTSTRAP_FILES,
  inspectRepositoryVitestBootstrap,
  oiaVitestBootstrapWiringProblems,
  VITEST_BOOTSTRAP_MANIFEST
} from "../scripts/lib/oia-vitest-bootstrap.mjs";
import {
  firstPartyVitestFocusSourceFiles,
  inspectRepositoryVitestFocusControls,
  inspectStaticVitestFocusControls
} from "../scripts/lib/oia-vitest-focus.mjs";
import {
  ciTestSelectionProblems,
  EXPECTED_BUILD_SCRIPT,
  EXPECTED_COVERAGE_SCRIPT,
  EXPECTED_PREPARE_SCRIPT,
  FORBIDDEN_REQUIRED_RUN_LIFECYCLE_SCRIPTS,
  forbiddenNpmProjectEntries,
  inspectRepositoryVitestSelectionControls,
  packageTestSelectionProblems,
  vitestSelectionProblems
} from "../scripts/lib/oia-vitest-selection.mjs";
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
// Class C invariant (post-PR #518/#519 sibling sweeps) — Vitest focus and
// pre-collection selection controls are enforced by OIA Check 12c in a
// separate Node process. Check 12d additionally binds the complete first-party
// bootstrap byte closure to a CI receipt verified before setup-node. The focus
// analyzer scans the complete first-party
// JavaScript/TypeScript executable-source census; the selection analyzer pins
// the persistent canonical config, root npm execution inputs, install/build/test
// commands and blocking CI test job. A persistent static selector can therefore
// skip this oracle only by leaving a non-overridable OIA finding after the
// unchanged OIA entrypoint starts. The CI receipt is an audited merge gate,
// not a defense against a coordinated replacement of the workflow itself.

const repoRoot = path.resolve(__dirname, "..");
const EXECUTABLE_SOURCE_EXTENSIONS = new Set([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);
const GENERATED_EXECUTABLE_ROOTS = new Set([".git", "coverage", "dist", "node_modules"]);
const RESTRICTED_MODULES = ["cli", "server", "tool-registry", "prompts"];
const COVERAGE_ONLY_TEST_EXCLUSIONS = [
  "tests/meta-invariant-coverage.test.ts",
  "tests/release-integrity.test.ts"
] as const;
const EXPECTED_OIA_SCRIPT = "node scripts/oia-walk.mjs";
const OIA_FOCUS_IMPORT = 'const { inspectRepositoryVitestFocusControls } = await import("./lib/oia-vitest-focus.mjs");';
const OIA_FOCUS_CALL = "for (const finding of inspectRepositoryVitestFocusControls(repoRoot))";
const OIA_FOCUS_LOOP =
  `  ${OIA_FOCUS_CALL} {\n` +
  "    record(finding.kind, finding.file, finding.line, finding.evidence, finding.hint);\n" +
  "  }";
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
const EXPECTED_VITEST_BOOTSTRAP_RUNTIME_IMPORTS = new Map<string, readonly string[]>([
  ["scripts/lib/coverage-policy.mjs", ["node:fs", "node:path"]],
  ["scripts/lib/entrypoint.mjs", ["node:fs", "node:url"]],
  ["scripts/lib/oia-offline-guard.mjs", ["typescript"]],
  ["scripts/lib/oia-release-claims.mjs", []],
  ["scripts/lib/oia-vitest-bootstrap.mjs", ["node:crypto", "node:fs", "node:path"]],
  ["scripts/lib/oia-vitest-focus.mjs", ["node:fs", "node:path", "typescript"]],
  [
    "scripts/lib/oia-vitest-selection.mjs",
    ["js-yaml", "node:crypto", "node:fs", "node:path", "node:util", "typescript"]
  ],
  ["scripts/npm-ci-with-retry.mjs", ["./lib/entrypoint.mjs", "node:child_process", "node:fs", "node:path"]],
  [
    "scripts/oia-walk.mjs",
    [
      "./lib/coverage-policy.mjs",
      "./lib/oia-offline-guard.mjs",
      "./lib/oia-release-claims.mjs",
      "./lib/oia-vitest-bootstrap.mjs",
      "./lib/oia-vitest-focus.mjs",
      "./lib/oia-vitest-selection.mjs",
      "./scope-completeness-audit.mjs",
      "js-yaml",
      "node:child_process",
      "node:child_process",
      "node:child_process",
      "node:crypto",
      "node:fs",
      "node:path",
      "node:url"
    ]
  ],
  ["scripts/scope-completeness-audit.mjs", ["./lib/entrypoint.mjs", "node:fs", "node:path", "node:url"]],
  ["tests/setup.ts", ["node:fs", "node:os", "node:path"]],
  ["vitest.config.ts", ["./scripts/lib/coverage-policy.mjs", "vitest/config"]]
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

const VITEST_RUNTIME_ROOTS = new Set(["vi", "vitest"]);
const VITEST_RUNTIME_LOADERS = new Set(["doMock", "importActual", "importMock", "mock"]);
const NODE_MODULE_RUNTIME_LOADER_EXPORTS = new Set(["Module", "createRequire", "default"]);
const MODULE_RUNTIME_LOADER_MEMBERS = new Set([
  "__proto__",
  "_compile",
  "_load",
  "children",
  "constructor",
  "createRequire",
  "load",
  "parent",
  "require"
]);
const GLOBAL_THIS_RUNTIME_CAPABILITIES = new Set(["global", "globalThis", "module", "process", "require", "vi"]);
const PROCESS_RUNTIME_LOADER_MEMBERS = new Set(["getBuiltinModule", "mainModule"]);
// Canonical JSON SHA-256 pins keep every reviewed step exact without copying
// multiline shell bodies into this invariant a second time.
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

function recordHasExactKeys(record: UnknownRecord, expected: readonly string[]): boolean {
  return isDeepStrictEqual(Object.keys(record).sort(), [...expected].sort());
}

function stringLiteralValue(expression: ts.Expression | undefined): string | undefined {
  return expression !== undefined && ts.isStringLiteralLike(expression) ? expression.text : undefined;
}

function packageCoverageProblems(source: string): string[] {
  const problems = [...packageTestSelectionProblems(source)];
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return problems;
  }
  const scripts = asRecord(asRecord(parsed)?.scripts);
  if (scripts?.["check:oia"] !== EXPECTED_OIA_SCRIPT) {
    problems.push("package scripts.check:oia must retain the exact independent Node entrypoint");
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
  const problems = [...ciTestSelectionProblems(source)];
  let parsed: unknown;
  try {
    parsed = load(source);
  } catch {
    return problems;
  }
  const workflow = asRecord(parsed);
  if (workflow === undefined) return problems;
  const jobs = asRecord(workflow.jobs);
  const testMacosJob = asRecord(jobs?.["test-macos"]);
  const coverageJob = asRecord(jobs?.coverage);
  const oiaJob = asRecord(jobs?.oia);

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
  return vitestSelectionProblems(source, configFiles);
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
    const bindingProblems = registrationVitestBindingProblems(sourceFile, filename, ["describe", callee]);
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
  const prefixStatements =
    registrationEntry === undefined ? [] : suiteCallback.body.statements.slice(0, registrationEntry.statementIndex);
  const prefixRegistrationBindings = prefixStatements.flatMap((statement): RegistrationVitestBinding[] => {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return [];
    const expression = statement.expression.expression;
    if (!ts.isIdentifier(expression)) return [];
    return expression.text === "beforeAll" || expression.text === "it" ? [expression.text] : [];
  });
  const requiredBindings = [...new Set<RegistrationVitestBinding>(["describe", callee, ...prefixRegistrationBindings])];
  const bindingProblems = registrationVitestBindingProblems(sourceFile, filename, requiredBindings);
  const shadowsTargetCallee = suiteCallback.body.statements.some(
    (statement) => ts.isFunctionDeclaration(statement) && statement.name !== undefined && statement.name.text === callee
  );
  const inertPrefixRegistration = (statement: ts.Statement): boolean => {
    if (ts.isFunctionDeclaration(statement)) return true;
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return false;
    const call = statement.expression;
    if (
      !ts.isIdentifier(call.expression) ||
      (call.expression.text !== "beforeAll" && call.expression.text !== "it") ||
      call.questionDotToken !== undefined ||
      call.typeArguments !== undefined
    ) {
      return false;
    }
    const prefixCallee = call.expression.text;
    const callbackIndex = prefixCallee === "beforeAll" ? 0 : 1;
    const timeoutIndex = prefixCallee === "beforeAll" ? 1 : 2;
    const callback = call.arguments[callbackIndex];
    const timeout = call.arguments[timeoutIndex];
    const minimumArgumentCount = prefixCallee === "beforeAll" ? 1 : 2;
    return (
      (call.arguments.length === minimumArgumentCount || call.arguments.length === minimumArgumentCount + 1) &&
      (prefixCallee === "beforeAll" || stringLiteralValue(call.arguments[0]) !== undefined) &&
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

function unwrapRuntimeExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function runtimeStaticStringValue(expression: ts.Expression | undefined): string | undefined {
  if (expression === undefined) return undefined;
  const current = unwrapRuntimeExpression(expression);
  if (ts.isStringLiteralLike(current)) return current.text;
  if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = runtimeStaticStringValue(current.left);
    const right = runtimeStaticStringValue(current.right);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  return undefined;
}

function runtimeMemberName(expression: ts.Expression): string | undefined {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (ts.isElementAccessExpression(expression)) return runtimeStaticStringValue(expression.argumentExpression);
  return undefined;
}

function runtimeStaticPropertyName(name: ts.PropertyName | undefined): string | undefined {
  if (name === undefined) return undefined;
  if (ts.isComputedPropertyName(name)) return runtimeStaticStringValue(name.expression);
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : undefined;
}

function runtimeMemberReceiver(expression: ts.Expression): ts.Expression | undefined {
  return ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)
    ? expression.expression
    : undefined;
}

function runtimeSymbolHasValueBinding(symbol: ts.Symbol): boolean {
  return (symbol.declarations ?? []).some((declaration) => {
    if (
      ts.isInterfaceDeclaration(declaration) ||
      ts.isTypeAliasDeclaration(declaration) ||
      ts.isTypeParameterDeclaration(declaration) ||
      ts.isExportSpecifier(declaration)
    ) {
      return false;
    }
    let current: ts.Node | undefined = declaration;
    while (current !== undefined && !ts.isSourceFile(current)) {
      if (
        ts.canHaveModifiers(current) &&
        ts.getModifiers(current)?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)
      ) {
        return false;
      }
      if (ts.isImportSpecifier(current) && current.isTypeOnly) return false;
      if (ts.isImportClause(current) && current.isTypeOnly) return false;
      if (ts.isImportEqualsDeclaration(current) && current.isTypeOnly) return false;
      current = current.parent;
    }
    return !declaration.getSourceFile().isDeclarationFile;
  });
}

function runtimeValueSymbolAt(checker: ts.TypeChecker, identifier: ts.Identifier): ts.Symbol | undefined {
  const direct = ts.isShorthandPropertyAssignment(identifier.parent)
    ? checker.getShorthandAssignmentValueSymbol(identifier.parent)
    : checker.getSymbolAtLocation(identifier);
  if (direct !== undefined && runtimeSymbolHasValueBinding(direct)) return direct;
  return checker
    .getSymbolsInScope(identifier, ts.SymbolFlags.Value)
    .find((candidate) => candidate.getName() === identifier.text && runtimeSymbolHasValueBinding(candidate));
}

function isErasedRuntimeModuleNode(node: ts.Node): boolean {
  let current: ts.Node | undefined = node;
  while (current !== undefined && !ts.isSourceFile(current)) {
    if (
      ts.isInterfaceDeclaration(current) ||
      ts.isTypeAliasDeclaration(current) ||
      ts.isTypeParameterDeclaration(current) ||
      ts.isTypeQueryNode(current) ||
      ts.isPropertySignature(current) ||
      ts.isMethodSignature(current) ||
      (ts.isHeritageClause(current) && current.token === ts.SyntaxKind.ImplementsKeyword) ||
      (ts.isImportSpecifier(current) && current.isTypeOnly) ||
      (ts.isImportClause(current) && current.isTypeOnly) ||
      (ts.isImportEqualsDeclaration(current) && current.isTypeOnly) ||
      (ts.isExportSpecifier(current) && current.isTypeOnly) ||
      (ts.isExportDeclaration(current) && current.isTypeOnly)
    ) {
      return true;
    }
    if (
      ts.canHaveModifiers(current) &&
      (ts.getModifiers(current)?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword) ||
        ((ts.isMethodDeclaration(current) ||
          ts.isPropertyDeclaration(current) ||
          ts.isGetAccessorDeclaration(current) ||
          ts.isSetAccessorDeclaration(current)) &&
          ts.getModifiers(current)?.some((modifier) => modifier.kind === ts.SyntaxKind.AbstractKeyword)))
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

interface BoundRuntimeModuleSource {
  readonly checker: ts.TypeChecker;
  readonly sourceFile: ts.SourceFile;
}

function bindRuntimeModuleSource(
  filename: string,
  source: string,
  scriptKind: ts.ScriptKind
): BoundRuntimeModuleSource {
  const virtualFilename = `/__runtime_module_edges__/${filename}`;
  const options: ts.CompilerOptions = {
    allowJs: true,
    module: ts.ModuleKind.ESNext,
    moduleDetection: ts.ModuleDetectionKind.Force,
    noLib: true,
    noResolve: true,
    target: ts.ScriptTarget.Latest
  };
  const host = ts.createCompilerHost(options, true);
  host.fileExists = (requested) => requested === virtualFilename;
  host.getSourceFile = (requested, languageVersionOrOptions) =>
    requested === virtualFilename
      ? ts.createSourceFile(virtualFilename, source, languageVersionOrOptions, true, scriptKind)
      : undefined;
  host.readFile = (requested) => (requested === virtualFilename ? source : undefined);
  const program = ts.createProgram({ host, options, rootNames: [virtualFilename] });
  const sourceFile = program.getSourceFile(virtualFilename);
  if (sourceFile === undefined) throw new Error(`runtime module-edge analyzer could not bind ${filename}`);
  return { checker: program.getTypeChecker(), sourceFile };
}

function runtimeExpressionEnvelope(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (true) {
    const parent = current.parent;
    if (
      (ts.isParenthesizedExpression(parent) ||
        ts.isAsExpression(parent) ||
        ts.isTypeAssertionExpression(parent) ||
        ts.isNonNullExpression(parent) ||
        ts.isSatisfiesExpression(parent)) &&
      parent.expression === current
    ) {
      current = parent;
      continue;
    }
    return current;
  }
}

function isDirectCallTarget(expression: ts.Expression): boolean {
  const envelope = runtimeExpressionEnvelope(expression);
  return ts.isCallExpression(envelope.parent) && envelope.parent.expression === envelope;
}

function isDirectRuntimeMemberReceiver(expression: ts.Expression): boolean {
  const envelope = runtimeExpressionEnvelope(expression);
  return (
    (ts.isPropertyAccessExpression(envelope.parent) || ts.isElementAccessExpression(envelope.parent)) &&
    envelope.parent.expression === envelope
  );
}

function isRuntimeLoaderIdentifierReference(identifier: ts.Identifier): boolean {
  const parent = identifier.parent;
  if (
    (ts.isPropertyAccessExpression(parent) && parent.name === identifier) ||
    ((ts.isPropertyAssignment(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isMethodSignature(parent)) &&
      parent.name === identifier) ||
    (ts.isBindingElement(parent) && (parent.name === identifier || parent.propertyName === identifier)) ||
    ((ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isClassExpression(parent) ||
      ts.isTypeAliasDeclaration(parent) ||
      ts.isInterfaceDeclaration(parent) ||
      ts.isTypeParameterDeclaration(parent) ||
      ts.isImportClause(parent) ||
      ts.isImportSpecifier(parent) ||
      ts.isNamespaceImport(parent) ||
      ts.isImportEqualsDeclaration(parent)) &&
      parent.name === identifier) ||
    ts.isTypeReferenceNode(parent) ||
    ts.isTypeQueryNode(parent) ||
    ts.isQualifiedName(parent)
  ) {
    return false;
  }
  if (ts.isExportSpecifier(parent)) {
    const declaration = parent.parent.parent;
    if (
      parent.isTypeOnly ||
      (ts.isExportDeclaration(declaration) && (declaration.isTypeOnly || declaration.moduleSpecifier !== undefined))
    ) {
      return false;
    }
    return parent.propertyName === undefined || parent.propertyName === identifier;
  }
  return true;
}

type RuntimeCapabilityKind = "globalThis" | "module" | "process" | "vi";

function directVitestRuntimeRootSymbols(sourceFile: ts.SourceFile, checker: ts.TypeChecker): ReadonlySet<ts.Symbol> {
  const symbols = new Set<ts.Symbol>();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "vitest" ||
      statement.importClause?.isTypeOnly === true ||
      statement.importClause?.namedBindings === undefined ||
      !ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      continue;
    }
    for (const element of statement.importClause.namedBindings.elements) {
      if (!element.isTypeOnly && element.propertyName === undefined && VITEST_RUNTIME_ROOTS.has(element.name.text)) {
        const symbol = runtimeValueSymbolAt(checker, element.name);
        if (symbol !== undefined) symbols.add(symbol);
      }
    }
  }
  return symbols;
}

function ambientRuntimeIdentifier(
  expression: ts.Expression,
  name: string,
  checker: ts.TypeChecker
): expression is ts.Identifier {
  const current = unwrapRuntimeExpression(expression);
  return ts.isIdentifier(current) && current.text === name && runtimeValueSymbolAt(checker, current) === undefined;
}

function globalThisContainerExpression(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  resolving: ReadonlySet<ts.Symbol> = new Set()
): boolean {
  const current = unwrapRuntimeExpression(expression);
  if (
    ambientRuntimeIdentifier(current, "globalThis", checker) ||
    ambientRuntimeIdentifier(current, "global", checker)
  ) {
    return true;
  }
  const receiver = runtimeMemberReceiver(current);
  if (
    receiver !== undefined &&
    (runtimeMemberName(current) === "globalThis" || runtimeMemberName(current) === "global") &&
    globalThisContainerExpression(receiver, checker, resolving)
  ) {
    return true;
  }
  if (!ts.isIdentifier(current)) return false;
  const symbol = runtimeValueSymbolAt(checker, current);
  if (symbol === undefined || resolving.has(symbol)) return false;
  const declarations = symbol.declarations ?? [];
  if (declarations.length !== 1) return false;
  const declaration = declarations[0];
  if (
    declaration === undefined ||
    !ts.isVariableDeclaration(declaration) ||
    !ts.isIdentifier(declaration.name) ||
    declaration.initializer === undefined ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0
  ) {
    return false;
  }
  return globalThisContainerExpression(declaration.initializer, checker, new Set([...resolving, symbol]));
}

function runtimeCapabilityKind(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  vitestRuntimeRootSymbols: ReadonlySet<ts.Symbol>
): RuntimeCapabilityKind | undefined {
  const current = unwrapRuntimeExpression(expression);
  if (globalThisContainerExpression(current, checker)) return "globalThis";
  if (ts.isIdentifier(current)) {
    if (
      (current.text === "module" || current.text === "process") &&
      runtimeValueSymbolAt(checker, current) === undefined
    ) {
      return current.text;
    }
    if (VITEST_RUNTIME_ROOTS.has(current.text)) {
      const symbol = runtimeValueSymbolAt(checker, current);
      if (
        (current.text === "vi" && symbol === undefined) ||
        (symbol !== undefined && vitestRuntimeRootSymbols.has(symbol))
      ) {
        return "vi";
      }
    }
    return undefined;
  }
  const receiver = runtimeMemberReceiver(current);
  if (receiver === undefined) return undefined;
  const memberName = runtimeMemberName(current);
  const receiverCapability = runtimeCapabilityKind(receiver, checker, vitestRuntimeRootSymbols);
  if (receiverCapability === "globalThis") {
    if (memberName === "globalThis") return "globalThis";
    return memberName === "module" || memberName === "process" || memberName === "vi" ? memberName : undefined;
  }
  if (memberName === "mainModule" && receiverCapability === "process") {
    return "module";
  }
  return undefined;
}

function bindingElementSource(binding: ts.BindingElement): ts.Expression | undefined {
  const pattern = binding.parent;
  if (!ts.isObjectBindingPattern(pattern)) return undefined;
  const declaration = pattern.parent;
  return ts.isVariableDeclaration(declaration) && declaration.name === pattern ? declaration.initializer : undefined;
}

interface RuntimeCapabilityDestructuringMember {
  readonly rest: boolean;
  readonly staticName?: string;
}

function runtimeCapabilityDestructuringMembers(
  expression: ts.Expression
): readonly RuntimeCapabilityDestructuringMember[] | undefined {
  const envelope = runtimeExpressionEnvelope(expression);
  const parent = envelope.parent;
  if (ts.isVariableDeclaration(parent) && parent.initializer === envelope && ts.isObjectBindingPattern(parent.name)) {
    return parent.name.elements.map((element) => ({
      rest: element.dotDotDotToken !== undefined,
      staticName:
        element.propertyName !== undefined
          ? runtimeStaticPropertyName(element.propertyName)
          : ts.isIdentifier(element.name)
            ? element.name.text
            : undefined
    }));
  }
  if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    parent.right === envelope
  ) {
    const left = unwrapRuntimeExpression(parent.left);
    if (!ts.isObjectLiteralExpression(left)) return undefined;
    return left.properties.map((property) => {
      if (ts.isSpreadAssignment(property)) return { rest: true };
      if (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) {
        return { rest: false, staticName: runtimeStaticPropertyName(property.name) };
      }
      return { rest: false };
    });
  }
  return undefined;
}

function runtimeCapabilityMemberIsLoader(capability: RuntimeCapabilityKind, memberName: string): boolean {
  if (capability === "globalThis") return GLOBAL_THIS_RUNTIME_CAPABILITIES.has(memberName);
  if (capability === "module") return MODULE_RUNTIME_LOADER_MEMBERS.has(memberName);
  if (capability === "process") return PROCESS_RUNTIME_LOADER_MEMBERS.has(memberName);
  return VITEST_RUNTIME_LOADERS.has(memberName);
}

function capabilityDestructuringAssignmentResultIsDiscarded(expression: ts.Expression): boolean {
  const sourceEnvelope = runtimeExpressionEnvelope(expression);
  const destructuringOwner = sourceEnvelope.parent;
  if (
    !ts.isBinaryExpression(destructuringOwner) ||
    destructuringOwner.operatorToken.kind !== ts.SyntaxKind.EqualsToken
  ) {
    return true;
  }
  const assignmentEnvelope = runtimeExpressionEnvelope(destructuringOwner);
  const resultConsumer = assignmentEnvelope.parent;
  return (
    (ts.isExpressionStatement(resultConsumer) && resultConsumer.expression === assignmentEnvelope) ||
    (ts.isVoidExpression(resultConsumer) && resultConsumer.expression === assignmentEnvelope)
  );
}

function safeObjectDestructuringFromCapability(expression: ts.Expression, capability: RuntimeCapabilityKind): boolean {
  const members = runtimeCapabilityDestructuringMembers(expression);
  if (!capabilityDestructuringAssignmentResultIsDiscarded(expression)) return false;
  return (
    members?.every(
      (member) =>
        !member.rest &&
        member.staticName !== undefined &&
        !runtimeCapabilityMemberIsLoader(capability, member.staticName)
    ) ?? false
  );
}

function runtimeLoaderImportProblems(filename: string, declaration: ts.ImportDeclaration): string[] {
  const moduleName = stringLiteralValue(declaration.moduleSpecifier);
  const clause = declaration.importClause;
  if (moduleName === undefined || clause === undefined || clause.isTypeOnly) return [];
  const problems: string[] = [];
  const bindings = clause.namedBindings;
  if (moduleName === "node:module" || moduleName === "module") {
    if (clause.name !== undefined || (bindings !== undefined && ts.isNamespaceImport(bindings))) {
      problems.push(`${filename} acquires createRequire-capable node:module outside the reviewed static import graph`);
    }
    if (bindings !== undefined && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        const importedName = element.propertyName?.text ?? element.name.text;
        if (!element.isTypeOnly && NODE_MODULE_RUNTIME_LOADER_EXPORTS.has(importedName)) {
          problems.push(
            importedName === "createRequire"
              ? `${filename} acquires createRequire outside the reviewed static import graph`
              : `${filename} acquires createRequire-capable node:module export ${importedName} outside the static graph`
          );
        }
      }
    }
  }
  if (moduleName === "vitest") {
    if (clause.name !== undefined || (bindings !== undefined && ts.isNamespaceImport(bindings))) {
      problems.push(`${filename} acquires a Vitest runtime loader namespace outside the reviewed static import graph`);
    }
    if (bindings !== undefined && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        const importedName = element.propertyName?.text ?? element.name.text;
        const directRuntimeRoot =
          !element.isTypeOnly &&
          VITEST_RUNTIME_ROOTS.has(importedName) &&
          element.propertyName === undefined &&
          element.name.text === importedName;
        if (
          !element.isTypeOnly &&
          ((VITEST_RUNTIME_ROOTS.has(importedName) && !directRuntimeRoot) || VITEST_RUNTIME_LOADERS.has(importedName))
        ) {
          problems.push(
            `${filename} acquires Vitest runtime loader ${importedName} outside the reviewed static import graph`
          );
        }
      }
    }
  }
  return problems;
}

function runtimeModuleEdges(filename: string, source: string): RuntimeModuleEdges {
  const scriptKind = filename.endsWith(".mjs") || filename.endsWith(".cjs") ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const { checker, sourceFile } = bindRuntimeModuleSource(filename, source, scriptKind);
  const vitestRuntimeRootSymbols = directVitestRuntimeRootSymbols(sourceFile, checker);
  const specifiers: string[] = [];
  const problems: string[] = [];
  const addLiteral = (expression: ts.Expression | undefined, kind: string): string | undefined => {
    const specifier = stringLiteralValue(expression);
    if (specifier === undefined) {
      problems.push(`${filename} uses a nonliteral ${kind} loader`);
    } else {
      specifiers.push(specifier);
    }
    return specifier;
  };
  const rejectLoaderNamespace = (specifier: string | undefined, kind: string): void => {
    if (specifier === "node:module" || specifier === "module" || specifier === "vitest") {
      problems.push(`${filename} acquires runtime loader namespace ${specifier} through ${kind}`);
    }
  };
  const visit = (node: ts.Node): void => {
    if (isErasedRuntimeModuleNode(node)) return;
    if (ts.isImportDeclaration(node) && importClauseHasRuntimeValue(node.importClause)) {
      addLiteral(node.moduleSpecifier, "import");
      problems.push(...runtimeLoaderImportProblems(filename, node));
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      exportDeclarationHasRuntimeValue(node)
    ) {
      rejectLoaderNamespace(addLiteral(node.moduleSpecifier, "export"), "re-export");
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      !node.isTypeOnly &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      rejectLoaderNamespace(addLiteral(node.moduleReference.expression, "import-equals"), "import-equals");
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        rejectLoaderNamespace(addLiteral(node.arguments[0], "dynamic import"), "dynamic import");
      } else {
        const callee = unwrapRuntimeExpression(node.expression);
        if (ambientRuntimeIdentifier(callee, "require", checker)) {
          rejectLoaderNamespace(addLiteral(node.arguments[0], "require"), "require");
        } else if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
          const receiver = runtimeMemberReceiver(callee);
          const directGlobalRequire =
            receiver !== undefined &&
            runtimeCapabilityKind(receiver, checker, vitestRuntimeRootSymbols) === "globalThis" &&
            runtimeMemberName(callee) === "require";
          const capability =
            receiver === undefined ? undefined : runtimeCapabilityKind(receiver, checker, vitestRuntimeRootSymbols);
          const memberName = runtimeMemberName(callee);
          if (directGlobalRequire) {
            rejectLoaderNamespace(addLiteral(node.arguments[0], "globalThis.require"), "globalThis.require");
          } else if (capability === "module" && memberName === "require") {
            rejectLoaderNamespace(addLiteral(node.arguments[0], "module.require"), "module.require");
          } else if (capability === "vi" && memberName !== undefined && VITEST_RUNTIME_LOADERS.has(memberName)) {
            addLiteral(node.arguments[0], `vi.${memberName}`);
          }
        }
      }
    }
    if (
      ts.isIdentifier(node) &&
      node.text === "require" &&
      runtimeValueSymbolAt(checker, node) === undefined &&
      isRuntimeLoaderIdentifierReference(node)
    ) {
      if (!isDirectCallTarget(node)) {
        problems.push(`${filename} uses require as a first-class loader value outside the reviewed static graph`);
      }
    }
    if (ts.isIdentifier(node) && isRuntimeLoaderIdentifierReference(node)) {
      const capability = runtimeCapabilityKind(node, checker, vitestRuntimeRootSymbols);
      if (
        capability !== undefined &&
        capability !== "globalThis" &&
        !isDirectRuntimeMemberReceiver(node) &&
        !safeObjectDestructuringFromCapability(node, capability)
      ) {
        problems.push(`${filename} acquires first-class ${capability} runtime capability outside the static graph`);
      }
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const projectedCapability = runtimeCapabilityKind(node, checker, vitestRuntimeRootSymbols);
      if (
        projectedCapability !== undefined &&
        projectedCapability !== "globalThis" &&
        !isDirectRuntimeMemberReceiver(node) &&
        !safeObjectDestructuringFromCapability(node, projectedCapability)
      ) {
        problems.push(
          `${filename} acquires first-class ${projectedCapability} runtime capability outside the static graph`
        );
      }
      const memberName = runtimeMemberName(node);
      const memberReceiver = runtimeMemberReceiver(node);
      const capability =
        memberReceiver === undefined
          ? undefined
          : runtimeCapabilityKind(memberReceiver, checker, vitestRuntimeRootSymbols);
      const directGlobalRequire =
        memberReceiver !== undefined &&
        runtimeCapabilityKind(memberReceiver, checker, vitestRuntimeRootSymbols) === "globalThis" &&
        memberName === "require";
      if (directGlobalRequire && !isDirectCallTarget(node)) {
        problems.push(`${filename} acquires a first-class runtime loader outside the reviewed static import graph`);
      } else if (capability !== undefined && memberName === undefined) {
        problems.push(`${filename} uses a dynamic ${capability} capability member outside the static graph`);
      } else if (capability === "process" && memberName === "getBuiltinModule") {
        problems.push(`${filename} uses process.getBuiltinModule outside the reviewed static import graph`);
      } else if (
        capability === "module" &&
        memberName !== undefined &&
        MODULE_RUNTIME_LOADER_MEMBERS.has(memberName) &&
        memberName !== "require"
      ) {
        problems.push(
          memberName === "createRequire"
            ? `${filename} acquires createRequire outside the reviewed static import graph`
            : `${filename} acquires module runtime loader member ${memberName} outside the static graph`
        );
      } else if (
        (capability === "module" && memberName === "require" && !isDirectCallTarget(node)) ||
        (capability === "vi" &&
          memberName !== undefined &&
          VITEST_RUNTIME_LOADERS.has(memberName) &&
          !isDirectCallTarget(node))
      ) {
        problems.push(`${filename} acquires a first-class runtime loader outside the reviewed static import graph`);
      }
    }
    if (ts.isBindingElement(node)) {
      const staticName =
        node.propertyName !== undefined
          ? runtimeStaticPropertyName(node.propertyName)
          : ts.isIdentifier(node.name)
            ? node.name.text
            : undefined;
      const sourceExpression = bindingElementSource(node);
      const sourceCapability =
        sourceExpression === undefined
          ? undefined
          : runtimeCapabilityKind(sourceExpression, checker, vitestRuntimeRootSymbols);
      if (sourceCapability !== undefined && node.dotDotDotToken !== undefined) {
        problems.push(`${filename} dynamically destructures a runtime capability outside the static import graph`);
      } else if (
        sourceCapability !== undefined &&
        staticName !== undefined &&
        runtimeCapabilityMemberIsLoader(sourceCapability, staticName)
      ) {
        problems.push(`${filename} destructures a runtime loader outside the reviewed static import graph`);
      } else if (sourceCapability !== undefined && staticName === undefined) {
        problems.push(`${filename} dynamically destructures a runtime capability outside the static import graph`);
      }
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const sourceCapability = runtimeCapabilityKind(node.right, checker, vitestRuntimeRootSymbols);
      const members = runtimeCapabilityDestructuringMembers(node.right);
      if (sourceCapability !== undefined && members !== undefined) {
        if (!capabilityDestructuringAssignmentResultIsDiscarded(node.right)) {
          problems.push(
            `${filename} preserves a ${sourceCapability} runtime capability through assignment destructuring`
          );
        }
        for (const member of members) {
          if (member.rest || member.staticName === undefined) {
            problems.push(`${filename} dynamically destructures a runtime capability outside the static import graph`);
          } else if (runtimeCapabilityMemberIsLoader(sourceCapability, member.staticName)) {
            problems.push(`${filename} destructures a runtime loader outside the reviewed static import graph`);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { specifiers, problems };
}

function setupOptionalImportProblems(source: string): string[] {
  const sourceFile = ts.createSourceFile("tests/setup.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const problems: string[] = [];
  const expectedOptionalDeps = [
    "@huggingface/transformers",
    "pdfjs-dist",
    "tesseract.js",
    "@napi-rs/canvas",
    "hnswlib-node",
    "better-sqlite3"
  ];
  const declarations: ts.VariableDeclaration[] = [];
  const dynamicImports: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "optionalDeps") {
      declarations.push(node);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      dynamicImports.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  const declaration = declarations[0];
  const initializer = declaration?.initializer;
  const actualOptionalDeps =
    initializer !== undefined && ts.isArrayLiteralExpression(initializer)
      ? initializer.elements.map((element) => stringLiteralValue(element as ts.Expression) ?? "<nonliteral>")
      : [];
  if (declarations.length !== 1 || !isDeepStrictEqual(actualOptionalDeps, expectedOptionalDeps)) {
    problems.push("tests/setup.ts must retain the exact reviewed optional dependency import census");
  }
  const dynamicImport = dynamicImports[0];
  const dynamicArgument = dynamicImport?.arguments[0];
  const catchAccess = dynamicImport?.parent;
  const catchCall = catchAccess?.parent;
  const arrow = catchCall?.parent;
  const parameter = arrow !== undefined && ts.isArrowFunction(arrow) ? arrow.parameters[0] : undefined;
  const mapCall = arrow?.parent;
  const mapAccess = mapCall !== undefined && ts.isCallExpression(mapCall) ? mapCall.expression : undefined;
  const exactDynamicWarmup =
    dynamicImports.length === 1 &&
    dynamicArgument !== undefined &&
    ts.isIdentifier(dynamicArgument) &&
    dynamicArgument.text === "spec" &&
    catchAccess !== undefined &&
    ts.isPropertyAccessExpression(catchAccess) &&
    catchAccess.expression === dynamicImport &&
    catchAccess.name.text === "catch" &&
    catchCall !== undefined &&
    ts.isCallExpression(catchCall) &&
    catchCall.expression === catchAccess &&
    arrow !== undefined &&
    ts.isArrowFunction(arrow) &&
    arrow.body === catchCall &&
    arrow.parameters.length === 1 &&
    parameter !== undefined &&
    ts.isIdentifier(parameter.name) &&
    parameter.name.text === "spec" &&
    mapCall !== undefined &&
    ts.isCallExpression(mapCall) &&
    mapCall.arguments.length === 1 &&
    mapCall.arguments[0] === arrow &&
    mapAccess !== undefined &&
    ts.isPropertyAccessExpression(mapAccess) &&
    ts.isIdentifier(mapAccess.expression) &&
    mapAccess.expression.text === "optionalDeps" &&
    mapAccess.name.text === "map";
  if (!exactDynamicWarmup) {
    problems.push("tests/setup.ts must retain one exact optionalDeps.map((spec) => import(spec)) loader");
  }
  return problems;
}

function vitestBootstrapImportClosureProblems(sources: ReadonlyMap<string, string>): string[] {
  const problems: string[] = [];
  const expectedExecutableFiles = EXPECTED_VITEST_BOOTSTRAP_FILES.filter(
    (filename) => filename.endsWith(".mjs") || filename.endsWith(".ts")
  ).sort();
  const reviewedFiles = [...EXPECTED_VITEST_BOOTSTRAP_RUNTIME_IMPORTS.keys()].sort();
  if (
    !isDeepStrictEqual(reviewedFiles, expectedExecutableFiles) ||
    !isDeepStrictEqual([...sources.keys()].sort(), reviewedFiles)
  ) {
    problems.push("trusted Vitest bootstrap runtime import source census must remain exact");
  }
  for (const [filename, expectedSpecifiers] of EXPECTED_VITEST_BOOTSTRAP_RUNTIME_IMPORTS) {
    const source = sources.get(filename);
    if (source === undefined) {
      problems.push(`trusted Vitest bootstrap import closure is missing ${filename}`);
      continue;
    }
    const edges = runtimeModuleEdges(filename, source);
    const edgeProblems =
      filename === "tests/setup.ts"
        ? edges.problems.filter((problem) => problem !== "tests/setup.ts uses a nonliteral dynamic import loader")
        : edges.problems;
    problems.push(...edgeProblems);
    if (!isDeepStrictEqual([...edges.specifiers].sort(), [...expectedSpecifiers].sort())) {
      problems.push(`${filename} runtime import census must remain exact`);
    }
    for (const specifier of edges.specifiers.filter((candidate) => candidate.startsWith("."))) {
      const normalized = path.posix.normalize(path.posix.join(path.posix.dirname(filename), specifier));
      if (!EXPECTED_VITEST_BOOTSTRAP_FILES.includes(normalized)) {
        problems.push(`${filename} runtime import escapes the trusted bootstrap receipt: ${specifier}`);
      }
    }
    if (filename === "tests/setup.ts") problems.push(...setupOptionalImportProblems(source));
  }
  return problems;
}

async function readVitestBootstrapImportSources(root: string): Promise<Map<string, string>> {
  const sources = new Map<string, string>();
  for (const filename of EXPECTED_VITEST_BOOTSTRAP_RUNTIME_IMPORTS.keys()) {
    sources.set(filename, await fs.readFile(path.join(root, ...filename.split("/")), "utf8"));
  }
  return sources;
}

async function copyVitestBootstrapFixture(sourceRoot: string, targetRoot: string): Promise<void> {
  const files = [...EXPECTED_VITEST_BOOTSTRAP_FILES, VITEST_BOOTSTRAP_MANIFEST];
  for (const filename of files) {
    const target = path.join(targetRoot, ...filename.split("/"));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(sourceRoot, ...filename.split("/")), target);
  }
}

async function writeVitestBootstrapManifest(root: string): Promise<string> {
  const lines: string[] = [];
  for (const filename of EXPECTED_VITEST_BOOTSTRAP_FILES) {
    const absolute = path.join(root, ...filename.split("/"));
    const digest =
      filename === ".github/workflows/ci.yml"
        ? ciWorkflowReceiptDigest(await fs.readFile(absolute, "utf8"))
        : createHash("sha256")
            .update(await fs.readFile(absolute))
            .digest("hex");
    lines.push(`${digest}  ${filename}`);
  }
  const manifest = `${lines.join("\n")}\n`;
  await fs.writeFile(path.join(root, ...VITEST_BOOTSTRAP_MANIFEST.split("/")), manifest);
  return createHash("sha256").update(manifest).digest("hex");
}

async function updateVitestBootstrapCarrier(root: string, manifestDigest: string): Promise<void> {
  const ciPath = path.join(root, ".github", "workflows", "ci.yml");
  const ciSource = await fs.readFile(ciPath, "utf8");
  const carriers = [...ciSource.matchAll(/^ {10}expected_manifest_sha=([0-9a-f]{64})$/gmu)];
  if (carriers.length !== 1) throw new Error(`expected one bootstrap receipt carrier, found ${carriers.length}`);
  const carrier = carriers[0];
  const carrierDigest = carrier?.[1];
  if (carrierDigest === undefined) throw new Error("expected bootstrap receipt carrier digest");
  if (carrierDigest === manifestDigest) return;
  await fs.writeFile(
    ciPath,
    replaceExactly(ciSource, `expected_manifest_sha=${carrierDigest}`, `expected_manifest_sha=${manifestDigest}`)
  );
}

async function refreshVitestBootstrapReceipt(root: string): Promise<void> {
  await updateVitestBootstrapCarrier(root, await writeVitestBootstrapManifest(root));
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
      requiredClosureSource(input.closureSources, "tests/meta-invariant-coverage.test.ts"),
      "tests/meta-invariant-coverage.test.ts",
      "META-invariant: exact structural census + NEGATIVE control coverage",
      "it",
      "every *-invariant.test.ts file has NEGATIVE control OR explicit exempt marker",
      "60_000"
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
  const vitestConfigFiles = rootEntries.filter((name) => /^vitest\.(?:config|projects|workspace)\./u.test(name)).sort();
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
  const isExactImport = (node: ts.Node): node is ts.VariableStatement => {
    if (
      !ts.isVariableStatement(node) ||
      (node.declarationList.flags & ts.NodeFlags.Const) === 0 ||
      node.declarationList.declarations.length !== 1
    ) {
      return false;
    }
    const declaration = node.declarationList.declarations[0];
    const initializer = declaration?.initializer;
    const importCall =
      initializer !== undefined && ts.isAwaitExpression(initializer) ? initializer.expression : undefined;
    const importArgument =
      importCall !== undefined && ts.isCallExpression(importCall) ? importCall.arguments[0] : undefined;
    if (
      declaration === undefined ||
      !ts.isObjectBindingPattern(declaration.name) ||
      declaration.name.elements.length !== 1 ||
      importCall === undefined ||
      !ts.isCallExpression(importCall) ||
      importCall.expression.kind !== ts.SyntaxKind.ImportKeyword ||
      importCall.arguments.length !== 1 ||
      importArgument === undefined ||
      !ts.isStringLiteral(importArgument) ||
      importArgument.text !== "./lib/oia-vitest-focus.mjs"
    ) {
      return false;
    }
    const binding = declaration.name.elements[0];
    return (
      binding !== undefined &&
      binding.propertyName === undefined &&
      ts.isIdentifier(binding.name) &&
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
    const iterable = loop.expression;
    if (
      !ts.isCallExpression(iterable) ||
      !ts.isIdentifier(iterable.expression) ||
      iterable.expression.text !== "inspectRepositoryVitestFocusControls"
    ) {
      return [];
    }
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
  beforeAll(async () => {
    const focusSourceFiles = firstPartyVitestFocusSourceFiles(repoRoot);
    expect(focusSourceFiles).toEqual(await independentExecutableSourceCensus(repoRoot));
    expect(focusSourceFiles).toContain("site/site.js");
    expect(focusSourceFiles).toContain("tests/fixtures/k1-invariant/good.ts");
    expect(inspectRepositoryVitestBootstrap(repoRoot)).toEqual([]);
    expect(vitestBootstrapImportClosureProblems(await readVitestBootstrapImportSources(repoRoot))).toEqual([]);
    expect(inspectRepositoryVitestSelectionControls(repoRoot)).toEqual([]);
    const oiaSource = await fs.readFile(path.join(repoRoot, "scripts/oia-walk.mjs"), "utf8");
    expect(oiaVitestBootstrapWiringProblems(oiaSource)).toEqual([]);
    expect(oiaFocusWiringProblems(oiaSource)).toEqual([]);
    expect(oiaMarkedCheckInventoryProblems(oiaSource)).toEqual([]);
  }, 45_000);

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
  }, 45_000);

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

    const bootstrapSources = await readVitestBootstrapImportSources(repoRoot);
    const bootstrapWithUnreceiptedImport = new Map(bootstrapSources);
    bootstrapWithUnreceiptedImport.set(
      "scripts/oia-walk.mjs",
      `${bootstrapSources.get("scripts/oia-walk.mjs") ?? ""}\nawait import("./lib/unreceipted.mjs");\n`
    );
    expect(vitestBootstrapImportClosureProblems(bootstrapWithUnreceiptedImport)).toContain(
      "scripts/oia-walk.mjs runtime import census must remain exact"
    );
    expect(vitestBootstrapImportClosureProblems(bootstrapWithUnreceiptedImport)).toContain(
      "scripts/oia-walk.mjs runtime import escapes the trusted bootstrap receipt: ./lib/unreceipted.mjs"
    );
    const bootstrapWithExtraAnalyzerImport = new Map(bootstrapSources);
    bootstrapWithExtraAnalyzerImport.set(
      "scripts/lib/oia-vitest-bootstrap.mjs",
      `import { spawn } from "node:child_process";\n${bootstrapSources.get("scripts/lib/oia-vitest-bootstrap.mjs") ?? ""}`
    );
    expect(vitestBootstrapImportClosureProblems(bootstrapWithExtraAnalyzerImport)).toContain(
      "scripts/lib/oia-vitest-bootstrap.mjs runtime import census must remain exact"
    );
    const setupSource = bootstrapSources.get("tests/setup.ts");
    if (setupSource === undefined) throw new Error("expected tests/setup.ts bootstrap source");
    const bootstrapWithLocalSetupLoader = new Map(bootstrapSources);
    bootstrapWithLocalSetupLoader.set(
      "tests/setup.ts",
      replaceExactly(setupSource, '  "better-sqlite3"', '  "better-sqlite3",\n  "./local-bypass.mjs"')
    );
    expect(vitestBootstrapImportClosureProblems(bootstrapWithLocalSetupLoader)).toContain(
      "tests/setup.ts must retain the exact reviewed optional dependency import census"
    );

    const bootstrapScratch = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-vitest-bootstrap-"));
    try {
      await copyVitestBootstrapFixture(repoRoot, bootstrapScratch);
      expect(inspectRepositoryVitestBootstrap(bootstrapScratch)).toEqual([]);

      for (const filename of EXPECTED_VITEST_BOOTSTRAP_FILES) {
        const absolute = path.join(bootstrapScratch, ...filename.split("/"));
        const baseline = await fs.readFile(absolute);
        await fs.writeFile(absolute, Buffer.concat([baseline, Buffer.from(" ")]));
        expect(inspectRepositoryVitestBootstrap(bootstrapScratch)).toContainEqual(
          expect.objectContaining({ kind: "VITEST-BOOTSTRAP-DIGEST", file: filename })
        );
        await fs.writeFile(absolute, baseline);
        expect(inspectRepositoryVitestBootstrap(bootstrapScratch)).toEqual([]);
      }

      const manifestPath = path.join(bootstrapScratch, ...VITEST_BOOTSTRAP_MANIFEST.split("/"));
      const baselineManifest = await fs.readFile(manifestPath, "utf8");
      await fs.writeFile(manifestPath, `A${baselineManifest.slice(1)}`);
      expect(inspectRepositoryVitestBootstrap(bootstrapScratch)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "VITEST-BOOTSTRAP-MANIFEST" }),
          expect.objectContaining({ kind: "VITEST-BOOTSTRAP-CI-CARRIER" })
        ])
      );
      await fs.writeFile(manifestPath, baselineManifest);

      const unterminatedTrailerManifest = `${baselineManifest}TRAILER`;
      await fs.writeFile(manifestPath, unterminatedTrailerManifest);
      await updateVitestBootstrapCarrier(
        bootstrapScratch,
        createHash("sha256").update(unterminatedTrailerManifest).digest("hex")
      );
      expect(inspectRepositoryVitestBootstrap(bootstrapScratch)).toContainEqual(
        expect.objectContaining({ kind: "VITEST-BOOTSTRAP-MANIFEST" })
      );
      await refreshVitestBootstrapReceipt(bootstrapScratch);

      const orderedReceiptLines = baselineManifest.split("\n").filter(Boolean);
      const firstReceiptLine = orderedReceiptLines[0];
      const secondReceiptLine = orderedReceiptLines[1];
      if (firstReceiptLine === undefined || secondReceiptLine === undefined) {
        throw new Error("expected at least two bootstrap receipt lines");
      }
      const reorderedManifest = `${[secondReceiptLine, firstReceiptLine, ...orderedReceiptLines.slice(2)].join(
        "\n"
      )}\n`;
      await fs.writeFile(manifestPath, reorderedManifest);
      await updateVitestBootstrapCarrier(
        bootstrapScratch,
        createHash("sha256").update(reorderedManifest).digest("hex")
      );
      expect(inspectRepositoryVitestBootstrap(bootstrapScratch)).toContainEqual(
        expect.objectContaining({ kind: "VITEST-BOOTSTRAP-CENSUS" })
      );
      await refreshVitestBootstrapReceipt(bootstrapScratch);

      const normalizedReceiptLines = (await fs.readFile(manifestPath, "utf8")).split("\n").filter(Boolean);
      const workflowReceiptLine = normalizedReceiptLines.at(-1);
      if (workflowReceiptLine === undefined) {
        throw new Error("expected normalized CI workflow receipt line");
      }
      const ciFixturePath = path.join(bootstrapScratch, ".github", "workflows", "ci.yml");
      const rawWorkflowDigest = createHash("sha256")
        .update(await fs.readFile(ciFixturePath))
        .digest("hex");
      const rawWorkflowManifest = `${[
        ...normalizedReceiptLines.slice(0, -1),
        `${rawWorkflowDigest}  .github/workflows/ci.yml`
      ].join("\n")}\n`;
      await fs.writeFile(manifestPath, rawWorkflowManifest);
      await updateVitestBootstrapCarrier(
        bootstrapScratch,
        createHash("sha256").update(rawWorkflowManifest).digest("hex")
      );
      expect(inspectRepositoryVitestBootstrap(bootstrapScratch)).toContainEqual(
        expect.objectContaining({ kind: "VITEST-BOOTSTRAP-DIGEST", file: ".github/workflows/ci.yml" })
      );
      await refreshVitestBootstrapReceipt(bootstrapScratch);

      const setupPath = path.join(bootstrapScratch, "tests", "setup.ts");
      const baselineSetup = await fs.readFile(setupPath, "utf8");
      await fs.writeFile(setupPath, `${baselineSetup}\n// reviewed receipt transition probe\n`);
      const changedManifestDigest = await writeVitestBootstrapManifest(bootstrapScratch);
      expect(inspectRepositoryVitestBootstrap(bootstrapScratch)).toContainEqual(
        expect.objectContaining({ kind: "VITEST-BOOTSTRAP-CI-CARRIER" })
      );
      await updateVitestBootstrapCarrier(bootstrapScratch, changedManifestDigest);
      expect(inspectRepositoryVitestBootstrap(bootstrapScratch)).toEqual([]);
      await fs.writeFile(setupPath, baselineSetup);
      await refreshVitestBootstrapReceipt(bootstrapScratch);

      const analyzerPath = path.join(bootstrapScratch, "scripts", "lib", "oia-vitest-bootstrap.mjs");
      const baselineAnalyzer = await fs.readFile(analyzerPath, "utf8");
      await fs.writeFile(analyzerPath, `import {\n  spawn\n} from "node:child_process";\n${baselineAnalyzer}`);
      await refreshVitestBootstrapReceipt(bootstrapScratch);
      expect(inspectRepositoryVitestBootstrap(bootstrapScratch)).toContainEqual(
        expect.objectContaining({ kind: "VITEST-BOOTSTRAP-ANALYZER" })
      );
      await fs.writeFile(analyzerPath, baselineAnalyzer);
      await refreshVitestBootstrapReceipt(bootstrapScratch);

      const oiaPath = path.join(bootstrapScratch, "scripts", "oia-walk.mjs");
      const baselineOia = await fs.readFile(oiaPath, "utf8");
      await fs.writeFile(
        oiaPath,
        replaceExactly(
          baselineOia,
          "const initialVitestBootstrapFindings = inspectRepositoryVitestBootstrap(repoRoot);",
          "const initialVitestBootstrapFindings = [];"
        )
      );
      await refreshVitestBootstrapReceipt(bootstrapScratch);
      expect(inspectRepositoryVitestBootstrap(bootstrapScratch)).toContainEqual(
        expect.objectContaining({ kind: "VITEST-BOOTSTRAP-OIA-WIRING" })
      );
      await fs.writeFile(oiaPath, baselineOia);
      await refreshVitestBootstrapReceipt(bootstrapScratch);

      const receiptLines = (await fs.readFile(manifestPath, "utf8")).split("\n").filter(Boolean);
      const omittedManifest = `${receiptLines.slice(0, -1).join("\n")}\n`;
      await fs.writeFile(manifestPath, omittedManifest);
      await updateVitestBootstrapCarrier(bootstrapScratch, createHash("sha256").update(omittedManifest).digest("hex"));
      expect(inspectRepositoryVitestBootstrap(bootstrapScratch)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "VITEST-BOOTSTRAP-MANIFEST" }),
          expect.objectContaining({ kind: "VITEST-BOOTSTRAP-CENSUS" })
        ])
      );
      await refreshVitestBootstrapReceipt(bootstrapScratch);

      const ciPath = path.join(bootstrapScratch, ".github", "workflows", "ci.yml");
      const baselineCi = await fs.readFile(ciPath, "utf8");
      const baselineCarrier = /^ {10}expected_manifest_sha=([0-9a-f]{64})$/mu.exec(baselineCi)?.[0];
      if (baselineCarrier === undefined) throw new Error("expected baseline CI receipt carrier");
      const alternateCarrier = baselineCarrier.endsWith("f".repeat(64))
        ? `          expected_manifest_sha=${"e".repeat(64)}`
        : `          expected_manifest_sha=${"f".repeat(64)}`;
      await fs.writeFile(ciPath, replaceExactly(baselineCi, baselineCarrier, alternateCarrier));
      const carrierOnlyFindings = inspectRepositoryVitestBootstrap(bootstrapScratch);
      expect(carrierOnlyFindings).toContainEqual(
        expect.objectContaining({ kind: "VITEST-BOOTSTRAP-CI-CARRIER", file: ".github/workflows/ci.yml" })
      );
      expect(carrierOnlyFindings).not.toContainEqual(
        expect.objectContaining({ kind: "VITEST-BOOTSTRAP-DIGEST", file: ".github/workflows/ci.yml" })
      );
      await fs.writeFile(ciPath, baselineCi);
      for (const invalidCarrier of [
        replaceExactly(baselineCarrier, "          expected_manifest_sha=", "         expected_manifest_sha="),
        `${baselineCarrier}\n${baselineCarrier}`
      ]) {
        await fs.writeFile(ciPath, replaceExactly(baselineCi, baselineCarrier, invalidCarrier));
        expect(inspectRepositoryVitestBootstrap(bootstrapScratch)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: "VITEST-BOOTSTRAP-DIGEST",
              file: ".github/workflows/ci.yml"
            }),
            expect.objectContaining({
              kind: "VITEST-BOOTSTRAP-CI-CARRIER",
              file: ".github/workflows/ci.yml"
            })
          ])
        );
      }
      const disabledTestCi = replaceExactly(
        baselineCi,
        "      - run: npm test\n        env:",
        "      - run: true\n        env:"
      );
      await fs.writeFile(ciPath, disabledTestCi);
      expect(inspectRepositoryVitestBootstrap(bootstrapScratch)).toContainEqual(
        expect.objectContaining({ kind: "VITEST-BOOTSTRAP-DIGEST", file: ".github/workflows/ci.yml" })
      );
      const staleCarrierManifestLines = (await fs.readFile(manifestPath, "utf8")).split("\n").filter(Boolean);
      const updatedWorkflowManifest = `${[
        ...staleCarrierManifestLines.slice(0, -1),
        `${ciWorkflowReceiptDigest(disabledTestCi)}  .github/workflows/ci.yml`
      ].join("\n")}\n`;
      await fs.writeFile(manifestPath, updatedWorkflowManifest);
      expect(inspectRepositoryVitestBootstrap(bootstrapScratch)).toContainEqual(
        expect.objectContaining({ kind: "VITEST-BOOTSTRAP-CI-CARRIER", file: ".github/workflows/ci.yml" })
      );
      await updateVitestBootstrapCarrier(
        bootstrapScratch,
        createHash("sha256").update(updatedWorkflowManifest).digest("hex")
      );
      expect(inspectRepositoryVitestBootstrap(bootstrapScratch)).toEqual([]);
      expect(ciTestSelectionProblems(await fs.readFile(ciPath, "utf8"))).toContain(
        "each CI Node leg must end with one exact unfiltered fail-capable npm test"
      );
      await fs.writeFile(ciPath, baselineCi);
      await refreshVitestBootstrapReceipt(bootstrapScratch);
      await fs.writeFile(ciPath, replaceExactly(baselineCi, "    timeout-minutes: 5", "    timeout-minutes: 4"));
      expect(inspectRepositoryVitestBootstrap(bootstrapScratch)).toContainEqual(
        expect.objectContaining({ kind: "VITEST-BOOTSTRAP-CI-SHAPE" })
      );
      await fs.writeFile(ciPath, baselineCi);

      await fs.writeFile(path.join(bootstrapScratch, ".env.example"), "inert=true\n");
      await fs.writeFile(path.join(bootstrapScratch, "vite.config.ts"), "export default {};\n");
      expect(inspectRepositoryVitestBootstrap(bootstrapScratch)).toEqual([]);
      await fs.writeFile(path.join(bootstrapScratch, ".env.test"), "VITEST_BYPASS=true\n");
      expect(inspectRepositoryVitestBootstrap(bootstrapScratch)).toContainEqual(
        expect.objectContaining({ kind: "VITEST-BOOTSTRAP-ROOT-INPUT", file: ".env.test" })
      );
      await fs.rm(path.join(bootstrapScratch, ".env.test"));
      await fs.writeFile(path.join(bootstrapScratch, "vitest.workspace.ts"), "export default [];\n");
      expect(inspectRepositoryVitestBootstrap(bootstrapScratch)).toContainEqual(
        expect.objectContaining({ kind: "VITEST-BOOTSTRAP-CONFIG-CENSUS" })
      );
      await fs.rm(path.join(bootstrapScratch, "vitest.workspace.ts"));

      if (process.platform !== "win32") {
        const focusPath = path.join(bootstrapScratch, "scripts", "lib", "oia-vitest-focus.mjs");
        const focusBytes = await fs.readFile(focusPath);
        await fs.rm(focusPath);
        await fs.symlink("oia-vitest-selection.mjs", focusPath);
        expect(inspectRepositoryVitestBootstrap(bootstrapScratch)).toContainEqual(
          expect.objectContaining({ kind: "VITEST-BOOTSTRAP-PHYSICAL-PATH" })
        );
        await fs.rm(focusPath);
        await fs.writeFile(focusPath, focusBytes);
      }
    } finally {
      await fs.rm(bootstrapScratch, { recursive: true, force: true });
    }

    const currentOiaSource = await fs.readFile(path.join(repoRoot, "scripts/oia-walk.mjs"), "utf8");
    const oiaWithoutEarlyBootstrap = replaceExactly(
      currentOiaSource,
      "const initialVitestBootstrapFindings = inspectRepositoryVitestBootstrap(repoRoot);",
      "const initialVitestBootstrapFindings = [];"
    );
    expect(oiaVitestBootstrapWiringProblems(oiaWithoutEarlyBootstrap)).toContain(
      "OIA must retain one exact builtins-only bootstrap prologue before dynamic imports"
    );
    const oiaWithPreBootstrapImport = replaceExactly(
      currentOiaSource,
      'import { createHash } from "node:crypto";',
      'import "./lib/unreceipted.mjs";\nimport { createHash } from "node:crypto";'
    );
    expect(oiaVitestBootstrapWiringProblems(oiaWithPreBootstrapImport)).toContain(
      "OIA must retain one exact builtins-only bootstrap prologue before dynamic imports"
    );
    const oiaWithoutBootstrapTail = replaceExactly(
      currentOiaSource,
      '    "VITEST-BOOTSTRAP-SCAN-ERROR",',
      '    "VITEST-BOOTSTRAP-SCAN-IGNORED",'
    );
    expect(oiaVitestBootstrapWiringProblems(oiaWithoutBootstrapTail)).toContain(
      "OIA must retain one exact fail-closed post-walk bootstrap re-scan"
    );
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
      OIA_FOCUS_LOOP,
      `  ${OIA_FOCUS_CALL} {\n    void finding;\n  }`
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
    expect(packageTestSelectionProblems("{")).toEqual(["package.json must remain valid JSON"]);
    expect(ciTestSelectionProblems("jobs: [")).toEqual(["CI workflow must remain valid YAML"]);
    expect(vitestSelectionProblems("export default {", ["vitest.config.ts"])).toEqual([
      expect.stringMatching(/^vitest config must parse without diagnostics:/u)
    ]);
    expect(forbiddenNpmProjectEntries([])).toEqual([]);
    expect(forbiddenNpmProjectEntries(["package.json", "npm-shrinkwrap.json", ".npmrc", "binding.gyp"])).toEqual([
      ".npmrc",
      "binding.gyp",
      "npm-shrinkwrap.json"
    ]);
    const selectionCensusScratch = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-selection-census-"));
    try {
      await fs.mkdir(path.join(selectionCensusScratch, "vitest.config.ts"));
      expect(() => inspectRepositoryVitestSelectionControls(selectionCensusScratch)).toThrow(
        "Vitest config census refuses non-regular entry vitest.config.ts"
      );
    } finally {
      await fs.rm(selectionCensusScratch, { recursive: true, force: true });
    }
    const exactBuildEntry = `"build": "${EXPECTED_BUILD_SCRIPT}"`;
    const packageWithFilteredBuild = replaceExactly(
      current.packageJson,
      exactBuildEntry,
      `"build": "${EXPECTED_BUILD_SCRIPT} && node scripts/rewrite-vitest-config.mjs"`
    );
    expect(packageCoverageProblems(packageWithFilteredBuild)).toContain(
      "package scripts.build must remain the exact reviewed pre-test build"
    );
    const exactPrepareEntry = `"prepare": "${EXPECTED_PREPARE_SCRIPT}"`;
    const packageWithJobFilteredPrepare = replaceExactly(
      current.packageJson,
      exactPrepareEntry,
      `"prepare": "${EXPECTED_PREPARE_SCRIPT} && node scripts/rewrite-vitest-config.mjs"`
    );
    expect(packageCoverageProblems(packageWithJobFilteredPrepare)).toContain(
      "package scripts.prepare must remain the exact reviewed install bootstrap"
    );
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
    for (const lifecycle of FORBIDDEN_REQUIRED_RUN_LIFECYCLE_SCRIPTS) {
      const packageWithLifecycleHook = replaceExactly(
        current.packageJson,
        '    "test": "vitest run",',
        `    "${lifecycle}": "printf fail-open",\n    "test": "vitest run",`
      );
      expect(packageCoverageProblems(packageWithLifecycleHook)).toContain(
        "package install/build/test lifecycle hooks must remain absent"
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
    const vitestWithNameFilter = replaceExactly(
      current.vitestConfig,
      '    include: ["tests/**/*.test.ts"],\n',
      '    include: ["tests/**/*.test.ts"],\n' +
        "    testNamePattern: /^(?!Class A invariant — no test imports value from registration boilerplate)/,\n"
    );
    expect(currentVitestProblems(vitestWithNameFilter)).toContain(
      "vitest test config must retain its exact reviewed static key set"
    );
    const vitestWithNarrowedInclude = replaceExactly(
      current.vitestConfig,
      '    include: ["tests/**/*.test.ts"],',
      '    include: ["tests/unit.test.ts"],'
    );
    expect(currentVitestProblems(vitestWithNarrowedInclude)).toContain(
      "vitest test.include must remain the exact full test-file glob"
    );
    expect(
      vitestSelectionProblems(current.vitestConfig, [...current.vitestConfigFiles, "vitest.projects.ts"])
    ).toContain("the repository must retain one canonical vitest.config.ts");
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
    const vitestWithExecutableCoverageInitializer = replaceExactly(
      replaceExactly(current.vitestConfig, "    coverage: {\n", "    coverage: (jobGatedSideEffect(), {\n"),
      "      }\n    }\n  }\n});\n",
      "      }\n    })\n  }\n});\n"
    );
    expect(vitestSelectionProblems(vitestWithExecutableCoverageInitializer, current.vitestConfigFiles)).toContain(
      "vitest config must retain one static coverage object"
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
    const metaCensusTimeoutProblems = (source: string): string[] =>
      registrationTimeoutProblems(
        source,
        "tests/meta-invariant-coverage.test.ts",
        "META-invariant: exact structural census + NEGATIVE control coverage",
        "it",
        "every *-invariant.test.ts file has NEGATIVE control OR explicit exempt marker",
        "60_000"
      );
    const metaCensusTimeoutDiagnostic =
      "tests/meta-invariant-coverage.test.ts must retain one direct it registration with timeout 60_000";
    const raisedMetaCensusTimeout = replaceExactly(
      metaSource,
      "  }, 60_000);\n\n  // NEGATIVE control for the META-invariant itself",
      "  }, 60_001);\n\n  // NEGATIVE control for the META-invariant itself"
    );
    const missingMetaCensusTimeout = replaceExactly(
      metaSource,
      "  }, 60_000);\n\n  // NEGATIVE control for the META-invariant itself",
      "  });\n\n  // NEGATIVE control for the META-invariant itself"
    );
    const eagerMetaCensusPrefix = replaceExactly(
      metaSource,
      '  }, 720_000);\n\n  it("every *-invariant.test.ts file has NEGATIVE control OR explicit exempt marker",',
      '  }, 720_000);\n  (() => { throw new Error("abort collection"); })();\n\n' +
        '  it("every *-invariant.test.ts file has NEGATIVE control OR explicit exempt marker",'
    );
    expect(metaCensusTimeoutProblems(metaSource)).toEqual([]);
    expect(metaCensusTimeoutProblems(aliasedMetaCallee)).toContain(metaBindingDiagnostic);
    expect(metaCensusTimeoutProblems(raisedMetaCensusTimeout)).toContain(metaCensusTimeoutDiagnostic);
    expect(metaCensusTimeoutProblems(missingMetaCensusTimeout)).toContain(metaCensusTimeoutDiagnostic);
    expect(metaCensusTimeoutProblems(eagerMetaCensusPrefix)).toContain(metaCensusTimeoutDiagnostic);
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
      replaceExactly(transitionTimeoutNeedle, "60_000", "35_000")
    );
    const missingTransitionTimeout = replaceExactly(
      current.releaseMutationTransitionSource,
      transitionTimeoutNeedle,
      replaceExactly(transitionTimeoutNeedle, "}, 60_000);", "});")
    );
    const raisedTransitionTimeout = replaceExactly(
      current.releaseMutationTransitionSource,
      transitionTimeoutNeedle,
      replaceExactly(transitionTimeoutNeedle, "60_000", "60_001")
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
    const docsSuiteLocalItBindingDiagnostic =
      "tests/docs-consistency.test.ts must bind it through one direct unaliased vitest named import and no other runtime bindings; found direct 1, other 1";
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
    expect(docsTimeoutProblems(suiteLocalOptionalVarShadow)).toContain(docsSuiteLocalItBindingDiagnostic);
    expect(docsTimeoutProblems(localPrefixRegistrar)).toContain(docsTimeoutDiagnostic);
    expect(docsTimeoutProblems(eagerPrefixArgument)).toContain(docsTimeoutDiagnostic);
    const docsTimeoutNeedle = '  }, 60_000);\n\n  it("package.json description tool-count matches actual count"';
    const inheritedDocsTimeout = replaceExactly(
      current.docsConsistencySource,
      docsTimeoutNeedle,
      replaceExactly(docsTimeoutNeedle, "60_000", "15_000")
    );
    const provenInsufficientDocsTimeout = replaceExactly(
      current.docsConsistencySource,
      docsTimeoutNeedle,
      replaceExactly(docsTimeoutNeedle, "60_000", "25_000")
    );
    const underBufferedDocsTimeout = replaceExactly(
      current.docsConsistencySource,
      docsTimeoutNeedle,
      replaceExactly(docsTimeoutNeedle, "60_000", "45_000")
    );
    const missingDocsTimeout = replaceExactly(
      current.docsConsistencySource,
      docsTimeoutNeedle,
      replaceExactly(docsTimeoutNeedle, "}, 60_000);", "});")
    );
    const raisedDocsTimeout = replaceExactly(
      current.docsConsistencySource,
      docsTimeoutNeedle,
      replaceExactly(docsTimeoutNeedle, "60_000", "60_001")
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

    expect([...NODE_MODULE_RUNTIME_LOADER_EXPORTS]).toEqual(["Module", "createRequire", "default"]);
    expect([...MODULE_RUNTIME_LOADER_MEMBERS]).toEqual([
      "__proto__",
      "_compile",
      "_load",
      "children",
      "constructor",
      "createRequire",
      "load",
      "parent",
      "require"
    ]);
    expect([...GLOBAL_THIS_RUNTIME_CAPABILITIES]).toEqual([
      "global",
      "globalThis",
      "module",
      "process",
      "require",
      "vi"
    ]);
    expect([...PROCESS_RUNTIME_LOADER_MEMBERS]).toEqual(["getBuiltinModule", "mainModule"]);
    expect([...VITEST_RUNTIME_ROOTS]).toEqual(["vi", "vitest"]);
    expect([...VITEST_RUNTIME_LOADERS]).toEqual(["doMock", "importActual", "importMock", "mock"]);

    const directVitestLoader =
      'import { vi } from "vitest";\nvoid vi.importActual("./helpers/exact-source-mutation.js");';
    expect(moduleProblems("tests/release-integrity.test.ts", directVitestLoader)).toEqual([]);
    const vitestProductionImport = 'import { vi } from "vitest";\nvoid vi.importActual("../src/vault.js");';
    expect(moduleProblems("tests/release-integrity.test.ts", vitestProductionImport)).toContain(
      "tests/release-integrity.test.ts value-imports production path src/vault.js"
    );
    const directVitestRootLoader =
      'import { vitest } from "vitest";\nvoid vitest.importActual("./helpers/exact-source-mutation.js");';
    expect(moduleProblems("tests/release-integrity.test.ts", directVitestRootLoader)).toEqual([]);
    const vitestRootProductionImport = 'import { vitest } from "vitest";\nvoid vitest.importActual("../src/vault.js");';
    expect(moduleProblems("tests/release-integrity.test.ts", vitestRootProductionImport)).toContain(
      "tests/release-integrity.test.ts value-imports production path src/vault.js"
    );
    const escapedVitestRootLoader =
      'import { vitest } from "vitest";\nconst hiddenLoader = vitest.importActual; void hiddenLoader;';
    expect(moduleProblems("tests/release-integrity.test.ts", escapedVitestRootLoader)).toContain(
      "tests/release-integrity.test.ts acquires a first-class runtime loader outside the reviewed static import graph"
    );
    const aliasedVitestImport = 'import { vi as testApi } from "vitest";\nvoid testApi;';
    expect(moduleProblems("tests/release-integrity.test.ts", aliasedVitestImport)).toContain(
      "tests/release-integrity.test.ts acquires Vitest runtime loader vi outside the reviewed static import graph"
    );
    const aliasedVitestRootImport = 'import { vitest as testApi } from "vitest";\nvoid testApi;';
    expect(moduleProblems("tests/release-integrity.test.ts", aliasedVitestRootImport)).toContain(
      "tests/release-integrity.test.ts acquires Vitest runtime loader vitest outside the reviewed static import graph"
    );
    const directVitestFunctionImport = 'import { importActual } from "vitest";\nvoid importActual;';
    expect(moduleProblems("tests/release-integrity.test.ts", directVitestFunctionImport)).toContain(
      "tests/release-integrity.test.ts acquires Vitest runtime loader importActual outside the reviewed static import graph"
    );
    const typeOnlyLoaderImports =
      'import type { createRequire } from "node:module";\nimport type { vi } from "vitest";';
    expect(moduleProblems("tests/release-integrity.test.ts", typeOnlyLoaderImports)).toEqual([]);
    const createRequireLoader =
      'import { createRequire } from "node:module";\n' + "const loadCoverageModule = createRequire(import.meta.url);";
    expect(moduleProblems("tests/release-integrity.test.ts", createRequireLoader)).toContain(
      "tests/release-integrity.test.ts acquires createRequire outside the reviewed static import graph"
    );
    const aliasedCreateRequireImport = 'import { createRequire as cr } from "node:module";\nvoid cr;';
    expect(moduleProblems("tests/release-integrity.test.ts", aliasedCreateRequireImport)).toContain(
      "tests/release-integrity.test.ts acquires createRequire outside the reviewed static import graph"
    );
    const moduleConstructorImport = 'import { Module } from "node:module";\nvoid Module;';
    expect(moduleProblems("tests/release-integrity.test.ts", moduleConstructorImport)).toContain(
      "tests/release-integrity.test.ts acquires createRequire-capable node:module export Module outside the static graph"
    );
    const moduleDefaultImport = 'import { default as ModuleApi } from "node:module";\nvoid ModuleApi;';
    expect(moduleProblems("tests/release-integrity.test.ts", moduleDefaultImport)).toContain(
      "tests/release-integrity.test.ts acquires createRequire-capable node:module export default outside the static graph"
    );
    const safeNodeModuleImport = 'import { builtinModules } from "node:module";\nvoid builtinModules;';
    expect(runtimeModuleEdges("tests/release-integrity.test.ts", safeNodeModuleImport).problems).toEqual([]);
    const acquiredCreateRequireLoader = [
      'const { createRequire: cr } = process.getBuiltinModule("node:module");',
      "const hiddenRequire = cr(import.meta.url);",
      'hiddenRequire("./unreceipted.cjs");'
    ].join("\n");
    expect(moduleProblems("tests/release-integrity.test.ts", acquiredCreateRequireLoader)).toContain(
      "tests/release-integrity.test.ts uses process.getBuiltinModule outside the reviewed static import graph"
    );
    const bracketAcquiredCreateRequireLoader = acquiredCreateRequireLoader
      .split('process.getBuiltinModule("node:module")')
      .join('process["getBuiltinModule"]("node:module")');
    expect(moduleProblems("tests/release-integrity.test.ts", bracketAcquiredCreateRequireLoader)).toContain(
      "tests/release-integrity.test.ts uses process.getBuiltinModule outside the reviewed static import graph"
    );
    const concatenatedProcessLoader =
      'void process["getBuiltin" + "Module"]("node:module").createRequire(import.meta.url);';
    expect(moduleProblems("tests/release-integrity.test.ts", concatenatedProcessLoader)).toContain(
      "tests/release-integrity.test.ts uses process.getBuiltinModule outside the reviewed static import graph"
    );
    const aliasedProcessLoader = 'const runtimeProcess = process; void runtimeProcess.getBuiltinModule("node:module");';
    expect(moduleProblems("tests/release-integrity.test.ts", aliasedProcessLoader)).toContain(
      "tests/release-integrity.test.ts acquires first-class process runtime capability outside the static graph"
    );
    const aliasedModuleLoader = 'const runtimeModule = module; void runtimeModule.require("./unreceipted.cjs");';
    expect(moduleProblems("tests/release-integrity.test.ts", aliasedModuleLoader)).toContain(
      "tests/release-integrity.test.ts acquires first-class module runtime capability outside the static graph"
    );
    const processMainModuleLoader = 'void process.mainModule.require("./helpers/exact-source-mutation.js");';
    expect(moduleProblems("tests/release-integrity.test.ts", processMainModuleLoader)).toEqual([]);
    const aliasedProcessMainModule = "const runtimeModule = process.mainModule; void runtimeModule;";
    expect(moduleProblems("tests/release-integrity.test.ts", aliasedProcessMainModule)).toContain(
      "tests/release-integrity.test.ts acquires first-class module runtime capability outside the static graph"
    );
    const moduleConstructorLoader = 'void module.constructor._load("./unreceipted.cjs");';
    expect(moduleProblems("tests/release-integrity.test.ts", moduleConstructorLoader)).toContain(
      "tests/release-integrity.test.ts acquires module runtime loader member constructor outside the static graph"
    );
    for (const memberName of [
      "__proto__",
      "_compile",
      "_load",
      "children",
      "constructor",
      "createRequire",
      "load",
      "parent"
    ]) {
      const memberProblems = moduleProblems(
        "tests/release-integrity.test.ts",
        `const hiddenLoader = module[${JSON.stringify(memberName)}]; void hiddenLoader;`
      );
      expect(memberProblems).toContain(
        memberName === "createRequire"
          ? "tests/release-integrity.test.ts acquires createRequire outside the reviewed static import graph"
          : `tests/release-integrity.test.ts acquires module runtime loader member ${memberName} outside the static graph`
      );
    }
    const assignedModuleLoader = "let hiddenRequire: unknown; ({ require: hiddenRequire } = module);";
    expect(moduleProblems("tests/release-integrity.test.ts", assignedModuleLoader)).toContain(
      "tests/release-integrity.test.ts acquires first-class module runtime capability outside the static graph"
    );
    const wrappedRequireLoader = '(0, require)("./unreceipted.cjs");';
    expect(moduleProblems("tests/release-integrity.test.ts", wrappedRequireLoader)).toContain(
      "tests/release-integrity.test.ts uses require as a first-class loader value outside the reviewed static graph"
    );
    const aliasedRequireLoader = 'const hiddenRequire = require; hiddenRequire("./unreceipted.cjs");';
    expect(moduleProblems("tests/release-integrity.test.ts", aliasedRequireLoader)).toContain(
      "tests/release-integrity.test.ts uses require as a first-class loader value outside the reviewed static graph"
    );
    const boundModuleRequireLoader =
      'const hiddenRequire = module.require.bind(module); hiddenRequire("./unreceipted.cjs");';
    expect(moduleProblems("tests/release-integrity.test.ts", boundModuleRequireLoader)).toContain(
      "tests/release-integrity.test.ts acquires a first-class runtime loader outside the reviewed static import graph"
    );
    const exportedRequireLoader = "export { require as hiddenRequire };";
    expect(moduleProblems("tests/release-integrity.test.ts", exportedRequireLoader)).toContain(
      "tests/release-integrity.test.ts uses require as a first-class loader value outside the reviewed static graph"
    );
    const globalRequireLoader = 'void globalThis["re" + "quire"]("./helpers/exact-source-mutation.js");';
    expect(moduleProblems("tests/release-integrity.test.ts", globalRequireLoader)).toEqual([]);
    const escapedGlobalRequire = "const hiddenRequire = globalThis.require; void hiddenRequire;";
    expect(moduleProblems("tests/release-integrity.test.ts", escapedGlobalRequire)).toContain(
      "tests/release-integrity.test.ts acquires a first-class runtime loader outside the reviewed static import graph"
    );
    const aliasedGlobalProcessLoader =
      'const runtimeRoot = globalThis; void runtimeRoot.process.getBuiltinModule("node:module");';
    expect(moduleProblems("tests/release-integrity.test.ts", aliasedGlobalProcessLoader)).toContain(
      "tests/release-integrity.test.ts uses process.getBuiltinModule outside the reviewed static import graph"
    );
    const globalThisSelfLoader =
      'const runtimeRoot = globalThis.globalThis; void runtimeRoot.process.getBuiltinModule("node:module");';
    expect(moduleProblems("tests/release-integrity.test.ts", globalThisSelfLoader)).toContain(
      "tests/release-integrity.test.ts uses process.getBuiltinModule outside the reviewed static import graph"
    );
    const safeGlobalThisSelf = "const runtimeRoot = globalThis.globalThis; void runtimeRoot.Array;";
    expect(moduleProblems("tests/release-integrity.test.ts", safeGlobalThisSelf)).toEqual([]);
    for (const [nodeGlobalLoader, expectedProblem] of [
      [
        'void global.process.getBuiltinModule("node:module");',
        "tests/release-integrity.test.ts uses process.getBuiltinModule outside the reviewed static import graph"
      ],
      [
        'void global.globalThis.process.getBuiltinModule("node:module");',
        "tests/release-integrity.test.ts uses process.getBuiltinModule outside the reviewed static import graph"
      ],
      [
        'const runtimeRoot = global.global; void runtimeRoot.module.require("./unreceipted.cjs");',
        "tests/release-integrity.test.ts has unresolved runtime import ./unreceipted.cjs"
      ]
    ]) {
      expect(moduleProblems("tests/release-integrity.test.ts", nodeGlobalLoader)).toContain(expectedProblem);
    }
    expect(moduleProblems("tests/release-integrity.test.ts", "void global.Array;")).toEqual([]);
    const destructuredGlobalCapability =
      "const runtimeRoot = globalThis; const { process: runtimeProcess } = runtimeRoot; void runtimeProcess;";
    expect(moduleProblems("tests/release-integrity.test.ts", destructuredGlobalCapability)).toContain(
      "tests/release-integrity.test.ts destructures a runtime loader outside the reviewed static import graph"
    );
    for (const capabilityName of ["global", "globalThis", "module", "process", "require", "vi"]) {
      const capabilityProblems = moduleProblems(
        "tests/release-integrity.test.ts",
        `const { ${capabilityName}: hiddenCapability } = globalThis; void hiddenCapability;`
      );
      expect(capabilityProblems).toContain(
        "tests/release-integrity.test.ts destructures a runtime loader outside the reviewed static import graph"
      );
    }
    const nestedGlobalCapability =
      "const { globalThis: { process: runtimeProcess } } = globalThis; void runtimeProcess;";
    expect(moduleProblems("tests/release-integrity.test.ts", nestedGlobalCapability)).toContain(
      "tests/release-integrity.test.ts destructures a runtime loader outside the reviewed static import graph"
    );
    const safeGlobalAlias = "const runtimeRoot = globalThis; void runtimeRoot.Array;";
    expect(moduleProblems("tests/release-integrity.test.ts", safeGlobalAlias)).toEqual([]);
    const aliasedVitestLoader =
      'import { vi } from "vitest"; const hiddenImport = vi.importActual; hiddenImport("../src/vault.js");';
    expect(moduleProblems("tests/release-integrity.test.ts", aliasedVitestLoader)).toContain(
      "tests/release-integrity.test.ts acquires a first-class runtime loader outside the reviewed static import graph"
    );
    for (const loaderName of ["doMock", "importActual", "importMock", "mock"]) {
      const directLoader = `import { vi } from "vitest";\nvoid vi[${JSON.stringify(loaderName)}]("./helpers/exact-source-mutation.js");`;
      expect(moduleProblems("tests/release-integrity.test.ts", directLoader)).toEqual([]);
      const escapedLoader = `import { vi } from "vitest";\nconst hiddenLoader = vi[${JSON.stringify(loaderName)}]; void hiddenLoader;`;
      expect(moduleProblems("tests/release-integrity.test.ts", escapedLoader)).toContain(
        "tests/release-integrity.test.ts acquires a first-class runtime loader outside the reviewed static import graph"
      );
    }
    const destructuredProcessLoader = "const { getBuiltinModule: loader } = process; void loader;";
    expect(moduleProblems("tests/release-integrity.test.ts", destructuredProcessLoader)).toContain(
      "tests/release-integrity.test.ts destructures a runtime loader outside the reviewed static import graph"
    );
    const destructuredGlobalProcessLoader = "const { getBuiltinModule: loader } = globalThis.process; void loader;";
    expect(moduleProblems("tests/release-integrity.test.ts", destructuredGlobalProcessLoader)).toContain(
      "tests/release-integrity.test.ts destructures a runtime loader outside the reviewed static import graph"
    );
    const destructuredModuleLoader = "const { require: loader } = module; void loader;";
    expect(moduleProblems("tests/release-integrity.test.ts", destructuredModuleLoader)).toContain(
      "tests/release-integrity.test.ts destructures a runtime loader outside the reviewed static import graph"
    );
    const destructuredVitestLoader = 'import { vi } from "vitest";\nconst { importActual: loader } = vi; void loader;';
    expect(moduleProblems("tests/release-integrity.test.ts", destructuredVitestLoader)).toContain(
      "tests/release-integrity.test.ts destructures a runtime loader outside the reviewed static import graph"
    );
    const assignedGlobalProcessLoader =
      "let runtimeProcess: unknown; ({ process: runtimeProcess } = globalThis); void runtimeProcess;";
    expect(moduleProblems("tests/release-integrity.test.ts", assignedGlobalProcessLoader)).toContain(
      "tests/release-integrity.test.ts destructures a runtime loader outside the reviewed static import graph"
    );
    const assignedGlobalRequireLoader =
      "let runtimeRequire: unknown; ({ require: runtimeRequire } = globalThis); void runtimeRequire;";
    expect(moduleProblems("tests/release-integrity.test.ts", assignedGlobalRequireLoader)).toContain(
      "tests/release-integrity.test.ts destructures a runtime loader outside the reviewed static import graph"
    );
    const safeCapabilityAssignment =
      "let arrayConstructor: unknown; let env: unknown; ({ Array: arrayConstructor } = globalThis); ({ env } = process); void arrayConstructor; void env;";
    expect(moduleProblems("tests/release-integrity.test.ts", safeCapabilityAssignment)).toEqual([]);
    const escapedCapabilityAssignmentResult =
      'let env: unknown; const escapedProcess = ({ env } = process); void escapedProcess.getBuiltinModule("node:module");';
    expect(moduleProblems("tests/release-integrity.test.ts", escapedCapabilityAssignmentResult)).toContain(
      "tests/release-integrity.test.ts acquires first-class process runtime capability outside the static graph"
    );
    const escapedGlobalAssignmentResult =
      'let arrayConstructor: unknown; const escapedRoot = ({ Array: arrayConstructor } = globalThis); void escapedRoot.process.getBuiltinModule("node:module");';
    expect(moduleProblems("tests/release-integrity.test.ts", escapedGlobalAssignmentResult)).toContain(
      "tests/release-integrity.test.ts preserves a globalThis runtime capability through assignment destructuring"
    );
    const voidedCapabilityAssignment = "let env: unknown; void ({ env } = process); void env;";
    expect(moduleProblems("tests/release-integrity.test.ts", voidedCapabilityAssignment)).toEqual([]);
    const descendantProcessProperty =
      "const { getBuiltinModule: ordinary } = process.env; void ordinary; void globalThis.process.env;";
    expect(moduleProblems("tests/release-integrity.test.ts", descendantProcessProperty)).toEqual([]);
    const safeCapabilityDestructuring =
      'import { vi } from "vitest";\n' +
      "const { argv } = process; const { filename } = module; const { fn } = vi; " +
      "const { Array: arrayConstructor } = globalThis; const { env } = globalThis.process; " +
      "const { filename: mainFilename } = process.mainModule; " +
      "void argv; void filename; void fn; void arrayConstructor; void env; void mainFilename;";
    expect(moduleProblems("tests/release-integrity.test.ts", safeCapabilityDestructuring)).toEqual([]);
    const restGlobalCapability = "const { ...runtimeGlobal } = globalThis; void runtimeGlobal;";
    expect(moduleProblems("tests/release-integrity.test.ts", restGlobalCapability)).toContain(
      "tests/release-integrity.test.ts dynamically destructures a runtime capability outside the static import graph"
    );
    const dynamicProcessMember = "declare const runtimeKey: string; void process[runtimeKey];";
    expect(moduleProblems("tests/release-integrity.test.ts", dynamicProcessMember)).toContain(
      "tests/release-integrity.test.ts uses a dynamic process capability member outside the static graph"
    );
    const dynamicModuleBinding =
      "declare const runtimeKey: string; const { [runtimeKey]: hiddenLoader } = module; void hiddenLoader;";
    expect(moduleProblems("tests/release-integrity.test.ts", dynamicModuleBinding)).toContain(
      "tests/release-integrity.test.ts dynamically destructures a runtime capability outside the static import graph"
    );
    const ambientShorthandLoaders =
      "const requireHolder = { require }; const processHolder = { process }; void requireHolder; void processHolder;";
    const ambientShorthandProblems = moduleProblems("tests/release-integrity.test.ts", ambientShorthandLoaders);
    expect(ambientShorthandProblems).toContain(
      "tests/release-integrity.test.ts uses require as a first-class loader value outside the reviewed static graph"
    );
    expect(ambientShorthandProblems).toContain(
      "tests/release-integrity.test.ts acquires first-class process runtime capability outside the static graph"
    );
    const invokedLocalLoaderShadows = [
      "const process = { getBuiltinModule: (name: string): string => name };",
      'const module = { require: (name: string): string => name, createRequire: (): string => "safe" };',
      "const require = (name: string): string => name;",
      'const createRequire = (): string => "safe";',
      "const vi = { importActual: (name: string): string => name };",
      "const vitest = { importActual: (name: string): string => name };",
      'const ordinary = { createRequire: (): string => "safe" };',
      'void process.getBuiltinModule("node:module"); void module.require("safe");',
      'void module.createRequire(); void require("safe"); void createRequire();',
      'void vi.importActual("safe"); void vitest.importActual("safe"); void ordinary.createRequire();'
    ].join("\n");
    expect(moduleProblems("tests/release-integrity.test.ts", invokedLocalLoaderShadows)).toEqual([]);
    const localShorthandLoaders = [
      'const require = (name: string): string => name; const process = { env: "safe" };',
      "const holder = { require, process }; void holder;"
    ].join("\n");
    expect(moduleProblems("tests/release-integrity.test.ts", localShorthandLoaders)).toEqual([]);
    const invokedLocalGlobalShadow = [
      "const globalThis = { globalThis: { Array }, require: (name: string): string => name, process: { getBuiltinModule: (name: string): string => name } };",
      'void globalThis.globalThis.Array; void globalThis.require("safe"); void globalThis.process.getBuiltinModule("safe");'
    ].join("\n");
    expect(moduleProblems("tests/release-integrity.test.ts", invokedLocalGlobalShadow)).toEqual([]);
    const invokedLocalNodeGlobalShadow = [
      "const global = { global: { Array }, process: { getBuiltinModule: (name: string): string => name } };",
      'void global.global.Array; void global.process.getBuiltinModule("safe");'
    ].join("\n");
    expect(moduleProblems("tests/release-integrity.test.ts", invokedLocalNodeGlobalShadow)).toEqual([]);
    const dynamicLocalShadow = [
      'const process = { env: "safe" }; const module = { filename: "safe" };',
      'const runtimeKey = "env"; const moduleKey = "filename";',
      "void process[runtimeKey]; void module[moduleKey];"
    ].join("\n");
    expect(moduleProblems("tests/release-integrity.test.ts", dynamicLocalShadow)).toEqual([]);
    const safeRuntimeExport = "const safe = 1; export { safe as require };";
    expect(moduleProblems("tests/release-integrity.test.ts", safeRuntimeExport)).toEqual([]);
    const safeTypeExport = "type require = unknown; export type { require };";
    expect(moduleProblems("tests/release-integrity.test.ts", safeTypeExport)).toEqual([]);
    expect(moduleProblems("tests/release-integrity.test.ts", 'void import("node:module");')).toContain(
      "tests/release-integrity.test.ts acquires runtime loader namespace node:module through dynamic import"
    );
    expect(
      moduleProblems("tests/release-integrity.test.ts", 'import ModuleApi = require("node:module"); void ModuleApi;')
    ).toContain("tests/release-integrity.test.ts acquires runtime loader namespace node:module through import-equals");
    expect(
      moduleProblems("tests/release-integrity.test.ts", 'import type ModuleApi = require("node:module");')
    ).toEqual([]);
    expect(
      moduleProblems("tests/release-integrity.test.ts", 'export { createRequire as hidden } from "node:module";')
    ).toContain("tests/release-integrity.test.ts acquires runtime loader namespace node:module through re-export");
    const inertLoaderNames = [
      'const documentation = "require createRequire process.getBuiltinModule vi.importActual";',
      "const ordinary = { require: documentation, createRequire: documentation, getBuiltinModule: documentation };",
      "type createRequire = { readonly require: string };",
      "void ordinary;"
    ].join("\n");
    expect(moduleProblems("tests/release-integrity.test.ts", inertLoaderNames)).toEqual([]);
    const erasedLoaderAccesses = [
      'import { vi, vitest } from "vitest";',
      "type ModuleLoader = typeof module.require;",
      "type ProcessLoader = typeof process.getBuiltinModule;",
      "type GlobalLoader = typeof globalThis.require;",
      "type VitestLoader = typeof vi.importActual;",
      "type VitestRootLoader = typeof vitest.importMock;"
    ].join("\n");
    expect(moduleProblems("tests/release-integrity.test.ts", erasedLoaderAccesses)).toEqual([]);
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
  }, 45_000);
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
