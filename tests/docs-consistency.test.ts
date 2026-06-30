import { promises as fs } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { TOOL_MANIFEST } from "../src/tool-manifest.js";

// Static-analysis tests: every MCP surface declared in src/tool-manifest.ts
// (single source of truth as of v3.6.0-rc.2) must be documented in
// README.md, and every tool/prompt name mentioned in README.md must be a
// real registered surface. Catches doc drift that a real audit previously
// found (e.g. README listing `summarize_recent` instead of the actual
// `summarize_recent_edits`, or a `review_tag` row missing entirely).
//
// Pre-v3.6.0-rc.2 this file regex-parsed `src/index.ts` for `registerTool(`
// patterns. After the v3.6.0-rc.2 monolith split, registration moved to
// `src/tool-registry.ts` and prompts moved to `src/prompts.ts`. Rather
// than chase the regex paths, we pivoted the **tool**-side checks onto
// `TOOL_MANIFEST` (machine-readable, type-safe). The **prompt**-side
// checks still parse `src/prompts.ts` directly via `registeredNames`.

const repoRoot = path.resolve(__dirname, "..");

async function read(rel: string): Promise<string> {
  return fs.readFile(path.join(repoRoot, rel), "utf8");
}

function registeredNames(src: string, fn: "registerTool" | "registerPrompt"): Set<string> {
  // Grab the first string-literal arg of every fn(...) call.
  const re = new RegExp(`${fn}\\(\\s*"([^"]+)"`, "g");
  return new Set([...src.matchAll(re)].map((m) => m[1] ?? ""));
}

/** Set of all registered tool names from the v3.6.0-rc.2 manifest. */
function manifestToolNames(): Set<string> {
  return new Set(TOOL_MANIFEST.map((t) => t.name));
}

function mentionedToolNames(readme: string): Set<string> {
  // README references tools as inline code: `obsidian_xxx`.
  return new Set([...readme.matchAll(/`(obsidian_[a-z_]+)`/g)].map((m) => m[1] ?? ""));
}

function mentionedPromptNames(readme: string): Set<string> {
  // README references prompts as inline code: `summarize_recent_edits`, etc.
  // We only treat a name as a "prompt mention" if it looks snake_case and
  // appears in the table cell that lists prompts (the `MCP prompts (...)` row).
  // Match the cell content between parens after `MCP prompts`.
  const cell = /MCP prompts\*\*\s*\(([^)]+)\)/.exec(readme);
  if (!cell) return new Set();
  return new Set([...cell[1].matchAll(/`([a-z_]+)`/g)].map((m) => m[1] ?? ""));
}

/**
 * v3.10.0-rc.48 — slice the `## MCP prompts` section of docs/api.md (up to the
 * next `## ` heading) so the prompts-table invariant pins the TABLE, not stray
 * prose mentions elsewhere in the doc.
 */
function apiMdPromptsSection(apiMd: string): string {
  const start = apiMd.indexOf("## MCP prompts");
  if (start < 0) return "";
  const rest = apiMd.slice(start + "## MCP prompts".length);
  const next = rest.indexOf("\n## ");
  return next < 0 ? rest : rest.slice(0, next);
}

/** Registered prompt names absent (as a `code-span`) from a docs section. */
function promptsMissingFrom(section: string, registered: Set<string>): string[] {
  return [...registered].filter((p) => !new RegExp(`\`${p}\``).test(section));
}

