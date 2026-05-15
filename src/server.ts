import * as path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { EmbedDb } from "./embed-db.js";
import { type loadEmbedder, resolveModel } from "./embeddings.js";
import { chunkContent, defaultIndexFile, FtsIndex } from "./fts5.js";
import { VERSION } from "./index.js";
import { registerPrompts } from "./prompts.js";
import {
  embedDbPath,
  parsePositiveInt,
  registerChunkResource,
  registerFtsTools,
  registerReadTools,
  registerResources,
  registerWriteTools
} from "./tool-registry.js";
import { Vault } from "./vault.js";
import { VaultWatcher } from "./watcher.js";

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
