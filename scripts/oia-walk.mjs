#!/usr/bin/env node
// Outside-In Audit (OIA) walk.
//
// Added in v3.7.17 (round-19) to close the meta-finding: external
// auditors consistently find stale fragments that internal class-sweeps
// miss because the internal methodology is CHANGE-DRIVEN (look at what
// changed, fix the class, verify nearby) while external audits are
// STATE-DRIVEN (read every file as it exists today, verify each claim
// against reality).
//
// The internal pre-merge RCA sweep (CLAUDE.md rule since v3.7.15) only
// scans the current patch's diff for class siblings. It does NOT scan
// stale fragments in files the patch didn't touch — those are the
// auditor's hunting ground.
//
// This script automates the cheap state-driven walks. Run before claiming
// "no open audit items" in any release.
//
// Usage:
//   node scripts/oia-walk.mjs            # walk, print findings, exit 1 if any
//   node scripts/oia-walk.mjs --allow    # walk, print findings, always exit 0
//
// Checks (all evidence-based — each finding includes file:line and the
// matched fragment):
//
//   1. STALE VERSION TOMBSTONES — `vX.Y.Z` or `X.Y.Z-rc.N` references
//      in file-header docstrings (first 30 lines of every src/*.ts file)
//      that aren't tagged as historical context (no `History:` or
//      `Pre-3.X` lead-in).
//
//   2. WORKFLOW EXISTENCE — every CI workflow name referenced in README /
//      docs (e.g. "CodeQL", "Analyze") must exist as `.github/workflows/
//      *.yml` OR be explicitly annotated as "via GitHub default-setup".
//
//   3. CLI SUBCOMMAND EXISTENCE — every backticked `enquire-mcp <cmd>`
//      reference in docs/*.md must match a `program.command("<cmd>")`
//      in `src/cli.ts`.
//
//   4. NPM SCRIPT EXISTENCE — every backticked `npm run <script>` in
//      docs/*.md and scripts/*.mjs comments must match `package.json#scripts`.
//
//   5. CURRENT-CLAIM vs TOMBSTONE — comments referring to a "default"
//      value (e.g. "rerank-multilingual default") must agree with the
//      actual exported default constant in the same file.
//
// Exit codes:
//   0 — no findings (or --allow flag passed)
//   1 — at least one finding (full diagnostic to stderr)

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");

const ALLOW_MODE = process.argv.includes("--allow");

/** All findings as a flat array. Each entry: { file, line, kind, evidence, hint }. */
const findings = [];

function record(kind, file, line, evidence, hint) {
  findings.push({ kind, file, line, evidence, hint });
}

function readLines(rel) {
  return readFileSync(join(repoRoot, rel), "utf8").split("\n");
}

function walk(dir, ext, callback) {
  for (const entry of readdirSync(join(repoRoot, dir), { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
      walk(join(dir, entry.name), ext, callback);
    } else if (entry.name.endsWith(ext)) {
      callback(join(dir, entry.name));
    }
  }
}

// ─── Check 1: STALE CURRENCY CLAIMS (not historical tombstones) ─────────
//
// The KEY DISTINCTION:
//
//   • `// v3.5.0 — link predicates added (uses outbound wikilink set)`
//     → HISTORICAL TOMBSTONE (feature added in v3.5.0; legitimate)
//
//   • `// Version 3.6.0-rc.2 split the previous 3665-line monolith`
//     → STALE CURRENCY CLAIM (reads as if 3.6.0-rc.2 is current)
//
// The first round-19 OIA run flagged 21 findings, 20 of which were
// legitimate tombstones (the `vX.Y.Z — feature` pattern). Refined
// heuristic now ONLY flags PATTERNS THAT CLAIM CURRENCY:
//   - "Version X.Y.Z" (no em-dash following, no "was/since" qualifier)
//   - "X.Y.Z-rc.N" / "X.Y.Z-alpha" / "X.Y.Z-beta" — pre-release tags
//     should NEVER appear in a current-state claim
//   - "current X.Y.Z" / "as of X.Y.Z"
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const currentVersion = pkg.version;

// Currency-claim patterns. Each pattern is a regex that captures a
// version number AND demonstrates a currency claim (not a history note).
const CURRENCY_CLAIM_PATTERNS = [
  // "Version X.Y.Z" without preceding "current is" / "was" / "Pre-"
  /(?<!\w)Version\s+(\d+\.\d+\.\d+)\b(?!\s*[-—])/,
  // "rc.N" or "alpha.N" or "beta.N" — pre-release tags only appear in
  // current-state claims (legit history always says "vX.Y.Z added", not
  // "vX.Y.Z-rc.N added").
  /\b(\d+\.\d+\.\d+-(?:rc|alpha|beta)\.\d+)/
];

walk("src", ".ts", (file) => {
  const lines = readLines(file).slice(0, 30);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/^\s*\*|^\s*\/\/|^\s*\/\*/.test(line)) continue;
    for (const pattern of CURRENCY_CLAIM_PATTERNS) {
      const m = pattern.exec(line);
      if (!m) continue;
      const ver = m[1];
      if (ver === currentVersion) continue; // current — OK
      // Skip if surrounding lines provide history context.
      const context = lines.slice(Math.max(0, i - 2), Math.min(lines.length, i + 3)).join(" ");
      if (/\b(History|Pre-|was\s+|legacy|tombstone|previously)\b/i.test(context)) continue;
      record(
        "STALE-CURRENCY-CLAIM",
        file,
        i + 1,
        line.trim(),
        `Reads as currency claim for v${ver} but current is v${currentVersion}. Either prefix with "History:" / "Pre-" to mark as tombstone, or update.`
      );
    }
  }
});

