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
// read. Skips gracefully if dist/ isn't built (same pattern as e2e-handlers).

import { spawnSync } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs script, no type declarations
import { createSyntheticVault } from "../scripts/synthetic-vault.mjs";

const repoRoot = path.resolve(__dirname, "..");
const distEntry = path.join(repoRoot, "dist", "index.js");
const smokeScript = path.join(repoRoot, "scripts", "smoke.mjs");
const tmpDirs: string[] = [];

afterEach(async () => {
  for (const d of tmpDirs.splice(0)) {
    await fs.rm(d, { recursive: true, force: true }).catch(() => {});
  }
});

describe("smoke default-vault target (audit G-1)", () => {
  it("POSITIVE — createSyntheticVault builds under tmpdir, not the home vault", async () => {
    const vault = (await createSyntheticVault()) as string;
    tmpDirs.push(vault);
    const homeVault = path.join(os.homedir(), "Documents", "Obsidian Vault");
    expect(vault).not.toBe(homeVault);
    expect(vault.startsWith(os.tmpdir())).toBe(true);
    // It's a usable vault: the canonical fixture notes exist.
    expect(existsSync(path.join(vault, "INDEX.md"))).toBe(true);
    expect(existsSync(path.join(vault, "01_Projects", "Apollo.md"))).toBe(true);
  });

  it("NEGATIVE control — no-arg smoke never reads ~/Documents/Obsidian Vault", async () => {
    if (!existsSync(distEntry)) {
      // dist not built (fresh checkout without `npm run build`) — skip, like e2e-handlers.
      return;
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
    expect(run.status).toBe(0);
  }, 90_000);
});