describe("docs/code consistency — README mirrors registered MCP surface", () => {
  it("every tool in TOOL_MANIFEST appears in README", async () => {
    const readme = await read("README.md");
    const registered = manifestToolNames();
    const mentioned = mentionedToolNames(readme);
    const missingFromReadme = [...registered].filter((t) => !mentioned.has(t));
    expect(missingFromReadme).toEqual([]);
  });

  it("every tool mentioned in README is actually registered (in TOOL_MANIFEST)", async () => {
    const readme = await read("README.md");
    const registered = manifestToolNames();
    const mentioned = mentionedToolNames(readme);
    const ghostTools = [...mentioned].filter((t) => !registered.has(t));
    expect(ghostTools).toEqual([]);
  });

  it("every registerPrompt() in src/prompts.ts appears in README's prompts cell", async () => {
    const promptsSrc = await read("src/prompts.ts");
    const readme = await read("README.md");
    const registered = registeredNames(promptsSrc, "registerPrompt");
    const mentioned = mentionedPromptNames(readme);
    const missingFromReadme = [...registered].filter((p) => !mentioned.has(p));
    expect(missingFromReadme).toEqual([]);
  });

  // v3.10.0-rc.48 — the RCA found docs/api.md's prompts TABLE stale at 10 of 19
  // (no invariant pinned it). This guards the api.md table against the registry.
  it("every registerPrompt() in src/prompts.ts appears in the docs/api.md prompts table", async () => {
    const promptsSrc = await read("src/prompts.ts");
    const apiMd = await read("docs/api.md");
    const registered = registeredNames(promptsSrc, "registerPrompt");
    const missing = promptsMissingFrom(apiMdPromptsSection(apiMd), registered);
    expect(missing, `Prompts missing from the docs/api.md prompts table: ${missing.join(", ")}`).toEqual([]);
  });

  it("NEGATIVE: a registered prompt absent from the api.md prompts section is flagged", () => {
    // A section listing only one of two registered prompts → the other is flagged.
    const section = "| `summarize_recent_edits` | `since_minutes?` | … |";
    const missing = promptsMissingFrom(section, new Set(["summarize_recent_edits", "vault_research"]));
    expect(missing).toEqual(["vault_research"]);
  });

  // v2.0.0-beta.2 architecture invariant: extend docs-consistency to catch
  // numeric drift between README/CHANGELOG/api.md claims and actual code.
  // Pre-fix, the audit found "364+ tests" in README while CHANGELOG said
  // 393, "22 read tools" in README while smoke expected 24, "~3500 lines"
  // while real source was 7526 lines. Each was a manual-update miss.

  it("README tool-count claim matches actual registered count", async () => {
    const readme = await read("README.md");
    // v3.6.0-rc.2: derive always-on-read count from TOOL_MANIFEST instead
    // of regex-parsing source code. kind="read" === always-on; the other
    // three kinds (fts, diagnostic, write) are opt-in via various flags.
    const alwaysOnRead = TOOL_MANIFEST.filter((t) => t.kind === "read");
    // Look for a heading or sentence claiming an always-on read tool count.
    // Accept "<N> read tools (always on)" (legacy phrasing) or "<N> always-on
    // read tools" (current heading-style phrasing in v2.0.0+ README).
    const m = /(\d+) read tools \(always on\)|(\d+) always-on read tools/.exec(readme);
    expect(m, "README must declare a number of always-on read tools").not.toBeNull();
    const claimed = Number.parseInt(m?.[1] ?? m?.[2] ?? "0", 10);
    expect(claimed).toBe(alwaysOnRead.length);
  });

  it("docs/api.md tool-count math is consistent (always-on + opt-in + write = total)", async () => {
    const apiMd = await read("docs/api.md");
    // Match: "30 MCP tools (24 always-on read + 1 opt-in read via --persistent-index + 5 opt-in write via --enable-write)"
    // v3.11.0 — the optional `+ N opt-in feedback` term covers obsidian_mark_useful
    // (kind "feedback", gated by --feedback-weight). Summed into the total too.
    const m =
      /(\d+) MCP tools \((\d+) always-on read \+ (\d+) opt-in read[^+]*\+ (\d+) opt-in write(?:[^+]*\+ (\d+) opt-in feedback)?/.exec(
        apiMd
      );
    expect(m, "docs/api.md must declare tool counts in the standard format").not.toBeNull();
    if (!m) return;
    const [, total, always, fts, write, feedback] = m;
    expect(Number.parseInt(total ?? "0", 10)).toBe(
      Number.parseInt(always ?? "0", 10) +
        Number.parseInt(fts ?? "0", 10) +
        Number.parseInt(write ?? "0", 10) +
        Number.parseInt(feedback ?? "0", 10)
    );
  });

  it("CLI subcommands documented in docs/api.md match those registered in src/cli.ts", async () => {
    // v3.6.0-rc.2: `main()` and `program.command()` calls moved from
    // src/index.ts to src/cli.ts as part of the monolith split.
    const cliSrc = await read("src/cli.ts");
    const apiMd = await read("docs/api.md");
    // Subcommands registered as `program.command("name")`.
    const registered = new Set([...cliSrc.matchAll(/program\s*\n?\s*\.command\(\s*"([^"]+)"/g)].map((m) => m[1] ?? ""));
    // Subcommands documented as backtick-wrapped first column entries in the
    // Subcommands table in api.md. Match `<name>` plus optional `(...)` suffix
    // (e.g. `(default)`, `(v2.0 beta)`).
    const documented = new Set(
      [...apiMd.matchAll(/^\| `([a-z][a-z0-9-]*)`(?:\s*\([^)]+\))?\s*\|/gm)].map((m) => m[1] ?? "")
    );
    const missingFromDocs = [...registered].filter((s) => !documented.has(s));
    expect(missingFromDocs, "subcommands missing from docs/api.md").toEqual([]);
  });
});

// v3.5.1 — guard against the recurring drift the audit identified: README
// says "44 tools / 656 tests" in one place, "606 tests" in another, "39
// tools" in a third. Extend the existing per-tool/prompt mention check
// with number-level invariants. Pull the source of truth from package.json
// (description) + actual src counts, fail loudly on drift.
describe("docs/code consistency — numeric claims (v3.5.1 audit-driven)", () => {
  async function getActualCounts(): Promise<{
    allTools: number;
    alwaysOn: number;
    ftsOptIn: number;
    diagnostic: number;
    writes: number;
    prompts: number;
  }> {
    // v3.6.0-rc.2: tools come from TOOL_MANIFEST (single source of truth).
    // Prompts still parsed from src/prompts.ts via registeredNames since
    // there's no PROMPT_MANIFEST yet — possible v3.6.0-rc.3 follow-up.
    const allTools = TOOL_MANIFEST.length;
    const alwaysOn = TOOL_MANIFEST.filter((t) => t.kind === "read").length;
    const ftsOptIn = TOOL_MANIFEST.filter((t) => t.kind === "fts").length;
    const diagnostic = TOOL_MANIFEST.filter((t) => t.kind === "diagnostic").length;
    const writes = TOOL_MANIFEST.filter((t) => t.kind === "write").length;
    const promptsSrc = await read("src/prompts.ts");
    const prompts = registeredNames(promptsSrc, "registerPrompt").size;
    return { allTools, alwaysOn, ftsOptIn, diagnostic, writes, prompts };
  }

  it("README total-tool-count badge matches actual registered tool count", async () => {
    const readme = await read("README.md");
    const counts = await getActualCounts();
    // Match e.g. "44 tools · 19 MCP prompts · 656 unit tests"
    const m = /\*\*(\d+) tools?\b/.exec(readme);
    expect(m, "README must declare a total tool count in **N tools** form near the top").not.toBeNull();
    const claimed = Number.parseInt(m?.[1] ?? "0", 10);
    expect(claimed).toBe(counts.allTools);
    // v3.10.0-rc.28 — also pin the "**N production tools**" phrasing (comparison
    // table). A stale "44 production tools" slipped the regex above (the number
    // wasn't directly followed by " tools") and even contradicted its own
    // 34+4+7=45 breakdown until rc.28. Inline guard against the live count, same
    // shape as the `**N tools**` and `+ N gated writes` checks in this test.
    // v3.10.0-rc.32 (audit LOW) — presence-assert so the guard isn't
    // vacuous-on-deletion (catches both a stale number AND the row vanishing).
    const productionToolMatches = [...readme.matchAll(/(\d+)\s+production tools\b/g)];
    expect(productionToolMatches.length, 'README must keep the "N production tools" comparison row').toBeGreaterThan(0);
    for (const pm of productionToolMatches) {
      expect(
        Number.parseInt(pm[1] ?? "0", 10),
        `README "N production tools" must equal the registered tool count (${counts.allTools})`
      ).toBe(counts.allTools);
    }
  });

  it("README write-tool-count claim matches actual write count", async () => {
    const readme = await read("README.md");
    const counts = await getActualCounts();
    // Find the pattern "+ N gated writes" anywhere in README.
    const m = /\+\s+(\d+)\s+gated writes/.exec(readme);
    expect(m, "README must declare write count in '+ N gated writes' form").not.toBeNull();
    expect(Number.parseInt(m?.[1] ?? "0", 10)).toBe(counts.writes);
  });

  it("README prompt-count claim matches actual prompt count (where claimed)", async () => {
    const readme = await read("README.md");
    const counts = await getActualCounts();
    // The first occurrence of "N **MCP prompts**" — that's the canonical claim.
    const m = /\b(\d+) \*\*MCP prompts\*\*/.exec(readme);
    if (m) expect(Number.parseInt(m[1] ?? "0", 10)).toBe(counts.prompts);
  });

  it("STABILITY.md tool-count header matches actual registered tool count", async () => {
    const stability = await read("STABILITY.md");
    const counts = await getActualCounts();
    // Match e.g. "### MCP tool names (44 tools)"
    const m = /MCP tool names \((\d+) tools?\)/.exec(stability);
    expect(m, "STABILITY.md must declare tool count in '### MCP tool names (N tools)' form").not.toBeNull();
    expect(Number.parseInt(m?.[1] ?? "0", 10)).toBe(counts.allTools);
  });

  it("STABILITY.md MCP prompts header matches actual prompt count", async () => {
    const stability = await read("STABILITY.md");
    const counts = await getActualCounts();
    // Match e.g. "### MCP prompts (19)"
    const m = /### MCP prompts \((\d+)\)/.exec(stability);
    expect(m, "STABILITY.md must declare prompts count in '### MCP prompts (N)' form").not.toBeNull();
    expect(Number.parseInt(m?.[1] ?? "0", 10)).toBe(counts.prompts);
  });

  // v3.9.0-rc.22 (full-audit batch 2) — α-class structural guard. The reranker
  // default alias drifted in STABILITY.md ("rerank-multilingual") vs the code
  // default ("rerank-bge") — the SAME drift fixed in rc.15 (TSDoc) + rc.16 (CLI
  // help). Pin STABILITY's "Default models" bullet to the code constant so this
  // 3rd-instance class can't recur on a packaged semver-contract doc.
  it("STABILITY.md reranker-default alias matches DEFAULT_RERANKER_ALIAS (rc.22 α-guard)", async () => {
    const stability = await read("STABILITY.md");
    const embeddings = await read("src/embeddings.ts");
    const cm = /DEFAULT_RERANKER_ALIAS\s*=\s*"([^"]+)"/.exec(embeddings);
    expect(cm, "src/embeddings.ts must define DEFAULT_RERANKER_ALIAS").not.toBeNull();
    const actual = cm?.[1] ?? "";
    const bullet = /\*\*Default models\.\*\*[^\n]*/.exec(stability)?.[0] ?? "";
    expect(bullet, "STABILITY.md must have a '**Default models.**' bullet").not.toBe("");
    expect(bullet, `Default-models bullet must name the actual reranker default '${actual}'`).toContain(actual);
    expect(
      bullet.includes("rerank-multilingual"),
      "Default-models bullet must NOT present rerank-multilingual as the default (α-class drift — see rc.15/16/22)"
    ).toBe(false);
  });

  // v3.10.0-rc.77 (full state-driven audit, LOW) — STABILITY.md (the packaged semver-contract
  // doc) attributed obsidian_full_text_search to `--persistent-index` ALONE, but server.ts:691
  // registers it under BOTH `--persistent-index` AND `--diagnostic-search-tools` (TOOL_MANIFEST
  // gating = "--persistent-index + --diagnostic-search-tools"). The existing STABILITY guards pin
  // the tool/prompt COUNTS but nothing pinned the per-flag GATING breakdown prose, so the drift
  // (live since v3.5.1) was never caught. Pure helper so a synthetic NEGATIVE control can prove
  // the detector isn't vacuous (rc.15 pattern).
  function stabilityGatingMismatches(
    stabilityText: string,
    manifest: ReadonlyArray<{ name: string; gating: string }>
  ): string[] {
    // Parse "**Read|Write — opt-in via|gated by <flags> (N):** `t1`, `t2`…" breakdown lines.
    const lineRe = /\*\*(?:Read|Write|Feedback) — (?:opt-in via|gated by) (.+?) \(\d+\):\*\*\s*(.+)/g;
    const named = new Map<string, string>(); // tool -> sorted flag-set as listed in STABILITY
    for (const m of stabilityText.matchAll(lineRe)) {
      const flags = [...(m[1] ?? "").matchAll(/`(--[\w-]+)`/g)].map((f) => f[1] as string).sort();
      const tools = [...(m[2] ?? "").matchAll(/`(obsidian_[a-z_]+)`/g)].map((t) => t[1] as string);
      for (const t of tools) named.set(t, flags.join(", "));
    }
    const out: string[] = [];
    for (const entry of manifest) {
      if (entry.gating === "always") continue;
      const expected = [...entry.gating.matchAll(/--[\w-]+/g)]
        .map((f) => f[0])
        .sort()
        .join(", ");
      const got = named.get(entry.name);
      if (got === undefined) {
        out.push(`${entry.name}: not listed under any opt-in/gated breakdown heading`);
      } else if (got !== expected) {
        out.push(`${entry.name}: STABILITY names [${got}] but TOOL_MANIFEST gating is [${expected}]`);
      }
    }
    return out;
  }

  it("STABILITY.md per-flag gating breakdown matches TOOL_MANIFEST gating (rc.77 full-audit α-guard)", async () => {
    const stability = await read("STABILITY.md");
    const mismatches = stabilityGatingMismatches(stability, TOOL_MANIFEST);
    expect(
      mismatches,
      `STABILITY.md opt-in/gated breakdown must match TOOL_MANIFEST gating:\n${mismatches.join("\n")}`
    ).toEqual([]);
  });

  it("stabilityGatingMismatches catches a wrong gating breakdown (NEGATIVE control)", () => {
    const fts = [{ name: "obsidian_full_text_search", gating: "--persistent-index + --diagnostic-search-tools" }];
    // The exact rc.77 drift — full_text_search listed under --persistent-index ALONE — must be caught.
    const wrong = "**Read — opt-in via `--persistent-index` (1):** `obsidian_full_text_search`.";
    const caught = stabilityGatingMismatches(wrong, fts);
    expect(caught).toHaveLength(1);
    expect(caught[0]).toContain("obsidian_full_text_search");
    // …and the corrected breakdown is accepted (POSITIVE control on the pure fn).
    const right =
      "**Read — opt-in via `--persistent-index` + `--diagnostic-search-tools` (1):** `obsidian_full_text_search`.";
    expect(stabilityGatingMismatches(right, fts)).toEqual([]);
  });

  // v3.9.0-rc.22 (full-audit batch 2) — OIA-check-count drift guard. ROADMAP.md
  // said "8 OIA checks" while the canonical count had reached 10 (Check 9 rc.14,
  // Check 10 rc.20). Pin every surface that states the count to oia-walk.mjs's
  // self-declared canonical number, so adding a check forces a docs sync.
  it("OIA check count is consistent across oia-walk.mjs, AGENTS.md, ROADMAP.md (rc.22)", async () => {
    const oia = await read("scripts/oia-walk.mjs");
    const canon = /canonical count is "(\d+)"/.exec(oia);
    expect(canon, 'scripts/oia-walk.mjs must declare `canonical count is "N"`').not.toBeNull();
    const n = Number.parseInt(canon?.[1] ?? "0", 10);
    expect(n, "canonical OIA count should be ≥ 10 as of rc.20").toBeGreaterThanOrEqual(10);
    const agents = await read("AGENTS.md");
    const agentsCounts = [...agents.matchAll(/drift scan[^\n]*?(\d+)\s+checks/g)].map((mm) =>
      Number.parseInt(mm[1] ?? "0", 10)
    );
    expect(agentsCounts.length, "AGENTS.md must state the OIA check count").toBeGreaterThan(0);
    for (const c of agentsCounts) expect(c, "AGENTS.md OIA count must match oia-walk canonical").toBe(n);
    const roadmap = await read("ROADMAP.md");
    const rm = /(\d+)\s+state-driven OIA drift checks/.exec(roadmap);
    expect(rm, "ROADMAP.md must state the OIA check count").not.toBeNull();
    expect(Number.parseInt(rm?.[1] ?? "0", 10), "ROADMAP.md OIA count must match oia-walk canonical").toBe(n);
  });

  it("package.json description tool-count matches actual count", async () => {
    const pkgRaw = await read("package.json");
    const pkg = JSON.parse(pkgRaw) as { description?: string };
    const counts = await getActualCounts();
    const desc = pkg.description ?? "";
    const m = /(\d+) tools/.exec(desc);
    expect(m, "package.json description must include 'N tools'").not.toBeNull();
    expect(Number.parseInt(m?.[1] ?? "0", 10)).toBe(counts.allTools);
  });

  it("package.json description prompt-count matches actual count", async () => {
    const pkgRaw = await read("package.json");
    const pkg = JSON.parse(pkgRaw) as { description?: string };
    const counts = await getActualCounts();
    const desc = pkg.description ?? "";
    const m = /(\d+) MCP prompts/.exec(desc);
    expect(m, "package.json description must include 'N MCP prompts'").not.toBeNull();
    expect(Number.parseInt(m?.[1] ?? "0", 10)).toBe(counts.prompts);
  });

  // v3.5.9 — number-word lookup for human-readable counts in CLI help / docs prose.
  // Restricted to 0-10 since tool counts won't realistically reach 11 without a
  // major surface redesign that would touch the help text anyway.
  const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

  it("CLI --enable-write help text mentions seven (not five) write tools", async () => {
    // The audit found the help text said "five write tools" while reality is 7.
    // Pin it to the actual count so adding/removing writes forces a help-text update.
    //
    // v3.5.12 — help strings live in src/cli-help.ts (shared between `serve`
    // and `serve-http`) per audit #4 LOW finding 3.1. Read from there.
    const cliHelpSrc = await read("src/cli-help.ts");
    const counts = await getActualCounts();
    const expectedWord = NUMBER_WORDS[counts.writes];
    expect(expectedWord, `write count ${counts.writes} outside 0-10 NUMBER_WORDS range`).toBeDefined();
    const helpMatch = /Enable the (\w+) write tools/.exec(cliHelpSrc);
    expect(
      helpMatch,
      "ENABLE_WRITE_HELP in src/cli-help.ts must follow 'Enable the <count-word> write tools' format"
    ).not.toBeNull();
    expect(helpMatch?.[1]).toBe(expectedWord);
  });

  // v3.5.12 audit #4 — section 3.1 caught that `serve` and `serve-http` had
  // different help strings for the SAME flag. Class fix: shared cli-help.ts
  // module. Invariant: every CLI flag accepted by BOTH subcommands must
  // reference the shared constant, not an inline string. Catches drift on
  // any newly-shared flag the next time someone forgets.
  it("flags accepted by both serve and serve-http must source help from src/cli-help.ts", async () => {
    // v3.6.0-rc.2: commander program.command() calls moved from src/index.ts
    // to src/cli.ts during the monolith split.
    const cliSrc = await read("src/cli.ts");
    const serveStart = cliSrc.indexOf('.command("serve",');
    const serveHttpStart = cliSrc.indexOf('.command("serve-http"');
    expect(serveStart, "serve subcommand definition not found").toBeGreaterThan(0);
    expect(serveHttpStart, "serve-http subcommand definition not found").toBeGreaterThan(0);
    const serveBlock = cliSrc.slice(serveStart, serveHttpStart);
    const afterServeHttp = cliSrc.indexOf(".command(", serveHttpStart + 1);
    const serveHttpBlock = cliSrc.slice(serveHttpStart, afterServeHttp > 0 ? afterServeHttp : cliSrc.length);

    const flagRe = /\.option\(\s*"(--[a-z-]+)"/g;
    const serveFlags = new Set([...serveBlock.matchAll(flagRe)].map((m) => m[1] ?? ""));
    const serveHttpFlags = new Set([...serveHttpBlock.matchAll(flagRe)].map((m) => m[1] ?? ""));
    const sharedFlags = [...serveFlags].filter((f) => serveHttpFlags.has(f));

    // Map of flag → expected shared-help constant. Extend as more flags
    // get extracted to src/cli-help.ts.
    const expectedConstFor: Record<string, string> = {
      "--enable-write": "ENABLE_WRITE_HELP",
      "--diagnostic-search-tools": "DIAGNOSTIC_SEARCH_TOOLS_HELP",
      "--persistent-index": "PERSISTENT_INDEX_HELP"
    };

    for (const flag of sharedFlags) {
      const expectedConst = expectedConstFor[flag];
      if (!expectedConst) continue; // Not yet extracted — future work.
      // `flag` comes from /--[a-z-]+/ matches, so it can only contain `-` and
      // lowercase letters — none are regex metachars outside character classes.
      // No escaping needed; embed directly. (CodeQL js/incomplete-sanitization
      // dismissed in v3.5.12 PR #62 — the prior .replace(/-/g, "\\-") was a
      // useless escape that CodeQL correctly flagged as an incomplete pattern.)
      const flagOptRe = new RegExp(`\\.option\\(\\s*"${flag}"\\s*,\\s*([^)]+?)\\s*\\)`, "g");
      const serveCall = [...serveBlock.matchAll(flagOptRe)][0]?.[1] ?? "";
      const httpCall = [...serveHttpBlock.matchAll(flagOptRe)][0]?.[1] ?? "";
      expect(
        serveCall,
        `serve's ${flag} help should reference ${expectedConst} from cli-help.ts (saw: ${serveCall})`
      ).toContain(expectedConst);
      expect(
        httpCall,
        `serve-http's ${flag} help should reference ${expectedConst} from cli-help.ts (saw: ${httpCall})`
      ).toContain(expectedConst);
    }

    // cli-help.ts must export each constant we're depending on.
    const cliHelpSrc = await read("src/cli-help.ts");
    for (const c of Object.values(expectedConstFor)) {
      expect(cliHelpSrc, `cli-help.ts must export ${c}`).toMatch(new RegExp(`export const ${c}\\s*=`));
    }
  });

  // v3.5.9 — class fix from external audit #3. The v3.5.1 invariants caught
  // tool/prompt count drift in README + STABILITY.md, but the same drift
  // recurred in 6 OTHER surfaces (docs/api.md, social-preview.svg, badge URL,
  // package.json description, source-code comments). Below: extend the
  // invariants to those surfaces so the next audit doesn't find the same
  // class of bug a 4th time.

  // Helper: count `it(` across tests/**.test.ts as a proxy for actual test
  // count. Not perfect (nested `it` in fixtures would inflate) but our tests
  // don't have nested it() blocks, verified manually. Cheaper than spawning
  // `vitest list` and works without a glob dep — walk tests/ via fs.readdir.
  async function countActualTests(): Promise<number> {
    const fs = await import("node:fs/promises");
    const files: string[] = [];
    async function walk(dir: string) {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else if (e.name.endsWith(".test.ts")) files.push(full);
      }
    }
    await walk(path.join(repoRoot, "tests"));
    let count = 0;
    for (const f of files) {
      const body = await fs.readFile(f, "utf8");
      // Match `it("..."` or `it(\n  "...` — both common formatter shapes.
      const matches = [...body.matchAll(/^\s*it\s*[(]/gm)];
      count += matches.length;
    }
    return count;
  }

  it("README test-count claims match actual it() count across tests/*.test.ts", async () => {
    const readme = await read("README.md");
    const actual = await countActualTests();
    // Find every "N tests" / "N passing" / "N unit tests" mention in README.
    // All occurrences must agree with each other AND with the actual count.
    const allMentions = [
      ...readme.matchAll(/\b(\d+)\s+(?:passing|tests|unit tests)\b/g),
      ...readme.matchAll(/tests-(\d+)/g) // badge URL: tests-665%20passing
    ];
    expect(allMentions.length, "README must declare test count somewhere").toBeGreaterThan(0);
    for (const m of allMentions) {
      const claimed = Number.parseInt(m[1] ?? "0", 10);
      expect(claimed, `README mentions "${m[0]}" but actual test count is ${actual}`).toBe(actual);
    }
  });

  it("package.json description test count matches actual", async () => {
    const pkgRaw = await read("package.json");
    const pkg = JSON.parse(pkgRaw) as { description?: string };
    const actual = await countActualTests();
    const m = /(\d+)\s+tests/.exec(pkg.description ?? "");
    if (m) {
      // Test count in package.json description is optional, but if present,
      // it must match.
      expect(Number.parseInt(m[1] ?? "0", 10)).toBe(actual);
    }
  });

  it("social-preview.svg test count matches actual (when present)", async () => {
    const svg = await read("assets/social-preview.svg");
    const actual = await countActualTests();
    // The SVG shows e.g. `<text ...>665</text>` next to `tests`. Look for any
    // number-text near the word "tests".
    const near = /(\d+)<\/text>\s*[^<]*<text[^>]*>tests/.exec(svg);
    if (near) {
      expect(Number.parseInt(near[1] ?? "0", 10)).toBe(actual);
    }
  });

  // v3.9.0-rc.37 (audit F1) — ROADMAP.md carried a stale "Process maturity —
  // N tests" claim (1020, drifted from the canonical 1026/1038) that NO gate
  // caught: it was absent from the scope-completeness AUDIT_FILES and from the
  // docs-consistency surfaces. Both gaps are now closed (AUDIT_FILES + this
  // invariant). The 3-4-digit pattern pins the maturity TOTAL while ignoring
  // the "+15 tests" / "+7 tests" per-RC deltas in the changelog-style bullets.
  it("ROADMAP.md test-count claim matches actual it() count", async () => {
    const roadmap = await read("ROADMAP.md");
    const actual = await countActualTests();
    const totals = [...roadmap.matchAll(/\b(\d{3,4})\s+tests\b/g)];
    expect(totals.length, "ROADMAP must state the maturity test total").toBeGreaterThan(0);
    for (const m of totals) {
      expect(Number.parseInt(m[1] ?? "0", 10), `ROADMAP "${m[0]}" must equal actual ${actual}`).toBe(actual);
    }
  });

  // v3.10.0-rc.21 (audit M2) — ROADMAP.md was the ONE tool-count surface NOT
  // covered by the README/STABILITY/COMPARISON/api.md/llms.txt total-tool-count
  // pins above, so its "44 tool descriptions" (the TDQS item) silently drifted
  // while every guarded surface stayed at 45. Pin it too. Pure check + NEGATIVE
  // control (CLAUDE.md rule since v3.6.4).
  function checkRoadmapToolCount(roadmap: string, total: number): string | null {
    const m = /(\d+) tool descriptions/.exec(roadmap);
    if (!m) return "ROADMAP.md must state 'N tool descriptions' (the TDQS item) so the tool count stays pinned";
    const claimed = Number.parseInt(m[1] ?? "0", 10);
    return claimed === total ? null : `ROADMAP.md "${m[0]}" but TOOL_MANIFEST has ${total} tools`;
  }
  it("ROADMAP.md tool-count claim matches TOOL_MANIFEST (rc.21 M2)", async () => {
    const roadmap = await read("ROADMAP.md");
    expect(checkRoadmapToolCount(roadmap, TOOL_MANIFEST.length)).toBeNull();
  });
  it("NEGATIVE: checkRoadmapToolCount flags drift / missing claim (rc.21 M2)", () => {
    expect(checkRoadmapToolCount("TDQS pass on all 44 tool descriptions", 45)).not.toBeNull(); // drift
    expect(checkRoadmapToolCount("TDQS pass on all 45 tool descriptions", 45)).toBeNull(); // match
    expect(checkRoadmapToolCount("no tool-count mention here", 45)).not.toBeNull(); // require-present
  });

  // v3.7.4 — close the "Hardcoded counts in docs without an invariant"
  // anti-pattern gap (Rule since v3.5.9 per CLAUDE.md). Previously docs-
  // consistency gated tool count, prompt count, and test count, but the
  // `package.json#description` claim "5 cross-encoder reranker models" was
  // not enforced. If RERANKER_MODELS grows/shrinks, the npm description
  // would drift silently.
  // v3.7.11 (round-13 audit) — extend hardcoded-counts gate to
  // docs/COMPARISON.md, which had stale "670 tests" / "44 tools" /
  // "19 prompts" claims that the v3.7.4 gate scope didn't include.
  // Round-12 caught "670" → "786" drift; this invariant locks the
  // counts in COMPARISON.md against actual values going forward.
  it("docs/COMPARISON.md hardcoded tool/prompt counts match actual", async () => {
    const comparisonMd = await read("docs/COMPARISON.md");
    const counts = await getActualCounts();
    // Match standalone "N tools" / "M prompts" mentions in COMPARISON
    // (e.g. "44 tools + 19 prompts" appears in line 117). Skip if no
    // matches found — the file is allowed to not mention counts at all.
    const toolMatches = [...comparisonMd.matchAll(/(\d+)\s+tools\b/g)];
    for (const m of toolMatches) {
      const claimed = Number.parseInt(m[1] ?? "0", 10);
      expect(claimed, `COMPARISON.md mentions "${m[0]}" but actual tool count is ${counts.allTools}`).toBe(
        counts.allTools
      );
    }
    const promptMatches = [...comparisonMd.matchAll(/(\d+)\s+prompts\b/g)];
    for (const m of promptMatches) {
      const claimed = Number.parseInt(m[1] ?? "0", 10);
      expect(claimed, `COMPARISON.md mentions "${m[0]}" but actual prompt count is ${counts.prompts}`).toBe(
        counts.prompts
      );
    }
    // v3.10.0-rc.28 — also pin the "| Tool count | N |" comparison-table cell.
    // The "N tools" regex above can't see a bare table cell, so it stayed stale
    // at 44 (one behind the 45th tool, obsidian_stale_notes) until rc.28.
    // v3.10.0-rc.32 (audit LOW) — presence-assert (not vacuous-on-deletion).
    const cellMatch = /Tool count\s*\|\s*\**(\d+)\**/.exec(comparisonMd);
    expect(cellMatch, 'COMPARISON.md must keep the "| Tool count | N |" row').not.toBeNull();
    expect(
      Number.parseInt(cellMatch?.[1] ?? "0", 10),
      `COMPARISON.md "Tool count | N" must equal the registered tool count (${counts.allTools})`
    ).toBe(counts.allTools);
  });

  // v3.7.13 M12 — extend COMPARISON.md gate to test count. The audit round-15
  // caught "Test count (public) | **786** |" while README+package said 787;
  // the previous COMPARISON gate covered tools+prompts but missed test count.
  // Now any "**N**" cell in the same table row as the literal "Test count"
  // must equal the actual test declaration count.
  it("docs/COMPARISON.md test count matches actual", async () => {
    const comparisonMd = await read("docs/COMPARISON.md");
    const actualTests = await countActualTests();
    const m = /\|\s*Test count[^|]*\|\s*\*\*(\d+)\*\*/.exec(comparisonMd);
    if (!m) return; // Claim is optional; if absent, nothing to check.
    const claimed = Number.parseInt(m[1] ?? "0", 10);
    expect(
      claimed,
      `COMPARISON.md "Test count (public) | **${claimed}**" but actual test count is ${actualTests}`
    ).toBe(actualTests);
  });

  // v3.7.12 H4 — every TypeScript symbol STABILITY.md promises as stable
  // must have a matching `./<name>` entry in package.json#exports, otherwise
  // ESM consumers can only reach it via deep imports (which TypeScript
  // resolution flat-out refuses past Node16/NodeNext). Round-14 external
  // audit caught `TOOL_MANIFEST` advertised as stable but missing from
  // exports — fixed in v3.7.12 H4. This invariant locks the parity so a
  // future module added to STABILITY.md without a matching exports entry
  // fails CI rather than silently shipping unreachable.
  it("every STABILITY.md-promised module has a package.json#exports entry (H4)", async () => {
    const stability = await read("STABILITY.md");
    const pkgRaw = await read("package.json");
    const pkg = JSON.parse(pkgRaw) as { exports?: Record<string, unknown> };
    const exports = pkg.exports ?? {};

    // Pull every "src/<name>.ts" reference out of STABILITY.md and map to
    // the canonical "./<name>" export key. The pattern is the parenthetical
    // backticked source path next to each promised symbol bullet.
    const srcRe = /\(`src\/([a-z][a-z0-9-]*)\.ts`\)/gi;
    const promised = new Set<string>();
    for (const m of stability.matchAll(srcRe)) {
      const mod = m[1];
      if (!mod) continue;
      // `index` is the root entry `.` — covered by `"./index"` would be a
      // duplicate of `"."` in exports, so skip it here.
      if (mod === "index") continue;
      promised.add(mod);
    }
    expect(promised.size, "STABILITY.md must promise at least one optional module").toBeGreaterThan(0);

    for (const mod of promised) {
      const key = `./${mod}`;
      expect(
        exports[key],
        `STABILITY.md promises src/${mod}.ts as stable but package.json#exports is missing "${key}"`
      ).toBeDefined();
    }
  });

  // v3.7.15 R17-3 — lock COMPARISON.md's reranker-row positioning against
  // the same v3.7.12 L4 honest framing applied to package.json. Round-17
  // self-audit found "Cross-encoder reranker (BGE, 5 models)" in
  // COMPARISON.md (line 31) while v3.7.12 L4 had already updated
  // package.json#description from "5 cross-encoder reranker models" →
  // "BGE cross-encoder reranker verified end-to-end (+4 aliases in
  // catalog ...)". The COMPARISON.md row was missed in v3.7.12 + v3.7.13.
  //
  // The invariant: COMPARISON.md must NOT claim a flat "N models" reranker
  // count (matches the v3.7.12 L4 narrative class fix); IF it mentions a
  // verified entity, the entity must be BGE (matches DEFAULT_RERANKER_ALIAS).
  it("COMPARISON.md reranker row uses honest framing (v3.7.15 R17-3)", async () => {
    const comparisonMd = await read("docs/COMPARISON.md");
    // Find any "reranker (BGE, N models)" form — should be ZERO matches post-3.7.15.
    const flatCount = /reranker\s*\(BGE\s*,?\s*\d+\s*models?\)/i.exec(comparisonMd);
    expect(
      flatCount,
      "COMPARISON.md reranker row uses stale 'BGE, N models' framing — use the v3.7.12 L4 honest form 'BGE verified end-to-end' instead"
    ).toBeNull();
  });

  // v3.7.14 F4 — close the "Hardcoded counts in docs without an invariant"
  // anti-pattern (Rule since v3.5.9). v3.7.13 M5 bumped the README+CLAUDE.md
  // "N required CI gates" claim from 7 → 8 manually, but no test gated it
  // against the actual release-workflow REQUIRED regex. If a 9th gate gets
  // added to .github/workflows/release.yml later, the public claims will
  // drift again — same recurring class as v3.5.9.
  //
  // This invariant counts pipe-separated entries in the release.yml REQUIRED
  // regex (the canonical authoritative source: it's what actually blocks an
  // npm publish) and asserts every "**N required** ... CI gates" claim in
  // README + CLAUDE.md matches.
  it("'N required CI gates' claims match release.yml REQUIRED regex count", async () => {
    const releaseYml = await read(".github/workflows/release.yml");
    // Match the REQUIRED="lint|test \(22\)|...|docs" assignment. Count
    // pipe-delimited entries.
    const reqMatch = /REQUIRED="([^"]+)"/.exec(releaseYml);
    expect(reqMatch, 'release.yml must declare a REQUIRED="...|..." regex').not.toBeNull();
    if (!reqMatch) return;
    const required = reqMatch[1] ?? "";
    const actualCount = required.split("|").length;

    // Cross-check the REQ_COUNT variable in the same workflow agrees with the
    // regex (these are set independently and have drifted before — this is the
    // structural double-source-of-truth guard).
    const reqCountMatch = /REQ_COUNT=(\d+)/.exec(releaseYml);
    expect(reqCountMatch, "release.yml must declare REQ_COUNT=N").not.toBeNull();
    if (reqCountMatch) {
      const declaredCount = Number.parseInt(reqCountMatch[1] ?? "0", 10);
      expect(
        declaredCount,
        `release.yml REQ_COUNT=${declaredCount} but REQUIRED regex has ${actualCount} entries`
      ).toBe(actualCount);
    }

    // Now assert every "**N required**" claim in README + CLAUDE.md matches
    // the actual count. Pattern: bold-wrapped N + "required" + optional "branch-
    // protection" or no qualifier + "gates" / "CI gates".
    for (const file of ["README.md", "CLAUDE.md"]) {
      const body = await read(file);
      const claims = [...body.matchAll(/\*\*?(\d+)\*?\*?\s+required\b/g)];
      for (const m of claims) {
        const claimed = Number.parseInt(m[1] ?? "0", 10);
        expect(
          claimed,
          `${file}: "${m[0]}" claims ${claimed} required gates but release.yml REQUIRED has ${actualCount}`
        ).toBe(actualCount);
      }
    }
  });

  it("package.json description reranker-model count matches RERANKER_MODELS catalog", async () => {
    const pkgRaw = await read("package.json");
    const pkg = JSON.parse(pkgRaw) as { description?: string };
    const desc = pkg.description ?? "";

    // Import the catalog via the dist build so we read the same shape production code uses.
    const distEntry = path.join(repoRoot, "dist", "embeddings.js");
    try {
      await fs.access(distEntry);
    } catch {
      return; // dist not built — skip rather than fail (dev watch loop case).
    }
    const mod = (await import(distEntry)) as {
      RERANKER_MODELS?: Record<string, unknown>;
      DEFAULT_RERANKER_ALIAS?: string;
    };
    const total = Object.keys(mod.RERANKER_MODELS ?? {}).length;

    // Legacy form: "N cross-encoder reranker models" — kept for back-compat
    // in case the description swings back to a flat count claim later.
    const flatMatch = /(\d+)\s+cross-encoder\s+reranker\s+models/.exec(desc);
    if (flatMatch) {
      const claimed = Number.parseInt(flatMatch[1] ?? "0", 10);
      expect(
        claimed,
        `package.json says "${claimed} cross-encoder reranker models" but RERANKER_MODELS has ${total}`
      ).toBe(total);
      return;
    }

    // v3.7.12 L4 — the honest form: "BGE cross-encoder reranker verified
    // end-to-end (+N aliases in catalog, transformers.js bump pending)".
    // Enforce both pieces: the verified alias must be `rerank-bge` (the
    // DEFAULT_RERANKER_ALIAS) and N must equal `total - 1` (catalog minus
    // the one verified entry). If neither phrasing is present, the claim is
    // absent and there's nothing to check.
    const honestMatch = /\+(\d+)\s+aliases\s+in\s+catalog/.exec(desc);
    if (!honestMatch) return;
    const claimedRemaining = Number.parseInt(honestMatch[1] ?? "0", 10);
    expect(
      claimedRemaining,
      `package.json says "+${claimedRemaining} aliases in catalog" but RERANKER_MODELS has ${total} (expected +${total - 1} after the BGE verified entry)`
    ).toBe(total - 1);

    // The "verified end-to-end" claim must reference the actual default
    // alias (otherwise the description is honest about a different model
    // than what users get without `--reranker-model`).
    expect(
      desc.includes("BGE cross-encoder reranker verified end-to-end"),
      "package.json description must include 'BGE cross-encoder reranker verified end-to-end' when using the +N-aliases form"
    ).toBe(true);
    expect(
      mod.DEFAULT_RERANKER_ALIAS,
      "DEFAULT_RERANKER_ALIAS must be 'rerank-bge' to match the package.json 'BGE … verified end-to-end' claim"
    ).toBe("rerank-bge");
  });

  it("docs/api.md first-paragraph tool count matches actual registered count", async () => {
    const apiMd = await read("docs/api.md");
    const counts = await getActualCounts();
    // First paragraph mentions "N MCP tools (M always-on read + ...)".
    // Both N and M must match the actual counts.
    const m = /(\d+) MCP tools \((\d+) always-on read/.exec(apiMd);
    expect(m, "docs/api.md first paragraph must declare 'N MCP tools (M always-on read ...)'").not.toBeNull();
    if (m) {
      expect(Number.parseInt(m[1] ?? "0", 10)).toBe(counts.allTools);
      expect(Number.parseInt(m[2] ?? "0", 10)).toBe(counts.alwaysOn);
    }
  });

  it("docs/api.md write-tool count word matches actual", async () => {
    const apiMd = await read("docs/api.md");
    const counts = await getActualCounts();
    const expectedWord = NUMBER_WORDS[counts.writes];
    expect(expectedWord, `write count ${counts.writes} outside 0-10 NUMBER_WORDS range`).toBeDefined();
    // Find every "<word> write tools" mention; all must agree with the actual.
    const mentions = [...apiMd.matchAll(/\b(\w+) write tools?\b/g)];
    expect(mentions.length, "docs/api.md must mention write-tool count").toBeGreaterThan(0);
    for (const m of mentions) {
      const word = m[1] ?? "";
      // Allow either the count-word ("seven") or numeric/short forms not yet enforced.
      // We pin only against the word form here; the per-count enforcement
      // ensures we'd notice drift between count and word.
      if (NUMBER_WORDS.includes(word)) {
        expect(word, `docs/api.md says "${m[0]}" but actual write count is ${counts.writes}`).toBe(expectedWord);
      }
    }
  });

  // v3.6 — class fix on top of v3.5.9. The v3.5.9 invariants caught mention
  // drift (every registerTool name must appear *somewhere* in README/api.md),
  // and they pin the numeric totals. But the audit on docs/api.md found a
  // distinct failure mode: the tool COVERAGE table at the top of the file
  // was 14 rows short while the count claim still added up — registered
  // tools were silently absent from the canonical structured listing.
  // This invariant requires every registered tool to appear as a row in one
  // of the structured markdown tables in docs/api.md whose first column is
  // a backtick-wrapped `obsidian_*` name, anywhere in the file. Rows may be
  // split across multiple tables (e.g. read / write / opt-in sections).
  it("docs/api.md tool index table covers every registered tool", async () => {
    // v3.6.1 CRIT-3 fix — this test silently passed for the whole v3.6.0
    // sprint because it was reading `src/index.ts` for `registerTool(`
    // calls, but registration moved to `src/tool-registry.ts` in rc.2.
    // `registered` set was empty → `missingFromTable` always empty →
    // gate trivially passed regardless of api.md content. External
    // (anonymous) audit caught this. Class fix: read from TOOL_MANIFEST
    // (the rc.2-introduced single source of truth) — refactor-resistant
    // and type-safe. Same pivot we did for the README/STABILITY tool
    // count checks during rc.2.
    const apiMd = await read("docs/api.md");
    const registered = manifestToolNames();
    const tableRows = new Set([...apiMd.matchAll(/^\|\s*`(obsidian_[a-z_]+)`\s*\|/gm)].map((m) => m[1] ?? ""));
    const missingFromTable = [...registered].filter((t) => !tableRows.has(t)).sort();
    expect(missingFromTable, "tools in TOOL_MANIFEST but missing from a docs/api.md tool table").toEqual([]);
  });

  // v3.6.1 — meta-invariant: any docs-consistency test that uses
  // `registeredNames()` should have a non-empty set, otherwise the test
  // trivially passes (the CRIT-3 silent-pass class). This guards against
  // the SAME class of bug recurring in some other test in this file.
  it("meta: no registeredNames(src/index.ts) returns ∅ (anti-silent-pass guard)", async () => {
    const indexSrc = await read("src/index.ts");
    const toolsInIndex = registeredNames(indexSrc, "registerTool");
    const promptsInIndex = registeredNames(indexSrc, "registerPrompt");
    expect(
      toolsInIndex.size,
      "registerTool() should NOT be in src/index.ts (registration moved to tool-registry.ts in rc.2). If this fails, tool registration moved BACK to index.ts — investigate. If a NEW test reads tools from index.ts and gets 0, it's the CRIT-3 class silent-pass bug; pivot to TOOL_MANIFEST or src/tool-registry.ts."
    ).toBe(0);
    expect(
      promptsInIndex.size,
      "registerPrompt() should NOT be in src/index.ts (registration moved to prompts.ts in rc.2)."
    ).toBe(0);
  });
});

