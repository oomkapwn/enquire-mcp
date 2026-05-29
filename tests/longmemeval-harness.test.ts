// v3.9.0-rc.19 — LongMemEval retrieval-harness pure-function tests.
//
// Covers the deterministic, I/O-free helpers of scripts/bench-longmemeval.mjs
// (session→note materialization, ground-truth relevant-set derivation,
// abstention detection, per-type aggregation). The full benchmark run needs
// the (uncommitted, large) LongMemEval dataset + heavy compute and is a
// maintainer-gated step, so main() is intentionally NOT exercised here — but
// the logic that decides WHAT is scored and HOW it aggregates is, with
// NEGATIVE controls so a silent mis-attribution can't ship.

import { describe, expect, it } from "vitest";
// @ts-expect-error — .mjs build script, no type declarations (CLI guarded by isEntrypoint).
import {
  aggregateByType,
  isAbstention,
  relevantSessionPaths,
  sessionNotePath,
  sessionToMarkdown
} from "../scripts/bench-longmemeval.mjs";

describe("sessionNotePath (v3.9.0-rc.19)", () => {
  it("prefixes sessions/ and keeps safe ids", () => {
    expect(sessionNotePath("s_42")).toBe("sessions/s_42.md");
  });
  it("sanitizes unsafe characters (NEGATIVE control — no path traversal / spaces)", () => {
    expect(sessionNotePath("../../etc/passwd")).toBe("sessions/______etc_passwd.md");
    expect(sessionNotePath("a b/c")).toBe("sessions/a_b_c.md");
  });
});

describe("sessionToMarkdown (v3.9.0-rc.19)", () => {
  it("renders role-labelled turns with the session header + date", () => {
    const md = sessionToMarkdown(
      [
        { role: "user", content: "What's my dog's name?" },
        { role: "assistant", content: "Your dog is Rex." }
      ],
      "s1",
      "2026/01/02"
    );
    expect(md).toContain("# Session s1");
    expect(md).toContain("*2026/01/02*");
    expect(md).toContain("**User:** What's my dog's name?");
    expect(md).toContain("**Assistant:** Your dog is Rex.");
  });
  it("skips malformed turns + handles an empty session (NEGATIVE control)", () => {
    const md = sessionToMarkdown([{ role: "user" }, null, { content: 42 }], "s2", undefined);
    expect(md).toContain("# Session s2");
    expect(md).not.toContain("**User:** undefined");
    expect(md).not.toContain("*"); // no date line emitted
    expect(md.endsWith("\n")).toBe(true);
  });
});

describe("relevantSessionPaths (v3.9.0-rc.19)", () => {
  it("uses explicit answer_session_ids", () => {
    const rel = relevantSessionPaths({ answer_session_ids: ["s3", "s7"] });
    expect([...rel].sort()).toEqual(["sessions/s3.md", "sessions/s7.md"]);
  });
  it("falls back to has_answer turns when answer_session_ids is absent", () => {
    const rel = relevantSessionPaths({
      haystack_session_ids: ["a", "b", "c"],
      haystack_sessions: [
        [{ role: "user", content: "x" }],
        [{ role: "assistant", content: "y", has_answer: true }],
        [{ role: "user", content: "z" }]
      ]
    });
    expect([...rel]).toEqual(["sessions/b.md"]);
  });
  it("returns an EMPTY set when there is no ground truth (NEGATIVE control — abstention)", () => {
    expect(relevantSessionPaths({ question: "?" }).size).toBe(0);
    expect(relevantSessionPaths({ answer_session_ids: [] }).size).toBe(0);
  });
});

describe("isAbstention (v3.9.0-rc.19)", () => {
  it("flags _abs question ids", () => {
    expect(isAbstention({ question_id: "q42_abs" })).toBe(true);
  });
  it("is false for normal ids (NEGATIVE control)", () => {
    expect(isAbstention({ question_id: "q42" })).toBe(false);
    expect(isAbstention({})).toBe(false);
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
  it("returns [] for no input (NEGATIVE control)", () => {
    expect(aggregateByType([])).toEqual([]);
  });
});
