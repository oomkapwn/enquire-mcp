# L6 — Documentation Audit (v3.6.0)

**Audit date**: 2026-05-15
**Branch**: `v3.6.0/post-stable-audit`
**Package version**: `3.6.0` (latest)
**Reference**: `docs/audits/v3.6.0-system-audit-plan.md` §L6

## Scope audited

Root-level: `README.md`, `CHANGELOG.md`, `STABILITY.md`, `CLAUDE.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`.
`docs/`: `api.md`, `QUICKSTART.md`, `COMPARISON.md`, `benchmarks.md`, `http-transport.md`, `api-reference/` (TypeDoc).
`examples/README.md` + JSON drop-ins.

## Summary

- **Internal link integrity**: 1 broken anchor (`docs/api.md` → `README.md#cache--privacy`). All other internal paths resolve.
- **External links**: 1 broken — `https://oomkapwn.github.io/enquire-mcp/` returns 404 (the auto-generated TypeDoc site that README + CHANGELOG advertise has not been deployed yet).
- **Headline counts (44 tools / 19 prompts / 714 tests / branches ≥74%)**: all four verified against source. CHANGELOG coverage numbers match `coverage/coverage-summary.json` exactly.
- **CHANGELOG TL;DR convention**: every entry from v3.5.9 onward carries a `>` TL;DR blockquote — class invariant holds.
- **STABILITY.md export claims**: every named symbol exists in src/.
- **Stale docs**: `CLAUDE.md` still describes rc.3 as "in flight" + rc.4 as "next"; `docs/COMPARISON.md` dated 2026-05-13 / v3.5.8 with **670** test count (now 714) and an erroneous "no public benchmark" claim contradicted by `docs/benchmarks.md`; `docs/api.md` headline blockquote still markets "v2.0 beta" channel that was retired at v3.0; `docs/QUICKSTART.md` cites Node 20 + an obsolete CI-runs-all-three claim + a `3.5.8` example version; README badge + tagline reference `v3.5.x` instead of `v3.6.x`.
- **TypeDoc warnings**: 3 broken `@link` annotations (`findBestMatch`, `suggestSimilar`, `FileEntry`) — TypeDoc emits warnings but exits 0.
- **Command snippets spot-checked**: `enquire-mcp doctor`, `npm run check:changelog-coverage`, `npm run docs:api`, `node scripts/smoke.mjs` all pass against a fresh build on the synthetic vault.

No Critical findings. 1 High (broken GH Pages URL on a flagship "we ship docs" claim). The rest are Medium / Low staleness items that cluster into one class: **per-version docs that weren't refreshed when v3.6.0 stable promoted**.

---

## Finding L6-01 — README + CHANGELOG advertise GitHub Pages URL that returns 404

- **Severity**: HIGH
- **Class**: documentation claims a deployed asset that isn't actually published. Same class as L4-class "CI workflow exists but never ran" findings — drift between "ships X" copy and reality.
- **Description**: `README.md:70` says **"Auto-generated API reference at oomkapwn.github.io/enquire-mcp"** and links the URL. `CHANGELOG.md:20,52,123` repeats the URL across the v3.6.0, v3.6.0-rc.4 entries. `docs/audits/v3.6.0-system-audit-plan.md` baseline expects `oomkapwn.github.io/enquire-mcp/` to host the 111-page TypeDoc site. Reality: `curl -sI https://oomkapwn.github.io/enquire-mcp/` returns **HTTP/2 404** with GitHub Pages's "Site not found" body. The workflow file (`/.github/workflows/publish-docs.yml`) is present and well-formed, but either it has never run successfully on `main`, or GitHub Pages has not been enabled in repo Settings, or the deployment is targeting the wrong branch.
- **Evidence**:
  ```bash
  $ curl -sI https://oomkapwn.github.io/enquire-mcp/ --max-time 10 | head -3
  HTTP/2 404
  server: GitHub.com
  content-type: text/html; charset=utf-8

  $ curl -sI https://oomkapwn.github.io --max-time 10 | head -3
  HTTP/2 404                   # the user landing page also 404s
  ```
  The locally-generated `docs/api-reference/` (111 HTML files, 1.9 MB) is present — `find docs/api-reference -name "*.html" | wc -l` returns `111`, matching the CHANGELOG claim. The local files are correct; only the deployed copy is missing.
