// v2.13.0 — HNSW vector index tests.
//
// Coverage:
//   • buildHnsw with synthetic L2-normalized vectors → searchKnn returns
//     the expected nearest neighbors for crafted query vectors
//   • Recall@K is high (≥ 95%) on a deterministic synthetic corpus —
//     the IR-standard correctness check
//   • legacy and receipt-bearing HNSW hit conversion preserve their distinct
//     public shapes and convert cosine distance back to similarity correctly
//   • EmbedDb.getAllVectors returns rows with stable labels, copies
//     vectors (no shared buffer aliasing), and skips corrupt rows
//   • Failure modes: dim mismatch throws, empty input is safe

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { EmbedDb } from "../src/embed-db.js";
import {
  buildHnsw as buildHnswWithoutScopes,
  clearHnswPersistedArtifacts as clearHnswPersistedArtifactsWithoutScopes,
  clearHnswPublishedGenerationIfStale as clearHnswPublishedGenerationIfStaleWithoutScopes,
  type HnswBuildOptions,
  type HnswIndex,
  type HnswPersistedMeta,
  type HnswPublicationReceiptSink,
  hnswResultsToHits,
  hnswResultsToReceiptHits,
  isHnswGenerationBasename,
  type LabeledVector,
  loadHnswFromDisk,
  preflightHnswPersistedArtifacts
} from "../src/hnsw.js";
import { acquirePersistenceFamilyLease, type PersistenceFamilyScopes } from "../src/persistence-coordination.js";
import { PersistenceLeaseConflictError } from "../src/persistence-lease.js";
import { SEMANTIC_PERSISTENCE_FAMILY_KEY } from "../src/semantic-persistence.js";
import { inspectSensitiveArtifact, publishSensitiveArtifact } from "../src/sensitive-artifact.js";
import { adaptiveHnswRefill, assertHnswModelMatchesEmbedder, selectUsableHnswContext } from "../src/tools/search.js";

async function testSemanticScopes(file: string): Promise<PersistenceFamilyScopes> {
  const embedFile = `${file.slice(0, -".hnsw".length)}.embed.db`;
  const lifetime = await acquirePersistenceFamilyLease({
    targetPath: embedFile,
    familyKey: SEMANTIC_PERSISTENCE_FAMILY_KEY,
    role: "shared"
  });
  const scopes = lifetime.scopes;
  await lifetime.release();
  return scopes;
}

async function buildHnsw(vectors: ReadonlyArray<LabeledVector>, opts: HnswBuildOptions): Promise<HnswIndex> {
  const index = await buildHnswWithoutScopes(vectors, opts);
  const saveWithoutTestAuthority = index.saveTo.bind(index);
  index.saveTo = async (file, rowsByLabel, signature, dbGeneration, persistenceScopes, publication) =>
    saveWithoutTestAuthority(
      file,
      rowsByLabel,
      signature,
      dbGeneration,
      persistenceScopes ?? (await testSemanticScopes(file)),
      publication
    );
  return index;
}

async function clearHnswPersistedArtifacts(file: string): Promise<boolean> {
  if (!path.basename(file).endsWith(".hnsw")) return clearHnswPersistedArtifactsWithoutScopes(file);
  return clearHnswPersistedArtifactsWithoutScopes(file, await testSemanticScopes(file));
}

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

function persistedRow(label: number): {
  rel_path: string;
  chunk_index: number;
  line_start: number;
  line_end: number;
  text_preview: string;
  kind: "md";
} {
  return {
    rel_path: `note-${label}.md`,
    chunk_index: 0,
    line_start: 1,
    line_end: 1,
    text_preview: `label ${label}`,
    kind: "md"
  };
}

function trustedHnswShape(
  labels: Iterable<number>,
  expectedDim = 4,
  vectors?: ReadonlyMap<number, Float32Array>,
  generation: { dbInstanceUuid: string; dbMutationEpoch: number } = {
    dbInstanceUuid: "00000000000000000000000000000000",
    dbMutationEpoch: 1
  }
): {
  expectedDim: number;
  expectedRowsByLabel: Map<number, ReturnType<typeof persistedRow>>;
  expectedVectorsByLabel: Map<number, Float32Array>;
  expectedDbInstanceUuid: string;
  expectedDbMutationEpoch: number;
} {
  const expectedRowsByLabel = new Map<number, ReturnType<typeof persistedRow>>();
  const expectedVectorsByLabel = new Map<number, Float32Array>();
  for (const label of labels) {
    expectedRowsByLabel.set(label, persistedRow(label));
    const supplied = vectors?.get(label);
    const deterministic = new Float32Array(expectedDim);
    if (expectedDim === 4) {
      deterministic.set(l2(new Float32Array([label + 1, 2, 3, 4])));
    } else {
      deterministic[0] = 1;
    }
    expectedVectorsByLabel.set(label, supplied ?? deterministic);
  }
  return {
    expectedDim,
    expectedRowsByLabel,
    expectedVectorsByLabel,
    expectedDbInstanceUuid: generation.dbInstanceUuid,
    expectedDbMutationEpoch: generation.dbMutationEpoch
  };
}

async function persistMinimalGeneration(
  persistFile: string,
  signature: string,
  label = 0
): Promise<Record<string, unknown>> {
  const vector = l2(new Float32Array([label + 1, 2, 3, 4]));
  const index = await buildHnsw([{ label, vector }], { dim: 4, maxElements: 1, seed: label + 101 });
  const saved = await index.saveTo(persistFile, new Map([[label, persistedRow(label)]]), signature);
  if (!saved) throw new Error("minimal HNSW fixture did not persist");
  return JSON.parse(await fs.readFile(`${persistFile}.meta.json`, "utf8")) as Record<string, unknown>;
}

async function mutatePersistedNativeGeneration(
  persistFile: string,
  mutate: (bytes: Buffer) => Buffer | undefined
): Promise<void> {
  const metaFile = `${persistFile}.meta.json`;
  const meta = JSON.parse(await fs.readFile(metaFile, "utf8")) as Record<string, unknown>;
  const generationFile = path.join(path.dirname(persistFile), String(meta.binFile));
  const bytes = Buffer.from(await fs.readFile(generationFile));
  const result = mutate(bytes);
  const mutated = Buffer.isBuffer(result) ? result : bytes;
  await fs.writeFile(generationFile, mutated, { mode: 0o600 });
  meta.binSha256 = createHash("sha256").update(mutated).digest("hex");
  await fs.writeFile(metaFile, JSON.stringify(meta), { mode: 0o600 });
}

function withSingleUpperLevel(bytes: Buffer, mutateUpper: (result: Buffer, upperRecordOffset: number) => void): Buffer {
  const currentCount = Number(bytes.readBigUInt64LE(16));
  const sizeDataPerElement = Number(bytes.readBigUInt64LE(24));
  const maxM = Number(bytes.readBigUInt64LE(56));
  if (currentCount !== 1) throw new Error("single-upper-level fixture requires one native element");
  const level0End = 96 + currentCount * sizeDataPerElement;
  const upperRecordBytes = maxM * 4 + 4;
  const result = Buffer.concat([bytes.subarray(0, level0End), Buffer.alloc(4 + upperRecordBytes)]);
  result.writeInt32LE(1, 48);
  result.writeUInt32LE(upperRecordBytes, level0End);
  mutateUpper(result, level0End + 4);
  return result;
}

function withUpperLevelLayout(
  bytes: Buffer,
  levels: readonly number[],
  entrypoint: number,
  mutate: (result: Buffer, upperRecordOffsets: readonly (readonly number[])[]) => void
): Buffer {
  const currentCount = Number(bytes.readBigUInt64LE(16));
  const sizeDataPerElement = Number(bytes.readBigUInt64LE(24));
  const maxM = Number(bytes.readBigUInt64LE(56));
  if (levels.length !== currentCount) throw new Error("upper-level fixture must describe every native element");
  const level0End = 96 + currentCount * sizeDataPerElement;
  const upperRecordBytes = maxM * 4 + 4;
  const suffixBytes = levels.reduce((total, level) => total + 4 + level * upperRecordBytes, 0);
  const result = Buffer.concat([bytes.subarray(0, level0End), Buffer.alloc(suffixBytes)]);
  result.writeInt32LE(Math.max(...levels), 48);
  result.writeUInt32LE(entrypoint, 52);
  const offsets: number[][] = [];
  let cursor = level0End;
  for (const level of levels) {
    result.writeUInt32LE(level * upperRecordBytes, cursor);
    cursor += 4;
    const elementOffsets: number[] = [];
    for (let index = 0; index < level; index += 1) {
      elementOffsets.push(cursor + index * upperRecordBytes);
    }
    offsets.push(elementOffsets);
    cursor += level * upperRecordBytes;
  }
  mutate(result, offsets);
  return result;
}

// Compile-time compatibility pin: current compact disk publication is internal. The
// exported v1 metadata shape remains exact source compatibility for existing users.
type ExpectedPublicMetaV1 = {
  formatVersion: 1;
  dim: number;
  size: number;
  signature: string;
  rowsByLabel: Record<
    string,
    {
      rel_path: string;
      chunk_index: number;
      line_start: number;
      line_end: number;
      text_preview: string;
      kind: "md" | "pdf";
    }
  >;
  writtenAt: string;
};
type TypeEqual<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? (<Value>() => Value extends Right ? 1 : 2) extends <Value>() => Value extends Left ? 1 : 2
      ? true
      : false
    : false;
type StablePublicMetaV1 = TypeEqual<HnswPersistedMeta, ExpectedPublicMetaV1>;

const PUBLIC_META_V1_FIXTURE: StablePublicMetaV1 extends true ? ExpectedPublicMetaV1 : never = {
  formatVersion: 1,
  dim: 4,
  size: 0,
  signature: "legacy-signature",
  rowsByLabel: {},
  writtenAt: "2026-01-01T00:00:00.000Z"
};

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

  it.each([
    {
      shape: "a vector with mismatched dim",
      invoke: () =>
        buildHnsw(
          [
            { label: 0, vector: l2(new Float32Array(8).fill(1)) },
            { label: 1, vector: l2(new Float32Array(4).fill(1)) }
          ],
          { dim: 8, maxElements: 2 }
        ),
      error: /dim/
    },
    {
      shape: "an unsafe native dimension",
      invoke: () => buildHnsw([], { dim: 2 ** 32 + 4, maxElements: 0 }),
      error: /dim.*safe integer/
    },
    {
      shape: "an unsafe maxElements",
      invoke: () => buildHnsw([], { dim: 4, maxElements: 2 ** 32 }),
      error: /maxElements.*safe integer/
    },
    {
      shape: "an unsafe native build parameter",
      invoke: () => buildHnsw([], { dim: 4, maxElements: 0, efConstruction: Number.NaN }),
      error: /efConstruction.*safe integer/
    },
    {
      shape: "an impractical M that cannot encode a finite level multiplier",
      invoke: () => buildHnsw([], { dim: 4, maxElements: 0, m: 1 }),
      error: /buildHnsw m.*safe integer/
    },
    {
      shape: "an unsafe native label",
      invoke: () =>
        buildHnsw([{ label: 2 ** 32, vector: l2(new Float32Array(4).fill(1)) }], { dim: 4, maxElements: 1 }),
      error: /label.*safe integer/
    },
    {
      shape: "a duplicate label",
      invoke: () =>
        buildHnsw(
          [
            { label: 1, vector: l2(new Float32Array(4).fill(1)) },
            { label: 1, vector: l2(new Float32Array(4).fill(2)) }
          ],
          { dim: 4, maxElements: 2 }
        ),
      error: /duplicate label/
    },
    {
      shape: "a non-finite vector",
      invoke: () =>
        buildHnsw([{ label: 1, vector: new Float32Array([1, 2, Number.NaN, 4]) }], { dim: 4, maxElements: 1 }),
      error: /non-finite/
    }
  ])("rejects $shape before native initialization", async ({ invoke, error }) => {
    await expect(invoke()).rejects.toThrow(error);
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

  it("searchKnn rejects malformed native query inputs", async () => {
    const dim = 8;
    const v = l2(new Float32Array(dim).fill(1));
    const index = await buildHnsw([{ label: 0, vector: v }], { dim, maxElements: 1 });
    expect(() => index.searchKnn(new Float32Array(4).fill(1), 1)).toThrow(/query dim/);
    expect(() => index.searchKnn(new Float32Array(dim).fill(Number.NaN), 1)).toThrow(/non-finite/);
    expect(() => index.searchKnn(v, 2 ** 32)).toThrow(/searchKnn k.*safe integer/);
    expect(() => index.searchKnn(v, 1, { ef: Number.POSITIVE_INFINITY })).toThrow(/searchKnn ef.*safe integer/);
  });
});

