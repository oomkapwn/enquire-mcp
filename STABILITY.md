# Stability promise

`enquire-mcp` follows [SemVer 2.0](https://semver.org/spec/v2.0.0.html) strictly. This document spells out exactly what counts as a "public surface" — what a major-version bump (`X.0.0`) is required to break.

## TL;DR

After **v3.0.0** every CLI flag, MCP tool name, MCP resource URI, MCP prompt name, and exported TypeScript symbol below is **semver-bound**. Breaking changes require a major bump. Additive minor releases (`v3.x.0`) and patches (`v3.x.y`) keep these contracts intact.

## v3.x stable surfaces

### MCP tool names (46 tools)

46 tools total = **34 always-on read** + **1 opt-in via `--persistent-index` + `--diagnostic-search-tools`** + **3 opt-in via `--diagnostic-search-tools`** + **7 gated by `--enable-write`** + **1 opt-in via `--feedback-weight`**. Names + argument shapes are stable in v3.x.

**Read — always-on (34):**

`obsidian_search`, `obsidian_hyde_search`, `obsidian_read_note`, `obsidian_list_notes`, `obsidian_list_tags`, `obsidian_list_canvases`, `obsidian_list_pdfs`, `obsidian_list_bases`, `obsidian_resolve_wikilink`, `obsidian_get_backlinks`, `obsidian_get_outbound_links`, `obsidian_get_note_neighbors`, `obsidian_get_communities`, `obsidian_get_recent_edits`, `obsidian_stale_notes`, `obsidian_get_unresolved_wikilinks`, `obsidian_open_questions`, `obsidian_dataview_query`, `obsidian_frontmatter_get`, `obsidian_frontmatter_search`, `obsidian_find_path`, `obsidian_find_similar`, `obsidian_read_canvas`, `obsidian_read_pdf`, `obsidian_read_base`, `obsidian_query_base`, `obsidian_ocr_pdf`, `obsidian_context_pack`, `obsidian_chat_thread_read`, `obsidian_stats`, `obsidian_lint_wiki`, `obsidian_open_in_ui`, `obsidian_paper_audit`, `obsidian_validate_note_proposal`.

**Read — opt-in via `--persistent-index` + `--diagnostic-search-tools` (1):** `obsidian_full_text_search`.

**Read — opt-in via `--diagnostic-search-tools` (3):** `obsidian_search_text`, `obsidian_semantic_search`, `obsidian_embeddings_search`. Registered alongside `obsidian_search` for diagnostic / A/B benchmarking.

**Write — gated by `--enable-write` (7):** `obsidian_create_note`, `obsidian_append_to_note`, `obsidian_rename_note`, `obsidian_replace_in_notes`, `obsidian_archive_note`, `obsidian_frontmatter_set`, `obsidian_chat_thread_append`.

**Feedback — opt-in via `--feedback-weight` (1):** `obsidian_mark_useful`. Records which recalled notes helped a query (closed-loop retrieval feedback); the recorded usefulness boosts those notes in subsequent `obsidian_search` results. Mutates a per-vault feedback cache sidecar (relative paths + counts only), NOT the vault — so it is gated by `--feedback-weight`, not `--enable-write`.

### MCP resource URIs

- `obsidian://vault/info`
- `obsidian://note/{path}`
- `obsidian://chunk/{n}/{path}` (FTS5-backed; only registered when `--persistent-index` is set)

### MCP prompts (19)

`summarize_recent_edits`, `review_tag`, `find_orphans`, `weekly_review`, `extract_todos`, `process_inbox`, `consolidate_tags`, `find_duplicates`, `lint_wiki`, `monthly_review`, `search_with_query_expansion`, `vault_synth`, `vault_wiki_compile`, `vault_lint_extended`, `vault_capture`, `vault_persona_search`, `vault_automation_setup`, `vault_research` (v3.1.0), `vault_synthesis_page` (v3.1.0).

### CLI flags

Every flag accepted by `enquire-mcp serve` / `serve-http` / `index` / `build-embeddings` / `setup` / `eval` / `doctor` / `clear-cache` / `clear-index` / `clear-embeddings` / `gen-token` / `install-model` / `install-ocr-lang` is stable. New flags will be added in minor releases (additive); existing flag names + accepted values + defaults will not change without a major bump.

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
- **On-disk file formats.** SQLite schemas, HNSW sidecar layouts, embedding model versions, and persistent-cache shapes can evolve. v2.17 demonstrated the policy: schema bumps trigger automatic rebuild via the meta-table contamination guard. You don't need to migrate manually.
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
