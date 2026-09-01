// Bulk embedding-index synchronization.
//
// v3.12.0-rc.20 — extracted from server.ts so the fail-soft production
// behavior and the strict evidence path share one directly testable
// implementation. Normal CLI callers remain fail-soft by default; benchmark
// callers opt into strict mode so an incomplete index can never become a
// headline-shaped artifact.

import type { EmbedDb, EmbedKindAudit, EmbedSyncReport } from "./embed-db.js";
import { embedSingleNote, embedSinglePdf } from "./embed-pipeline.js";
import type { loadEmbedder } from "./embeddings.js";
import { type FileEntry, MAX_INDEX_SYNC_FILES, MAX_INDEX_SYNC_VISITED_ENTRIES, type Vault } from "./vault.js";

/** Failure posture for a bulk embedding synchronization. */
export type EmbedSyncMode = "fail-soft" | "strict" | "replacement";

/** Options shared by Markdown and PDF bulk embedding synchronization. */
export interface EmbedSyncOptions {
  /** Neighbor context prepended/appended to each embedded chunk. */
  lateChunkContext?: number;
  /**
   * `"fail-soft"` keeps normal user builds moving past a bad file.
   * `"strict"` aborts on the first failed/empty file and rejects any final
   * database-integrity mismatch. `"replacement"` provides the same audited,
   * fail-fast error posture for a staged replacement database while accepting
   * legitimately empty source files as accounted inputs. Defaults to
   * `"fail-soft"`.
   */
  mode?: EmbedSyncMode;
}

/**
 * Evidence-bearing superset of the historical sync counters.
 *
 * The five {@link EmbedSyncReport} fields retain their original meanings.
 * New fields distinguish live input files, processed files, expected chunk
 * declarations, physical rows, and integrity mismatches so callers never
 * need to infer completeness from `added + unchanged`.
 */
export interface EmbedSyncEvidence extends EmbedSyncReport, EmbedKindAudit {
  /** Failure posture used for this run. */
  mode: EmbedSyncMode;
  /** Whether the expensive physical-row/vector audit and manifest were computed. */
  audited: boolean;
  /** Live source files presented to this sync. */
  total_files: number;
  /** Source files whose loop iteration completed. */
  processed_files: number;
  /** Files with no embeddable chunks. */
  empty: number;
  /** Files whose read/chunk/embed/upsert path threw. */
  failed: number;
  /** Physical rows whose decoded vector is non-finite, zero, or materially non-unit. */
  invalid_vectors: number;
  /** SHA-256 over exact kind-scoped source-state and embedding payload, or null when unaudited. */
  manifest_sha256: string | null;
  /** Derived completeness verdict over counters plus physical DB audit. */
  complete: boolean;
}

/** Audited-sync failure carrying the final audit when one was available. */
export class EmbedSyncIncompleteError extends Error {
  /** Evidence snapshot for a final integrity mismatch; null on fail-fast file errors. */
  readonly report: EmbedSyncEvidence | null;

  /**
   * @param message Human-readable audited-sync failure.
   * @param report Final evidence snapshot when the sync reached its audit.
   * @param cause Original per-file failure for fail-fast errors.
   */
  constructor(message: string, report: EmbedSyncEvidence | null = null, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "EmbedSyncIncompleteError";
    this.report = report;
  }
}

async function completeIndexInventory(
  vault: Vault,
  extension: ".md" | ".pdf",
  label: "Markdown" | "PDF"
): Promise<FileEntry[]> {
  const listing = await vault.listFilesByExtensionsBounded(
    [extension],
    MAX_INDEX_SYNC_FILES,
    MAX_INDEX_SYNC_VISITED_ENTRIES
  );
  if (!listing.complete) {
    throw new EmbedSyncIncompleteError(
      `Embed ${label} source inventory is incomplete within ${MAX_INDEX_SYNC_FILES} files / ${MAX_INDEX_SYNC_VISITED_ENTRIES} visited entries; refusing to infer deletions`
    );
  }
  return listing.entries;
}

/** Raw per-file counters consumed by {@link finalizeEmbedSyncEvidence}. */
export interface EmbedSyncCounters {
  /** Files newly indexed. */
  added: number;
  /** Existing files re-indexed after an mtime change. */
  updated: number;
  /** Previously indexed files removed because they are no longer live. */
  deleted: number;
  /** Live files reused from an unchanged source-state row. */
  unchanged: number;
  /** Live source files presented to the sync. */
  totalFiles: number;
  /** Source-file iterations completed before the final audit. */
  processedFiles: number;
  /** Source files that produced no embeddable chunks. */
  empty: number;
  /** Source files whose read/chunk/embed/upsert path threw. */
  failed: number;
}

