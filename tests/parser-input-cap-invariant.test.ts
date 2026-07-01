// v3.10.0-rc.57 (DQL-PARSE-QUADRATIC-DOS) — PARSER-INPUT LENGTH-CAP INVENTORY INVARIANT.
//
// Closes the "always-registered tool feeds an unbounded client string into a superlinear
// parser/regex on the main event loop" CPU-DoS class. Instances:
//   • obsidian_open_questions — `pattern` → regex (capped MAX_QUESTION_PATTERN_LEN, rc.9)
//   • obsidian_dataview_query — `query`  → DQL clause tokenizer (capped MAX_DQL_QUERY_LEN, rc.57)
//
// Each such tool's registered zod input MUST carry a `.max(<cap>)` so a future edit that
// drops the bound (or a NEW parser-fed tool added without one) fails CI rather than waiting
// for the next external audit. Curated-inventory discipline (same shape as
// enforcement-guard-invariant): a genuinely new parser-fed tool is added here by a human
// who must also cap it. The parser sinks ALSO enforce the cap fail-closed (defense in depth);
// this gate pins the cheaper boundary rejection so it can't silently regress.

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "..");
const registry = readFileSync(path.join(repoRoot, "src/tool-registry.ts"), "utf8");

// SCOPE (v3.11.1-rc.1 — reasoned-rejection of the v3.11.0-STABLE external "validate-then-write
// gap" LOW, documented so it is NOT re-litigated): this inventory pins inputs that flow into a
// PARSER/REGEX or a SUPERLINEAR per-note/whole-vault scan — the CPU-DoS class. The write-content
// BODY fields (`create_note.content`, `append_to_note.content`/`separator`) are DELIBERATELY out
// of scope: they flow LINEARLY into `composeNote` → `vault.writeNote`/`appendNote` (one
// `stringifyFrontmatter` + one `Buffer.byteLength`, no parser, no per-note/whole-vault scan), and
// are double-bounded already — by the serve-http body cap (`deriveHttpBodyCap` = max(4 MB,
// maxFileBytes×1.5) = 7.5 MB default, enforced streaming BEFORE the handler) and by the sink
// (`writeNote`/`appendNote` reject > maxFileBytes = 5 MB default). A boundary `.max(1_000_000)`
// (the auditor's proposed parity with `validate_note_proposal`, whose 1 MB cap exists because IT
// has a superlinear wikilink scan) would sit BELOW the real 5 MB write limit and REJECT legitimate
// large notes (long pastes / OCR dumps / merged logs) — a regression, not a fix. `frontmatter_set`
// is included below ONLY because its single-note YAML value is the rc.24 value-dimension sibling,
// not because all write-content must be capped.
//
// Inventory: always-registered tools whose free-string input flows into a parser/regex
// OR a superlinear per-note scan (tokenize / .toLowerCase() across the vault).
const PARSER_FED_TOOLS = [
  { tool: "obsidian_open_questions", field: "pattern", cap: "MAX_QUESTION_PATTERN_LEN" },
  { tool: "obsidian_dataview_query", field: "query", cap: "MAX_DQL_QUERY_LEN" },
  // v3.11.0-rc.11 (rc.9-audit L1) — free-form query / tag args that feed a per-note
  // tokenize+score scan; capped to MAX_QUERY_LEN / MAX_TAG_ARG_LEN (defense-in-depth
  // above the HTTP body cap). A future query-fed tool added without a cap fails here.
  { tool: "obsidian_search", field: "query", cap: "MAX_QUERY_LEN" },
  { tool: "obsidian_context_pack", field: "query", cap: "MAX_QUERY_LEN" },
  { tool: "obsidian_paper_audit", field: "tag", cap: "MAX_TAG_ARG_LEN" },
  // v3.11.0-rc.13 (rc.12-audit AUD-04) — frontmatter KEY args feed a whole-vault scan
  // with a per-note `nfcLower(key)` fold, so an uncapped multi-MB key is a bearer-reachable
  // CPU-DoS amplifier (measured ~9.5s for a 4 MB key). Capped to MAX_FRONTMATTER_KEY_LEN.
  { tool: "obsidian_frontmatter_search", field: "key", cap: "MAX_FRONTMATTER_KEY_LEN" },
  // v3.11.0-rc.21 (post-rc.20 re-sweep) — the VALUE predicates rc.13 left `z.unknown()`
  // (uncapped). The handler JSON.stringify's them and string-compares against EVERY note's
  // frontmatter across the whole vault → O(notes × valueLen) bearer-reachable DoS amplifier
  // (~3.9s for a 4 MB `contains` over a 2k-note vault). Capped via a `.refine()` length
  // bound (the value is arbitrary JSON, not a string, so `.max()` doesn't apply).
  { tool: "obsidian_frontmatter_search", field: "equals", cap: "MAX_FRONTMATTER_VALUE_LEN" },
  { tool: "obsidian_frontmatter_search", field: "contains", cap: "MAX_FRONTMATTER_VALUE_LEN" },
  { tool: "obsidian_frontmatter_get", field: "key", cap: "MAX_FRONTMATTER_KEY_LEN" },
  // v3.11.0-rc.16 — hyde_search was the ONE remaining always-on bearer-reachable
  // free-form query tool the rc.11 L1 cap sweep missed; `hypothetical_answer` is the
  // string that gets embedded (CPU), `query` is echoed/fallback-embedded. Both capped
  // to MAX_QUERY_LEN (defense-in-depth above the HTTP body cap).
  { tool: "obsidian_hyde_search", field: "query", cap: "MAX_QUERY_LEN" },
  { tool: "obsidian_hyde_search", field: "hypothetical_answer", cap: "MAX_QUERY_LEN" },
  // v3.11.0-rc.18 (rc.17 external audit, Codex RESOURCE-DOS-tool-registry-fts-query-cap) —
  // the opt-in FTS5 diagnostic tool (--persistent-index --diagnostic-search-tools) registered
  // `query` uncapped; a 4096-byte repeated-token query stalled SQLite FTS5 `MATCH` ~33s. This
  // inventory previously omitted it (curated around always-on parser-fed tools). Now pinned —
  // a future opt-in remote tool added without a `query` cap fails CI here.
  { tool: "obsidian_full_text_search", field: "query", cap: "MAX_QUERY_LEN" },
  // v3.11.0-rc.24 (external rc.21 audit, Cursor LOW-2/LOW-3) — the VALUE-dimension siblings of
  // the rc.21 frontmatter_search cap the inventory missed: filter_frontmatter on obsidian_search
  // (bounded by the fused candidate pool, defense-in-depth) + the write-gated frontmatter_set
  // value predicates (single-note YAML materialization). Both capped via the value-length form
  // (filter: `.max` on the string arms; set: a `.refine()`), recognized by the generalized detector.
  { tool: "obsidian_search", field: "filter_frontmatter", cap: "MAX_FRONTMATTER_VALUE_LEN" },
  { tool: "obsidian_frontmatter_set", field: "set", cap: "MAX_FRONTMATTER_VALUE_LEN" }
];

