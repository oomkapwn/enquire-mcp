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
import { existsSync, promises as fs, constants as fsConstants } from "node:fs";
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
export const OFFICIAL_LONGMEMEVAL_S_SCORED = 470;
export const OFFICIAL_LONGMEMEVAL_S_ABSTENTIONS = 30;
export const OFFICIAL_LONGMEMEVAL_S_NOTES = 22_419;
export const OHS_COMPARATOR_COMMIT = "c0922d955f5bf5abaad14a11cbb3e11303cd6036";
export const CANONICAL_EMBEDDING_MODEL = Object.freeze({
  alias: "multilingual",
  hfId: "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
  dtype: "q8",
  dim: 384,
  requiredFiles: Object.freeze(["config.json", "onnx/model_quantized.onnx", "tokenizer.json", "tokenizer_config.json"]),
  requiredFileSha256: Object.freeze({
    "config.json": "05b570bff786faa5c4604152aa16f19f77ed6dfc31e47dd0f3dd987078693ac7",
    "onnx/model_quantized.onnx": "66fc00f5f29afcaff34092e1bdd20008ca3918265a82fb9695a551e510cc4ebc",
    "tokenizer.json": "b60b6b43406a48bf3638526314f3d232d97058bc93472ff2de930d43686fa441",
    "tokenizer_config.json": "3f5961b9ac86288cccdb97f32fb848d6187c78e1603958c53f3ea1f296b7d8a2"
  })
});
const SAFE_QUESTION_ID = /^[A-Za-z0-9_-]+$/;
const LONGMEMEVAL_DATE = /^(\d{4})\/(\d{2})\/(\d{2})(?: \([^)]+\))?(?: (\d{2}):(\d{2}))?$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const EXPECTED_ORIGIN = /^(?:(?:git@|https?:\/\/|ssh:\/\/git@)?github\.com[:/])oomkapwn\/enquire-mcp(?:\.git)?$/i;
const REQUIRED_RUNTIME_DEPENDENCY_ROOT_SPECS = [
  { name: "better-sqlite3", packageName: "better-sqlite3" },
  { name: "@huggingface/transformers", packageName: "@huggingface/transformers" },
  { name: "js-yaml", packageName: "js-yaml" },
  { name: "typescript-native", packageName: "typescript" }
];
const REQUIRED_RUNTIME_DEPENDENCIES = REQUIRED_RUNTIME_DEPENDENCY_ROOT_SPECS.map(({ name }) => name);
const IMPLEMENTATION_PATHS = [
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "src",
  "scripts/bench-longmemeval.mjs",
  "scripts/lib/entrypoint.mjs"
];
const OUTPUT_PROTECTED_PATHS = [
  ".git",
  "src",
  "dist",
  "scripts",
  "node_modules",
  "package.json",
  "package-lock.json",
  "tsconfig.json"
];
const OUTPUT_ALLOWED_REPOSITORY_ROOTS = ["eval/results"];
const CANONICAL_GIT_REMOTE = "https://github.com/oomkapwn/enquire-mcp.git";
const TRUSTED_GIT_EXECUTABLE = process.platform === "win32" ? "C:\\Program Files\\Git\\cmd\\git.exe" : "/usr/bin/git";
const HARDENED_GIT_ARGS = [
  "--no-optional-locks",
  "--no-replace-objects",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false"
];
const ALLOWED_NODE_RUNTIME_ARG = /^--max-old-space-size=[1-9]\d*$/;

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

/** Exact canonical dataset plus independently derived cohort/materialization shape. */
export function isCanonicalLongMemEvalCohort(dataset, shape) {
  return (
    isCanonicalLongMemEvalS(dataset, shape.selected_instances) &&
    shape.expected_scored_instances === OFFICIAL_LONGMEMEVAL_S_SCORED &&
    shape.evaluated_instances === shape.expected_scored_instances &&
    shape.abstentions === OFFICIAL_LONGMEMEVAL_S_ABSTENTIONS &&
    shape.expected_notes === OFFICIAL_LONGMEMEVAL_S_NOTES &&
    shape.materialized_notes === shape.expected_notes
  );
}

/**
 * Validate the raw strict-sync equations needed for a dense publication.
 *
 * The derived `complete` flag is deliberately only one input: every counter
 * and physical-index invariant is recomputed here so a forged
 * `{ complete: true }` report cannot make an incomplete dense run publishable.
 */
export function embeddingSyncPublicationBlockers(report, expectedFiles) {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    return ["embedding-sync-report-missing"];
  }

  const blockers = [];
  const integerFields = [
    "added",
    "updated",
    "deleted",
    "unchanged",
    "total_chunks",
    "total_files",
    "processed_files",
    "empty",
    "failed",
    "indexed_files",
    "declared_chunks",
    "indexed_chunks",
    "mismatched_files",
    "invalid_vectors"
  ];
  for (const field of integerFields) {
    if (!Number.isSafeInteger(report[field]) || report[field] < 0) {
      blockers.push(`embedding-sync-invalid-${field.replaceAll("_", "-")}`);
    }
  }
  if (blockers.length > 0) return blockers;

  if (report.mode !== "strict") blockers.push("embedding-sync-not-strict");
  if (report.audited !== true) blockers.push("embedding-sync-not-audited");
  if (!SHA256_HEX.test(String(report.manifest_sha256))) blockers.push("embedding-sync-manifest-invalid");
  if (!Number.isSafeInteger(expectedFiles) || expectedFiles <= 0) {
    blockers.push("embedding-sync-expected-file-count-invalid");
  } else if (report.total_files !== expectedFiles) {
    blockers.push("embedding-sync-source-count-mismatch");
  }
  if (report.processed_files !== report.total_files) blockers.push("embedding-sync-unprocessed-files");
  if (report.added + report.updated + report.unchanged + report.empty + report.failed !== report.total_files) {
    blockers.push("embedding-sync-accounting-mismatch");
  }
  if (report.added !== report.total_files || report.updated !== 0 || report.unchanged !== 0 || report.deleted !== 0) {
    blockers.push("embedding-sync-not-fresh");
  }
  if (report.failed !== 0) blockers.push("embedding-sync-file-errors");
  if (report.empty !== 0) blockers.push("embedding-sync-empty-files");
  if (report.indexed_files !== report.total_files) blockers.push("embedding-sync-indexed-file-mismatch");
  if (report.declared_chunks !== report.indexed_chunks) blockers.push("embedding-sync-chunk-count-mismatch");
  if (report.total_chunks !== report.indexed_chunks) blockers.push("embedding-sync-total-chunk-mismatch");
  if (report.mismatched_files !== 0) blockers.push("embedding-sync-integrity-mismatch");
  if (report.invalid_vectors !== 0) blockers.push("embedding-sync-invalid-vectors");
  if (report.total_files > 0 && report.indexed_chunks === 0) blockers.push("embedding-sync-zero-chunks");
  if (report.complete !== true) blockers.push("embedding-sync-reported-incomplete");
  const postRun = report.post_run_audit;
  if (!postRun || typeof postRun !== "object" || Array.isArray(postRun)) {
    blockers.push("embedding-sync-post-run-audit-missing");
  } else {
    for (const field of ["indexed_files", "declared_chunks", "indexed_chunks", "mismatched_files"]) {
      if (!Number.isSafeInteger(postRun[field]) || postRun[field] < 0) {
        blockers.push(`embedding-sync-post-run-invalid-${field.replaceAll("_", "-")}`);
      }
    }
    if (
      postRun.indexed_files !== report.indexed_files ||
      postRun.declared_chunks !== report.declared_chunks ||
      postRun.indexed_chunks !== report.indexed_chunks ||
      postRun.mismatched_files !== 0
    ) {
      blockers.push("embedding-sync-post-run-integrity-mismatch");
    }
  }
  if (
    !report.post_run_vector_audit ||
    !Number.isSafeInteger(report.post_run_vector_audit.invalid_vectors) ||
    report.post_run_vector_audit.invalid_vectors !== 0
  ) {
    blockers.push("embedding-sync-post-run-vector-invalid");
  }
  if (
    !SHA256_HEX.test(String(report.post_run_manifest_sha256)) ||
    report.post_run_manifest_sha256 !== report.manifest_sha256
  ) {
    blockers.push("embedding-sync-post-run-manifest-mismatch");
  }
  if (report.post_run_unchanged !== true) blockers.push("embedding-sync-post-run-changed");
  return blockers;
}

/**
 * Validate the strict FTS sync and its post-query physical audit.
 *
 * Like the dense guard, this recomputes every accounting equation instead of
 * trusting the derived `complete` boolean.
 */
export function ftsSyncPublicationBlockers(report, expectedFiles) {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    return ["fts-sync-report-missing"];
  }
  const blockers = [];
  const integerFields = [
    "added",
    "updated",
    "deleted",
    "unchanged",
    "total_chunks",
    "total_files",
    "processed_files",
    "empty",
    "failed",
    "declared_files",
    "indexed_files",
    "declared_chunks",
    "indexed_chunks",
    "mismatched_files"
  ];
  for (const field of integerFields) {
    if (!Number.isSafeInteger(report[field]) || report[field] < 0) {
      blockers.push(`fts-sync-invalid-${field.replaceAll("_", "-")}`);
    }
  }
  if (blockers.length > 0) return blockers;

  if (report.mode !== "strict") blockers.push("fts-sync-not-strict");
  if (report.audited !== true) blockers.push("fts-sync-not-audited");
  if (!SHA256_HEX.test(String(report.manifest_sha256))) blockers.push("fts-sync-manifest-invalid");
  if (!Number.isSafeInteger(expectedFiles) || expectedFiles <= 0) {
    blockers.push("fts-sync-expected-file-count-invalid");
  } else if (report.total_files !== expectedFiles) {
    blockers.push("fts-sync-source-count-mismatch");
  }
  if (report.processed_files !== report.total_files) blockers.push("fts-sync-unprocessed-files");
  if (report.added + report.updated + report.unchanged + report.empty + report.failed !== report.total_files) {
    blockers.push("fts-sync-accounting-mismatch");
  }
  if (report.added !== report.total_files || report.updated !== 0 || report.unchanged !== 0 || report.deleted !== 0) {
    blockers.push("fts-sync-not-fresh");
  }
  if (report.failed !== 0) blockers.push("fts-sync-file-errors");
  if (report.empty !== 0) blockers.push("fts-sync-empty-files");
  if (report.declared_files !== report.total_files || report.indexed_files !== report.total_files) {
    blockers.push("fts-sync-indexed-file-mismatch");
  }
  if (report.declared_chunks !== report.indexed_chunks) blockers.push("fts-sync-chunk-count-mismatch");
  if (report.total_chunks !== report.indexed_chunks) blockers.push("fts-sync-total-chunk-mismatch");
  if (report.mismatched_files !== 0) blockers.push("fts-sync-integrity-mismatch");
  if (report.total_files > 0 && report.indexed_chunks === 0) blockers.push("fts-sync-zero-chunks");
  if (report.complete !== true) blockers.push("fts-sync-reported-incomplete");

  const postRun = report.post_run_audit;
  if (!postRun || typeof postRun !== "object" || Array.isArray(postRun)) {
    blockers.push("fts-sync-post-run-audit-missing");
  } else {
    for (const field of ["declared_files", "indexed_files", "declared_chunks", "indexed_chunks", "mismatched_files"]) {
      if (!Number.isSafeInteger(postRun[field]) || postRun[field] < 0) {
        blockers.push(`fts-sync-post-run-invalid-${field.replaceAll("_", "-")}`);
      }
    }
    if (
      postRun.declared_files !== report.declared_files ||
      postRun.indexed_files !== report.indexed_files ||
      postRun.declared_chunks !== report.declared_chunks ||
      postRun.indexed_chunks !== report.indexed_chunks ||
      postRun.mismatched_files !== 0
    ) {
      blockers.push("fts-sync-post-run-integrity-mismatch");
    }
  }
  if (
    !SHA256_HEX.test(String(report.post_run_manifest_sha256)) ||
    report.post_run_manifest_sha256 !== report.manifest_sha256
  ) {
    blockers.push("fts-sync-post-run-manifest-mismatch");
  }
  if (report.post_run_unchanged !== true) blockers.push("fts-sync-post-run-changed");
  return blockers;
}