// v3.8.0-rc.14 M-2 — root-class fix for "new files introduce drift surface
// without invariant coverage". rc.12 added llms.txt + AGENTS.md (Tier A
// discoverability for AI agents). Both contain numeric/structural claims —
// "848 unit tests", "44 tools", "19 MCP prompts", "9 required CI gates",
// "10 per-file branch floors" — that are NOT covered by the existing
// docs-consistency invariants (those check README/STABILITY/COMPARISON/
// package.json/api.md). When tests grow to 850+, llms.txt and AGENTS.md
// would silently drift.
//
// Same class as M-1 (CLI help text drift between serve and serve-http
// before rc.11 lifted to cli-help.ts). Fix: extend invariants to cover
// every numeric claim in these new files.
//
// v3.8.0-rc.15 M-3 — meta-recursion fix. rc.14 added 7 invariants here but
// NONE had NEGATIVE control siblings, violating CLAUDE.md rule since v3.6.4.
// Refactored: each check is now a pure function returning `null` on OK or
// an error string on drift. Positive `it()` tests call against real files;
// NEGATIVE control `it()` tests call against intentionally-drifted inline
// fixtures and assert non-null. Pattern matches tests/peek-meta.test.ts +
// tests/k1-class-invariant.test.ts.

/** Pure check: llms.txt unit-test claim must match actual count.
 *  Returns null on OK, error string on drift / missing claim. */
