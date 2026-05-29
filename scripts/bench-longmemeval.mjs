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

// ─── CLI (skipped when imported by tests) ───────────────────────────────────

function parseArgs(argv) {
  const args = { dataset: null, limit: Infinity, k: 10, embeddings: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dataset") args.dataset = argv[++i];
    else if (a === "--limit") args.limit = Number.parseInt(argv[++i], 10);
    else if (a === "--k") args.k = Number.parseInt(argv[++i], 10);
    else if (a === "--embeddings") args.embeddings = true;
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
  const { recallAtK, reciprocalRank, ndcgAtK } = await import(path.join(distDir, "eval.js"));

  const k = args.k;
  const perInstance = [];
  let abstentions = 0;
  let processed = 0;
  const total = Math.min(instances.length, args.limit);
  process.stderr.write(
    `enquire LongMemEval: ${total} question(s), k=${k}, embeddings=${args.embeddings ? "on" : "off (BM25+TF-IDF)"}\n`
  );

  for (let qi = 0; qi < total; qi++) {
    const inst = instances[qi];
    if (!inst || typeof inst.question !== "string") continue;
    if (isAbstention(inst)) {
      abstentions += 1;
      continue; // abstention questions have no in-haystack relevant session
    }
    const relevant = relevantSessionPaths(inst);
    if (relevant.size === 0) continue; // can't score recall without ground truth

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
      const result = await searchHybrid(vault, { query: inst.question, limit: k }, { ftsIndex });
      const retrieved = result.matches.map((m) => m.path);
      perInstance.push({
        type: inst.question_type ?? "unknown",
        recall: recallAtK(retrieved, relevant, k),
        mrr: reciprocalRank(retrieved, relevant, k),
        ndcg: ndcgAtK(retrieved, relevant, k),
        hit: retrieved.slice(0, k).some((p) => relevant.has(p))
      });
      ftsIndex.close?.();
      processed += 1;
      if (processed % 25 === 0) process.stderr.write(`  …${processed}/${total}\n`);
    } finally {
      await fs.rm(vaultRoot, { recursive: true, force: true });
      await fs.rm(idxDir, { recursive: true, force: true });
    }
  }

  const round = (n) => Math.round(n * 10000) / 10000;
  const mean = (arr, f) => (arr.length ? arr.reduce((s, x) => s + f(x), 0) / arr.length : 0);
  process.stdout.write("\n=== LongMemEval RETRIEVAL quality (recall of answer-bearing sessions) ===\n");
  process.stdout.write(`scored ${perInstance.length} question(s) · ${abstentions} abstention(s) skipped · k=${k}\n\n`);
  process.stdout.write(`overall  recall@${k}=${round(mean(perInstance, (x) => x.recall))}  `);
  process.stdout.write(`MRR=${round(mean(perInstance, (x) => x.mrr))}  `);
  process.stdout.write(`NDCG@${k}=${round(mean(perInstance, (x) => x.ndcg))}  `);
  process.stdout.write(`hit-rate=${round(mean(perInstance, (x) => (x.hit ? 1 : 0)))}\n\n`);
  process.stdout.write("by question type:\n");
  for (const row of aggregateByType(perInstance)) {
    process.stdout.write(
      `  ${row.type.padEnd(28)} n=${String(row.count).padStart(4)}  recall@${k}=${round(row.recall)}  MRR=${round(row.mrr)}  hit=${round(row.hit_rate)}\n`
    );
  }
  process.stdout.write(
    "\nNOTE: retrieval recall, NOT end-to-end QA accuracy. Answer generation is the calling agent's job.\n"
  );
}

const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isEntrypoint) {
  await main();
}
