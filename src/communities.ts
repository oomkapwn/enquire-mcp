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
import { extractWikilinks } from "./parser.js";
import type { Vault } from "./vault.js";

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
  /** Number of greedy passes until convergence. */
  iterations: number;
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
  const all = await vault.listFilesByExtension(".md");
  // Build a basename index for resolving wikilinks.
  const byBasename = new Map<string, string>();
  for (const e of all) {
    const base = e.basename.replace(/\.md$/i, "").toLowerCase();
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
    const links = extractWikilinks(body);
    for (const link of links) {
      // Normalize: strip section/block, take just the target part.
      const target = link.target.split(/[#^]/)[0]?.trim();
      if (!target) continue;
      // Resolution: try basename match, then path match.
      const lookupKey = path.basename(target).replace(/\.md$/i, "").toLowerCase();
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
    return finalize(graph, community, 0, 0);
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
  return finalize(graph, community, Q, iterations);
}

function computeModularity(graph: WikilinkGraph, community: Map<string, number>): number {
  const { adjacency, totalWeight2m: m2, degree } = graph;
  if (m2 === 0) return 0;
  let Q = 0;
  for (const [i, neighbors] of adjacency.entries()) {
    const ci = community.get(i);
    const ki = degree.get(i) ?? 0;
    for (const [j, w] of neighbors) {
      const cj = community.get(j);
      if (ci !== cj) continue;
      const kj = degree.get(j) ?? 0;
      Q += w - (ki * kj) / m2;
    }
  }
  return Q / m2;
}

function finalize(
  graph: WikilinkGraph,
  community: Map<string, number>,
  modularity: number,
  iterations: number
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
