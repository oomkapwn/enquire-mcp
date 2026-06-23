// ML embeddings layer (v2.0 alpha). Lazy wrapper around @huggingface/transformers
// so the heavy ONNX runtime + tokenizer dependency is loaded only when the user
// actually invokes `enquire-mcp install-model` / `build-embeddings` /
// `obsidian_embeddings_search`. Read-only / TF-IDF / FTS5 paths stay zero-cost.
//
// Architecture:
//   - We expose two catalog'd models: `multilingual` (default; 50+ languages,
//     384-dim, ~120 MB) and `bge` (English-tuned, 384-dim, ~33 MB).
//   - Models are pulled from HuggingFace Hub on first use, cached by
//     transformers.js under its OWN package dir — `<install>/node_modules/
//     @huggingface/transformers/.cache/Xenova/…`. Resolve it at runtime via
//     `resolveTransformersCacheDir()`; do NOT hardcode `~/.cache/huggingface`
//     (the older HF-Hub convention transformers.js v3 does NOT use by default).
//     We do NOT bundle model weights in the npm tarball — keeps install <200 KB.
//   - Embeddings are L2-normalized at extraction time so cosine = dot product
//     downstream (matches the v1.8 TF-IDF semantic_search convention).

import { createRequire } from "node:module";
import * as path from "node:path";
import { optionalDepDetail } from "./optional-dep.js";

/** Catalog of embedding models supported by enquire. Add new entries by
 *  pinning the Xenova-converted ONNX model id + the dim count + a friendly
 *  alias users pass on the CLI. */
export interface EmbeddingModel {
  /** CLI-friendly alias passed via `--embedding-model <alias>`. */
  alias: string;
  /** HuggingFace model id (Xenova-converted to ONNX). */
  hfId: string;
  /** Output vector dimensionality (384 for MiniLM family). */
  dim: number;
  /** Approximate disk footprint in MB after download, for progress messages. */
  approxSizeMB: number;
  /** True if this model has been trained on multilingual data. */
  multilingual: boolean;
  /** Maximum input tokens before transformers.js truncates. */
  maxTokens: number;
}

/**
 * Catalog of supported embedding models, keyed by CLI-friendly alias.
 * Add new entries by pinning the Xenova-converted ONNX model id, dim
 * count, and approximate download size. Frozen at module load so
 * runtime can't accidentally mutate.
 */
export const EMBEDDING_MODELS: Readonly<Record<string, EmbeddingModel>> = Object.freeze({
  multilingual: {
    alias: "multilingual",
    hfId: "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
    dim: 384,
    approxSizeMB: 120,
    multilingual: true,
    maxTokens: 128
  },
  bge: {
    alias: "bge",
    hfId: "Xenova/bge-small-en-v1.5",
    dim: 384,
    approxSizeMB: 33,
    multilingual: false,
    maxTokens: 512
  }
});

/** Default model alias when the user doesn't pass `--embedding-model`. */
export const DEFAULT_MODEL_ALIAS = "multilingual";

/**
 * Pure helper: given the resolved main entry of `@huggingface/transformers`
 * (as returned by `require.resolve("@huggingface/transformers")`), derive the
 * package's `.cache` directory — the location transformers.js v3 uses for
 * downloaded model weights (`<pkg>/.cache/Xenova/<model-id>/`).
 *
 * Works for BOTH layouts npm produces:
 *   - hoisted:  `<root>/node_modules/@huggingface/transformers/dist/…`
 *   - nested:   `<root>/node_modules/@oomkapwn/enquire-mcp/node_modules/
 *                @huggingface/transformers/dist/…`  ← global-install case
 * by slicing at the LAST `node_modules/@huggingface/transformers` segment
 * (innermost wins, matching Node's own resolution).
 *
 * @param resolvedMain Absolute path to the transformers main module.
 * @returns The `.cache` dir path, or `null` if the marker isn't present.
 * @example deriveTransformersCacheDir("/a/node_modules/@huggingface/transformers/dist/x.cjs")
 *   // → "/a/node_modules/@huggingface/transformers/.cache"
 */
