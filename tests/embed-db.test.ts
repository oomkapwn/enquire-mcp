// Synthetic-vector tests for the persistent embedding store. These tests
// don't load any ML model — they verify the SQLite schema, the cross-vault
// contamination guard, the upsert/delete/search/sync semantics with hand-
// constructed vectors. End-to-end ML smoke is out-of-band (see manual
// build-embeddings + the smoke.mjs probe in scripts/).

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodeInt8Vector, EmbedDb, encodeInt8Vector, peekEmbedDbMeta } from "../src/embed-db.js";

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

  it("releases its handle when open() throws on a corrupt db — close-on-throw (rc.70 reserve-before-try)", async () => {
    const file = path.join(dir, "corrupt.embed.db");
    await fs.writeFile(file, "not a sqlite database — garbage ".repeat(40));
    const db = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await expect(db.open()).rejects.toThrow();
    // Pre-rc.70 `this.db` stayed SET after the post-construction throw (pragma/bootstrapSchema),
    // so the `if (this.db) return` guard made a SECOND open() a silent no-op — the handle (+ its
    // WAL/SHM locks) leaked for the serve lifetime. The close-on-throw catch resets `this.db=null`,
    // so a second open() RE-THROWS: the behavioral proof the handle was released. (NEGATIVE control:
    // without the reset, the next line would resolve instead of reject.)
    await expect(db.open()).rejects.toThrow();
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

  it("folder filter matches an emoji (astral-char) folder name (rc.43 M1 — substr by char, not JS UTF-16)", async () => {
    const db = new EmbedDb({
      file: path.join(dir, "test.embed.db"),
      vaultRoot: "/v",
      modelAlias: "multilingual",
      dim: 4
    });
    await db.open();
    // "📚Books" leads with a non-BMP char (JS length 7, 6 code points). Pre-rc.43 the
    // prefix.length (UTF-16) bound to substr(...,1,?) (code points) matched ZERO rows.
    db.upsertNote("📚Books/oauth.md", 1000, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "auth", vector: l2([1, 0, 0, 0]) }
    ]);
    db.upsertNote("Other/pasta.md", 1000, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "pasta", vector: l2([1, 0, 0, 0]) }
    ]);
    const hits = db.search(l2([1, 0, 0, 0]), 10, { folder: "📚Books" });
    expect(hits.length).toBe(1);
    expect(hits[0]?.rel_path).toBe("📚Books/oauth.md");
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

  // v3.9.0-rc.34 (deep-audit P-2) — clearOnDisk must ALSO remove the HNSW
  // persistence sidecars (`<base>.hnsw.bin` + `<base>.hnsw.meta.json`), since
  // the .meta.json carries `text_preview` (raw chunk text). Previously these
  // survived `clear-embeddings`, a right-to-erasure gap for `--use-hnsw` users.
  it("clearOnDisk also removes the HNSW sidecars (P-2 erasure)", async () => {
    const file = path.join(dir, "vaultx.embed.db");
    const db = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await db.open();
    db.upsertNote("a.md", 1000, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "secret note text", vector: l2([1, 0, 0, 0]) }
    ]);
    db.close();
    // Simulate the HNSW persist sidecars next to the embed-db (same base the
    // server derives: strip `.embed.db`, append `.hnsw`).
    const base = `${file.replace(/\.embed\.db$/, "")}.hnsw`;
    const binFile = `${base}.bin`;
    const metaFile = `${base}.meta.json`;
    await fs.writeFile(binFile, Buffer.from([1, 2, 3, 4]));
    await fs.writeFile(metaFile, JSON.stringify({ text_preview: "secret note text" }));

    expect(await db.clearOnDisk()).toBe(true);
    // Both the embed-db AND both HNSW sidecars must be gone.
    for (const p of [file, binFile, metaFile]) {
      expect(
        await fs
          .stat(p)
          .then(() => true)
          .catch(() => false),
        `${p} should be removed`
      ).toBe(false);
    }
  });

  it("(negative control) clearOnDisk leaves UNRELATED sidecars untouched (P-2)", async () => {
    // Guard against over-deletion: a `.hnsw.bin` for a DIFFERENT embed-db base
    // must NOT be removed when clearing this one.
    const file = path.join(dir, "mine.embed.db");
    const db = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await db.open();
    db.upsertNote("a.md", 1000, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "x", vector: l2([1, 0, 0, 0]) }
    ]);
    db.close();
    const otherSidecar = path.join(dir, "someone-else.hnsw.bin");
    await fs.writeFile(otherSidecar, Buffer.from([9]));

    await db.clearOnDisk();
    expect(
      await fs
        .stat(otherSidecar)
        .then(() => true)
        .catch(() => false)
    ).toBe(true); // untouched
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

  // v2.8.0 — PDF chunks indexed via the kind column.
  it("upserts with kind='pdf' and search returns kind='pdf'", async () => {
    const file = path.join(dir, "test.embed.db");
    const db = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await db.open();
    try {
      // Markdown chunk.
      db.upsertNote("a.md", 1000, [
        { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "alpha", vector: l2([1, 0, 0, 0]) }
      ]);
      // PDF chunk — same dim, different kind.
      db.upsertNote(
        "paper.pdf",
        2000,
        [{ chunkIndex: 0, lineStart: 1, lineEnd: 5, textPreview: "[page: 1] alpha", vector: l2([1, 0, 0, 0]) }],
        "pdf"
      );
      // Cosine query that matches both.
      const hits = db.search(l2([1, 0, 0, 0]), 10);
      const byKind = new Map(hits.map((h) => [h.rel_path, h.kind]));
      expect(byKind.get("a.md")).toBe("md");
      expect(byKind.get("paper.pdf")).toBe("pdf");
    } finally {
      db.close();
    }
  });

  it("getSourceStates(kind='md') and getSourceStates(kind='pdf') don't overlap", async () => {
    const file = path.join(dir, "test.embed.db");
    const db = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await db.open();
    try {
      db.upsertNote("a.md", 1000, [
        { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "a", vector: l2([1, 0, 0, 0]) }
      ]);
      db.upsertNote(
        "p.pdf",
        2000,
        [{ chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "p", vector: l2([0, 1, 0, 0]) }],
        "pdf"
      );
      const md = db.getSourceStates("md").map((s) => s.rel_path);
      const pdf = db.getSourceStates("pdf").map((s) => s.rel_path);
      expect(md).toEqual(["a.md"]);
      expect(pdf).toEqual(["p.pdf"]);
      // Backward-compat: no kind filter returns both.
      const all = db.getSourceStates().map((s) => s.rel_path);
      expect(all.sort()).toEqual(["a.md", "p.pdf"]);
    } finally {
      db.close();
    }
  });

  it("schema bump from v1 → v2 auto-rebuilds (idempotent on matching schema)", async () => {
    const file = path.join(dir, "test.embed.db");
    const db1 = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await db1.open();
    db1.upsertNote("a.md", 1000, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "x", vector: l2([1, 0, 0, 0]) }
    ]);
    expect(db1.totalChunks()).toBe(1);
    db1.close();

    // Reopen with matching meta — should preserve data.
    const db2 = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await db2.open();
    expect(db2.totalChunks()).toBe(1);
    db2.close();
  });
});

