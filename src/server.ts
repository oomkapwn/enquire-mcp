import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { EmbedDb, hnswPersistBase, peekEmbedDbMeta } from "./embed-db.js";
import { embedSingleNote, embedSinglePdf } from "./embed-pipeline.js";
import { type loadEmbedder, resolveModel } from "./embeddings.js";
import { defaultFeedbackFile, FeedbackStore } from "./feedback.js";
import { defaultIndexFile, FtsIndex, peekFtsMetaSafe } from "./fts5.js";
import { VERSION } from "./index.js";
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
   *  sidecar (`<hash>.feedback.json`; paths + counts only). */
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
   *  Mode is per-database; switching modes triggers a full rebuild
   *  (the meta-table contamination guard treats it as a schema change).
   *  Must match the mode used at build-embeddings time — serving with a
   *  different mode would auto-rebuild the index. */
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
    /**
     * v3.6.2 HN-4 — model alias the HNSW index was built with (from
     * the embed-db's persisted meta, or the resolved default for fresh
     * dbs). Propagated to `HnswSearchContext` at search time so the
     * query embedder model can be verified against the index. CRIT-1
     * fixed the build-side destruction; this seals the search side.
     */
    modelAlias: string;
  } | null;
}

/**
 * One-time bootstrap of the heavy deps (vault open + FTS5 sync + watcher).
 * Idempotent on a per-call basis but NOT designed to be called multiple
 * times in one process — the FTS5 sync would double-index. Stdio + HTTP
 * each call this exactly once at startup.
 */
