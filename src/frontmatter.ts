// v3.10.0-rc.53 — minimal YAML-frontmatter parse/stringify, replacing gray-matter.
//
// WHY: gray-matter@4.0.3 hard-binds js-yaml@3's `safeLoad`/`safeDump` at module load
// (`lib/engines.js`), so it CANNOT run on js-yaml@4 — and js-yaml@3 (<=4.1.1) carries the
// merge-key quadratic-DoS advisory GHSA-h67p-54hq-rp68 with no v3 fix. To remove the
// vulnerable js-yaml from the tree entirely we drop gray-matter and parse frontmatter
// ourselves on js-yaml@4 (whose `load`/`dump` are safe-by-default — the v3 `safeLoad`/
// `safeDump` semantics).
//
// The STRUCTURAL split + stringify logic below is a faithful PORT of gray-matter's own
// `index.js#parseMatter` + `lib/stringify.js` (delimiter handling, the `----` guard, the
// comment-only-emptiness check, the CR/LF strip after the closing fence, the UTF-8 BOM
// strip, the `newline()` join) — a dev-only differential test (since deleted; it imported
// gray-matter) confirmed byte-identical `{data,content}` + stringify on those STRUCTURAL
// paths over a broad corpus.
//
// NOT byte-identical on SCALAR RESOLUTION (v3.10.0-rc.54 audit FM-1/SC-2): the engine is
// js-yaml@4 (YAML 1.2 core), whereas gray-matter used js-yaml@3 (YAML 1.1). They resolve
// some scalar shapes DIFFERENTLY, so a `frontmatter_set` edit re-persists them per js-yaml@4:
//   • bare octal `0755` → 755 (v3: 493)    • leading-zero `0888` → 888 (v3: "0888")
//   • sexagesimal `12:34:56` / `1:30` → string (v3: 45296 / 90 ints)
//   • underscore ints `1_000` → "1_000" string (v3: 1000)
// js-yaml@4 (YAML 1.2) is the intended modern default; these cases are pinned in
// `tests/frontmatter.test.ts` as the documented contract, not silently re-asserted as
// "byte-identical". Common frontmatter (tags, ISO dates, plain strings/ints) is unaffected.
//
// Scope vs gray-matter: we support ONLY the default `---` delimiter (Obsidian's
// frontmatter). Language tags (`---yaml`), custom delimiters, excerpts, sections, and a
// non-mapping top-level document (coerced to `{}`, gray-matter parity) are out of scope.

import { dump, load } from "js-yaml";

export interface Frontmatter {
  /** Parsed YAML object ({} when absent / empty). */
  data: Record<string, unknown>;
  /** Post-frontmatter body — a verbatim suffix of the input. */
  content: string;
}

const OPEN = "---";
const CLOSE = "\n---";

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
  if (input === "") return { data: {}, content: "" };
  if (!input.startsWith(OPEN)) return { data: {}, content: input };
  // gray-matter guard: `----…` (a 4th dash right after the opening fence) is NOT
  // frontmatter — treat the whole input as body.
  if (input.charAt(OPEN.length) === "-") return { data: {}, content: input };

  const str = input.slice(OPEN.length);
  const len = str.length;
  let closeIndex = str.indexOf(CLOSE);
  if (closeIndex === -1) closeIndex = len;

  const matterBlock = str.slice(0, closeIndex);
  // Strip YAML comment-only lines for the emptiness decision (gray-matter parity).
  const block = matterBlock.replace(/^\s*#[^\n]+/gm, "").trim();
  let data: Record<string, unknown> = {};
  if (block !== "") {
    // v3.10.0-rc.54 (audit FM-SCALAR) — coerce a NON-MAPPING document (scalar / array /
    // null) to {} the way gray-matter did. Otherwise a frontmatter block that's a bare
    // scalar (`---\nhello\n---`) or a sequence (`---\n- a\n- b\n---`) would be cast to
    // Record and later spread char-indexed by frontmatter_set, writing corrupt YAML back.
    const loaded = load(matterBlock);
    data = loaded && typeof loaded === "object" && !Array.isArray(loaded) ? (loaded as Record<string, unknown>) : {};
  }

  let content: string;
  if (closeIndex === len) {
    content = "";
  } else {
    content = str.slice(closeIndex + CLOSE.length);
    if (content[0] === "\r") content = content.slice(1);
    if (content[0] === "\n") content = content.slice(1);
  }
  return { data, content };
}

/** `s` with a guaranteed trailing newline (gray-matter's `newline()`). */
function withNewline(s: string): string {
  return s.slice(-1) !== "\n" ? `${s}\n` : s;
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
  const dumped = dump(data).trim();
  const block = dumped !== "{}" ? withNewline(OPEN) + withNewline(dumped) + withNewline(OPEN) : "";
  return block + withNewline(content);
}
