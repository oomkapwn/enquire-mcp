import * as path from "node:path";
import type { FtsIndex } from "../fts5.js";
import type { FileEntry, Vault } from "../vault.js";
import { findBestMatch, intersectionSize, jaccard, ngrams, stripMd } from "./meta.js";
import { resolveTarget } from "./write.js";

/**
 * Token-matching mode for {@link searchText}.
 *
 * - `"all"` — every whitespace-separated token must occur in the note (AND).
 * - `"any"` — at least one token must occur (OR).
 * - `"phrase"` — the raw query string must occur as a contiguous substring.
 */
export type SearchMode = "all" | "any" | "phrase";

/**
 * A single hit from {@link searchText}.
 *
 * Hits expose the surrounding snippet and the 1-based line where the first
 * matched token landed so the agent can scroll a UI directly to the relevant
 * passage. `score` is the total per-token occurrence count (higher = more
 * matches), not normalized — compare scores within the same response only.
 */
export interface SearchHit {
  /** Vault-relative path of the matching note (e.g. `"Reference/Foo.md"`). */
  path: string;
  /** ~120-char excerpt centered on the first matched token, with `…` truncation. */
  snippet: string;
  /** Total occurrences of all matched tokens. Sort key (desc). */
  score: number;
  /** 1-based line number where the first match starts. `0` when no match. */
  line: number;
  /** Original-case tokens that matched (subset of the query tokens). */
  matched_terms: string[];
}

/**
 * Envelope returned by {@link searchText}.
 *
 * Includes `scanned_notes` for observability — agents can detect when an
 * empty `matches[]` is "I searched 4000 notes and nothing matched" vs. "the
 * `folder` filter excluded everything".
 */
export interface SearchResponse {
  /** Echo of the input query (untouched). */
  query: string;
  /** Mode that was actually used (after `args.mode ?? "all"` defaulting). */
  mode: SearchMode;
  /** Total markdown notes considered (post-`folder`-filter, pre-match). */
  scanned_notes: number;
  /** Sorted by `score` desc, truncated to `args.limit ?? 25`. */
  matches: SearchHit[];
}

/**
 * Substring-grep search over the vault: scans every `.md` body for token
 * occurrences in `all` / `any` / `phrase` mode and ranks by occurrence count.
 *
 * This is the simplest retrieval primitive — no index, no embeddings, no
 * native deps. Useful when the agent already knows specific keywords; for
 * fuzzier semantic recall prefer {@link searchHybrid} or {@link semanticSearch}.
 * Read concurrency is bounded to 16 to avoid blowing the fd limit on large
 * vaults. Tokenization is whitespace-split + lowercased; case-insensitive.
 *
 * @param vault - The vault to search.
 * @param args - Search arguments. `query` is required and must be non-empty.
 *   `folder` restricts the scan to a subdirectory (vault-relative).
 *   `limit` caps results (default 25). `mode` defaults to `"all"`.
 * @returns A {@link SearchResponse} with sorted `matches` and a
 *   `scanned_notes` observability count.
 * @throws {Error} If `query` is empty / whitespace-only.
 * @throws {VaultPathError} If `folder` resolves outside the vault root.
 * @example
 * ```ts
 * const result = await searchText(vault, {
 *   query: "RAG retrieval",
 *   folder: "Reference",
 *   mode: "all",
 *   limit: 10
 * });
 * for (const hit of result.matches) {
 *   console.log(`${hit.path}:${hit.line} — ${hit.snippet}`);
 * }
 * ```
 */
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

/**
 * One row of the {@link findSimilar} response. Exposes the per-signal
 * breakdown so the agent can explain *why* a note is considered similar.
 */
export interface SimilarNote {
  /** Vault-relative path of the candidate. */
  path: string;
  /** `.md`-stripped basename for display. */
  title: string;
  /** Composite weighted score in approximately `[0, 8.5]`. Sort key (desc). */
  score: number;
  /** Per-signal contributions in `[0, 1]` before weighting. */
  signals: {
    tag_jaccard: number;
    title_3gram: number;
    shared_outbound: number;
    co_backlink: number;
  };
  /** Tags shared between the target and this candidate (lowercased, sorted). */
  shared_tags: string[];
  /** ISO-8601 modification time of the candidate note. */
  mtime: string;
}

