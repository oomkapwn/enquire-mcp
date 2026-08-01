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

import { promises as fs } from "node:fs";
import * as path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "..");

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
