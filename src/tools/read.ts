import { parseDql, runDql } from "../dql.js";
import type { Embed, Wikilink } from "../parser.js";
import type { FileEntry, Vault } from "../vault.js";
import { findBestMatch, normalizeTag, stripMd } from "./meta.js";
import { sliceSnippet } from "./search.js";
import { extractFrontmatterTagsLower, resolveTarget } from "./write.js";

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
