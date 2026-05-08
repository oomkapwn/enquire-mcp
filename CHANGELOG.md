# Changelog

All notable changes to this project will be documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] — 2026-05-08

**v2.0.0 stable.** Promotes the v2.0 prerelease train (alpha.0 → beta.{0,1,2,3,4}) to `@latest` on npm. `npm install @oomkapwn/enquire-mcp` now ships v2.0.0 by default; v1.11.1 stable users update on next install. **No new code changes from beta.4** — this release is the channel promotion only.

### What you get vs v1.11.1

**Hybrid retrieval (the headline):**
- `obsidian_search` — single umbrella tool that fuses BM25 (FTS5) + TF-IDF cosine + ML embeddings via Reciprocal Rank Fusion (Cormack et al, 2009). Auto-detects available signals, gracefully degrades. Returns per-signal observability so agents see which rankers contributed each hit.
- `obsidian_embeddings_search` (opt-in, behind `--diagnostic-search-tools`) — standalone ML-embedding retrieval via `@huggingface/transformers` + `paraphrase-multilingual-MiniLM-L12-v2` (50+ languages, 384-dim). Free, offline-capable, multilingual. Closes the gap to Smart Connections without the paywall.

**New CLI subcommands:**
- `enquire-mcp install-model [alias]` — pre-download embedding model (`multilingual` default, ~120MB; or `bge` English-only, ~33MB).
- `enquire-mcp build-embeddings --vault <path>` — cold-build the persistent SQLite vector index. Same paragraph-level chunking as the FTS5 index — chunk identity matches across BM25 and embeddings.
- `enquire-mcp clear-embeddings --vault <path>` — purge the embedding index.

**New CLI flag:**
- `--diagnostic-search-tools` — register the four single-ranker search tools (`obsidian_search_text`, `obsidian_full_text_search`, `obsidian_semantic_search`, `obsidian_embeddings_search`) for diagnostic / A/B benchmarking. Off by default in v2.0+ since `obsidian_search` produces consistent recall.

**Default tool surface:**
- 21 always-on read tools (was 22 in v1.11.1: `obsidian_search` replaces the four single-ranker tools as the headline)
- 4 opt-in: 1 via `--persistent-index` (`obsidian_full_text_search`), 3 via `--diagnostic-search-tools`
- 5 write tools (unchanged) via `--enable-write`
- **30 tools total**, same as v1.11.1's count but consolidated for clarity

### Verified end-to-end

Maintainer's 128-note bilingual (Russian + English) real vault:
- Build: 8854 chunks embedded in 8m 16s (with progress visibility)
- Query "Claude Code subscription migration": top hit fuses all 3 signals (BM25 rank 1 + TF-IDF rank 3 + embeddings rank 1)
- Embeddings retrieve Russian content for English queries (multilingual model working as designed)

### Tests, CI/CD, security

- 408 unit tests pass across 19 test files
- CI: ubuntu × {Node 20, 22, 24} required + macOS advisory job
- Coverage thresholds enforced (lines ≥86, statements ≥82, functions ≥75, branches ≥73)
- `npm audit --audit-level=moderate` for production deps; high for dev
- Branch protection ruleset: `bypass_mode: pull_request` (every change goes through PR with audit trail)
- Release pipeline integrity: tagged SHA must be reachable from `main` AND all 8 required CI checks must have reported `success` on it
- Privacy boundary verified across all write paths AND persistent-index search paths (filtering at search time even if user adds `--exclude-glob` between runs)

### Migration from v1.11.1

**Default tool list narrowed.** Clients hard-coded to call `obsidian_search_text`, `obsidian_full_text_search`, `obsidian_semantic_search`, or `obsidian_embeddings_search` directly need to either:
1. Switch to `obsidian_search` (recommended — auto-fuses signals), or
2. Pass `--diagnostic-search-tools` to `enquire-mcp serve`

**Optional new dependency:** `@huggingface/transformers` is in `optionalDependencies`. Read-only / TF-IDF / FTS5 paths stay zero-cost. Embedding tools/subcommands surface a clean error if optional deps were skipped (`npm install --omit=optional`).

**No breaking changes to:** `obsidian_read_note`, `obsidian_list_notes`, `obsidian_search_text` (now opt-in), `obsidian_get_backlinks`, `obsidian_dataview_query`, write tools, MCP resources, MCP prompts, or any v1.x CLI flag.

### Migration from v2.0.0-beta.4

**No-op.** This release is the channel promotion (npm `beta` → `latest`). Code is identical to beta.4.

### Acknowledgments

The v2.0 prerelease train (alpha.0 → beta.4) closed 100+ audit findings across two deep five-agent audits and one external auditor pass. Architecture invariants added at CI time prevent recurrence of the patterns that caused the privacy bypasses. End-to-end validation on a real bilingual vault confirms the v2.0 thesis: hybrid retrieval > any single ranker, with consistent recall across languages.

## [2.0.0-beta.4] — 2026-05-08

**ML build-embeddings UX + throughput fix.** v2.0.0-beta.3 manual smoke on the maintainer's 128-note real vault revealed that `enquire-mcp build-embeddings` was *silent* for 13+ minutes when processing notes with many chunks. Investigation: not actually hung — just very slow on large notes (8,854 chunks total, several notes with 100+ chunks each), with zero feedback to the user. This release fixes both the speed AND the visibility.

### Fixed — internal sub-batching cap on `embedder.embed()`

