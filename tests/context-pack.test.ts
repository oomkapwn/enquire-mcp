// v3.8.0-rc.8 T-1 — unit tests for contextPack (src/tools/meta.ts).
//
// Background. The rc.6 R-4 fix added a hard budget cap to the assembled
// bundle (`bundle.slice(0, charBudget)` + `[…budget cap reached…]` marker).
// The round-24 external audit found zero test coverage for the triggered
// path — a direct violation of CLAUDE.md anti-pattern "Invariant test
// without negative-control — Rule since v3.6.4".
//
// This file adds:
//   1. Positive control — budget large enough that the cap is NOT triggered:
//      proves the marker is not always appended (validates the "cap off" path).
//   2. Negative control — budget tiny enough that the cap IS triggered:
//      proves the marker is appended and the bundle is hard-sliced.
//   3. Error path — empty query throws.
//
// Import strategy: `src/tools/meta.ts` is NOT in RESTRICTED_MODULES
// (only cli/server/tool-registry/prompts are), so this import is valid.
// Uses ftsIndex:null + non-existent embedFile so only TF-IDF runs
// (no SQLite/model deps required).

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { contextPack } from "../src/tools/meta.js";
import { Vault } from "../src/vault.js";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "context-pack-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

// Shared ctx — no FTS5 index, no embed db (TF-IDF fallback only).
// Non-existent embedFile → embeddings search silently skipped.
const noIndex = (tmpDir: string) => ({ ftsIndex: null as null, embedFile: path.join(tmpDir, "nonexistent.embed.db") });

describe("contextPack (v3.8.0-rc.8 T-1)", () => {
  it("returns a bundle without the cap marker when content fits within budget", async () => {
    const v = new Vault(root);
    await v.ensureExists();
    await fs.writeFile(path.join(root, "note.md"), "# Hello\n\nSmall note body.\n");

    const result = await contextPack(v, { query: "hello", budget_tokens: 1000 }, noIndex(root));

    // Positive control: a 1000-token budget (~4000 chars) easily holds a tiny note.
    expect(result.bundle).not.toContain("[…budget cap reached…]");
    // estimated_tokens should be reasonably small.
    expect(result.estimated_tokens).toBeLessThan(1000);
    // Required fields present.
    expect(result.query).toBe("hello");
    expect(result.budget_tokens).toBe(1000);
  });

  it("hard-caps bundle at charBudget and appends [budget cap reached] marker when content exceeds budget", async () => {
    const v = new Vault(root);
    await v.ensureExists();
    // A note large enough that even with budget_tokens:1, the initial
    // "# Context for: hardcap\n" header (24 chars) already exceeds charBudget=4.
    await fs.writeFile(path.join(root, "big.md"), `# Big note\n\n${"x".repeat(2000)}\n`);

    // budget_tokens:1 → charBudget = 4 chars — guaranteed to trigger the cap.
    const result = await contextPack(v, { query: "hardcap", budget_tokens: 1 }, noIndex(root));

    // Negative control: the hard-cap marker must be present.
    expect(result.bundle).toContain("[…budget cap reached…]");

    // The slice portion must not exceed charBudget (the marker is appended after).
    const charBudget = 1 * 4; // budget_tokens * 4
    const markerLine = "\n[…budget cap reached…]";
    const slicedPart = result.bundle.slice(0, result.bundle.indexOf(markerLine));
    expect(slicedPart.length).toBeLessThanOrEqual(charBudget);
  });

  it("throws when query is empty or whitespace-only", async () => {
    const v = new Vault(root);
    await v.ensureExists();

    await expect(contextPack(v, { query: "" }, noIndex(root))).rejects.toThrow("query");

    await expect(contextPack(v, { query: "   " }, noIndex(root))).rejects.toThrow("query");
  });

  it("returns empty included_notes for no match and never parses selected PDFs as Markdown", async () => {
    const v = new Vault(root);
    await v.ensureExists();
    // Write a note that won't match a very off-topic query.
    await fs.writeFile(path.join(root, "unrelated.md"), "# About cats\n\nFluffy cats.\n");

    const result = await contextPack(v, { query: "quantum entanglement", budget_tokens: 500 }, noIndex(root));

    // Should return a valid result with the header even when no top notes match well.
    expect(result.bundle).toContain("# Context for: quantum entanglement");
    expect(result.query).toBe("quantum entanglement");
    expect(Array.isArray(result.included_notes)).toBe(true);
    expect(result.included_notes).toEqual([]);

    // A PDF can be a first-class hybrid hit, but context_pack is a Markdown
    // body packer. Pre-rc.30 it passed the .pdf path to Vault.readNote(); a
    // binary payload can decode to text without throwing and leak garbage into
    // the bundle. The kind branch must surface the path for read_pdf instead.
    await fs.writeFile(path.join(root, "evidence.pdf"), "PDF_BINARY_SENTINEL evidence");
    const pdfIndex = {
      search: () => [
        {
          rel_path: "evidence.pdf",
          chunk_index: 0,
          line_start: 1,
          line_end: 1,
          snippet: "evidence",
          score: 10,
          kind: "pdf" as const
        }
      ]
    };
    const pdfResult = await contextPack(
      v,
      // The header alone exhausts this budget. PDF follow-up metadata must
      // remain available because it does not consume Markdown bundle space.
      { query: "evidence", budget_tokens: 1 },
      {
        ...noIndex(root),
        ftsIndex: pdfIndex as unknown as NonNullable<Parameters<typeof contextPack>[2]["ftsIndex"]>
      }
    );
    expect(pdfResult.included_notes).not.toContain("evidence.pdf");
    expect(pdfResult.skipped_pdf_candidates).toEqual(["evidence.pdf"]);
    expect(pdfResult.bundle).not.toContain("PDF_BINARY_SENTINEL");
  });
});

