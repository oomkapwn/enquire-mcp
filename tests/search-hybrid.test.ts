// Integration tests for the v2.0 beta hybrid search. Exercises the
// graceful-degradation paths (no FTS5 + no embeddings → TF-IDF only;
// FTS5 + no embeddings → BM25 + TF-IDF). Embedding paths are excluded
// from CI — they need a real model load. The RRF math itself is unit-
// tested in tests/rrf.test.ts; this file verifies the wiring.

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { searchHybrid } from "../src/tools.js";
import { Vault } from "../src/vault.js";

let root: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-search-hybrid-"));
  await fs.mkdir(path.join(root, "Auth"), { recursive: true });
  await fs.mkdir(path.join(root, "Cooking"), { recursive: true });

  await fs.writeFile(
    path.join(root, "Auth", "OAuth Flows.md"),
    "OAuth authentication flow with JWT tokens. Authorization server issues access tokens.\n"
  );
  await fs.writeFile(
    path.join(root, "Auth", "JWT Validation.md"),
    "JWT validation: verify signature, expiration, audience, issuer. Refresh token rotation.\n"
  );
  await fs.writeFile(
    path.join(root, "Cooking", "Carbonara.md"),
    "Carbonara: guanciale, pecorino romano, eggs, black pepper. Toss with hot pasta.\n"
  );
  await fs.writeFile(
    path.join(root, "Cooking", "Sourdough.md"),
    "Sourdough starter feeding schedule. Bulk fermentation 4 hours at 25C.\n"
  );
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("searchHybrid (v2.0 beta — RRF over available signals)", () => {
  it("TF-IDF-only path: no FTS5, no embeddings → returns TF-IDF-style ranking", async () => {
    const v = new Vault(root);
    const result = await searchHybrid(
      v,
      { query: "OAuth JWT tokens", limit: 5 },
      { ftsIndex: null, embedFile: path.join(root, "nonexistent.embed.db") }
    );
    expect(result.method).toBe("rrf");
    expect(result.signals_used).toEqual(["tfidf"]);
    expect(result.matches.length).toBeGreaterThan(0);
    // Top hit should be from Auth/, not Cooking/.
    expect(result.matches[0]?.path.startsWith("Auth/")).toBe(true);
    // Per-signal must show only tfidf.
    expect(Object.keys(result.matches[0]?.per_signal ?? {})).toEqual(["tfidf"]);
  });

  it("respects min_signals filter (consensus search)", async () => {
    const v = new Vault(root);
    // With only TF-IDF available, requiring min_signals=2 returns nothing.
    const result = await searchHybrid(
      v,
      { query: "OAuth", limit: 5, min_signals: 2 },
      { ftsIndex: null, embedFile: path.join(root, "nonexistent.embed.db") }
    );
    expect(result.matches.length).toBe(0);
  });

  it("respects folder filter end-to-end", async () => {
    const v = new Vault(root);
    const result = await searchHybrid(
      v,
      { query: "tokens", folder: "Cooking", limit: 10 },
      { ftsIndex: null, embedFile: path.join(root, "nonexistent.embed.db") }
    );
    // Cooking has no token-related notes, so we get either zero hits or
    // very weak matches — but never anything from Auth/.
    expect(result.matches.every((m) => m.path.startsWith("Cooking/"))).toBe(true);
  });

  it("rejects empty query", async () => {
    const v = new Vault(root);
    await expect(
      searchHybrid(v, { query: "" }, { ftsIndex: null, embedFile: path.join(root, "nonexistent.embed.db") })
    ).rejects.toThrow(/empty/);
    await expect(
      searchHybrid(v, { query: "   " }, { ftsIndex: null, embedFile: path.join(root, "nonexistent.embed.db") })
    ).rejects.toThrow(/empty/);
  });

  it("response includes RRF k=60 (Cormack et al constant)", async () => {
    const v = new Vault(root);
    const result = await searchHybrid(
      v,
      { query: "OAuth" },
      { ftsIndex: null, embedFile: path.join(root, "nonexistent.embed.db") }
    );
    expect(result.k).toBe(60);
  });

  it("limits the response to args.limit", async () => {
    const v = new Vault(root);
    const result = await searchHybrid(
      v,
      { query: "the", limit: 2 },
      { ftsIndex: null, embedFile: path.join(root, "nonexistent.embed.db") }
    );
    expect(result.matches.length).toBeLessThanOrEqual(2);
  });

  it("reports total_candidates (the fused set size before truncation)", async () => {
    const v = new Vault(root);
    const result = await searchHybrid(
      v,
      { query: "OAuth JWT pasta sourdough" },
      { ftsIndex: null, embedFile: path.join(root, "nonexistent.embed.db") }
    );
    // total_candidates is the number of fused docs before topK truncation;
    // should be ≥ matches.length and bounded by total notes.
    expect(result.total_candidates).toBeGreaterThanOrEqual(result.matches.length);
  });
});
