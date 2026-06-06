import { capScanEntries } from "./tools/limits.js";
import type { FileEntry, Vault } from "./vault.js";

/**
 * The `FROM` clause of a parsed DQL query. `"all"` means scan every note;
 * `"folder"` restricts to a vault-relative subtree; `"tag"` restricts to
 * notes carrying the given tag (frontmatter or inline).
 */
export type Source = { type: "all" } | { type: "folder"; path: string } | { type: "tag"; tag: string };

/** Supported predicate operators in a DQL `WHERE` clause. `like` uses
 *  SQL-LIKE-style `*` wildcards (case-insensitive). */
export type Op = "=" | "!=" | "contains" | "like";

/** A single `WHERE` predicate (`field op value`). */
export interface Predicate {
  /** Field path — either a `file.*` virtual field or a frontmatter key. */
  field: string;
  /** Operator. See {@link Op}. */
  op: Op;
  /** RHS literal. Coerced at parse time: bare numbers → number, `true`/`false`
   *  → boolean, `null` → null, quoted strings → string, bare ident → string. */
  value: string | number | boolean | null;
}

/** A WHERE clause is a disjunction of conjunctions: (A AND B) OR (C AND D). */
export type WhereGroups = Predicate[][];

/**
 * Fully parsed Dataview-Query-Language (DQL) query, ready for
 * {@link runDql}.
 */
export interface DataviewQuery {
  /** Result shape: `LIST` returns one row per note; `TABLE` returns named columns. */
  kind: "LIST" | "TABLE";
  /** Column expressions (TABLE only). Empty for LIST. */
  columns: string[];
  /** Source restriction — see {@link Source}. */
  source: Source;
  /** Disjunction-of-conjunctions WHERE clause. Empty array means no filter. */
  where: WhereGroups;
  /** Optional sort spec. Default is unsorted (source order). */
  sort?: { field: string; dir: "ASC" | "DESC" };
  /** Optional row cap. Falls back to {@link DEFAULT_DQL_ROW_LIMIT} when undefined. */
  limit?: number;
}

/** Thrown by {@link parseDql} when input is not a valid DQL query.
 *  Error message describes the failure point. */
export class DqlParseError extends Error {}

const KEYWORDS = ["FROM", "WHERE", "SORT", "LIMIT"];

/**
 * Parse a Dataview-Query-Language string into a {@link DataviewQuery}.
 * Supports `LIST` / `TABLE` queries with `FROM`, `WHERE`, `SORT`, `LIMIT`
 * clauses. WHERE supports `AND` / `OR` and the {@link Op} operators.
 *
 * Quoted strings are recognized via a simple quote-aware tokenizer so
 * folder names with spaces or operator keywords survive.
 *
 * @param input - Raw DQL text. Whitespace-only input throws.
 * @returns Parsed query ready for {@link runDql}.
 * @throws {DqlParseError} On syntax errors (with a message pointing at the failing clause).
 * @example
 * ```ts
 * const q = parseDql('TABLE file.name FROM "Inbox" WHERE status = "open" SORT mtime DESC LIMIT 10');
 * q.kind;    // "TABLE"
 * q.columns; // ["file.name"]
 * q.source;  // { type: "folder", path: "Inbox" }
 * ```
 */
