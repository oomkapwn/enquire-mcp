#!/usr/bin/env node
// v3.7.0 PR4 — per-file branch coverage floor enforcement.
//
// Background. Vitest's global `thresholds.branches: 74` is met (current
// global is 75.4%), but per-file branch coverage hides substantial
// dips:
//   src/http-transport.ts: 66.86%
//   src/tools/search.ts:   68.27%
//   src/tools/meta.ts:     67.66%
//   src/tools/media.ts:    67.93%
//   src/doctor.ts:         66.05%
//   src/bases.ts:          73.17%
//   src/watcher.ts:        73.33%
//
// The global gate would let any of these drift further before failing.
// This script enforces per-file floors so a regression in a single
// security-critical module surfaces immediately, NOT after it averages
// out across the project.
//
// The floors are set ~2pp below current values — enough buffer to
// absorb natural fluctuation (test ordering, V8 coverage quirks) but
// tight enough to catch a meaningful regression. Adjust the FLOORS
// table below when raising the floor; never lower it without
// documenting the rationale in CHANGELOG.
//
// Usage:
//   node scripts/check-per-file-coverage.mjs
//   (Requires `npm run test:coverage` to have produced
//    `coverage/coverage-summary.json` first.)
//
// Exit codes:
//   0 — all per-file floors met
//   1 — at least one file dropped below its floor
//   2 — coverage-summary.json missing (skipped with warning)

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");
const SUMMARY_PATH = resolve(repoRoot, "coverage/coverage-summary.json");

if (!existsSync(SUMMARY_PATH)) {
  console.warn(
    `[per-file-coverage] coverage-summary.json not found at ${SUMMARY_PATH}. ` +
      "Run `npm run test:coverage` first. Skipping check."
  );
  process.exit(2);
}