export async function prepareServerDeps(opts: ServeOptions): Promise<ServerDeps> {
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
    const indexFile = opts.indexFile ?? defaultIndexFile(vault.root);
    // v3.6.2 K-1b — peek the existing fts5 index's tokenize_mode BEFORE
    // open. If user built with `--tokenize trigram` and restarts `serve`
    // without explicit --tokenize, the default "unicode61" would mismatch
    // and trigger bootstrapSchema DROP TABLE chunks. Honor the existing
    // mode unless caller passes --tokenize explicitly. Same class as
    // CRIT-1 (v3.6.1) — K-1b residual on FTS5 side. External audit
    // caught this on v3.6.1.
    const peeked = await peekFtsMetaSafe(indexFile);
    let tokenize: "unicode61" | "trigram" = opts.tokenize === "trigram" ? "trigram" : "unicode61";
    if (peeked?.tokenize_mode && !opts.tokenize) {
      tokenize = peeked.tokenize_mode;
      if (tokenize !== "unicode61") {
        process.stderr.write(
          `enquire: --persistent-index — honoring fts5 index stored tokenize '${tokenize}' (avoids DROP TABLE on schema mismatch); pass --tokenize to override.\n`
        );
      }
    }
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

  // Optional watcher — only when --watch is passed. Starts AFTER the initial
  // FTS5 sync so we don't double-index files during boot.
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
    // also requires an `embedDb`, which we wire below via attachEmbed()
    // because the embed-db open happens AFTER watcher start so file
    // events from boot-time edits aren't dropped. The ocrPdfs flag is
    // therefore set during attachEmbed (passed as a synthetic constructor
    // option once the embed handle is ready). Until attachEmbed runs,
    // PDF events take the no-embed-db path (FTS5 reindex + skip).
    watcher = new VaultWatcher({ vault, ftsIndex, includePdfs: opts.includePdfs === true });
    await watcher.start();
    // v3.8.0-rc.2 R-7 — wire embed-db sync. Pre-3.8.0 the watcher only
    // updated FTS5 on .md edits; embed-db drifted silently until manual
    // `enquire-mcp build-embeddings` ran. Users on `--use-hnsw` or
    // semantic search saw retrieval quality slowly degrade across a
    // session. Now: if the embed-db file exists, open a watcher-owned
    // handle (WAL mode safe alongside HNSW init's separate handle),
    // load the embedder lazily, attach to the watcher. Failures are
    // logged as warnings — the FTS5-only watcher continues working.
    try {
      const embedFile = embedDbPath(vault.root);
      const fsMod = await import("node:fs");
      if (fsMod.existsSync(embedFile)) {
        // Peek the existing embed-db meta to match the model alias +
        // dim + quantization the file was built with. Same posture as
        // HNSW init (CRIT-1 v3.6.1) — never DROP TABLE on mismatch.
        const existingMeta = await peekEmbedDbMeta(embedFile);
        const model = resolveModel(existingMeta?.model_alias);
        const quantization =
          (existingMeta?.quantization as "f32" | "int8" | undefined) ?? opts.quantizeEmbeddings ?? "f32";
        watcherEmbedDb = new EmbedDb({
          file: embedFile,
          vaultRoot: vault.root,
          modelAlias: model.alias,
          dim: model.dim,
          quantization
        });
        await watcherEmbedDb.open();
        // Lazy-load the embedder. ~120MB multilingual model first call
        // (~2-5s warm); subsequent calls reuse the cached transformers.js
        // pipeline. Done synchronously here so any failure surfaces
        // BEFORE watcher events start arriving.
        const { loadEmbedder } = await import("./embeddings.js");
        const embedder = await loadEmbedder(model.alias);
        const lateChunk = opts.lateChunkContext ? parsePositiveInt(opts.lateChunkContext, "--late-chunk-context") : 0;
        watcher.attachEmbed(watcherEmbedDb, embedder, lateChunk);
        process.stderr.write(
          `enquire: watcher embed-db sync enabled (model=${model.alias}, dim=${model.dim}, quantization=${quantization}, late-chunk-context=${lateChunk})\n`
        );
        // v3.9.0-rc.1 — wire OCR-on-watch AFTER attachEmbed. setOcrPdfs
        // fails loud if includePdfs is off, which is the right posture:
        // a user passing `--ocr-pdfs` without `--include-pdfs` would
        // otherwise silently watch nothing. opts.ocrPdfs is the CLI flag
        // value; opts.ocrLangs + opts.ocrMaxPages cascade through.
        if (opts.ocrPdfs) {
          try {
            const maxPages =
              opts.ocrMaxPages !== undefined ? parsePositiveInt(opts.ocrMaxPages, "--ocr-max-pages") : undefined;
            watcher.setOcrPdfs(true, opts.ocrLangs, maxPages);
            process.stderr.write(
              `enquire: watcher OCR-on-watch enabled (langs=${opts.ocrLangs ?? "eng"}${
                maxPages !== undefined ? `, max-pages=${maxPages}` : ""
              })\n`
            );
          } catch (ocrErr) {
            // Fail-loud-but-soft: the error is logged + the rest of
            // watcher startup continues. This matches the existing
            // attachEmbed catch above.
            process.stderr.write(
              `enquire: watcher OCR-on-watch DISABLED — ${ocrErr instanceof Error ? ocrErr.message : String(ocrErr)}\n`
            );
          }
        }
      } else if (opts.ocrPdfs) {
        // v3.9.0-rc.16 — `--ocr-pdfs` needs an embed-db to index the OCR'd
        // text; without one the flag is a silent no-op. Warn + continue
        // FTS5-only instead of failing the whole watcher.
        process.stderr.write(
          "enquire: --ocr-pdfs requested but no embed-db found — OCR-on-watch needs an embed-db to index scanned-PDF text. Run `enquire-mcp build-embeddings` first; continuing with FTS5-only watch.\n"
        );
      }
    } catch (err) {
      process.stderr.write(
        `enquire: watcher embed-db sync DISABLED (will continue with fts5-only) — ${err instanceof Error ? err.message : String(err)}\n`
      );
      if (watcherEmbedDb) {
        watcherEmbedDb.close();
        watcherEmbedDb = null;
      }
    }
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
        // v3.6.1 CRIT-1 — peek the existing embed-db's meta to discover
        // which model alias was used at build-embeddings time. Without
        // this, `serve --use-hnsw` always opened with the default
        // ("multilingual"). If the user had built with `--embedding-model
        // bge`, the bootstrap-schema mismatch check fired DROP TABLE
        // embeddings → data destruction on every restart.
        //
        // Now: peek first, resolve to the matching model, open without
        // forcing a rebuild. Fresh embed-dbs (no meta yet) still
        // gracefully fall back to the default.
        const existingMeta = await peekEmbedDbMeta(embedFile);
        const builtAlias = existingMeta?.model_alias;
        const builtQuant = existingMeta?.quantization as "f32" | "int8" | undefined;
        const model = resolveModel(builtAlias);
        // v2.17.0 — quantization mode honored same way as the model:
        // prefer the existing db's quantization over CLI default, since
        // mismatching it would also trigger DROP TABLE (same class).
        const quantization = builtQuant ?? opts.quantizeEmbeddings ?? "f32";
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
        await db.open();
        try {
          const startMs = Date.now();
          // v2.16.0 — try to load from disk first if persistence is enabled.
          // Skip-rebuild path: ~50ms read vs ~25s build for 50K-chunk
          // vault when nothing changed since last serve. Staleness
          // detected via `EmbedDb.computeSignature()` mismatch.
          // v3.10.0-rc.20 (audit M7) — shared base derivation with the eraser
          // (EmbedDb.clearOnDisk), so the persisted sidecars + the erased
          // sidecars can never drift (right-to-erasure completeness).
          const persistFile = hnswPersistBase(embedFile);
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
              modelAlias: model.alias,
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

  // v3.11.0 — open the opt-in closed-loop feedback store ONCE (shared across HTTP
  // sessions so a mark_useful in one session feeds the search boost in all). ON
  // only when `--feedback-weight > 0`. The weight was already validated at the top
  // of prepareServerDeps (CRL-1), so this re-parse only decides whether to open the
  // store. `FeedbackStore.open` is fail-soft (a corrupt/missing sidecar yields an
  // empty store — never breaks boot).
  const feedbackStore =
    parseFeedbackConfig(opts) !== null ? await FeedbackStore.open(defaultFeedbackFile(opts.vault)) : null;

  return {
    vault,
    ftsIndex,
    watcher,
    watcherEmbedDb,
    feedbackStore,
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
    feedbackContext
  );
  if (deps.feedbackStore) registerFeedbackTool(server, deps.feedbackStore);
  if (deps.vault.writeEnabled) registerWriteTools(server, deps.vault);
  if (deps.ftsIndex && opts.diagnosticSearchTools) registerFtsTools(server, deps.ftsIndex, deps.vault);
  registerResources(server, deps.vault);
  if (deps.ftsIndex) registerChunkResource(server, deps.ftsIndex, deps.vault);
  registerPrompts(server);

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

  return server;
}

export async function startServer(opts: ServeOptions): Promise<void> {
  const deps = await prepareServerDeps(opts);
  const server = buildMcpServer(deps, opts);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write(`${formatReadyBanner(deps)} (transport=stdio)\n`);

  // v3.10.0-rc.19 (audit M3) — ONE graceful-shutdown orchestrator on signal,
  // mirroring the HTTP path. `shutdownStdioDeps` closes watcher + embed-db,
  // flushes the persistent cache, then closes the fts5 index, AWAITING each
  // async step before `process.exit(0)`. Pre-rc.19 these were three separate
  // SIGINT/SIGTERM handlers and the cache-flush handler called `process.exit(0)`
  // the moment its flush resolved — racing the (async) `watcher.close()`. stdio
  // has no installSignalHandlers escape hatch (it always owns its process).
  let shuttingDown = false;
  const onSignal = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void shutdownStdioDeps(deps).finally(() => process.exit(0));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  // beforeExit (natural loop drain, no signal): best-effort teardown, never
  // exit. Guarded so the async work it schedules can't re-trigger beforeExit.
  let beforeExitRan = false;
  process.on("beforeExit", () => {
    if (beforeExitRan || shuttingDown) return;
    beforeExitRan = true;
    void shutdownStdioDeps(deps);
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

// v2.0 alpha — sync the persistent embedding index. Same incremental-rebuild
// pattern as syncFtsIndex (mtime tracked in source_state); we only re-embed
// notes whose mtime changed. Embedding is the bottleneck (~5-30ms per chunk
// CPU on M1), so incremental updates are critical for vaults of any size.
//
// v3.8.0-rc.4 — the inner-loop helpers `embedSingleNote` (rc.2) and
// `embedSinglePdf` (rc.3) moved to `./embed-pipeline.js` so tests can
// import them directly (server.ts is in RESTRICTED_MODULES of the
// no-internal-imports Class A invariant). syncEmbedDb / syncPdfEmbedDb
// stay here as they use ServerDeps + bulk-sync orchestration.

export async function syncEmbedDb(
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
      // v3.8.0-rc.2 R-7 — delegate single-note chunk+embed work to the
      // shared helper so the watcher can use the same pipeline. The
      // many-chunks warning stays here (bulk-sync context only).
      const result = await embedSingleNote(vault, embedder, e, { lateChunkContext: contextChars });
      if (result === null) {
        // No body — drop any stale entries.
        db.deleteNote(e.relPath);
        processed += 1;
        continue;
      }
      if (result.chunks >= 30) {
        process.stderr.write(
          `enquire: ${e.relPath} → ${result.chunks} chunks (this one will be slow; consider splitting the note)\n`
        );
      }
      db.upsertNote(e.relPath, e.mtimeMs, result.rows);
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

export async function syncFtsIndex(
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
    if (!entry) continue;
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
        if (updatedSet.has(relPath)) {
          idx.dropFile(relPath);
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

// v3.8.0-rc.4 — embedSinglePdf moved to src/embed-pipeline.ts (see
// rc.4 file header at the top of syncEmbedDb above).

/**
 * v2.8.0 — sync PDF chunks into the embedding index. Mirrors syncEmbedDb
 * but for PDFs. Page boundaries are preserved as `[page: N]` markers
 * before chunking so embeddings carry page-citation context.
 */
export async function syncPdfEmbedDb(
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
  // v3.8.0-rc.3 — extractPdfText lazy-import moved into embedSinglePdf helper.
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
      // v3.8.0-rc.3 R-7 — delegate single-PDF chunk+embed work to the
      // shared helper (DRY with watcher PDF path).
      const result = await embedSinglePdf(vault, embedder, e, { lateChunkContext: contextChars });
      if (result === null) {
        // Image-only PDF OR zero chunks. Drop stale rows if previously
        // indexed; otherwise skip with a stderr note.
        if (prevMtime !== undefined) {
          db.deleteNote(e.relPath);
          process.stderr.write(
            `enquire: dropping stale embed rows for ${e.relPath} — PDF is now image-only / scanned (or empty after extraction)\n`
          );
        } else {
          process.stderr.write(`enquire: skipping ${e.relPath} during pdf-embed sync — image-only / scanned\n`);
        }
        skipped += 1;
        processed += 1;
        continue;
      }
      db.upsertNote(e.relPath, e.mtimeMs, result.rows, "pdf");
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
