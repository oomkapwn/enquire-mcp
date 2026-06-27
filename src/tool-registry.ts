import * as path from "node:path";
import { type McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MAX_DQL_QUERY_LEN } from "./dql.js";
import { defaultIndexFile, type FtsIndex } from "./fts5.js";
import { VERSION } from "./index.js";
import type { ServerDeps } from "./server.js";
import {
  appendToNote,
  archiveNote,
  chatThreadAppend,
  chatThreadRead,
  contextPack,
  createNote,
  dataviewQuery,
  embeddingsSearch,
  findPath,
  findSimilar,
  frontmatterGet,
  frontmatterSearch,
  frontmatterSet,
  getBacklinks,
  getNoteNeighbors,
  getOpenQuestions,
  getOutboundLinks,
  getRecentEdits,
  getUnresolvedWikilinks,
  getVaultStats,
  lintWiki,
  listCanvases,
  listNotes,
  listPdfs,
  listTags,
  MAX_QUESTION_PATTERN_LEN,
  ocrPdf,
  openInUi,
  paperAudit,
  readCanvas,
  readNote,
  readPdf,
  renameNote,
  replaceInNotes,
  resolveWikilink,
  searchHybrid,
  searchText,
  semanticSearch,
  staleNotes,
  validateNoteProposal
} from "./tools/index.js";
import type { Vault } from "./vault.js";

/**
 * v3.11.0-rc.11 (rc.9-audit L1, defense-in-depth) — upper bound on a free-form
 * query / tag string at the schema boundary. The HTTP transport already caps the
 * body, but a per-tool `.max()` fails an absurd query fast (before a per-note
 * `.toLowerCase()` / tokenize scan) and documents the bound. Mirrors
 * `MAX_DQL_QUERY_LEN` / `MAX_QUESTION_PATTERN_LEN`.
 */
const MAX_QUERY_LEN = 4096;
const MAX_TAG_ARG_LEN = 256;
/**
 * v3.11.0-rc.13 (rc.12-audit AUD-04) — upper bound on a frontmatter KEY argument. An
 * uncapped key on `obsidian_frontmatter_search` / `frontmatter_get` / `filter_frontmatter`
 * / `frontmatter_set` is multiplied by a whole-vault scan and `nfcLower(key)`-folded
 * per note, so a multi-MB key is a bearer-reachable CPU/event-loop DoS amplifier
 * (measured ~9.5s for a 4 MB key on a 2k-note vault). A real property name is short;
 * 256 is generous. Sibling of the rc.11/rc.12 free-form string-cap class.
 */
const MAX_FRONTMATTER_KEY_LEN = 256;
/**
 * v3.11.0-rc.21 (post-rc.20 re-sweep) — upper bound on the stringified `equals` /
 * `contains` VALUE predicate of `obsidian_frontmatter_search`. rc.13 capped the
 * `key` but left the value predicates `z.unknown()` (uncapped); the handler
 * `JSON.stringify`s the predicate and string-compares it against every note's
 * frontmatter across the whole vault, so a multi-MB value is a bearer-reachable
 * O(notes × valueLen) CPU/event-loop amplifier (measured ~3.9s for a 4 MB
 * `contains` over a 2k-note vault) — the exact input-cap class rc.18 closed for
 * `obsidian_full_text_search`, here in the value dimension the inventory missed.
 * A real frontmatter value is short; 8 KiB is very generous.
 */
const MAX_FRONTMATTER_VALUE_LEN = 8192;

/** Default location for the persistent embedding index, alongside .fts5.db. */
export function embedDbPath(vaultRoot: string): string {
  // Match the FTS5 location convention by stripping the .fts5.db extension
  // off defaultIndexFile() and appending .embed.db.
  return defaultIndexFile(vaultRoot).replace(/\.fts5\.db$/, ".embed.db");
}

export function registerFtsTools(server: McpServer, idx: FtsIndex, vault: Vault): void {
  const READ_ONLY = { readOnlyHint: true, idempotentHint: true, openWorldHint: false } as const;
  server.registerTool(
    "obsidian_full_text_search",
    {
      title: "Full-text search (BM25, FTS5 index)",
      description:
        "BM25-ranked full-text search backed by a SQLite FTS5 inverted index. Sub-100ms on multi-thousand-note vaults. Returns chunk-level hits with snippet excerpts. Hyphenated tokens (e.g. `claude-telegram`) are auto-quoted. Optional filters: `folder` (vault-relative subtree), `tag` (exact frontmatter or inline tag membership), `since` (ISO date — only chunks from notes modified on/after this). Use `obsidian_search_text` instead if the index isn't built yet — this tool is only registered when the server is started with BOTH `--persistent-index` (so the FTS5 index exists) AND `--diagnostic-search-tools` (single-ranker diagnostic surface; the hybrid `obsidian_search` tool is the recommended default).",
      annotations: { ...READ_ONLY, title: "Full-text search" },
      inputSchema: {
        // v3.11.0-rc.18 (rc.17 external audit, Codex RESOURCE-DOS-tool-registry-fts-query-cap)
        // — these were uncapped `z.string()` while every other search tool caps `query`.
        // A 4096-byte repeated-token `query` flows into SQLite FTS5 `MATCH` and stalled the
        // event loop ~33s (bearer-reachable under --persistent-index --diagnostic-search-tools).
        // Cap every free-form FTS input; parser-input-cap-invariant now inventories this tool.
        query: z
          .string()
          .min(1)
          .max(MAX_QUERY_LEN)
          .describe(
            "Search query. Whitespace-tokenized; FTS5 BM25 matching with `unicode61` (default) or `trigram` tokenizer."
          ),
        folder: z.string().max(MAX_QUERY_LEN).optional().describe("Restrict to a subfolder (vault-relative)"),
        tag: z
          .string()
          .max(MAX_TAG_ARG_LEN)
          .optional()
          .describe("Exact tag membership (e.g. 'project'). Matches frontmatter + inline tags. No leading #."),
        since: z
          .string()
          .max(MAX_TAG_ARG_LEN)
          .optional()
          .describe("ISO 8601 date or timestamp — restrict to chunks from notes modified on/after this."),
        limit: z.number().int().positive().max(200).optional().describe("Max hits (default 25)")
      }
    },
    async (args) => {
      let sinceMtimeMs: number | undefined;
      if (args.since) {
        const t = Date.parse(args.since);
        if (Number.isFinite(t)) sinceMtimeMs = t;
        else throw new Error(`Invalid 'since' value (expected ISO date): ${args.since}`);
      }
      // v2.0.0-beta.2 P0 fix: filter excluded paths from FTS5 hits before
      // returning. The .fts5.db can contain entries from when the index was
      // built without exclusion flags. Pre-fix, BM25 search leaked excluded
      // chunks through `rel_path` and `snippet` (which contains the matched
      // chunk text bracketed with «…»).
      const userLimit = args.limit ?? 25;
      const overFetch = userLimit * 2;
      const rawMatches = idx.search(args.query, {
        limit: overFetch,
        folder: args.folder,
        tag: args.tag,
        sinceMtimeMs
      });
      const matches = rawMatches.filter((m) => !vault.isExcluded(m.rel_path)).slice(0, userLimit);
      return textResult({
        query: args.query,
        total_chunks: idx.totalChunks(),
        total_files: idx.totalFiles(),
        applied_filters: {
          folder: args.folder ?? null,
          tag: args.tag ?? null,
          since: args.since ?? null
        },
        matches
      });
    }
  );
}

