#!/usr/bin/env node
// Context-savings benchmark for enquire-mcp (v3.11.2).
//
// Measures the headline value prop of `obsidian_context_pack` for AI agents:
// how much LESS context an agent consumes by asking enquire for a budget-capped
// pack vs the naive "search → read every top hit in full" loop it would
// otherwise run. This is OUR niche-correct analog of code-memory tools'
// "Nx fewer tokens" claim — measured on OUR data, never asserted.
//
// Per question, two paths over the SAME hybrid retrieval:
//   (a) PACK     — `contextPack(query, budget_tokens)` → the assembled, capped pack
//   (b) BASELINE — the FULL bodies of the top-K notes that hybrid search returns
//                  (what an agent reads when it opens each hit via read_note)
// Token estimate = chars / 4 (standard rough heuristic; documented limitation).
// Reports baseline_tokens, pack_tokens, and the savings ratio per question + mean.
//
// Run:  npm run build && npm run bench:context   (alias: node scripts/bench-context.mjs)
//
// IMPORTANT — anti-overclaim contract: this script PRINTS a number when run, but
// NO headline figure is committed to the README/docs from a synthetic-vault run.
// A published "Nx less context" claim requires a reference-hardware run on a
// representative vault + maintainer sign-off (same gate as the LongMemEval score).
// See docs/EVALUATION_PLAN.md §"Context efficiency" + docs/benchmarks.md.
//
// Determinism: fixed note bodies (no Date.now/random), fixed mtimes via utimes,
// per-run tmpdir torn down at the end.

