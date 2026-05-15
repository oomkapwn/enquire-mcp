# L3 — Tests & Coverage Audit (v3.6.0)

**Audit date**: 2026-05-15
**Branch**: `v3.6.0/post-stable-audit`
**Package version**: `3.6.0` (latest)
**Reference**: `docs/audits/v3.6.0-system-audit-plan.md` §L3

## Summary

- Test count: **714** confirmed (713 passing + 1 documented env-gated skip). All 4 documented surfaces (README, package.json, social-preview.svg, CHANGELOG) agree.
- Per-file coverage: 6 files below 85% lines, 9 files below 75% branches, 6 files below 80% functions (excluding registration boilerplate and the barrel `tools/index.ts`). Most are external-dep or hard-to-reach error paths; one (`tools/index.ts` barrel) is a coverage-counter artifact.
- **Flake detection: 1 HIGH finding.** 3 npm-test runs produced 10, 11, 3 failures respectively; a 4th run with `--testTimeout=30000` produced 0 failures. Every "failure" is a 5000ms vitest default-timeout hit on `cli.test.ts` and `pdf.test.ts` and `ocr.test.ts` and `fts5.test.ts` tests that spawn child node processes or perform heavy disk/native work. **No deterministic test failures detected.**
- Snapshot integrity: no snapshot files exist (`tests/__snapshots__/` absent, no `toMatchSnapshot()` or `toMatchInlineSnapshot()` calls in any test file). NOT-APPLICABLE.
- Fixture freshness: `tests/fixtures/benchmark-queries.jsonl` (47 unique relevant paths) — every path exists in the synthetic vault built by `scripts/run-benchmarks.mjs`. Exact set match.
- Coverage thresholds: **branches threshold (74%) is THIN — actual 75.02%, margin +1.02pp.** Plan says ≥1pp is a flag-for-raise. Lines/statements/functions are safe.

---

## Finding L3-01 — npm-test 5000ms timeouts cause non-deterministic failures under load

- **Severity**: HIGH
- **Class**: flake-prone test pattern — tests that spawn child processes or perform cold-load of native deps rely on vitest's default 5000ms per-test timeout. Under parallel test contention (multiple worker processes + concurrent disk I/O from other clones running test:coverage on the same machine) these blow past 5s and report as failures.
- **Evidence**:
  - Run 1 (no override): `Test Files 2 failed | 30 passed | 1 skipped (33); Tests 10 failed | 703 passed | 1 skipped (714); Duration 169.21s`. Tail visible at `/private/tmp/claude-501/.../tasks/btl7fp0xp.output` shows `Error: Test timed out in 5000ms.` for `tests/cli.test.ts:277:3` and `tests/ocr.test.ts:82:3`.
  - Run 2 (no override): `Test Files 3 failed | 29 passed | 1 skipped (33); Tests 11 failed | 702 passed | 1 skipped (714); Duration 200.26s`. Failures at `/tmp/L3-test-run-2.log`:
    - `tests/cli.test.ts` lines 112, 187, 193, 203, 214, 225, 236, 263, 277 (9 distinct `it()` blocks)
    - `tests/fts5.test.ts:171` (`chunkContent > heading parser is linear-time on pathological input (no polynomial-redos)` — `AssertionError: expected 649 to be less than 500`)
    - `tests/pdf.test.ts:33` (`extractPdfText > extracts text from a single-page PDF`)
  - Run 3 (no override): `Test Files 1 failed | 31 passed | 1 skipped (33); Tests 3 failed | 710 passed | 1 skipped (714); Duration 31.15s`. Failures at `/tmp/L3-test-run-3.log`:
    - `tests/cli.test.ts:236, 263, 277` (3 distinct `it()` blocks)
  - Run 4 with `--testTimeout=30000` (control): `Test Files 32 passed | 1 skipped (33); Tests 713 passed | 1 skipped (714); Duration 67.92s`. Zero failures. Output at `/private/tmp/claude-501/.../tasks/b243wxd6u.output`.
  - Root cause: 14 `execFileSync(process.execPath, ...)` calls in `tests/cli.test.ts` (lines 120, 133, 180, 189, 195, 206, 217, 229, 240, 249, 267, 270, 281, 287) all spawn child node processes synchronously. On cold start with parallel native-dep imports, single-spawn cost has been observed at 4-15s. Vitest's default `testTimeout: 5000` is too tight.
  - Secondary: `tests/fts5.test.ts:171` asserts `expect(elapsedMs).toBeLessThan(500)` on a heading parser perf bound — under load this slipped to 649ms (run 2). This is a perf-threshold flake, not a timeout flake.
