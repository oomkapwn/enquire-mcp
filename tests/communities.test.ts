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
import { buildWikilinkGraph, detectCommunities } from "../src/communities.js";
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