// ─── Check 2: Workflow existence ────────────────────────────────────────
// Find every backticked "CodeQL", "Analyze", "smoke", etc. CI gate name
// in README/docs and verify it exists either as a .github/workflows/*.yml
// file OR is documented as "default-setup".
const workflowDir = join(repoRoot, ".github", "workflows");
const workflowFiles = existsSync(workflowDir) ? readdirSync(workflowDir).filter((f) => f.endsWith(".yml")) : [];
const workflowJobs = new Set();
for (const wf of workflowFiles) {
  const yml = readFileSync(join(workflowDir, wf), "utf8");
  // Job names like `lint:`, `test:`, etc. Detected by ^\s\s<name>:\n\s\s\sruns-on
  for (const m of yml.matchAll(/^\s\s([a-z][a-z0-9-]*):\n[\s\S]*?runs-on:/gm)) {
    workflowJobs.add(m[1]);
  }
}

// Specific check from round-19: README claims "CodeQL ×2" + "Analyze actions"
// in the advisory CI gates section. The actual CodeQL setup is via GitHub
// default-setup (no workflow file). The README should mention this OR
// the workflow files should exist. (Either path resolves the auditor's
// "claim vs reality" finding.)
const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
const README_CI_CLAIMS = ["CodeQL", "Analyze actions"];
for (const claim of README_CI_CLAIMS) {
  if (readme.includes(claim)) {
    const hasWorkflowFile = workflowFiles.some((f) =>
      readFileSync(join(workflowDir, f), "utf8").toLowerCase().includes(claim.toLowerCase())
    );
    const hasDefaultSetupNote = readme.toLowerCase().includes("default-setup");
    if (!hasWorkflowFile && !hasDefaultSetupNote) {
      record(
        "WORKFLOW-CLAIM-WITHOUT-EVIDENCE",
        "README.md",
        readme.split("\n").findIndex((l) => l.includes(claim)) + 1,
        `Claims "${claim}" but no matching workflow file and no "default-setup" annotation.`,
        `Either add the workflow YAML, or annotate the README to clarify the gate comes from GitHub default-setup.`
      );
    }
  }
}

