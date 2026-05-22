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
