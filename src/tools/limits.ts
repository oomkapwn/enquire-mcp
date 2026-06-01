// v3.9.0-rc.36 — shared resource-bound cap for always-registered tools that
// build a vault-sized in-memory GRAPH / PAIRWISE structure.
//
// Defense-in-depth (DoS): an always-registered MCP tool reachable over a
// bearer-auth `serve-http` client must not let vault size drive unbounded
// in-memory graph growth + per-note `readNote` I/O. `find_path` (MAX_VISITED,
// rc.34 R-5) and `communities` (MAX_GRAPH_NODES, rc.35 AS#5) capped their graph
// builds one at a time — each fix found by an EXTERNAL auditor, one RC apart,
// because nothing forced a sweep of the sibling graph-builders. This shared cap
// + the `tests/resource-bound-invariant.test.ts` manifest close the class: the
// CAP-vs-EXEMPT decision is now explicit and structurally enforced for every
// whole-vault scanner (graph/pairwise → CAP here; inherent single-pass O(N)
// like searchText / listTags / getBacklinks → EXEMPT, since capping those would
// silently corrupt exhaustive enumeration or aggregation results).
//
// 50_000 is far above any real Obsidian vault, so in practice this is graceful
// degradation (a slightly less-complete top-K ranking on an absurd vault),
// never a functional limit — the capped tools already return a bounded top-K,
// so trimming the scan only drops the long tail of candidates.

/** Max notes a single graph/neighborhood tool ingests in one whole-vault scan. */
export const MAX_SCAN_NOTES = 50_000;

const warnedTools = new Set<string>();

/**
 * Truncate a whole-vault entry list to {@link MAX_SCAN_NOTES}, warning once per
 * tool per process on the (vanishingly rare) overflow. Returns the input
 * unchanged when under the cap; pure aside from the one-shot stderr warning.
 *
 * @typeParam T - entry element type (e.g. `FileEntry`).
 * @param entries - the full `vault.listMarkdown()` result.
 * @param tool - MCP tool name, for the operator warning.
 * @returns `entries` unchanged, or its first `MAX_SCAN_NOTES` elements.
 */
export function capScanEntries<T>(entries: T[], tool: string): T[] {
  if (entries.length <= MAX_SCAN_NOTES) return entries;
  if (!warnedTools.has(tool)) {
    warnedTools.add(tool);
    process.stderr.write(
      `enquire: ${tool} scanned the first ${MAX_SCAN_NOTES} of ${entries.length} notes ` +
        "(MAX_SCAN_NOTES defense-in-depth cap; results may be partial on a vault this large).\n"
    );
  }
  return entries.slice(0, MAX_SCAN_NOTES);
}
