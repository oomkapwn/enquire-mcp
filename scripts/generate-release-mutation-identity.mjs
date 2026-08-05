#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TEST_PATH = join(ROOT, "tests/release-integrity.test.ts");
const NORMALIZER = "release-matrix-balanced-v2";
const SOURCE_COMMIT = "8420e2fca3ed0dac994859a9e9a30b933d5ddf9e";
const SOURCE_SHA256 = "3fa0b67411e2fc0f4d7c6bce6075ba91eb25edc19a210b5c2f8dd408def6e18b";
const MATRIX_SLICE_SHA256 = "caca0093c744df9f6c6cdd0e8200fd8df45052e784297079887ea48686c5e07f";
const MATRIX_TITLE = "keeps release.yml wired to the shared evaluator and an exact mirrored inventory";
const MATRIX_PREFIX = "    const releaseWorkflow = readFileSync(";
const MATRIX_START = `${MATRIX_PREFIX}new URL("../.github/workflows/release.yml", import.meta.url), "utf8");`;
const MATRIX_END = "  }, 120_000);";
const CALL_NAMES = ["replaceExactly", "replaceAllExactly"];
const RAW_ASSERTION_CENSUS = 332;
const REGEX_PREFIX_KEYWORDS = new Set([
  "await",
  "case",
  "delete",
  "do",
  "else",
  "in",
  "instanceof",
  "of",
  "return",
  "throw",
  "typeof",
  "void",
  "yield"
]);
const REGEX_PREFIX_OPERATORS = "(:,=![{?;|&>";
const PAIRS = new Map([
  ["(", ")"],
  ["[", "]"],
  ["{", "}"]
]);

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function semanticFingerprint(value) {
  return `sha256:${digest(value)}`;
}

function canonical(value) {
  return JSON.stringify(value);
}

function compact(value) {
  return value.replace(/\s+/gu, " ").trim();
}

function fail(message) {
  throw new Error(`release mutation identity generator: ${message}`);
}

function skipLineComment(text, index) {
  const end = text.indexOf("\n", index + 2);
  return end === -1 ? text.length : end;
}

function skipBlockComment(text, index) {
  const end = text.indexOf("*/", index + 2);
  if (end === -1) fail("unterminated block comment");
  return end + 2;
}

function skipQuoted(text, index, quote) {
  for (let cursor = index + 1; cursor < text.length; cursor++) {
    if (text[cursor] === "\\") {
      cursor++;
      continue;
    }
    if (text[cursor] === quote) return cursor + 1;
  }
  fail(`unterminated ${quote} string`);
}

function regexCanStart(text, index) {
  let cursor = index - 1;
  while (cursor >= 0 && /\s/u.test(text[cursor])) cursor--;
  if (cursor < 0 || REGEX_PREFIX_OPERATORS.includes(text[cursor])) return true;
  const end = cursor + 1;
  while (cursor >= 0 && identifierPart(text[cursor])) cursor--;
  return REGEX_PREFIX_KEYWORDS.has(text.slice(cursor + 1, end));
}

function skipRegex(text, index) {
  let inClass = false;
  for (let cursor = index + 1; cursor < text.length; cursor++) {
    const char = text[cursor];
    if (char === "\\") {
      cursor++;
      continue;
    }
    if (char === "[") inClass = true;
    else if (char === "]") inClass = false;
    else if (char === "/" && !inClass) {
      cursor++;
      while (cursor < text.length && /[A-Za-z]/u.test(text[cursor])) cursor++;
      return cursor;
    } else if (char === "\r" || char === "\n") fail("unterminated regular expression");
  }
  fail("unterminated regular expression");
}

function skipTrivia(text, index) {
  let cursor = index;
  while (cursor < text.length) {
    if (/\s/u.test(text[cursor])) cursor++;
    else if (text.startsWith("//", cursor)) cursor = skipLineComment(text, cursor);
    else if (text.startsWith("/*", cursor)) cursor = skipBlockComment(text, cursor);
    else break;
  }
  return cursor;
}

function balancedEnd(text, openIndex) {
  const firstCloser = PAIRS.get(text[openIndex]);
  if (firstCloser === undefined) fail(`unrecognized balanced opener at ${openIndex}`);
  const stack = [firstCloser];
  for (let cursor = openIndex + 1; cursor < text.length; cursor++) {
    const char = text[cursor];
    if (char === "'" || char === '"' || char === "`") {
      cursor = skipQuoted(text, cursor, char) - 1;
      continue;
    }
    if (text.startsWith("//", cursor)) {
      cursor = skipLineComment(text, cursor) - 1;
      continue;
    }
    if (text.startsWith("/*", cursor)) {
      cursor = skipBlockComment(text, cursor) - 1;
      continue;
    }
    if (char === "/" && regexCanStart(text, cursor)) {
      cursor = skipRegex(text, cursor) - 1;
      continue;
    }
    const closer = PAIRS.get(char);
    if (closer !== undefined) stack.push(closer);
    else if (char === stack.at(-1)) {
      stack.pop();
      if (stack.length === 0) return cursor;
    }
  }
  fail(`unterminated balanced token at ${openIndex}`);
}

function splitTopSpans(text, separator = ",") {
  const spans = [];
  const stack = [];
  let start = 0;
  for (let cursor = 0; cursor < text.length; cursor++) {
    const char = text[cursor];
    if (char === "'" || char === '"' || char === "`") {
      cursor = skipQuoted(text, cursor, char) - 1;
      continue;
    }
    if (text.startsWith("//", cursor)) {
      cursor = skipLineComment(text, cursor) - 1;
      continue;
    }
    if (text.startsWith("/*", cursor)) {
      cursor = skipBlockComment(text, cursor) - 1;
      continue;
    }
    if (char === "/" && regexCanStart(text, cursor)) {
      cursor = skipRegex(text, cursor) - 1;
      continue;
    }
    const closer = PAIRS.get(char);
    if (closer !== undefined) stack.push(closer);
    else if (stack.length > 0 && char === stack.at(-1)) stack.pop();
    else if (stack.length === 0 && text.startsWith(separator, cursor)) {
      spans.push([start, cursor]);
      start = cursor + separator.length;
      cursor += separator.length - 1;
    }
  }
  spans.push([start, text.length]);
  return spans;
}

function splitTop(text, separator = ",") {
  return splitTopSpans(text, separator).map(([start, end]) => text.slice(start, end).trim());
}

function stripOuterParens(expression) {
  let value = expression.trim();
  while (value.startsWith("(") && balancedEnd(value, 0) === value.length - 1) {
    value = value.slice(1, -1).trim();
  }
  return value;
}

function decodeJsString(expression) {
  const quote = expression[0];
  if (expression.at(-1) !== quote) {
    fail(`malformed string literal ${compact(expression).slice(0, 80)}`);
  }
  let output = "";
  const escapes = new Map([
    ["n", "\n"],
    ["r", "\r"],
    ["t", "\t"],
    ["b", "\b"],
    ["f", "\f"],
    ["v", "\v"],
    ["0", "\0"]
  ]);
  for (let cursor = 1; cursor < expression.length - 1; cursor++) {
    const char = expression[cursor];
    if (char !== "\\") {
      output += char;
      continue;
    }
    cursor++;
    const escaped = expression[cursor];
    if (escaped === "\n") continue;
    if (escaped === "\r") {
      if (expression[cursor + 1] === "\n") cursor++;
      continue;
    }
    if (escapes.has(escaped)) {
      output += escapes.get(escaped);
      continue;
    }
    if (escaped === "x" && /^[0-9A-Fa-f]{2}$/u.test(expression.slice(cursor + 1, cursor + 3))) {
      output += String.fromCodePoint(Number.parseInt(expression.slice(cursor + 1, cursor + 3), 16));
      cursor += 2;
      continue;
    }
    if (escaped === "u") {
      if (expression[cursor + 1] === "{") {
        const close = expression.indexOf("}", cursor + 2);
        output += String.fromCodePoint(Number.parseInt(expression.slice(cursor + 2, close), 16));
        cursor = close;
        continue;
      }
      const digits = expression.slice(cursor + 1, cursor + 5);
      if (/^[0-9A-Fa-f]{4}$/u.test(digits)) {
        output += String.fromCodePoint(Number.parseInt(digits, 16));
        cursor += 4;
        continue;
      }
    }
    output += escaped;
  }
  return output;
}

function expressionEnd(text, start) {
  const stack = [];
  for (let cursor = start; cursor < text.length; cursor++) {
    const char = text[cursor];
    if (char === "'" || char === '"' || char === "`") {
      cursor = skipQuoted(text, cursor, char) - 1;
      continue;
    }
    if (text.startsWith("//", cursor)) {
      cursor = skipLineComment(text, cursor) - 1;
      continue;
    }
    if (text.startsWith("/*", cursor)) {
      cursor = skipBlockComment(text, cursor) - 1;
      continue;
    }
    if (char === "/" && regexCanStart(text, cursor)) {
      cursor = skipRegex(text, cursor) - 1;
      continue;
    }
    const closer = PAIRS.get(char);
    if (closer !== undefined) stack.push(closer);
    else if (stack.length > 0 && char === stack.at(-1)) stack.pop();
    else if (stack.length === 0 && char === ";") return cursor;
  }
  fail(`unterminated const initializer at ${start}`);
}

function identifierPart(char) {
  return char !== undefined && /[A-Za-z0-9_$]/u.test(char);
}

