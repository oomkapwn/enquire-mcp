import { Buffer } from "node:buffer";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { Command } from "commander";
import {
  CACHE_FILE_HELP,
  CACHE_SIZE_HELP,
  DIAGNOSTIC_SEARCH_TOOLS_HELP,
  DISABLED_TOOLS_HELP,
  ENABLE_WRITE_HELP,
  ENABLED_TOOLS_HELP,
  INDEX_FILE_HELP,
  MAX_FILE_BYTES_HELP,
  PERSISTENT_CACHE_HELP,
  PERSISTENT_INDEX_HELP,
  QUANTIZE_EMBEDDINGS_HELP,
  TOKENIZE_HELP,
  WATCH_HELP
} from "./cli-help.js";
import { EmbedDb, peekEmbedDbMeta } from "./embed-db.js";
import {
  DEFAULT_MODEL_ALIAS,
  DEFAULT_RERANKER_ALIAS,
  EMBEDDING_MODELS,
  loadEmbedder,
  loadReranker,
  RERANKER_MODELS,
  resolveModel,
  resolveRerankerModel,
  resolveTransformersCacheDir,
  setEmbeddingsOffline
} from "./embeddings.js";
import { defaultIndexFile, FtsIndex, peekFtsMetaSafe, planCachePrune, type TokenizeMode } from "./fts5.js";
import { VERSION } from "./index.js";
import { ocrLangIsInstalled, resolveTessdataDir } from "./ocr.js";
import { validateServeHttpRetrievalOpts } from "./retrieval-opts.js";
import {
  type ServeOptions,
  startServer,
  syncEmbedDb,
  syncFtsIndex,
  syncPdfEmbedDb,
  syncPdfFtsIndex
} from "./server.js";
import { embedDbPath, parsePositiveInt, parseQuantizationMode } from "./tool-registry.js";
import { searchHybrid } from "./tools/index.js";
import { Vault } from "./vault.js";

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

/**
 * v3.8.0-rc.1 R-3 — shared option-registration for the 8 advanced
 * retrieval flags. Pre-3.8.0 these lived ONLY on `serve`, so HTTP-mode
 * users couldn't enable cross-encoder reranking, HNSW vector search,
 * PDF indexing, or late-chunking — half the project's retrieval stack
 * was inaccessible via remote MCP. Round-20 external audit (R-3) caught
 * this as the "duplicate CLI surfaces" class D finding.
 *
 * The 8 flags (all v2.x-introduced features documented in CHANGELOG):
 *   --include-pdfs            (v2.8.0 — FTS5 + embeddings PDF indexing)
 *   --enable-reranker         (v2.9.0 — BGE cross-encoder post-RRF)
 *   --reranker-model <alias>  (v2.9.0 / v3.3.0 — alias registry)
 *   --reranker-top-n <n>      (v2.9.0 — how many fused hits to rerank)
 *   --use-hnsw                (v2.13.0 — in-memory ANN index)
 *   --hnsw-ef <n>             (v2.13.0 — search beam width)
 *   --late-chunk-context <n>  (v2.15.0 — neighbor-tail context window)
 *   --no-hnsw-persist         (v2.16.0 — disable sidecar persistence)
 *
 * A CLI-parity invariant test (`tests/cli-parity.test.ts`) asserts both
 * commands accept the same set of retrieval flags so future drift fails
 * CI rather than silently shipping an asymmetric surface.
 *
 * @param cmd - The commander `Command` (`serve` or `serve-http`) to extend.
 * @returns The same `cmd`, with the shared retrieval flags registered (chainable).
 */
