// Retrieval-quality evaluation harness for enquire-mcp.
//
// v2.12.0 — closes the "you can't tune what you can't measure" gap. Before
// this, anyone trying to A/B test retrieval changes (graph_boost on/off,
// reranker on/off, different limit / min_signals values) had to write a
// custom script. Now there's a first-class subcommand:
//
//   enquire-mcp eval --vault <path> --queries <file>
//      Reads JSONL queries with known-relevant doc paths, runs
//      `obsidian_search` for each, computes NDCG@10 + Recall@10 + MRR,
//      reports per-query + aggregate scores. Pretty table by default,
//      `--json` for machine-readable output, `--matrix` to A/B several
//      flag combinations side-by-side in one run.
//
// Standard IR metrics (Manning et al, "Introduction to Information
// Retrieval", Chapter 8):
//   • NDCG@K (Normalized Discounted Cumulative Gain) — penalizes
//     relevant docs found low in the ranking; 1.0 is perfect, 0.0 is
//     worst. Best for graded relevance + position-aware comparison.
//   • Recall@K — fraction of relevant docs found in top-K. Best for
//     "did we surface ANY relevant content?" measurement.
//   • MRR (Mean Reciprocal Rank) — 1/rank of the first relevant doc.
//     Best for "did we put SOMETHING relevant near the top?"
//
// We treat the user's `relevant` paths as binary-relevance ground truth
// (each listed path is gain=1, others are gain=0) since most users won't
// label graded relevance. The DCG formula simplifies to
// sum(rel_i / log2(i + 1)) where rel_i ∈ {0, 1}. NDCG normalizes by the
// ideal DCG = sum(1 / log2(i + 1)) for i in [1, |relevant|].
//
// "Only enquire-mcp has this": no other Obsidian-MCP ships a built-in
// retrieval evaluation harness. This makes Karpathy-style LLM Wiki users
// systematically tune their hybrid retrieval — measure first, then
// adjust graph_boost / reranker / min_signals based on real numbers
// over their real corpus.

import { promises as fs } from "node:fs";
import type { FtsIndex } from "./fts5.js";
import { type SearchHybridHit, searchHybrid } from "./tools/index.js";
import type { Vault } from "./vault.js";

/** A single evaluation query — relevant doc paths are the ground truth. */
export interface EvalQuery {
  /** Query text fed to obsidian_search. */
  query: string;
  /**
   * Vault-relative paths considered relevant. Order doesn't matter — we
   * only need the set membership. Paths are matched against
   * `SearchHybridHit.path` exactly.
   */
  relevant: string[];
  /** Optional human-readable id for logging / reports. */
  id?: string;
}

/** Per-query scores. */
export interface EvalQueryScore {
  id: string;
  query: string;
  /** Normalized Discounted Cumulative Gain @ K. */
  ndcg_at_k: number;
  /** Recall @ K — fraction of relevant docs in top-K. */
  recall_at_k: number;
  /** Mean Reciprocal Rank — 1/rank of first relevant; 0 if none in top-K. */
  mrr: number;
  /** Number of relevant docs found anywhere in the top-K. */
  hits_relevant: number;
  /** Total relevant docs in the ground truth. */
  hits_total_relevant: number;
  /** Latency for this query in milliseconds. */
  latency_ms: number;
  /**
   * v3.9.0-rc.16 — true if `searchHybrid` threw for this query (transient
   * infra failure, embedder OOM, etc.). The query's scores are all 0 and it
   * still counts toward the means — an errored query is NOT silently dropped,
   * but it IS distinguishable from a genuine zero-relevance retrieval. Absent
   * (undefined) on successful queries.
   */
  error?: boolean;
  /**
   * v3.10.0-rc.31 — retrieval-failure classification for this query (see
   * {@link classifyFailureBucket}). Lets a maintainer see *why* a query scored
   * low (ranked-but-not-rank-1 vs missed entirely) without reading every hit.
   */
  failure_bucket: FailureBucket;
}

