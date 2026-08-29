// v3.7.0 M-2 — AST-based K-1 class invariant (strengthens the grep-based
// guard from v3.6.4).
//
// Background. v3.6.4 added `tests/k1-class-invariant.test.ts` which uses
// grep to assert that every `new EmbedDb(...)` / `new FtsIndex(...)` in
// `src/` is preceded by a configuration-discovery call OR a `// SAFE BY DESIGN`
// comment within 40 lines. That catches the "no discovery at all" case but
// NOT a more insidious variant: discovery IS called, but its result is
// discarded — the constructor uses a hardcoded value independent of
// the discovery result. Example bypass:
//
//   const _ignored = await discoverEmbedDbConfig(file, root); // ✓ grep passes
//   const db = new EmbedDb({ modelAlias: "hardcoded" }); // ✗ K-1 bug
//
// The compiler-API def-use trace below remains an adversarial fixture and
// mutation harness. Production admission is intentionally closed: the three
// files containing all ten reviewed discovery → constructor → awaited-open
// chains are pinned byte-for-byte, with an independent exact import and site
// census. Any byte drift or K-1 surface in another implementation source
// fails until the full chain is explicitly reviewed and its pin is updated.
//
// Test coverage:
//   1. Positive: `tests/fixtures/k1-invariant/good.ts` — all constructors
//      have discovery-derived args; analyzer reports 0 unguarded.
//   2. Negative #1: `tests/fixtures/k1-invariant/bad-ignored-peek.ts` —
//      peek call present, result discarded; analyzer reports ≥1 unguarded.
//   3. Negative #2: `tests/fixtures/k1-invariant/bad-no-peek.ts` —
//      no peek, no SAFE marker; analyzer reports ≥1 unguarded.
//   4. Whole-`src/` run: analyzer reports 0 unguarded across the real
//      production code (in addition to the existing grep-based gate).

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { replaceExactly } from "./helpers/exact-source-mutation.js";

const CONSTRUCTORS = new Set(["EmbedDb", "FtsIndex"]);
// Production callers use the discriminated discovery APIs. Keep the legacy
// diagnostic peek names solely so the frozen positive/negative fixtures still
// exercise the same def-use analyzer without changing fixture bytes.
// K-1-relevant constructor arg names. Every required field (and every extra
// one present) must trace to the exact discovery used by awaited `open(...)`.
const K1_ARG_NAMES = new Set(["modelAlias", "dim", "tokenize", "quantization"]);
const RELEVANT_IMPORT_NAMES = new Set([
  "assertTokenizeMode",
  "discoverEmbedDbConfig",
  "discoverEmbedDbConfigCached",
  "discoverFtsIndexConfig",
  "EmbedDb",
  "FtsIndex",
  "parseQuantizationMode",
  "resolveModel",
  "resolveStoredEmbeddingConfiguration"
]);
// Marker must appear at the START of a line-comment (after `//` and optional
// whitespace). Anchored to defeat false positives from prose like "no SAFE
// BY DESIGN comment present" that mentions the phrase to NEGATE it. The
// grep-based v3.6.4 invariant used a plain substring match — this stricter
// pattern is one of the AST guard's safety upgrades.
const SAFE_MARKER_RE = /^\s*\/\/\s*SAFE BY DESIGN/m;
const SAFE_LOOKBACK_LINES = 40;

interface UnguardedSite {
  file: string;
  line: number;
  className: string;
  reason: string;
}

interface ToolchainPackage {
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface ProductionFilePin {
  constructors: Readonly<Record<"EmbedDb" | "FtsIndex", number>>;
  discoveries: Readonly<
    Record<"discoverEmbedDbConfig" | "discoverEmbedDbConfigCached" | "discoverFtsIndexConfig", number>
  >;
  imports: readonly string[];
  k1Opens: number;
  sha256: string;
}

const PRODUCTION_FILE_PINS: Readonly<Record<string, ProductionFilePin>> = {
  "src/cli.ts": {
    constructors: { EmbedDb: 3, FtsIndex: 5 },
    discoveries: {
      discoverEmbedDbConfig: 2,
      discoverEmbedDbConfigCached: 0,
      discoverFtsIndexConfig: 4
    },
    imports: [
      "./embed-db.js|EmbedDb|EmbedDb",
      "./embed-db.js|discoverEmbedDbConfig|discoverEmbedDbConfig",
      "./embeddings.js|resolveModel|resolveModel",
      "./embeddings.js|resolveStoredEmbeddingConfiguration|resolveStoredEmbeddingConfiguration",
      "./fts5.js|FtsIndex|FtsIndex",
      "./fts5.js|assertTokenizeMode|assertTokenizeMode",
      "./fts5.js|discoverFtsIndexConfig|discoverFtsIndexConfig",
      "./tool-registry.js|parseQuantizationMode|parseQuantizationMode"
    ],
    k1Opens: 6,
    sha256: "7b894cbf9487ed799e090cceea745217012fa9d3e0d6bb07b481f8d0ab4cde26"
  },
  "src/server.ts": {
    constructors: { EmbedDb: 2, FtsIndex: 1 },
    discoveries: {
      discoverEmbedDbConfig: 2,
      discoverEmbedDbConfigCached: 0,
      discoverFtsIndexConfig: 1
    },
    imports: [
      "./embed-db.js|EmbedDb|EmbedDb",
      "./embed-db.js|discoverEmbedDbConfig|discoverEmbedDbConfig",
      "./embeddings.js|resolveModel|resolveModel",
      "./embeddings.js|resolveStoredEmbeddingConfiguration|resolveStoredEmbeddingConfiguration",
      "./fts5.js|FtsIndex|FtsIndex",
      "./fts5.js|assertTokenizeMode|assertTokenizeMode",
      "./fts5.js|discoverFtsIndexConfig|discoverFtsIndexConfig"
    ],
    k1Opens: 3,
    sha256: "b03297c68205aeb7e26f873a182867b10c56e69a39336669c8cf56402026e708"
  },
  "src/tools/search.ts": {
    constructors: { EmbedDb: 1, FtsIndex: 0 },
    discoveries: {
      discoverEmbedDbConfig: 0,
      discoverEmbedDbConfigCached: 1,
      discoverFtsIndexConfig: 0
    },
    imports: [
      "../embed-db.js|EmbedDb|EmbedDb",
      "../embed-db.js|discoverEmbedDbConfigCached|discoverEmbedDbConfigCached",
      "../embeddings.js|resolveModel|resolveModel",
      "../embeddings.js|resolveStoredEmbeddingConfiguration|resolveStoredEmbeddingConfiguration"
    ],
    k1Opens: 1,
    sha256: "a02d7cbfd2f616ad0641e43928c41c58066482799236d325a785f00f670203a7"
  }
};

interface BindingWrite {
  position: number;
  value: ts.Expression;
}

interface LexicalBinding {
  callable?: CallableKind;
  callableBody?: FunctionWithBody;
  parameter: boolean;
  writes: BindingWrite[];
}

interface PropertyMutation {
  position: number;
  target: ts.Expression;
}

interface InvokedClosure {
  body: FunctionWithBody;
  position: number;
}

type AuthorityKind = "embed" | "fts";
type CallableKind =
  | "assert-tokenize"
  | "embed-discovery"
  | "fts-discovery"
  | "parse-quantization"
  | "resolve-model"
  | "resolve-stored-embedding";
type ProvenanceKind =
  | "dim"
  | "embed-config"
  | "embed-discovery"
  | "embed-meta"
  | "embed-model"
  | "modelAlias"
  | "quantization"
  | "stored-model-alias"
  | "fts-discovery"
  | "fts-meta"
  | "tokenize";

interface DataFlowContext {
  allowLegacyFixturePeeks: boolean;
  bindings: ReadonlyMap<ts.Node, ReadonlyMap<string, LexicalBinding>>;
  constructorFile: ts.Expression;
  constructorPosition: number;
  constructorRoot: ts.Expression;
  invokedClosures: readonly InvokedClosure[];
  localInvocationPositions: readonly number[];
  propertyMutations: readonly PropertyMutation[];
  scope: ts.Node;
  sourceFile: ts.SourceFile;
  staticCallables: ReadonlyMap<string, CallableKind>;
}

const CLASSIC_TYPESCRIPT_RANGE = "^6.0.3";
const NATIVE_TYPESCRIPT_ALIAS = "npm:typescript@7.0.2";
const NATIVE_TSC_COMMAND = "node node_modules/typescript-native/bin/tsc";
const NATIVE_EMIT_SCRIPTS = {
  build: `rm -rf dist && ${NATIVE_TSC_COMMAND} && chmod +x dist/index.js`,
  dev: `${NATIVE_TSC_COMMAND} --watch`,
  prepare: `rm -rf dist && ${NATIVE_TSC_COMMAND} && chmod +x dist/index.js && (husky 2>/dev/null || true)`
} as const;

/**
 * Report product-emit scripts that can silently fall back to the classic
 * TypeScript 6 binary. TypeScript 6 remains the root package deliberately:
 * K-1 and TypeDoc 0.28 need its classic Compiler API. Product emit must use
 * the explicit TypeScript 7 alias because both packages expose a `tsc` bin.
 */
function toolchainProblems(pkg: ToolchainPackage): string[] {
  const problems: string[] = [];
  const classic = pkg.devDependencies?.typescript ?? "";
  const native = pkg.devDependencies?.["typescript-native"] ?? "";
  if (classic !== CLASSIC_TYPESCRIPT_RANGE) {
    problems.push(
      `typescript must remain exactly ${CLASSIC_TYPESCRIPT_RANGE} for the classic API (found ${classic || "<missing>"})`
    );
  }
  if (native !== NATIVE_TYPESCRIPT_ALIAS) {
    problems.push(`typescript-native must pin ${NATIVE_TYPESCRIPT_ALIAS} (found ${native || "<missing>"})`);
  }
  for (const [name, expected] of Object.entries(NATIVE_EMIT_SCRIPTS)) {
    const script = pkg.scripts?.[name] ?? "";
    if (script !== expected) {
      problems.push(`${name} must be exactly "${expected}" (found "${script || "<missing>"}")`);
    }
  }
  return problems;
}

/**
 * Find the nearest enclosing function-like scope for `node`. Returns the
 * function body node (Block) or the source file itself if at top level.
 */
function enclosingScope(node: ts.Node): ts.Node {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (
      ts.isFunctionDeclaration(cur) ||
      ts.isFunctionExpression(cur) ||
      ts.isArrowFunction(cur) ||
      ts.isMethodDeclaration(cur) ||
      ts.isConstructorDeclaration(cur) ||
      ts.isGetAccessorDeclaration(cur) ||
      ts.isSetAccessorDeclaration(cur)
    ) {
      return cur.body ?? cur;
    }
    cur = cur.parent;
  }
  return node.getSourceFile();
}

type FunctionWithBody =
  | ts.ArrowFunction
  | ts.ConstructorDeclaration
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.GetAccessorDeclaration
  | ts.MethodDeclaration
  | ts.SetAccessorDeclaration;

function isFunctionWithBody(node: ts.Node): node is FunctionWithBody {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

function isLexicalContainer(node: ts.Node): boolean {
  return (
    ts.isBlock(node) ||
    ts.isSourceFile(node) ||
    ts.isModuleBlock(node) ||
    ts.isCaseBlock(node) ||
    ts.isCatchClause(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node)
  );
}

function nearestLexicalContainer(node: ts.Node, scope: ts.Node): ts.Node {
  let current: ts.Node | undefined = node.parent;
  while (current && current !== scope) {
    if (isLexicalContainer(current)) return current;
    current = current.parent;
  }
  return scope;
}

function staticBoolean(node: ts.Expression): boolean | undefined {
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
    return staticBoolean(node.expression);
  }
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
    const operand = staticBoolean(node.operand);
    return operand === undefined ? undefined : !operand;
  }
  return undefined;
}

function staticNullish(node: ts.Expression): boolean | undefined {
  if (node.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(node) && node.text === "undefined")) return true;
  if (
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    ts.isStringLiteralLike(node) ||
    ts.isNumericLiteral(node) ||
    ts.isObjectLiteralExpression(node) ||
    ts.isArrayLiteralExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node)
  ) {
    return false;
  }
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
    return staticNullish(node.expression);
  }
  return undefined;
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.EqualsToken ||
    kind === ts.SyntaxKind.PlusEqualsToken ||
    kind === ts.SyntaxKind.MinusEqualsToken ||
    kind === ts.SyntaxKind.AsteriskEqualsToken ||
    kind === ts.SyntaxKind.AsteriskAsteriskEqualsToken ||
    kind === ts.SyntaxKind.SlashEqualsToken ||
    kind === ts.SyntaxKind.PercentEqualsToken ||
    kind === ts.SyntaxKind.LessThanLessThanEqualsToken ||
    kind === ts.SyntaxKind.GreaterThanGreaterThanEqualsToken ||
    kind === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken ||
    kind === ts.SyntaxKind.AmpersandEqualsToken ||
    kind === ts.SyntaxKind.BarEqualsToken ||
    kind === ts.SyntaxKind.CaretEqualsToken ||
    kind === ts.SyntaxKind.BarBarEqualsToken ||
    kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
    kind === ts.SyntaxKind.QuestionQuestionEqualsToken
  );
}

function statementDefinitelyExits(statement: ts.Statement): boolean {
  if (
    ts.isReturnStatement(statement) ||
    ts.isThrowStatement(statement) ||
    ts.isBreakStatement(statement) ||
    ts.isContinueStatement(statement)
  ) {
    return true;
  }
  if (ts.isBlock(statement)) {
    const last = statement.statements.at(-1);
    return last !== undefined && statementDefinitelyExits(last);
  }
  return (
    ts.isIfStatement(statement) &&
    statement.elseStatement !== undefined &&
    statementDefinitelyExits(statement.thenStatement) &&
    statementDefinitelyExits(statement.elseStatement)
  );
}

function statementDefinitelyThrows(statement: ts.Statement): boolean {
  if (ts.isThrowStatement(statement)) return true;
  if (ts.isBlock(statement)) {
    const last = statement.statements.at(-1);
    return last !== undefined && statementDefinitelyThrows(last);
  }
  return (
    ts.isIfStatement(statement) &&
    statement.elseStatement !== undefined &&
    statementDefinitelyThrows(statement.thenStatement) &&
    statementDefinitelyThrows(statement.elseStatement)
  );
}

/** Reject writes in statically dead branches; dynamic control flow remains conservative. */
function isSyntacticallyReachable(node: ts.Node, scope: ts.Node): boolean {
  let child: ts.Node = node;
  let parent: ts.Node | undefined = node.parent;
  while (parent) {
    if (ts.isBlock(parent) || ts.isSourceFile(parent) || ts.isCaseClause(parent) || ts.isDefaultClause(parent)) {
      const statements = parent.statements;
      const containingStatement = statements.find((statement) => isDescendantOf(child, statement));
      if (containingStatement) {
        const index = statements.indexOf(containingStatement);
        if (statements.slice(0, index).some(statementDefinitelyExits)) return false;
      }
    }
    if (ts.isIfStatement(parent)) {
      const condition = staticBoolean(parent.expression);
      if (condition === false && child === parent.thenStatement) return false;
      if (condition === true && child === parent.elseStatement) return false;
    } else if (ts.isConditionalExpression(parent)) {
      const condition = staticBoolean(parent.condition);
      if (condition === false && child === parent.whenTrue) return false;
      if (condition === true && child === parent.whenFalse) return false;
    } else if (ts.isWhileStatement(parent) && staticBoolean(parent.expression) === false) {
      if (child === parent.statement) return false;
    } else if (ts.isForStatement(parent) && parent.condition && staticBoolean(parent.condition) === false) {
      if (child === parent.statement) return false;
    } else if (ts.isBinaryExpression(parent) && child === parent.right) {
      const left = staticBoolean(parent.left);
      if (parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && left === false) return false;
      if (parent.operatorToken.kind === ts.SyntaxKind.BarBarToken && left === true) return false;
      if (parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken && staticNullish(parent.left) === false) {
        return false;
      }
    }
    if (parent === scope) break;
    child = parent;
    parent = parent.parent;
  }
  return true;
}

function callableKindForImport(importedName: string, moduleName: string): CallableKind | undefined {
  if (moduleName === "./embed-db.js" || moduleName === "../embed-db.js") {
    if (importedName === "discoverEmbedDbConfig") return "embed-discovery";
    if (importedName === "discoverEmbedDbConfigCached") return "embed-discovery";
  }
  if (moduleName === "./fts5.js" || moduleName === "../fts5.js") {
    if (importedName === "discoverFtsIndexConfig") return "fts-discovery";
    if (importedName === "assertTokenizeMode") return "assert-tokenize";
  }
  if (moduleName === "./embeddings.js" || moduleName === "../embeddings.js") {
    if (importedName === "resolveModel") return "resolve-model";
    if (importedName === "resolveStoredEmbeddingConfiguration") return "resolve-stored-embedding";
  }
  if (
    (moduleName === "./tool-registry.js" || moduleName === "../tool-registry.js") &&
    importedName === "parseQuantizationMode"
  ) {
    return "parse-quantization";
  }
  return undefined;
}

