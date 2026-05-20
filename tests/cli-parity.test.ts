// v3.8.0-rc.1 R-3 — CLI parity invariant.
//
// Background: round-20 external audit (App. B) caught that `serve-http`
// was missing 8 retrieval flags that `serve` had since v2.x:
//   --include-pdfs, --enable-reranker, --reranker-model, --reranker-top-n,
//   --use-hnsw, --hnsw-ef, --late-chunk-context, --no-hnsw-persist.
//
// HTTP-mode users (claude.ai web, ChatGPT, mobile MCP clients) were getting
// a strictly less-featured retrieval stack than stdio users despite the
// "same server, same tools, same indexes" framing in docs/http-transport.md.
//
// Fix: extract `addAdvancedRetrievalOptions(cmd)` helper in src/cli.ts,
// apply to both subcommand definitions. This test guards against future
// drift — if someone adds a new retrieval flag to ONE command but not the
// other, this test fails.
//
// Heuristic: parse src/cli.ts via regex (not by spawning the CLI — the
// goal is a fast, deterministic structural check that doesn't depend on
// startup-time side effects like vault loading).

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "..");

async function readCli(): Promise<string> {
  return fs.readFile(path.join(repoRoot, "src", "cli.ts"), "utf8");
}

/**
 * Parse the cli.ts source for `.option("--flag-name", ...)` calls inside
 * a specific subcommand's definition block. We anchor on the
 * `.command("serve")` / `.command("serve-http")` lines and read forward
 * until the `.action(` call.
 */
function extractFlags(cliSrc: string, anchorRe: RegExp): Set<string> {
  const startMatch = anchorRe.exec(cliSrc);
  if (!startMatch) return new Set();
  const startIdx = startMatch.index;
  // Find the next `.action(` call after this command's start. Subcommand
  // blocks terminate at their .action() invocation in cli.ts's fluent style.
  const actionIdx = cliSrc.indexOf(".action(", startIdx);
  const block = cliSrc.slice(startIdx, actionIdx > startIdx ? actionIdx : startIdx + 20000);
  const flags = new Set<string>();
  for (const m of block.matchAll(/\.option\(\s*"(--[a-z][a-z0-9-]*)/g)) {
    flags.add(m[1] ?? "");
  }
  // Also pick up flags added via `addAdvancedRetrievalOptions(cmd)` — we
  // need to follow the helper. The helper itself is one function that
  // takes a Command and adds the 8 retrieval flags. Look it up separately.
  if (/addAdvancedRetrievalOptions\(/.test(block)) {
    const helperRe = /function addAdvancedRetrievalOptions\([\s\S]*?^}/m;
    const helperMatch = helperRe.exec(cliSrc);
    if (helperMatch) {
      for (const m of helperMatch[0].matchAll(/\.option\(\s*"(--[a-z][a-z0-9-]*)/g)) {
        flags.add(m[1] ?? "");
      }
    }
  }
  return flags;
}

describe("CLI parity — serve and serve-http accept the same retrieval flags (v3.8.0-rc.1 R-3)", () => {
  // The 8 flags round-20 R-3 flagged as missing from serve-http. After
  // v3.8.0-rc.1 these must be present on BOTH subcommands.
  const REQUIRED_RETRIEVAL_FLAGS = [
    "--include-pdfs",
    "--enable-reranker",
    "--reranker-model",
    "--reranker-top-n",
    "--use-hnsw",
    "--hnsw-ef",
    "--late-chunk-context",
    "--no-hnsw-persist"
  ];

  it("both serve and serve-http register the 8 advanced retrieval flags", async () => {
    const cliSrc = await readCli();
    const serveFlags = extractFlags(cliSrc, /\.command\(\s*"serve"\s*,/);
    const serveHttpFlags = extractFlags(cliSrc, /\.command\(\s*"serve-http"\s*\)/);

    for (const flag of REQUIRED_RETRIEVAL_FLAGS) {
      expect(serveFlags.has(flag), `serve missing flag ${flag} — should be added via addAdvancedRetrievalOptions`).toBe(
        true
      );
      expect(serveHttpFlags.has(flag), `serve-http missing flag ${flag} — round-20 R-3 fix regressed`).toBe(true);
    }
  });

  // Negative-control: if the helper itself loses a flag, both subcommands
  // lose it — this asserts that the helper still defines all 8.
  it("addAdvancedRetrievalOptions helper defines all 8 retrieval flags", async () => {
    const cliSrc = await readCli();
    const helperMatch = /function addAdvancedRetrievalOptions\([\s\S]*?^}/m.exec(cliSrc);
    expect(helperMatch, "addAdvancedRetrievalOptions function must exist in src/cli.ts").not.toBeNull();
    if (!helperMatch) return;
    const helperBody = helperMatch[0];
    const helperFlags = new Set<string>();
    for (const m of helperBody.matchAll(/\.option\(\s*"(--[a-z][a-z0-9-]*)/g)) {
      helperFlags.add(m[1] ?? "");
    }
    for (const flag of REQUIRED_RETRIEVAL_FLAGS) {
      expect(helperFlags.has(flag), `addAdvancedRetrievalOptions missing ${flag}`).toBe(true);
    }
    // Sanity: helper should not have stray extra flags beyond the documented 8.
    // (Catches accidental scope creep — if helper grows beyond retrieval flags,
    // explicit rename / refactor is required.)
    expect(helperFlags.size, `addAdvancedRetrievalOptions has ${helperFlags.size} flags; expected exactly 8`).toBe(8);
  });
});
