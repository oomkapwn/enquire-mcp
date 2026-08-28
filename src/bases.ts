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
import { foldName, foldTag, lookupFoldedAny, lookupFoldedKey, nfc, nfcLower } from "./name-fold.js";
import { extractWikilinks, stripCodeAndInline } from "./parser.js";
import { MAX_SCAN_NOTES } from "./tools/limits.js";
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
  /**
   * Bounded diagnostics for the legacy `tags`/`status`/`type` keys and any
   * frontmatter keys referenced by the active filter. Ordinary small legacy
   * containers retain their public shape; complex or oversized values become
   * short type/size markers rather than being copied into every hit.
   */
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

const MAX_BASE_JSON_DEPTH = 64;
const MAX_BASE_JSON_NODES = 50_000;
const MAX_BASE_JSON_BYTES = 5 * 1024 * 1024;
const MAX_BASE_FILES = 10_000;
const MAX_BASE_LIST_VISITED_ENTRIES = 100_000;
const MAX_BASE_QUERY_VISITED_ENTRIES = 200_000;
const MAX_BASE_RESULT_LIMIT = 500;
const MAX_LISTED_VIEW_NAMES = 100;
const MAX_LISTED_VIEW_NAME_BYTES = 256;
const MAX_BASE_FILTER_NODES = 256;
const MAX_BASE_PREDICATE_BYTES = 4 * 1024;
const MAX_MATCHED_KEYS = 64;
const MAX_MATCHED_KEY_BYTES = 256;
const MAX_MATCHED_STRING_BYTES = 256;
const MAX_MATCHED_VALUE_DEPTH = 4;
const MAX_MATCHED_VALUE_NODES = 64;
const MAX_MATCHED_VALUE_BYTES = 1024;
const MAX_MATCHED_CONTAINER_ENTRIES = 32;
const LEGACY_MATCHED_KEYS = ["tags", "status", "type"] as const;
const LEGACY_MATCHED_FOLDED_KEYS = new Set<string>(LEGACY_MATCHED_KEYS.map((key) => nfcLower(key)));

interface AdmissionFrame {
  value: unknown;
  depth: number;
}

function jsonScalarBytes(value: string | number | boolean | null): number {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError("Bases data contains a non-JSON scalar");
  return Buffer.byteLength(encoded, "utf8");
}

/**
 * Iteratively admit one bounded, acyclic plain-JSON value graph.
 *
 * YAML aliases preserve object identity, including cycles. Rejecting every
 * repeated container identity before recursive Zod/filter/output code sees it
 * prevents both cycle overflows and alias-amplified output. The byte ledger is
 * the exact compact-JSON size for admitted shapes (keys, punctuation, and each
 * scalar occurrence), without calling recursive `JSON.stringify` on the graph.
 *
 * @param value - Parsed YAML value to validate in place.
 * @param label - Stable diagnostic prefix identifying the source surface.
 * @returns Nothing; throws when the graph is outside the admission envelope.
 */
