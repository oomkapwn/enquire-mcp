// v3.10.0-rc.14 (bug-report Issue 8) — `planCachePrune` is the pure core of the
// `prune` CLI: given the cache dir's filenames + the 12-hex hash of the vault to
// KEEP, it returns ONLY enquire's own artifacts belonging to OTHER vaults. The
// safety property — it can NEVER select a file enquire didn't create — is the
// reason `prune` can delete with confidence, so it gets a discriminating
// NEGATIVE control.
import { describe, expect, it } from "vitest";
import { planCachePrune } from "../src/fts5.js";

describe("planCachePrune (rc.14 — Issue 8 cache GC)", () => {
  const KEEP = "aaaaaaaaaaaa";
  const OTHER = "bbbbbbbbbbbb";

  it("selects OTHER vaults' artifacts (all 5 families + SQLite/tmp sidecars)", () => {
    const entries = [
      `${OTHER}.json`, // v3.10.0-rc.37 (audit #3) — parse cache: FULL note bodies
      `${OTHER}.json.tmp`, // atomic-write leftover (also full bodies)
      `${OTHER}.fts5.db`,
      `${OTHER}.fts5.db-wal`,
      `${OTHER}.fts5.db-shm`,
      `${OTHER}.embed.db`,
      `${OTHER}.hnsw.bin`,
      `${OTHER}.hnsw.meta.json`
    ];
    expect(planCachePrune(entries, KEEP).sort()).toEqual([...entries].sort());
  });

  it("v3.10.0-rc.37 (audit #3): prune covers the `.json` parse cache (full note bodies) — right-to-erasure", () => {
    // Pre-rc.37 the whitelist regex omitted `.json`, so a decommissioned vault's
    // full-text parse cache survived `prune` forever. Both `<hash>.json` and its
    // `.tmp` atomic-write leftover for OTHER must now be selected; KEEP's must not.
    expect(planCachePrune([`${OTHER}.json`, `${OTHER}.json.tmp`, `${KEEP}.json`], KEEP).sort()).toEqual(
      [`${OTHER}.json`, `${OTHER}.json.tmp`].sort()
    );
  });

  it("NEVER selects the kept vault's own artifacts", () => {
    const entries = [
      `${KEEP}.fts5.db`,
      `${KEEP}.embed.db`,
      `${KEEP}.hnsw.bin`,
      `${KEEP}.hnsw.meta.json`,
      `${OTHER}.fts5.db`
    ];
    expect(planCachePrune(entries, KEEP)).toEqual([`${OTHER}.fts5.db`]);
  });

  it("NEGATIVE control: ignores files enquire didn't create (the safety property)", () => {
    // A user note, another app's cache, a wrong-shaped hash, a bare hash, a
    // wrong extension — NONE may ever be selected for deletion. Only the single
    // real enquire artifact for OTHER is returned.
    const entries = [
      "keepme.md",
      "notes.txt",
      "README",
      "config.json",
      "zzz.fts5.db", // hash too short / non-hex
      "gggggggggggg.fts5.db", // 12 chars but not hex
      KEEP, // bare hash, no extension
      `${OTHER}.sqlite`, // enquire hash but wrong extension
      `${OTHER}.fts5.db` // ← the only real artifact
    ];
    expect(planCachePrune(entries, KEEP)).toEqual([`${OTHER}.fts5.db`]);
  });

  it("returns empty when only the kept vault (or nothing) is present", () => {
    expect(planCachePrune([`${KEEP}.fts5.db`, `${KEEP}.embed.db`], KEEP)).toEqual([]);
    expect(planCachePrune([], KEEP)).toEqual([]);
  });
});
