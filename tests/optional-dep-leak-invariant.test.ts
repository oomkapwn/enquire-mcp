// v3.10.0-rc.55 (OPTDEP-MODULE-PATH-LEAK-02) — OPTIONAL-DEP IMPORT-ERROR LEAK INVARIANT.
//
// Node's module-resolution error for a missing optional dependency EMBEDS the
// ABSOLUTE path of the importing file ("Cannot find package 'X' imported from
// /Users/<you>/.../dist/ocr.js"). Interpolating that `err.message` / `String(err)`
// into a thrown Error leaks the host filesystem layout to bearer-auth serve-http
// clients — the abs-path-leak class (cf. rc.45/rc.49 for vault fs errors). The fix
// (rc.55) routes every optional-dep `import()` catch through `optionalDepDetail`,
// which surfaces only the error CODE.
//
// This invariant pins the class for the curated inventory of modules that load
// optional deps via `import()` (the same inventory discipline as
// enforcement-guard-invariant / erasure-invariant). A new such module must be added
// here AND use `optionalDepDetail` — a raw `${err.message}` / `${String(err)}`
// interpolation in any listed file fails CI.

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { optionalDepDetail } from "../src/optional-dep.js";

const repoRoot = path.resolve(__dirname, "..");

// Inventory: every src module that loads an optional dependency via `import()`.
// v3.10.0-rc.57 (OPTDEP-SQLITE-PATH-LEAK-EMBEDDB) — added embed-db.ts + fts5.ts: their
// `await import("better-sqlite3")` loaders interpolated raw `err.message` (an
// ERR_MODULE_NOT_FOUND embedding the importing file's abs path) that reaches serve-http
// clients via `signal_errors.embeddings`. The rc.55 inventory was scope-too-narrow (3 files);
// these two sqlite loaders were the missed siblings — the signature "instance fix ≠ class fix".
const OPTIONAL_DEP_LOADERS = ["src/ocr.ts", "src/pdf.ts", "src/embeddings.ts", "src/embed-db.ts", "src/fts5.ts"];

/** Strip `//` line comments so a prose mention of `err.message` isn't flagged. */
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
 * Pure detector — true iff `source` interpolates a caught error's raw message
 * into a string (`${… err.message …}` or `${… String(err) …}`), the shape that
 * leaks the abs path. Kept standalone so the NEGATIVE control proves it isn't
 * vacuous. Comments are stripped first.
 */
function leaksRawError(source: string): boolean {
  const code = stripLineComments(source);
  return /\$\{[^}]*\berr\.message\b[^}]*\}/.test(code) || /\$\{[^}]*\bString\(\s*err\s*\)[^}]*\}/.test(code);
}

describe("optional-dep import-error leak invariant (rc.55)", () => {
  it("no optional-dep loader interpolates a raw import error (POSITIVE — inventory clean)", () => {
    const offenders = OPTIONAL_DEP_LOADERS.filter((f) => leaksRawError(readFileSync(path.join(repoRoot, f), "utf8")));
    expect(offenders, `these loaders leak err.message/String(err): ${offenders.join(", ")}`).toEqual([]);
  });

  it("the detector flags a raw-error interpolation and ignores a comment (NEGATIVE control — not vacuous)", () => {
    // Assemble the `${...}` token at runtime so biome's noTemplateCurlyInString rule
    // doesn't (correctly) flag these intentional leaky-source fixtures in the source.
    const interp = (inner: string) => `throw new Error(\`load failed: ${"$"}{${inner}}\`);`;
    expect(leaksRawError(interp("err.message"))).toBe(true);
    expect(leaksRawError(interp("String(err)"))).toBe(true);
    // path-free detail + a comment mentioning err.message must NOT trip the detector
    expect(leaksRawError(interp("optionalDepDetail(err)"))).toBe(false);
    expect(leaksRawError("// err.message embeds the importing file's abs path")).toBe(false);
  });

  it("optionalDepDetail surfaces only the error code, never a path (POSITIVE)", () => {
    expect(optionalDepDetail({ code: "ERR_MODULE_NOT_FOUND" })).toBe("error code: ERR_MODULE_NOT_FOUND");
    expect(optionalDepDetail(new Error("x"))).toBe("error code: unknown");
    // a realistic Node error message contains an abs path; the detail must not echo it
    const nodeErr = Object.assign(new Error("Cannot find package 'x' imported from /Users/secret/dist/ocr.js"), {
      code: "ERR_MODULE_NOT_FOUND"
    });
    expect(optionalDepDetail(nodeErr)).not.toMatch(/\/Users\/secret/);
    expect(optionalDepDetail(nodeErr)).toBe("error code: ERR_MODULE_NOT_FOUND");
  });
});
