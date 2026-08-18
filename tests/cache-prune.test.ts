// v3.10.0-rc.14 (bug-report Issue 8) — `planCachePrune` is the canonical-name
// classifier beneath the CLI's on-disk identity-aware planner. Given filenames
// + the 12-hex hash to KEEP, it returns only canonically spelled reserved
// families for OTHER hashes. This is bounded name recognition, not provenance.
import { describe, expect, it } from "vitest";
import { planCachePrune } from "../src/fts5.js";

describe("planCachePrune (rc.14 — Issue 8 cache GC)", () => {
  const KEEP = "aaaaaaaaaaaa";
  const OTHER = "bbbbbbbbbbbb";

  it("selects OTHER vaults' complete legacy/generated artifact families", () => {
    const token = "a".repeat(48);
    const entries = [
      `${OTHER}.json`, // v3.10.0-rc.37 (audit #3) — parse cache: FULL note bodies
      `${OTHER}.json.tmp`, // atomic-write leftover (also full bodies)
      `${OTHER}.json.enquire-tmp-${token}`,
      `${OTHER}.json.enquire-stage-${token}`,
      `${OTHER}.feedback.json.enquire-tmp-${token}`,
      `${OTHER}.fts5.db`,
      `${OTHER}.fts5.db-wal`,
      `${OTHER}.fts5.db-shm`,
      `${OTHER}.fts5.db-journal`,
      `${OTHER}.embed.db`,
      `${OTHER}.embed.db-wal`,
      `${OTHER}.embed.db-shm`,
      `${OTHER}.embed.db-journal`,
      `${OTHER}.hnsw.bin`,
      `${OTHER}.hnsw.meta.json`,
      `${OTHER}.hnsw.${token}.bin`,
      `${OTHER}.hnsw.${token}.bin.enquire-stage-${token}`,
      `${OTHER}.hnsw.meta.json.enquire-tmp-${token}`
    ];
    expect(planCachePrune(entries, KEEP).sort()).toEqual([...entries].sort());
  });

  it("v3.10.0-rc.37 (audit #3): prune covers the `.json` parse cache (full note bodies) — right-to-erasure", () => {
    // Pre-rc.37 the whitelist regex omitted `.json`, so a decommissioned vault's
    // full-text parse cache survived `prune` forever. Both `<hash>.json` and its
    // `.tmp` atomic-write leftover for OTHER must now be selected; KEEP's must not.
    const token = "b".repeat(48);
    const removable = [
      `${OTHER}.json`,
      `${OTHER}.json.tmp`,
      `${OTHER}.json.enquire-tmp-${token}`,
      `${OTHER}.json.enquire-stage-${token}`
    ];
    expect(planCachePrune([...removable, `${KEEP}.json`], KEEP).sort()).toEqual([...removable].sort());
  });

  it("NEVER selects the kept vault hash's recognized artifacts", () => {
    const token = "c".repeat(48);
    const entries = [
      `${KEEP}.fts5.db`,
      `${KEEP}.embed.db`,
      `${KEEP}.hnsw.bin`,
      `${KEEP}.hnsw.meta.json`,
      `${KEEP}.json.enquire-tmp-${token}`,
      `${KEEP}.hnsw.${token}.bin`,
      `${KEEP}.hnsw.${token}.bin.enquire-stage-${token}`,
      `${OTHER}.fts5.db`
    ];
    expect(planCachePrune(entries, KEEP)).toEqual([`${OTHER}.fts5.db`]);
  });

  it("NEGATIVE control: ignores names outside the reserved artifact namespace", () => {
    // A user note, another app's cache, a wrong-shaped hash, a bare hash, a
    // wrong extension — NONE may ever be selected for deletion. Only the single
    // recognized artifact for OTHER is returned.
    const entries = [
      "keepme.md",
      "notes.txt",
      "README",
      "config.json",
      "zzz.fts5.db", // hash too short / non-hex
      "gggggggggggg.fts5.db", // 12 chars but not hex
      KEEP, // bare hash, no extension
      `${OTHER}.sqlite`, // enquire hash but wrong extension
      `${OTHER}.json.enquire-tmp-short`, // publisher token must be exactly 48 hex
      `${OTHER}.notes.md.enquire-tmp-${"d".repeat(48)}`, // generated wrapper around a non-enquire final
      `${OTHER}.hnsw.${"g".repeat(48)}.bin`, // generation token is non-hex
      `${OTHER}.fts5.db` // ← the only real artifact
    ];
    expect(planCachePrune(entries, KEEP)).toEqual([`${OTHER}.fts5.db`]);
  });

  it.each([`${OTHER.toUpperCase()}.HNSW.${"A".repeat(48)}.BIN`] as const)(
    "pure planning rejects non-canonical spelling %s until on-disk identity proof",
    (entry) => {
      expect(planCachePrune([entry], KEEP)).toEqual([]);
    }
  );

  it.each([
    { label: "valid lowercase routing key", keepHash: KEEP, accepted: true },
    { label: "short routing key", keepHash: "a".repeat(11), accepted: false },
    { label: "non-hex routing key", keepHash: "g".repeat(12), accepted: false },
    { label: "uppercase routing key", keepHash: KEEP.toUpperCase(), accepted: false },
    { label: "routing key with trailing LF", keepHash: `${KEEP}\n`, accepted: false }
  ])("validates a $label before planning", ({ keepHash, accepted }) => {
    if (accepted) {
      expect(planCachePrune([`${OTHER}.json`, `${KEEP}.json`], keepHash)).toEqual([`${OTHER}.json`]);
    } else {
      expect(() => planCachePrune([`${OTHER}.json`], keepHash)).toThrow(/exactly 12 lowercase hexadecimal characters/);
    }
  });

  it("returns empty when only the kept vault (or nothing) is present", () => {
    expect(planCachePrune([`${KEEP}.fts5.db`, `${KEEP}.embed.db`], KEEP)).toEqual([]);
    expect(planCachePrune([], KEEP)).toEqual([]);
  });
});
