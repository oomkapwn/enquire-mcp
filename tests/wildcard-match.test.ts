import { describe, expect, it } from "vitest";
import { compileGlobTokens, compileLikeTokens, foldForMatch, matchWildcardTokens } from "../src/wildcard-match.js";

// v3.10.0-rc.71 (post-rc.66 re-sweep, ReDoS class — closes the rc.63 likeToRegex + rc.68
// globToRegex siblings). Both sinks previously compiled the pattern into a backtracking
// RegExp; a pattern with unbounded wildcards SEPARATED BY LITERALS (`*a*a*…` for LIKE,
// `**a**a…` for glob) — which neither the rc.63 run-collapse nor the rc.68 adjacency-collapse
// touched — produced `^.*a.*a…$`, the textbook catastrophic shape (measured 110 s for `.*a`×14).
// The catastrophe scales with the SUBJECT length, so a wildcard count cap is not structurally
// safe. The fix replaces the regex with a NON-backtracking DP that is O(tokens × len) for every
// input. These tests pin (a) correctness, (b) byte-equivalence to the OLD regex semantics over a
// broad corpus (differential regression guard), and (c) the linear budget on the catastrophic
// shapes that hung V8 pre-rc.71.

// ---- helpers mirroring the production call sites ----
const like =
  (pattern: string) =>
  (value: string): boolean =>
    matchWildcardTokens(compileLikeTokens(pattern), value, { caseInsensitive: true });
const glob =
  (pattern: string) =>
  (value: string): boolean =>
    matchWildcardTokens(compileGlobTokens(pattern), value);

// ---- INLINED pre-rc.71 builders (the shipped rc.70 source) — the differential reference.
// Kept self-contained in the test (the production functions no longer exist) so any future
// semantic drift in the matcher fails CI against the original regex behavior. Mirrors the
// rc.53 gray-matter→js-yaml differential-corpus method.
function oldLikeToRegex(pattern: string): RegExp {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: regex meta-chars list, not a template
  const REGEX_SPECIALS = ".+*^${}()|[]\\";
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\" && i + 1 >= pattern.length) {
      out += "\\\\";
      continue;
    }
    if (ch === "\\" && i + 1 < pattern.length) {
      const next = pattern[i + 1] as string;
      out += REGEX_SPECIALS.includes(next) ? `\\${next}` : next;
      i++;
      continue;
    }
    if (ch === "*") {
      out += ".*";
      while (pattern[i + 1] === "*") i++;
      continue;
    }
    if (ch !== undefined && REGEX_SPECIALS.includes(ch)) {
      out += `\\${ch}`;
      continue;
    }
    out += ch;
  }
  return new RegExp(`^${out}$`, "iu");
}
function oldGlobToRegex(glob: string): RegExp {
  let i = 0;
  let out = "^";
  while (i < glob.length) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i += 2;
        while (glob[i] === "*") i += 1;
        if (glob[i] === "/") i += 1;
        continue;
      }
      out += "[^/]*";
      i += 1;
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      i += 1;
      continue;
    }
    if (ch && /[.+^${}()|[\]\\]/.test(ch)) {
      out += `\\${ch}`;
      i += 1;
      continue;
    }
    out += ch ?? "";
    i += 1;
  }
  out = out.replace(/(?:\.\*|\[\^\/\]\*){2,}/g, ".*");
  out += "$";
  return new RegExp(out);
}

