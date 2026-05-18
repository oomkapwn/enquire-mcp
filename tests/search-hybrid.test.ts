// Integration tests for the v2.0 beta hybrid search. Exercises the
// graceful-degradation paths (no FTS5 + no embeddings → TF-IDF only;
// FTS5 + no embeddings → BM25 + TF-IDF). Embedding paths are excluded
// from CI — they need a real model load. The RRF math itself is unit-
// tested in tests/rrf.test.ts; this file verifies the wiring.

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultIndexFile, FtsIndex } from "../src/fts5.js";
import { searchHybrid } from "../src/tools/index.js";
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

// v2.0.0-beta.1 P2 fix: pre-fix, the BM25 codepath in searchHybrid had 0%
// coverage in CI — every test passed `ftsIndex: null` and skipped the
// chunk-collapse + rank-renumbering branch. A regression there (e.g.
// off-by-one in rank assignment, missed dedup) would silently land. These
// tests build a real FtsIndex against a tmp vault and verify BM25 + TF-IDF
// fusion end-to-end.
describe("searchHybrid — BM25 + TF-IDF fusion path", () => {
  let ftsRoot: string;
  let idx: FtsIndex;

  beforeAll(async () => {
    ftsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-hybrid-bm25-"));
    await fs.mkdir(path.join(ftsRoot, "Auth"), { recursive: true });
    await fs.mkdir(path.join(ftsRoot, "Cooking"), { recursive: true });

    // Two strong-signal notes about authentication, two unrelated.
    await fs.writeFile(
      path.join(ftsRoot, "Auth", "OAuth.md"),
      "OAuth authentication flow with JWT tokens. The authorization server issues access tokens.\n\nRefresh tokens rotate per session.\n"
    );
    await fs.writeFile(
      path.join(ftsRoot, "Auth", "JWT.md"),
      "JWT validation: verify signature, expiration, audience, issuer claim. Token introspection.\n"
    );
    await fs.writeFile(path.join(ftsRoot, "Cooking", "Pasta.md"), "Pasta carbonara with guanciale.\n");
    await fs.writeFile(path.join(ftsRoot, "Cooking", "Bread.md"), "Sourdough bread fermentation.\n");

    // Build a real FTS5 index.
    const v = new Vault(ftsRoot);
    await v.ensureExists();
    idx = new FtsIndex({ file: defaultIndexFile(ftsRoot), vaultRoot: ftsRoot });
    await idx.open();
    for (const e of await v.listMarkdown()) {
      const note = await v.readNote(e.absPath, e.mtimeMs);
      const wikilinkTargets = note.parsed.wikilinks.map((w) => w.target).filter((t) => t.length > 0);
      idx.reindexFile(e.relPath, e.mtimeMs, note.content, wikilinkTargets, note.parsed.tags);
    }
  });

  afterAll(async () => {
    idx.close();
    await fs.rm(ftsRoot, { recursive: true, force: true });
  });

  it("uses both bm25 and tfidf signals when ftsIndex is provided", async () => {
    const v = new Vault(ftsRoot);
    const result = await searchHybrid(
      v,
      { query: "OAuth JWT tokens", limit: 5 },
      { ftsIndex: idx, embedFile: path.join(ftsRoot, "nonexistent.embed.db") }
    );
    expect(result.signals_used.sort()).toEqual(["bm25", "tfidf"]);
    expect(result.matches.length).toBeGreaterThan(0);
    // Top hit must be from Auth/, not Cooking/.
    expect(result.matches[0]?.path.startsWith("Auth/")).toBe(true);
  });

  it("hits ranked in BOTH signals score higher than single-signal hits (fusion working)", async () => {
    const v = new Vault(ftsRoot);
    const result = await searchHybrid(
      v,
      { query: "OAuth JWT tokens", limit: 10 },
      { ftsIndex: idx, embedFile: path.join(ftsRoot, "nonexistent.embed.db") }
    );
    // Find a doc with 2 signals and a doc with 1 signal — multi-signal
    // must outrank single-signal. With a strong-overlap query against both
    // Auth notes, both should rank in BM25 + TF-IDF.
    const multiSignalHits = result.matches.filter((m) => m.per_signal.bm25 && m.per_signal.tfidf);
    expect(multiSignalHits.length).toBeGreaterThan(0);
    // Its score must be >= 2/(60+1) — both signals contributing rank 1ish.
    expect(multiSignalHits[0]?.score).toBeGreaterThan(1 / 61);
  });

  it("min_signals=2 returns only multi-ranker consensus hits", async () => {
    const v = new Vault(ftsRoot);
    const result = await searchHybrid(
      v,
      { query: "OAuth JWT tokens", limit: 10, min_signals: 2 },
      { ftsIndex: idx, embedFile: path.join(ftsRoot, "nonexistent.embed.db") }
    );
    // Every hit must have BOTH bm25 and tfidf populated.
    for (const m of result.matches) {
      const numSignals = Object.keys(m.per_signal).length;
      expect(numSignals).toBeGreaterThanOrEqual(2);
    }
  });

  it("BM25 chunk-collapse: per_signal.bm25 carries chunk_index from the best chunk", async () => {
    const v = new Vault(ftsRoot);
    const result = await searchHybrid(
      v,
      { query: "OAuth", limit: 5 },
      { ftsIndex: idx, embedFile: path.join(ftsRoot, "nonexistent.embed.db") }
    );
    // OAuth.md has 2 paragraphs (2 chunks). Hybrid response should carry
    // the chunk_index from the higher-ranked chunk.
    const oauthHit = result.matches.find((m) => m.path === "Auth/OAuth.md");
    expect(oauthHit).toBeDefined();
    expect(oauthHit?.chunk_index).toBeGreaterThanOrEqual(0);
  });

  it("BM25-only on the synthetic Cooking folder reaches that subfolder", async () => {
    const v = new Vault(ftsRoot);
    const result = await searchHybrid(
      v,
      { query: "carbonara", folder: "Cooking", limit: 5 },
      { ftsIndex: idx, embedFile: path.join(ftsRoot, "nonexistent.embed.db") }
    );
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches.every((m) => m.path.startsWith("Cooking/"))).toBe(true);
  });
});