export function deriveTransformersCacheDir(resolvedMain: string): string | null {
  const marker = path.join("node_modules", "@huggingface", "transformers");
  const idx = resolvedMain.lastIndexOf(marker);
  if (idx < 0) return null;
  return path.join(resolvedMain.slice(0, idx + marker.length), ".cache");
}

/**
 * Resolve the directory where transformers.js actually caches model weights on
 * THIS install — resolved relative to the running module (so it is correct for
 * a global `npm i -g` install, where the model lives inside the package's own
 * nested `node_modules`, NOT under `~/.cache/huggingface`).
 *
 * This is the single source of truth for the model-cache path: `doctor`'s
 * health probe and `install-model`'s "cached under …" message both call it, so
 * the diagnostic and the success message can never disagree with reality
 * (the v3.9.1 bug-report Issues 1 + 2: doctor false-negative + wrong path).
 *
 * Resolution-only — does NOT import/load the ONNX runtime, so it keeps the
 * `doctor` fast-read-only promise. Returns `null` if the optional dependency
 * isn't installed (resolve throws → caught).
 *
 * @returns Absolute `.cache` dir path, or `null` if transformers isn't installed.
 */
export function resolveTransformersCacheDir(): string | null {
  try {
    const req = createRequire(import.meta.url);
    return deriveTransformersCacheDir(req.resolve("@huggingface/transformers"));
  } catch {
    return null;
  }
}

/**
 * Look up an entry in the {@link EMBEDDING_MODELS} catalog. Throws with
 * a list of known aliases if the input is unknown — surfaces typos at
 * CLI parse time rather than after a 120MB model download.
 *
 * @param alias - Model alias, or `undefined` for the default ({@link DEFAULT_MODEL_ALIAS}).
 * @returns The matching {@link EmbeddingModel} entry.
 * @throws {Error} If `alias` isn't a known catalog key.
 */
export function resolveModel(alias: string | undefined): EmbeddingModel {
  const key = alias ?? DEFAULT_MODEL_ALIAS;
  const model = EMBEDDING_MODELS[key];
  if (!model) {
    const known = Object.keys(EMBEDDING_MODELS).join(", ");
    throw new Error(`Unknown embedding model alias '${key}'. Known aliases: ${known}.`);
  }
  return model;
}

/** Opaque handle for a loaded embedder. Constructed via `loadEmbedder()`. */
export interface Embedder {
  readonly model: EmbeddingModel;
  /** Embed a batch of texts. Each text is L2-normalized; output is one
   *  Float32Array per input, length === model.dim. */
  embed(texts: readonly string[]): Promise<Float32Array[]>;
}

// Lazy-loaded transformers.js pipeline so the heavy ONNX runtime + sharp +
// tokenizer transitive deps surface only when the user actually invokes an
// embeddings codepath. Mirrors the better-sqlite3 lazy-load in src/fts5.ts.
let pipelineCtor: ((task: string, model: string) => Promise<unknown>) | null = null;
let autoTokenizerCtor: { from_pretrained: (id: string, opts?: unknown) => Promise<unknown> } | null = null;
let autoModelForSeqClsCtor: { from_pretrained: (id: string, opts?: unknown) => Promise<unknown> } | null = null;

// v3.10.0-rc.42 (audit F1, HIGH) — serve-mode offline ENFORCEMENT for the embedder +
// reranker model load. README/llms.txt/SECURITY.md claim "zero cloud calls during serve";
// pre-rc.42 that was ASPIRATIONAL — a missing local cache let transformers.js silently
// CDN-fetch (~120MB) on a serve-time query. This makes the claim a real CODE GUARD,
// mirroring OCR's `assertOcrLangsInstalled` (overclaim #16). serve/serve-http call
// setEmbeddingsOffline() at startup → transformers.js `env.allowRemoteModels=false` →
// a model absent from the LOCAL cache fails CLOSED with an install hint instead of
// fetching. build-embeddings / install-model never call the setter, so the one-time
// online download path is unchanged.
let embeddingsOffline = false;
export function setEmbeddingsOffline(on = true): void {
  embeddingsOffline = on;
}
export function isEmbeddingsOffline(): boolean {
  return embeddingsOffline;
}
/** Force transformers.js to local-cache-only when serve has set the offline flag.
 *  Idempotent; a no-op when online (build-embeddings).
 *  v3.11.0-rc.12 (rc.11-audit L-2) — exported so a unit test asserts the WIRE-UP
 *  (a transformers.js-shaped `{ env }` actually gets `allowRemoteModels=false`),
 *  not merely that `setEmbeddingsOffline` flips the flag. */
