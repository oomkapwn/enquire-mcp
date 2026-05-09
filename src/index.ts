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
  validateNoteProposal
} from "./tools.js";
import { Vault } from "./vault.js";
import { VaultWatcher } from "./watcher.js";

const VERSION = "3.0.0";

/** Default location for the persistent embedding index, alongside .fts5.db. */
function embedDbPath(vaultRoot: string): string {
  // Match the FTS5 location convention by stripping the .fts5.db extension
  // off defaultIndexFile() and appending .embed.db.
  return defaultIndexFile(vaultRoot).replace(/\.fts5\.db$/, ".embed.db");
}

export interface ServeOptions {
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
  diagnosticSearchTools?: boolean;
  /** v2.8.0 — also index PDFs into FTS5 (and embeddings, if a build-embeddings
   *  with --include-pdfs ran). Off by default; opt-in because PDF extraction
   *  is slower than markdown. */
  includePdfs?: boolean;
  /** v2.9.0 — enable BGE cross-encoder reranking on top of RRF in
   *  obsidian_search. Off by default; adds ~30-50ms per query at top-50. */
  enableReranker?: boolean;
  /** v2.9.0 — reranker model alias (default "rerank-multilingual"). */
  rerankerModel?: string;
  /** v2.9.0 — how many top fused candidates to rerank (default 50). */
  rerankerTopN?: string;
  /** v2.13.0 — build an in-memory HNSW vector index on serve start.
   *  Off by default; rebuild cost ~25s for 50K chunks. Sub-10ms top-K
   *  per query thereafter, vs O(n) brute-force without it. Defers
   *  persistence to v3.0. */
  useHnsw?: boolean;
  /** v2.13.0 — HNSW search-time beam width (default 100; ≥k). */
  hnswEf?: string;
  /** v2.15.0 — late-chunking context windowing for embeddings (default 0 chars). */
  lateChunkContext?: string;
  /** v2.16.0 — persist HNSW index to disk for fast reload on next serve.
   *  Default true (the persistence is a pure optimization; corrupt files
   *  fall back to rebuild gracefully). Pass `--no-hnsw-persist` to opt out. */
  hnswPersist?: boolean;
  /** v2.17.0 — vector storage encoding for the persistent embed db.
   *  - `"f32"` (default) — Float32 BLOB, identical to v2.16- behavior.
   *  - `"int8"` — int8-quantized BLOB + per-vector (vMin, scale) Float32
   *    tuple. ~4× storage reduction at ~1-2% recall@10 cost.
   *  Mode is per-database; switching modes triggers a full rebuild
   *  (the meta-table contamination guard treats it as a schema change).
   *  Must match the mode used at build-embeddings time — serving with a
   *  different mode would auto-rebuild the index. */
  quantizeEmbeddings?: "f32" | "int8";
}

/** Raw `serve-http` flags as parsed by commander (string-typed). */
interface HttpServeCli extends ServeOptions {
  port?: string;
  host?: string;
  bearerToken?: string;
  bearerTokenEnv?: string;
  mcpPath?: string;
  rateLimit?: string;
  corsOrigin?: string[];
  healthPath?: string;
  /** v2.14.0 — stateful mode flags. */
  stateful?: boolean;
  sessionIdleTimeoutMs?: string;
  maxSessions?: string;
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
    .option(
      "--diagnostic-search-tools",
      "Register the four single-ranker search tools (obsidian_search_text, obsidian_full_text_search, obsidian_semantic_search, obsidian_embeddings_search) IN ADDITION to the default obsidian_search hybrid tool. Off by default in v2.0+ — the umbrella obsidian_search auto-detects available signals and produces consistent recall. Enable when you need single-ranker output for diagnostics or A/B benchmarking."
    )
    .option(
      "--include-pdfs",
      'v2.8.0 — also index PDF files into FTS5 (and embeddings, if `enquire-mcp build-embeddings --include-pdfs` ran). With `--persistent-index`, PDF chunks become first-class hits in `obsidian_search` results, surfaced with `kind: "pdf"` flag. Off by default — opt-in because PDF text extraction is slower than markdown (~50-200ms per page on M1 cold). Requires the `pdfjs-dist` optionalDependency (default-installed unless you used `--omit=optional`).'
    )
    .option(
      "--enable-reranker",
      "v2.9.0 — enable BGE cross-encoder reranking on top of RRF in `obsidian_search`. After fusion, top-N candidates (default 50) are re-scored by a cross-encoder model and re-sorted. Adds ~30-50ms per query on M1 CPU; +5-10 NDCG@10 typical for retrieval quality. Off by default — opt-in because the cross-encoder model is downloaded from HuggingFace on first call (~25-110 MB depending on alias). Requires the `@huggingface/transformers` optionalDependency."
    )
    .option(
      "--reranker-model <alias>",
      "v2.9.0 — reranker alias from RERANKER_MODELS. `rerank-multilingual` (default; Xenova/mxbai-rerank-xsmall-v1, ~25 MB, multilingual) or `rerank-bge` (Xenova/bge-reranker-base, ~110 MB, English-only). Only effective with `--enable-reranker`."
    )
    .option(
      "--reranker-top-n <n>",
      "v2.9.0 — how many top RRF-fused candidates to rerank (default 50). Larger N improves recall ceiling but costs more reranker compute (~30-50ms per 50 pairs on M1). Only effective with `--enable-reranker`."
    )
    .option(
      "--use-hnsw",
      "v2.13.0 — build an in-memory HNSW vector index on serve start (or rebuild if `.embed.db` is missing). Sub-10ms top-K queries at any vault scale, vs O(n) brute-force without it. Build cost: ~5s for 8K chunks, ~25s for 50K, ~4min for 500K (one-time per serve). Recall@10 ≥ 98% vs brute-force at default params. Requires the `hnswlib-wasm` optionalDependency (~340 KB, pure WASM, no native binding)."
    )
    .option(
      "--hnsw-ef <n>",
      "v2.13.0 — HNSW search-time beam width (default 100; must be ≥ requested k). Higher = more accurate, slightly slower. Common range: 50-500. Only effective with `--use-hnsw`."
    )
    .option(
      "--late-chunk-context <chars>",
      "v2.15.0 — late-chunking-style context windowing on embeddings. When > 0, prepends doc title + heading breadcrumb + tails of neighboring chunks (this many chars from each side) before sending to the embedder. Typical +2-5 NDCG@10 retrieval boost at zero new dep cost. Default 0 (off; matches v2.1.0+ breadcrumb-only behavior). Only effective during `build-embeddings` or auto-rebuild."
    )
    .option(
      "--no-hnsw-persist",
      "v2.16.0 — disable HNSW index persistence. By default (with --use-hnsw), the index is saved to a sidecar `.hnsw.bin` + `.meta.json` next to `.embed.db` after the first build, then re-loaded on subsequent serve starts when the embed-db signature matches. Skipping persistence means a fresh rebuild every serve start (~25s for 50K chunks). Pass this flag if you can't write to the cache dir or want diagnostic-fresh builds."
    )
    .option(
      "--quantize-embeddings <mode>",
      "v2.17.0 — vector storage encoding for the persistent embed db. `f32` (default) is identical to v2.16- behavior. `int8` cuts BLOB size ~4× (per-vector min+scale + int8 bytes) at ~1-2% recall@10 cost. Must match the mode used at `build-embeddings` time — otherwise the index auto-rebuilds on serve start. Accepts `f32`/`float32`/`none` and `int8`/`i8`/`q8`."
    )
    .action(async (opts: ServeOptions) => {
      // Validate up-front so a bad value fails before we touch the vault.
      parseQuantizationMode(opts.quantizeEmbeddings as string | undefined);
      await startServer(opts);
    });

