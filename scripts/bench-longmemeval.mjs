#!/usr/bin/env node
// v3.12.0-rc.17 — evidence-grade LongMemEval-S RETRIEVAL benchmark harness.
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
// Each question carries its OWN haystack. To match the closest peer's published
// scope protocol, the harness materializes every scored question into ONE
// temporary vault, builds ONE global index, and restricts each query to its
// question folder. This matters: BM25/TF-IDF corpus statistics come from the
// same global ~22k-note corpus as the peer protocol, while retrieval remains
// scope-per-question.
//
// The dataset is NOT committed (size + licensing). Download it yourself:
//   https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned
// then:
//   npm run build && node scripts/bench-longmemeval.mjs \
//     --dataset longmemeval_s_cleaned.json --dataset-source <official-url> \
//     --k 10 --embeddings --output <result.json>
//
// Pure helpers are exported (no dist dependency) for unit testing in
// tests/longmemeval-harness.test.ts.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { isEntrypoint } from "./lib/entrypoint.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const distDir = path.join(repoRoot, "dist");
export const OFFICIAL_LONGMEMEVAL_S_URL =
  "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json";
export const OFFICIAL_LONGMEMEVAL_S_SHA256 = "d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442";
export const OFFICIAL_LONGMEMEVAL_S_BYTES = 277_383_467;
export const OFFICIAL_LONGMEMEVAL_S_INSTANCES = 500;
export const OHS_COMPARATOR_COMMIT = "c0922d955f5bf5abaad14a11cbb3e11303cd6036";
const SAFE_QUESTION_ID = /^[A-Za-z0-9_-]+$/;
const LONGMEMEVAL_DATE = /^(\d{4})\/(\d{2})\/(\d{2})(?: \([^)]+\))?(?: (\d{2}):(\d{2}))?$/;

// ─── Pure, testable helpers (no dist / no I/O) ──────────────────────────────

/**
 * Stable scope-relative note path that exposes neither the source session id
 * nor its `answer_` prefix. LongMemEval source ids encode ground truth, so
 * putting them in filenames/headings would contaminate a retrieval benchmark.
 */
export function sessionNotePath(questionId, sessionIndex) {
  if (typeof questionId !== "string" || !SAFE_QUESTION_ID.test(questionId)) {
    throw new Error(`unsafe LongMemEval question_id: ${String(questionId)}`);
  }
  if (!Number.isInteger(sessionIndex) || sessionIndex < 0) {
    throw new Error(`invalid LongMemEval session index: ${String(sessionIndex)}`);
  }
  return `${questionId}/${String(sessionIndex + 1).padStart(4, "0")}.md`;
}

/**
 * Render one haystack session as a label-free Markdown conversation. The
 * answer-bearing session id is intentionally absent from the note.
 */
