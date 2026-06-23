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
  { tool: "obsidian_paper_audit", field: "tag", cap: "MAX_TAG_ARG_LEN" }
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

/** Pure detector — does the block cap the field with `.max(<cap>)`? */
function fieldHasMaxCap(block: string, field: string, cap: string): boolean {
  // The field's schema chain and the `.max(cap)` must both be present in the block.
  return block.includes(`${field}:`) && new RegExp(`\\.max\\(\\s*${cap}\\b`).test(block);
}

describe("parser-input length-cap invariant (rc.57)", () => {
  it("every parser-fed tool input carries a .max() cap in its registered schema (POSITIVE)", () => {
    const offenders = PARSER_FED_TOOLS.filter((t) => {
      const block = registerBlock(registry, t.tool);
      return !block || !fieldHasMaxCap(block, t.field, t.cap);
    }).map((t) => `${t.tool}.${t.field} missing .max(${t.cap})`);
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("the detector flags a missing cap and accepts a present one (NEGATIVE control — not vacuous)", () => {
    const capped = 'query: z.string().min(1).max(MAX_DQL_QUERY_LEN).describe("x")';
    const uncapped = 'query: z.string().min(1).describe("x")';
    expect(fieldHasMaxCap(capped, "query", "MAX_DQL_QUERY_LEN")).toBe(true);
    expect(fieldHasMaxCap(uncapped, "query", "MAX_DQL_QUERY_LEN")).toBe(false);
    // a wrong-cap reference must also be rejected
    expect(fieldHasMaxCap("query: z.string().max(SOME_OTHER)", "query", "MAX_DQL_QUERY_LEN")).toBe(false);
  });

  it("registerBlock locates a real tool block and returns null for an absent tool (control)", () => {
    expect(registerBlock(registry, "obsidian_dataview_query")).toContain("dataviewQuery");
    expect(registerBlock(registry, "obsidian_does_not_exist_tool")).toBeNull();
  });
});
