import { promises as fs } from "node:fs";
import * as path from "node:path";

/**
 * The one rule every erasure receipt in this product answers to.
 *
 * AH-5 established it for the two SQLite families: only `ENOENT` is idempotent
 * success, every other failure names the artifact it could not remove, and a
 * successful `unlink` is believed only once the entry is re-statted absent —
 * so no command can print "removed" for a file that is still on disk. The
 * post-merge re-sweep then found the rule applied to the loop AH-5 was pointed
 * at and not to the erasers delegated one line below it (the HNSW family, the
 * staged temps, the watcher guard, the parse cache and `prune`), all of which
 * feed the SAME `removed` boolean. This leaf exists so the rule has one
 * implementation instead of six, and so a new eraser inherits it by
 * construction; `tests/erasure-invariant.test.ts` fails CI on a receipt-path
 * function that unlinks without it.
 *
 * Paths are reported by BASENAME only: an erasure error can reach an MCP client
 * through a tool response, and the absolute vault/cache path is exactly what
 * the abs-path-leak class forbids exposing.
 *
 * @module
 */

function errnoCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null || !("code" in err)) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/** The canonical failure when a removal could not be attempted or completed. */
export function artifactRemovalError(label: string, target: string, cause: unknown): Error {
  return new Error(`Unable to remove ${label}: ${path.basename(target)}`, { cause });
}

/**
 * Prove an entry is gone after a removal that reported success.
 *
 * @param target - Absolute path just removed.
 * @param label - Human-readable artifact class, used verbatim in the message.
 * @throws If the entry is still present, or if its absence cannot be established.
 * @example
 * await fs.unlink(file);
 * await assertArtifactAbsent(file, "FTS index artifact");
 */
export async function assertArtifactAbsent(target: string, label: string): Promise<void> {
  try {
    await fs.lstat(target);
  } catch (err) {
    if (errnoCode(err) === "ENOENT") return;
    throw new Error(`Unable to confirm removal of ${label}: ${path.basename(target)}`, { cause: err });
  }
  throw new Error(`${label} still present after removal: ${path.basename(target)}`);
}

/**
 * Remove one file and return whether it existed, under the receipt rule.
 *
 * @param target - Absolute path to remove.
 * @param label - Human-readable artifact class for any failure message.
 * @returns `true` when an entry was removed, `false` when it was already absent.
 * @throws If the removal fails for any reason other than `ENOENT`, or if the
 *   entry survives a removal that reported success.
 * @example
 * const removed = await removeArtifact(sidecar, "HNSW artifact");
 */
export async function removeArtifact(target: string, label: string): Promise<boolean> {
  try {
    await fs.unlink(target);
  } catch (err) {
    if (errnoCode(err) === "ENOENT") return false;
    throw artifactRemovalError(label, target, err);
  }
  await assertArtifactAbsent(target, label);
  return true;
}

/**
 * Remove one directory entry under the same rule as {@link removeArtifact}.
 *
 * @param target - Absolute directory path to remove.
 * @param label - Human-readable artifact class for any failure message.
 * @returns `true` when a directory was removed, `false` when already absent.
 * @throws If the removal fails for any reason other than `ENOENT`, or if the
 *   directory survives a removal that reported success.
 * @example
 * await removeArtifactDirectory(guardPath, "watcher activation guard directory");
 */
export async function removeArtifactDirectory(target: string, label: string): Promise<boolean> {
  try {
    await fs.rmdir(target);
  } catch (err) {
    if (errnoCode(err) === "ENOENT") return false;
    throw artifactRemovalError(label, target, err);
  }
  await assertArtifactAbsent(target, label);
  return true;
}
