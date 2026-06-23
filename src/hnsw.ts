// HNSW (Hierarchical Navigable Small World) vector index for enquire-mcp.
//
// v2.13.0 — closes the "brute-force semantic search doesn't scale" gap. The
// existing path in `EmbedDb.search()` runs O(n) cosine over every embedded
// chunk per query (~5ms at 8K chunks, ~30ms at 50K, ~300ms at 500K, ~3s at
// 5M). HNSW is the IR-standard graph-based index that achieves O(log n)
// approximate nearest neighbor lookups — sub-10ms even at million-chunk
// scale, with recall@K ≥ 95% at default parameters (M=16, efConstruction=200).
//
// Architecture: in-memory rebuild on serve start.
//
// Persistence: SHIPPED in v2.16.0 — sidecar `.hnsw.bin` + `.hnsw.meta.json`
// next to `.embed.db`. Staleness check via `EmbedDb.computeSignature`.
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
// reference impl). Maintained by yoshoku since 2022, stable since v3.0
// (March 2024). Ships prebuilds for darwin-x64/arm64 + linux-x64/arm64
// + win32-x64; falls back to source build (requires C++ toolchain) on
// uncommon platforms. Lazy-loaded — same `optionalDependencies` pattern
// as tesseract.js / pdfjs-dist / @huggingface/transformers.
//
// (See "Historical note" above re: hnswlib-wasm vs hnswlib-node choice.)
//
// Performance characteristics on M1 Pro (cosine space, dim=384):
//   • Build: ~0.5ms per vector → 8K chunks ≈ 4s, 50K ≈ 25s, 500K ≈ 4min
//   • Query: ~0.5-1ms per top-10 lookup, independent of corpus size
//
// Recall@10 vs brute-force on the same corpus is consistently ≥98% at
// default params. Users tuning for max recall can pass `--hnsw-ef-search`
// to widen the search beam (default 100; higher = more accurate,
// slower).

import type { EmbedSearchHit } from "./embed-db.js";
import { optionalDepDetail } from "./optional-dep.js";

/** A single labeled vector — used to populate the index. */
export interface LabeledVector {
  /** Stable identifier — lets the search code recover the source row from the EmbedDb. */
  label: number;
  /** L2-normalized vector. Caller is responsible for the normalization. */
  vector: Float32Array;
}

