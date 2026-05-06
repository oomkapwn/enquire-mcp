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

/** Default RRF smoothing constant. Per Cormack et al (2009). */
export const RRF_K = 60;

/** A single ranker's hit. `rank` is 1-based — caller is responsible for
 *  numbering. `score` is the original ranker's score (carried through for
 *  observability; not used by RRF math). */
export interface RankedHit {
  /** Stable identifier — same string across rankers means same document.
   *  For enquire we use the vault-relative note path (`Auth/oauth.md`). */
  id: string;
  /** 1-based rank position in the ranker's output. */
  rank: number;
  /** Original ranker's score — passed through for diagnostics. */
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

/** Reciprocal Rank Fusion over named signals. Documents missing from a
 *  signal contribute 0 from that signal — fusion is union-safe.
 *
 *  Empty / undefined signals are silently ignored. If ALL signals are
 *  empty, returns an empty array. */
export function reciprocalRankFusion<S extends string>(
  signals: Partial<Record<S, ReadonlyArray<RankedHit>>>,
  opts: { k?: number; topK?: number } = {}
): FusedHit<S>[] {
  const k = opts.k ?? RRF_K;
  if (k <= 0) throw new Error(`RRF k must be positive, got ${k}`);
  const fused = new Map<string, FusedHit<S>>();

  for (const [signalName, hits] of Object.entries(signals) as [S, ReadonlyArray<RankedHit> | undefined][]) {
    if (!hits) continue;
    // v2.0.0-beta.1 P2 fix: guard duplicate (id, signal) pairs. A buggy
    // ranker might emit the same id twice (e.g. chunk-collapse missed a
    // dedup); pre-fix we silently double-added the same signal's
    // contribution, distorting the fused score. Now we keep only the BEST
    // (lowest) rank per id within a single signal — matches what callers
    // upstream of us already do with bestPerNote chunk-collapse.
    const seenInSignal = new Set<string>();
    for (const hit of hits) {
      if (hit.rank < 1) {
        throw new Error(`RRF expects 1-based ranks, got rank=${hit.rank} for id=${hit.id}`);
      }
      if (seenInSignal.has(hit.id)) continue;
      seenInSignal.add(hit.id);
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

/** Convert an arbitrary scored list into 1-based-ranked input for RRF.
 *  Caller passes already-sorted hits (highest score first); we tag them. */
export function toRanked<T>(
  hits: ReadonlyArray<T>,
  options: { idOf: (hit: T) => string; scoreOf: (hit: T) => number }
): RankedHit[] {
  return hits.map((hit, i) => ({
    id: options.idOf(hit),
    rank: i + 1,
    score: options.scoreOf(hit)
  }));
}
