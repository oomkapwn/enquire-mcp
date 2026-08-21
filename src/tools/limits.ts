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
// whole-vault scanner. Exact scanners fail closed when the bounded discovery
// receipt is incomplete; top-K graph tools no longer hide an arbitrary prefix.
//
import type { FileEntry, Vault } from "../vault.js";

/** Max notes a single graph/neighborhood tool ingests in one whole-vault scan. */
export const MAX_SCAN_NOTES = 50_000;

/** Max directory entries inspected while discovering one exact tool corpus. */
export const MAX_SCAN_VISITED_ENTRIES = 200_000;

/**
 * Discover an exact markdown corpus within the shared tool envelope.
 *
 * Admission happens inside the filesystem walker. An overflow, unreadable
 * subtree, race, or depth refusal is never represented as an exact prefix.
 *
 * @param vault - Vault whose public markdown namespace is scanned.
 * @param folder - Optional public vault-relative subtree.
 * @param tool - Stable tool label used in the refusal message.
 * @returns Complete, path-sorted file inventory.
 * @throws {Error} If the bounded walker cannot prove the inventory complete.
 */
export async function listExactScanEntries(
  vault: Vault,
  folder: string | undefined,
  tool: string
): Promise<FileEntry[]> {
  const listing = await vault.listFilesByExtensionsBounded([".md"], MAX_SCAN_NOTES, MAX_SCAN_VISITED_ENTRIES, folder);
  if (!listing.complete) {
    throw new Error(
      `${tool}: exact results require a complete vault inventory within ` +
        `${MAX_SCAN_NOTES} notes / ${MAX_SCAN_VISITED_ENTRIES} visited entries`
    );
  }
  return listing.entries;
}
