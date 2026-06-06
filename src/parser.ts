import matter from "gray-matter";

/**
 * A parsed Obsidian wikilink (`[[Target]]`, `[[Target#section]]`,
 * `[[Target^block]]`, `[[Target|alias]]`, or any combination).
 *
 * Fields are populated when the corresponding fragment is present in the
 * source; otherwise omitted (not `undefined`-valued — the property is
 * absent so callers can use `"section" in link` without ambiguity).
 */
export interface Wikilink {
  /** Original payload between the `[[` `]]` delimiters (everything before
   *  any alias `|`). Useful for round-tripping the link unchanged. */
  raw: string;
  /** Note target (basename or relative path, no `.md` suffix). For
   *  `[[Auth/oauth#setup|OAuth]]` this is `"Auth/oauth"`. */
  target: string;
  /** Heading anchor, if any (the text after `#`). */
  section?: string;
  /** Block reference, if any (the text after `^`). */
  block?: string;
  /** Display alias, if any (the text after `|`). */
  alias?: string;
}

/** A parsed Obsidian embed (`![[Target]]`). Same shape as {@link Wikilink};
 *  the `!` prefix is the only syntactic distinction. */
export type Embed = Wikilink;

/**
 * A parsed Obsidian note: frontmatter + body + the structural extracts
 * we feed retrieval over (wikilinks, embeds, tags).
 *
 * Code fences and inline code are stripped before link / tag extraction
 * so example markdown inside ``` blocks doesn't pollute the structural
 * index. The `body` field keeps the original (post-frontmatter) content
 * so callers can render verbatim.
 */
export interface ParsedNote {
  /** Frontmatter object (empty when no YAML block, or when YAML is malformed). */
  frontmatter: Record<string, unknown>;
  /** Post-frontmatter body — verbatim, including code fences. */
  body: string;
  /** 1-based line number in the ORIGINAL source where `body` begins (= the count
   *  of frontmatter + delimiter lines + 1; 1 when there's no frontmatter). Lets
   *  consumers that chunk `body` (the embedding pipeline) report FILE-absolute
   *  line numbers that match the FTS5 index, which chunks the full content.
   *  v3.10.0-rc.17 (audit M1). */
  bodyStartLine: number;
  /** All `[[wikilinks]]` found in the body (after stripping code spans). */
  wikilinks: Wikilink[];
  /** All `![[embeds]]` found in the body (after stripping code spans). */
  embeds: Embed[];
  /** Union of frontmatter tags + inline `#tags` (deduped, normalized to
   *  drop leading `#`). Order is insertion order from frontmatter first. */
  tags: string[];
}

/**
 * Parse an Obsidian markdown source string. Splits frontmatter (via
 * `gray-matter`) from body, then extracts wikilinks, embeds, and tags
 * from a code-stripped view of the body. Malformed YAML falls back to
 * treating the whole input as body (no throw).
 *
 * @param source - Raw note text (UTF-8).
 * @returns Parsed structure ready for indexing or rendering.
 * @example
 * ```ts
 * const parsed = parseNote("---\ntags: [idea]\n---\nSee [[Other]].");
 * parsed.frontmatter; // { tags: ["idea"] }
 * parsed.wikilinks;   // [{ raw: "Other", target: "Other" }]
 * parsed.tags;        // ["idea"]
 * ```
 */
export function parseNote(source: string): ParsedNote {
  let frontmatter: Record<string, unknown> = {};
  let body = source;
  try {
    const parsed = matter(source);
    frontmatter = (parsed.data ?? {}) as Record<string, unknown>;
    body = parsed.content;
  } catch {
    // Malformed YAML — fall back to treating the whole file as body.
    body = source;
  }
  const sanitized = stripCodeAndInline(body);
  // v3.10.0-rc.17 (audit M1) — the 1-based file line where `body` starts, so
  // body-chunking consumers (the embedding pipeline) can report FILE-absolute
  // line numbers that match the content-chunking FTS5 index.
  // v3.10.0-rc.24 (audit L) — `body` is the SUFFIX of `source` (everything after
  // the frontmatter), so use `lastIndexOf`: plain `indexOf` would false-match a
  // degenerate note whose entire body text also appears verbatim earlier inside
  // a frontmatter line (e.g. `---\nx: hi\n---\nhi`), reporting too-early a line.
  // 1 when there's no frontmatter, an empty body, or the defensive not-found case.
  const bodyIdx = body.length > 0 ? source.lastIndexOf(body) : -1;
  const bodyStartLine = bodyIdx > 0 ? source.slice(0, bodyIdx).split("\n").length : 1;
  return {
    frontmatter,
    body,
    bodyStartLine,
    wikilinks: extractWikilinks(sanitized),
    embeds: extractEmbeds(sanitized),
    tags: collectTags(frontmatter, sanitized)
  };
}

