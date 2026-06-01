// v3.10.0-rc.2 — obsidian_stale_notes handler.
// Controls mtimes via fs.utimes so age/threshold behavior is exact.

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { staleNotes } from "../src/tools/read.js";
import { Vault } from "../src/vault.js";

const DAY = 86_400_000;
let root: string;

/** Write a note and force its mtime to `ageDays` days ago. */
async function note(rel: string, ageDays: number): Promise<void> {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, `# ${rel}\n\nbody\n`);
  const when = new Date(Date.now() - ageDays * DAY);
  await fs.utimes(abs, when, when);
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-stale-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("staleNotes (v3.10 forgetting-aware staleness surface)", () => {
  it("returns notes older than the threshold, OLDEST first, with age_days", async () => {
    await note("fresh.md", 1);
    await note("old.md", 400);
    await note("ancient.md", 800);
    const v = new Vault(root);
    const r = await staleNotes(v, { stale_days: 365 });
    expect(r.scanned_notes).toBe(3);
    expect(r.stale_days).toBe(365);
    expect(r.matches.map((m) => m.path)).toEqual(["ancient.md", "old.md"]); // oldest first, fresh excluded
    expect(r.matches[0]?.age_days).toBeGreaterThanOrEqual(799);
    expect(r.matches[0]).toMatchObject({ path: "ancient.md", title: "ancient" });
    expect(typeof r.matches[0]?.mtime).toBe("string");
  });

  it("defaults to the 365-day threshold when stale_days omitted", async () => {
    await note("recent.md", 100);
    await note("year-old.md", 400);
    const v = new Vault(root);
    const r = await staleNotes(v, {});
    expect(r.stale_days).toBe(365);
    expect(r.matches.map((m) => m.path)).toEqual(["year-old.md"]); // 100d note is fresh at default
  });

  it("honors a custom stale_days threshold", async () => {
    await note("a.md", 50);
    await note("b.md", 200);
    const v = new Vault(root);
    expect((await staleNotes(v, { stale_days: 30 })).matches.map((m) => m.path)).toEqual(["b.md", "a.md"]);
    expect((await staleNotes(v, { stale_days: 100 })).matches.map((m) => m.path)).toEqual(["b.md"]);
  });

  it("respects limit (still oldest-first)", async () => {
    await note("x.md", 400);
    await note("y.md", 900);
    await note("z.md", 600);
    const v = new Vault(root);
    const r = await staleNotes(v, { stale_days: 365, limit: 2 });
    expect(r.matches.map((m) => m.path)).toEqual(["y.md", "z.md"]); // top-2 oldest
  });

  it("restricts to folder when given", async () => {
    await note("Archive/old.md", 500);
    await note("Inbox/old.md", 500);
    const v = new Vault(root);
    const r = await staleNotes(v, { stale_days: 365, folder: "Archive" });
    expect(r.matches.map((m) => m.path)).toEqual(["Archive/old.md"]);
  });

  // NEGATIVE control: an all-fresh vault yields ZERO stale notes (the filter
  // genuinely excludes — not a constant pass-through).
  it("NEGATIVE control — an all-fresh vault returns no stale notes", async () => {
    await note("a.md", 1);
    await note("b.md", 10);
    const v = new Vault(root);
    const r = await staleNotes(v, { stale_days: 365 });
    expect(r.scanned_notes).toBe(2);
    expect(r.matches).toEqual([]);
  });
});