function unwrapExpression(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isAwaitExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function dynamicImportModule(node: ts.Expression): string | undefined {
  const expression = unwrapExpression(node);
  if (
    !ts.isCallExpression(expression) ||
    expression.expression.kind !== ts.SyntaxKind.ImportKeyword ||
    expression.arguments.length !== 1
  ) {
    return undefined;
  }
  const moduleName = expression.arguments[0];
  return moduleName && ts.isStringLiteralLike(moduleName) ? moduleName.text : undefined;
}

function promiseAllImportModules(node: ts.Expression): Array<string | undefined> | undefined {
  const expression = unwrapExpression(node);
  if (
    !ts.isCallExpression(expression) ||
    !ts.isPropertyAccessExpression(expression.expression) ||
    !ts.isIdentifier(expression.expression.expression) ||
    expression.expression.expression.text !== "Promise" ||
    expression.expression.name.text !== "all" ||
    expression.arguments.length !== 1
  ) {
    return undefined;
  }
  const imports = expression.arguments[0];
  if (!imports || !ts.isArrayLiteralExpression(imports)) return undefined;
  return imports.elements.map((element) => (ts.isSpreadElement(element) ? undefined : dynamicImportModule(element)));
}

function collectRelevantImportBindings(sourceFile: ts.SourceFile): string[] {
  const imports: string[] = [];

  function collectPattern(pattern: ts.ObjectBindingPattern, moduleName: string): void {
    for (const element of pattern.elements) {
      if (!ts.isIdentifier(element.name)) continue;
      const propertyName = element.propertyName;
      const importedName =
        propertyName && (ts.isIdentifier(propertyName) || ts.isStringLiteralLike(propertyName))
          ? propertyName.text
          : element.name.text;
      if (RELEVANT_IMPORT_NAMES.has(importedName)) {
        imports.push(`${moduleName}|${importedName}|${element.name.text}`);
      }
    }
  }

  for (const statement of sourceFile.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteralLike(statement.moduleSpecifier) &&
      !statement.importClause?.isTypeOnly &&
      statement.importClause?.namedBindings &&
      ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      for (const element of statement.importClause.namedBindings.elements) {
        if (element.isTypeOnly) continue;
        const importedName = element.propertyName?.text ?? element.name.text;
        if (RELEVANT_IMPORT_NAMES.has(importedName)) {
          imports.push(`${statement.moduleSpecifier.text}|${importedName}|${element.name.text}`);
        }
      }
    }
  }

  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isObjectBindingPattern(node.name)) {
        const moduleName = dynamicImportModule(node.initializer);
        if (moduleName) collectPattern(node.name, moduleName);
      } else if (ts.isArrayBindingPattern(node.name)) {
        const modules = promiseAllImportModules(node.initializer);
        if (modules) {
          node.name.elements.forEach((element, index) => {
            if (!ts.isBindingElement(element) || !ts.isObjectBindingPattern(element.name)) return;
            const moduleName = modules[index];
            if (moduleName) collectPattern(element.name, moduleName);
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return imports.sort();
}

function productionRelativePath(filePath: string): string {
  const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  return path.relative(process.cwd(), absolutePath).split(path.sep).join("/");
}

function sourceSha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function productionPinViolation(filePath: string, reason: string): UnguardedSite[] {
  return [{ file: filePath, line: 1, className: "K1ProductionInventory", reason }];
}

function analyzePinnedProductionSource(
  filePath: string,
  text: string,
  sourceFile: ts.SourceFile,
  pin: ProductionFilePin
): UnguardedSite[] {
  const digest = sourceSha256(text);
  if (digest !== pin.sha256) {
    return productionPinViolation(
      filePath,
      `production K-1 source hash mismatch: expected ${pin.sha256}, received ${digest}`
    );
  }

  const imports = collectRelevantImportBindings(sourceFile);
  const expectedImports = [...pin.imports].sort();
  if (!sameStringArray(imports, expectedImports)) {
    return productionPinViolation(filePath, "production K-1 relevant import binding census drifted");
  }

  const constructorAliases = new Map<string, "EmbedDb" | "FtsIndex">();
  const discoveryAliases = new Map<
    string,
    "discoverEmbedDbConfig" | "discoverEmbedDbConfigCached" | "discoverFtsIndexConfig"
  >();
  for (const entry of imports) {
    const [, importedName, localName] = entry.split("|");
    if (!importedName || !localName) continue;
    if (importedName === "EmbedDb" || importedName === "FtsIndex") {
      constructorAliases.set(localName, importedName);
    } else if (
      importedName === "discoverEmbedDbConfig" ||
      importedName === "discoverEmbedDbConfigCached" ||
      importedName === "discoverFtsIndexConfig"
    ) {
      discoveryAliases.set(localName, importedName);
    }
  }

  const constructors = { EmbedDb: 0, FtsIndex: 0 };
  const discoveries = {
    discoverEmbedDbConfig: 0,
    discoverEmbedDbConfigCached: 0,
    discoverFtsIndexConfig: 0
  };
  let k1Opens = 0;
  function visit(node: ts.Node): void {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
      const constructorKind = constructorAliases.get(node.expression.text);
      if (constructorKind) constructors[constructorKind] += 1;
    } else if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression)) {
        const discovery = discoveryAliases.get(node.expression.text);
        if (discovery) discoveries[discovery] += 1;
      } else {
        const openArgument = node.arguments[0];
        if (
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "open" &&
          ts.isIdentifier(node.expression.expression) &&
          node.arguments.length === 1 &&
          openArgument &&
          ts.isIdentifier(openArgument)
        ) {
          k1Opens += 1;
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  if (
    constructors.EmbedDb !== pin.constructors.EmbedDb ||
    constructors.FtsIndex !== pin.constructors.FtsIndex ||
    discoveries.discoverEmbedDbConfig !== pin.discoveries.discoverEmbedDbConfig ||
    discoveries.discoverEmbedDbConfigCached !== pin.discoveries.discoverEmbedDbConfigCached ||
    discoveries.discoverFtsIndexConfig !== pin.discoveries.discoverFtsIndexConfig ||
    k1Opens !== pin.k1Opens
  ) {
    return productionPinViolation(filePath, "production K-1 constructor/discovery/open census drifted");
  }
  return [];
}

function isAuthorityModuleSpecifier(moduleName: string, sourceFile: ts.SourceFile): boolean {
  if (/(?:^|\/)(?:embed-db|embeddings|fts5|tool-registry)(?:\.[cm]?[jt]s)?$/.test(moduleName)) {
    return true;
  }
  if (!moduleName.startsWith(".")) return false;
  const sourcePath = path.isAbsolute(sourceFile.fileName)
    ? sourceFile.fileName
    : path.resolve(process.cwd(), sourceFile.fileName);
  const resolvedStem = path.resolve(path.dirname(sourcePath), moduleName).replace(/\.[cm]?[jt]s$/, "");
  return ["embed-db", "embeddings", "fts5", "tool-registry"].some(
    (name) => resolvedStem === path.resolve(process.cwd(), "src", name)
  );
}

function hasUnpinnedK1Surface(sourceFile: ts.SourceFile): boolean {
  const operationalImports = new Set([
    "discoverEmbedDbConfig",
    "discoverEmbedDbConfigCached",
    "discoverFtsIndexConfig",
    "EmbedDb",
    "FtsIndex"
  ]);
  if (
    collectRelevantImportBindings(sourceFile).some((entry) => {
      const importedName = entry.split("|")[1];
      return importedName !== undefined && operationalImports.has(importedName);
    })
  ) {
    return true;
  }
  for (const statement of sourceFile.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      !statement.importClause?.isTypeOnly &&
      ts.isStringLiteralLike(statement.moduleSpecifier) &&
      isAuthorityModuleSpecifier(statement.moduleSpecifier.text, sourceFile) &&
      (statement.importClause?.name ||
        (statement.importClause?.namedBindings && ts.isNamespaceImport(statement.importClause.namedBindings)))
    ) {
      return true;
    }
    if (
      ts.isImportEqualsDeclaration(statement) &&
      !statement.isTypeOnly &&
      ts.isExternalModuleReference(statement.moduleReference) &&
      statement.moduleReference.expression &&
      ts.isStringLiteralLike(statement.moduleReference.expression) &&
      isAuthorityModuleSpecifier(statement.moduleReference.expression.text, sourceFile)
    ) {
      return true;
    }
    if (
      !ts.isExportDeclaration(statement) ||
      statement.isTypeOnly ||
      !statement.moduleSpecifier ||
      !ts.isStringLiteralLike(statement.moduleSpecifier)
    ) {
      continue;
    }
    const clause = statement.exportClause;
    if (
      (!clause || ts.isNamespaceExport(clause)) &&
      isAuthorityModuleSpecifier(statement.moduleSpecifier.text, sourceFile)
    ) {
      return true;
    }
    if (clause && ts.isNamedExports(clause)) {
      for (const element of clause.elements) {
        if (element.isTypeOnly) continue;
        const exportedOriginal = element.propertyName?.text ?? element.name.text;
        if (operationalImports.has(exportedOriginal)) return true;
      }
    }
  }
  let found = false;
  function visit(node: ts.Node): void {
    if (found) return;
    if (
      ts.isNewExpression(node) &&
      ((ts.isIdentifier(node.expression) && CONSTRUCTORS.has(node.expression.text)) ||
        (ts.isPropertyAccessExpression(node.expression) && CONSTRUCTORS.has(node.expression.name.text)))
    ) {
      found = true;
      return;
    }
    if (ts.isCallExpression(node)) {
      const firstArgument = node.arguments[0];
      const importedModule =
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
        node.arguments.length === 1 &&
        firstArgument &&
        ts.isStringLiteralLike(firstArgument)
          ? firstArgument.text
          : undefined;
      if (importedModule && isAuthorityModuleSpecifier(importedModule, sourceFile)) {
        found = true;
        return;
      }
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "open" &&
        node.arguments.length === 1 &&
        firstArgument &&
        ts.isIdentifier(firstArgument)
      ) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return found;
}

function createDataFlowContext(
  sourceFile: ts.SourceFile,
  scope: ts.Node,
  constructorPosition: number,
  constructorFile: ts.Expression,
  constructorRoot: ts.Expression,
  allowLegacyFixturePeeks: boolean
): DataFlowContext {
  const bindings = new Map<ts.Node, Map<string, LexicalBinding>>();
  const invokedClosures: InvokedClosure[] = [];
  const localInvocationPositions: number[] = [];
  const propertyMutations: PropertyMutation[] = [];
  const staticCallables = new Map<string, CallableKind>();

  function ensureBinding(container: ts.Node, name: string, parameter = false): LexicalBinding {
    let byName = bindings.get(container);
    if (!byName) {
      byName = new Map<string, LexicalBinding>();
      bindings.set(container, byName);
    }
    let binding = byName.get(name);
    if (!binding) {
      binding = { parameter, writes: [] };
      byName.set(name, binding);
    } else if (parameter) {
      binding.parameter = true;
    }
    return binding;
  }

  function variableContainer(node: ts.VariableDeclaration): ts.Node {
    const declarationList = node.parent;
    if (ts.isVariableDeclarationList(declarationList) && (declarationList.flags & ts.NodeFlags.BlockScoped) === 0) {
      let current: ts.Node | undefined = node.parent;
      while (current && current !== scope) {
        if (isFunctionWithBody(current)) return current.body ?? current;
        current = current.parent;
      }
      return scope;
    }
    return nearestLexicalContainer(node, scope);
  }

  function registerBindingName(name: ts.BindingName, container: ts.Node, parameter = false): void {
    if (ts.isIdentifier(name)) {
      ensureBinding(container, name.text, parameter);
      return;
    }
    for (const element of name.elements) {
      if (ts.isBindingElement(element)) registerBindingName(element.name, container, parameter);
    }
  }

  for (const statement of sourceFile.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteralLike(statement.moduleSpecifier) &&
      statement.importClause?.namedBindings &&
      ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      for (const element of statement.importClause.namedBindings.elements) {
        const importedName = element.propertyName?.text ?? element.name.text;
        const callable = callableKindForImport(importedName, statement.moduleSpecifier.text);
        if (callable) staticCallables.set(element.name.text, callable);
      }
    }
    if (allowLegacyFixturePeeks && ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        if (declaration.name.text === "peekEmbedDbMeta") {
          staticCallables.set(declaration.name.text, "embed-discovery");
        } else if (declaration.name.text === "peekFtsMetaSafe") {
          staticCallables.set(declaration.name.text, "fts-discovery");
        } else if (declaration.name.text === "resolveModel") {
          staticCallables.set(declaration.name.text, "resolve-model");
        }
      }
    }
  }

  const owner = scope.parent;
  if (owner && isFunctionWithBody(owner) && owner.body === scope) {
    for (const parameter of owner.parameters) registerBindingName(parameter.name, scope, true);
  }

  function collectBindings(node: ts.Node): void {
    if (node !== scope && isFunctionWithBody(node)) {
      if (ts.isFunctionDeclaration(node) && node.name) {
        ensureBinding(nearestLexicalContainer(node, scope), node.name.text).callableBody = node;
      }
      const bodyContainer = node.body ?? node;
      for (const parameter of node.parameters) registerBindingName(parameter.name, bodyContainer, true);
      if (node.body) ts.forEachChild(node.body, collectBindings);
      return;
    }
    if (ts.isVariableDeclaration(node)) {
      const container = variableContainer(node);
      registerBindingName(node.name, container);
      if (
        ts.isIdentifier(node.name) &&
        node.initializer &&
        (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
      ) {
        ensureBinding(container, node.name.text).callableBody = node.initializer;
      }
    } else if (ts.isCatchClause(node) && node.variableDeclaration) {
      registerBindingName(node.variableDeclaration.name, node);
    } else if (ts.isClassDeclaration(node) && node.name) {
      ensureBinding(nearestLexicalContainer(node, scope), node.name.text);
    }
    ts.forEachChild(node, collectBindings);
  }
  collectBindings(scope);

  function resolveLocalBinding(identifier: ts.Identifier): LexicalBinding | undefined {
    let current: ts.Node | undefined = identifier;
    while (current) {
      const binding = bindings.get(current)?.get(identifier.text);
      if (binding) return binding;
      if (current === scope) break;
      current = current.parent;
    }
    return undefined;
  }

  function markObjectImportBindings(pattern: ts.ObjectBindingPattern, moduleName: string, container: ts.Node): void {
    for (const element of pattern.elements) {
      if (!ts.isIdentifier(element.name)) continue;
      const propertyName = element.propertyName;
      const importedName =
        propertyName && (ts.isIdentifier(propertyName) || ts.isStringLiteralLike(propertyName))
          ? propertyName.text
          : element.name.text;
      const callable = callableKindForImport(importedName, moduleName);
      if (callable) ensureBinding(container, element.name.text).callable = callable;
    }
  }

  function markDynamicImportBindings(node: ts.VariableDeclaration): void {
    if (!node.initializer) return;
    const container = variableContainer(node);
    if (ts.isObjectBindingPattern(node.name)) {
      const moduleName = dynamicImportModule(node.initializer);
      if (moduleName) markObjectImportBindings(node.name, moduleName, container);
      return;
    }
    if (!ts.isArrayBindingPattern(node.name)) return;
    const modules = promiseAllImportModules(node.initializer);
    if (!modules) return;
    node.name.elements.forEach((element, index) => {
      if (!ts.isBindingElement(element) || !ts.isObjectBindingPattern(element.name)) return;
      const moduleName = modules[index];
      if (moduleName) markObjectImportBindings(element.name, moduleName, container);
    });
  }

  function addWrite(binding: LexicalBinding, value: ts.Expression): void {
    const position = value.getStart();
    if (!isSyntacticallyReachable(value, scope)) return;
    binding.writes.push({ position, value });
  }

  function callableBodyAt(
    node: ts.Expression,
    beforePosition: number,
    seenBindings: ReadonlySet<LexicalBinding> = new Set<LexicalBinding>()
  ): FunctionWithBody | undefined {
    const expression = unwrapExpression(node);
    if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) return expression;
    if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
      const object = objectLiteralAt(expression.expression, beforePosition, seenBindings);
      const propertyName = accessPropertyName(expression);
      if (!object || propertyName === undefined) return undefined;
      for (const property of [...object.properties].reverse()) {
        if (ts.isSpreadAssignment(property) || literalPropertyName(property.name) !== propertyName) continue;
        if (
          ts.isMethodDeclaration(property) ||
          ts.isGetAccessorDeclaration(property) ||
          ts.isSetAccessorDeclaration(property)
        ) {
          return property;
        }
        if (ts.isPropertyAssignment(property)) {
          return callableBodyAt(property.initializer, property.initializer.getStart(), seenBindings);
        }
        if (ts.isShorthandPropertyAssignment(property)) {
          return callableBodyAt(property.name, property.name.getStart(), seenBindings);
        }
      }
      return undefined;
    }
    if (!ts.isIdentifier(expression)) return undefined;
    const binding = resolveLocalBinding(expression);
    if (!binding || seenBindings.has(binding)) return undefined;
    const write = binding.writes
      .filter((candidate) => candidate.position < beforePosition)
      .sort((left, right) => right.position - left.position)[0];
    if (!write) return binding.callableBody;
    const nextSeen = new Set(seenBindings);
    nextSeen.add(binding);
    return callableBodyAt(write.value, write.position, nextSeen);
  }

  function literalPropertyName(name: ts.PropertyName | undefined): string | undefined {
    if (!name) return undefined;
    if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
      return name.text;
    }
    if (
      ts.isComputedPropertyName(name) &&
      (ts.isStringLiteralLike(name.expression) || ts.isNumericLiteral(name.expression))
    ) {
      return name.expression.text;
    }
    return undefined;
  }

  function accessPropertyName(
    expression: ts.PropertyAccessExpression | ts.ElementAccessExpression
  ): string | undefined {
    if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
    const argument = expression.argumentExpression;
    return argument && (ts.isStringLiteralLike(argument) || ts.isNumericLiteral(argument)) ? argument.text : undefined;
  }

  function objectLiteralAt(
    node: ts.Expression,
    beforePosition: number,
    seenBindings: ReadonlySet<LexicalBinding> = new Set<LexicalBinding>()
  ): ts.ObjectLiteralExpression | undefined {
    const expression = unwrapExpression(node);
    if (ts.isObjectLiteralExpression(expression)) return expression;
    if (!ts.isIdentifier(expression)) return undefined;
    const binding = resolveLocalBinding(expression);
    if (!binding || seenBindings.has(binding)) return undefined;
    const write = binding.writes
      .filter((candidate) => candidate.position < beforePosition)
      .sort((left, right) => right.position - left.position)[0];
    if (!write) return undefined;
    const nextSeen = new Set(seenBindings);
    nextSeen.add(binding);
    return objectLiteralAt(write.value, write.position, nextSeen);
  }

  function collectWrites(node: ts.Node): void {
    if (node !== scope && isFunctionWithBody(node)) return;
    if (ts.isVariableDeclaration(node)) {
      markDynamicImportBindings(node);
      if (ts.isIdentifier(node.name) && node.initializer) {
        addWrite(ensureBinding(variableContainer(node), node.name.text), node.initializer);
      }
    } else if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
      if (ts.isIdentifier(node.left)) {
        const binding = resolveLocalBinding(node.left);
        if (binding) addWrite(binding, node.operatorToken.kind === ts.SyntaxKind.EqualsToken ? node.right : node);
      } else if (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left)) {
        const position = node.getStart();
        if (isSyntacticallyReachable(node, scope)) {
          propertyMutations.push({ position, target: node.left });
        }
      }
    } else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      if (ts.isIdentifier(node.operand)) {
        const binding = resolveLocalBinding(node.operand);
        if (binding) addWrite(binding, node);
      } else if (ts.isPropertyAccessExpression(node.operand) || ts.isElementAccessExpression(node.operand)) {
        const position = node.getStart();
        if (isSyntacticallyReachable(node, scope)) {
          propertyMutations.push({ position, target: node.operand });
        }
      }
    } else if (ts.isCallExpression(node)) {
      const callee = unwrapExpression(node.expression);
      const mutatingTarget =
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        ((callee.expression.text === "Object" &&
          (callee.name.text === "assign" || callee.name.text === "defineProperty")) ||
          (callee.expression.text === "Reflect" &&
            (callee.name.text === "set" || callee.name.text === "deleteProperty")))
          ? node.arguments[0]
          : undefined;
      if (mutatingTarget && isSyntacticallyReachable(node, scope)) {
        propertyMutations.push({ position: node.getStart(), target: mutatingTarget });
      }
      const position = node.getStart();
      if (isSyntacticallyReachable(node, scope)) {
        const bodies = new Set<FunctionWithBody>();
        const calleeBody = callableBodyAt(callee, position);
        if (calleeBody) bodies.add(calleeBody);
        for (const argument of node.arguments) {
          if (ts.isSpreadElement(argument)) continue;
          const callbackBody = callableBodyAt(argument, position);
          if (callbackBody) bodies.add(callbackBody);
        }
        const localObjectCall =
          (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) &&
          objectLiteralAt(callee.expression, position) !== undefined;
        if (bodies.size > 0 || localObjectCall) localInvocationPositions.push(position);
        for (const body of bodies) invokedClosures.push({ body, position });
      }
    }
    ts.forEachChild(node, collectWrites);
  }
  collectWrites(scope);
  for (const byName of bindings.values()) {
    for (const binding of byName.values()) binding.writes.sort((a, b) => b.position - a.position);
  }

  return {
    allowLegacyFixturePeeks,
    bindings,
    constructorFile,
    constructorPosition,
    constructorRoot,
    invokedClosures,
    localInvocationPositions,
    propertyMutations,
    scope,
    sourceFile,
    staticCallables
  };
}

function resolveBinding(identifier: ts.Identifier, context: DataFlowContext): LexicalBinding | undefined {
  let current: ts.Node | undefined = identifier;
  while (current) {
    const binding = context.bindings.get(current)?.get(identifier.text);
    if (binding) return binding;
    if (current === context.scope) break;
    current = current.parent;
  }
  return undefined;
}

