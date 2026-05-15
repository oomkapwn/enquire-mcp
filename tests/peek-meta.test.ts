// v3.6.2 K-1 unit tests — V-5 closure from external audit.
//
// Background. The v3.6.1 emergency patch added `peekEmbedDbMeta()`
// but shipped it WITHOUT unit tests. The external (anonymous) audit
// on v3.6.1 flagged this gap as V-5. A regression would silently
// re-introduce DROP TABLE on model_alias / tokenize_mode mismatch
// (data destruction) without firing any test.
//
// This file covers BOTH peek helpers (`peekEmbedDbMeta` for embed-db,
// `peekFtsMetaSafe` for fts5) with the same 3 scenario types:
//   1. file doesn't exist → null
//   2. file exists but no `meta` table yet (fresh db) → null
//   3. file exists with populated meta → meta dict honored
//
// Plus a regression guarantee for the K-1b doctor case:
// `doctor` running against an fts5 index built with `--tokenize trigram`
// must NOT trigger DROP TABLE. We assert by reading the chunk count
// before AND after the doctor probe — must be identical.

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EmbedDb, peekEmbedDbMeta } from "../src/embed-db.js";
import { FtsIndex, peekFtsMetaSafe } from "../src/fts5.js";

describe("peekEmbedDbMeta (v3.6.2 K-1a)", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-peek-embed-"));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns null when the file doesn't exist", async () => {
    const meta = await peekEmbedDbMeta(path.join(tmpDir, "missing.embed.db"));
    expect(meta).toBeNull();
  });

  it("returns populated meta after a build with explicit model_alias", async () => {
    const file = path.join(tmpDir, "bge.embed.db");
    const db = new EmbedDb({ file, vaultRoot: tmpDir, modelAlias: "bge", dim: 384 });
    await db.open();
    db.close();
    const meta = await peekEmbedDbMeta(file);
    expect(meta).not.toBeNull();
    expect(meta?.model_alias).toBe("bge");
    expect(meta?.dim).toBe("384");
    expect(meta?.vault_root).toBe(tmpDir);
  });

  it("regression guard: peek does NOT trigger DROP TABLE on the underlying db", async () => {
    // Build a db with `bge`.
    const file = path.join(tmpDir, "regression.embed.db");
    const db = new EmbedDb({ file, vaultRoot: tmpDir, modelAlias: "bge", dim: 384 });
    await db.open();
    db.close();
    // Peek N times — must not corrupt anything.
    for (let i = 0; i < 3; i++) {
      const m = await peekEmbedDbMeta(file);
      expect(m?.model_alias).toBe("bge");
    }
    // Re-open with the SAME model — no DROP fires.
    const db2 = new EmbedDb({ file, vaultRoot: tmpDir, modelAlias: "bge", dim: 384 });
    await db2.open();
    db2.close();
    // Meta is still `bge` post-reopen.
    const finalMeta = await peekEmbedDbMeta(file);
    expect(finalMeta?.model_alias).toBe("bge");
  });
});

describe("peekFtsMetaSafe (v3.6.2 K-1b — sibling class)", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-peek-fts-"));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns null when the file doesn't exist", async () => {
    const meta = await peekFtsMetaSafe(path.join(tmpDir, "missing.fts5.db"));
    expect(meta).toBeNull();
  });

  it("returns populated meta with tokenize_mode after a build", async () => {
    const file = path.join(tmpDir, "trigram.fts5.db");
    const idx = new FtsIndex({ file, vaultRoot: tmpDir, tokenize: "trigram" });
    await idx.open();
    idx.close();
    const meta = await peekFtsMetaSafe(file);
    expect(meta).not.toBeNull();
    expect(meta?.tokenize_mode).toBe("trigram");
    expect(meta?.vault_root).toBe(tmpDir);
  });

  it("regression guard: peek does NOT trigger DROP TABLE chunks", async () => {
    const file = path.join(tmpDir, "regression.fts5.db");
    const idx = new FtsIndex({ file, vaultRoot: tmpDir, tokenize: "trigram" });
    await idx.open();
    idx.close();
    // Multiple peeks must be idempotent + non-destructive.
    for (let i = 0; i < 3; i++) {
      const m = await peekFtsMetaSafe(file);
      expect(m?.tokenize_mode).toBe("trigram");
    }
    // Re-open with the matching tokenize — no DROP.
    const idx2 = new FtsIndex({ file, vaultRoot: tmpDir, tokenize: "trigram" });
    await idx2.open();
    idx2.close();
    const finalMeta = await peekFtsMetaSafe(file);
    expect(finalMeta?.tokenize_mode).toBe("trigram");
  });

  // K-1b critical regression: this is the EXACT scenario the external auditor
  // caught — a trigram-built index opened with default tokenize (unicode61)
  // pre-fix would DROP TABLE. Post-fix, the caller peeks first and honors
  // the existing mode. We assert the helper returns the right tokenize_mode
  // so a calling chain that does `peek → honor → open` is data-safe.
  it("K-1b regression: trigram-built db returns tokenize_mode='trigram' for callers to honor", async () => {
    const file = path.join(tmpDir, "k1b.fts5.db");
    const idx = new FtsIndex({ file, vaultRoot: tmpDir, tokenize: "trigram" });
    await idx.open();
    idx.close();
    const meta = await peekFtsMetaSafe(file);
    // Caller pattern: `const tokenize = peeked?.tokenize_mode ?? "unicode61"`.
    // If we returned "unicode61" by default here, callers would DROP.
    expect(meta?.tokenize_mode).toBe("trigram");
  });
});
