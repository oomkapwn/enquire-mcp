import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  acquirePersistenceLeaseInScope,
  composePersistenceLeaseDebtOwners,
  inspectPersistenceLeases,
  type PersistenceLeaseDebtOwner,
  type PersistenceLeaseHandle,
  type PersistenceLeaseInspectableMarker,
  type PersistenceLeaseInspection,
  PersistenceLeaseIntegrityError,
  PersistenceLeaseOwnershipError,
  type PersistenceLeaseRole,
  type PersistenceLeaseScope,
  type PersistenceLeaseTarget,
  recoverPersistenceLease,
  resolvePersistenceLeaseScope,
  retainPersistenceLeaseOwnershipError,
  revalidatePersistenceLeaseScope
} from "./persistence-lease.js";

const NAMESPACE_TARGET_BASENAME = ".enquire-mcp-persistence-namespace";
const NAMESPACE_FAMILY_KEY = "namespace-v1";

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const { code } = error as { code?: unknown };
  return typeof code === "string" ? code : undefined;
}

function assertPersistenceFamilyRole(role: unknown): asserts role is PersistenceLeaseRole {
  if (role !== "shared" && role !== "publisher" && role !== "eraser") {
    throw new TypeError("Persistence family role must be shared, publisher, or eraser");
  }
}

/** Bounded acquisition timing shared by both levels of a composite lease. */
export interface PersistenceCoordinationTiming {
  /** Maximum wait for a short acquisition gate at either level. */
  readonly gateTimeoutMs?: number;
  /** Poll interval while a short acquisition gate is held. */
  readonly gatePollMs?: number;
}

/** Pinned namespace and family scopes for one persistence target. */
export interface PersistenceFamilyScopes {
  /** Parent-wide scope shared by every coordinated family in that parent. */
  readonly namespace: PersistenceLeaseScope;
  /** Target basename and semantic-family-specific scope. */
  readonly family: PersistenceLeaseScope;
}

/** Options for a fresh two-level family lease acquisition. */
export interface AcquirePersistenceFamilyLeaseOptions extends PersistenceLeaseTarget, PersistenceCoordinationTiming {
  /** Inner family role; the outer namespace role is always `shared`. */
  readonly role: PersistenceLeaseRole;
}

/** Options for a two-level acquisition through previously pinned scopes. */
export interface AcquirePersistenceFamilyLeaseInScopesOptions extends PersistenceCoordinationTiming {
  /** Inner family role; the outer namespace role is always `shared`. */
  readonly role: PersistenceLeaseRole;
}

/** Options for a parent-wide destructive namespace lease. */
export interface AcquirePersistenceNamespaceEraserOptions extends PersistenceCoordinationTiming {
  /** Existing persistence parent whose coordinated families must be quiescent. */
  readonly parentPath: string;
}

/** Options for explicit recovery of one inspected parent-wide namespace orphan. */
export interface RecoverPersistenceNamespaceLeaseOptions extends PersistenceCoordinationTiming {
  /** Existing persistence parent whose fixed namespace was inspected. */
  readonly parentPath: string;
  /** Exact marker ID returned by {@link inspectPersistenceNamespaceLeases}. */
  readonly markerId: string;
  /**
   * Caller-owned proof that every participant using this persistence parent is
   * quiescent. Recovery proceeds only when the awaited predicate returns true.
   */
  readonly assertQuiescent: Parameters<typeof recoverPersistenceLease>[0]["assertQuiescent"];
}

/** Two-level handle acquired in namespace-then-family order. */
export interface PersistenceFamilyLeaseHandle {
  /** Exact pinned scopes used by later publishers and family operations. */
  readonly scopes: PersistenceFamilyScopes;
  /** Inner family role held by this handle. */
  readonly role: PersistenceLeaseRole;
  /** Exact outer namespace-shared marker. */
  readonly namespaceLease: PersistenceLeaseHandle;
  /** Exact inner family marker. */
  readonly familyLease: PersistenceLeaseHandle;
  /**
   * Release the family marker before the namespace marker.
   *
   * @returns A retryable promise that settles after both exact releases.
   */
  release(): Promise<void>;
}

function namespaceTarget(parentPath: string): PersistenceLeaseTarget {
  if (typeof parentPath !== "string" || parentPath.length === 0 || parentPath.includes("\0")) {
    throw new TypeError("Persistence namespace parent must be a non-empty filesystem path");
  }
  return {
    targetPath: path.join(path.resolve(parentPath), NAMESPACE_TARGET_BASENAME),
    familyKey: NAMESPACE_FAMILY_KEY
  };
}

function timingOptions(timing: PersistenceCoordinationTiming): PersistenceCoordinationTiming {
  return {
    ...(timing.gateTimeoutMs === undefined ? {} : { gateTimeoutMs: timing.gateTimeoutMs }),
    ...(timing.gatePollMs === undefined ? {} : { gatePollMs: timing.gatePollMs })
  };
}

