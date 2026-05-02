import { Vault, FileEntry } from "./vault.js";

export type Source =
  | { type: "all" }
  | { type: "folder"; path: string }
  | { type: "tag"; tag: string };

export interface Predicate {
  field: string;
  op: "=" | "!=" | "contains";
  value: string | number | boolean | null;
}

export interface DataviewQuery {
  kind: "LIST" | "TABLE";
  columns: string[];
  source: Source;
  where: Predicate[];
  sort?: { field: string; dir: "ASC" | "DESC" };
  limit?: number;
}

export class DqlParseError extends Error {}

const KEYWORDS = ["FROM", "WHERE", "SORT", "LIMIT"];

export function parseDql(input: string): DataviewQuery {
  const trimmed = input.trim().replace(/\s+/g, " ");
  if (!trimmed) throw new DqlParseError("Empty query");

  const kindMatch = /^(LIST|TABLE)\b\s*(.*)$/i.exec(trimmed);
  if (!kindMatch) throw new DqlParseError("Query must start with LIST or TABLE");
  const kind = kindMatch[1].toUpperCase() as "LIST" | "TABLE";
  let rest = kindMatch[2];

  const clauses = splitClauses(rest);

  const columnsRaw = clauses.head;
  const columns: string[] = kind === "TABLE"
    ? columnsRaw.split(",").map(c => c.trim()).filter(Boolean)
    : [];

  if (kind === "LIST" && columnsRaw.trim()) {
    throw new DqlParseError(`LIST does not take columns: got "${columnsRaw}"`);
  }

  const source = parseSource(clauses.from ?? "");
  const where = clauses.where ? parseWhere(clauses.where) : [];
  const sort = clauses.sort ? parseSort(clauses.sort) : undefined;
  const limit = clauses.limit ? parseLimit(clauses.limit) : undefined;

  return { kind, columns, source, where, sort, limit };
}

interface Clauses {
  head: string;
  from?: string;
  where?: string;
  sort?: string;
  limit?: string;
}

function splitClauses(input: string): Clauses {
  const out: Clauses = { head: "" };
  const parts: Array<{ kw: string | "HEAD"; content: string }> = [{ kw: "HEAD", content: "" }];
  let lastEnd = 0;
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === '"') {
      i++;
      while (i < input.length && input[i] !== '"') {
        if (input[i] === "\\" && i + 1 < input.length) i++;
        i++;
      }
      i++;
      continue;
    }
    if (i === 0 || /\s/.test(input[i - 1])) {
      const remaining = input.slice(i);
      const matched = KEYWORDS.find(k => {
        if (!remaining.toUpperCase().startsWith(k)) return false;
        const after = remaining[k.length];
        return after === undefined || /\s/.test(after);
      });
      if (matched) {
        parts[parts.length - 1].content = input.slice(lastEnd, i).trim();
        parts.push({ kw: matched, content: "" });
        i += matched.length;
        lastEnd = i;
        continue;
      }
    }
    i++;
  }
  parts[parts.length - 1].content = input.slice(lastEnd).trim();
  for (const p of parts) {
    if (p.kw === "HEAD") out.head = p.content;
    else if (p.kw === "FROM") out.from = p.content;
    else if (p.kw === "WHERE") out.where = p.content;
    else if (p.kw === "SORT") out.sort = p.content;
    else if (p.kw === "LIMIT") out.limit = p.content;
  }
  return out;
}

function parseSource(raw: string): Source {
  const s = raw.trim();
  if (!s) return { type: "all" };
  const strMatch = /^"([^"]*)"$/.exec(s);
  if (strMatch) return { type: "folder", path: strMatch[1] };
  if (s.startsWith("#")) return { type: "tag", tag: s.slice(1).trim() };
  throw new DqlParseError(`Unsupported FROM source: ${raw}. Use "folder" or #tag.`);
}

function parseWhere(raw: string): Predicate[] {
  const clauses = splitOnKeyword(raw, "AND");
  return clauses.map(parsePredicate);
}

function splitOnKeyword(input: string, keyword: string): string[] {
  const out: string[] = [];
  let last = 0;
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === '"') {
      i++;
      while (i < input.length && input[i] !== '"') {
        if (input[i] === "\\" && i + 1 < input.length) i++;
        i++;
      }
      i++;
      continue;
    }
    if (i === 0 || /\s/.test(input[i - 1])) {
      const slice = input.slice(i, i + keyword.length).toUpperCase();
      const after = input[i + keyword.length];
      if (slice === keyword.toUpperCase() && (after === undefined || /\s/.test(after))) {
        out.push(input.slice(last, i).trim());
        i += keyword.length;
        last = i;
        continue;
      }
    }
    i++;
  }
  const tail = input.slice(last).trim();
  if (tail) out.push(tail);
  return out;
}