export function assertBoundedBaseJson(value: unknown, label = "Bases data"): void {
  const stack: AdmissionFrame[] = [{ value, depth: 0 }];
  const discovered = new WeakSet<object>();
  if (typeof value === "object" && value !== null) discovered.add(value);
  let scheduledNodes = 1;
  let serializedBytes = 0;

  const addBytes = (bytes: number): void => {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || serializedBytes > MAX_BASE_JSON_BYTES - bytes) {
      throw new Error(`${label} exceeds the ${MAX_BASE_JSON_BYTES}-byte JSON budget`);
    }
    serializedBytes += bytes;
  };
  const schedule = (child: unknown, depth: number): void => {
    scheduledNodes += 1;
    if (scheduledNodes > MAX_BASE_JSON_NODES) {
      throw new Error(`${label} exceeds the ${MAX_BASE_JSON_NODES}-node budget`);
    }
    if (typeof child === "object" && child !== null) {
      if (discovered.has(child)) throw new Error(`${label} contains a YAML alias or cycle`);
      discovered.add(child);
    }
    stack.push({ value: child, depth });
  };

  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) break;
    if (frame.depth > MAX_BASE_JSON_DEPTH) {
      throw new Error(`${label} exceeds the maximum depth of ${MAX_BASE_JSON_DEPTH}`);
    }
    const current = frame.value;
    if (current === null || typeof current === "string" || typeof current === "boolean") {
      addBytes(jsonScalarBytes(current));
      continue;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new Error(`${label} contains a non-finite number`);
      addBytes(jsonScalarBytes(current));
      continue;
    }
    if (typeof current !== "object") throw new Error(`${label} contains a non-JSON value`);

    let prototype: object | null;
    let ownKeys: (string | symbol)[];
    try {
      prototype = Object.getPrototypeOf(current);
      ownKeys = Reflect.ownKeys(current);
    } catch {
      throw new Error(`${label} contains an exotic object`);
    }

    if (Array.isArray(current)) {
      if (prototype !== Array.prototype || current.length > MAX_BASE_JSON_NODES) {
        throw new Error(`${label} contains an exotic or oversized array`);
      }
      if (ownKeys.length !== current.length + 1 || !ownKeys.includes("length")) {
        throw new Error(`${label} contains a sparse or decorated array`);
      }
      addBytes(2 + Math.max(0, current.length - 1));
      for (let index = current.length - 1; index >= 0; index--) {
        const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
        if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
          throw new Error(`${label} contains a sparse or accessor-backed array`);
        }
        schedule(descriptor.value, frame.depth + 1);
      }
      continue;
    }

    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${label} contains a non-plain object`);
    }
    if (ownKeys.some((key) => typeof key === "symbol")) {
      throw new Error(`${label} contains a symbol-keyed property`);
    }
    const keys = ownKeys as string[];
    addBytes(2 + Math.max(0, keys.length - 1));
    for (let index = keys.length - 1; index >= 0; index--) {
      const key = keys[index];
      if (key === undefined) continue;
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
        throw new Error(`${label} contains a non-enumerable or accessor-backed property`);
      }
      addBytes(jsonScalarBytes(key) + 1);
      schedule(descriptor.value, frame.depth + 1);
    }
  }
}

function positiveBaseLimit(value: number | undefined, fallback: number, label: string): number {
  const admitted = value ?? fallback;
  if (!Number.isSafeInteger(admitted) || admitted < 1 || admitted > MAX_BASE_RESULT_LIMIT) {
    throw new TypeError(`${label} must be a positive safe integer no greater than ${MAX_BASE_RESULT_LIMIT}`);
  }
  return admitted;
}

function boundedViewNames(views: NonNullable<ParsedBase["views"]>): string[] {
  const names: string[] = [];
  const retained = Math.min(views.length, MAX_LISTED_VIEW_NAMES);
  for (let index = 0; index < retained; index++) {
    const name = views[index]?.name ?? `<unnamed view ${index}>`;
    names.push(
      name.length <= MAX_LISTED_VIEW_NAME_BYTES && Buffer.byteLength(name, "utf8") <= MAX_LISTED_VIEW_NAME_BYTES
        ? name
        : `<oversized view ${index} name omitted>`
    );
  }
  if (views.length > retained) names.push(`<${views.length - retained} additional views omitted>`);
  return names;
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
  // js-yaml@5 `load` is safe-by-default (YAML 1.2 core: no merge-key, no `!!js` — the v3 SAFE_SCHEMA
  // semantics). v3.11.0-rc.6: js-yaml@5 THROWS ("expected a document") on an empty/whitespace-only
  // body where v4 returned `undefined`, so guard an empty `.base` to `{}` (empty base = no fields)
  // before loading — preserves the v4 `load(body) ?? {}` contract.
  if (typeof body !== "string") throw new TypeError("Base body must be a string");
  if (Buffer.byteLength(body, "utf8") > MAX_BASE_JSON_BYTES) {
    throw new Error(`Base YAML exceeds the ${MAX_BASE_JSON_BYTES}-byte input budget`);
  }
  const raw = body.trim() === "" ? {} : ((load(body) as Record<string, unknown> | null) ?? {});
  assertBoundedBaseJson(raw, "Base YAML");
  const parsed = baseShape.parse(raw);
  return parsed as ParsedBase;
}

// ─── obsidian_list_bases ───────────────────────────────────────────────────

export async function listBases(vault: Vault, args: { folder?: string; limit?: number }): Promise<BaseSummary[]> {
  const limit = positiveBaseLimit(args.limit, 100, "listBases limit");
  await vault.ensureExists();
  const listing = await vault.listFilesByExtensionsBounded(
    [".base"],
    MAX_BASE_FILES,
    MAX_BASE_LIST_VISITED_ENTRIES,
    args.folder
  );
  if (!listing.complete) {
    throw new Error(
      `obsidian_list_bases requires a complete inventory; bounded walk stopped after ${listing.visitedEntries} entries`
    );
  }
  const all = listing.entries;
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
      viewNames = boundedViewNames(parsed.views ?? []);
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

const TAGGED_WITH_PATTERN = /^taggedWith\(\s*file\.file\s*,\s*(["'])([^"']+)\1\s*\)$/;
const LINKS_TO_PATTERN = /^linksTo\(\s*file\.file\s*,\s*(["'])([^"']+)\1\s*\)$/;
const TAG_EQUALITY_PATTERN = /^tag\s*(==|!=)\s*(["'])([^"']+)\2$/;
const PATH_OPERATION_PATTERN = /^(?:file\.)?path\s+(startsWith|contains)\s+(["'])([^"']+)\2$/;
const FILE_NAME_EQUALITY_PATTERN = /^file\.name\s*(==|!=)\s*(["'])([^"']+)\2$/;
const FRONTMATTER_CONTAINS_PATTERN = /^([A-Za-z_][\w.-]*)\s+contains\s+(["'])([^"']+)\2$/;
const FRONTMATTER_EQUALITY_PATTERN = /^([A-Za-z_][\w.-]*)\s*(==|!=)\s*(.+)$/;

function referencedFrontmatterKey(raw: string): string | null {
  const expr = raw.trim();
  if (
    expr === "" ||
    expr === "true" ||
    expr === "false" ||
    TAGGED_WITH_PATTERN.test(expr) ||
    LINKS_TO_PATTERN.test(expr) ||
    TAG_EQUALITY_PATTERN.test(expr) ||
    PATH_OPERATION_PATTERN.test(expr) ||
    FILE_NAME_EQUALITY_PATTERN.test(expr)
  ) {
    return null;
  }
  return FRONTMATTER_CONTAINS_PATTERN.exec(expr)?.[1] ?? FRONTMATTER_EQUALITY_PATTERN.exec(expr)?.[1] ?? null;
}

function compileReferencedFrontmatterKeys(filter: BaseFilter | undefined): string[] {
  if (filter === undefined) return [];
  const stack: BaseFilter[] = [filter];
  const byFoldedKey = new Map<string, string>();
  let filterNodes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    filterNodes += 1;
    if (filterNodes > MAX_BASE_FILTER_NODES) {
      throw new Error(`Base filter exceeds the ${MAX_BASE_FILTER_NODES}-node evaluation budget`);
    }
    if (typeof current === "string") {
      if (Buffer.byteLength(current, "utf8") > MAX_BASE_PREDICATE_BYTES) {
        throw new Error(`Base predicate exceeds ${MAX_BASE_PREDICATE_BYTES} UTF-8 bytes`);
      }
      const key = referencedFrontmatterKey(current);
      if (key === null) continue;
      if (Buffer.byteLength(key, "utf8") > MAX_MATCHED_KEY_BYTES) {
        throw new Error(`Base filter key exceeds ${MAX_MATCHED_KEY_BYTES} UTF-8 bytes`);
      }
      const folded = nfcLower(key);
      if (!byFoldedKey.has(folded)) {
        if (byFoldedKey.size >= MAX_MATCHED_KEYS) {
          throw new Error(`Base filter references more than ${MAX_MATCHED_KEYS} frontmatter keys`);
        }
        byFoldedKey.set(folded, key);
      }
      continue;
    }
    if ("not" in current) {
      stack.push(current.not);
      continue;
    }
    const children = "and" in current ? current.and : current.or;
    for (let index = children.length - 1; index >= 0; index--) {
      const child = children[index];
      if (child !== undefined) stack.push(child);
    }
  }
  return [...byFoldedKey.values()];
}

function compareHitPath(left: string, right: string): number {
  const localized = left.localeCompare(right);
  if (localized !== 0) return localized;
  return left < right ? -1 : left > right ? 1 : 0;
}

function insertBoundedHit(hits: BaseQueryHit[], hit: BaseQueryHit, limit: number): void {
  let low = 0;
  let high = hits.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const candidate = hits[middle];
    if (candidate !== undefined && compareHitPath(candidate.path, hit.path) <= 0) low = middle + 1;
    else high = middle;
  }
  hits.splice(low, 0, hit);
  if (hits.length > limit) hits.pop();
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
  const limit = positiveBaseLimit(args.limit, 50, "queryBase limit");
  await vault.ensureExists();
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
  const referencedKeys = compileReferencedFrontmatterKeys(effectiveFilter);

  // Walk the vault. We use the markdown listing for now; PDFs/canvas are
  // not exposed to base queries (Obsidian itself only queries .md notes).
  //
  // Walk the complete admitted snapshot so `total_matched` remains exact.
  // An incomplete bounded receipt is an error: silently returning a prefix
  // while calling its count `total_matched` would be an integrity failure.
  const matches: BaseQueryHit[] = [];
  let totalMatched = 0;
  const unevaluated = new Set<string>();
  const listing = await vault.listFilesByExtensionsBounded(
    [".md"],
    MAX_SCAN_NOTES,
    MAX_BASE_QUERY_VISITED_ENTRIES,
    args.folder
  );
  if (!listing.complete) {
    throw new Error(
      `obsidian_query_base cannot report an exact total; bounded walk stopped after ${listing.visitedEntries} entries`
    );
  }
  const notes = listing.entries;
  for (const e of notes) {
    let raw: string;
    try {
      raw = await vault.readFile(e.absPath);
    } catch {
      // A listed note that cannot be read makes total_matched inexact.
      throw new Error(`obsidian_query_base cannot report an exact total; unreadable note ${e.relPath}`);
    }
    let fm: Record<string, unknown> = {};
    let body = "";
    try {
      const parsed = parseFrontmatter(raw);
      assertBoundedBaseJson(parsed.data, `Frontmatter in ${e.relPath}`);
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
      totalMatched += 1;
      const last = matches.at(-1);
      if (matches.length < limit || (last !== undefined && compareHitPath(e.relPath, last.path) < 0)) {
        insertBoundedHit(
          matches,
          {
            path: e.relPath,
            title: e.basename.replace(/\.md$/i, ""),
            matched_on: matchedFrontmatterDiagnostics(fm, referencedKeys)
          },
          limit
        );
      }
    }
  }
  // v3.6.2 HN-1 — `total_matched` is the full count (post-walk); `matches`
  // is the truncated slice. `truncated` is the bit-flag callers should
  // check before assuming `matches.length === total_matched`.
  return {
    // v3.7.12 H2 — return canonical vault-relative path (the form
    // `readBase` normalized to) so callers can round-trip the result
    // back into `obsidian_read_base` without re-normalizing themselves.
    base_path: baseDoc.path,
    view: effectiveViewName,
    total_matched: totalMatched,
    truncated: totalMatched > matches.length,
    matches,
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
  const taggedWith = TAGGED_WITH_PATTERN.exec(expr);
  if (taggedWith) {
    const tag = foldTag(taggedWith[2] ?? ""); // v3.11.0-rc.9 (L-TAG-1) — NFC + case fold + strip
    return ctx.tags.includes(tag);
  }

  // v3.5.0 — linksTo(file.file, "Target") — outbound wikilink check.
  // Resolution mirrors Obsidian: basename match (case-insensitive),
  // strips .md extension and section/block refs from the target.
  const linksTo = LINKS_TO_PATTERN.exec(expr);
  if (linksTo) {
    const target = (linksTo[2] ?? "").trim();
    if (!target) return false;
    const stripped = (target.split("/").pop() ?? target).split(/[#^]/)[0]?.replace(/\.md$/i, "");
    const norm = stripped === undefined ? undefined : foldName(stripped);
    return norm ? ctx.outbound.has(norm) : false;
  }

  // tag == "x" / tag != "x"
  const tagEq = TAG_EQUALITY_PATTERN.exec(expr);
  if (tagEq) {
    const op = tagEq[1];
    const tag = foldTag(tagEq[3] ?? ""); // v3.11.0-rc.9 (L-TAG-1) — NFC + case fold + strip
    const has = ctx.tags.includes(tag);
    return op === "==" ? has : !has;
  }

  // path startsWith "X" / path contains "X"
  // v3.5.0 — also accept `file.path startsWith` / `file.path contains` as
  // aliases (Obsidian's canonical syntax uses the `file.` prefix).
  const pathOp = PATH_OPERATION_PATTERN.exec(expr);
  if (pathOp) {
    const op = pathOp[1];
    // v3.10.0-rc.73 — NFC-normalize the literal too (ctx.path is already NFC), so an NFD-typed
    // literal also matches. NFC-only; path comparison stays case-sensitive.
    const needle = (pathOp[3] ?? "").normalize("NFC");
    return op === "startsWith" ? ctx.path.startsWith(needle) : ctx.path.includes(needle);
  }

  // v3.5.0 — file.name == "X" / file.name != "X". Basename equality
  // (case-insensitive, .md stripped).
  const fileNameEq = FILE_NAME_EQUALITY_PATTERN.exec(expr);
  if (fileNameEq) {
    const op = fileNameEq[1];
    const want = foldName((fileNameEq[3] ?? "").replace(/\.md$/i, ""));
    const got = foldName((ctx.path.split("/").pop() ?? ctx.path).replace(/\.md$/i, ""));
    const eq = got === want;
    return op === "==" ? eq : !eq;
  }

  // <key> contains "<substr>"  — e.g. `status contains "doing"`
  const fmContains = FRONTMATTER_CONTAINS_PATTERN.exec(expr);
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
  const fmEq = FRONTMATTER_EQUALITY_PATTERN.exec(expr);
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

/** Collect tags from frontmatter `tags:` / `tag:` (string or array) AND inline
 *  `#tags` in the body. Lowercased + leading-# stripped. */
