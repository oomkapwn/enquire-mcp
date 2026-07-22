// v3.11.6-rc.20 (external audit L-1) — script CLI entrypoint guards must survive
// a checkout path that contains a space.
//
// `check-audit.mjs` and `scope-completeness-audit.mjs` compared
// `import.meta.url` with a RAW `` `file://${process.argv[1]}` `` string. A space
// is percent-encoded in `import.meta.url` (`%20`) but stays literal in
// `process.argv[1]`, so the comparison was false in any path containing a space
// (a common macOS shape, e.g. `.../New project/...`) — the entrypoint body was
// silently skipped and the script exited 0 WITHOUT running its gate. That made
// the mandatory audit gate a false-green in a local/prepublish run.
//
// This closes the CLASS: an inventory invariant forbidding the raw-URL compare
// in any `scripts/*.mjs`, plus a behavioral proof that the resolved-path form
// (`path.resolve(fileURLToPath(import.meta.url))`) fires from a space path while
// the raw form silently skips.

import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const scriptsDir = path.resolve(__dirname, "../scripts");

/** Strip `//` line comments + `/* *​/` block comments so a documented mention of
 *  the broken pattern (e.g. in a fix's explanatory comment) isn't a false offender. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

// The broken entrypoint comparison: a raw `file://` template over process.argv[1].
const RAW_URL_GUARD = /file:\/\/\$\{\s*process\.argv\[1\]\s*\}/;
// The broken literal, assembled so `${` never appears in a plain string (which
// biome's noTemplateCurlyInString would flag as a probable typo — here it's the
// deliberate fixture we detect). `CURLY` = the two chars `$` + `{`.
const CURLY = `$${"{"}`;
const RAW_LITERAL = `file://${CURLY}process.argv[1]}`;

describe("script CLI entrypoint-guard invariant (audit L-1, rc.20)", () => {
  it("no scripts/*.mjs uses the raw file-URL + process.argv[1] entrypoint compare (POSITIVE)", async () => {
    const files = (await fs.readdir(scriptsDir)).filter((f) => f.endsWith(".mjs"));
    expect(files.length, "sanity: scripts/ has .mjs files").toBeGreaterThan(5);
    const offenders: string[] = [];
    for (const f of files) {
      const code = stripComments(await fs.readFile(path.join(scriptsDir, f), "utf8"));
      if (RAW_URL_GUARD.test(code)) offenders.push(f);
    }
    expect(
      offenders,
      `use \`path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))\` (breaks on spaces otherwise):\n${offenders.join("\n")}`
    ).toEqual([]);
  });

  it("NEGATIVE control — the detector fires on the raw form and NOT on the resolved form", () => {
    expect(RAW_URL_GUARD.test(`if (import.meta.url === \`${RAW_LITERAL}\`) main();`)).toBe(true);
    expect(
      RAW_URL_GUARD.test(
        "process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))"
      )
    ).toBe(false);
    // The stripper must remove a comment that merely MENTIONS the raw pattern.
    expect(RAW_URL_GUARD.test(stripComments(`  // beware \`${RAW_LITERAL}\` breaks on spaces`))).toBe(false);
  });

  it("behavioral — the resolved-path guard FIRES from a space path; the raw form silently SKIPS", async () => {
    // realpath the temp base so ONLY the injected space (not a /tmp symlink) is the variable.
    const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "enquireguard-")));
    const spaceDir = path.join(base, "with space");
    await fs.mkdir(spaceDir);
    try {
      const fixed = path.join(spaceDir, "fixed.mjs");
      const broken = path.join(spaceDir, "broken.mjs");
      await fs.writeFile(
        fixed,
        'import * as path from "node:path";\nimport { fileURLToPath } from "node:url";\n' +
          'if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) console.log("RAN");\nelse console.log("SKIP");\n'
      );
      await fs.writeFile(
        broken,
        `if (import.meta.url === \`${RAW_LITERAL}\`) console.log('RAN');\nelse console.log('SKIP');\n`
      );
      const ran = spawnSync(process.execPath, [fixed], { encoding: "utf8" }).stdout.trim();
      const skipped = spawnSync(process.execPath, [broken], { encoding: "utf8" }).stdout.trim();
      expect(ran, "the fixed guard must fire from a checkout path with a space").toBe("RAN");
      expect(skipped, "the raw-URL guard silently skips from a space path — the L-1 bug").toBe("SKIP");
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });
});
