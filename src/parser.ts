import { Buffer } from "node:buffer";
import { advanceFence, type FenceState } from "./fence.js";
import { parseFrontmatter } from "./frontmatter.js";
import { lookupFoldedAny, nfc } from "./name-fold.js";

/** Hard UTF-8 admission ceiling for one direct parser input. */
export const MAX_PARSER_SOURCE_UTF8_BYTES = 64 * 1024 * 1024;

/** Hard ceiling for materialized parser occurrences (links, tags, and code runs). */
export const MAX_PARSER_OCCURRENCES = 1_100_000;

/** Hard ceiling for the aggregate UTF-8 bytes copied into parser result strings. */
export const MAX_PARSER_CAPTURE_UTF8_BYTES = 64 * 1024 * 1024;

/** Mutable deterministic counter used to prove scanner work without wall-clock timing. */
export interface ParserOperationCounter {
  /** Monotonic count of examined code units and bounded bookkeeping steps. */
  operations: number;
}

/**
 * Optional lower parser limits. Values can only narrow the production hard limits;
 * callers cannot use this surface to disable admission bounds.
 */
export interface ParserLimits {
  /** Maximum admitted UTF-8 bytes in the input string. */
  maxSourceUtf8Bytes?: number;
  /** Maximum number of materialized structural occurrences. */
  maxOccurrences?: number;
  /** Maximum aggregate UTF-8 bytes copied into structural result strings. */
  maxCapturedUtf8Bytes?: number;
  /** Optional deterministic operation counter, primarily useful to causal tests. */
  operationCounter?: ParserOperationCounter;
}

/** Typed fail-closed error for parser input, occurrence, and capture-budget exhaustion. */
export class ParserCapacityError extends RangeError {
  /** Create one capacity error with a stable class/name for callers. */
  constructor(message: string) {
    super(message);
    this.name = "ParserCapacityError";
  }
}

interface ResolvedParserLimits {
  maxSourceUtf8Bytes: number;
  maxOccurrences: number;
  maxCapturedUtf8Bytes: number;
  operationCounter?: ParserOperationCounter;
}

class ParserBudget {
  private occurrences = 0;
  private capturedUtf8Bytes = 0;

  constructor(private readonly limits: ResolvedParserLimits) {}

  admitSource(text: string): void {
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > this.limits.maxSourceUtf8Bytes) {
      throw new ParserCapacityError(
        `Parser input exceeds ${this.limits.maxSourceUtf8Bytes} UTF-8 bytes (got ${bytes})`
      );
    }
  }

  tick(units = 1): void {
    if (this.limits.operationCounter !== undefined) this.limits.operationCounter.operations += units;
  }

  reserveOccurrence(capturedUtf8Bytes: number, kind: string): void {
    if (this.occurrences >= this.limits.maxOccurrences) {
      throw new ParserCapacityError(`${kind} exceeds the ${this.limits.maxOccurrences}-occurrence parser budget`);
    }
    this.reserveCapturedBytes(capturedUtf8Bytes, kind);
    this.occurrences += 1;
  }

  reserveCapturedBytes(capturedUtf8Bytes: number, kind: string): void {
    if (capturedUtf8Bytes > this.limits.maxCapturedUtf8Bytes - this.capturedUtf8Bytes) {
      throw new ParserCapacityError(
        `${kind} exceeds the ${this.limits.maxCapturedUtf8Bytes}-byte parser capture budget`
      );
    }
    this.capturedUtf8Bytes += capturedUtf8Bytes;
  }
}

const PARSER_OUTPUT_CHUNK_CODE_UNITS = 8192;

class ParserStringBuilder {
  private readonly chunks: string[] = [];
  private pending = "";

  append(value: string | undefined): void {
    if (value === undefined || value.length === 0) return;
    if (this.pending.length + value.length < PARSER_OUTPUT_CHUNK_CODE_UNITS) {
      this.pending += value;
      return;
    }
    if (this.pending.length > 0) {
      this.chunks.push(this.pending);
      this.pending = "";
    }
    if (value.length >= PARSER_OUTPUT_CHUNK_CODE_UNITS) this.chunks.push(value);
    else this.pending = value;
  }

  finish(): string {
    if (this.chunks.length === 0) return this.pending;
    if (this.pending.length > 0) this.chunks.push(this.pending);
    return this.chunks.join("");
  }
}

function narrowLimit(value: number | undefined, hardLimit: number, label: string): number {
  if (value === undefined) return hardLimit;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return Math.min(value, hardLimit);
}