// v2.17.0 — int8 quantization. The encode/decode helpers are pure (no DB),
// so we exercise them directly first, then run end-to-end EmbedDb tests
// with `quantization: "int8"` to verify the BLOB layout, the schema-mismatch
// rebuild on mode swap, recall@K parity vs Float32, and the brute-force
// + getAllVectors paths.
describe("EmbedDb int8 quantization", () => {
  describe("encodeInt8Vector / decodeInt8Vector", () => {
    it("roundtrips a typical L2-normalized vector within ~range/256 absolute error", () => {
      const original = l2([0.5, -0.25, 0.75, -0.125, 0.4, -0.4, 0.6, -0.6]);
      const buf = encodeInt8Vector(original);
      // Layout: dim bytes int8 + 4 bytes Float32 vMin + 4 bytes Float32 scale.
      expect(buf.byteLength).toBe(original.length + 8);
      const decoded = decodeInt8Vector(buf, original.length);
      expect(decoded.length).toBe(original.length);
      // Per-element error is bounded by `scale = range/255`. For an L2-normed
      // 8-dim vector, range is ~1.4, so absolute error ≤ ~0.0055. Use a
      // generous 0.01 tolerance — we care about ordering/recall, not bits.
      for (let i = 0; i < original.length; i++) {
        expect(Math.abs((decoded[i] ?? 0) - (original[i] ?? 0))).toBeLessThan(0.01);
      }
    });

    it("handles the all-zero vector without div-by-zero (range collapses to 0)", () => {
      const zero = new Float32Array([0, 0, 0, 0]);
      const buf = encodeInt8Vector(zero);
      expect(buf.byteLength).toBe(4 + 8);
      const decoded = decodeInt8Vector(buf, 4);
      // vMin=0, scale=1 (forced), q=0 → decode = 0. Bit-exact.
      for (let i = 0; i < 4; i++) expect(decoded[i]).toBe(0);
    });

    it("clamps int8 values into [0, 255] at the boundary", () => {
      const v = new Float32Array([0.0, 1.0, 0.5, 1.0]); // includes dup max
      const buf = encodeInt8Vector(v);
      // First byte (vMin=0) must be 0; second (vMax=1) must be 255.
      expect(buf[0]).toBe(0);
      expect(buf[1]).toBe(255);
      // Mid value should be ~127 (linear interpolation).
      expect(Math.abs((buf[2] ?? 0) - 127)).toBeLessThanOrEqual(1);
      // Dup-max also lands at 255.
      expect(buf[3]).toBe(255);
    });

    it("decode rejects buffers with unexpected byte length", () => {
      // dim=4 expects 4+8=12 bytes; a 10-byte buffer must throw.
      expect(() => decodeInt8Vector(Buffer.alloc(10), 4)).toThrow(/expected 12B/);
    });

    it("preserves cosine ranking on a synthetic top-K query", () => {
      // Three orthogonal-ish vectors. Quantize, dequantize, then recompute
      // cosine vs the same query. Ordering must match the Float32 baseline.
      const docs = [l2([1, 0, 0, 0]), l2([0.95, 0.05, 0, 0.1]), l2([0, 1, 0, 0])];
      const query = l2([1, 0, 0, 0]);
      const f32Scores = docs.map((d) => {
        let s = 0;
        for (let i = 0; i < d.length; i++) s += (query[i] ?? 0) * (d[i] ?? 0);
        return s;
      });
      const int8Scores = docs.map((d) => {
        const q = decodeInt8Vector(encodeInt8Vector(d), d.length);
        let s = 0;
        for (let i = 0; i < q.length; i++) s += (query[i] ?? 0) * (q[i] ?? 0);
        return s;
      });
      // Order must be preserved: doc 0 > doc 1 > doc 2.
      const f32Order = [...f32Scores.keys()].sort((a, b) => (f32Scores[b] ?? 0) - (f32Scores[a] ?? 0));
      const int8Order = [...int8Scores.keys()].sort((a, b) => (int8Scores[b] ?? 0) - (int8Scores[a] ?? 0));
      expect(int8Order).toEqual(f32Order);
    });
  });

  it("opens with quantization='int8' and stores ~dim+8 bytes per vector", async () => {
    const file = path.join(dir, "int8.embed.db");
    const db = new EmbedDb({
      file,
      vaultRoot: "/v",
      modelAlias: "multilingual",
      dim: 4,
      quantization: "int8"
    });
    await db.open();
    try {
      db.upsertNote("a.md", 1000, [
        { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "hello", vector: l2([1, 0, 0, 0]) }
      ]);
      expect(db.totalChunks()).toBe(1);
      // Search returns the same row with a near-1.0 cosine score (small
      // quant error, but still ranks #1 against itself).
      const hits = db.search(l2([1, 0, 0, 0]), 1);
      expect(hits).toHaveLength(1);
      expect(hits[0]?.rel_path).toBe("a.md");
      expect(hits[0]?.score).toBeGreaterThan(0.99);
    } finally {
      db.close();
    }
  });

  it("rebuilds when the quantization mode changes (f32 ↔ int8)", async () => {
    const file = path.join(dir, "swap.embed.db");
    const f32 = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await f32.open();
    f32.upsertNote("a.md", 1000, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "x", vector: l2([1, 0, 0, 0]) }
    ]);
    expect(f32.totalChunks()).toBe(1);
    f32.close();

    // Reopen with int8 — meta-mismatch must drop the embeddings table.
    const int8 = new EmbedDb({
      file,
      vaultRoot: "/v",
      modelAlias: "multilingual",
      dim: 4,
      quantization: "int8"
    });
    await int8.open();
    expect(int8.totalChunks()).toBe(0);
    int8.close();

    // Swap back to f32 — same rebuild trigger.
    const f32again = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await f32again.open();
    expect(f32again.totalChunks()).toBe(0);
    f32again.close();
  });

  it("preserves data when reopening with the same int8 mode (idempotent)", async () => {
    const file = path.join(dir, "idem.embed.db");
    const db1 = new EmbedDb({
      file,
      vaultRoot: "/v",
      modelAlias: "multilingual",
      dim: 4,
      quantization: "int8"
    });
    await db1.open();
    db1.upsertNote("a.md", 1000, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "y", vector: l2([1, 0, 0, 0]) }
    ]);
    db1.close();

    const db2 = new EmbedDb({
      file,
      vaultRoot: "/v",
      modelAlias: "multilingual",
      dim: 4,
      quantization: "int8"
    });
    await db2.open();
    expect(db2.totalChunks()).toBe(1);
    db2.close();
  });

  it("ranks top-K identically to f32 on a 32-dim synthetic corpus (recall@5 = 100%)", async () => {
    // Generate 50 random unit vectors as the corpus, plus 5 query vectors
    // each closer to a known-relevant doc. Run search() in both f32 and
    // int8 modes; the top-5 result sets must overlap by ≥ 4/5 (typical
    // worst-case for asymmetric int8 quant).
    const dim = 32;
    const N = 50;
    // Deterministic random — Mulberry32 PRNG so the test is reproducible.
    let state = 0x9e3779b9;
    const rng = () => {
      state = (state + 0x6d2b79f5) | 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const corpus: Float32Array[] = [];
    for (let i = 0; i < N; i++) {
      const arr: number[] = [];
      for (let d = 0; d < dim; d++) arr.push(rng() * 2 - 1);
      corpus.push(l2(arr));
    }

    const f32File = path.join(dir, "rcl-f32.embed.db");
    const i8File = path.join(dir, "rcl-i8.embed.db");
    const f32Db = new EmbedDb({ file: f32File, vaultRoot: "/v", modelAlias: "m", dim });
    const i8Db = new EmbedDb({
      file: i8File,
      vaultRoot: "/v",
      modelAlias: "m",
      dim,
      quantization: "int8"
    });
    await f32Db.open();
    await i8Db.open();
    try {
      const chunks = corpus.map((v, i) => ({
        chunkIndex: i,
        lineStart: i + 1,
        lineEnd: i + 1,
        textPreview: `c${i}`,
        vector: v
      }));
      f32Db.upsertNote("corpus.md", 1, chunks);
      i8Db.upsertNote("corpus.md", 1, chunks);

      // Aggregate recall@5 across 5 queries; expect ≥ 90% overlap on average.
      let overlapTotal = 0;
      const k = 5;
      const Q = 5;
      for (let q = 0; q < Q; q++) {
        const qarr: number[] = [];
        for (let d = 0; d < dim; d++) qarr.push(rng() * 2 - 1);
        const query = l2(qarr);
        const f32Hits = new Set(f32Db.search(query, k).map((h) => h.chunk_index));
        const i8Hits = i8Db.search(query, k).map((h) => h.chunk_index);
        const overlap = i8Hits.filter((c) => f32Hits.has(c)).length;
        overlapTotal += overlap;
      }
      // Total possible overlap = Q * k = 25. 90% → 22.5 → require ≥ 22.
      expect(overlapTotal).toBeGreaterThanOrEqual(22);
    } finally {
      f32Db.close();
      i8Db.close();
    }
  });

  it("getAllVectors returns dequantized Float32 in int8 mode", async () => {
    const file = path.join(dir, "gav.embed.db");
    const db = new EmbedDb({
      file,
      vaultRoot: "/v",
      modelAlias: "multilingual",
      dim: 4,
      quantization: "int8"
    });
    await db.open();
    try {
      const v = l2([0.7, 0.1, -0.3, 0.5]);
      db.upsertNote("a.md", 1, [{ chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "z", vector: v }]);
      const all = db.getAllVectors();
      expect(all).toHaveLength(1);
      const got = all[0]?.vector;
      expect(got).toBeInstanceOf(Float32Array);
      expect(got?.length).toBe(4);
      // Dequant is lossy — match within scale-bounded tolerance.
      for (let i = 0; i < 4; i++) {
        expect(Math.abs((got?.[i] ?? 0) - (v[i] ?? 0))).toBeLessThan(0.01);
      }
    } finally {
      db.close();
    }
  });

  it("computeSignature DIFFERS across quantization modes (v3.7.6 M-10 fix — was: ignored encoding)", async () => {
    // v3.7.6 M-10 (external audit) — pre-fix the HNSW staleness signature
    // was `dim;rows;maxId;model`, NOT including quantization. If the user
    // re-built embed-db with `--quantize-embeddings int8` (vs the previous
    // `f32`) and rowcount/maxId/dim/model stayed the same, the persisted
    // HNSW sidecar was considered "fresh" — but its float32 vectors no
    // longer matched the int8 bytes in the new embed-db rows. v3.7.6 adds
    // `quant=` to the signature, so quantization swaps now force HNSW
    // rebuild correctly.
    //
    // This test FLIPS the pre-v3.7.6 assertion: two indexes with identical
    // content but different encodings must now produce DIFFERENT signatures.
    const fileA = path.join(dir, "sig-a.embed.db");
    const fileB = path.join(dir, "sig-b.embed.db");
    const a = new EmbedDb({ file: fileA, vaultRoot: "/v", modelAlias: "m", dim: 4 });
    const b = new EmbedDb({
      file: fileB,
      vaultRoot: "/v",
      modelAlias: "m",
      dim: 4,
      quantization: "int8"
    });
    await a.open();
    await b.open();
    try {
      const v = l2([1, 0, 0, 0]);
      a.upsertNote("x.md", 1, [{ chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "x", vector: v }]);
      b.upsertNote("x.md", 1, [{ chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "x", vector: v }]);
      // Post-fix: signatures differ because `quant=f32` vs `quant=int8`.
      expect(a.computeSignature()).not.toBe(b.computeSignature());
      expect(a.computeSignature()).toMatch(/quant=f32/);
      expect(b.computeSignature()).toMatch(/quant=int8/);
    } finally {
      a.close();
      b.close();
    }
  });
});