/** Expensive physical evidence computed only for audited synchronization. */
export interface EmbedSyncIntegrity {
  /** Whether all physical checks in this structure actually ran. */
  audited: boolean;
  /** Numerically invalid stored vectors. */
  invalidVectors: number;
  /** Exact ordered physical-row digest. */
  manifestSha256: string | null;
}

/**
 * Combine loop counters with a physical, kind-scoped database audit.
 *
 * Completeness is derived from the raw equations; the caller cannot forge it
 * by supplying a boolean. Exported for the benchmark status guard and direct
 * positive/negative-control tests.
 *
 * @param mode Failure posture used for the synchronization.
 * @param counters Raw loop and source-file counters.
 * @param audit Kind-scoped physical database audit.
 * @param totalChunks Total rows across the embedding database.
 * @param integrity Numerical audit and exact physical-row manifest.
 * @returns Evidence with a completeness verdict derived from the raw values.
 * @example
 * const evidence = finalizeEmbedSyncEvidence("strict", counters, audit, db.totalChunks(), integrity);
 * if (!evidence.complete) throw new Error("embedding index is incomplete");
 */
export function finalizeEmbedSyncEvidence(
  mode: EmbedSyncMode,
  counters: EmbedSyncCounters,
  audit: EmbedKindAudit,
  totalChunks: number,
  integrity: EmbedSyncIntegrity
): EmbedSyncEvidence {
  const rawCounts = [
    counters.added,
    counters.updated,
    counters.deleted,
    counters.unchanged,
    counters.totalFiles,
    counters.processedFiles,
    counters.empty,
    counters.failed,
    audit.indexed_files,
    audit.declared_chunks,
    audit.indexed_chunks,
    audit.mismatched_files,
    integrity.invalidVectors,
    totalChunks
  ];
  const rawCountsValid = rawCounts.every((value) => Number.isSafeInteger(value) && value >= 0);
  const accountedFiles = counters.added + counters.updated + counters.unchanged + counters.empty + counters.failed;
  const auditedMode = mode === "strict" || mode === "replacement";
  const sourceCoverageComplete =
    mode === "replacement"
      ? audit.indexed_files === counters.totalFiles - counters.empty &&
        (audit.indexed_chunks > 0 || counters.empty === counters.totalFiles)
      : counters.empty === 0 &&
        audit.indexed_files === counters.totalFiles &&
        (counters.totalFiles === 0 || audit.indexed_chunks > 0);
  const complete =
    auditedMode &&
    integrity.audited &&
    rawCountsValid &&
    typeof integrity.manifestSha256 === "string" &&
    /^[0-9a-f]{64}$/.test(integrity.manifestSha256) &&
    counters.processedFiles === counters.totalFiles &&
    accountedFiles === counters.totalFiles &&
    counters.failed === 0 &&
    sourceCoverageComplete &&
    audit.declared_chunks === audit.indexed_chunks &&
    audit.mismatched_files === 0 &&
    integrity.invalidVectors === 0;
  return {
    mode,
    audited: integrity.audited,
    added: counters.added,
    updated: counters.updated,
    deleted: counters.deleted,
    unchanged: counters.unchanged,
    total_chunks: totalChunks,
    total_files: counters.totalFiles,
    processed_files: counters.processedFiles,
    empty: counters.empty,
    failed: counters.failed,
    ...audit,
    invalid_vectors: integrity.invalidVectors,
    manifest_sha256: integrity.manifestSha256,
    complete
  };
}

function failFastFileFailure(
  mode: EmbedSyncMode,
  kind: "Markdown" | "PDF",
  relPath: string,
  reason: string,
  cause?: unknown
): void {
  if (mode === "fail-soft") return;
  throw new EmbedSyncIncompleteError(`${mode} ${kind} embed sync rejected ${relPath}: ${reason}`, null, cause);
}

function enforceFinalCompleteness(report: EmbedSyncEvidence, kind: "Markdown" | "PDF"): EmbedSyncEvidence {
  if (report.mode !== "fail-soft" && !report.complete) {
    throw new EmbedSyncIncompleteError(
      `${report.mode} ${kind} embed sync incomplete: ${report.indexed_files}/${report.total_files} files, ` +
        `${report.indexed_chunks}/${report.declared_chunks} chunks, ${report.mismatched_files} mismatched, ` +
        `${report.invalid_vectors} invalid vectors`,
      report
    );
  }
  return report;
}

