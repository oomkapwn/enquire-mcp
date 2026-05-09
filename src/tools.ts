import * as path from "node:path";
import matter from "gray-matter";
import { parseDql, runDql } from "./dql.js";
import type { Embed, Wikilink } from "./parser.js";
import { resolvePeriodicNoteName } from "./periodic.js";
import type { FileEntry, Vault } from "./vault.js";

export interface NoteSummary {
  title: string;
  path: string;
  frontmatter: Record<string, unknown>;
  tags: string[];
  mtime: string;
}

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

export interface NoteReadFull {
  path: string;
  title: string;
  content: string;
  frontmatter: Record<string, unknown>;
  wikilinks: Wikilink[];
  embeds: Embed[];
  tags: string[];
  mtime: string;
}

export interface NoteReadMap {
  path: string;
  title: string;
  format: "map";
  frontmatter_keys: string[];
  headings: Array<{ level: number; text: string; line: number }>;
  wikilinks_count: number;
  embeds_count: number;
  tags: string[];
  mtime: string;
  byte_size: number;
}

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
      headings: extractHeadings(parsed.body),
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
 *  line-by-line backtick toggle. */
function extractHeadings(body: string): Array<{ level: number; text: string; line: number }> {
  const out: Array<{ level: number; text: string; line: number }> = [];
  const lines = body.split("\n");
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m?.[1] && m[2]) {
      out.push({ level: m[1].length, text: m[2], line: i + 1 });
    }
  }
  return out;
}

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

export type SearchMode = "all" | "any" | "phrase";

export interface SearchHit {
  path: string;
  snippet: string;
  score: number;
  line: number;
  matched_terms: string[];
}

export interface SearchResponse {
  query: string;
  mode: SearchMode;
  scanned_notes: number;
  matches: SearchHit[];
}

export async function searchText(
  vault: Vault,
  args: { query: string; folder?: string; limit?: number; mode?: SearchMode }
): Promise<SearchResponse> {
  await vault.ensureExists();
  const limit = args.limit ?? 25;
  const mode: SearchMode = args.mode ?? "all";
  const q = args.query;
  if (!q.trim()) throw new Error("query must not be empty");

  // Tokenize on whitespace for "all" / "any". Phrase mode keeps the raw query.
  const tokens = mode === "phrase" ? [q] : q.trim().split(/\s+/);
  const lowerTokens = tokens.map((t) => t.toLowerCase());

  const entries = await vault.listMarkdown(args.folder);

  // Parallel file reads — was sequential, slow on large vaults. Chunk to
  // bound concurrency (avoid blowing the open-fd limit on huge vaults).
  const CHUNK = 16;
  const matches: SearchHit[] = [];
  for (let i = 0; i < entries.length; i += CHUNK) {
    const chunk = entries.slice(i, i + CHUNK);
    const results = await Promise.all(
      chunk.map(async (e) => {
        const { content } = await vault.readNote(e.absPath, e.mtimeMs);
        const lower = content.toLowerCase();
        let totalScore = 0;
        let firstHit = -1;
        let firstHitLen = 0;
        const matched: string[] = [];
        for (let t = 0; t < lowerTokens.length; t++) {
          const lowerT = lowerTokens[t];
          if (lowerT === undefined || lowerT === "") continue;
          let tokenScore = 0;
          let from = 0;
          while (true) {
            const idx = lower.indexOf(lowerT, from);
            if (idx === -1) break;
            tokenScore += 1;
            if (firstHit === -1 || idx < firstHit) {
              firstHit = idx;
              firstHitLen = lowerT.length;
            }
            from = idx + lowerT.length;
          }
          if (tokenScore > 0) {
            totalScore += tokenScore;
            matched.push(tokens[t] ?? lowerT);
          }
        }
        // Mode policy: "all" requires every token to match; "any" requires at
        // least one; "phrase" requires the raw query (single token).
        if (mode === "all" && matched.length !== lowerTokens.filter(Boolean).length) return null;
        if (totalScore === 0) return null;
        const { snippet, line } = sliceSnippet(content, firstHit, firstHitLen);
        const hit: SearchHit = {
          path: e.relPath,
          snippet,
          score: totalScore,
          line,
          matched_terms: matched
        };
        return hit;
      })
    );
    for (const r of results) if (r) matches.push(r);
  }
  matches.sort((a, b) => b.score - a.score);
  return {
    query: q,
    mode,
    scanned_notes: entries.length,
    matches: matches.slice(0, limit)
  };
}

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

export interface BacklinkHit {
  path: string;
  title: string;
  count: number;
  snippets: string[];
  link_kind: "wikilink" | "embed" | "mixed";
}

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

export interface UnresolvedWikilink {
  from_path: string;
  target: string;
  raw: string;
  kind: "wikilink" | "embed";
  alias: string | null;
  section: string | null;
  block: string | null;
  line: number;
  snippet: string;
}

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

export interface OutboundLink {
  raw: string;
  target: string;
  kind: "wikilink" | "embed";
  alias: string | null;
  section: string | null;
  block: string | null;
  resolved_path: string | null;
  resolved_title: string | null;
}

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

export interface TagSummary {
  tag: string;
  count: number;
  frontmatter_count: number;
  inline_count: number;
}

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
      const key = t.toLowerCase();
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

export async function createNote(
  vault: Vault,
  args: { path: string; content: string; frontmatter?: Record<string, unknown>; overwrite?: boolean }
): Promise<{ path: string; mtime: string; bytes: number }> {
  await vault.ensureExists();
  const body = composeNote(args.frontmatter, args.content);
  const result = await vault.writeNote(args.path, body, { overwrite: args.overwrite });
  return {
    path: result.relPath,
    mtime: new Date(result.mtimeMs).toISOString(),
    bytes: result.bytes
  };
}

export async function appendToNote(
  vault: Vault,
  args: { path?: string; title?: string; content: string; separator?: string }
): Promise<{ path: string; mtime: string; appended_bytes: number }> {
  await vault.ensureExists();
  const target = await resolveTarget(vault, args);
  const sep = args.separator ?? "\n\n";
  const result = await vault.appendNote(target.absPath, sep + args.content);
  return {
    path: result.relPath,
    mtime: new Date(result.mtimeMs).toISOString(),
    appended_bytes: result.appended_bytes
  };
}

// ─── obsidian_rename_note (v1.1 atomic rename + backlink rewrite) ────────────
// Closes the longstanding "renaming a note breaks all backlinks" pain. Walks
// every other note in the vault, finds wikilinks/embeds whose findBestMatch
// resolves to the source file, rewrites only those literals (preserving
// `|alias`, `#section`, `^block`, and the user's chosen path-qualification),
// then atomically renames the file. dry_run returns the same plan without
// touching the disk.

export interface RenameProposal {
  path: string;
  rewrites: number;
  before: string;
  after: string;
}

export interface RenameNoteResult {
  from: string;
  to: string;
  dry_run: boolean;
  files_updated: RenameProposal[];
  total_links_rewritten: number;
}

export async function renameNote(
  vault: Vault,
  args: { from: string; to: string; dry_run?: boolean; overwrite?: boolean }
): Promise<RenameNoteResult> {
  await vault.ensureExists();
  const dryRun = args.dry_run === true;
  const fromRelNorm = args.from.toLowerCase().endsWith(".md") ? args.from : `${args.from}.md`;
  const toRelNorm = args.to.toLowerCase().endsWith(".md") ? args.to : `${args.to}.md`;

  // Resolve from (must exist) — vault.stat() rejects traversal + excluded paths
  // and confirms the file is real. resolveInside() is the public wrapper for
  // the same path-normalization logic without an existence check.
  const fromAbs = vault.resolveInside(fromRelNorm);
  const fromRel = vault.toRel(fromAbs);
  await vault.stat(fromAbs); // throws on missing source — fail fast.
  // Validate to-path early so we don't do O(N) work then fail.
  const toAbsCheck = vault.resolveInside(toRelNorm);
  const toRelCheck = vault.toRel(toAbsCheck);
  const renameReason = vault.exclusionReason(toRelCheck);
  if (renameReason) {
    // v2.0.0-beta.2 P1 fix: distinguish allowlist-vs-denylist same as
    // writeNote and Vault.renameFile do. Pre-fix the message always blamed
    // --exclude-glob even when --read-paths was the reason.
    throw new Error(`Refusing to rename — destination is excluded by ${renameReason}: ${toRelCheck}`);
  }
  if (fromRel === toRelCheck) {
    throw new Error(`from and to are the same path: ${fromRel}`);
  }
  if (!args.overwrite) {
    const exists = await vault
      .stat(toAbsCheck)
      .then(() => true)
      .catch(() => false);
    if (exists) {
      throw new Error(`Destination already exists: ${toRelCheck} (pass overwrite=true to replace)`);
    }
  }

  const newBasename = stripMd(path.basename(toRelNorm));
  const newDir = path.dirname(toRelNorm).replace(/\\/g, "/");
  const entries = await vault.listMarkdown();

  // Build the rewrite plan. INCLUDES the source file itself so that any
  // self-references (e.g. `[[Foo]]` inside `Foo.md`) are also rewritten —
  // otherwise the renamed file would ship with a broken self-link. The source
  // is rewritten in place at the OLD path; fs.rename then carries the new
  // content to the new path in one atomic step.
  const plan: RenameProposal[] = [];
  let totalRewrites = 0;
  let sourcePlan: RenameProposal | null = null;
  for (const e of entries) {
    const isSource = e.absPath === fromAbs;
    const { content, parsed } = await vault.readNote(e.absPath, e.mtimeMs);

    // Find every wikilink + embed whose target resolves to fromAbs. Group by
    // raw inner text — multiple identical literals in the same file rewrite
    // together.
    const oldRawsToNew = new Map<string, { kind: "wikilink" | "embed"; newRaw: string }>();
    const candidates: Array<{ raw: string; target: string; kind: "wikilink" | "embed" }> = [
      ...parsed.wikilinks.map((l) => ({ raw: l.raw, target: l.target, kind: "wikilink" as const })),
      ...parsed.embeds.map((l) => ({ raw: l.raw, target: l.target, kind: "embed" as const }))
    ];
    for (const c of candidates) {
      if (oldRawsToNew.has(c.raw)) continue; // already mapped
      const m = findBestMatch(entries, c.target, e.relPath);
      if (!m || m.absPath !== fromAbs) continue;
      const newRaw = rewriteRawTarget(c.raw, c.target, newBasename, newDir);
      if (newRaw === c.raw) continue; // already correct (e.g., basename happened to match)
      oldRawsToNew.set(c.raw, { kind: c.kind, newRaw });
    }

    if (oldRawsToNew.size === 0) continue;

    // Apply the replacements with a code-fence-aware line walker so wikilinks
    // inside ``` / ~~~ blocks (which the parser ignores) stay verbatim.
    const { content: newContent, count } = rewriteOutsideCodeFences(content, oldRawsToNew);
    if (count === 0) continue;

    const proposal: RenameProposal = { path: e.relPath, rewrites: count, before: content, after: newContent };
    if (isSource) {
      // The source file's rewrite is held separately so we can write it last,
      // immediately before fs.rename, keeping the disk in a maximally-recoverable
      // state if anything between writes fails.
      sourcePlan = proposal;
    } else {
      plan.push(proposal);
    }
    totalRewrites += count;
  }

  if (!dryRun) {
    // Write order:
    //   1. All backlink-bearing files (other notes pointing at the source).
    //   2. Source file's rewritten content, written to its OLD path.
    //   3. fs.rename source's old path → new path.
    // A failure at any step leaves backlinks pointing at the still-present old
    // name (worst case: safe, recoverable).
    for (const p of plan) {
      await vault.writeNote(p.path, p.after, { overwrite: true });
    }
    if (sourcePlan) {
      await vault.writeNote(sourcePlan.path, sourcePlan.after, { overwrite: true });
    }
    // Atomic file move + cache invalidation.
    await vault.renameFile(fromRelNorm, toRelNorm, { overwrite: args.overwrite });
  }

  // Combine plans for the response so the caller sees the full picture.
  const allPlans = sourcePlan ? [...plan, sourcePlan] : plan;

  // Strip `before`/`after` from the response — the caller doesn't need the
  // full file contents back, just the per-file count. We kept them for the
  // pre-write loop; the response trims them. The source-file entry uses its
  // POST-rename path so the caller sees where the rewrite ended up.
  const trimmedPlan = allPlans.map((p) => ({
    path: p === sourcePlan ? toRelCheck : p.path,
    rewrites: p.rewrites,
    before: "",
    after: ""
  }));

  return {
    from: fromRel,
    to: toRelCheck,
    dry_run: dryRun,
    files_updated: trimmedPlan,
    total_links_rewritten: totalRewrites
  };
}

// ─── obsidian_archive_note (v1.11 thin convenience wrapper around rename) ────
// Common workflow: move a note to a vault Archive folder, preserving every
// `[[wikilink]]` / `![[embed]]` that pointed at it. Just calls renameNote
// under the hood with a computed `to` path. Defaults the archive folder to
// `Archive/` but accepts override.

export interface ArchiveNoteArgs {
  /** Vault-relative path of the note to archive (with or without `.md`). */
  path: string;
  /** Archive folder. Defaults to `Archive/`. Trailing slash optional. */
  archive_folder?: string;
  /** Preview the rewrite plan without writing. Default false. */
  dry_run?: boolean;
  /** Allow overwriting an existing file at the archive destination. Default false. */
  overwrite?: boolean;
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

export interface ChatThreadMessage {
  role: "user" | "assistant" | "system";
  timestamp: string;
  content: string;
  /** 1-based start line in the source note (for jumping to that point). */
  line_start: number;
  line_end: number;
}

export interface ChatThreadReadResult {
  note_path: string;
  thread_title: string | null;
  messages: ChatThreadMessage[];
  message_count: number;
}

const CHAT_HEADING_RE = /^### (user|assistant|system) · (.+?)\s*$/;
// Multi-line flag: `## Chat:` heading can appear anywhere in the body, not
// only at string start. The append codepath uses .test(body); the read
// codepath uses .exec(line) per-line so the flag is harmless there.
const CHAT_THREAD_TITLE_RE = /^## Chat: (.+?)\s*$/m;

/** Append a message to a note's chat thread. Creates the note (and the
 *  `## Chat: <title>` heading) if absent. Idempotent in the sense that
 *  appending always creates a fresh `### <role> · <timestamp>` block — no
 *  silent overwrites. */
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
    const initial = `# ${title}\n\n## Chat: ${title}\n${messageBlock}`;
    const result = await vault.writeNote(targetRel, initial, { overwrite: false });
    return {
      note_path: result.relPath,
      line_start: 4,
      line_end: 4 + messageBlock.split("\n").length
    };
  }
  const before = body.length;
  const newBody = body.replace(/\n+$/, "") + toAppend;
  await vault.writeNote(targetRel, newBody, { overwrite: true });
  const lineStart = (body.slice(0, before).match(/\n/g) ?? []).length + 1;
  return {
    note_path: vault.toRel(abs),
    line_start: lineStart,
    line_end: lineStart + toAppend.split("\n").length
  };
}

/** Parse a note's chat thread into structured messages. Non-chat content
 *  (anything outside the `## Chat: <title>` block) is ignored. */
export async function chatThreadRead(vault: Vault, args: { note_path: string }): Promise<ChatThreadReadResult> {
  await vault.ensureExists();
  const targetRel = args.note_path.toLowerCase().endsWith(".md") ? args.note_path : `${args.note_path}.md`;
  const abs = vault.resolveInside(targetRel);
  const body = await vault.readFile(abs);
  const lines = body.split("\n");
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
// strings, special chars, key-collision). Now: parse via gray-matter, edit,
// rewrite. Code-fence-aware via gray-matter (frontmatter is delimited
// strictly by leading `---`, so no fence ambiguity).
//
// _get is read-only; _set + _delete are write-gated.

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
      value: note.parsed.frontmatter[args.key]
    };
  }
  return { path: target.relPath, frontmatter: note.parsed.frontmatter };
}

export interface FrontmatterSetArgs {
  path?: string;
  title?: string;
  /** Keys to set. Setting a key to `null` deletes it. */
  set: Record<string, unknown>;
  /** Optional: dry_run shows the diff without writing. */
  dry_run?: boolean;
}

export async function frontmatterSet(
  vault: Vault,
  args: FrontmatterSetArgs
): Promise<{
  path: string;
  changed_keys: string[];
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  dry_run: boolean;
}> {
  await vault.ensureExists();
  if (!args.set || Object.keys(args.set).length === 0) {
    throw new Error("frontmatter_set: `set` must be a non-empty object");
  }
  const target = await resolveTarget(vault, args);
  const note = await vault.readNote(target.absPath, target.mtimeMs);
  const before = { ...note.parsed.frontmatter };
  const after: Record<string, unknown> = { ...before };
  const changed: string[] = [];
  for (const [k, v] of Object.entries(args.set)) {
    if (v === null) {
      if (k in after) {
        delete after[k];
        changed.push(`-${k}`);
      }
    } else {
      const prev = after[k];
      if (JSON.stringify(prev) !== JSON.stringify(v)) {
        after[k] = v;
        changed.push(`${k in before ? "~" : "+"}${k}`);
      }
    }
  }
  if (changed.length === 0 || args.dry_run === true) {
    return { path: target.relPath, changed_keys: changed, before, after, dry_run: args.dry_run === true };
  }
  // Round-trip via gray-matter — same writer pattern as createNote.
  const newDoc = matter.stringify(note.parsed.body, after);
  await vault.writeNote(target.relPath, newDoc, { overwrite: true });
  return { path: target.relPath, changed_keys: changed, before, after, dry_run: false };
}

