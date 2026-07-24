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
// This built-in command lets Karpathy-style LLM Wiki users tune their
// own retrieval — measure first, then adjust graph_boost / reranker /
// min_signals over their real corpus. Peer projects may ship separate
// benchmark suites (OHS does); that is distinct from this user-facing
// per-vault CLI workflow and avoids an unbounded uniqueness claim.

import { createHash } from "node:crypto";
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
  /**
   * v3.11.6-rc.5 — optional grouping key (e.g. `keyword` / `conceptual` /
   * `temporal-reasoning` / `knowledge-update`). When present, `runEval` reports
   * the same metrics per category in `EvalResult.by_category`, so a maintainer
   * can see WHICH class of query is weak (the highest-value diagnostic slice).
   */
  category?: string;
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
   * v3.11.6-rc.5 (eval overhaul) — additive diagnostics (all optional so
   * hand-built `EvalQueryScore`s stay valid; `runEval` always populates them).
   */
  /** Grouping key echoed from the query (for `by_category`). */
  category?: string;
  /** A relevant doc is at rank 1. */
  hit_at_1?: boolean;
  /** At least one relevant doc is in the top-K (binary). */
  hit_at_k?: boolean;
  /** EVERY relevant doc is in the top-K — the stricter multi-evidence signal (AllRel). */
  all_relevant_at_k?: boolean;
  /** Relevant paths NOT retrieved in top-K — the first files to inspect on a low recall. */
  missed_paths?: string[];
  /** The top-K retrieved paths in rank order — what outranked the missed docs. */
  top_paths?: string[];
  /**
   * True if `searchHybrid` threw or reported any degraded retrieval signal for
   * this query (transient infra failure, embedder/reranker load failure, etc.).
   * The query's scores are all 0 and it still counts toward the means — an
   * errored query is NOT silently dropped or mislabeled as a requested
   * configuration, but it IS distinguishable from a genuine retrieval miss.
   * Absent (undefined) on fully successful queries.
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
   * Number of queries that threw or reported a degraded retrieval signal
   * (counted in `query_count` and in the means as zeros). > 0 means the means
   * are deflated by infra failures, not retrieval quality — re-run before
   * publishing.
   */
  query_errors: number;
  /**
   * SHA-256 of the canonical query cohort (id/query/category + sorted unique
   * ground-truth paths). `runEval` always emits it; A/B comparison requires an
   * exact match so different query sets cannot produce a misleading delta.
   */
  query_set_fingerprint?: string;
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
   * v3.11.6-rc.5 (eval overhaul) — additive aggregate diagnostics (optional so
   * hand-built results stay valid; `runEval` always populates them).
   */
  /** Fraction of queries with a relevant doc at rank 1 (Hit@1). */
  mean_hit_at_1?: number;
  /** Fraction of queries with any relevant doc in top-K (Hit@K). */
  mean_hit_at_k?: number;
  /** Fraction of queries where EVERY relevant doc is in top-K (AllRel@K). */
  all_rel_at_k?: number;
  /** Same metrics grouped by `EvalQuery.category` — the weak-slice diagnostic. */
  by_category?: Record<string, CategoryScore>;
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
 * Hit@K — is ANY relevant doc in the top-K? Binary. `atRank` (default 1) lets
 * you ask Hit@1 vs Hit@3 vs Hit@5 by capping the window. `false` when there is
 * no ground truth (empty `relevant`). Pure. (v3.11.6-rc.5 eval overhaul.)
 */
export function hitAtK(retrievedPaths: string[], relevant: ReadonlySet<string>, k: number): boolean {
  if (relevant.size === 0) return false;
  for (let i = 0; i < Math.min(k, retrievedPaths.length); i++) {
    const p = retrievedPaths[i];
    if (p && relevant.has(p)) return true;
  }
  return false;
}

/**
 * AllRel@K — is EVERY relevant doc present in the top-K? The stricter
 * multi-evidence signal (a query needing 3 evidence notes only counts if all 3
 * are retrieved). `false` when there is no ground truth. Pure. (rc.5.)
 */
