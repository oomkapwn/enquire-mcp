import { createHash, randomBytes } from "node:crypto";
import { type BigIntStats, constants, type Dirent, promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { foldName } from "./name-fold.js";

const LEASE_ROOT_NAME = ".enquire-mcp-leases";
const GATE_NAME = ".gate";
const CANDIDATE_PREFIX = ".candidate.";
const MARKER_PREFIX = "lease.";
const MARKER_SUFFIX = ".json";
const MAX_FAMILY_KEY_BYTES = 256;
const MAX_MARKER_BYTES = 16 * 1024;
const MAX_NAMESPACE_ENTRIES = 4_096;
const MAX_PROCESS_DEBT_OWNERS = 256;
const MAX_PROCESS_DEBT_ARTIFACTS = 1_024;
const MAX_DEBT_ARTIFACTS_PER_OWNER = MAX_PROCESS_DEBT_ARTIFACTS;
const MAX_GATE_TIMEOUT_MS = 30_000;
const MAX_GATE_POLL_MS = 1_000;
const DEFAULT_GATE_TIMEOUT_MS = 2_000;
const DEFAULT_GATE_POLL_MS = 20;
const FAMILY_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const LEASE_MARKER_RE = /^lease\.(shared|publisher|eraser)\.([1-9][0-9]*)\.([0-9a-f]{32})\.json$/u;
const CANDIDATE_MARKER_RE = /^\.candidate\.([0-9a-f]{64})\.([1-9][0-9]*)\.([0-9a-f]{32})$/u;

/** A lifetime holder, serialized publisher, or globally exclusive eraser role. */
export type PersistenceLeaseRole = "shared" | "publisher" | "eraser";

/** Exact filesystem identity of the canonical persistence parent directory. */
export interface PersistenceLeaseParentIdentity {
  /** Exact device identifier returned by BigInt `lstat`. */
  readonly dev: bigint;
  /** Exact inode/file identifier returned by BigInt `lstat`. */
  readonly ino: bigint;
}

/** Exact filesystem identities of an acquisition-bound lease namespace. */
export interface PersistenceLeaseNamespaceIdentity {
  /** Device/inode identity of the private `.enquire-mcp-leases` root. */
  readonly root: PersistenceLeaseParentIdentity;
  /** Device/inode identity of the target family's private directory. */
  readonly family: PersistenceLeaseParentIdentity;
}

/** Stable identity and on-disk namespace for one persistence family. */
export interface PersistenceLeaseScope {
  /** Canonical real path of the target's parent directory. */
  readonly canonicalParent: string;
  /** Device/inode identity pinned when the canonical parent was resolved. */
  readonly parentIdentity: PersistenceLeaseParentIdentity;
  /** Canonical basename used in the scope digest. */
  readonly targetName: string;
  /** Caller-supplied semantic persistence family. */
  readonly familyKey: string;
  /** SHA-256 identity of the target basename and family key. */
  readonly digest: string;
  /** Private root shared by persistence leases in the canonical parent. */
  readonly rootDirectory: string;
  /** Private directory containing this scope's gate and lease markers. */
  readonly directory: string;
  /**
   * Namespace identities pinned by acquisition or inspection. Absent only
   * before the namespace has been opened or created for the first time.
   */
  readonly namespaceIdentity?: PersistenceLeaseNamespaceIdentity;
}

/** Input shared by lease acquisition, inspection, and explicit recovery. */
export interface PersistenceLeaseTarget {
  /** Main persistence path whose real parent owns the lease namespace. */
  readonly targetPath: string;
  /** Portable semantic family key such as `cache` or `embed-db`. */
  readonly familyKey: string;
}

/** Options for acquiring one lifetime or destructive persistence lease. */
export interface AcquirePersistenceLeaseOptions extends PersistenceLeaseTarget {
  /** Shared lifetime holder, serialized publisher, or globally exclusive eraser. */
  readonly role: PersistenceLeaseRole;
  /** Maximum wait for the short acquisition gate, never for a conflicting lease. */
  readonly gateTimeoutMs?: number;
  /** Poll interval while another process owns the short acquisition gate. */
  readonly gatePollMs?: number;
}

/** Options for a role acquired against an already-pinned lifetime scope. */
export interface AcquirePersistenceLeaseInScopeOptions {
  /** Shared lifetime holder, serialized publisher, or globally exclusive eraser. */
  readonly role: PersistenceLeaseRole;
  /** Maximum wait for the short acquisition gate, never for a conflicting lease. */
  readonly gateTimeoutMs?: number;
  /** Poll interval while another process owns the short acquisition gate. */
  readonly gatePollMs?: number;
}

/** Metadata stored in an authoritative gate or lease marker. */
export interface PersistenceLeaseMarker {
  /** Exact authoritative filename used for explicit inspection and recovery. */
  readonly id: string;
  /** Whether this is the short acquisition gate or a lifetime lease. */
  readonly kind: "gate" | "lease";
  /** Lease role; absent only for the short acquisition gate. */
  readonly role?: PersistenceLeaseRole;
  /** Hostname captured by the creating process. */
  readonly hostname: string;
  /** Operating-system process identifier captured by the creator. */
  readonly pid: number;
  /** Cryptographically random ownership token. */
  readonly nonce: string;
  /** ISO timestamp for diagnostics only; it never authorizes stealing. */
  readonly createdAt: string;
}

/** Recoverable staging marker created before its authoritative hard link. */
export interface PersistenceLeaseCandidateMarker {
  /** Exact staging filename used for explicit recovery. */
  readonly id: string;
  /** Distinguishes staging artifacts from authoritative markers. */
  readonly kind: "candidate";
  /** SHA-256 of the creating hostname, encoded atomically in the filename. */
  readonly hostDigest: string;
  /** Operating-system process identifier encoded atomically in the filename. */
  readonly pid: number;
  /** Cryptographically random ownership token encoded atomically in the filename. */
  readonly nonce: string;
}

/** Any exact filesystem marker returned by lease inspection or recovery. */
export type PersistenceLeaseInspectableMarker = PersistenceLeaseMarker | PersistenceLeaseCandidateMarker;

/** Read-only snapshot of the authoritative markers in one scope. */
export interface PersistenceLeaseInspection {
  /** Canonical scope that was inspected. */
  readonly scope: PersistenceLeaseScope;
  /** Current short gate owner, if one exists. */
  readonly gate: PersistenceLeaseMarker | null;
  /** Current shared and exclusive lifetime markers. */
  readonly leases: readonly PersistenceLeaseMarker[];
  /** Non-authoritative crash staging artifacts; never removed automatically. */
  readonly candidates: readonly PersistenceLeaseCandidateMarker[];
}

/** Context supplied to the caller's mandatory quiescence proof. */
export interface PersistenceLeaseRecoveryContext {
  /** Canonical scope containing the candidate orphan. */
  readonly scope: PersistenceLeaseScope;
  /** Exact same-host, non-running marker proposed for recovery. */
  readonly marker: PersistenceLeaseInspectableMarker;
}

/** Options for explicit, never-automatic orphan recovery. */
export interface RecoverPersistenceLeaseOptions extends PersistenceLeaseTarget {
  /** Exact marker ID obtained from {@link inspectPersistenceLeases}. */
  readonly markerId: string;
  /**
   * Caller-owned proof that every participant using this scope is quiescent.
   * Recovery proceeds only when the awaited predicate returns `true`.
   */
  readonly assertQuiescent: (context: PersistenceLeaseRecoveryContext) => boolean | Promise<boolean>;
  /** Bounded wait for the short gate when recovering a lifetime marker. */
  readonly gateTimeoutMs?: number;
  /** Poll interval while waiting for that short gate. */
  readonly gatePollMs?: number;
}

/** An exact owned marker that remains held until explicitly released. */
export interface PersistenceLeaseHandle {
  /** Canonical scope protected by this handle. */
  readonly scope: PersistenceLeaseScope;
  /** Shared or exclusive role held by this process. */
  readonly role: PersistenceLeaseRole;
  /** Exact marker metadata owned by this handle. */
  readonly marker: PersistenceLeaseMarker;
  /**
   * Remove only this handle's still-identical marker. Release is monotonic:
   * it never publishes a new gate or staging artifact.
   *
   * @returns A promise that settles after exact cleanup; repeated calls reuse it.
   */
  release(): Promise<void>;
}

/** One exact filesystem artifact retained by a retryable ownership debt. */
export interface PersistenceLeaseOwnedArtifact {
  /** Canonical acquisition-bound scope containing the artifact. */
  readonly scope: PersistenceLeaseScope;
  /** Exact authoritative marker or non-authoritative staging candidate. */
  readonly marker: PersistenceLeaseInspectableMarker;
}

/** Explicit owner for artifacts that an interrupted operation could not release. */
export interface PersistenceLeaseDebtOwner {
  /** Exact artifacts whose cleanup remains the responsibility of this owner. */
  readonly artifacts: readonly PersistenceLeaseOwnedArtifact[];
  /**
   * Retry exact cleanup without stealing, expiry, or an unbounded loop.
   *
   * @returns A promise that resolves only after every retained artifact is terminal.
   */
  release(): Promise<void>;
}

/** Bounded process-local summary of failed current-process ownership cleanup. */
export interface PersistenceLeaseDebtRegistryStatus {
  /** Number of deduplicated cleanup owners retained by this process. */
  readonly ownerCount: number;
  /** Number of unique exact scope-and-marker artifacts still retained. */
  readonly artifactCount: number;
  /** Hard maximum number of retained owners. */
  readonly maxOwners: number;
  /** Hard maximum number of unique retained artifacts. */
  readonly maxArtifacts: number;
  /** Whether a capacity refusal has permanently latched acquisition fail-closed. */
  readonly saturated: boolean;
}

/** One failed owner from a bounded process-wide terminal drain. */
export interface PersistenceLeaseDebtDrainFailure {
  /** Deduplicated artifacts that remained after the single explicit attempt. */
  readonly artifacts: readonly PersistenceLeaseOwnedArtifact[];
  /** Exact cleanup failure returned by the retained owner. */
  readonly error: unknown;
}

/** Result of one bounded, no-sleep process-wide debt drain. */
export interface PersistenceLeaseDebtDrainReport {
  /** Retained owners attempted at most once from the initial bounded snapshot. */
  readonly attemptedOwners: number;
  /** Owners whose exact cleanup completed during this call. */
  readonly releasedOwners: number;
  /** Owners that still failed and remain retained. */
  readonly failures: readonly PersistenceLeaseDebtDrainFailure[];
  /** Registry state after the bounded drain. */
  readonly status: PersistenceLeaseDebtRegistryStatus;
}

/** Base error for portable persistence lease failures. */
export class PersistenceLeaseError extends Error {
  /**
   * Create a persistence lease error.
   *
   * @param message - Stable, path-minimizing diagnostic message.
   */
  constructor(message: string) {
    super(message);
    this.name = "PersistenceLeaseError";
  }
}

/** Raised when another compatible process currently holds an incompatible role. */
export class PersistenceLeaseConflictError extends PersistenceLeaseError {
  /** Requested role that could not be admitted. */
  readonly requestedRole: PersistenceLeaseRole;
  /** Roles observed while the short acquisition gate was held. */
  readonly heldRoles: readonly PersistenceLeaseRole[];

  /**
   * Create a deterministic lease-conflict error.
   *
   * @param requestedRole - Role requested by the caller.
   * @param heldRoles - Incompatible roles observed in the namespace.
   */
  constructor(requestedRole: PersistenceLeaseRole, heldRoles: readonly PersistenceLeaseRole[]) {
    super(`Persistence lease '${requestedRole}' conflicts with active role(s): ${heldRoles.join(", ")}`);
    this.name = "PersistenceLeaseConflictError";
    this.requestedRole = requestedRole;
    this.heldRoles = [...heldRoles];
  }
}

/** Raised when the short acquisition gate remains occupied past its bounded wait. */
export class PersistenceLeaseTimeoutError extends PersistenceLeaseError {
  /** Configured gate wait in milliseconds. */
  readonly timeoutMs: number;

  /**
   * Create a gate timeout error.
   *
   * @param timeoutMs - Bounded duration that elapsed.
   */
  constructor(timeoutMs: number) {
    super(`Persistence lease gate remained occupied for ${timeoutMs} ms`);
    this.name = "PersistenceLeaseTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/** Raised when a namespace component or marker cannot be trusted. */
export class PersistenceLeaseIntegrityError extends PersistenceLeaseError {
  /**
   * Create a fail-closed namespace-integrity error.
   *
   * @param message - Integrity failure without an absolute host path.
   */
  constructor(message: string) {
    super(message);
    this.name = "PersistenceLeaseIntegrityError";
  }
}

/** Raised when explicit recovery cannot prove same-host orphanhood and quiescence. */
export class PersistenceLeaseRecoveryError extends PersistenceLeaseError {
  /**
   * Create an explicit recovery refusal.
   *
   * @param message - Reason the marker was not removed.
   */
  constructor(message: string) {
    super(message);
    this.name = "PersistenceLeaseRecoveryError";
  }
}

/** Raised when a failed operation still owns exact, explicitly releasable artifacts. */
export class PersistenceLeaseOwnershipError extends PersistenceLeaseIntegrityError {
  /** Original operation and cleanup failures, retained without hiding either. */
  readonly causes: readonly unknown[];
  /** Reachable, retryable owner for every artifact the operation may still own. */
  readonly debtOwner: PersistenceLeaseDebtOwner;

  /**
   * Create an ownership-carrying failure.
   *
   * @param message - Stable explanation of the incomplete ownership transition.
   * @param causes - Original operation and cleanup failures.
   * @param debtOwner - Exact retryable owner that must remain reachable.
   */
  constructor(message: string, causes: readonly unknown[], debtOwner: PersistenceLeaseDebtOwner) {
    super(message);
    this.name = "PersistenceLeaseOwnershipError";
    this.causes = [...causes];
    this.debtOwner = debtOwner;
  }
}

/** Raised when bounded process-local ownership retention cannot admit another unique debt. */
export class PersistenceLeaseDebtCapacityError extends PersistenceLeaseIntegrityError {
  /**
   * Create a fail-closed registry-capacity error.
   *
   * @param message - Stable capacity diagnostic without artifact paths.
   */
  constructor(message: string) {
    super(message);
    this.name = "PersistenceLeaseDebtCapacityError";
  }
}

interface StoredMarker {
  readonly version: 1;
  readonly scopeDigest: string;
  readonly kind: "gate" | "lease";
  readonly role?: PersistenceLeaseRole;
  readonly hostname: string;
  readonly pid: number;
  readonly nonce: string;
  readonly createdAt: string;
}

interface OwnedMarker {
  readonly path: string;
  readonly file: FileHandle;
  readonly identity: FileIdentity;
  readonly bytes: string;
  readonly marker: PersistenceLeaseMarker;
}

interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

interface GateOptions {
  readonly timeoutMs: number;
  readonly pollMs: number;
}

interface ScopeDirectoryScan {
  readonly leases: PersistenceLeaseMarker[];
  readonly candidates: PersistenceLeaseCandidateMarker[];
}

interface NormalizedDebtArtifact {
  readonly key: string;
  readonly scopeKey: string;
  readonly artifact: PersistenceLeaseOwnedArtifact;
}

interface ProcessDebtEntry {
  readonly id: number;
  readonly owner: PersistenceLeaseDebtOwner;
  readonly artifacts: Map<string, NormalizedDebtArtifact>;
}

const processDebtEntries = new Map<number, ProcessDebtEntry>();
const processDebtArtifactIndex = new Map<string, number>();
let nextProcessDebtId = 1;
let processDebtSaturated = false;

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const { code } = error as { code?: unknown };
  return typeof code === "string" ? code : undefined;
}

function exactMarkerOwnershipIsTerminal(error: unknown): boolean {
  return (
    errorCode(error) === "ENOENT" ||
    (error instanceof PersistenceLeaseIntegrityError &&
      (error.message.endsWith("no longer belongs to this handle") || error.message.endsWith("ownership token changed")))
  );
}

function hasExactFileIdentity(value: unknown): value is FileIdentity {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { readonly dev?: unknown; readonly ino?: unknown };
  return (
    typeof candidate.dev === "bigint" && candidate.dev >= 0n && typeof candidate.ino === "bigint" && candidate.ino > 0n
  );
}

function exactPinnedScopeKey(scope: PersistenceLeaseScope): string {
  const namespace = scope.namespaceIdentity;
  if (
    namespace === undefined ||
    !hasExactFileIdentity(scope.parentIdentity) ||
    !hasExactFileIdentity(namespace.root) ||
    !hasExactFileIdentity(namespace.family)
  ) {
    throw new PersistenceLeaseIntegrityError("Persistence lease debt requires an exact pinned scope");
  }
  return createHash("sha256")
    .update(
      JSON.stringify([
        scope.canonicalParent,
        scope.parentIdentity.dev.toString(10),
        scope.parentIdentity.ino.toString(10),
        scope.digest,
        namespace.root.dev.toString(10),
        namespace.root.ino.toString(10),
        namespace.family.dev.toString(10),
        namespace.family.ino.toString(10)
      ]),
      "utf8"
    )
    .digest("hex");
}

function normalizeCurrentProcessDebtArtifact(artifact: PersistenceLeaseOwnedArtifact): NormalizedDebtArtifact {
  const { marker } = artifact;
  if (marker.pid !== process.pid) {
    throw new PersistenceLeaseIntegrityError("Persistence lease registry accepts only current-process debt");
  }
  if (marker.kind === "candidate") {
    const match = CANDIDATE_MARKER_RE.exec(marker.id);
    if (!match || match[2] !== String(process.pid) || match[3] !== marker.nonce) {
      throw new PersistenceLeaseIntegrityError("Persistence lease registry candidate identity is invalid");
    }
  } else if (marker.kind === "gate") {
    if (marker.id !== GATE_NAME || marker.role !== undefined) {
      throw new PersistenceLeaseIntegrityError("Persistence lease registry gate identity is invalid");
    }
  } else {
    const match = LEASE_MARKER_RE.exec(marker.id);
    if (!match || match[1] !== marker.role || match[2] !== String(process.pid) || match[3] !== marker.nonce) {
      throw new PersistenceLeaseIntegrityError("Persistence lease registry marker identity is invalid");
    }
  }
  const scopeKey = exactPinnedScopeKey(artifact.scope);
  return {
    key: `${scopeKey}\0${marker.kind}\0${marker.id}\0${marker.nonce}`,
    scopeKey,
    artifact
  };
}

function normalizedDebtArtifacts(owner: PersistenceLeaseDebtOwner): Map<string, NormalizedDebtArtifact> {
  if (owner.artifacts.length < 1 || owner.artifacts.length > MAX_DEBT_ARTIFACTS_PER_OWNER) {
    throw new PersistenceLeaseIntegrityError(
      `Persistence lease debt owner must contain 1-${MAX_DEBT_ARTIFACTS_PER_OWNER} exact artifacts`
    );
  }
  const normalized = new Map<string, NormalizedDebtArtifact>();
  for (const artifact of owner.artifacts) {
    const entry = normalizeCurrentProcessDebtArtifact(artifact);
    normalized.set(entry.key, entry);
  }
  return normalized;
}

function removeProcessDebtEntry(id: number): void {
  const entry = processDebtEntries.get(id);
  if (entry === undefined) return;
  processDebtEntries.delete(id);
  for (const key of entry.artifacts.keys()) {
    if (processDebtArtifactIndex.get(key) === id) processDebtArtifactIndex.delete(key);
  }
}

function allocateProcessDebtId(): number {
  for (let attempt = 0; attempt < MAX_PROCESS_DEBT_OWNERS; attempt++) {
    const id = nextProcessDebtId;
    nextProcessDebtId = id === MAX_PROCESS_DEBT_OWNERS ? 1 : id + 1;
    if (!processDebtEntries.has(id)) return id;
  }
  processDebtSaturated = true;
  throw new PersistenceLeaseDebtCapacityError("Persistence lease debt registry has no bounded owner slot");
}

function notifyDebtArtifactsReleased(artifacts: readonly PersistenceLeaseOwnedArtifact[]): void {
  for (const artifact of artifacts) {
    const normalized = normalizeCurrentProcessDebtArtifact(artifact);
    const entryId = processDebtArtifactIndex.get(normalized.key);
    if (entryId === undefined) continue;
    const entry = processDebtEntries.get(entryId);
    if (entry === undefined) {
      processDebtArtifactIndex.delete(normalized.key);
      continue;
    }
    entry.artifacts.delete(normalized.key);
    processDebtArtifactIndex.delete(normalized.key);
    if (entry.artifacts.size === 0) removeProcessDebtEntry(entry.id);
  }
}

function retryableDebtOwner(
  artifacts: readonly PersistenceLeaseOwnedArtifact[],
  releaseArtifacts: () => Promise<void>
): PersistenceLeaseDebtOwner {
  let released = false;
  let releasePromise: Promise<void> | undefined;
  return {
    artifacts: [...artifacts],
    release: () => {
      if (released) return Promise.resolve();
      if (releasePromise === undefined) {
        const attempt = Promise.resolve()
          .then(releaseArtifacts)
          .then(() => {
            notifyDebtArtifactsReleased(artifacts);
            released = true;
          });
        releasePromise = attempt;
        void attempt.then(
          () => undefined,
          () => {
            if (releasePromise === attempt) releasePromise = undefined;
          }
        );
      }
      return releasePromise;
    }
  };
}

function registerFailedProcessDebt(owner: PersistenceLeaseDebtOwner): PersistenceLeaseDebtOwner {
  const incoming = normalizedDebtArtifacts(owner);
  const overlappingIds = new Set<number>();
  for (const key of incoming.keys()) {
    const entryId = processDebtArtifactIndex.get(key);
    if (entryId !== undefined) overlappingIds.add(entryId);
  }
  if (overlappingIds.size === 1) {
    const [entryId] = overlappingIds;
    const existing = entryId === undefined ? undefined : processDebtEntries.get(entryId);
    if (existing !== undefined && [...incoming.keys()].every((key) => existing.artifacts.has(key))) {
      return existing.owner;
    }
  }

  const overlapping = [...overlappingIds]
    .map((id) => processDebtEntries.get(id))
    .filter((entry): entry is ProcessDebtEntry => entry !== undefined);
  const union = new Map(incoming);
  for (const entry of overlapping) {
    for (const [key, artifact] of entry.artifacts) union.set(key, artifact);
  }
  const projectedOwners = processDebtEntries.size - overlapping.length + 1;
  const removedArtifactCount = overlapping.reduce((total, entry) => total + entry.artifacts.size, 0);
  const projectedArtifacts = processDebtArtifactIndex.size - removedArtifactCount + union.size;
  if (projectedOwners > MAX_PROCESS_DEBT_OWNERS || projectedArtifacts > MAX_PROCESS_DEBT_ARTIFACTS) {
    processDebtSaturated = true;
    throw new PersistenceLeaseDebtCapacityError("Persistence lease debt registry reached its bounded capacity");
  }

  const mergedOwner =
    overlapping.length === 0
      ? owner
      : retryableDebtOwner(
          [...union.values()].map(({ artifact }) => artifact),
          async () => {
            await owner.release();
            for (const entry of overlapping) await entry.owner.release();
          }
        );
  for (const entry of overlapping) removeProcessDebtEntry(entry.id);
  const id = allocateProcessDebtId();
  const entry: ProcessDebtEntry = { id, owner: mergedOwner, artifacts: union };
  processDebtEntries.set(id, entry);
  for (const key of union.keys()) processDebtArtifactIndex.set(key, id);
  return mergedOwner;
}

/**
 * Retain one ownership failure at a public operation boundary. Exact artifacts
 * are deduplicated, current-process-only, and bounded; active handles and
 * inspected crash orphans are never admitted by this API.
 *
 * @param error - Ownership-carrying failure about to cross a public boundary.
 * @returns The same failure or an equivalent failure carrying the retained owner.
 * @example
 * throw retainPersistenceLeaseOwnershipError(error);
 */
export function retainPersistenceLeaseOwnershipError(
  error: PersistenceLeaseOwnershipError
): PersistenceLeaseOwnershipError {
  try {
    const retained = registerFailedProcessDebt(error.debtOwner);
    if (retained === error.debtOwner) return error;
    return new PersistenceLeaseOwnershipError(error.message, error.causes, retained);
  } catch (registryError) {
    if (registryError instanceof PersistenceLeaseDebtCapacityError) processDebtSaturated = true;
    return new PersistenceLeaseOwnershipError(
      "Persistence lease ownership failed and process-local debt retention was incomplete",
      [error, registryError],
      error.debtOwner
    );
  }
}

/**
 * Inspect bounded process-local debt counts without touching any marker.
 *
 * @returns Counts and hard capacities for failed current-process owners only.
 * @example
 * const status = getProcessPersistenceLeaseDebtStatus();
 */
export function getProcessPersistenceLeaseDebtStatus(): PersistenceLeaseDebtRegistryStatus {
  return {
    ownerCount: processDebtEntries.size,
    artifactCount: processDebtArtifactIndex.size,
    maxOwners: MAX_PROCESS_DEBT_OWNERS,
    maxArtifacts: MAX_PROCESS_DEBT_ARTIFACTS,
    saturated: processDebtSaturated
  };
}

/**
 * Attempt every retained current-process owner once for terminal shutdown.
 * The bounded snapshot never sleeps or loops; failures remain registered.
 *
 * @returns Attempt and failure details plus the final bounded registry status.
 * @example
 * const report = await drainProcessPersistenceLeaseDebts();
 */
export async function drainProcessPersistenceLeaseDebts(): Promise<PersistenceLeaseDebtDrainReport> {
  const snapshot = [...processDebtEntries.values()].slice(0, MAX_PROCESS_DEBT_OWNERS);
  const failures: PersistenceLeaseDebtDrainFailure[] = [];
  let attemptedOwners = 0;
  let releasedOwners = 0;
  for (const original of snapshot) {
    const current = processDebtEntries.get(original.id);
    if (current === undefined) continue;
    attemptedOwners++;
    try {
      await current.owner.release();
      removeProcessDebtEntry(current.id);
      releasedOwners++;
    } catch (error) {
      const retained = processDebtEntries.get(current.id);
      failures.push({
        artifacts: [...(retained?.artifacts.values() ?? [])].map(({ artifact }) => artifact),
        error
      });
    }
  }
  return { attemptedOwners, releasedOwners, failures, status: getProcessPersistenceLeaseDebtStatus() };
}

async function drainProcessDebtForScope(scope: PersistenceLeaseScope): Promise<void> {
  if (processDebtSaturated) {
    throw new PersistenceLeaseDebtCapacityError("Persistence lease acquisition is disabled after debt saturation");
  }
  const scopeKey = exactPinnedScopeKey(scope);
  const snapshot = [...processDebtEntries.values()].filter((entry) =>
    [...entry.artifacts.values()].some((artifact) => artifact.scopeKey === scopeKey)
  );
  const failures: unknown[] = [];
  for (const original of snapshot) {
    const current = processDebtEntries.get(original.id);
    if (current === undefined) continue;
    try {
      await current.owner.release();
      removeProcessDebtEntry(current.id);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 0) return;
  const retained = [...processDebtEntries.values()].filter((entry) =>
    [...entry.artifacts.values()].some((artifact) => artifact.scopeKey === scopeKey)
  );
  if (retained.length === 0) throw failures[0];
  const artifacts = new Map<string, PersistenceLeaseOwnedArtifact>();
  for (const entry of retained) {
    for (const [key, artifact] of entry.artifacts) artifacts.set(key, artifact.artifact);
  }
  const debtOwner = retryableDebtOwner([...artifacts.values()], async () => {
    for (const entry of retained) await entry.owner.release();
  });
  throw new PersistenceLeaseOwnershipError("Persistence lease targeted debt drain was incomplete", failures, debtOwner);
}

/**
 * Compose exact debt owners in cleanup order while preserving retry progress.
 * A later owner is never attempted until every earlier owner is terminal.
 *
 * @param owners - Non-empty debt owners ordered from inner to outer ownership.
 * @returns One reachable owner that resumes at the first incomplete child.
 * @throws {TypeError} If no debt owner is supplied.
 * @example
 * await composePersistenceLeaseDebtOwners([innerDebt, outerDebt]).release();
 */
export function composePersistenceLeaseDebtOwners(
  owners: readonly PersistenceLeaseDebtOwner[]
): PersistenceLeaseDebtOwner {
  if (owners.length === 0) throw new TypeError("Persistence lease debt composition requires at least one owner");
  let nextOwner = 0;
  return retryableDebtOwner(
    owners.flatMap((owner) => owner.artifacts),
    async () => {
      while (nextOwner < owners.length) {
        const owner = owners[nextOwner];
        if (owner === undefined) {
          throw new PersistenceLeaseIntegrityError("Persistence lease debt composition lost an exact owner");
        }
        await owner.release();
        nextOwner++;
      }
    }
  );
}

function assertPrivateMode(stats: BigIntStats, expected: number, label: string): void {
  if (process.platform === "win32") return;
  if ((stats.mode & 0o777n) !== BigInt(expected)) {
    throw new PersistenceLeaseIntegrityError(`${label} permissions must be ${expected.toString(8)}`);
  }
  if (typeof process.getuid === "function" && stats.uid !== BigInt(process.getuid())) {
    throw new PersistenceLeaseIntegrityError(`${label} must be owned by the current user`);
  }
}

async function assertPrivateDirectory(directory: string, label: string): Promise<BigIntStats> {
  const stats = await fs.lstat(directory, { bigint: true });
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new PersistenceLeaseIntegrityError(`${label} must be a real directory`);
  }
  if (!hasExactFileIdentity(identity(stats))) {
    throw new PersistenceLeaseIntegrityError(`${label} has no exact filesystem identity`);
  }
  assertPrivateMode(stats, 0o700, label);
  const real = await fs.realpath(directory);
  if (real !== directory) {
    throw new PersistenceLeaseIntegrityError(`${label} must not resolve through an alias`);
  }
  return stats;
}

async function ensurePrivateDirectory(directory: string, label: string): Promise<void> {
  try {
    await fs.mkdir(directory, { mode: 0o700 });
    await fs.chmod(directory, 0o700);
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
  await assertPrivateDirectory(directory, label);
}

function validateFamilyKey(familyKey: unknown): string {
  if (typeof familyKey !== "string") throw new TypeError("Persistence lease family key must be a string");
  const normalized = familyKey.normalize("NFC");
  if (!FAMILY_KEY_RE.test(normalized) || Buffer.byteLength(normalized, "utf8") > MAX_FAMILY_KEY_BYTES) {
    throw new TypeError("Persistence lease family key must be a bounded portable identifier");
  }
  return normalized;
}

function validateRole(role: unknown): asserts role is PersistenceLeaseRole {
  if (role !== "shared" && role !== "publisher" && role !== "eraser") {
    throw new TypeError("Persistence lease role must be shared, publisher, or eraser");
  }
}

function persistenceScopeDigest(targetName: string, familyKey: string): string {
  return createHash("sha256")
    .update(`v1\0${foldName(targetName)}\0${familyKey}`, "utf8")
    .digest("hex");
}

function boundedInteger(value: unknown, fallback: number, maximum: number, label: string): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || Number(candidate) < 1 || Number(candidate) > maximum) {
    throw new TypeError(`${label} must be a positive integer no greater than ${maximum}`);
  }
  return Number(candidate);
}

function gateOptions(options: { readonly gateTimeoutMs?: number; readonly gatePollMs?: number }): GateOptions {
  const timeoutMs = boundedInteger(
    options.gateTimeoutMs,
    DEFAULT_GATE_TIMEOUT_MS,
    MAX_GATE_TIMEOUT_MS,
    "Persistence lease gate timeout"
  );
  const pollMs = boundedInteger(
    options.gatePollMs,
    DEFAULT_GATE_POLL_MS,
    Math.min(MAX_GATE_POLL_MS, timeoutMs),
    "Persistence lease gate poll interval"
  );
  return { timeoutMs, pollMs };
}

function markerName(role: PersistenceLeaseRole, pid: number, nonce: string): string {
  return `${MARKER_PREFIX}${role}.${pid}.${nonce}${MARKER_SUFFIX}`;
}

function currentHostDigest(): string {
  return createHash("sha256").update(`host\0${os.hostname()}`, "utf8").digest("hex");
}

function candidateName(nonce: string): string {
  return `${CANDIDATE_PREFIX}${currentHostDigest()}.${process.pid}.${nonce}`;
}

function candidateMarker(id: string): PersistenceLeaseCandidateMarker {
  const match = CANDIDATE_MARKER_RE.exec(id);
  if (!match) throw new PersistenceLeaseIntegrityError("Persistence lease staging filename is invalid");
  const hostDigest = match[1];
  const pidText = match[2];
  const nonce = match[3];
  const pid = Number(pidText);
  if (hostDigest === undefined || nonce === undefined || !Number.isSafeInteger(pid) || pid < 1) {
    throw new PersistenceLeaseIntegrityError("Persistence lease staging PID is invalid");
  }
  return {
    id,
    kind: "candidate",
    hostDigest,
    pid,
    nonce
  };
}

function publicMarker(id: string, stored: StoredMarker): PersistenceLeaseMarker {
  return {
    id,
    kind: stored.kind,
    ...(stored.role === undefined ? {} : { role: stored.role }),
    hostname: stored.hostname,
    pid: stored.pid,
    nonce: stored.nonce,
    createdAt: stored.createdAt
  };
}

function storedMarker(
  scope: PersistenceLeaseScope,
  kind: "gate" | "lease",
  nonce: string,
  role?: PersistenceLeaseRole
): StoredMarker {
  return {
    version: 1,
    scopeDigest: scope.digest,
    kind,
    ...(role === undefined ? {} : { role }),
    hostname: os.hostname(),
    pid: process.pid,
    nonce,
    createdAt: new Date().toISOString()
  };
}

function identity(stats: BigIntStats): FileIdentity {
  return { dev: stats.dev, ino: stats.ino };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return hasExactFileIdentity(left) && hasExactFileIdentity(right) && left.dev === right.dev && left.ino === right.ino;
}

async function lstatTrustedFile(filePath: string, label: string): Promise<BigIntStats> {
  const stats = await fs.lstat(filePath, { bigint: true });
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new PersistenceLeaseIntegrityError(`${label} must be a regular file`);
  }
  if (!hasExactFileIdentity(identity(stats))) {
    throw new PersistenceLeaseIntegrityError(`${label} has no exact filesystem identity`);
  }
  assertPrivateMode(stats, 0o600, label);
  if (stats.size < 1n || stats.size > BigInt(MAX_MARKER_BYTES)) {
    throw new PersistenceLeaseIntegrityError(`${label} has an invalid bounded size`);
  }
  return stats;
}

