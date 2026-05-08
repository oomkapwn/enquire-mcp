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
    // opt-in, not always-on.
    const diagnosticGated = new Set(
      [...indexSrc.matchAll(/if \(diagnosticSearchTools\) server\.registerTool\(\s*"([^"]+)"/g)].map((m) => m[1] ?? "")
    );
    const alwaysOnRead = [...registered].filter(
      (n) => !writeNames.has(n) && !ftsNames.has(n) && !diagnosticGated.has(n)
    );
    // Look for a heading or sentence claiming "<N> read tools (always on)".
    const m = /(\d+) read tools \(always on\)/.exec(readme);
    expect(m, "README must declare a number of always-on read tools").not.toBeNull();
    const claimed = Number.parseInt(m?.[1] ?? "0", 10);
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
