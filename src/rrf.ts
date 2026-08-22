// Reciprocal Rank Fusion (v2.0 beta). Combines independent ranked lists into
// a single ranking using only rank positions — robust to scale differences
// between rankers (BM25 → unbounded; TF-IDF → [0, 1]; cosine → [-1, 1]).
//
// Reference: Cormack, Clarke, Buettcher (2009) "Reciprocal Rank Fusion
// outperforms Condorcet and individual Rank Learning Methods", SIGIR.
//
//   RRF_score(d) = Σ over rankers r:  1 / (k + rank_r(d))
//
// `k = 60` is the constant Cormack et al recommend; smoothes contribution
// from any single ranker putting a doc at rank 1. Documents missing from a
// ranker contribute 0 from that ranker (NOT a penalty — fusion is union-
// safe). Each ranker contributes equally; v2.0 ships hardcoded weights per
// the architecture decision (see CHANGELOG v2.0.0-alpha.0).

import { Buffer } from "node:buffer";

const MAX_RRF_ID_BYTES = 4096;

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive safe integer, got ${String(value)}`);
  }
}

function assertRrfId(id: string): void {
  if (typeof id !== "string") {
    throw new TypeError("RRF hit id must be a string");
  }
  const byteLength = Buffer.byteLength(id, "utf8");
  if (byteLength < 1 || byteLength > MAX_RRF_ID_BYTES) {
    throw new RangeError(`RRF hit id must contain 1..${MAX_RRF_ID_BYTES} UTF-8 bytes`);
  }
}

function assertFiniteScore(score: number): void {
  if (!Number.isFinite(score)) {
    throw new TypeError(`RRF hit score must be finite, got ${String(score)}`);
  }
}

/** Default RRF smoothing constant. Per Cormack et al (2009). */
export const RRF_K = 60;

/** A single ranker's hit.
 *
 * `rank` is a positive safe integer and is 1-based. `score` is finite and is
 * carried through for observability, but is not used by RRF math.
 */
export interface RankedHit {
  /** Stable non-empty identifier of at most 4,096 UTF-8 bytes. The same string
   * across rankers means the same document. Enquire uses the vault-relative
   * note path (`Auth/oauth.md`). */
  id: string;
  /** Positive-safe-integer, 1-based rank position in the ranker's output. */
  rank: number;
  /** Finite original ranker score, passed through for diagnostics. */
  score: number;
}

/** Per-signal contribution to a fused doc's RRF score. */
export interface SignalContribution {
  /** 1-based rank in the corresponding ranker's output. */
  rank: number;
  /** Original score from the ranker (for debugging / UI). */
  score: number;
  /** Contribution to the RRF total: 1 / (k + rank). */
  rrf_term: number;
}

/** A fused result. `score` is the summed RRF total; `per_signal` records
 *  which rankers contributed and their original ranks. */
export interface FusedHit<S extends string = string> {
  id: string;
  score: number;
  per_signal: Partial<Record<S, SignalContribution>>;
}

/** Reciprocal Rank Fusion over named signals.
 *
 * Documents missing from a signal contribute 0 from that signal, so fusion is
 * union-safe. Empty or undefined signals are silently ignored. Duplicate IDs
 * within one signal contribute once using their lowest rank; equal-rank
 * duplicates retain the highest original score. If all signals are empty,
 * returns an empty array.
 *
 * @param signals Named ranked-result lists to fuse.
 * @param opts Positive-safe-integer smoothing constant and optional result
 *   limit.
 * @returns Fused hits ordered by descending RRF score.
 * @throws {RangeError} If `k`, `topK`, a rank, or an ID is outside its
 *   documented domain.
 * @throws {TypeError} If an ID is not a string or a score is not finite.
 */
export function reciprocalRankFusion<S extends string>(
  signals: Partial<Record<S, ReadonlyArray<RankedHit>>>,
  opts: { k?: number; topK?: number } = {}
): FusedHit<S>[] {
  const k = opts.k ?? RRF_K;
  assertPositiveSafeInteger(k, "RRF k");
  if (opts.topK !== undefined) {
    assertPositiveSafeInteger(opts.topK, "RRF topK");
  }
  const fused = new Map<string, FusedHit<S>>();

  for (const [signalName, hits] of Object.entries(signals) as [S, ReadonlyArray<RankedHit> | undefined][]) {
    if (!hits) continue;
    // v2.0.0-beta.1 P2 fix: guard duplicate (id, signal) pairs. A buggy
    // ranker might emit the same id twice (e.g. chunk-collapse missed a
    // dedup); pre-fix we silently double-added the same signal's
    // contribution, distorting the fused score. Now we keep only the BEST
    // (lowest) rank per id within a single signal — matches what callers
    // upstream of us already do with bestPerNote chunk-collapse.
    const bestInSignal = new Map<string, RankedHit>();
    for (const hit of hits) {
      assertRrfId(hit.id);
      assertPositiveSafeInteger(hit.rank, "RRF rank");
      assertFiniteScore(hit.score);

      const current = bestInSignal.get(hit.id);
      if (
        current === undefined ||
        hit.rank < current.rank ||
        (hit.rank === current.rank && hit.score > current.score)
      ) {
        bestInSignal.set(hit.id, hit);
      }
    }

    for (const hit of bestInSignal.values()) {
      const term = 1 / (k + hit.rank);
      const existing = fused.get(hit.id);
      if (existing) {
        existing.score += term;
        existing.per_signal[signalName] = { rank: hit.rank, score: hit.score, rrf_term: term };
      } else {
        const per: Partial<Record<S, SignalContribution>> = {};
        per[signalName] = { rank: hit.rank, score: hit.score, rrf_term: term };
        fused.set(hit.id, { id: hit.id, score: term, per_signal: per });
      }
    }
  }

  const sorted = Array.from(fused.values()).sort((a, b) => b.score - a.score);
  if (opts.topK !== undefined) return sorted.slice(0, opts.topK);
  return sorted;
}

/** Convert an arbitrary scored list into admitted 1-based RRF input.
 *
 * The caller supplies hits already sorted by descending score. IDs must be
 * non-empty strings of at most 4,096 UTF-8 bytes and scores must be finite.
 *
 * @param hits Already-sorted source hits.
 * @param options Extractors for the stable ID and original score.
 * @returns Validated `RankedHit` entries with 1-based ranks.
 * @throws {RangeError} If an extracted ID is empty or exceeds the byte limit.
 * @throws {TypeError} If an extracted ID is not a string or score is not
 *   finite.
 */
export function toRanked<T>(
  hits: ReadonlyArray<T>,
  options: { idOf: (hit: T) => string; scoreOf: (hit: T) => number }
): RankedHit[] {
  return hits.map((hit, i) => {
    const id = options.idOf(hit);
    const score = options.scoreOf(hit);
    assertRrfId(id);
    assertFiniteScore(score);
    return { id, rank: i + 1, score };
  });
}
