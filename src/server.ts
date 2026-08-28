import { existsSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import {
  assertEmbedDbRecoveryOwnership,
  discoverEmbedDbConfig,
  EmbedDb,
  type HnswPersistenceReceipt,
  type HnswPersistenceRow,
  hnswPersistBase,
  sameHnswPersistenceReceipt
} from "./embed-db.js";
import { syncEmbedDb, syncPdfEmbedDb } from "./embed-sync.js";
import { resolveModel, resolveStoredEmbeddingConfiguration, setEmbeddingsOffline } from "./embeddings.js";
import { defaultFeedbackFile, FeedbackStore } from "./feedback.js";
import {
  assertTokenizeMode,
  defaultIndexFile,
  discoverFtsIndexConfig,
  FtsIndex,
  syncFtsIndex,
  syncPdfFtsIndex,
  type TokenizeMode
} from "./fts5.js";
import { VERSION } from "./index.js";
import { buildInitializeInstructions, resolveInitializeToolProfile } from "./initialize-instructions.js";
import { createToolRegistrationAdapter } from "./mcp-registration.js";
import type { PersistenceFamilyLeaseHandle } from "./persistence-coordination.js";
import { registerPrompts } from "./prompts.js";
import { parseFeedbackConfig, parseRecencyConfig } from "./retrieval-opts.js";
import {
  createPreparedServerCleanupOwner,
  PreparedServerCleanupError,
  retryIncompleteShutdownOnce,
  shutdownStdioDeps
} from "./shutdown.js";
import {
  embedDbPath,
  parsePositiveInt,
  registerChunkResource,
  registerFeedbackTool,
  registerFtsTools,
  registerReadTools,
  registerResources,
  registerWriteTools
} from "./tool-registry.js";
import { Vault } from "./vault.js";
import { VaultWatcher } from "./watcher.js";
import {
  armWatcherActivationGuard,
  assertWatcherActivationGuardClear,
  releaseWatcherActivationGuard,
  type WatcherActivationGuard
} from "./watcher-activation-guard.js";
import { WriteRequestTracker } from "./write-lifecycle.js";

export { syncFtsIndex, syncPdfFtsIndex } from "./fts5.js";
// v3.12.0-rc.20 — bulk embedding sync moved to a testable leaf module.
// Re-export the historical server.js paths so CLI/scripts keep working.
export { syncEmbedDb, syncPdfEmbedDb };

/**
 * Configuration for {@link startServer} / {@link prepareServerDeps}.
 * Mirrors the CLI flag surface (`enquire-mcp serve --vault X --enable-write`)
 * but typed as a plain options object so HTTP transport / tests can call
 * the same entry points programmatically.
 *
 * Strings on numeric fields (e.g. `maxFileBytes`, `cacheSize`) reflect the
 * fact that callers usually pass CLI args verbatim — parsing happens
 * inside `prepareServerDeps` via {@link parsePositiveInt}.
 */
export interface ServeOptions {
  /** Absolute path to the vault root directory. Required. */
  vault: string;
  /** Allow the gated write tools (`obsidian_create_note`,
   *  `obsidian_append_to_note`, `obsidian_rename_note`, `obsidian_archive_note`,
   *  …). Default false (read-only). */
  enableWrite?: boolean;
  /** Per-file size cap (parsed via {@link parsePositiveInt}). */
  maxFileBytes?: string;
  /** In-memory parsed-note cache capacity. */
  cacheSize?: string;
  /** Persist the parse cache across server restarts. */
  persistentCache?: boolean;
  /**
   * Override the persistent cache file location. Must end exactly in the
   * case-sensitive `.json` suffix and must not occupy the reserved
   * `.feedback.json` or `.hnsw.meta.json` subclasses.
   */
  cacheFile?: string;
  /** Enable the persistent FTS5 index (requires `better-sqlite3`). */
  persistentIndex?: boolean;
  /** Override the FTS5 index file location; must end exactly in case-sensitive `.fts5.db`. */
  indexFile?: string;
  /** FTS5 tokenizer mode. */
  tokenize?: "unicode61" | "trigram";
  /** Privacy: glob patterns to exclude from the vault. */
  excludeGlob?: string[];
  /** Privacy: glob patterns that form a strict allowlist. */
  readPaths?: string[];
  /** Enable the filesystem watcher (auto-reindex on change). */
  watch?: boolean;
  /** Per-tool gating: deny list. Tools named here won't register. */
  disabledTools?: string[];
  /** Per-tool gating: allow list. Only listed tools register (deny still applies). */
  enabledTools?: string[];
  /** Expose diagnostic / debug tools (`obsidian_full_text_search` etc.). */
  diagnosticSearchTools?: boolean;
  /** Register the 19 MCP prompts. Default true; `--no-prompts` sets false. */
  prompts?: boolean;
  /**
   * Discover and use the per-vault persistent embedding index. Default true;
   * `--no-embedding-index` freezes the capability to null and also skips the
   * embedding watcher's durable startup guard.
   */
  embeddingIndex?: boolean;
  /** v2.8.0 — also index PDFs into FTS5 (and embeddings, if a build-embeddings
   *  with --include-pdfs ran). Off by default; opt-in because PDF extraction
   *  is slower than markdown. */
  includePdfs?: boolean;
  /** v3.9.0-rc.1 — also run Tesseract OCR on image-only / scanned PDFs that
   *  pdfjs can't read text from, so the watcher's embed-db sync keeps
   *  OCR'd PDFs in sync with edits during a long serve session. Requires
   *  `--watch` + `--include-pdfs` + the `tesseract.js` / `@napi-rs/canvas`
   *  optional dependencies. Off by default — OCR is slow (~1-2s per page
   *  on M1 CPU; bounded by `--ocr-max-pages`, default 200). */
  ocrPdfs?: boolean;
  /** v3.9.0-rc.1 — Tesseract language pack for OCR-on-watch. Default `"eng"`.
   *  Multi-lang via `+`, e.g. `"eng+rus"`. Languages must be pre-installed
   *  via `enquire-mcp install-ocr-lang <code>` (no runtime download). */
  ocrLangs?: string;
  /** v3.9.0-rc.1 — page cap for OCR-on-watch runs. Default 200 (matches
   *  `DEFAULT_OCR_MAX_PAGES`). Exceeding the cap attempts to quarantine the
   *  changed PDF generation and preserves its prior FTS/embed/HNSW rows. */
  ocrMaxPages?: string;
  /** v2.9.0 — enable BGE cross-encoder reranking on top of RRF in
   *  obsidian_search. Off by default; adds ~30-50ms per query at top-50. */
  enableReranker?: boolean;
  /** v2.9.0 — reranker model alias (default "rerank-bge", English-only). */
  rerankerModel?: string;
  /** v2.9.0 — how many top fused candidates to rerank (default 50). */
  rerankerTopN?: string;
  /** v2.13.0 — build an in-memory HNSW approximate nearest-neighbor index
   *  on serve start instead of the O(n) brute-force dense path. Off by
   *  default; latency and recall depend on corpus, hardware, and parameters. */
  useHnsw?: boolean;
  /** v2.13.0 — HNSW search-time beam width (default 100; ≥k). */
  hnswEf?: string;
  /** v3.10.0-rc.5 — opt-in recency re-ranking weight in [0,1] for obsidian_search.
   *  Default 0 (OFF — ranking stays purely relevance-driven). When > 0, the fused
   *  order is re-sorted by `(1-w)*relevanceRank + w*recency`. */
  recencyWeight?: string;
  /** v3.10.0-rc.5 — recency half-life in days for --recency-weight (age at which
   *  recency score = 0.5). Default 365. Tunes recency RE-RANKING only; the `stale`
   *  flag on hits always uses the fixed 365-day default (rc.40 #9 — was mis-claimed
   *  as this flag's threshold). */
  staleDays?: string;
  /** v3.11.0 — opt-in closed-loop feedback weight in [0,1]. Default 0 (OFF —
   *  no `obsidian_mark_useful` tool, no rank boost; ranking stays relevance-pure).
   *  When > 0, registers `obsidian_mark_useful` and blends each note's recorded
   *  usefulness (`useful/(useful+notUseful+1)`) into the `obsidian_search` order:
   *  `(1-w)*relevanceRank + w*feedbackScore`. State persists in a per-vault cache
   *  sidecar (`<hash>.feedback.json`; canonical absolute vault root + relative
   *  path keys + counts + ISO timestamps; no note content/query text). */
  feedbackWeight?: string;
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
   *  Mode is per-database. Explicit writer configuration changes may rebuild
   *  an exact-owned index; serve discovers and honors an admitted stored mode
   *  rather than switching it. */
  quantizeEmbeddings?: "f32" | "int8";
}

const SERVE_BOOLEAN_OPTIONS = [
  "enableWrite",
  "persistentCache",
  "persistentIndex",
  "watch",
  "diagnosticSearchTools",
  "prompts",
  "embeddingIndex",
  "includePdfs",
  "ocrPdfs",
  "enableReranker",
  "useHnsw",
  "hnswPersist"
] as const;

const SERVE_STRING_OPTIONS = [
  "maxFileBytes",
  "cacheSize",
  "cacheFile",
  "indexFile",
  "ocrLangs",
  "ocrMaxPages",
  "rerankerModel",
  "rerankerTopN",
  "hnswEf",
  "recencyWeight",
  "staleDays",
  "feedbackWeight",
  "lateChunkContext"
] as const;

// HttpServeOptions structurally extends ServeOptions and is intentionally
// forwarded through prepareServerDeps. Keep its transport-only fields in this
// closed-world superset; http-transport.ts owns their value/domain checks.
const SERVE_RUNTIME_OPTION_NAMES = new Set<string>([
  "vault",
  ...SERVE_BOOLEAN_OPTIONS,
  ...SERVE_STRING_OPTIONS,
  "tokenize",
  "excludeGlob",
  "readPaths",
  "disabledTools",
  "enabledTools",
  "quantizeEmbeddings",
  "port",
  "host",
  "bearerToken",
  "mcpPath",
  "rateLimitPerMinute",
  "corsOrigins",
  "healthPath",
  "stateful",
  "sessionIdleTimeoutMs",
  "maxSessions",
  "installSignalHandlers"
]);

function assertServeOptionsRuntime(value: unknown): asserts value is ServeOptions {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Serve options must be an object");
  }
  const opts = value as Record<string, unknown>;
  const unknownOptionName = Object.keys(opts).find((name) => !SERVE_RUNTIME_OPTION_NAMES.has(name));
  if (unknownOptionName !== undefined) {
    throw new TypeError(`Unknown serve option ${unknownOptionName}`);
  }
  if (typeof opts.vault !== "string" || opts.vault.trim().length === 0) {
    throw new TypeError("Serve option vault must be a non-empty path string");
  }
  for (const name of SERVE_BOOLEAN_OPTIONS) {
    const option = opts[name];
    if (option !== undefined && typeof option !== "boolean") {
      throw new TypeError(`Serve option ${name} must be a boolean`);
    }
  }
  for (const name of SERVE_STRING_OPTIONS) {
    const option = opts[name];
    if (option !== undefined && typeof option !== "string") {
      throw new TypeError(`Serve option ${name} must be a string`);
    }
  }
  for (const name of ["excludeGlob", "readPaths", "disabledTools", "enabledTools"] as const) {
    const option = opts[name];
    if (option !== undefined && (!Array.isArray(option) || !option.every((entry) => typeof entry === "string"))) {
      throw new TypeError(`Serve option ${name} must be an array of strings`);
    }
  }
  if (Array.isArray(opts.readPaths) && opts.readPaths.length === 0) {
    throw new TypeError("Serve option readPaths must not be an empty allowlist");
  }
  for (const name of ["disabledTools", "enabledTools"] as const) {
    const option = opts[name];
    if (
      Array.isArray(option) &&
      option.some((entry) => {
        const toolName = entry as string;
        return toolName.trim().length === 0 || toolName !== toolName.trim();
      })
    ) {
      throw new TypeError(`Serve option ${name} must contain canonical tool names without outer whitespace`);
    }
  }
  if (opts.tokenize !== undefined) assertTokenizeMode(opts.tokenize, "tokenize option");
  if (
    opts.quantizeEmbeddings !== undefined &&
    opts.quantizeEmbeddings !== "f32" &&
    opts.quantizeEmbeddings !== "int8"
  ) {
    throw new TypeError('Serve option quantizeEmbeddings must be "f32" or "int8"');
  }
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
  /**
   * v3.8.0-rc.2 R-7 — embed-db handle owned by the watcher for runtime
   * incremental sync. Opened in `prepareServerDeps` when `--watch` is
   * on AND the embed-db file exists, separate from the HNSW init path
   * (which opens its own short-lived handle for the rebuild scan).
   * SQLite WAL mode allows concurrent opens to the same file; the two
   * handles see consistent state via MVCC. Closed by the shutdown
   * handler in {@link startServer}.
   */
  watcherEmbedDb: EmbedDb | null;
  /**
   * Embedding capability frozen for this prepared server generation.
   *
   * With `--watch`, `null` means no EmbedDb existed at preparation time, so
   * search remains lexical until restart even if another process builds a DB
   * later. `undefined` preserves historical dynamic discovery for non-watcher
   * and backward-compatible caller-constructed dependencies. Every non-null
   * path must end in the exact case-sensitive `.embed.db` suffix so its SQLite
   * sidecars, watcher guard, and HNSW namespace remain injective.
   */
  embedDbFile?: string | null;
  /**
   * v3.11.0 — opt-in closed-loop feedback store, opened once on serve start when
   * `--feedback-weight > 0`. Shared across every per-session `McpServer` (HTTP)
   * so a `mark_useful` in one session influences the search boost in all of them.
   * `null` when feedback is off. Holds an in-memory tally + a per-vault JSON
   * sidecar. The store owns a cross-process persistence lifetime and must be
   * awaited through `close()` during shutdown after request admission drains.
   */
  feedbackStore: import("./feedback.js").FeedbackStore | null;
  disabledTools: Set<string>;
  /**
   * Prepared or caller-supplied tool allowlist.
   *
   * This remains a `Set<string>` for source compatibility with the original
   * public `ServerDeps` contract. For legacy caller-constructed dependencies,
   * an empty set with no {@link enabledToolsConfigured} marker means that no
   * allowlist was configured; any non-empty set is an active allowlist.
   */
  enabledTools: Set<string>;
  /**
   * Provenance bit emitted by {@link prepareServerDeps} to distinguish an
   * omitted allowlist from an explicitly empty `ServeOptions.enabledTools`
   * allowlist. Optional so existing caller-constructed `ServerDeps` objects
   * remain source-compatible.
   */
  enabledToolsConfigured?: boolean;
  warningTracker: { printed: boolean };
  /**
   * v2.13.0 — opt-in HNSW approximate nearest-neighbor index built in-memory
   * on serve start from the embed-db rows instead of O(n) brute force.
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
    /**
     * v3.6.2 HN-4 — model alias the HNSW index was built with (from
     * the embed-db's persisted meta, or the resolved default for fresh
     * dbs). Propagated to `HnswSearchContext` at search time so the
     * query embedder model can be verified against the index. CRIT-1
     * fixed the build-side destruction; this seals the search side.
     */
    modelAlias: string;
    /** Physical EmbedDb generation backing this prepared graph. */
    dbInstanceUuid: string;
    /** Durable EmbedDb mutation epoch backing this prepared graph. */
    dbMutationEpoch: number;
    /** Shared semantic-family lifetime retained after the snapshot DB closes. */
    persistenceLifetime?: Pick<PersistenceFamilyLeaseHandle, "release">;
    /** Shared semantic-route health; HNSW falls back after an uncertain diff. */
    health?: Readonly<import("./watcher.js").WatcherSearchHealth>;
  } | null;
  /** Shared semantic-route health for this prepared generation. Startup integrity can latch it even when watching is disabled. */
  watcherHealth?: Readonly<import("./watcher.js").WatcherSearchHealth> | null;
}

