/**
 * Shared CLI help strings for `serve` and `serve-http` subcommands.
 *
 * Background — v3.5.12 audit #4 (LOW finding 3.1) caught that the same
 * flag had two different help strings between stdio (`serve`) and
 * HTTP (`serve-http`) modes. e.g. `--diagnostic-search-tools` had a
 * 50-word explanation in `serve` that mentioned `--persistent-index`
 * gating, but a one-line legacy stub in `serve-http`. Same flag,
 * different docs depending on which `--help` you ran.
 *
 * **The pattern:** every CLI flag that BOTH subcommands accept should
 * pull its help text from this module. Drift between subcommands then
 * becomes impossible — one source of truth, one string.
 *
 * This first version covers the flags the v3.5.10 audit flagged as
 * drifting. As the next audit cycle finds more drift, lift them here.
 *
 * Not exported as part of the public API surface (per STABILITY.md —
 * see /package.json `exports`, this file is not listed).
 */

/**
 * `--enable-write` flag help. The "seven write tools" wording matches
 * what `registerWriteTools()` actually registers; the
 * docs-consistency `tests/docs-consistency.test.ts` invariant
 * (`enable-write write-count word`) verifies the count is still 7
 * — if a new write tool is added, that invariant fails and reminds
 * the implementer to update this string.
 */
export const ENABLE_WRITE_HELP =
  "Enable the seven write tools (create_note, append_to_note, rename_note, replace_in_notes, archive_note, frontmatter_set, chat_thread_append). Off by default.";

/**
 * `--diagnostic-search-tools` flag help. Explicit about the
 * `--persistent-index` gating for `obsidian_full_text_search` per
 * v3.5.9 audit fix D6. Single string used by both `serve` and
 * `serve-http`.
 */
export const DIAGNOSTIC_SEARCH_TOOLS_HELP =
  "Register the single-ranker search tools (obsidian_search_text, obsidian_semantic_search, obsidian_embeddings_search) IN ADDITION to the default obsidian_search hybrid tool — plus obsidian_full_text_search if --persistent-index is also set (it's gated on FTS5 availability separately). Off by default in v2.0+ — the umbrella obsidian_search auto-detects available signals and produces consistent recall. Enable when you need single-ranker output for diagnostics or A/B benchmarking.";

/**
 * `--persistent-index` flag help. States the FTS5 index requirement for
 * `obsidian_full_text_search`, without implying this flag alone registers it
 * (v3.8.0-rc.10 P3-21 — pre-rc.10 phrasing "Registers obsidian_full_text_search"
 * was a gating wording drift: both --persistent-index AND --diagnostic-search-tools
 * are required to expose the tool).
 */
export const PERSISTENT_INDEX_HELP =
  "Maintain a SQLite FTS5 inverted index for sub-100ms BM25-ranked search. Required for obsidian_full_text_search — also pass --diagnostic-search-tools to surface it alongside the default hybrid obsidian_search.";

/**
 * `--watch` flag help. Shared between `serve` and `serve-http` so the text
 * cannot drift between subcommands (v3.8.0-rc.11 M-1 — N-5 recurrence fix:
 * rc.6 updated serve-http, rc.7 updated serve to a *longer* string, leaving
 * them still different; lifting here makes drift structurally impossible).
 */
export const WATCH_HELP =
  "Watch the vault for .md and .pdf changes; incrementally re-syncs FTS5 and embed-db (when available). Off by default. Use this for long-running servers where you keep editing in Obsidian and want search to stay fresh without restarting.";

/**
 * `--disabled-tools` flag help (v3.8.0-rc.11 M-1 root-class fix). Pre-rc.11
 * serve had a 205-char explanation with rationale + example; serve-http had a
 * 44-char one-liner. Lifting here makes drift impossible. Uses serve's text
 * as canonical (more informative; serve-http inherits the full guidance).
 */
export const DISABLED_TOOLS_HELP =
  "Skip registration of specific tools by exact name. Useful when you want to expose a smaller surface to a particular agent (e.g. read-only research agent gets only obsidian_search_text + obsidian_read_note). Repeatable. Names are the same as in `tools/list` — `obsidian_*`. Example: `--disabled-tools obsidian_dataview_query obsidian_full_text_search`.";

/**
 * `--enabled-tools` flag help (v3.8.0-rc.11 M-1 root-class fix). Pre-rc.11
 * serve had a 98-char full description, serve-http had a 56-char abbreviated
 * one. Canonical text uses serve's full version.
 */
export const ENABLED_TOOLS_HELP =
  "Strict allowlist — when set, ONLY listed tools register. Complement to --disabled-tools (denylist). If both are set: a tool must be in the allowlist AND not in the denylist. Repeatable. Example: `--enabled-tools obsidian_search_text obsidian_read_note obsidian_get_recent_edits`.";

/**
 * `--tokenize` flag help (v3.8.0-rc.11 M-1 root-class fix). Pre-rc.11 serve
 * mentioned "Latin/Cyrillic" and "CJK/mixed-script", serve-http omitted these
 * — script-coverage hint matters for users picking a mode. Canonical text
 * keeps the script guidance from serve.
 */
export const TOKENIZE_HELP =
  "FTS5 tokenize mode: 'unicode61' (default; Latin/Cyrillic) or 'trigram' (CJK/mixed-script)";

/**
 * `--max-file-bytes` flag help (v3.8.0-rc.11 M-1 defensive lift). Both serve
 * and serve-http had identical inline text; lifting prevents future drift.
 */
export const MAX_FILE_BYTES_HELP = "Max bytes for any single file read/write (default 5MB)";

/**
 * `--cache-size` flag help (v3.8.0-rc.11 M-1 defensive lift). Identical
 * between serve and serve-http pre-rc.11.
 */
export const CACHE_SIZE_HELP = "Max parsed-note cache entries (default 1024)";

/**
 * `--persistent-cache` flag help (v3.8.0-rc.11 M-1 defensive lift). Identical
 * between serve and serve-http pre-rc.11.
 */
export const PERSISTENT_CACHE_HELP = "Persist parsed-note cache to disk so cold starts skip re-parsing";

/**
 * `--cache-file` flag help (v3.8.0-rc.11 M-1 defensive lift). Identical
 * between serve, serve-http, and other subcommands pre-rc.11.
 */
export const CACHE_FILE_HELP = "Override the persistent-cache file location";

/**
 * `--index-file` flag help (v3.8.0-rc.11 M-1 defensive lift). Identical
 * between serve, serve-http, and other subcommands pre-rc.11.
 */
export const INDEX_FILE_HELP = "Override the FTS5 index file location";

/**
 * `--quantize-embeddings` flag help (v3.8.0-rc.11 M-1 root-class fix; caught
 * by the new cli-parity invariant). Pre-rc.11 serve had a 355-char detailed
 * description with v2.16 history + recall numbers + accepted aliases; serve-http
 * had a 161-char abbreviated form missing the alias enumeration. The alias list
 * is contractual (users pass any of these — silently dropping documentation of
 * `i8`/`q8`/`float32`/`none` was a real omission).
 */
export const QUANTIZE_EMBEDDINGS_HELP =
  "v2.17.0 — vector storage encoding for the persistent embed db. `f32` (default) is identical to v2.16- behavior. `int8` cuts BLOB size ~4× (per-vector min+scale + int8 bytes) at ~1-2% recall@10 cost. Must match the mode used at `build-embeddings` time — otherwise the index auto-rebuilds on serve start. Accepts `f32`/`float32`/`none` and `int8`/`i8`/`q8`.";
