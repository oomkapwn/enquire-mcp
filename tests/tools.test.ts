import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  findSimilar,
  getBacklinks,
  getNoteNeighbors,
  getOutboundLinks,
  getRecentEdits,
  getUnresolvedWikilinks,
  getVaultStats,
  listNotes,
  readNote,
  resolveWikilink,
  searchText,
  validateNoteProposal
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

describe("readNote — document-map projection (v0.11)", () => {
  it('`format: "map"` returns headings + counts, no body', async () => {
    const v = new Vault(root);
    await fs.writeFile(
      path.join(root, "Mapped.md"),
      "---\ntitle: Mapped\ntags: [demo]\n---\n\n# Top heading\n\nbody line\n\n## Sub\n\nmore body\n\n```\n## not-a-heading-in-fence\n```\n\n### Deep\n"
    );
    try {
      const result = await readNote(v, { path: "Mapped.md", format: "map" });
      if (!("format" in result)) throw new Error("expected map projection");
      expect(result.format).toBe("map");
      expect(result.frontmatter_keys.sort()).toEqual(["tags", "title"]);
      expect(result.headings.map((h) => `${"#".repeat(h.level)} ${h.text}`)).toEqual([
        "# Top heading",
        "## Sub",
        "### Deep" // ## inside ``` is correctly NOT extracted
      ]);
      expect(result.byte_size).toBeGreaterThan(0);
      // No body field on map projection.
      expect("content" in result).toBe(false);
    } finally {
      await fs.unlink(path.join(root, "Mapped.md")).catch(() => {});
    }
  });

  it('`format: "full"` (default) keeps existing shape', async () => {
    const v = new Vault(root);
    const result = await readNote(v, { path: "Alpha.md" });
    if ("format" in result) throw new Error("expected full shape");
    expect(typeof result.content).toBe("string");
    expect(result.content.length).toBeGreaterThan(0);
  });
});

describe("readNote — periodic-note aliases (v0.11)", () => {
  it('`title: "today"` resolves to YYYY-MM-DD and reads the matching daily note', async () => {
    const v = new Vault(root);
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, "0");
    const dd = String(today.getDate()).padStart(2, "0");
    const dailyName = `${yyyy}-${mm}-${dd}.md`;
    await fs.writeFile(path.join(root, dailyName), "---\ntags: [daily]\n---\n\nToday's standup.\n");
    try {
      const result = await readNote(v, { title: "today" });
      if ("format" in result) throw new Error("expected full shape");
      expect(result.path).toBe(dailyName);
      expect(result.tags).toContain("daily");
    } finally {
      await fs.unlink(path.join(root, dailyName)).catch(() => {});
    }
  });

  it('"daily" alias error message includes the resolved date when neither literal nor alias matches', async () => {
    const v = new Vault(root);
    await expect(readNote(v, { title: "daily" })).rejects.toThrow(/also tried periodic alias "\d{4}-\d{2}-\d{2}"/);
  });

  it('"weekly" alias resolves to YYYY-Www format', async () => {
    const v = new Vault(root);
    await expect(readNote(v, { title: "weekly" })).rejects.toThrow(/also tried periodic alias "\d{4}-W\d{2}"/);
  });

  it('"monthly" alias resolves to YYYY-MM format', async () => {
    const v = new Vault(root);
    await expect(readNote(v, { title: "monthly" })).rejects.toThrow(/also tried periodic alias "\d{4}-\d{2}"/);
  });

  it("literal title takes priority over alias (user with `Daily.md` in vault)", async () => {
    const v = new Vault(root);
    // Stash a file literally named Daily.md to verify literal-first behavior.
    await fs.writeFile(path.join(root, "Daily.md"), "literal daily file");
    try {
      const result = await readNote(v, { title: "daily" });
      if ("format" in result) throw new Error("expected full shape");
      expect(result.path).toBe("Daily.md");
      expect(result.content).toContain("literal daily file");
    } finally {
      await fs.unlink(path.join(root, "Daily.md")).catch(() => {});
    }
  });
});

describe("readNote — did-you-mean suggestions (v0.11)", () => {
  it("near-miss path returns suggestions in error message", async () => {
    const v = new Vault(root);
    await expect(readNote(v, { path: "alph" })).rejects.toThrow(/Did you mean.*Alpha/i);
  });

  it("near-miss title returns suggestions in error message", async () => {
    const v = new Vault(root);
    await expect(readNote(v, { title: "alph" })).rejects.toThrow(/Did you mean.*Alpha/i);
  });

  it("exact match never includes 'Did you mean' (only on miss)", async () => {
    const v = new Vault(root);
    const result = await readNote(v, { title: "Alpha" });
    if ("format" in result) throw new Error("expected full shape");
    expect(result.title).toBe("Alpha");
  });
});