function checkLlmsTestCount(llms: string, actual: number): string | null {
  const m = /(\d+)\s+unit tests/.exec(llms);
  if (!m) return "llms.txt must declare 'N unit tests'";
  const claimed = Number.parseInt(m[1] ?? "0", 10);
  if (claimed !== actual) return `llms.txt mentions "${m[0]}" but actual test count is ${actual}`;
  return null;
}

/** Pure check: llms.txt tool breakdown "N tools (A always-on read + B opt-in + C gated writes)". */
function checkLlmsToolBreakdown(
  llms: string,
  total: number,
  alwaysOn: number,
  optIn: number,
  writes: number
): string | null {
  // v3.11.0 — the optional `+ N feedback` term covers obsidian_mark_useful (kind
  // "feedback"); the total (group 1) already pins the full count, so the term is
  // matched-but-not-summed here (always-on/opt-in/writes stay the read+write split).
  const m =
    /(\d+)\s+tools\s*\((\d+)\s+always-on read\s*\+\s*(\d+)\s+opt-in\s*\+\s*(\d+)\s+gated writes(?:\s*\+\s*\d+\s+feedback)?\)/.exec(
      llms
    );
  if (!m) return "llms.txt must declare 'N tools (A always-on read + B opt-in + C gated writes)'";
  if (Number.parseInt(m[1] ?? "0", 10) !== total) return `llms.txt total ${m[1]} ≠ ${total}`;
  if (Number.parseInt(m[2] ?? "0", 10) !== alwaysOn) return `llms.txt always-on ${m[2]} ≠ ${alwaysOn}`;
  if (Number.parseInt(m[3] ?? "0", 10) !== optIn) return `llms.txt opt-in ${m[3]} ≠ ${optIn}`;
  if (Number.parseInt(m[4] ?? "0", 10) !== writes) return `llms.txt writes ${m[4]} ≠ ${writes}`;
  return null;
}

