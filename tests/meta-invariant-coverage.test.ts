// META-invariant: the exact, reviewed set of structural-oracle tests must keep
// executable NEGATIVE-control coverage.
//
// CLAUDE.md rule since v3.6.4: an invariant test that always passes proves
// nothing. This guard therefore enforces both parts of the contract:
//   (a) exact membership of the 25 convention-named invariant files plus the
//       9 curated structural files whose historical names do not match it;
//   (b) one direct `it`/`test`/`describe` registration with a NEGATIVE title
//       and an assertion that is not obviously unreachable, or a reviewed
//       header exemption comment.
//
// Registration is deliberately fail-closed: only direct top-level calls and
// direct calls inside direct `describe` callbacks count. Aliases, `.each`,
// `.skip`, `.todo`, and other registration wrappers are unsupported. An
// unconditional runtime skip through the current test-context parameter ends
// that assertion path; a conditional environment guard may leave a later CI
// assertion reachable. Assertion recognition is syntactic, not a proof that an
// assertion is discriminating; for example, this guard cannot distinguish a
// useful matcher from a tautology. It also does not resolve whether
// `expect`/`assert` identifiers are shadowed.

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";
import { replaceAllExactly, replaceExactly, replaceIntegerAllExactly } from "./helpers/exact-source-mutation.js";
import {
  createReleaseMutationIdentityAuditor,
  releaseMutationIdentityAuditProblems
} from "./release-mutation-identity-audit.js";

const repoRoot = path.resolve(__dirname, "..");
const RELEASE_MUTATION_IDENTITY_FIXTURE_SHA256 = "9ccc4d25c0051d9516c9e7795dc6499a4ad024f33f67cea34776d59d5bbe6ce3";
const releaseMutationIdentityFixturePath = path.join(repoRoot, "tests/fixtures/release-mutation-identity.v2.json");
const releaseIntegritySourcePath = path.join(repoRoot, "tests/release-integrity.test.ts");

interface MutableIdentityControlManifest {
  readonly cases: Array<{
    readonly checks: Array<{
      readonly expectation: { regex?: string };
      readonly invoke: {
        readonly inputs: {
          readonly arguments: Array<{ readonly id?: string; readonly kind: string; readonly slot: string }>;
          callee: string;
        };
        kind: string;
      };
    }>;
  }>;
  readonly mutations: Array<{
    readonly id: string;
    readonly expressions: {
      readonly needle: { raw: string; resolved: string };
      readonly source: { resolved: string };
    };
    replacementDependency: string | null;
  }>;
  readonly sources: Array<{
    contentSha256: string;
    readonly declarativeBinding: string;
    readonly id: string;
    readonly legacyExpressions: string[];
    readonly order: number;
    readonly origin: unknown;
    semanticFingerprint: string;
  }>;
}

type MutableIdentityControlCheck = MutableIdentityControlManifest["cases"][number]["checks"][number];

function identityControlCheck(manifest: MutableIdentityControlManifest, kind: string): MutableIdentityControlCheck {
  const check = manifest.cases
    .flatMap((identityCase) => identityCase.checks)
    .find((entry) => entry.invoke.kind === kind);
  if (check === undefined) throw new Error(`release identity fixture has no ${kind} invocation`);
  return check;
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function refreshSourceSemanticFingerprint(source: MutableIdentityControlManifest["sources"][number]): void {
  source.semanticFingerprint = `sha256:${sha256Text(
    JSON.stringify({
      normalizer: "release-matrix-balanced-v2",
      source: {
        order: source.order,
        id: source.id,
        legacyExpressions: source.legacyExpressions,
        declarativeBinding: source.declarativeBinding,
        origin: source.origin,
        contentSha256: source.contentSha256
      }
    })
  )}`;
}

function firstIdentityEntry<T>(values: readonly T[], label: string): T {
  const value = values[0];
  if (value === undefined) throw new Error(`release identity fixture has no ${label}`);
  return value;
}

// Freeze the convention-named side too: a one-for-one delete/add swap must not
// evade review merely because the total count remains 34.
const EXPECTED_NAMED_STRUCTURAL_FILES = [
  "abs-path-leak-invariant.test.ts",
  "cache-isolation-invariant.test.ts",
  "cli-flag-docs-invariant.test.ts",
  "docker-glama-invariant.test.ts",
  "enforcement-guard-invariant.test.ts",
  "entrypoint-guard-invariant.test.ts",
  "erasure-invariant.test.ts",
  "fence-toggle-invariant.test.ts",
  "github-metadata-invariant.test.ts",
  "k1-ast-invariant.test.ts",
  "k1-class-invariant.test.ts",
  "k3-readonly-hint-invariant.test.ts",
  "module-header-claim-invariant.test.ts",
  "name-fold-invariant.test.ts",
  "no-graymatter-invariant.test.ts",
  "optional-dep-leak-invariant.test.ts",
  "parser-desync-invariant.test.ts",
  "parser-input-cap-invariant.test.ts",
  "phantom-import-invariant.test.ts",
  "readme-anchor-invariant.test.ts",
  "resource-bound-invariant.test.ts",
  "scope-completeness-invariant.test.ts",
  "sink-parity-invariant.test.ts",
  "smoke-default-vault-invariant.test.ts",
  "write-lifecycle-invariant.test.ts"
] as const;

// Historical structural tests that do not use the `*-invariant.test.ts` suffix
// are curated explicitly so they cannot dodge the same coverage rule.
const EXTRA_STRUCTURAL_FILES = [
  "docs-consistency.test.ts",
  "cli-parity.test.ts",
  "lint.test.ts",
  "no-internal-imports.test.ts",
  "meta-invariant-coverage.test.ts",
  "mcp-schema-compat.test.ts",
  // release-integrity is a structural oracle despite its historical filename.
  // Its mutation controls belong under the same fail-closed meta-guard.
  "release-integrity.test.ts",
  // v3.9.0-rc.26 (rc.25-audit LOW-1) — two more invariant-SHAPED tests that
  // assert source/state against a canonical value but aren't named
  // `*-invariant.test.ts`, so they escaped the glob. Both already carry a real
  // NEGATIVE control (k1-version-stamp drives `scanK1Stamps` on a bad fixture;
  // jsonld has an empty-answer control) — listing them keeps the meta-invariant
  // watching that those controls don't rot.
  "k1-version-stamp-consistency.test.ts",
  "jsonld.test.ts"
] as const;
const EXPECTED_STRUCTURAL_FILES = [...EXPECTED_NAMED_STRUCTURAL_FILES, ...EXTRA_STRUCTURAL_FILES] as const;
const EXPECTED_STRUCTURAL_FILE_COUNT = EXPECTED_STRUCTURAL_FILES.length;

const RAW_REPLACE_INVENTORY_FILES = [
  "abs-path-leak-invariant.test.ts",
  "docs-consistency.test.ts",
  "helpers/exact-source-mutation.ts",
  "write-lifecycle-invariant.test.ts"
] as const;
const EXPECTED_REPOSITORY_MUTATION_HELPER_CALLS = new Map<string, number>([
  ["abs-path-leak-invariant.test.ts", 7],
  ["docs-consistency.test.ts", 30],
  ["write-lifecycle-invariant.test.ts", 19]
]);
const EXPECTED_REPOSITORY_MUTATION_HELPER_IMPORTS = new Map<string, readonly string[]>([
  ["abs-path-leak-invariant.test.ts", ["replaceExactly"]],
  ["docs-consistency.test.ts", ["replaceAllExactly", "replaceExactly", "replaceIntegerAllExactly"]],
  ["write-lifecycle-invariant.test.ts", ["replaceExactly"]]
]);
const EXACT_MUTATION_HELPERS = new Set(["replaceExactly", "replaceAllExactly", "replaceIntegerAllExactly"]);

/** Require a deliberate list edit for every structural-oracle addition, removal, or rename. */
function assertStructuralFileMembership(actual: ReadonlySet<string>): void {
  const expected = new Set<string>(EXPECTED_STRUCTURAL_FILES);
  const missing = EXPECTED_STRUCTURAL_FILES.filter((name) => !actual.has(name));
  const unexpected = [...actual].filter((name) => !expected.has(name)).sort();
  if (missing.length === 0 && unexpected.length === 0) return;

  const details: string[] = [];
  if (missing.length > 0) details.push(`missing: ${missing.join(", ")}`);
  if (unexpected.length > 0) details.push(`unexpected: ${unexpected.join(", ")}`);
  throw new Error(`structural invariant census mismatch (${details.join("; ")})`);
}

/** Unwrap syntax that cannot change the static identity of a property access. */
function unwrapStaticExpression(node: ts.Expression): ts.Expression {
  let current = node;
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

/** Resolve only literal property spellings; dynamic properties remain unclassified. */
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
  if (current === undefined) return null;
  if (ts.isIdentifier(current) || ts.isStringLiteralLike(current)) return current.text;
  if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticStringExpressionText(current.left);
    const right = staticStringExpressionText(current.right);
    return left === null || right === null ? null : left + right;
  }
  return null;
}

/** Fold only literal string concatenation used as a computed property name. */
function staticStringExpressionText(node: ts.Expression): string | null {
  const current = unwrapStaticExpression(node);
  if (ts.isStringLiteralLike(current)) return current.text;
  if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticStringExpressionText(current.left);
    const right = staticStringExpressionText(current.right);
    return left === null || right === null ? null : left + right;
  }
  return null;
}

/** Type queries mention String APIs without creating an executable mutation sink. */
function isTypeOnlyAccess(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isTypeQueryNode(current)) return true;
    current = current.parent;
  }
  return false;
}

/** True when an object-literal property belongs to the left side of an assignment pattern. */
function isDestructuringAssignmentProperty(node: ts.PropertyAssignment | ts.ShorthandPropertyAssignment): boolean {
  let current: ts.Node = node;
  while (current.parent) {
    const parent = current.parent;
    if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      return current.getStart() >= parent.left.getStart() && current.getEnd() <= parent.left.getEnd();
    }
    if (ts.isForOfStatement(parent) || ts.isForInStatement(parent)) {
      return current.getStart() >= parent.initializer.getStart() && current.getEnd() <= parent.initializer.getEnd();
    }
    if (ts.isStatement(parent) || ts.isFunctionLike(parent)) return false;
    current = parent;
  }
  return false;
}

/** Recognize the sole reviewed non-mutation transform in the three-file residual. */
function isReviewedLifecycleNormalization(
  filename: string,
  node: ts.PropertyAccessExpression,
  sourceFile: ts.SourceFile
): boolean {
  if (filename !== "docs-consistency.test.ts" || node.name.text !== "replace") return false;
  const receiver = unwrapStaticExpression(node.expression);
  if (!ts.isIdentifier(receiver) || receiver.text !== "lifecycle") return false;

  const call = node.parent;
  if (!ts.isCallExpression(call) || call.expression !== node || call.arguments.length !== 2) return false;
  const pattern = call.arguments[0];
  const replacement = call.arguments[1];
  if (
    pattern === undefined ||
    replacement === undefined ||
    !ts.isRegularExpressionLiteral(pattern) ||
    pattern.getText(sourceFile) !== "/\\s+/g" ||
    !ts.isStringLiteral(replacement) ||
    replacement.text !== " "
  ) {
    return false;
  }

  const declaration = call.parent;
  return (
    ts.isVariableDeclaration(declaration) &&
    declaration.initializer === call &&
    ts.isIdentifier(declaration.name) &&
    declaration.name.text === "normalizedLifecycle"
  );
}

/** Reject every raw String.replace/replaceAll value access except one exact reviewed transform. */
function repositoryMutationOracleProblems(filename: string, source: string): string[] {
  const sourceFile = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const problems: string[] = [];
  let reviewedTransforms = 0;

  function location(node: ts.Node): string {
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    return `${position.line + 1}:${position.character + 1}`;
  }

  function visit(node: ts.Node): void {
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const method = ts.isPropertyAccessExpression(node)
        ? staticPropertyText(node.name)
        : staticPropertyText(node.argumentExpression);
      if ((method === "replace" || method === "replaceAll") && !isTypeOnlyAccess(node)) {
        if (ts.isPropertyAccessExpression(node) && isReviewedLifecycleNormalization(filename, node, sourceFile)) {
          reviewedTransforms++;
        } else {
          problems.push(`${filename}:${location(node)} has unclassified raw .${method} access`);
        }
      }
    }
    if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
      const method = staticPropertyText(node.propertyName ?? node.name);
      if (method === "replace" || method === "replaceAll") {
        problems.push(`${filename}:${location(node)} has unclassified raw .${method} binding`);
      }
    }
    if (
      (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
      isDestructuringAssignmentProperty(node)
    ) {
      const method = staticPropertyText(node.name);
      if (method === "replace" || method === "replaceAll") {
        problems.push(`${filename}:${location(node)} has unclassified raw .${method} assignment binding`);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  const expectedReviewedTransforms = filename === "docs-consistency.test.ts" ? 1 : 0;
  if (reviewedTransforms !== expectedReviewedTransforms) {
    problems.push(
      `${filename} expected ${expectedReviewedTransforms} reviewed ordinary transform(s), found ${reviewedTransforms}`
    );
  }
  return problems;
}

/** Count direct calls to the reviewed exact-mutation helpers, excluding inert text and aliases. */
function exactMutationHelperCallCount(filename: string, source: string): number {
  const sourceFile = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let count = 0;
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      EXACT_MUTATION_HELPERS.has(node.expression.text)
    ) {
      count++;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return count;
}

/** True only when an identifier creates a runtime binding that can shadow an imported helper. */
function isValueBindingIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    ((ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isClassExpression(parent) ||
      ts.isEnumDeclaration(parent) ||
      ts.isModuleDeclaration(parent) ||
      ts.isImportClause(parent) ||
      ts.isImportSpecifier(parent) ||
      ts.isNamespaceImport(parent) ||
      ts.isImportEqualsDeclaration(parent)) &&
      parent.name === node) ||
    (ts.isBindingElement(parent) && parent.name === node)
  );
}

/** Require direct, unaliased helper imports and reject every local binding that can shadow them. */
function exactMutationHelperBindingProblems(filename: string, source: string): string[] {
  const expectedImports = EXPECTED_REPOSITORY_MUTATION_HELPER_IMPORTS.get(filename);
  if (expectedImports === undefined) return [];

  const sourceFile = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const problems: string[] = [];
  const approvedImportIdentifiers = new Set<ts.Identifier>();
  const actualImports: string[] = [];
  const helperImports = sourceFile.statements.filter(
    (statement): statement is ts.ImportDeclaration =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === "./helpers/exact-source-mutation.js"
  );

  if (helperImports.length !== 1) {
    problems.push(
      `${filename} expected exactly one exact-source-mutation helper import, found ${helperImports.length}`
    );
  }
  const importClause = helperImports[0]?.importClause;
  if (
    importClause === undefined ||
    importClause.isTypeOnly ||
    importClause.name !== undefined ||
    importClause.namedBindings === undefined ||
    !ts.isNamedImports(importClause.namedBindings)
  ) {
    problems.push(`${filename} exact-source-mutation helpers must use one named import`);
  } else {
    for (const element of importClause.namedBindings.elements) {
      const importedName = element.propertyName?.text ?? element.name.text;
      const localName = element.name.text;
      if (element.isTypeOnly) {
        problems.push(`${filename} imports exact mutation helper ${importedName} as type-only`);
        continue;
      }
      if (importedName !== localName) {
        problems.push(`${filename} aliases exact mutation helper ${importedName} as ${localName}`);
        continue;
      }
      actualImports.push(localName);
      approvedImportIdentifiers.add(element.name);
    }
  }

  const expected = [...expectedImports].sort();
  const actual = actualImports.sort();
  if (actual.join("\0") !== expected.join("\0")) {
    problems.push(`${filename} expected exact helper imports ${expected.join(", ")}, found ${actual.join(", ")}`);
  }

  function visit(node: ts.Node): void {
    if (
      ts.isIdentifier(node) &&
      EXACT_MUTATION_HELPERS.has(node.text) &&
      isValueBindingIdentifier(node) &&
      !approvedImportIdentifiers.has(node)
    ) {
      const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      problems.push(
        `${filename}:${position.line + 1}:${position.character + 1} shadows exact mutation helper ${node.text}`
      );
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return problems;
}

/** Discover all structural-invariant test files: every `*-invariant.test.ts`
 *  (recursive) plus the curated EXTRA_STRUCTURAL_FILES. */
async function collectInvariantTestFiles(): Promise<string[]> {
  const testsRoot = path.join(repoRoot, "tests");
  const present = new Set<string>();
  async function walk(dir: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.name.endsWith("-invariant.test.ts")) {
        present.add(path.relative(testsRoot, full).split(path.sep).join("/"));
      }
    }
  }
  await walk(testsRoot);
  for (const name of EXTRA_STRUCTURAL_FILES) {
    const full = path.join(testsRoot, name);
    try {
      await fs.access(full);
      present.add(name);
    } catch {
      // Exact membership below aggregates missing and unexpected paths.
    }
  }
  assertStructuralFileMembership(present);
  return [...present].sort().map((name) => path.join(testsRoot, name));
}

/** Whether an expression is `expect(...)`, `expect.soft(...)`, or `expect.poll(...)`. */
function isExpectInvocation(node: ts.Expression): boolean {
  if (!ts.isCallExpression(node)) return false;
  if (ts.isIdentifier(node.expression)) return node.expression.text === "expect";
  return (
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "expect" &&
    (node.expression.name.text === "soft" || node.expression.name.text === "poll")
  );
}

/** A matcher call must be rooted in `expect(...)`; a bare `expect(value)` is vacuous. */
function isExpectMatcherCall(node: ts.CallExpression): boolean {
  if (!ts.isPropertyAccessExpression(node.expression)) return false;
  let target: ts.Expression = node.expression.expression;
  while (
    ts.isPropertyAccessExpression(target) &&
    (target.name.text === "not" || target.name.text === "resolves" || target.name.text === "rejects")
  ) {
    target = target.expression;
  }
  return isExpectInvocation(target);
}

/** Whether an argument is a positive integer literal accepted by `expect.assertions`. */
function isPositiveIntegerLiteral(node: ts.Expression | undefined): boolean {
  if (node === undefined || !ts.isNumericLiteral(node)) return false;
  const value = Number(node.text);
  return Number.isInteger(value) && value > 0;
}

/** Return true only for executable matcher/assertion calls. */
function isAssertionCall(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return callee.text === "assert";
  if (!ts.isPropertyAccessExpression(callee)) return false;
  if (ts.isIdentifier(callee.expression) && callee.expression.text === "assert") return true;
  if (ts.isIdentifier(callee.expression) && callee.expression.text === "expect") {
    if (callee.name.text === "fail") return true;
    if (callee.name.text === "hasAssertions") return node.arguments.length === 0;
    if (callee.name.text === "assertions") {
      return node.arguments.length === 1 && isPositiveIntegerLiteral(node.arguments[0]);
    }
  }
  return isExpectMatcherCall(node);
}

/** Match the literal booleans used by the deliberately small reachability guard. */
function isLiteralBoolean(node: ts.Expression, value: boolean): boolean {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current.kind === (value ? ts.SyntaxKind.TrueKeyword : ts.SyntaxKind.FalseKeyword);
}

interface CallbackSkipBindings {
  bareNames: ReadonlySet<string>;
  receiverNames: ReadonlySet<string>;
}

