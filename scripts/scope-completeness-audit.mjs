#!/usr/bin/env node
// v3.8.8 — META structural-defense scope completeness audit.
//
// The recurring "recursion-pair shape" pattern across v3.6.x→v3.8.x
// (6 documented instances) has a single root cause: every structural
// defense we add has a SCOPE — a set of files + claim patterns it
// covers. The recursion happens when a defense is narrower than the
// problem class it's supposed to catch.
//
// Examples:
//   • v3.8.3 added OIA Check 7 for currency claims in docs/+CLAUDE.md
//     only — v3.8.4 found the same drift in README.md+AGENTS.md+
//     examples/ (out of Check 7's scope).
//   • v3.8.0-rc.14 added 7 docs-consistency invariants — rc.15 found
//     they lacked NEGATIVE controls (META violation; M-3).
//   • v3.7.14 F1 closed overclaim #6 — F2 SHIPPED overclaim #7 in the
//     same PR (different function, same TSDoc-drift class).
//
// Class fix: this script enumerates the patterns historically-leaked
// claims have used, sweeps the ENTIRE repo for them, and reports any
// occurrence NOT covered by an existing defense. A future external
// auditor finding a gap in any of these patterns should be impossible
// because this audit runs before every release.
//
// Patterns covered (extend as the defense library grows):
//   • TEST-COUNT — \b\d{3,4} (unit )?tests\b
//   • TOOL-COUNT — \b\d{2}(\s+tools|-tool)\b (paired with the canonical 45)
//   • PROMPT-COUNT — \b\d{2} (MCP )?prompts\b (paired with canonical 19)
//   • CI-GATES — \b\d (required|advisory) (CI )?gates\b
//   • PER-FILE-FLOORS — \bN per-file (branch )?floors? \(was \d\)
//
// For each pattern, the manifest lists:
//   • files: glob patterns that ARE expected to carry the claim
//     (those must match the canonical value or docs-consistency.test.ts
//     fails — that's the existing defense)
//   • exempts: explicit allowlist — files where the pattern naturally
//     appears in a historical-narrative or per-RC context (CHANGELOG,
//     CLAUDE.md status entries). These are skipped.
//   • patterns: the regex pattern(s) the defense should match
//
// Run via: node scripts/scope-completeness-audit.mjs [--report]
// CI integration: invoked from `tests/scope-completeness.test.ts` so a
// gap fails the test run (consistent with the META-invariant pattern).

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

/**
 * v3.8.8 — manifest of every structural defense + its scope. Adding a
 * new defense to docs-consistency.test.ts MUST come with a matching
 * entry here so this audit knows what surfaces it's expected to cover.
 *
 * For each defense:
 *   - id        : short stable name (used in error messages)
 *   - pattern   : regex applied per-line; matches → a claim instance
 *   - scope     : files the defense IS responsible for (canonicalize)
 *   - exempts   : files where the pattern naturally occurs but is OUT
 *                 of scope (historical-narrative / per-release notes)
 *   - rationale : human-readable explanation of WHY this defense exists
 *                 + which previous overclaim / drift triggered it
 */
