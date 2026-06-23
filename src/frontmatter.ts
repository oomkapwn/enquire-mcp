// v3.10.0-rc.53 — minimal YAML-frontmatter parse/stringify, replacing gray-matter.
// v3.11.0-rc.6 — engine migrated js-yaml@4 → @5 (see DATES / MERGE KEYS / EMPTY INPUT below).
//
// WHY (rc.53): gray-matter@4.0.3 hard-binds js-yaml@3's `safeLoad`/`safeDump` at module load
// (`lib/engines.js`), so it could not run on a modern js-yaml — and js-yaml@3 (<=4.1.1) carried
// the merge-key quadratic-DoS advisory GHSA-h67p-54hq-rp68 with no v3 fix. To remove the
// vulnerable js-yaml from the tree we dropped gray-matter and parse frontmatter ourselves; the
// engine is now js-yaml@5 (`load`/`dump` safe-by-default, YAML 1.2 core — the v3 `safeLoad`/
// `safeDump` semantics).
//
// The STRUCTURAL split + stringify logic below is a faithful PORT of gray-matter's own
// `index.js#parseMatter` + `lib/stringify.js` (delimiter handling, the `----` guard, the
// comment-only-emptiness check, the CR/LF strip after the closing fence, the UTF-8 BOM
// strip, the `newline()` join) — a dev-only differential test (since deleted; it imported
// gray-matter) confirmed byte-identical `{data,content}` + stringify on those STRUCTURAL
// paths over a broad corpus.
//
// NOT byte-identical on SCALAR RESOLUTION (v3.10.0-rc.54 audit FM-1/SC-2; re-verified UNCHANGED
// on js-yaml@5 in rc.6): the engine is js-yaml@5 (YAML 1.2 core), whereas gray-matter used
// js-yaml@3 (YAML 1.1). They resolve some scalar shapes DIFFERENTLY from the old gray-matter
// behavior, so a `frontmatter_set` edit re-persists them per YAML 1.2 (identical on @4 and @5):
//   • bare octal `0755` → 755 (v3: 493)    • leading-zero `0888` → 888 (v3: "0888")
//   • sexagesimal `12:34:56` / `1:30` → string (v3: 45296 / 90 ints)
//   • underscore ints `1_000` → "1_000" string (v3: 1000)
// These are pinned in `tests/frontmatter.test.ts` as the documented contract, not silently
// re-asserted as "byte-identical". Common frontmatter (tags, plain strings/ints) is unaffected.
//
// DATES — js-yaml@5 NO LONGER coerces to `Date` (v3.11.0-rc.6): a bare `created: 2026-01-15` OR an
// explicit `2026-01-15T00:00:00Z` now loads as a plain STRING (js-yaml@5 dropped the implicit
// YAML-1.1 `timestamp` type from its default schema). This ROOT-FIXES the rc.58
// FM-DATE-SILENT-MUTATION bug: under js-yaml@4 a bare date loaded as a midnight `Date` and a naive
// `dump` re-serialized it as `2026-01-15T00:00:00.000Z`, silently appending a time on any unrelated
// `frontmatter_set`. On @5 the date string round-trips FAITHFULLY — it re-emits as a quoted
// `'2026-01-15'` (same string value, no time appended, no information loss), and the rc.66
// midnight/timestamp COLLISION cannot occur (the two distinct strings stay distinct). The
// `normalizeDateOnly` helper below is therefore now DEFENSIVE-ONLY: it still demotes a midnight-UTC
// `Date` to `YYYY-MM-DD`, but `parseFrontmatter` no longer yields `Date`s, so it fires only if a
// CALLER passes a `Date` object directly (pinned by a direct-Date unit test in `frontmatter.test.ts`).
//
// MERGE KEYS (`<<`) — js-yaml@5 does NOT resolve them (YAML 1.2 core has no merge key); a literal
// `<<` is kept as a plain mapping key. This is exactly WHY GHSA-h67p-54hq-rp68 (the merge-key
// quadratic DoS) is gone at the ROOT in v5, not merely version-bumped. No enquire feature relies on
// merge-key resolution, so dropping it is a pure security gain.
//
// EMPTY INPUT — js-yaml@5 `load("")` / whitespace-only THROWS ("expected a document") where v4
// returned `undefined`. `parseFrontmatter` never calls `load` on an empty/whitespace/comment-only
// block (the `block !== ""` guard precedes the call); `bases.ts parseBase` guards an empty `.base`
// body explicitly.
//
// Scope vs gray-matter: we support ONLY the default `---` delimiter (Obsidian's
// frontmatter). Language tags (`---yaml`), custom delimiters, excerpts, sections, and a
// non-mapping top-level document (coerced to `{}`, gray-matter parity) are out of scope.
//
// TAB-INDENTED YAML (v3.10.0-rc.56 audit FM-3, verdict: NOT a regression): js-yaml@5
// throws "tab characters must not be used in indentation" — but the YAML spec FORBIDS
// tabs for indentation and js-yaml@3/@4 enforced this identically, so this is
// not a behavior change from the migration. On a throw, callers (`parseNote`) fall back
// to treating the whole file as body — the frontmatter TEXT is still indexed/searchable
// (no data loss), it just isn't parsed into structured `data`. Pinned in tests.

