// v3.10.0 — forgetting-aware staleness (the "memory ages" capability).
//
// The Memora benchmark (arXiv:2604.20006, Apr 2026) showed every memory system
// fails at STALE-fact reuse — they recall an old fact as if it were current.
// enquire's structural advantage: every recalled note is a real markdown file
// with an `mtime`, so we can cheaply tell an agent HOW OLD a recalled fact is —
// turning "grounded, auditable recall" into "grounded, auditable, AND
// freshness-aware recall." This is metadata the agent can reason over ("this
// note is 2 years old — verify before relying on it"). The v3.10 line builds
// this up incrementally: rc.1 surfaced the signal additively on the embedding
// search tools (no ranking change); rc.2 added the `obsidian_stale_notes`
// surface; rc.4 extended the signal to the hybrid `obsidian_search`; rc.5 adds
// OPT-IN recency re-ranking (`recencyScore` below + the `--recency-weight` /
// `--stale-days` flags, default OFF so the ranking stays relevance-primary).

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

/**
 * v3.10 (rc.5) — a smooth recency score in `(0, 1]` for opt-in recency
 * re-ranking. Monotonically decreasing in `ageDays`: a brand-new note scores
 * `1`, a note exactly `staleDays` old scores `0.5`, and the score asymptotes
 * toward `0` (never reaching it) as a note ages further. This gentle hyperbolic
 * decay — rather than a hard cliff at the stale threshold — keeps the re-rank a
 * nudge, not a guillotine: a highly-relevant year-old note still competes.
 *
 * Used by `searchHybrid` ONLY when `--recency-weight > 0`; the blend is
 * `(1 - weight) * relevanceRankScore + weight * recencyScore`, so `weight = 0`
 * leaves the relevance order exactly intact (provable no-op — the default).
 *
 * Pure + deterministic. `staleDays` is clamped to ≥ 1 to avoid divide-by-zero
 * and to keep the curve well-defined; a non-finite / negative `ageDays` clamps
 * to `0` (treated as brand-new), mirroring {@link computeStaleness}'s
 * never-negative-age rule.
 *
 * @param ageDays - whole days since the note's mtime (as from {@link computeStaleness}).
 * @param staleDays - the half-life: the age at which recency score = 0.5. Defaults to {@link DEFAULT_STALE_DAYS}.
 * @returns a value in `(0, 1]`; `1` at age 0, `0.5` at age `staleDays`, → `0` as age → ∞.
 * @example
 * ```ts
 * recencyScore(0, 365);   // 1
 * recencyScore(365, 365); // 0.5
 * recencyScore(1095, 365); // 0.25
 * ```
 */
export function recencyScore(ageDays: number, staleDays: number = DEFAULT_STALE_DAYS): number {
  const age = Number.isFinite(ageDays) && ageDays > 0 ? ageDays : 0;
  const halfLife = Number.isFinite(staleDays) && staleDays >= 1 ? staleDays : 1;
  return halfLife / (halfLife + age);
}
