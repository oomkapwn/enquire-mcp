// v3.11.6-rc.20 (external audit L-1) + rc.21 (rc.20 re-sweep F2) — script CLI
// entrypoint guards must survive BOTH a checkout path with a SPACE and a
// SYMLINKED invocation path.
//
// L-1 (rc.20): `check-audit.mjs` / `scope-completeness-audit.mjs` compared
// `import.meta.url` with a RAW `` `file://${process.argv[1]}` `` string. A space
// is percent-encoded in `import.meta.url` (`%20`) but literal in `process.argv[1]`,
// so the compare was false in any path with a space — the gate silently no-op'd
// (exit 0, no audit): a false-green in a local/prepublish run.
//
// F2 (rc.21): the L-1 fix replaced the raw form with `path.resolve(...)` on both
// sides. `path.resolve` normalizes `.`/`..`/separators + the space but does NOT
// resolve SYMLINKS — so under a symlinked checkout (macOS `/tmp`→`/private/tmp`,
// a symlinked repo) the two spellings still differ and the gate silently skips.
// A latent recursion of L-1, and a false-green AUDIT gate is exactly what L-1 was.
//
// The class is closed by routing EVERY script through ONE shared realpath-both-
// sides guard — `scripts/lib/entrypoint.mjs` (mirrors src/index.ts). This
// invariant forbids (a) the raw-URL form and (b) any hand-rolled symlink-weak
// inline guard (argv[1] compared to import.meta.url WITHOUT realpath), pins the
// shared helper to the realpath form, and proves behaviorally that the realpath
// guard fires through a symlink while the `path.resolve` form silently skips.

import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const scriptsDir = path.resolve(__dirname, "../scripts");

