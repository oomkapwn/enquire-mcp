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
// matched fragment). v3.9.0-rc.8 (audit S3): this enumeration was stale —
// it listed only checks 1–5 while the code grew to 11 distinct walks. The
// canonical count is "12" (the top-level numbered checks 1–12), but check 4
// has historically accreted sub-checks (4b/4c/4d/4e/4f), so 15 distinct walks
// actually run. Full honest list below:
//
//   1.  STALE VERSION TOMBSTONES — `vX.Y.Z` / `X.Y.Z-rc.N` in src/*.ts
//       file-header docstrings (first 30 lines) not tagged as history.
//   2.  WORKFLOW EXISTENCE — CI workflow names in README/docs must exist
//       as `.github/workflows/*.yml` or be annotated "via GitHub default-setup".
//   3.  CLI SUBCOMMAND EXISTENCE — backticked `enquire-mcp <cmd>` in
//       docs/*.md must match a `program.command("<cmd>")` in src/cli.ts.
//   4b. STALE-CURRENCY-CLAIM in docs/*.md headers (extends 1 to docs/).
//   4c. SHELL-SCRIPT-STALENESS — scripts/*.sh referencing removed commands.
//   4d. SLSA build-provenance LEVEL claim vs release.yml mechanism +
//       (network) published-attestation presence. [rewritten rc.8 / audit S2]
//   4e. OCR OFFLINE-GUARD — docs claiming "zero outbound / no runtime CDN /
//       install-ocr-lang" must be backed by the real code guards in ocr.ts
//       (assertOcrLangsInstalled + cacheMethod:"readOnly") + cli.ts
//       (install-ocr-lang subcommand). [added rc.10 / overclaim #16]
//   4f. EMBED OFFLINE-GUARD — docs claiming "zero cloud calls during serve" must
//       be backed by src/embeddings.ts `allowRemoteModels=false` (offline flag) +
//       setEmbeddingsOffline() called in cli.ts serve + serve-http. [added rc.42 / F1]
//   4.  NPM SCRIPT EXISTENCE — backticked `npm run <script>` in docs +
//       script comments must match `package.json#scripts`.
//   5.  CURRENT-CLAIM vs TOMBSTONE — "default" value comments must agree
//       with the actual exported `DEFAULT_*` constant in the same file.
//   6.  COVERAGE-COMMENT DRIFT — inline `// current ~X%` in
//       check-per-file-coverage.mjs vs coverage-summary.json (>1pp fails).
//   7.  STALE CURRENT-STATE VERSION CLAIMS in docs/ + CLAUDE.md (present-
//       and future-tense currency claims vs the actual current major.minor;
//       v3.9.0-rc.12 added an RC-LEVEL sub-check — "currently/valid as of
//       vX.Y.Z-rc.N" must match the EXACT current version, not just maj.minor).
//   8.  SCOPE-COMPLETENESS — delegates to scope-completeness-audit.mjs
//       (numeric-claim + deferred-claim + cli-flag-coverage dimensions).
//   9.  ACTION SHA-PIN — every third-party GitHub Action in
//       .github/workflows/*.yml must be pinned to a 40-hex commit SHA, not a
//       floating tag (supply-chain). [added rc.14]
//   9b. RUN-DOWNLOAD-UNPINNED / -UNVERIFIED — a `run:` `curl`/`wget` must not
//       fetch from a moving `releases/latest` URL (same supply-chain class as 9,
//       different surface — the M-9 mcp-publisher shape) [added v3.9.1]; and a
//       tag-pinned release ARCHIVE (`releases/download/<tag>/…\.tar.gz`) must ALSO
//       be SHA256-verified (`sha256sum -c`) in the same file — content-pin, since
//       a tag is mutable. [extended rc.26 / SYS-1 M-9 completion]
//   10. NPM-CI RETRY — every `npm ci` in .github/workflows/*.yml must be
//       retry-wrapped (bare `- run: npm ci` fails the job on a transient
//       onnxruntime-postinstall CDN ETIMEDOUT). [added rc.20]
//   11. MCP-REGISTRY VERSION DRIFT — canonical registry version vs npm
//       `@latest` (non-fatal advisory; remediation is maintainer-gated). [rc.32]
//   12. STALE-DIST-TOOLS-IMPORT — scripts/*.mjs must not import the pre-split
//       `dist/tools.js` (TypeScript now emits `dist/tools/index.js`). [rc.35]
//   12b. ORPHAN-DIST-FILE — every emitted `dist/<p>.{js,d.ts}` must have a
//       backing `src/<p>.ts` (flat 1:1 TS emit rule). Catches the stale
//       *artifact* (not just the stale import string) that ships to npm when a
//       build doesn't purge dist/. Skips when dist/ is absent (CI oia job does
//       not build). [added rc.36 — the L-3 class root cause]
//
// NB: the on-disk marker order is 1,2,3,4b,4c,4d,4e,4,5,6,7,8,9,9b,10,11,12,12b —
// check 4d/4e/4 appear after the 4b/4c sub-checks for historical-accretion
// reasons; the numbering is kept stable because CHANGELOG entries reference
// these IDs. The canonical top-level count stays 12 (12b is a sub-check of the
// dist-split / L-3 class, mirroring 4b–4e under check 4).
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

