import { promises as fs } from "node:fs";
import * as path from "node:path";
import { removeArtifact } from "./erasure-receipt.js";
import { planCachePruneOnDisk } from "./fts5.js";
import { acquirePersistenceNamespaceEraser } from "./persistence-coordination.js";
import { PersistenceLeaseIntegrityError, revalidatePersistenceLeaseScope } from "./persistence-lease.js";
import { removeSensitiveArtifactTempEntry, sensitiveArtifactFinalBasename } from "./sensitive-artifact.js";

/** Maximum number of cache-parent entries admitted into one prune snapshot. */
export const MAX_CACHE_PRUNE_ENTRIES = 4_096;

/** Result of one namespace-exclusive destructive cache prune. */
export interface CachePruneExecutionResult {
  /** Exact preflighted basenames selected under non-kept routing stems. */
  readonly removable: readonly string[];
  /** Number of artifacts removed after the pinned-scope checks. */
  readonly removed: number;
  /** Best-effort byte total observed before removal. */
  readonly bytes: number;
}

/** Read-only result of one bounded cache-prune preview. */
export interface CachePrunePreviewResult {
  /** Exact preflighted basenames selected under non-kept routing stems. */
  readonly removable: readonly string[];
  /** Best-effort byte total observed without creating lease state. */
  readonly bytes: number;
}

async function readBoundedCacheDirectory(directory: string): Promise<string[]> {
  const opened = await fs.opendir(directory);
  const entries: string[] = [];
  try {
    while (true) {
      const entry = await opened.read();
      if (entry === null) return entries;
      if (entries.length >= MAX_CACHE_PRUNE_ENTRIES) {
        throw new Error(`Refusing cache prune: directory exceeds ${MAX_CACHE_PRUNE_ENTRIES} entries`);
      }
      entries.push(entry.name);
    }
  } finally {
    await opened.close();
  }
}

async function bestEffortBytes(directory: string, removable: readonly string[]): Promise<number> {
  let bytes = 0;
  for (const name of removable) {
    try {
      bytes += (await fs.lstat(path.join(directory, name))).size;
    } catch {
      // Reporting is best-effort; destructive authority is checked separately.
    }
  }
  return bytes;
}

/**
 * Produce a read-only prune preview through the same bounded complete directory
 * census used by destructive execution. It creates no lease namespace.
 *
 * @param cacheDir - Existing cache parent to inspect without mutation.
 * @param keepHash - Exact 12-hex routing stem whose artifacts must remain.
 * @returns Selected basenames and their best-effort byte total.
 * @example
 * const preview = await previewCachePrune("/tmp/enquire", "aaaaaaaaaaaa");
 */
export async function previewCachePrune(cacheDir: string, keepHash: string): Promise<CachePrunePreviewResult> {
  const canonicalDir = await fs.realpath(cacheDir);
  const entries = await readBoundedCacheDirectory(canonicalDir);
  const removable = await planCachePruneOnDisk(canonicalDir, entries, keepHash);
  const bytes = await bestEffortBytes(canonicalDir, removable);
  return { removable, bytes };
}

/**
 * Execute destructive cross-stem cache pruning under one parent-wide eraser.
 * The pinned namespace scope is revalidated before and after inventory, plan,
 * and every canonical deletion, rejecting parent replacements observed at
 * those boundaries. Node path APIs cannot make each check and deletion
 * dirfd-relative or indivisible against active same-account tampering.
 *
 * @param cacheDir - Existing cache parent containing reserved artifacts.
 * @param keepHash - Exact 12-hex routing stem whose artifacts must remain.
 * @returns Removed count, selected basenames, and best-effort byte total.
 * @throws {PersistenceLeaseIntegrityError} If the pinned namespace path changes.
 * @example
 * const result = await executeCachePrune("/tmp/enquire", "aaaaaaaaaaaa");
 */
export async function executeCachePrune(cacheDir: string, keepHash: string): Promise<CachePruneExecutionResult> {
  const eraser = await acquirePersistenceNamespaceEraser({ parentPath: cacheDir });
  const canonicalDir = eraser.scope.canonicalParent;
  let failed = false;
  let failure: unknown;
  let result: CachePruneExecutionResult | undefined;
  try {
    await revalidatePersistenceLeaseScope(eraser.scope);
    const entries = await readBoundedCacheDirectory(canonicalDir);
    await revalidatePersistenceLeaseScope(eraser.scope);
    const removable = await planCachePruneOnDisk(canonicalDir, entries, keepHash);
    await revalidatePersistenceLeaseScope(eraser.scope);

    const bytes = await bestEffortBytes(canonicalDir, removable);

    let removed = 0;
    for (const name of removable) {
      await revalidatePersistenceLeaseScope(eraser.scope);
      try {
        const target = path.join(canonicalDir, name);
        if (sensitiveArtifactFinalBasename(name)) {
          const removedGenerated = await removeSensitiveArtifactTempEntry(target);
          if (!removedGenerated) throw new Error("artifact changed after prune preflight");
        } else {
          await removeArtifact(target, "preflighted cache artifact");
        }
      } catch (error) {
        throw new Error(`Unable to remove a preflighted cache artifact: ${name}`, { cause: error });
      }
      await revalidatePersistenceLeaseScope(eraser.scope);
      removed += 1;
    }
    await revalidatePersistenceLeaseScope(eraser.scope);
    result = { removable, removed, bytes };
  } catch (error) {
    failed = true;
    failure = error;
  }

  try {
    await eraser.release();
  } catch (releaseError) {
    if (failed) {
      throw new AggregateError([failure, releaseError], "Cache prune failed and namespace release was incomplete");
    }
    throw releaseError;
  }
  if (failed) throw failure;
  if (result === undefined) throw new PersistenceLeaseIntegrityError("Cache prune did not reach a terminal result");
  return result;
}
