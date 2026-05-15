# L2 — Architecture (v3.6.0 audit)

**Scope**: module dependency graph; `package.json#exports` resolution; `TOOL_MANIFEST` ↔ `registerTool()` ↔ `kind`/gating reality; `registerPrompt()` ↔ README + STABILITY; CLI flag ↔ handler ↔ `docs/api.md` ↔ `ServeOptions` mapping.
**Auditor**: sub-agent C2.
**Date**: 2026-05-15.
**Baseline**: 30 `src/**/*.ts` modules; `npm run build` clean; `dist/` present; 713 tests pass; 44 `TOOL_MANIFEST` entries; 44 `registerTool()` calls; 19 `registerPrompt()` calls; 7 `package.json#exports` sub-paths (+ `.` and `./package.json`).

## Summary

The architecture is in good shape. Module dependency graph is shallow and intentional (a `VERSION` hub via `index.ts` + a tightly-coupled `tools/*` peer cluster); both detected cycle classes are runtime-safe (cycled imports are only referenced inside function bodies). All 44 `TOOL_MANIFEST` entries match `registerTool()` calls exactly, and every tool's `kind` matches its registration context (read/write/fts/diagnostic). All 19 prompts are documented in both README and STABILITY. `package.json#exports` resolves cleanly to existing `dist/` files. `ServeOptions` ↔ CLI flag mapping is bidirectional and complete for stdio `serve`.

Findings cluster into 4 classes (1 medium, 2 low, 1 info):

1. **L2-01 (Medium)** — `serve-http` is missing 8 retrieval-quality / PDF / HNSW / late-chunking flags that `serve` accepts and that `docs/api.md` claims work for both transports. Passing `--use-hnsw` (or any of the others) to `serve-http` is rejected by commander.
2. **L2-02 (Low)** — drift class: `obsidian_full_text_search` is registered ONLY when both `--persistent-index` AND `--diagnostic-search-tools` are set (per `server.ts:402`), but four user-facing strings claim only `--persistent-index` is required (tool description in `tool-registry.ts:63`, `docs/api.md:3`, `docs/api.md:820–822`, `STABILITY.md:19`). The two places that get it right are `tool-manifest.ts:47` and `docs/api.md:55`.
3. **L2-03 (Low)** — 7 circular dependencies in the module graph. None break runtime (cycled symbols are only referenced inside function bodies) and the cycles are intentional (`VERSION` re-export hub + `tools/*` peer cluster). No regression guard exists, so a future top-level use of a cycled symbol would break loading and not be caught by CI.
4. **L2-04 (Info)** — `--reranker-model <alias>` and `--reranker-top-n <n>` are valid `serve` flags but appear nowhere in `docs/api.md` (the canonical API ref). Only `STABILITY.md:63` mentions `--reranker-model`. Real flags, real defaults, real behavior — just undocumented in the api ref.

No Critical / High findings. All 7 `package.json#exports` resolve to existing `dist/*.{js,d.ts}` files. The slim re-export surface at `src/index.ts` keeps the v3.5.x public API stable through the rc.2 split. All `tools/*` symbols imported by `tool-registry.ts` exist in `dist/tools/index.js`. The 19-prompt count is exact across `src/prompts.ts`, `README.md:154`, and `STABILITY.md:33`. The 44-tool kind/gating split is exact across `src/tool-manifest.ts` and the actual registration sites.

---

### Finding L2-01 (Medium)

**File**: `src/cli.ts:122–177` (the `serve-http` command definition), `docs/api.md:102,110` (the contradicting claim), `src/http-transport.ts:41–102` (`HttpServeOptions extends ServeOptions`).
**Class**: CLI surface drift between `serve` and `serve-http` (commander `.option()` chains for the same `HttpServeOptions extends ServeOptions` type are out of sync — flags were added to `serve` after v2.8.0 but never back-ported to `serve-http`).
**Description**: `serve-http` (the remote-MCP transport) is missing eight `.option()` declarations that `serve` (stdio) has and that `docs/api.md` says both transports share. Because commander uses `.option()` chains, not type-driven CLI generation, the typed `HttpServeOptions extends ServeOptions` interface is honored at compile time but irrelevant at parse time — commander parses positionally from `.option()` declarations alone. Result: a `serve-http --use-hnsw` invocation fails fast with `error: unknown option '--use-hnsw'` despite `HttpServeOptions` having a `useHnsw?: boolean` field via `ServeOptions`.

