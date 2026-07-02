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
import { load } from "js-yaml";
import { z } from "zod";
import { parseFrontmatter } from "./frontmatter.js";
import { foldName, foldTag, lookupFoldedAny, lookupFoldedKey, nfc } from "./name-fold.js";
import { extractWikilinks, stripCodeAndInline } from "./parser.js";
import { capScanEntries } from "./tools/limits.js";
import type { Vault } from "./vault.js";
import { splitLines } from "./wildcard-match.js";

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

// v3.10.0-rc.53 — frontmatter + `.base` YAML now go through js-yaml@5 directly (rc.6: @4 → @5)
// (`load`/`dump` are safe-by-default — the v3 `safeLoad`/`safeDump` semantics). gray-matter
// was dropped (it hard-bound js-yaml@3's removed `safeLoad`, which pinned the vulnerable
// js-yaml@3 in the tree — GHSA-h67p-54hq-rp68). Note frontmatter parses via the shared
// `parseFrontmatter`; `.base` YAML parses via `load` below.

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
  // js-yaml@5 `load` is safe-by-default (YAML 1.2 core: no merge-key, no `!!js` — the v3 SAFE_SCHEMA
  // semantics). v3.11.0-rc.6: js-yaml@5 THROWS ("expected a document") on an empty/whitespace-only
  // body where v4 returned `undefined`, so guard an empty `.base` to `{}` (empty base = no fields)
  // before loading — preserves the v4 `load(body) ?? {}` contract.
  const raw = body.trim() === "" ? {} : ((load(body) as Record<string, unknown> | null) ?? {});
  const parsed = baseShape.parse(raw);
  return parsed as ParsedBase;
}

// ─── obsidian_list_bases ───────────────────────────────────────────────────

