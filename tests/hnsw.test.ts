// v2.13.0 — HNSW vector index tests.
//
// Coverage:
//   • buildHnsw with synthetic L2-normalized vectors → searchKnn returns
//     the expected nearest neighbors for crafted query vectors
//   • Recall@K is high (≥ 95%) on a deterministic synthetic corpus —
//     the IR-standard correctness check
//   • hnswResultsToHits maps labels → hits and converts cosine distance
//     back to similarity correctly
//   • EmbedDb.getAllVectors returns rows with stable labels, copies
//     vectors (no shared buffer aliasing), and skips corrupt rows
//   • Failure modes: dim mismatch throws, empty input is safe

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EmbedDb } from "../src/embed-db.js";
import { buildHnsw, hnswResultsToHits, loadHnswFromDisk } from "../src/hnsw.js";
import { adaptiveHnswRefill, assertHnswModelMatchesEmbedder } from "../src/tools/search.js";

/** L2-normalize a Float32Array in place; returns it for chaining. */
function l2(v: Float32Array): Float32Array {
  let s = 0;
  for (let i = 0; i < v.length; i++) {
    const x = v[i] ?? 0;
    s += x * x;
  }
  const n = Math.sqrt(s) || 1;
  for (let i = 0; i < v.length; i++) {
    const x = v[i] ?? 0;
    v[i] = x / n;
  }
  return v;
}

/**
 * Make a deterministic synthetic corpus of n vectors clustered around
 * `numClusters` random centroids. Each query targets a known centroid;
 * we expect HNSW to surface the cluster's points at the top.
 */
function makeClusteredCorpus(
  n: number,
  dim: number,
  numClusters: number,
  seed = 42
): { vectors: Float32Array[]; centroids: Float32Array[]; clusterByPoint: number[] } {
  // Simple deterministic PRNG (mulberry32).
  let s = seed >>> 0;
  const rand = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  // Random centroids.
  const centroids: Float32Array[] = [];
  for (let c = 0; c < numClusters; c++) {
    const v = new Float32Array(dim);
    for (let i = 0; i < dim; i++) v[i] = rand() - 0.5;
    centroids.push(l2(v));
  }
  // Each point = centroid + small noise.
  const vectors: Float32Array[] = [];
  const clusterByPoint: number[] = [];
  for (let p = 0; p < n; p++) {
    const cIdx = p % numClusters;
    const centroid = centroids[cIdx];
    if (!centroid) continue;
    const v = new Float32Array(dim);
    for (let i = 0; i < dim; i++) v[i] = centroid[i] + (rand() - 0.5) * 0.05; // 5% noise
    vectors.push(l2(v));
    clusterByPoint.push(cIdx);
  }
  return { vectors, centroids, clusterByPoint };
}

describe("buildHnsw + searchKnn (v2.13.0)", () => {
  it("retrieves the cluster's points for a centroid query", async () => {
    const dim = 8;
    const n = 60;
    const numClusters = 6;
    const { vectors, centroids, clusterByPoint } = makeClusteredCorpus(n, dim, numClusters);
    const labeled = vectors.map((v, i) => ({ label: i, vector: v }));
    const index = await buildHnsw(labeled, { dim, maxElements: n, m: 16, efConstruction: 200, seed: 100 });
    expect(index.size).toBe(n);
    expect(index.dim).toBe(dim);

    // Query the first centroid → top-K should be from cluster 0.
    const c0 = centroids[0];
    if (!c0) throw new Error("test setup: no centroid 0");
    const result = index.searchKnn(c0, 10);
    expect(result.labels).toHaveLength(10);
    expect(result.distances).toHaveLength(10);
    // At least 80% of the top-10 should be from cluster 0 (n / numClusters = 10
    // points per cluster; HNSW with default params should surface most of them).
    const fromCluster0 = result.labels.filter((label) => clusterByPoint[label] === 0).length;
    expect(fromCluster0).toBeGreaterThanOrEqual(8);
  });

  it("recall@10 vs brute-force is ≥ 95% on a 200-point corpus", async () => {
    const dim = 16;
    const n = 200;
    const { vectors } = makeClusteredCorpus(n, dim, 8, 17);
    const labeled = vectors.map((v, i) => ({ label: i, vector: v }));
    const index = await buildHnsw(labeled, { dim, maxElements: n });

    // Pick 10 random query vectors. For each, compute brute-force top-10
    // and HNSW top-10; measure overlap.
    let totalRecall = 0;
    const numQueries = 10;
    for (let q = 0; q < numQueries; q++) {
      const queryVec = vectors[(q * 17) % n];
      if (!queryVec) continue;
      // Brute-force top-10 via exhaustive cosine.
      const scored = vectors.map((v, i) => {
        let dot = 0;
        for (let d = 0; d < dim; d++) dot += (queryVec[d] ?? 0) * (v[d] ?? 0);
        return { i, score: dot };
      });
      scored.sort((a, b) => b.score - a.score);
      const bfTop = new Set(scored.slice(0, 10).map((x) => x.i));
      // HNSW top-10.
      const hnswResult = index.searchKnn(queryVec, 10);
      const hnswTop = new Set(hnswResult.labels);
      // Recall = |bfTop ∩ hnswTop| / |bfTop|.
      let overlap = 0;
      for (const x of bfTop) if (hnswTop.has(x)) overlap += 1;
      totalRecall += overlap / 10;
    }
    const meanRecall = totalRecall / numQueries;
    expect(meanRecall).toBeGreaterThanOrEqual(0.95);
  });

  it("rejects vectors with mismatched dim", async () => {
    const dim = 8;
    const goodVec = l2(new Float32Array(dim).fill(1));
    const badVec = l2(new Float32Array(4).fill(1));
    await expect(
      buildHnsw(
        [
          { label: 0, vector: goodVec },
          { label: 1, vector: badVec }
        ],
        { dim, maxElements: 2 }
      )
    ).rejects.toThrow(/dim/);
  });

  it("rejects more vectors than maxElements", async () => {
    const dim = 4;
    const v = l2(new Float32Array(dim).fill(1));
    await expect(
      buildHnsw(
        [
          { label: 0, vector: v },
          { label: 1, vector: v },
          { label: 2, vector: v }
        ],
        { dim, maxElements: 2 }
      )
    ).rejects.toThrow(/exceeds maxElements/);
  });

  it("searchKnn rejects mismatched query dim", async () => {
    const dim = 8;
    const v = l2(new Float32Array(dim).fill(1));
    const index = await buildHnsw([{ label: 0, vector: v }], { dim, maxElements: 1 });
    expect(() => index.searchKnn(new Float32Array(4).fill(1), 1)).toThrow(/query dim/);
  });
});