/**
 * v2.16.0 — sidecar metadata persisted alongside the .hnsw.bin index. Used
 * for staleness detection on boot: if `signature` matches the current
 * embed-db's signature (computed by `EmbedDb.computeSignature()`), the
 * pre-built HNSW is loaded; otherwise it's rebuilt from scratch.
 *
 * Stored as JSON next to the binary index (`<file>.meta.json`). Keep this
 * format stable — bumping `formatVersion` invalidates all on-disk
 * indexes for users on the new version (they'll rebuild on next boot,
 * which is harmless but visible).
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
   * rebuilt. We use rowcount + max-id + dim as a tractable signature
   * (full content-hash would require reading every vector).
   */
  signature: string;
  /** Row label → source row map needed to reconstruct hits. JSON-friendly. */
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
   * start. Writes the binary index to `<file>.bin` and a JSON meta
   * sidecar to `<file>.meta.json` containing the embed-db signature,
   * dim, size, and label→row map. Returns true on successful write.
   *
   * Caller is responsible for choosing `file` (typically alongside the
   * embed-db with `.hnsw` suffix). We separate binary + meta files so
   * a partial write (e.g. crash mid-flush) leaves the meta missing,
   * which the loader treats as "no usable index" → rebuild from scratch.
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
   * "rebuild required" — there's no rollback path in hnswlib.
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
   * is synchronous (in-place re-allocation).
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
 * or the native binding failed to load (typically from a missing
 * prebuild for an uncommon platform — falls back to source build,
 * which requires a C++ toolchain).
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
async function loadHnswlib(): Promise<HnswlibNodeModule> {
  if (cachedModule) return cachedModule;
  try {
    const mod = (await import("hnswlib-node")) as { default?: HnswlibNodeModule } & Partial<HnswlibNodeModule>;
    // hnswlib-node ships as CJS with a default export; ESM consumers get
    // both `.default` and the named exports. Try both.
    const lib = mod.default ?? (mod as HnswlibNodeModule);
    if (typeof lib.HierarchicalNSW !== "function") {
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
  // (`applyDiff`, `resize`) are unavailable on the native lib (older
  // hnswlib-node, or some platforms with a missing prebuild), the index
  // is read-only and `size` stays at the buildHnsw-time value. When the
  // methods ARE available, the `size` getter delegates to
  // `ctor.getCurrentCount()` so callers always see the live count after
  // mutations. We probe once at wrap time.
  const hasLiveUpdate =
    typeof ctor.markDelete === "function" &&
    typeof ctor.getCurrentCount === "function" &&
    typeof ctor.getMaxElements === "function" &&
    typeof ctor.resizeIndex === "function";
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
      if (!hasLiveUpdate) {
        throw new Error("HnswIndex.resize: hnswlib-node native binding does not expose resizeIndex");
      }
      if (newMaxElements > ctor.getMaxElements()) {
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
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      // Write the binary index to <file>.bin and the JSON meta sidecar
      // to <file>.meta.json. We separate them so a partial-write (e.g.
      // crash mid-flush) leaves meta missing → loader rebuilds.
      await fs.mkdir(path.dirname(file), { recursive: true });
      const binFile = `${file}.bin`;
      const metaFile = `${file}.meta.json`;
      // hnswlib-node's writeIndex writes to a host filesystem path
      // directly — much simpler than the WASM Emscripten FS plumbing.
      await ctor.writeIndex(binFile);
      const meta: HnswPersistedMeta = {
        formatVersion: 1,
        dim,
        // v3.9.0-rc.11 (audit M1) — persist the LIVE element count after any
        // applyDiff, not the stale build-time `size` closure. After watcher
        // live updates the closure `size` is wrong; the live count comes from
        // the native getCurrentCount() (same source the `size` getter uses).
        size: hasLiveUpdate ? ctor.getCurrentCount() : size,
        signature,
        rowsByLabel: Object.fromEntries(rowsByLabel),
        writtenAt: new Date().toISOString()
      };
      await fs.writeFile(metaFile, JSON.stringify(meta, null, 2), "utf8");
      // v3.6.2 (audit M-7) — defense-in-depth: persist the user-only
      // 0600 mode on both sidecars, matching the canonical pattern in
      // src/embed-db.ts and src/fts5.ts. The parent dir is already
      // 0700 (created by EmbedDb.open before HNSW persistence runs),
      // but per-file invariants are what the SECURITY.md privacy
      // guarantees require — the .meta.json carries text_preview
      // snippets which are sensitive note content. Best-effort: on
      // platforms without POSIX mode bits (Windows / some FAT mounts)
      // chmod is a no-op or throws; we swallow either way because the
      // parent-dir guard is the real protection.
      await Promise.all([fs.chmod(binFile, 0o600).catch(() => {}), fs.chmod(metaFile, 0o600).catch(() => {})]);
      return true;
    }
  };
}

/**
 * v2.16.0 — load a previously-persisted HNSW index from disk. Returns
 * `null` (with a stderr warning) if:
 *   • Either the .bin or .meta.json file is missing
 *   • The meta's `signature` doesn't match the caller's current signature
 *   • The meta's `formatVersion` doesn't match
 *   • The meta's `dim` is not a positive integer (v3.8.0-rc.10 P3-27)
 *   • The meta's `size` is not a non-negative integer (v3.8.0-rc.10 P3-27)
 *   • The meta's `rowsByLabel` is not a plain object (v3.8.0-rc.10 P3-27)
 *   • The native lib fails to load the .bin (corrupt / dim mismatch)
 *
 * On success returns `{ index, rowsByLabel }` so the caller can wire
 * both into `searchHybrid`'s `hnsw` context without rebuilding from
 * scratch. Typical boot-time win: ~25s rebuild → ~50ms load on a
 * 50K-chunk vault.
 */
export async function loadHnswFromDisk(
  file: string,
  expectedSignature: string
): Promise<{ index: HnswIndex; rowsByLabel: Map<number, HnswPersistedMeta["rowsByLabel"][string]> } | null> {
  const fs = await import("node:fs/promises");
  const binFile = `${file}.bin`;
  const metaFile = `${file}.meta.json`;
  let metaRaw: string;
  try {
    metaRaw = await fs.readFile(metaFile, "utf8");
  } catch {
    return null; // No meta → no persisted index (or partial write).
  }
  let meta: HnswPersistedMeta;
  try {
    meta = JSON.parse(metaRaw) as HnswPersistedMeta;
  } catch (err) {
    process.stderr.write(
      `enquire: HNSW meta at ${metaFile} is malformed; rebuilding — ${err instanceof Error ? err.message : String(err)}\n`
    );
    return null;
  }
  if (meta.formatVersion !== 1) {
    process.stderr.write(
      `enquire: HNSW meta format ${meta.formatVersion} ≠ expected 1; rebuilding (this happens on enquire-mcp upgrade)\n`
    );
    return null;
  }
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
  // Bin file present?
  try {
    await fs.access(binFile);
  } catch {
    process.stderr.write(`enquire: HNSW meta exists but ${binFile} is missing; rebuilding\n`);
    return null;
  }
  // Load the native binary.
  const lib = await loadHnswlib();
  const ctor = new lib.HierarchicalNSW("cosine", meta.dim);
  try {
    await ctor.readIndex(binFile);
  } catch (err) {
    process.stderr.write(
      `enquire: HNSW readIndex failed at ${binFile}; rebuilding — ${err instanceof Error ? err.message : String(err)}\n`
    );
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
 * Convert HNSW search results to EmbedSearchHit using a label → source-row
 * lookup. The label was assigned by the caller at build time (typically
 * `EmbedDb.getAllVectors()` returns rows with sequential integer labels);
 * we just reverse the mapping. Distance → cosine similarity: cosine
 * distance is `1 - cosine_similarity`, so we flip back here so callers
 * can compare HNSW + brute-force scores apples-to-apples.
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
