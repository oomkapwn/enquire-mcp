// Synthetic-vector tests for the persistent embedding store. These tests
// don't load any ML model — they verify the SQLite schema, the cross-vault
// contamination guard, the upsert/delete/search/sync semantics with hand-
// constructed vectors. End-to-end ML smoke is out-of-band (see manual
// build-embeddings + the smoke.mjs probe in scripts/).

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EmbedDb } from "../src/embed-db.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-embed-db-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function vec(values: number[]): Float32Array {
  // Caller-supplied vectors don't need to be L2-normalized; the store doesn't
  // enforce it. But for cosine to be meaningful, callers normalize before
  // insert. Tests use vectors that ARE pre-normalized so the cosine math is
  // checkable by hand.
  return new Float32Array(values);
}

function l2(v: number[]): Float32Array {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return new Float32Array(v.map((x) => x / (n || 1)));
}

describe("EmbedDb", () => {
  it("opens, closes, and reopens cleanly with the same meta", async () => {
    const file = path.join(dir, "test.embed.db");
    const db1 = new EmbedDb({ file, vaultRoot: "/v1", modelAlias: "multilingual", dim: 4 });
    await db1.open();
    db1.upsertNote("a.md", 1000, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "hello", vector: l2([1, 0, 0, 0]) }
    ]);
    expect(db1.totalChunks()).toBe(1);
    db1.close();

    const db2 = new EmbedDb({ file, vaultRoot: "/v1", modelAlias: "multilingual", dim: 4 });
    await db2.open();
    expect(db2.totalChunks()).toBe(1);
    db2.close();
  });

  it("rebuilds when vault_root changes (cross-vault contamination guard)", async () => {
    const file = path.join(dir, "test.embed.db");
    const db1 = new EmbedDb({ file, vaultRoot: "/v1", modelAlias: "multilingual", dim: 4 });
    await db1.open();
    db1.upsertNote("a.md", 1000, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "hello", vector: l2([1, 0, 0, 0]) }
    ]);
    db1.close();

    // Re-open with a different vault root — should DROP the table.
    const db2 = new EmbedDb({ file, vaultRoot: "/v2", modelAlias: "multilingual", dim: 4 });
    await db2.open();
    expect(db2.totalChunks()).toBe(0);
    db2.close();
  });

  it("rebuilds when model alias changes", async () => {
    const file = path.join(dir, "test.embed.db");
    const db1 = new EmbedDb({ file, vaultRoot: "/v1", modelAlias: "multilingual", dim: 4 });
    await db1.open();
    db1.upsertNote("a.md", 1000, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "hello", vector: l2([1, 0, 0, 0]) }
    ]);
    db1.close();

    const db2 = new EmbedDb({ file, vaultRoot: "/v1", modelAlias: "bge", dim: 4 });
    await db2.open();
    expect(db2.totalChunks()).toBe(0);
    db2.close();
  });

  it("rebuilds when dim changes", async () => {
    const file = path.join(dir, "test.embed.db");
    const db1 = new EmbedDb({ file, vaultRoot: "/v1", modelAlias: "multilingual", dim: 4 });
    await db1.open();
    db1.upsertNote("a.md", 1000, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "hello", vector: l2([1, 0, 0, 0]) }
    ]);
    db1.close();

    const db2 = new EmbedDb({ file, vaultRoot: "/v1", modelAlias: "multilingual", dim: 8 });
    await db2.open();
    expect(db2.totalChunks()).toBe(0);
    db2.close();
  });

  it("rejects vectors with the wrong dim at insert time", async () => {
    const db = new EmbedDb({
      file: path.join(dir, "test.embed.db"),
      vaultRoot: "/v",
      modelAlias: "multilingual",
      dim: 4
    });
    await db.open();
    expect(() =>
      db.upsertNote("a.md", 1000, [
        { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "x", vector: vec([1, 0, 0]) }
      ])
    ).toThrow(/dim mismatch/);
    db.close();
  });

  it("upsert replaces all chunks for a note (no orphan rows)", async () => {
    const db = new EmbedDb({
      file: path.join(dir, "test.embed.db"),
      vaultRoot: "/v",
      modelAlias: "multilingual",
      dim: 4
    });
    await db.open();
    db.upsertNote("a.md", 1000, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "p1", vector: l2([1, 0, 0, 0]) },
      { chunkIndex: 1, lineStart: 5, lineEnd: 5, textPreview: "p2", vector: l2([0, 1, 0, 0]) },
      { chunkIndex: 2, lineStart: 10, lineEnd: 10, textPreview: "p3", vector: l2([0, 0, 1, 0]) }
    ]);
    expect(db.totalChunks()).toBe(3);

    // Re-upsert with fewer chunks — old ones should disappear.
    db.upsertNote("a.md", 2000, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "p1-edited", vector: l2([1, 0, 0, 0]) }
    ]);
    expect(db.totalChunks()).toBe(1);
    db.close();
  });

  it("deleteNote removes embeddings AND source_state", async () => {
    const db = new EmbedDb({
      file: path.join(dir, "test.embed.db"),
      vaultRoot: "/v",
      modelAlias: "multilingual",
      dim: 4
    });
    await db.open();
    db.upsertNote("a.md", 1000, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "p1", vector: l2([1, 0, 0, 0]) }
    ]);
    expect(db.getSourceStates().length).toBe(1);
    db.deleteNote("a.md");
    expect(db.totalChunks()).toBe(0);
    expect(db.getSourceStates().length).toBe(0);
    db.close();
  });

  it("search ranks by cosine descending and respects the limit", async () => {
    const db = new EmbedDb({
      file: path.join(dir, "test.embed.db"),
      vaultRoot: "/v",
      modelAlias: "multilingual",
      dim: 4
    });
    await db.open();
    // Three chunks pointing at three different basis directions.
    db.upsertNote("auth.md", 1000, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "auth-stuff", vector: l2([1, 0, 0, 0]) }
    ]);
    db.upsertNote("cooking.md", 1000, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "pasta", vector: l2([0, 1, 0, 0]) }
    ]);
    db.upsertNote("travel.md", 1000, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "trip", vector: l2([0, 0, 1, 0]) }
    ]);
    // Query close to auth.md.
    const hits = db.search(l2([0.95, 0.31, 0, 0]), 2);
    expect(hits.length).toBe(2);
    expect(hits[0]?.rel_path).toBe("auth.md");
    expect(hits[0]?.score).toBeGreaterThan(hits[1]?.score ?? 0);
    db.close();
  });

  it("search applies minScore threshold", async () => {
    const db = new EmbedDb({
      file: path.join(dir, "test.embed.db"),
      vaultRoot: "/v",
      modelAlias: "multilingual",
      dim: 4
    });
    await db.open();
    db.upsertNote("a.md", 1000, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "x", vector: l2([1, 0, 0, 0]) }
    ]);
    db.upsertNote("b.md", 1000, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "y", vector: l2([0, 1, 0, 0]) }
    ]);
    // Query orthogonal to b.md (cosine = 0) and aligned with a.md (cosine = 1).
    const all = db.search(l2([1, 0, 0, 0]), 10);
    expect(all.length).toBe(2);
    const tight = db.search(l2([1, 0, 0, 0]), 10, { minScore: 0.5 });
    expect(tight.length).toBe(1);
    expect(tight[0]?.rel_path).toBe("a.md");
    db.close();
  });

  it("search applies folder filter via rel_path LIKE prefix", async () => {
    const db = new EmbedDb({
      file: path.join(dir, "test.embed.db"),
      vaultRoot: "/v",
      modelAlias: "multilingual",
      dim: 4
    });
    await db.open();
    db.upsertNote("Auth/oauth.md", 1000, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "auth", vector: l2([1, 0, 0, 0]) }
    ]);
    db.upsertNote("Other/pasta.md", 1000, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "pasta", vector: l2([1, 0, 0, 0]) }
    ]);
    const hits = db.search(l2([1, 0, 0, 0]), 10, { folder: "Auth" });
    expect(hits.length).toBe(1);
    expect(hits[0]?.rel_path).toBe("Auth/oauth.md");
    db.close();
  });

  it("search rejects query vectors with the wrong dim", async () => {
    const db = new EmbedDb({
      file: path.join(dir, "test.embed.db"),
      vaultRoot: "/v",
      modelAlias: "multilingual",
      dim: 4
    });
    await db.open();
    expect(() => db.search(vec([1, 0, 0]), 10)).toThrow(/dim mismatch/);
    db.close();
  });

  it("clearOnDisk removes the .embed.db file (idempotent)", async () => {
    const file = path.join(dir, "test.embed.db");
    const db = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await db.open();
    db.upsertNote("a.md", 1000, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "x", vector: l2([1, 0, 0, 0]) }
    ]);
    db.close();

    expect(
      await fs
        .stat(file)
        .then(() => true)
        .catch(() => false)
    ).toBe(true);
    expect(await db.clearOnDisk()).toBe(true);
    expect(
      await fs
        .stat(file)
        .then(() => true)
        .catch(() => false)
    ).toBe(false);
    // Idempotent — second call returns false but doesn't throw.
    expect(await db.clearOnDisk()).toBe(false);
  });

  it("getSourceStates returns the latest mtime per note for incremental rebuilds", async () => {
    const db = new EmbedDb({
      file: path.join(dir, "test.embed.db"),
      vaultRoot: "/v",
      modelAlias: "multilingual",
      dim: 4
    });
    await db.open();
    db.upsertNote("a.md", 1000, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "x", vector: l2([1, 0, 0, 0]) }
    ]);
    db.upsertNote("b.md", 2000, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "y", vector: l2([0, 1, 0, 0]) }
    ]);
    const states = db.getSourceStates();
    expect(states.length).toBe(2);
    const map = new Map(states.map((s) => [s.rel_path, s.mtime_ms]));
    expect(map.get("a.md")).toBe(1000);
    expect(map.get("b.md")).toBe(2000);

    // Update a.md — mtime should advance.
    db.upsertNote("a.md", 3000, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "x'", vector: l2([1, 0, 0, 0]) }
    ]);
    const after = new Map(db.getSourceStates().map((s) => [s.rel_path, s.mtime_ms]));
    expect(after.get("a.md")).toBe(3000);
    db.close();
  });
});