function resolvedCallable(identifier: ts.Identifier, context: DataFlowContext): CallableKind | undefined {
  const local = resolveBinding(identifier, context);
  return local ? local.callable : context.staticCallables.get(identifier.text);
}

interface CanonicalAccessPath {
  originPosition: number;
  root: LexicalBinding | string;
  segments: string[];
}

function accessSegment(node: ts.Expression): string | undefined {
  const expression = unwrapExpression(node);
  if (ts.isStringLiteralLike(expression) || ts.isNumericLiteral(expression)) return expression.text;
  return undefined;
}

function canonicalAccessPath(
  node: ts.Expression,
  context: DataFlowContext,
  beforePosition = node.getStart(),
  seenBindings: ReadonlySet<LexicalBinding> = new Set<LexicalBinding>()
): CanonicalAccessPath | undefined {
  const expression = unwrapExpression(node);
  if (ts.isPropertyAccessExpression(expression)) {
    const parent = canonicalAccessPath(expression.expression, context, beforePosition, seenBindings);
    return parent ? { ...parent, segments: [...parent.segments, expression.name.text] } : undefined;
  }
  if (ts.isElementAccessExpression(expression) && expression.argumentExpression) {
    const segment = accessSegment(expression.argumentExpression);
    if (segment === undefined) return undefined;
    const parent = canonicalAccessPath(expression.expression, context, beforePosition, seenBindings);
    return parent ? { ...parent, segments: [...parent.segments, segment] } : undefined;
  }
  if (!ts.isIdentifier(expression)) return undefined;
  const binding = resolveBinding(expression, context);
  if (!binding) return { originPosition: 0, root: `global:${expression.text}`, segments: [] };
  if (seenBindings.has(binding)) return undefined;
  const write = binding.writes.find((candidate) => candidate.position < beforePosition);
  if (write) {
    const value = unwrapExpression(write.value);
    if (ts.isIdentifier(value) || ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) {
      const nextSeen = new Set(seenBindings);
      nextSeen.add(binding);
      const aliased = canonicalAccessPath(value, context, write.position, nextSeen);
      if (aliased) return aliased;
    }
  }
  return { originPosition: write?.position ?? 0, root: binding, segments: [] };
}

function sameCanonicalAccess(left: CanonicalAccessPath, right: CanonicalAccessPath): boolean {
  return (
    left.root === right.root &&
    left.originPosition === right.originPosition &&
    left.segments.length === right.segments.length &&
    left.segments.every((segment, index) => segment === right.segments[index])
  );
}

function mutationAffectsPath(mutation: CanonicalAccessPath, access: CanonicalAccessPath): boolean {
  return (
    mutation.root === access.root &&
    mutation.originPosition === access.originPosition &&
    mutation.segments.length <= access.segments.length &&
    mutation.segments.every((segment, index) => segment === access.segments[index])
  );
}

function closurePropertyTargets(body: FunctionWithBody): ts.Expression[] {
  const targets: ts.Expression[] = [];
  function visit(node: ts.Node): void {
    if (node !== body && isFunctionWithBody(node)) return;
    if (
      ts.isBinaryExpression(node) &&
      isAssignmentOperator(node.operatorToken.kind) &&
      (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left))
    ) {
      targets.push(node.left);
    } else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) &&
      (ts.isPropertyAccessExpression(node.operand) || ts.isElementAccessExpression(node.operand))
    ) {
      targets.push(node.operand);
    }
    ts.forEachChild(node, visit);
  }
  if (body.body) visit(body.body);
  return targets;
}

function pathWasMutatedBetween(
  access: CanonicalAccessPath,
  startPosition: number,
  endPosition: number,
  context: DataFlowContext
): boolean {
  for (const mutation of context.propertyMutations) {
    if (mutation.position <= startPosition || mutation.position >= endPosition) continue;
    const mutatedPath = canonicalAccessPath(mutation.target, context, mutation.position);
    if (mutatedPath && mutationAffectsPath(mutatedPath, access)) return true;
  }
  for (const invocation of context.invokedClosures) {
    if (invocation.position <= startPosition || invocation.position >= endPosition) continue;
    for (const target of closurePropertyTargets(invocation.body)) {
      const mutatedPath = canonicalAccessPath(target, context, invocation.position);
      if (mutatedPath && mutationAffectsPath(mutatedPath, access)) return true;
    }
  }
  return false;
}

function sameLexicalValue(leftNode: ts.Expression, rightNode: ts.Expression, context: DataFlowContext): boolean {
  const left = unwrapExpression(leftNode);
  const right = unwrapExpression(rightNode);
  if (ts.isIdentifier(left) && ts.isIdentifier(right)) {
    const leftBinding = resolveBinding(left, context);
    const rightBinding = resolveBinding(right, context);
    if (!leftBinding && !rightBinding) return left.text === right.text;
    if (!leftBinding || leftBinding !== rightBinding) return false;
    const leftWrite = leftBinding.writes.find((candidate) => candidate.position < left.getStart());
    const rightWrite = rightBinding.writes.find((candidate) => candidate.position < right.getStart());
    if (leftWrite !== rightWrite) return false;
    const start = Math.min(left.getStart(), right.getStart());
    const end = Math.max(left.getStart(), right.getStart());
    return (
      !localCallableWasInvokedBetween(start, end, context) &&
      !bindingWasCapturedByClosureBetween(leftBinding, start, end, context) &&
      !bindingWasMutatedByClosure(leftBinding, start, end, context)
    );
  }
  if (
    (ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left)) &&
    (ts.isPropertyAccessExpression(right) || ts.isElementAccessExpression(right))
  ) {
    const leftPath = canonicalAccessPath(left, context);
    const rightPath = canonicalAccessPath(right, context);
    if (!leftPath || !rightPath || !sameCanonicalAccess(leftPath, rightPath)) return false;
    const start = Math.min(left.getStart(), right.getStart());
    const end = Math.max(left.getStart(), right.getStart());
    return (
      !localCallableWasInvokedBetween(start, end, context) &&
      (typeof leftPath.root === "string" || !bindingWasCapturedByClosureBetween(leftPath.root, start, end, context)) &&
      !pathWasMutatedBetween(leftPath, start, end, context)
    );
  }
  if (ts.isStringLiteralLike(left) && ts.isStringLiteralLike(right)) return left.text === right.text;
  if (ts.isNumericLiteral(left) && ts.isNumericLiteral(right)) return left.text === right.text;
  return (
    left.kind === right.kind &&
    (left.kind === ts.SyntaxKind.NullKeyword ||
      left.kind === ts.SyntaxKind.TrueKeyword ||
      left.kind === ts.SyntaxKind.FalseKeyword)
  );
}

function directDiscoveryCarriesAuthority(
  node: ts.CallExpression,
  context: DataFlowContext,
  expectedValue: ProvenanceKind
): boolean {
  if (!ts.isIdentifier(node.expression)) return false;
  const legacyMeta =
    context.allowLegacyFixturePeeks &&
    ((node.expression.text === "peekEmbedDbMeta" && expectedValue === "embed-meta") ||
      (node.expression.text === "peekFtsMetaSafe" && expectedValue === "fts-meta"));
  const expectedCallable =
    expectedValue === "embed-discovery"
      ? "embed-discovery"
      : expectedValue === "fts-discovery"
        ? "fts-discovery"
        : legacyMeta
          ? expectedValue === "embed-meta"
            ? "embed-discovery"
            : "fts-discovery"
          : undefined;
  if (!expectedCallable) return false;
  if (resolvedCallable(node.expression, context) !== expectedCallable) return false;
  const file = node.arguments[0];
  const root = node.arguments[1];
  if (legacyMeta) {
    return file !== undefined && sameLexicalValue(file, context.constructorFile, context);
  }
  return (
    file !== undefined &&
    root !== undefined &&
    sameLexicalValue(file, context.constructorFile, context) &&
    sameLexicalValue(root, context.constructorRoot, context)
  );
}

function isDescendantOf(node: ts.Node, ancestor: ts.Node): boolean {
  let current: ts.Node | undefined = node;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

function writeDominatesUse(write: ts.Expression, use: ts.Node, scope: ts.Node): boolean {
  let child: ts.Node = write;
  let parent: ts.Node | undefined = write.parent;
  while (parent) {
    let controlledRegion: ts.Node | undefined;
    if (ts.isIfStatement(parent)) {
      if (isDescendantOf(child, parent.thenStatement)) controlledRegion = parent.thenStatement;
      else if (parent.elseStatement && isDescendantOf(child, parent.elseStatement)) {
        controlledRegion = parent.elseStatement;
      }
    } else if (ts.isWhileStatement(parent) || ts.isDoStatement(parent)) {
      if (isDescendantOf(child, parent.statement)) controlledRegion = parent.statement;
    } else if (ts.isForStatement(parent)) {
      if (parent.incrementor && isDescendantOf(child, parent.incrementor)) {
        // The incrementor has not executed when the body runs for the first
        // time, and it may never execute if the loop is skipped or exits.
        controlledRegion = parent.incrementor;
      } else if (isDescendantOf(child, parent.statement)) {
        controlledRegion = parent.statement;
      }
    } else if (ts.isForInStatement(parent) || ts.isForOfStatement(parent)) {
      if (isDescendantOf(child, parent.initializer) || isDescendantOf(child, parent.statement)) {
        controlledRegion = parent.statement;
      }
    } else if (ts.isConditionalExpression(parent)) {
      if (isDescendantOf(child, parent.whenTrue)) controlledRegion = parent.whenTrue;
      else if (isDescendantOf(child, parent.whenFalse)) controlledRegion = parent.whenFalse;
    } else if (
      ts.isBinaryExpression(parent) &&
      isDescendantOf(child, parent.right) &&
      (parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        parent.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
    ) {
      controlledRegion = parent.right;
    } else if (ts.isSwitchStatement(parent)) {
      const clause = parent.caseBlock.clauses.find((candidate) => isDescendantOf(write, candidate));
      if (clause) controlledRegion = clause;
    } else if (ts.isLabeledStatement(parent) && isDescendantOf(child, parent.statement)) {
      controlledRegion = parent.statement;
    } else if (ts.isTryStatement(parent)) {
      if (isDescendantOf(child, parent.tryBlock)) controlledRegion = parent.tryBlock;
      else if (parent.catchClause && isDescendantOf(child, parent.catchClause)) controlledRegion = parent.catchClause;
      else if (parent.finallyBlock && isDescendantOf(child, parent.finallyBlock)) {
        controlledRegion = parent.finallyBlock;
      }
    }
    if (controlledRegion && !isDescendantOf(use, controlledRegion)) return false;
    if (parent === scope) break;
    child = parent;
    parent = parent.parent;
  }
  return true;
}

function nearestNonDominatingIf(write: ts.Expression, use: ts.Node, scope: ts.Node): ts.IfStatement | undefined {
  let current: ts.Node | undefined = write.parent;
  while (current) {
    if (ts.isIfStatement(current)) {
      const branch = isDescendantOf(write, current.thenStatement)
        ? current.thenStatement
        : current.elseStatement && isDescendantOf(write, current.elseStatement)
          ? current.elseStatement
          : undefined;
      if (branch && !isDescendantOf(use, branch)) return current;
    }
    if (current === scope) break;
    current = current.parent;
  }
  return undefined;
}

function closureMutatesBinding(body: FunctionWithBody, binding: LexicalBinding, context: DataFlowContext): boolean {
  let mutated = false;
  function visit(node: ts.Node): void {
    if (mutated || (node !== body && isFunctionWithBody(node))) return;
    const target =
      ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind) && ts.isIdentifier(node.left)
        ? node.left
        : (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
            (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) &&
            ts.isIdentifier(node.operand)
          ? node.operand
          : undefined;
    if (target && resolveBinding(target, context) === binding) {
      mutated = true;
      return;
    }
    ts.forEachChild(node, visit);
  }
  if (body.body) visit(body.body);
  return mutated;
}

function closureReferencesBinding(body: FunctionWithBody, binding: LexicalBinding, context: DataFlowContext): boolean {
  let referenced = false;
  function visit(node: ts.Node): void {
    if (referenced) return;
    if (ts.isIdentifier(node) && resolveBinding(node, context) === binding) {
      referenced = true;
      return;
    }
    ts.forEachChild(node, visit);
  }
  if (body.body) visit(body.body);
  return referenced;
}

function bindingWasMutatedByClosure(
  binding: LexicalBinding,
  startPosition: number,
  endPosition: number,
  context: DataFlowContext
): boolean {
  return context.invokedClosures.some(
    (invocation) =>
      invocation.position > startPosition &&
      invocation.position < endPosition &&
      closureMutatesBinding(invocation.body, binding, context)
  );
}

function bindingWasReferencedByInvokedClosure(
  binding: LexicalBinding,
  startPosition: number,
  endPosition: number,
  context: DataFlowContext
): boolean {
  return context.invokedClosures.some(
    (invocation) =>
      invocation.position > startPosition &&
      invocation.position < endPosition &&
      closureReferencesBinding(invocation.body, binding, context)
  );
}

function bindingWasCapturedByClosureBetween(
  binding: LexicalBinding,
  startPosition: number,
  endPosition: number,
  context: DataFlowContext
): boolean {
  let captured = false;
  function visit(node: ts.Node): void {
    if (captured) return;
    if (node !== context.scope && isFunctionWithBody(node)) {
      if (
        node.getStart() > startPosition &&
        node.getStart() < endPosition &&
        closureReferencesBinding(node, binding, context)
      ) {
        captured = true;
      }
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(context.scope);
  return captured;
}

function localCallableWasInvokedBetween(startPosition: number, endPosition: number, context: DataFlowContext): boolean {
  return context.localInvocationPositions.some((position) => position > startPosition && position < endPosition);
}

function expressionReferencesParameter(
  node: ts.Expression,
  context: DataFlowContext,
  beforePosition: number,
  seenBindings: ReadonlySet<LexicalBinding>
): boolean {
  const expression = unwrapExpression(node);
  if (ts.isIdentifier(expression)) {
    const binding = resolveBinding(expression, context);
    if (!binding || seenBindings.has(binding)) return false;
    if (binding.parameter) return true;
    const write = binding.writes.find((candidate) => candidate.position < beforePosition);
    if (!write || !writeDominatesUse(write.value, expression, context.scope)) return false;
    const nextSeen = new Set(seenBindings);
    nextSeen.add(binding);
    return expressionReferencesParameter(write.value, context, write.position, nextSeen);
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return expressionReferencesParameter(expression.expression, context, beforePosition, seenBindings);
  }
  if (ts.isElementAccessExpression(expression)) {
    return expressionReferencesParameter(expression.expression, context, beforePosition, seenBindings);
  }
  if (ts.isCallExpression(expression)) {
    return expression.arguments.some((argument) =>
      expressionReferencesParameter(argument, context, beforePosition, seenBindings)
    );
  }
  if (ts.isConditionalExpression(expression)) {
    return (
      expressionReferencesParameter(expression.condition, context, beforePosition, seenBindings) ||
      expressionReferencesParameter(expression.whenTrue, context, beforePosition, seenBindings) ||
      expressionReferencesParameter(expression.whenFalse, context, beforePosition, seenBindings)
    );
  }
  if (ts.isBinaryExpression(expression)) {
    return (
      expressionReferencesParameter(expression.left, context, beforePosition, seenBindings) ||
      expressionReferencesParameter(expression.right, context, beforePosition, seenBindings)
    );
  }
  if (ts.isPrefixUnaryExpression(expression)) {
    return expressionReferencesParameter(expression.operand, context, beforePosition, seenBindings);
  }
  return false;
}

function explicitOptionFromFlag(
  node: ts.Expression,
  context: DataFlowContext,
  beforePosition: number,
  seenBindings: ReadonlySet<LexicalBinding> = new Set<LexicalBinding>()
): string | undefined {
  const expression = unwrapExpression(node);
  if (ts.isIdentifier(expression)) {
    const binding = resolveBinding(expression, context);
    if (!binding || seenBindings.has(binding)) return undefined;
    const write = binding.writes.find((candidate) => candidate.position < beforePosition);
    if (!write || !writeDominatesUse(write.value, expression, context.scope)) return undefined;
    const nextSeen = new Set(seenBindings);
    nextSeen.add(binding);
    return explicitOptionFromFlag(write.value, context, write.position, nextSeen);
  }
  if (!ts.isBinaryExpression(expression)) return undefined;
  const operator = expression.operatorToken.kind;
  if (operator !== ts.SyntaxKind.EqualsEqualsEqualsToken && operator !== ts.SyntaxKind.EqualsEqualsToken) {
    return undefined;
  }
  const leftCli = ts.isStringLiteralLike(expression.left) && expression.left.text === "cli";
  const rightCli = ts.isStringLiteralLike(expression.right) && expression.right.text === "cli";
  const call = leftCli ? expression.right : rightCli ? expression.left : undefined;
  if (
    !call ||
    !ts.isCallExpression(call) ||
    !ts.isPropertyAccessExpression(call.expression) ||
    call.expression.name.text !== "getOptionValueSource" ||
    !expressionReferencesParameter(call.expression.expression, context, beforePosition, seenBindings)
  ) {
    return undefined;
  }
  const option = call.arguments[0];
  return option && ts.isStringLiteralLike(option) ? option.text : undefined;
}

function isNegatedExplicitOverrideFlag(
  node: ts.Expression,
  context: DataFlowContext,
  expectedValue: ProvenanceKind,
  beforePosition: number,
  seenBindings: ReadonlySet<LexicalBinding>
): boolean {
  const expression = unwrapExpression(node);
  if (!ts.isPrefixUnaryExpression(expression) || expression.operator !== ts.SyntaxKind.ExclamationToken) {
    return false;
  }
  if (context.allowLegacyFixturePeeks && ts.isIdentifier(expression.operand)) {
    return resolveBinding(expression.operand, context)?.parameter === true;
  }
  const option = explicitOptionFromFlag(expression.operand, context, beforePosition, seenBindings);
  if (expectedValue === "quantization") return option === "quantizeEmbeddings";
  if (expectedValue === "embed-model" || expectedValue === "modelAlias" || expectedValue === "dim") {
    return option === "embeddingModel";
  }
  return false;
}

function isReviewedEmbedOverridePairGuard(
  node: ts.Expression,
  context: DataFlowContext,
  beforePosition: number,
  seenBindings: ReadonlySet<LexicalBinding>
): boolean {
  const expression = unwrapExpression(node);
  if (!ts.isPrefixUnaryExpression(expression) || expression.operator !== ts.SyntaxKind.ExclamationToken) {
    return false;
  }
  const operand = unwrapExpression(expression.operand);
  if (!ts.isBinaryExpression(operand) || operand.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken) {
    return false;
  }
  const options = [
    explicitOptionFromFlag(operand.left, context, beforePosition, seenBindings),
    explicitOptionFromFlag(operand.right, context, beforePosition, seenBindings)
  ];
  return options.includes("embeddingModel") && options.includes("quantizeEmbeddings");
}

function isReviewedFallback(
  node: ts.Expression,
  context: DataFlowContext,
  beforePosition: number,
  seenBindings: ReadonlySet<LexicalBinding>
): boolean {
  const expression = unwrapExpression(node);
  if (
    expression.kind === ts.SyntaxKind.NullKeyword ||
    expression.kind === ts.SyntaxKind.TrueKeyword ||
    expression.kind === ts.SyntaxKind.FalseKeyword ||
    ts.isStringLiteralLike(expression) ||
    ts.isNumericLiteral(expression)
  ) {
    return true;
  }
  if (ts.isIdentifier(expression)) {
    if (expression.text === "undefined" && !resolveBinding(expression, context)) return true;
    const binding = resolveBinding(expression, context);
    if (!binding || seenBindings.has(binding)) return false;
    if (binding.parameter) return true;
    const write = binding.writes.find((candidate) => candidate.position < beforePosition);
    if (!write || !writeDominatesUse(write.value, expression, context.scope)) return false;
    const nextSeen = new Set(seenBindings);
    nextSeen.add(binding);
    return isReviewedFallback(write.value, context, write.position, nextSeen);
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return isReviewedFallback(expression.expression, context, beforePosition, seenBindings);
  }
  if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)) {
    const callable = resolvedCallable(expression.expression, context);
    if (callable !== "assert-tokenize" && callable !== "parse-quantization" && callable !== "resolve-model") {
      return false;
    }
    return expression.arguments.every((argument) =>
      isReviewedFallback(argument, context, beforePosition, seenBindings)
    );
  }
  if (ts.isConditionalExpression(expression)) {
    return (
      isReviewedFallback(expression.whenTrue, context, beforePosition, seenBindings) &&
      isReviewedFallback(expression.whenFalse, context, beforePosition, seenBindings)
    );
  }
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
    return (
      isReviewedFallback(expression.left, context, beforePosition, seenBindings) &&
      isReviewedFallback(expression.right, context, beforePosition, seenBindings)
    );
  }
  return false;
}

function isReviewedExplicitConfiguration(
  node: ts.Expression,
  context: DataFlowContext,
  beforePosition: number,
  seenBindings: ReadonlySet<LexicalBinding>
): boolean {
  return (
    isReviewedFallback(node, context, beforePosition, seenBindings) &&
    expressionReferencesParameter(node, context, beforePosition, seenBindings)
  );
}

function provenanceFamily(value: ProvenanceKind): AuthorityKind {
  return value === "fts-discovery" || value === "fts-meta" || value === "tokenize" ? "fts" : "embed";
}

function expressionCarriesAnyAuthority(
  node: ts.Expression,
  context: DataFlowContext,
  authority: AuthorityKind,
  beforePosition: number,
  seenBindings: ReadonlySet<LexicalBinding>
): boolean {
  const candidates: ProvenanceKind[] =
    authority === "fts"
      ? ["fts-discovery", "fts-meta", "tokenize"]
      : [
          "embed-discovery",
          "embed-meta",
          "embed-config",
          "embed-model",
          "stored-model-alias",
          "modelAlias",
          "dim",
          "quantization"
        ];
  return candidates.some((candidate) =>
    expressionCarriesConfiguredValue(node, context, candidate, beforePosition, seenBindings)
  );
}

function conditionContainsOwnedDiscriminant(
  node: ts.Expression,
  context: DataFlowContext,
  expectedAuthority: AuthorityKind,
  beforePosition: number,
  seenBindings: ReadonlySet<LexicalBinding>
): boolean {
  const expression = unwrapExpression(node);
  if (!ts.isBinaryExpression(expression)) return false;
  const operator = expression.operatorToken.kind;
  if (operator !== ts.SyntaxKind.EqualsEqualsEqualsToken && operator !== ts.SyntaxKind.EqualsEqualsToken) {
    return false;
  }
  const leftOwned = ts.isStringLiteralLike(expression.left) && expression.left.text === "owned";
  const rightOwned = ts.isStringLiteralLike(expression.right) && expression.right.text === "owned";
  const discriminant = leftOwned ? expression.right : rightOwned ? expression.left : undefined;
  const discriminantPath =
    discriminant && ts.isPropertyAccessExpression(discriminant)
      ? canonicalAccessPath(discriminant, context)
      : undefined;
  return (
    discriminant !== undefined &&
    ts.isPropertyAccessExpression(discriminant) &&
    discriminant.name.text === "kind" &&
    (!discriminantPath ||
      !pathWasMutatedBetween(discriminantPath, discriminantPath.originPosition, discriminant.getStart(), context)) &&
    expressionCarriesConfiguredValue(
      discriminant.expression,
      context,
      expectedAuthority === "embed" ? "embed-discovery" : "fts-discovery",
      beforePosition,
      seenBindings
    )
  );
}

function conditionIsReviewedOwnedSelection(
  node: ts.Expression,
  context: DataFlowContext,
  expectedValue: ProvenanceKind,
  beforePosition: number,
  seenBindings: ReadonlySet<LexicalBinding>
): boolean {
  const authority = provenanceFamily(expectedValue);
  if (conditionContainsOwnedDiscriminant(node, context, authority, beforePosition, seenBindings)) return true;
  const expression = unwrapExpression(node);
  if (
    expectedValue !== "embed-config" ||
    !ts.isBinaryExpression(expression) ||
    expression.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken
  ) {
    return false;
  }
  return (
    (conditionContainsOwnedDiscriminant(expression.left, context, authority, beforePosition, seenBindings) &&
      isReviewedEmbedOverridePairGuard(expression.right, context, beforePosition, seenBindings)) ||
    (conditionContainsOwnedDiscriminant(expression.right, context, authority, beforePosition, seenBindings) &&
      isReviewedEmbedOverridePairGuard(expression.left, context, beforePosition, seenBindings))
  );
}

function andOperands(node: ts.Expression): ts.Expression[] {
  const expression = unwrapExpression(node);
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    return [...andOperands(expression.left), ...andOperands(expression.right)];
  }
  return [expression];
}

