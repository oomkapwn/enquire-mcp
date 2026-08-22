// v3.4.0 — Wikilink community detection (GraphRAG-light).
//
// Builds an undirected graph from the vault's wikilinks (edge for every
// resolved [[link]]) and partitions notes into communities via greedy
// modularity optimization (single-phase Louvain). The result lets agents
// reason about which notes form coherent topics without relying on
// embeddings — pure structural signal.
//
// Why "GraphRAG-light"?
//   - Microsoft GraphRAG runs Leiden/Louvain on entity graphs +
//     LLM-summarizes communities bottom-up.
//   - We have wikilinks (a structural graph) + run modularity-based
//     community detection. We do NOT call an LLM (server stays
//     LLM-free); the calling agent can summarize communities itself.
//   - Result: structural communities surfaced as a retrieval primitive.
//
// Algorithm:
//   1. Build weighted undirected adjacency from wikilinks. Bidirectional
//      links count as a heavier edge (weight 2). Self-links ignored.
//   2. Initial partition: each node in its own community.
//   3. Greedy pass: for each node, evaluate moving it to each neighbor's
//      community. Pick the move with max ΔQ (modularity gain). Repeat
//      the pass until no node changes community in a full sweep.
//   4. Return community ID per node + community → member-list inverted
//      mapping + global modularity score.
//
// Single-phase (no super-node aggregation). Good enough for vaults up
// to ~50K notes; full multi-phase Louvain is a future optimization.

import * as path from "node:path";
import { foldName } from "./name-fold.js";
import type { Vault } from "./vault.js";

/**
 * v3.9.0-rc.35 (external-audit AS#5 / R-B) — hard cap on the number of notes
 * the wikilink graph ingests, mirroring the `MAX_VISITED` cap on `find_path`
 * BFS (rc.34 R-5). `obsidian_get_communities` is always-registered and reads
 * EVERY `.md` to build a full adjacency map + run Louvain; on a pathological /
 * very large vault that is unbounded I/O + memory for a single tool call. We
 * admit a complete, deterministically sorted bounded inventory. A vault that
 * exceeds the node or traversal ceiling fails closed rather than silently
 * presenting a prefix as a complete graph. Louvain itself is additionally
 * bounded by `MAX_PASSES`.
 */
export const MAX_GRAPH_NODES = 50_000;

/** Maximum directory entries inspected while discovering graph nodes. */
export const MAX_GRAPH_VISITED_ENTRIES = 200_000;

/** Maximum aggregate UTF-8 bytes retained for normalized graph-node paths. */
export const MAX_GRAPH_NODE_UTF8_BYTES = 8 * 1024 * 1024;

/** Maximum UTF-8 bytes accepted for one normalized graph-node path. */
export const MAX_GRAPH_NODE_PATH_UTF8_BYTES = 16 * 1024;

/** Maximum aggregate Markdown UTF-8 bytes parsed during one graph build. */
export const MAX_GRAPH_SOURCE_UTF8_BYTES = 256 * 1024 * 1024;

/** Maximum wikilink occurrences inspected during one graph build. */
export const MAX_GRAPH_LINK_OCCURRENCES = 500_000;

/** Maximum UTF-8 bytes accepted for one wikilink target. */
export const MAX_GRAPH_LINK_TARGET_UTF8_BYTES = 16 * 1024;

/** Maximum aggregate UTF-8 bytes inspected across wikilink targets. */
export const MAX_GRAPH_LINK_TARGETS_UTF8_BYTES = 32 * 1024 * 1024;

/** Maximum distinct undirected edges retained by one graph build. */
export const MAX_GRAPH_EDGES = 250_000;

/** Maximum members returned for any one community. */
export const MAX_COMMUNITY_MEMBERS_PER_COMMUNITY = 2_048;

/** Maximum JSON-string UTF-8 bytes returned for member paths and representative in one community. */
export const MAX_COMMUNITY_MEMBER_UTF8_BYTES_PER_COMMUNITY = 512 * 1024;

/** Maximum member occurrences returned across all communities. */
export const MAX_COMMUNITY_RESPONSE_MEMBERS = 10_000;