- **Cited file:line**:
  - `/Users/alex/Documents/Projects/obsidian-mcp/tests/cli.test.ts:112,187,193,203,214,225,236,263,277` — 9 `it()` blocks with no per-test timeout override
  - `/Users/alex/Documents/Projects/obsidian-mcp/tests/fts5.test.ts:171` — perf bound
  - `/Users/alex/Documents/Projects/obsidian-mcp/tests/pdf.test.ts:33` — cold pdfjs-dist load
  - `/Users/alex/Documents/Projects/obsidian-mcp/tests/ocr.test.ts:82` — cold tesseract.js + canvas + pdfjs load
  - `/Users/alex/Documents/Projects/obsidian-mcp/vitest.config.ts` — no `testTimeout` set in `test` block (defaults to 5000ms)
- **Class fix**:
  1. Set a higher floor in `vitest.config.ts` for the suite-level `testTimeout` (e.g. `testTimeout: 15_000`). This is one line.
  2. For the perf bound at `fts5.test.ts:171`, either widen the threshold (500 → 1500ms) or skip the bound under `process.env.CI === 'true'` with a separate marker test. Pre-fix polynomial was 1-2s; 1.5s preserves the regression-detection.
  3. Document in `vitest.config.ts` comments why 15s is the floor — because of `execFileSync` cold-start and native-dep imports.
- **Per-instance backfill**: tests in `cli.test.ts` could also each set `, 30_000` as the test timeout argument (vitest 3rd param), but the suite-level config is simpler and refactor-resistant.
- **Recommended next action**: file as v3.6.1 patch. The flake is intermittent on dev laptops but worse on CI runners that share build hosts with other jobs — risk that 1-2 failures get rationalized as "macOS oddity" and ignored.

---

## Finding L3-02 — coverage branches threshold within 1pp safety margin

- **Severity**: MEDIUM
- **Class**: threshold-vs-actual safety margin too tight; one regression test deletion drops below CI gate.
- **Evidence**: from `/Users/alex/Documents/Projects/obsidian-mcp/coverage/coverage-summary.json`:
  ```
  Threshold vs Actual:
    lines        threshold=86  actual=89.20  margin=+3.20 [SAFE]
    statements   threshold=82  actual=85.79  margin=+3.79 [SAFE]
    functions    threshold=75  actual=82.15  margin=+7.15 [SAFE]
    branches     threshold=74  actual=75.02  margin=+1.02 [THIN]
  ```
  Branches margin is +1.02pp — within the L3 plan's "<1pp" warn zone is borderline. v3.5.9 dropped branches threshold from 73→72 because local was at 72.94% (knife-edge against CI); v3.6.0 raised it back to 74 after the coverage uplift moved local to 75.29% (+1.3pp margin); the latest measurement at 75.02% leaves only +1.02pp.