async function lstatRecoverableCandidate(filePath: string): Promise<BigIntStats> {
  const stats = await fs.lstat(filePath, { bigint: true });
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new PersistenceLeaseIntegrityError("Persistence lease staging marker must be a regular file");
  }
  if (!hasExactFileIdentity(identity(stats))) {
    throw new PersistenceLeaseIntegrityError("Persistence lease staging marker has no exact filesystem identity");
  }
  if (process.platform !== "win32" && (stats.mode & 0o077n) !== 0n) {
    throw new PersistenceLeaseIntegrityError("Persistence lease staging marker permissions must remain private");
  }
  if (typeof process.getuid === "function" && stats.uid !== BigInt(process.getuid())) {
    throw new PersistenceLeaseIntegrityError("Persistence lease staging marker must be owned by the current user");
  }
  return stats;
}

interface OpenedIdentityFile {
  readonly file: FileHandle;
  readonly stats: BigIntStats;
}

async function openIdentityPinnedRegular(
  filePath: string,
  label: string,
  markerShape: "authoritative" | "candidate"
): Promise<OpenedIdentityFile> {
  const inspect =
    markerShape === "authoritative"
      ? () => lstatTrustedFile(filePath, label)
      : () => lstatRecoverableCandidate(filePath);
  const before = await inspect();
  const flags = constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const file = await fs.open(filePath, flags);
  try {
    const opened = await file.stat({ bigint: true });
    if (
      !opened.isFile() ||
      !hasExactFileIdentity(identity(opened)) ||
      (markerShape === "authoritative" && (opened.size < 1n || opened.size > BigInt(MAX_MARKER_BYTES)))
    ) {
      throw new PersistenceLeaseIntegrityError(`${label} changed while it was opened`);
    }
    const middle = await inspect();
    if (!sameIdentity(identity(before), identity(middle))) {
      throw new PersistenceLeaseIntegrityError(`${label} path identity changed while it was opened`);
    }

    // Windows 24H2+ exposes path lstat through GetFileInformationByName while
    // descriptor stat still uses the handle API. Those are distinct identity
    // surfaces in libuv, so compare path-to-path and fstat-to-fstat instead of
    // truncating either 64-bit value or assuming the two APIs are interchangeable.
    const confirmation = await fs.open(filePath, flags);
    try {
      const confirmed = await confirmation.stat({ bigint: true });
      if (!confirmed.isFile() || !sameIdentity(identity(opened), identity(confirmed))) {
        throw new PersistenceLeaseIntegrityError(`${label} descriptor identity changed while it was opened`);
      }
    } finally {
      await confirmation.close();
    }
    const after = await inspect();
    if (!sameIdentity(identity(before), identity(after))) {
      throw new PersistenceLeaseIntegrityError(`${label} path identity changed while it was confirmed`);
    }
    return { file, stats: opened };
  } catch (error) {
    await file.close();
    throw error;
  }
}

