import * as path from "node:path";
import type { FtsIndex } from "../fts5.js";
import type { FileEntry, Vault } from "../vault.js";
import { findBestMatch, intersectionSize, jaccard, ngrams, stripMd } from "./meta.js";
import { resolveTarget } from "./write.js";

export type SearchMode = "all" | "any" | "phrase";

export interface SearchHit {
  path: string;
  snippet: string;
  score: number;
  line: number;
  matched_terms: string[];
}

export interface SearchResponse {
  query: string;
  mode: SearchMode;
  scanned_notes: number;
  matches: SearchHit[];
}

export async function searchText(
  vault: Vault,
  args: { query: string; folder?: string; limit?: number; mode?: SearchMode }
): Promise<SearchResponse> {
  await vault.ensureExists();
  const limit = args.limit ?? 25;
  const mode: SearchMode = args.mode ?? "all";
  const q = args.query;
  if (!q.trim()) throw new Error("query must not be empty");

  // Tokenize on whitespace for "all" / "any". Phrase mode keeps the raw query.
  const tokens = mode === "phrase" ? [q] : q.trim().split(/\s+/);
  const lowerTokens = tokens.map((t) => t.toLowerCase());

  const entries = await vault.listMarkdown(args.folder);

  // Parallel file reads — was sequential, slow on large vaults. Chunk to
  // bound concurrency (avoid blowing the open-fd limit on huge vaults).
  const CHUNK = 16;
  const matches: SearchHit[] = [];
  for (let i = 0; i < entries.length; i += CHUNK) {
    const chunk = entries.slice(i, i + CHUNK);
    const results = await Promise.all(
      chunk.map(async (e) => {
        const { content } = await vault.readNote(e.absPath, e.mtimeMs);
        const lower = content.toLowerCase();
        let totalScore = 0;
        let firstHit = -1;
        let firstHitLen = 0;
        const matched: string[] = [];
        for (let t = 0; t < lowerTokens.length; t++) {
          const lowerT = lowerTokens[t];
          if (lowerT === undefined || lowerT === "") continue;
          let tokenScore = 0;
          let from = 0;
          while (true) {
            const idx = lower.indexOf(lowerT, from);
            if (idx === -1) break;
            tokenScore += 1;
            if (firstHit === -1 || idx < firstHit) {
              firstHit = idx;
              firstHitLen = lowerT.length;
            }
            from = idx + lowerT.length;
          }
          if (tokenScore > 0) {
            totalScore += tokenScore;
            matched.push(tokens[t] ?? lowerT);
          }
        }
        // Mode policy: "all" requires every token to match; "any" requires at
        // least one; "phrase" requires the raw query (single token).
        if (mode === "all" && matched.length !== lowerTokens.filter(Boolean).length) return null;
        if (totalScore === 0) return null;
        const { snippet, line } = sliceSnippet(content, firstHit, firstHitLen);
        const hit: SearchHit = {
          path: e.relPath,
          snippet,
          score: totalScore,
          line,
          matched_terms: matched
        };
        return hit;
      })
    );
    for (const r of results) if (r) matches.push(r);
  }
  matches.sort((a, b) => b.score - a.score);
  return {
    query: q,
    mode,
    scanned_notes: entries.length,
    matches: matches.slice(0, limit)
  };
}

// ─── obsidian_find_similar (v0.13 lexical-hybrid similarity) ─────────────────
// Given a note, rank other notes in the vault by how related they are. This is
// hybrid retrieval done with vault-native signals — no embeddings, no model
// download, no native dep — just the same structural metadata an Obsidian user
// already curates: tags, headings, link graph, and word overlap.
//
// Score = weighted sum of four signals, all in [0,1]:
//   • tag_jaccard       — |A.tags ∩ B.tags| / |A.tags ∪ B.tags|         (×3.0)
//   • title_3gram       — character 3-gram Jaccard of basenames         (×1.5)
//   • shared_outbound   — % of A's outbound links also in B's outbound  (×2.0)
//   • co_backlink       — % of X with X→A AND X→B (over union)          (×2.0)
//
// Body cosine isn't included: at vault scale (~5k notes × ~5KB each) a full
// TF-IDF pass is OK, but the structural signals above already converge on the
// notes a human would call "related" without paying that cost on every call.

export interface SimilarNote {
  path: string;
  title: string;
  score: number;
  signals: {
    tag_jaccard: number;
    title_3gram: number;
    shared_outbound: number;
    co_backlink: number;
  };
  shared_tags: string[];
  mtime: string;
}

