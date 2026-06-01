// v3.10.0 — forgetting-aware staleness (the "memory ages" capability).
//
// The Memora benchmark (arXiv:2604.20006, Apr 2026) showed every memory system
// fails at STALE-fact reuse — they recall an old fact as if it were current.
// enquire's structural advantage: every recalled note is a real markdown file
// with an `mtime`, so we can cheaply tell an agent HOW OLD a recalled fact is —
// turning "grounded, auditable recall" into "grounded, auditable, AND
// freshness-aware recall." This is metadata the agent can reason over ("this
// note is 2 years old — verify before relying on it"); rc.1 surfaces the signal
// additively (no ranking change). Recency re-ranking + an `obsidian_stale_notes`
// surface + a configurable `--stale-days` flag are the v3.10 follow-ups.

/** Default age (days) past which a recalled note is flagged `stale`. One year
 *  is a deliberately conservative default — old enough that a fact is worth
 *  re-verifying, not so aggressive that a stable reference note trips it. */
export const DEFAULT_STALE_DAYS = 365;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Staleness verdict for a single recalled note. */
export interface Staleness {
  /** Whole days between the note's mtime and `now` (floored, never negative). */
  age_days: number;
  /** `true` when `age_days >= staleDays` — the note is old enough to re-verify. */
  stale: boolean;
}

/**
 * Compute a note's freshness from its mtime. Pure + deterministic given `now`
 * (injected, not read from the clock here) so it's unit-testable and so all
 * hits in one search response share a single `now` reference.
 *
 * A future-dated mtime (clock skew, fabricated frontmatter) clamps to
 * `age_days: 0` rather than going negative — a note can't be "negatively old".
 *
 * @param mtimeMs - the note's modification time, epoch milliseconds.
 * @param now - reference time, epoch milliseconds (pass `Date.now()` at the call site).
 * @param staleDays - threshold; defaults to {@link DEFAULT_STALE_DAYS}.
 * @returns `{ age_days, stale }`.
 * @example
 * ```ts
 * computeStaleness(Date.now() - 400 * 86_400_000, Date.now()); // { age_days: 400, stale: true }
 * ```
 */
export function computeStaleness(mtimeMs: number, now: number, staleDays: number = DEFAULT_STALE_DAYS): Staleness {
  const age_days = Math.max(0, Math.floor((now - mtimeMs) / MS_PER_DAY));
  return { age_days, stale: age_days >= staleDays };
}