export function parseDql(input: string): DataviewQuery {
  // No global whitespace collapse here — splitClauses is quote-aware and would
  // otherwise see post-collapsed quoted strings, which silently mangles real
  // folder names and frontmatter values containing repeated whitespace.
  const trimmed = input.trim();
  if (!trimmed) throw new DqlParseError("Empty query");

  const kindMatch = /^(LIST|TABLE)\b\s*(.*)$/i.exec(trimmed);
  if (!kindMatch || kindMatch[1] === undefined) throw new DqlParseError("Query must start with LIST or TABLE");
  const kind = kindMatch[1].toUpperCase() as "LIST" | "TABLE";
  const rest = kindMatch[2] ?? "";

  const clauses = splitClauses(rest);

  const columnsRaw = clauses.head;
  const columns: string[] =
    kind === "TABLE"
      ? columnsRaw
          .split(",")
          .map((c) => c.trim())
          .filter(Boolean)
      : [];

  if (kind === "LIST" && columnsRaw.trim()) {
    throw new DqlParseError(`LIST does not take columns: got "${columnsRaw}"`);
  }

  const source = parseSource(clauses.from ?? "");
  const where = clauses.where ? parseWhere(clauses.where) : [];
  const sort = clauses.sort ? parseSort(clauses.sort) : undefined;
  const limit = clauses.limit !== undefined ? parseLimit(clauses.limit) : undefined;

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
    const prev = i > 0 ? input[i - 1] : undefined;
    if (i === 0 || (prev !== undefined && /\s/.test(prev))) {
      const remaining = input.slice(i);
      const matched = KEYWORDS.find((k) => {
        if (!remaining.toUpperCase().startsWith(k)) return false;
        const after = remaining[k.length];
        return after === undefined || /\s/.test(after);
      });
      if (matched) {
        const tail = parts[parts.length - 1];
        if (tail) tail.content = input.slice(lastEnd, i).trim();
        parts.push({ kw: matched, content: "" });
        i += matched.length;
        lastEnd = i;
        continue;
      }
    }
    i++;
  }
  const last = parts[parts.length - 1];
  if (last) last.content = input.slice(lastEnd).trim();
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
  if (strMatch && strMatch[1] !== undefined) {
    if (!strMatch[1]) throw new DqlParseError(`FROM "" is not allowed; omit the FROM clause to scan the whole vault`);
    return { type: "folder", path: strMatch[1] };
  }
  if (s.startsWith("#")) {
    const tag = s.slice(1).trim();
    if (!tag) throw new DqlParseError(`FROM # requires a tag name (e.g. FROM #idea)`);
    return { type: "tag", tag };
  }
  throw new DqlParseError(`Unsupported FROM source: ${raw}. Use "folder" or #tag.`);
}

function parseWhere(raw: string): WhereGroups {
  const orClauses = splitOnKeyword(raw, "OR");
  if (orClauses.length === 0) throw new DqlParseError(`WHERE clause is empty`);
  const groups: WhereGroups = [];
  for (const orClause of orClauses) {
    if (!orClause.trim()) {
      throw new DqlParseError(`WHERE has an empty OR group — check for trailing or duplicated OR`);
    }
    const andClauses = splitOnKeyword(orClause, "AND");
    if (andClauses.length === 0) {
      throw new DqlParseError(`WHERE has an empty AND group — check for trailing or duplicated AND`);
    }
    for (const ac of andClauses) {
      if (!ac.trim()) {
        throw new DqlParseError(`WHERE has an empty predicate — check for trailing or duplicated AND`);
      }
    }
    groups.push(andClauses.map(parsePredicate));
  }
  return groups;
}

function splitOnKeyword(input: string, keyword: string): string[] {
  const out: string[] = [];
  let last = 0;
  let i = 0;
  let foundAny = false;
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
    const prev = i > 0 ? input[i - 1] : undefined;
    if (i === 0 || (prev !== undefined && /\s/.test(prev))) {
      const slice = input.slice(i, i + keyword.length).toUpperCase();
      const after = input[i + keyword.length];
      if (slice === keyword.toUpperCase() && (after === undefined || /\s/.test(after))) {
        out.push(input.slice(last, i).trim());
        i += keyword.length;
        last = i;
        foundAny = true;
        continue;
      }
    }
    i++;
  }
  // Always push the tail when we saw at least one separator — preserves trailing-empty so
  // validators upstream (parseWhere) can detect malformed `... OR` / `... AND` queries.
  // When no separator was found at all and the whole thing trims to empty, return [].
  const tail = input.slice(last).trim();
  if (foundAny || tail) out.push(tail);
  return out;
}

function parsePredicate(raw: string): Predicate {
  const m = /^([\w.]+)\s*(=|!=|contains|like)\s*(.+)$/i.exec(raw.trim());
  if (!m || m[1] === undefined || m[2] === undefined || m[3] === undefined) {
    throw new DqlParseError(`Cannot parse predicate: ${raw}`);
  }
  return {
    field: m[1],
    op: m[2].toLowerCase() as Op,
    value: parseValue(m[3].trim())
  };
}