export function sessionToMarkdown(session, date) {
  const lines = ["# Conversation", ""];
  if (date) lines.push(`Date: ${date}`, "");
  for (const turn of session ?? []) {
    if (!turn || typeof turn.content !== "string") continue;
    const role = turn.role === "assistant" ? "Assistant" : "User";
    lines.push(`## ${role}`, "", turn.content, "");
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
  const indexes = new Set();
  const sessionIds = instance?.haystack_session_ids ?? [];
  if (Array.isArray(instance?.answer_session_ids)) {
    for (const id of instance.answer_session_ids) {
      const index = sessionIds.indexOf(id);
      if (index >= 0) indexes.add(index);
    }
  }
  if (indexes.size === 0 && Array.isArray(instance?.haystack_sessions)) {
    instance.haystack_sessions.forEach((sess, i) => {
      if (Array.isArray(sess) && sess.some((t) => t?.has_answer)) indexes.add(i);
    });
  }
  return new Set([...indexes].map((index) => sessionNotePath(instance.question_id, index)));
}

/** LongMemEval abstention questions (id suffix "_abs") have no in-haystack answer. */
export function isAbstention(instance) {
  return (
    (typeof instance?.question_id === "string" && instance.question_id.endsWith("_abs")) ||
    (Array.isArray(instance?.answer_session_ids) && instance.answer_session_ids.length === 0)
  );
}

/** Parse LongMemEval's stable `YYYY/MM/DD (Day) HH:MM` date as UTC. */
export function parseLongMemEvalDate(value) {
  if (typeof value !== "string") return null;
  const match = LONGMEMEVAL_DATE.exec(value);
  if (!match) return null;
  const [, year, month, day, hour = "00", minute = "00"] = match;
  const timestamp = Date.UTC(
    Number.parseInt(year, 10),
    Number.parseInt(month, 10) - 1,
    Number.parseInt(day, 10),
    Number.parseInt(hour, 10),
    Number.parseInt(minute, 10)
  );
  const date = new Date(timestamp);
  if (
    date.getUTCFullYear() !== Number.parseInt(year, 10) ||
    date.getUTCMonth() !== Number.parseInt(month, 10) - 1 ||
    date.getUTCDate() !== Number.parseInt(day, 10) ||
    date.getUTCHours() !== Number.parseInt(hour, 10) ||
    date.getUTCMinutes() !== Number.parseInt(minute, 10)
  ) {
    return null;
  }
  return timestamp;
}

/**
 * Normalize a historical session mtime relative to its question date. This
 * preserves the dataset's age/order signal while making a recency comparison
 * independent of the calendar date on which the benchmark is executed.
 */
export function normalizedSessionMtimeMs(sessionDate, questionDate, anchorMs) {
  const sessionMs = parseLongMemEvalDate(sessionDate);
  const questionMs = parseLongMemEvalDate(questionDate);
  if (sessionMs === null || questionMs === null) {
    throw new Error(`invalid LongMemEval date pair: session=${String(sessionDate)} question=${String(questionDate)}`);
  }
  return anchorMs - Math.max(0, questionMs - sessionMs);
}

/**
 * Fail-fast schema validation for the cleaned LongMemEval-S publishing cohort.
 * Returns the input array so callers can validate inline before doing any
 * expensive indexing.
 */
export function validateLongMemEvalInstances(instances) {
  if (!Array.isArray(instances) || instances.length === 0) {
    throw new Error("LongMemEval dataset must be a non-empty JSON array");
  }
  const seen = new Set();
  for (let i = 0; i < instances.length; i++) {
    const item = instances[i];
    const at = `LongMemEval instance[${i}]`;
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`${at} must be an object`);
    for (const key of ["question_id", "question_type", "question", "question_date"]) {
      if (typeof item[key] !== "string" || item[key].trim() === "") throw new Error(`${at}.${key} must be non-empty`);
    }
    if (!SAFE_QUESTION_ID.test(item.question_id)) throw new Error(`${at}.question_id is not path-safe`);
    if (seen.has(item.question_id)) throw new Error(`${at}.question_id is duplicated`);
    seen.add(item.question_id);
    for (const key of ["haystack_session_ids", "haystack_dates", "haystack_sessions", "answer_session_ids"]) {
      if (!Array.isArray(item[key])) throw new Error(`${at}.${key} must be an array`);
    }
    const count = item.haystack_sessions.length;
    if (count === 0) throw new Error(`${at}.haystack_sessions must not be empty`);
    if (item.haystack_session_ids.length !== count || item.haystack_dates.length !== count) {
      throw new Error(`${at} haystack arrays are misaligned`);
    }
    if (parseLongMemEvalDate(item.question_date) === null) throw new Error(`${at}.question_date is invalid`);
    const sessionIdCounts = new Map();
    for (let si = 0; si < count; si++) {
      const sessionId = item.haystack_session_ids[si];
      if (typeof sessionId !== "string" || sessionId.length === 0) throw new Error(`${at} has an invalid session id`);
      sessionIdCounts.set(sessionId, (sessionIdCounts.get(sessionId) ?? 0) + 1);
      if (parseLongMemEvalDate(item.haystack_dates[si]) === null) throw new Error(`${at} has an invalid session date`);
      const session = item.haystack_sessions[si];
      if (!Array.isArray(session)) throw new Error(`${at}.haystack_sessions[${si}] must be an array`);
      for (let ti = 0; ti < session.length; ti++) {
        const turn = session[ti];
        if (!turn || typeof turn !== "object" || typeof turn.content !== "string") {
          throw new Error(`${at}.haystack_sessions[${si}][${ti}] has invalid content`);
        }
        if (turn.role !== "user" && turn.role !== "assistant") {
          throw new Error(`${at}.haystack_sessions[${si}][${ti}] has invalid role`);
        }
      }
    }
    for (const answerId of item.answer_session_ids) {
      const occurrences = typeof answerId === "string" ? (sessionIdCounts.get(answerId) ?? 0) : 0;
      if (occurrences === 0) {
        throw new Error(`${at} references a missing answer session`);
      }
      if (occurrences > 1) throw new Error(`${at} has an ambiguous duplicated answer session`);
    }
    if (!isAbstention(item) && item.answer_session_ids.length === 0) {
      throw new Error(`${at} has no ground-truth answer session`);
    }
  }
  return instances;
}

