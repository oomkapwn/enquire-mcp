# enquire — API

**enquire is a long-term memory layer for AI agents, built on your Obsidian vault.** Open-source, MCP-native, vendor-neutral persistence: agents (Claude Code / Claude Desktop / Cursor / ChatGPT / Codex / any MCP client) get durable, queryable recall across sessions, models, and providers — your knowledge lives in plain markdown you own, not a vendor cloud. 44 MCP tools (33 always-on read + 4 opt-in read + 7 opt-in write); the 4 opt-ins are: 1 via `--persistent-index` + `--diagnostic-search-tools` (`obsidian_full_text_search` — needs BOTH flags: persistent-index for the FTS5 index, diagnostic-search-tools to surface it as a single-ranker tool alongside the hybrid default `obsidian_search`) + 3 via `--diagnostic-search-tools` (the single-ranker `obsidian_search_text` / `obsidian_semantic_search` / `obsidian_embeddings_search` — gated by default in v2.0+ since `obsidian_search` auto-detects + fuses signals). 2 + 1 opt-in MCP resources, 19 MCP prompts. **v3.1.0+ adds `obsidian_hyde_search`** (HyDE-augmented retrieval, Gao et al 2023; agent supplies a synthetic answer, server embeds it for retrieval) plus the `vault_research` (sub-question decomposition) and `vault_synthesis_page` (Karpathy LLM-Wiki synthesis loop) prompts. v2.6.0+ also speaks Streamable HTTP via `serve-http` (bearer auth + rate-limit + CORS). v2.7.0+ indexes PDFs as a separate read tool surface; **v2.8.0+ blends PDF chunks into `obsidian_search` hybrid retrieval** with `--include-pdfs` — every hit carries a `kind: "md" | "pdf"` flag and PDF snippets include `[page: N]` markers for citation. **v2.9.0+ adds BGE cross-encoder reranking** on top of RRF with `--enable-reranker` — typical +5-10 NDCG@10 retrieval-quality boost. **v2.10.0+ adds Tesseract OCR for image-only / scanned PDFs** via `obsidian_ocr_pdf` — completes the PDF retrieval story.

> **Channels:** stable v3.7.x (`@latest` on npm) ships 44 tools including `obsidian_search` (hybrid BM25 + TF-IDF + ML embeddings, RRF-fused) with optional BGE cross-encoder reranking, `obsidian_embeddings_search`, `obsidian_hyde_search`, plus the `install-model` / `build-embeddings` / `clear-embeddings` / `setup` / `doctor` / `eval` / `bench` subcommands. The `@rc` dist-tag carries the most recent release candidate. This document covers the **v3.7.x stable** surface — see [CHANGELOG.md](../CHANGELOG.md) for the v3.7.0 quality batch that closed the post-v3.6.4 audit cycle (K-1 class structurally enforced at 4 levels, ~20× faster search hot path via peek caching, per-file branch coverage floors, GitHub repo metadata invariant).

> Versioned dynamically — see [`CHANGELOG.md`](../CHANGELOG.md) for the current release.

## Tool index

Canonical list of every registered MCP tool. The `Kind` column splits read/write; `Gating` calls out CLI flags required to register the tool (else `always`). The new-tool invariant in `tests/docs-consistency.test.ts` parses this table and fails CI if any registered tool is missing.

### Read tools — always registered

