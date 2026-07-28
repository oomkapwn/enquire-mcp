// v3.12.0-rc.17 — LongMemEval retrieval-harness evidence-contract tests.
//
// Covers label-free materialization, schema/date validation, scoring helpers,
// and a compiled process-level two-question run that proves the public JSON
// artifact carries provenance + raw per-query evidence.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error — .mjs build script, no type declarations (CLI guarded by isEntrypoint).
import {
  aggregateByCategory,
  aggregateByType,
  artifactManifestSha256,
  benchmarkArtifactStatus,
  benchmarkOutputIsProtected,
  benchmarkOutputSafetyBlocker,
  byCategoryRows,
  CANONICAL_EMBEDDING_MODEL,
  corpusUniversePublicationBlockers,
  duplicateSessionIdStats,
  embeddingSyncPublicationBlockers,
  ftsSyncPublicationBlockers,
  hardenedGitText,
  implementationPublicationBlockers,
  isAbstention,
  isCanonicalLongMemEvalCohort,
  isCanonicalLongMemEvalS,
  isCanonicalSha512Sri,
  materializedCorpusPublicationBlockers,
  modelArtifactPublicationBlockers,
  modelArtifactSnapshot,
  normalizedSessionMtimeMs,
  OFFICIAL_LONGMEMEVAL_S_ABSTENTIONS,
  OFFICIAL_LONGMEMEVAL_S_BYTES,
  OFFICIAL_LONGMEMEVAL_S_INSTANCES,
  OFFICIAL_LONGMEMEVAL_S_NOTES,
  OFFICIAL_LONGMEMEVAL_S_SCORED,
  OFFICIAL_LONGMEMEVAL_S_SHA256,
  OFFICIAL_LONGMEMEVAL_S_URL,
  OHS_METRICS,
  parseLongMemEvalDate,
  queryEvidencePublicationBlockers,
  recencyDelta,
  recencyEvidencePublicationBlockers,
  relevantSessionPaths,
  runtimeDependencyManifestSha256,
  runtimeInjectionSnapshot,
  sanitizedGitEnv,
  sessionNotePath,
  sessionToMarkdown,
  validateLongMemEvalInstances,
  writeJsonAtomic
} from "../scripts/bench-longmemeval.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");
const registerTransformersFixture = path.join(
  projectRoot,
  "tests",
  "fixtures",
  "transformers-test-loader",
  "register.mjs"
);

function completeEmbeddingSync(totalFiles = 4) {
  const manifestSha256 = "1".repeat(64);
  const audit = {
    indexed_files: totalFiles,
    declared_chunks: totalFiles,
    indexed_chunks: totalFiles,
    mismatched_files: 0
  };
  return {
    mode: "strict",
    audited: true,
    added: totalFiles,
    updated: 0,
    deleted: 0,
    unchanged: 0,
    total_chunks: totalFiles,
    total_files: totalFiles,
    processed_files: totalFiles,
    empty: 0,
    failed: 0,
    ...audit,
    invalid_vectors: 0,
    manifest_sha256: manifestSha256,
    complete: true,
    post_run_audit: { ...audit },
    post_run_vector_audit: { invalid_vectors: 0 },
    post_run_manifest_sha256: manifestSha256,
    post_run_unchanged: true
  };
}

function completeFtsSync(totalFiles = 4) {
  const manifestSha256 = "2".repeat(64);
  const audit = {
    declared_files: totalFiles,
    indexed_files: totalFiles,
    declared_chunks: totalFiles,
    indexed_chunks: totalFiles,
    mismatched_files: 0
  };
  return {
    mode: "strict",
    audited: true,
    added: totalFiles,
    updated: 0,
    deleted: 0,
    unchanged: 0,
    total_chunks: totalFiles,
    total_files: totalFiles,
    processed_files: totalFiles,
    empty: 0,
    failed: 0,
    ...audit,
    manifest_sha256: manifestSha256,
    complete: true,
    post_run_audit: { ...audit },
    post_run_manifest_sha256: manifestSha256,
    post_run_unchanged: true
  };
}

function completeMaterializedCorpus(paths: string[]) {
  const files = paths.map((filePath, index) => ({
    path: filePath,
    mode: "100644",
    size_bytes: 100 + index,
    sha256: ((index + 3) % 16).toString(16).repeat(64)
  }));
  const snapshot = {
    files,
    file_count: files.length,
    manifest_sha256: artifactManifestSha256(files),
    snapshot_consistent: true
  };
  return {
    before_queries: structuredClone(snapshot),
    after_queries: structuredClone(snapshot),
    post_run_fts_diff: { added: [], updated: [], deleted: [], unchanged: [...paths] },
    unchanged_during_queries: true
  };
}

function completeQueryEvidence(totalQueries = 4, opts: { embeddings?: boolean; recencyCompare?: boolean } = {}) {
  const recencyReferenceMs = 1_700_000_000_000;
  const expectedQueryIds = Array.from({ length: totalQueries }, (_, index) => `q${index + 1}`);
  const result = (id: string) => ({
    id,
    query: `question ${id}`,
    category: "single-session-user",
    scope: `${id}/`,
    relevant_paths: [`${id}/0001.md`],
    top_paths: [`${id}/0001.md`],
    missed_paths: [],
    ndcg_5: 1,
    ndcg_10: 1,
    mrr: 1,
    hit_1: true,
    hit_5: true,
    recall_10: 1,
    all_rel_10: true,
    signals_used: ["bm25", "tfidf", ...(opts.embeddings ? ["embeddings"] : [])],
    latency_ms: 1
  });
  const perQuery = expectedQueryIds.map((id) => {
    const base = result(id);
    return opts.recencyCompare
      ? {
          ...base,
          recency: {
            top_paths: [...base.top_paths],
            missed_paths: [],
            ndcg_5: 1,
            ndcg_10: 1,
            mrr: 1,
            hit_1: true,
            hit_5: true,
            recall_10: 1,
            all_rel_10: true,
            signals_used: [...base.signals_used],
            latency_ms: 1
          }
        }
      : base;
  });
  const expectedQueryEvidence = perQuery.map((row) => ({
    id: row.id,
    query: row.query,
    category: row.category,
    relevant_paths: [...row.relevant_paths],
    materialized_paths: [...row.relevant_paths]
  }));
  const perfectMetrics = {
    n: totalQueries,
    ndcg_5: 1,
    ndcg_10: 1,
    mrr: 1,
    hit_1: 1,
    hit_5: 1,
    recall_10: 1,
    all_rel_10: 1
  };
  const expectedMaterializedPaths = expectedQueryEvidence.flatMap((row) => row.materialized_paths);
  const deltaMetrics = Object.fromEntries(OHS_METRICS.map((field) => [field, 0]));
  return {
    expectedQueries: totalQueries,
    completedQueries: totalQueries,
    completedRecencyQueries: opts.recencyCompare ? totalQueries : 0,
    recencyCompare: opts.recencyCompare ?? false,
    recencyWeight: 0.3,
    staleDays: 365,
    recencyReferenceMs,
    ftsSync: completeFtsSync(totalQueries),
    expectedFiles: totalQueries,
    expectedMaterializedPaths,
    materializedCorpus: completeMaterializedCorpus(expectedMaterializedPaths),
    perQuery,
    expectedQueryEvidence,
    k: 10,
    summary: {
      overall: { ...perfectMetrics },
      by_category: { "single-session-user": { ...perfectMetrics } }
    },
    recencyReport: opts.recencyCompare
      ? {
          weight: 0.3,
          stale_days: 365,
          reference_ms: recencyReferenceMs,
          overall: { ...perfectMetrics },
          by_category: { "single-session-user": { ...perfectMetrics } },
          delta: { "single-session-user": { n: totalQueries, ...deltaMetrics } }
        }
      : null
  };
}