export function registerReadTools(
  server: McpServer,
  vault: Vault,
  ftsIndex: FtsIndex | null,
  diagnosticSearchTools: boolean,
  /**
   * v2.9.0 — optional cross-encoder reranker config. When set, obsidian_search
   * post-RRF reranks the top-N candidates with a BGE-style cross-encoder.
   * `null` means reranker disabled (default).
   */
  rerankerConfig: { alias?: string; topN?: number } | null = null,
  /**
   * v2.13.0 — optional HNSW context. When set, embedding-side k-NN goes
   * through the in-memory HNSW index instead of brute-force cosine.
   * Built once on serve start; passed through every search call.
   */
  hnswContext: ServerDeps["hnswContext"] = null,
  /**
   * v3.10.0-rc.5 — optional opt-in recency re-ranking config for obsidian_search.
   * When set (weight > 0), the final fused order is re-sorted by a blend of
   * relevance rank and the note's live-mtime recency. `null` (default) keeps
   * ranking purely relevance-driven.
   */
  recencyConfig: { weight: number; staleDays: number } | null = null,
  /**
   * v3.11.0 — optional opt-in closed-loop feedback context for obsidian_search.
   * When set (weight > 0), the final fused order is re-sorted by a blend of
   * relevance rank and each note's recorded usefulness (live `store.scores()`
   * snapshot, computed per call). `null` (default) keeps ranking relevance-pure.
   */
  feedbackContext: { weight: number; store: import("./feedback.js").FeedbackStore } | null = null
): void {
  const READ_ONLY = { readOnlyHint: true, idempotentHint: true, openWorldHint: false } as const;

  server.registerTool(
    "obsidian_list_notes",
    {
      title: "List notes",
      description:
        "List notes in the vault. Filter by tag, folder, or modified-since date. Returns title, path, frontmatter, tags, and mtime — newest first.",
      annotations: { ...READ_ONLY, title: "List notes" },
      inputSchema: {
        tag: z.string().optional().describe("Filter by tag (with or without leading #)"),
        folder: z.string().optional().describe("Restrict to a subfolder (relative to vault root)"),
        since_date: z.string().optional().describe("ISO 8601 date (YYYY-MM-DD); only notes mtime >= this"),
        limit: z.number().int().positive().max(500).optional().describe("Max results (default 50)")
      }
    },
    async (args) => textResult(await listNotes(vault, args))
  );

  server.registerTool(
    "obsidian_read_note",
    {
      title: "Read note",
      description:
        'Read a note by relative path or by title (filename without .md). Default `format: "full"` returns content + frontmatter + wikilinks + embeds + tags. `format: "map"` returns just headings + frontmatter keys + counts (no body) — useful for planning a surgical edit without paying token cost for the body. Title accepts periodic-note aliases ("today"/"daily"/"weekly"/"monthly") that resolve to the standard `YYYY-MM-DD`/`YYYY-Www`/`YYYY-MM` names. Errors include `Did you mean: ...` suggestions on near-misses.',
      annotations: { ...READ_ONLY, title: "Read note" },
      inputSchema: {
        path: z.string().optional().describe("Path relative to vault root, with or without .md"),
        title: z
          .string()
          .optional()
          .describe('Note title (filename without .md). Aliases: "today"/"daily"/"weekly"/"monthly".'),
        format: z
          .enum(["full", "map"])
          .optional()
          .describe('"full" (default) returns body + parsed metadata. "map" returns just headings + counts.')
      }
    },
    async (args) => textResult(await readNote(vault, args))
  );

  server.registerTool(
    "obsidian_resolve_wikilink",
    {
      title: "Resolve wikilink",
      description:
        "Resolve an Obsidian [[wikilink]] (or ![[embed]]) to a vault file. Handles aliases (Note|alias), sections (Note#Heading), block refs (Note^block), and ../-relative paths.",
      annotations: { ...READ_ONLY, title: "Resolve wikilink" },
      inputSchema: {
        wikilink: z.string().describe("Wikilink target (e.g. 'Note Name', 'Note#Heading', 'Folder/Note|alias')"),
        from_note: z
          .string()
          .optional()
          .describe("Calling note's relative path (used to disambiguate same-name files)"),
        include_content: z.boolean().optional().describe("Include resolved file's body (default true)")
      }
    },
    async (args) => textResult(await resolveWikilink(vault, args))
  );

  // v2.0.0-beta.3: obsidian_search_text is now a DIAGNOSTIC tool — gated
  // behind --diagnostic-search-tools. Default search surface is the umbrella
  // obsidian_search which auto-detects + fuses signals. Pre-fix, agents
  // routinely picked the wrong single-ranker tool; consolidation reduces
  // tool-list bloat and produces consistent recall.
  if (diagnosticSearchTools)
    server.registerTool(
      "obsidian_search_text",
      {
        title: "Search text",
        description:
          "Case-insensitive token search across all notes. Default mode `all` requires every whitespace-separated token to appear in a note (AND-tokenizer); `any` requires at least one (OR); `phrase` does the old contiguous-substring match. Returns a structured response with `query`, `mode`, `scanned_notes`, and ranked `matches` (each with snippet, line, score, matched_terms) — empty matches are explicit, not ambiguous with a broken call.",
        annotations: { ...READ_ONLY, title: "Search text" },
        inputSchema: {
          query: z
            .string()
            .min(1)
            .max(MAX_QUERY_LEN)
            .describe('Search string. With mode=all/any, whitespace tokenizes ("foo bar" → ["foo","bar"]).'),
          folder: z.string().optional().describe("Restrict to a subfolder"),
          limit: z.number().int().positive().max(200).optional().describe("Max results (default 25)"),
          mode: z
            .enum(["all", "any", "phrase"])
            .optional()
            .describe('"all" (default, AND), "any" (OR), or "phrase" (literal substring — pre-v0.9 behavior)')
        }
      },
      async (args) => textResult(await searchText(vault, args))
    );

  server.registerTool(
    "obsidian_get_recent_edits",
    {
      title: "Get recent edits",
      description: "List notes ordered by most recent modification. Useful for picking up where work was left off.",
      annotations: { ...READ_ONLY, title: "Get recent edits" },
      inputSchema: {
        since_minutes: z.number().int().positive().optional().describe("Only notes edited within this many minutes"),
        folder: z.string().optional().describe("Restrict to a subfolder"),
        limit: z.number().int().positive().max(200).optional().describe("Max results (default 20)")
      }
    },
    async (args) => textResult(await getRecentEdits(vault, args))
  );

  server.registerTool(
    "obsidian_stale_notes",
    {
      title: "Stale notes",
      description:
        "List notes not edited in N days (forgetting-aware staleness), oldest first. Use to surface facts that may be outdated before relying on them, or to pick notes to refresh. Cheap mtime-only scan; returns path / title / mtime / age_days.",
      annotations: { ...READ_ONLY, title: "Stale notes" },
      inputSchema: {
        stale_days: z.number().int().positive().max(36500).optional().describe("Age threshold in days (default 365)"),
        folder: z.string().optional().describe("Restrict to a subfolder"),
        limit: z.number().int().positive().max(500).optional().describe("Max results (default 50)")
      }
    },
    async (args) => textResult(await staleNotes(vault, args))
  );

  server.registerTool(
    "obsidian_get_backlinks",
    {
      title: "Get backlinks",
      description:
        "List every note in the vault that links (or embeds) the target note. Returns ranked hits with snippets and link kind (wikilink/embed/mixed).",
      annotations: { ...READ_ONLY, title: "Get backlinks" },
      inputSchema: {
        path: z.string().optional().describe("Target note path relative to vault root"),
        title: z.string().optional().describe("Target note title (filename without .md)"),
        include_embeds: z.boolean().optional().describe("Include ![[…]] embeds (default true)"),
        limit: z.number().int().positive().max(500).optional().describe("Max results (default 50)")
      }
    },
    async (args) => textResult(await getBacklinks(vault, args))
  );

  server.registerTool(
    "obsidian_list_tags",
    {
      title: "List tags",
      description:
        "List every unique tag in the vault with usage counts (frontmatter vs inline). Sorted by count desc.",
      annotations: { ...READ_ONLY, title: "List tags" },
      inputSchema: {
        folder: z.string().optional().describe("Restrict to a subfolder"),
        min_count: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Drop tags used fewer than this many times (default 1)"),
        limit: z.number().int().positive().max(2000).optional().describe("Max results (default 200)")
      }
    },
    async (args) => textResult(await listTags(vault, args))
  );

  server.registerTool(
    "obsidian_dataview_query",
    {
      title: "Dataview query (basic)",
      description:
        'Run a Dataview-style query. Grammar: (LIST | TABLE col1, col2) FROM ("folder" | #tag) [WHERE pred (AND|OR pred)*] [SORT field [ASC|DESC]] [LIMIT n]. Operators: =, !=, contains, like (SQL-LIKE wildcard with *, escape with \\*). Special fields: file.name, file.path, file.mtime, file.tags. Other identifiers read frontmatter. No expressions, FLATTEN, GROUP BY, or joins — see docs/api.md for the unsupported set.',
      annotations: { ...READ_ONLY, title: "Dataview query" },
      inputSchema: {
        // v3.10.0-rc.57 (DQL-PARSE-QUADRATIC-DOS) — boundary length cap (mirrors
        // MAX_QUESTION_PATTERN_LEN); parseDql enforces the same cap fail-closed at the sink.
        query: z.string().min(1).max(MAX_DQL_QUERY_LEN).describe("Dataview-style query string")
      }
    },
    async (args) => textResult(await dataviewQuery(vault, args))
  );

  server.registerTool(
    "obsidian_get_unresolved_wikilinks",
    {
      title: "Get unresolved wikilinks",
      description:
        "Find every [[wikilink]] (and ![[embed]]) in the vault whose target does not resolve to a file. Useful as a vault-hygiene utility — broken links, typos, notes you intended to create.",
      annotations: { ...READ_ONLY, title: "Get unresolved wikilinks" },
      inputSchema: {
        folder: z.string().optional().describe("Restrict the scan to a subfolder"),
        include_embeds: z.boolean().optional().describe("Include ![[…]] embeds (default true)"),
        limit: z.number().int().positive().max(2000).optional().describe("Max results (default 200)")
      }
    },
    async (args) => textResult(await getUnresolvedWikilinks(vault, args))
  );

  server.registerTool(
    "obsidian_get_outbound_links",
    {
      title: "Get outbound links",
      description:
        "List every link this note points to — wikilinks and (optionally) embeds, with each one's resolution status. Symmetric counterpart to obsidian_get_backlinks.",
      annotations: { ...READ_ONLY, title: "Get outbound links" },
      inputSchema: {
        path: z.string().optional().describe("Source note path relative to vault root"),
        title: z.string().optional().describe("Source note title (filename without .md)"),
        include_embeds: z.boolean().optional().describe("Include ![[…]] embeds (default true)"),
        include_unresolved: z.boolean().optional().describe("Include links that don't resolve (default true)")
      }
    },
    async (args) => textResult(await getOutboundLinks(vault, args))
  );

  server.registerTool(
    "obsidian_validate_note_proposal",
    {
      title: "Validate a proposed new note (anti-slop)",
      description:
        "Lint a draft note BEFORE writing. Closes the #1 LLM-write pain: AI generates structurally-broken notes (bad YAML, fake wikilinks, inconsistent tags). This tool parses the proposed YAML, resolves every [[wikilink]] against the live vault (broken/resolved with did-you-mean), pre-classifies every tag (existing vs new), and checks for path/title collisions. Returns errors (blocking) + warnings (non-blocking) + per-link/tag diagnostics. Always available — does NOT require --enable-write. Recommended workflow: validate → fix → obsidian_create_note.",
      annotations: { ...READ_ONLY, title: "Validate note proposal" },
      inputSchema: {
        path: z.string().describe("Vault-relative path the LLM intends to write to (e.g. 'Inbox/idea.md')"),
        // v3.10.0-rc.67 (round-3 re-sweep, DoS) — cap the proposed content. The wikilink scan +
        // per-broken-link suggestion is bounded by body size; 1 MB is generous for any real note
        // draft while preventing a body packed with hundreds of thousands of broken `[[...]]`
        // targets from amplifying into a whole-vault scan storm (defense-in-depth alongside the
        // shared-listing + per-target memoization in validateNoteProposal).
        content: z
          .string()
          .max(1_000_000, "content too large (max 1 MB)")
          .describe("Full proposed markdown content including any frontmatter block"),
        mode: z
          .enum(["create", "overwrite", "append"])
          .optional()
          .describe('"create" (default) errors if path exists. "overwrite"/"append" allow existing path.')
      }
    },
    async (args) => textResult(await validateNoteProposal(vault, args))
  );

  server.registerTool(
    "obsidian_find_similar",
    {
      title: "Find similar notes (lexical-hybrid)",
      description:
        "Given a note, return up to N other notes that are 'related' — by tag overlap (Jaccard), title 3-gram overlap, shared outbound links, and co-backlinks. Score is a weighted sum of those four signals; each is also returned individually so the caller can re-rank. No embeddings, no native deps — pure structural retrieval over the existing vault graph. Runs O(N) over the whole vault per call; for vaults >5k notes prefer batching. **v3.10:** each result also carries `age_days` + a `stale` flag (from the note's live mtime) so you can prefer fresher related notes or flag aged ones.",
      annotations: { ...READ_ONLY, title: "Find similar notes" },
      inputSchema: {
        path: z.string().optional().describe("Vault-relative path to the source note"),
        title: z.string().optional().describe("Source note title (alternative to path)"),
        limit: z.number().int().positive().max(50).optional().describe("Max similar notes to return (default 10)"),
        min_score: z.number().min(0).max(10).optional().describe("Drop hits below this score (default 0.05)")
      }
    },
    async (args) => textResult(await findSimilar(vault, args))
  );

  server.registerTool(
    "obsidian_get_note_neighbors",
    {
      title: "Get a note + its 1-hop graph neighborhood",
      description:
        "Return a note's immediate graph neighborhood in one call: outbound wikilinks (resolved), inbound backlinks (with count), and tag-cluster siblings (notes sharing ≥1 tag, excluding outbound/inbound). Replaces the read_note → backlinks → outbound → resolve_wikilink chain with a single round-trip — designed for RAG-style 'give the LLM enough context to reason about THIS note'.",
      annotations: { ...READ_ONLY, title: "Get note neighbors" },
      inputSchema: {
        path: z.string().optional().describe("Vault-relative path to the center note"),
        title: z.string().optional().describe("Center note title (alternative to path)"),
        max_per_bucket: z
          .number()
          .int()
          .positive()
          .max(100)
          .optional()
          .describe("Cap each bucket (outbound/inbound/tag_siblings). Default 20.")
      }
    },
    async (args) => textResult(await getNoteNeighbors(vault, args))
  );

  server.registerTool(
    "obsidian_stats",
    {
      title: "Vault dashboard (one-shot orientation)",
      description:
        "Vault-wide summary: total notes, total bytes, average note length, recently-modified count (last 7 days), orphan notes (no inbound + no outbound), broken wikilink count, total tag count, and top-N tags by frequency. Cheap (one pass over the cached parse). Useful as the first call in a session so the LLM has structural context before issuing targeted reads.",
      annotations: { ...READ_ONLY, title: "Vault stats" },
      inputSchema: {
        top_tags: z.number().int().positive().max(50).optional().describe("How many top tags to return (default 10)")
      }
    },
    async (args) => textResult(await getVaultStats(vault, args))
  );

  server.registerTool(
    "obsidian_lint_wiki",
    {
      title: "Lint the wiki (Karpathy LLM-Wiki workflow)",
      description:
        "Comprehensive vault-hygiene check inspired by Karpathy's LLM-Wiki gist (gist.github.com/karpathy/442a6bf555914893e9891c11519de94f). Returns five buckets of findings in one call: orphans (no inbound + no outbound), broken wikilinks, stub pages (under N words), stale pages (frontmatter `last_reviewed` or mtime older than M days), and concept candidates (capitalised phrases mentioned by ≥ K notes that lack their own page). Each finding carries a path + suggestion shaped so the agent can fix via existing tools (validate_note_proposal → create_note / append_to_note / rename_note). Read-only.",
      annotations: { ...READ_ONLY, title: "Lint wiki" },
      inputSchema: {
        folder: z.string().optional().describe("Restrict the lint to a subfolder (default: whole vault)"),
        stub_word_threshold: z
          .number()
          .int()
          .positive()
          .max(10000)
          .optional()
          .describe("Notes shorter than this are flagged as stubs (default 100)"),
        stale_days: z
          .number()
          .int()
          .positive()
          .max(36500)
          .optional()
          .describe("Notes not touched for this many days are flagged as stale (default 365)"),
        concept_min_mentions: z
          .number()
          .int()
          .positive()
          .max(100)
          .optional()
          .describe(
            "A capitalised phrase mentioned by ≥ N distinct notes without a page is a concept candidate (default 3)"
          ),
        max_per_bucket: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .describe("Cap per finding bucket so the response stays bounded (default 50)")
      }
    },
    async (args) => textResult(await lintWiki(vault, args))
  );

  server.registerTool(
    "obsidian_open_questions",
    {
      title: "Surface open questions across the vault",
      description:
        "Walks every note for lines matching deferred-thinking markers — `Open question:` / `Q:` / `TODO?` / `??` (plus optional list-bullet/quote/heading prefixes). Returns each hit with source, the heading it lives under, line number, and age in days, sorted oldest-first so things aging out surface first. Common research-PKM pattern (Karpathy's wiki, Eleanor Konik, academic Zettelkasten). Read-only.",
      annotations: { ...READ_ONLY, title: "Open questions" },
      inputSchema: {
        folder: z.string().optional().describe("Restrict the scan to a subfolder"),
        limit: z.number().int().positive().max(500).optional().describe("Max questions to return (default 100)"),
        pattern: z
          .string()
          .max(MAX_QUESTION_PATTERN_LEN)
          .optional()
          .describe(
            "Override the regex (case-insensitive). Default matches Open question:/Q:/TODO?/?? at line start with optional list/quote/heading prefix. Capped length; patterns with nested unbounded quantifiers (ReDoS risk) are rejected."
          )
      }
    },
    async (args) => textResult(await getOpenQuestions(vault, args))
  );

  server.registerTool(
    "obsidian_paper_audit",
    {
      title: "Audit paper notes for missing citations",
      description:
        "For each note tagged `#paper` (configurable), verify frontmatter has at least one citable identifier (arxiv / doi / url / isbn). Also flag notes whose body contains an arxiv ID (e.g. `arxiv:2401.12345`) or DOI but doesn't carry the same identifier in frontmatter — common after quick-capture from a chat. Returns each flagged note with what was found in body and a proposed frontmatter patch the agent can apply via validate_note_proposal + create_note/append_to_note. Read-only.",
      annotations: { ...READ_ONLY, title: "Paper audit" },
      inputSchema: {
        tag: z
          .string()
          .max(MAX_TAG_ARG_LEN)
          .optional()
          .describe("Tag identifying paper notes — with or without leading # (default 'paper')"),
        folder: z.string().optional().describe("Restrict the audit to a subfolder"),
        limit: z.number().int().positive().max(500).optional().describe("Max flagged notes (default 100)")
      }
    },
    async (args) => textResult(await paperAudit(vault, args))
  );

  server.registerTool(
    "obsidian_find_path",
    {
      title: "Find shortest wikilink path between two notes",
      description:
        "Multi-hop graph traversal: BFS from `from` to `to` over the wikilink graph, returning the shortest path (sequence of notes connected by wikilinks) up to `max_depth` hops. Each step in the returned path carries the wikilink text used to traverse to it. With `include_alternatives=true`, returns up to 10 same-length paths so the agent can compare. Embeds (`![[…]]`) are followed by default; pass `follow_embeds=false` to skip them. Read-only.",
      annotations: { ...READ_ONLY, title: "Find path" },
      inputSchema: {
        from: z.string().optional().describe("Vault-relative path of the source note"),
        from_title: z.string().optional().describe("Source note title (alternative to `from`)"),
        to: z.string().optional().describe("Vault-relative path of the destination note"),
        to_title: z.string().optional().describe("Destination note title (alternative to `to`)"),
        max_depth: z
          .number()
          .int()
          .positive()
          .max(10)
          .optional()
          .describe("Maximum BFS depth (default 5). Each hop is one wikilink edge."),
        include_alternatives: z
          .boolean()
          .optional()
          .describe("Return up to 10 same-length alternative paths (default false)"),
        follow_embeds: z.boolean().optional().describe("Treat ![[embeds]] as graph edges (default true)")
      }
    },
    async (args) => textResult(await findPath(vault, args))
  );

  server.registerTool(
    "obsidian_open_in_ui",
    {
      title: "Generate an obsidian:// URI for hand-off to the desktop app",
      description:
        "Returns an `obsidian://open?vault=<vault>&file=<path>` URI for hand-off to the running Obsidian desktop app. No filesystem or network side effect — the URI emission lets the agent say 'open this in Obsidian' without enquire-mcp coordinating with the running app. Optional `new_pane=true` opens the note in a split. Read-only.",
      annotations: { ...READ_ONLY, title: "Open in Obsidian" },
      inputSchema: {
        path: z.string().optional().describe("Vault-relative path of the note"),
        title: z.string().optional().describe("Note title (alternative to `path`)"),
        new_pane: z.boolean().optional().describe("Append `&newpane=true` so Obsidian opens the note in a split")
      }
    },
    async (args) => textResult(await openInUi(vault, args))
  );

  server.registerTool(
    "obsidian_list_canvases",
    {
      title: "List Obsidian Canvas (.canvas) files",
      description:
        "Lists `.canvas` files (Obsidian's whiteboard / mind-map format — JSON nodes + edges) in the vault, with each canvas's node and edge counts. Read-only. Honors `--exclude-glob` and `--read-paths`. Use this to discover which canvases exist before calling `obsidian_read_canvas` to inspect one.",
      annotations: { ...READ_ONLY, title: "List canvases" },
      inputSchema: {
        folder: z.string().optional().describe("Restrict the listing to a subfolder"),
        limit: z.number().int().positive().max(500).optional().describe("Max canvases to return (default 100)")
      }
    },
    async (args) => textResult(await listCanvases(vault, args))
  );

  // v3.4.0 — Wikilink community detection (GraphRAG-light). Builds an
  // undirected graph from the vault's wikilinks and partitions notes
  // into structural communities via greedy modularity optimization
  // (single-phase Louvain). Pure structural signal — no embeddings,
  // no LLM calls. The agent can summarize communities itself with the
  // member list this tool returns.
  server.registerTool(
    "obsidian_get_communities",
    {
      title: "Detect wikilink-graph communities (GraphRAG-light)",
      description:
        "v3.4.0 — Computes structural communities over the vault's wikilink graph via greedy modularity optimization (single-phase Louvain). Returns `community_count`, `modularity` (∈ [-0.5, 1] — higher = stronger structure), `iterations` (greedy passes run) and `converged` (true if a stable partition was reached, false if it hit the 50-pass cap), `communities[]` (each with id/size/sorted-members/representative — the highest-in-community-degree note), and `membership` (path → id). Pure structural — no embeddings consulted. Server stays LLM-free; the agent can summarize a community by reading its representative + sample members. Computation is O(passes × edges); typical 8K-note vault completes in <500ms. The result is NOT cached — call once per session and reuse. First MCP server with native vault community detection.",
      annotations: { ...READ_ONLY, title: "Get communities" },
      inputSchema: {
        min_size: z
          .number()
          .int()
          .nonnegative()
          .max(1000)
          .optional()
          .describe(
            "Drop communities with fewer than N members from the response (default 1 — keep singletons). Useful for filtering dust."
          ),
        limit: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .describe("Max communities to return (default 50, sorted by size descending)")
      }
    },
    async (args) => {
      const { buildWikilinkGraph, detectCommunities } = await import("./communities.js");
      const graph = await buildWikilinkGraph(vault);
      const result = detectCommunities(graph);
      const minSize = args.min_size ?? 1;
      const limit = args.limit ?? 50;
      const filtered = result.communities.filter((c) => c.size >= minSize).slice(0, limit);
      const keptIds = new Set(filtered.map((c) => c.id));
      const membershipObj: Record<string, number> = {};
      for (const [k, v] of result.membership.entries()) {
        if (keptIds.has(v)) membershipObj[k] = v;
      }
      return textResult({
        community_count: result.community_count,
        modularity: result.modularity,
        iterations: result.iterations,
        converged: result.converged,
        node_count: result.membership.size,
        communities: filtered,
        membership: membershipObj
      });
    }
  );

  // v3.2.0 — Obsidian Bases (`.base`) support. Bases are Obsidian's
  // first-class structured-data primitive (GA mid-2026): YAML files
  // defining filters/views/formulas over the vault's notes. We expose
  // 3 tools — list, read (metadata-only), query (executes the filter
  // subset against vault notes). NO formula evaluation (deferred); the
  // query DSL covers tag / path / frontmatter / and/or/not — the ~90%
  // case of user-authored bases.
  server.registerTool(
    "obsidian_list_bases",
    {
      title: "List Obsidian Bases (.base) files",
      description:
        "v3.2.0 — Lists `.base` files (Obsidian's structured-query primitive — YAML files defining filters/views over the vault) with each base's view count and view names. Read-only. Honors `--exclude-glob` and `--read-paths`. Use this to discover which bases exist before calling `obsidian_read_base` (metadata) or `obsidian_query_base` (execute filters). Sorted by mtime descending.",
      annotations: { ...READ_ONLY, title: "List bases" },
      inputSchema: {
        folder: z.string().optional().describe("Restrict the listing to a subfolder"),
        limit: z.number().int().positive().max(500).optional().describe("Max bases to return (default 100)")
      }
    },
    async (args) => {
      const { listBases } = await import("./bases.js");
      return textResult(await listBases(vault, args));
    }
  );

  server.registerTool(
    "obsidian_read_base",
    {
      title: "Read an Obsidian Base — parsed YAML metadata",
      description:
        "v3.2.0 — Parses a `.base` file into structured JSON (filters, formulas, properties, summaries, views). Does NOT execute the query — use `obsidian_query_base` for that. Useful when an agent wants to introspect the structure of a base before deciding which view to run, or to surface the base's saved queries to the user. Read-only.",
      annotations: { ...READ_ONLY, title: "Read base" },
      inputSchema: {
        path: z.string().describe("Vault-relative path of the .base file (with or without .base)")
      }
    },
    async (args) => {
      const { readBase } = await import("./bases.js");
      return textResult(await readBase(vault, args));
    }
  );

  server.registerTool(
    "obsidian_query_base",
    {
      title: "Execute an Obsidian Base — return matching notes",
      description:
        'v3.2.0 (extended in v3.5.0) — Runs a `.base` file\'s filter against the vault\'s markdown notes, returning matching paths + the frontmatter values that contributed to the match. Supported DSL: `tag == "x"`, `taggedWith(file.file, "x")`, `linksTo(file.file, "Target")` (v3.5.0 — outbound wikilink check, basename-resolved, case-insensitive), `path startsWith "X"` / `path contains "X"` / `file.path startsWith "X"` (v3.5.0 — `file.` prefix accepted), `file.name == "X"` / `file.name != "X"` (v3.5.0 — basename equality, .md stripped), `<frontmatter_key> == <value>`, `<key> != <value>`, `<key> contains "<substr>"`, plus `and` / `or` / `not` combinators. Anything else (formula evaluation, date arithmetic, summaries) is **fail-closed since v3.6.2 HN-2** — treated as `false` (excludes the row) and returned in `unevaluated_predicates` so callers see typo/unsupported expressions in the response. Pre-v3.6.2 the behavior was permissive (`true`); v3.6.2 flipped it after an external auditor flagged over-include risk. Pair with `obsidian_search` for retrieval-quality search; this is for explicit saved queries.',
      annotations: { ...READ_ONLY, title: "Query base" },
      inputSchema: {
        path: z.string().describe("Vault-relative path of the .base file"),
        view: z
          .string()
          .optional()
          .describe(
            "Optional view name. When set, the view's filters are concat'd with the global filter via AND (matching Obsidian semantics). Defaults to the global filter only."
          ),
        folder: z.string().optional().describe("Extra folder scope on top of the base's filters"),
        limit: z.number().int().positive().max(500).optional().describe("Max matches to return (default 50)")
      }
    },
    async (args) => {
      const { queryBase } = await import("./bases.js");
      return textResult(await queryBase(vault, args));
    }
  );

  server.registerTool(
    "obsidian_read_canvas",
    {
      title: "Read an Obsidian Canvas (parses .canvas JSON)",
      description:
        "Parses one `.canvas` file into typed nodes (text / file / link / group) + edges (with from/to node IDs and optional sides + labels). Each `file` node carries a `file_resolved` field — the vault-relative path that the canvas's file reference resolved to (or null if broken). The response also includes a `summary` of node-kind counts and a `broken_file_refs` array surfacing canvas files that reference non-existent notes. Read-only.",
      annotations: { ...READ_ONLY, title: "Read canvas" },
      inputSchema: {
        path: z.string().describe("Vault-relative path of the .canvas file (with or without .canvas)")
      }
    },
    async (args) => textResult(await readCanvas(vault, args))
  );

  // v2.7.0 — PDF tools. PDFs are the #1 non-markdown content kind in real
  // research vaults; no other Obsidian-MCP indexes them. Both tools work
  // identically over stdio + serve-http transports. Underlying parser
  // (pdfjs-dist) is an optionalDependency — `obsidian_read_pdf` surfaces a
  // clean install-hint error on missing optional dep, never a cryptic
  // module-not-found stack trace.
  server.registerTool(
    "obsidian_list_pdfs",
    {
      title: "List PDF files in the vault",
      description:
        "Lists `.pdf` files in the vault with size + last-modified timestamp. Read-only. Honors `--exclude-glob` and `--read-paths`. Use this to discover which PDFs exist before calling `obsidian_read_pdf` to extract text. Sorted by mtime descending (newest first). PDFs are the #1 non-markdown content kind in real research vaults; this is the discovery entry point.",
      annotations: { ...READ_ONLY, title: "List PDFs" },
      inputSchema: {
        folder: z.string().optional().describe("Restrict the listing to a subfolder"),
        limit: z.number().int().positive().max(500).optional().describe("Max PDFs to return (default 100)")
      }
    },
    async (args) => textResult(await listPdfs(vault, args))
  );

  server.registerTool(
    "obsidian_read_pdf",
    {
      title: "Extract text from a PDF (page-by-page)",
      description:
        "Extracts plain text from one PDF, returning per-page text + a `full_text` join + doc-level metadata (title/author/subject/etc). Image-only / scanned PDFs surface `has_text: false` so agents can detect-and-recommend OCR via `obsidian_ocr_pdf` (v2.10.0). Optional `pages` slice (1-indexed inclusive range) for partial reads of long documents. Read-only. Same path-safety + privacy filter as `obsidian_read_note`. Powered by Mozilla's PDF.js (Apache-2.0).",
      annotations: { ...READ_ONLY, title: "Read PDF" },
      inputSchema: {
        path: z.string().describe("Vault-relative path of the .pdf file (with or without .pdf)"),
        // v3.7.13 L2 — schema-level rejection of inverted ranges (parity
        // with obsidian_ocr_pdf). Pre-3.7.13 a `[10, 5]` request flowed
        // through to readPdf's silent fallback (range ignored, full doc
        // extracted) — actively worse than the OCR path because the
        // entire PDF still got iterated by pdfjs. Now rejected upfront.
        pages: z
          .tuple([z.number().int().positive(), z.number().int().positive()])
          .refine(([from, to]) => to >= from, {
            message: "pages: 'to' must be >= 'from' (1-indexed inclusive range)"
          })
          .optional()
          .describe("Optional 1-indexed inclusive page range, e.g. [2, 5] reads pages 2..5"),
        include_metadata: z.boolean().optional().describe("Include doc-level metadata in result (default true)")
      }
    },
    async (args) => textResult(await readPdf(vault, args))
  );

  // v2.10.0 — OCR for image-only / scanned PDFs. Completes the v2.7-v2.8
  // PDF retrieval story: when `obsidian_read_pdf` returns `has_text: false`,
  // the agent calls `obsidian_ocr_pdf` to extract text via Tesseract.js.
  // Tesseract.js + @napi-rs/canvas are optionalDependencies — clean
  // install-hint error if missing. ~1-2s per page on M1 CPU.
  server.registerTool(
    "obsidian_ocr_pdf",
    {
      title: "OCR a scanned/image-only PDF (Tesseract.js)",
      description:
        "Runs Tesseract OCR over each page of an image-only / scanned PDF, returning per-page text + per-page confidence + mean confidence + the same shape as `obsidian_read_pdf`. Use this when `obsidian_read_pdf` returns `has_text: false` (typical for scans, photographed paper, image-only PDFs). Multilingual via `lang` (default `'eng'`; multi-lang via `'+'`, e.g. `'eng+rus'`). Optional `pages` range and `scale` (DPI multiplier, default 2 ~ 150 DPI, capped at 4). ~1-2s per page on M1 CPU. Read-only. Powered by Tesseract.js (Apache-2.0; language trained-data must be pre-installed via `enquire-mcp install-ocr-lang <code>` — serve mode makes zero outbound network calls, so a language missing from the local cache fails closed with an install hint rather than downloading at runtime) + @napi-rs/canvas for PDF→bitmap rendering. Both gated to `optionalDependencies` so the markdown-only path stays zero-cost.",
      annotations: { ...READ_ONLY, title: "OCR PDF" },
      inputSchema: {
        path: z.string().describe("Vault-relative path of the .pdf file (with or without .pdf)"),
        // v3.7.13 M3 / v3.9.0-rc.10 (#16) — `lang` is validated then passed to the
        // Tesseract worker, which runs `cacheMethod: "readOnly"` against the local
        // tessdata cache (NO runtime CDN download — serve mode is offline; a missing
        // pack fails closed via `assertOcrLangsInstalled` with an `install-ocr-lang`
        // hint). The schema constraint still bounds the input to avoid pathological
        // many-language requests against the OCR worker. Schema constraint: 1-8 entries,
        // each a 3-letter Tesseract code (lowercase, optionally suffixed
        // with `_<variant>` for regional packs like `chi_sim`, `chi_tra`).
        // The pattern accepts the common Tesseract trained-data file
        // naming (https://tesseract-ocr.github.io/tessdoc/Data-Files.html).
        lang: z
          .string()
          .regex(
            /^[a-z]{3}(_[a-z]+)?(\+[a-z]{3}(_[a-z]+)?){0,7}$/,
            "lang must be 1-8 '+'-joined Tesseract codes (3 lowercase letters, optional `_variant` suffix). Example: 'eng', 'rus', 'chi_sim', 'eng+rus'."
          )
          .optional()
          .describe(
            "Tesseract language pack(s). Default 'eng'. Multi-lang via '+': 'eng+rus' for English+Russian mixed scans (max 8 packs per call). Common: 'eng', 'rus', 'jpn', 'chi_sim', 'fra', 'deu'."
          ),
        // v3.7.13 L2 — schema-level rejection of inverted ranges. Pre-3.7.13
        // a `pages: [10, 5]` request flowed through to `ocr.ts:166-170` where
        // `[from=10, to=5]` made the loop body never execute and returned an
        // empty "success" result. Now rejected at the boundary.
        pages: z
          .tuple([z.number().int().positive(), z.number().int().positive()])
          .refine(([from, to]) => to >= from, {
            message: "pages: 'to' must be >= 'from' (1-indexed inclusive range)"
          })
          .optional()
          .describe("Optional 1-indexed inclusive page range, e.g. [2, 5] OCRs pages 2..5"),
        scale: z
          .number()
          .min(0.5)
          .max(4)
          .optional()
          .describe(
            "Render scale (DPI multiplier). Default 2 (~150 DPI). Higher = better OCR on small text but slower."
          )
      }
    },
    async (args) => textResult(await ocrPdf(vault, args))
  );

  // v2.0.0-beta.3: gated — see comment on obsidian_search_text above.
  if (diagnosticSearchTools)
    server.registerTool(
      "obsidian_semantic_search",
      {
        title: "Semantic search (TF-IDF cosine)",
        description:
          "Pure-JS lexical-semantic retrieval. Tokenizes + TF-IDFs + L2-normalizes every note's body once per session, then ranks notes by cosine similarity to the query. Free / offline / no model download — closes the gap to Smart Connections without paywall, ML deps, or HTTP. Use this when `obsidian_search_text` (substring) and `obsidian_full_text_search` (BM25) miss synonyms or related-term matches. For best results pair with `--persistent-index` so BM25 + semantic both run cheap. Returns ranked hits with snippet + matched terms (highest-IDF first). **v3.10:** each hit also carries `age_days` + a `stale` flag (from the note's live mtime) — a freshness signal you can reason over.",
        annotations: { ...READ_ONLY, title: "Semantic search" },
        inputSchema: {
          query: z
            .string()
            .min(1)
            .max(MAX_QUERY_LEN)
            .describe("Free-form query — multi-word, natural language is fine"),
          folder: z.string().optional().describe("Restrict to a subfolder (vault-relative)"),
          limit: z.number().int().positive().max(100).optional().describe("Max hits (default 10)"),
          min_score: z
            .number()
            .min(0)
            .max(1)
            .optional()
            .describe("Drop hits below this cosine score (default 0.05). Cosine ranges 0–1.")
        }
      },
      async (args) => textResult(await semanticSearch(vault, args))
    );

  // v2.0 alpha — ML-embeddings retrieval. Reads a persistent vector index
  // built by `enquire-mcp build-embeddings`. Returns clean error if the index
  // doesn't exist (rather than silently downloading a model).
  // v2.0.0-beta.3: gated — see comment on obsidian_search_text above.
  if (diagnosticSearchTools)
    server.registerTool(
      "obsidian_embeddings_search",
      {
        title: "Embeddings search (ML, paraphrase-multilingual)",
        description:
          "ML-embedding retrieval via @huggingface/transformers + paraphrase-multilingual-MiniLM-L12-v2 (50+ languages, 384-dim, runs on CPU). Higher-quality than `obsidian_semantic_search` for paraphrases / synonyms / cross-language queries, but requires a one-time setup: (1) `enquire-mcp install-model multilingual` downloads the ONNX weights (~120MB) and (2) `enquire-mcp build-embeddings --vault <path>` writes the persistent vector index (~1ms/chunk on M1). Subsequent queries are sub-100ms top-10. If the index is missing, the tool returns a clean error with the exact command to run — it does NOT silently kick off a model download.",
        annotations: { ...READ_ONLY, title: "Embeddings search" },
        inputSchema: {
          query: z
            .string()
            .min(1)
            .max(MAX_QUERY_LEN)
            .describe("Free-form query — multi-word, natural language, any supported language"),
          folder: z.string().optional().describe("Restrict to a subfolder (vault-relative)"),
          limit: z.number().int().positive().max(100).optional().describe("Max hits (default 10)"),
          min_score: z
            .number()
            .min(0)
            .max(1)
            .optional()
            .describe(
              "Drop hits below this cosine score (default 0.3). Cosine ranges -1 to 1; embeddings cluster ~0.4-0.9."
            )
        }
      },
      async (args) => {
        const embedFile = embedDbPath(vault.root);
        return textResult(await embeddingsSearch(vault, args, embedFile));
      }
    );

  // v3.1.0 — HyDE (Hypothetical Document Embeddings, Gao et al 2023).
  // Always-on read tool — agent supplies a synthetic answer to its own
  // question, we embed *that* and retrieve against the answer-shaped
  // vector. Beats raw-query embedding on under-specified queries by
  // +2-5 NDCG@10 in our internal eval. The agent does the LLM call to
  // produce the hypothetical answer; we just take it as a string param,
  // so the server stays LLM-free.
  server.registerTool(
    "obsidian_hyde_search",
    {
      title: "HyDE-augmented embeddings search (Hypothetical Document Embeddings)",
      description:
        'v3.1.0 — HyDE retrieval (Gao et al 2023). Caller agent generates a synthetic answer to its own question, passes it as `hypothetical_answer`; the server embeds the answer (not the question) and retrieves against the answer-shaped vector. Typically beats raw-query embedding by +2-5 NDCG@10 on under-specified queries (e.g. "what did I learn about X" — the question vector is generic; the answer vector is topically anchored). Uses the same `.embed.db` as `obsidian_embeddings_search`. The agent SHOULD generate the hypothetical answer with no vault access (otherwise the loop is circular); 1-3 sentences in the same style/register as your notes. If `hypothetical_answer` is empty, falls back to embedding the raw `query`. Requires `enquire-mcp build-embeddings` first.',
      annotations: { ...READ_ONLY, title: "HyDE search" },
      inputSchema: {
        query: z
          .string()
          .min(1)
          .max(MAX_QUERY_LEN)
          .describe(
            "The original user question. Echoed in the response for audit-trail; does NOT influence retrieval when hypothetical_answer is non-empty."
          ),
        hypothetical_answer: z
          .string()
          .min(1)
          .max(MAX_QUERY_LEN)
          .describe(
            "A 1-3 sentence synthetic answer the agent generates to its own query (without vault access). This is what gets embedded. Make it topically dense + match the register/style of your vault notes."
          ),
        folder: z.string().optional().describe("Restrict to a subfolder (vault-relative)"),
        limit: z.number().int().positive().max(100).optional().describe("Max hits (default 10)"),
        min_score: z.number().min(0).max(1).optional().describe("Drop hits below this cosine score (default 0.3).")
      }
    },
    async (args) => {
      const embedFile = embedDbPath(vault.root);
      return textResult(await embeddingsSearch(vault, args, embedFile, hnswContext));
    }
  );

  // v2.0 beta — hybrid RRF over BM25 + TF-IDF + embeddings. Single umbrella
  // tool that auto-detects which signals are available and gracefully
  // degrades. Equal weights, k=60 (Cormack et al's recommendation). Note-
  // level fusion: chunk hits collapse to best-rank-per-note before fusion.
  server.registerTool(
    "obsidian_search",
    {
      title: "Hybrid search (BM25 + TF-IDF + embeddings, RRF-fused)",
      description:
        '**The default search tool for v2.0.** Auto-detects every available retrieval signal — BM25 via FTS5 (if `--persistent-index`), TF-IDF cosine (always), and ML embeddings (if `enquire-mcp build-embeddings` ran) — and fuses them with Reciprocal Rank Fusion (Cormack et al, 2009) for higher recall and better paraphrase / synonym matching than any single ranker. Equal weights, k=60. Gracefully degrades: with only TF-IDF available it produces TF-IDF-style ranking; with BM25+TF-IDF it does keyword-augmented retrieval; with all 3 it matches Smart Connections-quality retrieval — free / offline / open-source. Returns per-signal observability (`per_signal: { bm25, tfidf, embeddings }`) so you can see WHY each hit ranked. **v2.8.0:** when `--include-pdfs` was passed to `serve` (or `enquire-mcp index --include-pdfs` ran), PDF chunks are blended into results — each hit carries a `kind: "md" | "pdf"` flag and PDF chunks include `[page: N]` markers in snippets so agents can cite the right page. Use this instead of the individual `_search_text` / `_full_text_search` / `_semantic_search` / `_embeddings_search` tools unless you specifically need single-ranker output for diagnostics. **v3.10 (forgetting-aware):** every hit also carries `age_days` (whole days since the note was last edited, from its live mtime) and a `stale` boolean (true past ~1 year) — use these to flag a recalled fact as possibly out-of-date instead of stating it as current. Ranking stays relevance-driven by default; if the server was started with `--recency-weight`, fresher notes are blended upward.',
      annotations: { ...READ_ONLY, title: "Hybrid search" },
      inputSchema: {
        query: z
          .string()
          .min(1)
          .max(MAX_QUERY_LEN)
          .describe("Free-form query — multi-word natural language is the sweet spot"),
        folder: z.string().optional().describe("Restrict to a subfolder (vault-relative)"),
        limit: z.number().int().positive().max(100).optional().describe("Max hits (default 10)"),
        min_signals: z
          .number()
          .int()
          .min(1)
          .max(3)
          .optional()
          .describe(
            "Filter: only return hits that appeared in at least this many ranker signals. Default 1 (any). Set to 2+ for high-precision multi-ranker consensus."
          ),
        embedding_model: z
          .string()
          .optional()
          .describe(
            "Override the embedding model alias (default 'multilingual'). Only consulted if a .embed.db exists."
          ),
        granularity: z
          .enum(["note", "block"])
          .optional()
          .describe(
            "v2.2.0: 'note' (default) returns one hit per note (best chunk wins). 'block' keeps each chunk as a distinct hit — useful when one note covers a topic in multiple paragraphs and you want the LLM to see all of them."
          ),
        graph_boost: z
          .boolean()
          .optional()
          .describe(
            "v2.3.0: post-RRF wikilink graph-boost — rerank top-K by counting how many OTHER top-K hits link to each one. Default ON. Set false to disable for diagnostic comparison. The 'only enquire-mcp does this' feature: generic vector stores can't do this without an Obsidian-aware layer."
          ),
        filter_frontmatter: z
          .record(
            z.string().max(MAX_FRONTMATTER_KEY_LEN),
            // rc.24 (external rc.21 audit, Cursor LOW-2) — cap the string value arms. The
            // filter runs only on the fused candidate pool (O(fanOutK), bounded), so this is
            // defense-in-depth, the value-dimension sibling of the rc.21 frontmatter_search cap.
            z.union([
              z.string().max(MAX_FRONTMATTER_VALUE_LEN),
              z.number(),
              z.boolean(),
              z.array(z.union([z.string().max(MAX_FRONTMATTER_VALUE_LEN), z.number(), z.boolean()]))
            ])
          )
          .optional()
          .describe(
            "v3.10: optional YAML-frontmatter filter — a {key: value} map. A hit is kept only if its note's frontmatter satisfies EVERY pair (AND across keys). Per key: strings match case-insensitively, an array frontmatter value matches by membership (e.g. {tags: 'project'} matches `tags: [project, x]`), and the filter value may itself be an array for OR ({type: ['meeting','decision']}). Notes with no frontmatter or missing a filtered key are excluded. Omit for no filtering (default). Filters the fused candidate pool, so a strict filter can return fewer than `limit` hits."
          )
      }
    },
    async (args) => {
      const embedFile = embedDbPath(vault.root);
      return textResult(
        await searchHybrid(vault, args, {
          ftsIndex,
          embedFile,
          ...(rerankerConfig ? { reranker: rerankerConfig } : {}),
          ...(hnswContext ? { hnsw: hnswContext } : {}),
          ...(recencyConfig ? { recency: recencyConfig } : {}),
          ...(feedbackContext
            ? { feedback: { weight: feedbackContext.weight, scores: feedbackContext.store.scores() } }
            : {})
        })
      );
    }
  );

  server.registerTool(
    "obsidian_chat_thread_read",
    {
      title: "Read parsed chat thread from a note",
      description:
        "Parse a note's `## Chat: <title>` block into structured messages with role/timestamp/content/line-range. Non-chat content in the same note is ignored. Read-only.",
      annotations: { ...READ_ONLY, title: "Read chat thread" },
      inputSchema: {
        note_path: z.string().min(1).describe("Vault-relative path to the note hosting the thread")
      }
    },
    async (args) => textResult(await chatThreadRead(vault, args))
  );

  // v2.2.0: context pack — Smart Connections "Send to Smart Context" pattern,
  // MCP-native (works with any AI client, not just Obsidian).
  server.registerTool(
    "obsidian_context_pack",
    {
      title: "Pack vault context for an AI question (token-budgeted)",
      description:
        "Given a question, retrieve the top relevant notes (via hybrid search), gather backlinks summaries + optionally recent dailies, deduplicate, pack to a token budget, return a single ready-to-paste markdown bundle. Saves the agent ~5 separate tool calls; produces a coherent context blob you can paste into any AI chat.",
      annotations: { ...READ_ONLY, title: "Context pack" },
      inputSchema: {
        query: z.string().min(1).max(MAX_QUERY_LEN).describe("Topic or question to gather context for"),
        budget_tokens: z
          .number()
          .int()
          .positive()
          .max(32000)
          .optional()
          .describe("Approximate token budget (default 4000, ~4 chars/token)"),
        folder: z.string().optional().describe("Restrict retrieval to this folder (vault-relative)"),
        include_backlinks: z
          .boolean()
          .optional()
          .describe("Include 1-line backlink summaries for top-3 notes (default true)"),
        recent_dailies: z
          .number()
          .int()
          .min(0)
          .max(30)
          .optional()
          .describe("Include the last N daily-format notes (YYYY-MM-DD basenames). Default 0 (off).")
      }
    },
    async (args) => {
      const embedFile = embedDbPath(vault.root);
      return textResult(await contextPack(vault, args, { ftsIndex, embedFile }));
    }
  );

  // v2.3.0: frontmatter atomic ops — read.
  server.registerTool(
    "obsidian_frontmatter_get",
    {
      title: "Read note frontmatter (full or single key)",
      description:
        "Return parsed YAML frontmatter for a note. With `key`, returns just that field's value. Without `key`, returns the whole frontmatter object. Read-only.",
      annotations: { ...READ_ONLY, title: "Get frontmatter" },
      inputSchema: {
        path: z.string().optional().describe("Vault-relative path"),
        title: z.string().optional().describe("Note title (filename without .md, accepts periodic aliases)"),
        key: z
          .string()
          .max(MAX_FRONTMATTER_KEY_LEN)
          .optional()
          .describe("Single key to read; omit for full frontmatter")
      }
    },
    async (args) => textResult(await frontmatterGet(vault, args))
  );

  server.registerTool(
    "obsidian_frontmatter_search",
    {
      title: "Find notes by frontmatter predicate",
      description:
        "Find every note where frontmatter.<key> matches a predicate. Useful as a precursor to bulk frontmatter_set: 'find all notes with status:draft and set their status to published'. Predicates are exclusive: pass exactly one of `equals` (strict equality), `exists` (key must be present), `contains` (for array values, member match).",
      annotations: { ...READ_ONLY, title: "Search frontmatter" },
      inputSchema: {
        key: z.string().min(1).max(MAX_FRONTMATTER_KEY_LEN).describe("Frontmatter key to test"),
        // rc.21 — bound the stringified value predicate: it is JSON.stringify'd and
        // string-compared against EVERY note's frontmatter across the whole vault, so an
        // uncapped multi-MB value is a bearer-reachable O(notes × valueLen) DoS amplifier.
        equals: z
          .unknown()
          .optional()
          .refine((v) => v === undefined || JSON.stringify(v).length <= MAX_FRONTMATTER_VALUE_LEN, {
            message: `equals predicate too large (stringified > ${MAX_FRONTMATTER_VALUE_LEN} chars)`
          })
          .describe("Strict equality predicate (JSON.stringify comparison)"),
        exists: z.boolean().optional().describe("Predicate: key must exist (any value)"),
        contains: z
          .unknown()
          .optional()
          .refine((v) => v === undefined || JSON.stringify(v).length <= MAX_FRONTMATTER_VALUE_LEN, {
            message: `contains predicate too large (stringified > ${MAX_FRONTMATTER_VALUE_LEN} chars)`
          })
          .describe("For array values, value must be a member"),
        folder: z.string().optional().describe("Restrict search to a folder"),
        limit: z.number().int().positive().max(1000).optional().describe("Max matches (default 100)")
      }
    },
    async (args) => textResult(await frontmatterSearch(vault, args))
  );
}

