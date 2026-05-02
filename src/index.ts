#!/usr/bin/env node
import { Command } from "commander";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Vault } from "./vault.js";
import {
  listNotes,
  readNote,
  resolveWikilink,
  searchText,
  getRecentEdits
} from "./tools.js";

const VERSION = "0.1.0";

async function main(): Promise<void> {
  const program = new Command();
  program
    .name("obsidian-mcp")
    .description("MCP server for reading Obsidian vaults")
    .version(VERSION);

  program
    .command("serve", { isDefault: true })
    .description("Start the MCP server over stdio")
    .requiredOption("--vault <path>", "Path to the Obsidian vault root")
    .action(async (opts: { vault: string }) => {
      await startServer(opts.vault);
    });

  await program.parseAsync(process.argv);
}

async function startServer(vaultPath: string): Promise<void> {
  const vault = new Vault(vaultPath);
  await vault.ensureExists();

  const server = new McpServer({
    name: "obsidian-mcp",
    version: VERSION
  });

  server.registerTool(
    "obsidian_list_notes",
    {
      title: "List notes",
      description:
        "List notes in the vault. Filter by tag, folder, or modified-since date. Returns title, path, frontmatter, tags, and mtime.",
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
        "Read a note by relative path or by title (filename without .md). Returns content, frontmatter, wikilinks, and tags.",
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
        "Resolve an Obsidian [[wikilink]] to a vault file. Handles aliases (Note|alias), sections (Note#Heading), and block refs (Note^block).",
      inputSchema: {
        wikilink: z.string().describe("Wikilink target (e.g. 'Note Name', 'Note#Heading', 'Folder/Note|alias')"),
        from_note: z.string().optional().describe("Calling note's relative path (used to disambiguate same-name files)"),
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
        "Case-insensitive substring search across all notes. Returns ranked matches with snippets.",
      inputSchema: {
        query: z.string().min(1).describe("Search string (case-insensitive substring)"),
        folder: z.string().optional().describe("Restrict to a subfolder"),
        limit: z.number().int().positive().max(200).optional().describe("Max results (default 25)")
      }
    },
    async (args) => textResult(await searchText(vault, args))
  );

  server.registerTool(
    "obsidian_get_recent_edits",
    {
      title: "Get recent edits",
      description:
        "List notes ordered by most recent modification. Useful for picking up where work was left off.",
      inputSchema: {
        since_minutes: z.number().int().positive().optional().describe("Only notes edited within this many minutes"),
        folder: z.string().optional().describe("Restrict to a subfolder"),
        limit: z.number().int().positive().max(200).optional().describe("Max results (default 20)")
      }
    },
    async (args) => textResult(await getRecentEdits(vault, args))
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`obsidian-mcp ${VERSION} ready (vault=${vault.root})\n`);
}

function textResult(payload: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }]
  };
}

main().catch((err) => {
  process.stderr.write(`obsidian-mcp fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
