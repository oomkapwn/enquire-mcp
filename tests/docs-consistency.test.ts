import { promises as fs } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

// Static-analysis tests: every MCP surface registered in src/index.ts must be
// documented in README.md, and every tool/prompt name mentioned in README.md
// must be a real registered surface. Catches doc drift that a real audit
// previously found (e.g. README listing `summarize_recent` instead of the
// actual `summarize_recent_edits`, or a `review_tag` row missing entirely).

const repoRoot = path.resolve(__dirname, "..");

async function read(rel: string): Promise<string> {
  return fs.readFile(path.join(repoRoot, rel), "utf8");
}

function registeredNames(src: string, fn: "registerTool" | "registerPrompt"): Set<string> {
  // Grab the first string-literal arg of every fn(...) call.
  const re = new RegExp(`${fn}\\(\\s*"([^"]+)"`, "g");
  return new Set([...src.matchAll(re)].map((m) => m[1] ?? ""));
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

describe("docs/code consistency — README mirrors registered MCP surface", () => {
  it("every registerTool() in src/index.ts appears in README", async () => {
    const indexSrc = await read("src/index.ts");
    const readme = await read("README.md");
    const registered = registeredNames(indexSrc, "registerTool");
    const mentioned = mentionedToolNames(readme);
    const missingFromReadme = [...registered].filter((t) => !mentioned.has(t));
    expect(missingFromReadme).toEqual([]);
  });

  it("every tool mentioned in README is actually registered", async () => {
    const indexSrc = await read("src/index.ts");
    const readme = await read("README.md");
    const registered = registeredNames(indexSrc, "registerTool");
    const mentioned = mentionedToolNames(readme);
    const ghostTools = [...mentioned].filter((t) => !registered.has(t));
    expect(ghostTools).toEqual([]);
  });

  it("every registerPrompt() in src/index.ts appears in README's prompts cell", async () => {
    const indexSrc = await read("src/index.ts");
    const readme = await read("README.md");
    const registered = registeredNames(indexSrc, "registerPrompt");
    const mentioned = mentionedPromptNames(readme);
    const missingFromReadme = [...registered].filter((p) => !mentioned.has(p));
    expect(missingFromReadme).toEqual([]);
  });

  // v2.0.0-beta.2 architecture invariant: extend docs-consistency to catch
  // numeric drift between README/CHANGELOG/api.md claims and actual code.
  // Pre-fix, the audit found "364+ tests" in README while CHANGELOG said
  // 393, "22 read tools" in README while smoke expected 24, "~3500 lines"
  // while real source was 7526 lines. Each was a manual-update miss.

  it("README tool-count claim matches actual registered count", async () => {
    const indexSrc = await read("src/index.ts");
    const readme = await read("README.md");
    const registered = registeredNames(indexSrc, "registerTool");
    // Heuristic: split by always-on read / opt-in read / write tools.
    // Always-on read = registered NOT in registerWriteTools or registerFtsTools
    // AND NOT gated behind `if (diagnosticSearchTools) server.registerTool(`.
    const writeFnStart = indexSrc.indexOf("function registerWriteTools(");
    const writeFnEnd = writeFnStart > 0 ? indexSrc.indexOf("\n}\n", writeFnStart) : -1;
    const ftsFnStart = indexSrc.indexOf("function registerFtsTools(");
    const ftsFnEnd = ftsFnStart > 0 ? indexSrc.indexOf("\n}\n", ftsFnStart) : -1;
    const writeBody = writeFnStart > 0 && writeFnEnd > 0 ? indexSrc.slice(writeFnStart, writeFnEnd) : "";
    const ftsBody = ftsFnStart > 0 && ftsFnEnd > 0 ? indexSrc.slice(ftsFnStart, ftsFnEnd) : "";
    const writeNames = registeredNames(writeBody, "registerTool");
    const ftsNames = registeredNames(ftsBody, "registerTool");
    // v2.0.0-beta.3: tools gated behind `if (diagnosticSearchTools)` are
    // opt-in, not always-on. Use `\s+` (matches newlines) instead of a
    // single space — Biome's formatter splits `if (...) server.registerTool(`
    // onto separate lines, which would have escaped a single-line regex.
    const diagnosticGated = new Set(
      [...indexSrc.matchAll(/if \(diagnosticSearchTools\)\s+server\.registerTool\(\s*"([^"]+)"/g)].map(
        (m) => m[1] ?? ""
      )
    );
    const alwaysOnRead = [...registered].filter(
      (n) => !writeNames.has(n) && !ftsNames.has(n) && !diagnosticGated.has(n)
    );
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
    const m = /(\d+) MCP tools \((\d+) always-on read \+ (\d+) opt-in read[^+]*\+ (\d+) opt-in write/.exec(apiMd);
    expect(m, "docs/api.md must declare tool counts in the standard format").not.toBeNull();
    if (!m) return;
    const [, total, always, fts, write] = m;
    expect(Number.parseInt(total ?? "0", 10)).toBe(
      Number.parseInt(always ?? "0", 10) + Number.parseInt(fts ?? "0", 10) + Number.parseInt(write ?? "0", 10)
    );
  });

  it("CLI subcommands documented in docs/api.md match those registered in src/index.ts", async () => {
    const indexSrc = await read("src/index.ts");
    const apiMd = await read("docs/api.md");
    // Subcommands registered as `program.command("name")`.
    const registered = new Set(
      [...indexSrc.matchAll(/program\s*\n?\s*\.command\(\s*"([^"]+)"/g)].map((m) => m[1] ?? "")
    );
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
    const indexSrc = await read("src/index.ts");
    const allTools = registeredNames(indexSrc, "registerTool");
    const writeStart = indexSrc.indexOf("function registerWriteTools(");
    const writeEnd = writeStart > 0 ? indexSrc.indexOf("\n}\n", writeStart) : -1;
    const ftsStart = indexSrc.indexOf("function registerFtsTools(");
    const ftsEnd = ftsStart > 0 ? indexSrc.indexOf("\n}\n", ftsStart) : -1;
    const writeBody = writeStart > 0 && writeEnd > 0 ? indexSrc.slice(writeStart, writeEnd) : "";
    const ftsBody = ftsStart > 0 && ftsEnd > 0 ? indexSrc.slice(ftsStart, ftsEnd) : "";
    const writes = registeredNames(writeBody, "registerTool").size;
    const ftsOptIn = registeredNames(ftsBody, "registerTool").size;
    const diagnostic = new Set(
      [...indexSrc.matchAll(/if \(diagnosticSearchTools\)\s+server\.registerTool\(\s*"([^"]+)"/g)].map(
        (m) => m[1] ?? ""
      )
    ).size;
    const writeNames = registeredNames(writeBody, "registerTool");
    const ftsNames = registeredNames(ftsBody, "registerTool");
    const diagSet = new Set(
      [...indexSrc.matchAll(/if \(diagnosticSearchTools\)\s+server\.registerTool\(\s*"([^"]+)"/g)].map(
        (m) => m[1] ?? ""
      )
    );
    const alwaysOn = [...allTools].filter((n) => !writeNames.has(n) && !ftsNames.has(n) && !diagSet.has(n)).length;
    const prompts = registeredNames(indexSrc, "registerPrompt").size;
    return { allTools: allTools.size, alwaysOn, ftsOptIn, diagnostic, writes, prompts };
  }

  it("README total-tool-count badge matches actual registered tool count", async () => {
    const readme = await read("README.md");
    const counts = await getActualCounts();
    // Match e.g. "44 tools · 19 MCP prompts · 656 unit tests"
    const m = /\*\*(\d+) tools?\b/.exec(readme);
    expect(m, "README must declare a total tool count in **N tools** form near the top").not.toBeNull();
    const claimed = Number.parseInt(m?.[1] ?? "0", 10);
    expect(claimed).toBe(counts.allTools);
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

  it("CLI --enable-write help text mentions seven (not five) write tools", async () => {
    // The audit found the help text said "five write tools" while reality is 7.
    // Pin it to "seven" so adding/removing writes forces a help-text update.
    const indexSrc = await read("src/index.ts");
    const counts = await getActualCounts();
    expect(counts.writes).toBe(7); // sanity check on our parsing
    const helpMatch = /Enable the (\w+) write tools/.exec(indexSrc);
    expect(
      helpMatch,
      "--enable-write help text must follow 'Enable the <count-word> write tools' format"
    ).not.toBeNull();
    expect(helpMatch?.[1]).toBe("seven");
  });
});