/** Dataset-level duplicate-id disclosure (cleaned S currently has distractor duplicates). */
export function duplicateSessionIdStats(instances) {
  let questions = 0;
  let extraOccurrences = 0;
  let answerAmbiguities = 0;
  for (const item of instances) {
    const counts = new Map();
    for (const id of item.haystack_session_ids ?? []) counts.set(id, (counts.get(id) ?? 0) + 1);
    const duplicateCounts = [...counts.values()].filter((count) => count > 1);
    if (duplicateCounts.length > 0) questions += 1;
    extraOccurrences += duplicateCounts.reduce((sum, count) => sum + count - 1, 0);
    for (const answerId of item.answer_session_ids ?? []) {
      if ((counts.get(answerId) ?? 0) > 1) answerAmbiguities += 1;
    }
  }
  return {
    questions_with_duplicate_session_ids: questions,
    extra_session_id_occurrences: extraOccurrences,
    answer_id_ambiguities: answerAmbiguities
  };
}

/** Exact canonical-cohort gate for a headline-shaped artifact. */
export function isCanonicalLongMemEvalS(dataset, selectedInstances) {
  return (
    dataset.sha256 === OFFICIAL_LONGMEMEVAL_S_SHA256 &&
    dataset.size_bytes === OFFICIAL_LONGMEMEVAL_S_BYTES &&
    dataset.total_instances === OFFICIAL_LONGMEMEVAL_S_INSTANCES &&
    selectedInstances === OFFICIAL_LONGMEMEVAL_S_INSTANCES
  );
}

