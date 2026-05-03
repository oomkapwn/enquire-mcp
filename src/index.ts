#!/usr/bin/env node
import { realpathSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Command } from "commander";
import { z } from "zod";
import { defaultIndexFile, FtsIndex } from "./fts5.js";
import {
  appendToNote,
  createNote,
  dataviewQuery,
  getBacklinks,
  getOutboundLinks,
  getRecentEdits,
  getUnresolvedWikilinks,
  listNotes,
  listTags,
  readNote,
  resolveWikilink,
  searchText
} from "./tools.js";
import { Vault } from "./vault.js";

const VERSION = "0.9.0";

interface ServeOptions {
  vault: string;
  enableWrite?: boolean;
  maxFileBytes?: string;
  cacheSize?: string;
  persistentCache?: boolean;
  cacheFile?: string;
  persistentIndex?: boolean;
  indexFile?: string;
  tokenize?: "unicode61" | "trigram";
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .name("enquire-mcp")
    .description("enquire — MCP server for Obsidian vaults. Named after Tim Berners-Lee's 1980 prototype of the WWW.")
    .version(VERSION);

  program
    .command("serve", { isDefault: true })
    .description("Start the MCP server over stdio")
    .requiredOption("--vault <path>", "Path to the Obsidian vault root")
    .option("--enable-write", "Enable write tools (create_note, append_to_note). Off by default.")
    .option("--max-file-bytes <n>", "Max bytes for any single file read/write (default 5MB)")
    .option("--cache-size <n>", "Max parsed-note cache entries (default 1024)")
    .option("--persistent-cache", "Persist parsed-note cache to disk so cold starts skip re-parsing")
    .option("--cache-file <path>", "Override the persistent-cache file location")
    .option(
      "--persistent-index",
      "Maintain a SQLite FTS5 inverted index for sub-100ms BM25-ranked search. Registers obsidian_full_text_search."
    )
    .option("--index-file <path>", "Override the FTS5 index file location")
    .option(
      "--tokenize <mode>",
      "FTS5 tokenize mode: 'unicode61' (default; Latin/Cyrillic) or 'trigram' (CJK/mixed-script)"
    )
    .action(async (opts: ServeOptions) => {
      await startServer(opts);
    });

  program
    .command("clear-cache")
    .description("Delete the persistent-cache file for a given vault")
    .requiredOption("--vault <path>", "Vault whose cache to delete")
    .option("--cache-file <path>", "Override the persistent-cache file location")
    .action(async (opts: { vault: string; cacheFile?: string }) => {
      const vault = new Vault(opts.vault, { persistentCache: true, cacheFile: opts.cacheFile });
      await vault.ensureExists();
      const removed = await vault.clearDiskCache();
      if (removed) {
        process.stdout.write(`enquire: removed cache file ${vault.cacheFile}\n`);
      } else {
        process.stdout.write(`enquire: no cache file at ${vault.cacheFile}\n`);
      }
    });

  program
    .command("index")
    .description(
      "Cold-build (or refresh) the FTS5 search index for a vault. Useful before first --persistent-index use."
    )
    .requiredOption("--vault <path>", "Path to the Obsidian vault root")
    .option("--index-file <path>", "Override the FTS5 index file location")
    .option("--tokenize <mode>", "FTS5 tokenize mode: 'unicode61' (default) or 'trigram'")
    .action(async (opts: { vault: string; indexFile?: string; tokenize?: "unicode61" | "trigram" }) => {
      const tokenize = opts.tokenize === "trigram" ? "trigram" : "unicode61";
      const vault = new Vault(opts.vault);
      await vault.ensureExists();
      const indexFile = opts.indexFile ?? defaultIndexFile(vault.root);
      const idx = new FtsIndex({ file: indexFile, vaultRoot: vault.root, tokenize });
      await idx.open();
      try {
        const report = await syncFtsIndex(vault, idx);
        process.stdout.write(
          `enquire: index ${indexFile} — added=${report.added} updated=${report.updated} deleted=${report.deleted} unchanged=${report.unchanged} total_chunks=${report.total_chunks}\n`
        );
      } finally {
        idx.close();
      }
    });