function isPositiveAuthorityPredicate(
  node: ts.Expression,
  context: DataFlowContext,
  expectedValue: ProvenanceKind,
  beforePosition: number,
  seenBindings: ReadonlySet<LexicalBinding>
): boolean {
  return (
    conditionContainsOwnedDiscriminant(node, context, provenanceFamily(expectedValue), beforePosition, seenBindings) ||
    expressionCarriesAnyAuthority(node, context, provenanceFamily(expectedValue), beforePosition, seenBindings)
  );
}

function isReviewedAuthorityComparison(
  node: ts.Expression,
  context: DataFlowContext,
  expectedValue: ProvenanceKind,
  beforePosition: number,
  seenBindings: ReadonlySet<LexicalBinding>
): boolean {
  const expression = unwrapExpression(node);
  if (!ts.isBinaryExpression(expression)) return false;
  const operator = expression.operatorToken.kind;
  if (operator !== ts.SyntaxKind.ExclamationEqualsEqualsToken && operator !== ts.SyntaxKind.ExclamationEqualsToken) {
    return false;
  }
  if (expectedValue !== "quantization") return false;
  return (
    (expressionCarriesAnyAuthority(
      expression.left,
      context,
      provenanceFamily(expectedValue),
      beforePosition,
      seenBindings
    ) &&
      isReviewedExplicitConfiguration(expression.right, context, beforePosition, seenBindings)) ||
    (expressionCarriesAnyAuthority(
      expression.right,
      context,
      provenanceFamily(expectedValue),
      beforePosition,
      seenBindings
    ) &&
      isReviewedExplicitConfiguration(expression.left, context, beforePosition, seenBindings))
  );
}

function conditionRequiresAuthorityAndNoExplicitOverride(
  node: ts.Expression,
  context: DataFlowContext,
  expectedValue: ProvenanceKind,
  beforePosition: number,
  seenBindings: ReadonlySet<LexicalBinding>
): boolean {
  let hasAuthority = false;
  let hasNoExplicitOverride = false;
  for (const operand of andOperands(node)) {
    if (isPositiveAuthorityPredicate(operand, context, expectedValue, beforePosition, seenBindings)) {
      hasAuthority = true;
      continue;
    }
    if (isNegatedExplicitOverrideFlag(operand, context, expectedValue, beforePosition, seenBindings)) {
      hasNoExplicitOverride = true;
      continue;
    }
    if (isReviewedAuthorityComparison(operand, context, expectedValue, beforePosition, seenBindings)) {
      continue;
    }
    return false;
  }
  return hasAuthority && hasNoExplicitOverride;
}

function ifBranchContaining(statement: ts.IfStatement, node: ts.Node): "else" | "then" | undefined {
  if (isDescendantOf(node, statement.thenStatement)) return "then";
  if (statement.elseStatement && isDescendantOf(node, statement.elseStatement)) return "else";
  return undefined;
}

function conditionSelectsExplicitValue(
  node: ts.Expression,
  explicitValue: ts.Expression,
  explicitBranch: "else" | "then",
  context: DataFlowContext
): boolean {
  const expression = unwrapExpression(node);
  if (!ts.isBinaryExpression(expression)) return false;
  const operator = expression.operatorToken.kind;
  const isEquality = operator === ts.SyntaxKind.EqualsEqualsEqualsToken || operator === ts.SyntaxKind.EqualsEqualsToken;
  const isInequality =
    operator === ts.SyntaxKind.ExclamationEqualsEqualsToken || operator === ts.SyntaxKind.ExclamationEqualsToken;
  if (!isEquality && !isInequality) return false;
  const leftUndefined = ts.isIdentifier(expression.left) && expression.left.text === "undefined";
  const rightUndefined = ts.isIdentifier(expression.right) && expression.right.text === "undefined";
  const candidate = leftUndefined ? expression.right : rightUndefined ? expression.left : undefined;
  if (!candidate || !sameLexicalValue(candidate, explicitValue, context)) return false;
  const presentBranch = isInequality ? "then" : "else";
  return explicitBranch === presentBranch;
}

function controlSelectsAuthoritativeWrite(
  statement: ts.IfStatement,
  authoritativeWrite: ts.Expression,
  explicitWrite: ts.Expression,
  context: DataFlowContext,
  expectedValue: ProvenanceKind,
  beforePosition: number,
  seenBindings: ReadonlySet<LexicalBinding>
): boolean {
  const authoritativeBranch = ifBranchContaining(statement, authoritativeWrite);
  const explicitBranch = ifBranchContaining(statement, explicitWrite);
  if (authoritativeBranch && explicitBranch && authoritativeBranch !== explicitBranch) {
    return conditionSelectsExplicitValue(statement.expression, explicitWrite, explicitBranch, context);
  }
  if (authoritativeBranch === "then" && explicitBranch === undefined) {
    return conditionRequiresAuthorityAndNoExplicitOverride(
      statement.expression,
      context,
      expectedValue,
      beforePosition,
      seenBindings
    );
  }
  return false;
}

function nullBranchCannotReachConstructor(
  condition: ts.Expression,
  nullWhenTrue: boolean,
  conditional: ts.ConditionalExpression,
  context: DataFlowContext
): boolean {
  let guarded = false;
  function visit(node: ts.Node): void {
    if (guarded || (node !== context.scope && isFunctionWithBody(node))) return;
    if (
      ts.isIfStatement(node) &&
      node.getStart() > conditional.getStart() &&
      node.getStart() < context.constructorPosition &&
      sameLexicalValue(node.expression, condition, context) &&
      writeDominatesUse(node.expression, context.constructorFile, context.scope)
    ) {
      const exitingBranch = nullWhenTrue ? node.thenStatement : node.elseStatement;
      if (exitingBranch && statementDefinitelyExits(exitingBranch)) {
        guarded = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(context.scope);
  return guarded;
}

/**
 * Trace a configuration value only through exact bindings, exact imported
 * callables, matching file/root discovery, and reviewed selection grammar.
 */
function expressionCarriesConfiguredValue(
  node: ts.Expression,
  context: DataFlowContext,
  expectedValue: ProvenanceKind,
  beforePosition = context.constructorPosition,
  seenBindings: ReadonlySet<LexicalBinding> = new Set<LexicalBinding>()
): boolean {
  const expression = unwrapExpression(node);
  if (ts.isIdentifier(expression)) {
    const binding = resolveBinding(expression, context);
    if (!binding || seenBindings.has(binding)) return false;
    const writes = binding.writes.filter((candidate) => candidate.position < beforePosition);
    const write = writes[0];
    if (!write) return false;
    if (localCallableWasInvokedBetween(write.position, expression.getStart(), context)) return false;
    if (bindingWasCapturedByClosureBetween(binding, write.position, expression.getStart(), context)) {
      return false;
    }
    if (bindingWasMutatedByClosure(binding, write.position, expression.getStart(), context)) return false;
    const nextSeen = new Set(seenBindings);
    nextSeen.add(binding);
    if (writeDominatesUse(write.value, expression, context.scope)) {
      return expressionCarriesConfiguredValue(write.value, context, expectedValue, write.position, nextSeen);
    }
    const control = nearestNonDominatingIf(write.value, expression, context.scope);
    const previous = writes[1];
    if (!control || !previous) return false;
    const authoritativeWrite = expressionCarriesConfiguredValue(
      write.value,
      context,
      expectedValue,
      write.position,
      nextSeen
    );
    const previousAuthority = expressionCarriesConfiguredValue(
      previous.value,
      context,
      expectedValue,
      previous.position,
      nextSeen
    );
    if (!authoritativeWrite) return false;
    if (previousAuthority) return true;
    if (!isReviewedExplicitConfiguration(previous.value, context, previous.position, nextSeen)) return false;
    return controlSelectsAuthoritativeWrite(
      control,
      write.value,
      previous.value,
      context,
      expectedValue,
      write.position,
      nextSeen
    );
  }
  if (ts.isCallExpression(expression)) {
    if (directDiscoveryCarriesAuthority(expression, context, expectedValue)) return true;
    if (!ts.isIdentifier(expression.expression)) return false;
    const callable = resolvedCallable(expression.expression, context);
    if (callable === "resolve-stored-embedding" && expectedValue === "embed-config") {
      return expression.arguments.some((argument) =>
        expressionCarriesConfiguredValue(argument, context, "embed-meta", beforePosition, seenBindings)
      );
    }
    if (callable === "resolve-model" && expectedValue === "embed-model") {
      return expression.arguments.some(
        (argument) =>
          expressionCarriesConfiguredValue(argument, context, "stored-model-alias", beforePosition, seenBindings) ||
          expressionCarriesConfiguredValue(argument, context, "modelAlias", beforePosition, seenBindings)
      );
    }
    return false;
  }
  if (ts.isPropertyAccessExpression(expression)) {
    const access = canonicalAccessPath(expression, context);
    if (
      access &&
      (localCallableWasInvokedBetween(access.originPosition, expression.getStart(), context) ||
        (typeof access.root !== "string" &&
          bindingWasCapturedByClosureBetween(access.root, access.originPosition, expression.getStart(), context)) ||
        pathWasMutatedBetween(access, access.originPosition, expression.getStart(), context))
    ) {
      return false;
    }
    const property = expression.name.text;
    const parentValue: ProvenanceKind | undefined =
      expectedValue === "embed-meta" && property === "meta"
        ? "embed-discovery"
        : expectedValue === "fts-meta" && property === "meta"
          ? "fts-discovery"
          : expectedValue === "embed-model" && property === "model"
            ? "embed-config"
            : expectedValue === "stored-model-alias" && property === "model_alias"
              ? "embed-meta"
              : expectedValue === "modelAlias" && property === "alias"
                ? "embed-model"
                : expectedValue === "dim" && property === "dim"
                  ? "embed-model"
                  : expectedValue === "quantization" && property === "quantization"
                    ? "embed-config"
                    : expectedValue === "tokenize" && property === "tokenize_mode"
                      ? "fts-meta"
                      : undefined;
    return (
      parentValue !== undefined &&
      expressionCarriesConfiguredValue(expression.expression, context, parentValue, beforePosition, seenBindings)
    );
  }
  if (ts.isConditionalExpression(expression)) {
    const condition = staticBoolean(expression.condition);
    if (condition === true) {
      return expressionCarriesConfiguredValue(
        expression.whenTrue,
        context,
        expectedValue,
        beforePosition,
        seenBindings
      );
    }
    if (condition === false) {
      return expressionCarriesConfiguredValue(
        expression.whenFalse,
        context,
        expectedValue,
        beforePosition,
        seenBindings
      );
    }
    const whenTrue = expressionCarriesConfiguredValue(
      expression.whenTrue,
      context,
      expectedValue,
      beforePosition,
      seenBindings
    );
    const whenFalse = expressionCarriesConfiguredValue(
      expression.whenFalse,
      context,
      expectedValue,
      beforePosition,
      seenBindings
    );
    if (whenTrue && whenFalse) return true;
    if (whenTrue) {
      if (staticNullish(expression.whenFalse) === true) {
        return conditionIsReviewedOwnedSelection(
          expression.condition,
          context,
          expectedValue,
          beforePosition,
          seenBindings
        );
      }
      return (
        conditionIsReviewedOwnedSelection(expression.condition, context, expectedValue, beforePosition, seenBindings) &&
        isReviewedFallback(expression.whenFalse, context, beforePosition, seenBindings)
      );
    }
    if (
      whenFalse &&
      staticNullish(expression.whenTrue) === true &&
      (expectedValue === "embed-discovery" || expectedValue === "fts-discovery")
    ) {
      return nullBranchCannotReachConstructor(expression.condition, true, expression, context);
    }
    return false;
  }
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
    const leftNullish = staticNullish(expression.left);
    if (leftNullish === false) {
      return expressionCarriesConfiguredValue(expression.left, context, expectedValue, beforePosition, seenBindings);
    }
    if (leftNullish === true) {
      return expressionCarriesConfiguredValue(expression.right, context, expectedValue, beforePosition, seenBindings);
    }
    const left = expressionCarriesConfiguredValue(
      expression.left,
      context,
      expectedValue,
      beforePosition,
      seenBindings
    );
    const right = expressionCarriesConfiguredValue(
      expression.right,
      context,
      expectedValue,
      beforePosition,
      seenBindings
    );
    return (
      (left && (right || isReviewedFallback(expression.right, context, beforePosition, seenBindings))) ||
      (right && isReviewedExplicitConfiguration(expression.left, context, beforePosition, seenBindings))
    );
  }
  // Logical/comparison/arithmetic operators, element lookup, arbitrary calls,
  // objects, arrays, templates, and function values are not authority-preserving.
  return false;
}

/**
 * Check whether a `// SAFE BY DESIGN` line-comment appears within
 * `SAFE_LOOKBACK_LINES` lines above the constructor line. Anchored regex
 * defeats false positives from prose mentioning the phrase to NEGATE it.
 */
function hasSafeComment(sourceFile: ts.SourceFile, sourceText: string, constructorNode: ts.NewExpression): boolean {
  let statement: ts.Node = constructorNode;
  while (
    statement.parent &&
    !ts.isBlock(statement.parent) &&
    !ts.isSourceFile(statement.parent) &&
    !ts.isCaseBlock(statement.parent)
  ) {
    statement = statement.parent;
  }
  const ctorLine = sourceFile.getLineAndCharacterOfPosition(constructorNode.getStart(sourceFile)).line;
  const comments = ts.getLeadingCommentRanges(sourceText, statement.getFullStart()) ?? [];
  return comments.some((comment) => {
    if (comment.kind !== ts.SyntaxKind.SingleLineCommentTrivia) return false;
    const commentText = sourceText.slice(comment.pos, comment.end);
    const commentLine = sourceFile.getLineAndCharacterOfPosition(comment.pos).line;
    return ctorLine - commentLine <= SAFE_LOOKBACK_LINES && SAFE_MARKER_RE.test(commentText);
  });
}

function isReviewedSafeClearOnlySite(filePath: string, constructorNode: ts.NewExpression): boolean {
  const normalized = filePath.replaceAll("\\", "/");
  if (normalized !== "src/cli.ts" && !normalized.endsWith("/src/cli.ts")) return false;
  const declaration = constructorNode.parent;
  if (!ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) return false;
  let statement: ts.Node = declaration;
  while (statement.parent && !ts.isBlock(statement.parent) && !ts.isSourceFile(statement.parent)) {
    statement = statement.parent;
  }
  const parent = statement.parent;
  if (!parent || (!ts.isBlock(parent) && !ts.isSourceFile(parent))) return false;
  const index = parent.statements.indexOf(statement as ts.Statement);
  const next = index >= 0 ? parent.statements[index + 1] : undefined;
  if (!next) return false;
  let exactClearCall = false;
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "clearOnDisk" &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === declaration.name.text
    ) {
      exactClearCall = true;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(next);
  return exactClearCall;
}

function optionPropertyName(
  prop: ts.PropertyAssignment | ts.ShorthandPropertyAssignment,
  sourceFile: ts.SourceFile
): string {
  if (ts.isShorthandPropertyAssignment(prop)) return prop.name.text;
  if (ts.isIdentifier(prop.name) || ts.isStringLiteralLike(prop.name) || ts.isNumericLiteral(prop.name)) {
    return prop.name.text;
  }
  return prop.name.getText(sourceFile);
}

function expressionDirectlyContainsDiscoveryCall(
  node: ts.Expression,
  context: DataFlowContext,
  authority: AuthorityKind
): boolean {
  const expression = unwrapExpression(node);
  if (ts.isCallExpression(expression)) {
    return directDiscoveryCarriesAuthority(
      expression,
      context,
      authority === "embed" ? "embed-discovery" : "fts-discovery"
    );
  }
  if (ts.isConditionalExpression(expression)) {
    return (
      expressionDirectlyContainsDiscoveryCall(expression.whenTrue, context, authority) ||
      expressionDirectlyContainsDiscoveryCall(expression.whenFalse, context, authority)
    );
  }
  return false;
}

function collectDiscoveryBindings(
  node: ts.Expression,
  context: DataFlowContext,
  authority: AuthorityKind,
  beforePosition = context.constructorPosition,
  seenBindings: ReadonlySet<LexicalBinding> = new Set<LexicalBinding>(),
  out = new Set<LexicalBinding>()
): Set<LexicalBinding> {
  const expression = unwrapExpression(node);
  if (ts.isIdentifier(expression)) {
    const binding = resolveBinding(expression, context);
    if (!binding || seenBindings.has(binding)) return out;
    const writes = binding.writes.filter((candidate) => candidate.position < beforePosition);
    if (writes.some((write) => expressionDirectlyContainsDiscoveryCall(write.value, context, authority))) {
      out.add(binding);
    }
    const nextSeen = new Set(seenBindings);
    nextSeen.add(binding);
    for (const write of writes) {
      collectDiscoveryBindings(write.value, context, authority, write.position, nextSeen, out);
    }
    return out;
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return collectDiscoveryBindings(expression.expression, context, authority, beforePosition, seenBindings, out);
  }
  if (ts.isElementAccessExpression(expression)) {
    collectDiscoveryBindings(expression.expression, context, authority, beforePosition, seenBindings, out);
    if (expression.argumentExpression) {
      collectDiscoveryBindings(expression.argumentExpression, context, authority, beforePosition, seenBindings, out);
    }
    return out;
  }
  if (ts.isCallExpression(expression)) {
    for (const argument of expression.arguments) {
      collectDiscoveryBindings(argument, context, authority, beforePosition, seenBindings, out);
    }
    return out;
  }
  if (ts.isConditionalExpression(expression)) {
    collectDiscoveryBindings(expression.condition, context, authority, beforePosition, seenBindings, out);
    collectDiscoveryBindings(expression.whenTrue, context, authority, beforePosition, seenBindings, out);
    collectDiscoveryBindings(expression.whenFalse, context, authority, beforePosition, seenBindings, out);
    return out;
  }
  if (ts.isBinaryExpression(expression)) {
    collectDiscoveryBindings(expression.left, context, authority, beforePosition, seenBindings, out);
    collectDiscoveryBindings(expression.right, context, authority, beforePosition, seenBindings, out);
    return out;
  }
  if (ts.isPrefixUnaryExpression(expression)) {
    return collectDiscoveryBindings(expression.operand, context, authority, beforePosition, seenBindings, out);
  }
  return out;
}

function constructorInstanceBinding(
  constructorNode: ts.NewExpression,
  context: DataFlowContext
): LexicalBinding | undefined {
  const parent = constructorNode.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name) && parent.initializer === constructorNode) {
    return resolveBinding(parent.name, context);
  }
  if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    parent.right === constructorNode &&
    ts.isIdentifier(parent.left)
  ) {
    return resolveBinding(parent.left, context);
  }
  return undefined;
}