function parseStoredMarker(raw: string, id: string, scope: PersistenceLeaseScope): StoredMarker {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new PersistenceLeaseIntegrityError("Persistence lease marker is not valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PersistenceLeaseIntegrityError("Persistence lease marker must be an object");
  }
  const record = value as Record<string, unknown>;
  const role = record.role;
  const roleValid = role === undefined || role === "shared" || role === "publisher" || role === "eraser";
  if (
    record.version !== 1 ||
    record.scopeDigest !== scope.digest ||
    (record.kind !== "gate" && record.kind !== "lease") ||
    !roleValid ||
    typeof record.hostname !== "string" ||
    record.hostname.length < 1 ||
    Buffer.byteLength(record.hostname, "utf8") > 1_024 ||
    !Number.isSafeInteger(record.pid) ||
    Number(record.pid) < 1 ||
    typeof record.nonce !== "string" ||
    !/^[0-9a-f]{32}$/u.test(record.nonce) ||
    typeof record.createdAt !== "string" ||
    !Number.isFinite(Date.parse(record.createdAt))
  ) {
    throw new PersistenceLeaseIntegrityError("Persistence lease marker has invalid metadata");
  }
  if (id === GATE_NAME) {
    if (record.kind !== "gate" || role !== undefined) {
      throw new PersistenceLeaseIntegrityError("Persistence lease gate metadata does not match its filename");
    }
  } else {
    const match = LEASE_MARKER_RE.exec(id);
    if (
      !match ||
      record.kind !== "lease" ||
      role !== match[1] ||
      Number(record.pid) !== Number(match[2]) ||
      record.nonce !== match[3]
    ) {
      throw new PersistenceLeaseIntegrityError("Persistence lease metadata does not match its filename");
    }
  }
  return {
    version: 1,
    scopeDigest: scope.digest,
    kind: record.kind,
    ...(role === undefined ? {} : { role }),
    hostname: record.hostname,
    pid: Number(record.pid),
    nonce: record.nonce,
    createdAt: record.createdAt
  };
}