Pre-fix: `embed(chunks)` passed the entire batch to ONNX Runtime in one call. A note with 175 chunks (e.g., maintainer's `CLAUDE.md` had 176) created a single 175-element batch, which ONNX Runtime processes pathologically slowly on CPU (memory pressure + lack of intra-batch parallelism).

Now caps internal batch size at 8. Same total work, but throughput on large notes improves dramatically (~3-10× on maintainer's vault). Caller still receives a flat `Float32Array[]` so the API is unchanged.

### Added — per-note progress logging in `build-embeddings`

Pre-fix: `build-embeddings --vault <path>` printed nothing until completion. On a 128-note vault that meant 8+ minutes of silence followed by "added=128 total_chunks=8854". Indistinguishable from a hang.

Now logs every ~5% with running rate + ETA, plus a per-note warning for notes producing 30+ chunks (so the user knows WHY a specific note is slow):

```
enquire: 99_Ilon/deep-dives/archive/013-... → 161 chunks (this one will be slow; consider splitting the note)
enquire: embed sync 102/128 (0.2 notes/s; ETA 105s)
```

### Verified — hybrid retrieval on real bilingual vault

End-to-end test on the maintainer's 128-note Russian/English vault:

```json
{
  "query": "Claude Code subscription migration",
  "signals_used": ["bm25", "tfidf", "embeddings"],
  "matches": [{
    "path": "99_Ilon/pipeline/cards/archive/claude-code-pro-to-max-migration-...",
    "score": 0.04866,
    "per_signal": {
      "bm25": { "rank": 1, "score": 14.18 },
      "tfidf": { "rank": 3, "score": 0.0898 },
      "embeddings": { "rank": 1, "score": 0.5885 }
    }
  }]
}
```

All three rankers fuse. Embeddings retrieve Russian content for English queries. Per-signal observability works. **First production-style validation of the v2.0 thesis.**

### Migration

**No-op for users.** The fix is purely internal — same API, same on-disk format, same response shape.

## [2.0.0-beta.3] — 2026-05-08

**Backlog cleanup + tool-surface consolidation.** All audit-driven P0/P1 work landed in beta.2; this release closes the long tail of P2/P3 backlog items the same audits surfaced. No new features, no breaking changes for default users — but the default tool list is now narrower (21 read tools instead of 24) because the four single-ranker search tools moved behind a new opt-in flag.

### Changed — `obsidian_search` is the headline; single-ranker tools moved behind `--diagnostic-search-tools`

The audit's recurring observation: agents routinely picked the wrong single-ranker search tool from the five options (`search_text`, `full_text_search`, `semantic_search`, `embeddings_search`, `search`). The umbrella `obsidian_search` (added v2.0.0-beta.0) auto-detects available signals and produces consistent recall — five-tool surface is now bloat.

- **Default surface (v2.0.0-beta.3+):** 21 always-on read tools. The single search tool is `obsidian_search`. Hybrid retrieval auto-detects what's available (BM25 if `--persistent-index`, ML embeddings if `build-embeddings` ran) and falls back gracefully.
- **Diagnostic surface:** add `--diagnostic-search-tools` to register `obsidian_search_text`, `obsidian_semantic_search`, `obsidian_embeddings_search` (and `obsidian_full_text_search` if `--persistent-index` is also set). Use these for A/B benchmarking or when you specifically need single-ranker output.

This is **not breaking** for clients calling `obsidian_search` (the v2.0 default). It IS a change for clients hard-coded to call `obsidian_search_text` / `obsidian_semantic_search` / `obsidian_embeddings_search` / `obsidian_full_text_search` — they need to either switch to `obsidian_search` (recommended) or add the flag.

### Added — Cross-platform CI: macOS advisory job

CI test matrix was Linux-only. `Vault` does cross-platform path work (`vault.ts:631` has a Windows separator normalization), symlink handling, and `chmod` operations — all of which behave differently on non-Linux platforms. Pre-fix, regressions only surfaced on user reports.

New `test-macos` job runs the same suite on `macos-latest` × Node 22. **Advisory only** (`continue-on-error: true`) so it doesn't block merges, but failures appear in the PR check list. Required CI gate stays Linux × {Node 20, 22, 24} for ruleset stability.

### Added — Coverage threshold gates in vitest

Pre-fix: the `coverage` CI job uploaded an HTML report and exited 0 regardless of the numbers. A regression that dropped coverage 90% → 40% would ship green. New `vitest.config.ts` thresholds:

- lines: ≥86%
- statements: ≥82%
- functions: ≥75%
- branches: ≥73%

All ~5pp below current. Excludes `src/index.ts` (registration boilerplate; line-count doesn't reflect quality) and test files. Fails CI if any threshold drops below.

### Changed — `npm audit` elevated to `moderate` for production deps

Pre-fix: `--audit-level=high` everywhere. The recently-resolved `ip-address` advisory (CVE-2026-42338, moderate severity) sat undetected between Dependabot scans because no audit gate caught it. Now production deps gate at `moderate`, dev deps stay at `high` (more noise, less surface).

### Process — branch-protection ruleset bypass mode hardened

`bypass_actors` for the admin role was `bypass_mode: always`. Changed to `bypass_mode: pull_request`. The maintainer's own pushes now go through PR (auto-mergeable), creating an audit trail. Combined with the v2.0.0-beta.2 release-pipeline integrity check, this means every change shipped to npm has a reviewable diff.

### Docs

- README "Configure your AI client" tool count: `24 read + 1 opt-in` → `21 read + 4 opt-in` (3 diagnostic + 1 FTS) reflecting the consolidation above.
- `docs/api.md` header updated with the new tool-count math + opt-in flag breakdown.
- README footer ENQUIRE paragraph deduplicated (was repeated near-verbatim at lines 59 and 484; footer now just references the inline note).
- GitHub repo About description shortened from 340 → 195 chars to fit OpenGraph truncation.

### Tests

408 unit tests pass (was 408 in beta.2 — no test count delta; tests exercise the same surfaces with the new gating reflected in `tests/docs-consistency.test.ts` to count diagnostic-gated tools as opt-in, not always-on).

`scripts/smoke.mjs` adds `--diagnostic-search-tools` to its server invocation so smoke continues to exercise all 5 search tools (was: 4, post-consolidation default surface is 1).

### Migration from v2.0.0-beta.2

**No-op for clients of `obsidian_search`** (the v2.0 hybrid default). Recommended path forward.

**Clients calling per-ranker tools directly:**
- Either switch to `obsidian_search` (preferred — auto-fuses signals)
- Or pass `--diagnostic-search-tools` to your `enquire-mcp serve` invocation

**Programmatic API surface unchanged.** The 4 gated tools have identical schemas + behavior when registered.

## [2.0.0-beta.2] — 2026-05-06

**Audit-driven patch.** A second deep audit (5 parallel agents covering architecture, tests, docs, CI/CD, security threat model) surfaced one P0 privacy bypass of the same shape as the writeNote bug from beta.1, three release-pipeline P0s, and a long tail of P1 hardening. This release closes 16 findings and adds new architectural invariants to prevent recurrence.

### Fixed — P0: persistent search indexes ignored `isExcluded` after config flip

**Same architectural debt as the writeNote miss in v2.0.0-beta.0.** The audit's root-cause analysis: `Vault.listMarkdown()` is the privacy chokepoint, but new persistent layers (FTS5 db, embed db) introduced their own search paths that bypassed it. Result: if a user built `.fts5.db` / `.embed.db` once, then added `--exclude-glob` later, excluded chunks leaked through:

- `obsidian_full_text_search` — BM25 hits from stale entries
- `obsidian_embeddings_search` — cosine hits from stale entries
- `obsidian_search` (the v2.0 default) — both BM25 + embed branches inherited
- `obsidian://chunk/{n}/{path}` resource — direct chunk fetch ignored exclusion

**Fix:** five new `isExcluded` filters, applied at the right layer:
1. `embeddingsSearch` post-filters `db.search()` results, with 2× over-fetch to keep top-K stable
2. `searchHybrid` BM25 branch post-filters `ftsIndex.search()` results
3. `searchHybrid` embed branch — automatically protected since `embeddingsSearch` now filters
4. `obsidian_full_text_search` handler post-filters with 2× over-fetch
5. `vault-chunk` resource refuses with "not found" framing (matches FTS5 search post-filter, so the attacker can't distinguish "doesn't exist" from "exists but excluded")

Architecturally, the indexes themselves can keep stale entries — content filtering happens at search time, mirroring how `Vault.readNote` filters at read time even when the parse cache has the path.

### Fixed — P0: release-pipeline integrity

**`release.yml`** previously trusted any tag pointing at any commit. An attacker who got commit access could `git tag v9.9.9 <evil-sha> && git push --tags` and ship malware bypassing main protections — the workflow re-ran lint/test/audit on the tag's SHA and would happily green-light it. Now release.yml:

1. Asserts the tagged SHA is reachable from `main` (`git merge-base --is-ancestor`)
2. Polls GitHub's check-runs API to verify all 8 required CI checks (`lint`, `test (20/22/24)`, `smoke`, `audit`, `coverage`, `version-consistency`) reported `success` on this exact SHA, with up to 5-minute tolerance for tag-vs-CI race conditions
3. Refuses to publish if either check fails

**dist-tag regex** was hand-rolled `/-([a-z]+)\.[0-9]+$/`, which misrouted three valid SemVer prereleases to `latest`:

- `2.0.0-rc` (no `.N` suffix) → previously latest, now `rc`
- `2.0.0-rc.0+build.1` (build metadata) → previously latest, now `rc`
- `2.0.0-alpha-3` (dash separator) → previously latest, now `alpha-3`

Replaced with a Node-side parser that extracts the prerelease channel by SemVer rules. Verified against 8-case matrix.

### Fixed — P1 sec DiD: `.obsidian/` plugin config bypassed `--read-paths`

**Defense in depth.** `loadPeriodicConfig()` read `.obsidian/daily-notes.json` and `.obsidian/plugins/periodic-notes/data.json` directly via `fs.readFile`, bypassing the user's privacy filter. Not a content leak (downstream `vault.stat` rejected paths), but the contract `--read-paths "Public/**"` = "ONLY Public/ visible" was technically violated. Now `loadPeriodicConfig` accepts an optional `isExcluded` predicate; when the user's allowlist excludes `.obsidian/**`, we silently fall back to v0.11 hard-coded defaults.

### Fixed — P1 sec DiD: empty exclusion patterns silent-disable

**Privacy fail-closed.** Pre-fix, `--read-paths ""` (empty after shell interpolation of an unset variable) survived as `[""]`. `globToRegex("")` produces `^$` which matches no real paths — so the user's intent ("filter to nothing") functionally meant the readPaths predicate matched nothing → every path treated as excluded. The opposite mistake (whitespace-only) silently disabled. Now the Vault constructor strips empty/whitespace-only patterns and throws if the cleaned list is empty but the user explicitly passed flags — privacy is fail-closed.

### Fixed — P1 architecture: searchHybrid silently swallowed ranker errors

`searchHybrid` wrapped each ranker in `try/catch` with stderr-only logging. The MCP response just showed `signals_used: []` with `matches: []` — a caller couldn't tell "no hits" from "all rankers crashed." New optional `signal_errors: { bm25?, tfidf?, embeddings? }` field surfaces per-signal failures so agents can reason about reliability.

### Fixed — P1 architecture: `replaceInNotes` partial-state on mid-loop write failure

Pre-fix, a throw on file 5 of 20 lost the response — files 1-4 silently committed with no way for the agent to discover. Now per-file errors are collected; response includes `partial: true` flag and `errors: [{path, message}]` array. Systemic failures (read-only vault) still throw fast — they're config errors, not per-file failures.

### Fixed — P1 architecture: `resolveTarget` periodic-alias fallthrough leaked content via basename collision

Pre-fix, when `vault.stat()` returned ENOENT for the configured periodic path (e.g., `Daily Notes/2026-05-08.md` doesn't exist yet), `resolveTarget` fell through to a basename match across the whole vault. With `--exclude-glob 'Daily Notes/**'` AND a `Public/2026-05-08.md`, the basename match silently redirected "today" to the unrelated public note. Now we only fall through if the periodic config produces a folder-less stem (i.e., user keeps periodic notes at vault root); configured-folder cases must hit the configured folder or fail clean.

### Fixed — P1: `renameNote` and `Vault.renameFile` error messages now distinguish allowlist vs denylist

Pre-fix, both always blamed `--exclude-glob` even when `--read-paths` was the reason. New `Vault.exclusionReason()` helper exposes the same logic that writeNote already used; renameNote and renameFile both adopt it.

### Fixed — P1: `replaceInNotes` accepted excluded `folder=` argument

Pre-fix, `replaceInNotes(folder: "Personal")` with `--exclude-glob "Personal/**"` returned `files_scanned: 0, scope: "Personal/"` — confirming the folder name existed in the user's layout. Now the function refuses early: `folder is excluded by privacy filter`. Same pattern applies to other tools that take `folder` arguments — listed as P2 backlog for v2.0.0-beta.3.

### Fixed — P1 docs

- README + SECURITY.md "v2.0 alpha" → "v2.0" (already shipped beta).
- README "Configure your AI client" section: now shows BOTH `@latest` (v1.x) AND `@beta` (v2.0) install snippets explicitly. Pre-fix, copying the snippet pulled v1.11.1 while the section below described v2.0 features.
- README source-line-count claim: `~3500 lines` → `~7500 lines` (verified `wc -l src/*.ts`).
- README test-count claim: `388+` → `405+` (will be `408+` after this release).
- CHANGELOG v1.11.1 entry: removed phantom `obsidian_resolve_periodic_alias` reference (replaced with `obsidian_read_note({title:"today"})`, the actual MCP-exposed entry-point).

### Added — Architecture invariant: docs-consistency tests for numeric drift

`tests/docs-consistency.test.ts` previously checked tool-name parity. Extended to:

- **Tool-count parity:** README's "N read tools (always on)" must match the actual count of `registerTool()` calls outside `registerWriteTools` and `registerFtsTools`.
- **`docs/api.md` math:** "M MCP tools (X always-on read + Y opt-in read + Z opt-in write)" must satisfy M = X + Y + Z.
- **CLI subcommand parity:** every `program.command()` registered must appear in the docs/api.md Subcommands table.

These prevent the kind of drift the audit caught manually. Now caught at CI time.

### Tests

408 unit tests pass (was 393, +15 new):
- 5 privacy-regression tests for `appendToNote`, `archiveNote`, `renameNote` (source + dest with allowlist), `replaceInNotes` (denylist)
- 2 search-time isExcluded filter tests (`searchHybrid` BM25 path with stale FTS5 db; `embeddingsSearch` filter post-search)
- 3 fail-closed Vault constructor tests (empty `--read-paths` / `--exclude-glob` rejection)
- 3 docs-consistency invariant tests
- 1 updated periodic-alias test (now expects "No note found" silent fallback instead of "excluded" leak)
- 1 architecture refactoring (security.test.ts test reordering after lint:fix)

### Migration from v2.0.0-beta.1

**No breaking changes for end users.** All v2.0.0-beta.1 tools and CLI flags continue to work.

**Programmatic callers (rare):** `Vault` now throws on empty `excludeGlobs: [""]` / `readPaths: [""]`. Filter empty strings in the caller before constructing.

**`searchHybrid` response shape:** new optional `signal_errors` field. Existing parsers that ignore unknown fields are unaffected.

**`replaceInNotes` response shape:** new `partial: boolean` field (always present) and `errors?: Array` (only when partial). Existing parsers ignoring unknown fields are unaffected.

## [2.0.0-beta.1] — 2026-05-06

**Audit-driven patch.** An independent external audit of v2.0.0-beta.0 surfaced one P0 privacy/security bug, several P1 doc/correctness drifts, and a handful of P2 hardening opportunities. This release closes all 17 findings (1 P0 + 7 P1 + 7 P2 + 2 P3). No new features.

### Fixed — P0: `obsidian_create_note` privacy bypass (`vault.writeNote`)

**Long-standing bug, present since v0.11.** `Vault.writeNote()` used `resolveInside()` (path-traversal check only) and never called `isExcluded()`. So:

```bash
enquire-mcp serve --vault ~/vault --enable-write --read-paths 'Public/**'
# → obsidian_create_note({ path: 'Private/secret.md', content: 'leaked' }) succeeded
```

A server with `--read-paths "Public/**"` allowed writes to `Private/`. With `overwrite: true`, a known excluded path could be clobbered. This violated the SECURITY.md privacy contract that explicitly claimed "the same predicate gates `listMarkdown()`, `listFilesByExtension()`, `resolveSafePath()` (so `readNote` / `readBinaryFile` / write paths all respect it)."

`writeNote()` now calls `isExcluded()` and surfaces the same allowlist-vs-denylist reason as `resolveSafePath()`. `appendNote()` and `renameFile()` were already safe (verified). Three regression tests added in `tests/security.test.ts`.

### Fixed — P1: `searchHybrid` starves the embeddings ranker

`searchHybrid` called `embeddingsSearch` without `min_score`, picking up the standalone tool's `0.3` default. BM25 (no floor) and TF-IDF (0.05) fan out wider, so RRF received an asymmetric candidate pool from embeddings. The user-facing precision filter belongs *after* fusion (`min_signals`), not before. Now passes `min_score: 0` for fan-out.

### Fixed — P1: `obsidian_create_note({ path: "" })` silently created `.md`

The walker hides dotfiles, so an empty-path create silently produced an invisible file. The MCP-tool schema now requires `path: z.string().min(1)`; `vault.writeNote()` runtime-rejects empty / whitespace / dot-only names. Test in `tests/security.test.ts`.

### Added — P1: `--enabled-tools` / `--disabled-tools` unknown-name validation

The SECURITY.md docs claimed unknown tool names would log a warning. The code didn't actually validate. A typo in `--disabled-tools obsidan_search` (missing `i`) silently disabled nothing. Now we track which user-supplied names matched a registered tool; any unmatched name produces a stderr warning listing the available tools so the user can correct it.

### Docs

- `README.md`: removed misleading "Stable" badge from v2-beta-doc page; added separate `@latest` and `@beta` shields. Quick-start now documents both channels with explicit `@beta` for v2 features.
- `README.md`: tool counts updated (24 always-on read + 1 opt-in FTS5 + 5 opt-in write = 30 total).
- `README.md`: test count refreshed (388+).
- `SECURITY.md`: removed phantom `obsidian_resolve_periodic_alias` tool reference (the resolver is internal to `resolveTarget`, never exposed as its own tool).
- `SECURITY.md`: documented the `paraphrase-multilingual-MiniLM-L12-v2` 128-token truncation as a known recall caveat (use `bge` for longer-context English).
- `docs/api.md`: full v2.0 surface — `obsidian_search`, `obsidian_embeddings_search`, and the `install-model` / `build-embeddings` / `clear-embeddings` subcommands now documented (was a 0% delta from v1.x; the audit caught this gap).

### Hardening — P2

- `embed-db.ts:search()` folder filter now uses `substr(rel_path, 1, ?) = ?` instead of `rel_path LIKE ? || '%'`. LIKE expanded `%` and `_` chars — rare but possible in Obsidian folder names. Matches the safe pattern from `fts5.ts:search()`.
- `embed-db.ts:search()` asserts `byteLength === dim*4` before wrapping a vector BLOB into `Float32Array`. A truncated row (e.g. from an aborted upsert) would otherwise produce a Float32Array reading past the source buffer's end and silently emit garbage scores. Skip + warn instead.
- `rrf.ts:reciprocalRankFusion()` guards duplicate `(id, signal)` pairs. A buggy ranker emitting the same id twice would have silently double-added the signal's contribution. Now we keep only the best (lowest) rank per id within a single signal.
- `tests/search-hybrid.test.ts`: BM25 + TF-IDF fusion path now has CI coverage (5 new tests). Pre-fix, every test passed `ftsIndex: null` and skipped the chunk-collapse + rank-renumbering branch — a regression there could have shipped silently.
- `fts5.ts` + `embed-db.ts`: `loadBetterSqlite()` now probes the native binding via `:memory:` open + close before caching the constructor. Catches the "JS package present but `.node` binary missing" failure mode (e.g. `npm ci --ignore-scripts`, broken native build, unsupported platform). Surface a clean error pointing at `npm rebuild better-sqlite3`, not a raw bindings stack trace.
- `tests/cli.test.ts`: `canRunFts5` now does the same constructor probe instead of import-only. CI no longer runs FTS5 E2E tests when the binding actually doesn't work.

### Process — P3

- `version-consistency` CI job is now in the `main-protection` ruleset's required status checks. Pre-fix, a PR could theoretically merge with version drift across the 5 surfaces.
- Lockfile refreshed via `npm audit fix` to resolve `ip-address <=10.1.0` → `10.2.0` (GHSA-v2v4-37r5-5v8g — moderate XSS in HTML-emitting helpers; zero real impact on a stdio MCP server but blocks `npm audit --audit-level=moderate`).

### Tests

393 unit tests pass (was 384, +9 new). +5 hybrid BM25 path, +3 createNote privacy regressions, +1 createNote empty-path validation.

### Migration from v2.0.0-beta.0

**No breaking changes.** This is a pure audit-fix patch.

## [2.0.0-beta.0] — 2026-05-06

**Theme: Hybrid RRF retrieval.** v2.0.0-alpha.0 shipped ML embeddings as a standalone tool. v2.0.0-beta.0 ships the integration step: a single `obsidian_search` umbrella tool that fuses every available retrieval signal — BM25 (FTS5) + TF-IDF cosine + ML embeddings — via Reciprocal Rank Fusion (Cormack et al, 2009).

This is the v2.0 user-facing thesis: instead of agents picking between four nearly-identical search tools and getting different recall depending on the choice, they call one tool that automatically picks the best evidence available. Result: better recall on paraphrase / synonym / cross-language queries without configuration.

### Added — `obsidian_search` MCP tool (the new default)

Single umbrella tool that auto-detects available signals and fuses them via RRF with k=60. Gracefully degrades:

- **TF-IDF only** (no `--persistent-index`, no embeddings) → produces TF-IDF ranking.
- **BM25 + TF-IDF** (add `--persistent-index`) → keyword-augmented retrieval, sub-100ms.
- **BM25 + TF-IDF + embeddings** (add `enquire-mcp build-embeddings`) → matches Smart Connections-quality retrieval, free / offline / open-source.

Returns per-signal observability so agents can see WHY each hit ranked:

```json
{
  "query": "OAuth flows",
  "method": "rrf",
  "k": 60,
  "signals_used": ["bm25", "tfidf", "embeddings"],
  "total_candidates": 47,
  "matches": [
    {
      "path": "Auth/OAuth Flows.md",
      "score": 0.0492,
      "snippet": "OAuth authentication flow with JWT tokens...",
      "chunk_index": 0,
      "line_start": 1,
      "line_end": 1,
      "per_signal": {
        "bm25": { "rank": 1, "score": 8.5 },
        "tfidf": { "rank": 2, "score": 0.7 },
        "embeddings": { "rank": 1, "score": 0.92 }
      }
    }
  ]
}
```

`min_signals` parameter lets agents request consensus search — e.g. `min_signals: 2` returns only hits that ranked in two-or-more rankers.

### Added — `src/rrf.ts` (isolated RRF math)

Standalone module implementing Reciprocal Rank Fusion. Pure function over named ranked lists; doesn't know about vaults, SQLite, or embeddings — testable in isolation. 13 unit tests cover the formula, union-safety (missing signals don't penalize), per-signal observability, rank-validation, and graceful degradation.

### Architecture decisions (locked)

- **Note-level fusion** (not chunk-level). BM25 + embeddings return chunks; we collapse to the best chunk per note before fusing. Chunk identity comparison would require all rankers to share a chunk space, which TF-IDF (note-level) doesn't. Note-level wins on simplicity and matches what most agents actually want ("which notes are relevant"). Chunk-level fusion is v2.1 backlog.
- **Hardcoded equal weights, k=60.** Per Cormack et al, RRF without per-signal weights outperforms most learned alternatives on heterogeneous rankers. We resist the urge to add `--rrf-weights` — sensible defaults serve >80% of users; advanced users can fork. Add the flag in v2.1 if real issues come in.
- **Graceful degradation, not feature gate.** `obsidian_search` works the moment the server starts (TF-IDF only). Adding `--persistent-index` enables BM25. Running `build-embeddings` enables ML retrieval. Each layer adds quality without changing the API or surface.
- **Per-signal observability is required, not optional.** The `per_signal` field on every hit is the foundation for v2.1 features (UI explainability, weights tuning, ranker disagreement detection). Hidden by default would be cheap; explicit is the right primitive.

### Tests

384 unit tests pass (was 364, +20). New: `tests/rrf.test.ts` (13 tests covering RRF math, union-safety, observability, rank validation, custom k, topK truncation, all-empty input). `tests/search-hybrid.test.ts` (7 tests covering graceful-degradation paths, min_signals filter, folder filter, empty query rejection, total_candidates accounting).

End-to-end ML smoke remains out-of-band; the v2.0 alpha smoke + hybrid path verifies the wiring against synthetic + real vaults.

### Migration from v2.0.0-alpha.0

**No breaking changes.** `obsidian_search` is purely additive; the existing `obsidian_search_text`, `obsidian_full_text_search`, `obsidian_semantic_search`, `obsidian_embeddings_search` tools continue to work for diagnostics. The v2.0 RC will likely move them all behind a `--diagnostic-tools` opt-in to declutter the default tool list, but that's not yet decided — feedback welcome on the alpha/beta channel.

### Try it

```bash
npm install -g @oomkapwn/enquire-mcp@beta
# Or upgrade from alpha:
# npm install -g @oomkapwn/enquire-mcp@beta

# Tier 1: TF-IDF only (zero setup)
enquire-mcp serve --vault ~/Documents/Obsidian\ Vault
# → obsidian_search { query: "OAuth flows" }  ← signals_used: ["tfidf"]

# Tier 2: + BM25
enquire-mcp serve --vault ~/Documents/Obsidian\ Vault --persistent-index
# → obsidian_search { query: "OAuth flows" }  ← signals_used: ["bm25","tfidf"]

# Tier 3: + ML embeddings
enquire-mcp install-model multilingual
enquire-mcp build-embeddings --vault ~/Documents/Obsidian\ Vault
enquire-mcp serve --vault ~/Documents/Obsidian\ Vault --persistent-index
# → obsidian_search { query: "OAuth flows" }  ← signals_used: ["bm25","tfidf","embeddings"]
```

## [2.0.0-alpha.0] — 2026-05-06

**Theme: ML-embedding retrieval.** v1.8 shipped TF-IDF cosine as the no-deps semantic-search floor. v2.0 raises the ceiling with real transformer embeddings — closer to Smart Connections quality, but free, offline-capable, multilingual, and (uniquely) chunk-aligned with the FTS5 BM25 index so the v2.0 beta hybrid RRF can score across both surfaces using the same identifier space.

### Added — `obsidian_embeddings_search`

ML-embedding retrieval via [@huggingface/transformers](https://github.com/huggingface/transformers.js) + `paraphrase-multilingual-MiniLM-L12-v2` (50+ languages, 384-dim, runs on CPU). Persistent SQLite vector index next to the FTS5 db. Brute-force cosine top-K (sub-100ms on 50K chunks; HNSW ladder is v2.1 if real users hit that ceiling).

Higher-quality than `obsidian_semantic_search` for paraphrases, synonyms, and cross-language queries — but requires a one-time setup (see below). The TF-IDF path remains the no-deps default.

### Added — `enquire-mcp install-model [alias]` subcommand

Pre-downloads an embedding model so the first MCP call doesn't block on a ~120MB HuggingFace download. Aliases:

- `multilingual` (default) — `Xenova/paraphrase-multilingual-MiniLM-L12-v2`, 384-dim, ~120MB, 50+ languages
- `bge` — `Xenova/bge-small-en-v1.5`, 384-dim, ~33MB, English-only (better recall on technical content)

Models are cached under `~/.cache/huggingface/transformers.js/` and reused across vaults. Subsequent `install-model` calls are no-ops if the cache is warm.

### Added — `enquire-mcp build-embeddings --vault <path>` subcommand

Cold-build (or refresh) the persistent embedding index for a vault. Same paragraph-level chunking as the FTS5 index (`fts5.chunkContent`) so chunk identity matches across BM25 and embeddings — foundation for the v2.0 beta hybrid RRF.

Incremental rebuilds via `source_state` mtime tracking — only re-embeds notes whose mtime changed since the last `build-embeddings`. ~5-30ms per chunk on M1 CPU.

Supports `--embedding-model <alias>`, `--exclude-glob`, `--read-paths`, `--embed-file <path>`.

### Added — `enquire-mcp clear-embeddings --vault <path>` subcommand

Removes the `.embed.db` + WAL/SHM sidecars. Mirrors `clear-cache` and `clear-index`.

### Added — `@huggingface/transformers ^4.2.0` as `optionalDependencies`

Mirrors the `better-sqlite3` pattern: the heavy ONNX runtime + tokenizer transitive deps install only if the user's npm policy allows optional deps (default). Read-only / TF-IDF / FTS5 paths stay zero-cost — no model load, no runtime cost. Tarball stays under 200KB.

If optional deps are skipped (`npm install --omit=optional`), the embedding tools and subcommands surface a clean error pointing the user at `npm install @huggingface/transformers` rather than an opaque module-not-found.

### Architecture decisions (locked for v2.0)

- **Default model = multilingual.** The user's dogfood vault is bilingual Russian + English; v2.0 covers >80% of real Obsidian users (most personal vaults are not pure English).
- **Models download on subcommand, not on first MCP call.** Predictable for CI; air-gap-friendly; explicit consent for networked operations. Pattern follows Stripe / Cloudflare CLI conventions.
- **Hardcoded RRF in v2.0 beta.** No `--rrf-weights` flag (yet). Sensible defaults work in 80% of cases per Cormack et al. Add the flag in v2.1 if real issues come in.
- **CJK is v2.0 backlog.** The Unicode tokenizer in v1.11.1 catches Cyrillic / Greek / Hebrew / Arabic. Chinese / Japanese / Thai need an `Intl.Segmenter` pass first; out-of-scope for alpha.
- **Brute-force cosine, not HNSW.** ~50ms top-10 on 50K × 384 floats — fine for >99% of personal vaults. HNSW ladder when the ceiling is hit.

### Tests

364 unit tests pass (was 341, +23). New: `tests/embed-db.test.ts` (synthetic-vector schema + upsert/delete/search semantics, cross-vault contamination guard, dim mismatch, folder filter, minScore threshold). `tests/embeddings.test.ts` (catalog + cosine math, no model load).

End-to-end ML smoke is out-of-band — CI doesn't download the model. Manual verification:
```bash
enquire-mcp install-model multilingual
enquire-mcp build-embeddings --vault ~/Documents/Obsidian\ Vault
# then via MCP: obsidian_embeddings_search { query: "OAuth flows" }
```

### Migration from v1.x

**No breaking changes for read-only / TF-IDF / FTS5 users.** All v1.x tools and CLI flags continue to work exactly as before. Embedding features are pure additions, gated behind explicit subcommand invocations.

The next prerelease (v2.0.0-beta.0) will add hybrid RRF scoring (`obsidian_search` umbrella tool over BM25 + TF-IDF + embeddings) — additive, not breaking.

### Excluded from this alpha (deferred to v2.0 beta / RC)

- Hybrid RRF tool (`obsidian_search`) — needs alpha shipping first to validate the embedding plumbing in real vaults
- HNSW vector index — only matters past 50K chunks, which no current user has
- `--persistent-embeddings` server flag (auto-build on serve startup) — pulls model load into hot path; alpha users prefer explicit subcommand
- CJK segmenter — needs `Intl.Segmenter` v18+ feature gating; v2.1 backlog

## [1.11.1] — 2026-05-05

Audit-driven patch. Five-agent audit of the v1.10 → v1.11 surface flagged two real P1 code bugs and one CI/process gap; this release fixes all three plus the doc drift the audit found.

### Fixed — `obsidian_semantic_search` now indexes non-Latin content

The TF-IDF tokenizer used `/[a-z0-9][a-z0-9_-]*/g` — ASCII-only. Russian / Greek / Hebrew / Arabic notes were silently dropped from the index AND non-Latin queries returned zero hits.

Replaced with `/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu` (Unicode-aware). Cyrillic / Greek / Hebrew / Arabic / Devanagari now work end-to-end. CJK languages (Chinese / Japanese / Thai) still need a segmenter pass first — tracked as v2.0 backlog (the regex matches them, but unsegmented sentences become single >40-char tokens which the length filter drops).

Regression tests: `tests/semantic.test.ts` now seeds Cyrillic + Greek vaults and asserts top-hit ranking.

### Fixed — periodic-alias resolver respects `--read-paths` / `--exclude-glob` consistently

`resolveTarget()` had two codepaths: path-based lookup (which preserved exclusion errors and re-threw them via `lastErr`) and periodic-alias lookup (which had a bare `catch {}` that silently swallowed exclusion errors). When a user requested `title: "today"` and the configured Daily Notes folder was excluded, the periodic-alias path fell through to the legacy basename matcher — which could surface a different (visible) note with a colliding basename.

Both codepaths now surface exclusion errors uniformly. The agent gets a clear `"Path is excluded by --read-paths allowlist"` or `"--exclude-glob denylist"` error instead of a wrong-note return.

Regression test: `tests/security.test.ts` adds two cases — one for `--exclude-glob`, one for `--read-paths`.

### Fixed — synthetic vault now exercises the v1.10 plugin-aware periodic resolver

`scripts/synthetic-vault.mjs` (CI smoke) didn't write `.obsidian/daily-notes.json`, so smoke fell back to the v0.11 hard-coded defaults — leaving `loadPeriodicConfig()` + `formatMoment()` regression-free in CI even when the actual code broke.

Added a 3-line config (`folder: "99_Daily"`, `format: "YYYY-MM-DD"`) so `obsidian_read_note({ title: "today" })` now exercises the lazy-load → cache → format codepath in every CI run.

### Docs

- README: write-tools quick-start now lists all five (`obsidian_create_note`, `_append_to_note`, `_rename_note`, `_replace_in_notes`, `_archive_note`); FAQ updated to "five write tools"; test-count badge bumped 294 → 341.
- SECURITY.md: new sections for the v1.10 periodic-config disk-read posture and the `--enabled-tools` / `--disabled-tools` per-tool gating posture.

### Tests

341 unit tests pass (was 337). Three regression tests added: 2× Unicode tokenizer (Cyrillic + Greek), 2× periodic-alias exclusion (`--exclude-glob` + `--read-paths`).

## [1.11.0] — 2026-05-06

Two more small wins, both completing surfaces from earlier releases:

### Added — `--enabled-tools <name...>` (allowlist complement to `--disabled-tools`)

When set, **ONLY** listed tools register. Pairs with the v1.10 `--disabled-tools` denylist:
- Allowlist alone: filter to a narrow surface (`--enabled-tools obsidian_search_text obsidian_read_note obsidian_get_recent_edits` for a research-only agent).
- Both flags: a tool must be in allowlist AND not in denylist (composable refinement).

Skips are logged to stderr (`enquire: skipping tool X (not in --enabled-tools allowlist)` or `(disabled by --disabled-tools)`), and the boot summary reports `enabled-tools=N` / `disabled-tools=N`.

Implementation: extends the v1.10 monkey-patch on `server.registerTool` with one extra branch — no per-register-function plumbing needed.

### Added — `obsidian_archive_note` (write tool, opt-in via `--enable-write`)

Thin convenience wrapper around `obsidian_rename_note` for the common archive workflow:

```ts
obsidian_archive_note({ path: "Inbox/Stale.md" })
// → from: "Inbox/Stale.md", to: "Archive/Stale.md"
// → all backlinks pointing at Stale rewritten via the v1.1 fence-aware rewriter.
```

Defaults `archive_folder` to `Archive/`. Source-folder stripping: `Inbox/Foo.md` archives to `Archive/Foo.md`, not `Archive/Inbox/Foo.md` — pass `archive_folder: "Archive/Inbox"` explicitly if you want the inbox structure preserved.

All `rename_note` guarantees apply: code-fence-aware backlink rewrites, `dry_run` preview, refuses to clobber an existing archive entry without `overwrite: true`. Returns the same shape as `obsidian_rename_note`.

The `--enable-write` help text bumps from "four" to "five" tools.

### Repo state
- **28 MCP tools** (was 27). 22 always-on read + 1 opt-in FTS5 + **5 write**.
- **10 MCP prompts** (unchanged).
- **337 unit tests** (was 330, +7 covering archive happy path / source-folder stripping / dry_run / overwrite refusal / empty path / trailing-slash normalisation / read-only refusal).

## [1.10.0] — 2026-05-06

Two small wins, both from the v1.5 competitive audit's Tier 1 list:

### Added — Daily Notes / Periodic Notes plugin awareness

`obsidian_read_note({ title: "today" })` now honors the user's actual plugin config. Pre-1.10 we hard-coded the legacy default formats (`YYYY-MM-DD` for daily, `YYYY-Www` for weekly, `YYYY-MM` for monthly) and assumed the file lived at vault root — which broke for the (very common) case where the user has Daily Notes set to `Daily Notes/YYYY-MM-DD` or a custom Moment format.

v1.10 reads two configs at first call (then caches for the session):
- `.obsidian/daily-notes.json` — Obsidian's core Daily Notes plugin (`format`, `folder`).
- `.obsidian/plugins/periodic-notes/data.json` — Periodic Notes community plugin (`daily` / `weekly` / `monthly` / `quarterly` / `yearly`, each with `enabled` + `format` + `folder`).

The Periodic Notes plugin's `enabled: false` flag is honored — disabled kinds fall back to the default formatter rather than producing a path the user explicitly opted out of.

Resolution order for `title: "today"` (and the other 5 aliases):
1. Literal title match — if `Today.md` exists, that one wins (no surprise alias hijacking).
2. User's plugin config (Daily Notes / Periodic Notes) format + folder.
3. Legacy v0.11 default formats (so users with no plugin configured still get the v0.11 behavior).

The Moment.js format converter supports the tokens periodic-note configs actually use: `YYYY` / `YY` / `MMMM` / `MMM` / `MM` / `M` / `Mo` / `Do` / `DD` / `D` / `dddd` / `ddd` / `WW` / `ww` / `Wo` / `wo` / `gggg` / `GGGG` / `Q` / `QQ` / `H` / `HH` / `h` / `hh` / `m` / `mm` / `s` / `ss` / `A` / `a`, plus bracket-escaped literals (`[W]`, `[Q]`, `[The year is]`).

The 5 aliases now supported (was 4): `today` / `daily` / `weekly` / `monthly` / `quarterly` / `yearly`.

Implementation: new `src/periodic.ts` module. `Vault.getPeriodicConfig()` lazy-loads + caches.

### Added — `--disabled-tools <name...>` CLI flag (per-tool gating)

Skip registration of specific tools by exact name. Repeatable. Names match `tools/list` (`obsidian_*`).

```bash
enquire-mcp serve --vault ~/Vault \
  --disabled-tools obsidian_dataview_query obsidian_full_text_search
```

Use case: narrow the surface for a restricted agent (read-only research agent gets only `obsidian_search_text` + `obsidian_read_note`). cyanheads + aaronsb both ship variants of this; v1.10 closes the gap with a one-line monkey-patch on `server.registerTool`. Skips are logged to stderr so users can verify the flag is doing what they expect.

The boot-line summary now reports `disabled-tools=N` when the flag is set.

### Repo state
- 27 MCP tools (unchanged). 22 always-on read + 1 opt-in FTS5 + 4 write.
- 10 MCP prompts (unchanged).
- **330 unit tests** (was 305, +25 covering Moment-format conversion / plugin-config loading / alias resolution / read_note integration with plugin folder).
- New module: `src/periodic.ts` (~200 LoC, fully tested).
- `--enable-write` help text unchanged. New `--disabled-tools` help text matches the spec's discoverability conventions.

## [1.9.0] — 2026-05-06

**Bulk find/replace.** v1.9 adds a write tool that's been on the wishlist since v1.1 — `obsidian_replace_in_notes`. Reuses rename_note's code-fence-aware line walker so example snippets and code documentation stay verbatim. Strategic agent recommended this over outputSchema spec polish: it's user-visible, ships fast, fills a real refactor gap that no other Obsidian-MCP server handles safely.

### Added — `obsidian_replace_in_notes` (write tool, opt-in via `--enable-write`)

Walks the vault (or a `folder` subset), substitutes every literal occurrence of `search` with `replace` outside fenced code blocks (` ``` ` / `~~~`), writes each modified file back. Returns per-file occurrence counts + total. `dry_run: true` previews. `case_sensitive: false` for case-insensitive substring match (replace text is inserted verbatim — case is not preserved).

**Footgun guards:**
- Refuses empty `search` (would be a no-op or worse — replace empty-string with `replace` everywhere).
- Refuses identical `search` and `replace` (no-op refused so it doesn't quietly burn write quota).
- Honors `--exclude-glob` and `--read-paths` — writes to filtered paths fail at `Vault.writeNote`.

**Use cases:** vocabulary refactor (`GPT-3.5` → `GPT-4`), deprecation cleanup (delete every `DEPRECATED ` prefix), brand rename (case-insensitive `api` → `REST` in prose, while keeping URLs intact via the code-fence skip).

### Internal — generic `replaceStringOutsideCodeFences()`
Promotes the rename_note line walker from a wikilink-specific replacer to a generic substring-with-case-options replacer. Both tools share the same fence-detection logic now, so a future bug in fence detection only needs to be fixed in one place.

### Repo state
- **27 MCP tools** (was 26). 22 always-on read + 1 opt-in FTS5 + 4 write.
- **10 MCP prompts** (unchanged).
- **304 unit tests** (was 294, +10 covering happy path, code-fence skip, dry_run, case sensitivity, folder filter, no-match, empty-search refusal, identical-strings refusal, delete-by-empty-replace, `--read-paths` enforcement).
- `--enable-write` help text bumped from "three" to "four" tools.

## [1.8.1] — 2026-05-06

Patch release driven by a 5-agent post-1.8 audit (code · process · docs · repo page · strategy). Three real bugs found, one process gap, several doc drifts. All fixed in this release. No new features.

### Fixed — code (3 P1 bugs)

- **`obsidian_find_path` was O(N²) on large vaults.** The BFS loop did `entries.find((e) => e.relPath === node.rel)` for every visited node — O(N) per visit times the visited-set size. Now builds a `Map<relPath, FileEntry>` once before the loop. On a 10k-vault BFS with depth 5, this drops the dominant cost from quadratic to linear.

- **`obsidian_semantic_search` snippet leaked frontmatter.** The snippet was built from the FULL file `content` (including the YAML frontmatter block), so a matched term that lived in YAML metadata could surface YAML keys/values in the response. Now uses `parsed.body` — TF-IDF is built from body too, so the indexOf is guaranteed to land if the term contributed to cosine score.

- **`Vault` exclusion error was misleading.** When `--read-paths` was set and a path didn't match the allowlist, the error said `"Path is excluded by --exclude-glob"` — wrong filter. Now the error names the actual rejecting filter: `"--read-paths allowlist (path doesn't match any allow-glob)"` or `"--exclude-glob denylist"`.

### Fixed — process (1 P0 gap)

- **Smoke test didn't exercise canvas tools.** `scripts/synthetic-vault.mjs` created only `.md` files, so the v1.7 canvas tools (`obsidian_list_canvases`, `obsidian_read_canvas`) were registered but never actually called by smoke. A regression in the canvas reader could ship green. Now `synthetic-vault.mjs` creates `Boards/Apollo Board.canvas` (text + file + link nodes + 1 edge) and `smoke.mjs` exercises both tools end-to-end. Smoke also now exercises `obsidian_semantic_search` (v1.8) for completeness.

### Fixed — docs (drift across the v1.5–v1.8 sprint)

- **README test counter:** comparison-table row said `246 unit tests` (stuck at v1.4). Bumped to `294+` (current actual count) with a `+` to acknowledge ongoing additions.
- **CONTRIBUTING.md runtime-deps count:** said `four` (`@modelcontextprotocol/sdk`, `commander`, `gray-matter`, `zod`) — missed `chokidar` (added v1.2.0). Now reads `five` plus the optional `better-sqlite3`.
- **README configuration table missing four flags:** `--persistent-index`, `--tokenize`, `--index-file`, `--exclude-glob` were referenced inline elsewhere but not in the canonical config table. All four added.
- **`SECURITY.md`:** new sections covering the v1.6+ surfaces — `--read-paths` strict-allowlist threat model + a "v1.5+ read tools: read-only safety" block covering `lint_wiki` / `open_questions` / `paper_audit` / `find_path` / `open_in_ui` / `list_canvases` / `read_canvas` / `semantic_search`. Specifically calls out that `readBinaryFile` (used by canvas) shares the `--max-file-bytes` cap with markdown.

### Hardened — `prepublishOnly`

`package.json:prepublishOnly` ran `lint + build + test` only. CI's release workflow runs all of that **plus** version-consistency check + `npm audit --audit-level=high`. So a maintainer running `npm publish` locally could ship a version mismatch or a high-severity advisory. `prepublishOnly` now runs the same gate set as CI.

### Repo state
- 26 MCP tools (unchanged). 22 always-on read + 1 opt-in FTS5 + 3 write.
- 10 MCP prompts (unchanged).
- 294 unit tests (unchanged). All still pass.
- Smoke now covers 3 tools that weren't exercised pre-1.8.1 (`list_canvases`, `read_canvas`, `semantic_search`).

## [1.8.0] — 2026-05-06

**Semantic search.** Pure-JS TF-IDF cosine retrieval — closes the Smart-Connections-paywall gap surfaced in the v1.5 competitive audit, free / offline / no model download / no new runtime deps. Real ML embedding retrieval (with an ONNX model + sqlite-vec) is the v2.0 follow-up; this is the meaningful first step that catches the related-term case BM25 misses.

### Added — `obsidian_semantic_search` (read-only)
Tokenizes (alphanumeric + hyphen, ≥ 2 chars, stop-words filtered), TF-IDFs, L2-normalizes every note's body once per session, then ranks notes by cosine similarity to the query. Returns ranked hits with `path` + `title` + `score` (cosine, 0–1) + `snippet` + `matched_terms` (sorted highest-IDF first — the most-discriminating terms in the corpus).

The IDF index is built lazily on first call and memoized via `WeakMap` keyed on the `entries` array reference. Subsequent calls reuse the index when `listMarkdown()` returns the same paths + mtimes; rebuilds automatically when the vault changes.

Args: `query` (required), `folder?` (subfolder restriction), `limit?` (≤ 100, default 10), `min_score?` (0–1, default 0.05).

### Why this matters
- `obsidian_search_text` does case-insensitive substring match — misses synonyms entirely.
- `obsidian_full_text_search` (FTS5 BM25) is great for keyword density but still doesn't bridge "access token" ↔ "JWT" ↔ "OAuth flow" the way semantic does.
- Smart Connections — the dominant Obsidian semantic-search plugin — paywalled this functionality in 2025. enquire-mcp gives it free.

### Why not ML embeddings yet?
Real embedding retrieval would need a 25–50 MB ONNX model + an inference runtime (`@xenova/transformers` or similar). That breaks the lean "5 runtime deps" promise. TF-IDF cosine ships zero new deps and meaningfully improves over BM25 alone for the related-term case. The v2.0 roadmap is real embeddings + sqlite-vec + RRF fusion with FTS5; this 1.8 release is the foundation.

### Tokenizer details
- Alphanumeric + hyphen (so `claude-code` stays one token, hyphenated tokens like FTS5).
- Length 2–40 chars (skip noise + base64 runs).
- 60 English stop-words filtered.
- Documented behaviour — the `pattern` argument we ship for `obsidian_open_questions` is intentionally NOT exposed here; the tokenizer is fixed in 1.x and frozen as part of the API contract.

### Repo state
- **26 MCP tools** (was 25). 22 always-on read + 1 opt-in FTS5 + 3 write.
- **10 MCP prompts** (unchanged).
- **294 unit tests** (was 285, +9 covering relevance ranking, vocabulary miss, folder filter, matched-terms ranking, min_score threshold, empty-query refusal, allowlist filtering, score bounds, total_docs reporting).

## [1.7.0] — 2026-05-06

Canvas (`.canvas`) read tools — green-field per the v1.5 competitive audit. Only obscure forks (`obsidian-mcp-pro`, `aaronsb`'s plugin via Obsidian Bases) had any canvas support, and even those required Obsidian to be running. enquire-mcp now reads Canvas natively from the filesystem like every other vault format.

### Added — `obsidian_list_canvases` (read-only)
Lists `.canvas` files (Obsidian's whiteboard / mind-map format — JSON nodes + edges) in the vault, with each canvas's node and edge counts. Honors `--exclude-glob` and `--read-paths`. Sorted newest-first by mtime. Use this to discover which canvases exist before reading one.

### Added — `obsidian_read_canvas` (read-only)
Parses one `.canvas` file into typed nodes + edges. Each node carries a `kind` discriminator — `text` / `file` / `link` / `group` / `unknown` (forward-compat: any future Obsidian canvas node type lands as `unknown` with `raw_type` + `raw` so the agent still sees the data).

Each `file` node carries a `file_resolved` field — the vault-relative path the canvas's file reference resolved to (or `null` if broken). The response also includes:
- `summary`: per-kind node count (`{ text, file, link, group, unknown }`).
- `broken_file_refs`: canvas `file:` references that don't resolve to any markdown in the vault — surfaces canvas hygiene issues alongside `obsidian_get_unresolved_wikilinks`.

`CanvasEdge` preserves `from_node` / `to_node` IDs, optional `from_side` / `to_side`, optional `label`, optional `color`. Throws on path-traversal, missing file, or invalid JSON.

### Internal — vault primitives for non-markdown formats
- `Vault.listFilesByExtension(ext, folder?)` — generic walker for any extension. Skip rules + privacy filters match `listMarkdown()`.
- `Vault.readBinaryFile(rel)` — reads non-markdown files (returns `Buffer`). Same path-safety + size cap as `readNote`.

These primitives unblock future tools for other Obsidian file formats (`.excalidraw`, `.base`, …) without re-implementing the walker each time.

### Repo state
- **25 MCP tools** (was 23). 21 always-on read + 1 opt-in FTS5 + 3 write.
- **10 MCP prompts** (unchanged).
- **285 unit tests** (was 275, +10 for canvas coverage: nodes by kind, broken refs, edge metadata, malformed JSON, path traversal, empty canvas, allowlist filtering, folder filter, .canvas auto-extension, future-type forward-compat).

## [1.6.0] — 2026-05-06

Three Tier-1 items from the v1.5 competitive audit. Same release: a graph-traversal tool that aaronsb's plugin made into a killer feature, an obsidian:// URI hand-off (cyanheads pattern), and a strict allowlist that pairs with the existing denylist.

### Added — `obsidian_find_path` tool
Multi-hop graph traversal: BFS from `from` to `to` over the wikilink graph, returning the **shortest path** (sequence of notes connected by wikilinks) up to `max_depth` hops. Each step in the returned path carries the wikilink text used to traverse to it. With `include_alternatives=true`, returns up to 10 same-length paths so the agent can compare. Embeds (`![[…]]`) are followed by default; pass `follow_embeds=false` to skip them. `from === to` returns `hops: 0` + the source-only path. Uses the shared `EntryIndex` memo so repeat calls in a session reuse the basename index for O(1) target resolution. Read-only.

### Added — `obsidian_open_in_ui` tool
Returns an `obsidian://open?vault=<vault>&file=<path>` URI for hand-off to the running Obsidian desktop app. No filesystem or network side effect — the URI emission lets the agent say "open this in Obsidian" without enquire-mcp coordinating with the running app. Optional `new_pane=true` opens the note in a split. The vault name defaults to the leaf folder of the vault root path; Obsidian matches on this OR on the file's absolute path so the URI works even if the user's instance opened the vault under a different name. Read-only.

### Added — `--read-paths <pattern...>` CLI flag
Strict allowlist complement to `--exclude-glob`. When set, ONLY paths matching one of these glob patterns are visible to any tool — list, read, watcher events, write attempts. If both are set: a path must match an allow-glob AND not match any exclude-glob. Same glob semantics (`*` within-segment, `**` cross-segment, `?` single char). Repeatable.

The cyanheads `OBSIDIAN_READ_PATHS` pattern was specifically called out in the competitive audit as a reason users picked their server over `--exclude-glob`-only ones; this closes that gap.

### Internal — listMarkdown filter gating
Pre-1.6, `listMarkdown()` only filtered when `excludeRegexes.length > 0`. Now filters when EITHER `excludeRegexes` OR `readPathRegexes` is non-empty. This was caught by the test suite during `--read-paths` development (a one-line bug fix that turned a failing allowlist test green).

### Repo state
- **23 MCP tools** (was 21). 19 always-on read + 1 opt-in FTS5 + 3 write.
- **10 MCP prompts** (unchanged).
- **275 unit tests** (was 261, +14 for find_path / open_in_ui / readPaths coverage).
- Smoke updated to expect 19 base read tools / 20 with FTS5.

## [1.5.0] — 2026-05-06

**Karpathy LLM-Wiki `/lint` workflow** — three new read tools + a new prompt that turn enquire-mcp into a reference implementation of the lint command from Karpathy's LLM-Wiki gist (`gist.github.com/karpathy/442a6bf555914893e9891c11519de94f`). The gist names three workflows: `ingest`, `query`, `lint`. enquire-mcp had `ingest` (`create_note` + `validate_note_proposal`) and `query` (`search_text` / `full_text_search` / `find_similar` / `get_note_neighbors` / `dataview_query`) since 0.13. v1.5 ships `lint` and closes the trio.

This release was driven by a 4-agent competitive-research pass (top obsidian-MCP servers, Karpathy + ML-PKM workflows, MCP ecosystem trends, Obsidian community pain). The convergent finding across all four reports: nobody in the obsidian-MCP space ships a hygiene-audit tool, and Karpathy's gist explicitly names the workflow.

### Added — `obsidian_lint_wiki` (read-only)
Five-bucket vault-hygiene report in **one** call:
- **Orphans** — notes with no inbound and no outbound wikilinks.
- **Broken links** — every `[[wikilink]]` that doesn't resolve, with source path and the literal that needs fixing.
- **Stubs** — notes shorter than `stub_word_threshold` (default 100). Configurable.
- **Stale** — notes whose frontmatter `last_reviewed` (or mtime if missing) is older than `stale_days` (default 365). Accepts Date / ISO string / numeric epoch.
- **Concept candidates** — capitalised phrases (1-3 CapitalCase tokens, with stop-word filtering) mentioned by ≥ `concept_min_mentions` (default 3) distinct notes that don't have their own page yet. Matches Karpathy's "concept mentioned in N+ notes but missing its own page" pass.

Each finding ships with `path` + `message` + `suggestion` shaped so the agent can fix via existing tools (`validate_note_proposal` → `create_note` / `append_to_note` / `rename_note`). `max_per_bucket` caps each bucket independently. `folder` narrows the scope.

### Added — `obsidian_open_questions` (read-only)
Walks every note for deferred-thinking markers — `Open question:` / `Q:` / `TODO?` / `??` (with optional list-bullet, blockquote, or heading prefix). Returns each hit with source path, the heading it lives under, line number, and age in days, sorted oldest-first so threads aging out surface first. Common research-PKM pattern (Karpathy, Eleanor Konik, academic Zettelkasten).

`pattern` lets you override the regex; default matches the markers above. `folder` narrows the scope. `limit` caps results (default 100). Scans `parsed.body` so frontmatter lines don't pollute the results.

### Added — `obsidian_paper_audit` (read-only)
For each note tagged `#paper` (configurable via `tag`), verifies frontmatter has at least one citable identifier (`arxiv` / `doi` / `url` / `isbn`). Also flags notes whose body contains an arxiv ID (e.g. `arxiv:2401.12345`) or DOI but doesn't carry the same identifier in frontmatter — the common quick-capture-from-chat pattern.

Returns a `proposed_frontmatter_patch` for each flagged note that the agent can pass through `validate_note_proposal` and apply. Scans `parsed.body` so the frontmatter's own keys don't get re-detected as "found in body".

### Added — `lint_wiki` MCP prompt
Karpathy `/lint` orchestration: the prompt instructs the agent to call `obsidian_lint_wiki` + `obsidian_open_questions` + `obsidian_paper_audit`, then synthesize the **5 highest-leverage fixes** across all three reports with concrete `obsidian_*` calls per fix. Read-only — proposes only, never modifies.

### Repo state
- **21 MCP tools** (was 18). 17 always-on read + 1 opt-in FTS5 + 3 write.
- **10 MCP prompts** (was 9). All read-only.
- **261 unit tests** (was 247, +14 for the lint trio: 7 lint_wiki / 3 open_questions / 3 paper_audit / 1 cross-feature).
- Smoke updated to expect 17 base read tools / 18 with FTS5 / 10 prompts.
- README comparison table picks up a new "Karpathy LLM-Wiki `/lint` workflow" row.

### Bugs caught and fixed during implementation (audit-resilient)
- `lintWiki` initially typed frontmatter `last_reviewed` as `string`-only, but gray-matter (js-yaml) parses ISO dates into `Date` objects — fixed to accept `Date | string | number`.
- `paperAudit` initially scanned the full file content, which made the regex re-discover the frontmatter's own `arxiv:` key in body — fixed to scan `parsed.body` only.
- `getOpenQuestions` had a stray `reGlobal` line with malformed flag concatenation (`imgm`) — removed the dead line.

## [1.4.0] — 2026-05-06

Three new MCP prompts + closes the v1.3.1 audit's last test gap. Pure additions; no breaking changes; embeddings retrieval is still the only outstanding 1.x roadmap item (deferred to 2.x because of the dep-footprint impact).

### Added — 3 new MCP prompts (6 → 9)

- **`consolidate_tags`** — surfaces near-duplicate / inconsistently-cased tags (`#productivity` vs `#productive` vs `#Productivity`) by clustering on 3-gram similarity and case-folded prefixes. Proposes a single canonical tag per cluster + total affected note count. Read-only — never writes. Args: `min_count?` (default 2).

- **`find_duplicates`** — walks the vault for clusters of structurally-similar notes via the existing `obsidian_find_similar` tool. A cluster is a group of notes that all rank in each other's top-5 with score above the threshold. Reads top-2 of each cluster to verify content overlap (doesn't trust structural signal alone). Outputs merge proposals only — never modifies. Args: `folder?`, `min_score?` (default 1.5).

- **`monthly_review`** — 30-day version of the existing `weekly_review`. Calls `obsidian_stats` first for orientation, then groups the past month's edits by tag, identifies stalled work, and compares against the previous month's tag distribution. Ends with a 3-sentence reflection on focus vs stated intent. Args: `folder?`.

### Tested
- **`tests/write.test.ts`** — closes the v1.3.1-audit P2 test gap: a self-reference inside a path-qualified target (`Folder/Foo.md` containing `[[Folder/Foo]]`) now has explicit coverage. Verifies that after a cross-folder rename the path component AND the basename component both update — the bare and the path-qualified self-link forms are both rewritten correctly.

### Repo state
- **18 MCP tools** (unchanged). 14 read + 1 opt-in FTS5 + 3 write.
- **9 MCP prompts** (was 6). All read-only — they orchestrate existing tools; none introduce new write paths.
- **247 unit tests** (was 246, +1 for the path-qualified self-reference case).
- Smoke + docs-consistency tests updated to expect 9 prompts.
- Code surface unchanged outside `src/index.ts` prompt registrations and the new test.

## [1.3.1] — 2026-05-06

Patch release driven by a 5-agent post-1.3 audit (code · security · process · docs · 48-hour git history). All 5 agents reported zero P0/P1 code bugs; this release closes the doc + UX drift the audits surfaced.

### Fixed
- **`--enable-write` help text** in `src/index.ts` listed only `(create_note, append_to_note)` — the third write tool, `rename_note` (added v1.1.0), was missing. Now reads "Enable the three write tools (create_note, append_to_note, rename_note)."
- **README test counter drift** — comparison-table row was stuck at 239 across the v1.2/v1.3 ships; bumped to 246 to match the actual count.
- **README "Versioning & releases" section** was missing a v1.3.0 entry, and the 1.x roadmap line still listed "benchmarks at 10k+ vaults" as planned even though they shipped in v1.3.0. Both fixed.
- **README author footer** linked `twitter.com/OomkaBear` — switched to the canonical `x.com/OomkaBear` (avoids the 301 redirect and matches how X self-identifies).

### Documented
- **`SECURITY.md` — `--watch` live-watcher posture** — new section covering the v1.2.0 file watcher's threat model: symlinks not followed (matches walker), `--exclude-glob` honoured at runtime so excluded paths fire no events, skip-dirs match the walker, editor-debouncing, cleanup on shutdown. Out-of-scope items (timing side channels, watcher-vs-tool race coalescing) listed explicitly.

### Added — tooling
- **`npm run bench` + `npm run bench:quick`** — exposes `scripts/bench.mjs` as discoverable npm scripts so users / contributors don't have to remember the path. `bench:quick` runs only the 100 + 1 000 scales.
- **`bench/results.md` is now `.gitignore`d** — it's hardware-specific (numbers in mine reflect Apple A18 Pro), so committing it forced spurious diffs on every contributor's local run. README still references the file as the place a fresh `npm run bench` writes its output.

### Repo state
- 18 MCP tools (unchanged). 14 read + 1 opt-in FTS5 + 3 write.
- 246 unit tests (unchanged).
- Code surface unchanged except the `--enable-write` help string. Behaviour identical to 1.3.0.

## [1.3.0] — 2026-05-06

Performance + benchmarks. The third 1.x roadmap item lands.

### Added — `scripts/bench.mjs`
Comprehensive latency benchmark for the read-tool surface. Spins up synthetic vaults at 100 / 1 000 / 10 000 notes (configurable), runs each tool 5× after warmup, reports min / p50 / p99. Writes a markdown table to `bench/results.md` so the README can reference concrete numbers without committing stale ones. Not part of CI — runs slow on 10k vaults. Run: `node scripts/bench.mjs` (default scales) or `node scripts/bench.mjs --quick` (100 + 1 000 only).

### Changed — `findBestMatch` is now O(1) avg via a basename + relPath index
v1.2's bench data showed `findBestMatch` was the dominant cost in `find_similar` / `get_note_neighbors` / `vault_stats` / `rename_note` at vault scale (10k notes) — every call did `entries.filter(e => stripMd(e.basename).toLowerCase() === target)` which is O(N), and these tools call it inside a loop over all entries (so O(N²) overall, ~2-4s p50 at 10k).

Fix: build two indices once per `entries` array — `byBasename: Map<string, FileEntry[]>` for the common bare-basename case, and `byRelPath: Map<string, FileEntry>` for path-qualified targets. The indices are memoized via a `WeakMap<FileEntry[], EntryIndex>` keyed by the entries-array reference, so a fresh `vault.listMarkdown()` rebuilds them but a hot loop calling `findBestMatch` repeatedly with the same `entries` argument shares one index for free.

Measured impact on a 10 000-note synthetic vault (p50 ms, before → after):

| Tool | Before | After | Δ |
|---|---|---|---|
| `get_backlinks` | 1937 | 1145 | −41% |
| `list_tags` | 1361 | 1037 | −24% |
| `find_similar` | 1903 | 1065 | −44% |
| `get_note_neighbors` | 3244 | 2002 | −38% |
| `vault_stats` | 1968 | 1058 | −46% |
| `validate_note_proposal` | 1972 | 1353 | −31% |

Pure refactor — no behaviour change, all 246 unit tests still green.

### Repo state
- 18 MCP tools (unchanged). 14 read + 1 opt-in FTS5 + 3 write.
- 246 unit tests (unchanged).
- New `scripts/bench.mjs` + `bench/results.md` — concrete latency numbers in the README's Architecture section now reflect post-1.3 performance.
- For vaults above ~1 000 notes, `--persistent-index` is still strongly recommended — the FTS5-backed `obsidian_full_text_search` runs sub-100ms on 10k vaults regardless of these graph-tool optimizations.

## [1.2.0] — 2026-05-06

Watcher mode — the second 1.x roadmap item lands.

### Added — `--watch` CLI flag
Closes the long-running-server workflow gap: until now, edits to your vault while the MCP server was alive were invisible to in-memory caches and the FTS5 index. The fix used to be "restart the server and wait for the cold-rebuild." With `--watch`:

- The server registers a vault-rooted file watcher on boot (after the initial FTS5 sync, so we don't double-index).
- On `add` / `change` / `unlink` of any `.md` file, the parsed-note cache entry for that file is invalidated, and (when `--persistent-index` is also set) the FTS5 index is incrementally re-synced for just that file.
- Non-`.md` files are ignored; `.git`, `.obsidian`, `.trash`, `node_modules`, `.DS_Store` directories are skipped; symlinks are not followed (matching the rest of the vault walker).
- `--exclude-glob` patterns are honored — edits to excluded paths don't fire cache invalidation or surface to the FTS5 layer, so private subfolders stay invisible to the running server.
- Editor-debouncing is delegated to chokidar's `awaitWriteFinish` (`stabilityThreshold: 250ms`, `pollInterval: 50ms`), so a single Obsidian save that fires five `change` events only reindexes once.
- Stderr emits a one-line trace per event: `enquire: watcher add/change/unlink <relPath> (cache-invalidated|fts5 reindexed|fts5 dropped)`.

Off by default — `--watch` is fully opt-in, no behavior change for users who don't pass the flag.

### Added — runtime dependency
- `chokidar` ^5.0.0 (battle-tested cross-platform fs watcher; ~6 KB of API surface for our use).

### Internal
- `Vault.invalidateOne(absPath)` — single-file cache eviction so the watcher doesn't blow away the entire LRU on every edit.

### Repo state
- 18 MCP tools (unchanged). 14 read + 1 opt-in FTS5 + 3 write.
- 246 unit tests (was 242, +4 watcher tests: cache invalidation on change, non-.md file ignored, `--exclude-glob` respected, idempotent close).
- 5 runtime deps (was 4): `@modelcontextprotocol/sdk`, `chokidar` (NEW), `commander`, `gray-matter`, `zod`. Plus the optional `better-sqlite3`.

## [1.1.1] — 2026-05-06

Patch release driven by a 4-agent post-1.1 audit (code · process · docs · repo page).

### Fixed
- **`obsidian_rename_note` self-reference rewrite (P1).** A note that linked to itself (e.g. `Foo.md` containing `[[Foo]]`) was previously skipped by the rename pass — the file got moved as-is and ended up with a broken self-link at the new name. Now the source file is included in the rewrite plan, written to its old path with the updated literals, and `fs.rename`'d last. Code-fence-aware behavior for the source file matches every other file (wikilinks inside ` ``` ` / `~~~` blocks stay verbatim). Two new tests cover the fix; one new test pins the existing `overwrite: true` semantics so they don't drift.

### Documented
- **`SECURITY.md` — `obsidian_rename_note` atomic-rewrite posture.** New section covers path-traversal/symlink-escape rejection on both `from` and `to`, `--exclude-glob` enforcement on the destination, refuses-by-default policy on overwrite + `from === to`, code-fence-aware rewrite as defense against arbitrary content injection in unrelated files, and the write-order recovery story (backlinks → source → rename) plus the `EXDEV` cross-filesystem caveat.
- **Write-tool count corrected from "two" to "three"** in three doc locations (`README.md` config table + FAQ; `docs/api.md` flag table) where the v1.1 rename tool wasn't reflected.
- **Banner + README badge made version-agnostic.** `assets/social-preview.svg` subtitle was "1.0 stable 🦞" — now "stable 🦞" so it doesn't drift on every minor. README "Stable 1.0" badge → "Stable".

### Polish
- **README badges trimmed** 9 → 6 (CI, npm, Stable, MIT, Node, MCP). Dropped tests-passing / coverage / lint badges that drifted on every version bump.
- **README author footer** now lists both `@oomkapwn` (GitHub) and `@OomkaBear` (X / Twitter).
- **GitHub repo description** refreshed to pain-led + version-agnostic.

### Repo state
- 18 MCP tools (unchanged). 14 read + 1 opt-in FTS5 + 3 write.
- 242 unit tests (was 239, +3 for the self-reference + overwrite fixes).

## [1.1.0] — 2026-05-06

First post-1.0 minor — the most-requested 1.x roadmap item lands: **atomic rename with automatic backlink rewrite**.

### Added — `obsidian_rename_note` tool
Closes the longstanding "rename breaks every link to the note" pain. The tool:

- Walks every other note in the vault, finds wikilinks/embeds whose `findBestMatch` resolves to the source file, and rewrites only those literals.
- **Preserves** `|alias`, `#section`, `^block`, and the user's chosen path-qualification convention (bare `[[Foo]]` stays bare; `[[Folder/Foo]]` updates to `[[NewFolder/Foo]]` when the destination directory changes).
- **Code-fence-aware:** wikilinks inside ` ``` ` / `~~~` blocks are left verbatim. The line-walker tracks fence in/out state so example snippets and code documentation aren't mangled.
- **Rewrites embeds** (`![[…]]`) just like wikilinks.
- Supports `dry_run: true` to preview which files would change without touching disk.
- Supports `overwrite: true` to allow the destination to be replaced (rare; default refuses).
- Refuses if `from` is missing, `to` exists, either path traverses the vault, or `from === to`.
- Order of operations: writes all the back-link-bearing files first, then `fs.rename`s the source file last — so a mid-run failure leaves backlinks pointing at the still-present old name (worst-case: safe, recoverable).

**WRITE TOOL** — only registered when the server is started with `--enable-write`. Annotated `destructiveHint: true`.

### Repo state
- 18 MCP tools (was 17). 14 always-on read + 1 opt-in FTS5 read + 3 opt-in write.
- 239 unit tests (was 228, +11 for the rename surface).
- Smoke + docs-consistency tests updated. README + `docs/api.md` cover the new tool.

## [1.0.0] — 2026-05-05

**Stable.** API freeze. Same code as v0.13.0 plus 4 polish commits (perf cleanup in `getVaultStats`, 3 more edge-case tests, full API docs for v0.12 + v0.13 tools, README test counter).

### Stability promise

- The 17 MCP tool names (`obsidian_*`) and their argument shapes are stable and will follow semver going forward — no breaking change without a major bump.
- The MCP resource URIs (`obsidian://vault/info`, `obsidian://note/{path}`, `obsidian://chunk/{n}/{path}`) are stable.
- The 6 prompts (`summarize_recent_edits`, `weekly_review`, `find_orphans`, `extract_todos`, `process_inbox`, `review_tag`) are stable.
- The CLI flags (`--vault`, `--enable-write`, `--persistent-cache`, `--persistent-index`, `--tokenize`, `--exclude-glob`, …) are stable.
- The four runtime dependencies (`@modelcontextprotocol/sdk`, `commander`, `gray-matter`, `zod`) plus one optional (`better-sqlite3`) are the contract — no surprise additions.

### What ships in 1.0

- **17 MCP tools** = 14 always-on read + 1 opt-in read (`--persistent-index`) + 2 opt-in write (`--enable-write`).
- **3 MCP resources** = `obsidian://vault/info`, `obsidian://note/{path}`, plus `obsidian://chunk/{n}/{path}` when FTS5 is enabled.
- **6 MCP prompts** for common workflows.
- **Privacy filter** via `--exclude-glob` (multi-pattern, glob semantics, blocks every read path).
- **Anti-slop write validator** (`obsidian_validate_note_proposal`) — lint a draft note before writing.
- **Graph-aware retrieval** (`obsidian_find_similar` + `obsidian_get_note_neighbors`) — multi-signal lexical hybrid, no embeddings.
- **FTS5 BM25 search** with `unicode61`/`trigram` tokenize modes and persistent SQLite index.
- **Persistent on-disk cache** for warm cold-starts.
- **228 unit tests**, TypeScript strict + `noUncheckedIndexedAccess`, Biome 2 lint, Husky pre-commit hooks.
- **CI gate** = lint + tests on Node 20/22/24 + smoke on scan + smoke on FTS5 + npm audit + version-consistency + coverage. Branch protection requires all 7 to pass.
- **Release pipeline** with SLSA-3 provenance via `npm publish --provenance`.

### What's not in 1.0 (planned for 1.x)

- `obsidian_rename_note` — atomic rename + automatic backlink update.
- Optional embedding-based retrieval (sqlite-vec + a small JS-runnable model). The `find_similar` lexical hybrid already covers the 80%; embeddings are for the long tail.
- Watcher-driven incremental FTS5 reindex (currently rebuilt on boot).

## [0.13.0] — 2026-05-05

Graph-aware retrieval — three new read-only tools that expose the vault's structural graph as first-class context for the LLM. No embeddings, no native dependencies, no model download — just the same metadata an Obsidian user already curates (tags, headings, link graph) reorganized into the queries an agent actually wants to make.

### Added — `obsidian_find_similar` tool
Given a note, return up to N other notes ranked by structural similarity. Score is a weighted sum of four signals — each also returned individually so the caller can re-rank:
- **`tag_jaccard`** (×3.0) — Jaccard over the case-folded tag set
- **`title_3gram`** (×1.5) — character 3-gram Jaccard over basenames (catches near-duplicates: "Apollo Project" vs "Apollo-Project")
- **`shared_outbound`** (×2.0) — fraction of A's resolved outbound links also present in B's
- **`co_backlink`** (×2.0) — Jaccard over the set of notes that link to A and to B (graph-co-mentioned siblings)

This is "hybrid retrieval" done with vault-native lexical signals — competitive at vault scales (1k–10k notes) without paying the cost of an embedding model.

### Added — `obsidian_get_note_neighbors` tool
Return a note + its 1-hop graph neighborhood in a single call: outbound resolved wikilinks, inbound backlinks (with count), and tag-cluster siblings (notes sharing ≥1 tag, excluding outbound/inbound). Replaces the `read_note → backlinks → outbound → resolve_wikilink` chain (4 round-trips) with one call. Designed for "give the LLM enough context to reason about THIS note" RAG workflows. `max_per_bucket` caps each bucket independently.

### Added — `obsidian_stats` tool
One-shot vault dashboard. Cheap (one pass over cached parses): `total_notes`, `total_size_bytes`, `avg_note_words`, `recently_modified_7d`, `orphans` (no inbound + no outbound), `broken_wikilinks`, `total_tags`, `top_tags` (frequency-ranked), `notes_with_frontmatter`. Useful as the first call in a session so the agent has structural context before issuing targeted reads.

### Repo state
- **14 read tools** (was 11). Smoke + docs-consistency tests updated.
- 3 new tools all annotated `READ_ONLY`. None require `--enable-write`.

## [0.12.0] — 2026-05-05

Anti-slop write validator — closes the #1 LLM-write pain found across forum #111443, Eleanor Konik's blog, and every chatforest review: *"AI generates structurally-broken notes — bad YAML, fake wikilinks, inconsistent tags — and I spend 10 minutes reformatting per note"*.

### Added — `obsidian_validate_note_proposal` tool
Lint a draft note BEFORE the LLM commits to writing. Inputs: `path` + `content` (full markdown including frontmatter) + optional `mode` ("create" | "overwrite" | "append"). Returns a structured diagnostic so the LLM can fix-and-retry rather than ship a broken note.

What it checks:
- **YAML parse** via `gray-matter` (the same parser used at write time). Reports `parsed: true|false` + error string + observed keys.
- **Every `[[wikilink]]`** resolved against the live vault via `findBestMatch`. Each link tagged `resolved` / `broken` with `resolved_path` or `did-you-mean` suggestions (top-3 nearest by prefix/contains rank).
- **Every tag** (frontmatter + inline) pre-classified as `existing` (case-insensitive match against `listTags()`) or `new` — flags `new` ones so the LLM doesn't fork a tag forest (`#productivity` vs `#productive` vs `#prod`).
- **Path collision**:
  - `mode: "create"` (default) — exact path exists → blocking `path-collision` error.
  - `mode: "overwrite"` / `"append"` — path exists → soft warning, validation passes.
  - Title collision (note with same basename at a different path) → soft warning regardless of mode.
- **Path traversal** caught and returned as a structured error (not an exception) — validator never throws on input shape.

This is a **read-only tool**. Always available, even without `--enable-write`. Recommended workflow: `validate → fix → obsidian_create_note`.

Why it's a moat: nobody else in the obsidian-MCP space ships this. Closes the gap between "scary LLM that touches my vault" and "LLM that drafts notes that arrive ready-to-merge".

### Tests
- 220 unit tests (was 213). 7 new for the validator: happy path, broken-wikilinks, new-tag classification, path-collision modes, invalid YAML pass-through, path traversal as structured error, auto `.md` append.

### Repo state
- 11 read tools (was 10). Smoke + docs-consistency tests updated.
- README comparison-table row added — "Anti-slop write validator".

## [0.11.0] — 2026-05-05

Competitive feature set — borrowed/synthesized from a deep audit of the obsidian-MCP space (StevenStavrakis, MarkusPfundstein, cyanheads, marcelmarais, aaronsb, mcpvault) and Obsidian community pain-point research (forum, HN, Reddit). Four user-visible features land here, none of them invented from scratch — each closes a gap real users complain about with the existing tools.

### Added — privacy
- **`--exclude-glob <pattern...>`** CLI flag (repeatable). Glob patterns matching vault-relative paths make those notes invisible to *every* tool — `list_notes`, `read_note`, `search_text`, `dataview_query`, even direct path reads. Closes the most-frequent forum complaint about Obsidian-MCP setups: *"the AI can see my whole vault and that isn't something I have enabled permanently in my main vault"*. Supports `*` (within-segment), `**` (cross-segment), `?` (single char). Example: `--exclude-glob '02_Personal/**' '*.private.md' 'Inbox/*.draft.md'`. Backed by 7 unit tests for both glob semantics and Vault filtering.

### Added — daily-note workflow
- **Periodic-note aliases on `obsidian_read_note`** — `title: "today"` (or `"daily"` / `"weekly"` / `"monthly"`) resolves to today's daily/weekly/monthly note using the standard Daily-Notes-plugin formats: `YYYY-MM-DD` / `YYYY-Www` (ISO week) / `YYYY-MM`. Literal title takes priority — if you have an actual `Daily.md`, that one wins. Borrowed from cyanheads/obsidian-mcp-server, made standalone (no Local REST API plugin needed).

### Added — LLM-friendly errors
- **`Did you mean: …` suggestions** on every `Note not found` error from `obsidian_read_note`, `obsidian_create_note`, and `obsidian_append_to_note`. Up to 3 nearest paths by case-insensitive prefix/contains/relpath ranking. Closes the cyanheads-style "case-insensitive retry plus closest-match hint" UX gap that LLMs hit when they paraphrase a note name.

### Added — projection format
- **`obsidian_read_note` accepts `format: "map"`** for a document-map projection: returns headings (with `level` + `text` + `line`) + frontmatter keys + wikilink/embed/tag counts + `byte_size` *without* the body. Lets an LLM plan a surgical edit without paying the token cost of reading the full note. Default `format: "full"` preserves the v0.10 shape.

### Tests
- 213 unit tests (was 195). 18 new across 4 features:
  - `globToRegex` semantics (4 tests)
  - `--exclude-glob` filtering at `listNotes` + `readNote` paths (4 tests)
  - Document-map projection — headings inside fences correctly skipped (2 tests)
  - Periodic-note aliases — `today`/`daily`/`weekly`/`monthly` resolution + literal-priority + error-message format (5 tests)
  - Did-you-mean — typo path/title suggestions, exact match doesn't include hint (3 tests)

### Why this matters
Each of these four features came directly from the competitor + community research:
- **`--exclude-glob`**: the privacy concern was the #1 unmet user want from the forum thread; nobody else ships per-folder ACL.
- **Periodic aliases**: daily-note workflow is one of the top reasons people use Obsidian; cyanheads had this, nobody else with the standalone-FS architecture did.
- **Did-you-mean + map projection**: cyanheads' UX patterns the rest of the field hadn't borrowed yet.

## [0.10.6] — 2026-05-03

CI re-release of v0.10.5. Same content + applied biome's auto-format wrap on the SQL string in `src/fts5.ts` (line was just past biome's 120-col `lineWidth`, CI strict where local was lenient until I re-ran `npm run lint`). v0.10.5 git tag exists pointing at 6039dc6 but never reached npm.

This is a CI-pipeline issue, not a code or branding change — v0.10.6 functionality is identical to v0.10.5.

## [0.10.5] — 2026-05-03

CI re-release of v0.10.4 (lint failed on the same biome severity divergence that bit v0.10.2 — `useTemplate` rule registers as `info` locally but `error` on the GitHub Actions image). Same code as v0.10.4 plus:

### Added — marketing surface for OpenClaw
- README, package.json description, and GitHub repo description now feature **OpenClaw** alongside Claude Code, Cursor, and Codex as primary MCP clients. The reference deployment for the FTS5 search backend (issue #10) is the SZBOX trading-system memory layer running on OpenClaw — explicit attribution makes that pairing discoverable.
- Devin moves from the headline list to "any other MCP-compatible client" — kept as a supported target, just not the lead example.
- Per-client install table gains an OpenClaw row.
- npm `keywords` adds `openclaw`. GitHub repo `topics` adds `openclaw` (now at the 20-topic max).

### Fixed (vs the broken v0.10.4 npm publish)
- `src/fts5.ts` `getChunk()`: collapsed the multi-line `prepare("…")` into one line via a `sql` const. Same biome `useTemplate`/format edge that bit v0.10.2.

## [0.10.4] — 2026-05-03

External-audit pass on top of v0.10.3 — closes one P1 (chunk-resource leaking FTS5 internal enrichment), tightens privacy posture for the FTS5 path, plugs a folder-filter pattern issue, hardens the release pipeline, and clears doc drift accumulated across the v0.10.x range.

### Fixed
- **P1 — `obsidian://chunk/{n}/{path}` resource was returning the FTS5-enriched chunk text, not the raw note text.** The FTS5 `content` column carries an appended `[wikilink_targets: …]` synthetic line for recall (so a search for a target name surfaces notes that link out to it without naming it inline). The resource handler returned that enriched text — meaning MCP clients were seeing a synthetic line that doesn't exist in the source note, breaking quoting and creating ambiguity in deep-link responses. Fix: schema bump (v2 → v3) adds an UNINDEXED `raw_content` column carrying the verbatim chunk; `getChunk()` now selects `raw_content`. Existing v0.10.x indexes auto-rebuild on first v0.10.4 boot. Negative-assertion regression test added in `tests/fts5.test.ts`.
- **P2 — FTS5 folder filter used SQLite `GLOB`** which interprets `*?[]` as pattern syntax. A folder named `Project [A]` or `Q?A` would expand into wider matches. Switched to `substr(rel_path, 1, ?) = ?` for prefix-equality with no pattern semantics.

### Added — privacy
- **DB + WAL + SHM file mode `0600`** on every `FtsIndex.open()` (was: only the parent dir got `0700`, and only when first created). Closes the audit gap that the FTS5 index — which stores chunked note content + tag list + wikilink targets — wasn't getting the same explicit chmod that the persistent parse cache does.
- **New CLI subcommand `enquire-mcp clear-index`** for full privacy purge: removes `.fts5.db`, `.fts5.db-wal`, `.fts5.db-shm`. Symmetric to `clear-cache`.
- **`SECURITY.md` gains a "Persistent FTS5 index: privacy posture" section** mirroring the existing persistent-cache section. Covers what the index stores, file modes, the WAL/SHM gotcha, the cross-vault contamination guard, and the manual purge path.

### Added — release pipeline
- **`.github/workflows/release.yml` now runs the full quality gate before `npm publish`**: lint, build, test, **`check-version-consistency`**, **`npm audit --audit-level=high`**, and a **JSON-RPC smoke test against a synthetic vault**. Previously a bad commit could publish to npm if it passed lint+build+test alone. (v0.10.2 already showed how brittle the slimmer gate was.)

### Added — server hardening
- **`startServer()` wraps FTS5 sync in try/catch** that closes the SQLite handle if `syncFtsIndex` throws — was leaking the connection until process exit.

### Docs cleanup (drift across the v0.10.x range)
- `docs/api.md` header was still `# enquire — API (v0.7)` and claimed `12 MCP tools (10 read + 2 opt-in write)` — actually 13 tools when both opt-ins are enabled (10 always-on read + 1 opt-in FTS read + 2 opt-in write). Header de-versioned, count corrected, link to CHANGELOG added.
- `docs/api.md` `obsidian_full_text_search` schema was missing the `tag` and `since` filters (shipped in v0.10.1) and the `applied_filters` field of the response shape. Added.
- `docs/api.md` `obsidian_full_text_search` returns shape: `chunk_index` no longer says "can address with obsidian://chunk URI later" — that resource shipped in v0.10.2 and is documented in its own section now.
- `docs/api.md` Roadmap reorganized: shipped items moved to "Shipped in 0.10" with checkmarks; only unshipped items remain in "Open".
- `README.md`: line 202 example used `"Shipped enquire v0.7.1"` — now version-agnostic. Line 304 said `npm test # 130+ unit tests` — generalized to "full suite (count in the badge)". Line 332 historical block claimed `0.7.x — current` — replaced with current 0.10.x → 0.7.x narrative.
- `README.md`: dependency claim updated from "four runtime dependencies" to "four mandatory + one optional (`better-sqlite3`)".
- `README.md`: 10k+ vault story now points at the FTS5 path (which shipped) instead of the prior "would help, on the Phase 3 roadmap" wording.
- `assets/social-preview.svg`: terminal mockup said `"You shipped the v0.7 spec."` — now version-agnostic.

### Tests
- 186 unit tests (was 185). 1 new negative-assertion regression test for the chunk-resource raw-content fix.

### What I'd done as a meta-pass: why was the chunk leak missed?
- The v0.10.0 wikilink-recall test asserted *positive* recall (search finds the file). It didn't assert *absence* of the synthetic enrichment in resource output.
- The v0.10.2 `getChunk` test used `toContain("first paragraph")`, which silently passes even when the chunk has extra trailing content.
- Storage column and API response field were treated as the same thing by default — nothing in the test discipline caught the divergence. Lesson: round-trip exact-equality assertions for any "fetch what you stored" path.
- A `grep` of `src/` for similar "store enriched / serve to user" patterns found this was the ONLY occurrence; no other path returns indexed-form data via a user-facing resource or tool.

## [0.10.3] — 2026-05-03

Re-release of v0.10.2. The v0.10.2 git tag exists, but the auto-publish workflow's `npm run lint` step failed on CI (a biome `useTemplate` finding that registered as `info` locally but was `error` on the CI image). v0.10.2 never reached npm; v0.10.3 contains the same code plus the lint fix and is the first npm-published version with chunk-level addressing.

### Same content as v0.10.2 (since the tag was a no-op on npm):
- **MCP resource template `obsidian://chunk/{chunkIndex}/{+notePath}`** — only registered when `--persistent-index` is on. Returns chunk content + line range as JSON. Closes the addressing gap so MCP clients can deep-link directly into specific chunks returned by `obsidian_full_text_search`.
- **`FtsIndex.getChunk(relPath, chunkIndex)`** public method backing the resource.

### Fixed (vs the broken v0.10.2 release attempt)
- `scripts/bench-search.mjs` line 38: string concatenation → template literal (biome `useTemplate` rule).
- `src/fts5.ts` `getChunk` signature line-wrap (biome formatter).

## [0.10.2] — 2026-05-03

**⚠️ Tagged but never published to npm** — the auto-publish workflow's lint step failed on a biome formatting check. Use v0.10.3, which contains identical functionality plus the lint fix.



Closes the last open item from the v0.10 roadmap (issue #10 suggestion 1): chunk-level addressing for FTS5 search hits.

### Added
- **MCP resource template `obsidian://chunk/{chunkIndex}/{+notePath}`** — only registered when `--persistent-index` is on. Returns chunk content + line range as JSON. Closes the addressing gap so MCP clients can deep-link directly into specific chunks returned by `obsidian_full_text_search` (e.g. surface a "show full chunk" follow-up button after a search hit).
- **`FtsIndex.getChunk(relPath, chunkIndex)`** public method backing the resource (returns content + line_start + line_end, or `null` for out-of-range / missing).

### URI shape
```
obsidian://chunk/0/01_Projects/Apollo.md   → chunk 0 of 01_Projects/Apollo.md
obsidian://chunk/3/notes/long-note.md      → chunk 3 of notes/long-note.md
```

Index goes FIRST (single path segment, no slashes) so the rest of the URI greedily eats the note path including subdirectories — keeps the template unambiguous.

### Tests
- 185 unit tests (was 184). 1 new for `getChunk` covering hit / out-of-range / missing-path.

## [0.10.1] — 2026-05-03

Closes the open items from the v0.10.0 changelog: filter args on the FTS5 path, plus a real bench comparing the two search backends.

### Added — filter API on `obsidian_full_text_search`
- **`tag` filter** — exact-tag membership (e.g. `tag: "project"`). Matches both frontmatter and inline tags. Implemented via a comma-wrapped `LIKE` against an indexed `tags` column on `chunks`. Won't false-match `core-team` for `tag: "core"` (the comma boundary makes membership explicit).
- **`since` filter** — ISO 8601 date or timestamp; restricts to chunks whose source note's `mtime ≥ since`. Joins against `source_state.mtime_ms`.
- **`folder` filter** continues to work; all three filters compose with AND semantics.
- The tool response now echoes `applied_filters: { folder, tag, since }` so callers see exactly which filters narrowed the result.

### Schema migration
- Added `tags` UNINDEXED column to `chunks`. Bumped `SCHEMA_VERSION` from 1 → 2 — existing v0.10.0 indexes auto-rebuild on first v0.10.1 boot (~5s for 1k files); a stderr warning explains why the next sync is longer than usual.

### Bench numbers
[`scripts/bench-search.mjs`](./scripts/bench-search.mjs) now compares both paths on the same synthetic vault. Direct function calls — no MCP RPC overhead.

| Vault    | scan cold | scan warm | fts5 build | fts5 warm | speedup (warm) |
|----------|-----------|-----------|------------|-----------|----------------|
| 100      | 12.2ms    | 3.7ms     | 22.9ms     | 0.1ms     | **37x**        |
| 500      | 31.7ms    | 15.7ms    | 123.5ms    | 0.2ms     | **78x**        |
| 1000     | 61.4ms    | 31.0ms    | 314.7ms    | 0.3ms     | **103x**       |

The gap widens with vault size — scan is O(N), FTS5 is effectively constant. Cold-build is a one-time cost per vault (subsequent boots are incremental: ~50ms when nothing changed).

### Tests
- 184 unit tests (was 181). 3 new for the filter args: tag exact-match, since timestamp filter, combined folder+tag+since composition.

### Pending for v0.11+
- `obsidian://chunk/<path>#<index>` resource URI for chunk-level addressing (issue #10 suggestion 1).

## [0.10.0] — 2026-05-03

Anchor feature: SQLite FTS5 inverted index. Architecture and reference numbers contributed by an external user via [issue #10](https://github.com/oomkapwn/enquire-mcp/issues/10) — full credit in `src/fts5.ts` header.

### Added
- **Opt-in `--persistent-index` flag** for `enquire-mcp serve` — boots a SQLite FTS5 inverted index, syncs against the live vault on startup (`~5s` cold for ~1k files, `~50ms` incremental on subsequent boots).
- **New CLI subcommand**: `enquire-mcp index --vault <path>` for explicit cold-build / refresh outside `serve`.
- **New MCP tool `obsidian_full_text_search`**, registered only when `--persistent-index` is on. BM25-ranked, sub-100ms on multi-thousand-note vaults. Returns chunk-level hits with `«…»`-bracketed snippets.
- **`--tokenize unicode61|trigram`** flag — defaults to `unicode61 remove_diacritics 2` (Latin / Cyrillic). Use `trigram` for CJK / mixed-script vaults at ~2x index-size cost.
- **`--index-file <path>`** to override the default index location (`~/Library/Caches/enquire/<hash>.fts5.db` on macOS, `~/.cache/enquire/<hash>.fts5.db` on Linux).
- **New optional runtime dep**: `better-sqlite3` (sync API; lazy-loaded so `npm install` without native build tools still succeeds — only fails when `--persistent-index` is actually used).

### Index design
- `chunks` (FTS5 virtual table): paragraph-first chunking with `\n\n → \n → hard-cut at 4 KB` fallback. Each chunk carries 1-based line offsets for precise quoting.
- `source_state` (mtime tracking): incremental updates skip files whose mtime hasn't changed.
- `meta` table tracks `schema_version`, `vault_root`, and `tokenize_mode`. A change to any of those triggers an automatic index reset on next open with a stderr warning so the user knows why the next sync is longer.
- Wikilink targets are appended as a `[wikilink_targets: A, B]` meta-line per chunk so a search for a target name recalls notes that link to it without naming it inline.
- Hyphenated tokens (e.g. `claude-telegram`) are auto-quoted by `safeFts5Query` so users don't have to learn FTS5 syntax. Reserved keywords (`AND` / `OR` / `NOT` / `NEAR`) are stripped from queries.

### Tests
- 181 unit tests (was 163). 18 new for FTS5: query escaping, chunking edge cases (paragraph / line-fallback / hard-cut), full index lifecycle, `diff()` categorization, `dropFile`, cross-vault guard, tokenize-mode rebuild, wikilink-target recall, folder filter. All FTS5 tests skip gracefully if `better-sqlite3` couldn't be loaded.

### Docs
- README: `obsidian_full_text_search` row added to the read-tools table; "10 read tools" → "10 read tools + 1 opt-in".
- `docs/api.md`: full tool spec, CLI subcommand block, roadmap reflects what's still open vs landed.

### Pending for future patch / minor releases
- Filter args (`tag`, `since`) on `obsidian_full_text_search`.
- `obsidian://chunk/<path>#<index>` resource URI for chunk-level addressing from MCP clients.
- Bench numbers from the FTS5 path vs the linear scan — preliminary local numbers in [scripts/bench-search.mjs](./scripts/bench-search.mjs) suggest the gap widens steeply past ~2k notes.

## [0.9.0] — 2026-05-03

External-user feedback on `obsidian_search_text`. Three issues, all addressed.

### Changed (BREAKING — semver-minor on 0.x is fine)
- **`obsidian_search_text` default semantics: substring → AND-tokenizer.** Pre-v0.9, a query like `"meeting notes"` only matched files where those two words were a contiguous substring (literal phrase). It silently returned `[]` even when both words appeared separately in a file — confusing and indistinguishable from a broken call. Reported by an external user.

  v0.9 default tokenizes the query on whitespace and requires every token to appear in the note (mode `"all"`). New `mode` parameter:
  - `"all"` — every token must appear (default, AND).
  - `"any"` — at least one token (OR).
  - `"phrase"` — pre-v0.9 contiguous-substring match (use this for the old behavior).

  Migration: if you relied on the old behavior, pass `mode: "phrase"`.

- **`obsidian_search_text` response shape: bare array → structured object.** Was: `[{path, snippet, score, line}]`. Now: `{query, mode, scanned_notes, matches: [{path, snippet, score, line, matched_terms}]}`. The wrapper closes the "0 matches vs broken silently" antipattern (you can now see how many notes were scanned and which terms were used). `matched_terms` lists which tokens actually hit, useful for diagnostic.

### Performance
- **`obsidian_search_text` reads files in parallel chunks of 16** (was strictly sequential). On a 100-note vault that's roughly a 4–8x cold-cache speedup for the search path. Open-fd consumption is bounded by the chunk size. Larger vaults still benefit from `--persistent-cache` for warm reads.

### Tests
- 163 unit tests (was 159). 4 new for `searchText`: AND-default, `any` mode, `phrase` mode (backward-compat), structured-response with `scanned_notes` on zero matches.

### Migration cheat-sheet
```diff
- searchText({ query: "weekly review" })
+ searchText({ query: "weekly review", mode: "phrase" })  // if you wanted the old phrase match
+ searchText({ query: "weekly review" })                  // new default: any note with both words
```

## [0.8.1] — 2026-05-03

### Fixed
- **`npm install -g github:oomkapwn/enquire-mcp` left a broken symlink in `node_modules`**: `dist/` is `.gitignore`d, so a fresh git clone has no compiled output. npm runs the `prepare` script automatically on git-source installs, but `package.json` had none — so npm completed the clone, found no `bin` target, silently cleaned up the tmp clone, and the global symlink ended up pointing at a now-deleted path.

  Fix: added `"prepare": "tsc && chmod +x dist/index.js"` to `package.json` `scripts`. Git-source installs now build automatically. Registry installs (`npm install -g @oomkapwn/enquire-mcp`) were unaffected — the npm tarball already ships `dist/`.

  Reported by an early user. Thank you 🙏

### CI
- v0.8.1 is the first release published via the new `.github/workflows/release.yml` workflow — `npm publish --provenance` runs in CI on `v*` tag push, no manual `npm publish` needed. The published package now carries the npm "Published with provenance" trust badge.

## [0.8.0] — 2026-05-03

Closes the v0.8 backlog from the post-launch audit pass: one DQL semantic correction, four P0 test gaps, and the standard Code of Conduct.

### Changed (potentially breaking — semver-minor on 0.x is fine)
- **DQL `contains` for arrays is now exact-membership, not substring**: `WHERE file.tags contains "core"` no longer falsely matches a `core-team` tag. Strings keep substring semantics (e.g. `WHERE title contains "draft"` still works as before). The previous behavior was a v0.7.x correctness bug that diverged from the Dataview convention this query language emulates. If you relied on substring matching against array elements, switch to `like` with explicit wildcards (e.g. `tags like "*core*"`).

### Added (test coverage for previously-implicit behavior)
- **Empty `[[]]` wikilink** — locked in as "produces no link" (whereas `[[ ]]` with one space is still a link target, surfaced to the user).
- **UTF-8 BOM-prefixed files** — confirmed they parse correctly through `gray-matter`.
- **`createNote` file mode** — verified files are created with reasonable permissions (read+write to owner, no exec bits).
- **DQL `!=` against missing fields** — confirmed absent fields evaluate as "not equal" to any compared value (Dataview-compatible).

### Added
- **`CODE_OF_CONDUCT.md`** based on Contributor Covenant 2.1. Brings the GitHub community profile to 100%.

### Tests
- 156 unit tests (was 150). 6 new regression tests covering all four P0 audit gaps + the DQL contains semantics change (2 tests).

## [0.7.6] — 2026-05-03

Audit-pass cleanup: two real correctness bugs in write-mode + DQL, plus a privacy guarantee tightening and a few P3/P4 polishes.

### Fixed
- **P2 — `obsidian_create_note` could corrupt YAML frontmatter**: the hand-rolled YAML renderer in `tools.ts` quoted only a narrow set of special chars, so date-like strings (`"2026-05-03"`), values starting with `!`/`>`/`@`, and values containing `|` either round-tripped as the wrong type (timestamp instead of string) or produced YAML that `gray-matter` couldn't parse back. Replaced with `gray-matter`'s `stringify` (backed by `js-yaml`) — every YAML edge case is now correctly handled. Two regression tests added (`tests/write.test.ts`).
- **P2 — DQL parser collapsed whitespace inside quoted strings**: `parseDql` did a global `.replace(/\s+/g, " ")` *before* the quote-aware tokenizer ran. Folder names like `"Two  Spaces"` and frontmatter values like `"in  progress"` silently lost their repeated whitespace and failed to match. Removed the global collapse — `splitClauses` is already quote-aware and handles separator whitespace correctly. Three regression tests added (`tests/dql.test.ts`).
- **P3 — Persistent-cache directory mode could be looser than `0700`**: `fs.mkdir({ mode: 0o700 })` only applies on creation. If the cache parent directory already existed with looser perms (custom `--cache-file` path, or pre-existing XDG dir), the README/SECURITY.md `0700` guarantee was unenforced. Added a follow-up `chmod(dir, 0o700)`.
- **P4 — DQL `LIMIT` accepted floats**: `LIMIT 1.5` silently truncated to `1`. Now requires `Number.isInteger(n)`.

### Tests
- 150 unit tests (was 142). 8 new regression tests covering the YAML, DQL whitespace, and LIMIT edge cases.

### Docs / assets
- Social preview banner: `140 tests` → `142 tests` (also matches v0.7.5 baseline; the v0.7.6 PNG re-render reflects 142 since that's what the v0.7.5 published baseline showed). README badge already at 142.

## [0.7.5] — 2026-05-03

**Critical hotfix** — v0.7.4 (and likely all earlier published versions) had a CLI guard that compared `import.meta.url` (resolved through realpath) against `process.argv[1]` (raw, no symlink resolution). When npm installs the package, the `bin` entry is exposed as a symlink in `node_modules/.bin/`, and on macOS `/tmp` is itself a symlink to `/private/tmp` — so the comparison failed and `main()` never ran. The CLI exited 0 with no output, making `npx -y @oomkapwn/enquire-mcp serve …` a no-op.

### Fixed
- `src/index.ts` `isCliEntry` check now `realpathSync`s both sides of the comparison. Tested via two regression cases in `tests/cli.test.ts`: (1) explicit symlink mimicking the npm bin shim, (2) macOS `/tmp` indirection.

### Tests
- 142 unit tests (was 140). 2 new regression tests for the CLI guard.

### Mitigation for users on 0.7.4
- v0.7.4 has been deprecated on npm with a redirect message. `npx -y @oomkapwn/enquire-mcp@latest …` automatically picks up 0.7.5.

## [0.7.4] — 2026-05-03

Repeat-audit pass — five public-facing inconsistencies closed.

### Packaging
- Regenerated `package-lock.json`. The lockfile root still claimed `@oomkapwn/obsidian-mcp@0.4.0` with `node>=18` and bin `obsidian-mcp` — pre-rename identity. Now correctly reflects `@oomkapwn/enquire-mcp@0.7.4`, `node>=20`, bin `enquire-mcp`. No dependency-tree changes.

### Docs
- README "Support the project" links now use absolute GitHub URLs (`https://github.com/oomkapwn/enquire-mcp/issues/new?template=...`) instead of relative `./.github/...` paths that would 404 when the README is rendered on npmjs.com.
- `docs/api.md` "Phase 3 (planned)" section renamed to "Roadmap" and rewritten — it claimed persistent cache and write tools were future work, but both shipped in v0.6.0 / v0.3.0 respectively. Now lists actual remaining items (cross-vault index, full DQL, rename/move tools, graph queries).
- `.github/ISSUE_TEMPLATE/bug_report.yml` version placeholder bumped from `0.7.1` to neutral `0.7.x` so it doesn't drift again next release.
- Social preview banner updated: `137 tests` → `140 tests`. Both SVG and rendered PNG refreshed.

### Security
- **P1 — Symlink-overwrite via `obsidian_create_note` with `overwrite=true`**: if a path inside the vault was a symlink whose target lived outside the vault, `fs.writeFile(abs, ...)` followed the link and overwrote the outside file. The existing `assertParentInsideVault` only protected parent directories; the leaf target was unchecked. Fix: `writeNote` now `lstat`s the target before writing and refuses if it's a symlink. The `overwrite=false` path was unaffected (a dangling symlink-to-missing-target presents as `not exists` to `fs.stat`, but `lstat` catches it explicitly). Regression test added.

### Packaging
- Added `assets/social-preview.png` to the `files` list in `package.json`. Without it, the README hero image rendered broken on npmjs.com — the file was referenced but not shipped. Tarball grew from ~58 kB → ~214 kB (the PNG is 159 kB).

### Repo hygiene
- Added `.claude/` to `.gitignore`.

### Tests
- 140 unit tests (was 139).

## [0.7.2] — 2026-05-03

### Security
- **P1 — Cache pollution via path traversal**: a crafted persistent-cache file with a `relPath` like `../../../etc/hosts` could pollute the in-memory cache with content keyed by paths outside the vault root. The orphaned entry was never *served* via tools (`resolveSafePath` blocks reads to out-of-vault paths), but it would persist back to the on-disk cache file on the next save, perpetuating the pollution. Fix: `loadDiskCache` now validates the resolved abs path stays inside the vault (relative-path check + `realpath` belt-and-braces). Two regression tests added (relative `../` traversal and absolute paths).

### MCP-spec correctness
- **Write tool annotations**: `obsidian_create_note` (which can overwrite irreversibly with `overwrite=true`) and `obsidian_append_to_note` (which mutates persistent state) were both annotated `destructiveHint: false`. Per MCP spec, `destructiveHint: true` is the right hint for tools that may make non-undoable changes. Updated. Read tools remain `destructiveHint` unset / `readOnlyHint: true`.

### Cleanup
- Dead conditional in `likeToRegex`: simplified `next === "*" || next === "\\" ? \`\\${next}\` : \`\\${next}\`` to its always-equal RHS. No behavior change.
- README coverage badge drifted from 83% → actual 82% lines (slight churn after persistent-cache code added). Refreshed badge and the per-percent breakdown.

### Docs
- README gains a "Support the project" section (star CTA + bug-report / feature-request / PR / Discussions pointers) and the ENQUIRE/Berners-Lee origin moved into the credits as a one-paragraph close.

### Tests
- 139 unit tests (was 137). 2 new regression tests for cache path-traversal (relative `..` escape and absolute path).

## [0.7.1] — 2026-05-03

**Second rename: `memex` → `enquire-mcp`.**

### Why a second rename
After v0.7.0 shipped under «memex», a deeper landscape audit revealed the `memex` namespace is even more contested than `obsidian-mcp`:
- **[WorldBrain Memex](https://github.com/WorldBrain/Memex)** — established browser extension with an explicit **memex-obsidian** plugin. Direct user-confusion risk.
- **[iamtouchskyer/memex](https://github.com/iamtouchskyer/memex)** (npm `@touchskyer/memex`) — Zettelkasten persistent memory for AI coding agents. Same client list (Claude Code / Cursor / Codex / Windsurf), same MCP positioning. Functionally near-identical.
- **[memex.tech](https://memex.tech/)** — commercial product with active MCP launch.
- **[memex.ai](https://memex.ai/)** — commercial brand.
- **[`memex-ai`](https://www.npmjs.com/package/memex-ai)** npm package: «Install the Memex AI MCP server for Claude Code and Claude Desktop». Tight collision.
- Plus `memex-md`, `@ai2070/memex`, `memex-cc`, `memex-vault` (Obsidian template), `memex-life/memex`, `memex-lab/memex`, etc.

We traded one crowded namespace for an even more crowded one. Time to commit to a name with a unique historical referent and minimal commercial collision.

### Why ENQUIRE
[**ENQUIRE**](https://en.wikipedia.org/wiki/ENQUIRE) is the program Tim Berners-Lee wrote at CERN in 1980 to track «the complex web of relationships between people, programs, machines and ideas». It was the **direct prototype of the World Wide Web** — cards with hyperlinked relationships, exactly the data model we expose to AI agents over MCP. Bush's memex was theoretical; ENQUIRE was real, working hypertext software. No commercial trademark holder. Available on npm with `-mcp` suffix and across all relevant places.

### Renamed
- npm package: `@oomkapwn/memex` → `@oomkapwn/enquire-mcp`
- CLI binary: `memex-mcp` → `enquire-mcp`
- GitHub repo: `oomkapwn/memex` → `oomkapwn/enquire-mcp`
- MCP server `name` reported in handshake: `memex` → `enquire`
- Boot stderr message: `memex <v> ready` → `enquire <v> ready`
- Default cache dir: `~/Library/Caches/memex/` → `~/Library/Caches/enquire/`
- Banner redesigned: «enquire» as brand, «MCP server for Obsidian vaults» subtitle in cyan, Berners-Lee tagline.
- README hero rewritten with the ENQUIRE narrative + Wikipedia link to ENQUIRE.

### Tool names: still unchanged
`obsidian_*` tool names (`obsidian_list_notes`, etc.) **remain `obsidian_`-prefixed** by design. The prefix tells the LLM what domain it's operating in.

### Disclaimer reaffirmed
README and SECURITY.md still carry the «Not affiliated with Obsidian.md» notice. Added clarification that the «enquire» name is a tribute to Berners-Lee's 1980 system, not a trademark claim.

### Tests
Still 137 unit tests, all green. No code changes — pure rename + docs.

## [0.7.0] — 2026-05-03

**First rename: `obsidian-mcp` → `memex`.**

### Why the rename
- The npm/GitHub `obsidian-mcp` namespace turned out to be crowded — at least 12 GitHub projects and 4 npm packages with overlapping names. We're indistinguishable in search.
- Trademark risk: `bitbonsai/mcpvault` was forced-renamed by Obsidian.md in March 2026, even though it didn't contain "obsidian" in the name. Anything with "obsidian" in the package name is exposed.
- The new name (`memex`) is a nod to Vannevar Bush's 1945 essay [As We May Think](https://en.wikipedia.org/wiki/Memex) — the original vision of a personal knowledge system. Resonates with the PKM / second-brain audience without leaning on Obsidian's brand.
- Obsidian-MCP discoverability is preserved via npm description, GitHub topics, README hero subtitle ("MCP server for Obsidian vaults"), and SVG banner — not via the package name.

### Renamed
- npm package: `@oomkapwn/obsidian-mcp` → `@oomkapwn/memex`
- CLI binary: `obsidian-mcp` → `memex-mcp`
- GitHub repo: `oomkapwn/obsidian-mcp` → `oomkapwn/memex`
- MCP server `name` reported in handshake: `obsidian-mcp` → `memex`
- Boot stderr message: `obsidian-mcp <v> ready` → `memex <v> ready`
- Default cache dir: `~/Library/Caches/obsidian-mcp/` → `~/Library/Caches/memex/`

### Tool names: unchanged
All `obsidian_*` tool names (`obsidian_list_notes`, `obsidian_read_note`, etc.) **remain `obsidian_`-prefixed** by design. The prefix tells the LLM what domain it's operating in. We are an MCP server that operates on Obsidian vaults; the tools should advertise that.

### Disclaimer added
Explicit "Not affiliated with Obsidian.md" notice in README and SECURITY.md. Obsidian and the Obsidian logo are trademarks of Dynalist Inc.

### Bundled fixes

**Cleanups carried into this release:**
- **DQL `LIKE` regex bug**: `\*` (escaped literal asterisk) used to compile to `^\\*$` — a regex matching "any number of literal backslashes" — instead of matching a literal `*`. Rewrote `likeToRegex` as a single-pass walker so escaping is unambiguous.
- **Disk cache load: parallelized stats**: `loadDiskCache` now does `Promise.all` over all entry-stat checks instead of awaiting them one at a time.
- **Disk cache size guard**: refuses to load or save cache files exceeding 50 MB by default (configurable via `maxDiskCacheBytes`).
- **Disk cache per-entry validation**: rejects entries whose `content` exceeds `maxFileBytes`, whose `relPath` isn't a string, or whose `mtimeMs` isn't a number.
- **`beforeExit` flush race**: guarded by a `saved` flag so flush completion doesn't trigger recursive `beforeExit`. Signal handlers use `process.once`.

**Audit findings closed:**
- **Persistent cache size-limit bypass**: `loadDiskCache` filters oversized entries from the in-memory cache load.
- **Persistent cache privacy**: cache file is now written with mode `0600` and parent directory `0700`. Documented explicitly in [README "Cache & privacy"](./README.md#cache--privacy) and [SECURITY.md](./SECURITY.md). Added test for file mode.
- **Deleted-note content lingers in cache**: when `loadDiskCache` skips entries because the source file was deleted (or is mtime-stale, or oversized), the cache is now marked dirty. Next save writes a clean file without those entries. Added test for deleted-note purge.
- **`clear-cache` CLI subcommand**: `enquire-mcp clear-cache --vault <path>` deletes the persistent-cache file. Returns 0 even if no file exists.
- **Node 18 incompatibility**: `commander` 14 and `vitest` 4 (shipped in v0.3.3) require Node ≥ 20. Bumped `engines.node` to `>=20`, dropped Node 18 from CI matrix (now `[20, 22, 24]`), updated README badge.
- **DQL malformed `OR` / `FROM #` accepted as match-all**: `parseWhere` now rejects empty `OR` / `AND` groups (trailing-OR, duplicated-OR-OR, trailing-AND, etc.) with `DqlParseError`. `parseSource` rejects `FROM ""` and `FROM #` with no tag name. 5 regression tests added.
- **Stale `obsidian_dataview_query` description**: tool description still claimed "no OR" — updated to reflect `AND`/`OR`, `=`/`!=`/`contains`/`like` operators, and the actual unsupported list (`FLATTEN`/`GROUP BY`/parens).
- **README stale references** (`119 unit tests`, `0.3.x current`, "no OR" FAQ) refreshed.

### Tests
- 137 unit tests (was 119). New since v0.6.0:
  - Cache mode `0600` enforced on save
  - Deleted-note entries purged on next save after load
  - `clearDiskCache` integration
  - Oversized cached content rejected on load
  - DQL: `FROM #` rejected (audit P2-4)
  - DQL: `FROM ""` rejected
  - DQL: trailing `OR` rejected
  - DQL: trailing `AND` rejected
  - DQL: `OR OR` (empty middle group) rejected
  - DQL: `LIKE` with regex specials (`a.b` is literal)
  - DQL: `LIKE` with `\*` matches literal asterisk

## [0.6.0] — 2026-05-02

Adds an opt-in persistent on-disk cache for warm cold-starts on large vaults.

### Added
- `--persistent-cache` CLI flag — opt-in. When set, the parsed-note cache is loaded from disk on boot and written back on graceful shutdown (SIGINT/SIGTERM/`beforeExit`). On second startup of the same process against an unchanged vault, repeat parses are skipped — net win on tools that walk the whole vault (`get_backlinks`, `search_text`, `list_tags`, `get_unresolved_wikilinks`).
- `--cache-file <path>` flag to override the default cache file location (useful for sandboxed environments).
- Default cache location: `$XDG_CACHE_HOME/obsidian-mcp/<vault-hash>.json` if set, otherwise `~/Library/Caches/obsidian-mcp/<hash>.json` on macOS, `~/.cache/obsidian-mcp/<hash>.json` on Linux. Vault path is hashed (sha1, 12 chars) so multiple vaults coexist.
- Atomic writes: cache is staged to `<file>.tmp` and renamed on success.
- Schema-versioned cache (`version: 1`) — invalidates whole file if shape ever changes between releases.
- Stale-entry detection: each entry stores its source mtime; on load, mismatched mtimes are silently dropped.
- Cross-vault protection: cache is rejected if its `root` field doesn't match the current vault realpath.

### Why opt-in (not default)
- The default fast path (in-memory cache + per-read mtime stat) is already O(1) for repeat reads within a session. Persistent cache only helps **across** process restarts, which most MCP-client workflows don't need (the client keeps the server warm).
- For users who do restart often (e.g. CI bots, scratch agents on huge vaults), the flag delivers a meaningful warm-cache start. Once we have telemetry from real users, we may flip the default.

### Skipped: chokidar-based watch mode
- Decided to skip for now. The current mtime-on-read check is correct and cheap (one `fs.stat` per read), and chokidar adds ~50KB of dep weight without measurable user-facing benefit at our vault sizes. Will revisit in v0.7+ if a benchmark says otherwise.

### Tests
- 126 unit tests (was 119). 7 new for persistent-cache: opt-in default-off, write-then-read round-trip, mtime invalidation, vault-root rejection, version mismatch rejection, corrupt-file graceful fallback, and cache file write atomicity.

## [0.5.0] — 2026-05-02

Stricter TypeScript, lint/format with Biome, and DQL gains `OR` + `LIKE`.

### Added (DQL)
- `OR` between predicate groups: `WHERE a = 1 OR b = 2`. `OR` has lower precedence than `AND`, so `a = 1 AND b = 2 OR c = 3` parses as `(a = 1 AND b = 2) OR (c = 3)`. Quote-aware tokenizer ensures `"OR"` inside a string is data, not a clause boundary.
- `like` operator: SQL-LIKE-style wildcard matching, case-insensitive. `*` is the wildcard, `\*` is a literal asterisk. Works on string fields and on string elements of array fields. Examples: `file.name like "draft*"`, `status like "*progress*"`.

### Changed (DQL parse model — backward compatible at the query level)
- `DataviewQuery.where` is now `Predicate[][]` (disjunction of conjunctions) instead of `Predicate[]`. Querie strings without `OR` produce a single-element outer array, so existing AND-only queries keep working unchanged.

### Code quality
- TypeScript strict++: enabled `noUncheckedIndexedAccess` and `noImplicitOverride`. Surfaced and fixed real defensive-coding gaps in `dql.ts` and `parser.ts` where regex match groups and array indexing could return `undefined`. (`exactOptionalPropertyTypes` was tried and removed — fights too hard with Zod-inferred types.)
- **Biome 2** added as a lint+format toolchain: `npm run lint`, `npm run lint:fix`, `npm run format`. CI gains a dedicated `lint` job. `prepublishOnly` now runs `lint && build && test`. Codebase formatted to a consistent house style (line-width 120, double quotes, trailing-comma none).
- All `catch (err: any)` replaced with `catch (err) { if (isErrnoException(err)) ... }` for type-safe error handling.

### Tests
- 119 unit tests (was 112). New coverage: `OR` parsing, mixed AND/OR precedence, `LIKE` parsing, `LIKE` matching with leading/trailing wildcards, `LIKE` case-insensitivity. Plus 2 quote-aware-keyword tests now covering `OR`.

## [0.4.0] — 2026-05-02

Two new vault-introspection tools, three new workflow prompts, and CI-driven coverage.

### Added (read tools)
- `obsidian_get_unresolved_wikilinks` — find every `[[wikilink]]` (and `![[embed]]`) whose target doesn't resolve. Vault-hygiene utility for finding broken links, typos, and intended-but-not-yet-created notes. Args: `folder?`, `include_embeds?`, `limit?`. Returns `{ from_path, target, raw, kind, alias, section, block, line, snippet }`.
- `obsidian_get_outbound_links` — symmetric counterpart to `obsidian_get_backlinks`. For one note, lists every link it points to with each one's resolution status. Args: `path?`, `title?`, `include_embeds?`, `include_unresolved?`. Returns `{ from_path, from_title, links: [...] }`.

### Added (prompts)
- `weekly_review` — aggregates the past 7 days of edits, groups by tag, surfaces "shipped / open / stuck" per group, ends with a 2-sentence reflection on actual vs. intended energy spend.
- `extract_todos` — greps TODO / FIXME / QUESTION across the vault (optionally filtered by `folder` and/or `tag`), groups verbatim hits by note, picks one highest-leverage next action.
- `process_inbox` — walks an inbox folder (`folder` required) and for each note proposes Move / Merge / Promote / Archive based on tags, content, and inbound/outbound links. Doesn't actually move anything — proposal-only.

### Added (CI / observability)
- `npm run test:coverage` — vitest with the v8 coverage provider.
- New CI job `coverage`: runs on every push/PR, uploads the full HTML report as a workflow artifact (`coverage-report`).
- README badges now include `tests-112-passing` and `coverage-83%-lines`.

### Tests
- 112 unit tests (was 103). New coverage: 4 cases for `get_unresolved_wikilinks` (basic detection, filtered out resolved, folder filter, embeds toggle), 5 cases for `get_outbound_links` (basic listing, embed toggle, unresolved marking, unresolved filter, alias/section/block preservation).
- Coverage on this release: **83% lines · 79% statements · 73% branches · 67% functions** (the function gap is mostly MCP wiring in `index.ts`, which is exercised by the smoke test rather than unit tests).

### Surface size
- 10 read tools (was 8) + 2 opt-in write tools.
- 2 MCP resources.
- 6 MCP prompts (was 3).

## [0.3.3] — 2026-05-02

Dependency triage — all 7 outstanding Dependabot major-version PRs landed in a single verified bump. Each was tested locally (full test suite + JSON-RPC smoke against a synthetic vault) before bundling.

### Dependencies
- `@types/node` 22 → 25 (devDep)
- `typescript` 5 → 6 (devDep) — required adding `types: ["node"]` to `tsconfig.json`. TS 6 dropped the implicit fallback that auto-discovered `@types/node` ambient globals; `process`, `Buffer`, and `node:*` modules need an explicit type-resolution hint now.
- `commander` 12 → 14 (runtime) — no API surface change in our usage.
- `zod` 3 → 4 (runtime) — `z.string().optional()`, `z.boolean().optional()`, `z.record(z.string(), z.unknown())` all migrate cleanly. No app code changes.
- `vitest` 2 → 4 (devDep) — also resolves the moderate-severity vulnerabilities flagged by `npm audit` in the `vite` / `esbuild` chain (Dependabot security PRs #8 and #9 superseded).

### Tests
- 103 unit tests, all green on the new dependency stack.
- Smoke green: 17 checks, all 10 MCP tools + 2 resources + 3 prompts verified against the synthetic CI vault.

### Notes
- Zero application code changes — pure dependency updates with one tsconfig tweak.
- Dependabot PRs #3 — #9 closed as superseded by this release.

## [0.3.2] — 2026-05-02

External read-only audit pass closed four real findings.

### Security & correctness
- **P2** `listMarkdown(folder)` now `lstat`s and realpath-checks the start directory before walking. Previously, passing a vault-internal symlink that pointed *outside* the vault as the `folder` argument would enumerate the external directory's `.md` files (reads still failed downstream, but the listing leaked filenames). Fix: empty list returned in that case.
- **P2** `--max-file-bytes` and `--cache-size` are now validated as positive finite integers at server boot. Previously, passing `NaN` / `Infinity` / floats / negative values silently disabled the size guard and produced unpredictable cache behavior. The server now exits with a clear error.
- **P2** `obsidian_read_note` now honors its documented contract — `path` works with *or* without the `.md` extension, matching the schema description and the parallel behavior of `obsidian_create_note`.
- **P3** Inline tag regex is now Unicode-aware: `#русский`, `#日本語`, `#café-au-lait`, `#русский/путь` all parse correctly. Previously the regex started with `[A-Za-z]` and silently dropped non-ASCII tags, contradicting the README's i18n promise.

### Packaging
- `docs/api.md` and `SECURITY.md` are now included in the npm tarball — README links from the published package no longer 404.
- CI: `actions/setup-node@v4` → `v6` on `main` (dependabot superseded).

### Docs
- README quick-start no longer hard-codes a stale boot-message version string.

### Tests
- 103 unit tests (was 86). New regression coverage for every audit finding above:
  - `listMarkdown(folder)` returns `[]` for symlinked-out start directory (P2-1).
  - `parsePositiveInt` rejects NaN / Infinity / non-integer / non-positive / non-numeric (P2-2).
  - `obsidian_read_note` accepts paths with and without `.md` (P2-3).
  - Cyrillic / CJK / accented inline tags parse correctly; mid-word `#` does not produce a tag (P3-1).

## [0.3.1] — 2026-05-02

### Security
- `obsidian_create_note` now realpath-checks the *parent directory* of the target before writing. Previously, a parent dir that was a symlink resolving outside the vault would let a write escape the vault root. With this fix, such writes are refused.

### Fixed
- Cache eviction is now a true **LRU** instead of FIFO — re-reading a cached entry bumps it to the freshest slot. README/CHANGELOG already advertised LRU; behavior now matches docs.
- Dropped a small dead-code path in `obsidian_list_tags` (an unused `WeakMap`).

### Added
- `obsidian_dataview_query` now applies a default row cap of **1000** when the query has no explicit `LIMIT`. Prevents runaway responses on huge vaults.
- CI gains a dedicated **smoke job** that builds a synthetic vault and runs the JSON-RPC end-to-end against the real binary.
- CI gains an **`npm audit --audit-level=high`** job.
- CI hardened with `permissions: contents: read`, `timeout-minutes`, and concurrency cancellation.
- New tests (86 total, was 79): LRU eviction order, internal-symlink rejection in walker, path-form wikilink backlink, mtime moves forward across write→append, write refusal when parent dir is a symlink to outside the vault, default-row-cap behavior in DQL.
- `SECURITY.md`, GitHub issue templates (bug / feature), PR template, FUNDING.yml.

### Docs
- Major README rewrite for launch readiness: value-prop lead, comparison table vs filesystem MCPs, "who is this for?" section, ASCII architecture diagram, FAQ, transactional install / `npx` / global blocks.
- `docs/api.md`: documented tag-counting semantics (`fm + inline == count`) and the default DQL row cap.

## [0.3.0] — 2026-05-02

### Added
- `obsidian_list_tags` — every unique tag in the vault with frontmatter / inline counts. Sorted by usage.
- **Opt-in write tools** behind `--enable-write`:
  - `obsidian_create_note` — creates a new note with optional frontmatter; refuses overwrite by default.
  - `obsidian_append_to_note` — appends a markdown block to an existing note (`path` or `title`).
- **MCP resources**:
  - `obsidian://vault/info` — vault metadata (root, note count, limits, write flag).
  - `obsidian://note/<relative-path>` — every note as a browsable resource via `ResourceTemplate`.
- **MCP prompts**: `summarize_recent_edits`, `review_tag`, `find_orphans`.
- **Tool annotations**: every read tool tagged `readOnlyHint: true, idempotentHint: true`; write tools tagged `readOnlyHint: false`.
- New CLI flags: `--enable-write`, `--max-file-bytes <n>`, `--cache-size <n>`.

### Security & robustness
- Vault walker skips symbolic links and refuses to descend into directories whose realpath exits the vault.
- `realpath`-based safety check on every read/write target — prevents symlink-escape attacks even if a link is created after server boot.
- File-size guard (default 5 MB) on every read and write — blocks oversized binary-renamed-md from blowing memory.
- Parsed-note cache is now bounded (default 1024 entries) with FIFO eviction — predictable memory ceiling on huge vaults.
- DQL parser respects quoted strings: `WHERE x = "foo SORT bar"` no longer prematurely splits on `SORT` / `WHERE` / `LIMIT` / `AND` keywords inside string literals.

### Changed
- `obsidian_resolve_wikilink` now also accepts `![[…]]` syntax in its `wikilink` argument.
- `obsidian_read_note` output now includes `embeds` alongside `wikilinks`.
- `package.json` — dropped `main` field (CLI-only package), added `publishConfig.access = public`, added `CHANGELOG.md` to `files`, `prepublishOnly` now runs build *and* tests.
- CLI no longer runs `main()` on bare module import (guarded by `import.meta.url` check).

### Docs
- New `CONTRIBUTING.md` with scope guidelines.
- `.editorconfig` for consistent style across editors.
- README gains a Troubleshooting section, an `npx`-based MCP wiring snippet, and write-flag docs.

### Tests
- 79 unit tests (was 57). New coverage: symlink rejection, oversized-file refusal, malformed YAML fallback, Unicode titles/tags, DQL keyword-in-string, write-tool happy paths and refusals.

## [0.2.0] — 2026-05-02

### Added
- `obsidian_get_backlinks` — list every note that wikilinks (or embeds) the target. Returns ranked hits with snippets and link kind (`wikilink` / `embed` / `mixed`). `include_embeds` flag, default `true`.
- `obsidian_dataview_query` — basic Dataview-style queries: `LIST` / `TABLE col1, col2 FROM ("folder" | #tag) [WHERE field op value [AND …]] [SORT field [ASC|DESC]] [LIMIT n]`. Operators: `=`, `!=`, `contains`. Special fields: `file.name`, `file.path`, `file.mtime`, `file.tags`. Other identifiers read frontmatter.
- Parser now extracts `![[…]]` embeds separately from `[[…]]` wikilinks; both surface in `obsidian_read_note` output.
- Vault gets an mtime-keyed parse cache — repeat reads of an unchanged note are now O(1).
- GitHub Actions CI on Node 18 / 20 / 22.

### Changed
- `obsidian_resolve_wikilink` now also accepts the `![[Embed]]` syntax in its input.
- Read paths route through the new cache, removing redundant `readFile` + `parseNote` work in tools that scan the whole vault.

### Notes
- Dataview implementation is intentionally minimal — no expressions, function calls, joins, or `FLATTEN`. It covers the common LIST/TABLE-with-WHERE shape and explicitly degrades for anything fancier.

## [0.1.0] — 2026-05-02

### Added
- Initial Phase 1 release.
- Five MCP tools: `obsidian_list_notes`, `obsidian_read_note`, `obsidian_resolve_wikilink`, `obsidian_search_text`, `obsidian_get_recent_edits`.
- Stdio transport via `@modelcontextprotocol/sdk` 1.29.
- Wikilink resolver covers aliases (`Note|alias`), section refs (`Note#Heading`), block refs (`Note^id`), and `..` relative paths.
- Path-traversal guards on every read; walker skips `.git`, `.obsidian`, `.trash`, `node_modules`, and dot-dirs.
- 33 unit tests + JSON-RPC smoke test against a real 117-note vault.
