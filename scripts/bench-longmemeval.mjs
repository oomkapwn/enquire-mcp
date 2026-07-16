#!/usr/bin/env node
// v3.9.0-rc.19 — LongMemEval RETRIEVAL benchmark harness.
//
// What this measures (and what it does NOT):
//   • enquire-mcp is a RETRIEVER over a vault, not an answer-generating chat
//     assistant. So this harness reports **retrieval quality** — recall@k /
//     MRR / NDCG@k of the *answer-bearing session(s)* for each LongMemEval
//     question — using the SAME IR metrics as `src/eval.ts` / the
//     `enquire-mcp eval` CLI / docs/benchmarks.md.
//   • It does NOT report LongMemEval's end-to-end QA accuracy (that needs an
//     LLM to generate an answer from the retrieved context, which is the
//     calling agent's job, not the memory layer's). Conflating the two would
//     be an overclaim — see CLAUDE.md "claimed-guarantee vs reality".
//
// LongMemEval (Wu et al. 2024, arXiv:2410.10813) instance shape (per the
// public dataset):
//   {
//     "question_id": "...",            // "..._abs" = abstention (no in-haystack answer)
//     "question_type": "single-session-user" | "multi-session" | "temporal-reasoning" | ...,
//     "question": "...",
//     "answer": "...",
//     "question_date": "YYYY/MM/DD (HH:MM)",
//     "haystack_session_ids": ["s1", "s2", ...],
//     "haystack_dates": ["...", ...],
//     "haystack_sessions": [ [ {"role":"user","content":"..."},
//                              {"role":"assistant","content":"...","has_answer":true} ], ... ],
//     "answer_session_ids": ["s3", ...]   // the evidence-bearing session(s)
//   }
// Each question carries its OWN haystack — so the harness materializes one
// temp vault PER question, indexes it, runs one search, scores, tears down.
// That's why a full longmemeval_s run is heavy (hundreds of sessions × N
// questions) and is a maintainer-gated step, not a CI gate.
//
// The dataset is NOT committed (size + licensing). Download it yourself:
//   https://github.com/xiaowu0162/LongMemEval  (longmemeval_s / _m / _oracle)
// then:
//   npm run build && node scripts/bench-longmemeval.mjs --dataset <path-to.json> [--limit N] [--k 10] [--embeddings]
//
// `sessionToMarkdown` / `sessionNotePath` / `relevantSessionPaths` /
// `isAbstention` / `aggregateByType` are exported pure (no dist dependency)
// for unit testing (tests/longmemeval-harness.test.ts).

