// v3.12.0-rc.17 — LongMemEval retrieval-harness evidence-contract tests.
//
// Covers label-free materialization, schema/date validation, scoring helpers,
// and a compiled process-level two-question run that proves the public JSON
// artifact carries provenance + raw per-query evidence.

import { spawnSync } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error — .mjs build script, no type declarations (CLI guarded by isEntrypoint).
import {
  aggregateByCategory,
  aggregateByType,
  benchmarkArtifactStatus,
  byCategoryRows,
  duplicateSessionIdStats,
  isAbstention,
  isCanonicalLongMemEvalS,
  normalizedSessionMtimeMs,
  OFFICIAL_LONGMEMEVAL_S_BYTES,
  OFFICIAL_LONGMEMEVAL_S_INSTANCES,
  OFFICIAL_LONGMEMEVAL_S_SHA256,
  OFFICIAL_LONGMEMEVAL_S_URL,
  OHS_METRICS,
  parseLongMemEvalDate,
  recencyDelta,
  relevantSessionPaths,
  sessionNotePath,
  sessionToMarkdown,
  validateLongMemEvalInstances
} from "../scripts/bench-longmemeval.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");

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
    const cleanCommit = { git_commit: "a".repeat(40), git_dirty: false };
    expect(benchmarkArtifactStatus(true, cleanCommit)).toEqual({
      status: "complete",
      partial: false,
      publishable: true
    });
    expect(benchmarkArtifactStatus(true, { ...cleanCommit, git_dirty: true })).toEqual({
      status: "diagnostic-untrusted",
      partial: false,
      publishable: false
    });
    expect(benchmarkArtifactStatus(false, cleanCommit)).toEqual({
      status: "diagnostic-partial",
      partial: true,
      publishable: false
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
      expect(artifact.meta.partial).toBe(true);
      expect(artifact.meta.status).toBe("diagnostic-partial");
      expect(artifact.meta.canonical_cohort).toBe(false);
      expect(artifact.meta.publishable).toBe(false);
      expect(artifact.meta.protocol.name).toBe("longmemeval-s-global-index-scope-per-question");
      expect(artifact.meta.dataset).toMatchObject({
        variant: "longmemeval-compatible",
        total_instances: 2,
        selected_instances: 2,
        scored_instances: 2,
        materialized_notes: 4,
        declared_source_url: OFFICIAL_LONGMEMEVAL_S_URL
      });
      expect(artifact.meta.dataset.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(artifact.meta.implementation.git_commit).toMatch(/^[a-f0-9]{40}$/);
      expect(artifact.meta.environment).not.toHaveProperty("hostname");
      expect(artifact.meta.timing.total_ms).toBeGreaterThan(0);
      expect(artifact.meta.timing.index_footprint_bytes.fts_bytes).toBeGreaterThan(0);
      expect(artifact.meta.timing.index_footprint_bytes.embeddings_bytes).toBe(0);
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
      expect(overwrite.stderr).toContain("must not overwrite --dataset");
      expect(JSON.parse(await fs.readFile(dataset, "utf8"))).toHaveLength(2);
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