/** Aggregate evaluation result. */
export interface EvalResult {
  /** Configuration label — useful for the matrix mode. */
  label: string;
  k: number;
  query_count: number;
  /**
   * v3.9.0-rc.16 — number of queries that threw during retrieval (counted in
   * `query_count` and in the means as zeros). > 0 means the means are deflated
   * by infra failures, not retrieval quality — re-run before publishing.
   */
  query_errors: number;
  /** Per-query scores. */
  per_query: EvalQueryScore[];
  /** Mean NDCG@K across all queries. */
  mean_ndcg: number;
  /** Mean Recall@K across all queries. */
  mean_recall: number;
  /** Mean Reciprocal Rank across all queries. */
  mean_mrr: number;
  /** Mean latency in milliseconds. */
  mean_latency_ms: number;
  /** Total run wall time. */
  total_wall_ms: number;
  /**
   * v3.10.0-rc.31 — aggregate retrieval-failure-bucket counts across all
   * queries (see {@link classifyFailureBucket}). Optional so externally
   * hand-built `EvalResult`s (e.g. `scripts/run-benchmarks.mjs`) stay valid;
   * `runEval` always populates it.
   */
  diagnostics?: { failure_buckets: Record<FailureBucket, number> };
}

/**
 * NDCG@K with binary relevance.
 *
 * DCG@K = sum_{i=1..K} rel_i / log2(i + 1)
 * IdealDCG@K = sum_{i=1..min(K, |relevant|)} 1 / log2(i + 1)
 * NDCG@K = DCG@K / IdealDCG@K
 *
 * Returns 0 when `relevant` is empty (no ground truth → undefined ratio).
 */
export function ndcgAtK(retrievedPaths: string[], relevant: ReadonlySet<string>, k: number): number {
  if (relevant.size === 0) return 0;
  let dcg = 0;
  // v3.10.0-rc.33 (post-rc.31 audit) — credit each relevant path ONCE, at its
  // first rank: a duplicate in the result list must not inflate DCG past the
  // ideal (same pre-existing, eval-unreachable class as recallAtK's dedupe).
  const credited = new Set<string>();
  for (let i = 0; i < Math.min(k, retrievedPaths.length); i++) {
    const path = retrievedPaths[i];
    if (path && relevant.has(path) && !credited.has(path)) {
      credited.add(path);
      dcg += 1 / Math.log2(i + 2); // i+2 because i is 0-indexed; rank = i+1, log2(rank+1)
    }
  }
  let idealDcg = 0;
  for (let i = 0; i < Math.min(k, relevant.size); i++) {
    idealDcg += 1 / Math.log2(i + 2);
  }
  return idealDcg > 0 ? dcg / idealDcg : 0;
}

/** Recall @ K = |retrieved ∩ relevant| / |relevant|. */
export function recallAtK(retrievedPaths: string[], relevant: ReadonlySet<string>, k: number): number {
  if (relevant.size === 0) return 0;
  // v3.10.0-rc.33 (post-rc.31 audit) — count DISTINCT relevant paths in top-K.
  // A relevant path duplicated in the result list must not inflate recall past
  // 1.0. (Unreachable via the eval path at the default `note` granularity —
  // `searchHybrid` yields one hit per note path — but the pure function is now
  // correct for any caller.)
  const found = new Set<string>();
  for (let i = 0; i < Math.min(k, retrievedPaths.length); i++) {
    const p = retrievedPaths[i];
    if (p && relevant.has(p)) found.add(p);
  }
  return found.size / relevant.size;
}

/** Mean Reciprocal Rank — 1/rank of first relevant; 0 if none in top-K. */
export function reciprocalRank(retrievedPaths: string[], relevant: ReadonlySet<string>, k: number): number {
  for (let i = 0; i < Math.min(k, retrievedPaths.length); i++) {
    const path = retrievedPaths[i];
    if (path && relevant.has(path)) return 1 / (i + 1);
  }
  return 0;
}

/**
 * Per-query retrieval-failure classification — a seeklink-inspired diagnostic
 * that turns a bare "the score is low" into "*why* it's low", so a maintainer
 * tuning retrieval knows where to look.
 *
 * The buckets are derived ONLY from the scored top-K result set (the data the
 * eval already has), so adding them is a zero-behavior-change, zero-extra-cost
 * diagnostic — the metric numbers are untouched.
 *
 *  - `error`       — `searchHybrid` threw for this query (infra, not relevance).
 *  - `no_labels`   — the query has no ground-truth `relevant` paths to score.
 *  - `hit_rank_1`  — a relevant doc is at rank 1 (ideal).
 *  - `hit_top_k`   — a relevant doc is in the top-K but not at rank 1 (ranking
 *                    could be tighter — a reranker-ordering signal).
 *  - `miss`        — no relevant doc in the top-K.
 *
 * NOTE (deferred): seeklink further splits `miss` into "candidate-generation
 * miss" (never retrieved) vs "ranking-budget / reranker-ordering miss"
 * (retrieved but ranked below K). That split needs a retrieval WIDER than K to
 * see where the expected doc landed — and widening the eval search would change
 * the reranker's candidate budget and thus the scored numbers, breaking
 * historical comparability. It is therefore deliberately NOT done here; a
 * future first-stage-diagnostics plumbing change (returning pre-rerank
 * candidates from `searchHybrid`) would enable it without that side effect.
 */