function lexicalBraceRanges(text) {
  const stack = [];
  const ranges = new Map();
  for (let cursor = 0; cursor < text.length; cursor++) {
    const char = text[cursor];
    if (char === "'" || char === '"' || char === "`") {
      cursor = skipQuoted(text, cursor, char) - 1;
      continue;
    }
    if (text.startsWith("//", cursor)) {
      cursor = skipLineComment(text, cursor) - 1;
      continue;
    }
    if (text.startsWith("/*", cursor)) {
      cursor = skipBlockComment(text, cursor) - 1;
      continue;
    }
    if (char === "/" && regexCanStart(text, cursor)) {
      cursor = skipRegex(text, cursor) - 1;
      continue;
    }
    if (char === "{") stack.push(cursor);
    else if (char === "}") {
      const open = stack.pop();
      if (open === undefined) fail(`unmatched closing brace at ${cursor}`);
      ranges.set(open, cursor);
    }
  }
  if (stack.length > 0) fail(`unterminated brace at ${stack.at(-1)}`);
  return ranges;
}

function collectDeclarations(text) {
  const result = new Map();
  const braceRanges = lexicalBraceRanges(text);
  const scopes = [];
  for (let cursor = 0; cursor < text.length; cursor++) {
    const char = text[cursor];
    if (char === "'" || char === '"' || char === "`") {
      cursor = skipQuoted(text, cursor, char) - 1;
      continue;
    }
    if (text.startsWith("//", cursor)) {
      cursor = skipLineComment(text, cursor) - 1;
      continue;
    }
    if (text.startsWith("/*", cursor)) {
      cursor = skipBlockComment(text, cursor) - 1;
      continue;
    }
    if (char === "/" && regexCanStart(text, cursor)) {
      cursor = skipRegex(text, cursor) - 1;
      continue;
    }
    if (char === "{") {
      scopes.push(cursor);
      continue;
    }
    if (char === "}") {
      const expected = scopes.pop();
      if (expected === undefined || braceRanges.get(expected) !== cursor) {
        fail(`declaration scanner scope mismatch at ${cursor}`);
      }
      continue;
    }
    if (!text.startsWith("const", cursor) || identifierPart(text[cursor - 1]) || identifierPart(text[cursor + 5])) {
      continue;
    }
    const declarationStart = cursor;
    let probe = skipTrivia(text, cursor + 5);
    const nameMatch = /^[A-Za-z_$][A-Za-z0-9_$]*/u.exec(text.slice(probe));
    if (nameMatch === null) continue;
    const name = nameMatch[0];
    probe = skipTrivia(text, probe + name.length);
    if (text[probe] === ":") {
      probe++;
      const typeStack = [];
      while (probe < text.length) {
        const typeChar = text[probe];
        if (typeChar === "'" || typeChar === '"' || typeChar === "`") {
          probe = skipQuoted(text, probe, typeChar);
          continue;
        }
        if (text.startsWith("//", probe)) {
          probe = skipLineComment(text, probe);
          continue;
        }
        if (text.startsWith("/*", probe)) {
          probe = skipBlockComment(text, probe);
          continue;
        }
        if (typeChar === "(" || typeChar === "[" || typeChar === "{") {
          typeStack.push(PAIRS.get(typeChar));
        } else if (typeStack.length > 0 && typeChar === typeStack.at(-1)) {
          typeStack.pop();
        } else if (typeStack.length === 0 && typeChar === "=") {
          break;
        } else if (typeStack.length === 0 && typeChar === ";") {
          fail(`missing initializer for const ${name} at ${declarationStart}`);
        }
        probe++;
      }
    }
    probe = skipTrivia(text, probe);
    if (text[probe] !== "=") continue;
    const expressionStart = skipTrivia(text, probe + 1);
    const end = expressionEnd(text, expressionStart);
    const scopeStart = scopes.at(-1) ?? -1;
    const scopeEnd = scopeStart === -1 ? text.length : braceRanges.get(scopeStart);
    if (scopeEnd === undefined) fail(`missing scope end for const ${name}`);
    const values = result.get(name) ?? [];
    values.push({
      name,
      expression: text.slice(expressionStart, end).trim(),
      start: declarationStart,
      scopeStart,
      scopeEnd
    });
    result.set(name, values);
    // Keep scanning the initializer: arrow/function bodies can introduce
    // narrower declarations that must remain visible only in their real scope.
    cursor = expressionStart - 1;
  }
  return result;
}

function assertDeclarationScanner() {
  const sample = [
    'const visibleBefore = "const fake = 1;";',
    'const shadow = "outer";',
    "{",
    '  const shadow = "inner";',
    "  const localRead = shadow;",
    "}",
    'const visibleAfter = "ok";',
    "const outerRead = shadow;",
    'const regexAfterOr = false || /[^}]/u.test("}");',
    'const regexAfterAnd = true && /[^}]/u.test("}");',
    'const regexAfterArrow = ["}"].some((value) => /["}]/u.test(value));',
    'const regexAfterReturn = () => { return /["}]/u; };',
    "const quotient = 8 / 2;",
    '/* const hidden = "no"; */'
  ].join("\n");
  const declarations = collectDeclarations(sample);
  if (
    declarations.has("fake") ||
    declarations.has("hidden") ||
    declarations.get("visibleBefore")?.[0]?.expression !== '"const fake = 1;"' ||
    declarations.get("visibleAfter")?.[0]?.expression !== '"ok"' ||
    declarations.get("regexAfterOr")?.[0]?.expression !== 'false || /[^}]/u.test("}")' ||
    declarations.get("regexAfterAnd")?.[0]?.expression !== 'true && /[^}]/u.test("}")' ||
    declarations.get("regexAfterArrow")?.[0]?.expression !== '["}"].some((value) => /["}]/u.test(value))' ||
    declarations.get("regexAfterReturn")?.[0]?.expression !== '() => { return /["}]/u; }' ||
    declarations.get("quotient")?.[0]?.expression !== "8 / 2"
  ) {
    fail("declaration scanner self-control rejected adjacent quoted declarations");
  }
  const evaluator = new StaticEvaluator(sample, new Map());
  const localContext = sample.indexOf("const localRead");
  const outerContext = sample.indexOf("const outerRead");
  if (
    evaluator.evaluateIdentifier("shadow", localContext) !== "inner" ||
    evaluator.evaluateIdentifier("shadow", outerContext) !== "outer"
  ) {
    fail("declaration scanner self-control rejected lexical shadowing");
  }
  let rejectedOutOfScope = false;
  try {
    evaluator.evaluateIdentifier("localRead", outerContext);
  } catch {
    rejectedOutOfScope = true;
  }
  if (!rejectedOutOfScope) {
    fail("declaration scanner self-control accepted an out-of-scope declaration");
  }
}

function expandReplacement(source, needle, replacement, offset) {
  let output = "";
  for (let cursor = 0; cursor < replacement.length; cursor++) {
    if (replacement[cursor] !== "$" || cursor + 1 >= replacement.length) {
      output += replacement[cursor];
      continue;
    }
    const next = replacement[cursor + 1];
    if (next === "$") output += "$";
    else if (next === "&") output += needle;
    else if (next === "`") output += source.slice(0, offset);
    else if (next === "'") output += source.slice(offset + needle.length);
    else {
      output += "$";
      continue;
    }
    cursor++;
  }
  return output;
}

function occurrenceCount(source, needle) {
  if (needle.length === 0) return 0;
  let count = 0;
  let cursor = 0;
  while (true) {
    const offset = source.indexOf(needle, cursor);
    if (offset === -1) return count;
    count++;
    cursor = offset + needle.length;
  }
}

function applyMutation(source, needle, replacement, mode, expected) {
  const observed = occurrenceCount(source, needle);
  if (observed !== expected) {
    fail(`mutation occurrence mismatch: expected ${expected}, found ${observed}`);
  }
  let output;
  if (mode === "first") {
    const offset = source.indexOf(needle);
    output =
      source.slice(0, offset) +
      expandReplacement(source, needle, replacement, offset) +
      source.slice(offset + needle.length);
  } else {
    const fragments = [];
    let cursor = 0;
    while (true) {
      const offset = source.indexOf(needle, cursor);
      if (offset === -1) break;
      fragments.push(source.slice(cursor, offset), expandReplacement(source, needle, replacement, offset));
      cursor = offset + needle.length;
    }
    fragments.push(source.slice(cursor));
    output = fragments.join("");
  }
  if (output === source) fail("mutation produced unchanged source");
  return output;
}

class StaticEvaluator {
  constructor(text, sourceValues) {
    this.text = text;
    this.declarations = collectDeclarations(text);
    this.sourceValues = sourceValues;
    this.active = new Set();
  }

  declaration(name, context) {
    const values = (this.declarations.get(name) ?? [])
      .filter((entry) => entry.start < context && entry.scopeStart < context && context <= entry.scopeEnd)
      .sort((left, right) => left.scopeStart - right.scopeStart || left.start - right.start);
    if (values.length === 0) fail(`unresolved identifier ${name} at ${context}`);
    return values.at(-1);
  }

  evaluateIdentifier(name, context) {
    if (this.sourceValues.has(name)) return this.sourceValues.get(name);
    const declaration = this.declaration(name, context);
    const key = `${name}:${declaration.start}`;
    if (this.active.has(key)) fail(`cyclic identifier ${name}`);
    this.active.add(key);
    try {
      return this.evaluate(declaration.expression, declaration.start);
    } finally {
      this.active.delete(key);
    }
  }

  evaluateTemplate(expression, context) {
    let output = "";
    let literalStart = 1;
    for (let cursor = 1; cursor < expression.length - 1; cursor++) {
      if (expression[cursor] === "\\") {
        cursor++;
        continue;
      }
      if (!expression.startsWith("${", cursor)) continue;
      if (literalStart < cursor) {
        output += decodeJsString(`\`${expression.slice(literalStart, cursor)}\``);
      }
      const close = balancedEnd(expression, cursor + 1);
      output += String(this.evaluate(expression.slice(cursor + 2, close), context));
      cursor = close;
      literalStart = cursor + 1;
    }
    if (literalStart < expression.length - 1) {
      output += decodeJsString(`\`${expression.slice(literalStart, -1)}\``);
    }
    return output;
  }

