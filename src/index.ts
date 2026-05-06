#!/usr/bin/env node
import { realpathSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Command } from "commander";
import { z } from "zod";
import { EmbedDb } from "./embed-db.js";
import { DEFAULT_MODEL_ALIAS, EMBEDDING_MODELS, loadEmbedder, resolveModel } from "./embeddings.js";
import { chunkContent, defaultIndexFile, FtsIndex } from "./fts5.js";
import {
  appendToNote,
  archiveNote,
  createNote,
  dataviewQuery,
  embeddingsSearch,
  findPath,
  findSimilar,
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
  listTags,
  openInUi,
  paperAudit,
  readCanvas,
  readNote,
  renameNote,
  replaceInNotes,
  resolveWikilink,
  searchText,
  semanticSearch,
  validateNoteProposal
} from "./tools.js";
import { Vault } from "./vault.js";
import { VaultWatcher } from "./watcher.js";

const VERSION = "2.0.0-alpha.0";

/** Default location for the persistent embedding index, alongside .fts5.db. */
function embedDbPath(vaultRoot: string): string {
  // Match the FTS5 location convention by stripping the .fts5.db extension
  // off defaultIndexFile() and appending .embed.db.
  return defaultIndexFile(vaultRoot).replace(/\.fts5\.db$/, ".embed.db");
}

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
  excludeGlob?: string[];
  readPaths?: string[];
  watch?: boolean;
  disabledTools?: string[];
  enabledTools?: string[];
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
    .option(
      "--enable-write",
      "Enable the five write tools (create_note, append_to_note, rename_note, replace_in_notes, archive_note). Off by default."
    )
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
    .option(
      "--exclude-glob <pattern...>",
      "Glob pattern(s) — paths matching any pattern are invisible to all tools and refuse direct reads. Supports `*`, `**`, `?`. Repeatable. Example: `--exclude-glob '02_Personal/**' '*.private.md'`."
    )
    .option(
      "--read-paths <pattern...>",
      "Strict allowlist — when set, ONLY paths matching one of these glob patterns are visible. Complement to --exclude-glob (denylist). If both are set: a path must match an allow-glob AND not match any exclude-glob. Same glob semantics as --exclude-glob (`*`, `**`, `?`). Repeatable. Example: `--read-paths '01_Projects/**' '99_Daily/**'`."
    )
    .option(
      "--watch",
      "Watch the vault for .md add/change/unlink events and incrementally invalidate the parsed-note cache (and refresh the FTS5 index when --persistent-index is also enabled). Off by default. Use this for long-running servers where you keep editing in Obsidian and want search to stay fresh without restarting."
    )
    .option(
      "--disabled-tools <name...>",
      "Skip registration of specific tools by exact name. Useful when you want to expose a smaller surface to a particular agent (e.g. read-only research agent gets only obsidian_search_text + obsidian_read_note). Repeatable. Names are the same as in `tools/list` — `obsidian_*`. Example: `--disabled-tools obsidian_dataview_query obsidian_full_text_search`."
    )
    .option(
      "--enabled-tools <name...>",
      "Strict allowlist — when set, ONLY listed tools register. Complement to --disabled-tools (denylist). If both are set: a tool must be in the allowlist AND not in the denylist. Repeatable. Example: `--enabled-tools obsidian_search_text obsidian_read_note obsidian_get_recent_edits`."
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
    .command("clear-index")
    .description("Delete the FTS5 search-index files (.fts5.db + WAL/SHM sidecar) for a given vault")
    .requiredOption("--vault <path>", "Vault whose index to delete")
    .option("--index-file <path>", "Override the FTS5 index file location")
    .action(async (opts: { vault: string; indexFile?: string }) => {
      const vault = new Vault(opts.vault);
      await vault.ensureExists();
      const indexFile = opts.indexFile ?? defaultIndexFile(vault.root);
      const idx = new FtsIndex({ file: indexFile, vaultRoot: vault.root });
      const removed = await idx.clearOnDisk();
      if (removed) {
        process.stdout.write(`enquire: removed fts5 index files at ${indexFile}\n`);
      } else {
        process.stdout.write(`enquire: no fts5 index files at ${indexFile}\n`);
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

  // v2.0 alpha — ML embeddings subcommands.
  program
    .command("install-model")
    .description(
      `Pre-download an embedding model so the first \`obsidian_embeddings_search\` call doesn't block on a ${EMBEDDING_MODELS[DEFAULT_MODEL_ALIAS]?.approxSizeMB}MB HuggingFace download. Models are cached under ~/.cache/huggingface/transformers.js/ and are reused across vaults.`
    )
    .argument("[alias]", `Model alias (${Object.keys(EMBEDDING_MODELS).join(" | ")})`, DEFAULT_MODEL_ALIAS)
    .action(async (alias: string) => {
      const model = resolveModel(alias);
      process.stderr.write(
        `enquire: downloading ${model.hfId} (~${model.approxSizeMB}MB; ${model.dim}-dim, ${
          model.multilingual ? "multilingual" : "English-only"
        })...\n`
      );
      const t0 = Date.now();
      // Loading the embedder triggers the transformers.js model download +
      // local cache write. We don't actually run inference — just verify the
      // pipeline initializes successfully.
      const embedder = await loadEmbedder(alias);
      // Smoke: embed one tiny string so any ONNX-runtime failure surfaces here
      // rather than at first MCP call.
      const [vec] = await embedder.embed(["hello"]);
      if (!vec || vec.length !== model.dim) {
        throw new Error(`Model loaded but produced unexpected output dim=${vec?.length}`);
      }
      process.stdout.write(
        `enquire: model ${alias} ready (${model.dim}-dim, ${Date.now() - t0}ms warmup, cached under ~/.cache/huggingface/)\n`
      );
    });

  program
    .command("build-embeddings")
    .description(
      "Cold-build (or refresh) the persistent embedding index for a vault. Required before `obsidian_embeddings_search` is useful. Uses the same paragraph-level chunking as the FTS5 index, so chunk identity matches across BM25 and embeddings."
    )
    .requiredOption("--vault <path>", "Path to the Obsidian vault root")
    .option("--embedding-model <alias>", `Model alias (default: ${DEFAULT_MODEL_ALIAS})`, DEFAULT_MODEL_ALIAS)
    .option("--embed-file <path>", "Override the .embed.db file location")
    .option("--exclude-glob <pattern...>", "Exclude paths matching glob (repeatable)")
    .option("--read-paths <pattern...>", "Strict allowlist of glob patterns (repeatable)")
    .action(
      async (opts: {
        vault: string;
        embeddingModel?: string;
        embedFile?: string;
        excludeGlob?: string[];
        readPaths?: string[];
      }) => {
        const model = resolveModel(opts.embeddingModel);
        const vault = new Vault(opts.vault, { excludeGlobs: opts.excludeGlob, readPaths: opts.readPaths });
        await vault.ensureExists();
        const embedFile = opts.embedFile ?? embedDbPath(vault.root);
        const db = new EmbedDb({ file: embedFile, vaultRoot: vault.root, modelAlias: model.alias, dim: model.dim });
        await db.open();
        try {
          process.stderr.write(`enquire: loading embedder ${model.alias} (${model.hfId})...\n`);
          const embedder = await loadEmbedder(opts.embeddingModel);
          const report = await syncEmbedDb(vault, db, embedder);
          process.stdout.write(
            `enquire: embed db ${embedFile} — added=${report.added} updated=${report.updated} deleted=${report.deleted} unchanged=${report.unchanged} total_chunks=${report.total_chunks}\n`
          );
        } finally {
          db.close();
        }
      }
    );

  program
    .command("clear-embeddings")
    .description("Delete the embedding index files (.embed.db + WAL/SHM sidecar) for a given vault")
    .requiredOption("--vault <path>", "Vault whose embedding index to delete")
    .option("--embed-file <path>", "Override the embedding-index file location")
    .action(async (opts: { vault: string; embedFile?: string }) => {
      const vault = new Vault(opts.vault);
      await vault.ensureExists();
      const file = opts.embedFile ?? embedDbPath(vault.root);
      // Use any model alias / dim for the delete path — bootstrapSchema uses
      // them only when the file already exists with mismatched meta.
      const db = new EmbedDb({ file, vaultRoot: vault.root, modelAlias: "n/a", dim: 1 });
      const removed = await db.clearOnDisk();
      if (removed) {
        process.stdout.write(`enquire: removed embedding index files at ${file}\n`);
      } else {
        process.stdout.write(`enquire: no embedding index files at ${file}\n`);
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
    cacheFile: opts.cacheFile,
    excludeGlobs: opts.excludeGlob,
    readPaths: opts.readPaths
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
    try {
      await ftsIndex.open();
      await syncFtsIndex(vault, ftsIndex);
    } catch (err) {
      // Don't leak the SQLite handle if open() succeeded but sync threw.
      ftsIndex.close();
      throw err;
    }
  }

  const server = new McpServer({
    name: "enquire",
    version: VERSION
  });

  // v1.10/v1.11 — per-tool gating. Monkey-patch registerTool ONCE so every
  // register* function below transparently honors the gating rules.
  //
  // Rules:
  //   • --enabled-tools (allowlist): if set, ONLY listed tools register.
  //   • --disabled-tools (denylist): listed tools are skipped.
  //   • Both set: tool must be in allowlist AND not in denylist.
  //
  // Skips are logged to stderr so users can verify the flags are doing what
  // they expect when wiring up an agent with a narrow tool surface.
  const disabledTools = new Set(opts.disabledTools ?? []);
  const enabledTools = new Set(opts.enabledTools ?? []);
  if (disabledTools.size > 0 || enabledTools.size > 0) {
    const origRegisterTool = server.registerTool.bind(server) as (name: string, ...rest: unknown[]) => unknown;
    (server as unknown as { registerTool: (name: string, ...rest: unknown[]) => unknown }).registerTool = (
      name: string,
      ...rest: unknown[]
    ) => {
      if (enabledTools.size > 0 && !enabledTools.has(name)) {
        process.stderr.write(`enquire: skipping tool ${name} (not in --enabled-tools allowlist)\n`);
        return undefined;
      }
      if (disabledTools.has(name)) {
        process.stderr.write(`enquire: skipping tool ${name} (disabled by --disabled-tools)\n`);
        return undefined;
      }
      return origRegisterTool(name, ...rest);
    };
  }

  registerReadTools(server, vault);
  if (vault.writeEnabled) registerWriteTools(server, vault);
  if (ftsIndex) registerFtsTools(server, ftsIndex);
  registerResources(server, vault);
  if (ftsIndex) registerChunkResource(server, ftsIndex);
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

  // Optional watcher — only when --watch is passed. Starts AFTER the initial
  // FTS5 sync so we don't double-index files during boot.
  let watcher: VaultWatcher | null = null;
  if (opts.watch) {
    watcher = new VaultWatcher({ vault, ftsIndex });
    await watcher.start();
    const closeWatcher = () => {
      void watcher?.close();
    };
    process.once("SIGINT", closeWatcher);
    process.once("SIGTERM", closeWatcher);
    process.on("beforeExit", closeWatcher);
  }

  const writeMode = vault.writeEnabled ? "WRITE-ENABLED" : "read-only";
  const cacheMode = vault.persistentCacheEnabled ? `, persistent-cache=${vault.cacheFile}` : "";
  const ftsMode = ftsIndex ? `, fts5-index (${ftsIndex.totalFiles()} files / ${ftsIndex.totalChunks()} chunks)` : "";
  const excludePart = vault.excludeGlobs.length > 0 ? `, exclude-globs=${vault.excludeGlobs.length}` : "";
  const allowPart = vault.readPaths.length > 0 ? `, read-paths=${vault.readPaths.length}` : "";
  const privacyMode = `${excludePart}${allowPart}`;
  const watchMode = watcher ? ", watch=on" : "";
  const disabledMode = disabledTools.size > 0 ? `, disabled-tools=${disabledTools.size}` : "";
  const enabledMode = enabledTools.size > 0 ? `, enabled-tools=${enabledTools.size}` : "";
  process.stderr.write(
    `enquire ${VERSION} ready (${writeMode}, vault=${vault.root}${cacheMode}${ftsMode}${privacyMode}${watchMode}${disabledMode}${enabledMode})\n`
  );

  if (ftsIndex) {
    const closeFts = () => ftsIndex?.close();
    process.once("SIGINT", closeFts);
    process.once("SIGTERM", closeFts);
    process.on("beforeExit", closeFts);
  }
}

// v2.0 alpha — sync the persistent embedding index. Same incremental-rebuild
// pattern as syncFtsIndex (mtime tracked in source_state); we only re-embed
// notes whose mtime changed. Embedding is the bottleneck (~5-30ms per chunk
// CPU on M1), so incremental updates are critical for vaults of any size.
async function syncEmbedDb(
  vault: Vault,
  db: EmbedDb,
  embedder: Awaited<ReturnType<typeof loadEmbedder>>
): Promise<{ added: number; updated: number; deleted: number; unchanged: number; total_chunks: number }> {
  const entries = await vault.listMarkdown();
  const known = new Map<string, number>();
  for (const s of db.getSourceStates()) known.set(s.rel_path, s.mtime_ms);

  const live = new Set<string>();
  let added = 0;
  let updated = 0;
  let unchanged = 0;
  for (const e of entries) {
    live.add(e.relPath);
    const prevMtime = known.get(e.relPath);
    if (prevMtime !== undefined && prevMtime === e.mtimeMs) {
      unchanged += 1;
      continue;
    }
    try {
      const note = await vault.readNote(e.absPath, e.mtimeMs);
      const chunks = chunkContent(note.parsed.body);
      if (chunks.length === 0) {
        // No body — drop any stale entries.
        db.deleteNote(e.relPath);
        continue;
      }
      const vectors = await embedder.embed(chunks.map((c) => c.text));
      const rows = chunks.map((c, i) => {
        const vector = vectors[i];
        if (!vector) throw new Error(`embedder returned no vector for chunk ${i} of ${e.relPath}`);
        return {
          chunkIndex: i,
          lineStart: c.lineStart,
          lineEnd: c.lineEnd,
          textPreview: c.text.slice(0, 480),
          vector
        };
      });
      db.upsertNote(e.relPath, e.mtimeMs, rows);
      if (prevMtime === undefined) added += 1;
      else updated += 1;
    } catch (err) {
      process.stderr.write(
        `enquire: skipping ${e.relPath} during embed sync — ${err instanceof Error ? err.message : String(err)}\n`
      );
    }
  }

  // Delete entries for files that have vanished.
  let deleted = 0;
  for (const relPath of known.keys()) {
    if (!live.has(relPath)) {
      db.deleteNote(relPath);
      deleted += 1;
    }
  }

  return {
    added,
    updated,
    deleted,
    unchanged,
    total_chunks: db.totalChunks()
  };
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
      idx.reindexFile(relPath, entry.mtimeMs, note.content, wikilinkTargets, note.parsed.tags);
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
        "BM25-ranked full-text search backed by a SQLite FTS5 inverted index. Sub-100ms on multi-thousand-note vaults. Returns chunk-level hits with snippet excerpts. Hyphenated tokens (e.g. `claude-telegram`) are auto-quoted. Optional filters: `folder` (vault-relative subtree), `tag` (exact frontmatter or inline tag membership), `since` (ISO date — only chunks from notes modified on/after this). Use `obsidian_search_text` instead if the index isn't built yet — this tool is only registered when the server is started with `--persistent-index`.",
      annotations: { ...READ_ONLY, title: "Full-text search" },
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe(
            "Search query. Whitespace-tokenized; FTS5 BM25 matching with `unicode61` (default) or `trigram` tokenizer."
          ),
        folder: z.string().optional().describe("Restrict to a subfolder (vault-relative)"),
        tag: z
          .string()
          .optional()
          .describe("Exact tag membership (e.g. 'project'). Matches frontmatter + inline tags. No leading #."),
        since: z
          .string()
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
      return textResult({
        query: args.query,
        total_chunks: idx.totalChunks(),
        total_files: idx.totalFiles(),
        applied_filters: {
          folder: args.folder ?? null,
          tag: args.tag ?? null,
          since: args.since ?? null
        },
        matches: idx.search(args.query, {
          limit: args.limit,
          folder: args.folder,
          tag: args.tag,
          sinceMtimeMs
        })
      });
    }
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

  server.registerTool(
    "obsidian_validate_note_proposal",
    {
      title: "Validate a proposed new note (anti-slop)",
      description:
        "Lint a draft note BEFORE writing. Closes the #1 LLM-write pain: AI generates structurally-broken notes (bad YAML, fake wikilinks, inconsistent tags). This tool parses the proposed YAML, resolves every [[wikilink]] against the live vault (broken/resolved with did-you-mean), pre-classifies every tag (existing vs new), and checks for path/title collisions. Returns errors (blocking) + warnings (non-blocking) + per-link/tag diagnostics. Always available — does NOT require --enable-write. Recommended workflow: validate → fix → obsidian_create_note.",
      annotations: { ...READ_ONLY, title: "Validate note proposal" },
      inputSchema: {
        path: z.string().describe("Vault-relative path the LLM intends to write to (e.g. 'Inbox/idea.md')"),
        content: z.string().describe("Full proposed markdown content including any frontmatter block"),
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
        "Given a note, return up to N other notes that are 'related' — by tag overlap (Jaccard), title 3-gram overlap, shared outbound links, and co-backlinks. Score is a weighted sum of those four signals; each is also returned individually so the caller can re-rank. No embeddings, no native deps — pure structural retrieval over the existing vault graph. Runs O(N) over the whole vault per call; for vaults >5k notes prefer batching.",
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
          .optional()
          .describe(
            "Override the regex (case-insensitive). Default matches Open question:/Q:/TODO?/?? at line start with optional list/quote/heading prefix."
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

  server.registerTool(
    "obsidian_semantic_search",
    {
      title: "Semantic search (TF-IDF cosine)",
      description:
        "Pure-JS lexical-semantic retrieval. Tokenizes + TF-IDFs + L2-normalizes every note's body once per session, then ranks notes by cosine similarity to the query. Free / offline / no model download — closes the gap to Smart Connections without paywall, ML deps, or HTTP. Use this when `obsidian_search_text` (substring) and `obsidian_full_text_search` (BM25) miss synonyms or related-term matches. For best results pair with `--persistent-index` so BM25 + semantic both run cheap. Returns ranked hits with snippet + matched terms (highest-IDF first).",
      annotations: { ...READ_ONLY, title: "Semantic search" },
      inputSchema: {
        query: z.string().min(1).describe("Free-form query — multi-word, natural language is fine"),
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
  server.registerTool(
    "obsidian_embeddings_search",
    {
      title: "Embeddings search (ML, paraphrase-multilingual)",
      description:
        "ML-embedding retrieval via @huggingface/transformers + paraphrase-multilingual-MiniLM-L12-v2 (50+ languages, 384-dim, runs on CPU). Higher-quality than `obsidian_semantic_search` for paraphrases / synonyms / cross-language queries, but requires a one-time setup: (1) `enquire-mcp install-model multilingual` downloads the ONNX weights (~120MB) and (2) `enquire-mcp build-embeddings --vault <path>` writes the persistent vector index (~1ms/chunk on M1). Subsequent queries are sub-100ms top-10. If the index is missing, the tool returns a clean error with the exact command to run — it does NOT silently kick off a model download.",
      annotations: { ...READ_ONLY, title: "Embeddings search" },
      inputSchema: {
        query: z.string().min(1).describe("Free-form query — multi-word, natural language, any supported language"),
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
        search: z.string().min(1).describe("Literal substring to find. Empty string is rejected."),
        replace: z.string().describe("Replacement text. Empty string means delete every occurrence."),
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
}

function registerChunkResource(server: McpServer, idx: FtsIndex): void {
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
