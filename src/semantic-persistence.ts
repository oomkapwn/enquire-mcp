import * as path from "node:path";
import {
  acquirePersistenceFamilyLease,
  acquirePersistenceFamilyLeaseInScopes,
  type PersistenceFamilyScopes
} from "./persistence-coordination.js";
import { assertEmbedDbFilePath, assertHnswFilePath } from "./persistence-path.js";

/** One coordinated persistence family shared by EmbedDb and its HNSW derivatives. */
export const SEMANTIC_PERSISTENCE_FAMILY_KEY = "embed-hnsw-v1";

/** Coordination family that serializes staged EmbedDb replacement against full-family erasure. */
export const EMBED_REPLACEMENT_STAGE_FAMILY_KEY = "embed-replacement-stage-v1";

const DEFAULT_HNSW_BASENAME_PATTERN = /^[0-9a-f]{12}\.hnsw$/u;
const activeSemanticErasers = new WeakSet<object>();

/**
 * Lexically bounded proof that the EmbedDb/HNSW family eraser is currently held.
 * Objects with this shape are not authority by themselves: consumers also
 * verify the unforgeable live membership maintained by
 * {@link withSemanticPersistenceEraser}.
 */
export interface ActiveSemanticPersistenceEraser {
  /** Exact primary EmbedDb family scopes protected by the active eraser. */
  readonly scopes: PersistenceFamilyScopes;
}

function expectedEmbedTargetName(hnswFile: string): string {
  const hnswName = path.basename(hnswFile);
  return `${hnswName.slice(0, -".hnsw".length)}.embed.db`;
}

/**
 * Resolve the primary default EmbedDb target for a legacy HNSW save call.
 * Custom HNSW basenames require caller-supplied pinned EmbedDb scopes; guessing
 * their authority would silently coordinate an unrelated semantic family.
 *
 * @param hnswFile - Exact default twelve-hex `.hnsw` persistence base.
 * @returns Lexical sibling `.embed.db` target used only for fresh scope acquisition.
 * @throws {TypeError} If the HNSW base is custom or outside the exact namespace.
 */
export function defaultEmbedDbAuthorityForHnsw(hnswFile: string): string {
  assertHnswFilePath(hnswFile);
  if (!DEFAULT_HNSW_BASENAME_PATTERN.test(path.basename(hnswFile))) {
    throw new TypeError("Custom HNSW persistence requires pinned EmbedDb family scopes");
  }
  const target = path.join(path.dirname(hnswFile), expectedEmbedTargetName(hnswFile));
  assertEmbedDbFilePath(target);
  return target;
}

/**
 * Derive the only writable canonical EmbedDb path from acquired family scopes.
 *
 * @param scopes - Pinned semantic-family namespace and target scopes.
 * @returns Canonical primary `.embed.db` target.
 * @throws {TypeError} If the scopes do not identify the semantic family.
 */
export function embedDbPathInSemanticScopes(scopes: PersistenceFamilyScopes): string {
  if (scopes.family.familyKey !== SEMANTIC_PERSISTENCE_FAMILY_KEY) {
    throw new TypeError("Persistence scopes do not identify the EmbedDb/HNSW semantic family");
  }
  const target = path.join(scopes.family.canonicalParent, scopes.family.targetName);
  assertEmbedDbFilePath(target);
  return target;
}

/**
 * Bind an HNSW request to the exact primary EmbedDb basename and canonical
 * parent already pinned by a semantic-family acquisition.
 *
 * @param hnswFile - Requested HNSW base; its parent may be a lexical alias.
 * @param scopes - Pinned primary EmbedDb family scopes.
 * @returns Canonical HNSW persistence base in the pinned parent.
 * @throws {TypeError} If the HNSW stem does not match the primary EmbedDb target.
 */
export function hnswPathInSemanticScopes(hnswFile: string, scopes: PersistenceFamilyScopes): string {
  assertHnswFilePath(hnswFile);
  const embedTarget = embedDbPathInSemanticScopes(scopes);
  if (path.basename(embedTarget) !== expectedEmbedTargetName(hnswFile)) {
    throw new TypeError("HNSW persistence base does not match its pinned EmbedDb authority");
  }
  const canonical = path.join(scopes.family.canonicalParent, path.basename(hnswFile));
  assertHnswFilePath(canonical);
  return canonical;
}

/**
 * Prove that an eraser capability is still live and return its pinned scopes.
 * A retained capability becomes invalid before its underlying lease is
 * released, so asynchronous cleanup cannot accidentally reuse stale authority.
 *
 * @param capability - Capability supplied only inside an active eraser callback.
 * @returns Exact pinned semantic-family scopes.
 * @throws {Error} If the capability is forged, retained, or already inactive.
 */
export function scopesFromActiveSemanticEraser(capability: ActiveSemanticPersistenceEraser): PersistenceFamilyScopes {
  if (typeof capability !== "object" || capability === null || !activeSemanticErasers.has(capability as object)) {
    throw new Error("Semantic persistence eraser capability is not active");
  }
  return capability.scopes;
}

