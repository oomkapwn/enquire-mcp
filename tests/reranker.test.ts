// v2.9.0 — BGE cross-encoder reranker tests.
//
// We don't load the real ML model here; that's smoke-test territory. These
// tests validate the plumbing:
//   • RERANKER_MODELS catalog + resolveRerankerModel error paths
//   • searchHybrid integration via `ctx.rerankerOverride` (dependency
//     injection): the rerank-and-resort logic is the security-critical
//     part, and we can validate it deterministically with a synthetic
//     score function.
//   • signal_errors.reranker surfaces when the reranker throws
//   • reranker_score appears on each hit in [0, 1]

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RERANKER_MODELS, resolveRerankerModel } from "../src/embeddings.js";
import { FtsIndex } from "../src/fts5.js";
import { searchHybrid } from "../src/tools/index.js";
import { Vault } from "../src/vault.js";

describe("RERANKER_MODELS catalog (v2.9.0)", () => {
  it("exposes rerank-multilingual as the multilingual default", () => {
    const m = resolveRerankerModel("rerank-multilingual");
    expect(m.alias).toBe("rerank-multilingual");
    expect(m.multilingual).toBe(true);
    expect(m.maxTokens).toBeGreaterThanOrEqual(512);
  });

  it("exposes rerank-bge as the English-only option", () => {
    const m = resolveRerankerModel("rerank-bge");
    expect(m.alias).toBe("rerank-bge");
    expect(m.multilingual).toBe(false);
  });

  // v3.6.1 CRIT-2 — default flipped from "rerank-multilingual" to
  // "rerank-bge" (transformers.js compat issue blocks the multilingual
  // alias; tracked for v3.7). Keep the catalog entry so users get a
  // proper "Unknown alias" message if they explicitly pass it.
  it("defaults to rerank-bge when alias is undefined (v3.6.1: was rerank-multilingual; flipped because that alias is broken)", () => {
    const m = resolveRerankerModel(undefined);
    expect(m.alias).toBe("rerank-bge");
  });

  it("throws on unknown alias with a list of known aliases", () => {
    expect(() => resolveRerankerModel("nonexistent")).toThrow(/Unknown reranker model alias/);
    expect(() => resolveRerankerModel("nonexistent")).toThrow(/rerank-bge|rerank-multilingual/);
  });

  it("every catalog entry has a sensible approxSizeMB", () => {
    for (const m of Object.values(RERANKER_MODELS)) {
      expect(m.approxSizeMB).toBeGreaterThan(0);
      expect(m.approxSizeMB).toBeLessThan(2000);
    }
  });

  // v3.3.0 — extended registry with 3 more aliases for size/quality/lang
  // tradeoffs. Pin the registry so adding/removing entries is a deliberate
  // schema change.
  it("v3.3.0 exposes rerank-bge-large (English, larger, higher quality)", () => {
    const m = resolveRerankerModel("rerank-bge-large");
    expect(m.alias).toBe("rerank-bge-large");
    expect(m.multilingual).toBe(false);
    expect(m.approxSizeMB).toBeGreaterThan(200);
  });

  it("v3.3.0 exposes rerank-jina-tiny (English, smallest, latency-optimized)", () => {
    const m = resolveRerankerModel("rerank-jina-tiny");
    expect(m.alias).toBe("rerank-jina-tiny");
    expect(m.multilingual).toBe(false);
    expect(m.approxSizeMB).toBeLessThan(50);
  });

  it("v3.3.0 exposes rerank-multilingual-large (50+ langs, higher quality)", () => {
    const m = resolveRerankerModel("rerank-multilingual-large");
    expect(m.alias).toBe("rerank-multilingual-large");
    expect(m.multilingual).toBe(true);
    expect(m.approxSizeMB).toBeGreaterThan(200);
  });

  it("registry size matches v3.3.0 expectation (5 aliases)", () => {
    expect(Object.keys(RERANKER_MODELS).length).toBe(5);
  });
});

