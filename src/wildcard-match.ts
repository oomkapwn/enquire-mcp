/**
 * Non-backtracking wildcard matchers for DQL `LIKE` and path globs.
 *
 * v3.10.0-rc.71 (post-rc.66 re-sweep, ReDoS class — closes the rc.63/rc.68 siblings):
 * both DQL `LIKE` ({@link compileLike}) and path globs ({@link compileGlob}) used to
 * compile the pattern into a backtracking `RegExp`. A pattern with unbounded wildcards
 * SEPARATED BY LITERALS (`*a*a*…` for LIKE, `**a**a**…` for glob) — which neither the
 * rc.63 run-collapse nor the rc.68 adjacency-collapse touched — produces `^.*a.*a…$`,
 * the textbook catastrophic shape: against a NON-matching subject the engine tries
 * every partition of the subject across the wildcards (≈ C(len, k) backtracks),
 * measured at **110 s** for `.*a`×14 against a 41-char subject via the always-on,
 * bearer-reachable `obsidian_dataview_query`. The catastrophe scales with the SUBJECT
 * length, so a wildcard COUNT cap is NOT structurally safe (a long path / field value
 * blows up at a handful of wildcards, and a count-cap also rejects legitimate
 * patterns). Per the rc.39 lesson — *bound the SINK, don't chase shapes* — the durable
 * fix is to not use a backtracking regex at all: a tabular DP over (token, position)
 * that is **O(tokens × len) for every input**, so no pattern can exceed a linear
 * budget. The atomic-group emulation `(?=(.*))\1` was rejected (empirically: it stops
 * backtracking but CHANGES matching semantics — it can't yield chars back to a
 * required following literal).
 */

/** A single token of a compiled wildcard pattern. */
export type WildcardToken =
  | { lit: string } // literal run; matched verbatim (case-folded if `caseInsensitive`)
  | { kind: "any" } // zero+ of ANY char        (LIKE `*`, glob `**`)
  | { kind: "segstar" } // zero+ of NON-`/` chars   (glob `*`)
  | { kind: "question" }; // exactly one NON-`/` char (glob `?`)

export interface MatchOpts {
  /** Fold case before comparing literals (LIKE is case-insensitive; glob is not). */
  caseInsensitive?: boolean;
}

/**
 * Match `value` against a compiled token list in O(tokens × value.length) time with
 * NO backtracking. Bottom-up DP with two rolling rows: `next[vi]` = "can the token
 * suffix starting at the next token match `value[vi..]`"; `cur[vi]` = the same for the
 * current token. Iterating `vi` descending lets the `any`/`segstar` self-recurrence
 * (`cur[vi+1]`) read an already-filled cell — that recurrence is what makes a wildcard
 * linear instead of a regex backtrack.
 *
 * v3.10.0-rc.75 — CASE-FOLD CONTRACT (accepted divergence from the pre-rc.71 regex; the
 * post-rc.74 re-sweep's one LOW finding): when `caseInsensitive` is set (DQL `LIKE` only),
 * folding is `String.prototype.toLowerCase()`, NOT the ECMAScript `RegExp` `i`+`u` canonical
 * case-folding the pre-rc.71 `^…$/iu` regex used. These agree for ASCII + ordinary accented
 * letters but DIVERGE for ~22 exotic BMP codepoints whose `i`-flag canonical fold differs from
 * `toLowerCase` — e.g. micro-sign `µ` (U+00B5) vs Greek mu `Μ`, long-s `ſ` (U+017F) vs `S`,
 * final-sigma `ς` (U+03C2) vs `Σ`, the Greek symbol variants `ϐϑϕϖϰϱϵ`, the U+1C80–U+1C88
 * Cyrillic small-caps block, `ẛ` (U+1E9B), `ι` (U+1FBE). For these, `field LIKE "µ"` no longer
 * matches a value of `"Μ"` (direction is UNDER-match — fewer rows, never over-exposure). This is
 * a deliberate, accepted trade-off: those characters are vanishingly rare in real vaults, and a
 * custom Unicode-canonical folder is its own bug surface; it is pinned by the case-fold-contract
 * test in `tests/wildcard-match.test.ts` (which also proves the divergence is real via a
 * NEGATIVE control against the old regex). The glob path ({@link compileGlob}) is case-SENSITIVE
 * and never folds, so the privacy filter is byte-faithful to the pre-rc.71 behavior.
 */
