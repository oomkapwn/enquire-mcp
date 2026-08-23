// Pure Vitest execution-selection policy for OIA Check 12c.
//
// The ordinary Vitest suite also validates these surfaces, but a pre-collection
// file/name filter can exclude that validator before it registers. This module
// therefore runs in the separate OIA Node process and admits only the reviewed
// direct declarative selection boundary: full-suite config, root npm execution
// inputs, package commands/lifecycles, and the blocking CI test job. Arbitrary
// side effects in imported config/setup code belong to the trusted bootstrap
// boundary and are intentionally not claimed here.

import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { load } from "js-yaml";
import ts from "typescript";

/** Exact build command that runs before each required Linux Vitest population. */
export const EXPECTED_BUILD_SCRIPT =
  "rm -rf dist && node node_modules/typescript-native/bin/tsc && chmod +x dist/index.js";

/** Exact coverage rerun with only the two reviewed coverage-only exclusions. */
export const EXPECTED_COVERAGE_SCRIPT =
  "vitest run --coverage --exclude tests/meta-invariant-coverage.test.ts " +
  "--exclude tests/release-integrity.test.ts";

/** Exact root lifecycle command admitted during dependency installation. */
export const EXPECTED_PREPARE_SCRIPT =
  "rm -rf dist && node node_modules/typescript-native/bin/tsc && chmod +x dist/index.js && " +
  "(husky 2>/dev/null || true)";

/** Lifecycle hooks that may not wrap installation, build, or Vitest commands. */
export const FORBIDDEN_REQUIRED_RUN_LIFECYCLE_SCRIPTS = Object.freeze([
  "predependencies",
  "dependencies",
  "postdependencies",
  "preinstall",
  "install",
  "postinstall",
  "prepublish",
  "preprepare",
  "postprepare",
  "prebuild",
  "postbuild",
  "pretest",
  "posttest",
  "pretest:coverage",
  "posttest:coverage"
]);

const EXPECTED_VITEST_CONFIG_FILES = ["vitest.config.ts"];
const VITEST_CONFIG_FILE = "vitest.config.ts";
const VITEST_CONFIG_CENSUS = /^vitest\.(?:config|projects|workspace)\./u;
const FORBIDDEN_NPM_PROJECT_ENTRIES = Object.freeze([".npmrc", "binding.gyp", "npm-shrinkwrap.json"]);
const EXPECTED_CHECKOUT_ACTION = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
const EXPECTED_SETUP_NODE_ACTION = "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020";
const EXPECTED_TEST_STEP_FINGERPRINTS = [
  "3ef4af68ef144f12dd555f182fb78c286413a5c20503a3491c8a1a7ea3554af7",
  "edca7cfed3ff243cb4a555e1d498c0aaf00c3beea661e07b0a4b29201526d909",
  "d6afccf6f68cf1593c09c268ca358cc0def948d0f8b14ee047128a5a6e366627",
  "338e29c470a015d92698b8184b65ee481976a1a24ad813eab912c20460a2a937",
  "44d96178c110e1ceeaa809d554c1bc392079517800a7a155792ee34206ef2c0e",
  "dbaf53cd3dfd2d8bc4d6f741915bc861d1ac27b5cf842aee668e9bef8e011843",
  "59d90db08cea0405ca3033ef2e00b11406b56244d0007ed5c0423684052640bc"
];
const CONFIG_HINT =
  "Restore the one reviewed static vitest.config.ts. Name, file, project, tag, shard, root, directory, and dynamic selectors are not admitted in required full-suite runs.";
const PACKAGE_HINT =
  "Restore the exact prepare/build/test commands and remove unreviewed install/build/test lifecycle hooks; use filtered commands only for local diagnostics outside required gates.";
const NPM_BOUNDARY_HINT =
  "Remove the unreviewed root npm execution input. Required runs admit no project .npmrc, implicit binding.gyp install action, or shrinkwrap precedence override.";
const CI_HINT =
  "Restore the exact blocking test matrix and its final unfiltered npm test step. Required CI may not narrow or conditionally bypass the full suite.";

function asRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}