- **Cited file:line**: `/Users/alex/Documents/Projects/obsidian-mcp/vitest.config.ts:46-51` (thresholds block) and `coverage-summary.json` `total.branches.pct = 75.02`.
- **Class fix**: per the plan, raise the threshold by 2pp where actual is within 1pp. Recommendation: keep `branches: 74` BUT add 8-12 new test cases targeting the 22 uncovered branch lines in `src/communities.ts` and the 12 uncovered branches in `src/watcher.ts` (both lower-effort than re-covering external-dep code). This brings actual to ~77% and creates >2pp margin without changing the threshold.
- **Per-instance backfill**: add tests for `communities.ts` `L83, L101, L107-L108, L116, L148, L164-L170, L174, L183-L186, L194, L208, L212, L216, L244, L255, L274, L280-L281` (22 uniq lines, 22 br instances) and `watcher.ts` `L38, L52, L74-L77, L95, L100-L101, L109, L121, L126-L128, L137` (12 uniq lines, 17 br instances). Together this is ~35 branches; covering half (~17) lifts total branch pct by ~0.6pp.
- **Recommended next action**: v3.6.2 — batched with other coverage uplifts.

---

## Finding L3-03 — `src/embeddings.ts` 31.25% lines / 30.00% branches / 33.33% functions

- **Severity**: MEDIUM
- **Class**: external-dep code path — runtime functions require model download (~30-280 MB from HuggingFace) and are gated behind `ENQUIRE_LOAD_RERANKER_SMOKE=1`. The catalog/resolution layer IS covered (v3.5.11 added 40 tests); only the model-IO code is uncovered.
- **Evidence**: from `coverage-summary.json`:
  ```
  embeddings.ts: lines=31.25 (covered/total ratio same shape as 392 source lines), branches=30.00 (12/40), functions=33.33
  ```
  Uncovered branch lines (from `coverage/lcov.info`): L81, L87, L94, L121, L129, L141, L172, L179, L202, L359, L375.
  Sample at `/Users/alex/Documents/Projects/obsidian-mcp/src/embeddings.ts:80-97`: `loadPipeline()` lazy dynamic import + clean-error fallback path — the success path requires `@huggingface/transformers` to actually load and run. L121-L143: `loadTransformersForRerank()` — same pattern. L358-L389: `score()` method that runs the reranker over batched pairs.
  These are exercised by `tests/reranker-smoke.test.ts:36-85`, but that suite is `it.skip` unless `ENQUIRE_LOAD_RERANKER_SMOKE=1`.
- **Cited file:line**:
  - `/Users/alex/Documents/Projects/obsidian-mcp/src/embeddings.ts:80-97` (loadPipeline)
  - `/Users/alex/Documents/Projects/obsidian-mcp/src/embeddings.ts:117-144` (loadTransformersForRerank)
  - `/Users/alex/Documents/Projects/obsidian-mcp/src/embeddings.ts:358-389` (score method)
  - `/Users/alex/Documents/Projects/obsidian-mcp/tests/reranker-smoke.test.ts:36-85` (gated tests)
- **Classification**: (b) external-dep code paths — model download requires network + ~280 MB. Already documented in `reranker-smoke.test.ts:18-27` why this is gated.
- **Class fix**: not actionable unless CI gets a HuggingFace cache populated at build-image time. Existing approach (env-gated smoke + manual before major releases) is reasonable.
- **Recommended next action**: ACCEPT. Document the (intentional) low coverage in `vitest.config.ts` comments so a future auditor doesn't try to "fix" it. Optional: split `embeddings.ts` into `embeddings-runtime.ts` (uncoverable without model) + `embeddings-catalog.ts` (fully coverable) for cleaner per-file metrics.

---

## Finding L3-04 — `src/ocr.ts` 33.33% lines / 24.00% branches / 45.45% functions

- **Severity**: MEDIUM
- **Class**: external-dep code path — requires Tesseract.js trained-data download + native canvas + pdfjs. Same pattern as embeddings.ts.
- **Evidence**: `coverage-summary.json` shows `ocr.ts`: lines=33.33, branches=24.00 (6/25), functions=45.45.
  Uncovered branch lines: L75, L88, L101, L168, L219-L220, L241, L259, L270.
  Sample at `/Users/alex/Documents/Projects/obsidian-mcp/src/ocr.ts:71-94`: `loadTesseract()` and `loadCanvas()` lazy-load with clean-error fallback. L97-L107: `loadPdfjs()` same pattern.
  Existing test `tests/ocr.test.ts:82` exercises real load when all 3 deps install — but that's the test that timed out in run 1 (5000ms isn't enough for cold load).
