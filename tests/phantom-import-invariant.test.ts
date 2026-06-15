// v3.10.0-rc.50 — PHANTOM-IMPORT INVENTORY INVARIANT (structural defense).
//
// Closes the phantom-dependency class (re-audit SC-PHANTOM-JSYAML-01): `src/bases.ts`
// did `await import("js-yaml")` for a CORE feature (`.base` parsing) without declaring
// js-yaml in package.json — it resolved ONLY via gray-matter's transitive pin + npm's
// flat hoisting, and would break under pnpm-no-hoist / Yarn PnP / a gray-matter major.
//
// TypeScript/tsc verify STATIC imports against installed types, but a DYNAMIC
// `import("x")` with a bare specifier is just a runtime string — nothing checks the
// package is declared. This invariant scans every dynamic import in src/ and fails CI
// if its package root isn't in `dependencies` or `optionalDependencies`. The next
// phantom dynamic dep can't ship.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { isBuiltin } from "node:module";
import * as path from "node:path";
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

/**
 * Pure detector — returns dynamic-import package roots NOT covered by `declared`
 * (and not node: builtins / relative). Exported shape lets the NEGATIVE control
 * prove it isn't vacuous.
 */
function phantomDynamicImports(src: string, declared: Set<string>): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/\bimport\(\s*["']([^"']+)["']/g)) {
    const spec = m[1] ?? "";
    if (spec.startsWith(".") || spec.startsWith("node:") || isBuiltin(spec)) continue;
    const root = packageRoot(spec);
    if (!declared.has(root)) out.push(spec);
  }
  return out;
}

describe("phantom-import inventory invariant (rc.50)", () => {
  it("every dynamic import in src/ has its package declared in package.json", () => {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    const declared = new Set<string>([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.optionalDependencies ?? {})
    ]);
    const offenders: string[] = [];
    for (const file of collectTsFiles(path.join(repoRoot, "src"))) {
      for (const spec of phantomDynamicImports(readFileSync(file, "utf8"), declared)) {
        offenders.push(`${path.relative(repoRoot, file)}: import("${spec}")`);
      }
    }
    expect(offenders, `Undeclared dynamic-import dependencies (phantom deps):\n${offenders.join("\n")}`).toEqual([]);
  });

  it("detector flags an undeclared dynamic import (NEGATIVE control)", () => {
    const declared = new Set(["gray-matter", "js-yaml"]);
    expect(phantomDynamicImports(`const m = await import("undeclared-pkg");`, declared)).toEqual(["undeclared-pkg"]);
    // Declared (incl. a subpath) + node builtin + relative are NOT flagged.
    expect(phantomDynamicImports(`await import("js-yaml"); await import("gray-matter/lib/x.js");`, declared)).toEqual(
      []
    );
    expect(phantomDynamicImports(`await import("node:fs"); await import("./local.js");`, declared)).toEqual([]);
  });
});
