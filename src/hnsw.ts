// HNSW (Hierarchical Navigable Small World) vector index for enquire-mcp.
//
// v2.13.0 — closes the "brute-force semantic search doesn't scale" gap. The
// existing path in `EmbedDb.search()` runs O(n) cosine over every embedded
// chunk per query. HNSW is the IR-standard graph-based index for approximate
// nearest-neighbor lookup. Real latency and recall depend on corpus shape,
// hardware, and the search/build parameters; benchmark the target vault.
//
// Architecture: in-memory rebuild on serve start.
//
// Persistence: SHIPPED in v2.16.0. Current storage uses immutable
// `.hnsw.<nonce>.bin` generations + a meta-last `.hnsw.meta.json` pointer next
// to `.embed.db`. Staleness check via `EmbedDb.computeSignature`.
// Persisted pointer bytes and every pointer read are capped at 256 MiB. Writer
// peak memory still remains proportional to the already in-memory metadata
// snapshot during serialization; the cap is not a constant-memory save claim.
// An oversize snapshot stays usable in memory but is rebuilt rather than
// persisted/reloaded through an unbounded read allocation.
// Default on for `--use-hnsw`; opt out with `--no-hnsw-persist`.
// See `loadHnswFromDisk` + `saveTo` below for the WAL-style consistency
// handling. The in-memory-only fallback path is still here (when the
// persistence flag is off OR the sidecar files are missing/stale).
//
// Historical note (v3.7.6 audit cleanup): early prototypes considered
// `hnswlib-wasm` (Emscripten port) but its virtual-FS persistence
// model added complexity vs. host-disk for our use case. Final choice
// is `hnswlib-node` (native N-API binding to C++ hnswlib reference
// impl) which writes directly to host disk and is the production-grade
// path for server-side vault retrieval.
//
// Native dep: `hnswlib-node@^3.0` (Node-N-API binding to the C++ hnswlib
// reference impl). Native availability depends on the host platform/ABI;
// npm is allowed to omit an optional dependency whose native install fails.
// Lazy-loaded — same `optionalDependencies` pattern as tesseract.js /
// pdfjs-dist / @huggingface/transformers.
//
// (See "Historical note" above re: hnswlib-wasm vs hnswlib-node choice.)
//
// Users tuning for recall can pass `--hnsw-ef-search` to widen the search
// beam (default 100; higher is generally more accurate and slower).

import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { EmbedReceiptSearchHit, EmbedSearchHit } from "./embed-db.js";
import { importOptionalDependency, optionalDepDetail } from "./optional-dep.js";
import { assertHnswFilePath } from "./persistence-path.js";
import {
  preflightSensitiveArtifactTempEntry,
  publishSensitiveArtifact,
  readSensitiveArtifactText,
  removeSensitiveArtifactTempEntry,
  sameCanonicalDirectoryEntry,
  sensitiveArtifactFinalBasename,
  sha256SensitiveArtifact
} from "./sensitive-artifact.js";

const HNSW_META_FORMAT_VERSION = 2;
const HNSW_GENERATION_TOKEN_BYTES = 24;
const MAX_HNSW_META_BYTES = 256 * 1024 * 1024;
const HNSW_GENERATION_TOKEN_PATTERN = /^[0-9a-f]{48}(?![\s\S])/;
const SHA256_PATTERN = /^[0-9a-f]{64}(?![\s\S])/;

/** A single labeled vector — used to populate the index. */
export interface LabeledVector {
  /** Stable identifier — lets the search code recover the source row from the EmbedDb. */
  label: number;
  /** L2-normalized vector. Caller is responsible for the normalization. */
  vector: Float32Array;
}

/**
 * Public legacy v1 metadata shape retained for source compatibility. Current
 * production persistence writes an internal v2 immutable-generation pointer;
 * an on-disk v1 fixed-bin record is explicitly rebuilt on first load.
 *
 * Historical v1 records were stored at `<file>.meta.json` next to
 * `<file>.bin`. Consumers may continue using this exported type, but it is not
 * the internal v2 disk-write authority.
 */
export interface HnswPersistedMeta {
  formatVersion: 1;
  /** Embedder dim — must match the corpus the index will be queried with. */
  dim: number;
  /** Vector count at write time. */
  size: number;
  /**
   * Embed-db signature at write time — when this differs from the current
   * embed-db's signature, the persisted index is stale and should be
   * rebuilt. The database signature binds current receipt-backed rowcount,
   * max-id, dimension, model, quantization, schema, and (when non-empty) a
   * quarantine digest; a full content hash would require reading every vector.
   */
  signature: string;
  /**
   * Row label → source-row snapshot retained for persistence diagnostics and
   * watcher graph maintenance. Search output must rehydrate labels through
   * `EmbedDb.getSearchRowsByIds()`; this sidecar preview is never an egress
   * authority. JSON-friendly and deliberately receipt-free for format v1.
   */
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
  /** ISO timestamp of the write — informational. */
  writtenAt: string;
}

/** Internal on-disk pointer format. The exported v1 interface remains stable. */
interface HnswPersistedMetaV2 extends Omit<HnswPersistedMeta, "formatVersion"> {
  formatVersion: typeof HNSW_META_FORMAT_VERSION;
  /** Strict same-directory basename of the immutable binary generation. */
  binFile: string;
  /** SHA-256 of `binFile`; binds this metadata to exactly one graph generation. */
  binSha256: string;
}