const WIKILINK_RE = /(?<!!)\[\[([^\]\n]+?)\]\]/g;
const EMBED_RE = /!\[\[([^\]\n]+?)\]\]/g;

/**
 * Extract all `[[wikilinks]]` from a markdown string. Excludes `![[embeds]]`
 * via a negative lookbehind on `!`. Caller is responsible for stripping
 * code fences / inline code first if recall over example markdown matters
 * (use the same pipeline as {@link parseNote}).
 *
 * @param text - Markdown source (already stripped of code spans, ideally).
 * @returns Wikilinks in source order. Empty array if none found.
 */
export function extractWikilinks(text: string): Wikilink[] {
  return matchLinks(text, WIKILINK_RE);
}

/**
 * Extract all `![[embeds]]` from a markdown string. Same payload syntax as
 * wikilinks; the `!` prefix is what distinguishes embed from link.
 *
 * @param text - Markdown source.
 * @returns Embeds in source order. Empty array if none found.
 */
export function extractEmbeds(text: string): Embed[] {
  return matchLinks(text, EMBED_RE);
}

function matchLinks(text: string, re: RegExp): Wikilink[] {
  const out: Wikilink[] = [];
  for (const m of text.matchAll(re)) {
    const raw = m[1];
    if (raw === undefined) continue;
    let alias: string | undefined;
    let rest = raw;
    const pipe = rest.indexOf("|");
    if (pipe !== -1) {
      alias = rest.slice(pipe + 1).trim();
      rest = rest.slice(0, pipe);
    }
    let block: string | undefined;
    const blockIdx = rest.indexOf("^");
    if (blockIdx !== -1) {
      block = rest.slice(blockIdx + 1).trim();
      rest = rest.slice(0, blockIdx);
    }
    let section: string | undefined;
    const hashIdx = rest.indexOf("#");
    if (hashIdx !== -1) {
      section = rest.slice(hashIdx + 1).trim();
      rest = rest.slice(0, hashIdx);
    }
    out.push({
      raw,
      target: rest.trim(),
      ...(section !== undefined ? { section } : {}),
      ...(block !== undefined ? { block } : {}),
      ...(alias !== undefined ? { alias } : {})
    });
  }
  return out;
}

const TAG_RE = /(?:^|[\s([{>])#([\p{L}][\p{L}\p{N}_/-]*)/gu;

/**
 * Extract `#hashtag` style inline tags from markdown body text. Tags must
 * be preceded by whitespace, bracket, or BOL — `#1` inside a markdown
 * heading is NOT a tag. Tag chars: Unicode letters/digits, `_`, `/`, `-`.
 *
 * @param text - Markdown body (caller should have stripped code spans).
 * @returns Unique tag names (without the leading `#`), in first-occurrence order.
 */
export function extractInlineTags(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(TAG_RE)) {
    if (m[1] !== undefined) found.add(m[1]);
  }
  return [...found];
}

/**
 * Normalize tags from a frontmatter object. Accepts both the
 * `tags: [a, b]` array form and the `tag: "a, b c"` string form
 * (comma-or-whitespace separated). Leading `#` characters are stripped.
 *
 * @param fm - Frontmatter object as returned by {@link parseNote}.
 * @returns Normalized tag list. Empty array when no `tags` / `tag` key.
 */
export function extractFrontmatterTags(fm: Record<string, unknown>): string[] {
  const raw = fm.tags ?? fm.tag;
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.filter((t): t is string => typeof t === "string").map(normalizeTag);
  }
  if (typeof raw === "string") {
    return raw
      .split(/[,\s]+/)
      .filter(Boolean)
      .map(normalizeTag);
  }
  return [];
}

function normalizeTag(t: string): string {
  return t.replace(/^#+/, "");
}

function collectTags(fm: Record<string, unknown>, body: string): string[] {
  const out = new Set<string>();
  for (const t of extractFrontmatterTags(fm)) out.add(t);
  for (const t of extractInlineTags(body)) out.add(t);
  return [...out];
}

function stripCodeAndInline(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/~~~[\s\S]*?~~~/g, "")
    .replace(/`[^`\n]*`/g, "");
}
