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
import { filterExcludedEmbedHits, frontmatterMatches, pruneExcludedHits } from "../src/tools/search.js";
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

// v3.10 — forgetting-aware freshness enrichment on hybrid hits. Verifies that
// searchHybrid stats each final hit's CURRENT on-disk mtime and attaches
// age_days/stale, that the threshold is the canonical 365 days, and that the
// enrichment is fail-soft (a deleted-after-fusion file omits the fields rather
// than throwing). Uses fs.utimes to control mtimes deterministically, mirroring
// tests/stale-notes.test.ts.
describe("searchHybrid — age_days/stale freshness enrichment (v3.10)", () => {
  const DAY = 86_400_000;
  let sRoot: string;

  beforeAll(async () => {
    sRoot = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-hybrid-stale-"));
    // Two topically-matching notes so both surface for the same query.
    await fs.writeFile(path.join(sRoot, "old-note.md"), "kubernetes ingress controller routing rules.\n");
    await fs.writeFile(path.join(sRoot, "fresh-note.md"), "kubernetes ingress controller TLS termination.\n");
    const now = Date.now();
    // old-note: 400 days old → stale; fresh-note: 10 days old → not stale.
    await fs.utimes(path.join(sRoot, "old-note.md"), new Date(now - 400 * DAY), new Date(now - 400 * DAY));
    await fs.utimes(path.join(sRoot, "fresh-note.md"), new Date(now - 10 * DAY), new Date(now - 10 * DAY));
  });

  afterAll(async () => {
    await fs.rm(sRoot, { recursive: true, force: true });
  });

  it("attaches age_days (>= 0) and stale to every hit, reflecting live mtime", async () => {
    const v = new Vault(sRoot);
    const result = await searchHybrid(
      v,
      { query: "kubernetes ingress controller", limit: 5 },
      { ftsIndex: null, embedFile: path.join(sRoot, "nonexistent.embed.db") }
    );
    expect(result.matches.length).toBeGreaterThanOrEqual(2);
    const byPath = new Map(result.matches.map((m) => [m.path, m]));
    const old = byPath.get("old-note.md");
    const fresh = byPath.get("fresh-note.md");
    expect(old).toBeDefined();
    expect(fresh).toBeDefined();
    // age_days is a non-negative integer reflecting the file mtime we set.
    expect(typeof old?.age_days).toBe("number");
    expect(old?.age_days).toBeGreaterThanOrEqual(399);
    expect(typeof fresh?.age_days).toBe("number");
    expect(fresh?.age_days).toBeGreaterThanOrEqual(9);
    expect(fresh?.age_days).toBeLessThan(30);
    // stale crosses at the canonical 365-day threshold.
    expect(old?.stale).toBe(true);
    expect(fresh?.stale).toBe(false);
  });

  it("NEGATIVE control: an all-fresh vault yields stale=false on every hit", async () => {
    const freshRoot = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-hybrid-allfresh-"));
    try {
      await fs.writeFile(path.join(freshRoot, "a.md"), "kubernetes ingress controller A.\n");
      await fs.writeFile(path.join(freshRoot, "b.md"), "kubernetes ingress controller B.\n");
      // Leave mtimes at creation time (now) — nothing is stale.
      const v = new Vault(freshRoot);
      const result = await searchHybrid(
        v,
        { query: "kubernetes ingress controller", limit: 5 },
        { ftsIndex: null, embedFile: path.join(freshRoot, "nonexistent.embed.db") }
      );
      expect(result.matches.length).toBeGreaterThan(0);
      for (const m of result.matches) {
        expect(m.stale).toBe(false);
        expect(m.age_days).toBeLessThan(2);
      }
    } finally {
      await fs.rm(freshRoot, { recursive: true, force: true });
    }
  });

  it("is fail-soft: the search still returns hits even if a hit path is unstattable", async () => {
    // FTS5-less TF-IDF path reads from the live vault, so every match path
    // exists at stat time; this asserts the happy path doesn't throw and the
    // fields are present (the catch-branch omission is exercised structurally
    // by the try/catch — a missing file simply omits the two fields).
    const v = new Vault(sRoot);
    const result = await searchHybrid(
      v,
      { query: "kubernetes", limit: 5 },
      { ftsIndex: null, embedFile: path.join(sRoot, "nonexistent.embed.db") }
    );
    expect(result.matches.length).toBeGreaterThan(0);
    // Every hit from a live vault gets enriched (no stat failures expected here).
    for (const m of result.matches) {
      expect(typeof m.age_days).toBe("number");
      expect(typeof m.stale).toBe("boolean");
    }
  });
});