export const DEFENSES = [
  {
    id: "test-count",
    pattern: /\b(\d{3,4})\s+(?:unit\s+)?tests?\b(?!\s*unchanged)/i,
    scope: ["README.md", "llms.txt", "AGENTS.md", "docs/COMPARISON.md", "package.json", "ROADMAP.md"],
    exempts: [
      // CHANGELOG entries naturally embed per-release test counts —
      // those are historical, not current-state. Each line in CHANGELOG
      // is exempt regardless of the count.
      "CHANGELOG.md",
      // CLAUDE.md status section is a chronological log of each release
      // with its test count at ship time. Same historical-narrative
      // exemption as CHANGELOG.
      "CLAUDE.md",
      // Audit responses written at a specific point in time embed the
      // count from THAT moment.
      "docs/audits/*"
    ],
    rationale:
      "v3.8.0-rc.14 M-2 + rc.15 M-3: test count claims drift fastest. " +
      "Covered by docs-consistency.test.ts numeric-claim invariants."
  },
  {
    id: "tool-count",
    // rc.42 F3 — also match the HYPHENATED singular ("45-tool surface"), not just
    // "45 tools". QUICKSTART.md:132 read "44-tool" and slipped BOTH this audit (space-only
    // pattern) and docs-consistency (QUICKSTART uncovered) → a real stale-count drift.
    pattern: /\b(\d{2})(?:\s+tools|-tool)\b/,
    scope: [
      "README.md",
      "llms.txt",
      "AGENTS.md",
      "docs/COMPARISON.md",
      "docs/api.md",
      "package.json",
      // STABILITY.md has "### MCP tool names (44 tools)" + a tool-breakdown
      // sentence — both gated by docs-consistency.test.ts line 183.
      "STABILITY.md",
      "docs/QUICKSTART.md" // rc.42 F3 — the surface that drifted to "44-tool"
    ],
    exempts: ["CHANGELOG.md", "CLAUDE.md", "docs/audits/*"],
    rationale:
      "Canonical: 44 tools (TOOL_MANIFEST length). docs-consistency.test.ts " +
      "asserts every claim site matches. v3.8.0-rc.14 M-2 added llms.txt + AGENTS.md coverage; " +
      "v3.8.8 META-audit added STABILITY.md to scope (was already gated but missing from manifest)."
  },
  {
    id: "prompt-count",
    pattern: /\b(\d{2})\s+(?:MCP\s+)?prompts\b/,
    scope: ["README.md", "llms.txt", "AGENTS.md", "docs/COMPARISON.md", "docs/api.md", "package.json"],
    exempts: ["CHANGELOG.md", "CLAUDE.md", "docs/audits/*"],
    rationale:
      "Canonical: 19 MCP prompts. docs-consistency.test.ts pins. " +
      "v3.8.0-rc.14 M-2 added llms.txt + AGENTS.md coverage."
  },
  {
    id: "ci-gate-count",
    pattern: /\b(\d+)\s+required\s+(?:\+\s+\d+\s+advisory\s+)?(?:CI\s+)?gates?\b/,
    scope: ["README.md", "llms.txt", "AGENTS.md", "ROADMAP.md"],
    exempts: ["CHANGELOG.md", "CLAUDE.md", "docs/audits/*"],
    rationale:
      "v3.7.14 F4: hardcoded '8 required CI gates' drift caught by " +
      "v3.5.9 anti-pattern recurrence. docs-consistency.test.ts pins " +
      "against release.yml REQUIRED regex (currently 9 required + 4 advisory)."
  },
  {
    id: "per-file-floor-count",
    pattern: /\b(\d{1,2})\s+per-file\s+(?:branch\s+)?floors?\b/,
    scope: ["llms.txt", "AGENTS.md"],
    exempts: ["CHANGELOG.md", "CLAUDE.md", "docs/audits/*"],
    rationale:
      "v3.8.0-rc.14 M-2: per-file floor count was claimed in llms.txt " +
      "+ AGENTS.md but uncovered. docs-consistency.test.ts now pins " +
      "against FLOORS object in scripts/check-per-file-coverage.mjs."
  }
];

/** Read a file relative to repo root. Returns null if missing. */
function read(rel) {
  const abs = resolve(repoRoot, rel);
  if (!existsSync(abs)) return null;
  return readFileSync(abs, "utf8");
}

/**
 * Does `pathRel` match any exempt-glob entry? Supports trailing `*`
 * (e.g. `docs/audits/*`) for directory-level exemption.
 */
function matchesExempt(pathRel, exempts) {
  for (const ex of exempts) {
    if (ex === pathRel) return true;
    if (ex.endsWith("/*")) {
      const prefix = ex.slice(0, -1); // keep trailing /
      if (pathRel.startsWith(prefix)) return true;
    }
  }
  return false;
}

/** All user-visible doc + manifest files we audit. */
const AUDIT_FILES = [
  ".github/pull_request_template.md",
  "AGENTS.md",
  "CHANGELOG.md",
  "CITATION.cff",
  "CLAUDE.md",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "README.md",
  "SECURITY.md",
  "STABILITY.md",
  "docs/COMPARISON.md",
  "docs/QUICKSTART.md",
  "docs/api.md",
  "docs/benchmarks.md",
  "docs/http-transport.md",
  "examples/README.md",
  "examples/chatgpt-actions.md",
  "llms.txt",
  "package.json",
  "server.json",
  "ROADMAP.md"
];

/**
 * Sweep every audit file for every defense's pattern; classify each
 * occurrence as covered / exempt / gap. Returns an array of findings
 * (gaps that should fail CI).
 *
 * v3.9.0-rc.4: this is the numeric-claim portion only. `runAudit()`
 * combines it with the structural-claim audits (deferred-claim,
 * cli-flag-coverage) added in rc.4 to close recursion-pair shape #7
 * (META audit's dimension was incomplete — it only covered NUMERIC
 * drift; non-numeric drift like stale-deferral and missing-flag-doc
 * required separate defenses).
 */