/**
 * v3.11.0 — register `obsidian_mark_useful`, the closed-loop retrieval feedback
 * tool. Registered ONLY when `--feedback-weight > 0` (the `store` is non-null).
 * It records which recalled note(s) actually helped a query into the per-vault
 * `FeedbackStore`; the recorded usefulness then boosts those notes in subsequent
 * `obsidian_search` results (the "Karpathy loop"). NOT read-only — it mutates the
 * feedback store (a cache-dir sidecar, NOT the vault), so `enableWrite` does not
 * gate it; it never touches note files. The store holds only relative paths +
 * counts (no content), is erased by `prune`, and the boost is opt-in.
 */
export function registerFeedbackTool(server: McpServer, store: import("./feedback.js").FeedbackStore): void {
  // K-3 invariant: `obsidian_mark_useful` is NOT read-only (it mutates the feedback
  // store), so it carries the WRITE annotation — consistent with how the additive
  // `obsidian_append_to_note` is annotated WRITE. It does NOT mutate the VAULT, so
  // `--enable-write` does not gate it (`--feedback-weight > 0` does); its handler
  // `markUseful` is listed in KNOWN_WRITE_HANDLERS as a state-mutator (cache sidecar,
  // not a vault writer) so the K-3 "WRITE tool wires to a known write handler" check holds.
  const WRITE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;
  server.registerTool(
    "obsidian_mark_useful",
    {
      title: "Mark recalled notes useful",
      description:
        "Close the retrieval feedback loop: after using `obsidian_search` results, call this with the note path(s) that ACTUALLY helped answer the query (pass the `path` field of the useful hits). The recorded usefulness gently boosts those notes in future searches for this vault (active only when the server was started with `--feedback-weight`). Set `useful: false` to record a note that looked relevant but was NOT helpful (lowers its boost). Stores ONLY relative note paths + counts — never note content or your query — in a per-vault cache sidecar that `enquire-mcp prune` erases. Each call increments the tally (not idempotent).",
      annotations: { ...WRITE, title: "Mark useful" },
      inputSchema: {
        paths: z
          .array(z.string().min(1).max(1024))
          .min(1)
          .max(50)
          .describe("Relative vault paths of the notes that were useful (the `path` field from search hits). 1–50."),
        useful: z
          .boolean()
          .optional()
          .describe("true (default) = the notes helped; false = they looked relevant but did not help.")
      }
    },
    async (args) => textResult(await markUseful(store, args))
  );
}

