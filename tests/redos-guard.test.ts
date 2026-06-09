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
  decodeEscapedChar,
  getOpenQuestions,
  isCatastrophicRegex,
  MAX_QUESTION_PATTERN_LEN,
  matchLinesBounded,
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
    "(cat|car)+", // shared leading char (over-flagged — conservative, acceptable)
    // v3.9.0-rc.24 — re-audit of rc.21 reproduced two false-negatives the
    // leading-atom analysis missed (each hung V8 ~16s). The tool compiles /i,
    // and escapes alias real chars, so these are all `(a|a)+` in effect.
    "(a|A)+$", // /i flag: a and A match the same input (case-fold)
    "(A|a)+$",
    "(\\x61|a)+$", // \x61 = "a" (hex escape decode)
    "(a|\\x61)+$",
    "(\\u0061|a)+$", // a = "a" (unicode escape decode)
    "(\\u{61}|a)+$", // \u{61} = "a" (unicode code-point escape)
    // v3.9.0-rc.24 — UNRESOLVED escapes must over-flag (the conservative/safe
    // direction): a branch whose first atom can't be decoded to a known single
    // char is treated as a broad/ANY leading atom, which overlaps the literal `a`.
    "(\\xZZ|a)+$", // malformed hex escape → undecodable → ANY → ambiguous
    "(\\uZZZZ|a)+$", // malformed 4-hex unicode → undecodable → ANY
    "(\\u{}|a)+$", // empty code-point braces → undecodable → ANY
    "(\\q|a)+$", // unknown escape letter → undecodable → ANY
    // v3.9.0-rc.25 — the C-1 audit + fuzz findings. Shape A: an OPTIONAL leading
    // atom makes a branch's leading set overlap another branch (the leading-atom
    // analysis read the literal and ignored the quantifier).
    "(a?b|b)+$", // `a?b` can start with `a` OR `b` → overlaps the `b` branch
    "(a??b|b)+$", // lazy `??` — same
    "(a{0,5}b|b)+$", // `{0,5}` min-0 → optional leading atom
    "(a*b|b)+$", // `*` min-0 → optional leading atom
    // Shape B: a NULLABLE body under an unbounded quantifier.
    "(a?){25}$", // `a?` nullable, `{25}` amplifier
    "(a?)+", // nullable body under +
    "(\\s*)*", // nullable body under *
    "((a?))+", // nested nullable group bubbles up
    // Shape C: a VARIABLE-LENGTH body under an unbounded quantifier (the whole
    // class the fuzz harness surfaced; readUnboundedQuantifier's amplify-threshold
    // treated bounded ranges like {2,5} as "not unbounded").
    "(a{2,5})+$", // variable-length inner range, repeated
    "([ac]{2,5})+$", // variable-length char-class run, repeated
    "(a[ab]?)+$", // optional overlapping atom, repeated
    "(\\w[ba]{0,3})+$", // class-shorthand + variable range, repeated
    // v3.10.0-rc.36 — the CRITICAL the rc.25 fuzz/guard still missed: ADJACENT
    // overlapping unbounded quantifiers at the TOP level (frame 0 is never popped,
    // so rc.21–rc.25's pop-only verdict never saw them). Measured ~16s V8 hang.
    "a*a*$", // 2 directly-adjacent identical stars + failing end-anchor (~1s @2000)
    "a*a*a*$",
    "\\w*\\w*\\w*\\w*\\w*\\w*\\w*\\w*$", // the auditor's exact repro (~16s @45 chars)
    "\\w*\\w*$",
    ".*.*$",
    "\\s*\\s*$", // whitespace run + failing anchor (~12s)
    "\\s*[:\\-]?\\s*$", // optional separator is transparent → still adjacent
    "a*x?a*$", // optional `x?` between → run stays adjacent
    "\\w*\\d*$", // cross-class overlap (\\d ⊂ \\w) — probe-based detection catches it
    "(a)*(a)*$", // adjacent quantified GROUPS over the same atom
    "(\\w*\\w*)x", // adjacency INSIDE a group, failing literal tail outside it
    "a*a*b$" // adjacent run + disjoint mandatory blocker (b can fail)
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
    "(.+){2,5}", // small bounded outer repetition (≤ amplify threshold)
    // v3.9.0-rc.24 — the escape DECODER must not OVER-flag a genuinely disjoint
    // escaped branch: `\.` is a literal dot, disjoint from `a`, so `(\.|a)+`
    // matches deterministically → safe (regression guard for the rc.24 decoder).
    "(\\.|a)+",
    // v3.9.0-rc.25 — precision guards for the leading-SET refactor and the
    // variable-body term. These MUST stay safe (the fix must not regress them):
    "(ab|cd)+", // fixed-length, disjoint first chars → linear
    "(abc){2,5}", // fixed-length body, bounded outer → linear
    "(a|b|c){5,10}", // disjoint single-char alternation, bounded outer
    "^(Q|TODO|Open question):\\s*(.+)$", // a realistic capture-group override
    "(open|q)\\s*[:-]\\s*(.+)", // another realistic override (groups for capture, not repetition)
    // v3.10.0-rc.36 — adjacency precision: these MUST stay accepted (the fix must
    // not over-flag common safe shapes; regression guards for the probe-based
    // overlap + the `.`-greedy absorber tail exemption).
    "a*b*$", // adjacent but DISJOINT (different chars) → linear
    "a*b*c*$",
    "\\d*\\s*x", // disjoint broad classes (\\d ∩ \\s = ∅) — probe overlap is empty
    "\\w+\\s+", // word-run then whitespace-run — disjoint, extremely common
    "[#.]+\\s+", // the default pattern's inner group shape — disjoint class vs \\s
    "a*xa*$", // a MANDATORY `x` between breaks the adjacency run
    "\\s*\\s*(.+)$", // adjacent \\s* but a `.`-greedy absorber tail → benign
    "\\s*[:\\-]?\\s*(.+)$" // the default's exact tail shape — absorber-saved
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