- **Cited file:line**:
  - `/Users/alex/Documents/Projects/obsidian-mcp/README.md:70` — "Auto-generated API reference at oomkapwn.github.io/enquire-mcp"
  - `/Users/alex/Documents/Projects/obsidian-mcp/CHANGELOG.md:20` — `| Auto-generated API reference | none | 111 HTML pages at oomkapwn.github.io/enquire-mcp | new`
  - `/Users/alex/Documents/Projects/obsidian-mcp/CHANGELOG.md:52` — "Live: `https://oomkapwn.github.io/enquire-mcp/`"
  - `/Users/alex/Documents/Projects/obsidian-mcp/CHANGELOG.md:123` — README new `## 📖 API reference` section
  - `/Users/alex/Documents/Projects/obsidian-mcp/.github/workflows/publish-docs.yml:1-30` — workflow present + targets `main`
- **Class fix**: Add a CI invariant (could live in `scripts/check-version-consistency.mjs` or new `scripts/check-docs-deployed.mjs`) that hits the README's GH-Pages URL on every release tag and fails the release if the response isn't 200. Pair this with the L4 CI-status audit. Either:
  1. Verify the `publish-docs.yml` workflow ran on the v3.6.0 SHA and surfaced any errors, OR
  2. Enable GitHub Pages in repo settings (Pages → Source → GitHub Actions) if it isn't already, OR
  3. Trigger a manual `workflow_dispatch` run, OR
  4. Remove the URL claims from README/CHANGELOG until Pages is actually live.
- **Per-instance backfill**: After fixing the deployment, re-verify the 3 README + CHANGELOG references resolve. Update any future v3.x release CHANGELOG entries to actually confirm the URL is live before merging.
- **Recommended next action**: v3.6.1 patch — most-visible drift in the project right now (README badge + flagship feature).

---

## Finding L6-02 — `docs/COMPARISON.md` is stale; signed v3.5.8 with 670 tests; contradicts new public benchmarks

- **Severity**: MEDIUM
- **Class**: per-version doc snapshots that fall out of sync with reality between releases. Same class as the L7 / L9 versioning-discipline findings (post-release CHANGELOG drift). Comparison docs are particularly drift-prone because the alternatives evolve too.
- **Description**: `docs/COMPARISON.md:3,46,59,236,242,250` carries multiple v3.5.8-era facts that v3.6.0 invalidates:
  1. **Line 3**: "Numbers and feature claims for enquire-mcp are accurate as of v3.5.8 (2026-05-13)" — should be v3.6.0 / 2026-05-15.
  2. **Line 46**: Test count column reads `**670**` — actual is **714** (+44).
  3. **Line 59**: "enquire-mcp's 44-tool count is exact for v3.5.8 and is verified by the test suite" — still 44 but version annotation stale.
  4. **Line 236**: "None of these servers (including enquire-mcp) ships a public, reproducible end-to-end retrieval benchmark against a shared Obsidian vault" — DIRECTLY contradicted by `docs/benchmarks.md` (shipped in v3.6.0-rc.4), which is the project's flagship differentiator. This sentence as written undermines a major v3.6.0 marketing claim.
  5. **Line 242**: "This is a snapshot as of **2026-05-13**".
  6. **Line 250**: Signature line `— enquire-mcp maintainer, v3.5.8`.
- **Evidence**: `grep -nE "v3.5.8|v3.6.0|v3.5.x" docs/COMPARISON.md` (12 hits, all v3.5.8 or 2026-05-13). Coverage-summary actual test count: `714` (see `coverage/coverage-summary.json`). `docs/benchmarks.md:1-25` is a public benchmark; `bench/benchmarks.json` is reproducible via `npm run bench:retrieval` (verified — `meta.queries_count = 60`).
- **Cited file:line**:
  - `/Users/alex/Documents/Projects/obsidian-mcp/docs/COMPARISON.md:3` — version + date
  - `/Users/alex/Documents/Projects/obsidian-mcp/docs/COMPARISON.md:46` — `Test count (public) | **670**`
  - `/Users/alex/Documents/Projects/obsidian-mcp/docs/COMPARISON.md:59` — "exact for v3.5.8"
  - `/Users/alex/Documents/Projects/obsidian-mcp/docs/COMPARISON.md:236` — "None of these servers...ships a public, reproducible end-to-end retrieval benchmark"
  - `/Users/alex/Documents/Projects/obsidian-mcp/docs/COMPARISON.md:242` — "snapshot as of **2026-05-13**"
  - `/Users/alex/Documents/Projects/obsidian-mcp/docs/COMPARISON.md:250` — signed v3.5.8