**Evidence** (commander runtime rejection):

```bash
$ enquire-mcp serve-http --vault /tmp/foo --bearer-token <…32+ chars…> --use-hnsw
error: unknown option '--use-hnsw'
```

Missing flags (each one is in `serve` at `src/cli.ts:42–117` but absent from `serve-http` at `src/cli.ts:122–177`):

| Flag | In `serve` | In `serve-http` | Effect in `ServeOptions` |
|---|---|---|---|
| `--include-pdfs` | `cli.ts:77` | (missing) | `includePdfs?: boolean` — PDF blend into hybrid search |
| `--enable-reranker` | `cli.ts:81` | (missing) | `enableReranker?: boolean` — BGE cross-encoder reranking |
| `--reranker-model <alias>` | `cli.ts:85` | (missing) | `rerankerModel?: string` |
| `--reranker-top-n <n>` | `cli.ts:89` | (missing) | `rerankerTopN?: string` |
| `--use-hnsw` | `cli.ts:93` | (missing) | `useHnsw?: boolean` |
| `--hnsw-ef <n>` | `cli.ts:97` | (missing) | `hnswEf?: string` |
| `--late-chunk-context <chars>` | `cli.ts:101` | (missing) | `lateChunkContext?: string` |
| `--no-hnsw-persist` | `cli.ts:105` | (missing) | `hnswPersist?: boolean` (negation) |

Conflicting documentation:

- `docs/api.md:102` — _"v2.13.0 — `serve` / `serve-http` flags: `--use-hnsw` builds an in-memory HNSW vector index on serve start … `--hnsw-ef <n>` tunes search-time accuracy."_ — claims both transports support `--use-hnsw` / `--hnsw-ef`.
- `docs/api.md:106` — _"v2.15.0 — `--late-chunk-context <chars>` on `serve` and `build-embeddings`."_ — at least concedes serve-http isn't included (so late-chunking is OK), but the v2.13.0 line above is wrong.
- `docs/api.md:108` — _"v2.16.0 — `--no-hnsw-persist`"_ — implies it applies to "when `--use-hnsw` is passed", which is documented as both transports.
- `docs/api.md:110` — _"v2.17.0 — `--quantize-embeddings <mode>` on `serve`, `serve-http`, `build-embeddings`, and `setup`."_ — `--quantize-embeddings` IS present on serve-http at `cli.ts:174–177`, so this one is correct. But it's the only late-feature flag that was actually back-ported.
- `src/http-transport.ts:38` — comment header: _"Extends ServeOptions so every stdio-mode flag (`--enable-write`, `--persistent-index`, `--watch`, etc.) is available over HTTP too."_ — overstates: HTTP transport's TYPE has every field, but the CLI surface drops 8 of them.

**Other instances** (grep cross-cutting):

- `README.md:62` — quickstart command is `enquire-mcp serve --vault <path> --persistent-index --enable-reranker --use-hnsw` — uses `serve`, doesn't claim it works for `serve-http`. Clean.
- `STABILITY.md:55–62` — lists CLI surface; doesn't claim serve-http parity beyond the shared serve flags. Clean.
- `docs/http-transport.md` — not inspected here (deferred to L6). If it claims `--use-hnsw` etc. work via serve-http, this same finding will surface there.

**Suggested class fix**: One of:
1. **Back-port the 8 missing `.option()` calls to `serve-http`** in `src/cli.ts` (line ~177, right before the `.action()`). Mechanical edit — copy-paste the 8 lines from the serve block. Then add an invariant test in `tests/cli.test.ts` that does `program._findCommand('serve').options` ∩ `program._findCommand('serve-http').options` and asserts every shared option (everything except `--port` / `--host` / `--bearer-token` / `--bearer-token-env` / `--mcp-path` / `--rate-limit` / `--cors-origin` / `--health-path` / `--stateful` / `--session-idle-timeout-ms` / `--max-sessions`) is present in both. This prevents future drift.
2. **Or factor the shared options into a helper** that takes a `Command` and chains the 23 `serve`/`serve-http` shared flags. Eliminates copy-paste drift entirely. `commander` v14 supports `Command.copyInheritedSettings` but not a clean shared-options pattern; a free function returning the chained command is the idiom. About a 30-line refactor of `cli.ts`.