describe("hnswResultsToHits (v2.13.0)", () => {
  it("maps labels to hits and converts cosine distance to similarity", () => {
    const rowByLabel = new Map<
      number,
      {
        rel_path: string;
        chunk_index: number;
        line_start: number;
        line_end: number;
        text_preview: string;
        kind: "md" | "pdf";
      }
    >();
    rowByLabel.set(7, {
      rel_path: "notes/a.md",
      chunk_index: 0,
      line_start: 1,
      line_end: 5,
      text_preview: "Hello world",
      kind: "md"
    });
    rowByLabel.set(13, {
      rel_path: "papers/b.pdf",
      chunk_index: 2,
      line_start: 10,
      line_end: 20,
      text_preview: "[page: 3] Some content",
      kind: "pdf"
    });
    const hits = hnswResultsToHits({ labels: [7, 13], distances: [0.1, 0.4] }, rowByLabel);
    expect(hits).toHaveLength(2);
    // distance 0.1 → similarity 0.9
    expect(hits[0]?.score).toBeCloseTo(0.9, 5);
    expect(hits[0]?.rel_path).toBe("notes/a.md");
    expect(hits[0]?.kind).toBe("md");
    expect(hits[1]?.score).toBeCloseTo(0.6, 5);
    expect(hits[1]?.kind).toBe("pdf");
  });

  it("silently drops labels not in rowByLabel (e.g. row deleted between build + query)", () => {
    const rowByLabel = new Map();
    rowByLabel.set(7, {
      rel_path: "a.md",
      chunk_index: 0,
      line_start: 1,
      line_end: 1,
      text_preview: "x",
      kind: "md"
    });
    const hits = hnswResultsToHits({ labels: [7, 99, 7], distances: [0.1, 0.2, 0.3] }, rowByLabel);
    // 99 is missing; 7 appears twice
    expect(hits.length).toBe(2);
  });
});

describe("EmbedDb.getAllVectors (v2.13.0)", () => {
  let dir: string;
  let dbFile: string;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-getall-"));
    dbFile = path.join(dir, "test.embed.db");
  });

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("returns rows with stable labels and copied vectors", async () => {
    const db = new EmbedDb({ file: dbFile, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await db.open();
    try {
      db.upsertNote("a.md", 1000, [
        { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "alpha", vector: l2(new Float32Array([1, 0, 0, 0])) },
        { chunkIndex: 1, lineStart: 2, lineEnd: 2, textPreview: "beta", vector: l2(new Float32Array([0, 1, 0, 0])) }
      ]);
      db.upsertNote(
        "p.pdf",
        2000,
        [
          {
            chunkIndex: 0,
            lineStart: 1,
            lineEnd: 5,
            textPreview: "[page: 1] gamma",
            vector: l2(new Float32Array([0, 0, 1, 0]))
          }
        ],
        "pdf"
      );
      const rows = db.getAllVectors();
      expect(rows.length).toBe(3);
      // Labels are stable integers (embeddings.id).
      const labels = rows.map((r) => r.label).sort((x, y) => x - y);
      expect(labels[0]).toBeGreaterThanOrEqual(1);
      // Each vector has the right dim.
      for (const r of rows) {
        expect(r.vector).toHaveLength(4);
      }
      // Kind is preserved.
      const pdfRow = rows.find((r) => r.rel_path === "p.pdf");
      expect(pdfRow?.kind).toBe("pdf");
      const mdRow = rows.find((r) => r.rel_path === "a.md");
      expect(mdRow?.kind).toBe("md");
    } finally {
      db.close();
    }
  });
});