export type FailureBucket = "error" | "no_labels" | "hit_rank_1" | "hit_top_k" | "miss";

/** The five buckets, in display order — also the keys of the aggregate counter. */
export const FAILURE_BUCKETS: readonly FailureBucket[] = ["hit_rank_1", "hit_top_k", "miss", "no_labels", "error"];

/** Classify a single query's outcome from its scored top-K paths. Pure. */
export function classifyFailureBucket(
  retrievedPaths: readonly string[],
  relevant: ReadonlySet<string>,
  k: number,
  errored = false
): FailureBucket {
  if (errored) return "error";
  if (relevant.size === 0) return "no_labels";
  const top = retrievedPaths.slice(0, Math.max(0, k));
  if (top.length > 0) {
    const first = top[0];
    if (first !== undefined && relevant.has(first)) return "hit_rank_1";
  }
  for (let i = 1; i < top.length; i++) {
    const p = top[i];
    if (p !== undefined && relevant.has(p)) return "hit_top_k";
  }
  return "miss";
}

/** Tally a list of per-query buckets into a complete counter (all keys present). */
export function tallyFailureBuckets(buckets: readonly FailureBucket[]): Record<FailureBucket, number> {
  const counts = { hit_rank_1: 0, hit_top_k: 0, miss: 0, no_labels: 0, error: 0 } satisfies Record<
    FailureBucket,
    number
  >;
  for (const b of buckets) counts[b] += 1;
  return counts;
}

/**
 * Read a JSONL file of EvalQuery objects. Tolerates blank lines and
 * comments (lines starting with `//`). Throws on invalid JSON or
 * missing required fields.
 */
export async function readQueriesJsonl(file: string): Promise<EvalQuery[]> {
  const raw = await fs.readFile(file, "utf8");
  const queries: EvalQuery[] = [];
  let lineNum = 0;
  for (const line of raw.split("\n")) {
    lineNum += 1;
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("//")) continue;
    try {
      const parsed = JSON.parse(trimmed) as Partial<EvalQuery>;
      if (typeof parsed.query !== "string" || parsed.query.length === 0) {
        throw new Error(`line ${lineNum}: missing or empty 'query' field`);
      }
      if (!Array.isArray(parsed.relevant) || parsed.relevant.some((p) => typeof p !== "string")) {
        throw new Error(`line ${lineNum}: 'relevant' must be an array of vault-relative path strings`);
      }
      queries.push({
        query: parsed.query,
        relevant: parsed.relevant,
        ...(parsed.id ? { id: parsed.id } : {})
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`enquire eval: failed to parse queries file at line ${lineNum} — ${msg}`);
    }
  }
  return queries;
}

export interface RunEvalOptions {
  vault: Vault;
  queries: readonly EvalQuery[];
  ftsIndex: FtsIndex | null;
  embedFile: string;
  k?: number;
  /** Label for the result — useful when running multiple configurations. */
  label?: string;
  /** Pass-through to searchHybrid (e.g. graph_boost, min_signals). */
  searchOpts?: {
    graph_boost?: boolean;
    min_signals?: number;
    embedding_model?: string;
  };
  /** Optional reranker config — pass-through to searchHybrid. */
  reranker?: { alias?: string; topN?: number };
  /** Test-only DI for mocking the reranker. */
  rerankerOverride?: { score(query: string, passages: readonly string[]): Promise<number[]> };
}

/**
 * Run obsidian_search across a set of evaluation queries and compute
 * NDCG@K, Recall@K, MRR. Returns a fully-populated EvalResult.
 *
 * `embedFile` may be a non-existent path — embeddings simply won't
 * contribute (graceful degradation matches `searchHybrid` behavior).
 */