import { dump, load } from "js-yaml";

export interface Frontmatter {
  /** Parsed YAML object ({} when absent / empty). */
  data: Record<string, unknown>;
  /** Post-frontmatter body — a verbatim suffix of the input. */
  content: string;
  /**
   * v3.10.0-rc.64 (round-3 audit) — true when the frontmatter block was present
   * and NON-EMPTY but its top-level YAML document is NOT a mapping (a bare scalar
   * `---\nhello\n---`, a sequence `---\n- a\n---`, or a non-plain object like a
   * `Date`), so {@link parseFrontmatter} coerced `data` to `{}` to avoid
   * spreading corrupt data. Callers that WRITE frontmatter back (`frontmatter_set`)
   * must refuse fail-closed on this signal — otherwise re-serializing `data` would
   * REPLACE the original scalar/sequence block with a fresh mapping, silently
   * destroying it. `false` for absent / empty / comment-only / valid-mapping
   * frontmatter (the legitimate add/edit paths).
   */
  coerced: boolean;
}

const OPEN = "---";
const CLOSE = "\n---";

/**
 * True only for a PLAIN object (a YAML mapping) — rejects `null`, arrays, and
 * built-ins like `Date`/`RegExp` that js-yaml resolves from a bare scalar
 * (e.g. `---\n2026-01-01\n---` → a `Date`). A non-mapping top-level document
 * must coerce to `{}`, never be returned as `data` (which `frontmatter_set`
 * would then spread). js-yaml emits maps as `Object.prototype`-rooted objects.
 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Parse YAML frontmatter from a markdown string (faithful gray-matter port).
 * Throws on malformed YAML — callers that want a fallback wrap in try/catch (the
 * same contract gray-matter had).
 *
 * @param input - Raw note text.
 * @returns `{ data, content }` — `content` is a verbatim suffix of `input`.
 */
