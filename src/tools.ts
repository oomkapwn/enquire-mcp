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
    if (m && m[1] && m[2]) {
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
  if (vault.isExcluded(toRelCheck)) {
    throw new Error(`Refusing to rename — destination matches --exclude-glob: ${toRelCheck}`);
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

  if (!dryRun) {
    for (const p of plan) {
      await vault.writeNote(p.path, p.after, { overwrite: true });
    }
  }

  return {
    search: args.search,
    replace: args.replace,
    case_sensitive: caseSensitive,
    dry_run: dryRun,
    scope: args.folder ?? "(whole vault)",
    files_scanned: entries.length,
    files_updated: plan.map((p) => ({ path: p.path, occurrences: p.count })),
    total_replacements: total
  };
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
      } catch {
        // Fall through to basename match.
      }
      const basenameMatch = await vault.findByTitle(path.basename(periodicResolved.relPath));
      if (basenameMatch) return basenameMatch;
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
      if (!m || !m[1]) continue;
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

function tokenizeForTfidf(text: string): string[] {
  const lower = text.toLowerCase();
  const out: string[] = [];
  for (const m of lower.matchAll(/[a-z0-9][a-z0-9_-]*/g)) {
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