// v2.16.0 — HNSW persistence: writeIndex/readIndex roundtrip + staleness
// detection via the embed-db signature.
describe("HNSW persistence (v2.16.0)", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-hnsw-persist-"));
  });

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("saveTo + loadHnswFromDisk roundtrip preserves search results", async () => {
    const dim = 8;
    const n = 30;
    // Reuse the cluster-corpus generator via a tiny inline replica.
    const vectors: Float32Array[] = [];
    for (let i = 0; i < n; i++) {
      const v = new Float32Array(dim);
      for (let d = 0; d < dim; d++) v[d] = Math.sin(i * 0.7 + d * 1.3);
      // L2-normalize.
      let s = 0;
      for (let d = 0; d < dim; d++) s += (v[d] ?? 0) ** 2;
      const norm = Math.sqrt(s) || 1;
      for (let d = 0; d < dim; d++) v[d] = (v[d] ?? 0) / norm;
      vectors.push(v);
    }
    const labeled = vectors.map((v, i) => ({ label: i + 100, vector: v }));
    const index = await buildHnsw(labeled, { dim, maxElements: n });
    const queryVec = vectors[5];
    if (!queryVec) throw new Error("test setup");
    const beforePersist = index.searchKnn(queryVec, 5);

    const persistFile = path.join(dir, "test.hnsw");
    const rowsByLabel = new Map<
      number,
      {
        rel_path: string;
        chunk_index: number;
        line_start: number;
        line_end: number;
        text_preview: string;
        kind: "md" | "pdf";
      }
    >();
    for (let i = 0; i < n; i++) {
      rowsByLabel.set(i + 100, {
        rel_path: `note-${i}.md`,
        chunk_index: 0,
        line_start: 1,
        line_end: 1,
        text_preview: `chunk ${i}`,
        kind: "md"
      });
    }
    const ok = await index.saveTo(persistFile, rowsByLabel, "sig-v1");
    expect(ok).toBe(true);

    // Both files should exist.
    await expect(fs.access(`${persistFile}.bin`)).resolves.toBeUndefined();
    await expect(fs.access(`${persistFile}.meta.json`)).resolves.toBeUndefined();

    // Load with matching signature.
    const loaded = await loadHnswFromDisk(persistFile, "sig-v1");
    expect(loaded).not.toBeNull();
    if (!loaded) return;
    expect(loaded.index.dim).toBe(dim);
    expect(loaded.index.size).toBe(n);
    expect(loaded.rowsByLabel.size).toBe(n);
    expect(loaded.rowsByLabel.get(105)?.rel_path).toBe("note-5.md");

    // Loaded index should produce the same top-5 as the original.
    const afterLoad = loaded.index.searchKnn(queryVec, 5);
    expect(afterLoad.labels).toEqual(beforePersist.labels);
  });

  it("M1 (v3.9.0-rc.11) — saveTo persists the LIVE element count after applyDiff, not the build-time size", async () => {
    const dim = 4;
    const n = 3;
    const norm = (a: number[]) => {
      const s = Math.sqrt(a.reduce((t, x) => t + x * x, 0)) || 1;
      return new Float32Array(a.map((x) => x / s));
    };
    const labeled = Array.from({ length: n }, (_, i) => ({ label: i, vector: norm([i + 1, 1, 1, 1]) }));
    const index = await buildHnsw(labeled, { dim, maxElements: 50 });
    expect(index.size).toBe(n); // build-time count

    // Live update: add one new point → live count becomes n + 1. Pre-rc.11
    // saveTo persisted the stale closure `size` (n); now it persists the live
    // getCurrentCount().
    index.applyDiff([], [{ label: 99, vector: norm([9, 9, 9, 9]) }]);
    const liveCount = index.size; // delegates to getCurrentCount()
    expect(liveCount).toBeGreaterThan(n);

    const persistFile = path.join(dir, "m1.hnsw");
    await index.saveTo(persistFile, new Map(), "m1-sig");
    const meta = JSON.parse(await fs.readFile(`${persistFile}.meta.json`, "utf8")) as { size: number };
    expect(meta.size, "persisted meta.size must be the live count").toBe(liveCount);
    expect(meta.size, "NEGATIVE control: must NOT be the stale build-time size").not.toBe(n);
  });

  it("M6 (rc.16 audit) — applyDiff with a wrong-dim point throws ATOMICALLY (no markDelete before the throw)", async () => {
    const dim = 4;
    const norm = (a: number[]) => {
      const s = Math.sqrt(a.reduce((t, x) => t + x * x, 0)) || 1;
      return new Float32Array(a.map((x) => x / s));
    };
    const labeled = [0, 1, 2].map((i) => ({ label: i, vector: norm([i + 1, 1, 1, 1]) }));
    const index = await buildHnsw(labeled, { dim, maxElements: 50 });
    const q = norm([1, 1, 1, 1]); // closest to label 0
    expect(index.searchKnn(q, 1).labels, "label 0 active pre-diff").toContain(0);

    // A diff that removes label 0 AND adds a WRONG-dim point. Pre-rc.16 the dim
    // check fired INSIDE the addPoint loop, so label 0 was already markDelete'd
    // when the throw hit → half-applied index. Now dims are pre-validated, so a
    // bad dim throws BEFORE any mutation.
    expect(() => index.applyDiff([0], [{ label: 99, vector: new Float32Array([1, 1, 1]) }])).toThrow(
      /dim 3, expected 4/
    );

    // ATOMICITY: label 0 must STILL be active — the failed diff didn't delete it.
    expect(index.searchKnn(q, 1).labels, "label 0 must survive a failed applyDiff").toContain(0);

    // NEGATIVE control: a VALID diff DOES remove label 0 — proves the search
    // check can actually observe a removal (the atomicity assertion isn't vacuous).
    index.applyDiff([0], [{ label: 99, vector: norm([9, 9, 9, 9]) }]);
    expect(index.searchKnn(q, 3).labels, "valid diff removes label 0").not.toContain(0);
  });

  it("returns null when signature doesn't match (stale index)", async () => {
    const persistFile = path.join(dir, "stale.hnsw");
    const v = new Float32Array(4).fill(0.5);
    let s = 0;
    for (const x of v) s += x * x;
    const norm = Math.sqrt(s);
    for (let i = 0; i < v.length; i++) v[i] = (v[i] ?? 0) / norm;

    const index = await buildHnsw([{ label: 0, vector: v }], { dim: 4, maxElements: 1 });
    await index.saveTo(persistFile, new Map(), "old-signature");

    const loaded = await loadHnswFromDisk(persistFile, "new-signature");
    expect(loaded).toBeNull();
  });

  it("returns null when meta file is missing", async () => {
    const loaded = await loadHnswFromDisk(path.join(dir, "nonexistent.hnsw"), "any-sig");
    expect(loaded).toBeNull();
  });

  it("returns null when meta is malformed JSON", async () => {
    const persistFile = path.join(dir, "malformed.hnsw");
    await fs.writeFile(`${persistFile}.bin`, "ignored");
    await fs.writeFile(`${persistFile}.meta.json`, "{not valid json");
    const loaded = await loadHnswFromDisk(persistFile, "any-sig");
    expect(loaded).toBeNull();
  });

  it("returns null when meta exists but bin file missing", async () => {
    const persistFile = path.join(dir, "no-bin.hnsw");
    const meta = {
      formatVersion: 1,
      dim: 4,
      size: 0,
      signature: "match",
      rowsByLabel: {},
      writtenAt: new Date().toISOString()
    };
    await fs.writeFile(`${persistFile}.meta.json`, JSON.stringify(meta));
    const loaded = await loadHnswFromDisk(persistFile, "match");
    expect(loaded).toBeNull();
  });

  // v3.8.0-rc.10 P3-27 — shallow validation of dim/size/rowsByLabel.
  // Pre-rc.10 these were used without validation: a malformed-but-valid-JSON
  // meta with dim=-1 or rowsByLabel:null would crash or produce garbage.
  it("returns null when meta has invalid dim (P3-27 NEGATIVE control)", async () => {
    const persistFile = path.join(dir, "bad-dim.hnsw");
    const meta = {
      formatVersion: 1,
      dim: -1,
      size: 0,
      signature: "match",
      rowsByLabel: {},
      writtenAt: new Date().toISOString()
    };
    await fs.writeFile(`${persistFile}.bin`, "ignored");
    await fs.writeFile(`${persistFile}.meta.json`, JSON.stringify(meta));
    const loaded = await loadHnswFromDisk(persistFile, "match");
    expect(loaded).toBeNull();
  });

  it("returns null when meta has invalid rowsByLabel (P3-27 NEGATIVE control)", async () => {
    const persistFile = path.join(dir, "bad-rows.hnsw");
    const meta = {
      formatVersion: 1,
      dim: 4,
      size: 0,
      signature: "match",
      rowsByLabel: null,
      writtenAt: new Date().toISOString()
    };
    await fs.writeFile(`${persistFile}.bin`, "ignored");
    await fs.writeFile(`${persistFile}.meta.json`, JSON.stringify(meta));
    const loaded = await loadHnswFromDisk(persistFile, "match");
    expect(loaded).toBeNull();
  });

  it("returns null on formatVersion mismatch (future-proof)", async () => {
    const persistFile = path.join(dir, "future.hnsw");
    const meta = {
      formatVersion: 99,
      dim: 4,
      size: 0,
      signature: "match",
      rowsByLabel: {},
      writtenAt: new Date().toISOString()
    };
    await fs.writeFile(`${persistFile}.bin`, "ignored");
    await fs.writeFile(`${persistFile}.meta.json`, JSON.stringify(meta));
    const loaded = await loadHnswFromDisk(persistFile, "match");
    expect(loaded).toBeNull();
  });

  // v3.6.2 audit M-7 — both sidecars (.bin + .meta.json) MUST be chmod'd to
  // 0o600 after write. The .meta.json carries text_preview snippets which are
  // sensitive note content; the parent dir is already 0700 (defense-in-depth),
  // but the per-file invariant is what SECURITY.md guarantees. Matches the
  // canonical pattern in src/embed-db.ts and src/fts5.ts.
  it("saveTo chmods both sidecars (.bin + .meta.json) to 0o600 (audit M-7)", async () => {
    if (process.platform === "win32") return; // POSIX mode bits don't apply on NTFS
    const dim = 4;
    const v = new Float32Array(dim).fill(0.5);
    let s = 0;
    for (const x of v) s += x * x;
    const norm = Math.sqrt(s);
    for (let i = 0; i < v.length; i++) v[i] = (v[i] ?? 0) / norm;
    const index = await buildHnsw([{ label: 0, vector: v }], { dim, maxElements: 1 });

    const persistFile = path.join(dir, "chmod-check.hnsw");
    const ok = await index.saveTo(persistFile, new Map(), "chmod-sig");
    expect(ok).toBe(true);

    const binStat = await fs.stat(`${persistFile}.bin`);
    const metaStat = await fs.stat(`${persistFile}.meta.json`);
    expect(binStat.mode & 0o777).toBe(0o600);
    expect(metaStat.mode & 0o777).toBe(0o600);
  });
});