  await program.parseAsync(process.argv);
}

async function startServer(opts: ServeOptions): Promise<void> {
  const vault = new Vault(opts.vault, {
    enableWrite: !!opts.enableWrite,
    maxFileBytes: opts.maxFileBytes !== undefined ? parsePositiveInt(opts.maxFileBytes, "--max-file-bytes") : undefined,
    maxCacheEntries: opts.cacheSize !== undefined ? parsePositiveInt(opts.cacheSize, "--cache-size") : undefined,
    persistentCache: !!opts.persistentCache,
    cacheFile: opts.cacheFile
  });
  await vault.ensureExists();

  // Optional FTS5 index. Sync on boot so the first MCP call sees a fresh
  // index. For typical vault sizes this is sub-second; cold-build of a fresh
  // 1k-file vault is ~5s.
  let ftsIndex: FtsIndex | null = null;
  if (opts.persistentIndex) {
    const tokenize = opts.tokenize === "trigram" ? "trigram" : "unicode61";
    const indexFile = opts.indexFile ?? defaultIndexFile(vault.root);
    ftsIndex = new FtsIndex({ file: indexFile, vaultRoot: vault.root, tokenize });
    await ftsIndex.open();
    await syncFtsIndex(vault, ftsIndex);
  }

  const server = new McpServer({
    name: "enquire",
    version: VERSION
  });

  registerReadTools(server, vault);
  if (vault.writeEnabled) registerWriteTools(server, vault);
  if (ftsIndex) registerFtsTools(server, ftsIndex);
  registerResources(server, vault);
  registerPrompts(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  if (vault.persistentCacheEnabled) {
    let saving = false;
    let saved = false;
    const flush = async () => {
      if (saving || saved) return;
      saving = true;
      try {
        await vault.saveDiskCache();
        saved = true;
      } catch (err) {
        process.stderr.write(`enquire: cache flush failed — ${err instanceof Error ? err.message : String(err)}\n`);
      } finally {
        saving = false;
      }
    };
    const onSignal = () => {
      flush().finally(() => process.exit(0));
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    // beforeExit fires when the loop empties; we schedule one async flush.
    // The `saved` guard prevents recursion when flush completes and beforeExit fires again.
    process.on("beforeExit", () => {
      if (!saved && !saving) void flush();
    });
  }

  const writeMode = vault.writeEnabled ? "WRITE-ENABLED" : "read-only";
  const cacheMode = vault.persistentCacheEnabled ? `, persistent-cache=${vault.cacheFile}` : "";
  const ftsMode = ftsIndex ? `, fts5-index (${ftsIndex.totalFiles()} files / ${ftsIndex.totalChunks()} chunks)` : "";
  process.stderr.write(`enquire ${VERSION} ready (${writeMode}, vault=${vault.root}${cacheMode}${ftsMode})\n`);

  if (ftsIndex) {
    const closeFts = () => ftsIndex?.close();
    process.once("SIGINT", closeFts);
    process.once("SIGTERM", closeFts);
    process.on("beforeExit", closeFts);
  }
}

async function syncFtsIndex(
  vault: Vault,
  idx: FtsIndex
): Promise<{ added: number; updated: number; deleted: number; unchanged: number; total_chunks: number }> {
  const entries = await vault.listMarkdown();
  const live = entries.map((e) => ({ relPath: e.relPath, mtimeMs: e.mtimeMs }));
  const diff = idx.diff(live);
  for (const relPath of diff.deleted) idx.dropFile(relPath);
  for (const relPath of [...diff.added, ...diff.updated]) {
    const entry = entries.find((e) => e.relPath === relPath);
    if (!entry) continue;
    try {
      const note = await vault.readNote(entry.absPath, entry.mtimeMs);
      const wikilinkTargets = note.parsed.wikilinks.map((w) => w.target).filter((t) => t.length > 0);
      idx.reindexFile(relPath, entry.mtimeMs, note.content, wikilinkTargets);
    } catch (err) {
      process.stderr.write(
        `enquire: skipping ${relPath} during fts5 sync — ${err instanceof Error ? err.message : String(err)}\n`
      );
    }
  }
  return {
    added: diff.added.length,
    updated: diff.updated.length,
    deleted: diff.deleted.length,
    unchanged: diff.unchanged.length,
    total_chunks: idx.totalChunks()
  };
}

function registerFtsTools(server: McpServer, idx: FtsIndex): void {
  const READ_ONLY = { readOnlyHint: true, idempotentHint: true, openWorldHint: false } as const;
  server.registerTool(
    "obsidian_full_text_search",
    {
      title: "Full-text search (BM25, FTS5 index)",
      description:
        "BM25-ranked full-text search backed by a SQLite FTS5 inverted index. Sub-100ms on multi-thousand-note vaults. Returns chunk-level hits with snippet excerpts. Hyphenated tokens (e.g. `claude-telegram`) are auto-quoted. Use `obsidian_search_text` instead if the index isn't built yet — this tool is only registered when the server is started with `--persistent-index`.",
      annotations: { ...READ_ONLY, title: "Full-text search" },
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe(
            "Search query. Whitespace-tokenized; FTS5 BM25 matching with `unicode61` (default) or `trigram` tokenizer."
          ),
        folder: z.string().optional().describe("Restrict to a subfolder (vault-relative)"),
        limit: z.number().int().positive().max(200).optional().describe("Max hits (default 25)")
      }
    },
    async (args) =>
      textResult({
        query: args.query,
        total_chunks: idx.totalChunks(),
        total_files: idx.totalFiles(),
        matches: idx.search(args.query, { limit: args.limit, folder: args.folder })
      })
  );
}

function registerReadTools(server: McpServer, vault: Vault): void {
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
        "Read a note by relative path or by title (filename without .md). Returns content, frontmatter, wikilinks, embeds, tags, mtime.",
      annotations: { ...READ_ONLY, title: "Read note" },
      inputSchema: {
        path: z.string().optional().describe("Path relative to vault root, with or without .md"),
        title: z.string().optional().describe("Note title (filename without .md)")
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
        query: z.string().min(1).describe("Dataview-style query string")
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
}

function registerWriteTools(server: McpServer, vault: Vault): void {
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
        path: z.string().describe("Vault-relative path (e.g. 'Inbox/My Note' or 'Inbox/My Note.md')"),
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
}

function registerResources(server: McpServer, vault: Vault): void {
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

function registerPrompts(server: McpServer): void {
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
}

function parsePositiveInt(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new Error(`${flag} must be a positive integer; got "${raw}"`);
  }
  return n;
}

function encodeNotePath(relPath: string): string {
  return relPath.split(path.sep).map(encodeURIComponent).join("/");
}

function decodeNotePath(uriPath: string): string {
  return uriPath.split("/").map(decodeURIComponent).join("/");
}

function textResult(payload: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }]
  };
}

const isCliEntry = (() => {
  if (!process.argv[1]) return false;
  try {
    // Both sides via realpath — npm installs the binary as a symlink in
    // `node_modules/.bin/`, and on macOS `/tmp` is itself a symlink to
    // `/private/tmp`. Without realpath on argv[1], the comparison fails and
    // main() never runs (silent exit 0). Regression test in tests/cli.test.ts.
    const meta = realpathSync(fileURLToPath(import.meta.url));
    const argv = realpathSync(process.argv[1]);
    return meta === argv;
  } catch {
    return false;
  }
})();

if (isCliEntry) {
  main().catch((err) => {
    process.stderr.write(`enquire fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  });
}

export { main, parsePositiveInt, startServer };