/** Publication state from cohort identity plus exact clean implementation state. */
export function benchmarkArtifactStatus(canonicalCohort, implementation) {
  if (!canonicalCohort) return { status: "diagnostic-partial", partial: true, publishable: false };
  const publishable =
    typeof implementation?.git_commit === "string" &&
    /^[a-f0-9]{40}$/.test(implementation.git_commit) &&
    implementation.git_dirty === false;
  return {
    status: publishable ? "complete" : "diagnostic-untrusted",
    partial: false,
    publishable
  };
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
    datasetSource: null,
    limit: Infinity,
    k: 10,
    embeddings: false,
    output: null,
    recencyCompare: false,
    recencyWeight: 0.3,
    staleDays: 365
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const takeValue = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${a} requires a value`);
      i += 1;
      return value;
    };
    if (a === "--dataset") args.dataset = takeValue();
    else if (a === "--dataset-source") args.datasetSource = takeValue();
    else if (a === "--limit") args.limit = Number(takeValue());
    else if (a === "--k") args.k = Number(takeValue());
    else if (a === "--embeddings") args.embeddings = true;
    else if (a === "--output") args.output = takeValue();
    else if (a === "--recency-compare") args.recencyCompare = true;
    else if (a === "--recency-weight") args.recencyWeight = Number(takeValue());
    else if (a === "--stale-days") args.staleDays = Number(takeValue());
    else throw new Error(`unknown argument: ${String(a)}`);
  }
  return args;
}

function validateArgs(args) {
  if (!Number.isInteger(args.k) || args.k !== 10) {
    throw new Error(`LongMemEval peer protocol requires --k 10 (received ${String(args.k)})`);
  }
  if (args.limit !== Infinity && (!Number.isInteger(args.limit) || args.limit <= 0)) {
    throw new Error(`--limit must be a positive integer (received ${String(args.limit)})`);
  }
  if (!Number.isFinite(args.recencyWeight) || args.recencyWeight < 0 || args.recencyWeight > 1) {
    throw new Error(`--recency-weight must be between 0 and 1 (received ${String(args.recencyWeight)})`);
  }
  if (!Number.isInteger(args.staleDays) || args.staleDays <= 0) {
    throw new Error(`--stale-days must be a positive integer (received ${String(args.staleDays)})`);
  }
  if (args.datasetSource !== null) {
    try {
      const source = new URL(args.datasetSource);
      if (source.protocol !== "https:" && source.protocol !== "http:") {
        throw new Error("unsupported source protocol");
      }
    } catch {
      throw new Error(`--dataset-source must be an absolute HTTP(S) URL (received ${String(args.datasetSource)})`);
    }
  }
}

function elapsedMs(start) {
  return Math.round((performance.now() - start) * 100) / 100;
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

function countSignals(rows) {
  const counts = { bm25: 0, tfidf: 0, embeddings: 0 };
  for (const row of rows) {
    for (const signal of row.signals_used) counts[signal] += 1;
  }
  return counts;
}

async function implementationMetadata() {
  const pkg = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"));
  const git = (args) => {
    try {
      return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return null;
    }
  };
  const commit = git(["rev-parse", "HEAD"]);
  const status = git(["status", "--porcelain", "--untracked-files=no"]);
  return {
    package_version: pkg.version,
    git_commit: commit,
    git_dirty: status === null ? null : status.length > 0
  };
}

function environmentMetadata() {
  const cpus = os.cpus();
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpu_model: cpus[0]?.model ?? "unknown",
    logical_cpu_count: cpus.length,
    total_memory_bytes: os.totalmem()
  };
}

async function writeJsonAtomic(output, payload) {
  const absolute = path.resolve(output);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  const temp = `${absolute}.${process.pid}.tmp`;
  try {
    await fs.writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await fs.rename(temp, absolute);
  } finally {
    await fs.rm(temp, { force: true });
  }
}

async function sqliteFootprintBytes(file) {
  let bytes = 0;
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      bytes += (await fs.stat(`${file}${suffix}`)).size;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return bytes;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
    validateArgs(args);
  } catch (error) {
    process.stderr.write(`enquire LongMemEval: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
  if (!args.dataset || !existsSync(args.dataset)) {
    process.stderr.write(
      [
        "enquire LongMemEval harness — dataset not found.",
        "",
        "This measures RETRIEVAL recall@k / MRR / NDCG@k of the answer-bearing",
        "session(s) — NOT end-to-end QA accuracy (enquire is a retriever).",
        "",
        "Download the dataset (not committed — size + licensing):",
        `  ${OFFICIAL_LONGMEMEVAL_S_URL}`,
        "then run:",
        "  npm run build && node scripts/bench-longmemeval.mjs \\",
        "    --dataset longmemeval_s_cleaned.json --dataset-source <official-url> \\",
        "    --k 10 --embeddings --output <result.json>",
        ""
      ].join("\n")
    );
    process.exit(2);
  }
  if (args.output && path.resolve(args.output) === path.resolve(args.dataset)) {
    process.stderr.write("enquire LongMemEval: --output must not overwrite --dataset\n");
    process.exit(2);
  }

  const runStarted = performance.now();
  const generatedAt = new Date().toISOString();
  let datasetText;
  let parsed;
  try {
    datasetText = await fs.readFile(args.dataset, "utf8");
    parsed = JSON.parse(datasetText);
  } catch (error) {
    process.stderr.write(
      `enquire LongMemEval: invalid dataset JSON (${error instanceof Error ? error.message : String(error)})\n`
    );
    process.exit(2);
  }
  const instances = Array.isArray(parsed) ? parsed : parsed?.questions;
  try {
    validateLongMemEvalInstances(instances);
  } catch (error) {
    process.stderr.write(`enquire LongMemEval: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
  const dataset = {
    variant: "longmemeval-compatible",
    filename: path.basename(args.dataset),
    size_bytes: Buffer.byteLength(datasetText, "utf8"),
    sha256: createHash("sha256").update(datasetText).digest("hex"),
    official_download_url: OFFICIAL_LONGMEMEVAL_S_URL,
    declared_source_url: args.datasetSource,
    total_instances: instances.length,
    duplicate_session_ids: duplicateSessionIdStats(instances)
  };
  if (isCanonicalLongMemEvalS(dataset, instances.length)) dataset.variant = "longmemeval_s_cleaned";

  const { Vault } = await import(path.join(distDir, "vault.js"));
  const { FtsIndex } = await import(path.join(distDir, "fts5.js"));
  const { syncFtsIndex, syncEmbedDb } = await import(path.join(distDir, "server.js"));
  const { searchHybrid } = await import(path.join(distDir, "tools", "index.js"));

  let embedder = null;
  let embedModel = null;
  let EmbedDbCtor = null;
  if (args.embeddings) {
    try {
      const emb = await import(path.join(distDir, "embeddings.js"));
      ({ EmbedDb: EmbedDbCtor } = await import(path.join(distDir, "embed-db.js")));
      embedModel = emb.resolveModel(undefined); // the default local alias
      process.stderr.write(`loading local embedder '${embedModel.alias}' (one-time)…\n`);
      embedder = await emb.loadEmbedder(embedModel.alias);
    } catch (e) {
      process.stderr.write(
        `--embeddings requested but the local embedder failed to load (${(e?.message ?? e).toString().slice(0, 120)}).\n` +
          "Install the optional dep + pre-cache the model first:\n" +
          "  npm i @huggingface/transformers && node dist/index.js install-model multilingual\n" +
          "Refusing to run WITHOUT embeddings under an embeddings disclosure (honest-publishing bar).\n"
      );
      process.exit(2);
    }
  }
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

  const base = [];
  const withRecency = [];
  const perQuery = [];
  let abstentions = 0;
  const total = Math.min(instances.length, args.limit);
  const selected = instances.slice(0, total);
  const scorable = [];
  for (const inst of selected) {
    if (isAbstention(inst)) {
      abstentions += 1;
      continue;
    }
    const relevant = relevantSessionPaths(inst);
    if (relevant.size === 0) {
      process.stderr.write(`enquire LongMemEval: ${inst.question_id} has no scoreable ground truth\n`);
      process.exit(2);
    }
    scorable.push({ inst, relevant });
  }
  if (scorable.length === 0) {
    process.stderr.write("enquire LongMemEval: selected cohort contains no scoreable questions\n");
    process.exit(2);
  }

  process.stderr.write(
    `enquire LongMemEval: ${scorable.length} scored question(s), one global scoped vault, k=${k}, ` +
      `embeddings=${args.embeddings ? "on" : "off (BM25+TF-IDF)"}` +
      `${args.recencyCompare ? `, recency-compare w=${args.recencyWeight}` : ""}\n`
  );

  const vaultRoot = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-lme-vault-"));
  const idxDir = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-lme-idx-"));
  let ftsIndex = null;
  const timing = {
    materialize_ms: 0,
    fts_index_ms: 0,
    embedding_index_ms: 0,
    retime_ms: 0,
    base_search_ms: 0,
    recency_search_ms: 0
  };
  const indexFootprint = {
    fts_bytes: 0,
    embeddings_bytes: 0
  };
  let notesWritten = 0;
  try {
    const materializeStarted = performance.now();
    for (const { inst } of scorable) {
      await fs.mkdir(path.join(vaultRoot, inst.question_id), { recursive: true });
      for (let si = 0; si < inst.haystack_sessions.length; si++) {
        const relPath = sessionNotePath(inst.question_id, si);
        const absolute = path.join(vaultRoot, relPath);
        await fs.writeFile(absolute, sessionToMarkdown(inst.haystack_sessions[si], inst.haystack_dates[si]), "utf8");
        notesWritten += 1;
      }
    }
    timing.materialize_ms = elapsedMs(materializeStarted);

    const indexVault = new Vault(vaultRoot);
    ftsIndex = new FtsIndex({ file: path.join(idxDir, "lme.fts5.db"), vaultRoot: indexVault.root });
    const ftsStarted = performance.now();
    await ftsIndex.open();
    await syncFtsIndex(indexVault, ftsIndex);
    timing.fts_index_ms = elapsedMs(ftsStarted);

    let embedFile = "";
    if (embedder && EmbedDbCtor && embedModel) {
      const embedStarted = performance.now();
      embedFile = path.join(idxDir, "lme.embed.db");
      const db = new EmbedDbCtor({
        file: embedFile,
        vaultRoot: indexVault.root,
        modelAlias: embedModel.alias,
        dim: embedModel.dim
      });
      try {
        await db.open();
        await syncEmbedDb(indexVault, db, embedder);
      } finally {
        db.close();
      }
      indexFootprint.embeddings_bytes = await sqliteFootprintBytes(embedFile);
      timing.embedding_index_ms = elapsedMs(embedStarted);
    }

    // Normalize after the expensive content indexes are complete so "question
    // date = now" cannot drift by hours during a dense build. Content is
    // unchanged; a fresh Vault below observes the final benchmark mtimes.
    const retimeStarted = performance.now();
    const mtimeAnchor = Date.now();
    for (const { inst } of scorable) {
      for (let si = 0; si < inst.haystack_sessions.length; si++) {
        const absolute = path.join(vaultRoot, sessionNotePath(inst.question_id, si));
        const mtime = normalizedSessionMtimeMs(inst.haystack_dates[si], inst.question_date, mtimeAnchor);
        await fs.utimes(absolute, new Date(mtime), new Date(mtime));
      }
    }
    timing.retime_ms = elapsedMs(retimeStarted);

    const searchVault = new Vault(vaultRoot);
    const searchCtx = { ftsIndex, embedFile };
    for (let qi = 0; qi < scorable.length; qi++) {
      const { inst, relevant } = scorable[qi];
      const baseStarted = performance.now();
      const r0 = await searchHybrid(
        searchVault,
        { query: inst.question, folder: inst.question_id, limit: k },
        searchCtx
      );
      const baseLatency = elapsedMs(baseStarted);
      timing.base_search_ms += baseLatency;
      if (Object.keys(r0.signal_errors ?? {}).length > 0) {
        throw new Error(`${inst.question_id} ranker error: ${JSON.stringify(r0.signal_errors)}`);
      }
      const topPaths = r0.matches.map((match) => match.path);
      const scored = scoreOhs(topPaths, relevant, inst.question_type);
      base.push({ ...scored, signals_used: r0.signals_used });

      let recencyLatency = null;
      let recencyEvidence = null;
      if (args.recencyCompare) {
        const recencyStarted = performance.now();
        const r1 = await searchHybrid(
          searchVault,
          { query: inst.question, folder: inst.question_id, limit: k },
          { ...searchCtx, recency: { weight: args.recencyWeight, staleDays: args.staleDays } }
        );
        recencyLatency = elapsedMs(recencyStarted);
        timing.recency_search_ms += recencyLatency;
        if (Object.keys(r1.signal_errors ?? {}).length > 0) {
          throw new Error(`${inst.question_id} recency ranker error: ${JSON.stringify(r1.signal_errors)}`);
        }
        withRecency.push({
          ...scoreOhs(
            r1.matches.map((match) => match.path),
            relevant,
            inst.question_type
          ),
          signals_used: r1.signals_used
        });
        const recencyTopPaths = r1.matches.map((match) => match.path);
        const recencyScored = scoreOhs(recencyTopPaths, relevant, inst.question_type);
        recencyEvidence = {
          top_paths: recencyTopPaths,
          missed_paths: [...relevant].filter((relPath) => !recencyTopPaths.includes(relPath)),
          ndcg_5: recencyScored.ndcg_5,
          ndcg_10: recencyScored.ndcg_10,
          mrr: recencyScored.mrr,
          hit_1: recencyScored.hit_1 === 1,
          hit_5: recencyScored.hit_5 === 1,
          recall_10: recencyScored.recall_10,
          all_rel_10: recencyScored.all_rel_10 === 1,
          signals_used: r1.signals_used,
          latency_ms: recencyLatency
        };
      }

      perQuery.push({
        id: inst.question_id,
        query: inst.question,
        category: inst.question_type,
        scope: `${inst.question_id}/`,
        relevant_paths: [...relevant],
        top_paths: topPaths,
        missed_paths: [...relevant].filter((relPath) => !topPaths.includes(relPath)),
        ndcg_5: scored.ndcg_5,
        ndcg_10: scored.ndcg_10,
        mrr: scored.mrr,
        hit_1: scored.hit_1 === 1,
        hit_5: scored.hit_5 === 1,
        recall_10: scored.recall_10,
        all_rel_10: scored.all_rel_10 === 1,
        signals_used: r0.signals_used,
        latency_ms: baseLatency,
        ...(recencyEvidence === null ? {} : { recency: recencyEvidence })
      });
      if ((qi + 1) % 25 === 0) process.stderr.write(`  …${qi + 1}/${scorable.length}\n`);
    }
    ftsIndex.close();
    ftsIndex = null;
    indexFootprint.fts_bytes = await sqliteFootprintBytes(path.join(idxDir, "lme.fts5.db"));
  } finally {
    ftsIndex?.close?.();
    await fs.rm(vaultRoot, { recursive: true, force: true });
    await fs.rm(idxDir, { recursive: true, force: true });
  }

  timing.base_search_ms = round4(timing.base_search_ms);
  timing.recency_search_ms = round4(timing.recency_search_ms);
  const agg = aggregateByCategory(base);
  const fmt = (m) => `${m.toFixed(4)}`;

  // ── Disclosure header (per the C-2 honest-publishing bar) ──
  const canonicalCohort = isCanonicalLongMemEvalS(dataset, selected.length);
  const implementation = await implementationMetadata();
  const { status, partial, publishable } = benchmarkArtifactStatus(canonicalCohort, implementation);
  process.stdout.write(
    `\n=== enquire LongMemEval-S RETRIEVAL (${status === "complete" ? "" : `${status.toUpperCase()}; `}global index + scope-per-question, k=${k}) ===\n`
  );
  process.stdout.write(
    `embedding backend: ${embedModel ? `LOCAL on-device (transformers.js · ${embedModel.alias})` : "OFF (BM25 + TF-IDF only)"} — ` +
      "NOT a cloud model; a cloud-embedding peer number (e.g. bge-m3) is a different measurement.\n"
  );
  process.stdout.write(
    `dataset sha256=${dataset.sha256} · ${notesWritten} notes · scored ${base.length} question(s) · ` +
      `${abstentions} abstention(s) skipped\n\n`
  );
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
    // rc.12 — each metric carries its OWN sign (pre-rc.12 ΔMRR reused ΔnDCG@5's,
    // printing "+-0.0123" when the deltas differed in direction).
    const signed = (n) => `${n >= 0 ? "+" : ""}${n.toFixed(4)}`;
    for (const row of byCategoryRows(delta)) {
      process.stdout.write(`  ${row.type.padEnd(26)} ΔnDCG@5=${signed(row.ndcg_5)}  ΔMRR=${signed(row.mrr)}\n`);
    }
    process.stdout.write(
      "  (temporal-reasoning / knowledge-update / preference are where a static retriever is weakest)\n"
    );
  }

  if (args.output) {
    const resourceUsage = process.resourceUsage();
    const payload = {
      meta: {
        schema_version: 1,
        generated_at: generatedAt,
        status,
        partial,
        canonical_cohort: canonicalCohort,
        publishable,
        protocol: {
          name: "longmemeval-s-global-index-scope-per-question",
          comparator: "flowing-abyss/obsidian-hybrid-search",
          comparator_commit: OHS_COMPARATOR_COMMIT,
          k,
          index_state: "rebuilt-once-for-selected-cohort",
          query_scope: "question-folder",
          timestamp_policy: "session age relative to question date, normalized after content indexing and before search"
        },
        dataset: {
          ...dataset,
          selected_instances: selected.length,
          scored_instances: base.length,
          abstentions_skipped: abstentions,
          materialized_notes: notesWritten
        },
        retrieval: {
          embeddings: args.embeddings,
          embedding_backend: embedModel ? `local-transformers.js (${embedModel.alias})` : "none-bm25-tfidf",
          base_signal_query_counts: countSignals(base),
          recency_compare: args.recencyCompare,
          recency_weight: args.recencyCompare ? args.recencyWeight : null,
          stale_days: args.recencyCompare ? args.staleDays : null
        },
        implementation,
        environment: environmentMetadata(),
        timing: {
          ...timing,
          index_footprint_bytes: indexFootprint,
          total_ms: elapsedMs(runStarted),
          max_rss_kib: resourceUsage.maxRSS
        }
      },
      summary: agg.overall,
      by_category: agg.by_category,
      per_query: perQuery,
      ...(recencyReport ? { recency: recencyReport } : {})
    };
    await writeJsonAtomic(args.output, payload);
    process.stderr.write(`\nwrote result JSON → ${args.output}\n`);
  }

  process.stdout.write(
    "\nNOTE: retrieval quality (does search rank the answer-bearing session near the top), NOT end-to-end QA\n" +
      "accuracy (answer generation is the calling agent's job). See docs/EVALUATION.md for the publishing bar.\n"
  );
}

if (isEntrypoint(import.meta.url)) {
  await main();
}