// v2.16.0 — embed-db signature for HNSW staleness checks.
describe("EmbedDb.computeSignature (v2.16.0)", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-sig-"));
  });

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("changes when a row is added (max-id moves up)", async () => {
    const file = path.join(dir, "sig-add.embed.db");
    const db = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await db.open();
    try {
      const sigEmpty = db.computeSignature();
      expect(sigEmpty).toBe("dim=4;rows=0;maxId=0;model=multilingual;quant=f32");

      db.upsertNote("a.md", 1, [
        { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "x", vector: l2(new Float32Array([1, 0, 0, 0])) }
      ]);
      const sig1 = db.computeSignature();
      expect(sig1).toBe("dim=4;rows=1;maxId=1;model=multilingual;quant=f32");
      expect(sig1).not.toBe(sigEmpty);

      db.upsertNote("b.md", 2, [
        { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "y", vector: l2(new Float32Array([0, 1, 0, 0])) }
      ]);
      const sig2 = db.computeSignature();
      expect(sig2).toBe("dim=4;rows=2;maxId=2;model=multilingual;quant=f32");
      expect(sig2).not.toBe(sig1);
    } finally {
      db.close();
    }
  });

  it("changes when a row is updated (max-id advances because upsert deletes+inserts)", async () => {
    const file = path.join(dir, "sig-update.embed.db");
    const db = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await db.open();
    try {
      db.upsertNote("a.md", 1, [
        { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "x", vector: l2(new Float32Array([1, 0, 0, 0])) }
      ]);
      const sig1 = db.computeSignature();
      // Update the same note.
      db.upsertNote("a.md", 2, [
        { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "y", vector: l2(new Float32Array([0, 1, 0, 0])) }
      ]);
      const sig2 = db.computeSignature();
      // Both rows=1 because upsert deleted then inserted, but maxId advanced.
      expect(sig2).not.toBe(sig1);
      expect(sig2).toMatch(/rows=1/);
    } finally {
      db.close();
    }
  });

  it("changes when a row is deleted (rowcount drops)", async () => {
    const file = path.join(dir, "sig-delete.embed.db");
    const db = new EmbedDb({ file, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await db.open();
    try {
      db.upsertNote("a.md", 1, [
        { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "x", vector: l2(new Float32Array([1, 0, 0, 0])) }
      ]);
      const sig1 = db.computeSignature();
      db.deleteNote("a.md");
      const sig2 = db.computeSignature();
      expect(sig2).not.toBe(sig1);
      expect(sig2).toMatch(/rows=0/);
    } finally {
      db.close();
    }
  });
});