/** Derive only the current test callback's syntactic context/skip bindings. */
function callbackSkipBindings(callback: ts.ArrowFunction | ts.FunctionExpression): CallbackSkipBindings {
  const receiverNames = new Set<string>();
  const bareNames = new Set<string>();
  const parameter = callback.parameters[0];
  if (parameter === undefined) return { bareNames, receiverNames };
  if (ts.isIdentifier(parameter.name)) {
    receiverNames.add(parameter.name.text);
  } else if (ts.isObjectBindingPattern(parameter.name)) {
    for (const element of parameter.name.elements) {
      if (!ts.isIdentifier(element.name)) continue;
      const propertyName = element.propertyName;
      let sourceName = element.name.text;
      if (propertyName !== undefined && (ts.isIdentifier(propertyName) || ts.isStringLiteralLike(propertyName))) {
        sourceName = propertyName.text;
      } else if (
        propertyName !== undefined &&
        ts.isComputedPropertyName(propertyName) &&
        ts.isStringLiteralLike(propertyName.expression)
      ) {
        sourceName = propertyName.expression.text;
      }
      if (sourceName === "skip") bareNames.add(element.name.text);
    }
  }
  return { bareNames, receiverNames };
}

/** Recognize `ctx.skip()` or a destructured `skip()` from this callback only. */
function isCallbackSkipCall(node: ts.Node, bindings: CallbackSkipBindings): boolean {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  return (
    (ts.isIdentifier(callee) && bindings.bareNames.has(callee.text)) ||
    (ts.isPropertyAccessExpression(callee) &&
      callee.name.text === "skip" &&
      ts.isIdentifier(callee.expression) &&
      bindings.receiverNames.has(callee.expression.text)) ||
    (ts.isElementAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      bindings.receiverNames.has(callee.expression.text) &&
      callee.argumentExpression !== undefined &&
      ts.isStringLiteralLike(callee.argumentExpression) &&
      callee.argumentExpression.text === "skip")
  );
}

/** Recognize an unconditional Vitest-style skip statement before an assertion. */
function isCallbackSkipStatement(statement: ts.Statement, bindings: CallbackSkipBindings): boolean {
  if (!ts.isExpressionStatement(statement)) return false;
  let expression = statement.expression;
  while (
    ts.isParenthesizedExpression(expression) ||
    ts.isAwaitExpression(expression) ||
    ts.isVoidExpression(expression)
  ) {
    expression = expression.expression;
  }
  return isCallbackSkipCall(expression, bindings);
}

/** Recognize only obvious unconditional exits; this is not intended to be a full CFG. */
function statementObviouslyTerminates(
  statement: ts.Statement,
  extraTerminator?: (candidate: ts.Statement) => boolean
): boolean {
  if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement) || extraTerminator?.(statement) === true)
    return true;
  if (ts.isBlock(statement)) {
    return statement.statements.some((nested) => statementObviouslyTerminates(nested, extraTerminator));
  }
  if (ts.isIfStatement(statement)) {
    if (isLiteralBoolean(statement.expression, true)) {
      return statementObviouslyTerminates(statement.thenStatement, extraTerminator);
    }
    if (isLiteralBoolean(statement.expression, false)) {
      return (
        statement.elseStatement !== undefined && statementObviouslyTerminates(statement.elseStatement, extraTerminator)
      );
    }
    return (
      statement.elseStatement !== undefined &&
      statementObviouslyTerminates(statement.thenStatement, extraTerminator) &&
      statementObviouslyTerminates(statement.elseStatement, extraTerminator)
    );
  }
  return false;
}

/** Find assertions reachable under the small, explicit guards above. */
function nodeHasReachableAssertion(node: ts.Node, skipBindings?: CallbackSkipBindings): boolean {
  if (isAssertionCall(node)) return true;
  if (ts.isFunctionLike(node)) return false;
  if (ts.isBlock(node)) {
    for (const statement of node.statements) {
      if (nodeHasReachableAssertion(statement, skipBindings)) return true;
      if (
        statementObviouslyTerminates(
          statement,
          skipBindings === undefined ? undefined : (candidate) => isCallbackSkipStatement(candidate, skipBindings)
        )
      ) {
        break;
      }
    }
    return false;
  }
  if (ts.isIfStatement(node)) {
    if (nodeHasReachableAssertion(node.expression, skipBindings)) return true;
    if (isLiteralBoolean(node.expression, false)) {
      return node.elseStatement !== undefined && nodeHasReachableAssertion(node.elseStatement, skipBindings);
    }
    if (isLiteralBoolean(node.expression, true)) return nodeHasReachableAssertion(node.thenStatement, skipBindings);
    return (
      nodeHasReachableAssertion(node.thenStatement, skipBindings) ||
      (node.elseStatement !== undefined && nodeHasReachableAssertion(node.elseStatement, skipBindings))
    );
  }
  if (ts.isBinaryExpression(node)) {
    if (nodeHasReachableAssertion(node.left, skipBindings)) return true;
    if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && isLiteralBoolean(node.left, false)) {
      return false;
    }
    if (node.operatorToken.kind === ts.SyntaxKind.BarBarToken && isLiteralBoolean(node.left, true)) return false;
    return nodeHasReachableAssertion(node.right, skipBindings);
  }
  if (ts.isConditionalExpression(node)) {
    if (nodeHasReachableAssertion(node.condition, skipBindings)) return true;
    if (isLiteralBoolean(node.condition, true)) return nodeHasReachableAssertion(node.whenTrue, skipBindings);
    if (isLiteralBoolean(node.condition, false)) return nodeHasReachableAssertion(node.whenFalse, skipBindings);
    return (
      nodeHasReachableAssertion(node.whenTrue, skipBindings) || nodeHasReachableAssertion(node.whenFalse, skipBindings)
    );
  }
  if (ts.isWhileStatement(node) && isLiteralBoolean(node.expression, false)) {
    return nodeHasReachableAssertion(node.expression, skipBindings);
  }
  if (ts.isForStatement(node) && node.condition !== undefined && isLiteralBoolean(node.condition, false)) {
    return (
      (node.initializer !== undefined && nodeHasReachableAssertion(node.initializer, skipBindings)) ||
      nodeHasReachableAssertion(node.condition, skipBindings)
    );
  }

  let found = false;
  ts.forEachChild(node, (child) => {
    if (!found && nodeHasReachableAssertion(child, skipBindings)) found = true;
  });
  return found;
}

/** Inspect one test callback without borrowing assertions from nested functions. */
function testCallbackHasAssertion(callback: ts.ArrowFunction | ts.FunctionExpression): boolean {
  return nodeHasReachableAssertion(callback.body, callbackSkipBindings(callback));
}

type RegistrationName = "it" | "test" | "describe";

/** Return a supported direct registration name; wrappers such as `it.each` fail closed. */
function registrationName(call: ts.CallExpression): RegistrationName | null {
  if (!ts.isIdentifier(call.expression)) return null;
  const name = call.expression.text;
  return name === "it" || name === "test" || name === "describe" ? name : null;
}

/** True only for the obvious Vitest options bypass `{ skip: true }`. */
function hasLiteralSkipTrue(node: ts.Expression): boolean {
  if (!ts.isObjectLiteralExpression(node)) return false;
  return node.properties.some((property) => {
    if (!ts.isPropertyAssignment(property)) return false;
    const name = property.name;
    const isSkip =
      ((ts.isIdentifier(name) || ts.isStringLiteralLike(name)) && name.text === "skip") ||
      (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression) && name.expression.text === "skip");
    return isSkip && isLiteralBoolean(property.initializer, true);
  });
}

/** Find a registration callback unless an earlier options object explicitly skips it. */
function registrationCallback(call: ts.CallExpression): ts.ArrowFunction | ts.FunctionExpression | undefined {
  for (let index = 1; index < call.arguments.length; index++) {
    const argument = call.arguments[index];
    if (argument === undefined) continue;
    if (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) {
      if (call.arguments.slice(1, index).some((option) => hasLiteralSkipTrue(option))) return undefined;
      return argument;
    }
  }
  return undefined;
}

/** Return supported registrations from a direct statement list. */
function registrationsInStatements(statements: readonly ts.Statement[]): ts.CallExpression[] {
  const registrations: ts.CallExpression[] = [];
  for (const statement of statements) {
    if (
      ts.isExpressionStatement(statement) &&
      ts.isCallExpression(statement.expression) &&
      registrationName(statement.expression) !== null
    ) {
      registrations.push(statement.expression);
    }
    if (statementObviouslyTerminates(statement)) break;
  }
  return registrations;
}

/** Return registrations that are direct statements in one source/describe body. */
function directRegistrations(body: ts.SourceFile | ts.ArrowFunction | ts.FunctionExpression): ts.CallExpression[] {
  if (ts.isSourceFile(body)) return registrationsInStatements(body.statements);
  if (ts.isBlock(body.body)) return registrationsInStatements(body.body.statements);
  if (ts.isCallExpression(body.body) && registrationName(body.body) !== null) {
    return [body.body];
  }
  return [];
}

/** A negative `describe` owns assertions only through direct nested registrations. */
function describeCallbackHasAssertion(callback: ts.ArrowFunction | ts.FunctionExpression): boolean {
  return directRegistrations(callback).some((call) => {
    const name = registrationName(call);
    const nestedCallback = registrationCallback(call);
    if (name === null || nestedCallback === undefined) return false;
    return name === "describe"
      ? describeCallbackHasAssertion(nestedCallback)
      : testCallbackHasAssertion(nestedCallback);
  });
}

/** Match a standalone title token rather than a substring such as `NONNEGATIVE`. */
function hasNegativeControlTitle(title: string): boolean {
  for (const match of title.matchAll(/NEGATIVE|negative[-_]control/gu)) {
    const start = match.index;
    const matched = match[0];
    if (start === undefined || matched === undefined) continue;
    const before = [...title.slice(0, start)].at(-1);
    const after = [...title.slice(start + matched.length)][0];
    if (before !== undefined && /[\p{L}\p{N}_]/u.test(before)) continue;
    if (after !== undefined && /[\p{L}\p{N}_]/u.test(after)) continue;
    if (title.slice(0, start).toLowerCase().endsWith("non-")) continue;
    return true;
  }
  return false;
}

/** Search a direct registration tree for a literal-titled NEGATIVE control. */
function registrationTreeHasNegativeControl(call: ts.CallExpression): boolean {
  const name = registrationName(call);
  const callback = registrationCallback(call);
  if (name === null || callback === undefined) return false;

  const title = call.arguments[0];
  if (
    title !== undefined &&
    ts.isStringLiteralLike(title) &&
    hasNegativeControlTitle(title.text) &&
    (name === "describe" ? describeCallbackHasAssertion(callback) : testCallbackHasAssertion(callback))
  ) {
    return true;
  }
  return name === "describe" && directRegistrations(callback).some(registrationTreeHasNegativeControl);
}

/** Only registered top-level/direct-describe tests can provide coverage. */
function sourceHasNegativeControl(filename: string, content: string): boolean {
  const sourceFile = ts.createSourceFile(filename, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return directRegistrations(sourceFile).some(registrationTreeHasNegativeControl);
}

/** Accept only a standalone, non-empty single-line exemption comment in lines 1–50. */
function hasHeaderExemption(filename: string, content: string): boolean {
  const sourceFile = ts.createSourceFile(filename, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lineStarts = sourceFile.getLineStarts();
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, content);
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    const tokenPosition = scanner.getTokenPos();
    const { line } = sourceFile.getLineAndCharacterOfPosition(tokenPosition);
    if (line >= 50) break;
    if (token !== ts.SyntaxKind.SingleLineCommentTrivia) continue;

    const lineStart = lineStarts[line] ?? 0;
    if (content.slice(lineStart, tokenPosition).trim() !== "") continue;
    if (/^\/\/\s*META-INVARIANT-EXEMPT:\s*\S.*$/.test(scanner.getTokenText())) return true;
  }
  return false;
}

/** Pure check: invariant file has NEGATIVE coverage OR a reviewed exemption. */
function checkInvariantHasNegativeCoverage(filename: string, content: string): string | null {
  // Path (a): an INLINE negative-control TEST — the token inside an
  // it()/test()/describe() title, whose CALLBACK BODY actually asserts. Repo
  // convention is mixed-case ("NEGATIVE" / "negative-control"); accept both.
  // Parse declarations structurally so a callback cannot be vacuous, borrow a
  // later assertion, or satisfy the rule with assertion-shaped inert text.
  if (sourceHasNegativeControl(filename, content)) return null;

  // Path (b): explicit reviewed exemption reason. Format:
  //   // META-INVARIANT-EXEMPT: <reason>
  // Must be a standalone single-line comment with a non-empty reason in the
  // first 50 lines. Strings, block comments, and empty markers do not count.
  if (hasHeaderExemption(filename, content)) return null;

  return (
    `${filename} has no INLINE NEGATIVE control test and no META-INVARIANT-EXEMPT marker. ` +
    `Add either: (a) a negative-control test whose it()/test()/describe() TITLE contains "NEGATIVE" ` +
    `(a test that drives the invariant logic with intentionally-drifted input and asserts the ` +
    `violation IS detected), OR (b) a "// META-INVARIANT-EXEMPT: <reason>" comment in the first ` +
    `50 lines stating the reviewed reason (a bare comment mentioning ` +
    `"negative" no longer counts — see the rc.21 audit).`
  );
}