function createParserBudget(limits?: ParserLimits): ParserBudget {
  return new ParserBudget({
    maxSourceUtf8Bytes: narrowLimit(limits?.maxSourceUtf8Bytes, MAX_PARSER_SOURCE_UTF8_BYTES, "maxSourceUtf8Bytes"),
    maxOccurrences: narrowLimit(limits?.maxOccurrences, MAX_PARSER_OCCURRENCES, "maxOccurrences"),
    maxCapturedUtf8Bytes: narrowLimit(
      limits?.maxCapturedUtf8Bytes,
      MAX_PARSER_CAPTURE_UTF8_BYTES,
      "maxCapturedUtf8Bytes"
    ),
    ...(limits?.operationCounter !== undefined ? { operationCounter: limits.operationCounter } : {})
  });
}

function countCanonicalLineBreaksBefore(text: string, end: number, budget: ParserBudget): number {
  let count = 0;
  let cursor = 0;
  while (cursor < end) {
    budget.tick();
    const code = text.charCodeAt(cursor);
    if (code === 13 && text.charCodeAt(cursor + 1) === 10 && cursor + 1 < end) {
      count += 1;
      cursor += 2;
      budget.tick();
    } else {
      if (code === 10 || code === 13 || code === 0x2028 || code === 0x2029) count += 1;
      cursor += 1;
    }
  }
  return count;
}

/**
 * A parsed Obsidian wikilink (`[[Target]]`, `[[Target#section]]`,
 * `[[Target^block]]`, `[[Target|alias]]`, or any combination).
 *
 * Fields are populated when the corresponding fragment is present in the
 * source; otherwise omitted (not `undefined`-valued — the property is
 * absent so callers can use `"section" in link` without ambiguity).
 */
