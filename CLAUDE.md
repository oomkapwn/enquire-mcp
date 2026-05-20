# Project goal — v3.7.x maintenance + v3.8.0 architectural

This file is read by Claude Code sessions on this repo. It defines the current sprint goal, scope, quality bar, and anti-patterns so any session (continuation or new) shares the same North Star.

**v3.6.0 stable shipped on 2026-05-15.** The current cascade (v3.6.0 → v3.7.17+) is the post-release maintenance + audit-driven hardening line. v3.8.0 is the architectural-changes milestone (HNSW filter-during-search, embed-db migrations, distributed rate-limit, watcher embed-db sync, K-3 readOnlyHint invariant, etc.).

---

## Goal (historical — v3.6.0 sprint, shipped 2026-05-15)

Released **enquire-mcp v3.6.0** per the planned RC sequence. This section is preserved as historical context — the sprint is closed.

Directive: **"Максимальное качество и уверенный топ-1 из всех Obsidian MCP по технологии и надёжности."**

## Scope (closed) — v3.6.0 RC sequence + promotion

- **v3.6.0-rc.1**: `tools.ts` (4252 lines) → 5 domain modules in `src/tools/` + barrel
- **v3.6.0-rc.2**: `index.ts` (3665 lines) → `src/cli.ts` + `src/server.ts` + `src/prompts.ts` + `src/tool-registry.ts` + `src/tool-manifest.ts`
- **v3.6.0-rc.3**: Full TSDoc (`@param` / `@returns` / `@example`) on 44 tools + 19 prompts + 20 `src/` modules (~1300+ lines of doc-comments)
- **v3.6.0-rc.4**: TypeDoc + GH Pages auto-generated API reference + Public benchmarks (`docs/benchmarks.md`, MRR/NDCG@10/Recall@K vs 3 main competitors)
- **v3.6.0 (stable)**: promote rc.4 → npm `latest`, GH release marked Latest

## Quality bar — required on every release (no exceptions)

