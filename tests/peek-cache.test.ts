// v3.7.0 L-1 — unit tests for `peekEmbedDbMetaCached`.
//
// The cache must:
//   1. Return the same shape as the non-cached `peekEmbedDbMeta`.
//   2. Return cached value on consecutive calls when file mtime unchanged.
//   3. Refresh when file mtime changes (e.g. rebuild flow).
//   4. Drop the cache entry on `stat` failure (file deleted between calls).
//   5. Be cleared by `clearPeekCache()` for test isolation.
//
// Why this matters: `embeddingsSearch` (src/tools/search.ts:917) calls this
// on every search invocation since v3.6.4's K-1a fix. A regression in the
// cache (e.g. caching the wrong file, never invalidating) would silently
// reintroduce the data-corruption class — old peek result, new on-disk
// state with a different `model_alias`. The mtime-based invalidation is
// the contract; this file pins it.

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearPeekCache, EmbedDb, lruMapSet, peekEmbedDbMeta, peekEmbedDbMetaCached } from "../src/embed-db.js";

describe("peekEmbedDbMetaCached (v3.7.0 L-1)", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-peek-cache-"));
    clearPeekCache();
  });
  afterEach(async () => {
    clearPeekCache();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns null when the file doesn't exist (cache-miss falls through to peekEmbedDbMeta)", async () => {
    const meta = await peekEmbedDbMetaCached(path.join(tmpDir, "missing.embed.db"));
    expect(meta).toBeNull();
  });

  it("returns the same shape as non-cached peekEmbedDbMeta on the first call", async () => {
    const file = path.join(tmpDir, "bge.embed.db");
    const db = new EmbedDb({ file, vaultRoot: tmpDir, modelAlias: "bge", dim: 384 });
    await db.open();
    db.close();
    const direct = await peekEmbedDbMeta(file);
    const cached = await peekEmbedDbMetaCached(file);
    expect(cached).toEqual(direct);
    expect(cached?.model_alias).toBe("bge");
  });

  it("returns the SAME (reference-equal) cached object on consecutive calls when mtime unchanged", async () => {
    const file = path.join(tmpDir, "ref.embed.db");
    const db = new EmbedDb({ file, vaultRoot: tmpDir, modelAlias: "bge", dim: 384 });
    await db.open();
    db.close();
    const first = await peekEmbedDbMetaCached(file);
    const second = await peekEmbedDbMetaCached(file);
    // Reference equality — proves the cache returned the same in-memory
    // object, NOT a fresh SQLite read.
    expect(second).toBe(first);
  });

  it("refreshes the cache when file mtime changes (rebuild flow)", async () => {
    const file = path.join(tmpDir, "rebuild.embed.db");
    // Build with bge.
    const db1 = new EmbedDb({ file, vaultRoot: tmpDir, modelAlias: "bge", dim: 384 });
    await db1.open();
    db1.close();
    const first = await peekEmbedDbMetaCached(file);
    expect(first?.model_alias).toBe("bge");

    // Force a mtime bump by waiting then touching the file.
    await new Promise((r) => setTimeout(r, 20));
    const now = new Date();
    await fs.utimes(file, now, now);

    // Re-open with a different model — this rewrites meta (bge → multilingual).
    const db2 = new EmbedDb({ file, vaultRoot: tmpDir, modelAlias: "multilingual", dim: 384 });
    await db2.open();
    db2.close();

    const second = await peekEmbedDbMetaCached(file);
    // Different object reference (cache miss → fresh read).
    expect(second).not.toBe(first);
    expect(second?.model_alias).toBe("multilingual");
  });

  it("drops the cache entry when the file is deleted between calls", async () => {
    const file = path.join(tmpDir, "deleted.embed.db");
    const db = new EmbedDb({ file, vaultRoot: tmpDir, modelAlias: "bge", dim: 384 });
    await db.open();
    db.close();
    const first = await peekEmbedDbMetaCached(file);
    expect(first?.model_alias).toBe("bge");
    // Delete the file + the SQLite WAL/SHM sidecars to ensure complete
    // removal (otherwise re-opening the same path might still see the meta).
    await fs.rm(file, { force: true });
    await fs.rm(`${file}-wal`, { force: true });
    await fs.rm(`${file}-shm`, { force: true });
    const second = await peekEmbedDbMetaCached(file);
    expect(second).toBeNull();
  });

  it("`clearPeekCache()` forces a fresh peek on the next call", async () => {
    const file = path.join(tmpDir, "manual-clear.embed.db");
    const db = new EmbedDb({ file, vaultRoot: tmpDir, modelAlias: "bge", dim: 384 });
    await db.open();
    db.close();
    const first = await peekEmbedDbMetaCached(file);
    clearPeekCache();
    const second = await peekEmbedDbMetaCached(file);
    // Same values but different objects — proves the manual clear worked.
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
  });
});

// v3.9.0-rc.28 (external-audit M-6) — the LRU bound that keeps `peekCache` from
// growing without limit over a long-running serve. Driven directly (the cached
// path needs real files); positive + NEGATIVE controls.
describe("lruMapSet — bounded LRU insert", () => {
  it("caps the map at `max` entries, evicting the oldest first (positive)", () => {
    const m = new Map<string, number>();
    for (let i = 0; i < 10; i++) lruMapSet(m, `k${i}`, i, 4);
    expect(m.size).toBe(4); // never exceeds the cap
    // Oldest (k0..k5) evicted; newest 4 (k6..k9) retained.
    expect([...m.keys()]).toEqual(["k6", "k7", "k8", "k9"]);
    expect(m.get("k0")).toBeUndefined();
    expect(m.get("k9")).toBe(9);
  });

  it("refreshes recency on re-set so a touched key is NOT evicted (LRU, not FIFO)", () => {
    const m = new Map<string, number>();
    lruMapSet(m, "a", 1, 3);
    lruMapSet(m, "b", 2, 3);
    lruMapSet(m, "c", 3, 3);
    lruMapSet(m, "a", 10, 3); // touch "a" → now newest
    lruMapSet(m, "d", 4, 3); // evicts the oldest, which is now "b" (not "a")
    expect(m.has("a")).toBe(true);
    expect(m.has("b")).toBe(false);
    expect(m.get("a")).toBe(10);
  });

  it("(NEGATIVE control) a plain Map.set with no bound grows unbounded", () => {
    // Proves the bound is what does the work: without lruMapSet, the same 10
    // inserts leave 10 entries (the unbounded-growth the audit flagged).
    const naive = new Map<string, number>();
    for (let i = 0; i < 10; i++) naive.set(`k${i}`, i);
    expect(naive.size).toBe(10);
  });
});