  evaluate(expression, context) {
    const value = stripOuterParens(expression);
    const plus = splitTop(value, "+");
    if (plus.length > 1) {
      const values = plus.map((entry) => this.evaluate(entry, context));
      return values.every(Number.isInteger) ? values.reduce((sum, entry) => sum + entry, 0) : values.join("");
    }
    if (value.length >= 2 && (value[0] === "'" || value[0] === '"') && value.at(-1) === value[0]) {
      return decodeJsString(value);
    }
    if (value.length >= 2 && value[0] === "`" && value.at(-1) === "`") {
      return this.evaluateTemplate(value, context);
    }
    if (/^\d[\d_]*$/u.test(value)) return Number.parseInt(value.replaceAll("_", ""), 10);
    if (value === "true") return true;
    if (value === "false") return false;
    if (value === "null") return null;
    if (value.startsWith("[") && balancedEnd(value, 0) === value.length - 1) {
      const inner = value.slice(1, -1);
      return inner.trim() === "" ? [] : splitTop(inner).map((entry) => this.evaluate(entry, context));
    }
    if (value.startsWith("{") && balancedEnd(value, 0) === value.length - 1) {
      const result = {};
      const inner = value.slice(1, -1);
      if (inner.trim() === "") return result;
      for (const member of splitTop(inner)) {
        const parts = splitTop(member, ":");
        if (parts.length !== 2) fail(`unsupported object member ${compact(member)}`);
        const rawKey = parts[0];
        const key = rawKey[0] === "'" || rawKey[0] === '"' ? decodeJsString(rawKey) : rawKey;
        result[key] = this.evaluate(parts[1], context);
      }
      return result;
    }
    if (/^[A-Za-z_$][A-Za-z0-9_$]*(?:\??\.[A-Za-z_$][A-Za-z0-9_$]*)*$/u.test(value)) {
      return this.evaluateIdentifier(value.replaceAll("?.", "."), context);
    }
    const joinMatch = /^(\[[\s\S]*\])\.join\(([\s\S]*)\)$/u.exec(value);
    if (joinMatch !== null) {
      const entries = splitTop(joinMatch[1].slice(1, -1));
      const separator = String(this.evaluate(joinMatch[2], context));
      return entries.map((entry) => String(this.evaluate(entry, context))).join(separator);
    }
    const repeatMatch = /^([\s\S]+)\.repeat\(([\s\S]+)\)$/u.exec(value);
    if (repeatMatch !== null) {
      return String(this.evaluate(repeatMatch[1], context)).repeat(Number(this.evaluate(repeatMatch[2], context)));
    }
    const rawClockMatch = /^rawClockGuard\(([\s\S]+)\)$/u.exec(value);
    if (rawClockMatch !== null) {
      return `          ${String(this.evaluate(rawClockMatch[1], context)).replaceAll("\n", "\n          ")}`;
    }
    const callMatch = /^(replaceExactly|replaceAllExactly)\s*\(/u.exec(value);
    if (callMatch !== null) {
      const open = value.indexOf("(", callMatch[1].length);
      if (balancedEnd(value, open) !== value.length - 1) fail("unexpected nested mutation suffix");
      const args = splitTop(value.slice(open + 1, -1));
      const source = String(this.evaluate(args[0], context));
      const needle = String(this.evaluate(args[1], context));
      const replacement = String(this.evaluate(args[2], context));
      const count = args.length === 4 ? Number(this.evaluate(args[3], context)) : 1;
      return applyMutation(source, needle, replacement, callMatch[1] === "replaceAllExactly" ? "all" : "first", count);
    }
    fail(`unsupported expression at ${context}: ${compact(value).slice(0, 180)}`);
  }
}

function registryRun(release) {
  const lines = release.split("\n");
  const nameIndex = lines.indexOf("      - name: Publish to MCP Registry (stable only)");
  if (nameIndex === -1) fail("registry publish step name is absent");
  const runIndex = lines.findIndex((line, index) => index > nameIndex && line === "        run: |");
  if (runIndex === -1) fail("registry publish run block is absent");
  const body = [];
  for (const line of lines.slice(runIndex + 1)) {
    if (line !== "" && line.length - line.trimStart().length <= 8) break;
    body.push(line.startsWith("          ") ? line.slice(10) : "");
  }
  return `${body.join("\n")}\n`;
}

function releaseFixture(release, transaction) {
  if (!transaction.endsWith("\n") || transaction.endsWith("\n\n")) {
    fail("release transaction must have exactly one terminal LF");
  }
  const normalized = transaction
    .slice(0, -1)
    .replaceAll("$MCPB_RELEASE_REPOSITORY", `\${{ github.repository }}`)
    .replaceAll("$MCPB_RELEASE_CHANNEL", `\${{ steps.dist_tag.outputs.tag }}`);
  const fixture = normalized
    .split("\n")
    .map((line) => `          ${line}`)
    .join("\n");
  return `${release.trimEnd()}\nx-enquire-release-transaction-script-under-test: |\n${fixture}\n`;
}

function buildSources(text, declarationContext) {
  const rawRelease = readFileSync(join(ROOT, ".github/workflows/release.yml"), "utf8");
  const transaction = readFileSync(join(ROOT, ".github/scripts/release-mcpb-github-transaction.sh"), "utf8");
  const combined = releaseFixture(rawRelease, transaction);
  const files = new Map([
    ["mcpbInputs.docsApi", "docs/api.md"],
    ["mcpbInputs.manifest", "mcpb/manifest.json"],
    ["packageJson", "package.json"],
    ["mcpbInputs.packageJson", "package.json"],
    ["mcpbInputs.packageLock", "package-lock.json"],
    ["mcpbInputs.build", "scripts/build-mcpb.mjs"],
    ["mcpbInputs.consumer", "scripts/mcpb-consumer.mjs"],
    ["packageConsumer", "scripts/package-consumer.mjs"],
    ["protocolConformance", "scripts/protocol-conformance.mjs"],
    ["mcpbInputs.integrity", "scripts/check-release-integrity.mjs"],
    ["releaseTransaction", ".github/scripts/release-mcpb-github-transaction.sh"],
    ["mcpbInputs.releaseTransaction", ".github/scripts/release-mcpb-github-transaction.sh"],
    ["mcpbInputs.versionCheck", "scripts/check-version-consistency.mjs"],
    ["mcpbInputs.versionSync", "scripts/sync-version.mjs"],
    ["mcpbInputs.cli", "src/cli.ts"],
    ["mcpbInputs.cliHelp", "src/cli-help.ts"],
    ["mcpbInputs.server", "src/server.ts"],
    ["ci", ".github/workflows/ci.yml"],
    ["releaseWorkflow", ".github/workflows/release.yml"]
  ]);
  const values = new Map([...files].map(([alias, path]) => [alias, readFileSync(join(ROOT, path), "utf8")]));
  values.set("workflow", combined);
  values.set("mcpbInputs.release", combined);
  values.set("registryRun", registryRun(combined));
  values.set("releaseTransactionSha256", digest(transaction.slice(0, -1)));
  const evaluator = new StaticEvaluator(text, values);
  const constants = [
    "rawCreateChannel",
    "releaseTransactionTail",
    "MCPB_ACTIONS_ARTIFACT_DOWNLOAD",
    "MCPB_EXACT_NPM_PACK",
    "NPM_PROVENANCE_AUDIT_COMMAND",
    "NPM_PROVENANCE_EVALUATOR_COMMAND",
    "MCPB_EXACT_NPM_PUBLISH",
    "MCPB_RELEASE_VISIBILITY_DUPLICATE_GUARD",
    "MCPB_RELEASE_VISIBILITY_POLL",
    "MCPB_RELEASE_VISIBILITY_TIMEOUT_GUARD",
    "MCPB_RELEASE_VISIBILITY_WAIT"
  ];
  for (const name of constants) {
    values.set(name, String(evaluator.evaluateIdentifier(name, declarationContext)));
  }
  const fileSource = (id, aliases, binding, path) => [id, aliases, binding, { kind: "file", path }];
  const constantSource = (id, alias, binding) => [
    id,
    [alias],
    binding,
    {
      kind: "constant",
      declarationExpression: evaluator.declaration(alias, declarationContext).expression
    }
  ];
  const specs = [
    fileSource("document.api", ["mcpbInputs.docsApi"], "docsApiSource", "docs/api.md"),
    [
      "fixture.release-workflow",
      ["workflow", "mcpbInputs.release"],
      "releaseWorkflowFixtureSource",
      {
        kind: "derived",
        definitionExpression: "releaseWorkflowFixture(releaseWorkflow, releaseTransaction)",
        dependencies: ["workflow.release-raw", "script.release-transaction"]
      }
    ],
    constantSource("fragment.github-create-channel", "rawCreateChannel", "githubCreateChannelSource"),
    constantSource(
      "fragment.github-release-transaction-tail",
      "releaseTransactionTail",
      "githubReleaseTransactionTailSource"
    ),
    constantSource(
      "fragment.mcpb-actions-artifact-download",
      "MCPB_ACTIONS_ARTIFACT_DOWNLOAD",
      "mcpbActionsArtifactDownloadSource"
    ),
    constantSource("fragment.npm-pack-command", "MCPB_EXACT_NPM_PACK", "npmPackCommandSource"),
    constantSource(
      "fragment.npm-provenance-audit-command",
      "NPM_PROVENANCE_AUDIT_COMMAND",
      "npmProvenanceAuditCommandSource"
    ),
    constantSource(
      "fragment.npm-provenance-evaluator-command",
      "NPM_PROVENANCE_EVALUATOR_COMMAND",
      "npmProvenanceEvaluatorCommandSource"
    ),
    constantSource("fragment.npm-publish-command", "MCPB_EXACT_NPM_PUBLISH", "npmPublishCommandSource"),
    constantSource(
      "fragment.release-visibility-duplicate-guard",
      "MCPB_RELEASE_VISIBILITY_DUPLICATE_GUARD",
      "releaseVisibilityDuplicateGuardSource"
    ),
    constantSource("fragment.release-visibility-poll", "MCPB_RELEASE_VISIBILITY_POLL", "releaseVisibilityPollSource"),
    constantSource(
      "fragment.release-visibility-timeout-guard",
      "MCPB_RELEASE_VISIBILITY_TIMEOUT_GUARD",
      "releaseVisibilityTimeoutGuardSource"
    ),
    constantSource("fragment.release-visibility-wait", "MCPB_RELEASE_VISIBILITY_WAIT", "releaseVisibilityWaitSource"),
    fileSource("manifest.mcpb", ["mcpbInputs.manifest"], "mcpbManifestSource", "mcpb/manifest.json"),
    fileSource(
      "manifest.package-json",
      ["packageJson", "mcpbInputs.packageJson"],
      "packageManifestSource",
      "package.json"
    ),
    fileSource("manifest.package-lock", ["mcpbInputs.packageLock"], "packageLockSource", "package-lock.json"),
    fileSource("script.mcpb-build", ["mcpbInputs.build"], "mcpbBuildSource", "scripts/build-mcpb.mjs"),
    fileSource("script.mcpb-consumer", ["mcpbInputs.consumer"], "mcpbConsumerSource", "scripts/mcpb-consumer.mjs"),
    fileSource("script.package-consumer", ["packageConsumer"], "packageConsumerSource", "scripts/package-consumer.mjs"),
    fileSource(
      "script.protocol-conformance",
      ["protocolConformance"],
      "protocolConformanceSource",
      "scripts/protocol-conformance.mjs"
    ),
    fileSource(
      "script.release-integrity",
      ["mcpbInputs.integrity"],
      "releaseIntegritySource",
      "scripts/check-release-integrity.mjs"
    ),
    fileSource(
      "script.release-transaction",
      ["releaseTransaction", "mcpbInputs.releaseTransaction"],
      "releaseTransactionSource",
      ".github/scripts/release-mcpb-github-transaction.sh"
    ),
    fileSource(
      "script.version-consistency",
      ["mcpbInputs.versionCheck"],
      "versionConsistencySource",
      "scripts/check-version-consistency.mjs"
    ),
    fileSource("script.version-sync", ["mcpbInputs.versionSync"], "versionSyncSource", "scripts/sync-version.mjs"),
    fileSource("source.cli", ["mcpbInputs.cli"], "cliSource", "src/cli.ts"),
    fileSource("source.cli-help", ["mcpbInputs.cliHelp"], "cliHelpSource", "src/cli-help.ts"),
    fileSource("source.server-ts", ["mcpbInputs.server"], "serverSource", "src/server.ts"),
    fileSource("workflow.ci", ["ci"], "ciWorkflowSource", ".github/workflows/ci.yml"),
    [
      "workflow.registry-publish-step",
      ["registryRun"],
      "registryPublishStepSource",
      {
        kind: "derived",
        definitionExpression: "runBody(registryStep)",
        dependencies: ["fixture.release-workflow"]
      }
    ],
    fileSource("workflow.release-raw", ["releaseWorkflow"], "releaseWorkflowRawSource", ".github/workflows/release.yml")
  ];
  const sources = specs.map(([id, aliases, declarativeBinding, origin], index) => {
    const aliasValues = aliases.map((alias) => values.get(alias));
    if (aliasValues.some((value) => value === undefined)) fail(`missing source value for ${id}`);
    if (aliasValues.some((value) => value !== aliasValues[0])) {
      fail(`source aliases diverged for ${id}`);
    }
    const payload = {
      order: index + 1,
      id,
      legacyExpressions: aliases,
      declarativeBinding,
      origin,
      contentSha256: digest(aliasValues[0])
    };
    return {
      ...payload,
      semanticFingerprint: semanticFingerprint(canonical({ normalizer: NORMALIZER, source: payload }))
    };
  });
  if (sources.length !== 30) fail(`source count drift: ${sources.length}`);
  return { sources, values };
}

function sourceSpan(text, start, end) {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  return {
    start,
    end,
    line: text.slice(0, start).split("\n").length,
    column: start - lineStart + 1,
    sha256: digest(text.slice(start, end))
  };
}

function tokenCharacter(value) {
  return value !== "" && /[\p{L}\p{N}_]/u.test(value);
}

function witnessCount(source, kind, anchor) {
  if (kind === "line") return source.split("\n").filter((line) => line === anchor).length;
  let count = 0;
  let cursor = 0;
  const startsToken = tokenCharacter(anchor[0]);
  const endsToken = tokenCharacter(anchor.at(-1));
  while (true) {
    const offset = source.indexOf(anchor, cursor);
    if (offset === -1) return count;
    const before = offset > 0 ? source[offset - 1] : "";
    const after = offset + anchor.length < source.length ? source[offset + anchor.length] : "";
    if ((!startsToken || !tokenCharacter(before)) && (!endsToken || !tokenCharacter(after))) {
      count++;
    }
    cursor = offset + anchor.length;
  }
}

function deriveWitness(source, mutant, needle, replacement) {
  const candidates = [];
  if (needle.length > 0 && needle.length <= 512) candidates.push(["token", needle, "needle"]);
  else if (needle.length > 0) {
    candidates.push(["token", needle.slice(0, 512), "token-delta"], ["token", needle.slice(-512), "token-delta"]);
  }
  if (replacement.length > 0 && replacement.length <= 512) {
    candidates.push(["token", replacement, "replacement"]);
  } else if (replacement.length > 0) {
    candidates.push(
      ["token", replacement.slice(0, 512), "token-delta"],
      ["token", replacement.slice(-512), "token-delta"]
    );
  }
  for (const changed of [needle, replacement]) {
    const lines = changed.split("\n");
    for (const width of [2, 3, 4]) {
      for (let start = 0; start < Math.max(0, lines.length - width + 1); start++) {
        const fragment = lines.slice(start, start + width).join("\n");
        if (fragment.length > 0 && fragment.length <= 512) {
          candidates.push(["token", fragment, "token-delta"]);
        }
      }
    }
  }
  const seenLines = new Set();
  for (const line of [...mutant.split("\n"), ...source.split("\n")]) {
    if (line !== "" && line.length <= 512 && !seenLines.has(line)) {
      seenLines.add(line);
      candidates.push(["line", line, "line-delta"]);
    }
  }
  const seenTokens = new Set();
  for (const token of `${replacement}\n${needle}`.match(/[\p{L}\p{N}_]+/gu) ?? []) {
    if (token.length <= 128 && !seenTokens.has(token)) {
      seenTokens.add(token);
      candidates.push(["token", token, "token-delta"]);
    }
  }
  for (const [kind, anchor, derivation] of candidates) {
    const before = witnessCount(source, kind, anchor);
    const after = witnessCount(mutant, kind, anchor);
    if (before !== after) {
      if ((derivation === "needle" && anchor !== needle) || (derivation === "replacement" && anchor !== replacement)) {
        fail(`non-exact witness cannot claim ${derivation} derivation`);
      }
      return {
        kind,
        anchor,
        before,
        after,
        derivation,
        sourceSha256: digest(source),
        mutantSha256: digest(mutant)
      };
    }
  }
  fail("no exact bounded mutation witness");
}

function expressionShape(expression, position) {
  const value = expression.trim();
  if (position === "count" && /^(?:1|\d[\d_]*)$/u.test(value)) return "integer";
  if (/^[A-Za-z_$][A-Za-z0-9_$]*(?:\??\.[A-Za-z_$][A-Za-z0-9_$]*)*$/u.test(value)) {
    return "identifier";
  }
  if (value.startsWith("replaceExactly(") || value.startsWith("replaceAllExactly(")) {
    return "nested";
  }
  if (splitTop(value, "+").length > 1) return position === "count" ? "sum" : "concat";
  if (value.length >= 2 && "'\"`".includes(value[0]) && value.at(-1) === value[0]) return "literal";
  return "other";
}

function incrementCounter(counter, key) {
  counter[key] = (counter[key] ?? 0) + 1;
}

function assertCounter(actual, expected, label) {
  const keys = new Set([...Object.keys(actual), ...Object.keys(expected)]);
  for (const key of keys) {
    if ((actual[key] ?? 0) !== (expected[key] ?? 0)) {
      fail(`${label} drift for ${key}: ${actual[key] ?? 0} != ${expected[key] ?? 0}`);
    }
  }
}

function materializeMutations(text, calls, sources, sourceValues) {
  const callByOrder = new Map(calls.map((call) => [call.legacyOrder, call]));
  const children = new Map(calls.map((call) => [call.legacyOrder, new Map()]));
  for (const call of calls) {
    if (call.parent !== null && call.parentArgument !== null) {
      children.get(call.parent).set(call.parentArgument, call.legacyOrder);
    }
  }
  const aliasToSource = new Map(
    sources.flatMap((source) => source.legacyExpressions.map((alias) => [alias, source.id]))
  );
  const evaluator = new StaticEvaluator(text, sourceValues);
  const outputs = new Map();
  const values = new Map();
  function produce(legacyOrder) {
    if (outputs.has(legacyOrder)) return outputs.get(legacyOrder);
    const call = callByOrder.get(legacyOrder);
    if (call === undefined) fail(`unknown mutation order ${legacyOrder}`);
    const sourceChild = children.get(legacyOrder).get(0);
    const replacementChild = children.get(legacyOrder).get(2);
    const source =
      sourceChild === undefined ? String(evaluator.evaluate(call.args[0], call.start)) : produce(sourceChild);
    const needle = String(evaluator.evaluate(call.args[1], call.start));
    const replacement =
      replacementChild === undefined ? String(evaluator.evaluate(call.args[2], call.start)) : produce(replacementChild);
    const countExpression = call.args.length === 4 ? call.args[3] : "1";
    const expected = Number(evaluator.evaluate(countExpression, call.start));
    const output = applyMutation(source, needle, replacement, call.mode, expected);
    outputs.set(legacyOrder, output);
    values.set(legacyOrder, { sourceValue: source, needle, replacement, expected, output });
    return output;
  }
  for (const call of calls) produce(call.legacyOrder);
  const parentByChild = new Map(
    calls.filter((call) => call.parent !== null).map((call) => [call.legacyOrder, call.parent])
  );
  const topological = [];
  const visited = new Set();
  function visit(order) {
    if (visited.has(order)) return;
    for (const child of [...children.get(order).values()].sort((left, right) => left - right)) {
      visit(child);
    }
    visited.add(order);
    topological.push(order);
  }
  for (const call of calls) if (call.parent === null) visit(call.legacyOrder);
  const topologyOrder = new Map(topological.map((legacy, index) => [legacy, index + 1]));
  const occurrence = new Map();
  const mutations = [];
  for (const legacy of topological) {
    const call = callByOrder.get(legacy);
    const sourceChild = children.get(legacy).get(0);
    const replacementChild = children.get(legacy).get(2);
    let sourceRef;
    if (sourceChild === undefined) {
      const sourceId = aliasToSource.get(call.args[0].trim());
      if (sourceId === undefined) {
        fail(`unknown canonical source ${call.id}: ${compact(call.args[0])}`);
      }
      sourceRef = { kind: "source", id: sourceId };
    } else {
      sourceRef = { kind: "mutation", id: callByOrder.get(sourceChild).id };
    }
    let owner = legacy;
    while (parentByChild.has(owner)) owner = parentByChild.get(owner);
    const countRaw = call.args.length === 4 ? call.args[3].trim() : "1";
    const key = canonical([call.mode, ...call.args.slice(0, 3).map((argument) => argument.trim()), countRaw]);
    occurrence.set(key, (occurrence.get(key) ?? 0) + 1);
    const current = values.get(legacy);
    const expressions = {
      source: { raw: call.args[0].trim(), resolved: sourceRef.id },
      needle: { raw: call.args[1].trim(), resolved: current.needle },
      replacement: {
        raw: call.args[2].trim(),
        resolved: replacementChild === undefined ? current.replacement : callByOrder.get(replacementChild).id
      },
      expectedOccurrences: { raw: countRaw, resolved: current.expected }
    };
    let witness;
    try {
      witness = deriveWitness(current.sourceValue, current.output, current.needle, current.replacement);
    } catch (error) {
      fail(`${call.id} witness failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    mutations.push({
      order: topologyOrder.get(legacy),
      legacyOrder: legacy,
      id: call.id,
      mode: call.mode,
      role: call.parent === null ? "root" : "dependency",
      legacyOccurrence: occurrence.get(key),
      expressions,
      source: sourceRef,
      replacementDependency: replacementChild === undefined ? null : callByOrder.get(replacementChild).id,
      ownerRoot: callByOrder.get(owner).id,
      legacySpan: sourceSpan(text, call.start, call.end),
      witness
    });
  }
  const shapes = { source: {}, needle: {}, replacement: {}, count: {} };
  for (const call of calls) {
    incrementCounter(shapes.source, expressionShape(call.args[0], "source"));
    incrementCounter(shapes.needle, expressionShape(call.args[1], "needle"));
    incrementCounter(shapes.replacement, expressionShape(call.args[2], "replacement"));
    incrementCounter(shapes.count, expressionShape(call.args.length === 4 ? call.args[3] : "1", "count"));
  }
  assertCounter(shapes.source, { identifier: 558, nested: 2 }, "source expression shape");
  assertCounter(shapes.needle, { literal: 479, identifier: 62, concat: 19 }, "needle expression shape");
  assertCounter(
    shapes.replacement,
    { literal: 498, concat: 41, nested: 18, identifier: 3 },
    "replacement expression shape"
  );
  assertCounter(shapes.count, { integer: 544, identifier: 15, sum: 1 }, "count expression shape");
  return { mutations, outputs, shapes };
}

function identifierAt(text, index, name) {
  if (!text.startsWith(name, index)) return false;
  return !identifierPart(text[index - 1]) && !identifierPart(text[index + name.length]);
}

function findCalls(text, start) {
  const calls = [];
  for (let cursor = start; cursor < text.length; ) {
    const char = text[cursor];
    if (char === "'" || char === '"' || char === "`") {
      cursor = skipQuoted(text, cursor, char);
      continue;
    }
    if (text.startsWith("//", cursor)) {
      cursor = skipLineComment(text, cursor);
      continue;
    }
    if (text.startsWith("/*", cursor)) {
      cursor = skipBlockComment(text, cursor);
      continue;
    }
    if (char === "/" && regexCanStart(text, cursor)) {
      cursor = skipRegex(text, cursor);
      continue;
    }
    let found = null;
    for (const name of CALL_NAMES) {
      if (!identifierAt(text, cursor, name)) continue;
      const open = skipTrivia(text, cursor + name.length);
      if (text[open] === "(") {
        found = { name, open };
        break;
      }
    }
    if (found === null) {
      cursor++;
      continue;
    }
    const close = balancedEnd(text, found.open);
    const argumentText = text.slice(found.open + 1, close);
    const relativeSpans = splitTopSpans(argumentText);
    const args = relativeSpans.map(([left, right]) => argumentText.slice(left, right).trim());
    const argumentSpans = relativeSpans.map(([left, right]) => [found.open + 1 + left, found.open + 1 + right]);
    const prefix = text.slice(Math.max(start, cursor - 300), cursor);
    const assignment = /\bconst\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=;]+)?=\s*$/u.exec(prefix);
    calls.push({
      legacyOrder: calls.length + 1,
      mode: found.name === "replaceAllExactly" ? "all" : "first",
      start: cursor,
      end: close + 1,
      args,
      argumentSpans,
      assignedName: assignment?.[1] ?? null,
      parent: null,
      parentArgument: null,
      id: `release.m${String(calls.length + 1).padStart(3, "0")}`
    });
    cursor += found.name.length;
  }
  for (const child of calls) {
    const containers = calls.filter((parent) => parent.start < child.start && child.end < parent.end);
    if (containers.length === 0) continue;
    containers.sort((left, right) => left.end - left.start - (right.end - right.start));
    const parent = containers[0];
    for (let argument = 0; argument < parent.argumentSpans.length; argument++) {
      const [left, right] = parent.argumentSpans[argument];
      if (left <= child.start && child.end <= right) {
        child.parent = parent.legacyOrder;
        child.parentArgument = argument;
        break;
      }
    }
  }
  const assigned = new Map(calls.filter((call) => call.assignedName !== null).map((call) => [call.assignedName, call]));
  for (const parent of calls) {
    if (parent.parent !== null) continue;
    const child = assigned.get(parent.args[0].trim());
    if (child !== undefined && child.parent === null) {
      child.parent = parent.legacyOrder;
      child.parentArgument = 0;
    }
  }
  return calls;
}

