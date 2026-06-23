// v3.10.0-rc.54 — GRAY-MATTER-REMOVAL INVENTORY INVARIANT (structural defense).
//
// rc.53 dropped the `gray-matter` dependency entirely, replacing it with the
// in-repo `src/frontmatter.ts` on js-yaml@5. This invariant makes the removal
// permanent: it fails CI if `gray-matter` ever reappears as a declared dependency
// OR if any `src/**/*.ts` module imports/requires it again. Without this guard a
// future PR could silently re-add the (vulnerable js-yaml@3-binding) dep and the
// only signal would be the npm-audit gate going red — too late and too indirect.
//
// Scope note: PROSE mentions of "gray-matter" (header comments explaining the
// port's provenance, CHANGELOG history) are intentionally allowed — they document
// WHY the dep is gone. The detector matches only an actual import/require, never a
// comment, so the historical references in src/frontmatter.ts / bases.ts stay legal.

import { readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "..");
const srcDir = path.join(repoRoot, "src");

/** Recursively collect every `.ts` file under src/. */
function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collectTsFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** Strip `//` line comments so a prose mention of gray-matter isn't flagged. */
function stripLineComments(source: string): string {
  return source
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("//");
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join("\n");
}

/**
 * Pure detector — true iff `source` actually IMPORTS or REQUIRES gray-matter
 * (static `from "gray-matter"`, dynamic `import("gray-matter")`, or
 * `require("gray-matter")`). Kept standalone so the NEGATIVE control proves it
 * isn't vacuous. Comments are stripped first so prose mentions don't count.
 */
function importsGrayMatter(source: string): boolean {
  const code = stripLineComments(source);
  return /(?:from|import|require)\s*\(?\s*["']gray-matter["']/.test(code);
}

describe("gray-matter removal invariant (rc.54)", () => {
  it("no src/**/*.ts module imports or requires gray-matter (POSITIVE — real tree clean)", () => {
    const offenders = collectTsFiles(srcDir).filter((f) => importsGrayMatter(readFileSync(f, "utf8")));
    expect(offenders.map((f) => path.relative(repoRoot, f))).toEqual([]);
  });

  it("gray-matter is not a declared dependency in any package.json section (POSITIVE)", () => {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as Record<
      string,
      Record<string, string> | undefined
    >;
    const sections = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;
    const found = sections.filter((s) => pkg[s] && Object.hasOwn(pkg[s] as object, "gray-matter"));
    expect(found).toEqual([]);
  });

  it("the detector flags a real import and ignores a prose mention (NEGATIVE control — not vacuous)", () => {
    expect(importsGrayMatter('import matter from "gray-matter";')).toBe(true);
    expect(importsGrayMatter("const m = require('gray-matter');")).toBe(true);
    expect(importsGrayMatter('const x = await import("gray-matter");')).toBe(true);
    // prose / comment mentions must NOT trip the detector
    expect(importsGrayMatter("// faithful port of gray-matter's split logic")).toBe(false);
    expect(importsGrayMatter('import { load } from "js-yaml";')).toBe(false);
  });
});