  // v2.6.0 — remote-MCP HTTP transport. Mirrors `serve` flags + adds HTTP
  // surface (bearer auth, rate-limit, CORS). See docs/http-transport.md.
  program
    .command("serve-http")
    .description(
      "Start the MCP server over HTTP (Streamable HTTP transport). For remote-MCP use with claude.ai web, ChatGPT, Cursor HTTP mode, mobile clients. Requires --bearer-token (or --bearer-token-env). Bind to 127.0.0.1 by default — front with Tailscale Funnel / Cloudflare Tunnel for remote access."
    )
    .requiredOption("--vault <path>", "Path to the Obsidian vault root")
    .option("--port <n>", "TCP port (default 3000)", "3000")
    .option(
      "--host <host>",
      "Bind host (default 127.0.0.1 — explicit because 0.0.0.0 must be opt-in for remote-MCP)",
      "127.0.0.1"
    )
    .option(
      "--bearer-token <token>",
      "Bearer token clients must present in the Authorization header. Generate with `enquire-mcp gen-token`. Required."
    )
    .option(
      "--bearer-token-env <name>",
      "Read the bearer token from this env var instead of --bearer-token (cleaner for systemd / .env / process listings). Either flag is required."
    )
    .option("--mcp-path <path>", "URL path for the MCP endpoint (default /mcp)", "/mcp")
    .option("--rate-limit <n>", "Max requests per minute per bearer token (default 120). Pass 0 to disable.", "120")
    .option(
      "--cors-origin <origin...>",
      "CORS allowlist (repeatable). Default empty — no Access-Control-Allow-Origin sent. Use '*' as a single entry to allow any origin (not compatible with credentialed Bearer requests; you almost always want explicit origins like https://claude.ai)."
    )
    .option("--health-path <path>", "URL path for the unauthenticated health probe (default /health)", "/health")
    .option(
      "--stateful",
      "v2.14.0 — run in stateful mode: sessions keyed by `Mcp-Session-Id`, persistent SSE for server-initiated notifications, DELETE /mcp for explicit termination. Required for ChatGPT custom GPT actions and other clients expecting persistent state across requests. Off by default (stateless minimizes attack surface and is the right choice for short-running tools)."
    )
    .option(
      "--session-idle-timeout-ms <n>",
      "v2.14.0 — evict stateful sessions idle longer than this many milliseconds. Default 1800000 (30 min). Only effective with --stateful."
    )
    .option(
      "--max-sessions <n>",
      "v2.14.0 — max concurrent stateful sessions. New sessions beyond this cap return 503 + Retry-After. Default 100. Only effective with --stateful."
    )
    .option("--enable-write", "Enable the write tools (gated identically to stdio mode). Off by default.")
    .option("--max-file-bytes <n>", "Max bytes for any single file read/write (default 5MB)")
    .option("--cache-size <n>", "Max parsed-note cache entries (default 1024)")
    .option("--persistent-cache", "Persist parsed-note cache to disk so cold starts skip re-parsing")
    .option("--cache-file <path>", "Override the persistent-cache file location")
    .option("--persistent-index", "Maintain a SQLite FTS5 inverted index for sub-100ms BM25-ranked search")
    .option("--index-file <path>", "Override the FTS5 index file location")
    .option("--tokenize <mode>", "FTS5 tokenize mode: 'unicode61' (default) or 'trigram'")
    .option("--exclude-glob <pattern...>", "Privacy denylist (same semantics as `serve`).")
    .option("--read-paths <pattern...>", "Privacy allowlist (same semantics as `serve`).")
    .option("--watch", "Watch the vault for .md changes and refresh indexes incrementally.")
    .option("--disabled-tools <name...>", "Skip registration of specific tools by name.")
    .option("--enabled-tools <name...>", "Strict allowlist — when set, ONLY listed tools register.")
    .option("--diagnostic-search-tools", "Register the four single-ranker search tools alongside obsidian_search.")
    .option(
      "--quantize-embeddings <mode>",
      "v2.17.0 — vector storage encoding for the persistent embed db (`f32` default, `int8` for ~4× smaller BLOBs). Must match the mode used at `build-embeddings` time."
    )
    .action(async (opts: HttpServeCli) => {
      const tokenFromArg = typeof opts.bearerToken === "string" ? opts.bearerToken.trim() : "";
      const tokenFromEnv =
        typeof opts.bearerTokenEnv === "string" ? (process.env[opts.bearerTokenEnv] ?? "").trim() : "";
      const bearerToken = tokenFromArg.length > 0 ? tokenFromArg : tokenFromEnv;
      if (!bearerToken) {
        process.stderr.write(
          "enquire serve-http: --bearer-token (or --bearer-token-env <name>) is required.\n" +
            "  Generate one with: enquire-mcp gen-token\n"
        );
        process.exit(1);
      }
      // --port accepts 0 as "kernel-assigned ephemeral" — useful for tests
      // and for scenarios where the user binds via a tunnel and doesn't
      // care which local port. So we use a non-negative-integer check
      // here, NOT parsePositiveInt (which would reject 0).
      const portNum = Number(opts.port ?? "3000");
      if (!Number.isFinite(portNum) || !Number.isInteger(portNum) || portNum < 0 || portNum > 65535) {
        throw new Error(`--port must be an integer in [0, 65535]; got "${opts.port}"`);
      }
      // v2.14.0 — stateful-mode opts. Tolerate missing flags (default to
      // standard values) and validate parsed integers.
      const sessionIdleMs =
        opts.sessionIdleTimeoutMs !== undefined
          ? parsePositiveInt(opts.sessionIdleTimeoutMs, "--session-idle-timeout-ms")
          : 30 * 60 * 1000;
      const maxSessionsCap =
        opts.maxSessions !== undefined ? parsePositiveInt(opts.maxSessions, "--max-sessions") : 100;
      // v2.17.0 — fail fast on a typo'd quantization mode.
      const quantMode = parseQuantizationMode(opts.quantizeEmbeddings as string | undefined);
      const httpOpts = {
        ...(opts as ServeOptions),
        ...(quantMode !== undefined ? { quantizeEmbeddings: quantMode } : {}),
        port: portNum,
        host: opts.host ?? "127.0.0.1",
        bearerToken,
        mcpPath: opts.mcpPath ?? "/mcp",
        rateLimitPerMinute: opts.rateLimit !== undefined ? Number(opts.rateLimit) : 120,
        corsOrigins: opts.corsOrigin ?? [],
        healthPath: opts.healthPath ?? "/health",
        stateful: opts.stateful === true,
        sessionIdleTimeoutMs: sessionIdleMs,
        maxSessions: maxSessionsCap
      } as const;
      if (
        !Number.isFinite(httpOpts.rateLimitPerMinute) ||
        httpOpts.rateLimitPerMinute < 0 ||
        !Number.isInteger(httpOpts.rateLimitPerMinute)
      ) {
        throw new Error(`--rate-limit must be a non-negative integer; got "${opts.rateLimit}"`);
      }
      const { startHttpServer } = await import("./http-transport.js");
      await startHttpServer(httpOpts);
    });

