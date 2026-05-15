# L1 — Code Quality (v3.6.0 audit)

**Scope**: every `src/**/*.ts` and `tests/**/*.test.ts` file.
**Auditor**: sub-agent C1.
**Date**: 2026-05-15.
**Baseline**: 28 src modules, 33 test files, 369 TSDoc blocks already present, 17 `@internal` markers (all in `src/tools/*.ts`).

## Summary

The codebase is in good shape overall. `src/tools/*.ts` (the public tool implementations) is exemplary — every function has full TSDoc with `@param` / `@returns` / `@throws` / `@example`, internal helpers are tagged `@internal`, and tests are specific and edge-case-heavy.

The findings below cluster into 4 classes, ordered by severity:

1. **L1-01 (Medium)** — TSDoc drift in foundational modules (`parser.ts`, `dql.ts`, `rrf.ts`, `embeddings.ts`, `vault.ts`, `embed-db.ts`, etc.): types/interfaces/constants exported but undocumented while `src/tools/*.ts` sets a much higher bar.
2. **L1-02 (Low)** — Weak `rejects.toThrow()` calls without message regex (13 instances), so a regression that changes WHICH error fires would still pass.
3. **L1-03 (Low)** — `@internal` usage limited to `src/tools/*.ts`; equally module-scoped exports elsewhere (`safeFts5Query`, `chunkContent`, `cosineSim`, `buildEmbedText`, etc.) are not tagged, so TypeDoc surfaces them as if public.
4. **L1-04 (Info)** — No tests explicitly probe concurrent / race-condition behavior; the persistent-cache + watcher + HTTP-session paths look prone to it.

No Critical / High findings. No silent `try { } catch {}` swallows — every catch I inspected has an inline comment explaining intent. No `any` types in exported signatures (a single stray `any` appears only in a code-fenced prompt string in `prompts.ts:1007` and in a comment block on `tools/meta.ts:641`). No commented-out code blocks (`grep` for `^\s*//\s+(import|const|...)` found 3 lines, all genuine sentence fragments inside multi-line comments). No `.skip` / `.todo` without context (single `it.skip` in `tests/reranker-smoke.test.ts:38` is fully documented).

---

### Finding L1-01 (Medium)

**File**: multiple — see backfill list
**Class**: TSDoc drift between `src/tools/*.ts` (gold standard) and the rest of `src/`. Public exported types / interfaces / constants / class members exist without `/** */` blocks while sibling modules carry full TSDoc + `@example`. The README, STABILITY.md, and TypeDoc output all claim "44 tools fully TSDoc'd → public API reference at github.io"; for non-tool modules that claim doesn't hold uniformly.
**Description**: 25-ish public exports in foundational modules have either no TSDoc, or inline `// ...` comments above (not parsed by TypeDoc), even though they appear in TypeDoc's public output (`docs/api-reference/`). Most painful are `parser.ts` (5 exported functions, 2 interfaces — zero TSDoc), `dql.ts` (5 types, 1 class, `parseDql` — zero TSDoc), `rrf.ts` (`RRF_K` constant + 3 interfaces — only the function bodies have JSDoc; interface fields use inline `/** */` but the top-level interface declarations don't), `embeddings.ts` (`EmbeddingModel` / `Embedder` / `Reranker` / `RerankerModel` interfaces, `EMBEDDING_MODELS` / `RERANKER_MODELS` constants, `resolveModel` / `resolveRerankerModel` / `cosineSim` functions), `embed-db.ts` (`EmbedDb` class itself has no class-level TSDoc; `upsertNote` / `deleteNote` / `getSourceStates` / `search` / `totalChunks` / `getAllVectors` methods documented inline but no `@param`/`@returns`), `vault.ts` (`Vault` class, `DEFAULT_MAX_FILE_BYTES` / `DEFAULT_MAX_CACHE_ENTRIES` / `DEFAULT_MAX_DISK_CACHE_BYTES` constants, `FileEntry` / `CachedNote` / `VaultOptions` interfaces — Vault class has 25+ public methods, only some have TSDoc), `watcher.ts` (`WatcherOptions`, `VaultWatcher` class), `periodic.ts` (`PeriodicKind`, `PeriodicSpec`, `PeriodicConfig`).

**Evidence** (`src/parser.ts:1-50`):