- **Class fix**: Add a docs-consistency invariant in `tests/docs-consistency.test.ts` that asserts:
  - The "as of v X.Y.Z" footer / header in `docs/COMPARISON.md` and `docs/QUICKSTART.md` matches `package.json#version`.
  - The Test count column in `docs/COMPARISON.md` (and the count in README) match the actual `vitest run` count from `tests/`.
  - Section 236's "no public benchmark" claim is removed once `docs/benchmarks.md` exists, OR keyed to a per-version condition.
- **Per-instance backfill**: Bulk edit `docs/COMPARISON.md` to v3.6.0 / 2026-05-15 / 714 / drop the "no public benchmark" line, OR rewrite section 236 to reference `docs/benchmarks.md` ("enquire-mcp now ships a public benchmark — see `docs/benchmarks.md`; the alternatives still don't").
- **Auditor verification of alternatives**: not performed in this audit pass — the audit plan asked for spot-checks if cyanheads etc. shipped new features. Not done because L6 scope was time-boxed at ~45 min and external repos require WebFetch. **Recommended deferred follow-up**: 30-min sweep of cyanheads / MarkusPfundstein / StevenStavrakis READMEs to confirm matrix rows are still accurate as of 2026-05-15.
- **Recommended next action**: v3.6.1 doc patch.

---

## Finding L6-03 — `CLAUDE.md` "Current phase status" claims v3.6.0 is mid-RC, not stable

- **Severity**: MEDIUM
- **Class**: per-sprint planning docs not closed out when the sprint completed. Affects anyone (human or agent) who reads `CLAUDE.md` for the project's North Star.
- **Description**: `CLAUDE.md:81-84` (the "Current phase status" section) reads:
  - "rc.1 shipped..."
  - "rc.2 shipped..."
  - "rc.3 **in flight** (PR #67)..."
  - "rc.4 **next**: TypeDoc + GH Pages + Public benchmarks."
  All four are inaccurate: v3.6.0 stable has shipped (npm `latest = 3.6.0`, GH release marked Latest, all four RCs merged, all listed deliverables landed). The "Goal" header at `CLAUDE.md:1` still reads `# Project goal — v3.6.0 sprint`, framing the sprint as ongoing.
  Also notable: `CLAUDE.md:26` says "712+ tests pass" — actual is 714 (no contradiction with `712+` but a stale baseline).
- **Evidence**:
  ```bash
  $ npm view @oomkapwn/enquire-mcp dist-tags
  # latest = 3.6.0
  $ node -e "console.log(require('./package.json').version)"
  3.6.0
  $ git tag --list 'v3.6.0*'
  # v3.6.0, v3.6.0-rc.1, v3.6.0-rc.2, v3.6.0-rc.3, v3.6.0-rc.4 (all present)
  ```
- **Cited file:line**:
  - `/Users/alex/Documents/Projects/obsidian-mcp/CLAUDE.md:1` — "# Project goal — v3.6.0 sprint" (sprint framing)
  - `/Users/alex/Documents/Projects/obsidian-mcp/CLAUDE.md:9` — "Release **enquire-mcp v3.6.0**..." (already done)
  - `/Users/alex/Documents/Projects/obsidian-mcp/CLAUDE.md:26` — "712+ tests pass"
  - `/Users/alex/Documents/Projects/obsidian-mcp/CLAUDE.md:79-84` — "Current phase status" section (entirely stale)
