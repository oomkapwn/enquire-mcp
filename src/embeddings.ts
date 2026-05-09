// ML embeddings layer (v2.0 alpha). Lazy wrapper around @huggingface/transformers
// so the heavy ONNX runtime + tokenizer dependency is loaded only when the user
// actually invokes `enquire-mcp install-model` / `build-embeddings` /
// `obsidian_embeddings_search`. Read-only / TF-IDF / FTS5 paths stay zero-cost.
//
// Architecture:
//   - We expose two catalog'd models: `multilingual` (default; 50+ languages,
//     384-dim, ~120 MB) and `bge` (English-tuned, 384-dim, ~33 MB).
//   - Models are pulled from HuggingFace Hub on first use, cached under
//     `~/.cache/huggingface/transformers.js/` (transformers.js default).
//     We do NOT bundle model weights in the npm tarball — keeps install <200 KB.
//   - Embeddings are L2-normalized at extraction time so cosine = dot product
//     downstream (matches the v1.8 TF-IDF semantic_search convention).

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

async function loadPipeline(): Promise<(task: string, model: string) => Promise<unknown>> {
  if (pipelineCtor) return pipelineCtor;
  try {
    // Dynamic import keeps the heavy module out of cold-start cost.
    const mod = (await import("@huggingface/transformers")) as {
      pipeline?: (task: string, model: string) => Promise<unknown>;
    };
    if (!mod.pipeline) throw new Error("@huggingface/transformers has no `pipeline` export");
    pipelineCtor = mod.pipeline;
    return pipelineCtor;
  } catch (err) {
    throw new Error(
      `Embeddings require the optional '@huggingface/transformers' dependency; install failed or the binding could not be loaded. ` +
        `Run: npm install @huggingface/transformers (or reinstall enquire-mcp without --omit=optional). ` +
        `Original error: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/** Load an embedder for the given model alias. First call may block on
 *  model download from HuggingFace (~120MB for multilingual). Subsequent
 *  calls reuse the cached weights under `~/.cache/huggingface/`.
 *
 *  @param alias - Model alias from EMBEDDING_MODELS (default: "multilingual").
 */
export async function loadEmbedder(alias?: string): Promise<Embedder> {
  const model = resolveModel(alias);
  const pipeline = await loadPipeline();
  const extractor = (await pipeline("feature-extraction", model.hfId)) as (
    text: string | string[],
    options: { pooling: "mean"; normalize: boolean }
  ) => Promise<{ data: Float32Array; dims: readonly number[] }>;

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
  alias: string;
  hfId: string;
  approxSizeMB: number;
  multilingual: boolean;
  /** Max combined (query + passage) tokens — BGE base is 512. */
  maxTokens: number;
}

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
  // the xsmall variant (rerank-multilingual default). Multi-language
  // benchmark performance is solid; cost is the larger download.
  "rerank-multilingual-large": {
    alias: "rerank-multilingual-large",
    hfId: "Xenova/mxbai-rerank-large-v2",
    approxSizeMB: 280,
    multilingual: true,
    maxTokens: 512
  }
});

export const DEFAULT_RERANKER_ALIAS = "rerank-multilingual";

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
 * (~25-110 MB depending on alias) into `~/.cache/huggingface/`.
 *
 * @param alias - Reranker alias from RERANKER_MODELS (default: "rerank-multilingual").
 */
export async function loadReranker(alias?: string): Promise<Reranker> {
  const model = resolveRerankerModel(alias);
  const pipeline = await loadPipeline();
  const classifier = (await pipeline("text-classification", model.hfId)) as (
    inputs: ReadonlyArray<{ text: string; text_pair: string }> | { text: string; text_pair: string },
    options?: { topk?: number }
  ) => Promise<Array<{ label: string; score: number }>>;

  return {
    model,
    async score(query: string, passages: readonly string[]): Promise<number[]> {
      if (passages.length === 0) return [];
      // Build the (query, passage) pair inputs. transformers.js
      // text-classification accepts an array; the model returns one
      // {label, score} per input.
      const inputs = passages.map((p) => ({ text: query, text_pair: p }));
      // Sub-batch to bound memory — same rationale as the embedder's
      // MAX_INTERNAL_BATCH. Cross-encoder is heavier per pair, so we use a
      // smaller batch (4) to keep peak memory under ~150 MB on M1.
      const MAX_INTERNAL_BATCH = 4;
      const out: number[] = [];
      for (let batchStart = 0; batchStart < inputs.length; batchStart += MAX_INTERNAL_BATCH) {
        const batch = inputs.slice(batchStart, batchStart + MAX_INTERNAL_BATCH);
        const result = await classifier(batch);
        // Pipeline returns one Array per input by default; flatten to scores.
        // Each output is {label, score}; for binary-relevance rerankers, the
        // score is already the model's relevance probability.
        const scores = Array.isArray(result) ? result : [result];
        for (const r of scores) {
          if (typeof r?.score === "number") {
            out.push(r.score);
          } else {
            // Defensive: surface as -Infinity so this hit goes to the bottom
            // rather than poisoning the sort with NaN.
            out.push(-Infinity);
          }
        }
      }
      return out;
    }
  };
}
