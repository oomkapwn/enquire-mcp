import { existsSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import {
  assertEmbedDbRecoveryOwnership,
  discoverEmbedDbConfig,
  EmbedDb,
  hnswPersistBase
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
  type TokenizeMode
} from "./fts5.js";
import { VERSION } from "./index.js";
import { buildInitializeInstructions, resolveInitializeToolProfile } from "./initialize-instructions.js";
import { createToolRegistrationAdapter } from "./mcp-registration.js";
import { registerPrompts } from "./prompts.js";
import { parseFeedbackConfig, parseRecencyConfig } from "./retrieval-opts.js";
import { shutdownStdioDeps } from "./shutdown.js";
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

export { syncFtsIndex } from "./fts5.js";
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
  /** Override the persistent cache file location. */
  cacheFile?: string;
  /** Enable the persistent FTS5 index (requires `better-sqlite3`). */
  persistentIndex?: boolean;
  /** Override the FTS5 index file location. */
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
   *  `DEFAULT_OCR_MAX_PAGES`). Image-only PDFs exceeding this skip embed-sync
   *  (FTS5 still updates from the pdfjs `extractPdfText` result, which
   *  returns empty pages for image-only PDFs). */
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
   * and backward-compatible caller-constructed dependencies.
   */
  embedDbFile?: string | null;
  /**
   * v3.11.0 — opt-in closed-loop feedback store, opened once on serve start when
   * `--feedback-weight > 0`. Shared across every per-session `McpServer` (HTTP)
   * so a `mark_useful` in one session influences the search boost in all of them.
   * `null` when feedback is off. Holds an in-memory tally + a per-vault JSON
   * sidecar; no open file handle to close at shutdown.
   */
  feedbackStore: import("./feedback.js").FeedbackStore | null;
  disabledTools: Set<string>;
  enabledTools: Set<string>;
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
    /** Shared watcher route health; HNSW falls back after an uncertain diff. */
    health?: Readonly<import("./watcher.js").WatcherSearchHealth>;
  } | null;
  /** Shared watcher semantic-route health, or null when watching is disabled. */
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

function closeWatcherEmbedDbAfterFailure(db: EmbedDb | null, phase: string): void {
  if (!db) return;
  try {
    db.close();
  } catch (error) {
    process.stderr.write(
      `enquire: watcher EmbedDb cleanup after ${phase} failure also failed — ${
        error instanceof Error ? error.message : String(error)
      }\n`
    );
  }
}

/**
 * One-time bootstrap of the heavy deps (vault open + FTS5 sync + watcher).
 * Idempotent on a per-call basis but NOT designed to be called multiple
 * times in one process — it would acquire duplicate live watcher/SQLite
 * resources. Stdio + HTTP each call this exactly once at startup.
 */