- **Class fix**: Pivot `CLAUDE.md` from per-sprint snapshot to evergreen project guide. Replace the "Current phase status" section with a "Last shipped" pointer that auto-derives from `package.json#version` + git tags. Better: add a phase header that auditors / new agents can recognize — `# Current sprint: post-v3.6.0 system audit` instead of `# Project goal — v3.6.0 sprint`.
- **Per-instance backfill**: Rewrite `CLAUDE.md` section "Current phase status" (lines 79-84) to reflect post-stable state. Update line 1 / line 9 framing.
- **Recommended next action**: v3.6.1 doc patch; or, even simpler, fold it into the v3.6.0 system audit's own retrospective doc.

---

## Finding L6-04 — `docs/api.md` headline blockquote still markets retired "v2.0 beta" channel

- **Severity**: MEDIUM
- **Class**: same as L6-02 — per-version copy that wasn't refreshed across the v3.0 stable promotion. Particularly visible because `docs/api.md` is the authoritative tool reference linked from README + STABILITY.
- **Description**: `docs/api.md:5` reads:
  > **Channels:** stable v1.x (`@latest` on npm) ships 28 tools — no ML embeddings, no hybrid search. **v2.0 beta** (`@beta` on npm) adds `obsidian_search` (hybrid RRF) + `obsidian_embeddings_search` + the `install-model` / `build-embeddings` / `clear-embeddings` subcommands. **This document covers the v2.0 beta surface.**

  At v3.6.0 stable: `npm view @oomkapwn/enquire-mcp dist-tags` shows `latest = 3.6.0`. There is no `@beta` dist-tag in current use; v2.0 features have been in `@latest` since v3.0.0 (2026-05-09). The blockquote is the first thing a reader sees in `docs/api.md`.

  Additionally, six section headers (`docs/api.md:115,495,518,...`) still carry `_(v2.0 beta)_` annotations even though those tools are core to v3.x stable. Examples:
  - Line 115: `install-model` (v2.0 beta)
  - Line 116: `build-embeddings` (v2.0 beta)
  - Line 495: `## obsidian_embeddings_search _(v2.0 beta — requires ...)_`
  - Line 518: `## obsidian_search _(v2.0 beta — the new default search tool)_`

  And line 493 says "For ML embeddings see `obsidian_embeddings_search` and `obsidian_search` (v2.0 beta)" — same issue.
- **Evidence**:
  ```bash
  $ grep -nE "v2.0 beta|stable v1.x|@beta" docs/api.md | wc -l
  10
  $ npm view @oomkapwn/enquire-mcp dist-tags 2>&1 | head -3
  # latest = 3.6.0
  # rc = 3.6.0-rc.4
  ```
- **Cited file:line**:
  - `/Users/alex/Documents/Projects/obsidian-mcp/docs/api.md:5` — channel blockquote (retired channels)
  - `/Users/alex/Documents/Projects/obsidian-mcp/docs/api.md:115` — `install-model (v2.0 beta)`
  - `/Users/alex/Documents/Projects/obsidian-mcp/docs/api.md:116` — `build-embeddings (v2.0 beta)`
  - `/Users/alex/Documents/Projects/obsidian-mcp/docs/api.md:493` — "(v2.0 beta)" in body text
  - `/Users/alex/Documents/Projects/obsidian-mcp/docs/api.md:495` — `## obsidian_embeddings_search _(v2.0 beta — ...)_`
  - `/Users/alex/Documents/Projects/obsidian-mcp/docs/api.md:518` — `## obsidian_search _(v2.0 beta — the new default search tool)_`
- **Class fix**: Single replacement of "v2.0 beta" → "v2.0+" everywhere it appears in `docs/api.md`. Rewrite line 5 blockquote to describe the current channel ("@latest = stable v3.x"; `@rc` for prereleases). Add an invariant to `tests/docs-consistency.test.ts` that the api.md header doesn't reference a retired dist-tag — fail if `@beta` appears in the document while `npm view <pkg> dist-tags` doesn't return a `beta` row.
- **Per-instance backfill**: 6 line edits in `docs/api.md`.
- **Recommended next action**: v3.6.1 doc patch.

---

## Finding L6-05 — `docs/api.md` line 80 broken anchor: `README.md#cache--privacy`