/**
 * Pure detector — returns the `server.registerTool(...)` block for `tool` from the
 * tool-registry source (from its name literal to the next registerTool call or EOF), or
 * null if absent. Standalone so the NEGATIVE control proves it isn't vacuous.
 */
function registerBlock(source: string, tool: string): string | null {
  const nameIdx = source.indexOf(`"${tool}"`);
  if (nameIdx < 0) return null;
  const next = source.indexOf("server.registerTool(", nameIdx + 1);
  return source.slice(nameIdx, next < 0 ? undefined : next);
}

/**
 * Pure detector — slice out `field`'s OWN schema chain from a registerTool block:
 * from its `name:` declaration (word-boundary so `set` ≠ `offset`) up to the NEXT
 * sibling field declaration (`name: z` — the `z` NAMESPACE TOKEN at a line/comma
 * boundary, `\b`-bounded so it matches z's chain starting either on the SAME line
 * (`field: z.string()`) or on the NEXT line (`field: z\n  .string()`)) or block end.
 * v3.11.4-rc.2 (full-audit PARSERCAP-FIELD-1) — the cap must live in THIS field's
 * chain; the prior block-wide token test let a per-field cap drop on a multi-field
 * tool (e.g. frontmatter_search `equals` losing its `.refine()` while `contains`
 * keeps the same `MAX_FRONTMATTER_VALUE_LEN`) slip past undetected.
 * v3.11.4-rc.3 (pre-promotion re-sweep) — the FIRST version of this fix required
 * `z.` (dot immediately after z), so it only recognized the single-line
 * `field: z.string()` shape and silently bled through every multi-line
 * `field: z\n  .string()` chain (58 of 160 fields in tool-registry.ts, incl.
 * obsidian_hyde_search's `query`) into the NEXT field's slice — reproduced by
 * removing a real `.max()` cap and watching the detector still pass because it
 * found the SIBLING's cap. `z\b` (word-boundary, not a literal dot) closes both shapes.
 */
function fieldSlice(block: string, field: string): string {
  const decl = new RegExp(`(?:^|[^\\w$])${field}\\s*:`).exec(block);
  if (!decl) return "";
  const rest = block.slice(decl.index + decl[0].length);
  const sib = rest.search(/[\n,]\s*[a-zA-Z_$][\w$]*\s*:\s*z\b/);
  return sib < 0 ? rest : rest.slice(0, sib);
}