async function readTrustedMarker(
  scope: PersistenceLeaseScope,
  id: string
): Promise<{
  readonly file: FileHandle;
  readonly identity: FileIdentity;
  readonly bytes: string;
  readonly marker: StoredMarker;
}> {
  await revalidatePersistenceLeaseScope(scope);
  const filePath = path.join(scope.directory, id);
  const openedFile = await openIdentityPinnedRegular(filePath, "Persistence lease marker", "authoritative");
  const { file } = openedFile;
  try {
    const opened = openedFile.stats;
    const bytes = await file.readFile({ encoding: "utf8" });
    if (BigInt(Buffer.byteLength(bytes, "utf8")) !== opened.size) {
      throw new PersistenceLeaseIntegrityError("Persistence lease marker changed while it was read");
    }
    const after = await file.stat({ bigint: true });
    if (
      !sameIdentity(identity(opened), identity(after)) ||
      opened.size !== after.size ||
      opened.mtimeNs !== after.mtimeNs ||
      opened.ctimeNs !== after.ctimeNs
    ) {
      throw new PersistenceLeaseIntegrityError("Persistence lease marker changed while it was read");
    }
    const current = await openIdentityPinnedRegular(filePath, "Persistence lease marker", "authoritative");
    try {
      if (!sameIdentity(identity(opened), identity(current.stats))) {
        throw new PersistenceLeaseIntegrityError("Persistence lease marker path changed while it was read");
      }
    } finally {
      await current.file.close();
    }
    const marker = parseStoredMarker(bytes, id, scope);
    await revalidatePersistenceLeaseScope(scope);
    return { file, identity: identity(opened), bytes, marker };
  } catch (error) {
    await file.close();
    throw error;
  }
}

