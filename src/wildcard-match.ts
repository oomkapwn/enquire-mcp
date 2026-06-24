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