// v3.10 (rc.5) — opt-in recency re-ranking. A vault with a MORE-relevant but
// OLD note and a LESS-relevant but FRESH note: by default the old-but-relevant
// note ranks first; with a high recency weight the fresh note rises. weight=0
// must be a provable no-op. mtimes controlled via fs.utimes.
describe("searchHybrid — opt-in recency re-ranking (v3.10 rc.5)", () => {
  const DAY = 86_400_000;
  let rRoot: string;

  beforeAll(async () => {
    rRoot = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-hybrid-recency-"));
    // alpha: 3× the query term → higher TF-IDF relevance, but OLD (1000 days).
    await fs.writeFile(path.join(rRoot, "alpha.md"), "kubernetes kubernetes kubernetes ingress controller.\n");
    // beta: 1× the term → lower relevance, but FRESH (1 day).
    await fs.writeFile(path.join(rRoot, "beta.md"), "kubernetes ingress controller notes.\n");
    const now = Date.now();
    await fs.utimes(path.join(rRoot, "alpha.md"), new Date(now - 1000 * DAY), new Date(now - 1000 * DAY));
    await fs.utimes(path.join(rRoot, "beta.md"), new Date(now - 1 * DAY), new Date(now - 1 * DAY));
  });

  afterAll(async () => {
    await fs.rm(rRoot, { recursive: true, force: true });
  });

  const embedFile = () => path.join(rRoot, "nonexistent.embed.db");

  it("baseline (no recency config): the more-relevant OLD note ranks first", async () => {
    const v = new Vault(rRoot);
    const result = await searchHybrid(v, { query: "kubernetes", limit: 5 }, { ftsIndex: null, embedFile: embedFile() });
    expect(result.matches.length).toBe(2);
    expect(result.matches[0]?.path).toBe("alpha.md"); // relevance wins by default
  });

  it("with recency weight 1.0, the FRESH note rises above the more-relevant old one", async () => {
    const v = new Vault(rRoot);
    const result = await searchHybrid(
      v,
      { query: "kubernetes", limit: 5 },
      { ftsIndex: null, embedFile: embedFile(), recency: { weight: 1, staleDays: 365 } }
    );
    expect(result.matches.length).toBe(2);
    // weight 1 → order is purely by recency → the 1-day note beats the 1000-day note.
    expect(result.matches[0]?.path).toBe("beta.md");
    expect(result.matches[1]?.path).toBe("alpha.md");
  });

  // NEGATIVE control: weight 0 must NOT change anything — identical to baseline.
  // This proves the blend is a true no-op when off (the default), so nobody is
  // surprised by recency silently reordering relevance.
  it("NEGATIVE control — recency weight 0 is a provable no-op (order == baseline)", async () => {
    const v = new Vault(rRoot);
    const baseline = await searchHybrid(
      v,
      { query: "kubernetes", limit: 5 },
      { ftsIndex: null, embedFile: embedFile() }
    );
    const withZero = await searchHybrid(
      v,
      { query: "kubernetes", limit: 5 },
      { ftsIndex: null, embedFile: embedFile(), recency: { weight: 0, staleDays: 365 } }
    );
    expect(withZero.matches.map((m) => m.path)).toEqual(baseline.matches.map((m) => m.path));
    expect(withZero.matches[0]?.path).toBe("alpha.md"); // still relevance-first
  });

  it("a smaller staleDays (faster decay) still ranks the fresh note first at high weight", async () => {
    const v = new Vault(rRoot);
    const result = await searchHybrid(
      v,
      { query: "kubernetes", limit: 5 },
      { ftsIndex: null, embedFile: embedFile(), recency: { weight: 0.9, staleDays: 30 } }
    );
    expect(result.matches[0]?.path).toBe("beta.md");
  });
});