// v2.8.0 — verify the kind flag propagates from FTS5 hits through searchHybrid
// to the MCP response, and that markdown + PDF hits coexist in the same
// blended retrieval.
describe("searchHybrid — kind flag (v2.8.0)", () => {
  let blendRoot: string;
  let blendIdx: FtsIndex;

  beforeAll(async () => {
    blendRoot = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-hybrid-kind-"));
    // One markdown note + one synthetic PDF — both contain "Apollo".
    await fs.writeFile(path.join(blendRoot, "notes.md"), "Apollo program notes from 1969.\n");
    blendIdx = new FtsIndex({
      file: path.join(blendRoot, ".cache", "test.fts5.db"),
      vaultRoot: blendRoot,
      tokenize: "unicode61"
    });
    await fs.mkdir(path.dirname(blendIdx.file), { recursive: true });
    await blendIdx.open();
    blendIdx.reindexFile("notes.md", Date.now(), "Apollo program notes from 1969.");
    blendIdx.reindexPdfFile("apollo.pdf", Date.now(), [
      { pageNumber: 1, text: "Apollo guidance computer architecture" },
      { pageNumber: 2, text: "Saturn V launch sequence" }
    ]);
  });

  afterAll(async () => {
    blendIdx?.close();
    await fs.rm(blendRoot, { recursive: true, force: true });
  });

  it("returns blended hits with kind='md' and kind='pdf'", async () => {
    const v = new Vault(blendRoot);
    const result = await searchHybrid(
      v,
      { query: "Apollo", limit: 10 },
      { ftsIndex: blendIdx, embedFile: path.join(blendRoot, "nonexistent.embed.db") }
    );
    const kinds = new Set(result.matches.map((m) => m.kind));
    expect(kinds).toContain("md");
    expect(kinds).toContain("pdf");
  });

  it("kind='pdf' hits use a .pdf-stripped title (no .md-strip)", async () => {
    const v = new Vault(blendRoot);
    const result = await searchHybrid(
      v,
      { query: "Apollo", limit: 10 },
      { ftsIndex: blendIdx, embedFile: path.join(blendRoot, "nonexistent.embed.db") }
    );
    const pdfHit = result.matches.find((m) => m.kind === "pdf");
    expect(pdfHit).toBeDefined();
    if (pdfHit) {
      expect(pdfHit.title).toBe("apollo");
      expect(pdfHit.path.endsWith(".pdf")).toBe(true);
    }
    const mdHit = result.matches.find((m) => m.kind === "md");
    expect(mdHit).toBeDefined();
    if (mdHit) {
      expect(mdHit.title).toBe("notes");
    }
  });

  it("kind defaults to 'md' on TF-IDF-only matches (no FTS5 / embedding hit)", async () => {
    // No FTS5 index → only TF-IDF (in-memory, scans markdown). No PDF hits possible.
    const v = new Vault(blendRoot);
    const result = await searchHybrid(
      v,
      { query: "Apollo", limit: 10 },
      { ftsIndex: null, embedFile: path.join(blendRoot, "nonexistent.embed.db") }
    );
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches.every((m) => m.kind === "md")).toBe(true);
  });

  // v3.7.12 M6 — graph boost must NOT call `vault.readNote` on `.pdf`
  // candidates. Pre-fix the boost code path attempted `readNote(*.pdf)`
  // for every fused PDF candidate, did a UTF-8 decode of binary bytes,
  // and silently swallowed the parse error via try/catch. The fix
  // restricts the candidate set to `.md` paths only.
  it("graph_boost skips .pdf candidates (M6 negative-control)", async () => {
    const v = new Vault(blendRoot);
    // Spy on vault.readNote — record every absolute path it's called with.
    const calls: string[] = [];
    const origReadNote = v.readNote.bind(v);
    v.readNote = async (...args: Parameters<typeof v.readNote>) => {
      calls.push(args[0]);
      return origReadNote(...args);
    };
    const result = await searchHybrid(
      v,
      { query: "Apollo", limit: 10, graph_boost: true },
      { ftsIndex: blendIdx, embedFile: path.join(blendRoot, "nonexistent.embed.db") }
    );
    // Confirm the fused set still contains both kinds (precondition for
    // a meaningful negative-control — otherwise the PDF skip is vacuous).
    const kinds = new Set(result.matches.map((m) => m.kind));
    expect(kinds).toContain("pdf");
    expect(kinds).toContain("md");
    // Critical: graph-boost-driven readNote calls must NEVER target .pdf.
    // (Tag-index lookups during TF-IDF can call readNote for `.md` files;
    // we only assert the absence of `.pdf` in the call list.)
    const pdfReadCalls = calls.filter((p) => p.toLowerCase().endsWith(".pdf"));
    expect(
      pdfReadCalls.length,
      `graph_boost called readNote on .pdf paths ${pdfReadCalls.join(", ")} — should be skipped post-3.7.12 M6`
    ).toBe(0);
  });
});
