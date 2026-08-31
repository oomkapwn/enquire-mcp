// Pure structural analyzer for OIA Check 12c.
//
// Vitest normally rejects `.only` in CI. A test file can override that default
// at runtime with `vi.setConfig({ allowOnly: true })`, however, and then focus a
// passing decoy while silently skipping repository-integrity tests. This module
// deliberately runs outside Vitest and scans every first-party executable
// TypeScript/JavaScript source instead of relying on an import graph that a
// loader spelling can evade.

import { readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import ts from "typescript";

const SOURCE_EXTENSIONS = new Set([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);
const ONLY_CONTROL = ["on", "ly"].join("");
const ALLOW_ONLY_CONTROL = ["allow", "Only"].join("");
const SET_CONFIG_CONTROL = ["set", "Config"].join("");
const TARGET_CONTROLS = new Set([ALLOW_ONLY_CONTROL, ONLY_CONTROL, SET_CONFIG_CONTROL]);
const MAX_TARGET_CONTROL_LENGTH = Math.max(...[...TARGET_CONTROLS].map((control) => control.length));
const OPAQUE_TOP_LEVEL_DIRS = new Set([".git", "coverage", "dist", "node_modules"]);
const GENERATED_EXECUTABLE_DIRS = new Set([
  ".mcpb-stage",
  ".pages-dist",
  ".vitest-cache",
  "docs/api-reference",
  "false"
]);
const FOCUS_CONTROL_HINT =
  "A reserved Vitest focus/runtime-config spelling appears on a guarded executable surface. Remove the control " +
  "or rewrite benign data flow; use CLI test-name filters only for local diagnostics.";

function scriptKindFor(filename) {
  switch (extname(filename)) {
    case ".js":
    case ".mjs":
    case ".cjs":
      return ts.ScriptKind.JS;
    case ".jsx":
      return ts.ScriptKind.JSX;
    case ".tsx":
      return ts.ScriptKind.TSX;
    default:
      return ts.ScriptKind.TS;
  }
}

function unwrapStaticExpression(expression) {
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

function staticString(expression, cache) {
  if (!expression) return undefined;
  const current = unwrapStaticExpression(expression);
  if (cache.has(current)) return cache.get(current);
  let value;
  if (ts.isStringLiteralLike(current)) {
    value = current.text.length <= MAX_TARGET_CONTROL_LENGTH ? current.text : undefined;
  }
  if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticString(current.left, cache);
    if (left !== undefined) {
      const right = staticString(current.right, cache);
      if (right !== undefined && left.length + right.length <= MAX_TARGET_CONTROL_LENGTH) {
        value = `${left}${right}`;
      }
    }
  }
  if (ts.isTemplateExpression(current)) {
    value = current.head.text.length <= MAX_TARGET_CONTROL_LENGTH ? current.head.text : undefined;
    if (value !== undefined) {
      for (const span of current.templateSpans) {
        const part = staticString(span.expression, cache);
        const suffix = span.literal.text;
        if (part === undefined || value.length + part.length + suffix.length > MAX_TARGET_CONTROL_LENGTH) {
          value = undefined;
          break;
        }
        value += part + suffix;
      }
    }
  }
  cache.set(current, value);
  return value;
}

function staticPropertyName(name, cache) {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
  return ts.isComputedPropertyName(name) ? staticString(name.expression, cache) : undefined;
}

function bindingPropertyName(binding, cache) {
  if (!ts.isObjectBindingPattern(binding.parent)) return undefined;
  if (binding.propertyName) return staticPropertyName(binding.propertyName, cache);
  return ts.isIdentifier(binding.name) ? binding.name.text : undefined;
}

function hasModifier(node, kind) {
  return node.modifiers?.some((modifier) => modifier.kind === kind) ?? false;
}

function isErasedAbstractMember(node) {
  return (
    (ts.isPropertyDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)) &&
    hasModifier(node, ts.SyntaxKind.AbstractKeyword)
  );
}

function isErasedSignature(node) {
  return (
    ts.isIndexSignatureDeclaration(node) ||
    ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)) &&
      node.body === undefined)
  );
}

function runtimeExpressionWithTypeArguments(node) {
  if (!ts.isExpressionWithTypeArguments(node)) return undefined;
  const parent = node.parent;
  if (parent.kind === ts.SyntaxKind.JSDocAugmentsTag || parent.kind === ts.SyntaxKind.JSDocImplementsTag) {
    return undefined;
  }
  if (!ts.isHeritageClause(parent)) return node.expression;
  if (parent.token !== ts.SyntaxKind.ExtendsKeyword) return undefined;
  const owner = parent.parent;
  return ts.isClassDeclaration(owner) || ts.isClassExpression(owner) ? node.expression : undefined;
}