function sameParentIdentity(left: PersistenceLeaseScope, right: PersistenceLeaseScope): boolean {
  return (
    left.canonicalParent === right.canonicalParent &&
    left.parentIdentity.dev === right.parentIdentity.dev &&
    left.parentIdentity.ino === right.parentIdentity.ino
  );
}

async function assertFamilyScopes(scopes: PersistenceFamilyScopes): Promise<void> {
  await revalidatePersistenceLeaseScope(scopes.namespace);
  await revalidatePersistenceLeaseScope(scopes.family);
  if (
    scopes.namespace.targetName !== NAMESPACE_TARGET_BASENAME ||
    scopes.namespace.familyKey !== NAMESPACE_FAMILY_KEY ||
    !sameParentIdentity(scopes.namespace, scopes.family)
  ) {
    throw new PersistenceLeaseIntegrityError("Persistence family scopes do not share the fixed namespace authority");
  }
}

function compositeHandle(
  role: PersistenceLeaseRole,
  namespaceLease: PersistenceLeaseHandle,
  familyLease: PersistenceLeaseHandle
): PersistenceFamilyLeaseHandle {
  let familyReleased = false;
  let namespaceReleased = false;
  let releasePromise: Promise<void> | undefined;
  let handle: PersistenceFamilyLeaseHandle;
  const release = async (): Promise<void> => {
    if (!familyReleased) {
      await familyLease.release();
      familyReleased = true;
    }
    if (!namespaceReleased) {
      await namespaceLease.release();
      namespaceReleased = true;
    }
  };
  handle = {
    scopes: { namespace: namespaceLease.scope, family: familyLease.scope },
    role,
    namespaceLease,
    familyLease,
    release: () => {
      if (releasePromise === undefined) {
        const attempt = release().catch((error: unknown) => {
          const owners: PersistenceLeaseDebtOwner[] = [];
          const message =
            error instanceof Error
              ? error.message
              : "Persistence family release retained exact inner-to-namespace ownership debt";
          if (error instanceof PersistenceLeaseOwnershipError) owners.push(error.debtOwner);
          if (!familyReleased && !namespaceReleased) {
            owners.push({
              artifacts: [{ scope: namespaceLease.scope, marker: namespaceLease.marker }],
              release: async () => handle.release()
            });
          }
          if (owners.length === 0) throw error;
          throw retainPersistenceLeaseOwnershipError(
            new PersistenceLeaseOwnershipError(message, [error], composePersistenceLeaseDebtOwners(owners))
          );
        });
        releasePromise = attempt;
        void attempt.then(
          () => undefined,
          () => {
            if ((!familyReleased || !namespaceReleased) && releasePromise === attempt) releasePromise = undefined;
          }
        );
      }
      return releasePromise;
    }
  };
  return handle;
}

function leaseDebtOwner(lease: PersistenceLeaseHandle): PersistenceLeaseDebtOwner {
  return {
    artifacts: [{ scope: lease.scope, marker: lease.marker }],
    release: async () => lease.release()
  };
}

/**
 * Resolve the one fixed parent-wide namespace scope without creating it.
 * Its identity depends only on the canonical parent and reserved key/path.
 *
 * @param parentPath - Existing persistence parent or a lexical alias to it.
 * @returns Canonical parent-wide namespace scope.
 * @throws {PersistenceLeaseIntegrityError} If the parent or reserved target is unsafe.
 * @example
 * const scope = await resolvePersistenceNamespaceLeaseScope("/tmp/enquire");
 */
export async function resolvePersistenceNamespaceLeaseScope(parentPath: string): Promise<PersistenceLeaseScope> {
  return resolvePersistenceLeaseScope(namespaceTarget(parentPath));
}

/**
 * Inspect the fixed parent-wide namespace without acquiring or recovering it.
 *
 * @param parentPath - Existing persistence parent to inspect.
 * @returns Current namespace gate, leases, and recoverable candidates.
 * @example
 * const state = await inspectPersistenceNamespaceLeases("/tmp/enquire");
 */
export async function inspectPersistenceNamespaceLeases(parentPath: string): Promise<PersistenceLeaseInspection> {
  return inspectPersistenceLeases(namespaceTarget(parentPath));
}

/**
 * Recover one explicitly inspected orphan from the fixed parent-wide
 * namespace. This is an operator-only wrapper over the same exact-host,
 * proven-dead, unchanged-marker, and awaited-quiescence checks as family
 * recovery; it never runs during acquisition and never steals by age.
 *
 * @param options - Exact namespace parent/marker plus caller-owned quiescence proof.
 * @returns Metadata for the one exact namespace marker removed.
 * @throws {PersistenceLeaseIntegrityError} If the namespace or marker changed.
 * @example
 * await recoverPersistenceNamespaceLease({
 *   parentPath: "/tmp/enquire",
 *   markerId: snapshot.leases[0]?.id ?? "",
 *   assertQuiescent: async (context) => independentlyVerifyQuiescence(context.scope)
 * });
 */
