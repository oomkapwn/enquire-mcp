# Stability promise

`enquire-mcp` follows [SemVer 2.0](https://semver.org/spec/v2.0.0.html) strictly. This document spells out exactly what counts as a "public surface" — what a major-version bump (`X.0.0`) is required to break.

## TL;DR

On the stable channel after **v3.0.0**, every CLI flag, MCP tool name, MCP resource URI, MCP prompt name, and exported TypeScript symbol below is **semver-bound**. Breaking changes require a major bump. Minor releases add backward-compatible functionality; patch releases fix defects without adding a new public capability. Explicit `@rc` previews remain prerelease surfaces until stable promotion. npm `@latest` remains the stable v3 line while v4 is exercised on `@rc`.

## v4.x prerelease compatibility boundary

`4.0.0-rc.7` is the current preview of the deliberate major boundary for the official MCP TypeScript SDK v2 and MCP protocol revision `2026-07-28`:

- The 46 tool names and argument shapes, 19 prompt names and schemas, resources, CLI flags/defaults, privacy controls, and write gates remain compatible with v3. Storage is not blanket-compatible: the exact custom-path admission boundary and HNSW layout migration are called out below.
- Custom persistence paths now require exact case-sensitive family suffixes: `.json` for parse cache (excluding reserved `.feedback.json`/`.hnsw.meta.json` subclasses), `.fts5.db`, `.embed.db`, `.feedback.json`, and `.hnsw`. This is an intentional v4 prerelease break from v3's arbitrary custom spellings. There is no automatic migration or broad legacy eraser: stop all enquire processes, manually inspect/remove the old main and sidecars, then select a compliant path.
- HNSW persistence now writes an immutable `.hnsw.<nonce>.bin` generation and publishes a compact format-4, digest-bound `.hnsw.meta.json` pointer last. The pointer contains no row paths or previews; the live label/row manifest must come from one atomic EmbedDb snapshot. The exported `HnswPersistedMeta` v1 TypeScript declaration and legacy two-argument `loadHnswFromDisk(file, signature)` overload remain source-compatible, but the two-argument call now deliberately returns `null` instead of trusting caller-writable sidecar row/capacity metadata. Programmatic consumers that want disk reload must pass the additive trusted `HnswLoadOptions`; v1/v2/v3 sidecars rebuild fail-soft. This is an intentional v4 runtime contract break, while the TypeScript call remains compilable.
- `serve` now uses SDK v2's era-aware stdio entrypoint. `serve-http` accepts strict modern `2026-07-28` exchanges and supported legacy 2025-era clients from the same registered surface; `--stateful` continues to provide sticky sessions, GET/SSE, and DELETE lifecycle for the legacy leg. Malformed or unsupported modern claims are never retried as legacy.
- The one intentional programmatic TypeScript break is nominal: `buildMcpServer()` now returns `McpServer` from `@modelcontextprotocol/server@2.0.0`, not the monolithic SDK v1 class. Consumers that name or inspect the old SDK type must migrate their import/type expectation; the Enquire function name and parameters are unchanged.
- Persisted-index receipts are additive: the exact receipt-free `FtsIndex.search()`/`getChunk()`, `EmbedDb.search()`/`getAllVectors()`, and `hnswResultsToHits()` shapes remain available, while receipt-aware consumers can opt into `searchWithReceipts()`, `getChunkWithReceipt()`, `getSearchRowsByIds()`, and `hnswResultsToReceiptHits()`. This adds no second intentional TypeScript break.
- Persistent-index ownership APIs are additive. `@oomkapwn/enquire-mcp/fts5` exposes `FtsIndexOwnedMeta`, the discriminated `FtsIndexDiscovery`, `assertTokenizeMode()`, and `discoverFtsIndexConfig()`; `@oomkapwn/enquire-mcp/embed-db` exposes `EmbedDbOwnedMeta`, the discriminated `EmbedDbConfigDiscovery`, `discoverEmbedDbConfig()`, its root/file-isolated cached sibling `discoverEmbedDbConfigCached()`, and the recovery-guidance gate `assertEmbedDbRecoveryOwnership()`. The existing `peekFtsMetaSafe()`, `peekEmbedDbMeta()`, and `peekEmbedDbMetaCached()` retain their one-argument compatibility and add an optional expected-root filter. Discovery is configuration guidance rather than standalone mutation authority: production callers pass the result into the additive optional `open(expectedDiscovery)` parameter so a changed configuration refuses before bootstrap, while the legacy no-argument `open()` remains available for explicitly configured low-level rebuilds. The mutating open's live-handle checks remain authoritative in both forms.
- Modern HTTP and legacy-stateless HTTP are per-request. Legacy stateful HTTP retains its session lifecycle. Persistent writes on stdio and every HTTP leg are drained or rolled back before shared persistence resources close.

Because this is an `@rc`, the v4 contract is not a stable-channel promise yet. Stable v4 promotion additionally requires real-client evidence and an explicit maintainer decision; installing `@latest` continues to select v3.

The `enquire-mcp-basic-4.0.0-rc.7.mcpb` asset is the current build of the deliberately narrower preview profile introduced in `v4.0.0-rc.2`, not a replacement for the full npm/CLI surface. It fixes one vault, exactly 13 read-only tools, zero prompts, and no writes, watcher controls, persistent/on-disk index, embedding model, PDF, or OCR surface; its compatible host must provide Node.js 22.13 or newer. Its release is remotely gated and provenance-bound, but real desktop UI acceptance, signing, and directory/catalog approval remain outside this RC's claims.

## v3.x stable surfaces

### MCP tool names (46 tools)

46 tools total = **34 always-on read** + **1 opt-in via `--persistent-index` + `--diagnostic-search-tools`** + **3 opt-in via `--diagnostic-search-tools`** + **7 gated by `--enable-write`** + **1 opt-in via `--feedback-weight`**. Names + argument shapes are stable in v3.x.

**Read — always-on (34):**

`obsidian_search`, `obsidian_hyde_search`, `obsidian_read_note`, `obsidian_list_notes`, `obsidian_list_tags`, `obsidian_list_canvases`, `obsidian_list_pdfs`, `obsidian_list_bases`, `obsidian_resolve_wikilink`, `obsidian_get_backlinks`, `obsidian_get_outbound_links`, `obsidian_get_note_neighbors`, `obsidian_get_communities`, `obsidian_get_recent_edits`, `obsidian_stale_notes`, `obsidian_get_unresolved_wikilinks`, `obsidian_open_questions`, `obsidian_dataview_query`, `obsidian_frontmatter_get`, `obsidian_frontmatter_search`, `obsidian_find_path`, `obsidian_find_similar`, `obsidian_read_canvas`, `obsidian_read_pdf`, `obsidian_read_base`, `obsidian_query_base`, `obsidian_ocr_pdf`, `obsidian_context_pack`, `obsidian_chat_thread_read`, `obsidian_stats`, `obsidian_lint_wiki`, `obsidian_open_in_ui`, `obsidian_paper_audit`, `obsidian_validate_note_proposal`.

**Read — opt-in via `--persistent-index` + `--diagnostic-search-tools` (1):** `obsidian_full_text_search`.

**Read — opt-in via `--diagnostic-search-tools` (3):** `obsidian_search_text`, `obsidian_semantic_search`, `obsidian_embeddings_search`. Registered alongside `obsidian_search` for diagnostic / A/B benchmarking.

**Write — gated by `--enable-write` (7):** `obsidian_create_note`, `obsidian_append_to_note`, `obsidian_rename_note`, `obsidian_replace_in_notes`, `obsidian_archive_note`, `obsidian_frontmatter_set`, `obsidian_chat_thread_append`.

**Feedback — opt-in via `--feedback-weight` (1):** `obsidian_mark_useful`. Records which recalled notes helped a query (closed-loop retrieval feedback); the recorded usefulness boosts those notes in subsequent `obsidian_search` results. Mutates a root-checked, routing-key-scoped feedback cache sidecar (canonical absolute vault root + relative path keys + counts + ISO timestamps; no note content/query text), NOT the vault — so it is gated by `--feedback-weight`, not `--enable-write`. The legacy SHA1-12 default stem is not collision-proof vault identity; see the SECURITY retention boundary.

### MCP resource URIs

- `obsidian://vault/info`
- `obsidian://note/{path}`
- `obsidian://chunk/{n}/{path}` (FTS5-backed; only registered when `--persistent-index` is set)

### MCP prompts (19)

`summarize_recent_edits`, `review_tag`, `find_orphans`, `weekly_review`, `extract_todos`, `process_inbox`, `consolidate_tags`, `find_duplicates`, `lint_wiki`, `monthly_review`, `search_with_query_expansion`, `vault_synth`, `vault_wiki_compile`, `vault_lint_extended`, `vault_capture`, `vault_persona_search`, `vault_automation_setup`, `vault_research` (v3.1.0), `vault_synthesis_page` (v3.1.0).

### CLI flags

Every flag available from stable `@latest` on `enquire-mcp serve` / `serve-http` / `index` / `build-embeddings` / `setup` / `eval` / `doctor` / `configure` / `clear-cache` / `clear-index` / `clear-embeddings` / `gen-token` / `install-model` / `install-ocr-lang` / `query` / `prune` is stable. New flags arrive in minor releases; existing flag names, accepted values, and defaults do not change without a major bump.

`eval-compare` and `first-run` are v3.12.0 `@rc` previews. They join this stability promise when the minor release is promoted to `@latest`; until then their prerelease contracts may still be refined. `first-run` is preview-first: adding `--apply` is the explicit authorization boundary for local index/model-cache preparation.

Notable defaults that are part of the contract:
- `serve` is read-only by default — `--enable-write` required for the write tools.
- `--persistent-index` is **off** by default (TF-IDF works zero-setup).
- `--use-hnsw` is **off** by default (HNSW persistence is on once `--use-hnsw` is set; opt out with `--no-hnsw-persist`).
- `--quantize-embeddings` defaults to `f32` (bit-identical to v2.16- behavior).
- `--host 127.0.0.1` for `serve-http` (explicit local binding; remote access requires a tunnel).

### Exported TypeScript symbols

The package exports a few symbols for advanced embedding / programmatic use. These are stable in v3.x:

- `EmbedDb` / `EmbedDbOptions` / `EmbedQuantization` / `encodeInt8Vector` / `decodeInt8Vector` (`src/embed-db.ts`)
- `FtsIndex` / `chunkContent` / `defaultIndexFile` (`src/fts5.ts`)
- `Vault` (`src/vault.ts`)
- `ServeOptions` / `parsePositiveInt` / `parseQuantizationMode` / `startServer` / `main` / `buildMcpServer` / `prepareServerDeps` / `formatReadyBanner` / `buildEmbedText` — re-exported from `src/index.ts` (since v3.6.0-rc.2 they live in `src/server.ts` / `src/cli.ts` / `src/tool-registry.ts`, with `src/index.ts` keeping the re-export surface for v3.5.x BC).
- `HnswIndex` / `loadHnswFromDisk` / `HnswPersistedMeta` (`src/hnsw.ts`)
- `TOOL_MANIFEST` / `ToolManifestEntry` (`src/tool-manifest.ts`) — machine-readable manifest of all MCP tools (added in v3.6.0-rc.2). New stable surface — guaranteed to retain `name`, `kind`, `gating`, `summary` fields per entry across all v3.x.

Anything not listed here (private fields, internal helpers, test fixtures) is **not** semver-bound.

## What's NOT in the stability promise

- **Stderr log format.** We add diagnostic lines, change wording, and adjust verbosity in minor releases. Don't grep stderr for control flow.
- **On-disk file formats.** SQLite schemas, HNSW sidecar layouts, embedding model versions, and persistent-cache shapes can evolve. An exact-root index may rebuild automatically for an older supported schema or an intentional stored-configuration change; a foreign or unverifiably owned populated database is refused instead of being adopted or rebuilt. You don't need to migrate supported derived indexes manually.
- **Default models.** `--embedding-model` and `--reranker-model` default aliases (`multilingual` / `rerank-bge`) point at the recommended HuggingFace repos for the current release. We may change which underlying repo a default alias resolves to in a minor release if a better one becomes available; the alias name itself is stable.
- **Internal HTTP routes** other than `/mcp` and `/health` (which are configurable via `--mcp-path` / `--health-path`).
- **Test infrastructure** under `tests/` and helper scripts under `scripts/`.

## Deprecation policy

When a flag, tool, or symbol is deprecated:

1. We add a runtime warning (stderr) on first use, in the next minor release.
2. The deprecated surface continues to work for at least one minor release cycle.
3. We document the replacement in CHANGELOG.md.
4. Removal happens at the next major bump.

No surface in v3.0.0 is currently deprecated.

## Reporting compatibility breaks

If you find a behavior that breaks between minor / patch versions and isn't explicitly documented in the changelog, open an issue at <https://github.com/oomkapwn/enquire-mcp/issues> with the prior + new version numbers. We treat unintentional breakage as a bug.

## Why v3.0.0?

v3.0.0 is the **stable channel promotion** release that finalizes the v2.x retrieval roadmap. The v2.x line shipped 18 minor releases (v2.0 → v2.17) over ~3 days that turned the project from a v1-era keyword-search server into a feature-complete hybrid retrieval stack: BM25 + TF-IDF + ML embeddings (RRF-fused) + cross-encoder reranking + HNSW vector index (persisted) + late-chunking embeddings + int8 quantization + stateful HTTP + zero-touch onboarding + built-in eval harness.

There are no breaking code changes in v3.0.0 — it's a semantic milestone confirming the retrieval API has stabilized and committing to extended semver guarantees on the surfaces above.
