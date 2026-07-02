/**
 * Machine-readable tool registry. Single source of truth for:
 *   - which tools exist
 *   - their gating (always-on / opt-in via which flag)
 *   - their description
 *   - their input schema reference
 *
 * Consumers:
 *   - tool-registry.ts iterates this to call server.registerTool()
 *   - tests/docs-consistency.test.ts iterates this to verify api.md coverage
 *   - future: auto-generate docs/api.md table from this
 *
 * Introduced in v3.6.0-rc.2 alongside the src/index.ts → domain-module
 * split. Populated by hand from the existing registerReadTools /
 * registerWriteTools / registerFtsTools call sites. The summary field is
 * a 1-line distillation of the registerTool() `description` argument —
 * the full description stays at the registration site so MCP clients
 * still see verbatim what they did pre-refactor. Count math invariant
 * (enforced by docs-consistency.test.ts): 46 total = 34 always-on read
 * + 1 fts (opt-in via --persistent-index) + 3 diagnostic (opt-in via
 * --diagnostic-search-tools) + 7 write (opt-in via --enable-write)
 * + 1 feedback (opt-in via --feedback-weight).
 */
export interface ToolManifestEntry {
  /** Tool name as registered (e.g., "obsidian_search"). */
  name: string;
  /** Registration kind — drives WHICH register*Tools fn picks it up. v3.11.0
   *  adds "feedback" (the closed-loop `obsidian_mark_useful`, via registerFeedbackTool). */
  kind: "read" | "fts" | "write" | "diagnostic" | "feedback";
  /** Human-readable gating clause shown in docs. */
  gating:
    | "always"
    | "--persistent-index"
    | "--enable-write"
    | "--diagnostic-search-tools"
    | "--persistent-index + --diagnostic-search-tools"
    | "--feedback-weight";
  /** One-line summary (~60 chars). Detailed description lives in the registerTool() call's `description` field. */
  summary: string;
}