**Suggested per-instance backfill**: After the class fix, no per-instance backfill needed — both transports converge. If the choice is option (1) without the invariant test, monitor over the next 2 releases for regression.

---

### Finding L2-02 (Low)

**File**: `src/tool-registry.ts:63`, `docs/api.md:3,820,822`, `STABILITY.md:19`. The truth-source is `src/server.ts:402` + `src/tool-manifest.ts:47`.
**Class**: Drift between user-visible documentation and runtime gating logic for `obsidian_full_text_search`. The actual gate is `if (deps.ftsIndex && opts.diagnosticSearchTools) registerFtsTools(...)` — needs BOTH `--persistent-index` (which builds the FTS5 index → makes `deps.ftsIndex` non-null) AND `--diagnostic-search-tools`. Four downstream strings drop the second flag.
**Description**: The single-ranker FTS5 search tool was demoted to diagnostic in v2.0.0-beta.3 (along with `obsidian_search_text`, `obsidian_semantic_search`, `obsidian_embeddings_search`). The umbrella `obsidian_search` became default. The manifest knows this (kind: `fts`, gating: `--persistent-index + --diagnostic-search-tools`) and `docs/api.md:55` knows this (table row reads `--persistent-index (+ --diagnostic-search-tools)`). But 4 other locations describe the gating as `--persistent-index` alone — including the description string the tool returns over MCP, which is the most user-visible. Users following `docs/api.md:822` who start `enquire-mcp serve --vault X --persistent-index` will be confused when `obsidian_full_text_search` does not appear in `tools/list`.

**Evidence** (truth-source — `src/server.ts:402`):

```ts
if (deps.ftsIndex && opts.diagnosticSearchTools) registerFtsTools(server, deps.ftsIndex, deps.vault);
```

Conflicting strings (each says or implies just `--persistent-index`):

```ts
// src/tool-registry.ts:63 — returned to every MCP client in tools/list:
"… Use `obsidian_search_text` instead if the index isn't built yet — this tool is only registered when the server is started with `--persistent-index`."
```

```md
<!-- docs/api.md:3 — the intro paragraph: -->
… the 4 opt-ins are: 1 via `--persistent-index` (`obsidian_full_text_search`) + 3 via `--diagnostic-search-tools` …
```

```md
<!-- docs/api.md:820: -->
## `obsidian_full_text_search` _(opt-in, requires `--persistent-index`)_

<!-- docs/api.md:822: -->
BM25-ranked full-text search over a SQLite FTS5 inverted index … Only registered when the server is started with `--persistent-index`; otherwise use `obsidian_search_text`.
```

```md
<!-- STABILITY.md:19: -->
**Read — opt-in via `--persistent-index` (1):** `obsidian_full_text_search`.
```

Two sources get it right (`docs/api.md:55`, `tool-manifest.ts:47`):

```md
| `obsidian_full_text_search` | read | `--persistent-index` (+ `--diagnostic-search-tools`) | BM25-ranked search … |
```

```ts
// tool-manifest.ts:45-48:
{
  name: "obsidian_full_text_search",
  kind: "fts",
  gating: "--persistent-index + --diagnostic-search-tools",
  summary: "BM25 full-text search backed by the SQLite FTS5 inverted index."
}
```

**Other instances** (grep cross-cutting): the four conflicting strings above. No other doc / test / code path describes the gating.

**Suggested class fix**: Two options, not mutually exclusive:
1. **Single source of truth, derived strings**: Have `src/tool-registry.ts` import the manifest entry for `obsidian_full_text_search` and use `TOOL_MANIFEST.find(t => t.name === '...').gating` to construct the description string. Then any future gating change updates the manifest once + the MCP description automatically. Same pattern works for `docs/api.md` — add a render step in `scripts/docs:api` (or in TypeDoc post-processing) that fills the gating column from the manifest.
2. **Tighten the docs-consistency test**: `tests/docs-consistency.test.ts` already checks tool surface coverage. Extend it to assert (for every manifest entry whose `gating` includes `--diagnostic-search-tools`) that the docs sections describing that tool mention BOTH flags. About 20 lines of test code. Catches manual drift even without a render-time fix.

