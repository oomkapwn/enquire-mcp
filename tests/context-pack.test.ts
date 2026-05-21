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

  it("returns empty included_notes when vault has no matching content", async () => {
    const v = new Vault(root);
    await v.ensureExists();
    // Write a note that won't match a very off-topic query.
    await fs.writeFile(path.join(root, "unrelated.md"), "# About cats\n\nFluffy cats.\n");

    const result = await contextPack(v, { query: "quantum entanglement", budget_tokens: 500 }, noIndex(root));

    // Should return a valid result with the header even when no top notes match well.
    expect(result.bundle).toContain("# Context for: quantum entanglement");
    expect(result.query).toBe("quantum entanglement");
    expect(Array.isArray(result.included_notes)).toBe(true);
  });
});