export function allRelevantAtK(retrievedPaths: string[], relevant: ReadonlySet<string>, k: number): boolean {
  if (relevant.size === 0) return false;
  const found = new Set<string>();
  for (let i = 0; i < Math.min(k, retrievedPaths.length); i++) {
    const p = retrievedPaths[i];
    if (p && relevant.has(p)) found.add(p);
  }
  return found.size === relevant.size;
}

/** The relevant paths NOT found in top-K — the first files to inspect on a low recall. Pure. (rc.5.) */
export function missedPaths(retrievedPaths: string[], relevant: ReadonlySet<string>, k: number): string[] {
  const top = new Set(retrievedPaths.slice(0, Math.max(0, k)));
  const missed: string[] = [];
  for (const r of relevant) if (!top.has(r)) missed.push(r);
  return missed;
}

/** Per-category aggregate metrics (a slice of the whole-run aggregate). */
export interface CategoryScore {
  query_count: number;
  mean_ndcg: number;
  mean_recall: number;
  mean_mrr: number;
  mean_hit_at_1: number;
  mean_hit_at_k: number;
  all_rel_at_k: number;
}

/**
 * Group scored per-query rows by their `category` and compute the same means
 * per group. Rows with no category are grouped under `uncategorized`. Pure —
 * derived entirely from the already-scored `per_query`, so it never re-runs a
 * search. (v3.11.6-rc.5 — the highest-value OHS-inspired diagnostic.)
 */
export function groupByCategory(perQuery: readonly EvalQueryScore[]): Record<string, CategoryScore> {
  const groups = new Map<string, EvalQueryScore[]>();
  for (const p of perQuery) {
    const key = p.category ?? "uncategorized";
    const arr = groups.get(key);
    if (arr) arr.push(p);
    else groups.set(key, [p]);
  }
  // A category is user-authored input. A null-prototype result keeps special
  // keys such as "__proto__" as ordinary own properties instead of mutating
  // or disappearing into Object.prototype.
  const out = Object.create(null) as Record<string, CategoryScore>;
  for (const [cat, rows] of groups) {
    out[cat] = {
      query_count: rows.length,
      mean_ndcg: round(mean(rows.map((r) => r.ndcg_at_k))),
      mean_recall: round(mean(rows.map((r) => r.recall_at_k))),
      mean_mrr: round(mean(rows.map((r) => r.mrr))),
      mean_hit_at_1: round(mean(rows.map((r) => (r.hit_at_1 ? 1 : 0)))),
      mean_hit_at_k: round(mean(rows.map((r) => (r.hit_at_k ? 1 : 0)))),
      all_rel_at_k: round(mean(rows.map((r) => (r.all_relevant_at_k ? 1 : 0))))
    };
  }
  return out;
}

/** One metric's before/after delta in an A/B comparison. */
export interface MetricDelta {
  metric: string;
  baseline: number;
  after: number;
  delta: number;
  /** True iff `|delta| >= MEANINGFUL_DELTA`, a material-effect heuristic (not a significance test). */
  meaningful: boolean;
}

/** Material-effect threshold used for CI gating; it does not estimate statistical significance. */
export const MEANINGFUL_DELTA = 0.01;

export interface EvalComparison {
  baseline_label: string;
  after_label: string;
  deltas: MetricDelta[];
}

/**
 * Compare two EvalResults (baseline vs after) into a delta table. Compares the
 * whole-run aggregate metrics after proving that k and the canonical query
 * cohort match. A `|delta| >= MEANINGFUL_DELTA` is flagged as materially large
 * by a fixed heuristic; it is not a statistical-significance claim.
 */