export interface Wikilink {
  /** Original payload between the `[[` `]]` delimiters, including any
   *  alias/section/block suffix. Useful for round-tripping unchanged. */
  raw: string;
  /** Zero-based UTF-16 offset of `[[` (or the `!` in `![[`) in the parser input.
   * Optional in the public type for source compatibility; canonical parsers set it. */
  sourceStart?: number;
  /** Exclusive zero-based UTF-16 offset immediately after the closing `]]`.
   * Optional in the public type for source compatibility; canonical parsers set it. */
  sourceEnd?: number;
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
 * @param limits - Optional lower admission limits; omitted for production defaults.
 * @returns Parsed structure ready for indexing or rendering.
 * @example
 * ```ts
 * const parsed = parseNote("---\ntags: [idea]\n---\nSee [[Other]].");
 * parsed.frontmatter; // { tags: ["idea"] }
 * parsed.wikilinks;   // [{ raw: "Other", target: "Other" }]
 * parsed.tags;        // ["idea"]
 * ```
 */
export function parseNote(source: string, limits?: ParserLimits): ParsedNote {
  const budget = createParserBudget(limits);
  // Admit before gray-matter can allocate YAML collections or the sanitizer can
  // construct line/run inventories. This is the parser's outermost fail-closed gate.
  budget.admitSource(source);
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
  const sanitized = stripCodeAndInlineWithBudget(body, budget, true);
  // v3.10.0-rc.17 (audit M1) — the 1-based file line where `body` starts, so
  // body-chunking consumers (the embedding pipeline) can report FILE-absolute
  // line numbers that match the content-chunking FTS5 index.
  // v3.10.0-rc.24 (audit L) — `body` is the SUFFIX of `source` (everything after
  // the frontmatter), so use `lastIndexOf`: plain `indexOf` would false-match a
  // degenerate note whose entire body text also appears verbatim earlier inside
  // a frontmatter line (e.g. `---\nx: hi\n---\nhi`), reporting too-early a line.
  // 1 when there's no frontmatter, an empty body, or the defensive not-found case.
  const bodyIdx = body.length > 0 ? source.lastIndexOf(body) : -1;
  const bodyStartLine = bodyIdx > 0 ? countCanonicalLineBreaksBefore(source, bodyIdx, budget) + 1 : 1;
  return {
    frontmatter,
    body,
    bodyStartLine,
    wikilinks: matchLinks(sanitized, false, budget, bodyIdx > 0 ? bodyIdx : 0),
    embeds: matchLinks(sanitized, true, budget, bodyIdx > 0 ? bodyIdx : 0),
    tags: collectTags(frontmatter, sanitized, budget)
  };
}

/**
 * Linear, non-backtracking scan for `[[wikilink]]` (embed=false) / `![[embed]]`
 * (embed=true) INNER captures, in source order. Equivalent to the former regexes
 * except that every project-canonical Markdown line terminator (LF / CRLF / CR /
 * U+2028 / U+2029) now ends a candidate rather than LF alone.
 *
 * v3.11.0-rc.17 (rc.16 re-audit, HIGH ReDoS) — REPLACES those two regexes. The
 * lazy `[^\]\n]+?` searching for the 2-char `]]` delimiter is O(n²) on an
 * unclosed `[[`-run: each `[[` start lazily extends to EOF hunting a `]]` that
 * never comes (measured 195 KB → 10.7 s; reachable via the always-on
 * `obsidian_read_note` → `parseNote` over adversarial note CONTENT = a
 * bearer-reachable serve-http event-loop hang — the rc.39 worker sink-bound and
 * the rc.14/rc.71 linear matchers never covered this wikilink/embed sink). The
 * monotonic DFA visits each code unit at most once. In particular, it never
 * searches for `]` from every opener, so `("[[a\n").repeat(m) + "]]"` is O(n),
 * not O(n²). The close is the first `]` after `[[`, which must be doubled (`]]`).
 *
 * @param text - Markdown source (already stripped of code spans, ideally).
 * @param embed - false = `[[wikilink]]` (preceding char not `!`); true = `![[embed]]`.
 * @param limits - Optional lower admission limits and deterministic operation counter.
 * @returns Inner capture strings in source order.
 */
export function scanWikilinkInners(text: string, embed = false, limits?: ParserLimits): string[] {
  const budget = createParserBudget(limits);
  budget.admitSource(text);
  const out: string[] = [];
  scanWikilinkOccurrences(text, embed, budget, (start, end) => out.push(text.slice(start, end)));
  return out;
}

function isLineTerminatorCode(code: number): boolean {
  return code === 10 || code === 13 || code === 0x2028 || code === 0x2029;
}

function utf8WidthAt(text: string, index: number): 1 | 2 | 3 | 4 {
  const code = text.charCodeAt(index);
  if (code <= 0x7f) return 1;
  if (code <= 0x7ff) return 2;
  if (code >= 0xd800 && code <= 0xdbff) {
    const next = text.charCodeAt(index + 1);
    if (next >= 0xdc00 && next <= 0xdfff) return 4;
  }
  return 3;
}

function scanWikilinkOccurrences(
  text: string,
  embed: boolean,
  budget: ParserBudget,
  onMatch: (innerStart: number, innerEnd: number, capturedUtf8Bytes: number) => void
): void {
  let cursor = 0;
  while (cursor + 1 < text.length) {
    budget.tick();
    if (text.charCodeAt(cursor) !== 91 || text.charCodeAt(cursor + 1) !== 91) {
      cursor += 1;
      continue;
    }

    const open = cursor;
    const innerStart = open + 2;
    let innerCursor = innerStart;
    let capturedUtf8Bytes = 0;
    let resolved = false;
    while (innerCursor < text.length) {
      budget.tick();
      const code = text.charCodeAt(innerCursor);
      if (isLineTerminatorCode(code)) {
        // Every opener at or before this boundary crosses the same line ending.
        // Treat CRLF as one canonical terminator and resume after it.
        cursor = code === 13 && text.charCodeAt(innerCursor + 1) === 10 ? innerCursor + 2 : innerCursor + 1;
        resolved = true;
        break;
      }
      if (code === 93) {
        if (innerCursor === innerStart) {
          // Empty `[[]]`: preserve the incumbent overlap behavior and try the
          // second `[` as a possible opener on the next outer iteration.
          cursor = open + 1;
        } else if (text.charCodeAt(innerCursor + 1) === 93) {
          const isEmbed = open > 0 && text.charCodeAt(open - 1) === 33;
          if (isEmbed === embed) {
            // Reserve before slice()/push(): an over-budget payload never exists
            // transiently as a large result string or array entry.
            budget.reserveOccurrence(capturedUtf8Bytes, embed ? "embed" : "wikilink");
            onMatch(innerStart, innerCursor, capturedUtf8Bytes);
          }
          cursor = innerCursor + 2;
        } else {
          cursor = innerCursor + 1;
        }
        resolved = true;
        break;
      }

      const width = utf8WidthAt(text, innerCursor);
      capturedUtf8Bytes += width;
      if (width === 4) {
        // A four-byte UTF-8 scalar occupies two UTF-16 code units.
        innerCursor += 2;
        budget.tick();
      } else {
        innerCursor += 1;
      }
    }
    if (!resolved) return;
  }
}

/**
 * Extract all `[[wikilinks]]` from a markdown string. Excludes `![[embeds]]`
 * via the preceding-`!` check. Caller is responsible for stripping
 * code fences / inline code first if recall over example markdown matters
 * (use the same pipeline as {@link parseNote}).
 *
 * @param text - Markdown source (already stripped of code spans, ideally).
 * @param limits - Optional lower admission limits.
 * @returns Wikilinks in source order. Empty array if none found.
 */
export function extractWikilinks(text: string, limits?: ParserLimits): Wikilink[] {
  const budget = createParserBudget(limits);
  budget.admitSource(text);
  return matchLinks(text, false, budget);
}

/**
 * Extract all `![[embeds]]` from a markdown string. Same payload syntax as
 * wikilinks; the `!` prefix is what distinguishes embed from link.
 *
 * @param text - Markdown source.
 * @param limits - Optional lower admission limits.
 * @returns Embeds in source order. Empty array if none found.
 */
export function extractEmbeds(text: string, limits?: ParserLimits): Embed[] {
  const budget = createParserBudget(limits);
  budget.admitSource(text);
  return matchLinks(text, true, budget);
}

function matchLinks(text: string, embed: boolean, budget: ParserBudget, sourceOffset = 0): Wikilink[] {
  const out: Wikilink[] = [];
  scanWikilinkOccurrences(text, embed, budget, (start, end, capturedUtf8Bytes) => {
    // `raw` plus target/section/block/alias materialize at most two copies of
    // the raw payload in aggregate. Reserve that second-copy envelope before
    // creating any of those strings or pushing the result object.
    budget.reserveCapturedBytes(capturedUtf8Bytes, embed ? "embed fields" : "wikilink fields");
    const raw = text.slice(start, end);
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
      sourceStart: sourceOffset + start - 2 - (embed ? 1 : 0),
      sourceEnd: sourceOffset + end + 2,
      target: rest.trim(),
      ...(section !== undefined ? { section } : {}),
      ...(block !== undefined ? { block } : {}),
      ...(alias !== undefined ? { alias } : {})
    });
  });
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
 * @param limits - Optional lower admission limits.
 * @returns Unique tag names (without the leading `#`), in first-occurrence order.
 */