/**
 * Lexical-hybrid similarity over vault-native signals — finds notes related
 * to the target without any embeddings.
 *
 * Combines four structural signals: tag Jaccard (×3.0), title character
 * 3-gram Jaccard (×1.5), shared-outbound link overlap (×2.0), and co-backlink
 * Jaccard (×2.0). Tag overlap dominates by design — that's the strongest
 * "this is the same topic" signal a human would use. Skips body cosine on
 * purpose: structural signals converge fast at vault scale (5k × 5KB) without
 * a full TF-IDF pass per call.
 *
 * Use this when the agent has *one specific note* and wants neighbors. For
 * "find notes about <topic>" use {@link searchHybrid} or {@link semanticSearch}.
 *
 * @param vault - The vault to search.
 * @param args - One of `path` or `title` is required to identify the target.
 *   `limit` defaults to 10. `min_score` (default 0.05) prunes weak matches.
 * @returns Sorted `SimilarNote[]` (desc by `score`), capped at `limit`.
 *   Empty array if the target was excluded by `--exclude-glob`.
 * @throws {Error} If neither `path` nor `title` is provided, or the target
 *   cannot be resolved.
 * @example
 * ```ts
 * const related = await findSimilar(vault, {
 *   path: "Reference/Hybrid Retrieval.md",
 *   limit: 5
 * });
 * for (const n of related) {
 *   console.log(n.path, n.score, n.signals);
 * }
 * ```
 */
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

/**
 * Unicode-aware tokenizer used by the TF-IDF index and {@link semanticSearch}.
 *
 * For Latin / Cyrillic / Greek / Arabic / Hebrew etc., matches `\p{L}\p{N}`
 * runs (length 2–40, stop-word filtered). For CJK / Thai / Khmer / Lao
 * (no-whitespace scripts), uses `Intl.Segmenter` with `granularity: "word"`
 * to get real word boundaries — without this, a sentence like
 * "認可サーバーがアクセストークン" becomes a single 12-char token that the
 * length filter would drop, gutting non-Latin TF-IDF precision.
 *
 * @internal
 * @param text - Raw text to tokenize. Will be lowercased.
 * @returns A flat array of tokens in document order. May contain duplicates
 *   (TF is computed downstream).
 * @example
 * ```ts
 * tokenizeForTfidf("Hybrid RAG retrieval");
 * // → ["hybrid", "rag", "retrieval"]
 * tokenizeForTfidf("認可サーバーがアクセストークン");
 * // → ["認可", "サーバー", "アクセス", "トークン"]
 * ```
 */
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

/**
 * Build (or fetch from per-vault cache) the L2-normalized TF-IDF index over
 * every markdown body in the vault.
 *
 * Uses smoothed IDF (`ln(1 + N / (1 + df))`) which keeps every-doc terms
 * non-zero and tames inflation on small vaults. Cache invalidates on
 * `entries` length / order / mtime mismatch — the same {@link Vault} instance
 * reuses the index across consecutive {@link semanticSearch} calls.
 *
 * @internal
 * @param vault - The vault whose corpus to index.
 * @returns `{ docs, idf, entriesRef }` — `docs` are L2-normalized sparse
 *   vectors keyed by relPath; `idf` maps term → smoothed IDF weight;
 *   `entriesRef` is the `FileEntry` snapshot used for cache validation.
 * @example
 * ```ts
 * const { docs, idf } = await buildTfidfIndex(vault);
 * console.log(`${docs.length} docs, ${idf.size} unique terms`);
 * ```
 */
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

/**
 * One hit from {@link semanticSearch}. `matched_terms` are the query tokens
 * that contributed to the cosine score, sorted by IDF (rarest first).
 */
export interface SemanticHit {
  /** Vault-relative path of the matching note. */
  path: string;
  /** `.md`-stripped basename for display. */
  title: string;
  /** Cosine similarity in `[0, 1]`, rounded to 4 decimals. Sort key. */
  score: number;
  /** ~120-char excerpt centered on the first matched term in the body. */
  snippet: string;
  /** Up to 8 query tokens that contributed, sorted by IDF desc (rarest first). */
  matched_terms: string[];
  /** ISO-8601 modification time of the note. */
  mtime: string;
}

