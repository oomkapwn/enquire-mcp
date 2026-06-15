// v3.10.0-rc.49 — ABS-PATH-LEAK INVENTORY INVARIANT (P0 structural defense).
//
// Closes the abs-path information-disclosure class at the apparatus level. rc.45
// added `Vault.sanitizeFsError` and wired it into 3 read sinks (readFile,
// readBinaryFile, stat) — and CLAIMED the class was closed "at the SOURCE every
// caller funnels through". The rc45-48 re-audit proved that FALSE: the write path
// (writeNote/renameFile/appendNote — HIGH) and readNote (the primary read funnel —
// MEDIUM) still threw RAW fs errors embedding the host's absolute vault/home path,
// reaching any bearer-token serve-http client as the tool's isError text. Classic
// "audit-driven fix recurs its own class in the next surface" (cf. rc.40/rc.41).
//
// WHY THE GATES MISSED IT: the CI apparatus is drift/claim-driven; it has no lens
// for "does a thrown error reaching an MCP client embed an absolute path?". rc.45
// was an INSTANCE fix (3 named sinks); nothing enforced completeness.
//
// This invariant converts "did we sanitize every fs sink?" (recursion-prone) into
// a self-checking gate: every raw `fs.<sink>(` in src/vault.ts must sit in a method
// that also references `sanitizeFsError` (the *Safe wrappers and the inline
// try/catch methods both satisfy this), OR carry an explicit `abs-path-safe`
// exemption marker for a genuinely non-client-reachable / error-swallowed site.
// A NEW unsanitized fs sink fails CI — the next surface cannot escape.

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "..");

// The fs ops that can throw a raw Error embedding the absolute path. `realpath` is
// INCLUDED — rc.49 found resolveSafePath's realpath leaked ENOTDIR with the abs path
// (the behavioral test caught what the first static sweep missed). lstat/chmod stay
// excluded: they are always `.catch`-guarded probes (the detector also skips any line
// containing `.catch(`).
const SINK = /\bfs\.(stat|realpath|readFile|writeFile|mkdir|open|rename|link|copyFile|unlink|readdir)\(/;
// A class member at exactly 2-space indent. Control-flow keywords at that indent
// (`if (`, `for (`, …) are NOT methods — exclude them so block bodies aren't
// mis-attributed.
const METHOD_SIG =
  /^ {2}(?:public |private |protected |static |readonly |async |get |set )*[A-Za-z_$][\w$]*\s*(?:<[^>]*>)?\(/;
const CONTROL_KW = new Set(["if", "for", "while", "switch", "catch", "return", "await", "throw", "else", "do", "with"]);
const EXEMPT = /abs-path-safe/; // documented marker for a non-leaking / swallowed sink

type Method = { name: string; start: number; lines: string[] };

/** The `Vault` class body only — module-level helpers (walk/walkAnyExt) are
 *  separately safe (they swallow readdir errors + `.catch`-guard probes) and
 *  can't use `this.sanitizeFsError`, so they're out of scope for this invariant. */
function vaultClassBody(src: string): { body: string; offset: number } {
  const start = src.indexOf("export class Vault");
  const afterClass = src.slice(start).search(/\n(?:export )?(?:async )?function /);
  const end = afterClass < 0 ? src.length : start + afterClass;
  const offset = src.slice(0, start).split("\n").length - 1; // line number of class start (0-based)
  return { body: src.slice(start, end), offset };
}

/** Split a TS class source into its 2-space-indent member bodies. */
function splitMethods(src: string): Method[] {
  const lines = src.split("\n");
  const methods: Method[] = [];
  let cur: Method | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const name = /^ {2}(?:[a-z]+ )*([A-Za-z_$][\w$]*)\s*[(<]/.exec(line)?.[1];
    if (METHOD_SIG.test(line) && name && !CONTROL_KW.has(name)) {
      if (cur) methods.push(cur);
      cur = { name, start: i + 1, lines: [line] };
    } else if (cur) {
      cur.lines.push(line);
    }
  }
  if (cur) methods.push(cur);
  return methods;
}

/**
 * Pure detector — returns the names+lines of methods that contain a RAW (non-
 * `.catch`-guarded) fs sink but neither reference `sanitizeFsError` nor an
 * `abs-path-safe` exemption marker. Exported shape lets the NEGATIVE control
 * prove it isn't vacuous.
 */
function findUnsanitizedFsSinks(src: string): Array<{ method: string; line: number; code: string }> {
  const out: Array<{ method: string; line: number; code: string }> = [];
  const { body: classBody, offset } = vaultClassBody(src);
  for (const m of splitMethods(classBody)) {
    const body = m.lines.join("\n");
    const sanitizes = body.includes("sanitizeFsError") || EXEMPT.test(body);
    if (sanitizes) continue;
    for (let j = 0; j < m.lines.length; j++) {
      const raw = m.lines[j] ?? "";
      // Strip line-comments + skip block-comment lines so a `fs.x(` inside a
      // TSDoc/`//` comment isn't mistaken for a real sink.
      const code = raw.split("//")[0] ?? "";
      if (raw.trimStart().startsWith("*") || raw.trimStart().startsWith("/*")) continue;
      if (SINK.test(code) && !code.includes(".catch(")) {
        out.push({ method: m.name, line: offset + m.start + j, code: raw.trim() });
      }
    }
  }
  return out;
}

describe("abs-path-leak inventory invariant (rc.49)", () => {
  it("every raw fs sink in src/vault.ts sits in a sanitizing (or exempt) method", () => {
    const src = readFileSync(path.join(repoRoot, "src/vault.ts"), "utf8");
    const offenders = findUnsanitizedFsSinks(src);
    const detail = offenders.map((o) => `  ${o.method}() @vault.ts:${o.line}  ${o.code}`).join("\n");
    expect(
      offenders,
      `Raw fs sinks not funnelled through sanitizeFsError (leak the host abs path):\n${detail}`
    ).toEqual([]);
  });

  it("detector flags a raw sink in a non-sanitizing method (NEGATIVE control)", () => {
    const bad = `export class Vault {\n  async leaky(p) {\n    return await fs.readFile(p, "utf8");\n  }\n}`;
    expect(findUnsanitizedFsSinks(bad)).toHaveLength(1);
    // A method that sanitizes is NOT flagged.
    const good = `export class Vault {\n  async safe(p) {\n    try { return await fs.readFile(p); } catch (e) { throw this.sanitizeFsError(e); }\n  }\n}`;
    expect(findUnsanitizedFsSinks(good)).toHaveLength(0);
    // A \`.catch\`-guarded probe is NOT flagged (it swallows the error).
    const probe = `export class Vault {\n  async probe(p) {\n    return await fs.lstat(p).catch(() => null) ?? (await fs.stat(p).catch(() => null));\n  }\n}`;
    expect(findUnsanitizedFsSinks(probe)).toHaveLength(0);
    // An explicit exemption marker suppresses the flag.
    const exempt = `export class Vault {\n  async internal(p) {\n    // abs-path-safe(rc.49): startup-only\n    return await fs.mkdir(p, { recursive: true });\n  }\n}`;
    expect(findUnsanitizedFsSinks(exempt)).toHaveLength(0);
  });
});
