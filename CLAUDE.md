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

## Method note

Apply **root-cause sweep methodology** consistently: every bug → identify the class → ship class fix + per-instance backfill in one PR. If during this sprint the methodology spots 2+ instances of the same class, escalate to a mandatory class fix BEFORE v3.6.0 stable — do not defer.

**"Каждый этап и элемент системы проаудирован, все ошибки устранены"** = after v3.6.0 stable there is zero open issue, zero CI failure, zero docs drift, zero coverage gap below threshold, zero un-rejected (and undocumented) auditor recommendation.

---

## Current phase status

- **rc.1 shipped**: `tools.ts` (4252 lines) → `src/tools/{search,read,write,media,meta}.ts` + barrel.
- **rc.2 shipped**: `index.ts` (3665 lines) → `src/{cli,server,tool-registry,prompts,tool-manifest}.ts`; slim `src/index.ts` (84 lines).
- **rc.3 in flight** (PR #67): Full TSDoc (+2238 lines, 369 doc-blocks) on 44 tools + 19 prompts + helpers.
- **rc.4 next**: TypeDoc + GH Pages + Public benchmarks.