export async function findSimilar(
  vault: Vault,
  args: { path?: string; title?: string; limit?: number; min_score?: number }
): Promise<SimilarNote[]> {
  await vault.ensureExists();
  const limit = args.limit ?? 10;
  const minScore = args.min_score ?? 0.05;
  const target = await resolveTarget(vault, args);
  const entries = await vault.listMarkdown();

  // Pre-extract metadata for all notes including the target.
  type NoteMeta = {
    entry: FileEntry;
    tags: Set<string>;
    title3grams: Set<string>;
    outbound: Set<string>; // resolved relPaths this note links to
  };
  const metas = new Map<string, NoteMeta>();
  for (const e of entries) {
    const { parsed } = await vault.readNote(e.absPath, e.mtimeMs);
    const tags = new Set(parsed.tags.map((t) => t.toLowerCase()));
    const title3grams = ngrams(stripMd(e.basename).toLowerCase(), 3);
    const outbound = new Set<string>();
    for (const link of parsed.wikilinks) {
      const m = findBestMatch(entries, link.target, e.relPath);
      if (m) outbound.add(m.relPath);
    }
    metas.set(e.relPath, { entry: e, tags, title3grams, outbound });
  }

  const targetMeta = metas.get(target.relPath);
  if (!targetMeta) {
    // The target was found by resolveTarget but may have been excluded from
    // listMarkdown by --exclude-glob. Treat as zero results rather than crash.
    return [];
  }

  // For co-backlink: build "who links to X?" for everyone we care about
  // (target + all candidates). Single pass over outbound sets.
  const inboundFor = new Map<string, Set<string>>();
  for (const [from, m] of metas) {
    for (const to of m.outbound) {
      const set = inboundFor.get(to) ?? new Set();
      set.add(from);
      inboundFor.set(to, set);
    }
  }
  const targetInbound = inboundFor.get(target.relPath) ?? new Set();

  const out: SimilarNote[] = [];
  for (const [relPath, m] of metas) {
    if (relPath === target.relPath) continue;
    const tagJ = jaccard(targetMeta.tags, m.tags);
    const titleJ = jaccard(targetMeta.title3grams, m.title3grams);
    const candInbound = inboundFor.get(relPath) ?? new Set();
    // shared_outbound: how much of A's outbound is also in B's
    const sharedOut =
      targetMeta.outbound.size === 0 ? 0 : intersectionSize(targetMeta.outbound, m.outbound) / targetMeta.outbound.size;
    // co_backlink: how many notes link to both target and candidate, over union
    const coBack = jaccard(targetInbound, candInbound);

    const score = 3.0 * tagJ + 1.5 * titleJ + 2.0 * sharedOut + 2.0 * coBack;
    if (score < minScore) continue;

    const shared: string[] = [];
    for (const t of targetMeta.tags) if (m.tags.has(t)) shared.push(t);
    shared.sort();

    out.push({
      path: m.entry.relPath,
      title: stripMd(m.entry.basename),
      score: Math.round(score * 10000) / 10000,
      signals: {
        tag_jaccard: Math.round(tagJ * 10000) / 10000,
        title_3gram: Math.round(titleJ * 10000) / 10000,
        shared_outbound: Math.round(sharedOut * 10000) / 10000,
        co_backlink: Math.round(coBack * 10000) / 10000
      },
      shared_tags: shared,
      mtime: new Date(m.entry.mtimeMs).toISOString()
    });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}

// ─── obsidian_semantic_search (v1.8 TF-IDF cosine retrieval) ────────────────
// Pure-JS lexical-semantic search: tokenize + TF-IDF + L2-normalize each
// note's body, then rank notes by cosine similarity to the query vector.
// Closes the Smart-Connections-paywall gap surfaced in the v1.5 audit
// without adding any runtime deps. Real ML embedding retrieval is the v2.0
// follow-up; this is the meaningful no-deps first step that handles the
// related-term case the BM25 / exact-substring path misses.

interface DocVector {
  relPath: string;
  basename: string;
  mtimeMs: number;
  /** Sparse term-frequency-IDF vector. Map<term, weight>. L2-normalized. */
  weights: Map<string, number>;
}

const tfidfCache = new WeakMap<Vault, { docs: DocVector[]; idf: Map<string, number>; entriesRef: FileEntry[] }>();

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "for",
  "from",
  "has",
  "have",
  "if",
  "in",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "was",
  "were",
  "will",
  "with",
  "i",
  "you",
  "we",
  "they",
  "he",
  "she",
  "not",
  "no",
  "do",
  "does",
  "did",
  "had",
  "been",
  "being",
  "so",
  "than",
  "then",
  "there",
  "their",
  "them",
  "these",
  "those",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "how"
]);

// v2.1.0: detect Chinese / Japanese / Thai / Khmer / Lao via script ranges.
// These languages don't use spaces between words, so the Unicode-regex
// tokenizer falls back to character-level (or huge multi-word tokens),
// which tanks BM25 + TF-IDF precision. Intl.Segmenter (Node 16+ ICU)
// gives word-break per language. Detection is per-document, branching the
// tokenizer.
const CJK_OR_THAI_RANGES = /[぀-ヿ㐀-䶿一-鿿가-힯฀-๿ༀ-࿿ក-៿]/;

export function tokenizeForTfidf(text: string): string[] {
  // v1.11.1: Unicode-aware tokenizer. The previous ASCII-only regex
  // (`/[a-z0-9][a-z0-9_-]*/g`) silently dropped Cyrillic, Greek, CJK,
  // Hebrew, Arabic, and any non-Latin content from the TF-IDF index.
  // `\p{L}` matches any Unicode letter; `\p{N}` matches any Unicode number.
  //
  // v2.1.0: when the text contains CJK / Thai / Khmer / Lao chars (no-
  // whitespace scripts), use Intl.Segmenter for proper word-break first,
  // then run the Unicode regex per-segment. This produces real word tokens
  // instead of "認可サーバーがアクセストークン" as a single 12-char token
  // that the length filter would drop.
  const lower = text.toLowerCase();
  const out: string[] = [];
  if (CJK_OR_THAI_RANGES.test(lower) && typeof Intl !== "undefined" && typeof Intl.Segmenter !== "undefined") {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
    for (const seg of segmenter.segment(lower)) {
      if (!seg.isWordLike) continue;
      const t = seg.segment;
      if (t.length < 1) continue;
      if (t.length > 40) continue;
      if (STOP_WORDS.has(t)) continue;
      out.push(t);
    }
    return out;
  }
  for (const m of lower.matchAll(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu)) {
    const t = m[0];
    if (t.length < 2) continue;
    if (t.length > 40) continue;
    if (STOP_WORDS.has(t)) continue;
    out.push(t);
  }
  return out;
}

