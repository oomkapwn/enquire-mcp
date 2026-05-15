import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * Register all enquire-mcp prompt templates on the given MCP server.
 *
 * Prompts are agent-side orchestration recipes — each one expands into a
 * structured `user`-role message that tells the LLM how to chain
 * `obsidian_*` tools to accomplish a higher-level workflow (weekly review,
 * Karpathy-style wiki maintenance, captcha-style ingest, sub-question
 * decomposition, etc.). No server-side LLM calls happen here; the prompts
 * are pure prompt engineering that the calling client surfaces to its own
 * model.
 *
 * Total: 19 prompts grouped roughly into:
 * - Day-to-day vault hygiene (`summarize_recent_edits`, `weekly_review`,
 *   `monthly_review`, `extract_todos`, `process_inbox`, `consolidate_tags`,
 *   `find_orphans`, `find_duplicates`)
 * - Wiki maintenance (`lint_wiki`, `vault_synth`, `vault_wiki_compile`,
 *   `vault_lint_extended`, `vault_synthesis_page`)
 * - Retrieval orchestration (`search_with_query_expansion`, `vault_research`,
 *   `vault_persona_search`)
 * - Knowledge capture / automation (`vault_capture`, `vault_automation_setup`)
 * - Reading-list helpers (`review_tag`)
 *
 * Called once at server startup by `tool-registry.ts`.
 *
 * @param server - The MCP server to register prompts on. Mutated in place.
 * @example
 * ```ts
 * const server = new McpServer({ name: "enquire-mcp", version: "3.6.0" });
 * registerPrompts(server);
 * registerTools(server, vault, ctx);
 * ```
 */
