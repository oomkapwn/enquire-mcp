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
import { parseNote } from "./parser.js";
import type { Vault } from "./vault.js";

/**
 * v3.9.0-rc.35 (external-audit AS#5 / R-B) — hard cap on the number of notes
 * the wikilink graph ingests, mirroring the `MAX_VISITED` cap on `find_path`
 * BFS (rc.34 R-5). `obsidian_get_communities` is always-registered and reads
 * EVERY `.md` to build a full adjacency map + run Louvain; on a pathological /
 * very large vault that is unbounded I/O + memory for a single tool call. We
 * cap the node set (newest-first by the vault's own listing order) so the
 * worst case is bounded regardless of vault size — defense-in-depth, not a
 * correctness limit (real vaults are far below the cap; Louvain itself is
 * already bounded by `MAX_PASSES`).
 */
export const MAX_GRAPH_NODES = 50_000;

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

/**
 * Build the undirected wikilink graph from the vault. Each edge = a
 * resolved wikilink (we ignore broken ones — they wouldn't be part of
 * the graph anyway). Bidirectional links contribute weight 2 (one per
 * direction); unidirectional contribute weight 1.
 *
 * Resolution: we use case-insensitive basename match (matches the
 * existing tools' behavior). A wikilink `[[Foo]]` resolves to a note
 * named `Foo.md` if exactly one such note exists; otherwise to the
 * first match by walk order.
 */
export async function buildWikilinkGraph(vault: Vault): Promise<WikilinkGraph> {
  await vault.ensureExists();
  const listed = await vault.listFilesByExtension(".md");
  // v3.9.0-rc.35 (AS#5 / R-B) — bound the node set so a pathological/huge vault
  // can't drive unbounded I/O + memory through this always-registered tool.
  // Truncate to MAX_GRAPH_NODES (graceful degradation; real vaults are far
  // below the cap). Mirrors the rc.34 find_path R-5 MAX_VISITED cap.
  const all = listed.length > MAX_GRAPH_NODES ? listed.slice(0, MAX_GRAPH_NODES) : listed;
  // Build a basename index for resolving wikilinks.
  const byBasename = new Map<string, string>();
  for (const e of all) {
    const base = foldName(e.basename.replace(/\.md$/i, ""));
    if (!byBasename.has(base)) byBasename.set(base, e.relPath.replace(/\\/g, "/"));
  }
  const adj = new Map<string, Map<string, number>>();
  const allPaths = all.map((e) => e.relPath.replace(/\\/g, "/"));
  for (const p of allPaths) adj.set(p, new Map());

  for (const e of all) {
    const fromPath = e.relPath.replace(/\\/g, "/");
    let body: string;
    try {
      body = await vault.readFile(e.absPath);
    } catch {
      continue;
    }
    // v3.11.5-rc.3 (post-rc.2 re-sweep, PARSER-DESYNC class) — go through parseNote so
    // frontmatter + fenced/inline code are stripped BEFORE link extraction. Pre-rc.3 this
    // called extractWikilinks on the RAW file body, so a `[[link]]` inside a ``` fence (or
    // in frontmatter) created a phantom graph edge that skewed the community clustering +
    // modularity the always-on obsidian_get_communities tool returns.
    const links = parseNote(body).wikilinks;
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
    .sort((a, b) => b.size - a.size);
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
    return a.localeCompare(b);
  });
}
