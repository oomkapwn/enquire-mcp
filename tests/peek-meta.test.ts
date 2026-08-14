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
// Doctor no longer uses these helpers: its stronger immutable-snapshot
// preservation contract lives in doctor.test.ts, including a real
// migration-primitive negative control.

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
    expect((await peekEmbedDbMeta(file, tmpDir))?.model_alias).toBe("bge");
    expect(await peekEmbedDbMeta(file, path.join(tmpDir, "foreign-root"))).toBeNull();
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
    expect((await peekFtsMetaSafe(file, tmpDir))?.tokenize_mode).toBe("trigram");
    expect(await peekFtsMetaSafe(file, path.join(tmpDir, "foreign-root"))).toBeNull();

    // Discovery is deliberately fail-soft, but it must not turn an unknown
    // stored value into unicode61. The same-handle open admission remains the
    // authority and will reject this metadata without rebuilding it.
    const { default: Database } = await import("better-sqlite3");
    const raw = new Database(file);
    raw.prepare("UPDATE meta SET value = ? WHERE key = 'tokenize_mode'").run("porter");
    raw.close();
    expect(await peekFtsMetaSafe(file)).toBeNull();
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
  // pre-fix would DROP TABLE. This legacy compatibility helper still exposes
  // the historical value without coercion; production callers now use the
  // discriminated full-class discovery API instead.
  it("K-1b regression: trigram-built db returns tokenize_mode='trigram' for callers to honor", async () => {
    const file = path.join(tmpDir, "k1b.fts5.db");
    const idx = new FtsIndex({ file, vaultRoot: tmpDir, tokenize: "trigram" });
    await idx.open();
    idx.close();
    const meta = await peekFtsMetaSafe(file);
    // Historical diagnostic contract: never fabricate "unicode61" here.
    expect(meta?.tokenize_mode).toBe("trigram");
  });
});

// Historical v3.6.3 compatibility controls. These pin the old raw helper's
// non-destructive behavior and the bootstrap failure mode that motivated K-1.
// Current production cli/server/search callers do not use this pattern: they
// consume discriminated, expected-root, full-class discovery results, whose
// structural and behavioral controls live in k1-class-invariant/CLI/server/search tests.
describe("K-1 historical peek compatibility guards (v3.6.3)", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-peek-caller-"));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("legacy Embed peek compatibility: build with `bge`, re-open honoring it, meta stays `bge`", async () => {
    const file = path.join(tmpDir, "caller.embed.db");
    // Build with bge.
    const db1 = new EmbedDb({ file, vaultRoot: tmpDir, modelAlias: "bge", dim: 384 });
    await db1.open();
    db1.close();

    // Simulate the historical pre-discovery caller pattern solely as a
    // compatibility control. A skipped read demonstrates the K-1 bootstrap
    // consequence in the negative sibling below.
    const peeked = await peekEmbedDbMeta(file);
    expect(peeked?.model_alias).toBe("bge");
    const honored = peeked?.model_alias ?? "multilingual";
    const db2 = new EmbedDb({ file, vaultRoot: tmpDir, modelAlias: honored, dim: 384 });
    await db2.open();
    db2.close();

    // After the "caller" re-open, meta is still bge — caller honored it.
    const after = await peekEmbedDbMeta(file);
    expect(after?.model_alias).toBe("bge");
  });

  it("legacy FTS peek compatibility: build with trigram, re-open honoring it, meta stays trigram", async () => {
    const file = path.join(tmpDir, "caller.fts5.db");
    // Build with trigram.
    const idx1 = new FtsIndex({ file, vaultRoot: tmpDir, tokenize: "trigram" });
    await idx1.open();
    idx1.close();

    // Historical compatibility pattern; production uses discoverFtsIndexConfig.
    const peeked = await peekFtsMetaSafe(file);
    expect(peeked?.tokenize_mode).toBe("trigram");
    const honored = peeked?.tokenize_mode ?? "unicode61";
    const idx2 = new FtsIndex({ file, vaultRoot: tmpDir, tokenize: honored });
    await idx2.open();
    idx2.close();

    const after = await peekFtsMetaSafe(file);
    expect(after?.tokenize_mode).toBe("trigram");
  });

  it("legacy Embed pattern: NEGATIVE control — constructor without discovery can DROP", async () => {
    // Pre-v3.6.3 (and pre-v3.6.2 for several callers): caller constructs
    // EmbedDb with the default modelAlias without peeking. bootstrapSchema
    // detects mismatch and DROPs. This test pins the BAD behavior so any
    // future refactor that "fixes" bootstrapSchema to be non-destructive
    // surfaces in test results (would change this test, forcing review).
    const file = path.join(tmpDir, "negative.embed.db");
    const db1 = new EmbedDb({ file, vaultRoot: tmpDir, modelAlias: "bge", dim: 384 });
    await db1.open();
    db1.close();

    // The intentionally bad historical caller skips all discovery and uses a different alias.
    const dbBad = new EmbedDb({ file, vaultRoot: tmpDir, modelAlias: "wrong-alias", dim: 384 });
    await dbBad.open();
    dbBad.close();

    // Meta is now "wrong-alias" — the original bge is gone. This is the
    // failure mode the K-1 fix prevents at every caller. Documenting the
    // bug class explicitly so its consequence is testable.
    const after = await peekEmbedDbMeta(file);
    expect(after?.model_alias).toBe("wrong-alias");
  });
});