function isAwaitedCall(call: ts.CallExpression): boolean {
  let current: ts.Node = call;
  let parent = call.parent;
  while (
    parent &&
    (ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isTypeAssertionExpression(parent) ||
      ts.isNonNullExpression(parent))
  ) {
    current = parent;
    parent = parent.parent;
  }
  return parent !== undefined && ts.isAwaitExpression(parent) && parent.expression === current;
}

function openControlDominatesConstructor(
  call: ts.CallExpression,
  constructorNode: ts.NewExpression,
  scope: ts.Node
): boolean {
  if (!isSyntacticallyReachable(call, scope)) return false;
  let child: ts.Node = call;
  let parent: ts.Node | undefined = call.parent;
  while (parent) {
    let controlledRegion: ts.Node | undefined;
    if (ts.isIfStatement(parent)) {
      if (isDescendantOf(child, parent.thenStatement)) controlledRegion = parent.thenStatement;
      else if (parent.elseStatement && isDescendantOf(child, parent.elseStatement)) {
        controlledRegion = parent.elseStatement;
      }
    } else if (
      ts.isWhileStatement(parent) ||
      ts.isDoStatement(parent) ||
      ts.isForStatement(parent) ||
      ts.isForInStatement(parent) ||
      ts.isForOfStatement(parent)
    ) {
      if (isDescendantOf(child, parent.statement)) controlledRegion = parent.statement;
    } else if (ts.isConditionalExpression(parent)) {
      if (isDescendantOf(child, parent.whenTrue)) controlledRegion = parent.whenTrue;
      else if (isDescendantOf(child, parent.whenFalse)) controlledRegion = parent.whenFalse;
    } else if (ts.isSwitchStatement(parent)) {
      controlledRegion = parent.caseBlock.clauses.find((candidate) => isDescendantOf(call, candidate));
    } else if (ts.isLabeledStatement(parent) && isDescendantOf(child, parent.statement)) {
      controlledRegion = parent.statement;
    } else if (
      ts.isBinaryExpression(parent) &&
      isDescendantOf(child, parent.right) &&
      (parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        parent.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
    ) {
      controlledRegion = parent.right;
    } else if (ts.isTryStatement(parent) && parent.catchClause && isDescendantOf(child, parent.catchClause)) {
      controlledRegion = parent.catchClause;
    }
    if (controlledRegion && !isDescendantOf(constructorNode, controlledRegion)) return false;
    if (parent === scope) break;
    child = parent;
    parent = parent.parent;
  }
  return true;
}

function catchInvalidatesInstance(clause: ts.CatchClause, instance: LexicalBinding, context: DataFlowContext): boolean {
  if (statementDefinitelyThrows(clause.block)) return true;
  const end = clause.block.statements.at(-1) ?? clause.block;
  let invalidated = false;
  function visit(node: ts.Node): void {
    if (invalidated || (node !== clause.block && isFunctionWithBody(node))) return;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      resolveBinding(node.left, context) === instance &&
      (node.right.kind === ts.SyntaxKind.NullKeyword ||
        (ts.isIdentifier(node.right) && node.right.text === "undefined")) &&
      writeDominatesUse(node.right, end, clause.block)
    ) {
      invalidated = true;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(clause.block);
  return invalidated;
}

function constructorBindingIsConfinedToTry(constructorNode: ts.NewExpression, statement: ts.TryStatement): boolean {
  const declaration = constructorNode.parent;
  if (
    !ts.isVariableDeclaration(declaration) ||
    declaration.initializer !== constructorNode ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.BlockScoped) === 0
  ) {
    return false;
  }
  return isDescendantOf(declaration, statement.tryBlock);
}

function openTryCatchesAreSafe(
  call: ts.CallExpression,
  constructorNode: ts.NewExpression,
  instance: LexicalBinding,
  context: DataFlowContext
): boolean {
  let current: ts.Node | undefined = call;
  while (current && current !== context.scope) {
    const parent = current.parent;
    if (
      parent &&
      ts.isTryStatement(parent) &&
      isDescendantOf(call, parent.tryBlock) &&
      parent.catchClause &&
      !constructorBindingIsConfinedToTry(constructorNode, parent) &&
      !catchInvalidatesInstance(parent.catchClause, instance, context)
    ) {
      return false;
    }
    current = parent;
  }
  return true;
}

function accessOrDescendantWasMutatedBetween(
  access: CanonicalAccessPath,
  startPosition: number,
  endPosition: number,
  context: DataFlowContext
): boolean {
  const overlaps = (mutation: CanonicalAccessPath): boolean =>
    mutation.root === access.root &&
    mutation.originPosition === access.originPosition &&
    access.segments.every((segment, index) => segment === mutation.segments[index]);
  for (const mutation of context.propertyMutations) {
    if (mutation.position <= startPosition || mutation.position >= endPosition) continue;
    const mutatedPath = canonicalAccessPath(mutation.target, context, mutation.position);
    if (mutatedPath && overlaps(mutatedPath)) return true;
  }
  for (const invocation of context.invokedClosures) {
    if (invocation.position <= startPosition || invocation.position >= endPosition) continue;
    for (const target of closurePropertyTargets(invocation.body)) {
      const mutatedPath = canonicalAccessPath(target, context, invocation.position);
      if (mutatedPath && overlaps(mutatedPath)) return true;
    }
  }
  return false;
}

function openUsesSameDiscovery(
  constructorNode: ts.NewExpression,
  context: DataFlowContext,
  options: ReadonlyMap<string, ts.Expression>,
  authority: AuthorityKind
): boolean {
  const instance = constructorInstanceBinding(constructorNode, context);
  if (!instance) return false;
  let sharedDiscovery: Set<LexicalBinding> | undefined;
  for (const [name, value] of options) {
    if (!K1_ARG_NAMES.has(name)) continue;
    const sources = collectDiscoveryBindings(value, context, authority);
    sharedDiscovery =
      sharedDiscovery === undefined ? sources : new Set([...sharedDiscovery].filter((binding) => sources.has(binding)));
  }
  if (sharedDiscovery?.size !== 1) return false;
  const expectedDiscovery = [...sharedDiscovery][0];
  if (!expectedDiscovery) return false;

  let firstUsePosition = Number.POSITIVE_INFINITY;
  function visitUses(node: ts.Node): void {
    if (node !== context.scope && isFunctionWithBody(node)) return;
    if (
      ts.isIdentifier(node) &&
      node.getStart() > constructorNode.getStart() &&
      resolveBinding(node, context) === instance
    ) {
      firstUsePosition = Math.min(firstUsePosition, node.getStart());
    }
    ts.forEachChild(node, visitUses);
  }
  visitUses(context.scope);

  let matchedOpen = false;
  function visitOpen(node: ts.Node): void {
    if (node !== context.scope && isFunctionWithBody(node)) return;
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "open" &&
      ts.isIdentifier(node.expression.expression) &&
      resolveBinding(node.expression.expression, context) === instance &&
      node.expression.expression.getStart() === firstUsePosition &&
      isAwaitedCall(node) &&
      openControlDominatesConstructor(node, constructorNode, context.scope) &&
      openTryCatchesAreSafe(node, constructorNode, instance, context)
    ) {
      const argument = node.arguments[0];
      const exactArgument = argument ? unwrapExpression(argument) : undefined;
      const configuredWrite = expectedDiscovery.writes.find(
        (candidate) => candidate.position < constructorNode.getStart()
      );
      const openedWrite = expectedDiscovery.writes.find(
        (candidate) => candidate.position < (exactArgument?.getStart() ?? 0)
      );
      const discoveryPath = exactArgument ? canonicalAccessPath(exactArgument, context) : undefined;
      matchedOpen =
        exactArgument !== undefined &&
        ts.isIdentifier(exactArgument) &&
        resolveBinding(exactArgument, context) === expectedDiscovery &&
        configuredWrite !== undefined &&
        openedWrite === configuredWrite &&
        !localCallableWasInvokedBetween(constructorNode.getStart(), node.getStart(), context) &&
        !bindingWasCapturedByClosureBetween(instance, constructorNode.getStart(), node.getStart(), context) &&
        !bindingWasReferencedByInvokedClosure(instance, constructorNode.getStart(), node.getStart(), context) &&
        !bindingWasMutatedByClosure(expectedDiscovery, constructorNode.getStart(), exactArgument.getStart(), context) &&
        (!discoveryPath ||
          !accessOrDescendantWasMutatedBetween(
            discoveryPath,
            constructorNode.getStart(),
            exactArgument.getStart(),
            context
          ));
    }
    ts.forEachChild(node, visitOpen);
  }
  visitOpen(context.scope);
  return matchedOpen;
}

/**
 * Analyze a single TypeScript source file for K-1 invariant violations.
 * Returns an array of unguarded sites (empty if all constructors are OK).
 */
function analyzeSource(
  filePath: string,
  text: string,
  allowLegacyFixturePeeks = false,
  enforceProductionPins = false
): UnguardedSite[] {
  const sourceFile = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true);
  if (enforceProductionPins) {
    const relativePath = productionRelativePath(filePath);
    if (relativePath === "src" || relativePath.startsWith("src/")) {
      const pin = PRODUCTION_FILE_PINS[relativePath];
      if (pin) return analyzePinnedProductionSource(filePath, text, sourceFile, pin);
      return hasUnpinnedK1Surface(sourceFile)
        ? productionPinViolation(
            filePath,
            "K-1 constructor/discovery/import appeared outside the exact pinned production inventory"
          )
        : [];
    }
  }
  const unguarded: UnguardedSite[] = [];

  function visit(node: ts.Node): void {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && CONSTRUCTORS.has(node.expression.text)) {
      const className = node.expression.text;
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      const ctorLine = line + 1; // 1-based for reporting

      // 1. SAFE BY DESIGN escape hatch?
      if (
        hasSafeComment(sourceFile, text, node) &&
        (allowLegacyFixturePeeks || isReviewedSafeClearOnlySite(filePath, node))
      ) {
        // Guarded.
        ts.forEachChild(node, visit);
        return;
      }

      // 2. Inspect the first argument (must be ObjectLiteralExpression).
      const arg0 = node.arguments?.[0];
      if (!arg0 || !ts.isObjectLiteralExpression(arg0)) {
        unguarded.push({
          file: filePath,
          line: ctorLine,
          className,
          reason:
            "constructor's first argument is not an object literal; " +
            "AST analyzer requires the canonical options-object shape"
        });
        ts.forEachChild(node, visit);
        return;
      }

      if (arg0.properties.some((property) => ts.isSpreadAssignment(property))) {
        unguarded.push({
          file: filePath,
          line: ctorLine,
          className,
          reason: "constructor options contain a spread that can add or override K-1 authority fields"
        });
        ts.forEachChild(node, visit);
        return;
      }

      const options = new Map<string, ts.Expression>();
      for (const prop of arg0.properties) {
        if (!ts.isPropertyAssignment(prop) && !ts.isShorthandPropertyAssignment(prop)) continue;
        const propName = optionPropertyName(prop, sourceFile);
        const initializer = ts.isShorthandPropertyAssignment(prop) ? prop.name : prop.initializer;
        options.set(propName, initializer);
      }

      const requiredK1 =
        className === "EmbedDb"
          ? allowLegacyFixturePeeks
            ? ["modelAlias", "dim"]
            : ["modelAlias", "dim", "quantization"]
          : ["tokenize"];
      const missingK1 = requiredK1.filter((name) => !options.has(name));
      const constructorFile = options.get("file");
      const constructorRoot = options.get("vaultRoot");
      if (missingK1.length > 0 || !constructorFile || !constructorRoot) {
        const missingBoundary = [
          ...missingK1,
          ...(constructorFile ? [] : ["file"]),
          ...(constructorRoot ? [] : ["vaultRoot"])
        ];
        unguarded.push({
          file: filePath,
          line: ctorLine,
          className,
          reason: `constructor options are missing required complete-authority fields: ${missingBoundary.join(", ")}`
        });
        ts.forEachChild(node, visit);
        return;
      }

      // 3. Build a constructor-position-bounded lexical def-use index. Nested
      //    functions and later writes cannot lend authority to this site.
      const scope = enclosingScope(node);
      const dataFlow = createDataFlowContext(
        sourceFile,
        scope,
        node.getStart(sourceFile),
        constructorFile,
        constructorRoot,
        allowLegacyFixturePeeks
      );

      // 4. Every K-1-relevant property present in the options object must be
      //    authority-derived. One good field cannot launder a hard-coded
      //    sibling field (for example, derived model/dim plus fixed quantization).
      const underivedArgs: string[] = [];
      for (const [name, initializer] of options) {
        if (!K1_ARG_NAMES.has(name)) continue;
        const expectedValue = name as ProvenanceKind;
        if (!expressionCarriesConfiguredValue(initializer, dataFlow, expectedValue)) {
          underivedArgs.push(name);
        }
      }

      if (underivedArgs.length > 0) {
        unguarded.push({
          file: filePath,
          line: ctorLine,
          className,
          reason:
            "K-1 args do not all trace back to a configuration-discovery result " +
            `(underived: ${underivedArgs.join(", ")})`
        });
        return;
      }

      if (
        !allowLegacyFixturePeeks &&
        !openUsesSameDiscovery(node, dataFlow, options, className === "EmbedDb" ? "embed" : "fts")
      ) {
        unguarded.push({
          file: filePath,
          line: ctorLine,
          className,
          reason:
            "constructor fields and first awaited open() do not use the same exact configuration-discovery binding"
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return unguarded;
}

async function analyzeFile(filePath: string, allowLegacyFixturePeeks = false): Promise<UnguardedSite[]> {
  return analyzeSource(filePath, await fs.readFile(filePath, "utf8"), allowLegacyFixturePeeks, true);
}

function isTsImplementationFile(name: string): boolean {
  return /\.(?:ts|tsx|mts|cts)$/.test(name) && !/\.d\.(?:ts|mts|cts)$/.test(name);
}

/** Recursively collect every TypeScript implementation source extension. */
async function collectTs(root: string): Promise<string[]> {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur) continue;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name.startsWith(".")) continue;
        stack.push(path.join(cur, e.name));
        continue;
      }
      if (!e.isFile()) continue;
      if (!isTsImplementationFile(e.name)) continue;
      out.push(path.join(cur, e.name));
    }
  }
  return out;
}