export async function recoverPersistenceNamespaceLease(
  options: RecoverPersistenceNamespaceLeaseOptions
): Promise<PersistenceLeaseInspectableMarker> {
  return recoverPersistenceLease({
    ...namespaceTarget(options.parentPath),
    markerId: options.markerId,
    assertQuiescent: options.assertQuiescent,
    ...timingOptions(options)
  });
}

/**
 * Acquire a coordinated family role in strict namespace-then-family order.
 * A failed inner acquisition exactly rolls back the outer shared marker before
 * the error is returned.
 *
 * @param options - Persistence target, inner role, and bounded gate timing.
 * @returns Pinned two-level handle released in reverse order.
 * @throws {PersistenceLeaseIntegrityError} If either scope is unsafe or mismatched.
 * @example
 * const lifetime = await acquirePersistenceFamilyLease({
 *   targetPath: "/tmp/enquire/a.feedback.json",
 *   familyKey: "feedback-v1",
 *   role: "shared"
 * });
 * await lifetime.release();
 */
export async function acquirePersistenceFamilyLease(
  options: AcquirePersistenceFamilyLeaseOptions
): Promise<PersistenceFamilyLeaseHandle> {
  assertPersistenceFamilyRole(options.role);
  let family: PersistenceLeaseScope;
  try {
    family = await resolvePersistenceLeaseScope(options);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    await fs.mkdir(path.dirname(path.resolve(options.targetPath)), { recursive: true, mode: 0o700 });
    family = await resolvePersistenceLeaseScope(options);
  }
  const namespace = await resolvePersistenceNamespaceLeaseScope(family.canonicalParent);
  return acquirePersistenceFamilyLeaseInScopes(
    { namespace, family },
    { role: options.role, ...timingOptions(options) }
  );
}

/**
 * Acquire a coordinated family role through two previously pinned scopes.
 * Publishers therefore cannot silently re-resolve a replaced namespace.
 *
 * @param scopes - Fixed namespace and target-family scopes from a lifetime handle.
 * @param options - Inner role and bounded gate timing.
 * @returns Pinned two-level handle released in reverse order.
 * @throws {PersistenceLeaseIntegrityError} If either pinned identity changed.
 * @example
 * const publisher = await acquirePersistenceFamilyLeaseInScopes(lifetime.scopes, { role: "publisher" });
 * await publisher.release();
 */
export async function acquirePersistenceFamilyLeaseInScopes(
  scopes: PersistenceFamilyScopes,
  options: AcquirePersistenceFamilyLeaseInScopesOptions
): Promise<PersistenceFamilyLeaseHandle> {
  assertPersistenceFamilyRole(options.role);
  await assertFamilyScopes(scopes);
  const timing = timingOptions(options);
  const namespaceLease = await acquirePersistenceLeaseInScope(scopes.namespace, { role: "shared", ...timing });
  try {
    const familyLease = await acquirePersistenceLeaseInScope(scopes.family, { role: options.role, ...timing });
    return compositeHandle(options.role, namespaceLease, familyLease);
  } catch (error) {
    if (error instanceof PersistenceLeaseOwnershipError) {
      const debtOwner = composePersistenceLeaseDebtOwners([error.debtOwner, leaseDebtOwner(namespaceLease)]);
      throw retainPersistenceLeaseOwnershipError(
        new PersistenceLeaseOwnershipError(
          "Persistence family acquisition retained inner and namespace ownership debt",
          [error],
          debtOwner
        )
      );
    }
    try {
      await namespaceLease.release();
    } catch (rollbackError) {
      if (!(rollbackError instanceof PersistenceLeaseOwnershipError)) {
        throw new AggregateError(
          [error, rollbackError],
          "Persistence family acquisition failed after namespace ownership became terminal"
        );
      }
      throw retainPersistenceLeaseOwnershipError(
        new PersistenceLeaseOwnershipError(
          "Persistence family acquisition failed and namespace rollback was incomplete",
          [error, rollbackError],
          leaseDebtOwner(namespaceLease)
        )
      );
    }
    throw error;
  }
}

/**
 * Acquire the globally destructive role for every coordinated family under one
 * canonical persistence parent. It conflicts with namespace-shared lifetimes,
 * publishers, and family erasers without inspecting their inner directories.
 *
 * @param options - Existing parent path and bounded gate timing.
 * @returns Exact namespace eraser handle.
 * @example
 * const eraser = await acquirePersistenceNamespaceEraser({ parentPath: "/tmp/enquire" });
 * await eraser.release();
 */
export async function acquirePersistenceNamespaceEraser(
  options: AcquirePersistenceNamespaceEraserOptions
): Promise<PersistenceLeaseHandle> {
  const scope = await resolvePersistenceNamespaceLeaseScope(options.parentPath);
  return acquirePersistenceLeaseInScope(scope, { role: "eraser", ...timingOptions(options) });
}
