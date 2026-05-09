// v3.2.0 — Obsidian Bases (.base) support. Tests the YAML parser, the
// listBases / readBase / queryBase pipeline, and the filter DSL subset
// against synthetic vaults. No live Obsidian needed.

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listBases, parseBase, queryBase, readBase } from "../src/bases.js";
import { Vault } from "../src/vault.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-bases-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("parseBase — YAML schema", () => {
  it("accepts the canonical example from Obsidian docs", async () => {
    const src = `
filters:
  or:
    - taggedWith(file.file, "tag")
    - and:
        - taggedWith(file.file, "book")
        - linksTo(file.file, "Textbook")
formulas:
  formatted_price: 'concat(price, " dollars")'
  ppu: "price / age"
properties:
  status:
    displayName: Status
views:
  - type: table
    name: "My table"
    filters:
      and:
        - 'status != "done"'
  - type: map
    name: "Example map"
    filters: "has_coords == true"
    lat: lat
    long: long
`;
    const parsed = await parseBase(src);
    expect(parsed.filters).toBeDefined();
    expect(parsed.formulas?.formatted_price).toBe('concat(price, " dollars")');
    expect(parsed.properties?.status?.displayName).toBe("Status");
    expect(parsed.views).toHaveLength(2);
    expect(parsed.views?.[0]?.type).toBe("table");
    expect(parsed.views?.[1]?.type).toBe("map");
  });

  it("accepts a minimal base (just one view, no filters)", async () => {
    const src = `
views:
  - type: table
    name: "All notes"
`;
    const parsed = await parseBase(src);
    expect(parsed.views).toHaveLength(1);
    expect(parsed.filters).toBeUndefined();
  });

  it("accepts an empty base (no fields at all)", async () => {
    const parsed = await parseBase("");
    expect(parsed.views ?? []).toEqual([]);
  });

  it("recursively validates and/or/not combinators", async () => {
    const src = `
filters:
  and:
    - 'status == "open"'
    - or:
        - 'priority == "high"'
        - not: 'tag == "ignored"'
`;
    const parsed = await parseBase(src);
    expect(parsed.filters).toBeDefined();
  });
});

async function makeBaseVault(): Promise<{ root: string; vault: Vault }> {
  const root = await fs.mkdtemp(path.join(dir, "vault-"));
  await fs.writeFile(path.join(root, "open.md"), "---\nstatus: open\npriority: high\ntags: [book]\n---\nopen book");
  await fs.writeFile(path.join(root, "done.md"), "---\nstatus: done\npriority: low\ntags: [book]\n---\nfinished book");
  await fs.writeFile(path.join(root, "untagged.md"), "---\nstatus: open\n---\nno tags here");
  await fs.mkdir(path.join(root, "Notes"), { recursive: true });
  await fs.writeFile(
    path.join(root, "Notes", "inline.md"),
    "## Heading\n\nSome content with #inline tags here.\n#book\n"
  );
  const vault = new Vault(root);
  await vault.ensureExists();
  return { root, vault };
}

describe("listBases", () => {
  it("returns empty when vault has no .base files", async () => {
    const { vault } = await makeBaseVault();
    const out = await listBases(vault, {});
    expect(out).toEqual([]);
  });

  it("returns base file metadata + view names", async () => {
    const { root, vault } = await makeBaseVault();
    await fs.writeFile(
      path.join(root, "books.base"),
      `views:
  - type: table
    name: "All books"
    filters: 'taggedWith(file.file, "book")'
`
    );
    const out = await listBases(vault, {});
    expect(out).toHaveLength(1);
    expect(out[0]?.name).toBe("books");
    expect(out[0]?.view_count).toBe(1);
    expect(out[0]?.view_names).toEqual(["All books"]);
    expect(out[0]?.size_bytes).toBeGreaterThan(0);
  });

  it("survives malformed .base files (size=0 counts, no crash)", async () => {
    const { root, vault } = await makeBaseVault();
    await fs.writeFile(path.join(root, "broken.base"), "this is\n  not: valid\n yaml: [");
    const out = await listBases(vault, {});
    expect(out).toHaveLength(1);
    expect(out[0]?.name).toBe("broken");
    expect(out[0]?.view_count).toBe(0);
    expect(out[0]?.view_names).toEqual([]);
  });
});

describe("readBase", () => {
  it("returns parsed structure with normalized view names", async () => {
    const { root, vault } = await makeBaseVault();
    await fs.writeFile(
      path.join(root, "tasks.base"),
      `filters: 'status != "done"'
views:
  - type: table
    name: "Open tasks"
    filters: 'priority == "high"'
  - type: cards
`
    );
    const out = await readBase(vault, { path: "tasks.base" });
    expect(out.path).toBe("tasks.base");
    expect(out.name).toBe("tasks");
    expect(out.filters).toBe('status != "done"');
    expect(out.views).toHaveLength(2);
    expect(out.views[0]?.name).toBe("Open tasks");
    expect(out.views[1]?.name).toBeNull(); // unnamed view
  });

  it("rejects path outside the vault (privacy boundary)", async () => {
    const { vault } = await makeBaseVault();
    await expect(readBase(vault, { path: "../etc/passwd" })).rejects.toThrow();
  });
});

