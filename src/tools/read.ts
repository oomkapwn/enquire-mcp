import { parseDql, runDql } from "../dql.js";
import { foldTag, lookupFoldedKey } from "../name-fold.js";
import type { Embed, Wikilink } from "../parser.js";
import { computeStaleness, DEFAULT_STALE_DAYS } from "../staleness.js";
import { noteHeadings } from "../structure.js";
import type { FileEntry, Vault } from "../vault.js";
import { countLineBreaks, splitLines, stripTrailingNewlines } from "../wildcard-match.js";
import { capScanEntries } from "./limits.js";
import { findBestMatch, normalizeTag, stripMd } from "./meta.js";
import { sliceSnippet } from "./search.js";
import { extractFrontmatterTagsLower, resolveTarget } from "./write.js";

/**
 * Lightweight metadata row used by listing endpoints ({@link listNotes},
 * {@link getRecentEdits}).
 *
 * No `content` — for the body, follow up with {@link readNote}.
 */
export interface NoteSummary {
  /** `.md`-stripped basename of the note. */
  title: string;
  /** Vault-relative path. */
  path: string;
  /** Parsed YAML frontmatter (may be empty `{}`). */
  frontmatter: Record<string, unknown>;
  /** Tags (frontmatter + inline `#tag`), de-duplicated, original case. */
  tags: string[];
  /** ISO-8601 modification timestamp. */
  mtime: string;
}

/**
 * List markdown notes in the vault, optionally filtered by tag / folder /
 * modification date.
 *
 * Sorted by mtime descending (most recent first). Cheap metadata view —
 * frontmatter and tags only, no body. Use {@link readNote} to fetch the
 * full content for a specific result.
 *
 * @param vault - The vault to scan.
 * @param args - All optional. `tag` matches against both frontmatter and
 *   inline tags (normalized — leading `#` and case ignored). `folder`
 *   restricts to a subdirectory. `since_date` is an ISO 8601 date
 *   (`YYYY-MM-DD`) — only notes modified at-or-after are returned.
 *   `limit` defaults to 50.
 * @returns A {@link NoteSummary} array sorted by mtime desc, truncated to
 *   `limit`.
 * @throws {Error} If `since_date` is not a parseable ISO 8601 date.
 * @throws {VaultPathError} If `folder` resolves outside the vault.
 * @example
 * ```ts
 * const drafts = await listNotes(vault, {
 *   tag: "draft",
 *   folder: "Posts",
 *   since_date: "2026-01-01",
 *   limit: 20
 * });
 * ```
 */