/** Build-time HNSW parameters. Defaults tuned for 384-dim cosine on PKM data. */
export interface HnswBuildOptions {
  /** Embedding dimensionality (must match the corpus). */
  dim: number;
  /** Maximum elements (caller's count of vectors); enables index pre-sizing. */
  maxElements: number;
  /**
   * Number of bidirectional links per node. Higher M = better recall but
   * more memory + slower build. Default 16 (Malkov & Yashunin, 2018, §4.1).
   */
  m?: number;
  /**
   * Beam width during build. Higher efConstruction = better recall,
   * slower build, no query-time cost. Default 200.
   */
  efConstruction?: number;
  /** Seed for build-time randomization (reproducibility in tests). */
  seed?: number;
}

/** Per-query parameters. */
export interface HnswQueryOptions {
  /**
   * Beam width during search. Higher = more accurate, slower. Default 100.
   * Must be ≥ k. Common range: 50-500.
   */
  ef?: number;
}

/**
 * In-memory HNSW index over L2-normalized cosine vectors. Built once on
 * serve start from `EmbedDb.getAllVectors()`; queried per
 * `obsidian_search` / `obsidian_embeddings_search` invocation.
 */
export interface HnswIndex {
  /** Vector dimensionality. */
  readonly dim: number;
  /** Number of points currently in the index. */
  readonly size: number;
  /**
   * k-NN search. Returns labels + distances (cosine distance, smaller =
   * more similar). Caller maps labels back to source rows via the same
   * `LabeledVector.label` they used at build time.
   */
  searchKnn(queryVec: Float32Array, k: number, opts?: HnswQueryOptions): { labels: number[]; distances: number[] };
  /**
   * v2.16.0 — persist the index to disk for fast reload on next serve
   * start. Writes an immutable `<file>.<nonce>.bin` generation, then
   * atomically publishes `<file>.meta.json` last as its basename + SHA-256
   * pointer. Returns true once that pointer commits; prior-generation cleanup
   * is best-effort and cannot turn a committed save into a reported failure.
   *
   * `file` must use the exact lowercase `.hnsw` suffix so separate configured
   * bases cannot collide with one another's generated artifacts. A missing
   * parent is requested via recursive
   * mode-`0700` mkdir subject to a more-restrictive umask; an existing/custom
   * parent is never path-chmod'd. Saves
   * on one wrapped index serialize in invocation order. A queued save whose
   * graph epoch changed before it starts rejects without publishing; live
   * native mutation is mutually excluded while `writeIndex` is in flight.
   * Metadata larger than 256 MiB is refused before pointer publication; the
   * already-built in-memory graph remains usable. Precommit orphan cleanup is
   * best-effort: a failed cleanup may leave a strict generated residue that
   * explicit clear/prune covers.
   *
   * @param file - Exact lowercase `.hnsw` persistence base.
   * @param rowsByLabel - Metadata snapshot keyed by native labels.
   * @param signature - Embed-database generation signature bound into the pointer.
   * @returns `true` after the meta-last pointer commits.
   * @throws {TypeError} If `file` is outside the exact HNSW namespace.
   * @throws {Error} If the graph changes before snapshot, overlaps mutation, or publication fails.
   */
  saveTo(
    file: string,
    rowsByLabel: ReadonlyMap<
      number,
      {
        rel_path: string;
        chunk_index: number;
        line_start: number;
        line_end: number;
        text_preview: string;
        kind: "md" | "pdf";
      }
    >,
    signature: string
  ): Promise<boolean>;
  /**
   * v3.9.0-rc.2 — apply a live-update diff to the in-memory index. The
   * watcher calls this after `embedDb.upsertNote()` returns its
   * `{ oldIds, newIds }` so search reflects the change immediately
   * (pre-3.9.0, search was stale until the next serve restart rebuilt
   * the index from the freshly upserted embed-db).
   *
   * Semantics:
   *   1. Each id in `removeLabels` is `markDelete`'d. Missing labels
   *      (e.g. a stale watcher tracking a label that was already evicted)
   *      are silently skipped.
   *   2. Each entry in `addPoints` is `addPoint`'d with `replaceDeleted`
   *      = true so deleted-but-allocated slots are reused before the
   *      index grows. Throws (wrapped) if capacity is exhausted AND the
   *      caller didn't pre-grow via {@link resize}.
   *
   * Atomicity: the SDK's underlying mutations are synchronous, but
   * `applyDiff` does not wrap them in a transaction. A throw mid-loop
   * leaves the index in a partial-update state (some labels removed,
   * some new points added, others not). Callers MUST treat throws as
   * "rebuild required" — there's no rollback path in hnswlib. The method also
   * throws before its first native mutation if a persistence snapshot is in
   * flight, so `writeIndex` can never race C++ graph mutation.
   *
   * @returns the number of labels removed + the number of points added
   *   (for logging / instrumentation). Sum should equal
   *   `removeLabels.length + addPoints.length` on success.
   */
  applyDiff(
    removeLabels: ReadonlyArray<number>,
    addPoints: ReadonlyArray<{ label: number; vector: Float32Array }>
  ): { removed: number; added: number };
  /**
   * v3.9.0-rc.2 — grow the index to at least `newMaxElements`. No-op if
   * already large enough. Used by the watcher before `applyDiff` when
   * the live-update would push us past current capacity. Native call
   * is synchronous (in-place re-allocation). Throws before resizing if a
   * persistence snapshot is in flight.
   */
  resize(newMaxElements: number): void;
  /**
   * v3.9.0-rc.2 — capacity introspection. `currentCount` is the number
   * of live points (deleted points still count toward this); `maxElements`
   * is the pre-allocated cap. Caller uses these to decide whether
   * {@link resize} is needed before {@link applyDiff}.
   */
  capacity(): { currentCount: number; maxElements: number };
}

