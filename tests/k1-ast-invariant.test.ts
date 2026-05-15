// v3.7.0 M-2 — AST-based K-1 class invariant (strengthens the grep-based
// guard from v3.6.4).
//
// Background. v3.6.4 added `tests/k1-class-invariant.test.ts` which uses
// grep to assert that every `new EmbedDb(...)` / `new FtsIndex(...)` in
// `src/` is preceded by a `peek*Meta` call OR a `// SAFE BY DESIGN`
// comment within 40 lines. That catches the "no peek at all" case but
// NOT a more insidious variant: peek IS called, but its result is
// discarded — the constructor uses a hardcoded value independent of
// the peek result. Example bypass:
//
//   const _ignored = await peekEmbedDbMeta(file);   // ✓ grep passes
//   const db = new EmbedDb({ modelAlias: "hardcoded" }); // ✗ K-1 bug
//
// This file uses the TypeScript compiler API to perform a def-use trace:
// for every constructor call, at least one of the K-1-relevant named args
// (`modelAlias`, `dim`, `tokenize`, `quantization`) must reference an
// identifier that traces back (transitively, within the enclosing function
// scope) to a `peek*Meta` call return value. If no such trace exists, the
// constructor must instead have a `// SAFE BY DESIGN` comment within 40
// lines above (matching the grep-based escape hatch).
//
// Test coverage:
//   1. Positive: `tests/fixtures/k1-invariant/good.ts` — all constructors
//      have peek-derived args; analyzer reports 0 unguarded.
//   2. Negative #1: `tests/fixtures/k1-invariant/bad-ignored-peek.ts` —
//      peek call present, result discarded; analyzer reports ≥1 unguarded.
//   3. Negative #2: `tests/fixtures/k1-invariant/bad-no-peek.ts` —
//      no peek, no SAFE marker; analyzer reports ≥1 unguarded.
//   4. Whole-`src/` run: analyzer reports 0 unguarded across the real
//      production code (in addition to the existing grep-based gate).

import { promises as fs } from "node:fs";
import * as path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const CONSTRUCTORS = new Set(["EmbedDb", "FtsIndex"]);
const PEEK_NAMES = new Set(["peekEmbedDbMeta", "peekFtsMetaSafe"]);
// K-1-relevant constructor arg names. At least one of these must trace to
// a peek result for the constructor to be considered "guarded".
const K1_ARG_NAMES = new Set(["modelAlias", "dim", "tokenize", "quantization"]);
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

/**
 * Compute the set of identifier names within `scope` that are
 * (transitively) derived from a `peek*Meta` call.
 *
 * Algorithm: scan every variable declaration in scope. Initial taint: any
 * var whose initializer textually contains a `peek*Meta` identifier.
 * Iterate to fixed point: any var whose initializer textually contains an
 * already-tainted name becomes tainted too.
 */
function peekDerivedNames(scope: ts.Node, sourceFile: ts.SourceFile): Set<string> {
  const tainted = new Set<string>();
  const decls: { name: string; initText: string }[] = [];

  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && node.name && ts.isIdentifier(node.name) && node.initializer) {
      const name = node.name.text;
      const initText = node.initializer.getText(sourceFile);
      decls.push({ name, initText });
    }
    // Also catch assignments like `model = honored` where `model` was
    // declared with `let`. Look for BinaryExpression with `=` operator.
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      const name = node.left.text;
      const initText = node.right.getText(sourceFile);
      decls.push({ name, initText });
    }
    ts.forEachChild(node, visit);
  }
  visit(scope);

  // Initial pass: direct peek calls.
  for (const d of decls) {
    for (const peek of PEEK_NAMES) {
      if (d.initText.includes(peek)) {
        tainted.add(d.name);
        break;
      }
    }
  }
  // Fixed-point pass: var initialized from a tainted name.
  let changed = true;
  while (changed) {
    changed = false;
    for (const d of decls) {
      if (tainted.has(d.name)) continue;
      for (const t of tainted) {
        // Match as a word boundary to avoid `peekedX` matching `peek`.
        const re = new RegExp(`\\b${t}\\b`);
        if (re.test(d.initText)) {
          tainted.add(d.name);
          changed = true;
          break;
        }
      }
    }
  }
  return tainted;
}

/**
 * Check whether a `// SAFE BY DESIGN` line-comment appears within
 * `SAFE_LOOKBACK_LINES` lines above the constructor line. Anchored regex
 * defeats false positives from prose mentioning the phrase to NEGATE it.
 */
function hasSafeComment(sourceText: string, ctorLine: number): boolean {
  const lines = sourceText.split(/\r?\n/);
  const start = Math.max(0, ctorLine - 1 - SAFE_LOOKBACK_LINES);
  const end = Math.min(lines.length, ctorLine);
  const window = lines.slice(start, end).join("\n");
  return SAFE_MARKER_RE.test(window);
}

/**
 * Analyze a single TypeScript source file for K-1 invariant violations.
 * Returns an array of unguarded sites (empty if all constructors are OK).
 */