export function compareEvalResults(baseline: EvalResult, after: EvalResult): EvalComparison {
  validateComparisonResult(baseline, "baseline");
  validateComparisonResult(after, "after");
  if (baseline.query_errors > 0 || after.query_errors > 0) {
    throw new Error(
      `Cannot compare eval results with retrieval errors (baseline=${baseline.query_errors}, after=${after.query_errors}); re-run before publishing`
    );
  }
  if (baseline.k !== after.k) {
    throw new Error(`Cannot compare eval results with different k (baseline=${baseline.k}, after=${after.k})`);
  }
  if (baseline.query_count !== after.query_count) {
    throw new Error(
      `Cannot compare eval results with different query counts (baseline=${baseline.query_count}, after=${after.query_count})`
    );
  }
  if (baseline.query_set_fingerprint !== after.query_set_fingerprint) {
    throw new Error(
      `Cannot compare different query cohorts (baseline=${baseline.query_set_fingerprint}, after=${after.query_set_fingerprint})`
    );
  }
  const rows: Array<[string, number, number]> = [
    ["nDCG@k", baseline.mean_ndcg, after.mean_ndcg],
    ["Recall@k", baseline.mean_recall, after.mean_recall],
    ["MRR", baseline.mean_mrr, after.mean_mrr],
    ["Hit@1", baseline.mean_hit_at_1 as number, after.mean_hit_at_1 as number],
    ["Hit@k", baseline.mean_hit_at_k as number, after.mean_hit_at_k as number],
    ["AllRel@k", baseline.all_rel_at_k as number, after.all_rel_at_k as number]
  ];
  const deltas: MetricDelta[] = rows.map(([metric, b, a]) => {
    const delta = round(a - b);
    return { metric, baseline: round(b), after: round(a), delta, meaningful: Math.abs(delta) >= MEANINGFUL_DELTA };
  });
  return { baseline_label: baseline.label, after_label: after.label, deltas };
}

/** Render an EvalComparison as a delta table (used by `scripts/eval-compare.mjs`). */
export function formatEvalComparison(cmp: EvalComparison): string {
  const isTty = process.stdout.isTTY === true;
  const bold = (s: string) => (isTty ? `\x1b[1m${s}\x1b[0m` : s);
  const lines: string[] = [];
  lines.push(bold(`eval compare — ${cmp.baseline_label} → ${cmp.after_label}`));
  lines.push(`  ${"metric".padEnd(10)} ${"baseline".padEnd(9)} ${"after".padEnd(9)} ${"delta".padEnd(9)}`);
  for (const d of cmp.deltas) {
    const sign = d.delta > 0 ? "+" : "";
    const mark = d.meaningful ? (d.delta > 0 ? " ✓" : " ✗ regression") : "";
    lines.push(
      `  ${d.metric.padEnd(10)} ${d.baseline.toFixed(4).padEnd(9)} ${d.after.toFixed(4).padEnd(9)} ${`${sign}${d.delta.toFixed(4)}`.padEnd(9)}${mark}`
    );
  }
  lines.push("");
  lines.push(`  (|Δ| ≥ ${MEANINGFUL_DELTA} is a material-effect heuristic, not statistical significance)`);
  return lines.join("\n");
}