/**
 * Lazy-load `hnswlib-node`. Same clean-error pattern as the other
 * optional-dep loaders (tesseract.js, pdfjs-dist, @huggingface/
 * transformers). Throws with an install hint if the dep isn't present
 * or its source-built native binding failed to load. npm may omit the
 * package entirely when that optional native installation fails.
 */
interface HnswlibNodeModule {
  HierarchicalNSW: new (space: "cosine" | "l2" | "ip", dim: number) => HnswNativeIndex;
}

interface HnswNativeIndex {
  initIndex(
    maxElements: number,
    m?: number,
    efConstruction?: number,
    randomSeed?: number,
    allowReplaceDeleted?: boolean
  ): void;
  addPoint(point: number[], label: number, replaceDeleted?: boolean): void;
  searchKnn(
    query: number[],
    k: number,
    filter?: (label: number) => boolean
  ): { distances: number[]; neighbors: number[] };
  setEf(ef: number): void;
  /** v2.16.0 — persistence (hnswlib-node@^3 API). */
  writeIndex(filename: string): Promise<boolean>;
  readIndex(filename: string, allowReplaceDeleted?: boolean): Promise<boolean>;
  /** v3.9.0-rc.2 — mark a label as deleted (the slot stays allocated; a
   *  later `addPoint(..., replaceDeleted=true)` can reuse it). Throws if
   *  the label was never added. */
  markDelete(label: number): void;
  /** v3.9.0-rc.2 — current allocated slot count + max capacity. Used by
   *  HnswIndex.applyDiff to detect capacity exhaustion BEFORE addPoint
   *  throws (the native error is "The number of elements exceeds the
   *  specified limit." which we want to wrap in a clearer message). */
  getCurrentCount(): number;
  getMaxElements(): number;
  /** v3.9.0-rc.2 — grow the index in place. Native call is sync. */
  resizeIndex(newMaxElements: number): void;
}

let cachedModule: HnswlibNodeModule | null = null;

function asHnswlibNodeModule(value: unknown): HnswlibNodeModule | null {
  if (typeof value !== "object" || value === null) return null;
  const namespace = value as Record<string, unknown>;
  for (const candidate of [namespace.default, namespace]) {
    if (typeof candidate !== "object" || candidate === null) continue;
    if (typeof (candidate as Record<string, unknown>).HierarchicalNSW === "function") {
      return candidate as unknown as HnswlibNodeModule;
    }
  }
  return null;
}

async function loadHnswlib(): Promise<HnswlibNodeModule> {
  if (cachedModule) return cachedModule;
  try {
    // hnswlib-node ships as CJS; ESM consumers may expose the module through
    // `.default`, named exports, or both. Narrow the untrusted namespace.
    const lib = asHnswlibNodeModule(await importOptionalDependency("hnswlib-node"));
    if (!lib) {
      throw new Error("hnswlib-node has no HierarchicalNSW export — package mismatch");
    }
    cachedModule = lib;
    return cachedModule;
  } catch (err) {
    // rc.59 (OPTDEP leak, post-rc.58 re-sweep) — code only; Node's ERR_MODULE_NOT_FOUND
    // message embeds the importing file's abs path. (This loader used a `const msg = …`
    // INDIRECTION the rc.57 detector was blind to — now caught by the strengthened invariant.)
    throw new Error(
      "enquire: hnswlib-node (optional dependency) is not available. HNSW requires it. " +
        `Install with: npm install hnswlib-node@^3 (or reinstall enquire-mcp without --omit=optional). (${optionalDepDetail(err)})`
    );
  }
}

/**
 * Build a fresh in-memory HNSW from labeled vectors.
 *
 * `vectors` must be L2-normalized — the cosine distance space treats
 * inputs as already-unit-length, so unnormalized inputs produce wrong
 * distances. The `EmbedDb` already L2-normalizes at insert time, so the
 * usual call path (loadAllVectors → buildHnsw) is safe by construction.
 *
 * Throws if `dim` doesn't match any vector's length, if `maxElements`
 * is less than the input count, or if `hnswlib-node` failed to load.
 */
export async function buildHnsw(vectors: ReadonlyArray<LabeledVector>, opts: HnswBuildOptions): Promise<HnswIndex> {
  const dim = opts.dim;
  if (vectors.length > opts.maxElements) {
    throw new Error(
      `buildHnsw: vectors.length=${vectors.length} exceeds maxElements=${opts.maxElements}; pre-size the index`
    );
  }
  const m = opts.m ?? 16;
  const efConstruction = opts.efConstruction ?? 200;
  const seed = opts.seed ?? 100;

  // Validate first — fail fast before pulling in the WASM module.
  for (let i = 0; i < vectors.length; i++) {
    const v = vectors[i];
    if (!v) continue;
    if (v.vector.length !== dim) {
      throw new Error(`buildHnsw: vector at index ${i} has dim ${v.vector.length}, expected ${dim}`);
    }
  }

  const lib = await loadHnswlib();
  const ctor = new lib.HierarchicalNSW("cosine", dim);
  // Pre-size the index. `m=16` and `efConstruction=200` are HNSW defaults
  // (Malkov & Yashunin, 2018) and produce ≥98% recall@10 vs brute-force on
  // typical PKM corpora.
  // v3.9.0-rc.2 — pass `allowReplaceDeleted=true` so the live-update
  // path (`applyDiff` → `addPoint(replaceDeleted=true)`) can reuse
  // markDelete'd slots. Hnswlib defaults this to false; calling addPoint
  // with replaceDeleted=true on an index that wasn't initialized with
  // this flag throws "Replacement of deleted elements is disabled in
  // constructor". Always-on costs nothing for the read-only path.
  ctor.initIndex(Math.max(opts.maxElements, 1), m, efConstruction, seed, /* allowReplaceDeleted */ true);

  for (let i = 0; i < vectors.length; i++) {
    const v = vectors[i];
    if (!v) continue;
    // hnswlib-node accepts plain number[] (it copies into its own C++
    // buffer internally). Float32Array.from-via-Array.from would allocate
    // an intermediate; we use a plain spread which is fast and explicit.
    ctor.addPoint(Array.from(v.vector), v.label);
  }

  return wrapNativeIndex(ctor, dim, vectors.length);
}

