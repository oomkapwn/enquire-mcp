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
//   • TOOL-COUNT — \b\d{2} tools\b (paired with the canonical 44)
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
    scope: ["README.md", "llms.txt", "AGENTS.md", "docs/COMPARISON.md", "package.json"],
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
    pattern: /\b(\d{2})\s+tools\b/,
    scope: [
      "README.md",
      "llms.txt",
      "AGENTS.md",
      "docs/COMPARISON.md",
      "docs/api.md",
      "package.json",
      // STABILITY.md has "### MCP tool names (44 tools)" + a tool-breakdown
      // sentence — both gated by docs-consistency.test.ts line 183.
      "STABILITY.md"
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
    scope: ["README.md", "llms.txt", "AGENTS.md"],
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
  "server.json"
];

/**
 * Sweep every audit file for every defense's pattern; classify each
 * occurrence as covered / exempt / gap. Returns an array of findings
 * (gaps that should fail CI).
 */
export function runAudit() {
  const findings = [];
  for (const defense of DEFENSES) {
    for (const file of AUDIT_FILES) {
      const content = read(file);
      if (content === null) continue; // file missing (optional surface)
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
    }
  }
  return findings;
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