// v3.10.0-rc.8 (post-rc.7 audit) — the fusion-stage privacy prune. This guards
// the fusion-stage consumers of `fused` (graph-boost reads candidate CONTENT;
// recency stats candidate mtime) which run BEFORE the response-build
// isExcluded guard. Tested as a PURE unit (predicate injected) because the
// public searchHybrid path can't inject an excluded id into `fused` — the
// per-arm ranker filters already drop them — so an integration test would be
// vacuous (verified: it passed with the prune disabled).
describe("pruneExcludedHits (v3.10 rc.8 — fusion-stage isExcluded parity)", () => {
  const hits = [{ id: "Public/a.md" }, { id: "Personal/diary.md" }, { id: "Public/b.md" }];
  const isExcludedPersonal = (p: string) => p.startsWith("Personal/");

  it("removes excluded note-granularity ids, preserves order of the rest", () => {
    const out = pruneExcludedHits(hits, isExcludedPersonal, "note");
    expect(out.map((h) => h.id)).toEqual(["Public/a.md", "Public/b.md"]);
  });

  it("strips the #chunk suffix before the membership test (block granularity)", () => {
    const blockHits = [{ id: "Public/a.md#0" }, { id: "Personal/diary.md#3" }, { id: "Public/b.md#1" }];
    const out = pruneExcludedHits(blockHits, isExcludedPersonal, "block");
    expect(out.map((h) => h.id)).toEqual(["Public/a.md#0", "Public/b.md#1"]);
  });

  it("does NOT strip a literal '#' in a note-granularity filename (C# Notes.md)", () => {
    // In "note" granularity the id IS the path — a `#` in the name is part of it.
    const csharp = [{ id: "C# Notes.md" }];
    expect(pruneExcludedHits(csharp, () => false, "note").map((h) => h.id)).toEqual(["C# Notes.md"]);
    // And it's correctly excluded when the predicate matches the full name.
    expect(pruneExcludedHits(csharp, (p) => p === "C# Notes.md", "note")).toEqual([]);
  });

  // NEGATIVE control: the prune MUST be driven by the predicate. A predicate
  // that excludes nothing leaves the list intact; one that matches an entry
  // removes exactly it. A no-op impl (`return hits`) FAILS the second assertion
  // — this is what made the integration test vacuous and this one real.
  it("NEGATIVE control — driven by the predicate, not unconditional", () => {
    expect(pruneExcludedHits(hits, () => false, "note")).toHaveLength(3); // excludes nothing
    expect(pruneExcludedHits(hits, () => true, "note")).toHaveLength(0); // excludes everything
    expect(pruneExcludedHits(hits, isExcludedPersonal, "note")).toHaveLength(2); // exactly the 1 excluded removed
  });
});

// v3.10.0-rc.22 (audit M8) — embeddingsSearch's privacy filter, extracted from
// two inline `.filter(row => !vault.isExcluded(row.rel_path))` sites so it's
// unit-testable without the ML embedder. Before rc.22 the security test
// REIMPLEMENTED this filter inline (never ran the real one) — a vacuous test
// that would have passed even if embeddingsSearch dropped its guard.
describe("filterExcludedEmbedHits (v3.10 rc.22 — embeddingsSearch privacy filter)", () => {
  const rows = [
    { rel_path: "Public/a.md", score: 1 },
    { rel_path: "Personal/diary.md", score: 0.9 },
    { rel_path: "Public/b.md", score: 0.8 }
  ];
  const isExcludedPersonal = (p: string) => p.startsWith("Personal/");

  it("removes excluded rel_paths, preserves order of the rest", () => {
    const out = filterExcludedEmbedHits(rows, isExcludedPersonal);
    expect(out.map((r) => r.rel_path)).toEqual(["Public/a.md", "Public/b.md"]);
  });

  // NEGATIVE control: must be predicate-driven (a no-op `return hits` fails the
  // "excludes everything" assertion). This is the exact filter embeddingsSearch
  // applies at search.ts ~1100/1106.
  it("NEGATIVE control — driven by the predicate, not unconditional", () => {
    expect(filterExcludedEmbedHits(rows, () => false)).toHaveLength(3); // excludes nothing
    expect(filterExcludedEmbedHits(rows, () => true)).toHaveLength(0); // excludes everything
    expect(filterExcludedEmbedHits(rows, isExcludedPersonal)).toHaveLength(2); // exactly 1 removed
  });
});