/**
 * Pure per-(defense, file) classifier: every line of `content` matching
 * `defense.pattern` in a file that is NOT in `defense.scope` and NOT exempt is a
 * coverage gap. Extracted (v3.9.0-rc.26, rc.25-audit MED-3) so the
 * scope-completeness NEGATIVE control can drive the REAL classifier with a
 * synthetic gap instead of a re-implemented copy (a copy would pass even if this
 * diverged). `runNumericAudit` is the only production caller.
 * @param {{id:string,pattern:RegExp,scope:string[],exempts:string[],rationale:string}} defense
 * @param {string} file - repo-relative path (for scope/exempt matching + finding)
 * @param {string} content - the file's text
 * @returns {Array<{defense:string,file:string,line:number,evidence:string,rationale:string}>}
 */
export function classifyDefenseFile(defense, file, content) {
  const findings = [];
  const inScope = defense.scope.includes(file);
  const isExempt = matchesExempt(file, defense.exempts);
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!defense.pattern.test(line)) continue;
    // Found a match. Classify:
    if (inScope) continue; // existing defense covers this file
    if (isExempt) continue; // explicitly allowlisted
    findings.push({
      defense: defense.id,
      file,
      line: i + 1,
      evidence: line.trim().slice(0, 160),
      rationale: defense.rationale
    });
  }
  return findings;
}

export function runNumericAudit() {
  const findings = [];
  for (const defense of DEFENSES) {
    for (const file of AUDIT_FILES) {
      const content = read(file);
      if (content === null) continue; // file missing (optional surface)
      findings.push(...classifyDefenseFile(defense, file, content));
    }
  }
  return findings;
}

/**
 * v3.9.0-rc.4 — deferred-claim defense.
 *
 * Closes overclaim instance #13 (CLAUDE.md self-contradiction:
 * header says "deferred to v3.9.0+: X" while status section below
 * says "v3.9.0-rc.N shipped: X"). OIA Check 7 catches "as of vX.Y.Z"
 * present-tense currency claims; this catches the future-tense
 * deferral claim that becomes stale once the item ships.
 *
 * Heuristic: scan CLAUDE.md for the literal substring
 * "deferred to v" anchored on a list of items. For each item named
 * in such a line, check whether the same file contains "shipped"
 * status line mentioning the item (substring match on item name).
 * If both present → finding.
 *
 * Limitations: matches by substring, so item names need to be
 * distinctive (e.g. "OCR'd PDF watcher embed-sync" works; "OCR"
 * alone would collide with "OCR for scanned PDFs").
 */
export function runDeferredClaimAudit() {
  const findings = [];
  const file = "CLAUDE.md";
  const content = read(file);
  if (content === null) return findings;
  const lines = content.split("\n");
  // Concatenate the status section as a single haystack for "shipped"
  // substring search. The status section is bounded between the
  // "Current phase status" heading (or just the bullet list of
  // "v3.X.Y shipped:" lines).
  const haystack = content;
  // Pattern: "deferred to vX.Y.Z+:" OR "Still deferred to vX.Y.Z+:"
  // followed by comma-separated items.
  const deferralRe = /(?:Still\s+)?deferred\s+to\s+v\d+\.\d+\.\d+\+?:\s*([^.\n]+)/i;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const m = deferralRe.exec(line);
    if (!m) continue;
    const itemsText = m[1] ?? "";
    // Split by comma; trim each. Strip leading "and " / trailing
    // ".".
    const items = itemsText
      .split(/,|\band\b/)
      .map((s) => s.trim().replace(/[.,;]$/, ""))
      .filter((s) => s.length > 5); // ignore short connector words
    for (const item of items) {
      // Look for "shipped" status entry mentioning this item by
      // substring. We look for the item appearing within ~150 chars
      // of the literal substring "shipped".
      // Quick check: does the file contain BOTH the item AND "shipped"
      // within a single line that mentions the item?
      const itemLower = item.toLowerCase();
      const shippedRe = new RegExp(
        `^[^\\n]*\\bshipped\\b[^\\n]*${escapeRegex(itemLower)}|${escapeRegex(itemLower)}[^\\n]*\\bshipped\\b`,
        "im"
      );
      if (shippedRe.test(haystack)) {
        findings.push({
          defense: "deferred-claim",
          file,
          line: i + 1,
          evidence: line.trim().slice(0, 200),
          rationale:
            `"${item}" is listed in the deferred-to line at L${i + 1} ` +
            `but ALSO appears in a "shipped" status entry somewhere in the same file. ` +
            "Update the deferred-to header to remove the shipped item " +
            "(overclaim instance #13 class — header / status drift)."
        });
      }
    }
  }
  return findings;
}