function validateComparisonResult(result: EvalResult, label: "after" | "baseline"): void {
  const malformed = (message: string): never => {
    throw new Error(`Cannot compare malformed ${label} eval result: ${message}`);
  };
  const requireUnitInterval = (value: unknown, field: string): number => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      return malformed(`${field} must be a finite number between 0 and 1`);
    }
    return value;
  };
  const requireNonNegativeFinite = (value: unknown, field: string): number => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      return malformed(`${field} must be a finite non-negative number`);
    }
    return value;
  };

  if (typeof result.label !== "string" || result.label.length === 0) {
    malformed("label must be a non-empty string");
  }
  if (!Number.isInteger(result.k) || result.k <= 0) {
    malformed("k must be a positive integer");
  }
  if (!Number.isInteger(result.query_count) || result.query_count <= 0) {
    malformed("query_count must be a positive integer");
  }
  if (!Number.isInteger(result.query_errors) || result.query_errors < 0 || result.query_errors > result.query_count) {
    malformed("query_errors is invalid");
  }
  if (!Array.isArray(result.per_query) || result.per_query.length !== result.query_count) {
    malformed("per_query length must equal query_count");
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(result.query_set_fingerprint ?? "")) {
    malformed("query_set_fingerprint is missing or invalid; re-run with the current version");
  }

  const seenIds = new Set<string>();
  const validBuckets = new Set<string>(FAILURE_BUCKETS);
  let errorRows = 0;
  const rows: EvalQueryScore[] = [];
  for (let index = 0; index < result.per_query.length; index++) {
    const rawRow: unknown = result.per_query[index];
    if (typeof rawRow !== "object" || rawRow === null || Array.isArray(rawRow)) {
      malformed(`per_query[${index}] must be an object`);
    }
    const row = rawRow as Partial<EvalQueryScore>;
    if (typeof row.id !== "string" || row.id.trim().length === 0) {
      malformed(`per_query[${index}].id must be a non-empty string`);
    }
    const rowId = row.id as string;
    if (seenIds.has(rowId)) malformed(`per_query contains duplicate id ${JSON.stringify(rowId)}`);
    seenIds.add(rowId);
    if (typeof row.query !== "string" || row.query.trim().length === 0) {
      malformed(`per_query[${index}].query must be a non-empty string`);
    }
    const rowQuery = row.query as string;

    const ndcg = requireUnitInterval(row.ndcg_at_k, `per_query[${index}].ndcg_at_k`);
    const recall = requireUnitInterval(row.recall_at_k, `per_query[${index}].recall_at_k`);
    const mrr = requireUnitInterval(row.mrr, `per_query[${index}].mrr`);
    const latency = requireNonNegativeFinite(row.latency_ms, `per_query[${index}].latency_ms`);
    if (!Number.isInteger(row.hits_relevant) || (row.hits_relevant ?? -1) < 0) {
      malformed(`per_query[${index}].hits_relevant must be a non-negative integer`);
    }
    if (!Number.isInteger(row.hits_total_relevant) || (row.hits_total_relevant ?? -1) < 0) {
      malformed(`per_query[${index}].hits_total_relevant must be a non-negative integer`);
    }
    const hitsRelevant = row.hits_relevant as number;
    const hitsTotal = row.hits_total_relevant as number;
    if (hitsRelevant > hitsTotal) {
      malformed(`per_query[${index}].hits_relevant cannot exceed hits_total_relevant`);
    }
    if (typeof row.hit_at_1 !== "boolean" || typeof row.hit_at_k !== "boolean") {
      malformed(`per_query[${index}] must contain boolean hit_at_1 and hit_at_k diagnostics`);
    }
    if (typeof row.all_relevant_at_k !== "boolean") {
      malformed(`per_query[${index}].all_relevant_at_k must be boolean`);
    }
    if (row.error !== undefined && typeof row.error !== "boolean") {
      malformed(`per_query[${index}].error must be boolean when present`);
    }
    if (typeof row.failure_bucket !== "string" || !validBuckets.has(row.failure_bucket)) {
      malformed(`per_query[${index}].failure_bucket is invalid`);
    }

    const errored = row.error === true;
    if (errored !== (row.failure_bucket === "error")) {
      malformed(`per_query[${index}] error flag and failure_bucket disagree`);
    }
    if (errored) errorRows += 1;
    if (row.hit_at_1 && !row.hit_at_k) {
      malformed(`per_query[${index}] hit_at_1 cannot be true when hit_at_k is false`);
    }
    if (row.hit_at_k !== hitsRelevant > 0) {
      malformed(`per_query[${index}] hit_at_k disagrees with hits_relevant`);
    }
    if (row.all_relevant_at_k !== (hitsTotal > 0 && hitsRelevant === hitsTotal)) {
      malformed(`per_query[${index}] all_relevant_at_k disagrees with hit counts`);
    }
    const expectedBucket: FailureBucket = errored
      ? "error"
      : hitsTotal === 0
        ? "no_labels"
        : row.hit_at_1
          ? "hit_rank_1"
          : row.hit_at_k
            ? "hit_top_k"
            : "miss";
    if (row.failure_bucket !== expectedBucket) {
      malformed(`per_query[${index}].failure_bucket must be ${expectedBucket}`);
    }
    if (errored && (ndcg !== 0 || recall !== 0 || mrr !== 0 || hitsRelevant !== 0)) {
      malformed(`per_query[${index}] errored rows must have zero scores and zero relevant hits`);
    }

    rows.push({
      ...row,
      id: rowId,
      query: rowQuery,
      ndcg_at_k: ndcg,
      recall_at_k: recall,
      mrr,
      hits_relevant: hitsRelevant,
      hits_total_relevant: hitsTotal,
      latency_ms: latency,
      hit_at_1: row.hit_at_1,
      hit_at_k: row.hit_at_k,
      all_relevant_at_k: row.all_relevant_at_k,
      failure_bucket: row.failure_bucket as FailureBucket
    });
  }
  if (errorRows !== result.query_errors) {
    malformed(`query_errors=${result.query_errors} but per_query contains ${errorRows} error row(s)`);
  }

  const aggregateFields = [
    "mean_ndcg",
    "mean_recall",
    "mean_mrr",
    "mean_hit_at_1",
    "mean_hit_at_k",
    "all_rel_at_k"
  ] as const;
  for (const metric of aggregateFields) {
    requireUnitInterval(result[metric], metric);
  }
  const expectedAggregates: Array<[(typeof aggregateFields)[number], number]> = [
    ["mean_ndcg", round(mean(rows.map((row) => row.ndcg_at_k)))],
    ["mean_recall", round(mean(rows.map((row) => row.recall_at_k)))],
    ["mean_mrr", round(mean(rows.map((row) => row.mrr)))],
    ["mean_hit_at_1", round(mean(rows.map((row) => (row.hit_at_1 ? 1 : 0))))],
    ["mean_hit_at_k", round(mean(rows.map((row) => (row.hit_at_k ? 1 : 0))))],
    ["all_rel_at_k", round(mean(rows.map((row) => (row.all_relevant_at_k ? 1 : 0))))]
  ];
  for (const [field, expected] of expectedAggregates) {
    if (result[field] !== expected) {
      malformed(`${field}=${result[field]} does not match per_query mean ${expected}`);
    }
  }

  const meanLatency = requireNonNegativeFinite(result.mean_latency_ms, "mean_latency_ms");
  requireNonNegativeFinite(result.total_wall_ms, "total_wall_ms");
  const expectedMeanLatency = Math.round(mean(rows.map((row) => row.latency_ms)));
  if (meanLatency !== expectedMeanLatency) {
    malformed(`mean_latency_ms=${meanLatency} does not match per_query mean ${expectedMeanLatency}`);
  }

  if (result.diagnostics !== undefined) {
    const rawDiagnostics: unknown = result.diagnostics;
    if (typeof rawDiagnostics !== "object" || rawDiagnostics === null || Array.isArray(rawDiagnostics)) {
      malformed("diagnostics must be an object when present");
    }
    const rawBuckets = (rawDiagnostics as { failure_buckets?: unknown }).failure_buckets;
    if (typeof rawBuckets !== "object" || rawBuckets === null || Array.isArray(rawBuckets)) {
      malformed("diagnostics.failure_buckets must be an object");
    }
    const actualBuckets = tallyFailureBuckets(rows.map((row) => row.failure_bucket));
    for (const bucket of FAILURE_BUCKETS) {
      const count = (rawBuckets as Record<string, unknown>)[bucket];
      if (!Number.isInteger(count) || (count as number) < 0) {
        malformed(`diagnostics.failure_buckets.${bucket} must be a non-negative integer`);
      }
      if (count !== actualBuckets[bucket]) {
        malformed(
          `diagnostics.failure_buckets.${bucket}=${String(count)} does not match per_query count ${actualBuckets[bucket]}`
        );
      }
    }
    const unknownBuckets = Object.keys(rawBuckets as Record<string, unknown>).filter(
      (bucket) => !validBuckets.has(bucket)
    );
    if (unknownBuckets.length > 0) {
      malformed(`diagnostics.failure_buckets contains unknown key ${JSON.stringify(unknownBuckets[0])}`);
    }
  }
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
 *  - `error`       — `searchHybrid` threw or reported a degraded retrieval
 *                    signal for this query (infra, not relevance).
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
  const seenIds = new Set<string>();
  let lineNum = 0;
  for (const line of raw.split("\n")) {
    lineNum += 1;
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("//")) continue;
    try {
      const parsed = JSON.parse(trimmed) as Partial<EvalQuery>;
      if (typeof parsed.query !== "string" || parsed.query.trim().length === 0) {
        throw new Error(`line ${lineNum}: missing or empty 'query' field`);
      }
      if (
        !Array.isArray(parsed.relevant) ||
        parsed.relevant.some((p) => typeof p !== "string" || p.trim().length === 0)
      ) {
        throw new Error(`line ${lineNum}: 'relevant' must be an array of non-empty vault-relative path strings`);
      }
      if (parsed.id !== undefined && (typeof parsed.id !== "string" || parsed.id.trim().length === 0)) {
        throw new Error(`line ${lineNum}: optional 'id' must be a non-empty string`);
      }
      if (
        parsed.category !== undefined &&
        (typeof parsed.category !== "string" || parsed.category.trim().length === 0)
      ) {
        throw new Error(`line ${lineNum}: optional 'category' must be a non-empty string`);
      }
      if (parsed.id !== undefined) {
        if (seenIds.has(parsed.id)) throw new Error(`line ${lineNum}: duplicate query id '${parsed.id}'`);
        seenIds.add(parsed.id);
      }
      queries.push({
        query: parsed.query,
        relevant: parsed.relevant,
        ...(parsed.id !== undefined ? { id: parsed.id } : {}),
        ...(parsed.category !== undefined ? { category: parsed.category } : {})
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`enquire eval: failed to parse queries file at line ${lineNum} — ${msg}`);
    }
  }
  validateEvalQueryCohort(queries);
  return queries;
}