/** Maximum JSON-string UTF-8 bytes returned across all member paths and representatives. */
export const MAX_COMMUNITY_RESPONSE_MEMBER_UTF8_BYTES = 2 * 1024 * 1024;

/**
 * Resource ceilings used by {@link buildWikilinkGraph}.
 *
 * Overrides exist so callers and small causal tests can request a stricter
 * envelope. Every override is validated against the production maximum; this
 * interface cannot be used to raise a server-side ceiling.
 */
export interface WikilinkGraphBudgets {
  /** Maximum admitted Markdown nodes. */
  maxNodes: number;
  /** Maximum directory entries inspected by the bounded walker. */
  maxVisitedEntries: number;
  /** Maximum aggregate UTF-8 bytes retained for node paths. */
  maxNodeUtf8Bytes: number;
  /** Maximum aggregate UTF-8 bytes parsed from Markdown sources. */
  maxSourceUtf8Bytes: number;
  /** Maximum wikilink occurrences inspected. */
  maxLinkOccurrences: number;
  /** Maximum aggregate UTF-8 bytes inspected across wikilink targets. */
  maxLinkTargetUtf8Bytes: number;
  /** Maximum distinct undirected edges retained. */
  maxEdges: number;
}

const DEFAULT_GRAPH_BUDGETS: Readonly<WikilinkGraphBudgets> = Object.freeze({
  maxNodes: MAX_GRAPH_NODES,
  maxVisitedEntries: MAX_GRAPH_VISITED_ENTRIES,
  maxNodeUtf8Bytes: MAX_GRAPH_NODE_UTF8_BYTES,
  maxSourceUtf8Bytes: MAX_GRAPH_SOURCE_UTF8_BYTES,
  maxLinkOccurrences: MAX_GRAPH_LINK_OCCURRENCES,
  maxLinkTargetUtf8Bytes: MAX_GRAPH_LINK_TARGETS_UTF8_BYTES,
  maxEdges: MAX_GRAPH_EDGES
});

export interface WikilinkGraph {
  /** Node ID = vault-relative path (forward-slash normalized). */
  nodes: string[];
  /** Adjacency: nodeId → neighborNodeId → edge weight. Symmetric. */
  adjacency: Map<string, Map<string, number>>;
  /** Total edge weight × 2 (= sum of all edge weights, undirected). */
  totalWeight2m: number;
  /** Degree per node (sum of incident edge weights). */
  degree: Map<string, number>;
}

export interface CommunityResult {
  /** Number of distinct communities found. */
  community_count: number;
  /** Modularity Q ∈ [-0.5, 1] of the final partition. */
  modularity: number;
  /** Number of greedy passes run. */
  iterations: number;
  /**
   * v3.9.0-rc.15 — true if Louvain reached a stable partition (a pass made no
   * moves); false if it hit the `MAX_PASSES` cap with moves still pending (the
   * partition is valid but may be sub-optimal — callers can surface this).
   */
  converged: boolean;
  /** community_id → member note paths, sorted by in-community degree desc. */
  communities: Array<{
    id: number;
    size: number;
    /** Sorted by descending in-community degree (= "central" first). */
    members: string[];
    /** Single most-central member (highest in-community degree). */
    representative: string;
  }>;
  /** Inverted index: note path → community id. */
  membership: Map<string, number>;
}

function comparePaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function graphBudgets(overrides: Partial<WikilinkGraphBudgets>): WikilinkGraphBudgets {
  const admitted = { ...DEFAULT_GRAPH_BUDGETS };
  for (const key of Object.keys(DEFAULT_GRAPH_BUDGETS) as Array<keyof WikilinkGraphBudgets>) {
    const value = overrides[key];
    if (value === undefined) continue;
    const maximum = DEFAULT_GRAPH_BUDGETS[key];
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
      throw new TypeError(`${key} must be a positive safe integer no greater than ${maximum}`);
    }
    admitted[key] = value;
  }
  return admitted;
}