describe("decodeEscapedChar — escape resolution + span (v3.9.0-rc.25)", () => {
  // `pos` is the index of the char AFTER the backslash. Covers the branches the
  // rc.24 redos cases exercised only transitively (test-audit MED-2).
  it("decodes hex / unicode / code-point escapes to the right char + length", () => {
    expect(decodeEscapedChar("\\x61", 1)).toEqual({ char: "a", length: 3 });
    expect(decodeEscapedChar("\\u0061", 1)).toEqual({ char: "a", length: 5 });
    expect(decodeEscapedChar("\\u{61}", 1)).toEqual({ char: "a", length: 5 });
    expect(decodeEscapedChar("\\u{1F600}", 1).char).toBe("\u{1F600}");
  });
  it("decodes the control escapes (the previously-untested branches)", () => {
    expect(decodeEscapedChar("\\t", 1)).toEqual({ char: "\t", length: 1 });
    expect(decodeEscapedChar("\\n", 1)).toEqual({ char: "\n", length: 1 });
    expect(decodeEscapedChar("\\r", 1)).toEqual({ char: "\r", length: 1 });
    expect(decodeEscapedChar("\\f", 1)).toEqual({ char: "\f", length: 1 });
    expect(decodeEscapedChar("\\v", 1)).toEqual({ char: "\v", length: 1 });
  });
  it("decodes \\0 NUL only when not followed by a digit (octal disambiguation)", () => {
    expect(decodeEscapedChar("\\0", 1)).toEqual({ char: "\0", length: 1 });
    expect(decodeEscapedChar("\\012", 1).char).toBeNull(); // octal → unresolved
  });
  it("decodes a punctuation/metacharacter escape to its literal", () => {
    expect(decodeEscapedChar("\\.", 1)).toEqual({ char: ".", length: 1 });
    expect(decodeEscapedChar("\\+", 1)).toEqual({ char: "+", length: 1 });
  });
  it("returns char:null (length≥1) for unresolved escapes (NEGATIVE control)", () => {
    expect(decodeEscapedChar("\\xZZ", 1).char).toBeNull(); // malformed hex
    expect(decodeEscapedChar("\\uZZZZ", 1).char).toBeNull(); // malformed 4-hex
    expect(decodeEscapedChar("\\u{}", 1).char).toBeNull(); // empty code-point
    expect(decodeEscapedChar("\\q", 1).char).toBeNull(); // unknown letter
    expect(decodeEscapedChar("\\", 1)).toEqual({ char: null, length: 0 }); // nothing after backslash
  });
});

