import { promises as fs } from "node:fs";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { load } from "js-yaml";
import ts from "typescript";
import { describe, expect, it } from "vitest";
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
// package command, workflow prerequisites, production coverage set, timeout
// ceilings and reviewed direct-loader value-import closure are one fail-closed contract:
// a wildcard, third omission, filtered prerequisite or production import
// makes this lightweight test fail before the coverage job can qualify.

const repoRoot = path.resolve(__dirname, "..");
const RESTRICTED_MODULES = ["cli", "server", "tool-registry", "prompts"];
const COVERAGE_ONLY_TEST_EXCLUSIONS = [
  "tests/meta-invariant-coverage.test.ts",
  "tests/release-integrity.test.ts"
] as const;
const EXPECTED_COVERAGE_SCRIPT =
  "vitest run --coverage --exclude tests/meta-invariant-coverage.test.ts " +
  "--exclude tests/release-integrity.test.ts";
const EXPECTED_CHECKOUT_ACTION = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
const EXPECTED_SETUP_NODE_ACTION = "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020";
const EXPECTED_COVERAGE_CLOSURE_FILES = [
  "scripts/check-release-integrity.mjs",
  "scripts/lib/entrypoint.mjs",
  "scripts/lib/mcpb-safety.mjs",
  "scripts/mcpb-consumer.mjs",
  "tests/helpers/exact-source-mutation.ts",
  "tests/meta-invariant-coverage.test.ts",
  "tests/release-integrity.test.ts",
  "tests/release-mutation-identity-audit.ts",
  "tests/release-mutation-plan.ts"
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
const VITEST_RUNTIME_LOADERS = new Set(["doMock", "importActual", "importMock", "mock"]);
const EXPECTED_VITEST_CONFIG_FILES = ["vitest.config.ts"] as const;

type UnknownRecord = Record<string, unknown>;

interface CoverageIsolationInputs {
  readonly packageJson: string;
  readonly ciWorkflow: string;
  readonly vitestConfig: string;
  readonly vitestConfigFiles: readonly string[];
  readonly closureSources: ReadonlyMap<string, string>;
}

function asRecord(value: unknown): UnknownRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as UnknownRecord) : undefined;
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

  const prepublishOnly = scripts?.prepublishOnly;
  if (typeof prepublishOnly !== "string") {
    problems.push("prepublishOnly must remain a static script");
    return problems;
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
  const coverageJob = asRecord(jobs?.coverage);
  if (testJob === undefined) {
    problems.push("CI must retain the blocking test matrix job");
  } else {
    if (
      !recordHasExactKeys(testJob, ["name", "runs-on", "timeout-minutes", "env", "strategy", "steps"]) ||
      testJob.name !== `test (\${{ matrix.label }})` ||
      testJob["runs-on"] !== "ubuntu-latest" ||
      testJob["timeout-minutes"] !== 10 ||
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
  }
  return problems;
}

function vitestCoverageProblems(source: string, configFiles: readonly string[]): string[] {
  const problems: string[] = [];
  if (!isDeepStrictEqual([...configFiles].sort(), [...EXPECTED_VITEST_CONFIG_FILES])) {
    problems.push("the repository must retain one canonical vitest.config.ts");
  }
  const sourceFile = ts.createSourceFile("vitest.config.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (sourceFile.statements.length !== 2 || !hasExactDefineConfigImport(sourceFile.statements[0])) {
    problems.push("vitest config must retain the exact unaliased defineConfig import");
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
  if (
    !isDeepStrictEqual(stringLiteralArray(objectProperty(coverage, "exclude")), [
      "src/{index,cli,server,tool-registry,prompts,tool-manifest}.ts",
      "**/*.test.ts"
    ])
  ) {
    problems.push("vitest production coverage exclusions must remain the reviewed exact pair");
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
    return [`${filename} must retain one direct top-level suite ${suiteTitle}`];
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
  const safeRegistrationCallees = new Set([
    "afterAll",
    "afterEach",
    "beforeAll",
    "beforeEach",
    "describe",
    "it",
    "test"
  ]);
  const registrationIsReachable =
    registrationEntry !== undefined &&
    suiteCallback.body.statements.slice(0, registrationEntry.statementIndex + 1).every((statement) => {
      if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return false;
      return ts.isIdentifier(statement.expression.expression)
        ? safeRegistrationCallees.has(statement.expression.expression.text)
        : false;
    });
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
  return isDeepStrictEqual(timeouts, [expectedTimeout])
    ? []
    : [`${filename} must retain one direct ${callee} registration with timeout ${expectedTimeout}`];
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
    const edges = runtimeModuleEdges(filename, source);
    problems.push(...edges.problems);
    for (const specifier of edges.specifiers) {
      const resolved = resolveClosureTarget(filename, specifier, sources);
      if (resolved.problem !== undefined) problems.push(resolved.problem);
      if (resolved.target !== undefined) pending.push(resolved.target);
    }
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
      "480_000"
    ),
    ...registrationTimeoutProblems(
      requiredClosureSource(input.closureSources, "tests/release-integrity.test.ts"),
      "tests/release-integrity.test.ts",
      "release identity and exact required-job gate",
      "it",
      "keeps release.yml wired to the shared evaluator and an exact mirrored inventory",
      "330_000"
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
  const [packageJson, ciWorkflow, vitestConfig] = await Promise.all([
    fs.readFile(path.join(repoRoot, "package.json"), "utf8"),
    fs.readFile(path.join(repoRoot, ".github", "workflows", "ci.yml"), "utf8"),
    fs.readFile(path.join(repoRoot, "vitest.config.ts"), "utf8")
  ]);
  return { packageJson, ciWorkflow, vitestConfig, vitestConfigFiles, closureSources };
}

let coverageInputsPromise: Promise<CoverageIsolationInputs> | undefined;

function currentCoverageIsolationInputs(): Promise<CoverageIsolationInputs> {
  if (coverageInputsPromise === undefined) coverageInputsPromise = readCoverageIsolationInputs();
  return coverageInputsPromise;
}

function withClosureSource(input: CoverageIsolationInputs, filename: string, source: string): CoverageIsolationInputs {
  const closureSources = new Map(input.closureSources);
  closureSources.set(filename, source);
  return { ...input, closureSources };
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

    const current = await currentCoverageIsolationInputs();
    const exactCoverageEntry = `"test:coverage": "${EXPECTED_COVERAGE_SCRIPT}"`;
    const packageWithThirdExclusion = replaceExactly(
      current.packageJson,
      exactCoverageEntry,
      `"test:coverage": "${EXPECTED_COVERAGE_SCRIPT} --exclude tests/other.test.ts"`
    );
    expect(coverageIsolationProblems({ ...current, packageJson: packageWithThirdExclusion })).toContain(
      "package scripts.test:coverage must retain the exact two-file coverage-only exclusion"
    );
    const packageWithWildcard = replaceExactly(
      current.packageJson,
      exactCoverageEntry,
      '"test:coverage": "vitest run --coverage --exclude tests/*invariant*.test.ts"'
    );
    expect(coverageIsolationProblems({ ...current, packageJson: packageWithWildcard })).toContain(
      "package scripts.test:coverage must retain the exact two-file coverage-only exclusion"
    );
    const packageWithMissingExclusion = replaceExactly(
      current.packageJson,
      exactCoverageEntry,
      '"test:coverage": "vitest run --coverage --exclude tests/meta-invariant-coverage.test.ts"'
    );
    expect(coverageIsolationProblems({ ...current, packageJson: packageWithMissingExclusion })).toContain(
      "package scripts.test:coverage must retain the exact two-file coverage-only exclusion"
    );
    const packageWithFilteredTest = replaceExactly(
      current.packageJson,
      '"test": "vitest run"',
      '"test": "vitest run tests/unit.test.ts"'
    );
    expect(coverageIsolationProblems({ ...current, packageJson: packageWithFilteredTest })).toContain(
      "package scripts.test must remain the exact unfiltered vitest run"
    );
    const packageWithCoverageBeforeTest = replaceExactly(
      current.packageJson,
      "npm test && node scripts/check-version-consistency.mjs && node scripts/check-audit.mjs && " +
        "npm run test:coverage --silent",
      "npm run test:coverage --silent && node scripts/check-version-consistency.mjs && " +
        "node scripts/check-audit.mjs && npm test"
    );
    expect(coverageIsolationProblems({ ...current, packageJson: packageWithCoverageBeforeTest })).toContain(
      "prepublishOnly must run the unfiltered suite before coverage isolation"
    );
    const packageWithFailOpenTest = replaceExactly(
      current.packageJson,
      "npm test && node scripts/check-version-consistency.mjs",
      "npm test || true && node scripts/check-version-consistency.mjs"
    );
    expect(coverageIsolationProblems({ ...current, packageJson: packageWithFailOpenTest })).toContain(
      "prepublishOnly must retain one exact unfiltered npm test stage"
    );

    const ciWithFilteredTest = mutableWorkflow(current.ciWorkflow, (workflow) => {
      mutableRunStep(mutableWorkflowJob(workflow, "test"), "npm test").run =
        "npm test -- tests/no-internal-imports.test.ts";
    });
    expect(coverageIsolationProblems({ ...current, ciWorkflow: ciWithFilteredTest })).toContain(
      "each CI Node leg must end with one exact unfiltered fail-capable npm test"
    );
    const ciWithoutNode24 = mutableWorkflow(current.ciWorkflow, (workflow) => {
      const testJob = mutableWorkflowJob(workflow, "test");
      const include = asRecord(asRecord(testJob.strategy)?.matrix)?.include;
      if (!Array.isArray(include)) throw new Error("expected test matrix include");
      include.pop();
    });
    expect(coverageIsolationProblems({ ...current, ciWorkflow: ciWithoutNode24 })).toContain(
      "CI test matrix must retain exact unfiltered Node 22.13 and Node 24 legs"
    );
    const ciWithMatrixExclude = mutableWorkflow(current.ciWorkflow, (workflow) => {
      const testJob = mutableWorkflowJob(workflow, "test");
      const matrix = asRecord(asRecord(testJob.strategy)?.matrix);
      if (matrix === undefined) throw new Error("expected test matrix");
      matrix.exclude = [{ label: "22" }];
    });
    expect(coverageIsolationProblems({ ...current, ciWorkflow: ciWithMatrixExclude })).toContain(
      "CI test matrix must retain exact unfiltered Node 22.13 and Node 24 legs"
    );
    const ciWithHardcodedTestNode = mutableWorkflow(current.ciWorkflow, (workflow) => {
      const setup = mutableUsesStep(mutableWorkflowJob(workflow, "test"), EXPECTED_SETUP_NODE_ACTION);
      const setupWith = asRecord(setup.with);
      if (setupWith === undefined) throw new Error("expected test setup-node inputs");
      setupWith["node-version"] = "22";
    });
    expect(coverageIsolationProblems({ ...current, ciWorkflow: ciWithHardcodedTestNode })).toContain(
      "CI test matrix must bind the exact pinned setup-node step to each matrix runtime"
    );
    const ciWithCheckoutRef = mutableWorkflow(current.ciWorkflow, (workflow) => {
      mutableUsesStep(mutableWorkflowJob(workflow, "test"), EXPECTED_CHECKOUT_ACTION).with = { ref: "main" };
    });
    expect(coverageIsolationProblems({ ...current, ciWorkflow: ciWithCheckoutRef })).toContain(
      "CI test matrix must begin with the exact pinned checkout step"
    );
    const ciWithoutCoverageNeed = mutableWorkflow(current.ciWorkflow, (workflow) => {
      mutableWorkflowJob(workflow, "coverage").needs = "lint";
    });
    expect(coverageIsolationProblems({ ...current, ciWorkflow: ciWithoutCoverageNeed })).toContain(
      "CI coverage must retain its exact prerequisite-bound 10-minute job boundary"
    );
    const ciWithFailOpenTest = mutableWorkflow(current.ciWorkflow, (workflow) => {
      mutableWorkflowJob(workflow, "test")["continue-on-error"] = true;
    });
    expect(coverageIsolationProblems({ ...current, ciWorkflow: ciWithFailOpenTest })).toContain(
      "CI test matrix must retain its exact fail-capable job boundary"
    );
    const ciWithNoopTestShell = mutableWorkflow(current.ciWorkflow, (workflow) => {
      mutableRunStep(mutableWorkflowJob(workflow, "test"), "npm test").shell = "echo {0}";
    });
    expect(coverageIsolationProblems({ ...current, ciWorkflow: ciWithNoopTestShell })).toContain(
      "each CI Node leg must end with one exact unfiltered fail-capable npm test"
    );
    const ciWithRootDefaults = mutableWorkflow(current.ciWorkflow, (workflow) => {
      workflow.defaults = { run: { "working-directory": "/tmp" } };
    });
    expect(coverageIsolationProblems({ ...current, ciWorkflow: ciWithRootDefaults })).toContain(
      "CI root may not override the test or coverage execution environment"
    );
    const ciWithRaisedBreaker = mutableWorkflow(current.ciWorkflow, (workflow) => {
      mutableWorkflowJob(workflow, "coverage")["timeout-minutes"] = 11;
    });
    expect(coverageIsolationProblems({ ...current, ciWorkflow: ciWithRaisedBreaker })).toContain(
      "CI coverage must retain its exact prerequisite-bound 10-minute job boundary"
    );
    const ciWithWrongCoverageNode = mutableWorkflow(current.ciWorkflow, (workflow) => {
      const setup = mutableUsesStep(mutableWorkflowJob(workflow, "coverage"), EXPECTED_SETUP_NODE_ACTION);
      const setupWith = asRecord(setup.with);
      if (setupWith === undefined) throw new Error("expected coverage setup-node inputs");
      setupWith["node-version"] = 24;
    });
    expect(coverageIsolationProblems({ ...current, ciWorkflow: ciWithWrongCoverageNode })).toContain(
      "CI coverage must retain the exact pinned Node 22 setup step"
    );
    const ciWithSkippedPerFileGate = mutableWorkflow(current.ciWorkflow, (workflow) => {
      mutableRunStep(mutableWorkflowJob(workflow, "coverage"), "npm run check:per-file-coverage").if = "false";
    });
    expect(coverageIsolationProblems({ ...current, ciWorkflow: ciWithSkippedPerFileGate })).toContain(
      "CI coverage must retain contiguous fail-capable build, coverage and floor gates"
    );
    const ciWithFailOpenBuild = mutableWorkflow(current.ciWorkflow, (workflow) => {
      mutableRunStep(mutableWorkflowJob(workflow, "coverage"), "npm run build")["continue-on-error"] = true;
    });
    expect(coverageIsolationProblems({ ...current, ciWorkflow: ciWithFailOpenBuild })).toContain(
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
    expect(coverageIsolationProblems({ ...current, ciWorkflow: ciWithInsertedGateStep })).toContain(
      "CI coverage must retain contiguous fail-capable build, coverage and floor gates"
    );

    const vitestWithGlobalExclusion = replaceExactly(
      current.vitestConfig,
      '    include: ["tests/**/*.test.ts"],\n',
      '    include: ["tests/**/*.test.ts"],\n    exclude: ["tests/release-integrity.test.ts"],\n'
    );
    expect(coverageIsolationProblems({ ...current, vitestConfig: vitestWithGlobalExclusion })).toContain(
      "vitest test config must retain its exact reviewed static key set"
    );
    const vitestWithHiddenExclusion = replaceExactly(
      current.vitestConfig,
      '    include: ["tests/**/*.test.ts"],\n',
      '    include: ["tests/**/*.test.ts"],\n    ...{ exclude: ["tests/release-integrity.test.ts"] },\n'
    );
    expect(coverageIsolationProblems({ ...current, vitestConfig: vitestWithHiddenExclusion })).toContain(
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
    expect(coverageIsolationProblems({ ...current, vitestConfig: vitestWithAliasedDefineConfig })).toContain(
      "vitest config must retain the exact unaliased defineConfig import"
    );
    const vitestWithExportEquals = replaceExactly(
      current.vitestConfig,
      "export default defineConfig(",
      "export = defineConfig("
    );
    expect(coverageIsolationProblems({ ...current, vitestConfig: vitestWithExportEquals })).toContain(
      "vitest config must remain one static default defineConfig object"
    );
    const vitestWithRootOverride = replaceExactly(
      current.vitestConfig,
      "export default defineConfig({\n  test:",
      'export default defineConfig({\n  root: "./empty",\n  test:'
    );
    expect(coverageIsolationProblems({ ...current, vitestConfig: vitestWithRootOverride })).toContain(
      "vitest root config must retain the exact static test-only shape"
    );
    const vitestWithComputedExclusion = replaceExactly(
      current.vitestConfig,
      '    include: ["tests/**/*.test.ts"],\n',
      '    include: ["tests/**/*.test.ts"],\n    ["exclude"]: ["tests/release-integrity.test.ts"],\n'
    );
    expect(coverageIsolationProblems({ ...current, vitestConfig: vitestWithComputedExclusion })).toContain(
      "vitest test config must retain its exact reviewed static key set"
    );
    const vitestWithCoverageSpread = replaceExactly(
      current.vitestConfig,
      "      thresholds: {\n",
      '      ...{ include: ["src/vault.ts"] },\n      thresholds: {\n'
    );
    expect(coverageIsolationProblems({ ...current, vitestConfig: vitestWithCoverageSpread })).toContain(
      "vitest coverage config must retain its exact reviewed static key set"
    );
    const vitestWithThresholdSpread = replaceExactly(
      current.vitestConfig,
      "        branches: 74\n",
      "        branches: 74,\n        ...{ branches: 0 }\n"
    );
    expect(coverageIsolationProblems({ ...current, vitestConfig: vitestWithThresholdSpread })).toContain(
      "vitest coverage thresholds must retain the exact four global floors"
    );
    const vitestWithNarrowSource = replaceExactly(
      current.vitestConfig,
      '      include: ["src/**/*.ts"],',
      '      include: ["src/vault.ts"],'
    );
    expect(coverageIsolationProblems({ ...current, vitestConfig: vitestWithNarrowSource })).toContain(
      "vitest coverage.include must remain exact src/**/*.ts"
    );
    const vitestWithWrongProvider = replaceExactly(
      current.vitestConfig,
      '      provider: "v8",',
      '      provider: "istanbul",'
    );
    expect(coverageIsolationProblems({ ...current, vitestConfig: vitestWithWrongProvider })).toContain(
      "vitest coverage provider must remain v8"
    );
    const vitestWithLowerFloor = replaceExactly(current.vitestConfig, "        branches: 74", "        branches: 73");
    expect(coverageIsolationProblems({ ...current, vitestConfig: vitestWithLowerFloor })).toContain(
      "vitest coverage threshold branches must remain 74"
    );
    expect(
      coverageIsolationProblems({
        ...current,
        vitestConfigFiles: [...current.vitestConfigFiles, "vitest.workspace.ts"]
      })
    ).toContain("the repository must retain one canonical vitest.config.ts");

    const metaSource = requiredClosureSource(current.closureSources, "tests/meta-invariant-coverage.test.ts");
    const raisedMetaTimeout = replaceExactly(
      metaSource,
      '  }, 480_000);\n\n  it("every *-invariant.test.ts file has NEGATIVE control OR explicit exempt marker",',
      '  }, 481_000);\n\n  it("every *-invariant.test.ts file has NEGATIVE control OR explicit exempt marker",'
    );
    expect(
      coverageIsolationProblems(withClosureSource(current, "tests/meta-invariant-coverage.test.ts", raisedMetaTimeout))
    ).toContain(
      "tests/meta-invariant-coverage.test.ts must retain one direct beforeAll registration with timeout 480_000"
    );
    const releaseSource = requiredClosureSource(current.closureSources, "tests/release-integrity.test.ts");
    const raisedReleaseTimeout = replaceExactly(releaseSource, "  }, 330_000);\n});\n", "  }, 331_000);\n});\n");
    expect(
      coverageIsolationProblems(withClosureSource(current, "tests/release-integrity.test.ts", raisedReleaseTimeout))
    ).toContain("tests/release-integrity.test.ts must retain one direct it registration with timeout 330_000");
    const unreachableReleaseRegistration = replaceExactly(
      releaseSource,
      '  it("keeps release.yml wired to the shared evaluator and an exact mirrored inventory", () => {',
      '  return;\n  it("keeps release.yml wired to the shared evaluator and an exact mirrored inventory", () => {'
    );
    expect(
      coverageIsolationProblems(
        withClosureSource(current, "tests/release-integrity.test.ts", unreachableReleaseRegistration)
      )
    ).toContain("tests/release-integrity.test.ts must retain one direct it registration with timeout 330_000");

    const directProductionImport = `import { Vault } from "../src/vault.js";\n${releaseSource}`;
    expect(
      coverageIsolationProblems(withClosureSource(current, "tests/release-integrity.test.ts", directProductionImport))
    ).toContain("tests/release-integrity.test.ts value-imports production path src/vault.js");
    const helperSource = requiredClosureSource(current.closureSources, "tests/helpers/exact-source-mutation.ts");
    const transitiveProductionImport = `import "../../dist/index.js";\n${helperSource}`;
    expect(
      coverageIsolationProblems(
        withClosureSource(current, "tests/helpers/exact-source-mutation.ts", transitiveProductionImport)
      )
    ).toContain("tests/helpers/exact-source-mutation.ts value-imports production path dist/index.js");
    const vitestProductionImport = `import { vi } from "vitest";\nvoid vi.importActual("../src/vault.js");\n${releaseSource}`;
    expect(
      coverageIsolationProblems(withClosureSource(current, "tests/release-integrity.test.ts", vitestProductionImport))
    ).toContain("tests/release-integrity.test.ts value-imports production path src/vault.js");
    const createRequireLoader =
      'import { createRequire } from "node:module";\n' +
      "const loadCoverageModule = createRequire(import.meta.url);\n" +
      releaseSource;
    expect(
      coverageIsolationProblems(withClosureSource(current, "tests/release-integrity.test.ts", createRequireLoader))
    ).toContain("tests/release-integrity.test.ts uses createRequire outside the reviewed static import graph");
    const emptyNamedProductionImport = `import {} from "../src/vault.js";\n${releaseSource}`;
    expect(
      coverageIsolationProblems(
        withClosureSource(current, "tests/release-integrity.test.ts", emptyNamedProductionImport)
      )
    ).toContain("tests/release-integrity.test.ts value-imports production path src/vault.js");
    const selfPackageImport = `import "@oomkapwn/enquire-mcp";\n${releaseSource}`;
    expect(
      coverageIsolationProblems(withClosureSource(current, "tests/release-integrity.test.ts", selfPackageImport))
    ).toContain("tests/release-integrity.test.ts value-imports the enquire-mcp package surface");
    const unresolvedImport = `import "./missing-coverage-helper.js";\n${metaSource}`;
    expect(
      coverageIsolationProblems(withClosureSource(current, "tests/meta-invariant-coverage.test.ts", unresolvedImport))
    ).toContain("tests/meta-invariant-coverage.test.ts has unresolved runtime import ./missing-coverage-helper.js");
    const computedImport = `const hiddenModule = "./helpers/exact-source-mutation.js";\nvoid import(hiddenModule);\n${metaSource}`;
    expect(
      coverageIsolationProblems(withClosureSource(current, "tests/meta-invariant-coverage.test.ts", computedImport))
    ).toContain("tests/meta-invariant-coverage.test.ts uses a nonliteral dynamic import loader");
    const unreviewedAliasImport = `import "#production-alias";\n${releaseSource}`;
    expect(
      coverageIsolationProblems(withClosureSource(current, "tests/release-integrity.test.ts", unreviewedAliasImport))
    ).toContain("tests/release-integrity.test.ts uses an unreviewed external runtime module #production-alias");
    expect(reviewedClosurePathProblem("tests/helpers/exact-source-mutation.ts", "src/vault.ts")).toBe(
      "reviewed coverage closure path tests/helpers/exact-source-mutation.ts resolves to unexpected src/vault.ts"
    );

    const typeOnlyProductionImport = `import type { Vault } from "../src/vault.js";\n${releaseSource}`;
    expect(
      coverageIsolationProblems(withClosureSource(current, "tests/release-integrity.test.ts", typeOnlyProductionImport))
    ).toEqual([]);
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