**Suggested per-instance backfill**: 4 string edits:
- `src/tool-registry.ts:63` — change "only registered when the server is started with `--persistent-index`" to "only registered when the server is started with `--persistent-index --diagnostic-search-tools`".
- `docs/api.md:3` — clarify the intro: "1 via `--persistent-index + --diagnostic-search-tools` …".
- `docs/api.md:820–822` — change `_(opt-in, requires `--persistent-index`)_` to `_(opt-in, requires `--persistent-index --diagnostic-search-tools`)_`; same fix in line 822 body text.
- `STABILITY.md:19` — change "opt-in via `--persistent-index` (1)" to "opt-in via `--persistent-index --diagnostic-search-tools` (1)" or restructure (move it to the diagnostic-search-tools section at line 23).

Estimated 15 minutes for the per-instance fix, 1 hour for the class fix (test extension).

---

### Finding L2-03 (Low)

**File**: 8 modules participate in the 7 detected cycles: `src/index.ts`, `src/cli.ts`, `src/server.ts`, `src/tool-registry.ts`, `src/http-transport.ts`, `src/tools/meta.ts`, `src/tools/read.ts`, `src/tools/search.ts`, `src/tools/write.ts`.
**Class**: Module dependency cycles. ESM tolerates them when cycled symbols are only referenced inside function bodies (the bindings get hoisted and bind by the time the cycled function is called), but they're a smell: they make module-load order brittle, complicate refactoring (extracting a symbol can break loading), and any future move from inside-function to top-level usage of a cycled symbol introduces a `ReferenceError: Cannot access '<symbol>' before initialization` at load time that no current test would catch.
**Description**: `npx madge --circular --extensions ts src/` reports 7 cycles. They fall into 2 classes:

**Class A — `VERSION` re-export hub** (4 cycles, all transitive through `src/index.ts`):
```
1. cli.ts → http-transport.ts → index.ts          (→ cli.ts via index re-export of main)
2. index.ts → server.ts                           (→ index.ts via server's `import { VERSION } from "./index.js"`)
3. index.ts → server.ts → tool-registry.ts        (→ index.ts via tool-registry's `import { VERSION }`)
4. server.ts → tool-registry.ts                   (→ server.ts via tool-registry's `import type { ServerDeps }`)
```

Class A root cause: `VERSION = "3.6.0"` lives in `src/index.ts:37` (single source of truth so `scripts/check-version-consistency.mjs` can grep one file), and three modules import it: `cli.ts:6`, `server.ts:7`, `tool-registry.ts:5`. Combined with the v3.6.0-rc.2 split (`src/index.ts:47–57` re-exports `main`, `buildEmbedText`, `buildMcpServer`, `formatReadyBanner`, `prepareServerDeps`, `ServeOptions`, `ServerDeps`, `startServer`, `parsePositiveInt`, `parseQuantizationMode` from `cli.ts`, `server.ts`, `tool-registry.ts` to keep the public surface stable), every cross-import creates a cycle through index.

**Class B — `tools/*` peer cluster** (3 cycles, all inside `src/tools/`):
```
5. tools/meta.ts → tools/read.ts                          (→ meta.ts via read's `import { findBestMatch, ... } from "./meta.js"`)
6. tools/meta.ts → tools/read.ts → tools/search.ts        (→ meta.ts via search's `import { findBestMatch, ... } from "./meta.js"`)
7. tools/meta.ts → tools/read.ts → tools/search.ts → tools/write.ts  (→ meta.ts via write's `import { findBestMatch, ... } from "./meta.js"`)
```

Class B root cause: `tools/meta.ts` exports cross-tool helpers (`findBestMatch`, `stripMd`, `jaccard`, `intersectionSize`, `ngrams`, `normalizeTag`, `indexFor`) used by `read.ts`, `search.ts`, `write.ts`; and `meta.ts` calls into `read.ts` (`getRecentEdits`), `search.ts` (`searchHybrid`), `write.ts` (`resolveTarget`, `suggestSimilar`) for its higher-level tools (`contextPack`, `paperAudit`). So they import each other, and `tools/meta.ts` is both a "leaf" (helpers) and an "aggregator" (multi-tool composer).