function completeImplementation() {
  const runtimeInjection = runtimeInjectionSnapshot({}, []);
  const runtimeDependencies = [
    { rootAlias: "better-sqlite3", name: "better-sqlite3" },
    { rootAlias: "@huggingface/transformers", name: "@huggingface/transformers" },
    { rootAlias: "js-yaml", name: "js-yaml" },
    { rootAlias: "typescript-native", name: "typescript" }
  ].map(({ rootAlias, name }, index) => ({
    root_alias: rootAlias,
    name,
    lock_path: `node_modules/${rootAlias}`,
    version: `1.0.${index}`,
    lock_version: `1.0.${index}`,
    lock_resolved: `https://registry.npmjs.org/${rootAlias}/-/${rootAlias.split("/").at(-1)}-1.0.${index}.tgz`,
    lock_integrity: `sha512-${"A".repeat(86)}==`,
    lock_matches: true,
    metadata_matches_lock: true,
    file_count: 10 + index,
    manifest_sha256: ((index + 1) % 16).toString(16).repeat(64),
    snapshot_consistent: true,
    dependency_paths: [],
    optional_dependency_paths: [],
    missing_optional_dependencies: []
  }));
  const snapshot = {
    package_version: "3.12.0-rc.20",
    git_commit: "a".repeat(40),
    git_dirty: false,
    release_tag: "v3.12.0-rc.20",
    release_tag_commit: "a".repeat(40),
    origin_url: "git@github.com:oomkapwn/enquire-mcp.git",
    origin_main_commit: "a".repeat(40),
    head_on_origin_main: true,
    remote_tag_commit: "a".repeat(40),
    source_file_count: 100,
    source_tree_sha256: "b".repeat(64),
    tagged_source_file_count: 100,
    tagged_source_tree_sha256: "b".repeat(64),
    source_matches_tagged_commit: true,
    dist_file_count: 100,
    executed_dist_sha256: "c".repeat(64),
    rebuilt_dist_file_count: 100,
    rebuilt_dist_sha256: "c".repeat(64),
    dist_matches_source_build: true,
    dist_entrypoints_present: true,
    runtime_injection: runtimeInjection,
    runtime_injection_sha256: runtimeInjection.sha256,
    runtime_dependencies: runtimeDependencies,
    runtime_dependencies_sha256: runtimeDependencyManifestSha256(runtimeDependencies),
    runtime_dependency_closure_complete: true,
    runtime_dependency_integrity_complete: true,
    runtime_dependency_integrity_missing_paths: [],
    runtime_dependency_integrity_missing_sha256: createHash("sha256").update("[]").digest("hex"),
    snapshot_consistent: true
  };
  return {
    ...snapshot,
    run_start: { ...snapshot },
    unchanged_during_run: true
  };
}

function completeModelArtifacts() {
  const files = [
    {
      path: "config.json",
      size_bytes: 673,
      sha256: CANONICAL_EMBEDDING_MODEL.requiredFileSha256["config.json"]
    },
    {
      path: "onnx/model_quantized.onnx",
      size_bytes: 118_000_000,
      sha256: CANONICAL_EMBEDDING_MODEL.requiredFileSha256["onnx/model_quantized.onnx"]
    },
    {
      path: "tokenizer.json",
      size_bytes: 17_082_913,
      sha256: CANONICAL_EMBEDDING_MODEL.requiredFileSha256["tokenizer.json"]
    },
    {
      path: "tokenizer_config.json",
      size_bytes: 496,
      sha256: CANONICAL_EMBEDDING_MODEL.requiredFileSha256["tokenizer_config.json"]
    }
  ];
  const snapshot = {
    alias: "multilingual",
    hf_id: "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
    dtype: "q8",
    transformers_version: "4.2.0",
    files,
    file_count: files.length,
    manifest_sha256: artifactManifestSha256(files),
    snapshot_consistent: true
  };
  return {
    ...snapshot,
    run_start: { ...snapshot, files: files.map((file) => ({ ...file })) },
    post_load: { ...snapshot, files: files.map((file) => ({ ...file })) },
    unchanged_during_run: true
  };
}

function completeModelRetrievalEvidence() {
  return {
    embeddingModelArtifacts: completeModelArtifacts(),
    expectedEmbeddingModel: CANONICAL_EMBEDDING_MODEL
  };
}

function fixtureQuestion(id: string, answerToken: string, distractorToken: string) {
  return {
    question_id: id,
    question_type: "single-session-user",
    question: `Where is ${answerToken}?`,
    answer: answerToken,
    question_date: "2023/05/30 (Tue) 23:40",
    haystack_session_ids: [`answer_${id}`, `distractor_${id}`],
    haystack_dates: ["2023/05/29 (Mon) 10:00", "2023/05/28 (Sun) 10:00"],
    haystack_sessions: [
      [
        { role: "user", content: `Remember ${answerToken}.`, has_answer: true },
        { role: "assistant", content: `${answerToken} is in the archive.`, has_answer: true }
      ],
      [
        { role: "user", content: `Unrelated ${distractorToken}.` },
        { role: "assistant", content: "No matching fact here." }
      ]
    ],
    answer_session_ids: [`answer_${id}`]
  };
}

describe("sessionNotePath (v3.12.0-rc.17)", () => {
  it("uses numeric names so answer-bearing source ids never enter the vault", () => {
    expect(sessionNotePath("q_42", 0)).toBe("q_42/0001.md");
    expect(sessionNotePath("q_42", 41)).toBe("q_42/0042.md");
    expect(sessionNotePath("q_42", 0)).not.toContain("answer");
  });
  it("rejects unsafe ids/indexes (NEGATIVE control — no traversal or silent collision)", () => {
    expect(() => sessionNotePath("../../etc/passwd", 0)).toThrow(/unsafe/);
    expect(() => sessionNotePath("a b/c", 0)).toThrow(/unsafe/);
    expect(() => sessionNotePath("safe", -1)).toThrow(/index/);
  });
});

describe("sessionToMarkdown (v3.12.0-rc.17)", () => {
  it("renders role-labelled turns without the ground-truth-bearing session id", () => {
    const md = sessionToMarkdown(
      [
        { role: "user", content: "What's my dog's name?" },
        { role: "assistant", content: "Your dog is Rex." }
      ],
      "2026/01/02"
    );
    expect(md).toContain("# Conversation");
    expect(md).toContain("Date: 2026/01/02");
    expect(md).toContain("## User\n\nWhat's my dog's name?");
    expect(md).toContain("## Assistant\n\nYour dog is Rex.");
    expect(md).not.toContain("answer_");
  });
  it("skips malformed turns + handles an empty session (NEGATIVE control)", () => {
    const md = sessionToMarkdown([{ role: "user" }, null, { content: 42 }], undefined);
    expect(md).toContain("# Conversation");
    expect(md).not.toContain("undefined");
    expect(md).not.toContain("Date:");
    expect(md.endsWith("\n")).toBe(true);
  });
});

describe("relevantSessionPaths (v3.12.0-rc.17)", () => {
  it("uses explicit answer_session_ids", () => {
    const rel = relevantSessionPaths({
      question_id: "q1",
      haystack_session_ids: ["s3", "s7"],
      answer_session_ids: ["s7"]
    });
    expect([...rel]).toEqual(["q1/0002.md"]);
  });
  it("falls back to has_answer turns when answer_session_ids is absent", () => {
    const rel = relevantSessionPaths({
      question_id: "q2",
      haystack_session_ids: ["a", "b", "c"],
      haystack_sessions: [
        [{ role: "user", content: "x" }],
        [{ role: "assistant", content: "y", has_answer: true }],
        [{ role: "user", content: "z" }]
      ]
    });
    expect([...rel]).toEqual(["q2/0002.md"]);
  });
  it("returns an EMPTY set when there is no ground truth (NEGATIVE control — abstention)", () => {
    expect(relevantSessionPaths({ question_id: "q3", question: "?" }).size).toBe(0);
    expect(relevantSessionPaths({ question_id: "q4", answer_session_ids: [] }).size).toBe(0);
  });
});

