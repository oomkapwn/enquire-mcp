// v3.10.0-rc.62 (CLI-SERVEHTTP-RECENCY-FAILLATE) — leaf module for parsing/validating the
// advanced-retrieval CLI flags (recency re-ranking + reranker top-N). Extracted out of
// `server.ts` so both the serve boot paths (stdio `prepareServerDeps` + the `serve-http` boot
// in `cli.ts`) AND unit tests can import these pure helpers without value-importing from the
// registration-boilerplate modules (the `no-internal-imports` Class-A invariant forbids tests
// from value-importing `src/{cli,server,tool-registry,prompts}.ts`).

import { DEFAULT_STALE_DAYS } from "./staleness.js";
import { parsePositiveInt } from "./tool-registry.js";

/**
 * v3.10.0-rc.5 — parse the opt-in recency re-ranking config from CLI opts. Returns `null` when
 * `--recency-weight` is unset or 0 (recency re-ranking OFF; ranking stays relevance-pure). Throws
 * on an out-of-range weight or a non-positive `--stale-days` so the error surfaces with the
 * offending flag name. `--stale-days` is validated even when the weight is 0 (a typo'd value should
 * fail regardless), but only tunes the half-life when the weight is > 0.
 *
 * @param opts - `{ recencyWeight?, staleDays? }` raw CLI string values.
 * @returns `{ weight, staleDays }` when re-ranking is on, else `null`.
 */
export function parseRecencyConfig(opts: {
  recencyWeight?: string;
  staleDays?: string;
}): { weight: number; staleDays: number } | null {
  const recencyWeight = opts.recencyWeight !== undefined ? Number(opts.recencyWeight) : 0;
  if (!Number.isFinite(recencyWeight) || recencyWeight < 0 || recencyWeight > 1) {
    throw new Error(`--recency-weight must be a number in [0, 1]; got "${opts.recencyWeight}"`);
  }
  const recencyStaleDays =
    opts.staleDays !== undefined ? parsePositiveInt(opts.staleDays, "--stale-days") : DEFAULT_STALE_DAYS;
  return recencyWeight > 0 ? { weight: recencyWeight, staleDays: recencyStaleDays } : null;
}

/**
 * v3.11.0 — parse the opt-in closed-loop-feedback config from CLI opts. Returns
 * `null` when `--feedback-weight` is unset or 0 (the feedback feature is OFF — no
 * `obsidian_mark_useful` tool registered, no rank boost; ranking stays
 * relevance-pure, a provable no-op). A weight > 0 turns the whole closed loop on
 * (mirrors `parseRecencyConfig`'s single-flag gate). Throws on an out-of-range
 * weight so the error surfaces with the offending flag name.
 *
 * @param opts - `{ feedbackWeight? }` raw CLI string value.
 * @returns `{ weight }` when feedback is on, else `null`.
 */
export function parseFeedbackConfig(opts: { feedbackWeight?: string }): { weight: number } | null {
  const w = opts.feedbackWeight !== undefined ? Number(opts.feedbackWeight) : 0;
  if (!Number.isFinite(w) || w < 0 || w > 1) {
    throw new Error(`--feedback-weight must be a number in [0, 1]; got "${opts.feedbackWeight}"`);
  }
  return w > 0 ? { weight: w } : null;
}

/**
 * v3.10.0-rc.62 (CLI-SERVEHTTP-RECENCY-FAILLATE) — fail-FAST validation of the advanced retrieval
 * flags for the `serve-http` boot path. `startHttpServer` builds `prepareServerDeps` lazily (per
 * session, on the first request), so a typo'd `--recency-weight 5` / `--stale-days x` /
 * `--reranker-top-n 0` previously started the server cleanly and only threw on the first search.
 * Calling this at boot mirrors stdio `serve`'s eager validation. Throws (with the offending flag
 * name) on any invalid value; returns void on success.
 *
 * @param opts - `{ recencyWeight?, staleDays?, enableReranker?, rerankerTopN? }` raw CLI values.
 */
export function validateServeHttpRetrievalOpts(opts: {
  recencyWeight?: string;
  staleDays?: string;
  enableReranker?: boolean;
  rerankerTopN?: string;
  feedbackWeight?: string;
}): void {
  parseRecencyConfig(opts); // throws on bad --recency-weight / --stale-days
  parseFeedbackConfig(opts); // throws on bad --feedback-weight
  if (opts.enableReranker && opts.rerankerTopN !== undefined) {
    parsePositiveInt(opts.rerankerTopN, "--reranker-top-n"); // throws on non-positive-int
  }
}
