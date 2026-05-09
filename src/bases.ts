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
//       * path predicates: `path startsWith "X"`, `path contains "X"`
//       * frontmatter equality: `<key> == <value>`, `<key> != <value>`,
//         `<key> contains "<substr>"`
//       * combinators: `and`, `or`, `not`
//       * boolean literals + bare-word property paths
//
// Out of scope (deferred):
//   - Full DSL (linksTo / inDate range / formula evaluator / summaries)
//   - View rendering (we surface views as metadata, agent decides how to use them)
//
// Why this scope: covers the ~90% case (most user-authored .base filters
// are tag/path/frontmatter checks). Anything fancier requires the formula
// evaluator which is several days of work — explicit deferral.

import * as path from "node:path";
import { z } from "zod";
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
  total_matched: number;
  /** Sub-set of matches (truncated to limit). */
  matches: BaseQueryHit[];
  /**
   * Predicates the parser couldn't evaluate (formula calls, linksTo, etc).
   * Listed verbatim so callers know what was IGNORED — these were treated
   * as "true" in our DSL subset (most permissive). Empty array = all
   * predicates fully evaluated.
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

export async function readBase(vault: Vault, args: { path: string }): Promise<BaseDocument> {
  await vault.ensureExists();
  const buf = await vault.readBinaryFile(args.path);
  const parsed = await parseBase(buf.toString("utf8"));
  return {
    path: args.path,
    name: path.basename(args.path).replace(/\.base$/i, ""),
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
  const matches: BaseQueryHit[] = [];
  const unevaluated = new Set<string>();
  const gm = await getGrayMatter();
  const notes = await vault.listFilesByExtension(".md", args.folder);
  for (const e of notes) {
    if (matches.length >= limit) break;
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
    const ctx: EvalContext = {
      path: e.relPath.replace(/\\/g, "/"),
      tags,
      frontmatter: fm,
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
  return {
    base_path: args.path,
    view: effectiveViewName,
    total_matched: matches.length,
    matches: matches.slice(0, limit),
    unevaluated_predicates: [...unevaluated]
  };
}

interface EvalContext {
  path: string;
  tags: string[];
  frontmatter: Record<string, unknown>;
  /** Predicates we couldn't evaluate get pushed here. Treated as `true`
   *  (most permissive) so the rest of the filter still works. */
  unevaluated: Set<string>;
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
 *   - `path startsWith "X"` / `path contains "X"`
 *   - `<key> == <value>` / `<key> != <value>` / `<key> contains "<substr>"`
 *   - boolean literals: `true`, `false`
 *
 * Anything else: pushed to ctx.unevaluated and returns `true` (most
 * permissive — we'd rather over-include than under-include silently).
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

  // tag == "x" / tag != "x"
  const tagEq = /^tag\s*(==|!=)\s*(["'])([^"']+)\2$/.exec(expr);
  if (tagEq) {
    const op = tagEq[1];
    const tag = (tagEq[3] ?? "").toLowerCase().replace(/^#/, "");
    const has = ctx.tags.includes(tag);
    return op === "==" ? has : !has;
  }

  // path startsWith "X" / path contains "X"
  const pathOp = /^path\s+(startsWith|contains)\s+(["'])([^"']+)\2$/.exec(expr);
  if (pathOp) {
    const op = pathOp[1];
    const needle = pathOp[3] ?? "";
    return op === "startsWith" ? ctx.path.startsWith(needle) : ctx.path.includes(needle);
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
      ctx.unevaluated.add(expr);
      return true;
    }
    const eq = literalEqual(lhs, rhs);
    return op === "==" ? eq : !eq;
  }

  // Anything else: log + permissive.
  ctx.unevaluated.add(expr);
  return true;
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
