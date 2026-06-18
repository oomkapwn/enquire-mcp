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
// v3.10.0-rc.59 — added hnsw.ts: its `await import("hnswlib-node")` loader used a
// `const msg = err.message; …${msg}` INDIRECTION the rc.57 detector was blind to (it matched
// only DIRECT `${err.message}`) — missed by the rc.57 inventory AND the 8-lens audit. The
// detector below is now indirection-aware (catches the var-capture pattern in a `throw`).
const OPTIONAL_DEP_LOADERS = [
  "src/ocr.ts",
  "src/pdf.ts",
  "src/embeddings.ts",
  "src/embed-db.ts",
  "src/fts5.ts",
  "src/hnsw.ts"
];

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
 * Pure detector — true iff `source` interpolates a caught error's raw message into a THROWN
 * Error, the shape that leaks the importing file's abs path to clients. Catches BOTH:
 *   • DIRECT       — `throw new Error(\`… ${err.message} …\`)` / `${String(err)}`
 *   • INDIRECTION  — `const msg = err.message; … throw new Error(\`… ${msg} …\`)`
 * (rc.59 — the indirection form is what hnsw.ts used and the rc.57 direct-only detector missed.)
 * Server-side `process.stderr.write(… ${msg})` logs are NOT flagged (operator's own machine;
 * only a THROWN Error reaches the MCP client). Comments are stripped first. Standalone so the
 * NEGATIVE control proves it isn't vacuous.
 */
function leaksRawError(source: string): boolean {
  const code = stripLineComments(source);
  // The leak SINK is a thrown Error reaching the MCP client — NOT a server-side
  // `process.stderr.write(… ${err.message})` (operator's own machine). So every check is
  // scoped to a `throw new Error(...)` statement (bounded to one statement via `[^;]` —
  // a throw statement has no `;` until its end). Tainted tokens = the caught error's raw
  // message, directly OR captured into a `const`.
  const tainted = [
    "err\\.message",
    "String\\(\\s*err\\s*\\)",
    ...[...code.matchAll(/\bconst\s+(\w+)\s*=\s*[^;\n]*?(?:err\.message|String\(\s*err\s*\))/g)].map((m) => m[1])
  ];
  for (const t of tainted) {
    if (new RegExp(`throw new Error\\([^;]*?\\$\\{[^}]*?${t}[^}]*?\\}`).test(code)) return true;
  }
  return false;
}

describe("optional-dep import-error leak invariant (rc.55)", () => {
  it("no optional-dep loader interpolates a raw import error (POSITIVE — inventory clean)", () => {
    const offenders = OPTIONAL_DEP_LOADERS.filter((f) => leaksRawError(readFileSync(path.join(repoRoot, f), "utf8")));
    expect(offenders, `these loaders leak err.message/String(err): ${offenders.join(", ")}`).toEqual([]);
  });

  it("the detector flags direct AND indirection raw-error throws, ignores stderr logs (NEGATIVE control — not vacuous)", () => {
    // Assemble the `${...}` token at runtime so biome's noTemplateCurlyInString rule
    // doesn't (correctly) flag these intentional leaky-source fixtures in the source.
    const D = "$"; // dollar, kept off-source so no literal `${` appears
    const throwInterp = (inner: string) => `throw new Error(\`load failed: ${D}{${inner}}\`);`;
    // DIRECT interpolation in a throw — flagged.
    expect(leaksRawError(throwInterp("err.message"))).toBe(true);
    expect(leaksRawError(throwInterp("String(err)"))).toBe(true);
    // INDIRECTION (rc.59 — hnsw.ts's shape): const capture then `${msg}` in a throw — flagged.
    const indirection = `const msg = err instanceof Error ? err.message : String(err);\nthrow new Error(\`x: ${D}{msg}\`);`;
    expect(leaksRawError(indirection), "must catch the const-msg indirection").toBe(true);
    // A server-side stderr log of the SAME captured var is NOT a client leak — must NOT flag.
    const stderrLog = `const msg = err instanceof Error ? err.message : String(err);\nprocess.stderr.write(\`x: ${D}{msg}\\n\`);`;
    expect(leaksRawError(stderrLog), "stderr logs are operator-side, not flagged").toBe(false);
    // path-free detail + a comment mentioning err.message must NOT trip the detector.
    expect(leaksRawError(throwInterp("optionalDepDetail(err)"))).toBe(false);
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