  // v2.6.0 — convenience helper. Same as `node -e
  // 'console.log(require("crypto").randomBytes(32).toString("base64url"))'`
  // but discoverable in --help.
  program
    .command("gen-token")
    .description("Generate a fresh 32-byte base64url bearer token suitable for `serve-http --bearer-token`.")
    .action(async () => {
      const { generateBearerToken } = await import("./http-transport.js");
      process.stdout.write(`${generateBearerToken()}\n`);
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
    .option(
      "--include-pdfs",
      "v2.8.0 — also index PDFs into the FTS5 index. Off by default; PDF extraction is slower than markdown."
    )
    .action(
      async (opts: {
        vault: string;
        indexFile?: string;
        tokenize?: "unicode61" | "trigram";
        includePdfs?: boolean;
      }) => {
        const tokenize = opts.tokenize === "trigram" ? "trigram" : "unicode61";
        const vault = new Vault(opts.vault);
        await vault.ensureExists();
        const indexFile = opts.indexFile ?? defaultIndexFile(vault.root);
        const idx = new FtsIndex({ file: indexFile, vaultRoot: vault.root, tokenize });
        await idx.open();
        try {
          const report = await syncFtsIndex(vault, idx);
          process.stdout.write(
            `enquire: index ${indexFile} (md) — added=${report.added} updated=${report.updated} deleted=${report.deleted} unchanged=${report.unchanged} total_chunks=${report.total_chunks}\n`
          );
          if (opts.includePdfs) {
            const pdfReport = await syncPdfFtsIndex(vault, idx);
            process.stdout.write(
              `enquire: index ${indexFile} (pdf) — added=${pdfReport.added} updated=${pdfReport.updated} deleted=${pdfReport.deleted} unchanged=${pdfReport.unchanged} total_chunks=${pdfReport.total_chunks}\n`
            );
          }
        } finally {
          idx.close();
        }
      }
    );

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
    .option(
      "--include-pdfs",
      "v2.8.0 — also embed PDF chunks. Off by default; PDF extraction + embedding is ~10-30x slower than markdown per file."
    )
    .option(
      "--late-chunk-context <chars>",
      "v2.15.0 — context-windowed embedding text (doc title + breadcrumb + neighbor-chunk tails of N chars). Default 0 (off). Typical 100-200 for +2-5 NDCG@10."
    )
    .option(
      "--quantize-embeddings <mode>",
      "v2.17.0 — vector storage encoding. `f32` (default) is identical to v2.16- behavior. `int8` uses asymmetric scalar quantization (per-vector min + scale + int8 bytes) for ~4× smaller BLOBs at ~1-2% recall@10 cost. Switching modes triggers a full rebuild via the schema-mismatch path. Accepts `f32`/`float32`/`none` and `int8`/`i8`/`q8`."
    )
    .action(
      async (opts: {
        vault: string;
        embeddingModel?: string;
        embedFile?: string;
        excludeGlob?: string[];
        readPaths?: string[];
        includePdfs?: boolean;
        lateChunkContext?: string;
        quantizeEmbeddings?: string;
      }) => {
        const model = resolveModel(opts.embeddingModel);
        const vault = new Vault(opts.vault, { excludeGlobs: opts.excludeGlob, readPaths: opts.readPaths });
        await vault.ensureExists();
        const embedFile = opts.embedFile ?? embedDbPath(vault.root);
        const quantization = parseQuantizationMode(opts.quantizeEmbeddings) ?? "f32";
        const db = new EmbedDb({
          file: embedFile,
          vaultRoot: vault.root,
          modelAlias: model.alias,
          dim: model.dim,
          quantization
        });
        const lateChunkContext =
          opts.lateChunkContext !== undefined
            ? Math.max(0, parsePositiveInt(opts.lateChunkContext, "--late-chunk-context"))
            : 0;
        await db.open();
        try {
          process.stderr.write(`enquire: loading embedder ${model.alias} (${model.hfId})...\n`);
          const embedder = await loadEmbedder(opts.embeddingModel);
          const report = await syncEmbedDb(vault, db, embedder, { lateChunkContext });
          process.stdout.write(
            `enquire: embed db ${embedFile} (md) — added=${report.added} updated=${report.updated} deleted=${report.deleted} unchanged=${report.unchanged} total_chunks=${report.total_chunks}${lateChunkContext > 0 ? ` late-chunk-context=${lateChunkContext}` : ""}${quantization !== "f32" ? ` quantization=${quantization}` : ""}\n`
          );
          if (opts.includePdfs) {
            const pdfReport = await syncPdfEmbedDb(vault, db, embedder, { lateChunkContext });
            process.stdout.write(
              `enquire: embed db ${embedFile} (pdf) — added=${pdfReport.added} updated=${pdfReport.updated} deleted=${pdfReport.deleted} unchanged=${pdfReport.unchanged} total_chunks=${pdfReport.total_chunks}\n`
            );
          }
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

  // v2.11.0 — diagnostic + zero-touch onboarding. `doctor` is read-only and
  // returns 0 if everything is ready, 1 if any critical setup is missing.
  // `setup` runs the install + build sequence in order, idempotent.
  program
    .command("doctor")
    .description(
      "Run a read-only health check: verify the vault path, optional deps (better-sqlite3 / transformers / pdfjs / tesseract / canvas), embedding-model cache, FTS5 index, and embed-db. Returns 0 if everything is ready for full hybrid retrieval, 1 if any critical piece is missing. Color-coded ✓ / ⚠ / ✗ output. Use this when you're unsure what's set up vs not."
    )
    .requiredOption("--vault <path>", "Path to the Obsidian vault root")
    .option("--json", "Emit machine-readable JSON instead of the colored banner")
    .action(async (opts: { vault: string; json?: boolean }) => {
      const { runDoctor, formatDoctorResult } = await import("./doctor.js");
      const result = await runDoctor({
        vault: opts.vault,
        modelEntry: EMBEDDING_MODELS[DEFAULT_MODEL_ALIAS]
      });
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } else {
        process.stdout.write(`${formatDoctorResult(result)}\n`);
      }
      if (!result.ready) process.exit(1);
    });

  program
    .command("setup")
    .description(
      "Zero-touch onboarding: run `install-model` + `index` + `build-embeddings` in sequence so a fresh vault is fully indexed for hybrid retrieval (BM25 + TF-IDF + ML embeddings) in a single command. Idempotent — re-running on a fully set-up vault is a fast no-op pass that just reports the existing state."
    )
    .requiredOption("--vault <path>", "Path to the Obsidian vault root")
    .option("--embedding-model <alias>", `Model alias (default: ${DEFAULT_MODEL_ALIAS})`, DEFAULT_MODEL_ALIAS)
    .option(
      "--include-pdfs",
      "Also index PDFs (FTS5 + embeddings). Off by default; opt-in because PDF extraction is slower."
    )
    .option("--skip-embeddings", "Skip the install-model + build-embeddings steps (only build FTS5)")
    .option(
      "--quantize-embeddings <mode>",
      "v2.17.0 — vector storage encoding for the embed db (`f32` default, `int8` for ~4× smaller BLOBs). Same semantics as the `build-embeddings` flag."
    )
    .action(
      async (opts: {
        vault: string;
        embeddingModel?: string;
        includePdfs?: boolean;
        skipEmbeddings?: boolean;
        quantizeEmbeddings?: string;
      }) => {
        const v = new Vault(opts.vault);
        await v.ensureExists();
        process.stdout.write(`enquire setup — ${opts.vault}\n\n`);

        // Step 1: FTS5 index.
        process.stdout.write(">> Step 1/3: Cold-build FTS5 index\n");
        const indexFile = defaultIndexFile(v.root);
        const idx = new FtsIndex({ file: indexFile, vaultRoot: v.root });
        await idx.open();
        try {
          const ftsReport = await syncFtsIndex(v, idx);
          process.stdout.write(
            `   FTS5 (md): added=${ftsReport.added} updated=${ftsReport.updated} unchanged=${ftsReport.unchanged} chunks=${ftsReport.total_chunks}\n`
          );
          if (opts.includePdfs) {
            const pdfReport = await syncPdfFtsIndex(v, idx);
            process.stdout.write(
              `   FTS5 (pdf): added=${pdfReport.added} updated=${pdfReport.updated} unchanged=${pdfReport.unchanged} chunks=${pdfReport.total_chunks}\n`
            );
          }
        } finally {
          idx.close();
        }

        if (opts.skipEmbeddings) {
          process.stdout.write("\n>> Step 2-3 skipped (--skip-embeddings)\n");
          process.stdout.write("\nSetup partial. Run without --skip-embeddings to enable ML hybrid retrieval.\n");
          return;
        }

        // Step 2: Install-model.
        process.stdout.write("\n>> Step 2/3: Install embedding model\n");
        const model = resolveModel(opts.embeddingModel);
        const t0 = Date.now();
        const embedder = await loadEmbedder(opts.embeddingModel);
        const [smokeVec] = await embedder.embed(["hello"]);
        if (!smokeVec || smokeVec.length !== model.dim) {
          throw new Error(`Model ${model.alias} loaded but dim mismatch: ${smokeVec?.length} vs ${model.dim}`);
        }
        process.stdout.write(
          `   model ${model.alias} ready (${model.dim}-dim, ${Date.now() - t0}ms warmup, cached under ~/.cache/huggingface/)\n`
        );

        // Step 3: build-embeddings.
        process.stdout.write("\n>> Step 3/3: Build embedding index\n");
        const embedFile = embedDbPath(v.root);
        const quantization = parseQuantizationMode(opts.quantizeEmbeddings) ?? "f32";
        const db = new EmbedDb({
          file: embedFile,
          vaultRoot: v.root,
          modelAlias: model.alias,
          dim: model.dim,
          quantization
        });
        await db.open();
        try {
          const embReport = await syncEmbedDb(v, db, embedder);
          process.stdout.write(
            `   embed-db (md): added=${embReport.added} updated=${embReport.updated} unchanged=${embReport.unchanged} chunks=${embReport.total_chunks}${quantization !== "f32" ? ` quantization=${quantization}` : ""}\n`
          );
          if (opts.includePdfs) {
            const pdfReport = await syncPdfEmbedDb(v, db, embedder);
            process.stdout.write(
              `   embed-db (pdf): added=${pdfReport.added} updated=${pdfReport.updated} unchanged=${pdfReport.unchanged} chunks=${pdfReport.total_chunks}\n`
            );
          }
        } finally {
          db.close();
        }

        process.stdout.write("\n✓ Setup complete. Now run:\n");
        process.stdout.write(`   enquire-mcp serve --vault ${opts.vault} --persistent-index`);
        if (opts.includePdfs) process.stdout.write(" --include-pdfs");
        if (quantization !== "f32") process.stdout.write(` --quantize-embeddings ${quantization}`);
        process.stdout.write("\n");
        process.stdout.write(`Or check status: enquire-mcp doctor --vault ${opts.vault}\n`);
      }
    );

  // v2.12.0 — retrieval-quality evaluation harness. Reads a JSONL file of
  // queries with known-relevant doc paths, runs obsidian_search for each,
  // computes NDCG@K + Recall@K + MRR. Pretty table by default, --json for
  // machine output, --matrix to A/B several flag combinations.
  program
    .command("eval")
    .description(
      "Built-in retrieval-quality benchmark harness. Reads a JSONL file of queries with known-relevant doc paths, runs `obsidian_search` for each, computes NDCG@K + Recall@K + MRR + per-query latency. Pretty table output by default; `--json` for machine-readable output. `--matrix` runs all combinations of (graph_boost on/off × reranker on/off) side-by-side for systematic tuning. The only Obsidian-MCP with built-in retrieval evaluation."
    )
    .requiredOption("--vault <path>", "Path to the Obsidian vault root")
    .requiredOption("--queries <file>", "JSONL file with {query, relevant: ['path1', ...], id?} per line")
    .option("--k <n>", "Top-K cutoff for NDCG / Recall (default 10)", "10")
    .option("--matrix", "Run a 2x2 matrix of (graph_boost ± reranker) and print a comparison table")
    .option("--reranker", "Enable cross-encoder reranking (same as serve --enable-reranker)")
    .option("--reranker-model <alias>", `Reranker alias (default rerank-multilingual)`, "rerank-multilingual")
    .option("--reranker-top-n <n>", "How many top RRF candidates to rerank (default 50)", "50")
    .option("--persistent-index", "Open the FTS5 index for BM25 retrieval (recommended)")
    .option("--per-query", "Print per-query scores in addition to aggregates (verbose)")
    .option("--json", "Emit machine-readable JSON instead of the pretty table")
    .action(
      async (opts: {
        vault: string;
        queries: string;
        k?: string;
        matrix?: boolean;
        reranker?: boolean;
        rerankerModel?: string;
        rerankerTopN?: string;
        persistentIndex?: boolean;
        perQuery?: boolean;
        json?: boolean;
      }) => {
        const { readQueriesJsonl, runEval, formatEvalResult, formatEvalMatrix } = await import("./eval.js");
        const k = parsePositiveInt(opts.k ?? "10", "--k");
        const queries = await readQueriesJsonl(opts.queries);
        if (queries.length === 0) {
          process.stderr.write(`enquire eval: ${opts.queries} contains no queries\n`);
          process.exit(1);
        }
        process.stderr.write(`enquire eval: loaded ${queries.length} queries from ${opts.queries}\n`);

        const v = new Vault(opts.vault);
        await v.ensureExists();

        // Optional FTS5 index.
        let ftsIndex: FtsIndex | null = null;
        if (opts.persistentIndex) {
          const indexFile = defaultIndexFile(v.root);
          ftsIndex = new FtsIndex({ file: indexFile, vaultRoot: v.root });
          try {
            await ftsIndex.open();
            await syncFtsIndex(v, ftsIndex);
          } catch (err) {
            ftsIndex.close();
            throw err;
          }
        }
        const embedFile = embedDbPath(v.root);

        try {
          if (opts.matrix) {
            // 2x2 matrix: (graph_boost ± reranker)
            const configs: Array<{
              label: string;
              searchOpts: { graph_boost: boolean };
              reranker?: { alias: string; topN: number };
            }> = [
              { label: "baseline (RRF only)", searchOpts: { graph_boost: false } },
              { label: "+graph-boost", searchOpts: { graph_boost: true } },
              {
                label: "+reranker",
                searchOpts: { graph_boost: false },
                reranker: {
                  alias: opts.rerankerModel ?? "rerank-multilingual",
                  topN: parsePositiveInt(opts.rerankerTopN ?? "50", "--reranker-top-n")
                }
              },
              {
                label: "+graph-boost +reranker",
                searchOpts: { graph_boost: true },
                reranker: {
                  alias: opts.rerankerModel ?? "rerank-multilingual",
                  topN: parsePositiveInt(opts.rerankerTopN ?? "50", "--reranker-top-n")
                }
              }
            ];
            const results = [];
            for (const cfg of configs) {
              process.stderr.write(`enquire eval: running config "${cfg.label}"...\n`);
              const r = await runEval({
                vault: v,
                queries,
                ftsIndex,
                embedFile,
                k,
                label: cfg.label,
                searchOpts: cfg.searchOpts,
                ...(cfg.reranker ? { reranker: cfg.reranker } : {})
              });
              results.push(r);
            }
            if (opts.json) {
              process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
            } else {
              process.stdout.write(`${formatEvalMatrix(results)}\n`);
            }
          } else {
            // Single-config run.
            const reranker = opts.reranker
              ? {
                  alias: opts.rerankerModel ?? "rerank-multilingual",
                  topN: parsePositiveInt(opts.rerankerTopN ?? "50", "--reranker-top-n")
                }
              : undefined;
            const result = await runEval({
              vault: v,
              queries,
              ftsIndex,
              embedFile,
              k,
              label: reranker ? `with-reranker(${reranker.alias})` : "default",
              ...(reranker ? { reranker } : {})
            });
            if (opts.json) {
              process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
            } else {
              process.stdout.write(`${formatEvalResult(result, { perQuery: opts.perQuery ?? false })}\n`);
            }
          }
        } finally {
          if (ftsIndex) ftsIndex.close();
        }
      }
    );

  await program.parseAsync(process.argv);
}

/**
 * Heavyweight resources shared across every MCP-server instance: the vault
 * (parsed-note cache + privacy filter), the FTS5 index handle, the optional
 * filesystem watcher. v2.6.0 split this out so the HTTP transport can spin up
 * a fresh `McpServer` per session over the SAME vault/index — opening the
 * SQLite handle once and reusing it across thousands of remote-MCP calls.
 *
 * `warningTracker` is a single-fire latch for the `--disabled-tools` /
 * `--enabled-tools` typo warnings: stdio prints them once at boot; HTTP
 * prints them on the first session build, then never again.
 */
export interface ServerDeps {
  vault: Vault;
  ftsIndex: FtsIndex | null;
  watcher: VaultWatcher | null;
  disabledTools: Set<string>;
  enabledTools: Set<string>;
  warningTracker: { printed: boolean };
  /**
   * v2.13.0 — opt-in HNSW vector index built in-memory on serve start
   * from the embed-db rows. Sub-10ms top-K queries vs O(n) brute-force.
   * `null` when `--use-hnsw` wasn't passed or the embed-db doesn't exist.
   */
  hnswContext: {
    /** The HNSW index. */
    index: import("./hnsw.js").HnswIndex;
    /** Map from HNSW label (= embeddings.id) to source row metadata. */
    rowByLabel: Map<
      number,
      {
        rel_path: string;
        chunk_index: number;
        line_start: number;
        line_end: number;
        text_preview: string;
        kind: "md" | "pdf";
      }
    >;
    /** Search-time beam width override; falls back to module default if undefined. */
    ef?: number;
  } | null;
}

/**
 * One-time bootstrap of the heavy deps (vault open + FTS5 sync + watcher).
 * Idempotent on a per-call basis but NOT designed to be called multiple
 * times in one process — the FTS5 sync would double-index. Stdio + HTTP
 * each call this exactly once at startup.
 */
export async function prepareServerDeps(opts: ServeOptions): Promise<ServerDeps> {
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
      // v2.8.0: opt-in PDF indexing. Runs after the markdown sync so
      // partial-progress logs interleave naturally. PDF extraction is
      // ~10-30x slower than markdown chunk-and-index, so we surface a
      // separate progress line for each .pdf processed.
      if (opts.includePdfs) {
        try {
          const pdfReport = await syncPdfFtsIndex(vault, ftsIndex);
          if (pdfReport.added + pdfReport.updated + pdfReport.deleted > 0) {
            process.stderr.write(
              `enquire: pdf-fts5 sync — added=${pdfReport.added} updated=${pdfReport.updated} deleted=${pdfReport.deleted} unchanged=${pdfReport.unchanged}\n`
            );
          }
        } catch (err) {
          // Bad PDF / missing pdfjs-dist — don't take down the markdown
          // index path. Markdown search keeps working without PDFs.
          process.stderr.write(
            `enquire: pdf-fts5 sync skipped — ${err instanceof Error ? err.message : String(err)}\n`
          );
        }
      }
    } catch (err) {
      // Don't leak the SQLite handle if open() succeeded but sync threw.
      ftsIndex.close();
      throw err;
    }
  }

  // Optional watcher — only when --watch is passed. Starts AFTER the initial
  // FTS5 sync so we don't double-index files during boot.
  let watcher: VaultWatcher | null = null;
  if (opts.watch) {
    watcher = new VaultWatcher({ vault, ftsIndex });
    await watcher.start();
  }

  // v2.13.0 — opt-in HNSW vector index. Built in-memory on serve start
  // from the embed-db rows. Acceptable boot-time cost (≤30s for 50K
  // chunks) in exchange for sub-10ms top-K queries thereafter, vs O(n)
  // brute-force without it. We deliberately don't persist — see
  // src/hnsw.ts header comment for the rationale.
  let hnswContext: ServerDeps["hnswContext"] = null;
  if (opts.useHnsw) {
    try {
      const embedFile = embedDbPath(vault.root);
      const fsMod = await import("node:fs");
      if (!fsMod.existsSync(embedFile)) {
        process.stderr.write(
          `enquire: --use-hnsw passed but ${embedFile} doesn't exist; skipping HNSW build. Run \`enquire-mcp build-embeddings --vault ${vault.root}\` first.\n`
        );
      } else {
        // Resolve the model dim by reading meta from the embed-db (we
        // don't know which alias the user built with — they might have
        // chosen `bge` instead of the default `multilingual`).
        // Workaround: open with the default model + dim; mismatch will
        // trigger an auto-rebuild (which is wrong). Better: peek at
        // the meta directly without reopening. For now we accept the
        // over-default-fallback risk and recommend doctor's output.
        const model = resolveModel(undefined);
        // v2.17.0 — pass through the quantization mode from CLI so the
        // schema check matches what build-embeddings wrote. Default
        // "f32" matches v2.16- behavior for users who don't set it.
        const quantization = opts.quantizeEmbeddings ?? "f32";
        const db = new EmbedDb({
          file: embedFile,
          vaultRoot: vault.root,
          modelAlias: model.alias,
          dim: model.dim,
          quantization
        });
        await db.open();
        try {
          const startMs = Date.now();
          // v2.16.0 — try to load from disk first if persistence is enabled.
          // Skip-rebuild path: ~50ms read vs ~25s build for 50K-chunk
          // vault when nothing changed since last serve. Staleness
          // detected via `EmbedDb.computeSignature()` mismatch.
          const persistFile = `${embedFile.replace(/\.embed\.db$/, "")}.hnsw`;
          const signature = db.computeSignature();
          const efOverride = opts.hnswEf ? parsePositiveInt(opts.hnswEf, "--hnsw-ef") : undefined;
          let loaded: {
            index: import("./hnsw.js").HnswIndex;
            rowByLabel: Map<
              number,
              {
                rel_path: string;
                chunk_index: number;
                line_start: number;
                line_end: number;
                text_preview: string;
                kind: "md" | "pdf";
              }
            >;
          } | null = null;
          if (opts.hnswPersist !== false) {
            const { loadHnswFromDisk } = await import("./hnsw.js");
            const loadResult = await loadHnswFromDisk(persistFile, signature);
            if (loadResult) {
              loaded = { index: loadResult.index, rowByLabel: loadResult.rowsByLabel };
              process.stderr.write(
                `enquire: HNSW index loaded from disk (${loadResult.index.size} vectors, dim=${loadResult.index.dim}, ${Date.now() - startMs}ms — signature matched)\n`
              );
            }
          }
          if (loaded) {
            hnswContext = {
              index: loaded.index,
              rowByLabel: loaded.rowByLabel,
              ...(efOverride !== undefined ? { ef: efOverride } : {})
            };
          } else {
            const rows = db.getAllVectors();
            if (rows.length === 0) {
              process.stderr.write(`enquire: --use-hnsw passed but embed-db is empty; skipping HNSW build.\n`);
            } else {
              const { buildHnsw } = await import("./hnsw.js");
              const index = await buildHnsw(
                rows.map((r) => ({ label: r.label, vector: r.vector })),
                { dim: model.dim, maxElements: rows.length }
              );
              const rowByLabel = new Map<
                number,
                {
                  rel_path: string;
                  chunk_index: number;
                  line_start: number;
                  line_end: number;
                  text_preview: string;
                  kind: "md" | "pdf";
                }
              >();
              for (const r of rows) {
                rowByLabel.set(r.label, {
                  rel_path: r.rel_path,
                  chunk_index: r.chunk_index,
                  line_start: r.line_start,
                  line_end: r.line_end,
                  text_preview: r.text_preview,
                  kind: r.kind
                });
              }
              hnswContext = { index, rowByLabel, ...(efOverride !== undefined ? { ef: efOverride } : {}) };
              process.stderr.write(
                `enquire: HNSW index built (${rows.length} vectors, dim=${model.dim}, ${Date.now() - startMs}ms)\n`
              );
              // v2.16.0 — persist the freshly-built index for next serve start.
              if (opts.hnswPersist !== false) {
                try {
                  await index.saveTo(persistFile, rowByLabel, signature);
                  process.stderr.write(`enquire: HNSW index persisted to ${persistFile}.bin (+ .meta.json)\n`);
                } catch (err) {
                  // Non-fatal — persistence is an optimization. Log + continue.
                  process.stderr.write(
                    `enquire: HNSW persist failed (continuing with in-memory index) — ${err instanceof Error ? err.message : String(err)}\n`
                  );
                }
              }
            }
          }
        } finally {
          db.close();
        }
      }
    } catch (err) {
      // Don't take down the server if HNSW build fails — fall back to
      // brute-force search. Surface as warning.
      process.stderr.write(
        `enquire: HNSW build failed; falling back to brute-force semantic search — ${err instanceof Error ? err.message : String(err)}\n`
      );
      hnswContext = null;
    }
  }

  return {
    vault,
    ftsIndex,
    watcher,
    disabledTools: new Set(opts.disabledTools ?? []),
    enabledTools: new Set(opts.enabledTools ?? []),
    warningTracker: { printed: false },
    hnswContext
  };
}

/**
 * Build a fresh `McpServer` over already-prepared deps. Cheap (just
 * registers tool handlers — no I/O, no SQLite open). Stdio calls this once;
 * HTTP calls it per session.
 */
export function buildMcpServer(deps: ServerDeps, opts: ServeOptions): McpServer {
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
  // v2.0.0-beta.1 audit fix: also track which user-supplied names actually
  // matched a registered tool. After registration, unmatched names are
  // unknown — typo or stale doc reference. Pre-fix, a typo in
  // `--disabled-tools obsidan_search` (note the missing `i`) silently
  // disabled nothing; now we log a warning so the user can correct it.
  const usedDisabled = new Set<string>();
  const usedEnabled = new Set<string>();
  const registeredNames = new Set<string>();
  // v2.6.0: only print skip-logging on the first build (stdio: once at boot;
  // HTTP: once on first session). Subsequent HTTP sessions reuse the same
  // gating decisions silently — no need to spam logs per request.
  const verbose = !deps.warningTracker.printed;
  if (deps.disabledTools.size > 0 || deps.enabledTools.size > 0) {
    const origRegisterTool = server.registerTool.bind(server) as (name: string, ...rest: unknown[]) => unknown;
    (server as unknown as { registerTool: (name: string, ...rest: unknown[]) => unknown }).registerTool = (
      name: string,
      ...rest: unknown[]
    ) => {
      registeredNames.add(name);
      if (deps.enabledTools.size > 0) {
        if (deps.enabledTools.has(name)) {
          usedEnabled.add(name);
        } else {
          if (verbose) process.stderr.write(`enquire: skipping tool ${name} (not in --enabled-tools allowlist)\n`);
          return undefined;
        }
      }
      if (deps.disabledTools.has(name)) {
        usedDisabled.add(name);
        if (verbose) process.stderr.write(`enquire: skipping tool ${name} (disabled by --disabled-tools)\n`);
        return undefined;
      }
      return origRegisterTool(name, ...rest);
    };
  }

  // v2.9.0: build reranker config from CLI opts. Off when `--enable-reranker`
  // wasn't passed; otherwise we pass through alias + top-n. The reranker
  // model itself is lazy-loaded on first search call (no boot cost).
  const rerankerConfig = opts.enableReranker
    ? {
        ...(opts.rerankerModel ? { alias: opts.rerankerModel } : {}),
        ...(opts.rerankerTopN ? { topN: parsePositiveInt(opts.rerankerTopN, "--reranker-top-n") } : {})
      }
    : null;
  registerReadTools(
    server,
    deps.vault,
    deps.ftsIndex,
    opts.diagnosticSearchTools ?? false,
    rerankerConfig,
    deps.hnswContext
  );
  if (deps.vault.writeEnabled) registerWriteTools(server, deps.vault);
  if (deps.ftsIndex && opts.diagnosticSearchTools) registerFtsTools(server, deps.ftsIndex, deps.vault);
  registerResources(server, deps.vault);
  if (deps.ftsIndex) registerChunkResource(server, deps.ftsIndex, deps.vault);
  registerPrompts(server);

  // v2.0.0-beta.1: warn on unknown names AFTER all tools are registered.
  // We can't validate at parse time because the canonical list depends on
  // runtime config (e.g. --persistent-index gates obsidian_full_text_search,
  // --enable-write gates the 5 write tools). So we wait until everything is
  // registered, then diff the user's lists against what was actually seen.
  if (verbose) {
    for (const name of deps.disabledTools) {
      if (!usedDisabled.has(name)) {
        const hint = registeredNames.has(name)
          ? "" // shouldn't happen — would have been used
          : ` (no such tool registered; check spelling; available: ${[...registeredNames].sort().join(", ")})`;
        process.stderr.write(`enquire: warning — --disabled-tools "${name}" did not match any tool${hint}\n`);
      }
    }
    for (const name of deps.enabledTools) {
      if (!usedEnabled.has(name)) {
        const hint = registeredNames.has(name)
          ? ""
          : ` (no such tool; check spelling; available: ${[...registeredNames].sort().join(", ")})`;
        process.stderr.write(`enquire: warning — --enabled-tools "${name}" did not match any tool${hint}\n`);
      }
    }
    deps.warningTracker.printed = true;
  }

  return server;
}

async function startServer(opts: ServeOptions): Promise<void> {
  const deps = await prepareServerDeps(opts);
  const { vault, ftsIndex, watcher } = deps;
  const server = buildMcpServer(deps, opts);

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

  if (watcher) {
    const closeWatcher = () => {
      void watcher?.close();
    };
    process.once("SIGINT", closeWatcher);
    process.once("SIGTERM", closeWatcher);
    process.on("beforeExit", closeWatcher);
  }

  process.stderr.write(`${formatReadyBanner(deps)} (transport=stdio)\n`);

  if (ftsIndex) {
    const closeFts = () => ftsIndex?.close();
    process.once("SIGINT", closeFts);
    process.once("SIGTERM", closeFts);
    process.on("beforeExit", closeFts);
  }
}

/**
 * Shared "ready" banner used by stdio + HTTP startup paths so the runtime
 * configuration summary is identical regardless of transport. Transport
 * suffix is appended by the caller.
 */
export function formatReadyBanner(deps: ServerDeps): string {
  const { vault, ftsIndex, watcher, disabledTools, enabledTools } = deps;
  const writeMode = vault.writeEnabled ? "WRITE-ENABLED" : "read-only";
  const cacheMode = vault.persistentCacheEnabled ? `, persistent-cache=${vault.cacheFile}` : "";
  const ftsMode = ftsIndex ? `, fts5-index (${ftsIndex.totalFiles()} files / ${ftsIndex.totalChunks()} chunks)` : "";
  const excludePart = vault.excludeGlobs.length > 0 ? `, exclude-globs=${vault.excludeGlobs.length}` : "";
  const allowPart = vault.readPaths.length > 0 ? `, read-paths=${vault.readPaths.length}` : "";
  const privacyMode = `${excludePart}${allowPart}`;
  const watchMode = watcher ? ", watch=on" : "";
  const disabledMode = disabledTools.size > 0 ? `, disabled-tools=${disabledTools.size}` : "";
  const enabledMode = enabledTools.size > 0 ? `, enabled-tools=${enabledTools.size}` : "";
  return `enquire ${VERSION} ready (${writeMode}, vault=${vault.root}${cacheMode}${ftsMode}${privacyMode}${watchMode}${disabledMode}${enabledMode})`;
}

/**
 * v2.15.0 — context-prefixed embedding text builder ("late-chunking-style"
 * context windowing). Pre-pends the document title + heading breadcrumb,
 * then includes a tail of the previous chunk + the chunk itself + a head
 * of the next chunk, all bounded so the multilingual model's 128-token
 * context budget isn't blown.
 *
 * Why: short standalone chunks ("Use Adam β=0.9, β=0.999") embed
 * identically across documents, losing the surrounding context that
 * disambiguates them. Adding ~50-100 chars of neighbor text + the
 * doc title + breadcrumb gives the bi-encoder enough signal to keep
 * cross-document semantic separation. Per Chroma 2024 + Jina AI's late
 * chunking blog: +2-5 NDCG@10 typical at zero new dep cost.
 *
 * Returns the concatenated text. When `contextChars` ≤ 0, returns the
 * legacy v2.1.0 form (just breadcrumb + chunk text), preserving
 * bit-for-bit behavior for users who don't opt in.
 */
export function buildEmbedText(
  chunks: ReadonlyArray<{ text: string; breadcrumb?: string }>,
  i: number,
  opts: { docTitle?: string; contextChars: number }
): string {
  const c = chunks[i];
  if (!c) return "";
  if (opts.contextChars <= 0) {
    // Legacy v2.1.0 form — breadcrumb only.
    return c.breadcrumb ? `${c.breadcrumb}\n\n${c.text}` : c.text;
  }
  const parts: string[] = [];
  if (opts.docTitle) parts.push(`[doc: ${opts.docTitle}]`);
  if (c.breadcrumb) parts.push(c.breadcrumb);
  // Previous chunk tail — last N chars, trimmed at word boundary.
  const prev = chunks[i - 1];
  if (prev) {
    const tail = prev.text.slice(-opts.contextChars).replace(/^\S*\s/, "");
    if (tail.length > 0) parts.push(`… ${tail}`);
  }
  parts.push(c.text);
  // Next chunk head — first N chars, trimmed at word boundary.
  const next = chunks[i + 1];
  if (next) {
    const head = next.text.slice(0, opts.contextChars).replace(/\s\S*$/, "");
    if (head.length > 0) parts.push(`${head} …`);
  }
  return parts.join("\n\n");
}

// v2.0 alpha — sync the persistent embedding index. Same incremental-rebuild
// pattern as syncFtsIndex (mtime tracked in source_state); we only re-embed
// notes whose mtime changed. Embedding is the bottleneck (~5-30ms per chunk
// CPU on M1), so incremental updates are critical for vaults of any size.
async function syncEmbedDb(
  vault: Vault,
  db: EmbedDb,
  embedder: Awaited<ReturnType<typeof loadEmbedder>>,
  opts: { lateChunkContext?: number } = {}
): Promise<{ added: number; updated: number; deleted: number; unchanged: number; total_chunks: number }> {
  const contextChars = opts.lateChunkContext ?? 0;
  const entries = await vault.listMarkdown();
  const known = new Map<string, number>();
  // v2.8.0: scope to kind="md" so the markdown-sync path doesn't see (and
  // potentially delete) PDF rows added by syncPdfEmbedDb.
  for (const s of db.getSourceStates("md")) known.set(s.rel_path, s.mtime_ms);

  const live = new Set<string>();
  let added = 0;
  let updated = 0;
  let unchanged = 0;
  // v2.0.0-beta.4: per-note progress logging. Pre-fix, build-embeddings on
  // a 100+ note vault gave the user zero feedback for 10+ minutes — when
  // it eventually hung on a pathological note (long content × big batch),
  // the user couldn't tell "still working" from "stuck forever". Now we
  // log every Nth note with running rate so the user sees life signs and
  // can ctrl-C with confidence if rate collapses to 0.
  const totalToProcess = entries.length;
  const logEvery = Math.max(1, Math.floor(totalToProcess / 20)); // ~5% increments
  let processed = 0;
  const startMs = Date.now();
  for (const e of entries) {
    live.add(e.relPath);
    const prevMtime = known.get(e.relPath);
    if (prevMtime !== undefined && prevMtime === e.mtimeMs) {
      unchanged += 1;
      processed += 1;
      continue;
    }
    try {
      const note = await vault.readNote(e.absPath, e.mtimeMs);
      const chunks = chunkContent(note.parsed.body);
      if (chunks.length === 0) {
        // No body — drop any stale entries.
        db.deleteNote(e.relPath);
        processed += 1;
        continue;
      }
      // v2.0.0-beta.4: warn when a single note produces many chunks, so the
      // user knows WHY their build is slow on this specific file.
      if (chunks.length >= 30) {
        process.stderr.write(
          `enquire: ${e.relPath} → ${chunks.length} chunks (this one will be slow; consider splitting the note)\n`
        );
      }
      // v2.1.0: prepend heading breadcrumb to embedded text so the model sees
      // structural context. Free win at zero token cost — Chroma 2024 +
      // NAACL 2025 show +2-5 NDCG@10 from breadcrumb prepending.
      // v2.15.0: when `--late-chunk-context <n>` is set, also include
      // doc title + neighbor-chunk tails so the embedding captures
      // cross-paragraph context. The text stored in `text_preview`
      // (for snippets) stays clean.
      const docTitle = note.parsed.frontmatter?.title || path.basename(e.relPath, ".md");
      const embedTexts = chunks.map((_c, i) =>
        buildEmbedText(chunks, i, {
          docTitle: typeof docTitle === "string" ? docTitle : undefined,
          contextChars
        })
      );
      const vectors = await embedder.embed(embedTexts);
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
    processed += 1;
    if (processed % logEvery === 0 || processed === totalToProcess) {
      const elapsed = (Date.now() - startMs) / 1000;
      const rate = processed / elapsed;
      const eta = totalToProcess - processed > 0 ? (totalToProcess - processed) / rate : 0;
      process.stderr.write(
        `enquire: embed sync ${processed}/${totalToProcess} (${rate.toFixed(1)} notes/s; ETA ${eta.toFixed(0)}s)\n`
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
  // v2.8.0: scope to kind="md" so markdown-sync doesn't try to delete PDF
  // rows added by syncPdfFtsIndex.
  const diff = idx.diff(live, "md");
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

/**
 * v2.8.0 — sync PDF chunks into the FTS5 index. Same incremental-mtime
 * pattern as syncFtsIndex but for PDFs: list .pdf files, diff against
 * source_state rows where kind="pdf", reindex the changed ones via
 * `extractPdfText` + `reindexPdfFile`.
 *
 * pdfjs-dist is an optionalDependency — extraction failures (missing dep
 * / corrupt PDF / encrypted without password) are caught per-file and
 * surfaced via stderr so one bad PDF doesn't poison the whole index.
 */
async function syncPdfFtsIndex(
  vault: Vault,
  idx: FtsIndex
): Promise<{ added: number; updated: number; deleted: number; unchanged: number; total_chunks: number }> {
  const pdfEntries = await vault.listFilesByExtension(".pdf");
  const live = pdfEntries.map((e) => ({ relPath: e.relPath, mtimeMs: e.mtimeMs }));
  const diff = idx.diff(live, "pdf");
  for (const relPath of diff.deleted) idx.dropFile(relPath);
  if (diff.added.length + diff.updated.length === 0) {
    return {
      added: diff.added.length,
      updated: diff.updated.length,
      deleted: diff.deleted.length,
      unchanged: diff.unchanged.length,
      total_chunks: idx.totalChunks()
    };
  }
  // Lazy import — keeps the markdown-only path zero-cost when pdfjs-dist
  // isn't installed (--omit=optional users).
  const { extractPdfText } = await import("./pdf.js");
  for (const relPath of [...diff.added, ...diff.updated]) {
    const entry = pdfEntries.find((e) => e.relPath === relPath);
    if (!entry) continue;
    try {
      const buf = await vault.readBinaryFile(entry.absPath);
      const result = await extractPdfText(buf);
      // Skip image-only PDFs (no extractable text). They'd produce a chunk
      // with only `[page: N]` markers and waste index space.
      if (!result.hasText) {
        process.stderr.write(
          `enquire: skipping ${relPath} during pdf-fts5 sync — image-only / scanned (no extractable text; use OCR via v2.9+)\n`
        );
        continue;
      }
      idx.reindexPdfFile(relPath, entry.mtimeMs, result.pages);
    } catch (err) {
      process.stderr.write(
        `enquire: skipping ${relPath} during pdf-fts5 sync — ${err instanceof Error ? err.message : String(err)}\n`
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

/**
 * v2.8.0 — sync PDF chunks into the embedding index. Mirrors syncEmbedDb
 * but for PDFs. Page boundaries are preserved as `[page: N]` markers
 * before chunking so embeddings carry page-citation context.
 */
async function syncPdfEmbedDb(
  vault: Vault,
  db: EmbedDb,
  embedder: Awaited<ReturnType<typeof loadEmbedder>>,
  opts: { lateChunkContext?: number } = {}
): Promise<{ added: number; updated: number; deleted: number; unchanged: number; total_chunks: number }> {
  const contextChars = opts.lateChunkContext ?? 0;
  const pdfEntries = await vault.listFilesByExtension(".pdf");
  const known = new Map<string, number>();
  for (const s of db.getSourceStates("pdf")) known.set(s.rel_path, s.mtime_ms);

  const live = new Set<string>();
  let added = 0;
  let updated = 0;
  let unchanged = 0;
  let skipped = 0;
  const totalToProcess = pdfEntries.length;
  if (totalToProcess === 0) {
    // Still need to handle deletions — PDFs that vanished from disk.
    let deleted = 0;
    for (const relPath of known.keys()) {
      db.deleteNote(relPath);
      deleted += 1;
    }
    return { added: 0, updated: 0, deleted, unchanged: 0, total_chunks: db.totalChunks() };
  }
  const { extractPdfText } = await import("./pdf.js");
  const logEvery = Math.max(1, Math.floor(totalToProcess / 20));
  let processed = 0;
  const startMs = Date.now();
  for (const e of pdfEntries) {
    live.add(e.relPath);
    const prevMtime = known.get(e.relPath);
    if (prevMtime !== undefined && prevMtime === e.mtimeMs) {
      unchanged += 1;
      processed += 1;
      continue;
    }
    try {
      const buf = await vault.readBinaryFile(e.absPath);
      const extracted = await extractPdfText(buf);
      if (!extracted.hasText) {
        process.stderr.write(`enquire: skipping ${e.relPath} during pdf-embed sync — image-only / scanned\n`);
        skipped += 1;
        processed += 1;
        continue;
      }
      // Reuse the same chunker as markdown so chunk identity matches across
      // BM25 / TF-IDF / embeddings rankers. Page markers travel inline.
      const joined = extracted.pages.map((p) => `[page: ${p.pageNumber}]\n${p.text}`).join("\n\n");
      const chunks = chunkContent(joined);
      if (chunks.length === 0) {
        db.deleteNote(e.relPath);
        processed += 1;
        continue;
      }
      // Same breadcrumb-prepending logic as syncEmbedDb (no-op for PDFs
      // since chunkContent returns no breadcrumb on non-markdown).
      // v2.15.0: late-chunking context windowing applies here too.
      const docTitle = path.basename(e.relPath, ".pdf");
      const embedTexts = chunks.map((_c, i) => buildEmbedText(chunks, i, { docTitle, contextChars }));
      const vectors = await embedder.embed(embedTexts);
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
      db.upsertNote(e.relPath, e.mtimeMs, rows, "pdf");
      if (prevMtime === undefined) added += 1;
      else updated += 1;
    } catch (err) {
      process.stderr.write(
        `enquire: skipping ${e.relPath} during pdf-embed sync — ${err instanceof Error ? err.message : String(err)}\n`
      );
      skipped += 1;
    }
    processed += 1;
    if (processed % logEvery === 0 || processed === totalToProcess) {
      const elapsed = (Date.now() - startMs) / 1000;
      const rate = processed / elapsed;
      const eta = totalToProcess - processed > 0 ? (totalToProcess - processed) / rate : 0;
      process.stderr.write(
        `enquire: pdf-embed sync ${processed}/${totalToProcess} (${rate.toFixed(2)} pdfs/s; ETA ${eta.toFixed(0)}s${skipped > 0 ? `; ${skipped} skipped` : ""})\n`
      );
    }
  }
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

function registerFtsTools(server: McpServer, idx: FtsIndex, vault: Vault): void {
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

function registerReadTools(
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
  hnswContext: ServerDeps["hnswContext"] = null
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
        pages: z
          .tuple([z.number().int().positive(), z.number().int().positive()])
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
        "Runs Tesseract OCR over each page of an image-only / scanned PDF, returning per-page text + per-page confidence + mean confidence + the same shape as `obsidian_read_pdf`. Use this when `obsidian_read_pdf` returns `has_text: false` (typical for scans, photographed paper, image-only PDFs). Multilingual via `lang` (default `'eng'`; multi-lang via `'+'`, e.g. `'eng+rus'`). Optional `pages` range and `scale` (DPI multiplier, default 2 ~ 150 DPI, capped at 4). ~1-2s per page on M1 CPU. Read-only. Powered by Tesseract.js (Apache-2.0; trained-data files download on first use into the local cache, ~10 MB per language) + @napi-rs/canvas for PDF→bitmap rendering. Both gated to `optionalDependencies` so the markdown-only path stays zero-cost.",
      annotations: { ...READ_ONLY, title: "OCR PDF" },
      inputSchema: {
        path: z.string().describe("Vault-relative path of the .pdf file (with or without .pdf)"),
        lang: z
          .string()
          .optional()
          .describe(
            "Tesseract language pack(s). Default 'eng'. Multi-lang via '+': 'eng+rus' for English+Russian mixed scans. Common: 'eng', 'rus', 'jpn', 'chi_sim', 'fra', 'deu'."
          ),
        pages: z
          .tuple([z.number().int().positive(), z.number().int().positive()])
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

  // v2.0 beta — hybrid RRF over BM25 + TF-IDF + embeddings. Single umbrella
  // tool that auto-detects which signals are available and gracefully
  // degrades. Equal weights, k=60 (Cormack et al's recommendation). Note-
  // level fusion: chunk hits collapse to best-rank-per-note before fusion.
  server.registerTool(
    "obsidian_search",
    {
      title: "Hybrid search (BM25 + TF-IDF + embeddings, RRF-fused)",
      description:
        '**The default search tool for v2.0.** Auto-detects every available retrieval signal — BM25 via FTS5 (if `--persistent-index`), TF-IDF cosine (always), and ML embeddings (if `enquire-mcp build-embeddings` ran) — and fuses them with Reciprocal Rank Fusion (Cormack et al, 2009) for higher recall and better paraphrase / synonym matching than any single ranker. Equal weights, k=60. Gracefully degrades: with only TF-IDF available it produces TF-IDF-style ranking; with BM25+TF-IDF it does keyword-augmented retrieval; with all 3 it matches Smart Connections-quality retrieval — free / offline / open-source. Returns per-signal observability (`per_signal: { bm25, tfidf, embeddings }`) so you can see WHY each hit ranked. **v2.8.0:** when `--include-pdfs` was passed to `serve` (or `enquire-mcp index --include-pdfs` ran), PDF chunks are blended into results — each hit carries a `kind: "md" | "pdf"` flag and PDF chunks include `[page: N]` markers in snippets so agents can cite the right page. Use this instead of the individual `_search_text` / `_full_text_search` / `_semantic_search` / `_embeddings_search` tools unless you specifically need single-ranker output for diagnostics.',
      annotations: { ...READ_ONLY, title: "Hybrid search" },
      inputSchema: {
        query: z.string().min(1).describe("Free-form query — multi-word natural language is the sweet spot"),
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
          ...(hnswContext ? { hnsw: hnswContext } : {})
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
        query: z.string().min(1).describe("Topic or question to gather context for"),
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
        key: z.string().optional().describe("Single key to read; omit for full frontmatter")
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
        key: z.string().min(1).describe("Frontmatter key to test"),
        equals: z.unknown().optional().describe("Strict equality predicate (JSON.stringify comparison)"),
        exists: z.boolean().optional().describe("Predicate: key must exist (any value)"),
        contains: z.unknown().optional().describe("For array values, value must be a member"),
        folder: z.string().optional().describe("Restrict search to a folder"),
        limit: z.number().int().positive().max(1000).optional().describe("Max matches (default 100)")
      }
    },
    async (args) => textResult(await frontmatterSearch(vault, args))
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
        "Surgical YAML manipulation: set one or more keys, or remove them by passing `null` as the value. Round-trips through gray-matter (same parser used at write time) so YAML formatting / quoting / type-coercion stays consistent. Returns `before` + `after` + list of changed keys for observability. `dry_run: true` shows the diff without writing.",
      annotations: { ...WRITE, title: "Set frontmatter" },
      inputSchema: {
        path: z.string().optional().describe("Vault-relative path"),
        title: z.string().optional().describe("Note title (filename without .md)"),
        set: z
          .record(z.string(), z.unknown())
          .describe("Keys to set. Pass `null` as value to delete a key (e.g. {status: 'published', draft: null})"),
        dry_run: z.boolean().optional().describe("Preview the diff without writing (default false)")
      }
    },
    async (args) => textResult(await frontmatterSet(vault, args))
  );
}

function registerChunkResource(server: McpServer, idx: FtsIndex, vault: Vault): void {
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

  // v2.1.0: multi-query expansion as a prompt template (NOT a server-side
  // LLM call — that would violate the MCP boundary). The agent paraphrases
  // the user's question N ways, calls obsidian_search per paraphrase, then
  // RRF-fuses the results client-side. Boosts recall on terse / ambiguous
  // queries by 5-15 NDCG@10 vs single-pass search. Pure prompt eng.
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
}

function parsePositiveInt(raw: string, flag: string): number {
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
function parseQuantizationMode(raw: string | undefined): "f32" | "int8" | undefined {
  if (raw === undefined) return undefined;
  const norm = raw.trim().toLowerCase();
  if (norm === "" || norm === "f32" || norm === "float32" || norm === "none") return "f32";
  if (norm === "int8" || norm === "i8" || norm === "q8") return "int8";
  throw new Error(
    `--quantize-embeddings must be "f32" or "int8" (got "${raw}"). ` +
      `Aliases: "none"/"float32" → f32, "q8"/"i8" → int8.`
  );
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

export { main, parsePositiveInt, parseQuantizationMode, startServer };