function parseValue(raw: string): string | number | boolean | null {
  const strMatch = /^"([^"]*)"$/.exec(raw);
  if (strMatch && strMatch[1] !== undefined) return strMatch[1];
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
}

function parseSort(raw: string): { field: string; dir: "ASC" | "DESC" } {
  const m = /^([\w.]+)(?:\s+(ASC|DESC))?$/i.exec(raw.trim());
  if (!m || m[1] === undefined) throw new DqlParseError(`Cannot parse SORT: ${raw}`);
  return { field: m[1], dir: (m[2]?.toUpperCase() as "ASC" | "DESC") ?? "ASC" };
}

function parseLimit(raw: string): number {
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n <= 0) throw new DqlParseError(`Invalid LIMIT: ${raw} (positive integer required)`);
  return n;
}

interface Row {
  entry: FileEntry;
  frontmatter: Record<string, unknown>;
  tags: string[];
  mtimeMs: number;
  values: Record<string, unknown>;
}

/**
 * Default row cap for {@link runDql} when the query has no `LIMIT` clause.
 * Prevents accidental "TABLE FROM" returning thousands of rows on a
 * large vault.
 */
export const DEFAULT_DQL_ROW_LIMIT = 1000;

/**
 * Execute a parsed DQL query against a vault. Iterates the source
 * restriction, evaluates the WHERE filter per note, sorts (if requested),
 * and applies the row cap. Each result row carries `file.path`,
 * `file.name`, `file.mtime` plus any TABLE-requested columns.
 *
 * @param vault - The vault to query.
 * @param query - Parsed query (from {@link parseDql}).
 * @param opts - Optional overrides; `defaultLimit` replaces
 *   {@link DEFAULT_DQL_ROW_LIMIT} when the query has no `LIMIT`.
 * @returns Result rows in sort order (or source order when unsorted),
 *   truncated to the limit.
 * @example
 * ```ts
 * const q = parseDql('LIST FROM "Inbox" WHERE status = "open"');
 * const rows = await runDql(vault, q);
 * for (const row of rows) console.log(row["file.path"]);
 * ```
 */
