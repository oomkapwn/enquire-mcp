import { describe, expect, it } from "vitest";
import {
  extractEmbeds,
  extractFrontmatterTags,
  extractInlineTags,
  extractWikilinks,
  parseNote
} from "../src/parser.js";

describe("extractWikilinks", () => {
  it("parses simple wikilinks", () => {
    const links = extractWikilinks("see [[Foo]] and [[Bar Baz]]");
    expect(links.map((l) => l.target)).toEqual(["Foo", "Bar Baz"]);
  });

  it("parses aliased wikilinks", () => {
    const [link] = extractWikilinks("[[Note|alias text]]");
    expect(link.target).toBe("Note");
    expect(link.alias).toBe("alias text");
  });

  it("parses section refs", () => {
    const [link] = extractWikilinks("[[Note#Heading]]");
    expect(link.target).toBe("Note");
    expect(link.section).toBe("Heading");
  });

  it("parses block refs", () => {
    const [link] = extractWikilinks("[[Note^abc123]]");
    expect(link.target).toBe("Note");
    expect(link.block).toBe("abc123");
  });

  it("parses combined section + alias", () => {
    const [link] = extractWikilinks("[[Note#Section|Custom]]");
    expect(link.target).toBe("Note");
    expect(link.section).toBe("Section");
    expect(link.alias).toBe("Custom");
  });

  it("parses path-style wikilinks", () => {
    const [link] = extractWikilinks("[[folder/sub/Note]]");
    expect(link.target).toBe("folder/sub/Note");
  });

  it("does not produce a wikilink for empty `[[]]` (audit v0.8 P0)", () => {
    expect(extractWikilinks("a [[]] b").length).toBe(0);
    expect(extractWikilinks("[[ ]]").length).toBe(1); // a single space is still a target — surface to user
  });

  it("strips a UTF-8 BOM at the start of a file before parsing (audit v0.8 P0)", () => {
    // BOM-prefixed YAML frontmatter must still parse (gray-matter strips BOM).
    const text = "﻿---\ntitle: BOM Test\n---\n\nbody [[Linked]]\n";
    const parsed = parseNote(text);
    expect(parsed.frontmatter.title).toBe("BOM Test");
    expect(parsed.wikilinks.map((w) => w.target)).toEqual(["Linked"]);
  });
});

describe("extractInlineTags", () => {
  it("captures basic tags", () => {
    expect(extractInlineTags("body with #foo and #bar/baz tags")).toEqual(["foo", "bar/baz"]);
  });

  it("ignores hashes in middle of words", () => {
    expect(extractInlineTags("issue#42 not a tag")).toEqual([]);
  });

  it("handles tag at start of line", () => {
    expect(extractInlineTags("#start-of-line")).toEqual(["start-of-line"]);
  });

  it("dedupes", () => {
    expect(extractInlineTags("#x and #x again")).toEqual(["x"]);
  });

  it("captures Cyrillic / non-ASCII inline tags (audit P3-1)", () => {
    const tags = extractInlineTags("body with #русский and #русский/путь and #idea");
    expect(tags).toContain("русский");
    expect(tags).toContain("русский/путь");
    expect(tags).toContain("idea");
  });

  it("captures CJK and accented inline tags", () => {
    const tags = extractInlineTags("#日本語 #café-au-lait #über");
    expect(tags).toContain("日本語");
    expect(tags).toContain("café-au-lait");
    expect(tags).toContain("über");
  });

  it("still rejects mid-word hashes for Unicode words", () => {
    expect(extractInlineTags("issue#42 не тег и проблема#тест тоже")).toEqual([]);
  });
});

describe("extractFrontmatterTags", () => {
  it("reads array form", () => {
    expect(extractFrontmatterTags({ tags: ["a", "b"] })).toEqual(["a", "b"]);
  });

  it("reads space-separated string", () => {
    expect(extractFrontmatterTags({ tags: "a b c" })).toEqual(["a", "b", "c"]);
  });

  it("strips leading # from frontmatter tags", () => {
    expect(extractFrontmatterTags({ tags: ["#a", "#b"] })).toEqual(["a", "b"]);
  });

  it("returns empty when missing", () => {
    expect(extractFrontmatterTags({})).toEqual([]);
  });
});

describe("extractEmbeds", () => {
  it("captures embed syntax separately from wikilinks", () => {
    const text = "regular [[Link]] and embed ![[Image]]";
    expect(extractWikilinks(text).map((l) => l.target)).toEqual(["Link"]);
    expect(extractEmbeds(text).map((l) => l.target)).toEqual(["Image"]);
  });

  it("handles embed with section ref", () => {
    const [embed] = extractEmbeds("![[Note#Section]]");
    expect(embed.target).toBe("Note");
    expect(embed.section).toBe("Section");
  });
});