export function extractInlineTags(text: string, limits?: ParserLimits): string[] {
  const budget = createParserBudget(limits);
  budget.admitSource(text);
  return extractInlineTagsWithBudget(text, budget);
}

function extractInlineTagsWithBudget(text: string, budget: ParserBudget): string[] {
  const found = new Set<string>();
  // v3.11.0-rc.10 (M1) — NFC-normalize the BODY before matching so an NFD inline
  // tag (`#café` = `cafe`+U+0301 on macOS APFS) composes to `café` and the regex
  // captures the full accented token instead of truncating at the combining mark.
  for (const m of text.normalize("NFC").matchAll(INLINE_TAG_RE)) {
    // nfc() is now belt-and-suspenders (the input is already NFC); kept so a future
    // caller passing un-normalized text still stores a canonical tag.
    if (m[1] !== undefined) {
      const tag = nfc(m[1]);
      if (!found.has(tag)) {
        budget.reserveOccurrence(Buffer.byteLength(tag, "utf8"), "inline tag");
        found.add(tag);
      }
    }
  }
  return [...found];
}

/**
 * Normalize tags from a frontmatter object. Accepts both the
 * `tags: [a, b]` array form and the `tag: "a, b c"` string form
 * (comma-or-whitespace separated). Leading `#` characters are stripped.
 *
 * @param fm - Frontmatter object as returned by {@link parseNote}.
 * @param limits - Optional lower admission limits.
 * @returns Normalized tag list. Empty array when no `tags` / `tag` key.
 */
export function extractFrontmatterTags(fm: Record<string, unknown>, limits?: ParserLimits): string[] {
  return extractFrontmatterTagsWithBudget(fm, createParserBudget(limits));
}