function decodeJsxTargetEntities(text) {
  // TypeScript 6.0.3's JSX emitter decodes decimal/lowercase-x hexadecimal
  // numeric references plus its HTML4 named-entity table. Numeric references
  // are the only entries capable of synthesizing ASCII letters: the five
  // ASCII named values are punctuation and every other named value is
  // non-ASCII. Leaving named references spelled is therefore decision-
  // equivalent when comparing only the three ASCII TARGET_CONTROLS.
  return text.replace(/&#(?:(\d+)|x([\da-fA-F]+));/gu, (match, decimal, hex) => {
    const encoded = decimal ?? hex;
    if (encoded === undefined) return match;
    const value = Number.parseInt(encoded, decimal === undefined ? 16 : 10);
    return Number.isInteger(value) && value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : match;
  });
}

function jsxRuntimeText(text) {
  /** @type {string | undefined} */
  let value;
  let firstNonWhitespace = 0;
  let lastNonWhitespace = -1;
  const addLine = (line) => {
    const decoded = decodeJsxTargetEntities(line);
    value = value === undefined ? decoded : `${value} ${decoded}`;
  };
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (ts.isLineBreak(code)) {
      if (firstNonWhitespace !== -1 && lastNonWhitespace !== -1) {
        addLine(text.slice(firstNonWhitespace, lastNonWhitespace + 1));
      }
      firstNonWhitespace = -1;
    } else if (!ts.isWhiteSpaceSingleLine(code)) {
      lastNonWhitespace = index;
      if (firstNonWhitespace === -1) firstNonWhitespace = index;
    }
  }
  if (firstNonWhitespace !== -1) addLine(text.slice(firstNonWhitespace));
  return value ?? "";
}

function lineEvidence(source, sourceFile, node) {
  const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line;
  return (source.split(/\r\n|[\n\r\u2028\u2029]/u)[line] ?? "").trim();
}

function findingFor(name, source, sourceFile, filename, node) {
  const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const kind =
    name === ONLY_CONTROL
      ? "VITEST-FOCUS-ONLY"
      : name === ALLOW_ONLY_CONTROL
        ? "VITEST-ALLOW-ONLY"
        : "VITEST-RUNTIME-CONFIG";
  return {
    evidence: lineEvidence(source, sourceFile, node),
    file: filename,
    hint: FOCUS_CONTROL_HINT,
    kind,
    line
  };
}

/**
 * Inspect one executable source for statically named Vitest focus/config controls.
 *
 * Comments, compound/non-reserved prose strings, static module specifiers,
 * undecorated ambient/declaration-file syntax, type parameters, abstract erased
 * members, and other type nodes are ignored. Runtime decorators on otherwise
 * erased declarations are still visited. Exact reserved runtime identifiers and
 * string values, plus literal-only concatenated/template values anywhere in
 * executable syntax, fail closed. Runtime import/export bindings,
 * class/parameter-property names, runtime class-extends expressions, JSX
 * attributes/text (including TypeScript's physical-line whitespace semantics
 * for text and numeric-entity semantics for text plus quoted attributes),
 * property access, object literals, and destructuring are therefore covered by
 * one policy.
 * A variable/parameter statically initialized to a reserved control name is
 * rejected even when unused; this conservative rule prevents cross-file key
 * exports from escaping per-file resolution. Same-file or cross-file
 * composition through identifiers holding individually non-reserved fragments,
 * runtime-computed keys, non-executable data-file indirection, and generated/eval
 * code are intentionally outside scope. Declaration files remain excluded, but
 * any parse diagnostic in an executable source throws so TypeScript's recovery
 * AST cannot silently turn an unparsed control surface into a clean result.
 *
 * @param {string} source Source text to inspect.
 * @param {string} filename Repository-relative diagnostic filename.
 * @returns {Array<{evidence: string, file: string, hint: string, kind: string, line: number}>} Findings.
 */