```ts
import matter from "gray-matter";

export interface Wikilink {
  raw: string;
  target: string;
  section?: string;
  block?: string;
  alias?: string;
}

export type Embed = Wikilink;

export interface ParsedNote {
  frontmatter: Record<string, unknown>;
  body: string;
  wikilinks: Wikilink[];
  embeds: Embed[];
  tags: string[];
}

export function parseNote(source: string): ParsedNote {
```

Compare against `src/tools/search.ts:7-86` (gold standard — every export has a full TSDoc block with `@param` / `@returns` / `@throws` / `@example`).

**Other instances** (grep cross-cutting):

- `src/parser.ts` — `Wikilink`, `Embed`, `ParsedNote`, `parseNote`, `extractWikilinks`, `extractEmbeds`, `extractInlineTags`, `extractFrontmatterTags`
- `src/dql.ts` — `Source`, `Op`, `Predicate`, `WhereGroups`, `DataviewQuery`, `DqlParseError`, `parseDql`, `DEFAULT_DQL_ROW_LIMIT`
- `src/rrf.ts` — `RRF_K`, `RankedHit`, `SignalContribution`, `FusedHit` (interfaces themselves have no leading TSDoc — fields are doc'd inline)
- `src/embeddings.ts` — `EmbeddingModel`, `EMBEDDING_MODELS`, `DEFAULT_MODEL_ALIAS`, `resolveModel`, `Embedder`, `cosineSim`, `RerankerModel`, `RERANKER_MODELS`, `DEFAULT_RERANKER_ALIAS`, `resolveRerankerModel`, `Reranker`
- `src/vault.ts` — `DEFAULT_MAX_FILE_BYTES`, `DEFAULT_MAX_CACHE_ENTRIES`, `DEFAULT_MAX_DISK_CACHE_BYTES`, `FileEntry`, `CachedNote`, `VaultOptions`, `Vault` class header, most `Vault` methods (`ensureExists`, `loadDiskCache`, `clearDiskCache`, `saveDiskCache`, `resolveInside`, `listMarkdown`, `listFilesByExtension`, `readBinaryFile`, `readFile`, `readNote`, `writeNote`, `renameFile`, `appendNote`, `invalidateCache`, `invalidateOne`, `stat`, `toRel`, `findByTitle`)
- `src/embed-db.ts` — `EmbedSearchHit`, `EmbedSyncReport`, `EmbedChunkKind`, `EmbedQuantization`, `EmbedDbOptions`, `EmbedDb` class header, `open`, `close`, `clearOnDisk`, `totalChunks`, `defaultEmbedDbFile`
- `src/fts5.ts` — `ChunkKind`, `FtsSearchHit`, `FtsSyncReport`, `FtsIndex` class header, `safeFts5Query`, `defaultIndexFile`, `chunkContent` (has TSDoc but no `@param`/`@returns`)
- `src/eval.ts` — `EvalQuery`, `EvalQueryScore`, `EvalResult`, `recallAtK`, `reciprocalRank`, `RunEvalOptions`
- `src/hnsw.ts` — `LabeledVector`, `HnswBuildOptions`, `HnswQueryOptions` (interfaces have inline field docs but no leading TSDoc on the interface itself)
- `src/http-transport.ts` — `createSessionRegistry`, `createHttpHandler` (signature TSDoc-less; behavior described in nearby block comments only)
- `src/ocr.ts` — `OcrPdfPage`, `OcrPdfResult`, `ExtractPdfWithOcrOptions`
- `src/pdf.ts` — `PdfExtractionResult`
- `src/periodic.ts` — `PeriodicKind`, `PeriodicSpec`, `PeriodicConfig`, `resolvePeriodicNoteName`, `formatMoment`
- `src/server.ts` — `ServeOptions` (the most important interface in the project; the export itself has no TSDoc; each field has a `/** */`)
- `src/tool-manifest.ts` — `TOOL_MANIFEST` constant (the file header is excellent, but the export itself has no TSDoc)
- `src/tool-registry.ts` — `embedDbPath`, `registerFtsTools`, `registerReadTools`, `registerWriteTools`, `registerChunkResource`, `registerResources`, `parsePositiveInt`, `encodeNotePath`, `decodeNotePath`, `textResult` (the register* functions are 50-200 lines each and exported, but get just a single-line `//` comment above)
- `src/watcher.ts` — `WatcherOptions`, `VaultWatcher` (class itself, plus `start`, `close` methods)
- `src/communities.ts` — `WikilinkGraph`, `CommunityResult` (interfaces themselves — fields are doc'd inline)
- `src/bases.ts` — `BaseSummary`, `BaseDocument`, `BaseQueryHit`, `BaseQueryResult`, `QueryBaseArgs`, `readBase`
- `src/doctor.ts` — `CheckStatus`, `DoctorCheck`, `DoctorResult`, `RunDoctorOptions`

**Suggested class fix**: Add a TypeDoc / lint invariant that fails the build if any `export (function|class|interface|type|const|enum)` is not immediately preceded by a `/** ... */` TSDoc block. Easiest place: extend `tests/lint.test.ts` (already an AST-style invariant runner) with a regex sweep over `src/**/*.ts` that mirrors what `tests/docs-consistency.test.ts` does for `docs/api.md`. Alternative: configure TypeDoc with `requiredToBeDocumented` + treat warnings as errors in `npm run docs:api`.

**Suggested per-instance backfill**: 25 exported entities across the 18 files listed above. Each fix is mechanical (write a 2-5 line TSDoc block + `@param`/`@returns`/`@throws` for functions). Estimated ~3-4 hours total. Prioritize the highest-visibility surface first:

1. `src/parser.ts` (8 exports — referenced from every tool module)
2. `src/vault.ts` (class + 25+ methods — the central abstraction)
3. `src/server.ts` (`ServeOptions` — the canonical CLI surface)
4. `src/embed-db.ts`, `src/fts5.ts`, `src/embeddings.ts`, `src/hnsw.ts` (retrieval-stack public API)
5. Everything else.

---

### Finding L1-02 (Low)

**File**: `tests/pdf.test.ts:111,274,281`, `tests/ocr.test.ts:45,54,63,76,77,97`, `tests/bases.test.ts:163`, `tests/canvas.test.ts:168`, `tests/watcher.test.ts:108`, `tests/write.test.ts:343` (13 total; the `not.toThrow()` cases at `tests/dql.test.ts:310` and `tests/security.test.ts:477` are correctly used and excluded)
**Class**: `rejects.toThrow()` (or `expect(...).toThrow()`) called with NO message regex / matcher. The test passes as long as ANY error fires — a regression that changes the error message, error type, or even the failing line still passes. We have 55 strong `rejects.toThrow(/regex/)` calls already; the 13 weak ones below are the outliers.
**Description**: A common pattern in test files — when an action is expected to fail, but the failure mode isn't pinned. Several of these test "rejects negative paths", "rejects malformed input", or "rejects missing dependency". The downside is that the test would still pass if the rejection came from a totally different bug — e.g. a path-traversal error firing instead of a "missing file" error in `tests/pdf.test.ts:274`. Best practice across the rest of the suite is `rejects.toThrow(/specific message excerpt/)`.

**Evidence** (`tests/pdf.test.ts:271-282`):

```ts
  it("rejects reading a PDF that doesn't exist", async () => {
    const v = new Vault(root);
    await v.ensureExists();
    await expect(readPdf(v, { path: "missing.pdf" })).rejects.toThrow();
  });

  it("rejects reading a PDF outside the privacy filter", async () => {
    const v = new Vault(root, { excludeGlobs: ["private/**"] });
    await v.ensureExists();
    await expect(readPdf(v, { path: "private/secret.pdf" })).rejects.toThrow();
  });
```

**Other instances** (grep cross-cutting):

- `tests/bases.test.ts:163` — `rejects.toThrow()` on path traversal (should match `/escapes vault root/`)
- `tests/canvas.test.ts:168` — same
- `tests/pdf.test.ts:111,274,281` — should match `/PDF/` or `/missing/` or `/excluded/`
- `tests/ocr.test.ts:45,54,63,76,77,97` — should match `/path is required/` (already used at line 39!), `/missing/`, `/excluded/`, or `/invalid PDF/`
- `tests/watcher.test.ts:108` — should match `/excluded/`
- `tests/write.test.ts:343` — should match `/not found/` or `/Source/`

**Suggested class fix**: Add a `tests/lint.test.ts` invariant that fails if any `rejects.toThrow()` or `.toThrow()` is called with zero arguments. Alternative: ESLint rule `vitest/prefer-strict-equal` family + custom rule. (Vitest's own docs recommend always passing a matcher.)

**Suggested per-instance backfill**: Add a regex matching the actual error message to each of the 13 weak assertions. Mechanical edit — for each one, run the failing case manually to capture the message, then add `/excerpt/`. Estimated 30 minutes total.

---

### Finding L1-03 (Low)

**File**: 11 files across `src/` (non-tools)
**Class**: `@internal` marker discipline. `src/tools/*.ts` rigorously tags helpers used cross-module-but-not-public-API with `@internal` (17 uses across 3 files). Equivalent module-scoped utilities elsewhere — exported because `tests/` or sibling modules need them, but NOT part of the public `package.json#exports` surface — are not tagged.
**Description**: Per STABILITY.md, the public surface is defined by `package.json#exports` (which lists `./tool-registry`, `./tool-manifest`, `./server`, etc.). Many helpers exported from non-listed modules are de-facto private — `safeFts5Query` (used only by `fts5.ts` + tests), `chunkContent` (called by `server.ts` for embedding-sync), `cosineSim` (used by `embed-db.ts` + tests), `defaultEmbedDbFile` (mirrors `embedDbPath` in `tool-registry.ts`), `buildEmbedText` (re-exported through `index.ts` mainly for `tests/late-chunking.test.ts`). Without `@internal`, TypeDoc surfaces them as public API in `docs/api-reference/`, and downstream consumers might import them via the deep `./fts5` / `./embed-db` path (which is what `tests/no-internal-imports.test.ts` is built to prevent — but only at the project's own boundaries, not for external consumers).

**Evidence** (`src/fts5.ts:462` — `safeFts5Query` has helpful inline comment but no `@internal`):

```ts
// Quote-wrap any token containing non-alphanumerics so FTS5 doesn't interpret
// hyphens / colons / dots as operators (`claude-telegram` would otherwise
// parse as `claude NOT telegram`). Strip reserved keywords. Returns "" if the
// query has no usable tokens.
export function safeFts5Query(q: string): string {
```

Versus `src/tools/search.ts:417` (gold standard):

```ts
/**
 * ...
 * @internal
 * @param text - Raw text to tokenize. Will be lowercased.
 */
export function tokenizeForTfidf(text: string): string[] {
```

**Other instances** (grep cross-cutting):

- `src/fts5.ts` — `safeFts5Query`, `chunkContent`, `defaultIndexFile` (used by `server.ts` + `tool-registry.ts` + tests; not in `package.json#exports`)
- `src/embeddings.ts` — `cosineSim`, `resolveModel`, `resolveRerankerModel` (test-only / cross-module helpers)
- `src/embed-db.ts` — `encodeInt8Vector`, `decodeInt8Vector`, `defaultEmbedDbFile` (test + module utilities)
- `src/server.ts` — `buildEmbedText`, `syncEmbedDb`, `syncPdfEmbedDb`, `syncFtsIndex`, `syncPdfFtsIndex` (re-exported via index.ts but only for CLI / test consumers)
- `src/tool-registry.ts` — `embedDbPath`, `encodeNotePath`, `decodeNotePath`, `textResult` (utility helpers)
- `src/vault.ts` — `globToRegex` (used by `tests/security.test.ts:16` and `tests/watcher.test.ts`; not part of public API)
- `src/parser.ts` — `extractInlineTags`, `extractFrontmatterTags`, `extractWikilinks`, `extractEmbeds` (called by `bases.ts` + `communities.ts` + write tools; arguably "internal but cross-module")
- `src/periodic.ts` — `resolvePeriodicNoteName`, `formatMoment`, `loadPeriodicConfig` (called from `vault.ts` + tools; not external API)
- `src/communities.ts` — `buildWikilinkGraph`, `detectCommunities` (called only by `tool-registry.ts`)
- `src/eval.ts` — `ndcgAtK`, `recallAtK`, `reciprocalRank`, `readQueriesJsonl`, `runEval`, `formatEvalResult`, `formatEvalMatrix` (only the CLI consumes them; not in package.json#exports)
- `src/http-transport.ts` — `RateLimiter`, `readJsonBody`, `verifyBearer`, `createSessionRegistry`, `createHttpHandler` (test exports, plus re-exports at file bottom)

**Suggested class fix**: Adopt the convention `if package.json#exports doesn't list this module path, every exported symbol from it carries @internal`. Enforce with a lint test that intersects `package.json#exports` paths against `src/**/*.ts` and flags any export from a non-listed file that lacks `@internal`. Pair with `typedoc.json#excludeInternal: true` so the public reference site only shows true public API.

**Suggested per-instance backfill**: Add `@internal` to each non-public export listed above (~30 symbols). Mechanical edit. Estimated 1 hour total. Validate by re-running `npm run docs:api` and confirming the rendered API reference no longer surfaces internal helpers.

---

### Finding L1-04 (Info)

**File**: all `tests/*.test.ts` collectively
**Class**: No tests are explicitly named or structured to exercise concurrent / race-condition paths, despite the project shipping several intrinsically concurrent components: persistent-cache flush under SIGINT/SIGTERM/beforeExit, watcher events firing during MCP tool calls, stateful HTTP sessions under `maxSessions` cap pressure, rate-limiter sliding-window under burst, idle-eviction sweep during active session, parallel `vault.listMarkdown()` walks during embedding sync, optional-dep lazy-load races during boot.
**Description**: The audit plan asks specifically about "concurrent access" coverage. Grepping for the word `concurrent` in tests yields zero hits; grepping `Promise.all` returns only a few cleanup loops (`tests/security.test.ts:110`). None of the tests structurally race two requests against the same handler / session / cache and assert correctness. This is INFO-level — no concrete regression spotted, but the audit reviewer should know that race-class bugs are not currently covered by the test suite. Examples of plausible races: (a) two HTTP requests on the same stateful session arriving before `onsessioninitialized` fires; (b) a watcher reindex landing exactly between `idx.diff()` and `idx.reindexFile()` in `syncFtsIndex`; (c) `vault.saveDiskCache()` racing with `vault.cacheSet()` (cache-dirty flag not protected); (d) `prepareServerDeps()` called twice from a script (the comment says "not designed to be called multiple times" — but there's no test that asserts what happens if it IS).

**Evidence**: see `src/server.ts:120` ("Idempotent on a per-call basis but NOT designed to be called multiple times in one process — the FTS5 sync would double-index. Stdio + HTTP each call this exactly once at startup."). No test verifies the double-call failure mode, and no test simulates concurrent stdio + HTTP startup against the same vault.

**Other instances** (grep cross-cutting): not applicable — this is an absence-of-coverage finding, not a code finding.

**Suggested class fix**: When a new patch touches a concurrent-sensitive path (cache flush, watcher event handling, session lifecycle, rate-limiter), include at least one test that calls the API twice in flight (`Promise.all` of two operations) and asserts the post-state. Document this expectation in `CONTRIBUTING.md` under a new "concurrency" section.

**Suggested per-instance backfill**: Add ~4 targeted tests over the next 2-3 patch releases — not a blocker for v3.6.1:

1. `tests/http-transport.test.ts` — two simultaneous initialize requests at `maxSessions = 1`; assert second gets 503.
2. `tests/watcher.test.ts` — fire a `change` event while a `vault.readNote()` is in flight on the same path; assert post-state is the new content.
3. `tests/persistent-cache.test.ts` — race `saveDiskCache()` with a `cacheSet()`; assert no data loss + flush idempotent.
4. `tests/embed-db.test.ts` — two `upsertNote` calls on the same `rel_path` in parallel; assert exactly one survives (transaction isolation).

---

## Files explicitly clean (no findings)

The following files were inspected and have no issues at this audit's bar:

- `src/cli-help.ts` — 3 exported constants, each with a clear TSDoc explaining what flag it's for and why it was hoisted (v3.5.12 audit context).
- `src/index.ts` — slim entry point; the file header is a model of clarity (audit context, sub-module map, version-const rationale).
- `src/cli.ts` — every `program.command(...)` invocation has a long-form `description()` explaining the subcommand's purpose; flags carry inline help strings.
- `src/tools/index.ts` — barrel re-export only.
- `src/tools/read.ts`, `src/tools/write.ts`, `src/tools/search.ts`, `src/tools/meta.ts`, `src/tools/media.ts` — gold standard; every export has TSDoc + `@param` + `@returns` + `@throws` + `@example`; internal helpers carry `@internal`.
- `src/prompts.ts` — every prompt has a leading TSDoc explaining the use case + args + example invocation.
- `src/tool-manifest.ts` — the file header explains its purpose as machine-readable single-source-of-truth; each entry has a 1-line `summary` field.
- `tests/setup.ts` — well-documented warmup file explaining the v3.5.6 timeout-flake root cause.
- `tests/helpers/make-pdf.ts` — module header lists exactly what's covered vs not.
- `tests/fixtures/benchmark-queries.jsonl` — comment header documents the schema + category taxonomy.
- `tests/reranker-smoke.test.ts` — the one skipped test in the suite, fully documented with rationale.

All other test files have specific test names (mean test description ~60 chars), exercise edge cases (empty input, oversized input, missing path, malformed YAML, schema mismatch), and assert error message regexes (55 strong assertions) — well above the bar.