/** Validate the exact live vault bytes and mtime reconciliation around queries. */
export function materializedCorpusPublicationBlockers(report, expectedPaths) {
  if (
    !report ||
    typeof report !== "object" ||
    Array.isArray(report) ||
    !Array.isArray(expectedPaths) ||
    expectedPaths.length === 0
  ) {
    return ["materialized-corpus-report-missing"];
  }
  const blockers = [];
  const normalizedExpected = [...expectedPaths].sort();
  if (
    new Set(normalizedExpected).size !== normalizedExpected.length ||
    normalizedExpected.some(
      (candidate) =>
        typeof candidate !== "string" ||
        candidate.length === 0 ||
        path.posix.normalize(candidate) !== candidate ||
        path.isAbsolute(candidate) ||
        candidate.split("/").includes("..")
    )
  ) {
    return ["materialized-corpus-expected-paths-invalid"];
  }
  const validateSnapshot = (snapshot, phase) => {
    if (
      !snapshot ||
      typeof snapshot !== "object" ||
      Array.isArray(snapshot) ||
      !Array.isArray(snapshot.files) ||
      snapshot.file_count !== normalizedExpected.length ||
      snapshot.files.length !== normalizedExpected.length ||
      snapshot.snapshot_consistent !== true ||
      !SHA256_HEX.test(String(snapshot.manifest_sha256))
    ) {
      blockers.push(`materialized-corpus-${phase}-manifest-invalid`);
      return;
    }
    const paths = snapshot.files.map((file) => file?.path);
    const filesValid = snapshot.files.every(
      (file) =>
        file &&
        typeof file === "object" &&
        typeof file.path === "string" &&
        Number.isSafeInteger(file.size_bytes) &&
        file.size_bytes > 0 &&
        SHA256_HEX.test(String(file.sha256))
    );
    if (
      !filesValid ||
      new Set(paths).size !== paths.length ||
      [...paths].sort().some((candidate, index) => candidate !== normalizedExpected[index]) ||
      (filesValid && artifactManifestSha256(snapshot.files) !== snapshot.manifest_sha256)
    ) {
      blockers.push(`materialized-corpus-${phase}-manifest-invalid`);
    }
  };
  validateSnapshot(report.before_queries, "before");
  validateSnapshot(report.after_queries, "after");
  if (
    report.unchanged_during_queries !== true ||
    report.before_queries?.manifest_sha256 !== report.after_queries?.manifest_sha256
  ) {
    blockers.push("materialized-corpus-changed-during-queries");
  }
  const diff = report.post_run_fts_diff;
  if (
    !diff ||
    typeof diff !== "object" ||
    Array.isArray(diff) ||
    !Array.isArray(diff.added) ||
    !Array.isArray(diff.updated) ||
    !Array.isArray(diff.deleted) ||
    !Array.isArray(diff.unchanged) ||
    diff.added.length !== 0 ||
    diff.updated.length !== 0 ||
    diff.deleted.length !== 0 ||
    diff.unchanged.length !== normalizedExpected.length ||
    [...diff.unchanged].sort().some((candidate, index) => candidate !== normalizedExpected[index])
  ) {
    blockers.push("materialized-corpus-index-state-stale");
  }
  return [...new Set(blockers)];
}

function validScopedPaths(paths, scope, k = Number.MAX_SAFE_INTEGER) {
  if (!Array.isArray(paths) || paths.length > k || new Set(paths).size !== paths.length) return false;
  return paths.every(
    (candidate) =>
      typeof candidate === "string" &&
      candidate.startsWith(scope) &&
      path.posix.normalize(candidate) === candidate &&
      !candidate.split("/").includes("..")
  );
}

/**
 * Validate raw per-query evidence rather than trusting aggregate counters.
 *
 * This pins exact IDs, folder scope, signal uniqueness, metric domains, and
 * result cardinality for both the base and optional recency runs.
 */
export function queryEvidencePublicationBlockers(rows, expectedRows, k, opts = {}) {
  if (
    !Array.isArray(rows) ||
    !Array.isArray(expectedRows) ||
    expectedRows.length === 0 ||
    !Number.isSafeInteger(k) ||
    k <= 0
  ) {
    return ["retrieval-raw-evidence-invalid"];
  }
  const blockers = [];
  const expected = new Map();
  for (const descriptor of expectedRows) {
    const scope = typeof descriptor?.id === "string" ? `${descriptor.id}/` : "";
    const relevantPaths = descriptor?.relevant_paths;
    const materializedPaths = descriptor?.materialized_paths;
    if (
      !descriptor ||
      typeof descriptor !== "object" ||
      Array.isArray(descriptor) ||
      typeof descriptor.id !== "string" ||
      expected.has(descriptor.id) ||
      typeof descriptor.query !== "string" ||
      descriptor.query.length === 0 ||
      typeof descriptor.category !== "string" ||
      descriptor.category.length === 0 ||
      !validScopedPaths(relevantPaths, scope) ||
      relevantPaths.length === 0 ||
      !validScopedPaths(materializedPaths, scope) ||
      materializedPaths.length === 0 ||
      relevantPaths.some((candidate) => !materializedPaths.includes(candidate))
    ) {
      return ["retrieval-expected-evidence-invalid"];
    }
    expected.set(descriptor.id, descriptor);
  }
  const observed = new Set();
  const metricFields = ["ndcg_5", "ndcg_10", "mrr", "recall_10"];
  const booleanFields = ["hit_1", "hit_5", "all_rel_10"];
  const recomputeMetrics = (topPaths, relevantPaths) => {
    const relevant = new Set(relevantPaths);
    const ndcg = (at) => {
      let dcg = 0;
      for (let index = 0; index < Math.min(at, topPaths.length); index++) {
        if (relevant.has(topPaths[index])) dcg += 1 / Math.log2(index + 2);
      }
      let ideal = 0;
      for (let index = 0; index < Math.min(at, relevant.size); index++) ideal += 1 / Math.log2(index + 2);
      return ideal > 0 ? dcg / ideal : 0;
    };
    const foundAt10 = new Set(topPaths.slice(0, 10).filter((candidate) => relevant.has(candidate)));
    const firstRelevant = topPaths.slice(0, k).findIndex((candidate) => relevant.has(candidate));
    return {
      ndcg_5: ndcg(5),
      ndcg_10: ndcg(10),
      mrr: firstRelevant < 0 ? 0 : 1 / (firstRelevant + 1),
      hit_1: topPaths.slice(0, 1).some((candidate) => relevant.has(candidate)),
      hit_5: topPaths.slice(0, 5).some((candidate) => relevant.has(candidate)),
      recall_10: foundAt10.size / relevant.size,
      all_rel_10: foundAt10.size === relevant.size
    };
  };
  const samePathSet = (left, right) =>
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((candidate) => right.includes(candidate));
  const validateResult = (result, descriptor, prefix) => {
    const scope = `${descriptor.id}/`;
    if (!validScopedPaths(result?.top_paths, scope, k)) blockers.push(`${prefix}-paths-invalid`);
    if (
      Array.isArray(result?.top_paths) &&
      result.top_paths.some((candidate) => !descriptor.materialized_paths.includes(candidate))
    ) {
      blockers.push(`${prefix}-path-not-materialized`);
    }
    if (
      !validScopedPaths(result?.relevant_paths ?? [], scope) ||
      !Array.isArray(result?.relevant_paths) ||
      result.relevant_paths.length === 0 ||
      !samePathSet(result.relevant_paths, descriptor.relevant_paths)
    ) {
      blockers.push(`${prefix}-ground-truth-mismatch`);
    }
    const expectedMissed =
      Array.isArray(result?.top_paths) && Array.isArray(result?.relevant_paths)
        ? result.relevant_paths.filter((candidate) => !result.top_paths.includes(candidate))
        : [];
    if (
      !validScopedPaths(result?.missed_paths ?? [], scope) ||
      result?.missed_paths?.length !== expectedMissed.length ||
      expectedMissed.some((candidate) => !result.missed_paths.includes(candidate))
    ) {
      blockers.push(`${prefix}-missed-paths-invalid`);
    }
    if (
      !Array.isArray(result?.signals_used) ||
      new Set(result.signals_used).size !== result.signals_used.length ||
      !result.signals_used.every((signal) => ["bm25", "tfidf", "embeddings"].includes(signal))
    ) {
      blockers.push(`${prefix}-signals-invalid`);
    } else if (opts.embeddings === true && !result.signals_used.includes("embeddings")) {
      blockers.push(`${prefix}-embedding-signal-missing`);
    }
    if (
      metricFields.some(
        (field) =>
          typeof result?.[field] !== "number" ||
          !Number.isFinite(result[field]) ||
          result[field] < 0 ||
          result[field] > 1
      ) ||
      booleanFields.some((field) => typeof result?.[field] !== "boolean") ||
      typeof result?.latency_ms !== "number" ||
      !Number.isFinite(result.latency_ms) ||
      result.latency_ms < 0
    ) {
      blockers.push(`${prefix}-metrics-invalid`);
    } else if (
      Array.isArray(result.top_paths) &&
      Array.isArray(result.relevant_paths) &&
      result.relevant_paths.length > 0
    ) {
      const recomputed = recomputeMetrics(result.top_paths, result.relevant_paths);
      if (
        metricFields.some((field) => Math.abs(result[field] - recomputed[field]) > 1e-12) ||
        booleanFields.some((field) => result[field] !== recomputed[field])
      ) {
        blockers.push(`${prefix}-metrics-inconsistent`);
      }
    }
  };

  for (const row of rows) {
    const descriptor =
      row && typeof row === "object" && !Array.isArray(row) && typeof row.id === "string"
        ? expected.get(row.id)
        : undefined;
    if (!descriptor) {
      blockers.push("retrieval-query-id-mismatch");
      continue;
    }
    if (observed.has(row.id)) blockers.push("retrieval-query-id-duplicate");
    observed.add(row.id);
    const scope = `${descriptor.id}/`;
    if (row.scope !== scope || row.query !== descriptor.query || row.category !== descriptor.category) {
      blockers.push("retrieval-query-metadata-invalid");
    }
    validateResult(row, descriptor, "retrieval-base");
    if (opts.recencyCompare === true) {
      if (!row.recency || typeof row.recency !== "object" || Array.isArray(row.recency)) {
        blockers.push("retrieval-recency-evidence-missing");
      } else {
        validateResult({ ...row.recency, relevant_paths: row.relevant_paths }, descriptor, "retrieval-recency");
      }
    } else if (row.recency !== undefined) {
      blockers.push("retrieval-unexpected-recency-evidence");
    }
  }
  if (
    rows.length !== expected.size ||
    observed.size !== expected.size ||
    [...expected.keys()].some((id) => !observed.has(id))
  ) {
    blockers.push("retrieval-raw-query-count-mismatch");
  }
  if (opts.requireSummary === true) {
    const aggregate = aggregateByCategory(
      rows.map((row) => ({
        type: row.category,
        ndcg_5: row.ndcg_5,
        ndcg_10: row.ndcg_10,
        mrr: row.mrr,
        hit_1: row.hit_1 ? 1 : 0,
        hit_5: row.hit_5 ? 1 : 0,
        recall_10: row.recall_10,
        all_rel_10: row.all_rel_10 ? 1 : 0
      }))
    );
    const summary = opts.summary;
    const metricRowMatches = (actual, derived) =>
      actual &&
      typeof actual === "object" &&
      Number.isSafeInteger(actual.n) &&
      actual.n === derived.n &&
      OHS_METRICS.every(
        (field) =>
          typeof actual[field] === "number" &&
          Number.isFinite(actual[field]) &&
          Math.abs(actual[field] - derived[field]) <= 1e-12
      );
    const actualCategories =
      summary?.by_category && typeof summary.by_category === "object" && !Array.isArray(summary.by_category)
        ? Object.keys(summary.by_category)
        : [];
    const derivedCategories = Object.keys(aggregate.by_category);
    if (
      !metricRowMatches(summary?.overall, aggregate.overall) ||
      actualCategories.length !== derivedCategories.length ||
      derivedCategories.some(
        (category) =>
          !actualCategories.includes(category) ||
          !metricRowMatches(summary.by_category[category], aggregate.by_category[category])
      )
    ) {
      blockers.push("retrieval-summary-inconsistent");
    }
  }
  return [...new Set(blockers)];
}