async function analyzeFile(filePath: string): Promise<UnguardedSite[]> {
  const text = await fs.readFile(filePath, "utf8");
  const sourceFile = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true);
  const unguarded: UnguardedSite[] = [];

  function visit(node: ts.Node): void {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && CONSTRUCTORS.has(node.expression.text)) {
      const className = node.expression.text;
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      const ctorLine = line + 1; // 1-based for reporting

      // 1. SAFE BY DESIGN escape hatch?
      if (hasSafeComment(text, ctorLine)) {
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
            "constructor's first argument is not an object literal; AST analyzer requires the canonical options-object shape"
        });
        ts.forEachChild(node, visit);
        return;
      }

      // 3. Find peek-derived identifier names in the enclosing scope.
      const scope = enclosingScope(node);
      const tainted = peekDerivedNames(scope, sourceFile);

      // 4. Check each K-1-relevant property: is its initializer text
      //    referencing a tainted name?
      let foundTaintedArg = false;
      let foundAnyK1Arg = false;
      for (const prop of arg0.properties) {
        if (!ts.isPropertyAssignment(prop) && !ts.isShorthandPropertyAssignment(prop)) continue;
        const propName = ts.isPropertyAssignment(prop) ? prop.name.getText(sourceFile) : prop.name.text;
        if (!K1_ARG_NAMES.has(propName)) continue;
        foundAnyK1Arg = true;
        const initText = ts.isShorthandPropertyAssignment(prop) ? prop.name.text : prop.initializer.getText(sourceFile);
        for (const t of tainted) {
          const re = new RegExp(`\\b${t}\\b`);
          if (re.test(initText)) {
            foundTaintedArg = true;
            break;
          }
        }
        if (foundTaintedArg) break;
      }

      if (!foundAnyK1Arg) {
        // Constructor doesn't declare any K-1-relevant args (e.g.
        // `new FtsIndex({ file, vaultRoot })` without tokenize). In that
        // case the default would be applied at bootstrap; require SAFE.
        // We already checked SAFE above and didn't find it, so this is
        // unguarded.
        unguarded.push({
          file: filePath,
          line: ctorLine,
          className,
          reason: `no K-1 arg (${[...K1_ARG_NAMES].join("/")}) declared and no SAFE BY DESIGN comment within ${SAFE_LOOKBACK_LINES} lines`
        });
      } else if (!foundTaintedArg) {
        unguarded.push({
          file: filePath,
          line: ctorLine,
          className,
          reason: `K-1 args present but none trace back to a peek*Meta result (peek-derived names in scope: ${tainted.size === 0 ? "<none>" : [...tainted].join(", ")})`
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return unguarded;
}

/**
 * Recursively collect all .ts files under a directory (excluding .d.ts).
 */
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
      if (!e.name.endsWith(".ts") || e.name.endsWith(".d.ts")) continue;
      out.push(path.join(cur, e.name));
    }
  }
  return out;
}

describe("K-1 AST invariant (v3.7.0 M-2 — strengthens v3.6.4 grep-based guard)", () => {
  const FIXTURE_DIR = path.join(process.cwd(), "tests", "fixtures", "k1-invariant");

  it("POSITIVE: fixtures/k1-invariant/good.ts has 0 unguarded sites", async () => {
    const unguarded = await analyzeFile(path.join(FIXTURE_DIR, "good.ts"));
    if (unguarded.length > 0) {
      const detail = unguarded.map((u) => `  ${u.className}@${u.line}: ${u.reason}`).join("\n");
      expect.fail(`good.ts should be clean but analyzer flagged:\n${detail}`);
    }
    expect(unguarded.length).toBe(0);
  });

  it("NEGATIVE: fixtures/k1-invariant/bad-ignored-peek.ts has ≥1 unguarded site (peek result discarded)", async () => {
    const unguarded = await analyzeFile(path.join(FIXTURE_DIR, "bad-ignored-peek.ts"));
    expect(unguarded.length).toBeGreaterThanOrEqual(1);
    // The specific failure mode: K-1 args present but peek not consumed.
    expect(unguarded[0]?.reason).toMatch(/none trace back to a peek\*Meta/);
    expect(unguarded[0]?.className).toBe("EmbedDb");
  });

  it("NEGATIVE: fixtures/k1-invariant/bad-no-peek.ts has ≥1 unguarded site (no peek call)", async () => {
    const unguarded = await analyzeFile(path.join(FIXTURE_DIR, "bad-no-peek.ts"));
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
      expect.fail(
        `K-1 AST invariant violated in src/. Constructors below have a peek*Meta call in scope but none of their K-1 args (${[...K1_ARG_NAMES].join("/")}) traces back to it:\n${detail}\n\nFix: either thread the peek result into one of the K-1 args (typical: \`modelAlias: peeked?.model_alias ?? "default"\`), OR add a \`// SAFE BY DESIGN: <reason>\` comment within 40 lines above if the constructor demonstrably can't trigger bootstrapSchema.`
      );
    }
    expect(allUnguarded.length).toBe(0);
  });
});
