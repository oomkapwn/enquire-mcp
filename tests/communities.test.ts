// v3.4.0 — wikilink community detection (GraphRAG-light). Tests:
//   1. Graph construction over synthetic vaults with known link
//      structure. Verify edges + degrees.
//   2. Modularity-based community detection on graphs with planted
//      communities — clusters should be recovered.
//   3. Edge cases: empty graph, isolated nodes, single component,
//      bidirectional vs unidirectional links.

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildWikilinkGraph,
  type CommunityResult,
  computeModularity,
  detectCommunities,
  formatCommunityResponse,
  MAX_COMMUNITY_MEMBER_UTF8_BYTES_PER_COMMUNITY,
  MAX_COMMUNITY_MEMBERS_PER_COMMUNITY,
  MAX_COMMUNITY_RESPONSE_MEMBER_UTF8_BYTES,
  MAX_COMMUNITY_RESPONSE_MEMBERS
} from "../src/communities.js";
import { parseNote } from "../src/parser.js";
import { Vault } from "../src/vault.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-comm-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function vaultWith(notes: Record<string, string>): Promise<Vault> {
  for (const [rel, body] of Object.entries(notes)) {
    const full = path.join(dir, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, body);
  }
  const v = new Vault(dir);
  await v.ensureExists();
  return v;
}

function fakeGraphVault(
  entries: Array<{ relPath: string; absPath: string; basename: string; mtimeMs: number }>,
  bodies: Record<string, string>,
  complete = true
): Vault {
  return {
    listFilesByExtensionsBounded: async () => ({ entries, visitedEntries: entries.length, complete }),
    readNoteUncached: async (absPath: string) => {
      const content = bodies[absPath] ?? "";
      return { content, parsed: parseNote(content), mtimeMs: 0 };
    }
  } as unknown as Vault;
}

describe("buildWikilinkGraph", () => {
  it("returns empty-but-valid graph on empty vault", async () => {
    const v = await vaultWith({});
    const g = await buildWikilinkGraph(v);
    expect(g.nodes).toEqual([]);
    expect(g.totalWeight2m).toBe(0);
  });

  it("creates an undirected edge per wikilink (bidirectional doubles weight)", async () => {
    const v = await vaultWith({
      "A.md": "links to [[B]] and [[C]]\n",
      "B.md": "links to [[A]] (bidirectional)\n",
      "C.md": "no outbound\n"
    });
    const g = await buildWikilinkGraph(v);
    expect(g.nodes.length).toBe(3);
    // A↔B: A says [[B]] (+1 each side), B says [[A]] (+1 each side) → weight 2.
    // A↔C: only A says [[C]] (+1 each side) → weight 1.
    expect(g.adjacency.get("A.md")?.get("B.md")).toBe(2);
    expect(g.adjacency.get("B.md")?.get("A.md")).toBe(2);
    expect(g.adjacency.get("A.md")?.get("C.md")).toBe(1);
    expect(g.adjacency.get("C.md")?.get("A.md")).toBe(1);
    // Total 2m = 2*1 (A↔B) + 2*1 (A↔C) ... actually it's sum of all incident weights.
    // A: B=2 + C=1 = 3; B: A=2; C: A=1 → 3+2+1 = 6.
    expect(g.totalWeight2m).toBe(6);
  });

  it("ignores broken wikilinks (no edge added)", async () => {
    const v = await vaultWith({
      "A.md": "[[NonExistent]] and [[B]]\n",
      "B.md": "real note"
    });
    const g = await buildWikilinkGraph(v);
    expect(g.adjacency.get("A.md")?.has("B.md")).toBe(true);
    // No edge to NonExistent because it's not a real node.
    expect(g.adjacency.get("A.md")?.size).toBe(1);
  });

  it("ignores self-links", async () => {
    const v = await vaultWith({ "A.md": "self-ref [[A]] and [[B]]\n", "B.md": "real" });
    const g = await buildWikilinkGraph(v);
    expect(g.adjacency.get("A.md")?.has("A.md")).toBe(false);
    expect(g.adjacency.get("A.md")?.get("B.md")).toBe(1);
  });

  it("strips section/block refs when resolving wikilink target", async () => {
    const v = await vaultWith({
      "A.md": "section ref: [[B#heading]]\n",
      "B.md": "## heading\nblock ^abc"
    });
    const g = await buildWikilinkGraph(v);
    expect(g.adjacency.get("A.md")?.get("B.md")).toBe(1);
  });
});