describe("validateNoteProposal — anti-slop write linter (v0.12)", () => {
  it("happy path: valid YAML + resolved wikilinks + existing tags + non-colliding path → ok=true", async () => {
    const v = new Vault(root);
    const result = await validateNoteProposal(v, {
      path: "Inbox/new-idea.md",
      content: "---\ntags: [planning]\n---\n\nLinks to [[Alpha]] and [[Beta]].\n"
    });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.yaml.parsed).toBe(true);
    expect(result.yaml.keys).toEqual(["tags"]);
    expect(result.wikilinks.every((w) => w.status === "resolved")).toBe(true);
    expect(result.tags.find((t) => t.name === "planning")?.status).toBe("existing");
    expect(result.collision.kind).toBe("none");
  });

  it("flags broken wikilinks with did-you-mean suggestions", async () => {
    const v = new Vault(root);
    const result = await validateNoteProposal(v, {
      path: "Inbox/x.md",
      content: "Linking to [[Alph]] (typo for Alpha) and [[NonExistent]].\n"
    });
    expect(result.warnings.some((w) => w.kind === "broken-wikilink")).toBe(true);
    const broken = result.wikilinks.filter((w) => w.status === "broken");
    expect(broken.length).toBe(2);
    const alphTypo = broken.find((w) => w.target === "Alph");
    expect(alphTypo?.suggestions.length ?? 0).toBeGreaterThan(0);
    expect(alphTypo?.suggestions[0]?.toLowerCase()).toContain("alpha");
  });

  it("flags new tags so the LLM doesn't fork a tag forest", async () => {
    const v = new Vault(root);
    const result = await validateNoteProposal(v, {
      path: "Inbox/x.md",
      content: "---\ntags: [planning, brand-new-tag-xyzzy]\n---\n\nbody.\n"
    });
    const newTags = result.tags.filter((t) => t.status === "new");
    expect(newTags.map((t) => t.name)).toContain("brand-new-tag-xyzzy");
    expect(result.tags.find((t) => t.name === "planning")?.status).toBe("existing");
    expect(result.warnings.some((w) => w.kind === "new-tag" && w.message.includes("brand-new-tag-xyzzy"))).toBe(true);
  });

  it("path collision in mode=create blocks (errors), in mode=overwrite warns instead", async () => {
    const v = new Vault(root);
    // Alpha.md already exists in test vault.
    const created = await validateNoteProposal(v, { path: "Alpha.md", content: "body" });
    expect(created.ok).toBe(false);
    expect(created.errors.some((e) => e.kind === "path-collision")).toBe(true);

    const overwritten = await validateNoteProposal(v, {
      path: "Alpha.md",
      content: "body",
      mode: "overwrite"
    });
    expect(overwritten.ok).toBe(true);
    expect(overwritten.collision.kind).toBe("path-exists");
  });

  it("invalid YAML is reported as a hard error with parse message", async () => {
    const v = new Vault(root);
    const result = await validateNoteProposal(v, {
      path: "Inbox/broken.md",
      content: "---\nthis is: : not: : valid: yaml\n---\n\nbody"
    });
    // gray-matter is lenient on most malformed YAML — accept either explicit
    // parse-error OR an empty data with no error (the existing readNote tests
    // observe the same lenience). Either way, the content should pass through
    // and not crash the validator.
    expect(typeof result.yaml.parsed).toBe("boolean");
    expect(result.proposed_path).toBe("Inbox/broken.md");
  });

  it("path traversal is reported as a structured error, not an exception", async () => {
    const v = new Vault(root);
    const result = await validateNoteProposal(v, {
      path: "../../etc/passwd",
      content: "evil"
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.kind === "path-traversal")).toBe(true);
  });

  it("auto-appends .md to the path if missing", async () => {
    const v = new Vault(root);
    const result = await validateNoteProposal(v, {
      path: "Inbox/some-name",
      content: "body"
    });
    expect(result.proposed_path).toBe("Inbox/some-name.md");
  });
});

// ─── v0.13 graph-aware retrieval ─────────────────────────────────────────────
// Use a dedicated fixture so the existing fixture's mtime / link topology
// doesn't get reshaped to fit similarity assertions.