/**
 * v2.16.0 — wrap a native hnswlib-node index (built fresh OR loaded from
 * disk) as our `HnswIndex` type. Factored out of `buildHnsw` so the
 * load-from-disk path returns the same shape without re-running addPoint.
 */
function wrapNativeIndex(ctor: HnswNativeIndex, dim: number, size: number): HnswIndex {
  // v3.9.0-rc.2 — `size` is a fallback. When the live-update methods
  // (`applyDiff`, `resize`) are unavailable on an older native library,
  // the index is read-only and `size` stays at the buildHnsw-time value. When the
  // methods ARE available, the `size` getter delegates to
  // `ctor.getCurrentCount()` so callers always see the live count after
  // mutations. We probe once at wrap time.
  const hasLiveUpdate =
    typeof ctor.markDelete === "function" &&
    typeof ctor.getCurrentCount === "function" &&
    typeof ctor.getMaxElements === "function" &&
    typeof ctor.resizeIndex === "function";
  let mutationEpoch = 0;
  let persistInFlight = false;
  let persistChain: Promise<void> = Promise.resolve();
  return {
    dim,
    get size(): number {
      return hasLiveUpdate ? ctor.getCurrentCount() : size;
    },
    searchKnn(queryVec: Float32Array, k: number, qOpts?: HnswQueryOptions): { labels: number[]; distances: number[] } {
      if (queryVec.length !== dim) {
        throw new Error(`HnswIndex.searchKnn: query dim ${queryVec.length} ≠ index dim ${dim}`);
      }
      // ef must be ≥ k; the underlying lib enforces this but we surface a
      // friendlier error if the caller forgets.
      const ef = Math.max(qOpts?.ef ?? 100, k);
      ctor.setEf(ef);
      const result = ctor.searchKnn(Array.from(queryVec), k, undefined);
      return { labels: result.neighbors, distances: result.distances };
    },
    applyDiff(removeLabels, addPoints): { removed: number; added: number } {
      if (persistInFlight) {
        throw new Error("HnswIndex.applyDiff: persistence snapshot is in flight; refusing an overlapping mutation");
      }
      if (!hasLiveUpdate) {
        throw new Error(
          "HnswIndex.applyDiff: hnswlib-node native binding does not expose markDelete/addPoint/resizeIndex — " +
            "upgrade hnswlib-node to ≥3.0 (or rebuild from source) to use live-update; falling back to full rebuild on next serve restart"
        );
      }
      // v3.10.0-rc.16 (audit M6) — pre-validate ALL vector dims BEFORE any
      // mutation (markDelete / resizeIndex / addPoint). Previously the dim
      // check lived INSIDE the addPoint loop, so a mismatched vector threw
      // AFTER some labels were already markDelete'd and some points added —
      // leaving a half-applied index the caller had to rebuild (silent embed-db
      // ↔ HNSW divergence in the watcher path, which logs + continues rather
      // than rebuilding). Hoisting the check makes applyDiff ATOMIC for the
      // only caller-data-driven throw: if any dim is wrong, nothing mutates.
      for (const pt of addPoints) {
        if (pt.vector.length !== dim) {
          throw new Error(
            `HnswIndex.applyDiff: vector for label ${pt.label} has dim ${pt.vector.length}, expected ${dim}`
          );
        }
      }
      // From the first native mutation onward, any throw may leave a partial
      // graph. Advance conservatively before touching C++ so no later save can
      // mistake that graph for the previously admitted generation.
      mutationEpoch += 1;
      let removed = 0;
      for (const label of removeLabels) {
        try {
          ctor.markDelete(label);
          removed += 1;
        } catch {
          // Silently skip labels that were never added (or already deleted).
          // The watcher's view can lag behind reality after a sweep eviction;
          // it shouldn't fail the live-update for this.
        }
      }
      let added = 0;
      // Pre-grow if needed so addPoint doesn't throw mid-loop with a
      // half-applied diff. We size to currentCount + addPoints.length
      // with a small headroom multiplier so successive small diffs don't
      // ping-pong the resize call (allocations are O(n)).
      const needed = ctor.getCurrentCount() + addPoints.length;
      const current = ctor.getMaxElements();
      if (needed > current) {
        // 1.5× the requested target — same growth factor most JS array
        // implementations use; balances allocation cost vs. memory waste.
        ctor.resizeIndex(Math.max(needed, Math.ceil(current * 1.5)));
      }
      for (const pt of addPoints) {
        // dim pre-validated above (audit M6); the only remaining throw is a
        // genuine native/capacity error — capacity is pre-grown above, so this
        // is rare and not caller-data-driven.
        ctor.addPoint(Array.from(pt.vector), pt.label, /* replaceDeleted */ true);
        added += 1;
      }
      return { removed, added };
    },
    resize(newMaxElements: number): void {
      if (persistInFlight) {
        throw new Error("HnswIndex.resize: persistence snapshot is in flight; refusing an overlapping mutation");
      }
      if (!hasLiveUpdate) {
        throw new Error("HnswIndex.resize: hnswlib-node native binding does not expose resizeIndex");
      }
      if (newMaxElements > ctor.getMaxElements()) {
        mutationEpoch += 1;
        ctor.resizeIndex(newMaxElements);
      }
    },
    capacity(): { currentCount: number; maxElements: number } {
      if (!hasLiveUpdate) {
        // v3.11.0-rc.9 (audit I-HNSW-1) — HONEST fallback. The read-only binding
        // can't introspect the real maxElements, so report it as Infinity (capacity
        // unknown / effectively unbounded) rather than fabricating `size`. The old
        // `maxElements: size` lied (cap == count → "0 free slots"); a future caller
        // computing `free = max - current` now reads Infinity ("never needs resize"),
        // which is correct here since resize()/applyDiff() both throw on this binding.
        return { currentCount: size, maxElements: Number.POSITIVE_INFINITY };
      }
      return { currentCount: ctor.getCurrentCount(), maxElements: ctor.getMaxElements() };
    },
    async saveTo(file, rowsByLabel, signature): Promise<boolean> {
      assertHnswFilePath(file);
      // Snapshot caller-owned metadata at invocation, then serialize native
      // writes for this wrapped index. This prevents an older invocation from
      // publishing its pointer after a newer invocation on the same instance.
      const rowsSnapshot = Object.fromEntries(
        [...rowsByLabel].map(([label, row]) => [label, { ...row }])
      ) as HnswPersistedMeta["rowsByLabel"];
      const invocationEpoch = mutationEpoch;
      const sizeSnapshot = hasLiveUpdate ? ctor.getCurrentCount() : size;
      const save = persistChain.then(async () => {
        if (mutationEpoch !== invocationEpoch) {
          throw new Error("HNSW changed before its queued persistence snapshot could start");
        }
        persistInFlight = true;
        try {
          const parentDir = path.dirname(file);
          // Create missing parents with no group/world grants (subject to a
          // more-restrictive umask), but never path-chmod an existing/custom
          // parent based on a racy pre-stat ownership guess.
          await fs.mkdir(parentDir, { recursive: true, mode: 0o700 });

          const metaFile = `${file}.meta.json`;
          const previous = await readHnswMetaPointer(metaFile, file);
          const generationBasename = hnswGenerationBasename(file);
          const generationFile = path.join(parentDir, generationBasename);
          let generationPublished = false;
          let metaPublished = false;
          try {
            // hnswlib-node accepts only a host path. The common publisher gives
            // it a pre-created mode-0600 file inside an owned unpredictable 0700
            // staging directory, validates the held inode, then promotes it as
            // an immutable generation.
            const binary = await publishSensitiveArtifact(generationFile, async (stagedPath) => {
              const written = await ctor.writeIndex(stagedPath);
              if (!written) throw new Error("hnswlib-node reported an unsuccessful index write");
            });
            generationPublished = true;
            const meta: HnswPersistedMetaV2 = {
              formatVersion: HNSW_META_FORMAT_VERSION,
              binFile: generationBasename,
              binSha256: binary.sha256,
              dim,
              // Persist the LIVE element count after any applyDiff, not the stale
              // build-time closure.
              size: sizeSnapshot,
              signature,
              rowsByLabel: rowsSnapshot,
              writtenAt: new Date().toISOString()
            };
            // Meta is the sole generation pointer and is published LAST. A crash
            // before this rename leaves the previous pointer authoritative.
            const serializedMeta = JSON.stringify(meta, null, 2);
            if (Buffer.byteLength(serializedMeta, "utf8") > MAX_HNSW_META_BYTES) {
              throw new Error("HNSW metadata exceeds the persistence read limit");
            }
            await publishSensitiveArtifact(metaFile, serializedMeta);
            metaPublished = true;

            // Pointer commit is the success boundary. Generation GC is
            // best-effort and must never turn a committed save into a reported
            // failure that callers might retry as if nothing landed.
            try {
              const current = await readHnswMetaPointer(metaFile, file);
              if (current && current.binFile === generationBasename && current.binSha256 === binary.sha256) {
                if (previous && previous.binFile !== generationBasename) {
                  await unlinkHnswGeneration(path.join(parentDir, previous.binFile));
                }
                // Explicit migration cleanup for the pre-format-2 fixed binary.
                await unlinkHnswGeneration(`${file}.bin`);
              } else if (current) {
                // A concurrent publisher won the meta pointer. This invocation
                // may erase only its own now-unreferenced generation.
                await unlinkHnswGeneration(generationFile);
              }
            } catch {
              // Strict generation names are covered by explicit clear/prune;
              // an orphan is safer than rejecting after the pointer committed.
            }
            return true;
          } catch (err) {
            // Before the meta pointer commits, this generation is provably
            // unreferenced and owned by this invocation.
            if (generationPublished && !metaPublished) await unlinkHnswGeneration(generationFile).catch(() => {});
            throw err;
          }
        } finally {
          persistInFlight = false;
        }
      });
      persistChain = save.then(
        () => {},
        () => {}
      );
      return save;
    }
  };
}