export function inspectStaticVitestFocusControls(source, filename) {
  const sourceFile = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, scriptKindFor(filename));
  if (sourceFile.isDeclarationFile) return [];
  const parseDiagnostic = sourceFile.parseDiagnostics[0];
  if (parseDiagnostic !== undefined) {
    const position = Math.min(Math.max(parseDiagnostic.start ?? 0, 0), source.length);
    const location = sourceFile.getLineAndCharacterOfPosition(position);
    const message = ts.flattenDiagnosticMessageText(parseDiagnostic.messageText, " ").trim();
    throw new SyntaxError(
      `focus-control parse failure in ${filename}:${location.line + 1}:${location.character + 1}: ` +
        `TS${parseDiagnostic.code}: ${message}`
    );
  }
  const hits = new Map();
  const staticStringCache = new WeakMap();
  const record = (name, node) => {
    if (!TARGET_CONTROLS.has(name)) return;
    if (!hits.has(name)) hits.set(name, findingFor(name, source, sourceFile, filename, node));
  };
  const visit = (node) => {
    const runtimeTypedExpression = runtimeExpressionWithTypeArguments(node);
    if (runtimeTypedExpression !== undefined) {
      visit(runtimeTypedExpression);
      return;
    }
    const isErasedNode =
      ts.isTypeNode(node) ||
      ts.isTypeParameterDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      hasModifier(node, ts.SyntaxKind.DeclareKeyword) ||
      isErasedAbstractMember(node) ||
      isErasedSignature(node);
    if (isErasedNode) {
      if (ts.canHaveDecorators(node)) {
        for (const decorator of ts.getDecorators(node) ?? []) visit(decorator.expression);
      }
      return;
    }
    if (ts.isImportEqualsDeclaration(node)) {
      if (node.isTypeOnly) return;
      record(node.name.text, node.name);
      if (!ts.isExternalModuleReference(node.moduleReference)) {
        ts.forEachChild(node.moduleReference, visit);
      }
      return;
    }
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const isRuntimeImport = clause === undefined || !clause.isTypeOnly;
      if (clause !== undefined && isRuntimeImport) {
        if (clause.name) record(clause.name.text, clause.name);
        const bindings = clause.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) {
          record(bindings.name.text, bindings.name);
        } else if (bindings && ts.isNamedImports(bindings)) {
          for (const binding of bindings.elements) {
            if (binding.isTypeOnly) continue;
            if (binding.propertyName) record(binding.propertyName.text, binding.propertyName);
            record(binding.name.text, binding.name);
          }
        }
      }
      const attributes = node.attributes ?? node.assertClause;
      if (isRuntimeImport && attributes !== undefined) ts.forEachChild(attributes, visit);
      return;
    }
    if (ts.isExportDeclaration(node)) {
      if (!node.isTypeOnly && node.exportClause !== undefined) {
        if (ts.isNamespaceExport(node.exportClause)) {
          record(node.exportClause.name.text, node.exportClause.name);
        } else {
          for (const binding of node.exportClause.elements) {
            if (binding.isTypeOnly) continue;
            if (binding.propertyName) record(binding.propertyName.text, binding.propertyName);
            record(binding.name.text, binding.name);
          }
        }
      }
      const attributes = node.attributes ?? node.assertClause;
      if (!node.isTypeOnly && attributes !== undefined) ts.forEachChild(attributes, visit);
      return;
    }
    if (ts.isIdentifier(node)) {
      record(node.text, node);
      return;
    }
    if (ts.isStringLiteralLike(node)) {
      record(ts.isJsxAttribute(node.parent) ? decodeJsxTargetEntities(node.text) : node.text, node);
      return;
    }
    if (ts.isJsxText(node)) {
      record(jsxRuntimeText(node.text), node);
      return;
    }
    if (
      (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) ||
      ts.isTemplateExpression(node)
    ) {
      record(staticString(node, staticStringCache), node);
    }
    if (ts.isPropertyAccessExpression(node)) {
      record(node.name.text, node.name);
    } else if (ts.isBindingElement(node)) {
      record(bindingPropertyName(node, staticStringCache), node);
    } else if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (ts.isSpreadAssignment(property)) continue;
        const name = ts.isShorthandPropertyAssignment(property)
          ? property.name.text
          : staticPropertyName(property.name, staticStringCache);
        record(name, property);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...hits.values()].sort((left, right) => left.line - right.line || left.kind.localeCompare(right.kind));
}

/**
 * Enumerate the complete first-party JavaScript/TypeScript executable-source census.
 *
 * Only exact generated/install roots declared in `.gitignore` and Git metadata
 * are excluded; every other repository directory, including near-miss names,
 * is traversed.
 *
 * @param {string} repoRoot Absolute repository root.
 * @returns {string[]} Sorted repository-relative source paths.
 */
export function firstPartyVitestFocusSourceFiles(repoRoot) {
  const files = [];
  const walk = (relativeDirectory) => {
    const absoluteDirectory = relativeDirectory === "" ? repoRoot : join(repoRoot, relativeDirectory);
    for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
      const relativeEntry = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
      if (relativeDirectory === "" && OPAQUE_TOP_LEVEL_DIRS.has(entry.name)) continue;
      if (entry.isSymbolicLink()) {
        throw new Error(`focus-control source census refuses symbolic link ${relativeEntry}`);
      }
      if (entry.isDirectory() && GENERATED_EXECUTABLE_DIRS.has(relativeEntry)) continue;
      if (entry.isDirectory()) {
        walk(relativeEntry);
      } else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) files.push(relativeEntry);
    }
  };
  walk("");
  return [...new Set(files)].sort();
}

/**
 * Inspect every first-party executable source independently of the test runner.
 *
 * @param {string} repoRoot Absolute repository root.
 * @returns {Array<{evidence: string, file: string, hint: string, kind: string, line: number}>} Findings.
 */
export function inspectRepositoryVitestFocusControls(repoRoot) {
  return firstPartyVitestFocusSourceFiles(repoRoot).flatMap((filename) =>
    inspectStaticVitestFocusControls(readFileSync(join(repoRoot, filename), "utf8"), filename)
  );
}
