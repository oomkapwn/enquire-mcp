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
  "src/ocr.ts": { branches: 22 }, // current 24% (integration-dep)
  "src/http-transport.ts": { branches: 65 }, // current 66.86%
  "src/doctor.ts": { branches: 64 }, // current 66.05%
  "src/tools/search.ts": { branches: 66 }, // current 68.27%
  "src/tools/meta.ts": { branches: 65 }, // current 67.66%
  "src/tools/media.ts": { branches: 65 }, // current 67.93%
  "src/bases.ts": { branches: 71 }, // current 73.17%
  "src/watcher.ts": { branches: 71 } // current 73.33%
};

const summary = JSON.parse(readFileSync(SUMMARY_PATH, "utf8"));

let hasError = false;
const passing = [];
const failing = [];

for (const [relPath, floors] of Object.entries(FLOORS)) {
  const absPath = resolve(repoRoot, relPath);
  const entry = summary[absPath];
  if (!entry) {
    console.warn(
      `[per-file-coverage] WARN — no coverage entry for ${relPath}; was the file deleted or renamed? Update FLOORS in scripts/check-per-file-coverage.mjs.`
    );
    continue;
  }
  for (const [metric, floor] of Object.entries(floors)) {
    const actual = entry[metric]?.pct;
    if (typeof actual !== "number") {
      console.warn(`[per-file-coverage] WARN — ${relPath}: no ${metric}.pct in summary`);
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
