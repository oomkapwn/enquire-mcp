// v3.2.0 — Obsidian Bases (`.base`) file support.
//
// Bases are Obsidian's first-class structured-data primitive (GA mid-2026):
// YAML files that define filters/views/formulas/properties over the vault's
// markdown notes. See https://obsidian.md/help/bases/syntax for the spec.
//
// Scope of this module:
//   - Parse .base YAML files (read-only).
//   - Execute a SUBSET of the filter DSL against vault notes:
//       * tag predicates: `tag == "x"`, `tag != "x"`, `taggedWith(file.file, "x")`
//       * path predicates: `path startsWith "X"`, `path contains "X"`,
//         `file.path startsWith "X"`, `file.name == "X"` (v3.5.0)
//       * link predicates: `linksTo(file.file, "Target")` (v3.5.0 — uses
//         the per-note outbound wikilink set; basename-resolved, case-insensitive)
//       * frontmatter equality: `<key> == <value>`, `<key> != <value>`,
//         `<key> contains "<substr>"`
//       * combinators: `and`, `or`, `not`
//       * boolean literals + bare-word property paths
//
// Out of scope (deferred):
//   - Date arithmetic (`inDate`, `> 6mo`, etc) — needs a date parser
//   - Formula evaluator (`concat`, `price / age`) — needs an expression engine
//   - Summaries — would require aggregation pass
//   - View rendering (we surface views as metadata, agent decides how to use them)
//
// Why this scope: covers the ~90% case (most user-authored .base filters
// are tag/path/frontmatter checks). Anything fancier requires the formula
// evaluator which is several days of work — explicit deferral.

import * as path from "node:path";
import { z } from "zod";
import { extractWikilinks } from "./parser.js";
import type { Vault } from "./vault.js";

/** Top-level shape of a parsed `.base` file. Mirrors the Obsidian schema. */
export interface ParsedBase {
  /** Global filter applying to all views (string or recursive object). */
  filters?: BaseFilter;
  /** Derived properties (formula expressions as strings). NOT evaluated by us. */
  formulas?: Record<string, string>;
  /** Display configuration per property. */
  properties?: Record<string, { displayName?: string; [k: string]: unknown }>;
  /** Aggregations. NOT evaluated by us. */
  summaries?: Record<string, unknown>;
  /** Views: how data is rendered. We surface as metadata. */
  views?: Array<{
    type: string;
    name?: string;
    filters?: BaseFilter;
    [k: string]: unknown;
  }>;
}

/**
 * Filter DSL — either a string predicate ("status != \"done\"") or a recursive
 * combinator object. Mirrors the Obsidian YAML grammar.
 */
export type BaseFilter = string | { and: BaseFilter[] } | { or: BaseFilter[] } | { not: BaseFilter };

/** What `obsidian_list_bases` returns per file. */
export interface BaseSummary {
  path: string;
  name: string;
  size_bytes: number;
  mtime: string;
  view_count: number;
  view_names: string[];
}

/** What `obsidian_read_base` returns. Strict subset of `ParsedBase` plus
 *  the source path so callers can re-fetch. */
export interface BaseDocument {
  path: string;
  name: string;
  filters?: BaseFilter;
  formulas?: Record<string, string>;
  properties?: Record<string, { displayName?: string; [k: string]: unknown }>;
  summaries?: Record<string, unknown>;
  views: Array<{
    type: string;
    name: string | null;
    filters?: BaseFilter;
    [k: string]: unknown;
  }>;
}

/** What `obsidian_query_base` returns per matching note. */
export interface BaseQueryHit {
  path: string;
  title: string;
  /** Frontmatter keys+values used in matching, for transparency. */
  matched_on: Record<string, unknown>;
}

export interface BaseQueryResult {
  base_path: string;
  view: string | null;
  /**
   * v3.6.2 HN-1 — count of ALL matching notes in the vault, NOT just the
   * returned slice. Pre-3.6.2 this was `matches.length` after the limit
   * cap, which underreported when more matches existed than `limit`.
   * Callers can now reliably tell when a result was truncated by
   * comparing `total_matched > matches.length` (or check `truncated`).
   */
  total_matched: number;
  /** v3.6.2 HN-1 — true iff `total_matched > matches.length` (i.e. the
   *  `limit` capped the response). */
  truncated: boolean;
  /** Sub-set of matches (truncated to limit). */
  matches: BaseQueryHit[];
  /**
   * Predicates the parser couldn't evaluate (formula calls, linksTo, etc).
   * v3.6.2 HN-2 — under strict mode (the new default) these now exclude
   * the row instead of admitting it. Listed verbatim so callers can see
   * what was REJECTED — empty array = all predicates fully evaluated.
   */
  unevaluated_predicates: string[];
}