function addAdvancedRetrievalOptions(cmd: Command): Command {
  return cmd
    .option(
      "--include-pdfs",
      'v2.8.0 — also index PDF files into FTS5 (and embeddings, if `enquire-mcp build-embeddings --include-pdfs` ran). With `--persistent-index`, PDF chunks become first-class hits in `obsidian_search` results, surfaced with `kind: "pdf"` flag. Off by default — opt-in because PDF text extraction is slower than markdown (~50-200ms per page on M1 cold). Requires the `pdfjs-dist` optionalDependency (default-installed unless you used `--omit=optional`).'
    )
    .option(
      "--enable-reranker",
      "v2.9.0 — enable BGE cross-encoder reranking on top of RRF in `obsidian_search`. After fusion, top-N candidates (default 50) are re-scored by a cross-encoder model and re-sorted. Adds ~30-50ms per query on M1 CPU; ≈+15.5 NDCG@10 / +24.7 MRR measured on our 60-query ablation. Off by default — opt-in because the cross-encoder model is downloaded from HuggingFace on first call (~25-110 MB depending on alias). Requires the `@huggingface/transformers` optionalDependency."
    )
    .option(
      "--reranker-model <alias>",
      "v2.9.0 (registry extended in v3.3.0) — reranker alias from RERANKER_MODELS. Default `rerank-bge` (Xenova/bge-reranker-base, ~110 MB, English; v3.6.1 — verified working end-to-end). Other options: `rerank-multilingual` / `rerank-bge-large` / `rerank-jina-tiny` / `rerank-multilingual-large` currently fail at AutoTokenizer due to transformers.js compat issue — tracked for v3.7+ restoration. Only effective with `--enable-reranker`."
    )
    .option(
      "--reranker-top-n <n>",
      "v2.9.0 — how many top RRF-fused candidates to rerank (default 50). Larger N improves recall ceiling but costs more reranker compute (~30-50ms per 50 pairs on M1). Only effective with `--enable-reranker`."
    )
    .option(
      "--use-hnsw",
      "v2.13.0 — build an in-memory HNSW vector index on serve start (or rebuild if `.embed.db` is missing). Sub-10ms top-K queries at any vault scale, vs O(n) brute-force without it. Build cost: ~5s for 8K chunks, ~25s for 50K, ~4min for 500K (one-time per serve). Recall@10 ≥ 98% vs brute-force at default params. Requires the `hnswlib-node` optionalDependency (native binding via N-API)."
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
      "--ocr-pdfs",
      "v3.9.0-rc.1 — when used with --watch + --include-pdfs, run Tesseract OCR on image-only / scanned PDFs that pdfjs can't read text from, so the watcher's embed-db sync keeps OCR'd PDFs in sync with edits during a long serve session. Without this flag, image-only PDF events drop the embed-db rows (FTS5 still reindexes from empty pages). OCR is slow (~1-2s per page on M1 CPU; bounded by --ocr-max-pages, default 200). Requires `tesseract.js` + `@napi-rs/canvas` optional dependencies + the language pack pre-installed via `enquire-mcp install-ocr-lang <code>` (the explicit, opt-in download). serve itself makes NO outbound network call — a missing pack throws fail-closed before the worker starts (v3.9.0-rc.10 offline enforcement). See SECURITY.md \"OCR network posture\"."
    )
    .option(
      "--ocr-langs <langs>",
      'v3.9.0-rc.1 — Tesseract language pack for --ocr-pdfs. Default `eng`. Multi-language via `+` (e.g. `eng+rus` for English+Russian mixed documents). Each language pack (`<lang>.traineddata`, ~10 MB) must be pre-installed via `enquire-mcp install-ocr-lang <code>` (one code per invocation, e.g. `eng`, `rus`, `chi_sim`). serve makes no runtime CDN download — a missing pack throws fail-closed (v3.9.0-rc.10). See SECURITY.md "OCR network posture".'
    )
    .option(
      "--ocr-max-pages <n>",
      "v3.9.0-rc.1 — page cap for OCR runs invoked by --ocr-pdfs. Default 200 (matches DEFAULT_OCR_MAX_PAGES). Image-only PDFs exceeding this skip the OCR pass entirely (FTS5 still reindexes from pdfjs's empty pages; embed-db rows are cleared). Lift the cap (or pass a large value) for trusted PDF sets; lower it on shared deployments to bound per-event CPU."
    )
    .option(
      "--recency-weight <w>",
      "v3.10.0-rc.5 — OPT-IN recency re-ranking for `obsidian_search`. A number in [0, 1]; default 0 (OFF — ranking stays purely relevance-driven). When > 0, the final fused order is re-sorted by `(1 - w) * relevanceRank + w * recency`, where recency decays with the note's live last-modified time (half-life = --stale-days). 0.15-0.3 gently favors fresher notes among similarly-relevant hits; 1.0 sorts almost purely by recency. The forgetting-aware knob for the Memora stale-reuse frontier — your knowledge, freshness-aware. Reflects live mtime (re-stats the candidate set), so a just-edited note is treated as fresh immediately."
    )
    .option(
      "--stale-days <n>",
      "v3.10.0-rc.5 — recency half-life in days for --recency-weight (the age at which a note's recency score is 0.5). Default 365. Lower it (e.g. 90) for fast-moving notes where staleness matters sooner; raise it for stable reference vaults. No effect unless --recency-weight > 0 (it ONLY tunes recency re-ranking). NOTE: the `stale` freshness flag on search hits always uses the fixed 365-day default and is NOT affected by this flag."
    )
    .option(
      "--feedback-weight <w>",
      "v3.11.0 — OPT-IN closed-loop feedback re-ranking for `obsidian_search`, and the gate for the `obsidian_mark_useful` tool. A number in [0, 1]; default 0 (OFF — no feedback tool, no boost; ranking stays purely relevance-driven). When > 0, registers `obsidian_mark_useful` (agents record which recalled notes actually helped a query) and re-sorts the fused order by `(1 - w) * relevanceRank + w * feedbackScore`, where feedbackScore = useful/(useful+notUseful+1) per note. 0.15-0.3 gently favors notes marked useful; 1.0 sorts almost purely by recorded usefulness. State persists per-vault in a cache sidecar (relative paths + counts only — no note content, no query text; erased by `enquire-mcp prune`)."
    );
}