/** Pure check: llms.txt MCP prompt count. */
function checkLlmsPromptCount(llms: string, actual: number): string | null {
  const m = /(\d+)\s+MCP prompts/.exec(llms);
  if (!m) return "llms.txt must declare 'N MCP prompts'";
  const claimed = Number.parseInt(m[1] ?? "0", 10);
  if (claimed !== actual) return `llms.txt prompts ${claimed} ≠ ${actual}`;
  return null;
}

/** Pure check: llms.txt 'N required + M advisory CI gates'. */
function checkLlmsCiGates(llms: string, actualRequired: number): string | null {
  const m = /(\d+)\s+required\s*\+\s*\d+\s+advisory CI gates/.exec(llms);
  if (!m) return "llms.txt must declare 'N required + M advisory CI gates'";
  const claimed = Number.parseInt(m[1] ?? "0", 10);
  if (claimed !== actualRequired)
    return `llms.txt says "${m[0]}" but release.yml REQUIRED has ${actualRequired} entries`;
  return null;
}

/** Pure check: AGENTS.md 'X+ tests' is a valid lower bound (and not far below actual). */
function checkAgentsTestFloor(agents: string, actual: number): string | null {
  const m = /(\d+)\+\s+tests/.exec(agents);
  if (!m) return "AGENTS.md must declare 'X+ tests'";
  const claimed = Number.parseInt(m[1] ?? "0", 10);
  if (claimed > actual)
    return `AGENTS.md says "${m[0]}" (lower bound) but actual is ${actual} — floor is above reality`;
  if (actual - claimed >= 50)
    return `AGENTS.md '${claimed}+ tests' is ${actual - claimed} below actual ${actual} — bump the floor`;
  return null;
}

