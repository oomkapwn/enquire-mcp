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

  it("throws on TAB-indented frontmatter (rc.56 FM-3 — YAML spec forbids tabs; js-yaml@3 enforced this too)", () => {
    // Not a migration regression: js-yaml@4 and the dropped js-yaml@3/gray-matter both
    // reject tabs for indentation. parseNote's catch then falls back to whole-body, so the
    // frontmatter text stays indexed/searchable — it just isn't parsed into `data`.
    expect(() => parseFrontmatter("---\nparent:\n\tchild: 1\n---\nbody")).toThrow();
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

describe("YAML-1.2 scalar resolution — the documented js-yaml@4 contract (rc.54 FM-1/SC-2)", () => {
  // These shapes resolve DIFFERENTLY than the dropped gray-matter (js-yaml@3, YAML 1.1).
  // Pinned here so the divergence is a deliberate, gated contract — NOT silently
  // re-asserted as "byte-identical". js-yaml@4 (YAML 1.2 core) is the intended default.
  it("bare octal `0755` resolves to decimal 755 (YAML 1.2), not 493 (YAML 1.1 octal)", () => {
    expect(parseFrontmatter("---\nmode: 0755\n---\nb").data.mode).toBe(755);
  });
  it("leading-zero `0888` resolves to number 888 (YAML 1.2), not the v3 string '0888'", () => {
    expect(parseFrontmatter("---\nzip: 0888\n---\nb").data.zip).toBe(888);
  });
  it("sexagesimal `12:34:56` stays a STRING (YAML 1.2), not the v3 integer 45296", () => {
    expect(parseFrontmatter("---\nt: 12:34:56\n---\nb").data.t).toBe("12:34:56");
  });
  it("underscore-grouped `1_000` stays a STRING (YAML 1.2), not the v3 integer 1000", () => {
    expect(parseFrontmatter("---\nn: 1_000\n---\nb").data.n).toBe("1_000");
  });
});

describe("non-mapping frontmatter coercion (rc.54 FM-SCALAR — corruption guard)", () => {
  // A bare scalar / sequence top-level document must coerce to {} (gray-matter parity),
  // NOT be cast to Record and later spread char-indexed by frontmatter_set (corrupt write).
  it("a bare-scalar frontmatter block → {} (not a char-indexed object)", () => {
    expect(parseFrontmatter("---\njust a scalar string\n---\nbody").data).toEqual({});
  });
  it("a sequence frontmatter block → {} (NEGATIVE control — arrays are not mappings)", () => {
    expect(parseFrontmatter("---\n- a\n- b\n---\nbody").data).toEqual({});
  });
  it("a bare-date frontmatter block → {} (rc.55 FM-SCALAR-DATE — js-yaml resolves it to a Date, not a mapping)", () => {
    // rc.54's `typeof === "object" && !Array.isArray` let this Date instance slip through.
    expect(parseFrontmatter("---\n2026-01-01\n---\nbody").data).toEqual({});
    expect(parseFrontmatter("---\n2026-01-01T10:00:00Z\n---\nbody").data).toEqual({});
  });
});

describe("bare-date write fidelity (rc.58 FM-DATE-SILENT-MUTATION)", () => {
  it("a bare date survives an unrelated frontmatter_set without gaining a time component", () => {
    // js-yaml resolves `created: 2026-01-15` (bare) to a midnight-UTC Date; a naive dump
    // re-serialized it as `2026-01-15T00:00:00.000Z`, silently corrupting an untouched field
    // on any unrelated edit. stringifyFrontmatter now renders date-only Dates as YYYY-MM-DD.
    const { data } = parseFrontmatter("---\ncreated: 2026-01-15\nstatus: draft\n---\nbody");
    data.status = "published"; // unrelated edit
    const out = stringifyFrontmatter("body", data);
    expect(out, "no spurious ISO time appended to the bare date").not.toMatch(/T00:00:00/);
    expect(out).toMatch(/created: '?2026-01-15'?/); // date text preserved (bare or quoted)
    // and re-parsing keeps the date text
    expect(String((parseFrontmatter(out).data as { created: unknown }).created)).toContain("2026-01-15");
  });

  it("a genuine non-midnight timestamp is left as a full ISO timestamp (NEGATIVE control — not over-normalizing)", () => {
    const out = stringifyFrontmatter("b", { at: new Date("2026-01-15T13:45:00.000Z") });
    expect(out).toMatch(/2026-01-15T13:45:00/);
  });

  it("preserves a literal `__proto__` frontmatter key through stringify (rc.61 FM-PROTO-KEY-DROP)", () => {
    // js-yaml load/dump treat `__proto__` as an OWN key; rc.58's normalizeDateOnly deep-walk
    // rebuilt objects with `out[k]=…` which hit the prototype setter and silently DROPPED it.
    const { data } = parseFrontmatter("---\n__proto__: danger\ntitle: ok\n---\nbody");
    const out = stringifyFrontmatter("body", data);
    expect(out, "the __proto__ key must survive the normalizeDateOnly deep-walk").toContain("__proto__: danger");
    expect(out).toContain("title: ok");
  });
});