import { existsSync, promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const distDir = path.join(repoRoot, "dist");

// ─── Pure, testable helpers (no dist / no I/O) ──────────────────────────────

/** Sanitize a session id into a stable, safe vault note path under `sessions/`. */
export function sessionNotePath(sessionId) {
  const safe = String(sessionId).replace(/[^a-zA-Z0-9_-]/g, "_");
  return `sessions/${safe}.md`;
}

/**
 * Render one haystack session (array of {role, content} turns) as a markdown
 * note body. Deterministic — no dates/RNG beyond the passed `date`.
 */
export function sessionToMarkdown(session, sessionId, date) {
  const lines = [`# Session ${sessionId}`];
  if (date) lines.push(`*${date}*`);
  lines.push("");
  for (const turn of session ?? []) {
    if (!turn || typeof turn.content !== "string") continue;
    const role = turn.role === "assistant" ? "Assistant" : "User";
    lines.push(`**${role}:** ${turn.content}`, "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * The set of vault note paths that are ground-truth "relevant" for a question
 * — the answer-bearing session(s). Prefers explicit `answer_session_ids`;
 * falls back to sessions whose turns carry `has_answer: true`. Returns an
 * EMPTY set for abstention questions (no in-haystack evidence) — callers must
 * handle that (recall is undefined; the question tests abstention, not recall).
 */
export function relevantSessionPaths(instance) {
  const ids = new Set();
  if (Array.isArray(instance?.answer_session_ids)) {
    for (const id of instance.answer_session_ids) ids.add(id);
  }
  if (ids.size === 0 && Array.isArray(instance?.haystack_sessions)) {
    const sessIds = instance.haystack_session_ids ?? [];
    instance.haystack_sessions.forEach((sess, i) => {
      if (Array.isArray(sess) && sess.some((t) => t?.has_answer)) {
        ids.add(sessIds[i] ?? `idx-${i}`);
      }
    });
  }
  return new Set([...ids].map(sessionNotePath));
}

/** LongMemEval abstention questions (id suffix "_abs") have no in-haystack answer. */
export function isAbstention(instance) {
  return typeof instance?.question_id === "string" && instance.question_id.endsWith("_abs");
}

/**
 * Average recall/mrr/ndcg/hit-rate per question_type. Input is the array of
 * per-instance scores `{type, recall, mrr, ndcg, hit}`. Pure.
 */
export function aggregateByType(perInstance) {
  const byType = new Map();
  for (const r of perInstance) {
    const t = r.type ?? "unknown";
    if (!byType.has(t)) byType.set(t, { count: 0, recall: 0, mrr: 0, ndcg: 0, hits: 0 });
    const agg = byType.get(t);
    agg.count += 1;
    agg.recall += r.recall;
    agg.mrr += r.mrr;
    agg.ndcg += r.ndcg;
    agg.hits += r.hit ? 1 : 0;
  }
  const rows = [];
  for (const [type, a] of byType) {
    rows.push({
      type,
      count: a.count,
      recall: a.recall / a.count,
      mrr: a.mrr / a.count,
      ndcg: a.ndcg / a.count,
      hit_rate: a.hits / a.count
    });
  }
  rows.sort((x, y) => x.type.localeCompare(y.type));
  return rows;
}

// ─── v3.11.6-rc.10 (C-2) — OHS-comparable peer-protocol aggregation ──────────
// The competitive study's C-2: publish an apples-to-apples LongMemEval-S
// retrieval number vs `flowing-abyss/obsidian-hybrid-search` (OHS). OHS's public
// protocol is scope-per-question (each query searches ONLY its own generated
// mini-vault — which this harness already models by materializing one temp vault
// per question) at k=10, reporting nDCG@5/@10, MRR, Hit@1/@5, Recall@10, AllRel@10
// grouped by LongMemEval `question_type`. These pure aggregators produce that
// exact shape from per-instance scores so the number is one command from the
// dataset. (Metric COMPUTATION uses the rc.5 `src/eval.ts` functions in main();
// AGGREGATION is pure + unit-testable here, mirroring `aggregateByType`.)

/** The OHS-comparable metric keys, in display order. */
export const OHS_METRICS = ["ndcg_5", "ndcg_10", "mrr", "hit_1", "hit_5", "recall_10", "all_rel_10"];

/** Mean of every OHS metric over a list of per-instance score objects. Pure. */
function meanMetrics(rows) {
  const out = { n: rows.length };
  for (const m of OHS_METRICS) {
    out[m] = rows.length ? Math.round((rows.reduce((s, r) => s + (r[m] ?? 0), 0) / rows.length) * 10000) / 10000 : 0;
  }
  return out;
}

/**
 * Aggregate per-instance OHS-metric scores into `{ overall, by_category }`,
 * where `by_category` is keyed by `question_type` (the LongMemEval category).
 * Each value is the mean of every OHS metric over that group. Pure.
 * Categories are sorted weakest-nDCG@5 first in the returned array form via
 * {@link byCategoryRows}, matching OHS's "diagnose the weak slice first" flow.
 */
export function aggregateByCategory(scored) {
  const groups = new Map();
  for (const r of scored) {
    const t = r.type ?? "unknown";
    if (!groups.has(t)) groups.set(t, []);
    groups.get(t).push(r);
  }
  const by_category = {};
  for (const [type, rows] of groups) by_category[type] = meanMetrics(rows);
  return { overall: meanMetrics(scored), by_category };
}

/** `by_category` as an array sorted weakest-nDCG@5 first (the diagnostic order). */
export function byCategoryRows(byCategory) {
  return Object.entries(byCategory)
    .map(([type, m]) => ({ type, ...m }))
    .sort((a, b) => a.ndcg_5 - b.ndcg_5);
}

/**
 * Per-category metric delta between a baseline run and a second run (e.g.
 * `--recency-weight` OFF vs ON) — the differentiator diagnostic. For each
 * category present in both, returns `after - before` per OHS metric. Pure.
 * Leads the C-2 write-up: freshness helps exactly the temporal-reasoning /
 * knowledge-update / preference categories where a static retriever is weakest.
 */
export function recencyDelta(baseByCategory, afterByCategory) {
  const out = {};
  for (const type of Object.keys(baseByCategory)) {
    const b = baseByCategory[type];
    const a = afterByCategory[type];
    if (!a) continue;
    const d = { n: b.n };
    for (const m of OHS_METRICS) d[m] = Math.round(((a[m] ?? 0) - (b[m] ?? 0)) * 10000) / 10000;
    out[type] = d;
  }
  return out;
}

// ─── CLI (skipped when imported by tests) ───────────────────────────────────

function parseArgs(argv) {
  const args = {
    dataset: null,
    limit: Infinity,
    k: 10,
    embeddings: false,
    // v3.11.6-rc.10 (C-2) — peer-protocol options.
    output: null, // write the full result JSON (raw per-category, for publishing)
    recencyCompare: false, // also run with --recency-weight ON and report the by-category delta
    recencyWeight: 0.3, // the ON-pass weight for --recency-compare
    staleDays: 365
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dataset") args.dataset = argv[++i];
    else if (a === "--limit") args.limit = Number.parseInt(argv[++i], 10);
    else if (a === "--k") args.k = Number.parseInt(argv[++i], 10);
    else if (a === "--embeddings") args.embeddings = true;
    else if (a === "--output") args.output = argv[++i];
    else if (a === "--recency-compare") args.recencyCompare = true;
    else if (a === "--recency-weight") args.recencyWeight = Number.parseFloat(argv[++i]);
    else if (a === "--stale-days") args.staleDays = Number.parseInt(argv[++i], 10);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dataset || !existsSync(args.dataset)) {
    process.stderr.write(
      [
        "enquire LongMemEval harness — dataset not found.",
        "",
        "This measures RETRIEVAL recall@k / MRR / NDCG@k of the answer-bearing",
        "session(s) — NOT end-to-end QA accuracy (enquire is a retriever).",
        "",
        "Download the dataset (not committed — size + licensing):",
        "  https://github.com/xiaowu0162/LongMemEval  (longmemeval_s / _m / _oracle)",
        "then run:",
        "  npm run build && node scripts/bench-longmemeval.mjs --dataset <path.json> [--limit N] [--k 10] [--embeddings]",
        ""
      ].join("\n")
    );
    process.exit(2);
  }

  const raw = JSON.parse(await fs.readFile(args.dataset, "utf8"));
  const instances = Array.isArray(raw) ? raw : (raw.questions ?? []);
  if (instances.length === 0) {
    process.stderr.write(`enquire LongMemEval: ${args.dataset} contained no instances\n`);
    process.exit(2);
  }

  const { Vault } = await import(path.join(distDir, "vault.js"));
  const { FtsIndex } = await import(path.join(distDir, "fts5.js"));
  const { syncFtsIndex } = await import(path.join(distDir, "server.js"));
  const { searchHybrid } = await import(path.join(distDir, "tools", "index.js"));
  // v3.11.6-rc.10 (C-2) — the rc.5 OHS-comparable metric set.
  const { recallAtK, reciprocalRank, ndcgAtK, hitAtK, allRelevantAtK } = await import(path.join(distDir, "eval.js"));

  const k = args.k;
  /** Compute the full OHS metric set for one question's retrieved paths. */
  const scoreOhs = (retrieved, relevant, type) => ({
    type,
    ndcg_5: ndcgAtK(retrieved, relevant, 5),
    ndcg_10: ndcgAtK(retrieved, relevant, 10),
    mrr: reciprocalRank(retrieved, relevant, k),
    hit_1: hitAtK(retrieved, relevant, 1) ? 1 : 0,
    hit_5: hitAtK(retrieved, relevant, 5) ? 1 : 0,
    recall_10: recallAtK(retrieved, relevant, 10),
    all_rel_10: allRelevantAtK(retrieved, relevant, 10) ? 1 : 0
  });

  const base = []; // recency OFF (the headline)
  const withRecency = []; // recency ON (only when --recency-compare)
  let abstentions = 0;
  let processed = 0;
  const total = Math.min(instances.length, args.limit);
  process.stderr.write(
    `enquire LongMemEval: ${total} question(s), k=${k}, embeddings=${args.embeddings ? "on" : "off (BM25+TF-IDF)"}` +
      `${args.recencyCompare ? `, recency-compare w=${args.recencyWeight}` : ""}\n`
  );

  for (let qi = 0; qi < total; qi++) {
    const inst = instances[qi];
    if (!inst || typeof inst.question !== "string") continue;
    if (isAbstention(inst)) {
      abstentions += 1;
      continue; // abstention questions have no in-haystack relevant session
    }
    const relevant = relevantSessionPaths(inst);
    if (relevant.size === 0) continue; // can't score without ground truth

    const vaultRoot = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-lme-vault-"));
    const idxDir = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-lme-idx-"));
    try {
      const sessIds = inst.haystack_session_ids ?? [];
      const dates = inst.haystack_dates ?? [];
      await fs.mkdir(path.join(vaultRoot, "sessions"), { recursive: true });
      for (let si = 0; si < (inst.haystack_sessions?.length ?? 0); si++) {
        const sid = sessIds[si] ?? `idx-${si}`;
        const md = sessionToMarkdown(inst.haystack_sessions[si], sid, dates[si]);
        await fs.writeFile(path.join(vaultRoot, sessionNotePath(sid)), md, "utf8");
      }
      const vault = new Vault(vaultRoot);
      const ftsIndex = new FtsIndex({ file: path.join(idxDir, "lme.fts5.db"), vaultRoot: vault.root });
      await syncFtsIndex(vault, ftsIndex);
      const type = inst.question_type ?? "unknown";
      // scope-per-question: this vault IS the question's LongMemEval haystack.
      const r0 = await searchHybrid(vault, { query: inst.question, limit: k }, { ftsIndex });
      base.push(
        scoreOhs(
          r0.matches.map((m) => m.path),
          relevant,
          type
        )
      );
      if (args.recencyCompare) {
        const r1 = await searchHybrid(
          vault,
          { query: inst.question, limit: k },
          { ftsIndex, recency: { weight: args.recencyWeight, staleDays: args.staleDays } }
        );
        withRecency.push(
          scoreOhs(
            r1.matches.map((m) => m.path),
            relevant,
            type
          )
        );
      }
      ftsIndex.close?.();
      processed += 1;
      if (processed % 25 === 0) process.stderr.write(`  …${processed}/${total}\n`);
    } finally {
      await fs.rm(vaultRoot, { recursive: true, force: true });
      await fs.rm(idxDir, { recursive: true, force: true });
    }
  }

  const agg = aggregateByCategory(base);
  const fmt = (m) => `${m.toFixed(4)}`;

  // ── Disclosure header (per the C-2 honest-publishing bar) ──
  process.stdout.write(`\n=== enquire LongMemEval-S RETRIEVAL (peer-protocol; scope-per-question, k=${k}) ===\n`);
  process.stdout.write(
    `embedding backend: ${args.embeddings ? "LOCAL on-device (transformers.js)" : "OFF (BM25 + TF-IDF only)"} — ` +
      "NOT a cloud model; a cloud-embedding peer number (e.g. bge-m3) is a different measurement.\n"
  );
  process.stdout.write(`scored ${base.length} question(s) · ${abstentions} abstention(s) skipped\n\n`);
  process.stdout.write(
    `overall  nDCG@5=${fmt(agg.overall.ndcg_5)}  nDCG@10=${fmt(agg.overall.ndcg_10)}  MRR=${fmt(agg.overall.mrr)}  ` +
      `Hit@1=${fmt(agg.overall.hit_1)}  Hit@5=${fmt(agg.overall.hit_5)}  Recall@10=${fmt(agg.overall.recall_10)}  ` +
      `AllRel@10=${fmt(agg.overall.all_rel_10)}\n\n`
  );
  process.stdout.write("by category (weakest nDCG@5 first):\n");
  for (const row of byCategoryRows(agg.by_category)) {
    process.stdout.write(
      `  ${row.type.padEnd(26)} n=${String(row.n).padStart(4)}  nDCG@5=${fmt(row.ndcg_5)}  MRR=${fmt(row.mrr)}  ` +
        `Recall@10=${fmt(row.recall_10)}  AllRel@10=${fmt(row.all_rel_10)}\n`
    );
  }

  let recencyReport = null;
  if (args.recencyCompare && withRecency.length > 0) {
    const aggR = aggregateByCategory(withRecency);
    const delta = recencyDelta(agg.by_category, aggR.by_category);
    recencyReport = { weight: args.recencyWeight, stale_days: args.staleDays, overall: aggR.overall, delta };
    process.stdout.write(
      `\n--- freshness differentiator: --recency-weight ${args.recencyWeight} ON vs OFF (Δ nDCG@5) ---\n`
    );
    // Highlight the categories freshness is designed to help.
    for (const row of byCategoryRows(delta)) {
      const sign = row.ndcg_5 >= 0 ? "+" : "";
      process.stdout.write(
        `  ${row.type.padEnd(26)} ΔnDCG@5=${sign}${row.ndcg_5.toFixed(4)}  ΔMRR=${sign}${row.mrr.toFixed(4)}\n`
      );
    }
    process.stdout.write(
      "  (temporal-reasoning / knowledge-update / preference are where a static retriever is weakest)\n"
    );
  }

  if (args.output) {
    const payload = {
      meta: {
        protocol: "longmemeval-s-scope-per-question",
        k,
        embeddings: args.embeddings,
        embedding_backend: args.embeddings ? "local-transformers.js" : "none-bm25-tfidf",
        scored: base.length,
        abstentions_skipped: abstentions
      },
      summary: agg.overall,
      by_category: agg.by_category,
      ...(recencyReport ? { recency: recencyReport } : {})
    };
    await fs.writeFile(args.output, `${JSON.stringify(payload, null, 2)}\n`);
    process.stderr.write(`\nwrote result JSON → ${args.output}\n`);
  }

  process.stdout.write(
    "\nNOTE: retrieval quality (does search rank the answer-bearing session near the top), NOT end-to-end QA\n" +
      "accuracy (answer generation is the calling agent's job). See docs/EVALUATION.md for the publishing bar.\n"
  );
}

const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isEntrypoint) {
  await main();
}