describe("parseNote", () => {
  it("parses frontmatter and body", () => {
    const src = "---\ntitle: Hello\ntags: [foo, bar]\n---\n\nBody with [[Link]] and #inline tag.\n";
    const r = parseNote(src);
    expect(r.frontmatter.title).toBe("Hello");
    expect(r.tags.sort()).toEqual(["bar", "foo", "inline"]);
    expect(r.wikilinks[0].target).toBe("Link");
    expect(r.embeds).toEqual([]);
    expect(r.body.trim().startsWith("Body")).toBe(true);
  });

  it("separates wikilinks from embeds in same note", () => {
    const r = parseNote("![[Diagram]] explained in [[Notes]].");
    expect(r.wikilinks.map((l) => l.target)).toEqual(["Notes"]);
    expect(r.embeds.map((l) => l.target)).toEqual(["Diagram"]);
  });

  it("strips wikilinks/tags found inside fenced code blocks", () => {
    const src = "Outer [[Real]]\n\n```\n[[NotALink]] and #notag\n```\n";
    const r = parseNote(src);
    expect(r.wikilinks.map((l) => l.target)).toEqual(["Real"]);
    expect(r.tags).toEqual([]);
  });

  it("handles missing frontmatter", () => {
    const r = parseNote("just a body with [[Link]]");
    expect(r.frontmatter).toEqual({});
    expect(r.wikilinks[0].target).toBe("Link");
  });

  // v3.6.2 — exercise branches in extractFrontmatterTags. Pre-fix the
  // non-array, non-string branch (`tags: 42`) and the malformed-YAML
  // fallback weren't hit.
  it("ignores `tags:` values that aren't an array or string", () => {
    const r = parseNote("---\ntags: 42\n---\nbody");
    expect(r.tags).toEqual([]);
  });

  it("falls back to body-only when frontmatter YAML is malformed", () => {
    // gray-matter throws on hard YAML errors — the parseNote catch
    // treats the whole source as body and returns empty frontmatter.
    const r = parseNote("---\ntags: [foo,\n---\nstill body [[Link]]");
    expect(r.frontmatter).toEqual({});
    // body fallback contains the original source verbatim.
    expect(r.body).toContain("still body");
  });

  it("strips multiple leading # from frontmatter tags", () => {
    const r = parseNote("---\ntags: ['##already-hashed', '#single']\n---\nbody");
    expect(r.tags.sort()).toEqual(["already-hashed", "single"]);
  });
});

describe("bodyStartLine (rc.17 audit M1 — file-absolute line offset)", () => {
  it("is > 1 when frontmatter precedes the body (so body-chunk lines can be file-absolute)", () => {
    expect(parseNote("---\ntitle: T\ntags: [x]\n---\n\nBody line.\n").bodyStartLine).toBeGreaterThan(1);
  });

  it("NEGATIVE control: is exactly 1 when there's no frontmatter", () => {
    expect(parseNote("Body only.\n\nMore body.\n").bodyStartLine).toBe(1);
  });

  it("points at (or before) the first body line in the original source", () => {
    const src = "---\nstatus: active\n---\n\nThe real body starts here.\n";
    const { bodyStartLine, body } = parseNote(src);
    // The source line at bodyStartLine begins the body region: everything from
    // there on must contain the body's first text (not the frontmatter).
    const fromBody = src
      .split("\n")
      .slice(bodyStartLine - 1)
      .join("\n");
    expect(fromBody).toContain("The real body starts here.");
    expect(body).toContain("The real body starts here.");
  });

  // v3.10.0-rc.24 (audit L) — degenerate case: the body text ALSO appears
  // verbatim inside a frontmatter line. Plain `indexOf` would false-match the
  // frontmatter occurrence (reporting too-early a line); `lastIndexOf` anchors to
  // the real body (the suffix of source). The discriminator: the source line at
  // `bodyStartLine` must be the body line ("findme"), NOT the frontmatter
  // `note: findme` — which is what the pre-rc.24 `indexOf` would have pointed at.
  it("anchors to the body's REAL position when its text also appears in frontmatter (rc.24)", () => {
    const src = "---\nnote: findme\n---\nfindme\n";
    const { bodyStartLine, body } = parseNote(src);
    expect(body).toContain("findme");
    const lineAt = src.split("\n")[bodyStartLine - 1];
    expect(lineAt, "bodyStartLine must point at the body line, not the frontmatter occurrence").toBe("findme");
  });
});