export async function buildTfidfIndex(
  vault: Vault
): Promise<{ docs: DocVector[]; idf: Map<string, number>; entriesRef: FileEntry[] }> {
  const entries = await vault.listMarkdown();
  const cached = tfidfCache.get(vault);
  if (
    cached &&
    cached.entriesRef.length === entries.length &&
    cached.entriesRef.every((e, i) => entries[i]?.relPath === e.relPath && entries[i]?.mtimeMs === e.mtimeMs)
  ) {
    return cached;
  }

  type RawDoc = { entry: FileEntry; tf: Map<string, number> };
  const rawDocs: RawDoc[] = [];
  const docFreq = new Map<string, number>();
  for (const e of entries) {
    const { parsed } = await vault.readNote(e.absPath, e.mtimeMs);
    const tokens = tokenizeForTfidf(parsed.body);
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    rawDocs.push({ entry: e, tf });
    for (const t of tf.keys()) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
  }

  // Smoothed IDF: ln(1 + N / (1 + df)). Smoothing keeps every-doc terms
  // non-zero and tames inflation on small vaults.
  const N = rawDocs.length || 1;
  const idf = new Map<string, number>();
  for (const [term, df] of docFreq) {
    idf.set(term, Math.log(1 + N / (1 + df)));
  }

  const docs: DocVector[] = [];
  for (const r of rawDocs) {
    const weights = new Map<string, number>();
    let normSq = 0;
    for (const [term, count] of r.tf) {
      const w = (1 + Math.log(count)) * (idf.get(term) ?? 0);
      if (w === 0) continue;
      weights.set(term, w);
      normSq += w * w;
    }
    const norm = Math.sqrt(normSq);
    if (norm > 0) {
      for (const [t, w] of weights) weights.set(t, w / norm);
    }
    docs.push({
      relPath: r.entry.relPath,
      basename: r.entry.basename,
      mtimeMs: r.entry.mtimeMs,
      weights
    });
  }

  const result = { docs, idf, entriesRef: entries };
  tfidfCache.set(vault, result);
  return result;
}

export interface SemanticHit {
  path: string;
  title: string;
  score: number;
  snippet: string;
  matched_terms: string[];
  mtime: string;
}

export async function semanticSearch(
  vault: Vault,
  args: { query: string; folder?: string; limit?: number; min_score?: number }
): Promise<{ query: string; total_docs: number; method: "tfidf-cosine"; matches: SemanticHit[] }> {
  await vault.ensureExists();
  const limit = args.limit ?? 10;
  const minScore = args.min_score ?? 0.05;
  if (!args.query.trim()) throw new Error("query must not be empty");

  const { docs, idf } = await buildTfidfIndex(vault);

  // Vectorize query: same tokenization, IDF from the corpus, L2 normalize.
  const qTokens = tokenizeForTfidf(args.query);
  const qTf = new Map<string, number>();
  for (const t of qTokens) qTf.set(t, (qTf.get(t) ?? 0) + 1);
  const qWeights = new Map<string, number>();
  let qNormSq = 0;
  for (const [t, count] of qTf) {
    const w = (1 + Math.log(count)) * (idf.get(t) ?? 0);
    if (w === 0) continue;
    qWeights.set(t, w);
    qNormSq += w * w;
  }
  const qNorm = Math.sqrt(qNormSq);
  if (qNorm > 0) {
    for (const [t, w] of qWeights) qWeights.set(t, w / qNorm);
  }

  // Cosine = Σ q[t]·d[t] over shared terms (both vectors are L2-normed).
  const folderPrefix = args.folder ? `${args.folder.replace(/\/+$/, "")}/` : null;
  const scored: Array<{ doc: DocVector; score: number; matchedTerms: string[] }> = [];
  for (const doc of docs) {
    if (folderPrefix && !doc.relPath.startsWith(folderPrefix) && doc.relPath !== args.folder) continue;
    let s = 0;
    const matched: string[] = [];
    for (const [t, qw] of qWeights) {
      const dw = doc.weights.get(t);
      if (dw !== undefined) {
        s += qw * dw;
        matched.push(t);
      }
    }
    if (s < minScore) continue;
    scored.push({ doc, score: s, matchedTerms: matched });
  }
  scored.sort((a, b) => b.score - a.score);

  const matches: SemanticHit[] = [];
  for (const { doc, score, matchedTerms } of scored.slice(0, limit)) {
    matchedTerms.sort((a, b) => (idf.get(b) ?? 0) - (idf.get(a) ?? 0));
    // v1.8.1 fix: snippet was being built from `content` (full file with
    // frontmatter), so a matched term that lived in the YAML block could leak
    // YAML keys/values into the response. Use `parsed.body` instead — TF-IDF
    // is built from body too, so the indexOf below is guaranteed to land if
    // the term contributed to the cosine score.
    const { parsed } = await vault.readNote(vault.resolveInside(doc.relPath), doc.mtimeMs);
    const body = parsed.body;
    let snippetText = "";
    for (const t of matchedTerms) {
      const idx = body.toLowerCase().indexOf(t);
      if (idx >= 0) {
        const { snippet } = sliceSnippet(body, idx, t.length);
        snippetText = snippet;
        break;
      }
    }
    matches.push({
      path: doc.relPath,
      title: stripMd(doc.basename),
      score: Math.round(score * 10000) / 10000,
      snippet: snippetText,
      matched_terms: matchedTerms.slice(0, 8),
      mtime: new Date(doc.mtimeMs).toISOString()
    });
  }

  return { query: args.query, total_docs: docs.length, method: "tfidf-cosine", matches };
}

// ─── obsidian_embeddings_search (v2.0 alpha — ML embeddings retrieval) ──────
// Hits a persistent vector index built by `enquire-mcp build-embeddings`. If
// the user hasn't run that yet, returns a clean `index_missing` error rather
// than blocking inside the model load (which can take ~30s on first call).
//
// The index is opt-in and out-of-band: we don't load any ONNX runtime or
// model files unless the tool is actually invoked. Cold path is identical to
// `obsidian_semantic_search` (TF-IDF, no native deps, instant).

export interface EmbedHit {
  path: string;
  title: string;
  score: number;
  snippet: string;
  chunk_index: number;
  line_start: number;
  line_end: number;
  /** v2.8.0 — content-source kind ("md" | "pdf"). */
  kind: "md" | "pdf";
}

export interface EmbedSearchResponse {
  query: string;
  method: "embeddings-cosine";
  model: string;
  total_chunks: number;
  matches: EmbedHit[];
  /**
   * v3.1.0 — present + true when retrieval used the agent-supplied
   * `hypothetical_answer` as the embedding seed (HyDE). Lets clients
   * audit whether they're seeing raw-query or HyDE-augmented results.
   */
  hyde?: boolean;
}

