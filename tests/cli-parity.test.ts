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

// v3.8.0-rc.11 M-1 root-class fix.
//
// Background: N-5 (round-18 audit) was about `--watch` help text differing
// between serve and serve-http. rc.6 updated serve-http inline. rc.7 updated
// serve inline (longer string, not identical) — still drifted. rc.10 audit
// caught this AND found 8 more flags with the same drift class
// (--disabled-tools 205↔44 chars, --enabled-tools 98↔56, --tokenize, etc.).
//
// Root cause: shared flags between serve and serve-http were defined inline
// in both subcommand blocks (two sources → drift). The `cli-help.ts` module
// existed to prevent this (ENABLE_WRITE_HELP, PERSISTENT_INDEX_HELP, etc.)
// but only a few flags were lifted into it. New flags went inline.
//
// Structural fix: rc.11 lifted 8 more shared flags into cli-help.ts (now 12
// constants total) and replaced both inline literals with the constant. This
// invariant pins the structural property: every flag that appears in BOTH
// serve and serve-http with inline help text must have IDENTICAL text. The
// only exception is short-form cross-references where serve-http says
// "(same semantics as `serve`)" — those are explicitly allowlisted.
//
// If a future PR adds a new shared flag with inline text and the texts
// differ, this test fails before merge.

describe("CLI parity — serve and serve-http shared-flag help text equality (v3.8.0-rc.11 M-1)", () => {
  /**
   * Flags where serve-http intentionally uses a short cross-reference like
   * "(same semantics as `serve`)" instead of repeating the long serve text.
   * Adding to this allowlist must be a deliberate design decision documented
   * in the CHANGELOG.
   */
  const INTENTIONAL_SHORT_FORM = new Set(["--exclude-glob", "--read-paths"]);

  /** Extract `.option("--flag", "literal text")` pairs from a block.
   *  Constants (UPPER_SNAKE_CASE identifiers as second arg) are normalized
   *  to the marker `:CONSTANT:<NAME>` so identical constant usage is
   *  trivially equal across blocks. */
  function extractInlineHelp(block: string): Map<string, string> {
    const out = new Map<string, string>();
    // Match .option("--flag[ <arg>]", "literal" | IDENTIFIER)
    // Both single-line and multi-line .option() invocations.
    const re = /\.option\(\s*"(--[a-z][a-z0-9-]*)(?:\s+<[^>]+>)?"\s*,\s*("([^"]+)"|([A-Z][A-Z0-9_]*))\s*\)/g;
    for (const m of block.matchAll(re)) {
      const flag = m[1] ?? "";
      const literal = m[3];
      const constant = m[4];
      if (constant) {
        out.set(flag, `:CONSTANT:${constant}`);
      } else if (literal !== undefined) {
        out.set(flag, literal);
      }
    }
    return out;
  }

  function extractCommandBlock(cliSrc: string, anchorRe: RegExp): string {
    const startMatch = anchorRe.exec(cliSrc);
    if (!startMatch) return "";
    const startIdx = startMatch.index;
    const actionIdx = cliSrc.indexOf(".action(", startIdx);
    return cliSrc.slice(startIdx, actionIdx > startIdx ? actionIdx : startIdx + 20000);
  }

  it("every flag appearing in BOTH serve and serve-http has identical help text", async () => {
    const cliSrc = await readCli();
    const serveBlock = extractCommandBlock(cliSrc, /\.command\(\s*"serve"\s*,/);
    const serveHttpBlock = extractCommandBlock(cliSrc, /\.command\(\s*"serve-http"\s*\)/);

    const serveHelp = extractInlineHelp(serveBlock);
    const httpHelp = extractInlineHelp(serveHttpBlock);

    const sharedFlags = [...serveHelp.keys()].filter((f) => httpHelp.has(f));
    expect(sharedFlags.length, "expected at least 10 shared flags between serve and serve-http").toBeGreaterThan(10);

    const drifts: string[] = [];
    for (const flag of sharedFlags) {
      if (INTENTIONAL_SHORT_FORM.has(flag)) continue;
      const s = serveHelp.get(flag) ?? "";
      const h = httpHelp.get(flag) ?? "";
      if (s !== h) {
        drifts.push(
          `${flag}:\n  serve      (${s.length}): ${s.slice(0, 100)}\n  serve-http (${h.length}): ${h.slice(0, 100)}`
        );
      }
    }

    expect(
      drifts,
      `${drifts.length} flag(s) drifted between serve and serve-http. Fix: lift the help text into src/cli-help.ts as a constant and use it in both .option() calls. If the asymmetry is intentional (cross-reference short-form), add the flag to INTENTIONAL_SHORT_FORM allowlist.\n\n${drifts.join("\n\n")}`
    ).toEqual([]);
  });

  it("INTENTIONAL_SHORT_FORM allowlist matches reality — NEGATIVE control", async () => {
    // Sanity: each flag in the allowlist must actually appear in BOTH
    // commands AND have asymmetric help text (else it doesn't need to be
    // allowlisted — clean it up to keep the allowlist minimal).
    const cliSrc = await readCli();
    const serveBlock = extractCommandBlock(cliSrc, /\.command\(\s*"serve"\s*,/);
    const serveHttpBlock = extractCommandBlock(cliSrc, /\.command\(\s*"serve-http"\s*\)/);
    const serveHelp = extractInlineHelp(serveBlock);
    const httpHelp = extractInlineHelp(serveHttpBlock);

    for (const flag of INTENTIONAL_SHORT_FORM) {
      expect(serveHelp.has(flag), `${flag} in allowlist but not in serve`).toBe(true);
      expect(httpHelp.has(flag), `${flag} in allowlist but not in serve-http`).toBe(true);
      const s = serveHelp.get(flag) ?? "";
      const h = httpHelp.get(flag) ?? "";
      expect(
        s === h ? "IDENTICAL" : "DIFFERENT",
        `${flag} is in allowlist but help texts are actually identical — remove from allowlist`
      ).toBe("DIFFERENT");
    }
  });
});