// ─── v3.11.6-rc.14 (root-cause audit) — full search-ctx flow-through ─────────
// Pre-rc.14 contextPack accepted ONLY {ftsIndex, embedFile}, so a server with
// --enable-reranker (etc.) silently packed context in plain RRF order while
// obsidian_search ranked with the enhancements — the "enabled but not wired"
// class (CRL-1/M5 siblings). This pins the flow-through behaviorally: an
// injected reranker that inverts the order MUST change which note the pack
// leads with.
describe("contextPack forwards the full search ctx (rc.14)", () => {
  it("an injected reranker reorders the packed notes (ctx flows to the inner searchHybrid)", async () => {
    const v = new Vault(root);
    await v.ensureExists();
    // alpha: 3× the term → TF-IDF rank 0 without a reranker.
    await fs.writeFile(path.join(root, "alpha.md"), "kubernetes kubernetes kubernetes ingress.\n");
    await fs.writeFile(path.join(root, "beta.md"), "kubernetes ingress notes.\n");

    const baseline = await contextPack(v, { query: "kubernetes", budget_tokens: 2000 }, noIndex(root));
    expect(baseline.included_notes[0]).toBe("alpha.md");

    // Reranker that INVERTS the order (last passage scores highest).
    const inverted = await contextPack(
      v,
      { query: "kubernetes", budget_tokens: 2000 },
      {
        ...noIndex(root),
        rerankerOverride: {
          score: async (_q: string, passages: readonly string[]) => passages.map((_, i) => i)
        }
      }
    );
    // NEGATIVE control vs baseline: the pack's lead note flips — proving the
    // reranker ctx reached the inner searchHybrid (pre-rc.14 this was
    // impossible: the ctx type didn't even accept rerankerOverride).
    expect(inverted.included_notes[0]).toBe("beta.md");
  });
});

// ─── v3.11.7-rc.4 — bounded coverage-aware research packs ──────────────────
describe("contextPack subquery coverage mode (v3.11.7-rc.4)", () => {
  it("keeps absent, empty, and duplicate-only subqueries byte-identical on the legacy path", async () => {
    const v = new Vault(root);
    await v.ensureExists();
    await fs.writeFile(path.join(root, "note.md"), "# Auth\n\nAccess token rotation notes.\n");

    const absent = await contextPack(v, { query: "access token", budget_tokens: 1000 }, noIndex(root));
    const empty = await contextPack(v, { query: "access token", subqueries: [], budget_tokens: 1000 }, noIndex(root));
    const duplicateOnly = await contextPack(
      v,
      { query: "access token", subqueries: ["  ACCESS   token  "], budget_tokens: 1000 },
      noIndex(root)
    );

    expect(empty).toEqual(absent);
    expect(duplicateOnly).toEqual(absent);
    expect("research" in empty).toBe(false);
    expect("research" in duplicateOnly).toBe(false);
  });

  it("reserves candidates for distinct subqueries and exposes a non-semantic retrieval trace", async () => {
    const v = new Vault(root);
    await v.ensureExists();
    await fs.writeFile(path.join(root, "overview.md"), "Platform recovery overview and operating owners.\n");
    await fs.writeFile(path.join(root, "auth.md"), "Authentication uses access token rotation before promotion.\n");
    await fs.writeFile(path.join(root, "rollback.md"), "Rollback snapshot restore returns the prior artifact.\n");
    await fs.writeFile(path.join(root, "unrelated.md"), "Pasta recipe and kitchen notes.\n");

    const baseline = await contextPack(v, { query: "platform recovery", budget_tokens: 2000 }, noIndex(root));
    const result = await contextPack(
      v,
      {
        query: "platform recovery",
        subqueries: ["access token rotation", "rollback snapshot restore", "  PLATFORM   recovery  "],
        budget_tokens: 2000
      },
      noIndex(root)
    );

    expect(result.included_notes.slice(0, 3)).toEqual(["overview.md", "auth.md", "rollback.md"]);
    expect(result.included_notes[0]).toBe(baseline.included_notes[0]);
    expect(result.bundle).toContain("Authentication uses access token rotation");
    expect(result.research?.strategy).toBe("coverage_slots_then_rrf");
    expect(result.research?.search_calls).toBe(3);
    expect(result.research?.queries.map((entry) => entry.query)).toEqual([
      "platform recovery",
      "access token rotation",
      "rollback snapshot restore"
    ]);
    expect(result.research?.queries[1]?.selected_paths).toContain("auth.md");
    expect(result.research?.queries[2]?.selected_paths).toContain("rollback.md");
    expect(JSON.stringify(result.research)).not.toContain('"covered"');
  });

  it("NEGATIVE control — a zero-hit subquery remains explicitly unresolved at retrieval level", async () => {
    const v = new Vault(root);
    await v.ensureExists();
    await fs.writeFile(path.join(root, "overview.md"), "Platform recovery overview.\n");

    const result = await contextPack(
      v,
      { query: "platform recovery", subqueries: ["zz-no-such-evidence-token"], budget_tokens: 1000 },
      noIndex(root)
    );

    expect(result.research?.zero_hit_queries).toEqual(["zz-no-such-evidence-token"]);
    expect(result.research?.queries[1]?.top_paths).toEqual([]);
  });
});