function watcherActivationRecoveryError(cause: unknown): Error {
  return new Error(
    "enquire: a watcher startup generation did not complete, so its embedding-derived indexes are quarantined. " +
      "Stop every enquire-mcp process using this vault, then run the strict " +
      "`enquire-mcp clear-embeddings --vault <vault>` recovery. It refuses unsafe or foreign interlock " +
      "shapes before deleting indexes; if it refuses, inspect the guard without following it and remove it " +
      "only after a manual ownership audit. Then rebuild successfully with the SAME embedding model, " +
      "quantization, late-chunk, privacy (`--exclude-glob` / `--read-paths`) and PDF settings previously " +
      "used for this vault before restarting.",
    { cause }
  );
}

/**
 * Release the watcher-owned EmbedDb at one failed startup boundary.
 *
 * The caller clears its local handle only after this awaited close succeeds.
 * A rejection therefore leaves the exact handle reachable by the outer
 * retryable prepared-dependency cleanup owner.
 *
 * @param db - Watcher-owned database handle, when startup opened one.
 * @param context - Stable lifecycle stage used only in the diagnostic.
 * @returns After the database and its shared persistence lifetime are closed.
 */
async function closeWatcherEmbedDbAfterFailure(db: EmbedDb | null, context: string): Promise<void> {
  if (!db) return;
  try {
    await db.closeAndRelease();
  } catch (error) {
    throw new Error(`enquire: watcher EmbedDb cleanup after ${context} failed`, { cause: error });
  }
}