export function registerPrompts(server: McpServer): void {
  /**
   * Summarize recent vault activity for the user.
   *
   * Use case: "What was I working on this morning?" / "Catch me up after I
   * step away for a day". Chains `obsidian_get_recent_edits` (window-
   * filtered list) → `obsidian_read_note` on the top-3 results → produces
   * one paragraph per note with TODOs quoted verbatim, plus a one-sentence
   * "what to pick up next" suggestion.
   *
   * Args: `since_minutes` (string, optional, default `"720"` = last 12 hours).
   *
   * @example
   * The client invokes this with `since_minutes="60"` to get a one-hour catch-up.
   */
  // === summarize_recent_edits ==========================================
  server.registerPrompt(
    "summarize_recent_edits",
    {
      title: "Summarize recent edits",
      description: "Use obsidian_get_recent_edits + obsidian_read_note to summarize what was worked on recently.",
      argsSchema: {
        since_minutes: z.string().optional().describe("Window in minutes (default 720 — last 12 hours)")
      }
    },
    ({ since_minutes }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Summarize what I've been working on in my Obsidian vault.

1. Call \`obsidian_get_recent_edits\` with \`since_minutes=${since_minutes ?? 720}\` and \`limit=10\`.
2. For each top-3 result, call \`obsidian_read_note\` to read the body.
3. Produce one paragraph per note: what changed, what's open, what's blocked. Quote any TODO/FIXME bullets verbatim.
4. Finish with a 1-sentence "what to pick up next" suggestion.`
          }
        }
      ]
    })
  );

  /**
   * Review every note carrying a specific tag and surface unresolved threads.
   *
   * Use case: "What's the state of #project-foo?" / "All the open questions
   * across my #reading list". Pulls notes via `obsidian_list_notes` with the
   * tag filter, reads each, extracts open questions / blocking decisions /
   * TODOs, and groups recurring themes across the set.
   *
   * Args: `tag` (string, required, leading `#` optional).
   *
   * @example
   * Invoke with `tag="project-foo"` to summarize state of a project.
   */
  // === review_tag ======================================================
  server.registerPrompt(
    "review_tag",
    {
      title: "Review notes by tag",
      description: "Pull every note with a given tag and surface the open questions / unresolved threads.",
      argsSchema: {
        tag: z.string().describe("The tag to review (with or without leading #)")
      }
    },
    ({ tag }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Review every note tagged \`${tag}\` in my vault.

1. Call \`obsidian_list_notes\` with \`tag=${tag}\`, \`limit=50\`.
2. Read each note via \`obsidian_read_note\`.
3. For each: list its open questions, blocking decisions, and any explicit TODOs.
4. Group across notes — what themes recur? What's the highest-leverage thing to resolve?`
          }
        }
      ]
    })
  );

  /**
   * Identify orphan notes — notes with no inbound links, candidates for
   * archiving or wiring up to a hub note.
   *
   * Use case: vault hygiene pass. Enumerates with `obsidian_list_notes`,
   * checks `obsidian_get_backlinks` per note, and surfaces the zero-inbound
   * set sorted by mtime ascending (oldest stale orphans first). For each
   * orphan, proposes archive / hub-link / delete based on frontmatter +
   * a skim of the body.
   *
   * Args: `folder` (string, optional — scope the scan to a subfolder).
   */
  // === find_orphans ====================================================
  server.registerPrompt(
    "find_orphans",
    {
      title: "Find orphan notes",
      description: "Identify notes with no inbound links — candidates for archiving or wiring up.",
      argsSchema: {
        folder: z.string().optional().describe("Restrict the scan to a subfolder")
      }
    },
    ({ folder }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Find orphan notes in my Obsidian vault${folder ? ` under \`${folder}\`` : ""}.

1. Call \`obsidian_list_notes\`${folder ? ` with \`folder=${folder}\`` : ""} to enumerate.
2. For each note, call \`obsidian_get_backlinks\` and note the \`count\`.
3. Output the notes with \`count == 0\`, sorted by mtime ascending (oldest first).
4. For each orphan, propose one of: archive, link from a hub note, delete. Pick based on its frontmatter and a 1-line skim of its body.`
          }
        }
      ]
    })
  );

  /**
   * Weekly review of vault activity — what shipped, what's open, what's stuck.
   *
   * Use case: end-of-week reflection. Aggregates the past 7 days
   * (`since_minutes=10080`), groups by frontmatter `tags`, reads top-2
   * notes per tag-group, and produces "Shipped / Open / Stuck" bullets
   * plus a 2-sentence reflection on the actual-vs-intended focus.
   *
   * Args: `folder` (string, optional — restrict the review to a subfolder).
   */
  // === weekly_review ===================================================
  server.registerPrompt(
    "weekly_review",
    {
      title: "Weekly review",
      description: "Aggregate the last 7 days of vault edits and surface what shipped, what's open, what's stuck.",
      argsSchema: {
        folder: z.string().optional().describe("Restrict the review to a subfolder")
      }
    },
    ({ folder }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Run a weekly review of my Obsidian vault${folder ? ` (folder \`${folder}\`)` : ""}.

1. Call \`obsidian_get_recent_edits\` with \`since_minutes=10080\`${folder ? `, \`folder=${folder}\`` : ""}, \`limit=50\` to get the past week's edits.
2. Group results by top-level frontmatter \`tags\` (or by the most-frequent inline tag if no frontmatter).
3. For each tag-group, read the top 2 notes via \`obsidian_read_note\` and produce one bullet:
   - "Shipped:" what was completed
   - "Open:" any TODO/FIXME/QUESTION still in the body
   - "Stuck:" anything explicitly blocked
4. End with a 2-sentence reflection: where did the week's energy actually go vs. where you intended.`
          }
        }
      ]
    })
  );

  /**
   * Extract every TODO / FIXME / QUESTION marker across the vault, grouped
   * by note.
   *
   * Use case: "show me everything I've punted on". Runs three
   * `obsidian_search_text` passes (one per marker), optionally cross-filters
   * by tag, reads each unique source note, pulls the literal marker lines,
   * and ends with a highest-leverage next-action pick.
   *
   * Args: `folder` (string, optional), `tag` (string, optional).
   */
  // === extract_todos ===================================================
  server.registerPrompt(
    "extract_todos",
    {
      title: "Extract TODOs",
      description: "Surface every TODO / FIXME / QUESTION across the vault, grouped by note.",
      argsSchema: {
        folder: z.string().optional().describe("Restrict the scan to a subfolder"),
        tag: z.string().optional().describe("Restrict to notes carrying a specific tag")
      }
    },
    ({ folder, tag }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Extract every actionable item from my Obsidian vault${folder ? ` under \`${folder}\`` : ""}${tag ? ` (tag \`${tag}\`)` : ""}.

1. Call \`obsidian_search_text\` three times — once each for "TODO", "FIXME", "QUESTION" — with ${folder ? `\`folder=${folder}\`` : "no folder filter"} and \`limit=200\`.${tag ? `\n2. Cross-filter the hits to only notes from \`obsidian_list_notes({ tag: "${tag}" })\`.` : ""}
${tag ? "3" : "2"}. For each unique source note, read it via \`obsidian_read_note\` and pull the actual TODO/FIXME/QUESTION lines verbatim.
${tag ? "4" : "3"}. Output a flat list grouped by note path. Sort within each group by line number.
${tag ? "5" : "4"}. End with a one-line "highest-leverage next action" pick — the single TODO that, if done today, would unblock the most other items.`
          }
        }
      ]
    })
  );

  /**
   * Process an inbox folder — for each note propose where it should live
   * and which existing notes link to it.
   *
   * Use case: GTD-style inbox triage. Lists every note in the inbox,
   * checks inbound + outbound links per note, and proposes one of: move /
   * merge into existing / promote to hub / archive. Read-only by design —
   * proposes only, the user runs the actual write tools.
   *
   * Args: `folder` (string, required — the inbox folder, e.g. `"00_Inbox"`).
   */
  // === process_inbox ===================================================
  server.registerPrompt(
    "process_inbox",
    {
      title: "Process inbox",
      description:
        "For every note in an inbox folder, propose where it should live and which existing notes link to it.",
      argsSchema: {
        folder: z.string().describe("Inbox folder path (e.g. '00_Inbox')")
      }
    },
    ({ folder }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Process every note in \`${folder}\`.

1. Call \`obsidian_list_notes\` with \`folder=${folder}\`, \`limit=100\`.
2. For each note:
   a. Read it via \`obsidian_read_note\`.
   b. Check inbound references via \`obsidian_get_backlinks\`.
   c. Skim outbound links via \`obsidian_get_outbound_links\`.
3. For each note, propose ONE of:
   - **Move to \`<destination>\`** — pick a real existing folder based on the note's tags and content.
   - **Merge into \`<existing-note>\`** — if the content overlaps with an existing note.
   - **Promote to its own hub** — if it spawned 3+ outbound links.
   - **Archive / delete** — if it's stale and unlinked.
4. Output: one block per note with the proposed action and a one-sentence rationale. Don't actually move anything; just propose.`
          }
        }
      ]
    })
  );

  /**
   * Audit the tag forest and propose consolidations for near-duplicate
   * variants.
   *
   * Use case: tag drift cleanup. Finds clusters like
   * `#productivity` / `#productive` / `#Productivity` (case drift),
   * `book-notes` / `booknotes` / `book_notes` (separator drift),
   * `project` / `projects` (pluralization drift), or
   * `work/clients` / `clients` (hierarchy drift). Proposes a single
   * canonical tag per cluster. Read-only — no notes modified.
   *
   * Args: `min_count` (string, optional — minimum tag usage threshold,
   * default `"2"`).
   */
  // === consolidate_tags ================================================
  server.registerPrompt(
    "consolidate_tags",
    {
      title: "Consolidate tags",
      description:
        "Surface near-duplicate or inconsistently-cased tags (#productivity vs #productive vs #Productivity) and propose unifications.",
      argsSchema: {
        min_count: z.string().optional().describe("Only consider tags with at least N uses (default 2)")
      }
    },
    ({ min_count }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Audit my tag forest and propose consolidations.

1. Call \`obsidian_list_tags\` with \`min_count=${min_count ?? 2}\`, \`limit=200\`.
2. Group tags by 3-gram similarity AND by case-folded prefix. Look for clusters like:
   - Pluralization drift: \`project\` vs \`projects\` vs \`proj\`.
   - Case drift: \`AI\` vs \`ai\` vs \`Ai\`.
   - Hyphen/space drift: \`book-notes\` vs \`booknotes\` vs \`book_notes\`.
   - Hierarchy drift: \`work/clients\` vs \`clients\` vs \`work-clients\`.
3. For each cluster of 2+ near-duplicates, propose a single canonical tag (the highest-count one or the most-style-conformant one).
4. Output a markdown table: \`canonical | aliases-to-merge | total-affected-notes\`. End with a one-line "do this first" pick — the highest-leverage merge.

DO NOT modify any notes. This is read-only analysis.`
          }
        }
      ]
    })
  );

  /**
   * Find clusters of near-duplicate notes — merge candidates.
   *
   * Use case: vault consolidation. Walks notes via `obsidian_list_notes`,
   * runs `obsidian_find_similar` per candidate, builds mutual-top-5
   * clusters, then verifies content overlap on the top-2 of each cluster
   * (don't trust the structural signal alone). Proposes merge / split /
   * leave per cluster. Read-only.
   *
   * Args: `folder` (string, optional), `min_score` (string, optional,
   * default `"1.5"` — moderately tight similarity threshold).
   */
  // === find_duplicates =================================================
  server.registerPrompt(
    "find_duplicates",
    {
      title: "Find near-duplicate notes",
      description:
        "Walk the vault for clusters of structurally similar notes (same tags, overlapping titles, shared backlinks) — candidates for merge.",
      argsSchema: {
        folder: z.string().optional().describe("Restrict the scan to a subfolder"),
        min_score: z.string().optional().describe("Similarity threshold (0-10, default 1.5 — moderately tight)")
      }
    },
    ({ folder, min_score }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Find clusters of near-duplicate notes${folder ? ` under \`${folder}\`` : ""} that are merge candidates.

1. Call \`obsidian_list_notes\`${folder ? ` with \`folder=${folder}\`,` : " with"} \`limit=200\` to seed the candidate set.
2. For each candidate, call \`obsidian_find_similar\` with \`min_score=${min_score ?? "1.5"}\`, \`limit=5\`.
3. Build clusters: a cluster is a group of notes that all rank in each other's top-5 with score above the threshold. Discard solo notes.
4. For each cluster, read the top 2 notes via \`obsidian_read_note\` to verify content overlap (don't trust the structural signal alone).
5. Output: one block per cluster with member paths, signal scores, and a one-line proposal — \`merge into <best-canonical>\`, \`split into <distinct-topics>\`, or \`leave-they're-genuinely-different\`.

DO NOT modify any notes. Read-only.`
          }
        }
      ]
    })
  );

  /**
   * Karpathy LLM-Wiki lint workflow — comprehensive wiki health audit.
   *
   * Use case: Karpathy-style PKM maintenance pass. Orchestrates
   * `obsidian_lint_wiki` (orphans + broken links + stubs + stale + concept
   * candidates) + `obsidian_open_questions` (deferred threads) +
   * `obsidian_paper_audit` (missing citations). Synthesizes the top 5
   * highest-leverage fixes across all three reports with concrete
   * `obsidian_*` calls. Read-only — proposes only.
   *
   * Reference: {@link https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f}.
   *
   * Args: `folder` (string, optional — restrict the lint to a subfolder).
   */
  // === lint_wiki =======================================================
  server.registerPrompt(
    "lint_wiki",
    {
      title: "Lint the wiki (Karpathy LLM-Wiki workflow)",
      description:
        "Run Karpathy's lint workflow over the vault — orchestrate obsidian_lint_wiki + obsidian_open_questions + obsidian_paper_audit, surface every actionable issue, propose fixes the agent can apply via the existing write tools after validate_note_proposal. Read-only — proposes only, never modifies.",
      argsSchema: {
        folder: z.string().optional().describe("Restrict the lint to a subfolder")
      }
    },
    ({ folder }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Run a Karpathy-style \`/lint\` pass over my Obsidian vault${folder ? ` (folder \`${folder}\`)` : ""}.

The reference workflow is at https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f — three commands: ingest, query, lint. This is the lint pass.

1. Call \`obsidian_lint_wiki\`${folder ? ` with \`folder=${folder}\`` : ""} to get the five-bucket health report (orphans, broken links, stubs, stale pages, concept candidates). Read the \`summary\` first, then the per-bucket \`findings\`.
2. Call \`obsidian_open_questions\`${folder ? ` with \`folder=${folder}\`,` : " with"} \`limit=50\` to surface deferred threads.
3. Call \`obsidian_paper_audit\`${folder ? ` with \`folder=${folder}\`` : ""} to find paper notes missing arxiv/doi/url citations.
4. Synthesize: pick the **5 highest-leverage fixes** across all three reports. For each, propose a concrete action:
   - **Broken link**: which note, which target, what to do (\`obsidian_create_note\` the missing target / fix the link with \`obsidian_validate_note_proposal\` + write / \`obsidian_rename_note\` if the target moved).
   - **Orphan**: which hub note should link to it, OR archive proposal.
   - **Stub**: develop in-place / merge into / archive (with which existing note).
   - **Stale**: review checklist (re-read, update frontmatter \`last_reviewed\`, or archive).
   - **Concept candidate**: which phrase, which sources mention it, propose a stub page (\`obsidian_validate_note_proposal\` first to check the proposed wikilinks resolve).
   - **Open question**: which note + heading + age, propose pulling it into a "questions/<topic>.md" page or resolving it inline.
   - **Paper audit**: apply the \`proposed_frontmatter_patch\` to each flagged paper note (\`obsidian_validate_note_proposal\` → \`obsidian_append_to_note\` for the YAML).
5. Output:
   - 1-paragraph "state of the wiki" summary (counts per bucket).
   - 5-item action list with concrete \`obsidian_*\` calls.
   - Single-sentence pick — the one fix that, if done today, has the most cascade effect.

DO NOT actually modify any notes. This is a proposal pass — the user runs the proposed actions afterwards.`
          }
        }
      ]
    })
  );

  /**
   * 30-day vault review — themes, what shipped, what stalled.
   *
   * Use case: end-of-month reflection. Calls `obsidian_stats` for vault
   * health, then `obsidian_get_recent_edits` over a 30-day window
   * (`since_minutes=43200`). Groups by tags, identifies through-lines,
   * surfaces notes that look stalled (touched once early in the month),
   * and compares against the previous month if possible.
   *
   * Args: `folder` (string, optional).
   */
  // === monthly_review ==================================================
  server.registerPrompt(
    "monthly_review",
    {
      title: "Monthly review",
      description:
        "30-day version of `weekly_review` — aggregates a month of vault activity, identifies themes, and surfaces what stalled.",
      argsSchema: {
        folder: z.string().optional().describe("Restrict the review to a subfolder")
      }
    },
    ({ folder }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Run a monthly review of my Obsidian vault${folder ? ` (folder \`${folder}\`)` : ""}.

1. Call \`obsidian_stats\` first to get the lay of the land — total notes, top tags, orphan count, broken-link count, recently-modified-7d.
2. Call \`obsidian_get_recent_edits\` with \`since_minutes=43200\`${folder ? `, \`folder=${folder}\`` : ""}, \`limit=200\` to enumerate the past 30 days.
3. Group results by top-level frontmatter \`tags\` (or the most-frequent inline tag).
4. For each tag-group with 5+ touches:
   - "Theme:" what's the through-line of the work?
   - "Shipped:" 2-3 notes that look like they reached a conclusion.
   - "Stalled:" notes touched once early in the month and not since (likely abandoned).
5. Compare against the previous month's tag distribution if you can infer it from \`obsidian_get_recent_edits\` with a wider window — note any tag that was active last month but silent this one.
6. End with a 3-sentence reflection: what does the month say about your actual focus vs. your stated focus, and what's the one tag-cluster that deserves more attention next month.`
          }
        }
      ]
    })
  );

  // v2.1.0: multi-query expansion as a prompt template (NOT a server-side
  // LLM call — that would violate the MCP boundary). The agent paraphrases
  // the user's question N ways, calls obsidian_search per paraphrase, then
  // RRF-fuses the results client-side. Boosts recall on terse / ambiguous
  // queries by 5-15 NDCG@10 vs single-pass search. Pure prompt eng.
  /**
   * High-recall retrieval via multi-query expansion + client-side RRF
   * fusion.
   *
   * Use case: terse or ambiguous queries where single-pass search misses
   * the right answer. The agent paraphrases the query 3-5 ways (mix of
   * keyword-focused, semantic-focused, step-back, optionally bilingual),
   * calls `obsidian_search` per paraphrase, then reciprocal-rank-fuses the
   * results client-side (no server-side LLM call — violates the MCP
   * boundary). Boosts recall by 5-15 NDCG@10 on ambiguous queries.
   *
   * Args: `query` (string, required), `n_paraphrases` (string, optional,
   * default `"4"`), `limit` (string, optional, default `"10"`).
   */
  // === search_with_query_expansion =====================================
  server.registerPrompt(
    "search_with_query_expansion",
    {
      title: "Search with multi-query expansion",
      description:
        "Higher-recall retrieval: paraphrase the query 3-5 ways, call obsidian_search per paraphrase, fuse results. Boosts recall on terse / ambiguous queries by 5-15 NDCG@10 over a single-pass search. Pure agent-side orchestration — no server-side LLM calls.",
      argsSchema: {
        query: z.string().describe("The user's original question / search query"),
        n_paraphrases: z.string().optional().describe("How many paraphrases to generate (default 4)"),
        limit: z.string().optional().describe("Top-K hits per paraphrase before fusion (default 10)")
      }
    },
    ({ query, n_paraphrases, limit }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `High-recall retrieval over my Obsidian vault. The user asked: "${query}"

1. Generate ${n_paraphrases ?? 4} short paraphrases of the question. Mix:
   - 1 keyword-focused (good for BM25): noun phrases, technical terms
   - 1 semantic-focused (good for embeddings): natural-language restating
   - 1-2 step-back: a more general question whose answer would contain this one
   - Optionally 1 in another language if my vault is bilingual

2. For each paraphrase, call \`obsidian_search\` with \`query=<paraphrase>\` and \`limit=${limit ?? 10}\`.

3. Reciprocal Rank Fusion: assign each hit a score of 1/(60+rank), sum across paraphrases per note path, sort descending.

4. Return the top 10 fused results. For each: path, fused_score, which paraphrases hit it (and at what rank), and a 1-sentence "why this answers the original question."

5. If a hit appears in only ONE paraphrase, mark it as "low-confidence — only retrieved by paraphrase #N" — these are speculative.

The goal is recall + observability: the user sees not just the answer but WHY each note ranked.`
          }
        }
      ]
    })
  );

  // v2.4.0 — Karpathy LLM-Wiki workflow prompts.
  // Reference: https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
  // Karpathy named three workflows: ingest, query, lint. We had `query` and
  // `lint` since v1.5. v2.4.0 adds `ingest`-style workflows + `compile`/
  // `synth` patterns that close the loop. Position: enquire-mcp = the
  // open-source backend for Karpathy-style LLM Wikis on top of Obsidian.

  /**
   * Karpathy LLM-Wiki **ingest** workflow — synthesize wiki page(s) from
   * an external source.
   *
   * Use case: paste a paragraph / arXiv abstract / URL transcript and have
   * the agent extract 3-7 concepts, reconcile each against existing vault
   * notes (EXISTS → append / PARTIAL → new note with wikilink / NEW →
   * fresh wiki page), validate each draft via `obsidian_validate_note_proposal`,
   * then output a transactional plan for user approval before writing.
   * Every claim is cited with the source quote.
   *
   * Distinct from `vault_synthesis_page` which synthesizes from existing
   * vault content rather than external input.
   *
   * Args: `source` (string, required — the content to ingest),
   * `target_folder` (string, optional — default `"Wiki/"`).
   */
  // === vault_synth =====================================================
  server.registerPrompt(
    "vault_synth",
    {
      title: "Synthesize a vault wiki page from sources (Karpathy-style ingest)",
      description:
        "Karpathy LLM-Wiki ingest workflow: take raw source(s), extract entities/concepts/claims, decide which existing notes to update vs which new wiki pages to create, then propose drafts. The agent decides; this prompt sequences the calls. Cites every claim with the source location for trust.",
      argsSchema: {
        source: z
          .string()
          .describe("Source content to ingest — paste a paragraph, an arXiv abstract, a URL transcript, etc."),
        target_folder: z
          .string()
          .optional()
          .describe("Where new wiki pages should land (vault-relative, default 'Wiki/')")
      }
    },
    ({ source, target_folder }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Karpathy LLM-Wiki **ingest** workflow on this source:

\`\`\`
${source}
\`\`\`

Steps:

1. **Extract concepts.** Identify 3-7 distinct concepts / entities / claims worth indexing. For each, propose a wiki page title (PascalCase or "Title Case" — match my vault's existing convention; check via \`obsidian_list_notes\` on a few sample folders).

2. **Reconcile with vault.** For each concept, run \`obsidian_search\` (graph_boost ON, default) to find existing notes that ALREADY cover it. Three outcomes per concept:
   - **EXISTS** (top hit score > 0.04 and same scope) → propose an APPEND to the existing note
   - **PARTIAL** (related but doesn't cover this angle) → propose a new note that \`[[wikilinks]]\` to the existing one
   - **NEW** → propose a fresh wiki page in \`${target_folder ?? "Wiki/"}\`

3. **Lint drafts before writing.** For each proposed write, call \`obsidian_validate_note_proposal\` to catch broken \`[[wikilinks]]\` / inconsistent tags / structurally-broken YAML BEFORE creating.

4. **Cite every claim.** Each new note should have a "Source" frontmatter field referencing the input + a "Claims" section with one bullet per extracted claim, each with the source quote.

5. **Output a transactional plan.** Don't write yet. Output a JSON-like list:
   \`\`\`
   [
     { action: "create" | "append", path: "Wiki/Foo.md", reason: "...", body_preview: "..." },
     ...
   ]
   \`\`\`
   Then ask the user to approve. ONLY write after explicit approval, using \`obsidian_create_note\` / \`obsidian_append_to_note\`.

This is the Karpathy LLM-Wiki ingest loop applied to Obsidian. Goal: knowledge that compounds over time, with every claim traceable to its source.`
          }
        }
      ]
    })
  );

  /**
   * Karpathy LLM-Wiki **compile** workflow — regenerate `index.md` +
   * append to `log.md`.
   *
   * Use case: weekly maintenance run, or post-batch-ingest. Scans
   * recently-changed wiki notes, groups by tags/folder into clusters,
   * regenerates the top-level index with table of contents + concept
   * clusters + "Recent" section, then appends a chronological compile-log
   * entry. Idempotent — safe to re-run.
   *
   * Args: `since_minutes` (string, optional, default `"10080"` = 7 days),
   * `wiki_folder` (string, optional, default `"Wiki/"`).
   */
  // === vault_wiki_compile ==============================================
  server.registerPrompt(
    "vault_wiki_compile",
    {
      title: "Compile vault index + log (Karpathy-style maintenance)",
      description:
        "The LLM-Wiki maintenance step: scan the vault for new/updated notes since last compile, regenerate the top-level `index.md` (table of contents + concept clusters) and append to `log.md` (a chronological compile-log). Run weekly or after a batch ingest. Idempotent.",
      argsSchema: {
        since_minutes: z.string().optional().describe("Window for 'recently changed' notes (default 10080 = 7 days)"),
        wiki_folder: z.string().optional().describe("Wiki folder root (default 'Wiki/')")
      }
    },
    ({ since_minutes, wiki_folder }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Karpathy LLM-Wiki **compile** workflow.

Step 1 — Scan recent changes:
- \`obsidian_get_recent_edits since_minutes=${since_minutes ?? 10080} folder=${wiki_folder ?? "Wiki"}\`
- For each, \`obsidian_read_note format=map\` to get headings + frontmatter only (cheap).

Step 2 — Regenerate index.md:
- Group notes by frontmatter \`tags\` and by folder.
- For each cluster (≥3 notes), produce a heading + bullet list of \`[[wikilinks]]\` to the cluster members.
- Add a "Recent" section listing the 10 most recently modified.
- Use \`obsidian_validate_note_proposal\` to catch any broken wikilinks BEFORE writing.
- Write via \`obsidian_create_note overwrite=true\` to \`${wiki_folder ?? "Wiki"}/index.md\`.

Step 3 — Append to log.md:
- A bullet per note touched in the window: \`- 2026-05-08 — [[NoteTitle]] (created|updated): one-line summary\`
- Append via \`obsidian_append_to_note\`. The log accumulates compile history.

Step 4 — Surface gaps:
- Run \`obsidian_lint_wiki\` to enumerate orphans / broken / stubs / stale.
- Add the gap summary to the bottom of \`index.md\` so the next compile sees it.

Idempotent. Re-run weekly.`
          }
        }
      ]
    })
  );

  /**
   * Deeper-than-structural vault lint — contradictions, stale claims,
   * missing cross-references.
   *
   * Use case: monthly deep audit on top of `lint_wiki`'s structural pass.
   * Four phases:
   * 1. Structural lint via `obsidian_lint_wiki`.
   * 2. Semantic contradictions: paraphrase claims to their negation,
   *    search for multi-ranker consensus on the opposite (`min_signals=2`).
   * 3. Stale claims: scan body for date patterns + present-tense markers
   *    ("current" / "latest" / "now"), flag if > 6 months old.
   * 4. Missing cross-references: titles mentioned in plain text without
   *    `[[brackets]]`.
   *
   * Output is a single markdown report with sections per phase + top 5
   * highest-leverage fixes.
   *
   * Args: `folder` (string, optional).
   */
  // === vault_lint_extended =============================================
  server.registerPrompt(
    "vault_lint_extended",
    {
      title: "Extended vault lint (orphans + contradictions + stale claims + missing cross-refs)",
      description:
        "Beyond the structural lint of `obsidian_lint_wiki`: this prompt sequences a deeper inspection — contradictions across notes (semantic search for opposing claims), stale claims (notes with date references > 6mo old), missing cross-references (notes that mention an entity by name without `[[wikilinking]]` to its wiki page).",
      argsSchema: {
        folder: z.string().optional().describe("Restrict to a folder (default whole vault)")
      }
    },
    ({ folder }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Extended lint pass on${folder ? ` ${folder}` : " the whole vault"}.

Phase 1 — structural (\`obsidian_lint_wiki${folder ? ` folder=${folder}` : ""}\`):
- Surface orphans / broken / stubs / stale per the existing tool. Skim the report.

Phase 2 — semantic contradictions:
- For each top-30 note (by recent-edits window), pick 1-2 strong claims (declarative sentences in the body).
- For each claim, run \`obsidian_search query="<claim paraphrased to negate>" min_signals=2\` — multi-ranker consensus on the OPPOSITE statement.
- If a hit comes back with score > 0.04, flag as a potential contradiction. Output: A says X, B says ¬X, suggest reconciliation.

Phase 3 — stale claims:
- For each note, scan body for date patterns (\`/\\b(20\\d{2})-\\d{2}-\\d{2}\\b/\` or \`/\\b(20\\d{2})\\b/\` with words like "current"/"latest"/"now"/"upcoming").
- If the date is > 6 months old, surface as "potentially stale: <note> claims X with date Y".

Phase 4 — missing cross-references:
- For each top-15 note, get its outbound \`[[wikilinks]]\` (via \`obsidian_get_outbound_links\`).
- Read the body. Check for wiki page TITLES (use \`obsidian_list_notes\` for the list) mentioned in plain text WITHOUT \`[[\` brackets.
- For each, propose a rewrite that adds the brackets. \`obsidian_validate_note_proposal\` first.

Output: a single markdown report with sections per phase. End with the top 5 highest-leverage fixes.`
          }
        }
      ]
    })
  );

  /**
   * Mem.ai-style "write don't organize" capture — file a quick thought
   * intelligently with user approval.
   *
   * Use case: pasting a transient thought without manually filing it.
   * Decision tree:
   * 1. Daily? (conversational / time-bound) → append to today's daily note.
   * 2. Continues an existing note? (top hit score > 0.05) → propose
   *    append.
   * 3. New wiki page? (1-3 distinct concepts) → run `vault_synth`.
   * 4. Inbox catch-all → `Inbox/<timestamp>-<3-word-slug>.md`.
   *
   * Always validates via `obsidian_validate_note_proposal`, shows the diff,
   * asks for user approval before writing.
   *
   * Args: `text` (string, required), `target_hint` (string, optional —
   * `"daily"` / `"new-note"` / a path/topic).
   */
  // === vault_capture ===================================================
  server.registerPrompt(
    "vault_capture",
    {
      title: "Capture a quick thought into the vault (write don't organize)",
      description:
        "Mem.ai-style 'write don't organize' UX: the user pastes a thought; we file it intelligently. Auto-detect destination (today's daily note vs new wiki page vs append to most-relevant existing note via hybrid search) and propose a diff for user approval before writing.",
      argsSchema: {
        text: z.string().describe("The thought to capture — free-form text"),
        target_hint: z
          .string()
          .optional()
          .describe("Optional hint: 'daily', 'new-note', or a path/topic to bias destination")
      }
    },
    ({ text, target_hint }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Capture this thought into my vault, Mem.ai-style: figure out where it goes, propose a diff, ask before writing.

Thought:
\`\`\`
${text}
\`\`\`

Hint: ${target_hint ?? "(none — auto-detect)"}

Decision tree:

1. **Daily?** If thought is conversational / reflective / time-bound (uses words like "today", "yesterday", "I'm thinking about", "TIL"), propose APPEND to today's daily note via \`obsidian_read_note title="today"\` → \`obsidian_append_to_note\`.

2. **Continues an existing note?** Run \`obsidian_search query="<thought first 200 chars>" limit=5\`. If top hit has score > 0.05, propose APPEND to that note. Show the user: "this looks related to [[NoteTitle]] — append there?"

3. **New wiki page?** If thought contains 1-3 distinct concepts that don't have existing notes, run \`vault_synth\` workflow on it.

4. **Inbox catch-all.** If steps 1-3 give nothing high-confidence, propose \`obsidian_create_note path="Inbox/<timestamp>-<3-word-slug>.md"\`.

5. **Show diff, ask, then write.** Always preview the proposed write to the user. Use \`obsidian_validate_note_proposal\` first. Write only after explicit approval.

Goal: zero filing burden on the user. The AI does the indexing.`
          }
        }
      ]
    })
  );

  // v2.5.0 — agentic prompts (Khoj parity, lite scope).
  // Agent personas + scheduled automations as prompts that orchestrate
  // existing tools. Pure agent-side: no server-side state, no LLM calls.
  // HTTP transport is a separate larger-scope sprint (planned post v2.5).

  /**
   * Khoj-style persona-scoped vault search — folder-scoped retrieval with
   * persona-tuned response framing.
   *
   * Use case: distinct "agents" over distinct vault zones — "research-
   * assistant" over `Research/` (cites sources, ignores drafts) vs.
   * "editor" over `Drafts/` (flags contradictions, surfaces structure).
   * Pure prompt template — orchestrates existing search tools with a
   * fixed scope and persona-specific instructions.
   *
   * Args: `persona` (string, required — persona name + traits),
   * `folder` (string, required), `query` (string, required).
   */
  // === vault_persona_search ============================================
  server.registerPrompt(
    "vault_persona_search",
    {
      title: "Search the vault as a named persona (folder-scoped + tuned)",
      description:
        "Khoj-style agent persona pattern: scope retrieval to a folder + apply a persona-specific lens to the response. Useful when you want 'research-assistant' behavior over `Research/` distinct from 'editor' over `Drafts/`. Pure prompt template — orchestrates existing search tools with a fixed scope/instructions.",
      argsSchema: {
        persona: z
          .string()
          .describe("Persona name + traits (e.g. 'research-assistant: cite sources, ignore drafts, tldr first')"),
        folder: z.string().describe("Folder to scope retrieval to (vault-relative)"),
        query: z.string().describe("The user's question")
      }
    },
    ({ persona, folder, query }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Acting as **${persona}**, with retrieval scoped to \`${folder}\`.

User question: ${query}

Steps:

1. \`obsidian_search query="${query}" folder="${folder}" limit=15\` — hybrid retrieval inside the persona's scope.
2. For each top-3 hit, \`obsidian_read_note\` to load the body.
3. Synthesize the answer through the persona's lens (e.g. research-assistant cites every claim with \`[[wikilinks]]\`; editor flags contradictions; project-PM extracts deliverables).
4. End with **3 follow-up questions** the user might ask next (use the persona's intent — research-assistant: "should I cite paper X?"; editor: "want me to flag the inconsistency between A and B?").

Stay in the persona for the entire response. If asked something out-of-scope (e.g. research-assistant asked about cooking), politely redirect.`
          }
        }
      ]
    })
  );

  /**
   * Khoj-style automation setup — wire up a cron'd vault query that lands
   * in a daily note or digest.
   *
   * Use case: "every Monday at 9am, surface last week's edits and
   * unresolved questions". Bridges enquire-mcp tools + the host's
   * `scheduled-tasks` MCP (or any cron tool the agent has access to).
   * Five steps: parse intent → propose JSON spec → user confirms →
   * register via `mcp__scheduled-tasks__create_scheduled_task` →
   * smoke-run once to verify output shape.
   *
   * Args: `intent` (string, required — natural-language description of
   * the automation, including cadence + source + sink).
   */
  // === vault_automation_setup ==========================================
  server.registerPrompt(
    "vault_automation_setup",
    {
      title: "Set up a scheduled vault query (Khoj-style automations)",
      description:
        "Walks you through creating a cron'd vault query whose results land as a daily note or get appended to a digest. Bridges enquire-mcp tools + the host's `scheduled-tasks` MCP (or any cron tool the agent has access to). Pure orchestration — no server-side state.",
      argsSchema: {
        intent: z
          .string()
          .describe(
            "What you want automated (e.g. 'every Monday 9am, show me all notes touched last week and highlight unresolved questions')"
          )
      }
    },
    ({ intent }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `User wants this automation: "${intent}"

Steps:

1. **Parse the intent.** Identify:
   - **Cadence:** cron expression (daily/weekly/monthly + time)
   - **Source:** which obsidian tool answers this? (\`get_recent_edits\`, \`obsidian_search\`, \`lint_wiki\`, \`paper_audit\`, etc.)
   - **Sink:** how does the user want results? (a) append to today's daily note via \`append_to_note\`; (b) create a new note in \`Automations/\`; (c) just notify

2. **Propose the automation as a JSON spec.** Example:
   \`\`\`json
   {
     "name": "weekly-review",
     "cron": "0 9 * * 1",
     "tool_sequence": [
       { "tool": "obsidian_get_recent_edits", "args": { "since_minutes": 10080 } },
       { "tool": "obsidian_open_questions", "args": { "limit": 20 } }
     ],
     "sink": { "type": "append_to_note", "path": "Daily/{{today}}.md", "header": "## Weekly review" }
   }
   \`\`\`

3. **Show the spec, ask user to confirm.**

4. **Register via the host's scheduled-tasks MCP** (if available) or output the cron config for manual paste. \`mcp__scheduled-tasks__create_scheduled_task\` is the standard target.

5. **Smoke once.** Before the first scheduled run, execute the tool sequence ONCE manually so the user verifies output shape. Show the produced markdown.

This is the Khoj automation pattern translated to MCP: research that comes to you instead of you remembering to ask for it.`
          }
        }
      ]
    })
  );

  // v3.1.0 — sub-question decomposition / agentic retrieval. Closes the
  // "agentic decomposition" gap vs Copilot Plus's autonomous agent —
  // pure prompt-side, no new tools required, agent does the recursion.
  /**
   * Multi-hop research via sub-question decomposition — agentic-RAG
   * pattern translated to vault search.
   *
   * Use case: complex questions that hide multiple lookups (e.g. "what
   * are the trade-offs between BM25 and embeddings for my use case?").
   * Single-shot RRF retrieves the most plausible chunk but misses the
   * chunks that answer the sub-parts. Decomposition surfaces them all
   * and forces evidence-grounded synthesis.
   *
   * Workflow: decompose → per-sub `obsidian_search` (or `obsidian_hyde_search`
   * if available) → extract atomic evidence → compose answer with citations
   * → flag any sub-question the vault didn't answer as an "open question".
   *
   * Args: `question` (string, required — the complex / multi-hop question),
   * `max_sub_questions` (string, optional, default `"3-5"`).
   */
  // === vault_research ==================================================
  server.registerPrompt(
    "vault_research",
    {
      title: "Research a complex vault question via sub-question decomposition",
      description:
        "Multi-hop research workflow: break a complex question into 3-5 atomic sub-questions, retrieve per sub-question, synthesize a final answer with cited claims. Closes the gap to agentic-RAG patterns (sub-question decomposition + ReAct) without forcing the server to make LLM calls — the agent handles the decomposition.",
      argsSchema: {
        question: z.string().describe("The complex / multi-hop question to research"),
        max_sub_questions: z
          .string()
          .optional()
          .describe("Cap on sub-questions to expand (default 5; keep small to control tool budget)")
      }
    },
    ({ question, max_sub_questions }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Research this question against my Obsidian vault using **sub-question decomposition**:

> ${question}

Steps:

1. **Decompose.** Break the question into ${max_sub_questions ?? "3-5"} atomic sub-questions, each independently searchable. Format:
   \`\`\`
   sub_q1: <single-fact / single-relationship question>
   sub_q2: <...>
   ...
   \`\`\`
   Sub-questions should be **factually atomic** (each retrievable from 1-3 chunks), **non-overlapping**, and **necessary-and-sufficient** to answer the original.

2. **Per-sub retrieval.** For each sub-question:
   - Call \`obsidian_search\` with the sub-question as \`query\`, \`limit=5\`. Use \`graph_boost=true\` (default).
   - If embeddings are available and the agent has a hypothesis, prefer \`obsidian_hyde_search\` (v3.1.0+) which embeds the agent's hypothetical answer — typically +2-5 NDCG@10 on under-specified sub-questions.
   - Read the top 1-2 hits via \`obsidian_read_note\`.
   - Extract the single bullet of evidence that answers the sub-question. Cite path + line range.

3. **Synthesize.** Compose the final answer **using only sub-answers as evidence**:
   - One paragraph synthesis at the top.
   - Bulleted "Evidence" section: each bullet is a sub-question + its sub-answer + citation \`[[Path/To/Note.md#L23-L27]]\`.
   - "Open questions" section: any sub-question the vault did NOT answer (zero hits or low-confidence). These are the gaps for future ingest.

4. **(Optional) Persist.** Ask the user if they want this filed as a research note. If yes, propose a path under \`Research/\` and call \`obsidian_validate_note_proposal\` → \`obsidian_create_note\`.

Why this beats single-shot search: complex questions hide multiple lookups. Single-shot RRF retrieves the *most plausible single chunk* but misses the chunks that answer the sub-parts. Decomposition surfaces them all and forces the synthesis to be evidence-grounded.`
          }
        }
      ]
    })
  );

  // v3.1.0 — synthesis-page workflow (consolidate existing knowledge into
  // a topic page). Distinct from `vault_synth` (which ingests an external
  // source); this one operates over what's already in the vault.
  /**
   * Karpathy LLM-Wiki **synthesis** workflow — consolidate scattered
   * existing notes into a single topic page.
   *
   * Use case: when the vault has enough scattered notes about a topic
   * that a consolidated overview would help. Surveys via
   * `obsidian_search`, extracts per-source bullets (definition,
   * comparison, examples, caveats, see-also), reconciles across sources
   * (deduplicate, flag contradictions), composes a structured wiki page
   * with citations, validates, asks user, writes via `obsidian_create_note`.
   *
   * Distinct from `vault_synth` (which ingests external sources rather
   * than synthesizing existing vault content).
   *
   * Args: `topic` (string, required), `target_path` (string, optional,
   * default `"Wiki/<Topic>.md"`).
   */
  // === vault_synthesis_page ============================================
  server.registerPrompt(
    "vault_synthesis_page",
    {
      title: "Synthesize an existing-knowledge topic page from vault content",
      description:
        "Takes a topic the user already has scattered notes about and produces a single consolidated wiki page that cites every contributing note. Karpathy LLM-Wiki **synthesis** loop (vs `vault_synth` which is the *ingest* loop).",
      argsSchema: {
        topic: z.string().describe("The topic to synthesize a wiki page for (e.g. 'BM25 vs TF-IDF')"),
        target_path: z.string().optional().describe("Where the synthesis page should land (default 'Wiki/<Topic>.md')")
      }
    },
    ({ topic, target_path }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Synthesize an existing-knowledge wiki page for: **${topic}**

Steps:

1. **Survey.** Call \`obsidian_search\` with \`query="${topic}"\`, \`limit=20\`, \`graph_boost=true\`. These are your candidate sources.

2. **Read + extract.** For each top-10 hit, call \`obsidian_read_note\`. Extract:
   - Definitional claims (what it IS)
   - Comparative claims (vs neighbors)
   - Examples / case studies
   - Caveats / known limitations
   - References / outbound \`[[wikilinks]]\` (those are your "see also" candidates)

3. **Reconcile.** Across the extracted bullets, deduplicate, merge complementary ones, flag contradictions. Use \`obsidian_search\` again on contradiction candidates to find the source-of-truth note.

4. **Compose.** Produce a single markdown body in this structure:
   \`\`\`markdown
   # ${topic}

   ## Definition
   <1-2 sentences, every clause cited inline>

   ## Key properties
   - <bullet> — \`[[source-note]]\`
   - ...

   ## Comparisons
   <table or bullets contrasting with neighbors, each row cited>

   ## Examples
   - <example> — \`[[source-note]]\`

   ## Caveats / open questions
   - <bullet>

   ## See also
   - \`[[wikilink]]\` — why it's related
   \`\`\`

5. **Validate.** Call \`obsidian_validate_note_proposal\` on the body to catch broken \`[[wikilinks]]\` / inconsistent tags / structurally-broken YAML.

6. **Write.** With user approval, \`obsidian_create_note\` at \`${target_path ?? `Wiki/${topic}.md`}\`. Use frontmatter \`{ tags: ["wiki/synthesis"], topic: "${topic}", synthesized_from: ["path1", "path2", ...] }\`.

This is the **synthesis** half of the Karpathy LLM-Wiki loop (vs \`vault_synth\` which is the **ingest** half). Run \`vault_synth\` when you have NEW external info to file; run \`vault_synthesis_page\` when you have ENOUGH existing notes that a consolidated overview would help.`
          }
        }
      ]
    })
  );
}