// v3.9.0-rc.2 — return-value contract for upsertNote / deleteNote.
// The watcher's HNSW live-update path consumes oldIds + newIds to
// keep the in-memory graph in sync with embed-db. These tests pin
// the contract so a future refactor that loses the IDs breaks here
// rather than silently breaking watcher → HNSW sync.
describe("EmbedDb upsertNote + deleteNote return ids (v3.9.0-rc.2)", () => {
  it("upsertNote returns oldIds=[] + newIds for a fresh file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-db-"));
    const file = path.join(dir, "x.embed.db");
    const db = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "m", dim: 4 });
    await db.open();
    try {
      const v = l2([1, 0, 0, 0]);
      const r = db.upsertNote("a.md", 1000, [
        { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "first", vector: v },
        { chunkIndex: 1, lineStart: 2, lineEnd: 2, textPreview: "second", vector: v }
      ]);
      expect(r.oldIds).toEqual([]);
      expect(r.newIds).toHaveLength(2);
      // AUTOINCREMENT IDs are positive integers, monotonically increasing.
      expect(r.newIds[0]).toBeGreaterThan(0);
      expect(r.newIds[1]).toBeGreaterThan(r.newIds[0] ?? 0);
    } finally {
      db.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("upsertNote returns oldIds=existing + newIds=fresh on re-upsert", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-db-"));
    const file = path.join(dir, "x.embed.db");
    const db = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "m", dim: 4 });
    await db.open();
    try {
      const v = l2([1, 0, 0, 0]);
      // First upsert assigns ids 1, 2.
      const first = db.upsertNote("a.md", 1000, [
        { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "a0", vector: v },
        { chunkIndex: 1, lineStart: 2, lineEnd: 2, textPreview: "a1", vector: v }
      ]);
      // Second upsert: DELETE old (ids 1,2), INSERT new (ids 3,4,5).
      const second = db.upsertNote("a.md", 2000, [
        { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "b0", vector: v },
        { chunkIndex: 1, lineStart: 2, lineEnd: 2, textPreview: "b1", vector: v },
        { chunkIndex: 2, lineStart: 3, lineEnd: 3, textPreview: "b2", vector: v }
      ]);
      expect(second.oldIds).toEqual(first.newIds);
      expect(second.newIds).toHaveLength(3);
      // New ids must NOT overlap old ids — AUTOINCREMENT guarantees monotonic.
      for (const newId of second.newIds) {
        expect(second.oldIds.includes(newId)).toBe(false);
      }
    } finally {
      db.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("deleteNote returns the ids that were dropped", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-db-"));
    const file = path.join(dir, "x.embed.db");
    const db = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "m", dim: 4 });
    await db.open();
    try {
      const v = l2([1, 0, 0, 0]);
      const r = db.upsertNote("a.md", 1000, [
        { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "first", vector: v },
        { chunkIndex: 1, lineStart: 2, lineEnd: 2, textPreview: "second", vector: v }
      ]);
      const deletedIds = db.deleteNote("a.md");
      expect(deletedIds).toEqual(r.newIds);
    } finally {
      db.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  // NEGATIVE control: deleteNote on a file with no embed-db rows returns [].
  it("(NEGATIVE control) — deleteNote on absent file returns empty array", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-db-"));
    const file = path.join(dir, "x.embed.db");
    const db = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "m", dim: 4 });
    await db.open();
    try {
      const deletedIds = db.deleteNote("ghost.md");
      expect(deletedIds).toEqual([]);
    } finally {
      db.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("peekEmbedDbMeta is truly safe — never throws (v3.10.0-rc.34, RCA sibling of peekFtsMetaSafe)", () => {
  // Pass trivially when better-sqlite3 is absent (the peek returns null at the
  // dep-load catch before reaching `new Database`); when present (CI + dev) the
  // directory/corrupt cases exercise the rc.34 fix — pre-fix `new Database()`
  // threw out of the peek and errored the embeddings_search hot path / crashed
  // CLI subcommands that call it unguarded.
  it("returns null for a non-existent file", async () => {
    expect(await peekEmbedDbMeta(path.join(os.tmpdir(), `enquire-nope-${Date.now()}.embed.db`))).toBeNull();
  });

  it("returns null (not throw) when the path is a DIRECTORY", async () => {
    const d = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-embed-dir-"));
    try {
      expect(await peekEmbedDbMeta(d)).toBeNull();
    } finally {
      await fs.rm(d, { recursive: true, force: true });
    }
  });

  it("returns null (not throw) for a corrupt / non-SQLite file", async () => {
    const d = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-embed-corrupt-"));
    const f = path.join(d, "bad.embed.db");
    await fs.writeFile(f, "this is not a sqlite database");
    try {
      expect(await peekEmbedDbMeta(f)).toBeNull();
    } finally {
      await fs.rm(d, { recursive: true, force: true });
    }
  });
});