- **Severity**: MEDIUM
- **Class**: drift between cross-file anchor + the target heading the anchor refers to. Same class as L1 / L4 "drift between two surfaces" findings.
- **Description**: `docs/api.md:80` has a markdown link `[Cache & privacy](../README.md#cache--privacy)`. README has no heading whose slug is `cache--privacy`; in fact README has no `## Cache & privacy` heading at all. The closest content is `SECURITY.md` ## "Persistent cache: privacy posture" (line 39). Link resolves to top-of-README on click — silent miss.
- **Evidence**:
  ```bash
  $ grep -n "#cache--privacy" docs/api.md
  80:| `--persistent-cache`   | off     | Persist parsed-note cache to disk... see [Cache & privacy](../README.md#cache--privacy).
  $ grep -E "^##+" README.md | head -20
  # No "Cache & privacy" heading anywhere in README.md
  $ grep -iE "^##+ .*cache" SECURITY.md
  ## Persistent cache: privacy posture
  ```
- **Cited file:line**:
  - `/Users/alex/Documents/Projects/obsidian-mcp/docs/api.md:80` — `[Cache & privacy](../README.md#cache--privacy)`
  - `/Users/alex/Documents/Projects/obsidian-mcp/README.md` — no `## Cache & privacy` section
  - `/Users/alex/Documents/Projects/obsidian-mcp/SECURITY.md:39` — actual content
- **Class fix**: Add a `tests/docs-consistency.test.ts` invariant that walks every markdown link in `docs/*.md` (and README) of the form `path#anchor` and verifies the anchor slug exists in the target file. Existing test only checks link _paths_, not anchors.
- **Per-instance backfill**: Change `docs/api.md:80` link target to `../SECURITY.md#persistent-cache-privacy-posture` (which exists and is the actual content). Same line: the existing `[SECURITY.md "Persistent FTS5 index"](../SECURITY.md#persistent-fts5-index-privacy-posture)` 4 lines down is the correct pattern.
- **Recommended next action**: v3.6.1 doc patch.

---

## Finding L6-06 — `docs/QUICKSTART.md` cites stale version `3.5.8` example + obsolete CI matrix claim

- **Severity**: LOW
- **Class**: per-version examples in docs that weren't refreshed at v3.6.0. Same root as L6-02 / L6-03 / L6-04.
- **Description**: `docs/QUICKSTART.md` has two drift items:
  1. **Line 30**: `Expected output: the current version string (e.g. `3.5.8`).` — should be `3.6.0`. The user runs `enquire-mcp --version` and sees `3.6.0` but the doc says they should see `3.5.8`. Minor confusion, but the example is precisely the kind of thing readers latch onto.
  2. **Line 142**: "enquire-mcp targets Node 20 / 22 / 24 — the CI matrix runs all three." — **NOT TRUE since v3.5.11** (2026-05-13), which dropped Node 20 from CI. Current `.github/workflows/ci.yml` matrix is `[22, 24]`. The `package.json engines` field still says `">=20"` for prebuilt-dist users, but the CI matrix is 22/24 only.
  3. **Line 14**: "Node 20+" — strictly compatible with `engines >=20`, no false claim, but combined with line 142's "CI runs all three" makes the doc misleading.
- **Evidence**:
  ```bash
  $ grep -E "node-version|matrix:" .github/workflows/ci.yml | head -5
            node-version: 22
        matrix:
          node-version: [22, 24]
  $ grep -A1 '"engines"' package.json
    "engines": {
      "node": ">=20"
  ```
  And `CHANGELOG.md:495-497` documents the Node 20 drop:
  > **Dropped Node 20 from CI test matrix** (`[20, 22, 24]` → `[22, 24]`).
- **Cited file:line**:
  - `/Users/alex/Documents/Projects/obsidian-mcp/docs/QUICKSTART.md:14` — "Node 20+"
  - `/Users/alex/Documents/Projects/obsidian-mcp/docs/QUICKSTART.md:30` — `3.5.8` example
  - `/Users/alex/Documents/Projects/obsidian-mcp/docs/QUICKSTART.md:142` — "CI matrix runs all three"