function findAssertions(text, start, end) {
  const result = [];
  for (let cursor = start; cursor < end; ) {
    const char = text[cursor];
    if (char === "'" || char === '"' || char === "`") {
      cursor = skipQuoted(text, cursor, char);
      continue;
    }
    if (text.startsWith("//", cursor)) {
      cursor = skipLineComment(text, cursor);
      continue;
    }
    if (text.startsWith("/*", cursor)) {
      cursor = skipBlockComment(text, cursor);
      continue;
    }
    if (char === "/" && regexCanStart(text, cursor)) {
      cursor = skipRegex(text, cursor);
      continue;
    }
    if (!identifierAt(text, cursor, "expect")) {
      cursor++;
      continue;
    }
    const actualOpen = skipTrivia(text, cursor + "expect".length);
    if (actualOpen >= end || text[actualOpen] !== "(") {
      cursor += "expect".length;
      continue;
    }
    const actualClose = balancedEnd(text, actualOpen);
    let probe = skipTrivia(text, actualClose + 1);
    let negated = false;
    if (text.startsWith(".not", probe)) {
      negated = true;
      probe = skipTrivia(text, probe + 4);
    }
    if (probe >= end || text[probe] !== ".") {
      cursor = actualClose + 1;
      continue;
    }
    const matcherStart = probe + 1;
    const matcherMatch = /^[A-Za-z_$][A-Za-z0-9_$]*/u.exec(text.slice(matcherStart));
    if (matcherMatch === null) {
      cursor = actualClose + 1;
      continue;
    }
    const matcher = matcherMatch[0];
    const expectedOpen = skipTrivia(text, matcherStart + matcher.length);
    if (expectedOpen >= end || text[expectedOpen] !== "(") {
      cursor = actualClose + 1;
      continue;
    }
    const expectedClose = balancedEnd(text, expectedOpen);
    result.push({
      start: cursor,
      end: expectedClose + 1,
      actualStart: actualOpen + 1,
      actualEnd: actualClose,
      actual: text.slice(actualOpen + 1, actualClose).trim(),
      matcher,
      negated,
      expected: text.slice(expectedOpen + 1, expectedClose).trim()
    });
    cursor = expectedClose + 1;
  }
  return result;
}

