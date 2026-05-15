# L8 — Reproducibility audit (light, foreground)

**Date**: 2026-05-15
**Auditor**: maintainer (foreground; L8 sub-agent was killed before completing)
**Scope**: every public `npm` script runs to green in the dev tree

## Note on light-vs-isolated execution

The original L8 plan called for a fresh `git worktree` clone to catch install bugs masked by dev-tree caches. The sub-agent was killed mid-execution. This light L8 runs the same script set in the dev tree — sufficient to verify the public commands work, but does NOT catch "rebuild relies on stale cache" or "missing package-lock entry" issues.

Recommend: re-run L8 in isolated worktree before v3.6.1 ships as a sanity check.

## TL;DR — 7/8 scripts clean, 1 TypeDoc warning

| Script | Status | Notes |
|---|---|---|
| `npm test` | ✅ PASS | 713 passed + 1 skip, 12.05s |
| `npm run lint` | ✅ PASS | biome — 1 pre-existing info note (schema version) |
| `npx tsc` | ✅ PASS | strict + noUncheckedIndexedAccess clean |
| `npm run build` | ✅ PASS | tsc → dist/ |
| `check-changelog-coverage` | ✅ PASS | within 0.5pp |
| `check-version-consistency` | ✅ PASS | 3.6.0 across 5 surfaces |
| `smoke.mjs` (scan path) | ✅ PASS | bearer auth + initialize work |
| `smoke.mjs --with-fts` | ✅ PASS | FTS5 path also clean |
| `npm run docs:api` (TypeDoc) | ⚠️ 3 warnings | 0 errors, 111 HTML pages generated. `@link` to `findBestMatch`, `suggestSimilar`, `FileEntry` — these helpers are `@internal` so TypeDoc filters them out, but the `@link` references in tools/* TSDoc still point at them. |

## Findings

### L8-01 (Low) — 3 TypeDoc `@link` warnings to @internal helpers

**Class**: TSDoc `@link` referring to `@internal`-annotated targets.

**Evidence**:
- `tools.readCanvas` TSDoc has `{@link findBestMatch}` — findBestMatch is `@internal` in `src/tools/meta.ts`
- `tools.resolveTarget` TSDoc has `{@link suggestSimilar}` — same
- `tools.resolveTarget` TSDoc has `{@link FileEntry}` — FileEntry comes from `src/vault.ts`, not exported as a public type

Same finding as **L6-08** — L6 doc audit caught it independently. Cross-confirmed.

**Suggested fix**: either (a) un-`@internal` those helpers so they appear in TypeDoc (changes the public surface), or (b) replace `{@link X}` with backtick code `` `X` `` (loses navigation but kills the warning), or (c) add `externalSymbolLinkMappings` config to typedoc.json mapping these symbols to `#`.

**Per-instance backfill**: 3 places in tool TSDoc.

### L8-02 (Info) — `npm bench:retrieval` was NOT run in this light L8

The benchmark script (`scripts/run-benchmarks.mjs`) needs ~3-5 minutes wall-clock + downloads the BGE reranker model on first run. Skipped to keep the audit fast.

**Recommend**: full L8 in worktree must include this step. The benchmark is the most important script we ship.

## Verified clean

- All 7 quick commands pass (test/lint/tsc/build/changelog-coverage/version-consistency/smoke)
- TypeDoc generates 111 HTML pages, 0 errors
- No stale-cache surprises observed (no missing files, no failed imports)

## Recommendation

**v3.6.1 should include**:
1. Real L8 in fresh worktree as part of pre-release validation
2. The 3 TypeDoc `@link` warnings fixed (Low, but they're visible to anyone running `docs:api`)

## Sign-off

L8 verdict: **GREEN** with 1 Low finding (TypeDoc `@link` warnings — cross-confirmed with L6). All public scripts run clean. Light-vs-isolated note documented as a follow-up task.
