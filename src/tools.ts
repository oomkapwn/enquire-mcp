import * as path from "node:path";
import matter from "gray-matter";
import { parseDql, runDql } from "./dql.js";
import type { Embed, Wikilink } from "./parser.js";
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

export async function readNote(
  vault: Vault,
  args: { path?: string; title?: string }
): Promise<{
  path: string;
  title: string;
  content: string;
  frontmatter: Record<string, unknown>;
  wikilinks: Wikilink[];
  embeds: Embed[];
  tags: string[];
  mtime: string;
}> {
  await vault.ensureExists();
  const entry = await resolveTarget(vault, args);
  const { parsed, mtimeMs } = await vault.readNote(entry.absPath, entry.mtimeMs);
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
    throw lastErr instanceof Error ? lastErr : new Error(`Note not found: ${args.path}`);
  }
  if (args.title) {
    const found = await vault.findByTitle(args.title);
    if (!found) throw new Error(`No note found with title: ${args.title}`);
    return found;
  }
  throw new Error("Either path or title is required");
}

function findBestMatch(entries: FileEntry[], target: string, fromNote?: string): FileEntry | null {
  if (target.startsWith("./") || target.startsWith("../") || target.includes("/../")) {
    if (fromNote) {
      const fromDir = path.dirname(fromNote);
      const joined = path.posix.normalize(path.posix.join(fromDir.split(path.sep).join("/"), target));
      const lower = stripMd(joined).toLowerCase();
      const rel = entries.find((e) => stripMd(e.relPath).toLowerCase() === lower);
      if (rel) return rel;
    }
  }
  const norm = stripMd(target).toLowerCase();
  const exact = entries.filter((e) => stripMd(e.basename).toLowerCase() === norm);
  if (exact.length === 1) return exact[0] ?? null;
  if (exact.length > 1 && fromNote) {
    const fromDir = path.dirname(fromNote);
    const sameDir = exact.find((e) => path.dirname(e.relPath) === fromDir);
    if (sameDir) return sameDir;
  }
  if (exact.length > 0) return exact[0] ?? null;
  if (target.includes("/")) {
    const lower = stripMd(target).toLowerCase();
    const path1 = entries.find((e) => stripMd(e.relPath).toLowerCase() === lower);
    if (path1) return path1;
    const path2 = entries.find((e) => stripMd(e.relPath).toLowerCase().endsWith(`/${lower}`));
    if (path2) return path2;
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