// ─── Check 4d: SLSA build-provenance LEVEL claim vs actual mechanism ───
// v3.9.0-rc.8 (audit S2) — REWRITTEN. The old check only verified that the
// current npm version had SOME slsa.dev attestation, and its wording still
// said "SLSA-3" — the exact overclaim (#15) that rc.7 had to retract. It
// could NOT detect the actual bug (a doc claiming SLSA-3/Build L3 when the
// workflow only earns L2), and it silently no-op'd on unpublished RCs (i.e.
// it was effectively OFF for every pre-stable release that CI runs).
//
// This is the "claimed-guarantee vs code-guard" class (CLAUDE.md anti-pattern
// since rc.7): the SLSA *level* claimed in docs MUST match what release.yml
// actually does.
//   • `npm publish --provenance` (+ GitHub OIDC) = SLSA Build **L2**
//     (hosted builder + Sigstore-signed, non-forgeable-by-author provenance).
//   • SLSA Build **L3** requires an isolated, non-falsifiable builder, i.e.
//     the `slsa-framework/slsa-github-generator` reusable workflow.
//
// Part A (STATIC, always runs — offline + on RCs): derive the EARNED level
// from release.yml, then fail if any doc claims a HIGHER level than earned.
// This catches the #15 regression with zero network dependency.
{
  const releaseYml = readLines(".github/workflows/release.yml").join("\n");
  const earnsL3 = /slsa-framework\/slsa-github-generator/.test(releaseYml);
  const doesProvenance = /npm publish[^\n]*--provenance/.test(releaseYml);
  // Earned level: 3 if the isolated-builder generator is wired; 2 if only
  // `npm publish --provenance`; 0 if neither (no provenance at all).
  const earnedLevel = earnsL3 ? 3 : doesProvenance ? 2 : 0;
  // Surfaces that carry the public SLSA/provenance claim. v3.9.0-rc.18 added
  // assets/social-preview.svg — the GitHub social card is the most-shared
  // visual of the repo and it carried a stale "SLSA-3" badge that rc.7's
  // sweep (and this check's original scope) both missed for 11 RCs.
  const claimFiles = [
    "README.md",
    "package.json",
    "llms.txt",
    "docs/COMPARISON.md",
    "STABILITY.md",
    "assets/social-preview.svg"
  ];
  // Patterns that assert SLSA Build Level 3 (or the legacy "SLSA-3" shorthand,
  // or a badge linking to the L3 spec anchor).
  const l3ClaimRe = /\bSLSA[-\s]?3\b|\bSLSA\s+(?:Build\s+)?L(?:evel\s*)?3\b|levels#build-l3/i;
  for (const file of claimFiles) {
    const lines = readLines(file);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (!l3ClaimRe.test(line)) continue;
      // A doc may legitimately mention L3 as a ROADMAP/future target — skip
      // lines that frame it as not-yet-earned.
      if (/\b(roadmap|on the roadmap|planned|future|earn|target|not yet|L3 generator)\b/i.test(line)) continue;
      if (earnedLevel < 3) {
        record(
          "SLSA-LEVEL-OVERCLAIM",
          file,
          i + 1,
          line.trim().slice(0, 140),
          `Doc claims SLSA Build L3 but release.yml only earns Build L${earnedLevel} (it does ${doesProvenance ? "`npm publish --provenance` = L2" : "no provenance"}; L3 needs slsa-framework/slsa-github-generator). Either adopt the isolated-builder generator, OR phrase the L3 mention as a roadmap target (add "roadmap"/"planned"/"on the roadmap").`
        );
      }
    }
  }
}