interface HnswMetaPointer {
  binFile: string;
  binSha256: string;
}

function hnswGenerationBasename(file: string): string {
  return `${path.basename(file)}.${randomBytes(HNSW_GENERATION_TOKEN_BYTES).toString("hex")}.bin`;
}

/**
 * Test whether a basename is in the immutable-generation namespace reserved for `file`.
 *
 * @param file - Stable HNSW persistence base.
 * @param entryBasename - Candidate same-directory basename.
 * @returns `true` only for `<base>.<48-hex>.bin`.
 * @throws {TypeError} If `file` is outside the exact `.hnsw` namespace.
 * @example
 * isHnswGenerationBasename("/tmp/a.hnsw", "a.hnsw.000000000000000000000000000000000000000000000000.bin");
 * @internal
 */
export function isHnswGenerationBasename(file: string, entryBasename: string): boolean {
  assertHnswFilePath(file);
  const prefix = `${path.basename(file)}.`;
  const candidatePrefix = entryBasename.slice(0, prefix.length);
  if (candidatePrefix !== prefix || !entryBasename.endsWith(".bin")) return false;
  const token = entryBasename.slice(prefix.length, -".bin".length);
  return HNSW_GENERATION_TOKEN_PATTERN.test(token);
}

interface HnswEraseEntry {
  entryPath: string;
  generatedTemp: boolean;
}