/** Lazy gray-matter (already a project dep) for frontmatter parse. */
let GrayMatter: typeof import("gray-matter") | null = null;
async function getGrayMatter(): Promise<typeof import("gray-matter")> {
  if (GrayMatter) return GrayMatter;
  GrayMatter = (await import("gray-matter")).default as unknown as typeof import("gray-matter");
  return GrayMatter;
}

/**
 * Lazy js-yaml (already pulled in via gray-matter) for .base YAML parse.
 * No @types/js-yaml in deps; we use the minimal surface as a structural type.
 */
interface JsYamlModule {
  load(input: string, opts?: { schema?: unknown }): unknown;
  SAFE_SCHEMA: unknown;
}
let JsYaml: JsYamlModule | null = null;
async function getJsYaml(): Promise<JsYamlModule> {
  if (JsYaml) return JsYaml;
  // @ts-expect-error — js-yaml has no @types in this project; structural cast.
  const mod = (await import("js-yaml")) as { default?: JsYamlModule } & JsYamlModule;
  JsYaml = mod.default ?? mod;
  return JsYaml;
}

/** Schema-validate the parsed YAML. Throws on shapes we don't support. */
const filterShape: z.ZodType<BaseFilter> = z.lazy(() =>
  z.union([
    z.string(),
    z.object({ and: z.array(filterShape) }).strict(),
    z.object({ or: z.array(filterShape) }).strict(),
    z.object({ not: filterShape }).strict()
  ])
);

const baseShape = z
  .object({
    filters: filterShape.optional(),
    formulas: z.record(z.string(), z.string()).optional(),
    properties: z.record(z.string(), z.object({ displayName: z.string().optional() }).passthrough()).optional(),
    summaries: z.record(z.string(), z.unknown()).optional(),
    views: z
      .array(
        z
          .object({
            type: z.string(),
            name: z.string().optional(),
            filters: filterShape.optional()
          })
          .passthrough()
      )
      .optional()
  })
  .passthrough();

/** Parse a .base file body into typed structure. Throws on malformed YAML. */
export async function parseBase(body: string): Promise<ParsedBase> {
  const yaml = await getJsYaml();
  const raw = (yaml.load(body, { schema: yaml.SAFE_SCHEMA }) as Record<string, unknown> | null) ?? {};
  const parsed = baseShape.parse(raw);
  return parsed as ParsedBase;
}

// ─── obsidian_list_bases ───────────────────────────────────────────────────

export async function listBases(vault: Vault, args: { folder?: string; limit?: number }): Promise<BaseSummary[]> {
  await vault.ensureExists();
  const limit = args.limit ?? 100;
  const all = await vault.listFilesByExtension(".base", args.folder);
  const out: BaseSummary[] = [];
  for (const e of all) {
    if (out.length >= limit) break;
    let viewCount = 0;
    let viewNames: string[] = [];
    let size = 0;
    try {
      const buf = await vault.readBinaryFile(e.absPath);
      size = buf.byteLength;
      const parsed = await parseBase(buf.toString("utf8"));
      viewCount = parsed.views?.length ?? 0;
      viewNames = parsed.views?.map((v, i) => v.name ?? `<unnamed view ${i}>`) ?? [];
    } catch {
      // Malformed base — fall through with 0 counts. Don't poison the listing.
    }
    out.push({
      path: e.relPath,
      name: e.basename.replace(/\.base$/i, ""),
      size_bytes: size,
      mtime: new Date(e.mtimeMs).toISOString(),
      view_count: viewCount,
      view_names: viewNames
    });
  }
  out.sort((a, b) => b.mtime.localeCompare(a.mtime));
  return out;
}

// ─── obsidian_read_base ────────────────────────────────────────────────────

/**
 * Read and parse a `.base` file.
 *
 * v3.7.12 H2 — path normalization parity with `readCanvas` / `readPdf`:
 *   - `path` is required (rejects empty string)
 *   - extension auto-appended (`Books` → `Books.base`)
 *   - non-`.base` paths rejected (caller can't accidentally read a `.md`
 *     file through this surface and trigger parser errors)
 *   - resolves through `vault.resolveInside` (path-traversal guard)
 *   - `stat()` checked early — fail fast on missing/excluded files
 *   - returned `path` is the canonical vault-relative form, so callers
 *     can re-issue requests by the same key regardless of how they
 *     spelled the input
 */