/**
 * Build the undirected wikilink graph from the vault. Each edge = a
 * resolved wikilink (we ignore broken ones — they wouldn't be part of
 * the graph anyway). Bidirectional links contribute weight 2 (one per
 * direction); unidirectional contribute weight 1.
 *
 * Resolution: we use case-insensitive basename match (matches the
 * existing tools' behavior). A wikilink `[[Foo]]` resolves to a note
 * named `Foo.md` if exactly one such note exists; otherwise to the
 * first match in deterministic path order.
 *
 * @param vault - Vault whose visible Markdown notes form the graph.
 * @param overrides - Optional stricter resource ceilings. Values may not
 *   exceed the production defaults.
 * @returns A complete, resource-admitted graph snapshot.
 * @throws {RangeError} If discovery, source, link, or edge admission is
 *   incomplete or exceeds a configured ceiling.
 */
export async function buildWikilinkGraph(
  vault: Vault,
  overrides: Partial<WikilinkGraphBudgets> = {}
): Promise<WikilinkGraph> {
  const budgets = graphBudgets(overrides);
  const listing = await vault.listFilesByExtensionsBounded([".md"], budgets.maxNodes, budgets.maxVisitedEntries);
  if (!listing.complete || listing.entries.length > budgets.maxNodes) {
    throw new RangeError(
      `Wikilink graph requires a complete inventory within ${budgets.maxNodes} notes / ${budgets.maxVisitedEntries} visited entries`
    );
  }

  // The walker order follows filesystem enumeration and therefore is not a
  // stable ambiguity tiebreaker. Normalize and sort before building either the
  // basename authority or the node/adjacency arrays.
  const all = listing.entries
    .map((entry) => ({ entry, nodePath: entry.relPath.replace(/\\/g, "/") }))
    .sort((a, b) => comparePaths(a.nodePath, b.nodePath));

  let nodeUtf8Bytes = 0;
  for (const { nodePath } of all) {
    const pathBytes = Buffer.byteLength(nodePath, "utf8");
    if (pathBytes > MAX_GRAPH_NODE_PATH_UTF8_BYTES) {
      throw new RangeError(`Wikilink graph node path exceeds ${MAX_GRAPH_NODE_PATH_UTF8_BYTES} UTF-8 bytes`);
    }
    if (pathBytes > budgets.maxNodeUtf8Bytes - nodeUtf8Bytes) {
      throw new RangeError(`Wikilink graph node paths exceed ${budgets.maxNodeUtf8Bytes} aggregate UTF-8 bytes`);
    }
    nodeUtf8Bytes += pathBytes;
  }

  // Build a basename index for resolving wikilinks.
  const byBasename = new Map<string, string>();
  for (const { entry, nodePath } of all) {
    const base = foldName(entry.basename.replace(/\.md$/i, ""));
    if (!byBasename.has(base)) byBasename.set(base, nodePath);
  }
  const adj = new Map<string, Map<string, number>>();
  const allPaths = all.map(({ nodePath }) => nodePath);
  for (const nodePath of allPaths) {
    if (adj.has(nodePath)) throw new Error("Wikilink graph inventory contains a duplicate normalized note path");
    adj.set(nodePath, new Map());
  }

  let sourceUtf8Bytes = 0;
  let linkOccurrences = 0;
  let linkTargetUtf8Bytes = 0;
  let edgeCount = 0;
  for (const { entry, nodePath: fromPath } of all) {
    const note = await vault.readNoteUncached(entry.absPath, entry.mtimeMs);
    const bodyBytes = Buffer.byteLength(note.content, "utf8");
    if (bodyBytes > budgets.maxSourceUtf8Bytes - sourceUtf8Bytes) {
      throw new RangeError(`Wikilink graph sources exceed ${budgets.maxSourceUtf8Bytes} aggregate UTF-8 bytes`);
    }
    sourceUtf8Bytes += bodyBytes;

    // v3.11.5-rc.3 (post-rc.2 re-sweep, PARSER-DESYNC class) — use the Vault's
    // canonical parsed-note path so frontmatter + fenced/inline code are stripped
    // BEFORE link extraction. Pre-rc.3 a raw-body extractor let a `[[link]]` inside
    // code/frontmatter create a phantom graph edge. The uncached staging read also
    // avoids filling the shared parsed-note cache during this whole-vault operation.
    const links = note.parsed.wikilinks;
    if (links.length > budgets.maxLinkOccurrences - linkOccurrences) {
      throw new RangeError(`Wikilink graph exceeds ${budgets.maxLinkOccurrences} wikilink occurrences`);
    }
    linkOccurrences += links.length;

    let noteTargetUtf8Bytes = 0;
    for (const link of links) {
      const targetBytes = Buffer.byteLength(link.target, "utf8");
      if (targetBytes > MAX_GRAPH_LINK_TARGET_UTF8_BYTES) {
        throw new RangeError(`Wikilink target exceeds ${MAX_GRAPH_LINK_TARGET_UTF8_BYTES} UTF-8 bytes`);
      }
      if (targetBytes > budgets.maxLinkTargetUtf8Bytes - linkTargetUtf8Bytes - noteTargetUtf8Bytes) {
        throw new RangeError(`Wikilink graph targets exceed ${budgets.maxLinkTargetUtf8Bytes} aggregate UTF-8 bytes`);
      }
      noteTargetUtf8Bytes += targetBytes;
    }
    linkTargetUtf8Bytes += noteTargetUtf8Bytes;

    for (const link of links) {
      // Normalize: strip section/block, take just the target part.
      const target = link.target.split(/[#^]/)[0]?.trim();
      if (!target) continue;
      // Resolution: try basename match, then path match.
      const lookupKey = foldName(path.basename(target).replace(/\.md$/i, ""));
      let toPath = byBasename.get(lookupKey);
      if (!toPath) {
        // Try direct path match.
        const candidate = target.endsWith(".md") ? target : `${target}.md`;
        if (adj.has(candidate.replace(/\\/g, "/"))) toPath = candidate.replace(/\\/g, "/");
      }
      if (!toPath || toPath === fromPath) continue;
      // Add edge in BOTH directions (undirected, weight 1 per direction).
      // Bidirectional links naturally accumulate weight 2 because we'll
      // see the link from both sides.
      const fromMap = adj.get(fromPath);
      const toMap = adj.get(toPath);
      if (!fromMap || !toMap) continue;
      if (!fromMap.has(toPath)) {
        if (edgeCount >= budgets.maxEdges) {
          throw new RangeError(`Wikilink graph exceeds ${budgets.maxEdges} distinct undirected edges`);
        }
        edgeCount += 1;
      }
      fromMap.set(toPath, (fromMap.get(toPath) ?? 0) + 1);
      toMap.set(fromPath, (toMap.get(fromPath) ?? 0) + 1);
    }
  }

  // Compute total weight (2m) + degree per node.
  let total = 0;
  const degree = new Map<string, number>();
  for (const [n, neighbors] of adj.entries()) {
    let d = 0;
    for (const w of neighbors.values()) d += w;
    degree.set(n, d);
    total += d;
  }
  return { nodes: allPaths, adjacency: adj, totalWeight2m: total, degree };
}

/**
 * Greedy modularity-based community detection. Single-phase Louvain.
 *
 * Returns the partition + modularity + community summary.
 */
export function detectCommunities(graph: WikilinkGraph): CommunityResult {
  const { nodes, adjacency, totalWeight2m: m2, degree } = graph;
  // Initial partition: each node in its own community.
  const community = new Map<string, number>();
  for (const [i, n] of nodes.entries()) community.set(n, i);

  // Pre-compute total weight per community (Σ_tot in Louvain notation).
  const sigmaTot = new Map<number, number>();
  for (const [n, c] of community.entries()) {
    sigmaTot.set(c, (sigmaTot.get(c) ?? 0) + (degree.get(n) ?? 0));
  }

  // Edge case: no edges (every node isolated). Each node is its own
  // community; modularity = 0 by convention.
  if (m2 === 0) {
    // No edges → nothing to optimize; trivially converged in 0 passes.
    return finalize(graph, community, 0, 0, true);
  }

  let iterations = 0;
  const MAX_PASSES = 50;
  let changed = true;
  while (changed && iterations < MAX_PASSES) {
    changed = false;
    iterations++;
    for (const node of nodes) {
      const cur = community.get(node) ?? -1;
      const ki = degree.get(node) ?? 0;
      // Compute weight from `node` to each neighboring community.
      const wToCommunity = new Map<number, number>();
      for (const [neighbor, w] of adjacency.get(node) ?? []) {
        const cn = community.get(neighbor);
        if (cn === undefined) continue;
        wToCommunity.set(cn, (wToCommunity.get(cn) ?? 0) + w);
      }
      // Remove `node` from its current community before evaluating.
      sigmaTot.set(cur, (sigmaTot.get(cur) ?? 0) - ki);
      const wToCur = wToCommunity.get(cur) ?? 0;
      // Evaluate ΔQ for moving to each candidate community.
      // Louvain ΔQ formula (simplified, single-phase):
      //   ΔQ(node → C) = (k_i,C - σ_tot(C) * k_i / m) / m
      // where k_i,C = sum of weights from node to nodes in C
      // and σ_tot(C) = sum of degrees of nodes in C (after removing node).
      // We pick the C with max ΔQ; if max ΔQ <= ΔQ(stay) then keep stay.
      let bestCommunity = cur;
      let bestGain = (wToCur - ((sigmaTot.get(cur) ?? 0) * ki) / m2) / m2;
      for (const [cand, kIc] of wToCommunity.entries()) {
        if (cand === cur) continue;
        const sigC = sigmaTot.get(cand) ?? 0;
        const gain = (kIc - (sigC * ki) / m2) / m2;
        if (gain > bestGain) {
          bestGain = gain;
          bestCommunity = cand;
        }
      }
      // Apply the move.
      sigmaTot.set(bestCommunity, (sigmaTot.get(bestCommunity) ?? 0) + ki);
      if (bestCommunity !== cur) {
        community.set(node, bestCommunity);
        changed = true;
      }
    }
  }

  const Q = computeModularity(graph, community);
  // v3.9.0-rc.15 — `!changed` means the last pass made no moves → converged.
  // `changed` is still true only when the loop exited on the MAX_PASSES cap.
  return finalize(graph, community, Q, iterations, !changed);
}

/**
 * Newman–Girvan modularity Q = Σ_ij [A_ij − k_i·k_j/2m]·δ(c_i,c_j) / 2m, decomposed as
 * Q = Σ_c [ in_c/2m − (tot_c/2m)² ] where `in_c` is the intra-community edge weight (the
 * adjacency rep counts each undirected edge twice) and `tot_c` the community's degree sum.
 *
 * v3.10.0-rc.43 (M7) — FIX: the prior implementation summed the null-model penalty
 * `(k_i·k_j/2m)` ONLY over ADJACENT same-community pairs (it lived inside the `for (…of
 * neighbors)` loop), but the standard formula penalizes ALL same-community pairs incl.
 * non-adjacent ones (where A_ij=0 but −k_i·k_j/2m still applies). The truncated penalty
 * inflated Q and could rank a degenerate single-community partition ABOVE the correct
 * split. Now the penalty is the exact Σ_c tot_c² over per-community degree sums.
 */
export function computeModularity(graph: WikilinkGraph, community: Map<string, number>): number {
  const { adjacency, totalWeight2m: m2, degree } = graph;
  if (m2 === 0) return 0;
  // Term 1 — intra-community edge weight (adjacency double-counts undirected edges).
  let sIn = 0;
  for (const [i, neighbors] of adjacency.entries()) {
    const ci = community.get(i);
    for (const [j, w] of neighbors) {
      if (community.get(j) === ci) sIn += w;
    }
  }
  // Term 2 — null-model penalty over ALL same-community pairs: Σ_c (Σ_{i∈c} k_i)².
  const degByCommunity = new Map<number, number>();
  for (const [node, c] of community.entries()) {
    degByCommunity.set(c, (degByCommunity.get(c) ?? 0) + (degree.get(node) ?? 0));
  }
  let sumSq = 0;
  for (const tot of degByCommunity.values()) sumSq += tot * tot;
  return sIn / m2 - sumSq / (m2 * m2);
}

function finalize(
  graph: WikilinkGraph,
  community: Map<string, number>,
  modularity: number,
  iterations: number,
  converged: boolean
): CommunityResult {
  // Renumber communities to dense 0..N-1 IDs.
  const remap = new Map<number, number>();
  const buckets: Map<number, string[]> = new Map();
  for (const [n, c] of community.entries()) {
    let nc = remap.get(c);
    if (nc === undefined) {
      nc = remap.size;
      remap.set(c, nc);
    }
    if (!buckets.has(nc)) buckets.set(nc, []);
    buckets.get(nc)?.push(n);
  }
  // Build membership map with the remapped IDs.
  const membership = new Map<string, number>();
  for (const [n, c] of community.entries()) {
    const nc = remap.get(c) ?? 0;
    membership.set(n, nc);
  }
  // Sort each community's members by in-community degree descending.
  const communities = [...buckets.entries()]
    .map(([id, members]) => {
      const sorted = sortMembersByCentrality(members, graph, membership);
      return {
        id,
        size: members.length,
        members: sorted,
        representative: sorted[0] ?? ""
      };
    })
    .sort((a, b) => b.size - a.size || a.id - b.id);
  return {
    community_count: communities.length,
    modularity: Math.round(modularity * 10000) / 10000,
    iterations,
    converged,
    communities,
    membership
  };
}

function sortMembersByCentrality(members: string[], graph: WikilinkGraph, membership: Map<string, number>): string[] {
  // In-community degree per member.
  const inDeg = new Map<string, number>();
  for (const m of members) {
    let d = 0;
    const myComm = membership.get(m);
    for (const [n, w] of graph.adjacency.get(m) ?? []) {
      if (membership.get(n) === myComm) d += w;
    }
    inDeg.set(m, d);
  }
  return [...members].sort((a, b) => {
    const da = inDeg.get(a) ?? 0;
    const db = inDeg.get(b) ?? 0;
    if (da !== db) return db - da;
    return comparePaths(a, b);
  });
}

function jsonStringUtf8Bytes(value: string): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/**
 * Build the bounded public response for `obsidian_get_communities`.
 *
 * Community totals remain exact, while returned community and member counts
 * explicitly distinguish caller filtering from truncation. Membership is
 * encoded once in `communities[].members`; the former duplicate path→id object
 * is intentionally omitted. Member arrays are deterministic prefixes of the
 * centrality ordering and are admitted against per-community and global count
 * plus JSON UTF-8 byte ceilings before insertion. Byte receipts include every
 * returned membership-path string occurrence: the representative and each
 * entry of the member array.
 *
 * @param result - Complete detected partition.
 * @param args - Optional minimum community size and maximum community count.
 * @returns A bounded response with exact total/returned/truncation receipts.
 */
export function formatCommunityResponse(
  result: CommunityResult,
  args: { minSize?: number; limit?: number } = {}
): {
  community_count: number;
  eligible_community_count: number;
  returned_community_count: number;
  filtered_community_count: number;
  modularity: number;
  iterations: number;
  converged: boolean;
  node_count: number;
  eligible_member_count: number;
  returned_member_count: number;
  returned_membership_path_utf8_bytes: number;
  communities_truncated: boolean;
  members_truncated: boolean;
  truncated: boolean;
  membership_map_omitted: true;
  communities: Array<{
    id: number;
    size: number;
    returned_member_count: number;
    returned_membership_path_utf8_bytes: number;
    members_truncated: boolean;
    members: string[];
    representative: string;
  }>;
} {
  const minSize = args.minSize ?? 1;
  const limit = args.limit ?? 50;
  if (!Number.isSafeInteger(minSize) || minSize < 0 || minSize > 1_000) {
    throw new TypeError("minSize must be a non-negative safe integer no greater than 1000");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new TypeError("limit must be a positive safe integer no greater than 500");
  }

  let eligibleCommunityCount = 0;
  let eligibleMemberCount = 0;
  for (const community of result.communities) {
    if (community.size < minSize) continue;
    eligibleCommunityCount += 1;
    eligibleMemberCount += community.size;
  }

  const communities: Array<{
    id: number;
    size: number;
    returned_member_count: number;
    returned_membership_path_utf8_bytes: number;
    members_truncated: boolean;
    members: string[];
    representative: string;
  }> = [];
  let returnedMemberCount = 0;
  let returnedMemberUtf8Bytes = 0;

  for (const community of result.communities) {
    if (community.size < minSize) continue;
    if (communities.length >= limit) break;

    const representativeBytes = jsonStringUtf8Bytes(community.representative);
    if (representativeBytes > MAX_COMMUNITY_MEMBER_UTF8_BYTES_PER_COMMUNITY) {
      throw new RangeError(
        `One community representative exceeds ${MAX_COMMUNITY_MEMBER_UTF8_BYTES_PER_COMMUNITY} JSON UTF-8 bytes`
      );
    }
    const firstMember = community.members[0];
    if (community.size > 0 && firstMember === undefined) {
      throw new Error("Detected community size is non-zero but its member inventory is empty");
    }
    const firstMemberBytes = firstMember === undefined ? 0 : jsonStringUtf8Bytes(firstMember);
    if (
      representativeBytes + firstMemberBytes > MAX_COMMUNITY_MEMBER_UTF8_BYTES_PER_COMMUNITY ||
      representativeBytes + firstMemberBytes > MAX_COMMUNITY_RESPONSE_MEMBER_UTF8_BYTES - returnedMemberUtf8Bytes ||
      (community.size > 0 && returnedMemberCount >= MAX_COMMUNITY_RESPONSE_MEMBERS)
    ) {
      break;
    }

    const members: string[] = [];
    let communityMemberUtf8Bytes = representativeBytes;
    returnedMemberUtf8Bytes += representativeBytes;
    let globalBudgetExhausted = false;
    for (const member of community.members) {
      if (members.length >= MAX_COMMUNITY_MEMBERS_PER_COMMUNITY) break;
      if (returnedMemberCount >= MAX_COMMUNITY_RESPONSE_MEMBERS) {
        globalBudgetExhausted = true;
        break;
      }
      const memberBytes = jsonStringUtf8Bytes(member);
      if (memberBytes > MAX_COMMUNITY_MEMBER_UTF8_BYTES_PER_COMMUNITY) {
        throw new RangeError(
          `One community member exceeds ${MAX_COMMUNITY_MEMBER_UTF8_BYTES_PER_COMMUNITY} JSON UTF-8 bytes`
        );
      }
      if (memberBytes > MAX_COMMUNITY_MEMBER_UTF8_BYTES_PER_COMMUNITY - communityMemberUtf8Bytes) break;
      if (memberBytes > MAX_COMMUNITY_RESPONSE_MEMBER_UTF8_BYTES - returnedMemberUtf8Bytes) {
        globalBudgetExhausted = true;
        break;
      }
      members.push(member);
      communityMemberUtf8Bytes += memberBytes;
      returnedMemberUtf8Bytes += memberBytes;
      returnedMemberCount += 1;
    }

    communities.push({
      id: community.id,
      size: community.size,
      returned_member_count: members.length,
      returned_membership_path_utf8_bytes: communityMemberUtf8Bytes,
      members_truncated: members.length < community.size,
      members,
      representative: community.representative
    });
    if (globalBudgetExhausted) break;
  }

  const communitiesTruncated = communities.length < eligibleCommunityCount;
  const membersTruncated = returnedMemberCount < eligibleMemberCount;
  return {
    community_count: result.community_count,
    eligible_community_count: eligibleCommunityCount,
    returned_community_count: communities.length,
    filtered_community_count: result.community_count - eligibleCommunityCount,
    modularity: result.modularity,
    iterations: result.iterations,
    converged: result.converged,
    node_count: result.membership.size,
    eligible_member_count: eligibleMemberCount,
    returned_member_count: returnedMemberCount,
    returned_membership_path_utf8_bytes: returnedMemberUtf8Bytes,
    communities_truncated: communitiesTruncated,
    members_truncated: membersTruncated,
    truncated: communitiesTruncated || membersTruncated,
    membership_map_omitted: true,
    communities
  };
}