function collectTags(fm: Record<string, unknown>, body: string): string[] {
  const out = new Set<string>();
  // v3.11.0-rc.13 (rc.12-audit AUD-03) — fold the `tags`/`tag` KEY so a `Tags:` /
  // `Tag:` frontmatter property is visible to Bases tag filters (the producer
  // sibling of the H1 key-fold class).
  const fmTags = lookupFoldedAny(fm, ["tags", "tag"]);
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

type BaseMatchScalar = string | number | boolean | null;

interface MatchedProjectionState {
  seen: WeakSet<object>;
  nodes: number;
  bytes: number;
}

const MATCHED_PROJECTION_OMITTED = Symbol("matched projection omitted");

function addMatchedProjectionBytes(state: MatchedProjectionState, bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || state.bytes > MAX_MATCHED_VALUE_BYTES - bytes) {
    throw MATCHED_PROJECTION_OMITTED;
  }
  state.bytes += bytes;
}

/** Clone a small JSON-like value without retaining aliases to frontmatter. */
function projectMatchedValue(value: unknown, depth: number, state: MatchedProjectionState): unknown {
  if (depth > MAX_MATCHED_VALUE_DEPTH) throw MATCHED_PROJECTION_OMITTED;
  state.nodes += 1;
  if (state.nodes > MAX_MATCHED_VALUE_NODES) throw MATCHED_PROJECTION_OMITTED;

  if (value === null || typeof value === "boolean") {
    addMatchedProjectionBytes(state, jsonScalarBytes(value));
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw MATCHED_PROJECTION_OMITTED;
    addMatchedProjectionBytes(state, jsonScalarBytes(value));
    return value;
  }
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > MAX_MATCHED_STRING_BYTES) throw MATCHED_PROJECTION_OMITTED;
    addMatchedProjectionBytes(state, jsonScalarBytes(value));
    return value;
  }
  if (typeof value !== "object") throw MATCHED_PROJECTION_OMITTED;
  if (state.seen.has(value)) throw MATCHED_PROJECTION_OMITTED;
  state.seen.add(value);

  const prototype = Object.getPrototypeOf(value);
  const ownKeys = Reflect.ownKeys(value);
  if (Array.isArray(value)) {
    if (
      prototype !== Array.prototype ||
      value.length > MAX_MATCHED_CONTAINER_ENTRIES ||
      ownKeys.length !== value.length + 1 ||
      !ownKeys.includes("length")
    ) {
      throw MATCHED_PROJECTION_OMITTED;
    }
    addMatchedProjectionBytes(state, 2 + Math.max(0, value.length - 1));
    const clone: unknown[] = [];
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
        throw MATCHED_PROJECTION_OMITTED;
      }
      clone.push(projectMatchedValue(descriptor.value, depth + 1, state));
    }
    return clone;
  }

  if (prototype !== Object.prototype && prototype !== null) throw MATCHED_PROJECTION_OMITTED;
  if (ownKeys.length > MAX_MATCHED_CONTAINER_ENTRIES || ownKeys.some((key) => typeof key === "symbol")) {
    throw MATCHED_PROJECTION_OMITTED;
  }
  const keys = ownKeys as string[];
  addMatchedProjectionBytes(state, 2 + Math.max(0, keys.length - 1));
  const clone: Record<string, unknown> = {};
  for (const key of keys) {
    if (Buffer.byteLength(key, "utf8") > MAX_MATCHED_KEY_BYTES) throw MATCHED_PROJECTION_OMITTED;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw MATCHED_PROJECTION_OMITTED;
    }
    addMatchedProjectionBytes(state, jsonScalarBytes(key) + 1);
    Object.defineProperty(clone, key, {
      value: projectMatchedValue(descriptor.value, depth + 1, state),
      enumerable: true,
      configurable: true,
      writable: true
    });
  }
  return clone;
}