export async function readBase(vault: Vault, args: { path: string }): Promise<BaseDocument> {
  await vault.ensureExists();
  if (!args.path) throw new Error("path is required");
  // Reject paths whose explicit extension is something other than `.base`.
  // (An empty extension is fine — we append `.base` below.)
  const lower = args.path.toLowerCase();
  const ext = path.extname(lower);
  if (ext && ext !== ".base") {
    throw new Error(`obsidian_read_base only accepts .base files (got ${ext || "<no ext>"}): ${args.path}`);
  }
  const normalized = lower.endsWith(".base") ? args.path : `${args.path}.base`;
  const abs = vault.resolveInside(normalized);
  await vault.stat(abs); // throws if missing or excluded — fail fast
  const rel = vault.toRel(abs);

  const buf = await vault.readBinaryFile(abs);
  const parsed = await parseBase(buf.toString("utf8"));
  return {
    path: rel,
    name: path.basename(rel).replace(/\.base$/i, ""),
    ...(parsed.filters !== undefined ? { filters: parsed.filters } : {}),
    ...(parsed.formulas ? { formulas: parsed.formulas } : {}),
    ...(parsed.properties ? { properties: parsed.properties } : {}),
    ...(parsed.summaries ? { summaries: parsed.summaries } : {}),
    views: (parsed.views ?? []).map((v) => ({
      ...v,
      name: v.name ?? null
    }))
  };
}

// ─── obsidian_query_base ───────────────────────────────────────────────────

export interface QueryBaseArgs {
  /** Path to the .base file (vault-relative). */
  path: string;
  /** Optional view-name filter. When set, the view's filters are concat'd
   *  with the global filter via AND (matching Obsidian semantics). */
  view?: string;
  /** Cap on matches returned (default 50). */
  limit?: number;
  /** Extra folder scope on top of the .base's filters. */
  folder?: string;
}

/**
 * Run a base's filter against the vault's markdown notes. Returns a list
 * of matching notes plus any predicates we couldn't evaluate.
 *
 * Implementation: walks the vault, parses each note's frontmatter, evals
 * the filter tree against (file.path, frontmatter, tags). Tags come from
 * frontmatter `tags:` AND inline `#tags` in the body.
 *
 * NOT a full Obsidian DSL implementation — see module header for the
 * subset we support.
 */