function tokenPairs(text, start, end, desiredOpener) {
  const result = [];
  const stack = [];
  for (let cursor = start; cursor < end; cursor++) {
    const char = text[cursor];
    if (char === "'" || char === '"' || char === "`") {
      cursor = skipQuoted(text, cursor, char) - 1;
      continue;
    }
    if (text.startsWith("//", cursor)) {
      cursor = skipLineComment(text, cursor) - 1;
      continue;
    }
    if (text.startsWith("/*", cursor)) {
      cursor = skipBlockComment(text, cursor) - 1;
      continue;
    }
    if (char === "/" && regexCanStart(text, cursor)) {
      cursor = skipRegex(text, cursor) - 1;
      continue;
    }
    const closer = PAIRS.get(char);
    if (closer !== undefined) stack.push([closer, cursor]);
    else if (stack.length > 0 && char === stack.at(-1)[0]) {
      const [, opening] = stack.pop();
      if (text[opening] === desiredOpener) result.push([opening, cursor + 1]);
    }
  }
  return result;
}

function findForOfLoops(text, start, end) {
  const result = [];
  for (let cursor = start; cursor < end; ) {
    const char = text[cursor];
    if (char === "'" || char === '"' || char === "`") {
      cursor = skipQuoted(text, cursor, char);
      continue;
    }
    if (text.startsWith("//", cursor)) {
      cursor = skipLineComment(text, cursor);
      continue;
    }
    if (text.startsWith("/*", cursor)) {
      cursor = skipBlockComment(text, cursor);
      continue;
    }
    if (!identifierAt(text, cursor, "for")) {
      cursor++;
      continue;
    }
    const open = skipTrivia(text, cursor + 3);
    if (open >= end || text[open] !== "(") {
      cursor += 3;
      continue;
    }
    const close = balancedEnd(text, open);
    const header = text.slice(open + 1, close);
    const match = /^\s*const\s+(.+?)\s+of\s+([\s\S]+?)\s*$/u.exec(header);
    if (match === null) {
      cursor = close + 1;
      continue;
    }
    const bindingNames = match[1].match(/[A-Za-z_$][A-Za-z0-9_$]*/gu) ?? [];
    if (bindingNames.length === 0) {
      cursor = close + 1;
      continue;
    }
    const iterableRelative = header.indexOf(match[2]);
    const iterableStart = open + 1 + iterableRelative;
    const bodyOpen = skipTrivia(text, close + 1);
    if (bodyOpen >= end || text[bodyOpen] !== "{") {
      cursor = close + 1;
      continue;
    }
    const bodyClose = balancedEnd(text, bodyOpen);
    result.push({
      binding: bindingNames.at(-1),
      iterableStart,
      iterableEnd: iterableStart + match[2].length,
      iterable: match[2].trim(),
      bodyStart: bodyOpen + 1,
      bodyEnd: bodyClose
    });
    cursor = bodyClose + 1;
  }
  return result;
}

function escapedRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function mapAssertions(text, matrixStart, matrixEnd, calls) {
  const assertions = findAssertions(text, matrixStart, matrixEnd);
  const roots = calls.filter((call) => call.parent === null);
  const mapped = new Map(roots.map((call) => [call.legacyOrder, []]));
  for (const assertion of assertions) {
    for (const call of roots) {
      if (assertion.actualStart <= call.start && call.end <= assertion.actualEnd) {
        mapped.get(call.legacyOrder).push(assertion);
      }
    }
  }
  for (const call of roots) {
    if (call.assignedName === null) continue;
    const pattern = new RegExp(`(^|[^A-Za-z0-9_$])${escapedRegExp(call.assignedName)}([^A-Za-z0-9_$]|$)`, "u");
    for (const assertion of assertions) {
      if (assertion.start > call.end && pattern.test(assertion.actual)) {
        mapped.get(call.legacyOrder).push(assertion);
      }
    }
  }
  const arrays = new Map();
  for (const [opening, closing] of tokenPairs(text, matrixStart, matrixEnd, "[")) {
    const contained = roots
      .filter((call) => opening < call.start && call.end < closing)
      .map((call) => call.legacyOrder);
    const arrayText = text.slice(opening, closing);
    for (const call of roots) {
      if (call.assignedName === null || call.end >= opening) continue;
      const pattern = new RegExp(`(^|[^A-Za-z0-9_$])${escapedRegExp(call.assignedName)}([^A-Za-z0-9_$]|$)`, "u");
      if (pattern.test(arrayText)) contained.push(call.legacyOrder);
    }
    if (contained.length === 0) continue;
    const unique = [...new Set(contained)].sort((left, right) => left - right);
    const prefix = text.slice(Math.max(matrixStart, opening - 300), opening);
    const declaration = /\bconst\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=;\n]+)?=\s*$/u.exec(prefix);
    if (declaration !== null) arrays.set(declaration[1], unique);
  }
  for (const loop of findForOfLoops(text, matrixStart, matrixEnd)) {
    let iterableRoots = roots
      .filter((call) => loop.iterableStart <= call.start && call.end <= loop.iterableEnd)
      .map((call) => call.legacyOrder);
    if (iterableRoots.length === 0) iterableRoots = arrays.get(loop.iterable) ?? [];
    if (iterableRoots.length === 0) continue;
    const pattern = new RegExp(`(^|[^A-Za-z0-9_$])${escapedRegExp(loop.binding)}([^A-Za-z0-9_$]|$)`, "u");
    for (const assertion of assertions) {
      if (loop.bodyStart <= assertion.start && assertion.end <= loop.bodyEnd && pattern.test(assertion.actual)) {
        for (const legacy of iterableRoots) mapped.get(legacy).push(assertion);
      }
    }
  }
  const transactionRoots = arrays.get("releaseTransactionMutationCases") ?? [];
  if (transactionRoots.length > 0) {
    const transactionAssertions = assertions.filter(
      (assertion) =>
        compact(assertion.actual).includes("githubReleaseTransactionProblems(mutant)") &&
        assertion.expected === "expectedProblem"
    );
    if (transactionAssertions.length !== 1) {
      fail(`transaction assertion count drift: ${transactionAssertions.length}`);
    }
    for (const legacy of transactionRoots) mapped.get(legacy).push(transactionAssertions[0]);
  }
  for (const [legacy, entries] of mapped) {
    const unique = new Map(entries.map((assertion) => [assertion.start, assertion]));
    mapped.set(
      legacy,
      [...unique.values()].sort((left, right) => left.start - right.start)
    );
  }
  return { assertions, mapped, arrays };
}

const DETECTOR_CALLEES = new Set([
  "githubWorkflowSchemaProblems",
  "mcpRegistryEvaluatorProblems",
  "mcpRegistryStepProblems",
  "npmProvenanceContractProblems",
  "npmProvenanceWorkflowProblems",
  "npmProvenanceEvaluatorProblems",
  "remoteGateScriptProblems",
  "releasePollProblems",
  "mcpbContractProblems",
  "githubReleaseTransactionProblems",
  "nodeFloorCiProblems"
]);

const MCPB_SOURCE_SLOTS = [
  ["manifest", "manifest.mcpb"],
  ["cli", "source.cli"],
  ["cliHelp", "source.cli-help"],
  ["server", "source.server-ts"],
  ["build", "script.mcpb-build"],
  ["consumer", "script.mcpb-consumer"],
  ["docsApi", "document.api"],
  ["integrity", "script.release-integrity"],
  ["packageLock", "manifest.package-lock"],
  ["packageJson", "manifest.package-json"],
  ["release", "fixture.release-workflow"],
  ["releaseTransaction", "script.release-transaction"],
  ["versionCheck", "script.version-consistency"],
  ["versionSync", "script.version-sync"]
];
const MCPB_MUTABLE_SLOT_BY_SOURCE = new Map(MCPB_SOURCE_SLOTS.map(([slot, sourceId]) => [sourceId, slot]));

function firstExpectArgument(assertion) {
  const [span] = splitTopSpans(assertion.actual);
  return assertion.actual.slice(span[0], span[1]).trim();
}

function parseDirectCall(expression) {
  const value = expression.trim();
  const match = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/u.exec(value);
  if (match === null) fail(`not a direct call: ${compact(value).slice(0, 120)}`);
  const open = value.indexOf("(", match[1].length);
  const close = balancedEnd(value, open);
  if (close !== value.length - 1) fail(`direct call suffix: ${compact(value).slice(-120)}`);
  const inner = value.slice(open + 1, close);
  return {
    callee: match[1],
    args: inner.trim() === "" ? [] : splitTop(inner)
  };
}

function transactionExpectedProblems(text, matrixStart, matrixEnd, calls, roots, evaluator) {
  const pairs = tokenPairs(text, matrixStart, matrixEnd, "{");
  const result = new Map();
  const callByOrder = new Map(calls.map((call) => [call.legacyOrder, call]));
  for (const legacy of roots) {
    const call = callByOrder.get(legacy);
    const containers = pairs.filter(
      ([opening, closing]) =>
        opening < call.start && call.end < closing && text.slice(opening, closing).includes("expectedProblem")
    );
    if (containers.length === 0) fail(`transaction object missing for ${call.id}`);
    containers.sort((left, right) => left[1] - left[0] - (right[1] - right[0]));
    const [opening, closing] = containers[0];
    const objectText = text.slice(opening, closing);
    const match = /\bexpectedProblem\s*:\s*/u.exec(objectText);
    if (match === null) fail(`transaction expectedProblem missing for ${call.id}`);
    const expressionStart = skipTrivia(text, opening + match.index + match[0].length);
    const quote = text[expressionStart];
    if (quote !== "'" && quote !== '"' && quote !== "`") {
      fail(`transaction expectedProblem must be literal for ${call.id}`);
    }
    const expressionEnd = skipQuoted(text, expressionStart, quote);
    result.set(legacy, String(evaluator.evaluate(text.slice(expressionStart, expressionEnd), expressionStart)));
  }
  return result;
}