describe("detectCommunities", () => {
  it("returns trivial result on empty graph (zero communities, zero modularity)", async () => {
    const v = await vaultWith({});
    const g = await buildWikilinkGraph(v);
    const r = detectCommunities(g);
    expect(r.community_count).toBe(0);
    expect(r.modularity).toBe(0);
    expect(r.communities).toEqual([]);
  });

  it("isolated nodes each form their own community", async () => {
    const v = await vaultWith({ "A.md": "no links", "B.md": "no links", "C.md": "no links" });
    const g = await buildWikilinkGraph(v);
    const r = detectCommunities(g);
    expect(r.community_count).toBe(3);
    expect(r.modularity).toBe(0); // no edges → Q=0
    expect(r.converged).toBe(true); // v3.9.0-rc.15 — edgeless graph trivially converges (m2===0 path)
    expect(r.iterations).toBe(0);
  });

  it("recovers planted clusters in a 2-community graph", async () => {
    // 6 notes, 2 obvious clusters: {A,B,C} densely linked, {D,E,F} densely linked,
    // single bridge between clusters via A↔D.
    const v = await vaultWith({
      "A.md": "[[B]] [[C]] [[D]]\n",
      "B.md": "[[A]] [[C]]\n",
      "C.md": "[[A]] [[B]]\n",
      "D.md": "[[A]] [[E]] [[F]]\n",
      "E.md": "[[D]] [[F]]\n",
      "F.md": "[[D]] [[E]]\n"
    });
    const g = await buildWikilinkGraph(v);
    const r = detectCommunities(g);
    // We should find ~2 communities (could be 1-3 depending on local optima);
    // at minimum, A/B/C should land in the same community AND D/E/F should
    // land in the same community.
    const cAB = r.membership.get("A.md");
    const cAC = r.membership.get("C.md");
    const cAD = r.membership.get("D.md");
    const cAE = r.membership.get("E.md");
    expect(cAB).toBe(r.membership.get("B.md")); // A,B same
    expect(cAB).toBe(cAC); // A,B,C same
    expect(cAD).toBe(cAE); // D,E same
    expect(cAD).toBe(r.membership.get("F.md")); // D,E,F same
    // Ideally A's community ≠ D's community (single bridge isn't enough).
    expect(cAB).not.toBe(cAD);
    expect(r.modularity).toBeGreaterThan(0); // structure present
    // v3.9.0-rc.15 — a small real graph converges well within MAX_PASSES (the
    // `!changed` path), so `converged` is true and `iterations` < the cap.
    expect(r.converged).toBe(true);
    expect(r.iterations).toBeLessThan(50);
  });

  it("a single fully-connected component lands in one community", async () => {
    const v = await vaultWith({
      "A.md": "[[B]] [[C]] [[D]]\n",
      "B.md": "[[A]] [[C]] [[D]]\n",
      "C.md": "[[A]] [[B]] [[D]]\n",
      "D.md": "[[A]] [[B]] [[C]]\n"
    });
    const g = await buildWikilinkGraph(v);
    const r = detectCommunities(g);
    expect(r.community_count).toBe(1);
    expect(r.communities[0]?.size).toBe(4);
  });

  it("representative is the most-central member (highest in-community degree)", async () => {
    // Hub A linked from B/C/D; B/C/D each only link to A. A has degree 6, B/C/D have 2 each.
    const v = await vaultWith({
      "A.md": "hub note",
      "B.md": "[[A]]",
      "C.md": "[[A]]",
      "D.md": "[[A]]"
    });
    const g = await buildWikilinkGraph(v);
    const r = detectCommunities(g);
    // All in one community (A is the bridge); A should be representative.
    expect(r.communities[0]?.representative).toBe("A.md");
  });

  it("converges in finite iterations (small graph, < 50 passes)", async () => {
    const v = await vaultWith({
      "A.md": "[[B]]",
      "B.md": "[[C]]",
      "C.md": "[[D]]",
      "D.md": "[[A]]"
    });
    const g = await buildWikilinkGraph(v);
    const r = detectCommunities(g);
    expect(r.iterations).toBeGreaterThan(0);
    expect(r.iterations).toBeLessThan(50);
  });

  it("modularity is in [-0.5, 1]", async () => {
    const v = await vaultWith({
      "A.md": "[[B]] [[C]]\n",
      "B.md": "[[A]] [[C]]\n",
      "C.md": "[[A]] [[B]]\n",
      "D.md": "[[E]] [[F]]\n",
      "E.md": "[[D]] [[F]]\n",
      "F.md": "[[D]] [[E]]\n"
    });
    const g = await buildWikilinkGraph(v);
    const r = detectCommunities(g);
    expect(r.modularity).toBeGreaterThanOrEqual(-0.5);
    expect(r.modularity).toBeLessThanOrEqual(1);
  });

  it("communities are sorted by size descending in the response", async () => {
    const v = await vaultWith({
      "Big1.md": "[[Big2]] [[Big3]] [[Big4]]\n",
      "Big2.md": "[[Big1]] [[Big3]] [[Big4]]\n",
      "Big3.md": "[[Big1]] [[Big2]] [[Big4]]\n",
      "Big4.md": "[[Big1]] [[Big2]] [[Big3]]\n",
      "Small1.md": "[[Small2]]\n",
      "Small2.md": "[[Small1]]\n"
    });
    const g = await buildWikilinkGraph(v);
    const r = detectCommunities(g);
    // Big cluster should rank first; small second; isolated last.
    expect(r.communities[0]?.size).toBeGreaterThanOrEqual(r.communities[1]?.size ?? 0);
  });
});