| Tool | Kind | Gating | Summary |
|---|---|---|---|
| `obsidian_list_notes` | read | always | List markdown notes filtered by tag / folder / mtime — newest-first. |
| `obsidian_read_note` | read | always | Read a note by `path` or `title` (full body or heading-only map). |
| `obsidian_resolve_wikilink` | read | always | Resolve `[[wikilink]]` (alias / section / block / relative) to a vault file. |
| `obsidian_get_recent_edits` | read | always | List notes ordered by most recent modification. |
| `obsidian_get_backlinks` | read | always | List every note that links (or embeds) the target note, ranked. |
| `obsidian_list_tags` | read | always | List unique tags with frontmatter / inline usage counts. |
| `obsidian_dataview_query` | read | always | Run a Dataview-style `LIST` / `TABLE` query (subset DSL). |
| `obsidian_get_unresolved_wikilinks` | read | always | Find every `[[wikilink]]` whose target does not resolve to a real file. |
| `obsidian_get_outbound_links` | read | always | List every outbound wikilink / embed in a note with resolution status. |
| `obsidian_validate_note_proposal` | read | always | Lint a draft note BEFORE writing — YAML / wikilinks / tags / collisions. |
| `obsidian_find_similar` | read | always | Lexical-hybrid similarity (tags / 3-grams / shared outbound / co-backlinks). |
| `obsidian_get_note_neighbors` | read | always | Return a note + its 1-hop graph neighborhood (outbound / inbound / tag siblings). |
| `obsidian_stats` | read | always | Vault dashboard — totals, recent edits, orphans, broken links, top tags. |
| `obsidian_lint_wiki` | read | always | Karpathy LLM-Wiki lint — orphans / broken / stubs / stale / concept candidates. |
| `obsidian_open_questions` | read | always | Surface deferred-thinking markers (`Open question:` / `Q:` / `TODO?` / `??`) across notes. |
| `obsidian_paper_audit` | read | always | Flag `#paper` notes missing a citable identifier (arxiv / doi / url / isbn). |
| `obsidian_find_path` | read | always | BFS shortest wikilink path between two notes (with alternatives). |
| `obsidian_open_in_ui` | read | always | Generate an `obsidian://open` URI for hand-off to the desktop app. |
| `obsidian_list_canvases` | read | always | List `.canvas` files (whiteboard format) with node + edge counts. |
| `obsidian_read_canvas` | read | always | Parse one `.canvas` file into typed nodes (text / file / link / group) + edges. |
| `obsidian_get_communities` | read | always | Detect wikilink-graph communities via greedy modularity (GraphRAG-light). |
| `obsidian_list_bases` | read | always | List `.base` files (Obsidian's structured-query primitive) with view counts. |
| `obsidian_read_base` | read | always | Parse a `.base` file into structured JSON (filters / formulas / properties / views). |
| `obsidian_query_base` | read | always | Execute a `.base` file's filter against the vault, returning matching notes. |
| `obsidian_list_pdfs` | read | always | List `.pdf` files in the vault with size + mtime. |
| `obsidian_read_pdf` | read | always | Extract per-page text + `full_text` + doc-level metadata from a PDF. |
| `obsidian_ocr_pdf` | read | always | Tesseract OCR for image-only / scanned PDFs (multilingual via `lang`). |
| `obsidian_hyde_search` | read | always | HyDE retrieval — agent supplies a synthetic answer; server embeds it for retrieval. |
| `obsidian_search` | read | always | Hybrid retrieval — BM25 + TF-IDF + embeddings fused via RRF (v2.0 default). |
| `obsidian_chat_thread_read` | read | always | Parse a note's `## Chat: <title>` block into structured messages. |
| `obsidian_context_pack` | read | always | Retrieve + pack vault context for a question to a token budget. |
| `obsidian_frontmatter_get` | read | always | Read parsed YAML frontmatter (full object or single key). |
| `obsidian_frontmatter_search` | read | always | Find notes where `frontmatter.<key>` matches `equals` / `exists` / `contains`. |

### Read tools — opt-in (diagnostic / index-gated)

| Tool | Kind | Gating | Summary |
|---|---|---|---|
| `obsidian_full_text_search` | read | `--persistent-index` (+ `--diagnostic-search-tools`) | BM25-ranked search over a SQLite FTS5 inverted index. |
| `obsidian_search_text` | read | `--diagnostic-search-tools` | Case-insensitive token search (AND / OR / phrase modes). |
| `obsidian_semantic_search` | read | `--diagnostic-search-tools` | Pure-JS TF-IDF cosine retrieval (no model download). |
| `obsidian_embeddings_search` | read | `--diagnostic-search-tools` | ML-embedding retrieval via `@huggingface/transformers` (persistent vector index). |

### Write tools — opt-in (`--enable-write`)

| Tool | Kind | Gating | Summary |
|---|---|---|---|
| `obsidian_create_note` | write | `--enable-write` | Create a new note (refuses to overwrite unless `overwrite=true`). |
| `obsidian_append_to_note` | write | `--enable-write` | Append a markdown block to the end of an existing note. |
| `obsidian_rename_note` | write | `--enable-write` | Atomically rename a note AND rewrite every `[[wikilink]]` / `![[embed]]` pointing at it (code-fence-aware). |
| `obsidian_replace_in_notes` | write | `--enable-write` | Bulk find/replace across notes outside fenced code blocks. |
| `obsidian_archive_note` | write | `--enable-write` | Move a note into `Archive/` and rewrite backlinks (`rename_note` wrapper). |
| `obsidian_chat_thread_append` | write | `--enable-write` | Append a user/assistant/system message to a note's `## Chat: <title>` block. |
| `obsidian_frontmatter_set` | write | `--enable-write` | Set or unset frontmatter keys atomically (pass `null` to delete). |

## CLI flags

| Flag                   | Default | Notes                                      |
|------------------------|---------|--------------------------------------------|
| `--vault <path>`       | (required) | Path to the Obsidian vault root.        |
| `--enable-write`       | off     | Register the seven write tools.            |
| `--max-file-bytes <n>` | 5 MB    | Max size for any single file read/write.   |
| `--cache-size <n>`     | 1024    | LRU cap for parsed-note cache.             |
| `--persistent-cache`   | off     | Persist parsed-note cache to disk so cold starts skip re-parsing. **Stores full note bodies — see [Cache & privacy](../README.md#cache--privacy).** |
| `--cache-file <path>`  | auto    | Override the persistent-cache file location. Default: `~/Library/Caches/enquire/<vault-hash>.json` (macOS) or `~/.cache/enquire/<vault-hash>.json` (Linux). |
| `--persistent-index`   | off     | Maintain a SQLite FTS5 inverted index for sub-100ms BM25-ranked search. Registers the `obsidian://chunk/{n}/{path}` resource; also registers `obsidian_full_text_search` **when combined with `--diagnostic-search-tools`** (since v3.5.9). **Stores chunked note content + tag list + wikilink targets — see [SECURITY.md "Persistent FTS5 index"](../SECURITY.md#persistent-fts5-index-privacy-posture).** |
| `--tokenize <mode>`    | `unicode61` | FTS5 tokenize mode. `unicode61` (default; Latin/Cyrillic, removes diacritics) or `trigram` (CJK / mixed-script, ~2x index size). Changing this triggers an automatic index rebuild. |
| `--index-file <path>`  | auto    | Override the FTS5 index file location. Default: `~/Library/Caches/enquire/<vault-hash>.fts5.db` (macOS) or `~/.cache/enquire/<vault-hash>.fts5.db` (Linux). |
| `--exclude-glob <pattern...>` | none | Repeatable glob pattern(s) — paths matching any pattern are invisible to every tool and refuse direct reads. Privacy filter (denylist). Supports `*` (within-segment), `**` (cross-segment), `?` (single char). Example: `--exclude-glob '02_Personal/**' '*.private.md'`. |
| `--read-paths <pattern...>` | none | **Strict allowlist** — when set, ONLY paths matching one of these glob patterns are visible. Complement to `--exclude-glob`. If both are set: a path must match an allow-glob AND not match any exclude-glob. Same glob semantics. Repeatable. Example: `--read-paths '01_Projects/**' '99_Daily/**'`. |
| `--disabled-tools <name...>` | none | Skip registration of specific tools by exact name (matches `tools/list`). Repeatable. Useful for narrow-surface agents. Example: `--disabled-tools obsidian_dataview_query obsidian_full_text_search`. |
| `--enabled-tools <name...>` | none | **Strict allowlist** — when set, ONLY listed tools register. Complement to `--disabled-tools`. If both are set: a tool must be in allowlist AND not in denylist. Repeatable. Example: `--enabled-tools obsidian_search_text obsidian_read_note obsidian_get_recent_edits`. |
| `--watch`              | off     | Watch the vault for `.md` add/change/unlink events. On change: invalidate the parsed-note cache for that file; if `--persistent-index` is also enabled, incrementally re-sync just that file's FTS5 chunks. Editor saves are debounced via chokidar's `awaitWriteFinish`. `--exclude-glob` patterns are honored — edits to excluded paths don't fire. Off by default; opt in for long-running servers. |

## Subcommands

| Subcommand | Args | What it does |
|---|---|---|
| `serve` (default) | see flags above | Start the MCP server over stdio. |
| `serve-http` (v2.6.0) | `--vault <path>` `--bearer-token <token>` (or `--bearer-token-env <name>`) `[--port <n>]` `[--host <host>]` `[--mcp-path <path>]` `[--rate-limit <n>]` `[--cors-origin <origin...>]` `[--health-path <path>]` plus all `serve` flags | Start the MCP server over HTTP (Streamable HTTP transport). Required for remote-MCP use with claude.ai web, ChatGPT, Cursor HTTP mode, mobile clients. Bearer auth + per-token rate-limit + CORS allowlist. Default bind `127.0.0.1:3000` — front with Tailscale Funnel / Cloudflare Tunnel for remote access. See [`docs/http-transport.md`](http-transport.md). |
| `gen-token` (v2.6.0) | none | Print a fresh 32-byte base64url bearer token suitable for `serve-http --bearer-token`. |
| `doctor` (v2.11.0) | `--vault <path>` `[--json]` | Read-only health check: verifies vault path, optional deps (better-sqlite3 / transformers / pdfjs / tesseract / canvas), embedding model cache, FTS5 index, and embed-db. Color-coded ✓ / ⚠ / ✗ output. Returns 0 if everything is ready for full hybrid retrieval, 1 if any critical piece is missing. Pass `--json` for machine-readable output. |
| `setup` (v2.11.0) | `--vault <path>` `[--embedding-model <alias>]` `[--include-pdfs]` `[--skip-embeddings]` | Zero-touch onboarding — runs `install-model` + `index` + `build-embeddings` in sequence so a fresh vault is fully indexed for hybrid retrieval (BM25 + TF-IDF + ML embeddings) in a single command. Idempotent. |
| `eval` (v2.12.0) | `--vault <path>` `--queries <jsonl>` `[--k <n>]` `[--matrix]` `[--reranker]` `[--persistent-index]` `[--per-query]` `[--json]` | Built-in retrieval-quality benchmark harness. Reads a JSONL file of queries with known-relevant doc paths (`{query, relevant: ["path1", ...], id?}`), runs `obsidian_search` for each, computes NDCG@K + Recall@K + MRR + per-query latency. Pretty table by default; `--json` for machine output. `--matrix` runs a 2x2 (graph_boost ± reranker) comparison side-by-side for systematic tuning. The only Obsidian-MCP with built-in retrieval evaluation. |

**v2.13.0 — `serve` / `serve-http` flags:** `--use-hnsw` builds an in-memory HNSW vector index on serve start (sub-10ms top-K queries vs O(n) brute-force). `--hnsw-ef <n>` tunes search-time accuracy (default 100). Requires the `hnswlib-node` optionalDependency. See changelog for details.

**v2.14.0 — `serve-http` stateful sessions:** `--stateful` enables Mcp-Session-Id keyed session reuse + SSE GET handler + DELETE termination. `--max-sessions <n>` (default 100) caps concurrent sessions. `--session-idle-timeout-ms <n>` (default 1800000 = 30 min) sweeps idle sessions. Required for ChatGPT custom GPT actions. Off by default — stateless minimizes attack surface.

**v2.15.0 — late-chunking-style context-windowed embeddings:** `--late-chunk-context <chars>` on `serve` and `build-embeddings`. When > 0, prepends doc title + heading breadcrumb + neighbor-chunk tails of N chars to embedding text. Typical +2-5 NDCG@10 retrieval boost at zero new dep cost. Default 0 (off; matches v2.1.0+ breadcrumb-only behavior). Word-boundary-trimmed at neighbor slices.

**v2.16.0 — HNSW persistence:** when `--use-hnsw` is passed, the index is now persisted to a sidecar `.hnsw.bin` + `.hnsw.meta.json` next to `.embed.db` after the first build. Subsequent serve starts load the persisted index in ~50ms (vs ~25s rebuild for 50K chunks) when the embed-db signature matches; rebuild happens automatically on signature mismatch. Pass `--no-hnsw-persist` to disable.

**v2.17.0 — int8 vector quantization:** `--quantize-embeddings <mode>` on `serve`, `serve-http`, `build-embeddings`, and `setup`. Default `f32` is bit-identical to v2.16- behavior. `int8` cuts the embed-db size ~4× via per-vector asymmetric scalar quantization (vMin + scale Float32 tuple + dim×int8 bytes) at ≈1-2% recall@10 cost. Mode is per-database; switching modes triggers a full rebuild via the meta-table contamination guard. Must match between `build-embeddings` and `serve` invocations. Aliases: `f32`/`float32`/`none` and `int8`/`i8`/`q8`.
| `clear-cache` | `--vault <path>` `[--cache-file <path>]` | Delete the persistent-cache file for the given vault. Useful for purging stale or sensitive content. Returns 0 even if no cache file exists. |
| `clear-index` | `--vault <path>` `[--index-file <path>]` | Delete the FTS5 search-index files (`.fts5.db` + WAL/SHM sidecar) for the given vault. Privacy purge for `--persistent-index` users. Returns 0 even if no files exist. |
| `index` | `--vault <path>` `[--tokenize <mode>]` `[--index-file <path>]` | Cold-build (or refresh) the FTS5 search index for a vault. Useful before first `--persistent-index serve`. Reports `added`/`updated`/`deleted`/`unchanged` chunk counts. |
| `install-model` (v2.0+) | `[alias]` (default `multilingual`) | Pre-download an embedding model so the first MCP call doesn't block on a ~120MB HuggingFace download. Aliases: `multilingual` (Xenova/paraphrase-multilingual-MiniLM-L12-v2, 384-dim, 50+ languages, ~120MB) or `bge` (Xenova/bge-small-en-v1.5, 384-dim, English-only, ~33MB). Models cached under `~/.cache/huggingface/transformers.js/` and reused across vaults. Idempotent. |
| `build-embeddings` (v2.0+) | `--vault <path>` `[--embedding-model <alias>]` `[--embed-file <path>]` `[--exclude-glob <pattern...>]` `[--read-paths <pattern...>]` `[--late-chunk-context <chars>]` `[--quantize-embeddings <mode>]` | Cold-build (or refresh) the persistent embedding index for a vault. Required before `obsidian_embeddings_search` and `obsidian_search` (in hybrid mode) are useful. Same paragraph-level chunking as the FTS5 index — chunk identity matches across BM25 and embeddings. Incremental rebuilds via `source_state` mtime tracking. Reports `added`/`updated`/`deleted`/`unchanged` chunk counts. v2.15.0 `--late-chunk-context <chars>` prepends doc title + breadcrumb + neighbor-chunk tails of N chars before embedding (typical 100-200 for +2-5 NDCG@10). v2.17.0 `--quantize-embeddings <mode>` (`f32` default, `int8` for ~4× smaller BLOBs at ≈1-2% recall cost; mode change triggers a full rebuild). |
| `clear-embeddings` (v2.0+) | `--vault <path>` `[--embed-file <path>]` | Delete the embedding-index files (`.embed.db` + WAL/SHM sidecar). Idempotent. |

## Read tools (always registered)

## `obsidian_list_notes`

List markdown notes in the vault. Filter by tag, folder, or modification date.

| Argument     | Type                  | Notes                                              |
|--------------|-----------------------|----------------------------------------------------|
| `tag`        | `string?`             | With or without leading `#`. Case-insensitive.     |
| `folder`     | `string?`             | Subfolder relative to vault root.                  |
| `since_date` | `string?`             | ISO 8601 (`YYYY-MM-DD`). mtime ≥ this date.        |
| `limit`      | `number?` (≤ 500)     | Default 50.                                        |

**Returns:** `Array<{ title, path, frontmatter, tags, mtime }>`, newest-first.

## `obsidian_read_note`

Read a single note. Provide either `path` or `title`.

| Argument | Type      | Notes                                                  |
|----------|-----------|--------------------------------------------------------|
| `path`   | `string?` | Vault-relative path, with or without `.md`.            |
| `title`  | `string?` | Filename without extension. Case-insensitive lookup.   |

**Returns:** `{ path, title, content, frontmatter, wikilinks, embeds, tags, mtime }`. `content` is the body with frontmatter stripped. `wikilinks` and `embeds` share the same shape (`{ raw, target, section?, block?, alias? }`) and are surfaced separately.

### Periodic-note aliases (v1.10 plugin-aware)

`title` accepts the periodic aliases `today` / `daily` / `weekly` / `monthly` / `quarterly` / `yearly`. Resolution order:

1. **Literal title match** — if you have a real file called `Today.md`, that one wins (no surprise alias hijacking).
2. **User's plugin config** — `obsidian_read_note` reads `.obsidian/daily-notes.json` (Daily Notes core plugin) and `.obsidian/plugins/periodic-notes/data.json` (Periodic Notes community plugin) at first call, caches them for the session. The user's `format` (Moment.js pattern) and `folder` are honored exactly. Periodic Notes kinds with `enabled: false` are skipped (fall back to default).
3. **Legacy default formats** — `YYYY-MM-DD` / `YYYY-[W]ww` / `YYYY-MM` / `YYYY-[Q]Q` / `YYYY` at vault root. Matches what enquire shipped pre-1.10.

The Moment.js format converter supports the tokens periodic-note configs actually use: `YYYY` / `YY` / `MMMM` / `MMM` / `MM` / `M` / `Mo` / `Do` / `DD` / `D` / `dddd` / `ddd` / `WW` / `ww` / `Wo` / `wo` / `gggg` / `GGGG` / `Q` / `QQ` / `H` / `HH` / `h` / `hh` / `m` / `mm` / `s` / `ss` / `A` / `a` and bracket-escaped literals (`[W]`, `[Q]`, `[The year is]`).

## `obsidian_resolve_wikilink`

Resolve an Obsidian `[[wikilink]]` to a vault file. Handles aliases (`Note|alias`), section refs (`Note#Heading`), block refs (`Note^abc`), and relative paths (`../Folder/Note`) when `from_note` is supplied.

| Argument          | Type       | Notes                                                    |
|-------------------|------------|----------------------------------------------------------|
| `wikilink`        | `string`   | The target inside `[[ ]]` (brackets optional).           |
| `from_note`       | `string?`  | Calling note path. Used to disambiguate same-name files and to anchor relative paths. |
| `include_content` | `boolean?` | Default `true`. Set `false` to skip reading the target.  |

**Returns:** `{ found, path, title, content, section, block, alias }`. `found=false` when no match.

## `obsidian_search_text`

Case-insensitive token search across the vault. Default mode tokenizes the query on whitespace and requires every token to appear (AND); other modes available.

| Argument | Type                              | Notes                                                     |
|----------|-----------------------------------|-----------------------------------------------------------|
| `query`  | `string`                          | Required. At least one non-space char.                    |
| `folder` | `string?`                         | Restrict to a subfolder.                                  |
| `limit`  | `number?` (≤ 200)                 | Default 25.                                               |
| `mode`   | `"all" \| "any" \| "phrase"`     | Default `"all"`. `"any"` = OR. `"phrase"` = pre-v0.9 contiguous-substring match. |

**Returns:**

```ts
{
  query: string;        // echoed back
  mode: "all" | "any" | "phrase";
  scanned_notes: number; // how many notes were searched
  matches: Array<{
    path: string;
    snippet: string;     // ~120 chars around first hit
    score: number;       // total token-hit count
    line: number;        // 1-based line of first hit
    matched_terms: string[]; // which tokens actually hit
  }>;
}
```

`scanned_notes` lets the caller distinguish "0 matches in 245 notes" (real null result) from "search did nothing" (broken setup).

## `obsidian_get_recent_edits`

List notes by modification time, newest-first. Useful for "what was I working on?" queries.

| Argument        | Type              | Notes                                         |
|-----------------|-------------------|-----------------------------------------------|
| `since_minutes` | `number?`         | Only include notes edited within this window. |
| `folder`        | `string?`         | Restrict to a subfolder.                      |
| `limit`         | `number?` (≤ 200) | Default 20.                                   |

**Returns:** `Array<{ title, path, frontmatter, tags, mtime }>`.

## `obsidian_get_backlinks`

List every note that links (or embeds) the target note. Ranked by hit count.

| Argument         | Type       | Notes                                                       |
|------------------|------------|-------------------------------------------------------------|
| `path`           | `string?`  | Target note path, vault-relative.                           |
| `title`          | `string?`  | Target note title (filename without `.md`).                 |
| `include_embeds` | `boolean?` | Default `true`. Set `false` to ignore `![[…]]` references.  |
| `limit`          | `number?`  | Max results (default 50, ≤ 500).                            |

**Returns:** `Array<{ path, title, count, snippets, link_kind }>`. `link_kind` is `"wikilink"`, `"embed"`, or `"mixed"`. `snippets` are up to two ~120-char excerpts around the literal `[[…]]` / `![[…]]`.

## `obsidian_list_tags`

Enumerate every unique tag used in the vault with usage counts.

| Argument    | Type      | Notes                                      |
|-------------|-----------|--------------------------------------------|
| `folder`    | `string?` | Restrict to a subfolder.                   |
| `min_count` | `number?` | Drop tags used fewer than this (default 1).|
| `limit`     | `number?` | Max results (default 200, ≤ 2000).         |

**Returns:** `Array<{ tag, count, frontmatter_count, inline_count }>`, sorted by `count` desc.

> **Counting rules.** Each note contributes at most `+1` to a tag's `count` even if the tag appears in both the note's frontmatter and inline body. The note is credited to `frontmatter_count` if the tag was found in frontmatter, otherwise to `inline_count`. So `frontmatter_count + inline_count == count` for every tag.

## `obsidian_get_unresolved_wikilinks`

Find every `[[wikilink]]` (and `![[embed]]`) in the vault whose target does not resolve to a real file. Vault-hygiene utility — broken links, typos, intended-but-not-yet-created notes.

| Argument         | Type       | Notes                                                       |
|------------------|------------|-------------------------------------------------------------|
| `folder`         | `string?`  | Restrict the scan to a subfolder.                           |
| `include_embeds` | `boolean?` | Include `![[…]]` embeds (default `true`).                   |
| `limit`          | `number?`  | Max results (default 200, ≤ 2000).                          |

**Returns:** `Array<{ from_path, target, raw, kind, alias, section, block, line, snippet }>`. `kind` is `"wikilink"` or `"embed"`. `snippet` is a ~120-char window around the literal `[[…]]` / `![[…]]`.

## `obsidian_get_outbound_links`

Symmetric counterpart to `obsidian_get_backlinks`. For one note, list every outbound link (wikilink or embed) and its resolution status.

| Argument             | Type       | Notes                                                        |
|----------------------|------------|--------------------------------------------------------------|
| `path`               | `string?`  | Source note path; provide either this or `title`.            |
| `title`              | `string?`  | Source note title (filename without `.md`).                  |
| `include_embeds`     | `boolean?` | Include `![[…]]` embeds (default `true`).                    |
| `include_unresolved` | `boolean?` | Include links that don't resolve (default `true`).           |

**Returns:** `{ from_path, from_title, links: Array<{ raw, target, kind, alias, section, block, resolved_path, resolved_title }> }`. `resolved_path` and `resolved_title` are `null` when the link doesn't resolve.

## `obsidian_dataview_query`

Run a minimal Dataview-style query. Phase-2 minimal — designed to cover the common shape, not to replicate the Obsidian Dataview plugin.

| Argument | Type     | Notes                              |
|----------|----------|------------------------------------|
| `query`  | `string` | The DQL string. See grammar below. |

### Grammar (subset)

```
QUERY    ::= ("LIST" | "TABLE" COLUMNS) ("FROM" SOURCE)? WHERE? SORT? LIMIT?
COLUMNS  ::= IDENT ("," IDENT)*
SOURCE   ::= "\"" PATH "\""    -- folder
           | "#" TAG           -- tag
WHERE    ::= "WHERE" CONJ ("OR" CONJ)*
CONJ     ::= PRED ("AND" PRED)*
PRED     ::= IDENT OP VALUE
OP       ::= "=" | "!=" | "contains" | "like"
VALUE    ::= "\"" STRING "\"" | NUMBER | "true" | "false" | "null" | BARE
SORT     ::= "SORT" IDENT ("ASC" | "DESC")?
LIMIT    ::= "LIMIT" INTEGER
```

`OR` has lower precedence than `AND` — `WHERE a = 1 AND b = 2 OR c = 3` parses as `(a = 1 AND b = 2) OR (c = 3)`. Use parentheses-style alternatives in the future once we add them; for now you can express any DNF directly.

`like` is a SQL-LIKE-style wildcard match (case-insensitive). `*` matches any run of characters; `\*` is a literal asterisk. Examples: `file.name like "draft*"`, `status like "in*progress"`.

### Special fields

| Field         | Meaning                                       |
|---------------|-----------------------------------------------|
| `file.name`   | Filename without `.md`.                       |
| `file.path`   | Vault-relative path.                          |
| `file.mtime`  | ISO 8601 modification timestamp.              |
| `file.tags`   | Combined frontmatter + inline tags (array).   |
| any other     | Reads the matching frontmatter field.         |

`contains` on an array field tests membership; on a string field, substring match (case-insensitive).

**Returns:** `{ query, rows: Array<Record<string, unknown>> }`. Every row always carries `file.path`, `file.name`, `file.mtime`. `TABLE` rows additionally carry the requested columns.

### Examples

```
LIST FROM "01_Projects"
LIST FROM #idea WHERE status = "active"
TABLE status, priority FROM "01_Projects" WHERE done = false SORT priority ASC LIMIT 10
LIST FROM #people WHERE file.tags contains "core-team"
```

### Not supported (yet)

- Expressions / arithmetic / function calls (`length(...)`, `regexmatch(...)`, etc.)
- `FLATTEN`, `GROUP BY`, joins, embedded queries
- `SOURCE` combinations beyond a single folder or single tag (no `FROM "a" OR #b`)
- Parentheses for explicit precedence in `WHERE`

### Row caps

If the query has no explicit `LIMIT`, results are capped at **1000 rows** by default to prevent runaway responses on large vaults. Use `LIMIT n` (any positive integer) to override.

## `obsidian_validate_note_proposal`

Anti-slop write linter. Lint a draft note **before** writing — parses YAML, resolves every `[[wikilink]]` against the live vault, pre-classifies every tag (existing vs new), and checks path/title collisions. Always available — does **not** require `--enable-write`. Recommended workflow: validate → fix → `obsidian_create_note`.

| Argument  | Type                                       | Notes                                                                |
|-----------|--------------------------------------------|----------------------------------------------------------------------|
| `path`    | `string`                                   | Vault-relative path the LLM intends to write to.                     |
| `content` | `string`                                   | Full proposed markdown content (frontmatter + body).                 |
| `mode`    | `"create" \| "overwrite" \| "append"`     | Default `"create"`. Affects how a path collision is reported.        |

**Returns:** `{ ok, proposed_path, mode, errors[], warnings[], yaml: { parsed, error, keys[] }, wikilinks[], tags[], collision }`. `errors[]` is blocking; `warnings[]` is informational. Each wikilink is tagged `resolved`/`broken`/`ambiguous` with `did-you-mean` suggestions; each tag is tagged `existing` or `new`.

## `obsidian_find_similar`

Lexical-hybrid similarity ranking. Given a note, returns up to N other notes scored by:

| Signal           | Weight | Definition                                                            |
|------------------|--------|-----------------------------------------------------------------------|
| `tag_jaccard`    | 3.0    | Jaccard over case-folded tag set.                                     |
| `title_3gram`    | 1.5    | Character 3-gram Jaccard over basenames.                              |
| `shared_outbound`| 2.0    | Fraction of source's resolved outbound links also present in candidate's. |
| `co_backlink`    | 2.0    | Jaccard over the set of notes that link to source AND to candidate.   |

| Argument    | Type                  | Notes                                                |
|-------------|-----------------------|------------------------------------------------------|
| `path`      | `string?`             | Vault-relative path of the source note.              |
| `title`     | `string?`             | Source note title (alternative to `path`).           |
| `limit`     | `number?` (≤ 50)      | Default 10.                                          |
| `min_score` | `number?` (0 – 10)    | Default 0.05. Drops hits below this raw score.       |

**Returns:** `Array<{ path, title, score, signals: { tag_jaccard, title_3gram, shared_outbound, co_backlink }, shared_tags, mtime }>`, ranked descending by score.

## `obsidian_get_note_neighbors`

Returns a note + its 1-hop graph neighborhood: outbound links + backlinks + tag-cluster siblings (notes sharing ≥1 tag, excluding outbound/inbound). Replaces a `read_note → backlinks → outbound → resolve_wikilink` chain with one round-trip.

| Argument          | Type                | Notes                                              |
|-------------------|---------------------|----------------------------------------------------|
| `path`            | `string?`           | Vault-relative path of the center note.            |
| `title`           | `string?`           | Center note title (alternative to `path`).        |
| `max_per_bucket`  | `number?` (≤ 100)   | Cap per bucket (outbound / inbound / tag_siblings). Default 20. |

**Returns:** `{ center: { path, title, tags, mtime }, outbound: [{ path, title, tags }], inbound: [{ path, title, tags, count }], tag_siblings: [{ path, title, shared_tags }] }`.

## `obsidian_stats`

Vault dashboard. One-shot orientation call — useful as the first call in a session so the agent has structural context before issuing targeted reads.

| Argument   | Type                | Notes                                  |
|------------|---------------------|----------------------------------------|
| `top_tags` | `number?` (≤ 50)    | Number of top tags to return. Default 10. |

**Returns:** `{ total_notes, total_size_bytes, avg_note_words, recently_modified_7d, orphans, broken_wikilinks, total_tags, top_tags: [{ tag, count }], notes_with_frontmatter, generated_at }`. `orphans` = notes with no inbound *and* no outbound wikilinks.

## `obsidian_lint_wiki`

Karpathy LLM-Wiki lint workflow ([gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)). Returns five buckets of findings in one call: orphans, broken wikilinks, stub pages, stale notes, and concept candidates (capitalised phrases mentioned by ≥ K notes that lack their own page). Each finding ships with `path` + `message` + `suggestion` so the agent can fix via existing tools (`validate_note_proposal` → `create_note` / `append_to_note` / `rename_note`).

| Argument                | Type              | Notes                                                                           |
|-------------------------|-------------------|---------------------------------------------------------------------------------|
| `folder`                | `string?`         | Restrict to a subfolder. Default: whole vault.                                  |
| `stub_word_threshold`   | `number?` (≤ 10000) | Notes shorter than this are flagged as stubs. Default 100.                    |
| `stale_days`            | `number?` (≤ 36500) | Notes not touched for this many days are flagged as stale. Default 365.       |
| `concept_min_mentions`  | `number?` (≤ 100) | A capitalised phrase mentioned by ≥ N distinct notes without a page is a candidate. Default 3. |
| `max_per_bucket`        | `number?` (≤ 500) | Cap per finding bucket. Default 50.                                             |

**Returns:** `{ scope, scanned, generated_at, summary: { orphans, broken_links, stubs, stale, concept_candidates }, findings: { orphans[], broken_links[], stubs[], stale[], concept_candidates[] } }`. Each finding: `{ kind, path?, message, suggestion?, details? }`.

The `stale` pass uses frontmatter `last_reviewed` (or `last-reviewed`) when present — Date / ISO string / numeric epoch all accepted. Falls back to mtime when the field is missing.

## `obsidian_open_questions`

Walks every note for deferred-thinking markers — `Open question:` / `Q:` / `TODO?` / `??` (with optional list-bullet, blockquote, or heading prefix). Returns each hit with source path, the heading it lives under, line number, and age in days, sorted oldest-first. Common research-PKM pattern (Karpathy, Eleanor Konik, academic Zettelkasten).

| Argument  | Type             | Notes                                                                          |
|-----------|------------------|--------------------------------------------------------------------------------|
| `folder`  | `string?`        | Restrict to a subfolder.                                                       |
| `limit`   | `number?` (≤ 500)| Max questions to return. Default 100.                                          |
| `pattern` | `string?`        | Override the default regex (case-insensitive). Default matches the markers above at line start with optional list/quote/heading prefix. |

**Returns:** `Array<{ question, source_path, source_title, context_heading, line, age_days, mtime }>`, sorted oldest-first.

## `obsidian_paper_audit`

For each note tagged `#paper` (configurable), verify frontmatter has at least one citable identifier (`arxiv` / `doi` / `url` / `isbn`). Also flag notes whose body contains an arxiv ID (e.g. `arxiv:2401.12345`) or DOI but doesn't carry the same identifier in frontmatter — common after quick-capture from a chat.

| Argument | Type             | Notes                                                            |
|----------|------------------|------------------------------------------------------------------|
| `tag`    | `string?`        | Tag identifying paper notes. Default `paper`. Leading `#` optional. |
| `folder` | `string?`        | Restrict to a subfolder.                                         |
| `limit`  | `number?` (≤ 500)| Max flagged notes. Default 100.                                  |

**Returns:** `{ scanned, flagged: Array<{ path, title, has_frontmatter_citation, found_in_body: { arxiv[], doi[], url[] }, proposed_frontmatter_patch, message }> }`. The `proposed_frontmatter_patch` is a `{key: value}` object the agent can pass to `validate_note_proposal` and then `append_to_note` (or rewrite the YAML block).

## `obsidian_find_path`

Multi-hop graph traversal. BFS from `from` to `to` over the wikilink graph, returning the shortest path (sequence of notes connected by wikilinks) up to `max_depth` hops. Each step in the returned `path` carries the `via` wikilink text used to traverse to it. With `include_alternatives=true`, returns up to 10 same-length paths so the agent can pick the most semantically-coherent one.

| Argument               | Type             | Notes                                                                |
|------------------------|------------------|----------------------------------------------------------------------|
| `from`                 | `string?`        | Vault-relative path of the source note.                              |
| `from_title`           | `string?`        | Source title (alternative to `from`).                                |
| `to`                   | `string?`        | Vault-relative path of the destination note.                         |
| `to_title`             | `string?`        | Destination title (alternative to `to`).                             |
| `max_depth`            | `number?` (≤ 10) | Maximum BFS depth. Default 5. Each hop = one wikilink edge.          |
| `include_alternatives` | `boolean?`       | Return up to 10 same-length alternative paths. Default `false`.      |
| `follow_embeds`        | `boolean?`       | Treat `![[embeds]]` as graph edges. Default `true`.                  |

**Returns:** `{ from, to, found, path: [{ path, title, via }], hops, alternatives? }`. `via` is the wikilink raw text used at each step (empty on the source). Returns `found: false`, `hops: -1`, `path: []` when no route exists within `max_depth`. `from === to` returns `hops: 0` + the source-only path.

## `obsidian_open_in_ui`

Returns an `obsidian://open?vault=<v>&file=<f>` URI for hand-off to the running Obsidian desktop app. No filesystem or network side effect — the URI emission lets the agent say "open this in Obsidian" without enquire-mcp coordinating with the running app.

| Argument   | Type       | Notes                                                                  |
|------------|------------|------------------------------------------------------------------------|
| `path`     | `string?`  | Vault-relative path of the note.                                       |
| `title`    | `string?`  | Title (alternative to `path`).                                         |
| `new_pane` | `boolean?` | Append `&newpane=true` so Obsidian opens the note in a split. Default `false`. |

**Returns:** `{ uri, vault_name, path, title }`. The `vault_name` is the leaf folder of the vault root path; Obsidian matches on this OR on the absolute file path, so the URI works even if the user's Obsidian instance opened the vault under a different name.

## `obsidian_list_canvases`

Lists `.canvas` files (Obsidian's whiteboard format — JSON nodes + edges) in the vault, with each canvas's node and edge counts. Honors `--exclude-glob` and `--read-paths`. Use this to discover which canvases exist before calling `obsidian_read_canvas`.

| Argument | Type             | Notes                                       |
|----------|------------------|---------------------------------------------|
| `folder` | `string?`        | Restrict the listing to a subfolder.        |
| `limit`  | `number?` (≤ 500)| Max canvases to return. Default 100.        |

**Returns:** `Array<{ path, name, size_bytes, mtime, node_count, edge_count }>`, sorted newest-first.

## `obsidian_read_canvas`

Parses one `.canvas` file into typed nodes + edges. Each node has a `kind` field — `text` / `file` / `link` / `group` / `unknown` (forward-compat for new Obsidian canvas node types). Each `file` node carries a `file_resolved` field — the vault-relative path the canvas's file reference resolved to (or `null` if broken).

| Argument | Type     | Notes                                                  |
|----------|----------|--------------------------------------------------------|
| `path`   | `string` | Vault-relative path of the `.canvas` file (`.canvas` extension auto-appended). |

**Returns:** `{ path, name, size_bytes, mtime, nodes: CanvasNode[], edges: CanvasEdge[], summary: { text, file, link, group, unknown }, broken_file_refs: string[] }`. Throws on path-traversal, missing file, or invalid JSON.

`CanvasNode` discriminated union by `kind`:
- `{ kind: "text", id, x, y, width, height, text, color? }`
- `{ kind: "file", id, x, y, width, height, file, file_resolved, subpath?, color? }`
- `{ kind: "link", id, x, y, width, height, url, color? }`
- `{ kind: "group", id, x, y, width, height, label?, color? }`
- `{ kind: "unknown", id, raw_type, raw }` — preserves any future canvas node type unchanged.

`CanvasEdge`: `{ id, from_node, from_side?, to_node, to_side?, label?, color? }`.

`broken_file_refs` lists canvas `file:` nodes that didn't resolve to any markdown in the current vault — useful as a vault-hygiene signal alongside `obsidian_get_unresolved_wikilinks`.

## `obsidian_semantic_search`

Pure-JS TF-IDF cosine retrieval. Tokenizes (alphanumeric + hyphen, stop-words filtered, ≥ 2 chars), TF-IDFs, L2-normalizes every note's body once per session, then ranks notes by cosine similarity to the query. Catches synonym + related-term matches that `obsidian_search_text` (substring) and `obsidian_full_text_search` (BM25) miss.

| Argument    | Type             | Notes                                                                          |
|-------------|------------------|--------------------------------------------------------------------------------|
| `query`     | `string`         | Required. Free-form, multi-word, natural language is fine.                     |
| `folder`    | `string?`        | Restrict to a subfolder.                                                       |
| `limit`     | `number?` (≤ 100)| Max hits. Default 10.                                                          |
| `min_score` | `number?` (0–1)  | Drop hits below this cosine score. Default 0.05. Cosine ranges 0–1.            |

**Returns:** `{ query, total_docs, method: "tfidf-cosine", matches: [{ path, title, score, snippet, matched_terms, mtime }] }`. `matched_terms` is sorted highest-IDF first (the most-discriminating terms in the corpus). `snippet` is taken from the first occurrence of the highest-IDF matched term.

**Caching:** the IDF index is built lazily on first call and memoized via `WeakMap` keyed on the `entries` array. Subsequent calls reuse the index when `listMarkdown()` returns the same paths + mtimes; the index rebuilds automatically when the vault changes.

**Performance:** at 10k notes the cold-build is ~5–10s on Apple silicon (similar to FTS5 cold-build). Warm cosine is sub-100ms. For very large vaults, prefer `--persistent-index` + `obsidian_full_text_search` for raw query latency, and use `obsidian_semantic_search` when BM25 misses.

**Why not embeddings?** TF-IDF cosine ships zero new deps, runs offline, and meaningfully improves over BM25 alone for the related-term case. For ML embeddings see `obsidian_embeddings_search` and `obsidian_search` (v2.0+).

## `obsidian_embeddings_search` _(v2.0+ — requires `enquire-mcp install-model` + `enquire-mcp build-embeddings`)_

ML-embedding retrieval via [@huggingface/transformers](https://github.com/huggingface/transformers.js) + `paraphrase-multilingual-MiniLM-L12-v2` (default; 384-dim, 50+ languages, runs on CPU). Persistent SQLite vector index next to the FTS5 db. Brute-force cosine top-K (sub-100ms on 50K chunks; HNSW ladder is v2.1 if real users hit that ceiling).

| Argument           | Type                | Notes                                                                                |
|--------------------|---------------------|--------------------------------------------------------------------------------------|
| `query`            | `string`            | Required. Free-form, multi-word, any supported language.                              |
| `folder`           | `string?`           | Restrict to a subfolder.                                                              |
| `limit`            | `number?` (≤ 100)   | Max hits. Default 10.                                                                |
| `min_score`        | `number?` (0–1)     | Drop hits below this cosine score. Default 0.3. Embeddings cluster ~0.4–0.9.          |

**Returns:** `{ query, method: "embeddings-cosine", model, total_chunks, matches: [{ path, title, score, snippet, chunk_index, line_start, line_end }] }`.

**Setup (one-time):**
```bash
enquire-mcp install-model multilingual          # ~120MB, cached globally
enquire-mcp build-embeddings --vault <path>     # ~5-30ms per chunk (CPU)
```

If the index is missing, the tool returns a clean error pointing at `enquire-mcp build-embeddings` — it does NOT silently kick off a model download at MCP-call time.

**Caveat — token truncation.** The default multilingual model truncates at 128 tokens. The FTS5 chunker produces ~600-1000-token chunks, so the tail of long paragraphs is not embedded. Use the `bge` model (512-token limit) for longer-context English content, or split notes into shorter paragraphs.

## `obsidian_search` _(v2.0+ — the default search tool)_

**Hybrid retrieval via Reciprocal Rank Fusion (Cormack et al, 2009).** Auto-detects every available retrieval signal — BM25 via FTS5, TF-IDF cosine, ML embeddings — and fuses them with RRF (k=60, equal weights). Gracefully degrades with whatever signals are available:

| Signals available | Fusion behavior |
|---|---|
| TF-IDF only (zero setup) | TF-IDF-style ranking |
| BM25 + TF-IDF (`--persistent-index`) | Keyword-augmented retrieval, sub-100ms |
| BM25 + TF-IDF + embeddings (`+ build-embeddings`) | Full hybrid — matches Smart Connections-quality |

| Argument           | Type                  | Notes                                                                              |
|--------------------|-----------------------|------------------------------------------------------------------------------------|
| `query`            | `string`              | Required. Multi-word natural language is the sweet spot.                            |
| `folder`           | `string?`             | Restrict to a subfolder.                                                            |
| `limit`            | `number?` (≤ 100)     | Max hits. Default 10.                                                              |
| `min_signals`      | `number?` (1–3)       | Filter: only return hits that ranked in at least N rankers. Default 1. Set 2+ for high-precision multi-ranker consensus. |
| `embedding_model`  | `string?`             | Override the embedding model alias (default `multilingual`). Only consulted if a `.embed.db` exists. |

**Returns:** `{ query, method: "rrf", k: 60, signals_used, total_candidates, matches: [{ path, title, score, snippet, chunk_index?, line_start?, line_end?, per_signal: { bm25?, tfidf?, embeddings? } }] }`.

`per_signal` is the observability surface: every hit reports which rankers contributed at what rank/score. Use this to debug retrieval quality and understand WHY a hit ranked.

**Why prefer this over the per-ranker tools?** Single tool surface for agents → consistent recall regardless of vault setup. Per-ranker tools (`obsidian_search_text`, `obsidian_full_text_search`, `obsidian_semantic_search`, `obsidian_embeddings_search`) remain available as diagnostic surfaces for tuning / debugging.

## `obsidian_hyde_search` _(v3.1.0)_

HyDE retrieval (Gao et al 2023). The caller agent generates a 1–3 sentence synthetic answer to its own query (without vault access); the server embeds the **answer** (not the question) and retrieves against the answer-shaped vector. Typically beats raw-query embedding by +2–5 NDCG@10 on under-specified queries. Uses the same `.embed.db` as `obsidian_embeddings_search`. Requires `enquire-mcp build-embeddings` first; if `hypothetical_answer` is empty, falls back to embedding the raw `query`.

| Argument               | Type             | Notes                                                                                  |
|------------------------|------------------|----------------------------------------------------------------------------------------|
| `query`                | `string`         | Required. The original user question; echoed for audit-trail. Does NOT influence retrieval when `hypothetical_answer` is non-empty. |
| `hypothetical_answer`  | `string`         | Required. The 1–3 sentence synthetic answer the agent generates. This is what gets embedded. |
| `folder`               | `string?`        | Restrict to a subfolder.                                                               |
| `limit`                | `number?` (≤ 100)| Max hits. Default 10.                                                                  |
| `min_score`            | `number?` (0–1)  | Drop hits below this cosine score. Default 0.3.                                        |

**Returns:** Same shape as `obsidian_embeddings_search` plus an `applied_hyde: true` echo so the caller can confirm which branch ran.

## `obsidian_context_pack`

Given a question, retrieves top-relevant notes (via `obsidian_search`), gathers backlink summaries + optional recent dailies, deduplicates, packs to a token budget, and returns a single ready-to-paste markdown bundle. Saves ~5 separate tool calls; produces a coherent context blob you can paste into any AI chat.

| Argument            | Type              | Notes                                                                  |
|---------------------|-------------------|------------------------------------------------------------------------|
| `query`             | `string`          | Required. Topic or question to gather context for.                     |
| `budget_tokens`     | `number?` (≤ 32000)| Approximate token budget. Default 4000 (~4 chars/token).              |
| `folder`            | `string?`         | Restrict retrieval to a folder.                                        |
| `include_backlinks` | `boolean?`        | Include 1-line backlink summaries for top-3 notes. Default `true`.     |
| `recent_dailies`    | `number?` (0–30)  | Include the last N daily-format notes (`YYYY-MM-DD` basenames). Default 0. |

**Returns:** `{ query, budget_tokens, included_notes: [{ path, title, reason }], markdown }`. `markdown` is the packed bundle, ready to paste.

## `obsidian_chat_thread_read`

Parse a note's `## Chat: <title>` block into structured messages with role / timestamp / content / line-range. Non-chat content in the same note is ignored.

| Argument    | Type     | Notes                                                |
|-------------|----------|------------------------------------------------------|
| `note_path` | `string` | Required. Vault-relative path to the note hosting the thread. |

**Returns:** `{ note_path, threads: Array<{ title, messages: Array<{ role, content, timestamp?, line_start, line_end }> }> }`.

## `obsidian_frontmatter_get`

Return parsed YAML frontmatter for a note. With `key`, returns just that field's value; without `key`, returns the whole frontmatter object.

| Argument | Type      | Notes                                                |
|----------|-----------|------------------------------------------------------|
| `path`   | `string?` | Vault-relative path.                                 |
| `title`  | `string?` | Note title (filename without `.md`; periodic aliases accepted). |
| `key`    | `string?` | Single key to read; omit for full frontmatter.       |

**Returns:** `{ path, title, frontmatter }` (full mode) or `{ path, title, key, value }` (single-key mode). `value` is `null` when the key is absent.

## `obsidian_frontmatter_search`

Find every note where `frontmatter.<key>` matches a predicate. Useful as a precursor to bulk `frontmatter_set`: *find all notes with `status: draft` and set their status to `published`*. Predicates are exclusive — pass exactly one of `equals` / `exists` / `contains`.

| Argument   | Type               | Notes                                                                |
|------------|--------------------|----------------------------------------------------------------------|
| `key`      | `string`           | Required. Frontmatter key to test.                                   |
| `equals`   | `unknown?`         | Strict equality predicate (`JSON.stringify` comparison).             |
| `exists`   | `boolean?`         | Predicate: key must exist (any value).                               |
| `contains` | `unknown?`         | For array values, value must be a member.                            |
| `folder`   | `string?`          | Restrict search to a folder.                                         |
| `limit`    | `number?` (≤ 1000) | Max matches. Default 100.                                            |

**Returns:** `Array<{ path, title, value, mtime }>`.

## `obsidian_get_communities` _(v3.4.0)_

GraphRAG-light. Builds an undirected wikilink graph and partitions notes into structural communities via greedy modularity optimization (single-phase Louvain). Pure structural — no embeddings, no LLM calls. The agent can summarize a community by reading its `representative` (the highest-in-community-degree note) + a sample of members.

| Argument    | Type             | Notes                                                                 |
|-------------|------------------|-----------------------------------------------------------------------|
| `min_size`  | `number?` (≤ 1000)| Drop communities with fewer than N members. Default 1 (keep singletons). |
| `limit`     | `number?` (≤ 500)| Max communities to return (size-desc sort). Default 50.               |

**Returns:** `{ community_count, modularity, iterations, node_count, communities: [{ id, size, members: string[], representative }], membership: Record<string, number> }`. `modularity` ∈ [-0.5, 1] — higher = stronger structure. NOT cached server-side; call once per session and reuse.

## `obsidian_list_bases` _(v3.2.0)_

Lists `.base` files (Obsidian's structured-query primitive — YAML files defining filters/views over the vault) with each base's view count and view names. Honors `--exclude-glob` and `--read-paths`. Sorted newest-first by mtime.

| Argument | Type             | Notes                                       |
|----------|------------------|---------------------------------------------|
| `folder` | `string?`        | Restrict the listing to a subfolder.        |
| `limit`  | `number?` (≤ 500)| Max bases to return. Default 100.           |

**Returns:** `Array<{ path, name, size_bytes, mtime, view_count, view_names: string[] }>`.

## `obsidian_read_base` _(v3.2.0)_

Parses a `.base` file into structured JSON (filters, formulas, properties, summaries, views). Does NOT execute the query — use `obsidian_query_base` for that. Useful when an agent wants to introspect a base before deciding which view to run.

| Argument | Type     | Notes                                                  |
|----------|----------|--------------------------------------------------------|
| `path`   | `string` | Required. Vault-relative path of the `.base` file (`.base` extension auto-appended). |

**Returns:** `{ path, name, size_bytes, mtime, filters, formulas, properties, summaries, views }`.

## `obsidian_query_base` _(v3.2.0, extended in v3.5.0)_

Runs a `.base` file's filter against the vault's markdown notes, returning matching paths + the frontmatter values that contributed to the match. Supported DSL: `tag == "x"`, `taggedWith(file.file, "x")`, `linksTo(file.file, "Target")` (basename-resolved), `path startsWith / contains "X"`, `file.name == "X"`, `<frontmatter_key> == / != / contains <value>`, plus `and` / `or` / `not`. Anything else (formula evaluation, date arithmetic, summaries) is treated as `true` and surfaced in `unevaluated_predicates`.

| Argument | Type             | Notes                                                                                                       |
|----------|------------------|-------------------------------------------------------------------------------------------------------------|
| `path`   | `string`         | Required. Vault-relative path of the `.base` file.                                                          |
| `view`   | `string?`        | Optional view name; the view's filters are concat'd with the global filter via AND (matching Obsidian semantics). |
| `folder` | `string?`        | Extra folder scope on top of the base's filters.                                                            |
| `limit`  | `number?` (≤ 500)| Max matches to return. Default 50.                                                                          |

**Returns:** `{ path, view, matches: Array<{ path, title, frontmatter_subset }>, unevaluated_predicates: string[] }`. Pair with `obsidian_search` for retrieval-quality search; this tool is for explicit saved queries.

## `obsidian_list_pdfs` _(v2.7.0)_

Lists `.pdf` files in the vault with size + last-modified timestamp. Honors `--exclude-glob` and `--read-paths`. Use as the discovery entry point before calling `obsidian_read_pdf`. Sorted newest-first by mtime.

| Argument | Type             | Notes                                       |
|----------|------------------|---------------------------------------------|
| `folder` | `string?`        | Restrict the listing to a subfolder.        |
| `limit`  | `number?` (≤ 500)| Max PDFs to return. Default 100.            |

**Returns:** `Array<{ path, name, size_bytes, mtime }>`.

## `obsidian_read_pdf` _(v2.7.0)_

Extracts plain text from one PDF, returning per-page text + a `full_text` join + doc-level metadata (title / author / subject / etc). Image-only / scanned PDFs surface `has_text: false` so agents can detect-and-recommend `obsidian_ocr_pdf`. Powered by Mozilla's PDF.js (Apache-2.0).

| Argument           | Type                                | Notes                                                                |
|--------------------|-------------------------------------|----------------------------------------------------------------------|
| `path`             | `string`                            | Required. Vault-relative path of the `.pdf` file.                    |
| `pages`            | `[number, number]?`                 | Optional 1-indexed inclusive page range, e.g. `[2, 5]`.              |
| `include_metadata` | `boolean?`                          | Include doc-level metadata. Default `true`.                          |

**Returns:** `{ path, page_count, pages: Array<{ index, text }>, full_text, has_text, metadata? }`. `has_text: false` indicates an image-only PDF — call `obsidian_ocr_pdf` instead.

## `obsidian_ocr_pdf` _(v2.10.0)_

Runs Tesseract OCR over each page of an image-only / scanned PDF, returning per-page text + per-page confidence + mean confidence + the same shape as `obsidian_read_pdf`. Multilingual via `lang` (default `'eng'`; multi-lang via `'+'`, e.g. `'eng+rus'`). ~1–2s per page on M1 CPU. Powered by Tesseract.js (Apache-2.0; trained-data files download on first use into the local cache, ~10 MB per language) + `@napi-rs/canvas` for PDF→bitmap rendering. Both gated to `optionalDependencies` so the markdown-only path stays zero-cost.

| Argument | Type                                | Notes                                                                                       |
|----------|-------------------------------------|---------------------------------------------------------------------------------------------|
| `path`   | `string`                            | Required. Vault-relative path of the `.pdf` file.                                           |
| `lang`   | `string?`                           | Tesseract language pack(s). Default `'eng'`. Multi-lang via `'+'`: `'eng+rus'`. Common: `'eng'`, `'rus'`, `'jpn'`, `'chi_sim'`, `'fra'`, `'deu'`. |
| `pages`  | `[number, number]?`                 | Optional 1-indexed inclusive page range.                                                    |
| `scale`  | `number?` (0.5–4)                   | Render scale (DPI multiplier). Default 2 (~150 DPI). Higher = better OCR on small text but slower. |

**Returns:** Same shape as `obsidian_read_pdf` plus `{ mean_confidence, pages: Array<{ index, text, confidence }> }`.

## Write tools (opt-in)

All seven write tools are **only registered when the server is started with `--enable-write`**. Without that flag the tools are not advertised to the client at all.

### `obsidian_create_note`

Create a new note at the given vault-relative path.

| Argument      | Type       | Notes                                                         |
|---------------|------------|---------------------------------------------------------------|
| `path`        | `string`   | Vault-relative path; `.md` is appended if missing.            |
| `content`     | `string`   | Markdown body (frontmatter is supplied separately).           |
| `frontmatter` | `object?`  | Flat key/value YAML to render. Arrays render as block lists.  |
| `overwrite`   | `boolean?` | Default `false`. Existing notes are not clobbered without it. |

**Returns:** `{ path, mtime, bytes }`. Throws if the path escapes the vault, the file would exceed `--max-file-bytes`, or the file exists and `overwrite=false`.

### `obsidian_append_to_note`

Append a markdown block to an existing note.

| Argument    | Type       | Notes                                                       |
|-------------|------------|-------------------------------------------------------------|
| `path`      | `string?`  | Path of the target note. Provide either this or `title`.    |
| `title`     | `string?`  | Title (filename without `.md`).                             |
| `content`   | `string`   | Markdown to append.                                         |
| `separator` | `string?`  | Inserted between existing body and new content (default `"\n\n"`). |

**Returns:** `{ path, mtime, appended_bytes }`. Refuses to grow the file past `--max-file-bytes`.

### `obsidian_rename_note`

Atomically rename a note **and** rewrite every `[[wikilink]]` / `![[embed]]` in the rest of the vault that resolves to it. Code-fence-aware: wikilinks inside ` ``` ` / `~~~` blocks are left verbatim. Preserves alias / section / block (`[[Foo|alias]]` → `[[Bar|alias]]`, `[[Foo#section]]` → `[[Bar#section]]`, `[[Foo^block-id]]` → `[[Bar^block-id]]`) and the user's chosen path-qualification convention (bare `[[Foo]]` stays bare; `[[Folder/Foo]]` becomes `[[NewFolder/Foo]]` when the destination directory changes).

| Argument    | Type       | Notes                                                                |
|-------------|------------|----------------------------------------------------------------------|
| `from`      | `string`   | Existing note path (`.md` appended if missing).                      |
| `to`        | `string`   | New path (`.md` appended if missing). Different folder = move.       |
| `dry_run`   | `boolean?` | Preview the rewrite plan without touching disk. Default `false`.     |
| `overwrite` | `boolean?` | Allow overwriting an existing file at `to`. Default `false`.         |

**Returns:** `{ from, to, dry_run, files_updated: [{ path, rewrites, before, after }], total_links_rewritten }`. (`before`/`after` are blank in the response — they're used internally to apply the rewrite atomically.) Throws if `from` is missing, `to` exists without `overwrite`, either path traverses, or `from === to`.

### `obsidian_replace_in_notes`

Bulk find/replace across the vault, code-fence-aware. Walks every note (or a `folder` subset), substitutes every literal occurrence of `search` with `replace` outside fenced code blocks (` ``` ` / `~~~`), and writes each modified file back. Reuses the same line walker rename_note uses, so example snippets and code documentation stay verbatim.

| Argument         | Type       | Notes                                                                  |
|------------------|------------|------------------------------------------------------------------------|
| `search`         | `string`   | Required. Literal substring to find. Empty string is rejected.         |
| `replace`        | `string`   | Replacement text. Empty string means delete every occurrence.          |
| `folder`         | `string?`  | Restrict to a subfolder (vault-relative). Default: whole vault.        |
| `dry_run`        | `boolean?` | Preview the plan without writing. Default `false`.                     |
| `case_sensitive` | `boolean?` | Default `true`. `false` = case-insensitive substring match. Replace text is inserted verbatim. |

**Returns:** `{ search, replace, case_sensitive, dry_run, scope, files_scanned, files_updated: [{ path, occurrences }], total_replacements }`.

**Footgun guards.** Refuses (a) empty `search` and (b) identical `search` and `replace` (no-op). Honors `--exclude-glob` and `--read-paths`: writes to filtered paths fail at the `Vault.writeNote` layer.

**Use cases.** Vocabulary refactor (e.g. `GPT-3.5` → `GPT-4`). Deprecation cleanup (delete every `DEPRECATED ` prefix). Brand rename (case-insensitive `api` → `REST` in prose, while keeping URLs intact via the code-fence skip).

### `obsidian_archive_note`

Convenience wrapper around `obsidian_rename_note` for the common archive workflow. Moves the note's basename into `archive_folder` (default `Archive/`) and rewrites every wikilink/embed pointing at it. All `rename_note` guarantees apply.

| Argument         | Type       | Notes                                                                       |
|------------------|------------|-----------------------------------------------------------------------------|
| `path`           | `string`   | Vault-relative path of the note to archive (with or without `.md`).         |
| `archive_folder` | `string?`  | Destination folder. Default `Archive`. Trailing slash optional.             |
| `dry_run`        | `boolean?` | Preview the rewrite plan without writing. Default `false`.                  |
| `overwrite`      | `boolean?` | Allow overwriting an existing file at the archive destination. Default `false`. |

**Returns:** Same shape as `obsidian_rename_note`: `{ from, to, dry_run, files_updated, total_links_rewritten }`.

**Source-folder stripping.** The source's leading folders are stripped so the basename lands cleanly in the archive — `Inbox/Foo.md` archives to `Archive/Foo.md`, not `Archive/Inbox/Foo.md`. If you want the inbox structure preserved, pass `archive_folder: "Archive/Inbox"` explicitly.

**Bare-vs-qualified backlinks.** Bare wikilinks (`[[Foo]]`) stay bare and continue to resolve via `findBestMatch`'s basename search — they don't need rewriting. Path-qualified wikilinks (`[[Inbox/Foo]]`) are updated to point at the new path.

### `obsidian_chat_thread_append`

Add a user / assistant / system message to a note's `## Chat: <title>` block. Creates the note + heading if absent. Threads are stored as markdown so they're searchable, version-controllable, and survive across sessions / clients. Pair with `obsidian_chat_thread_read` to load past context.

| Argument       | Type                                | Notes                                                                |
|----------------|-------------------------------------|----------------------------------------------------------------------|
| `note_path`    | `string`                            | Required. Vault-relative path to the note hosting the thread.        |
| `role`         | `"user" \| "assistant" \| "system"` | Required. Role of the message being appended.                        |
| `content`      | `string`                            | Required. Message body (markdown allowed).                           |
| `thread_title` | `string?`                           | Optional thread title — used when the note is created from scratch.  |

**Returns:** `{ note_path, thread_title, role, line_start, line_end, appended_bytes }`.

### `obsidian_frontmatter_set`

Surgical YAML manipulation: set one or more frontmatter keys, or remove them by passing `null` as the value. Round-trips through gray-matter (the same parser used at write time) so YAML formatting / quoting / type-coercion stays consistent.

| Argument  | Type                       | Notes                                                                       |
|-----------|----------------------------|-----------------------------------------------------------------------------|
| `path`    | `string?`                  | Vault-relative path.                                                        |
| `title`   | `string?`                  | Note title (filename without `.md`).                                        |
| `set`     | `Record<string, unknown>`  | Required. Keys to set. Pass `null` as value to delete a key (e.g. `{status: "published", draft: null}`). |
| `dry_run` | `boolean?`                 | Preview the diff without writing. Default `false`.                          |

**Returns:** `{ path, before: object, after: object, changed_keys: string[], dry_run }`.

## MCP resources

| URI                          | Type           | Description                                |
|------------------------------|----------------|--------------------------------------------|
| `obsidian://vault/info`      | static JSON    | Root, note count, write flag, byte/cache limits, server version. |
| `obsidian://note/{notePath}` | template (md)  | Each markdown note. `notePath` is the URI-encoded vault-relative path. |

The note template implements `list`, so MCP clients with a resource browser will see the full vault enumerated on connect.

## MCP prompts

| Prompt                  | Args                       | What it sets up                                |
|-------------------------|----------------------------|-----------------------------------------------|
| `summarize_recent_edits`| `since_minutes?`           | Walks recent edits, reads top-3, produces a writeup. |
| `review_tag`            | `tag`                      | Pulls every note for a tag, surfaces open threads. |
| `find_orphans`          | `folder?`                  | Finds notes with zero inbound links — archive candidates. |
| `weekly_review`         | `folder?`                  | Aggregates the last 7 days of edits; groups by tag; surfaces shipped / open / stuck. |
| `monthly_review`        | `folder?`                  | 30-day version: themes, what stalled, focus vs stated intent. Calls `obsidian_stats` first. |
| `lint_wiki`             | `folder?`                  | **Karpathy `/lint`** — orchestrates `obsidian_lint_wiki` + `obsidian_open_questions` + `obsidian_paper_audit`, picks the 5 highest-leverage fixes, proposes concrete `obsidian_*` calls. Read-only. |
| `extract_todos`         | `folder?`, `tag?`          | Greps TODO / FIXME / QUESTION across the vault, groups by note, picks a top-leverage next action. |
| `process_inbox`         | `folder` (required)        | Walks an inbox folder, proposes Move / Merge / Promote / Archive for each note. |
| `consolidate_tags`      | `min_count?`               | Surfaces near-duplicate / inconsistently-cased tags via `obsidian_list_tags` clustering. Proposes canonical merges. Read-only. |
| `find_duplicates`       | `folder?`, `min_score?`    | Walks the vault clustering structurally-similar notes via `obsidian_find_similar`. Outputs merge proposals; never modifies. |

## Path safety

Every path argument is resolved relative to the vault root and rejected if it escapes the root via `..`. The server never reads outside the vault.

## `obsidian_full_text_search` _(opt-in, requires `--persistent-index` AND `--diagnostic-search-tools`)_

BM25-ranked full-text search over a SQLite FTS5 inverted index. Sub-100ms on multi-thousand-note vaults. Only registered when the server is started with BOTH `--persistent-index` (FTS5 index lifecycle) AND `--diagnostic-search-tools` (single-ranker surface — the hybrid `obsidian_search` tool is the recommended default); otherwise use `obsidian_search_text`.

| Argument | Type                              | Notes                                                     |
|----------|-----------------------------------|-----------------------------------------------------------|
| `query`  | `string`                          | Required. Whitespace-tokenized; hyphenated tokens (e.g. `claude-telegram`) auto-quoted so FTS5 doesn't interpret `-` as `NOT`. |
| `folder` | `string?`                         | Restrict to a subfolder (vault-relative).                  |
| `tag`    | `string?`                         | Exact tag membership (e.g. `"project"`). Frontmatter + inline tags. No leading `#`. |
| `since`  | `string?`                         | ISO 8601 date or timestamp — restrict to chunks from notes modified on/after this. |
| `limit`  | `number?` (≤ 200)                 | Default 25.                                                |

**Returns:**

```ts
{
  query: string;
  total_chunks: number;
  total_files: number;
  applied_filters: { folder: string|null; tag: string|null; since: string|null };
  matches: Array<{
    rel_path: string;
    chunk_index: number;     // 0-based; address via obsidian://chunk/<index>/<path>
    line_start: number;      // 1-based
    line_end: number;
    snippet: string;         // «…term…» format from FTS5 snippet()
    score: number;           // BM25 relevance, higher = better
  }>;
}
```

**Implementation note:** see [issue #10](https://github.com/oomkapwn/enquire-mcp/issues/10) for the full architecture (production-verified by an external contributor at 1771 chunks / 368 files, 9.8 MB index, 50–100ms BM25 top-10). Local bench against synthetic vault sees 37–103x speedup over the linear-scan path on 100–1000 notes — see [`scripts/bench-search.mjs`](../scripts/bench-search.mjs).

## `obsidian://chunk/{chunkIndex}/{+notePath}` resource _(opt-in, requires `--persistent-index`)_

Chunk-level deep-linking. Construct the URI from `rel_path` + `chunk_index` returned by `obsidian_full_text_search`:

```
obsidian://chunk/0/01_Projects/Apollo.md   → chunk 0 of 01_Projects/Apollo.md
obsidian://chunk/3/notes/long-note.md      → chunk 3 of notes/long-note.md
```

Returns `{rel_path, chunk_index, line_start, line_end, content}` JSON. **`content` is the verbatim original chunk text** — the synthetic FTS5 wikilink-target enrichment used for recall does NOT appear in the response.

## CLI subcommands for the FTS5 index

```bash
# Cold-build or refresh the index (useful before first --persistent-index serve).
enquire-mcp index --vault /path/to/vault [--tokenize unicode61|trigram] [--index-file <path>]

# Then serve with the index loaded.
enquire-mcp serve --vault /path/to/vault --persistent-index

# Remove the index files (.fts5.db + WAL/SHM sidecar) — privacy purge.
enquire-mcp clear-index --vault /path/to/vault [--index-file <path>]
```

The index file lives at `~/Library/Caches/enquire/<vault-hash>.fts5.db` (macOS) or `~/.cache/enquire/<vault-hash>.fts5.db` (Linux) by default. Override with `--index-file <path>`. DB + WAL + SHM files are chmod'd to `0600`; parent directory to `0700`. See [SECURITY.md "Persistent FTS5 index: privacy posture"](../SECURITY.md#persistent-fts5-index-privacy-posture) for full privacy details.

## Roadmap

### Shipped in 0.10
- ✅ SQLite FTS5 inverted index (`--persistent-index`).
- ✅ BM25 ranking, sub-millisecond warm queries on multi-thousand-note vaults.
- ✅ Filter API on `obsidian_full_text_search`: `tag`, `since`, `folder`.
- ✅ Chunk-level resource URI (`obsidian://chunk/{n}/{path}`).
- ✅ `--tokenize=unicode61|trigram` for CJK / mixed-script vaults.
- ✅ `clear-index` subcommand for privacy purge.

### Open
- Full DQL: expressions, `FLATTEN`, `GROUP BY`, parenthesized precedence.
- Higher-level write tools: rename/move with wikilink rewrites, tag refactor.
- Graph queries (multi-hop link traversal).
- Examples directory with the contributor's reference Python implementation (per [issue #10](https://github.com/oomkapwn/enquire-mcp/issues/10)).

## Skipped directories

The walker ignores `.git`, `.obsidian`, `.trash`, `node_modules`, and any other dot-directory.