/**
 * Run one destructive EmbedDb/HNSW-family operation while holding its exclusive
 * two-level eraser. The callback receives the only active capability accepted
 * by low-level HNSW erasure; the capability is revoked before release begins.
 *
 * @param targetPath - Primary `.embed.db` target for fresh acquisition.
 * @param pinnedScopes - Existing pinned scopes, or `undefined` for first use.
 * @param operation - Entire destructive family operation.
 * @returns The callback result after the eraser has been released.
 * @throws {AggregateError} If both the operation and exact eraser release fail.
 */
export async function withSemanticPersistenceEraser<T>(
  targetPath: string,
  pinnedScopes: PersistenceFamilyScopes | undefined,
  operation: (capability: ActiveSemanticPersistenceEraser) => Promise<T>
): Promise<T> {
  assertEmbedDbFilePath(targetPath);
  if (pinnedScopes && path.basename(embedDbPathInSemanticScopes(pinnedScopes)) !== path.basename(targetPath)) {
    throw new TypeError("EmbedDb eraser target does not match its pinned semantic-family scopes");
  }
  const lease = pinnedScopes
    ? await acquirePersistenceFamilyLeaseInScopes(pinnedScopes, { role: "eraser" })
    : await acquirePersistenceFamilyLease({
        targetPath,
        familyKey: SEMANTIC_PERSISTENCE_FAMILY_KEY,
        role: "eraser"
      });
  const capability: ActiveSemanticPersistenceEraser = Object.freeze({ scopes: lease.scopes });
  activeSemanticErasers.add(capability);
  let operationResult: T | undefined;
  let operationError: unknown;
  try {
    operationResult = await operation(capability);
  } catch (error) {
    operationError = error;
  }
  activeSemanticErasers.delete(capability);
  let releaseError: unknown;
  try {
    await lease.release();
  } catch (error) {
    releaseError = error;
  }
  if (operationError !== undefined && releaseError !== undefined) {
    throw new AggregateError(
      [operationError, releaseError],
      "Semantic persistence erase failed and eraser release was incomplete"
    );
  }
  if (operationError !== undefined) throw operationError;
  if (releaseError !== undefined) throw releaseError;
  return operationResult as T;
}

async function withEmbedReplacementStageRole<T>(
  targetPath: string,
  role: "publisher" | "eraser",
  operation: () => Promise<T>
): Promise<T> {
  assertEmbedDbFilePath(targetPath);
  const lease = await acquirePersistenceFamilyLease({
    targetPath,
    familyKey: EMBED_REPLACEMENT_STAGE_FAMILY_KEY,
    role
  });
  let operationResult: T | undefined;
  let operationError: unknown;
  try {
    operationResult = await operation();
  } catch (error) {
    operationError = error;
  }
  let releaseError: unknown;
  try {
    await lease.release();
  } catch (error) {
    releaseError = error;
  }
  if (operationError !== undefined && releaseError !== undefined) {
    throw new AggregateError(
      [operationError, releaseError],
      "Embedding replacement stage operation failed and barrier release was incomplete"
    );
  }
  if (operationError !== undefined) throw operationError;
  if (releaseError !== undefined) throw releaseError;
  return operationResult as T;
}

/**
 * Hold the staged-replacement publisher barrier for one complete prepare,
 * promotion, and callback cleanup lifetime.
 *
 * @param targetPath - Final `.embed.db` target whose stage namespace is protected.
 * @param operation - Complete staged replacement operation.
 * @returns The operation result after the exact barrier marker is released.
 * @throws If the barrier conflicts, the operation fails, or exact release is incomplete.
 * @example
 * await withEmbedReplacementStagePublisher(file, async () => buildAndPromoteReplacement());
 * @internal
 */
export async function withEmbedReplacementStagePublisher<T>(
  targetPath: string,
  operation: () => Promise<T>
): Promise<T> {
  return withEmbedReplacementStageRole(targetPath, "publisher", operation);
}

/**
 * Hold the staged-replacement eraser barrier across a complete EmbedDb/HNSW
 * family clear. Acquiring this barrier before the semantic-family eraser gives
 * replacement and clear one consistent lock order.
 *
 * @param targetPath - Final `.embed.db` target whose stage namespace is protected.
 * @param operation - Complete destructive family operation.
 * @returns The operation result after the exact barrier marker is released.
 * @throws If an active replacement conflicts, the operation fails, or exact release is incomplete.
 * @example
 * await withEmbedReplacementStageEraser(file, async () => clearSemanticFamily());
 * @internal
 */
export async function withEmbedReplacementStageEraser<T>(targetPath: string, operation: () => Promise<T>): Promise<T> {
  return withEmbedReplacementStageRole(targetPath, "eraser", operation);
}
