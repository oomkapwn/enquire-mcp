import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listCanvases, readCanvas } from "../src/tools.js";
import { Vault } from "../src/vault.js";

let root: string;

const apolloCanvas = {
  nodes: [
    { id: "n1", type: "text", x: 0, y: 0, width: 200, height: 80, text: "Apollo Project hub", color: "1" },
    {
      id: "n2",
      type: "file",
      x: 250,
      y: 0,
      width: 240,
      height: 100,
      file: "Notes/Apollo.md"
    },
    {
      id: "n3",
      type: "file",
      x: 250,
      y: 130,
      width: 240,
      height: 100,
      file: "Notes/Missing.md"
    },
    { id: "n4", type: "link", x: 600, y: 0, width: 240, height: 80, url: "https://arxiv.org/abs/2401.12345" },
    { id: "n5", type: "group", x: -20, y: -20, width: 800, height: 200, label: "Apollo cluster" },
    { id: "n6", type: "weird-future-type", x: 0, y: 300, width: 100, height: 50 }
  ],
  edges: [
    { id: "e1", fromNode: "n1", fromSide: "right", toNode: "n2", toSide: "left", label: "primary" },
    { id: "e2", fromNode: "n2", toNode: "n3" },
    { id: "e3", fromNode: "n2", toNode: "n4", color: "5" }
  ]
};

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mcp-canvas-"));
  await fs.mkdir(path.join(root, "Notes"), { recursive: true });
  await fs.mkdir(path.join(root, "Boards"), { recursive: true });

  // Markdown that the canvas's file: nodes will reference (or not).
  await fs.writeFile(path.join(root, "Notes", "Apollo.md"), "Apollo body\n");
  // Notes/Missing.md is intentionally absent → broken_file_refs entry.

  // Canvas — well-formed JSON.
  await fs.writeFile(path.join(root, "Boards", "Apollo Board.canvas"), JSON.stringify(apolloCanvas, null, 2));

  // Canvas — empty (zero nodes / edges).
  await fs.writeFile(path.join(root, "Boards", "Empty.canvas"), JSON.stringify({ nodes: [], edges: [] }));

  // Canvas — malformed JSON.
  await fs.writeFile(path.join(root, "Boards", "Broken.canvas"), "{ this is not valid json");
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("listCanvases (v1.7)", () => {
  it("lists every .canvas file with node/edge counts", async () => {
    const v = new Vault(root);
    const out = await listCanvases(v, {});
    expect(out.length).toBe(3);
    const paths = out.map((c) => c.path);
    expect(paths).toContain("Boards/Apollo Board.canvas");
    expect(paths).toContain("Boards/Empty.canvas");
    expect(paths).toContain("Boards/Broken.canvas");

    const apollo = out.find((c) => c.path === "Boards/Apollo Board.canvas");
    expect(apollo?.node_count).toBe(6);
    expect(apollo?.edge_count).toBe(3);
    expect(apollo?.name).toBe("Apollo Board");

    const empty = out.find((c) => c.path === "Boards/Empty.canvas");
    expect(empty?.node_count).toBe(0);
    expect(empty?.edge_count).toBe(0);

    // Malformed canvas appears with 0 counts — must NOT poison the listing.
    const broken = out.find((c) => c.path === "Boards/Broken.canvas");
    expect(broken).toBeTruthy();
    expect(broken?.node_count).toBe(0);
  });

  it("respects --read-paths allowlist", async () => {
    const v = new Vault(root, { readPaths: ["Notes/**"] });
    await v.ensureExists();
    const out = await listCanvases(v, {});
    // Boards/* canvases excluded by allowlist; nothing left.
    expect(out.length).toBe(0);
  });

  it("respects folder filter", async () => {
    const v = new Vault(root);
    const inBoards = await listCanvases(v, { folder: "Boards" });
    expect(inBoards.length).toBe(3);
    const inNotes = await listCanvases(v, { folder: "Notes" });
    expect(inNotes.length).toBe(0);
  });
});

describe("readCanvas (v1.7)", () => {
  it("parses nodes by kind with the right shape", async () => {
    const v = new Vault(root);
    const c = await readCanvas(v, { path: "Boards/Apollo Board.canvas" });
    expect(c.path).toBe("Boards/Apollo Board.canvas");
    expect(c.name).toBe("Apollo Board");
    expect(c.summary).toEqual({ text: 1, file: 2, link: 1, group: 1, unknown: 1 });

    const text = c.nodes.find((n) => n.kind === "text");
    expect(text?.kind === "text" ? text.text : "").toBe("Apollo Project hub");

    const file = c.nodes.find((n) => n.kind === "file" && n.id === "n2");
    expect(file?.kind === "file" ? file.file : "").toBe("Notes/Apollo.md");
    expect(file?.kind === "file" ? file.file_resolved : "x").toBe("Notes/Apollo.md");

    const link = c.nodes.find((n) => n.kind === "link");
    expect(link?.kind === "link" ? link.url : "").toBe("https://arxiv.org/abs/2401.12345");

    const group = c.nodes.find((n) => n.kind === "group");
    expect(group?.kind === "group" ? group.label : "").toBe("Apollo cluster");

    // weird-future-type is preserved as kind: "unknown" with raw_type set —
    // forward-compat for new Obsidian canvas node types.
    const unknown = c.nodes.find((n) => n.kind === "unknown");
    expect(unknown?.kind === "unknown" ? unknown.raw_type : "").toBe("weird-future-type");
  });

  it("surfaces broken file refs", async () => {
    const v = new Vault(root);
    const c = await readCanvas(v, { path: "Boards/Apollo Board.canvas" });
    expect(c.broken_file_refs).toContain("Notes/Missing.md");
    // The broken-ref node still appears in nodes[] with file_resolved=null.
    const missing = c.nodes.find((n) => n.kind === "file" && n.id === "n3");
    expect(missing?.kind === "file" ? missing.file_resolved : "x").toBeNull();
  });

  it("preserves edge metadata (sides, label, color)", async () => {
    const v = new Vault(root);
    const c = await readCanvas(v, { path: "Boards/Apollo Board.canvas" });
    expect(c.edges.length).toBe(3);
    const e1 = c.edges.find((e) => e.id === "e1");
    expect(e1?.from_side).toBe("right");
    expect(e1?.to_side).toBe("left");
    expect(e1?.label).toBe("primary");
    const e3 = c.edges.find((e) => e.id === "e3");
    expect(e3?.color).toBe("5");
  });

  it("auto-appends .canvas when missing", async () => {
    const v = new Vault(root);
    const c = await readCanvas(v, { path: "Boards/Apollo Board" });
    expect(c.path).toBe("Boards/Apollo Board.canvas");
  });

  it("rejects malformed JSON with a clear error", async () => {
    const v = new Vault(root);
    await expect(readCanvas(v, { path: "Boards/Broken.canvas" })).rejects.toThrow(/not valid JSON/);
  });

  it("rejects path traversal", async () => {
    const v = new Vault(root);
    await expect(readCanvas(v, { path: "../outside.canvas" })).rejects.toThrow();
  });

  it("handles an empty canvas (zero nodes/edges)", async () => {
    const v = new Vault(root);
    const c = await readCanvas(v, { path: "Boards/Empty.canvas" });
    expect(c.nodes).toEqual([]);
    expect(c.edges).toEqual([]);
    expect(c.summary).toEqual({ text: 0, file: 0, link: 0, group: 0, unknown: 0 });
    expect(c.broken_file_refs).toEqual([]);
  });
});