// ─── Check 3: CLI subcommand existence ──────────────────────────────────
const cliSrc = readFileSync(join(repoRoot, "src", "cli.ts"), "utf8");
const registeredSubs = new Set([...cliSrc.matchAll(/program\s*\n?\s*\.command\(\s*"([^"]+)"/g)].map((m) => m[1]));

walk("docs", ".md", (file) => {
  // Skip docs/audits — internal-only finding notes (excluded from npm
  // tarball since v3.7.13 L7). These often contain HYPOTHETICAL references
  // like "the `enquire-mcp dump-index` command if one exists" — flagging
  // them produces false positives. The cost of skipping is that genuine
  // stale audit-doc references slip through; we accept that for now since
  // user-facing docs (docs/*.md root) are what end users see.
  if (file.startsWith("docs/audits/") || file.startsWith("docs\\audits\\")) return;
  const lines = readLines(file);
  for (let i = 0; i < lines.length; i++) {
    // Match `enquire-mcp <cmd>` and verify <cmd> exists in cli.ts.
    for (const m of lines[i].matchAll(/`enquire-mcp\s+([a-z][a-z0-9-]*)\b/g)) {
      const cmd = m[1];
      if (!registeredSubs.has(cmd)) {
        record(
          "CLI-SUBCMD-MISSING",
          file,
          i + 1,
          m[0],
          `docs reference \`enquire-mcp ${cmd}\` but src/cli.ts has no program.command("${cmd}"). Either add the subcommand or drop the reference.`
        );
      }
    }
    // v3.7.18 round-20 R-2 — also catch the LIST format:
    //   "...the `install-model` / `build-embeddings` / ... / `bench` subcommands."
    // where each backticked entry IS a CLI subcommand even though no
    // `enquire-mcp` prefix appears. Heuristic: line containing the literal
    // word "subcommand" AND ≥2 backticked tokens — treat all backticked
    // hyphen-tokens on that line as subcommand claims to verify.
    if (/\bsubcommand/i.test(lines[i])) {
      const tokens = [...lines[i].matchAll(/`([a-z][a-z0-9-]*)`/g)].map((m) => m[1]);
      if (tokens.length >= 2) {
        for (const cmd of tokens) {
          if (!registeredSubs.has(cmd)) {
            record(
              "CLI-SUBCMD-MISSING-LIST",
              file,
              i + 1,
              `\`${cmd}\` in subcommand list`,
              `docs lists \`${cmd}\` as a subcommand in a "/ X / Y / Z subcommands." sentence but src/cli.ts has no program.command("${cmd}"). Round-20 R-2 caught \`bench\` via this pattern.`
            );
          }
        }
      }
    }
  }
});

// ─── Check 4b: STALE-CURRENCY-CLAIM in docs/*.md headers ────────────────
// v3.7.18 round-20 B-1 — extends Check 1 (which scans src/**.ts) to docs/.
// The benchmarks.md "v3.7.0" header drift sat in plain sight for 4 releases
// (v3.7.10→v3.7.13 actually re-measured latency but didn't bump the header).
// Heuristic: scan first 10 lines of every docs/*.md (root, NOT audits) for
// the same currency-claim patterns as src/.
walk("docs", ".md", (file) => {
  if (file.startsWith("docs/audits/") || file.startsWith("docs\\audits\\")) return;
  const lines = readLines(file).slice(0, 10);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const pattern of CURRENCY_CLAIM_PATTERNS) {
      const m = pattern.exec(line);
      if (!m) continue;
      const ver = m[1];
      if (ver === currentVersion) continue;
      // For docs/, the historical-marker check applies to the same line
      // (docs typically don't span 5 lines for one fact).
      if (
        /\b(History|Pre-|was\s+|legacy|tombstone|previously|originally|re-measured|recomputed|bumped\s+to)\b/i.test(
          line
        )
      )
        continue;
      record(
        "STALE-CURRENCY-CLAIM-DOC",
        file,
        i + 1,
        line.trim(),
        `docs/*.md header reads as currency claim for v${ver} but current is v${currentVersion}. Either prefix with "History:" / "Pre-" or update.`
      );
    }
  }
});

// ─── Check 4c: SHELL-SCRIPT-STALENESS ───────────────────────────────────
// v3.7.18 round-20 S-C1/S-C2 — maintainer scripts (`scripts/*.sh`) can drift
// silently because they're never re-run after the first invocation. Examples
// caught by round-20: post-public-setup.sh required dropped `test (20)` gate,
// repo-setup.sh hardcoded v0.3.1 description. Heuristic: a .sh file that
// references a specific version (`v0.X.Y` / `vX.Y.Z`) or a CI gate name
// (`test (20)`, `test (22)`, etc.) without a DEPRECATED guard at the top.
walk("scripts", ".sh", (file) => {
  const content = readFileSync(join(repoRoot, file), "utf8");
  const head = content.split("\n").slice(0, 5).join("\n");
  if (/DEPRECATED|ARCHIVED|exit\s+1/i.test(head)) return; // guarded — OK
  // Look for stale signals.
  const staleSignals = [];
  for (const m of content.matchAll(/\bv0\.\d+\.\d+\b/g)) staleSignals.push(m[0]);
  for (const m of content.matchAll(/test \((20|18|16|14)\)/g)) staleSignals.push(m[0]);
  if (staleSignals.length > 0) {
    record(
      "SHELL-SCRIPT-STALE",
      file,
      1,
      `Found stale references: ${staleSignals.slice(0, 3).join(", ")}`,
      `Maintainer script references old version / dropped CI gate but has no DEPRECATED guard. Either add an "exit 1" deprecation guard at the top OR update the contents to match current state.`
    );
  }
});