/** Strip `//` line comments + block comments so a documented mention of a broken
 *  pattern (e.g. inside a fix's explanatory comment) isn't a false offender. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

// (a) the raw `file://${process.argv[1]}` template compare (the L-1 bug).
const RAW_URL_GUARD = /file:\/\/\$\{\s*process\.argv\[1\]\s*\}/;
// (b) an inline entrypoint compare of process.argv[1] against this module's URL
//     that does NOT go through realpath (the F2 symlink-weak form). Matches a
//     single line holding both `process.argv[1]` and an `import.meta.url` /
//     `fileURLToPath` / `__filename` token joined by `===`.
function isSymlinkWeakGuardLine(line: string): boolean {
  if (!/process\.argv\[1\]/.test(line)) return false;
  if (!/===/.test(line)) return false;
  if (!/(import\.meta\.url|fileURLToPath|__filename)/.test(line)) return false;
  return !/realpath/i.test(line);
}

// The raw literal, assembled so `${` never appears in a plain string (biome's
// noTemplateCurlyInString would flag it). `CURLY` = the two chars `$` + `{`.
const CURLY = `$${"{"}`;
const RAW_LITERAL = `file://${CURLY}process.argv[1]}`;

describe("script CLI entrypoint-guard invariant (audit L-1 rc.20 + F2 rc.21)", () => {
  it("no scripts/*.mjs uses the raw file-URL + process.argv[1] compare (POSITIVE, L-1)", async () => {
    const files = (await fs.readdir(scriptsDir)).filter((f) => f.endsWith(".mjs"));
    expect(files.length, "sanity: scripts/ has .mjs files").toBeGreaterThan(5);
    const offenders: string[] = [];
    for (const f of files) {
      const code = stripComments(await fs.readFile(path.join(scriptsDir, f), "utf8"));
      if (RAW_URL_GUARD.test(code)) offenders.push(f);
    }
    expect(
      offenders,
      `route the entrypoint guard through scripts/lib/entrypoint.mjs:\n${offenders.join("\n")}`
    ).toEqual([]);
  });

  it("no scripts/*.mjs hand-rolls a symlink-weak inline entrypoint guard (POSITIVE, F2)", async () => {
    const files = (await fs.readdir(scriptsDir)).filter((f) => f.endsWith(".mjs"));
    const offenders: string[] = [];
    for (const f of files) {
      const code = stripComments(await fs.readFile(path.join(scriptsDir, f), "utf8"));
      for (const line of code.split("\n")) {
        if (isSymlinkWeakGuardLine(line)) offenders.push(`${f}: ${line.trim()}`);
      }
    }
    expect(
      offenders,
      `compare argv[1] to import.meta.url via realpath (use isEntrypoint(import.meta.url)); path.resolve is symlink-blind:\n${offenders.join(
        "\n"
      )}`
    ).toEqual([]);
  });

  it("the shared scripts/lib/entrypoint.mjs guard realpaths BOTH sides (STRUCTURAL)", async () => {
    const helper = await fs.readFile(path.join(scriptsDir, "lib", "entrypoint.mjs"), "utf8");
    expect(helper, "helper must export isEntrypoint").toMatch(/export function isEntrypoint/);
    // realpathSync applied to process.argv[1] AND to the fileURLToPath(importMetaUrl).
    expect(helper).toMatch(/realpathSync\(\s*process\.argv\[1\]\s*\)/);
    expect(helper).toMatch(/realpathSync\(\s*fileURLToPath\(/);
  });

  it("NEGATIVE control — detectors fire on the weak forms and NOT on the realpath/delegating forms", () => {
    // raw-URL detector
    expect(RAW_URL_GUARD.test(`if (import.meta.url === \`${RAW_LITERAL}\`) main();`)).toBe(true);
    expect(RAW_URL_GUARD.test("if (isEntrypoint(import.meta.url)) main();")).toBe(false);
    // symlink-weak detector
    expect(
      isSymlinkWeakGuardLine(
        "process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))"
      )
    ).toBe(true);
    expect(isSymlinkWeakGuardLine("process.argv[1] && path.resolve(process.argv[1]) === __filename")).toBe(true);
    // the realpath form and the delegating form are NOT weak
    expect(
      isSymlinkWeakGuardLine("realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))")
    ).toBe(false);
    expect(isSymlinkWeakGuardLine("if (isEntrypoint(import.meta.url)) {")).toBe(false);
    // an unrelated argv[2] read that merely mentions import.meta.url elsewhere isn't a guard
    expect(isSymlinkWeakGuardLine("const target = resolve(repoRoot, process.argv[2] ?? 'x')")).toBe(false);
    // the stripper removes a comment that merely MENTIONS the raw pattern
    expect(RAW_URL_GUARD.test(stripComments(`  // beware \`${RAW_LITERAL}\` breaks on spaces`))).toBe(false);
  });

  it("behavioral — the realpath guard FIRES through a SYMLINK; the path.resolve form silently SKIPS", async () => {
    const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "enquireguard-")));
    const realDir = path.join(base, "with space real");
    await fs.mkdir(realDir);
    const linkDir = path.join(base, "link"); // a symlink pointing at realDir
    await fs.symlink(realDir, linkDir);
    try {
      const strong = path.join(realDir, "strong.mjs");
      const weak = path.join(realDir, "weak.mjs");
      await fs.writeFile(
        strong,
        'import { realpathSync } from "node:fs";\nimport { fileURLToPath } from "node:url";\n' +
          'if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) console.log("RAN");\nelse console.log("SKIP");\n'
      );
      await fs.writeFile(
        weak,
        'import * as path from "node:path";\nimport { fileURLToPath } from "node:url";\n' +
          'if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) console.log("RAN");\nelse console.log("SKIP");\n'
      );
      // Invoke via the SYMLINKED spelling of the directory.
      const ran = spawnSync(process.execPath, [path.join(linkDir, "strong.mjs")], { encoding: "utf8" }).stdout.trim();
      const skipped = spawnSync(process.execPath, [path.join(linkDir, "weak.mjs")], { encoding: "utf8" }).stdout.trim();
      expect(ran, "the realpath guard must fire through a symlinked invocation path").toBe("RAN");
      expect(skipped, "the path.resolve guard silently skips through a symlink — the F2 bug").toBe("SKIP");
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });
});