// v3.6.2 branch-coverage uplift: exercise the wikilink-resolution edge
// paths (duplicate basenames across folders, explicit `.md`-suffixed
// target paths, empty link targets) so the buildWikilinkGraph branches
// at L83 / L101 / L107-108 land. These were uncovered in v3.6.0 — the
// per-instance backfill mentioned in `docs/audits/findings/L3-tests.md`.
describe("buildWikilinkGraph — resolution edge cases (v3.6.2 branches)", () => {
  it("first-seen wins when multiple notes share a basename across folders", async () => {
    const v = await vaultWith({
      "A.md": "[[Dup]]",
      "Folder1/Dup.md": "first",
      "Folder2/Dup.md": "second"
    });
    const g = await buildWikilinkGraph(v);
    // The basename index is populated in walk order; the FIRST `Dup.md`
    // wins (line 83 — `if (!byBasename.has(base))` is the falsy branch
    // when the second `Dup.md` is processed).
    expect(g.nodes.length).toBe(3);
    const aLinks = g.adjacency.get("A.md");
    expect(aLinks).toBeDefined();
    expect(aLinks?.size).toBe(1); // only one Dup edge — second is shadowed
  });

  it("ignores wikilinks whose target trims to empty (e.g. [[#section-only]])", async () => {
    const v = await vaultWith({
      "A.md": "ref to section: [[#orphan]] and [[B]]",
      "B.md": "real note"
    });
    const g = await buildWikilinkGraph(v);
    // [[#orphan]] has an empty target after stripping `#orphan` → branch
    // at L101 (`if (!target) continue;`). The [[B]] edge still resolves.
    expect(g.adjacency.get("A.md")?.get("B.md")).toBe(1);
    expect(g.adjacency.get("A.md")?.size).toBe(1);
  });

  it("falls back to direct path match when basename lookup misses", async () => {
    const v = await vaultWith({
      "A.md": "[[notes/Sub]]", // multi-segment, no basename collision
      "notes/Sub.md": "target"
    });
    const g = await buildWikilinkGraph(v);
    // basename lookup finds `sub` → maps to `notes/Sub.md` already.
    // But the explicit-`.md` branch in L107 needs a different setup:
    expect(g.adjacency.get("A.md")?.get("notes/Sub.md")).toBe(1);
  });

  it("resolves [[Target.md]] with explicit .md suffix via path-fallback", async () => {
    const v = await vaultWith({
      "A.md": "explicit: [[Sub/T.md]]",
      "Sub/T.md": "target"
    });
    const g = await buildWikilinkGraph(v);
    // L107: `const candidate = target.endsWith(".md") ? target : ${target}.md`
    // — the truthy branch ("ends with .md").
    expect(g.adjacency.get("A.md")?.get("Sub/T.md")).toBe(1);
  });

  it("returns empty edge list when wikilink targets a note that doesn't exist (path-fallback miss)", async () => {
    const v = await vaultWith({
      "A.md": "[[ghost/NoSuch.md]] and [[B]]",
      "B.md": "real"
    });
    const g = await buildWikilinkGraph(v);
    // ghost/NoSuch.md doesn't resolve via either basename or path —
    // L108's `if (adj.has(candidate))` is the falsy branch.
    expect(g.adjacency.get("A.md")?.size).toBe(1);
    expect(g.adjacency.get("A.md")?.has("B.md")).toBe(true);
  });
});

