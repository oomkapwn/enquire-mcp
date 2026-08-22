import type { FeedbackStore } from "./feedback.js";
import type { Vault } from "./vault.js";

/** Arguments admitted by the feedback tool handler after schema validation. */
export interface MarkUsefulInput {
  /** Vault-relative note identities returned by search. */
  paths: string[];
  /** Whether the recalled notes helped; defaults to true. */
  useful?: boolean;
}

/** Result returned after a feedback batch commits. */
export interface MarkUsefulResult {
  /** Number of canonical paths recorded by this call. */
  recorded: number;
  /** Effective usefulness polarity. */
  useful: boolean;
  /** Number of notes that now have durable feedback. */
  total_notes_with_feedback: number;
  /** Human-readable reminder of when feedback affects ranking. */
  note: string;
}

/**
 * Canonicalize an entire feedback batch before committing any tally mutation.
 *
 * @param store - Root-bound durable feedback tally.
 * @param vault - Live path/privacy authority.
 * @param args - Schema-admitted feedback request.
 * @returns The committed feedback summary.
 */
export async function markUseful(store: FeedbackStore, vault: Vault, args: MarkUsefulInput): Promise<MarkUsefulResult> {
  const useful = args.useful !== false;
  const canonicalPaths = await vault.canonicalFeedbackPaths(args.paths);
  const recorded = await store.record(canonicalPaths, useful, new Date().toISOString());
  return {
    recorded,
    useful,
    total_notes_with_feedback: store.size(),
    note: "Feedback boosts future obsidian_search ranking for this vault when --feedback-weight > 0."
  };
}
