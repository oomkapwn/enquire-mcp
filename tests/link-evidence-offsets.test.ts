import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseNote } from "../src/parser.js";
import { getBacklinks, getOutboundLinks, getUnresolvedWikilinks } from "../src/tools/read.js";
import { Vault } from "../src/vault.js";

describe("wikilink source evidence", () => {
  let root = "";

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-link-offsets-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("carries full-source offsets across frontmatter while excluding fenced decoys", () => {
    const source = "---\nstatus: active\n---\n```md\n[[Missing]]\n```\nreal [[Missing]]\n";
    const parsed = parseNote(source);
    expect(parsed.wikilinks).toHaveLength(1);
    const link = parsed.wikilinks[0];
    expect(link?.sourceStart).toBe(source.lastIndexOf("[[Missing]]"));
    expect(source.slice(link?.sourceStart, link?.sourceEnd)).toBe("[[Missing]]");
  });

  it("reports each repeated real unresolved link at its own line, never at a fenced decoy", async () => {
    const source = [
      "# Source",
      "```md",
      "fenced-decoy [[Missing]]",
      "```",
      "x".repeat(200),
      "real-one [[Missing]]",
      "y".repeat(200),
      "real-two [[Missing]]"
    ].join("\n");
    await fs.writeFile(path.join(root, "Source.md"), source);
    const vault = new Vault(root);

    const hits = await getUnresolvedWikilinks(vault, { limit: 10 });
    expect(hits.map((hit) => hit.line)).toEqual([6, 8]);
    expect(hits[0]?.snippet).toContain("real-one");
    expect(hits[1]?.snippet).toContain("real-two");
    expect(hits.map((hit) => hit.snippet).join("\n")).not.toContain("fenced-decoy");
  });

  it("uses admitted offsets for backlink snippets with duplicate literals", async () => {
    await fs.writeFile(path.join(root, "Target.md"), "# Target\n");
    await fs.writeFile(
      path.join(root, "Source.md"),
      [
        "# Source",
        "```md",
        "fenced-decoy [[Target]]",
        "```",
        "x".repeat(200),
        "real-one [[Target]]",
        "y".repeat(200),
        "real-two [[Target]]"
      ].join("\n")
    );
    const vault = new Vault(root);

    const hits = await getBacklinks(vault, { path: "Target.md", limit: 10 });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.count).toBe(2);
    expect(hits[0]?.snippets[0]).toContain("real-one");
    expect(hits[0]?.snippets[1]).toContain("real-two");
    expect(hits[0]?.snippets.join("\n")).not.toContain("fenced-decoy");
  });

  it("preserves interleaved embed/wikilink source order", async () => {
    await fs.writeFile(path.join(root, "Source.md"), "![[E1]] [[W1]] ![[E2]] [[W2]]\n");
    const vault = new Vault(root);

    const result = await getOutboundLinks(vault, { path: "Source.md" });
    expect(result.links.map((link) => [link.kind, link.target])).toEqual([
      ["embed", "E1"],
      ["wikilink", "W1"],
      ["embed", "E2"],
      ["wikilink", "W2"]
    ]);
  });
});