function extractFrontmatterTagsWithBudget(fm: Record<string, unknown>, budget: ParserBudget): string[] {
  // v3.11.0-rc.13 (rc.12-audit AUD-03) — fold the `tags`/`tag` KEY (case/NFC) so a
  // `Tags:`/`Tag:` (or NFD-on-disk) frontmatter property is not invisible to tag
  // retrieval (list_tags / list_notes(tag) / DQL `FROM #tag` / Bases / paper_audit).
  // The PRODUCER sibling of the rc.10/rc.12 H1 frontmatter-key-fold class.
  const raw = lookupFoldedAny(fm, ["tags", "tag"]);
  if (!raw) return [];
  const out: string[] = [];
  if (Array.isArray(raw)) {
    for (const value of raw) {
      if (typeof value !== "string") continue;
      const tag = normalizeTag(value);
      budget.reserveOccurrence(Buffer.byteLength(tag, "utf8"), "frontmatter tag");
      out.push(tag);
    }
    return out;
  }
  if (typeof raw === "string") {
    // Iterator form avoids creating an unbounded intermediate split array.
    for (const match of raw.matchAll(/[^,\s]+/gu)) {
      const tag = normalizeTag(match[0]);
      budget.reserveOccurrence(Buffer.byteLength(tag, "utf8"), "frontmatter tag");
      out.push(tag);
    }
  }
  return out;
}