function invocationInputs(kind, baseline, nodeEngine) {
  const source = (slot, id) => ({ kind: "source", slot, id });
  const mutant = (slot) => ({ kind: "mutant", slot });
  if (kind === "workflow.schema") {
    return { callee: "githubWorkflowSchemaProblems", arguments: [mutant("workflow")] };
  }
  if (kind === "registry.evaluator") {
    return { callee: "mcpRegistryEvaluatorProblems", arguments: [mutant("integrity")] };
  }
  if (kind === "registry.step.run") {
    return {
      callee: "mcpRegistryStepProblems",
      arguments: [mutant("run"), source("integrity", "script.release-integrity")]
    };
  }
  if (kind === "registry.step.integrity") {
    return {
      callee: "mcpRegistryStepProblems",
      arguments: [source("run", "workflow.registry-publish-step"), mutant("integrity")]
    };
  }
  if (kind === "npm.contract.release") {
    return {
      callee: "npmProvenanceContractProblems",
      arguments: [mutant("release"), source("integrity", "script.release-integrity")]
    };
  }
  if (kind === "npm.contract.integrity") {
    return {
      callee: "npmProvenanceContractProblems",
      arguments: [source("release", "fixture.release-workflow"), mutant("integrity")]
    };
  }
  if (kind === "npm.workflow") {
    return { callee: "npmProvenanceWorkflowProblems", arguments: [mutant("release")] };
  }
  if (kind === "npm.evaluator") {
    return { callee: "npmProvenanceEvaluatorProblems", arguments: [mutant("integrity")] };
  }
  if (kind === "remote-gate.package-consumer") {
    return {
      callee: "remoteGateScriptProblems",
      arguments: [mutant("packageConsumer"), source("protocolConformance", "script.protocol-conformance")]
    };
  }
  if (kind === "remote-gate.protocol-conformance") {
    return {
      callee: "remoteGateScriptProblems",
      arguments: [source("packageConsumer", "script.package-consumer"), mutant("protocolConformance")]
    };
  }
  if (kind === "release.poll") {
    return { callee: "releasePollProblems", arguments: [mutant("release")] };
  }
  if (kind === "mcpb.contract") {
    const mutableSlot = MCPB_MUTABLE_SLOT_BY_SOURCE.get(baseline);
    if (mutableSlot === undefined) fail(`unknown MCPB mutable baseline ${baseline}`);
    return {
      callee: "mcpbContractProblems",
      arguments: [
        {
          kind: "source-map",
          slot: "inputs",
          mutantSlot: mutableSlot,
          companions: MCPB_SOURCE_SLOTS.filter(([slot]) => slot !== mutableSlot).map(([slot, id]) => source(slot, id))
        }
      ]
    };
  }
  if (kind === "github.release-transaction") {
    return { callee: "githubReleaseTransactionProblems", arguments: [mutant("release")] };
  }
  if (kind === "ci.node-floor") {
    return {
      callee: "nodeFloorCiProblems",
      arguments: [mutant("ci"), { kind: "literal", slot: "nodeEngine", value: nodeEngine }]
    };
  }
  fail(`unknown invocation kind ${kind}`);
}

function primaryKind(callee, baseline) {
  if (callee === "githubWorkflowSchemaProblems") return "workflow.schema";
  if (callee === "mcpRegistryEvaluatorProblems") return "registry.evaluator";
  if (callee === "mcpRegistryStepProblems") {
    return baseline === "workflow.registry-publish-step" ? "registry.step.run" : "registry.step.integrity";
  }
  if (callee === "npmProvenanceContractProblems") {
    return baseline === "fixture.release-workflow" ? "npm.contract.release" : "npm.contract.integrity";
  }
  if (callee === "npmProvenanceWorkflowProblems") return "npm.workflow";
  if (callee === "npmProvenanceEvaluatorProblems") return "npm.evaluator";
  if (callee === "remoteGateScriptProblems") {
    return baseline === "script.package-consumer" ? "remote-gate.package-consumer" : "remote-gate.protocol-conformance";
  }
  if (callee === "releasePollProblems") return "release.poll";
  if (callee === "mcpbContractProblems") return "mcpb.contract";
  if (callee === "githubReleaseTransactionProblems") return "github.release-transaction";
  if (callee === "nodeFloorCiProblems") return "ci.node-floor";
  fail(`unknown detector callee ${callee}`);
}

function ultimateBaseline(mutation, mutationById) {
  let current = mutation;
  const visited = new Set();
  while (current.source.kind === "mutation") {
    const dependencyId = current.source.id;
    if (visited.has(dependencyId)) fail("mutation source cycle");
    visited.add(dependencyId);
    current = mutationById.get(dependencyId);
    if (current === undefined) fail(`missing mutation source ${dependencyId}`);
  }
  return current.source.id;
}

const WORKFLOW_SCHEMA_REGEX_RAW =
  "expect.stringMatching(/case-insensitive duplicate NPM_CONFIG_REGISTRY\\/npm_config_registry/)";
const WORKFLOW_SCHEMA_REGEX_ID = "workflow.schema.case-insensitive-env";

function regexIdentity(raw) {
  if (raw.trim() !== WORKFLOW_SCHEMA_REGEX_RAW) {
    fail(`workflow schema regex drift: ${compact(raw)}`);
  }
  return WORKFLOW_SCHEMA_REGEX_ID;
}

function buildCases(text, matrixStart, matrixEnd, calls, mutations, sourceValues, mapped, arrays) {
  const evaluator = new StaticEvaluator(text, sourceValues);
  const mutationById = new Map(mutations.map((mutation) => [mutation.id, mutation]));
  const rootCalls = calls.filter((call) => call.parent === null);
  const transactionProblems = transactionExpectedProblems(
    text,
    matrixStart,
    matrixEnd,
    calls,
    arrays.get("releaseTransactionMutationCases") ?? [],
    evaluator
  );
  const nodeEngine = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).engines.node;
  const cases = [];
  const kindCounts = {};
  let primaryProblemCount = 0;
  let primaryRegexCount = 0;
  const auxiliaryProfiles = new Map();
  for (let caseIndex = 0; caseIndex < rootCalls.length; caseIndex++) {
    const call = rootCalls[caseIndex];
    const mutation = mutationById.get(call.id);
    const baseline = ultimateBaseline(mutation, mutationById);
    const rootAssertions = mapped.get(call.legacyOrder) ?? [];
    const primary = [];
    const auxiliary = [];
    for (const assertion of rootAssertions) {
      const observation = firstExpectArgument(assertion);
      let callee = "";
      try {
        callee = parseDirectCall(observation).callee;
      } catch {
        callee = "";
      }
      if (DETECTOR_CALLEES.has(callee)) primary.push([assertion, callee]);
      else auxiliary.push(assertion);
    }
    if (primary.length !== 1) fail(`${call.id} primary assertion count ${primary.length}`);
    const [assertion, callee] = primary[0];
    const kind = primaryKind(callee, baseline);
    incrementCounter(kindCounts, kind);
    const expectationId = `release.expectation.m${String(call.legacyOrder).padStart(3, "0")}.primary`;
    let resolved;
    let expectation;
    if (call.legacyOrder === 1) {
      resolved = regexIdentity(assertion.expected);
      expectation = { id: expectationId, kind: "regex", regex: resolved };
      primaryRegexCount++;
    } else {
      resolved = transactionProblems.get(call.legacyOrder);
      if (resolved === undefined) {
        resolved = String(evaluator.evaluate(assertion.expected, assertion.start));
      }
      expectation = { id: expectationId, kind: "problem", problem: resolved };
      primaryProblemCount++;
    }
    const checks = [
      {
        invoke: {
          kind,
          baseline,
          mutant: call.id,
          inputs: invocationInputs(kind, baseline, nodeEngine)
        },
        expectation,
        matcherEvaluations: [
          {
            matcher: assertion.matcher,
            negated: assertion.negated,
            operand: { raw: assertion.expected, resolved },
            assertionSpan: sourceSpan(text, assertion.start, assertion.end)
          }
        ],
        assertionSpan: sourceSpan(text, assertion.start, assertion.end)
      }
    ];
    if (auxiliary.length > 0) {
      if (![38, 39, 40, 41, 42].includes(call.legacyOrder)) {
        fail(`unexpected auxiliary checks for ${call.id}`);
      }
      const profile = [];
      const matcherEvaluations = [];
      const sortedAuxiliary = [...auxiliary].sort((left, right) => left.start - right.start);
      for (const leafAssertion of sortedAuxiliary) {
        const observation = firstExpectArgument(leafAssertion);
        const { callee: leafCallee, args: leafArgs } = parseDirectCall(observation);
        const args = leafArgs.map((argument) => {
          if (call.assignedName !== null && argument === call.assignedName) {
            return { kind: "mutant", slot: "run" };
          }
          return {
            kind: "literal",
            slot: leafCallee === "canonicalLogicalShellIdentifierInventory" ? "identifier" : "environment",
            value: evaluator.evaluate(argument, leafAssertion.start)
          };
        });
        const operandValue = evaluator.evaluate(leafAssertion.expected, leafAssertion.start);
        const operand = { raw: leafAssertion.expected, resolved: operandValue };
        profile.push({
          callee: leafCallee,
          arguments: args,
          matcher: leafAssertion.matcher,
          negated: leafAssertion.negated,
          operand
        });
        matcherEvaluations.push({
          matcher: leafAssertion.matcher,
          negated: leafAssertion.negated,
          operand,
          assertionSpan: sourceSpan(text, leafAssertion.start, leafAssertion.end)
        });
      }
      auxiliaryProfiles.set(call.legacyOrder, [profile.length, matcherEvaluations.length]);
      checks.push({
        invoke: {
          kind: "registry.composite",
          baseline,
          mutant: call.id,
          inputs: { profile }
        },
        expectation: {
          id: `release.expectation.m${String(call.legacyOrder).padStart(3, "0")}.composition`,
          kind: "equal",
          value: canonical(profile)
        },
        matcherEvaluations,
        assertionSpan: sourceSpan(text, sortedAuxiliary[0].start, sortedAuxiliary.at(-1).end)
      });
    }
    const casePayload = {
      order: caseIndex + 1,
      id: `release.case.m${String(call.legacyOrder).padStart(3, "0")}`,
      root: call.id,
      checks
    };
    cases.push({
      ...casePayload,
      semanticFingerprint: semanticFingerprint(canonical({ normalizer: NORMALIZER, case: casePayload }))
    });
  }
  assertCounter(
    kindCounts,
    {
      "workflow.schema": 1,
      "registry.evaluator": 36,
      "registry.step.run": 72,
      "registry.step.integrity": 1,
      "npm.contract.release": 1,
      "npm.contract.integrity": 1,
      "npm.workflow": 36,
      "npm.evaluator": 37,
      "remote-gate.package-consumer": 1,
      "remote-gate.protocol-conformance": 2,
      "release.poll": 22,
      "mcpb.contract": 110,
      "github.release-transaction": 129,
      "ci.node-floor": 87
    },
    "primary adapter"
  );
  if (primaryProblemCount !== 535 || primaryRegexCount !== 1) {
    fail(`primary expectation drift ${primaryProblemCount}/${primaryRegexCount}`);
  }
  const expectedAuxiliary = new Map([
    [38, [2, 2]],
    [39, [1, 1]],
    [40, [2, 2]],
    [41, [3, 3]],
    [42, [2, 2]]
  ]);
  if (canonical([...auxiliaryProfiles]) !== canonical([...expectedAuxiliary])) {
    fail(`auxiliary profile drift: ${canonical([...auxiliaryProfiles])}`);
  }
  return cases;
}