/**
 * Incrementally synchronize Markdown notes into an {@link EmbedDb}.
 *
 * Default mode preserves the historical fail-soft CLI behavior: a bad note is
 * logged and the remaining notes continue. Strict mode is for evidence-grade
 * callers and aborts before they can write a result artifact, including for
 * an empty note. Replacement mode is for a staged database: it retains the
 * same physical evidence and error fail-fast guarantees but accounts for
 * legitimately empty notes without indexing them.
 *
 * @param vault Vault whose Markdown notes are synchronized.
 * @param db Persistent embedding database to update.
 * @param embedder Loaded local embedding model.
 * @param opts Context and failure-posture options.
 * @returns Raw counters. Strict and replacement modes add the physical/vector
 *   audit and exact manifest; fail-soft mode returns explicit unaudited
 *   placeholders so normal startup does not add an O(all embedding rows) scan.
 * @example
 * const evidence = await syncEmbedDb(vault, db, embedder, { mode: "strict" });
 * if (!evidence.complete) throw new Error("unexpected incomplete strict sync");
 */
export async function syncEmbedDb(
  vault: Vault,
  db: EmbedDb,
  embedder: Awaited<ReturnType<typeof loadEmbedder>>,
  opts: EmbedSyncOptions = {}
): Promise<EmbedSyncEvidence> {
  const contextChars = opts.lateChunkContext ?? 0;
  const mode = opts.mode ?? "fail-soft";
  const entries = await completeIndexInventory(vault, ".md", "Markdown");
  const known = new Map<string, number>();
  // Scope to kind="md" so markdown sync cannot delete PDF rows.
  for (const state of db.getSourceStates("md")) known.set(state.rel_path, state.mtime_ms);
  const quarantined = new Set(db.getQuarantinedPaths("md"));

  const live = new Set<string>();
  let added = 0;
  let updated = 0;
  let unchanged = 0;
  let empty = 0;
  let failed = 0;
  const totalToProcess = entries.length;
  const logEvery = Math.max(1, Math.floor(totalToProcess / 20));
  let processed = 0;
  const startMs = Date.now();

  for (const entry of entries) {
    live.add(entry.relPath);
    const prevMtime = known.get(entry.relPath);
    if (!quarantined.has(entry.relPath) && prevMtime !== undefined && prevMtime === entry.mtimeMs) {
      unchanged += 1;
      processed += 1;
      continue;
    }
    try {
      const result = await embedSingleNote(vault, embedder, entry, { lateChunkContext: contextChars });
      if (result === null) {
        empty += 1;
        processed += 1;
        if (mode === "strict") {
          db.quarantineSource(entry.relPath, "md");
          failFastFileFailure(mode, "Markdown", entry.relPath, "note has no embeddable chunks");
        }
        db.deleteNote(entry.relPath);
        continue;
      }
      if (result.chunks >= 30) {
        process.stderr.write(
          `enquire: ${entry.relPath} → ${result.chunks} chunks (this one will be slow; consider splitting the note)\n`
        );
      }
      db.upsertNote(entry.relPath, entry.mtimeMs, result.rows);
      if (prevMtime === undefined) added += 1;
      else updated += 1;
    } catch (err) {
      if (err instanceof EmbedSyncIncompleteError) throw err;
      failed += 1;
      const detail = err instanceof Error ? err.message : String(err);
      process.stderr.write(`enquire: skipping ${entry.relPath} during embed sync — ${detail}\n`);
      db.quarantineSource(entry.relPath, "md");
      failFastFileFailure(mode, "Markdown", entry.relPath, detail, err);
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

  let deleted = 0;
  for (const relPath of known.keys()) {
    if (!live.has(relPath)) {
      db.deleteNote(relPath);
      deleted += 1;
    }
  }
  for (const relPath of quarantined) {
    if (!live.has(relPath) && !known.has(relPath)) db.deleteNote(relPath);
  }

  return enforceFinalCompleteness(
    finalizeEmbedSyncEvidence(
      mode,
      {
        added,
        updated,
        deleted,
        unchanged,
        totalFiles: totalToProcess,
        processedFiles: processed,
        empty,
        failed
      },
      mode !== "fail-soft"
        ? db.auditKind("md")
        : { indexed_files: 0, declared_chunks: 0, indexed_chunks: 0, mismatched_files: 0 },
      db.totalChunks(),
      mode !== "fail-soft"
        ? {
            audited: true,
            invalidVectors: db.auditVectorHealth("md").invalid_vectors,
            manifestSha256: db.fingerprintKind("md")
          }
        : { audited: false, invalidVectors: 0, manifestSha256: null }
    ),
    "Markdown"
  );
}

/**
 * Incrementally synchronize PDFs into an {@link EmbedDb}.
 *
 * Image-only PDFs count as `empty`; ordinary callers remain fail-soft, strict
 * callers reject them, and replacement callers account for them without
 * weakening the final physical audit.
 *
 * @param vault Vault whose PDF files are synchronized.
 * @param db Persistent embedding database to update.
 * @param embedder Loaded local embedding model.
 * @param opts Context and failure-posture options.
 * @returns Raw counters. Strict and replacement modes add the PDF-scoped
 *   physical/vector audit and manifest; fail-soft mode returns explicit
 *   unaudited placeholders.
 * @example
 * const evidence = await syncPdfEmbedDb(vault, db, embedder, { mode: "strict" });
 * console.log(evidence.indexed_files, evidence.indexed_chunks);
 */
export async function syncPdfEmbedDb(
  vault: Vault,
  db: EmbedDb,
  embedder: Awaited<ReturnType<typeof loadEmbedder>>,
  opts: EmbedSyncOptions = {}
): Promise<EmbedSyncEvidence> {
  const contextChars = opts.lateChunkContext ?? 0;
  const mode = opts.mode ?? "fail-soft";
  const entries = await completeIndexInventory(vault, ".pdf", "PDF");
  const known = new Map<string, number>();
  for (const state of db.getSourceStates("pdf")) known.set(state.rel_path, state.mtime_ms);
  const quarantined = new Set(db.getQuarantinedPaths("pdf"));

  const live = new Set<string>();
  let added = 0;
  let updated = 0;
  let unchanged = 0;
  let empty = 0;
  let failed = 0;
  const totalToProcess = entries.length;
  const logEvery = Math.max(1, Math.floor(totalToProcess / 20));
  let processed = 0;
  const startMs = Date.now();

  for (const entry of entries) {
    live.add(entry.relPath);
    const prevMtime = known.get(entry.relPath);
    if (!quarantined.has(entry.relPath) && prevMtime !== undefined && prevMtime === entry.mtimeMs) {
      unchanged += 1;
      processed += 1;
      continue;
    }
    try {
      const result = await embedSinglePdf(vault, embedder, entry, { lateChunkContext: contextChars });
      if (result === null) {
        empty += 1;
        processed += 1;
        if (mode === "strict") {
          db.quarantineSource(entry.relPath, "pdf");
          failFastFileFailure(mode, "PDF", entry.relPath, "PDF is image-only, scanned, or empty");
        }
        // A prior failed attempt may have left only a durable quarantine
        // marker (no source_state/embedding rows). A successful empty result
        // is still authoritative and must clear that marker idempotently, or
        // every later sync would retry the same healthy image-only PDF.
        db.deleteNote(entry.relPath);
        if (prevMtime !== undefined) {
          process.stderr.write(
            `enquire: dropping stale embed rows for ${entry.relPath} — PDF is now image-only / scanned (or empty after extraction)\n`
          );
        } else {
          process.stderr.write(`enquire: skipping ${entry.relPath} during pdf-embed sync — image-only / scanned\n`);
        }
        continue;
      }
      db.upsertNote(entry.relPath, entry.mtimeMs, result.rows, "pdf");
      if (prevMtime === undefined) added += 1;
      else updated += 1;
    } catch (err) {
      if (err instanceof EmbedSyncIncompleteError) throw err;
      failed += 1;
      const detail = err instanceof Error ? err.message : String(err);
      process.stderr.write(`enquire: skipping ${entry.relPath} during pdf-embed sync — ${detail}\n`);
      db.quarantineSource(entry.relPath, "pdf");
      failFastFileFailure(mode, "PDF", entry.relPath, detail, err);
    }
    processed += 1;
    if (processed % logEvery === 0 || processed === totalToProcess) {
      const elapsed = (Date.now() - startMs) / 1000;
      const rate = processed / elapsed;
      const skipped = empty + failed;
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
  for (const relPath of quarantined) {
    if (!live.has(relPath) && !known.has(relPath)) db.deleteNote(relPath);
  }

  return enforceFinalCompleteness(
    finalizeEmbedSyncEvidence(
      mode,
      {
        added,
        updated,
        deleted,
        unchanged,
        totalFiles: totalToProcess,
        processedFiles: processed,
        empty,
        failed
      },
      mode !== "fail-soft"
        ? db.auditKind("pdf")
        : { indexed_files: 0, declared_chunks: 0, indexed_chunks: 0, mismatched_files: 0 },
      db.totalChunks(),
      mode !== "fail-soft"
        ? {
            audited: true,
            invalidVectors: db.auditVectorHealth("pdf").invalid_vectors,
            manifestSha256: db.fingerprintKind("pdf")
          }
        : { audited: false, invalidVectors: 0, manifestSha256: null }
    ),
    "PDF"
  );
}