function parsePredicate(raw: string): Predicate {
  const m = /^([\w.]+)\s*(=|!=|contains)\s*(.+)$/i.exec(raw.trim());
  if (!m) throw new DqlParseError(`Cannot parse predicate: ${raw}`);
  return {
    field: m[1],
    op: m[2].toLowerCase() as Predicate["op"],
    value: parseValue(m[3].trim())
  };
}

function parseValue(raw: string): string | number | boolean | null {
  const strMatch = /^"([^"]*)"$/.exec(raw);
  if (strMatch) return strMatch[1];
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
}

function parseSort(raw: string): { field: string; dir: "ASC" | "DESC" } {
  const m = /^([\w.]+)(?:\s+(ASC|DESC))?$/i.exec(raw.trim());
  if (!m) throw new DqlParseError(`Cannot parse SORT: ${raw}`);
  return { field: m[1], dir: (m[2]?.toUpperCase() as "ASC" | "DESC") ?? "ASC" };
}

function parseLimit(raw: string): number {
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n <= 0) throw new DqlParseError(`Invalid LIMIT: ${raw}`);
  return Math.floor(n);
}

interface Row {
  entry: FileEntry;
  frontmatter: Record<string, unknown>;
  tags: string[];
  mtimeMs: number;
  values: Record<string, unknown>;
}

export const DEFAULT_DQL_ROW_LIMIT = 1000;

export async function runDql(
  vault: Vault,
  query: DataviewQuery,
  opts: { defaultLimit?: number } = {}
): Promise<Array<Record<string, unknown>>> {
  const defaultLimit = opts.defaultLimit ?? DEFAULT_DQL_ROW_LIMIT;
  const folder = query.source.type === "folder" ? query.source.path : undefined;
  const entries = await vault.listMarkdown(folder);
  const wantTag = query.source.type === "tag" ? query.source.tag.toLowerCase() : null;

  const rows: Row[] = [];
  for (const entry of entries) {
    const { parsed, mtimeMs } = await vault.readNote(entry.absPath, entry.mtimeMs);
    if (wantTag && !parsed.tags.some(t => t.toLowerCase() === wantTag)) continue;

    const fieldVal = (field: string) => resolveField(field, entry, parsed.frontmatter, parsed.tags, mtimeMs);
    if (!query.where.every(p => evalPredicate(p, fieldVal(p.field)))) continue;

    const out: Record<string, unknown> = {
      "file.path": entry.relPath,
      "file.name": stripMd(entry.basename),
      "file.mtime": new Date(mtimeMs).toISOString()
    };
    if (query.kind === "TABLE") {
      for (const col of query.columns) out[col] = fieldVal(col);
    }
    rows.push({ entry, frontmatter: parsed.frontmatter, tags: parsed.tags, mtimeMs, values: out });
  }

  if (query.sort) {
    const { field, dir } = query.sort;
    rows.sort((a, b) => {
      const av = resolveField(field, a.entry, a.frontmatter, a.tags, a.mtimeMs);
      const bv = resolveField(field, b.entry, b.frontmatter, b.tags, b.mtimeMs);
      return compare(av, bv) * (dir === "ASC" ? 1 : -1);
    });
  }

  const cap = query.limit ?? defaultLimit;
  return rows.slice(0, cap).map(r => r.values);
}

function resolveField(
  field: string,
  entry: FileEntry,
  frontmatter: Record<string, unknown>,
  tags: string[],
  mtimeMs: number
): unknown {
  switch (field) {
    case "file.name": return stripMd(entry.basename);
    case "file.path": return entry.relPath;
    case "file.mtime": return new Date(mtimeMs).toISOString();
    case "file.tags": return tags;
    default: return frontmatter[field];
  }
}

function evalPredicate(pred: Predicate, value: unknown): boolean {
  switch (pred.op) {
    case "=":
      if (Array.isArray(value)) return value.some(v => looseEq(v, pred.value));
      return looseEq(value, pred.value);
    case "!=":
      if (Array.isArray(value)) return !value.some(v => looseEq(v, pred.value));
      return !looseEq(value, pred.value);
    case "contains":
      if (Array.isArray(value)) {
        return value.some(v => typeof v === "string" && typeof pred.value === "string" && v.toLowerCase().includes(pred.value.toLowerCase()));
      }
      if (typeof value === "string" && typeof pred.value === "string") {
        return value.toLowerCase().includes(pred.value.toLowerCase());
      }
      return false;
  }
}

function looseEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "string" && typeof b === "string") return a.toLowerCase() === b.toLowerCase();
  if (a == null || b == null) return false;
  return String(a) === String(b);
}

function compare(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

function stripMd(name: string): string {
  return name.replace(/\.md$/i, "");
}