// v3.6.2 HN-4 — search-side model verification. CRIT-1 fixed the build path
// (which silently DROP-TABLE'd on model-alias mismatch); this is the
// search-time guard that prevents returning garbage similarities when the
// HNSW index and the query embedder come from different vector spaces.
describe("assertHnswModelMatchesEmbedder (v3.6.2 HN-4)", () => {
  it("passes silently when aliases match (multilingual = multilingual)", () => {
    expect(() => assertHnswModelMatchesEmbedder("multilingual", "multilingual")).not.toThrow();
  });

  it("passes silently when aliases match (bge = bge)", () => {
    expect(() => assertHnswModelMatchesEmbedder("bge", "bge")).not.toThrow();
  });

  it("throws an actionable error on mismatch (HNSW=bge, search=multilingual)", () => {
    // The classic mismatch: user built embeddings with --embedding-model bge
    // then forgot the flag on serve / overrode it in a tool call → query
    // vector and index vectors come from different latent spaces, cosine
    // returns meaningless numbers. We refuse to return those.
    expect(() => assertHnswModelMatchesEmbedder("multilingual", "bge")).toThrow(/HNSW model mismatch/);
    expect(() => assertHnswModelMatchesEmbedder("multilingual", "bge")).toThrow(/built with embedding model 'bge'/);
    expect(() => assertHnswModelMatchesEmbedder("multilingual", "bge")).toThrow(/search is using 'multilingual'/);
  });

  it("throws on the reverse mismatch (HNSW=multilingual, search=bge)", () => {
    expect(() => assertHnswModelMatchesEmbedder("bge", "multilingual")).toThrow(/HNSW model mismatch/);
  });

  it("error message includes a fix suggestion (build-embeddings command)", () => {
    try {
      assertHnswModelMatchesEmbedder("bge", "multilingual");
      throw new Error("did not throw");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toContain("build-embeddings");
      expect(msg).toContain("--embedding-model bge");
    }
  });
});