// ─── Check 4d: SLSA-3 provenance attestation for the current version ───
// v3.7.19 round-21 θ2 — README claims "SLSA-3 build provenance on releases".
// CI-published releases via `npm publish --provenance` DO get an attestation
// recorded in npm's dist.attestations + Sigstore transparency log. Manual
// publishes (e.g. when NPM_TOKEN is broken and the maintainer falls back to
// `npm publish` from their machine) typically OMIT the `--provenance` flag
// and silently break the SLSA-3 chain.
//
// Round-21 caught this when v3.7.18 was manually published: every CI-shipped
// version (v3.7.14/15/16) has provenance, but v3.7.13 + v3.7.18 (both
// manual) do not. The README claim is technically false for those gaps.
//
// This check queries the live npm registry for the package's current
// version's `dist.attestations` field. If missing, flags it — BUT only
// in `--strict` mode (default) since the missing version state takes a
// few seconds to propagate after publish and false positives are noisy.
// Network-gated: skip the check if offline / npm registry unreachable.
//
// To skip this check explicitly (e.g. for local dev runs), pass
// `--skip-network` flag.
const SKIP_NETWORK = process.argv.includes("--skip-network");
if (!SKIP_NETWORK) {
  try {
    const { execSync } = await import("node:child_process");
    const npmJson = execSync(`npm view @oomkapwn/enquire-mcp@${currentVersion} --json 2>/dev/null`, {
      encoding: "utf8",
      timeout: 10_000
    });
    if (npmJson && npmJson.trim().length > 0) {
      const npmData = JSON.parse(npmJson);
      const hasAttestation = npmData.dist?.attestations?.provenance?.predicateType?.includes("slsa.dev");
      if (!hasAttestation) {
        record(
          "SLSA-PROVENANCE-MISSING",
          "package.json",
          5,
          `npm @oomkapwn/enquire-mcp@${currentVersion} has no SLSA-3 provenance attestation`,
          `README claims "SLSA-3 build provenance on releases" but the current published version lacks dist.attestations. This typically means a manual \`npm publish\` (without --provenance flag) was used to ship this version. Future releases should go through CI (release.yml uses --provenance). Pass --skip-network to OIA to skip this check (offline environments).`
        );
      }
    }
    // npmJson empty = version not yet published — OK, no claim to verify.
  } catch (err) {
    // Network failure or `npm` not installed — silently skip with a stderr note.
    // (Don't fail OIA on infrastructure issues outside the repo's control.)
    console.error(`[oia-walk] SLSA-PROVENANCE check skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ─── Check 4: npm script existence ──────────────────────────────────────
const npmScripts = new Set(Object.keys(pkg.scripts ?? {}));

const npmRefSources = ["docs", "scripts"];
for (const sourceDir of npmRefSources) {
  walk(sourceDir, sourceDir === "scripts" ? ".mjs" : ".md", (file) => {
    const lines = readLines(file);
    for (let i = 0; i < lines.length; i++) {
      for (const m of lines[i].matchAll(/`npm run\s+([a-z][a-z0-9:-]*)`/g)) {
        const script = m[1];
        if (!npmScripts.has(script)) {
          record(
            "NPM-SCRIPT-MISSING",
            file,
            i + 1,
            m[0],
            `Reference to \`npm run ${script}\` but package.json#scripts has no such entry. Either add the script or fix the reference.`
          );
        }
      }
    }
  });
}

// ─── Check 5: Current-claim vs tombstone for "default" inline comments ──
// Look for comments like "X is the default" / "(X default)" / "default X"
// in src/*.ts and cross-check against exported DEFAULT_* constants in
// the same file. This is a heuristic — false-positive-friendly.
walk("src", ".ts", (file) => {
  const src = readFileSync(join(repoRoot, file), "utf8");
  const defaults = new Map();
  for (const m of src.matchAll(/^export const (DEFAULT_[A-Z_]+)\s*=\s*"([^"]+)"/gm)) {
    defaults.set(m[1], m[2]);
  }
  if (defaults.size === 0) return;
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/^\s*\*|^\s*\/\/|^\s*\/\*/.test(line)) continue;
    // Heuristic: comment mentions "<value> default" or "(<value> default)" — find quoted value.
    for (const m of line.matchAll(/[`"']([a-z][a-z0-9-]*)[`"']\s+default\b/gi)) {
      const claimedDefault = m[1];
      // Check against every DEFAULT_* constant in the file.
      for (const [constName, actualValue] of defaults) {
        if (actualValue === claimedDefault) continue; // matches — OK
        // Heuristic: only flag if the comment mentions the SAME alias prefix
        // (e.g. comments about "rerank-multilingual default" near a DEFAULT_RERANKER_ALIAS).
        const prefix = claimedDefault.split("-")[0];
        if (!actualValue.startsWith(prefix)) continue;
        record(
          "STALE-DEFAULT-CLAIM",
          file,
          i + 1,
          line.trim(),
          `Comment claims "${claimedDefault}" is the default, but ${constName} = "${actualValue}". If the comment is historical, prefix with "Pre-vX.Y.Z, the default was..." to mark as tombstone.`
        );
      }
    }
  }
});

