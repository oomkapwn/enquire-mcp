import matter from "gray-matter";

export interface Wikilink {
  raw: string;
  target: string;
  section?: string;
  block?: string;
  alias?: string;
}

export type Embed = Wikilink;

export interface ParsedNote {
  frontmatter: Record<string, unknown>;
  body: string;
  wikilinks: Wikilink[];
  embeds: Embed[];
  tags: string[];
}

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
  return {
    frontmatter,
    body,
    wikilinks: extractWikilinks(sanitized),
    embeds: extractEmbeds(sanitized),
    tags: collectTags(frontmatter, sanitized)
  };
}

const WIKILINK_RE = /(?<!!)\[\[([^\]\n]+?)\]\]/g;
const EMBED_RE = /!\[\[([^\]\n]+?)\]\]/g;

export function extractWikilinks(text: string): Wikilink[] {
  return matchLinks(text, WIKILINK_RE);
}

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

export function extractInlineTags(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(TAG_RE)) {
    if (m[1] !== undefined) found.add(m[1]);
  }
  return [...found];
}

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