/**
 * One-time bootstrap of the heavy deps (vault open + FTS5 sync + watcher).
 * Idempotent on a per-call basis but NOT designed to be called multiple
 * times in one process — it would acquire duplicate live watcher/SQLite
 * resources. Stdio + HTTP each call this exactly once at startup.
 */
export async function prepareServerDeps(opts: ServeOptions): Promise<ServerDeps> {
  assertServeOptionsRuntime(opts);
  const requestedTokenize =
    opts.tokenize === undefined ? undefined : assertTokenizeMode(opts.tokenize, "tokenize option");
  // Programmatic stdio/HTTP consumers bypass src/cli.ts, so the privacy
  // boundary belongs here as well: every server preparation is local-cache-only
  // before any embedder/reranker can load. Explicit setup/install commands do
  // not call prepareServerDeps and remain network-enabled.
  setEmbeddingsOffline();
  // v3.11.5-rc.1 CRL-1 — fail fast on a bad --feedback-weight / --recency-weight /
  // --stale-days BEFORE acquiring any resource (vault cache, FTS5 handle, watcher,
  // embed-db, HNSW). These parsers throw on an out-of-range value; validating them
  // here means a typo can no longer leak an open SQLite handle / running watcher for
  // the process lifetime. buildMcpServer re-parses the (now-validated) values cheaply.
  parseFeedbackConfig(opts);
  parseRecencyConfig(opts);
  // v3.11.5-rc.4 (post-rc.3 re-sweep, CRL-1 sibling) — `--reranker-top-n` was validated
  // only inside buildMcpServer (server.ts, one call-frame LATER), which the stdio `serve`
  // path invokes AFTER prepareServerDeps has already acquired the FTS5 handle / watcher /
  // embed-db / HNSW, so a bad value (`--reranker-top-n 0`) leaked them all. serve-http
  // already fails fast via validateServeHttpRetrievalOpts; hoist the same check here so
  // BOTH paths validate before any acquire. Only consumed when reranking is on.
  if (opts.enableReranker && opts.rerankerTopN !== undefined) {
    parsePositiveInt(opts.rerankerTopN, "--reranker-top-n");
  }
  if (opts.watch && opts.ocrPdfs && !opts.includePdfs) {
    throw new Error("enquire: --ocr-pdfs requires --include-pdfs when --watch is enabled");
  }
  const validatedLateChunkContext =
    opts.watch && opts.lateChunkContext !== undefined
      ? parsePositiveInt(opts.lateChunkContext, "--late-chunk-context")
      : 0;
  const validatedOcrMaxPages =
    opts.watch && opts.ocrPdfs && opts.ocrMaxPages !== undefined
      ? parsePositiveInt(opts.ocrMaxPages, "--ocr-max-pages")
      : undefined;
  const validatedHnswEf =
    opts.useHnsw && opts.hnswEf !== undefined ? parsePositiveInt(opts.hnswEf, "--hnsw-ef", 0xffff_ffff) : undefined;

  const vault = new Vault(opts.vault, {
    enableWrite: opts.enableWrite ?? false,
    maxFileBytes: opts.maxFileBytes !== undefined ? parsePositiveInt(opts.maxFileBytes, "--max-file-bytes") : undefined,
    maxCacheEntries: opts.cacheSize !== undefined ? parsePositiveInt(opts.cacheSize, "--cache-size") : undefined,
    persistentCache: opts.persistentCache ?? false,
    cacheFile: opts.cacheFile,
    excludeGlobs: opts.excludeGlob,
    readPaths: opts.readPaths
  });
  let ftsIndex: FtsIndex | null = null;
  let watcher: VaultWatcher | null = null;
  let watcherEmbedDb: EmbedDb | null = null;
  let hnswSnapshotDb: EmbedDb | null = null;
  let hnswContext: ServerDeps["hnswContext"] = null;
  let hnswPersistenceLifetime: PersistenceFamilyLeaseHandle | null = null;
  let feedbackStore: FeedbackStore | null = null;
  try {
    await vault.ensureExists();
    const startupEmbedFile = embedDbPath(vault.root);
    const embeddingIndexEnabled = opts.embeddingIndex !== false;
    if (embeddingIndexEnabled) {
      try {
        await assertWatcherActivationGuardClear(startupEmbedFile);
      } catch (error) {
        await assertEmbedDbRecoveryOwnership(startupEmbedFile, vault.root);
        throw watcherActivationRecoveryError(error);
      }
    }
    // Freeze the embedding capability once for this server generation. A DB
    // created after this point is intentionally ignored until restart; otherwise
    // search could publish it while this watcher remains FTS-only and unarmed.
    const startupEmbedDbAvailable = embeddingIndexEnabled && existsSync(startupEmbedFile);

    // Optional FTS5 index. Sync on boot so the first MCP call sees a fresh
    // index. For typical vault sizes this is sub-second; cold-build of a fresh
    // 1k-file vault is ~5s.
    if (opts.persistentIndex) {
      const indexFile = opts.indexFile ?? defaultIndexFile(vault.root);
      // v3.6.2 K-1b — discover the existing FTS index's admitted tokenize_mode BEFORE
      // open. If user built with `--tokenize trigram` and restarts `serve`
      // without explicit --tokenize, the default "unicode61" would mismatch
      // and trigger bootstrapSchema DROP TABLE chunks. Honor the existing
      // mode unless caller passes --tokenize explicitly. Same class as
      // CRIT-1 (v3.6.1) — K-1b residual on FTS5 side. External audit
      // caught this on v3.6.1.
      const discovered = await discoverFtsIndexConfig(indexFile, vault.root);
      const refusedFts = discovered.kind === "refused";
      let tokenize: TokenizeMode =
        requestedTokenize ?? (discovered.kind === "owned" ? discovered.meta.tokenize_mode : "unicode61");
      if (discovered.kind === "owned" && requestedTokenize === undefined) {
        tokenize = discovered.meta.tokenize_mode;
        if (tokenize !== "unicode61") {
          process.stderr.write(
            `enquire: --persistent-index — honoring fts5 index stored tokenize '${tokenize}' (avoids DROP TABLE on schema mismatch); pass --tokenize to override.\n`
          );
        }
      }
      if (refusedFts) {
        process.stderr.write(
          "enquire: --persistent-index FTS5/BM25 configuration could not be verified — degrading to TF-IDF search\n"
        );
      } else {
        ftsIndex = new FtsIndex({ file: indexFile, vaultRoot: vault.root, tokenize });
        try {
          await ftsIndex.open(discovered);
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
          // v3.10.0-rc.33 (post-rc.31 audit) — FAIL-SOFT to TF-IDF instead of
          // crashing serve, matching the embed-db / PDF / HNSW paths below and the
          // "auto-degrades gracefully: works with any subset of signals available"
          // guarantee. The common trigger is better-sqlite3 missing/unbuilt (the
          // Docker introspection image, or an install whose native build failed)
          // + `--persistent-index` — which previously hard-crashed startup with an
          // unactionable "npm rebuild" stack trace. Setting `ftsIndex = null`
          // yields exactly the (heavily-tested) no-`--persistent-index` state:
          // BM25/FTS5 is skipped and search degrades to pure-JS TF-IDF, with a
          // loud stderr warning so a genuinely-broken native install is visible.
          try {
            await ftsIndex?.closeAndRelease(); // open() may have retained a retryable lifetime
          } catch (cleanupError) {
            throw new AggregateError(
              [err, cleanupError],
              "FTS startup failed and its persistence lifetime could not be released"
            );
          }
          ftsIndex = null;
          process.stderr.write(
            `enquire: --persistent-index FTS5/BM25 unavailable — degrading to TF-IDF search (${err instanceof Error ? err.message : String(err)})\n`
          );
        }
      }
    }

    // Optional watcher — only when --watch is passed. Starts after the initial
    // FTS5 sync, then performs one post-ready incremental diff to close
    // chokidar's `ignoreInitial` pre-capture window.
    //
    // v3.7.16 P1-5 — when --include-pdfs is also set, the watcher tracks
    // PDF lifecycle events too, keeping the FTS5 PDF chunks in sync with
    // adds/changes/deletes. Pre-3.7.16 only .md events were handled, so
    // PDF moves/deletes left stale rows until restart.
    // v3.8.0-rc.2 R-7 — watcher-owned embed-db handle (separate from HNSW
    // init's short-lived handle). Opened below if `--watch` + the embed-db
    // file exists; closed by startServer's shutdown handler.
    let watcherActivationGuard: WatcherActivationGuard | null = null;
    let guardArmAttempted = false;
    // v3.9.0-rc.16 — `--ocr-pdfs` only takes effect on the watcher path (it
    // re-OCRs scanned PDFs as they change and feeds the embed pipeline). Warn
    // if it was passed without `--watch` so the flag isn't a silent no-op.
    if (opts.ocrPdfs && !opts.watch) {
      process.stderr.write(
        "enquire: --ocr-pdfs has no effect without --watch (it re-indexes scanned PDFs as they change during a session). Ignoring.\n"
      );
    }
    if (opts.watch) {
      // v3.9.0-rc.1 — OCR-on-watch is wired here when both `--ocr-pdfs` and
      // `--include-pdfs` are set. The constructor fail-loud check enforces
      // the pairing (OCR without includePdfs is wasted CPU because PDF
      // events would be filtered out before the OCR codepath runs). Note
      // we DON'T pass `ocrPdfs` at this point — the watcher's constructor
      // also requires an `embedDb`, which we wire below via attachEmbed(). The
      // owning handle is admitted before the activation guard and watcher start;
      // the watcher then captures (but does not process) boot-window events until
      // embed + HNSW sinks reach their terminal startup state below. The
      // ocrPdfs flag is therefore set during attachEmbed, once that handle is
      // ready; activate() later reconciles every captured path across all
      // successfully attached sinks.
      watcher = new VaultWatcher({
        vault,
        ftsIndex,
        includePdfs: opts.includePdfs === true,
        deferActivation: true
      });
      try {
        const embedFile = startupEmbedFile;
        let watcherEmbedModel: ReturnType<typeof resolveModel> | null = null;
        let watcherEmbedQuantization: "f32" | "int8" | null = null;
        if (startupEmbedDbAvailable) {
          // Discover the complete admitted class for this canonical vault. A
          // foreign artifact is refused before a writable handle is constructed
          // or any durable activation guard is armed.
          const discovered = await discoverEmbedDbConfig(embedFile, vault.root);
          if (discovered.kind === "missing" || discovered.kind === "refused") {
            throw new Error("Embedding index configuration could not be verified");
          }
          const storedConfiguration =
            discovered.kind === "owned" ? resolveStoredEmbeddingConfiguration(discovered.meta) : null;
          watcherEmbedModel = storedConfiguration?.model ?? resolveModel(undefined);
          watcherEmbedQuantization = storedConfiguration?.quantization ?? opts.quantizeEmbeddings ?? "f32";
          watcherEmbedDb = new EmbedDb({
            file: embedFile,
            vaultRoot: vault.root,
            modelAlias: watcherEmbedModel.alias,
            dim: watcherEmbedModel.dim,
            quantization: watcherEmbedQuantization
          });
          await watcherEmbedDb.open(discovered);
        }

        // Arm before chokidar can receive its first event. Any crash, attachment
        // failure, overflow, or non-quiescing activation leaves this exact
        // interlock behind; every later serve then refuses to publish the
        // potentially stale embedding index until explicit recovery.
        if (startupEmbedDbAvailable) {
          guardArmAttempted = true;
          watcherActivationGuard = await armWatcherActivationGuard(startupEmbedFile);
        }
        await watcher.start();

        // `ignoreInitial:true` suppresses the initial add stream. Repeat the
        // incremental FTS diff after ready so a file created during chokidar's
        // first scan cannot remain in a pre-capture gap.
        if (ftsIndex) {
          await syncFtsIndex(vault, ftsIndex);
          if (opts.includePdfs) {
            try {
              await syncPdfFtsIndex(vault, ftsIndex);
            } catch (error) {
              process.stderr.write(
                `enquire: post-ready pdf-fts5 reconciliation skipped — ${
                  error instanceof Error ? error.message : String(error)
                }\n`
              );
            }
          }
        }

        // v3.8.0-rc.2 R-7 — wire embed-db sync. When an existing EmbedDb
        // cannot be attached, startup now fails closed: the same file would
        // otherwise remain lazily available to search tools while no watcher
        // could keep it fresh.
        if (startupEmbedDbAvailable) {
          if (!watcherEmbedDb || !watcherEmbedModel || !watcherEmbedQuantization) {
            throw new Error("enquire: watcher EmbedDb configuration was not retained through startup");
          }
          // Load the already-cached embedder (~2-5s warm for the default
          // multilingual model); subsequent calls reuse the transformers.js
          // pipeline. The watcher is already capturing events, but none can
          // mutate FTS/embed state until the startup activation barrier.
          const { loadEmbedder } = await import("./embeddings.js");
          const embedder = await loadEmbedder(watcherEmbedModel.alias);
          const lateChunk = validatedLateChunkContext;
          watcher.attachEmbed(watcherEmbedDb, embedder, lateChunk);
          process.stderr.write(
            `enquire: watcher embed-db sync enabled (model=${watcherEmbedModel.alias}, dim=${watcherEmbedModel.dim}, quantization=${watcherEmbedQuantization}, late-chunk-context=${lateChunk})\n`
          );
          // v3.9.0-rc.1 — wire OCR-on-watch AFTER attachEmbed. setOcrPdfs
          // fails loud if includePdfs is off, which is the right posture:
          // a user passing `--ocr-pdfs` without `--include-pdfs` would
          // otherwise silently watch nothing. opts.ocrPdfs is the CLI flag
          // value; opts.ocrLangs + opts.ocrMaxPages cascade through.
          if (opts.ocrPdfs) {
            try {
              const maxPages = validatedOcrMaxPages;
              watcher.setOcrPdfs(true, opts.ocrLangs, maxPages);
              process.stderr.write(
                `enquire: watcher OCR-on-watch enabled (langs=${opts.ocrLangs ?? "eng"}${
                  maxPages !== undefined ? `, max-pages=${maxPages}` : ""
                })\n`
              );
            } catch (ocrErr) {
              process.stderr.write(
                `enquire: watcher OCR-on-watch attachment FAILED — ${
                  ocrErr instanceof Error ? ocrErr.message : String(ocrErr)
                }\n`
              );
              throw ocrErr;
            }
          }
          // `ignoreInitial:true` can suppress a file created during chokidar's
          // first scan. Diff attached EmbedDb declarations against the current
          // privacy-filtered vault and capture every mismatch. PDF replay then
          // follows this watcher's configured OCR policy.
          await watcher.captureAttachedSinkDrift();
        } else if (opts.ocrPdfs) {
          // v3.9.0-rc.16 — `--ocr-pdfs` needs an embed-db to index the OCR'd
          // text; without one the flag is a silent no-op. Warn + continue
          // FTS5-only instead of failing the whole watcher. This server
          // generation intentionally cannot adopt a DB built after startup.
          process.stderr.write(
            "enquire: --ocr-pdfs requested but no embed-db found — this generation remains FTS5-only. " +
              "Stop this server, run `enquire-mcp build-embeddings`, then restart to enable OCR-on-watch.\n"
          );
        }
      } catch (err) {
        process.stderr.write(
          `enquire: watcher startup FAILED before activation — ${err instanceof Error ? err.message : String(err)}\n`
        );
        await watcher.close().catch((closeErr) => {
          process.stderr.write(
            `enquire: watcher cleanup after startup failure also failed — ${
              closeErr instanceof Error ? closeErr.message : String(closeErr)
            }\n`
          );
        });
        try {
          await closeWatcherEmbedDbAfterFailure(watcherEmbedDb, "watcher startup");
          watcherEmbedDb = null;
        } catch (closeErr) {
          // Keep the exact handle for prepareServerDeps' outer retryable
          // cleanup owner; this diagnostic must not bypass guard recovery.
          process.stderr.write(
            `enquire: watcher EmbedDb cleanup after startup failure also failed — ${
              closeErr instanceof Error ? closeErr.message : String(closeErr)
            }\n`
          );
        }
        if (guardArmAttempted) throw watcherActivationRecoveryError(err);
        throw err;
      }
    }

    const semanticRouteHealth = watcher?.searchHealth ?? { semanticUsable: true, hnswUsable: true };

    // v2.13.0 — opt-in HNSW approximate nearest-neighbor index. Built in-memory
    // on serve start from the embed-db rows instead of the O(n) brute-force
    // dense path. Build/query performance must be measured on the target vault.
    if (opts.useHnsw) {
      try {
        const embedFile = startupEmbedFile;
        if (!startupEmbedDbAvailable) {
          process.stderr.write(
            `enquire: --use-hnsw passed but ${embedFile} doesn't exist; this generation remains lexical. ` +
              `Stop this server, run \`enquire-mcp build-embeddings --vault ${vault.root}\`, then restart.\n`
          );
        } else {
          // v3.6.1 CRIT-1 — discover the existing embed-db's admitted configuration to determine
          // which model alias was used at build-embeddings time. Without
          // this, `serve --use-hnsw` always opened with the default
          // ("multilingual"). If the user had built with `--embedding-model
          // bge`, the bootstrap-schema mismatch check fired DROP TABLE
          // embeddings → data destruction on every restart.
          //
          // Now: full-class discovery first, resolve to the matching model, open without
          // forcing a rebuild. Fresh embed-dbs (no meta yet) still
          // gracefully fall back to the default.
          const discovered = await discoverEmbedDbConfig(embedFile, vault.root);
          if (discovered.kind === "missing" || discovered.kind === "refused") {
            throw new Error("Embedding index configuration could not be verified");
          }
          const storedConfiguration =
            discovered.kind === "owned" ? resolveStoredEmbeddingConfiguration(discovered.meta) : null;
          const model = storedConfiguration?.model ?? resolveModel(undefined);
          const builtAlias = model.alias;
          // v2.17.0 — quantization mode honored same way as the model:
          // prefer the existing db's quantization over CLI default, since
          // mismatching it would also trigger DROP TABLE (same class).
          const quantization = storedConfiguration?.quantization ?? opts.quantizeEmbeddings ?? "f32";
          if (builtAlias && builtAlias !== resolveModel(undefined).alias) {
            process.stderr.write(
              `enquire: --use-hnsw — embed-db was built with model '${builtAlias}'; honoring (avoiding DROP TABLE on schema mismatch).\n`
            );
          }
          hnswSnapshotDb = new EmbedDb({
            file: embedFile,
            vaultRoot: vault.root,
            modelAlias: model.alias,
            dim: model.dim,
            quantization
          });
          const db = hnswSnapshotDb;
          await db.open(discovered);
          try {
            const startMs = Date.now();
            // v2.16.0 — try to load from disk first if persistence is enabled.
            // Skip-rebuild path: load the persisted sidecar when nothing changed
            // since last serve. Staleness is detected via
            // `EmbedDb.computeSignature()` mismatch.
            // v3.10.0-rc.20 (audit M7) — shared base derivation with the eraser
            // (EmbedDb.clearOnDisk), so the persisted sidecars + the erased
            // sidecars can never drift (right-to-erasure completeness).
            const persistFile = hnswPersistBase(embedFile);
            const efOverride = validatedHnswEf;
            let candidate: {
              index: import("./hnsw.js").HnswIndex;
              rowByLabel: Map<number, HnswPersistenceRow>;
              receipt: HnswPersistenceReceipt;
              origin: "loaded" | "built";
            } | null = null;
            if (opts.hnswPersist !== false) {
              const beforeLoad = db.captureHnswLoadSnapshot();
              const { loadHnswFromDisk } = await import("./hnsw.js");
              const loadResult = await loadHnswFromDisk(persistFile, beforeLoad.receipt.signature, {
                expectedDim: beforeLoad.receipt.dim,
                expectedRowsByLabel: beforeLoad.rowsByLabel,
                expectedVectorsByLabel: beforeLoad.vectorsByLabel,
                expectedDbInstanceUuid: beforeLoad.receipt.dbInstanceUuid,
                expectedDbMutationEpoch: beforeLoad.receipt.dbMutationEpoch
              });
              if (loadResult) {
                const afterLoad = db.captureHnswReceiptSnapshot();
                if (sameHnswPersistenceReceipt(beforeLoad.receipt, afterLoad.receipt)) {
                  candidate = {
                    index: loadResult.index,
                    rowByLabel: afterLoad.rowsByLabel,
                    receipt: afterLoad.receipt,
                    origin: "loaded"
                  };
                } else {
                  process.stderr.write(
                    "enquire: embedding database changed while HNSW was loading; discarding the stale candidate\n"
                  );
                }
              }
            }
            if (!candidate) {
              const buildSnapshot = db.captureHnswBuildSnapshot();
              const rows = buildSnapshot.vectors;
              if (rows.length === 0) {
                process.stderr.write(`enquire: --use-hnsw passed but embed-db is empty; skipping HNSW build.\n`);
                // v3.10.0-rc.37 (audit #8 — right-to-erasure) — an emptied embed-db
                // leaves stale immutable generations + `.meta.json` on disk, and the
                // older format-2 metadata carried raw `text_preview`. With
                // no index built there is no `saveTo` to overwrite them, so erase the
                // sidecars now (best-effort) when persistence is on — mirrors the
                // EmbedDb.clearOnDisk sidecar-erase, minus deleting the (valid) db.
                if (opts.hnswPersist !== false) {
                  const { clearHnswPersistedArtifacts } = await import("./hnsw.js");
                  await clearHnswPersistedArtifacts(persistFile, db.getPersistenceFamilyScopes()).catch((err) => {
                    process.stderr.write(
                      `enquire: unable to erase stale HNSW artifacts for an empty index — ${err instanceof Error ? err.message : String(err)}\n`
                    );
                  });
                }
              } else {
                const { buildHnsw } = await import("./hnsw.js");
                const index = await buildHnsw(
                  rows.map((r) => ({ label: r.label, vector: r.vector })),
                  { dim: model.dim, maxElements: rows.length }
                );
                let afterAsync = db.captureHnswReceiptSnapshot();
                if (!sameHnswPersistenceReceipt(buildSnapshot.receipt, afterAsync.receipt)) {
                  process.stderr.write(
                    "enquire: embedding database changed while HNSW was building; discarding the stale candidate\n"
                  );
                } else {
                  // v2.16.0 — persist the freshly-built index for next serve start.
                  let persisted = false;
                  try {
                    if (opts.hnswPersist !== false) {
                      persisted =
                        (await index.saveTo(
                          persistFile,
                          afterAsync.rowsByLabel,
                          afterAsync.receipt.signature,
                          {
                            dbInstanceUuid: afterAsync.receipt.dbInstanceUuid,
                            dbMutationEpoch: afterAsync.receipt.dbMutationEpoch
                          },
                          db.getPersistenceFamilyScopes()
                        )) === true;
                      if (!persisted) {
                        throw new Error("HNSW persistence did not commit its metadata pointer");
                      }
                    }
                  } catch (err) {
                    // Non-fatal — persistence is an optimization. Log + continue.
                    process.stderr.write(
                      `enquire: HNSW persist failed (continuing with in-memory index) — ${err instanceof Error ? err.message : String(err)}\n`
                    );
                  }
                  const afterPersist = db.captureHnswReceiptSnapshot();
                  if (sameHnswPersistenceReceipt(afterAsync.receipt, afterPersist.receipt)) {
                    if (persisted) {
                      process.stderr.write(
                        `enquire: HNSW immutable generation + meta pointer persisted at ${persistFile}\n`
                      );
                    }
                    afterAsync = afterPersist;
                    candidate = {
                      index,
                      rowByLabel: afterAsync.rowsByLabel,
                      receipt: afterAsync.receipt,
                      origin: "built"
                    };
                  } else {
                    process.stderr.write(
                      "enquire: embedding database changed while HNSW was persisting; discarding the stale candidate\n"
                    );
                  }
                }
              }
            }
            if (candidate) {
              // Keep one independent shared semantic-family marker continuously
              // across the short-lived SQLite snapshot handle's release. An
              // external clear must not erase the DB/HNSW generation while this
              // in-memory graph can still answer requests.
              hnswPersistenceLifetime = await db.acquireSharedPersistenceLifetime();
              hnswContext = {
                index: candidate.index,
                rowByLabel: candidate.rowByLabel,
                modelAlias: model.alias,
                dbInstanceUuid: candidate.receipt.dbInstanceUuid,
                dbMutationEpoch: candidate.receipt.dbMutationEpoch,
                persistenceLifetime: hnswPersistenceLifetime,
                ...(watcher ? { health: watcher.searchHealth } : {}),
                ...(efOverride !== undefined ? { ef: efOverride } : {})
              };
              process.stderr.write(
                candidate.origin === "loaded"
                  ? `enquire: HNSW index loaded from disk (${candidate.index.size} vectors, dim=${candidate.index.dim}, ${Date.now() - startMs}ms — DB receipt, labels, and canonical vectors matched)\n`
                  : `enquire: HNSW index built (${candidate.index.size} vectors, dim=${model.dim}, ${Date.now() - startMs}ms)\n`
              );
              // Attach only after the final database-generation recheck. A static
              // context that cannot receive watcher replay is never published.
              if (watcher) {
                try {
                  watcher.attachHnsw(
                    candidate.index,
                    candidate.rowByLabel,
                    opts.hnswPersist !== false ? persistFile : undefined,
                    hnswContext
                  );
                  process.stderr.write(
                    `enquire: watcher HNSW live-update enabled (${candidate.origin}-from-database receipt)\n`
                  );
                } catch (err) {
                  hnswContext = null;
                  try {
                    await hnswPersistenceLifetime.release();
                    hnswPersistenceLifetime = null;
                  } catch (releaseError) {
                    throw new AggregateError(
                      [err, releaseError],
                      "Watcher HNSW attachment failed and its persistence lifetime could not be released"
                    );
                  }
                  process.stderr.write(
                    `enquire: watcher HNSW live-update DISABLED — ${err instanceof Error ? err.message : String(err)}\n`
                  );
                }
              }
            }
          } finally {
            await db.closeAndRelease();
            hnswSnapshotDb = null;
          }
        }
      } catch (err) {
        const cleanupErrors: unknown[] = [];
        if (hnswSnapshotDb) {
          try {
            await hnswSnapshotDb.closeAndRelease();
            hnswSnapshotDb = null;
          } catch (cleanupError) {
            cleanupErrors.push(cleanupError);
          }
        }
        if (hnswPersistenceLifetime) {
          try {
            await hnswPersistenceLifetime.release();
            hnswPersistenceLifetime = null;
          } catch (releaseError) {
            cleanupErrors.push(releaseError);
          }
        }
        if (cleanupErrors.length > 0) {
          throw new AggregateError(
            [err, ...cleanupErrors],
            "HNSW startup failed and persistence cleanup was incomplete"
          );
        }
        // Incomplete/over-envelope snapshot admission and native/sidecar
        // failures are both HNSW-optimization misses. Brute EmbedDb can still
        // rank current well-formed rows; process-wide semanticUsable stays up.
        // Live pending-queue overflow may still latch it (B0).
        process.stderr.write(
          `enquire: HNSW build failed; falling back to brute-force semantic search — ${err instanceof Error ? err.message : String(err)}\n`
        );
        hnswContext = null;
      }
    }

    // v3.12.0-rc.25 — the one startup linearization point for watcher
    // correctness. Until now, edits received while the embedder or HNSW index
    // initialized could update only the sinks already attached at that moment,
    // permanently splitting FTS, EmbedDb, and HNSW generations. Activation
    // replays every captured exact path only after all optional sink attempts
    // have terminated. rc.26 propagates fatal staging/commit failures during
    // activation; ordinary live events remain fail-soft by retaining the prior
    // pre-commit generation or recording a source-scoped quarantine (HNSW may
    // still be process-quarantined; optional OCR keeps its explicit
    // empty-generation fallback). Activation
    // never converts overflow or churn failure into startup success.
    if (watcher) {
      try {
        await watcher.activate();
        if (watcherActivationGuard) {
          await releaseWatcherActivationGuard(watcherActivationGuard);
          watcherActivationGuard = null;
        }
      } catch (err) {
        // Activation overflow/churn or an interlock-release failure means we
        // cannot prove index convergence. Fail startup closed and deliberately
        // leave the durable guard in place so an automatic restart cannot publish
        // the stale EmbedDb through a non-watcher search path.
        await watcher.close().catch((closeErr) => {
          process.stderr.write(
            `enquire: watcher cleanup after activation failure also failed — ${
              closeErr instanceof Error ? closeErr.message : String(closeErr)
            }\n`
          );
        });
        try {
          await closeWatcherEmbedDbAfterFailure(watcherEmbedDb, "watcher activation");
          watcherEmbedDb = null;
        } catch (closeErr) {
          // Preserve the handle for the outer retryable cleanup owner.
          process.stderr.write(
            `enquire: watcher EmbedDb cleanup after activation failure also failed — ${
              closeErr instanceof Error ? closeErr.message : String(closeErr)
            }\n`
          );
        }
        if (hnswPersistenceLifetime) {
          try {
            await hnswPersistenceLifetime.release();
            hnswPersistenceLifetime = null;
            hnswContext = null;
          } catch (releaseError) {
            process.stderr.write(
              `enquire: HNSW lifetime cleanup after watcher activation failure also failed — ${
                releaseError instanceof Error ? releaseError.message : String(releaseError)
              }\n`
            );
          }
        }
        if (watcherActivationGuard) throw watcherActivationRecoveryError(err);
        throw err;
      }
    }

    // v3.11.0 — open the opt-in closed-loop feedback store ONCE (shared across HTTP
    // sessions so a mark_useful in one session feeds the search boost in all). ON
    // only when `--feedback-weight > 0`. The weight was already validated at the top
    // of prepareServerDeps (CRL-1), so this re-parse only decides whether to open the
    // store. `FeedbackStore.open` is fail-soft (a corrupt/missing sidecar yields an
    // empty store — never breaks boot).
    // v3.11.6-rc.8 (RFC-surfaced latent bug) — key the feedback sidecar off the
    // CANONICAL vault.root (realpath'd), NOT the raw `opts.vault`. The FTS5/embed/
    // parse-cache sidecars all use vault.root, so a symlinked or trailing-slash
    // `--vault` path used to give the feedback file a DIFFERENT sha1 hash than the
    // rest — fragmenting feedback across path spellings and desyncing it from the
    // realpath-keyed prune eraser. vault.root is also passed as the on-open guard.
    feedbackStore =
      parseFeedbackConfig(opts) !== null ? await FeedbackStore.open(defaultFeedbackFile(vault.root), vault.root) : null;

    return {
      vault,
      ftsIndex,
      watcher,
      watcherEmbedDb,
      embedDbFile:
        opts.embeddingIndex === false
          ? null
          : opts.watch
            ? startupEmbedDbAvailable
              ? startupEmbedFile
              : null
            : undefined,
      feedbackStore,
      disabledTools: new Set(opts.disabledTools ?? []),
      enabledTools: new Set(opts.enabledTools ?? []),
      enabledToolsConfigured: opts.enabledTools !== undefined,
      warningTracker: { printed: false },
      hnswContext,
      watcherHealth: semanticRouteHealth
    };
  } catch (error) {
    const temporaryCleanupErrors: unknown[] = [];
    if (hnswSnapshotDb) {
      try {
        await hnswSnapshotDb.closeAndRelease();
        hnswSnapshotDb = null;
      } catch (cleanupError) {
        temporaryCleanupErrors.push(cleanupError);
      }
    }
    const cleanupHnswContext = hnswPersistenceLifetime ? { persistenceLifetime: hnswPersistenceLifetime } : hnswContext;
    const cleanupOwner = createPreparedServerCleanupOwner(
      {
        feedbackStore,
        vault,
        ftsIndex,
        watcher,
        watcherEmbedDb,
        hnswContext: cleanupHnswContext
      },
      { flushVaultCache: false }
    );
    const cleanupFailures = await cleanupOwner.cleanup();
    if (temporaryCleanupErrors.length > 0 || cleanupFailures.length > 0) {
      throw new PreparedServerCleanupError(
        "Server dependency preparation failed and cleanup was incomplete",
        cleanupFailures,
        cleanupOwner,
        [error, ...temporaryCleanupErrors]
      );
    }
    throw error;
  }
}

