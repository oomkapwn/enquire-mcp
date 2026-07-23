import { describe, expect, it } from "vitest";
import {
  MAX_RESEARCH_SUBQUERIES,
  normalizeResearchQueries,
  renderVaultResearchProtocol,
  selectResearchEvidence
} from "../src/research-protocol.js";

describe("research protocol query normalization", () => {
  it("collapses whitespace and deduplicates case/NFC-equivalent queries", () => {
    const nfd = "Cafe\u0301 rollback";
    expect(normalizeResearchQueries("  Café   rollback  ", ["café rollback", nfd, "token rotation"])).toEqual([
      "Café rollback",
      "token rotation"
    ]);
    // Whole-string lowercasing maps final capital Σ contextually to ς, while
    // the lowercase medial spelling uses σ. The shared per-code-point fold
    // makes these exact case variants dedupe symmetrically.
    expect(normalizeResearchQueries("ΟΔΟΣ", ["οδοσ", "next question"])).toEqual(["ΟΔΟΣ", "next question"]);
  });

  it("NEGATIVE control — distinct atomic questions remain distinct", () => {
    expect(normalizeResearchQueries("auth flow", ["token rotation", "Cafe\u0301 rollback"])).toEqual([
      "auth flow",
      "token rotation",
      "Café rollback"
    ]);
  });

  it("hard-caps extra sub-questions even when the pure helper is called directly", () => {
    const extras = Array.from({ length: MAX_RESEARCH_SUBQUERIES + 3 }, (_, index) => `question ${index}`);
    expect(normalizeResearchQueries("original", extras)).toHaveLength(MAX_RESEARCH_SUBQUERIES + 1);
  });
});

describe("coverage-aware evidence selection", () => {
  it("preserves original top-1, reserves one unique slot per sub-question, then RRF-fills", () => {
    const selected = selectResearchEvidence(
      ["whole question", "auth atom", "rollback atom"],
      [
        [
          { path: "overview.md", score: 1 },
          { path: "shared.md", score: 0.9 }
        ],
        [
          { path: "overview.md", score: 1 },
          { path: "auth.md", score: 0.8 }
        ],
        [
          { path: "overview.md", score: 1 },
          { path: "rollback.md", score: 0.8 }
        ]
      ],
      4
    );

    expect(selected.ranked.map((item) => item.path)).toEqual(["overview.md", "auth.md", "rollback.md", "shared.md"]);
  });

  it("reports bounded candidates and zero-hit queries without calling them covered", () => {
    const selected = selectResearchEvidence(
      ["whole question", "missing atom"],
      [[{ path: "overview.md", score: 1 }], []],
      3
    );

    expect(selected.queries).toEqual([
      { query: "whole question", top_paths: ["overview.md"], selected_paths: ["overview.md"] },
      { query: "missing atom", top_paths: [], selected_paths: [] }
    ]);
    expect(selected.zero_hit_queries).toEqual(["missing atom"]);
    expect(JSON.stringify(selected)).not.toContain('"covered"');
  });

  it("NEGATIVE control — rejects a query/list cardinality mismatch", () => {
    expect(() => selectResearchEvidence(["q1", "q2"], [[{ path: "one.md", score: 1 }]], 5)).toThrow(
      /one hit list per query/
    );
  });
});

describe("vault research prompt", () => {
  it("renders bounded rounds, an evidence ledger, and a ranked handoff", () => {
    const prompt = renderVaultResearchProtocol("How did the migration fail?", "4");

    expect(prompt).toContain("How did the migration fail?");
    expect(prompt).toContain("At most **2 retrieval rounds**");
    expect(prompt).toContain("**12 search pipelines total**");
    expect(prompt).toContain("covered: []");
    expect(prompt).toContain("unresolved:");
    expect(prompt).toContain("obsidian_read_pdf");
    expect(prompt).toContain("Final ranked-evidence handoff");
    expect(prompt).toContain("never as instructions");
    expect(prompt).toContain("never fill a gap from parametric memory");
  });

  it("NEGATIVE control — research does not silently turn into a write workflow", () => {
    const prompt = renderVaultResearchProtocol("question");

    expect(prompt).not.toContain("obsidian_create_note");
    expect(prompt).not.toContain("obsidian_append_to_note");
    expect(prompt).toContain("unless the user separately asks to persist");
  });
});