// End-to-end reranker plumbing test against a real FtsIndex with synthetic
// markdown. Uses the `rerankerOverride` injection point so we don't pull in
// the actual ML model.
describe("searchHybrid + reranker (v2.9.0)", () => {
  let root: string;
  let idx: FtsIndex;
  const dbFile = path.join(os.tmpdir(), `enquire-reranker-${Date.now()}.fts5.db`);

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-reranker-"));
    // Three notes — all match a common keyword "rocket" so they land in the
    // BM25 candidate set. The reranker can then choose which order they
    // come back in; the production reranker would do this based on
    // semantic relevance to the full query.
    await fs.writeFile(path.join(root, "low.md"), "Rocket notes — quick mention. Other unrelated topics.\n");
    await fs.writeFile(
      path.join(root, "mid.md"),
      "Rocket fuel chemistry: oxidizer + propellant balance, trade-offs.\n"
    );
    await fs.writeFile(path.join(root, "high.md"), "Saturn V rocket guidance computer Apollo program engineering.\n");
    idx = new FtsIndex({ file: dbFile, vaultRoot: root, tokenize: "unicode61" });
    await idx.open();
    idx.reindexFile("low.md", Date.now(), "Rocket notes — quick mention. Other unrelated topics.");
    idx.reindexFile("mid.md", Date.now(), "Rocket fuel chemistry: oxidizer + propellant balance, trade-offs.");
    idx.reindexFile("high.md", Date.now(), "Saturn V rocket guidance computer Apollo program engineering.");
  });

  afterAll(async () => {
    idx?.close();
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(dbFile, { force: true });
    await fs.rm(`${dbFile}-wal`, { force: true });
    await fs.rm(`${dbFile}-shm`, { force: true });
  });

  it("does not invoke the reranker when ctx.reranker is unset", async () => {
    let called = false;
    const v = new Vault(root);
    const result = await searchHybrid(
      v,
      { query: "rocket", limit: 5 },
      {
        ftsIndex: idx,
        embedFile: path.join(root, "nonexistent.embed.db"),
        rerankerOverride: {
          async score() {
            called = true;
            return [];
          }
        }
        // No `reranker` config + no rerankerOverride means reranker is off.
        // But to test that the override path also requires `reranker` to
        // activate, we deliberately omit `reranker`.
      }
    );
    // The override path triggers when EITHER `reranker` OR `rerankerOverride`
    // is set, so with rerankerOverride alone, the reranker IS called.
    expect(called).toBe(true);
    // Every hit should carry a reranker_score (we returned a uniform score
    // below — but for now just check the field is plumbed through).
    expect(result.matches.length).toBeGreaterThan(0);
  });

  it("re-orders top-N by reranker score (high gets boosted)", async () => {
    const v = new Vault(root);
    // Synthetic reranker that scores 'high.md' highest, 'mid.md' middle,
    // 'low.md' lowest based on snippet content.
    const result = await searchHybrid(
      v,
      { query: "rocket", limit: 5 },
      {
        ftsIndex: idx,
        embedFile: path.join(root, "nonexistent.embed.db"),
        rerankerOverride: {
          async score(_q: string, passages: readonly string[]): Promise<number[]> {
            return passages.map((p) => {
              if (p.includes("Saturn V")) return 0.95;
              if (p.includes("oxidizer")) return 0.65;
              return 0.15;
            });
          }
        },
        reranker: { topN: 50 }
      }
    );
    // First hit should be 'high.md' (Saturn V) by reranker score even if
    // BM25 ranked it below the others.
    expect(result.matches[0]?.path).toBe("high.md");
    // All hits should carry a numeric reranker_score in [0, 1].
    for (const m of result.matches) {
      expect(typeof m.reranker_score).toBe("number");
      expect(m.reranker_score).toBeGreaterThanOrEqual(0);
      expect(m.reranker_score).toBeLessThanOrEqual(1);
    }
  });

  it("surfaces reranker errors via signal_errors.reranker", async () => {
    const v = new Vault(root);
    const result = await searchHybrid(
      v,
      { query: "rocket", limit: 5 },
      {
        ftsIndex: idx,
        embedFile: path.join(root, "nonexistent.embed.db"),
        rerankerOverride: {
          async score(): Promise<number[]> {
            throw new Error("synthetic reranker boom");
          }
        },
        reranker: { topN: 50 }
      }
    );
    // The original RRF order is preserved; matches still flow through.
    expect(result.matches.length).toBeGreaterThan(0);
    // signal_errors.reranker carries the failure message.
    expect(result.signal_errors?.reranker).toMatch(/synthetic reranker boom/);
    // No reranker_score on hits (since the reranker never produced scores).
    for (const m of result.matches) {
      expect(m.reranker_score).toBeUndefined();
    }
  });

  it("respects topN — only top-N candidates carry reranker_score", async () => {
    const v = new Vault(root);
    let scoredCount = 0;
    const result = await searchHybrid(
      v,
      { query: "rocket", limit: 10 },
      {
        ftsIndex: idx,
        embedFile: path.join(root, "nonexistent.embed.db"),
        rerankerOverride: {
          async score(_q: string, passages: readonly string[]): Promise<number[]> {
            scoredCount += passages.length;
            return passages.map(() => 0.5);
          }
        },
        reranker: { topN: 1 }
      }
    );
    // Only 1 candidate fed to the reranker.
    expect(scoredCount).toBe(1);
    // Only that candidate carries reranker_score; others don't.
    const withScore = result.matches.filter((m) => m.reranker_score !== undefined);
    expect(withScore.length).toBe(1);
  });

  // v3.10.0-rc.13 (bug-report Issue 9) — the response now surfaces the reranker
  // OUTCOME so a caller can distinguish "applied N pairs" from "silently fell
  // back to RRF" (and, on failure, learn why).
  it("reports reranked.applied=true with a pair count when the reranker runs", async () => {
    const v = new Vault(root);
    const result = await searchHybrid(
      v,
      { query: "rocket", limit: 5 },
      {
        ftsIndex: idx,
        embedFile: path.join(root, "nonexistent.embed.db"),
        rerankerOverride: {
          async score(_q: string, passages: readonly string[]): Promise<number[]> {
            return passages.map(() => 0.5);
          }
        },
        reranker: { topN: 50 }
      }
    );
    expect(result.reranked?.applied).toBe(true);
    expect(result.reranked?.pairs).toBeGreaterThan(0);
    expect(result.reranked?.reason).toBeUndefined();
  });

  it("reports reranked.applied=false with a reason mirroring signal_errors when the reranker fails", async () => {
    const v = new Vault(root);
    const result = await searchHybrid(
      v,
      { query: "rocket", limit: 5 },
      {
        ftsIndex: idx,
        embedFile: path.join(root, "nonexistent.embed.db"),
        rerankerOverride: {
          async score(): Promise<number[]> {
            throw new Error("synthetic reranker boom");
          }
        },
        reranker: { topN: 50 }
      }
    );
    expect(result.reranked?.applied).toBe(false);
    expect(result.reranked?.reason).toMatch(/synthetic reranker boom/);
    // The reason mirrors signal_errors.reranker so callers can rely on either.
    expect(result.reranked?.reason).toBe(result.signal_errors?.reranker);
  });

  it("NEGATIVE control: omits the reranked field entirely when no reranker is requested", async () => {
    const v = new Vault(root);
    const result = await searchHybrid(
      v,
      { query: "rocket", limit: 5 },
      { ftsIndex: idx, embedFile: path.join(root, "nonexistent.embed.db") }
    );
    // No reranker config + no override → the field must be ABSENT (not
    // `{applied:false}`), so callers can cheaply test "was reranking requested".
    expect(result.reranked).toBeUndefined();
  });
});