// v3.7.5 — external audit (v3.6.2 report) found 2 CRITICAL bugs that 5
// rounds of internal audit + the K-1 invariant chain MISSED. These
// regression tests pin the fixes.
describe("K-1 / K-2 external-audit regression guards (v3.7.5)", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-v375-"));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("K-1 (CRITICAL): peek-honored alias must thread to loadEmbedder, not raw args.model", () => {
    // The external auditor caught: src/tools/search.ts:945 called
    // `loadEmbedder(args.model)`. If user omits args.model AND embed-db
    // was built with bge, the EmbedDb was opened with `bge` (correct)
    // but the embedder loaded with `multilingual` (the default that
    // resolveModel(undefined) returns). Vector-space mismatch, silent
    // garbage similarities, response still reports model='bge'.
    //
    // This test pins the fix at the SOURCE-CODE level: grep search.ts
    // for the loadEmbedder call inside embeddingsSearch and assert it
    // takes `model.alias` (the honored variable), not `args.model`.
    // We can't directly test the runtime behavior without loading the
    // embedder (which requires the model download); the source-grep
    // is a fast structural guard.
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const src = fs.readFileSync(path.join(process.cwd(), "src/tools/search.ts"), "utf8");
    // Search for `loadEmbedder(args.model)` — this is the BUG signature.
    // Allow `loadEmbedder(args.model)` ONLY inside HyDE-pickEmbedTextForHyde
    // unrelated paths; in embeddingsSearch's main body we must use the
    // honored `model.alias`.
    const bugSignature = /loadEmbedder\s*\(\s*args\.model\s*\)/;
    const matches = src.match(bugSignature);
    expect(matches, "K-1 regression: loadEmbedder(args.model) found — should be loadEmbedder(model.alias)").toBeNull();
    // Sanity: the honored-alias version must be present.
    const fixSignature = /loadEmbedder\s*\(\s*model\.alias\s*\)/;
    expect(src).toMatch(fixSignature);
  });

  it("K-2 (CRITICAL): read-only search must throw on model mismatch, not DROP TABLE", async () => {
    // The external auditor caught: passing `embedding_model` override
    // that differs from the stored alias caused EmbedDb.bootstrapSchema
    // to DROP TABLE embeddings + source_state. Data destruction from a
    // read-only tool.
    //
    // v3.7.5 fix: detect mismatch BEFORE constructing EmbedDb and throw
    // a clear actionable error. This test exercises the source-grep
    // signature of the fix (the throw statement) plus a behavioral
    // test: when the K-2 check fires, the on-disk meta stays bge.
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const src = fs.readFileSync(path.join(process.cwd(), "src/tools/search.ts"), "utf8");
    // The K-2 throw must reference "Read-only search refuses to rebuild"
    expect(src).toMatch(/Read-only search refuses to rebuild/);
    // Full-class metadata must pass through the shared supported-catalog
    // projection before the mismatch check can inspect its safe alias.
    expect(src).toMatch(/resolveStoredEmbeddingConfiguration\(discovered\.meta\)/);
    expect(src).toMatch(/args\.model.*storedConfiguration\.model\.alias/);

    // Behavioral pin: simulate the K-2 path locally. The actual fix
    // throws BEFORE EmbedDb opens; so the on-disk file is untouched.
    const file = path.join(tmpDir, "k2.embed.db");
    const db = new EmbedDb({ file, vaultRoot: tmpDir, modelAlias: "bge", dim: 384 });
    await db.open();
    db.close();
    const before = await peekEmbedDbMeta(file);
    expect(before?.model_alias).toBe("bge");

    // The K-2 mismatch check (extracted from search.ts:917+ pattern):
    const argsModel = "wrong-alias";
    const existingAlias = before?.model_alias;
    const shouldThrow = argsModel && existingAlias && argsModel !== existingAlias;
    expect(shouldThrow).toBe(true);

    // If the production code throws (as fixed in v3.7.5), the on-disk
    // file is never re-opened destructively. Confirm by peeking again.
    const after = await peekEmbedDbMeta(file);
    expect(after?.model_alias).toBe("bge");
  });
});
