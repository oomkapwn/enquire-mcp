import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Vault } from "../src/vault.js";
import {
  listNotes,
  readNote,
  resolveWikilink,
  searchText,
  getRecentEdits,
  getBacklinks
} from "../src/tools.js";

let root: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mcp-test-"));
  await fs.mkdir(path.join(root, "subfolder"), { recursive: true });
  await fs.writeFile(
    path.join(root, "Alpha.md"),
    "---\ntags: [planning]\n---\n\nAlpha note with #idea tag (no outbound links here).\n"
  );
  await fs.writeFile(
    path.join(root, "Beta.md"),
    "---\ntitle: Beta\ntags:\n  - reference\n---\n\nBeta note. Mentions search-target-phrase here.\n"
  );
  await fs.writeFile(
    path.join(root, "subfolder", "Gamma.md"),
    "---\ntags: [idea]\n---\n\nGamma in subfolder, links to [[Alpha|the first one]] and embeds ![[Beta]].\n"
  );
  // Touch files with distinct mtimes (Beta = newest).
  const now = Date.now();
  await fs.utimes(path.join(root, "Alpha.md"), new Date(now - 60_000), new Date(now - 60_000));
  await fs.utimes(path.join(root, "subfolder", "Gamma.md"), new Date(now - 30_000), new Date(now - 30_000));
  await fs.utimes(path.join(root, "Beta.md"), new Date(now), new Date(now));
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("listNotes", () => {
  it("lists every markdown file by default", async () => {
    const v = new Vault(root);
    const out = await listNotes(v, {});
    expect(out.map(n => n.title).sort()).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  it("filters by tag", async () => {
    const v = new Vault(root);
    const out = await listNotes(v, { tag: "idea" });
    expect(out.map(n => n.title).sort()).toEqual(["Alpha", "Gamma"]);
  });

  it("filters by folder", async () => {
    const v = new Vault(root);
    const out = await listNotes(v, { folder: "subfolder" });
    expect(out.map(n => n.title)).toEqual(["Gamma"]);
  });

  it("respects limit", async () => {
    const v = new Vault(root);
    const out = await listNotes(v, { limit: 1 });
    expect(out.length).toBe(1);
  });
});

describe("readNote", () => {
  it("reads by title", async () => {
    const v = new Vault(root);
    const out = await readNote(v, { title: "Beta" });
    expect(out.title).toBe("Beta");
    expect(out.frontmatter.title).toBe("Beta");
    expect(out.tags).toContain("reference");
  });

  it("reads by path", async () => {
    const v = new Vault(root);
    const out = await readNote(v, { path: "subfolder/Gamma.md" });
    expect(out.title).toBe("Gamma");
    expect(out.wikilinks[0].target).toBe("Alpha");
    expect(out.wikilinks[0].alias).toBe("the first one");
  });

  it("rejects path traversal", async () => {
    const v = new Vault(root);
    await expect(readNote(v, { path: "../etc/passwd" })).rejects.toThrow(/escapes vault root/);
  });
});

describe("resolveWikilink", () => {
  it("resolves a basic target", async () => {
    const v = new Vault(root);
    const out = await resolveWikilink(v, { wikilink: "Beta" });
    expect(out.found).toBe(true);
    expect(out.path).toBe("Beta.md");
    expect(out.content).toContain("search-target-phrase");
  });

  it("returns metadata for sections + aliases", async () => {
    const v = new Vault(root);
    const out = await resolveWikilink(v, { wikilink: "Alpha#Heading|alt" });
    expect(out.section).toBe("Heading");
    expect(out.alias).toBe("alt");
    expect(out.path).toBe("Alpha.md");
  });

  it("reports not found", async () => {
    const v = new Vault(root);
    const out = await resolveWikilink(v, { wikilink: "Nonexistent" });
    expect(out.found).toBe(false);
    expect(out.path).toBeNull();
  });

  it("can omit content", async () => {
    const v = new Vault(root);
    const out = await resolveWikilink(v, { wikilink: "Beta", include_content: false });
    expect(out.content).toBeNull();
    expect(out.found).toBe(true);
  });

  it("resolves relative paths from from_note", async () => {
    const v = new Vault(root);
    const out = await resolveWikilink(v, {
      wikilink: "../Beta",
      from_note: "subfolder/Gamma.md"
    });
    expect(out.found).toBe(true);
    expect(out.path).toBe("Beta.md");
  });
});

describe("searchText", () => {
  it("finds substring matches with snippets", async () => {
    const v = new Vault(root);
    const out = await searchText(v, { query: "search-target-phrase" });
    expect(out.length).toBe(1);
    expect(out[0].path).toBe("Beta.md");
    expect(out[0].snippet).toContain("search-target-phrase");
  });

  it("is case-insensitive", async () => {
    const v = new Vault(root);
    const out = await searchText(v, { query: "ALPHA NOTE" });
    expect(out.length).toBe(1);
    expect(out[0].path).toBe("Alpha.md");
  });

  it("respects folder filter", async () => {
    const v = new Vault(root);
    const out = await searchText(v, { query: "links", folder: "subfolder" });
    expect(out.length).toBe(1);
    expect(out[0].path.startsWith("subfolder/")).toBe(true);
  });
});

describe("getRecentEdits", () => {
  it("returns notes newest-first", async () => {
    const v = new Vault(root);
    const out = await getRecentEdits(v, {});
    expect(out[0].title).toBe("Beta");
    expect(out[1].title).toBe("Gamma");
    expect(out[2].title).toBe("Alpha");
  });

  it("filters by since_minutes", async () => {
    const v = new Vault(root);
    const out = await getRecentEdits(v, { since_minutes: 1 });
    expect(out.map(n => n.title).sort()).toEqual(["Beta", "Gamma"]);
  });
});

describe("getBacklinks", () => {
  it("finds notes that wikilink the target", async () => {
    const v = new Vault(root);
    const out = await getBacklinks(v, { title: "Alpha" });
    expect(out.map(h => h.title)).toEqual(["Gamma"]);
    expect(out[0].count).toBe(1);
    expect(out[0].link_kind).toBe("wikilink");
  });

  it("finds embed-style backlinks too", async () => {
    const v = new Vault(root);
    const out = await getBacklinks(v, { title: "Beta" });
    expect(out.map(h => h.title)).toEqual(["Gamma"]);
    expect(out[0].link_kind).toBe("embed");
  });

  it("excludes embeds when include_embeds=false", async () => {
    const v = new Vault(root);
    const out = await getBacklinks(v, { title: "Beta", include_embeds: false });
    expect(out).toEqual([]);
  });

  it("returns snippets around the link", async () => {
    const v = new Vault(root);
    const out = await getBacklinks(v, { title: "Alpha" });
    expect(out[0].snippets[0]).toMatch(/Alpha\|the first one/);
  });

  it("does not list the target itself", async () => {
    const v = new Vault(root);
    const out = await getBacklinks(v, { title: "Beta" });
    expect(out.every(h => h.title !== "Beta")).toBe(true);
  });
});

describe("readNote — embeds in output", () => {
  it("surfaces embeds alongside wikilinks", async () => {
    const v = new Vault(root);
    const out = await readNote(v, { path: "subfolder/Gamma.md" });
    expect(out.embeds.map(e => e.target)).toEqual(["Beta"]);
    expect(out.wikilinks.map(w => w.target)).toEqual(["Alpha"]);
  });
});