export function applyOfflineEnv(mod: unknown): void {
  if (!embeddingsOffline) return;
  const env = (mod as { env?: { allowRemoteModels?: boolean; allowLocalModels?: boolean } }).env;
  if (env) {
    env.allowRemoteModels = false; // local cache only — no outbound CDN fetch during serve
    env.allowLocalModels = true;
  }
}
/** v3.10.0-rc.42 (F1) — translate a serve-offline model-load failure (with
 *  allowRemoteModels=false the CDN fallback is blocked, so a failure is almost always a
 *  cache miss) into an actionable fail-closed error. Pure → unit-testable without a model. */
export function offlineModelLoadError(alias: string, hfId: string, _original: unknown): Error {
  // rc.45 (abs-path-leak class) — do NOT interpolate the raw transformers.js cause into
  // the client-facing message: an offline cache-miss error embeds the ABSOLUTE model-cache
  // path (host home dir). The install hint is the actionable part; `_original` is kept in
  // the signature for call-site stability but deliberately not surfaced to the client.
  return new Error(
    `Model "${alias}" (${hfId}) is not in the local model cache, and serve mode makes zero outbound ` +
      `network calls (privacy — your vault never reaches the network). Pre-download the model in an ` +
      `online context (e.g. \`enquire build-embeddings\` for the embedder, or one reranker query) ` +
      `before serving, then restart.`
  );
}

async function loadPipeline(): Promise<(task: string, model: string) => Promise<unknown>> {
  if (pipelineCtor) return pipelineCtor;
  try {
    // Dynamic import keeps the heavy module out of cold-start cost.
    const mod = (await import("@huggingface/transformers")) as {
      pipeline?: (task: string, model: string) => Promise<unknown>;
    };
    if (!mod.pipeline) throw new Error("@huggingface/transformers has no `pipeline` export");
    applyOfflineEnv(mod); // rc.42 F1 — serve sets local-cache-only before any model load
    pipelineCtor = mod.pipeline;
    return pipelineCtor;
  } catch (err) {
    throw new Error(
      `Embeddings require the optional '@huggingface/transformers' dependency; install failed or the binding could not be loaded. ` +
        `Run: npm install @huggingface/transformers (or reinstall enquire-mcp without --omit=optional). ` +
        // rc.55 (OPTDEP-MODULE-PATH-LEAK-02) — code only; err.message embeds the importing file's abs path.
        `(${optionalDepDetail(err)})`
    );
  }
}

/**
 * v3.6.0-rc.4 P0 fix — load `AutoTokenizer` + `AutoModelForSequenceClassification`
 * directly from `@huggingface/transformers`. Reason: the high-level
 * `text-classification` pipeline applies softmax over the model's
 * classification head. BGE-reranker family (and the other sigmoid-head
 * cross-encoders we ship) have a SINGLE output class — softmax over 1
 * class is always 1.0 by definition, so the pipeline returns
 * `{ label: "LABEL_0", score: 1 }` for every input regardless of
 * relevance. Empirically verified on `Xenova/bge-reranker-base`.
 *
 * Direct inference: tokenize the (query, passage) pair, run the model,
 * read the raw logit from `logits.data[0]`, apply sigmoid to map to
 * [0, 1]. Yields meaningful relevance scoring.
 *
 * Tests/regression catch: `tests/reranker.test.ts` previously used a
 * mock `rerankerOverride` so the bug never surfaced. v3.6.0-rc.4 adds
 * an opt-in real-model smoke test that exercises this codepath.
 */