export const TOOL_MANIFEST: readonly ToolManifestEntry[] = [
  // --- FTS5 BM25 search (1 entry) — registered by registerFtsTools().
  // v3.5.9 audit: this tool is opt-in via BOTH --persistent-index (the
  // FTS5 index must exist) AND --diagnostic-search-tools (single-ranker
  // diagnostic; default search is the umbrella obsidian_search).
  {
    name: "obsidian_full_text_search",
    kind: "fts",
    gating: "--persistent-index + --diagnostic-search-tools",
    summary: "BM25 full-text search backed by the SQLite FTS5 inverted index."
  },

  // --- Always-on read tools (34 entries) — registered by registerReadTools()
  //     OUTSIDE the `if (diagnosticSearchTools)` blocks.
  {
    name: "obsidian_list_notes",
    kind: "read",
    gating: "always",
    summary: "List notes filtered by tag / folder / mtime; newest first."
  },
  {
    name: "obsidian_read_note",
    kind: "read",
    gating: "always",
    summary: "Read a note by path or title (full body or headings-map)."
  },
  {
    name: "obsidian_resolve_wikilink",
    kind: "read",
    gating: "always",
    summary: "Resolve [[wikilink]] (aliases, sections, blocks) to a file."
  },
  {
    name: "obsidian_get_recent_edits",
    kind: "read",
    gating: "always",
    summary: "Notes ordered by most-recent modification."
  },
  {
    name: "obsidian_stale_notes",
    kind: "read",
    gating: "always",
    summary: "Notes not edited in N days (forgetting-aware staleness), oldest first."
  },
  {
    name: "obsidian_get_backlinks",
    kind: "read",
    gating: "always",
    summary: "List notes that link to / embed the target note."
  },
  {
    name: "obsidian_list_tags",
    kind: "read",
    gating: "always",
    summary: "All unique tags with usage counts (frontmatter + inline)."
  },
  {
    name: "obsidian_dataview_query",
    kind: "read",
    gating: "always",
    summary: "Run a Dataview-style LIST/TABLE query against the vault."
  },
  {
    name: "obsidian_get_unresolved_wikilinks",
    kind: "read",
    gating: "always",
    summary: "Every [[wikilink]] whose target doesn't resolve to a file."
  },
  {
    name: "obsidian_get_outbound_links",
    kind: "read",
    gating: "always",
    summary: "Outbound wikilinks/embeds from a note with resolution status."
  },
  {
    name: "obsidian_validate_note_proposal",
    kind: "read",
    gating: "always",
    summary: "Lint a draft note before writing (YAML / links / tags)."
  },
  {
    name: "obsidian_find_similar",
    kind: "read",
    gating: "always",
    summary: "Lexical-hybrid 'related notes' via tags, titles, links."
  },
  {
    name: "obsidian_get_note_neighbors",
    kind: "read",
    gating: "always",
    summary: "1-hop graph neighborhood: outbound, inbound, tag siblings."
  },
  {
    name: "obsidian_stats",
    kind: "read",
    gating: "always",
    summary: "Vault dashboard: counts, orphans, broken links, top tags."
  },
  {
    name: "obsidian_lint_wiki",
    kind: "read",
    gating: "always",
    summary: "Karpathy LLM-Wiki five-bucket hygiene check (read-only)."
  },
  {
    name: "obsidian_open_questions",
    kind: "read",
    gating: "always",
    summary: "Surface deferred-thinking markers (Q:/TODO?/Open question)."
  },
  {
    name: "obsidian_paper_audit",
    kind: "read",
    gating: "always",
    summary: "Audit paper notes for missing arxiv/doi/url citations."
  },
  {
    name: "obsidian_find_path",
    kind: "read",
    gating: "always",
    summary: "BFS shortest wikilink path between two notes."
  },
  {
    name: "obsidian_open_in_ui",
    kind: "read",
    gating: "always",
    summary: "Generate an obsidian:// URI to hand off to the desktop app."
  },
  {
    name: "obsidian_list_canvases",
    kind: "read",
    gating: "always",
    summary: "List .canvas files with node + edge counts."
  },
  {
    name: "obsidian_get_communities",
    kind: "read",
    gating: "always",
    summary: "Detect wikilink-graph communities (GraphRAG-light, Louvain)."
  },
  {
    name: "obsidian_list_bases",
    kind: "read",
    gating: "always",
    summary: "List Obsidian .base files (structured-query primitive)."
  },
  {
    name: "obsidian_read_base",
    kind: "read",
    gating: "always",
    summary: "Parse a .base file's YAML (filters/views/formulas)."
  },
  {
    name: "obsidian_query_base",
    kind: "read",
    gating: "always",
    summary: "Execute a .base filter against the vault's notes."
  },
  {
    name: "obsidian_read_canvas",
    kind: "read",
    gating: "always",
    summary: "Parse a .canvas file into typed nodes + edges."
  },
  {
    name: "obsidian_list_pdfs",
    kind: "read",
    gating: "always",
    summary: "List .pdf files in the vault (size + mtime)."
  },
  {
    name: "obsidian_read_pdf",
    kind: "read",
    gating: "always",
    summary: "Extract per-page text + metadata from a PDF (PDF.js)."
  },
  {
    name: "obsidian_ocr_pdf",
    kind: "read",
    gating: "always",
    summary: "OCR a scanned/image-only PDF via Tesseract.js."
  },
  {
    name: "obsidian_hyde_search",
    kind: "read",
    gating: "always",
    summary: "HyDE retrieval — embed the agent's hypothetical answer."
  },
  {
    name: "obsidian_search",
    kind: "read",
    gating: "always",
    summary: "Hybrid BM25 + TF-IDF + embeddings, RRF-fused (default)."
  },
  {
    name: "obsidian_chat_thread_read",
    kind: "read",
    gating: "always",
    summary: "Parse a note's `## Chat: <title>` block into messages."
  },
  {
    name: "obsidian_context_pack",
    kind: "read",
    gating: "always",
    summary: "Token-budgeted context bundle for an AI question."
  },
  {
    name: "obsidian_frontmatter_get",
    kind: "read",
    gating: "always",
    summary: "Read a note's frontmatter (full or a single key)."
  },
  {
    name: "obsidian_frontmatter_search",
    kind: "read",
    gating: "always",
    summary: "Find notes by frontmatter predicate (equals/exists/contains)."
  },

  // --- Diagnostic search tools (3 entries) — registered by registerReadTools()
  //     INSIDE `if (diagnosticSearchTools)` blocks. Single-ranker variants
  //     of the umbrella obsidian_search; useful for retrieval debugging.
  {
    name: "obsidian_search_text",
    kind: "diagnostic",
    gating: "--diagnostic-search-tools",
    summary: "Substring/AND/OR token search (no index required)."
  },
  {
    name: "obsidian_semantic_search",
    kind: "diagnostic",
    gating: "--diagnostic-search-tools",
    summary: "Pure-JS TF-IDF cosine semantic search (no model download)."
  },
  {
    name: "obsidian_embeddings_search",
    kind: "diagnostic",
    gating: "--diagnostic-search-tools",
    summary: "ML embeddings retrieval against the persistent vector index."
  },

  // --- Write tools (7 entries) — registered by registerWriteTools() and
  //     gated behind --enable-write. Every entry mutates vault state on disk.
  {
    name: "obsidian_create_note",
    kind: "write",
    gating: "--enable-write",
    summary: "Create a new note (refuses overwrite unless allowed)."
  },
  {
    name: "obsidian_append_to_note",
    kind: "write",
    gating: "--enable-write",
    summary: "Append a markdown block to an existing note."
  },
  {
    name: "obsidian_rename_note",
    kind: "write",
    gating: "--enable-write",
    summary: "Rename a note + rewrite every [[wikilink]] / ![[embed]]."
  },
  {
    name: "obsidian_replace_in_notes",
    kind: "write",
    gating: "--enable-write",
    summary: "Bulk find/replace across notes (code-fence-aware)."
  },
  {
    name: "obsidian_archive_note",
    kind: "write",
    gating: "--enable-write",
    summary: "Move a note into Archive/ + rewrite backlinks."
  },
  {
    name: "obsidian_chat_thread_append",
    kind: "write",
    gating: "--enable-write",
    summary: "Append a chat message to a note's `## Chat:` block."
  },
  {
    name: "obsidian_frontmatter_set",
    kind: "write",
    gating: "--enable-write",
    summary: "Set/unset frontmatter keys atomically (round-tripped YAML)."
  },

  // --- Closed-loop feedback (1 entry) — registered by registerFeedbackTool(),
  //     opt-in via --feedback-weight > 0. Mutates a per-vault feedback cache
  //     sidecar (paths + counts only), NOT the vault, so it's NOT --enable-write.
  {
    name: "obsidian_mark_useful",
    kind: "feedback",
    gating: "--feedback-weight",
    summary: "Record which recalled notes helped; boosts them in future search."
  }
];