export async function listBases(vault: Vault, args: { folder?: string; limit?: number }): Promise<BaseSummary[]> {
  await vault.ensureExists();
  const limit = args.limit ?? 100;
  const all = await vault.listFilesByExtension(".base", args.folder);
  // v3.10.0-rc.76 (full-audit MEDIUM) — sort by mtime DESC BEFORE truncating to `limit`; see
  // media.ts listCanvases. Walk order != mtime order, so truncate-then-sort returned a not-newest
  // subset on vaults with > limit .base files, breaking the documented "newest first" contract.
  all.sort((a, b) => b.mtimeMs - a.mtimeMs);
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
  // v3.10.0-rc.24 (audit L) — DoS cap. `obsidian_query_base` is always-registered
  // and bearer-reachable on serve-http, and reads every matched note's full body;
  // an unbounded whole-vault content scan is a DoS amplifier. `capScanEntries`
  // bounds it at MAX_SCAN_NOTES (partial + logged on overflow) — the same
  // defense-in-depth its O(N) sibling `runDql` got in rc.18 (M4). (`limit` is
  // applied AFTER the walk to keep `total_matched` honest, so it can't bound the
  // scan itself.)
  const notes = capScanEntries(await vault.listFilesByExtension(".md", args.folder), "obsidian_query_base");
  for (const e of notes) {
    let fm: Record<string, unknown> = {};
    let body = "";
    try {
      const raw = await vault.readFile(e.absPath);
      const parsed = parseFrontmatter(raw);
      fm = (parsed.data as Record<string, unknown>) ?? {};
      body = parsed.content ?? "";
    } catch {
      continue;
    }
    // v3.11.5-rc.3 (post-rc.2 re-sweep, PARSER-DESYNC class) — sanitize (strip fenced +
    // inline code) BEFORE collecting tags/links, matching the canonical parseNote. Pre-rc.3
    // both collectTags and extractWikilinks ran on the RAW (fm-stripped-only) body, so a
    // `#tag` or `[[link]]` whose only occurrence is inside a ``` fence was treated as real —
    // `tag ==` / `linksTo()` .base filters then matched notes they shouldn't (parity break
    // with obsidian_search + Obsidian, which ignore links/tags inside code).
    const sanitizedBody = stripCodeAndInline(body);
    const tags = collectTags(fm, sanitizedBody);
    // v3.5.0 — collect outbound wikilink targets (basename-normalized,
    // lowercased) for `linksTo()` predicate evaluation. We don't resolve
    // against the vault's basename index here — `linksTo("Foo")` just
    // checks whether the note has a `[[Foo]]` (or `[[foo]]`, `[[Foo.md]]`,
    // `[[Foo#section]]`) outbound link; matching the basename is the
    // semantic Obsidian uses too.
    const outbound = new Set<string>();
    for (const link of extractWikilinks(sanitizedBody)) {
      const t = link.target.split(/[#^]/)[0]?.trim();
      if (!t) continue;
      const norm = foldName((t.split("/").pop() ?? t).replace(/\.md$/i, ""));
      if (norm) outbound.add(norm);
    }
    const ctx: EvalContext = {
      // v3.10.0-rc.73 (post-rc.70 re-sweep, NFC sibling of rc.69) — NFC-normalize the path so the
      // `path`/`file.path` startsWith/contains predicates resolve an NFD-on-disk path (macOS APFS
      // returns NFD) against an NFC user literal. NFC-only, NOT case-fold: `path`/`file.path` is
      // case-SENSITIVE in Obsidian/Dataview. The `file.name ==` branch already folds via foldName
      // (NFC + case), idempotent under this normalize; the result projection (line ~346) keeps the
      // raw relPath verbatim.
      path: e.relPath.replace(/\\/g, "/").normalize("NFC"),
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
 * on a vault with 10k notes. The dedup Set is module-level (the daemon is
 * single-process).
 *
 * v3.9.0-rc.15 — the original "one log line each" reasoning only held for a
 * FIXED set of predicates; a stream of DISTINCT malformed predicates
 * (attacker- or agent-controlled `.base` input) would grow the Set without
 * bound over a long-lived `serve`. `MAX_WARNED_PREDICATES` caps it (past the
 * cap a distinct predicate may re-warn — an acceptable trade vs. a leak).
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
  if ("not" in f) {
    // v3.10.0-rc.38 (audit #5) — negation must not INVERT the fail-closed
    // semantics. An UNEVALUATED child predicate (unknown/typo/unparseable, incl.
    // `inDate(...)`) fail-closes to `false` = "exclude the row" (v3.6.2 HN-2);
    // blindly negating that to `true` would INCLUDE every row — the exact
    // over-inclusion HN-2 was created to prevent, reachable via `not:`. Evaluate the
    // child against a FRESH `unevaluated` probe (the real ctx.unevaluated is SHARED
    // across all rows, so a size delta only fires for the first row that hits the
    // predicate); if the child touched ANY unevaluated predicate it wasn't
    // evaluable → fail-closed (exclude) regardless of polarity. Predicates the
    // probe collected are merged back so they still surface to the caller.
    const probe = new Set<string>();
    const inner = evalFilter(f.not, { ...ctx, unevaluated: probe });
    for (const p of probe) ctx.unevaluated.add(p);
    if (probe.size > 0) return false; // child wasn't evaluable → exclude, never negate-to-include
    return !inner;
  }
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
    const tag = foldTag(taggedWith[2] ?? ""); // v3.11.0-rc.9 (L-TAG-1) — NFC + case fold + strip
    return ctx.tags.includes(tag);
  }

  // v3.5.0 — linksTo(file.file, "Target") — outbound wikilink check.
  // Resolution mirrors Obsidian: basename match (case-insensitive),
  // strips .md extension and section/block refs from the target.
  const linksTo = /^linksTo\(\s*file\.file\s*,\s*(["'])([^"']+)\1\s*\)$/.exec(expr);
  if (linksTo) {
    const target = (linksTo[2] ?? "").trim();
    if (!target) return false;
    const stripped = (target.split("/").pop() ?? target).split(/[#^]/)[0]?.replace(/\.md$/i, "");
    const norm = stripped === undefined ? undefined : foldName(stripped);
    return norm ? ctx.outbound.has(norm) : false;
  }

  // tag == "x" / tag != "x"
  const tagEq = /^tag\s*(==|!=)\s*(["'])([^"']+)\2$/.exec(expr);
  if (tagEq) {
    const op = tagEq[1];
    const tag = foldTag(tagEq[3] ?? ""); // v3.11.0-rc.9 (L-TAG-1) — NFC + case fold + strip
    const has = ctx.tags.includes(tag);
    return op === "==" ? has : !has;
  }

  // path startsWith "X" / path contains "X"
  // v3.5.0 — also accept `file.path startsWith` / `file.path contains` as
  // aliases (Obsidian's canonical syntax uses the `file.` prefix).
  const pathOp = /^(?:file\.)?path\s+(startsWith|contains)\s+(["'])([^"']+)\2$/.exec(expr);
  if (pathOp) {
    const op = pathOp[1];
    // v3.10.0-rc.73 — NFC-normalize the literal too (ctx.path is already NFC), so an NFD-typed
    // literal also matches. NFC-only; path comparison stays case-sensitive.
    const needle = (pathOp[3] ?? "").normalize("NFC");
    return op === "startsWith" ? ctx.path.startsWith(needle) : ctx.path.includes(needle);
  }

  // v3.5.0 — file.name == "X" / file.name != "X". Basename equality
  // (case-insensitive, .md stripped).
  const fileNameEq = /^file\.name\s*(==|!=)\s*(["'])([^"']+)\2$/.exec(expr);
  if (fileNameEq) {
    const op = fileNameEq[1];
    const want = foldName((fileNameEq[3] ?? "").replace(/\.md$/i, ""));
    const got = foldName((ctx.path.split("/").pop() ?? ctx.path).replace(/\.md$/i, ""));
    const eq = got === want;
    return op === "==" ? eq : !eq;
  }

  // <key> contains "<substr>"  — e.g. `status contains "doing"`
  const fmContains = /^([A-Za-z_][\w.-]*)\s+contains\s+(["'])([^"']+)\2$/.exec(expr);
  if (fmContains) {
    const key = fmContains[1] ?? "";
    const needle = fmContains[3] ?? "";
    // v3.11.0-rc.10 (H1) — case/NFC-insensitive KEY lookup (Obsidian property names
    // are case-insensitive); the VALUE compare below stays case-sensitive (Bases semantics).
    const v = lookupFoldedKey(ctx.frontmatter, key).value;
    // v3.11.0-rc.9 (audit re-verify) — NFC-normalize both sides (case-PRESERVED,
    // matching Obsidian Bases' case-sensitive `contains`) so `café`(NFC) matches an
    // NFD-stored value. The DQL twin folds case too (nfcLower); Bases keeps case by design.
    const needleNfc = nfc(needle);
    if (typeof v === "string") return nfc(v).includes(needleNfc);
    if (Array.isArray(v)) return v.some((x) => typeof x === "string" && nfc(x).includes(needleNfc));
    return false;
  }

  // <key> == <value> / <key> != <value>  — value can be quoted string,
  // number, or boolean literal.
  const fmEq = /^([A-Za-z_][\w.-]*)\s*(==|!=)\s*(.+)$/.exec(expr);
  if (fmEq) {
    const key = fmEq[1] ?? "";
    const op = fmEq[2];
    const rhsRaw = (fmEq[3] ?? "").trim();
    // v3.11.0-rc.10 (H1) — case/NFC-insensitive KEY lookup (key names case-insensitive
    // per Obsidian; the literalEqual value compare below remains case-sensitive).
    const lhs = lookupFoldedKey(ctx.frontmatter, key).value;
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
  // v3.11.0-rc.9 (audit re-verify) — NFC-normalize string equality (case-PRESERVED,
  // Bases semantics) so `café`(NFC) === `café`(NFD); even a case-sensitive engine
  // should treat the same string in two Unicode forms as equal.
  if (typeof a === "string" && typeof b === "string") return nfc(a) === nfc(b);
  return false;
}

/** Collect tags from frontmatter `tags:` (string or array) AND inline
 *  `#tags` in the body. Lowercased + leading-# stripped. */
function collectTags(fm: Record<string, unknown>, body: string): string[] {
  const out = new Set<string>();
  // v3.11.0-rc.13 (rc.12-audit AUD-03) — fold the `tags` KEY so a `Tags:` frontmatter
  // property is visible to Bases tag filters (the producer sibling of the H1 key-fold class).
  const fmTags = lookupFoldedAny(fm, ["tags"]);
  // v3.11.0-rc.9 (L-TAG-1) — foldTag (NFC + case fold + strip) so a Unicode
  // frontmatter tag canonicalizes identically to the predicate side.
  if (typeof fmTags === "string") {
    for (const t of fmTags.split(/[\s,]+/).filter(Boolean)) out.add(foldTag(t));
  } else if (Array.isArray(fmTags)) {
    for (const t of fmTags) {
      if (typeof t === "string") out.add(foldTag(t));
    }
  }
  // Inline #tags. Matches `#word`, `#word/subword`, ignores leading-# in
  // headings (lines starting with # are markdown headings, not tags).
  for (const line of splitLines(body)) {
    if (/^#{1,6}\s/.test(line)) continue;
    // v3.11.0-rc.10 (M1, external audit) — was ASCII-only (`#[A-Za-z][\w/-]*`), which
    // silently dropped EVERY non-ASCII inline tag (accented `#café` → `#caf`, CJK
    // `#日本語` → no match). Now Unicode-aware (`\p{L}` + `u` flag), and the line is
    // NFC-normalized FIRST so an NFD `#café` (macOS APFS) composes its combining mark
    // into the base letter before matching (parity with parser's extractInlineTags).
    for (const m of line.normalize("NFC").matchAll(/(?:^|\s)(#[\p{L}][\p{L}\p{N}_/-]*)/gu)) {
      const tag = foldTag(m[1] ?? ""); // strip `#` + NFC + lowercase
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