/**
 * Build a fresh `McpServer` over already-prepared deps. Cheap (just
 * registers tool handlers — no I/O, no SQLite open). The stdio entry calls
 * this factory once for the selected era, except for the protocol-defined
 * modern-probe-to-legacy-fallback path where it discards the probe instance
 * and calls the same cheap factory again. HTTP also calls it per served
 * request/session; neither path re-prepares the vault or persistence handles.
 *
 * @param deps - Shared prepared vault/index/model dependencies.
 * @param opts - Tool and retrieval configuration.
 * @param writeTracker - Optional transport/session aggregate for persistent
 *   mutation lifecycle. The stdio, modern + legacy-stateless HTTP, and legacy
 *   stateful HTTP serving entrypoints supply an owning tracker so shared
 *   dependencies outlive every finishing or rolling-back write; direct
 *   programmatic consumers may omit it.
 * @returns A freshly registered MCP server.
 */
export function buildMcpServer(deps: ServerDeps, opts: ServeOptions, writeTracker?: WriteRequestTracker): McpServer {
  assertServeOptionsRuntime(opts);
  if (
    !(deps.disabledTools instanceof Set) ||
    [...deps.disabledTools].some((name) => typeof name !== "string" || name.trim().length === 0 || name !== name.trim())
  ) {
    throw new TypeError("ServerDeps.disabledTools must be a Set of canonical tool names without outer whitespace");
  }
  if (
    !(deps.enabledTools instanceof Set) ||
    [...deps.enabledTools].some((name) => typeof name !== "string" || name.trim().length === 0 || name !== name.trim())
  ) {
    throw new TypeError("ServerDeps.enabledTools must be a Set of canonical tool names without outer whitespace");
  }
  if (deps.enabledToolsConfigured !== undefined && typeof deps.enabledToolsConfigured !== "boolean") {
    throw new TypeError("ServerDeps.enabledToolsConfigured must be a boolean when provided");
  }
  const configuredExcludeGlobs = (opts.excludeGlob ?? []).filter((pattern) => pattern.trim().length > 0);
  const configuredReadPaths = (opts.readPaths ?? []).filter((pattern) => pattern.trim().length > 0);
  if (
    opts.excludeGlob !== undefined &&
    (configuredExcludeGlobs.length !== deps.vault.excludeGlobs.length ||
      configuredExcludeGlobs.some((pattern, index) => pattern !== deps.vault.excludeGlobs[index]))
  ) {
    throw new TypeError("Serve option excludeGlob does not match the prepared Vault privacy boundary");
  }
  if (
    opts.readPaths !== undefined &&
    (configuredReadPaths.length !== deps.vault.readPaths.length ||
      configuredReadPaths.some((pattern, index) => pattern !== deps.vault.readPaths[index]))
  ) {
    throw new TypeError("Serve option readPaths does not match the prepared Vault privacy boundary");
  }

  // A caller may construct ServerDeps and then pass a second, narrower set of
  // public ServeOptions to this semver-bound factory. Compose those two
  // authorities monotonically: an allowlist can only shrink, a denylist can
  // only grow, and write/feedback require both the prepared capability and the
  // current options. This makes a computed `enabledTools: []` or
  // `enableWrite: false` fail closed instead of inheriting broader deps.
  const depsEnabledToolsConfigured = deps.enabledTools.size > 0 || deps.enabledToolsConfigured === true;
  const requestedEnabledTools = opts.enabledTools === undefined ? null : new Set(opts.enabledTools);
  const effectiveEnabledTools = !depsEnabledToolsConfigured
    ? requestedEnabledTools
    : requestedEnabledTools === null
      ? new Set(deps.enabledTools)
      : new Set([...deps.enabledTools].filter((name) => requestedEnabledTools.has(name)));
  const effectiveDisabledTools = new Set(deps.disabledTools);
  for (const name of opts.disabledTools ?? []) effectiveDisabledTools.add(name);
  const writeToolsEnabled = deps.vault.writeEnabled && opts.enableWrite === true;
  const feedbackConfig = parseFeedbackConfig(opts);
  const feedbackToolEnabled = deps.feedbackStore !== null && feedbackConfig !== null;
  // `buildMcpServer` is a public, semver-bound programmatic entrypoint and can
  // be called with caller-constructed deps (without `prepareServerDeps`).
  // Enforce the runtime privacy boundary here too, before any registered tool
  // can lazily load an embedder or reranker.
  setEmbeddingsOffline();
  const initializeToolProfile = resolveInitializeToolProfile({
    hasFtsIndex: deps.ftsIndex !== null,
    diagnosticSearchTools: opts.diagnosticSearchTools ?? false,
    writeTools: writeToolsEnabled,
    feedbackTool: feedbackToolEnabled,
    enabledTools: effectiveEnabledTools,
    disabledTools: effectiveDisabledTools
  });
  const mcpServer = new McpServer(
    {
      name: "enquire",
      version: VERSION
    },
    {
      instructions: buildInitializeInstructions(initializeToolProfile)
    }
  );

  // v1.10/v1.11 — per-tool gating. A composition adapter intercepts
  // registerTool so every register* function below transparently honors the
  // gating rules without mutating the SDK server instance.
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
  let server = mcpServer;
  if (effectiveDisabledTools.size > 0 || effectiveEnabledTools !== null) {
    server = createToolRegistrationAdapter(mcpServer, (name) => {
      registeredNames.add(name);
      if (effectiveEnabledTools !== null) {
        if (effectiveEnabledTools.has(name)) {
          usedEnabled.add(name);
        } else {
          if (verbose) process.stderr.write(`enquire: skipping tool ${name} (not in --enabled-tools allowlist)\n`);
          return false;
        }
      }
      if (effectiveDisabledTools.has(name)) {
        usedDisabled.add(name);
        if (verbose) process.stderr.write(`enquire: skipping tool ${name} (disabled by --disabled-tools)\n`);
        return false;
      }
      return true;
    });
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

  // v3.10.0-rc.5: build opt-in recency re-ranking config. Default OFF
  // (weight 0 → null → searchHybrid skips the re-rank entirely, ranking stays
  // relevance-pure). `--stale-days` only matters when weight > 0 (the half-life).
  const recencyConfig = parseRecencyConfig(opts);

  // v3.11.0 — opt-in closed-loop feedback. `feedbackContext` (weight + the shared
  // store) is passed to the search tool for the boost; the `obsidian_mark_useful`
  // tool is registered only when the store was opened (`--feedback-weight > 0`).
  const feedbackContext =
    feedbackToolEnabled && feedbackConfig && deps.feedbackStore
      ? { weight: feedbackConfig.weight, store: deps.feedbackStore }
      : null;

  registerReadTools(
    server,
    deps.vault,
    deps.ftsIndex,
    opts.diagnosticSearchTools ?? false,
    rerankerConfig,
    deps.hnswContext,
    recencyConfig,
    feedbackContext,
    deps.embedDbFile,
    deps.watcherHealth
  );
  if (feedbackToolEnabled && deps.feedbackStore) {
    registerFeedbackTool(server, deps.feedbackStore, deps.vault, writeTracker);
  }
  if (writeToolsEnabled) registerWriteTools(server, deps.vault, writeTracker);
  if (deps.ftsIndex && opts.diagnosticSearchTools) registerFtsTools(server, deps.ftsIndex, deps.vault);
  registerResources(server, deps.vault);
  if (deps.ftsIndex) registerChunkResource(server, deps.ftsIndex, deps.vault);
  if (opts.prompts !== false) registerPrompts(server);

  // v2.0.0-beta.1: warn on unknown names AFTER all tools are registered.
  // We can't validate at parse time because the canonical list depends on
  // runtime config (e.g. --persistent-index gates obsidian_full_text_search,
  // --enable-write gates the 7 write tools). So we wait until everything is
  // registered, then diff the user's lists against what was actually seen.
  if (verbose) {
    for (const name of effectiveDisabledTools) {
      if (!usedDisabled.has(name)) {
        const hint = registeredNames.has(name)
          ? "" // shouldn't happen — would have been used
          : ` (no such tool registered; check spelling; available: ${[...registeredNames].sort().join(", ")})`;
        process.stderr.write(`enquire: warning — --disabled-tools "${name}" did not match any tool${hint}\n`);
      }
    }
    for (const name of effectiveEnabledTools ?? []) {
      if (!usedEnabled.has(name)) {
        const hint = registeredNames.has(name)
          ? ""
          : ` (no such tool; check spelling; available: ${[...registeredNames].sort().join(", ")})`;
        process.stderr.write(`enquire: warning — --enabled-tools "${name}" did not match any tool${hint}\n`);
      }
    }
    deps.warningTracker.printed = true;
  }

  // Return the facade when filters are active so programmatic consumers that
  // register a tool after buildMcpServer() retain the same gating semantics as
  // the historical in-place override. Every lifecycle method stays bound to
  // the untouched raw SDK target inside the adapter.
  return server;
}

/** Ordinary bound for closing the SDK-owned stdio protocol handle. */
const STDIO_PROTOCOL_CLOSE_GRACE_MS = 3000;

async function waitForStdioProtocolClose(
  task: Promise<void>,
  timeoutMs: number = STDIO_PROTOCOL_CLOSE_GRACE_MS
): Promise<boolean> {
  if (timeoutMs <= 0) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Test-only controls for exercising the stdio startup ownership boundary. */
interface StdioStartupInternals {
  /** Fault-injection point after the SDK protocol handle exists but before ownership is committed. */
  afterProtocolConnected?: (deps: ServerDeps) => void | Promise<void>;
}

export async function startServer(opts: ServeOptions, internals: StdioStartupInternals = {}): Promise<void> {
  const deps = await prepareServerDeps(opts);
  const writeTracker = new WriteRequestTracker();
  // SDK v2 owns the stdio transport and negotiates the 2026-07-28 vs legacy
  // era from the connection's opening exchange. Keep the factory strictly
  // registration-only: a probe followed by legacy fallback may invoke it
  // twice, while the vault/index/watcher generation above remains singular.
  let handle: ReturnType<typeof serveStdio> | undefined;
  let onSignal: (() => void) | undefined;
  let onBeforeExit: (() => void) | undefined;
  let sigintInstalled = false;
  let sigtermInstalled = false;
  let beforeExitInstalled = false;
  try {
    handle = serveStdio(() => buildMcpServer(deps, opts, writeTracker), {
      onerror: (error) => {
        process.stderr.write(`enquire: stdio transport error — ${error.message}\n`);
      }
    });
    if (internals.afterProtocolConnected) await internals.afterProtocolConnected(deps);

    // v3.10.0-rc.19 (audit M3) — ONE graceful-shutdown orchestrator on signal,
    // mirroring the HTTP path. SDK protocol close starts immediately, the
    // persistent-write integrity tail completes independently, and only then
    // `shutdownStdioDeps` closes watcher + embed-db, flushes the persistent
    // cache, and closes the fts5 index, AWAITING each async step before
    // `process.exit(0)`. Pre-rc.19 these were three separate SIGINT/SIGTERM
    // handlers and the cache-flush handler called `process.exit(0)` the moment
    // its flush resolved — racing the (async) `watcher.close()`. stdio has no
    // installSignalHandlers escape hatch (it always owns its process).
    let shutdownPromise: Promise<void> | undefined;
    let protocolClosed = false;
    let protocolCloseAttempt: Promise<void> | undefined;
    let protocolCloseFailure: unknown;
    let writeIntegrityComplete = false;
    const stdioCleanupOwner = createPreparedServerCleanupOwner(deps, {
      flushVaultCache: true,
      onCacheFlushError: () => {
        process.stderr.write("enquire: cache flush failed; retained for retry\n");
      }
    });
    const connectedHandle = handle;
    const shutdown = (): Promise<void> => {
      if (shutdownPromise) return shutdownPromise;
      const attempt = (async () => {
        const cleanupErrors: unknown[] = [];
        writeTracker.closeAdmission("Stdio shutdown closed persistent-write admission");
        // Start protocol close immediately so no new read callback is admitted,
        // but never put its potentially backpressured graceful flush in front of
        // the persistent-write integrity tail. The tracker gate above rejects a
        // write callback that dispatches late after the SDK close began.
        if (!protocolClosed && !protocolCloseAttempt) {
          protocolCloseFailure = undefined;
          const closeAttempt = Promise.resolve()
            .then(() => connectedHandle.close())
            .then(
              () => {
                protocolClosed = true;
              },
              (error: unknown) => {
                protocolCloseFailure = error;
                throw error;
              }
            );
          protocolCloseAttempt = closeAttempt;
          void closeAttempt
            .catch(() => {})
            .finally(() => {
              if (protocolCloseAttempt === closeAttempt) protocolCloseAttempt = undefined;
            });
        }
        const protocolClose = protocolCloseAttempt ?? Promise.resolve();
        if (!writeIntegrityComplete) {
          let writeIntegrityFailed = false;
          try {
            await writeTracker.abortRollbackSafe("Stdio shutdown exceeded the protocol-close boundary");
          } catch (error) {
            writeIntegrityFailed = true;
            cleanupErrors.push(error);
          }
          try {
            await writeTracker.waitForAll();
          } catch (error) {
            writeIntegrityFailed = true;
            cleanupErrors.push(error);
          }
          if (!writeIntegrityFailed) writeIntegrityComplete = true;
        }
        // `serveStdio.close()` may flush a graceful subscriptions/listen
        // result through a client-controlled stdout pipe. Bound that ordinary
        // protocol courtesy after write integrity is settled; a client that
        // stopped reading must not pin SIGTERM or shared dependency cleanup.
        if (!(await waitForStdioProtocolClose(protocolClose.catch(() => {})))) {
          cleanupErrors.push(new Error("Stdio protocol close exceeded its bounded grace"));
          process.stderr.write(
            `enquire: stdio protocol close exceeded ${STDIO_PROTOCOL_CLOSE_GRACE_MS}ms; retained for retry\n`
          );
        } else if (protocolCloseFailure !== undefined) {
          cleanupErrors.push(protocolCloseFailure);
          process.stderr.write("enquire: stdio protocol close failed; retained for retry\n");
        }
        try {
          await shutdownStdioDeps(deps, stdioCleanupOwner);
        } catch (error) {
          cleanupErrors.push(error);
        }
        if (cleanupErrors.length > 0) {
          throw new AggregateError(cleanupErrors, "Stdio shutdown was incomplete; exact owners retained for retry");
        }
      })();
      shutdownPromise = attempt;
      void attempt.catch(() => {
        if (shutdownPromise === attempt) shutdownPromise = undefined;
      });
      return attempt;
    };
    let signalExitScheduled = false;
    onSignal = () => {
      if (signalExitScheduled) return;
      signalExitScheduled = true;
      void retryIncompleteShutdownOnce(shutdown).then(
        () => process.exit(0),
        () => {
          process.stderr.write("enquire: stdio shutdown incomplete after bounded retry; retained cleanup debt\n");
          process.exit(1);
        }
      );
    };
    // beforeExit (natural loop drain, no signal): best-effort teardown, never
    // exit. Guarded so the async work it schedules can't re-trigger beforeExit.
    let beforeExitRan = false;
    onBeforeExit = () => {
      if (beforeExitRan) return;
      beforeExitRan = true;
      void shutdown().catch(() => {
        process.stderr.write("enquire: stdio before-exit cleanup incomplete; retained cleanup debt\n");
        process.exitCode = 1;
      });
    };
    process.once("SIGINT", onSignal);
    sigintInstalled = true;
    process.once("SIGTERM", onSignal);
    sigtermInstalled = true;
    process.on("beforeExit", onBeforeExit);
    beforeExitInstalled = true;

    // A ready banner is a startup commit: every earlier operation remains
    // inside this ownership boundary, and the shutdown owner is installed
    // before readiness becomes externally observable.
    process.stderr.write(`${formatReadyBanner(deps)} (transport=stdio)\n`);
    return;
  } catch (error) {
    // A partially installed process owner must not retain a failed startup.
    if (sigintInstalled && onSignal) process.removeListener("SIGINT", onSignal);
    if (sigtermInstalled && onSignal) process.removeListener("SIGTERM", onSignal);
    if (beforeExitInstalled && onBeforeExit) process.removeListener("beforeExit", onBeforeExit);

    const cleanupErrors: unknown[] = [];
    writeTracker.closeAdmission("Stdio startup rollback closed persistent-write admission");
    if (handle) {
      const rollbackHandle = handle;
      try {
        const closed = await waitForStdioProtocolClose(Promise.resolve().then(() => rollbackHandle.close()));
        if (!closed) cleanupErrors.push(new Error("Stdio protocol startup rollback exceeded its close boundary"));
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    try {
      await writeTracker.abortRollbackSafe("Stdio startup rollback aborted persistent writes");
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    try {
      await writeTracker.waitForAll();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    const cleanupOwner = createPreparedServerCleanupOwner(deps, { flushVaultCache: false });
    const cleanupFailures = await cleanupOwner.cleanup();
    cleanupErrors.push(...cleanupFailures.map((failure) => failure.error));
    if (cleanupErrors.length > 0) {
      throw new PreparedServerCleanupError(
        "Stdio transport startup failed and dependency cleanup was incomplete",
        cleanupFailures,
        cleanupOwner,
        [error, ...cleanupErrors.slice(0, cleanupErrors.length - cleanupFailures.length)]
      );
    }
    throw error;
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
  const enabledMode =
    enabledTools.size === 0 && deps.enabledToolsConfigured !== true ? "" : `, enabled-tools=${enabledTools.size}`;
  return `enquire ${VERSION} ready (${writeMode}, vault=${vault.root}${cacheMode}${ftsMode}${privacyMode}${watchMode}${disabledMode}${enabledMode})`;
}

// v3.8.0-rc.6 ARCH-1 — `buildEmbedText` moved to embed-pipeline.ts to break
// the circular import (embed-pipeline → server → embed-pipeline). Re-exported
// here so that src/index.ts + tests/late-chunking.test.ts see no API change.
export { buildEmbedText } from "./embed-pipeline.js";