describe("wildcard-match — compileLike (DQL LIKE, case-insensitive)", () => {
  it("matches the basic LIKE shapes (POSITIVE controls)", () => {
    expect(like("foo*bar")("fooXYZbar")).toBe(true);
    expect(like("*foo*")("xxfooyy")).toBe(true);
    expect(like("*foo*")("bar")).toBe(false); // NEGATIVE
    expect(like("a*b")("ab")).toBe(true); // `*` matches empty
    expect(like("a*b")("aXc")).toBe(false); // NEGATIVE
    expect(like("****")("anything at all")).toBe(true);
    expect(like("****")("")).toBe(true);
    expect(like("")("")).toBe(true); // empty pattern matches only empty
    expect(like("")("x")).toBe(false); // NEGATIVE
    expect(like("exact")("exact")).toBe(true);
    expect(like("exact")("exactly")).toBe(false); // NEGATIVE — anchored
  });

  it("is case-insensitive (matches the old `iu` flag / the file's other string ops)", () => {
    expect(like("FOO*")("foobar")).toBe(true);
    expect(like("*café*")("THE CAFÉ HERE".toLowerCase())).toBe(true);
    expect(like("*café*")("the CAFÉ here")).toBe(true);
  });

  it("honors the escape rules (`\\*` literal asterisk, `\\\\` literal backslash, trailing `\\`)", () => {
    expect(like("a\\*\\*b")("a**b")).toBe(true);
    expect(like("a\\*\\*b")("aXYb")).toBe(false); // NEGATIVE — `\*` is a literal, not a wildcard
    expect(like("a\\\\b")("a\\b")).toBe(true);
    expect(like("trailing\\")("trailing\\")).toBe(true);
  });

  it("treats `?` as a LITERAL (the only LIKE wildcard is `*`) — incidentally fixes a pre-rc.71 crash", () => {
    // The pre-rc.71 likeToRegex omitted `?` from its regex-specials set, so any LIKE
    // value containing `?` produced an INVALID regex (`^?$` → 'Nothing to repeat') and
    // THREW. The matcher has no regex, so `?` is just a literal char.
    expect(() => like("a?b")("a?b")).not.toThrow();
    expect(like("a?b")("a?b")).toBe(true);
    expect(like("a?b")("aXb")).toBe(false); // `?` is NOT a single-char wildcard in LIKE
  });
});

describe("wildcard-match — compileGlob (path glob, case-sensitive, `/`-aware)", () => {
  it("`*` matches within a segment, `**` crosses segments (POSITIVE/NEGATIVE controls)", () => {
    expect(glob("*.md")("note.md")).toBe(true);
    expect(glob("*.md")("dir/note.md")).toBe(false); // `*` doesn't cross `/`
    expect(glob("**")("any/deep/path.md")).toBe(true);
    expect(glob("Personal/**")("Personal/diary.md")).toBe(true);
    expect(glob("Personal/**")("Work/diary.md")).toBe(false); // NEGATIVE
    expect(glob("a/**/b")("a/b")).toBe(true); // globstar eats the slash
    expect(glob("a/**/b")("a/x/y/b")).toBe(true);
    expect(glob("a/*/b")("a/x/b")).toBe(true);
    expect(glob("a/*/b")("a/x/y/b")).toBe(false); // single `*` is one segment
  });

  it("`?` matches exactly one non-slash char; is case-sensitive", () => {
    expect(glob("?_temp.md")("x_temp.md")).toBe(true);
    expect(glob("?_temp.md")("xx_temp.md")).toBe(false); // NEGATIVE
    expect(glob("?_temp.md")("/_temp.md")).toBe(false); // `?` excludes `/`
    expect(glob("dot.path/x.md")("dotXpath/x.md")).toBe(false); // `.` is literal
    expect(glob("Inbox/note.md")("inbox/note.md")).toBe(false); // case-sensitive
  });
});

// The DIFFERENTIAL regression guard: the matcher must agree with the pre-rc.71 regex
// semantics on every corpus pair in the ASCII + ordinary-accented (`café`) corpus below.
// 0 mismatches proves the rewrite preserved behavior on that corpus. NOTE (rc.75): the
// case-insensitive FOLDING dimension is NOT covered here (the corpus contains no codepoint
// whose `i`-flag canonical fold differs from `toLowerCase`); it is pinned separately by the
// "case-fold contract" describe below — the rc.54 lesson that a differential corpus is only
// as strong as the shapes it can produce.
describe("wildcard-match — differential vs pre-rc.71 regex (behavior-preservation guard)", () => {
  it("LIKE: new matcher === old likeToRegex over a broad corpus", () => {
    const patterns = [
      "",
      "*",
      "**",
      "***",
      "foo",
      "*foo",
      "foo*",
      "*foo*",
      "a*b",
      "a*b*c",
      "*a*a*",
      "a\\*b",
      "a\\\\b",
      "\\d",
      "trailing\\",
      "*.md",
      "FOO",
      "café*",
      "*x*y*z*",
      "a**b"
    ];
    const subjects = [
      "",
      "foo",
      "FOO",
      "xfoox",
      "ab",
      "axb",
      "abc",
      "aXbYc",
      "a*b",
      "a\\b",
      "d",
      "x.md",
      "café x",
      "CAFÉ",
      "axaxa",
      "trailing\\"
    ];
    let mismatches = 0;
    for (const p of patterns) {
      const old = oldLikeToRegex(p);
      const next = like(p);
      for (const s of subjects) if (old.test(s) !== next(s)) mismatches++;
    }
    expect(mismatches, "new LIKE matcher must agree with the pre-rc.71 regex on every corpus pair").toBe(0);
  });

  it("glob: new matcher === old globToRegex over a broad corpus", () => {
    const patterns = [
      "",
      "*",
      "**",
      "***",
      "****",
      "*.md",
      "Personal/**",
      "a/**/b",
      "a/**/**/b",
      "**foo**",
      "?_temp.md",
      "(parens)/x.md",
      "dot.path/x.md",
      "Inbox/*.md",
      "**/*.md",
      "a/*/b",
      "**.md",
      "x*y*z",
      "deep/**/nested/*.txt",
      "a**/*b"
    ];
    const subjects = [
      "",
      "x.md",
      "Personal/diary.md",
      "a/b",
      "a/x/y/b",
      "a/zzzb",
      "foobar",
      "x_temp.md",
      "/_temp.md",
      "(parens)/x.md",
      "dot.path/x.md",
      "dotXpath/x.md",
      "Inbox/note.md",
      "deep/a/nested/f.txt",
      "ab",
      "a/c/b",
      "x.md.bak",
      "any/deep/path.md",
      "a/x/yb"
    ];
    let mismatches = 0;
    for (const p of patterns) {
      const old = oldGlobToRegex(p);
      const next = glob(p);
      for (const s of subjects) if (old.test(s) !== next(s)) mismatches++;
    }
    expect(mismatches, "new glob matcher must agree with the pre-rc.71 regex on every corpus pair").toBe(0);
  });
});