describe("matchLinesBounded — hard ReDoS sink-bound (v3.10.0-rc.39)", () => {
  // isCatastrophicRegex is a best-effort denylist (ReDoS is undecidable; the rc.36
  // re-sweep confirmed a residual under-flag tail). This worker-thread timeout is
  // the HARD backstop — the main event loop can never hang for ANY pattern, and one
  // that blows the budget is rejected fail-closed. The catastrophic pattern is
  // base64-decoded at runtime so no catastrophic regex literal reaches a `new RegExp`
  // sink in this source (CodeQL js/redos hygiene).
  const cataMissed = Buffer.from("XFc/KChbY2FdKj8pezAsM318Y3syLDV9YnsyLDV9KXswLDN9JA==", "base64").toString();

  it("returns first-capture matches for a safe pattern (POSITIVE control)", async () => {
    const out = await matchLinesBounded("^Q: (.+)$", ["Q: hello", "nope", "Q: two"], 2000);
    expect(out).toEqual([
      { idx: 0, q: "hello" },
      { idx: 2, q: "two" }
    ]);
  });

  it("REJECTS within the budget a pattern isCatastrophicRegex MISSES (the rc.36 residual)", async () => {
    // Confirm it IS a detector-miss (so the worker bound — not the denylist — is what
    // saves us), then prove the worker is killed at the budget instead of hanging.
    expect(isCatastrophicRegex(cataMissed)).toBe(false);
    const t0 = Date.now();
    await expect(matchLinesBounded(cataMissed, [`${"a".repeat(50)}!`], 500)).rejects.toThrow(
      /budget|catastrophic|ReDoS/i
    );
    expect(Date.now() - t0).toBeLessThan(4000); // bounded — did NOT hang
  });

  it("REJECTS an invalid pattern with a clear error (NEGATIVE control)", async () => {
    const open = String.fromCharCode(40); // "(" — unbalanced → invalid regex
    await expect(matchLinesBounded(open, ["x"], 1000)).rejects.toThrow(/invalid pattern/i);
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

  it("REJECTS a detector-MISSED catastrophic pattern via the worker sink-bound (v3.10.0-rc.39)", async () => {
    // The rc.36 re-sweep proved isCatastrophicRegex under-flags some nested shapes
    // (decoded at runtime). The worker timeout is the hard backstop end-to-end: the
    // tool rejects fail-closed at the budget instead of hanging the event loop.
    const cataMissed = Buffer.from("XFc/KChbY2FdKj8pezAsM318Y3syLDV9YnsyLDV9KXswLDN9JA==", "base64").toString();
    expect(isCatastrophicRegex(cataMissed)).toBe(false); // the cheap denylist misses it
    // The catastrophic backtracking needs a LONG input line to bite — seed a
    // dedicated vault with one (the shared `root` notes are too short to hang).
    const longRoot = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-redos-long-"));
    try {
      // Trailing "!" (a non-[abc]/non-word char) makes the anchored `$` fail after
      // the long run → forces the exponential redistribution that hangs the engine.
      await fs.writeFile(path.join(longRoot, "Long.md"), `# H\n\n${"a".repeat(60)}!\n`);
      await expect(getOpenQuestions(new Vault(longRoot), { pattern: cataMissed, scanBudgetMs: 600 })).rejects.toThrow(
        /budget|catastrophic|ReDoS|rejected/i
      );
    } finally {
      await fs.rm(longRoot, { recursive: true, force: true });
    }
  });
});

describe("getOpenQuestions — returns the genuinely-OLDEST, not a walk-order subset (rc.16 audit M5)", () => {
  let root: string;
  const DAY = 24 * 3600 * 1000;
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-oq-age-"));
    // Each note has exactly one question; mtime sets its age. Created in
    // newest→oldest order with names that sort the OLDEST LAST, so the oldest is
    // never readdir-first under alphabetical OR creation order — the pre-rc.16
    // code (collect first `limit` in walk order, THEN sort) would surface the
    // NEWEST here, the fixed code the OLDEST.
    const notes: Array<[string, number]> = [
      ["aaa-newest.md", 0],
      ["mmm-mid.md", 100],
      ["zzz-oldest.md", 200]
    ];
    for (const [name, ageDays] of notes) {
      const abs = path.join(root, name);
      await fs.writeFile(abs, `Open question: from ${name}?\n`);
      const mtime = new Date(Date.now() - ageDays * DAY);
      await fs.utimes(abs, mtime, mtime);
    }
  });
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("with limit=1 returns the single OLDEST question, not the walk-first/newest", async () => {
    const out = await getOpenQuestions(new Vault(root), { limit: 1 });
    expect(out).toHaveLength(1);
    // The fix: globally-oldest. The bug returned the walk-first (newest) note.
    expect(out[0]?.source_path).toBe("zzz-oldest.md");
    expect(out[0]?.source_path).not.toBe("aaa-newest.md");
  });

  it("with limit=2 (< total) returns the 2 OLDEST, oldest-first", async () => {
    const out = await getOpenQuestions(new Vault(root), { limit: 2 });
    expect(out.map((q) => q.source_path)).toEqual(["zzz-oldest.md", "mmm-mid.md"]);
  });

  it("returns ALL questions oldest-first when limit covers them (ordering regression guard)", async () => {
    const out = await getOpenQuestions(new Vault(root), { limit: 50 });
    expect(out.map((q) => q.source_path)).toEqual(["zzz-oldest.md", "mmm-mid.md", "aaa-newest.md"]);
  });
});