describe("detectCommunities — convergence + Louvain branches (v3.6.2)", () => {
  it("nodes with zero degree don't change community during the pass", async () => {
    // Pure isolated graph: the `wToCommunity` loop at L168 is empty for
    // every node, so the bestGain at L183 stays = `(0 - 0)/m2` = 0 for
    // the stay-option, and no move happens. Exercises the "no candidate
    // beats current" branch at L188.
    const v = await vaultWith({ "Solo1.md": "no links", "Solo2.md": "no links" });
    const g = await buildWikilinkGraph(v);
    const r = detectCommunities(g);
    // Both nodes stay in their own community (community_count === 2,
    // modularity === 0 by the m2 === 0 short-circuit at L153).
    expect(r.community_count).toBe(2);
    expect(r.modularity).toBe(0);
  });

  it("two strongly-connected triangles bridged by one edge produce 2 communities", async () => {
    // Drives the inner Louvain loop: each triangle's nodes prefer their
    // own community over the bridge community, so on the second sweep
    // the system converges. Branches in `for (const [cand, kIc] of
    // wToCommunity.entries())` (L184) execute multiple times.
    const v = await vaultWith({
      "T1.md": "[[T2]] [[T3]] [[B1]]",
      "T2.md": "[[T1]] [[T3]]",
      "T3.md": "[[T1]] [[T2]]",
      "B1.md": "[[T1]] [[U1]]", // single bridge
      "U1.md": "[[U2]] [[U3]] [[B1]]",
      "U2.md": "[[U1]] [[U3]]",
      "U3.md": "[[U1]] [[U2]]"
    });
    const g = await buildWikilinkGraph(v);
    const r = detectCommunities(g);
    // Modularity should be positive (planted structure recovered).
    expect(r.modularity).toBeGreaterThan(0);
    // T1/T2/T3 share a community; U1/U2/U3 share one too.
    const cT1 = r.membership.get("T1.md");
    expect(cT1).toBe(r.membership.get("T2.md"));
    expect(cT1).toBe(r.membership.get("T3.md"));
    const cU1 = r.membership.get("U1.md");
    expect(cU1).toBe(r.membership.get("U2.md"));
    expect(cU1).toBe(r.membership.get("U3.md"));
  });

  describe("graph resource admission", () => {
    const twoEntries = [
      { relPath: "b.md", absPath: "/v/b.md", basename: "b.md", mtimeMs: 0 },
      { relPath: "a.md", absPath: "/v/a.md", basename: "a.md", mtimeMs: 0 }
    ];

    it("accepts the exact node boundary and returns deterministic path order", async () => {
      const graph = await buildWikilinkGraph(fakeGraphVault(twoEntries, {}), { maxNodes: 2 });
      expect(graph.nodes).toEqual(["a.md", "b.md"]);
    });

    it("rejects a cap+1 incomplete walker receipt before reading any note", async () => {
      let reads = 0;
      const stub = {
        listFilesByExtensionsBounded: async () => ({ entries: twoEntries, visitedEntries: 3, complete: false }),
        readNoteUncached: async () => {
          reads += 1;
          throw new Error("must not read");
        }
      } as unknown as Vault;
      await expect(buildWikilinkGraph(stub, { maxNodes: 2 })).rejects.toThrow(/complete inventory/);
      expect(reads).toBe(0);
    });

    it("accepts the aggregate node-path UTF-8 boundary and rejects boundary+1", async () => {
      await expect(buildWikilinkGraph(fakeGraphVault(twoEntries, {}), { maxNodeUtf8Bytes: 8 })).resolves.toMatchObject({
        nodes: ["a.md", "b.md"]
      });
      await expect(buildWikilinkGraph(fakeGraphVault(twoEntries, {}), { maxNodeUtf8Bytes: 7 })).rejects.toThrow(
        /node paths exceed/
      );
    });

    it("accepts the aggregate source UTF-8 boundary and rejects boundary+1", async () => {
      const v = await vaultWith({ "A.md": "1234" });
      await expect(buildWikilinkGraph(v, { maxSourceUtf8Bytes: 4 })).resolves.toMatchObject({ nodes: ["A.md"] });
      await expect(buildWikilinkGraph(v, { maxSourceUtf8Bytes: 3 })).rejects.toThrow(/sources exceed 3/);
    });

    it("rejects a dense graph at the distinct-edge cap without a large fixture", async () => {
      const v = await vaultWith({
        "A.md": "[[B]] [[C]] [[D]]",
        "B.md": "",
        "C.md": "",
        "D.md": ""
      });
      await expect(buildWikilinkGraph(v, { maxEdges: 2 })).rejects.toThrow(/2 distinct undirected edges/);
      await expect(buildWikilinkGraph(v, { maxEdges: 3 })).resolves.toMatchObject({ totalWeight2m: 6 });
    });

    it("enforces aggregate wikilink count and target UTF-8 boundaries", async () => {
      const v = await vaultWith({ "A.md": "[[B]] [[B]]", "B.md": "" });
      await expect(buildWikilinkGraph(v, { maxLinkOccurrences: 2, maxLinkTargetUtf8Bytes: 2 })).resolves.toMatchObject({
        totalWeight2m: 4
      });
      await expect(buildWikilinkGraph(v, { maxLinkOccurrences: 1 })).rejects.toThrow(/1 wikilink occurrences/);
      await expect(buildWikilinkGraph(v, { maxLinkTargetUtf8Bytes: 1 })).rejects.toThrow(/targets exceed 1/);
    });

    it("uses deterministic path order to resolve duplicate basenames", async () => {
      const entries = [
        { relPath: "Z/Dup.md", absPath: "/v/Z/Dup.md", basename: "Dup.md", mtimeMs: 0 },
        { relPath: "Source.md", absPath: "/v/Source.md", basename: "Source.md", mtimeMs: 0 },
        { relPath: "A/Dup.md", absPath: "/v/A/Dup.md", basename: "Dup.md", mtimeMs: 0 }
      ];
      const graph = await buildWikilinkGraph(fakeGraphVault(entries, { "/v/Source.md": "[[Dup]]" }));
      expect(graph.adjacency.get("Source.md")?.has("A/Dup.md")).toBe(true);
      expect(graph.adjacency.get("Source.md")?.has("Z/Dup.md")).toBe(false);
    });
  });
});