function canonicalJsonValue(value) {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  const record = asRecord(value);
  if (record === undefined) return value;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, canonicalJsonValue(record[key])])
  );
}

function workflowStepFingerprints(steps) {
  if (steps === undefined) return [];
  return steps.map((step) => {
    const encoded = JSON.stringify(canonicalJsonValue(step));
    if (encoded === undefined) throw new Error("workflow step must remain JSON-serializable");
    return createHash("sha256").update(encoded).digest("hex");
  });
}

function recordHasExactKeys(record, expected) {
  return isDeepStrictEqual(Object.keys(record).sort(), [...expected].sort());
}

function workflowSteps(job) {
  const steps = job?.steps;
  if (!Array.isArray(steps) || steps.some((value) => asRecord(value) === undefined)) return undefined;
  return steps;
}

function propertyNameText(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

function objectProperty(object, name) {
  const matches = object.properties.filter(
    (property) => ts.isPropertyAssignment(property) && propertyNameText(property.name) === name
  );
  return matches.length === 1 ? matches[0]?.initializer : undefined;
}

function objectHasExactStaticKeys(object, expected) {
  const actual = object.properties.flatMap((property) => {
    if (!ts.isPropertyAssignment(property)) return [];
    const name = propertyNameText(property.name);
    return name === undefined ? [] : [name];
  });
  return actual.length === object.properties.length && isDeepStrictEqual(actual.sort(), [...expected].sort());
}

function stringLiteralValue(expression) {
  return expression !== undefined && ts.isStringLiteralLike(expression) ? expression.text : undefined;
}

function stringLiteralArray(expression) {
  if (expression === undefined || !ts.isArrayLiteralExpression(expression)) return undefined;
  const values = [];
  for (const element of expression.elements) {
    if (!ts.isStringLiteralLike(element)) return undefined;
    values.push(element.text);
  }
  return values;
}

function isExactCoveragePolicySpread(expression) {
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

function hasExactNamedImport(statement, moduleName, bindingName) {
  if (
    statement === undefined ||
    !ts.isImportDeclaration(statement) ||
    stringLiteralValue(statement.moduleSpecifier) !== moduleName ||
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
    binding.name.text === bindingName
  );
}

function parseVitestConfig(source) {
  const sourceFile = ts.createSourceFile(VITEST_CONFIG_FILE, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const diagnostic = sourceFile.parseDiagnostics[0];
  if (diagnostic !== undefined) {
    const position = Math.min(Math.max(diagnostic.start ?? 0, 0), source.length);
    const location = sourceFile.getLineAndCharacterOfPosition(position);
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ").trim();
    return {
      problem:
        `vitest config must parse without diagnostics: ${location.line + 1}:${location.character + 1} ` +
        `TS${diagnostic.code}: ${message}`,
      sourceFile
    };
  }
  return { sourceFile };
}

/**
 * Check package scripts that select the required Vitest populations.
 *
 * @param {string} source Raw package.json text.
 * @returns {string[]} Selection-policy problems.
 * @example
 * packageTestSelectionProblems('{"scripts":{"test":"vitest run"}}');
 */
export function packageTestSelectionProblems(source) {
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    return ["package.json must remain valid JSON"];
  }
  const scripts = asRecord(asRecord(parsed)?.scripts);
  const problems = [];
  if (scripts?.prepare !== EXPECTED_PREPARE_SCRIPT) {
    problems.push("package scripts.prepare must remain the exact reviewed install bootstrap");
  }
  if (scripts?.build !== EXPECTED_BUILD_SCRIPT) {
    problems.push("package scripts.build must remain the exact reviewed pre-test build");
  }
  if (scripts?.test !== "vitest run") {
    problems.push("package scripts.test must remain the exact unfiltered vitest run");
  }
  if (scripts?.["test:coverage"] !== EXPECTED_COVERAGE_SCRIPT) {
    problems.push("package scripts.test:coverage must retain the exact two-file coverage-only exclusion");
  }
  if (FORBIDDEN_REQUIRED_RUN_LIFECYCLE_SCRIPTS.some((name) => Object.hasOwn(scripts ?? {}, name))) {
    problems.push("package install/build/test lifecycle hooks must remain absent");
  }
  return problems;
}

/**
 * Return root npm execution inputs that can reinterpret exact commands.
 *
 * @param {readonly string[]} rootEntryNames Repository-root entry names.
 * @returns {string[]} Forbidden root entry names in policy order.
 * @example
 * forbiddenNpmProjectEntries([".npmrc"]);
 */
export function forbiddenNpmProjectEntries(rootEntryNames) {
  return FORBIDDEN_NPM_PROJECT_ENTRIES.filter((filename) => rootEntryNames.includes(filename));
}

/**
 * Check the blocking CI job that invokes the required unfiltered suite.
 *
 * @param {string} source Raw .github/workflows/ci.yml text.
 * @returns {string[]} Selection-policy problems.
 * @example
 * ciTestSelectionProblems("jobs: {}");
 */
export function ciTestSelectionProblems(source) {
  let parsed;
  try {
    parsed = load(source);
  } catch {
    return ["CI workflow must remain valid YAML"];
  }
  const workflow = asRecord(parsed);
  if (workflow === undefined) return ["CI workflow must remain an object"];
  const problems = [];
  if (Object.hasOwn(workflow, "env") || Object.hasOwn(workflow, "defaults")) {
    problems.push("CI root may not override the test or coverage execution environment");
  }
  const testJob = asRecord(asRecord(workflow.jobs)?.test);
  if (testJob === undefined) {
    return [...problems, "CI must retain the blocking test matrix job"];
  }
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
    strategy["fail-fast"] !== false ||
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
  return problems;
}

/**
 * Check the canonical static Vitest config and its root-level config census.
 *
 * @param {string} source Raw vitest.config.ts text.
 * @param {readonly string[]} configFiles Root filenames beginning with vitest.config, vitest.projects, or vitest.workspace.
 * @returns {string[]} Selection-policy problems.
 * @example
 * vitestSelectionProblems("export default {};", ["vitest.config.ts"]);
 */
export function vitestSelectionProblems(source, configFiles) {
  const problems = [];
  if (!isDeepStrictEqual([...configFiles].sort(), EXPECTED_VITEST_CONFIG_FILES)) {
    problems.push("the repository must retain one canonical vitest.config.ts");
  }
  const parsed = parseVitestConfig(source);
  if (parsed.problem !== undefined) return [...problems, parsed.problem];
  const { sourceFile } = parsed;
  if (!hasExactNamedImport(sourceFile.statements[0], "vitest/config", "defineConfig")) {
    problems.push("vitest config must retain the exact unaliased defineConfig import");
  }
  if (
    sourceFile.statements.length !== 3 ||
    !hasExactNamedImport(sourceFile.statements[1], "./scripts/lib/coverage-policy.mjs", "COVERAGE_EXCLUDE_PATTERNS")
  ) {
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
  if (!objectHasExactStaticKeys(configArgument, ["test"])) {
    problems.push("vitest root config must retain the exact static test-only shape");
  }
  const testExpression = objectProperty(configArgument, "test");
  if (testExpression === undefined || !ts.isObjectLiteralExpression(testExpression)) {
    return [...problems, "vitest config must retain one static test object"];
  }
  if (!objectHasExactStaticKeys(testExpression, ["include", "environment", "testTimeout", "setupFiles", "coverage"])) {
    problems.push("vitest test config must retain its exact reviewed static key set");
  }
  if (!isDeepStrictEqual(stringLiteralArray(objectProperty(testExpression, "include")), ["tests/**/*.test.ts"])) {
    problems.push("vitest test.include must remain the exact full test-file glob");
  }
  if (stringLiteralValue(objectProperty(testExpression, "environment")) !== "node") {
    problems.push("vitest test.environment must remain node");
  }
  if (objectProperty(testExpression, "testTimeout")?.getText(sourceFile) !== "15_000") {
    problems.push("vitest testTimeout must remain 15_000");
  }
  if (!isDeepStrictEqual(stringLiteralArray(objectProperty(testExpression, "setupFiles")), ["./tests/setup.ts"])) {
    problems.push("vitest setupFiles must retain the exact tests/setup.ts bootstrap");
  }
  const coverageExpression = objectProperty(testExpression, "coverage");
  if (coverageExpression === undefined || !ts.isObjectLiteralExpression(coverageExpression)) {
    return [...problems, "vitest config must retain one static coverage object"];
  }
  if (!objectHasExactStaticKeys(coverageExpression, ["provider", "reporter", "include", "exclude", "thresholds"])) {
    problems.push("vitest coverage config must retain its exact reviewed static key set");
  }
  if (stringLiteralValue(objectProperty(coverageExpression, "provider")) !== "v8") {
    problems.push("vitest coverage provider must remain v8");
  }
  if (
    !isDeepStrictEqual(stringLiteralArray(objectProperty(coverageExpression, "reporter")), [
      "text",
      "html",
      "lcov",
      "json-summary"
    ])
  ) {
    problems.push("vitest coverage reporters must retain text, html, lcov and json-summary");
  }
  if (!isDeepStrictEqual(stringLiteralArray(objectProperty(coverageExpression, "include")), ["src/**/*.ts"])) {
    problems.push("vitest coverage.include must remain exact src/**/*.ts");
  }
  if (!isExactCoveragePolicySpread(objectProperty(coverageExpression, "exclude"))) {
    problems.push("vitest production coverage exclusions must use the exact centralized policy spread");
  }
  const thresholdsExpression = objectProperty(coverageExpression, "thresholds");
  if (thresholdsExpression === undefined || !ts.isObjectLiteralExpression(thresholdsExpression)) {
    problems.push("vitest coverage thresholds must remain a static object");
  } else {
    const expectedThresholds = { branches: "74", functions: "75", lines: "86", statements: "82" };
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

function readRegularFile(repoRoot, filename) {
  const absolute = join(repoRoot, ...filename.split("/"));
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Vitest selection policy refuses non-regular file ${filename}`);
  }
  return readFileSync(absolute, "utf8");
}

function findings(kind, file, hint, problems) {
  return problems.map((evidence) => ({ evidence, file, hint, kind, line: 1 }));
}

/**
 * Inspect the reviewed direct declarative surfaces that can narrow the required Vitest run.
 *
 * @param {string} repoRoot Absolute repository root.
 * @returns {Array<{evidence: string, file: string, hint: string, kind: string, line: number}>} Non-overridable OIA findings.
 * @example
 * inspectRepositoryVitestSelectionControls(process.cwd());
 */
export function inspectRepositoryVitestSelectionControls(repoRoot) {
  const rootEntries = readdirSync(repoRoot, { withFileTypes: true });
  const rootEntryNames = rootEntries.map((entry) => entry.name);
  const configEntries = rootEntries.filter((entry) => VITEST_CONFIG_CENSUS.test(entry.name));
  for (const entry of configEntries) {
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(`Vitest config census refuses non-regular entry ${entry.name}`);
    }
  }
  const configFiles = configEntries.map((entry) => entry.name).sort();
  const configSource = configFiles.includes(VITEST_CONFIG_FILE) ? readRegularFile(repoRoot, VITEST_CONFIG_FILE) : "";
  return [
    ...findings(
      "VITEST-SELECTION-CONFIG",
      VITEST_CONFIG_FILE,
      CONFIG_HINT,
      vitestSelectionProblems(configSource, configFiles)
    ),
    ...findings(
      "VITEST-SELECTION-PACKAGE",
      "package.json",
      PACKAGE_HINT,
      packageTestSelectionProblems(readRegularFile(repoRoot, "package.json"))
    ),
    ...forbiddenNpmProjectEntries(rootEntryNames).flatMap((filename) =>
      findings("VITEST-SELECTION-NPM-BOUNDARY", filename, NPM_BOUNDARY_HINT, [
        `the repository root must not contain ${filename}`
      ])
    ),
    ...findings(
      "VITEST-SELECTION-CI",
      ".github/workflows/ci.yml",
      CI_HINT,
      ciTestSelectionProblems(readRegularFile(repoRoot, ".github/workflows/ci.yml"))
    )
  ];
}