describe("queryBase — DSL execution", () => {
  it('filters by tag equality (`tag == "book"`)', async () => {
    const { root, vault } = await makeBaseVault();
    await fs.writeFile(
      path.join(root, "q.base"),
      `filters: 'tag == "book"'
views:
  - type: table
`
    );
    const out = await queryBase(vault, { path: "q.base" });
    // open.md + done.md (frontmatter tag) AND Notes/inline.md (inline #book)
    expect(out.matches.map((m) => m.path).sort()).toEqual(["Notes/inline.md", "done.md", "open.md"]);
    expect(out.unevaluated_predicates).toEqual([]);
  });

  it("filters by taggedWith(file.file, ...)", async () => {
    const { root, vault } = await makeBaseVault();
    await fs.writeFile(
      path.join(root, "q.base"),
      `filters: 'taggedWith(file.file, "book")'
views:
  - type: table
`
    );
    const out = await queryBase(vault, { path: "q.base" });
    expect(out.matches.map((m) => m.path).sort()).toContain("open.md");
    expect(out.matches.map((m) => m.path).sort()).toContain("done.md");
  });

  it("filters by frontmatter equality", async () => {
    const { root, vault } = await makeBaseVault();
    await fs.writeFile(
      path.join(root, "q.base"),
      `filters: 'status == "open"'
views:
  - type: table
`
    );
    const out = await queryBase(vault, { path: "q.base" });
    const paths = out.matches.map((m) => m.path).sort();
    expect(paths).toContain("open.md");
    expect(paths).toContain("untagged.md");
    expect(paths).not.toContain("done.md");
  });

  it("filters via and-of-clauses", async () => {
    const { root, vault } = await makeBaseVault();
    await fs.writeFile(
      path.join(root, "q.base"),
      `filters:
  and:
    - 'status == "open"'
    - 'priority == "high"'
views:
  - type: table
`
    );
    const out = await queryBase(vault, { path: "q.base" });
    expect(out.matches).toHaveLength(1);
    expect(out.matches[0]?.path).toBe("open.md");
  });

  it("filters via or-of-clauses", async () => {
    const { root, vault } = await makeBaseVault();
    await fs.writeFile(
      path.join(root, "q.base"),
      `filters:
  or:
    - 'priority == "high"'
    - 'priority == "low"'
views:
  - type: table
`
    );
    const out = await queryBase(vault, { path: "q.base" });
    const paths = out.matches.map((m) => m.path).sort();
    expect(paths).toEqual(["done.md", "open.md"]);
  });

  it("filters via not", async () => {
    const { root, vault } = await makeBaseVault();
    await fs.writeFile(
      path.join(root, "q.base"),
      `filters:
  not: 'status == "done"'
views:
  - type: table
`
    );
    const out = await queryBase(vault, { path: "q.base" });
    const paths = out.matches.map((m) => m.path).sort();
    expect(paths).toContain("open.md");
    expect(paths).toContain("untagged.md");
    expect(paths).not.toContain("done.md");
  });

  it("filters via path predicates", async () => {
    const { root, vault } = await makeBaseVault();
    await fs.writeFile(
      path.join(root, "q.base"),
      `filters: 'path startsWith "Notes/"'
views:
  - type: table
`
    );
    const out = await queryBase(vault, { path: "q.base" });
    expect(out.matches).toHaveLength(1);
    expect(out.matches[0]?.path).toBe("Notes/inline.md");
  });

  it("merges global filter AND view filter when view is specified", async () => {
    const { root, vault } = await makeBaseVault();
    await fs.writeFile(
      path.join(root, "q.base"),
      `filters: 'tag == "book"'
views:
  - type: table
    name: "Open books"
    filters: 'status == "open"'
  - type: table
    name: "All books"
`
    );
    const openBooks = await queryBase(vault, { path: "q.base", view: "Open books" });
    expect(openBooks.matches).toHaveLength(1);
    expect(openBooks.matches[0]?.path).toBe("open.md");
    expect(openBooks.view).toBe("Open books");

    const allBooks = await queryBase(vault, { path: "q.base", view: "All books" });
    // open.md + done.md (frontmatter) + Notes/inline.md (inline #book)
    expect(allBooks.matches).toHaveLength(3);
    expect(allBooks.view).toBe("All books");
  });

  it("collects unevaluated predicates without crashing (e.g. linksTo)", async () => {
    const { root, vault } = await makeBaseVault();
    await fs.writeFile(
      path.join(root, "q.base"),
      `filters:
  and:
    - 'tag == "book"'
    - 'linksTo(file.file, "Textbook")'
views:
  - type: table
`
    );
    const out = await queryBase(vault, { path: "q.base" });
    expect(out.unevaluated_predicates).toContain('linksTo(file.file, "Textbook")');
    // linksTo treated as `true` (most permissive) → matches both books.
    expect(out.matches.length).toBeGreaterThanOrEqual(2);
  });

  it("collects inline #tags from body for taggedWith() matching", async () => {
    const { root, vault } = await makeBaseVault();
    await fs.writeFile(
      path.join(root, "q.base"),
      `filters: 'taggedWith(file.file, "inline")'
views:
  - type: table
`
    );
    const out = await queryBase(vault, { path: "q.base" });
    expect(out.matches.map((m) => m.path)).toEqual(["Notes/inline.md"]);
  });

  it("throws on unknown view name", async () => {
    const { root, vault } = await makeBaseVault();
    await fs.writeFile(
      path.join(root, "q.base"),
      `views:
  - type: table
    name: "Real view"
`
    );
    await expect(queryBase(vault, { path: "q.base", view: "Ghost view" })).rejects.toThrow(/view not found/);
  });

  it("respects limit", async () => {
    const { root, vault } = await makeBaseVault();
    await fs.writeFile(
      path.join(root, "q.base"),
      `views:
  - type: table
`
    );
    const out = await queryBase(vault, { path: "q.base", limit: 2 });
    expect(out.matches.length).toBeLessThanOrEqual(2);
  });
});
