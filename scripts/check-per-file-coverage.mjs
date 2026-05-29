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
  "src/embeddings.ts": { branches: 28 }, // current 30% (integration-dep)
  // v3.9.0-rc.23 (full-audit batch 3) — vault.ts is the single most
  // security-critical module (path-traversal / symlink-escape / privacy-glob
  // enforcement) and was the one critical module with NO per-file floor, so a
  // privacy-boundary regression would only show in the global average. First
  // floor, conservative (actual branches 78.03%).
  "src/vault.ts": { branches: 75 },
  // rc.23 — ocr.ts gains a `lines` floor too: it's the #16 offline-enforcement
  // security surface, and a branches-only floor let line coverage rot toward 0
  // (actual lines 44.44%) without tripping any gate.
  "src/ocr.ts": { branches: 60, lines: 40 }, // current branches 66.66% / lines 44.44%
  "src/http-transport.ts": { branches: 65 }, // current 72.85% (v3.8.7 P2-10/P2-11 raised branch coverage with 10 new tests)
  "src/doctor.ts": { branches: 64 }, // current 68.99% (rc.16 P2-12 privacy tests lifted it +2.9pp)
  "src/tools/search.ts": { branches: 66 }, // current 68.27%
  // v3.8.0-rc.8 — lifted from 65% → 71% after T-1 contextPack tests
  // raised per-file branches from 67.66% → 73.85%.
  "src/tools/meta.ts": { branches: 74 }, // current 76.43% (rc.21 added alternation-ReDoS detector branches)
  "src/tools/media.ts": { branches: 65 }, // current 67.93%
  "src/bases.ts": { branches: 71 }, // current 74.71% (rc.15 boundedSetAdd tests lifted it +1.5pp)
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
  "src/watcher.ts": { branches: 53 }, // current 60.69% (v3.9.0-rc.11 H1 serialization + zip-guard tests)
  // v3.8.0-rc.4 — embed-pipeline extracted from server.ts. INFO-2
  // (round-24 audit) noted it was missing from FLOORS; added here in
  // rc.8 at floor 84% (2pp below current 86.84%).
  "src/embed-pipeline.ts": { branches: 84 } // current 88.09% (v3.9.0-rc.2 preExtractedPages branches)
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
  console.log(`\n[per-file-coverage] OK — all ${passing.length} per-file branch floors met.`);
  process.exit(0);
}