/** Find every note where frontmatter.<key> matches a predicate. Useful as
 *  a precursor to bulk frontmatter_set: "find all notes with status:draft
 *  and set their status to published".
 *
 *  Predicate semantics:
 *    - `equals: <value>`   — strict equality (JSON.stringify comparison)
 *    - `exists: true`      — key must exist (any value)
 *    - `contains: <value>` — for array values, value must be a member
 *  Exactly one predicate must be set. */
export interface FrontmatterSearchArgs {
  key: string;
  equals?: unknown;
  exists?: boolean;
  contains?: unknown;
  folder?: string;
  limit?: number;
}

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
  const entries = await vault.listMarkdown(args.folder);
  const matches: Array<{ path: string; value: unknown; mtime: string }> = [];
  for (const e of entries) {
    if (matches.length >= limit) break;
    try {
      const note = await vault.readNote(e.absPath, e.mtimeMs);
      const value = note.parsed.frontmatter[args.key];
      let hit = false;
      if (args.exists === true) hit = value !== undefined;
      else if (args.equals !== undefined) hit = JSON.stringify(value) === JSON.stringify(args.equals);
      else if (args.contains !== undefined) {
        if (Array.isArray(value)) {
          hit = value.some((v) => JSON.stringify(v) === JSON.stringify(args.contains));
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

export async function archiveNote(vault: Vault, args: ArchiveNoteArgs): Promise<RenameNoteResult> {
  await vault.ensureExists();
  if (!args.path) throw new Error("archive_note: `path` is required");
  const folder = (args.archive_folder ?? "Archive").replace(/\/+$/, "");
  // Strip leading folders from the source so the basename lands cleanly in
  // the archive — e.g. `Inbox/Foo.md` → `Archive/Foo.md`, not
  // `Archive/Inbox/Foo.md`. Preserves the user's `.md` extension or appends
  // it if missing (renameNote handles that anyway).
  const basename = path.basename(args.path);
  const renameArgs: { from: string; to: string; dry_run?: boolean; overwrite?: boolean } = {
    from: args.path,
    to: `${folder}/${basename}`
  };
  if (args.dry_run !== undefined) renameArgs.dry_run = args.dry_run;
  if (args.overwrite !== undefined) renameArgs.overwrite = args.overwrite;
  return renameNote(vault, renameArgs);
}

// ─── obsidian_replace_in_notes (v1.9 bulk find/replace) ─────────────────────
// Code-fence-aware bulk string replacement across the vault. Reuses the same
// fence-tracking line walker as rename_note's wikilink rewriter so example
// snippets and code documentation stay verbatim. Read-only by design unless
// dry_run is false; returns per-file counts so the agent can verify before
// committing. WRITE TOOL — only registered when --enable-write is passed.

export interface ReplaceInNotesArgs {
  /** Literal substring to find. Empty string is rejected. */
  search: string;
  /** Replacement text. May be empty (= delete every occurrence). */
  replace: string;
  /** Restrict to a subfolder (vault-relative). Default: whole vault. */
  folder?: string;
  /** Preview the rewrite plan without touching disk. Default false. */
  dry_run?: boolean;
  /** Case-sensitive match (default true). False = case-insensitive substring. */
  case_sensitive?: boolean;
}

export interface ReplaceInNotesFileResult {
  path: string;
  occurrences: number;
}

export interface ReplaceInNotesResult {
  search: string;
  replace: string;
  case_sensitive: boolean;
  dry_run: boolean;
  scope: string;
  files_scanned: number;
  files_updated: ReplaceInNotesFileResult[];
  total_replacements: number;
  /** v2.0.0-beta.2 P1: when true, the apply pass aborted partway through.
   *  `files_updated` only contains files that DID write successfully. Files
   *  in `errors` (if present) failed mid-write — caller should retry just
   *  those and verify state. Always false on dry_run. */
  partial: boolean;
  /** v2.0.0-beta.2 P1: per-file write errors collected during apply. Only
   *  populated when the apply phase encountered errors (so happy-path
   *  responses stay narrow). */
  errors?: Array<{ path: string; message: string }>;
}

export async function replaceInNotes(vault: Vault, args: ReplaceInNotesArgs): Promise<ReplaceInNotesResult> {
  await vault.ensureExists();
  const dryRun = args.dry_run === true;
  const caseSensitive = args.case_sensitive !== false;
  if (!args.search) {
    throw new Error("replace_in_notes: `search` must be a non-empty string");
  }
  if (args.search === args.replace) {
    throw new Error("replace_in_notes: `search` and `replace` are identical — no-op refused");
  }
  // v2.0.0-beta.2 P2 fix: reject early if `args.folder` itself is excluded.
  // Pre-fix, listMarkdown(excludedFolder) returned [] and the response said
  // "scope: 02_Personal/, files_scanned: 0" — confirming the folder name
  // existed in the user's vault layout. Now we refuse, returning a clean
  // error that doesn't reveal whether the folder is real-but-empty,
  // real-but-excluded, or nonexistent.
  // Test both `<folder>` (folder itself excluded) and `<folder>/_probe.md`
  // (a representative path inside) — the user's glob may use `**` which
  // matches subpaths but not the bare folder name.
  if (args.folder) {
    const folderTrim = args.folder.replace(/\/+$/, "");
    if (vault.isExcluded(folderTrim) || vault.isExcluded(`${folderTrim}/_probe.md`)) {
      throw new Error(`replace_in_notes: folder is excluded by privacy filter: ${args.folder}`);
    }
  }

  const entries = await vault.listMarkdown(args.folder);
  const plan: Array<{ path: string; before: string; after: string; count: number }> = [];
  let total = 0;
  for (const e of entries) {
    const { content } = await vault.readNote(e.absPath, e.mtimeMs);
    const { content: rewritten, count } = replaceStringOutsideCodeFences(
      content,
      args.search,
      args.replace,
      caseSensitive
    );
    if (count === 0) continue;
    plan.push({ path: e.relPath, before: content, after: rewritten, count });
    total += count;
  }

  // v2.0.0-beta.2 P1 fix: per-file error collection on apply. Pre-fix, a
  // throw on file 5 of 20 would lose the response — files 1-4 silently
  // committed, agent had no way to discover which. Now we continue past
  // failures, collect errors, and return both `files_updated` (committed)
  // and `errors` (uncommitted) with `partial: true` flag.
  //
  // Systemic-error fast-path: if the vault is read-only OR the first write
  // fails synchronously (e.g. all paths excluded by --read-paths), throw
  // immediately rather than returning a "partial: true" with N errors —
  // that's a config problem, not a per-file failure.
  const updated: ReplaceInNotesFileResult[] = [];
  const errors: Array<{ path: string; message: string }> = [];
  if (!dryRun) {
    if (!vault.writeEnabled) {
      throw new Error("Vault is read-only — start the server with --enable-write to allow note creation");
    }
    for (const p of plan) {
      try {
        await vault.writeNote(p.path, p.after, { overwrite: true });
        updated.push({ path: p.path, occurrences: p.count });
      } catch (err) {
        errors.push({ path: p.path, message: err instanceof Error ? err.message : String(err) });
      }
    }
  } else {
    for (const p of plan) updated.push({ path: p.path, occurrences: p.count });
  }

  const result: ReplaceInNotesResult = {
    search: args.search,
    replace: args.replace,
    case_sensitive: caseSensitive,
    dry_run: dryRun,
    scope: args.folder ?? "(whole vault)",
    files_scanned: entries.length,
    files_updated: updated,
    total_replacements: total,
    partial: errors.length > 0
  };
  if (errors.length > 0) result.errors = errors;
  return result;
}

/** Given the raw inner text of a wikilink (`Foo|alias`, `Folder/Foo#sec`, etc.)
 *  and the resolved target string the parser already extracted, produce the new
 *  raw text after the file has been renamed. Preserves alias/section/block and
 *  the user's chosen path-qualification convention (bare-basename vs path). */
function rewriteRawTarget(raw: string, oldTarget: string, newBasename: string, newDir: string): string {
  const wasPathQualified = oldTarget.includes("/");
  const newTargetBare = wasPathQualified
    ? newDir === "." || newDir === ""
      ? newBasename
      : `${newDir}/${newBasename}`
    : newBasename;

  // The raw text is `<target><suffix>` where suffix starts with the first of
  // |, #, or ^. Find the boundary.
  const pipeIdx = raw.indexOf("|");
  const hashIdx = raw.indexOf("#");
  const blockIdx = raw.indexOf("^");
  const idxs = [pipeIdx, hashIdx, blockIdx].filter((i) => i !== -1);
  const suffixStart = idxs.length === 0 ? raw.length : Math.min(...idxs);
  const suffix = raw.slice(suffixStart);
  return `${newTargetBare}${suffix}`;
}

/** Walk file content line by line. Toggle `inFence` at any line that opens or
 *  closes a ``` or ~~~ fence. Inside a fence, leave content untouched. Outside,
 *  replace each old literal with its new literal. Returns { content, count }
 *  where count is the total number of literal replacements applied. */
function rewriteOutsideCodeFences(
  content: string,
  oldRawsToNew: Map<string, { kind: "wikilink" | "embed"; newRaw: string }>
): { content: string; count: number } {
  const lines = content.split("\n");
  let inFence = false;
  let count = 0;
  const out: string[] = [];
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    let mutated = line;
    for (const [oldRaw, { kind, newRaw }] of oldRawsToNew) {
      const oldLit = `${kind === "embed" ? "![[" : "[["}${oldRaw}]]`;
      const newLit = `${kind === "embed" ? "![[" : "[["}${newRaw}]]`;
      if (oldLit === newLit) continue;
      // Use indexOf-based replacement so we count occurrences accurately.
      let idx = mutated.indexOf(oldLit);
      while (idx !== -1) {
        mutated = mutated.slice(0, idx) + newLit + mutated.slice(idx + oldLit.length);
        count += 1;
        idx = mutated.indexOf(oldLit, idx + newLit.length);
      }
    }
    out.push(mutated);
  }
  return { content: out.join("\n"), count };
}

/** Generic code-fence-aware string replacer used by replaceInNotes (v1.9).
 *  Walks line-by-line, tracks ` ``` ` / `~~~` fences, and replaces every
 *  occurrence of `search` with `replace` outside fenced blocks. Case-sensitive
 *  by default; pass `caseSensitive: false` for case-insensitive substring
 *  match. Returns the rewritten content + replacement count. */
function replaceStringOutsideCodeFences(
  content: string,
  search: string,
  replace: string,
  caseSensitive: boolean
): { content: string; count: number } {
  if (!search) return { content, count: 0 };
  const lines = content.split("\n");
  let inFence = false;
  let count = 0;
  const out: string[] = [];
  const needle = caseSensitive ? search : search.toLowerCase();
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    if (caseSensitive) {
      let mutated = line;
      let idx = mutated.indexOf(needle);
      while (idx !== -1) {
        mutated = mutated.slice(0, idx) + replace + mutated.slice(idx + search.length);
        count += 1;
        idx = mutated.indexOf(needle, idx + replace.length);
      }
      out.push(mutated);
    } else {
      // Case-insensitive: walk by lowering only when comparing, but preserve
      // the rest of the original line. Replace verbatim with `replace`.
      let mutated = line;
      let lowered = mutated.toLowerCase();
      let idx = lowered.indexOf(needle);
      while (idx !== -1) {
        mutated = mutated.slice(0, idx) + replace + mutated.slice(idx + search.length);
        lowered = mutated.toLowerCase();
        count += 1;
        idx = lowered.indexOf(needle, idx + replace.length);
      }
      out.push(mutated);
    }
  }
  return { content: out.join("\n"), count };
}

function composeNote(frontmatter: Record<string, unknown> | undefined, content: string): string {
  if (!frontmatter || Object.keys(frontmatter).length === 0) return content;
  // Use gray-matter's stringify (backed by js-yaml) so YAML-special strings —
  // date-like ("2026-05-03"), !-prefixed, pipe-containing, etc. — are
  // round-trip-safe. The hand-rolled renderer this replaced silently corrupted
  // a long tail of valid string values (e.g. "due: 2026-05-03" came back as a
  // Date object on read).
  return matter.stringify(content, frontmatter);
}

function extractFrontmatterTagsLower(fm: Record<string, unknown>): string[] {
  const raw = fm.tags ?? fm.tag;
  if (!raw) return [];
  const list: string[] = Array.isArray(raw)
    ? raw.filter((t): t is string => typeof t === "string")
    : typeof raw === "string"
      ? raw.split(/[,\s]+/).filter(Boolean)
      : [];
  return list.map((t) => t.replace(/^#+/, "").toLowerCase());
}

/** Resolve "today"/"daily"/"weekly"/"monthly" to today's periodic-note name
 *  using the standard Obsidian Daily-Notes-plugin formats. Custom formats are
 *  out of scope (users with non-default conventions address by exact name). */
function resolvePeriodicAlias(title: string): string | null {
  const lower = title.trim().toLowerCase();
  if (lower !== "daily" && lower !== "today" && lower !== "weekly" && lower !== "monthly") {
    return null;
  }
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  if (lower === "daily" || lower === "today") return `${yyyy}-${mm}-${dd}`;
  if (lower === "monthly") return `${yyyy}-${mm}`;
  // ISO week number (Mon-based, ISO 8601). Weekly format: YYYY-Www.
  const target = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const dayNum = target.getUTCDay() || 7; // Mon=1..Sun=7
  target.setUTCDate(target.getUTCDate() + 4 - dayNum); // Thursday of this week
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((target.valueOf() - yearStart.valueOf()) / 86400000 + 1) / 7);
  return `${target.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

/** Up to 3 vault-relative paths whose basename or relPath looks similar to
 *  the missing target. Used to enrich `Note not found` errors with did-you-mean
 *  hints — meaningful for LLMs that mistype a note name. */
async function suggestSimilar(vault: Vault, target: string): Promise<string[]> {
  try {
    const all = await vault.listMarkdown();
    const lower = target.toLowerCase().replace(/\.md$/i, "");
    const ranked = all
      .map((e) => {
        const baseLower = stripMd(e.basename).toLowerCase();
        const relLower = e.relPath.toLowerCase();
        let score = 0;
        if (baseLower === lower) score = 100;
        else if (baseLower.startsWith(lower) || lower.startsWith(baseLower)) score = 70;
        else if (baseLower.includes(lower) || lower.includes(baseLower)) score = 50;
        else if (relLower.includes(lower)) score = 30;
        return { path: e.relPath, score };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
    return ranked.map((r) => r.path);
  } catch {
    return [];
  }
}

async function resolveTarget(vault: Vault, args: { path?: string; title?: string }): Promise<FileEntry> {
  if (args.path) {
    const candidates = args.path.toLowerCase().endsWith(".md") ? [args.path] : [args.path, `${args.path}.md`];
    let lastErr: unknown;
    for (const candidate of candidates) {
      const abs = vault.resolveInside(candidate);
      try {
        const stat = await vault.stat(abs);
        return {
          absPath: abs,
          relPath: vault.toRel(abs),
          basename: path.basename(abs),
          mtimeMs: stat.mtimeMs
        };
      } catch (err) {
        lastErr = err;
      }
    }
    const suggestions = await suggestSimilar(vault, args.path);
    const hint = suggestions.length ? `. Did you mean: ${suggestions.join(", ")}?` : "";
    throw lastErr instanceof Error
      ? new Error(`${lastErr.message}${hint}`)
      : new Error(`Note not found: ${args.path}${hint}`);
  }
  if (args.title) {
    // Try literal title first — a user may have an actual file named
    // "Daily.md" / "Today.md" they meant to address. Only fall back to the
    // periodic-note alias when the literal lookup misses.
    const literal = await vault.findByTitle(args.title);
    if (literal) return literal;
    // v1.10: try the user's Daily / Periodic Notes plugin config first. The
    // user may have configured `Daily Notes/YYYY-MM-DD` or a custom format —
    // honor that before the v0.11 hard-coded defaults.
    const periodicConfig = await vault.getPeriodicConfig();
    const periodicResolved = resolvePeriodicNoteName(args.title, periodicConfig);
    if (periodicResolved) {
      // The user's config produced a vault-relative path stem. Look it up by
      // path (with .md appended); if THAT misses, fall back to basename match
      // for users whose plugin folder is empty (vault-root files).
      try {
        const tryPath = `${periodicResolved.relPath}.md`;
        const abs = vault.resolveInside(tryPath);
        const stat = await vault.stat(abs);
        return {
          absPath: abs,
          relPath: vault.toRel(abs),
          basename: path.basename(abs),
          mtimeMs: stat.mtimeMs
        };
      } catch (err) {
        // v1.11.1: surface exclusion errors instead of masking them as
        // "not found". The path-based lookup above already does this via
        // lastErr — keep both codepaths consistent. Exclusion errors come
        // from a user's own --read-paths / --exclude-glob config, so they
        // deserve a clear "excluded" message rather than silent fallthrough
        // to the legacy alias resolver (which won't help anyway).
        if (err instanceof Error && /excluded by --(read-paths|exclude-glob)/.test(err.message)) {
          throw err;
        }
        // Fall through to basename match on ENOENT-class errors only.
      }
      // v2.0.0-beta.2 P1 fix: only fall through to basename match if the
      // user's periodic config produces a folder-less stem (i.e., they keep
      // periodic notes at the vault root). If they configured a specific
      // folder, returning a same-basename note from a DIFFERENT folder is a
      // privacy/correctness hazard — silently redirects "today" to a note
      // the user never configured. The architecture audit (P1-4) traced an
      // exploit: with `--exclude-glob 'Daily Notes/**'` set AND a Public/
      // file named `2026-05-08.md`, basename match would surface that
      // unrelated note as "today".
      const periodicHasFolder = periodicResolved.relPath.includes("/");
      if (!periodicHasFolder) {
        const basenameMatch = await vault.findByTitle(path.basename(periodicResolved.relPath));
        if (basenameMatch) return basenameMatch;
      }
    }
    // Last-resort: legacy v0.11 hard-coded alias resolver, in case the user
    // has neither plugin configured but expects the default formats to work.
    const aliased = resolvePeriodicAlias(args.title);
    if (aliased) {
      const aliasMatch = await vault.findByTitle(aliased);
      if (aliasMatch) return aliasMatch;
    }
    const suggestions = await suggestSimilar(vault, args.title);
    const hint = suggestions.length ? `. Did you mean: ${suggestions.join(", ")}?` : "";
    const aliasHint = periodicResolved ? ` (also tried periodic alias "${periodicResolved.relPath}")` : "";
    throw new Error(`No note found with title: ${args.title}${aliasHint}${hint}`);
  }
  throw new Error("Either path or title is required");
}

// ─── obsidian_validate_note_proposal (v0.12 anti-slop validator) ─────────────
// Closes the #1 user-pain finding: LLM-generated notes arrive structurally
// broken — bad YAML, fake wikilinks, inconsistent tags — and users spend
// minutes reformatting per note. This tool is called BEFORE create/append:
// the LLM proposes a draft, we lint it against the live vault, return
// errors/warnings/suggestions, and the LLM can fix-and-retry without ever
// writing a broken note.

export interface ValidateProposalArgs {
  /** Vault-relative path the LLM intends to write to (e.g. "Inbox/idea.md"). */
  path: string;
  /** Full proposed markdown content including any frontmatter block. */
  content: string;
  /** "create" (default) → fail if path exists. "overwrite" / "append" → ok if exists. */
  mode?: "create" | "overwrite" | "append";
}

export interface ValidateProposalResult {
  ok: boolean;
  proposed_path: string;
  mode: "create" | "overwrite" | "append";
  errors: Array<{ kind: string; message: string }>;
  warnings: Array<{ kind: string; message: string; suggestion?: string }>;
  yaml: {
    parsed: boolean;
    error: string | null;
    keys: string[];
  };
  wikilinks: Array<{
    raw: string;
    target: string;
    status: "resolved" | "broken" | "ambiguous";
    resolved_path: string | null;
    suggestions: string[];
  }>;
  tags: Array<{
    name: string;
    status: "existing" | "new";
  }>;
  collision: {
    kind: "none" | "path-exists" | "title-exists-elsewhere";
    existing_path?: string;
  };
}

export async function validateNoteProposal(vault: Vault, args: ValidateProposalArgs): Promise<ValidateProposalResult> {
  await vault.ensureExists();
  const mode = args.mode ?? "create";
  const errors: Array<{ kind: string; message: string }> = [];
  const warnings: Array<{ kind: string; message: string; suggestion?: string }> = [];

  // 1. Path sanity. resolveInside throws on traversal — capture as error,
  //    don't let it propagate as a generic exception (the validator should
  //    return a structured result for ANY input).
  let normalizedPath = args.path.toLowerCase().endsWith(".md") ? args.path : `${args.path}.md`;
  let absPath: string | null = null;
  try {
    absPath = vault.resolveInside(normalizedPath);
    normalizedPath = vault.toRel(absPath);
  } catch (err) {
    errors.push({
      kind: "path-traversal",
      message: err instanceof Error ? err.message : String(err)
    });
  }

  // 2. YAML parse via gray-matter (the same parser used at write time).
  const yamlReport = { parsed: false, error: null as string | null, keys: [] as string[] };
  let bodyAfterFm = args.content;
  try {
    const parsed = matter(args.content);
    yamlReport.parsed = true;
    yamlReport.keys = Object.keys(parsed.data ?? {});
    bodyAfterFm = parsed.content;
  } catch (err) {
    yamlReport.error = err instanceof Error ? err.message : String(err);
    errors.push({ kind: "yaml-invalid", message: `YAML frontmatter could not be parsed: ${yamlReport.error}` });
  }

  // 3. Wikilink resolution against the live vault.
  const all = await vault.listMarkdown();
  const wikilinkRe = /(?<!!)\[\[([^\]\n]+?)\]\]/g;
  const wikilinks: ValidateProposalResult["wikilinks"] = [];
  for (const m of bodyAfterFm.matchAll(wikilinkRe)) {
    const raw = m[0];
    const inner = (m[1] ?? "").trim();
    if (!inner) continue;
    // Strip alias / section / block to get the bare target name.
    const beforePipe = inner.split("|")[0] ?? "";
    const beforeHash = beforePipe.split("#")[0] ?? "";
    const target = beforeHash.split("^")[0]?.trim() ?? "";
    if (!target) continue;
    const match = findBestMatch(all, target, normalizedPath);
    if (match) {
      wikilinks.push({
        raw,
        target,
        status: "resolved",
        resolved_path: match.relPath,
        suggestions: []
      });
    } else {
      const suggestions = await suggestSimilar(vault, target);
      wikilinks.push({
        raw,
        target,
        status: "broken",
        resolved_path: null,
        suggestions
      });
      warnings.push({
        kind: "broken-wikilink",
        message: `[[${target}]] does not resolve to any existing note`,
        suggestion: suggestions.length ? `Closest matches: ${suggestions.join(", ")}` : undefined
      });
    }
  }

  // 4. Tag pre-classification (existing vs new).
  const existingTags = new Set((await listTags(vault, {})).map((t) => t.tag.toLowerCase()));
  const proposedTagsRaw = new Set<string>();
  // Frontmatter tags.
  const fmData = yamlReport.parsed ? matter(args.content).data : {};
  const fmTags = fmData.tags ?? fmData.tag;
  if (Array.isArray(fmTags)) {
    for (const t of fmTags) if (typeof t === "string" && t) proposedTagsRaw.add(t.replace(/^#/, ""));
  } else if (typeof fmTags === "string" && fmTags) {
    for (const t of fmTags.split(/[\s,]+/)) if (t) proposedTagsRaw.add(t.replace(/^#/, ""));
  }
  // Inline tags.
  const inlineTagRe = /(?:^|[\s([{>])#([\p{L}][\p{L}\p{N}_/-]*)/gu;
  for (const m of bodyAfterFm.matchAll(inlineTagRe)) {
    if (m[1]) proposedTagsRaw.add(m[1]);
  }
  const tags: ValidateProposalResult["tags"] = [];
  for (const t of proposedTagsRaw) {
    const status = existingTags.has(t.toLowerCase()) ? "existing" : "new";
    tags.push({ name: t, status });
    if (status === "new") {
      warnings.push({
        kind: "new-tag",
        message: `#${t} is new — won't fork an existing tag (case-insensitive check)`
      });
    }
  }

  // 5. Path collision check.
  let collision: ValidateProposalResult["collision"] = { kind: "none" };
  if (absPath) {
    try {
      await vault.stat(absPath);
      // Path exists.
      if (mode === "create") {
        errors.push({
          kind: "path-collision",
          message: `Note already exists at ${normalizedPath} (mode="create" refuses overwrite)`
        });
      }
      collision = { kind: "path-exists", existing_path: normalizedPath };
    } catch {
      // Path doesn't exist — try title collision (an existing note at a different path).
      const titleFromBasename = stripMd(path.basename(normalizedPath));
      const existing = await vault.findByTitle(titleFromBasename);
      if (existing && existing.relPath !== normalizedPath) {
        warnings.push({
          kind: "title-collision",
          message: `A note titled "${titleFromBasename}" already exists at ${existing.relPath} — proceeding will create a same-titled file at a different path`,
          suggestion: existing.relPath
        });
        collision = { kind: "title-exists-elsewhere", existing_path: existing.relPath };
      }
    }
  }

  return {
    ok: errors.length === 0,
    proposed_path: normalizedPath,
    mode,
    errors,
    warnings,
    yaml: yamlReport,
    wikilinks,
    tags,
    collision
  };
}

