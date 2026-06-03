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
    autoTokenizerCtor = mod.AutoTokenizer;
    autoModelForSeqClsCtor = mod.AutoModelForSequenceClassification;
    return { AutoTokenizer: autoTokenizerCtor, AutoModelForSequenceClassification: autoModelForSeqClsCtor };
  } catch (err) {
    throw new Error(
      "Rerankers require the optional '@huggingface/transformers' dependency; install failed or the binding could not be loaded. " +
        "Run: npm install @huggingface/transformers (or reinstall enquire-mcp without --omit=optional). " +
        `Original error: ${err instanceof Error ? err.message : String(err)}`
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
export async function loadReranker(alias?: string): Promise<Reranker> {
  const model = resolveRerankerModel(alias);
  const { AutoTokenizer, AutoModelForSequenceClassification } = await loadTransformersForRerank();
  // q8 quantization keeps memory bounded and CPU-friendly. Models in our
  // catalog all ship q8 ONNX weights via Xenova/.
  const dtype = "q8" as const;
  const tokenizer = (await AutoTokenizer.from_pretrained(model.hfId)) as (
    text: string | string[],
    options: { text_pair: string | string[]; padding: boolean; truncation: boolean }
  ) => unknown;
  const seqCls = (await AutoModelForSequenceClassification.from_pretrained(model.hfId, { dtype })) as (
    inputs: unknown
  ) => Promise<{ logits: { data: Float32Array; dims: readonly number[] } }>;

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
