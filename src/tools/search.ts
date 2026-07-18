import * as path from "node:path";
import type { FtsIndex } from "../fts5.js";
import { foldName, foldTag, lookupFoldedKey, nfcLower } from "../name-fold.js";
import { computeStaleness, recencyScore } from "../staleness.js";
import type { FileEntry, Vault } from "../vault.js";
import { foldForMatch, splitLines, stripTrailingSlashes } from "../wildcard-match.js";
import { capScanEntries } from "./limits.js";
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
  // v3.11.1-rc.2 — fold the needle PER CODE POINT (foldForMatch), NOT whole-string
  // `.toLowerCase()`: the haystack below is folded per code point by `foldWithMap`, and a
  // whole-string fold applies Greek word-final sigma (`"ΟΔΟΣ"`→`"οδος"`, final `ς`) while the
  // haystack folds to medial `σ` → `indexOf` returns -1 and the note is SILENTLY DROPPED
  // (tokenScore 0 → return null). Unlike the semanticSearch snippet sibling (cosmetic), here
  // `indexOf` is the SOLE matcher, so the asymmetry is a recall miss, not just mis-centring.
  const lowerTokens = tokens.map((t) => foldForMatch(t));

  // v3.11.0-rc.11 (rc.9-audit L2, defense-in-depth) — cap the whole-vault scan
  // (parity with findSimilar/validateNoteProposal). This tool is gated behind
  // --diagnostic-search-tools, but a bounded scan keeps a pathological vault from
  // a sustained per-note read+tokenize amplifier on serve-http.
  const entries = capScanEntries(await vault.listMarkdown(args.folder), "obsidian_search_text");

  // Parallel file reads — was sequential, slow on large vaults. Chunk to
  // bound concurrency (avoid blowing the open-fd limit on huge vaults).
  const CHUNK = 16;
  const matches: SearchHit[] = [];
  for (let i = 0; i < entries.length; i += CHUNK) {
    const chunk = entries.slice(i, i + CHUNK);
    const results = await Promise.all(
      chunk.map(async (e) => {
        const { content } = await vault.readNote(e.absPath, e.mtimeMs);
        // rc.21 — fold with an offset map so `firstHit` maps back to the ORIGINAL
        // string before slicing (a length-expanding fold char would drift the offset).
        const { folded: lower, map: foldMap } = foldWithMap(content);
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
        const origHit = firstHit >= 0 ? (foldMap[firstHit] ?? firstHit) : firstHit;
        const { snippet, line } = sliceSnippet(content, origHit, firstHitLen);
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
  /** v3.10 — whole days since `mtime` (freshness signal; never negative). */
  age_days: number;
  /** v3.10 — `true` when older than the default stale threshold (365d). */
  stale: boolean;
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
  // rc.36 F-4 (R-5/AS#5 sibling) — cap the whole-vault scan: findSimilar builds
  // a vault-sized `metas` + `inboundFor` graph and scores pairwise against the
  // target. Defense-in-depth against a pathological vault over serve-http;
  // 50_000 ≫ any real vault, so a partial scan only trims the similarity tail.
  const entries = capScanEntries(await vault.listMarkdown(), "obsidian_find_similar");

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
    const tags = new Set(parsed.tags.map((t) => foldTag(t)));
    const title3grams = ngrams(foldName(stripMd(e.basename)), 3);
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

  const now = Date.now(); // v3.10 — one staleness reference for all hits in this response
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
      mtime: new Date(m.entry.mtimeMs).toISOString(),
      ...computeStaleness(m.entry.mtimeMs, now)
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
// v3.11.6-rc.15 (audit H-1) — single-flight: a corpus build in flight for a given
// Vault + corpus snapshot, so concurrent cold callers share ONE build instead of
// each running the whole read+tokenize scan. Keyed by Vault (WeakMap → GC'd with it).
const tfidfPending = new WeakMap<
  Vault,
  {
    entriesRef: FileEntry[];
    promise: Promise<{ docs: DocVector[]; idf: Map<string, number>; entriesRef: FileEntry[] }>;
  }
>();

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
  // v3.11.0-rc.10 (M1 LOW sibling) — NFC-normalize before lowercasing so the TF-IDF
  // tokenizer is symmetric across Unicode forms: an NFD-on-disk body and an NFC query
  // (or vice versa) tokenize identically (`café`-NFD → `café`-NFC) instead of the body
  // tokenizing to `cafe` and the query to `café`. This tokenizer serves BOTH the indexed
  // body and the query, so normalizing here closes the asymmetry at a single point.
  const lower = text.normalize("NFC").toLowerCase();
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
  if (cached && sameCorpus(cached.entriesRef, entries)) {
    return cached;
  }

  // v3.11.6-rc.15 (external rc.14 audit H-1) — SINGLE-FLIGHT the corpus build.
  // Pre-rc.15 the cache published ONLY the completed result, so N concurrent
  // callers on a cold/invalidated cache each ran the full read+tokenize scan.
  // The always-on multi-query fan-out (`obsidian_search` `queries[]`, up to 8
  // extra phrasings + the main query = 9) starts every sub-query with
  // `Promise.all`, so a single legal bearer-reachable request could trigger 9
  // concurrent whole-vault corpus builds (measured ~10-12× reads / ~3.2s /
  // +224MB RSS at 6.4k notes — a cold-start / event-loop DoS amplifier). Now a
  // build-in-flight for THIS exact corpus snapshot is shared: concurrent callers
  // await the one pending promise instead of racing their own scans.
  const pending = tfidfPending.get(vault);
  if (pending && sameCorpus(pending.entriesRef, entries)) {
    return pending.promise;
  }

  // Publish the pending promise BEFORE the first `await` inside the build (the
  // IIFE runs synchronously up to its first `readNote` await, then this set()
  // runs — no await between, so a concurrent caller resuming from its own
  // `listMarkdown` await observes this pending entry).
  const promise = buildTfidfIndexUncached(vault, entries);
  tfidfPending.set(vault, { entriesRef: entries, promise });
  try {
    return await promise;
  } finally {
    // Clear pending only if it's still OURS — a newer invalidating build may
    // have replaced it while this one was in flight.
    const cur = tfidfPending.get(vault);
    if (cur && cur.promise === promise) tfidfPending.delete(vault);
  }
}

/** Corpus-snapshot equality: same file set at the same mtimes, in order. Shared
 *  by the completed-cache check and the single-flight pending check (rc.15). */
function sameCorpus(ref: FileEntry[], entries: FileEntry[]): boolean {
  return (
    ref.length === entries.length &&
    ref.every((e, i) => entries[i]?.relPath === e.relPath && entries[i]?.mtimeMs === e.mtimeMs)
  );
}

/** The actual read+tokenize+weight corpus build (rc.15 — extracted from
 *  {@link buildTfidfIndex} so the single-flight wrapper owns cache publication).
 *  Sets the completed `tfidfCache` on success. */
async function buildTfidfIndexUncached(
  vault: Vault,
  entries: FileEntry[]
): Promise<{ docs: DocVector[]; idf: Map<string, number>; entriesRef: FileEntry[] }> {
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
  /** v3.10 — whole days since `mtime` (freshness signal; never negative). */
  age_days: number;
  /** v3.10 — `true` when older than the default stale threshold (365d). */
  stale: boolean;
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
  const folderPrefix = args.folder ? `${stripTrailingSlashes(args.folder)}/` : null;
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

  const now = Date.now(); // v3.10 — one staleness reference for all hits in this response
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
      // rc.21 — original-string offset (not the toLowerCase() copy's): a
      // length-expanding fold char before the term shifted the naive offset.
      const idx = foldedIndexOf(body, t);
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
      mtime: new Date(doc.mtimeMs).toISOString(),
      ...computeStaleness(doc.mtimeMs, now)
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
 * v3.9.0-rc.3 R-10 — adaptive HNSW refill loop for under-returned
 * semantic-search queries.
 *
 * Background: the embed-db can contain entries for paths that the
 * privacy filter (`vault.isExcluded`) then drops at response-build
 * time. Pre-3.9.0-rc.3:
 *   - v2.13.0 fetched `limit * 2` from HNSW.
 *   - v3.8.0-rc.9 raised to `max(overFetch * 3, 50)` (effective 6× limit).
 *   - But both were STATIC multipliers — a vault with 80% excluded
 *     entries still under-returned because filtering left < limit.
 *
 * The adaptive loop solves this self-tuningly: if after filtering
 * the result set is < limit AND k < maxLabels, double k and try again.
 * Bounded by `maxAttempts` (default 3) so a fully-exhausted query
 * doesn't burn arbitrary CPU. Most vaults converge on the first
 * attempt (typical exclude ratio < 20%); the refill engages only
 * for long-tail privacy-heavy configurations.
 *
 * Pure function. The HNSW search and filter callbacks are injected so
 * tests can drive the loop with stub searchKnn + filter implementations.
 *
 * @param ctx - Loop inputs:
 *   - `initialK`: first attempt's k (typically `max(overFetch * 3, 50)`)
 *   - `maxLabels`: index size; k is capped at this
 *   - `limit`: caller's desired top-K (loop stops once filtered ≥ limit)
 *   - `searchKnn(k)`: HNSW search returning labels + distances arrays
 *   - `filter(labels, distances)`: apply min_score / folder / privacy
 *     filters; returns a post-filtered hit array
 *   - `maxAttempts`: bound on iterations (default 3)
 * @returns the final filtered hit array (may still be < limit if even
 *   the saturated k+filter couldn't satisfy — caller must handle).
 */
export function adaptiveHnswRefill<T>(ctx: {
  initialK: number;
  maxLabels: number;
  limit: number;
  searchKnn: (k: number) => { labels: number[]; distances: number[] };
  filter: (labels: number[], distances: number[]) => T[];
  maxAttempts?: number;
}): T[] {
  const maxAttempts = ctx.maxAttempts ?? 3;
  let k = Math.min(ctx.initialK, ctx.maxLabels);
  let filtered: T[] = [];
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const result = ctx.searchKnn(k);
    filtered = ctx.filter(result.labels, result.distances);
    if (filtered.length >= ctx.limit) break;
    if (k >= ctx.maxLabels) break; // saturated — re-search would yield same set
    k = Math.min(k * 2, ctx.maxLabels);
  }
  return filtered;
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
 * `--exclude-glob` / `--read-paths` never leak through. To keep the returned
 * count stable under normal exclude-glob use, the search over-fetches by 2×
 * (brute-force) or 6× (HNSW). Under extreme configurations where the majority
 * of the embed-db is excluded, fewer than `limit` results may be returned —
 * this is accepted behavior: privacy takes precedence over result count.
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
  const [{ EmbedDb, peekEmbedDbMetaCached }, { loadEmbedder, resolveModel }] = await Promise.all([
    import("../embed-db.js"),
    import("../embeddings.js")
  ]);

  // Verify the embed db exists before doing anything heavy. This separates
  // "user hasn't built the index yet" from "model failed to load".
  const fsMod = await import("node:fs");
  if (!fsMod.existsSync(embedFile)) {
    // v3.9.0-rc.34 (deep-audit P-3) — this error propagates to the MCP client
    // (a tool-handler throw), so on bearer-auth `serve-http` it must NOT echo
    // the absolute vault path / embed-db path (filesystem fingerprinting).
    // Sanitized to a path-free, still-actionable remediation. (Both `embedFile`
    // and `vault.root` were absolute; the auditor flagged only `vault.root`.)
    throw new Error(
      "Embedding index not found. " +
        "Run `enquire-mcp build-embeddings --vault <your-vault>` to build it " +
        "(first-time setup also needs `enquire-mcp install-model multilingual`)."
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
  //
  // v3.7.0 L-1 — uses `peekEmbedDbMetaCached` so the SQLite open+close
  // overhead (~5-10ms) only fires on the first search after a file-mtime
  // change. Subsequent searches against the same embed-db hit the
  // module-level cache (~µs). Mtime-based invalidation covers the
  // clear-embeddings + build-embeddings rebuild flow automatically.
  const existingMeta = await peekEmbedDbMetaCached(embedFile);
  // v3.7.5 CRITICAL — external-audit caught read-only-search-can-DROP
  // (K-1-class sibling that v3.6.4 cli.ts closure didn't model).
  // Read-only search MUST NOT trigger destructive rebuild. Pre-fix: if user passed
  // `embedding_model` override that differed from the stored model_alias,
  // the EmbedDb open path would DROP TABLE embeddings and rebuild as the
  // user's choice. That's a data-loss side effect from a read-only tool.
  // Now: if user-explicit override mismatches stored alias, throw a
  // clear actionable error — never silently destroy the index. To
  // intentionally switch models, the user must run
  // `enquire-mcp clear-embeddings` + `build-embeddings --embedding-model X`
  // explicitly (those paths are documented write/build operations).
  if (args.model && existingMeta?.model_alias && args.model !== existingMeta.model_alias) {
    throw new Error(
      `embeddingsSearch: requested model '${args.model}' does not match the embed-db's stored model '${existingMeta.model_alias}'. ` +
        `Read-only search refuses to rebuild the index. ` +
        `To switch models, run: enquire-mcp clear-embeddings --vault <path> && enquire-mcp build-embeddings --vault <path> --embedding-model ${args.model}`
    );
  }
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
    // v3.7.5 CRITICAL — external-audit caught embedder/db model mismatch
    // (a residual K-1-class instance the v3.6.4 cli.ts closure didn't
    // cover). Pre-fix: when user omitted `args.model` and the embed-db
    // was built with `bge`, we opened the DB as `bge` (correct via peek-
    // honor) but loaded the embedder as `multilingual` (the default that
    // `loadEmbedder(undefined)` resolves to). Result: query vector built
    // in `multilingual` vector space but similarity computed against
    // `bge` chunks — silent garbage output with response still reporting
    // `model: "bge"`. HNSW path had `assertHnswModelMatchesEmbedder`
    // which converted this to an error for HNSW, but brute-force cosine
    // and HyDE silent-passed. Now we load embedder via `model.alias`
    // (already resolved + honored above).
    const embedder = await loadEmbedder(model.alias);
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
      // more than brute-force because HNSW can occasionally miss a true
      // nearest neighbor AND because the privacy filter pares down the pool.
      // v3.8.0-rc.9 R-10 — bumped multiplier from ×2 → ×3 (effective 4× →
      // 6× limit) to reduce under-return when many embed-db entries are
      // excluded by --exclude-glob / --read-paths.
      // v3.9.0-rc.3 R-10 — adaptive refill loop. Closes the ">66% excluded"
      // under-return class that rc.9's static multiplier could not fully
      // solve. See `adaptiveHnswRefill` for the algorithm.
      const maxLabels = Math.max(hnsw.rowByLabel.size, 1);
      const initialK = Math.min(Math.max(overFetch * 3, 50), maxLabels);
      const { hnswResultsToHits } = await import("../hnsw.js");
      const folderPrefix = args.folder ? `${stripTrailingSlashes(args.folder)}/` : null;
      rawHits = adaptiveHnswRefill({
        initialK,
        maxLabels,
        limit,
        searchKnn: (k) => hnsw.index.searchKnn(qVec, k, hnsw.ef !== undefined ? { ef: hnsw.ef } : undefined),
        filter: (labels, distances) => {
          let h = hnswResultsToHits({ labels, distances }, hnsw.rowByLabel);
          if (folderPrefix) h = h.filter((row) => row.rel_path.startsWith(folderPrefix));
          h = h.filter((row) => row.score >= minScore);
          // Privacy filter applied here too so the refill loop's "did we
          // get enough?" check is accurate. The downstream filter then
          // re-applies (idempotent — already-filtered hits pass through).
          // v3.10.0-rc.22 (audit M8) — via the shared, unit-tested helper.
          return filterExcludedEmbedHits(h, (p) => vault.isExcluded(p));
        }
      });
    } else {
      rawHits = db.search(qVec, overFetch, { folder: args.folder, minScore });
    }
    // v3.10.0-rc.22 (audit M8) — terminal privacy filter via the shared,
    // unit-tested helper (was an inline `.filter` the security test only
    // reimplemented, never exercised).
    const hits = filterExcludedEmbedHits(rawHits, (p) => vault.isExcluded(p)).slice(0, limit);
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
/**
 * v3.11.6 (S-5) — per-hit ranking EXPLANATION, attached to a {@link SearchHybridHit}
 * ONLY when the search was called with `explain: true`. It makes every re-rank
 * stage's contribution — and the rank MOVEMENT it caused — visible, so you can
 * see WHY a hit landed where it did and, crucially, whether the opt-in
 * `--recency-weight` / `--feedback-weight` stages actually changed the order
 * (both were previously evidence-poor: the response showed the final order but
 * never which stage produced it). Every field is a score / rank / age only — no
 * note content beyond what the hit already carries (privacy-safe). Ranks are
 * 0-based positions in the fused candidate list at each stage boundary.
 */
export interface SearchHitExplain {
  /** RRF-fused rank + score right after Reciprocal Rank Fusion, BEFORE any re-rank stage. The three ranker arms that fed it live in the hit's `per_signal`. */
  rrf: { rank: number; score: number };
  /** Wikilink graph-boost (v2.3.0): in-degree among the fused top-K + the score added (α × in_degree). Present only when graph-boost ran AND this hit received a boost. */
  graph_boost?: { in_degree: number; score_delta: number };
  /** Cross-encoder reranker (v2.9.0): the reranker score + rank before/after the rerank re-sort. Present only when a reranker ran and scored this hit. */
  reranker?: { score: number; rank_before: number; rank_after: number };
  /** Opt-in recency re-rank (`--recency-weight`): the note's age + recency score + rank before/after. Present only when recency re-rank was active AND the note's mtime was stattable (a path deleted mid-flight contributes recency 0 and is omitted here); `rank_before === rank_after` means recency did NOT move this hit. */
  recency?: { age_days: number; recency_score: number; rank_before: number; rank_after: number };
  /** Opt-in closed-loop feedback re-rank (`--feedback-weight`): the note's feedback score + rank before/after. Present only when feedback re-rank was active; `rank_before === rank_after` means feedback did NOT move this hit. */
  feedback?: { feedback_score: number; rank_before: number; rank_after: number };
  /** Final 0-based rank of this hit in the returned `matches`. */
  final_rank: number;
}

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
  /**
   * v3.10 — whole days since the note's current on-disk `mtime` (freshness
   * signal for forgetting-aware recall; never negative). Computed by statting
   * the final hit paths, so it reflects the live file mtime, not the possibly-
   * lagging indexed mtime in FTS5/embed-db `source_state`. Omitted (along with
   * `stale`) only when the stat fails — e.g. the file was deleted between
   * fusion and response assembly (fail-soft, never throws).
   */
  age_days?: number;
  /**
   * v3.10 — `true` when `age_days >= DEFAULT_STALE_DAYS` (365). Lets an agent
   * flag a recalled fact as potentially out-of-date instead of presenting it
   * as current (the Memora stale-memory-reuse frontier). Read-only signal —
   * does NOT reorder results (opt-in recency re-ranking is a separate flag).
   */
  stale?: boolean;
  /**
   * v3.11.6 (S-5) — per-stage ranking explanation. Present ONLY when the search
   * was called with `explain: true`. See {@link SearchHitExplain}.
   */
  explain?: SearchHitExplain;
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
  /** v3.10.0-rc.13 — reranker outcome, present ONLY when a cross-encoder was
   *  requested (`--enable-reranker` / `ctx.reranker`). `{applied:true, pairs:N}`
   *  when it re-scored N candidates; `{applied:false, reason}` when requested but
   *  it didn't run — `reason` mirrors `signal_errors.reranker` on a load/download
   *  failure, or notes there were no candidates. Closes the v3.9.1 bug-report
   *  Issue 9 (reranker silently fell back to RRF with no way to tell whether it
   *  was downloading, failed, or disabled). The stderr lifecycle log
   *  (`reranker '<alias>' loading…` / `loaded; reranked N pairs`) is the
   *  serve-side companion. */
  reranked?: { applied: boolean; pairs?: number; reason?: string };
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
 *   `granularity: "note"` (default) collapses to best chunk per note (fused by
 *   path — unaffected by chunking differences); `"block"` keeps each chunk
 *   distinct (fused by `path#chunk_index`). NB for notes WITH frontmatter the
 *   embeddings ranker chunks the body while BM25 chunks the full content, so a
 *   `block` chunk INDEX may not denote the same span across the two rankers —
 *   prefer the default `note` granularity for frontmatter-heavy vaults (audit M1).
 *   `graph_boost` defaults to `true`.
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
/**
 * v3.10.0-rc.8 — prune excluded paths from a fused ranking list, at the
 * fusion-stage source. Defense-in-depth parity with the rc.18 L-HYB-1
 * response-build guard: the fusion-stage consumers of the fused list
 * (graph-boost reads candidate CONTENT via `readNote`; recency stats candidate
 * mtime) run before that terminal guard, and this keeps them excluded-free even
 * if a future ranker arm forgets its own per-arm filter.
 *
 * Pure (the `isExcluded` predicate is injected) and granularity-aware: for
 * `"block"` ids of the form `path#chunk`, the chunk suffix is stripped before
 * the membership test — matching the response-build guard's `lastIndexOf("#")`
 * logic exactly so the two layers never disagree.
 *
 * @param hits - fused ranking entries (each carries an `id` = path or `path#chunk`).
 * @param isExcluded - returns true if a vault-relative path is excluded (`vault.isExcluded`).
 * @param granularity - `"note"` (id IS the path) or `"block"` (id is `path#chunk`).
 * @returns a new array with excluded-path entries removed (order preserved).
 */
export function pruneExcludedHits<T extends { id: string }>(
  hits: T[],
  isExcluded: (relPath: string) => boolean,
  granularity: "note" | "block"
): T[] {
  return hits.filter((h) => {
    let p = h.id;
    if (granularity === "block") {
      const hashIdx = h.id.lastIndexOf("#");
      if (hashIdx > 0) p = h.id.slice(0, hashIdx);
    }
    return !isExcluded(p);
  });
}

/**
 * v3.10.0-rc.22 (audit M8) — pure privacy filter for embed-search hits; the
 * `embeddingsSearch` sibling of {@link pruneExcludedHits}. Drops rows whose
 * `rel_path` is excluded by the injected predicate (`vault.isExcluded`). Embed
 * hits carry a bare `rel_path` (no `#chunk` suffix), so — unlike
 * `pruneExcludedHits` — there's no id-splitting.
 *
 * Extracted so the actual filter `embeddingsSearch` applies (it ran inline at
 * two sites: the HNSW refill path + the brute-force path) is unit-testable
 * WITHOUT loading the ML embedder the function needs to encode a query. Before
 * rc.22 the security test "reimplemented" this filter inline and never exercised
 * the real code path — a vacuous (theater) test that would have passed even if
 * `embeddingsSearch` had dropped its guard.
 *
 * @param hits - embed-search rows (each carries a vault-relative `rel_path`).
 * @param isExcluded - true if a vault-relative path is excluded.
 * @returns a new array with excluded-path rows removed (order preserved).
 */
export function filterExcludedEmbedHits<T extends { rel_path: string }>(
  hits: T[],
  isExcluded: (relPath: string) => boolean
): T[] {
  return hits.filter((h) => !isExcluded(h.rel_path));
}

/** v3.10 (rc.10) — a scalar a frontmatter filter can match against. */
export type FrontmatterFilterScalar = string | number | boolean;
/** v3.10 (rc.10) — one filter value: a scalar, or an array of scalars (OR-semantics). */
export type FrontmatterFilterValue = FrontmatterFilterScalar | FrontmatterFilterScalar[];

/**
 * v3.10 (rc.10) — case-insensitive-for-strings, strict-for-number/boolean scalar
 * equality. Strings compare case- and whitespace-insensitively (frontmatter is
 * human-authored — `Active` should match `active`); numbers/booleans compare
 * strictly. Mixed types never match (`"1"` ≠ `1`).
 */
function frontmatterScalarEq(a: unknown, b: FrontmatterFilterScalar): boolean {
  // v3.11.0-rc.9 (audit re-verify sibling of rc.8 DQL nfcLower) — NFC-fold both
  // operands so an NFC `filter_frontmatter` value matches an NFD-on-disk value
  // (macOS); case-insensitive matches the prior `.toLowerCase()` contract.
  if (typeof b === "string") return typeof a === "string" && nfcLower(a.trim()) === nfcLower(b.trim());
  return a === b; // number / boolean — strict
}

/**
 * v3.10 (rc.10) — does a single note frontmatter value satisfy one filter value?
 * Handles the four shapes intuitively:
 * - note scalar vs filter scalar → equality
 * - note scalar vs filter array  → note ∈ filter (OR)
 * - note array  vs filter scalar → filter ∈ note (membership, e.g. `tags`)
 * - note array  vs filter array  → non-empty intersection (any-of)
 */
function frontmatterValueMatches(have: unknown, want: FrontmatterFilterValue): boolean {
  const wants = Array.isArray(want) ? want : [want];
  const haves = Array.isArray(have) ? have : [have];
  return wants.some((w) => haves.some((h) => frontmatterScalarEq(h, w)));
}

/**
 * v3.10 (rc.10) — does a note's frontmatter satisfy a frontmatter filter?
 *
 * AND across keys (every `key: value` pair must match); per-key matching is
 * scalar-equality or array-membership, with OR over an array filter value
 * (see `frontmatterValueMatches`). A note with NO frontmatter, or missing any filtered
 * key, does NOT match (a filter is a positive assertion — absence ≠ match). Pure
 * + injectable so it's unit-tested directly without spinning up a vault.
 *
 * @example
 * ```ts
 * frontmatterMatches({ status: "Active", tags: ["proj", "x"] }, { status: "active", tags: "proj" }); // true
 * frontmatterMatches({ status: "done" }, { status: "active" }); // false
 * frontmatterMatches(undefined, { status: "active" }); // false (no frontmatter)
 * ```
 */
export function frontmatterMatches(
  frontmatter: Record<string, unknown> | undefined | null,
  filter: Record<string, FrontmatterFilterValue>
): boolean {
  if (!frontmatter) return false;
  for (const [key, want] of Object.entries(filter)) {
    // v3.11.0-rc.10 (H1, external audit) — case/NFC-insensitive KEY lookup. rc.9
    // folded the VALUE side but the KEY was still exact-string (`Status` filter
    // missed `status`, NFC key missed an NFD-on-disk key). Obsidian properties are
    // case-insensitive, so fold the key at lookup time (never destructively at parse).
    const { present, value } = lookupFoldedKey(frontmatter, key);
    if (!present) return false;
    if (!frontmatterValueMatches(value, want)) return false;
  }
  return true;
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
    /**
     * v3.10 (rc.10) — optional frontmatter filter. A `{ key: value }` map;
     * a hit is kept only if its note's YAML frontmatter satisfies EVERY pair
     * (AND across keys). Per key, the value matches by scalar-equality
     * (strings case-insensitive) or array-membership, and a filter value may
     * itself be an array for OR — see {@link frontmatterMatches}. A note with
     * no frontmatter, or missing a filtered key, is excluded (a filter is a
     * positive assertion). Absent ⇒ no filtering (byte-identical to pre-3.10).
     * Filtering happens on the fused candidate pool (already excluded-pruned),
     * so a strict filter may return fewer than `limit` hits — that's correct.
     * @example `{ status: "active", type: ["meeting", "decision"] }`
     */
    filter_frontmatter?: Record<string, FrontmatterFilterValue>;
    /**
     * v3.11.6 (S-5) — when true, attach a per-hit {@link SearchHitExplain}
     * breakdown (RRF rank/score, graph-boost, reranker, and the opt-in recency /
     * feedback rank movement) to every returned hit. Diagnostic — adds a small
     * per-hit object and a few `Map`s while ranking. Absent/false ⇒ no `explain`
     * field and zero extra allocation (byte-identical to pre-S-5). Meaningful
     * only on the single-query path (`searchHybridMulti` re-fuses sub-query
     * lists, so per-stage ranks wouldn't map to the final order — it drops it).
     */
    explain?: boolean;
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
    /**
     * v3.10 (rc.5) — optional opt-in recency re-ranking. When `weight > 0`,
     * the final fused order is re-sorted by a blend of relevance rank and the
     * note's live-mtime recency (see `recencyScore` in staleness.ts). `weight = 0` (or
     * undefined) is a no-op — the default keeps ranking purely relevance-driven.
     * `staleDays` is the recency half-life (the age at which recency = 0.5).
     */
    recency?: { weight: number; staleDays: number };
    /**
     * v3.11.0 — optional opt-in closed-loop feedback re-ranking. When `weight > 0`
     * AND `scores` is non-empty, the final fused order is re-sorted by a blend of
     * relevance rank and each note's feedback score (`useful/(useful+notUseful+1)`,
     * from `obsidian_mark_useful` via the `FeedbackStore`). `weight = 0` / empty
     * `scores` is a provable no-op. Applied AFTER recency so a "human said this
     * helped" signal is the final tie-break. `scores` is keyed by relPath.
     */
    feedback?: { weight: number; scores: ReadonlyMap<string, number> };
  }
): Promise<SearchHybridResponse> {
  await vault.ensureExists();
  if (!args.query.trim()) throw new Error("query must not be empty");
  const limit = args.limit ?? 10;
  const minSignals = args.min_signals ?? 1;
  const granularity = args.granularity ?? "note";
  // v3.10 (rc.10) — opt-in frontmatter filter. Normalized to `undefined` when
  // absent/empty so the per-candidate filter block (and its extra readNote) is
  // skipped entirely on the default path ⇒ byte-identical to pre-3.10.
  const fmFilter =
    args.filter_frontmatter && Object.keys(args.filter_frontmatter).length > 0 ? args.filter_frontmatter : undefined;
  // Fan-out per-ranker top-K. Bigger than user's `limit` so RRF has room
  // to surface a doc that's mid-rank in one signal but top in another.
  const fanOutK = Math.max(50, limit * 5);

  // v3.11.6 (S-5) — opt-in per-hit ranking explanation. Each map is populated
  // only when `explain` is on; the default path allocates none of them and adds
  // no per-stage work (every recording site is guarded by the map's presence).
  const explain = args.explain === true;
  const round5 = (n: number): number => Math.round(n * 100000) / 100000;
  const posOf = (arr: readonly { id: string }[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (let i = 0; i < arr.length; i++) {
      const el = arr[i];
      if (el) m.set(el.id, i);
    }
    return m;
  };
  const exRrf = explain ? new Map<string, { rank: number; score: number }>() : undefined;
  const exGraph = explain ? new Map<string, { in_degree: number; score_delta: number }>() : undefined;
  const exRerank = explain ? new Map<string, { score: number; rank_before: number; rank_after: number }>() : undefined;
  const exRecency = explain
    ? new Map<string, { age_days: number; recency_score: number; rank_before: number; rank_after: number }>()
    : undefined;
  const exFeedback = explain
    ? new Map<string, { feedback_score: number; rank_before: number; rank_after: number }>()
    : undefined;

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
  let fused = reciprocalRankFusion(
    {
      bm25: bm25Ranked.map((h) => ({ id: h.id, rank: h.rank, score: h.score })),
      tfidf: tfidfRanked.map((h) => ({ id: h.id, rank: h.rank, score: h.score })),
      embeddings: embedRanked.map((h) => ({ id: h.id, rank: h.rank, score: h.score }))
    },
    { topK: Math.max(limit * 4, 30) } // overshoot — graph boost may rerank
  );

  // v3.10.0-rc.8 (post-rc.7 audit) — privacy guard at the SOURCE, for parity
  // with the rc.18 L-HYB-1 response-build guard. The fusion-stage consumers of
  // `fused` run BEFORE that terminal guard: graph-boost (below) calls
  // `vault.readNote` to parse a candidate's wikilinks — reading its CONTENT —
  // and the rc.5 recency re-rank stats a candidate's mtime. Each ranker arm
  // ALREADY drops excluded paths (BM25 + embeddings post-filter, TF-IDF via
  // listMarkdown) AND the response-build guard (~line 1790) drops them from
  // output — so this is a THIRD, defense-in-depth layer that still holds if a
  // future ranker arm forgets its per-arm filter (L-HYB-1's rationale: "RRF
  // fusion trusts ranker inputs; don't"). Pruning here makes every downstream
  // fusion stage excluded-free by construction. Extracted to the pure
  // {@link pruneExcludedHits} and unit-tested directly: the public searchHybrid
  // path can't inject an excluded id into `fused` (the per-arm filters already
  // prevent it), so an integration test of this layer would be vacuous.
  fused = pruneExcludedHits(fused, (p) => vault.isExcluded(p), granularity);

  // S-5 — snapshot the pure-RRF order/score BEFORE any re-rank stage runs.
  if (exRrf) {
    fused.forEach((f, i) => {
      exRrf.set(f.id, { rank: i, score: round5(f.score) });
    });
  }

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
    // v3.7.16 P2-16 — strip the `#chunk-N` suffix ONLY when it's a chunk
    // marker, not a literal `#` in the filename. Pre-3.7.16 `f.id.split("#")[0]`
    // mangled `C# Notes.md` → `C` and broke graph boost for any filename
    // containing `#`. The post-3.7.16 regex strips `#<digits>` ONLY at the
    // end of the id, matching the chunker's `${path}#${chunkIndex}` format.
    const stripChunkSuffix = (id: string): string => id.replace(/#\d+$/, "");
    const candidatePaths = new Set<string>();
    for (const f of fused) {
      const candidatePath = stripChunkSuffix(f.id);
      // v3.7.12 M6 — skip non-markdown candidates. PDF/canvas/base files
      // can show up in `fused` (PDFs ride the same FTS5 + embeddings tables
      // when --include-pdfs is on) but they don't have wikilinks parsable
      // by `vault.readNote`. Calling `readNote` on `Foo.pdf` triggers an
      // I/O round-trip + UTF-8 decode of binary bytes + a swallowed parse
      // error — wasted work that the try/catch was hiding. Restrict to
      // `.md` so graph boost stays a wikilinks-on-markdown signal.
      const lower = candidatePath.toLowerCase();
      if (!lower.endsWith(".md")) continue;
      candidatePaths.add(candidatePath);
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
          // v3.10.0-rc.66 (round-3 audit) — fold through foldName (NFC + case-fold), the same
          // canonical key the other 14 rc.46 name-comparison sites + findBestMatch use. Without
          // it, a wikilink target (NFC, user-authored) never matched a candidate path (NFD on
          // macOS APFS), so an accented note silently lost its graph-boost in-degree tie-break.
          // This was the one name-comparison site the rc.46 sweep missed (it used `stripMd`
          // WITHOUT `.toLowerCase()`, so the name-fold detector's signature didn't catch it).
          targets.add(foldName(wl.target));
          targets.add(foldName(stripMd(wl.target)));
        }
        outLinks.set(candidatePath, targets);
      } catch {
        // skip unreadable notes
      }
    }
    const ALPHA = 0.005;
    for (const f of fused) {
      const fPath = stripChunkSuffix(f.id); // v3.7.16 P2-16
      const fBasename = stripMd(path.basename(fPath));
      let inDegree = 0;
      for (const [otherPath, targets] of outLinks) {
        if (otherPath === fPath) continue;
        // rc.66 — fold the candidate keys through the SAME canonical key as the targets above.
        if (targets.has(foldName(fPath)) || targets.has(foldName(stripMd(fPath))) || targets.has(foldName(fBasename))) {
          inDegree += 1;
        }
      }
      if (inDegree > 0) {
        f.score += ALPHA * inDegree;
        if (exGraph) exGraph.set(f.id, { in_degree: inDegree, score_delta: round5(ALPHA * inDegree) });
      }
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
  let rerankedPairs = 0;
  if ((ctx.reranker || ctx.rerankerOverride) && fused.length > 0) {
    const topN = ctx.reranker?.topN ?? 50;
    const rerankBatch = fused.slice(0, topN);
    try {
      // Prefer the test-injected reranker when present; otherwise lazy-load.
      let reranker: { score(query: string, passages: readonly string[]): Promise<number[]> };
      if (ctx.rerankerOverride) {
        reranker = ctx.rerankerOverride;
      } else {
        // v3.10.0-rc.13 (bug-report Issue 9) — reranker lifecycle logging. The
        // first --enable-reranker call lazily downloads a cross-encoder (~110 MB
        // for the default rerank-bge); previously this was SILENT, so a long hang
        // that exceeded the client's tool-call timeout looked like an unexplained
        // RRF fallback. Announce the load (with size) BEFORE it blocks, and
        // confirm AFTER — three distinguishable states (loading… / loaded /
        // failed) on stderr. Pre-cache with `enquire-mcp install-model <alias>`.
        const emb = await import("../embeddings.js");
        const rmodel = emb.resolveRerankerModel(ctx.reranker?.alias);
        process.stderr.write(
          `obsidian_search: reranker '${rmodel.alias}' loading (~${rmodel.approxSizeMB} MB; first call downloads from HuggingFace and can take 30-60s)…\n`
        );
        reranker = await emb.loadReranker(ctx.reranker?.alias);
      }
      // For each candidate, find the best snippet (BM25 > embeddings > TF-IDF)
      // and pair it with the query. Empty-snippet candidates go to the bottom
      // by getting a -Infinity score (sort below scored candidates).
      //
      // v3.7.6 M-12 (external audit) — pre-fix the empty-snippet sentinel
      // was implicit: we passed `""` to the reranker and the comment
      // claimed those candidates would get -Infinity, but the reranker
      // returned a real (low) score for `""` and that score was used.
      // Now: track which passages were empty BEFORE scoring, and
      // explicitly set their final score to -Infinity regardless of
      // what the reranker returned. Matches the comment's contract.
      const emptySnippetIds = new Set<string>();
      const passages = rerankBatch.map((f) => {
        const bm = bm25Map.get(f.id);
        const emb = embedMap.get(f.id);
        const tf = tfidfMap.get(f.id);
        const snippet = bm?.snippet ?? emb?.snippet ?? tf?.snippet ?? "";
        if (!snippet.trim()) emptySnippetIds.add(f.id);
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
        if (!f) continue;
        // v3.7.6 M-12 — pin empty-snippet candidates to -Infinity per
        // the documented contract. Otherwise honor the reranker score.
        if (emptySnippetIds.has(f.id)) {
          rerankerScores.set(f.id, Number.NEGATIVE_INFINITY);
        } else if (typeof s === "number") {
          rerankerScores.set(f.id, s);
        }
      }
      // Sort the top-N by reranker score; everything below top-N keeps RRF
      // order. We do this by re-ordering fused[0..topN] in place.
      const reordered = [...rerankBatch].sort((a, b) => {
        const sa = rerankerScores?.get(a.id) ?? -Infinity;
        const sb = rerankerScores?.get(b.id) ?? -Infinity;
        return sb - sa;
      });
      const posBeforeRerank = exRerank ? posOf(fused) : undefined;
      for (let i = 0; i < reordered.length; i++) {
        fused[i] = reordered[i] as (typeof fused)[number];
      }
      if (exRerank && posBeforeRerank && rerankerScores) {
        const posAfter = posOf(fused);
        for (const [id, sc] of rerankerScores) {
          if (!Number.isFinite(sc)) continue; // empty-snippet -Infinity sentinels omitted
          exRerank.set(id, {
            score: round5(sc),
            rank_before: posBeforeRerank.get(id) ?? -1,
            rank_after: posAfter.get(id) ?? -1
          });
        }
      }
      rerankedPairs = rerankBatch.length;
      if (!ctx.rerankerOverride) {
        process.stderr.write(`obsidian_search: reranker loaded; reranked ${rerankedPairs} pairs\n`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Add to signalErrors so it surfaces in the response. Reranker is not
      // a "signal" per se but the existing dict is the right home.
      (signalErrors as Record<string, string>).reranker = msg;
      process.stderr.write(`obsidian_search: reranker failed — ${msg}\n`);
    }
  }

  // ─── v3.10 (rc.5): opt-in recency re-ranking ────────────────────────────
  // OFF unless `--recency-weight > 0`. Blends each candidate's RELEVANCE RANK
  // (its current position in `fused`, after RRF + graph-boost + reranker) with
  // a recency score derived from the note's LIVE on-disk mtime:
  //   key = (1 - w) * 1/(1+pos) + w * recencyScore(ageDays, staleDays)
  // The relevance term is rank-based (scale-free), so the blend is agnostic to
  // whether the order came from RRF or the cross-encoder — sidestepping the
  // score-magnitude mismatch between those stages. `w = 0` makes `key` a
  // strictly-decreasing function of `pos` ⇒ the order is preserved exactly
  // (provable no-op — which is why the default ranking stays relevance-pure).
  // Bounded: stats ≤ `fused.length` (≤ topK) unique paths, ONLY when enabled.
  // Fail-soft throughout — any stat / import failure keeps the relevance order.
  if (ctx.recency && ctx.recency.weight > 0 && fused.length > 1) {
    try {
      const { stat } = await import("node:fs/promises");
      const w = Math.min(1, Math.max(0, ctx.recency.weight));
      const staleDays = ctx.recency.staleDays;
      const now = Date.now();
      const pathOf = (id: string): string => {
        if (granularity !== "block") return id;
        const h = id.lastIndexOf("#");
        return h > 0 ? id.slice(0, h) : id;
      };
      const uniquePaths = [...new Set(fused.map((f) => pathOf(f.id)))];
      const ageByPath = new Map<string, number>();
      await Promise.all(
        uniquePaths.map(async (p) => {
          try {
            const s = await stat(vault.resolveInside(p));
            ageByPath.set(p, computeStaleness(s.mtimeMs, now, staleDays).age_days);
          } catch {
            // unstattable (e.g. deleted mid-flight) — omit; recency score 0 below.
          }
        })
      );
      const exAgeRec = exRecency ? new Map<string, { age: number; rec: number; statted: boolean }>() : undefined;
      const blended = fused.map((f, pos) => {
        const age = ageByPath.get(pathOf(f.id));
        const rec = typeof age === "number" ? recencyScore(age, staleDays) : 0;
        if (exAgeRec)
          exAgeRec.set(f.id, { age: typeof age === "number" ? age : 0, rec, statted: typeof age === "number" });
        const relevance = 1 / (1 + pos);
        return { f, key: (1 - w) * relevance + w * rec };
      });
      const posBeforeRecency = exRecency ? posOf(fused) : undefined;
      blended.sort((a, b) => b.key - a.key);
      for (let i = 0; i < blended.length; i++) {
        const b = blended[i];
        if (b) fused[i] = b.f;
      }
      if (exRecency && exAgeRec && posBeforeRecency) {
        const posAfter = posOf(fused);
        for (const f of fused) {
          const ar = exAgeRec.get(f.id);
          if (!ar) continue;
          // rc.12 — omit the entry for an unstattable path (deleted mid-flight):
          // it contributed recency 0, but reporting `age_days: 0` alongside
          // `recency_score: 0` would be internally inconsistent (age 0 ⇒ score 1).
          if (!ar.statted) continue;
          exRecency.set(f.id, {
            age_days: ar.age,
            recency_score: round5(ar.rec),
            rank_before: posBeforeRecency.get(f.id) ?? -1,
            rank_after: posAfter.get(f.id) ?? -1
          });
        }
      }
    } catch {
      // node:fs/promises import failed (should never happen) — keep relevance order.
    }
  }

  // ─── v3.11.0: opt-in closed-loop feedback re-ranking ────────────────────────
  // OFF unless `--feedback-weight > 0` AND at least one note has feedback. Blends
  // each candidate's RELEVANCE RANK (current `pos` in `fused`, after RRF +
  // graph-boost + reranker + any recency re-rank above) with its feedback score:
  //   key = (1 - w) * 1/(1+pos) + w * feedbackScore(path)
  // Same scale-free rank-based relevance term as the recency block, so the blend
  // is order-source-agnostic. `w = 0` (or no scores) ⇒ `key` strictly decreasing
  // in `pos` ⇒ order preserved exactly (provable no-op). Pure + in-memory (no
  // disk I/O) — the score map is computed once per call from the FeedbackStore.
  // Applied AFTER recency so the explicit human "this helped" signal wins ties.
  if (ctx.feedback && ctx.feedback.weight > 0 && ctx.feedback.scores.size > 0 && fused.length > 1) {
    const w = Math.min(1, Math.max(0, ctx.feedback.weight));
    const fbScores = ctx.feedback.scores;
    const fbPathOf = (id: string): string => {
      if (granularity !== "block") return id;
      const h = id.lastIndexOf("#");
      return h > 0 ? id.slice(0, h) : id;
    };
    const exFbTmp = exFeedback ? new Map<string, number>() : undefined;
    const blended = fused.map((f, pos) => {
      const fb = fbScores.get(fbPathOf(f.id)) ?? 0;
      if (exFbTmp) exFbTmp.set(f.id, fb);
      const relevance = 1 / (1 + pos);
      return { f, key: (1 - w) * relevance + w * fb };
    });
    const posBeforeFb = exFeedback ? posOf(fused) : undefined;
    blended.sort((a, b) => b.key - a.key);
    for (let i = 0; i < blended.length; i++) {
      const b = blended[i];
      if (b) fused[i] = b.f;
    }
    if (exFeedback && exFbTmp && posBeforeFb) {
      const posAfter = posOf(fused);
      for (const f of fused) {
        const fb = exFbTmp.get(f.id);
        if (fb === undefined) continue;
        exFeedback.set(f.id, {
          feedback_score: round5(fb),
          rank_before: posBeforeFb.get(f.id) ?? -1,
          rank_after: posAfter.get(f.id) ?? -1
        });
      }
    }
  }

  const matches: SearchHybridHit[] = [];
  for (const f of fused) {
    const numSignals = Object.keys(f.per_signal).length;
    if (numSignals < minSignals) continue;
    // v3.8.0-rc.18 L-HYB-1 (Cursor external audit on rc.15) — terminal
    // defense-in-depth privacy filter. Per-ranker arms (BM25 ~1262,
    // embeddings ~1019, TF-IDF via listMarkdown) already exclude private
    // paths, but RRF fusion trusts ranker inputs. If a future ranker arm
    // ships without the per-arm filter, this terminal guard prevents leakage
    // into the final SearchHybridHit[]. Cheap (string-glob match) and closes
    // the ε-class sibling gap noted by the audit.
    let pathForFilter = f.id;
    if (granularity === "block") {
      const hashIdx = f.id.lastIndexOf("#");
      if (hashIdx > 0) pathForFilter = f.id.slice(0, hashIdx);
    }
    if (vault.isExcluded(pathForFilter)) continue;
    // v3.10 (rc.10) — opt-in frontmatter filter. Runs ONLY when the caller
    // passed `filter_frontmatter` (else skipped — byte-identical default).
    // PDFs/canvas have no YAML frontmatter, so a frontmatter filter excludes
    // them without a binary-decoding read. Otherwise read the note (cached;
    // graph-boost has usually warmed it) and keep only if its frontmatter
    // satisfies the filter. The candidate pool is already excluded-pruned
    // (rc.8), so no excluded note's frontmatter is ever read here. Fail-soft:
    // an unreadable candidate can't be verified → excluded (honors the filter).
    if (fmFilter) {
      if (!pathForFilter.toLowerCase().endsWith(".md")) continue;
      let fm: Record<string, unknown> | undefined;
      try {
        const note = await vault.readNote(vault.resolveInside(pathForFilter));
        fm = note.parsed.frontmatter;
      } catch {
        continue;
      }
      if (!frontmatterMatches(fm, fmFilter)) continue;
    }
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
    const hit: SearchHybridHit = {
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
    };
    // S-5 — assemble the per-stage explanation from the accumulators. `final_rank`
    // is this hit's 0-based position in the returned matches (= current length).
    if (explain) {
      const ex: SearchHitExplain = {
        rrf: exRrf?.get(f.id) ?? { rank: -1, score: round5(f.score) },
        final_rank: matches.length
      };
      const g = exGraph?.get(f.id);
      if (g) ex.graph_boost = g;
      const r = exRerank?.get(f.id);
      if (r) ex.reranker = r;
      const rc = exRecency?.get(f.id);
      if (rc) ex.recency = rc;
      const fb = exFeedback?.get(f.id);
      if (fb) ex.feedback = fb;
      hit.explain = ex;
    }
    matches.push(hit);
    if (matches.length >= limit) break;
  }

  // v3.10 — forgetting-aware freshness enrichment. Attach age_days/stale to
  // each final hit by statting its CURRENT on-disk mtime (not the indexed
  // mtime in FTS5/embed-db source_state, which can lag a live edit). Bounded:
  // O(unique paths in matches) ≤ limit stats, run concurrently. Fail-soft —
  // any stat error (e.g. file deleted between fusion and now) just omits the
  // two fields for that hit; a staleness-enrichment failure must never break
  // search. Block granularity repeats a path across chunks, so dedupe first.
  try {
    const { stat } = await import("node:fs/promises");
    const now = Date.now();
    const uniquePaths = [...new Set(matches.map((m) => m.path))];
    const mtimeByPath = new Map<string, number>();
    await Promise.all(
      uniquePaths.map(async (p) => {
        try {
          const s = await stat(vault.resolveInside(p));
          mtimeByPath.set(p, s.mtimeMs);
        } catch {
          // file vanished or unreadable — leave it out of the map (fields omitted)
        }
      })
    );
    for (const m of matches) {
      const mtimeMs = mtimeByPath.get(m.path);
      if (typeof mtimeMs === "number") Object.assign(m, computeStaleness(mtimeMs, now));
    }
  } catch {
    // node:fs/promises import failed (should never happen) — skip enrichment.
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
  // v3.10.0-rc.13 (Issue 9) — surface the reranker outcome when one was
  // requested, so callers can distinguish "applied N pairs" from "silently fell
  // back to RRF" (and, on failure, why). `rerankerScores` is set iff the
  // cross-encoder ran successfully; otherwise carry the reason.
  if (ctx.reranker || ctx.rerankerOverride) {
    response.reranked = rerankerScores
      ? { applied: true, pairs: rerankedPairs }
      : {
          applied: false,
          reason: (signalErrors as { reranker?: string }).reranker ?? "no candidates to rerank"
        };
  }
  return response;
}

/** Max EXTRA phrasings a single `obsidian_search` call may fan out over (rc.7).
 *  The tool handler prepends the main `query`, so the worst case is
 *  MAX_FANOUT_QUERIES + 1 = 9 full hybrid pipeline runs per call. */
export const MAX_FANOUT_QUERIES = 8;

/** v3.11.6-rc.15 (audit H-1) — how many fan-out sub-queries run concurrently.
 *  Bounds the simultaneous full pipelines (graph-boost / optional reranker /
 *  embedding) so a legal 9-phrasing request can't start 9 heavy pipelines at
 *  once on the event loop. Combined with the {@link buildTfidfIndex} single-
 *  flight (which collapses the shared corpus build to ONE regardless), this
 *  makes the worst-case cold fan-out cost bounded + independent of vault size. */
export const MAX_FANOUT_CONCURRENCY = 4;

/** Run `fn` over `items` with at most `limit` in flight at once, preserving
 *  input order in the result. A bounded-pool replacement for `Promise.all` on
 *  the fan-out path (rc.15). */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    // `const i = next++` is atomic (no await between read + increment), so no
    // two workers claim the same index.
    for (let i = next++; i < items.length; i = next++) {
      results[i] = await fn(items[i] as T, i);
    }
  };
  const n = Math.min(Math.max(1, limit), items.length);
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

type SearchHybridArgs = Parameters<typeof searchHybrid>[1];
type SearchHybridCtx = Parameters<typeof searchHybrid>[2];

/**
 * v3.11.6-rc.7 (competitive-study C-4) — MULTI-QUERY FAN-OUT. Runs
 * {@link searchHybrid} once per phrasing and RRF-merges the result LISTS by
 * note path, so a note that ranks well for ANY phrasing floats to the top.
 * Useful when the note may use different vocabulary than the caller's first
 * phrasing (complements HyDE, which reshapes ONE query into an answer vector;
 * this fuses N independent phrasings). RRF fuses RANKS, not scores, so the
 * per-query reranker scores — explicitly "not comparable across queries" — are
 * combined safely by position.
 *
 * Each sub-query runs the full hybrid pipeline (BM25 + TF-IDF + embeddings +
 * optional rerank/recency/feedback); cost scales linearly with the phrasing
 * count, which is why the caller-facing schema caps it at {@link MAX_FANOUT_QUERIES}
 * (the tool handler prepends the main `query`, so the worst case is
 * MAX_FANOUT_QUERIES + 1 = 9 full pipeline runs).
 *
 * Granularity caveat (rc.12): the fan-out fuses BY NOTE PATH (`idOf: h.path`),
 * so `granularity: "block"` degrades to note-level in the fused result — one
 * hit per note, not per chunk (`chunk_index` reflects the best sub-hit and may
 * be absent). Use single-query mode when per-chunk hits matter.
 */
export async function searchHybridMulti(
  vault: Vault,
  args: SearchHybridArgs & { queries: string[] },
  ctx: SearchHybridCtx
): Promise<SearchHybridResponse> {
  const { reciprocalRankFusion, toRanked, RRF_K } = await import("../rrf.js");
  // S-5 — `explain` is a single-query diagnostic: each sub-query's per-stage
  // ranks refer to ITS own fusion, not this outer re-fusion, so a per-hit
  // explain here would be misleading. Drop it from the fan-out.
  const { queries, explain: _dropExplain, ...rest } = args;
  const limit = args.limit ?? 10;
  // Over-fetch per sub-query so the fused top-`limit` has a deep enough pool.
  const perQueryLimit = Math.min(100, Math.max(limit * 3, 30));

  // rc.15 (audit H-1) — bounded concurrency (was `Promise.all` = all 9 at once).
  // The shared TF-IDF corpus still builds ONCE via the buildTfidfIndex single-
  // flight; this additionally caps how many full pipelines run simultaneously.
  const perQuery = await mapWithConcurrency(queries, MAX_FANOUT_CONCURRENCY, (q) =>
    searchHybrid(vault, { ...rest, query: q, limit: perQueryLimit }, ctx)
  );

  // Keep, per path, the best-scoring hit object across sub-queries for display
  // metadata (snippet / per_signal / kind); RRF decides the final order.
  const bestHit = new Map<string, SearchHybridHit>();
  const signals: Record<string, ReturnType<typeof toRanked>> = {};
  perQuery.forEach((res, i) => {
    signals[`q${i}`] = toRanked(res.matches, { idOf: (h) => h.path, scoreOf: (h) => h.score });
    for (const h of res.matches) {
      const cur = bestHit.get(h.path);
      if (!cur || h.score > cur.score) bestHit.set(h.path, h);
    }
  });

  const fused = reciprocalRankFusion(signals, { topK: limit });
  const matches: SearchHybridHit[] = fused
    .map((f) => {
      const h = bestHit.get(f.id);
      // rc.12 — round to 5dp, parity with the single-query path (which rounds
      // at response build); pre-rc.12 the multi path emitted raw RRF floats.
      return h ? { ...h, score: Math.round(f.score * 100000) / 100000 } : null;
    })
    .filter((h): h is SearchHybridHit => h !== null);

  // Union the per-query signal usage + errors so the response stays honest.
  const signalsUsed = new Set<"bm25" | "tfidf" | "embeddings">();
  const signalErrors: NonNullable<SearchHybridResponse["signal_errors"]> = {};
  for (const res of perQuery) {
    for (const s of res.signals_used) signalsUsed.add(s);
    if (res.signal_errors) Object.assign(signalErrors, res.signal_errors);
  }

  // rc.12 (re-sweep) — carry the v3.10.0-rc.13 Issue-9 reranker observability
  // through the fan-out. Pre-rc.12 the multi response silently DROPPED the
  // `reranked` field even though every sub-query ran the reranker, so a
  // reranker-enabled `queries[]` caller couldn't distinguish "reranked" from
  // "silently fell back" — the exact gap rc.13 closed for the single path.
  // Union semantics: applied iff EVERY sub-query applied (pairs summed);
  // otherwise not-applied with the first sub-query's reason.
  const subReranked = perQuery.map((r) => r.reranked).filter((r): r is NonNullable<typeof r> => r !== undefined);
  let reranked: SearchHybridResponse["reranked"];
  if (subReranked.length > 0) {
    const failed = subReranked.find((r) => !r.applied);
    reranked = failed
      ? { applied: false, reason: failed.reason ?? "a sub-query fell back to RRF" }
      : { applied: true, pairs: subReranked.reduce((n, r) => n + (r.pairs ?? 0), 0) };
  }

  return {
    query: queries.join(" | "),
    method: "rrf",
    k: RRF_K,
    signals_used: [...signalsUsed],
    ...(Object.keys(signalErrors).length > 0 ? { signal_errors: signalErrors } : {}),
    ...(reranked !== undefined ? { reranked } : {}),
    total_candidates: bestHit.size,
    matches
  };
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
/**
 * Case-fold a string while recording, for every folded code unit, the index in
 * the ORIGINAL string it came from.
 *
 * `String.prototype.toLowerCase()` is NOT length-preserving (`İ` U+0130 → `i̇`,
 * 1 code unit → 2; final-sigma; the German ẞ; …). So an offset obtained from
 * `original.toLowerCase().indexOf(needle)` is an index into the FOLDED string and
 * drifts past the true position in `original` by the cumulative expansion of
 * every fold-expanding char before the match. Feeding that drifted offset to
 * {@link sliceSnippet} mis-centres the window and miscounts the line number.
 *
 * Iterates by code POINT so a surrogate pair maps to the code-unit index where
 * the pair begins (matching `sliceSnippet`'s code-unit slicing). `map.length ===
 * folded.length`; `map[k]` is the original code-unit index of folded unit `k`.
 *
 * v3.11.0-rc.21 — the read/snippet-path siblings of the rc.18 `replaceLineOnce`
 * fold-offset class (found by the post-rc.20 re-sweep in `semanticSearch` +
 * `searchText`, where a folded offset was sliced against the original body).
 */
export function foldWithMap(original: string): { folded: string; map: number[] } {
  let folded = "";
  const map: number[] = [];
  let i = 0;
  while (i < original.length) {
    const cp = original.codePointAt(i);
    if (cp === undefined) break;
    const ch = String.fromCodePoint(cp);
    const width = ch.length; // 1 or 2 UTF-16 code units
    const lo = ch.toLowerCase();
    for (let j = 0; j < lo.length; j++) {
      folded += lo[j];
      map.push(i);
    }
    i += width;
  }
  return { folded, map };
}

/**
 * Case-insensitive `indexOf` that returns the offset into the ORIGINAL string
 * (not the folded copy). `needleLower` must already be lower-cased. Returns -1
 * if not found. See {@link foldWithMap} for why the naive
 * `original.toLowerCase().indexOf(needle)` is wrong for length-changing folds.
 *
 * KNOWN COSMETIC LIMITATION (v3.11.1-rc.1, documented-accept) — `foldWithMap` folds the
 * haystack per CODE POINT (context-free), but `needleLower` here is the caller's
 * whole-string-`toLowerCase()` query token, which applies Greek word-final sigma
 * (`"ΟΔΟΣ"`→`"οδος"`, `ς`) while the body folds to `σ`. So a query token ending in a
 * capital Σ can return -1 and the snippet falls back to the note start instead of
 * centring on the hit. This is SNIPPET CENTRING ONLY — TF-IDF SCORING is unaffected
 * (query and document tokens are both whole-string-folded the same way upstream, so the
 * hit still ranks). The materially-harmful sibling (a SILENT under-replace in
 * `replace_in_notes`) was fixed in v3.11.1-rc.1 by folding the needle per code point
 * (`foldForMatch`, wildcard-match.ts); aligning the read path here would require re-folding the whole
 * TF-IDF token pipeline per code point (a scoring-path change) — disproportionate for a
 * snippet-window position, so the cosmetic residual is accepted and pinned by a contract test.
 */
export function foldedIndexOf(original: string, needleLower: string): number {
  if (needleLower === "") return 0;
  const { folded, map } = foldWithMap(original);
  const f = folded.indexOf(needleLower);
  return f < 0 ? -1 : (map[f] ?? -1);
}

export function sliceSnippet(text: string, idx: number, qLen: number): { snippet: string; line: number } {
  if (idx < 0) return { snippet: "", line: 0 };
  const before = Math.max(0, idx - 60);
  const after = Math.min(text.length, idx + qLen + 60);
  let snippet = text.slice(before, after).replace(/\s+/g, " ").trim();
  if (before > 0) snippet = `…${snippet}`;
  if (after < text.length) snippet = `${snippet}…`;
  const line = splitLines(text.slice(0, idx)).length;
  return { snippet, line };
}