// v3.10.0-rc.75 — CASE-FOLD CONTRACT (closes the post-rc.74 re-sweep's one LOW + the rc.54-class
// "differential corpus is only as strong as the shapes it can produce" gap). DQL `LIKE` folds via
// `toLowerCase`, NOT the pre-rc.71 regex `i`+`u` canonical fold, so it DIVERGES (under-match) for
// ~22 exotic BMP codepoints. This pins the DP matcher's deliberate semantics for representatives of
// that set AND proves the divergence is real (the old regex WOULD have matched) so the contract
// isn't vacuous — the dimension the ASCII differential corpus above structurally cannot reach.
describe("wildcard-match — LIKE Unicode case-fold contract (rc.75)", () => {
  // [pattern, value] pairs where the pre-rc.71 `^pattern$/iu` regex matched but `toLowerCase`
  // folding does not (verified by an exhaustive BMP brute-force in the re-sweep).
  const divergent: Array<[string, string, string]> = [
    ["µ", "Μ", "micro-sign U+00B5 vs Greek capital mu U+039C"],
    ["ſ", "S", "long-s U+017F vs S"],
    ["ς", "Σ", "final-sigma U+03C2 vs Sigma U+03A3"]
  ];

  it("ASCII/ordinary-accented case-insensitivity is UNCHANGED (POSITIVE control)", () => {
    expect(like("FOO")("foo")).toBe(true);
    expect(like("É")("é")).toBe(true); // ordinary accented letter still folds
    expect(like("CAFÉ")("café")).toBe(true);
  });

  for (const [pattern, value, label] of divergent) {
    it(`folds via toLowerCase, NOT regex iu canonical fold — ${label}`, () => {
      // The DP matcher's CONTRACT: these do NOT match (toLowerCase semantics).
      expect(like(pattern)(value)).toBe(false);
      // NEGATIVE control — the divergence is REAL and the row is non-vacuous: the pre-rc.71
      // regex (preserved inline as oldLikeToRegex) WOULD have matched.
      expect(oldLikeToRegex(pattern).test(value)).toBe(true);
      // sanity: a same-codepoint match still works (the char folds to itself).
      expect(like(pattern)(pattern)).toBe(true);
    });
  }
});