function attachFingerprints(sources, mutations, cases) {
  for (const source of sources) {
    const sourceWithoutFingerprint = Object.fromEntries(
      Object.entries(source).filter(([key]) => key !== "semanticFingerprint")
    );
    source.semanticFingerprint = semanticFingerprint(
      canonical({ normalizer: NORMALIZER, source: sourceWithoutFingerprint })
    );
  }
  const caseByRoot = new Map(cases.map((entry) => [entry.root, entry]));
  for (const mutation of mutations) {
    const mutationWithoutFingerprint = Object.fromEntries(
      Object.entries(mutation).filter(([key]) => key !== "semanticFingerprint")
    );
    const owner = caseByRoot.get(mutation.ownerRoot);
    if (owner === undefined) fail(`missing owner case for ${mutation.id}`);
    mutation.semanticFingerprint = semanticFingerprint(
      canonical({
        normalizer: NORMALIZER,
        mutation: mutationWithoutFingerprint,
        ownerCaseFingerprint: owner.semanticFingerprint
      })
    );
  }
}

function assertInventory(actual, expected) {
  for (const key of Object.keys(expected)) {
    if (actual[key] !== expected[key]) {
      fail(`inventory drift for ${key}: ${actual[key]} != ${expected[key]}`);
    }
  }
  if (Object.keys(actual).length !== Object.keys(expected).length) {
    fail("inventory key drift");
  }
}

function buildManifest() {
  assertDeclarationScanner();
  const text = readFileSync(TEST_PATH, "utf8");
  if (digest(text) !== SOURCE_SHA256) {
    fail("tests/release-integrity.test.ts source SHA-256 drift");
  }
  const firstPrefix = text.indexOf(MATRIX_PREFIX);
  if (firstPrefix === -1) fail("first releaseWorkflow prefix is absent");
  const matrixStart = text.indexOf(MATRIX_PREFIX, firstPrefix + MATRIX_PREFIX.length);
  if (matrixStart === -1 || !text.startsWith(MATRIX_START, matrixStart)) {
    fail("second releaseWorkflow prefix does not bind the exact matrix start");
  }
  const matrixEndStart = text.lastIndexOf(MATRIX_END);
  if (matrixEndStart < matrixStart) fail("exact matrix end marker is absent");
  const matrixClosingBraceOffset = MATRIX_END.indexOf("}");
  if (matrixClosingBraceOffset === -1) fail("exact matrix end marker has no callback closing brace");
  const matrixDeclarationContext = matrixEndStart + matrixClosingBraceOffset - 1;
  const matrixEnd = matrixEndStart + MATRIX_END.length;
  const matrixSliceSha256 = digest(text.slice(matrixStart, matrixEnd));
  if (matrixSliceSha256 !== MATRIX_SLICE_SHA256) {
    fail("release matrix slice SHA-256 drift");
  }
  const calls = findCalls(text, matrixStart);
  const { sources, values: sourceValues } = buildSources(text, matrixDeclarationContext);
  const { mutations } = materializeMutations(text, calls, sources, sourceValues);
  const { assertions, mapped, arrays } = mapAssertions(text, matrixStart, matrixEnd, calls);
  const cases = buildCases(text, matrixStart, matrixEnd, calls, mutations, sourceValues, mapped, arrays);
  attachFingerprints(sources, mutations, cases);
  const parentByChild = new Map(
    calls.filter((call) => call.parent !== null).map((call) => [call.legacyOrder, call.parent])
  );
  let maxDependencyDepth = 0;
  for (const call of calls) {
    let current = call.legacyOrder;
    let depth = 0;
    const seen = new Set();
    while (parentByChild.has(current)) {
      if (seen.has(current)) fail(`dependency cycle at ${call.id}`);
      seen.add(current);
      depth++;
      current = parentByChild.get(current);
    }
    maxDependencyDepth = Math.max(maxDependencyDepth, depth);
  }
  const inventory = {
    sources: sources.length,
    mutations: mutations.length,
    first: calls.filter((call) => call.mode === "first").length,
    all: calls.filter((call) => call.mode === "all").length,
    roots: calls.filter((call) => call.parent === null).length,
    dependencyOnly: calls.filter((call) => call.parent !== null).length,
    cases: cases.length,
    primaryChecks: cases.length,
    compositeChecks: cases.reduce((sum, entry) => sum + entry.checks.length - 1, 0),
    logicalChecks: cases.reduce((sum, entry) => sum + entry.checks.length, 0),
    rawMatcherEvaluations: cases.reduce(
      (sum, entry) => sum + entry.checks.reduce((caseSum, check) => caseSum + check.matcherEvaluations.length, 0),
      0
    ),
    sourceEdges: calls.filter((call) => call.parentArgument === 0).length,
    replacementEdges: calls.filter((call) => call.parentArgument === 2).length,
    maxDependencyDepth,
    transactionCases: (arrays.get("releaseTransactionMutationCases") ?? []).length
  };
  assertInventory(inventory, {
    sources: 30,
    mutations: 560,
    first: 538,
    all: 22,
    roots: 536,
    dependencyOnly: 24,
    cases: 536,
    primaryChecks: 536,
    compositeChecks: 5,
    logicalChecks: 541,
    rawMatcherEvaluations: 546,
    sourceEdges: 6,
    replacementEdges: 18,
    maxDependencyDepth: 2,
    transactionCases: 76
  });
  if (assertions.length !== RAW_ASSERTION_CENSUS) {
    fail(`raw assertion census drift: expected ${RAW_ASSERTION_CENSUS}, found ${assertions.length}`);
  }
  const rawExpressionShape = {
    classifier: "outer-expression-v1",
    source: { identifier: 558, nestedCall: 2 },
    needle: { literal: 479, identifier: 62, concatenation: 19 },
    replacement: { literal: 498, concatenation: 41, nestedCall: 18, identifier: 3 },
    expectedOccurrences: { integer: 544, identifier: 15, sum: 1 }
  };
  return {
    schemaVersion: 2,
    normalizer: NORMALIZER,
    generatedFrom: {
      commit: SOURCE_COMMIT,
      path: "tests/release-integrity.test.ts",
      matrixTitle: MATRIX_TITLE,
      matrixSliceSha256,
      rawExpressionShape
    },
    inventory,
    sources,
    mutations,
    cases
  };
}

function serializeManifest(manifest) {
  const lines = [
    "{",
    `  "schemaVersion": ${canonical(manifest.schemaVersion)},`,
    `  "normalizer": ${canonical(manifest.normalizer)},`,
    `  "generatedFrom": ${canonical(manifest.generatedFrom)},`,
    `  "inventory": ${canonical(manifest.inventory)},`
  ];
  for (const [arrayIndex, key] of ["sources", "mutations", "cases"].entries()) {
    lines.push(`  ${canonical(key)}: [`);
    const values = manifest[key];
    for (let index = 0; index < values.length; index++) {
      lines.push(`    ${canonical(values[index])}${index + 1 === values.length ? "" : ","}`);
    }
    lines.push(`  ]${arrayIndex === 2 ? "" : ","}`);
  }
  lines.push("}");
  return `${lines.join("\n")}\n`;
}

if (process.argv.length !== 2) {
  fail("this generator accepts no arguments and writes the canonical manifest to stdout");
}
process.stdout.write(serializeManifest(buildManifest()));