/** Tiny regex escape — single use-site for runDeferredClaimAudit. */
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * v3.9.0-rc.4 — cli-flag-coverage defense.
 *
 * Closes recursion-pair shape #7 dimension: every CLI flag defined
 * in `src/cli.ts` (via `.option("--name", ...)`) must appear in
 * `docs/api.md` (the user-facing flag reference). New flags added
 * in v3.9.0-rc.1 (`--ocr-pdfs`, `--ocr-langs`, `--ocr-max-pages`)
 * were missing from api.md for 3 RCs because the v3.8.8 META audit
 * covered only NUMERIC drift, not FEATURE-MENTION drift.
 *
 * Substring match in `docs/api.md`. Allowlist subcommand-specific
 * flags (e.g. `--bearer-token` for serve-http, `--queries` for eval)
 * that are documented in the subcommand table rather than the
 * top-level flag table.
 */
export function runCliFlagCoverageAudit() {
  const findings = [];
  const cliSrc = read("src/cli.ts");
  const apiDoc = read("docs/api.md");
  if (cliSrc === null || apiDoc === null) return findings;
  // Extract every `.option("--name"` from src/cli.ts.
  const flagSet = new Set();
  const re = /\.option\(\s*"(--[a-z][a-z0-9-]*)/g;
  for (const m of cliSrc.matchAll(re)) {
    flagSet.add(m[1]);
  }
  // Subcommand-specific flags that live in the subcommand table
  // (`## Subcommands` section), not the top-level `## CLI flags`
  // table. Exempt from coverage check.
  const subcommandExempts = new Set([
    "--bearer-token",
    "--bearer-token-env",
    "--port",
    "--host",
    "--mcp-path",
    "--rate-limit",
    "--cors-origin",
    "--health-path",
    "--stateful",
    "--session-idle-timeout-ms",
    "--max-sessions",
    "--queries",
    "--k",
    "--matrix",
    "--reranker",
    "--per-query",
    "--json",
    "--embedding-model",
    "--skip-embeddings"
    // (v3.11.0-rc.20: pruned 6 phantom exempts — --no-recurse/--lang/--max-pages/--scale/
    //  --pages/--out — leftovers of a removed media subcommand that match NO current cli.ts
    //  flag, so they were dead cover that could silently exempt a future real flag of the
    //  same name. Verified absent from src/cli.ts before removal.)
  ]);
  for (const flag of flagSet) {
    if (subcommandExempts.has(flag)) continue;
    if (!apiDoc.includes(flag)) {
      findings.push({
        defense: "cli-flag-coverage",
        file: "src/cli.ts",
        line: 0, // we don't track per-flag line numbers in the loop
        evidence: `CLI flag '${flag}' defined in src/cli.ts but absent from docs/api.md`,
        rationale:
          "Every shipped CLI flag should appear in docs/api.md's flag table " +
          "(or the subcommand table, in which case add it to subcommandExempts " +
          "in scripts/scope-completeness-audit.mjs). " +
          "Closes recursion-pair shape #7 (META audit dimension coverage)."
      });
    }
  }
  return findings;
}

/**
 * v3.9.0-rc.4 — combined audit. Runs all three audits and merges
 * findings. Backwards-compatible: existing callers that called
 * `runAudit()` from rc.8+ continue to work; new callers get the
 * extended dimension coverage.
 */
export function runAudit() {
  return [...runNumericAudit(), ...runDeferredClaimAudit(), ...runCliFlagCoverageAudit()];
}

/**
 * Print findings in human-readable form + exit non-zero on any gap.
 * Mirrors scripts/oia-walk.mjs's report style for consistency.
 */
function main() {
  const findings = runAudit();
  if (findings.length === 0) {
    console.log("[scope-completeness] No gaps. Every numeric claim is covered by a defense or exempt.");
    process.exit(0);
  }
  console.error(`[scope-completeness] ${findings.length} gap(s) found:`);
  for (const f of findings) {
    console.error(`  • ${f.defense} :: ${f.file}:${f.line}`);
    console.error(`      evidence: ${f.evidence}`);
    console.error(`      why: ${f.rationale}`);
    console.error(`      fix:  Either (a) add ${f.file} to DEFENSES['${f.defense}'].scope`);
    console.error(`            and extend the matching docs-consistency invariant to cover it, OR`);
    console.error(`            (b) add ${f.file} to DEFENSES['${f.defense}'].exempts with reasoning.`);
  }
  process.exit(1);
}

// Run via CLI; don't run when imported as a module (e.g. by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