export function matchWildcardTokens(tokens: readonly WildcardToken[], value: string, opts?: MatchOpts): boolean {
  const ci = opts?.caseInsensitive === true;
  const subject = ci ? value.toLowerCase() : value;
  const m = subject.length;
  const n = tokens.length;
  // next = DP row for the token suffix AFTER the current token. Seed for the empty
  // suffix: it matches only the empty value suffix (vi === m).
  let next = new Array<boolean>(m + 1).fill(false);
  next[m] = true;
  let cur = new Array<boolean>(m + 1).fill(false);
  for (let ti = n - 1; ti >= 0; ti--) {
    const tok = tokens[ti] as WildcardToken;
    if ("lit" in tok) {
      const lit = ci ? tok.lit.toLowerCase() : tok.lit;
      const L = lit.length;
      for (let vi = m; vi >= 0; vi--) {
        cur[vi] = vi + L <= m && subject.startsWith(lit, vi) && (next[vi + L] as boolean);
      }
    } else if (tok.kind === "any") {
      for (let vi = m; vi >= 0; vi--) {
        cur[vi] = (next[vi] as boolean) || (vi < m && (cur[vi + 1] as boolean));
      }
    } else if (tok.kind === "segstar") {
      for (let vi = m; vi >= 0; vi--) {
        cur[vi] = (next[vi] as boolean) || (vi < m && subject[vi] !== "/" && (cur[vi + 1] as boolean));
      }
    } else {
      // question: exactly one non-slash char
      for (let vi = m; vi >= 0; vi--) {
        cur[vi] = vi < m && subject[vi] !== "/" && (next[vi + 1] as boolean);
      }
    }
    // swap rows (cur becomes next for ti-1; reuse the old next buffer as the new cur)
    const tmp = next;
    next = cur;
    cur = tmp;
  }
  return next[0] as boolean;
}

/**
 * Tokenize a DQL `LIKE` pattern. `*` is the only wildcard (any run of chars);
 * `\x` escapes the next char to a literal (so `\*` is a literal asterisk, `\\` a
 * literal backslash); a trailing `\` is a literal backslash. Consecutive `*` coalesce
 * into one `any` token (semantically identical, keeps the token list small). The
 * escape semantics are byte-for-byte the pre-rc.71 `likeToRegex` rules — only
 * the final consumer changed (a linear matcher instead of `new RegExp`).
 */
export function compileLikeTokens(pattern: string): WildcardToken[] {
  const tokens: WildcardToken[] = [];
  let cur = "";
  const flushLit = (): void => {
    if (cur.length > 0) {
      tokens.push({ lit: cur });
      cur = "";
    }
  };
  const pushAny = (): void => {
    const last = tokens[tokens.length - 1];
    if (!(last !== undefined && "kind" in last && last.kind === "any")) tokens.push({ kind: "any" });
  };
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\") {
      if (i + 1 < pattern.length) {
        cur += pattern[i + 1] as string; // escaped: next char is a literal
        i++;
      } else {
        cur += "\\"; // trailing backslash → literal backslash
      }
      continue;
    }
    if (ch === "*") {
      flushLit();
      pushAny();
      continue;
    }
    cur += ch ?? "";
  }
  flushLit();
  return tokens;
}

/**
 * Tokenize a minimal glob into wildcard tokens, mirroring the pre-rc.71
 * `globToRegex` grammar exactly (so matching semantics are preserved):
 *   `**` — globstar, any run of chars INCLUDING `/`; consumes the rest of the `*`
 *          run and ONE trailing `/` (so `a/**​/b` matches `a/b`) → `any`
 *   `*`  — any run of NON-`/` chars → `segstar`
 *   `?`  — exactly one NON-`/` char → `question`
 *   else — literal char (no regex escaping needed — the matcher compares chars directly)
 * No bracket sets / `!` / `{a,b}`. The match is full-path anchored (the DP requires the
 * whole token list to consume the whole path), matching the old `^…$` regex.
 */
export function compileGlobTokens(glob: string): WildcardToken[] {
  const tokens: WildcardToken[] = [];
  let cur = "";
  const flushLit = (): void => {
    if (cur.length > 0) {
      tokens.push({ lit: cur });
      cur = "";
    }
  };
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        // globstar: any chars incl `/`
        flushLit();
        tokens.push({ kind: "any" });
        i += 2;
        while (glob[i] === "*") i += 1; // consume the rest of the run
        if (glob[i] === "/") i += 1; // eat ONE trailing slash so `a/**/b` matches `a/b`
        continue;
      }
      flushLit();
      tokens.push({ kind: "segstar" });
      i += 1;
      continue;
    }
    if (ch === "?") {
      flushLit();
      tokens.push({ kind: "question" });
      i += 1;
      continue;
    }
    cur += ch ?? "";
    i += 1;
  }
  flushLit();
  return tokens;
}