async function loadTransformersForRerank(): Promise<{
  AutoTokenizer: { from_pretrained: (id: string, opts?: unknown) => Promise<unknown> };
  AutoModelForSequenceClassification: { from_pretrained: (id: string, opts?: unknown) => Promise<unknown> };
}> {
  if (autoTokenizerCtor && autoModelForSeqClsCtor) {
    return { AutoTokenizer: autoTokenizerCtor, AutoModelForSequenceClassification: autoModelForSeqClsCtor };
  }
  try {
    const mod = (await import("@huggingface/transformers")) as {
      AutoTokenizer?: { from_pretrained: (id: string, opts?: unknown) => Promise<unknown> };
      AutoModelForSequenceClassification?: { from_pretrained: (id: string, opts?: unknown) => Promise<unknown> };
    };
    if (!mod.AutoTokenizer || !mod.AutoModelForSequenceClassification) {
      throw new Error(
        "@huggingface/transformers has no `AutoTokenizer` / `AutoModelForSequenceClassification` exports"
      );
    }
    applyOfflineEnv(mod); // rc.42 F1 — serve sets local-cache-only before any reranker load
    autoTokenizerCtor = mod.AutoTokenizer;
    autoModelForSeqClsCtor = mod.AutoModelForSequenceClassification;
    return { AutoTokenizer: autoTokenizerCtor, AutoModelForSequenceClassification: autoModelForSeqClsCtor };
  } catch (err) {
    throw new Error(
      "Rerankers require the optional '@huggingface/transformers' dependency; install failed or the binding could not be loaded. " +
        "Run: npm install @huggingface/transformers (or reinstall enquire-mcp without --omit=optional). " +
        // rc.55 (OPTDEP-MODULE-PATH-LEAK-02) — code only; err.message embeds the importing file's abs path.
        `(${optionalDepDetail(err)})`
    );
  }
}

/** Load an embedder for the given model alias. First call may block on
 *  model download from HuggingFace (~120MB for multilingual). Subsequent
 *  calls reuse the cached weights from the transformers.js package cache
 *  (resolve the exact path via `resolveTransformersCacheDir()`).
 *
 *  @param alias - Model alias from EMBEDDING_MODELS (default: "multilingual").
 */
const embedderCache = new Map<string, Promise<Embedder>>();

// v3.10.0-rc.38 (audit #2) — cache the loaded handle (the heavy ONNX
// InferenceSession) per alias so it's built ONCE per process, not rebuilt on
// every embeddings query. Pre-rc.38 each obsidian_search re-parsed the ~120MB
// embedder graph (hundreds of ms + a transient native alloc per query; N
// concurrent queries → N simultaneous sessions). The PROMISE-cache also collapses
// a concurrent first-load thundering-herd; a rejected load is evicted so a later
// call can retry rather than be stuck with a permanently-failed promise.
export async function loadEmbedder(alias?: string): Promise<Embedder> {
  const model = resolveModel(alias);
  const hit = embedderCache.get(model.alias);
  if (hit) return hit;
  const built = buildEmbedder(model);
  embedderCache.set(model.alias, built);
  built.catch(() => embedderCache.delete(model.alias));
  return built;
}

async function buildEmbedder(model: EmbeddingModel): Promise<Embedder> {
  const pipeline = await loadPipeline();
  let extractor: (
    text: string | string[],
    options: { pooling: "mean"; normalize: boolean }
  ) => Promise<{ data: Float32Array; dims: readonly number[] }>;
  try {
    extractor = (await pipeline("feature-extraction", model.hfId)) as typeof extractor;
  } catch (err) {
    // rc.42 F1 — under serve-offline, a load failure is a cache miss (CDN blocked); fail closed with a hint.
    throw embeddingsOffline ? offlineModelLoadError(model.alias, model.hfId, err) : err;
  }

  // v2.0.0-beta.4: cap internal batch size to avoid pathological embedder
  // hangs on notes with many chunks. Real-vault smoke (128 notes) hung at
  // 75% CPU for 13+ minutes when an unbounded batch of ~50 chunks was sent
  // in one extractor() call. ONNX runtime can degrade catastrophically on
  // large input batches. 8 keeps memory bounded (~3KB per L2-normed Float32
  // dim=384 vector + token-tensor scratch space) and progress smoothly.
  const MAX_INTERNAL_BATCH = 8;

  const dim = model.dim;
  return {
    model,
    async embed(texts: readonly string[]): Promise<Float32Array[]> {
      if (texts.length === 0) return [];
      const out: Float32Array[] = [];
      // Sub-batch internally so a single note with N chunks doesn't stall
      // the entire pipeline. Caller still gets a flat Float32Array[].
      for (let batchStart = 0; batchStart < texts.length; batchStart += MAX_INTERNAL_BATCH) {
        const batch = texts.slice(batchStart, batchStart + MAX_INTERNAL_BATCH);
        const tensor = await extractor([...batch], { pooling: "mean", normalize: true });
        if (tensor.dims[1] !== dim) {
          throw new Error(
            `Model ${model.hfId} produced dim=${tensor.dims[1]}, expected ${dim}. EMBEDDING_MODELS catalog is stale.`
          );
        }
        for (let i = 0; i < batch.length; i++) {
          const start = i * dim;
          // Copy the slice — the underlying buffer is reused by transformers.js.
          out.push(new Float32Array(tensor.data.slice(start, start + dim)));
        }
      }
      return out;
    }
  };
}