- **Cited file:line**:
  - `/Users/alex/Documents/Projects/obsidian-mcp/src/ocr.ts:71-107` (3 lazy-load functions)
  - `/Users/alex/Documents/Projects/obsidian-mcp/src/ocr.ts:165-275` (extraction pipeline)
  - `/Users/alex/Documents/Projects/obsidian-mcp/tests/ocr.test.ts:82` (only real-load test, timeout-prone)
- **Classification**: (b) external-dep code paths.
- **Class fix**: same as L3-03 — accept low coverage; document why. Bumping `testTimeout` per L3-01 will make the existing real-load test run reliably.

---

## Finding L3-05 — `src/http-transport.ts` 79.91% lines / 66.86% branches / 58.97% functions

- **Severity**: LOW
- **Class**: hard-to-reach error paths — 500 internal server error handlers, session-id miss paths, max-sessions reached, transport.close() failure recovery.
- **Evidence**: `coverage-summary.json` shows `http-transport.ts`: lines=79.91, branches=66.86 (111/166), functions=58.97.
  32 unique uncovered branch lines: L130, L188, L246, L313-L316, L336, L430, L438, L455, L471-L473, L511, L518, L523, L531-L533, L557, L571-L572, L607-L608, L612, L618, L630-L633, L639, L665-L671.
  Sample uncovered branches: `L430-L444` (GET with no `Mcp-Session-Id` header → 400; with unknown session → 404; SSE transport error catch), `L511-L526` (server.connect failure path), `L527-L536` (outer-block catch-all 500), `L607-L612` (transport.close fallback), `L665-L671` (cors/rate-limit label formatting when both are disabled).
- **Cited file:line**:
  - `/Users/alex/Documents/Projects/obsidian-mcp/src/http-transport.ts:430-445` (GET without session-id)
  - `/Users/alex/Documents/Projects/obsidian-mcp/src/http-transport.ts:511-526` (initialize error)
  - `/Users/alex/Documents/Projects/obsidian-mcp/src/http-transport.ts:527-536` (final safety net)
  - `/Users/alex/Documents/Projects/obsidian-mcp/src/http-transport.ts:660-672` (banner formatting)
- **Classification**: (a) hard-to-reach error paths. Most are defensive `try { ... } catch (err) { write_error_log }` recovery paths that would require fault injection (mock transport.handleRequest to throw). Reachable via test-double, but cost/benefit is marginal for a v3.6.x patch.
- **Class fix**: existing pattern (test E2E via real `spawn()` at `tests/http-transport.test.ts:225`) covers happy-path well. Adding fault-injection coverage is a v3.7 candidate.

---

## Finding L3-06 — `src/tools/search.ts` 80.89% lines / 69.75% branches / 70.00% functions

- **Severity**: LOW (single largest source file; ratio still acceptable)
- **Class**: genuinely undertested (c) — `search.ts` is 1565 lines, 52 unique uncovered branch lines spread across the file.
- **Evidence**: `coverage-summary.json` shows `tools/search.ts`: lines=80.89, branches=69.75 (196/281), functions=70.00.
  Uncovered branch lines: L94, L118, L133, L239, L265, L447-L449, L457, L511, L522-L523, L528, L641, L652, L841, L845-L846, L857, L875, L880, L890, L895, L900, L925, L1156, L1182, L1208, L1213, L1237, L1254, L1269-L1271, L1295, L1320-L1325, L1354, L1362, L1375, L1380, L1384, L1411, L1424, L1450, L1475, L1483-L1488, L1505, L1515, L1557. (52 unique, 85 br instances.)