/**
 * Handler for `obsidian_mark_useful` — records usefulness marks into the feedback
 * store (a cache sidecar, NOT the vault). Extracted + named so the K-3 invariant
 * can pin it as the tool's write handler (`KNOWN_WRITE_HANDLERS`). `new Date()` is
 * called here (not in the Date-free `feedback.ts` module) and injected into `record`.
 */
async function markUseful(
  store: import("./feedback.js").FeedbackStore,
  args: { paths: string[]; useful?: boolean }
): Promise<{ recorded: number; useful: boolean; total_notes_with_feedback: number; note: string }> {
  const useful = args.useful !== false;
  const recorded = await store.record(args.paths, useful, new Date().toISOString());
  return {
    recorded,
    useful,
    total_notes_with_feedback: store.size(),
    note: "Feedback boosts future obsidian_search ranking for this vault when --feedback-weight > 0."
  };
}

export function registerWriteTools(server: McpServer, vault: Vault): void {
  // destructiveHint=true: `obsidian_create_note` with overwrite=true replaces a
  // file irreversibly; `obsidian_append_to_note` mutates persistent state with
  // no built-in undo. Per MCP spec, both qualify as destructive.
  const WRITE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;

  server.registerTool(
    "obsidian_create_note",
    {
      title: "Create note",
      description:
        "Create a new note inside the vault. Refuses to overwrite unless overwrite=true. Frontmatter is rendered as YAML when supplied. WRITE TOOL — only available when the server is started with --enable-write.",
      annotations: { ...WRITE, title: "Create note" },
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe("Vault-relative path (e.g. 'Inbox/My Note' or 'Inbox/My Note.md'). Must not be empty or dot-only."),
        content: z.string().describe("Markdown body (frontmatter is supplied separately)"),
        frontmatter: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Optional YAML frontmatter as a flat object"),
        overwrite: z.boolean().optional().describe("Allow overwriting an existing note (default false)")
      }
    },
    async (args) => textResult(await createNote(vault, args))
  );

  server.registerTool(
    "obsidian_append_to_note",
    {
      title: "Append to note",
      description:
        "Append a block of markdown to the end of an existing note. Provide either path or title. WRITE TOOL — only available when the server is started with --enable-write.",
      annotations: { ...WRITE, title: "Append to note" },
      inputSchema: {
        path: z.string().optional().describe("Vault-relative path of the target note"),
        title: z.string().optional().describe("Target note title (filename without .md)"),
        content: z.string().describe("Markdown to append"),
        separator: z
          .string()
          .optional()
          .describe('String inserted between existing body and the new content (default "\\n\\n")')
      }
    },
    async (args) => textResult(await appendToNote(vault, args))
  );

  server.registerTool(
    "obsidian_rename_note",
    {
      title: "Rename note (with backlink rewrite)",
      description:
        "Atomically rename a note AND rewrite every [[wikilink]] / ![[embed]] in the rest of the vault that resolves to it — preserving |alias, #section, ^block, and the user's chosen path-qualification convention (bare basename vs path). Code-fence-aware: wikilinks inside ``` / ~~~ blocks are left verbatim. Use dry_run=true to preview which files would change without touching disk. Returns per-file rewrite counts + total. WRITE TOOL — only available when the server is started with --enable-write.",
      annotations: { ...WRITE, title: "Rename note" },
      inputSchema: {
        from: z.string().describe("Vault-relative path of the existing note (with or without .md)"),
        to: z
          .string()
          .describe("Vault-relative path of the new location (with or without .md). Different folder = move."),
        dry_run: z
          .boolean()
          .optional()
          .describe("Preview the rewrite plan without writing anything to disk (default false)"),
        overwrite: z.boolean().optional().describe("Allow overwriting an existing note at `to` (default false)")
      }
    },
    async (args) => textResult(await renameNote(vault, args))
  );

  server.registerTool(
    "obsidian_replace_in_notes",
    {
      title: "Bulk find/replace across notes (code-fence-aware)",
      description:
        "Walks the vault (or a `folder` subset), substitutes every occurrence of `search` with `replace` outside fenced code blocks (` ``` ` / `~~~`), and writes each modified file back. Reuses the same line-walker rename_note uses, so example snippets and code documentation stay verbatim. Pass `dry_run=true` to preview the plan without touching disk — you get per-file occurrence counts + total. `case_sensitive` defaults to true. Refuses identical search/replace and empty search to prevent footguns. WRITE TOOL — only registered when --enable-write is passed.",
      annotations: { ...WRITE, title: "Replace in notes" },
      inputSchema: {
        search: z.string().min(1).max(MAX_QUERY_LEN).describe("Literal substring to find. Empty string is rejected."),
        replace: z
          .string()
          .max(MAX_QUERY_LEN)
          .describe("Replacement text. Empty string means delete every occurrence."),
        folder: z.string().optional().describe("Restrict to a subfolder (vault-relative). Default: whole vault."),
        dry_run: z.boolean().optional().describe("Preview the plan without writing anything to disk (default false)"),
        case_sensitive: z
          .boolean()
          .optional()
          .describe("Default true. Set false for case-insensitive substring match (replace text inserted verbatim).")
      }
    },
    async (args) => textResult(await replaceInNotes(vault, args))
  );

  server.registerTool(
    "obsidian_archive_note",
    {
      title: "Archive a note (move to Archive/ + rewrite backlinks)",
      description:
        "Convenience wrapper around obsidian_rename_note for the common archive workflow. Moves the note's basename into `archive_folder` (default `Archive/`) and rewrites every wikilink/embed pointing at it. All the rename_note guarantees apply: code-fence-aware, dry_run preview, refuses to clobber an existing archive entry without `overwrite: true`. Returns the same shape as `obsidian_rename_note`. WRITE TOOL — only registered when --enable-write is passed.",
      annotations: { ...WRITE, title: "Archive note" },
      inputSchema: {
        path: z.string().describe("Vault-relative path of the note to archive (with or without `.md`)"),
        archive_folder: z
          .string()
          .optional()
          .describe("Destination folder. Default `Archive`. Trailing slash optional."),
        dry_run: z.boolean().optional().describe("Preview the rewrite plan without touching disk (default false)"),
        overwrite: z
          .boolean()
          .optional()
          .describe("Allow overwriting an existing file at the archive destination (default false)")
      }
    },
    async (args) => textResult(await archiveNote(vault, args))
  );

  // v2.2.0: append message to a note's chat thread.
  server.registerTool(
    "obsidian_chat_thread_append",
    {
      title: "Append message to note-tethered chat thread",
      description:
        "Add a user/assistant/system message to a note's `## Chat: <title>` block. Creates the note + heading if absent. Threads are stored as markdown so they're searchable, version-controllable, and survive across sessions / clients. Pair with `obsidian_chat_thread_read` to load past context. WRITE TOOL — only registered with --enable-write.",
      annotations: { ...WRITE, title: "Append chat thread" },
      inputSchema: {
        note_path: z.string().min(1).describe("Vault-relative path to the note hosting the thread"),
        role: z.enum(["user", "assistant", "system"]).describe("Role of the message being appended"),
        content: z.string().min(1).describe("Message body (markdown allowed)"),
        thread_title: z
          .string()
          .optional()
          .describe("Optional thread title — used when the note is created from scratch")
      }
    },
    async (args) => textResult(await chatThreadAppend(vault, args))
  );

  // v2.3.0: surgical frontmatter writes (set / unset / bulk).
  server.registerTool(
    "obsidian_frontmatter_set",
    {
      title: "Set/unset frontmatter keys atomically",
      description:
        "Surgical YAML manipulation: set one or more keys, or remove them by passing `null` as the value. Round-trips through the same js-yaml-backed frontmatter serializer used at write time so YAML formatting / quoting / type-coercion stays consistent. Returns `before` + `after` + list of changed keys for observability. `dry_run: true` shows the diff without writing.",
      annotations: { ...WRITE, title: "Set frontmatter" },
      inputSchema: {
        path: z.string().optional().describe("Vault-relative path"),
        title: z.string().optional().describe("Note title (filename without .md)"),
        set: z
          .record(z.string().max(MAX_FRONTMATTER_KEY_LEN), z.unknown())
          // rc.24 (external rc.21 audit, Cursor LOW-3) — bound each value's stringified length
          // (write-gated single-note YAML materialization; the value-dimension sibling of the
          // rc.21 frontmatter_search cap). `null`/`undefined` (the delete sentinel) are exempt.
          .refine(
            (rec) =>
              Object.values(rec).every((v) => v == null || JSON.stringify(v).length <= MAX_FRONTMATTER_VALUE_LEN),
            { message: `a frontmatter value exceeds ${MAX_FRONTMATTER_VALUE_LEN} chars (stringified)` }
          )
          .describe("Keys to set. Pass `null` as value to delete a key (e.g. {status: 'published', draft: null})"),
        dry_run: z.boolean().optional().describe("Preview the diff without writing (default false)")
      }
    },
    async (args) => textResult(await frontmatterSet(vault, args))
  );
}