/** Cosine similarity between two L2-normalized vectors (= dot product). */
export function cosineSim(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`cosine: dim mismatch ${a.length} vs ${b.length}`);
  }
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    s += (a[i] ?? 0) * (b[i] ?? 0);
  }
  return s;
}

// ─── v2.9.0 — BGE cross-encoder reranker support ────────────────────────────
//
// Cross-encoder reranking is the SOTA technique for boosting retrieval
// quality over bi-encoder (= our embedding) candidates. The flow:
//   1. Hybrid retrieval (BM25 + TF-IDF + embeddings, RRF) returns top-N (~50).
//   2. Cross-encoder scores each (query, snippet) pair → relevance score.
//   3. Re-sort by cross-encoder score, return top-K.
//
// Why cross-encoder is more accurate than bi-encoder for re-ranking:
//   • Bi-encoders embed query and document separately, then dot-product.
//     Information about query-document interaction is lost at embedding time.
//   • Cross-encoders concatenate (query, document) and run them through the
//     model jointly — query-document term interactions are modeled directly.
//   • Trade-off: cross-encoder is 100-1000x more expensive per pair, so we
//     only run it on the small RRF-fused candidate set, not the full vault.
//
// This module wraps `@huggingface/transformers`'s text-classification pipeline
// in a thin `Reranker` interface — the pipeline returns a single score in
// [0, 1] per (query, passage) pair (BGE rerankers are trained as binary
// relevance classifiers; higher = more relevant).

/** BGE reranker model catalog — analogous to `EMBEDDING_MODELS`. */
export interface RerankerModel {
  /** CLI-friendly alias passed via `--reranker-model <alias>`. */
  alias: string;
  /** HuggingFace model id (Xenova-converted to ONNX). */
  hfId: string;
  /** Approximate disk footprint in MB after download. */
  approxSizeMB: number;
  /** True if trained on multilingual data. */
  multilingual: boolean;
  /** Max combined (query + passage) tokens — BGE base is 512. */
  maxTokens: number;
}

/**
 * Catalog of supported cross-encoder reranker models, keyed by CLI alias.
 * Each entry trades off quality vs latency vs download size; see comments
 * inline for guidance. Frozen at module load.
 */