/**
 * Validate the complete HNSW erasure family before any member is deleted.
 *
 * @param file - Stable HNSW persistence base passed to `saveTo`.
 * @returns `true` when at least one recognized artifact exists.
 * @throws {TypeError} If `file` is outside the exact `.hnsw` namespace.
 * @throws {Error} If a reserved-shape entry is malformed or its path spelling is ambiguous.
 * @example
 * await preflightHnswPersistedArtifacts("/tmp/vault.hnsw");
 * @internal
 */
export async function preflightHnswPersistedArtifacts(file: string): Promise<boolean> {
  assertHnswFilePath(file);
  return (await planHnswErasure(file)).length > 0;
}

/**
 * Erase the complete HNSW artifact family, including legacy fixed binaries,
 * immutable generations, the stable meta pointer, and recognized crash temps.
 *
 * @param file - Stable HNSW persistence base passed to `saveTo`.
 * @returns `true` when at least one artifact was removed.
 * @throws {TypeError} If `file` is outside the exact `.hnsw` namespace.
 * @throws {Error} If a recognized generated entry has an unsafe shape or cannot be removed.
 * @example
 * await clearHnswPersistedArtifacts("/tmp/vault.hnsw");
 * @internal
 */
export async function clearHnswPersistedArtifacts(file: string): Promise<boolean> {
  assertHnswFilePath(file);
  // Re-run the complete preflight immediately before deletion. No malformed
  // generated entry can make erasure stop after only part of the family.
  const plan = await planHnswErasure(file);
  let removed = false;
  for (const entry of plan) {
    if (entry.generatedTemp) {
      removed = (await removeSensitiveArtifactTempEntry(entry.entryPath)) || removed;
      continue;
    }
    try {
      await fs.unlink(entry.entryPath);
      removed = true;
    } catch (err) {
      if (errnoCode(err) !== "ENOENT") throw err;
    }
  }
  return removed;
}

async function planHnswErasure(file: string): Promise<HnswEraseEntry[]> {
  const parent = path.dirname(file);
  const legacyBin = `${path.basename(file)}.bin`;
  const meta = `${path.basename(file)}.meta.json`;
  let entries: string[];
  try {
    entries = await fs.readdir(parent);
  } catch (err) {
    if (errnoCode(err) === "ENOENT") return [];
    throw err;
  }

  const plan: HnswEraseEntry[] = [];
  for (const entry of entries) {
    const generatedFinal = sensitiveArtifactFinalBasename(entry);
    const ownedFinal = generatedFinal ?? entry;
    const expectedFinal = expectedHnswBasename(file, ownedFinal, legacyBin, meta);
    if (!expectedFinal) continue;
    const entryPath = path.join(parent, entry);
    const expectedEntry = generatedFinal
      ? `${expectedFinal}${entry.slice(generatedFinal.length).toLowerCase()}`
      : expectedFinal;
    if (entry !== expectedEntry) {
      if (!(await sameCanonicalDirectoryEntry(entryPath, path.join(parent, expectedEntry)))) {
        if (normalizedHnswEntrySpelling(entry) === normalizedHnswEntrySpelling(expectedEntry)) {
          throw new Error("Refusing HNSW erasure: a reserved-shape artifact has ambiguous path spelling");
        }
        continue;
      }
    }
    if (generatedFinal) {
      await preflightSensitiveArtifactTempEntry(entryPath);
      plan.push({ entryPath, generatedTemp: true });
      continue;
    }
    const entryStat = await fs.lstat(entryPath);
    if (!entryStat.isFile() && !entryStat.isSymbolicLink()) {
      throw new Error("Refusing HNSW erasure: an artifact is not a regular file or symlink leaf");
    }
    plan.push({ entryPath, generatedTemp: false });
  }
  return plan;
}

function expectedHnswBasename(file: string, candidate: string, legacyBin: string, meta: string): string | null {
  if (candidate === legacyBin || candidate === meta || isHnswGenerationBasename(file, candidate)) return candidate;
  if (/^.+\.meta\.json(?![\s\S])/is.test(candidate)) return meta;
  if (!/^.+\.bin(?![\s\S])/is.test(candidate)) return null;
  const generation = /^.+\.([0-9a-f]{48})\.bin(?![\s\S])/is.exec(candidate);
  const token = generation?.[1]?.toLowerCase();
  return token ? `${path.basename(file)}.${token}.bin` : legacyBin;
}

function normalizedHnswEntrySpelling(value: string): string {
  return value.normalize("NFC").toLowerCase();
}

async function readHnswMetaPointer(metaFile: string, file: string): Promise<HnswMetaPointer | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readSensitiveArtifactText(metaFile, MAX_HNSW_META_BYTES)) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (
    record.formatVersion !== HNSW_META_FORMAT_VERSION ||
    typeof record.binFile !== "string" ||
    !isHnswGenerationBasename(file, record.binFile) ||
    typeof record.binSha256 !== "string" ||
    !SHA256_PATTERN.test(record.binSha256)
  ) {
    return null;
  }
  return { binFile: record.binFile, binSha256: record.binSha256 };
}