describe("isAbstention + normalized dates (v3.12.0-rc.17)", () => {
  it("flags _abs question ids", () => {
    expect(isAbstention({ question_id: "q42_abs" })).toBe(true);
    expect(isAbstention({ question_id: "q42", answer_session_ids: [] })).toBe(true);
    const anchor = Date.UTC(2026, 0, 10, 12);
    expect(parseLongMemEvalDate("2023/05/30 (Tue) 23:40")).toBe(Date.UTC(2023, 4, 30, 23, 40));
    expect(normalizedSessionMtimeMs("2023/05/28 (Sun) 23:40", "2023/05/30 (Tue) 23:40", anchor)).toBe(
      anchor - 2 * 86_400_000
    );
  });
  it("is false for normal ids (NEGATIVE control)", () => {
    expect(isAbstention({ question_id: "q42", answer_session_ids: ["s1"] })).toBe(false);
    expect(isAbstention({})).toBe(false);
    expect(parseLongMemEvalDate("2023/02/30 (Thu) 10:00")).toBeNull();
    expect(() => normalizedSessionMtimeMs("bad", "2023/05/30 (Tue) 23:40", Date.now())).toThrow(/invalid/);
  });
});

describe("dense embedding publication evidence (v3.12.0-rc.20)", () => {
  const cleanCommit = completeImplementation();

  it("keeps both clean sparse and raw-equation-complete dense artifacts publication-safe", () => {
    expect(benchmarkArtifactStatus(true, cleanCommit, completeQueryEvidence())).toEqual({
      status: "complete",
      partial: false,
      publishable: true,
      publication_blockers: []
    });
    expect(
      benchmarkArtifactStatus(true, cleanCommit, {
        embeddings: true,
        ...completeQueryEvidence(4, { embeddings: true, recencyCompare: true }),
        embeddingSync: completeEmbeddingSync(),
        expectedFiles: 4,
        baseEmbeddingQueries: 4,
        recencyCompare: true,
        completedRecencyQueries: 4,
        recencyEmbeddingQueries: 4,
        ...completeModelRetrievalEvidence()
      })
    ).toEqual({
      status: "complete",
      partial: false,
      publishable: true,
      publication_blockers: []
    });
    expect(
      benchmarkArtifactStatus(false, cleanCommit, {
        embeddings: true,
        ...completeQueryEvidence(4, { embeddings: true }),
        embeddingSync: completeEmbeddingSync(),
        expectedFiles: 4,
        baseEmbeddingQueries: 4,
        recencyCompare: false,
        ...completeModelRetrievalEvidence()
      })
    ).toEqual({
      status: "diagnostic-partial",
      partial: true,
      publishable: false,
      publication_blockers: ["noncanonical-cohort"]
    });
  });

  it("rejects missing, fail-soft, failed, empty, unprocessed, and mismatched dense reports", () => {
    const cases = [
      {
        name: "missing",
        report: null,
        blocker: "embedding-sync-report-missing"
      },
      {
        name: "fail-soft",
        report: { ...completeEmbeddingSync(), mode: "fail-soft" },
        blocker: "embedding-sync-not-strict"
      },
      {
        name: "not fresh",
        report: { ...completeEmbeddingSync(), added: 3, unchanged: 1 },
        blocker: "embedding-sync-not-fresh"
      },
      {
        name: "failed with forged complete=true",
        report: { ...completeEmbeddingSync(), added: 3, failed: 1, complete: true },
        blocker: "embedding-sync-file-errors"
      },
      {
        name: "empty with forged complete=true",
        report: { ...completeEmbeddingSync(), added: 3, empty: 1, complete: true },
        blocker: "embedding-sync-empty-files"
      },
      {
        name: "unprocessed with forged complete=true",
        report: { ...completeEmbeddingSync(), processed_files: 3, complete: true },
        blocker: "embedding-sync-unprocessed-files"
      },
      {
        name: "physical mismatch with forged complete=true",
        report: {
          ...completeEmbeddingSync(),
          total_chunks: 3,
          declared_chunks: 4,
          indexed_chunks: 3,
          mismatched_files: 1,
          complete: true
        },
        blocker: "embedding-sync-chunk-count-mismatch"
      }
    ];

    for (const scenario of cases) {
      const blockers = embeddingSyncPublicationBlockers(scenario.report, 4);
      expect(blockers, scenario.name).toContain(scenario.blocker);
      expect(
        benchmarkArtifactStatus(true, cleanCommit, {
          embeddings: true,
          ...completeQueryEvidence(4, { embeddings: true }),
          embeddingSync: scenario.report,
          expectedFiles: 4,
          baseEmbeddingQueries: 4,
          recencyCompare: false
        }),
        scenario.name
      ).toMatchObject({
        status: "diagnostic-incomplete",
        partial: true,
        publishable: false
      });
    }

    const ftsCases = [
      { report: null, blocker: "fts-sync-report-missing" },
      { report: { ...completeFtsSync(), mode: "fail-soft" }, blocker: "fts-sync-not-strict" },
      {
        report: { ...completeFtsSync(), added: 3, failed: 1, complete: true },
        blocker: "fts-sync-file-errors"
      },
      {
        report: { ...completeFtsSync(), declared_files: 3, complete: true },
        blocker: "fts-sync-indexed-file-mismatch"
      },
      {
        report: { ...completeFtsSync(), post_run_unchanged: false, complete: true },
        blocker: "fts-sync-post-run-changed"
      }
    ];
    for (const scenario of ftsCases) {
      expect(ftsSyncPublicationBlockers(scenario.report, 4)).toContain(scenario.blocker);
      expect(
        benchmarkArtifactStatus(true, cleanCommit, {
          ...completeQueryEvidence(),
          ftsSync: scenario.report
        })
      ).toMatchObject({ status: "diagnostic-incomplete", publishable: false });
    }
  });

  it("does not trust complete=true when raw file accounting or source cardinality is forged", () => {
    const forged = { ...completeEmbeddingSync(), added: 2, complete: true };
    expect(embeddingSyncPublicationBlockers(forged, 5)).toEqual(
      expect.arrayContaining(["embedding-sync-source-count-mismatch", "embedding-sync-accounting-mismatch"])
    );
    expect(embeddingSyncPublicationBlockers(completeEmbeddingSync(), undefined)).toContain(
      "embedding-sync-expected-file-count-invalid"
    );
    expect(
      embeddingSyncPublicationBlockers(
        {
          ...completeEmbeddingSync(),
          total_chunks: Number.MAX_SAFE_INTEGER + 1
        },
        4
      )
    ).toContain("embedding-sync-invalid-total-chunks");
    expect(
      benchmarkArtifactStatus(true, cleanCommit, {
        embeddings: true,
        ...completeQueryEvidence(4, { embeddings: true, recencyCompare: true }),
        embeddingSync: completeEmbeddingSync(),
        expectedFiles: 4,
        baseEmbeddingQueries: 3,
        recencyCompare: true,
        completedRecencyQueries: 4,
        recencyEmbeddingQueries: 4
      }).publication_blockers
    ).toContain("embedding-base-signal-count-mismatch");
    expect(
      benchmarkArtifactStatus(true, cleanCommit, {
        embeddings: true,
        ...completeQueryEvidence(4, { embeddings: true, recencyCompare: true }),
        embeddingSync: completeEmbeddingSync(),
        expectedFiles: 4,
        baseEmbeddingQueries: 4,
        recencyCompare: true,
        completedRecencyQueries: 4,
        recencyEmbeddingQueries: 3
      }).publication_blockers
    ).toContain("embedding-recency-signal-count-mismatch");

    const mismatchedCorpusCount = completeQueryEvidence(2);
    expect(
      corpusUniversePublicationBlockers(
        3,
        mismatchedCorpusCount.expectedMaterializedPaths,
        mismatchedCorpusCount.expectedQueryEvidence
      )
    ).toContain("retrieval-corpus-universe-mismatch");
    const mismatchedCorpusPaths = structuredClone(mismatchedCorpusCount);
    mismatchedCorpusPaths.expectedMaterializedPaths = ["q1/0001.md", "q1/0002.md"];
    expect(benchmarkArtifactStatus(true, cleanCommit, mismatchedCorpusPaths).publication_blockers).toContain(
      "retrieval-corpus-universe-mismatch"
    );

    const isolatedReportCases = [
      {
        report: { ...completeEmbeddingSync(), total_chunks: 3 },
        blocker: "embedding-sync-total-chunk-mismatch"
      },
      {
        report: { ...completeEmbeddingSync(), indexed_files: 3 },
        blocker: "embedding-sync-indexed-file-mismatch"
      },
      {
        report: { ...completeEmbeddingSync(), complete: false },
        blocker: "embedding-sync-reported-incomplete"
      }
    ];
    for (const scenario of isolatedReportCases) {
      expect(embeddingSyncPublicationBlockers(scenario.report, 4)).toContain(scenario.blocker);
    }
    expect(
      embeddingSyncPublicationBlockers(
        {
          ...completeEmbeddingSync(),
          post_run_audit: { ...completeEmbeddingSync().post_run_audit, indexed_chunks: 3 },
          post_run_unchanged: true
        },
        4
      )
    ).toContain("embedding-sync-post-run-integrity-mismatch");
    expect(
      ftsSyncPublicationBlockers(
        {
          ...completeFtsSync(),
          post_run_audit: { ...completeFtsSync().post_run_audit, mismatched_files: 1 },
          post_run_unchanged: true
        },
        4
      )
    ).toContain("fts-sync-post-run-integrity-mismatch");

    const queryCases = [
      {
        retrieval: { expectedQueries: 0, completedQueries: 0 },
        blocker: "retrieval-expected-query-count-invalid"
      },
      {
        retrieval: { expectedQueries: 4, completedQueries: 3 },
        blocker: "retrieval-query-count-mismatch"
      },
      {
        retrieval: {
          expectedQueries: 4,
          completedQueries: 4,
          recencyCompare: true,
          completedRecencyQueries: 3
        },
        blocker: "retrieval-recency-query-count-mismatch"
      }
    ];
    for (const scenario of queryCases) {
      expect(benchmarkArtifactStatus(true, cleanCommit, scenario.retrieval).publication_blockers).toContain(
        scenario.blocker
      );
    }

    const rawEvidence = completeQueryEvidence(2);
    const duplicateSignals = structuredClone(rawEvidence.perQuery);
    duplicateSignals[0]?.signals_used.push("bm25");
    expect(queryEvidencePublicationBlockers(duplicateSignals, rawEvidence.expectedQueryEvidence, 10)).toContain(
      "retrieval-base-signals-invalid"
    );
    const escapedScope = structuredClone(rawEvidence.perQuery);
    if (escapedScope[0]) escapedScope[0].top_paths = ["q2/0001.md"];
    expect(queryEvidencePublicationBlockers(escapedScope, rawEvidence.expectedQueryEvidence, 10)).toContain(
      "retrieval-base-paths-invalid"
    );
    const invalidMetric = structuredClone(rawEvidence.perQuery);
    if (invalidMetric[0]) invalidMetric[0].mrr = Number.NaN;
    expect(queryEvidencePublicationBlockers(invalidMetric, rawEvidence.expectedQueryEvidence, 10)).toContain(
      "retrieval-base-metrics-invalid"
    );
    const forgedMetric = structuredClone(rawEvidence.perQuery);
    if (forgedMetric[0]) forgedMetric[0].mrr = 0.5;
    expect(queryEvidencePublicationBlockers(forgedMetric, rawEvidence.expectedQueryEvidence, 10)).toContain(
      "retrieval-base-metrics-inconsistent"
    );
    const forgedGroundTruth = structuredClone(rawEvidence.perQuery);
    if (forgedGroundTruth[0]) {
      forgedGroundTruth[0].relevant_paths = ["q1/9999.md"];
      forgedGroundTruth[0].top_paths = ["q1/9999.md"];
    }
    expect(queryEvidencePublicationBlockers(forgedGroundTruth, rawEvidence.expectedQueryEvidence, 10)).toEqual(
      expect.arrayContaining(["retrieval-base-ground-truth-mismatch", "retrieval-base-path-not-materialized"])
    );

    const changedCorpus = structuredClone(rawEvidence.materializedCorpus);
    changedCorpus.after_queries.files[0].sha256 = "f".repeat(64);
    changedCorpus.after_queries.manifest_sha256 = artifactManifestSha256(changedCorpus.after_queries.files);
    expect(materializedCorpusPublicationBlockers(changedCorpus, rawEvidence.expectedMaterializedPaths)).toContain(
      "materialized-corpus-changed-during-queries"
    );
    expect(
      benchmarkArtifactStatus(true, cleanCommit, {
        ...rawEvidence,
        materializedCorpus: changedCorpus
      }).publication_blockers
    ).toContain("materialized-corpus-changed-during-queries");
    const staleFtsCorpus = structuredClone(rawEvidence.materializedCorpus);
    const stalePath = staleFtsCorpus.post_run_fts_diff.unchanged.shift();
    staleFtsCorpus.post_run_fts_diff.updated.push(stalePath);
    expect(materializedCorpusPublicationBlockers(staleFtsCorpus, rawEvidence.expectedMaterializedPaths)).toContain(
      "materialized-corpus-index-state-stale"
    );

    const recencyEvidence = completeQueryEvidence(2, { recencyCompare: true });
    const forgedRecencySummary = structuredClone(recencyEvidence.recencyReport);
    if (forgedRecencySummary) forgedRecencySummary.overall.mrr = 0.5;
    expect(recencyEvidencePublicationBlockers(forgedRecencySummary, recencyEvidence.perQuery)).toContain(
      "retrieval-recency-summary-inconsistent"
    );
    const forgedRecencyDelta = structuredClone(recencyEvidence.recencyReport);
    if (forgedRecencyDelta) forgedRecencyDelta.delta["single-session-user"].mrr = 0.25;
    expect(recencyEvidencePublicationBlockers(forgedRecencyDelta, recencyEvidence.perQuery)).toContain(
      "retrieval-recency-delta-inconsistent"
    );
    expect(
      benchmarkArtifactStatus(true, cleanCommit, {
        ...recencyEvidence,
        recencyWeight: 0.7
      }).publication_blockers
    ).toContain("retrieval-recency-configuration-mismatch");
    expect(
      benchmarkArtifactStatus(true, cleanCommit, {
        ...recencyEvidence,
        recencyReferenceMs: recencyEvidence.recencyReferenceMs + 1
      }).publication_blockers
    ).toContain("retrieval-recency-configuration-mismatch");
  });

  it("pins release/source/dist and local-model bytes for a publishable canonical artifact", async () => {
    const expectedModel = completeModelRetrievalEvidence().expectedEmbeddingModel;
    expect(implementationPublicationBlockers(cleanCommit)).toEqual([]);
    expect(modelArtifactPublicationBlockers(completeModelArtifacts(), expectedModel)).toEqual([]);

    expect(implementationPublicationBlockers({ ...cleanCommit, release_tag_commit: "f".repeat(40) })).toContain(
      "implementation-release-tag-mismatch"
    );
    expect(implementationPublicationBlockers({ ...cleanCommit, remote_tag_commit: "f".repeat(40) })).toContain(
      "implementation-release-tag-mismatch"
    );
    expect(implementationPublicationBlockers({ ...cleanCommit, head_on_origin_main: false })).toContain(
      "implementation-not-on-origin-main"
    );
    expect(implementationPublicationBlockers({ ...cleanCommit, dist_matches_source_build: false })).toContain(
      "implementation-dist-not-bound-to-source"
    );
    expect(
      implementationPublicationBlockers({
        ...cleanCommit,
        tagged_source_tree_sha256: "0".repeat(64),
        source_matches_tagged_commit: true
      })
    ).toContain("implementation-source-not-bound-to-tag");
    const injectedRuntime = runtimeInjectionSnapshot({ NODE_OPTIONS: "--import=/tmp/remap.mjs" }, []);
    expect(
      implementationPublicationBlockers({
        ...cleanCommit,
        runtime_injection: injectedRuntime,
        runtime_injection_sha256: injectedRuntime.sha256
      })
    ).toContain("implementation-runtime-injection");
    expect(runtimeInjectionSnapshot({ NODE_OPTIONS: "--max-old-space-size=8192" }, []).clean).toBe(true);
    expect(runtimeInjectionSnapshot({}, ["--max-old-space-size=8192"]).clean).toBe(true);
    expect(runtimeInjectionSnapshot({ NODE_OPTIONS: "-C development" }, []).clean).toBe(false);
    expect(runtimeInjectionSnapshot({ NODE_OPTIONS: "--enable-source-maps" }, []).clean).toBe(false);
    expect(runtimeInjectionSnapshot({ NODE_PRESERVE_SYMLINKS: "1" }, []).clean).toBe(false);
    expect(runtimeInjectionSnapshot({ OPENSSL_CONF: "/tmp/hostile-openssl.cnf" }, []).clean).toBe(false);
    expect(runtimeInjectionSnapshot({ LD_AUDIT: "/tmp/hostile-audit.so" }, []).clean).toBe(false);
    expect(runtimeInjectionSnapshot({ DYLD_FRAMEWORK_PATH: "/tmp/hostile-frameworks" }, []).clean).toBe(false);
    expect(runtimeInjectionSnapshot({ DYLD_FALLBACK_LIBRARY_PATH: "/tmp/hostile-libs" }, []).clean).toBe(false);
    expect(runtimeInjectionSnapshot({}, ["-C", "development"]).clean).toBe(false);
    expect(runtimeInjectionSnapshot({}, ["--enable-source-maps"]).clean).toBe(false);
    expect(runtimeInjectionSnapshot({}, ["--preserve-symlinks-main"]).clean).toBe(false);
    const hardenedGitEnv = sanitizedGitEnv({
      PATH: "/tmp/fake-bin",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.sshCommand",
      GIT_CONFIG_VALUE_0: "/tmp/fake-ssh",
      GIT_EXEC_PATH: "/tmp/fake-git-core",
      GIT_SSH_COMMAND: "/tmp/fake-ssh",
      HTTPS_PROXY: "http://127.0.0.1:9",
      SSL_CERT_FILE: "/tmp/fake-ca.pem"
    });
    expect(hardenedGitEnv).toMatchObject({
      PATH: "/tmp/fake-bin",
      GIT_ALLOW_PROTOCOL: "https",
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: os.devNull,
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_PROTOCOL_FROM_USER: "0",
      GIT_TERMINAL_PROMPT: "0"
    });
    for (const name of [
      "GIT_CONFIG_COUNT",
      "GIT_CONFIG_KEY_0",
      "GIT_CONFIG_VALUE_0",
      "GIT_EXEC_PATH",
      "GIT_SSH_COMMAND",
      "HTTPS_PROXY",
      "SSL_CERT_FILE"
    ]) {
      expect(hardenedGitEnv).not.toHaveProperty(name);
    }
    const replaceRepo = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-git-replace-"));
    try {
      const gitEnv = {
        ...process.env,
        GIT_CONFIG_GLOBAL: os.devNull,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "enquire-test",
        GIT_AUTHOR_EMAIL: "test@example.invalid",
        GIT_COMMITTER_NAME: "enquire-test",
        GIT_COMMITTER_EMAIL: "test@example.invalid"
      };
      const runGit = (args: string[]) => {
        const result = spawnSync("git", args, { cwd: replaceRepo, encoding: "utf8", env: gitEnv });
        expect(result.status, result.stderr).toBe(0);
        return result.stdout.trim();
      };
      runGit(["init", "-q"]);
      await fs.writeFile(path.join(replaceRepo, "proof.txt"), "SAFE\n");
      runGit(["add", "proof.txt"]);
      runGit(["commit", "-q", "-m", "safe"]);
      const safeCommit = runGit(["rev-parse", "HEAD"]);
      await fs.writeFile(path.join(replaceRepo, "proof.txt"), "EVIL\n");
      runGit(["add", "proof.txt"]);
      runGit(["commit", "-q", "-m", "evil"]);
      const evilCommit = runGit(["rev-parse", "HEAD"]);
      runGit(["checkout", "-q", safeCommit]);
      runGit(["replace", safeCommit, evilCommit]);
      expect(runGit(["show", "HEAD:proof.txt"])).toBe("EVIL");
      expect(hardenedGitText(["show", "HEAD:proof.txt"], { cwd: replaceRepo })).toBe("SAFE");
    } finally {
      await fs.rm(replaceRepo, { recursive: true, force: true });
    }
    expect(benchmarkOutputIsProtected(path.join(projectRoot, "dist", "index.js"))).toBe(true);
    expect(benchmarkOutputIsProtected(path.join(projectRoot, "README.md"))).toBe(true);
    expect(benchmarkOutputIsProtected(path.join(projectRoot, "eval", "results", "result.json"))).toBe(false);
    expect(benchmarkOutputIsProtected(path.join(os.tmpdir(), "enquire-result.json"))).toBe(false);
    expect(await benchmarkOutputSafetyBlocker(path.join(projectRoot, ".git", "config"))).toBe(
      "protected-repository-state"
    );
    expect(await benchmarkOutputSafetyBlocker(path.join(projectRoot, "README.md"))).toBe("protected-repository-state");
    const outputGuardRoot = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-output-guard-"));
    try {
      const redirect = path.join(outputGuardRoot, "redirect");
      await fs.symlink(path.join(projectRoot, "dist"), redirect);
      expect(await benchmarkOutputSafetyBlocker(path.join(redirect, "index.js"))).toBe("protected-repository-state");
      const privateOutputRoot = path.join(outputGuardRoot, "private");
      await fs.mkdir(privateOutputRoot, { mode: 0o700 });
      const output = path.join(privateOutputRoot, "result.json");
      const legacyTemp = `${output}.${process.pid}.tmp`;
      await fs.writeFile(legacyTemp, "caller-owned");
      await writeJsonAtomic(output, { ok: true });
      expect(JSON.parse(await fs.readFile(output, "utf8"))).toEqual({ ok: true });
      expect(await fs.readFile(legacyTemp, "utf8")).toBe("caller-owned");

      const protectedDataset = path.join(privateOutputRoot, "dataset.json");
      await fs.writeFile(protectedDataset, "dataset-original");
      await expect(
        writeJsonAtomic(protectedDataset, { replaced: true }, { dataset: protectedDataset })
      ).rejects.toThrow(/benchmark-dataset/);
      expect(await fs.readFile(protectedDataset, "utf8")).toBe("dataset-original");

      const writableOutputRoot = path.join(outputGuardRoot, "world-writable");
      await fs.mkdir(writableOutputRoot, { mode: 0o700 });
      await fs.chmod(writableOutputRoot, 0o777);
      await expect(writeJsonAtomic(path.join(writableOutputRoot, "result.json"), { unsafe: true })).rejects.toThrow(
        /group\/world-writable/
      );
    } finally {
      await fs.rm(outputGuardRoot, { recursive: true, force: true });
    }
    expect(
      implementationPublicationBlockers({
        ...cleanCommit,
        executed_dist_sha256: "0".repeat(64),
        unchanged_during_run: true
      })
    ).toContain("implementation-changed-during-run");
    expect(
      implementationPublicationBlockers({
        ...cleanCommit,
        runtime_dependency_closure_complete: false
      })
    ).toContain("implementation-runtime-dependencies-untrusted");
    expect(
      implementationPublicationBlockers({
        ...cleanCommit,
        runtime_dependency_integrity_complete: false,
        runtime_dependency_integrity_missing_paths: ["node_modules/better-sqlite3"],
        runtime_dependency_integrity_missing_sha256: createHash("sha256")
          .update(JSON.stringify(["node_modules/better-sqlite3"]))
          .digest("hex")
      })
    ).toContain("implementation-runtime-dependency-integrity-unavailable");
    const canonicalSri = `sha512-${Buffer.alloc(64, 0xa5).toString("base64")}`;
    expect(isCanonicalSha512Sri(canonicalSri)).toBe(true);
    expect(isCanonicalSha512Sri("sha512-A")).toBe(false);
    const forgedSriDependencies = structuredClone(cleanCommit.runtime_dependencies);
    if (forgedSriDependencies[0]) forgedSriDependencies[0].lock_integrity = "sha512-A";
    expect(
      implementationPublicationBlockers({
        ...cleanCommit,
        runtime_dependencies: forgedSriDependencies,
        runtime_dependencies_sha256: runtimeDependencyManifestSha256(forgedSriDependencies)
      })
    ).toContain("implementation-runtime-dependencies-untrusted");

    expect(
      modelArtifactPublicationBlockers(
        {
          ...completeModelArtifacts(),
          manifest_sha256: "0".repeat(64),
          unchanged_during_run: true
        },
        expectedModel
      )
    ).toEqual(
      expect.arrayContaining([
        "embedding-model-artifact-manifest-invalid",
        "embedding-model-artifact-changed-during-run"
      ])
    );
    const noOnnxFiles = [{ path: "tokenizer.json", size_bytes: 42, sha256: "f".repeat(64) }];
    const noOnnxSnapshot = {
      ...completeModelArtifacts(),
      files: noOnnxFiles,
      file_count: noOnnxFiles.length,
      manifest_sha256: artifactManifestSha256(noOnnxFiles)
    };
    expect(
      modelArtifactPublicationBlockers(
        {
          ...noOnnxSnapshot,
          run_start: { ...noOnnxSnapshot, files: noOnnxFiles.map((file) => ({ ...file })) }
        },
        expectedModel
      )
    ).toContain("embedding-model-artifact-file-set-mismatch");
    const symlinkModelRoot = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-model-symlink-"));
    try {
      const cacheRoot = path.join(symlinkModelRoot, ".cache");
      const realNamespace = path.join(symlinkModelRoot, "real", "Xenova");
      await fs.mkdir(path.join(realNamespace, "fixture"), { recursive: true });
      await fs.mkdir(cacheRoot);
      await fs.writeFile(path.join(symlinkModelRoot, "package.json"), '{"version":"0.0.0-test"}\n');
      await fs.writeFile(path.join(realNamespace, "fixture", "model.bin"), "pinned-bytes");
      await fs.symlink(realNamespace, path.join(cacheRoot, "Xenova"));
      const symlinkSnapshot = await modelArtifactSnapshot(
        { resolveTransformersCacheDir: () => cacheRoot },
        { alias: "fixture", hfId: "Xenova/fixture", dtype: "q8" },
        symlinkModelRoot
      );
      expect(symlinkSnapshot).toMatchObject({
        file_count: 0,
        manifest_sha256: null,
        snapshot_consistent: false
      });
    } finally {
      await fs.rm(symlinkModelRoot, { recursive: true, force: true });
    }
    const wrongHashFiles = completeModelArtifacts().files.map((file) =>
      file.path === "tokenizer.json" ? { ...file, sha256: "0".repeat(64) } : file
    );
    const wrongHashSnapshot = {
      ...completeModelArtifacts(),
      files: wrongHashFiles,
      file_count: wrongHashFiles.length,
      manifest_sha256: artifactManifestSha256(wrongHashFiles)
    };
    expect(
      modelArtifactPublicationBlockers(
        {
          ...wrongHashSnapshot,
          run_start: { ...wrongHashSnapshot },
          post_load: { ...wrongHashSnapshot }
        },
        expectedModel
      )
    ).toContain("embedding-model-artifact-required-file-hash-mismatch");
    const wrongQ8Files = [
      { path: "onnx/model_q8.onnx", size_bytes: 1, sha256: "e".repeat(64) },
      { path: "tokenizer.json", size_bytes: 42, sha256: "f".repeat(64) }
    ];
    const wrongQ8Snapshot = {
      ...completeModelArtifacts(),
      files: wrongQ8Files,
      file_count: wrongQ8Files.length,
      manifest_sha256: artifactManifestSha256(wrongQ8Files)
    };
    expect(
      modelArtifactPublicationBlockers(
        {
          ...wrongQ8Snapshot,
          run_start: { ...wrongQ8Snapshot },
          post_load: { ...wrongQ8Snapshot }
        },
        expectedModel
      )
    ).toContain("embedding-model-artifact-file-set-mismatch");
    const zeroQ8Files = completeModelArtifacts().files.map((file) =>
      file.path === "onnx/model_quantized.onnx" ? { ...file, size_bytes: 0 } : file
    );
    const zeroQ8Snapshot = {
      ...completeModelArtifacts(),
      files: zeroQ8Files,
      file_count: zeroQ8Files.length,
      manifest_sha256: artifactManifestSha256(zeroQ8Files)
    };
    expect(
      modelArtifactPublicationBlockers(
        {
          ...zeroQ8Snapshot,
          run_start: { ...zeroQ8Snapshot },
          post_load: { ...zeroQ8Snapshot }
        },
        expectedModel
      )
    ).toContain("embedding-model-artifact-file-set-mismatch");

    expect(
      benchmarkArtifactStatus(true, cleanCommit, {
        embeddings: true,
        ...completeQueryEvidence(4, { embeddings: true }),
        embeddingSync: completeEmbeddingSync(),
        expectedFiles: 4,
        baseEmbeddingQueries: 4,
        recencyCompare: false,
        ...completeModelRetrievalEvidence()
      })
    ).toMatchObject({ status: "complete", publishable: true });
    expect(
      benchmarkArtifactStatus(true, cleanCommit, {
        embeddings: true,
        ...completeQueryEvidence(4, { embeddings: true }),
        embeddingSync: completeEmbeddingSync(),
        expectedFiles: 4,
        baseEmbeddingQueries: 4,
        recencyCompare: false
      })
    ).toMatchObject({
      status: "diagnostic-untrusted",
      publishable: false,
      publication_blockers: ["embedding-model-artifact-report-missing"]
    });
  });
});

