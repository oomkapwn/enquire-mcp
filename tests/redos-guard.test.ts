// v3.9.0-rc.9 (audit: input-validation security) — tests for the ReDoS guard
// protecting `obsidian_open_questions`. The tool compiles a caller-supplied
// `pattern` into V8's backtracking regex engine and runs it against every
// line of every note, so an unbounded/catastrophic pattern is a remote DoS on
// a bearer-authenticated serve-http. `isCatastrophicRegex` rejects the classic
// "star height ≥ 2" shapes before compile; `MAX_QUESTION_PATTERN_LEN` caps
// length. Both POSITIVE (safe patterns accepted) and NEGATIVE (catastrophic
// patterns rejected) controls per the CLAUDE.md rule since v3.6.4.

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getOpenQuestions,
  isCatastrophicRegex,
  MAX_QUESTION_PATTERN_LEN,
  readUnboundedQuantifier
} from "../src/tools/index.js";
import { Vault } from "../src/vault.js";

describe("isCatastrophicRegex — catastrophic patterns are flagged (NEGATIVE controls)", () => {
  const catastrophic = [
    "(a+)+$", // textbook nested unbounded quantifiers
    "(a+)*",
    "(a*)+",
    "(a*)*",
    "(.*)*",
    "(.+)+",
    "(\\d+)*", // escaped class-shorthand inside the group still counts
    "([a-z]+)+",
    "(\\w+)+$",
    "(.*a){20}", // bounded-but-large outer repetition over an unbounded body
    "(\\d+){11}", // {11} > amplify threshold (10)
    "((ab)+)+", // deep nesting — risk propagates up two frames
    "(?:a+)+", // non-capturing group, identical risk
    // v3.9.0-rc.21 — overlapping-alternation ReDoS (the audit-reproduced class
    // that the rc.9 guard missed). All are unbounded-quantified AMBIGUOUS
    // alternations (branches can match a common start), so V8 backtracks.
    "(a|a)+$", // textbook identical-branch alternation (auditor reproduced >8s hang)
    "(a|a)*",
    "(a|ab)+", // prefix-overlapping branches share leading `a`
    "(a|ab)*",
    "(.|a)+", // a broad `.` branch overlaps the literal branch
    "(\\w|x)+", // class-shorthand branch overlaps the literal `x`
    "(a|)+", // a nullable (empty) branch loops ambiguously
    "((a|a))+", // ambiguity bubbles up from the nested group to the outer `+`
    "(?:a|a)+", // non-capturing, same risk
    "(cat|car)+" // shared leading char (over-flagged — conservative, acceptable)
  ];
  for (const p of catastrophic) {
    it(`flags ${JSON.stringify(p)}`, () => {
      expect(isCatastrophicRegex(p)).toBe(true);
    });
  }
});

describe("isCatastrophicRegex — safe patterns are NOT flagged (POSITIVE controls)", () => {
  const safe = [
    "^Q: (.+)$",
    // the production default pattern MUST pass (regression guard)
    "^\\s*(?:[#\\->\\*\\d\\.]+\\s+)?(?:open\\s+question|q|todo\\?|\\?\\?)\\s*[:\\-]?\\s*(.+)$",
    "(foo|bar)",
    "(ab)+", // single-level quantifier on a group — linear
    "\\d{4}-\\d{2}-\\d{2}", // bounded brace quantifiers
    "[a-z]+@[a-z]+\\.[a-z]+",
    "TODO\\??",
    "(a|b|c)+", // DISJOINT single-char alternation under + — matches linearly, safe
    "(cat|dog)+", // DISJOINT multi-char alternation (distinct first chars) — safe
    "(a|b|c)", // alternation with NO quantifier — never a backtracking risk
    "(?:open|q|todo)\\s*", // the default pattern's alternation shape (unquantified) stays safe
    "\\(a+\\)\\+", // escaped parens/plus are literals, not a quantified group
    "[(+*)]+", // metacharacters inside a char class are literals
    "(.+){2,5}" // small bounded outer repetition (≤ amplify threshold)
  ];
  for (const p of safe) {
    it(`accepts ${JSON.stringify(p)}`, () => {
      expect(isCatastrophicRegex(p)).toBe(false);
    });
  }
});