async function unlinkHnswGeneration(file: string): Promise<void> {
  let entry: import("node:fs").Stats;
  try {
    entry = await fs.lstat(file);
  } catch (err) {
    if (errnoCode(err) === "ENOENT") return;
    throw err;
  }
  if (!entry.isFile() && !entry.isSymbolicLink()) {
    throw new Error("Refusing to remove an unsafe HNSW generation leaf");
  }
  await fs.unlink(file);
}

/**
 * v2.16.0 — load a previously-persisted HNSW index from disk. Returns
 * `null` (with a stderr warning) if:
 *   • The meta pointer or its immutable generation is missing
 *   • The meta pointer exceeds the bounded 256 MiB persistence fast-path
 *   • A legacy fixed-bin meta lacks the format-2 pointer/digest
 *   • The generation digest or pre/post-load generation receipt differs
 *   • The meta's `signature` doesn't match the caller's current signature
 *   • The meta's `formatVersion` doesn't match
 *   • The meta's `dim` is not a positive integer (v3.8.0-rc.10 P3-27)
 *   • The meta's `size` is not a non-negative integer (v3.8.0-rc.10 P3-27)
 *   • The meta's `rowsByLabel` is not a plain object (v3.8.0-rc.10 P3-27)
 *   • The native lib fails to load the .bin (corrupt / dim mismatch)
 *
 * On success returns `{ index, rowsByLabel }` so the caller can wire
 * both into `searchHybrid`'s `hnsw` context without rebuilding from
 * scratch. The actual boot-time win depends on index size and storage.
 *
 * @param file - Exact lowercase `.hnsw` persistence base.
 * @param expectedSignature - Current embed-database generation signature.
 * @returns A digest/signature-validated graph and metadata map, or `null` for fail-soft rebuild.
 * @throws {TypeError} If `file` is outside the exact HNSW namespace.
 */
export async function loadHnswFromDisk(
  file: string,
  expectedSignature: string
): Promise<{ index: HnswIndex; rowsByLabel: Map<number, HnswPersistedMeta["rowsByLabel"][string]> } | null> {
  assertHnswFilePath(file);
  const metaFile = `${file}.meta.json`;
  let metaRawBefore: string;
  try {
    metaRawBefore = await readSensitiveArtifactText(metaFile, MAX_HNSW_META_BYTES);
  } catch {
    return null; // No meta → no persisted index (or partial write).
  }
  let parsedMeta: unknown;
  try {
    parsedMeta = JSON.parse(metaRawBefore) as unknown;
  } catch (err) {
    process.stderr.write(
      `enquire: HNSW meta at ${metaFile} is malformed; rebuilding — ${err instanceof Error ? err.message : String(err)}\n`
    );
    return null;
  }
  if (typeof parsedMeta !== "object" || parsedMeta === null || Array.isArray(parsedMeta)) {
    process.stderr.write(`enquire: HNSW meta at ${metaFile} is not an object; rebuilding\n`);
    return null;
  }
  const meta = parsedMeta as HnswPersistedMetaV2;
  const storedFormatVersion = (parsedMeta as { formatVersion?: unknown }).formatVersion;
  if (storedFormatVersion !== HNSW_META_FORMAT_VERSION) {
    const legacy = storedFormatVersion === 1;
    process.stderr.write(
      legacy
        ? "enquire: legacy HNSW fixed-bin metadata has no immutable generation digest; rebuilding\n"
        : `enquire: HNSW meta format ${String(storedFormatVersion)} ≠ expected ${HNSW_META_FORMAT_VERSION}; rebuilding (this happens on enquire-mcp upgrade)\n`
    );
    return null;
  }
  if (
    typeof meta.binFile !== "string" ||
    !isHnswGenerationBasename(file, meta.binFile) ||
    typeof meta.binSha256 !== "string" ||
    !SHA256_PATTERN.test(meta.binSha256)
  ) {
    process.stderr.write("enquire: HNSW meta has an invalid generation pointer or digest; rebuilding\n");
    return null;
  }
  const binFile = path.join(path.dirname(file), meta.binFile);
  if (meta.signature !== expectedSignature) {
    process.stderr.write(
      `enquire: HNSW persisted index is stale (signature mismatch — embed-db changed since last write); rebuilding\n`
    );
    return null;
  }
  // v3.8.0-rc.10 P3-27 — shallow validation of dim/size/rowsByLabel before
  // passing them to the native hnswlib constructor. Malformed-but-valid-JSON
  // meta files with negative/non-integer dim or missing rowsByLabel would
  // previously produce a native crash or garbage results.
  if (!Number.isInteger(meta.dim) || meta.dim <= 0) {
    process.stderr.write(`enquire: HNSW meta at ${metaFile} has invalid dim=${meta.dim}; rebuilding\n`);
    return null;
  }
  if (!Number.isInteger(meta.size) || meta.size < 0) {
    process.stderr.write(`enquire: HNSW meta at ${metaFile} has invalid size=${meta.size}; rebuilding\n`);
    return null;
  }
  if (typeof meta.rowsByLabel !== "object" || meta.rowsByLabel === null || Array.isArray(meta.rowsByLabel)) {
    process.stderr.write(`enquire: HNSW meta at ${metaFile} has invalid rowsByLabel; rebuilding\n`);
    return null;
  }
  let digestBefore: string;
  try {
    digestBefore = await sha256SensitiveArtifact(binFile);
  } catch (err) {
    process.stderr.write(
      `enquire: HNSW generation is missing or unsafe; rebuilding — ${err instanceof Error ? err.message : String(err)}\n`
    );
    return null;
  }
  if (digestBefore !== meta.binSha256) {
    process.stderr.write("enquire: HNSW generation digest does not match metadata; rebuilding\n");
    return null;
  }
  // Load the native binary.
  const lib = await loadHnswlib();
  const ctor = new lib.HierarchicalNSW("cosine", meta.dim);
  try {
    const loaded = await ctor.readIndex(binFile);
    if (!loaded) {
      process.stderr.write("enquire: hnswlib-node reported an unsuccessful index load; rebuilding\n");
      return null;
    }
  } catch (err) {
    process.stderr.write(
      `enquire: HNSW readIndex failed at ${binFile}; rebuilding — ${err instanceof Error ? err.message : String(err)}\n`
    );
    return null;
  }
  // A different publisher may commit while native readIndex is in flight.
  // Re-hash the path and re-read the pointer; only an unchanged meta+binary
  // pair may authorize the in-memory row mapping.
  let digestAfter: string;
  let metaRawAfter: string;
  try {
    [digestAfter, metaRawAfter] = await Promise.all([
      sha256SensitiveArtifact(binFile),
      readSensitiveArtifactText(metaFile, MAX_HNSW_META_BYTES)
    ]);
  } catch {
    process.stderr.write("enquire: HNSW generation changed during load; rebuilding\n");
    return null;
  }
  if (digestAfter !== digestBefore || digestAfter !== meta.binSha256 || metaRawAfter !== metaRawBefore) {
    process.stderr.write("enquire: HNSW meta/generation changed during load; rebuilding\n");
    return null;
  }
  const index = wrapNativeIndex(ctor, meta.dim, meta.size);
  // Reconstruct the row map.
  const rowsByLabel = new Map<number, HnswPersistedMeta["rowsByLabel"][string]>();
  for (const [labelStr, row] of Object.entries(meta.rowsByLabel)) {
    rowsByLabel.set(Number.parseInt(labelStr, 10), row);
  }
  return { index, rowsByLabel };
}