/**
 * v2.13.0 — optional HNSW context. When passed, embeddingsSearch routes
 * the k-NN lookup through the in-memory HNSW index (sub-10ms at any
 * scale) instead of the O(n) brute-force cosine in EmbedDb.search().
 * `rowByLabel` is the label → source-row mapping established at HNSW
 * build time (typically labels are `embeddings.id`, set in
 * `EmbedDb.getAllVectors()`).
 */
export interface HnswSearchContext {
  index: { searchKnn(q: Float32Array, k: number, opts?: { ef?: number }): { labels: number[]; distances: number[] } };
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
  >;
  ef?: number;
}

/**
 * v3.1.0 — pick the text that should be embedded for an embeddings-search
 * call. HyDE-augmented retrieval prefers the agent-supplied
 * `hypothetical_answer` (Gao et al 2023); falls back to the raw query
 * when that's absent / empty / whitespace-only.
 *
 * Pure helper so we can unit-test the decision in isolation (the real
 * `embeddingsSearch` function loads the @huggingface/transformers
 * embedder, which is out of scope for unit tests).
 */
export function pickEmbedTextForHyde(args: { query: string; hypothetical_answer?: string }): {
  text: string;
  usedHyde: boolean;
} {
  const ha = args.hypothetical_answer?.trim() ?? "";
  if (ha.length > 0) return { text: ha, usedHyde: true };
  return { text: args.query, usedHyde: false };
}

export async function embeddingsSearch(
  vault: Vault,
  args: {
    query: string;
    folder?: string;
    limit?: number;
    min_score?: number;
    model?: string;
    /**
     * v3.1.0 — HyDE (Hypothetical Document Embeddings) augmentation.
     * When set, this string is embedded instead of `query`. The agent
     * generates a synthetic answer to its own question, embeds *that*,
     * and retrieves against the answer-shaped vector — typically beats
     * raw-query retrieval on under-specified queries by +2-5 NDCG@10.
     * The `query` string is still echoed in the response for caller
     * audit-trail; it does NOT influence retrieval when `hypothetical_answer`
     * is present.
     */
    hypothetical_answer?: string;
  },
  embedFile: string,
  hnsw?: HnswSearchContext | null
): Promise<EmbedSearchResponse> {
  await vault.ensureExists();
  if (!args.query.trim()) throw new Error("query must not be empty");
  // v3.1.0 — pick the actual text to embed. HyDE prefers the
  // hypothetical answer when present; otherwise fall back to the query.
  const { text: embedText, usedHyde } = pickEmbedTextForHyde(args);
  const limit = args.limit ?? 10;
  const minScore = args.min_score ?? 0.3;

  // Lazy-load embed-db + embeddings only when the tool is actually called.
  const [{ EmbedDb }, { loadEmbedder, resolveModel }] = await Promise.all([
    import("../embed-db.js"),
    import("../embeddings.js")
  ]);

  // Verify the embed db exists before doing anything heavy. This separates
  // "user hasn't built the index yet" from "model failed to load".
  const fsMod = await import("node:fs");
  if (!fsMod.existsSync(embedFile)) {
    throw new Error(
      `Embedding index not found at ${embedFile}. ` +
        `Run: enquire-mcp build-embeddings --vault ${vault.root} ` +
        `(first-time setup also needs: enquire-mcp install-model multilingual)`
    );
  }

  const model = resolveModel(args.model);
  const db = new EmbedDb({
    file: embedFile,
    vaultRoot: vault.root,
    modelAlias: model.alias,
    dim: model.dim
  });
  await db.open();
  try {
    const total = db.totalChunks();
    if (total === 0) {
      return { query: args.query, method: "embeddings-cosine", model: model.alias, total_chunks: 0, matches: [] };
    }
    const embedder = await loadEmbedder(args.model);
    const [qVec] = await embedder.embed([embedText]);
    if (!qVec) throw new Error("Embedder returned no vectors for the query");
    // v2.0.0-beta.2 P0 fix: filter excluded paths from the embedding-index
    // hits BEFORE returning. The persistent .embed.db is built once and may
    // contain entries for paths now excluded by --exclude-glob / --read-paths
    // (added between build-embeddings and serve, or between two serve runs).
    // Pre-fix, those entries leaked through `text_preview` and `rel_path`,
    // bypassing the privacy contract — same shape as the writeNote bug.
    // We over-fetch by 2× to keep top-K stable when many hits get filtered.
    const overFetch = limit * 2;
    let rawHits: import("../embed-db.js").EmbedSearchHit[];
    if (hnsw) {
      // v2.13.0 — HNSW path. Sub-10ms top-K at any scale. We over-fetch
      // slightly more (3×) than brute-force because HNSW can occasionally
      // miss a true nearest neighbor; the privacy filter then pares down.
      const k = Math.min(Math.max(overFetch * 2, 30), Math.max(hnsw.rowByLabel.size, 1));
      const result = hnsw.index.searchKnn(qVec, k, hnsw.ef !== undefined ? { ef: hnsw.ef } : undefined);
      const { hnswResultsToHits } = await import("../hnsw.js");
      rawHits = hnswResultsToHits(result, hnsw.rowByLabel);
      // HNSW returns scores in [-1, 1] like brute-force cosine. Apply the
      // same min_score floor + folder filter brute-force does.
      if (args.folder) {
        const prefix = `${args.folder.replace(/\/+$/, "")}/`;
        rawHits = rawHits.filter((h) => h.rel_path.startsWith(prefix));
      }
      rawHits = rawHits.filter((h) => h.score >= minScore);
    } else {
      rawHits = db.search(qVec, overFetch, { folder: args.folder, minScore });
    }
    const hits = rawHits.filter((h) => !vault.isExcluded(h.rel_path)).slice(0, limit);
    const matches: EmbedHit[] = hits.map((h) => ({
      path: h.rel_path,
      title: stripMd(path.basename(h.rel_path)),
      score: Math.round(h.score * 10000) / 10000,
      snippet: h.text_preview.slice(0, 240),
      chunk_index: h.chunk_index,
      line_start: h.line_start,
      line_end: h.line_end,
      kind: h.kind
    }));
    return {
      query: args.query,
      method: "embeddings-cosine",
      model: model.alias,
      total_chunks: total,
      matches,
      ...(usedHyde ? { hyde: true } : {})
    };
  } finally {
    db.close();
  }
}