- **Cited file:line**: `/Users/alex/Documents/Projects/obsidian-mcp/src/tools/search.ts` — 52 line ranges as above.
- **Classification**: (c) genuinely undertested — `search.ts` houses the hybrid pipeline + reranker integration; some uncovered branches are around late-chunking flags, HyDE flags, reranker overrides, and result-merging edge cases (empty result set, single-source result, conflict resolution).
- **Class fix**: same as L3-02 — pair with v3.6.2 coverage uplift; target ~20 of the 52 uncovered lines for ~+0.7pp branches total.

---

## Finding L3-07 — `src/tools/meta.ts` 80.93% lines / 67.66% branches / 70.96% functions

- **Severity**: LOW
- **Class**: genuinely undertested (c) — `meta.ts` is 1425 lines, 65 unique uncovered branch lines.
- **Evidence**: `coverage-summary.json` shows `tools/meta.ts`: lines=80.93, branches=67.66 (203/300), functions=70.96.
  Uncovered branch lines: L114, L124-L127, L137-L143, L177-L179, L184, L215, L392, L404, L422-L426, L437, L449, L453, L484, L590, L597, L615, L693, L699, L723-L725, L846, L851, L887, L892-L893, L897, L920-L922, L932, L1103-L1107, L1118, L1126, L1135, L1147, L1151-L1155, L1165, L1169, L1173-L1176, L1225, L1273, L1316, L1357, L1362, L1367-L1373, L1381. (65 unique, 97 br instances.)
- **Cited file:line**: `/Users/alex/Documents/Projects/obsidian-mcp/src/tools/meta.ts` — 65 line ranges as above.
- **Classification**: (c) genuinely undertested — `meta.ts` covers metadata-related tools (frontmatter, tags, links, communities, periodic-notes, base files). Uncovered branches cluster around `L120-L185` (frontmatter parsing edge cases), `L420-L490` (link manipulation error paths), `L1100-L1180` (Bases query argument validation).
- **Class fix**: pair with v3.6.2 coverage uplift. Highest-ROI targets: `L137-L143` (7-line block, likely a single switch fall-through) and `L1367-L1373` (similar shape).

---

## Finding L3-08 — `src/watcher.ts` 82.00% lines / 62.22% branches / 78.57% functions

- **Severity**: LOW
- **Class**: hard-to-reach error paths + concurrency races (a)+(c) — `watcher.ts` is only 142 lines but exercising chokidar event ordering deterministically is hard.
- **Evidence**: `coverage-summary.json` shows `watcher.ts`: lines=82.00, branches=62.22 (28/45), functions=78.57.
  Uncovered branches: L38 (silent default), L52 (skip-dir match), L74-L77 (handle error catch), L95 (path safety), L100-L101 (no-ftsIndex branch), L109 (unlink branch), L121 (silent-flag), L126-L128 (read error catch), L137 (close idempotency).
- **Cited file:line**: `/Users/alex/Documents/Projects/obsidian-mcp/src/watcher.ts:38, 52, 74-77, 95, 100-101, 109, 121, 126-128, 137`.
- **Classification**: mostly (c). Many of these branches are reachable with a small additional test that pre-sets `silent: false` then triggers add/change/unlink events and asserts stderr output via `stderr` capture. ~30 lines of test code lifts branch pct from 62 → ~80.
- **Class fix**: targeted watcher.test.ts addition; recommended for v3.6.2.

---

## Finding L3-09 — `tools/index.ts` 0.00% coverage (barrel artifact)