function matchedValueDiagnostic(value: unknown): BaseMatchScalar {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : "<non-finite number omitted>";
  if (typeof value === "string") {
    if (value.length > MAX_MATCHED_STRING_BYTES) return "<string omitted>";
    const bytes = Buffer.byteLength(value, "utf8");
    return bytes <= MAX_MATCHED_STRING_BYTES ? value : "<string omitted>";
  }
  if (Array.isArray(value)) return `<array omitted: ${value.length} items>`;
  if (typeof value === "object") return "<object omitted>";
  return `<${typeof value} omitted>`;
}

function boundedLegacyMatchedValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") return matchedValueDiagnostic(value);
  try {
    return projectMatchedValue(value, 0, {
      seen: new WeakSet<object>(),
      nodes: 0,
      bytes: 0
    });
  } catch {
    return matchedValueDiagnostic(value);
  }
}

/**
 * Project the stable legacy diagnostics plus keys referenced by the filter.
 *
 * Lookup follows the same case/NFC-folded semantics as evaluation. Legacy keys
 * retain small JSON-like values through a detached, tightly bounded clone.
 * Additional filter keys remain scalar-only diagnostics, so referencing a
 * container cannot turn the response into a repeated frontmatter dump. This
 * is an inventory, not a claim that every key caused an OR branch to match.
 */
function matchedFrontmatterDiagnostics(
  frontmatter: Record<string, unknown>,
  referencedKeys: readonly string[]
): Record<string, unknown> {
  const diagnosticKeys = new Map<string, string>();
  for (const key of LEGACY_MATCHED_KEYS) diagnosticKeys.set(nfcLower(key), key);
  for (const key of referencedKeys) {
    const folded = nfcLower(key);
    if (!diagnosticKeys.has(folded)) diagnosticKeys.set(folded, key);
  }

  const out: Record<string, unknown> = {};
  for (const [foldedKey, key] of diagnosticKeys) {
    const hit = lookupFoldedKey(frontmatter, key);
    if (!hit.present) continue;
    Object.defineProperty(out, key, {
      value: LEGACY_MATCHED_FOLDED_KEYS.has(foldedKey)
        ? boundedLegacyMatchedValue(hit.value)
        : matchedValueDiagnostic(hit.value),
      enumerable: true,
      configurable: true,
      writable: true
    });
  }
  return out;
}
