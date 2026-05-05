import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getBacklinks,
  getOutboundLinks,
  getRecentEdits,
  getUnresolvedWikilinks,
  listNotes,
  readNote,
  resolveWikilink,
  searchText
} from "../src/tools.js";
import { Vault } from "../src/vault.js";

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
    expect(out.map((n) => n.title).sort()).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  it("filters by tag", async () => {
    const v = new Vault(root);
    const out = await listNotes(v, { tag: "idea" });
    expect(out.map((n) => n.title).sort()).toEqual(["Alpha", "Gamma"]);
  });

  it("filters by folder", async () => {
    const v = new Vault(root);
    const out = await listNotes(v, { folder: "subfolder" });
    expect(out.map((n) => n.title)).toEqual(["Gamma"]);
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

  it("accepts path without .md extension (audit P2-3)", async () => {
    const v = new Vault(root);
    const out = await readNote(v, { path: "Alpha" });
    expect(out.title).toBe("Alpha");
    expect(out.path).toBe("Alpha.md");
  });

  it("accepts subfolder path without .md extension", async () => {
    const v = new Vault(root);
    const out = await readNote(v, { path: "subfolder/Gamma" });
    expect(out.title).toBe("Gamma");
    expect(out.path).toBe(path.join("subfolder", "Gamma.md"));
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
  it("finds single-token matches with snippets", async () => {
    const v = new Vault(root);
    const result = await searchText(v, { query: "search-target-phrase" });
    expect(result.matches.length).toBe(1);
    expect(result.matches[0].path).toBe("Beta.md");
    expect(result.matches[0].snippet).toContain("search-target-phrase");
    expect(result.mode).toBe("all");
    expect(result.scanned_notes).toBeGreaterThan(0);
  });

  it("is case-insensitive", async () => {
    const v = new Vault(root);
    const result = await searchText(v, { query: "ALPHA NOTE" });
    expect(result.matches.length).toBe(1);
    expect(result.matches[0].path).toBe("Alpha.md");
  });

  it("respects folder filter", async () => {
    const v = new Vault(root);
    const result = await searchText(v, { query: "links", folder: "subfolder" });
    expect(result.matches.length).toBe(1);
    expect(result.matches[0].path.startsWith("subfolder/")).toBe(true);
  });

  it("default mode `all` requires every token to match (audit v0.9 P1)", async () => {
    const v = new Vault(root);
    // "alpha note" — both words appear in Alpha.md (frontmatter title is
    // "Alpha Note" + body has "Alpha note body."). With AND-tokenizer that
    // matches; under the old phrase mode it would also match. Confirm that
    // a query where one word matches one note + the other word matches a
    // disjoint note — under "all" mode no single note has BOTH, so 0 hits
    // is the correct answer (the previous `>=0` assertion was meaningless).
    const disjoint = await searchText(v, { query: "alpha xyzzy-nonexistent" });
    expect(disjoint.matches.length).toBe(0);
    expect(disjoint.mode).toBe("all");

    // a query where both words appear in the SAME note — should match.
    const colocated = await searchText(v, { query: "alpha note" });
    expect(colocated.matches.length).toBeGreaterThan(0);
    expect(colocated.matches[0].matched_terms).toContain("alpha");
    expect(colocated.matches[0].matched_terms).toContain("note");
  });

  it("mode=phrase does the old contiguous substring match (v0.9 backward-compat)", async () => {
    const v = new Vault(root);
    // A phrase with internal whitespace — AND mode would match if both words
    // are separately in the file; phrase mode requires the contiguous string.
    const phrase = await searchText(v, { query: "search-target-phrase", mode: "phrase" });
    expect(phrase.mode).toBe("phrase");
    expect(phrase.matches.length).toBe(1);
  });

  it("mode=any matches when at least one token hits (v0.9 OR mode)", async () => {
    const v = new Vault(root);
    const result = await searchText(v, { query: "alpha xyzzy-nonexistent", mode: "any" });
    expect(result.mode).toBe("any");
    expect(result.matches.length).toBeGreaterThan(0); // alpha hits even if xyzzy doesn't
  });

  it("returns scanned_notes count even on zero matches (audit v0.9 Bug #4)", async () => {
    const v = new Vault(root);
    const result = await searchText(v, { query: "definitely-not-in-the-vault-xyzzy-zzz" });
    expect(result.matches).toEqual([]);
    expect(result.scanned_notes).toBeGreaterThan(0);
    expect(result.query).toBe("definitely-not-in-the-vault-xyzzy-zzz");
    expect(result.mode).toBe("all");
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
    expect(out.map((n) => n.title).sort()).toEqual(["Beta", "Gamma"]);
  });
});

describe("getBacklinks", () => {
  it("finds notes that wikilink the target", async () => {
    const v = new Vault(root);
    const out = await getBacklinks(v, { title: "Alpha" });
    expect(out.map((h) => h.title)).toEqual(["Gamma"]);
    expect(out[0].count).toBe(1);
    expect(out[0].link_kind).toBe("wikilink");
  });

  it("finds embed-style backlinks too", async () => {
    const v = new Vault(root);
    const out = await getBacklinks(v, { title: "Beta" });
    expect(out.map((h) => h.title)).toEqual(["Gamma"]);
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
    expect(out.every((h) => h.title !== "Beta")).toBe(true);
  });

  it("resolves a path-form wikilink target", async () => {
    const v = new Vault(root);
    // Add a note that uses a folder-prefixed wikilink to a unique target.
    await fs.writeFile(path.join(root, "PathRef.md"), "Pointer to [[subfolder/Gamma]].\n");
    try {
      const out = await getBacklinks(v, { path: "subfolder/Gamma.md" });
      const titles = out.map((h) => h.title);
      expect(titles).toContain("PathRef");
    } finally {
      await fs.unlink(path.join(root, "PathRef.md")).catch(() => {});
    }
  });
});

describe("readNote — embeds in output", () => {
  it("surfaces embeds alongside wikilinks", async () => {
    const v = new Vault(root);
    const out = await readNote(v, { path: "subfolder/Gamma.md" });
    expect(out.embeds.map((e) => e.target)).toEqual(["Beta"]);
    expect(out.wikilinks.map((w) => w.target)).toEqual(["Alpha"]);
  });
});

describe("getUnresolvedWikilinks", () => {
  it("finds links to non-existent notes", async () => {
    const v = new Vault(root);
    await fs.writeFile(path.join(root, "Broken.md"), "Pointer to [[NonexistentTarget]] and [[AlsoMissing]].");
    try {
      const out = await getUnresolvedWikilinks(v, {});
      const targets = out.filter((u) => u.from_path === "Broken.md").map((u) => u.target);
      expect(targets).toContain("NonexistentTarget");
      expect(targets).toContain("AlsoMissing");
    } finally {
      await fs.unlink(path.join(root, "Broken.md")).catch(() => {});
    }
  });

  it("does NOT include resolved links", async () => {
    const v = new Vault(root);
    const out = await getUnresolvedWikilinks(v, {});
    expect(out.every((u) => u.target !== "Alpha" && u.target !== "Beta")).toBe(true);
  });

  it("respects folder filter", async () => {
    const v = new Vault(root);
    await fs.writeFile(path.join(root, "Broken.md"), "Pointer to [[NoSuchNote]].");
    try {
      const subfolderOut = await getUnresolvedWikilinks(v, { folder: "subfolder" });
      expect(subfolderOut.find((u) => u.from_path === "Broken.md")).toBeUndefined();
    } finally {
      await fs.unlink(path.join(root, "Broken.md")).catch(() => {});
    }
  });

  it("can exclude embeds", async () => {
    const v = new Vault(root);
    await fs.writeFile(path.join(root, "BrokenEmbed.md"), "![[NoSuchEmbed]]");
    try {
      const withEmbeds = await getUnresolvedWikilinks(v, { include_embeds: true });
      expect(withEmbeds.some((u) => u.target === "NoSuchEmbed" && u.kind === "embed")).toBe(true);
      const withoutEmbeds = await getUnresolvedWikilinks(v, { include_embeds: false });
      expect(withoutEmbeds.some((u) => u.target === "NoSuchEmbed")).toBe(false);
    } finally {
      await fs.unlink(path.join(root, "BrokenEmbed.md")).catch(() => {});
    }
  });
});

describe("getOutboundLinks", () => {
  it("lists wikilinks and embeds with resolution status", async () => {
    const v = new Vault(root);
    const out = await getOutboundLinks(v, { path: "subfolder/Gamma.md" });
    expect(out.from_title).toBe("Gamma");
    const targets = out.links.map((l) => l.target).sort();
    expect(targets).toEqual(["Alpha", "Beta"]);
    const alpha = out.links.find((l) => l.target === "Alpha")!;
    expect(alpha.resolved_path).toBe("Alpha.md");
    expect(alpha.kind).toBe("wikilink");
    const beta = out.links.find((l) => l.target === "Beta")!;
    expect(beta.resolved_path).toBe("Beta.md");
    expect(beta.kind).toBe("embed");
  });

  it("can exclude embeds", async () => {
    const v = new Vault(root);
    const out = await getOutboundLinks(v, { path: "subfolder/Gamma.md", include_embeds: false });
    expect(out.links.map((l) => l.target)).toEqual(["Alpha"]);
  });

  it("marks unresolved links with null resolved_path", async () => {
    const v = new Vault(root);
    await fs.writeFile(path.join(root, "Mixed.md"), "Has [[Alpha]] and [[Ghost]].");
    try {
      const out = await getOutboundLinks(v, { path: "Mixed.md" });
      const ghost = out.links.find((l) => l.target === "Ghost")!;
      expect(ghost.resolved_path).toBeNull();
      expect(ghost.resolved_title).toBeNull();
      const alpha = out.links.find((l) => l.target === "Alpha")!;
      expect(alpha.resolved_path).toBe("Alpha.md");
    } finally {
      await fs.unlink(path.join(root, "Mixed.md")).catch(() => {});
    }
  });

  it("can hide unresolved links", async () => {
    const v = new Vault(root);
    await fs.writeFile(path.join(root, "Mixed2.md"), "Has [[Alpha]] and [[Ghost2]].");
    try {
      const out = await getOutboundLinks(v, { path: "Mixed2.md", include_unresolved: false });
      expect(out.links.map((l) => l.target)).toEqual(["Alpha"]);
    } finally {
      await fs.unlink(path.join(root, "Mixed2.md")).catch(() => {});
    }
  });

  it("preserves alias / section / block metadata", async () => {
    const v = new Vault(root);
    await fs.writeFile(path.join(root, "Meta.md"), "Hit [[Alpha#Heading|alt]] and [[Beta^block-id]].");
    try {
      const out = await getOutboundLinks(v, { path: "Meta.md" });
      const alpha = out.links.find((l) => l.target === "Alpha")!;
      expect(alpha.alias).toBe("alt");
      expect(alpha.section).toBe("Heading");
      const beta = out.links.find((l) => l.target === "Beta")!;
      expect(beta.block).toBe("block-id");
    } finally {
      await fs.unlink(path.join(root, "Meta.md")).catch(() => {});
    }
  });
});