export async function prepareServerDeps(opts: ServeOptions): Promise<ServerDeps> {
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
    opts.useHnsw && opts.hnswEf !== undefined ? parsePositiveInt(opts.hnswEf, "--hnsw-ef") : undefined;

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
  let ftsIndex: FtsIndex | null = null;
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
          ftsIndex?.close(); // open() may have thrown before a handle existed
        } catch {
          // no handle to close — ignore
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
  let watcher: VaultWatcher | null = null;
  // v3.8.0-rc.2 R-7 — watcher-owned embed-db handle (separate from HNSW
  // init's short-lived handle). Opened below if `--watch` + the embed-db
  // file exists; closed by startServer's shutdown handler.
  let watcherEmbedDb: EmbedDb | null = null;
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
      closeWatcherEmbedDbAfterFailure(watcherEmbedDb, "watcher startup");
      watcherEmbedDb = null;
      try {
        ftsIndex?.close();
      } catch {
        // Preserve the watcher startup error below.
      }
      if (guardArmAttempted) throw watcherActivationRecoveryError(err);
      throw err;
    }
  }

  // v2.13.0 — opt-in HNSW approximate nearest-neighbor index. Built in-memory
  // on serve start from the embed-db rows instead of the O(n) brute-force
  // dense path. Build/query performance must be measured on the target vault.
  let hnswContext: ServerDeps["hnswContext"] = null;
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
        const db = new EmbedDb({
          file: embedFile,
          vaultRoot: vault.root,
          modelAlias: model.alias,
          dim: model.dim,
          quantization
        });
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
          const signature = db.computeSignature();
          const efOverride = validatedHnswEf;
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
              modelAlias: model.alias,
              ...(watcher ? { health: watcher.searchHealth } : {}),
              ...(efOverride !== undefined ? { ef: efOverride } : {})
            };
            // v3.9.0-rc.2 — wire HNSW live-update on the disk-loaded path
            // too. Same posture as the freshly-built path below: the
            // loaded index supports applyDiff() through the same wrapper.
            if (watcher) {
              try {
                // v3.9.0-rc.6 — pass persistFile so the watcher re-persists
                // the live-updated index at close time (unless --no-hnsw-persist).
                watcher.attachHnsw(
                  loaded.index,
                  loaded.rowByLabel,
                  opts.hnswPersist !== false ? persistFile : undefined
                );
                process.stderr.write(`enquire: watcher HNSW live-update enabled (loaded-from-disk index)\n`);
              } catch (err) {
                // A static HNSW context without live watcher attachment
                // would become stale on the first edit. Fall back to the
                // brute-force path instead of publishing that candidate.
                hnswContext = null;
                process.stderr.write(
                  `enquire: watcher HNSW live-update DISABLED — ${err instanceof Error ? err.message : String(err)}\n`
                );
              }
            }
          } else {
            const rows = db.getAllVectors();
            if (rows.length === 0) {
              process.stderr.write(`enquire: --use-hnsw passed but embed-db is empty; skipping HNSW build.\n`);
              // v3.10.0-rc.37 (audit #8 — right-to-erasure) — an emptied embed-db
              // leaves a stale `<persistFile>.bin` + `.meta.json` on disk, and the
              // `.meta.json` sidecar carries deleted notes' raw `text_preview`. With
              // no index built there is no `saveTo` to overwrite them, so erase the
              // sidecars now (best-effort) when persistence is on — mirrors the
              // EmbedDb.clearOnDisk sidecar-erase, minus deleting the (valid) db.
              if (opts.hnswPersist !== false) {
                const { unlink } = await import("node:fs/promises");
                for (const sidecar of [`${persistFile}.bin`, `${persistFile}.meta.json`]) {
                  await unlink(sidecar).catch(() => {});
                }
              }
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
              hnswContext = {
                index,
                rowByLabel,
                modelAlias: model.alias,
                ...(watcher ? { health: watcher.searchHealth } : {}),
                ...(efOverride !== undefined ? { ef: efOverride } : {})
              };
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
              // v3.9.0-rc.2 — wire HNSW into the watcher for live updates.
              // After this call, every md/pdf edit ALSO updates the in-memory
              // HNSW graph via applyDiff(), so semantic-search reflects the
              // change immediately. Pre-3.9.0 the HNSW index was rebuilt only
              // at serve startup; long-running sessions slowly drifted out of
              // sync with the freshly-upserted embed-db rows.
              if (watcher) {
                try {
                  // v3.9.0-rc.6 — pass persistFile so the watcher re-persists
                  // the live-updated index at close time (unless --no-hnsw-persist).
                  watcher.attachHnsw(index, rowByLabel, opts.hnswPersist !== false ? persistFile : undefined);
                  process.stderr.write(`enquire: watcher HNSW live-update enabled\n`);
                } catch (err) {
                  // Fail-soft. Log + continue; watcher still does embed-db sync.
                  // Do not publish a static HNSW context that cannot receive
                  // the activation replay or later live updates.
                  hnswContext = null;
                  process.stderr.write(
                    `enquire: watcher HNSW live-update DISABLED — ${err instanceof Error ? err.message : String(err)}\n`
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

  // v3.12.0-rc.25 — the one startup linearization point for watcher
  // correctness. Until now, edits received while the embedder or HNSW index
  // initialized could update only the sinks already attached at that moment,
  // permanently splitting FTS, EmbedDb, and HNSW generations. Activation
  // replays every captured exact path only after all optional sink attempts
  // have terminated. rc.26 propagates fatal staging/commit failures during
  // activation; ordinary live events remain fail-soft by retaining the prior
  // pre-mutation generation or quarantining an uncertain semantic route
  // (optional OCR keeps its explicit empty-generation fallback). Activation
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
      closeWatcherEmbedDbAfterFailure(watcherEmbedDb, "watcher activation");
      watcherEmbedDb = null;
      try {
        ftsIndex?.close();
      } catch {
        // Best-effort cleanup; the activation failure below remains primary.
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
  const feedbackStore =
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
    warningTracker: { printed: false },
    hnswContext,
    watcherHealth: watcher?.searchHealth ?? null
  };
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
  // `buildMcpServer` is a public, semver-bound programmatic entrypoint and can
  // be called with caller-constructed deps (without `prepareServerDeps`).
  // Enforce the runtime privacy boundary here too, before any registered tool
  // can lazily load an embedder or reranker.
  setEmbeddingsOffline();
  const initializeToolProfile = resolveInitializeToolProfile({
    hasFtsIndex: deps.ftsIndex !== null,
    diagnosticSearchTools: opts.diagnosticSearchTools ?? false,
    writeTools: deps.vault.writeEnabled,
    feedbackTool: deps.feedbackStore !== null,
    enabledTools: deps.enabledTools,
    disabledTools: deps.disabledTools
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
  if (deps.disabledTools.size > 0 || deps.enabledTools.size > 0) {
    server = createToolRegistrationAdapter(mcpServer, (name) => {
      registeredNames.add(name);
      if (deps.enabledTools.size > 0) {
        if (deps.enabledTools.has(name)) {
          usedEnabled.add(name);
        } else {
          if (verbose) process.stderr.write(`enquire: skipping tool ${name} (not in --enabled-tools allowlist)\n`);
          return false;
        }
      }
      if (deps.disabledTools.has(name)) {
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
  const feedbackConfig = parseFeedbackConfig(opts);
  const feedbackContext =
    feedbackConfig && deps.feedbackStore ? { weight: feedbackConfig.weight, store: deps.feedbackStore } : null;

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
  if (deps.feedbackStore) registerFeedbackTool(server, deps.feedbackStore, writeTracker);
  if (deps.vault.writeEnabled) registerWriteTools(server, deps.vault, writeTracker);
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

export async function startServer(opts: ServeOptions): Promise<void> {
  const deps = await prepareServerDeps(opts);
  const writeTracker = new WriteRequestTracker();
  // SDK v2 owns the stdio transport and negotiates the 2026-07-28 vs legacy
  // era from the connection's opening exchange. Keep the factory strictly
  // registration-only: a probe followed by legacy fallback may invoke it
  // twice, while the vault/index/watcher generation above remains singular.
  const handle = serveStdio(() => buildMcpServer(deps, opts, writeTracker), {
    onerror: (error) => {
      process.stderr.write(`enquire: stdio transport error — ${error.message}\n`);
    }
  });

  process.stderr.write(`${formatReadyBanner(deps)} (transport=stdio)\n`);

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
  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      writeTracker.closeAdmission("Stdio shutdown closed persistent-write admission");
      // Start protocol close immediately so no new read callback is admitted,
      // but never put its potentially backpressured graceful flush in front of
      // the persistent-write integrity tail. The tracker gate above rejects a
      // write callback that dispatches late after the SDK close began.
      const protocolClose = Promise.resolve()
        .then(() => handle.close())
        .catch((error) => {
          process.stderr.write(
            `enquire: stdio protocol close failed — ${error instanceof Error ? error.message : String(error)}\n`
          );
        });
      try {
        await writeTracker.abortRollbackSafe("Stdio shutdown exceeded the protocol-close boundary");
        await writeTracker.waitForAll();
      } finally {
        // `serveStdio.close()` may flush a graceful subscriptions/listen
        // result through a client-controlled stdout pipe. Bound that ordinary
        // protocol courtesy after write integrity is settled; a client that
        // stopped reading must not pin SIGTERM or shared dependency cleanup.
        if (!(await waitForStdioProtocolClose(protocolClose))) {
          process.stderr.write(
            `enquire: stdio protocol close exceeded ${STDIO_PROTOCOL_CLOSE_GRACE_MS}ms; continuing teardown\n`
          );
        }
        await shutdownStdioDeps(deps);
      }
    })();
    return shutdownPromise;
  };
  let signalExitScheduled = false;
  const onSignal = () => {
    if (signalExitScheduled) return;
    signalExitScheduled = true;
    void shutdown().finally(() => process.exit(0));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  // beforeExit (natural loop drain, no signal): best-effort teardown, never
  // exit. Guarded so the async work it schedules can't re-trigger beforeExit.
  let beforeExitRan = false;
  process.on("beforeExit", () => {
    if (beforeExitRan) return;
    beforeExitRan = true;
    void shutdown();
  });
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

// v3.8.0-rc.6 ARCH-1 — `buildEmbedText` moved to embed-pipeline.ts to break
// the circular import (embed-pipeline → server → embed-pipeline). Re-exported
// here so that src/index.ts + tests/late-chunking.test.ts see no API change.
export { buildEmbedText } from "./embed-pipeline.js";

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
export async function syncPdfFtsIndex(
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
  const updatedSet = new Set(diff.updated);
  for (const relPath of [...diff.added, ...diff.updated]) {
    const entry = pdfEntries.find((e) => e.relPath === relPath);
    if (!entry) {
      idx.quarantineFile(relPath, "pdf");
      continue;
    }
    try {
      const buf = await vault.readBinaryFile(entry.absPath);
      const result = await extractPdfText(buf);
      // v3.7.6 H-4 (external audit) — when a PDF becomes image-only (re-saved
      // as scan, replaced with photo, etc.), the old text-extracted chunks
      // linger in the FTS5 index unless we explicitly delete them. Pre-fix
      // the old chunks kept returning stale text for the path even though
      // the new PDF file had no extractable text. Now: when `!hasText` AND
      // this is an UPDATE (path is in diff.updated, i.e. was previously
      // indexed), we drop the previous rows. Pure adds with no text are
      // still just skipped (nothing to delete).
      if (!result.hasText) {
        // dropFile is intentionally idempotent: besides removing any prior
        // chunks/source receipt, it clears a durable quarantine marker left by
        // an earlier failed ADD. Without this call, a now-healthy image-only
        // source with no source_state would remain quarantined forever.
        idx.dropFile(relPath);
        if (updatedSet.has(relPath)) {
          process.stderr.write(
            `enquire: dropping stale rows for ${relPath} during pdf-fts5 sync — PDF is now image-only / scanned (previous text-extracted chunks removed)\n`
          );
        } else {
          process.stderr.write(
            `enquire: skipping ${relPath} during pdf-fts5 sync — image-only / scanned (no extractable text; use OCR via v2.9+)\n`
          );
        }
        continue;
      }
      idx.reindexPdfFile(relPath, entry.mtimeMs, result.pages);
    } catch (err) {
      idx.quarantineFile(relPath, "pdf");
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
