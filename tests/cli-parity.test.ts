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
    "--no-hnsw-persist",
    "--recency-weight",
    "--stale-days"
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
  // lose it — this asserts that the helper still defines all retrieval
  // flags. v3.9.0-rc.1 grew the helper from 8 to 11 (added --ocr-pdfs,
  // --ocr-langs, --ocr-max-pages — the OCR-on-watch options that both
  // serve and serve-http share). Sanity cap raised accordingly.
  it("addAdvancedRetrievalOptions helper defines all retrieval flags (14 as of v3.11.0)", async () => {
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
    // Sanity: helper should not have stray extra flags beyond the documented set.
    // (Catches accidental scope creep — if helper grows beyond retrieval flags,
    // explicit rename / refactor is required.)
    expect(helperFlags.size, `addAdvancedRetrievalOptions has ${helperFlags.size} flags; expected exactly 14`).toBe(14);
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

// v3.8.0-rc.17 — multi-subcommand drift invariant. Generalizes the serve↔serve-http
// parity (cli-parity rc.11) to ALL subcommands. If a flag appears as inline
// literal text in 2+ subcommands AND the text is byte-identical, that's a
// "lift candidate" — should have been added to cli-help.ts. The invariant
// fails to force the lift.
//
// Drifted text across subcommands is ALLOWED if intentional (different
// operational semantics per subcommand, e.g. --include-pdfs does different
// things in install-model vs build-embeddings vs setup). Document those
// inline with comments — the invariant doesn't flag them.
//
// META-INVARIANT-EXEMPT: NEGATIVE control coverage provided by the
// fixture-based test below (intentionally-drifted inline strings).

describe("CLI parity — no byte-identical inline help text across subcommands (v3.8.0-rc.17)", () => {
  /** Extract every (subcommand, flag, text) triple from cli.ts.
   *  Returns Map<flag, Map<subcommand, text>>. */
  function extractAllFlagHelp(cliSrc: string): Map<string, Map<string, string>> {
    const out = new Map<string, Map<string, string>>();
    // Find subcommand starts: .command("foo") or .command("foo", { ... })
    const subcmds: { name: string; start: number }[] = [];
    for (const m of cliSrc.matchAll(/\.command\(\s*"([\w-]+)"/g)) {
      subcmds.push({ name: m[1] ?? "", start: m.index ?? 0 });
    }
    subcmds.push({ name: "_END_", start: cliSrc.length });
    for (let i = 0; i < subcmds.length - 1; i++) {
      const block = cliSrc.slice(subcmds[i]?.start ?? 0, subcmds[i + 1]?.start ?? cliSrc.length);
      // Match .option("--flag[ <arg>]", "literal" | CONST | template) — captures both inline and constant
      const re = /\.option\(\s*"(--[a-z][a-z0-9-]*)(?:\s+<[^>]+>)?"\s*,\s*(?:"([^"]+)"|([A-Z][A-Z0-9_]*))/g;
      for (const om of block.matchAll(re)) {
        const flag = om[1] ?? "";
        const inlineText = om[2];
        const constant = om[3];
        if (inlineText !== undefined) {
          // Track inline text only — constants are already drift-proof
          const key = subcmds[i]?.name ?? "";
          if (!out.has(flag)) out.set(flag, new Map());
          out.get(flag)?.set(key, inlineText);
        } else if (constant) {
          const key = subcmds[i]?.name ?? "";
          if (!out.has(flag)) out.set(flag, new Map());
          out.get(flag)?.set(key, `:CONST:${constant}`);
        }
      }
    }
    return out;
  }

  /** Pure check: byte-identical inline text in 2+ subcommands should be lifted.
   *  Returns null on OK, error string on violation. */
  function checkNoIdenticalInlineDrift(flagMap: Map<string, Map<string, string>>): string | null {
    const violations: string[] = [];
    for (const [flag, perCmd] of flagMap) {
      // Group by text — only inline literals (skip :CONST: entries)
      const inlineEntries = [...perCmd.entries()].filter(([_, txt]) => !txt.startsWith(":CONST:"));
      if (inlineEntries.length < 2) continue;
      const byText = new Map<string, string[]>();
      for (const [cmd, txt] of inlineEntries) {
        const list = byText.get(txt) ?? [];
        list.push(cmd);
        byText.set(txt, list);
      }
      for (const [txt, cmds] of byText) {
        if (cmds.length >= 2) {
          violations.push(
            `${flag}: byte-identical inline text "${txt.slice(0, 60)}..." in ${cmds.length} subcommands [${cmds.join(", ")}] — lift to cli-help.ts as a constant`
          );
        }
      }
    }
    return violations.length === 0 ? null : violations.join("\n");
  }

  it("no flag has byte-identical inline help text in 2+ subcommands (should be lifted)", async () => {
    const cliSrc = await readCli();
    const flagMap = extractAllFlagHelp(cliSrc);
    const err = checkNoIdenticalInlineDrift(flagMap);
    expect(err, err ?? "").toBeNull();
  });

  it("NEGATIVE: checkNoIdenticalInlineDrift detects identical inline text", () => {
    // Two subcommands with the SAME inline text → must fail
    const flagMap = new Map([
      [
        "--cache-file",
        new Map([
          ["clear-cache", "Override the cache file location"],
          ["serve", "Override the cache file location"]
        ])
      ]
    ]);
    expect(checkNoIdenticalInlineDrift(flagMap)).toMatch(/cache-file.*byte-identical/);
  });

  it("NEGATIVE: checkNoIdenticalInlineDrift allows different inline text (intentional context-specific)", () => {
    // Different text across subcommands → OK (intentional drift)
    const flagMap = new Map([
      [
        "--include-pdfs",
        new Map([
          ["index", "Index PDFs into FTS5"],
          ["build-embeddings", "Embed PDF chunks"]
        ])
      ]
    ]);
    expect(checkNoIdenticalInlineDrift(flagMap)).toBeNull();
  });

  it("NEGATIVE: checkNoIdenticalInlineDrift allows constant references (already drift-proof)", () => {
    // Constants don't count as inline drift
    const flagMap = new Map([
      [
        "--watch",
        new Map([
          ["serve", ":CONST:WATCH_HELP"],
          ["serve-http", ":CONST:WATCH_HELP"]
        ])
      ]
    ]);
    expect(checkNoIdenticalInlineDrift(flagMap)).toBeNull();
  });
});

// v3.11.5-rc.1 (CLI-QUANT-NORM-1) — both `serve` and `serve-http` must forward the
// NORMALIZED quantization mode (aliases "q8"/"float32"/"none" → "int8"/"f32"), not the
// raw --quantize-embeddings string. Downstream (server.ts) exact-matches "f32"/"int8",
// so a discarded parseQuantizationMode() result silently degrades an aliased value to the
// default. Pre-fix stdio `serve` called parseQuantizationMode() for VALIDATION but threw
// the return away and forwarded raw opts; serve-http captured + spread it.
describe("CLI parity — serve and serve-http both forward the NORMALIZED quantize mode (v3.11.5-rc.1)", () => {
  it("spreads the normalized quantMode into forwarded opts in BOTH serve + serve-http (2 spreads)", async () => {
    const src = await readCli();
    // The distinctive normalized-forward signal: `quantizeEmbeddings: quantMode` — one per
    // long-lived serve subcommand (serve + serve-http). Pre-fix stdio serve had none (it
    // forwarded raw opts), so this was 1; post-fix it is 2.
    const spreads = src.match(/quantizeEmbeddings:\s*quantMode/g) ?? [];
    expect(spreads.length, "both serve + serve-http must spread the normalized quantMode into forwarded opts").toBe(2);
  });

  it("NEGATIVE control — no discarded (statement-position) parseQuantizationMode() call remains", async () => {
    const src = await readCli();
    // The regression shape: a bare `parseQuantizationMode(...)` on its own line whose result is
    // thrown away (not `const x =` / `= ` / `return `). That is exactly what forwarded the raw string.
    const discarded = src.split("\n").filter((l) => /^\s*parseQuantizationMode\(/.test(l));
    expect(discarded, `discarded parseQuantizationMode() call(s): ${discarded.join(" | ")}`).toEqual([]);
  });
});