describe("hnswResultsToHits (v2.13.0)", () => {
  it("preserves legacy hits while the additive helper carries current receipts", () => {
    const legacyRows = new Map<
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
    legacyRows.set(7, {
      rel_path: "notes/a.md",
      chunk_index: 0,
      line_start: 1,
      line_end: 5,
      text_preview: "Hello world",
      kind: "md"
    });
    legacyRows.set(13, {
      rel_path: "papers/b.pdf",
      chunk_index: 2,
      line_start: 10,
      line_end: 20,
      text_preview: "[page: 3] Some content",
      kind: "pdf"
    });
    const result = { labels: [7, 13], distances: [0.1, 0.4] };
    const legacyHits = hnswResultsToHits(result, legacyRows);
    expect(legacyHits).toHaveLength(2);
    // distance 0.1 → similarity 0.9
    expect(legacyHits[0]?.score).toBeCloseTo(0.9, 5);
    expect(legacyHits[0]?.rel_path).toBe("notes/a.md");
    expect(legacyHits[0]?.kind).toBe("md");
    expect(legacyHits[0]?.text_preview).toBe("Hello world");
    expect(legacyHits[0]).not.toHaveProperty("indexed_mtime_ms");
    expect(legacyHits[0]).not.toHaveProperty("indexed_revision");
    expect(legacyHits[1]?.score).toBeCloseTo(0.6, 5);
    expect(legacyHits[1]?.kind).toBe("pdf");

    const receiptRows = new Map(
      [...legacyRows].map(
        ([label, row]) =>
          [
            label,
            {
              ...row,
              indexed_mtime_ms: label === 7 ? 1700000000001 : 1700000000002,
              indexed_revision: label === 7 ? 11 : 12
            }
          ] as const
      )
    );
    const receiptHits = hnswResultsToReceiptHits(result, receiptRows);
    expect(receiptHits).toHaveLength(2);
    expect(receiptHits[0]?.score).toBeCloseTo(0.9, 5);
    expect(receiptHits[0]).toEqual(
      expect.objectContaining({
        rel_path: "notes/a.md",
        indexed_mtime_ms: 1700000000001,
        indexed_revision: 11
      })
    );
    expect(receiptHits[1]?.score).toBeCloseTo(0.6, 5);
    expect(receiptHits[1]).toEqual(
      expect.objectContaining({
        rel_path: "papers/b.pdf",
        indexed_mtime_ms: 1700000000002,
        indexed_revision: 12
      })
    );
  });

  it("silently drops labels not in rowByLabel (e.g. row deleted between build + query)", () => {
    const rowByLabel = new Map();
    rowByLabel.set(7, {
      rel_path: "a.md",
      chunk_index: 0,
      line_start: 1,
      line_end: 1,
      text_preview: "x",
      kind: "md",
      indexed_mtime_ms: 1700000000001,
      indexed_revision: 11
    });
    const result = { labels: [7, 99, 7], distances: [0.1, 0.2, 0.3] };
    const hits = hnswResultsToHits(result, rowByLabel);
    const receiptHits = hnswResultsToReceiptHits(result, rowByLabel);
    // 99 is missing; 7 appears twice
    expect(hits.length).toBe(2);
    expect(receiptHits.length).toBe(2);
    expect(receiptHits.map((hit) => hit.indexed_revision)).toEqual([11, 11]);
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
      await db.closeAndRelease();
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

  const invalidHnswAdmissionCases = [
    ["missing suffix", "index.bin"],
    ["uppercase suffix", "index.HNSW"],
    ["trailing LF", "index.hnsw\n"],
    ["trailing U+2028", "index.hnsw\u2028"]
  ] as const;
  const hnswAdmissionRoutes = [
    { route: "load", invoke: async (file: string) => loadHnswFromDisk(file, "signature", undefined as never) },
    { route: "preflight", invoke: async (file: string) => preflightHnswPersistedArtifacts(file) },
    { route: "clear", invoke: async (file: string) => clearHnswPersistedArtifacts(file) },
    {
      route: "generation classifier",
      invoke: async (file: string) => isHnswGenerationBasename(file, "index.hnsw.aaaaaaaa.bin")
    }
  ].flatMap(({ route, invoke }) =>
    invalidHnswAdmissionCases.map(([shape, basename]) => ({ route, invoke, shape, basename }))
  );

  it.each(hnswAdmissionRoutes)("$route rejects $shape before filesystem work", async ({ invoke, basename }) => {
    const absentParent = path.join(dir, `invalid-${Buffer.from(basename).toString("hex")}`);
    await expect(invoke(path.join(absentParent, basename))).rejects.toThrow(
      new TypeError("HNSW persistence base must end exactly in '.hnsw'")
    );
    await expect(fs.lstat(absentParent)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("admits only the canonical twelve-hex legacy HNSW derivation without pinned EmbedDb scopes", async () => {
    const vector = l2(new Float32Array([1, 0, 0, 0]));
    const custom = await buildHnswWithoutScopes([{ label: 1, vector }], { dim: 4, maxElements: 1 });
    const customFile = path.join(dir, "custom.hnsw");
    await expect(custom.saveTo(customFile, new Map([[1, persistedRow(1)]]), "legacy-custom")).rejects.toThrow(
      /Custom HNSW persistence requires pinned EmbedDb family scopes/
    );
    await expect(fs.lstat(`${customFile}.meta.json`)).rejects.toMatchObject({ code: "ENOENT" });

    const canonical = await buildHnswWithoutScopes([{ label: 2, vector }], { dim: 4, maxElements: 1 });
    const canonicalFile = path.join(dir, "0123456789ab.hnsw");
    await expect(canonical.saveTo(canonicalFile, new Map([[2, persistedRow(2)]]), "legacy-canonical")).resolves.toBe(
      true
    );
    await expect(clearHnswPersistedArtifactsWithoutScopes(canonicalFile)).resolves.toBe(true);
  });

  it("saveTo publishes one coherent generation and load reproduces search results", async () => {
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
    expect(await index.saveTo(persistFile, rowsByLabel, "sig-v1")).toBe(true);

    // The stable meta leaf points to one immutable, digest-bound generation.
    const persistedMeta = JSON.parse(await fs.readFile(`${persistFile}.meta.json`, "utf8")) as {
      formatVersion: number;
      binFile: string;
      binSha256: string;
      dim: number;
      size: number;
      signature: string;
      dbInstanceUuid: string;
      dbMutationEpoch: number;
      writtenAt: string;
    };
    expect(persistedMeta.formatVersion).toBe(4);
    expect(persistedMeta.binFile).toMatch(/^test\.hnsw\.[0-9a-f]{48}\.bin$/);
    expect(persistedMeta.binSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(persistedMeta).sort()).toEqual(
      [
        "formatVersion",
        "binFile",
        "binSha256",
        "dim",
        "size",
        "signature",
        "dbInstanceUuid",
        "dbMutationEpoch",
        "writtenAt"
      ].sort()
    );
    expect(persistedMeta.dbInstanceUuid).toBe("00000000000000000000000000000000");
    expect(persistedMeta.dbMutationEpoch).toBe(1);
    expect(persistedMeta).not.toHaveProperty("rowsByLabel");
    expect(Buffer.byteLength(JSON.stringify(persistedMeta), "utf8")).toBeLessThan(64 * 1024);
    await expect(fs.access(path.join(dir, persistedMeta.binFile))).resolves.toBeUndefined();
    await expect(fs.access(`${persistFile}.meta.json`)).resolves.toBeUndefined();
    // Load with matching signature.
    const loaded = await loadHnswFromDisk(persistFile, "sig-v1", {
      expectedDim: dim,
      expectedRowsByLabel: rowsByLabel,
      expectedVectorsByLabel: new Map(labeled.map(({ label, vector }) => [label, vector]))
    });
    expect(loaded).not.toBeNull();
    if (!loaded) return;
    expect(loaded.index.dim).toBe(dim);
    expect(loaded.index.size).toBe(n);
    expect(loaded.rowsByLabel.size).toBe(n);
    expect(loaded.rowsByLabel.get(105)?.rel_path).toBe("note-5.md");

    // Loaded index should produce the same top-5 as the original.
    const afterLoad = loaded.index.searchKnn(queryVec, 5);
    expect(afterLoad.labels).toEqual(beforePersist.labels);

    // Disk-loaded graphs must retain replaceDeleted authority. Without the
    // explicit readIndex(..., true) flag, this first watcher-style replacement
    // throws after markDelete and permanently quarantines the loaded graph.
    const replacement = l2(new Float32Array([0.91, -0.23, 0.37, 0.11, -0.41, 0.29, 0.18, -0.07]));
    expect(loaded.index.applyDiff([105], [{ label: 900, vector: replacement }])).toEqual({ removed: 1, added: 1 });
    const afterReplacement = loaded.index.searchKnn(replacement, 5, { ef: 30 });
    expect(afterReplacement.labels[0]).toBe(900);
    expect(afterReplacement.labels).not.toContain(105);
  });

  it("(NEGATIVE control) conditional stale cleanup preserves a newer published generation", async () => {
    const persistFile = path.join(dir, "conditional-newer.hnsw");
    const persistenceScopes = await testSemanticScopes(persistFile);
    const staleAuthority = { dbInstanceUuid: "a".repeat(32), dbMutationEpoch: 11 };
    const currentAuthority = { dbInstanceUuid: "a".repeat(32), dbMutationEpoch: 12 };
    const vectorA = l2(new Float32Array([1, 2, 3, 4]));
    const vectorB = l2(new Float32Array([4, 3, 2, 1]));
    const indexA = await buildHnsw([{ label: 801, vector: vectorA }], { dim: 4, maxElements: 1, seed: 801 });
    const indexB = await buildHnsw([{ label: 802, vector: vectorB }], { dim: 4, maxElements: 1, seed: 802 });
    const publicationA: HnswPublicationReceiptSink = {};
    const publicationB: HnswPublicationReceiptSink = {};

    await indexA.saveTo(
      persistFile,
      new Map([[801, persistedRow(801)]]),
      "conditional-race-a",
      staleAuthority,
      persistenceScopes,
      publicationA
    );
    await indexB.saveTo(
      persistFile,
      new Map([[802, persistedRow(802)]]),
      "conditional-race-b",
      currentAuthority,
      persistenceScopes,
      publicationB
    );
    const stale = publicationA.receipt;
    const current = publicationB.receipt;
    if (!stale || !current) throw new Error("saveTo did not return publication receipts");
    expect(current.binFile).not.toBe(stale.binFile);

    await expect(
      clearHnswPublishedGenerationIfStaleWithoutScopes(persistFile, stale, staleAuthority, persistenceScopes)
    ).resolves.toBe(false);
    const meta = JSON.parse(await fs.readFile(`${persistFile}.meta.json`, "utf8")) as {
      binFile: string;
      binSha256: string;
    };
    expect(meta).toMatchObject(current);
    await expect(fs.access(path.join(dir, current.binFile))).resolves.toBeUndefined();
    await expect(
      loadHnswFromDisk(
        persistFile,
        "conditional-race-b",
        trustedHnswShape([802], 4, new Map([[802, vectorB]]), currentAuthority)
      )
    ).resolves.not.toBeNull();
  });

  it("removes a later publication bound to the same invalidated DB generation", async () => {
    const persistFile = path.join(dir, "conditional-stale-later.hnsw");
    const persistenceScopes = await testSemanticScopes(persistFile);
    const staleAuthority = { dbInstanceUuid: "c".repeat(32), dbMutationEpoch: 21 };
    const vectorA = l2(new Float32Array([1, 3, 2, 4]));
    const vectorB = l2(new Float32Array([4, 2, 3, 1]));
    const indexA = await buildHnsw([{ label: 811, vector: vectorA }], { dim: 4, maxElements: 1, seed: 811 });
    const indexB = await buildHnsw([{ label: 812, vector: vectorB }], { dim: 4, maxElements: 1, seed: 812 });
    const publicationA: HnswPublicationReceiptSink = {};
    const publicationB: HnswPublicationReceiptSink = {};

    await indexA.saveTo(
      persistFile,
      new Map([[811, persistedRow(811)]]),
      "conditional-stale-a",
      staleAuthority,
      persistenceScopes,
      publicationA
    );
    await indexB.saveTo(
      persistFile,
      new Map([[812, persistedRow(812)]]),
      "conditional-stale-b",
      staleAuthority,
      persistenceScopes,
      publicationB
    );
    const stale = publicationA.receipt;
    const laterStale = publicationB.receipt;
    if (!stale || !laterStale) throw new Error("saveTo did not return publication receipts");
    expect(laterStale.binFile).not.toBe(stale.binFile);

    await expect(
      clearHnswPublishedGenerationIfStaleWithoutScopes(persistFile, stale, staleAuthority, persistenceScopes)
    ).resolves.toBe(true);
    await expect(fs.lstat(`${persistFile}.meta.json`)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.lstat(path.join(dir, laterStale.binFile))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes an older same-instance publication without relying on an exact save receipt", async () => {
    const persistFile = path.join(dir, "conditional-older-authority.hnsw");
    const persistenceScopes = await testSemanticScopes(persistFile);
    const olderAuthority = { dbInstanceUuid: "f".repeat(32), dbMutationEpoch: 50 };
    const invalidatedAuthority = { dbInstanceUuid: "f".repeat(32), dbMutationEpoch: 51 };
    const vector = l2(new Float32Array([3, 1, 4, 2]));
    const index = await buildHnsw([{ label: 814, vector }], { dim: 4, maxElements: 1, seed: 814 });
    const publication: HnswPublicationReceiptSink = {};
    await index.saveTo(
      persistFile,
      new Map([[814, persistedRow(814)]]),
      "conditional-older-authority",
      olderAuthority,
      persistenceScopes,
      publication
    );
    const older = publication.receipt;
    if (!older) throw new Error("saveTo did not return a publication receipt");

    await expect(
      clearHnswPublishedGenerationIfStaleWithoutScopes(persistFile, undefined, invalidatedAuthority, persistenceScopes)
    ).resolves.toBe(true);
    await expect(fs.lstat(`${persistFile}.meta.json`)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.lstat(path.join(dir, older.binFile))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("conditional stale cleanup removes the exact current publication", async () => {
    const persistFile = path.join(dir, "conditional-current.hnsw");
    const persistenceScopes = await testSemanticScopes(persistFile);
    const staleAuthority = { dbInstanceUuid: "d".repeat(32), dbMutationEpoch: 31 };
    const vector = l2(new Float32Array([1, 4, 2, 3]));
    const index = await buildHnsw([{ label: 803, vector }], { dim: 4, maxElements: 1, seed: 803 });
    const publication: HnswPublicationReceiptSink = {};
    await index.saveTo(
      persistFile,
      new Map([[803, persistedRow(803)]]),
      "conditional-current",
      staleAuthority,
      persistenceScopes,
      publication
    );
    const receipt = publication.receipt;
    if (!receipt) throw new Error("saveTo did not return a publication receipt");
    const unrelatedBasename = `${path.basename(persistFile)}.${"9".repeat(48)}.bin`;
    const unrelatedGeneration = path.join(dir, unrelatedBasename);
    await fs.writeFile(unrelatedGeneration, "UNRELATED_ORPHAN");

    await expect(
      clearHnswPublishedGenerationIfStaleWithoutScopes(persistFile, receipt, staleAuthority, persistenceScopes)
    ).resolves.toBe(true);
    await expect(fs.lstat(`${persistFile}.meta.json`)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.lstat(path.join(dir, receipt.binFile))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(unrelatedGeneration, "utf8")).resolves.toBe("UNRELATED_ORPHAN");
  });

  it("removes the invalidated current publication without a save receipt", async () => {
    const persistFile = path.join(dir, "conditional-no-receipt.hnsw");
    const persistenceScopes = await testSemanticScopes(persistFile);
    const staleAuthority = { dbInstanceUuid: "e".repeat(32), dbMutationEpoch: 41 };
    const vector = l2(new Float32Array([2, 4, 1, 3]));
    const index = await buildHnsw([{ label: 813, vector }], { dim: 4, maxElements: 1, seed: 813 });
    const publication: HnswPublicationReceiptSink = {};
    await index.saveTo(
      persistFile,
      new Map([[813, persistedRow(813)]]),
      "conditional-no-receipt",
      staleAuthority,
      persistenceScopes,
      publication
    );
    const current = publication.receipt;
    if (!current) throw new Error("saveTo did not return a publication receipt");

    await expect(
      clearHnswPublishedGenerationIfStaleWithoutScopes(persistFile, undefined, staleAuthority, persistenceScopes)
    ).resolves.toBe(true);
    await expect(fs.lstat(`${persistFile}.meta.json`)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.lstat(path.join(dir, current.binFile))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports a present but inadmissible pointer instead of silently skipping stale cleanup", async () => {
    const persistFile = path.join(dir, "conditional-malformed.hnsw");
    const persistenceScopes = await testSemanticScopes(persistFile);
    const staleAuthority = { dbInstanceUuid: "1".repeat(32), dbMutationEpoch: 61 };
    await fs.writeFile(`${persistFile}.meta.json`, "{malformed");

    await expect(
      clearHnswPublishedGenerationIfStaleWithoutScopes(persistFile, undefined, staleAuthority, persistenceScopes)
    ).rejects.toThrow(/live meta pointer is not admissible/i);
    await expect(fs.readFile(`${persistFile}.meta.json`, "utf8")).resolves.toBe("{malformed");
  });

  it.each(["f32", "int8"] as const)(
    "loads an exact native graph from one atomic %s DB row/vector authority snapshot",
    async (quantization) => {
      const db = new EmbedDb({
        file: path.join(dir, `semantic-authority-${quantization}.embed.db`),
        vaultRoot: "/v",
        modelAlias: "multilingual",
        dim: 4,
        quantization
      });
      await db.open();
      try {
        db.upsertNote("authority.md", 1000, [
          {
            chunkIndex: 0,
            lineStart: 1,
            lineEnd: 1,
            textPreview: quantization,
            vector: l2(new Float32Array([0.31, -0.72, 0.41, 0.46]))
          }
        ]);
        const snapshot = db.captureHnswLoadSnapshot();
        expect(snapshot.vectorsByLabel.size).toBe(1);
        expect([...snapshot.vectorsByLabel.keys()]).toEqual([...snapshot.rowsByLabel.keys()]);
        const points = [...snapshot.vectorsByLabel].map(([label, vector]) => ({ label, vector }));
        const index = await buildHnsw(points, { dim: 4, maxElements: points.length, seed: 616 });
        const persistFile = path.join(dir, `semantic-authority-${quantization}.hnsw`);
        await index.saveTo(persistFile, snapshot.rowsByLabel, snapshot.receipt.signature, {
          dbInstanceUuid: snapshot.receipt.dbInstanceUuid,
          dbMutationEpoch: snapshot.receipt.dbMutationEpoch
        });

        const loaded = await loadHnswFromDisk(persistFile, snapshot.receipt.signature, {
          expectedDim: snapshot.receipt.dim,
          expectedRowsByLabel: snapshot.rowsByLabel,
          expectedVectorsByLabel: snapshot.vectorsByLabel,
          expectedDbInstanceUuid: snapshot.receipt.dbInstanceUuid,
          expectedDbMutationEpoch: snapshot.receipt.dbMutationEpoch
        });
        expect(loaded).not.toBeNull();
        expect(loaded?.index.searchKnn(points[0]?.vector ?? new Float32Array(4), 1).labels).toEqual([points[0]?.label]);
      } finally {
        await db.closeAndRelease();
      }
    }
  );

  it.for([{ sidecar: "legacy binary" as const }, { sidecar: "stable metadata" as const }])(
    "saveTo does not follow a planted $sidecar sidecar symlink",
    async ({ sidecar }, { skip }) => {
      const persistFile = path.join(dir, `symlink-${sidecar.replace(" ", "-")}.hnsw`);
      const link = sidecar === "legacy binary" ? `${persistFile}.bin` : `${persistFile}.meta.json`;
      const sentinel = path.join(dir, `symlink-${sidecar.replace(" ", "-")}-sentinel.txt`);
      await fs.writeFile(sentinel, `UNCHANGED_${sidecar}`);
      try {
        await fs.symlink(sentinel, link, "file");
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EPERM" || code === "EACCES" || code === "ENOSYS") {
          skip(`filesystem cannot create the symlink control (${code})`);
          return;
        }
        throw err;
      }

      await persistMinimalGeneration(persistFile, `symlink-${sidecar}`);
      expect(await fs.readFile(sentinel, "utf8")).toBe(`UNCHANGED_${sidecar}`);
      if (sidecar === "legacy binary") {
        await expect(fs.lstat(link)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        expect((await fs.lstat(link)).isSymbolicLink()).toBe(false);
      }
    }
  );

  it.each(["native stage"])("post-publish %s cleanup failure does not turn success into failure", async () => {
    const persistFile = path.join(dir, "stage-cleanup.hnsw");
    const realRmdir = fs.rmdir.bind(fs);
    let injected = false;
    const rmdirSpy = vi.spyOn(fs, "rmdir").mockImplementation(async (candidate) => {
      if (!injected && String(candidate).includes(".enquire-stage-")) {
        injected = true;
        throw Object.assign(new Error("injected post-publish stage cleanup failure"), { code: "EACCES" });
      }
      await realRmdir(candidate);
    });
    let meta: Record<string, unknown> | null = null;
    try {
      meta = await persistMinimalGeneration(persistFile, "stage-cleanup-signature");
    } finally {
      rmdirSpy.mockRestore();
    }
    expect(injected).toBe(true);
    expect(meta?.formatVersion).toBe(4);
    expect(await loadHnswFromDisk(persistFile, "stage-cleanup-signature", trustedHnswShape([0]))).not.toBeNull();
  });

  it("M1 live count remains correct in persisted metadata", async () => {
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

    const exactRows = new Map([0, 1, 2, 99].map((label) => [label, persistedRow(label)] as const));
    const rejectedFile = path.join(dir, "m1-rejected.hnsw");
    await expect(index.saveTo(rejectedFile, new Map(), "")).rejects.toThrow(/signature must be a non-empty string/);
    await expect(index.saveTo(rejectedFile, new Map(), 42 as never)).rejects.toThrow(
      /signature must be a non-empty string/
    );
    await expect(index.saveTo(rejectedFile, new Map([[2 ** 32, persistedRow(0)]]), "m1-sig")).rejects.toThrow(
      /does not exactly match the live native-label manifest/
    );
    const malformedExactRows = new Map(exactRows);
    malformedExactRows.set(1, { ...persistedRow(1), line_start: 0 });
    await expect(index.saveTo(rejectedFile, malformedExactRows, "m1-sig")).rejects.toThrow(/invalid persisted shape/);
    await expect(
      index.saveTo(
        rejectedFile,
        new Map(Array.from({ length: liveCount + 1 }, (_, label) => [label, persistedRow(label)] as const)),
        "m1-sig"
      )
    ).rejects.toThrow(/does not exactly match the live native-label manifest/);
    await expect(fs.lstat(`${rejectedFile}.meta.json`)).rejects.toMatchObject({ code: "ENOENT" });

    const persistFile = path.join(dir, "m1.hnsw");
    await index.saveTo(persistFile, exactRows, "m1-sig");
    const meta = JSON.parse(await fs.readFile(`${persistFile}.meta.json`, "utf8")) as {
      size: number;
      binFile: string;
    };
    expect(meta.size, "persisted meta.size must be the live count").toBe(liveCount);
    expect(meta.size, "NEGATIVE control: must NOT be the stale build-time size").not.toBe(n);
  });

  it.each(["old immutable generation"])("post-meta GC failure for %s is non-fatal", async () => {
    const persistFile = path.join(dir, "gc-failure.hnsw");
    await persistMinimalGeneration(persistFile, "gc-failure-signature", 41);
    const oldMeta = JSON.parse(await fs.readFile(`${persistFile}.meta.json`, "utf8")) as { binFile: string };
    const oldGeneration = path.join(dir, oldMeta.binFile);
    const vector = l2(new Float32Array([1, 2, 3, 4]));
    const index = await buildHnsw([{ label: 42, vector }], { dim: 4, maxElements: 1, seed: 142 });
    const realUnlink = fs.unlink.bind(fs);
    let injectedOldGenerationGcFailure = false;
    const unlinkSpy = vi.spyOn(fs, "unlink").mockImplementation(async (candidate) => {
      if (!injectedOldGenerationGcFailure && path.basename(String(candidate)) === path.basename(oldGeneration)) {
        injectedOldGenerationGcFailure = true;
        throw Object.assign(new Error("injected old-generation GC failure"), { code: "EACCES" });
      }
      await realUnlink(candidate);
    });
    let savedAfterGcFailure = false;
    try {
      savedAfterGcFailure = await index.saveTo(persistFile, new Map([[42, persistedRow(42)]]), "gc-failure-signature");
    } finally {
      unlinkSpy.mockRestore();
    }
    expect(injectedOldGenerationGcFailure).toBe(true);
    expect(savedAfterGcFailure).toBe(true);
    const newMeta = JSON.parse(await fs.readFile(`${persistFile}.meta.json`, "utf8")) as {
      binFile: string;
    };
    expect(newMeta.binFile).not.toBe(oldMeta.binFile);
    expect((await fs.lstat(oldGeneration)).isFile()).toBe(true);
    const loaded = await loadHnswFromDisk(
      persistFile,
      "gc-failure-signature",
      trustedHnswShape([42], 4, new Map([[42, vector]]))
    );
    expect(loaded).not.toBeNull();
    expect(loaded?.index.searchKnn(vector, 1).labels).toEqual([42]);
  });

  it("migrates an oversized format-2 pointer and garbage-collects its referenced generation", async () => {
    const persistFile = path.join(dir, "legacy-v2-migration.hnsw");
    const originalMeta = await persistMinimalGeneration(persistFile, "legacy-v2-signature", 41);
    const oldGeneration = path.join(dir, String(originalMeta.binFile));
    const legacyMeta = {
      formatVersion: 2,
      binFile: originalMeta.binFile,
      binSha256: originalMeta.binSha256,
      dim: 4,
      size: 1,
      signature: "legacy-v2-signature",
      rowsByLabel: { "41": persistedRow(41) },
      writtenAt: "2026-01-01T00:00:00.000Z",
      padding: "x".repeat(70 * 1024)
    };
    await fs.writeFile(`${persistFile}.meta.json`, JSON.stringify(legacyMeta, null, 2), { mode: 0o600 });
    expect((await fs.stat(`${persistFile}.meta.json`)).size).toBeGreaterThan(64 * 1024);

    const vector = l2(new Float32Array([4, 3, 2, 1]));
    const replacement = await buildHnsw([{ label: 42, vector }], { dim: 4, maxElements: 1, seed: 242 });
    await expect(
      replacement.saveTo(persistFile, new Map([[42, persistedRow(42)]]), "legacy-v2-signature")
    ).resolves.toBe(true);

    await expect(fs.lstat(oldGeneration)).rejects.toMatchObject({ code: "ENOENT" });
    const migratedMeta = JSON.parse(await fs.readFile(`${persistFile}.meta.json`, "utf8")) as Record<string, unknown>;
    expect(migratedMeta.formatVersion).toBe(4);
    expect(migratedMeta).not.toHaveProperty("rowsByLabel");
    expect(migratedMeta.binFile).not.toBe(originalMeta.binFile);
    const loaded = await loadHnswFromDisk(
      persistFile,
      "legacy-v2-signature",
      trustedHnswShape([42], 4, new Map([[42, vector]]))
    );
    expect(loaded?.index.searchKnn(vector, 1).labels).toEqual([42]);
  });

  it.each(["metadata one byte over its compact read limit"])("refuses %s before native publication", async () => {
    const persistFile = path.join(dir, "oversize-meta.hnsw");
    const vector = l2(new Float32Array([1, 2, 3, 4]));
    const index = await buildHnsw([{ label: 601, vector }], { dim: 4, maxElements: 1, seed: 601 });
    const openSpy = vi.spyOn(fs, "open");
    const renameSpy = vi.spyOn(fs, "rename");
    try {
      await expect(
        index.saveTo(persistFile, new Map([[601, persistedRow(601)]]), "x".repeat(64 * 1024))
      ).rejects.toThrow(/metadata exceeds the persistence read limit/);
    } finally {
      openSpy.mockRestore();
      renameSpy.mockRestore();
    }
    expect(openSpy).not.toHaveBeenCalled();
    expect(renameSpy).not.toHaveBeenCalled();
    await expect(fs.lstat(`${persistFile}.meta.json`)).rejects.toMatchObject({ code: "ENOENT" });
    expect(index.searchKnn(vector, 1).labels).toEqual([601]);
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

  it.each(["applyDiff"] as const)("%s throws before native mutation while persistence is in flight", async () => {
    const persistFile = path.join(dir, "mutation-overlap.hnsw");
    const persistenceScopes = await testSemanticScopes(persistFile);
    const query = l2(new Float32Array([1, 0, 0, 0]));
    const replacement = l2(new Float32Array([0, 1, 0, 0]));
    const index = await buildHnsw([{ label: 801, vector: query }], { dim: 4, maxElements: 2, seed: 801 });
    expect(index.searchKnn(query, 1).labels).toEqual([801]);

    const realRename = fs.rename.bind(fs);
    let releaseGeneration = (): void => {};
    let observeGeneration = (): void => {};
    const generationGate = new Promise<void>((resolve) => {
      releaseGeneration = resolve;
    });
    const generationObserved = new Promise<void>((resolve) => {
      observeGeneration = resolve;
    });
    let blocked = false;
    const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      const targetName = path.basename(String(to));
      if (!blocked && targetName.startsWith(`${path.basename(persistFile)}.`) && targetName.endsWith(".bin")) {
        blocked = true;
        observeGeneration();
        await generationGate;
      }
      await realRename(from, to);
    });
    let save: Promise<boolean> | undefined;
    try {
      save = index.saveTo(
        persistFile,
        new Map([[801, persistedRow(801)]]),
        "mutation-overlap-signature",
        undefined,
        persistenceScopes
      );
      await generationObserved;
      expect(() => index.applyDiff([801], [{ label: 802, vector: replacement }])).toThrow(
        /persistence snapshot is in flight/
      );
      expect(index.searchKnn(query, 1).labels, "rejected overlap must not delete label 801").toEqual([801]);
      releaseGeneration();
      await expect(save).resolves.toBe(true);
    } finally {
      releaseGeneration();
      renameSpy.mockRestore();
      await save?.catch(() => {});
    }

    expect(index.applyDiff([801], [{ label: 802, vector: replacement }])).toEqual({ removed: 1, added: 1 });
    expect(index.searchKnn(replacement, 1).labels).toEqual([802]);
  });

  it.each(["applyDiff", "resize"] as const)(
    "%s is excluded while publisher acquisition is suspended after the queued epoch check",
    async (operation) => {
      const persistFile = path.join(dir, `publisher-acquisition-${operation}.hnsw`);
      const persistenceScopes = await testSemanticScopes(persistFile);
      const label = operation === "applyDiff" ? 821 : 822;
      const replacementLabel = label + 100;
      const original = l2(new Float32Array([1, 0, 0, 0]));
      const replacement = l2(new Float32Array([0, 1, 0, 0]));
      const index = await buildHnsw([{ label, vector: original }], { dim: 4, maxElements: 2, seed: label });

      const realOpen = fs.open.bind(fs);
      let releasePublisherCandidate = (): void => {};
      let observePublisherCandidate = (): void => {};
      const publisherCandidateGate = new Promise<void>((resolve) => {
        releasePublisherCandidate = resolve;
      });
      const publisherCandidateObserved = new Promise<void>((resolve) => {
        observePublisherCandidate = resolve;
      });
      let candidateBlocked = false;
      const openSpy = vi.spyOn(fs, "open").mockImplementation(async (candidate, ...args) => {
        const candidatePath = String(candidate);
        if (
          !candidateBlocked &&
          candidatePath.includes(`${path.sep}.enquire-mcp-leases${path.sep}`) &&
          path.basename(candidatePath).startsWith(".candidate.")
        ) {
          candidateBlocked = true;
          observePublisherCandidate();
          await publisherCandidateGate;
        }
        return realOpen(candidate, ...args);
      });

      const mutate = (): { removed: number; added: number } | { currentCount: number; maxElements: number } => {
        if (operation === "applyDiff") {
          return index.applyDiff([label], [{ label: replacementLabel, vector: replacement }]);
        }
        index.resize(3);
        return index.capacity();
      };

      let save: Promise<boolean> | undefined;
      try {
        save = index.saveTo(
          persistFile,
          new Map([[label, persistedRow(label)]]),
          `publisher-acquisition-${operation}-signature`,
          undefined,
          persistenceScopes
        );
        // Causal barrier: the save callback has passed its queued epoch check
        // and is now awaiting the first publisher-lease candidate open.
        await publisherCandidateObserved;
        expect(mutate).toThrow(/persistence snapshot is in flight/);
        expect(index.searchKnn(original, 1).labels).toEqual([label]);
        expect(index.capacity().maxElements).toBe(2);
        releasePublisherCandidate();
        await expect(save).resolves.toBe(true);
      } finally {
        releasePublisherCandidate();
        openSpy.mockRestore();
        await save?.catch(() => {});
      }

      const loaded = await loadHnswFromDisk(
        persistFile,
        `publisher-acquisition-${operation}-signature`,
        trustedHnswShape([label], 4, new Map([[label, original]]))
      );
      expect(loaded, "the admitted pre-mutation snapshot must remain reloadable").not.toBeNull();

      // NEGATIVE control: the same valid mutation must work once persistence
      // has completed, proving the barrier did not permanently freeze the graph.
      if (operation === "applyDiff") {
        expect(mutate()).toEqual({ removed: 1, added: 1 });
        expect(index.searchKnn(replacement, 1).labels).toEqual([replacementLabel]);
      } else {
        expect(mutate()).toEqual({ currentCount: 1, maxElements: 3 });
      }
    }
  );

  it.each(["queued save"])("mutation before a %s starts rejects it before native publication", async () => {
    const persistFile = path.join(dir, "queued-epoch.hnsw");
    const persistenceScopes = await testSemanticScopes(persistFile);
    const original = l2(new Float32Array([1, 0, 0, 0]));
    const replacement = l2(new Float32Array([0, 1, 0, 0]));
    const index = await buildHnsw([{ label: 811, vector: original }], { dim: 4, maxElements: 2, seed: 811 });
    const openSpy = vi.spyOn(fs, "open");
    const renameSpy = vi.spyOn(fs, "rename");
    try {
      const save = index.saveTo(
        persistFile,
        new Map([[811, persistedRow(811)]]),
        "queued-epoch-signature",
        undefined,
        persistenceScopes
      );
      expect(index.applyDiff([811], [{ label: 812, vector: replacement }])).toEqual({ removed: 1, added: 1 });
      await expect(save).rejects.toThrow(/changed before.*persistence snapshot/i);
      expect(openSpy, "rejected queued epoch must not reserve a generation file").not.toHaveBeenCalled();
      expect(renameSpy, "rejected queued epoch must not publish a generation or pointer").not.toHaveBeenCalled();
    } finally {
      openSpy.mockRestore();
      renameSpy.mockRestore();
    }
    expect(index.searchKnn(replacement, 1).labels).toEqual([812]);
    await expect(fs.access(`${persistFile}.meta.json`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a persisted generation with a stale embed signature", async () => {
    const persistFile = path.join(dir, "stale.hnsw");
    const v = new Float32Array(4).fill(0.5);
    let s = 0;
    for (const x of v) s += x * x;
    const norm = Math.sqrt(s);
    for (let i = 0; i < v.length; i++) v[i] = (v[i] ?? 0) / norm;

    const index = await buildHnsw([{ label: 0, vector: v }], { dim: 4, maxElements: 1 });
    await index.saveTo(persistFile, new Map([[0, persistedRow(0)]]), "old-signature");

    const loaded = await loadHnswFromDisk(persistFile, "new-signature", trustedHnswShape([0]));
    expect(loaded).toBeNull();
  });

  it.each(["digest-bound immutable binary"])("rejects a mixed HNSW generation via its %s", async () => {
    const persistFile = path.join(dir, "mixed.hnsw");
    const vectorA = l2(new Float32Array([0.5, 0.5, 0.5, 0.5]));
    const indexA = await buildHnsw([{ label: 0, vector: vectorA }], { dim: 4, maxElements: 1 });
    await indexA.saveTo(persistFile, new Map([[0, persistedRow(0)]]), "same-signature");
    const metaA = JSON.parse(await fs.readFile(`${persistFile}.meta.json`, "utf8")) as Record<string, unknown>;
    const generationA = path.join(dir, String(metaA.binFile));
    const generationABytes = await fs.readFile(generationA);

    // Publish a distinct graph generation under the same logical signature,
    // then reconstruct the crash/race shape "meta A + binary B" at A's valid
    // generation basename. Both native files are loadable and the signature is
    // equal, so only the exact binary digest can reject the mixed pair.
    const other = l2(new Float32Array([0.9, -0.1, 0.2, -0.4]));
    const otherIndex = await buildHnsw([{ label: 0, vector: other }], { dim: 4, maxElements: 1, seed: 909 });
    await otherIndex.saveTo(persistFile, new Map([[0, persistedRow(0)]]), "same-signature");
    const metaB = JSON.parse(await fs.readFile(`${persistFile}.meta.json`, "utf8")) as Record<string, unknown>;
    const generationB = path.join(dir, String(metaB.binFile));
    await fs.writeFile(generationA, await fs.readFile(generationB), { mode: 0o600 });
    await fs.writeFile(`${persistFile}.meta.json`, JSON.stringify(metaA), { mode: 0o600 });
    expect(await loadHnswFromDisk(persistFile, "same-signature", trustedHnswShape([0]))).toBeNull();

    // NEGATIVE setup control: A and B really are different native generations;
    // otherwise a digest equality would make the mixed fixture non-discriminating.
    expect(await fs.readFile(generationA)).not.toEqual(generationABytes);
  });

  it("binds every digest-valid native vector to the DB-canonical vector for its label", async () => {
    const persistFile = path.join(dir, "semantic-vector-authority.hnsw");
    const original = l2(new Float32Array([1, 2, 3, 4]));
    const index = await buildHnsw([{ label: 0, vector: original }], { dim: 4, maxElements: 1, seed: 515 });
    await index.saveTo(persistFile, new Map([[0, persistedRow(0)]]), "semantic-vector-signature");

    const alternate = l2(new Float32Array([4, -3, 2, -1]));
    // Negative control: the loader detaches authority before its first I/O
    // suspension, so caller mutation cannot steer later native preflight.
    const callerOwned = new Float32Array(original);
    const pendingExactLoad = loadHnswFromDisk(
      persistFile,
      "semantic-vector-signature",
      trustedHnswShape([0], 4, new Map([[0, callerOwned]]))
    );
    callerOwned.set(alternate);
    await expect(pendingExactLoad).resolves.not.toBeNull();

    // Causal mutant: keep geometry, label set, unit norm, signature, and a
    // freshly recomputed binary digest valid while replacing only vector bytes.
    await mutatePersistedNativeGeneration(persistFile, (bytes) => {
      const vectorOffset = Number(bytes.readBigUInt64LE(40));
      for (let component = 0; component < alternate.length; component += 1) {
        bytes.writeFloatLE(alternate[component] ?? 0, 96 + vectorOffset + component * 4);
      }
    });
    const authority = trustedHnswShape([0], 4, new Map([[0, original]]));
    await expect(loadHnswFromDisk(persistFile, "semantic-vector-signature", authority)).resolves.toBeNull();
  });

  it("rejects accumulated angular drift across a large dimension even when every component delta is tiny", async () => {
    const dim = 4096;
    const persistFile = path.join(dir, "semantic-vector-angular-drift.hnsw");
    const original = l2(new Float32Array(dim).fill(1));
    const index = await buildHnsw([{ label: 77, vector: original }], { dim, maxElements: 1, seed: 517 });
    await index.saveTo(persistFile, new Map([[77, persistedRow(77)]]), "angular-drift-signature");
    const authority = trustedHnswShape([77], dim, new Map([[77, original]]));
    await expect(loadHnswFromDisk(persistFile, "angular-drift-signature", authority)).resolves.not.toBeNull();

    await mutatePersistedNativeGeneration(persistFile, (bytes) => {
      const vectorOffset = Number(bytes.readBigUInt64LE(40));
      for (let component = 0; component < dim; component += 1) {
        const position = 96 + vectorOffset + component * 4;
        const tinyDelta = component % 2 === 0 ? 5e-7 : -5e-7;
        bytes.writeFloatLE(bytes.readFloatLE(position) + tinyDelta, position);
      }
    });
    await expect(loadHnswFromDisk(persistFile, "angular-drift-signature", authority)).resolves.toBeNull();
  });

  it("rejects an otherwise exact graph restored across a clear/recreate boundary by DB instance UUID", async () => {
    const dbFile = path.join(dir, "db-instance-causal.embed.db");
    const persistFile = path.join(dir, "db-instance-causal.hnsw");
    const exactVector = l2(new Float32Array([1, 2, 3, 4]));
    const dbA = new EmbedDb({ file: dbFile, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await dbA.open();
    dbA.upsertNote("note-1.md", 1000, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "label 1", vector: exactVector }
    ]);
    const snapshotA = dbA.captureHnswLoadSnapshot();
    const index = await buildHnsw(
      [...snapshotA.vectorsByLabel].map(([label, vector]) => ({ label, vector })),
      { dim: 4, maxElements: snapshotA.rowsByLabel.size, seed: 519 }
    );
    await index.saveTo(persistFile, snapshotA.rowsByLabel, snapshotA.receipt.signature, {
      dbInstanceUuid: snapshotA.receipt.dbInstanceUuid,
      dbMutationEpoch: snapshotA.receipt.dbMutationEpoch
    });
    const oldMeta = JSON.parse(await fs.readFile(`${persistFile}.meta.json`, "utf8")) as Record<string, unknown>;
    const oldGeneration = await fs.readFile(path.join(dir, String(oldMeta.binFile)));

    await dbA.clearOnDisk();
    const dbB = new EmbedDb({ file: dbFile, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await dbB.open();
    try {
      dbB.upsertNote("note-1.md", 1000, [
        { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "label 1", vector: exactVector }
      ]);
      const snapshotB = dbB.captureHnswLoadSnapshot();
      expect(snapshotB.receipt.dbInstanceUuid).not.toBe(snapshotA.receipt.dbInstanceUuid);
      expect(snapshotB.receipt.dbMutationEpoch).toBe(snapshotA.receipt.dbMutationEpoch);
      expect(snapshotB.receipt.liveLabelSha256).toBe(snapshotA.receipt.liveLabelSha256);
      expect(snapshotB.receipt.dbPayloadSha256).toBe(snapshotA.receipt.dbPayloadSha256);
      expect(snapshotB.rowsByLabel).toEqual(snapshotA.rowsByLabel);
      expect(snapshotB.vectorsByLabel).toEqual(snapshotA.vectorsByLabel);

      await fs.writeFile(path.join(dir, String(oldMeta.binFile)), oldGeneration, { mode: 0o600 });
      oldMeta.signature = snapshotB.receipt.signature;
      oldMeta.dbMutationEpoch = snapshotB.receipt.dbMutationEpoch;
      await fs.writeFile(`${persistFile}.meta.json`, JSON.stringify(oldMeta), { mode: 0o600 });
      const options = {
        expectedDim: snapshotB.receipt.dim,
        expectedRowsByLabel: snapshotB.rowsByLabel,
        expectedVectorsByLabel: snapshotB.vectorsByLabel,
        expectedDbInstanceUuid: snapshotB.receipt.dbInstanceUuid,
        expectedDbMutationEpoch: snapshotB.receipt.dbMutationEpoch
      };
      await expect(loadHnswFromDisk(persistFile, snapshotB.receipt.signature, options)).resolves.toBeNull();

      oldMeta.dbInstanceUuid = snapshotB.receipt.dbInstanceUuid;
      await fs.writeFile(`${persistFile}.meta.json`, JSON.stringify(oldMeta), { mode: 0o600 });
      await expect(loadHnswFromDisk(persistFile, snapshotB.receipt.signature, options)).resolves.not.toBeNull();
    } finally {
      await dbB.closeAndRelease();
    }
  });

  it("rejects an otherwise exact pointer after the DB mutation epoch advances", async () => {
    const dbFile = path.join(dir, "db-epoch-causal.embed.db");
    const persistFile = path.join(dir, "db-epoch-causal.hnsw");
    const db = new EmbedDb({ file: dbFile, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await db.open();
    try {
      db.upsertNote("note-1.md", 1000, [
        {
          chunkIndex: 0,
          lineStart: 1,
          lineEnd: 1,
          textPreview: "label 1",
          vector: l2(new Float32Array([1, 2, 3, 4]))
        }
      ]);
      const before = db.captureHnswLoadSnapshot();
      const index = await buildHnsw(
        [...before.vectorsByLabel].map(([label, vector]) => ({ label, vector })),
        { dim: 4, maxElements: before.rowsByLabel.size, seed: 521 }
      );
      await index.saveTo(persistFile, before.rowsByLabel, before.receipt.signature, {
        dbInstanceUuid: before.receipt.dbInstanceUuid,
        dbMutationEpoch: before.receipt.dbMutationEpoch
      });

      const Database = (await import("better-sqlite3")).default;
      const raw = new Database(dbFile);
      raw.prepare("UPDATE embeddings SET text_preview = text_preview WHERE id = 1").run();
      raw.close();
      const after = db.captureHnswLoadSnapshot();
      expect(after.receipt.dbInstanceUuid).toBe(before.receipt.dbInstanceUuid);
      expect(after.receipt.dbMutationEpoch).toBeGreaterThan(before.receipt.dbMutationEpoch);
      expect(after.receipt.liveLabelSha256).toBe(before.receipt.liveLabelSha256);
      expect(after.receipt.dbPayloadSha256).toBe(before.receipt.dbPayloadSha256);
      expect(after.rowsByLabel).toEqual(before.rowsByLabel);
      expect(after.vectorsByLabel).toEqual(before.vectorsByLabel);

      const metaFile = `${persistFile}.meta.json`;
      const meta = JSON.parse(await fs.readFile(metaFile, "utf8")) as Record<string, unknown>;
      meta.signature = after.receipt.signature;
      meta.dbInstanceUuid = after.receipt.dbInstanceUuid;
      await fs.writeFile(metaFile, JSON.stringify(meta), { mode: 0o600 });
      const options = {
        expectedDim: after.receipt.dim,
        expectedRowsByLabel: after.rowsByLabel,
        expectedVectorsByLabel: after.vectorsByLabel,
        expectedDbInstanceUuid: after.receipt.dbInstanceUuid,
        expectedDbMutationEpoch: after.receipt.dbMutationEpoch
      };
      await expect(loadHnswFromDisk(persistFile, after.receipt.signature, options)).resolves.toBeNull();

      meta.dbMutationEpoch = after.receipt.dbMutationEpoch;
      await fs.writeFile(metaFile, JSON.stringify(meta), { mode: 0o600 });
      await expect(loadHnswFromDisk(persistFile, after.receipt.signature, options)).resolves.not.toBeNull();
    } finally {
      await db.closeAndRelease();
    }
  });

  it.each(["two wrapped indexes"])("serializes concurrent %s publications under one publisher", async () => {
    const concurrentFile = path.join(dir, "concurrent.hnsw");
    const concurrentMetaFile = `${concurrentFile}.meta.json`;
    const persistenceScopes = await testSemanticScopes(concurrentFile);
    const vectorA = l2(new Float32Array([1, 0, 0, 0]));
    const vectorB = l2(new Float32Array([0, 1, 0, 0]));
    const indexA = await buildHnsw([{ label: 701, vector: vectorA }], { dim: 4, maxElements: 1, seed: 701 });
    const indexB = await buildHnsw([{ label: 702, vector: vectorB }], { dim: 4, maxElements: 1, seed: 702 });
    const row = (relPath: string) => ({
      rel_path: relPath,
      chunk_index: 0,
      line_start: 1,
      line_end: 1,
      text_preview: relPath,
      kind: "md" as const
    });
    const realRename = fs.rename.bind(fs);
    let releaseMetaA = (): void => {};
    let observeMetaA = (): void => {};
    const metaAGate = new Promise<void>((resolve) => {
      releaseMetaA = resolve;
    });
    const metaAObserved = new Promise<void>((resolve) => {
      observeMetaA = resolve;
    });
    let metaRenameCount = 0;
    const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (path.basename(String(to)) === path.basename(concurrentMetaFile)) {
        metaRenameCount += 1;
        if (metaRenameCount === 1) {
          observeMetaA();
          await metaAGate;
          await realRename(from, to);
          return;
        }
        await realRename(from, to);
        return;
      }
      await realRename(from, to);
    });
    try {
      const saveA = indexA.saveTo(
        concurrentFile,
        new Map([[701, row("A.md")]]),
        "concurrent-sig",
        undefined,
        persistenceScopes
      );
      await metaAObserved;
      await expect(
        indexB.saveTo(concurrentFile, new Map([[702, row("B.md")]]), "concurrent-sig", undefined, persistenceScopes)
      ).rejects.toBeInstanceOf(PersistenceLeaseConflictError);
      releaseMetaA();
      await saveA;
      await expect(
        indexB.saveTo(concurrentFile, new Map([[702, row("B.md")]]), "concurrent-sig", undefined, persistenceScopes)
      ).resolves.toBe(true);
    } finally {
      releaseMetaA();
      renameSpy.mockRestore();
    }
    expect(metaRenameCount).toBe(2);
    const concurrentLoaded = await loadHnswFromDisk(
      concurrentFile,
      "concurrent-sig",
      trustedHnswShape([702], 4, new Map([[702, vectorB]]))
    );
    expect(concurrentLoaded).not.toBeNull();
    if (!concurrentLoaded) throw new Error("concurrent HNSW generation was not loadable");
    expect([...concurrentLoaded.rowsByLabel.keys()]).toEqual([702]);
    expect(concurrentLoaded.index.searchKnn(vectorB, 1).labels).toEqual([702]);
  });

  it("blocks public HNSW cleanup and EmbedDb family clear until a late publisher releases", async () => {
    const dbFile = path.join(dir, "save-clear.embed.db");
    const persistFile = path.join(dir, "save-clear.hnsw");
    const db = new EmbedDb({ file: dbFile, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    await db.open();
    db.upsertNote("held.md", 1, [
      { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "held", vector: l2(new Float32Array([1, 0, 0, 0])) }
    ]);
    const snapshot = db.captureHnswBuildSnapshot();
    const persistenceScopes = db.getPersistenceFamilyScopes();
    await db.closeAndRelease();
    const index = await buildHnsw(
      snapshot.vectors.map(({ label, vector }) => ({ label, vector })),
      { dim: 4, maxElements: snapshot.vectors.length }
    );

    let releaseMeta = (): void => {};
    let observeMeta = (): void => {};
    const metaGate = new Promise<void>((resolve) => {
      releaseMeta = resolve;
    });
    const metaObserved = new Promise<void>((resolve) => {
      observeMeta = resolve;
    });
    const realRename = fs.rename.bind(fs);
    let blocked = false;
    const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (!blocked && path.basename(String(to)) === `${path.basename(persistFile)}.meta.json`) {
        blocked = true;
        observeMeta();
        await metaGate;
      }
      await realRename(from, to);
    });
    let save: Promise<boolean> | undefined;
    const clearer = new EmbedDb({ file: dbFile, vaultRoot: "/v", modelAlias: "multilingual", dim: 4 });
    try {
      save = index.saveTo(
        persistFile,
        snapshot.rowsByLabel,
        snapshot.receipt.signature,
        {
          dbInstanceUuid: snapshot.receipt.dbInstanceUuid,
          dbMutationEpoch: snapshot.receipt.dbMutationEpoch
        },
        persistenceScopes
      );
      await metaObserved;
      const beforeClear = new Map(
        await Promise.all(
          (await fs.readdir(dir))
            .filter((name) => name.startsWith("save-clear."))
            .map(async (name) => [name, await fs.readFile(path.join(dir, name))] as const)
        )
      );
      await expect(clearHnswPersistedArtifactsWithoutScopes(persistFile, persistenceScopes)).rejects.toBeInstanceOf(
        PersistenceLeaseConflictError
      );
      await expect(clearer.clearOnDisk()).rejects.toBeInstanceOf(PersistenceLeaseConflictError);
      const afterRefusal = new Map(
        await Promise.all(
          (await fs.readdir(dir))
            .filter((name) => name.startsWith("save-clear."))
            .map(async (name) => [name, await fs.readFile(path.join(dir, name))] as const)
        )
      );
      expect(afterRefusal).toEqual(beforeClear);
      releaseMeta();
      await expect(save).resolves.toBe(true);
    } finally {
      releaseMeta();
      renameSpy.mockRestore();
      await save?.catch(() => {});
    }

    await expect(clearer.clearOnDisk()).resolves.toBe(true);
    await expect(fs.lstat(dbFile)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fs.readdir(dir)).filter((name) => name.startsWith("save-clear.hnsw"))).toEqual([]);
  });

  it("returns null when meta file is missing", async () => {
    const loaded = await loadHnswFromDisk(path.join(dir, "nonexistent.hnsw"), "any-sig", trustedHnswShape([]));
    expect(loaded).toBeNull();
  });

  it("enforces the publisher byte cap on a small staged generation before rename", async () => {
    const finalPath = path.join(dir, "bounded-publisher.bin");
    await expect(publishSensitiveArtifact(finalPath, Buffer.from("four"), -1)).rejects.toThrow(RangeError);
    await expect(
      publishSensitiveArtifact(
        finalPath,
        async (stagedPath) => {
          await fs.writeFile(stagedPath, "four");
        },
        3
      )
    ).rejects.toThrow(/bounded publish limit/);
    await expect(fs.lstat(finalPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(publishSensitiveArtifact(finalPath, Buffer.from("four"), 4)).resolves.toMatchObject({
      sha256: createHash("sha256").update("four").digest("hex")
    });
    await expect(fs.readFile(finalPath, "utf8")).resolves.toBe("four");
  });

  it("rejects a held-descriptor parse whose generation changes before the parser returns", async () => {
    const file = path.join(dir, "changing-held-generation.bin");
    await fs.writeFile(file, "head", { mode: 0o600 });
    await expect(
      inspectSensitiveArtifact(file, 16, async (handle, size) => {
        const header = Buffer.alloc(4);
        expect(await handle.read(header, 0, header.length, 0)).toMatchObject({ bytesRead: 4 });
        expect(header.toString("utf8")).toBe("head");
        expect(size).toBe(4n);
        await fs.appendFile(file, "x");
        return header;
      })
    ).rejects.toThrow(/changed while being inspected/);
  });

  it("keeps the legacy two-argument call source-compatible and fails soft before disk/native work", async () => {
    const persistFile = path.join(dir, "missing-trusted-shape.hnsw");
    const lstatSpy = vi.spyOn(fs, "lstat");
    const openSpy = vi.spyOn(fs, "open");
    try {
      await expect(loadHnswFromDisk(persistFile, "trusted-signature")).resolves.toBeNull();
    } finally {
      lstatSpy.mockRestore();
      openSpy.mockRestore();
    }
    expect(lstatSpy).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();
  });

  it.each([
    { shape: "trusted row map is absent", options: { expectedDim: 4 } },
    { shape: "trusted model dimension is absent", options: { expectedRowsByLabel: new Map() } },
    {
      shape: "trusted vector map is absent",
      options: { expectedDim: 4, expectedRowsByLabel: new Map() }
    }
  ] as const)("fails soft before disk/native work when $shape", async ({ options }) => {
    const persistFile = path.join(dir, "missing-trusted-shape.hnsw");
    const lstatSpy = vi.spyOn(fs, "lstat");
    const openSpy = vi.spyOn(fs, "open");
    try {
      await expect(loadHnswFromDisk(persistFile, "trusted-signature", options as never)).resolves.toBeNull();
    } finally {
      lstatSpy.mockRestore();
      openSpy.mockRestore();
    }
    expect(lstatSpy).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();
  });

  it.each([
    { shape: "an array", expectedRowsByLabel: [] as unknown, error: /bounded readonly map/ },
    {
      shape: "a negative label",
      expectedRowsByLabel: new Map([[-1, persistedRow(0)]]),
      error: /invalid or duplicate row/
    },
    {
      shape: "a uint32-overflow label",
      expectedRowsByLabel: new Map([[2 ** 32, persistedRow(0)]]),
      error: /invalid or duplicate row/
    },
    {
      shape: "a non-finite label",
      expectedRowsByLabel: new Map([[Number.NaN, persistedRow(0)]]),
      error: /invalid or duplicate row/
    },
    {
      shape: "a malformed row",
      expectedRowsByLabel: new Map([[0, { rel_path: "partial.md" }]]),
      error: /invalid or duplicate row/
    },
    {
      shape: "a row with an extra own field",
      expectedRowsByLabel: new Map([[0, { ...persistedRow(0), extra: true }]]),
      error: /invalid or duplicate row/
    },
    {
      shape: "a malformed iterator entry",
      expectedRowsByLabel: {
        size: 1,
        *[Symbol.iterator]() {
          yield [0];
        }
      },
      error: /entries must be \[label, row\] pairs/
    },
    {
      shape: "an iterator exceeding its declared size",
      expectedRowsByLabel: {
        size: 1,
        *[Symbol.iterator]() {
          yield [0, persistedRow(0)];
          yield [1, persistedRow(1)];
        }
      },
      error: /iterator exceeds its declared size/
    },
    {
      shape: "an iterator shorter than its declared size",
      expectedRowsByLabel: {
        size: 2,
        *[Symbol.iterator]() {
          yield [0, persistedRow(0)];
        }
      },
      error: /iterator does not match its declared size/
    },
    {
      shape: "duplicate iterator labels",
      expectedRowsByLabel: {
        size: 2,
        *[Symbol.iterator]() {
          yield [0, persistedRow(0)];
          yield [0, persistedRow(0)];
        }
      },
      error: /invalid or duplicate row/
    },
    {
      shape: "a negative declared size",
      expectedRowsByLabel: { size: -1, *[Symbol.iterator]() {} },
      error: /bounded readonly map/
    },
    {
      shape: "a uint32-overflow declared size",
      expectedRowsByLabel: { size: 2 ** 32, *[Symbol.iterator]() {} },
      error: /bounded readonly map/
    }
  ])("rejects trusted row manifest with $shape before disk/native work", async ({ expectedRowsByLabel, error }) => {
    const persistFile = path.join(dir, "invalid-trusted-labels.hnsw");
    const lstatSpy = vi.spyOn(fs, "lstat");
    const openSpy = vi.spyOn(fs, "open");
    try {
      await expect(
        loadHnswFromDisk(persistFile, "trusted-signature", {
          expectedDim: 4,
          expectedRowsByLabel: expectedRowsByLabel as never,
          expectedVectorsByLabel: new Map()
        })
      ).rejects.toThrow(error);
    } finally {
      lstatSpy.mockRestore();
      openSpy.mockRestore();
    }
    expect(lstatSpy).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();
  });

  it.each([
    { shape: "an array", expectedVectorsByLabel: [] as unknown, error: /bounded readonly map/ },
    { shape: "a cardinality mismatch", expectedVectorsByLabel: new Map(), error: /identical cardinality/ },
    {
      shape: "a label outside the row authority",
      expectedVectorsByLabel: new Map([[1, l2(new Float32Array([1, 2, 3, 4]))]]),
      error: /invalid or duplicate vector/
    },
    {
      shape: "a wrong-dimensional vector",
      expectedVectorsByLabel: new Map([[0, l2(new Float32Array([1, 2, 3]))]]),
      error: /invalid or duplicate vector/
    },
    {
      shape: "a non-finite vector",
      expectedVectorsByLabel: new Map([[0, new Float32Array([1, 2, Number.NaN, 4])]]),
      error: /non-finite vector/
    },
    {
      shape: "a zero vector",
      expectedVectorsByLabel: new Map([[0, new Float32Array(4)]]),
      error: /zero or unbounded vector/
    },
    {
      shape: "an iterator exceeding its declared size",
      expectedVectorsByLabel: {
        size: 1,
        *[Symbol.iterator]() {
          yield [0, l2(new Float32Array([1, 2, 3, 4]))];
          yield [1, l2(new Float32Array([4, 3, 2, 1]))];
        }
      },
      error: /invalid or duplicate vector/
    },
    {
      shape: "an iterator shorter than its declared size",
      expectedVectorsByLabel: { size: 1, *[Symbol.iterator]() {} },
      error: /iterator does not match its declared size/
    }
  ])(
    "rejects trusted vector manifest with $shape before disk/native work",
    async ({ expectedVectorsByLabel, error }) => {
      const persistFile = path.join(dir, "invalid-trusted-vectors.hnsw");
      const lstatSpy = vi.spyOn(fs, "lstat");
      const openSpy = vi.spyOn(fs, "open");
      try {
        await expect(
          loadHnswFromDisk(persistFile, "trusted-signature", {
            expectedDim: 4,
            expectedRowsByLabel: new Map([[0, persistedRow(0)]]),
            expectedVectorsByLabel: expectedVectorsByLabel as never
          })
        ).rejects.toThrow(error);
      } finally {
        lstatSpy.mockRestore();
        openSpy.mockRestore();
      }
      expect(lstatSpy).not.toHaveBeenCalled();
      expect(openSpy).not.toHaveBeenCalled();
    }
  );

  it.each(["", undefined, null, 42] as const)(
    "rejects invalid runtime signature %j before disk/native work",
    async (signature) => {
      const persistFile = path.join(dir, "invalid-runtime-signature.hnsw");
      const lstatSpy = vi.spyOn(fs, "lstat");
      try {
        await expect(loadHnswFromDisk(persistFile, signature as never, trustedHnswShape([]))).rejects.toThrow(
          /expectedSignature must be a non-empty string/
        );
      } finally {
        lstatSpy.mockRestore();
      }
      expect(lstatSpy).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["truncated header", (_bytes: Buffer) => Buffer.alloc(95)],
    ["nonzero level-0 offset", (bytes: Buffer) => void bytes.writeBigUInt64LE(1n, 0)],
    ["zero capacity", (bytes: Buffer) => void bytes.writeBigUInt64LE(0n, 8)],
    ["capacity above trusted headroom", (bytes: Buffer) => void bytes.writeBigUInt64LE(1025n, 8)],
    ["current count unlike metadata", (bytes: Buffer) => void bytes.writeBigUInt64LE(2n, 16)],
    ["inconsistent element stride", (bytes: Buffer) => void bytes.writeBigUInt64LE(bytes.readBigUInt64LE(24) + 1n, 24)],
    ["inconsistent label offset", (bytes: Buffer) => void bytes.writeBigUInt64LE(bytes.readBigUInt64LE(32) + 1n, 32)],
    ["inconsistent vector offset", (bytes: Buffer) => void bytes.writeBigUInt64LE(bytes.readBigUInt64LE(40) + 1n, 40)],
    ["impractical maximum level", (bytes: Buffer) => void bytes.writeInt32LE(65, 48)],
    ["entrypoint outside current count", (bytes: Buffer) => void bytes.writeUInt32LE(1, 52)],
    ["maxM unlike M", (bytes: Buffer) => void bytes.writeBigUInt64LE(bytes.readBigUInt64LE(56) + 1n, 56)],
    ["maxM0 unlike twice M", (bytes: Buffer) => void bytes.writeBigUInt64LE(bytes.readBigUInt64LE(64) + 1n, 64)],
    ["impractical M", (bytes: Buffer) => void bytes.writeBigUInt64LE(1n, 72)],
    ["invalid level multiplier", (bytes: Buffer) => void bytes.writeDoubleLE(0, 80)],
    ["construction beam below M", (bytes: Buffer) => void bytes.writeBigUInt64LE(1n, 88)],
    [
      "misaligned upper-level block",
      (bytes: Buffer) => {
        const firstLevelBlock = 96 + Number(bytes.readBigUInt64LE(24));
        bytes.writeUInt32LE(1, firstLevelBlock);
      }
    ],
    ["trailing undeclared byte", (bytes: Buffer) => Buffer.concat([bytes, Buffer.from([0])])]
  ] as const)("rejects a digest-matched native generation with %s before optional import", async (shape, mutate) => {
    const persistFile = path.join(dir, `native-header-${shape.replaceAll(" ", "-")}.hnsw`);
    await persistMinimalGeneration(persistFile, "native-header-signature");
    await mutatePersistedNativeGeneration(persistFile, mutate);
    const meta = JSON.parse(await fs.readFile(`${persistFile}.meta.json`, "utf8")) as { binFile: string };
    const generationFile = path.join(dir, meta.binFile);
    let importCalls = 0;
    let generationOpenCalls = 0;
    const realOpen = fs.open.bind(fs);
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (candidate, ...args) => {
      if (String(candidate) === generationFile) generationOpenCalls += 1;
      return realOpen(candidate, ...args);
    });
    vi.resetModules();
    vi.doMock("../src/optional-dep.js", () => ({
      importOptionalDependency: async () => {
        importCalls += 1;
        throw new Error("native import must remain unreachable");
      },
      optionalDepDetail: () => "error code: unreachable"
    }));
    try {
      const isolated = await import("../src/hnsw.js");
      await expect(
        isolated.loadHnswFromDisk(persistFile, "native-header-signature", trustedHnswShape([0]))
      ).resolves.toBeNull();
    } finally {
      vi.doUnmock("../src/optional-dep.js");
      vi.resetModules();
      openSpy.mockRestore();
    }
    expect(generationOpenCalls, "preflight rejection must happen before a second full-file digest open").toBe(1);
    expect(importCalls).toBe(0);
  });

  it("binds the parsed held descriptor to the path digest before optional import", async () => {
    const persistFile = path.join(dir, "native-preflight-generation-swap.hnsw");
    const meta = await persistMinimalGeneration(persistFile, "generation-swap-signature");
    const metaFile = `${persistFile}.meta.json`;
    const generationFile = path.join(dir, String(meta.binFile));
    const replacementFile = path.join(dir, "unpreflighted-native-replacement.bin");
    const replacement = Buffer.from(await fs.readFile(generationFile));
    replacement.writeUInt32LE((replacement.readUInt32LE(96) | 0x0002_0000) >>> 0, 96);
    await fs.writeFile(replacementFile, replacement, { mode: 0o600 });
    meta.binSha256 = createHash("sha256").update(replacement).digest("hex");
    await fs.writeFile(metaFile, JSON.stringify(meta), { mode: 0o600 });

    let importCalls = 0;
    let generationLstatCalls = 0;
    let swapped = false;
    const realLstat = fs.lstat.bind(fs);
    const lstatSpy = vi.spyOn(fs, "lstat").mockImplementation(async (candidate, ...args) => {
      if (String(candidate) === generationFile) {
        generationLstatCalls += 1;
        if (generationLstatCalls === 2) {
          await fs.rename(replacementFile, generationFile);
          swapped = true;
        }
      }
      return realLstat(candidate, ...args);
    });
    vi.resetModules();
    vi.doMock("../src/optional-dep.js", () => ({
      importOptionalDependency: async () => {
        importCalls += 1;
        throw new Error("native import must remain unreachable");
      },
      optionalDepDetail: () => "error code: unreachable"
    }));
    try {
      const isolated = await import("../src/hnsw.js");
      await expect(
        isolated.loadHnswFromDisk(persistFile, "generation-swap-signature", trustedHnswShape([0]))
      ).resolves.toBeNull();
    } finally {
      vi.doUnmock("../src/optional-dep.js");
      vi.resetModules();
      lstatSpy.mockRestore();
    }
    expect(swapped).toBe(true);
    expect(generationLstatCalls).toBe(2);
    expect(importCalls).toBe(0);
  });

  it("loads native code only from the admitted private snapshot across a public-path A-to-B-to-A swap", async () => {
    const persistFile = path.join(dir, "native-private-snapshot.hnsw");
    const meta = await persistMinimalGeneration(persistFile, "private-snapshot-signature");
    const generationFile = path.join(dir, String(meta.binFile));
    const parkedOriginal = path.join(dir, "parked-original-generation.bin");
    const replacementFile = path.join(dir, "replacement-generation.bin");
    const originalBytes = Buffer.from(await fs.readFile(generationFile));
    const replacementBytes = Buffer.from(originalBytes);
    replacementBytes[96] = (replacementBytes[96] ?? 0) ^ 0xff;
    await fs.writeFile(replacementFile, replacementBytes, { mode: 0o600 });

    let swapped = false;
    let restored = false;
    let nativeReadPath = "";
    let nativeReadBytes: Buffer | null = null;
    let publicBytesDuringNativeRead: Buffer | null = null;
    vi.resetModules();
    vi.doMock("../src/optional-dep.js", () => ({
      importOptionalDependency: async () => {
        await fs.rename(generationFile, parkedOriginal);
        await fs.rename(replacementFile, generationFile);
        swapped = true;
        return {
          HierarchicalNSW: class {
            async readIndex(candidate: string): Promise<boolean> {
              nativeReadPath = candidate;
              nativeReadBytes = Buffer.from(await fs.readFile(candidate));
              publicBytesDuringNativeRead = Buffer.from(await fs.readFile(generationFile));
              await fs.rename(generationFile, replacementFile);
              await fs.rename(parkedOriginal, generationFile);
              restored = true;
              return true;
            }
            getCurrentCount(): number {
              return 1;
            }
            getMaxElements(): number {
              return 1;
            }
          }
        };
      },
      optionalDepDetail: () => "error code: synthetic"
    }));
    let loaded: Awaited<ReturnType<typeof loadHnswFromDisk>> = null;
    try {
      const isolated = await import("../src/hnsw.js");
      loaded = await isolated.loadHnswFromDisk(persistFile, "private-snapshot-signature", trustedHnswShape([0]));
    } finally {
      if (swapped && !restored) {
        await fs.rename(generationFile, replacementFile).catch(() => {});
        await fs.rename(parkedOriginal, generationFile).catch(() => {});
      }
      vi.doUnmock("../src/optional-dep.js");
      vi.resetModules();
    }
    expect(swapped).toBe(true);
    expect(restored).toBe(true);
    expect(loaded).not.toBeNull();
    expect(nativeReadPath).not.toBe(generationFile);
    expect(path.basename(nativeReadPath)).toBe("artifact");
    expect(nativeReadBytes).toEqual(originalBytes);
    expect(publicBytesDuringNativeRead).toEqual(replacementBytes);
    expect(nativeReadBytes).not.toEqual(publicBytesDuringNativeRead);
    expect(
      (await fs.readdir(dir)).filter((entry) => entry.startsWith(`${path.basename(generationFile)}.enquire-stage-`))
    ).toEqual([]);
  });

  it("removes the private snapshot when the inspector's post-callback receipt rejects a source mutation", async () => {
    const persistFile = path.join(dir, "native-post-inspector-mutation.hnsw");
    const meta = await persistMinimalGeneration(persistFile, "post-inspector-mutation-signature");
    const generationFile = path.join(dir, String(meta.binFile));
    const stagePrefix = `${path.basename(generationFile)}.enquire-stage-`;
    const realOpen = fs.open.bind(fs);
    let mutatedAfterSnapshotClose = false;
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (candidate, ...args) => {
      const handle = await realOpen(candidate, ...args);
      if (String(candidate).includes(stagePrefix) && path.basename(String(candidate)) === "artifact") {
        const realClose = handle.close.bind(handle);
        Object.defineProperty(handle, "close", {
          configurable: true,
          value: async () => {
            await realClose();
            if (!mutatedAfterSnapshotClose) {
              mutatedAfterSnapshotClose = true;
              await fs.appendFile(generationFile, Buffer.from([0]));
            }
          }
        });
      }
      return handle;
    });
    try {
      await expect(
        loadHnswFromDisk(persistFile, "post-inspector-mutation-signature", trustedHnswShape([0]))
      ).resolves.toBeNull();
    } finally {
      openSpy.mockRestore();
    }
    expect(mutatedAfterSnapshotClose).toBe(true);
    expect((await fs.readdir(dir)).filter((entry) => entry.startsWith(stagePrefix))).toEqual([]);
  });

  it.each([
    [
      "level-0 neighbor count above maxM0",
      (bytes: Buffer) => {
        const count = Number(bytes.readBigUInt64LE(64)) + 1;
        const state = ((bytes.readUInt32LE(96) & 0xffff_0000) | count) >>> 0;
        bytes.writeUInt32LE(state, 96);
      }
    ],
    [
      "level-0 reserved flag",
      (bytes: Buffer) => void bytes.writeUInt32LE((bytes.readUInt32LE(96) | 0x0002_0000) >>> 0, 96)
    ],
    [
      "out-of-range level-0 neighbor",
      (bytes: Buffer) => {
        const state = ((bytes.readUInt32LE(96) & 0xffff_0000) | 1) >>> 0;
        bytes.writeUInt32LE(state, 96);
        bytes.writeUInt32LE(1, 100);
      }
    ],
    [
      "deletion bit unlike trusted live manifest",
      (bytes: Buffer) => void bytes.writeUInt32LE((bytes.readUInt32LE(96) | 0x0001_0000) >>> 0, 96)
    ],
    [
      "external label above uint32",
      (bytes: Buffer) => {
        const labelOffset = Number(bytes.readBigUInt64LE(32));
        bytes.writeBigUInt64LE(0x1_0000_0000n, 96 + labelOffset);
      }
    ],
    [
      "safe external label unlike trusted live manifest",
      (bytes: Buffer) => {
        const labelOffset = Number(bytes.readBigUInt64LE(32));
        bytes.writeBigUInt64LE(2n, 96 + labelOffset);
      }
    ],
    [
      "non-finite float32 vector component",
      (bytes: Buffer) => {
        const vectorOffset = Number(bytes.readBigUInt64LE(40));
        bytes.writeFloatLE(Number.NaN, 96 + vectorOffset);
      }
    ],
    [
      "finite but unbounded float32 vector norm",
      (bytes: Buffer) => {
        const vectorOffset = Number(bytes.readBigUInt64LE(40));
        bytes.writeFloatLE(3.4e38, 96 + vectorOffset);
      }
    ],
    [
      "finite non-unit cosine vector",
      (bytes: Buffer) => {
        const vectorOffset = Number(bytes.readBigUInt64LE(40));
        for (let component = 0; component < 4; component += 1) bytes.writeFloatLE(0, 96 + vectorOffset + component * 4);
        bytes.writeFloatLE(2, 96 + vectorOffset);
      }
    ],
    [
      "upper-level neighbor count above maxM",
      (bytes: Buffer) =>
        withSingleUpperLevel(bytes, (result, upperOffset) => {
          result.writeUInt32LE(Number(result.readBigUInt64LE(56)) + 1, upperOffset);
        })
    ],
    [
      "upper-level deletion flag",
      (bytes: Buffer) =>
        withSingleUpperLevel(bytes, (result, upperOffset) => {
          result.writeUInt32LE(0x0001_0000, upperOffset);
        })
    ],
    [
      "out-of-range upper-level neighbor",
      (bytes: Buffer) =>
        withSingleUpperLevel(bytes, (result, upperOffset) => {
          result.writeUInt32LE(1, upperOffset);
          result.writeUInt32LE(1, upperOffset + 4);
        })
    ]
  ] as const)("rejects digest-matched native payload with %s before hash/import", async (shape, mutate) => {
    const persistFile = path.join(dir, `native-payload-${shape.replaceAll(" ", "-")}.hnsw`);
    await persistMinimalGeneration(persistFile, "native-payload-signature");
    await mutatePersistedNativeGeneration(persistFile, mutate);
    const meta = JSON.parse(await fs.readFile(`${persistFile}.meta.json`, "utf8")) as { binFile: string };
    const generationFile = path.join(dir, meta.binFile);
    let importCalls = 0;
    let generationOpenCalls = 0;
    const realOpen = fs.open.bind(fs);
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (candidate, ...args) => {
      if (String(candidate) === generationFile) generationOpenCalls += 1;
      return realOpen(candidate, ...args);
    });
    vi.resetModules();
    vi.doMock("../src/optional-dep.js", () => ({
      importOptionalDependency: async () => {
        importCalls += 1;
        throw new Error("native import must remain unreachable");
      },
      optionalDepDetail: () => "error code: unreachable"
    }));
    try {
      const isolated = await import("../src/hnsw.js");
      await expect(
        isolated.loadHnswFromDisk(persistFile, "native-payload-signature", trustedHnswShape([0]))
      ).resolves.toBeNull();
    } finally {
      vi.doUnmock("../src/optional-dep.js");
      vi.resetModules();
      openSpy.mockRestore();
    }
    expect(generationOpenCalls, "payload rejection must happen before a second full-file digest open").toBe(1);
    expect(importCalls).toBe(0);
  });

  it.each([
    {
      shape: "an upper-level edge whose target has no matching level",
      mutate: (bytes: Buffer) =>
        withUpperLevelLayout(bytes, [1, 0], 0, (result, offsets) => {
          const upper = offsets[0]?.[0];
          if (upper === undefined) throw new Error("expected upper-level fixture record");
          result.writeUInt32LE(1, upper);
          result.writeUInt32LE(1, upper + 4);
        })
    },
    {
      shape: "an entrypoint below the declared maximum level",
      mutate: (bytes: Buffer) => withUpperLevelLayout(bytes, [1, 0], 1, () => {})
    }
  ])("rejects $shape before native import", async ({ shape, mutate }) => {
    const persistFile = path.join(dir, `native-level-relationship-${shape.replaceAll(" ", "-")}.hnsw`);
    const vectors = [
      { label: 0, vector: l2(new Float32Array([1, 2, 3, 4])) },
      { label: 1, vector: l2(new Float32Array([4, 3, 2, 1])) }
    ];
    const index = await buildHnsw(vectors, { dim: 4, maxElements: 2, seed: 419 });
    await index.saveTo(
      persistFile,
      new Map([
        [0, persistedRow(0)],
        [1, persistedRow(1)]
      ]),
      "level-relationship-signature"
    );
    await mutatePersistedNativeGeneration(persistFile, mutate);
    let importCalls = 0;
    vi.resetModules();
    vi.doMock("../src/optional-dep.js", () => ({
      importOptionalDependency: async () => {
        importCalls += 1;
        throw new Error("native import must remain unreachable");
      },
      optionalDepDetail: () => "error code: unreachable"
    }));
    try {
      const isolated = await import("../src/hnsw.js");
      await expect(
        isolated.loadHnswFromDisk(persistFile, "level-relationship-signature", trustedHnswShape([0, 1]))
      ).resolves.toBeNull();
    } finally {
      vi.doUnmock("../src/optional-dep.js");
      vi.resetModules();
    }
    expect(importCalls).toBe(0);
  });

  it("rejects duplicate external labels before full hash or native import", async () => {
    const persistFile = path.join(dir, "native-payload-duplicate-labels.hnsw");
    const vectors = [
      { label: 0, vector: l2(new Float32Array([1, 2, 3, 4])) },
      { label: 1, vector: l2(new Float32Array([4, 3, 2, 1])) }
    ];
    const index = await buildHnsw(vectors, { dim: 4, maxElements: 2, seed: 405 });
    await index.saveTo(
      persistFile,
      new Map([
        [0, persistedRow(0)],
        [1, persistedRow(1)]
      ]),
      "duplicate-label-signature"
    );
    await mutatePersistedNativeGeneration(persistFile, (bytes) => {
      const sizeDataPerElement = Number(bytes.readBigUInt64LE(24));
      const labelOffset = Number(bytes.readBigUInt64LE(32));
      bytes.writeBigUInt64LE(0n, 96 + sizeDataPerElement + labelOffset);
    });
    const meta = JSON.parse(await fs.readFile(`${persistFile}.meta.json`, "utf8")) as { binFile: string };
    const generationFile = path.join(dir, meta.binFile);
    let importCalls = 0;
    let generationOpenCalls = 0;
    const realOpen = fs.open.bind(fs);
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (candidate, ...args) => {
      if (String(candidate) === generationFile) generationOpenCalls += 1;
      return realOpen(candidate, ...args);
    });
    vi.resetModules();
    vi.doMock("../src/optional-dep.js", () => ({
      importOptionalDependency: async () => {
        importCalls += 1;
        throw new Error("native import must remain unreachable");
      },
      optionalDepDetail: () => "error code: unreachable"
    }));
    try {
      const isolated = await import("../src/hnsw.js");
      await expect(
        isolated.loadHnswFromDisk(persistFile, "duplicate-label-signature", trustedHnswShape([0, 1]))
      ).resolves.toBeNull();
    } finally {
      vi.doUnmock("../src/optional-dep.js");
      vi.resetModules();
      openSpy.mockRestore();
    }
    expect(generationOpenCalls).toBe(1);
    expect(importCalls).toBe(0);
  });

  it("rejects a declared graph above the practical native allocation envelope before optional import", async () => {
    let importCalls = 0;
    vi.resetModules();
    vi.doMock("../src/optional-dep.js", () => ({
      importOptionalDependency: async () => {
        importCalls += 1;
        throw new Error("native import must remain unreachable");
      },
      optionalDepDetail: () => "error code: unreachable"
    }));
    try {
      const isolated = await import("../src/hnsw.js");
      await expect(isolated.buildHnsw([], { dim: 65_536, maxElements: 4000, m: 10_000 })).rejects.toThrow(
        /practical .*native allocation envelope/
      );
    } finally {
      vi.doUnmock("../src/optional-dep.js");
      vi.resetModules();
    }
    expect(importCalls).toBe(0);
  });

  it("rejects tombstone persistence and refuses zero-valued trusted DB authority", async () => {
    const deletedFile = path.join(dir, "native-deleted-slot.hnsw");
    const deletedVector = l2(new Float32Array([1, 2, 3, 4]));
    const deletedIndex = await buildHnsw([{ label: 17, vector: deletedVector }], {
      dim: 4,
      maxElements: 1,
      seed: 417
    });
    expect(deletedIndex.applyDiff([17], [])).toEqual({ removed: 1, added: 0 });
    await expect(deletedIndex.saveTo(deletedFile, new Map(), "deleted-slot-signature")).rejects.toThrow(
      /deleted native slots require a compact rebuild/
    );
    await expect(fs.lstat(`${deletedFile}.meta.json`)).rejects.toMatchObject({ code: "ENOENT" });
    expect(deletedIndex.searchKnn(deletedVector, 1).labels).toEqual([]);

    const zeroFile = path.join(dir, "native-zero-vector.hnsw");
    const zeroVector = new Float32Array(4);
    const zeroIndex = await buildHnsw([{ label: 18, vector: zeroVector }], { dim: 4, maxElements: 1, seed: 418 });
    await zeroIndex.saveTo(zeroFile, new Map([[18, persistedRow(18)]]), "zero-vector-signature");
    expect(zeroIndex.searchKnn(zeroVector, 1).labels).toEqual([18]);
    await expect(
      loadHnswFromDisk(zeroFile, "zero-vector-signature", trustedHnswShape([18], 4, new Map([[18, zeroVector]])))
    ).rejects.toThrow(/zero or unbounded vector/);
  });

  it.each([
    "resolved false",
    "read threw",
    "constructor threw",
    "native count mismatch",
    "native capacity differs from header",
    "native capacity below count"
  ] as const)("returns null when native %s", async (outcome) => {
    const persistFile = path.join(dir, `read-index-${outcome.replace(" ", "-")}.hnsw`);
    let trustedVectors: Map<number, Float32Array> | undefined;
    if (outcome === "native capacity below count") {
      const vectors = [
        { label: 0, vector: l2(new Float32Array([1, 2, 3, 4])) },
        { label: 1, vector: l2(new Float32Array([4, 3, 2, 1])) }
      ];
      trustedVectors = new Map(vectors.map(({ label, vector }) => [label, vector]));
      const index = await buildHnsw(vectors, { dim: 4, maxElements: 2, seed: 404 });
      await index.saveTo(
        persistFile,
        new Map([
          [0, persistedRow(0)],
          [1, persistedRow(1)]
        ]),
        "native-read-signature"
      );
    } else {
      await persistMinimalGeneration(persistFile, "native-read-signature");
    }
    let readCalls = 0;
    const replaceDeletedArguments: Array<boolean | undefined> = [];
    let constructorCalls = 0;
    vi.resetModules();
    vi.doMock("../src/optional-dep.js", () => ({
      importOptionalDependency: async (specifier: string) => {
        if (specifier !== "hnswlib-node") throw new Error(`unexpected optional dependency ${specifier}`);
        return {
          HierarchicalNSW: class {
            constructor() {
              constructorCalls += 1;
              if (outcome === "constructor threw") throw new Error("synthetic native constructor failure");
            }
            async readIndex(_filename: string, allowReplaceDeleted?: boolean): Promise<boolean> {
              readCalls += 1;
              replaceDeletedArguments.push(allowReplaceDeleted);
              if (outcome === "read threw") throw new Error("synthetic native read failure");
              return outcome !== "resolved false";
            }
            getCurrentCount(): number {
              return outcome === "native count mismatch" || outcome === "native capacity below count" ? 2 : 1;
            }
            getMaxElements(): number {
              return outcome === "native capacity differs from header" ? 2 : 1;
            }
          }
        };
      },
      optionalDepDetail: () => "error code: synthetic"
    }));
    try {
      const isolated = await import("../src/hnsw.js");
      await expect(
        isolated.loadHnswFromDisk(
          persistFile,
          "native-read-signature",
          trustedHnswShape(outcome === "native capacity below count" ? [0, 1] : [0], 4, trustedVectors)
        )
      ).resolves.toBeNull();
    } finally {
      vi.doUnmock("../src/optional-dep.js");
      vi.resetModules();
    }
    expect(constructorCalls).toBe(1);
    expect(readCalls).toBe(outcome === "constructor threw" ? 0 : 1);
    expect(replaceDeletedArguments).toEqual(outcome === "constructor threw" ? [] : [true]);
  });

  it("returns null when meta JSON is malformed", async () => {
    const persistFile = path.join(dir, "malformed.hnsw");
    await fs.writeFile(`${persistFile}.bin`, "ignored");
    await fs.writeFile(`${persistFile}.meta.json`, "{not valid json");
    const loaded = await loadHnswFromDisk(persistFile, "any-sig", trustedHnswShape([]));
    expect(loaded).toBeNull();
  });

  it.each([
    ["null", "null"],
    ["number", "42"],
    ["string", '"metadata"'],
    ["array", "[]"],
    ["empty object", "{}"]
  ] as const)("returns null for valid JSON %s metadata", async (name, json) => {
    const persistFile = path.join(dir, `valid-json-${name.replace(" ", "-")}.hnsw`);
    await fs.writeFile(`${persistFile}.meta.json`, json);
    await expect(loadHnswFromDisk(persistFile, "any-sig", trustedHnswShape([]))).resolves.toBeNull();
  });

  it.each([
    [
      "missing-bin-file",
      (meta: Record<string, unknown>) => {
        delete meta.binFile;
      }
    ],
    [
      "non-string-bin-file",
      (meta: Record<string, unknown>) => {
        meta.binFile = 42;
      }
    ],
    [
      "missing-bin-sha",
      (meta: Record<string, unknown>) => {
        delete meta.binSha256;
      }
    ],
    [
      "non-string-bin-sha",
      (meta: Record<string, unknown>) => {
        meta.binSha256 = 42;
      }
    ],
    [
      "bin-sha-trailing-LF",
      (meta: Record<string, unknown>) => {
        meta.binSha256 = `${String(meta.binSha256)}\n`;
      }
    ],
    [
      "bin-sha-trailing-U+2028",
      (meta: Record<string, unknown>) => {
        meta.binSha256 = `${String(meta.binSha256)}\u2028`;
      }
    ]
  ] as const)("returns null when format-4 metadata has %s", async (name, mutate) => {
    const malformedBase = path.join(dir, `${name}.hnsw`);
    const meta = await persistMinimalGeneration(malformedBase, "format-4-signature");
    mutate(meta);
    await fs.writeFile(`${malformedBase}.meta.json`, JSON.stringify(meta));
    expect(await loadHnswFromDisk(malformedBase, "format-4-signature", trustedHnswShape([0]))).toBeNull();
  });

  it("returns null when meta exists but bin file missing", async () => {
    const persistFile = path.join(dir, "no-bin.hnsw");
    const meta = await persistMinimalGeneration(persistFile, "match");
    await fs.unlink(path.join(dir, String(meta.binFile)));
    const loaded = await loadHnswFromDisk(persistFile, "match", trustedHnswShape([0]));
    expect(loaded).toBeNull();
  });

  // Compact format-4 metadata retains graph-shape plus EmbedDb generation fields;
  // row paths/previews are admitted independently from the trusted EmbedDb map.
  it.each([
    {
      shape: "negative dim",
      mutate: (meta: Record<string, unknown>) => (meta.dim = -1),
      options: trustedHnswShape([0])
    },
    {
      shape: "native uint32-overflow dim",
      mutate: (meta: Record<string, unknown>) => (meta.dim = 2 ** 32),
      options: trustedHnswShape([0])
    },
    {
      shape: "unsafe-integer dim",
      mutate: (meta: Record<string, unknown>) => (meta.dim = Number.MAX_SAFE_INTEGER + 1),
      options: trustedHnswShape([0])
    },
    {
      shape: "native uint32-overflow size",
      mutate: (meta: Record<string, unknown>) => (meta.size = 2 ** 32),
      options: trustedHnswShape([0])
    },
    {
      shape: "native count mismatch",
      mutate: (meta: Record<string, unknown>) => (meta.size = 2),
      options: trustedHnswShape([0])
    },
    {
      shape: "trusted model-dimension mismatch",
      mutate: (_meta: Record<string, unknown>) => {},
      options: trustedHnswShape([0], 8)
    },
    {
      shape: "trusted active-row mismatch",
      mutate: (_meta: Record<string, unknown>) => {},
      options: trustedHnswShape([0, 1])
    }
  ] as const)("returns null when metadata has $shape", async ({ shape, mutate, options }) => {
    const persistFile = path.join(dir, `bad-shape-${shape.replaceAll(" ", "-")}.hnsw`);
    const meta = await persistMinimalGeneration(persistFile, "match");
    mutate(meta);
    await fs.writeFile(`${persistFile}.meta.json`, JSON.stringify(meta));
    await expect(loadHnswFromDisk(persistFile, "match", options)).resolves.toBeNull();
  });

  it("rejects a trusted active-row mismatch before hashing or opening the native generation", async () => {
    const persistFile = path.join(dir, "trusted-row-mismatch-before-bin.hnsw");
    const meta = await persistMinimalGeneration(persistFile, "match");
    const binFile = path.join(dir, String(meta.binFile));
    const realOpen = fs.open.bind(fs);
    let binOpenCalls = 0;
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (candidate, ...args) => {
      if (String(candidate) === binFile) binOpenCalls += 1;
      return realOpen(candidate, ...args);
    });
    try {
      await expect(loadHnswFromDisk(persistFile, "match", trustedHnswShape([0, 1]))).resolves.toBeNull();
    } finally {
      openSpy.mockRestore();
    }
    expect(binOpenCalls).toBe(0);
  });

  it("rejects a same-size trusted label mismatch during one bounded native preflight", async () => {
    const persistFile = path.join(dir, "trusted-label-mismatch-before-bin.hnsw");
    const meta = await persistMinimalGeneration(persistFile, "match");
    const binFile = path.join(dir, String(meta.binFile));
    const realOpen = fs.open.bind(fs);
    let binOpenCalls = 0;
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (candidate, ...args) => {
      if (String(candidate) === binFile) binOpenCalls += 1;
      return realOpen(candidate, ...args);
    });
    try {
      await expect(loadHnswFromDisk(persistFile, "match", trustedHnswShape([1]))).resolves.toBeNull();
    } finally {
      openSpy.mockRestore();
    }
    expect(binOpenCalls).toBe(1);
  });

  it.each([0, 2 ** 32] as const)("rejects an unsafe trusted expectedDim=%i before disk I/O", async (expectedDim) => {
    const missing = path.join(dir, `invalid-expected-dim-${expectedDim}.hnsw`);
    await expect(loadHnswFromDisk(missing, "match", { expectedDim, expectedRowsByLabel: new Map() })).rejects.toThrow(
      /expectedDim must be a safe integer/
    );
    await expect(fs.lstat(`${missing}.meta.json`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns null on formatVersion mismatch (future-proof)", async () => {
    const legacyFile = path.join(dir, "legacy-v1.hnsw");
    await fs.writeFile(`${legacyFile}.meta.json`, JSON.stringify(PUBLIC_META_V1_FIXTURE));
    await fs.writeFile(`${legacyFile}.bin`, "legacy-binary");
    expect(await loadHnswFromDisk(legacyFile, "legacy-signature", trustedHnswShape([]))).toBeNull();
  });

  it.each([99])("returns null on future formatVersion %i", async (formatVersion) => {
    const persistFile = path.join(dir, "future.hnsw");
    const meta = await persistMinimalGeneration(persistFile, "match");
    meta.formatVersion = formatVersion;
    await fs.writeFile(`${persistFile}.meta.json`, JSON.stringify(meta));
    const loaded = await loadHnswFromDisk(persistFile, "match", trustedHnswShape([0]));
    expect(loaded).toBeNull();
  });

  // v3.6.2 audit M-7 — both the immutable binary generation and .meta.json
  // pointer MUST be mode 0600. The binary carries vector-derived private data,
  // so the per-file invariant must hold independently of an existing/custom
  // parent directory's operator-managed mode.
  it("saveTo modes both the immutable generation and meta pointer 0o600 (audit M-7)", async () => {
    if (process.platform === "win32") return; // POSIX mode bits don't apply on NTFS
    const dim = 4;
    const v = new Float32Array(dim).fill(0.5);
    let s = 0;
    for (const x of v) s += x * x;
    const norm = Math.sqrt(s);
    for (let i = 0; i < v.length; i++) v[i] = (v[i] ?? 0) / norm;
    const index = await buildHnsw([{ label: 0, vector: v }], { dim, maxElements: 1 });

    const freshParent = path.join(dir, "chmod-check-parent");
    const persistFile = path.join(freshParent, "chmod-check.hnsw");
    const exactRows = new Map([[0, persistedRow(0)]]);
    const ok = await index.saveTo(persistFile, exactRows, "chmod-sig");
    expect(ok).toBe(true);

    expect((await fs.stat(freshParent)).mode & 0o077).toBe(0); // 0700 request may be tightened by umask
    const meta = JSON.parse(await fs.readFile(`${persistFile}.meta.json`, "utf8")) as { binFile: string };
    const binStat = await fs.stat(path.join(freshParent, meta.binFile));
    const metaStat = await fs.stat(`${persistFile}.meta.json`);
    expect(binStat.mode & 0o777).toBe(0o600);
    expect(metaStat.mode & 0o777).toBe(0o600);

    const existingParent = path.join(dir, "operator-managed-hnsw-parent");
    await fs.mkdir(existingParent, { mode: 0o750 });
    await fs.chmod(existingParent, 0o750);
    const existingParentFile = path.join(existingParent, "preserve-parent.hnsw");
    expect(await index.saveTo(existingParentFile, exactRows, "parent-mode-sig")).toBe(true);
    expect((await fs.stat(existingParent)).mode & 0o777).toBe(0o750);
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
      const signaturePattern =
        /^instance=([0-9a-f]{32});epoch=([1-9][0-9]*);dim=4;rows=([0-9]+);maxId=([0-9]+);model=multilingual;quant=f32;embedSchema=5;labels=[0-9a-f]{64};payload=[0-9a-f]{64}$/;
      const sigEmpty = db.computeSignature();
      const emptyMatch = signaturePattern.exec(sigEmpty);
      expect(emptyMatch?.slice(3)).toEqual(["0", "0"]);

      db.upsertNote("a.md", 1, [
        { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "x", vector: l2(new Float32Array([1, 0, 0, 0])) }
      ]);
      const sig1 = db.computeSignature();
      const firstMatch = signaturePattern.exec(sig1);
      expect(firstMatch?.slice(3)).toEqual(["1", "1"]);
      expect(firstMatch?.[1]).toBe(emptyMatch?.[1]);
      expect(Number(firstMatch?.[2])).toBeGreaterThan(Number(emptyMatch?.[2]));
      expect(sig1).not.toBe(sigEmpty);

      db.upsertNote("b.md", 2, [
        { chunkIndex: 0, lineStart: 1, lineEnd: 1, textPreview: "y", vector: l2(new Float32Array([0, 1, 0, 0])) }
      ]);
      const sig2 = db.computeSignature();
      const secondMatch = signaturePattern.exec(sig2);
      expect(secondMatch?.slice(3)).toEqual(["2", "2"]);
      expect(secondMatch?.[1]).toBe(emptyMatch?.[1]);
      expect(Number(secondMatch?.[2])).toBeGreaterThan(Number(firstMatch?.[2]));
      expect(sig2).not.toBe(sig1);
    } finally {
      await db.closeAndRelease();
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
      await db.closeAndRelease();
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
      await db.closeAndRelease();
    }
  });
});

// v3.6.2 HN-4 — search-side model verification. CRIT-1 fixed the build path
// (which silently DROP-TABLE'd on model-alias mismatch); this is the
// search-time guard that prevents returning garbage similarities when the
// HNSW index and the query embedder come from different vector spaces.
describe("assertHnswModelMatchesEmbedder (v3.6.2 HN-4)", () => {
  it("routes a quarantined live graph to EmbedDb while preserving a healthy HNSW route", () => {
    const health = { hnswUsable: true };
    const context = {
      index: { size: 0, searchKnn: () => ({ labels: [], distances: [] }) },
      rowByLabel: new Map(),
      modelAlias: "multilingual",
      health
    };
    expect(selectUsableHnswContext(context)).toBe(context);
    health.hnswUsable = false;
    expect(selectUsableHnswContext(context)).toBeNull();
    expect(selectUsableHnswContext(null)).toBeNull();
  });

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
    expect(() => idx.resize(0)).toThrow(/safe integer/);
    expect(() => idx.resize(2 ** 32)).toThrow(/safe integer/);
    expect(() => idx.resize(Number.NaN)).toThrow(/safe integer/);
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

  // NEGATIVE controls: every caller-controlled native scalar/vector is
  // admitted before the first markDelete/resize/addPoint mutation.
  it("(NEGATIVE control) — applyDiff rejects malformed native inputs atomically", async () => {
    const dim = 8;
    const labeled = Array.from({ length: 5 }, (_, i) => ({ label: i, vector: makeNormVector(dim, i) }));
    const idx = await buildHnsw(labeled, { dim, maxElements: 20 });
    const wrongDim = new Float32Array(16); // dim=16 ≠ 8
    expect(() => idx.applyDiff([], [{ label: 99, vector: wrongDim }])).toThrow(/dim 16, expected 8/);
    expect(() => idx.applyDiff([], [{ label: 2 ** 32, vector: makeNormVector(dim, 99) }])).toThrow(
      /add label.*safe integer/
    );
    expect(() => idx.applyDiff([2 ** 32], [])).toThrow(/remove label.*safe integer/);
    expect(() => idx.applyDiff([], [{ label: 99, vector: new Float32Array(dim).fill(Number.NaN) }])).toThrow(
      /non-finite/
    );
    expect(() =>
      idx.applyDiff(
        [],
        [
          { label: 99, vector: makeNormVector(dim, 99) },
          { label: 99, vector: makeNormVector(dim, 100) }
        ]
      )
    ).toThrow(/duplicate add label 99/);
    expect(idx.searchKnn(makeNormVector(dim, 0), 5).labels).toContain(0);
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