export function registerChunkResource(server: McpServer, idx: FtsIndex, vault: Vault): void {
  // Chunk-level addressing — closes the v0.10 roadmap item from issue #10
  // suggestion 1. URI shape: obsidian://chunk/{chunkIndex}/{+notePath}.
  // Index FIRST so the {+notePath} can greedily eat slash-bearing paths.
  server.registerResource(
    "vault-chunk",
    new ResourceTemplate("obsidian://chunk/{chunkIndex}/{+notePath}", {
      list: async () => {
        // No exhaustive enumeration — chunks are a derived index that can
        // contain thousands of entries per vault. Clients should construct
        // these URIs from search hits returned by `obsidian_full_text_search`.
        // We surface a single example URI so the schema is discoverable.
        return { resources: [] };
      }
    }),
    {
      title: "Vault chunks (FTS5 index)",
      description:
        "Chunk-level addressing for FTS5 search hits. URI shape: `obsidian://chunk/<chunk_index>/<note-path>` — only registered when `--persistent-index` is on. Construct these URIs from `chunk_index` + `rel_path` returned by `obsidian_full_text_search`.",
      mimeType: "text/plain"
    },
    async (uri, params) => {
      const indexRaw = String(params.chunkIndex ?? "");
      const chunkIndex = Number.parseInt(indexRaw, 10);
      if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
        throw new Error(`Invalid chunk index in URI: ${indexRaw}`);
      }
      const notePathRaw = Array.isArray(params.notePath) ? params.notePath.join("/") : (params.notePath as string);
      const decoded = decodeNotePath(notePathRaw);
      // v3.7.20 R-9 — defense-in-depth: reject `..` / absolute-path inputs
      // BEFORE the FTS5 lookup. Pre-3.7.20, a chunk URI like
      // `obsidian://chunk/0/../../../etc/passwd` would not match anything
      // in FTS5 (which only contains vault-relative paths) and return a
      // generic "Chunk not found" — so privacy WAS preserved end-to-end,
      // but the path-traversal attempt itself wasn't rejected at the
      // input boundary. resolveInside() is the canonical path-traversal
      // guard used across vault read/write surfaces; applying it here
      // makes the error surface uniform AND prevents future regressions
      // if someone ever indexes content keyed on non-vault-relative paths.
      try {
        vault.resolveInside(decoded);
      } catch {
        throw new Error(`Chunk not found: ${decoded}#${chunkIndex}`);
      }
      // v2.0.0-beta.2 P0 fix: enforce --read-paths / --exclude-glob on the
      // chunk resource. The .fts5.db can contain entries from before the user
      // added a privacy filter, so a stale URI returned earlier in the
      // session would otherwise serve excluded content. We refuse with the
      // same "not found" framing the FTS5 search uses post-filter, so the
      // attacker can't distinguish "doesn't exist" from "exists but excluded".
      if (vault.isExcluded(decoded)) {
        throw new Error(`Chunk not found: ${decoded}#${chunkIndex}`);
      }
      const chunk = idx.getChunk(decoded, chunkIndex);
      if (!chunk) throw new Error(`Chunk not found: ${decoded}#${chunkIndex}`);
      const payload = {
        rel_path: decoded,
        chunk_index: chunkIndex,
        line_start: chunk.line_start,
        line_end: chunk.line_end,
        content: chunk.content
      };
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(payload, null, 2) }]
      };
    }
  );
}

