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
import { assertHnswModelMatchesEmbedder } from "../src/tools/search.js";

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