**Evidence — confirmed runtime-safe** (no cycled symbol is referenced at module-load time):

```bash
$ grep -nE "^(const|let|var|export const|export let|export var)\s+\w+\s*=\s*(findBestMatch|stripMd|jaccard|intersectionSize|ngrams|searchHybrid|resolveTarget|sliceSnippet|extractFrontmatterTagsLower|normalizeTag|listTags|getRecentEdits|getBacklinks|suggestSimilar|VERSION)" /Users/alex/Documents/Projects/obsidian-mcp/src/**/*.ts
# (empty)

$ node -e "import('./dist/index.js').then(m => console.log('VERSION:', m.VERSION))"
VERSION: 3.6.0
```

All 7 cycles load cleanly. All 713 tests pass. So this is a smell, not a bug.

**Other instances** (grep cross-cutting): not applicable — this finding IS the cross-cutting view.

**Suggested class fix**: Two options:
1. **Add a circular-dep invariant test**: `tests/no-circular-deps.test.ts` — invoke madge programmatically (`import madge from 'madge'; const result = await madge('src/', { fileExtensions: ['ts'] }); expect(result.circular()).toEqual([])` OR allow exactly the current 7 cycles and snapshot them). This catches NEW cycles introduced in PRs but tolerates the existing 2 classes. About 30 lines.
2. **Eliminate Class A** by extracting `VERSION` to its own micro-module (`src/version.ts`) that nobody else imports from. `src/index.ts`, `cli.ts`, `server.ts`, `tool-registry.ts` would all import from `./version.js` directly. Removes 4 of the 7 cycles. Trade-off: `scripts/check-version-consistency.mjs` regex must be updated to grep `src/version.ts` instead of `src/index.ts`. About 10 lines of refactor + 1 script change.
3. **Eliminate Class B** by extracting the cross-tool helpers (`findBestMatch`, `stripMd`, `jaccard`, `intersectionSize`, `ngrams`, `normalizeTag`, `indexFor`) from `tools/meta.ts` into a new `tools/_shared.ts`. Then `tools/meta.ts` becomes a pure aggregator (importing from peers but not exporting to them). Eliminates the 3 tools cycles. About a 50-line refactor.

Option (1) is the lowest-cost: keep the cycles, prevent new ones. Options (2) and (3) are nice-to-haves but not blocking.

**Suggested per-instance backfill**: not applicable — depends on which class fix is taken.

---

### Finding L2-04 (Info)

**File**: `docs/api.md` (canonical API reference) is missing two real CLI flags: `--reranker-model <alias>` and `--reranker-top-n <n>`.
**Class**: Doc completeness drift. The flags exist (`src/cli.ts:85–92` for `serve`, `src/cli.ts:580–581` for `eval`) and are honored at runtime (`src/server.ts` consumes `rerankerModel` + `rerankerTopN` from `ServeOptions`; `eval` consumes from its own opts). But they're not in the canonical CLI reference. A user reading `docs/api.md` end-to-end will not learn that the reranker model is configurable (`rerank-multilingual` is just one of 5 aliases — `rerank-bge`, `rerank-bge-large`, `rerank-jina-tiny`, `rerank-multilingual-large`) or how many candidates get reranked.
**Description**: `docs/api.md` describes `--enable-reranker` narratively in the line-3 intro and in section header "v2.9.0+ adds BGE cross-encoder reranking", but stops there. The serve-flag table at `docs/api.md:75–89` doesn't include any reranker flag (even `--enable-reranker` itself is missing from the table). The eval subcommand row at line 100 mentions `[--reranker]` but not `[--reranker-model]` / `[--reranker-top-n]`.