// ─── Check 6: Inline "// current ~X%" coverage comments vs actuals ────
// Background: v3.8.0-rc.10 audit (L-1) caught a stale comment in
// scripts/check-per-file-coverage.mjs — line said "// current ~69.23%"
// but the actual file coverage was 71.15% after the rc.10 watcher test
// uplift. The floor (69%) was correct, the test passed, but the inline
// comment created false expectations for readers.
//
// Pattern: per-file coverage entries in check-per-file-coverage.mjs have
// "// current X%" annotations. This check scans them and compares against
// coverage/coverage-summary.json (when present from a recent `npm run
// test:coverage` run). Drift > 1pp triggers a finding.
//
// Skipped when coverage-summary.json doesn't exist (cold CI without
// coverage run) — this is not an authoritative check, just a state-driven
// confirmation that documentation matches measurement.
{
  const summaryPath = join(repoRoot, "coverage", "coverage-summary.json");
  if (existsSync(summaryPath)) {
    let summary;
    try {
      summary = JSON.parse(readFileSync(summaryPath, "utf8"));
    } catch {
      summary = null;
    }
    if (summary) {
      const checkerPath = "scripts/check-per-file-coverage.mjs";
      const checkerSrc = readFileSync(join(repoRoot, checkerPath), "utf8");
      const checkerLines = checkerSrc.split("\n");
      // Pattern: "src/foo.ts": { branches: N }, // current X% [...rest]
      // OR     :                                 // current ~X% [...rest]
      const lineRe = /"(src\/[\w./-]+)":\s*\{\s*branches:\s*\d+\s*\}\s*,?\s*\/\/\s*current\s*~?(\d+(?:\.\d+)?)%/;
      for (let i = 0; i < checkerLines.length; i++) {
        const line = checkerLines[i] ?? "";
        const m = lineRe.exec(line);
        if (!m) continue;
        const filePath = m[1];
        const claimedPercent = parseFloat(m[2] ?? "0");
        // Find the matching entry in coverage-summary.json. Keys are
        // absolute paths; normalize to relative.
        let actualPercent = null;
        for (const [absPath, metrics] of Object.entries(summary)) {
          if (absPath === "total") continue;
          if (absPath.endsWith(`/${filePath}`) && metrics?.branches?.pct !== undefined) {
            actualPercent = metrics.branches.pct;
            break;
          }
        }
        if (actualPercent === null) continue; // file not in coverage report
        const drift = Math.abs(actualPercent - claimedPercent);
        if (drift > 1.0) {
          record(
            "STALE-COVERAGE-COMMENT",
            checkerPath,
            i + 1,
            line.trim(),
            `Inline comment claims ~${claimedPercent}% for ${filePath} but coverage-summary.json says ${actualPercent.toFixed(2)}% (drift ${drift.toFixed(2)}pp). Update the comment to match reality, or remove the percentage annotation if maintenance burden outweighs value.`
          );
        }
      }
    }
  }
}

// ─── Report ─────────────────────────────────────────────────────────────
if (findings.length === 0) {
  console.log("[oia-walk] ✓ No outside-in findings.");
  process.exit(0);
}

console.error(`[oia-walk] ${findings.length} finding(s):\n`);
for (const f of findings) {
  const relPath = f.file.startsWith(repoRoot) ? relative(repoRoot, f.file) : f.file;
  console.error(`  • [${f.kind}] ${relPath}:${f.line}`);
  console.error(`    > ${f.evidence}`);
  console.error(`    hint: ${f.hint}`);
  console.error("");
}

if (ALLOW_MODE) {
  console.error("[oia-walk] --allow flag set; exiting 0 despite findings.");
  process.exit(0);
}
console.error("[oia-walk] Pass --allow to override (CHANGELOG must document why findings are acceptable).");
process.exit(1);