export async function runEval(opts: RunEvalOptions): Promise<EvalResult> {
  const k = opts.k ?? 10;
  const totalT0 = Date.now();
  const perQuery: EvalQueryScore[] = [];
  let queryErrors = 0;

  for (let i = 0; i < opts.queries.length; i++) {
    const q = opts.queries[i];
    if (!q) continue;
    const id = q.id ?? `q${i + 1}`;
    const relevantSet = new Set(q.relevant);
    const t0 = Date.now();
    let hits: SearchHybridHit[] = [];
    let errored = false;
    try {
      const result = await searchHybrid(
        opts.vault,
        {
          query: q.query,
          limit: k,
          ...(opts.searchOpts?.graph_boost !== undefined ? { graph_boost: opts.searchOpts.graph_boost } : {}),
          ...(opts.searchOpts?.min_signals !== undefined ? { min_signals: opts.searchOpts.min_signals } : {}),
          ...(opts.searchOpts?.embedding_model ? { embedding_model: opts.searchOpts.embedding_model } : {})
        },
        {
          ftsIndex: opts.ftsIndex,
          embedFile: opts.embedFile,
          ...(opts.reranker ? { reranker: opts.reranker } : {}),
          ...(opts.rerankerOverride ? { rerankerOverride: opts.rerankerOverride } : {})
        }
      );
      hits = result.matches;
    } catch (err) {
      // Per-query isolation — one bad query doesn't sink the whole eval.
      // The query's scores will all be 0 and we keep going, but we flag it
      // (errored) + count it (queryErrors) so the deflation is visible.
      errored = true;
      queryErrors += 1;
      process.stderr.write(
        `enquire eval: query "${q.query.slice(0, 60)}" failed — ${err instanceof Error ? err.message : String(err)}\n`
      );
    }
    const latency = Date.now() - t0;
    const retrievedPaths = hits.map((h) => h.path);
    const ndcg = ndcgAtK(retrievedPaths, relevantSet, k);
    const recall = recallAtK(retrievedPaths, relevantSet, k);
    const mrr = reciprocalRank(retrievedPaths, relevantSet, k);
    // v3.10.0-rc.40 (#13) — count DISTINCT relevant paths (mirrors the rc.33 dedup in
    // recallAtK/ndcgAtK) so a duplicate path can't push hits_relevant past
    // hits_total_relevant in the `N/M` display. Unreachable at the default note
    // granularity (paths are unique), but pins the contract for block-granularity callers.
    const hitsRelevantSet = new Set<string>();
    for (const p of retrievedPaths.slice(0, k)) {
      if (relevantSet.has(p)) hitsRelevantSet.add(p);
    }
    const hitsRelevant = hitsRelevantSet.size;
    perQuery.push({
      id,
      query: q.query,
      ndcg_at_k: round(ndcg),
      recall_at_k: round(recall),
      mrr: round(mrr),
      hits_relevant: hitsRelevant,
      hits_total_relevant: relevantSet.size,
      latency_ms: latency,
      failure_bucket: classifyFailureBucket(retrievedPaths, relevantSet, k, errored),
      ...(errored ? { error: true } : {})
    });
  }

  const meanNdcg = mean(perQuery.map((p) => p.ndcg_at_k));
  const meanRecall = mean(perQuery.map((p) => p.recall_at_k));
  const meanMrr = mean(perQuery.map((p) => p.mrr));
  const meanLatency = mean(perQuery.map((p) => p.latency_ms));

  return {
    label: opts.label ?? "default",
    k,
    query_count: perQuery.length,
    query_errors: queryErrors,
    per_query: perQuery,
    mean_ndcg: round(meanNdcg),
    mean_recall: round(meanRecall),
    mean_mrr: round(meanMrr),
    mean_latency_ms: Math.round(meanLatency),
    total_wall_ms: Date.now() - totalT0,
    diagnostics: { failure_buckets: tallyFailureBuckets(perQuery.map((p) => p.failure_bucket)) }
  };
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function round(x: number): number {
  return Math.round(x * 10000) / 10000;
}

/**
 * Render an EvalResult as a pretty CLI table. ANSI-colored when stdout
 * is a TTY, plain text otherwise (so `enquire eval | tee report.txt`
 * stays readable).
 */
export function formatEvalResult(result: EvalResult, opts: { perQuery?: boolean } = {}): string {
  const isTty = process.stdout.isTTY === true;
  const bold = (s: string) => (isTty ? `\x1b[1m${s}\x1b[0m` : s);
  const dim = (s: string) => (isTty ? `\x1b[2m${s}\x1b[0m` : s);
  const lines: string[] = [];
  lines.push(bold(`enquire eval — ${result.label}`));
  lines.push(`  ${result.query_count} queries · k=${result.k} · wall=${result.total_wall_ms}ms`);
  if (result.query_errors > 0) {
    lines.push(
      `  ⚠ ${result.query_errors} query(s) errored (scored 0) — the means below are deflated by infra failures, not retrieval quality; re-run before publishing`
    );
  }
  lines.push("");
  if (opts.perQuery) {
    lines.push(bold("per query:"));
    // v3.10.0-rc.33 (audit) — dynamic id-column width so ids longer than 15
    // chars don't shift every following column (mirrors formatEvalMatrix's
    // labelWidth). Empty per_query → Math.max(15) = 15.
    const idWidth = Math.max(15, ...result.per_query.map((p) => p.id.length));
    lines.push(`  ${"id".padEnd(idWidth)} ndcg@k  recall@k  mrr     hits   latency   bucket`);
    for (const p of result.per_query) {
      lines.push(
        `  ${p.id.padEnd(idWidth)} ${p.ndcg_at_k.toFixed(4)}  ${p.recall_at_k.toFixed(4)}    ${p.mrr.toFixed(4)}  ${`${p.hits_relevant}/${p.hits_total_relevant}`.padEnd(6)} ${`${p.latency_ms}ms`.padEnd(8)} ${p.failure_bucket ?? "?"}`
      );
    }
    lines.push("");
  }
  lines.push(bold("aggregate:"));
  lines.push(`  mean NDCG@${result.k}   = ${result.mean_ndcg.toFixed(4)}`);
  lines.push(`  mean Recall@${result.k} = ${result.mean_recall.toFixed(4)}`);
  lines.push(`  mean MRR        = ${result.mean_mrr.toFixed(4)}`);
  lines.push(`  mean latency    = ${result.mean_latency_ms}ms ${dim("(per query)")}`);
  if (result.diagnostics) {
    const fb = result.diagnostics.failure_buckets;
    lines.push("");
    lines.push(bold("failure buckets:"));
    lines.push(
      `  ${dim("hit@1")}=${fb.hit_rank_1}  ${dim("hit@k")}=${fb.hit_top_k}  ${dim("miss")}=${fb.miss}  ${dim("no-labels")}=${fb.no_labels}  ${dim("error")}=${fb.error}`
    );
  }
  return lines.join("\n");
}

/**
 * Render multiple EvalResults side-by-side as a comparison matrix. Used
 * by `enquire eval --matrix` to A/B several configurations in one run.
 */
export function formatEvalMatrix(results: readonly EvalResult[]): string {
  if (results.length === 0) return "(no results)";
  const isTty = process.stdout.isTTY === true;
  const bold = (s: string) => (isTty ? `\x1b[1m${s}\x1b[0m` : s);
  const lines: string[] = [];
  lines.push(bold(`enquire eval matrix (${results.length} configs)`));
  lines.push("");
  // Column header.
  const labelWidth = Math.max(...results.map((r) => r.label.length), 8) + 2;
  const header = `${"label".padEnd(labelWidth)}NDCG@${results[0]?.k ?? 10}  Recall@${results[0]?.k ?? 10}  MRR     latency`;
  lines.push(bold(header));
  // Rows.
  for (const r of results) {
    lines.push(
      `${r.label.padEnd(labelWidth)}${r.mean_ndcg.toFixed(4)}   ${r.mean_recall.toFixed(4)}     ${r.mean_mrr.toFixed(4)}  ${r.mean_latency_ms}ms`
    );
  }
  // Best-config callout.
  let best = results[0];
  if (best) {
    for (const r of results) {
      if (r.mean_ndcg > best.mean_ndcg) best = r;
    }
    lines.push("");
    lines.push(`best NDCG@${best.k}: ${bold(best.label)} (${best.mean_ndcg.toFixed(4)})`);
  }
  return lines.join("\n");
}