**Evidence**: `grep -nE "reranker-model|reranker-top-n" docs/api.md README.md` returns 0 matches. Only `STABILITY.md:63` mentions `--reranker-model` (it's the alias-stability promise). `docs/api-reference/` (TypeDoc-generated) has `rerankerModel` + `rerankerTopN` because they're `ServeOptions` fields — but that's not the place a CLI user looks.

**Other instances** (grep cross-cutting): same class as L2-01 (drift between `cli.ts` and `docs/api.md`), but L2-01 is about flag REJECTION (real bug); this is about flag UNDOCUMENTED (real gap). Other potentially undocumented flags worth a sweep when fixing this one: `--hnsw-ef` (described in narrative para at line 102 ✅), `--late-chunk-context` (line 106 ✅), `--no-hnsw-persist` (line 108 ✅), `--cors-origin` (mentioned in serve-http row at line 96 ✅), `--health-path` (line 96 ✅), `--mcp-path` (line 96 ✅). So this is JUST the 2 reranker tuning flags.

**Suggested class fix**: Add a docs-consistency invariant test that asserts every flag declared in `src/cli.ts` (regex `\.option\("(--[a-z][a-z-]+)`) appears at least once in `docs/api.md`. About 15 lines, similar shape to the existing tool-surface-coverage assertion in `tests/docs-consistency.test.ts`. Would catch future flag drift automatically.

**Suggested per-instance backfill**: Add a row (or a paragraph similar to the v2.13.0 narrative at line 102) covering `--reranker-model <alias>` and `--reranker-top-n <n>` in `docs/api.md`. Mention the 5 alias options + their size/quality trade-offs (already documented in `src/cli.ts:86–88` description string). About 5 lines.

---

## Files explicitly clean (no findings)

The following architecture surfaces were inspected and have no issues:

- **`package.json#exports`** — all 7 sub-paths (`.`, `./embed-db`, `./fts5`, `./vault`, `./hnsw`, `./bases`, `./communities`, `./package.json`) resolve to existing `dist/*.{js,d.ts}` files. Each subpath import loads cleanly (`embed-db` exports `EmbedDb` / `defaultEmbedDbFile` / `encodeInt8Vector` / `decodeInt8Vector`; `fts5` exports `FtsIndex` / `chunkContent` / `defaultIndexFile` / `safeFts5Query`; etc.). The slim `src/index.ts` re-export hub (`main`, `buildMcpServer`, `buildEmbedText`, `formatReadyBanner`, `prepareServerDeps`, `startServer`, `parsePositiveInt`, `parseQuantizationMode`, `ServeOptions`, `ServerDeps`, `VERSION`) preserves the v3.5.x public surface through the rc.2 module split.

- **`TOOL_MANIFEST` ↔ registration**: 44 manifest entries, 44 `server.registerTool()` calls, exact name-set equality (`Only in TOOL_MANIFEST (not in registry): [] / Only in registry (not in TOOL_MANIFEST): []`). Per-tool `kind` matches registration context: 1 fts (`registerFtsTools`), 33 read (`registerReadTools` outside the `if (diagnosticSearchTools)` block), 3 diagnostic (`registerReadTools` inside the `if (diagnosticSearchTools)` block), 7 write (`registerWriteTools`). Per-tool `gating` field exactly describes the runtime gate: `always` (33), `--diagnostic-search-tools` (3), `--persistent-index + --diagnostic-search-tools` (1), `--enable-write` (7) — see L2-02 for the one drift in the description strings.

- **`registerPrompt()` ↔ README + STABILITY**: 19 `server.registerPrompt()` calls in `src/prompts.ts`; 19 names in `README.md:154` (single `MCP prompts (...)` paragraph); 19 names in `STABILITY.md:33`. Set-equal across all three. (Detected names: `summarize_recent_edits`, `review_tag`, `find_orphans`, `weekly_review`, `extract_todos`, `process_inbox`, `consolidate_tags`, `find_duplicates`, `lint_wiki`, `monthly_review`, `search_with_query_expansion`, `vault_synth`, `vault_wiki_compile`, `vault_lint_extended`, `vault_capture`, `vault_persona_search`, `vault_automation_setup`, `vault_research`, `vault_synthesis_page`.)

- **`ServeOptions` ↔ CLI flag mapping** (bidirectional): 23 `ServeOptions` keys (`vault`, `enableWrite`, `maxFileBytes`, `cacheSize`, `persistentCache`, `cacheFile`, `persistentIndex`, `indexFile`, `tokenize`, `excludeGlob`, `readPaths`, `watch`, `disabledTools`, `enabledTools`, `diagnosticSearchTools`, `includePdfs`, `enableReranker`, `rerankerModel`, `rerankerTopN`, `useHnsw`, `hnswEf`, `lateChunkContext`, `hnswPersist`, `quantizeEmbeddings`) each map cleanly to a `serve`-command CLI flag (the negation `--no-hnsw-persist` → `hnswPersist` is the one camelCase exception, handled correctly by commander). Every `ServeOptions` key is referenced from at least 2 of `src/server.ts` / `src/cli.ts` / `src/http-transport.ts` / `src/tool-registry.ts` — none are dead.

- **CLI option handlers**: every `.option(...)` on every command (`serve`, `serve-http`, `gen-token`, `clear-cache`, `clear-index`, `index`, `install-model`, `build-embeddings`, `clear-embeddings`, `doctor`, `setup`, `eval`) is consumed by the corresponding `.action(opts => …)` handler. Spot-checked all 12 commands. No orphan flags.

- **Module graph shape**: shallow; max chain length ≤ 4 (`cli.ts → server.ts → tool-registry.ts → tools/index.ts → tools/*.ts`). `vault.ts` has the highest fan-in (14 importers) — it's the right hub (parsed-note cache + privacy filter + path resolution). `fts5.ts` (8 fan-in), `embed-db.ts` (4), `embeddings.ts` (4), `parser.ts` (4) are the right next-tier shared utilities. `tool-manifest.ts` has 0 fan-in inside `src/` by design — it's a spec file consumed only by `tests/docs-consistency.test.ts`. No suspicious orphans.

- **`tools/*` exports vs consumption**: 57 named exports from `src/tools/index.ts` (re-exports from `media.ts` + `meta.ts` + `read.ts` + `search.ts` + `write.ts`). 38 are imported by `src/tool-registry.ts` (the public tool handlers). The remaining 19 (`buildTfidfIndex`, `composeNote`, `extractFrontmatterTagsLower`, `findBestMatch`, `indexFor`, `intersectionSize`, `jaccard`, `ngrams`, `normalizeTag`, `pickEmbedTextForHyde`, `replaceStringOutsideCodeFences`, `resolvePeriodicAlias`, `resolveTarget`, `rewriteOutsideCodeFences`, `rewriteRawTarget`, `sliceSnippet`, `stripMd`, `suggestSimilar`, `tokenizeForTfidf`) are internal cross-module helpers used by sibling `tools/*` files — re-exported by `tools/index.ts` because `export * from` doesn't discriminate `@internal`. This intersects with L1-03 (`@internal` discipline) — adding `@internal` tags wouldn't hide them from JS consumers but would hide them from TypeDoc.

- **`tools/index.ts` cycle safety**: `export * from` chains through all 5 leaf files; despite cycles in the underlying graph, `import('./tools/index.js')` loads cleanly with 57 keys present.

- **`src/index.ts` CLI-entry guard**: realpath-comparison still functional; `if (isCliEntry) main().catch(...)` still gated. Module loads cleanly when imported as a library (no main() invoked); CLI-mode triggers correctly.

- **No dead code branches**: `grep -E "TODO|FIXME"` returns ~30 hits across `src/`, all of them descriptive context (e.g. "TODO: defer to v3.7" / "FIXME if multi-process needed") — none indicate broken / abandoned scaffolding. No `// @ts-expect-error` without explanation.

## Verification commands

```bash
cd /Users/alex/Documents/Projects/obsidian-mcp
npx madge --circular --extensions ts src/                       # 7 cycles, all runtime-safe
npx madge --extensions ts --json src/ > /tmp/deps.json          # dependency graph for analysis
node -e "import('./dist/index.js').then(m => console.log(Object.keys(m)))"   # public surface
for sp in embed-db fts5 vault hnsw bases communities; do        # all subpath exports
  node -e "import('./dist/$sp.js').then(m => console.log('$sp:', Object.keys(m).length))"
done
node -e "import('./dist/tool-manifest.js').then(m => console.log(m.TOOL_MANIFEST.length))"  # 44
grep -cE "server\.registerTool\(" src/tool-registry.ts                 # 44
grep -cE "server\.registerPrompt\(" src/prompts.ts                     # 19
enquire-mcp serve --help      | grep -oE '^\s+--[a-z][a-z-]+' | sort -u | wc -l   # 24 (serve flags, incl. --vault)
enquire-mcp serve-http --help | grep -oE '^\s+--[a-z][a-z-]+' | sort -u | wc -l   # 27 (24 + 11 HTTP-only − 8 missing; see L2-01)
```