/**
 * Pure-JS lexical-semantic search via TF-IDF cosine similarity.
 *
 * Builds (or reuses cached) per-vault TF-IDF index, then ranks notes by
 * cosine similarity of the query vector against each body vector. Catches
 * "related-term" recall that the substring path of {@link searchText} misses
 * (e.g. searching `"retrieval"` will surface notes about `"recall"` if the
 * vocabulary co-occurs). Zero native deps — works on every platform with
 * no model download. For full ML retrieval use {@link embeddingsSearch};
 * for graceful-degradation fusion use {@link searchHybrid}.
 *
 * @param vault - The vault to search.
 * @param args - `query` is required. `limit` defaults to 10. `min_score`
 *   defaults to 0.05 — anything below is pruned. `folder` restricts to a
 *   subdirectory.
 * @returns An envelope with `query`, `total_docs` (corpus size), `method`
 *   (always `"tfidf-cosine"`), and `matches` sorted by `score` desc.
 * @throws {Error} If `query` is empty / whitespace-only.
 * @example
 * ```ts
 * const result = await semanticSearch(vault, {
 *   query: "vector retrieval cosine",
 *   limit: 5
 * });
 * for (const hit of result.matches) {
 *   console.log(hit.path, hit.score, hit.matched_terms);
 * }
 * ```
 */
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

/**
 * One chunk-level hit from {@link embeddingsSearch}.
 *
 * Unlike {@link SemanticHit}, embedding hits are chunk-scoped (not note-
 * scoped) — `chunk_index` / `line_start` / `line_end` let the agent jump to
 * the exact paragraph that matched.
 */
export interface EmbedHit {
  /** Vault-relative path of the source file (markdown or PDF). */
  path: string;
  /** `.md`/`.pdf`-stripped basename for display. */
  title: string;
  /** Cosine score in `[-1, 1]`, rounded to 4 decimals. Sort key. */
  score: number;
  /** ~240-char excerpt from the matching chunk. */
  snippet: string;
  /** 0-based chunk number within the source file. */
  chunk_index: number;
  /** 1-based start line of the chunk in the source file. */
  line_start: number;
  /** 1-based end line of the chunk (inclusive). */
  line_end: number;
  /** v2.8.0 — content-source kind ("md" | "pdf"). */
  kind: "md" | "pdf";
}

/**
 * Envelope returned by {@link embeddingsSearch}.
 *
 * `total_chunks` is the full index size (post-exclusion filtering), useful
 * for sanity-checking that the agent's `build-embeddings` actually ran on
 * the expected corpus.
 */
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
  /**
   * v3.6.2 HN-4 — embedding-model alias the HNSW index was built with
   * (e.g. "multilingual" or "bge"). At search time we verify that the
   * embedder used to encode the query produces vectors in the SAME
   * vector space as the index. CRIT-1 (v3.6.1) fixed the build-side
   * silent destruction; this is the corresponding search-side guard.
   *
   * If the search-time embedder model doesn't match this alias, the
   * stored vectors and the query vector are from different vector
   * spaces — cosine returns garbage similarities. We throw instead of
   * returning garbage; the agent / user can correct the
   * `--embedding-model` flag and retry.
   */
  modelAlias: string;
}

/**
 * v3.6.2 HN-4 — assert that the query-time embedder model matches the
 * HNSW index's build-time model. Standalone helper so the check is
 * unit-testable in isolation from `embeddingsSearch` (which depends on
 * loading the real ONNX embedder runtime).
 *
 * Throws a clear, actionable error on mismatch instead of letting the
 * caller compute cosine distances between vectors from two different
 * vector spaces (which would silently return garbage similarities).
 *
 * @param embedderAlias - The alias of the embedder being used at search
 *   time (typically `embedder.model.alias` after `loadEmbedder(...)`).
 * @param hnswAlias - The alias the HNSW index was built with (stored
 *   on the {@link HnswSearchContext} at server boot).
 * @throws {Error} If the aliases differ.
 */