// ─── obsidian_search (v2.0 beta — hybrid RRF over BM25 + TF-IDF + embeddings)
// Single umbrella tool that fuses every available retrieval signal via
// Reciprocal Rank Fusion (Cormack et al, 2009). Gracefully degrades:
//   - All 3 signals available → fuse all 3
//   - No FTS5 (`--persistent-index` not passed) → TF-IDF + embeddings (or just TF-IDF)
//   - No embeddings (`build-embeddings` not run) → BM25 + TF-IDF
//   - Only TF-IDF → falls back to TF-IDF-only ranking
// Each signal contributes equally; v2.0 ships hardcoded RRF with k=60 per
// the architecture decision. Future v2.1 may add `--rrf-weights` flag.
//
// Note-level fusion: BM25 + embeddings return chunk hits; we collapse to the
// best chunk per note before fusing. The chunk_index from the highest-ranked
// chunk hit is preserved on the response so the agent can scroll to the
// right paragraph.

export interface SearchHybridHit {
  path: string;
  title: string;
  /** Fused RRF score (sum of 1/(k+rank) terms across signals). */
  score: number;
  /** Snippet from whichever signal produced the best chunk hit. */
  snippet: string;
  chunk_index?: number;
  line_start?: number;
  line_end?: number;
  /**
   * v2.8.0 — content-source kind. Lets agents distinguish markdown notes
   * from PDF chunks when both are indexed. Defaults to "md" for backward
   * compatibility (legacy DBs and TF-IDF hits have no kind metadata).
   */
  kind: "md" | "pdf";
  /** Per-signal observability — which signals contributed at what rank/score. */
  per_signal: {
    bm25?: { rank: number; score: number };
    tfidf?: { rank: number; score: number };
    embeddings?: { rank: number; score: number };
  };
  /**
   * v2.9.0 — cross-encoder reranker score in [0, 1] (sigmoid of the model's
   * relevance logit). Present only when the server was started with
   * `--enable-reranker` AND this hit was within the reranker's top-N
   * candidate set (default 50). Higher = more relevant. Compare across
   * results within the same response, NOT across queries (the absolute
   * value depends on the query).
   */
  reranker_score?: number;
}

export interface SearchHybridResponse {
  query: string;
  method: "rrf";
  k: number;
  signals_used: ("bm25" | "tfidf" | "embeddings")[];
  /** v2.0.0-beta.2: per-signal failure reasons. Pre-fix, ranker exceptions
   *  were silently swallowed (only stderr-logged). The MCP response just
   *  showed `signals_used: []` with `matches: []` — caller couldn't tell
   *  "no hits" from "all rankers crashed". Now any catch'ed exception
   *  surfaces here as a string so agents can reason about reliability.
   *  v2.9.0 added `reranker` for cross-encoder failure surfacing. */
  signal_errors?: { bm25?: string; tfidf?: string; embeddings?: string; reranker?: string };
  total_candidates: number;
  matches: SearchHybridHit[];
}