// The structural ReDoS guard: the EXACT literal-separated shapes that hung V8 pre-rc.71
// (the rc.63/rc.68 siblings the catastrophe-collapse couldn't touch) must complete in a
// linear budget. Pre-rc.71 these took seconds-to-minutes; the DP is O(tokens × len).
describe("wildcard-match — linear budget on catastrophic literal-separated shapes (rc.71)", () => {
  it("LIKE `*a*a…` against an adversarial non-matching subject is linear", () => {
    // `*a`×40 = 40 wildcards; pre-rc.71 (`^.*a.*a…$`) this hung V8 for many minutes against
    // a long all-`a` subject. The matcher must finish well under a second.
    const matcher = like(`${"*a".repeat(40)}`);
    const subject = "a".repeat(4000); // worst case: many partitions for a regex, O(n·k) here
    const t0 = Date.now();
    for (let r = 0; r < 5; r++) matcher(`${subject}b`); // non-matching (trailing b)
    expect(Date.now() - t0, "linear LIKE matcher must not hang").toBeLessThan(3000);
  });

  it("glob `**a**a…` / `*a*a…` against an adversarial non-matching path is linear", () => {
    const subject = `${"a".repeat(2000)}/${"a".repeat(2000)}`;
    const t0 = Date.now();
    for (const pat of [`${"**a".repeat(30)}X`, `${"*a".repeat(40)}X`]) {
      const matcher = glob(pat);
      for (let r = 0; r < 5; r++) matcher(subject);
    }
    expect(Date.now() - t0, "linear glob matcher must not hang").toBeLessThan(3000);
  });

  it("matchWildcardTokens scales linearly, not catastrophically, in wildcard count (empirical)", () => {
    // A regex backtracker explodes super-linearly with wildcard count; the DP stays flat.
    const subject = `${"a".repeat(500)}b`;
    const time = (k: number): number => {
      const tokens = compileLikeTokens("*a".repeat(k));
      const t0 = Date.now();
      for (let r = 0; r < 50; r++) matchWildcardTokens(tokens, subject, { caseInsensitive: true });
      return Date.now() - t0;
    };
    // Even at 80 wildcards (catastrophic pre-rc.71) the matcher is fast. Assert an absolute
    // budget rather than a ratio (ratios flake under parallel-test CPU load).
    expect(
      time(80),
      "80 literal-separated wildcards must not hang (generous ceiling — rc.24 widened from 500ms; parallel CI load spiked the matcher to ~1s)"
    ).toBeLessThan(3000);
  });
});

describe("wildcard-match — tokenizers", () => {
  it("compileLikeTokens coalesces `*` runs and parses escapes", () => {
    expect(compileLikeTokens("a**b")).toEqual([{ lit: "a" }, { kind: "any" }, { lit: "b" }]);
    expect(compileLikeTokens("***")).toEqual([{ kind: "any" }]);
    expect(compileLikeTokens("a\\*b")).toEqual([{ lit: "a*b" }]); // escaped star → literal
    expect(compileLikeTokens("")).toEqual([]);
  });

  it("compileGlobTokens distinguishes `*` / `**` / `?` and eats one trailing slash after `**`", () => {
    expect(compileGlobTokens("*.md")).toEqual([{ kind: "segstar" }, { lit: ".md" }]);
    expect(compileGlobTokens("a/**/b")).toEqual([{ lit: "a/" }, { kind: "any" }, { lit: "b" }]);
    expect(compileGlobTokens("?x")).toEqual([{ kind: "question" }, { lit: "x" }]);
  });
});

describe("wildcard-match — foldForMatch (rc.1, context-free per-code-point case fold)", () => {
  it("folds Greek capital sigma to MEDIAL σ regardless of position (context-free)", () => {
    // The bug it closes: whole-string `"ΟΔΟΣ".toLowerCase()` applies word-final ς.
    expect("ΟΔΟΣ".toLowerCase()).toBe("οδος"); // JS context-sensitive fold (final ς)
    expect(foldForMatch("ΟΔΟΣ")).toBe("οδοσ"); // context-free (medial σ) — matches a per-cp haystack
    expect(foldForMatch("ΣΟ")).toBe("σο"); // non-final Σ unchanged in meaning
  });

  it("is idempotent for ASCII + handles length-changing folds (İ) per code point", () => {
    expect(foldForMatch("ABC")).toBe("abc");
    expect(foldForMatch("abc")).toBe("abc");
    expect(foldForMatch("İ")).toBe("i̇"); // U+0130 → 2 units, like the haystack fold
    expect(foldForMatch("")).toBe("");
  });

  it("folds an ASTRAL case-folding char (Deseret 𐐀→𐐨) — a per-UTF-16-unit charAt loop would NOT", () => {
    expect(foldForMatch("𐐀")).toBe("𐐨"); // for..of iterates by code point, so the surrogate pair folds
    // NEGATIVE control: a per-UTF-16-unit fold splits the pair and leaves it UNfolded (the old hazard)
    const perUnit = [..."𐐀".split("")].map((c) => c.toLowerCase()).join("");
    expect(perUnit).toBe("𐐀");
    expect(foldForMatch("𐐀")).not.toBe(perUnit);
  });
});
