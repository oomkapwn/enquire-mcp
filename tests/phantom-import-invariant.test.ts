// v3.10.0-rc.50 — PHANTOM-IMPORT INVENTORY INVARIANT (structural defense).
//
// Closes the phantom-dependency class (re-audit SC-PHANTOM-JSYAML-01): `src/bases.ts`
// did `await import("js-yaml")` for a CORE feature (`.base` parsing) without declaring
// js-yaml in package.json — it resolved ONLY via gray-matter's transitive pin + npm's
// flat hoisting, and would break under pnpm-no-hoist / Yarn PnP / a gray-matter major.
//
// Static and literal dynamic imports are checked against whatever happens to
// be installed, which can still be an undeclared transitive package. A
// compiler-opaque `importOptionalDependency("x")` has no compiler manifest
// check at all. This invariant parses every direct/helper form in src/ and
// requires its package root in `dependencies` or `optionalDependencies`.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { isBuiltin } from "node:module";
import * as path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "..");

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collectTsFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** Bare specifier → package root: `pdfjs-dist/legacy/build/pdf.mjs` → `pdfjs-dist`,
 *  `@huggingface/transformers` → `@huggingface/transformers`. */
function packageRoot(spec: string): string {
  if (spec.startsWith("@")) return spec.split("/").slice(0, 2).join("/");
  return spec.split("/")[0] ?? spec;
}

interface RuntimeImport {
  specifier: string;
  direct: boolean;
}

function literalRuntimeImports(src: string): RuntimeImport[] {
  const sourceFile = ts.createSourceFile("phantom-import-source.ts", src, ts.ScriptTarget.Latest, true);
  const imports: RuntimeImport[] = [];
  const record = (specifier: ts.Expression | undefined, direct: boolean): void => {
    if (specifier && ts.isStringLiteralLike(specifier)) {
      imports.push({ specifier: specifier.text, direct });
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      record(node.moduleSpecifier, true);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      record(node.moduleReference.expression, true);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      record(node.argument.literal, true);
    } else if (ts.isCallExpression(node)) {
      const firstArg = node.arguments[0];
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        record(firstArg, true);
      } else if (
        ts.isIdentifier(node.expression) &&
        (node.expression.text === "require" || node.expression.text === "importOptionalDependency")
      ) {
        record(firstArg, node.expression.text === "require");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return imports;
}

/**
 * Pure detector — returns runtime-import package roots NOT covered by
 * `declared` (and not node: builtins / relative). Its return shape lets the
 * NEGATIVE control prove it isn't vacuous.
 */
function phantomRuntimeImports(src: string, declared: Set<string>): string[] {
  const out: string[] = [];
  for (const { specifier: spec } of literalRuntimeImports(src)) {
    if (spec.startsWith(".") || spec.startsWith("node:") || isBuiltin(spec)) continue;
    const root = packageRoot(spec);
    if (!declared.has(root)) out.push(spec);
  }
  return out;
}

describe("phantom-import inventory invariant (rc.50)", () => {
  it("every runtime import in src/ has its package declared in package.json", () => {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    const declared = new Set<string>([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.optionalDependencies ?? {})
    ]);
    const offenders: string[] = [];
    for (const file of collectTsFiles(path.join(repoRoot, "src"))) {
      for (const spec of phantomRuntimeImports(readFileSync(file, "utf8"), declared)) {
        offenders.push(`${path.relative(repoRoot, file)}: import("${spec}")`);
      }
    }
    expect(offenders, `Undeclared runtime-import dependencies (phantom deps):\n${offenders.join("\n")}`).toEqual([]);

    // rc.23 — a failed native optional install must not make tsc resolve
    // hnswlib-node before the fail-soft loader runs. Pin both package placement
    // and the compiler-opaque import shape, with a mutated negative control.
    expect(pkg.optionalDependencies?.["hnswlib-node"]).toBeDefined();
    expect(pkg.dependencies?.["hnswlib-node"]).toBeUndefined();
    expect(pkg.devDependencies?.["hnswlib-node"]).toBeUndefined();
    const sourceFiles = collectTsFiles(path.join(repoRoot, "src"));
    const hnswImports = sourceFiles.flatMap((file) =>
      literalRuntimeImports(readFileSync(file, "utf8")).filter((entry) => entry.specifier === "hnswlib-node")
    );
    expect(hnswImports.filter((entry) => entry.direct)).toEqual([]);
    expect(hnswImports.filter((entry) => !entry.direct)).toEqual([{ specifier: "hnswlib-node", direct: false }]);
    const optionalDepSource = readFileSync(path.join(repoRoot, "src/optional-dep.ts"), "utf8");
    expect(optionalDepSource).toContain(
      "export async function importOptionalDependency(specifier: string): Promise<unknown>"
    );
    expect(optionalDepSource).toContain("return import(specifier);");
  });

  it("detector flags undeclared dynamic and compiler-opaque imports (NEGATIVE control)", () => {
    const declared = new Set(["gray-matter", "js-yaml"]);
    expect(
      phantomRuntimeImports(
        `import type { X } from "undeclared-static";
         const m = await import("undeclared-pkg");
         await importOptionalDependency("undeclared-native");`,
        declared
      )
    ).toEqual(["undeclared-static", "undeclared-pkg", "undeclared-native"]);
    expect(literalRuntimeImports(`await import("hnswlib-node")`)).toEqual([
      { specifier: "hnswlib-node", direct: true }
    ]);
    expect(literalRuntimeImports(`import type { X } from "hnswlib-node"`)).toEqual([
      { specifier: "hnswlib-node", direct: true }
    ]);
    expect(literalRuntimeImports(`type X = typeof import("hnswlib-node")`)).toEqual([
      { specifier: "hnswlib-node", direct: true }
    ]);
    expect(literalRuntimeImports(`await importOptionalDependency("hnswlib-node")`)).toEqual([
      { specifier: "hnswlib-node", direct: false }
    ]);
    // Declared (incl. a subpath/helper) + node builtin + relative are NOT flagged.
    expect(
      phantomRuntimeImports(
        `await import("js-yaml"); await import("gray-matter/lib/x.js"); await importOptionalDependency("js-yaml");`,
        declared
      )
    ).toEqual([]);
    expect(phantomRuntimeImports(`await import("node:fs"); await import("./local.js");`, declared)).toEqual([]);
  });
});