function normalizeTag(t: string): string {
  // v3.11.0-rc.9 (L-TAG-1) — NFC-normalize the stored tag (display case kept) so
  // frontmatter + inline forms of one accented tag canonicalize to a single key.
  return nfc(t.replace(/^#+/, ""));
}

function collectTags(fm: Record<string, unknown>, body: string, budget: ParserBudget): string[] {
  const out = new Set<string>();
  for (const t of extractFrontmatterTagsWithBudget(fm, budget)) out.add(t);
  for (const t of extractInlineTagsWithBudget(body, budget)) out.add(t);
  return [...out];
}

interface BacktickRun {
  rawStart: number;
  end: number;
  rawLength: number;
  openerStart: number;
  openerLength: number;
  nextSame: number;
}

function appendLineTerminators(text: string, start: number, end: number, budget: ParserBudget): string {
  const out = new ParserStringBuilder();
  let cursor = start;
  while (cursor < end) {
    budget.tick();
    const code = text.charCodeAt(cursor);
    if (code === 13 && text.charCodeAt(cursor + 1) === 10 && cursor + 1 < end) {
      out.append("\r\n");
      cursor += 2;
      budget.tick();
    } else {
      if (isLineTerminatorCode(code)) out.append(text[cursor]);
      cursor += 1;
    }
  }
  return out.finish();
}

function maskRangePreservingTerminators(text: string, start: number, end: number, budget: ParserBudget): string {
  const out = new ParserStringBuilder();
  let cursor = start;
  let maskedStart = start;
  while (cursor < end) {
    budget.tick();
    const code = text.charCodeAt(cursor);
    if (!isLineTerminatorCode(code)) {
      cursor += 1;
      continue;
    }
    if (maskedStart < cursor) out.append(" ".repeat(cursor - maskedStart));
    if (code === 13 && text.charCodeAt(cursor + 1) === 10 && cursor + 1 < end) {
      out.append("\r\n");
      cursor += 2;
      budget.tick();
    } else {
      out.append(text[cursor]);
      cursor += 1;
    }
    maskedStart = cursor;
  }
  if (maskedStart < end) out.append(" ".repeat(end - maskedStart));
  return out.finish();
}

/**
 * Strip CommonMark backtick code spans in one fence-free source range. A reverse
 * same-run-length index makes every opener's next eligible closer O(1), while the
 * forward pairing pass preserves CommonMark's earliest-equal-run rule. Outside a
 * span, an odd backslash run escapes the first backtick (the remainder may open);
 * inside a span backslashes are literal, so a closer uses the full raw run length.
 * Differing runs inside a matched span are content; when an opener is unmatched,
 * later runs remain eligible to form their own spans. Line terminators inside
 * removed spans are retained so structural boundaries cannot merge.
 */
function stripInlineCodeRange(
  text: string,
  start: number,
  end: number,
  budget: ParserBudget,
  preserveOffsets: boolean
): string {
  const runs: BacktickRun[] = [];
  let cursor = start;
  let precedingBackslashes = 0;
  while (cursor < end) {
    budget.tick();
    const code = text.charCodeAt(cursor);
    if (code === 92) {
      precedingBackslashes += 1;
      cursor += 1;
      continue;
    }
    if (code !== 96) {
      precedingBackslashes = 0;
      cursor += 1;
      continue;
    }
    const runStart = cursor;
    cursor += 1;
    while (cursor < end && text.charCodeAt(cursor) === 96) {
      cursor += 1;
      budget.tick();
    }
    const escapedFirst = precedingBackslashes % 2 === 1;
    const rawLength = cursor - runStart;
    budget.reserveOccurrence(0, "inline-code delimiter run");
    runs.push({
      rawStart: runStart,
      end: cursor,
      rawLength,
      openerStart: escapedFirst ? runStart + 1 : runStart,
      openerLength: escapedFirst ? rawLength - 1 : rawLength,
      nextSame: -1
    });
    precedingBackslashes = 0;
  }

  const nextByLength = new Map<number, number>();
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    budget.tick();
    const run = runs[index] as BacktickRun;
    if (run.openerLength > 0) run.nextSame = nextByLength.get(run.openerLength) ?? -1;
    nextByLength.set(run.rawLength, index);
  }

  const out = new ParserStringBuilder();
  let visibleStart = start;
  let runIndex = 0;
  while (runIndex < runs.length) {
    budget.tick();
    const opener = runs[runIndex] as BacktickRun;
    if (opener.nextSame < 0) {
      runIndex += 1;
      continue;
    }
    const closer = runs[opener.nextSame] as BacktickRun;
    out.append(text.slice(visibleStart, opener.openerStart));
    out.append(
      preserveOffsets
        ? maskRangePreservingTerminators(text, opener.openerStart, closer.end, budget)
        : appendLineTerminators(text, opener.end, closer.rawStart, budget)
    );
    visibleStart = closer.end;
    runIndex = opener.nextSame + 1;
  }
  out.append(text.slice(visibleStart, end));
  return out.finish();
}

function nextLineBounds(text: string, start: number, budget: ParserBudget): { contentEnd: number; nextStart: number } {
  let cursor = start;
  while (cursor < text.length) {
    budget.tick();
    const code = text.charCodeAt(cursor);
    if (code === 13) {
      if (text.charCodeAt(cursor + 1) === 10) {
        budget.tick();
        return { contentEnd: cursor, nextStart: cursor + 2 };
      }
      return { contentEnd: cursor, nextStart: cursor + 1 };
    }
    if (code === 10 || code === 0x2028 || code === 0x2029) {
      return { contentEnd: cursor, nextStart: cursor + 1 };
    }
    cursor += 1;
  }
  return { contentEnd: text.length, nextStart: text.length };
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
 * Block stripping uses the exact same char/run-length state machine as every
 * structural reader and write rewriter. Unclosed fences therefore run to EOF,
 * short closers and trailing-text pseudo-closers remain code, and there is no
 * separate paired-regex interpretation to drift from the walkers.
 *
 * Inline-code stripping is whole-text within each fence-free region: exact
 * delimiter-run lengths pair across LF / CRLF / CR / U+2028 / U+2029, so a
 * multi-line span cannot leak links or tags. The run inventory is occurrence-
 * bounded before each push and uses a reverse next-run index rather than a
 * suffix search from every unmatched opener.
 *
 * @param text - Markdown source to sanitize.
 * @param limits - Optional lower admission limits and deterministic operation counter.
 * @returns Source with code content removed and canonical line terminators preserved.
 */
export function stripCodeAndInline(text: string, limits?: ParserLimits): string {
  const budget = createParserBudget(limits);
  budget.admitSource(text);
  return stripCodeAndInlineWithBudget(text, budget, false);
}

function stripCodeAndInlineWithBudget(text: string, budget: ParserBudget, preserveOffsets: boolean): string {
  let marker: FenceState | null = null;
  const out = new ParserStringBuilder();
  let lineStart = 0;
  let visibleStart = 0;

  while (lineStart < text.length) {
    const { contentEnd, nextStart } = nextLineBounds(text, lineStart, budget);
    const line = text.slice(lineStart, contentEnd);
    const state = advanceFence(line, marker);
    marker = state.marker;
    if (state.delimiter || marker !== null) {
      if (visibleStart < lineStart) {
        out.append(stripInlineCodeRange(text, visibleStart, lineStart, budget, preserveOffsets));
      }
      // Fence content is removed, but its exact line terminator remains.
      if (preserveOffsets) out.append(maskRangePreservingTerminators(text, lineStart, contentEnd, budget));
      out.append(text.slice(contentEnd, nextStart));
      visibleStart = nextStart;
    }
    lineStart = nextStart;
    if (contentEnd === text.length) break;
  }

  if (visibleStart < text.length) {
    out.append(stripInlineCodeRange(text, visibleStart, text.length, budget, preserveOffsets));
  }
  return out.finish();
}