async function exactUnlink(scope: PersistenceLeaseScope, owned: OwnedMarker, label: string): Promise<void> {
  await revalidatePersistenceLeaseScope(scope);
  const current = await openIdentityPinnedRegular(owned.path, label, "authoritative");
  try {
    if (!sameIdentity(owned.identity, identity(current.stats))) {
      throw new PersistenceLeaseIntegrityError(`${label} no longer belongs to this handle`);
    }
    const currentBytes = await current.file.readFile({ encoding: "utf8" });
    const afterRead = await current.file.stat({ bigint: true });
    if (
      currentBytes !== owned.bytes ||
      BigInt(Buffer.byteLength(currentBytes, "utf8")) !== afterRead.size ||
      !sameIdentity(identity(current.stats), identity(afterRead)) ||
      current.stats.mtimeNs !== afterRead.mtimeNs ||
      current.stats.ctimeNs !== afterRead.ctimeNs
    ) {
      throw new PersistenceLeaseIntegrityError(`${label} ownership token changed`);
    }
  } finally {
    await current.file.close();
  }
  await revalidatePersistenceLeaseScope(scope);
  await fs.unlink(owned.path);
  await revalidatePersistenceLeaseScope(scope);
}

async function cleanupCandidate(
  scope: PersistenceLeaseScope,
  filePath: string,
  expectedIdentity: FileIdentity
): Promise<void> {
  await revalidatePersistenceLeaseScope(scope);
  try {
    const current = await openIdentityPinnedRegular(filePath, "Persistence lease staging marker", "candidate");
    try {
      if (!sameIdentity(expectedIdentity, identity(current.stats))) {
        throw new PersistenceLeaseIntegrityError("Persistence lease staging marker no longer belongs to this handle");
      }
    } finally {
      await current.file.close();
    }
    await revalidatePersistenceLeaseScope(scope);
    await fs.unlink(filePath);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  await revalidatePersistenceLeaseScope(scope);
}

function ownedMarkerDebt(
  scope: PersistenceLeaseScope,
  owned: OwnedMarker,
  candidatePath?: string,
  finalPublished = true
): PersistenceLeaseDebtOwner {
  let finalPending = finalPublished;
  let candidatePending = candidatePath !== undefined;
  let fileClosed = false;
  const artifacts: PersistenceLeaseOwnedArtifact[] = [
    ...(finalPublished ? [{ scope, marker: owned.marker }] : []),
    ...(candidatePath === undefined ? [] : [{ scope, marker: candidateMarker(path.basename(candidatePath)) }])
  ];
  return retryableDebtOwner(artifacts, async () => {
    const failures: unknown[] = [];
    if (finalPending) {
      try {
        await exactUnlink(
          scope,
          owned,
          owned.marker.kind === "gate" ? "Persistence lease gate" : "Persistence lease marker"
        );
        finalPending = false;
      } catch (error) {
        if (exactMarkerOwnershipIsTerminal(error)) finalPending = false;
        else failures.push(error);
      }
    }
    if (candidatePending && candidatePath !== undefined) {
      try {
        await cleanupCandidate(scope, candidatePath, owned.identity);
        candidatePending = false;
      } catch (error) {
        failures.push(error);
      }
    }
    if (!finalPending && !candidatePending && !fileClosed) {
      try {
        await owned.file.close();
        fileClosed = true;
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "Persistence lease exact artifact cleanup was incomplete");
    }
  });
}

async function publishMarker(
  scope: PersistenceLeaseScope,
  finalName: string,
  stored: StoredMarker
): Promise<OwnedMarker> {
  await revalidatePersistenceLeaseScope(scope);
  const candidatePath = path.join(scope.directory, candidateName(stored.nonce));
  const bytes = `${JSON.stringify(stored)}\n`;
  if (Buffer.byteLength(bytes, "utf8") > MAX_MARKER_BYTES) {
    throw new PersistenceLeaseIntegrityError("Persistence lease marker exceeds its byte budget");
  }
  const file = await fs.open(candidatePath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600);
  const opened = await file.stat({ bigint: true });
  if (!opened.isFile() || !hasExactFileIdentity(identity(opened))) {
    await file.close();
    throw new PersistenceLeaseIntegrityError("Persistence lease staging marker has no exact filesystem identity");
  }
  const candidateOwned: OwnedMarker = {
    path: path.join(scope.directory, finalName),
    file,
    identity: identity(opened),
    bytes,
    marker: publicMarker(finalName, stored)
  };
  let publishedOwned: OwnedMarker | undefined;
  let finalLinked = false;
  try {
    await file.writeFile(bytes, "utf8");
    await file.sync();
    await fs.chmod(candidatePath, 0o600);
    const written = await file.stat({ bigint: true });
    if (
      !sameIdentity(candidateOwned.identity, identity(written)) ||
      written.size !== BigInt(Buffer.byteLength(bytes, "utf8"))
    ) {
      throw new PersistenceLeaseIntegrityError("Persistence lease staging marker changed while it was written");
    }
    await fs.link(candidatePath, path.join(scope.directory, finalName));
    finalLinked = true;
    const finalOpened = await openIdentityPinnedRegular(
      path.join(scope.directory, finalName),
      "Persistence lease marker",
      "authoritative"
    );
    let finalOwned: OwnedMarker;
    try {
      if (!sameIdentity(candidateOwned.identity, identity(finalOpened.stats))) {
        throw new PersistenceLeaseIntegrityError("Published persistence lease marker changed identity");
      }
      const finalBytes = await finalOpened.file.readFile({ encoding: "utf8" });
      const afterRead = await finalOpened.file.stat({ bigint: true });
      if (
        finalBytes !== bytes ||
        BigInt(Buffer.byteLength(finalBytes, "utf8")) !== afterRead.size ||
        !sameIdentity(identity(finalOpened.stats), identity(afterRead)) ||
        finalOpened.stats.mtimeNs !== afterRead.mtimeNs ||
        finalOpened.stats.ctimeNs !== afterRead.ctimeNs
      ) {
        throw new PersistenceLeaseIntegrityError("Published persistence lease marker changed while verified");
      }
      finalOwned = {
        ...candidateOwned,
        file: finalOpened.file,
        identity: identity(finalOpened.stats)
      };
    } catch (error) {
      await finalOpened.file.close();
      throw error;
    }
    try {
      // On Windows, retaining the descriptor opened through the candidate
      // pathname can prevent that hard-link name from being removed while the
      // authoritative name remains. Transfer ownership to a separately opened
      // final descriptor before deleting the staging link.
      await file.close();
    } catch (error) {
      await finalOwned.file.close();
      throw error;
    }
    publishedOwned = finalOwned;
    await revalidatePersistenceLeaseScope(scope);
    await cleanupCandidate(scope, candidatePath, finalOwned.identity);
    return finalOwned;
  } catch (error) {
    const debtOwner = ownedMarkerDebt(scope, publishedOwned ?? candidateOwned, candidatePath, finalLinked);
    try {
      await debtOwner.release();
    } catch (cleanupError) {
      throw new PersistenceLeaseOwnershipError(
        !finalLinked
          ? "Persistence lease staging cleanup was incomplete"
          : "Persistence lease marker publication retained exact ownership debt",
        [error, cleanupError],
        debtOwner
      );
    }
    if (finalLinked) {
      throw new PersistenceLeaseIntegrityError("Persistence lease marker publication did not reach a fixed point");
    }
    throw error;
  }
}

async function pinExistingScopeDirectories(scope: PersistenceLeaseScope): Promise<PersistenceLeaseScope> {
  await revalidatePersistenceLeaseScope(scope);
  const rootStats = await assertPrivateDirectory(scope.rootDirectory, "Persistence lease root");
  const familyStats = await assertPrivateDirectory(scope.directory, "Persistence lease family directory");
  const pinned =
    scope.namespaceIdentity === undefined
      ? {
          ...scope,
          namespaceIdentity: {
            root: identity(rootStats),
            family: identity(familyStats)
          }
        }
      : scope;
  await revalidatePersistenceLeaseScope(pinned);
  return pinned;
}

async function ensureScopeDirectories(scope: PersistenceLeaseScope): Promise<PersistenceLeaseScope> {
  await revalidatePersistenceLeaseScope(scope);
  if (scope.namespaceIdentity !== undefined) return pinExistingScopeDirectories(scope);
  await ensurePrivateDirectory(scope.rootDirectory, "Persistence lease root");
  await ensurePrivateDirectory(scope.directory, "Persistence lease family directory");
  return pinExistingScopeDirectories(scope);
}

async function releaseGate(scope: PersistenceLeaseScope, gate: OwnedMarker): Promise<void> {
  const debtOwner = ownedMarkerDebt(scope, gate);
  try {
    await debtOwner.release();
  } catch (error) {
    throw new PersistenceLeaseOwnershipError(
      "Persistence lease gate release retained exact ownership debt",
      [error],
      debtOwner
    );
  }
}

async function acquireGate(scope: PersistenceLeaseScope, options: GateOptions): Promise<OwnedMarker> {
  const started = performance.now();
  while (true) {
    await revalidatePersistenceLeaseScope(scope);
    const nonce = randomBytes(16).toString("hex");
    try {
      return await publishMarker(scope, GATE_NAME, storedMarker(scope, "gate", nonce));
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      try {
        await readTrustedMarker(scope, GATE_NAME).then(async ({ file }) => file.close());
      } catch (inspectionError) {
        if (errorCode(inspectionError) === "ENOENT") continue;
        throw inspectionError;
      }
      const elapsed = performance.now() - started;
      if (elapsed >= options.timeoutMs) throw new PersistenceLeaseTimeoutError(options.timeoutMs);
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(options.pollMs, options.timeoutMs - elapsed)));
    }
  }
}