export const RERANKER_MODELS: Readonly<Record<string, RerankerModel>> = Object.freeze({
  // BGE-reranker-base — English, ~110 MB. Latency ~30-50ms per pair on M1 CPU.
  "rerank-bge": {
    alias: "rerank-bge",
    hfId: "Xenova/bge-reranker-base",
    approxSizeMB: 110,
    multilingual: false,
    maxTokens: 512
  },
  // mxbai-rerank-xsmall-v1 — multilingual, ~25 MB, much faster than BGE-base.
  // Better default for users on slower hardware or larger candidate sets.
  // Cited in MTEB leaderboard as comparable to BGE-base on English while
  // staying multilingual.
  "rerank-multilingual": {
    alias: "rerank-multilingual",
    hfId: "Xenova/mxbai-rerank-xsmall-v1",
    approxSizeMB: 25,
    multilingual: true,
    maxTokens: 512
  },
  // v3.3.0 — additional reranker options for users who want different
  // size/quality/language tradeoffs.
  //
  // BGE-reranker-large — English, ~560 MB. Larger than rerank-bge with
  // higher quality (often +1-2 NDCG@10 vs base). Use when retrieval
  // quality matters more than memory.
  "rerank-bge-large": {
    alias: "rerank-bge-large",
    hfId: "Xenova/bge-reranker-large",
    approxSizeMB: 560,
    multilingual: false,
    maxTokens: 512
  },
  // jina-reranker-v1-tiny-en — English, ~33 MB. Faster than rerank-bge
  // (the "tiny" reranker), comparable quality on shorter passages.
  // Good when reranker latency is the bottleneck.
  "rerank-jina-tiny": {
    alias: "rerank-jina-tiny",
    hfId: "Xenova/jina-reranker-v1-tiny-en",
    approxSizeMB: 33,
    multilingual: false,
    maxTokens: 512
  },
  // mxbai-rerank-large-v2 — multilingual, ~280 MB. Higher quality than
  // the xsmall `rerank-multilingual` (which is the multilingual variant,
  // NOT the project-wide default — see `DEFAULT_RERANKER_ALIAS` below; it
  // was bumped to `rerank-bge` in v3.6.1 CRIT-2 because 4 of 5 catalog
  // aliases fail at `AutoTokenizer.from_pretrained` due to a
  // transformers.js compat issue). Multi-language benchmark performance
  // is solid; cost is the larger download.
  "rerank-multilingual-large": {
    alias: "rerank-multilingual-large",
    hfId: "Xenova/mxbai-rerank-large-v2",
    approxSizeMB: 280,
    multilingual: true,
    maxTokens: 512
  }
});

// v3.6.1 CRIT-2 — was "rerank-multilingual" but per v3.6.0 CHANGELOG, only
// `rerank-bge` is verified working end-to-end. The 4 other catalog aliases
// fail at `AutoTokenizer.from_pretrained` due to a transformers.js compat
// issue (tracked for v3.7). Defaulting to a broken alias meant every
// `--enable-reranker` user (without `--reranker-model rerank-bge`) silently
// got NO reranking despite the marketing claim "+5-10 NDCG@10". External
// audit (anonymous) caught this.
export const DEFAULT_RERANKER_ALIAS = "rerank-bge";

/**
 * Look up an entry in the {@link RERANKER_MODELS} catalog. Throws with
 * a list of known aliases if the input is unknown.
 *
 * @param alias - Reranker alias, or `undefined` for the default
 *   ({@link DEFAULT_RERANKER_ALIAS}).
 * @returns The matching {@link RerankerModel} entry.
 * @throws {Error} If `alias` isn't a known catalog key.
 */
export function resolveRerankerModel(alias: string | undefined): RerankerModel {
  const key = alias ?? DEFAULT_RERANKER_ALIAS;
  const model = RERANKER_MODELS[key];
  if (!model) {
    const known = Object.keys(RERANKER_MODELS).join(", ");
    throw new Error(`Unknown reranker model alias '${key}'. Known aliases: ${known}.`);
  }
  return model;
}

/** Opaque handle for a loaded reranker. Constructed via `loadReranker()`. */
export interface Reranker {
  readonly model: RerankerModel;
  /**
   * Score (query, passage) pairs. Higher = more relevant. BGE rerankers
   * return logits in roughly [-10, +10]; we apply sigmoid to get [0, 1] for
   * comparable scoring across models. Truncation of overly-long passages
   * is the model's responsibility (it'll silently chop at maxTokens).
   *
   * Returns one score per passage in input order.
   */
  score(query: string, passages: readonly string[]): Promise<number[]>;
}

/**
 * Load a BGE-style cross-encoder reranker. Lazy-imports
 * `@huggingface/transformers` on first call (same lazy-load pattern as
 * `loadEmbedder`). Cold-start downloads the model from HuggingFace
 * (~25-110 MB depending on alias) into the transformers.js package cache
 * (resolve the exact path via `resolveTransformersCacheDir()`).
 *
 * **v3.6.0-rc.4 P0 fix.** Previously used the high-level
 * `text-classification` pipeline, which softmax'es over the model's
 * classification head. BGE-style rerankers have a SINGLE output class
 * (relevance logit) — softmax over 1 class is always 1.0, so the
 * pipeline returned `score: 1.0` for every input. **The reranker was
 * effectively a no-op.** Hidden because `tests/reranker.test.ts` used a
 * mock `rerankerOverride` that never exercised the real model. Now
 * fixed: direct tokenizer + model inference + sigmoid maps the raw
 * relevance logit to [0, 1].
 *
 * @param alias - Reranker alias from RERANKER_MODELS (default: "rerank-bge" — `DEFAULT_RERANKER_ALIAS`).
 */