/**
 * CLI entry point — the function `dist/index.js` invokes when a user runs
 * `enquire-mcp` from the terminal. Builds the commander program, registers every
 * subcommand (`serve`, `serve-http`, `setup`, `install-model`, `install-ocr-lang`,
 * `build-embeddings`, `index`, `eval`, `doctor`, `clear-cache`, `clear-index`,
 * `clear-embeddings`, `gen-token`), wires the shared retrieval flags via
 * `addAdvancedRetrievalOptions`, and parses `process.argv`. Each subcommand
 * action handles its own errors and sets `process.exitCode`; `main` itself does
 * not catch — an unexpected throw propagates to the top-level handler in
 * `index.ts` which prints it and exits non-zero.
 *
 * @returns A promise that resolves once argument parsing + the selected
 *   subcommand's action have completed (commander's `parseAsync`).
 * @example
 * ```ts
 * // dist/index.js
 * import { main } from "./cli.js";
 * main().catch((e) => { console.error(e); process.exit(1); });
 * ```
 *
 * v3.9.0-rc.28 (external-audit M-4) — the entry point previously had zero TSDoc.
 */
export async function main(): Promise<void> {
  const program = new Command();
  program
    .name("enquire-mcp")
    .description("enquire — MCP server for Obsidian vaults. Named after Tim Berners-Lee's 1980 prototype of the WWW.")
    .version(VERSION);

  const serveCmd = program
    .command("serve", { isDefault: true })
    .description("Start the MCP server over stdio")
    .requiredOption("--vault <path>", "Path to the Obsidian vault root")
    .option("--enable-write", ENABLE_WRITE_HELP)
    .option("--max-file-bytes <n>", MAX_FILE_BYTES_HELP)
    .option("--cache-size <n>", CACHE_SIZE_HELP)
    .option("--persistent-cache", PERSISTENT_CACHE_HELP)
    .option("--cache-file <path>", CACHE_FILE_HELP)
    .option("--persistent-index", PERSISTENT_INDEX_HELP)
    .option("--index-file <path>", INDEX_FILE_HELP)
    .option("--tokenize <mode>", TOKENIZE_HELP)
    .option(
      "--exclude-glob <pattern...>",
      "Glob pattern(s) — paths matching any pattern are invisible to all tools and refuse direct reads. Supports `*`, `**`, `?`. Repeatable. Example: `--exclude-glob '02_Personal/**' '*.private.md'`."
    )
    .option(
      "--read-paths <pattern...>",
      "Strict allowlist — when set, ONLY paths matching one of these glob patterns are visible. Complement to --exclude-glob (denylist). If both are set: a path must match an allow-glob AND not match any exclude-glob. Same glob semantics as --exclude-glob (`*`, `**`, `?`). Repeatable. Example: `--read-paths '01_Projects/**' '99_Daily/**'`."
    )
    .option("--watch", WATCH_HELP)
    .option("--disabled-tools <name...>", DISABLED_TOOLS_HELP)
    .option("--enabled-tools <name...>", ENABLED_TOOLS_HELP)
    .option("--diagnostic-search-tools", DIAGNOSTIC_SEARCH_TOOLS_HELP);
  addAdvancedRetrievalOptions(serveCmd)
    .option("--quantize-embeddings <mode>", QUANTIZE_EMBEDDINGS_HELP)
    .action(async (opts: ServeOptions) => {
      // Validate up-front so a bad value fails before we touch the vault, and forward the
      // NORMALIZED mode (aliases "q8"/"float32"/"none" → "int8"/"f32") — parity with
      // serve-http (v3.11.5-rc.1 CLI-QUANT-NORM-1). Downstream (server.ts) exact-matches
      // "f32"/"int8", so forwarding the raw alias silently degrades to the default.
      const quantMode = parseQuantizationMode(opts.quantizeEmbeddings as string | undefined);
      const serveOpts: ServeOptions = {
        ...opts,
        ...(quantMode !== undefined ? { quantizeEmbeddings: quantMode } : {})
      };
      // rc.42 F1 — enforce "zero cloud calls during serve": a model not already in the
      // local cache fails closed (with an install hint) instead of CDN-fetching. Must
      // run BEFORE any embedder/reranker load (startServer → prepareServerDeps).
      setEmbeddingsOffline();
      await startServer(serveOpts);
    });

  // v2.6.0 — remote-MCP HTTP transport. Mirrors `serve` flags + adds HTTP
  // surface (bearer auth, rate-limit, CORS). See docs/http-transport.md.
  const serveHttpCmd = program
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
    .option("--enable-write", ENABLE_WRITE_HELP)
    .option("--max-file-bytes <n>", MAX_FILE_BYTES_HELP)
    .option("--cache-size <n>", CACHE_SIZE_HELP)
    .option("--persistent-cache", PERSISTENT_CACHE_HELP)
    .option("--cache-file <path>", CACHE_FILE_HELP)
    .option("--persistent-index", PERSISTENT_INDEX_HELP)
    .option("--index-file <path>", INDEX_FILE_HELP)
    .option("--tokenize <mode>", TOKENIZE_HELP)
    .option("--exclude-glob <pattern...>", "Privacy denylist (same semantics as `serve`).")
    .option("--read-paths <pattern...>", "Privacy allowlist (same semantics as `serve`).")
    .option("--watch", WATCH_HELP)
    .option("--disabled-tools <name...>", DISABLED_TOOLS_HELP)
    .option("--enabled-tools <name...>", ENABLED_TOOLS_HELP)
    .option("--diagnostic-search-tools", DIAGNOSTIC_SEARCH_TOOLS_HELP);
  // v3.8.0-rc.1 R-3 — apply the same advanced-retrieval flag set as
  // `serve` so HTTP-mode users can enable reranker / HNSW / PDF indexing /
  // late-chunking. Pre-3.8.0 these flags were SILENTLY missing from
  // serve-http — bearer-authenticated clients got a strictly less-featured
  // retrieval stack than stdio clients despite "same server" framing.
  addAdvancedRetrievalOptions(serveHttpCmd)
    .option("--quantize-embeddings <mode>", QUANTIZE_EMBEDDINGS_HELP)
    .action(async (opts: HttpServeCli) => {
      // rc.42 F1 — enforce "zero cloud calls during serve" for the HTTP transport too
      // (bearer-reachable embeddings_search / reranker). Set offline before any load.
      setEmbeddingsOffline();
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
      // v3.9.0-rc.9 audit — reconcile the bearer min-length check with
      // startHttpServer (which independently throws if < 16). Enforcing it
      // here too gives the user the friendly gen-token hint + a clean exit(1)
      // instead of a deeper thrown Error from the transport layer.
      if (bearerToken.length < 16) {
        process.stderr.write(
          `enquire serve-http: --bearer-token must be ≥16 chars (got ${bearerToken.length}).\n` +
            "  Generate a strong one with: enquire-mcp gen-token\n"
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
      // v3.10.0-rc.62 (CLI-SERVEHTTP-RECENCY-FAILLATE) — fail FAST on a typo'd advanced-retrieval
      // flag. `startHttpServer` builds `prepareServerDeps` lazily (per session, on first request),
      // so a bad --recency-weight / --stale-days / --reranker-top-n would otherwise start the server
      // and only throw on the first search. Validate at boot, matching stdio `serve`.
      validateServeHttpRetrievalOpts(httpOpts);
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
    .option("--cache-file <path>", CACHE_FILE_HELP)
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
    .option("--index-file <path>", INDEX_FILE_HELP)
    .action(async (opts: { vault: string; indexFile?: string }) => {
      const vault = new Vault(opts.vault);
      await vault.ensureExists();
      const indexFile = opts.indexFile ?? defaultIndexFile(vault.root);
      // SAFE BY DESIGN (v3.6.4 K-1 invariant): `clearOnDisk()` only deletes
      // files. It never calls `.open()` → no `bootstrapSchema()` → no DROP
      // TABLE risk. Peek-before-open does not apply.
      const idx = new FtsIndex({ file: indexFile, vaultRoot: vault.root });
      const removed = await idx.clearOnDisk();
      if (removed) {
        process.stdout.write(`enquire: removed fts5 index files at ${indexFile}\n`);
      } else {
        process.stdout.write(`enquire: no fts5 index files at ${indexFile}\n`);
      }
    });

  // v3.10.0-rc.14 (bug-report Issue 4) — one-shot CLI search for smoke-tests /
  // CI / debugging without an MCP client. Builds (or reuses) the per-vault FTS5
  // index, runs the SAME hybrid `searchHybrid` the MCP `obsidian_search` tool
  // uses, and prints the results.
  program
    .command("query")
    .description(
      "Run a one-shot hybrid search (BM25 + TF-IDF + embeddings, RRF-fused) from the CLI and print the results — for quick smoke-tests / CI / debugging without an MCP client. Reuses the persistent per-vault FTS5 index (same as `serve --persistent-index`)."
    )
    .argument("<text>", "Search query")
    .requiredOption("--vault <path>", "Path to the Obsidian vault root")
    .option("--limit <n>", "Max results (default 10)", "10")
    .option("--index-file <path>", INDEX_FILE_HELP)
    .option("--json", "Emit the full JSON response instead of the pretty list")
    .action(async (text: string, opts: { vault: string; limit?: string; indexFile?: string; json?: boolean }) => {
      const v = new Vault(opts.vault);
      await v.ensureExists();
      const limit = parsePositiveInt(opts.limit ?? "10", "--limit");
      const indexFile = opts.indexFile ?? defaultIndexFile(v.root);
      // Peek tokenize_mode before constructing (v3.6.4 K-1: never DROP TABLE on
      // a mismatch) — identical to the `eval` command's safe-open pattern.
      const peeked = await peekFtsMetaSafe(indexFile);
      const honoredTokenize: TokenizeMode = peeked?.tokenize_mode ?? "unicode61";
      const ftsIndex = new FtsIndex({ file: indexFile, vaultRoot: v.root, tokenize: honoredTokenize });
      try {
        await ftsIndex.open();
        await syncFtsIndex(v, ftsIndex);
        const result = await searchHybrid(v, { query: text, limit }, { ftsIndex, embedFile: embedDbPath(v.root) });
        if (opts.json) {
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
          return;
        }
        const signals = result.signals_used.length > 0 ? result.signals_used.join("+") : "none";
        process.stdout.write(`\n${result.matches.length} result(s) for "${text}"  (signals: ${signals})\n\n`);
        for (const m of result.matches) {
          const loc = m.line_start ? `:${m.line_start}` : "";
          const snippet = m.snippet.replace(/\s+/g, " ").trim().slice(0, 160);
          process.stdout.write(`  ${m.path}${loc}  [${m.kind}]\n    ${snippet}\n`);
        }
        process.stdout.write("\n");
      } finally {
        ftsIndex.close();
      }
    });

  // v3.10.0-rc.14 (bug-report Issue 8) — GC the per-vault index clutter that
  // accumulates in the cache dir over time (one index set per vault path/config
  // hash). `clear-cache`/`clear-index` only target the CURRENT vault; `prune`
  // removes all OTHER vaults' enquire artifacts, keeping the one you name.
  // Dry-run by DEFAULT (destructive → opt in with --yes). Only ever touches
  // files matching enquire's strict artifact pattern (see `planCachePrune`).
  program
    .command("prune")
    .description(
      "Delete cached index artifacts for OTHER vaults, keeping only the named vault's — GCs the per-vault clutter that builds up in the cache dir. Dry-run by default; pass --yes to actually delete. Only ever removes enquire's own `<hash>.{json,fts5.db,embed.db,hnsw.bin,hnsw.meta.json,feedback.json}` files (incl. the `.json` parse cache that holds full note bodies, the `.feedback.json` usefulness tally, and `.tmp`/WAL sidecars)."
    )
    .requiredOption("--vault <path>", "Vault whose index to KEEP (all OTHER enquire cache artifacts are removed)")
    .option("--yes", "Actually delete (without this, prune only PREVIEWS what would be removed)")
    .action(async (opts: { vault: string; yes?: boolean }) => {
      const v = new Vault(opts.vault);
      await v.ensureExists();
      const keepFile = defaultIndexFile(v.root);
      const cacheDir = path.dirname(keepFile);
      const keepHash = path.basename(keepFile).split(".")[0] ?? "";
      let entries: string[];
      try {
        entries = await fs.readdir(cacheDir);
      } catch {
        process.stdout.write(`enquire prune: no cache directory at ${cacheDir} — nothing to prune\n`);
        return;
      }
      const removable = planCachePrune(entries, keepHash);
      if (removable.length === 0) {
        process.stdout.write(
          `enquire prune: cache already clean (kept ${keepHash}.*; 0 other artifacts in ${cacheDir})\n`
        );
        return;
      }
      // Best-effort byte sum for the report.
      let bytes = 0;
      for (const name of removable) {
        try {
          bytes += (await fs.stat(path.join(cacheDir, name))).size;
        } catch {
          /* unreadable — skip in the tally */
        }
      }
      const mb = (bytes / 1024 / 1024).toFixed(1);
      const sample = `${removable.slice(0, 5).join(", ")}${removable.length > 5 ? ", …" : ""}`;
      if (!opts.yes) {
        process.stdout.write(
          `enquire prune (DRY RUN): would remove ${removable.length} artifact(s) (~${mb} MB) from ${cacheDir}, keeping ${keepHash}.*\n` +
            `  Re-run with --yes to delete. Sample: ${sample}\n`
        );
        return;
      }
      let removed = 0;
      for (const name of removable) {
        try {
          await fs.rm(path.join(cacheDir, name), { force: true });
          removed++;
        } catch {
          /* skip unremovable entries; report the rest */
        }
      }
      process.stdout.write(
        `enquire prune: removed ${removed} artifact(s) (~${mb} MB) from ${cacheDir}, kept ${keepHash}.*\n`
      );
    });

  program
    .command("index")
    .description(
      "Cold-build (or refresh) the FTS5 search index for a vault. Useful before first --persistent-index use."
    )
    .requiredOption("--vault <path>", "Path to the Obsidian vault root")
    .option("--index-file <path>", INDEX_FILE_HELP)
    .option("--tokenize <mode>", TOKENIZE_HELP)
    .option(
      "--include-pdfs",
      "v2.8.0 — also index PDFs into the FTS5 index. Off by default; PDF extraction is slower than markdown."
    )
    .option(
      "--exclude-glob <pattern...>",
      "v3.6.2 (audit M-8) — privacy denylist (same semantics as `serve`). Paths matching any pattern are skipped at indexing time so the FTS5 db never contains private content at rest. Repeatable."
    )
    .option(
      "--read-paths <pattern...>",
      "v3.6.2 (audit M-8) — privacy allowlist (same semantics as `serve`). When set, ONLY matching paths are indexed. Repeatable."
    )
    .action(
      async (opts: {
        vault: string;
        indexFile?: string;
        tokenize?: "unicode61" | "trigram";
        includePdfs?: boolean;
        excludeGlob?: string[];
        readPaths?: string[];
      }) => {
        const vault = new Vault(opts.vault, { excludeGlobs: opts.excludeGlob, readPaths: opts.readPaths });
        await vault.ensureExists();
        const indexFile = opts.indexFile ?? defaultIndexFile(vault.root);
        // v3.6.4 K-1 closure: if user passed --tokenize, honor user's intent.
        // If not passed, peek existing to avoid silently rebuilding (which
        // would destroy a `--tokenize trigram`-built index when user just
        // wanted to refresh content). To force a rebuild with different
        // tokenize, pass --tokenize explicitly.
        let tokenize: TokenizeMode;
        if (opts.tokenize === "trigram" || opts.tokenize === "unicode61") {
          tokenize = opts.tokenize;
        } else {
          const peeked = await peekFtsMetaSafe(indexFile);
          tokenize = peeked?.tokenize_mode ?? "unicode61";
          if (peeked?.tokenize_mode === "trigram") {
            process.stderr.write(
              `enquire index: honoring existing tokenize_mode=trigram (pass --tokenize unicode61 to rebuild)\n`
            );
          }
        }
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
      `Pre-download an embedding OR reranker model so the first \`obsidian_embeddings_search\` / \`--enable-reranker\` call doesn't block on a HuggingFace download (the default cross-encoder \`${DEFAULT_RERANKER_ALIAS}\` is ~${RERANKER_MODELS[DEFAULT_RERANKER_ALIAS]?.approxSizeMB}MB). Models are cached by transformers.js inside its own package directory (run \`enquire-mcp doctor\` to see the exact resolved path) and are reused across vaults.`
    )
    .argument(
      "[alias]",
      `Embedding alias (${Object.keys(EMBEDDING_MODELS).join(" | ")}) or reranker alias (${Object.keys(RERANKER_MODELS).join(" | ")})`,
      DEFAULT_MODEL_ALIAS
    )
    .action(async (alias: string) => {
      // v3.10.0-rc.13 (bug-report Issue 3) — install-model now also pre-caches
      // cross-encoder rerankers, so `serve --enable-reranker` doesn't block on a
      // ~110 MB download at the FIRST query (which previously could exceed an MCP
      // client's tool-call timeout → unexplained RRF fallback). Reranker aliases
      // live in a separate catalog (RERANKER_MODELS); detect + route accordingly.
      if (alias in RERANKER_MODELS) {
        const rmodel = resolveRerankerModel(alias);
        process.stderr.write(
          `enquire: downloading reranker ${rmodel.hfId} (~${rmodel.approxSizeMB}MB; ${
            rmodel.multilingual ? "multilingual" : "English-only"
          } cross-encoder)...\n`
        );
        const t0 = Date.now();
        const reranker = await loadReranker(alias);
        // Smoke: score one trivial pair so an ONNX / tokenizer failure surfaces
        // HERE rather than at first MCP call. (Some multilingual aliases are
        // known to fail at AutoTokenizer — see `--reranker-model` help; this
        // makes that failure explicit at install time instead of silent later.)
        const [s] = await reranker.score("hello", ["world"]);
        if (typeof s !== "number") {
          throw new Error(`Reranker loaded but produced no score (got ${typeof s})`);
        }
        process.stdout.write(
          `enquire: reranker ${alias} ready (${Date.now() - t0}ms warmup, cached under ${resolveTransformersCacheDir() ?? "the transformers.js model cache"})\n`
        );
        return;
      }
      if (!(alias in EMBEDDING_MODELS)) {
        throw new Error(
          `Unknown model alias '${alias}'. Embedding aliases: ${Object.keys(EMBEDDING_MODELS).join(" | ")}; reranker aliases: ${Object.keys(RERANKER_MODELS).join(" | ")}.`
        );
      }
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
        `enquire: model ${alias} ready (${model.dim}-dim, ${Date.now() - t0}ms warmup, cached under ${resolveTransformersCacheDir() ?? "the transformers.js model cache"})\n`
      );
    });

  program
    .command("install-ocr-lang")
    .description(
      "Download a Tesseract OCR language pack (`<code>.traineddata`, ~10 MB) into the local tessdata cache so `--ocr-pdfs` works fully offline during serve — no runtime CDN fetch. This is the ONLY OCR-related network call and it is explicit + opt-in (mirrors `install-model` for embeddings). Codes: https://github.com/tesseract-ocr/tessdata_fast (e.g. eng, rus, jpn, chi_sim, deu, fra, spa). One code per invocation."
    )
    .argument("<code>", "Tesseract language code (e.g. eng, rus, jpn, chi_sim)")
    .action(async (code: string) => {
      const lang = code.trim();
      // `lang` is interpolated into BOTH a URL and a filesystem path, so reject
      // anything but a plain Tesseract code (prevents path traversal + URL
      // injection). Tesseract codes are alphanumeric + underscore (e.g. chi_sim).
      if (!/^[a-z0-9_]+$/i.test(lang)) {
        process.stderr.write(
          `enquire install-ocr-lang: invalid language code '${code}'. Use a plain Tesseract code like 'eng', 'rus', 'chi_sim' (one per invocation, no '+').\n`
        );
        process.exit(1);
      }
      const dir = resolveTessdataDir();
      const dest = path.join(dir, `${lang}.traineddata`);
      if (ocrLangIsInstalled(lang, dir)) {
        process.stdout.write(`enquire: OCR language '${lang}' already installed (${dest}).\n`);
        return;
      }
      const url = `https://github.com/tesseract-ocr/tessdata_fast/raw/main/${lang}.traineddata`;
      process.stderr.write(`enquire: downloading Tesseract language pack '${lang}' from ${url} ...\n`);
      let res: Response;
      try {
        res = await fetch(url);
      } catch (err) {
        process.stderr.write(
          `enquire install-ocr-lang: network error fetching '${lang}': ${err instanceof Error ? err.message : String(err)}\n`
        );
        process.exit(1);
        return;
      }
      if (!res.ok) {
        process.stderr.write(
          `enquire install-ocr-lang: download failed (HTTP ${res.status}) for '${lang}'. ` +
            "Verify the code exists at https://github.com/tesseract-ocr/tessdata_fast.\n"
        );
        process.exit(1);
      }
      const bytes = Buffer.from(await res.arrayBuffer());
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(dest, bytes);
      process.stdout.write(
        `enquire: OCR language '${lang}' ready (${(bytes.length / 1e6).toFixed(1)} MB, cached at ${dest}). ` +
          "`serve --ocr-pdfs` now OCRs this language fully offline.\n"
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
    .option("--quantize-embeddings <mode>", QUANTIZE_EMBEDDINGS_HELP)
    .action(
      async (
        opts: {
          vault: string;
          embeddingModel?: string;
          embedFile?: string;
          excludeGlob?: string[];
          readPaths?: string[];
          includePdfs?: boolean;
          lateChunkContext?: string;
          quantizeEmbeddings?: string;
        },
        command: Command
      ) => {
        const vault = new Vault(opts.vault, { excludeGlobs: opts.excludeGlob, readPaths: opts.readPaths });
        await vault.ensureExists();
        const embedFile = opts.embedFile ?? embedDbPath(vault.root);
        // v3.6.4 K-1 closure: peek existing embed-db before constructing
        // EmbedDb. If user didn't explicitly pass --embedding-model /
        // --quantize-embeddings, honor the existing config to avoid silent
        // rebuild (which destroys the user's pre-built data). To force a
        // switch, pass the explicit flag.
        const explicitModel = command.getOptionValueSource("embeddingModel") === "cli";
        const explicitQuant = command.getOptionValueSource("quantizeEmbeddings") === "cli";
        const peeked = await peekEmbedDbMeta(embedFile);
        const requestedModel = resolveModel(opts.embeddingModel);
        let model = requestedModel;
        if (!explicitModel && peeked?.model_alias) {
          const honored = resolveModel(peeked.model_alias);
          if (honored.alias !== requestedModel.alias) {
            process.stderr.write(
              `enquire build-embeddings: honoring existing model_alias=${peeked.model_alias} (pass --embedding-model to override)\n`
            );
            model = honored;
          }
        }
        const requestedQuant = parseQuantizationMode(opts.quantizeEmbeddings) ?? "f32";
        let quantization = requestedQuant;
        if (!explicitQuant && peeked?.quantization && peeked.quantization !== requestedQuant) {
          quantization = peeked.quantization === "int8" ? "int8" : "f32";
          process.stderr.write(
            `enquire build-embeddings: honoring existing quantization=${peeked.quantization} (pass --quantize-embeddings to override)\n`
          );
        }
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
          const embedder = await loadEmbedder(model.alias);
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
    .description(
      "Delete the embedding index files (.embed.db + WAL/SHM sidecar + HNSW .hnsw.bin/.hnsw.meta.json sidecars) for a given vault"
    )
    .requiredOption("--vault <path>", "Vault whose embedding index to delete")
    .option("--embed-file <path>", "Override the embedding-index file location")
    .action(async (opts: { vault: string; embedFile?: string }) => {
      const vault = new Vault(opts.vault);
      await vault.ensureExists();
      const file = opts.embedFile ?? embedDbPath(vault.root);
      // SAFE BY DESIGN (v3.6.4 K-1 invariant): `clearOnDisk()` only deletes
      // files. It never calls `.open()` → no `bootstrapSchema()` → no DROP
      // TABLE risk. Dummy `modelAlias`/`dim` are never consulted because
      // we never construct the schema. Peek-before-open does not apply.
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
    .option(
      "--exclude-glob <pattern...>",
      "Privacy denylist (same semantics as `serve`) — counts + checks reflect the filter."
    )
    .option(
      "--read-paths <pattern...>",
      "Privacy allowlist (same semantics as `serve`) — counts + checks reflect the filter."
    )
    .option("--json", "Emit machine-readable JSON instead of the colored banner")
    .action(async (opts: { vault: string; json?: boolean; excludeGlob?: string[]; readPaths?: string[] }) => {
      const { runDoctor, formatDoctorResult } = await import("./doctor.js");
      const result = await runDoctor({
        vault: opts.vault,
        modelEntry: EMBEDDING_MODELS[DEFAULT_MODEL_ALIAS],
        ...(opts.excludeGlob ? { excludeGlobs: opts.excludeGlob } : {}),
        ...(opts.readPaths ? { readPaths: opts.readPaths } : {})
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
    .option("--quantize-embeddings <mode>", QUANTIZE_EMBEDDINGS_HELP)
    .option(
      "--exclude-glob <pattern...>",
      "v3.6.2 (audit M-8) — privacy denylist (same semantics as `serve`). Paths matching any pattern are skipped during BOTH the FTS5 index build AND the embedding build so neither db contains private content at rest. Repeatable."
    )
    .option(
      "--read-paths <pattern...>",
      "v3.6.2 (audit M-8) — privacy allowlist (same semantics as `serve`). When set, ONLY matching paths are indexed/embedded. Repeatable."
    )
    .action(
      async (
        opts: {
          vault: string;
          embeddingModel?: string;
          includePdfs?: boolean;
          skipEmbeddings?: boolean;
          quantizeEmbeddings?: string;
          excludeGlob?: string[];
          readPaths?: string[];
        },
        command: Command
      ) => {
        const v = new Vault(opts.vault, { excludeGlobs: opts.excludeGlob, readPaths: opts.readPaths });
        await v.ensureExists();
        process.stdout.write(`enquire setup — ${opts.vault}\n\n`);

        // Step 1: FTS5 index.
        process.stdout.write(">> Step 1/3: Cold-build FTS5 index\n");
        const indexFile = defaultIndexFile(v.root);
        // v3.6.4 K-1 closure (setup is idempotent per its description):
        // honor existing tokenize_mode so re-running `setup` on a vault
        // built with `--tokenize trigram` doesn't silently downgrade to
        // unicode61. The setup command has no `--tokenize` flag, so the
        // user's only way to "switch" is to clear-index first.
        const peekedFts = await peekFtsMetaSafe(indexFile);
        const setupTokenize: TokenizeMode = peekedFts?.tokenize_mode ?? "unicode61";
        if (peekedFts?.tokenize_mode === "trigram") {
          process.stdout.write(`   (honoring existing tokenize_mode=trigram — run clear-index then setup to reset)\n`);
        }
        const idx = new FtsIndex({ file: indexFile, vaultRoot: v.root, tokenize: setupTokenize });
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

        // v3.6.4 K-1 closure: peek existing embed-db BEFORE loading the
        // embedder so step 2 loads the right model. setup is idempotent
        // per its description — re-running on a vault built with
        // `--embedding-model bge` must NOT silently rebuild as
        // multilingual. Honor existing model unless user passed
        // --embedding-model explicitly on the CLI.
        const embedFile = embedDbPath(v.root);
        const explicitEmbedModel = command.getOptionValueSource("embeddingModel") === "cli";
        const explicitQuant = command.getOptionValueSource("quantizeEmbeddings") === "cli";
        const peekedEmbed = await peekEmbedDbMeta(embedFile);
        const requestedModel = resolveModel(opts.embeddingModel);
        let setupModel = requestedModel;
        if (!explicitEmbedModel && peekedEmbed?.model_alias) {
          setupModel = resolveModel(peekedEmbed.model_alias);
          if (setupModel.alias !== requestedModel.alias) {
            process.stdout.write(
              `   (note: existing embed-db built with ${peekedEmbed.model_alias}; honoring it — pass --embedding-model to override)\n`
            );
          }
        }
        const requestedQuant = parseQuantizationMode(opts.quantizeEmbeddings) ?? "f32";
        let quantization = requestedQuant;
        if (!explicitQuant && peekedEmbed?.quantization && peekedEmbed.quantization !== requestedQuant) {
          quantization = peekedEmbed.quantization === "int8" ? "int8" : "f32";
          process.stdout.write(
            `   (note: existing embed-db built with quantization=${peekedEmbed.quantization}; honoring it — pass --quantize-embeddings to override)\n`
          );
        }

        // Step 2: Install-model (load the resolved/honored model).
        process.stdout.write("\n>> Step 2/3: Install embedding model\n");
        const t0 = Date.now();
        const embedder = await loadEmbedder(setupModel.alias);
        const [smokeVec] = await embedder.embed(["hello"]);
        if (!smokeVec || smokeVec.length !== setupModel.dim) {
          throw new Error(
            `Model ${setupModel.alias} loaded but dim mismatch: ${smokeVec?.length} vs ${setupModel.dim}`
          );
        }
        process.stdout.write(
          `   model ${setupModel.alias} ready (${setupModel.dim}-dim, ${Date.now() - t0}ms warmup, cached under ${resolveTransformersCacheDir() ?? "the transformers.js model cache"})\n`
        );

        // Step 3: build-embeddings.
        process.stdout.write("\n>> Step 3/3: Build embedding index\n");
        const db = new EmbedDb({
          file: embedFile,
          vaultRoot: v.root,
          modelAlias: setupModel.alias,
          dim: setupModel.dim,
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
    .option(
      "--reranker-model <alias>",
      "Reranker alias (default rerank-bge — v3.6.1 only verified-working alias)",
      "rerank-bge"
    )
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
          // v3.6.4 K-1 closure (eval = diagnostic, MUST never destroy):
          // peek existing tokenize_mode before constructing. Without peek,
          // an eval run against a `--tokenize trigram`-built index would
          // silently DROP TABLE because the default `unicode61` mismatches.
          // Same class as the doctor.ts:328 fix in v3.6.2.
          const peeked = await peekFtsMetaSafe(indexFile);
          const honoredTokenize: TokenizeMode = peeked?.tokenize_mode ?? "unicode61";
          ftsIndex = new FtsIndex({ file: indexFile, vaultRoot: v.root, tokenize: honoredTokenize });
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
                  alias: opts.rerankerModel ?? "rerank-bge",
                  topN: parsePositiveInt(opts.rerankerTopN ?? "50", "--reranker-top-n")
                }
              },
              {
                label: "+graph-boost +reranker",
                searchOpts: { graph_boost: true },
                reranker: {
                  alias: opts.rerankerModel ?? "rerank-bge",
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
                  alias: opts.rerankerModel ?? "rerank-bge",
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