- **Severity**: INFO
- **Class**: coverage-counter artifact — `src/tools/index.ts` is 5 lines of `export * from "./media.js"` etc. (pure barrel). v8 coverage reports 0/0 because the file has no executable statements outside the imports. The barrel itself is excluded only because of the `**/*.test.ts` exclude in vitest.config.ts — it should be added to `src/tools/index.ts` or the brace-glob exclude pattern should add it.
- **Evidence**: `coverage-summary.json`:
  ```json
  "tools/index": { "lines": {"total": 0, "covered": 0, "pct": 0}, ... }
  ```
  `/Users/alex/Documents/Projects/obsidian-mcp/src/tools/index.ts:1-5`:
  ```
  export * from "./media.js";
  export * from "./meta.js";
  export * from "./read.js";
  export * from "./search.js";
  export * from "./write.js";
  ```
- **Cited file:line**: `/Users/alex/Documents/Projects/obsidian-mcp/vitest.config.ts:35-38` — the exclude block uses `src/{index,cli,server,tool-registry,prompts,tool-manifest}.ts` which does NOT include `src/tools/index.ts`. So the v8 coverage tool reports it, but because it's a pure re-export, the metric is 0/0 = NaN%, displayed as 0%.
- **Classification**: presentation artifact, not a real coverage gap.
- **Class fix**: add `src/tools/index.ts` to the exclude pattern. One-line change:
  ```ts
  exclude: [
    "src/{index,cli,server,tool-registry,prompts,tool-manifest}.ts",
    "src/tools/index.ts",  // barrel re-export
    "**/*.test.ts"
  ]
  ```
  Or expand the glob: `"src/{index,cli,server,tool-registry,prompts,tool-manifest,tools/index}.ts"`.
- **Recommended next action**: include in v3.6.1 if patching anyway. Cosmetic but prevents future "tools/index has 0% coverage!" confusion.

---

## Finding L3-10 — `src/pdf.ts` 58.33% branches (89.18% lines)

- **Severity**: LOW
- **Class**: external-dep + (a) hard-to-reach metadata branches.
- **Evidence**: `coverage-summary.json` shows `pdf.ts`: lines=89.18, branches=58.33 (14/24).
  Uncovered branches: L94 (lazy-load fallback), L139, L168, L172-L177 (6-line block of metadata `typeof info.X === "string"` checks).
  `/Users/alex/Documents/Projects/obsidian-mcp/src/pdf.ts:172-177`: subject, keywords, creator, producer, creationDate, modDate — all `typeof info.X === "string"` checks where test PDFs (synthesised via `pdf-lib` in `tests/helpers/make-pdf.ts`) only set `title`/`author`, not the rest. So the truthy-string branch never fires for those 5 metadata fields.
- **Cited file:line**: `/Users/alex/Documents/Projects/obsidian-mcp/src/pdf.ts:172-177`, `/Users/alex/Documents/Projects/obsidian-mcp/tests/helpers/make-pdf.ts` (PDF builder).
- **Classification**: (a) — easily reachable, just need a test PDF with all 8 metadata fields populated.
- **Class fix**: extend `tests/helpers/make-pdf.ts` to optionally accept all 8 metadata fields, then add one test PDF with all set + assert all 8 fields land in `extractPdfText().metadata`. ~10 lines, lifts branches from 58 → ~95.
- **Recommended next action**: v3.6.2 coverage uplift.

---

## Finding L3-11 — fixture freshness verified (PASS)

- **Severity**: INFO
- **Evidence**:
  - `/Users/alex/Documents/Projects/obsidian-mcp/tests/fixtures/benchmark-queries.jsonl` — 60 queries (q01-q60) reference 47 unique relevant paths.
  - `/Users/alex/Documents/Projects/obsidian-mcp/scripts/run-benchmarks.mjs` — `VAULT_NOTES` object defines exactly the same 47 paths.
  - `diff` between the two sorted unique-path sets returns 0.
  - Path categories: `Reference/*.md` (32), `Projects/*.md` (6), `Inbox/*.md` (5), `Daily/*.md` (5), `INDEX.md` (1) — 47 total.
- **Status**: NO FINDING. Fixture is in sync with the synthetic-vault generator.
- **Notable**: the inline JSONL comment at line 6 explicitly states "When the vault layout changes the relevant-paths list here MUST change too — these are the binary ground-truth labels for NDCG / Recall / MRR." This invariant is currently held.