// ─── obsidian_find_similar (v0.13 lexical-hybrid similarity) ─────────────────
// Given a note, rank other notes in the vault by how related they are. This is
// hybrid retrieval done with vault-native signals — no embeddings, no model
// download, no native dep — just the same structural metadata an Obsidian user
// already curates: tags, headings, link graph, and word overlap.
//
// Score = weighted sum of four signals, all in [0,1]:
//   • tag_jaccard       — |A.tags ∩ B.tags| / |A.tags ∪ B.tags|         (×3.0)
//   • title_3gram       — character 3-gram Jaccard of basenames         (×1.5)
//   • shared_outbound   — % of A's outbound links also in B's outbound  (×2.0)
//   • co_backlink       — % of X with X→A AND X→B (over union)          (×2.0)
//
// Body cosine isn't included: at vault scale (~5k notes × ~5KB each) a full
// TF-IDF pass is OK, but the structural signals above already converge on the
// notes a human would call "related" without paying that cost on every call.

export interface SimilarNote {
  path: string;
  title: string;
  score: number;
  signals: {
    tag_jaccard: number;
    title_3gram: number;
    shared_outbound: number;
    co_backlink: number;
  };
  shared_tags: string[];
  mtime: string;
}

export async function findSimilar(
  vault: Vault,
  args: { path?: string; title?: string; limit?: number; min_score?: number }
): Promise<SimilarNote[]> {
  await vault.ensureExists();
  const limit = args.limit ?? 10;
  const minScore = args.min_score ?? 0.05;
  const target = await resolveTarget(vault, args);
  const entries = await vault.listMarkdown();

  // Pre-extract metadata for all notes including the target.
  type NoteMeta = {
    entry: FileEntry;
    tags: Set<string>;
    title3grams: Set<string>;
    outbound: Set<string>; // resolved relPaths this note links to
  };
  const metas = new Map<string, NoteMeta>();
  for (const e of entries) {
    const { parsed } = await vault.readNote(e.absPath, e.mtimeMs);
    const tags = new Set(parsed.tags.map((t) => t.toLowerCase()));
    const title3grams = ngrams(stripMd(e.basename).toLowerCase(), 3);
    const outbound = new Set<string>();
    for (const link of parsed.wikilinks) {
      const m = findBestMatch(entries, link.target, e.relPath);
      if (m) outbound.add(m.relPath);
    }
    metas.set(e.relPath, { entry: e, tags, title3grams, outbound });
  }

  const targetMeta = metas.get(target.relPath);
  if (!targetMeta) {
    // The target was found by resolveTarget but may have been excluded from
    // listMarkdown by --exclude-glob. Treat as zero results rather than crash.
    return [];
  }

  // For co-backlink: build "who links to X?" for everyone we care about
  // (target + all candidates). Single pass over outbound sets.
  const inboundFor = new Map<string, Set<string>>();
  for (const [from, m] of metas) {
    for (const to of m.outbound) {
      const set = inboundFor.get(to) ?? new Set();
      set.add(from);
      inboundFor.set(to, set);
    }
  }
  const targetInbound = inboundFor.get(target.relPath) ?? new Set();

  const out: SimilarNote[] = [];
  for (const [relPath, m] of metas) {
    if (relPath === target.relPath) continue;
    const tagJ = jaccard(targetMeta.tags, m.tags);
    const titleJ = jaccard(targetMeta.title3grams, m.title3grams);
    const candInbound = inboundFor.get(relPath) ?? new Set();
    // shared_outbound: how much of A's outbound is also in B's
    const sharedOut =
      targetMeta.outbound.size === 0 ? 0 : intersectionSize(targetMeta.outbound, m.outbound) / targetMeta.outbound.size;
    // co_backlink: how many notes link to both target and candidate, over union
    const coBack = jaccard(targetInbound, candInbound);

    const score = 3.0 * tagJ + 1.5 * titleJ + 2.0 * sharedOut + 2.0 * coBack;
    if (score < minScore) continue;

    const shared: string[] = [];
    for (const t of targetMeta.tags) if (m.tags.has(t)) shared.push(t);
    shared.sort();

    out.push({
      path: m.entry.relPath,
      title: stripMd(m.entry.basename),
      score: Math.round(score * 10000) / 10000,
      signals: {
        tag_jaccard: Math.round(tagJ * 10000) / 10000,
        title_3gram: Math.round(titleJ * 10000) / 10000,
        shared_outbound: Math.round(sharedOut * 10000) / 10000,
        co_backlink: Math.round(coBack * 10000) / 10000
      },
      shared_tags: shared,
      mtime: new Date(m.entry.mtimeMs).toISOString()
    });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}

// ─── obsidian_get_note_neighbors (v0.13 graph-aware context) ─────────────────
// Return a note + its 1-hop graph neighborhood — outbound links + backlinks +
// tag-cluster siblings. Designed as the canonical "give the LLM enough context
// to reason about this note" call: instead of read_note → backlinks → outbound
// → resolve_wikilink (4 round-trips), one call returns the node and its edges.

export interface NoteNeighbors {
  center: {
    path: string;
    title: string;
    tags: string[];
    mtime: string;
  };
  outbound: Array<{ path: string; title: string; tags: string[] }>;
  inbound: Array<{ path: string; title: string; tags: string[]; count: number }>;
  tag_siblings: Array<{ path: string; title: string; shared_tags: string[] }>;
}

export async function getNoteNeighbors(
  vault: Vault,
  args: { path?: string; title?: string; max_per_bucket?: number }
): Promise<NoteNeighbors> {
  await vault.ensureExists();
  const cap = args.max_per_bucket ?? 20;
  const target = await resolveTarget(vault, args);
  const entries = await vault.listMarkdown();
  const { parsed: targetParsed } = await vault.readNote(target.absPath, target.mtimeMs);
  const targetTagsLower = new Set(targetParsed.tags.map((t) => t.toLowerCase()));

  // Outbound: resolved unique destinations from the target.
  const seenOut = new Set<string>();
  const outbound: NoteNeighbors["outbound"] = [];
  for (const link of targetParsed.wikilinks) {
    const m = findBestMatch(entries, link.target, target.relPath);
    if (!m || seenOut.has(m.relPath)) continue;
    seenOut.add(m.relPath);
    const { parsed: nbrParsed } = await vault.readNote(m.absPath, m.mtimeMs);
    outbound.push({ path: m.relPath, title: stripMd(m.basename), tags: nbrParsed.tags });
    if (outbound.length >= cap) break;
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
        if (targetTagsLower.has(t.toLowerCase())) shared.push(t);
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

export interface VaultStats {
  total_notes: number;
  total_size_bytes: number;
  avg_note_words: number;
  recently_modified_7d: number;
  orphans: number;
  broken_wikilinks: number;
  total_tags: number;
  top_tags: Array<{ tag: string; count: number }>;
  notes_with_frontmatter: number;
  generated_at: string;
}

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
      const key = t.toLowerCase();
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

// ─── obsidian_lint_wiki (v1.5 — Karpathy LLM-Wiki lint workflow) ─────────────
// Karpathy's gist (gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
// names three workflows for an LLM-maintained wiki: ingest, query, lint. We had
// the ingest+query primitives (create_note + search/find_similar/etc.) since
// 0.13. lint completes the trio in one tool call: orphans, broken links, stub
// pages, stale claims, and "concept mentioned in N+ notes but missing its own
// page." Each finding is shaped so the agent can fix it via existing tools
// (validate_note_proposal → create_note / append_to_note / rename_note).

export interface LintWikiArgs {
  /** Folder to restrict the lint to (default: whole vault). */
  folder?: string;
  /** Word count below which a note is considered a "stub". Default 100. */
  stub_word_threshold?: number;
  /** A note is "stale" if its frontmatter `last_reviewed` (or mtime if missing)
   *  is older than this many days. Default 365. */
  stale_days?: number;
  /** A capitalised n-gram mentioned by ≥ N distinct notes but not having its
   *  own page is flagged as a concept candidate. Default 3. */
  concept_min_mentions?: number;
  /** Cap on each finding-bucket so the response stays bounded. Default 50. */
  max_per_bucket?: number;
}

export interface LintWikiFinding {
  kind: "orphan" | "broken-link" | "stub" | "stale" | "concept-without-page";
  path?: string;
  message: string;
  suggestion?: string;
  details?: Record<string, unknown>;
}

export interface LintWikiResult {
  scope: string;
  scanned: number;
  generated_at: string;
  summary: {
    orphans: number;
    broken_links: number;
    stubs: number;
    stale: number;
    concept_candidates: number;
  };
  findings: {
    orphans: LintWikiFinding[];
    broken_links: LintWikiFinding[];
    stubs: LintWikiFinding[];
    stale: LintWikiFinding[];
    concept_candidates: LintWikiFinding[];
  };
}

export async function lintWiki(vault: Vault, args: LintWikiArgs): Promise<LintWikiResult> {
  await vault.ensureExists();
  const stubThreshold = args.stub_word_threshold ?? 100;
  const staleDays = args.stale_days ?? 365;
  const conceptMinMentions = args.concept_min_mentions ?? 3;
  const cap = args.max_per_bucket ?? 50;

  const entries = await vault.listMarkdown(args.folder);
  const allEntries = await vault.listMarkdown();
  const staleMs = Date.now() - staleDays * 24 * 3600 * 1000;

  // Single pass: collect inbound counts, outbound presence, broken links,
  // word counts, last-reviewed times, capitalised-phrase mentions.
  const inbound = new Map<string, number>();
  const outboundPresence = new Set<string>();
  const broken: LintWikiFinding[] = [];
  const stubs: LintWikiFinding[] = [];
  const stale: LintWikiFinding[] = [];
  const titleSet = new Set<string>();
  for (const e of allEntries) titleSet.add(stripMd(e.basename).toLowerCase());

  // Capitalised-phrase mentions across the whole vault. A phrase is 1-3
  // CapitalCase tokens (e.g. "Reinforcement Learning", "Attention Heads").
  // Stop-words: dropped when they appear at the start of a phrase.
  const conceptStopwords = new Set([
    "The",
    "A",
    "An",
    "This",
    "That",
    "These",
    "Those",
    "If",
    "When",
    "While",
    "But",
    "And",
    "Or"
  ]);
  const capPhraseRe = /\b((?:[A-Z][a-z][a-z]+(?:\s+[A-Z][a-z][a-z]+){0,2}))\b/g;
  const conceptMentions = new Map<string, Set<string>>(); // phrase → set of source paths

  for (const e of entries) {
    const { parsed, mtimeMs } = await vault.readNote(e.absPath, e.mtimeMs);

    // Outbound + broken pass.
    if (parsed.wikilinks.length > 0) outboundPresence.add(e.relPath);
    for (const link of parsed.wikilinks) {
      const m = findBestMatch(allEntries, link.target, e.relPath);
      if (m) {
        inbound.set(m.relPath, (inbound.get(m.relPath) ?? 0) + 1);
      } else if (broken.length < cap) {
        broken.push({
          kind: "broken-link",
          path: e.relPath,
          message: `[[${link.target}]] in ${e.relPath} doesn't resolve`,
          suggestion: "create the missing note, fix the link, or remove it",
          details: { target: link.target, raw: link.raw }
        });
      }
    }

    // Stub pass.
    const wordCount = parsed.body.trim() ? parsed.body.trim().split(/\s+/).length : 0;
    if (wordCount < stubThreshold && stubs.length < cap) {
      stubs.push({
        kind: "stub",
        path: e.relPath,
        message: `${e.relPath} is ${wordCount} words (threshold ${stubThreshold})`,
        suggestion: "develop, merge into a hub, or archive",
        details: { word_count: wordCount, mtime: new Date(mtimeMs).toISOString() }
      });
    }

    // Stale pass — frontmatter `last_reviewed` overrides mtime if present.
    // gray-matter (js-yaml) parses ISO dates into Date objects automatically,
    // so we accept Date | string | number.
    const lastReviewedRaw = parsed.frontmatter?.last_reviewed ?? parsed.frontmatter?.["last-reviewed"];
    let lastTouchedMs = mtimeMs;
    if (lastReviewedRaw instanceof Date) {
      const t = lastReviewedRaw.getTime();
      if (Number.isFinite(t)) lastTouchedMs = t;
    } else if (typeof lastReviewedRaw === "string") {
      const t = Date.parse(lastReviewedRaw);
      if (Number.isFinite(t)) lastTouchedMs = t;
    } else if (typeof lastReviewedRaw === "number" && Number.isFinite(lastReviewedRaw)) {
      lastTouchedMs = lastReviewedRaw;
    }
    if (lastTouchedMs < staleMs && stale.length < cap) {
      stale.push({
        kind: "stale",
        path: e.relPath,
        message: `${e.relPath} not touched since ${new Date(lastTouchedMs).toISOString().slice(0, 10)}`,
        suggestion: "review for accuracy or archive",
        details: {
          last_touched: new Date(lastTouchedMs).toISOString(),
          source: lastReviewedRaw !== undefined ? "frontmatter.last_reviewed" : "mtime"
        }
      });
    }

    // Concept-mention pass — capitalised phrases in the body that aren't
    // already a wikilink target. Cap at 30 unique phrases per source to
    // bound memory, but loose enough that real concepts in long notes don't
    // get truncated.
    const seenInThisNote = new Set<string>();
    for (const m of parsed.body.matchAll(capPhraseRe)) {
      const phrase = m[1];
      if (!phrase) continue;
      const firstWord = phrase.split(/\s+/)[0];
      if (firstWord !== undefined && conceptStopwords.has(firstWord)) continue;
      if (seenInThisNote.has(phrase)) continue;
      if (seenInThisNote.size >= 30) break;
      // Skip phrases that are already a vault note (basename match).
      if (titleSet.has(phrase.toLowerCase())) continue;
      seenInThisNote.add(phrase);
      const set = conceptMentions.get(phrase) ?? new Set<string>();
      set.add(e.relPath);
      conceptMentions.set(phrase, set);
    }
  }

  // Orphan findings (no inbound AND no outbound).
  const orphans: LintWikiFinding[] = [];
  for (const e of entries) {
    if (orphans.length >= cap) break;
    if (!inbound.get(e.relPath) && !outboundPresence.has(e.relPath)) {
      orphans.push({
        kind: "orphan",
        path: e.relPath,
        message: `${e.relPath} has no inbound or outbound wikilinks`,
        suggestion: "link from a hub note, archive, or delete",
        details: { mtime: new Date(e.mtimeMs).toISOString() }
      });
    }
  }

  // Concept candidates — phrases mentioned by ≥ N distinct notes.
  const conceptCandidates: LintWikiFinding[] = [];
  const ranked = [...conceptMentions.entries()]
    .filter(([, sources]) => sources.size >= conceptMinMentions)
    .sort((a, b) => b[1].size - a[1].size);
  for (const [phrase, sources] of ranked) {
    if (conceptCandidates.length >= cap) break;
    conceptCandidates.push({
      kind: "concept-without-page",
      message: `"${phrase}" is mentioned by ${sources.size} notes but has no page of its own`,
      suggestion: `create a page \`${phrase}.md\` and refile the most-developed mentions into it`,
      details: { phrase, mention_count: sources.size, sources: [...sources].slice(0, 5) }
    });
  }

  return {
    scope: args.folder ?? "(whole vault)",
    scanned: entries.length,
    generated_at: new Date().toISOString(),
    summary: {
      orphans: orphans.length,
      broken_links: broken.length,
      stubs: stubs.length,
      stale: stale.length,
      concept_candidates: conceptCandidates.length
    },
    findings: {
      orphans,
      broken_links: broken,
      stubs,
      stale,
      concept_candidates: conceptCandidates
    }
  };
}

// ─── obsidian_open_questions (v1.5 — surface unresolved threads) ─────────────
// Karpathy and other ML PKM workflows use "Open question:" / "Q:" / "TODO?" /
// "??" lines as deferred-thinking markers. This tool returns every such line
// across the vault with source + context heading + age, sorted oldest-first.

export interface OpenQuestion {
  question: string;
  source_path: string;
  source_title: string;
  context_heading: string | null;
  line: number;
  age_days: number;
  mtime: string;
}

export async function getOpenQuestions(
  vault: Vault,
  args: { folder?: string; limit?: number; pattern?: string }
): Promise<OpenQuestion[]> {
  await vault.ensureExists();
  const limit = args.limit ?? 100;
  // Default pattern: "Open question:" / "Open question -" / "Q:" / "TODO?" / "??"
  // followed by space + question text. Anchored at line start (with optional
  // list-bullet / quote / heading prefix).
  // Default pattern matches deferred-thinking markers at line start (with
  // optional list-bullet / quote / heading prefix). Single-line `i` flag —
  // we apply it line-by-line below.
  const defaultPat = "^\\s*(?:[#\\->\\*\\d\\.]+\\s+)?(?:open\\s+question|q|todo\\?|\\?\\?)\\s*[:\\-]?\\s*(.+)$";
  const re = new RegExp(args.pattern ?? defaultPat, "i");

  const entries = await vault.listMarkdown(args.folder);
  const out: OpenQuestion[] = [];
  const now = Date.now();
  for (const e of entries) {
    if (out.length >= limit) break;
    const { parsed, mtimeMs } = await vault.readNote(e.absPath, e.mtimeMs);
    // Scan parsed.body so frontmatter lines (which can contain "Q:" -ish
    // tokens) don't pollute results.
    const lines = parsed.body.split("\n");
    let currentHeading: string | null = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      const headingMatch = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      if (headingMatch?.[2]) {
        currentHeading = headingMatch[2];
        // A heading line itself isn't a question hit — skip the regex match.
        continue;
      }
      const m = re.exec(line);
      if (!m?.[1]) continue;
      out.push({
        question: m[1].trim(),
        source_path: e.relPath,
        source_title: stripMd(e.basename),
        context_heading: currentHeading,
        line: i + 1,
        age_days: Math.round((now - mtimeMs) / (24 * 3600 * 1000)),
        mtime: new Date(mtimeMs).toISOString()
      });
      if (out.length >= limit) break;
    }
  }
  // Sort oldest-first so things aging out surface first.
  out.sort((a, b) => b.age_days - a.age_days);
  return out;
}

// ─── obsidian_paper_audit (v1.5 — verify #paper notes have citations) ────────
// For each note tagged #paper (configurable), verify frontmatter has at least
// one of arxiv/doi/url/isbn. Also flag notes whose body contains an arxiv ID
// (e.g. "arxiv:2401.12345") but doesn't carry it in frontmatter — common after
// quick-capture from a chat.

export interface PaperAuditFinding {
  path: string;
  title: string;
  has_frontmatter_citation: boolean;
  found_in_body: { arxiv: string[]; doi: string[]; url: string[] };
  proposed_frontmatter_patch: Record<string, string> | null;
  message: string;
}

export async function paperAudit(
  vault: Vault,
  args: { tag?: string; folder?: string; limit?: number }
): Promise<{ scanned: number; flagged: PaperAuditFinding[] }> {
  await vault.ensureExists();
  const tag = (args.tag ?? "paper").replace(/^#+/, "").toLowerCase();
  const limit = args.limit ?? 100;
  const entries = await vault.listMarkdown(args.folder);

  const arxivRe = /\barxiv[:\s]*([0-9]{4}\.[0-9]{4,5}(?:v\d+)?)\b/gi;
  const doiRe = /\bdoi[:\s]*(10\.\d{4,9}\/[\w\-._;()/:]+)/gi;
  const urlRe = /\bhttps?:\/\/[^\s<>")\]]+/g;

  let scanned = 0;
  const flagged: PaperAuditFinding[] = [];
  for (const e of entries) {
    if (flagged.length >= limit) break;
    const { parsed } = await vault.readNote(e.absPath, e.mtimeMs);
    const tagsLower = parsed.tags.map((t) => t.toLowerCase());
    if (!tagsLower.includes(tag)) continue;
    scanned += 1;

    const fm = parsed.frontmatter ?? {};
    const fmKeys = new Set(Object.keys(fm).map((k) => k.toLowerCase()));
    const hasFmCitation = fmKeys.has("arxiv") || fmKeys.has("doi") || fmKeys.has("url") || fmKeys.has("isbn");

    // Scan parsed.body so the frontmatter's own arxiv/doi keys don't get
    // re-detected as "found in body".
    const body = parsed.body;
    const arxivIds = [...body.matchAll(arxivRe)].map((m) => m[1]).filter((v): v is string => !!v);
    const doiIds = [...body.matchAll(doiRe)].map((m) => m[1]).filter((v): v is string => !!v);
    const urls = [...body.matchAll(urlRe)].map((m) => m[0]);
    const foundInBody = {
      arxiv: [...new Set(arxivIds)],
      doi: [...new Set(doiIds)],
      url: [...new Set(urls)].slice(0, 3)
    };

    const bodyHasAnyId = foundInBody.arxiv.length > 0 || foundInBody.doi.length > 0 || foundInBody.url.length > 0;
    // Clean ⇒ has a frontmatter citation. The body might cite OTHER papers,
    // but this note itself is properly identified.
    if (hasFmCitation) continue;

    let proposed: Record<string, string> | null = null;
    if (bodyHasAnyId) {
      proposed = {};
      if (foundInBody.arxiv[0]) proposed.arxiv = foundInBody.arxiv[0];
      if (foundInBody.doi[0]) proposed.doi = foundInBody.doi[0];
      if (foundInBody.url[0] && !proposed.arxiv && !proposed.doi) proposed.url = foundInBody.url[0];
    }

    const msg = bodyHasAnyId
      ? `${e.relPath} has identifiers in body (${[
          ...foundInBody.arxiv.map((v) => `arxiv:${v}`),
          ...foundInBody.doi.map((v) => `doi:${v}`)
        ]
          .slice(0, 2)
          .join(", ")}) but missing frontmatter`
      : `${e.relPath} has #${tag} but no arxiv/doi/url anywhere — citation missing`;

    flagged.push({
      path: e.relPath,
      title: stripMd(e.basename),
      has_frontmatter_citation: hasFmCitation,
      found_in_body: foundInBody,
      proposed_frontmatter_patch: proposed,
      message: msg
    });
  }
  return { scanned, flagged };
}

// ─── obsidian_find_path (v1.6 multi-hop graph traversal) ────────────────────
// BFS over the wikilink graph from `from` to `to`, returning the shortest path
// (sequence of notes connected by wikilinks) up to `max_depth` hops. Closes
// the gap aaronsb's plugin opened: "find paths between concepts" was the
// most-praised graph feature in the competitive audit. We use the shared
// EntryIndex memo so repeat calls in a session reuse the basename index for
// O(1) target resolution.

export interface PathStep {
  path: string;
  title: string;
  /** Wikilink raw text (`[[…]]` content) used to traverse FROM the previous
   *  step to this one. Empty on the source step. */
  via: string;
}

export interface FindPathResult {
  from: string;
  to: string;
  found: boolean;
  path: PathStep[];
  hops: number;
  /** Up to 10 same-length alternatives, only when include_alternatives=true. */
  alternatives?: PathStep[][];
}

export async function findPath(
  vault: Vault,
  args: {
    from?: string;
    from_title?: string;
    to?: string;
    to_title?: string;
    max_depth?: number;
    include_alternatives?: boolean;
    follow_embeds?: boolean;
  }
): Promise<FindPathResult> {
  await vault.ensureExists();
  const maxDepth = args.max_depth ?? 5;
  const includeAlts = args.include_alternatives === true;
  const followEmbeds = args.follow_embeds !== false;

  const fromArgs: { path?: string; title?: string } = {};
  if (args.from !== undefined) fromArgs.path = args.from;
  else if (args.from_title !== undefined) fromArgs.title = args.from_title;
  const fromEntry = await resolveTarget(vault, fromArgs);

  const toArgs: { path?: string; title?: string } = {};
  if (args.to !== undefined) toArgs.path = args.to;
  else if (args.to_title !== undefined) toArgs.title = args.to_title;
  const toEntry = await resolveTarget(vault, toArgs);

  if (fromEntry.absPath === toEntry.absPath) {
    return {
      from: fromEntry.relPath,
      to: toEntry.relPath,
      found: true,
      hops: 0,
      path: [{ path: fromEntry.relPath, title: stripMd(fromEntry.basename), via: "" }]
    };
  }

  const entries = await vault.listMarkdown();

  // BFS layer-by-layer. visited tracks shortest-known-depth so we don't
  // revisit at greater depths. We continue collecting at the depth where
  // we first hit the target IF include_alternatives is set.
  // v1.8.1 perf fix: build a relPath → entry map ONCE before the BFS loop.
  // Pre-fix: entries.find((e) => e.relPath === node.rel) was O(N) per visited
  // node, making the whole BFS O(N²) on large vaults.
  const byRel = new Map<string, FileEntry>();
  for (const e of entries) byRel.set(e.relPath, e);

  type FrontierEntry = { rel: string; trail: PathStep[] };
  const visited = new Set<string>([fromEntry.relPath]);
  let frontier: FrontierEntry[] = [
    { rel: fromEntry.relPath, trail: [{ path: fromEntry.relPath, title: stripMd(fromEntry.basename), via: "" }] }
  ];
  const found: PathStep[][] = [];
  let foundDepth = -1;

  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const next: FrontierEntry[] = [];
    for (const node of frontier) {
      const entry = byRel.get(node.rel);
      if (!entry) continue;
      const { parsed } = await vault.readNote(entry.absPath, entry.mtimeMs);
      const links = followEmbeds ? [...parsed.wikilinks, ...parsed.embeds] : parsed.wikilinks;
      for (const link of links) {
        const m = findBestMatch(entries, link.target, entry.relPath);
        if (!m) continue;
        if (visited.has(m.relPath) && m.absPath !== toEntry.absPath) continue;
        const newTrail: PathStep[] = [...node.trail, { path: m.relPath, title: stripMd(m.basename), via: link.raw }];
        if (m.absPath === toEntry.absPath) {
          if (foundDepth === -1) foundDepth = depth + 1;
          if (foundDepth === depth + 1) {
            found.push(newTrail);
            if (!includeAlts) {
              return {
                from: fromEntry.relPath,
                to: toEntry.relPath,
                found: true,
                hops: foundDepth,
                path: newTrail
              };
            }
          }
        } else {
          visited.add(m.relPath);
          next.push({ rel: m.relPath, trail: newTrail });
        }
      }
    }
    if (foundDepth !== -1 && depth + 1 === foundDepth) break;
    frontier = next;
  }

  if (found.length > 0) {
    found.sort((a, b) => a.length - b.length || (a[0]?.path ?? "").localeCompare(b[0]?.path ?? ""));
    const first = found[0];
    if (!first) {
      return { from: fromEntry.relPath, to: toEntry.relPath, found: false, hops: -1, path: [] };
    }
    const result: FindPathResult = {
      from: fromEntry.relPath,
      to: toEntry.relPath,
      found: true,
      hops: foundDepth,
      path: first
    };
    if (includeAlts) result.alternatives = found.slice(0, 10);
    return result;
  }

  return { from: fromEntry.relPath, to: toEntry.relPath, found: false, hops: -1, path: [] };
}

// ─── obsidian_open_in_ui (v1.6 cyanheads pattern) ───────────────────────────
// Returns an obsidian:// URI for hand-off to the desktop app. No filesystem or
// network side effect — the URI emission lets the agent say "open this in
// Obsidian" without enquire-mcp needing to coordinate with the running app.

export interface OpenInUiResult {
  uri: string;
  vault_name: string;
  path: string;
  title: string;
}

export async function openInUi(
  vault: Vault,
  args: { path?: string; title?: string; new_pane?: boolean }
): Promise<OpenInUiResult> {
  await vault.ensureExists();
  const target = await resolveTarget(vault, args);
  // Vault name = leaf of the vault root path. obsidian:// matches by name OR
  // by the file's absolute path; if the user opened the vault from a
  // different name in Obsidian, the file argument still resolves correctly.
  const vaultName = path.basename(vault.root);
  const noteRel = stripMd(target.relPath);
  const params = new URLSearchParams({ vault: vaultName, file: noteRel });
  if (args.new_pane) params.set("newpane", "true");
  return {
    uri: `obsidian://open?${params.toString()}`,
    vault_name: vaultName,
    path: target.relPath,
    title: stripMd(target.basename)
  };
}

// ─── obsidian_list_canvases (v1.7) ──────────────────────────────────────────
// Lists `.canvas` files (Obsidian's whiteboard format — JSON nodes + edges).
// Green-field per the v1.5 competitive audit: only obscure forks support
// canvas, and we now do it natively without coupling to the Obsidian app.

export interface CanvasSummary {
  path: string;
  name: string;
  size_bytes: number;
  mtime: string;
  node_count: number;
  edge_count: number;
}

export async function listCanvases(vault: Vault, args: { folder?: string; limit?: number }): Promise<CanvasSummary[]> {
  await vault.ensureExists();
  const limit = args.limit ?? 100;
  const all = await vault.listFilesByExtension(".canvas", args.folder);
  const out: CanvasSummary[] = [];
  for (const e of all) {
    if (out.length >= limit) break;
    let nodeCount = 0;
    let edgeCount = 0;
    let size = e.mtimeMs; // placeholder; replaced below
    try {
      const buf = await vault.readBinaryFile(e.absPath);
      size = buf.byteLength;
      const txt = buf.toString("utf8");
      const parsed = JSON.parse(txt) as { nodes?: unknown[]; edges?: unknown[] };
      nodeCount = Array.isArray(parsed.nodes) ? parsed.nodes.length : 0;
      edgeCount = Array.isArray(parsed.edges) ? parsed.edges.length : 0;
    } catch {
      // Malformed canvas — fall through with 0 counts. Don't poison the listing.
    }
    out.push({
      path: e.relPath,
      name: e.basename.replace(/\.canvas$/i, ""),
      size_bytes: size,
      mtime: new Date(e.mtimeMs).toISOString(),
      node_count: nodeCount,
      edge_count: edgeCount
    });
  }
  out.sort((a, b) => b.mtime.localeCompare(a.mtime));
  return out;
}

// ─── obsidian_read_canvas (v1.7) ────────────────────────────────────────────
// Parses one .canvas file into typed nodes + edges. The agent gets a graph
// representation it can reason about: which notes are pinned where, what
// connects them, what's textual vs file-embed vs URL.

export type CanvasNode =
  | {
      kind: "text";
      id: string;
      x: number;
      y: number;
      width: number;
      height: number;
      text: string;
      color?: string;
    }
  | {
      kind: "file";
      id: string;
      x: number;
      y: number;
      width: number;
      height: number;
      file: string;
      file_resolved: string | null; // vault-relative path that findBestMatch resolved to (or null)
      subpath?: string;
      color?: string;
    }
  | {
      kind: "link";
      id: string;
      x: number;
      y: number;
      width: number;
      height: number;
      url: string;
      color?: string;
    }
  | {
      kind: "group";
      id: string;
      x: number;
      y: number;
      width: number;
      height: number;
      label?: string;
      color?: string;
    }
  | {
      kind: "unknown";
      id: string;
      raw_type: string;
      raw: Record<string, unknown>;
    };

export interface CanvasEdge {
  id: string;
  from_node: string;
  from_side?: string;
  to_node: string;
  to_side?: string;
  label?: string;
  color?: string;
}

export interface ReadCanvasResult {
  path: string;
  name: string;
  size_bytes: number;
  mtime: string;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  /** Convenience summary: # of each node kind. */
  summary: { text: number; file: number; link: number; group: number; unknown: number };
  /** Embedded files that didn't resolve to anything in the vault — broken
   *  canvas references. Empty when all files resolve cleanly. */
  broken_file_refs: string[];
}

export async function readCanvas(vault: Vault, args: { path: string }): Promise<ReadCanvasResult> {
  await vault.ensureExists();
  if (!args.path) throw new Error("path is required");
  const normalized = args.path.toLowerCase().endsWith(".canvas") ? args.path : `${args.path}.canvas`;
  const abs = vault.resolveInside(normalized);
  await vault.stat(abs); // throws if missing or excluded — fail fast
  const rel = vault.toRel(abs);

  const buf = await vault.readBinaryFile(abs);
  let parsed: { nodes?: unknown[]; edges?: unknown[] };
  try {
    parsed = JSON.parse(buf.toString("utf8")) as { nodes?: unknown[]; edges?: unknown[] };
  } catch (err) {
    throw new Error(`Canvas file is not valid JSON: ${rel} — ${err instanceof Error ? err.message : String(err)}`);
  }

  // Resolve each `file:` node's reference against the vault's current
  // markdown index — surfaces broken canvas links the same way
  // get_unresolved_wikilinks does for note bodies.
  const allMarkdown = await vault.listMarkdown();
  const nodes: CanvasNode[] = [];
  const summary = { text: 0, file: 0, link: 0, group: 0, unknown: 0 };
  const brokenRefs: string[] = [];
  if (Array.isArray(parsed.nodes)) {
    for (const raw of parsed.nodes) {
      if (!raw || typeof raw !== "object") continue;
      const n = raw as Record<string, unknown>;
      const id = typeof n.id === "string" ? n.id : "";
      const x = typeof n.x === "number" ? n.x : 0;
      const y = typeof n.y === "number" ? n.y : 0;
      const width = typeof n.width === "number" ? n.width : 0;
      const height = typeof n.height === "number" ? n.height : 0;
      const color = typeof n.color === "string" ? n.color : undefined;
      const type = typeof n.type === "string" ? n.type : "unknown";
      switch (type) {
        case "text":
          nodes.push({
            kind: "text",
            id,
            x,
            y,
            width,
            height,
            text: typeof n.text === "string" ? n.text : "",
            ...(color !== undefined ? { color } : {})
          });
          summary.text += 1;
          break;
        case "file": {
          const fileRef = typeof n.file === "string" ? n.file : "";
          // Strip leading slash so `findBestMatch` treats it as relative.
          const cleaned = fileRef.replace(/^\/+/, "");
          // findBestMatch only looks at the basename; for canvases we have a full
          // vault-relative path, so try direct match first. Fall through to
          // findBestMatch (basename) for the path-stripped case.
          const direct =
            cleaned.length > 0 ? allMarkdown.find((m) => m.relPath.replace(/\\/g, "/") === cleaned) : undefined;
          const resolved = direct ?? (cleaned ? findBestMatch(allMarkdown, cleaned) : null);
          if (cleaned && !resolved) brokenRefs.push(cleaned);
          nodes.push({
            kind: "file",
            id,
            x,
            y,
            width,
            height,
            file: fileRef,
            file_resolved: resolved ? resolved.relPath : null,
            ...(typeof n.subpath === "string" ? { subpath: n.subpath } : {}),
            ...(color !== undefined ? { color } : {})
          });
          summary.file += 1;
          break;
        }
        case "link":
          nodes.push({
            kind: "link",
            id,
            x,
            y,
            width,
            height,
            url: typeof n.url === "string" ? n.url : "",
            ...(color !== undefined ? { color } : {})
          });
          summary.link += 1;
          break;
        case "group":
          nodes.push({
            kind: "group",
            id,
            x,
            y,
            width,
            height,
            ...(typeof n.label === "string" ? { label: n.label } : {}),
            ...(color !== undefined ? { color } : {})
          });
          summary.group += 1;
          break;
        default:
          nodes.push({ kind: "unknown", id, raw_type: type, raw: n });
          summary.unknown += 1;
      }
    }
  }

  const edges: CanvasEdge[] = [];
  if (Array.isArray(parsed.edges)) {
    for (const raw of parsed.edges) {
      if (!raw || typeof raw !== "object") continue;
      const e = raw as Record<string, unknown>;
      const id = typeof e.id === "string" ? e.id : "";
      const fromNode = typeof e.fromNode === "string" ? e.fromNode : "";
      const toNode = typeof e.toNode === "string" ? e.toNode : "";
      if (!fromNode || !toNode) continue;
      edges.push({
        id,
        from_node: fromNode,
        ...(typeof e.fromSide === "string" ? { from_side: e.fromSide } : {}),
        to_node: toNode,
        ...(typeof e.toSide === "string" ? { to_side: e.toSide } : {}),
        ...(typeof e.label === "string" ? { label: e.label } : {}),
        ...(typeof e.color === "string" ? { color: e.color } : {})
      });
    }
  }

  const stat = await vault.stat(abs);
  return {
    path: rel,
    name: path.basename(rel).replace(/\.canvas$/i, ""),
    size_bytes: stat.size,
    mtime: new Date(stat.mtimeMs).toISOString(),
    nodes,
    edges,
    summary,
    broken_file_refs: brokenRefs
  };
}

// ─── obsidian_semantic_search (v1.8 TF-IDF cosine retrieval) ────────────────
// Pure-JS lexical-semantic search: tokenize + TF-IDF + L2-normalize each
// note's body, then rank notes by cosine similarity to the query vector.
// Closes the Smart-Connections-paywall gap surfaced in the v1.5 audit
// without adding any runtime deps. Real ML embedding retrieval is the v2.0
// follow-up; this is the meaningful no-deps first step that handles the
// related-term case the BM25 / exact-substring path misses.

interface DocVector {
  relPath: string;
  basename: string;
  mtimeMs: number;
  /** Sparse term-frequency-IDF vector. Map<term, weight>. L2-normalized. */
  weights: Map<string, number>;
}

const tfidfCache = new WeakMap<Vault, { docs: DocVector[]; idf: Map<string, number>; entriesRef: FileEntry[] }>();

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "for",
  "from",
  "has",
  "have",
  "if",
  "in",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "was",
  "were",
  "will",
  "with",
  "i",
  "you",
  "we",
  "they",
  "he",
  "she",
  "not",
  "no",
  "do",
  "does",
  "did",
  "had",
  "been",
  "being",
  "so",
  "than",
  "then",
  "there",
  "their",
  "them",
  "these",
  "those",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "how"
]);

// v2.1.0: detect Chinese / Japanese / Thai / Khmer / Lao via script ranges.
// These languages don't use spaces between words, so the Unicode-regex
// tokenizer falls back to character-level (or huge multi-word tokens),
// which tanks BM25 + TF-IDF precision. Intl.Segmenter (Node 16+ ICU)
// gives word-break per language. Detection is per-document, branching the
// tokenizer.
const CJK_OR_THAI_RANGES = /[぀-ヿ㐀-䶿一-鿿가-힯฀-๿ༀ-࿿ក-៿]/;

function tokenizeForTfidf(text: string): string[] {
  // v1.11.1: Unicode-aware tokenizer. The previous ASCII-only regex
  // (`/[a-z0-9][a-z0-9_-]*/g`) silently dropped Cyrillic, Greek, CJK,
  // Hebrew, Arabic, and any non-Latin content from the TF-IDF index.
  // `\p{L}` matches any Unicode letter; `\p{N}` matches any Unicode number.
  //
  // v2.1.0: when the text contains CJK / Thai / Khmer / Lao chars (no-
  // whitespace scripts), use Intl.Segmenter for proper word-break first,
  // then run the Unicode regex per-segment. This produces real word tokens
  // instead of "認可サーバーがアクセストークン" as a single 12-char token
  // that the length filter would drop.
  const lower = text.toLowerCase();
  const out: string[] = [];
  if (CJK_OR_THAI_RANGES.test(lower) && typeof Intl !== "undefined" && typeof Intl.Segmenter !== "undefined") {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
    for (const seg of segmenter.segment(lower)) {
      if (!seg.isWordLike) continue;
      const t = seg.segment;
      if (t.length < 1) continue;
      if (t.length > 40) continue;
      if (STOP_WORDS.has(t)) continue;
      out.push(t);
    }
    return out;
  }
  for (const m of lower.matchAll(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu)) {
    const t = m[0];
    if (t.length < 2) continue;
    if (t.length > 40) continue;
    if (STOP_WORDS.has(t)) continue;
    out.push(t);
  }
  return out;
}

async function buildTfidfIndex(
  vault: Vault
): Promise<{ docs: DocVector[]; idf: Map<string, number>; entriesRef: FileEntry[] }> {
  const entries = await vault.listMarkdown();
  const cached = tfidfCache.get(vault);
  if (
    cached &&
    cached.entriesRef.length === entries.length &&
    cached.entriesRef.every((e, i) => entries[i]?.relPath === e.relPath && entries[i]?.mtimeMs === e.mtimeMs)
  ) {
    return cached;
  }

  type RawDoc = { entry: FileEntry; tf: Map<string, number> };
  const rawDocs: RawDoc[] = [];
  const docFreq = new Map<string, number>();
  for (const e of entries) {
    const { parsed } = await vault.readNote(e.absPath, e.mtimeMs);
    const tokens = tokenizeForTfidf(parsed.body);
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    rawDocs.push({ entry: e, tf });
    for (const t of tf.keys()) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
  }

  // Smoothed IDF: ln(1 + N / (1 + df)). Smoothing keeps every-doc terms
  // non-zero and tames inflation on small vaults.
  const N = rawDocs.length || 1;
  const idf = new Map<string, number>();
  for (const [term, df] of docFreq) {
    idf.set(term, Math.log(1 + N / (1 + df)));
  }

  const docs: DocVector[] = [];
  for (const r of rawDocs) {
    const weights = new Map<string, number>();
    let normSq = 0;
    for (const [term, count] of r.tf) {
      const w = (1 + Math.log(count)) * (idf.get(term) ?? 0);
      if (w === 0) continue;
      weights.set(term, w);
      normSq += w * w;
    }
    const norm = Math.sqrt(normSq);
    if (norm > 0) {
      for (const [t, w] of weights) weights.set(t, w / norm);
    }
    docs.push({
      relPath: r.entry.relPath,
      basename: r.entry.basename,
      mtimeMs: r.entry.mtimeMs,
      weights
    });
  }

  const result = { docs, idf, entriesRef: entries };
  tfidfCache.set(vault, result);
  return result;
}

export interface SemanticHit {
  path: string;
  title: string;
  score: number;
  snippet: string;
  matched_terms: string[];
  mtime: string;
}

export async function semanticSearch(
  vault: Vault,
  args: { query: string; folder?: string; limit?: number; min_score?: number }
): Promise<{ query: string; total_docs: number; method: "tfidf-cosine"; matches: SemanticHit[] }> {
  await vault.ensureExists();
  const limit = args.limit ?? 10;
  const minScore = args.min_score ?? 0.05;
  if (!args.query.trim()) throw new Error("query must not be empty");

  const { docs, idf } = await buildTfidfIndex(vault);

  // Vectorize query: same tokenization, IDF from the corpus, L2 normalize.
  const qTokens = tokenizeForTfidf(args.query);
  const qTf = new Map<string, number>();
  for (const t of qTokens) qTf.set(t, (qTf.get(t) ?? 0) + 1);
  const qWeights = new Map<string, number>();
  let qNormSq = 0;
  for (const [t, count] of qTf) {
    const w = (1 + Math.log(count)) * (idf.get(t) ?? 0);
    if (w === 0) continue;
    qWeights.set(t, w);
    qNormSq += w * w;
  }
  const qNorm = Math.sqrt(qNormSq);
  if (qNorm > 0) {
    for (const [t, w] of qWeights) qWeights.set(t, w / qNorm);
  }

  // Cosine = Σ q[t]·d[t] over shared terms (both vectors are L2-normed).
  const folderPrefix = args.folder ? `${args.folder.replace(/\/+$/, "")}/` : null;
  const scored: Array<{ doc: DocVector; score: number; matchedTerms: string[] }> = [];
  for (const doc of docs) {
    if (folderPrefix && !doc.relPath.startsWith(folderPrefix) && doc.relPath !== args.folder) continue;
    let s = 0;
    const matched: string[] = [];
    for (const [t, qw] of qWeights) {
      const dw = doc.weights.get(t);
      if (dw !== undefined) {
        s += qw * dw;
        matched.push(t);
      }
    }
    if (s < minScore) continue;
    scored.push({ doc, score: s, matchedTerms: matched });
  }
  scored.sort((a, b) => b.score - a.score);

  const matches: SemanticHit[] = [];
  for (const { doc, score, matchedTerms } of scored.slice(0, limit)) {
    matchedTerms.sort((a, b) => (idf.get(b) ?? 0) - (idf.get(a) ?? 0));
    // v1.8.1 fix: snippet was being built from `content` (full file with
    // frontmatter), so a matched term that lived in the YAML block could leak
    // YAML keys/values into the response. Use `parsed.body` instead — TF-IDF
    // is built from body too, so the indexOf below is guaranteed to land if
    // the term contributed to the cosine score.
    const { parsed } = await vault.readNote(vault.resolveInside(doc.relPath), doc.mtimeMs);
    const body = parsed.body;
    let snippetText = "";
    for (const t of matchedTerms) {
      const idx = body.toLowerCase().indexOf(t);
      if (idx >= 0) {
        const { snippet } = sliceSnippet(body, idx, t.length);
        snippetText = snippet;
        break;
      }
    }
    matches.push({
      path: doc.relPath,
      title: stripMd(doc.basename),
      score: Math.round(score * 10000) / 10000,
      snippet: snippetText,
      matched_terms: matchedTerms.slice(0, 8),
      mtime: new Date(doc.mtimeMs).toISOString()
    });
  }

  return { query: args.query, total_docs: docs.length, method: "tfidf-cosine", matches };
}

// ─── obsidian_embeddings_search (v2.0 alpha — ML embeddings retrieval) ──────
// Hits a persistent vector index built by `enquire-mcp build-embeddings`. If
// the user hasn't run that yet, returns a clean `index_missing` error rather
// than blocking inside the model load (which can take ~30s on first call).
//
// The index is opt-in and out-of-band: we don't load any ONNX runtime or
// model files unless the tool is actually invoked. Cold path is identical to
// `obsidian_semantic_search` (TF-IDF, no native deps, instant).

export interface EmbedHit {
  path: string;
  title: string;
  score: number;
  snippet: string;
  chunk_index: number;
  line_start: number;
  line_end: number;
  /** v2.8.0 — content-source kind ("md" | "pdf"). */
  kind: "md" | "pdf";
}

export interface EmbedSearchResponse {
  query: string;
  method: "embeddings-cosine";
  model: string;
  total_chunks: number;
  matches: EmbedHit[];
  /**
   * v3.1.0 — present + true when retrieval used the agent-supplied
   * `hypothetical_answer` as the embedding seed (HyDE). Lets clients
   * audit whether they're seeing raw-query or HyDE-augmented results.
   */
  hyde?: boolean;
}

/**
 * v2.13.0 — optional HNSW context. When passed, embeddingsSearch routes
 * the k-NN lookup through the in-memory HNSW index (sub-10ms at any
 * scale) instead of the O(n) brute-force cosine in EmbedDb.search().
 * `rowByLabel` is the label → source-row mapping established at HNSW
 * build time (typically labels are `embeddings.id`, set in
 * `EmbedDb.getAllVectors()`).
 */
export interface HnswSearchContext {
  index: { searchKnn(q: Float32Array, k: number, opts?: { ef?: number }): { labels: number[]; distances: number[] } };
  rowByLabel: ReadonlyMap<
    number,
    {
      rel_path: string;
      chunk_index: number;
      line_start: number;
      line_end: number;
      text_preview: string;
      kind: "md" | "pdf";
    }
  >;
  ef?: number;
}

/**
 * v3.1.0 — pick the text that should be embedded for an embeddings-search
 * call. HyDE-augmented retrieval prefers the agent-supplied
 * `hypothetical_answer` (Gao et al 2023); falls back to the raw query
 * when that's absent / empty / whitespace-only.
 *
 * Pure helper so we can unit-test the decision in isolation (the real
 * `embeddingsSearch` function loads the @huggingface/transformers
 * embedder, which is out of scope for unit tests).
 */
export function pickEmbedTextForHyde(args: { query: string; hypothetical_answer?: string }): {
  text: string;
  usedHyde: boolean;
} {
  const ha = args.hypothetical_answer?.trim() ?? "";
  if (ha.length > 0) return { text: ha, usedHyde: true };
  return { text: args.query, usedHyde: false };
}

export async function embeddingsSearch(
  vault: Vault,
  args: {
    query: string;
    folder?: string;
    limit?: number;
    min_score?: number;
    model?: string;
    /**
     * v3.1.0 — HyDE (Hypothetical Document Embeddings) augmentation.
     * When set, this string is embedded instead of `query`. The agent
     * generates a synthetic answer to its own question, embeds *that*,
     * and retrieves against the answer-shaped vector — typically beats
     * raw-query retrieval on under-specified queries by +2-5 NDCG@10.
     * The `query` string is still echoed in the response for caller
     * audit-trail; it does NOT influence retrieval when `hypothetical_answer`
     * is present.
     */
    hypothetical_answer?: string;
  },
  embedFile: string,
  hnsw?: HnswSearchContext | null
): Promise<EmbedSearchResponse> {
  await vault.ensureExists();
  if (!args.query.trim()) throw new Error("query must not be empty");
  // v3.1.0 — pick the actual text to embed. HyDE prefers the
  // hypothetical answer when present; otherwise fall back to the query.
  const { text: embedText, usedHyde } = pickEmbedTextForHyde(args);
  const limit = args.limit ?? 10;
  const minScore = args.min_score ?? 0.3;

  // Lazy-load embed-db + embeddings only when the tool is actually called.
  const [{ EmbedDb }, { loadEmbedder, resolveModel }] = await Promise.all([
    import("./embed-db.js"),
    import("./embeddings.js")
  ]);

  // Verify the embed db exists before doing anything heavy. This separates
  // "user hasn't built the index yet" from "model failed to load".
  const fsMod = await import("node:fs");
  if (!fsMod.existsSync(embedFile)) {
    throw new Error(
      `Embedding index not found at ${embedFile}. ` +
        `Run: enquire-mcp build-embeddings --vault ${vault.root} ` +
        `(first-time setup also needs: enquire-mcp install-model multilingual)`
    );
  }

  const model = resolveModel(args.model);
  const db = new EmbedDb({
    file: embedFile,
    vaultRoot: vault.root,
    modelAlias: model.alias,
    dim: model.dim
  });
  await db.open();
  try {
    const total = db.totalChunks();
    if (total === 0) {
      return { query: args.query, method: "embeddings-cosine", model: model.alias, total_chunks: 0, matches: [] };
    }
    const embedder = await loadEmbedder(args.model);
    const [qVec] = await embedder.embed([embedText]);
    if (!qVec) throw new Error("Embedder returned no vectors for the query");
    // v2.0.0-beta.2 P0 fix: filter excluded paths from the embedding-index
    // hits BEFORE returning. The persistent .embed.db is built once and may
    // contain entries for paths now excluded by --exclude-glob / --read-paths
    // (added between build-embeddings and serve, or between two serve runs).
    // Pre-fix, those entries leaked through `text_preview` and `rel_path`,
    // bypassing the privacy contract — same shape as the writeNote bug.
    // We over-fetch by 2× to keep top-K stable when many hits get filtered.
    const overFetch = limit * 2;
    let rawHits: import("./embed-db.js").EmbedSearchHit[];
    if (hnsw) {
      // v2.13.0 — HNSW path. Sub-10ms top-K at any scale. We over-fetch
      // slightly more (3×) than brute-force because HNSW can occasionally
      // miss a true nearest neighbor; the privacy filter then pares down.
      const k = Math.min(Math.max(overFetch * 2, 30), Math.max(hnsw.rowByLabel.size, 1));
      const result = hnsw.index.searchKnn(qVec, k, hnsw.ef !== undefined ? { ef: hnsw.ef } : undefined);
      const { hnswResultsToHits } = await import("./hnsw.js");
      rawHits = hnswResultsToHits(result, hnsw.rowByLabel);
      // HNSW returns scores in [-1, 1] like brute-force cosine. Apply the
      // same min_score floor + folder filter brute-force does.
      if (args.folder) {
        const prefix = `${args.folder.replace(/\/+$/, "")}/`;
        rawHits = rawHits.filter((h) => h.rel_path.startsWith(prefix));
      }
      rawHits = rawHits.filter((h) => h.score >= minScore);
    } else {
      rawHits = db.search(qVec, overFetch, { folder: args.folder, minScore });
    }
    const hits = rawHits.filter((h) => !vault.isExcluded(h.rel_path)).slice(0, limit);
    const matches: EmbedHit[] = hits.map((h) => ({
      path: h.rel_path,
      title: stripMd(path.basename(h.rel_path)),
      score: Math.round(h.score * 10000) / 10000,
      snippet: h.text_preview.slice(0, 240),
      chunk_index: h.chunk_index,
      line_start: h.line_start,
      line_end: h.line_end,
      kind: h.kind
    }));
    return {
      query: args.query,
      method: "embeddings-cosine",
      model: model.alias,
      total_chunks: total,
      matches,
      ...(usedHyde ? { hyde: true } : {})
    };
  } finally {
    db.close();
  }
}

// ─── obsidian_search (v2.0 beta — hybrid RRF over BM25 + TF-IDF + embeddings)
// Single umbrella tool that fuses every available retrieval signal via
// Reciprocal Rank Fusion (Cormack et al, 2009). Gracefully degrades:
//   - All 3 signals available → fuse all 3
//   - No FTS5 (`--persistent-index` not passed) → TF-IDF + embeddings (or just TF-IDF)
//   - No embeddings (`build-embeddings` not run) → BM25 + TF-IDF
//   - Only TF-IDF → falls back to TF-IDF-only ranking
// Each signal contributes equally; v2.0 ships hardcoded RRF with k=60 per
// the architecture decision. Future v2.1 may add `--rrf-weights` flag.
//
// Note-level fusion: BM25 + embeddings return chunk hits; we collapse to the
// best chunk per note before fusing. The chunk_index from the highest-ranked
// chunk hit is preserved on the response so the agent can scroll to the
// right paragraph.

import type { FtsIndex } from "./fts5.js";

export interface SearchHybridHit {
  path: string;
  title: string;
  /** Fused RRF score (sum of 1/(k+rank) terms across signals). */
  score: number;
  /** Snippet from whichever signal produced the best chunk hit. */
  snippet: string;
  chunk_index?: number;
  line_start?: number;
  line_end?: number;
  /**
   * v2.8.0 — content-source kind. Lets agents distinguish markdown notes
   * from PDF chunks when both are indexed. Defaults to "md" for backward
   * compatibility (legacy DBs and TF-IDF hits have no kind metadata).
   */
  kind: "md" | "pdf";
  /** Per-signal observability — which signals contributed at what rank/score. */
  per_signal: {
    bm25?: { rank: number; score: number };
    tfidf?: { rank: number; score: number };
    embeddings?: { rank: number; score: number };
  };
  /**
   * v2.9.0 — cross-encoder reranker score in [0, 1] (sigmoid of the model's
   * relevance logit). Present only when the server was started with
   * `--enable-reranker` AND this hit was within the reranker's top-N
   * candidate set (default 50). Higher = more relevant. Compare across
   * results within the same response, NOT across queries (the absolute
   * value depends on the query).
   */
  reranker_score?: number;
}

export interface SearchHybridResponse {
  query: string;
  method: "rrf";
  k: number;
  signals_used: ("bm25" | "tfidf" | "embeddings")[];
  /** v2.0.0-beta.2: per-signal failure reasons. Pre-fix, ranker exceptions
   *  were silently swallowed (only stderr-logged). The MCP response just
   *  showed `signals_used: []` with `matches: []` — caller couldn't tell
   *  "no hits" from "all rankers crashed". Now any catch'ed exception
   *  surfaces here as a string so agents can reason about reliability.
   *  v2.9.0 added `reranker` for cross-encoder failure surfacing. */
  signal_errors?: { bm25?: string; tfidf?: string; embeddings?: string; reranker?: string };
  total_candidates: number;
  matches: SearchHybridHit[];
}

export async function searchHybrid(
  vault: Vault,
  args: {
    query: string;
    folder?: string;
    limit?: number;
    min_signals?: number;
    embedding_model?: string;
    /** v2.2.0: "note" (default) returns 1 hit per note, picking the best
     *  chunk; "block" returns each chunk as a distinct hit so you see the
     *  multiple-paragraph case where one note covers a topic in two places. */
    granularity?: "note" | "block";
    /** v2.3.0: post-RRF graph boost — rerank by counting how many other
     *  top-K hits link to each one. Default true; set false to disable for
     *  diagnostic comparison (e.g. measuring whether boost helped). */
    graph_boost?: boolean;
  },
  ctx: {
    /** FTS5 index, if `--persistent-index` is enabled at server start. */
    ftsIndex: FtsIndex | null;
    /** Path to the `.embed.db` (file may or may not exist — checked at call time). */
    embedFile: string;
    /**
     * v2.9.0 — optional cross-encoder reranker config. When set, the top-N
     * hits from RRF (default 50) are re-scored by a BGE-style cross-encoder
     * and re-sorted before truncation. Adds ~30-50ms per query on M1 CPU
     * for a 50-candidate set.
     *
     * `alias` resolves to a `RERANKER_MODELS` entry. `topN` defaults to 50.
     * Lazy-loaded — first call downloads the model from HuggingFace
     * (~25-110 MB depending on alias). Failures are swallowed and surface
     * via `signal_errors.reranker` so the whole search doesn't break on a
     * model load issue.
     */
    reranker?: { alias?: string; topN?: number };
    /**
     * v2.9.0 — test-only injection point. When set, this pre-loaded
     * reranker is used instead of lazy-loading via `loadReranker(alias)`.
     * Lets unit tests validate the rerank-and-resort plumbing without
     * pulling in the real ML model. Unused in production callers.
     */
    rerankerOverride?: { score(query: string, passages: readonly string[]): Promise<number[]> };
    /**
     * v2.13.0 — optional HNSW context for the embeddings-search arm.
     * When passed, the embedding-side k-NN goes through the in-memory
     * HNSW index (sub-10ms at any scale) instead of the O(n) brute-force
     * cosine in EmbedDb.search(). Built on serve start; lives in
     * ServerDeps.hnswContext. Null/undefined → brute-force fallback.
     */
    hnsw?: HnswSearchContext | null;
  }
): Promise<SearchHybridResponse> {
  await vault.ensureExists();
  if (!args.query.trim()) throw new Error("query must not be empty");
  const limit = args.limit ?? 10;
  const minSignals = args.min_signals ?? 1;
  const granularity = args.granularity ?? "note";
  // Fan-out per-ranker top-K. Bigger than user's `limit` so RRF has room
  // to surface a doc that's mid-rank in one signal but top in another.
  const fanOutK = Math.max(50, limit * 5);

  const [{ reciprocalRankFusion, RRF_K }, { existsSync }] = await Promise.all([import("./rrf.js"), import("node:fs")]);

  // v2.0.0-beta.2 P1 fix: collect per-signal errors for response-side observability.
  const signalErrors: { bm25?: string; tfidf?: string; embeddings?: string } = {};

  const signalsUsed: ("bm25" | "tfidf" | "embeddings")[] = [];

  // ─── BM25 (FTS5) ────────────────────────────────────────────────────────
  // Note-level: collapse multi-chunk hits to the best rank per note.
  let bm25Ranked: Array<{
    id: string;
    rank: number;
    score: number;
    snippet: string;
    chunk_index?: number;
    line_start?: number;
    line_end?: number;
    /** v2.8.0: content-source kind ("md" | "pdf"). */
    kind: "md" | "pdf";
  }> = [];
  if (ctx.ftsIndex) {
    try {
      // v2.0.0-beta.2 P0 fix: filter excluded paths from FTS5 hits BEFORE
      // chunk-collapse + RRF. The .fts5.db can contain entries from when the
      // index was built without exclusion flags (or with different flags).
      // Pre-fix, BM25 search returned excluded chunks via the hybrid pipeline.
      const rawFtsHits = ctx.ftsIndex.search(args.query, { limit: fanOutK, folder: args.folder });
      const ftsHits = rawFtsHits.filter((h) => !vault.isExcluded(h.rel_path));
      // v2.2.0: granularity branch.
      //   "note"  → collapse multi-chunk hits per note (best-rank wins),
      //             RRF fuses on path key.
      //   "block" → keep each chunk distinct, RRF fuses on `path#chunk_index`.
      if (granularity === "block") {
        bm25Ranked = ftsHits.map((h, i) => ({
          id: `${h.rel_path}#${h.chunk_index}`,
          rank: i + 1,
          score: h.score,
          snippet: h.snippet,
          chunk_index: h.chunk_index,
          line_start: h.line_start,
          line_end: h.line_end,
          kind: h.kind
        }));
      } else {
        const bestPerNote = new Map<
          string,
          {
            score: number;
            rank: number;
            snippet: string;
            chunk_index: number;
            line_start: number;
            line_end: number;
            kind: "md" | "pdf";
          }
        >();
        ftsHits.forEach((h, i) => {
          const existing = bestPerNote.get(h.rel_path);
          if (!existing || i < existing.rank) {
            bestPerNote.set(h.rel_path, {
              score: h.score,
              rank: i + 1,
              snippet: h.snippet,
              chunk_index: h.chunk_index,
              line_start: h.line_start,
              line_end: h.line_end,
              kind: h.kind
            });
          }
        });
        bm25Ranked = Array.from(bestPerNote.entries()).map(([id, b]) => ({
          id,
          rank: b.rank,
          score: b.score,
          snippet: b.snippet,
          chunk_index: b.chunk_index,
          line_start: b.line_start,
          line_end: b.line_end,
          kind: b.kind
        }));
        // Re-sort to ensure 1-based ranks are consecutive after dedup.
        bm25Ranked.sort((a, b) => a.rank - b.rank);
        for (let i = 0; i < bm25Ranked.length; i++) {
          const hit = bm25Ranked[i];
          if (hit) hit.rank = i + 1;
        }
      }
      if (bm25Ranked.length > 0) signalsUsed.push("bm25");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      signalErrors.bm25 = msg;
      process.stderr.write(`obsidian_search: BM25 ranker failed — ${msg}\n`);
    }
  }

  // ─── TF-IDF ─────────────────────────────────────────────────────────────
  // Always available (in-memory, no native deps).
  let tfidfRanked: Array<{ id: string; rank: number; score: number; snippet: string }> = [];
  try {
    const tfidf = await semanticSearch(vault, {
      query: args.query,
      folder: args.folder,
      limit: fanOutK,
      min_score: 0.05
    });
    tfidfRanked = tfidf.matches.map((m, i) => ({
      id: m.path,
      rank: i + 1,
      score: m.score,
      snippet: m.snippet
    }));
    if (tfidfRanked.length > 0) signalsUsed.push("tfidf");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    signalErrors.tfidf = msg;
    process.stderr.write(`obsidian_search: TF-IDF ranker failed — ${msg}\n`);
  }

  // ─── ML embeddings (if .embed.db exists) ────────────────────────────────
  let embedRanked: Array<{
    id: string;
    rank: number;
    score: number;
    snippet: string;
    chunk_index?: number;
    line_start?: number;
    line_end?: number;
    /** v2.8.0: content-source kind ("md" | "pdf"). */
    kind: "md" | "pdf";
  }> = [];
  if (existsSync(ctx.embedFile)) {
    try {
      // v2.0.0-beta.1 P1 fix: pass `min_score: 0` to fan-out the embeddings
      // ranker uniformly with BM25 (no floor) and TF-IDF (0.05 floor). The
      // user-facing precision filter happens AFTER fusion via `min_signals`,
      // not before — pre-fix, embeddings used the standalone tool's 0.3
      // default which silently shrank the embedding-side candidate pool and
      // starved RRF of cross-signal evidence.
      const embed = await embeddingsSearch(
        vault,
        { query: args.query, folder: args.folder, limit: fanOutK, model: args.embedding_model, min_score: 0 },
        ctx.embedFile,
        ctx.hnsw
      );
      // v2.2.0: granularity branch — same shape as BM25 above.
      if (granularity === "block") {
        embedRanked = embed.matches.map((m, i) => ({
          id: `${m.path}#${m.chunk_index ?? 0}`,
          rank: i + 1,
          score: m.score,
          snippet: m.snippet,
          chunk_index: m.chunk_index,
          line_start: m.line_start,
          line_end: m.line_end,
          kind: m.kind
        }));
      } else {
        const bestPerNote = new Map<
          string,
          {
            score: number;
            rank: number;
            snippet: string;
            chunk_index: number;
            line_start: number;
            line_end: number;
            kind: "md" | "pdf";
          }
        >();
        embed.matches.forEach((m, i) => {
          const existing = bestPerNote.get(m.path);
          if (!existing || i < existing.rank) {
            bestPerNote.set(m.path, {
              score: m.score,
              rank: i + 1,
              snippet: m.snippet,
              chunk_index: m.chunk_index,
              line_start: m.line_start,
              line_end: m.line_end,
              kind: m.kind
            });
          }
        });
        embedRanked = Array.from(bestPerNote.entries()).map(([id, b]) => ({
          id,
          rank: b.rank,
          score: b.score,
          snippet: b.snippet,
          chunk_index: b.chunk_index,
          line_start: b.line_start,
          line_end: b.line_end,
          kind: b.kind
        }));
        embedRanked.sort((a, b) => a.rank - b.rank);
        for (let i = 0; i < embedRanked.length; i++) {
          const hit = embedRanked[i];
          if (hit) hit.rank = i + 1;
        }
      }
      if (embedRanked.length > 0) signalsUsed.push("embeddings");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      signalErrors.embeddings = msg;
      process.stderr.write(`obsidian_search: embeddings ranker failed — ${msg}\n`);
    }
  }

  // ─── RRF fusion ─────────────────────────────────────────────────────────
  const fused = reciprocalRankFusion(
    {
      bm25: bm25Ranked.map((h) => ({ id: h.id, rank: h.rank, score: h.score })),
      tfidf: tfidfRanked.map((h) => ({ id: h.id, rank: h.rank, score: h.score })),
      embeddings: embedRanked.map((h) => ({ id: h.id, rank: h.rank, score: h.score }))
    },
    { topK: Math.max(limit * 4, 30) } // overshoot — graph boost may rerank
  );

  // ─── v2.3.0: Wikilink graph-boost ───────────────────────────────────────
  // Re-rank top-K by counting how many *other* top-K hits link to each one.
  // Equivalent to a 1-step personalised PageRank seeded by the fused top-K.
  // Boost is small (α=0.005) — enough to break ties but won't override
  // strong single-ranker signals. Requires no new index — uses already-
  // cached parsed wikilinks per note.
  // This is the "only enquire-mcp does this" feature: generic vector stores
  // can't do this without an Obsidian-aware layer; Smart Connections doesn't
  // do it either. Wikilinks ARE the differentiating Obsidian primitive.
  const graphBoost = args.graph_boost !== false; // default ON
  if (graphBoost && fused.length > 1) {
    const candidatePaths = new Set<string>();
    for (const f of fused) {
      candidatePaths.add(f.id.includes("#") ? (f.id.split("#")[0] ?? f.id) : f.id);
    }
    const outLinks = new Map<string, Set<string>>();
    for (const candidatePath of candidatePaths) {
      try {
        const note = await vault.readNote(vault.resolveInside(candidatePath));
        const targets = new Set<string>();
        for (const wl of note.parsed.wikilinks) {
          if (!wl.target) continue;
          // Wikilinks can be by basename ("Foo") or relative path ("Sub/Foo").
          // Normalize both forms so the membership test catches either.
          targets.add(wl.target);
          targets.add(stripMd(wl.target));
        }
        outLinks.set(candidatePath, targets);
      } catch {
        // skip unreadable notes
      }
    }
    const ALPHA = 0.005;
    for (const f of fused) {
      const fPath = f.id.includes("#") ? (f.id.split("#")[0] ?? f.id) : f.id;
      const fBasename = stripMd(path.basename(fPath));
      let inDegree = 0;
      for (const [otherPath, targets] of outLinks) {
        if (otherPath === fPath) continue;
        if (targets.has(fPath) || targets.has(stripMd(fPath)) || targets.has(fBasename)) {
          inDegree += 1;
        }
      }
      if (inDegree > 0) f.score += ALPHA * inDegree;
    }
    fused.sort((a, b) => b.score - a.score);
  }

  // Build snippet/chunk lookup tables for attaching the best evidence per
  // note in the final response.
  const bm25Map = new Map(bm25Ranked.map((h) => [h.id, h]));
  const tfidfMap = new Map(tfidfRanked.map((h) => [h.id, h]));
  const embedMap = new Map(embedRanked.map((h) => [h.id, h]));

  // ─── v2.9.0: Cross-encoder reranking (post-RRF, post-graph-boost) ────────
  // Take the top-N fused candidates, score each (query, snippet) pair with a
  // BGE-style cross-encoder, and re-sort. Cross-encoder is far more accurate
  // than bi-encoder cosine for relevance ranking — it sees query+document
  // interaction directly. ~30-50ms per query overhead on M1 CPU at N=50.
  //
  // Failures are caught and surfaced as `signal_errors.reranker` so a model
  // load problem doesn't poison the whole search response. The fused order
  // (RRF + graph-boost) is preserved if reranking fails.
  let rerankerScores: Map<string, number> | null = null;
  if ((ctx.reranker || ctx.rerankerOverride) && fused.length > 0) {
    const topN = ctx.reranker?.topN ?? 50;
    const rerankBatch = fused.slice(0, topN);
    try {
      // Prefer the test-injected reranker when present; otherwise lazy-load.
      let reranker: { score(query: string, passages: readonly string[]): Promise<number[]> };
      if (ctx.rerankerOverride) {
        reranker = ctx.rerankerOverride;
      } else {
        const { loadReranker } = await import("./embeddings.js");
        reranker = await loadReranker(ctx.reranker?.alias);
      }
      // For each candidate, find the best snippet (BM25 > embeddings > TF-IDF)
      // and pair it with the query. Empty-snippet candidates go to the bottom
      // by getting a -Infinity score (sort below scored candidates).
      const passages = rerankBatch.map((f) => {
        const bm = bm25Map.get(f.id);
        const emb = embedMap.get(f.id);
        const tf = tfidfMap.get(f.id);
        const snippet = bm?.snippet ?? emb?.snippet ?? tf?.snippet ?? "";
        // Strip FTS5 «…» highlight markers — they're cosmetic and the
        // reranker should see clean prose. Limit to ~600 chars to stay
        // safely under the model's 512-token budget (rough char/token ratio
        // varies by language; 600 chars ≈ 200 tokens for English / Cyrillic
        // per the multilingual model's tokenizer, well under 512).
        return snippet.replace(/[«»]/g, "").slice(0, 600);
      });
      const scores = await reranker.score(args.query, passages);
      rerankerScores = new Map();
      for (let i = 0; i < rerankBatch.length; i++) {
        const f = rerankBatch[i];
        const s = scores[i];
        if (f && typeof s === "number") rerankerScores.set(f.id, s);
      }
      // Sort the top-N by reranker score; everything below top-N keeps RRF
      // order. We do this by re-ordering fused[0..topN] in place.
      const reordered = [...rerankBatch].sort((a, b) => {
        const sa = rerankerScores?.get(a.id) ?? -Infinity;
        const sb = rerankerScores?.get(b.id) ?? -Infinity;
        return sb - sa;
      });
      for (let i = 0; i < reordered.length; i++) {
        fused[i] = reordered[i] as (typeof fused)[number];
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Add to signalErrors so it surfaces in the response. Reranker is not
      // a "signal" per se but the existing dict is the right home.
      (signalErrors as Record<string, string>).reranker = msg;
      process.stderr.write(`obsidian_search: reranker failed — ${msg}\n`);
    }
  }

  const matches: SearchHybridHit[] = [];
  for (const f of fused) {
    const numSignals = Object.keys(f.per_signal).length;
    if (numSignals < minSignals) continue;
    // Snippet preference: BM25 > embeddings > TF-IDF (BM25 snippets bracket
    // the matched terms with «…», highest signal-to-noise).
    const bm = bm25Map.get(f.id);
    const emb = embedMap.get(f.id);
    const tf = tfidfMap.get(f.id);
    const bestEvidence = bm ?? emb ?? tf;
    // Build per_signal as a Partial — only include keys that actually
    // contributed. Setting `key: undefined` keeps the key visible in
    // Object.keys() and JSON.stringify, which leaks "this signal exists
    // but didn't match" instead of "this signal wasn't even running".
    const perSignal: SearchHybridHit["per_signal"] = {};
    if (f.per_signal.bm25) perSignal.bm25 = { rank: f.per_signal.bm25.rank, score: f.per_signal.bm25.score };
    if (f.per_signal.tfidf) perSignal.tfidf = { rank: f.per_signal.tfidf.rank, score: f.per_signal.tfidf.score };
    if (f.per_signal.embeddings) {
      perSignal.embeddings = { rank: f.per_signal.embeddings.rank, score: f.per_signal.embeddings.score };
    }
    // v2.2.0: when granularity is "block", f.id is "path#chunk_index" — split
    // back into path + chunk_index for the response. When "note", f.id is
    // just the path.
    let pathPart = f.id;
    let chunkFromId: number | undefined;
    if (granularity === "block") {
      const hashIdx = f.id.lastIndexOf("#");
      if (hashIdx > 0) {
        pathPart = f.id.slice(0, hashIdx);
        const parsed = Number.parseInt(f.id.slice(hashIdx + 1), 10);
        if (Number.isInteger(parsed) && parsed >= 0) chunkFromId = parsed;
      }
    }
    // v2.8.0: derive content-source kind. BM25 / embeddings hits carry it
    // explicitly; TF-IDF doesn't (it only runs over markdown). Either
    // ranker reporting "pdf" wins; otherwise fall back to "md".
    const kind: "md" | "pdf" = bm?.kind === "pdf" || emb?.kind === "pdf" ? "pdf" : "md";
    // For PDFs, the title is best derived from the filename without
    // `.md`-stripping (PDFs don't have that extension); use the .pdf-stripped
    // form so titles read naturally in agent output.
    const baseName = path.basename(pathPart);
    const title = kind === "pdf" ? baseName.replace(/\.pdf$/i, "") : stripMd(baseName);
    const rerankerScore = rerankerScores?.get(f.id);
    matches.push({
      path: pathPart,
      title,
      score: Math.round(f.score * 100000) / 100000,
      snippet: bestEvidence?.snippet ?? "",
      chunk_index: chunkFromId ?? bm?.chunk_index ?? emb?.chunk_index,
      line_start: bm?.line_start ?? emb?.line_start,
      line_end: bm?.line_end ?? emb?.line_end,
      kind,
      per_signal: perSignal,
      ...(typeof rerankerScore === "number" && Number.isFinite(rerankerScore)
        ? { reranker_score: Math.round(rerankerScore * 100000) / 100000 }
        : {})
    });
    if (matches.length >= limit) break;
  }

  // v2.0.0-beta.2 P1 fix: surface signal_errors only when at least one
  // ranker actually failed. Omit the key when all signals ran cleanly so
  // happy-path responses stay narrow.
  const response: SearchHybridResponse = {
    query: args.query,
    method: "rrf",
    k: RRF_K,
    signals_used: signalsUsed,
    total_candidates: fused.length,
    matches
  };
  if (Object.keys(signalErrors).length > 0) {
    response.signal_errors = signalErrors;
  }
  return response;
}

// ─── obsidian_context_pack (v2.2.0 — token-budgeted vault context export) ───
// Smart Connections' "Send to Smart Context" pattern, MCP-native. Takes a
// query, runs hybrid retrieval, gathers note bodies + 1-line backlink
// summaries + recent daily notes, deduplicates, packs to a token budget,
// returns one ready-to-paste markdown string. The agent doesn't have to
// orchestrate 5 separate tool calls — one tool, one context blob.
//
// Why MCP-native > Obsidian-only: Smart Context only works inside Obsidian.
// This tool works in Claude Code, Cursor, Codex, anywhere — copy the result
// into ANY chat.

export interface ContextPackArgs {
  /** Topic / question to gather context for. */
  query: string;
  /** Approximate token budget for the bundle. ~4 chars/token assumption. Default 4000. */
  budget_tokens?: number;
  /** Restrict retrieval to this folder. */
  folder?: string;
  /** Include backlinks of top-K notes (1-line each)? Default true. */
  include_backlinks?: boolean;
  /** Include the last N daily notes? Default 0 (off). Set to 3 for "what was I doing recently". */
  recent_dailies?: number;
}

export interface ContextPackResult {
  query: string;
  /** The packed markdown bundle ready to paste into an AI chat. */
  bundle: string;
  /** Approximate token count (chars / 4). */
  estimated_tokens: number;
  budget_tokens: number;
  /** Per-section byte counts for observability. */
  sections: {
    notes: number;
    backlinks: number;
    dailies: number;
  };
  /** Top-K hit paths included in the bundle. */
  included_notes: string[];
}

export async function contextPack(
  vault: Vault,
  args: ContextPackArgs,
  ctx: { ftsIndex: FtsIndex | null; embedFile: string }
): Promise<ContextPackResult> {
  await vault.ensureExists();
  if (!args.query?.trim()) throw new Error("context_pack: `query` is required");
  const budget = args.budget_tokens ?? 4000;
  const charBudget = budget * 4; // ~4 chars/token
  const includeBacklinks = args.include_backlinks !== false;
  const recentN = Math.max(0, args.recent_dailies ?? 0);

  // 1) Hybrid retrieval — top-K notes
  const search = await searchHybrid(
    vault,
    { query: args.query, folder: args.folder, limit: 10 },
    { ftsIndex: ctx.ftsIndex, embedFile: ctx.embedFile }
  );

  const sections: string[] = [`# Context for: ${args.query}\n`];
  const includedNotes: string[] = [];
  let charsUsed = sections[0]?.length ?? 0;
  let notesBytes = 0;
  let backlinksBytes = 0;
  let dailiesBytes = 0;

  // 2) Pack note bodies until budget exhausted
  sections.push("## Top notes");
  for (const m of search.matches) {
    if (charsUsed >= charBudget) break;
    try {
      const note = await vault.readNote(vault.resolveInside(m.path), undefined);
      const body = note.parsed.body.trim();
      const headerLen = m.path.length + 5;
      const remaining = charBudget - charsUsed;
      // Truncate body to fit remaining budget for THIS note (~50% of remainder
      // so we leave room for backlinks + dailies).
      const noteCap = Math.min(body.length, Math.max(500, Math.floor(remaining * 0.5)));
      const trimmed = body.length <= noteCap ? body : `${body.slice(0, noteCap)}\n\n[…truncated…]`;
      const block = `### ${m.path}\n\n${trimmed}\n`;
      sections.push(block);
      charsUsed += block.length + headerLen;
      notesBytes += block.length;
      includedNotes.push(m.path);
    } catch {
      // skip unreadable notes
    }
  }

  // 3) 1-line backlink summaries for top-3
  if (includeBacklinks && includedNotes.length > 0 && charsUsed < charBudget) {
    sections.push("## Backlinks");
    let backlinksAdded = 0;
    for (const notePath of includedNotes.slice(0, 3)) {
      if (charsUsed >= charBudget) break;
      try {
        const links = await getBacklinks(vault, { path: notePath, limit: 5 });
        if (links.length > 0) {
          const block = `### → ${notePath}\n${links.map((l) => `- ${l.path} : ${(l.snippets[0] ?? "").slice(0, 80)}`).join("\n")}\n`;
          sections.push(block);
          charsUsed += block.length;
          backlinksBytes += block.length;
          backlinksAdded += links.length;
        }
      } catch {
        // skip
      }
    }
    if (backlinksAdded === 0) sections.pop(); // remove empty heading
  }

  // 4) Recent daily notes
  if (recentN > 0 && charsUsed < charBudget) {
    try {
      const recent = await getRecentEdits(vault, { since_minutes: 60 * 24 * 7, limit: recentN, folder: args.folder });
      const dailies = recent.filter((r) => /\d{4}-\d{2}-\d{2}/.test(r.path));
      if (dailies.length > 0) {
        sections.push(`## Recent (${dailies.length} dailies, last 7 days)`);
        for (const d of dailies) {
          if (charsUsed >= charBudget) break;
          const block = `- ${d.path} (${d.mtime})`;
          sections.push(block);
          charsUsed += block.length;
          dailiesBytes += block.length;
        }
      }
    } catch {
      // skip
    }
  }

  const bundle = sections.join("\n");
  return {
    query: args.query,
    bundle,
    estimated_tokens: Math.ceil(bundle.length / 4),
    budget_tokens: budget,
    sections: { notes: notesBytes, backlinks: backlinksBytes, dailies: dailiesBytes },
    included_notes: includedNotes
  };
}

// ─── small set / string helpers shared by find_similar / get_note_neighbors ─

function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function intersectionSize<T>(a: Set<T>, b: Set<T>): number {
  let n = 0;
  for (const x of a) if (b.has(x)) n += 1;
  return n;
}

function ngrams(s: string, n: number): Set<string> {
  const out = new Set<string>();
  if (s.length < n) {
    if (s) out.add(s);
    return out;
  }
  for (let i = 0; i <= s.length - n; i++) out.add(s.slice(i, i + n));
  return out;
}

// Per-entries-array memo for the lookup indices findBestMatch needs. Keyed by
// the entries array reference so a fresh listMarkdown() result rebuilds the
// indices, but a hot loop calling findBestMatch repeatedly with the same
// `entries` argument shares one index. Closes the v1.2 bench finding that
// findBestMatch was the dominant cost in find_similar / get_note_neighbors /
// vault_stats / rename_note at 10k vaults (~2-3s p50 → ~50-200ms post-fix).
interface EntryIndex {
  byBasename: Map<string, FileEntry[]>;
  byRelPath: Map<string, FileEntry>;
}
const entryIndexCache = new WeakMap<FileEntry[], EntryIndex>();

function indexFor(entries: FileEntry[]): EntryIndex {
  const cached = entryIndexCache.get(entries);
  if (cached) return cached;
  const byBasename = new Map<string, FileEntry[]>();
  const byRelPath = new Map<string, FileEntry>();
  for (const e of entries) {
    const key = stripMd(e.basename).toLowerCase();
    const slot = byBasename.get(key);
    if (slot) slot.push(e);
    else byBasename.set(key, [e]);
    byRelPath.set(stripMd(e.relPath).toLowerCase(), e);
  }
  const idx: EntryIndex = { byBasename, byRelPath };
  entryIndexCache.set(entries, idx);
  return idx;
}

function findBestMatch(entries: FileEntry[], target: string, fromNote?: string): FileEntry | null {
  const idx = indexFor(entries);

  if (target.startsWith("./") || target.startsWith("../") || target.includes("/../")) {
    if (fromNote) {
      const fromDir = path.dirname(fromNote);
      const joined = path.posix.normalize(path.posix.join(fromDir.split(path.sep).join("/"), target));
      const lower = stripMd(joined).toLowerCase();
      const rel = idx.byRelPath.get(lower);
      if (rel) return rel;
    }
  }
  const norm = stripMd(target).toLowerCase();
  const exact = idx.byBasename.get(norm) ?? [];
  if (exact.length === 1) return exact[0] ?? null;
  if (exact.length > 1 && fromNote) {
    const fromDir = path.dirname(fromNote);
    const sameDir = exact.find((e) => path.dirname(e.relPath) === fromDir);
    if (sameDir) return sameDir;
  }
  if (exact.length > 0) return exact[0] ?? null;
  if (target.includes("/")) {
    const lower = stripMd(target).toLowerCase();
    const path1 = idx.byRelPath.get(lower);
    if (path1) return path1;
    // endsWith match — falls back to a scan, but only for path-qualified
    // targets that don't exact-match (rare).
    for (const e of entries) {
      if (stripMd(e.relPath).toLowerCase().endsWith(`/${lower}`)) return e;
    }
  }
  return null;
}

function sliceSnippet(text: string, idx: number, qLen: number): { snippet: string; line: number } {
  if (idx < 0) return { snippet: "", line: 0 };
  const before = Math.max(0, idx - 60);
  const after = Math.min(text.length, idx + qLen + 60);
  let snippet = text.slice(before, after).replace(/\s+/g, " ").trim();
  if (before > 0) snippet = `…${snippet}`;
  if (after < text.length) snippet = `${snippet}…`;
  const line = text.slice(0, idx).split("\n").length;
  return { snippet, line };
}

function stripMd(name: string): string {
  return name.replace(/\.md$/i, "");
}

function normalizeTag(t: string): string {
  return t.replace(/^#+/, "").toLowerCase();
}

// ─── obsidian_list_pdfs (v2.7.0) ────────────────────────────────────────────
// PDFs are the #1 non-markdown content kind in real research vaults. No other
// Obsidian-MCP indexes them — `serve` (stdio) and `serve-http` (remote) both
// surface the same list/read tools when pdfjs-dist is installed. Same privacy
// filter (--exclude-glob / --read-paths) as listFilesByExtension applies.

export interface PdfSummary {
  /** Vault-relative path. */
  path: string;
  /** Filename minus the `.pdf` extension. */
  name: string;
  /** File size in bytes. */
  size_bytes: number;
  /** Last-modified ISO timestamp. */
  mtime: string;
}

export async function listPdfs(vault: Vault, args: { folder?: string; limit?: number }): Promise<PdfSummary[]> {
  await vault.ensureExists();
  const limit = args.limit ?? 100;
  const all = await vault.listFilesByExtension(".pdf", args.folder);
  const out: PdfSummary[] = [];
  for (const e of all) {
    if (out.length >= limit) break;
    let size = 0;
    try {
      const buf = await vault.readBinaryFile(e.absPath);
      size = buf.byteLength;
    } catch {
      // Unreadable PDF — skip without poisoning the listing.
      continue;
    }
    out.push({
      path: e.relPath,
      name: e.basename.replace(/\.pdf$/i, ""),
      size_bytes: size,
      mtime: new Date(e.mtimeMs).toISOString()
    });
  }
  out.sort((a, b) => b.mtime.localeCompare(a.mtime));
  return out;
}

// ─── obsidian_read_pdf (v2.7.0) ─────────────────────────────────────────────
// Extract text from a single PDF, page-by-page. Image-only / scanned PDFs
// surface `has_text: false` so agents can detect-and-recommend OCR (deferred
// to v2.8+). Supports an optional `pages` slice (1-indexed inclusive range)
// for partial reads of long documents.

export interface ReadPdfArgs {
  /** Vault-relative path to the .pdf file. */
  path: string;
  /** Optional 1-indexed inclusive page range: `[2, 5]` reads pages 2..5. */
  pages?: [number, number];
  /** When true, include doc-level metadata (title/author/etc) in the result. Default true. */
  include_metadata?: boolean;
}

export interface ReadPdfPage {
  page_number: number;
  text: string;
  is_empty: boolean;
  char_count: number;
}

export interface ReadPdfResult {
  path: string;
  name: string;
  size_bytes: number;
  mtime: string;
  page_count: number;
  has_text: boolean;
  pages: ReadPdfPage[];
  full_text: string;
  metadata?: {
    title?: string;
    author?: string;
    subject?: string;
    keywords?: string;
    creator?: string;
    producer?: string;
    creation_date?: string;
    mod_date?: string;
  };
  /** When `pages` slicing was applied, this carries the original page count
   *  for callers that need to know how much they didn't read. */
  total_page_count: number;
}

export async function readPdf(vault: Vault, args: ReadPdfArgs): Promise<ReadPdfResult> {
  await vault.ensureExists();
  if (!args.path) throw new Error("path is required");
  const normalized = args.path.toLowerCase().endsWith(".pdf") ? args.path : `${args.path}.pdf`;
  const abs = vault.resolveInside(normalized);
  const stat = await vault.stat(abs); // throws if missing or excluded
  const rel = vault.toRel(abs);

  const buf = await vault.readBinaryFile(abs);
  // Lazy import — keeps the markdown-only path zero-cost when pdfjs-dist
  // isn't installed (--omit=optional users).
  const { extractPdfText } = await import("./pdf.js");
  const result = await extractPdfText(buf);

  // Optional page-range slice (1-indexed inclusive). Validated lightly —
  // out-of-range bounds clamp rather than throw, matching how `slice()`
  // behaves elsewhere in the toolkit.
  let pages = result.pages;
  if (args.pages && args.pages.length === 2) {
    const [from, to] = args.pages;
    if (typeof from === "number" && typeof to === "number" && from > 0 && to >= from) {
      pages = result.pages.slice(from - 1, to);
    }
  }

  const out: ReadPdfResult = {
    path: rel,
    name:
      rel
        .split("/")
        .pop()
        ?.replace(/\.pdf$/i, "") ?? rel,
    size_bytes: buf.byteLength,
    mtime: new Date(stat.mtimeMs).toISOString(),
    page_count: pages.length,
    has_text: pages.some((p) => !p.isEmpty),
    pages: pages.map((p) => ({
      page_number: p.pageNumber,
      text: p.text,
      is_empty: p.isEmpty,
      char_count: p.charCount
    })),
    full_text: pages
      .map((p) => p.text)
      .filter((t) => t.length > 0)
      .join("\n\n"),
    total_page_count: result.pageCount
  };

  if (args.include_metadata !== false && Object.keys(result.metadata).length > 0) {
    out.metadata = {
      title: result.metadata.title,
      author: result.metadata.author,
      subject: result.metadata.subject,
      keywords: result.metadata.keywords,
      creator: result.metadata.creator,
      producer: result.metadata.producer,
      creation_date: result.metadata.creationDate,
      mod_date: result.metadata.modDate
    };
  }

  return out;
}

// ─── obsidian_ocr_pdf (v2.10.0) ─────────────────────────────────────────────
// Image-only / scanned PDFs return `has_text: false` from obsidian_read_pdf
// (v2.7.0+). This tool runs Tesseract OCR over each page bitmap, completing
// the PDF retrieval story. Tesseract.js + @napi-rs/canvas are
// optionalDependencies — clean install-hint error if missing.

export interface OcrPdfArgs {
  /** Vault-relative path to the .pdf file. */
  path: string;
  /**
   * Tesseract language pack(s). Default `'eng'`. Multi-lang via `'+'`,
   * e.g. `'eng+rus'` for English+Russian mixed scans.
   */
  lang?: string;
  /** Optional 1-indexed inclusive page range, e.g. [2, 5] runs OCR on pages 2..5. */
  pages?: [number, number];
  /**
   * Render scale (DPI multiplier). Higher = better OCR accuracy on small
   * text but more memory + slower render. Default 2 (~150 DPI). Capped at
   * 4 server-side.
   */
  scale?: number;
}

export interface OcrPdfPage {
  page_number: number;
  text: string;
  is_empty: boolean;
  char_count: number;
  /** Tesseract's mean confidence for this page, 0-100. */
  confidence: number;
}

export interface OcrPdfResult {
  path: string;
  name: string;
  size_bytes: number;
  mtime: string;
  page_count: number;
  total_page_count: number;
  has_text: boolean;
  pages: OcrPdfPage[];
  full_text: string;
  /** Mean confidence across pages with text. NaN if all pages empty. */
  mean_confidence: number;
  /** Languages used for OCR (whatever the caller passed). */
  langs: string;
}

export async function ocrPdf(vault: Vault, args: OcrPdfArgs): Promise<OcrPdfResult> {
  await vault.ensureExists();
  if (!args.path) throw new Error("path is required");
  const normalized = args.path.toLowerCase().endsWith(".pdf") ? args.path : `${args.path}.pdf`;
  const abs = vault.resolveInside(normalized);
  const stat = await vault.stat(abs); // throws if missing or excluded
  const rel = vault.toRel(abs);

  const buf = await vault.readBinaryFile(abs);
  // Lazy import — keeps the markdown-only path zero-cost when tesseract /
  // canvas optionalDeps aren't installed.
  const { extractPdfWithOcr } = await import("./ocr.js");
  const result = await extractPdfWithOcr(buf, {
    ...(args.lang ? { langs: args.lang } : {}),
    ...(args.pages ? { pages: args.pages } : {}),
    ...(typeof args.scale === "number" ? { scale: args.scale } : {})
  });

  return {
    path: rel,
    name:
      rel
        .split("/")
        .pop()
        ?.replace(/\.pdf$/i, "") ?? rel,
    size_bytes: buf.byteLength,
    mtime: new Date(stat.mtimeMs).toISOString(),
    page_count: result.pages.length,
    total_page_count: result.pageCount,
    has_text: result.hasText,
    pages: result.pages.map((p) => ({
      page_number: p.pageNumber,
      text: p.text,
      is_empty: p.isEmpty,
      char_count: p.charCount,
      confidence: Math.round(p.confidence * 10) / 10
    })),
    full_text: result.fullText,
    mean_confidence: Number.isFinite(result.meanConfidence) ? Math.round(result.meanConfidence * 10) / 10 : Number.NaN,
    langs: result.langs
  };
}