/** Validate published recency aggregates and deltas against nested raw rows. */
export function recencyEvidencePublicationBlockers(report, rows, opts = {}) {
  if (!report || typeof report !== "object" || Array.isArray(report) || !Array.isArray(rows) || rows.length === 0) {
    return ["retrieval-recency-summary-missing"];
  }
  const blockers = [];
  if (
    typeof report.weight !== "number" ||
    !Number.isFinite(report.weight) ||
    report.weight < 0 ||
    report.weight > 1 ||
    !Number.isSafeInteger(report.stale_days) ||
    report.stale_days <= 0 ||
    !Number.isSafeInteger(report.reference_ms) ||
    report.reference_ms <= 0 ||
    (opts.expectedWeight !== undefined && report.weight !== opts.expectedWeight) ||
    (opts.expectedStaleDays !== undefined && report.stale_days !== opts.expectedStaleDays) ||
    (opts.expectedReferenceMs !== undefined && report.reference_ms !== opts.expectedReferenceMs)
  ) {
    blockers.push("retrieval-recency-configuration-mismatch");
  }
  const metricRowMatches = (actual, expected) =>
    actual &&
    typeof actual === "object" &&
    !Array.isArray(actual) &&
    Number.isSafeInteger(actual.n) &&
    actual.n === expected.n &&
    OHS_METRICS.every(
      (field) =>
        typeof actual[field] === "number" &&
        Number.isFinite(actual[field]) &&
        Math.abs(actual[field] - expected[field]) <= 1e-12
    );
  const categoriesMatch = (actual, expected) => {
    if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
    const actualKeys = Object.keys(actual);
    const expectedKeys = Object.keys(expected);
    return (
      actualKeys.length === expectedKeys.length &&
      expectedKeys.every(
        (category) => actualKeys.includes(category) && metricRowMatches(actual[category], expected[category])
      )
    );
  };
  const baseRows = rows.map((row) => ({
    type: row?.category,
    ...Object.fromEntries(
      OHS_METRICS.map((field) => [field, row?.[field] === true ? 1 : row?.[field] === false ? 0 : row?.[field]])
    )
  }));
  const recencyRows = rows.map((row) => ({
    type: row?.category,
    ...Object.fromEntries(
      OHS_METRICS.map((field) => [
        field,
        row?.recency?.[field] === true ? 1 : row?.recency?.[field] === false ? 0 : row?.recency?.[field]
      ])
    )
  }));
  if (
    rows.some(
      (row) =>
        !row?.recency ||
        OHS_METRICS.some((field) => typeof row.recency[field] !== "number" && typeof row.recency[field] !== "boolean")
    )
  ) {
    return ["retrieval-recency-summary-source-invalid"];
  }
  const baseAggregate = aggregateByCategory(baseRows);
  const recencyAggregate = aggregateByCategory(recencyRows);
  const expectedDelta = recencyDelta(baseAggregate.by_category, recencyAggregate.by_category);
  if (
    !metricRowMatches(report.overall, recencyAggregate.overall) ||
    !categoriesMatch(report.by_category, recencyAggregate.by_category)
  ) {
    blockers.push("retrieval-recency-summary-inconsistent");
  }
  if (!categoriesMatch(report.delta, expectedDelta)) {
    blockers.push("retrieval-recency-delta-inconsistent");
  }
  return blockers;
}

/**
 * Bind every independently reported corpus cardinality and path universe.
 *
 * A publishable artifact must describe one exact set of notes across the
 * dataset count, materialized-file manifest, and per-query evidence. This
 * prevents separately self-consistent reports from referring to different
 * corpora.
 */
export function corpusUniversePublicationBlockers(expectedFiles, expectedMaterializedPaths, expectedQueryEvidence) {
  if (
    !Number.isSafeInteger(expectedFiles) ||
    expectedFiles <= 0 ||
    !Array.isArray(expectedMaterializedPaths) ||
    !Array.isArray(expectedQueryEvidence)
  ) {
    return ["retrieval-corpus-universe-mismatch"];
  }
  const globalPaths = expectedMaterializedPaths;
  const queryPaths = expectedQueryEvidence.flatMap((descriptor) =>
    Array.isArray(descriptor?.materialized_paths) ? descriptor.materialized_paths : []
  );
  const globalSet = new Set(globalPaths);
  const querySet = new Set(queryPaths);
  if (
    globalPaths.length !== expectedFiles ||
    globalSet.size !== globalPaths.length ||
    queryPaths.length !== expectedFiles ||
    querySet.size !== queryPaths.length ||
    globalSet.size !== querySet.size ||
    [...globalSet].some((candidate) => !querySet.has(candidate))
  ) {
    return ["retrieval-corpus-universe-mismatch"];
  }
  return [];
}