export function registerResources(server: McpServer, vault: Vault): void {
  server.registerResource(
    "vault-info",
    "obsidian://vault/info",
    {
      title: "Vault metadata",
      description: "Root path, note count, write-enabled flag, and limits for the connected vault.",
      mimeType: "application/json"
    },
    async (uri) => {
      const entries = await vault.listMarkdown();
      const payload = {
        root: vault.root,
        note_count: entries.length,
        write_enabled: vault.writeEnabled,
        max_file_bytes: vault.maxFileBytes,
        max_cache_entries: vault.maxCacheEntries,
        version: VERSION
      };
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(payload, null, 2) }]
      };
    }
  );

  server.registerResource(
    "vault-note",
    new ResourceTemplate("obsidian://note/{+notePath}", {
      list: async () => {
        const entries = await vault.listMarkdown();
        return {
          resources: entries.map((e) => ({
            uri: `obsidian://note/${encodeNotePath(e.relPath)}`,
            name: e.basename.replace(/\.md$/i, ""),
            description: e.relPath,
            mimeType: "text/markdown"
          }))
        };
      }
    }),
    {
      title: "Vault notes",
      description: "Each markdown note in the vault, addressable via `obsidian://note/<relative-path>`.",
      mimeType: "text/markdown"
    },
    async (uri, params) => {
      const raw = Array.isArray(params.notePath) ? params.notePath.join("/") : (params.notePath as string);
      const decoded = decodeNotePath(raw);
      const { content } = await vault.readNote(decoded);
      return {
        contents: [{ uri: uri.href, mimeType: "text/markdown", text: content }]
      };
    }
  );
}