async function readBoundedDirectory(directory: string): Promise<Dirent[]> {
  const opened = await fs.opendir(directory);
  const entries: Dirent[] = [];
  try {
    while (true) {
      const entry = await opened.read();
      if (entry === null) return entries;
      if (entries.length >= MAX_NAMESPACE_ENTRIES) {
        throw new PersistenceLeaseIntegrityError("Persistence lease namespace exceeds its entry budget");
      }
      entries.push(entry);
    }
  } finally {
    await opened.close();
  }
}

async function scanScopeDirectory(scope: PersistenceLeaseScope): Promise<ScopeDirectoryScan> {
  await revalidatePersistenceLeaseScope(scope);
  const entries = await readBoundedDirectory(scope.directory);
  const markers: PersistenceLeaseMarker[] = [];
  const candidates: PersistenceLeaseCandidateMarker[] = [];
  for (const entry of entries) {
    if (entry.name === GATE_NAME) continue;
    if (entry.name.startsWith(CANDIDATE_PREFIX)) {
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new PersistenceLeaseIntegrityError("Persistence lease staging marker must be a regular file");
      }
      try {
        await lstatRecoverableCandidate(path.join(scope.directory, entry.name));
      } catch (error) {
        // A contender may remove its non-authoritative candidate after losing
        // the final hard-link race for `.gate`; a confirmed disappearance is
        // not an orphan and must not poison the gate owner's bounded scan.
        if (errorCode(error) === "ENOENT") continue;
        throw error;
      }
      candidates.push(candidateMarker(entry.name));
      continue;
    }
    if (!LEASE_MARKER_RE.test(entry.name)) {
      throw new PersistenceLeaseIntegrityError("Persistence lease family directory contains an unknown entry");
    }
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new PersistenceLeaseIntegrityError("Persistence lease marker must be a regular file");
    }
    const trusted = await readTrustedMarker(scope, entry.name);
    try {
      markers.push(publicMarker(entry.name, trusted.marker));
    } finally {
      await trusted.file.close();
    }
  }
  await revalidatePersistenceLeaseScope(scope);
  return {
    leases: markers.sort((left, right) => left.id.localeCompare(right.id)),
    candidates: candidates.sort((left, right) => left.id.localeCompare(right.id))
  };
}

async function listLeaseMarkers(scope: PersistenceLeaseScope): Promise<PersistenceLeaseMarker[]> {
  return (await scanScopeDirectory(scope)).leases;
}

function conflictingRoles(
  requestedRole: PersistenceLeaseRole,
  markers: readonly PersistenceLeaseMarker[]
): PersistenceLeaseRole[] {
  const roles = markers.flatMap((marker) => (marker.role === undefined ? [] : [marker.role]));
  if (requestedRole === "shared") return roles.filter((role) => role === "eraser");
  if (requestedRole === "publisher") return roles.filter((role) => role !== "shared");
  return roles;
}

async function targetCanonicalName(absoluteTarget: string, canonicalParent: string): Promise<string> {
  try {
    const targetStats = await fs.lstat(absoluteTarget, { bigint: true });
    if (targetStats.isSymbolicLink() || !targetStats.isFile()) {
      throw new PersistenceLeaseIntegrityError("Persistence lease target must be absent or a regular file");
    }
    if (targetStats.nlink !== 1n) {
      throw new PersistenceLeaseIntegrityError("Persistence lease target must not have hard-link aliases");
    }
    const targetReal = await fs.realpath(absoluteTarget);
    if (path.dirname(targetReal) !== canonicalParent) {
      throw new PersistenceLeaseIntegrityError("Persistence lease target escaped its canonical real parent");
    }
    return path.basename(targetReal).normalize("NFC");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return path.basename(absoluteTarget).normalize("NFC");
    throw error;
  }
}

/**
 * Revalidate a pinned scope against the canonical parent and, after acquisition
 * or inspection, the lease root and family directory device/inode identities.
 * A rename followed by a replacement at the same string path is rejected when
 * observed at this boundary. Node path APIs do not make a subsequent operation
 * dirfd-relative or atomic with this check.
 *
 * @param scope - Previously resolved lifetime scope to revalidate.
 * @returns Only after the scope shape and parent identity still match.
 * @throws {PersistenceLeaseIntegrityError} If the parent or derived scope changed.
 * @example
 * await revalidatePersistenceLeaseScope(lease.scope);
 */