describe("aggregateByType (v3.9.0-rc.19)", () => {
  it("averages recall/mrr/ndcg + computes hit-rate per type", () => {
    const rows = aggregateByType([
      { type: "multi-session", recall: 1, mrr: 1, ndcg: 1, hit: true },
      { type: "multi-session", recall: 0, mrr: 0, ndcg: 0, hit: false },
      { type: "temporal-reasoning", recall: 0.5, mrr: 0.5, ndcg: 0.5, hit: true }
    ]);
    const multi = rows.find((r) => r.type === "multi-session");
    expect(multi.count).toBe(2);
    expect(multi.recall).toBe(0.5);
    expect(multi.hit_rate).toBe(0.5);
    const temporal = rows.find((r) => r.type === "temporal-reasoning");
    expect(temporal.count).toBe(1);
    expect(temporal.hit_rate).toBe(1);
  });
  it("validates schema and emits a provenance-complete compiled artifact (POSITIVE + NEGATIVE controls)", async () => {
    expect(aggregateByType([])).toEqual([]);
    const cohort = [
      fixtureQuestion("qalpha", "alpha-needle", "orange"),
      fixtureQuestion("qbeta", "beta-needle", "purple")
    ];
    expect(validateLongMemEvalInstances(cohort)).toBe(cohort);
    const duplicateDistractor = structuredClone(cohort);
    duplicateDistractor[0].haystack_session_ids[1] = duplicateDistractor[1].haystack_session_ids[1];
    duplicateDistractor[0].haystack_session_ids.push(duplicateDistractor[1].haystack_session_ids[1]);
    duplicateDistractor[0].haystack_dates.push("2023/05/27 (Sat) 10:00");
    duplicateDistractor[0].haystack_sessions.push([{ role: "user", content: "Repeated distractor id." }]);
    expect(validateLongMemEvalInstances(duplicateDistractor)).toBe(duplicateDistractor);
    expect(duplicateSessionIdStats(duplicateDistractor)).toMatchObject({
      questions_with_duplicate_session_ids: 1,
      extra_session_id_occurrences: 1,
      answer_id_ambiguities: 0
    });
    expect(
      isCanonicalLongMemEvalS(
        {
          sha256: OFFICIAL_LONGMEMEVAL_S_SHA256,
          size_bytes: OFFICIAL_LONGMEMEVAL_S_BYTES,
          total_instances: OFFICIAL_LONGMEMEVAL_S_INSTANCES
        },
        OFFICIAL_LONGMEMEVAL_S_INSTANCES
      )
    ).toBe(true);
    const canonicalDataset = {
      sha256: OFFICIAL_LONGMEMEVAL_S_SHA256,
      size_bytes: OFFICIAL_LONGMEMEVAL_S_BYTES,
      total_instances: OFFICIAL_LONGMEMEVAL_S_INSTANCES
    };
    const canonicalShape = {
      selected_instances: OFFICIAL_LONGMEMEVAL_S_INSTANCES,
      expected_scored_instances: OFFICIAL_LONGMEMEVAL_S_SCORED,
      evaluated_instances: OFFICIAL_LONGMEMEVAL_S_SCORED,
      abstentions: OFFICIAL_LONGMEMEVAL_S_ABSTENTIONS,
      expected_notes: OFFICIAL_LONGMEMEVAL_S_NOTES,
      materialized_notes: OFFICIAL_LONGMEMEVAL_S_NOTES
    };
    expect(isCanonicalLongMemEvalCohort(canonicalDataset, canonicalShape)).toBe(true);
    for (const field of [
      "selected_instances",
      "expected_scored_instances",
      "evaluated_instances",
      "abstentions",
      "expected_notes",
      "materialized_notes"
    ] as const) {
      expect(
        isCanonicalLongMemEvalCohort(canonicalDataset, {
          ...canonicalShape,
          [field]: canonicalShape[field] - 1
        }),
        field
      ).toBe(false);
    }
    expect(
      isCanonicalLongMemEvalS(
        {
          sha256: `${OFFICIAL_LONGMEMEVAL_S_SHA256.slice(0, -1)}0`,
          size_bytes: OFFICIAL_LONGMEMEVAL_S_BYTES,
          total_instances: OFFICIAL_LONGMEMEVAL_S_INSTANCES
        },
        OFFICIAL_LONGMEMEVAL_S_INSTANCES
      )
    ).toBe(false);
    const cleanCommit = completeImplementation();
    expect(benchmarkArtifactStatus(true, cleanCommit, completeQueryEvidence(2))).toEqual({
      status: "complete",
      partial: false,
      publishable: true,
      publication_blockers: []
    });
    expect(benchmarkArtifactStatus(true, { ...cleanCommit, git_dirty: true }, completeQueryEvidence(2))).toEqual({
      status: "diagnostic-untrusted",
      partial: false,
      publishable: false,
      publication_blockers: ["implementation-state-dirty", "implementation-changed-during-run"]
    });
    expect(benchmarkArtifactStatus(false, cleanCommit, completeQueryEvidence(2))).toEqual({
      status: "diagnostic-partial",
      partial: true,
      publishable: false,
      publication_blockers: ["noncanonical-cohort"]
    });
    expect(() =>
      validateLongMemEvalInstances([
        {
          ...cohort[0],
          haystack_dates: []
        }
      ])
    ).toThrow(/misaligned/);

    expect(existsSync(path.join(projectRoot, "dist", "index.js")), "compiled run requires `npm run build`").toBe(true);
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-longmemeval-contract-"));
    try {
      const dataset = path.join(tempRoot, "longmemeval_s_cleaned.json");
      const output = path.join(tempRoot, "result.json");
      await fs.writeFile(dataset, `${JSON.stringify(cohort)}\n`);
      const result = spawnSync(
        process.execPath,
        [
          path.join(projectRoot, "scripts", "bench-longmemeval.mjs"),
          "--dataset",
          dataset,
          "--dataset-source",
          OFFICIAL_LONGMEMEVAL_S_URL,
          "--k",
          "10",
          "--output",
          output
        ],
        { cwd: projectRoot, encoding: "utf8", timeout: 60_000 }
      );
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      const artifact = JSON.parse(await fs.readFile(output, "utf8"));
      expect(artifact.meta.schema_version).toBe(2);
      expect(artifact.meta.partial).toBe(true);
      expect(artifact.meta.status).toBe("diagnostic-partial");
      expect(artifact.meta.canonical_cohort).toBe(false);
      expect(artifact.meta.publishable).toBe(false);
      expect(artifact.meta.publication_blockers).toContain("noncanonical-cohort");
      expect(artifact.meta.publication_blockers).not.toContain("implementation-runtime-dependencies-untrusted");
      expect(artifact.meta.publication_blockers).not.toContain("implementation-dist-not-bound-to-source");
      expect(artifact.meta.protocol.name).toBe("longmemeval-s-global-index-scope-per-question");
      expect(artifact.meta.dataset).toMatchObject({
        variant: "longmemeval-compatible",
        total_instances: 2,
        selected_instances: 2,
        scored_instances: 2,
        expected_materialized_notes: 4,
        materialized_notes: 4,
        declared_source_url: OFFICIAL_LONGMEMEVAL_S_URL
      });
      expect(artifact.meta.dataset.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(artifact.meta.implementation.git_commit).toMatch(/^[a-f0-9]{40}$/);
      expect(artifact.meta.implementation.source_tree_sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(artifact.meta.implementation.executed_dist_sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(artifact.meta.implementation.dist_matches_source_build).toBe(true);
      expect(artifact.meta.implementation.runtime_dependencies.length).toBeGreaterThanOrEqual(4);
      expect(artifact.meta.implementation.runtime_dependency_closure_complete).toBe(true);
      expect(artifact.meta.implementation.run_start).toBeTypeOf("object");
      expect(artifact.meta.environment).not.toHaveProperty("hostname");
      expect(artifact.meta.timing.total_ms).toBeGreaterThan(0);
      expect(artifact.meta.timing.index_footprint_bytes.fts_bytes).toBeGreaterThan(0);
      expect(artifact.meta.timing.index_footprint_bytes.embeddings_bytes).toBe(0);
      expect(artifact.meta.retrieval.embedding_sync).toBeNull();
      expect(artifact.meta.retrieval.fts_sync).toMatchObject({
        mode: "strict",
        audited: true,
        added: 4,
        total_files: 4,
        processed_files: 4,
        failed: 0,
        declared_files: 4,
        indexed_files: 4,
        mismatched_files: 0,
        manifest_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        post_run_unchanged: true
      });
      expect(artifact.meta.retrieval.materialized_corpus).toMatchObject({
        before_queries: {
          file_count: 4,
          manifest_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          snapshot_consistent: true
        },
        after_queries: {
          file_count: 4,
          manifest_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          snapshot_consistent: true
        },
        post_run_fts_diff: {
          added: [],
          updated: [],
          deleted: [],
          unchanged: expect.arrayContaining(["qalpha/0001.md", "qalpha/0002.md", "qbeta/0001.md", "qbeta/0002.md"])
        },
        unchanged_during_queries: true
      });
      expect(artifact.meta.retrieval.materialized_corpus.before_queries.manifest_sha256).toBe(
        artifact.meta.retrieval.materialized_corpus.after_queries.manifest_sha256
      );
      expect(artifact.meta.retrieval).toMatchObject({
        expected_queries: 2,
        completed_queries: 2,
        completed_recency_queries: null
      });
      expect(artifact.per_query).toHaveLength(2);
      expect(artifact.per_query[0].relevant_paths).toEqual(["qalpha/0001.md"]);
      expect(artifact.per_query[0].top_paths[0]).toBe("qalpha/0001.md");
      expect(JSON.stringify(artifact)).not.toContain("answer_qalpha");

      const invalid = spawnSync(
        process.execPath,
        [
          path.join(projectRoot, "scripts", "bench-longmemeval.mjs"),
          "--dataset",
          dataset,
          "--k",
          "5",
          "--output",
          output
        ],
        { cwd: projectRoot, encoding: "utf8", timeout: 10_000 }
      );
      expect(invalid.status).toBe(2);
      expect(invalid.stderr).toContain("requires --k 10");

      const overwrite = spawnSync(
        process.execPath,
        [
          path.join(projectRoot, "scripts", "bench-longmemeval.mjs"),
          "--dataset",
          dataset,
          "--k",
          "10",
          "--output",
          dataset
        ],
        { cwd: projectRoot, encoding: "utf8", timeout: 10_000 }
      );
      expect(overwrite.status).toBe(2);
      expect(overwrite.stderr).toContain("must not overwrite benchmark inputs");
      expect(JSON.parse(await fs.readFile(dataset, "utf8"))).toHaveLength(2);

      const denseOutput = path.join(tempRoot, "dense-result.json");
      const networkMarker = path.join(tempRoot, "dense.network");
      const nodeOptions = [process.env.NODE_OPTIONS, `--import=${pathToFileURL(registerTransformersFixture).href}`]
        .filter(Boolean)
        .join(" ");
      const dense = spawnSync(
        process.execPath,
        [
          path.join(projectRoot, "scripts", "bench-longmemeval.mjs"),
          "--dataset",
          dataset,
          "--k",
          "10",
          "--embeddings",
          "--recency-compare",
          "--output",
          denseOutput
        ],
        {
          cwd: projectRoot,
          encoding: "utf8",
          timeout: 60_000,
          env: {
            ...process.env,
            NODE_OPTIONS: nodeOptions,
            ENQUIRE_TEST_MODEL_STATE: "present",
            ENQUIRE_TEST_NETWORK_MARKER: networkMarker
          }
        }
      );
      expect(dense.error, dense.stderr).toBeUndefined();
      expect(dense.status, dense.stderr).toBe(0);
      expect(existsSync(networkMarker), dense.stderr).toBe(false);
      const denseArtifact = JSON.parse(await fs.readFile(denseOutput, "utf8"));
      expect(denseArtifact.meta.schema_version).toBe(2);
      expect(denseArtifact.meta.status).toBe("diagnostic-partial");
      expect(denseArtifact.meta.retrieval.embeddings).toBe(true);
      expect(denseArtifact.meta.retrieval).toMatchObject({
        expected_queries: 2,
        completed_queries: 2,
        completed_recency_queries: 2,
        recency_reference_ms: expect.any(Number)
      });
      expect(denseArtifact.meta.protocol.recency_reference_ms).toBe(denseArtifact.meta.retrieval.recency_reference_ms);
      expect(denseArtifact.recency).toMatchObject({
        weight: 0.3,
        stale_days: 365,
        reference_ms: denseArtifact.meta.retrieval.recency_reference_ms,
        overall: expect.objectContaining({ n: 2 }),
        by_category: expect.any(Object),
        delta: expect.any(Object)
      });
      expect(denseArtifact.meta.retrieval.embedding_model_artifacts).toMatchObject({
        alias: "multilingual",
        hf_id: "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
        dtype: "q8",
        file_count: expect.any(Number),
        unchanged_during_run: true
      });
      expect(denseArtifact.meta.retrieval.embedding_sync).toMatchObject({
        mode: "strict",
        audited: true,
        added: 4,
        updated: 0,
        unchanged: 0,
        total_files: 4,
        processed_files: 4,
        empty: 0,
        failed: 0,
        indexed_files: 4,
        mismatched_files: 0,
        invalid_vectors: 0,
        manifest_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        complete: true,
        post_run_unchanged: true
      });
      expect(denseArtifact.meta.retrieval.embedding_sync.declared_chunks).toBeGreaterThan(0);
      expect(denseArtifact.meta.retrieval.embedding_sync.indexed_chunks).toBe(
        denseArtifact.meta.retrieval.embedding_sync.declared_chunks
      );
      expect(denseArtifact.meta.retrieval.embedding_sync.total_chunks).toBe(
        denseArtifact.meta.retrieval.embedding_sync.indexed_chunks
      );
      expect(denseArtifact.meta.timing.index_footprint_bytes.embeddings_bytes).toBeGreaterThan(0);
      expect(
        denseArtifact.per_query.every((row: { signals_used: string[] }) => row.signals_used.includes("embeddings"))
      ).toBe(true);

      const failedDenseOutput = path.join(tempRoot, "failed-dense-result.json");
      const failedDense = spawnSync(
        process.execPath,
        [
          path.join(projectRoot, "scripts", "bench-longmemeval.mjs"),
          "--dataset",
          dataset,
          "--k",
          "10",
          "--embeddings",
          "--output",
          failedDenseOutput
        ],
        {
          cwd: projectRoot,
          encoding: "utf8",
          timeout: 60_000,
          env: {
            ...process.env,
            NODE_OPTIONS: nodeOptions,
            ENQUIRE_TEST_MODEL_STATE: "present",
            ENQUIRE_TEST_EMBED_FAIL_MATCH: "beta-needle"
          }
        }
      );
      expect(failedDense.error, failedDense.stderr).toBeUndefined();
      expect(failedDense.status, failedDense.stderr).not.toBe(0);
      expect(failedDense.stderr).toContain("strict Markdown embed sync rejected");
      expect(failedDense.stderr).toContain("fixture embedding failure for match: beta-needle");
      expect(existsSync(failedDenseOutput)).toBe(false);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  }, 90_000);
});

// ─── v3.11.6-rc.10 (C-2) — OHS peer-protocol aggregation ────────────────────
describe("aggregateByCategory + byCategoryRows (v3.11.6-rc.10)", () => {
  const scored = [
    {
      type: "temporal-reasoning",
      ndcg_5: 0.5,
      ndcg_10: 0.6,
      mrr: 0.5,
      hit_1: 0,
      hit_5: 1,
      recall_10: 1,
      all_rel_10: 1
    },
    { type: "temporal-reasoning", ndcg_5: 0.9, ndcg_10: 0.9, mrr: 1, hit_1: 1, hit_5: 1, recall_10: 1, all_rel_10: 1 },
    { type: "single-session-user", ndcg_5: 1.0, ndcg_10: 1.0, mrr: 1, hit_1: 1, hit_5: 1, recall_10: 1, all_rel_10: 1 }
  ];
  it("means the OHS metric set overall + per category", () => {
    const agg = aggregateByCategory(scored);
    expect(agg.overall.n).toBe(3);
    expect(agg.overall.ndcg_5).toBeCloseTo(0.8, 4); // (0.5+0.9+1.0)/3
    expect(agg.by_category["temporal-reasoning"]?.n).toBe(2);
    expect(agg.by_category["temporal-reasoning"]?.ndcg_5).toBeCloseTo(0.7, 4);
    expect(agg.by_category["temporal-reasoning"]?.hit_1).toBeCloseTo(0.5, 4); // one of two hit rank-1
    // every OHS metric key is present on each group
    for (const m of OHS_METRICS) expect(agg.by_category["single-session-user"]).toHaveProperty(m);
  });
  it("byCategoryRows sorts weakest nDCG@5 first (the diagnostic order)", () => {
    const rows = byCategoryRows(aggregateByCategory(scored).by_category);
    expect(rows.map((r) => r.type)).toEqual(["temporal-reasoning", "single-session-user"]);
  });
  it("NEGATIVE control — empty input yields zeroed overall + no categories", () => {
    const agg = aggregateByCategory([]);
    expect(agg.overall.n).toBe(0);
    expect(agg.overall.ndcg_5).toBe(0);
    expect(Object.keys(agg.by_category)).toEqual([]);
  });
});

describe("recencyDelta (v3.11.6-rc.10 — freshness differentiator)", () => {
  it("computes after-minus-before per OHS metric, per shared category", () => {
    const before = {
      "temporal-reasoning": {
        n: 2,
        ndcg_5: 0.5,
        ndcg_10: 0.5,
        mrr: 0.5,
        hit_1: 0,
        hit_5: 1,
        recall_10: 1,
        all_rel_10: 1
      }
    };
    const after = {
      "temporal-reasoning": {
        n: 2,
        ndcg_5: 0.7,
        ndcg_10: 0.7,
        mrr: 0.6,
        hit_1: 0,
        hit_5: 1,
        recall_10: 1,
        all_rel_10: 1
      }
    };
    const d = recencyDelta(before, after);
    expect(d["temporal-reasoning"]?.ndcg_5).toBeCloseTo(0.2, 4); // recency helped
    expect(d["temporal-reasoning"]?.mrr).toBeCloseTo(0.1, 4);
  });
  it("NEGATIVE control — a category missing from the after run is skipped", () => {
    const before = {
      a: { n: 1, ndcg_5: 0.5, ndcg_10: 0.5, mrr: 0.5, hit_1: 0, hit_5: 0, recall_10: 0, all_rel_10: 0 }
    };
    expect(recencyDelta(before, {})).toEqual({});
  });
});