describe("META-invariant: exact structural census + NEGATIVE control coverage", () => {
  // PR #443 raised hybrid candidate-audit invocations from 24 to 53; the m109-m110
  // migration adds 12 bounded candidates for 65 total, and m111, paired m112-m113, m114-m130,
  // plus the nested m108->m107 dependency pair reuse those exact candidate slots without
  // adding another full matrix scan. The last
  // measured 53-candidate run completed the synchronous work in 323.7s; remote CI must
  // prove this exact candidate within the unchanged scoped 480s and 10-minute job circuit breakers.
  beforeAll(async () => {
    const [matrixSource, fixtureBefore] = await Promise.all([
      fs.readFile(releaseIntegritySourcePath, "utf8"),
      fs.readFile(releaseMutationIdentityFixturePath, "utf8")
    ]);
    expect(sha256Text(fixtureBefore)).toBe(RELEASE_MUTATION_IDENTITY_FIXTURE_SHA256);

    // The immutable fixture remains historical authority after the current source deliberately
    // adopts a mixed legacy/declarative representation; it is never regenerated or rewritten here.
    expect(await fs.readFile(releaseMutationIdentityFixturePath, "utf8")).toBe(fixtureBefore);
    const outsideSliceCommentDrift = replaceExactly(
      matrixSource,
      "// @ts-expect-error — .mjs consumer helpers have no declaration file; the release invariant exercises cleanup behavior.",
      "// @ts-expect-error — .mjs consumer helpers have no declaration file; the release invariant exercises owned cleanup behavior."
    );
    const preparedAudit = createReleaseMutationIdentityAuditor(fixtureBefore);
    // Seed the execution-scoped projection with a candidate whose matrix and all 30 materialized
    // sources remain exact, then prove that a clean baseline between two identical mutants cannot
    // inherit diagnostics or mutable caller state from either neighbour.
    const firstRepeatedProblems = preparedAudit.auditMatrix(outsideSliceCommentDrift);
    const stableRepeatedProblems = [...firstRepeatedProblems];
    // The reviewed mixed baseline is the positive control for the exact partition, descriptor,
    // case, detector and remaining-legacy identities. Assert it before interpreting the mutant so
    // a stale negative-control expectation can never mask a real canonical-baseline regression.
    expect(preparedAudit.auditMatrix(matrixSource)).toEqual([]);
    expect(firstRepeatedProblems).toEqual([
      expect.stringMatching(/release mutation hybrid current source must retain exact SHA-256/)
    ]);

    const mcpbSpreadOverride = replaceExactly(
      matrixSource,
      [
        '      integrity: readFileSync(new URL("../scripts/check-release-integrity.mjs", import.meta.url), "utf8"),',
        '      packageLock: readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"),'
      ].join("\n"),
      [
        '      integrity: readFileSync(new URL("../scripts/check-release-integrity.mjs", import.meta.url), "utf8"),',
        '      ...[{ integrity: "alternate release integrity source" }][0],',
        '      packageLock: readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"),'
      ].join("\n")
    );
    expect(preparedAudit.auditMatrix(mcpbSpreadOverride)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/release mutation hybrid current source must retain exact SHA-256/),
        expect.stringMatching(/release mutation hybrid current matrix slice must retain exact SHA-256/),
        expect.stringMatching(
          /release mutation hybrid mcpbInputs must be one exact frozen source object with 14 direct reviewed properties/
        )
      ])
    );

    const missingDeclarativeRootIdentity = replaceExactly(
      matrixSource,
      [
        '    const releaseMutationM002 = releaseMutationPlan.registerMutation("release.m002", {',
        '      mode: "first",',
        "      source: releaseIntegritySource"
      ].join("\n"),
      [
        '    const releaseMutationM002 = releaseMutationPlan.registerMutation("release.m999", {',
        '      mode: "first",',
        "      source: releaseIntegritySource"
      ].join("\n")
    );
    const missingDeclarativeIdentity = replaceExactly(
      missingDeclarativeRootIdentity,
      ['      id: "release.case.m107",', "      root: releaseMutationM107,"].join("\n"),
      ['      id: "release.case.m108",', "      root: releaseMutationM108,"].join("\n")
    );
    expect(preparedAudit.auditMatrix(missingDeclarativeIdentity)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m002 must exist in exactly one legacy XOR declarative representation; found 0\/0/
        ),
        expect.stringMatching(/release mutation hybrid descriptor release\.m999 has no frozen identity/),
        expect.stringMatching(/release mutation hybrid case allowlist must be exact/),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m108 disagrees with its exact frozen identity/
        )
      ])
    );

    const overlappingLegacyIdentity = replaceExactly(
      matrixSource,
      [
        "    const releaseIntegrityText = mcpbInputs.integrity;",
        "    const releaseMutationPlan = new ReleaseMutationPlan({"
      ].join("\n"),
      [
        "    void replaceExactly(",
        "        mcpbInputs.integrity,",
        "        'import { isDeepStrictEqual } from \"node:util\";',",
        '        "const isDeepStrictEqual = () => true;"',
        "      );",
        "    const releaseIntegrityText = mcpbInputs.integrity;",
        "    const releaseMutationPlan = new ReleaseMutationPlan({"
      ].join("\n")
    );
    expect(preparedAudit.auditMatrix(overlappingLegacyIdentity)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m002 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        )
      ])
    );

    const sameHashRemainingFixture = replaceExactly(
      fixtureBefore,
      "6339e5c510913eafb1defe67939b667f2d19461df01fe4e791b3ee7afb2a8909",
      "2523c1c577061ab48258e780f02ccda0cba9ca0ac209d9cf3362a2e7680fc9b1"
    );
    const sameHashRemainingProblems = releaseMutationIdentityAuditProblems(matrixSource, sameHashRemainingFixture);
    expect(sameHashRemainingProblems).toContainEqual(
      expect.stringMatching(/release mutation identity fixture must remain byte-exact SHA-256/)
    );
    expect(
      sameHashRemainingProblems.filter((problem) =>
        problem.includes("release mutation hybrid frozen ID release.m002 must exist in exactly one legacy XOR")
      )
    ).toEqual([]);

    const registrySourceLine =
      '    const registryPublishStepSource = releaseMutationPlan.registerSource("workflow.registry-publish-step", registryRun);';
    const releaseWorkflowSourceBlock = [
      "    const releaseWorkflowFixtureSource = releaseMutationPlan.registerSource(",
      '      "fixture.release-workflow",',
      "      mcpbInputs.release",
      "    );"
    ].join("\n");
    for (const [label, registryReplacement, releaseWorkflowReplacement] of [
      [
        "id",
        '    const registryPublishStepSource = releaseMutationPlan.registerSource("workflow.registry-step", registryRun);',
        [
          "    const releaseWorkflowFixtureSource = releaseMutationPlan.registerSource(",
          '      "fixture.release-source",',
          "      mcpbInputs.release",
          "    );"
        ].join("\n")
      ],
      [
        "value",
        '    const registryPublishStepSource = releaseMutationPlan.registerSource("workflow.registry-publish-step", releaseIntegrityText);',
        [
          "    const releaseWorkflowFixtureSource = releaseMutationPlan.registerSource(",
          '      "fixture.release-workflow",',
          "      releaseIntegrityText",
          "    );"
        ].join("\n")
      ],
      [
        "handle",
        '    const registryStepSource = releaseMutationPlan.registerSource("workflow.registry-publish-step", registryRun);',
        [
          "    const releaseWorkflowSource = releaseMutationPlan.registerSource(",
          '      "fixture.release-workflow",',
          "      mcpbInputs.release",
          "    );"
        ].join("\n")
      ]
    ] as const) {
      const registrySourceDrift = replaceExactly(matrixSource, registrySourceLine, registryReplacement);
      const sourceDrift = replaceExactly(registrySourceDrift, releaseWorkflowSourceBlock, releaseWorkflowReplacement);
      const sourceBindingProblems = preparedAudit
        .auditMatrix(sourceDrift)
        .filter((problem) =>
          problem.startsWith(
            "release mutation hybrid sources must bind releaseIntegritySource/script.release-integrity and " +
              "registryPublishStepSource/workflow.registry-publish-step and " +
              "releaseWorkflowFixtureSource/fixture.release-workflow"
          )
        );
      expect(sourceBindingProblems, `derived source ${label} drift`).toHaveLength(2);
    }

    // NEGATIVE control: the derived Registry source is admitted only after its exact
    // clean raw-run baseline, with no intervening or reordered statement.
    const registryBaselineAndSource = [
      "    expect(mcpRegistryRunProblems(registryRun, mcpbInputs.integrity)).toEqual([]);",
      registrySourceLine
    ].join("\n");
    const reorderedRegistryBaseline = replaceExactly(
      matrixSource,
      registryBaselineAndSource,
      [registrySourceLine, "    expect(mcpRegistryRunProblems(registryRun, mcpbInputs.integrity)).toEqual([]);"].join(
        "\n"
      )
    );
    expect(preparedAudit.auditMatrix(reorderedRegistryBaseline)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/Registry-step source must immediately follow one exact clean registry run assertion/)
      ])
    );
    const duplicatedRegistryBaseline = replaceExactly(
      matrixSource,
      registryBaselineAndSource,
      [
        "    expect(mcpRegistryRunProblems(registryRun, mcpbInputs.integrity)).toEqual([]);",
        registryBaselineAndSource
      ].join("\n")
    );
    expect(preparedAudit.auditMatrix(duplicatedRegistryBaseline)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /release mutation hybrid registry run requires one exact clean baseline assertion; found 2/
        )
      ])
    );

    const m109Witness = [
      '        anchor: "MCP_REGISTRY_CONFIRMED=false\\nMCP_REGISTRY_CONFIRMED=true",',
      "        before: 0,",
      "        after: 1"
    ].join("\n");
    const positiveOnlyM109Witness = replaceExactly(
      matrixSource,
      m109Witness,
      [
        '        anchor: "MCP_REGISTRY_CONFIRMED=false\\nMCP_REGISTRY_CONFIRMED=true",',
        "        before: 1,",
        "        after: 0"
      ].join("\n")
    );
    expect(preparedAudit.auditMatrix(positiveOnlyM109Witness)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /release mutation hybrid descriptor release\.m109 disagrees with its exact frozen semantics/
        )
      ])
    );
    const needleDerivedM109Witness = replaceExactly(
      matrixSource,
      m109Witness,
      ['        anchor: "MCP_REGISTRY_CONFIRMED=false",', "        before: 0,", "        after: 1"].join("\n")
    );
    expect(preparedAudit.auditMatrix(needleDerivedM109Witness)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /release mutation hybrid descriptor release\.m109 disagrees with its exact frozen semantics/
        )
      ])
    );
    const weakenedM110Replacement = replaceExactly(
      matrixSource,
      '      replacement: \'[ "$MCP_PUBLISH_ATTEMPTED" != "true" ] && [ "$MCP_REGISTRY_CONFIRMED" != "true" ]\',',
      '      replacement: \'[ "$MCP_PUBLISH_ATTEMPTED" != "true" ] || [ "$MCP_REGISTRY_CONFIRMED" != "true" ]\','
    );
    expect(preparedAudit.auditMatrix(weakenedM110Replacement)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /release mutation hybrid descriptor release\.m110 disagrees with its exact frozen semantics/
        )
      ])
    );

    const m109ExpectationBlock = [
      '            id: "release.expectation.m109.primary",',
      '            kind: "problem",',
      "            problem:",
      '              "stable MCP Registry publication must bind exact source manifests, one pinned publisher write, and bounded readback"'
    ].join("\n");
    const borrowedM109Problem = replaceExactly(
      matrixSource,
      m109ExpectationBlock,
      [
        '            id: "release.expectation.m109.primary",',
        '            kind: "problem",',
        "            problem:",
        '              "MCP Registry reconciliation must retain exact identity, lifecycle, absence, and convergence semantics"'
      ].join("\n")
    );
    expect(preparedAudit.auditMatrix(borrowedM109Problem)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m109 disagrees with its exact frozen identity/
        )
      ])
    );

    // NEGATIVE control: append the twenty-three exact historical root call-node byte spans after
    // the frozen legacy tail. The m107 root retains its nested m108 dependency, so one
    // resurrection must fail both frozen XOR identities. Earlier insertion would shift
    // unrelated positional identities, while different inner indentation would not
    // reproduce the pinned legacy span hashes and therefore would not exercise the detector.
    const finalRequiredReleaseCheck = '    expect(REQUIRED_RELEASE_CHECKS).not.toContain("test-windows");';
    const legacyM108CallNode = [
      "replaceExactly(",
      "            registryRun,",
      "            'require_job_reserve 2200 \"MCP Registry publish and convergence\"',",
      "            'for replay in {1..2}; do\\n  require_job_reserve 2200 \"MCP Registry publish and convergence\"'",
      "          )"
    ].join("\n");
    const legacyM107CallNode = [
      "replaceExactly(",
      "          replaceExactly(",
      "            registryRun,",
      "            'require_job_reserve 2200 \"MCP Registry publish and convergence\"',",
      "            'for replay in {1..2}; do\\n  require_job_reserve 2200 \"MCP Registry publish and convergence\"'",
      "          ),",
      "          'echo \"MCP Registry exact publication is confirmed for $MCP_NAME@$VERSION\"',",
      "          'echo \"MCP Registry exact publication is confirmed for $MCP_NAME@$VERSION\"\\ndone'",
      "        )"
    ].join("\n");
    const legacyM109CallNode = [
      "replaceExactly(",
      "          registryRun,",
      '          "MCP_REGISTRY_CONFIRMED=false",',
      '          "MCP_REGISTRY_CONFIRMED=false\\nMCP_REGISTRY_CONFIRMED=true"',
      "        )"
    ].join("\n");
    const legacyM110CallNode = [
      "replaceExactly(",
      "          registryRun,",
      '          \'[ "$MCP_PUBLISH_ATTEMPTED" != "true" ] || [ "$MCP_REGISTRY_CONFIRMED" != "true" ]\',',
      '          \'[ "$MCP_PUBLISH_ATTEMPTED" != "true" ] && [ "$MCP_REGISTRY_CONFIRMED" != "true" ]\'',
      "        )"
    ].join("\n");
    const legacyM111CallNode = [
      "replaceExactly(",
      "          mcpbInputs.integrity,",
      "          'phase === \"convergence\" && (status === 429 || status >= 500)',",
      "          'phase === \"convergence\"'",
      "        )"
    ].join("\n");
    const legacyM112CallNode = [
      "replaceExactly(",
      "      mcpbInputs.release,",
      "      NPM_PROVENANCE_CONTEXT_COMMAND,",
      '      "true # provenance context bypassed"',
      "    )"
    ].join("\n");
    const legacyM113CallNode = [
      "replaceExactly(",
      "      mcpbInputs.integrity,",
      "      'eventName: \"push\"',",
      "      'eventName: \"workflow_dispatch\"'",
      "    )"
    ].join("\n");
    const legacyM114CallNode = [
      "replaceExactly(",
      "        mcpbInputs.release,",
      "        'require_job_reserve 4500 \"npm publish\"',",
      "        'require_job_reserve 2100 \"npm publish\"'",
      "      )"
    ].join("\n");
    const legacyM115CallNode = [
      "replaceExactly(",
      "        mcpbInputs.release,",
      "        'require_job_reserve 2700 \"token-free npm provenance verification\"',",
      "        'require_job_reserve 1200 \"token-free npm provenance verification\"'",
      "      )"
    ].join("\n");
    const legacyM116CallNode = [
      "replaceExactly(",
      "        mcpbInputs.release,",
      `        \`PROVENANCE_SHA: \\\${{ github.sha }}\`,`,
      `        \`PROVENANCE_SHA: \\\${{ github.workflow_sha }}\``,
      "      )"
    ].join("\n");
    const legacyM117CallNode = [
      "replaceExactly(",
      "        mcpbInputs.release,",
      `        \`      - name: \${NPM_PROVENANCE_STEP_NAME}\`,`,
      '        "      - name: Skipped npm provenance"',
      "      )"
    ].join("\n");
    const legacyM118CallNode = [
      "replaceExactly(",
      "        mcpbInputs.release,",
      `        \`PUBLISH_ATTEMPTED: \\\${{ steps.npm_publication.outputs.publish_attempted }}\`,`,
      "        'PUBLISH_ATTEMPTED: \"false\"'",
      "      )"
    ].join("\n");
    const legacyM119CallNode = [
      "replaceExactly(",
      "        mcpbInputs.release,",
      `        \`          RELEASE_JOB_DEADLINE_EPOCH: \\\${{ steps.deadline.outputs.epoch }}\\n\` +`,
      `          \`          EXPECTED_VERSION: \\\${{ steps.npm_publication.outputs.version }}\\n\` +`,
      `          \`          EXPECTED_SOURCE_SHA: \\\${{ steps.npm_publication.outputs.source_sha }}\\n\` +`,
      `          \`          EXPECTED_TAG: \\\${{ steps.npm_publication.outputs.tag }}\\n\` +`,
      `          \`          EXPECTED_INTEGRITY: \\\${{ steps.npm_publication.outputs.integrity }}\`,`,
      `        \`          RELEASE_JOB_DEADLINE_EPOCH: 9999999999\\n\` +`,
      `          \`          EXPECTED_VERSION: \\\${{ steps.npm_publication.outputs.version }}\\n\` +`,
      `          \`          EXPECTED_SOURCE_SHA: \\\${{ steps.npm_publication.outputs.source_sha }}\\n\` +`,
      `          \`          EXPECTED_TAG: \\\${{ steps.npm_publication.outputs.tag }}\\n\` +`,
      `          \`          EXPECTED_INTEGRITY: \\\${{ steps.npm_publication.outputs.integrity }}\``,
      "      )"
    ].join("\n");
    const legacyM120CallNode =
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Historical source expression must remain exact.
      "replaceExactly(mcpbInputs.release, '          NPM_TOKEN: \"\"', `          NPM_TOKEN: \\${{ secrets.NPM_TOKEN }}`)";
    const legacyM121CallNode =
      "replaceExactly(mcpbInputs.release, '          NPM_CLI_VERSION: \"11.18.0\"', '          NPM_CLI_VERSION: \"latest\"')";
    const legacyM122CallNode = [
      "replaceExactly(",
      "        mcpbInputs.release,",
      "        '          NPM_CLI_URL: \"https://registry.npmjs.org/npm/-/npm-11.18.0.tgz\"',",
      "        '          NPM_CLI_URL: \"https://registry.npmjs.org/npm/-/npm-latest.tgz\"'",
      "      )"
    ].join("\n");
    const legacyM123CallNode = [
      "replaceExactly(",
      "        mcpbInputs.release,",
      `        \`          NPM_CLI_SRI: "\${NPM_PROVENANCE_CLI_SRI}"\`,`,
      "        '          NPM_CLI_SRI: \"sha512-unpinned\"'",
      "      )"
    ].join("\n");
    const legacyM124CallNode =
      "replaceExactly(mcpbInputs.release, '          NPM_CLI_SIZE: \"2997746\"', '          NPM_CLI_SIZE: \"0\"')";
    const legacyM125CallNode = [
      "replaceExactly(",
      "        mcpbInputs.release,",
      "        '          NPM_GLOBALCONFIG=\"$VERIFY_ROOT/global.npmrc\"',",
      "        '          NPM_GLOBALCONFIG=\"$VERIFY_ROOT/user.npmrc\"'",
      "      )"
    ].join("\n");
    const legacyM126CallNode = [
      "replaceExactly(",
      "        mcpbInputs.release,",
      '        \'/usr/bin/touch "$NPM_USERCONFIG" "$NPM_GLOBALCONFIG"\',',
      '        \'/bin/true "$NPM_USERCONFIG" "$NPM_GLOBALCONFIG"\'',
      "      )"
    ].join("\n");
    const legacyM127CallNode = [
      "replaceExactly(",
      "        mcpbInputs.release,",
      '        \'/bin/chmod 600 "$NPM_USERCONFIG" "$NPM_GLOBALCONFIG"\',',
      '        \'/bin/chmod 644 "$NPM_USERCONFIG" "$NPM_GLOBALCONFIG"\'',
      "      )"
    ].join("\n");
    const legacyM128CallNode = [
      "replaceExactly(",
      "        mcpbInputs.release,",
      "        '\"NPM_CONFIG_USERCONFIG=$NPM_USERCONFIG\"',",
      "        '\"NPM_CONFIG_USERCONFIG=/dev/null\"'",
      "      )"
    ].join("\n");
    const legacyM129CallNode =
      "replaceExactly(mcpbInputs.release, '\"NPM_CONFIG_PREFER_ONLINE=true\"', " +
      "'\"NPM_CONFIG_PREFER_ONLINE=false\"')";
    const legacyM130CallNode =
      'replaceExactly(mcpbInputs.release, "--max-filesize 4194304 --retry 0", "--max-filesize 4194304 --retry 1")';
    expect(sha256Text(legacyM108CallNode)).toBe("067bacefc171385fbf496ba6d7e25ad9403569d2a8daeba29e483e8c486507b8");
    expect(sha256Text(legacyM107CallNode)).toBe("b67c164531f5a0702f1ceb3ec750cf4df6f655ac68d12fbb31bf04db35ca5325");
    expect(sha256Text(legacyM109CallNode)).toBe("24c05d112a2d846080b17c7413f555c37b2c50a54975f16a985d8b1018b2d711");
    expect(sha256Text(legacyM110CallNode)).toBe("69e2c8d2350a13c0b755c30190653e9d60a78c7eac7ca5996f624663a0d31c8d");
    expect(sha256Text(legacyM111CallNode)).toBe("77aaafb7f62f9bb1addab5347cb5e704ece40a7354569378d17d1881bb3e1479");
    expect(sha256Text(legacyM112CallNode)).toBe("2472b8e6ac2bbd1d245fe3c4a80a0e02feb000823d261169c21161a276c54b0d");
    expect(sha256Text(legacyM113CallNode)).toBe("ebe9c3077c0627c8d7ac444bbfaf9fedf4e51e6c152ca81593c40bf6dc831742");
    expect(sha256Text(legacyM114CallNode)).toBe("33eafb51e59c895771d9b0523834365e423477bdee438022ebba3866ac293581");
    expect(sha256Text(legacyM115CallNode)).toBe("32f57ce2ec034103af6ada47d96577ac16df4c63e90c2ea31994b106f4955576");
    expect(sha256Text(legacyM116CallNode)).toBe("54be2d32d9f71d6781fa5b76a93b19373e8387f0c99452104b3676ab8060c27c");
    expect(sha256Text(legacyM117CallNode)).toBe("6255d6dc505099d10ea951efa0ff2bd01583bce7caeb565dd28ffa9d6415b9c1");
    expect(sha256Text(legacyM118CallNode)).toBe("2ee0dd47ee5eff32f85a211d3ff97442bcb04cf9dbdfc40adaeb2168d4186da9");
    expect(sha256Text(legacyM119CallNode)).toBe("7a36fed60778fadcf6d4201175b6b9bfa95fc3abfde05f3c63b107f56b72d791");
    expect(sha256Text(legacyM120CallNode)).toBe("ccd2d90b61c718eb1eda20534d4f4aceba81f47204934f8fd5121614c8fd02f4");
    expect(sha256Text(legacyM121CallNode)).toBe("1d3cc9522c1816d75444d959205382473a871c923c368c70428f0726b3ce9c94");
    expect(sha256Text(legacyM122CallNode)).toBe("7a7621c1f9a23dff5d41a78a1b2d7cd93064c016b5f1096cbba461f75bcabe1e");
    expect(sha256Text(legacyM123CallNode)).toBe("291ff89757fe8bdf1802128e2d5eaa50b97bf911c1d1e8f2556134b212b311b0");
    expect(sha256Text(legacyM124CallNode)).toBe("9c2db9142fa26ee12b3bacdcddf25454e02e115512fb4a4046a7551f865969d6");
    expect(sha256Text(legacyM125CallNode)).toBe("831d3bdfe43fbb0c1a5bc6edea87c729869d52df54316814b734f1a09d47e048");
    expect(sha256Text(legacyM126CallNode)).toBe("a57fcbf5f69a93231f615fa5adbbb9209b999b5da510f75bf4083c544f878057");
    expect(sha256Text(legacyM127CallNode)).toBe("fcff4d18f06c85f3f808501ff9bf1e361422b61a4e7c5e3d157d1bb0aad19d26");
    expect(sha256Text(legacyM128CallNode)).toBe("ab716cd073b425a0fc02698dbc5cffa1089648e086c65f0ef15664e5ba8b99c5");
    expect(sha256Text(legacyM129CallNode)).toBe("aba88ee9863569cd07d1d8c96991f90391ac82a2616562c2556559315ae691ac");
    expect(sha256Text(legacyM130CallNode)).toBe("dabf96e7320490ff03e46edf67376cf6a77c09687d4802a03d552fa2ad18c70f");
    const resurrectedRegistryRoots = replaceExactly(
      matrixSource,
      finalRequiredReleaseCheck,
      [
        `    void ${legacyM107CallNode};`,
        `    void ${legacyM109CallNode};`,
        `    void ${legacyM110CallNode};`,
        `    void ${legacyM111CallNode};`,
        `    void ${legacyM112CallNode};`,
        `    void ${legacyM113CallNode};`,
        `    void ${legacyM114CallNode};`,
        `    void ${legacyM115CallNode};`,
        `    void ${legacyM116CallNode};`,
        `    void ${legacyM117CallNode};`,
        `    void ${legacyM118CallNode};`,
        `    void ${legacyM119CallNode};`,
        `    void ${legacyM120CallNode};`,
        `    void ${legacyM121CallNode};`,
        `    void ${legacyM122CallNode};`,
        `    void ${legacyM123CallNode};`,
        `    void ${legacyM124CallNode};`,
        `    void ${legacyM125CallNode};`,
        `    void ${legacyM126CallNode};`,
        `    void ${legacyM127CallNode};`,
        `    void ${legacyM128CallNode};`,
        `    void ${legacyM129CallNode};`,
        `    void ${legacyM130CallNode};`,
        finalRequiredReleaseCheck
      ].join("\n")
    );
    const resurrectedRegistryProblems = preparedAudit.auditMatrix(resurrectedRegistryRoots);
    expect(resurrectedRegistryProblems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m108 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m107 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m109 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m110 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m111 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m112 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m113 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m114 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m115 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m116 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m117 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m118 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m119 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m120 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m121 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m122 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m123 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m124 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m125 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m126 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m127 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m128 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m129 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m130 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        )
      ])
    );
    expect(resurrectedRegistryProblems).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /remaining legacy order|legacy case .* has no remaining root call|remaining matcher census/
        )
      ])
    );

    const m108BlockStart = matrixSource.indexOf(
      '    const releaseMutationM108 = releaseMutationPlan.registerMutation("release.m108", {'
    );
    const m107BlockStart = matrixSource.indexOf(
      '    const releaseMutationM107 = releaseMutationPlan.registerMutation("release.m107", {'
    );
    const m109BlockStart = matrixSource.indexOf(
      '    const releaseMutationM109 = releaseMutationPlan.registerMutation("release.m109", {'
    );
    const m110BlockStart = matrixSource.indexOf(
      '    const releaseMutationM110 = releaseMutationPlan.registerMutation("release.m110", {'
    );
    const m111BlockStart = matrixSource.indexOf(
      '    const releaseMutationM111 = releaseMutationPlan.registerMutation("release.m111", {'
    );
    const releaseWorkflowSourceStart = matrixSource.indexOf(
      "    const releaseWorkflowFixtureSource = releaseMutationPlan.registerSource("
    );
    const m112BlockStart = matrixSource.indexOf(
      '    const releaseMutationM112 = releaseMutationPlan.registerMutation("release.m112", {'
    );
    const m113BlockStart = matrixSource.indexOf(
      '    const releaseMutationM113 = releaseMutationPlan.registerMutation("release.m113", {'
    );
    const m114BlockStart = matrixSource.indexOf(
      '    const releaseMutationM114 = releaseMutationPlan.registerMutation("release.m114", {'
    );
    const m115BlockStart = matrixSource.indexOf(
      '    const releaseMutationM115 = releaseMutationPlan.registerMutation("release.m115", {'
    );
    const m116BlockStart = matrixSource.indexOf(
      '    const releaseMutationM116 = releaseMutationPlan.registerMutation("release.m116", {'
    );
    const m117BlockStart = matrixSource.indexOf(
      '    const releaseMutationM117 = releaseMutationPlan.registerMutation("release.m117", {'
    );
    const m118BlockStart = matrixSource.indexOf(
      '    const releaseMutationM118 = releaseMutationPlan.registerMutation("release.m118", {'
    );
    const m119BlockStart = matrixSource.indexOf(
      '    const releaseMutationM119 = releaseMutationPlan.registerMutation("release.m119", {'
    );
    const m120BlockStart = matrixSource.indexOf(
      '    const releaseMutationM120 = releaseMutationPlan.registerMutation("release.m120", {'
    );
    const m121BlockStart = matrixSource.indexOf(
      '    const releaseMutationM121 = releaseMutationPlan.registerMutation("release.m121", {'
    );
    const m122BlockStart = matrixSource.indexOf(
      '    const releaseMutationM122 = releaseMutationPlan.registerMutation("release.m122", {'
    );
    const m123BlockStart = matrixSource.indexOf(
      '    const releaseMutationM123 = releaseMutationPlan.registerMutation("release.m123", {'
    );
    const m124BlockStart = matrixSource.indexOf(
      '    const releaseMutationM124 = releaseMutationPlan.registerMutation("release.m124", {'
    );
    const m125BlockStart = matrixSource.indexOf(
      '    const releaseMutationM125 = releaseMutationPlan.registerMutation("release.m125", {'
    );
    const m126BlockStart = matrixSource.indexOf(
      '    const releaseMutationM126 = releaseMutationPlan.registerMutation("release.m126", {'
    );
    const m127BlockStart = matrixSource.indexOf(
      '    const releaseMutationM127 = releaseMutationPlan.registerMutation("release.m127", {'
    );
    const m128BlockStart = matrixSource.indexOf(
      '    const releaseMutationM128 = releaseMutationPlan.registerMutation("release.m128", {'
    );
    const m129BlockStart = matrixSource.indexOf(
      '    const releaseMutationM129 = releaseMutationPlan.registerMutation("release.m129", {'
    );
    const m130BlockStart = matrixSource.indexOf(
      '    const releaseMutationM130 = releaseMutationPlan.registerMutation("release.m130", {'
    );
    const declarativeSealStart = matrixSource.indexOf(
      "    const releaseMutationProblems = releaseMutationPlan.seal();",
      m130BlockStart
    );
    expect(m108BlockStart).toBeGreaterThan(0);
    expect(m107BlockStart).toBeGreaterThan(m108BlockStart);
    expect(m109BlockStart).toBeGreaterThan(m107BlockStart);
    expect(m110BlockStart).toBeGreaterThan(m109BlockStart);
    expect(m111BlockStart).toBeGreaterThan(m110BlockStart);
    expect(releaseWorkflowSourceStart).toBeGreaterThan(m111BlockStart);
    expect(m112BlockStart).toBeGreaterThan(releaseWorkflowSourceStart);
    expect(m113BlockStart).toBeGreaterThan(m112BlockStart);
    expect(m114BlockStart).toBeGreaterThan(m113BlockStart);
    expect(m115BlockStart).toBeGreaterThan(m114BlockStart);
    expect(m116BlockStart).toBeGreaterThan(m115BlockStart);
    expect(m117BlockStart).toBeGreaterThan(m116BlockStart);
    expect(m118BlockStart).toBeGreaterThan(m117BlockStart);
    expect(m119BlockStart).toBeGreaterThan(m118BlockStart);
    expect(m120BlockStart).toBeGreaterThan(m119BlockStart);
    expect(m121BlockStart).toBeGreaterThan(m120BlockStart);
    expect(m122BlockStart).toBeGreaterThan(m121BlockStart);
    expect(m123BlockStart).toBeGreaterThan(m122BlockStart);
    expect(m124BlockStart).toBeGreaterThan(m123BlockStart);
    expect(m125BlockStart).toBeGreaterThan(m124BlockStart);
    expect(m126BlockStart).toBeGreaterThan(m125BlockStart);
    expect(m127BlockStart).toBeGreaterThan(m126BlockStart);
    expect(m128BlockStart).toBeGreaterThan(m127BlockStart);
    expect(m129BlockStart).toBeGreaterThan(m128BlockStart);
    expect(m130BlockStart).toBeGreaterThan(m129BlockStart);
    expect(declarativeSealStart).toBeGreaterThan(m130BlockStart);
    const swappedRegistryDependencyDeclarations = [
      matrixSource.slice(0, m108BlockStart),
      matrixSource.slice(m107BlockStart, m109BlockStart),
      matrixSource.slice(m108BlockStart, m107BlockStart),
      matrixSource.slice(m109BlockStart)
    ].join("");
    const swappedNpmDeclarations = [
      swappedRegistryDependencyDeclarations.slice(0, m112BlockStart),
      swappedRegistryDependencyDeclarations.slice(m113BlockStart, declarativeSealStart),
      swappedRegistryDependencyDeclarations.slice(m112BlockStart, m113BlockStart),
      swappedRegistryDependencyDeclarations.slice(declarativeSealStart)
    ].join("");
    expect(preparedAudit.auditMatrix(swappedNpmDeclarations)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/release mutation hybrid declarative allowlist must be exact/),
        expect.stringMatching(/release mutation hybrid case allowlist must be exact/),
        expect.stringMatching(
          /release mutation hybrid registrations must be exact contiguous.*expected mutation:release\.m108, found mutation:release\.m107/
        )
      ])
    );

    const m107SourceDependencyDrift = replaceExactly(
      matrixSource,
      "      source: releaseMutationM108,",
      "      source: registryPublishStepSource,"
    );
    const m109CompanionDrift = replaceExactly(
      m107SourceDependencyDrift,
      [
        '            kind: "registry.step.run",',
        "            baseline: registryPublishStepSource,",
        "            mutant: releaseMutationM109,",
        "            integrity: releaseIntegritySource"
      ].join("\n"),
      [
        '            kind: "registry.step.run",',
        "            baseline: registryPublishStepSource,",
        "            mutant: releaseMutationM109,",
        "            integrity: registryPublishStepSource"
      ].join("\n")
    );
    const registryRunInvocationDrift = replaceExactly(
      m109CompanionDrift,
      [
        '            kind: "registry.step.run",',
        "            baseline: registryPublishStepSource,",
        "            mutant: releaseMutationM110,",
        "            integrity: releaseIntegritySource"
      ].join("\n"),
      [
        '            kind: "registry.step.run",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM110,",
        "            integrity: releaseIntegritySource"
      ].join("\n")
    );
    const registryInvocationDrift = replaceExactly(
      registryRunInvocationDrift,
      [
        '            kind: "registry.step.integrity",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM111,",
        "            run: registryPublishStepSource"
      ].join("\n"),
      [
        '            kind: "registry.step.integrity",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM111,",
        "            run: releaseIntegritySource"
      ].join("\n")
    );
    const npmReleaseInvocationDrift = replaceExactly(
      registryInvocationDrift,
      [
        '            kind: "npm.contract.release",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM112,",
        "            integrity: releaseIntegritySource"
      ].join("\n"),
      [
        '            kind: "npm.contract.release",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM112,",
        "            integrity: releaseWorkflowFixtureSource"
      ].join("\n")
    );
    const releaseOracleInvocationDrift = replaceExactly(
      npmReleaseInvocationDrift,
      [
        '            kind: "npm.contract.integrity",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM113,",
        "            release: releaseWorkflowFixtureSource"
      ].join("\n"),
      [
        '            kind: "npm.contract.integrity",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM113,",
        "            release: releaseIntegritySource"
      ].join("\n")
    );
    const npmWorkflowM114InvocationDrift = replaceExactly(
      releaseOracleInvocationDrift,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM114"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM114"
      ].join("\n")
    );
    const npmWorkflowM115InvocationDrift = replaceExactly(
      npmWorkflowM114InvocationDrift,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM115"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM115"
      ].join("\n")
    );
    const npmWorkflowM116InvocationDrift = replaceExactly(
      npmWorkflowM115InvocationDrift,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM116"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM116"
      ].join("\n")
    );
    const npmWorkflowM117InvocationDrift = replaceExactly(
      npmWorkflowM116InvocationDrift,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM117"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM117"
      ].join("\n")
    );
    const npmWorkflowM118InvocationDrift = replaceExactly(
      npmWorkflowM117InvocationDrift,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM118"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM118"
      ].join("\n")
    );
    const npmWorkflowM119InvocationDrift = replaceExactly(
      npmWorkflowM118InvocationDrift,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM119"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM119"
      ].join("\n")
    );
    const npmWorkflowM120InvocationDrift = replaceExactly(
      npmWorkflowM119InvocationDrift,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM120"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM120"
      ].join("\n")
    );
    const npmWorkflowM121InvocationDrift = replaceExactly(
      npmWorkflowM120InvocationDrift,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM121"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM121"
      ].join("\n")
    );
    const npmWorkflowM122InvocationDrift = replaceExactly(
      npmWorkflowM121InvocationDrift,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM122"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM122"
      ].join("\n")
    );
    const npmWorkflowM123InvocationDrift = replaceExactly(
      npmWorkflowM122InvocationDrift,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM123"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM123"
      ].join("\n")
    );
    const npmWorkflowM124InvocationDrift = replaceExactly(
      npmWorkflowM123InvocationDrift,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM124"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM124"
      ].join("\n")
    );
    const npmWorkflowM125InvocationDrift = replaceExactly(
      npmWorkflowM124InvocationDrift,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM125"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM125"
      ].join("\n")
    );
    const npmWorkflowM126InvocationDrift = replaceExactly(
      npmWorkflowM125InvocationDrift,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM126"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM126"
      ].join("\n")
    );
    const npmWorkflowM127InvocationDrift = replaceExactly(
      npmWorkflowM126InvocationDrift,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM127"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM127"
      ].join("\n")
    );
    const npmWorkflowM128InvocationDrift = replaceExactly(
      npmWorkflowM127InvocationDrift,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM128"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM128"
      ].join("\n")
    );
    const npmWorkflowM129InvocationDrift = replaceExactly(
      npmWorkflowM128InvocationDrift,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM129"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM129"
      ].join("\n")
    );
    const npmWorkflowInvocationDrift = replaceExactly(
      npmWorkflowM129InvocationDrift,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM130"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM130"
      ].join("\n")
    );
    expect(preparedAudit.auditMatrix(npmWorkflowInvocationDrift)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /release mutation hybrid descriptor release\.m107 disagrees with its exact frozen semantics/
        ),
        expect.stringMatching(/release mutation hybrid case release\.case\.m109 invocation must retain its exact/),
        expect.stringMatching(/release mutation hybrid case release\.case\.m110 invocation must retain its exact/),
        expect.stringMatching(/release mutation hybrid case release\.case\.m111 invocation must retain its exact/),
        expect.stringMatching(/release mutation hybrid case release\.case\.m112 invocation must retain its exact/),
        expect.stringMatching(/release mutation hybrid case release\.case\.m113 invocation must retain its exact/),
        expect.stringMatching(/release mutation hybrid case release\.case\.m114 invocation must retain its exact/),
        expect.stringMatching(/release mutation hybrid case release\.case\.m115 invocation must retain its exact/),
        expect.stringMatching(/release mutation hybrid case release\.case\.m116 invocation must retain its exact/),
        expect.stringMatching(/release mutation hybrid case release\.case\.m117 invocation must retain its exact/),
        expect.stringMatching(/release mutation hybrid case release\.case\.m118 invocation must retain its exact/),
        expect.stringMatching(/release mutation hybrid case release\.case\.m119 invocation must retain its exact/),
        expect.stringMatching(/release mutation hybrid case release\.case\.m120 invocation must retain its exact/),
        expect.stringMatching(/release mutation hybrid case release\.case\.m121 invocation must retain its exact/),
        expect.stringMatching(/release mutation hybrid case release\.case\.m122 invocation must retain its exact/),
        expect.stringMatching(/release mutation hybrid case release\.case\.m123 invocation must retain its exact/),
        expect.stringMatching(/release mutation hybrid case release\.case\.m124 invocation must retain its exact/),
        expect.stringMatching(/release mutation hybrid case release\.case\.m125 invocation must retain its exact/),
        expect.stringMatching(/release mutation hybrid case release\.case\.m126 invocation must retain its exact/),
        expect.stringMatching(/release mutation hybrid case release\.case\.m127 invocation must retain its exact/),
        expect.stringMatching(/release mutation hybrid case release\.case\.m128 invocation must retain its exact/),
        expect.stringMatching(/release mutation hybrid case release\.case\.m129 invocation must retain its exact/),
        expect.stringMatching(/release mutation hybrid case release\.case\.m130 invocation must retain its exact/)
      ])
    );

    const nonAdjacentSeal = replaceExactly(
      matrixSource,
      "    const releaseMutationProblems = releaseMutationPlan.seal();",
      "    void registryRun;\n    const releaseMutationProblems = releaseMutationPlan.seal();"
    );
    expect(preparedAudit.auditMatrix(nonAdjacentSeal)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/release mutation hybrid lifecycle must be one clean seal followed by the exact m037/)
      ])
    );

    // NEGATIVE control: an exact-text but root-unbound second physical matcher must
    // fail the global span multiplicity check instead of borrowing a legacy root.
    const sharedRegistryMatcherLoop = [
      "    for (const weakenedRegistryStep of weakenedRegistrySteps) {",
      "      expect(mcpRegistryStepProblems(weakenedRegistryStep, mcpbInputs.integrity)).toContain(",
      "        MCP_REGISTRY_WORKFLOW_CONTRACT_PROBLEM",
      "      );",
      "    }"
    ].join("\n");
    const duplicateSharedRegistryMatcher = replaceExactly(
      matrixSource,
      sharedRegistryMatcherLoop,
      [
        sharedRegistryMatcherLoop,
        "    void ((weakenedRegistryStep: YamlRecord) => {",
        "      expect(mcpRegistryStepProblems(weakenedRegistryStep, mcpbInputs.integrity)).toContain(",
        "        MCP_REGISTRY_WORKFLOW_CONTRACT_PROBLEM",
        "      );",
        "    });"
      ].join("\n")
    );
    const sharedNpmWorkflowMatcher =
      "      expect(npmProvenanceWorkflowProblems(weakenedProvenanceWorkflow)).toContain(NPM_PROVENANCE_CONTRACT_PROBLEM);";
    const duplicateSharedPrimaryMatchers = replaceExactly(
      duplicateSharedRegistryMatcher,
      sharedNpmWorkflowMatcher,
      [sharedNpmWorkflowMatcher, sharedNpmWorkflowMatcher].join("\n")
    );
    expect(preparedAudit.auditMatrix(duplicateSharedPrimaryMatchers)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/release mutation hybrid current source must retain exact SHA-256/),
        expect.stringMatching(/release mutation hybrid matcher 5e2815d5.*physical multiplicity must equal 1 .*found 2/),
        expect.stringMatching(/release mutation hybrid matcher 3df3ee2e.*physical multiplicity must equal 1 .*found 2/)
      ])
    );

    // NEGATIVE control: migrated-only frozen matcher hashes must remain physically
    // absent even when their exact historical root-bound assertions are appended after the tail.
    const legacyM111MatcherNode = [
      "expect(",
      "      mcpRegistryStepProblems(",
      "        registryStep,",
      `        ${legacyM111CallNode}`,
      "      )",
      "    ).toContain(MCP_REGISTRY_WORKFLOW_CONTRACT_PROBLEM)"
    ].join("\n");
    const legacyM112MatcherNode = [
      "expect(npmProvenanceContractProblems(provenanceWorkflowCompositionMutation, mcpbInputs.integrity)).toContain(",
      "      NPM_PROVENANCE_CONTRACT_PROBLEM",
      "    )"
    ].join("\n");
    const legacyM113MatcherNode = [
      "expect(npmProvenanceContractProblems(mcpbInputs.release, provenanceEvaluatorCompositionMutation)).toContain(",
      "      NPM_PROVENANCE_CONTRACT_PROBLEM",
      "    )"
    ].join("\n");
    expect(sha256Text(legacyM111MatcherNode)).toBe("f77d156123db5a20c3cb2984980ad88548547a95d673ff9315d1be394ba86c5d");
    expect(sha256Text(legacyM112MatcherNode)).toBe("70d1140baaad93fc1a0491e5da0b6d8d3c4474a6989db7642db4f0602ab0715a");
    expect(sha256Text(legacyM113MatcherNode)).toBe("1b65bfa3daf8f47b905b8593e9e7abb7f6aa1a93724a7f9609e43421e93d9e94");
    const resurrectedMigratedRegistryMatcher = replaceExactly(
      matrixSource,
      finalRequiredReleaseCheck,
      [
        `    void ${legacyM111MatcherNode};`,
        `    const provenanceWorkflowCompositionMutation = ${legacyM112CallNode};`,
        `    void ${legacyM112MatcherNode};`,
        `    const provenanceEvaluatorCompositionMutation = ${legacyM113CallNode};`,
        `    void ${legacyM113MatcherNode};`,
        finalRequiredReleaseCheck
      ].join("\n")
    );
    const resurrectedMigratedRegistryMatcherProblems = preparedAudit.auditMatrix(resurrectedMigratedRegistryMatcher);
    expect(resurrectedMigratedRegistryMatcherProblems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/release mutation hybrid current source must retain exact SHA-256/),
        expect.stringMatching(/release mutation hybrid current matrix slice must retain exact SHA-256/),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m111 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m112 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(
          /release mutation hybrid frozen ID release\.m113 must exist in exactly one legacy XOR declarative representation; found 1\/1/
        ),
        expect.stringMatching(/release mutation hybrid matcher f77d1561.*physical multiplicity must equal 0 .*found 1/),
        expect.stringMatching(/release mutation hybrid matcher 70d1140b.*physical multiplicity must equal 0 .*found 1/),
        expect.stringMatching(/release mutation hybrid matcher 1b65bfa3.*physical multiplicity must equal 0 .*found 1/)
      ])
    );
    expect(resurrectedMigratedRegistryMatcherProblems).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /remaining legacy order|legacy case .* has no remaining root call|remaining matcher census/
        )
      ])
    );

    // NEGATIVE control: removing the one residual physical matcher must fail the
    // same class invariant even though its 69 remaining legacy root mutations remain in place.
    const missingSharedRegistryMatcher = replaceExactly(
      matrixSource,
      sharedRegistryMatcherLoop,
      [
        "    for (const weakenedRegistryStep of weakenedRegistrySteps) {",
        "      void weakenedRegistryStep;",
        "    }"
      ].join("\n")
    );
    expect(preparedAudit.auditMatrix(missingSharedRegistryMatcher)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/release mutation hybrid current source must retain exact SHA-256/),
        expect.stringMatching(/release mutation hybrid current matrix slice must retain exact SHA-256/),
        expect.stringMatching(/release mutation hybrid matcher 5e2815d5.*physical multiplicity must equal 1 .*found 0/)
      ])
    );

    // NEGATIVE control: creation order is not runtime order if a named iterable
    // is reversed between construction and its shared matcher loop.
    const reversedSharedRegistryIterable = replaceExactly(
      matrixSource,
      sharedRegistryMatcherLoop,
      ["    weakenedRegistrySteps.reverse();", sharedRegistryMatcherLoop].join("\n")
    );
    expect(preparedAudit.auditMatrix(reversedSharedRegistryIterable)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/release mutation hybrid current source must retain exact SHA-256/),
        expect.stringMatching(/release mutation hybrid current matrix slice must retain exact SHA-256/),
        expect.stringMatching(
          /release mutation hybrid shared primary matcher 5e2815d5.*exact closed iterable\/runtime topology for 69 frozen root/
        )
      ])
    );

    // NEGATIVE control: an alias can preserve the named array's bytes while
    // inserting an unreviewed runtime hop between the frozen array and loop.
    const aliasedSharedRegistryIterable = replaceExactly(
      matrixSource,
      sharedRegistryMatcherLoop,
      [
        "    const aliasedWeakenedRegistrySteps = weakenedRegistrySteps;",
        "    for (const weakenedRegistryStep of aliasedWeakenedRegistrySteps) {",
        "      expect(mcpRegistryStepProblems(weakenedRegistryStep, mcpbInputs.integrity)).toContain(",
        "        MCP_REGISTRY_WORKFLOW_CONTRACT_PROBLEM",
        "      );",
        "    }"
      ].join("\n")
    );
    expect(preparedAudit.auditMatrix(aliasedSharedRegistryIterable)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/release mutation hybrid current source must retain exact SHA-256/),
        expect.stringMatching(/release mutation hybrid current matrix slice must retain exact SHA-256/),
        expect.stringMatching(
          /release mutation hybrid shared primary matcher 5e2815d5.*exact closed iterable\/runtime topology for 69 frozen root/
        )
      ])
    );

    // NEGATIVE control: even a value-preserving alternate iterable is outside
    // the exact named-array execution topology and could later hide filtering.
    const copiedSharedRegistryIterable = replaceExactly(
      matrixSource,
      "    for (const weakenedRegistryStep of weakenedRegistrySteps) {",
      "    for (const weakenedRegistryStep of weakenedRegistrySteps.slice()) {"
    );
    expect(preparedAudit.auditMatrix(copiedSharedRegistryIterable)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/release mutation hybrid current source must retain exact SHA-256/),
        expect.stringMatching(/release mutation hybrid current matrix slice must retain exact SHA-256/),
        expect.stringMatching(
          /release mutation hybrid shared primary matcher 5e2815d5.*exact closed iterable\/runtime topology for 69 frozen root/
        )
      ])
    );

    // NEGATIVE control: the exact loop cannot be made conditional, repeated or
    // exception-dependent by placing it under another callback-body statement.
    const wrappedSharedRegistryMatcher = replaceExactly(
      matrixSource,
      sharedRegistryMatcherLoop,
      ["    if (false) {", sharedRegistryMatcherLoop, "    }"].join("\n")
    );
    expect(preparedAudit.auditMatrix(wrappedSharedRegistryMatcher)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/release mutation hybrid current source must retain exact SHA-256/),
        expect.stringMatching(/release mutation hybrid current matrix slice must retain exact SHA-256/),
        expect.stringMatching(
          /release mutation hybrid shared primary matcher 5e2815d5.*exact closed iterable\/runtime topology for 69 frozen root/
        )
      ])
    );

    // NEGATIVE control: a direct loop is still unreachable if the matrix callback
    // returns first. Returns in nested helpers remain outside this callback guard.
    const returnedBeforeSharedRegistryMatcher = replaceExactly(
      matrixSource,
      sharedRegistryMatcherLoop,
      ["    if (true) return;", sharedRegistryMatcherLoop].join("\n")
    );
    expect(preparedAudit.auditMatrix(returnedBeforeSharedRegistryMatcher)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/release mutation hybrid current source must retain exact SHA-256/),
        expect.stringMatching(/release mutation hybrid current matrix slice must retain exact SHA-256/),
        expect.stringMatching(/release mutation hybrid matrix callback must not return before all case executions/)
      ])
    );

    // NEGATIVE control: the four non-manifest Registry mutations are not merely
    // a count. Their exact reviewed expressions must remain inert until detection.
    const poisonedRegistryOwnerlessPrefix = replaceExactly(
      matrixSource,
      '{ ...registryStep, if: "always()" }',
      '(() => { throw new Error("ownerless-prefix-bypass"); })()'
    );
    expect(preparedAudit.auditMatrix(poisonedRegistryOwnerlessPrefix)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/release mutation hybrid current source must retain exact SHA-256/),
        expect.stringMatching(/release mutation hybrid current matrix slice must retain exact SHA-256/),
        expect.stringMatching(
          /release mutation hybrid shared primary matcher 5e2815d5.*exact closed iterable\/runtime topology for 69 frozen root/
        )
      ])
    );

    // NEGATIVE control: merely mentioning a carrier root is insufficient. The
    // exact carrier value itself must be the sole Registry wrapper argument.
    const discardedRegistryCarrier = replaceExactly(
      matrixSource,
      "      registryStepWithRun(fragmentedCurlWriteRun),",
      "      (false ? registryStepWithRun(fragmentedCurlWriteRun) : registryStep),"
    );
    expect(preparedAudit.auditMatrix(discardedRegistryCarrier)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/release mutation hybrid current source must retain exact SHA-256/),
        expect.stringMatching(/release mutation hybrid current matrix slice must retain exact SHA-256/),
        expect.stringMatching(
          /release mutation hybrid shared primary matcher 5e2815d5.*exact closed iterable\/runtime topology for 69 frozen root/
        )
      ])
    );

    // NEGATIVE control: a direct Registry root cannot execute and then be
    // discarded through a comma expression before registryStepWithRun receives it.
    const discardedDirectRegistryRoot = replaceExactly(
      matrixSource,
      [
        "      registryStepWithRun(",
        "        replaceExactly(registryRun, 'GH_CONFIG_DIR=\"$WORK_ROOT/gh-config\"', " +
          "'GH_CONFIG_DIR=\"$GITHUB_WORKSPACE\"')",
        "      ),"
      ].join("\n"),
      [
        "      registryStepWithRun(",
        "        (replaceExactly(registryRun, 'GH_CONFIG_DIR=\"$WORK_ROOT/gh-config\"', " +
          "'GH_CONFIG_DIR=\"$GITHUB_WORKSPACE\"'), registryRun)",
        "      ),"
      ].join("\n")
    );
    expect(preparedAudit.auditMatrix(discardedDirectRegistryRoot)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/release mutation hybrid current source must retain exact SHA-256/),
        expect.stringMatching(/release mutation hybrid current matrix slice must retain exact SHA-256/),
        expect.stringMatching(
          /release mutation hybrid shared primary matcher 5e2815d5.*exact closed iterable\/runtime topology for 69 frozen root/
        )
      ])
    );

    // NEGATIVE control: non-Registry shared arrays also require the root call's
    // resulting mutant, not a comma expression that returns the clean source.
    const discardedProvenanceRoot = replaceExactly(
      matrixSource,
      '      replaceExactly(mcpbInputs.release, \'[ "$NPM_CLI_ACTUAL_SRI" != "$NPM_CLI_SRI" ]\', "false"),',
      [
        "      (",
        "        replaceExactly(",
        "          mcpbInputs.release,",
        '          \'[ "$NPM_CLI_ACTUAL_SRI" != "$NPM_CLI_SRI" ]\',',
        '          "false"',
        "        ),",
        "        mcpbInputs.release",
        "      ),"
      ].join("\n")
    );
    expect(preparedAudit.auditMatrix(discardedProvenanceRoot)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/release mutation hybrid current source must retain exact SHA-256/),
        expect.stringMatching(/release mutation hybrid current matrix slice must retain exact SHA-256/),
        expect.stringMatching(
          /release mutation hybrid shared primary matcher 3df3ee2e.*exact closed iterable\/runtime topology for 18 frozen root/
        )
      ])
    );

    // NEGATIVE control: the shared matcher must execute unconditionally once for
    // every iterable element; a continue path cannot preserve the certified trace.
    const conditionallySkippedSharedRegistryMatcher = replaceExactly(
      matrixSource,
      sharedRegistryMatcherLoop,
      [
        "    for (const weakenedRegistryStep of weakenedRegistrySteps) {",
        "      if (weakenedRegistryStep) continue;",
        "      expect(mcpRegistryStepProblems(weakenedRegistryStep, mcpbInputs.integrity)).toContain(",
        "        MCP_REGISTRY_WORKFLOW_CONTRACT_PROBLEM",
        "      );",
        "    }"
      ].join("\n")
    );
    expect(preparedAudit.auditMatrix(conditionallySkippedSharedRegistryMatcher)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/release mutation hybrid current source must retain exact SHA-256/),
        expect.stringMatching(/release mutation hybrid current matrix slice must retain exact SHA-256/),
        expect.stringMatching(
          /release mutation hybrid shared primary matcher 5e2815d5.*exact closed iterable\/runtime topology for 69 frozen root/
        )
      ])
    );

    // NEGATIVE control: the indexed shared loop must consume its entire exact
    // dense case array, not a shortened literal prefix.
    const shortenedTransactionMutationLoop = replaceExactly(
      matrixSource,
      [
        "    for (let mutationIndex = 0; mutationIndex < 76; mutationIndex++) {",
        "      const { mutant, expectedProblem } = releaseTransactionMutationCases[mutationIndex]!;"
      ].join("\n"),
      [
        "    for (let mutationIndex = 0; mutationIndex < 75; mutationIndex++) {",
        "      const { mutant, expectedProblem } = releaseTransactionMutationCases[mutationIndex]!;"
      ].join("\n")
    );
    expect(preparedAudit.auditMatrix(shortenedTransactionMutationLoop)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/release mutation hybrid current source must retain exact SHA-256/),
        expect.stringMatching(/release mutation hybrid current matrix slice must retain exact SHA-256/),
        expect.stringMatching(
          /release mutation hybrid shared primary matcher df5a0075.*exact closed iterable\/runtime topology for 76 frozen root/
        )
      ])
    );

    // NEGATIVE control: object aliases can retain both field names and matcher
    // text while routing the detector to expectedProblem instead of the mutant.
    const swappedTransactionBindings = replaceExactly(
      matrixSource,
      "      const { mutant, expectedProblem } = releaseTransactionMutationCases[mutationIndex]!;",
      "      const { mutant: expectedProblem, expectedProblem: mutant } = " +
        "releaseTransactionMutationCases[mutationIndex]!;"
    );
    expect(preparedAudit.auditMatrix(swappedTransactionBindings)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/release mutation hybrid current source must retain exact SHA-256/),
        expect.stringMatching(/release mutation hybrid current matrix slice must retain exact SHA-256/),
        expect.stringMatching(
          /release mutation hybrid shared primary matcher df5a0075.*exact closed iterable\/runtime topology for 76 frozen root/
        )
      ])
    );

    // NEGATIVE control: tuple binding order is part of execution identity. The
    // same matcher text must not consume the diagnostic label as release source.
    const swappedTagIdentityBindings = replaceExactly(
      matrixSource,
      "    for (const [label, weakenedRelease] of [",
      "    for (const [weakenedRelease, label] of ["
    );
    expect(preparedAudit.auditMatrix(swappedTagIdentityBindings)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/release mutation hybrid current source must retain exact SHA-256/),
        expect.stringMatching(/release mutation hybrid current matrix slice must retain exact SHA-256/),
        expect.stringMatching(
          /release mutation hybrid shared primary matcher 2392196b.*exact closed iterable\/runtime topology for 3 frozen root/
        )
      ])
    );

    const stagedPrefixCallBlock = [
      "    releaseMutationPlan.executeThrough(releaseMutationM037, {",
      "      registryEvaluatorProblems: mcpRegistryEvaluatorProblems,",
      "      registryStepProblems: mcpRegistryRunProblems,",
      "      npmContractProblems: npmProvenanceContractProblems,",
      "      npmWorkflowProblems: npmProvenanceWorkflowProblems",
      "    });"
    ].join("\n");
    const stagedRemainingCall = "    releaseMutationPlan.executeRemaining();";
    const stagedRemainingBlock = [
      stagedRemainingCall,
      '    expect(releaseMutationPlan.phase).toBe("executed");',
      "    expect(releaseMutationPlan.caseExecutions).toBe(59);",
      "    expect(releaseMutationPlan.expectationExecutions).toBe(59);"
    ].join("\n");
    const stagedLifecycleProblem =
      /release mutation hybrid lifecycle must be one clean seal followed by the exact m037 executeThrough\/executeRemaining pair with derived phase and execution censuses/;

    // NEGATIVE control: the prefix has its own phase and derived case/expectation
    // census; final-state claims cannot be borrowed before the suffix executes.
    const wrongStagedPrefixPhase = replaceExactly(
      matrixSource,
      '    expect(releaseMutationPlan.phase).toBe("partially-executed");',
      '    expect(releaseMutationPlan.phase).toBe("executed");'
    );
    expect(preparedAudit.auditMatrix(wrongStagedPrefixPhase)).toEqual(
      expect.arrayContaining([expect.stringMatching(stagedLifecycleProblem)])
    );
    const wrongStagedPrefixCaseCount = replaceExactly(
      matrixSource,
      "    expect(releaseMutationPlan.caseExecutions).toBe(36);",
      "    expect(releaseMutationPlan.caseExecutions).toBe(35);"
    );
    const wrongStagedPrefixCensus = replaceExactly(
      wrongStagedPrefixCaseCount,
      "    expect(releaseMutationPlan.expectationExecutions).toBe(36);",
      "    expect(releaseMutationPlan.expectationExecutions).toBe(35);"
    );
    expect(preparedAudit.auditMatrix(wrongStagedPrefixCensus)).toEqual(
      expect.arrayContaining([expect.stringMatching(stagedLifecycleProblem)])
    );
    const wrongStagedFinalCaseCount = replaceExactly(
      matrixSource,
      "    expect(releaseMutationPlan.caseExecutions).toBe(59);",
      "    expect(releaseMutationPlan.caseExecutions).toBe(58);"
    );
    const wrongStagedFinalCensus = replaceExactly(
      wrongStagedFinalCaseCount,
      "    expect(releaseMutationPlan.expectationExecutions).toBe(59);",
      "    expect(releaseMutationPlan.expectationExecutions).toBe(58);"
    );
    expect(preparedAudit.auditMatrix(wrongStagedFinalCensus)).toEqual(
      expect.arrayContaining([expect.stringMatching(stagedLifecycleProblem)])
    );

    const missingStagedRemaining = replaceExactly(matrixSource, stagedRemainingCall, "");
    expect(preparedAudit.auditMatrix(missingStagedRemaining)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(stagedLifecycleProblem),
        expect.stringMatching(/declarative execution schedule must terminate complete .*found prefix/)
      ])
    );

    // NEGATIVE control: a second suffix call is a replay of a completed plan,
    // regardless of whether it is adjacent to the first call or labelled a retry.
    const replayedStagedRemaining = replaceExactly(
      matrixSource,
      stagedRemainingCall,
      [stagedRemainingCall, stagedRemainingCall].join("\n")
    );
    expect(preparedAudit.auditMatrix(replayedStagedRemaining)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(stagedLifecycleProblem),
        expect.stringMatching(/declarative executeRemaining .*cannot replay a completed plan/)
      ])
    );

    // NEGATIVE control: executeRemaining consumes only the adapters frozen by
    // executeThrough; accepting another adapter would reopen suffix injection.
    const reinjectedRemainingAdapter = replaceExactly(
      matrixSource,
      stagedRemainingCall,
      "    releaseMutationPlan.executeRemaining({ registryStepProblems: mcpRegistryRunProblems });"
    );
    expect(preparedAudit.auditMatrix(reinjectedRemainingAdapter)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /release mutation hybrid executeRemaining event must use the exact staged execution argument shape/
        ),
        expect.stringMatching(stagedLifecycleProblem)
      ])
    );

    // NEGATIVE control: the prefix must preflight the complete adapter set needed
    // by its suffix; neither the Registry-step, npm-contract, nor npm-workflow adapter can be omitted.
    const missingStagedAdapter = replaceExactly(
      matrixSource,
      stagedPrefixCallBlock,
      [
        "    releaseMutationPlan.executeThrough(releaseMutationM037, {",
        "      registryEvaluatorProblems: mcpRegistryEvaluatorProblems",
        "    });"
      ].join("\n")
    );
    expect(preparedAudit.auditMatrix(missingStagedAdapter)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /release mutation hybrid execute adapter must bind registryStepProblems exactly to mcpRegistryRunProblems/
        ),
        expect.stringMatching(
          /release mutation hybrid execute adapter must bind npmContractProblems exactly to npmProvenanceContractProblems/
        ),
        expect.stringMatching(
          /release mutation hybrid execute adapter must bind npmWorkflowProblems exactly to npmProvenanceWorkflowProblems/
        ),
        expect.stringMatching(stagedLifecycleProblem)
      ])
    );

    // NEGATIVE controls: lifecycle calls cannot hide under control flow or behind
    // computed property syntax while retaining a superficially valid method name.
    const nestedStagedRemaining = replaceExactly(
      matrixSource,
      stagedRemainingCall,
      ["    if (true) {", "      releaseMutationPlan.executeRemaining();", "    }"].join("\n")
    );
    expect(preparedAudit.auditMatrix(nestedStagedRemaining)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/release mutation hybrid execution events must be exact direct top-level property calls/)
      ])
    );
    const computedStagedRemaining = replaceExactly(
      matrixSource,
      stagedRemainingCall,
      '    releaseMutationPlan["executeRemaining"]();'
    );
    expect(preparedAudit.auditMatrix(computedStagedRemaining)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/release mutation hybrid execution events must be exact direct top-level property calls/)
      ])
    );

    // NEGATIVE controls: executeThrough accepts only the exact m037 boundary.
    const unknownStagedBoundary = replaceExactly(
      matrixSource,
      stagedPrefixCallBlock,
      [
        "    releaseMutationPlan.executeThrough(releaseMutationUnknown, {",
        "      registryEvaluatorProblems: mcpRegistryEvaluatorProblems,",
        "      registryStepProblems: mcpRegistryRunProblems,",
        "      npmContractProblems: npmProvenanceContractProblems,",
        "      npmWorkflowProblems: npmProvenanceWorkflowProblems",
        "    });"
      ].join("\n")
    );
    expect(preparedAudit.auditMatrix(unknownStagedBoundary)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/declarative executeThrough .*must name one exact root handle/),
        expect.stringMatching(stagedLifecycleProblem)
      ])
    );
    const wrongKnownStagedBoundary = replaceExactly(
      matrixSource,
      stagedPrefixCallBlock,
      [
        "    releaseMutationPlan.executeThrough(releaseMutationM036, {",
        "      registryEvaluatorProblems: mcpRegistryEvaluatorProblems,",
        "      registryStepProblems: mcpRegistryRunProblems,",
        "      npmContractProblems: npmProvenanceContractProblems,",
        "      npmWorkflowProblems: npmProvenanceWorkflowProblems",
        "    });"
      ].join("\n")
    );
    expect(preparedAudit.auditMatrix(wrongKnownStagedBoundary)).toEqual(
      expect.arrayContaining([expect.stringMatching(stagedLifecycleProblem)])
    );

    // NEGATIVE controls: the suffix executes exactly between the shared m038-m106
    // Registry loop and legacy m131, preserving the frozen global case order.
    const stagedWithoutRemaining = replaceExactly(matrixSource, stagedRemainingBlock, "");
    const earlyStagedRemaining = replaceExactly(
      stagedWithoutRemaining,
      sharedRegistryMatcherLoop,
      [stagedRemainingBlock, sharedRegistryMatcherLoop].join("\n")
    );
    expect(preparedAudit.auditMatrix(earlyStagedRemaining)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/release mutation hybrid current source must retain exact SHA-256/),
        expect.stringMatching(/release mutation hybrid current matrix slice must retain exact SHA-256/),
        expect.stringMatching(
          /release mutation hybrid global case execution order must equal exact frozen primary-oracle order/
        )
      ])
    );
    const npmWorkflowPrimaryMatcherTail = [
      "      expect(npmProvenanceWorkflowProblems(weakenedProvenanceWorkflow)).toContain(NPM_PROVENANCE_CONTRACT_PROBLEM);",
      "    }"
    ].join("\n");
    const lateStagedRemaining = replaceExactly(
      stagedWithoutRemaining,
      npmWorkflowPrimaryMatcherTail,
      `${npmWorkflowPrimaryMatcherTail}\n${stagedRemainingBlock}`
    );
    expect(preparedAudit.auditMatrix(lateStagedRemaining)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/release mutation hybrid current source must retain exact SHA-256/),
        expect.stringMatching(/release mutation hybrid current matrix slice must retain exact SHA-256/),
        expect.stringMatching(
          /release mutation hybrid global case execution order must equal exact frozen primary-oracle order/
        )
      ])
    );

    // NEGATIVE control: m111 shares m035's raw mutation tuple and materialized mutant,
    // but its frozen Registry-step integrity oracle must never collapse to m035's evaluator.
    const m111EvaluatorInvocation = replaceExactly(
      matrixSource,
      [
        '            kind: "registry.step.integrity",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM111,",
        "            run: registryPublishStepSource"
      ].join("\n"),
      [
        '            kind: "registry.evaluator",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM111"
      ].join("\n")
    );
    const conflatedM111WithM035Oracle = replaceExactly(
      m111EvaluatorInvocation,
      [
        '            id: "release.expectation.m111.primary",',
        '            kind: "problem",',
        "            problem:",
        '              "stable MCP Registry publication must bind exact source manifests, one pinned publisher write, and bounded readback"'
      ].join("\n"),
      [
        '            id: "release.expectation.m111.primary",',
        '            kind: "problem",',
        "            problem:",
        '              "MCP Registry reconciliation must retain exact identity, lifecycle, absence, and convergence semantics"'
      ].join("\n")
    );
    const transplantedM112Invocation = replaceExactly(
      conflatedM111WithM035Oracle,
      [
        '            kind: "npm.contract.release",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM112,",
        "            integrity: releaseIntegritySource"
      ].join("\n"),
      [
        '            kind: "npm.contract.integrity",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM112,",
        "            release: releaseWorkflowFixtureSource"
      ].join("\n")
    );
    const conflatedReleaseOracles = replaceExactly(
      transplantedM112Invocation,
      [
        '            kind: "npm.contract.integrity",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM113,",
        "            release: releaseWorkflowFixtureSource"
      ].join("\n"),
      [
        '            kind: "npm.contract.release",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM113,",
        "            integrity: releaseIntegritySource"
      ].join("\n")
    );
    const conflatedM114NpmOracle = replaceExactly(
      conflatedReleaseOracles,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM114"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM114"
      ].join("\n")
    );
    const conflatedM115NpmOracle = replaceExactly(
      conflatedM114NpmOracle,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM115"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM115"
      ].join("\n")
    );
    const conflatedM116NpmOracle = replaceExactly(
      conflatedM115NpmOracle,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM116"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM116"
      ].join("\n")
    );
    const conflatedM117NpmOracle = replaceExactly(
      conflatedM116NpmOracle,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM117"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM117"
      ].join("\n")
    );
    const conflatedM118NpmOracle = replaceExactly(
      conflatedM117NpmOracle,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM118"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM118"
      ].join("\n")
    );
    const conflatedM119NpmOracle = replaceExactly(
      conflatedM118NpmOracle,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM119"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM119"
      ].join("\n")
    );
    const conflatedM120NpmOracle = replaceExactly(
      conflatedM119NpmOracle,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM120"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM120"
      ].join("\n")
    );
    const conflatedM121NpmOracle = replaceExactly(
      conflatedM120NpmOracle,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM121"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM121"
      ].join("\n")
    );
    const conflatedM122NpmOracle = replaceExactly(
      conflatedM121NpmOracle,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM122"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM122"
      ].join("\n")
    );
    const conflatedM123NpmOracle = replaceExactly(
      conflatedM122NpmOracle,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM123"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM123"
      ].join("\n")
    );
    const conflatedM124NpmOracle = replaceExactly(
      conflatedM123NpmOracle,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM124"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM124"
      ].join("\n")
    );
    const conflatedM125NpmOracle = replaceExactly(
      conflatedM124NpmOracle,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM125"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM125"
      ].join("\n")
    );
    const conflatedM126NpmOracle = replaceExactly(
      conflatedM125NpmOracle,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM126"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM126"
      ].join("\n")
    );
    const conflatedM127NpmOracle = replaceExactly(
      conflatedM126NpmOracle,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM127"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM127"
      ].join("\n")
    );
    const conflatedM128NpmOracle = replaceExactly(
      conflatedM127NpmOracle,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM128"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM128"
      ].join("\n")
    );
    const conflatedM129NpmOracle = replaceExactly(
      conflatedM128NpmOracle,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM129"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM129"
      ].join("\n")
    );
    const conflatedNpmOracles = replaceExactly(
      conflatedM129NpmOracle,
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseWorkflowFixtureSource,",
        "            mutant: releaseMutationM130"
      ].join("\n"),
      [
        '            kind: "npm.workflow",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM130"
      ].join("\n")
    );
    expect(preparedAudit.auditMatrix(conflatedNpmOracles)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m111 invocation must retain its exact frozen oracle adapter/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m111 disagrees with its exact frozen identity/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m112 invocation must retain its exact frozen oracle adapter/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m112 disagrees with its exact frozen identity/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m113 invocation must retain its exact frozen oracle adapter/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m113 disagrees with its exact frozen identity/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m114 invocation must retain its exact frozen oracle adapter/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m114 disagrees with its exact frozen identity/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m115 invocation must retain its exact frozen oracle adapter/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m115 disagrees with its exact frozen identity/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m116 invocation must retain its exact frozen oracle adapter/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m116 disagrees with its exact frozen identity/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m117 invocation must retain its exact frozen oracle adapter/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m117 disagrees with its exact frozen identity/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m118 invocation must retain its exact frozen oracle adapter/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m118 disagrees with its exact frozen identity/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m119 invocation must retain its exact frozen oracle adapter/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m119 disagrees with its exact frozen identity/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m120 invocation must retain its exact frozen oracle adapter/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m120 disagrees with its exact frozen identity/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m121 invocation must retain its exact frozen oracle adapter/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m121 disagrees with its exact frozen identity/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m122 invocation must retain its exact frozen oracle adapter/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m122 disagrees with its exact frozen identity/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m123 invocation must retain its exact frozen oracle adapter/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m123 disagrees with its exact frozen identity/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m124 invocation must retain its exact frozen oracle adapter/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m124 disagrees with its exact frozen identity/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m125 invocation must retain its exact frozen oracle adapter/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m125 disagrees with its exact frozen identity/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m126 invocation must retain its exact frozen oracle adapter/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m126 disagrees with its exact frozen identity/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m127 invocation must retain its exact frozen oracle adapter/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m127 disagrees with its exact frozen identity/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m128 invocation must retain its exact frozen oracle adapter/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m128 disagrees with its exact frozen identity/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m129 invocation must retain its exact frozen oracle adapter/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m129 disagrees with its exact frozen identity/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m130 invocation must retain its exact frozen oracle adapter/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m130 disagrees with its exact frozen identity/
        )
      ])
    );

    const declarativeDescriptorDrift = replaceExactly(
      matrixSource,
      [
        '    const releaseMutationM002 = releaseMutationPlan.registerMutation("release.m002", {',
        '      mode: "first",',
        "      source: releaseIntegritySource"
      ].join("\n"),
      [
        '    const releaseMutationM002 = releaseMutationPlan.registerMutation("release.m002", {',
        '      mode: "all",',
        "      source: releaseIntegritySource"
      ].join("\n")
    );
    expect(preparedAudit.auditMatrix(declarativeDescriptorDrift)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/release mutation hybrid descriptor release\.m002 mode disagrees with frozen identity/)
      ])
    );

    const semanticSwapFirst = replaceExactly(
      matrixSource,
      [
        '    const releaseMutationM002 = releaseMutationPlan.registerMutation("release.m002", {',
        '      mode: "first",',
        "      source: releaseIntegritySource"
      ].join("\n"),
      [
        '    const releaseMutationM002 = releaseMutationPlan.registerMutation("release.swap", {',
        '      mode: "first",',
        "      source: releaseIntegritySource"
      ].join("\n")
    );
    const semanticSwapSecond = replaceExactly(
      semanticSwapFirst,
      [
        '    const releaseMutationM003 = releaseMutationPlan.registerMutation("release.m003", {',
        '      mode: "first",',
        "      source: releaseIntegritySource"
      ].join("\n"),
      [
        '    const releaseMutationM003 = releaseMutationPlan.registerMutation("release.m002", {',
        '      mode: "first",',
        "      source: releaseIntegritySource"
      ].join("\n")
    );
    const declarativeSemanticSwap = replaceExactly(
      semanticSwapSecond,
      [
        '    const releaseMutationM002 = releaseMutationPlan.registerMutation("release.swap", {',
        '      mode: "first",',
        "      source: releaseIntegritySource"
      ].join("\n"),
      [
        '    const releaseMutationM002 = releaseMutationPlan.registerMutation("release.m003", {',
        '      mode: "first",',
        "      source: releaseIntegritySource"
      ].join("\n")
    );
    expect(preparedAudit.auditMatrix(declarativeSemanticSwap)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /release mutation hybrid descriptor release\.m002 disagrees with its exact frozen semantics/
        ),
        expect.stringMatching(
          /release mutation hybrid descriptor release\.m003 disagrees with its exact frozen semantics/
        )
      ])
    );

    const declarativeRootTransplant = replaceExactly(
      matrixSource,
      [
        "    releaseMutationPlan.registerCase({",
        '      id: "release.case.m002",',
        "      root: releaseMutationM002,"
      ].join("\n"),
      [
        "    releaseMutationPlan.registerCase({",
        '      id: "release.case.m002",',
        "      root: releaseMutationM004,"
      ].join("\n")
    );
    expect(preparedAudit.auditMatrix(declarativeRootTransplant)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m002 invocation must retain its exact frozen oracle adapter/
        ),
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m002 disagrees with its exact frozen identity/
        )
      ])
    );

    const declarativeInvocationDrift = replaceExactly(
      matrixSource,
      [
        "          invoke: {",
        '            kind: "registry.evaluator",',
        "            baseline: releaseIntegritySource,",
        "            mutant: releaseMutationM002"
      ].join("\n"),
      [
        "          invoke: {",
        '            kind: "registry.evaluator",',
        "            baseline: releaseMutationM002,",
        "            mutant: releaseMutationM002"
      ].join("\n")
    );
    expect(preparedAudit.auditMatrix(declarativeInvocationDrift)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /release mutation hybrid case release\.case\.m002 invocation must retain its exact frozen oracle adapter/
        )
      ])
    );

    const declarativeAliasDrift = replaceExactly(
      matrixSource,
      [
        "    const releaseIntegrityText = mcpbInputs.integrity;",
        "    const releaseMutationPlan = new ReleaseMutationPlan({"
      ].join("\n"),
      [
        "    const releaseIntegrityText = mcpbInputs.release;",
        "    const releaseMutationPlan = new ReleaseMutationPlan({"
      ].join("\n")
    );
    const declarativeSourceDrift = replaceExactly(
      declarativeAliasDrift,
      [
        '    const releaseIntegritySource = releaseMutationPlan.registerSource("script.release-integrity", releaseIntegrityText);',
        '    const releaseMutationM002 = releaseMutationPlan.registerMutation("release.m002", {'
      ].join("\n"),
      [
        '    const releaseIntegritySource = releaseMutationPlan.registerSource("script.release-integrity", mcpbInputs.release);',
        '    const releaseMutationM002 = releaseMutationPlan.registerMutation("release.m002", {'
      ].join("\n")
    );
    const declarativeExecuteAdapterDrift = replaceExactly(
      declarativeSourceDrift,
      [
        "    releaseMutationPlan.executeThrough(releaseMutationM037, {",
        "      registryEvaluatorProblems: mcpRegistryEvaluatorProblems,",
        "      registryStepProblems: mcpRegistryRunProblems,",
        "      npmContractProblems: npmProvenanceContractProblems,",
        "      npmWorkflowProblems: npmProvenanceWorkflowProblems",
        "    });"
      ].join("\n"),
      [
        "    releaseMutationPlan.executeThrough(releaseMutationM037, {",
        "      registryEvaluatorProblems: mcpRegistryContractProblems,",
        "      registryStepProblems: mcpRegistryRunProblems,",
        "      npmContractProblems: mcpRegistryRunProblems,",
        "      npmWorkflowProblems: mcpRegistryRunProblems",
        "    });"
      ].join("\n")
    );
    const npmDetectorBodyDrift = replaceExactly(
      declarativeExecuteAdapterDrift,
      "function npmProvenanceContractProblems(release: string, integrity: string): string[] {",
      "function npmProvenanceContractProblems(release: string, integrity: string): string[] { /* drift */"
    );
    const npmWorkflowDetectorBodyDrift = replaceExactly(
      npmDetectorBodyDrift,
      "function npmProvenanceWorkflowProblems(release: string): string[] {",
      "function npmProvenanceWorkflowProblems(release: string): string[] { /* drift */"
    );
    const npmProblemPreludeDrift = replaceExactly(
      npmWorkflowDetectorBodyDrift,
      [
        "const NPM_PROVENANCE_CONTRACT_PROBLEM =",
        '  "npm provenance must bind the tag-push context before the sole publish " +',
        '  "and verify two exact attestations without credentials";'
      ].join("\n"),
      [
        "const NPM_PROVENANCE_CONTRACT_PROBLEM =",
        '  "npm provenance may bind an approximate tag context before publication " +',
        '  "and verify one attestation with credentials";'
      ].join("\n")
    );
    const registryDetectorBodyDrift = replaceExactly(
      npmProblemPreludeDrift,
      "function mcpRegistryEvaluatorProblems(integrity: string): string[] {",
      "function mcpRegistryEvaluatorProblems(source: string): string[] {"
    );
    const registryProblemPreludeDrift = replaceExactly(
      registryDetectorBodyDrift,
      [
        "const MCP_REGISTRY_EVALUATOR_CONTRACT_PROBLEM =",
        '  "MCP Registry reconciliation must retain exact identity, lifecycle, absence, and convergence semantics";'
      ].join("\n"),
      [
        "const MCP_REGISTRY_EVALUATOR_CONTRACT_PROBLEM =",
        '  "MCP Registry reconciliation must retain approximate identity, lifecycle, absence, and convergence semantics";'
      ].join("\n")
    );
    const registryRunBodyDrift = replaceExactly(
      registryProblemPreludeDrift,
      "function mcpRegistryRunProblems(run: string, integrity: string): string[] {",
      "function mcpRegistryRunProblems(run: string, integrity: string): string[] { /* drift */"
    );
    const registryStepBodyDrift = replaceExactly(
      registryRunBodyDrift,
      "function mcpRegistryStepProblems(step: YamlRecord | undefined, integrity: string): string[] {",
      "function mcpRegistryStepProblems(step: YamlRecord | undefined, integrity: string): string[] { /* drift */"
    );
    const registryWorkflowProblemDrift = replaceExactly(
      registryStepBodyDrift,
      [
        "const MCP_REGISTRY_WORKFLOW_CONTRACT_PROBLEM =",
        '  "stable MCP Registry publication must bind exact source manifests, one pinned publisher write, and bounded readback";'
      ].join("\n"),
      [
        "const MCP_REGISTRY_WORKFLOW_CONTRACT_PROBLEM =",
        '  "stable MCP Registry publication may bind approximate source manifests, one publisher write, and readback";'
      ].join("\n")
    );
    const registryDetectorAliasDrift =
      `${registryWorkflowProblemDrift}\nconst registryEvaluatorAlias = mcpRegistryEvaluatorProblems;\n` +
      "const npmContractAlias = npmProvenanceContractProblems;\n" +
      "const npmWorkflowAlias = npmProvenanceWorkflowProblems;\n" +
      "const registryStepAlias = mcpRegistryStepProblems;\n" +
      "const registryRunAlias = mcpRegistryRunProblems;\n";
    expect(preparedAudit.auditMatrix(registryDetectorAliasDrift)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /release mutation hybrid alias must be exact const releaseIntegrityText = mcpbInputs\.integrity/
        ),
        expect.stringMatching(
          /release mutation hybrid sources must bind releaseIntegritySource\/script\.release-integrity/
        ),
        expect.stringMatching(
          /release mutation hybrid execute adapter must bind registryEvaluatorProblems exactly to mcpRegistryEvaluatorProblems/
        ),
        expect.stringMatching(
          /release mutation hybrid execute adapter must bind npmContractProblems exactly to npmProvenanceContractProblems/
        ),
        expect.stringMatching(
          /release mutation hybrid execute adapter must bind npmWorkflowProblems exactly to npmProvenanceWorkflowProblems/
        ),
        expect.stringMatching(
          /release mutation hybrid pinned npmProvenanceContractProblems AST node must retain exact SHA-256/
        ),
        expect.stringMatching(
          /release mutation hybrid pinned npmProvenanceWorkflowProblems AST node must retain exact SHA-256/
        ),
        expect.stringMatching(
          /release mutation hybrid pinned npm provenance problem AST node must retain exact SHA-256/
        ),
        expect.stringMatching(
          /release mutation hybrid npm contract binding must have no aliases, writes, or indirect references/
        ),
        expect.stringMatching(
          /release mutation hybrid npm workflow binding must have no aliases, writes, or indirect references/
        ),
        expect.stringMatching(
          /release mutation hybrid pinned mcpRegistryEvaluatorProblems AST node must retain exact SHA-256/
        ),
        expect.stringMatching(/release mutation hybrid pinned registry problem AST node must retain exact SHA-256/),
        expect.stringMatching(
          /release mutation hybrid registry evaluator binding must have no aliases, writes, or indirect references/
        ),
        expect.stringMatching(
          /release mutation hybrid pinned mcpRegistryRunProblems AST node must retain exact SHA-256/
        ),
        expect.stringMatching(
          /release mutation hybrid registry run binding must have no aliases, writes, or indirect references/
        ),
        expect.stringMatching(
          /release mutation hybrid pinned mcpRegistryStepProblems AST node must retain exact SHA-256/
        ),
        expect.stringMatching(
          /release mutation hybrid pinned registry workflow problem AST node must retain exact SHA-256/
        ),
        expect.stringMatching(
          /release mutation hybrid registry step binding must have no aliases, writes, or indirect references/
        )
      ])
    );

    const registryStepShadow =
      `${matrixSource}\nfunction registryStepShadowControl(): void {\n` +
      "  const mcpRegistryStepProblems = (_step: YamlRecord | undefined, _integrity: string): string[] => [];\n" +
      "  void mcpRegistryStepProblems;\n}\n";
    expect(preparedAudit.auditMatrix(registryStepShadow)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /release mutation hybrid registry step binding must have one top-level declaration and no runtime shadows; found 1\/1/
        )
      ])
    );
    const registryStepWrite =
      `${matrixSource}\nmcpRegistryStepProblems = ` +
      "(_step: YamlRecord | undefined, _integrity: string): string[] => [];\n";
    expect(preparedAudit.auditMatrix(registryStepWrite)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /release mutation hybrid registry step binding must have no aliases, writes, or indirect references; found 0\/1\//
        )
      ])
    );
    const registryStepIndirectReference = `${matrixSource}\nvoid [mcpRegistryStepProblems];\n`;
    expect(preparedAudit.auditMatrix(registryStepIndirectReference)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /release mutation hybrid registry step binding must have no aliases, writes, or indirect references; found 0\/0\/1/
        )
      ])
    );

    const mutationMatchCountBodyDrift = replaceExactly(
      matrixSource,
      "    count++;\n    offset = match + needle.length;",
      "    count += 2;\n    offset = match + needle.length;"
    );
    expect(preparedAudit.auditMatrix(mutationMatchCountBodyDrift)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/release mutation hybrid current source must retain exact SHA-256/),
        expect.stringMatching(/release mutation hybrid pinned mutationMatchCount AST node must retain exact SHA-256/)
      ])
    );

    const mutationMatchCountShadow = `${matrixSource}\nfunction mutationMatchCountShadow(): void {\n  const mutationMatchCount = () => 0;\n  void mutationMatchCount;\n}\n`;
    expect(preparedAudit.auditMatrix(mutationMatchCountShadow)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /release mutation hybrid mutationMatchCount binding must have one top-level declaration and no runtime shadows; found 1\/1/
        )
      ])
    );

    const mutationMatchCountAlias = `${matrixSource}\nconst mutationCounterAlias = mutationMatchCount;\nvoid mutationCounterAlias;\n`;
    expect(preparedAudit.auditMatrix(mutationMatchCountAlias)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /release mutation hybrid mutationMatchCount must have no aliases; found 1 alias initializer/
        )
      ])
    );

    const mutationMatchCountWrite = `${matrixSource}\nmutationMatchCount = (_source: string, _needle: string) => 0;\n`;
    expect(preparedAudit.auditMatrix(mutationMatchCountWrite)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /release mutation hybrid mutationMatchCount binding must never be reassigned; found 1 write/
        )
      ])
    );

    const mutationMatchCountIndirect = `${matrixSource}\nvoid [mutationMatchCount];\n`;
    expect(preparedAudit.auditMatrix(mutationMatchCountIndirect)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /release mutation hybrid mutationMatchCount may only be called directly with two arguments; found 1 other reference/
        )
      ])
    );

    const loopBodyMutation = replaceExactly(
      matrixSource,
      "    ]) {\n      expect(npmProvenanceEvaluatorProblems(weakenedProvenanceEvaluator)).toContain(",
      '    ]) {\n      void replaceExactly(mcpbInputs.integrity, "loop-body", "mutant");\n' +
        '      ["mapped"].map(() => replaceExactly(mcpbInputs.integrity, "mapped", "mutant"));\n' +
        "      expect(npmProvenanceEvaluatorProblems(weakenedProvenanceEvaluator)).toContain("
    );
    expect(preparedAudit.auditMatrix(loopBodyMutation)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/matrix AST execution-multiplying mutation helper sites must be zero; found 2/)
      ])
    );

    const unsupportedExpressionMutation = replaceExactly(
      matrixSource,
      "replaceExactly(registryRun, 'mcp-registry-state \"$phase\"', 'mcp-registry-read \"$phase\"')",
      'replaceExactly(true ? registryRun : "", true ? \'mcp-registry-state "$phase"\' : "x", [\'mcp-registry-read "$phase"\'][0])'
    );
    expect(preparedAudit.auditMatrix(unsupportedExpressionMutation)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/legacy source expression .* is outside outer-expression-v1/),
        expect.stringMatching(/legacy needle expression .* is outside outer-expression-v1/),
        expect.stringMatching(/legacy replacement expression .* is outside outer-expression-v1/)
      ])
    );

    const duplicateTopLevelKey = replaceExactly(
      fixtureBefore,
      '"schemaVersion": 2,',
      '"schemaVersion": 2,\n  "schemaVersion": 2,'
    );
    const duplicateKeyProblems = releaseMutationIdentityAuditProblems(matrixSource, duplicateTopLevelKey);
    expect(duplicateKeyProblems).toEqual([
      expect.stringMatching(/duplicate JSON key schemaVersion/),
      expect.stringMatching(/release mutation identity fixture must remain byte-exact SHA-256/)
    ]);

    const referencedDeclarationDrift = replaceExactly(
      matrixSource,
      `const MCPB_EXACT_NPM_PACK = '"$TIMEOUT_BIN" --kill-after=10s 600s "$NPM_BIN" pack --json --ignore-scripts';`,
      `const MCPB_EXACT_NPM_PACK = '"$TIMEOUT_BIN" --kill-after=10s 600s "$NPM_BIN" pack --json --ignore-scriptz';`
    );
    const beforeSourceCatalogueDrift = preparedAudit.telemetry();
    expect(preparedAudit.auditMatrix(referencedDeclarationDrift)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/manifest source row 6 disagrees with the exact reviewed catalogue identity/)
      ])
    );
    const afterSourceCatalogueDrift = preparedAudit.telemetry();
    expect(afterSourceCatalogueDrift.sourceCatalogueBypasses).toBe(
      beforeSourceCatalogueDrift.sourceCatalogueBypasses + 1
    );
    expect(afterSourceCatalogueDrift.materializedGraphReuses).toBe(beforeSourceCatalogueDrift.materializedGraphReuses);

    // The frozen Registry-step and npm-contract primary invocations are directional
    // ordered pairs, not unordered bags: each mutated slot and clean companion stay exact.
    const releaseOracleCompanionControl = JSON.parse(fixtureBefore) as MutableIdentityControlManifest;
    const registryStepRunCheck = identityControlCheck(releaseOracleCompanionControl, "registry.step.run");
    const registryStepIntegrityCheck = identityControlCheck(releaseOracleCompanionControl, "registry.step.integrity");
    const npmContractReleaseCheck = identityControlCheck(releaseOracleCompanionControl, "npm.contract.release");
    const npmContractIntegrityCheck = identityControlCheck(releaseOracleCompanionControl, "npm.contract.integrity");
    expect(registryStepRunCheck.invoke.inputs.arguments).toEqual([
      { kind: "mutant", slot: "run" },
      { id: "script.release-integrity", kind: "source", slot: "integrity" }
    ]);
    expect(registryStepIntegrityCheck.invoke.inputs.arguments).toEqual([
      { id: "workflow.registry-publish-step", kind: "source", slot: "run" },
      { kind: "mutant", slot: "integrity" }
    ]);
    expect(npmContractReleaseCheck.invoke.inputs.arguments).toEqual([
      { kind: "mutant", slot: "release" },
      { id: "script.release-integrity", kind: "source", slot: "integrity" }
    ]);
    expect(npmContractIntegrityCheck.invoke.inputs.arguments).toEqual([
      { id: "fixture.release-workflow", kind: "source", slot: "release" },
      { kind: "mutant", slot: "integrity" }
    ]);

    // NEGATIVE control: swapping every companion order must fail all four closed
    // invocation signatures even though every individual source identity remains.
    registryStepRunCheck.invoke.inputs.arguments.reverse();
    registryStepIntegrityCheck.invoke.inputs.arguments.reverse();
    npmContractReleaseCheck.invoke.inputs.arguments.reverse();
    npmContractIntegrityCheck.invoke.inputs.arguments.reverse();
    expect(releaseMutationIdentityAuditProblems(matrixSource, JSON.stringify(releaseOracleCompanionControl))).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/release mutation identity fixture must remain byte-exact SHA-256/),
        expect.stringMatching(/inputs\.arguments disagree with the exact registry\.step\.run detector signature/),
        expect.stringMatching(/inputs\.arguments disagree with the exact registry\.step\.integrity detector signature/),
        expect.stringMatching(/inputs\.arguments disagree with the exact npm\.contract\.release detector signature/),
        expect.stringMatching(/inputs\.arguments disagree with the exact npm\.contract\.integrity detector signature/)
      ])
    );

    const tampered = JSON.parse(fixtureBefore) as MutableIdentityControlManifest;
    const firstSource = firstIdentityEntry(tampered.sources, "source identities");
    const unrelatedSource = tampered.sources[1];
    if (unrelatedSource === undefined) throw new Error("release identity fixture has no unrelated source identity");
    const firstMutation = firstIdentityEntry(tampered.mutations, "mutation identities");
    const dependencySplitMutation = tampered.mutations.find((mutation) => mutation.id === "release.m038");
    if (dependencySplitMutation === undefined) throw new Error("release identity fixture has no release.m038");
    const firstCase = firstIdentityEntry(tampered.cases, "case identities");
    const firstCheck = firstIdentityEntry(firstCase.checks, "case checks");
    firstSource.contentSha256 = "0".repeat(64);
    refreshSourceSemanticFingerprint(firstSource);
    firstMutation.expressions.needle.raw += " /* manifest raw-expression drift */";
    firstMutation.expressions.needle.resolved += "\n# resolved-needle drift";
    firstMutation.expressions.source.resolved = unrelatedSource.id;
    dependencySplitMutation.replacementDependency = "release.m037";
    firstCheck.invoke.kind = "release.poll";
    firstCheck.invoke.inputs.callee = "unreviewedDetector";
    firstCheck.expectation.regex = "workflow.schema.unreviewed-regex";
    const tamperProblems = releaseMutationIdentityAuditProblems(matrixSource, JSON.stringify(tampered));
    expect(tamperProblems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/release mutation identity fixture must remain byte-exact SHA-256/),
        expect.stringMatching(/release mutation hybrid dependency edge release\.m037->release\.m038 crosses/),
        expect.stringMatching(/contentSha256 must identify exact materialized bytes/),
        expect.stringMatching(/needle raw expression disagrees with exact AST identity/),
        expect.stringMatching(/resolved source must equal/),
        expect.stringMatching(/resolved needle disagrees with independent AST evaluation/),
        expect.stringMatching(/baseline must equal release\.poll mutant source fixture\.release-workflow/),
        expect.stringMatching(/inputs\.callee must be releasePollProblems/),
        expect.stringMatching(/inputs\.arguments disagree with the exact release\.poll detector signature/),
        expect.stringMatching(/uses an unknown named-regex identity/)
      ])
    );

    // Prepared execution is order-independent and returns fresh diagnostics on every call.
    const secondRepeatedProblems = preparedAudit.auditMatrix(outsideSliceCommentDrift);
    expect(secondRepeatedProblems).toEqual(stableRepeatedProblems);
    firstRepeatedProblems.push("caller-owned sentinel");
    expect(secondRepeatedProblems).toEqual(stableRepeatedProblems);
    expect(secondRepeatedProblems).toEqual(
      releaseMutationIdentityAuditProblems(outsideSliceCommentDrift, fixtureBefore)
    );
    expect(preparedAudit.telemetry()).toEqual({
      fixturePreparations: 1,
      materializedGraphEvaluations: 1,
      materializedGraphReuses: 62,
      sourceCatalogueBypasses: 2,
      sourceProjectionBypasses: 0
    });
  }, 480_000);

  it("every *-invariant.test.ts file has NEGATIVE control OR explicit exempt marker", async () => {
    const completeSet = new Set<string>(EXPECTED_STRUCTURAL_FILES);
    const missingReleaseIntegrity = new Set(completeSet);
    missingReleaseIntegrity.delete("release-integrity.test.ts");
    expect(() => assertStructuralFileMembership(completeSet)).not.toThrow();
    expect(() => assertStructuralFileMembership(missingReleaseIntegrity)).toThrow(
      /structural invariant census mismatch \(missing: release-integrity\.test\.ts\)/
    );
    const oneForOneSwap = new Set(completeSet);
    oneForOneSwap.delete("abs-path-leak-invariant.test.ts");
    oneForOneSwap.add("replacement-invariant.test.ts");
    expect(() => assertStructuralFileMembership(oneForOneSwap)).toThrow(
      /missing: abs-path-leak-invariant\.test\.ts; unexpected: replacement-invariant\.test\.ts/
    );

    expect(() => replaceExactly("alpha", "missing", "omega")).toThrow(/expected 1 occurrence\(s\), found 0/);
    expect(() => replaceExactly("alpha alpha", "alpha", "omega")).toThrow(/expected 1 occurrence\(s\), found 2/);
    expect(() => replaceAllExactly("alpha", "missing", "omega")).toThrow(/expected 1 occurrence\(s\), found 0/);
    expect(() => replaceExactly("alpha", "", "omega")).toThrow(/must not be empty/);
    expect(() => replaceExactly("alpha", "alpha", "omega", 0)).toThrow(/positive safe integer/);
    expect(() => replaceExactly("alpha", "alpha", "omega", 1.5)).toThrow(/positive safe integer/);
    expect(() => replaceExactly("alpha", "alpha", "alpha")).toThrow(/did not change its source/);
    expect(() => replaceAllExactly("alpha", "alpha", "alpha")).toThrow(/did not change its source/);
    expect(replaceExactly("alpha alpha", "alpha", "omega", 2)).toBe("omega alpha");
    expect(replaceAllExactly("alpha alpha", "alpha", "omega", 2)).toBe("omega omega");
    expect(replaceExactly("left alpha right", "alpha", "$`|$&|$'|$$")).toBe("left left |alpha| right|$ right");
    expect(replaceExactly("alpha", "alpha", "$1|$01|$<name>|$0")).toBe("$1|$01|$<name>|$0");
    expect(() => replaceExactly("alpha", "alpha", "$&")).toThrow(/did not change its source/);
    expect(replaceAllExactly("a-a", "a", "$`|$&|$'", 2)).toBe("|a|-a-a-|a|");
    expect(replaceIntegerAllExactly("7 17 7", 7, "70", 2)).toBe("70 17 70");
    expect(() => replaceIntegerAllExactly("17", 7, "70", 1)).toThrow(/expected 1 bounded occurrence\(s\), found 0/);
    expect(() => replaceIntegerAllExactly("7 7", 7, "70", 1)).toThrow(/expected 1 bounded occurrence\(s\), found 2/);
    expect(() => replaceIntegerAllExactly("7", 7, "7", 1)).toThrow(/did not change its source/);
    expect(
      exactMutationHelperCallCount(
        "fixture.test.ts",
        'replaceExactly("a", "a", "b"); replaceAllExactly("a", "a", "b"); "replaceIntegerAllExactly()";'
      )
    ).toBe(2);
    const exactHelperImport =
      'import { replaceExactly } from "./helpers/exact-source-mutation.js";\n' +
      'replaceExactly("alpha", "alpha", "omega");';
    expect(exactMutationHelperBindingProblems("abs-path-leak-invariant.test.ts", exactHelperImport)).toEqual([]);
    const shadowedHelper =
      `${exactHelperImport}\n{ ` +
      'const replaceExactly = (source: string): string => source; replaceExactly("alpha"); }';
    expect(exactMutationHelperBindingProblems("abs-path-leak-invariant.test.ts", shadowedHelper)).toEqual([
      expect.stringMatching(/shadows exact mutation helper replaceExactly/)
    ]);
    expect(
      exactMutationHelperBindingProblems(
        "abs-path-leak-invariant.test.ts",
        'import { replaceExactly as mutate } from "./helpers/exact-source-mutation.js"; mutate("alpha");'
      )
    ).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/aliases exact mutation helper replaceExactly as mutate/),
        expect.stringMatching(/expected exact helper imports replaceExactly, found/)
      ])
    );

    const mutationInventoryFile = "abs-path-leak-invariant.test.ts";
    expect(
      repositoryMutationOracleProblems(
        mutationInventoryFile,
        "type Replacer = Parameters<typeof String.prototype.replace>[1];"
      )
    ).toEqual([]);
    expect(repositoryMutationOracleProblems(mutationInventoryFile, '// value.replace("old", "new")')).toEqual([]);
    for (const rawAccess of [
      'const weakened = source.replace("old", "new");',
      'const weakened = source["replaceAll"]("old", "new");',
      'const weakened = source["re" + "place"]("old", "new");',
      'const rawMutation = source[("replace")];',
      "const rawMutation = source.replace;",
      'const { ["replace"]: rawMutation } = source;',
      "const { replaceAll: rawMutation } = source;",
      '({ ["re" + "place"]: rawMutation } = source);',
      "({ replace } = source);",
      "for ({ replaceAll: rawMutation } of sources) {}",
      "for ({ replace: rawMutation } in sources) {}",
      "const rawMutation = String.prototype.replace;",
      'function replaceExactly(source: string): string { return source.replace("old", "new"); }'
    ]) {
      expect(repositoryMutationOracleProblems(mutationInventoryFile, rawAccess)).toEqual([
        expect.stringMatching(/unclassified raw \.(?:replace|replaceAll) (?:access|(?:assignment )?binding)/)
      ]);
    }
    const reviewedNormalization = 'const normalizedLifecycle = lifecycle.replace(/\\s+/g, " ");';
    expect(repositoryMutationOracleProblems("docs-consistency.test.ts", reviewedNormalization)).toEqual([]);
    expect(repositoryMutationOracleProblems("docs-consistency.test.ts", "")).toContain(
      "docs-consistency.test.ts expected 1 reviewed ordinary transform(s), found 0"
    );
    expect(
      repositoryMutationOracleProblems(
        "docs-consistency.test.ts",
        'const normalizedLifecycle = lifecycle.replace(/\\s*/g, " ");'
      )
    ).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/unclassified raw \.replace access/),
        "docs-consistency.test.ts expected 1 reviewed ordinary transform(s), found 0"
      ])
    );

    const files = await collectInvariantTestFiles();
    expect(
      files.length,
      "expected exactly 34 structural-invariant files (*-invariant.test.ts + curated EXTRA_STRUCTURAL_FILES)"
    ).toBe(EXPECTED_STRUCTURAL_FILE_COUNT);

    const violations: string[] = [];
    for (const file of files) {
      const rel = path.relative(repoRoot, file);
      const content = await fs.readFile(file, "utf8");
      const err = checkInvariantHasNegativeCoverage(rel, content);
      if (err) violations.push(err);
    }
    expect(violations, violations.join("\n\n")).toEqual([]);

    for (const filename of RAW_REPLACE_INVENTORY_FILES) {
      const source = await fs.readFile(path.join(repoRoot, "tests", filename), "utf8");
      const problems = repositoryMutationOracleProblems(filename, source);
      expect(problems, problems.join("\n")).toEqual([]);
      const expectedHelperCalls = EXPECTED_REPOSITORY_MUTATION_HELPER_CALLS.get(filename);
      if (expectedHelperCalls !== undefined) {
        const bindingProblems = exactMutationHelperBindingProblems(filename, source);
        expect(bindingProblems, bindingProblems.join("\n")).toEqual([]);
        expect(exactMutationHelperCallCount(filename, source), `${filename} exact mutation-helper census drifted`).toBe(
          expectedHelperCalls
        );
      }
    }
  });

  // NEGATIVE control for the META-invariant itself (eats its own dog food).
  // Without these, the check above could trivially pass against a regex bug.

  it("NEGATIVE: checkInvariantHasNegativeCoverage detects file with no coverage", () => {
    const fakeContent = `// just regular code\nimport { describe } from "vitest";\ndescribe("foo", () => {});`;
    const err = checkInvariantHasNegativeCoverage("fake-invariant.test.ts", fakeContent);
    expect(err).toMatch(/no INLINE NEGATIVE control test/);
  });

  it("NEGATIVE: a comment/TODO token with no inline test is REJECTED (rc.23 — closes the audit bypass)", () => {
    // The exact bypass the rc.21 audit reproduced: token only in an aspirational
    // comment, plus a vacuous test. Must NOT satisfy the rule anymore.
    const todoOnly = `// TODO: add a negative-control test later\nit("does a thing", () => { expect(1).toBeGreaterThan(0); });`;
    expect(checkInvariantHasNegativeCoverage("x-invariant.test.ts", todoOnly)).toMatch(
      /no INLINE NEGATIVE control test/
    );
    // And a "covered by sibling" prose comment alone (no inline test, no marker) is also rejected —
    // such files must use the explicit EXEMPT marker (path b), which is unambiguous.
    const proseOnly = `// NEGATIVE control coverage lives in a sibling file\nit("checks", () => { expect(2).toBe(2); });`;
    expect(checkInvariantHasNegativeCoverage("y-invariant.test.ts", proseOnly)).toMatch(/META-INVARIANT-EXEMPT/);
    const deadFunction = `function neverCalled() { it("NEGATIVE: catches drift", () => { expect(run()).toBe(false); }); }`;
    expect(checkInvariantHasNegativeCoverage("dead-function-invariant.test.ts", deadFunction)).toMatch(
      /no INLINE NEGATIVE control test/
    );
    const deadBranch = `if (false) { it("NEGATIVE: catches drift", () => { expect(run()).toBe(false); }); }`;
    expect(checkInvariantHasNegativeCoverage("dead-branch-invariant.test.ts", deadBranch)).toMatch(
      /no INLINE NEGATIVE control test/
    );
    const deadNestedBranch = `describe("suite", () => { if (false) { it("NEGATIVE: catches drift", () => { expect(run()).toBe(false); }); } });`;
    expect(checkInvariantHasNegativeCoverage("dead-nested-branch-invariant.test.ts", deadNestedBranch)).toMatch(
      /no INLINE NEGATIVE control test/
    );
    const registrationAfterReturn = `describe("suite", () => { return; it("NEGATIVE: catches drift", () => { expect(run()).toBe(false); }); });`;
    expect(
      checkInvariantHasNegativeCoverage("after-return-registration-invariant.test.ts", registrationAfterReturn)
    ).toMatch(/no INLINE NEGATIVE control test/);
    const registrationAfterThrow = `describe("suite", () => { throw new Error("stop"); it("NEGATIVE: catches drift", () => { expect(run()).toBe(false); }); });`;
    expect(
      checkInvariantHasNegativeCoverage("after-throw-registration-invariant.test.ts", registrationAfterThrow)
    ).toMatch(/no INLINE NEGATIVE control test/);
    const assertionAfterReturnInNegativeDescribe = `describe("NEGATIVE: claims coverage", () => { return; it("never registered", () => { expect(run()).toBe(false); }); });`;
    expect(
      checkInvariantHasNegativeCoverage(
        "after-return-negative-describe-invariant.test.ts",
        assertionAfterReturnInNegativeDescribe
      )
    ).toMatch(/no INLINE NEGATIVE control test/);
  });

  it("NEGATIVE: checkInvariantHasNegativeCoverage accepts file with NEGATIVE token + asserting body (uppercase)", () => {
    const goodContent = `// has coverage\nit("NEGATIVE: catches drift", () => { expect(check("bad")).toMatch(/x/); });`;
    expect(checkInvariantHasNegativeCoverage("good-invariant.test.ts", goodContent)).toBeNull();
    const explicitFailure = `it("NEGATIVE: catches missed drift", () => { if (!detected()) expect.fail("missed"); });`;
    expect(checkInvariantHasNegativeCoverage("expect-fail-invariant.test.ts", explicitFailure)).toBeNull();
    const positiveAssertionCount = `it("NEGATIVE: requires an assertion", () => { expect.assertions(1); });`;
    expect(checkInvariantHasNegativeCoverage("assertion-count-invariant.test.ts", positiveAssertionCount)).toBeNull();
    const nonSkippedOptions = `it("NEGATIVE: catches drift", { timeout: 1000 }, () => { expect(run()).toBe(false); });`;
    expect(checkInvariantHasNegativeCoverage("options-invariant.test.ts", nonSkippedOptions)).toBeNull();
    const reachableAnd = `it("NEGATIVE: catches drift", () => { true && expect(run()).toBe(false); });`;
    expect(checkInvariantHasNegativeCoverage("reachable-and-invariant.test.ts", reachableAnd)).toBeNull();
    const reachableOr = `it("NEGATIVE: catches drift", () => { false || expect(run()).toBe(false); });`;
    expect(checkInvariantHasNegativeCoverage("reachable-or-invariant.test.ts", reachableOr)).toBeNull();
    const reachableConditional = `it("NEGATIVE: catches drift", () => { true ? expect(run()).toBe(false) : undefined; });`;
    expect(
      checkInvariantHasNegativeCoverage("reachable-conditional-invariant.test.ts", reachableConditional)
    ).toBeNull();
    const conditionalCiSkip = `it("NEGATIVE: catches drift", (ctx) => { if (missingBuild()) return ctx.skip(); expect(run()).toBe(false); });`;
    expect(checkInvariantHasNegativeCoverage("conditional-skip-invariant.test.ts", conditionalCiSkip)).toBeNull();
    const conditionalDestructuredSkip = `it("NEGATIVE: catches drift", ({ skip }) => { if (missingBuild()) return skip(); expect(run()).toBe(false); });`;
    expect(
      checkInvariantHasNegativeCoverage("conditional-destructured-skip-invariant.test.ts", conditionalDestructuredSkip)
    ).toBeNull();
    const skippedSibling = `describe("suite", () => { it.skip("optional", () => {}); it("NEGATIVE: catches drift", () => { expect(run()).toBe(false); }); });`;
    expect(checkInvariantHasNegativeCoverage("skipped-sibling-invariant.test.ts", skippedSibling)).toBeNull();
  });

  it("NEGATIVE: checkInvariantHasNegativeCoverage accepts negative-control describe with asserting nested test (hyphenated)", () => {
    const goodContent = `// has coverage\ndescribe("foo — negative-control via fixtures", () => { it("flags drift", () => { expect(run()).toBe(false); }); });`;
    expect(checkInvariantHasNegativeCoverage("good-invariant.test.ts", goodContent)).toBeNull();
  });

  it("NEGATIVE: an EMPTY-body negative control is REJECTED (rc.26 — closes the vacuity bypass)", () => {
    // The HIGH-1 gap the rc.25 audit found: a title with the token but a body
    // that asserts NOTHING is vacuous — the exact thing this META-invariant forbids.
    const emptyBody = `// header\nit("NEGATIVE: catches drift", () => {});`;
    expect(checkInvariantHasNegativeCoverage("empty-invariant.test.ts", emptyBody)).toMatch(
      /no INLINE NEGATIVE control test/
    );
    const vacuousExpression = `it("NEGATIVE: claims coverage", () => true);`;
    expect(checkInvariantHasNegativeCoverage("vacuous-expression.test.ts", vacuousExpression)).toMatch(
      /no INLINE NEGATIVE control test/
    );
    const borrowedAssertion =
      `it("NEGATIVE: claims coverage", () => true);\n` +
      `it("ordinary positive", () => { expect(run()).toBe(true); });`;
    expect(checkInvariantHasNegativeCoverage("borrowed-assertion.test.ts", borrowedAssertion)).toMatch(
      /no INLINE NEGATIVE control test/
    );
    const assertionString = `it("NEGATIVE: claims coverage", () => "expect(run()).toBe(false)");`;
    expect(checkInvariantHasNegativeCoverage("assertion-string.test.ts", assertionString)).toMatch(
      /no INLINE NEGATIVE control test/
    );
    const assertionRegex = String.raw`it("NEGATIVE: claims coverage", () => /expect\(run\(\)\)\.toBe\(false\)/);`;
    expect(checkInvariantHasNegativeCoverage("assertion-regex.test.ts", assertionRegex)).toMatch(
      /no INLINE NEGATIVE control test/
    );
    const assertionComment =
      `it("NEGATIVE: claims coverage", () => {\n` + `  return true; // expect(run()).toBe(false)\n` + `});`;
    expect(checkInvariantHasNegativeCoverage("assertion-comment.test.ts", assertionComment)).toMatch(
      /no INLINE NEGATIVE control test/
    );
    const deadNestedAssertion =
      `it("NEGATIVE: claims coverage", () => {\n` +
      `  const neverCalled = () => expect(run()).toBe(false);\n` +
      `  return true;\n` +
      `});`;
    expect(checkInvariantHasNegativeCoverage("dead-nested-assertion.test.ts", deadNestedAssertion)).toMatch(
      /no INLINE NEGATIVE control test/
    );
    const bareExpect = `it("NEGATIVE: claims coverage", () => { expect(value); });`;
    expect(checkInvariantHasNegativeCoverage("bare-expect.test.ts", bareExpect)).toMatch(
      /no INLINE NEGATIVE control test/
    );
    const zeroAssertions = `it("NEGATIVE: claims coverage", () => { expect.assertions(0); });`;
    expect(checkInvariantHasNegativeCoverage("zero-assertions.test.ts", zeroAssertions)).toMatch(
      /no INLINE NEGATIVE control test/
    );
    const dynamicAssertions = `it("NEGATIVE: claims coverage", () => { expect.assertions(count); });`;
    expect(checkInvariantHasNegativeCoverage("dynamic-assertions.test.ts", dynamicAssertions)).toMatch(
      /no INLINE NEGATIVE control test/
    );
    const afterReturn = `it("NEGATIVE: claims coverage", () => { return; expect(run()).toBe(false); });`;
    expect(checkInvariantHasNegativeCoverage("after-return.test.ts", afterReturn)).toMatch(
      /no INLINE NEGATIVE control test/
    );
    const literalFalse = `it("NEGATIVE: claims coverage", () => { if (false) expect(run()).toBe(false); });`;
    expect(checkInvariantHasNegativeCoverage("literal-false.test.ts", literalFalse)).toMatch(
      /no INLINE NEGATIVE control test/
    );
    const falseAndAssertion = `it("NEGATIVE: claims coverage", () => { false && expect(run()).toBe(false); });`;
    expect(checkInvariantHasNegativeCoverage("false-and.test.ts", falseAndAssertion)).toMatch(
      /no INLINE NEGATIVE control test/
    );
    const trueOrAssertion = `it("NEGATIVE: claims coverage", () => { true || expect(run()).toBe(false); });`;
    expect(checkInvariantHasNegativeCoverage("true-or.test.ts", trueOrAssertion)).toMatch(
      /no INLINE NEGATIVE control test/
    );
    const falseLoopAssertion = `it("NEGATIVE: claims coverage", () => { while (false) expect(run()).toBe(false); });`;
    expect(checkInvariantHasNegativeCoverage("false-loop.test.ts", falseLoopAssertion)).toMatch(
      /no INLINE NEGATIVE control test/
    );
    const falseForAssertion = `it("NEGATIVE: claims coverage", () => { for (; false; ) expect(run()).toBe(false); });`;
    expect(checkInvariantHasNegativeCoverage("false-for.test.ts", falseForAssertion)).toMatch(
      /no INLINE NEGATIVE control test/
    );
    const falseConditionalAssertion = `it("NEGATIVE: claims coverage", () => { false ? expect(run()).toBe(false) : true; });`;
    expect(checkInvariantHasNegativeCoverage("false-conditional.test.ts", falseConditionalAssertion)).toMatch(
      /no INLINE NEGATIVE control test/
    );
    const skippedBeforeAssertion = `it("NEGATIVE: claims coverage", (ctx) => { ctx.skip(); expect(run()).toBe(false); });`;
    expect(checkInvariantHasNegativeCoverage("runtime-skipped.test.ts", skippedBeforeAssertion)).toMatch(
      /no INLINE NEGATIVE control test/
    );
    const awaitedSkipBeforeAssertion = `it("NEGATIVE: claims coverage", async (ctx) => { await ctx.skip(); expect(run()).toBe(false); });`;
    expect(checkInvariantHasNegativeCoverage("awaited-runtime-skipped.test.ts", awaitedSkipBeforeAssertion)).toMatch(
      /no INLINE NEGATIVE control test/
    );
    const voidSkipBeforeAssertion = `it("NEGATIVE: claims coverage", (ctx) => { void ctx.skip(); expect(run()).toBe(false); });`;
    expect(checkInvariantHasNegativeCoverage("void-runtime-skipped.test.ts", voidSkipBeforeAssertion)).toMatch(
      /no INLINE NEGATIVE control test/
    );
    const bracketSkipBeforeAssertion = `it("NEGATIVE: claims coverage", (ctx) => { ctx["skip"](); expect(run()).toBe(false); });`;
    expect(checkInvariantHasNegativeCoverage("bracket-runtime-skipped.test.ts", bracketSkipBeforeAssertion)).toMatch(
      /no INLINE NEGATIVE control test/
    );
    const destructuredSkipBeforeAssertion = `it("NEGATIVE: claims coverage", ({ ["skip"]: skipTest }) => { skipTest(); expect(run()).toBe(false); });`;
    expect(
      checkInvariantHasNegativeCoverage("destructured-runtime-skipped.test.ts", destructuredSkipBeforeAssertion)
    ).toMatch(/no INLINE NEGATIVE control test/);
    const skippedOptions = `it("NEGATIVE: claims coverage", { skip: true }, () => { expect(run()).toBe(false); });`;
    expect(checkInvariantHasNegativeCoverage("skipped-options.test.ts", skippedOptions)).toMatch(
      /no INLINE NEGATIVE control test/
    );
    const assertedSkippedOptions = `it("NEGATIVE: claims coverage", { skip: true as const }, () => { expect(run()).toBe(false); });`;
    expect(checkInvariantHasNegativeCoverage("asserted-skipped-options.test.ts", assertedSkippedOptions)).toMatch(
      /no INLINE NEGATIVE control test/
    );
    const angleAssertedSkippedOptions = `it("NEGATIVE: claims coverage", { skip: <true>true }, () => { expect(run()).toBe(false); });`;
    expect(
      checkInvariantHasNegativeCoverage("angle-asserted-skipped-options.test.ts", angleAssertedSkippedOptions)
    ).toMatch(/no INLINE NEGATIVE control test/);
    const nonNullSkippedOptions = `it("NEGATIVE: claims coverage", { skip: true! }, () => { expect(run()).toBe(false); });`;
    expect(checkInvariantHasNegativeCoverage("non-null-skipped-options.test.ts", nonNullSkippedOptions)).toMatch(
      /no INLINE NEGATIVE control test/
    );
    const satisfiesSkippedOptions = `it("NEGATIVE: claims coverage", { skip: true satisfies true }, () => { expect(run()).toBe(false); });`;
    expect(checkInvariantHasNegativeCoverage("satisfies-skipped-options.test.ts", satisfiesSkippedOptions)).toMatch(
      /no INLINE NEGATIVE control test/
    );
    const aliasedRegistration = `const invariantTest = it; invariantTest("NEGATIVE: claims coverage", () => { expect(run()).toBe(false); });`;
    expect(checkInvariantHasNegativeCoverage("aliased-registration.test.ts", aliasedRegistration)).toMatch(
      /no INLINE NEGATIVE control test/
    );
    const eachRegistration = `it.each(["bad"])("NEGATIVE: claims coverage", () => { expect(run()).toBe(false); });`;
    expect(checkInvariantHasNegativeCoverage("each-registration.test.ts", eachRegistration)).toMatch(
      /no INLINE NEGATIVE control test/
    );
    const skippedRegistration = `it.skip("NEGATIVE: claims coverage", () => { expect(run()).toBe(false); });`;
    expect(checkInvariantHasNegativeCoverage("skipped-registration.test.ts", skippedRegistration)).toMatch(
      /no INLINE NEGATIVE control test/
    );
    const substringTitle = `it("NONNEGATIVE: claims coverage", () => { expect(run()).toBe(false); });`;
    expect(checkInvariantHasNegativeCoverage("substring-title.test.ts", substringTitle)).toMatch(
      /no INLINE NEGATIVE control test/
    );
    const negatedTitle = `it("NON-NEGATIVE: claims coverage", () => { expect(run()).toBe(false); });`;
    expect(checkInvariantHasNegativeCoverage("negated-title.test.ts", negatedTitle)).toMatch(
      /no INLINE NEGATIVE control test/
    );
    const unicodeAdjacentTitle = `it("ЯNEGATIVE: claims coverage", () => { expect(run()).toBe(false); });`;
    expect(checkInvariantHasNegativeCoverage("unicode-adjacent-title.test.ts", unicodeAdjacentTitle)).toMatch(
      /no INLINE NEGATIVE control test/
    );
    const astralAdjacentTitle = `it("𐐀NEGATIVE: claims coverage", () => { expect(run()).toBe(false); });`;
    expect(checkInvariantHasNegativeCoverage("astral-adjacent-title.test.ts", astralAdjacentTitle)).toMatch(
      /no INLINE NEGATIVE control test/
    );
  });

  it("NEGATIVE: a COMMENTED-OUT negative control is REJECTED (AST ignores comments)", () => {
    // A full-line-commented test must not satisfy the rule even though its text
    // contains both the token and an assertion.
    const commentedOut = `// it("NEGATIVE: catches drift", () => { expect(x).toBe(1); });\nit("real", () => { expect(2).toBe(2); });`;
    expect(checkInvariantHasNegativeCoverage("commented-invariant.test.ts", commentedOut)).toMatch(
      /no INLINE NEGATIVE control test/
    );
  });

  it("NEGATIVE: an expression-bodied arrow negative control is accepted (no `{` body)", () => {
    // `() => expect(...).toThrow()` owns a real matcher assertion — a brace body is not required.
    const exprBody = `// header\nit("NEGATIVE: rejects bad input", () => expect(() => parse("bad")).toThrow());`;
    expect(checkInvariantHasNegativeCoverage("expr-invariant.test.ts", exprBody)).toBeNull();
  });

  it("NEGATIVE: checkInvariantHasNegativeCoverage accepts explicit exempt marker", () => {
    const exemptContent = `// header\n// META-INVARIANT-EXEMPT: covered by sibling file foo-invariant.test.ts\nimport ...`;
    expect(checkInvariantHasNegativeCoverage("exempt-invariant.test.ts", exemptContent)).toBeNull();
  });

  it("NEGATIVE: late, empty, or inert exemption markers do NOT count", () => {
    const tooLate = `${Array(55).fill("// filler").join("\n")}\n// META-INVARIANT-EXEMPT: too late\n`;
    const err = checkInvariantHasNegativeCoverage("late-marker-invariant.test.ts", tooLate);
    expect(err).toMatch(/no INLINE NEGATIVE control test/);
    const emptyReason = `// META-INVARIANT-EXEMPT:   \n`;
    expect(checkInvariantHasNegativeCoverage("empty-marker-invariant.test.ts", emptyReason)).toMatch(
      /no INLINE NEGATIVE control test/
    );
    const stringMarker = `const marker = "// META-INVARIANT-EXEMPT: inert string";`;
    expect(checkInvariantHasNegativeCoverage("string-marker-invariant.test.ts", stringMarker)).toMatch(
      /no INLINE NEGATIVE control test/
    );
    const blockMarker = `/* // META-INVARIANT-EXEMPT: inert block comment */`;
    expect(checkInvariantHasNegativeCoverage("block-marker-invariant.test.ts", blockMarker)).toMatch(
      /no INLINE NEGATIVE control test/
    );
    const trailingMarker = `const active = true; // META-INVARIANT-EXEMPT: not a header line`;
    expect(checkInvariantHasNegativeCoverage("trailing-marker-invariant.test.ts", trailingMarker)).toMatch(
      /no INLINE NEGATIVE control test/
    );
  });
});
