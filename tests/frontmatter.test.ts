// v3.10.0-rc.53 — standalone guard for src/frontmatter.ts (the gray-matter replacement).
// The dev-only differential test (vs gray-matter) validated the port before gray-matter
// was removed; this is the shipped CI guard (no gray-matter dependency).
import { describe, expect, it } from "vitest";
import { parseFrontmatter, stringifyFrontmatter } from "../src/frontmatter.js";

describe("parseFrontmatter (rc.53)", () => {
  it("parses a simple frontmatter block + body", () => {
    const r = parseFrontmatter("---\ntitle: Hello\ntags: [a, b]\n---\nBody text");
    expect(r.data).toEqual({ title: "Hello", tags: ["a", "b"] });
    expect(r.content).toBe("Body text");
  });

  it("returns empty data + verbatim content when there's no frontmatter", () => {
    const src = "Just a body\nwith lines";
    const r = parseFrontmatter(src);
    expect(r.data).toEqual({});
    expect(r.content).toBe(src);
  });

  it("treats `----` (4 dashes) as body, not a fence (gray-matter guard)", () => {
    const src = "----\nnot frontmatter\n---\nx";
    expect(parseFrontmatter(src).data).toEqual({});
    expect(parseFrontmatter(src).content).toBe(src);
  });

  it("empty frontmatter → empty data", () => {
    const r = parseFrontmatter("---\n---\nbody");
    expect(r.data).toEqual({});
    expect(r.content).toBe("body");
  });

  it("comment-only frontmatter → empty data (not a parse of the comment)", () => {
    expect(parseFrontmatter("---\n# just a comment\n---\nbody").data).toEqual({});
  });

  it("content is a verbatim suffix of the input (so parser.ts bodyStartLine lastIndexOf holds)", () => {
    const src = "---\nk: v\n---\nbody with --- inside\nmore";
    const r = parseFrontmatter(src);
    expect(src.endsWith(r.content)).toBe(true);
    expect(r.content).toBe("body with --- inside\nmore");
  });

  it("strips a single leading CR/LF after the closing fence (CRLF parity)", () => {
    expect(parseFrontmatter("---\r\nk: v\r\n---\r\nbody").content).toBe("body");
  });

  it("throws on malformed YAML (so parseNote's catch falls back to whole-body) — NEGATIVE control", () => {
    expect(() => parseFrontmatter("---\nkey: : : broken\n  bad: [unclosed\n---\nbody")).toThrow();
  });
});

describe("stringifyFrontmatter (rc.53)", () => {
  it("round-trips data + content through parse∘stringify", () => {
    const data = { status: "draft", tags: ["x", "y"], due: "2026-05-03" };
    const out = stringifyFrontmatter("# Title\n\nBody", data);
    expect(out.startsWith("---\n")).toBe(true);
    const back = parseFrontmatter(out);
    expect(back.data).toEqual(data);
    expect(back.content).toBe("# Title\n\nBody\n"); // stringify appends a trailing newline
  });

  it("empty data → content verbatim with a trailing newline (no fence)", () => {
    expect(stringifyFrontmatter("body", {})).toBe("body\n");
  });

  it("forces date-like strings to stay strings (no Date coercion on round-trip)", () => {
    const out = stringifyFrontmatter("b", { due: "2026-05-03" });
    expect(typeof parseFrontmatter(out).data.due).toBe("string");
  });
});