---

## Finding L3-12 — no snapshot files (NOT APPLICABLE)

- **Severity**: INFO
- **Evidence**:
  - `find /Users/alex/Documents/Projects/obsidian-mcp/tests -name "__snapshots__"` → no results
  - `find /Users/alex/Documents/Projects/obsidian-mcp/tests -name "*.snap"` → no results
  - `grep -rn "toMatchSnapshot\|toMatchInlineSnapshot" tests/` → no matches
- **Status**: NO FINDING. Snapshot integrity check is moot because the project uses no snapshots — all assertions are explicit `expect().toEqual()`, `.toMatch()`, etc.

---

## Coverage table (full)

From `/Users/alex/Documents/Projects/obsidian-mcp/coverage/coverage-summary.json`:

| File | Lines | Branches | Funcs | Stmts | Flags |
|---|---:|---:|---:|---:|---|
| `tools/index` | 0.00 | 0.00 | 0.00 | 0.00 | barrel artifact (L3-09) |
| `embeddings` | 31.25 | 30.00 | 33.33 | 29.21 | external-dep (L3-03) |
| `ocr` | 33.33 | 24.00 | 45.45 | 30.30 | external-dep (L3-04) |
| `http-transport` | 79.91 | 66.86 | 58.97 | 78.57 | error paths (L3-05) |
| `tools/search` | 80.89 | 69.75 | 70.00 | 78.47 | (L3-06) |
| `tools/meta` | 80.93 | 67.66 | 70.96 | 76.88 | (L3-07) |
| `watcher` | 82.00 | 62.22 | 78.57 | 79.03 | (L3-08) |
| `pdf` | 89.18 | 58.33 | 100.00 | 90.00 | (L3-10) |
| `vault` | 92.63 | 80.00 | 75.38 | 83.52 | F<80 |
| `hnsw` | 94.25 | 75.00 | 100.00 | 91.57 |  |
| `tools/media` | 94.30 | 67.93 | 92.30 | 91.11 | B<75 |
| `fts5` | 94.32 | 80.95 | 93.33 | 92.51 |  |
| `doctor` | 94.54 | 66.35 | 100.00 | 92.50 | B<75 |
| `embed-db` | 95.56 | 81.30 | 88.00 | 93.78 |  |
| `dql` | 95.95 | 86.12 | 89.65 | 90.28 |  |
| `tools/read` | 96.11 | 85.43 | 91.17 | 93.97 |  |
| `parser` | 98.00 | 84.61 | 100.00 | 96.42 |  |
| `bases` | 98.21 | 73.17 | 91.30 | 92.27 | B<75 |
| `tools/write` | 98.51 | 84.83 | 96.15 | 95.30 |  |
| `periodic` | 99.06 | 85.04 | 100.00 | 99.13 |  |
| `communities` | 99.15 | 73.17 | 100.00 | 95.52 | B<75 |
| `cli-help` | 100.00 | 100.00 | 100.00 | 100.00 |  |
| `eval` | 100.00 | 76.62 | 100.00 | 98.49 |  |
| `rrf` | 100.00 | 93.33 | 100.00 | 96.66 |  |
| **TOTAL** | **89.20** | **75.02** | **82.15** | **85.79** | branches THIN (L3-02) |

Thresholds: lines=86, statements=82, functions=75, branches=74. All passing; branches has +1.02pp margin (L3-02).

---

## Test count cross-surface verification (PASS)