describe("formatCommunityResponse — bounded single-encoding membership", () => {
  function resultWith(groups: string[][]): CommunityResult {
    const membership = new Map<string, number>();
    const communities = groups.map((members, id) => {
      for (const member of members) membership.set(member, id);
      return {
        id,
        size: members.length,
        members,
        representative: members[0] ?? ""
      };
    });
    return {
      community_count: communities.length,
      modularity: 0.25,
      iterations: 2,
      converged: true,
      communities,
      membership
    };
  }

  it("preserves an ordinary small partition exactly without a duplicate membership map", () => {
    const response = formatCommunityResponse(resultWith([["A.md", "B.md"], ["C.md"]]));
    expect(response.communities.map((community) => community.members)).toEqual([["A.md", "B.md"], ["C.md"]]);
    expect(response).toMatchObject({
      community_count: 2,
      eligible_community_count: 2,
      returned_community_count: 2,
      node_count: 3,
      eligible_member_count: 3,
      returned_member_count: 3,
      communities_truncated: false,
      members_truncated: false,
      truncated: false,
      membership_map_omitted: true
    });
    expect("membership" in response).toBe(false);
  });

  it("reports filter, limit, total, returned, and truncation counts without conflation", () => {
    const response = formatCommunityResponse(resultWith([["A", "B", "C"], ["D", "E"], ["F"]]), {
      minSize: 2,
      limit: 1
    });
    expect(response).toMatchObject({
      community_count: 3,
      eligible_community_count: 2,
      returned_community_count: 1,
      filtered_community_count: 1,
      node_count: 6,
      eligible_member_count: 5,
      returned_member_count: 3,
      communities_truncated: true,
      members_truncated: true,
      truncated: true
    });
  });

  it("bounds a giant one-community member list by count and JSON UTF-8 bytes", () => {
    const longSuffix = "x".repeat(1_024);
    const members = Array.from(
      { length: MAX_COMMUNITY_MEMBERS_PER_COMMUNITY + 100 },
      (_, index) => `${index}-${longSuffix}`
    );
    const response = formatCommunityResponse(resultWith([members]));
    const community = response.communities[0];
    expect(community?.returned_member_count).toBeLessThanOrEqual(MAX_COMMUNITY_MEMBERS_PER_COMMUNITY);
    expect(community?.returned_membership_path_utf8_bytes).toBeLessThanOrEqual(
      MAX_COMMUNITY_MEMBER_UTF8_BYTES_PER_COMMUNITY
    );
    expect(community?.members_truncated).toBe(true);
    expect(response.returned_member_count).toBe(community?.returned_member_count);
    expect(response.returned_membership_path_utf8_bytes).toBe(community?.returned_membership_path_utf8_bytes);
    expect(response.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(response), "utf8")).toBeLessThan(
      MAX_COMMUNITY_MEMBER_UTF8_BYTES_PER_COMMUNITY + 64 * 1024
    );
  });

  it("enforces the global member count/UTF-8 envelope across communities", () => {
    const groups = Array.from({ length: 6 }, (_, group) =>
      Array.from({ length: MAX_COMMUNITY_MEMBERS_PER_COMMUNITY }, (_, index) => `g${group}-m${index}.md`)
    );
    const response = formatCommunityResponse(resultWith(groups));
    expect(response.eligible_member_count).toBe(6 * MAX_COMMUNITY_MEMBERS_PER_COMMUNITY);
    expect(response.returned_member_count).toBe(MAX_COMMUNITY_RESPONSE_MEMBERS);
    expect(response.returned_membership_path_utf8_bytes).toBeLessThanOrEqual(MAX_COMMUNITY_RESPONSE_MEMBER_UTF8_BYTES);
    expect(response.members_truncated).toBe(true);
    expect(response.truncated).toBe(true);
  });
});