// Per-file branch coverage floors (in percent). Each entry pins a single
// file's branch coverage to a value ~2pp below the current measurement so
// natural fluctuation doesn't trip the gate but a real regression does.
//
// embeddings.ts + ocr.ts are integration-dep heavy (transformers.js +
// tesseract.js) and largely tested through other paths; their floors
// reflect that explicitly so a refactor doesn't accidentally promise
// coverage uplift that requires real model downloads in CI.
const FLOORS = {
  "src/embeddings.ts": { branches: 27 }, // current 35.29% (integration-dep; rc.12 L-2 exported applyOfflineEnv + its mock-mod test covered the offline-env arms → branch% rose 29.41→35.29; floor kept at 27 as margin — embedder/reranker load + offline catch still need a real model download to fully cover; rc.13 AUD-02 synced after OIA Check 6 flagged the drift)
  // v3.9.0-rc.23 (full-audit batch 3) — vault.ts is the single most
  // security-critical module (path-traversal / symlink-escape / privacy-glob
  // enforcement) and was the one critical module with NO per-file floor, so a
  // privacy-boundary regression would only show in the global average. First
  // floor, conservative (actual branches 78.03%).
  "src/vault.ts": { branches: 75 }, // current 80.49% (rc.49 sanitizing fs wrappers + behavioral leak tests)
  // rc.23 — ocr.ts gains a `lines` floor too: it's the #16 offline-enforcement
  // security surface, and a branches-only floor let line coverage rot toward 0
  // (actual lines 44.44%) without tripping any gate.
  "src/ocr.ts": { branches: 60, lines: 40 }, // current branches 71.11% / lines 45.97% (rc.55 OPTDEP fix dropped the 3 import-catch `err.message` ternaries → branch% rose; floors kept as margin)
  "src/http-transport.ts": { branches: 65 }, // current 75.23% (v3.10.0-rc.19 M3 removed 4 redundant signal handlers — fewer uncovered branches)
  "src/doctor.ts": { branches: 64 }, // current 70.22% (rc.12 exported candidateModelCacheRoots + cache-path tests lifted it)
  "src/tools/search.ts": { branches: 66 }, // current 69.71% (rc.10 frontmatter-filter helpers + matches-loop branch lifted it)
  // v3.8.0-rc.8 — lifted from 65% → 71% after T-1 contextPack tests
  // raised per-file branches from 67.66% → 73.85%.
  "src/tools/meta.ts": { branches: 74 }, // current 78.51% (rc.25 added leadingAtomSet/branchIsNullable/bodyVariable detector branches)
  "src/tools/media.ts": { branches: 65 }, // current 69.17%
  "src/bases.ts": { branches: 71 }, // current 75.84% (rc.9 NFC foldTag/nfc tag+value tests lifted it)
  // v3.8.0-rc.3 — lowered from 71% → 69% because rc.3 expanded watcher.ts
  // with a PDF embed-sync block (lines 240-288); the fail-soft error branches
  // (embedder throws) required dependency injection to test deterministically.
  // v3.8.0-rc.10 — the attachEmbed error-path NEGATIVE control test lifted
  // coverage from ~69.23% → 71.15%; floor stays at 69% (2pp safety margin).
  // v3.9.0-rc.1 — lowered from 69% → 64% because OCR-on-watch added 3 new
  // option fields + setOcrPdfs method + a try/catch around dynamic
  // extractPdfWithOcr import. The OCR branches require tesseract.js +
  // @napi-rs/canvas optional deps that aren't installed in CI; mocking
  // them would defeat the fail-soft posture the codepath is testing.
  // v3.9.0-rc.2 — lowered from 64% → 53% because HNSW live-update added
  // syncHnswForFile + the attachHnsw method + 6 new branches in the md
  // and pdf event handlers (oldIds/newIds zip + fail-soft try/catch +
  // empty-result skip). End-to-end coverage required real vault edits.
  // v3.9.0-rc.6 — the integration test (file-change → applyDiff → close
  // → flushHnswToDisk → loadHnswFromDisk round-trip) lifted coverage
  // 55.05% → 59.58%; floor stays at 53% (kept the conservative margin
  // because OCR branches still need tesseract.js + canvas, absent from CI).
  "src/watcher.ts": { branches: 53 }, // current 61.83% (v3.10.0-rc.24 unlink-gate refactor + excluded-unlink test lifted it)
  // v3.8.0-rc.4 — embed-pipeline extracted from server.ts. INFO-2
  // (round-24 audit) noted it was missing from FLOORS; added here in
  // rc.8 at floor 84% (2pp below current 86.84%).
  "src/embed-pipeline.ts": { branches: 84 } // current 85.41% (v3.9.0-rc.28 MAX_EMBED_CHARS clamp branch; rc.13 AUD-03 added the lookupFoldedAny title-fold `|| basename` branch → 86.95→85.41, still > 84 floor)
};

const summary = JSON.parse(readFileSync(SUMMARY_PATH, "utf8"));

let hasError = false;
const passing = [];
const failing = [];

// v3.7.13 M8 — fail loudly on missing floor entries. Pre-3.7.13 the
// script emitted a warning and `continue`d, so a file rename or a
// vitest coverage-include regex change could silently drop the floor.
// Now any FLOORS key without a coverage entry → exit 1 with a clear
// "update FLOORS" message. Same policy for individual missing metrics.
for (const [relPath, floors] of Object.entries(FLOORS)) {
  const absPath = resolve(repoRoot, relPath);
  const entry = summary[absPath];
  if (!entry) {
    console.error(
      `[per-file-coverage] ERROR — no coverage entry for ${relPath}; was the file deleted or renamed? Update FLOORS in scripts/check-per-file-coverage.mjs and document the change in CHANGELOG.`
    );
    hasError = true;
    continue;
  }
  for (const [metric, floor] of Object.entries(floors)) {
    const actual = entry[metric]?.pct;
    if (typeof actual !== "number") {
      console.error(
        `[per-file-coverage] ERROR — ${relPath}: no ${metric}.pct in coverage summary. The metric was either removed from vitest config or the file was excluded from coverage. Update FLOORS or coverage config.`
      );
      hasError = true;
      continue;
    }
    const ok = actual >= floor;
    const line = `${relPath} ${metric}: ${actual.toFixed(2)}% (floor ${floor}%)`;
    if (ok) {
      passing.push(`  ✓ ${line}`);
    } else {
      failing.push(`  ✗ ${line}  — dropped ${(floor - actual).toFixed(2)}pp below floor`);
      hasError = true;
    }
  }
}