export async function searchHybrid(
  vault: Vault,
  args: {
    query: string;
    folder?: string;
    limit?: number;
    min_signals?: number;
    embedding_model?: string;
    /** v2.2.0: "note" (default) returns 1 hit per note, picking the best
     *  chunk; "block" returns each chunk as a distinct hit so you see the
     *  multiple-paragraph case where one note covers a topic in two places. */
    granularity?: "note" | "block";
    /** v2.3.0: post-RRF graph boost — rerank by counting how many other
     *  top-K hits link to each one. Default true; set false to disable for
     *  diagnostic comparison (e.g. measuring whether boost helped). */
    graph_boost?: boolean;
  },
  ctx: {
    /** FTS5 index, if `--persistent-index` is enabled at server start. */
    ftsIndex: FtsIndex | null;
    /** Path to the `.embed.db` (file may or may not exist — checked at call time). */
    embedFile: string;
    /**
     * v2.9.0 — optional cross-encoder reranker config. When set, the top-N
     * hits from RRF (default 50) are re-scored by a BGE-style cross-encoder
     * and re-sorted before truncation. Adds ~30-50ms per query on M1 CPU
     * for a 50-candidate set.
     *
     * `alias` resolves to a `RERANKER_MODELS` entry. `topN` defaults to 50.
     * Lazy-loaded — first call downloads the model from HuggingFace
     * (~25-110 MB depending on alias). Failures are swallowed and surface
     * via `signal_errors.reranker` so the whole search doesn't break on a
     * model load issue.
     */
    reranker?: { alias?: string; topN?: number };
    /**
     * v2.9.0 — test-only injection point. When set, this pre-loaded
     * reranker is used instead of lazy-loading via `loadReranker(alias)`.
     * Lets unit tests validate the rerank-and-resort plumbing without
     * pulling in the real ML model. Unused in production callers.
     */
    rerankerOverride?: { score(query: string, passages: readonly string[]): Promise<number[]> };
    /**
     * v2.13.0 — optional HNSW context for the embeddings-search arm.
     * When passed, the embedding-side k-NN goes through the in-memory
     * HNSW index (sub-10ms at any scale) instead of the O(n) brute-force
     * cosine in EmbedDb.search(). Built on serve start; lives in
     * ServerDeps.hnswContext. Null/undefined → brute-force fallback.
     */
    hnsw?: HnswSearchContext | null;
  }
): Promise<SearchHybridResponse> {
  await vault.ensureExists();
  if (!args.query.trim()) throw new Error("query must not be empty");
  const limit = args.limit ?? 10;
  const minSignals = args.min_signals ?? 1;
  const granularity = args.granularity ?? "note";
  // Fan-out per-ranker top-K. Bigger than user's `limit` so RRF has room
  // to surface a doc that's mid-rank in one signal but top in another.
  const fanOutK = Math.max(50, limit * 5);

  const [{ reciprocalRankFusion, RRF_K }, { existsSync }] = await Promise.all([import("../rrf.js"), import("node:fs")]);

  // v2.0.0-beta.2 P1 fix: collect per-signal errors for response-side observability.
  const signalErrors: { bm25?: string; tfidf?: string; embeddings?: string } = {};

  const signalsUsed: ("bm25" | "tfidf" | "embeddings")[] = [];

  // ─── BM25 (FTS5) ────────────────────────────────────────────────────────
  // Note-level: collapse multi-chunk hits to the best rank per note.
  let bm25Ranked: Array<{
    id: string;
    rank: number;
    score: number;
    snippet: string;
    chunk_index?: number;
    line_start?: number;
    line_end?: number;
    /** v2.8.0: content-source kind ("md" | "pdf"). */
    kind: "md" | "pdf";
  }> = [];
  if (ctx.ftsIndex) {
    try {
      // v2.0.0-beta.2 P0 fix: filter excluded paths from FTS5 hits BEFORE
      // chunk-collapse + RRF. The .fts5.db can contain entries from when the
      // index was built without exclusion flags (or with different flags).
      // Pre-fix, BM25 search returned excluded chunks via the hybrid pipeline.
      const rawFtsHits = ctx.ftsIndex.search(args.query, { limit: fanOutK, folder: args.folder });
      const ftsHits = rawFtsHits.filter((h) => !vault.isExcluded(h.rel_path));
      // v2.2.0: granularity branch.
      //   "note"  → collapse multi-chunk hits per note (best-rank wins),
      //             RRF fuses on path key.
      //   "block" → keep each chunk distinct, RRF fuses on `path#chunk_index`.
      if (granularity === "block") {
        bm25Ranked = ftsHits.map((h, i) => ({
          id: `${h.rel_path}#${h.chunk_index}`,
          rank: i + 1,
          score: h.score,
          snippet: h.snippet,
          chunk_index: h.chunk_index,
          line_start: h.line_start,
          line_end: h.line_end,
          kind: h.kind
        }));
      } else {
        const bestPerNote = new Map<
          string,
          {
            score: number;
            rank: number;
            snippet: string;
            chunk_index: number;
            line_start: number;
            line_end: number;
            kind: "md" | "pdf";
          }
        >();
        ftsHits.forEach((h, i) => {
          const existing = bestPerNote.get(h.rel_path);
          if (!existing || i < existing.rank) {
            bestPerNote.set(h.rel_path, {
              score: h.score,
              rank: i + 1,
              snippet: h.snippet,
              chunk_index: h.chunk_index,
              line_start: h.line_start,
              line_end: h.line_end,
              kind: h.kind
            });
          }
        });
        bm25Ranked = Array.from(bestPerNote.entries()).map(([id, b]) => ({
          id,
          rank: b.rank,
          score: b.score,
          snippet: b.snippet,
          chunk_index: b.chunk_index,
          line_start: b.line_start,
          line_end: b.line_end,
          kind: b.kind
        }));
        // Re-sort to ensure 1-based ranks are consecutive after dedup.
        bm25Ranked.sort((a, b) => a.rank - b.rank);
        for (let i = 0; i < bm25Ranked.length; i++) {
          const hit = bm25Ranked[i];
          if (hit) hit.rank = i + 1;
        }
      }
      if (bm25Ranked.length > 0) signalsUsed.push("bm25");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      signalErrors.bm25 = msg;
      process.stderr.write(`obsidian_search: BM25 ranker failed — ${msg}\n`);
    }
  }

  // ─── TF-IDF ─────────────────────────────────────────────────────────────
  // Always available (in-memory, no native deps).
  let tfidfRanked: Array<{ id: string; rank: number; score: number; snippet: string }> = [];
  try {
    const tfidf = await semanticSearch(vault, {
      query: args.query,
      folder: args.folder,
      limit: fanOutK,
      min_score: 0.05
    });
    tfidfRanked = tfidf.matches.map((m, i) => ({
      id: m.path,
      rank: i + 1,
      score: m.score,
      snippet: m.snippet
    }));
    if (tfidfRanked.length > 0) signalsUsed.push("tfidf");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    signalErrors.tfidf = msg;
    process.stderr.write(`obsidian_search: TF-IDF ranker failed — ${msg}\n`);
  }

  // ─── ML embeddings (if .embed.db exists) ────────────────────────────────
  let embedRanked: Array<{
    id: string;
    rank: number;
    score: number;
    snippet: string;
    chunk_index?: number;
    line_start?: number;
    line_end?: number;
    /** v2.8.0: content-source kind ("md" | "pdf"). */
    kind: "md" | "pdf";
  }> = [];
  if (existsSync(ctx.embedFile)) {
    try {
      // v2.0.0-beta.1 P1 fix: pass `min_score: 0` to fan-out the embeddings
      // ranker uniformly with BM25 (no floor) and TF-IDF (0.05 floor). The
      // user-facing precision filter happens AFTER fusion via `min_signals`,
      // not before — pre-fix, embeddings used the standalone tool's 0.3
      // default which silently shrank the embedding-side candidate pool and
      // starved RRF of cross-signal evidence.
      const embed = await embeddingsSearch(
        vault,
        { query: args.query, folder: args.folder, limit: fanOutK, model: args.embedding_model, min_score: 0 },
        ctx.embedFile,
        ctx.hnsw
      );
      // v2.2.0: granularity branch — same shape as BM25 above.
      if (granularity === "block") {
        embedRanked = embed.matches.map((m, i) => ({
          id: `${m.path}#${m.chunk_index ?? 0}`,
          rank: i + 1,
          score: m.score,
          snippet: m.snippet,
          chunk_index: m.chunk_index,
          line_start: m.line_start,
          line_end: m.line_end,
          kind: m.kind
        }));
      } else {
        const bestPerNote = new Map<
          string,
          {
            score: number;
            rank: number;
            snippet: string;
            chunk_index: number;
            line_start: number;
            line_end: number;
            kind: "md" | "pdf";
          }
        >();
        embed.matches.forEach((m, i) => {
          const existing = bestPerNote.get(m.path);
          if (!existing || i < existing.rank) {
            bestPerNote.set(m.path, {
              score: m.score,
              rank: i + 1,
              snippet: m.snippet,
              chunk_index: m.chunk_index,
              line_start: m.line_start,
              line_end: m.line_end,
              kind: m.kind
            });
          }
        });
        embedRanked = Array.from(bestPerNote.entries()).map(([id, b]) => ({
          id,
          rank: b.rank,
          score: b.score,
          snippet: b.snippet,
          chunk_index: b.chunk_index,
          line_start: b.line_start,
          line_end: b.line_end,
          kind: b.kind
        }));
        embedRanked.sort((a, b) => a.rank - b.rank);
        for (let i = 0; i < embedRanked.length; i++) {
          const hit = embedRanked[i];
          if (hit) hit.rank = i + 1;
        }
      }
      if (embedRanked.length > 0) signalsUsed.push("embeddings");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      signalErrors.embeddings = msg;
      process.stderr.write(`obsidian_search: embeddings ranker failed — ${msg}\n`);
    }
  }

  // ─── RRF fusion ─────────────────────────────────────────────────────────
  const fused = reciprocalRankFusion(
    {
      bm25: bm25Ranked.map((h) => ({ id: h.id, rank: h.rank, score: h.score })),
      tfidf: tfidfRanked.map((h) => ({ id: h.id, rank: h.rank, score: h.score })),
      embeddings: embedRanked.map((h) => ({ id: h.id, rank: h.rank, score: h.score }))
    },
    { topK: Math.max(limit * 4, 30) } // overshoot — graph boost may rerank
  );

  // ─── v2.3.0: Wikilink graph-boost ───────────────────────────────────────
  // Re-rank top-K by counting how many *other* top-K hits link to each one.
  // Equivalent to a 1-step personalised PageRank seeded by the fused top-K.
  // Boost is small (α=0.005) — enough to break ties but won't override
  // strong single-ranker signals. Requires no new index — uses already-
  // cached parsed wikilinks per note.
  // This is the "only enquire-mcp does this" feature: generic vector stores
  // can't do this without an Obsidian-aware layer; Smart Connections doesn't
  // do it either. Wikilinks ARE the differentiating Obsidian primitive.
  const graphBoost = args.graph_boost !== false; // default ON
  if (graphBoost && fused.length > 1) {
    const candidatePaths = new Set<string>();
    for (const f of fused) {
      candidatePaths.add(f.id.includes("#") ? (f.id.split("#")[0] ?? f.id) : f.id);
    }
    const outLinks = new Map<string, Set<string>>();
    for (const candidatePath of candidatePaths) {
      try {
        const note = await vault.readNote(vault.resolveInside(candidatePath));
        const targets = new Set<string>();
        for (const wl of note.parsed.wikilinks) {
          if (!wl.target) continue;
          // Wikilinks can be by basename ("Foo") or relative path ("Sub/Foo").
          // Normalize both forms so the membership test catches either.
          targets.add(wl.target);
          targets.add(stripMd(wl.target));
        }
        outLinks.set(candidatePath, targets);
      } catch {
        // skip unreadable notes
      }
    }
    const ALPHA = 0.005;
    for (const f of fused) {
      const fPath = f.id.includes("#") ? (f.id.split("#")[0] ?? f.id) : f.id;
      const fBasename = stripMd(path.basename(fPath));
      let inDegree = 0;
      for (const [otherPath, targets] of outLinks) {
        if (otherPath === fPath) continue;
        if (targets.has(fPath) || targets.has(stripMd(fPath)) || targets.has(fBasename)) {
          inDegree += 1;
        }
      }
      if (inDegree > 0) f.score += ALPHA * inDegree;
    }
    fused.sort((a, b) => b.score - a.score);
  }

  // Build snippet/chunk lookup tables for attaching the best evidence per
  // note in the final response.
  const bm25Map = new Map(bm25Ranked.map((h) => [h.id, h]));
  const tfidfMap = new Map(tfidfRanked.map((h) => [h.id, h]));
  const embedMap = new Map(embedRanked.map((h) => [h.id, h]));

  // ─── v2.9.0: Cross-encoder reranking (post-RRF, post-graph-boost) ────────
  // Take the top-N fused candidates, score each (query, snippet) pair with a
  // BGE-style cross-encoder, and re-sort. Cross-encoder is far more accurate
  // than bi-encoder cosine for relevance ranking — it sees query+document
  // interaction directly. ~30-50ms per query overhead on M1 CPU at N=50.
  //
  // Failures are caught and surfaced as `signal_errors.reranker` so a model
  // load problem doesn't poison the whole search response. The fused order
  // (RRF + graph-boost) is preserved if reranking fails.
  let rerankerScores: Map<string, number> | null = null;
  if ((ctx.reranker || ctx.rerankerOverride) && fused.length > 0) {
    const topN = ctx.reranker?.topN ?? 50;
    const rerankBatch = fused.slice(0, topN);
    try {
      // Prefer the test-injected reranker when present; otherwise lazy-load.
      let reranker: { score(query: string, passages: readonly string[]): Promise<number[]> };
      if (ctx.rerankerOverride) {
        reranker = ctx.rerankerOverride;
      } else {
        const { loadReranker } = await import("../embeddings.js");
        reranker = await loadReranker(ctx.reranker?.alias);
      }
      // For each candidate, find the best snippet (BM25 > embeddings > TF-IDF)
      // and pair it with the query. Empty-snippet candidates go to the bottom
      // by getting a -Infinity score (sort below scored candidates).
      const passages = rerankBatch.map((f) => {
        const bm = bm25Map.get(f.id);
        const emb = embedMap.get(f.id);
        const tf = tfidfMap.get(f.id);
        const snippet = bm?.snippet ?? emb?.snippet ?? tf?.snippet ?? "";
        // Strip FTS5 «…» highlight markers — they're cosmetic and the
        // reranker should see clean prose. Limit to ~600 chars to stay
        // safely under the model's 512-token budget (rough char/token ratio
        // varies by language; 600 chars ≈ 200 tokens for English / Cyrillic
        // per the multilingual model's tokenizer, well under 512).
        return snippet.replace(/[«»]/g, "").slice(0, 600);
      });
      const scores = await reranker.score(args.query, passages);
      rerankerScores = new Map();
      for (let i = 0; i < rerankBatch.length; i++) {
        const f = rerankBatch[i];
        const s = scores[i];
        if (f && typeof s === "number") rerankerScores.set(f.id, s);
      }
      // Sort the top-N by reranker score; everything below top-N keeps RRF
      // order. We do this by re-ordering fused[0..topN] in place.
      const reordered = [...rerankBatch].sort((a, b) => {
        const sa = rerankerScores?.get(a.id) ?? -Infinity;
        const sb = rerankerScores?.get(b.id) ?? -Infinity;
        return sb - sa;
      });
      for (let i = 0; i < reordered.length; i++) {
        fused[i] = reordered[i] as (typeof fused)[number];
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Add to signalErrors so it surfaces in the response. Reranker is not
      // a "signal" per se but the existing dict is the right home.
      (signalErrors as Record<string, string>).reranker = msg;
      process.stderr.write(`obsidian_search: reranker failed — ${msg}\n`);
    }
  }

  const matches: SearchHybridHit[] = [];
  for (const f of fused) {
    const numSignals = Object.keys(f.per_signal).length;
    if (numSignals < minSignals) continue;
    // Snippet preference: BM25 > embeddings > TF-IDF (BM25 snippets bracket
    // the matched terms with «…», highest signal-to-noise).
    const bm = bm25Map.get(f.id);
    const emb = embedMap.get(f.id);
    const tf = tfidfMap.get(f.id);
    const bestEvidence = bm ?? emb ?? tf;
    // Build per_signal as a Partial — only include keys that actually
    // contributed. Setting `key: undefined` keeps the key visible in
    // Object.keys() and JSON.stringify, which leaks "this signal exists
    // but didn't match" instead of "this signal wasn't even running".
    const perSignal: SearchHybridHit["per_signal"] = {};
    if (f.per_signal.bm25) perSignal.bm25 = { rank: f.per_signal.bm25.rank, score: f.per_signal.bm25.score };
    if (f.per_signal.tfidf) perSignal.tfidf = { rank: f.per_signal.tfidf.rank, score: f.per_signal.tfidf.score };
    if (f.per_signal.embeddings) {
      perSignal.embeddings = { rank: f.per_signal.embeddings.rank, score: f.per_signal.embeddings.score };
    }
    // v2.2.0: when granularity is "block", f.id is "path#chunk_index" — split
    // back into path + chunk_index for the response. When "note", f.id is
    // just the path.
    let pathPart = f.id;
    let chunkFromId: number | undefined;
    if (granularity === "block") {
      const hashIdx = f.id.lastIndexOf("#");
      if (hashIdx > 0) {
        pathPart = f.id.slice(0, hashIdx);
        const parsed = Number.parseInt(f.id.slice(hashIdx + 1), 10);
        if (Number.isInteger(parsed) && parsed >= 0) chunkFromId = parsed;
      }
    }
    // v2.8.0: derive content-source kind. BM25 / embeddings hits carry it
    // explicitly; TF-IDF doesn't (it only runs over markdown). Either
    // ranker reporting "pdf" wins; otherwise fall back to "md".
    const kind: "md" | "pdf" = bm?.kind === "pdf" || emb?.kind === "pdf" ? "pdf" : "md";
    // For PDFs, the title is best derived from the filename without
    // `.md`-stripping (PDFs don't have that extension); use the .pdf-stripped
    // form so titles read naturally in agent output.
    const baseName = path.basename(pathPart);
    const title = kind === "pdf" ? baseName.replace(/\.pdf$/i, "") : stripMd(baseName);
    const rerankerScore = rerankerScores?.get(f.id);
    matches.push({
      path: pathPart,
      title,
      score: Math.round(f.score * 100000) / 100000,
      snippet: bestEvidence?.snippet ?? "",
      chunk_index: chunkFromId ?? bm?.chunk_index ?? emb?.chunk_index,
      line_start: bm?.line_start ?? emb?.line_start,
      line_end: bm?.line_end ?? emb?.line_end,
      kind,
      per_signal: perSignal,
      ...(typeof rerankerScore === "number" && Number.isFinite(rerankerScore)
        ? { reranker_score: Math.round(rerankerScore * 100000) / 100000 }
        : {})
    });
    if (matches.length >= limit) break;
  }

  // v2.0.0-beta.2 P1 fix: surface signal_errors only when at least one
  // ranker actually failed. Omit the key when all signals ran cleanly so
  // happy-path responses stay narrow.
  const response: SearchHybridResponse = {
    query: args.query,
    method: "rrf",
    k: RRF_K,
    signals_used: signalsUsed,
    total_candidates: fused.length,
    matches
  };
  if (Object.keys(signalErrors).length > 0) {
    response.signal_errors = signalErrors;
  }
  return response;
}

export function sliceSnippet(text: string, idx: number, qLen: number): { snippet: string; line: number } {
  if (idx < 0) return { snippet: "", line: 0 };
  const before = Math.max(0, idx - 60);
  const after = Math.min(text.length, idx + qLen + 60);
  let snippet = text.slice(before, after).replace(/\s+/g, " ").trim();
  if (before > 0) snippet = `…${snippet}`;
  if (after < text.length) snippet = `${snippet}…`;
  const line = text.slice(0, idx).split("\n").length;
  return { snippet, line };
}