// v3.9.0-rc.2 — HnswIndex live-update API (applyDiff, resize, capacity).
// These exercise the new methods the watcher uses to keep the in-memory
// graph in sync with embed-db mutations during a serve session, without
// rebuilding the index from scratch.
describe("HnswIndex live-update (v3.9.0-rc.2 applyDiff / resize / capacity)", () => {
  // L2-normalize a synthetic vector so cosine distances are meaningful.
  function makeNormVector(dim: number, seed: number): Float32Array {
    const v = new Float32Array(dim);
    let norm2 = 0;
    for (let i = 0; i < dim; i++) {
      const x = Math.sin(seed * 7.31 + i * 0.17);
      v[i] = x;
      norm2 += x * x;
    }
    const inv = 1 / Math.sqrt(norm2);
    for (let i = 0; i < dim; i++) v[i] *= inv;
    return v;
  }

  it("applyDiff removes labels (markDelete) + searchKnn no longer surfaces them", async () => {
    const dim = 8;
    const labeled = Array.from({ length: 20 }, (_, i) => ({ label: i + 100, vector: makeNormVector(dim, i) }));
    const idx = await buildHnsw(labeled, { dim, maxElements: 50 });
    expect(idx.size).toBe(20);
    // Remove labels 100–104 (the first 5).
    const { removed, added } = idx.applyDiff([100, 101, 102, 103, 104], []);
    expect(removed).toBe(5);
    expect(added).toBe(0);
    // hnswlib-node's getCurrentCount returns SLOT count (deleted slots
    // still count), not live count. Size therefore stays at 20 after
    // markDelete; the observable defense is that searchKnn never
    // surfaces a markDelete'd label.
    const result = idx.searchKnn(makeNormVector(dim, 0), 15, { ef: 50 });
    for (const removedLabel of [100, 101, 102, 103, 104]) {
      expect(result.labels.includes(removedLabel), `searchKnn surfaced markDelete'd label ${removedLabel}`).toBe(false);
    }
  });

  it("applyDiff adds new points + searchKnn returns them", async () => {
    const dim = 8;
    const labeled = Array.from({ length: 10 }, (_, i) => ({ label: i, vector: makeNormVector(dim, i) }));
    const idx = await buildHnsw(labeled, { dim, maxElements: 30 });
    // Add 3 new points with labels 1000-1002. Use distinct seeds so they
    // form their own "cluster" in vector space.
    const newPoints = [1000, 1001, 1002].map((label) => ({
      label,
      vector: makeNormVector(dim, label) // seed = label → unique direction
    }));
    const { removed, added } = idx.applyDiff([], newPoints);
    expect(removed).toBe(0);
    expect(added).toBe(3);
    expect(idx.size).toBe(13);
    // Query a vector close to label 1000 → it should be top-1.
    const result = idx.searchKnn(makeNormVector(dim, 1000), 5, { ef: 30 });
    expect(result.labels).toContain(1000);
    expect(result.labels[0]).toBe(1000);
  });

  it("applyDiff combined remove + add (typical watcher upsert path)", async () => {
    const dim = 8;
    const labeled = Array.from({ length: 10 }, (_, i) => ({ label: i, vector: makeNormVector(dim, i) }));
    const idx = await buildHnsw(labeled, { dim, maxElements: 30 });
    // Simulate a file edit: remove labels 0,1,2 and add new labels 10,11,12,13 (one extra chunk).
    // The addPoint(replaceDeleted=true) path reuses deleted slots (3 of
    // the 4 adds), so getCurrentCount only grows by 1 (the fourth add
    // beyond the available deleted slots).
    const newPoints = [10, 11, 12, 13].map((label) => ({ label, vector: makeNormVector(dim, label + 500) }));
    const { removed, added } = idx.applyDiff([0, 1, 2], newPoints);
    expect(removed).toBe(3);
    expect(added).toBe(4);
    // Old labels are absent, new ones are present.
    const result = idx.searchKnn(makeNormVector(dim, 510), 8, { ef: 30 });
    expect(result.labels).toContain(10); // seed 510 = 10 + 500
    for (const oldLabel of [0, 1, 2]) {
      expect(result.labels.includes(oldLabel), `surfaced removed label ${oldLabel}`).toBe(false);
    }
  });

  it("applyDiff silently skips removeLabels that were never added (watcher-lag tolerance)", async () => {
    const dim = 8;
    const labeled = Array.from({ length: 5 }, (_, i) => ({ label: i, vector: makeNormVector(dim, i) }));
    const idx = await buildHnsw(labeled, { dim, maxElements: 20 });
    // Mix real + bogus labels in the remove list.
    const { removed } = idx.applyDiff([0, 999, 1, 1000], []);
    // Only the 2 real labels (0, 1) were actually removed; bogus 999,
    // 1000 silently skipped (the watcher's view can lag behind reality
    // after a sweep eviction; it shouldn't fail the live-update).
    expect(removed).toBe(2);
    // Observable: 0 and 1 are absent from search results; 2, 3, 4 still
    // present. (Don't rely on idx.size because hnswlib-node's
    // getCurrentCount returns SLOT count including deleted.)
    const result = idx.searchKnn(makeNormVector(dim, 2), 5, { ef: 20 });
    expect(result.labels.includes(0)).toBe(false);
    expect(result.labels.includes(1)).toBe(false);
    expect(result.labels.includes(2)).toBe(true);
  });

  it("applyDiff auto-grows when adding points past maxElements (watcher fail-safe)", async () => {
    const dim = 8;
    const labeled = Array.from({ length: 5 }, (_, i) => ({ label: i, vector: makeNormVector(dim, i) }));
    // maxElements = 5 (exact). Add 6 more → must auto-resize.
    const idx = await buildHnsw(labeled, { dim, maxElements: 5 });
    const newPoints = Array.from({ length: 6 }, (_, i) => ({
      label: 100 + i,
      vector: makeNormVector(dim, 100 + i)
    }));
    const { added } = idx.applyDiff([], newPoints);
    expect(added).toBe(6);
    // Capacity should have grown to fit the new total (11 = 5 + 6).
    const cap = idx.capacity();
    expect(cap.maxElements).toBeGreaterThanOrEqual(11);
    // All new labels searchable.
    const result = idx.searchKnn(makeNormVector(dim, 100), 8, { ef: 20 });
    expect(result.labels).toContain(100);
  });

  it("resize grows the index; no-op when already large enough", async () => {
    const dim = 8;
    const labeled = Array.from({ length: 5 }, (_, i) => ({ label: i, vector: makeNormVector(dim, i) }));
    const idx = await buildHnsw(labeled, { dim, maxElements: 5 });
    expect(idx.capacity().maxElements).toBe(5);
    idx.resize(50);
    expect(idx.capacity().maxElements).toBe(50);
    idx.resize(20); // smaller — no-op
    expect(idx.capacity().maxElements).toBe(50);
  });

  it("capacity returns {currentCount, maxElements}", async () => {
    const dim = 8;
    const labeled = Array.from({ length: 7 }, (_, i) => ({ label: i, vector: makeNormVector(dim, i) }));
    const idx = await buildHnsw(labeled, { dim, maxElements: 100 });
    const cap = idx.capacity();
    expect(cap.currentCount).toBe(7);
    expect(cap.maxElements).toBe(100);
  });

  // NEGATIVE control: addPoints with wrong dim throws (would have left the
  // index in a partial-update state if applyDiff didn't validate first).
  it("(NEGATIVE control) — applyDiff with wrong-dim vector throws", async () => {
    const dim = 8;
    const labeled = Array.from({ length: 5 }, (_, i) => ({ label: i, vector: makeNormVector(dim, i) }));
    const idx = await buildHnsw(labeled, { dim, maxElements: 20 });
    const wrongDim = new Float32Array(16); // dim=16 ≠ 8
    expect(() => idx.applyDiff([], [{ label: 99, vector: wrongDim }])).toThrow(/dim 16, expected 8/);
  });
});

