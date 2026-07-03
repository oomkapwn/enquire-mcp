import { advanceFence, type FenceChar } from "./fence.js";
import { parseFrontmatter } from "./frontmatter.js";
import { lookupFoldedAny, nfc } from "./name-fold.js";
import { splitLines } from "./wildcard-match.js";

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
 * `parseFrontmatter`) from body, then extracts wikilinks, embeds, and tags
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
    const parsed = parseFrontmatter(source);
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
  const bodyStartLine = bodyIdx > 0 ? splitLines(source.slice(0, bodyIdx)).length : 1;
  return {
    frontmatter,
    body,
    bodyStartLine,
    wikilinks: extractWikilinks(sanitized),
    embeds: extractEmbeds(sanitized),
    tags: collectTags(frontmatter, sanitized)
  };
}

/**
 * Linear, non-backtracking scan for `[[wikilink]]` (embed=false) / `![[embed]]`
 * (embed=true) INNER captures, in source order. Byte-equivalent to the `m[1]`
 * sequence of the former regexes `/(?<!!)\[\[([^\]\n]+?)\]\]/g` (wikilink) and
 * `/!\[\[([^\]\n]+?)\]\]/g` (embed) — proven by `tests/wikilink-scan.test.ts`'s
 * differential against inlined copies of those regexes over a broad corpus.
 *
 * v3.11.0-rc.17 (rc.16 re-audit, HIGH ReDoS) — REPLACES those two regexes. The
 * lazy `[^\]\n]+?` searching for the 2-char `]]` delimiter is O(n²) on an
 * unclosed `[[`-run: each `[[` start lazily extends to EOF hunting a `]]` that
 * never comes (measured 195 KB → 10.7 s; reachable via the always-on
 * `obsidian_read_note` → `parseNote` over adversarial note CONTENT = a
 * bearer-reachable serve-http event-loop hang — the rc.39 worker sink-bound and
 * the rc.14/rc.71 linear matchers never covered this wikilink/embed sink). This
 * scan visits each `]` / `[[` / `\n` at most once → O(n) for ANY input. Inner
 * excludes `]` and `\n` (a wikilink never crosses a line); the close is the first
 * `]` after `[[`, which must be doubled (`]]`).
 *
 * @param text - Markdown source (already stripped of code spans, ideally).
 * @param embed - false = `[[wikilink]]` (preceding char not `!`); true = `![[embed]]`.
 * @returns Inner capture strings in source order.
 */
export function scanWikilinkInners(text: string, embed = false): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const open = text.indexOf("[[", from);
    if (open < 0) break;
    const innerStart = open + 2;
    const bracket = text.indexOf("]", innerStart);
    if (bracket < 0) break; // no closing ']' anywhere → no further match is possible
    // A `\n` before the first `]` means the inner would cross a newline (inner is
    // `[^\]\n]`), so no `[[` start ≤ that `\n` can match → skip past it.
    // v3.11.0-rc.18 (rc.17 external audit, HIGH ReDoS regression) — scan ONLY the
    // bounded inner window [innerStart, bracket). The rc.17 form used the UNBOUNDED
    // `text.indexOf("\n", innerStart)`: on a body with no `\n` between `[[` and EOF
    // (a dense single-line `[[a]]`-run / MOC-index note) it rescanned to EOF every
    // iteration → O(n²) (400k links = 8.2s; ~50s at the 5 MB cap, bearer-reachable
    // via the always-on obsidian_read_note → parseNote). This bounded charCodeAt
    // scan visits each inner char at most once → O(n) overall, and is
    // byte-equivalent (it finds the same first `\n`-before-`]`, if any).
    let nl = -1;
    for (let k = innerStart; k < bracket; k++) {
      if (text.charCodeAt(k) === 10 /* '\n' */) {
        nl = k;
        break;
      }
    }
    if (nl >= 0) {
      from = nl + 1;
      continue;
    }
    if (bracket === innerStart) {
      from = open + 1; // empty inner (`[[]]`) — the inner needs ≥1 char; try next start
      continue;
    }
    if (text.charCodeAt(bracket + 1) === 93 /* ']' */) {
      const isEmbed = open > 0 && text.charCodeAt(open - 1) === 33; /* '!' */
      if (isEmbed === embed) out.push(text.slice(innerStart, bracket));
      from = bracket + 2; // consume past `]]`
    } else {
      // lone ']' (not doubled) — inner can't cross it and the close isn't `]]`;
      // no `[[` start ≤ bracket can match → skip past this ']'.
      from = bracket + 1;
    }
  }
  return out;
}