export async function revalidatePersistenceLeaseScope(scope: PersistenceLeaseScope): Promise<void> {
  const familyKey = validateFamilyKey(scope.familyKey);
  const namespaceIdentity = scope.namespaceIdentity;
  if (
    typeof scope.canonicalParent !== "string" ||
    path.resolve(scope.canonicalParent) !== scope.canonicalParent ||
    typeof scope.targetName !== "string" ||
    scope.targetName.length === 0 ||
    path.basename(scope.targetName) !== scope.targetName ||
    scope.targetName !== scope.targetName.normalize("NFC") ||
    !hasExactFileIdentity(scope.parentIdentity) ||
    (namespaceIdentity !== undefined &&
      (typeof namespaceIdentity !== "object" ||
        namespaceIdentity === null ||
        !hasExactFileIdentity(namespaceIdentity.root) ||
        !hasExactFileIdentity(namespaceIdentity.family)))
  ) {
    throw new PersistenceLeaseIntegrityError("Persistence lease scope shape is invalid");
  }
  const expectedDigest = persistenceScopeDigest(scope.targetName, familyKey);
  const expectedRoot = path.join(scope.canonicalParent, LEASE_ROOT_NAME);
  if (
    scope.digest !== expectedDigest ||
    scope.rootDirectory !== expectedRoot ||
    scope.directory !== path.join(expectedRoot, expectedDigest)
  ) {
    throw new PersistenceLeaseIntegrityError("Persistence lease scope derivation is invalid");
  }
  const parentStats = await fs.lstat(scope.canonicalParent, { bigint: true });
  if (parentStats.isSymbolicLink() || !parentStats.isDirectory()) {
    throw new PersistenceLeaseIntegrityError("Persistence lease parent must remain a real directory");
  }
  if (!sameIdentity(scope.parentIdentity, identity(parentStats))) {
    throw new PersistenceLeaseIntegrityError("Persistence lease parent identity changed");
  }
  if ((await fs.realpath(scope.canonicalParent)) !== scope.canonicalParent) {
    throw new PersistenceLeaseIntegrityError("Persistence lease parent path is no longer canonical");
  }
  const currentTargetName = await targetCanonicalName(
    path.join(scope.canonicalParent, scope.targetName),
    scope.canonicalParent
  );
  if (currentTargetName !== scope.targetName) {
    throw new PersistenceLeaseIntegrityError("Persistence lease target identity changed");
  }
  if (namespaceIdentity !== undefined) {
    const rootStats = await assertPrivateDirectory(scope.rootDirectory, "Persistence lease root");
    if (!sameIdentity(namespaceIdentity.root, identity(rootStats))) {
      throw new PersistenceLeaseIntegrityError("Persistence lease root identity changed");
    }
    const familyStats = await assertPrivateDirectory(scope.directory, "Persistence lease family directory");
    if (!sameIdentity(namespaceIdentity.family, identity(familyStats))) {
      throw new PersistenceLeaseIntegrityError("Persistence lease family directory identity changed");
    }
  }
}

/**
 * Resolve a persistence target to a canonical real-parent lease namespace.
 * Existing target symlinks, hard-link aliases, and special files are rejected;
 * lexical and parent-symlink aliases converge through `realpath(parent)`.
 *
 * @param target - Persistence target path and semantic family key.
 * @returns Canonical, non-created scope paths and digest.
 * @throws {TypeError} If the target or family key is malformed.
 * @throws {PersistenceLeaseIntegrityError} If an existing target is not a regular file.
 * @example
 * const scope = await resolvePersistenceLeaseScope({ targetPath: "/tmp/vault.embed.db", familyKey: "embed-db" });
 */
export async function resolvePersistenceLeaseScope(target: PersistenceLeaseTarget): Promise<PersistenceLeaseScope> {
  if (typeof target.targetPath !== "string" || target.targetPath.length === 0 || target.targetPath.includes("\0")) {
    throw new TypeError("Persistence lease target path must be a non-empty filesystem path");
  }
  const familyKey = validateFamilyKey(target.familyKey);
  const absoluteTarget = path.resolve(target.targetPath);
  const lexicalName = path.basename(absoluteTarget);
  if (lexicalName.length === 0 || lexicalName === "." || lexicalName === "..") {
    throw new TypeError("Persistence lease target path must name a file");
  }
  const canonicalParent = await fs.realpath(path.dirname(absoluteTarget));
  const parentStats = await fs.lstat(canonicalParent, { bigint: true });
  if (!parentStats.isDirectory() || parentStats.isSymbolicLink()) {
    throw new PersistenceLeaseIntegrityError("Persistence lease parent must be a real directory");
  }
  if (!hasExactFileIdentity(identity(parentStats))) {
    throw new PersistenceLeaseIntegrityError("Persistence lease parent has no exact filesystem identity");
  }
  const targetName = await targetCanonicalName(absoluteTarget, canonicalParent);
  const digest = persistenceScopeDigest(targetName, familyKey);
  const rootDirectory = path.join(canonicalParent, LEASE_ROOT_NAME);
  return {
    canonicalParent,
    parentIdentity: identity(parentStats),
    targetName,
    familyKey,
    digest,
    rootDirectory,
    directory: path.join(rootDirectory, digest)
  };
}

/**
 * Acquire one portable cross-process persistence lease.
 * Shared roles coexist with each other and with one publisher. Publishers are
 * mutually exclusive, while an eraser conflicts with every active lease.
 * Conflicts fail immediately; only the short acquisition gate is polled under
 * a bounded timeout. No timestamp ever authorizes marker removal.
 *
 * @param options - Target, family, role, and bounded gate timing.
 * @returns Exact owned handle whose marker stays open until release.
 * @throws {PersistenceLeaseConflictError} If an incompatible marker exists.
 * @throws {PersistenceLeaseTimeoutError} If the short gate remains occupied.
 * @throws {PersistenceLeaseIntegrityError} If the private namespace is untrusted.
 * @example
 * const lease = await acquirePersistenceLease({ targetPath: "/tmp/vault.embed.db", familyKey: "embed-db", role: "shared" });
 * await lease.release();
 */
export async function acquirePersistenceLease(
  options: AcquirePersistenceLeaseOptions
): Promise<PersistenceLeaseHandle> {
  const scope = await resolvePersistenceLeaseScope(options);
  return acquirePersistenceLeaseInScope(scope, options);
}

function leaseHandleDebt(handle: PersistenceLeaseHandle): PersistenceLeaseDebtOwner {
  return retryableDebtOwner([{ scope: handle.scope, marker: handle.marker }], async () => handle.release());
}

function persistenceLeaseHandle(
  scope: PersistenceLeaseScope,
  role: PersistenceLeaseRole,
  owned: OwnedMarker
): PersistenceLeaseHandle {
  let markerPending = true;
  let fileClosed = false;
  let releasePromise: Promise<void> | undefined;
  let handle: PersistenceLeaseHandle;
  const fullyReleased = (): boolean => !markerPending && fileClosed;
  const currentDebtOwner = (): PersistenceLeaseDebtOwner => ({
    artifacts: markerPending ? [{ scope, marker: owned.marker }] : [],
    release: async () => handle.release()
  });
  const release = async (): Promise<void> => {
    if (markerPending) {
      // Exact unlink is the release linearization point. A concurrent gated
      // acquisition either observes this marker, observes its absence after
      // unlink, or fails closed if the entry disappears mid-inspection.
      // Release itself must remain deletion-only so a fire-and-forget close
      // cannot recreate lease entries after parent teardown has begun.
      let markerFailure: unknown;
      try {
        await exactUnlink(scope, owned, "Persistence lease marker");
        markerPending = false;
        notifyDebtArtifactsReleased([{ scope, marker: owned.marker }]);
      } catch (error) {
        if (exactMarkerOwnershipIsTerminal(error)) {
          markerPending = false;
          notifyDebtArtifactsReleased([{ scope, marker: owned.marker }]);
          if (errorCode(error) !== "ENOENT") markerFailure = error;
        } else markerFailure = error;
      }
      let closeFailure: unknown;
      if (!markerPending && !fileClosed) {
        try {
          await owned.file.close();
          fileClosed = true;
        } catch (error) {
          closeFailure = error;
        }
      }
      const failures = [markerFailure, closeFailure].filter((error) => error !== undefined);
      if (failures.length > 0) {
        const debtOwner = currentDebtOwner();
        if (debtOwner.artifacts.length > 0) {
          const primary = failures.find((error): error is Error => error instanceof Error);
          throw new PersistenceLeaseOwnershipError(
            primary?.message ?? "Persistence lease exact release retained current-process ownership debt",
            failures,
            debtOwner
          );
        }
        if (failures.length === 1) throw failures[0];
        throw new AggregateError(failures, "Persistence lease release failed after ownership became terminal");
      }
    }
    if (!markerPending && !fileClosed) {
      await owned.file.close();
      fileClosed = true;
    }
  };
  handle = {
    scope,
    role,
    marker: owned.marker,
    release: () => {
      if (fullyReleased()) return Promise.resolve();
      if (releasePromise === undefined) {
        const attempt = release().catch((error: unknown) => {
          if (error instanceof PersistenceLeaseOwnershipError) {
            throw retainPersistenceLeaseOwnershipError(error);
          }
          throw error;
        });
        releasePromise = attempt;
        void attempt.then(
          () => undefined,
          () => {
            if (!fullyReleased() && releasePromise === attempt) releasePromise = undefined;
          }
        );
      }
      return releasePromise;
    }
  };
  return handle;
}

/**
 * Acquire a later role against an already-pinned lifetime scope. Path-based
 * steps bracket their work with canonical parent and namespace device/inode
 * checks, rejecting replacements observed at those boundaries instead of
 * deliberately re-resolving into a fresh namespace. Node does not expose the
 * dirfd-relative protocol needed to make each check and operation indivisible.
 *
 * @param scope - Scope captured by a lifetime holder or explicit resolver.
 * @param options - Role and bounded gate timing.
 * @returns Exact owned handle whose marker stays open until release.
 * @throws {PersistenceLeaseIntegrityError} If the parent identity changed.
 * @example
 * const publisher = await acquirePersistenceLeaseInScope(lifetime.scope, { role: "publisher" });
 * await publisher.release();
 */