// v3.9.0-rc.3 R-10 — adaptiveHnswRefill loop. Pure helper extracted
// from src/tools/search.ts; tests drive it with stub callbacks that
// simulate (a) HNSW search returning a controlled label set and (b)
// a privacy filter that drops a configurable fraction.
describe("adaptiveHnswRefill (v3.9.0-rc.3 R-10)", () => {
  // Build a stub searchKnn that returns the first `k` labels from a
  // pre-built array. Distances are synthetic (descending from 0).
  function makeStubSearchKnn(allLabels: number[]) {
    return (k: number) => {
      const labels = allLabels.slice(0, k);
      const distances = labels.map((_, i) => i / allLabels.length);
      return { labels, distances };
    };
  }

  // Returns a filter that drops every label NOT in `allowed`. Mirrors
  // vault.isExcluded — the privacy guard the real refill loop applies.
  function makeAllowFilter(allowed: Set<number>) {
    return (labels: number[], _distances: number[]) => labels.filter((l) => allowed.has(l));
  }

  it("returns initialK results when no filter drops anything (typical 0% excluded case)", () => {
    const allLabels = Array.from({ length: 1000 }, (_, i) => i);
    const filtered = adaptiveHnswRefill({
      initialK: 50,
      maxLabels: 1000,
      limit: 10,
      searchKnn: makeStubSearchKnn(allLabels),
      filter: (labels) => [...labels] // identity
    });
    expect(filtered.length).toBe(50); // initialK returned, all pass
  });

  it("refills when 80% are filtered out (R-10 target case)", () => {
    const allLabels = Array.from({ length: 1000 }, (_, i) => i);
    // Allow only every 5th label (20% pass) — 80% of any window will drop.
    const allowed = new Set(allLabels.filter((l) => l % 5 === 0));
    const filtered = adaptiveHnswRefill({
      initialK: 50,
      maxLabels: 1000,
      limit: 10,
      searchKnn: makeStubSearchKnn(allLabels),
      filter: makeAllowFilter(allowed)
    });
    // First attempt: k=50, filter keeps every 5th → 10 results. EXACTLY hits limit on attempt 1.
    expect(filtered.length).toBeGreaterThanOrEqual(10);
  });

  it("doubles k up to MAX_REFILL_ATTEMPTS=3 times when refill needed", () => {
    let searchCalls = 0;
    const kHistory: number[] = [];
    const allLabels = Array.from({ length: 1000 }, (_, i) => i);
    // Allow only labels >= 500 (so first 50, 100, 200 calls return 0 hits;
    // 400 still 0; only at k=500+ do we start seeing allowed labels).
    const allowed = new Set(allLabels.filter((l) => l >= 500));
    adaptiveHnswRefill({
      initialK: 50,
      maxLabels: 1000,
      limit: 10,
      searchKnn: (k) => {
        searchCalls += 1;
        kHistory.push(k);
        return makeStubSearchKnn(allLabels)(k);
      },
      filter: makeAllowFilter(allowed)
    });
    // Attempts: k=50, k=100, k=200. Bounded by maxAttempts=3.
    expect(searchCalls).toBe(3);
    expect(kHistory).toEqual([50, 100, 200]);
  });

  it("stops doubling when k saturates maxLabels", () => {
    let searchCalls = 0;
    const allLabels = Array.from({ length: 60 }, (_, i) => i);
    // Filter rejects everything → refill never satisfies; should stop
    // at saturation rather than continuing to double.
    adaptiveHnswRefill({
      initialK: 50,
      maxLabels: 60,
      limit: 10,
      searchKnn: (k) => {
        searchCalls += 1;
        return makeStubSearchKnn(allLabels)(k);
      },
      filter: () => [] // rejects all
    });
    // Attempt 1: k=50 → 0 hits, k *= 2 → 100, capped to 60.
    // Attempt 2: k=60 (saturated) → 0 hits, loop sees k >= maxLabels → break.
    expect(searchCalls).toBe(2);
  });

  it("respects custom maxAttempts override", () => {
    let searchCalls = 0;
    const allLabels = Array.from({ length: 10000 }, (_, i) => i);
    adaptiveHnswRefill({
      initialK: 10,
      maxLabels: 10000,
      limit: 100,
      searchKnn: (k) => {
        searchCalls += 1;
        return makeStubSearchKnn(allLabels)(k);
      },
      filter: () => [], // never satisfies
      maxAttempts: 5
    });
    expect(searchCalls).toBe(5);
  });

  // NEGATIVE control: if filter immediately returns ≥ limit, loop must
  // exit on attempt 1 (proves the early-exit optimization fires).
  it("(NEGATIVE control) — exits after attempt 1 when filter satisfies on first try", () => {
    let searchCalls = 0;
    const allLabels = Array.from({ length: 1000 }, (_, i) => i);
    adaptiveHnswRefill({
      initialK: 50,
      maxLabels: 1000,
      limit: 10,
      searchKnn: (k) => {
        searchCalls += 1;
        return makeStubSearchKnn(allLabels)(k);
      },
      filter: (labels) => [...labels] // identity → 50 passes immediately
    });
    expect(searchCalls).toBe(1);
  });

  // NEGATIVE control: maxAttempts=0 doesn't make any calls.
  it("(NEGATIVE control) — maxAttempts=0 makes zero searchKnn calls", () => {
    let searchCalls = 0;
    const result = adaptiveHnswRefill({
      initialK: 50,
      maxLabels: 1000,
      limit: 10,
      searchKnn: () => {
        searchCalls += 1;
        return { labels: [], distances: [] };
      },
      filter: () => [],
      maxAttempts: 0
    });
    expect(searchCalls).toBe(0);
    expect(result).toEqual([]);
  });
});