describe("computeModularity — Newman–Girvan null-model penalty (rc.43 M7)", () => {
  // Two triangles {0,1,2} and {3,4,5}, bridged by edge 2–3.
  function bridgedTriangles() {
    const edges: [number, number][] = [
      [0, 1],
      [1, 2],
      [0, 2],
      [3, 4],
      [4, 5],
      [3, 5],
      [2, 3]
    ];
    const adjacency = new Map<string, Map<string, number>>();
    const degree = new Map<string, number>();
    const nodes: string[] = [];
    for (let n = 0; n < 6; n++) {
      adjacency.set(String(n), new Map());
      degree.set(String(n), 0);
      nodes.push(String(n));
    }
    let totalWeight2m = 0;
    for (const [a, b] of edges) {
      const A = String(a);
      const B = String(b);
      adjacency.get(A)?.set(B, 1);
      adjacency.get(B)?.set(A, 1);
      degree.set(A, (degree.get(A) ?? 0) + 1);
      degree.set(B, (degree.get(B) ?? 0) + 1);
      totalWeight2m += 2;
    }
    return { nodes, adjacency, degree, totalWeight2m };
  }
  const split = new Map([
    ["0", 0],
    ["1", 0],
    ["2", 0],
    ["3", 1],
    ["4", 1],
    ["5", 1]
  ]);
  const allInOne = new Map([
    ["0", 0],
    ["1", 0],
    ["2", 0],
    ["3", 0],
    ["4", 0],
    ["5", 0]
  ]);

  it("scores the natural 2-community split ABOVE a degenerate single community (the inversion the bug caused)", () => {
    const g = bridgedTriangles() as unknown as Parameters<typeof computeModularity>[0];
    const qSplit = computeModularity(g, split);
    const qAll = computeModularity(g, allInOne);
    // Standard Newman–Girvan value for this graph's natural split is 0.3571…
    expect(qSplit).toBeCloseTo(0.3571, 3);
    // Pre-rc.43 the truncated null-model penalty inverted these (split 0.5306 < all-in 0.5816).
    expect(qSplit).toBeGreaterThan(qAll);
    // Q is bounded in [-0.5, 1] for any valid partition.
    expect(qSplit).toBeLessThanOrEqual(1);
    expect(qAll).toBeGreaterThanOrEqual(-0.5);
  });

  it("NEGATIVE control — a single community over a fully-connected graph has Q ≈ 0 (in − tot²/2m cancels)", () => {
    // Triangle {0,1,2}, all one community: in=6/2m, (tot/2m)²·1 → Q = 1 - 1 = 0.
    const adjacency = new Map<string, Map<string, number>>();
    const degree = new Map<string, number>();
    for (let n = 0; n < 3; n++) {
      adjacency.set(String(n), new Map());
      degree.set(String(n), 2);
    }
    for (const [a, b] of [
      ["0", "1"],
      ["1", "2"],
      ["0", "2"]
    ]) {
      adjacency.get(a)?.set(b, 1);
      adjacency.get(b)?.set(a, 1);
    }
    const g = { nodes: ["0", "1", "2"], adjacency, degree, totalWeight2m: 6 } as unknown as Parameters<
      typeof computeModularity
    >[0];
    const q = computeModularity(
      g,
      new Map([
        ["0", 0],
        ["1", 0],
        ["2", 0]
      ])
    );
    expect(q).toBeCloseTo(0, 6);
  });
});
