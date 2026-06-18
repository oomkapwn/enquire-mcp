// v3.10.0-rc.53 — minimal YAML-frontmatter parse/stringify, replacing gray-matter.
//
// WHY: gray-matter@4.0.3 hard-binds js-yaml@3's `safeLoad`/`safeDump` at module load
// (`lib/engines.js`), so it CANNOT run on js-yaml@4 — and js-yaml@3 (<=4.1.1) carries the
// merge-key quadratic-DoS advisory GHSA-h67p-54hq-rp68 with no v3 fix. To remove the
// vulnerable js-yaml from the tree entirely we drop gray-matter and parse frontmatter
// ourselves on js-yaml@4 (whose `load`/`dump` are safe-by-default — the v3 `safeLoad`/
// `safeDump` semantics).
//
// The split + stringify logic below is a faithful PORT of gray-matter's own
// `index.js#parseMatter` + `lib/stringify.js` (delimiter handling, the `----` guard, the
// comment-only-emptiness check, the CR/LF strip after the closing fence, the `newline()`
// join), with only the YAML engine swapped. A differential test
// (`tests/frontmatter.test.ts`) validated byte-identical `{data,content}` + stringify
// output against gray-matter over a broad corpus before gray-matter was removed.
//
// Scope vs gray-matter: we support ONLY the default `---` delimiter (Obsidian's
// frontmatter). Language tags (`---yaml`), custom delimiters, excerpts, and sections are
// not supported — Obsidian never produces them.

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
    data = (load(matterBlock) ?? {}) as Record<string, unknown>;
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