export async function acquirePersistenceLeaseInScope(
  scope: PersistenceLeaseScope,
  options: AcquirePersistenceLeaseInScopeOptions
): Promise<PersistenceLeaseHandle> {
  try {
    return await acquirePersistenceLeaseInScopeOnce(scope, options);
  } catch (error) {
    if (error instanceof PersistenceLeaseOwnershipError) {
      throw retainPersistenceLeaseOwnershipError(error);
    }
    throw error;
  }
}

async function acquirePersistenceLeaseInScopeOnce(
  scope: PersistenceLeaseScope,
  options: AcquirePersistenceLeaseInScopeOptions
): Promise<PersistenceLeaseHandle> {
  validateRole(options.role);
  const timing = gateOptions(options);
  await revalidatePersistenceLeaseScope(scope);
  const pinnedScope = await ensureScopeDirectories(scope);
  await drainProcessDebtForScope(pinnedScope);
  const gate = await acquireGate(pinnedScope, timing);
  let owned: OwnedMarker | undefined;
  try {
    const active = await listLeaseMarkers(pinnedScope);
    const heldRoles = conflictingRoles(options.role, active);
    if (heldRoles.length > 0) throw new PersistenceLeaseConflictError(options.role, heldRoles);
    const nonce = randomBytes(16).toString("hex");
    const id = markerName(options.role, process.pid, nonce);
    owned = await publishMarker(pinnedScope, id, storedMarker(pinnedScope, "lease", nonce, options.role));
  } catch (error) {
    if (error instanceof PersistenceLeaseOwnershipError) {
      const debtOwner = composePersistenceLeaseDebtOwners([error.debtOwner, ownedMarkerDebt(pinnedScope, gate)]);
      throw new PersistenceLeaseOwnershipError(
        "Persistence lease acquisition retained marker and gate ownership debt",
        [error],
        debtOwner
      );
    }
    try {
      await releaseGate(pinnedScope, gate);
    } catch (rollbackError) {
      const debtOwner =
        rollbackError instanceof PersistenceLeaseOwnershipError
          ? rollbackError.debtOwner
          : ownedMarkerDebt(pinnedScope, gate);
      throw new PersistenceLeaseOwnershipError(
        "Persistence lease acquisition failed and gate rollback was incomplete",
        [error, rollbackError],
        debtOwner
      );
    }
    throw error;
  }
  if (!owned) throw new PersistenceLeaseIntegrityError("Persistence lease acquisition did not publish a marker");
  const handle = persistenceLeaseHandle(pinnedScope, options.role, owned);
  try {
    await releaseGate(pinnedScope, gate);
  } catch (gateError) {
    const gateDebt =
      gateError instanceof PersistenceLeaseOwnershipError ? gateError.debtOwner : ownedMarkerDebt(pinnedScope, gate);
    const debtOwner = composePersistenceLeaseDebtOwners([gateDebt, leaseHandleDebt(handle)]);
    throw new PersistenceLeaseOwnershipError(
      "Persistence lease acquisition published a marker but gate release was incomplete",
      [gateError],
      debtOwner
    );
  }
  return handle;
}

/**
 * Inspect authoritative markers without recovering, stealing, or creating any.
 * Missing lease directories produce an empty inspection; malformed or unsafe
 * existing namespace components fail closed.
 *
 * @param target - Persistence target path and semantic family key.
 * @returns Current gate and lease markers for the canonical scope.
 * @throws {PersistenceLeaseIntegrityError} If an existing namespace is unsafe.
 * @example
 * const snapshot = await inspectPersistenceLeases({ targetPath: "/tmp/vault.embed.db", familyKey: "embed-db" });
 */
export async function inspectPersistenceLeases(target: PersistenceLeaseTarget): Promise<PersistenceLeaseInspection> {
  const resolvedScope = await resolvePersistenceLeaseScope(target);
  let scope: PersistenceLeaseScope;
  try {
    scope = await pinExistingScopeDirectories(resolvedScope);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { scope: resolvedScope, gate: null, leases: [], candidates: [] };
    throw error;
  }
  let gate: PersistenceLeaseMarker | null = null;
  try {
    const trusted = await readTrustedMarker(scope, GATE_NAME);
    try {
      gate = publicMarker(GATE_NAME, trusted.marker);
    } finally {
      await trusted.file.close();
    }
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  const scan = await scanScopeDirectory(scope);
  return { scope, gate, leases: scan.leases, candidates: scan.candidates };
}

function assertMarkerId(markerId: unknown): asserts markerId is string {
  if (
    markerId !== GATE_NAME &&
    (typeof markerId !== "string" || (!LEASE_MARKER_RE.test(markerId) && !CANDIDATE_MARKER_RE.test(markerId)))
  ) {
    throw new TypeError("Persistence lease recovery marker ID is invalid");
  }
}

function assertSameHostEsrch(marker: PersistenceLeaseInspectableMarker): void {
  const sameHost =
    marker.kind === "candidate" ? marker.hostDigest === currentHostDigest() : marker.hostname === os.hostname();
  if (!sameHost) {
    throw new PersistenceLeaseRecoveryError("Persistence lease recovery requires the marker's exact host");
  }
  try {
    process.kill(marker.pid, 0);
  } catch (error) {
    if (errorCode(error) === "ESRCH") return;
    throw new PersistenceLeaseRecoveryError("Persistence lease creator liveness could not be disproved");
  }
  throw new PersistenceLeaseRecoveryError("Persistence lease creator is still running");
}

async function recoverExactCandidate(
  scope: PersistenceLeaseScope,
  markerId: string,
  assertQuiescent: RecoverPersistenceLeaseOptions["assertQuiescent"]
): Promise<PersistenceLeaseCandidateMarker> {
  await revalidatePersistenceLeaseScope(scope);
  const marker = candidateMarker(markerId);
  const markerPath = path.join(scope.directory, markerId);
  const openedFile = await openIdentityPinnedRegular(markerPath, "Persistence lease staging marker", "candidate");
  const { file } = openedFile;
  try {
    const opened = openedFile.stats;
    assertSameHostEsrch(marker);
    if (!(await assertQuiescent({ scope, marker }))) {
      throw new PersistenceLeaseRecoveryError("Persistence lease recovery requires proven quiescence");
    }
    await revalidatePersistenceLeaseScope(scope);
    const current = await openIdentityPinnedRegular(markerPath, "Persistence lease staging marker", "candidate");
    try {
      if (!sameIdentity(identity(opened), identity(current.stats))) {
        throw new PersistenceLeaseIntegrityError("Persistence lease staging marker changed before recovery");
      }
    } finally {
      await current.file.close();
    }
    await revalidatePersistenceLeaseScope(scope);
    await fs.unlink(markerPath);
    await revalidatePersistenceLeaseScope(scope);
    return marker;
  } finally {
    await file.close();
  }
}

async function recoverExactMarker(
  scope: PersistenceLeaseScope,
  markerId: string,
  assertQuiescent: RecoverPersistenceLeaseOptions["assertQuiescent"]
): Promise<PersistenceLeaseMarker> {
  const trusted = await readTrustedMarker(scope, markerId);
  const marker = publicMarker(markerId, trusted.marker);
  const owned: OwnedMarker = {
    path: path.join(scope.directory, markerId),
    file: trusted.file,
    identity: trusted.identity,
    bytes: trusted.bytes,
    marker
  };
  try {
    assertSameHostEsrch(marker);
    if (!(await assertQuiescent({ scope, marker }))) {
      throw new PersistenceLeaseRecoveryError("Persistence lease recovery requires proven quiescence");
    }
    await exactUnlink(scope, owned, "Persistence lease recovery marker");
    return marker;
  } finally {
    await trusted.file.close();
  }
}

/**
 * Recover one explicitly inspected crash orphan. This API never runs during
 * normal acquisition. It requires exact same-host metadata, an `ESRCH`
 * liveness result, and an awaited caller-owned quiescence proof. A blocked gate
 * must itself be explicitly recovered before any lifetime marker.
 *
 * @param options - Exact inspected marker plus the mandatory quiescence proof.
 * @returns Metadata for the exact marker that was removed.
 * @throws {PersistenceLeaseRecoveryError} If host, liveness, or quiescence is unproven.
 * @throws {PersistenceLeaseIntegrityError} If the marker changed or is unsafe.
 * @example
 * await recoverPersistenceLease({
 *   targetPath: "/tmp/vault.embed.db",
 *   familyKey: "embed-db",
 *   markerId: snapshot.leases[0]?.id ?? "",
 *   assertQuiescent: async () => true
 * });
 */
export async function recoverPersistenceLease(
  options: RecoverPersistenceLeaseOptions
): Promise<PersistenceLeaseInspectableMarker> {
  try {
    assertMarkerId(options.markerId);
    const timing = gateOptions(options);
    const resolvedScope = await resolvePersistenceLeaseScope(options);
    const scope = await pinExistingScopeDirectories(resolvedScope);
    if (CANDIDATE_MARKER_RE.test(options.markerId)) {
      return recoverExactCandidate(scope, options.markerId, options.assertQuiescent);
    }
    if (options.markerId === GATE_NAME) {
      return recoverExactMarker(scope, options.markerId, options.assertQuiescent);
    }
    const gate = await acquireGate(scope, timing);
    try {
      return await recoverExactMarker(scope, options.markerId, options.assertQuiescent);
    } finally {
      await releaseGate(scope, gate);
    }
  } catch (error) {
    if (error instanceof PersistenceLeaseOwnershipError) {
      throw retainPersistenceLeaseOwnershipError(error);
    }
    throw error;
  }
}
