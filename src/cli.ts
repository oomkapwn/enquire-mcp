import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { Command } from "commander";
import { executeCachePrune, previewCachePrune } from "./cache-prune.js";
import {
  CACHE_FILE_HELP,
  CACHE_SIZE_HELP,
  CONFIG_CLIENT_HELP,
  CONFIG_HTTP_HELP,
  CONFIG_NAME_HELP,
  CONFIG_TIER_HELP,
  DIAGNOSTIC_SEARCH_TOOLS_HELP,
  DISABLED_TOOLS_HELP,
  EMBED_FILE_HELP,
  EMBEDDING_INDEX_HELP,
  ENABLE_WRITE_HELP,
  ENABLED_TOOLS_HELP,
  EXCLUDE_GLOB_HELP,
  INDEX_FILE_HELP,
  MAX_FILE_BYTES_HELP,
  NO_HNSW_PERSIST_HELP,
  PERSISTENT_CACHE_HELP,
  PERSISTENT_INDEX_HELP,
  PROMPTS_HELP,
  QUANTIZE_EMBEDDINGS_HELP,
  READ_PATHS_HELP,
  TOKENIZE_HELP,
  WATCH_HELP
} from "./cli-help.js";
import { assertEmbedDbRecoveryOwnership, discoverEmbedDbConfig, EmbedDb } from "./embed-db.js";
import {
  embedConfigurationNeedsReplacement,
  loadValidatedEmbedder,
  replaceEmbeddingIndex
} from "./embed-replacement.js";
import {
  DEFAULT_MODEL_ALIAS,
  DEFAULT_RERANKER_ALIAS,
  EMBEDDING_MODELS,
  loadEmbedder,
  loadReranker,
  RERANKER_MODELS,
  resolveModel,
  resolveRerankerModel,
  resolveStoredEmbeddingConfiguration,
  resolveTransformersCacheDir,
  setEmbeddingsOffline
} from "./embeddings.js";
import { buildFirstRunPlan, executeFirstRunPlan, type FirstRunStep, renderFirstRunStep } from "./first-run.js";
import {
  assertTokenizeMode,
  defaultIndexFile,
  discoverFtsIndexConfig,
  FtsIndex,
  type FtsIndexDiscovery,
  syncFtsIndex,
  syncPdfFtsIndex,
  type TokenizeMode
} from "./fts5.js";
import { VERSION } from "./index.js";
import {
  buildPrivacyArgs,
  CONFIG_CLIENTS,
  CONFIG_TIERS,
  type ConfigClient,
  type ConfigInput,
  isConfigTier,
  isValidServerName,
  preflightHint,
  renderAllClients,
  renderClientConfig,
  renderShellCommand,
  shellQuote
} from "./mcp-config.js";
import { ocrLangIsInstalled, resolveTessdataDir } from "./ocr.js";
import { resolvePersistenceLeaseScope } from "./persistence-lease.js";
import { validateServeHttpRetrievalOpts } from "./retrieval-opts.js";
import { FTS_SCHEMA_VERSION } from "./schema-contract.js";
import { type ServeOptions, startServer, syncEmbedDb, syncPdfEmbedDb } from "./server.js";
import { embedDbPath, parsePositiveInt, parseQuantizationMode } from "./tool-registry.js";
import { searchHybrid } from "./tools/index.js";
import { Vault } from "./vault.js";
import { assertWatcherActivationGuardClear } from "./watcher-activation-guard.js";

/** Raw `serve` flags as parsed by commander. */
interface ServeCli extends Omit<ServeOptions, "tokenize"> {
  /** Untrusted tokenizer flag; validated before server preparation. */
  tokenize?: string;
}

/** Raw `serve-http` flags as parsed by commander (string-typed). */
interface HttpServeCli extends Omit<ServeOptions, "tokenize"> {
  /** Untrusted tokenizer flag; validated before HTTP or server preparation. */
  tokenize?: string;
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
 * One-shot `query` and diagnostic `eval` honor `--exclude-glob` / `--read-paths`
 * at search time via the Vault they construct. They must not persist those
 * filters as FTS deletions into the shared default per-vault index
 * (`defaultIndexFile`), which `serve --persistent-index` also uses. Identity is
 * resolved through the persistence-lease canonical parent + target identity,
 * not whether `--index-file` was spelled: naming the default file through a
 * parent-directory symlink is still the shared file. A proven-distinct
 * `--index-file` is a dedicated index the caller owns; privacy-filtered sync
 * there remains the M-8 contract. The selected parent is canonicalized before
 * discovery/open so stable lexical parent aliases converge, while the exact
 * leaf spelling remains the caller-selected storage path rather than the
 * NFC/folded lease identity. An
 * identity-resolution failure is not proof of a dedicated target and
 * therefore fails closed by withholding sync.
 * Privacy on that shared or unproven destination also skips `open()` unless
 * this invocation's discovery is already `owned` at the live `FTS_SCHEMA_VERSION`:
 * missing, empty, and legacy files at discovery time are left untouched
 * (search uses `ftsIndex: null`) because `open()` CREATE/DROP+rebuilds then
 * skip-sync would empty the shared index. A current-schema shared `open()` still
 * runs WAL/pragma/chmod/triggers. An owned discovery that races to missing
 * before `open()` is the existing stale-discovery CREATE class, not a privacy
 * sync. `serve` / `serve-http` are writers of the Vault they were started with
 * and are unchanged.
 */
async function resolvePersistentFtsReadTarget(
  opts: {
    excludeGlob?: string[];
    readPaths?: string[];
  },
  indexFile: string,
  vaultRoot: string
): Promise<{ file: string; shouldSync: boolean }> {
  const privacyActive = (opts.excludeGlob?.length ?? 0) > 0 || (opts.readPaths?.length ?? 0) > 0;
  if (!privacyActive) return { file: indexFile, shouldSync: true };
  let selected: Awaited<ReturnType<typeof resolvePersistenceLeaseScope>>;
  try {
    selected = await resolvePersistenceLeaseScope({ targetPath: indexFile, familyKey: "fts5-v1" });
  } catch {
    return { file: indexFile, shouldSync: false };
  }
  // `targetName` is an NFC-normalized lease identity, not a storage pathname.
  // Preserve the exact caller-selected leaf so a normalization-sensitive
  // filesystem cannot redirect an existing NFD index to a new NFC sibling.
  const canonicalSelected = path.join(selected.canonicalParent, path.basename(path.resolve(indexFile)));
  const sharedFile = defaultIndexFile(vaultRoot);
  try {
    const shared = await resolvePersistenceLeaseScope({ targetPath: sharedFile, familyKey: "fts5-v1" });
    const sameParentIdentity =
      selected.parentIdentity.dev === shared.parentIdentity.dev &&
      selected.parentIdentity.ino === shared.parentIdentity.ino;
    if (selected.canonicalParent === shared.canonicalParent && !sameParentIdentity) {
      return { file: canonicalSelected, shouldSync: false };
    }
    return {
      file: canonicalSelected,
      shouldSync: !(sameParentIdentity && selected.targetName === shared.targetName)
    };
  } catch (error) {
    const defaultParentIsMissing =
      typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
    return {
      file: canonicalSelected,
      shouldSync: defaultParentIsMissing && canonicalSelected !== path.resolve(sharedFile)
    };
  }
}

function shouldOpenPersistentFtsForReadPath(shouldSync: boolean, discovered: FtsIndexDiscovery): boolean {
  if (shouldSync) return true;
  return discovered.kind === "owned" && discovered.meta.schema_version === String(FTS_SCHEMA_VERSION);
}

async function resolveConfiguredVault(
  vaultPath: string,
  privacy: { excludeGlobs?: string[]; readPaths?: string[] }
): Promise<Vault> {
  const vault = new Vault(path.resolve(vaultPath), privacy);
  await vault.ensureExists();
  if (
    [...vault.root].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  ) {
    throw new Error("Vault paths containing control characters cannot be rendered safely");
  }
  return vault;
}

async function assertEmbeddingWriterGuardClear(
  embedFile: string,
  vaultRoot: string,
  commandName: "build-embeddings" | "setup",
  customEmbedFile = false
): Promise<void> {
  try {
    await assertWatcherActivationGuardClear(embedFile);
  } catch (error) {
    await assertEmbedDbRecoveryOwnership(embedFile, vaultRoot);
    const customRecoveryGuidance = customEmbedFile
      ? " Because this command selected a custom embedding index, repeat the exact same `--embed-file` option " +
        "on both `clear-embeddings` and the rebuild command; the absolute path is intentionally omitted here."
      : "";
    const rebuildGuidance =
      commandName === "setup"
        ? "If FTS setup is needed, rerun setup with `--skip-embeddings`; rebuild embeddings separately with " +
          "`enquire-mcp build-embeddings --vault <vault>` using the same model, quantization, late-chunk, " +
          "privacy and PDF settings."
        : "Then rerun this build-embeddings command with the same model, quantization, late-chunk, privacy " +
          "and PDF settings.";
    throw new Error(
      `enquire ${commandName}: an incomplete watcher startup quarantined this embedding index. ` +
        "Stop every enquire-mcp process using the vault, then run the strict " +
        "`enquire-mcp clear-embeddings --vault <vault>` recovery. It refuses unsafe or foreign interlock " +
        "shapes before deleting indexes; if it refuses, inspect the guard without following it and remove it " +
        `only after a manual ownership audit.${customRecoveryGuidance} ${rebuildGuidance}`,
      { cause: error }
    );
  }
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
      "v2.9.0 — enable BGE cross-encoder reranking on top of RRF in `obsidian_search`. After fusion, top-N candidates (default 50) are re-scored by a cross-encoder model and re-sorted. Adds ~30-50ms per query on M1 CPU; ≈+15.5 NDCG@10 / +24.7 MRR measured on our 60-query ablation. Off by default — opt-in and requires a locally cached model (~25-110 MB; run `enquire-mcp install-model rerank-bge` before serving) plus the `@huggingface/transformers` optionalDependency."
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
      "v2.13.0 — build an in-memory HNSW approximate nearest-neighbor index on serve start (or rebuild if `.embed.db` is missing), replacing the O(n) brute-force dense path. Build time, query latency, and recall depend on corpus, hardware, and HNSW parameters; benchmark your vault before setting an SLO. Requires the `hnswlib-node` optionalDependency (native binding via N-API)."
    )
    .option(
      "--hnsw-ef <n>",
      "v2.13.0 — HNSW search-time beam width (default 100; must be ≥ requested k). Higher = more accurate, slightly slower. Common range: 50-500. Only effective with `--use-hnsw`."
    )
    .option(
      "--late-chunk-context <chars>",
      "v2.15.0 — late-chunking-style context windowing on embeddings. When > 0, prepends doc title + heading breadcrumb + tails of neighboring chunks (this many chars from each side) before sending to the embedder. Typical +2-5 NDCG@10 retrieval boost at zero new dep cost. Default 0 (off; matches v2.1.0+ breadcrumb-only behavior). Applies during `build-embeddings` and, with `serve --watch`, to subsequently refreshed chunks; it does not rebuild existing rows at serve start."
    )
    .option("--no-hnsw-persist", NO_HNSW_PERSIST_HELP)
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
      "v3.11.0 — OPT-IN closed-loop feedback re-ranking for `obsidian_search`, and the gate for the `obsidian_mark_useful` tool. A number in [0, 1]; default 0 (OFF — no feedback tool, no boost; ranking stays purely relevance-driven). When > 0, registers `obsidian_mark_useful` (agents record which recalled notes actually helped a query) and re-sorts the fused order by `(1 - w) * relevanceRank + w * feedbackScore`, where feedbackScore = useful/(useful+notUseful+1) per note. 0.15-0.3 gently favors notes marked useful; 1.0 sorts almost purely by recorded usefulness. State persists in a root-checked, legacy-routing-key-scoped cache sidecar containing the canonical absolute vault root plus relative path keys, counts, and ISO timestamps — no note content, snippets, or query text. `prune` recognizes other stems; the SHA1-12 stem is not collision-proof vault identity."
    );
}