/**
 * Pure detector — is the field present AND bounded by the length cap `cap`?
 * Accepts EITHER a `.max(<cap>)` (string fields) OR a `.refine(... <cap> ...)`
 * (v3.11.0-rc.21 — the frontmatter value predicates are arbitrary JSON, so they
 * are capped by a stringified-length `.refine()`, not `.max()`). The cap token
 * must appear within THIS field's own schema slice, not anywhere in the block.
 */
function fieldHasCap(block: string, field: string, cap: string): boolean {
  const slice = fieldSlice(block, field);
  return slice !== "" && new RegExp(`\\b${cap}\\b`).test(slice);
}

describe("parser-input length-cap invariant (rc.57)", () => {
  it("every parser-fed tool input carries a .max() cap in its registered schema (POSITIVE)", () => {
    const offenders = PARSER_FED_TOOLS.filter((t) => {
      const block = registerBlock(registry, t.tool);
      return !block || !fieldHasCap(block, t.field, t.cap);
    }).map((t) => `${t.tool}.${t.field} missing cap ${t.cap}`);
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("the detector flags a missing cap and accepts both .max() and .refine() forms (NEGATIVE control — not vacuous)", () => {
    const capped = 'query: z.string().min(1).max(MAX_DQL_QUERY_LEN).describe("x")';
    const uncapped = 'query: z.string().min(1).describe("x")';
    expect(fieldHasCap(capped, "query", "MAX_DQL_QUERY_LEN")).toBe(true);
    expect(fieldHasCap(uncapped, "query", "MAX_DQL_QUERY_LEN")).toBe(false);
    // a wrong-cap reference must also be rejected
    expect(fieldHasCap("query: z.string().max(SOME_OTHER)", "query", "MAX_DQL_QUERY_LEN")).toBe(false);
    // rc.21 — the .refine()-based value-predicate cap is accepted, and an unbounded
    // z.unknown() predicate is rejected (the precise regression this entry guards).
    const refined =
      "equals: z.unknown().optional().refine((v) => JSON.stringify(v).length <= MAX_FRONTMATTER_VALUE_LEN)";
    expect(fieldHasCap(refined, "equals", "MAX_FRONTMATTER_VALUE_LEN")).toBe(true);
    expect(fieldHasCap("equals: z.unknown().optional()", "equals", "MAX_FRONTMATTER_VALUE_LEN")).toBe(false);
    // v3.11.4-rc.2 (PARSERCAP-FIELD-1) — PER-FIELD binding: in a two-field block where `equals`
    // LOST its cap but the sibling `contains` still references the SAME constant, the detector must
    // flag `equals` (the prior block-wide token search returned a FALSE NEGATIVE on exactly this).
    const twoField =
      "equals: z.unknown().optional(),\n    contains: z.unknown().optional().refine((v) => JSON.stringify(v).length <= MAX_FRONTMATTER_VALUE_LEN)";
    expect(fieldHasCap(twoField, "equals", "MAX_FRONTMATTER_VALUE_LEN")).toBe(false); // uncapped → flagged
    expect(fieldHasCap(twoField, "contains", "MAX_FRONTMATTER_VALUE_LEN")).toBe(true); // its sibling is capped
    // word-boundary: `set` must not match `offset:`
    expect(fieldHasCap("offset: z.number().max(MAX_X)", "set", "MAX_X")).toBe(false);
    // v3.11.4-rc.3 (pre-promotion re-sweep on rc.2's OWN fix) — the MULTI-LINE chain shape
    // (`field: z\n  .string()...`, tool-registry.ts's DOMINANT convention, 58 of 160 fields)
    // is the exact shape the rc.2 fix's `z.` sibling-boundary MISSED: it bled `query`'s slice
    // through into `hypothetical_answer`'s cap, so an UNCAPPED `query` (a real, reproduced
    // regression on obsidian_hyde_search) still passed. This mirrors the real HyDE shape 1:1.
    const multiLineTwoField =
      'query: z\n    .string()\n    .min(1)\n    .describe("x"),\n  hypothetical_answer: z\n    .string()\n    .min(1)\n    .max(MAX_QUERY_LEN)\n    .describe("y")';
    expect(fieldHasCap(multiLineTwoField, "query", "MAX_QUERY_LEN")).toBe(false); // uncapped → flagged
    expect(fieldHasCap(multiLineTwoField, "hypothetical_answer", "MAX_QUERY_LEN")).toBe(true); // its sibling is capped
  });

  it("registerBlock locates a real tool block and returns null for an absent tool (control)", () => {
    expect(registerBlock(registry, "obsidian_dataview_query")).toContain("dataviewQuery");
    expect(registerBlock(registry, "obsidian_does_not_exist_tool")).toBeNull();
  });
});