- **Class fix**: Add a docs-consistency invariant: the "current version string" examples in `docs/QUICKSTART.md` must match `package.json#version`. CI Node matrix claims must match `.github/workflows/ci.yml`. (The latter would have caught the v3.5.13 README drift the audit #4 found, too — see CHANGELOG line 405.)
- **Per-instance backfill**: 2 line edits in `docs/QUICKSTART.md`. Suggested wording for line 142: "enquire-mcp targets Node 20+ for prebuilt installs and Node 22+ for source builds — the CI matrix runs Node 22 and 24 (Node 20 was EOL'd 2026-04 and dropped from CI in v3.5.11; the package still installs on Node 20 from npm because the prebuilt `dist/` is shipped)."
- **Recommended next action**: v3.6.1 doc patch.

---

## Finding L6-07 — README badge + tagline still reference `v3.5.x-stable` at v3.6.0

- **Severity**: LOW
- **Class**: per-version copy not bumped on minor-version promotion. Same as L6-02..L6-06.
- **Description**: README has two visible stale items:
  1. **Line 15**: `[![stable](https://img.shields.io/badge/v3.5.x-stable-brightgreen.svg)](./STABILITY.md)` — badge URL hard-codes `v3.5.x`. At v3.6.0 stable, the badge displays "v3.5.x stable" while npm shows latest=3.6.0.
  2. **Line 32**: `**44 tools · 19 MCP prompts · 714 unit tests · 50+ languages · v3.5.x · semver-bound · MIT · SLSA-3.**` — same `v3.5.x` mention.
- **Evidence**:
  ```bash
  $ grep -n "v3.5.x" README.md
  15:[![stable](https://img.shields.io/badge/v3.5.x-stable-brightgreen.svg)](./STABILITY.md)
  32:**44 tools · 19 MCP prompts · 714 unit tests · 50+ languages · v3.5.x · semver-bound · MIT · SLSA-3.**
  ```
  (Note: `README.md:171` says "v3.0+ semver-bound" — that's CORRECT, since semver-bound is from v3.0.0 onward.)
- **Cited file:line**:
  - `/Users/alex/Documents/Projects/obsidian-mcp/README.md:15` — `v3.5.x-stable` badge
  - `/Users/alex/Documents/Projects/obsidian-mcp/README.md:32` — `v3.5.x` in tagline
- **Class fix**: Add a docs-consistency invariant that asserts any `vX.Y.x` channel reference in README matches the current major.minor from `package.json#version`. Combined with the version-consistency script that already exists for code surfaces, this would close the README badge-drift class — same one v3.5.13 already had to patch for the `#trust` table (see CHANGELOG line 405).
- **Per-instance backfill**: Two line edits — `v3.5.x` → `v3.6.x` in both spots.
- **Recommended next action**: v3.6.1 doc patch.

---

## Finding L6-08 — 3 TypeDoc `@link` warnings to undocumented symbols

- **Severity**: LOW
- **Class**: TSDoc `@link` annotations referencing helpers that are tagged `@internal` (so TypeDoc filters them out, but the `@link` references still emit warnings). Cosmetic — TypeDoc exits 0 with these warnings, but the generated docs have plain-text "findBestMatch" instead of hyperlinks.
- **Description**: Running `npm run docs:api` emits:
  ```
  [warning] The comment for tools.readCanvas links to "findBestMatch" which was resolved but is not included in the documentation.
  [warning] The comment for tools.resolveTarget links to "suggestSimilar" which was resolved but is not included in the documentation.
  [warning] The comment for tools.resolveTarget links to "FileEntry" which was resolved but is not included in the documentation.
  Found 0 errors and 3 warnings
  ```
  The three referenced symbols are `findBestMatch` (`src/tools/meta.ts`), `suggestSimilar` (referenced in `src/tools/write.ts:984`), and `FileEntry` (`src/vault.ts`, imported in many places). All three are either `@internal`-tagged or not exported from the entry points. The `@link` works at the TSDoc parser level but breaks at the TypeDoc public-doc-only filter.
- **Evidence**:
  ```bash
  $ npm run docs:api 2>&1 | tail -5
  [warning] The comment for tools.readCanvas links to "findBestMatch"...
  [warning] The comment for tools.resolveTarget links to "suggestSimilar"...
  [warning] The comment for tools.resolveTarget links to "FileEntry"...
  [info] html generated at ./docs/api-reference
  [warning] Found 0 errors and 3 warnings

  $ grep -nE "@link\s+(findBestMatch|suggestSimilar|FileEntry)" src/tools/*.ts | head -10
  src/tools/search.ts:477: *   `entriesRef` is the {@link FileEntry} snapshot used for cache validation.
  src/tools/media.ts:199: * the live vault — `file_resolved` carries the post-{@link findBestMatch}
  src/tools/meta.ts:1294: * lookup indices that {@link findBestMatch} needs.
  src/tools/meta.ts:1344: * @returns The resolved {@link FileEntry}, or null if no match.
  src/tools/write.ts:984: * 4. On miss → throw with did-you-mean suggestions via {@link suggestSimilar}.
  src/tools/write.ts:989: * @returns A {@link FileEntry} pointing at the resolved file on disk.
  ```
- **Cited file:line**:
  - `/Users/alex/Documents/Projects/obsidian-mcp/src/tools/search.ts:477`
  - `/Users/alex/Documents/Projects/obsidian-mcp/src/tools/media.ts:199`
  - `/Users/alex/Documents/Projects/obsidian-mcp/src/tools/meta.ts:1294`
  - `/Users/alex/Documents/Projects/obsidian-mcp/src/tools/meta.ts:1344`
  - `/Users/alex/Documents/Projects/obsidian-mcp/src/tools/write.ts:984`
  - `/Users/alex/Documents/Projects/obsidian-mcp/src/tools/write.ts:989`
- **Class fix**: Either (a) add `findBestMatch` / `suggestSimilar` / `FileEntry` to TypeDoc's `externalSymbolLinkMappings` as `"#"` (suppresses the warning while keeping the inline text), or (b) replace the `@link` with plain backticks in the offending TSDoc comments. Option (b) is cleaner for internal helpers — `{@link findBestMatch}` → `\`findBestMatch\``. Add `treatWarningsAsErrors: true` to `typedoc.json` once the 3 are fixed so future warnings fail CI.
- **Per-instance backfill**: 6 inline edits.
- **Recommended next action**: v3.6.1 or v3.6.2 doc patch — low impact (generated site looks fine; just lacks the hyperlinks).

---

## Finding L6-09 — README "v3.0 release (2026-05-09)" footnote dated incorrectly for current claim window

- **Severity**: INFO
- **Class**: footnote drift; the claim itself is still true ("comparison based on public capabilities at v3.0 release") but the timeframe is now ~7 days behind current.
- **Description**: `README.md:104` reads "<sub>Comparison based on each project's public capabilities as documented at v3.0 release (2026-05-09)</sub>". Not actively wrong — it's the "as of v3.0" snapshot. Combined with COMPARISON.md's signed-v3.5.8 (L6-02 above), the project effectively has THREE different "as of" dates referenced (v3.0 / v3.5.8 / v3.6.0) for the same comparison data. Should consolidate to one current date.
- **Cited file:line**:
  - `/Users/alex/Documents/Projects/obsidian-mcp/README.md:104` — `at v3.0 release (2026-05-09)`
- **Class fix**: Fold into L6-02's class fix — single "comparison data current as of" string in both README and COMPARISON.md, with the docs-consistency invariant asserting they match.
- **Per-instance backfill**: 1 line edit, will be batched with L6-02.

---

## Class summary

Almost every Medium/Low finding in this layer is **the same drift class**: post-stable-promotion doc refresh wasn't comprehensive. v3.6.0 changed the version, test count, capabilities, and benchmarks, but the following docs still describe the pre-promotion state in some way:

- `README.md` — badge + tagline carry `v3.5.x`
- `CLAUDE.md` — entire "Current phase status" stale
- `docs/COMPARISON.md` — date + test count + a now-false benchmark claim
- `docs/api.md` — first blockquote markets retired beta channel + 6 inline "(v2.0 beta)" annotations
- `docs/QUICKSTART.md` — version example + CI matrix claim

**Class fix** (one PR, one invariant, broad coverage): extend `tests/docs-consistency.test.ts` with three new asserts:

1. Every `vX.Y` / `vX.Y.x` channel string in README + docs/*.md matches `package.json#version`'s major.minor.
2. Every `Test count` / `\d+ unit tests` / `\d+ tests` claim in docs matches the actual count (read from a freshly-run vitest reporter or from `tests/`).
3. Every "as of YYYY-MM-DD" string in README + docs/COMPARISON.md falls within the past 30 days of `git log -1 --format=%cs HEAD`.

This single class fix would have caught 6 of the 9 findings above at lint-time and prevent the next minor release from carrying the same drift.

## Out-of-scope spot checks performed

These confirmed no findings:

- **README internal links** (9 paths) — all resolve.
- **External URLs** (slsa.dev / modelcontextprotocol.io / huggingface.co / wikipedia / karpathy gist) — all 200.
- **STABILITY.md exports** (23 symbols) — every one present in src/.
- **`grep -n "registerTool\|registerPrompt"` counts** — 44 tools + 19 prompts.
- **Coverage stats in CHANGELOG.md** — `npm run check:changelog-coverage` confirms within 0.5pp (actual 89.20% lines / 75.02% branches matches v3.6.0 entry exactly).
- **All 4 example JSON configs in `examples/`** (`claude-desktop.json`, `claude-desktop-hybrid.json`, `cursor-mcp.json`, `queries.jsonl`) — valid JSON, parseable.
- **`enquire-mcp doctor --vault <synthetic>` from QUICKSTART step 2** — exits 0, prints expected colour-coded health checks.
- **`node scripts/smoke.mjs <synthetic>`** — all probes PASS.
- **TypeDoc output** — 111 HTML files generated (matches CHANGELOG claim).
- **`bench/benchmarks.json` numbers** — MRR/NDCG@10/Recall match `docs/benchmarks.md` headline table to 4 decimals.
- **CHANGELOG v3.5.9+ TL;DR convention** — every entry has a `>` TL;DR blockquote (11/11 checked).

## Did NOT check (deferred / out of scope)

- **Alternatives' current state** for `docs/COMPARISON.md` (cyanheads / Markus / Stevens / mcpvault). The audit plan asked for spot-checks; ~30 min of WebFetch would be needed. Defer to a v3.6.1 doc patch.
- **`docs/api-reference/` per-page rendering**. Spot-checked the index page exists; didn't open all 111 pages. TypeDoc itself exited successfully so likely all OK.
- **`enquire-mcp serve --vault <path>` stdio I/O test** from QUICKSTART. Smoke script (`node scripts/smoke.mjs`) is a fuller replacement and passed.
- **`docs/http-transport.md` end-to-end deployment recipes**. Spot-checked the TL;DR block (auth flow correct, gen-token + serve-http commands correct). Did not actually deploy with Tailscale/Cloudflare Tunnel.
- **`docs/benchmarks.md` reproducibility via `npm run bench:retrieval`**. Would take 5-10 min to run; existing `bench/benchmarks.json` was inspected and is consistent with the doc.

## Recommended Phase D triage

| ID | Severity | Effort | Bundle |
|---|---|---|---|
| L6-01 | HIGH | 1h | v3.6.1 — investigate `publish-docs.yml` last run; either fix Pages config or remove the URL claims |
| L6-02 | MEDIUM | 30min | v3.6.1 — bulk-rewrite `docs/COMPARISON.md` to v3.6.0 + drop the no-benchmark claim |
| L6-03 | MEDIUM | 15min | v3.6.1 — close out `CLAUDE.md` "Current phase status" |
| L6-04 | MEDIUM | 15min | v3.6.1 — `docs/api.md` "v2.0 beta" → "v2.0+" sweep |
| L6-05 | MEDIUM | 5min | v3.6.1 — fix one anchor link |
| L6-06 | LOW | 10min | v3.6.1 — `docs/QUICKSTART.md` Node + version refresh |
| L6-07 | LOW | 5min | v3.6.1 — README badge + tagline |
| L6-08 | LOW | 15min | v3.6.2 — TypeDoc `@link` warnings → suppress or rewrite |
| L6-09 | INFO | 1min | Bundle with L6-02 |

**Class fix** (proposed): single new invariant test in `tests/docs-consistency.test.ts` (~50 lines) that covers L6-02 / L6-03 / L6-04 / L6-06 / L6-07 / L6-09 prospectively. Add as part of the v3.6.1 bundle.

**Total remediation effort**: ~3 hours. None block v3.6.0 stable's promotion (already shipped); all are post-release polish.