/**
 * CLI entry point — the function `dist/index.js` invokes when a user runs
 * `enquire-mcp` from the terminal. Builds the commander program, registers every
 * subcommand (`serve`, `serve-http`, `setup`, `configure`, `install-model`,
 * `install-ocr-lang`, `build-embeddings`, `index`, `eval`, `doctor`, `clear-cache`,
 * `clear-index`, `clear-embeddings`, `gen-token`), wires the shared retrieval flags via
 * `addAdvancedRetrievalOptions`, and parses `process.argv`. Each subcommand
 * action handles its own errors and sets `process.exitCode`; `main` itself does
 * not catch — an unexpected throw propagates to the top-level handler in
 * `index.ts` which prints it and exits non-zero.
 *
 * @param invocation - Physical Node + package entry identity captured by the
 * CLI entry guard. Programmatic callers may omit it and use the exact-version
 * npx fallback for generated commands.
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
export async function main(invocation?: ConfigInput["invocation"]): Promise<void> {
  const program = new Command();
  const exactPackageSpec = `@oomkapwn/enquire-mcp@${VERSION}`;
  const invocationPrefix = invocation
    ? renderShellCommand(invocation.command, invocation.argsPrefix, process.platform)
    : renderShellCommand("npx", ["-y", exactPackageSpec], process.platform);
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
    .option("--exclude-glob <pattern...>", EXCLUDE_GLOB_HELP)
    .option("--read-paths <pattern...>", READ_PATHS_HELP)
    .option("--watch", WATCH_HELP)
    .option("--disabled-tools <name...>", DISABLED_TOOLS_HELP)
    .option("--enabled-tools <name...>", ENABLED_TOOLS_HELP)
    .option("--no-prompts", PROMPTS_HELP)
    .option("--no-embedding-index", EMBEDDING_INDEX_HELP)
    .option("--diagnostic-search-tools", DIAGNOSTIC_SEARCH_TOOLS_HELP);
  addAdvancedRetrievalOptions(serveCmd)
    .option("--quantize-embeddings <mode>", QUANTIZE_EMBEDDINGS_HELP)
    .action(async (opts: ServeCli) => {
      const { tokenize: rawTokenize, ...serveBaseOpts } = opts;
      const tokenize = rawTokenize === undefined ? undefined : assertTokenizeMode(rawTokenize, "--tokenize");
      // Validate up-front so a bad value fails before we touch the vault, and forward the
      // NORMALIZED mode (aliases "q8"/"float32"/"none" → "int8"/"f32") — parity with
      // serve-http (v3.11.5-rc.1 CLI-QUANT-NORM-1). Downstream (server.ts) exact-matches
      // "f32"/"int8", so forwarding the raw alias silently degrades to the default.
      const quantMode = parseQuantizationMode(opts.quantizeEmbeddings as string | undefined);
      const serveOpts: ServeOptions = {
        ...serveBaseOpts,
        ...(tokenize !== undefined ? { tokenize } : {}),
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
      "Exact browser Origin allowlist (repeatable). A present unlisted Origin gets 403 before request handling. Wildcard '*' is rejected; use exact origins like https://claude.ai."
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
    .option("--exclude-glob <pattern...>", EXCLUDE_GLOB_HELP)
    .option("--read-paths <pattern...>", READ_PATHS_HELP)
    .option("--watch", WATCH_HELP)
    .option("--disabled-tools <name...>", DISABLED_TOOLS_HELP)
    .option("--enabled-tools <name...>", ENABLED_TOOLS_HELP)
    .option("--no-prompts", PROMPTS_HELP)
    .option("--no-embedding-index", EMBEDDING_INDEX_HELP)
    .option("--diagnostic-search-tools", DIAGNOSTIC_SEARCH_TOOLS_HELP);
  // v3.8.0-rc.1 R-3 — apply the same advanced-retrieval flag set as
  // `serve` so HTTP-mode users can enable reranker / HNSW / PDF indexing /
  // late-chunking. Pre-3.8.0 these flags were SILENTLY missing from
  // serve-http — bearer-authenticated clients got a strictly less-featured
  // retrieval stack than stdio clients despite "same server" framing.
  addAdvancedRetrievalOptions(serveHttpCmd)
    .option("--quantize-embeddings <mode>", QUANTIZE_EMBEDDINGS_HELP)
    .action(async (opts: HttpServeCli) => {
      // Project Commander's raw HTTP-only spellings away before the closed-world
      // ServeOptions boundary. Keeping a generic `...opts` rest here leaked
      // `rateLimit`, `bearerTokenEnv`, and `corsOrigin` into prepareServerDeps;
      // once ServeOptions became typo-strict, an otherwise valid serve-http
      // invocation failed before opening the vault. Every transport field is
      // named explicitly so a future CLI-only option cannot cross accidentally.
      const {
        tokenize: rawTokenize,
        port: rawPort,
        host: rawHost,
        bearerToken: rawBearerToken,
        bearerTokenEnv: rawBearerTokenEnv,
        mcpPath: rawMcpPath,
        rateLimit: rawRateLimit,
        corsOrigin: rawCorsOrigins,
        healthPath: rawHealthPath,
        stateful: rawStateful,
        sessionIdleTimeoutMs: rawSessionIdleTimeoutMs,
        maxSessions: rawMaxSessions,
        quantizeEmbeddings: rawQuantizeEmbeddings,
        ...serveBaseOpts
      } = opts;
      const tokenize = rawTokenize === undefined ? undefined : assertTokenizeMode(rawTokenize, "--tokenize");
      // rc.42 F1 — enforce "zero cloud calls during serve" for the HTTP transport too
      // (bearer-reachable embeddings_search / reranker). Set offline before any load.
      setEmbeddingsOffline();
      const tokenFromArg = typeof rawBearerToken === "string" ? rawBearerToken.trim() : "";
      const tokenFromEnv = typeof rawBearerTokenEnv === "string" ? (process.env[rawBearerTokenEnv] ?? "").trim() : "";
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
      const portRaw = rawPort ?? "3000";
      const portNum = /^(?:0|[1-9][0-9]*)$/u.test(portRaw) ? Number(portRaw) : Number.NaN;
      if (!Number.isSafeInteger(portNum) || portNum < 0 || portNum > 65535) {
        throw new Error(`--port must be an integer in [0, 65535]; got "${rawPort}"`);
      }
      // v2.14.0 — stateful-mode opts. Tolerate missing flags (default to
      // standard values) and validate parsed integers.
      const sessionIdleMs =
        rawSessionIdleTimeoutMs !== undefined
          ? parsePositiveInt(rawSessionIdleTimeoutMs, "--session-idle-timeout-ms")
          : 30 * 60 * 1000;
      const maxSessionsCap = rawMaxSessions !== undefined ? parsePositiveInt(rawMaxSessions, "--max-sessions") : 100;
      // v2.17.0 — fail fast on a typo'd quantization mode.
      const quantMode = parseQuantizationMode(rawQuantizeEmbeddings as string | undefined);
      const rateLimitRaw = rawRateLimit ?? "120";
      const rateLimitPerMinute = /^(?:0|[1-9][0-9]*)$/u.test(rateLimitRaw) ? Number(rateLimitRaw) : Number.NaN;
      const httpOpts = {
        ...serveBaseOpts,
        ...(tokenize !== undefined ? { tokenize } : {}),
        ...(quantMode !== undefined ? { quantizeEmbeddings: quantMode } : {}),
        port: portNum,
        host: rawHost ?? "127.0.0.1",
        bearerToken,
        mcpPath: rawMcpPath ?? "/mcp",
        rateLimitPerMinute,
        corsOrigins: rawCorsOrigins ?? [],
        healthPath: rawHealthPath ?? "/health",
        stateful: rawStateful === true,
        sessionIdleTimeoutMs: sessionIdleMs,
        maxSessions: maxSessionsCap
      } as const;
      if (
        !Number.isSafeInteger(httpOpts.rateLimitPerMinute) ||
        httpOpts.rateLimitPerMinute < 0 ||
        !Number.isInteger(httpOpts.rateLimitPerMinute)
      ) {
        throw new Error(`--rate-limit must be a non-negative integer; got "${rawRateLimit}"`);
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
      try {
        const removed = await vault.clearDiskCache();
        if (removed) {
          process.stdout.write(`enquire: removed cache file ${vault.cacheFile}\n`);
        } else {
          process.stdout.write(`enquire: no cache file at ${vault.cacheFile}\n`);
        }
      } finally {
        await vault.closePersistence();
      }
    });

  program
    .command("clear-index")
    .description("Delete the FTS5 search-index files (.fts5.db + WAL/SHM/rollback-journal sidecars) for a given vault")
    .requiredOption("--vault <path>", "Vault whose index to delete")
    .option("--index-file <path>", INDEX_FILE_HELP)
    .action(async (opts: { vault: string; indexFile?: string }) => {
      const vault = new Vault(opts.vault);
      await vault.ensureExists();
      const indexFile = opts.indexFile ?? defaultIndexFile(vault.root);
      // SAFE BY DESIGN (v3.6.4 K-1 invariant): `clearOnDisk()` only deletes
      // files. It never calls `.open()` → no `bootstrapSchema()` → no DROP
      // TABLE risk. Configuration discovery before open does not apply.
      const idx = new FtsIndex({ file: indexFile, vaultRoot: vault.root });
      const removed = await idx.clearOnDisk();
      if (removed) {
        process.stdout.write(`enquire: removed fts5 index files at ${indexFile}\n`);
      } else {
        process.stdout.write(`enquire: no fts5 index files at ${indexFile}\n`);
      }
    });

  // v3.10.0-rc.14 (bug-report Issue 4) — one-shot CLI search for smoke-tests /
  // CI / debugging without an MCP client. Reuses (and, without privacy flags,
  // refreshes) the per-vault FTS5 index, runs the SAME hybrid `searchHybrid`
  // the MCP `obsidian_search` tool uses, and prints the results. Privacy flags
  // filter this invocation's hits; they do not rewrite the shared default index.
  program
    .command("query")
    .description(
      "Run a one-shot hybrid search (BM25 + TF-IDF + embeddings, RRF-fused) from the CLI and print the results — for quick smoke-tests / CI / debugging without an MCP client. Reuses the persistent per-vault FTS5 index (same as `serve --persistent-index`). `--exclude-glob` / `--read-paths` filter this invocation's results; they do not rewrite that shared index. Pass a proven physically distinct `--index-file` to persist a dedicated privacy-filtered index."
    )
    .argument("<text>", "Search query")
    .requiredOption("--vault <path>", "Path to the Obsidian vault root")
    .option("--limit <n>", "Max results (default 10)", "10")
    .option("--index-file <path>", INDEX_FILE_HELP)
    .option("--exclude-glob <pattern...>", EXCLUDE_GLOB_HELP)
    .option("--read-paths <pattern...>", READ_PATHS_HELP)
    .option("--json", "Emit the full JSON response instead of the pretty list")
    .action(
      async (
        text: string,
        opts: {
          vault: string;
          limit?: string;
          indexFile?: string;
          excludeGlob?: string[];
          readPaths?: string[];
          json?: boolean;
        }
      ) => {
        // One-shot query is a read/runtime path, not an installation command.
        // Match serve/serve-http: a missing model cache fails closed instead of
        // turning an apparently local query into an implicit network download.
        setEmbeddingsOffline();
        const v = new Vault(opts.vault, { excludeGlobs: opts.excludeGlob, readPaths: opts.readPaths });
        await v.ensureExists();
        const limit = parsePositiveInt(opts.limit ?? "10", "--limit");
        const selectedIndexFile = opts.indexFile ?? defaultIndexFile(v.root);
        const ftsTarget = await resolvePersistentFtsReadTarget(opts, selectedIndexFile, v.root);
        const indexFile = ftsTarget.file;
        // Discover the full admitted configuration before constructing (v3.6.4
        // K-1: never DROP TABLE on a mismatch) — identical to `eval`.
        const discovered = await discoverFtsIndexConfig(indexFile, v.root);
        if (discovered.kind === "refused") {
          throw new Error("FTS index configuration could not be verified");
        }
        const honoredTokenize: TokenizeMode = discovered.kind === "owned" ? discovered.meta.tokenize_mode : "unicode61";
        const shouldSyncFts = ftsTarget.shouldSync;
        const openFts = shouldOpenPersistentFtsForReadPath(shouldSyncFts, discovered);
        let result: Awaited<ReturnType<typeof searchHybrid>>;
        if (openFts) {
          const ftsIndex = new FtsIndex({ file: indexFile, vaultRoot: v.root, tokenize: honoredTokenize });
          try {
            await ftsIndex.open(discovered);
            if (shouldSyncFts) {
              await syncFtsIndex(v, ftsIndex);
            }
            result = await searchHybrid(v, { query: text, limit }, { ftsIndex, embedFile: embedDbPath(v.root) });
          } finally {
            await ftsIndex.closeAndRelease();
          }
        } else {
          result = await searchHybrid(v, { query: text, limit }, { ftsIndex: null, embedFile: embedDbPath(v.root) });
        }
        if (opts.json) {
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
          return;
        }
        if (result.signal_errors?.embeddings) {
          process.stderr.write(`enquire query: embeddings unavailable — ${result.signal_errors.embeddings}\n`);
        }
        const signals = result.signals_used.length > 0 ? result.signals_used.join("+") : "none";
        process.stdout.write(`\n${result.matches.length} result(s) for "${text}"  (signals: ${signals})\n\n`);
        for (const m of result.matches) {
          const loc = m.line_start ? `:${m.line_start}` : "";
          const snippet = m.snippet.replace(/\s+/g, " ").trim().slice(0, 160);
          process.stdout.write(`  ${m.path}${loc}  [${m.kind}]\n    ${snippet}\n`);
        }
        process.stdout.write("\n");
      }
    );

  // v3.10.0-rc.14 (bug-report Issue 8) — GC the per-vault index clutter that
  // accumulates in the cache dir over time (one index set per vault path/config
  // hash). `clear-cache`/`clear-index` target the named vault's configured/default
  // paths; `prune` removes recognized artifacts under OTHER legacy hash stems and
  // keeps the one you name. The 12-hex stem is a routing hint, not collision-proof
  // vault identity. Dry-run by DEFAULT (destructive → opt in with --yes). It touches
  // only the strict reserved filename namespace (see `planCachePrune`); filename
  // recognition is not proof of which same-account process created an entry.
  program
    .command("prune")
    .description(
      "Delete recognized cache artifacts under hash stems OTHER than the named vault's legacy first-12-hex SHA-1 routing stem. The stem is not collision-proof vault identity. Dry-run by default; inspect it before passing --yes. Selection is limited to the reserved `<hash>.{json,fts5.db,embed.db,hnsw.bin,hnsw.meta.json,feedback.json}` namespace, immutable HNSW generation names, and strictly-shaped temp/WAL/SHM/rollback-journal sidecars; matching names are recognized, not creation-provenanced. A visible watcher startup interlock for any selected stem vetoes the whole plan and remains exact-vault clear-embeddings recovery only."
    )
    .requiredOption(
      "--vault <path>",
      "Vault whose legacy hash stem to KEEP (recognized artifacts under OTHER stems are removed)"
    )
    .option("--yes", "Actually delete (without this, prune only PREVIEWS what would be removed)")
    .action(async (opts: { vault: string; yes?: boolean }) => {
      const v = new Vault(opts.vault);
      await v.ensureExists();
      const keepFile = defaultIndexFile(v.root);
      const cacheDir = path.dirname(keepFile);
      const keepHash = path.basename(keepFile).split(".")[0] ?? "";
      if (opts.yes) {
        try {
          const { bytes, removable, removed } = await executeCachePrune(cacheDir, keepHash);
          if (removable.length === 0) {
            process.stdout.write(
              `enquire prune: cache already clean (kept ${keepHash}.*; 0 other artifacts in ${cacheDir})\n`
            );
            return;
          }
          const mb = (bytes / 1024 / 1024).toFixed(1);
          process.stdout.write(
            `enquire prune: removed ${removed} artifact(s) (~${mb} MB) from ${cacheDir}, kept ${keepHash}.*\n`
          );
          return;
        } catch (err) {
          if (!(typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT")) throw err;
          process.stdout.write(`enquire prune: no cache directory at ${cacheDir} — nothing to prune\n`);
          return;
        }
      }
      let preview: Awaited<ReturnType<typeof previewCachePrune>>;
      try {
        preview = await previewCachePrune(cacheDir, keepHash);
      } catch (err) {
        if (typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT") {
          process.stdout.write(`enquire prune: no cache directory at ${cacheDir} — nothing to prune\n`);
          return;
        }
        throw new Error("Unable to inspect the cache directory for prune", { cause: err });
      }
      const { bytes, removable } = preview;
      if (removable.length === 0) {
        process.stdout.write(
          `enquire prune: cache already clean (kept ${keepHash}.*; 0 other artifacts in ${cacheDir})\n`
        );
        return;
      }
      const mb = (bytes / 1024 / 1024).toFixed(1);
      const sample = `${removable.slice(0, 5).join(", ")}${removable.length > 5 ? ", …" : ""}`;
      process.stdout.write(
        `enquire prune (DRY RUN): would remove ${removable.length} artifact(s) (~${mb} MB) from ${cacheDir}, keeping ${keepHash}.*\n` +
          `  Re-run with --yes to delete. Sample: ${sample}\n`
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
    .option("--exclude-glob <pattern...>", EXCLUDE_GLOB_HELP)
    .option("--read-paths <pattern...>", READ_PATHS_HELP)
    .action(
      async (opts: {
        vault: string;
        indexFile?: string;
        tokenize?: string;
        includePdfs?: boolean;
        excludeGlob?: string[];
        readPaths?: string[];
      }) => {
        const requestedTokenize =
          opts.tokenize === undefined ? undefined : assertTokenizeMode(opts.tokenize, "--tokenize");
        const vault = new Vault(opts.vault, { excludeGlobs: opts.excludeGlob, readPaths: opts.readPaths });
        await vault.ensureExists();
        const indexFile = opts.indexFile ?? defaultIndexFile(vault.root);
        const discovered = await discoverFtsIndexConfig(indexFile, vault.root);
        if (discovered.kind === "refused") {
          throw new Error("FTS index configuration could not be verified");
        }
        // v3.6.4 K-1 closure: if user passed --tokenize, honor user's intent.
        // If not passed, honor an admitted existing configuration to avoid silently rebuilding (which
        // would destroy a `--tokenize trigram`-built index when user just
        // wanted to refresh content). To force a rebuild with different
        // tokenize, pass --tokenize explicitly.
        let tokenize: TokenizeMode;
        if (requestedTokenize !== undefined) {
          tokenize = requestedTokenize;
        } else {
          tokenize = discovered.kind === "owned" ? discovered.meta.tokenize_mode : "unicode61";
          if (discovered.kind === "owned" && discovered.meta.tokenize_mode === "trigram") {
            process.stderr.write(
              `enquire index: honoring existing tokenize_mode=trigram (pass --tokenize unicode61 to rebuild)\n`
            );
          }
        }
        const idx = new FtsIndex({ file: indexFile, vaultRoot: vault.root, tokenize });
        await idx.open(discovered);
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
          await idx.closeAndRelease();
        }
      }
    );

  // v2.0 alpha — ML embeddings subcommands.
  program
    .command("install-model")
    .description(
      `Explicitly download and smoke-test an embedding OR reranker model for offline runtime use (the default cross-encoder \`${DEFAULT_RERANKER_ALIAS}\` is ~${RERANKER_MODELS[DEFAULT_RERANKER_ALIAS]?.approxSizeMB}MB). Runtime commands fail closed on a cache miss instead of downloading. Models are cached by transformers.js inside its own package directory (run \`enquire-mcp doctor\` to see the exact resolved path) and are reused across vaults.`
    )
    .argument(
      "[alias]",
      `Embedding alias (${Object.keys(EMBEDDING_MODELS).join(" | ")}) or reranker alias (${Object.keys(RERANKER_MODELS).join(" | ")})`,
      DEFAULT_MODEL_ALIAS
    )
    .action(async (alias: string) => {
      // v3.10.0-rc.13 (bug-report Issue 3) — install-model now also pre-caches
      // cross-encoder rerankers. Runtime commands are offline-enforced, so this
      // explicit network-enabled path prevents a cache-miss fallback instead of
      // making the first query download weights. Reranker aliases live in a
      // separate catalog (RERANKER_MODELS); detect + route accordingly.
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
    .option("--embed-file <path>", EMBED_FILE_HELP)
    .option("--exclude-glob <pattern...>", EXCLUDE_GLOB_HELP)
    .option("--read-paths <pattern...>", READ_PATHS_HELP)
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
        await assertEmbeddingWriterGuardClear(embedFile, vault.root, "build-embeddings", opts.embedFile !== undefined);
        // v3.6.4 K-1 closure: discover the admitted embed-db configuration before constructing
        // EmbedDb. If user didn't explicitly pass --embedding-model /
        // --quantize-embeddings, honor the existing config to avoid silent
        // rebuild (which destroys the user's pre-built data). To force a
        // switch, pass the explicit flag.
        const explicitModel = command.getOptionValueSource("embeddingModel") === "cli";
        const explicitQuant = command.getOptionValueSource("quantizeEmbeddings") === "cli";
        const discovered = await discoverEmbedDbConfig(embedFile, vault.root);
        if (discovered.kind === "refused") {
          throw new Error("Embedding index configuration could not be verified");
        }
        const requestedModel = resolveModel(opts.embeddingModel);
        let model = requestedModel;
        const storedConfiguration =
          discovered.kind === "owned" && !(explicitModel && explicitQuant)
            ? resolveStoredEmbeddingConfiguration(discovered.meta)
            : null;
        if (!explicitModel && storedConfiguration) {
          const honored = storedConfiguration.model;
          if (honored.alias !== requestedModel.alias) {
            process.stderr.write(
              `enquire build-embeddings: honoring existing model_alias=${honored.alias} (pass --embedding-model to override)\n`
            );
            model = honored;
          }
        }
        const requestedQuant = parseQuantizationMode(opts.quantizeEmbeddings) ?? "f32";
        let quantization = requestedQuant;
        if (!explicitQuant && storedConfiguration && storedConfiguration.quantization !== requestedQuant) {
          quantization = storedConfiguration.quantization;
          process.stderr.write(
            `enquire build-embeddings: honoring existing quantization=${storedConfiguration.quantization} (pass --quantize-embeddings to override)\n`
          );
        }
        const lateChunkContext =
          opts.lateChunkContext !== undefined
            ? Math.max(0, parsePositiveInt(opts.lateChunkContext, "--late-chunk-context"))
            : 0;
        process.stderr.write(`enquire: loading embedder ${model.alias} (${model.hfId})...\n`);
        const embedder = await loadValidatedEmbedder(model);
        let report: Awaited<ReturnType<typeof syncEmbedDb>>;
        let pdfReport: Awaited<ReturnType<typeof syncPdfEmbedDb>> | undefined;
        if (embedConfigurationNeedsReplacement(discovered, model, quantization)) {
          const replacement = await replaceEmbeddingIndex({
            file: embedFile,
            vault,
            expectedDiscovery: discovered,
            model,
            quantization,
            embedder,
            includePdfs: opts.includePdfs,
            lateChunkContext
          });
          report = replacement.markdown;
          pdfReport = replacement.pdf;
        } else {
          const db = new EmbedDb({
            file: embedFile,
            vaultRoot: vault.root,
            modelAlias: model.alias,
            dim: model.dim,
            quantization
          });
          await db.open(discovered);
          try {
            report = await syncEmbedDb(vault, db, embedder, { lateChunkContext });
            if (opts.includePdfs) {
              pdfReport = await syncPdfEmbedDb(vault, db, embedder, { lateChunkContext });
            }
          } finally {
            await db.closeAndRelease();
          }
        }
        process.stdout.write(
          `enquire: embed db ${embedFile} (md) — added=${report.added} updated=${report.updated} deleted=${report.deleted} unchanged=${report.unchanged} total_chunks=${report.total_chunks}${lateChunkContext > 0 ? ` late-chunk-context=${lateChunkContext}` : ""}${quantization !== "f32" ? ` quantization=${quantization}` : ""}\n`
        );
        if (pdfReport) {
          process.stdout.write(
            `enquire: embed db ${embedFile} (pdf) — added=${pdfReport.added} updated=${pdfReport.updated} deleted=${pdfReport.deleted} unchanged=${pdfReport.unchanged} total_chunks=${pdfReport.total_chunks}\n`
          );
        }
      }
    );

  program
    .command("clear-embeddings")
    .description(
      "Delete the embedding index files (.embed.db + WAL/SHM/rollback-journal, HNSW sidecars, and any stranded watcher-startup interlock) for a given vault"
    )
    .requiredOption("--vault <path>", "Vault whose embedding index to delete")
    .option("--embed-file <path>", EMBED_FILE_HELP)
    .action(async (opts: { vault: string; embedFile?: string }) => {
      const vault = new Vault(opts.vault);
      await vault.ensureExists();
      const file = opts.embedFile ?? embedDbPath(vault.root);
      // SAFE BY DESIGN (v3.6.4 K-1 invariant): `clearOnDisk()` only deletes
      // files. It never calls `.open()` → no `bootstrapSchema()` → no DROP
      // TABLE risk. Dummy `modelAlias`/`dim` are never consulted because
      // we never construct the schema. Configuration discovery before open does not apply.
      const db = new EmbedDb({ file, vaultRoot: vault.root, modelAlias: "n/a", dim: 1 });
      const removed = await db.clearOnDisk();
      if (removed) {
        process.stdout.write(`enquire: removed embedding index files at ${file}\n`);
      } else {
        process.stdout.write(`enquire: no embedding index files at ${file}\n`);
      }
    });

  // v2.11.0 — diagnostic + onboarding. `doctor` preserves logical SQLite
  // schema/content and returns 0 if the selected tier is structurally ready.
  // `setup` runs the install + build sequence in order, idempotent.
  program
    .command("doctor")
    .description(
      "Run a logical-content-preserving health check for a capability tier: basic (live scan), hybrid (FTS5 + embeddings + reranker + HNSW), or hybrid-live (hybrid + PDFs/watch). Every tier verifies that no incomplete watcher startup interlock blocks serving. Index-health checks use in-memory SQLite snapshots; stranded-guard recovery guidance separately performs read-only full-class ownership admission, whose SQLite/VFS open may update recovery or WAL/SHM bookkeeping. Doctor does not issue schema/content writes. Structural/runtime READY does not certify index freshness or complete PDF coverage."
    )
    .requiredOption("--vault <path>", "Path to the Obsidian vault root")
    .option("--tier <tier>", CONFIG_TIER_HELP)
    .option("--index-file <path>", INDEX_FILE_HELP)
    .option("--embed-file <path>", EMBED_FILE_HELP)
    .option(
      "--exclude-glob <pattern...>",
      "Privacy denylist (same semantics as `serve`) — live vault content counts reflect the filter; this is not a retroactive index-membership or purge audit."
    )
    .option(
      "--read-paths <pattern...>",
      "Privacy allowlist (same semantics as `serve`) — live vault content counts reflect the filter; this is not a retroactive index-membership or purge audit."
    )
    .option("--json", "Emit machine-readable JSON instead of the colored banner")
    .action(
      async (opts: {
        vault: string;
        tier?: string;
        indexFile?: string;
        embedFile?: string;
        json?: boolean;
        excludeGlob?: string[];
        readPaths?: string[];
      }) => {
        const tier = opts.tier ?? "hybrid";
        if (!isConfigTier(tier)) {
          process.stderr.write(`enquire doctor: invalid --tier '${tier}'. Use ${CONFIG_TIERS.join(" | ")}.\n`);
          process.exit(1);
        }
        const { runDoctor, formatDoctorResult } = await import("./doctor.js");
        const result = await runDoctor({
          vault: opts.vault,
          tier,
          ...(opts.indexFile !== undefined ? { indexFile: opts.indexFile } : {}),
          ...(opts.embedFile !== undefined ? { embedFile: opts.embedFile } : {}),
          repairCommandPrefix: invocationPrefix,
          repairCommandPlatform: process.platform,
          ...(opts.excludeGlob ? { excludeGlobs: opts.excludeGlob } : {}),
          ...(opts.readPaths ? { readPaths: opts.readPaths } : {})
        });
        if (opts.json) {
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        } else {
          process.stdout.write(`${formatDoctorResult(result)}\n`);
        }
        if (!result.ready) process.exitCode = 1;
      }
    );

  program
    .command("configure")
    .description(
      "Generate the strongest verified install action plus the exact fallback MCP config for THIS vault. Non-destructive — it writes nothing. VS Code gets a native review URI, Claude Code/Codex get copy-and-run commands, and Marketplace/Registry-only targets are labeled copy-only. Pick a `--tier` (basic = live scan, no setup; hybrid = full retrieval, needs `setup`) and optionally a `--client`. Run this right after install to skip hand-assembling config."
    )
    .requiredOption("--vault <path>", "Path to the Obsidian vault root")
    .option("--client <name>", CONFIG_CLIENT_HELP)
    .option("--tier <tier>", CONFIG_TIER_HELP)
    .option("--name <name>", CONFIG_NAME_HELP, "obsidian")
    .option("--http", CONFIG_HTTP_HELP)
    .option("--exclude-glob <pattern...>", "Privacy denylist propagated to setup, doctor, and runtime.")
    .option("--read-paths <pattern...>", "Privacy allowlist propagated to setup, doctor, and runtime.")
    .action(
      async (opts: {
        vault: string;
        client?: string;
        tier?: string;
        name?: string;
        http?: boolean;
        excludeGlob?: string[];
        readPaths?: string[];
      }) => {
        const tier = opts.tier ?? "hybrid";
        if (!isConfigTier(tier)) {
          process.stderr.write(`enquire configure: invalid --tier '${opts.tier}'. Use ${CONFIG_TIERS.join(" | ")}.\n`);
          process.exit(1);
        }
        if (opts.client && !CONFIG_CLIENTS.includes(opts.client as ConfigClient)) {
          process.stderr.write(
            `enquire configure: invalid --client '${opts.client}'. Use one of: ${CONFIG_CLIENTS.join(", ")} (or omit for all).\n`
          );
          process.exit(1);
        }
        if (opts.http && opts.client && opts.client !== "http") {
          process.stderr.write(
            `enquire configure: --http is incompatible with --client ${opts.client}; use --client http or omit --client.\n`
          );
          process.exit(1);
        }
        const name = opts.name ?? "obsidian";
        if (!isValidServerName(name)) {
          process.stderr.write(
            "enquire configure: invalid --name. Use only letters, digits, dot, underscore, or hyphen.\n"
          );
          process.exit(1);
        }
        // Resolve and validate before emitting a config. A ready-looking snippet
        // for a missing/file vault would fail only after a client installs it.
        let configuredVault: Vault;
        try {
          configuredVault = await resolveConfiguredVault(opts.vault, {
            ...(opts.excludeGlob ? { excludeGlobs: opts.excludeGlob } : {}),
            ...(opts.readPaths ? { readPaths: opts.readPaths } : {})
          });
        } catch (error) {
          process.stderr.write(
            `enquire configure: invalid vault/privacy configuration: ${
              error instanceof Error ? error.message : String(error)
            }\n`
          );
          process.exit(1);
        }
        const input: ConfigInput = {
          vault: configuredVault.root,
          tier,
          name,
          http: opts.http ?? false,
          ...(opts.excludeGlob ? { excludeGlobs: opts.excludeGlob } : {}),
          ...(opts.readPaths ? { readPaths: opts.readPaths } : {}),
          packageSpec: exactPackageSpec,
          platform: process.platform,
          ...(invocation ? { invocation } : {})
        };
        const body =
          opts.client && opts.client !== "http" && input.http
            ? renderClientConfig("http", input)
            : opts.client
              ? renderClientConfig(opts.client as ConfigClient, input)
              : input.http
                ? renderClientConfig("http", input)
                : renderAllClients(input);
        process.stdout.write(`# enquire-mcp configure — ${input.name} → ${input.vault} (${tier})\n\n`);
        process.stdout.write(`${body}\n\n`);
        process.stdout.write(`---\n${preflightHint(input)}\n`);
      }
    );

  program
    .command("first-run")
    .description(
      "Preview or apply one package-coherent onboarding flow: validate the vault and print its client config, then (with explicit --apply) prepare the selected tier and verify it with doctor. Preview is the default and never builds indexes or downloads models."
    )
    .requiredOption("--vault <path>", "Path to the Obsidian vault root")
    .option("--client <name>", CONFIG_CLIENT_HELP)
    .option("--tier <tier>", CONFIG_TIER_HELP)
    .option("--name <name>", CONFIG_NAME_HELP, "obsidian")
    .option("--http", CONFIG_HTTP_HELP)
    .option(
      "--embedding-model <alias>",
      `Explicit embedding alias for setup (otherwise setup honors an existing index or defaults to ${DEFAULT_MODEL_ALIAS})`
    )
    .option("--quantize-embeddings <mode>", QUANTIZE_EMBEDDINGS_HELP)
    .option(
      "--exclude-glob <pattern...>",
      "Privacy denylist preserved across generated config, setup, readiness verification, and runtime."
    )
    .option(
      "--read-paths <pattern...>",
      "Privacy allowlist preserved across generated config, setup, readiness verification, and runtime."
    )
    .option(
      "--apply",
      "Explicitly authorize local index/model-cache preparation and run the full flow. Without this flag, only non-destructive configure runs."
    )
    .action(
      async (opts: {
        vault: string;
        client?: string;
        tier?: string;
        name?: string;
        http?: boolean;
        embeddingModel?: string;
        quantizeEmbeddings?: string;
        excludeGlob?: string[];
        readPaths?: string[];
        apply?: boolean;
      }) => {
        const tier = opts.tier ?? "hybrid";
        if (!isConfigTier(tier)) {
          process.stderr.write(`enquire first-run: invalid --tier '${tier}'. Use ${CONFIG_TIERS.join(" | ")}.\n`);
          process.exitCode = 1;
          return;
        }
        let client: ConfigClient | undefined;
        if (opts.client) {
          if (!CONFIG_CLIENTS.includes(opts.client as ConfigClient)) {
            process.stderr.write(
              `enquire first-run: invalid --client '${opts.client}'. Use one of: ${CONFIG_CLIENTS.join(", ")} (or omit for all).\n`
            );
            process.exitCode = 1;
            return;
          }
          client = opts.client as ConfigClient;
        }
        if (opts.http && client && client !== "http") {
          process.stderr.write(
            `enquire first-run: --http is incompatible with --client ${client}; use --client http or omit --client.\n`
          );
          process.exitCode = 1;
          return;
        }
        const name = opts.name ?? "obsidian";
        if (!isValidServerName(name)) {
          process.stderr.write(
            "enquire first-run: invalid --name. Use only letters, digits, dot, underscore, or hyphen.\n"
          );
          process.exitCode = 1;
          return;
        }
        try {
          if (opts.embeddingModel) resolveModel(opts.embeddingModel);
          if (opts.quantizeEmbeddings !== undefined) parseQuantizationMode(opts.quantizeEmbeddings);
        } catch (error) {
          process.stderr.write(
            `enquire first-run: invalid setup option: ${error instanceof Error ? error.message : String(error)}\n`
          );
          process.exitCode = 1;
          return;
        }
        if (tier === "basic" && (opts.embeddingModel || opts.quantizeEmbeddings !== undefined)) {
          process.stderr.write(
            "enquire first-run: --embedding-model and --quantize-embeddings apply only to hybrid tiers.\n"
          );
          process.exitCode = 1;
          return;
        }

        let firstRunVault: Vault;
        try {
          firstRunVault = await resolveConfiguredVault(opts.vault, {
            ...(opts.excludeGlob ? { excludeGlobs: opts.excludeGlob } : {}),
            ...(opts.readPaths ? { readPaths: opts.readPaths } : {})
          });
        } catch (error) {
          process.stderr.write(
            `enquire first-run: invalid vault/privacy configuration: ${
              error instanceof Error ? error.message : String(error)
            }\n`
          );
          process.exitCode = 1;
          return;
        }

        const plan = buildFirstRunPlan({
          // Pin the real vault path before spawning any child step. Reusing a
          // caller-supplied symlink here would allow it to be retargeted
          // between configure and setup, splitting one approved plan across
          // two physical vaults.
          vault: firstRunVault.root,
          tier,
          ...(client ? { client } : {}),
          name,
          http: opts.http ?? false,
          ...(opts.excludeGlob ? { excludeGlobs: opts.excludeGlob } : {}),
          ...(opts.readPaths ? { readPaths: opts.readPaths } : {}),
          ...(opts.embeddingModel ? { embeddingModel: opts.embeddingModel } : {}),
          ...(opts.quantizeEmbeddings ? { quantizeEmbeddings: opts.quantizeEmbeddings } : {}),
          invocation: invocation ?? {
            command: process.platform === "win32" ? "npx.cmd" : "npx",
            argsPrefix: ["-y", exactPackageSpec]
          }
        });
        const apply = opts.apply ?? false;
        process.stdout.write(`# enquire-mcp first-run — ${apply ? "apply" : "preview"} (${tier})\n`);
        if (!apply) {
          process.stdout.write(
            "Preview mode runs only non-destructive configure. Index/model-cache preparation and doctor remain planned until --apply.\n"
          );
        }

        const runner = (step: FirstRunStep) =>
          new Promise<number>((resolve, reject) => {
            const child = spawn(step.command, step.args, { stdio: "inherit" });
            child.once("error", reject);
            child.once("close", (code, signal) => {
              if (signal) {
                process.stderr.write(`enquire first-run: ${step.id} terminated by ${signal}\n`);
                resolve(signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1);
                return;
              }
              resolve(code ?? 1);
            });
          });
        const result = await executeFirstRunPlan(plan, apply, runner, (step, index, total) => {
          process.stdout.write(`\n>> Step ${index + 1}/${total}: ${step.label}\n`);
          process.stdout.write(`   ${renderFirstRunStep(step, process.platform)}\n\n`);
        });

        if (!result.ok) {
          const detail = result.error ? ` (${result.error})` : "";
          const resumeCommand = apply ? plan.applyCommand : plan.previewCommand;
          process.stderr.write(
            `\n✗ first-run stopped at ${result.failedStep.id}; exit ${result.exitCode}${detail}.\n` +
              "Completed steps are idempotent. After fixing the reported cause, resume safely with:\n" +
              `   ${renderFirstRunStep(resumeCommand, process.platform)}\n`
          );
          process.exitCode = result.exitCode || 1;
          return;
        }

        if (!apply) {
          process.stdout.write("\nPlanned after explicit --apply:\n");
          for (const [index, step] of plan.steps.entries()) {
            if (!step.requiresApply) continue;
            const effect = step.mutatesLocalState ? "creates/updates local state" : "read-only verification";
            process.stdout.write(
              `  ${index + 1}. ${step.label} [${effect}]\n     ${renderFirstRunStep(step, process.platform)}\n`
            );
          }
          process.stdout.write(
            "\nPreview complete: first-run requested no index or model-cache writes.\n" +
              "Apply this exact, resumable plan with:\n" +
              `   ${renderFirstRunStep(plan.applyCommand, process.platform)}\n`
          );
          return;
        }

        process.stdout.write("\n✓ first-run complete. The generated client configuration now targets a READY tier.\n");
      }
    );

  program
    .command("setup")
    .description(
      "Prepare the embedder and core indexes: run embedding-model install + FTS5 index + build-embeddings in sequence. Idempotent. The exact hybrid tier additionally requires `install-model rerank-bge`; setup prints the tier-matched preflight and doctor commands when it finishes."
    )
    .requiredOption("--vault <path>", "Path to the Obsidian vault root")
    .option("--embedding-model <alias>", `Model alias (default: ${DEFAULT_MODEL_ALIAS})`, DEFAULT_MODEL_ALIAS)
    .option(
      "--include-pdfs",
      "Also index PDFs (FTS5 + embeddings). Off by default; opt-in because PDF extraction is slower."
    )
    .option("--skip-embeddings", "Skip the install-model + build-embeddings steps (only build FTS5)")
    .option("--quantize-embeddings <mode>", QUANTIZE_EMBEDDINGS_HELP)
    .option("--exclude-glob <pattern...>", EXCLUDE_GLOB_HELP)
    .option("--read-paths <pattern...>", READ_PATHS_HELP)
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
        const embedFile = embedDbPath(v.root);
        await assertEmbeddingWriterGuardClear(embedFile, v.root, "setup");
        const indexFile = defaultIndexFile(v.root);
        // v3.6.4 K-1 closure (setup is idempotent per its description):
        // honor existing tokenize_mode so re-running `setup` on a vault
        // built with `--tokenize trigram` doesn't silently downgrade to
        // unicode61. The setup command has no `--tokenize` flag, so the
        // user's only way to "switch" is to clear-index first.
        const discoveredFts = await discoverFtsIndexConfig(indexFile, v.root);
        if (discoveredFts.kind === "refused") {
          throw new Error("FTS index configuration could not be verified");
        }
        // When this invocation will write embeddings, resolve the complete
        // expected-root configuration before emitting progress or opening FTS.
        // `--skip-embeddings` is not an embedding writer and deliberately avoids
        // adopting an unrelated EmbedDb configuration decision.
        const explicitEmbedModel = command.getOptionValueSource("embeddingModel") === "cli";
        const explicitQuant = command.getOptionValueSource("quantizeEmbeddings") === "cli";
        const discoveredEmbed = opts.skipEmbeddings ? null : await discoverEmbedDbConfig(embedFile, v.root);
        if (discoveredEmbed?.kind === "refused") {
          throw new Error("Embedding index configuration could not be verified");
        }
        const storedConfiguration =
          discoveredEmbed?.kind === "owned" && !(explicitEmbedModel && explicitQuant)
            ? resolveStoredEmbeddingConfiguration(discoveredEmbed.meta)
            : null;
        process.stdout.write(`enquire setup — ${opts.vault}\n\n`);

        // Step 1: FTS5 index.
        process.stdout.write(">> Step 1/3: Cold-build FTS5 index\n");
        const setupTokenize: TokenizeMode =
          discoveredFts.kind === "owned" ? discoveredFts.meta.tokenize_mode : "unicode61";
        if (discoveredFts.kind === "owned" && discoveredFts.meta.tokenize_mode === "trigram") {
          process.stdout.write(`   (honoring existing tokenize_mode=trigram — run clear-index then setup to reset)\n`);
        }
        const idx = new FtsIndex({ file: indexFile, vaultRoot: v.root, tokenize: setupTokenize });
        await idx.open(discoveredFts);
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
          await idx.closeAndRelease();
        }

        const quotedVault = shellQuote(v.root, process.platform);
        const privacyArgs = buildPrivacyArgs({
          ...(opts.excludeGlob ? { excludeGlobs: opts.excludeGlob } : {}),
          ...(opts.readPaths ? { readPaths: opts.readPaths } : {})
        })
          .map((arg) => shellQuote(arg, process.platform))
          .join(" ");
        const privacySuffix = privacyArgs ? ` ${privacyArgs}` : "";

        if (opts.skipEmbeddings) {
          process.stdout.write("\n>> Step 2-3 skipped (--skip-embeddings)\n");
          const modelSuffix =
            command.getOptionValueSource("embeddingModel") === "cli"
              ? ` --embedding-model ${shellQuote(opts.embeddingModel ?? DEFAULT_MODEL_ALIAS, process.platform)}`
              : "";
          const quantizationSuffix =
            command.getOptionValueSource("quantizeEmbeddings") === "cli"
              ? ` --quantize-embeddings ${shellQuote(opts.quantizeEmbeddings ?? "f32", process.platform)}`
              : "";
          const pdfSuffix = opts.includePdfs ? " --include-pdfs" : "";
          process.stdout.write(
            "\nSetup partial. Continue without dropping the vault privacy policy:\n" +
              `   ${invocationPrefix} setup --vault ${quotedVault}${modelSuffix}${quantizationSuffix}${pdfSuffix}${privacySuffix}\n`
          );
          return;
        }
        if (discoveredEmbed === null) {
          throw new Error("Embedding index configuration could not be verified");
        }

        // v3.6.4 K-1 closure: discover the admitted embed-db configuration BEFORE loading the
        // embedder so step 2 loads the right model. setup is idempotent
        // per its description — re-running on a vault built with
        // `--embedding-model bge` must NOT silently rebuild as
        // multilingual. Honor existing model unless user passed
        // --embedding-model explicitly on the CLI.
        const requestedModel = resolveModel(opts.embeddingModel);
        let setupModel = requestedModel;
        if (!explicitEmbedModel && storedConfiguration) {
          setupModel = storedConfiguration.model;
          if (setupModel.alias !== requestedModel.alias) {
            process.stdout.write(
              `   (note: existing embed-db built with ${setupModel.alias}; honoring it — pass --embedding-model to override)\n`
            );
          }
        }
        const requestedQuant = parseQuantizationMode(opts.quantizeEmbeddings) ?? "f32";
        let quantization = requestedQuant;
        if (!explicitQuant && storedConfiguration && storedConfiguration.quantization !== requestedQuant) {
          quantization = storedConfiguration.quantization;
          process.stdout.write(
            `   (note: existing embed-db built with quantization=${storedConfiguration.quantization}; honoring it — pass --quantize-embeddings to override)\n`
          );
        }

        // Step 2: Install-model (load the resolved/honored model).
        process.stdout.write("\n>> Step 2/3: Install embedding model\n");
        const t0 = Date.now();
        const embedder = await loadValidatedEmbedder(setupModel);
        process.stdout.write(
          `   model ${setupModel.alias} ready (${setupModel.dim}-dim, ${Date.now() - t0}ms warmup, cached under ${resolveTransformersCacheDir() ?? "the transformers.js model cache"})\n`
        );

        // Step 3: build-embeddings.
        process.stdout.write("\n>> Step 3/3: Build embedding index\n");
        let embReport: Awaited<ReturnType<typeof syncEmbedDb>>;
        let pdfReport: Awaited<ReturnType<typeof syncPdfEmbedDb>> | undefined;
        if (embedConfigurationNeedsReplacement(discoveredEmbed, setupModel, quantization)) {
          const replacement = await replaceEmbeddingIndex({
            file: embedFile,
            vault: v,
            expectedDiscovery: discoveredEmbed,
            model: setupModel,
            quantization,
            embedder,
            includePdfs: opts.includePdfs
          });
          embReport = replacement.markdown;
          pdfReport = replacement.pdf;
        } else {
          const db = new EmbedDb({
            file: embedFile,
            vaultRoot: v.root,
            modelAlias: setupModel.alias,
            dim: setupModel.dim,
            quantization
          });
          await db.open(discoveredEmbed);
          try {
            embReport = await syncEmbedDb(v, db, embedder);
            if (opts.includePdfs) {
              pdfReport = await syncPdfEmbedDb(v, db, embedder);
            }
          } finally {
            await db.closeAndRelease();
          }
        }
        process.stdout.write(
          `   embed-db (md): added=${embReport.added} updated=${embReport.updated} unchanged=${embReport.unchanged} chunks=${embReport.total_chunks}${quantization !== "f32" ? ` quantization=${quantization}` : ""}\n`
        );
        if (pdfReport) {
          process.stdout.write(
            `   embed-db (pdf): added=${pdfReport.added} updated=${pdfReport.updated} unchanged=${pdfReport.unchanged} chunks=${pdfReport.total_chunks}\n`
          );
        }

        const doctorTier = opts.includePdfs ? "hybrid-live" : "hybrid";
        // Keep follow-up commands on the exact package copy that performed
        // setup. Model caches are package-local, so a bare global command or a
        // fresh npx resolution could validate/start a different cache root.
        const shellLabel = process.platform === "win32" ? " (PowerShell)" : "";
        process.stdout.write(`\n✓ Embedder + indexes ready. Complete the exact tier preflight${shellLabel}:\n`);
        process.stdout.write(
          `   ${invocationPrefix} install-model ${DEFAULT_RERANKER_ALIAS}\n` +
            `   ${invocationPrefix} doctor --tier ${doctorTier} --vault ${quotedVault}${privacySuffix}\n`
        );
        process.stdout.write("Then run:\n");
        process.stdout.write(
          `   ${invocationPrefix} serve --vault ${quotedVault} --persistent-index --enable-reranker --use-hnsw`
        );
        if (opts.includePdfs) process.stdout.write(" --include-pdfs --watch");
        if (quantization !== "f32") process.stdout.write(` --quantize-embeddings ${quantization}`);
        process.stdout.write(privacySuffix);
        process.stdout.write("\n");
      }
    );

  // v2.12.0 — retrieval-quality evaluation harness. Reads a JSONL file of
  // queries with known-relevant doc paths, runs obsidian_search for each,
  // computes NDCG@K + Recall@K + MRR. Pretty table by default, --json for
  // machine output, --matrix to A/B several flag combinations.
  program
    .command("eval")
    .description(
      "Built-in per-vault retrieval-quality harness. Reads a JSONL file of queries with known-relevant doc paths, runs `obsidian_search` for each, computes NDCG@K + Recall@K + MRR + per-query latency. Pretty table output by default; `--json` for machine-readable output. `--matrix` runs all combinations of (graph_boost on/off × reranker on/off) side-by-side for systematic tuning."
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
    .option("--index-file <path>", INDEX_FILE_HELP)
    .option("--exclude-glob <pattern...>", EXCLUDE_GLOB_HELP)
    .option("--read-paths <pattern...>", READ_PATHS_HELP)
    .option("--per-query", "Print per-query scores in addition to aggregates (verbose)")
    .option("--json", "Emit machine-readable JSON instead of the pretty table")
    .option(
      "--output <file>",
      "Also write the full result JSON to this file (for `enquire-mcp eval-compare` A/B analysis). Includes by_category + per-query missed_paths/top_paths diagnostics."
    )
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
        indexFile?: string;
        excludeGlob?: string[];
        readPaths?: string[];
        perQuery?: boolean;
        json?: boolean;
        output?: string;
      }) => {
        // Eval is also a read/runtime path. Model acquisition stays explicit
        // via install-model/build-embeddings/setup.
        setEmbeddingsOffline();
        const { readQueriesJsonl, runEval, formatEvalResult, formatEvalMatrix } = await import("./eval.js");
        const k = parsePositiveInt(opts.k ?? "10", "--k");
        const queries = await readQueriesJsonl(opts.queries);
        if (queries.length === 0) {
          process.stderr.write(`enquire eval: ${opts.queries} contains no queries\n`);
          process.exit(1);
        }
        process.stderr.write(`enquire eval: loaded ${queries.length} queries from ${opts.queries}\n`);

        const v = new Vault(opts.vault, { excludeGlobs: opts.excludeGlob, readPaths: opts.readPaths });
        await v.ensureExists();

        // Optional FTS5 index.
        let ftsIndex: FtsIndex | null = null;
        if (opts.persistentIndex) {
          const selectedIndexFile = opts.indexFile ?? defaultIndexFile(v.root);
          const ftsTarget = await resolvePersistentFtsReadTarget(opts, selectedIndexFile, v.root);
          const indexFile = ftsTarget.file;
          // v3.6.4 K-1 closure (eval = diagnostic, MUST never destroy):
          // discover the admitted tokenize_mode before constructing. Without discovery,
          // an eval run against a `--tokenize trigram`-built index would
          // silently DROP TABLE because the default `unicode61` mismatches.
          // Same historical K-1 class; doctor now uses immutable byte snapshots.
          // B5: a privacy-filtered Vault must not sync deletions into the
          // shared default index; a proven physically distinct `--index-file` still syncs (M-8).
          const discovered = await discoverFtsIndexConfig(indexFile, v.root);
          if (discovered.kind === "refused") {
            throw new Error("FTS index configuration could not be verified");
          }
          const honoredTokenize: TokenizeMode =
            discovered.kind === "owned" ? discovered.meta.tokenize_mode : "unicode61";
          const shouldSyncFts = ftsTarget.shouldSync;
          if (shouldOpenPersistentFtsForReadPath(shouldSyncFts, discovered)) {
            ftsIndex = new FtsIndex({ file: indexFile, vaultRoot: v.root, tokenize: honoredTokenize });
            try {
              await ftsIndex.open(discovered);
              if (shouldSyncFts) {
                await syncFtsIndex(v, ftsIndex);
              }
            } catch (err) {
              await ftsIndex.closeAndRelease();
              throw err;
            }
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
            if (opts.output) {
              await fs.writeFile(opts.output, `${JSON.stringify(results, null, 2)}\n`);
              process.stderr.write(`enquire eval: wrote ${results.length} results to ${opts.output}\n`);
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
            if (opts.output) {
              await fs.writeFile(opts.output, `${JSON.stringify(result, null, 2)}\n`);
              process.stderr.write(`enquire eval: wrote result to ${opts.output}\n`);
            }
            if (opts.json) {
              process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
            } else {
              process.stdout.write(`${formatEvalResult(result, { perQuery: opts.perQuery ?? false })}\n`);
            }
          }
        } finally {
          if (ftsIndex) await ftsIndex.closeAndRelease();
        }
      }
    );

  program
    .command("eval-compare")
    .description(
      "Compare two eval JSON outputs from the same query cohort. Returns nonzero for errored, malformed, or mismatched inputs and for a metric regression at the material-effect threshold."
    )
    .argument("<baseline>", "Baseline JSON file written by `enquire-mcp eval --output`")
    .argument("<after>", "After JSON file written by `enquire-mcp eval --output`")
    .option("--json", "Emit the comparison as machine-readable JSON")
    .action(async (baselineFile: string, afterFile: string, opts: { json?: boolean }) => {
      const { compareEvalResults, formatEvalComparison } = await import("./eval.js");
      const readResult = async (file: string) => {
        const raw = await fs.readFile(path.resolve(file), "utf8");
        const parsed = JSON.parse(raw) as import("./eval.js").EvalResult | import("./eval.js").EvalResult[];
        const result = Array.isArray(parsed) ? parsed[0] : parsed;
        if (!result || typeof result !== "object") {
          throw new Error(`${file} does not contain an eval result`);
        }
        return result;
      };
      const comparison = compareEvalResults(await readResult(baselineFile), await readResult(afterFile));
      process.stdout.write(
        opts.json ? `${JSON.stringify(comparison, null, 2)}\n` : `${formatEvalComparison(comparison)}\n`
      );
      if (comparison.deltas.some((delta) => delta.meaningful && delta.delta < 0)) {
        process.exitCode = 1;
      }
    });

  await program.parseAsync(process.argv);
}