import { existsSync, promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// ── Pure, testable helpers (imported by tests/bench-context.test.ts) ─────────

/** Rough token estimate: ~4 chars/token. Deterministic; documented heuristic. */
export function estimateTokens(text) {
  return Math.ceil((text?.length ?? 0) / 4);
}

/**
 * Context-savings ratio = baseline_tokens / pack_tokens (how many times LESS
 * context the pack costs vs reading the same hits in full). Returns 1 when the
 * pack is not actually smaller (no savings), and never divides by zero.
 */
export function savingsRatio(baselineTokens, packTokens) {
  if (packTokens <= 0) return 0;
  if (baselineTokens <= packTokens) return 1; // pack didn't save anything
  return baselineTokens / packTokens;
}

// ── CLI entrypoint (skipped when imported by the test) ───────────────────────

const __filename = fileURLToPath(import.meta.url);
const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === __filename;

const QUESTIONS = [
  "how does hybrid retrieval combine BM25 and embeddings",
  "what is the plan for the RAG bot project",
  "explain HNSW and why it scales vector search",
  "what conclusions did I reach about reranking quality",
  "how is the vault index cache structured and refreshed"
];

// Compact deterministic vault — a handful of medium notes per topic so the
// "read every hit in full" baseline is meaningfully larger than the capped pack.
function buildVaultNotes() {
  const para = (seed) => `${seed} `.repeat(80).trim(); // ~medium body so full-read baseline is non-trivial
  return {
    "Reference/Hybrid.md": `---\ntitle: Hybrid retrieval\ntags: [reference, retrieval]\n---\n\n# Hybrid retrieval\n\nHybrid retrieval fuses lexical BM25 with dense ML embeddings via reciprocal rank fusion (RRF). ${para("BM25 captures exact keyword overlap while embeddings capture semantic similarity, and RRF merges the two ranked lists so a document strong on either signal surfaces.")}\n`,
    "Reference/HNSW.md": `---\ntitle: HNSW\ntags: [reference, vector-index]\n---\n\n# HNSW\n\nHNSW is a graph-based approximate nearest-neighbour index. ${para("It builds a hierarchical navigable small-world graph so vector search scales to millions of vectors with logarithmic query cost, trading a little recall for large speedups over brute-force cosine.")}\n`,
    "Reference/Reranker.md": `---\ntitle: Reranker\ntags: [reference, retrieval]\n---\n\n# Cross-encoder reranking\n\nA cross-encoder reranker re-scores the fused candidate list. ${para("On our ablation the BGE cross-encoder reranker improved ranking quality materially over fusion alone; reranking is the last stage and reorders the top candidates by a joint query-document score.")}\n`,
    "Projects/RAG-bot.md": `---\ntitle: RAG bot\ntags: [project, active]\n---\n\n# RAG bot project\n\nPlan: build a retrieval-augmented bot over this vault. ${para("The plan is to encode the query, retrieve top-K passages with hybrid search, assemble a budget-capped context pack, and generate the answer grounded in the retrieved notes with citations back to the source files.")}\n`,
    "Reference/Cache.md": `---\ntitle: Index cache\ntags: [reference, infra]\n---\n\n# Index cache\n\nThe persistent index is cached per-vault. ${para("FTS5 and the embedding store live under the OS cache dir keyed by a vault hash; setup is incremental and re-embeds only changed notes, and the HNSW sidecar rebuilds on a signature mismatch.")}\n`,
    "Daily/2026-05-15.md": `---\ntitle: Daily\ntags: [daily]\n---\n\n# Daily 2026-05-15\n\n${para("Reviewed reranking quality and concluded the cross-encoder is worth the latency on this corpus; noted the RAG bot plan and the hybrid retrieval design as the next steps.")}\n`
  };
}

async function main() {
  const projectRoot = path.resolve(path.dirname(__filename), "..");
  const distDir = path.join(projectRoot, "dist");
  if (!existsSync(path.join(distDir, "tools", "index.js"))) {
    process.stderr.write("dist/ not found — run `npm run build` first.\n");
    process.exit(1);
  }
  const EMBEDDER_ALIAS = "bge";
  const { contextPack, searchHybrid } = await import(path.join(distDir, "tools", "index.js"));
  const { Vault } = await import(path.join(distDir, "vault.js"));
  const { FtsIndex } = await import(path.join(distDir, "fts5.js"));
  const { syncFtsIndex, syncEmbedDb } = await import(path.join(distDir, "server.js"));

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-bench-context-"));
  const cacheDir = path.join(root, ".cache");
  await fs.mkdir(cacheDir, { recursive: true });
  const FIXED_MTIME = new Date("2026-05-15T12:00:00Z");
  let ftsIndex = null;
  try {
    const notes = buildVaultNotes();
    for (const [rel, body] of Object.entries(notes)) {
      const abs = path.join(root, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, body);
      await fs.utimes(abs, FIXED_MTIME, FIXED_MTIME);
    }

    const vault = new Vault(root);
    const ftsFile = path.join(cacheDir, "bench.fts5.db");
    const embedFile = path.join(cacheDir, "bench.embed.db");
    ftsIndex = new FtsIndex({ file: ftsFile, vaultRoot: vault.root });
    await ftsIndex.open();
    await syncFtsIndex(vault, ftsIndex);

    let embedReady = false;
    try {
      const { loadEmbedder, resolveModel } = await import(path.join(distDir, "embeddings.js"));
      const { EmbedDb } = await import(path.join(distDir, "embed-db.js"));
      const m = resolveModel(EMBEDDER_ALIAS);
      const db = new EmbedDb({ file: embedFile, vaultRoot: vault.root, modelAlias: m.alias, dim: m.dim });
      await db.open();
      const embedder = await loadEmbedder(EMBEDDER_ALIAS);
      await syncEmbedDb(vault, db, embedder);
      db.close();
      embedReady = true;
    } catch (e) {
      process.stderr.write(
        `embeddings unavailable (${(e?.message ?? e).toString().slice(0, 80)}) — measuring FTS-only pack\n`
      );
    }
    const ctx = { ftsIndex, embedFile: embedReady ? embedFile : "" };

    const rows = [];
    for (const query of QUESTIONS) {
      const pack = await contextPack(vault, { query, budget_tokens: 1500 }, ctx);
      const packTokens = estimateTokens(pack.bundle);
      // BASELINE: the full bodies of the top-K hits the agent would open via read_note.
      const search = await searchHybrid(vault, { query, limit: 5 }, ctx);
      let baselineChars = 0;
      for (const m of search.matches ?? []) {
        try {
          const note = await vault.readNote(vault.resolveInside(m.path), undefined);
          baselineChars += note.parsed.body.length;
        } catch {
          /* skip */
        }
      }
      const baselineTokens = Math.ceil(baselineChars / 4);
      rows.push({ query, baselineTokens, packTokens, ratio: savingsRatio(baselineTokens, packTokens) });
    }

    const mean = rows.reduce((a, r) => a + r.ratio, 0) / (rows.length || 1);
    process.stdout.write(`\n# Context-savings — synthetic vault (${embedReady ? "hybrid" : "FTS-only"})\n\n`);
    process.stdout.write("| question | baseline tokens (read-all) | pack tokens | savings |\n");
    process.stdout.write("|---|---:|---:|---:|\n");
    for (const r of rows) {
      process.stdout.write(
        `| ${r.query.slice(0, 48)} | ${r.baselineTokens} | ${r.packTokens} | ${r.ratio.toFixed(1)}× |\n`
      );
    }
    process.stdout.write(
      `\n**Mean savings: ${mean.toFixed(1)}× less context** (synthetic vault, ~4 chars/token estimate).\n`
    );
    process.stdout.write(
      "\n> Methodology only — NOT a published claim. A README figure needs a reference-vault run + sign-off (docs/EVALUATION_PLAN.md).\n"
    );
    await fs
      .writeFile(
        path.join(projectRoot, "bench", "context-savings.json"),
        JSON.stringify({ rows, mean, embedReady, note: "synthetic vault; methodology only" }, null, 2)
      )
      .catch(() => {
        /* bench/ may not exist; non-fatal */
      });
  } finally {
    try {
      ftsIndex?.close();
    } catch {
      /* best-effort */
    }
    await fs.rm(root, { recursive: true, force: true });
  }
}

if (isEntrypoint) {
  main().catch((e) => {
    process.stderr.write(`bench-context failed: ${e?.stack ?? e}\n`);
    process.exit(1);
  });
}