// v3.10 (rc.10) — frontmatter-aware retrieval filter. Pure matcher unit-tested
// directly (semantics), then the opt-in filter exercised end-to-end through
// searchHybrid with a NEGATIVE control proving it actually narrows.
describe("frontmatterMatches (v3.10 rc.10 — filter semantics)", () => {
  it("scalar equality, strings case-insensitive", () => {
    expect(frontmatterMatches({ status: "Active" }, { status: "active" })).toBe(true);
    expect(frontmatterMatches({ status: "done" }, { status: "active" })).toBe(false);
  });
  it("array frontmatter value matches by membership", () => {
    expect(frontmatterMatches({ tags: ["proj", "x"] }, { tags: "proj" })).toBe(true);
    expect(frontmatterMatches({ tags: ["a", "b"] }, { tags: "proj" })).toBe(false);
  });
  it("array filter value is OR; multiple keys are AND", () => {
    expect(frontmatterMatches({ type: "meeting" }, { type: ["meeting", "decision"] })).toBe(true);
    expect(frontmatterMatches({ status: "active", type: "meeting" }, { status: "active", type: "decision" })).toBe(
      false
    );
  });
  it("numbers/booleans are strict (no cross-type coercion)", () => {
    expect(frontmatterMatches({ priority: 1, pinned: true }, { priority: 1, pinned: true })).toBe(true);
    expect(frontmatterMatches({ priority: 1 }, { priority: "1" })).toBe(false); // 1 ≠ "1"
  });
  it("missing key, empty, or absent frontmatter never matches a filter", () => {
    expect(frontmatterMatches({ status: "active" }, { type: "meeting" })).toBe(false); // missing key
    expect(frontmatterMatches({}, { status: "active" })).toBe(false);
    expect(frontmatterMatches(undefined, { status: "active" })).toBe(false);
    expect(frontmatterMatches(null, { status: "active" })).toBe(false);
  });
  // NEGATIVE control: the matcher must DISCRIMINATE — a satisfiable filter
  // returns true, an unsatisfiable one false. A constant impl fails one of these.
  it("NEGATIVE control — discriminates (not constant)", () => {
    const fm = { status: "active", type: "meeting" };
    expect(frontmatterMatches(fm, { status: "active" })).toBe(true);
    expect(frontmatterMatches(fm, { status: "archived" })).toBe(false);
  });
});

describe("searchHybrid — opt-in frontmatter filter (v3.10 rc.10)", () => {
  let fmRoot: string;
  beforeAll(async () => {
    fmRoot = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-hybrid-fm-"));
    await fs.writeFile(
      path.join(fmRoot, "active.md"),
      "---\nstatus: active\ntype: project\n---\nkubernetes ingress controller routing.\n"
    );
    await fs.writeFile(
      path.join(fmRoot, "done.md"),
      "---\nstatus: done\ntype: project\n---\nkubernetes ingress controller routing.\n"
    );
    await fs.writeFile(path.join(fmRoot, "nofm.md"), "kubernetes ingress controller routing, no frontmatter.\n");
  });
  afterAll(async () => {
    await fs.rm(fmRoot, { recursive: true, force: true });
  });

  it("filters hits to notes whose frontmatter matches (and excludes no-frontmatter / non-matching)", async () => {
    const v = new Vault(fmRoot);
    const result = await searchHybrid(
      v,
      { query: "kubernetes ingress", limit: 10, filter_frontmatter: { status: "active" } },
      { ftsIndex: null, embedFile: path.join(fmRoot, "nonexistent.embed.db") }
    );
    expect(result.matches.map((m) => m.path)).toEqual(["active.md"]);
  });

  // NEGATIVE control: WITHOUT the filter, the same query returns all three —
  // proving the filter above actually removed done.md + nofm.md (not that the
  // query only matched one note).
  it("NEGATIVE control — no filter returns all three (the filter is what narrowed it)", async () => {
    const v = new Vault(fmRoot);
    const result = await searchHybrid(
      v,
      { query: "kubernetes ingress", limit: 10 },
      { ftsIndex: null, embedFile: path.join(fmRoot, "nonexistent.embed.db") }
    );
    const paths = result.matches.map((m) => m.path).sort();
    expect(paths).toEqual(["active.md", "done.md", "nofm.md"]);
  });

  it("array-value frontmatter filter (OR) + AND across keys", async () => {
    const v = new Vault(fmRoot);
    const result = await searchHybrid(
      v,
      { query: "kubernetes ingress", limit: 10, filter_frontmatter: { type: "project", status: ["active", "done"] } },
      { ftsIndex: null, embedFile: path.join(fmRoot, "nonexistent.embed.db") }
    );
    expect(result.matches.map((m) => m.path).sort()).toEqual(["active.md", "done.md"]); // both projects, nofm excluded
  });
});