// Part B (NETWORK, opt-out via --skip-network): for a PUBLISHED version,
// confirm the npm artifact actually carries the L2 provenance attestation
// the docs promise. Skips cleanly for unpublished RCs (no claim to verify
// yet) and on infra failure — Part A is the always-on guard.
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
          `npm @oomkapwn/enquire-mcp@${currentVersion} has no signed build-provenance attestation`,
          `Docs claim signed build provenance (SLSA L2) but the current published version lacks dist.attestations. This typically means a manual \`npm publish\` (without --provenance) shipped this version. Releases must go through CI (release.yml uses --provenance). Pass --skip-network to skip (offline environments).`
        );
      }
    }
    // npmJson empty = version not yet published — OK, no claim to verify.
  } catch (err) {
    // Network failure or `npm` not installed — silently skip with a stderr note.
    // (Don't fail OIA on infrastructure issues outside the repo's control.)
    console.error(
      `[oia-walk] SLSA-PROVENANCE network check skipped: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

// ─── Check 4e: OCR offline-enforcement claim vs actual code-guard ────────
// v3.9.0-rc.10 (overclaim #16) — the "claimed-guarantee vs code-guard" class,
// applied to the OCR offline guarantee (mirrors Check 4d for SLSA). Docs claim
// `serve` makes "zero outbound network calls" / "no runtime CDN download" and
// reference an `install-ocr-lang` subcommand. That is only TRUE if three code
// guards exist: (1) `extractPdfWithOcr` calls `assertOcrLangsInstalled` (the
// pre-flight throw), (2) the worker is pinned to the local cache
// (`cacheMethod: "readOnly"`), (3) `install-ocr-lang` is a registered CLI
// subcommand. If a doc makes the enforced claim but a guard is missing, fail —
// exactly the regression that shipped as overclaim #16 before rc.10.
{
  const ocrSrc = readLines("src/ocr.ts").join("\n");
  const cliSrc = readLines("src/cli.ts").join("\n");
  const guardCalled = /assertOcrLangsInstalled\s*\(/.test(ocrSrc);
  const readOnlyPin = /cacheMethod\s*:\s*["']readOnly["']/.test(ocrSrc);
  const installCmd = /\.command\(\s*["']install-ocr-lang["']\s*\)/.test(cliSrc);
  if (!(guardCalled && readOnlyPin && installCmd)) {
    const missing = [
      !guardCalled && "src/ocr.ts must call assertOcrLangsInstalled() (offline pre-flight)",
      !readOnlyPin && 'src/ocr.ts createWorker must set cacheMethod:"readOnly"',
      !installCmd && 'src/cli.ts must register the "install-ocr-lang" subcommand'
    ].filter(Boolean);
    const claimFiles = ["SECURITY.md", "README.md", "docs/COMPARISON.md", "docs/api.md", "llms.txt"];
    const claimRe =
      /no runtime CDN download|offline-only (?:posture|enforcement)|install-ocr-lang|zero outbound network calls in serve/i;
    for (const file of claimFiles) {
      const lines = readLines(file);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        if (!claimRe.test(line)) continue;
        if (/roadmap|planned|deferred|not yet|will (?:ship|land)/i.test(line)) continue; // roadmap framing is legal
        record(
          "OCR-OFFLINE-GUARD-MISSING",
          file,
          i + 1,
          line.trim().slice(0, 140),
          `Doc claims an ENFORCED offline-OCR guarantee but the code guard is incomplete: ${missing.join("; ")}. Either restore the guard(s) OR phrase the claim as a roadmap target.`
        );
      }
    }
  }
}

// ─── Check 4f: embeddings/reranker serve-offline claim vs actual code-guard ──
// v3.10.0-rc.42 (audit F1, HIGH) — same "claimed-guarantee vs code-guard" class as
// Check 4e (OCR), applied to the embeddings + reranker model-load path. Docs claim
// serve makes "zero cloud calls during serve" / "zero outbound network calls during
// serve". That is only TRUE if (1) src/embeddings.ts sets transformers.js
// `allowRemoteModels = false` under an offline flag (so a cache-miss fails closed
// instead of CDN-fetching), and (2) src/cli.ts calls setEmbeddingsOffline() in BOTH
// the serve and serve-http actions. If a doc makes the enforced claim but a guard is
// missing, fail — the exact gap that shipped as the rc.41 overclaim before rc.42.
{
  const embSrc = readLines("src/embeddings.ts").join("\n");
  const cliSrc = readLines("src/cli.ts").join("\n");
  const remoteOff = /allowRemoteModels\s*=\s*false/.test(embSrc);
  const setterExported = /export function setEmbeddingsOffline\b/.test(embSrc);
  const serveCalls = (cliSrc.match(/setEmbeddingsOffline\s*\(/g) || []).length;
  if (!(remoteOff && setterExported && serveCalls >= 2)) {
    const missing = [
      !remoteOff && "src/embeddings.ts must set transformers `allowRemoteModels = false` under the offline flag",
      !setterExported && "src/embeddings.ts must export setEmbeddingsOffline()",
      serveCalls < 2 && `src/cli.ts must call setEmbeddingsOffline() in BOTH serve + serve-http (found ${serveCalls})`
    ].filter(Boolean);
    const claimFiles = ["SECURITY.md", "README.md", "docs/COMPARISON.md", "llms.txt"];
    const claimRe = /zero cloud calls during serve|zero outbound network calls during serve/i;
    for (const file of claimFiles) {
      const lines = readLines(file);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        if (!claimRe.test(line)) continue;
        if (/roadmap|planned|deferred|not yet|will (?:ship|land)/i.test(line)) continue;
        record(
          "EMBED-OFFLINE-GUARD-MISSING",
          file,
          i + 1,
          line.trim().slice(0, 140),
          `Doc claims an ENFORCED "zero cloud calls during serve" guarantee but the code guard is incomplete: ${missing.join("; ")}. Either restore the guard(s) OR phrase the claim as actual default behavior.`
        );
      }
    }
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
//
// IMPORTANT (v3.8.0-rc.18 S-AUDIT-3, self-audit on rc.17):
// On dirty dev trees with STALE coverage-summary.json (e.g. from a
// previous run before the watcher uplift), this check fires a
// false-positive STALE-COVERAGE-COMMENT finding even when the floor is
// still met. Workflow: ALWAYS run `npm run test:coverage` IMMEDIATELY
// BEFORE `npm run check:oia` so the summary.json reflects current code.
// CI's `coverage` job runs before the `oia` job — fine in CI. For local
// dev, the recommended sequence is:
//   npm run test:coverage && npm run check:oia
// This script does NOT auto-run test:coverage to keep the check fast in
// CI (where coverage already ran) and to avoid masking the staleness
// signal — surfaced explicitly in the error message for clarity.
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
      // Pattern: "src/foo.ts": { branches: N [, lines: M ...] }, // current [branches ]X% [...rest]
      // v3.9.0-rc.24 — broadened from single-key `{ branches: N }` + `// current X%`:
      // rc.23 added two-key floors (`{ branches, lines }`) + a `// current branches X% / lines Y%`
      // comment, which the old regex silently dropped from drift-checking (the very gap this
      // check exists to prevent). Now tolerates extra floor keys + an optional `branches ` word
      // before the percent; still extracts the BRANCHES percent for the drift comparison.
      const lineRe =
        /"(src\/[\w./-]+)":\s*\{\s*branches:\s*\d+[^}]*\}\s*,?\s*\/\/\s*current\s*(?:branches\s*)?~?(\d+(?:\.\d+)?)%/;
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

// ─── Check 7: STALE CURRENT-STATE VERSION CLAIMS in docs/ + CLAUDE.md ──
//
// Background: v3.8.2 (state-driven audit) found 6 stale-version refs
// in CLAUDE.md + docs/api.md + docs/COMPARISON.md that survived the
// v3.6.0→v3.8.1 cascade. They survived because Check 1 only walks
// src/*.ts file headers — never visits docs/*.md or CLAUDE.md.
//
// This is the same recursion meta-class: my methodology defines a
// structural defense (Check 1) but applies it only to ONE surface,
// leaving sibling surfaces (docs/) unprotected. The fix is the same
// shape as M-1 (lift to cli-help.ts) and M-2 (extend docs-consistency):
// generalize the existing defense to cover all sibling surfaces.
//
// Pattern strategy: match phrases that pair a VERSION with a
// CURRENT-STATE VERB ("is", "ships", "stable", "covers", "accurate as
// of", "exact for", "@latest on npm ships"). Compare the matched version
// against current major.minor. Skip if explicit historical contextualization
// is present ("initial", "from", "Pre-", "since", "added in").
//
// Cf. v3.6.4 rule on tombstone vs current-claim semantics.
const currentMajorMinor = currentVersion.replace(/^(\d+\.\d+).*$/, "$1");

// Each tuple: [regex (must capture version in group 1), human-readable claim type]
const DOC_CURRENT_STATE_PATTERNS = [
  // "stable v3.X.x" or "stable v3.X.0" — claim of stability for that line
  [/\bstable\s+v?(\d+\.\d+)\.[\dx]/i, "stable version claim"],
  // "@latest on npm ... v3.X.x" or "ships v3.X.x" — current npm channel claim
  [/(?:@latest|ships)\s+v?(\d+\.\d+)\.[\dx]/i, "npm @latest claim"],
  // "covers the v3.X.x stable surface" — scope claim
  [/covers\s+the\s+\*?\*?v?(\d+\.\d+)\.[\dx]/i, "coverage scope claim"],
  // "exact for v3.X.x" — claim of current accuracy
  [/exact\s+for\s+v?(\d+\.\d+)\.[\dx]/i, "exactness claim"],
  // "(accurate|capabilities|claims|features|snapshot) as of v3.X.Y" — accuracy
  // timestamp claim. v3.8.4 broadened from just "accurate as of" after B-1
  // ("capabilities as of v3.7.0" in README.md) slipped past the narrower pattern.
  [/\b(?:accurate|capabilities|claims|features|snapshot)\s+as\s+of\s+v?(\d+\.\d+\.\d+)/i, "as-of timestamp claim"]
];

// "(wait for|coming in|planned for|will land in) v3.X.0" — forthcoming-feature
// claim. If current major.minor >= claimed, the claim is stale (the feature
// already shipped or was deferred). v3.8.4 added this after B-2 ("wait for
// v3.8.0 which adds full serve-http flag parity" in examples/chatgpt-actions.md
// when v3.8.0 already shipped).
const DOC_FORTHCOMING_PATTERN = /(?:wait\s+for|coming\s+in|planned\s+for|will\s+land\s+in)\s+v?(\d+\.\d+)\.\d/i;

/** Compare two major.minor versions. Returns -1 if a<b, 0 if equal, 1 if a>b. */
function cmpMajorMinor(a, b) {
  const [aMa, aMi] = a.split(".").map(Number);
  const [bMa, bMi] = b.split(".").map(Number);
  if (aMa !== bMa) return aMa < bMa ? -1 : 1;
  if (aMi !== bMi) return aMi < bMi ? -1 : 1;
  return 0;
}

// Phrases that mark a version reference as INTENTIONAL HISTORY (skip flag).
// Conservative — only obvious history markers.
const HISTORY_CONTEXT_MARKERS = [
  /\binitial\b/i,
  /\bfrom\b.*\bv?\d+\.\d+/i, // "initial v3.7.0 from 2026-..."
  /\bsince\b/i,
  /\bPre-v?\d/i,
  /\b(history|legacy|tombstone|previously|was)\b/i,
  /\bv?\d+\.\d+\.\d+\s+(added|fix|bumped|introduced|deferred|patched|shipped|closed)\b/i
];

// v3.8.4 META-12 — Check 7 scope expanded to ALL user-visible markdown
// surfaces. Pre-v3.8.4 the scope was just CLAUDE.md + docs/*.md, which
// turned out to be the same recursion class the check was built to close:
// defense scoped too narrowly, sibling surfaces (README.md, AGENTS.md,
// examples/*.md, llms.txt) unprotected. v3.8.4 post-merge audit found
// stale "v3.7.0" claim in README.md:185 and "wait for v3.8.0" in
// examples/chatgpt-actions.md:25 — both already-shipped versions, both
// would have been caught if Check 7 walked these files.
const DOCS_FILES_TO_SCAN = ["CLAUDE.md", "README.md", "AGENTS.md", "llms.txt"];
// Walk docs/ for .md files — but skip docs/audits/ since those are by
// definition historical snapshots (auditor reports timestamped at submission).
// Stale version refs in audit reports are accurate history of what was current
// at that time, not stale current-state claims about NOW.
walk("docs", ".md", (file) => {
  if (file.startsWith(join("docs", "audits"))) return;
  DOCS_FILES_TO_SCAN.push(file);
});
// Walk examples/ for .md files — user-visible drop-in config examples;
// stale version claims here mislead users ("wait for v3.8.0" when v3.8.0
// already shipped).
walk("examples", ".md", (file) => {
  DOCS_FILES_TO_SCAN.push(file);
});

for (const docFile of DOCS_FILES_TO_SCAN) {
  const fullPath = join(repoRoot, docFile);
  if (!existsSync(fullPath)) continue;
  const lines = readFileSync(fullPath, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    for (const [pattern, claimType] of DOC_CURRENT_STATE_PATTERNS) {
      const m = pattern.exec(line);
      if (!m) continue;
      const claimedVersion = m[1];
      // Normalize: "3.8" matches current "3.8". For 3-part like "3.8.0",
      // also extract major.minor.
      const claimedMajorMinor = claimedVersion.replace(/^(\d+\.\d+).*$/, "$1");
      if (claimedMajorMinor === currentMajorMinor) continue; // current — OK
      // Skip if line OR surrounding 2 lines have explicit history context.
      const context = lines.slice(Math.max(0, i - 1), Math.min(lines.length, i + 2)).join(" ");
      if (HISTORY_CONTEXT_MARKERS.some((rx) => rx.test(context))) continue;
      record(
        "STALE-DOC-CURRENCY-CLAIM",
        docFile,
        i + 1,
        line.trim().slice(0, 120) + (line.length > 120 ? "…" : ""),
        `${claimType} for v${claimedVersion} but current major.minor is v${currentMajorMinor}. Either update the version, OR prefix with "Pre-vX.Y.Z" / "initial" / "from" / "since" to mark as legitimate historical reference.`
      );
    }
    // Forthcoming-feature claim: "wait for v3.8.0 which adds X". If current
    // major.minor >= claimed, the feature already shipped (or was deferred);
    // either way the "wait for" framing is stale.
    const fm = DOC_FORTHCOMING_PATTERN.exec(line);
    if (fm) {
      const claimedMM = fm[1];
      if (cmpMajorMinor(claimedMM, currentMajorMinor) <= 0) {
        // v3.8.4 self-audit — skip if the matched text is QUOTED in the
        // source (ASCII "..." or backtick `...`). CHANGELOG/CLAUDE.md
        // status sections legitimately quote past stale claims when
        // describing audit history; those are tombstone references, not
        // present-tense assertions. Heuristic: if the match start index
        // is preceded by an opening quote within 80 chars without an
        // intervening close quote, skip.
        const matchStart = fm.index;
        const preceding = line.slice(Math.max(0, matchStart - 80), matchStart);
        const describeRegex =
          /\b(quote|quoted|describing|described as|originally|previously said|retracted|incorrectly|stale claim)\b/i;
        const isQuoted = /["`][^"`]*$/.test(preceding) || describeRegex.test(preceding);
        if (isQuoted) continue;
        record(
          "STALE-FORTHCOMING-CLAIM",
          docFile,
          i + 1,
          line.trim().slice(0, 120) + (line.length > 120 ? "…" : ""),
          `Forthcoming-feature claim for v${claimedMM} but current is v${currentMajorMinor} (already shipped or past that version). Either remove the "wait for" framing, OR rephrase as "as of v${claimedMM}, X works" if the feature shipped.`
        );
      }
    }
    // v3.9.0-rc.12 — RC-LEVEL currency drift. The major.minor patterns above
    // treat "v3.9.0-rc.3" as current (3.9 == 3.9), so a pinned "currently
    // v3.9.0-rc.N" / "as of v3.9.0-rc.N" / "still valid as of v3.9.0-rc.N"
    // silently goes stale every RC (the audit found 3 such instances). Match
    // the FULL rc-pinned version and compare to the EXACT current version.
    // Prefer version-agnostic phrasing ("the @rc dist-tag carries the latest
    // RC — see CHANGELOG"); if a doc DOES pin an RC it must be the current one.
    // Match only UNAMBIGUOUS currency phrasings — "currently vX" / "still
    // valid as of vX" / "valid as of vX". Bare "as of vX, <feature> ships" is
    // a SINCE/history claim (e.g. "As of v3.6.0-rc.4, benchmarks ship"), not a
    // currency claim, so it's excluded.
    const rcm = /\b(?:currently|(?:still\s+)?valid\s+as\s+of)\s+`?v?(\d+\.\d+\.\d+-rc\.\d+)`?/i.exec(line);
    if (rcm) {
      const claimedFull = rcm[1];
      // Tight tombstone skip: only when the RC version is IMMEDIATELY followed
      // by a history verb (e.g. "v3.9.0-rc.6 shipped"). The broad
      // HISTORY_CONTEXT_MARKERS skip is wrong here — it false-negatives on
      // lines that merely mention an unrelated older version nearby (e.g.
      // "stable since v3.8.x ... currently v3.9.0-rc.3").
      const after = line.slice(rcm.index + rcm[0].length, rcm.index + rcm[0].length + 24);
      const isTombstone = /^\s*(?:added|fixed?|shipped|closed|introduced|deferred|patched|bumped|retracted)\b/i.test(
        after
      );
      if (claimedFull !== currentVersion && !isTombstone) {
        record(
          "STALE-RC-CURRENCY-CLAIM",
          docFile,
          i + 1,
          line.trim().slice(0, 120) + (line.length > 120 ? "…" : ""),
          `Pins RC-currency to v${claimedFull} but the current version is v${currentVersion}. RC-pinned currency drifts every release — prefer version-agnostic phrasing (e.g. "the @rc dist-tag carries the latest RC — see CHANGELOG"), or update to the current version.`
        );
      }
    }
  }
}

// ─── Check 8: SCOPE-COMPLETENESS for structural defenses ───────────────
// v3.8.8 META — for every existing numeric-claim defense in
// `tests/docs-consistency.test.ts`, sweep the entire repo for the
// pattern and report any file containing it that's not in the
// defense's scope or exempts list. The audit script
// `scripts/scope-completeness-audit.mjs` owns the DEFENSES manifest;
// this OIA check is a thin wrapper that calls into it so a gap is
// surfaced by both `npm run check:oia` and the matching
// `tests/scope-completeness-invariant.test.ts`.
//
// Rationale: the recursion-pair shape pattern (6 documented instances
// across v3.6.x→v3.8.x) keeps recurring because each new structural
// defense is narrower than the problem class. Catching gaps in BOTH
// OIA (state-driven sweep) and the invariant test (change-driven gate)
// makes the recursion structurally impossible: a new doc file with an
// uncovered numeric claim fails CI immediately, regardless of whether
// the author ran the test locally.
{
  const { runAudit } = await import("./scope-completeness-audit.mjs");
  for (const f of runAudit()) {
    record(
      "SCOPE-COMPLETENESS-GAP",
      join(repoRoot, f.file),
      f.line,
      f.evidence,
      `Defense '${f.defense}' missing coverage. Either (a) extend tests/docs-consistency.test.ts ` +
        `to cover this file, then add it to DEFENSES['${f.defense}'].scope in ` +
        `scripts/scope-completeness-audit.mjs, OR (b) add the file to ` +
        `DEFENSES['${f.defense}'].exempts with reasoning. ${f.rationale}`
    );
  }
}

// ─── Check 9: GitHub Actions must be SHA-pinned (supply-chain) ─────────
// v3.9.0-rc.14 — a floating action tag (`uses: org/action@v3` or `@main`) can
// be silently retagged to malicious code; SHA-pinning to a 40-hex commit (with
// a `# vN` comment for humans + Dependabot) is the OpenSSF "Pinned-Dependencies"
// best practice and matches this project's supply-chain brand (SLSA L2 +
// provenance). Flags any third-party action ref NOT pinned to a commit SHA.
// Local reusable refs (`./.github/...`) and already-pinned `@<40hex>` pass.
{
  const wfDir = ".github/workflows";
  if (existsSync(join(repoRoot, wfDir))) {
    for (const wf of readdirSync(join(repoRoot, wfDir)).filter((f) => f.endsWith(".yml"))) {
      const rel = join(wfDir, wf);
      const lines = readLines(rel);
      for (let i = 0; i < lines.length; i++) {
        const m = /uses:\s*([^\s@]+)@([^\s#]+)/.exec(lines[i] ?? "");
        if (!m) continue;
        const ref = m[1];
        const ver = m[2];
        if (ref.startsWith("./")) continue; // local reusable workflow — no pin needed
        if (/^[0-9a-f]{40}$/.test(ver)) continue; // already SHA-pinned
        record(
          "ACTION-NOT-SHA-PINNED",
          rel,
          i + 1,
          (lines[i] ?? "").trim().slice(0, 100),
          `GitHub Action '${ref}@${ver}' uses a floating tag, not a commit SHA — supply-chain risk (a tag can be moved to malicious code). Pin to the full 40-char commit SHA with a trailing '# ${ver}' comment (resolve via: gh api repos/${ref}/commits/${ver} --jq .sha).`
        );
      }
    }
  }
}

// ─── Check 9b: workflow `run:` downloads — tag-pinned AND SHA256-verified ─────
// v3.9.1 (audit M-9 class) — Check 9 SHA-pins `uses:` action refs, but a binary
// fetched inside a `run:` block via `curl`/`wget` from a moving `releases/latest`
// URL is the SAME supply-chain risk on a DIFFERENT syntactic surface (the exact
// shape of M-9: `mcp-publisher` was downloaded from `releases/latest` until rc.33
// pinned it to the `v1.7.9` tag). Flags any non-comment `curl`/`wget` line whose
// URL contains `releases/latest` (or `releases/download/latest`). A version- or
// var-pinned asset (`releases/download/${TAG}` / `releases/download/v1.2.3/`)
// passes the URL check — pinning is the remediation, exactly like Check 9.
// v3.10.0-rc.26 (SYS-1 / M-9 completion) — a tag-pin is NOT immutable (a tag can
// be force-moved, a release asset re-uploaded), so a tag-pinned release ARCHIVE
// (`releases/download/<tag>/…\.tar.gz|.tgz|.zip`) ALSO requires a SHA256
// verification (`sha256sum -c` / `shasum -a 256 -c`) somewhere in the same
// workflow file — content-pin, the strongest form. Comment lines that merely
// MENTION `releases/latest` (e.g. release.yml's "PINNED … (not releases/latest)"
// note) are skipped so the guard can't flag its own rationale.
{
  const wfDir = ".github/workflows";
  if (existsSync(join(repoRoot, wfDir))) {
    for (const wf of readdirSync(join(repoRoot, wfDir)).filter((f) => f.endsWith(".yml"))) {
      const rel = join(wfDir, wf);
      const lines = readLines(rel);
      // A SHA256 verification anywhere in the file (`sha256sum -c` / `shasum -a
      // 256 -c`) — content-pin proof a tag-pinned archive download must carry.
      const hasChecksumVerify = lines.some(
        (l) => !/^\s*#/.test(l) && (/\bsha256sum\b[^|]*-c\b/.test(l) || /\bshasum\b[^|]*-a\s*256[^|]*-c\b/.test(l))
      );
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        if (/^\s*#/.test(line)) continue; // YAML comment — not an executed download
        if (!/\b(curl|wget)\b/.test(line)) continue; // only download commands
        if (/releases\/(latest|download\/latest)\b/.test(line)) {
          record(
            "RUN-DOWNLOAD-UNPINNED",
            rel,
            i + 1,
            line.trim().slice(0, 120),
            "A `run:` download pulls from a moving `releases/latest` URL — supply-chain risk (the asset can change under a fixed URL). Pin to an exact release tag or version (`releases/download/<tag>/…`), mirroring the rc.33 mcp-publisher fix + Check 9's `uses:` SHA-pin policy."
          );
          continue;
        }
        // v3.10.0-rc.26 — a tag-pinned release archive is still mutable; require a
        // SHA256 verification in the same file (content-pin).
        if (/\breleases\/download\//.test(line) && /\.(tar\.gz|tgz|zip)\b/.test(line) && !hasChecksumVerify) {
          record(
            "RUN-DOWNLOAD-UNVERIFIED",
            rel,
            i + 1,
            line.trim().slice(0, 120),
            'A `run:` release-archive download is tag-pinned but not SHA256-verified — a tag can be force-moved / a release asset re-uploaded. Content-pin it: download to a file, then `echo "<sha256>  <file>" | sha256sum -c -` before extracting/executing (see release.yml\'s mcp-publisher block, rc.26).'
          );
        }
      }
    }
  }
}

// ─── Check 10: workflow `npm ci` steps must be retry-wrapped ──────────
// v3.9.0-rc.20 — a bare `- run: npm ci` fails the whole job on a transient
// network blip: the onnxruntime-node postinstall fetches its native binary
// from a CDN that intermittently ETIMEDOUTs (hit rc.9, then FAILED the rc.19
// release at the assert-CI gate). Every `npm ci` must run inside a retry loop
// (`run: |` + `for n in 1 2 3; do npm ci && break; … sleep 15; done`). Flags
// any line that is exactly a bare `- run: npm ci` (dependency-free guard — no
// new action to SHA-pin, unlike a marketplace retry action).
{
  const wfDir = ".github/workflows";
  if (existsSync(join(repoRoot, wfDir))) {
    for (const wf of readdirSync(join(repoRoot, wfDir)).filter((f) => f.endsWith(".yml"))) {
      const rel = join(wfDir, wf);
      const lines = readLines(rel);
      for (let i = 0; i < lines.length; i++) {
        if (/^\s*-\s*run:\s*npm ci\s*$/.test(lines[i] ?? "")) {
          record(
            "NPM-CI-NOT-RETRY-WRAPPED",
            rel,
            i + 1,
            (lines[i] ?? "").trim(),
            "Bare `npm ci` fails the job on a transient CDN blip (onnxruntime-node postinstall ETIMEDOUT — hit rc.9 + failed the rc.19 release). Wrap in a retry loop: `run: |` then `for n in 1 2 3; do npm ci && break; [ $n -eq 3 ] && exit 1; sleep 15; done`."
          );
        }
      }
    }
  }
}

// ─── Check 11: MCP Registry version must not drift behind npm @latest ────
// v3.9.0-rc.32 (NETWORK, skipped under --skip-network) — the canonical MCP
// Registry (registry.modelcontextprotocol.io) is what Glama / mcp.so /
// smithery auto-sync from, so a stale registry entry silently propagates an
// outdated "current version" across the whole directory ecosystem. Pre-rc.32
// the registry was published manually after each stable and fell ~7 versions
// behind (stuck at 3.8.4 while npm @latest was 3.8.8). rc.32 automates the
// publish via OIDC in release.yml (stable-only); this check is the state-driven
// backstop that surfaces drift if that automation ever regresses. Compares the
// registry's isLatest version to npm's `latest` dist-tag; flags a mismatch.
// Skips cleanly offline / on infra failure (Part-A checks are the always-on guard).
if (!SKIP_NETWORK) {
  try {
    const { execSync } = await import("node:child_process");
    const npmLatest = execSync("npm view @oomkapwn/enquire-mcp dist-tags.latest 2>/dev/null", {
      encoding: "utf8",
      timeout: 10_000
    }).trim();
    const regJson = execSync(
      'curl -fsSL --max-time 12 "https://registry.modelcontextprotocol.io/v0/servers?search=io.github.oomkapwn/enquire-mcp" 2>/dev/null',
      { encoding: "utf8", timeout: 15_000 }
    );
    if (npmLatest && regJson && regJson.trim().length > 0) {
      const parsed = JSON.parse(regJson);
      const servers = parsed.servers ?? [];
      // The registry returns all published versions; find the one flagged
      // isLatest (the official-registry metadata block carries the flag).
      let regLatest = null;
      for (const entry of servers) {
        const sv = entry.server ?? entry;
        const meta = entry._meta?.["io.modelcontextprotocol.registry/official"] ?? entry._meta ?? {};
        if (meta.isLatest === true || sv.isLatest === true) regLatest = sv.version ?? meta.version ?? null;
      }
      // ADVISORY, not a hard finding: when the registry trails npm @latest we
      // print a visible warning but do NOT exit 1. Remediation (re-publish to
      // the registry) is maintainer-gated — it runs only on a STABLE tag via
      // the OIDC step in release.yml, or a manual `mcp-publisher login`. A PR
      // author cannot fix registry state inside their PR, so hard-failing the
      // `oia` gate on it would block unrelated work. (Same principle as the
      // SLSA network check skipping on infra it doesn't control.) The advisory
      // keeps the drift visible; the OIDC automation is the actual fix.
      if (regLatest && regLatest !== npmLatest) {
        console.error(
          `[oia-walk] ADVISORY — MCP-REGISTRY-VERSION-DRIFT: registry isLatest=${regLatest} but npm @latest=${npmLatest}. ` +
            "The canonical registry (Glama/mcp.so/smithery auto-sync from it) trails npm. " +
            "Stable releases auto-publish via OIDC (release.yml, v3.9.0-rc.32); to reconcile now, re-run the release workflow on the latest stable tag or `mcp-publisher login github-oidc && mcp-publisher publish`. Non-fatal (maintainer-gated remediation)."
        );
      }
    }
  } catch (err) {
    console.error(
      `[oia-walk] MCP-REGISTRY-VERSION-DRIFT network check skipped: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

// ─── Check 12: scripts must not import the pre-split `dist/tools.js` ──────
// v3.9.0-rc.35 (external-audit L-3) — `tools.ts` was split into a `tools/`
// directory; TypeScript now emits `dist/tools/index.js`, NOT `dist/tools.js`.
// `scripts/bench.mjs` + `bench-search.mjs` kept the old `../dist/tools.js`
// import, which only "resolved" locally because a STALE pre-split
// `dist/tools.js` lingered in the gitignored `dist/` — on a clean build it
// breaks. CI never runs these (only `bench:retrieval`), so it stayed hidden.
// Flag any `from "...dist/tools.js"` import in scripts/ so the directory-vs-
// file trap can't recur silently. (Dependency-free; reads scripts/*.mjs.)
{
  const scriptsDir = "scripts";
  if (existsSync(join(repoRoot, scriptsDir))) {
    for (const f of readdirSync(join(repoRoot, scriptsDir)).filter((n) => n.endsWith(".mjs"))) {
      const rel = join(scriptsDir, f);
      const lines = readLines(rel);
      for (let i = 0; i < lines.length; i++) {
        if (/from\s+["'][^"']*\/dist\/tools\.js["']/.test(lines[i] ?? "")) {
          record(
            "STALE-DIST-TOOLS-IMPORT",
            rel,
            i + 1,
            (lines[i] ?? "").trim(),
            "Imports `../dist/tools.js`, which TypeScript no longer emits (the source is `tools/` → `dist/tools/index.js`). This only resolves if a stale pre-split `dist/tools.js` lingers; on a clean build it breaks. Change the import to `../dist/tools/index.js`."
          );
        }
      }
    }
  }
}

// ─── Check 12b: no orphan dist artifacts (the L-3 class ROOT CAUSE) ───────
// v3.9.0-rc.36 — Check 12 caught the stale *import string*; this catches the
// stale *file*. After `src/tools.ts` was split into `src/tools/`, TypeScript
// emits `dist/tools/index.js` and NO LONGER emits `dist/tools.js` — but a
// `tsc` that doesn't first purge dist/ leaves the 6-week-old pre-split
// `dist/tools.{js,d.ts}` (+ maps) behind, and `files:["dist"]` SHIPS them to
// npm (~309 KB of stale code/types, confirmed via `npm pack --dry-run`). The
// real fix is `build: rm -rf dist && tsc` (package.json); this check is the
// state-driven tripwire that fails a local pre-ship `check:oia` if a stale
// dist lingers. TS emit is FLAT 1:1: `dist/<p>.js` ⇔ `src/<p>.ts` (a *file*),
// and a directory `src/<p>/` emits `dist/<p>/index.js`, never `dist/<p>.js` —
// so a `src/<p>/` directory must NOT satisfy `dist/<p>.js` (that exact
// false-negative bit my first probe; mirrors the rc.24 "analyze the right
// semantic space" rule). Skips entirely when dist/ is absent — the CI oia job
// deliberately does not build (it only greps source + docs), so this protects
// the maintainer's local pre-ship run + the published tarball, not CI itself.
{
  const distRoot = join(repoRoot, "dist");
  if (existsSync(distRoot)) {
    /** Recursively collect every file under dist/ (relative to dist/). */
    const walkDist = (dir, prefix = "") => {
      const out = [];
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory()) out.push(...walkDist(join(dir, e.name), rel));
        else out.push(rel);
      }
      return out;
    };
    for (const rel of walkDist(distRoot)) {
      // Map an emitted artifact back to its source stem. Order matters:
      // `.d.ts.map` and `.js.map` must be tested before `.d.ts`/`.js`.
      let stem = null;
      if (rel.endsWith(".d.ts.map")) stem = rel.slice(0, -".d.ts.map".length);
      else if (rel.endsWith(".js.map")) stem = rel.slice(0, -".js.map".length);
      else if (rel.endsWith(".d.ts")) stem = rel.slice(0, -".d.ts".length);
      else if (rel.endsWith(".js")) stem = rel.slice(0, -".js".length);
      if (stem === null) continue; // non-emit asset (rare); not our concern
      // FLAT rule — NO directory fallback. `dist/tools.js` ⇒ `src/tools.ts`.
      if (!existsSync(join(repoRoot, "src", `${stem}.ts`))) {
        record(
          "ORPHAN-DIST-FILE",
          `dist/${rel}`,
          1,
          `dist/${rel} has no backing src/${stem}.ts`,
          'Stale build artifact with no source — TypeScript no longer emits it (likely a pre-rename/pre-split leftover). It SHIPS to npm via `files:["dist"]`. Run `npm run clean && npm run build` to purge dist/ and rebuild; `build`/`prepublishOnly` now `rm -rf dist` first so a clean build cannot reproduce this.'
        );
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