export function parseFrontmatter(input: string): Frontmatter {
  // gray-matter parity: strip a single leading UTF-8 BOM before fence detection
  // (its toFile() ran strip-bom-string). `content` stays a suffix of the BOM-stripped
  // input — still a suffix of the original (the BOM is at offset 0), so parser.ts's
  // `source.lastIndexOf(body)` for bodyStartLine is unaffected.
  if (input.charCodeAt(0) === 0xfeff) input = input.slice(1);
  if (input === "") return { data: {}, content: "", coerced: false };
  if (!input.startsWith(OPEN)) return { data: {}, content: input, coerced: false };
  // gray-matter guard: `----…` (a 4th dash right after the opening fence) is NOT
  // frontmatter — treat the whole input as body.
  if (input.charAt(OPEN.length) === "-") return { data: {}, content: input, coerced: false };

  const str = input.slice(OPEN.length);
  const len = str.length;
  let closeIndex = str.indexOf(CLOSE);
  if (closeIndex === -1) closeIndex = len;

  const matterBlock = str.slice(0, closeIndex);
  // Strip YAML comment-only lines for the emptiness decision (gray-matter parity).
  const block = matterBlock.replace(/^\s*#[^\n]+/gm, "").trim();
  let data: Record<string, unknown> = {};
  // v3.10.0-rc.64 (round-3 audit) — track whether a non-empty block was coerced
  // away from a non-mapping document (see the `coerced` field doc on Frontmatter).
  let coerced = false;
  if (block !== "") {
    // v3.10.0-rc.54 (audit FM-SCALAR) — coerce a NON-MAPPING document (scalar / array /
    // null) to {} the way gray-matter did. Otherwise a frontmatter block that's a bare
    // scalar (`---\nhello\n---`) or a sequence (`---\n- a\n- b\n---`) would be cast to
    // Record and later spread char-indexed by frontmatter_set, writing corrupt YAML back.
    // v3.10.0-rc.55 (FM-SCALAR-DATE) — the rc.54 `typeof === "object" && !Array` check let
    // a bare top-level Date (`---\n2026-01-01\n---`, which js-yaml resolves to a `Date`
    // instance) slip through as `data`; require a PLAIN object (a real mapping) instead.
    const loaded = load(matterBlock);
    if (isPlainObject(loaded)) {
      data = loaded;
    } else {
      data = {};
      coerced = true; // a non-empty block that is NOT a mapping → would be lost on write-back
    }
  }

  let content: string;
  if (closeIndex === len) {
    content = "";
  } else {
    content = str.slice(closeIndex + CLOSE.length);
    if (content[0] === "\r") content = content.slice(1);
    if (content[0] === "\n") content = content.slice(1);
  }
  return { data, content, coerced };
}

/** `s` with a guaranteed trailing newline (gray-matter's `newline()`). */
function withNewline(s: string): string {
  return s.slice(-1) !== "\n" ? `${s}\n` : s;
}

/**
 * v3.10.0-rc.58 (FM-DATE-SILENT-MUTATION) — deep-clone `value`, converting any `Date` with
 * NO time-of-day component (exactly midnight UTC) to a `YYYY-MM-DD` string so `dump` emits a
 * date-only scalar instead of a full ISO timestamp. A genuine timestamp (any non-zero
 * time-of-day) is left as a `Date` (dump → full ISO). Recurses through arrays + plain objects
 * (the rebuild also preserves a literal `__proto__` key via defineProperty — rc.61); all other
 * values pass through untouched. Pure (no input mutation).
 *
 * v3.11.0-rc.6: under js-yaml@5 `parseFrontmatter` yields date STRINGS, not `Date`s, so the Date
 * branch is now DEFENSIVE-ONLY — it fires only if a caller passes a `Date` object directly (the
 * deep-walk + `__proto__` preservation still run on every write). Pinned by a direct-Date unit.
 */
function normalizeDateOnly(value: unknown): unknown {
  if (value instanceof Date) {
    const midnightUtc =
      value.getUTCHours() === 0 &&
      value.getUTCMinutes() === 0 &&
      value.getUTCSeconds() === 0 &&
      value.getUTCMilliseconds() === 0;
    return midnightUtc && !Number.isNaN(value.getTime()) ? value.toISOString().slice(0, 10) : value;
  }
  if (Array.isArray(value)) return value.map(normalizeDateOnly);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      // v3.10.0-rc.61 (FM-PROTO-KEY-DROP) — `out[k] = …` would silently DROP a literal
      // `__proto__` frontmatter key (it hits the prototype-setter accessor, not an own
      // property) — data loss vs the direct dump. defineProperty sets a real own enumerable
      // data property for every key, so `__proto__` (and any key) is preserved + re-dumped.
      Object.defineProperty(out, k, {
        value: normalizeDateOnly(v),
        enumerable: true,
        writable: true,
        configurable: true
      });
    }
    return out;
  }
  return value;
}

/**
 * Serialize `data` as a YAML frontmatter block prepended to `content` (faithful
 * gray-matter `stringify` port). Empty `{}` → `content` verbatim (with a trailing
 * newline, matching gray-matter).
 *
 * @param content - Body (no leading `---` delimiter).
 * @param data - Frontmatter object.
 */
export function stringifyFrontmatter(content: string, data: Record<string, unknown>): string {
  // rc.58 (FM-DATE-SILENT-MUTATION) — render bare/date-only Dates as YYYY-MM-DD, not full ISO.
  const dumped = dump(normalizeDateOnly(data) as Record<string, unknown>).trim();
  const block = dumped !== "{}" ? withNewline(OPEN) + withNewline(dumped) + withNewline(OPEN) : "";
  return block + withNewline(content);
}