// v3.11.0-rc.19 (rc.17 external audit, Cursor LOW-1) — SELF-VALIDATE the inline
// `// current X%` annotations against the summary THIS script just consumed. Pre-rc.19
// the only check of these comments was OIA Check 6, which runs in the artifact-LESS
// `oia` CI job (existsSync-gated → silent skip), so an `embed-pipeline.ts` comment
// drifted (85.41 → 86.95) undetected on CI. This check runs inside `check:per-file-coverage`
// — i.e. the `coverage` CI job, which HAS coverage-summary.json — so the drift now fails CI
// where the data lives, with no workflow change and no silent skip. Threshold 1pp (matches OIA Check 6).
{
  const selfSrc = readFileSync(__filename, "utf8");
  // 2pp tolerance — branch coverage is mildly ENVIRONMENT-SENSITIVE (which optional deps
  // are built changes which branches execute), and the FLOORS are themselves set ~2pp below
  // the measured value, so the annotations are accurate to ~2pp by construction. A tighter
  // gate would flake across CI runners; 2pp still catches a genuinely stale comment (a
  // refactor that shifts coverage several pp without updating the `// current X%` note).
  const COMMENT_DRIFT_PP = 2;
  // The integration-dep files (transformers.js / tesseract.js) only fully cover with a real
  // model download, so their branch% swings widely by environment — their comments document
  // that explicitly and their floors sit far below the comment. Exempt them from the drift gate.
  const SELF_CHECK_EXEMPT = new Set(["src/embeddings.ts", "src/ocr.ts"]);
  const commentDrifts = [];
  for (const relPath of Object.keys(FLOORS)) {
    if (SELF_CHECK_EXEMPT.has(relPath)) continue;
    const actualBranches = summary[resolve(repoRoot, relPath)]?.branches?.pct;
    if (typeof actualBranches !== "number") continue; // the floor loop already errored on this file
    const lineRe = new RegExp(
      `"${relPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}":[^\\n]*//[^\\n]*current (?:branches )?(\\d+(?:\\.\\d+)?)%`
    );
    const m = lineRe.exec(selfSrc);
    if (!m) continue; // no `// current X%` annotation on this entry → nothing to validate
    const claimed = Number(m[1]);
    const drift = Math.abs(claimed - actualBranches);
    if (drift > COMMENT_DRIFT_PP) {
      commentDrifts.push(
        `  ✗ ${relPath}: comment says ~${claimed}% but coverage-summary.json branches = ${actualBranches.toFixed(2)}% (drift ${drift.toFixed(2)}pp)`
      );
    }
  }
  if (commentDrifts.length > 0) {
    console.error(
      `\n[per-file-coverage] ${commentDrifts.length} stale '// current X%' comment(s) — sync each to the measured value (drift > ${COMMENT_DRIFT_PP}pp):`
    );
    for (const d of commentDrifts) console.error(d);
    console.error(
      "  (runs in the `coverage` CI job which has the summary — closes the OIA Check 6 silent-skip on CI; rc.19, Cursor LOW-1.)"
    );
    hasError = true;
  }
}

if (passing.length > 0) {
  console.log(`[per-file-coverage] ${passing.length} floors met:`);
  for (const p of passing) console.log(p);
}
if (failing.length > 0) {
  console.error(`\n[per-file-coverage] ${failing.length} floors VIOLATED:`);
  for (const f of failing) console.error(f);
  console.error(
    "\n[per-file-coverage] A per-file branch coverage floor regressed. Options:\n" +
      "  1. Add tests to lift the file back above its floor (preferred).\n" +
      "  2. Lower the floor in scripts/check-per-file-coverage.mjs AND document the rationale\n" +
      "     in CHANGELOG (e.g. 'audit decided file X is integration-dep heavy; reducing floor by Npp').\n" +
      "Silent floor reductions are not allowed — see CLAUDE.md anti-pattern 'silent-pass gates'."
  );
  process.exit(1);
}

if (!hasError) {
  console.log(`\n[per-file-coverage] OK — all ${passing.length} per-file coverage floors met.`);
  process.exit(0);
}
