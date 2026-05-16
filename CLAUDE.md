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
7. All 7 required CI gates green on PR
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
- **v3.7.3 shipped (current)**: round-4 audit response (24h after v3.7.2). Caught **self-applied methodological violation**: v3.7.2's invariant lacked a negative-control sibling test (CLAUDE.md anti-pattern "Invariant test without negative-control — Rule since v3.6.4"). Extracted scanning into `scanK1Stamps()` pure function + added fixture-based negative-control at `tests/fixtures/k1-version-stamps/drift-mixed.ts` + 2 negative-control tests proving the analyzer detects drift. **All 5 K-1 enforcement levels now have negative-control coverage.**
- **v3.7+ backlog status**: 8/8 items from the post-v3.6.4 audit are closed (v3.7.0). External-audit response is closed (v3.7.1). K-1 doc-drift class structurally closed (v3.7.2 + v3.7.3 negative-control). **No open audit items as of 2026-05-16.**
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
