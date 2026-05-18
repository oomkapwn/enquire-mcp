# Project goal — v3.6.0 sprint

This file is read by Claude Code sessions on this repo. It defines the current sprint goal, scope, quality bar, and anti-patterns so any session (continuation or new) shares the same North Star.

---

## Goal

Release **enquire-mcp v3.6.0** per the planned RC sequence (or better — if mid-sprint observation reveals additional drift classes or quality improvements, extend scope, don't defer).

Directive: **"Максимальное качество и уверенный топ-1 из всех Obsidian MCP по технологии и надёжности."**

## Scope — RC sequence + promotion

- **v3.6.0-rc.1**: `tools.ts` (4252 lines) → 5 domain modules in `src/tools/` + barrel
- **v3.6.0-rc.2**: `index.ts` (3665 lines) → `src/cli.ts` + `src/server.ts` + `src/prompts.ts` + `src/tool-registry.ts` + `src/tool-manifest.ts`
- **v3.6.0-rc.3**: Full TSDoc (`@param` / `@returns` / `@example`) on 44 tools + 19 prompts + 20 `src/` modules (~1300+ lines of doc-comments)
- **v3.6.0-rc.4**: TypeDoc + GH Pages auto-generated API reference + Public benchmarks (`docs/benchmarks.md`, MRR/NDCG@10/Recall@K vs 3 main competitors)
- **v3.6.0 (stable)**: promote rc.4 → npm `latest`, GH release marked Latest

## Quality bar — required on every RC (no exceptions)

1. 712+ tests pass (some RCs may add tests from coverage redistribution)
2. Lint clean (biome 0 warnings/errors)
3. `tsc` strict + `noUncheckedIndexedAccess` clean
4. Coverage thresholds met (lines ≥86, statements ≥82, functions ≥75, branches ≥74)
5. `scripts/check-changelog-coverage.mjs` passes (CHANGELOG claims = reality within 0.5pp)
6. `scripts/smoke.mjs` synthetic vault scan passes
7. All 8 required CI gates green on PR (lint, test×2, smoke, audit, coverage, version-consistency, docs — `docs` added v3.7.10, count locked at 8 since v3.7.13)
8. Daily-check report after merge: 0 regressions, 0 new CodeQL / Dependabot alerts
9. CHANGELOG entry with TL;DR blockquote + method note
10. All docs-consistency invariants stay green (extend as new surfaces appear)

## Audit checkpoint — after every RC

- **Self-audit** via root-cause-sweep methodology (memory: `method_audit_root_cause_sweep.md`): check the drift class hasn't returned from previous cycles
- **Any external audit report** (Mavis / MiniMax / other) — pause until processed; either instance-fix OR class-fix
- **All rejections of auditor recommendations** must be documented inline in the CHANGELOG with reasoning (see v3.5.14 L-2 for the empirical-rejection pattern)
- **New findings in the current RC** → fix BEFORE the next RC, do not carry into the final v3.6.0

## Exit criteria — v3.6.0 is "closed" when

1. npm `latest = 3.6.0` (not RC)
2. GH release v3.6.0 marked Latest
3. All 4 RC merged + tagged + on npm under `rc` dist-tag
4. `docs/api-reference/` published to GH Pages (auto-generated TypeDoc)
5. `docs/benchmarks.md` published with real MRR/NDCG/Recall numbers on a BEIR/TREC subset + competitor comparison
6. CHANGELOG v3.6.0 entry with major summary: before/after, measurable improvements (coverage delta, lines-per-file delta, build time delta)
7. Twitter thread (@OomkaBear) with top-3 differentiators
8. Daily-check shows 0 regressions + clean security for 7 days after final
9. If external audit on v3.6.0 happens — must return ≥ 4.8 / 5.0

## Non-goals (NOT doing in this sprint)

- Multi-vault support (out of scope per `docs/COMPARISON.md` positioning)
- OAuth (bearer-only is a deliberate security-positive design choice)
- Live Obsidian integration via Local REST API (different positioning vs `cyanheads/obsidian-mcp-server`)
- Formula evaluator for Bases DSL (deferred to v3.7+)
- Any API breaking changes (this is a MINOR bump; major surface stays stable per STABILITY.md)

## Anti-patterns to avoid

- **Big-bang refactor** — always phased via RCs
- **Copy-paste coverage stats** from sub-agent output (lesson from v3.5.12)
- **Optional dep removal without empirical test** (lesson from v3.5.14 L-2)
- **Hardcoded counts in docs without an invariant** (rule since v3.5.9)
- **Dismissing an auditor without CHANGELOG reasoning** (rule since v3.5.14)
- **Compressing CHANGELOG for aesthetics** — audit trail trumps style
- **Merge without green daily-check on main** afterward
- **Claim "all N callsites" before grep-verifying** — overclaim class repeated 3× in K-1 saga (v3.6.1, v3.6.2, v3.6.4). Solution: structural enforcement (`tests/k1-class-invariant.test.ts`) > CHANGELOG promises. **Rule since v3.6.4**: any "N of N fixed" claim requires a test gate or it doesn't ship.
- **Reactive same-day patching** — 5 releases (3.6.0→3.6.4) on 2026-05-15 happened because each post-ship audit found another instance. Lesson: **audit BEFORE ship, not after**. After a retroactive correction patch (like v3.6.4), allow 24h of dogfood on main before next patch — surfaces regressions and breaks the "instance-spotted → instance-patched" cycle. **Rule since v3.6.4**: after a CRITICAL or retroactive-correction patch, the next patch waits ≥24h unless a new CRITICAL is found in production.
- **Invariant test without negative-control** — a test that ALWAYS passes proves nothing. Every new invariant test must have a sibling test that fails when the invariant is violated (see `tests/peek-meta.test.ts` "NEGATIVE control" pattern from v3.6.4). **Rule since v3.6.4**.

## Method note

Apply **root-cause sweep methodology** consistently: every bug → identify the class → ship class fix + per-instance backfill in one PR. If during this sprint the methodology spots 2+ instances of the same class, escalate to a mandatory class fix BEFORE v3.6.0 stable — do not defer.

**"Каждый этап и элемент системы проаудирован, все ошибки устранены"** = after v3.6.0 stable there is zero open issue, zero CI failure, zero docs drift, zero coverage gap below threshold, zero un-rejected (and undocumented) auditor recommendation.

---

## Current phase status

- **v3.6.0 stable shipped**: tools.ts + index.ts splits + Full TSDoc + TypeDoc on GH Pages + public benchmarks. Internal 9-layer audit produced 4.85/5 verdict. Mavis external 4.9/5.
- **v3.6.1 emergency patch shipped**: closed 3 CRITICAL ship-blockers caught by an anonymous external auditor that all 3 prior audits missed. (Overclaim instance #1: "CRIT-1 closed" was 1 of 10 callsites.)
- **v3.6.2 shipped**: 13 Medium + 14 Low + 4 HIGHs from internal + external audits. Claimed "K-1 RESIDUAL CLASS full fix" + "all 10 callsites". (Overclaim instance #2: actually 4 of 10.)
- **v3.6.3 shipped**: marketing pivot to "memory layer for AI agents" framing — README + npm description + GitHub About/Topics + package.json keywords. Zero code/behavior changes; pure discovery patch.
- **v3.6.4 shipped**: K-1 class TRULY FINAL closure — fixes the 5 residual `cli.ts` callsites that v3.6.2 left + adds `tests/k1-class-invariant.test.ts` (structural class guard) + 3 caller-pattern integration tests (positive bge / positive trigram / negative-control). Retroactive TSDoc corrections in `embed-db.ts` + `fts5.ts`. CHANGELOG explicitly names v3.6.2 as overclaim instance #2 and v3.6.1 as #1.
- **v3.7.0 shipped**: quality batch closing 8/8 post-v3.6.4 audit items. M-1 E2E preservation tests (setup/eval/build-embeddings) + M-2 AST-based K-1 invariant with fixture negative-controls + M-3 recursive `SRC_DIRS` scan + L-1 peek-result caching (19.9× speedup on search hot path) + L-2 bench rerun + L-4 marketing positioning permeation into docs/api.md / docs/QUICKSTART.md / docs/COMPARISON.md + per-file branch coverage floors (`scripts/check-per-file-coverage.mjs`) + GitHub repo metadata invariant. **K-1 saga now structurally enforced at 4 levels (grep, AST, caller-pattern, fixture-based negative-control). Last instance in this thread.**
- **v3.7.1 shipped**: external audit response. The v3.6.0 audit report (`AUDIT-enquire-mcp-2026-05-15.md`) was processed in full — 36/38 findings were already closed by the v3.6.1→v3.7.0 cascade; 1 material residual (`SECURITY.md` drift — said `.base` unevaluated predicates were "permissive" but v3.6.2 HN-2 had flipped to fail-closed) was fixed in this patch + 2 docs touch-ups (api.md channels → v3.7.x, QUICKSTART Node version framing). 1 finding (L-1 index.ts rc.2 historical comment) is documented as accepted with reasoning. Zero code/API/behavior changes.
- **v3.7.2 shipped**: round-3 audit response. Found 13+ inline `// v3.6.3 K-1 ...` mis-attributions (v3.6.3 was marketing-only, K-1 actually closed in v3.6.4). Mass-fixed all stamps + added `tests/k1-version-stamp-consistency.test.ts` as 5th-level structural guard for the K-1 class. The doc-drift class has now recurred 4 times; this invariant terminates the iteration.
- **v3.7.3 shipped**: round-4 audit response (24h after v3.7.2). Caught **self-applied methodological violation**: v3.7.2's invariant lacked a negative-control sibling test. Extracted scanning into `scanK1Stamps()` pure function + added fixture-based negative-control. **All 5 K-1 enforcement levels got negative-control coverage.**
- **v3.7.4 shipped**: round-5 audit response — class-vs-instance recursion correction. v3.7.3 fixed ONE instance of "post-v3.6.4 invariant lacking negative-control" (k1-version-stamp) but the CLASS had a second open instance (`tests/github-metadata-invariant.test.ts`). Plus reranker model count (5) gate.
- **v3.7.5 shipped**: 2nd external audit response (CRITICAL). `enquire-mcp-audit-report-v3.6.2.md` (round-7) found K-1 (embedder thread-through silent corruption) + K-2 (read-only search DROP TABLE) that 5 internal audit rounds missed. 1-line fix `loadEmbedder(args.model)` → `loadEmbedder(model.alias)` + throw-on-mismatch instead of bootstrap rebuild + M-1 SECURITY docs drift in api.md/tool-registry.ts. Re-confirms v3.6.1 method note: ≥2 independent external auditors with DIFFERENT methodologies.
- **v3.7.6 shipped**: 8 ship-ready findings from v3.6.2 audit batched (H-4 PDF stale rows · H-5 serve-http examples · M-5 TypeDoc CI gate · M-9 chmod parent · M-10 HNSW signature includes quantization · M-12 reranker -Infinity · L-3/L-4 docs). 786 tests unchanged; 2 tests updated for M-10 signature change.
- **v3.7.7 shipped**: visual + marketing refresh — new social-preview.png with emotional value prop + visual flow (vault → enquire-mcp → 5 AI agents). README hero rewritten with "The problem / The solution" narrative + sticky nav. Zero code changes.
- **v3.7.8 shipped**: positioning calibration — restored "The most advanced Obsidian MCP" credential to README H3 (paired with value prop), restored OpenClaw across 5 README surfaces + GitHub About + Topics (swapped context-engineering for openclaw in 20-cap).
- **v3.7.9 shipped**: round-11 audit response — positioning permeation completion. Caught 5 drift findings from v3.7.8 calibration: docs/QUICKSTART.md and docs/api.md had agent lists without OpenClaw, `tests/github-metadata-invariant.test.ts` REQUIRED_TOPICS + ABOUT_LEADS_WITH still carried v3.7.0 values (drift across 4 patches), CLAUDE.md status section stuck at v3.7.4. All synchronized.
- **v3.7.10 shipped**: round-12 audit — 10 findings closed (DQL `likeToRegex` 3 sub-bugs, `EmbedDb.upsertNote` transactionality verify, FTS5 transaction sibling fix, CI workflow `REQUIRED` includes `docs`, etc.). 786 tests.
- **v3.7.11 shipped**: round-13 self-audit — 3 findings closed including v3.7.10 silent overclaim correction (CHANGELOG D4 claimed `examples/` added to `package.json#files` but Edit hit a file-modified race; verified post-merge, actually added in v3.7.11). 5th overclaim instance documented. 787 tests.
- **v3.7.12 shipped**: round-14 external audit response — 3rd independent external audit since v3.6.0 (Mavis on v3.6.0, anonymous on v3.6.0, this round-14 on v3.7.5). 10 ship-ready findings: H2 `.base` path normalization, H4 `./tool-manifest` missing from exports, M3 listCanvases mtime-as-bytes leak, M4 HTTP body cap < file cap, M6 graph-boost wasted I/O on PDFs, M11 HTTP docs token-env primary, L1 stateful clarification, L2 QUICKSTART version stale, L4 reranker catalog vs verified, L6 TypeDoc treatWarningsAsErrors. 2 false positives confirmed (PNG + queries.jsonl). 19 architectural items deferred to v3.8.0. **801 tests** (+14 negative-controls); +2 docs-consistency invariants.
- **v3.7.13 shipped (current)**: round-15 external audit response — 4th independent external audit since v3.6.0. 15 ship-ready findings: H1 PDF page slicing pre-extraction DoS, H2 HTTP stateful pre-initialize resource leak, H3 engines.node floor mismatch, M1 renameNote rollback recovery, M2 overwrite=false atomic create (wx flag), M3 OCR lang regex validation, M5 7→8 required gates, M8 per-file coverage fail-on-missing, M9 chmod parentExisted pattern in saveDiskCache, M10 docs/api.md broken link → SECURITY.md, M11 benchmarks latency dedup, M12 COMPARISON test count gate, L2 OCR/read_pdf page range refine, L4 github-metadata fail-loud + CI GH_TOKEN, L7 exclude docs/audits from npm package. 2 findings already closed by v3.7.12 (L1 `.base` normalization, L3 canvas mtimeMs). **813 tests** (+11 negative-controls); +1 docs-consistency invariant; npm tarball -228 KB (docs/audits/ excluded).
- **v3.7+ backlog status**: All known audit findings from rounds 1–15 closed. v3.8.0 backlog: round-14 architectural items + round-15 deferred items M4 (HTTP feature parity matrix), M6 (reranker smoke in CI), M7 (write-tool smoke variant), M13 (release automation), L5 (test-count from Vitest JSON), L6 (watcher tests timing). **No open audit items as of 2026-05-18 / 23 releases into the v3.6.0 → v3.7.13 cascade.**
- **v3.7+ deferred** (no audit pressure, parked for v3.8+):
  - E2E preservation tests for `setup` / `eval` / `build-embeddings` (currently only `index` has E2E preservation+forced-rebuild pair from v3.6.4).
  - Strengthen K-1 invariant via TypeScript AST: enforce that peek result is CONSUMED in the constructor's `modelAlias` / `tokenize` arg, not just present in scope.
  - Recursive `SRC_DIRS` scan in `tests/k1-class-invariant.test.ts` (currently hardcoded `["src", "src/tools"]`).
  - Cache peek result in `prepareServerDeps` to avoid hot-path SQLite open+close on every `embeddingsSearch` call (~5-10ms × N searches).
  - Re-run `npm run bench:retrieval` post-v3.6.4 and republish `docs/benchmarks.md` (ensure K-1 fix doesn't impact retrieval numbers).
  - Marketing positioning permeation into `docs/api.md`, `docs/QUICKSTART.md`, `docs/COMPARISON.md` opening paragraphs (still framed as "MCP server", not "memory layer").
  - Per-file branch-coverage thresholds for security-critical modules (`http-transport.ts` 67%, `tools/search.ts` 68%, `tools/meta.ts` 68%, `tools/media.ts` 68%). Global 75.4% hides these dips.
  - GitHub repo metadata invariant test (`About` + `Topics` drift caught by no CI today).
- **Method lessons accumulated through the v3.6.x cascade**:
  1. **Every minor/major needs ≥2 independent external auditors with DIFFERENT methodologies.** Internal multi-layer audits = breadth + speed but NOT a substitute for fresh external perspective. See `~/.claude/.../memory/method_full_system_audit.md`.
  2. **Class fix ≠ instance fix; structural enforcement > CHANGELOG promises.** When a methodological bug recurs in two consecutive releases, the fix is a test gate, not another patch. (See `tests/k1-class-invariant.test.ts`.)
  3. **Caller-pattern coverage ≠ helper-pattern coverage.** Unit tests for utility functions don't catch callers forgetting to use them. Negative-control test pins the bad behavior.
  4. **Audit BEFORE ship, not after.** Reactive post-ship patches create release churn and overclaim risk. Audit during code review; after a CRITICAL/retroactive patch, allow 24h of main dogfooding before the next patch.
  5. **Marketing positioning is continuous calibration.** Same capabilities, evolving search vocabulary — Claude Memory (Oct 2025) and Skills (Nov 2025) shifted "memory for AI agents" into mainstream developer-discovery terms.