export function assertHnswModelMatchesEmbedder(embedderAlias: string, hnswAlias: string): void {
  if (embedderAlias !== hnswAlias) {
    throw new Error(
      `HNSW model mismatch: index was built with embedding model '${hnswAlias}' ` +
        `but the search is using '${embedderAlias}'. ` +
        `The cosine similarities would be meaningless (vectors come from different spaces). ` +
        `Fix: re-run \`enquire-mcp build-embeddings --vault <path> --embedding-model ${embedderAlias}\` ` +
        `(rebuilds the index against the search-time model), ` +
        `OR restart \`serve\` without overriding the model in tool args (the embed-db's meta is honored automatically).`
    );
  }
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

/**
 * ML embeddings retrieval — k-NN over a persistent vector index.
 *
 * Hits a `.embed.db` (SQLite) built by `enquire-mcp build-embeddings`. The
 * index is **opt-in and out-of-band**: this function lazy-loads the
 * `@huggingface/transformers` runtime + the embedder model only when called.
 * If the user hasn't run `build-embeddings`, returns a clean error pointing
 * to the setup command instead of blocking inside model load.
 *
 * Supports HyDE (Hypothetical Document Embeddings, Gao et al 2023): pass
 * `hypothetical_answer` and that text is embedded instead of `query` —
 * typically +2-5 NDCG@10 on under-specified queries. Optional HNSW
 * acceleration (sub-10ms k-NN at any scale) when an {@link HnswSearchContext}
 * is provided; otherwise falls back to brute-force cosine in `EmbedDb`.
 *
 * Privacy contract: hits are filtered through `vault.isExcluded()` before
 * return — entries in the `.embed.db` for paths now matched by
 * `--exclude-glob` / `--read-paths` never leak through.
 *
 * @param vault - The vault. Used for path-exclusion filtering and to error
 *   on missing index with a guidance message.
 * @param args - `query` is required + non-empty. `limit` defaults to 10,
 *   `min_score` to 0.3 (relatively high cosine floor — embeddings cosine
 *   has a tighter distribution than TF-IDF). `model` overrides the
 *   embedder alias. `hypothetical_answer` enables HyDE.
 * @param embedFile - Absolute path to the `.embed.db`. Existence is checked
 *   before any model load so the error message is fast and clear.
 * @param hnsw - Optional HNSW index context. When passed, k-NN routes
 *   through HNSW instead of brute-force cosine.
 * @returns An {@link EmbedSearchResponse} with chunk-level matches and a
 *   `hyde: true` marker iff HyDE actually fired.
 * @throws {Error} If `query` is empty, the embed db doesn't exist, the
 *   embedder fails to load, or returns no vectors for the query.
 * @example
 * ```ts
 * const result = await embeddingsSearch(
 *   vault,
 *   {
 *     query: "How do BM25 and embeddings compare on multilingual recall?",
 *     limit: 10,
 *     hypothetical_answer: "BM25 dominates on rare-term Latin queries..."
 *   },
 *   "/path/to/vault.embed.db"
 * );
 * console.log(result.matches[0]?.path, result.hyde); // true
 * ```
 */
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
  const [{ EmbedDb, peekEmbedDbMeta }, { loadEmbedder, resolveModel }] = await Promise.all([
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

  // v3.6.2 K-1a — peek the existing embed-db's model_alias BEFORE open,
  // so bootstrapSchema() doesn't DROP TABLE when the user built embeddings
  // with `--embedding-model bge` but searches with the default
  // `multilingual` model (or vice versa). v3.6.1 CRIT-1 fix only closed
  // the `serve --use-hnsw` path; this runtime hot path (every
  // obsidian_search + obsidian_embeddings_search call) was still
  // destroying data on every query. External audit on v3.6.1 caught this
  // (K-1 residual class). Honor the stored alias unless caller passes
  // `args.model` explicitly.
  const existingMeta = await peekEmbedDbMeta(embedFile);
  const honoredAlias = args.model ?? existingMeta?.model_alias;
  const honoredQuant = existingMeta?.quantization as "f32" | "int8" | undefined;
  const model = resolveModel(honoredAlias);
  if (existingMeta?.model_alias && !args.model && existingMeta.model_alias !== resolveModel(undefined).alias) {
    process.stderr.write(
      `enquire: embeddingsSearch — honoring embed-db's stored model '${existingMeta.model_alias}' (avoids DROP TABLE on schema mismatch); pass args.model to override.\n`
    );
  }
  const db = new EmbedDb({
    file: embedFile,
    vaultRoot: vault.root,
    modelAlias: model.alias,
    dim: model.dim,
    quantization: honoredQuant
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
      // v3.6.2 HN-4 — verify the search-time embedder model matches the
      // model the HNSW index was built with. Different models → different
      // vector spaces → cosine returns garbage. CRIT-1 fixed the build
      // side; this is the corresponding search-side guard.
      assertHnswModelMatchesEmbedder(embedder.model.alias, hnsw.modelAlias);
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

/**
 * One row of the fused {@link searchHybrid} response.
 *
 * Exposes `per_signal` for full observability — agents can see *which*
 * retrieval signal contributed (BM25 / TF-IDF / embeddings) and at what
 * rank/score, which is critical for debugging recall regressions and for
 * explaining results to end users.
 */
export interface SearchHybridHit {
  /** Vault-relative path of the matching note (or `path#chunk` for `granularity: "block"`). */
  path: string;
  /** Stripped basename for display (`.md` or `.pdf` removed per `kind`). */
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

/**
 * Envelope returned by {@link searchHybrid}.
 *
 * `signals_used` tells the agent which rankers actually fired (BM25 needs
 * `--persistent-index`; embeddings needs `build-embeddings`). `signal_errors`
 * surfaces failed-but-attempted rankers so an empty `matches[]` can be
 * distinguished from "all rankers crashed".
 */
export interface SearchHybridResponse {
  /** Echo of the input query. */
  query: string;
  /** Always `"rrf"` in v3.x — present as a versioned discriminator. */
  method: "rrf";
  /** RRF constant `k` (60 per Cormack 2009; documented for transparency). */
  k: number;
  /** Which rankers contributed to the fused result. */
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

/**
 * Hybrid retrieval — fuses BM25 + TF-IDF + ML embeddings via Reciprocal Rank
 * Fusion (Cormack et al, 2009). The recommended search entry point.
 *
 * **Most agents should call this** rather than the single-ranker variants
 * ({@link searchText}, {@link semanticSearch}, {@link embeddingsSearch})
 * because the umbrella auto-detects which signals are available and produces
 * consistent recall across user setups. Gracefully degrades:
 * - All 3 signals → fuse all 3
 * - No FTS5 (no `--persistent-index`) → TF-IDF + embeddings (or just TF-IDF)
 * - No embeddings (no `build-embeddings`) → BM25 + TF-IDF
 * - Only TF-IDF → fall back to TF-IDF-only ranking
 *
 * Two unique signal layers ride on top of RRF:
 * - **Wikilink graph-boost** (v2.3.0): re-rank fused top-K by counting how
 *   many other top-K hits link to each one. Only enquire-mcp does this —
 *   wikilinks are the differentiating Obsidian primitive.
 * - **Cross-encoder reranker** (v2.9.0, opt-in): re-score top-N candidates
 *   with a BGE-style cross-encoder. ~30-50ms / query overhead on M1 CPU.
 *
 * @param vault - The vault to search.
 * @param args - `query` is required + non-empty. `limit` defaults to 10.
 *   `min_signals` (default 1) requires that many rankers fired for a hit.
 *   `granularity: "note"` (default) collapses to best chunk per note;
 *   `"block"` keeps each chunk distinct. `graph_boost` defaults to `true`.
 * @param ctx - Server-side context: `ftsIndex` (nullable), `embedFile`
 *   (path may not exist), optional `reranker` config, optional
 *   `rerankerOverride` (test injection point), optional `hnsw` context for
 *   accelerated k-NN.
 * @returns A {@link SearchHybridResponse} with sorted `matches`, observability
 *   in `signals_used` / `signal_errors`, and per-hit `per_signal` breakdown.
 * @throws {Error} If `query` is empty / whitespace-only.
 * @example
 * ```ts
 * const result = await searchHybrid(
 *   vault,
 *   { query: "RAG hybrid retrieval", limit: 10, folder: "Reference" },
 *   { ftsIndex, embedFile: "/path/to/vault.embed.db" }
 * );
 * for (const hit of result.matches) {
 *   console.log(hit.path, hit.score, hit.per_signal);
 * }
 * console.log("Rankers fired:", result.signals_used);
 * ```
 */
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

/**
 * Build a fixed-width snippet centered on a character index within `text`,
 * plus the 1-based line number where the match starts.
 *
 * Window is 60 chars before + `qLen` + 60 chars after, whitespace-collapsed,
 * with `…` truncation markers when the window is clipped at either end.
 * Used by {@link searchText} and {@link semanticSearch} to produce human-
 * readable evidence excerpts.
 *
 * @internal
 * @param text - The full text body to slice.
 * @param idx - Character offset of the match. Negative values return an
 *   empty snippet.
 * @param qLen - Length of the matched substring.
 * @returns `{ snippet, line }` — `line` is 0 if `idx < 0`.
 * @example
 * ```ts
 * sliceSnippet("Hello world, this is a long text", 6, 5);
 * // → { snippet: "Hello world, this is a long text", line: 1 }
 * ```
 */
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