1. All tests pass (current count: 818+ at v3.7.17; tests grow with each audit cycle — see CHANGELOG)
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
- **TSDoc header drifts from function body** — every overclaim instance since v3.6.1 (7 documented) has the same shape: code changed inside a function, but the function-level TSDoc / file-header / block-comment describing the behavior wasn't updated in the same commit. TypeDoc + IDE hover then publish the stale (lying) description. **Rule since v3.7.15**: every fix that changes function internals MUST include the matching TSDoc header update in the same commit; reviewers MUST diff the header alongside the body. Examples of the drift: v3.7.14 F1 (renameNote body fixed, header lied), v3.7.14 F2 inside the SAME patch (renameFile body fixed by F2, header still said "Atomic via fs.rename").
- **Single class-sweep is not enough — same-release recursion happens** — v3.7.14 F1 fixed overclaim #6, and v3.7.14 F2 SHIPPED overclaim #7 inside the very same patch. The author of an audit-driven fix sees the immediate problem but doesn't apply the lesson to OTHER changes in the same diff. **Rule since v3.7.15**: after every audit-driven release that closes a "class" finding (overclaim, TSDoc drift, TOCTOU, etc.), run a post-merge re-sweep specifically scanning that patch's own diff for fresh instances of the same class. The recursion rate observed across v3.6.x-v3.7.x is high enough that this is a required step, not optional.
- **Tag the SQUASH-MERGE commit on main, not the feature-branch HEAD** — v3.7.14 was tagged against the pre-merge branch SHA (orphan, not on main), and `.github/workflows/release.yml`'s "Assert tag is on main" guard correctly refused to publish (overclaim #8). The CHANGELOG implied the ship completed before it actually did. **Rule since v3.7.15**: the post-merge release procedure is *always*: `git checkout main` → `git pull origin main` → `git log -1 --oneline` (capture the squash-merge SHA) → `git tag vX.Y.Z <that-SHA>` → `git push origin vX.Y.Z`. Never tag from a feature branch — the squash-merge produces a NEW commit whose SHA differs from the branch HEAD.
- **Internal change-driven sweeps miss state-driven failure modes — run OIA before claiming "no open findings"** — every external auditor since v3.6.0 has found stale fragments that internal class-sweeps missed: README badges, CLAUDE.md titles, file-header comments, stale CLI references in docs, stale npm-script references in script docstrings. Root cause: my methodology is CHANGE-DRIVEN (look at what changed, fix the class, verify nearby) while external audits are STATE-DRIVEN (read every file as it exists, verify each claim against reality). These find non-overlapping failure modes. **Rule since v3.7.17**: run `npm run check:oia` (`scripts/oia-walk.mjs`) before claiming "no open audit items" in any release. The script automates the 5 cheap state-driven walks: stale currency claims in file headers, CI workflow existence vs README claims, CLI subcommand existence vs docs references, npm script existence vs script-docstring references, and inline-comment default-value claims vs exported `DEFAULT_*` constants. Default mode exits 1 on any finding; `--allow` overrides for documented architectural deferrals. **Round-19 (v3.7.17) shipped the rule + the script after the 5th external audit caught 4 cheap stale fragments my v3.7.16 pre-merge RCA missed.**

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
- **v3.7.13 shipped**: round-15 external audit response — 4th independent external audit since v3.6.0. 15 ship-ready findings: H1 PDF page slicing pre-extraction DoS, H2 HTTP stateful pre-initialize resource leak, H3 engines.node floor mismatch, M1 renameNote rollback recovery, M2 overwrite=false atomic create (wx flag), M3 OCR lang regex validation, M5 7→8 required gates, M8 per-file coverage fail-on-missing, M9 chmod parentExisted pattern in saveDiskCache, M10 docs/api.md broken link → SECURITY.md, M11 benchmarks latency dedup, M12 COMPARISON test count gate, L2 OCR/read_pdf page range refine, L4 github-metadata fail-loud + CI GH_TOKEN, L7 exclude docs/audits from npm package. 2 findings already closed by v3.7.12 (L1 `.base` normalization, L3 canvas mtimeMs). **813 tests** (+11 negative-controls); +1 docs-consistency invariant; npm tarball -228 KB (docs/audits/ excluded).
- **v3.7.14 shipped**: round-16 SELF-audit — class-sweep methodology applied to v3.7.13 fixes. 5 findings: F1 v3.7.13 silent overclaim (M1 fixed renameNote ordering but TSDoc header still described OLD buggy order — 6th overclaim instance), F2 M2 sibling (renameFile had same stat-then-rename TOCTOU race; fix via link()+unlink() atomic exclusive create), F3 appendNote stat-then-append race let parallel writers bypass maxFileBytes (fix via single open fd + write), F4 hardcoded "8 required CI gates" not gated by docs-consistency (v3.5.9 anti-pattern recurrence — new invariant against release.yml REQUIRED regex), F5 automated gh release create in release.yml (M13 from round-15, originally v3.8.0-deferred). **815 tests** (+2 negative-controls + invariant); +1 docs-consistency invariant.
- **v3.7.15 shipped**: round-17 POST-MERGE audit on v3.7.14 — **meta-recursion finding**: v3.7.14 F1 closed overclaim #6 but v3.7.14 F2 SHIPPED overclaim #7 in the same patch (renameFile TSDoc still said "Atomic via fs.rename" after F2 changed the impl to link()+unlink()). 3 fixes (R17-1 renameFile TSDoc, R17-2 appendNote TSDoc enhancement, R17-3 docs/COMPARISON.md "5 models" missed v3.7.12 L4 instance) + 1 new invariant (R17-4 COMPARISON reranker honesty). Plus overclaim #8 (v3.7.14 orphan-tag procedural error caught by "Assert tag is on main" guard) + overclaim #9 (v3.7.14 F5 was permission-incomplete, `HTTP 403`, fixed via `permissions: contents: write`). 9 documented overclaim instances now. CLAUDE.md anti-patterns extended with 3 new rules. **816 tests** (+1 invariant). F5 release automation finally verified working end-to-end on v3.7.15 tag push.
- **v3.7.16 shipped (current)**: round-18 external audit response — 5th independent external audit since v3.6.0, on the v3.7.5 codebase (commit b9daf39). The v3.7.6→v3.7.15 cascade had already closed many findings; this patch addresses still-open critical + high-impact items. **10 fixes**: P1-1 OCR network-policy disclosure (stderr warning + SECURITY.md), P1-2 OCR 200-page default cap, P1-4 persistent-cache + privacy filter lifecycle, P1-5 watcher PDF lifecycle, P1-6 macOS case-insensitive write privacy bypass (canonicalize parent via realpath), P2-13 title-based write fail-on-ambiguity (silent data corruption), P2-14 validateNoteProposal privacy check, P2-15 FTS5 tag LIKE `%`/`_` escape, P2-16 graph_boost `#chunk-N` regex (fixes `C# Notes.md`), P3-23 PDF install hint v5.7.284, P3-28 safeFts5Query reserved-word quoting (contract change), P3-30 issue template ChatGPT + Claude Desktop. 14 architectural findings deferred to v3.8.0 backlog. **816 tests** (1 test contract change for P3-28).
- **v3.7+ backlog status**: All known audit findings from rounds 1–18 closed. v3.8.0 backlog: serve-http parity (P1-3), OCR concurrency/timeout (#2 beyond 200-page cap), search underfill (P2-7), FTS5/embedding chunking parity (P2-8), stateful session race (P2-10), HTTP server close cleanup (P2-11), doctor privacy filters (P2-12), npm package broken links (P2-18), canonical CLI docs completeness (P2-20), FTS gating wording (P3-21), heading tilde fences (P3-25), substring search contract (P3-26), HNSW metadata validation (P3-27), setup-snippet mkdir (P3-29) + round-14/15 originals. **No open audit items as of 2026-05-18 / 26 releases into the v3.6.0 → v3.7.16 cascade.**
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