/**
 * Convert HNSW search results to legacy, receipt-free {@link EmbedSearchHit}
 * rows using a label-to-source-row lookup. This compatibility helper does not
 * establish live-source authority and must not be used directly for persisted
 * content egress; use {@link hnswResultsToReceiptHits} with current EmbedDb
 * hydration for that path.
 *
 * @param result Labels and cosine distances returned by the native HNSW index.
 * @param rowByLabel Receipt-free source rows keyed by the labels assigned at build time.
 * @returns Legacy hits for labels present in the supplied lookup.
 * @example
 * ```ts
 * const hits = hnswResultsToHits(result, loaded.rowsByLabel);
 * ```
 */
export function hnswResultsToHits(
  result: { labels: number[]; distances: number[] },
  rowByLabel: ReadonlyMap<
    number,
    {
      rel_path: string;
      chunk_index: number;
      line_start: number;
      line_end: number;
      text_preview: string;
      kind: "md" | "pdf";
    }
  >
): EmbedSearchHit[] {
  const hits: EmbedSearchHit[] = [];
  for (let i = 0; i < result.labels.length; i++) {
    const label = result.labels[i];
    const distance = result.distances[i];
    if (label === undefined || distance === undefined) continue;
    const row = rowByLabel.get(label);
    if (!row) continue; // race: row deleted between build and query — skip
    // hnswlib-node cosine distance = 1 - cosine_similarity.
    // Convert back so callers can compare against brute-force scores.
    const score = 1 - distance;
    hits.push({
      rel_path: row.rel_path,
      chunk_index: row.chunk_index,
      line_start: row.line_start,
      line_end: row.line_end,
      text_preview: row.text_preview,
      score,
      kind: row.kind
    });
  }
  return hits;
}

/**
 * Convert HNSW search results to receipt-bearing embedding hits using current
 * rows hydrated from `EmbedDb.getSearchRowsByIds()`. Persisted HNSW sidecar
 * previews are never an authority for this helper: stale, quarantined, or
 * missing labels must already be absent from the supplied EmbedDb lookup.
 * Cosine distance is converted back to similarity as `1 - distance`.
 *
 * @param result Labels and cosine distances returned by the native HNSW index.
 * @param rowByLabel Current receipt-bearing EmbedDb rows keyed by embedding id.
 * @returns Receipt-bearing hits for labels still present in the current EmbedDb.
 * @example
 * ```ts
 * const rows = embedDb.getSearchRowsByIds(result.labels);
 * const hits = hnswResultsToReceiptHits(result, rows);
 * ```
 */
export function hnswResultsToReceiptHits(
  result: { labels: number[]; distances: number[] },
  rowByLabel: ReadonlyMap<number, Omit<EmbedReceiptSearchHit, "score">>
): EmbedReceiptSearchHit[] {
  const hits: EmbedReceiptSearchHit[] = [];
  for (let i = 0; i < result.labels.length; i++) {
    const label = result.labels[i];
    const distance = result.distances[i];
    if (label === undefined || distance === undefined) continue;
    const row = rowByLabel.get(label);
    if (!row) continue;
    hits.push({
      rel_path: row.rel_path,
      chunk_index: row.chunk_index,
      line_start: row.line_start,
      line_end: row.line_end,
      text_preview: row.text_preview,
      score: 1 - distance,
      kind: row.kind,
      indexed_mtime_ms: row.indexed_mtime_ms,
      indexed_revision: row.indexed_revision
    });
  }
  return hits;
}

function errnoCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null || !("code" in err)) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