export async function listNotes(
  vault: Vault,
  args: { tag?: string; folder?: string; since_date?: string; limit?: number }
): Promise<NoteSummary[]> {
  await vault.ensureExists();
  const limit = args.limit ?? 50;
  const sinceMs = args.since_date ? Date.parse(args.since_date) : null;
  if (sinceMs !== null && Number.isNaN(sinceMs)) {
    throw new Error(`Invalid since_date: ${args.since_date}. Use ISO 8601 (YYYY-MM-DD).`);
  }
  const wantTag = args.tag ? normalizeTag(args.tag) : null;

  const entries = await vault.listMarkdown(args.folder);
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const out: NoteSummary[] = [];
  for (const e of entries) {
    if (sinceMs !== null && e.mtimeMs < sinceMs) continue;
    const { parsed } = await vault.readNote(e.absPath, e.mtimeMs);
    if (wantTag && !parsed.tags.some((t) => normalizeTag(t) === wantTag)) continue;
    out.push({
      title: stripMd(e.basename),
      path: e.relPath,
      frontmatter: parsed.frontmatter,
      tags: parsed.tags,
      mtime: new Date(e.mtimeMs).toISOString()
    });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Full-fidelity note representation returned by `readNote(..., format: "full")`.
 *
 * `content` is the body (frontmatter stripped — frontmatter is exposed
 * separately in the `frontmatter` field).
 */
export interface NoteReadFull {
  /** Vault-relative path. */
  path: string;
  /** `.md`-stripped basename. */
  title: string;
  /** Markdown body, frontmatter stripped. */
  content: string;
  /** Parsed YAML frontmatter (may be empty `{}`). */
  frontmatter: Record<string, unknown>;
  /** All `[[wikilinks]]` in the body, with target / alias / section / block. */
  wikilinks: Wikilink[];
  /** All `![[embeds]]` in the body (images, transcludes, etc.). */
  embeds: Embed[];
  /** Tags (frontmatter + inline), de-duplicated. */
  tags: string[];
  /** ISO-8601 modification timestamp. */
  mtime: string;
}

/**
 * Document-map projection returned by `readNote(..., format: "map")`.
 *
 * Headings + frontmatter keys + counts only — no body. Lets the agent plan
 * a surgical edit (target a specific heading, count outbound links)
 * without paying token cost for the full content.
 */
export interface NoteReadMap {
  /** Vault-relative path. */
  path: string;
  /** `.md`-stripped basename. */
  title: string;
  /** Discriminator — always `"map"` for this variant. */
  format: "map";
  /** Top-level keys present in frontmatter (no values — values may be PII). */
  frontmatter_keys: string[];
  /** ATX headings (`#`, `##`, ...). 1-based line numbers. Code-fence aware. */
  headings: Array<{ level: number; text: string; line: number }>;
  /** Total `[[wikilinks]]` in the body. */
  wikilinks_count: number;
  /** Total `![[embeds]]` in the body. */
  embeds_count: number;
  /** Tags (frontmatter + inline), de-duplicated. */
  tags: string[];
  /** ISO-8601 modification timestamp. */
  mtime: string;
  /** UTF-8 byte length of the full file (frontmatter + body). */
  byte_size: number;
}

/**
 * Read a single note, either full-body or as a document-map projection.
 *
 * The `"map"` format is the recommended preflight call when an agent wants
 * to plan an edit but doesn't yet need the full body — it returns headings,
 * frontmatter keys, and counts in a fraction of the tokens. Switch to
 * `"full"` for the actual content.
 *
 * Resolves notes by exact path (`path: "Sub/Note.md"`) or by title
 * (`title: "Note"`) — title resolution uses the same fuzzy-match path as
 * wikilinks.
 *
 * @param vault - The vault to read from.
 * @param args - One of `path` or `title` is required. `format` defaults to
 *   `"full"`.
 * @returns Either a {@link NoteReadFull} or {@link NoteReadMap} depending on
 *   `args.format`. Use the `format` discriminator to narrow.
 * @throws {Error} If neither `path` nor `title` is provided, or the note
 *   cannot be resolved.
 * @throws {VaultPathError} If `path` resolves outside the vault.
 * @example
 * ```ts
 * // Plan an edit — cheap, no body
 * const map = await readNote(vault, { path: "Reference/Foo.md", format: "map" });
 * console.log(map.headings); // → [{ level: 1, text: "Foo", line: 1 }, ...]
 *
 * // Fetch full body
 * const full = await readNote(vault, { title: "Foo" });
 * console.log(full.content);
 * ```
 */
export async function readNote(
  vault: Vault,
  args: { path?: string; title?: string; format?: "full" | "map" }
): Promise<NoteReadFull | NoteReadMap> {
  await vault.ensureExists();
  const entry = await resolveTarget(vault, args);
  const { content, parsed, mtimeMs } = await vault.readNote(entry.absPath, entry.mtimeMs);

  if (args.format === "map") {
    // Document-map projection — headings + frontmatter keys + counts. Lets an
    // LLM plan a surgical edit without paying token cost for the full body.
    return {
      path: entry.relPath,
      title: stripMd(entry.basename),
      format: "map",
      frontmatter_keys: Object.keys(parsed.frontmatter),
      headings: noteHeadings(parsed),
      wikilinks_count: parsed.wikilinks.length,
      embeds_count: parsed.embeds.length,
      tags: parsed.tags,
      mtime: new Date(mtimeMs).toISOString(),
      byte_size: Buffer.byteLength(content, "utf8")
    };
  }

  return {
    path: entry.relPath,
    title: stripMd(entry.basename),
    content: parsed.body,
    frontmatter: parsed.frontmatter,
    wikilinks: parsed.wikilinks,
    embeds: parsed.embeds,
    tags: parsed.tags,
    mtime: new Date(mtimeMs).toISOString()
  };
}

/** Pull ATX headings (`#`, `##`, `###`, etc.) out of note body for the
 *  document-map projection. Skips ATX inside fenced code blocks via a simple
 *  line-by-line toggle on both backtick fences (` ``` `) and tilde fences
 *  (`~~~`) per CommonMark spec (v3.8.0-rc.10 P3-25).
 *
 *  v3.10.0-rc.47 (range-arithmetic) — `line` is FILE-absolute. `body` is the
 *  frontmatter-stripped content, so `i + 1` alone was BODY-relative and off by
 *  the frontmatter length for any note with YAML (an agent opening the file and
 *  jumping to a heading line would land too early). `bodyStartLine` (the file
 *  line where the body begins; 1 when there's no frontmatter) maps body line `i`
 *  to file line `bodyStartLine + i`. */

/**
 * Resolve an Obsidian wikilink string to a concrete vault file (or report
 * unresolved).
 *
 * Accepts the full wikilink syntax (`[[Target]]`, `[[Target|alias]]`,
 * `[[Target#section]]`, `[[Target^block]]`, `![[Embedded]]`) and parses out
 * the components. Resolution uses the project's fuzzy-match path — exact
 * basename, then in-folder, then global — same algorithm Obsidian uses
 * client-side. Pass `from_note` to bias resolution toward the same folder.
 *
 * @param vault - The vault to resolve against.
 * @param args - `wikilink` is required and may include or omit the
 *   `[[` ... `]]` brackets. `from_note` (vault-relative path) is the
 *   source note — used for folder-local resolution priority.
 *   `include_content` defaults to `true`; set false to skip the body read.
 * @returns `{ found, path, title, content, section, block, alias }`. When
 *   `found` is false all path/title/content are null but section/block/alias
 *   are still parsed (so the agent can report "broken link to
 *   `[[Foo#Bar]]`").
 * @example
 * ```ts
 * const r = await resolveWikilink(vault, {
 *   wikilink: "[[Hybrid Retrieval#BM25|the BM25 part]]",
 *   from_note: "Posts/2026/Article.md"
 * });
 * if (r.found) console.log(r.path, r.section, r.alias);
 * ```
 */
export async function resolveWikilink(
  vault: Vault,
  args: { wikilink: string; from_note?: string; include_content?: boolean }
): Promise<{
  found: boolean;
  path: string | null;
  title: string | null;
  content: string | null;
  section: string | null;
  block: string | null;
  alias: string | null;
}> {
  await vault.ensureExists();
  const cleaned = args.wikilink.replace(/^!?\[\[|\]\]$/g, "");
  const aliasIdx = cleaned.indexOf("|");
  const alias = aliasIdx === -1 ? null : cleaned.slice(aliasIdx + 1).trim();
  let rest = aliasIdx === -1 ? cleaned : cleaned.slice(0, aliasIdx);
  const blockIdx = rest.indexOf("^");
  const block = blockIdx === -1 ? null : rest.slice(blockIdx + 1).trim();
  rest = blockIdx === -1 ? rest : rest.slice(0, blockIdx);
  const hashIdx = rest.indexOf("#");
  const section = hashIdx === -1 ? null : rest.slice(hashIdx + 1).trim();
  const target = (hashIdx === -1 ? rest : rest.slice(0, hashIdx)).trim();

  if (!target) {
    return { found: false, path: null, title: null, content: null, section, block, alias };
  }

  const all = await vault.listMarkdown();
  const match = findBestMatch(all, target, args.from_note);
  if (!match) {
    return { found: false, path: null, title: null, content: null, section, block, alias };
  }
  let body: string | null = null;
  if (args.include_content !== false) {
    const { parsed } = await vault.readNote(match.absPath, match.mtimeMs);
    body = parsed.body;
  }
  return {
    found: true,
    path: match.relPath,
    title: stripMd(match.basename),
    content: body,
    section,
    block,
    alias
  };
}

/**
 * Recently-modified notes — the "what changed lately" view.
 *
 * Lighter-weight than {@link listNotes} when the caller doesn't need tag
 * filtering. Sorted by mtime descending. Use `since_minutes` for tight
 * windows ("what did I edit in the last hour?") rather than `since_date`.
 *
 * @param vault - The vault to scan.
 * @param args - All optional. `since_minutes` is a sliding window in
 *   minutes; omit for "everything, newest first". `limit` defaults to 20.
 *   `folder` restricts the scan.
 * @returns A {@link NoteSummary} array sorted by mtime desc.
 * @throws {VaultPathError} If `folder` resolves outside the vault.
 * @example
 * ```ts
 * // What did I edit in the last 2 hours?
 * const recent = await getRecentEdits(vault, { since_minutes: 120, limit: 10 });
 * ```
 */
export async function getRecentEdits(
  vault: Vault,
  args: { since_minutes?: number; limit?: number; folder?: string }
): Promise<NoteSummary[]> {
  await vault.ensureExists();
  const limit = args.limit ?? 20;
  const sinceMs = args.since_minutes !== undefined ? Date.now() - args.since_minutes * 60_000 : null;

  const entries = await vault.listMarkdown(args.folder);
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const out: NoteSummary[] = [];
  for (const e of entries) {
    if (sinceMs !== null && e.mtimeMs < sinceMs) break;
    const { parsed } = await vault.readNote(e.absPath, e.mtimeMs);
    out.push({
      title: stripMd(e.basename),
      path: e.relPath,
      frontmatter: parsed.frontmatter,
      tags: parsed.tags,
      mtime: new Date(e.mtimeMs).toISOString()
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** One stale-note row from {@link staleNotes}. */
export interface StaleNote {
  /** Vault-relative path. */
  path: string;
  /** `.md`-stripped basename for display. */
  title: string;
  /** ISO-8601 modification time. */
  mtime: string;
  /** Whole days since `mtime` (≥ the requested `stale_days` threshold). */
  age_days: number;
}

/** Envelope returned by {@link staleNotes}. */
export interface StaleNotesResponse {
  /** The staleness threshold applied (days). */
  stale_days: number;
  /** Total notes scanned (post-`folder` filter) — observability. */
  scanned_notes: number;
  /** Stale notes, OLDEST first, truncated to `limit`. */
  matches: StaleNote[];
}

/**
 * List notes not edited in `stale_days` days — the v3.10 forgetting-aware
 * "what's gone stale in my vault?" surface. Lets an agent proactively flag (or
 * refresh) aged facts rather than recalling them as if current (the Memora
 * frontier — see `computeStaleness` in `src/staleness.ts`).
 *
 * Cheap: a single metadata pass over `vault.listMarkdown()` mtimes — NO
 * `readNote` (so it's not a whole-vault content scan). Sorted oldest-first so
 * the most-stale notes surface at the top.
 *
 * @param vault - The vault.
 * @param args - All optional. `stale_days` (default `DEFAULT_STALE_DAYS` = 365),
 *   `limit` (default 50), `folder` restricts the scan.
 * @returns `{ stale_days, scanned_notes, matches }`, `matches` oldest-first.
 * @example
 * ```ts
 * const r = await staleNotes(vault, { stale_days: 180, limit: 20 });
 * for (const n of r.matches) console.log(`${n.path} — ${n.age_days}d old`);
 * ```
 */
export async function staleNotes(
  vault: Vault,
  args: { stale_days?: number; limit?: number; folder?: string }
): Promise<StaleNotesResponse> {
  await vault.ensureExists();
  const staleDays = args.stale_days ?? DEFAULT_STALE_DAYS;
  const limit = args.limit ?? 50;
  const now = Date.now();
  const entries = await vault.listMarkdown(args.folder);
  const stale: StaleNote[] = [];
  for (const e of entries) {
    const { age_days, stale: isStale } = computeStaleness(e.mtimeMs, now, staleDays);
    if (!isStale) continue;
    stale.push({
      path: e.relPath,
      title: stripMd(e.basename),
      mtime: new Date(e.mtimeMs).toISOString(),
      age_days
    });
  }
  stale.sort((a, b) => b.age_days - a.age_days); // oldest (most stale) first
  return { stale_days: staleDays, scanned_notes: entries.length, matches: stale.slice(0, limit) };
}

/**
 * One backlink hit — a note that links to the target.
 *
 * `count` is how many distinct links from that note point at the target
 * (a note can link to the same target multiple times). `snippets` includes
 * up to 2 context excerpts showing where the link appears.
 */
export interface BacklinkHit {
  /** Vault-relative path of the linking note. */
  path: string;
  /** `.md`-stripped basename for display. */
  title: string;
  /** Number of distinct links from this note to the target. Sort key (desc). */
  count: number;
  /** Up to 2 context excerpts showing the link in situ. */
  snippets: string[];
  /** Whether the links are wikilinks, embeds, or a mix. */
  link_kind: "wikilink" | "embed" | "mixed";
}

/**
 * Find every note that links to the target — the "who references this?"
 * query.
 *
 * Scans the full vault, so cost is O(N notes × parse). Use {@link getNoteNeighbors}
 * if you also need outbound links + tag siblings in one call. Sorted by
 * `count` desc (most-linking notes first).
 *
 * @param vault - The vault to search.
 * @param args - One of `path` or `title` is required to identify the target.
 *   `limit` defaults to 50. `include_embeds` defaults to `true` —
 *   set false to count only `[[wikilinks]]` and skip `![[embeds]]`.
 * @returns A {@link BacklinkHit} array sorted by `count` desc.
 * @throws {Error} If the target can't be resolved.
 * @example
 * ```ts
 * const backlinks = await getBacklinks(vault, {
 *   path: "Concepts/Vector Embeddings.md",
 *   limit: 25
 * });
 * for (const b of backlinks) {
 *   console.log(`${b.path} links ${b.count}x:`, b.snippets);
 * }
 * ```
 */
export async function getBacklinks(
  vault: Vault,
  args: { path?: string; title?: string; limit?: number; include_embeds?: boolean }
): Promise<BacklinkHit[]> {
  await vault.ensureExists();
  const limit = args.limit ?? 50;
  const includeEmbeds = args.include_embeds !== false;
  const target = await resolveTarget(vault, args);
  const targetAbs = target.absPath;
  const all = await vault.listMarkdown();

  const hits: BacklinkHit[] = [];
  for (const e of all) {
    if (e.absPath === targetAbs) continue;
    const { content, parsed } = await vault.readNote(e.absPath, e.mtimeMs);
    const linkBag: Array<{ link: Wikilink; kind: "wikilink" | "embed" }> = [
      ...parsed.wikilinks.map((l) => ({ link: l, kind: "wikilink" as const })),
      ...(includeEmbeds ? parsed.embeds.map((l) => ({ link: l, kind: "embed" as const })) : [])
    ];
    if (!linkBag.length) continue;

    let count = 0;
    const kindFlags = { wikilink: false, embed: false };
    const snippets: string[] = [];
    for (const { link, kind } of linkBag) {
      const match = findBestMatch(all, link.target, e.relPath);
      if (!match || match.absPath !== targetAbs) continue;
      count += 1;
      kindFlags[kind] = true;
      if (snippets.length < 2) {
        const literal = `${(kind === "embed" ? "![[" : "[[") + link.raw}]]`;
        const idx = content.indexOf(literal);
        const { snippet } = sliceSnippet(content, idx, literal.length);
        if (snippet) snippets.push(snippet);
      }
    }
    if (count === 0) continue;
    hits.push({
      path: e.relPath,
      title: stripMd(e.basename),
      count,
      snippets,
      link_kind: kindFlags.wikilink && kindFlags.embed ? "mixed" : kindFlags.embed ? "embed" : "wikilink"
    });
  }
  hits.sort((a, b) => b.count - a.count);
  return hits.slice(0, limit);
}

/**
 * Run a Dataview-style DQL query against the vault.
 *
 * Parses the input with the project's DQL frontend (see `src/dql.ts`) and
 * executes against the live vault index. Supports a subset of Dataview's
 * syntax: `TABLE` / `LIST` projections, `WHERE` clauses, `FROM "folder"` /
 * `FROM #tag` sources, `SORT`, `LIMIT`, `GROUP BY`. No formula evaluator —
 * pure field projection + boolean filters (formula evaluator deferred per
 * v3.6.0 non-goals).
 *
 * @param vault - The vault to query.
 * @param args - `query` is the DQL string.
 * @returns `{ query, rows }` — `rows` is an array of objects keyed by the
 *   projected fields.
 * @throws {Error} If the DQL fails to parse or references an unknown source.
 * @example
 * ```ts
 * const r = await dataviewQuery(vault, {
 *   query: 'TABLE status, mtime FROM "Posts" WHERE status = "draft" SORT mtime DESC'
 * });
 * for (const row of r.rows) console.log(row);
 * ```
 */
export async function dataviewQuery(
  vault: Vault,
  args: { query: string }
): Promise<{
  query: string;
  rows: Array<Record<string, unknown>>;
}> {
  await vault.ensureExists();
  const parsed = parseDql(args.query);
  const rows = await runDql(vault, parsed);
  return { query: args.query, rows };
}

/**
 * One unresolved (broken) wikilink — a `[[Target]]` that doesn't point to
 * any file in the vault.
 *
 * `line` + `snippet` give the agent enough context to fix the link in-place.
 */
export interface UnresolvedWikilink {
  /** Note containing the broken link. */
  from_path: string;
  /** Link target as written (e.g. `"Foo"`, `"Sub/Bar"`). */
  target: string;
  /** Raw inner-bracket text including any `|alias` / `#section` / `^block`. */
  raw: string;
  /** Whether the link is a normal `[[wikilink]]` or an `![[embed]]`. */
  kind: "wikilink" | "embed";
  /** Display alias, or null if absent. */
  alias: string | null;
  /** `#section` anchor, or null if absent. */
  section: string | null;
  /** `^block` anchor, or null if absent. */
  block: string | null;
  /** 1-based line number where the broken link appears. */
  line: number;
  /** ~120-char excerpt centered on the link. */
  snippet: string;
}

/**
 * Find every wikilink in the vault that doesn't resolve to a real file —
 * the "broken links" report.
 *
 * Useful for housekeeping: detecting moved/deleted notes, typos, or
 * orphaned `[[Future Note]]` placeholders. Cost is O(N notes × outbound).
 *
 * @param vault - The vault to scan.
 * @param args - All optional. `folder` restricts the source scan (broken
 *   links are still resolved against the full vault). `include_embeds`
 *   defaults to `true`. `limit` defaults to 200 — early-exits on hit count.
 * @returns Sorted in scan order (mtime desc per `vault.listMarkdown`).
 * @throws {VaultPathError} If `folder` resolves outside the vault.
 * @example
 * ```ts
 * const broken = await getUnresolvedWikilinks(vault, { limit: 50 });
 * for (const b of broken) {
 *   console.log(`${b.from_path}:${b.line} → [[${b.target}]]`);
 * }
 * ```
 */
export async function getUnresolvedWikilinks(
  vault: Vault,
  args: { folder?: string; include_embeds?: boolean; limit?: number }
): Promise<UnresolvedWikilink[]> {
  await vault.ensureExists();
  const limit = args.limit ?? 200;
  const includeEmbeds = args.include_embeds !== false;
  const entries = await vault.listMarkdown(args.folder);
  const all = await vault.listMarkdown();
  const out: UnresolvedWikilink[] = [];
  for (const e of entries) {
    if (out.length >= limit) break;
    const { content, parsed } = await vault.readNote(e.absPath, e.mtimeMs);
    const candidates: Array<{ link: Wikilink; kind: "wikilink" | "embed" }> = [
      ...parsed.wikilinks.map((l) => ({ link: l, kind: "wikilink" as const })),
      ...(includeEmbeds ? parsed.embeds.map((l) => ({ link: l, kind: "embed" as const })) : [])
    ];
    for (const { link, kind } of candidates) {
      if (out.length >= limit) break;
      if (!link.target) continue;
      const match = findBestMatch(all, link.target, e.relPath);
      if (match) continue;
      const literal = `${(kind === "embed" ? "![[" : "[[") + link.raw}]]`;
      const idx = content.indexOf(literal);
      const { snippet, line } = sliceSnippet(content, idx, literal.length);
      out.push({
        from_path: e.relPath,
        target: link.target,
        raw: link.raw,
        kind,
        alias: link.alias ?? null,
        section: link.section ?? null,
        block: link.block ?? null,
        line,
        snippet
      });
    }
  }
  return out;
}

/**
 * One outbound link from a source note. Both resolved and unresolved
 * variants share this shape — `resolved_path` is null when the target is
 * broken (and `include_unresolved` was true).
 */
export interface OutboundLink {
  /** Raw inner-bracket text. */
  raw: string;
  /** Link target as written. */
  target: string;
  /** Wikilink vs. embed. */
  kind: "wikilink" | "embed";
  /** Display alias, or null. */
  alias: string | null;
  /** `#section` anchor, or null. */
  section: string | null;
  /** `^block` anchor, or null. */
  block: string | null;
  /** Vault-relative path of the resolved target, or null if unresolved. */
  resolved_path: string | null;
  /** `.md`-stripped basename of the resolved target, or null. */
  resolved_title: string | null;
}

/**
 * List every link emanating from a single note, with resolved targets.
 *
 * The "outbound" complement to {@link getBacklinks}. Useful for building a
 * link-graph view of a note's neighborhood without paying for the inbound
 * scan. Resolution uses the same fuzzy match as {@link resolveWikilink},
 * biased toward the source note's folder.
 *
 * @param vault - The vault.
 * @param args - One of `path` or `title` is required. `include_embeds`
 *   defaults to `true`. `include_unresolved` defaults to `true` — set
 *   false to filter out broken targets.
 * @returns `{ from_path, from_title, links }` — `links` preserves the
 *   order links appear in the source note.
 * @throws {Error} If the source note can't be resolved.
 * @example
 * ```ts
 * const r = await getOutboundLinks(vault, {
 *   path: "Posts/2026/Article.md",
 *   include_unresolved: false
 * });
 * for (const link of r.links) console.log(link.target, "→", link.resolved_path);
 * ```
 */
export async function getOutboundLinks(
  vault: Vault,
  args: { path?: string; title?: string; include_embeds?: boolean; include_unresolved?: boolean }
): Promise<{ from_path: string; from_title: string; links: OutboundLink[] }> {
  await vault.ensureExists();
  const includeEmbeds = args.include_embeds !== false;
  const includeUnresolved = args.include_unresolved !== false;
  const entry = await resolveTarget(vault, args);
  const { parsed } = await vault.readNote(entry.absPath, entry.mtimeMs);
  const all = await vault.listMarkdown();
  const candidates: Array<{ link: Wikilink; kind: "wikilink" | "embed" }> = [
    ...parsed.wikilinks.map((l) => ({ link: l, kind: "wikilink" as const })),
    ...(includeEmbeds ? parsed.embeds.map((l) => ({ link: l, kind: "embed" as const })) : [])
  ];
  const links: OutboundLink[] = [];
  for (const { link, kind } of candidates) {
    const match = findBestMatch(all, link.target, entry.relPath);
    if (!match && !includeUnresolved) continue;
    links.push({
      raw: link.raw,
      target: link.target,
      kind,
      alias: link.alias ?? null,
      section: link.section ?? null,
      block: link.block ?? null,
      resolved_path: match ? match.relPath : null,
      resolved_title: match ? stripMd(match.basename) : null
    });
  }
  return {
    from_path: entry.relPath,
    from_title: stripMd(entry.basename),
    links
  };
}

/**
 * One row of the {@link listTags} response.
 *
 * Tracks frontmatter vs. inline occurrences separately — useful for
 * detecting tag drift (e.g. `#draft` inline that should be moved to
 * `tags: [draft]` in YAML).
 */
export interface TagSummary {
  /** Normalized tag (lowercased, no leading `#`). */
  tag: string;
  /** Total occurrences across the vault (frontmatter + inline). Sort key. */
  count: number;
  /** Occurrences in YAML `tags:` arrays. */
  frontmatter_count: number;
  /** Occurrences as inline `#tag` in note body. */
  inline_count: number;
}

/**
 * Build a tag-frequency dashboard for the vault.
 *
 * Aggregates every tag from both frontmatter (`tags: [foo, bar]`) and
 * inline (`#foo` in body) across all notes. Sorted by count descending,
 * tied by alphabetical. Cheap — single pass with the parser cache.
 *
 * @param vault - The vault.
 * @param args - All optional. `folder` restricts the scan. `min_count`
 *   filters tags below a threshold (default 1, i.e. include everything).
 *   `limit` defaults to 200.
 * @returns Sorted {@link TagSummary} array.
 * @throws {VaultPathError} If `folder` resolves outside the vault.
 * @example
 * ```ts
 * const top = await listTags(vault, { min_count: 5, limit: 30 });
 * for (const t of top) console.log(`#${t.tag}: ${t.count}`);
 * ```
 */
export async function listTags(
  vault: Vault,
  args: { folder?: string; min_count?: number; limit?: number }
): Promise<TagSummary[]> {
  await vault.ensureExists();
  const limit = args.limit ?? 200;
  const minCount = args.min_count ?? 1;
  const entries = await vault.listMarkdown(args.folder);
  const counts = new Map<string, { count: number; fm: number; inline: number }>();
  for (const e of entries) {
    const { parsed } = await vault.readNote(e.absPath, e.mtimeMs);
    const fmSet = new Set(extractFrontmatterTagsLower(parsed.frontmatter));
    for (const t of parsed.tags) {
      const key = foldTag(t); // v3.11.0-rc.9 (L-TAG-1) — NFC+case fold so accented tag forms count as one
      const slot = counts.get(key) ?? { count: 0, fm: 0, inline: 0 };
      slot.count += 1;
      if (fmSet.has(key)) slot.fm += 1;
      else slot.inline += 1;
      counts.set(key, slot);
    }
  }
  const out: TagSummary[] = [];
  for (const [tag, slot] of counts) {
    if (slot.count < minCount) continue;
    out.push({ tag, count: slot.count, frontmatter_count: slot.fm, inline_count: slot.inline });
  }
  out.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  return out.slice(0, limit);
}

// ─── obsidian_chat_thread (v2.2.0 — note-tethered AI conversations) ─────────
// Smart Connections' #1 paid feature: AI conversations bound to a specific
// note, persisted as markdown so they're searchable, version-controllable,
// and survive across sessions / clients. We ship the same UX MCP-native
// (works with Claude / Cursor / Codex / any agent), free.
//
// Wire format: messages stored as second-level headings under a parent
// `## Chat: <title>` heading, with role tag in the heading and timestamp.
//   ```md
//   ## Chat: research session — 2026-05-08T10:00Z
//
//   ### user · 2026-05-08T10:00Z
//   What did I write last week about RLHF?
//
//   ### assistant · 2026-05-08T10:00Z
//   You wrote three things: ...
//   ```
// This format is human-readable, parseable, and feeds back into our
// retrieval index — agents can search past chat threads by content.

/**
 * Arguments for {@link chatThreadAppend}.
 */
export interface ChatThreadAppendArgs {
  /** Vault-relative path to the note hosting the thread. Created if absent. */
  note_path: string;
  /** Role of the message being appended. */
  role: "user" | "assistant" | "system";
  /** Message body (markdown allowed). */
  content: string;
  /** Optional thread title — used when the note is created from scratch. */
  thread_title?: string;
}

/**
 * Parsed message row returned by {@link chatThreadRead}.
 *
 * `line_start` / `line_end` are 1-based and let the agent jump to or
 * surgically edit a single turn in the conversation.
 */
export interface ChatThreadMessage {
  /** Speaker role from the message heading. */
  role: "user" | "assistant" | "system";
  /** ISO-8601 timestamp from the heading (writer-supplied, not reparsed). */
  timestamp: string;
  /** Message body, trimmed. May contain markdown. */
  content: string;
  /** 1-based start line in the source note (for jumping to that point). */
  line_start: number;
  /** 1-based end line of this message. */
  line_end: number;
}

/**
 * Envelope returned by {@link chatThreadRead}.
 */
export interface ChatThreadReadResult {
  /** Vault-relative path of the source note. */
  note_path: string;
  /** Thread title from `## Chat: <title>`, or null if no chat block. */
  thread_title: string | null;
  /** Parsed messages in chronological order. */
  messages: ChatThreadMessage[];
  /** Convenience field — equal to `messages.length`. */
  message_count: number;
}

const CHAT_HEADING_RE = /^### (user|assistant|system) · (.+?)\s*$/;
// Multi-line flag: `## Chat:` heading can appear anywhere in the body, not
// only at string start. The append codepath uses .test(body); the read
// codepath uses .exec(line) per-line so the flag is harmless there.
const CHAT_THREAD_TITLE_RE = /^## Chat: (.+?)\s*$/m;

/**
 * Append a message to a note's chat thread — note-tethered AI conversations
 * persisted as markdown.
 *
 * Creates the note (and the `## Chat: <title>` parent heading) if absent.
 * Messages are stored as third-level headings with role + ISO timestamp
 * (`### user · 2026-05-08T10:00Z`). The format is human-readable, version-
 * controllable via git, and feeds back into the vault's retrieval index —
 * agents can search past threads by content like any other note.
 *
 * Appending always creates a fresh `### <role> · <timestamp>` block, never
 * mutates existing messages.
 *
 * CONCURRENCY CONTRACT (v3.10.0-rc.58, audit CONC-1): this is a read-modify-WRITE
 * (read the note → append in memory → `writeNote(overwrite)`), NOT an atomic
 * O_APPEND like `Vault.appendNote`. Two appends to the SAME `note_path` that
 * overlap (e.g. a client firing two without awaiting, or concurrent serve-http
 * requests) are a lost-update window: both read body B, and the second write
 * (B + msg2) overwrites the first (B + msg1), dropping msg1. Callers MUST
 * serialize appends to a given thread note (await each before the next). This is
 * an accepted design characteristic — the heading-injection / new-note branches
 * genuinely need a full write, so routing through atomic append is deferred.
 *
 * @param vault - The vault. Must allow writes (i.e. the server was started
 *   with `--enable-writes`).
 * @param args - `note_path`, `role`, `content` are required. `thread_title`
 *   is used only when creating a brand-new note from scratch.
 * @returns The note's vault-relative path plus the 1-based line range of
 *   the appended message (for jumping the UI to it).
 * @throws {Error} If `note_path` or `content` is empty, or `role` is not
 *   a valid value.
 * @example
 * ```ts
 * await chatThreadAppend(vault, {
 *   note_path: "Threads/Research-2026-05-08.md",
 *   role: "user",
 *   content: "What did I write last week about RLHF?",
 *   thread_title: "RLHF research session"
 * });
 * ```
 */
export async function chatThreadAppend(
  vault: Vault,
  args: ChatThreadAppendArgs
): Promise<{ note_path: string; line_start: number; line_end: number }> {
  await vault.ensureExists();
  if (!args.note_path?.trim()) throw new Error("chat_thread_append: `note_path` is required");
  if (!args.content?.trim()) throw new Error("chat_thread_append: `content` is required");
  const role = args.role;
  if (role !== "user" && role !== "assistant" && role !== "system") {
    throw new Error(`chat_thread_append: invalid role "${role}" (must be user|assistant|system)`);
  }
  const targetRel = args.note_path.toLowerCase().endsWith(".md") ? args.note_path : `${args.note_path}.md`;
  const abs = vault.resolveInside(targetRel);
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const messageBlock = `\n### ${role} · ${timestamp}\n\n${args.content.trim()}\n`;

  // Read existing or create new with thread heading.
  let existed = true;
  let body = "";
  try {
    body = await vault.readFile(abs);
  } catch {
    existed = false;
  }
  let toAppend: string;
  if (existed && CHAT_THREAD_TITLE_RE.test(body)) {
    // Existing thread — just append message.
    toAppend = messageBlock;
  } else if (existed) {
    // Existing note without a chat heading — add heading first.
    const title = args.thread_title?.trim() || `chat — ${timestamp.slice(0, 10)}`;
    toAppend = `\n\n## Chat: ${title}\n${messageBlock}`;
  } else {
    // New note from scratch.
    const title = args.thread_title?.trim() || `chat — ${timestamp.slice(0, 10)}`;
    toAppend = `# ${title}\n\n## Chat: ${title}\n${messageBlock}`;
  }
  // v3.10.0-rc.55 (CT-LINE-OFFBY1) + v3.10.0-rc.50 (CODE-2 range-arithmetic class) —
  // line_start/line_end must address the file ACTUALLY written AND point AT the
  // appended message's `### role · ts` heading. Pre-rc.55 line_start counted newlines
  // in the pre-append body + 1, which landed one line BEFORE the heading (the prior
  // content line / a blank line), and the new-note branch hardcoded `4` — actually the
  // blank line, since the heading is on line 5. Now derive both from the heading marker
  // in the FINAL written content, so all three branches are correct (and frontmatter-
  // free of off-by-N). `existed` ⇒ overwrite; new note ⇒ create (no clobber).
  const trimmed = existed ? stripTrailingNewlines(body) : "";
  const newBody = trimmed + toAppend;
  const result = await vault.writeNote(targetRel, newBody, { overwrite: existed });
  const headingMarker = `### ${role} · ${timestamp}`;
  // v3.10.0-rc.58 (CT-LASTINDEXOF-COLLISION) — anchor the offset to the APPENDED block, not
  // the whole document: `newBody.lastIndexOf` could match a byte-identical line inside
  // `args.content` (if it embeds the exact same-second `### role · ts` marker) → line_start
  // into user content / past EOF. `toAppend` contains exactly ONE real heading, and it always
  // PRECEDES any user-content copy within `messageBlock` (`\n### role · ts\n\n<content>\n`),
  // so `indexOf` (first occurrence) inside `toAppend` is collision-proof.
  const appendOffset = toAppend.indexOf(headingMarker);
  const headingOffset = appendOffset >= 0 ? trimmed.length + appendOffset : -1;
  const lineStart =
    headingOffset >= 0 ? splitLines(newBody.slice(0, headingOffset)).length : countLineBreaks(trimmed) + 1;
  // line_end spans through the message's last content line: the heading line plus the
  // newline count of the trimmed message block (heading → blank → content[…]).
  const lineEnd = lineStart + countLineBreaks(messageBlock.trim());
  return { note_path: result.relPath, line_start: lineStart, line_end: lineEnd };
}

/**
 * Parse a note's chat thread into structured messages.
 *
 * Reads the chat block delimited by `## Chat: <title>` and parses each
 * `### <role> · <timestamp>` sub-heading into a {@link ChatThreadMessage}.
 * Non-chat content (anything outside the chat block) is ignored. Returns
 * `thread_title: null` and an empty `messages` array if the note has no
 * chat block.
 *
 * @param vault - The vault.
 * @param args - `note_path` is the vault-relative path to the thread note.
 * @returns A {@link ChatThreadReadResult} with parsed messages in
 *   chronological order.
 * @throws {VaultPathError} If `note_path` resolves outside the vault.
 * @throws {Error} If the note doesn't exist.
 * @example
 * ```ts
 * const thread = await chatThreadRead(vault, {
 *   note_path: "Threads/Research-2026-05-08.md"
 * });
 * for (const msg of thread.messages) {
 *   console.log(`[${msg.timestamp}] ${msg.role}: ${msg.content}`);
 * }
 * ```
 */
export async function chatThreadRead(vault: Vault, args: { note_path: string }): Promise<ChatThreadReadResult> {
  await vault.ensureExists();
  const targetRel = args.note_path.toLowerCase().endsWith(".md") ? args.note_path : `${args.note_path}.md`;
  const abs = vault.resolveInside(targetRel);
  const body = await vault.readFile(abs);
  const lines = splitLines(body);
  let threadTitle: string | null = null;
  let inThread = false;
  const messages: ChatThreadMessage[] = [];
  let current: { role: ChatThreadMessage["role"]; timestamp: string; line_start: number; lines: string[] } | null =
    null;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i] ?? "";
    const titleMatch = CHAT_THREAD_TITLE_RE.exec(ln);
    if (titleMatch) {
      if (current) {
        messages.push({
          role: current.role,
          timestamp: current.timestamp,
          content: current.lines.join("\n").trim(),
          line_start: current.line_start,
          line_end: i
        });
        current = null;
      }
      threadTitle = (titleMatch[1] ?? "").trim();
      inThread = true;
      continue;
    }
    if (!inThread) continue;
    // Higher-level heading or a different `## Chat:` block ends the thread.
    if (/^# /.test(ln) || (/^## /.test(ln) && !CHAT_THREAD_TITLE_RE.test(ln))) {
      if (current) {
        messages.push({
          role: current.role,
          timestamp: current.timestamp,
          content: current.lines.join("\n").trim(),
          line_start: current.line_start,
          line_end: i
        });
        current = null;
      }
      inThread = false;
      continue;
    }
    const headingMatch = CHAT_HEADING_RE.exec(ln);
    if (headingMatch?.[1] && headingMatch[2]) {
      if (current) {
        messages.push({
          role: current.role,
          timestamp: current.timestamp,
          content: current.lines.join("\n").trim(),
          line_start: current.line_start,
          line_end: i
        });
      }
      current = {
        role: headingMatch[1] as ChatThreadMessage["role"],
        timestamp: headingMatch[2].trim(),
        line_start: i + 1,
        lines: []
      };
      continue;
    }
    if (current) current.lines.push(ln);
  }
  if (current) {
    messages.push({
      role: current.role,
      timestamp: current.timestamp,
      content: current.lines.join("\n").trim(),
      line_start: current.line_start,
      line_end: lines.length
    });
  }
  return {
    note_path: vault.toRel(abs),
    thread_title: threadTitle,
    messages,
    message_count: messages.length
  };
}

// ─── obsidian_frontmatter_{get,set,search} (v2.3.0 — atomic YAML ops) ──────
// Surgical YAML manipulation. Pre-fix, agents wanting to set `status:
// published` on 12 notes had to find/replace text — error-prone (multi-line
// strings, special chars, key-collision). Now: parse via `parseFrontmatter`
// (js-yaml@5), edit, rewrite. Delimiter-aware (frontmatter is delimited
// strictly by leading `---`, so no fence ambiguity).
//
// _get is read-only; _set + _delete are write-gated.

/**
 * Read a note's frontmatter — full map, or a single key's value.
 *
 * The read-only counterpart to `frontmatterSet` (write side). Use this
 * before bulk-editing frontmatter so the agent can reason about current
 * state before issuing a write. When `key` is set, the response includes
 * the resolved `value` (which may be `undefined` if the key is absent).
 *
 * @remarks Trust boundary — this is an in-process API that trusts its
 * `key` argument's length. The MCP boundary (`obsidian_frontmatter_get` in
 * `tool-registry.ts`) caps `key` at `MAX_FRONTMATTER_KEY_LEN` (256, rc.13
 * AUD-04) so a remote bearer client cannot drive an unbounded multi-MB key
 * through the per-note `lookupFoldedKey` fold; direct internal callers are
 * not capped and must pass sane keys.
 *
 * @param vault - The vault to read from.
 * @param args - One of `path` or `title` is required. `key` narrows the
 *   response to a single value.
 * @returns `{ path, frontmatter, value? }` — `value` is only included when
 *   `key` is set.
 * @throws {Error} If the target can't be resolved.
 * @example
 * ```ts
 * // Read all frontmatter
 * const all = await frontmatterGet(vault, { path: "Posts/Article.md" });
 *
 * // Read a single key
 * const just = await frontmatterGet(vault, {
 *   path: "Posts/Article.md",
 *   key: "status"
 * });
 * console.log(just.value); // → "draft"
 * ```
 */
export async function frontmatterGet(
  vault: Vault,
  args: { path?: string; title?: string; key?: string }
): Promise<{ path: string; frontmatter: Record<string, unknown>; value?: unknown }> {
  await vault.ensureExists();
  const target = await resolveTarget(vault, args);
  const note = await vault.readNote(target.absPath, target.mtimeMs);
  if (args.key) {
    return {
      path: target.relPath,
      frontmatter: note.parsed.frontmatter,
      // v3.11.0-rc.10 (H1) — case/NFC-insensitive key resolution (Obsidian property
      // names are case-insensitive); was a raw exact-string `frontmatter[args.key]`.
      value: lookupFoldedKey(note.parsed.frontmatter, args.key).value
    };
  }
  return { path: target.relPath, frontmatter: note.parsed.frontmatter };
}

/**
 * Predicate-based frontmatter query — arguments to {@link frontmatterSearch}.
 *
 * Exactly one of `equals` / `exists` / `contains` must be set:
 * - `equals: <value>`   — strict equality (JSON.stringify comparison)
 * - `exists: true`      — key must exist (any value, including `false` / `0` / `null`)
 * - `contains: <value>` — for array values, value must be a member
 */
export interface FrontmatterSearchArgs {
  /** Frontmatter key to match against. */
  key: string;
  /** Strict equality predicate (JSON.stringify comparison). */
  equals?: unknown;
  /** Existence predicate — when `true`, matches notes where `key` is present at all. */
  exists?: boolean;
  /** Array-membership predicate. Matches when `frontmatter[key]` is an array containing this value. */
  contains?: unknown;
  /** Restrict scan to a subdirectory (vault-relative). */
  folder?: string;
  /** Result cap (default 100). */
  limit?: number;
}

/**
 * Find every note whose frontmatter matches a predicate.
 *
 * Useful as a precursor to bulk operations like {@link frontmatterSet}:
 * "find all notes with `status: draft` and set their status to `published`",
 * or "find notes whose `aliases` array contains a typo". Single predicate
 * per call by design — combine with multiple calls if you need AND/OR logic.
 *
 * @remarks Trust boundary — in-process API that trusts its `key` length.
 * The MCP boundary (`obsidian_frontmatter_search` in `tool-registry.ts`)
 * caps `key` at `MAX_FRONTMATTER_KEY_LEN` (256, rc.13 AUD-04) so a remote
 * bearer client cannot drive an unbounded multi-MB key through the
 * whole-vault per-note `nfcLower(key)` fold; direct internal callers are
 * not capped and must pass sane keys.
 *
 * @param vault - The vault to scan.
 * @param args - {@link FrontmatterSearchArgs}. `key` is required and
 *   exactly one of `equals` / `exists` / `contains` must be set.
 * @returns `{ key, total_matches, matches }` — `total_matches` equals
 *   `matches.length` (counts the truncated result, not the full count).
 * @throws {Error} If `key` is empty or the predicate count is not exactly 1.
 * @throws {VaultPathError} If `folder` resolves outside the vault.
 * @example
 * ```ts
 * // Find every draft
 * const drafts = await frontmatterSearch(vault, {
 *   key: "status",
 *   equals: "draft",
 *   limit: 50
 * });
 *
 * // Find every note whose `aliases` array contains "RAG"
 * const rag = await frontmatterSearch(vault, {
 *   key: "aliases",
 *   contains: "RAG"
 * });
 * ```
 */
export async function frontmatterSearch(
  vault: Vault,
  args: FrontmatterSearchArgs
): Promise<{
  key: string;
  total_matches: number;
  matches: Array<{ path: string; value: unknown; mtime: string }>;
}> {
  await vault.ensureExists();
  if (!args.key) throw new Error("frontmatter_search: `key` is required");
  const predicates = [args.equals !== undefined, args.exists !== undefined, args.contains !== undefined].filter(
    Boolean
  );
  if (predicates.length !== 1) {
    throw new Error("frontmatter_search: exactly one of `equals` / `exists` / `contains` must be set");
  }
  const limit = args.limit ?? 100;
  // v3.11.0-rc.21 — hoist the predicate's JSON.stringify OUT of the per-note loop
  // (it is loop-invariant). Pre-rc.21 this re-stringified the (schema-capped) value
  // once per note across the whole vault — an O(notes × valueLen) amplifier.
  const equalsJson = args.equals !== undefined ? JSON.stringify(args.equals) : undefined;
  const containsJson = args.contains !== undefined ? JSON.stringify(args.contains) : undefined;
  const entries = await vault.listMarkdown(args.folder);
  const matches: Array<{ path: string; value: unknown; mtime: string }> = [];
  for (const e of entries) {
    if (matches.length >= limit) break;
    try {
      const note = await vault.readNote(e.absPath, e.mtimeMs);
      // v3.11.0-rc.10 (H1) — case/NFC-insensitive key resolution; was exact-string.
      const value = lookupFoldedKey(note.parsed.frontmatter, args.key).value;
      let hit = false;
      if (args.exists === true) hit = value !== undefined;
      else if (equalsJson !== undefined) hit = JSON.stringify(value) === equalsJson;
      else if (containsJson !== undefined) {
        if (Array.isArray(value)) {
          hit = value.some((v) => JSON.stringify(v) === containsJson);
        }
      }
      if (hit) {
        matches.push({ path: e.relPath, value, mtime: new Date(e.mtimeMs).toISOString() });
      }
    } catch {
      // skip unparseable notes
    }
  }
  return { key: args.key, total_matches: matches.length, matches };
}

// ─── obsidian_get_note_neighbors (v0.13 graph-aware context) ─────────────────
// Return a note + its 1-hop graph neighborhood — outbound links + backlinks +
// tag-cluster siblings. Designed as the canonical "give the LLM enough context
// to reason about this note" call: instead of read_note → backlinks → outbound
// → resolve_wikilink (4 round-trips), one call returns the node and its edges.

/**
 * One-hop graph neighborhood around a target note — returned by
 * {@link getNoteNeighbors}.
 *
 * Three orthogonal "neighbor" buckets:
 * - `outbound` — notes the target links to
 * - `inbound`  — notes that link to the target (with backlink count)
 * - `tag_siblings` — notes sharing ≥1 tag, excluding outbound/inbound
 */
export interface NoteNeighbors {
  /** The target note (the graph center). */
  center: {
    path: string;
    title: string;
    tags: string[];
    mtime: string;
  };
  /** Notes the center links to. Bounded by `max_per_bucket`. */
  outbound: Array<{ path: string; title: string; tags: string[] }>;
  /** Notes linking to the center, sorted by `count` desc. Bounded by `max_per_bucket`. */
  inbound: Array<{ path: string; title: string; tags: string[]; count: number }>;
  /** Notes sharing ≥1 tag, excluding outbound/inbound. Bounded by `max_per_bucket`. */
  tag_siblings: Array<{ path: string; title: string; shared_tags: string[] }>;
}

/**
 * Return a note and its 1-hop graph neighborhood — outbound links +
 * backlinks + tag-cluster siblings in one call.
 *
 * Designed as the canonical "give the LLM enough context to reason about
 * this note" call. Pre-fix, the agent had to chain 4 round-trips
 * (`read_note` → `get_backlinks` → `get_outbound_links` →
 * `resolve_wikilink` × N). This collapses them into one structured graph
 * view at the cost of a full vault scan.
 *
 * @param vault - The vault.
 * @param args - One of `path` or `title` is required. `max_per_bucket`
 *   caps each bucket independently (default 20).
 * @returns A {@link NoteNeighbors} with center + 3 sorted neighbor buckets.
 * @throws {Error} If the target can't be resolved.
 * @example
 * ```ts
 * const ctx = await getNoteNeighbors(vault, {
 *   path: "Concepts/Hybrid Retrieval.md",
 *   max_per_bucket: 10
 * });
 * console.log("Linked from:", ctx.inbound.length, "notes");
 * console.log("Tag siblings:", ctx.tag_siblings.map(s => s.title));
 * ```
 */
export async function getNoteNeighbors(
  vault: Vault,
  args: { path?: string; title?: string; max_per_bucket?: number }
): Promise<NoteNeighbors> {
  await vault.ensureExists();
  const cap = args.max_per_bucket ?? 20;
  const target = await resolveTarget(vault, args);
  // rc.36 F-5 (R-5/AS#5 sibling) — cap the whole-vault scan: getNoteNeighbors
  // does TWO full-vault readNote passes (inbound backlinks + tag-siblings) and
  // builds an inbound-count map. Defense-in-depth against a pathological vault
  // over serve-http; output is a bounded top-K per bucket, so a partial scan on
  // an absurdly large vault only trims the neighbor tail.
  const entries = capScanEntries(await vault.listMarkdown(), "obsidian_get_note_neighbors");
  const { parsed: targetParsed } = await vault.readNote(target.absPath, target.mtimeMs);
  const targetTagsLower = new Set(targetParsed.tags.map((t) => foldTag(t)));

  // Outbound: resolved unique destinations from the target.
  const seenOut = new Set<string>();
  const outbound: NoteNeighbors["outbound"] = [];
  for (const link of targetParsed.wikilinks) {
    const m = findBestMatch(entries, link.target, target.relPath);
    if (!m || seenOut.has(m.relPath)) continue;
    // v3.11.4-rc.2 (full-audit NEIGHBORS-OUTBOUND-CAP-2) — track EVERY resolved outbound
    // destination in seenOut (a cheap O(1) indexed lookup) so the tag_siblings exclude set
    // below is complete; only the expensive readNote + DISPLAY is capped at `cap`. Pre-fix the
    // loop broke at `cap`, leaving outbound dests past the cap out of seenOut, so a genuine
    // outbound neighbor that also shared a tag was mis-surfaced as a tag_sibling.
    seenOut.add(m.relPath);
    if (outbound.length < cap) {
      const { parsed: nbrParsed } = await vault.readNote(m.absPath, m.mtimeMs);
      outbound.push({ path: m.relPath, title: stripMd(m.basename), tags: nbrParsed.tags });
    }
  }

  // Inbound: notes that link to target, with backlink count.
  const inboundCounts = new Map<string, { entry: FileEntry; count: number; tags: string[] }>();
  for (const e of entries) {
    if (e.absPath === target.absPath) continue;
    const { parsed } = await vault.readNote(e.absPath, e.mtimeMs);
    let cnt = 0;
    for (const link of parsed.wikilinks) {
      const m = findBestMatch(entries, link.target, e.relPath);
      if (m && m.absPath === target.absPath) cnt += 1;
    }
    if (cnt > 0) inboundCounts.set(e.relPath, { entry: e, count: cnt, tags: parsed.tags });
  }
  const inbound: NoteNeighbors["inbound"] = [...inboundCounts.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, cap)
    .map((x) => ({ path: x.entry.relPath, title: stripMd(x.entry.basename), tags: x.tags, count: x.count }));

  // Tag siblings: notes sharing ≥1 tag with target, excluding outbound/inbound.
  const tag_siblings: NoteNeighbors["tag_siblings"] = [];
  if (targetTagsLower.size > 0) {
    const exclude = new Set<string>([target.relPath, ...seenOut, ...inboundCounts.keys()]);
    const candidates: Array<{ path: string; title: string; shared: string[] }> = [];
    for (const e of entries) {
      if (exclude.has(e.relPath)) continue;
      const { parsed } = await vault.readNote(e.absPath, e.mtimeMs);
      const shared: string[] = [];
      for (const t of parsed.tags) {
        if (targetTagsLower.has(foldTag(t))) shared.push(t);
      }
      if (shared.length > 0) {
        candidates.push({ path: e.relPath, title: stripMd(e.basename), shared });
      }
    }
    candidates.sort((a, b) => b.shared.length - a.shared.length);
    for (const c of candidates.slice(0, cap)) {
      tag_siblings.push({ path: c.path, title: c.title, shared_tags: c.shared });
    }
  }

  return {
    center: {
      path: target.relPath,
      title: stripMd(target.basename),
      tags: targetParsed.tags,
      mtime: new Date(target.mtimeMs).toISOString()
    },
    outbound,
    inbound,
    tag_siblings
  };
}

// ─── obsidian_stats (v0.13 vault dashboard) ──────────────────────────────────
// Single-shot vault summary the LLM can call once at the start of a session
// to orient itself. Cheap signals only — no full-text scan.

/**
 * Vault-wide dashboard returned by {@link getVaultStats}.
 *
 * All counts are computed in a single pass over the markdown corpus so
 * cost is O(N notes × parse). `orphans` are notes with neither inbound nor
 * outbound links. `broken_wikilinks` is the total count of unresolved
 * `[[targets]]` (use {@link getUnresolvedWikilinks} for the per-link details).
 */
export interface VaultStats {
  /** Total `.md` files in the vault (post-exclusion filtering). */
  total_notes: number;
  /** Sum of UTF-8 byte sizes across all notes. */
  total_size_bytes: number;
  /** Average words per note, rounded. Zero if vault is empty. */
  avg_note_words: number;
  /** Notes with mtime in the last 7 days. */
  recently_modified_7d: number;
  /** Notes with no inbound AND no outbound wikilinks. */
  orphans: number;
  /** Total count of `[[targets]]` that fail to resolve to any note. */
  broken_wikilinks: number;
  /** Distinct tag count (normalized: lowercase, deduplicated). */
  total_tags: number;
  /** Top N tags by frequency, sorted desc. N = `args.top_tags ?? 10`. */
  top_tags: Array<{ tag: string; count: number }>;
  /** Notes whose frontmatter is non-empty. */
  notes_with_frontmatter: number;
  /** ISO-8601 timestamp of report generation. */
  generated_at: string;
}

/**
 * One-shot vault dashboard the LLM can call at the start of a session to
 * orient itself.
 *
 * Cheap structural signals only — no full-text scan, no embedding. Useful
 * as a "first call" for an agent to understand the corpus shape (size,
 * recency, link-graph health) before issuing specific reads.
 *
 * @param vault - The vault.
 * @param args - `top_tags` controls how many top tags are returned
 *   (default 10).
 * @returns A {@link VaultStats} snapshot.
 * @example
 * ```ts
 * const stats = await getVaultStats(vault, { top_tags: 20 });
 * console.log(`${stats.total_notes} notes, ${stats.orphans} orphans`);
 * console.log("Top tags:", stats.top_tags.slice(0, 5));
 * ```
 */
export async function getVaultStats(vault: Vault, args: { top_tags?: number }): Promise<VaultStats> {
  await vault.ensureExists();
  const topTagsLimit = args.top_tags ?? 10;
  const entries = await vault.listMarkdown();
  const sevenDaysMs = Date.now() - 7 * 24 * 3600 * 1000;

  let totalSize = 0;
  let totalWords = 0;
  let recent = 0;
  let withFm = 0;
  const tagCounts = new Map<string, number>();
  // Build inbound map in one pass so orphans and broken counts are O(N).
  const inbound = new Map<string, number>();
  let broken = 0;
  // outboundPresence is collected in the same single pass (cache hits keep
  // this O(N) instead of the previous O(2N) re-read).
  const outboundPresence = new Set<string>();
  for (const e of entries) {
    const { content, parsed } = await vault.readNote(e.absPath, e.mtimeMs);
    totalSize += Buffer.byteLength(content, "utf8");
    totalWords += content.trim() ? content.trim().split(/\s+/).length : 0;
    if (e.mtimeMs >= sevenDaysMs) recent += 1;
    if (Object.keys(parsed.frontmatter).length > 0) withFm += 1;
    if (parsed.wikilinks.length > 0) outboundPresence.add(e.relPath);
    for (const t of parsed.tags) {
      const key = foldTag(t); // v3.11.0-rc.9 (L-TAG-1) — NFC+case fold for top-tag counting
      tagCounts.set(key, (tagCounts.get(key) ?? 0) + 1);
    }
    for (const link of parsed.wikilinks) {
      const m = findBestMatch(entries, link.target, e.relPath);
      if (!m) {
        broken += 1;
        continue;
      }
      inbound.set(m.relPath, (inbound.get(m.relPath) ?? 0) + 1);
    }
  }
  let orphans = 0;
  for (const e of entries) {
    if (!inbound.get(e.relPath) && !outboundPresence.has(e.relPath)) orphans += 1;
  }
  const top_tags = [...tagCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, topTagsLimit)
    .map(([tag, count]) => ({ tag, count }));

  return {
    total_notes: entries.length,
    total_size_bytes: totalSize,
    avg_note_words: entries.length === 0 ? 0 : Math.round(totalWords / entries.length),
    recently_modified_7d: recent,
    orphans,
    broken_wikilinks: broken,
    total_tags: tagCounts.size,
    top_tags,
    notes_with_frontmatter: withFm,
    generated_at: new Date().toISOString()
  };
}
