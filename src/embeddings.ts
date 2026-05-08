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