/** Pure check: AGENTS.md 'N per-file branch floors'. */
function checkAgentsPerFileFloors(agents: string, actualFloors: number): string | null {
  // v3.9.0-rc.26 (F1): accept "branch" or "coverage" wording — rc.26 relabeled
  // AGENTS to "coverage floors" since ocr.ts now has a `lines` floor too.
  const m = /(\d+)\s+per-file (?:branch|coverage) floors/.exec(agents);
  if (!m) return "AGENTS.md must declare 'N per-file branch/coverage floors enforced'";
  const claimed = Number.parseInt(m[1] ?? "0", 10);
  if (claimed !== actualFloors)
    return `AGENTS.md says "${m[0]}" but scripts/check-per-file-coverage.mjs has ${actualFloors} entries`;
  return null;
}

/** Pure check: AGENTS.md 'N required CI gates' (multiple mentions, all must agree). */
function checkAgentsCiGates(agents: string, actualRequired: number): string | null {
  const mentions = [...agents.matchAll(/(\d+)\s+required\s+(?:CI\s+)?gates/g)];
  if (mentions.length === 0) return "AGENTS.md must mention 'N required gates' at least once";
  for (const m of mentions) {
    const claimed = Number.parseInt(m[1] ?? "0", 10);
    if (claimed !== actualRequired)
      return `AGENTS.md mentions "${m[0]}" but release.yml REQUIRED has ${actualRequired} entries`;
  }
  return null;
}