export function parsePositiveInt(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new Error(`${flag} must be a positive integer; got "${raw}"`);
  }
  return n;
}

/**
 * v2.17.0 — validate a `--quantize-embeddings <mode>` value. Accepts the
 * canonical `"f32"` / `"int8"` plus a few user-friendly aliases (`"none"`
 * for f32; `"q8"` for int8). Anything else throws with the exact list of
 * accepted values so the user can fix the typo immediately.
 */
export function parseQuantizationMode(raw: string | undefined): "f32" | "int8" | undefined {
  if (raw === undefined) return undefined;
  const norm = raw.trim().toLowerCase();
  if (norm === "" || norm === "f32" || norm === "float32" || norm === "none") return "f32";
  if (norm === "int8" || norm === "i8" || norm === "q8") return "int8";
  throw new Error(
    `--quantize-embeddings must be "f32" or "int8" (got "${raw}"). ` +
      `Aliases: "none"/"float32" → f32, "q8"/"i8" → int8.`
  );
}

export function encodeNotePath(relPath: string): string {
  return relPath.split(path.sep).map(encodeURIComponent).join("/");
}

export function decodeNotePath(uriPath: string): string {
  return uriPath.split("/").map(decodeURIComponent).join("/");
}

export function textResult(payload: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }]
  };
}