export async function queryBase(vault: Vault, args: QueryBaseArgs): Promise<BaseQueryResult> {
  await vault.ensureExists();
  const limit = args.limit ?? 50;
  const baseDoc = await readBase(vault, { path: args.path });

  // Resolve effective filter — global AND view-specific (Obsidian semantics).
  let effectiveFilter: BaseFilter | undefined = baseDoc.filters;
  let effectiveViewName: string | null = null;
  if (args.view !== undefined) {
    const view = baseDoc.views.find((v) => v.name === args.view);
    if (!view)
      throw new Error(`Base view not found: ${args.view} (available: ${baseDoc.views.map((v) => v.name).join(", ")})`);
    effectiveViewName = view.name;
    if (view.filters !== undefined) {
      effectiveFilter = baseDoc.filters !== undefined ? { and: [baseDoc.filters, view.filters] } : view.filters;
    }
  }

  // Walk the vault. We use the markdown listing for now; PDFs/canvas are
  // not exposed to base queries (Obsidian itself only queries .md notes).
  //
  // v3.6.2 HN-1 — walk ALL notes without early break, so `total_matched`
  // reflects the full count. The `limit` is applied AFTER the walk by
  // slicing. Memory cost is bounded by the vault's matching subset (worst
  // case the whole markdown listing × constant per-hit overhead) which is
  // acceptable: an Obsidian vault that doesn't fit in memory for a single
  // walk would already break dozens of other code paths in this server.
  const matches: BaseQueryHit[] = [];
  const unevaluated = new Set<string>();
  const gm = await getGrayMatter();
  const notes = await vault.listFilesByExtension(".md", args.folder);
  for (const e of notes) {
    let fm: Record<string, unknown> = {};
    let body = "";
    try {
      const raw = await vault.readFile(e.absPath);
      const parsed = gm(raw);
      fm = (parsed.data as Record<string, unknown>) ?? {};
      body = parsed.content ?? "";
    } catch {
      continue;
    }
    const tags = collectTags(fm, body);
    // v3.5.0 — collect outbound wikilink targets (basename-normalized,
    // lowercased) for `linksTo()` predicate evaluation. We don't resolve
    // against the vault's basename index here — `linksTo("Foo")` just
    // checks whether the note has a `[[Foo]]` (or `[[foo]]`, `[[Foo.md]]`,
    // `[[Foo#section]]`) outbound link; matching the basename is the
    // semantic Obsidian uses too.
    const outbound = new Set<string>();
    for (const link of extractWikilinks(body)) {
      const t = link.target.split(/[#^]/)[0]?.trim();
      if (!t) continue;
      const norm = (t.split("/").pop() ?? t).replace(/\.md$/i, "").toLowerCase();
      if (norm) outbound.add(norm);
    }
    const ctx: EvalContext = {
      path: e.relPath.replace(/\\/g, "/"),
      tags,
      frontmatter: fm,
      outbound,
      unevaluated
    };
    const matched = effectiveFilter === undefined ? true : evalFilter(effectiveFilter, ctx);
    if (matched) {
      matches.push({
        path: e.relPath,
        title: e.basename.replace(/\.md$/i, ""),
        matched_on: pickMatchedFm(fm, ["tags", "status", "type"])
      });
    }
  }
  matches.sort((a, b) => a.path.localeCompare(b.path));
  // v3.6.2 HN-1 — `total_matched` is the full count (post-walk); `matches`
  // is the truncated slice. `truncated` is the bit-flag callers should
  // check before assuming `matches.length === total_matched`.
  const totalMatched = matches.length;
  const sliced = matches.slice(0, limit);
  return {
    // v3.7.12 H2 — return canonical vault-relative path (the form
    // `readBase` normalized to) so callers can round-trip the result
    // back into `obsidian_read_base` without re-normalizing themselves.
    base_path: baseDoc.path,
    view: effectiveViewName,
    total_matched: totalMatched,
    truncated: totalMatched > sliced.length,
    matches: sliced,
    unevaluated_predicates: [...unevaluated]
  };
}

interface EvalContext {
  path: string;
  tags: string[];
  frontmatter: Record<string, unknown>;
  /**
   * v3.5.0 — outbound wikilink targets (basename, lowercased, no .md
   * extension, no section/block refs). Powers the `linksTo(file.file, "X")`
   * predicate. Set rather than array because membership lookup is the
   * only operation we need.
   */
  outbound: Set<string>;
  /**
   * v3.6.2 HN-2 — predicates we couldn't evaluate get pushed here.
   * Under STRICT mode (the new default) the row is EXCLUDED on an unknown
   * predicate, not admitted. Pre-3.6.2 we returned `true` (permissive),
   * which silently caused over-inclusion: a typo in a predicate name
   * (`taggedWWith` instead of `taggedWith`) matched every note in the
   * vault, hiding the bug behind plausible-looking results.
   */
  unevaluated: Set<string>;
}

/**
 * v3.6.2 HN-2 — allowlist of predicate name prefixes the DSL recognizes.
 * Used purely for documentation / stderr warning text — the actual
 * dispatching still happens via the regex chain in `evalPredicate`.
 * Update both when adding a new predicate.
 */
const KNOWN_PREDICATES = Object.freeze([
  "true",
  "false",
  "taggedWith(file.file, ...)",
  "linksTo(file.file, ...)",
  'tag == "..." / tag != "..."',
  'path startsWith "..." / path contains "..."',
  'file.path startsWith "..." / file.path contains "..."',
  'file.name == "..." / file.name != "..."',
  '<key> == <value> / <key> != <value> / <key> contains "..."'
] as const);

/**
 * v3.6.2 HN-2 — stderr warning is rate-limited to ONE message per
 * predicate string per process, so a single typo doesn't drown out logs
 * on a vault with 10k notes. Module-level Set is fine because the daemon
 * is single-process; the worst case across multiple `serve` sessions is
 * one log line each.
 */
/**
 * v3.9.0-rc.15 — max distinct entries tracked for warn-once dedup. Caps the
 * module-level set so a stream of distinct malformed predicates (attacker- or
 * agent-controlled `.base` input) can't grow it without bound over a
 * long-lived `serve` process.
 */
export const MAX_WARNED_PREDICATES = 1000;

/**
 * Add `value` to a dedup `set` only while it's under `max` entries — a bounded
 * "warn once" tracker. Past the cap, returns false (caller may still act, but
 * the value isn't tracked, so it could re-fire later — an acceptable trade vs.
 * unbounded memory). Pure + exported for unit testing.
 *
 * @returns true if the value was newly added; false if already present OR the
 *   set is at `max` capacity.
 */
export function boundedSetAdd(set: Set<string>, value: string, max: number): boolean {
  if (set.has(value)) return false;
  if (set.size >= max) return false;
  set.add(value);
  return true;
}

const warnedUnknownPredicates = new Set<string>();
function warnUnknownPredicate(expr: string): void {
  // Bounded dedup: skip if already warned OR the tracker is at capacity (past
  // the cap a distinct predicate may re-warn once — fine; unbounded growth is not).
  if (warnedUnknownPredicates.has(expr)) return;
  boundedSetAdd(warnedUnknownPredicates, expr, MAX_WARNED_PREDICATES);
  const known = KNOWN_PREDICATES.join(" | ");
  process.stderr.write(
    `enquire: bases.ts — unknown predicate '${expr}'; row excluded (strict mode). Known predicates: ${known}\n`
  );
}

function evalFilter(f: BaseFilter, ctx: EvalContext): boolean {
  if (typeof f === "string") return evalPredicate(f, ctx);
  if ("and" in f) return f.and.every((sub) => evalFilter(sub, ctx));
  if ("or" in f) return f.or.some((sub) => evalFilter(sub, ctx));
  if ("not" in f) return !evalFilter(f.not, ctx);
  return false;
}

/**
 * Evaluate a single predicate string against the eval context. Subset:
 *   - `taggedWith(file.file, "x")` / `tag == "x"` / `tag != "x"`
 *   - v3.5.0: `linksTo(file.file, "Target")` (basename, case-insensitive)
 *   - `path startsWith "X"` / `path contains "X"`
 *   - v3.5.0: `file.path startsWith "X"` / `file.path contains "X"` (alias)
 *   - v3.5.0: `file.name == "X"` / `file.name != "X"` (basename eq, case-insensitive)
 *   - `<key> == <value>` / `<key> != <value>` / `<key> contains "<substr>"`
 *   - boolean literals: `true`, `false`
 *
 * Anything else (v3.6.2 HN-2 — STRICT mode): pushed to ctx.unevaluated and
 * returns `false` (fail-closed — exclude row). Pre-3.6.2 we returned `true`
 * (over-permissive), which let typos silently match every note. The
 * unevaluated set is still surfaced to the caller via
 * `BaseQueryResult.unevaluated_predicates` so a typo is visible in the
 * response itself, not just in stderr.
 */
function evalPredicate(raw: string, ctx: EvalContext): boolean {
  const expr = raw.trim();
  if (!expr) return true;

  // Boolean literals.
  if (expr === "true") return true;
  if (expr === "false") return false;

  // taggedWith(file.file, "x")
  const taggedWith = /^taggedWith\(\s*file\.file\s*,\s*(["'])([^"']+)\1\s*\)$/.exec(expr);
  if (taggedWith) {
    const tag = (taggedWith[2] ?? "").toLowerCase().replace(/^#/, "");
    return ctx.tags.includes(tag);
  }

  // v3.5.0 — linksTo(file.file, "Target") — outbound wikilink check.
  // Resolution mirrors Obsidian: basename match (case-insensitive),
  // strips .md extension and section/block refs from the target.
  const linksTo = /^linksTo\(\s*file\.file\s*,\s*(["'])([^"']+)\1\s*\)$/.exec(expr);
  if (linksTo) {
    const target = (linksTo[2] ?? "").trim();
    if (!target) return false;
    const norm = (target.split("/").pop() ?? target).split(/[#^]/)[0]?.replace(/\.md$/i, "").toLowerCase();
    return norm ? ctx.outbound.has(norm) : false;
  }

  // tag == "x" / tag != "x"
  const tagEq = /^tag\s*(==|!=)\s*(["'])([^"']+)\2$/.exec(expr);
  if (tagEq) {
    const op = tagEq[1];
    const tag = (tagEq[3] ?? "").toLowerCase().replace(/^#/, "");
    const has = ctx.tags.includes(tag);
    return op === "==" ? has : !has;
  }

  // path startsWith "X" / path contains "X"
  // v3.5.0 — also accept `file.path startsWith` / `file.path contains` as
  // aliases (Obsidian's canonical syntax uses the `file.` prefix).
  const pathOp = /^(?:file\.)?path\s+(startsWith|contains)\s+(["'])([^"']+)\2$/.exec(expr);
  if (pathOp) {
    const op = pathOp[1];
    const needle = pathOp[3] ?? "";
    return op === "startsWith" ? ctx.path.startsWith(needle) : ctx.path.includes(needle);
  }

  // v3.5.0 — file.name == "X" / file.name != "X". Basename equality
  // (case-insensitive, .md stripped).
  const fileNameEq = /^file\.name\s*(==|!=)\s*(["'])([^"']+)\2$/.exec(expr);
  if (fileNameEq) {
    const op = fileNameEq[1];
    const want = (fileNameEq[3] ?? "").replace(/\.md$/i, "").toLowerCase();
    const got = (ctx.path.split("/").pop() ?? ctx.path).replace(/\.md$/i, "").toLowerCase();
    const eq = got === want;
    return op === "==" ? eq : !eq;
  }

  // <key> contains "<substr>"  — e.g. `status contains "doing"`
  const fmContains = /^([A-Za-z_][\w.-]*)\s+contains\s+(["'])([^"']+)\2$/.exec(expr);
  if (fmContains) {
    const key = fmContains[1] ?? "";
    const needle = fmContains[3] ?? "";
    const v = ctx.frontmatter[key];
    if (typeof v === "string") return v.includes(needle);
    if (Array.isArray(v)) return v.some((x) => typeof x === "string" && x.includes(needle));
    return false;
  }

  // <key> == <value> / <key> != <value>  — value can be quoted string,
  // number, or boolean literal.
  const fmEq = /^([A-Za-z_][\w.-]*)\s*(==|!=)\s*(.+)$/.exec(expr);
  if (fmEq) {
    const key = fmEq[1] ?? "";
    const op = fmEq[2];
    const rhsRaw = (fmEq[3] ?? "").trim();
    const lhs = ctx.frontmatter[key];
    const rhs = parseLiteral(rhsRaw);
    if (rhs === SKIP) {
      // v3.6.2 HN-2 — unparseable RHS literal (bare identifier, etc) is
      // surfaced in unevaluated AND fails-closed (excludes the row),
      // matching strict-mode semantics for unknown predicates. Pre-3.6.2
      // returned `true` (permissive).
      ctx.unevaluated.add(expr);
      warnUnknownPredicate(expr);
      return false;
    }
    const eq = literalEqual(lhs, rhs);
    return op === "==" ? eq : !eq;
  }

  // v3.6.2 HN-2 — STRICT mode: unknown predicate → row excluded.
  // The expr is surfaced in `unevaluated_predicates` so the caller sees
  // the typo, and a one-time stderr warning explains the change.
  ctx.unevaluated.add(expr);
  warnUnknownPredicate(expr);
  return false;
}

const SKIP = Symbol("skip");
function parseLiteral(raw: string): unknown {
  const t = raw.trim();
  if (t === "true") return true;
  if (t === "false") return false;
  if (t === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  const quoted = /^(["'])(.*)\1$/.exec(t);
  if (quoted) return quoted[2] ?? "";
  return SKIP;
}

function literalEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) return a.some((x) => literalEqual(x, b));
  if (typeof a === "number" && typeof b === "number") return a === b;
  if (typeof a === "string" && typeof b === "string") return a === b;
  return false;
}

/** Collect tags from frontmatter `tags:` (string or array) AND inline
 *  `#tags` in the body. Lowercased + leading-# stripped. */
function collectTags(fm: Record<string, unknown>, body: string): string[] {
  const out = new Set<string>();
  const fmTags = fm.tags;
  if (typeof fmTags === "string") {
    for (const t of fmTags.split(/[\s,]+/).filter(Boolean)) out.add(t.toLowerCase().replace(/^#/, ""));
  } else if (Array.isArray(fmTags)) {
    for (const t of fmTags) {
      if (typeof t === "string") out.add(t.toLowerCase().replace(/^#/, ""));
    }
  }
  // Inline #tags. Matches `#word`, `#word/subword`, ignores leading-# in
  // headings (lines starting with # are markdown headings, not tags).
  for (const line of body.split("\n")) {
    if (/^#{1,6}\s/.test(line)) continue;
    for (const m of line.matchAll(/(?:^|\s)(#[A-Za-z][\w/-]*)/g)) {
      const tag = (m[1] ?? "").slice(1).toLowerCase();
      if (tag) out.add(tag);
    }
  }
  return [...out];
}

/** Pick a few well-known frontmatter keys for the `matched_on` summary
 *  (helps callers see WHY a note matched). */
function pickMatchedFm(fm: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    if (fm[k] !== undefined) out[k] = fm[k];
  }
  return out;
}