/**
 * Compute an order-independent identity for an evaluation cohort.
 *
 * @param queries - Queries and their complete ground-truth labels.
 * @returns `sha256:<hex>` over canonical id/query/category/relevant tuples.
 */
export function evalQuerySetFingerprint(queries: readonly EvalQuery[]): string {
  const rows = queries
    .map((query) =>
      JSON.stringify({
        id: query.id ?? null,
        query: query.query,
        category: query.category ?? null,
        relevant: [...new Set(query.relevant)].sort()
      })
    )
    .sort();
  return `sha256:${createHash("sha256").update(JSON.stringify(rows)).digest("hex")}`;
}

function validateEvalQueryCohort(queries: readonly EvalQuery[]): void {
  if (queries.length === 0) {
    throw new Error("enquire eval: query cohort must contain at least one query");
  }
  const seenIds = new Set<string>();
  for (let index = 0; index < queries.length; index++) {
    const query = queries[index];
    if (!query || query.query.trim().length === 0) {
      throw new Error(`enquire eval: query ${index + 1} must contain non-whitespace text`);
    }
    if (query.relevant.some((entry) => entry.trim().length === 0)) {
      throw new Error(`enquire eval: query ${index + 1} has an empty relevant path`);
    }
    if (query.id !== undefined && query.id.trim().length === 0) {
      throw new Error(`enquire eval: query ${index + 1} has an empty id`);
    }
    const effectiveId = query.id ?? `q${index + 1}`;
    if (seenIds.has(effectiveId)) throw new Error(`enquire eval: duplicate effective query id '${effectiveId}'`);
    seenIds.add(effectiveId);
    if (query.category !== undefined && query.category.trim().length === 0) {
      throw new Error(`enquire eval: query ${index + 1} has an empty category`);
    }
  }
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
  if (!Number.isInteger(k) || k <= 0) throw new Error("enquire eval: k must be a positive integer");
  validateEvalQueryCohort(opts.queries);
  const querySetFingerprint = evalQuerySetFingerprint(opts.queries);
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
      const failedSignals = Object.keys(result.signal_errors ?? {});
      if (failedSignals.length > 0) {
        throw new Error(`retrieval signal failure(s): ${failedSignals.join(", ")}`);
      }
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
      // v3.11.6-rc.5 (eval overhaul) — additive diagnostics.
      ...(q.category ? { category: q.category } : {}),
      hit_at_1: hitAtK(retrievedPaths, relevantSet, 1),
      hit_at_k: hitAtK(retrievedPaths, relevantSet, k),
      all_relevant_at_k: allRelevantAtK(retrievedPaths, relevantSet, k),
      missed_paths: missedPaths(retrievedPaths, relevantSet, k),
      top_paths: retrievedPaths.slice(0, k),
      ...(errored ? { error: true } : {})
    });
  }

  const meanNdcg = mean(perQuery.map((p) => p.ndcg_at_k));
  const meanRecall = mean(perQuery.map((p) => p.recall_at_k));
  const meanMrr = mean(perQuery.map((p) => p.mrr));
  const meanLatency = mean(perQuery.map((p) => p.latency_ms));
  const meanHit1 = mean(perQuery.map((p) => (p.hit_at_1 ? 1 : 0)));
  const meanHitK = mean(perQuery.map((p) => (p.hit_at_k ? 1 : 0)));
  const allRelK = mean(perQuery.map((p) => (p.all_relevant_at_k ? 1 : 0)));

  return {
    label: opts.label ?? "default",
    k,
    query_count: perQuery.length,
    query_errors: queryErrors,
    query_set_fingerprint: querySetFingerprint,
    per_query: perQuery,
    mean_ndcg: round(meanNdcg),
    mean_recall: round(meanRecall),
    mean_mrr: round(meanMrr),
    mean_latency_ms: Math.round(meanLatency),
    total_wall_ms: Date.now() - totalT0,
    mean_hit_at_1: round(meanHit1),
    mean_hit_at_k: round(meanHitK),
    all_rel_at_k: round(allRelK),
    by_category: groupByCategory(perQuery),
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
  if (result.mean_hit_at_1 !== undefined) {
    lines.push(
      `  Hit@1 / Hit@${result.k}   = ${result.mean_hit_at_1.toFixed(4)} / ${(result.mean_hit_at_k ?? 0).toFixed(4)}  ${dim(`AllRel@${result.k}=${(result.all_rel_at_k ?? 0).toFixed(4)}`)}`
    );
  }
  lines.push(`  mean latency    = ${result.mean_latency_ms}ms ${dim("(per query)")}`);
  // v3.11.6-rc.5 — by-category weak-slice table (the OHS-inspired diagnostic).
  if (result.by_category) {
    const cats = Object.entries(result.by_category).filter(
      ([c]) => c !== "uncategorized" || Object.keys(result.by_category ?? {}).length === 1
    );
    if (cats.length > 1 || (cats.length === 1 && cats[0]?.[0] !== "uncategorized")) {
      lines.push("");
      lines.push(bold("by category (weakest nDCG first):"));
      const catWidth = Math.max(8, ...cats.map(([c]) => c.length));
      lines.push(`  ${"category".padEnd(catWidth)} n     nDCG    recall  mrr     AllRel@k`);
      for (const [cat, cs] of cats.sort((a, b) => a[1].mean_ndcg - b[1].mean_ndcg)) {
        lines.push(
          `  ${cat.padEnd(catWidth)} ${String(cs.query_count).padEnd(5)} ${cs.mean_ndcg.toFixed(4)}  ${cs.mean_recall.toFixed(4)}  ${cs.mean_mrr.toFixed(4)}  ${cs.all_rel_at_k.toFixed(4)}`
        );
      }
    }
  }
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
  const header = `${"label".padEnd(labelWidth)}NDCG@${results[0]?.k ?? 10}  Recall@${results[0]?.k ?? 10}  MRR     latency  errors`;
  lines.push(bold(header));
  // Rows.
  for (const r of results) {
    const errorStatus = r.query_errors > 0 ? `${r.query_errors} INVALID` : "0";
    lines.push(
      `${r.label.padEnd(labelWidth)}${r.mean_ndcg.toFixed(4)}   ${r.mean_recall.toFixed(4)}     ${r.mean_mrr.toFixed(4)}  ${`${r.mean_latency_ms}ms`.padEnd(9)}${errorStatus}`
    );
  }
  // Best-config callout. A degraded configuration is not a valid benchmark
  // candidate even when its remaining successful queries yield the highest mean.
  const validResults = results.filter((result) => result.query_errors === 0);
  let best = validResults[0];
  if (best) {
    for (const r of validResults) {
      if (r.mean_ndcg > best.mean_ndcg) best = r;
    }
    lines.push("");
    lines.push(`best NDCG@${best.k}: ${bold(best.label)} (${best.mean_ndcg.toFixed(4)})`);
  } else {
    lines.push("");
    lines.push("best NDCG: none — all configurations are INVALID; re-run after fixing retrieval errors");
  }
  return lines.join("\n");
}