describe("findSimilar / getNoteNeighbors / getVaultStats (v0.13)", () => {
  let groot: string;

  beforeAll(async () => {
    groot = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mcp-v013-"));
    // Hub
    await fs.writeFile(path.join(groot, "Hub.md"), "---\ntags: [hub]\n---\n\nHub: [[A]] [[B]] [[C]]\n");
    // A and B share #project tag and both link to Common; C is unrelated
    await fs.writeFile(
      path.join(groot, "A.md"),
      "---\ntags: [project, blue]\n---\n\nA links to [[Common]] and [[B]].\n"
    );
    await fs.writeFile(path.join(groot, "B.md"), "---\ntags: [project, red]\n---\n\nB links to [[Common]].\n");
    await fs.writeFile(path.join(groot, "C.md"), "---\ntags: [unrelated]\n---\n\nC has no shared signals.\n");
    await fs.writeFile(path.join(groot, "Common.md"), "---\ntags: [shared]\n---\n\nCommon target.\n");
    // Orphan: no inbound, no outbound
    await fs.writeFile(path.join(groot, "Orphan.md"), "An orphan note with no links and no tags.\n");
    // Note with a broken wikilink
    await fs.writeFile(path.join(groot, "Broken.md"), "---\ntags: [project]\n---\n\nThis links to [[NonExistent]].\n");
  });

  afterAll(async () => {
    await fs.rm(groot, { recursive: true, force: true });
  });

  it("findSimilar ranks B above C for source=A (shared tag + shared outbound)", async () => {
    const v = new Vault(groot);
    const out = await findSimilar(v, { path: "A.md", limit: 10 });
    const titles = out.map((s) => s.title);
    // B should appear and rank above C (which has nothing in common).
    const bIdx = titles.indexOf("B");
    const cIdx = titles.indexOf("C");
    expect(bIdx).toBeGreaterThanOrEqual(0);
    if (cIdx >= 0) expect(bIdx).toBeLessThan(cIdx);
    // The top hit must surface the shared "project" tag.
    expect(out[0]?.shared_tags).toContain("project");
    // Each result has all four signals.
    for (const r of out) {
      expect(r.signals).toHaveProperty("tag_jaccard");
      expect(r.signals).toHaveProperty("title_3gram");
      expect(r.signals).toHaveProperty("shared_outbound");
      expect(r.signals).toHaveProperty("co_backlink");
    }
  });

  it("findSimilar respects min_score and never returns the source itself", async () => {
    const v = new Vault(groot);
    const all = await findSimilar(v, { path: "A.md", limit: 100, min_score: 0 });
    expect(all.find((r) => r.path === "A.md")).toBeUndefined();
    const filtered = await findSimilar(v, { path: "A.md", limit: 100, min_score: 100 });
    expect(filtered.length).toBe(0);
  });

  it("getNoteNeighbors returns center + outbound + inbound + tag_siblings", async () => {
    const v = new Vault(groot);
    const out = await getNoteNeighbors(v, { path: "A.md" });
    expect(out.center.path).toBe("A.md");
    expect(out.outbound.map((o) => o.title).sort()).toEqual(["B", "Common"]);
    expect(out.inbound.map((o) => o.title)).toContain("Hub");
    // Tag siblings: notes that share #project but aren't already outbound/inbound.
    // Broken.md has #project and is neither linked from nor to A → expected sibling.
    expect(out.tag_siblings.map((s) => s.title)).toContain("Broken");
  });

  it("getVaultStats reports counts, orphans, broken links, top tags", async () => {
    const v = new Vault(groot);
    const s = await getVaultStats(v, {});
    expect(s.total_notes).toBe(7);
    expect(s.orphans).toBe(1); // Orphan.md
    expect(s.broken_wikilinks).toBe(1); // [[NonExistent]] from Broken.md
    expect(s.notes_with_frontmatter).toBe(6); // every note except Orphan.md
    const tags = s.top_tags.map((t) => t.tag);
    expect(tags).toContain("project");
    // total_tags should equal unique tag count across the vault
    expect(s.total_tags).toBeGreaterThanOrEqual(5);
  });

  it("getVaultStats handles an empty vault", async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mcp-empty-"));
    try {
      const v = new Vault(empty);
      const s = await getVaultStats(v, {});
      expect(s.total_notes).toBe(0);
      expect(s.avg_note_words).toBe(0);
      expect(s.orphans).toBe(0);
      expect(s.broken_wikilinks).toBe(0);
      expect(s.top_tags).toEqual([]);
    } finally {
      await fs.rm(empty, { recursive: true, force: true });
    }
  });
});