describe("docs/code consistency — llms.txt + AGENTS.md numeric claims (v3.8.0-rc.14 M-2)", () => {
  async function countActualTests(): Promise<number> {
    const fs = await import("node:fs/promises");
    const files: string[] = [];
    async function walk(dir: string) {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else if (e.name.endsWith(".test.ts")) files.push(full);
      }
    }
    await walk(path.join(repoRoot, "tests"));
    let count = 0;
    for (const f of files) {
      const body = await fs.readFile(f, "utf8");
      const matches = [...body.matchAll(/^\s*it\s*[(]/gm)];
      count += matches.length;
    }
    return count;
  }

  async function getActualCounts(): Promise<{
    allTools: number;
    alwaysOn: number;
    ftsOptIn: number;
    diagnostic: number;
    writes: number;
    prompts: number;
  }> {
    const allTools = TOOL_MANIFEST.length;
    const alwaysOn = TOOL_MANIFEST.filter((t) => t.kind === "read").length;
    const ftsOptIn = TOOL_MANIFEST.filter((t) => t.kind === "fts").length;
    const diagnostic = TOOL_MANIFEST.filter((t) => t.kind === "diagnostic").length;
    const writes = TOOL_MANIFEST.filter((t) => t.kind === "write").length;
    const promptsSrc = await read("src/prompts.ts");
    const prompts = registeredNames(promptsSrc, "registerPrompt").size;
    return { allTools, alwaysOn, ftsOptIn, diagnostic, writes, prompts };
  }

  async function countRequiredCiGates(): Promise<number> {
    const releaseYml = await read(".github/workflows/release.yml");
    const m = /REQUIRED="([^"]+)"/.exec(releaseYml);
    if (!m) throw new Error('release.yml must declare REQUIRED="...|..." regex');
    return (m[1] ?? "").split("|").length;
  }

  async function countPerFileFloors(): Promise<number> {
    const script = await read("scripts/check-per-file-coverage.mjs");
    // v3.9.0-rc.26 (rc.25-audit F1): tolerate MULTI-KEY floor objects. rc.23 added
    // a two-key `"src/ocr.ts": { branches: 60, lines: 40 }`, which the original
    // single-key `{ branches: N }` regex skipped — so this counter returned 10
    // while reality was 11, and AGENTS.md's "10" passed against a wrong number
    // (the exact gate-passes-while-claim-is-wrong shape this file exists to catch).
    const matches = [...script.matchAll(/"src\/[\w./-]+":\s*\{[^}]*\bbranches:\s*\d+[^}]*\}/g)];
    return matches.length;
  }

  // ─── Positive tests (real files must pass) ────────────────────────────

  it("llms.txt test count matches actual it() count", async () => {
    const err = checkLlmsTestCount(await read("llms.txt"), await countActualTests());
    expect(err, err ?? "").toBeNull();
  });

  it("llms.txt tool count matches actual", async () => {
    const counts = await getActualCounts();
    const err = checkLlmsToolBreakdown(
      await read("llms.txt"),
      counts.allTools,
      counts.alwaysOn,
      counts.ftsOptIn + counts.diagnostic,
      counts.writes
    );
    expect(err, err ?? "").toBeNull();
  });

  it("llms.txt MCP prompt count matches actual", async () => {
    const counts = await getActualCounts();
    const err = checkLlmsPromptCount(await read("llms.txt"), counts.prompts);
    expect(err, err ?? "").toBeNull();
  });

  it("llms.txt 'N required + M advisory CI gates' matches release.yml REQUIRED count", async () => {
    const err = checkLlmsCiGates(await read("llms.txt"), await countRequiredCiGates());
    expect(err, err ?? "").toBeNull();
  });

  it("AGENTS.md test count claim (X+ tests) is a valid lower bound", async () => {
    const agents = await read("AGENTS.md");
    const err = checkAgentsTestFloor(agents, await countActualTests());
    expect(err, err ?? "").toBeNull();
    // v3.10.0-rc.28 — also pin AGENTS.md "N tool implementations" (file-tree
    // comment) to the registered tool count; it was stale at 44 until rc.28.
    const counts = await getActualCounts();
    // v3.10.0-rc.32 (audit LOW) — presence-assert (not vacuous-on-deletion).
    const toolImplMatches = [...agents.matchAll(/(\d+)\s+tool implementations\b/g)];
    expect(toolImplMatches.length, 'AGENTS.md must keep the "N tool implementations" note').toBeGreaterThan(0);
    for (const tm of toolImplMatches) {
      expect(
        Number.parseInt(tm[1] ?? "0", 10),
        `AGENTS.md "N tool implementations" must equal ${counts.allTools}`
      ).toBe(counts.allTools);
    }
  });

  it("AGENTS.md per-file branch floor count matches actual entries in scripts/check-per-file-coverage.mjs", async () => {
    const err = checkAgentsPerFileFloors(await read("AGENTS.md"), await countPerFileFloors());
    expect(err, err ?? "").toBeNull();
  });

  it("README.zh.md numeric claims match canonical (tools/prompts exact, tests lower-bound)", async () => {
    // v3.10.0-rc.30 — bilingual README.zh.md is a new docs surface; per the
    // rc.14 rule, the same PR pins its numeric claims. Tools/prompts are exact;
    // the test count is a drift-proof lower bound ("N+ 单元测试") so it stays
    // valid as the suite grows (mirrors AGENTS.md's "X+ tests" convention).
    const zh = await read("README.zh.md");
    const counts = await getActualCounts();
    const actualTests = await countActualTests();
    const toolM = /(\d+)\s*个工具/.exec(zh); // stat line "45 个工具" (table "个生产级工具" doesn't match)
    expect(toolM, "README.zh.md must state the tool count as 'N 个工具'").not.toBeNull();
    expect(Number.parseInt(toolM?.[1] ?? "0", 10)).toBe(counts.allTools);
    const promptM = /(\d+)\s*个 MCP 提示词/.exec(zh);
    expect(promptM, "README.zh.md must state 'N 个 MCP 提示词'").not.toBeNull();
    expect(Number.parseInt(promptM?.[1] ?? "0", 10)).toBe(counts.prompts);
    const testM = /(\d+)\+\s*单元测试/.exec(zh);
    expect(testM, "README.zh.md must state tests as a lower bound 'N+ 单元测试'").not.toBeNull();
    const floor = Number.parseInt(testM?.[1] ?? "0", 10);
    expect(floor, `README.zh.md '${floor}+ 单元测试' exceeds actual ${actualTests}`).toBeLessThanOrEqual(actualTests);
    expect(
      actualTests - floor,
      `README.zh.md test floor ${floor} is >200 below actual ${actualTests} — raise it`
    ).toBeLessThan(200);
  });

  it("README.{es,hi,ar,ru,pt,fr,ja}.md numeric claims match canonical (tools/prompts exact, tests lower-bound)", async () => {
    // v3.10.1 / v3.11.0-rc.2 — the top-language translated READMEs are new docs surfaces; per the
    // rc.14 rule the SAME PR pins their numeric claims, mirroring the rc.30 README.zh.md guard.
    // Tools/prompts exact; tests a drift-proof lower bound ("N+ …") matching each stat line.
    const counts = await getActualCounts();
    const actualTests = await countActualTests();
    const langs: Array<{ file: string; tool: RegExp; prompt: RegExp; test: RegExp }> = [
      { file: "README.es.md", tool: /(\d+)\s*herramientas/, prompt: /(\d+)\s*prompts MCP/, test: /(\d+)\+\s*pruebas/ },
      { file: "README.hi.md", tool: /(\d+)\s*टूल/, prompt: /(\d+)\s*MCP\s*प्रॉम्प्ट/, test: /(\d+)\+\s*यूनिट टेस्ट/ },
      { file: "README.ar.md", tool: /(\d+)\s*أداة/, prompt: /(\d+)\s*موجِّه\s*MCP/, test: /(\d+)\+\s*اختبار/ },
      // v3.11.0-rc.2 — ru/pt/fr/ja join the set (9 total). Russian matches "1329+ модульных
      // тестов"; Japanese the spaced "MCP プロンプト".
      { file: "README.ru.md", tool: /(\d+)\s*инструмент/, prompt: /(\d+)\s*MCP-промпт/, test: /(\d+)\+\s*модульных/ },
      { file: "README.pt.md", tool: /(\d+)\s*ferramentas/, prompt: /(\d+)\s*prompts MCP/, test: /(\d+)\+\s*testes/ },
      { file: "README.fr.md", tool: /(\d+)\s*outils/, prompt: /(\d+)\s*prompts MCP/, test: /(\d+)\+\s*tests/ },
      {
        file: "README.ja.md",
        tool: /(\d+)\s*ツール/,
        prompt: /(\d+)\s*MCP\s*プロンプト/,
        test: /(\d+)\+\s*ユニットテスト/
      },
      // v3.11.3 — ko/de join the set (11 total). Korean states the counts word-first
      // ("도구 46개" / "MCP 프롬프트 19개" / "단위 테스트 1440+개"); German uses the tech
      // anglicisms "Tools" / "MCP-Prompts" / "Unit-Tests". Tests are a "N+" lower bound.
      {
        file: "README.ko.md",
        tool: /도구\s*(\d+)\s*개/,
        prompt: /MCP\s*프롬프트\s*(\d+)\s*개/,
        test: /단위\s*테스트\s*(\d+)\+/
      },
      { file: "README.de.md", tool: /(\d+)\s*Tools/, prompt: /(\d+)\s*MCP-Prompts/, test: /(\d+)\+\s*Unit-Tests/ }
    ];
    for (const l of langs) {
      const md = await read(l.file);
      const toolM = l.tool.exec(md);
      expect(toolM, `${l.file} must state the tool count`).not.toBeNull();
      expect(Number.parseInt(toolM?.[1] ?? "0", 10), `${l.file} tool count`).toBe(counts.allTools);
      const promptM = l.prompt.exec(md);
      expect(promptM, `${l.file} must state the MCP prompt count`).not.toBeNull();
      expect(Number.parseInt(promptM?.[1] ?? "0", 10), `${l.file} prompt count`).toBe(counts.prompts);
      const testM = l.test.exec(md);
      expect(testM, `${l.file} must state tests as a lower bound 'N+ …'`).not.toBeNull();
      const floor = Number.parseInt(testM?.[1] ?? "0", 10);
      expect(floor, `${l.file} test floor exceeds actual ${actualTests}`).toBeLessThanOrEqual(actualTests);
      expect(actualTests - floor, `${l.file} test floor ${floor} is >200 below actual ${actualTests}`).toBeLessThan(
        200
      );
    }
    // v3.11.4-rc.2 (full-audit DOCS-TESTCOUNT-I18N-1) — the tests BADGE is an EXACT, language-
    // NEUTRAL surface (`tests-N%20passing`) that the lower-bound stat-line check above does NOT
    // cover; the rc.1 1440→1441 bump synced only en/fr and left the translation badges stale at
    // 1440. Guard every README badge (canonical + translations) === the real count so an exact
    // badge can't silently drift again. Translations without a badge are simply skipped.
    const allReadmes = ["README.md", ...langs.map((l) => l.file)];
    let badgesChecked = 0;
    for (const file of allReadmes) {
      const md = await read(file);
      const badge = /tests-(\d+)(?:%20| )passing/.exec(md);
      if (!badge) continue;
      badgesChecked += 1;
      expect(Number.parseInt(badge[1] ?? "0", 10), `${file} tests badge must equal the real count ${actualTests}`).toBe(
        actualTests
      );
    }
    // non-vacuous: the canonical README + the badge-carrying translations must actually be checked.
    expect(badgesChecked, "at least 2 README test badges must be present + checked").toBeGreaterThanOrEqual(2);
  });

  it("all 11 language READMEs cross-link each other in the switcher (i18n consistency)", async () => {
    // v3.10.1 / v3.11.0-rc.2 — the language switcher is a multi-file surface prone to drift (add a
    // 10th language → forget to update the others). Pin it: each README's <sub> switcher must LINK
    // the other 8 language files and NOT link itself (the current language is bolded, not linked).
    const readmes = [
      "README.md",
      "README.zh.md",
      "README.es.md",
      "README.hi.md",
      "README.ar.md",
      "README.ru.md",
      "README.pt.md",
      "README.fr.md",
      "README.ja.md",
      "README.ko.md",
      "README.de.md"
    ];
    for (const self of readmes) {
      const md = await read(self);
      const switcher = /<sub>([\s\S]*?)<\/sub>/.exec(md)?.[1] ?? "";
      expect(switcher, `${self} must have a <sub>…</sub> language switcher`).not.toBe("");
      for (const other of readmes) {
        const linksOther = switcher.includes(`](./${other})`);
        if (other === self) {
          expect(linksOther, `${self} switcher must NOT link itself — the current language is bolded`).toBe(false);
        } else {
          expect(linksOther, `${self} switcher must link ${other}`).toBe(true);
        }
      }
    }
  });

  it("all translated READMEs are at full SECTION-PARITY with README.md (same H2/H3 count)", async () => {
    // v3.11.3 — the rc.1 i18n audit found zh/es/hi/ar were ABBREVIATED (13 H2 / 1 H3 vs the
    // canonical 15 / 2): they had silently dropped the "Set up in your AI agent", "API reference",
    // and "Example queries" sections while staying GREEN on the numeric + anchor + switcher gates
    // (those check claims/links, never section COMPLETENESS). This structural guard closes that
    // blind spot: every translation must carry the same number of H2 (`## `) and H3 (`### `)
    // headings as the English source, so a future translation can't drift incomplete unnoticed.
    const countHeadings = (md: string, level: 2 | 3): number => {
      const prefix = `${"#".repeat(level)} `;
      return md.split("\n").filter((l) => l.startsWith(prefix) && !l.startsWith(`${prefix}#`)).length;
    };
    const canon = await read("README.md");
    const canonH2 = countHeadings(canon, 2);
    const canonH3 = countHeadings(canon, 3);
    // Within-section CONTENT-block parity: heading-count parity alone let hi/ar keep a PROSE
    // summary where English has a richer block (the rc.2 finding — a translation can have all
    // 15 H2 yet still drop the mermaid diagram or collapse the 46-tool table to one sentence).
    // Pin the two concrete, language-agnostic blocks every complete translation carries:
    //   - the retrieval mermaid diagram (a ```mermaid fence — code, identical across languages)
    //   - the tool table rows that name an `obsidian_*` tool (verbatim, so countable in any script)
    const countMermaid = (md: string): number => (md.match(/```mermaid/g) ?? []).length;
    const countToolRows = (md: string): number =>
      md.split("\n").filter((l) => l.startsWith("|") && /obsidian_/.test(l)).length;
    const canonMermaid = countMermaid(canon);
    const canonToolRows = countToolRows(canon);
    // Sanity: the source itself has a non-trivial section set + content blocks (guards vacuous passes).
    expect(canonH2, "README.md must have >10 H2 sections").toBeGreaterThan(10);
    expect(canonMermaid, "README.md must have a ```mermaid retrieval diagram").toBeGreaterThanOrEqual(1);
    expect(canonToolRows, "README.md must have the per-tool table (>5 obsidian_ rows)").toBeGreaterThan(5);
    const translations = [
      "README.zh.md",
      "README.es.md",
      "README.hi.md",
      "README.ar.md",
      "README.ru.md",
      "README.pt.md",
      "README.fr.md",
      "README.ja.md",
      "README.ko.md",
      "README.de.md"
    ];
    for (const file of translations) {
      const md = await read(file);
      expect(
        countHeadings(md, 2),
        `${file} H2 count must equal README.md (${canonH2}) — a missing section drops it`
      ).toBe(canonH2);
      expect(countHeadings(md, 3), `${file} H3 count must equal README.md (${canonH3})`).toBe(canonH3);
      expect(countMermaid(md), `${file} must keep the mermaid retrieval diagram (README.md has ${canonMermaid})`).toBe(
        canonMermaid
      );
      expect(
        countToolRows(md),
        `${file} must keep the full per-tool table (${canonToolRows} obsidian_ rows in README.md), not a prose summary`
      ).toBe(canonToolRows);
    }
  });

  it("no shipped-stable release is mislabelled `@rc` in any README/llms Releases reel (currency)", async () => {
    // v3.11.3 — the rc.1 relabel of `v3.10` (`@rc`) → `v3.10` stable was an INSTANCE fix: it
    // covered en/ko/de but left fr/ru/pt/ja + llms.txt still advertising the now-stable v3.10
    // line as a pre-release in the Releases highlight reel (the pre-promotion re-sweep caught
    // it). That currency class recurred 3× this release line. v3.10 has shipped to @latest, so
    // NO surface may pair it with `@rc`. Version codes are language-neutral, so this holds
    // across every translation regardless of script.
    const files = [
      "README.md",
      "README.zh.md",
      "README.es.md",
      "README.hi.md",
      "README.ar.md",
      "README.ru.md",
      "README.pt.md",
      "README.fr.md",
      "README.ja.md",
      "README.ko.md",
      "README.de.md",
      "llms.txt"
    ];
    // `v3.10` optionally + `+`, optional backtick/space, a half- OR full-width open paren,
    // optional space/backtick, then `@rc` — the exact shape of the stale label.
    const STALE = /v3\.10`?\+?[\s`]*[(（][\s`]*@rc/;
    // Non-vacuous: the canonical reel DOES mention v3.10, so absence-of-@rc is meaningful.
    const canon = await read("README.md");
    expect(/v3\.10/.test(canon), "README.md Releases reel must mention v3.10").toBe(true);
    expect(STALE.test("`v3.10` (`@rc`)"), "the STALE detector must fire on the known bad shape").toBe(true);
    for (const file of files) {
      const md = await read(file);
      expect(STALE.test(md), `${file} must NOT label shipped-stable v3.10 as @rc (it is @latest-stable)`).toBe(false);
    }
  });

  it("AGENTS.md 'N required CI gates' matches release.yml REQUIRED count", async () => {
    const err = checkAgentsCiGates(await read("AGENTS.md"), await countRequiredCiGates());
    expect(err, err ?? "").toBeNull();
  });

  // ─── NEGATIVE control tests (rc.15 M-3): intentionally-drifted fixtures
  // must trigger non-null error. Without these, the positive tests above
  // could silently pass against a regex that happens to match anything
  // (e.g. typo in the pattern), which is the trivial-pass class.
  // Pattern matches v3.6.4 NEGATIVE-control rule + peek-meta.test.ts.

  it("NEGATIVE: checkLlmsTestCount catches drift", () => {
    // Claim 100, actual 855 → must fail
    expect(checkLlmsTestCount("- 100 unit tests passing", 855)).toMatch(/100.*855|855.*100/);
    // Missing claim entirely → must fail
    expect(checkLlmsTestCount("no test claim here", 855)).toMatch(/must declare/);
    // Matching claim → must pass
    expect(checkLlmsTestCount("- 855 unit tests passing", 855)).toBeNull();
  });

  it("NEGATIVE: checkLlmsToolBreakdown catches drift in any of 4 fields", () => {
    const good = "44 tools (33 always-on read + 4 opt-in + 7 gated writes)";
    expect(checkLlmsToolBreakdown(good, 44, 33, 4, 7)).toBeNull();
    // Drift in total
    expect(checkLlmsToolBreakdown(good, 45, 33, 4, 7)).toMatch(/total/);
    // Drift in always-on
    expect(checkLlmsToolBreakdown(good, 44, 32, 4, 7)).toMatch(/always-on/);
    // Drift in opt-in
    expect(checkLlmsToolBreakdown(good, 44, 33, 5, 7)).toMatch(/opt-in/);
    // Drift in writes
    expect(checkLlmsToolBreakdown(good, 44, 33, 4, 8)).toMatch(/writes/);
    // Missing claim
    expect(checkLlmsToolBreakdown("no breakdown", 44, 33, 4, 7)).toMatch(/must declare/);
  });

  it("NEGATIVE: checkLlmsPromptCount catches drift", () => {
    expect(checkLlmsPromptCount("19 MCP prompts", 19)).toBeNull();
    expect(checkLlmsPromptCount("20 MCP prompts", 19)).toMatch(/prompts/);
    expect(checkLlmsPromptCount("no prompt claim", 19)).toMatch(/must declare/);
  });

  it("NEGATIVE: checkLlmsCiGates catches drift", () => {
    expect(checkLlmsCiGates("9 required + 4 advisory CI gates", 9)).toBeNull();
    expect(checkLlmsCiGates("10 required + 4 advisory CI gates", 9)).toMatch(/10.*9/);
    expect(checkLlmsCiGates("no gates claim", 9)).toMatch(/must declare/);
  });

  it("NEGATIVE: checkAgentsTestFloor catches floor above actual + missing claim", () => {
    // Exact match → pass
    expect(checkAgentsTestFloor("855+ tests", 855)).toBeNull();
    // Floor slightly below actual (within 50 threshold) → pass
    expect(checkAgentsTestFloor("840+ tests", 855)).toBeNull(); // 15 below — within threshold
    // Floor far below actual (>= 50 below) → fail
    expect(checkAgentsTestFloor("800+ tests", 855)).toMatch(/bump the floor/); // 55 below — exceeds threshold
    // Floor above actual → fail
    expect(checkAgentsTestFloor("900+ tests", 855)).toMatch(/above reality/);
    // Missing claim → fail
    expect(checkAgentsTestFloor("no floor claim", 855)).toMatch(/must declare/);
  });

  it("NEGATIVE: checkAgentsPerFileFloors catches drift", () => {
    expect(checkAgentsPerFileFloors("10 per-file branch floors enforced", 10)).toBeNull();
    expect(checkAgentsPerFileFloors("11 per-file branch floors", 10)).toMatch(/11/);
    expect(checkAgentsPerFileFloors("no floor claim", 10)).toMatch(/must declare/);
  });

  it("NEGATIVE: checkAgentsCiGates catches ANY drifted mention", () => {
    // All match → pass
    expect(checkAgentsCiGates("9 required gates, 9 required CI gates", 9)).toBeNull();
    // First mention drifts → fail
    expect(checkAgentsCiGates("10 required gates, 9 required CI gates", 9)).toMatch(/10/);
    // Last mention drifts → fail (multiple-mention coverage)
    expect(checkAgentsCiGates("9 required gates, 10 required CI gates", 9)).toMatch(/10/);
    // Zero mentions → fail
    expect(checkAgentsCiGates("no claim", 9)).toMatch(/at least once/);
  });

  // v3.11.0-rc.8 (pre-promotion audit LOW) — CITATION.cff `version` tracks the @latest
  // STABLE line (its own stated contract) but is deliberately NOT in
  // check-version-consistency.mjs (which pins the in-flight rc), so it silently drifted
  // at v3.9.1 across two stable promotions. Pin it to the newest NON-rc CHANGELOG heading
  // so the next stable promotion can't forget to bump it.
  it("CITATION.cff version equals the latest STABLE release in CHANGELOG (drift guard)", async () => {
    const changelog = await read("CHANGELOG.md");
    // First heading of the form `## [X.Y.Z]` with NO prerelease suffix = the latest stable
    // (the `-rc.N` headings above it don't match — the `]` isn't immediately after the patch).
    const stable = changelog.match(/^## \[(\d+\.\d+\.\d+)\]/m);
    expect(stable, "a stable (non-prerelease) CHANGELOG heading must exist").not.toBeNull();
    const latestStable = (stable as RegExpMatchArray)[1];
    const cff = await read("CITATION.cff");
    const v = cff.match(/^version:\s*"([^"]+)"/m);
    expect(v, "CITATION.cff must declare a version").not.toBeNull();
    expect(
      (v as RegExpMatchArray)[1],
      `CITATION.cff version must equal the latest STABLE release ${latestStable} (its own tracking rule) — bump version + date-released at each stable promotion`
    ).toBe(latestStable);
  });
});