export async function runDql(
  vault: Vault,
  query: DataviewQuery,
  opts: { defaultLimit?: number } = {}
): Promise<Array<Record<string, unknown>>> {
  const defaultLimit = opts.defaultLimit ?? DEFAULT_DQL_ROW_LIMIT;
  const folder = query.source.type === "folder" ? query.source.path : undefined;
  // v3.10.0-rc.18 (audit M4) — bound the whole-vault readNote scan. This tool is
  // always-registered and bearer-reachable on serve-http, so an unbounded scan is
  // a DoS amplifier. DQL is a LINEAR query (LIMIT/SORT applied AFTER the scan), so
  // this is a defense-in-depth cap: on a vault larger than MAX_SCAN_NOTES the
  // result is partial (logged once), never a hang. Real vaults are far under it.
  const entries = capScanEntries(await vault.listMarkdown(folder), "obsidian_dataview_query");
  const wantTag = query.source.type === "tag" ? query.source.tag.toLowerCase() : null;

  const rows: Row[] = [];
  for (const entry of entries) {
    const { parsed, mtimeMs } = await vault.readNote(entry.absPath, entry.mtimeMs);
    if (wantTag && !parsed.tags.some((t) => t.toLowerCase() === wantTag)) continue;

    const fieldVal = (field: string) => resolveField(field, entry, parsed.frontmatter, parsed.tags, mtimeMs);
    if (!evalWhere(query.where, fieldVal)) continue;

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
  return rows.slice(0, cap).map((r) => r.values);
}

function evalWhere(where: WhereGroups, fieldVal: (field: string) => unknown): boolean {
  if (where.length === 0) return true;
  return where.some((group) => group.every((pred) => evalPredicate(pred, fieldVal(pred.field))));
}

function resolveField(
  field: string,
  entry: FileEntry,
  frontmatter: Record<string, unknown>,
  tags: string[],
  mtimeMs: number
): unknown {
  switch (field) {
    case "file.name":
      return stripMd(entry.basename);
    case "file.path":
      return entry.relPath;
    case "file.mtime":
      return new Date(mtimeMs).toISOString();
    case "file.tags":
      return tags;
    default:
      return frontmatter[field];
  }
}

function evalPredicate(pred: Predicate, value: unknown): boolean {
  switch (pred.op) {
    case "=":
      if (Array.isArray(value)) return value.some((v) => looseEq(v, pred.value));
      return looseEq(value, pred.value);
    case "!=":
      if (Array.isArray(value)) return !value.some((v) => looseEq(v, pred.value));
      return !looseEq(value, pred.value);
    case "contains":
      if (Array.isArray(value)) {
        // Membership test (case-insensitive exact match) for arrays — matches
        // the Dataview convention. Substring matching on array elements (the
        // pre-v0.8 behavior) caused `file.tags contains "core"` to falsely
        // match a `core-team` tag.
        return value.some((v) => looseEq(v, pred.value));
      }
      if (typeof value === "string" && typeof pred.value === "string") {
        // Strings keep substring semantics — `title contains "draft"` is
        // typically what users want.
        return value.toLowerCase().includes(pred.value.toLowerCase());
      }
      return false;
    case "like": {
      if (typeof pred.value !== "string") return false;
      const re = likeToRegex(pred.value);
      if (Array.isArray(value)) {
        return value.some((v) => typeof v === "string" && re.test(v));
      }
      if (typeof value === "string") return re.test(value);
      return false;
    }
  }
}

/**
 * Defensive cap on a DQL `like` pattern length (v3.9.0-rc.9 audit). NOT a
 * ReDoS guard — {@link likeToRegex} is catastrophic-backtracking-SAFE by
 * construction (it only ever emits `.*` for `*`, never a nested quantifier).
 * This solely bounds regex-compile / match CPU on an absurdly long
 * user-supplied LIKE value from a `.base` / DQL query.
 */
export const MAX_LIKE_PATTERN_LEN = 512;

/** @internal exported for unit tests; not part of the package `exports` map. */
export function likeToRegex(pattern: string): RegExp {
  if (pattern.length > MAX_LIKE_PATTERN_LEN) {
    throw new Error(`dql: LIKE pattern too long (${pattern.length} > ${MAX_LIKE_PATTERN_LEN} chars).`);
  }
  // Single-pass walker so escaping is unambiguous:
  //   *  → .*   (SQL-LIKE-style wildcard, any run of chars)
  //   \* → \*   (literal asterisk; the \ is an escape)
  //   \\ → \\   (literal backslash; the \ escapes the next \)
  //   \d → d    (literal d; SQL-LIKE escape passes char through; pre-v3.7.10
  //              this incorrectly output `\d` which is regex digit-class)
  //   trailing \ → \\  (literal backslash; pre-v3.7.10 emitted a dangling
  //                     escape that produced invalid RegExp)
  // v3.7.10 (external audit #13) — added `*` and `\` to the regex-specials
  // set. `*` is regex-meta (repetition); without it in the set, an escaped
  // `\*` would fall through to the else-branch and output literal `*` which
  // is then mis-interpreted by RegExp. `\` itself is regex-meta and trailing
  // backslash needs explicit handling (see trailing-\\ branch above).
  // biome-ignore lint/suspicious/noTemplateCurlyInString: regex meta-chars list, not a template
  const REGEX_SPECIALS = ".+*^${}()|[]\\";
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    // v3.7.10 (external audit #13) — handle trailing backslash as literal.
    if (ch === "\\" && i + 1 >= pattern.length) {
      out += "\\\\";
      continue;
    }
    if (ch === "\\" && i + 1 < pattern.length) {
      // Backslash escapes the next char. Result is the next char as a
      // regex literal — escape it ONLY if it's regex-special, else pass
      // through. v3.7.10 fix: pre-v3.7.10 unconditionally prepended `\`
      // which turned escape sequences like `\d` into regex digit-class
      // instead of literal `d`.
      const next = pattern[i + 1] as string;
      if (REGEX_SPECIALS.includes(next)) {
        out += `\\${next}`;
      } else {
        out += next;
      }
      i++;
      continue;
    }
    if (ch === "*") {
      out += ".*";
      continue;
    }
    if (ch !== undefined && REGEX_SPECIALS.includes(ch)) {
      out += `\\${ch}`;
      continue;
    }
    out += ch;
  }
  return new RegExp(`^${out}$`, "iu");
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