// ── Linear (non-backtracking) trailing/leading run strips ──────────────────────
//
// v3.11.0-rc.14 (CodeQL js/polynomial-redos #13, HIGH) — these REPLACE the
// `s.replace(/<class>+$/, "")` idiom that was duplicated across the folder-prefix
// builders (fts5 / embed-db / tools.search ×2 / tools.write ×2), the periodic-notes
// folder normalizer, and the trailing-newline/ATX-hash strippers. `/<class>+$/` is a
// POLYNOMIAL-time regex: on `<class>×n + <one non-class char>` (e.g. `"/"×n + "x"`)
// the anchored `+$` retries from EVERY run position → O(n²). Empirically a 4 MB
// `folder` arg (bearer-reachable on serve-http) hung V8 for minutes. The prior
// "$ anchor makes it O(n)" code comment was WRONG — it only held for the all-class
// input, never for class-then-other. These loops are O(n) for ANY input.
const SLASH = 47; // '/'
const NEWLINE = 10; // '\n'
const HASH = 35; // '#'
const CR = 13; // '\r'
const LS = 0x2028; // LINE SEPARATOR
const PS = 0x2029; // PARAGRAPH SEPARATOR

/** Strip the trailing run of chars satisfying `pred` — O(n), no backtracking. */
export function stripTrailingRun(s: string, pred: (code: number) => boolean): string {
  let end = s.length;
  while (end > 0 && pred(s.charCodeAt(end - 1))) end--;
  return s.slice(0, end);
}
/** Strip the leading run of chars satisfying `pred` — O(n), no backtracking. */
export function stripLeadingRun(s: string, pred: (code: number) => boolean): string {
  let start = 0;
  while (start < s.length && pred(s.charCodeAt(start))) start++;
  return s.slice(start);
}
const isSlash = (c: number): boolean => c === SLASH;
/** `s.replace(/\/+$/, "")` — linear. */
export function stripTrailingSlashes(s: string): string {
  return stripTrailingRun(s, isSlash);
}
/** `s.replace(/^\/+|\/+$/g, "")` — linear (leading AND trailing slash runs). */
export function stripSurroundingSlashes(s: string): string {
  return stripTrailingRun(stripLeadingRun(s, isSlash), isSlash);
}
/** `s.replace(/\n+$/, "")` — linear. */
export function stripTrailingNewlines(s: string): string {
  return stripTrailingRun(s, (c) => c === NEWLINE);
}
/** `s.replace(/#+$/, "")` — linear (ATX heading closing hashes). */
export function stripTrailingHashes(s: string): string {
  return stripTrailingRun(s, (c) => c === HASH);
}
/**
 * Strip the trailing run of JS line-terminator chars (`\n` `\r` U+2028 U+2029) — linear.
 *
 * v3.11.0-rc.17 (rc.16 re-audit, CRLF heading-drop regression) — a line obtained
 * from `body.split("\n")` retains a trailing `\r` on a CRLF (Windows) note, and
 * ` `/` ` are never split on at all. The rc.16 heading capture
 * `/^(#{1,6})\s+(.+)$/` then MATCHES NOTHING, because JS `.` (no `s` flag) does
 * not match a line terminator and `$` (no `m` flag) only matches true end-of-input
 * — so the trailing `\r` makes `(.+)$` fail and the heading is silently dropped.
 * The pre-rc.16 combined form absorbed the `\r` via its trailing `\s*`. Strip the
 * terminator (linearly — a `replace(/[\r\n…]+$/,"")` would itself be the
 * polynomial-ReDoS class the static guard polices) before the heading match.
 */
export function stripTrailingLineEnds(s: string): string {
  return stripTrailingRun(s, (c) => c === NEWLINE || c === CR || c === LS || c === PS);
}

/**
 * Split text into lines on EVERY terminator enquire treats as one — LF (`\n`),
 * CRLF (`\r\n`), bare CR (`\r`, classic-Mac), U+2028 LINE SEPARATOR, U+2029
 * PARAGRAPH SEPARATOR — i.e. the SAME set {@link stripTrailingLineEnds} strips
 * (rc.17/rc.19). A raw `text.split("\n")` splits ONLY on LF, so the strip and the
 * split disagreed: a note saved with bare CR, or with U+2028/U+2029 as the line
 * SEPARATOR (not just a trailing terminator), collapsed to one "line".
 *
 * That inconsistency had two consequences the external rc.21 audits surfaced:
 *   • read-path (LOW): `extractHeadings`, `getOpenQuestions`, snippet line-numbers
 *     and FTS breadcrumbs merged or mis-counted lines on such notes;
 *   • write-path (MEDIUM, data corruption): the per-line code-fence detection in
 *     `rewriteOutsideCodeFences` / `replaceStringOutsideCodeFences` never fired, so
 *     a wikilink INSIDE a fenced code block was rewritten on rename/replace.
 *
 * For an LF-only note this is byte-identical to `split("\n")` (no other terminator
 * present), so the common path is unchanged. NEL (U+0085) / VT (U+000B) / FF
 * (U+000C) are deliberately NOT split on — neither `stripTrailingLineEnds` nor
 * CommonMark/Obsidian treat them as line breaks, so splitting on them would diverge
 * from how the note renders. v3.11.0-rc.23 — the sibling of the rc.17/rc.19 CRLF fix.
 */