describe("K-1 AST invariant (v3.7.0 M-2 — strengthens v3.6.4 grep-based guard)", () => {
  const FIXTURE_DIR = path.join(process.cwd(), "tests", "fixtures", "k1-invariant");

  it("POSITIVE: classic AST guard + native emit split is live; good.ts has 0 unguarded sites", async () => {
    expect(ts.versionMajorMinor, "K-1 and TypeDoc require the classic Compiler API").toBe("6.0");
    const pkg = JSON.parse(await fs.readFile(path.join(process.cwd(), "package.json"), "utf8")) as ToolchainPackage;
    expect(toolchainProblems(pkg)).toEqual([]);

    const unguarded = await analyzeFile(path.join(FIXTURE_DIR, "good.ts"), true);
    if (unguarded.length > 0) {
      const detail = unguarded.map((u) => `  ${u.className}@${u.line}: ${u.reason}`).join("\n");
      expect.fail(`good.ts should be clean but analyzer flagged:\n${detail}`);
    }
    expect(unguarded.length).toBe(0);

    for (const relativePath of Object.keys(PRODUCTION_FILE_PINS)) {
      const filePath = path.join(process.cwd(), relativePath);
      const source = await fs.readFile(filePath, "utf8");
      expect(analyzeSource(filePath, source, false, true), relativePath).toEqual([]);
    }

    const typeOnlyConsumer =
      'import type { EmbedDb } from "./embed-db.js";\n' + 'import type { FtsIndex } from "./fts5.js";\n';
    expect(
      analyzeSource(path.join(process.cwd(), "src/type-only-k1-consumer.ts"), typeOnlyConsumer, false, true)
    ).toEqual([]);
    const resolverOnlyConsumer =
      'import { resolveModel } from "./embeddings.js";\nexport const model = resolveModel(undefined);\n';
    expect(
      analyzeSource(path.join(process.cwd(), "src/resolver-only-consumer.ts"), resolverOnlyConsumer, false, true)
    ).toEqual([]);
    const resolverOnlyReexport = 'export { parseQuantizationMode } from "./tool-registry.js";\n';
    expect(
      analyzeSource(path.join(process.cwd(), "src/resolver-only-reexport.ts"), resolverOnlyReexport, false, true)
    ).toEqual([]);
    const providerInternalDiscovery = `
export async function discoverEmbedDbConfig(file, vaultRoot) {
  return discoverEmbedDbConfigCached(file, vaultRoot);
}
async function discoverEmbedDbConfigCached(file, vaultRoot) {
  return discoverEmbedDbConfig(file, vaultRoot);
}`;
    expect(
      analyzeSource(
        path.join(process.cwd(), "src/embed-db-provider-internal.ts"),
        providerInternalDiscovery,
        false,
        true
      )
    ).toEqual([]);
    expect(isTsImplementationFile("new-k1-site.tsx")).toBe(true);
    expect(isTsImplementationFile("new-k1-site.mts")).toBe(true);
    expect(isTsImplementationFile("types.d.mts")).toBe(false);
    const extensionTree = await fs.mkdtemp(path.join(tmpdir(), "enquire-k1-extensions-"));
    try {
      const implementationNames = ["a.ts", "b.tsx", "c.mts", "d.cts"];
      const declarationNames = ["a.d.ts", "c.d.mts", "d.d.cts"];
      await Promise.all(
        [...implementationNames, ...declarationNames].map((name) => fs.writeFile(path.join(extensionTree, name), ""))
      );
      const collectedNames = (await collectTs(extensionTree)).map((file) => path.basename(file)).sort();
      expect(collectedNames).toEqual(implementationNames);
    } finally {
      await fs.rm(extensionTree, { force: true, recursive: true });
    }
  });

  it("NEGATIVE: toolchain regressions and bad-ignored-peek.ts are rejected", async () => {
    const pkg = JSON.parse(await fs.readFile(path.join(process.cwd(), "package.json"), "utf8")) as ToolchainPackage;

    const pinnedCliPath = path.join(process.cwd(), "src/cli.ts");
    const pinnedCli = await fs.readFile(pinnedCliPath, "utf8");
    const destructuringAfterDiscovery = replaceExactly(
      pinnedCli,
      "        const idx = new FtsIndex({ file: indexFile, vaultRoot: vault.root, tokenize });",
      '        [tokenize] = ["unicode61"];\n' +
        "        const idx = new FtsIndex({ file: indexFile, vaultRoot: vault.root, tokenize });"
    );
    const pinnedMutationViolations = analyzeSource(pinnedCliPath, destructuringAfterDiscovery, false, true);
    expect(pinnedMutationViolations).toHaveLength(1);
    expect(pinnedMutationViolations[0]?.reason).toMatch(/source hash mismatch/);

    // Recompute the pin over a semantic server mutant so the independent AST
    // census — rather than the byte hash alone — must reject a lost awaited
    // discovery-bound open. This keeps a future legitimate pin refresh from
    // accidentally laundering a changed K-1 construction/open inventory.
    const pinnedServerPath = path.join(process.cwd(), "src/server.ts");
    const pinnedServer = await fs.readFile(pinnedServerPath, "utf8");
    const missingServerOpen = replaceExactly(
      pinnedServer,
      "          await watcherEmbedDb.open(discovered);",
      "          void watcherEmbedDb;"
    );
    const serverPin = PRODUCTION_FILE_PINS["src/server.ts"];
    expect(serverPin).toBeDefined();
    if (serverPin === undefined) throw new Error("src/server.ts K-1 production pin is missing");
    const missingServerOpenSource = ts.createSourceFile(
      pinnedServerPath,
      missingServerOpen,
      ts.ScriptTarget.Latest,
      true
    );
    const semanticServerMutationViolations = analyzePinnedProductionSource(
      pinnedServerPath,
      missingServerOpen,
      missingServerOpenSource,
      { ...serverPin, sha256: sourceSha256(missingServerOpen) }
    );
    expect(semanticServerMutationViolations).toHaveLength(1);
    expect(semanticServerMutationViolations[0]?.reason).toMatch(/constructor\/discovery\/open census drifted/);

    const unpinnedAliasSite = `
import { discoverEmbedDbConfig as discover, EmbedDb as E } from "./embed-db.js";
async function unpinnedAliasSite(file, vaultRoot) {
  const discovered = await discover(file, vaultRoot);
  const db = new E({ file, vaultRoot, modelAlias: "fixed", dim: 384, quantization: "int8" });
  await db.open(discovered);
}`;
    const aliasInventoryViolations = analyzeSource(
      path.join(process.cwd(), "src/unpinned-k1-alias.mts"),
      unpinnedAliasSite,
      false,
      true
    );
    expect(aliasInventoryViolations).toHaveLength(1);
    expect(aliasInventoryViolations[0]?.reason).toMatch(/outside the exact pinned production inventory/);

    const reexportAlias = 'export { EmbedDb as E, discoverEmbedDbConfig as discover } from "./embed-db.js";\n';
    const reexportInventoryViolations = analyzeSource(
      path.join(process.cwd(), "src/unpinned-k1-reexport.ts"),
      reexportAlias,
      false,
      true
    );
    expect(reexportInventoryViolations).toHaveLength(1);
    expect(reexportInventoryViolations[0]?.reason).toMatch(/outside the exact pinned production inventory/);

    const namespaceAliasSite = `
import * as dbmod from "../../embed-db.js";
const E = dbmod.EmbedDb;
const discover = dbmod.discoverEmbedDbConfig;
async function namespaceAliasSite(file, vaultRoot) {
  const discovered = await discover(file, vaultRoot);
  const db = new E({ file, vaultRoot, modelAlias: "fixed", dim: 384, quantization: "int8" });
  await db.open(discovered);
}`;
    const namespaceInventoryViolations = analyzeSource(
      path.join(process.cwd(), "src/new/deeper/unpinned-k1-namespace.tsx"),
      namespaceAliasSite,
      false,
      true
    );
    expect(namespaceInventoryViolations).toHaveLength(1);
    expect(namespaceInventoryViolations[0]?.reason).toMatch(/outside the exact pinned production inventory/);

    const dynamicNamespaceSite = `
async function dynamicNamespaceSite(file, vaultRoot) {
  const dbmod = await import("./embed-db.js");
  const discovered = await dbmod.discoverEmbedDbConfig(file, vaultRoot);
  const db = new dbmod.EmbedDb({ file, vaultRoot, modelAlias: "fixed", dim: 384, quantization: "int8" });
  await db.open(discovered);
}`;
    const dynamicInventoryViolations = analyzeSource(
      path.join(process.cwd(), "src/unpinned-k1-dynamic.ts"),
      dynamicNamespaceSite,
      false,
      true
    );
    expect(dynamicInventoryViolations).toHaveLength(1);
    expect(dynamicInventoryViolations[0]?.reason).toMatch(/outside the exact pinned production inventory/);

    const importEqualsAliasSite = `
import dbmod = require("../../embed-db.js");
const E = dbmod.EmbedDb;
const discover = dbmod.discoverEmbedDbConfig;
async function importEqualsAliasSite(file, vaultRoot) {
  const discovered = await discover(file, vaultRoot);
  const db = new E({ file, vaultRoot, modelAlias: "fixed", dim: 384, quantization: "int8" });
  await db.open(discovered);
}`;
    const importEqualsInventoryViolations = analyzeSource(
      path.join(process.cwd(), "src/new/deeper/unpinned-k1-import-equals.cts"),
      importEqualsAliasSite,
      false,
      true
    );
    expect(importEqualsInventoryViolations).toHaveLength(1);
    expect(importEqualsInventoryViolations[0]?.reason).toMatch(/outside the exact pinned production inventory/);

    const classicRegressed = structuredClone(pkg);
    classicRegressed.devDependencies = {
      ...classicRegressed.devDependencies,
      typescript: `${CLASSIC_TYPESCRIPT_RANGE} || ^7.0.2`
    };
    expect(toolchainProblems(classicRegressed)[0]).toMatch(/^typescript must remain exactly /);

    const nativeRegressed = structuredClone(pkg);
    nativeRegressed.devDependencies = {
      ...nativeRegressed.devDependencies,
      "typescript-native": "npm:typescript@7.0.3"
    };
    expect(toolchainProblems(nativeRegressed)[0]).toMatch(/^typescript-native must pin /);

    // NEGATIVE controls for every emit path: merely mentioning the native
    // binary before a bare `tsc` emit must not satisfy the exact-script gate.
    for (const name of Object.keys(NATIVE_EMIT_SCRIPTS)) {
      const scriptRegressed = structuredClone(pkg);
      scriptRegressed.scripts = {
        ...scriptRegressed.scripts,
        [name]: `${NATIVE_TSC_COMMAND} --version && tsc`
      };
      expect(toolchainProblems(scriptRegressed).some((problem) => problem.startsWith(`${name} must be exactly `))).toBe(
        true
      );
    }

    const unguarded = await analyzeFile(path.join(FIXTURE_DIR, "bad-ignored-peek.ts"), true);
    expect(unguarded.length).toBeGreaterThanOrEqual(1);
    // The specific failure mode: K-1 args present but discovery not consumed.
    expect(unguarded[0]?.reason).toMatch(/do not all trace back to a configuration-discovery result/);
    expect(unguarded[0]?.className).toBe("EmbedDb");

    const rawPeekOnly = `
async function rawPeekCaller(indexFile, vaultRoot) {
  const discovered = await peekFtsMetaSafe(indexFile, vaultRoot);
  const tokenize = discovered?.tokenize_mode ?? "unicode61";
  const index = new FtsIndex({ file: indexFile, vaultRoot, tokenize });
  await index.open(discovered);
  return index;
}`;
    expect(analyzeSource("src/raw-peek-mutant.ts", rawPeekOnly)).toHaveLength(1);
    expect(
      analyzeSource(
        "src/discovery-positive.ts",
        `import { discoverFtsIndexConfig } from "./fts5.js";\n${replaceExactly(
          replaceExactly(rawPeekOnly, "peekFtsMetaSafe", "discoverFtsIndexConfig"),
          'discovered?.tokenize_mode ?? "unicode61"',
          'discovered.kind === "owned" ? discovered.meta.tokenize_mode : "unicode61"'
        )}`
      )
    ).toEqual([]);

    const textualDiscoveryDecoy = `
import { discoverEmbedDbConfig } from "./embed-db.js";
async function discardedDiscoveryWithTextDecoy(indexFile, vaultRoot) {
  await discoverEmbedDbConfig(indexFile, vaultRoot);
  const decoy = "discoverEmbedDbConfig";
  const modelAlias = decoy;
  return new EmbedDb({ file: indexFile, vaultRoot, modelAlias, dim: 384, quantization: "f32" });
}`;
    const decoyViolations = analyzeSource("src/discovery-text-decoy.ts", textualDiscoveryDecoy);
    expect(decoyViolations).toHaveLength(1);
    expect(decoyViolations[0]?.reason).toMatch(/do not all trace back to a configuration-discovery result/);

    const discardedObjectField = `
import { discoverFtsIndexConfig } from "./fts5.js";
async function discardedDiscoveryObjectField(indexFile, vaultRoot) {
  const wrapper = {
    ignored: await discoverFtsIndexConfig(indexFile, vaultRoot),
    meta: { tokenize_mode: "unicode61" }
  };
  const tokenize = wrapper.meta.tokenize_mode;
  return new FtsIndex({ file: indexFile, vaultRoot, tokenize });
}`;
    const objectFieldViolations = analyzeSource("src/discovery-object-decoy.ts", discardedObjectField);
    expect(objectFieldViolations).toHaveLength(1);
    expect(objectFieldViolations[0]?.reason).toMatch(/do not all trace back to a configuration-discovery result/);

    const constantConditionalDecoy = `
import { discoverFtsIndexConfig } from "./fts5.js";
async function constantConditionalDiscovery(indexFile, vaultRoot) {
  const discovered = await discoverFtsIndexConfig(indexFile, vaultRoot);
  const tokenize = discovered.kind === "owned" ? "unicode61" : "unicode61";
  return new FtsIndex({ file: indexFile, vaultRoot, tokenize });
}`;
    const constantConditionalViolations = analyzeSource(
      "src/discovery-constant-conditional.ts",
      constantConditionalDecoy
    );
    expect(constantConditionalViolations).toHaveLength(1);
    expect(constantConditionalViolations[0]?.reason).toMatch(
      /do not all trace back to a configuration-discovery result/
    );

    const hardcodedSiblingArg = `
import { discoverEmbedDbConfig } from "./embed-db.js";
import { resolveModel, resolveStoredEmbeddingConfiguration } from "./embeddings.js";
async function oneGoodFieldCannotLaunderAnother(embedFile, vaultRoot) {
  const discovered = await discoverEmbedDbConfig(embedFile, vaultRoot);
  const stored =
    discovered.kind === "owned" ? resolveStoredEmbeddingConfiguration(discovered.meta) : null;
  const model = stored?.model ?? resolveModel(undefined);
  return new EmbedDb({
    file: embedFile,
    vaultRoot,
    modelAlias: model.alias,
    dim: model.dim,
    quantization: "f32"
  });
}`;
    const hardcodedSiblingViolations = analyzeSource("src/discovery-hardcoded-sibling.ts", hardcodedSiblingArg);
    expect(hardcodedSiblingViolations).toHaveLength(1);
    expect(hardcodedSiblingViolations[0]?.reason).toMatch(/underived: quantization/);

    const assignmentAfterConstructor = `
import { discoverFtsIndexConfig } from "./fts5.js";
async function futureWriteCannotAuthorizePastConstructor(indexFile, vaultRoot) {
  const discovered = await discoverFtsIndexConfig(indexFile, vaultRoot);
  let tokenize = "unicode61";
  const index = new FtsIndex({ file: indexFile, vaultRoot, tokenize });
  tokenize = discovered.kind === "owned" ? discovered.meta.tokenize_mode : "unicode61";
  return index;
}`;
    const futureWriteViolations = analyzeSource("src/discovery-future-write.ts", assignmentAfterConstructor);
    expect(futureWriteViolations).toHaveLength(1);
    expect(futureWriteViolations[0]?.reason).toMatch(/underived: tokenize/);

    const lexicalShadowDecoys = `
import { discoverFtsIndexConfig } from "./fts5.js";
async function shadowsCannotLendAuthority(indexFile, vaultRoot) {
  const discovered = await discoverFtsIndexConfig(indexFile, vaultRoot);
  let tokenize = "unicode61";
  {
    const tokenize = discovered.kind === "owned" ? discovered.meta.tokenize_mode : "unicode61";
    void tokenize;
  }
  function nestedDecoy() {
    tokenize = discovered.kind === "owned" ? discovered.meta.tokenize_mode : "unicode61";
  }
  void nestedDecoy;
  return new FtsIndex({ file: indexFile, vaultRoot, tokenize });
}`;
    const shadowViolations = analyzeSource("src/discovery-shadow-decoys.ts", lexicalShadowDecoys);
    expect(shadowViolations).toHaveLength(1);
    expect(shadowViolations[0]?.reason).toMatch(/underived: tokenize/);

    const unreachableFalseArm = `
import { discoverFtsIndexConfig } from "./fts5.js";
async function unreachableAuthorityArm(indexFile, vaultRoot) {
  const discovered = await discoverFtsIndexConfig(indexFile, vaultRoot);
  const tokenize = false ? discovered.meta.tokenize_mode : "unicode61";
  return new FtsIndex({ file: indexFile, vaultRoot, tokenize });
}`;
    const unreachableArmViolations = analyzeSource("src/discovery-unreachable-arm.ts", unreachableFalseArm);
    expect(unreachableArmViolations).toHaveLength(1);
    expect(unreachableArmViolations[0]?.reason).toMatch(/underived: tokenize/);

    const discardingCallDecoy = `
import { discoverFtsIndexConfig } from "./fts5.js";
async function discardingCallDiscovery(indexFile, vaultRoot) {
  const discovered = await discoverFtsIndexConfig(indexFile, vaultRoot);
  const tokenize = ((_ignored) => "unicode61")(discovered);
  return new FtsIndex({ file: indexFile, vaultRoot, tokenize });
}`;
    const discardingCallViolations = analyzeSource("src/discovery-discarding-call.ts", discardingCallDecoy);
    expect(discardingCallViolations).toHaveLength(1);
    expect(discardingCallViolations[0]?.reason).toMatch(/do not all trace back to a configuration-discovery result/);

    const missingEmbedQuantization = `
import { discoverEmbedDbConfig } from "./embed-db.js";
import { resolveModel, resolveStoredEmbeddingConfiguration } from "./embeddings.js";
async function deletedQuantization(embedFile, vaultRoot) {
  const discovered = await discoverEmbedDbConfig(embedFile, vaultRoot);
  const stored =
    discovered.kind === "owned" ? resolveStoredEmbeddingConfiguration(discovered.meta) : null;
  const model = stored?.model ?? resolveModel(undefined);
  return new EmbedDb({ file: embedFile, vaultRoot, modelAlias: model.alias, dim: model.dim });
}`;
    const missingQuantizationViolations = analyzeSource(
      "src/discovery-missing-quantization.ts",
      missingEmbedQuantization
    );
    expect(missingQuantizationViolations).toHaveLength(1);
    expect(missingQuantizationViolations[0]?.reason).toMatch(
      /missing required complete-authority fields: quantization/
    );

    const missingFtsTokenize = `
import { discoverFtsIndexConfig } from "./fts5.js";
async function deletedTokenize(indexFile, vaultRoot) {
  const discovered = await discoverFtsIndexConfig(indexFile, vaultRoot);
  void discovered;
  return new FtsIndex({ file: indexFile, vaultRoot });
}`;
    const missingTokenizeViolations = analyzeSource("src/discovery-missing-tokenize.ts", missingFtsTokenize);
    expect(missingTokenizeViolations).toHaveLength(1);
    expect(missingTokenizeViolations[0]?.reason).toMatch(/missing required complete-authority fields: tokenize/);

    const wrongDiscoveryFile = `
import { discoverFtsIndexConfig } from "./fts5.js";
async function wrongFile(indexFile, otherFile, vaultRoot) {
  const discovered = await discoverFtsIndexConfig(otherFile, vaultRoot);
  const tokenize = discovered.kind === "owned" ? discovered.meta.tokenize_mode : "unicode61";
  return new FtsIndex({ file: indexFile, vaultRoot, tokenize });
}`;
    const wrongFileViolations = analyzeSource("src/discovery-wrong-file.ts", wrongDiscoveryFile);
    expect(wrongFileViolations).toHaveLength(1);
    expect(wrongFileViolations[0]?.reason).toMatch(/underived: tokenize/);

    const wrongDiscoveryRoot = `
import { discoverFtsIndexConfig } from "./fts5.js";
async function wrongRoot(indexFile, vaultRoot, otherRoot) {
  const discovered = await discoverFtsIndexConfig(indexFile, otherRoot);
  const tokenize = discovered.kind === "owned" ? discovered.meta.tokenize_mode : "unicode61";
  return new FtsIndex({ file: indexFile, vaultRoot, tokenize });
}`;
    const wrongRootViolations = analyzeSource("src/discovery-wrong-root.ts", wrongDiscoveryRoot);
    expect(wrongRootViolations).toHaveLength(1);
    expect(wrongRootViolations[0]?.reason).toMatch(/underived: tokenize/);

    const arbitraryConditional = `
import { discoverFtsIndexConfig } from "./fts5.js";
async function arbitraryCondition(indexFile, vaultRoot, useStored) {
  const discovered = await discoverFtsIndexConfig(indexFile, vaultRoot);
  const tokenize = useStored ? discovered.meta.tokenize_mode : "unicode61";
  return new FtsIndex({ file: indexFile, vaultRoot, tokenize });
}`;
    const arbitraryConditionalViolations = analyzeSource(
      "src/discovery-arbitrary-conditional.ts",
      arbitraryConditional
    );
    expect(arbitraryConditionalViolations).toHaveLength(1);
    expect(arbitraryConditionalViolations[0]?.reason).toMatch(/underived: tokenize/);

    const logicalDiscard = `
import { discoverFtsIndexConfig } from "./fts5.js";
async function logicalDiscard(indexFile, vaultRoot) {
  const discovered = await discoverFtsIndexConfig(indexFile, vaultRoot);
  const tokenize = discovered.meta.tokenize_mode && "unicode61";
  return new FtsIndex({ file: indexFile, vaultRoot, tokenize });
}`;
    const logicalDiscardViolations = analyzeSource("src/discovery-logical-discard.ts", logicalDiscard);
    expect(logicalDiscardViolations).toHaveLength(1);
    expect(logicalDiscardViolations[0]?.reason).toMatch(/underived: tokenize/);

    const spreadOverride = `
import { discoverFtsIndexConfig } from "./fts5.js";
async function spreadCanOverride(indexFile, vaultRoot) {
  const discovered = await discoverFtsIndexConfig(indexFile, vaultRoot);
  const tokenize = discovered.kind === "owned" ? discovered.meta.tokenize_mode : "unicode61";
  const override = { tokenize: "unicode61" };
  return new FtsIndex({ file: indexFile, vaultRoot, tokenize, ...override });
}`;
    const spreadViolations = analyzeSource("src/discovery-spread-override.ts", spreadOverride);
    expect(spreadViolations).toHaveLength(1);
    expect(spreadViolations[0]?.reason).toMatch(/spread that can add or override/);

    const destructuredLocalShadow = `
import { discoverFtsIndexConfig } from "./fts5.js";
async function localShadow(indexFile, vaultRoot, helpers) {
  const { discoverFtsIndexConfig } = helpers;
  const discovered = await discoverFtsIndexConfig(indexFile, vaultRoot);
  const tokenize = discovered.kind === "owned" ? discovered.meta.tokenize_mode : "unicode61";
  return new FtsIndex({ file: indexFile, vaultRoot, tokenize });
}`;
    const localShadowViolations = analyzeSource("src/discovery-local-shadow.ts", destructuredLocalShadow);
    expect(localShadowViolations).toHaveLength(1);
    expect(localShadowViolations[0]?.reason).toMatch(/underived: tokenize/);

    const wrongDiscoveryModule = `
import { discoverFtsIndexConfig } from "./lookalike.js";
async function wrongModule(indexFile, vaultRoot) {
  const discovered = await discoverFtsIndexConfig(indexFile, vaultRoot);
  const tokenize = discovered.kind === "owned" ? discovered.meta.tokenize_mode : "unicode61";
  return new FtsIndex({ file: indexFile, vaultRoot, tokenize });
}`;
    const wrongModuleViolations = analyzeSource("src/discovery-wrong-module.ts", wrongDiscoveryModule);
    expect(wrongModuleViolations).toHaveLength(1);
    expect(wrongModuleViolations[0]?.reason).toMatch(/underived: tokenize/);

    const conditionalOnlyWrite = `
import { discoverFtsIndexConfig } from "./fts5.js";
async function conditionalOnly(indexFile, vaultRoot, useStored) {
  const discovered = await discoverFtsIndexConfig(indexFile, vaultRoot);
  let tokenize = "unicode61";
  if (useStored) {
    tokenize = discovered.kind === "owned" ? discovered.meta.tokenize_mode : "unicode61";
  }
  return new FtsIndex({ file: indexFile, vaultRoot, tokenize });
}`;
    const conditionalWriteViolations = analyzeSource("src/discovery-conditional-write.ts", conditionalOnlyWrite);
    expect(conditionalWriteViolations).toHaveLength(1);
    expect(conditionalWriteViolations[0]?.reason).toMatch(/underived: tokenize/);

    const loopOnlyWrite = `
import { discoverFtsIndexConfig } from "./fts5.js";
async function loopOnly(indexFile, vaultRoot, useStored) {
  const discovered = await discoverFtsIndexConfig(indexFile, vaultRoot);
  let tokenize = "unicode61";
  while (useStored) {
    tokenize = discovered.kind === "owned" ? discovered.meta.tokenize_mode : "unicode61";
    break;
  }
  return new FtsIndex({ file: indexFile, vaultRoot, tokenize });
}`;
    const loopWriteViolations = analyzeSource("src/discovery-loop-write.ts", loopOnlyWrite);
    expect(loopWriteViolations).toHaveLength(1);
    expect(loopWriteViolations[0]?.reason).toMatch(/underived: tokenize/);

    const falseConjunct = `
import { discoverFtsIndexConfig } from "./fts5.js";
async function falseConjunct(indexFile, vaultRoot) {
  const discovered = await discoverFtsIndexConfig(indexFile, vaultRoot);
  const tokenize =
    discovered.kind === "owned" && false ? discovered.meta.tokenize_mode : "unicode61";
  return new FtsIndex({ file: indexFile, vaultRoot, tokenize });
}`;
    const falseConjunctViolations = analyzeSource("src/discovery-false-conjunct.ts", falseConjunct);
    expect(falseConjunctViolations).toHaveLength(1);
    expect(falseConjunctViolations[0]?.reason).toMatch(/underived: tokenize/);

    const identifierFalseConjunct = `
import { discoverFtsIndexConfig } from "./fts5.js";
async function identifierFalseConjunct(indexFile, vaultRoot) {
  const discovered = await discoverFtsIndexConfig(indexFile, vaultRoot);
  const never = false;
  const tokenize =
    discovered.kind === "owned" && never ? discovered.meta.tokenize_mode : "unicode61";
  return new FtsIndex({ file: indexFile, vaultRoot, tokenize });
}`;
    const identifierFalseViolations = analyzeSource(
      "src/discovery-identifier-false-conjunct.ts",
      identifierFalseConjunct
    );
    expect(identifierFalseViolations).toHaveLength(1);
    expect(identifierFalseViolations[0]?.reason).toMatch(/underived: tokenize/);

    const reversedOwnedArms = `
import { discoverFtsIndexConfig } from "./fts5.js";
async function reversedOwnedArms(indexFile, vaultRoot) {
  const discovered = await discoverFtsIndexConfig(indexFile, vaultRoot);
  const stored = discovered.kind === "owned" ? discovered.meta.tokenize_mode : "unicode61";
  const tokenize = discovered.kind === "owned" ? "unicode61" : stored;
  return new FtsIndex({ file: indexFile, vaultRoot, tokenize });
}`;
    const reversedArmViolations = analyzeSource("src/discovery-reversed-owned-arms.ts", reversedOwnedArms);
    expect(reversedArmViolations).toHaveLength(1);
    expect(reversedArmViolations[0]?.reason).toMatch(/underived: tokenize/);

    const reassignedTarget = `
import { discoverFtsIndexConfig } from "./fts5.js";
async function reassignedTarget(indexFile, otherFile, vaultRoot) {
  let target = indexFile;
  const discovered = await discoverFtsIndexConfig(target, vaultRoot);
  target = otherFile;
  const tokenize = discovered.kind === "owned" ? discovered.meta.tokenize_mode : "unicode61";
  return new FtsIndex({ file: target, vaultRoot, tokenize });
}`;
    const reassignedTargetViolations = analyzeSource("src/discovery-reassigned-target.ts", reassignedTarget);
    expect(reassignedTargetViolations).toHaveLength(1);
    expect(reassignedTargetViolations[0]?.reason).toMatch(/underived: tokenize/);

    const compoundReassignedTarget = `
import { discoverFtsIndexConfig } from "./fts5.js";
async function compoundReassignedTarget(indexFile, vaultRoot) {
  let target = indexFile;
  const discovered = await discoverFtsIndexConfig(target, vaultRoot);
  target += ".other";
  const tokenize = discovered.kind === "owned" ? discovered.meta.tokenize_mode : "unicode61";
  return new FtsIndex({ file: target, vaultRoot, tokenize });
}`;
    const compoundTargetViolations = analyzeSource(
      "src/discovery-compound-reassigned-target.ts",
      compoundReassignedTarget
    );
    expect(compoundTargetViolations).toHaveLength(1);
    expect(compoundTargetViolations[0]?.reason).toMatch(/underived: tokenize/);

    const mutatedFilePath = `
import { discoverFtsIndexConfig } from "./fts5.js";
async function mutatedFilePath(indexFile, otherFile, vaultRoot) {
  const paths = { db: indexFile };
  const discovered = await discoverFtsIndexConfig(paths.db, vaultRoot);
  paths.db = otherFile;
  const tokenize = discovered.kind === "owned" ? discovered.meta.tokenize_mode : "unicode61";
  return new FtsIndex({ file: paths.db, vaultRoot, tokenize });
}`;
    const mutatedFilePathViolations = analyzeSource("src/discovery-mutated-file-path.ts", mutatedFilePath);
    expect(mutatedFilePathViolations).toHaveLength(1);
    expect(mutatedFilePathViolations[0]?.reason).toMatch(/underived: tokenize/);

    const mutatedRootPath = `
import { discoverFtsIndexConfig } from "./fts5.js";
async function mutatedRootPath(indexFile, vaultRoot, otherRoot) {
  const roots = { current: vaultRoot };
  const discovered = await discoverFtsIndexConfig(indexFile, roots.current);
  roots.current = otherRoot;
  const tokenize = discovered.kind === "owned" ? discovered.meta.tokenize_mode : "unicode61";
  return new FtsIndex({ file: indexFile, vaultRoot: roots.current, tokenize });
}`;
    const mutatedRootPathViolations = analyzeSource("src/discovery-mutated-root-path.ts", mutatedRootPath);
    expect(mutatedRootPathViolations).toHaveLength(1);
    expect(mutatedRootPathViolations[0]?.reason).toMatch(/underived: tokenize/);

    const reassignedPathObject = `
import { discoverFtsIndexConfig } from "./fts5.js";
async function reassignedPathObject(indexFile, otherFile, vaultRoot) {
  let paths = { db: indexFile };
  const discovered = await discoverFtsIndexConfig(paths.db, vaultRoot);
  paths = { db: otherFile };
  const tokenize = discovered.kind === "owned" ? discovered.meta.tokenize_mode : "unicode61";
  return new FtsIndex({ file: paths.db, vaultRoot, tokenize });
}`;
    const reassignedPathObjectViolations = analyzeSource(
      "src/discovery-reassigned-path-object.ts",
      reassignedPathObject
    );
    expect(reassignedPathObjectViolations).toHaveLength(1);
    expect(reassignedPathObjectViolations[0]?.reason).toMatch(/underived: tokenize/);

    const wrongEmbedProperty = `
import { discoverEmbedDbConfig } from "./embed-db.js";
import { resolveModel, resolveStoredEmbeddingConfiguration } from "./embeddings.js";
async function wrongEmbedProperty(embedFile, vaultRoot) {
  const discovered = await discoverEmbedDbConfig(embedFile, vaultRoot);
  const stored =
    discovered.kind === "owned" ? resolveStoredEmbeddingConfiguration(discovered.meta) : null;
  const model = stored?.model ?? resolveModel(undefined);
  const quantization = stored?.quantization ?? "f32";
  return new EmbedDb({
    file: embedFile,
    vaultRoot,
    modelAlias: discovered.kind,
    dim: model.dim,
    quantization
  });
}`;
    const wrongEmbedPropertyViolations = analyzeSource("src/discovery-wrong-embed-property.ts", wrongEmbedProperty);
    expect(wrongEmbedPropertyViolations).toHaveLength(1);
    expect(wrongEmbedPropertyViolations[0]?.reason).toMatch(/underived: modelAlias/);

    const safeMarkerStringDecoy = `
async function safeMarkerStringDecoy(indexFile, vaultRoot) {
  const prose = \`line one
// SAFE BY DESIGN: this is string data, not TypeScript trivia
line three\`;
  void prose;
  return new FtsIndex({ file: indexFile, vaultRoot });
}`;
    const safeStringViolations = analyzeSource("src/safe-marker-string-decoy.ts", safeMarkerStringDecoy);
    expect(safeStringViolations).toHaveLength(1);
    expect(safeStringViolations[0]?.reason).toMatch(/missing required complete-authority fields: tokenize/);

    const switchOnlyWrite = `
import { discoverFtsIndexConfig } from "./fts5.js";
async function switchOnlyWrite(indexFile, vaultRoot, choice) {
  const discovered = await discoverFtsIndexConfig(indexFile, vaultRoot);
  let tokenize = "unicode61";
  switch (choice) {
    case 1:
      tokenize = discovered.kind === "owned" ? discovered.meta.tokenize_mode : "unicode61";
      break;
  }
  return new FtsIndex({ file: indexFile, vaultRoot, tokenize });
}`;
    const switchWriteViolations = analyzeSource("src/discovery-switch-write.ts", switchOnlyWrite);
    expect(switchWriteViolations).toHaveLength(1);
    expect(switchWriteViolations[0]?.reason).toMatch(/underived: tokenize/);

    const crossSwitchClauseWrite = `
import { discoverFtsIndexConfig } from "./fts5.js";
async function crossSwitchClauseWrite(indexFile, vaultRoot, choice) {
  const discovered = await discoverFtsIndexConfig(indexFile, vaultRoot);
  let tokenize = "unicode61";
  switch (choice) {
    case 1:
      tokenize = discovered.kind === "owned" ? discovered.meta.tokenize_mode : "unicode61";
      break;
    case 2:
      return new FtsIndex({ file: indexFile, vaultRoot, tokenize });
  }
}`;
    const crossClauseViolations = analyzeSource("src/discovery-cross-switch-clause.ts", crossSwitchClauseWrite);
    expect(crossClauseViolations).toHaveLength(1);
    expect(crossClauseViolations[0]?.reason).toMatch(/underived: tokenize/);

    const tryOnlyWrite = `
import { discoverFtsIndexConfig } from "./fts5.js";
async function tryOnlyWrite(indexFile, vaultRoot) {
  const discovered = await discoverFtsIndexConfig(indexFile, vaultRoot);
  let tokenize = "unicode61";
  try {
    throw new Error("skip write");
    tokenize = discovered.kind === "owned" ? discovered.meta.tokenize_mode : "unicode61";
  } catch {}
  return new FtsIndex({ file: indexFile, vaultRoot, tokenize });
}`;
    const tryWriteViolations = analyzeSource("src/discovery-try-write.ts", tryOnlyWrite);
    expect(tryWriteViolations).toHaveLength(1);
    expect(tryWriteViolations[0]?.reason).toMatch(/underived: tokenize/);

    const forIncrementorWrite = `
import { discoverFtsIndexConfig } from "./fts5.js";
async function forIncrementorWrite(indexFile, vaultRoot) {
  const discovered = await discoverFtsIndexConfig(indexFile, vaultRoot);
  let tokenize = "unicode61";
  for (let i = 0; i < 1; tokenize = discovered.kind === "owned" ? discovered.meta.tokenize_mode : "unicode61") {
    return new FtsIndex({ file: indexFile, vaultRoot, tokenize });
  }
}`;
    const forIncrementorViolations = analyzeSource("src/discovery-for-incrementor.ts", forIncrementorWrite);
    expect(forIncrementorViolations).toHaveLength(1);
    expect(forIncrementorViolations[0]?.reason).toMatch(/underived: tokenize/);

    const labeledBreakWrite = `
import { discoverFtsIndexConfig } from "./fts5.js";
async function labeledBreakWrite(indexFile, vaultRoot, skip) {
  const discovered = await discoverFtsIndexConfig(indexFile, vaultRoot);
  let tokenize = "unicode61";
  outer: {
    if (skip) break outer;
    tokenize = discovered.kind === "owned" ? discovered.meta.tokenize_mode : "unicode61";
  }
  return new FtsIndex({ file: indexFile, vaultRoot, tokenize });
}`;
    const labeledBreakViolations = analyzeSource("src/discovery-labeled-break.ts", labeledBreakWrite);
    expect(labeledBreakViolations).toHaveLength(1);
    expect(labeledBreakViolations[0]?.reason).toMatch(/underived: tokenize/);

    const invokedArrowReset = `
import { discoverFtsIndexConfig } from "./fts5.js";
async function invokedArrowReset(indexFile, vaultRoot) {
  const discovered = await discoverFtsIndexConfig(indexFile, vaultRoot);
  let tokenize = discovered.kind === "owned" ? discovered.meta.tokenize_mode : "unicode61";
  const reset = () => { tokenize = "unicode61"; };
  reset();
  return new FtsIndex({ file: indexFile, vaultRoot, tokenize });
}`;
    const arrowResetViolations = analyzeSource("src/discovery-arrow-reset.ts", invokedArrowReset);
    expect(arrowResetViolations).toHaveLength(1);
    expect(arrowResetViolations[0]?.reason).toMatch(/underived: tokenize/);

    const invokedDeclarationReset = `
import { discoverFtsIndexConfig } from "./fts5.js";
async function invokedDeclarationReset(indexFile, vaultRoot) {
  const discovered = await discoverFtsIndexConfig(indexFile, vaultRoot);
  let tokenize = discovered.kind === "owned" ? discovered.meta.tokenize_mode : "unicode61";
  function reset() { tokenize = "unicode61"; }
  reset();
  return new FtsIndex({ file: indexFile, vaultRoot, tokenize });
}`;
    const declarationResetViolations = analyzeSource("src/discovery-declaration-reset.ts", invokedDeclarationReset);
    expect(declarationResetViolations).toHaveLength(1);
    expect(declarationResetViolations[0]?.reason).toMatch(/underived: tokenize/);

    const invokedIifeReset = `
import { discoverFtsIndexConfig } from "./fts5.js";
async function invokedIifeReset(indexFile, vaultRoot) {
  const discovered = await discoverFtsIndexConfig(indexFile, vaultRoot);
  let tokenize = discovered.kind === "owned" ? discovered.meta.tokenize_mode : "unicode61";
  (() => { tokenize = "unicode61"; })();
  return new FtsIndex({ file: indexFile, vaultRoot, tokenize });
}`;
    const iifeResetViolations = analyzeSource("src/discovery-iife-reset.ts", invokedIifeReset);
    expect(iifeResetViolations).toHaveLength(1);
    expect(iifeResetViolations[0]?.reason).toMatch(/underived: tokenize/);

    const invokedAliasReset = `
import { discoverFtsIndexConfig } from "./fts5.js";
async function invokedAliasReset(indexFile, vaultRoot) {
  const discovered = await discoverFtsIndexConfig(indexFile, vaultRoot);
  let tokenize = discovered.kind === "owned" ? discovered.meta.tokenize_mode : "unicode61";
  const reset = () => { tokenize = "unicode61"; };
  const alias = reset;
  alias();
  return new FtsIndex({ file: indexFile, vaultRoot, tokenize });
}`;
    const aliasResetViolations = analyzeSource("src/discovery-alias-reset.ts", invokedAliasReset);
    expect(aliasResetViolations).toHaveLength(1);
    expect(aliasResetViolations[0]?.reason).toMatch(/underived: tokenize/);

    const invokedCallbackReset = `
import { discoverFtsIndexConfig } from "./fts5.js";
async function invokedCallbackReset(indexFile, vaultRoot) {
  const discovered = await discoverFtsIndexConfig(indexFile, vaultRoot);
  let tokenize = discovered.kind === "owned" ? discovered.meta.tokenize_mode : "unicode61";
  await Promise.resolve().then(() => { tokenize = "unicode61"; });
  return new FtsIndex({ file: indexFile, vaultRoot, tokenize });
}`;
    const callbackResetViolations = analyzeSource("src/discovery-callback-reset.ts", invokedCallbackReset);
    expect(callbackResetViolations).toHaveLength(1);
    expect(callbackResetViolations[0]?.reason).toMatch(/underived: tokenize/);

    const invokedObjectMethodReset = `
import { discoverFtsIndexConfig } from "./fts5.js";
async function invokedObjectMethodReset(indexFile, vaultRoot) {
  const discovered = await discoverFtsIndexConfig(indexFile, vaultRoot);
  let tokenize = discovered.kind === "owned" ? discovered.meta.tokenize_mode : "unicode61";
  const helpers = { reset() { tokenize = "unicode61"; } };
  helpers.reset();
  return new FtsIndex({ file: indexFile, vaultRoot, tokenize });
}`;
    const objectMethodResetViolations = analyzeSource("src/discovery-object-method-reset.ts", invokedObjectMethodReset);
    expect(objectMethodResetViolations).toHaveLength(1);
    expect(objectMethodResetViolations[0]?.reason).toMatch(/underived: tokenize/);

    const invokedObjectAliasReset = `
import { discoverFtsIndexConfig } from "./fts5.js";
async function invokedObjectAliasReset(indexFile, vaultRoot) {
  const discovered = await discoverFtsIndexConfig(indexFile, vaultRoot);
  let tokenize = discovered.kind === "owned" ? discovered.meta.tokenize_mode : "unicode61";
  const reset = () => { tokenize = "unicode61"; };
  const helpers = { reset };
  helpers.reset();
  return new FtsIndex({ file: indexFile, vaultRoot, tokenize });
}`;
    const objectAliasResetViolations = analyzeSource("src/discovery-object-alias-reset.ts", invokedObjectAliasReset);
    expect(objectAliasResetViolations).toHaveLength(1);
    expect(objectAliasResetViolations[0]?.reason).toMatch(/underived: tokenize/);

    const capturedGetterReset = `
import { discoverFtsIndexConfig } from "./fts5.js";
async function capturedGetterReset(indexFile, vaultRoot) {
  const discovered = await discoverFtsIndexConfig(indexFile, vaultRoot);
  let tokenize = discovered.kind === "owned" ? discovered.meta.tokenize_mode : "unicode61";
  const helpers = {
    get reset() { tokenize = "unicode61"; return 0; }
  };
  void helpers.reset;
  return new FtsIndex({ file: indexFile, vaultRoot, tokenize });
}`;
    const getterResetViolations = analyzeSource("src/discovery-getter-reset.ts", capturedGetterReset);
    expect(getterResetViolations).toHaveLength(1);
    expect(getterResetViolations[0]?.reason).toMatch(/underived: tokenize/);

    const capturedPromiseExecutor = `
import { discoverFtsIndexConfig } from "./fts5.js";
async function capturedPromiseExecutor(indexFile, vaultRoot) {
  const discovered = await discoverFtsIndexConfig(indexFile, vaultRoot);
  let tokenize = discovered.kind === "owned" ? discovered.meta.tokenize_mode : "unicode61";
  await new Promise((resolve) => {
    tokenize = "unicode61";
    resolve(undefined);
  });
  return new FtsIndex({ file: indexFile, vaultRoot, tokenize });
}`;
    const promiseExecutorViolations = analyzeSource("src/discovery-promise-executor.ts", capturedPromiseExecutor);
    expect(promiseExecutorViolations).toHaveLength(1);
    expect(promiseExecutorViolations[0]?.reason).toMatch(/underived: tokenize/);

    const mutatedDiscoveredMeta = `
import { discoverFtsIndexConfig } from "./fts5.js";
async function mutatedDiscoveredMeta(indexFile, vaultRoot) {
  const discovered = await discoverFtsIndexConfig(indexFile, vaultRoot);
  if (discovered.kind === "owned") discovered.meta.tokenize_mode = "unicode61";
  const tokenize = discovered.kind === "owned" ? discovered.meta.tokenize_mode : "unicode61";
  return new FtsIndex({ file: indexFile, vaultRoot, tokenize });
}`;
    const mutatedMetaViolations = analyzeSource("src/discovery-mutated-meta.ts", mutatedDiscoveredMeta);
    expect(mutatedMetaViolations).toHaveLength(1);
    expect(mutatedMetaViolations[0]?.reason).toMatch(/underived: tokenize/);

    const mutatedMetaAlias = `
import { discoverFtsIndexConfig } from "./fts5.js";
async function mutatedMetaAlias(indexFile, vaultRoot) {
  const discovered = await discoverFtsIndexConfig(indexFile, vaultRoot);
  if (discovered.kind === "owned") {
    const meta = discovered.meta;
    meta.tokenize_mode = "unicode61";
  }
  const tokenize = discovered.kind === "owned" ? discovered.meta.tokenize_mode : "unicode61";
  return new FtsIndex({ file: indexFile, vaultRoot, tokenize });
}`;
    const mutatedMetaAliasViolations = analyzeSource("src/discovery-mutated-meta-alias.ts", mutatedMetaAlias);
    expect(mutatedMetaAliasViolations).toHaveLength(1);
    expect(mutatedMetaAliasViolations[0]?.reason).toMatch(/underived: tokenize/);

    const mutatedStoredConfiguration = `
import { discoverEmbedDbConfig } from "./embed-db.js";
import { resolveModel, resolveStoredEmbeddingConfiguration } from "./embeddings.js";
async function mutatedStoredConfiguration(embedFile, vaultRoot) {
  const discovered = await discoverEmbedDbConfig(embedFile, vaultRoot);
  const stored =
    discovered.kind === "owned" ? resolveStoredEmbeddingConfiguration(discovered.meta) : null;
  if (stored) stored.quantization = "int8";
  const model = stored?.model ?? resolveModel(undefined);
  const quantization = stored?.quantization ?? "f32";
  return new EmbedDb({
    file: embedFile,
    vaultRoot,
    modelAlias: model.alias,
    dim: model.dim,
    quantization
  });
}`;
    const mutatedStoredViolations = analyzeSource(
      "src/discovery-mutated-stored-configuration.ts",
      mutatedStoredConfiguration
    );
    expect(mutatedStoredViolations).toHaveLength(1);
    expect(mutatedStoredViolations[0]?.reason).toMatch(/underived: quantization/);

    const mutatedModelAlias = `
import { discoverEmbedDbConfig } from "./embed-db.js";
import { resolveModel, resolveStoredEmbeddingConfiguration } from "./embeddings.js";
async function mutatedModelAlias(embedFile, vaultRoot) {
  const discovered = await discoverEmbedDbConfig(embedFile, vaultRoot);
  const stored =
    discovered.kind === "owned" ? resolveStoredEmbeddingConfiguration(discovered.meta) : null;
  const model = stored?.model ?? resolveModel(undefined);
  model.alias = "multilingual";
  const quantization = stored?.quantization ?? "f32";
  return new EmbedDb({
    file: embedFile,
    vaultRoot,
    modelAlias: model.alias,
    dim: model.dim,
    quantization
  });
}`;
    const mutatedModelViolations = analyzeSource("src/discovery-mutated-model.ts", mutatedModelAlias);
    expect(mutatedModelViolations).toHaveLength(1);
    expect(mutatedModelViolations[0]?.reason).toMatch(/underived: modelAlias/);

    const droppedOpenDiscovery = `
import { discoverFtsIndexConfig } from "./fts5.js";
async function droppedOpenDiscovery(indexFile, vaultRoot) {
  const discovered = await discoverFtsIndexConfig(indexFile, vaultRoot);
  const tokenize = discovered.kind === "owned" ? discovered.meta.tokenize_mode : "unicode61";
  const index = new FtsIndex({ file: indexFile, vaultRoot, tokenize });
  await index.open();
  return index;
}`;
    const droppedOpenViolations = analyzeSource("src/discovery-dropped-open.ts", droppedOpenDiscovery);
    expect(droppedOpenViolations).toHaveLength(1);
    expect(droppedOpenViolations[0]?.reason).toMatch(/first awaited open\(\).*same exact/);

    const wrongOpenDiscovery = `
import { discoverFtsIndexConfig } from "./fts5.js";
async function wrongOpenDiscovery(indexFile, vaultRoot) {
  const configuredFrom = await discoverFtsIndexConfig(indexFile, vaultRoot);
  const openedFrom = await discoverFtsIndexConfig(indexFile, vaultRoot);
  const tokenize =
    configuredFrom.kind === "owned" ? configuredFrom.meta.tokenize_mode : "unicode61";
  const index = new FtsIndex({ file: indexFile, vaultRoot, tokenize });
  await index.open(openedFrom);
  return index;
}`;
    const wrongOpenViolations = analyzeSource("src/discovery-wrong-open.ts", wrongOpenDiscovery);
    expect(wrongOpenViolations).toHaveLength(1);
    expect(wrongOpenViolations[0]?.reason).toMatch(/first awaited open\(\).*same exact/);

    const wrappedOpenDiscovery = `
import { discoverFtsIndexConfig } from "./fts5.js";
async function wrappedOpenDiscovery(indexFile, vaultRoot, identity) {
  const discovered = await discoverFtsIndexConfig(indexFile, vaultRoot);
  const tokenize = discovered.kind === "owned" ? discovered.meta.tokenize_mode : "unicode61";
  const index = new FtsIndex({ file: indexFile, vaultRoot, tokenize });
  await index.open(identity(discovered));
  return index;
}`;
    const wrappedOpenViolations = analyzeSource("src/discovery-wrapped-open.ts", wrappedOpenDiscovery);
    expect(wrappedOpenViolations).toHaveLength(1);
    expect(wrappedOpenViolations[0]?.reason).toMatch(/first awaited open\(\).*same exact/);

    const conditionalOpenDiscovery = `
import { discoverFtsIndexConfig } from "./fts5.js";
async function conditionalOpenDiscovery(indexFile, vaultRoot, runtimeFlag) {
  const discovered = await discoverFtsIndexConfig(indexFile, vaultRoot);
  const tokenize = discovered.kind === "owned" ? discovered.meta.tokenize_mode : "unicode61";
  const index = new FtsIndex({ file: indexFile, vaultRoot, tokenize });
  if (runtimeFlag) await index.open(discovered);
  return index;
}`;
    const conditionalOpenViolations = analyzeSource("src/discovery-conditional-open.ts", conditionalOpenDiscovery);
    expect(conditionalOpenViolations).toHaveLength(1);
    expect(conditionalOpenViolations[0]?.reason).toMatch(/first awaited open\(\).*same exact/);

    const deadOpenDiscovery = `
import { discoverFtsIndexConfig } from "./fts5.js";
async function deadOpenDiscovery(indexFile, vaultRoot) {
  const discovered = await discoverFtsIndexConfig(indexFile, vaultRoot);
  const tokenize = discovered.kind === "owned" ? discovered.meta.tokenize_mode : "unicode61";
  const index = new FtsIndex({ file: indexFile, vaultRoot, tokenize });
  if (false) await index.open(discovered);
  return index;
}`;
    const deadOpenViolations = analyzeSource("src/discovery-dead-open.ts", deadOpenDiscovery);
    expect(deadOpenViolations).toHaveLength(1);
    expect(deadOpenViolations[0]?.reason).toMatch(/first awaited open\(\).*same exact/);

    const swallowedOpenDiscovery = `
import { discoverFtsIndexConfig } from "./fts5.js";
async function swallowedOpenDiscovery(indexFile, vaultRoot) {
  const discovered = await discoverFtsIndexConfig(indexFile, vaultRoot);
  const tokenize = discovered.kind === "owned" ? discovered.meta.tokenize_mode : "unicode61";
  const index = new FtsIndex({ file: indexFile, vaultRoot, tokenize });
  try {
    await index.open(discovered);
  } catch {}
  return index;
}`;
    const swallowedOpenViolations = analyzeSource("src/discovery-swallowed-open.ts", swallowedOpenDiscovery);
    expect(swallowedOpenViolations).toHaveLength(1);
    expect(swallowedOpenViolations[0]?.reason).toMatch(/first awaited open\(\).*same exact/);

    const returnedFailedOpenInstance = `
import { discoverFtsIndexConfig } from "./fts5.js";
async function returnedFailedOpenInstance(indexFile, vaultRoot) {
  const discovered = await discoverFtsIndexConfig(indexFile, vaultRoot);
  const tokenize = discovered.kind === "owned" ? discovered.meta.tokenize_mode : "unicode61";
  const index = new FtsIndex({ file: indexFile, vaultRoot, tokenize });
  try {
    await index.open(discovered);
  } catch {
    return index;
  }
  return index;
}`;
    const returnedFailedOpenViolations = analyzeSource(
      "src/discovery-returned-failed-open.ts",
      returnedFailedOpenInstance
    );
    expect(returnedFailedOpenViolations).toHaveLength(1);
    expect(returnedFailedOpenViolations[0]?.reason).toMatch(/first awaited open\(\).*same exact/);

    const invokedPreopenClosure = `
import { discoverFtsIndexConfig } from "./fts5.js";
async function invokedPreopenClosure(indexFile, vaultRoot) {
  const discovered = await discoverFtsIndexConfig(indexFile, vaultRoot);
  const tokenize = discovered.kind === "owned" ? discovered.meta.tokenize_mode : "unicode61";
  const index = new FtsIndex({ file: indexFile, vaultRoot, tokenize });
  const preopen = async () => { await index.open(); };
  await preopen();
  await index.open(discovered);
  return index;
}`;
    const preopenClosureViolations = analyzeSource("src/discovery-invoked-preopen.ts", invokedPreopenClosure);
    expect(preopenClosureViolations).toHaveLength(1);
    expect(preopenClosureViolations[0]?.reason).toMatch(/first awaited open\(\).*same exact/);

    const reassignedOpenDiscovery = `
import { discoverFtsIndexConfig } from "./fts5.js";
async function reassignedOpenDiscovery(indexFile, vaultRoot) {
  let discovered = await discoverFtsIndexConfig(indexFile, vaultRoot);
  const tokenize = discovered.kind === "owned" ? discovered.meta.tokenize_mode : "unicode61";
  const index = new FtsIndex({ file: indexFile, vaultRoot, tokenize });
  discovered = await discoverFtsIndexConfig(indexFile, vaultRoot);
  await index.open(discovered);
  return index;
}`;
    const reassignedOpenViolations = analyzeSource("src/discovery-reassigned-open.ts", reassignedOpenDiscovery);
    expect(reassignedOpenViolations).toHaveLength(1);
    expect(reassignedOpenViolations[0]?.reason).toMatch(/first awaited open\(\).*same exact/);

    const nestedNullableGuard = `
import { discoverEmbedDbConfig } from "./embed-db.js";
import { resolveModel, resolveStoredEmbeddingConfiguration } from "./embeddings.js";
async function nestedNullableGuard(embedFile, vaultRoot, skip, runtimeFlag) {
  const discovered = skip ? null : await discoverEmbedDbConfig(embedFile, vaultRoot);
  if (runtimeFlag) {
    if (skip) return;
  }
  const stored =
    discovered?.kind === "owned" ? resolveStoredEmbeddingConfiguration(discovered.meta) : null;
  const model = stored?.model ?? resolveModel(undefined);
  const quantization = stored?.quantization ?? "f32";
  const db = new EmbedDb({
    file: embedFile,
    vaultRoot,
    modelAlias: model.alias,
    dim: model.dim,
    quantization
  });
  await db.open(discovered);
}`;
    const nestedGuardViolations = analyzeSource("src/discovery-nested-null-guard.ts", nestedNullableGuard);
    expect(nestedGuardViolations).toHaveLength(1);
    expect(nestedGuardViolations[0]?.reason).toMatch(/underived:/);

    const equalityQuantizationGuard = `
import { discoverEmbedDbConfig } from "./embed-db.js";
import { resolveModel, resolveStoredEmbeddingConfiguration } from "./embeddings.js";
import { parseQuantizationMode } from "./tool-registry.js";
async function equalityQuantizationGuard(embedFile, vaultRoot, opts, command) {
  const explicitQuant = command.getOptionValueSource("quantizeEmbeddings") === "cli";
  const discovered = await discoverEmbedDbConfig(embedFile, vaultRoot);
  const stored =
    discovered.kind === "owned" ? resolveStoredEmbeddingConfiguration(discovered.meta) : null;
  const model = stored?.model ?? resolveModel(undefined);
  const requestedQuant = parseQuantizationMode(opts.quantizeEmbeddings) ?? "f32";
  let quantization = requestedQuant;
  if (!explicitQuant && stored && stored.quantization === requestedQuant) {
    quantization = stored.quantization;
  }
  return new EmbedDb({
    file: embedFile,
    vaultRoot,
    modelAlias: model.alias,
    dim: model.dim,
    quantization
  });
}`;
    const equalityQuantizationViolations = analyzeSource(
      "src/discovery-equality-quantization.ts",
      equalityQuantizationGuard
    );
    expect(equalityQuantizationViolations).toHaveLength(1);
    expect(equalityQuantizationViolations[0]?.reason).toMatch(/underived: quantization/);
  });

  it("NEGATIVE: fixtures/k1-invariant/bad-no-peek.ts has ≥1 unguarded site (no peek call)", async () => {
    const unguarded = await analyzeFile(path.join(FIXTURE_DIR, "bad-no-peek.ts"), true);
    expect(unguarded.length).toBeGreaterThanOrEqual(1);
    expect(unguarded[0]?.className).toBe("FtsIndex");
  });

  it("WHOLE-SRC: zero unguarded constructors across the real src/ tree", async () => {
    const SRC = path.join(process.cwd(), "src");
    const files = await collectTs(SRC);
    const allUnguarded: UnguardedSite[] = [];
    for (const file of files) {
      const u = await analyzeFile(file);
      allUnguarded.push(...u);
    }
    if (allUnguarded.length > 0) {
      const detail = allUnguarded
        .map((u) => `  ${path.relative(process.cwd(), u.file)}:${u.line} (${u.className}) — ${u.reason}`)
        .join("\n");
      const argNames = [...K1_ARG_NAMES].join("/");
      expect.fail(
        `K-1 AST invariant violated in src/. Constructors below have K-1 args (${argNames}) ` +
          "that do not all trace through exact lexical bindings to a pre-constructor " +
          `configuration-discovery result:\n${detail}\n\nFix: thread the discriminated discovery result ` +
          "into every required K-1 argument and into the exact instance's first awaited " +
          "open(discovery). Only the two reviewed clearOnDisk-only CLI constructors may use " +
          "an actual leading `// SAFE BY DESIGN: <reason>` comment."
      );
    }
    expect(allUnguarded.length).toBe(0);
  });
});
