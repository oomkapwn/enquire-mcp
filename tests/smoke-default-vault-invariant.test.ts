// v3.11.6-rc.3 (audit G-1) — smoke-harness target-confusion guard.
//
// Finding (Codex external audit, novel class): `node scripts/smoke.mjs` with
// NO positional vault argument fell back to `~/Documents/Obsidian Vault` — the
// maintainer's conventional REAL vault — and printed its note titles/paths.
// That silently changed the smoke target and disclosed local note metadata.
//
// Fix: with no arg, smoke builds a throwaway synthetic vault under os.tmpdir()
// (the exported `createSyntheticVault`), never the real vault. CI still passes
// an explicit synthetic path.
//
// This file pins both halves: a POSITIVE unit on `createSyntheticVault` (it
// lives under tmpdir, not the home vault) and a behavioral NEGATIVE control —
// the auditor's own G-1 harness inverted: run the no-arg smoke with a controlled
// HOME containing a sentinel real-vault note and assert the sentinel is NEVER
// read. The positive case also structurally pins early serve-http child-close
// observation plus timeout cancellation, with a causal mutation control, so a
// fast startup crash cannot regress into a misleading eight-second timeout.
// Skips gracefully if dist/ isn't built (same pattern as e2e-handlers).

import { spawnSync } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs script, no type declarations
import { createSyntheticVault } from "../scripts/synthetic-vault.mjs";
import { replaceExactly } from "./helpers/exact-source-mutation.js";

const repoRoot = path.resolve(__dirname, "..");
const distEntry = path.join(repoRoot, "dist", "index.js");
const smokeScript = path.join(repoRoot, "scripts", "smoke.mjs");
const tmpDirs: string[] = [];

function httpStartupObservationProblems(source: string): string[] {
  const start = source.indexOf("async function smokeHttp(");
  const httpSmoke = start >= 0 ? source.slice(start) : "";
  const problems: string[] = [];
  if (!httpSmoke.includes('httpProc.once("close"')) {
    problems.push("HTTP smoke does not observe child close before declaring a startup timeout");
  }
  if (!httpSmoke.includes("clearTimeout(timeout)")) {
    problems.push("HTTP smoke leaves its startup timeout alive after an earlier outcome");
  }
  if (httpSmoke.includes("Promise.race([")) {
    problems.push("HTTP smoke still races only the ready banner against an uncleared timer");
  }
  return problems;
}

afterEach(async () => {
  for (const d of tmpDirs.splice(0)) {
    await fs.rm(d, { recursive: true, force: true }).catch(() => {});
  }
});

describe("smoke default-vault target (audit G-1)", () => {
  it("POSITIVE — synthetic target and HTTP startup observer are structurally guarded", async () => {
    const vault = (await createSyntheticVault()) as string;
    tmpDirs.push(vault);
    const homeVault = path.join(os.homedir(), "Documents", "Obsidian Vault");
    expect(vault).not.toBe(homeVault);
    expect(vault.startsWith(os.tmpdir())).toBe(true);
    // It's a usable vault: the canonical fixture notes exist.
    expect(existsSync(path.join(vault, "INDEX.md"))).toBe(true);
    expect(existsSync(path.join(vault, "01_Projects", "Apollo.md"))).toBe(true);

    const smokeSource = await fs.readFile(smokeScript, "utf8");
    expect(httpStartupObservationProblems(smokeSource)).toEqual([]);
    // Causal mutation control: deleting the early-child observation recreates
    // the misleading eight-second timeout that hid the real startup error.
    const blindMutant = replaceExactly(
      smokeSource,
      'httpProc.once("close"',
      'httpProc.once("ignored-close"'
    );
    expect(httpStartupObservationProblems(blindMutant)).toContain(
      "HTTP smoke does not observe child close before declaring a startup timeout"
    );
  });

  it("NEGATIVE control — no-arg smoke never reads ~/Documents/Obsidian Vault", async (ctx) => {
    if (!existsSync(distEntry)) {
      // dist not built (fresh checkout without `npm run build`) — VISIBLE skip
      // (rc.12; the e2e-handlers CI-GUARD already asserts dist exists in CI,
      // so this skip is only reachable locally).
      return ctx.skip();
    }
    // Controlled HOME with a sentinel "real" vault the OLD code would have targeted.
    const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "smoke-home-"));
    tmpDirs.push(fakeHome);
    const sentinelVault = path.join(fakeHome, "Documents", "Obsidian Vault");
    await fs.mkdir(sentinelVault, { recursive: true });
    const sentinel = "SMOKE_SENTINEL_DO_NOT_READ";
    await fs.writeFile(path.join(sentinelVault, `${sentinel}.md`), `# ${sentinel}\n[[other]]\n`);

    const run = spawnSync(process.execPath, [smokeScript], {
      cwd: repoRoot,
      env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome },
      encoding: "utf8",
      timeout: 80_000
    });

    const out = `${run.stdout ?? ""}${run.stderr ?? ""}`;
    // The fix announces a synthetic vault and never touches the sentinel real vault.
    expect(out).toMatch(/synthetic vault/i);
    expect(out).not.toContain(sentinel);
    expect(
      run.status,
      `smoke process error=${run.error?.message ?? "none"} signal=${run.signal ?? "none"}\n${out}`
    ).toBe(0);
  }, 90_000);
});