const LINE_SPLIT_RE = /\r\n|[\n\r\u2028\u2029]/;
export function splitLines(text: string): string[] {
  return text.split(LINE_SPLIT_RE);
}

/**
 * Split `text` into lines AND the exact terminator that followed each line.
 * `lines[i]` is the line text (terminator-stripped, identical to {@link splitLines});
 * `ends[i]` is the terminator that followed it (`""` for the final line when the text
 * has no trailing terminator). Rejoin faithfully with
 * `lines.map((l, i) => l + ends[i]).join("")` \u2014 this PRESERVES CRLF / CR / U+2028 /
 * U+2029 line endings on every line, including untouched ones.
 *
 * v3.11.4-rc.2 \u2014 the write-path rewriters (`rewriteOutsideCodeFences` /
 * `replaceStringOutsideCodeFences`) split with the terminator-aware {@link splitLines}
 * (rc.23) but rejoined with a hard-coded `"\n"`, silently flattening a whole CRLF
 * (Windows) note to LF on any `replace_in_notes` / `rename_note` edit. Splitting on a
 * CAPTURING terminator group keeps each line's own ending so the rejoin is byte-faithful.
 */
export function splitLinesWithEnds(text: string): { lines: string[]; ends: string[] } {
  const parts = text.split(/(\r\n|[\n\r\u2028\u2029])/);
  const lines: string[] = [];
  const ends: string[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    lines.push(parts[i] ?? "");
    ends.push(parts[i + 1] ?? "");
  }
  return { lines, ends };
}

/**
 * Count the line BREAKS in `text` per the {@link splitLines} terminator set
 * (LF / CRLF / CR / U+2028 / U+2029) \u2014 i.e. `splitLines(text).length - 1`.
 *
 * v3.11.0-rc.25 (post-rc.24 pre-promotion re-sweep) \u2014 the COUNTING sibling of the rc.23
 * split class. Line-NUMBER math that used `(text.match(/\n/g) ?? []).length` counts only LF,
 * so on a bare-CR / U+2028 / U+2029 note the reported `line_start`/`line_end` (chatThreadAppend)
 * and breadcrumb line numbers (fts5) drifted \u2014 the same blindness `splitLines` fixed for the
 * splitting form. The rc.23 inventory invariant only patrolled `.split("\n")`; it now also
 * flags `.match(/\n/g)`, and these counters route through here.
 */
export function countLineBreaks(text: string): number {
  return splitLines(text).length - 1;
}

/**
 * Case-fold a string for case-INSENSITIVE substring matching by lower-casing each
 * Unicode CODE POINT independently (context-free). Use this for BOTH the needle AND
 * the haystack of any case-insensitive search — NEVER whole-string
 * `String.prototype.toLowerCase()` on one side and a per-code-point fold on the other.
 *
 * Whole-string `.toLowerCase()` applies CONTEXT-SENSITIVE rules — most notably Greek
 * word-final sigma: `"ΟΔΟΣ".toLowerCase()` → `"οδος"` (final `ς`), whereas a
 * per-code-point fold yields `"οδοσ"` (medial `σ`, no context). So a whole-string-folded
 * needle (`"οδος"`) silently FAILS to match a per-code-point-folded haystack (`"…οδοσ…"`)
 * → a SILENT miss. That is exactly what bit `replace_in_notes` (the needle was
 * `search.toLowerCase()` while the line was folded per code unit → a case-insensitive
 * Greek replace ending in a capital Σ reported 0 replacements) and is the same hazard the
 * read-path `foldWithMap` (search.ts) avoids by folding the haystack per code point.
 *
 * v3.11.1-rc.1 (v3.11.0 STABLE external audit — anti-anchoring finding) — the fold sibling
 * of the rc.18/rc.21/rc.46 case-fold-asymmetry class. Iterates by code point (`for..of`),
 * so astral case-folding chars (e.g. Deseret `𐐀`→`𐐨`) fold correctly too — a per-UTF-16-unit
 * `charAt` loop would split the surrogate pair and leave them UNfolded, re-introducing the
 * very asymmetry on the astral plane.
 */
export function foldForMatch(s: string): string {
  let out = "";
  for (const ch of s) out += ch.toLowerCase();
  return out;
}
