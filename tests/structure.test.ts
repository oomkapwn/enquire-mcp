// v3.11.6-rc.2 — the canonical note-STRUCTURE accessors (src/structure.ts). Pins the contract the
// migrated read-path walkers (fts5 computeBreadcrumbsByLine, read extractHeadings→noteHeadings,
// meta getOpenQuestions) now depend on, so a future edit to the shared iterator can't silently
// shift line numbers / headings / breadcrumbs under all three at once.
import { describe, expect, it } from "vitest";
import { type ParsedNote, parseNote } from "../src/parser.js";
import { iterateBodyLines, iterateContentLines, noteHeadings } from "../src/structure.js";

describe("structure.ts — line origins (rc.47 range-arithmetic class)", () => {
  it("iterateContentLines: line === index + 1 (content-origin, base 1)", () => {
    const rows = [...iterateContentLines("a\nb\nc\n")];
    expect(rows.map((r) => r.line)).toEqual([1, 2, 3, 4]); // trailing "" line included, like splitLines
    expect(rows.map((r) => r.index)).toEqual([0, 1, 2, 3]);
    expect(rows.map((r) => r.text)).toEqual(["a", "b", "c", ""]);
  });

  it("iterateBodyLines: line === bodyStartLine + index (file-absolute across frontmatter)", () => {
    // A note with 3-line frontmatter → body starts at file line 5.
    const parsed = parseNote("---\ntitle: X\ntag: y\n---\n# Body Heading\ntext\n");
    expect(parsed.bodyStartLine).toBe(5);
    const rows = [...iterateBodyLines(parsed)];
    // "# Body Heading" is the first body line → file line 5.
    expect(rows[0]?.line).toBe(5);
    expect(noteHeadings(parsed)).toEqual([{ level: 1, text: "Body Heading", line: 5 }]);
  });
});

describe("structure.ts — headings", () => {
  const parse = (body: string): ParsedNote => parseNote(body);

  it("noteHeadings returns level/text/line, in document order, code-fenced ones excluded", () => {
    const parsed = parse("# A\n## B\n```\n## Fenced\n```\n### C\n");
    expect(noteHeadings(parsed)).toEqual([
      { level: 1, text: "A", line: 1 },
      { level: 2, text: "B", line: 2 },
      { level: 3, text: "C", line: 6 }
    ]);
  });

  it("a degenerate all-hashes heading (`# ###`) is NOT a real heading, but IS a heading-shaped line", () => {
    const parsed = parse("# ###\ntext\n");
    // read/meta "real heading" view: skipped.
    expect(noteHeadings(parsed)).toEqual([]);
    // per-line view: heading present with EMPTY text (fts5 pushes it; meta continues on it).
    const rows = [...iterateBodyLines(parsed)];
    expect(rows[0]?.heading).toEqual({ level: 1, text: "" });
    expect(rows[0]?.breadcrumb).toEqual([""]); // fts5-exact: degenerate heading pushed
  });

  it("ATX-close hashes are trimmed; CRLF terminator does not drop the heading (rc.17)", () => {
    expect(noteHeadings(parse("## Heading ##\n"))).toEqual([{ level: 2, text: "Heading", line: 1 }]);
    expect(noteHeadings(parse("# Top\r\nbody\r\n"))).toEqual([{ level: 1, text: "Top", line: 1 }]);
  });
});

describe("structure.ts — fence classification + breadcrumb (fts5 parity)", () => {
  it("inFence marks delimiter + interior lines; breadcrumb carries the heading stack", () => {
    const rows = [...iterateContentLines("# A\n## B\ntext\n```\nfenced\n```\nafter\n")];
    const byText = (t: string) => rows.find((r) => r.text === t);
    expect(byText("text")?.breadcrumb).toEqual(["A", "B"]);
    expect(byText("text")?.inFence).toBe(false);
    expect(byText("```")?.isFenceDelimiter).toBe(true);
    expect(byText("fenced")?.inFence).toBe(true); // interior line
    expect(byText("fenced")?.heading).toBeUndefined(); // no heading parse inside a fence
    // "after" is outside the closed fence, still under B.
    expect(byText("after")?.breadcrumb).toEqual(["A", "B"]);
  });

  it("a mismatched inner fence (`~~~` inside a ``` block) stays code (char-aware, rc.5)", () => {
    const rows = [...iterateContentLines("# T\n```\n~~~\n## FakeInside\n```\n## RealAfter\n")];
    expect(rows.find((r) => r.text === "## FakeInside")?.inFence).toBe(true);
    expect(rows.find((r) => r.text === "## RealAfter")?.heading).toEqual({ level: 2, text: "RealAfter" });
  });
});

describe("structure.ts — terminator preservation (write-back) + disk-cache safety", () => {
  it("StructLine.end carries the exact terminator (CRLF/CR/LF), lossless rejoin", () => {
    const text = "a\r\nb\rc\n";
    const rows = [...iterateContentLines(text)];
    expect(rows.map((r) => r.text + r.end).join("")).toBe(text); // byte-faithful reconstruction
  });

  it("accessors work on a PLAIN (disk-rehydrated, methodless) ParsedNote object", () => {
    // vault.ts JSON.parse's the cache → a plain object, not a class instance. Free functions must
    // still work (the reason structure is functions, not methods/getters on ParsedNote).
    const plain = {
      frontmatter: {},
      body: "# H\ntext\n",
      bodyStartLine: 1,
      wikilinks: [],
      embeds: [],
      tags: []
    } as unknown as ParsedNote;
    expect(noteHeadings(plain)).toEqual([{ level: 1, text: "H", line: 1 }]);
    expect([...iterateBodyLines(plain)][0]?.text).toBe("# H");
  });
});