const rerankerCache = new Map<string, Promise<Reranker>>();

// v3.10.0-rc.38 (audit #2) — same handle-cache as loadEmbedder: the BGE
// cross-encoder ONNX session is ~110MB and `--enable-reranker` rebuilt it on
// EVERY search pre-rc.38. (The `rerankerOverride` test seam in search.ts bypasses
// this entirely, so it's unaffected.)
export async function loadReranker(alias?: string): Promise<Reranker> {
  const model = resolveRerankerModel(alias);
  const hit = rerankerCache.get(model.alias);
  if (hit) return hit;
  const built = buildReranker(model);
  rerankerCache.set(model.alias, built);
  built.catch(() => rerankerCache.delete(model.alias));
  return built;
}

async function buildReranker(model: RerankerModel): Promise<Reranker> {
  const { AutoTokenizer, AutoModelForSequenceClassification } = await loadTransformersForRerank();
  // q8 quantization keeps memory bounded and CPU-friendly. Models in our
  // catalog all ship q8 ONNX weights via Xenova/.
  const dtype = "q8" as const;
  let tokenizer: (
    text: string | string[],
    options: { text_pair: string | string[]; padding: boolean; truncation: boolean }
  ) => unknown;
  let seqCls: (inputs: unknown) => Promise<{ logits: { data: Float32Array; dims: readonly number[] } }>;
  try {
    tokenizer = (await AutoTokenizer.from_pretrained(model.hfId)) as typeof tokenizer;
    seqCls = (await AutoModelForSequenceClassification.from_pretrained(model.hfId, { dtype })) as typeof seqCls;
  } catch (err) {
    // rc.42 F1 — under serve-offline, a load failure is a cache miss (CDN blocked); fail closed with a hint.
    throw embeddingsOffline ? offlineModelLoadError(model.alias, model.hfId, err) : err;
  }

  // Sub-batch size: cross-encoder is heavier per pair than encoder-only;
  // 4 keeps peak memory under ~280 MB on M1 with q8 + the largest model
  // (mxbai multilingual ~280 MB).
  const MAX_INTERNAL_BATCH = 4;

  return {
    model,
    async score(query: string, passages: readonly string[]): Promise<number[]> {
      if (passages.length === 0) return [];
      const out: number[] = [];
      for (let batchStart = 0; batchStart < passages.length; batchStart += MAX_INTERNAL_BATCH) {
        const batch = passages.slice(batchStart, batchStart + MAX_INTERNAL_BATCH);
        // Batched tokenization: each pair is (query, passage_i). transformers.js
        // accepts parallel arrays for the second positional + the text_pair
        // option. padding:true pads to the longest sequence in the batch;
        // truncation:true clips to the model's max position (typically 512).
        const queries = new Array<string>(batch.length).fill(query);
        const inputs = tokenizer(queries, { text_pair: [...batch], padding: true, truncation: true });
        const { logits } = await seqCls(inputs);
        // For a 1-class sigmoid head: logits shape [batch, 1] → flat
        // Float32Array of length batch. Map each logit through sigmoid to
        // get a [0, 1] relevance score that's comparable across queries.
        for (let i = 0; i < batch.length; i++) {
          const raw = logits.data[i];
          if (typeof raw !== "number" || Number.isNaN(raw)) {
            // Defensive: -Infinity puts the hit at the bottom of the sort
            // rather than poisoning order with NaN.
            out.push(-Infinity);
            continue;
          }
          // Sigmoid: 1 / (1 + exp(-x)). Stable for extreme magnitudes
          // because exp(-large) → 0 and exp(-very-negative) → +∞ both
          // clamp gracefully (the latter overflows to Infinity and the
          // division yields 0, which is the correct relevance for a
          // strongly-negative logit).
          out.push(1 / (1 + Math.exp(-raw)));
        }
      }
      return out;
    }
  };
}