/** Stable digest over a privacy-safe file manifest. */
export function artifactManifestSha256(files) {
  const normalized = [...files]
    .map((file) => ({
      path: file.path,
      mode: file.mode ?? null,
      size_bytes: file.size_bytes,
      sha256: file.sha256
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

/** Privacy-safe runtime injection posture for provenance metadata. */
export function runtimeInjectionSnapshot(env = process.env, execArgv = process.execArgv) {
  const loaderFlag =
    /(?:^|\s)(?:-r|-C|--require|--import|--loader|--experimental-loader|--experimental-policy|--policy-integrity|--conditions|--preserve-symlinks|--preserve-symlinks-main)(?:=|\s|(?=\S)|$)/;
  const injectionEnv = [
    "NODE_PATH",
    "NODE_PRESERVE_SYMLINKS",
    "NODE_PRESERVE_SYMLINKS_MAIN",
    "NODE_ICU_DATA",
    "NODE_COMPILE_CACHE",
    "OPENSSL_CONF",
    "OPENSSL_MODULES",
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "DYLD_INSERT_LIBRARIES",
    "DYLD_LIBRARY_PATH"
  ];
  const dynamicLoaderEnv = Object.keys(env)
    .filter((name) => name.startsWith("LD_") || name.startsWith("DYLD_"))
    .sort();
  const envFlags = Object.fromEntries(
    [...new Set([...injectionEnv, ...dynamicLoaderEnv])].map((name) => [name.toLowerCase(), Boolean(env[name]?.trim())])
  );
  const nodeOptions = env.NODE_OPTIONS?.trim() ?? "";
  const nodeOptionArgs = nodeOptions.length === 0 ? [] : nodeOptions.split(/\s+/);
  const argv = Array.isArray(execArgv) ? execArgv : [];
  const codeLoadingFlags = argv.filter((arg) =>
    /^(?:-r(?:=|[^-]|$)|-C(?:=|[^-]|$)|--require(?:=|$)|--import(?:=|$)|--loader(?:=|$)|--experimental-loader(?:=|$)|--experimental-policy(?:=|$)|--policy-integrity(?:=|$)|--conditions(?:=|$)|--preserve-symlinks(?:=|$)|--preserve-symlinks-main(?:=|$))/.test(
      arg
    )
  );
  const nodeOptionsAllowlisted = nodeOptionArgs.every((arg) => ALLOWED_NODE_RUNTIME_ARG.test(arg));
  const execArgvAllowlisted = argv.every((arg) => typeof arg === "string" && ALLOWED_NODE_RUNTIME_ARG.test(arg));
  const posture = {
    ...envFlags,
    node_options_set: nodeOptions.length > 0,
    node_options_code_loading: loaderFlag.test(nodeOptions),
    node_options_arg_count: nodeOptionArgs.length,
    node_options_allowlisted: nodeOptionsAllowlisted,
    exec_argv_count: argv.length,
    exec_argv_allowlisted: execArgvAllowlisted,
    code_loading_flag_count: codeLoadingFlags.length,
    clean:
      !Object.values(envFlags).some(Boolean) &&
      nodeOptionsAllowlisted &&
      execArgvAllowlisted &&
      !loaderFlag.test(nodeOptions) &&
      codeLoadingFlags.length === 0
  };
  return {
    ...posture,
    sha256: createHash("sha256").update(JSON.stringify(posture)).digest("hex")
  };
}

/** Return true only for one canonically encoded 64-byte SHA-512 SRI digest. */
export function isCanonicalSha512Sri(value) {
  if (typeof value !== "string" || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  const encoded = value.slice("sha512-".length);
  try {
    const digest = Buffer.from(encoded, "base64");
    return digest.length === 64 && digest.toString("base64") === encoded;
  } catch {
    return false;
  }
}

/** Stable digest over installed runtime-dependency code receipts. */
export function runtimeDependencyManifestSha256(dependencies) {
  const normalized = [...dependencies]
    .map((dependency) => ({
      root_alias: dependency.root_alias,
      name: dependency.name,
      lock_path: dependency.lock_path,
      version: dependency.version,
      lock_version: dependency.lock_version,
      lock_resolved: dependency.lock_resolved,
      lock_integrity: dependency.lock_integrity,
      file_count: dependency.file_count,
      manifest_sha256: dependency.manifest_sha256,
      lock_matches: dependency.lock_matches,
      metadata_matches_lock: dependency.metadata_matches_lock,
      dependency_paths: dependency.dependency_paths,
      optional_dependency_paths: dependency.optional_dependency_paths,
      missing_optional_dependencies: dependency.missing_optional_dependencies
    }))
    .sort((a, b) => a.lock_path.localeCompare(b.lock_path));
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

/** Validate the exact local model bytes used by a canonical dense run. */
export function modelArtifactPublicationBlockers(report, expectedModel) {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    return ["embedding-model-artifact-report-missing"];
  }
  const blockers = [];
  const snapshots = [report.run_start, report.post_load, report];
  for (const snapshot of snapshots) {
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
      blockers.push("embedding-model-artifact-metadata-incomplete");
      continue;
    }
    if (
      snapshot.alias !== expectedModel?.alias ||
      snapshot.hf_id !== expectedModel?.hfId ||
      snapshot.dtype !== expectedModel?.dtype ||
      typeof snapshot.transformers_version !== "string" ||
      snapshot.transformers_version.length === 0
    ) {
      blockers.push("embedding-model-artifact-identity-mismatch");
    }
    if (
      !Number.isSafeInteger(snapshot.file_count) ||
      snapshot.file_count <= 0 ||
      !Array.isArray(snapshot.files) ||
      snapshot.files.length !== snapshot.file_count
    ) {
      blockers.push("embedding-model-artifact-manifest-incomplete");
      continue;
    }
    const filePaths = snapshot.files.map((file) => file?.path);
    const validFiles = snapshot.files.every(
      (file) =>
        file &&
        typeof file === "object" &&
        typeof file.path === "string" &&
        file.path.length > 0 &&
        !path.isAbsolute(file.path) &&
        !file.path.split("/").includes("..") &&
        Number.isSafeInteger(file.size_bytes) &&
        file.size_bytes >= 0 &&
        typeof file.sha256 === "string" &&
        SHA256_HEX.test(file.sha256)
    );
    if (
      !validFiles ||
      new Set(filePaths).size !== filePaths.length ||
      snapshot.snapshot_consistent !== true ||
      !SHA256_HEX.test(String(snapshot.manifest_sha256)) ||
      (validFiles && artifactManifestSha256(snapshot.files) !== snapshot.manifest_sha256)
    ) {
      blockers.push("embedding-model-artifact-manifest-invalid");
    }
    const requiredFiles = Array.isArray(expectedModel?.requiredFiles) ? expectedModel.requiredFiles : [];
    if (
      validFiles &&
      (requiredFiles.length === 0 ||
        snapshot.files.length !== requiredFiles.length ||
        snapshot.files.some((file) => !requiredFiles.includes(file.path)) ||
        requiredFiles.some(
          (required) =>
            !snapshot.files.some(
              (file) => file.path === required && Number.isSafeInteger(file.size_bytes) && file.size_bytes > 0
            )
        ))
    ) {
      blockers.push("embedding-model-artifact-file-set-mismatch");
    }
    const requiredHashes = expectedModel?.requiredFileSha256;
    if (
      !requiredHashes ||
      typeof requiredHashes !== "object" ||
      Array.isArray(requiredHashes) ||
      requiredFiles.some(
        (required) =>
          !SHA256_HEX.test(String(requiredHashes[required])) ||
          !snapshot.files.some((file) => file.path === required && file.sha256 === requiredHashes[required])
      )
    ) {
      blockers.push("embedding-model-artifact-required-file-hash-mismatch");
    }
  }
  const stableFields = [
    "alias",
    "hf_id",
    "dtype",
    "transformers_version",
    "file_count",
    "manifest_sha256",
    "snapshot_consistent"
  ];
  if (
    report.unchanged_during_run !== true ||
    !report.run_start ||
    !report.post_load ||
    stableFields.some((field) => report[field] !== report.run_start[field] || report[field] !== report.post_load[field])
  ) {
    blockers.push("embedding-model-artifact-changed-during-run");
  }
  return [...new Set(blockers)];
}

/** Validate release identity plus source/dist fingerprints for a canonical run. */
export function implementationPublicationBlockers(implementation) {
  if (!implementation || typeof implementation !== "object" || Array.isArray(implementation)) {
    return ["implementation-metadata-incomplete"];
  }
  const blockers = [];
  const snapshots = [implementation.run_start, implementation];
  for (const snapshot of snapshots) {
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
      blockers.push("implementation-metadata-incomplete");
      continue;
    }
    const expectedTag =
      typeof snapshot.package_version === "string" && snapshot.package_version.length > 0
        ? `v${snapshot.package_version}`
        : null;
    if (
      typeof snapshot.git_commit !== "string" ||
      !/^[a-f0-9]{40}$/.test(snapshot.git_commit) ||
      !Number.isSafeInteger(snapshot.source_file_count) ||
      snapshot.source_file_count <= 0 ||
      !Number.isSafeInteger(snapshot.dist_file_count) ||
      snapshot.dist_file_count <= 0
    ) {
      blockers.push("implementation-metadata-incomplete");
    }
    if (snapshot.git_dirty !== false) blockers.push("implementation-state-dirty");
    if (typeof snapshot.origin_url !== "string" || !EXPECTED_ORIGIN.test(snapshot.origin_url)) {
      blockers.push("implementation-origin-mismatch");
    }
    if (
      typeof snapshot.origin_main_commit !== "string" ||
      !/^[a-f0-9]{40}$/.test(snapshot.origin_main_commit) ||
      snapshot.head_on_origin_main !== true
    ) {
      blockers.push("implementation-not-on-origin-main");
    }
    if (
      expectedTag === null ||
      snapshot.release_tag !== expectedTag ||
      snapshot.release_tag_commit !== snapshot.git_commit ||
      snapshot.remote_tag_commit !== snapshot.git_commit
    ) {
      blockers.push("implementation-release-tag-mismatch");
    }
    if (
      !SHA256_HEX.test(String(snapshot.source_tree_sha256)) ||
      !SHA256_HEX.test(String(snapshot.executed_dist_sha256)) ||
      snapshot.snapshot_consistent !== true
    ) {
      blockers.push("implementation-fingerprint-missing");
    }
    if (
      !Number.isSafeInteger(snapshot.tagged_source_file_count) ||
      snapshot.tagged_source_file_count <= 0 ||
      !SHA256_HEX.test(String(snapshot.tagged_source_tree_sha256)) ||
      snapshot.source_file_count !== snapshot.tagged_source_file_count ||
      snapshot.source_tree_sha256 !== snapshot.tagged_source_tree_sha256 ||
      snapshot.source_matches_tagged_commit !== true
    ) {
      blockers.push("implementation-source-not-bound-to-tag");
    }
    if (
      !Number.isSafeInteger(snapshot.rebuilt_dist_file_count) ||
      snapshot.rebuilt_dist_file_count <= 0 ||
      !SHA256_HEX.test(String(snapshot.rebuilt_dist_sha256)) ||
      snapshot.dist_matches_source_build !== true ||
      snapshot.dist_entrypoints_present !== true
    ) {
      blockers.push("implementation-dist-not-bound-to-source");
    }
    if (snapshot.runtime_injection?.clean !== true || !SHA256_HEX.test(String(snapshot.runtime_injection?.sha256))) {
      blockers.push("implementation-runtime-injection");
    }
    const dependencies = snapshot.runtime_dependencies;
    const dependencyPaths = Array.isArray(dependencies)
      ? new Set(dependencies.map((dependency) => dependency?.lock_path))
      : new Set();
    const dependenciesValid =
      Array.isArray(dependencies) &&
      dependencies.length >= REQUIRED_RUNTIME_DEPENDENCIES.length &&
      dependencyPaths.size === dependencies.length &&
      REQUIRED_RUNTIME_DEPENDENCIES.every((name) =>
        dependencies.some((dependency) => dependency?.root_alias === name)
      ) &&
      dependencies.every(
        (dependency) =>
          dependency &&
          (dependency.root_alias === null ||
            (typeof dependency.root_alias === "string" &&
              REQUIRED_RUNTIME_DEPENDENCIES.includes(dependency.root_alias))) &&
          typeof dependency.name === "string" &&
          dependency.name.length > 0 &&
          typeof dependency.lock_path === "string" &&
          dependency.lock_path.startsWith("node_modules/") &&
          !dependency.lock_path.split("/").includes("..") &&
          typeof dependency.version === "string" &&
          dependency.version.length > 0 &&
          dependency.version === dependency.lock_version &&
          typeof dependency.lock_resolved === "string" &&
          /^https:\/\/registry\.npmjs\.org\//.test(dependency.lock_resolved) &&
          isCanonicalSha512Sri(dependency.lock_integrity) &&
          dependency.lock_matches === true &&
          dependency.metadata_matches_lock === true &&
          Number.isSafeInteger(dependency.file_count) &&
          dependency.file_count > 0 &&
          SHA256_HEX.test(String(dependency.manifest_sha256)) &&
          dependency.snapshot_consistent === true &&
          Array.isArray(dependency.dependency_paths) &&
          new Set(dependency.dependency_paths).size === dependency.dependency_paths.length &&
          dependency.dependency_paths.every((entry) => dependencyPaths.has(entry)) &&
          Array.isArray(dependency.optional_dependency_paths) &&
          new Set(dependency.optional_dependency_paths).size === dependency.optional_dependency_paths.length &&
          dependency.optional_dependency_paths.every((entry) => dependencyPaths.has(entry)) &&
          Array.isArray(dependency.missing_optional_dependencies) &&
          new Set(dependency.missing_optional_dependencies).size === dependency.missing_optional_dependencies.length &&
          dependency.missing_optional_dependencies.every((entry) => typeof entry === "string" && entry.length > 0)
      );
    if (
      snapshot.runtime_dependency_closure_complete !== true ||
      !dependenciesValid ||
      !SHA256_HEX.test(String(snapshot.runtime_dependencies_sha256)) ||
      (dependenciesValid && runtimeDependencyManifestSha256(dependencies) !== snapshot.runtime_dependencies_sha256)
    ) {
      blockers.push("implementation-runtime-dependencies-untrusted");
    }
    const missingIntegrityPaths = snapshot.runtime_dependency_integrity_missing_paths;
    if (
      snapshot.runtime_dependency_integrity_complete !== true ||
      !Array.isArray(missingIntegrityPaths) ||
      missingIntegrityPaths.length !== 0 ||
      new Set(missingIntegrityPaths).size !== missingIntegrityPaths.length ||
      !SHA256_HEX.test(String(snapshot.runtime_dependency_integrity_missing_sha256)) ||
      createHash("sha256")
        .update(JSON.stringify(missingIntegrityPaths ?? null))
        .digest("hex") !== snapshot.runtime_dependency_integrity_missing_sha256
    ) {
      blockers.push("implementation-runtime-dependency-integrity-unavailable");
    }
  }
  const stableFields = [
    "package_version",
    "git_commit",
    "git_dirty",
    "release_tag",
    "release_tag_commit",
    "origin_url",
    "origin_main_commit",
    "head_on_origin_main",
    "remote_tag_commit",
    "source_file_count",
    "source_tree_sha256",
    "tagged_source_file_count",
    "tagged_source_tree_sha256",
    "source_matches_tagged_commit",
    "dist_file_count",
    "executed_dist_sha256",
    "rebuilt_dist_file_count",
    "rebuilt_dist_sha256",
    "dist_matches_source_build",
    "dist_entrypoints_present",
    "runtime_injection_sha256",
    "runtime_dependencies_sha256",
    "runtime_dependency_closure_complete",
    "runtime_dependency_integrity_complete",
    "runtime_dependency_integrity_missing_sha256",
    "snapshot_consistent"
  ];
  if (
    implementation.unchanged_during_run !== true ||
    !implementation.run_start ||
    stableFields.some((field) => implementation[field] !== implementation.run_start[field])
  ) {
    blockers.push("implementation-changed-during-run");
  }
  return [...new Set(blockers)];
}

/** Publication state from cohort, implementation, and raw retrieval evidence. */
export function benchmarkArtifactStatus(canonicalCohort, implementation, retrieval = {}) {
  const retrievalBlockers = [];
  if (!Number.isSafeInteger(retrieval.expectedQueries) || retrieval.expectedQueries <= 0) {
    retrievalBlockers.push("retrieval-expected-query-count-invalid");
  } else {
    if (retrieval.completedQueries !== retrieval.expectedQueries) {
      retrievalBlockers.push("retrieval-query-count-mismatch");
    }
    if (retrieval.recencyCompare === true && retrieval.completedRecencyQueries !== retrieval.expectedQueries) {
      retrievalBlockers.push("retrieval-recency-query-count-mismatch");
    }
  }
  retrievalBlockers.push(
    ...corpusUniversePublicationBlockers(
      retrieval.expectedFiles,
      retrieval.expectedMaterializedPaths,
      retrieval.expectedQueryEvidence
    )
  );
  retrievalBlockers.push(...ftsSyncPublicationBlockers(retrieval.ftsSync, retrieval.expectedFiles));
  retrievalBlockers.push(
    ...materializedCorpusPublicationBlockers(retrieval.materializedCorpus, retrieval.expectedMaterializedPaths)
  );
  retrievalBlockers.push(
    ...queryEvidencePublicationBlockers(retrieval.perQuery, retrieval.expectedQueryEvidence, retrieval.k, {
      embeddings: retrieval.embeddings,
      recencyCompare: retrieval.recencyCompare,
      requireSummary: true,
      summary: retrieval.summary
    })
  );
  if (retrieval.recencyCompare === true) {
    retrievalBlockers.push(
      ...recencyEvidencePublicationBlockers(retrieval.recencyReport, retrieval.perQuery, {
        expectedWeight: retrieval.recencyWeight,
        expectedStaleDays: retrieval.staleDays,
        expectedReferenceMs: retrieval.recencyReferenceMs
      })
    );
  } else if (retrieval.recencyReport !== null && retrieval.recencyReport !== undefined) {
    retrievalBlockers.push("retrieval-unexpected-recency-summary");
  }
  if (retrieval.embeddings === true) {
    retrievalBlockers.push(...embeddingSyncPublicationBlockers(retrieval.embeddingSync, retrieval.expectedFiles));
    if (retrieval.baseEmbeddingQueries !== retrieval.expectedQueries) {
      retrievalBlockers.push("embedding-base-signal-count-mismatch");
    }
    if (retrieval.recencyCompare === true && retrieval.recencyEmbeddingQueries !== retrieval.expectedQueries) {
      retrievalBlockers.push("embedding-recency-signal-count-mismatch");
    }
  }
  const provenanceBlockers = [
    ...(retrieval.embeddings === true
      ? modelArtifactPublicationBlockers(retrieval.embeddingModelArtifacts, retrieval.expectedEmbeddingModel)
      : []),
    ...implementationPublicationBlockers(implementation)
  ];
  const publicationBlockers = [
    ...retrievalBlockers,
    ...(!canonicalCohort ? ["noncanonical-cohort"] : []),
    ...provenanceBlockers
  ];
  const uniqueBlockers = [...new Set(publicationBlockers)];
  if (retrievalBlockers.length > 0) {
    return {
      status: "diagnostic-incomplete",
      partial: true,
      publishable: false,
      publication_blockers: uniqueBlockers
    };
  }
  if (!canonicalCohort) {
    return {
      status: "diagnostic-partial",
      partial: true,
      publishable: false,
      publication_blockers: uniqueBlockers
    };
  }
  const publishable = provenanceBlockers.length === 0;
  return {
    status: publishable ? "complete" : "diagnostic-untrusted",
    partial: false,
    publishable,
    publication_blockers: uniqueBlockers
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

function pathWithin(candidate, root) {
  const absoluteCandidate = path.resolve(candidate);
  const absoluteRoot = path.resolve(root);
  return absoluteCandidate === absoluteRoot || absoluteCandidate.startsWith(`${absoluteRoot}${path.sep}`);
}

/** Reject result paths that could overwrite executed or fingerprinted inputs. */
export function benchmarkOutputIsProtected(output, modelRoot = null) {
  if (!output) return false;
  if (
    pathWithin(output, repoRoot) &&
    !OUTPUT_ALLOWED_REPOSITORY_ROOTS.some((relative) => pathWithin(output, path.join(repoRoot, relative)))
  ) {
    return true;
  }
  if (OUTPUT_PROTECTED_PATHS.some((relative) => pathWithin(output, path.join(repoRoot, relative)))) return true;
  return modelRoot !== null && pathWithin(output, modelRoot);
}

async function canonicalPotentialPath(candidate) {
  let cursor = path.resolve(candidate);
  const suffix = [];
  for (;;) {
    try {
      await fs.lstat(cursor);
      const canonicalParent = await fs.realpath(cursor);
      return path.join(canonicalParent, ...suffix);
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      suffix.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

/**
 * Canonical, symlink-aware output-path guard for destructive benchmark writes.
 *
 * Existing ancestors are resolved with `realpath`, so a harmless-looking
 * `/tmp/out-link/result.json` cannot redirect the atomic rename into `.git`,
 * executed sources, the dataset, or exact model cache.
 */
export async function benchmarkOutputSafetyBlocker(output, { dataset = null, modelRoot = null } = {}) {
  if (!output) return null;
  const candidate = await canonicalPotentialPath(output);
  for (const relative of OUTPUT_PROTECTED_PATHS) {
    const protectedRoot = await canonicalPotentialPath(path.join(repoRoot, relative));
    if (pathWithin(candidate, protectedRoot)) return "protected-repository-state";
  }
  const canonicalRepoRoot = await canonicalPotentialPath(repoRoot);
  const allowedRepositoryRoots = await Promise.all(
    OUTPUT_ALLOWED_REPOSITORY_ROOTS.map((relative) => canonicalPotentialPath(path.join(repoRoot, relative)))
  );
  if (
    pathWithin(candidate, canonicalRepoRoot) &&
    !allowedRepositoryRoots.some((allowedRoot) => pathWithin(candidate, allowedRoot))
  ) {
    return "protected-repository-state";
  }
  if (dataset !== null && candidate === (await canonicalPotentialPath(dataset))) return "benchmark-dataset";
  if (modelRoot !== null) {
    const canonicalModelRoot = await canonicalPotentialPath(modelRoot);
    if (pathWithin(candidate, canonicalModelRoot)) return "embedding-model-cache";
  }
  return null;
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
    for (const signal of new Set(row.signals_used)) counts[signal] += 1;
  }
  return counts;
}

export function sanitizedGitEnv(source = process.env) {
  const env = { ...source };
  for (const name of Object.keys(env)) {
    if (
      name.startsWith("GIT_") ||
      name === "SSH_ASKPASS" ||
      name === "SSH_ASKPASS_REQUIRE" ||
      name === "HTTP_PROXY" ||
      name === "HTTPS_PROXY" ||
      name === "ALL_PROXY" ||
      name === "NO_PROXY" ||
      name === "http_proxy" ||
      name === "https_proxy" ||
      name === "all_proxy" ||
      name === "no_proxy" ||
      name === "CURL_CA_BUNDLE" ||
      name === "SSL_CERT_FILE" ||
      name === "SSL_CERT_DIR"
    ) {
      delete env[name];
    }
  }
  env.GIT_ALLOW_PROTOCOL = "https";
  env.GIT_CONFIG_GLOBAL = os.devNull;
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_SYSTEM = os.devNull;
  env.GIT_NO_REPLACE_OBJECTS = "1";
  env.GIT_PROTOCOL_FROM_USER = "0";
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

export function hardenedGitText(args, opts = {}) {
  try {
    return execFileSync(TRUSTED_GIT_EXECUTABLE, [...HARDENED_GIT_ARGS, ...args], {
      cwd: opts.cwd ?? repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: sanitizedGitEnv(),
      timeout: opts.timeout ?? 15_000
    }).trim();
  } catch {
    return null;
  }
}

function gitBuffer(args) {
  try {
    return execFileSync(TRUSTED_GIT_EXECUTABLE, [...HARDENED_GIT_ARGS, ...args], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "ignore"],
      env: sanitizedGitEnv(),
      timeout: 15_000
    });
  } catch {
    return null;
  }
}

function gitSucceeds(args) {
  try {
    execFileSync(TRUSTED_GIT_EXECUTABLE, [...HARDENED_GIT_ARGS, ...args], {
      cwd: repoRoot,
      stdio: "ignore",
      env: sanitizedGitEnv(),
      timeout: 15_000
    });
    return true;
  } catch {
    return false;
  }
}

function gitTreeManifest(commit, implementationPaths = IMPLEMENTATION_PATHS) {
  if (!/^[a-f0-9]{40}$/.test(commit ?? "")) {
    return { files: [], file_count: 0, manifest_sha256: null, snapshot_consistent: false };
  }
  const listing = gitBuffer(["ls-tree", "-r", "-z", "--full-tree", commit, "--", ...implementationPaths]);
  if (!listing) return { files: [], file_count: 0, manifest_sha256: null, snapshot_consistent: false };
  const files = [];
  for (const encoded of listing.toString("utf8").split("\0").filter(Boolean)) {
    const tab = encoded.indexOf("\t");
    const metadata = tab >= 0 ? encoded.slice(0, tab) : "";
    const relative = tab >= 0 ? encoded.slice(tab + 1) : "";
    const match = /^(100644|100755) blob ([a-f0-9]{40})$/.exec(metadata);
    if (!match || relative.length === 0 || path.isAbsolute(relative) || relative.split("/").includes("..")) {
      return { files: [], file_count: 0, manifest_sha256: null, snapshot_consistent: false };
    }
    const bytes = gitBuffer(["cat-file", "blob", match[2]]);
    if (!bytes) return { files: [], file_count: 0, manifest_sha256: null, snapshot_consistent: false };
    files.push({
      path: relative,
      mode: match[1],
      size_bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex")
    });
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return {
    files,
    file_count: files.length,
    manifest_sha256: files.length > 0 ? artifactManifestSha256(files) : null,
    snapshot_consistent: files.length > 0
  };
}

function remoteReleaseRefs(tag, checkRemote) {
  if (!checkRemote || !tag) return { origin_main_commit: null, remote_tag_commit: null };
  const output = hardenedGitText(
    ["ls-remote", CANONICAL_GIT_REMOTE, "refs/heads/main", `refs/tags/${tag}`, `refs/tags/${tag}^{}`],
    {
      cwd: path.parse(repoRoot).root,
      timeout: 30_000
    }
  );
  const refs = new Map();
  for (const line of output?.split("\n") ?? []) {
    const [commit, ref] = line.trim().split(/\s+/);
    if (/^[a-f0-9]{40}$/.test(commit ?? "") && ref) refs.set(ref, commit);
  }
  return {
    origin_main_commit: refs.get("refs/heads/main") ?? null,
    remote_tag_commit: refs.get(`refs/tags/${tag}^{}`) ?? refs.get(`refs/tags/${tag}`) ?? null
  };
}

async function sha256File(file) {
  const beforeLink = await fs.lstat(file);
  if (!beforeLink.isFile()) throw new Error(`manifest entry is not a regular file: ${file}`);
  const handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.dev !== beforeLink.dev || before.ino !== beforeLink.ino) {
      throw new Error(`manifest entry changed before hashing: ${file}`);
    }
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    const after = await handle.stat();
    const afterLink = await fs.lstat(file);
    const stableFields = ["dev", "ino", "size", "mtimeMs", "ctimeMs", "mode"];
    return {
      mode: after.mode & 0o111 ? "100755" : "100644",
      size_bytes: after.size,
      sha256: hash.digest("hex"),
      consistent:
        afterLink.isFile() &&
        stableFields.every((field) => before[field] === after[field]) &&
        after.dev === afterLink.dev &&
        after.ino === afterLink.ino
    };
  } finally {
    await handle.close();
  }
}

async function assertNoSymlinkPath(root, candidate) {
  const absoluteRoot = path.resolve(root);
  const absoluteCandidate = path.resolve(candidate);
  if (!pathWithin(absoluteCandidate, absoluteRoot)) {
    throw new Error(`path escapes manifest root: ${absoluteCandidate}`);
  }
  const rootStat = await fs.lstat(absoluteRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`manifest root is not a real directory: ${absoluteRoot}`);
  }
  const relative = path.relative(absoluteRoot, absoluteCandidate);
  let cursor = absoluteRoot;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    const stat = await fs.lstat(cursor);
    if (stat.isSymbolicLink()) throw new Error(`manifest path contains a symlink: ${cursor}`);
  }
  const canonicalRoot = await fs.realpath(absoluteRoot);
  const canonicalCandidate = await fs.realpath(absoluteCandidate);
  if (!pathWithin(canonicalCandidate, canonicalRoot)) {
    throw new Error(`manifest path escapes canonical root: ${absoluteCandidate}`);
  }
}

async function regularFilesUnder(root, relativeRoot = "", excludedRoots = new Set()) {
  const absolute = path.join(root, relativeRoot);
  await assertNoSymlinkPath(root, absolute);
  const rootStat = await fs.lstat(absolute);
  if (!rootStat.isDirectory()) throw new Error(`manifest root is not a real directory: ${absolute}`);
  const entries = await fs.readdir(absolute, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = path.join(relativeRoot, entry.name);
    const portable = relative.split(path.sep).join("/");
    if ([...excludedRoots].some((excluded) => portable === excluded || portable.startsWith(`${excluded}/`))) {
      if (!entry.isDirectory()) throw new Error(`excluded manifest root is not a real directory: ${relative}`);
      continue;
    }
    if (entry.isDirectory()) files.push(...(await regularFilesUnder(root, relative, excludedRoots)));
    else if (entry.isFile()) files.push(relative.split(path.sep).join("/"));
    else throw new Error(`non-regular manifest entry: ${relative}`);
  }
  return files.sort();
}

async function fileManifest(root, relativeFiles) {
  const files = [];
  let consistent = true;
  const normalizedRoot = path.resolve(root);
  const normalizedFiles = [...relativeFiles].map((relative) => relative.split(path.sep).join("/")).sort();
  if (new Set(normalizedFiles).size !== normalizedFiles.length) throw new Error("duplicate manifest path");
  for (const relative of normalizedFiles) {
    const absolute = path.resolve(normalizedRoot, relative);
    if (absolute !== normalizedRoot && !absolute.startsWith(`${normalizedRoot}${path.sep}`)) {
      throw new Error(`manifest path escapes root: ${relative}`);
    }
    await assertNoSymlinkPath(normalizedRoot, absolute);
    const digest = await sha256File(absolute);
    consistent &&= digest.consistent;
    files.push({
      path: relative,
      mode: digest.mode,
      size_bytes: digest.size_bytes,
      sha256: digest.sha256
    });
  }
  return {
    files,
    file_count: files.length,
    manifest_sha256: files.length > 0 ? artifactManifestSha256(files) : null,
    snapshot_consistent: consistent
  };
}

async function implementationFilesystemFiles() {
  const files = [];
  for (const relative of IMPLEMENTATION_PATHS) {
    const absolute = path.join(repoRoot, relative);
    await assertNoSymlinkPath(repoRoot, absolute);
    const stat = await fs.lstat(absolute);
    if (stat.isDirectory()) files.push(...(await regularFilesUnder(repoRoot, relative)));
    else if (stat.isFile()) files.push(relative);
    else throw new Error(`implementation path is not a regular file or directory: ${relative}`);
  }
  const unique = [...new Set(files.map((relative) => relative.split(path.sep).join("/")))].sort();
  if (unique.length !== files.length) throw new Error("duplicate implementation file");
  return unique;
}

async function compiledDistReceipt() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-lme-build-"));
  try {
    execFileSync(
      process.execPath,
      [
        path.join(repoRoot, "node_modules", "typescript-native", "bin", "tsc"),
        "--project",
        path.join(repoRoot, "tsconfig.json"),
        "--outDir",
        tempRoot
      ],
      {
        cwd: repoRoot,
        stdio: "ignore",
        timeout: 120_000
      }
    );
    await fs.chmod(path.join(tempRoot, "index.js"), 0o755);
    const rebuiltFiles = (await regularFilesUnder(tempRoot)).filter((relative) => relative.endsWith(".js"));
    const executedFiles = (await regularFilesUnder(distDir)).filter((relative) => relative.endsWith(".js"));
    const rebuilt = await fileManifest(tempRoot, rebuiltFiles);
    const executed = await fileManifest(distDir, executedFiles);
    return {
      rebuilt,
      executed,
      matches:
        rebuilt.file_count === executed.file_count &&
        rebuilt.manifest_sha256 !== null &&
        rebuilt.manifest_sha256 === executed.manifest_sha256
    };
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

export async function runtimeDependenciesSnapshot() {
  const lock = JSON.parse(await fs.readFile(path.join(repoRoot, "package-lock.json"), "utf8"));
  const lockPackages = lock.packages ?? {};
  const receipts = new Map();

  const resolveLockPath = (requestName, fromRoot) => {
    const requestParts = requestName.split("/");
    let cursor = path.resolve(fromRoot);
    for (;;) {
      const candidate = path.join(cursor, "node_modules", ...requestParts);
      const relative = path.relative(repoRoot, candidate).split(path.sep).join("/");
      if (relative.startsWith("node_modules/") && !relative.split("/").includes("..") && lockPackages[relative]) {
        return relative;
      }
      if (cursor === repoRoot) return null;
      const parent = path.dirname(cursor);
      if (!pathWithin(parent, repoRoot)) return null;
      cursor = parent;
    }
  };

  const visit = async ({ requestName, expectedName = null, fromRoot, rootAlias = null, optional = false }) => {
    const relativeRoot = resolveLockPath(requestName, fromRoot);
    if (relativeRoot === null) {
      if (optional) return null;
      throw new Error(`runtime dependency missing from package-lock graph: ${requestName}`);
    }
    const existing = receipts.get(relativeRoot);
    if (existing) {
      if (rootAlias !== null) existing.root_alias = rootAlias;
      return relativeRoot;
    }
    const root = path.join(repoRoot, relativeRoot);
    try {
      await assertNoSymlinkPath(repoRoot, root);
    } catch (error) {
      if (optional && error?.code === "ENOENT") return null;
      throw error;
    }
    const metadata = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
    if (
      typeof metadata.name !== "string" ||
      metadata.name.length === 0 ||
      (expectedName !== null && metadata.name !== expectedName)
    ) {
      throw new Error(`runtime dependency metadata mismatch at ${relativeRoot}`);
    }
    const receipt = { root_alias: rootAlias, lock_path: relativeRoot };
    receipts.set(relativeRoot, receipt);
    const lockEntry = lock.packages?.[relativeRoot];
    if (!lockEntry) throw new Error(`runtime dependency missing from package-lock: ${relativeRoot}`);
    const dependencyPaths = [];
    const requiredNames = new Set([
      ...Object.keys(lockEntry.dependencies ?? {}),
      ...Object.keys(lockEntry.peerDependencies ?? {}).filter(
        (dependencyName) => lockEntry.peerDependenciesMeta?.[dependencyName]?.optional !== true
      )
    ]);
    for (const dependencyName of [...requiredNames].sort()) {
      const childPath = await visit({
        requestName: dependencyName,
        fromRoot: root,
        optional: false
      });
      if (childPath) dependencyPaths.push(childPath);
    }
    const optionalDependencyPaths = [];
    const missingOptionalDependencies = [];
    const optionalNames = new Set([
      ...Object.keys(lockEntry.optionalDependencies ?? {}),
      ...Object.keys(lockEntry.peerDependencies ?? {}).filter(
        (dependencyName) => lockEntry.peerDependenciesMeta?.[dependencyName]?.optional === true
      )
    ]);
    for (const dependencyName of [...optionalNames].sort()) {
      const childPath = await visit({
        requestName: dependencyName,
        fromRoot: root,
        optional: true
      });
      if (childPath) optionalDependencyPaths.push(childPath);
      else missingOptionalDependencies.push(dependencyName);
    }
    const packageFiles = await regularFilesUnder(
      root,
      "",
      new Set(metadata.name === "@huggingface/transformers" ? [".cache", "node_modules"] : ["node_modules"])
    );
    const manifest = await fileManifest(root, packageFiles);
    const normalizedNames = (value) => Object.keys(value ?? {}).sort();
    const metadataRequiredNames = [
      ...new Set([
        ...normalizedNames(metadata.dependencies),
        ...normalizedNames(metadata.peerDependencies).filter(
          (dependencyName) => metadata.peerDependenciesMeta?.[dependencyName]?.optional !== true
        )
      ])
    ].sort();
    const metadataOptionalNames = [
      ...new Set([
        ...normalizedNames(metadata.optionalDependencies),
        ...normalizedNames(metadata.peerDependencies).filter(
          (dependencyName) => metadata.peerDependenciesMeta?.[dependencyName]?.optional === true
        )
      ])
    ].sort();
    const lockRequiredNames = [...requiredNames].sort();
    const lockOptionalNames = [...optionalNames].sort();
    const metadataMatchesLock =
      JSON.stringify(metadataRequiredNames) === JSON.stringify(lockRequiredNames) &&
      JSON.stringify(metadataOptionalNames) === JSON.stringify(lockOptionalNames);
    Object.assign(receipt, {
      name: metadata.name ?? requestName,
      version: metadata.version ?? null,
      lock_version: lockEntry?.version ?? null,
      lock_resolved: lockEntry?.resolved ?? null,
      lock_integrity: lockEntry?.integrity ?? null,
      lock_matches: metadata.version === lockEntry?.version && metadataMatchesLock,
      metadata_matches_lock: metadataMatchesLock,
      file_count: manifest.file_count,
      manifest_sha256: manifest.manifest_sha256,
      snapshot_consistent: manifest.snapshot_consistent,
      dependency_paths: [...new Set(dependencyPaths)].sort(),
      optional_dependency_paths: [...new Set(optionalDependencyPaths)].sort(),
      missing_optional_dependencies: missingOptionalDependencies
    });
    return relativeRoot;
  };

  for (const { name, packageName } of REQUIRED_RUNTIME_DEPENDENCY_ROOT_SPECS) {
    await visit({
      requestName: name,
      expectedName: packageName,
      fromRoot: repoRoot,
      rootAlias: name,
      optional: false
    });
  }
  const dependencies = [...receipts.values()].sort((left, right) => left.lock_path.localeCompare(right.lock_path));
  const integrityMissingPaths = dependencies
    .filter(
      (receipt) =>
        typeof receipt.lock_resolved !== "string" ||
        !/^https:\/\/registry\.npmjs\.org\//.test(receipt.lock_resolved) ||
        !isCanonicalSha512Sri(receipt.lock_integrity)
    )
    .map((receipt) => receipt.lock_path);
  return {
    dependencies,
    closureComplete: true,
    integrityComplete: integrityMissingPaths.length === 0,
    integrityMissingPaths
  };
}

async function implementationSnapshot({ checkRemote = false } = {}) {
  let packageVersion = null;
  try {
    packageVersion = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8")).version ?? null;
  } catch {
    // The publication guard below will fail closed on incomplete metadata.
  }
  const commitBefore = hardenedGitText(["rev-parse", "HEAD"]);
  const statusArgs = ["status", "--porcelain=v1", "--untracked-files=all", "--", ...IMPLEMENTATION_PATHS];
  const statusBefore = hardenedGitText(statusArgs);
  const releaseTag = typeof packageVersion === "string" && packageVersion.length > 0 ? `v${packageVersion}` : null;
  const releaseTagCommit = releaseTag ? hardenedGitText(["rev-parse", "--verify", `${releaseTag}^{commit}`]) : null;
  const originUrl = hardenedGitText(["remote", "get-url", "origin"]);
  const remoteRefs = remoteReleaseRefs(releaseTag, checkRemote);
  let source = { file_count: 0, manifest_sha256: null, snapshot_consistent: false };
  let taggedSource = { file_count: 0, manifest_sha256: null, snapshot_consistent: false };
  let dist = { file_count: 0, manifest_sha256: null, snapshot_consistent: false };
  let compiled = {
    rebuilt: { file_count: 0, manifest_sha256: null, snapshot_consistent: false },
    executed: { file_count: 0, manifest_sha256: null, snapshot_consistent: false },
    matches: false
  };
  let runtimeDependencies = [];
  let runtimeDependencyClosureComplete = false;
  let runtimeDependencyIntegrityComplete = false;
  let runtimeDependencyIntegrityMissingPaths = [];
  try {
    source = await fileManifest(repoRoot, await implementationFilesystemFiles());
  } catch {
    // The publication guard below will fail closed on incomplete metadata.
  }
  taggedSource = gitTreeManifest(remoteRefs.remote_tag_commit);
  try {
    dist = await fileManifest(repoRoot, await regularFilesUnder(repoRoot, path.relative(repoRoot, distDir)));
  } catch {
    // The publication guard below will fail closed on incomplete metadata.
  }
  try {
    compiled = await compiledDistReceipt();
  } catch {
    // The publication guard below will fail closed on an unbound dist.
  }
  try {
    const runtimeReceipt = await runtimeDependenciesSnapshot();
    runtimeDependencies = runtimeReceipt.dependencies;
    runtimeDependencyClosureComplete = runtimeReceipt.closureComplete;
    runtimeDependencyIntegrityComplete = runtimeReceipt.integrityComplete;
    runtimeDependencyIntegrityMissingPaths = runtimeReceipt.integrityMissingPaths;
  } catch {
    // The publication guard below will fail closed on an incomplete dependency receipt.
  }
  const commitAfter = hardenedGitText(["rev-parse", "HEAD"]);
  const statusAfter = hardenedGitText(statusArgs);
  const runtimeInjection = runtimeInjectionSnapshot();
  const runtimeDependenciesSha256 =
    runtimeDependencies.length > 0 ? runtimeDependencyManifestSha256(runtimeDependencies) : null;
  const runtimeDependencyIntegrityMissingSha256 = createHash("sha256")
    .update(JSON.stringify(runtimeDependencyIntegrityMissingPaths))
    .digest("hex");
  const distEntrypoints = [
    "dist/embed-db.js",
    "dist/embeddings.js",
    "dist/eval.js",
    "dist/fts5.js",
    "dist/server.js",
    "dist/tools/index.js",
    "dist/vault.js"
  ];
  return {
    package_version: packageVersion,
    git_commit: commitAfter,
    git_dirty: statusBefore === null || statusAfter === null ? null : statusBefore.length > 0 || statusAfter.length > 0,
    release_tag: releaseTag,
    release_tag_commit: releaseTagCommit,
    origin_url: originUrl,
    origin_main_commit: remoteRefs.origin_main_commit,
    head_on_origin_main:
      commitAfter !== null &&
      remoteRefs.origin_main_commit !== null &&
      gitSucceeds(["merge-base", "--is-ancestor", commitAfter, remoteRefs.origin_main_commit]),
    remote_tag_commit: remoteRefs.remote_tag_commit,
    source_file_count: source.file_count,
    source_tree_sha256: source.manifest_sha256,
    tagged_source_file_count: taggedSource.file_count,
    tagged_source_tree_sha256: taggedSource.manifest_sha256,
    source_matches_tagged_commit:
      source.file_count > 0 &&
      source.file_count === taggedSource.file_count &&
      source.manifest_sha256 === taggedSource.manifest_sha256,
    dist_file_count: dist.file_count,
    executed_dist_sha256: dist.manifest_sha256,
    rebuilt_dist_file_count: compiled.rebuilt.file_count,
    rebuilt_dist_sha256: compiled.rebuilt.manifest_sha256,
    dist_matches_source_build: compiled.matches,
    dist_entrypoints_present: distEntrypoints.every((entrypoint) =>
      dist.files?.some((file) => file.path === entrypoint)
    ),
    runtime_injection: runtimeInjection,
    runtime_injection_sha256: runtimeInjection.sha256,
    runtime_dependencies: runtimeDependencies,
    runtime_dependencies_sha256: runtimeDependenciesSha256,
    runtime_dependency_closure_complete: runtimeDependencyClosureComplete,
    runtime_dependency_integrity_complete: runtimeDependencyIntegrityComplete,
    runtime_dependency_integrity_missing_paths: runtimeDependencyIntegrityMissingPaths,
    runtime_dependency_integrity_missing_sha256: runtimeDependencyIntegrityMissingSha256,
    snapshot_consistent:
      source.snapshot_consistent &&
      taggedSource.snapshot_consistent &&
      dist.snapshot_consistent &&
      compiled.rebuilt.snapshot_consistent &&
      compiled.executed.snapshot_consistent &&
      runtimeDependencyClosureComplete &&
      runtimeDependencies.every((dependency) => dependency.snapshot_consistent === true) &&
      commitBefore !== null &&
      commitBefore === commitAfter &&
      statusBefore !== null &&
      statusBefore === statusAfter
  };
}

async function implementationMetadata(runStart, opts) {
  const runEnd = await implementationSnapshot(opts);
  const stableFields = [
    "package_version",
    "git_commit",
    "git_dirty",
    "release_tag",
    "release_tag_commit",
    "origin_url",
    "origin_main_commit",
    "head_on_origin_main",
    "remote_tag_commit",
    "source_file_count",
    "source_tree_sha256",
    "tagged_source_file_count",
    "tagged_source_tree_sha256",
    "source_matches_tagged_commit",
    "dist_file_count",
    "executed_dist_sha256",
    "rebuilt_dist_file_count",
    "rebuilt_dist_sha256",
    "dist_matches_source_build",
    "dist_entrypoints_present",
    "runtime_injection_sha256",
    "runtime_dependencies_sha256",
    "runtime_dependency_closure_complete",
    "runtime_dependency_integrity_complete",
    "runtime_dependency_integrity_missing_sha256",
    "snapshot_consistent"
  ];
  return {
    ...runEnd,
    run_start: runStart,
    unchanged_during_run: stableFields.every((field) => runStart[field] === runEnd[field])
  };
}

export async function modelArtifactSnapshot(embeddingsModule, model, trustRoot = repoRoot) {
  const cacheRoot =
    typeof embeddingsModule?.resolveTransformersCacheDir === "function"
      ? embeddingsModule.resolveTransformersCacheDir()
      : null;
  let transformersVersion = null;
  let manifest = { files: [], file_count: 0, manifest_sha256: null, snapshot_consistent: false };
  if (cacheRoot) {
    try {
      await assertNoSymlinkPath(trustRoot, cacheRoot);
      transformersVersion =
        JSON.parse(await fs.readFile(path.join(cacheRoot, "..", "package.json"), "utf8")).version ?? null;
    } catch {
      // The publication guard below will fail closed on incomplete metadata.
    }
    try {
      const modelRoot = path.join(cacheRoot, ...model.hfId.split("/"));
      await assertNoSymlinkPath(trustRoot, modelRoot);
      manifest = await fileManifest(modelRoot, await regularFilesUnder(modelRoot));
    } catch {
      // The publication guard below will fail closed on incomplete metadata.
    }
  }
  return {
    alias: model.alias,
    hf_id: model.hfId,
    dtype: model.dtype,
    transformers_version: transformersVersion,
    ...manifest
  };
}

async function modelArtifactMetadata(embeddingsModule, model, runStart, postLoad) {
  const runEnd = await modelArtifactSnapshot(embeddingsModule, model);
  const stableFields = [
    "alias",
    "hf_id",
    "dtype",
    "transformers_version",
    "file_count",
    "manifest_sha256",
    "snapshot_consistent"
  ];
  return {
    ...runEnd,
    run_start: runStart,
    post_load: postLoad,
    unchanged_during_run: stableFields.every(
      (field) => runStart[field] === postLoad[field] && postLoad[field] === runEnd[field]
    )
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

export async function writeJsonAtomic(output, payload, { dataset = null, modelRoot = null } = {}) {
  const requested = path.resolve(output);
  const basename = path.basename(requested);
  if (basename.length === 0) throw new Error("benchmark output must name a file");
  const parentCandidate = await canonicalPotentialPath(path.dirname(requested));
  const targetCandidate = path.join(parentCandidate, basename);
  const initialBlocker = await benchmarkOutputSafetyBlocker(targetCandidate, { dataset, modelRoot });
  if (initialBlocker !== null) throw new Error(`unsafe benchmark output target: ${initialBlocker}`);

  await fs.mkdir(parentCandidate, { recursive: true });
  const canonicalParent = await fs.realpath(parentCandidate);
  const parentBefore = await fs.lstat(canonicalParent);
  if (!parentBefore.isDirectory() || parentBefore.isSymbolicLink()) {
    throw new Error("benchmark output parent must be a real directory");
  }
  if (process.platform !== "win32" && (parentBefore.mode & 0o022) !== 0) {
    throw new Error("benchmark output parent must not be group/world-writable");
  }

  const absolute = path.join(canonicalParent, basename);
  const canonicalBlocker = await benchmarkOutputSafetyBlocker(absolute, { dataset, modelRoot });
  if (canonicalBlocker !== null) throw new Error(`unsafe benchmark output target: ${canonicalBlocker}`);

  let tempDir = null;
  let handle = null;
  try {
    tempDir = await fs.mkdtemp(path.join(canonicalParent, ".enquire-longmemeval-"));
    await fs.chmod(tempDir, 0o700);
    const temp = path.join(tempDir, "result.json");
    handle = await fs.open(
      temp,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      0o600
    );
    await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await handle.sync();
    const written = await handle.stat();
    await handle.close();
    handle = null;
    const writtenPath = await fs.lstat(temp);
    if (
      !writtenPath.isFile() ||
      written.dev !== writtenPath.dev ||
      written.ino !== writtenPath.ino ||
      written.size !== writtenPath.size
    ) {
      throw new Error("benchmark output temporary file changed before rename");
    }
    const parentAfter = await fs.lstat(canonicalParent);
    if (!parentAfter.isDirectory() || parentBefore.dev !== parentAfter.dev || parentBefore.ino !== parentAfter.ino) {
      throw new Error("benchmark output parent changed before rename");
    }
    const finalBlocker = await benchmarkOutputSafetyBlocker(absolute, { dataset, modelRoot });
    if (finalBlocker !== null) throw new Error(`unsafe benchmark output target: ${finalBlocker}`);
    await fs.rename(temp, absolute);
  } finally {
    await handle?.close();
    if (tempDir !== null) await fs.rm(tempDir, { recursive: true, force: true });
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
  if (args.output && (await benchmarkOutputSafetyBlocker(args.output, { dataset: args.dataset })) !== null) {
    process.stderr.write("enquire LongMemEval: --output must not overwrite benchmark inputs or executable state\n");
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
  const canonicalDatasetSelection = isCanonicalLongMemEvalS(dataset, Math.min(instances.length, args.limit));
  const implementationOpts = { checkRemote: canonicalDatasetSelection };
  const implementationStart = await implementationSnapshot(implementationOpts);

  const { Vault } = await import(path.join(distDir, "vault.js"));
  const { FtsIndex, syncFtsIndex } = await import(path.join(distDir, "fts5.js"));
  const { syncEmbedDb } = await import(path.join(distDir, "embed-sync.js"));
  const { searchHybrid } = await import(path.join(distDir, "tools", "search.js"));

  let embedder = null;
  let embedModel = null;
  let EmbedDbCtor = null;
  let embeddingsModule = null;
  let embeddingModelArtifactsStart = null;
  let embeddingModelArtifactsPostLoad = null;
  let modelRootForOutput = null;
  if (args.embeddings) {
    try {
      const emb = await import(path.join(distDir, "embeddings.js"));
      embeddingsModule = emb;
      ({ EmbedDb: EmbedDbCtor } = await import(path.join(distDir, "embed-db.js")));
      embedModel = emb.resolveModel(undefined); // the default local alias
      if (
        embedModel.alias !== CANONICAL_EMBEDDING_MODEL.alias ||
        embedModel.hfId !== CANONICAL_EMBEDDING_MODEL.hfId ||
        embedModel.dtype !== CANONICAL_EMBEDDING_MODEL.dtype ||
        embedModel.dim !== CANONICAL_EMBEDDING_MODEL.dim
      ) {
        throw new Error("executed embedding catalog does not match the pinned canonical q8 model");
      }
      const cacheRoot = emb.resolveTransformersCacheDir?.();
      const modelRoot = cacheRoot ? path.join(cacheRoot, ...embedModel.hfId.split("/")) : null;
      modelRootForOutput = modelRoot;
      if (
        args.output &&
        modelRoot &&
        (await benchmarkOutputSafetyBlocker(args.output, { dataset: args.dataset, modelRoot })) !== null
      ) {
        throw new Error("--output would overwrite the exact embedding-model cache");
      }
      emb.setEmbeddingsOffline?.(true);
      embeddingModelArtifactsStart = await modelArtifactSnapshot(emb, embedModel);
      process.stderr.write(`loading local embedder '${embedModel.alias}' (one-time)…\n`);
      embedder = await emb.loadEmbedder(embedModel.alias);
      embeddingModelArtifactsPostLoad = await modelArtifactSnapshot(emb, embedModel);
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
  const expectedNotes = scorable.reduce((sum, { inst }) => sum + inst.haystack_sessions.length, 0);
  const expectedMaterializedPaths = scorable
    .flatMap(({ inst }) => inst.haystack_sessions.map((_session, index) => sessionNotePath(inst.question_id, index)))
    .sort();

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
  let ftsSyncReport = null;
  let embeddingSyncReport = null;
  let materializedCorpusReport = null;
  let recencyReferenceMs = null;
  let notesWritten = 0;
  let embedFile = "";
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

    // Normalize before either content index is built. Both FTS and embeddings
    // therefore record the same final mtime map used by recency queries.
    const retimeStarted = performance.now();
    const mtimeAnchor = Date.now();
    recencyReferenceMs = mtimeAnchor;
    for (const { inst } of scorable) {
      for (let si = 0; si < inst.haystack_sessions.length; si++) {
        const absolute = path.join(vaultRoot, sessionNotePath(inst.question_id, si));
        const mtime = normalizedSessionMtimeMs(inst.haystack_dates[si], inst.question_date, mtimeAnchor);
        await fs.utimes(absolute, new Date(mtime), new Date(mtime));
      }
    }
    timing.retime_ms = elapsedMs(retimeStarted);
    const corpusBeforeQueries = await fileManifest(vaultRoot, expectedMaterializedPaths);

    const indexVault = new Vault(vaultRoot);
    ftsIndex = new FtsIndex({ file: path.join(idxDir, "lme.fts5.db"), vaultRoot: indexVault.root });
    const ftsStarted = performance.now();
    await ftsIndex.open();
    ftsSyncReport = await syncFtsIndex(indexVault, ftsIndex, { mode: "strict" });
    timing.fts_index_ms = elapsedMs(ftsStarted);

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
        embeddingSyncReport = await syncEmbedDb(indexVault, db, embedder, { mode: "strict" });
      } finally {
        db.close();
      }
      indexFootprint.embeddings_bytes = await sqliteFootprintBytes(embedFile);
      timing.embedding_index_ms = elapsedMs(embedStarted);
    }

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
          {
            ...searchCtx,
            recency: {
              weight: args.recencyWeight,
              staleDays: args.staleDays,
              nowMs: recencyReferenceMs
            }
          }
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
    const corpusAfterQueries = await fileManifest(vaultRoot, expectedMaterializedPaths);
    const postRunEntries = await indexVault.listMarkdown();
    const postRunFtsDiff = ftsIndex.diff(
      postRunEntries.map((entry) => ({ relPath: entry.relPath, mtimeMs: entry.mtimeMs })),
      "md"
    );
    materializedCorpusReport = {
      before_queries: corpusBeforeQueries,
      after_queries: corpusAfterQueries,
      post_run_fts_diff: postRunFtsDiff,
      unchanged_during_queries:
        corpusBeforeQueries.manifest_sha256 === corpusAfterQueries.manifest_sha256 &&
        postRunFtsDiff.added.length === 0 &&
        postRunFtsDiff.updated.length === 0 &&
        postRunFtsDiff.deleted.length === 0 &&
        postRunFtsDiff.unchanged.length === expectedMaterializedPaths.length
    };
    const ftsPostRunAudit = ftsIndex.auditKind("md");
    const ftsPostRunManifestSha256 = ftsIndex.fingerprintKind("md");
    ftsSyncReport = {
      ...ftsSyncReport,
      post_run_audit: ftsPostRunAudit,
      post_run_manifest_sha256: ftsPostRunManifestSha256,
      post_run_unchanged:
        ftsSyncReport !== null &&
        ftsSyncReport.manifest_sha256 === ftsPostRunManifestSha256 &&
        ["declared_files", "indexed_files", "declared_chunks", "indexed_chunks", "mismatched_files"].every(
          (field) => ftsSyncReport[field] === ftsPostRunAudit[field]
        )
    };
    if (embeddingSyncReport && EmbedDbCtor && embedModel && embedFile) {
      const postRunDb = new EmbedDbCtor({
        file: embedFile,
        vaultRoot: indexVault.root,
        modelAlias: embedModel.alias,
        dim: embedModel.dim
      });
      try {
        await postRunDb.open();
        const embeddingPostRunAudit = postRunDb.auditKind("md");
        const embeddingPostRunVectorAudit = postRunDb.auditVectorHealth("md");
        const embeddingPostRunManifestSha256 = postRunDb.fingerprintKind("md");
        embeddingSyncReport = {
          ...embeddingSyncReport,
          post_run_audit: embeddingPostRunAudit,
          post_run_vector_audit: embeddingPostRunVectorAudit,
          post_run_manifest_sha256: embeddingPostRunManifestSha256,
          post_run_unchanged:
            embeddingSyncReport.manifest_sha256 === embeddingPostRunManifestSha256 &&
            embeddingPostRunVectorAudit.invalid_vectors === 0 &&
            ["indexed_files", "declared_chunks", "indexed_chunks", "mismatched_files"].every(
              (field) => embeddingSyncReport[field] === embeddingPostRunAudit[field]
            )
        };
      } finally {
        postRunDb.close();
      }
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
  const baseSignalCounts = countSignals(base);
  const recencySignalCounts = args.recencyCompare ? countSignals(withRecency) : null;
  let recencyReport = null;
  if (args.recencyCompare && withRecency.length > 0) {
    const aggregate = aggregateByCategory(withRecency);
    recencyReport = {
      weight: args.recencyWeight,
      stale_days: args.staleDays,
      reference_ms: recencyReferenceMs,
      overall: aggregate.overall,
      by_category: aggregate.by_category,
      delta: recencyDelta(agg.by_category, aggregate.by_category)
    };
  }
  const expectedQueryEvidence = scorable.map(({ inst, relevant }) => ({
    id: inst.question_id,
    query: inst.question,
    category: inst.question_type,
    relevant_paths: [...relevant],
    materialized_paths: inst.haystack_sessions.map((_session, index) => sessionNotePath(inst.question_id, index))
  }));

  // ── Disclosure header (per the C-2 honest-publishing bar) ──
  const canonicalCohort = isCanonicalLongMemEvalCohort(dataset, {
    selected_instances: selected.length,
    expected_scored_instances: scorable.length,
    evaluated_instances: base.length,
    abstentions,
    expected_notes: expectedNotes,
    materialized_notes: notesWritten
  });
  const implementation = await implementationMetadata(implementationStart, implementationOpts);
  const embeddingModelArtifacts =
    args.embeddings && embeddingsModule && embedModel && embeddingModelArtifactsStart && embeddingModelArtifactsPostLoad
      ? await modelArtifactMetadata(
          embeddingsModule,
          embedModel,
          embeddingModelArtifactsStart,
          embeddingModelArtifactsPostLoad
        )
      : null;
  const {
    status,
    partial,
    publishable,
    publication_blockers: publicationBlockers
  } = benchmarkArtifactStatus(canonicalCohort, implementation, {
    embeddings: args.embeddings,
    ftsSync: ftsSyncReport,
    materializedCorpus: materializedCorpusReport,
    expectedMaterializedPaths,
    expectedQueries: scorable.length,
    completedQueries: base.length,
    completedRecencyQueries: withRecency.length,
    embeddingSync: embeddingSyncReport,
    expectedFiles: expectedNotes,
    baseEmbeddingQueries: baseSignalCounts.embeddings,
    recencyCompare: args.recencyCompare,
    recencyWeight: args.recencyWeight,
    staleDays: args.staleDays,
    recencyReferenceMs,
    recencyEmbeddingQueries: recencySignalCounts?.embeddings,
    perQuery,
    expectedQueryEvidence,
    k,
    summary: agg,
    recencyReport,
    embeddingModelArtifacts,
    expectedEmbeddingModel: CANONICAL_EMBEDDING_MODEL
  });
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

  if (recencyReport !== null) {
    process.stdout.write(
      `\n--- freshness differentiator: --recency-weight ${args.recencyWeight} ON vs OFF (Δ nDCG@5) ---\n`
    );
    // Highlight the categories freshness is designed to help.
    // rc.12 — each metric carries its OWN sign (pre-rc.12 ΔMRR reused ΔnDCG@5's,
    // printing "+-0.0123" when the deltas differed in direction).
    const signed = (n) => `${n >= 0 ? "+" : ""}${n.toFixed(4)}`;
    for (const row of byCategoryRows(recencyReport.delta)) {
      process.stdout.write(`  ${row.type.padEnd(26)} ΔnDCG@5=${signed(row.ndcg_5)}  ΔMRR=${signed(row.mrr)}\n`);
    }
    process.stdout.write(
      "  (temporal-reasoning / knowledge-update / preference are where a static retriever is weakest)\n"
    );
  }

  if (args.output) {
    if (
      (await benchmarkOutputSafetyBlocker(args.output, {
        dataset: args.dataset,
        modelRoot: modelRootForOutput
      })) !== null
    ) {
      process.stderr.write("enquire LongMemEval: --output became unsafe before the atomic write\n");
      process.exitCode = 2;
      return;
    }
    const resourceUsage = process.resourceUsage();
    const payload = {
      meta: {
        schema_version: 2,
        generated_at: generatedAt,
        status,
        partial,
        canonical_cohort: canonicalCohort,
        publishable,
        publication_blockers: publicationBlockers,
        protocol: {
          name: "longmemeval-s-global-index-scope-per-question",
          comparator: "flowing-abyss/obsidian-hybrid-search",
          comparator_commit: OHS_COMPARATOR_COMMIT,
          k,
          index_state: "rebuilt-once-for-selected-cohort",
          query_scope: "question-folder",
          timestamp_policy: "session age relative to question date, normalized before strict indexing and search",
          recency_reference_ms: args.recencyCompare ? recencyReferenceMs : null
        },
        dataset: {
          ...dataset,
          selected_instances: selected.length,
          expected_scored_instances: scorable.length,
          scored_instances: base.length,
          abstentions_skipped: abstentions,
          expected_materialized_notes: expectedNotes,
          materialized_notes: notesWritten
        },
        retrieval: {
          embeddings: args.embeddings,
          materialized_corpus: materializedCorpusReport,
          fts_sync: ftsSyncReport,
          embedding_sync: embeddingSyncReport,
          embedding_model_artifacts: embeddingModelArtifacts,
          expected_queries: scorable.length,
          completed_queries: base.length,
          completed_recency_queries: args.recencyCompare ? withRecency.length : null,
          embedding_backend: embedModel
            ? `local-transformers.js (${embedModel.alias}, ${embedModel.dtype})`
            : "none-bm25-tfidf",
          base_signal_query_counts: baseSignalCounts,
          recency_signal_query_counts: recencySignalCounts,
          recency_compare: args.recencyCompare,
          recency_weight: args.recencyCompare ? args.recencyWeight : null,
          stale_days: args.recencyCompare ? args.staleDays : null,
          recency_reference_ms: args.recencyCompare ? recencyReferenceMs : null
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
    await writeJsonAtomic(args.output, payload, {
      dataset: args.dataset,
      modelRoot: modelRootForOutput
    });
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
