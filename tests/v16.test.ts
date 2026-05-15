import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findPath, listNotes, openInUi } from "../src/tools/index.js";
import { Vault } from "../src/vault.js";

let root: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mcp-v16-"));
  // Linear chain: A → B → C → D
  await fs.writeFile(path.join(root, "A.md"), "Linear: [[B]]\n");
  await fs.writeFile(path.join(root, "B.md"), "[[C]]\n");
  await fs.writeFile(path.join(root, "C.md"), "[[D]] and ![[Embed Target]]\n");
  await fs.writeFile(path.join(root, "D.md"), "endpoint\n");
  // Disconnected
  await fs.writeFile(path.join(root, "Island.md"), "no links here\n");
  // Branching: Hub → {X, Y, Z}; X → Final, Y → Final, Z → Dead
  await fs.writeFile(path.join(root, "Hub.md"), "[[X]] [[Y]] [[Z]]\n");
  await fs.writeFile(path.join(root, "X.md"), "[[Final]]\n");
  await fs.writeFile(path.join(root, "Y.md"), "[[Final]]\n");
  await fs.writeFile(path.join(root, "Z.md"), "[[Dead]]\n");
  await fs.writeFile(path.join(root, "Final.md"), "destination\n");
  await fs.writeFile(path.join(root, "Dead.md"), "no further\n");
  await fs.writeFile(path.join(root, "Embed Target.md"), "embedded\n");

  // Allowlist test scaffolding.
  await fs.mkdir(path.join(root, "Public"), { recursive: true });
  await fs.mkdir(path.join(root, "Private"), { recursive: true });
  await fs.writeFile(path.join(root, "Public", "p1.md"), "public\n");
  await fs.writeFile(path.join(root, "Private", "secret.md"), "secret\n");
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("findPath (v1.6 multi-hop graph traversal)", () => {
  it("finds the shortest linear path A → B → C → D", async () => {
    const v = new Vault(root);
    const out = await findPath(v, { from: "A.md", to: "D.md" });
    expect(out.found).toBe(true);
    expect(out.hops).toBe(3);
    expect(out.path.map((s) => s.path)).toEqual(["A.md", "B.md", "C.md", "D.md"]);
    // Each non-source step has a `via` recording the wikilink that was traversed.
    expect(out.path[1]?.via).toBe("B");
    expect(out.path[2]?.via).toBe("C");
    expect(out.path[3]?.via).toBe("D");
  });

  it("returns hops=0 + 1-step path when from == to", async () => {
    const v = new Vault(root);
    const out = await findPath(v, { from: "A.md", to: "A.md" });
    expect(out.found).toBe(true);
    expect(out.hops).toBe(0);
    expect(out.path.length).toBe(1);
    expect(out.path[0]?.path).toBe("A.md");
  });

  it("returns found=false when no path exists within max_depth", async () => {
    const v = new Vault(root);
    const out = await findPath(v, { from: "A.md", to: "Island.md" });
    expect(out.found).toBe(false);
    expect(out.hops).toBe(-1);
    expect(out.path).toEqual([]);
  });

  it("returns found=false when path exists but exceeds max_depth", async () => {
    const v = new Vault(root);
    // A → B → C → D is 3 hops; max_depth=2 should fail.
    const out = await findPath(v, { from: "A.md", to: "D.md", max_depth: 2 });
    expect(out.found).toBe(false);
  });

  it("include_alternatives surfaces same-length sibling paths (Hub→Final via X or Y)", async () => {
    const v = new Vault(root);
    const out = await findPath(v, { from: "Hub.md", to: "Final.md", include_alternatives: true });
    expect(out.found).toBe(true);
    expect(out.hops).toBe(2);
    expect(out.alternatives).toBeTruthy();
    // Both Hub→X→Final and Hub→Y→Final exist at the same length.
    const altMidpoints = (out.alternatives ?? []).map((alt) => alt[1]?.path);
    expect(altMidpoints).toContain("X.md");
    expect(altMidpoints).toContain("Y.md");
  });

  it("follow_embeds=true (default) traverses ![[embeds]] like wikilinks", async () => {
    const v = new Vault(root);
    // A → B → C → ![[Embed Target]]. Reachable only through embed.
    const out = await findPath(v, { from: "A.md", to: "Embed Target.md" });
    expect(out.found).toBe(true);
    expect(out.path.map((s) => s.path)).toContain("Embed Target.md");
  });

  it("follow_embeds=false skips embeds — Embed Target unreachable", async () => {
    const v = new Vault(root);
    const out = await findPath(v, { from: "A.md", to: "Embed Target.md", follow_embeds: false });
    expect(out.found).toBe(false);
  });

  it("supports title-based source/destination", async () => {
    const v = new Vault(root);
    const out = await findPath(v, { from_title: "A", to_title: "D" });
    expect(out.found).toBe(true);
    expect(out.hops).toBe(3);
  });
});

describe("openInUi (v1.6)", () => {
  it("emits an obsidian:// URI with vault + file params", async () => {
    const v = new Vault(root);
    const out = await openInUi(v, { path: "A.md" });
    expect(out.uri.startsWith("obsidian://open?")).toBe(true);
    expect(out.uri).toContain(`vault=${encodeURIComponent(path.basename(root))}`);
    expect(out.uri).toContain("file=A");
    expect(out.path).toBe("A.md");
    expect(out.title).toBe("A");
  });

  it("appends &newpane=true when new_pane=true", async () => {
    const v = new Vault(root);
    const out = await openInUi(v, { path: "A.md", new_pane: true });
    expect(out.uri).toContain("newpane=true");
  });

  it("strips .md from the file= parameter (Obsidian's expected form)", async () => {
    const v = new Vault(root);
    const out = await openInUi(v, { path: "A.md" });
    expect(out.uri).not.toContain("file=A.md");
    expect(out.uri).toContain("file=A");
  });
});

describe("Vault.readPaths (v1.6 strict allowlist)", () => {
  it("limits visibility to paths matching one of the allow-globs", async () => {
    const v = new Vault(root, { readPaths: ["Public/**"] });
    await v.ensureExists();
    const out = await listNotes(v, {});
    expect(out.every((n) => n.path.startsWith("Public/"))).toBe(true);
    expect(out.some((n) => n.path === "Public/p1.md")).toBe(true);
    // Anything outside Public/** is invisible.
    expect(out.every((n) => !n.path.startsWith("Private/"))).toBe(true);
    expect(out.every((n) => n.path !== "A.md")).toBe(true);
  });

  it("readPaths AND excludeGlobs combine — must match allow AND not match exclude", async () => {
    const v = new Vault(root, {
      readPaths: ["Public/**", "Private/**"],
      excludeGlobs: ["Private/**"]
    });
    await v.ensureExists();
    const out = await listNotes(v, {});
    expect(out.some((n) => n.path === "Public/p1.md")).toBe(true);
    expect(out.every((n) => !n.path.startsWith("Private/"))).toBe(true);
  });

  it("when readPaths is empty, behaviour matches v1.5 (no allowlist filter)", async () => {
    const v = new Vault(root);
    await v.ensureExists();
    const out = await listNotes(v, { limit: 200 });
    // All seeded files visible.
    expect(out.some((n) => n.path === "A.md")).toBe(true);
    expect(out.some((n) => n.path === "Public/p1.md")).toBe(true);
    expect(out.some((n) => n.path === "Private/secret.md")).toBe(true);
  });
});