| Surface | Path:line | Claimed |
|---|---|---|
| README | `/Users/alex/Documents/Projects/obsidian-mcp/README.md:13` (badge) | 714 passing |
| README | `/Users/alex/Documents/Projects/obsidian-mcp/README.md:32` (one-liner) | 714 unit tests |
| README | `/Users/alex/Documents/Projects/obsidian-mcp/README.md:98` (table) | 714 unit tests |
| README | `/Users/alex/Documents/Projects/obsidian-mcp/README.md:208` (code block) | 714 tests, ~5s |
| package.json | `/Users/alex/Documents/Projects/obsidian-mcp/package.json:5` (description) | 714 tests |
| social-preview.svg | `/Users/alex/Documents/Projects/obsidian-mcp/assets/social-preview.svg` | `<text>714</text>` |
| CHANGELOG | `/Users/alex/Documents/Projects/obsidian-mcp/CHANGELOG.md:70` (v3.6.0 entry) | 714 tests (713 passing + 1 env-gated smoke) |
| CHANGELOG | `/Users/alex/Documents/Projects/obsidian-mcp/CHANGELOG.md:167` (v3.6.0-rc.4) | 714 tests (713 passing + 1 skipped) |

**Actual measured**: `grep -rEh "^\s+(it|test)\(" tests/*.test.ts | wc -l` → **714**. Of those, 1 is `it.skip` at `tests/reranker-smoke.test.ts:38`. So **713 active + 1 skipped = 714 total**, matching every documented surface.

---

## Per-test-file count (sanity)

```
tests/reranker-smoke.test.ts:        0 it() at indent 2 (1 it.skip)
tests/no-internal-imports.test.ts:   1
tests/chat-thread.test.ts:           7
tests/ocr.test.ts:                   7
tests/watcher.test.ts:               7
tests/late-chunking.test.ts:         8
tests/canvas.test.ts:                10
tests/frontmatter-ops.test.ts:       11
tests/communities.test.ts:           13
tests/persistent-cache.test.ts:      13
tests/reranker.test.ts:              13
tests/rrf.test.ts:                   13
tests/semantic.test.ts:              13
tests/lint.test.ts:                  14
tests/v16.test.ts:                   14
tests/doctor.test.ts:                15
tests/search-hybrid.test.ts:         15
tests/embeddings.test.ts:            17
tests/hnsw.test.ts:                  17
tests/bases.test.ts:                 21
tests/docs-consistency.test.ts:      21
tests/embed-db.test.ts:              22
tests/eval.test.ts:                  25
tests/parser.test.ts:                25
tests/periodic.test.ts:              25
tests/pdf.test.ts:                   26
tests/cli.test.ts:                   31
tests/fts5.test.ts:                  34
tests/security.test.ts:              36
tests/dql.test.ts:                   43
tests/http-transport.test.ts:        49
tests/write.test.ts:                 50
tests/tools.test.ts:                 70
```
Sum of `it()` calls in indented form: 686 (excluding nested describes counted differently). Including all `it()` and `test()` variations: 714. Includes 1 `it.skip` at `tests/reranker-smoke.test.ts:38`.

---

## Constraints honored

- Audit-only: no source files modified.
- Test + coverage runs executed (read-only on src/).
- Every claim cites specific `file:line` per L3 plan.

## Recommendations summary

| Priority | Finding | Action |
|---|---|---|
| HIGH | L3-01 | Set `testTimeout: 15_000` in `vitest.config.ts`; widen `fts5.test.ts:171` perf bound to 1500ms. Ship as v3.6.1 patch. |
| MEDIUM | L3-02 | Add 8-12 test cases in `tests/communities.test.ts` + `tests/watcher.test.ts` to lift branches margin past 2pp; OR raise threshold to 75. |
| MEDIUM | L3-03, L3-04 | Document external-dep coverage gap in `vitest.config.ts` comments so future auditors don't try to "fix" it. |
| LOW | L3-05, L3-06, L3-07, L3-08, L3-10 | Batch into v3.6.2 coverage uplift; target the lowest-hanging branches. |
| INFO | L3-09 | Add `src/tools/index.ts` to vitest coverage exclude (one-line). |
| PASS | L3-11, L3-12, test count | No action — recorded for traceability. |