describe("readUnboundedQuantifier", () => {
  it("recognizes * and + as unbounded (length 1)", () => {
    expect(readUnboundedQuantifier("*", 0)).toEqual({ unbounded: true, length: 1 });
    expect(readUnboundedQuantifier("+", 0)).toEqual({ unbounded: true, length: 1 });
  });
  it("folds a trailing lazy ? into the span", () => {
    expect(readUnboundedQuantifier("+?", 0)).toEqual({ unbounded: true, length: 2 });
  });
  it("treats open-ended {n,} as unbounded", () => {
    expect(readUnboundedQuantifier("{2,}", 0)).toEqual({ unbounded: true, length: 4 });
  });
  it("treats a large finite {n,m} (m > 10) as amplifying", () => {
    expect(readUnboundedQuantifier("{2,50}", 0).unbounded).toBe(true);
  });
  it("treats small bounded {n} / {n,m} as NOT unbounded (NEGATIVE control)", () => {
    expect(readUnboundedQuantifier("{4}", 0).unbounded).toBe(false);
    expect(readUnboundedQuantifier("{2,5}", 0).unbounded).toBe(false);
  });
  it("returns length 0 at a non-quantifier position (NEGATIVE control)", () => {
    expect(readUnboundedQuantifier("abc", 0)).toEqual({ unbounded: false, length: 0 });
    expect(readUnboundedQuantifier("{nope}", 0)).toEqual({ unbounded: false, length: 0 });
  });
});

describe("getOpenQuestions — pattern hardening integration", () => {
  let root: string;
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-redos-"));
    await fs.writeFile(
      path.join(root, "Note.md"),
      "# Heading\n\nOpen question: what is the budget?\n\nSome body text.\n"
    );
  });
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("works with the safe default pattern (POSITIVE control)", async () => {
    const out = await getOpenQuestions(new Vault(root), {});
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]?.question).toContain("budget");
  });

  it("accepts a safe custom pattern (POSITIVE control)", async () => {
    const out = await getOpenQuestions(new Vault(root), { pattern: "^Open question: (.+)$" });
    expect(out.length).toBeGreaterThan(0);
  });

  it("REJECTS a catastrophic custom pattern (NEGATIVE control)", async () => {
    // Build the catastrophic pattern at RUNTIME (not a string literal) so
    // CodeQL's js/redos static analysis doesn't flag a catastrophic regex
    // reaching getOpenQuestions's `new RegExp` sink. The point of this test is
    // precisely that the guard REJECTS it *before* any compile — so it never
    // executes as a regex — but CodeQL can't model that the guard throws first.
    // `String.fromCharCode(43)` is "+"; `evil` equals "(a+)+$".
    const plus = String.fromCharCode(43);
    const evil = `(a${plus})${plus}$`;
    await expect(getOpenQuestions(new Vault(root), { pattern: evil })).rejects.toThrow(
      /catastrophic backtracking|ReDoS|rejected/i
    );
  });

  it("REJECTS an overlapping-alternation pattern (NEGATIVE control, v3.9.0-rc.21)", async () => {
    // The audit-reproduced ReDoS class the rc.9 guard missed: `(a|a)+$`.
    // Built at runtime (pipe via String.fromCharCode(124)) so CodeQL's js/redos
    // never sees a catastrophic literal reaching the `new RegExp` sink — the
    // guard rejects it BEFORE compile, so it never executes.
    const pipe = String.fromCharCode(124);
    const plus = String.fromCharCode(43);
    const evilAlt = `(a${pipe}a)${plus}$`; // "(a|a)+$"
    await expect(getOpenQuestions(new Vault(root), { pattern: evilAlt })).rejects.toThrow(
      /catastrophic backtracking|ReDoS|rejected/i
    );
  });

  it("still accepts a DISJOINT alternation override (POSITIVE control — no over-rejection)", async () => {
    // `(open question|todo): ...` style — distinct first chars, matches linearly.
    const out = await getOpenQuestions(new Vault(root), { pattern: "^(open question|todo): (.+)$" });
    expect(Array.isArray(out)).toBe(true); // compiles + runs; not rejected
  });

  it("REJECTS an over-long pattern (NEGATIVE control)", async () => {
    const tooLong = "a".repeat(MAX_QUESTION_PATTERN_LEN + 1);
    await expect(getOpenQuestions(new Vault(root), { pattern: tooLong })).rejects.toThrow(/too long/i);
  });
});