/**
 * Extract all `[[wikilinks]]` from a markdown string. Excludes `![[embeds]]`
 * via the preceding-`!` check. Caller is responsible for stripping
 * code fences / inline code first if recall over example markdown matters
 * (use the same pipeline as {@link parseNote}).
 *
 * @param text - Markdown source (already stripped of code spans, ideally).
 * @returns Wikilinks in source order. Empty array if none found.
 */
export function extractWikilinks(text: string): Wikilink[] {
  return matchLinks(text, false);
}

/**
 * Extract all `![[embeds]]` from a markdown string. Same payload syntax as
 * wikilinks; the `!` prefix is what distinguishes embed from link.
 *
 * @param text - Markdown source.
 * @returns Embeds in source order. Empty array if none found.
 */
export function extractEmbeds(text: string): Embed[] {
  return matchLinks(text, true);
}

function matchLinks(text: string, embed: boolean): Wikilink[] {
  const out: Wikilink[] = [];
  for (const raw of scanWikilinkInners(text, embed)) {
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

/**
 * Inline `#tag` extraction regex (shared — imported by `tools/meta.ts` so the
 * two extractors cannot drift; was a byte-identical copy before v3.11.0-rc.10).
 * Tag = a leading Unicode LETTER then letters/digits/`_`/`/`/`-`. Preceded by
 * whitespace/bracket/BOL so `#1` in a heading is not a tag. The `u` flag is
 * required for `\p{L}`. `matchAll` clones the regex per call, so sharing this
 * `/g` instance across modules is lastIndex-safe.
 *
 * v3.11.0-rc.10 (M1, external audit) — the character class deliberately does NOT
 * include `\p{M}` (combining marks); instead every caller NFC-normalizes the text
 * BEFORE matching (see {@link extractInlineTags}). On macOS APFS an inline `#café`
 * is stored DECOMPOSED (NFD: `e` + U+0301), and U+0301 is a `\p{M}` mark that the
 * class excludes — so a raw match would TRUNCATE the capture to `cafe` and the
 * accent would be lost BEFORE any downstream `nfc()`/`foldTag()` could recover it
 * (the rc.9 producer-`nfc()` ran on already-corrupted input). Normalizing the text
 * first composes the mark back into the base letter (`é` = `\p{L}`), so the capture
 * is complete and canonical. (Normalize-before-match recovers ANY combining mark,
 * not just the ones we could enumerate in a character class.)
 */
export const INLINE_TAG_RE = /(?:^|[\s([{>])#([\p{L}][\p{L}\p{N}_/-]*)/gu;

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
  // v3.11.0-rc.10 (M1) — NFC-normalize the BODY before matching so an NFD inline
  // tag (`#café` = `cafe`+U+0301 on macOS APFS) composes to `café` and the regex
  // captures the full accented token instead of truncating at the combining mark.
  for (const m of text.normalize("NFC").matchAll(INLINE_TAG_RE)) {
    // nfc() is now belt-and-suspenders (the input is already NFC); kept so a future
    // caller passing un-normalized text still stores a canonical tag.
    if (m[1] !== undefined) found.add(nfc(m[1]));
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
  // v3.11.0-rc.13 (rc.12-audit AUD-03) — fold the `tags`/`tag` KEY (case/NFC) so a
  // `Tags:`/`Tag:` (or NFD-on-disk) frontmatter property is not invisible to tag
  // retrieval (list_tags / list_notes(tag) / DQL `FROM #tag` / Bases / paper_audit).
  // The PRODUCER sibling of the rc.10/rc.12 H1 frontmatter-key-fold class.
  const raw = lookupFoldedAny(fm, ["tags", "tag"]);
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
  // v3.11.0-rc.9 (L-TAG-1) — NFC-normalize the stored tag (display case kept) so
  // frontmatter + inline forms of one accented tag canonicalize to a single key.
  return nfc(t.replace(/^#+/, ""));
}

function collectTags(fm: Record<string, unknown>, body: string): string[] {
  const out = new Set<string>();
  for (const t of extractFrontmatterTags(fm)) out.add(t);
  for (const t of extractInlineTags(body)) out.add(t);
  return [...out];
}

/**
 * Drop an UNCLOSED block code fence (an opening ` ``` ` / `~~~` line with no matching close
 * before EOF) and everything after it. Per CommonMark §4.5 an unclosed fence runs to
 * end-of-document, so its body is code — exactly what the char-aware line-walkers
 * (`advanceFence`, used by read.ts / meta.ts / fts5.ts / write.ts) already do. The paired-fence
 * regexes in `stripCodeAndInline` REQUIRE a closing fence, so without this an unclosed fence's
 * body would survive and every parser-based always-on tool (`buildWikilinkGraph`, `queryBase`,
 * `validateNoteProposal`) would surface phantom wikilinks / tags / questions from inside it.
 * Shares the fence primitive with the walkers so the two can never diverge on this shape.
 * Well-formed notes (all fences paired) are returned byte-unchanged.
 */
function dropUnclosedBlockFence(text: string): string {
  const lines = splitLines(text); // terminator-aware (CR/LS/PS), matches the walkers + rc.23 inventory
  let marker: FenceChar | null = null;
  let openLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const wasOutside = marker === null;
    const st = advanceFence(lines[i] ?? "", marker);
    marker = st.marker;
    if (wasOutside && marker !== null)
      openLine = i; // this line opened a block fence
    else if (marker === null) openLine = -1; // a matching close returned us outside
  }
  return marker !== null && openLine >= 0 ? lines.slice(0, openLine).join("\n") : text;
}

/**
 * Strip fenced (` ``` ` / `~~~`) and inline (`` `…` ``) code from Markdown so that
 * `[[wikilinks]]`, `#tags`, and `![[embeds]]` inside code are NOT treated as real —
 * the canonical sanitizer `parseNote` applies before every extraction. Any consumer that
 * extracts links/tags from a note body MUST route through this (or `parseNote`) so its
 * view matches the parser + Obsidian, which do not index links/tags inside code blocks.
 *
 * Exported in v3.11.5-rc.3 (post-rc.2 re-sweep, PARSER-DESYNC class) — several always-on
 * tools (query_base, get_communities, validate_note_proposal) re-extracted from the RAW
 * body and disagreed with this sanitizer; guarded by `tests/parser-desync-invariant.test.ts`.
 *
 * v3.11.6-rc.1 — reconciled with the char-aware line-walkers on the UNCLOSED-fence shape:
 * the paired regexes require a closing fence, so an unclosed ` ``` ` used to leak its body
 * (phantom links/tags), while the walkers correctly treat it as code-to-EOF. `dropUnclosedBlockFence`
 * closes that divergence up front. Now covered by `tests/canonical-parser-agreement.test.ts`.
 *
 * KNOWN RESIDUAL (pre-existing, deferred): the non-greedy paired regexes still diverge from the
 * char-aware walkers on an EXOTIC shape — a line-leading self-contained inline `` ``` `` span
 * *inside* a fenced block makes the regex pair fences early, so a `[[link]]`/`#tag` still inside the
 * block can surface as a phantom (a read-side false positive in `buildWikilinkGraph`/`queryBase`/
 * `validateNoteProposal`; not DoS, not data loss). This is the regex-vs-char-aware gap the meta-audit
 * named for the deferred canonical structure accessors (a fence-aware iterator on `ParsedNote`), not a
 * v3.11.6-rc.1 regression — the behavior is byte-identical to prior stable on that shape.
 */
export function stripCodeAndInline(text: string): string {
  return dropUnclosedBlockFence(text)
    .replace(/```[\s\S]*?```/g, "")
    .replace(/~~~[\s\S]*?~~~/g, "")
    .replace(/`[^`\n]*`/g, "");
}
