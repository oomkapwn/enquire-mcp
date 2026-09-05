import { createHash, randomBytes } from "node:crypto";
import { promises as fs, constants as fsConstants } from "node:fs";
import * as path from "node:path";
import { removeArtifact, removeArtifactDirectory } from "./erasure-receipt.js";

const TOKEN_BYTES = 24;
const TOKEN_HEX_LENGTH = TOKEN_BYTES * 2;
const STAGED_ARTIFACT_BASENAME = "artifact";
const STAGED_EMBED_ARTIFACT_BASENAME = `${STAGED_ARTIFACT_BASENAME}.embed.db`;
const STAGED_LEASE_ROOT_BASENAME = ".enquire-mcp-leases";
const STAGED_LEASE_SCOPE_BASENAME_PATTERN = /^[0-9a-f]{64}$/u;
const STAGED_EMBED_LEASE_SCOPE_COUNT = 2;
const SQLITE_SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"] as const;
const GENERATED_ENTRY_PATTERN = new RegExp(
  `^(.+)\\.enquire-(tmp|stage)-([0-9a-f]{${TOKEN_HEX_LENGTH}})(?![\\s\\S])`,
  "is"
);

interface FileIdentity {
  dev: bigint;
  ino: bigint;
}

interface OwnedTemp {
  tempPath: string;
  tempIdentity: FileIdentity;
  handle: import("node:fs/promises").FileHandle | null;
  stagePath: string | null;
  stageIdentity: FileIdentity | null;
}

interface GeneratedEntry {
  finalBasename: string;
  kind: "tmp" | "stage";
  token: string;
}

interface InspectedGeneratedEntry {
  generated: GeneratedEntry;
  stagedChildren: string[];
  leaseScopeDirectories: string[];
}

/** Result of publishing one sensitive filesystem artifact. @internal */
export interface SensitiveArtifactReceipt {
  /** SHA-256 of the held staged descriptor after the producer returns. */
  sha256: string;
}

/** Callback-scoped sensitive artifact ready for caller-controlled publication. @internal */
export interface PreparedSensitiveArtifact {
  /** Exact prepared path, valid only while the callback is active. */
  readonly stagedPath: string;
  /** SHA-256 of the stable, fsync'd staged generation. */
  readonly sha256: string;
  /** Atomically rename the still-unchanged staged generation onto its final path. */
  commit(): Promise<void>;
}

/**
 * Native/path-only producer used by {@link publishSensitiveArtifact}.
 *
 * The destination is an already-created mode-0600 regular file inside an
 * unpredictable, mode-0700 staging directory owned by the publisher. The
 * producer must write that file in place; replacing its directory entry is
 * rejected before publication.
 *
 * @param stagedPath - Exclusive staged file to fill in place.
 * @returns A promise that resolves after the producer has closed/flushed its writer.
 * @internal
 */
export type SensitiveArtifactPathWriter = (stagedPath: string) => Promise<void>;

/**
 * Atomically publish sensitive bytes without following a pre-planted temp or
 * final-leaf symlink.
 *
 * Byte sources use an unpredictable same-parent `O_CREAT|O_EXCL` file. Native
 * path-only sources use an unpredictable same-parent mode-0700 staging
 * directory containing an exclusive mode-0600 file. In both cases the owned
 * descriptor remains open through the write, is chmod'd and fsync'd before a
 * final `rename(2)`, and cleanup revalidates the reserved entry's exact BigInt
 * identity before removal.
 * A missing, regular-file, or symlink final leaf is replaceable; directories
 * and special objects are refused. Renaming the temporary inode onto a final
 * symlink leaf never opens or truncates the symlink target.
 *
 * This guarantee assumes the containing parent, its path components, and the
 * reserved staged inode's contents remain stable after the producer returns.
 * Node does not expose the dirfd-relative rename/unlink protocol needed to
 * defeat active same-account entry/content tampering; existing/custom parents
 * remain operator-managed. The file is fsync'd but the parent directory is not,
 * so power-loss durability is not claimed.
 *
 * @param finalPath - Final artifact path whose parent already exists.
 * @param source - Bytes to write, or a native producer that fills a staged path.
 * @param maxBytes - Maximum bytes admitted from the held staged descriptor.
 * @returns SHA-256 receipt for the promoted staged generation under that stability boundary.
 * @throws If the limit is invalid or exclusive reservation, writing, bounded identity validation, sync, or rename fails.
 * @example
 * await publishSensitiveArtifact("/tmp/cache.json", JSON.stringify({ version: 1 }));
 * @internal
 */
export async function publishSensitiveArtifact(
  finalPath: string,
  source: string | Uint8Array | SensitiveArtifactPathWriter,
  maxBytes = Number.MAX_SAFE_INTEGER
): Promise<SensitiveArtifactReceipt> {
  return withPreparedSensitiveArtifact(
    finalPath,
    source,
    async (prepared) => {
      await prepared.commit();
      return { sha256: prepared.sha256 };
    },
    maxBytes
  );
}

/**
 * Prepare a sensitive artifact and expose one callback-scoped atomic commit.
 *
 * The staged inode remains held after it is written, chmod'd, fsync'd, and
 * hashed. `commit()` revalidates the complete descriptor receipt, refuses a
 * SQLite stage with live WAL/SHM/rollback-journal sidecars, closes the held
 * descriptor, and atomically renames the exact owned inode onto `finalPath`.
 * Returning or throwing without commit erases the owned stage best-effort.
 * A commit started inside the callback is awaited even if the callback forgets
 * to await it; leaked callback state cannot publish after the callback settles.
 *
 * For a native writer targeting an exact `.embed.db` final path, `stagedPath`
 * also ends in `.embed.db` so the normal embedding path admission remains in
 * force. Crash cleanup recognizes that staged main plus only its exact SQLite
 * `-wal`, `-shm`, and `-journal` children and a fully released, exact empty
 * two-scope lease namespace. Any retained lease marker fails closed.
 *
 * @param finalPath - Final artifact path whose parent already exists.
 * @param source - Bytes to write, or a native producer that fills a staged path.
 * @param use - Callback that validates the prepared generation and optionally commits it.
 * @param maxBytes - Maximum bytes admitted from the held staged descriptor.
 * @returns The callback result after any started commit settles and cleanup completes.
 * @throws If preparation, bounded validation, callback work, or atomic commit fails.
 * @example
 * await withPreparedSensitiveArtifact(
 *   "/tmp/index.embed.db",
 *   async (stagedPath) => buildIndex(stagedPath),
 *   async (prepared) => prepared.commit()
 * );
 * @internal
 */
export async function withPreparedSensitiveArtifact<Result>(
  finalPath: string,
  source: string | Uint8Array | SensitiveArtifactPathWriter,
  use: (prepared: PreparedSensitiveArtifact) => Promise<Result>,
  maxBytes = Number.MAX_SAFE_INTEGER
): Promise<Result> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("Sensitive artifact publish limit must be a non-negative safe integer");
  }
  const owned =
    typeof source === "function" ? await reserveStagedArtifact(finalPath) : await reserveSiblingTemp(finalPath);
  let callbackActive = true;
  let callbackCompleted = false;
  let committed = false;
  const commitState: { attempt: Promise<void> | null } = { attempt: null };
  try {
    if (typeof source === "function") {
      await source(owned.tempPath);
      await removeOwnedEmptyEmbedLeaseNamespace(owned);
    } else {
      await owned.handle?.writeFile(source);
    }

    const handle = owned.handle;
    if (!handle) throw new Error("Sensitive artifact publisher lost its owned file descriptor");
    const afterWrite = await handle.stat({ bigint: true });
    if (!afterWrite.isFile() || !sameFileIdentity(afterWrite, owned.tempIdentity)) {
      throw new Error("Sensitive artifact producer replaced its owned temporary file");
    }
    if (afterWrite.size > BigInt(maxBytes)) {
      throw new Error("Sensitive artifact exceeds the bounded publish limit");
    }
    await handle.chmod(0o600);
    await handle.sync();
    const sha256 = await sha256StableHandle(handle, maxBytes);
    await assertPathStillOwned(owned.tempPath, owned.tempIdentity);
    const preparedStat = await handle.stat({ bigint: true });
    const prepared: PreparedSensitiveArtifact = {
      stagedPath: owned.tempPath,
      sha256,
      commit: () => {
        if (!callbackActive) {
          return Promise.reject(new Error("Sensitive artifact commit escaped its preparation callback"));
        }
        commitState.attempt ??= (async () => {
          const beforeCommit = await handle.stat({ bigint: true });
          if (!sameStableFileReceipt(preparedStat, beforeCommit)) {
            throw new Error("Sensitive artifact changed after it was prepared");
          }
          await assertNoStagedSqliteSidecars(owned.tempPath);
          await handle.close();
          owned.handle = null;
          await assertPathStillOwned(owned.tempPath, owned.tempIdentity);
          await assertReplaceableFinalLeaf(finalPath);
          await fs.rename(owned.tempPath, finalPath);
          committed = true;
          // Publication committed at rename. A best-effort empty-stage cleanup
          // must never turn that success into a reported failure/retry ambiguity.
          if (owned.stagePath) await removeOwnedEmptyStage(owned.stagePath, owned.stageIdentity).catch(() => {});
        })();
        return commitState.attempt;
      }
    };
    const result = await use(prepared);
    callbackCompleted = true;
    callbackActive = false;
    if (commitState.attempt) await commitState.attempt;
    return result;
  } finally {
    callbackActive = false;
    if (!callbackCompleted && commitState.attempt) await commitState.attempt.catch(() => {});
    if (owned.handle) await owned.handle.close().catch(() => {});
    if (!committed) await cleanupOwnedTemp(owned);
  }
}

async function assertReplaceableFinalLeaf(finalPath: string): Promise<void> {
  let entry: import("node:fs").Stats;
  try {
    entry = await fs.lstat(finalPath);
  } catch (err) {
    if (errnoCode(err) === "ENOENT") return;
    throw err;
  }
  if (!entry.isFile() && !entry.isSymbolicLink()) {
    throw new Error("Refusing to replace a non-regular sensitive-artifact destination");
  }
}

/**
 * Hash a regular artifact through a non-symlink descriptor.
 *
 * @param file - Artifact path to hash.
 * @param maxBytes - Maximum bytes admitted from the held descriptor.
 * @returns Lowercase SHA-256 hex for a stable descriptor snapshot.
 * @throws If the path is a symlink/non-file, exceeds `maxBytes`, changes while read, or cannot be read safely.
 * @example
 * const digest = await sha256SensitiveArtifact("/tmp/index.hnsw.bin");
 * @internal
 */
export async function sha256SensitiveArtifact(file: string, maxBytes = Number.MAX_SAFE_INTEGER): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("Sensitive artifact hash limit must be a non-negative safe integer");
  }
  const handle = await openRegularNoFollow(file);
  try {
    return await sha256StableHandle(handle, maxBytes);
  } finally {
    await handle.close();
  }
}

/**
 * Inspect one bounded sensitive artifact through a held read-only descriptor.
 *
 * The callback receives the already-admitted descriptor and its exact byte
 * size. The descriptor is kept open until the callback settles, then its
 * identity, size, mtime, and ctime are compared with the pre-callback receipt.
 * Callers can therefore parse sparse headers/records without materializing the
 * whole artifact and without accidentally following a symlink leaf.
 *
 * @param file - Artifact path to inspect.
 * @param maxBytes - Maximum bytes admitted from the held descriptor.
 * @param inspect - Read-only parser over the held descriptor and stable size.
 * @returns The parser result after the descriptor receipt remains unchanged.
 * @throws If the leaf is unsafe, the limit is invalid/exceeded, the parser fails, or the descriptor changes.
 * @example
 * const size = await inspectSensitiveArtifact("/tmp/index.bin", 1024, async (_handle, bytes) => bytes);
 * @internal
 */
export async function inspectSensitiveArtifact<Result>(
  file: string,
  maxBytes: number,
  inspect: (handle: import("node:fs/promises").FileHandle, size: bigint) => Promise<Result>
): Promise<Result> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("Sensitive artifact inspection limit must be a non-negative safe integer");
  }
  const handle = await openRegularNoFollow(file);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new Error("Refusing to inspect a non-regular sensitive artifact");
    if (before.size > BigInt(maxBytes)) throw new Error("Sensitive artifact exceeds its inspection limit");
    const result = await inspect(handle, before.size);
    const after = await handle.stat({ bigint: true });
    if (
      !sameFileIdentity(before, after) ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    ) {
      throw new Error("Sensitive artifact changed while being inspected");
    }
    return result;
  } finally {
    await handle.close();
  }
}

/**
 * Read one UTF-8 sensitive artifact through a non-symlink regular-file
 * descriptor and reject a generation that changes during the read.
 *
 * @param file - Artifact path to read.
 * @param maxBytes - Maximum encoded bytes accepted from the held descriptor.
 * @returns UTF-8 text from one stable regular-file generation.
 * @throws If the leaf is a symlink/special object, exceeds `maxBytes`, changes during the read, or cannot be read.
 * @example
 * const raw = await readSensitiveArtifactText("/tmp/cache.json", 64 * 1024 * 1024);
 * @internal
 */
export async function readSensitiveArtifactText(file: string, maxBytes = Number.MAX_SAFE_INTEGER): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("Sensitive artifact read limit must be a non-negative safe integer");
  }
  const handle = await openRegularNoFollow(file);
  try {
    const before = await handle.stat({ bigint: true });
    if (before.size > BigInt(maxBytes)) throw new Error("Sensitive artifact exceeds its read limit");
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const remaining = maxBytes - total;
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining + 1));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) throw new Error("Sensitive artifact exceeds its read limit");
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const after = await handle.stat({ bigint: true });
    if (
      !sameFileIdentity(before, after) ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    ) {
      throw new Error("Sensitive artifact changed while being read");
    }
    return Buffer.concat(chunks, total).toString("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * Validate a SQLite main/WAL/SHM/rollback-journal family before a native
 * handle may open it.
 *
 * Every present leaf must be a singly linked regular file. A fresh main file
 * is admitted only when all three derived sidecars are also absent. This
 * prevents SQLite from following a stable symlink/junction leaf recognized by
 * `lstat`, or writing through a hardlink into another pathname. The check
 * assumes the containing parent remains stable until the native open; active entry replacement after
 * this receipt is outside the available Node path-based boundary.
 *
 * @param mainFile - Exact admitted SQLite main-file path.
 * @returns `true` when the main file exists, `false` when the whole family is absent.
 * @throws If inspection fails or any present family leaf is unsafe or ambiguous.
 * @example
 * const exists = await preflightSqliteArtifactFamily("/tmp/index.fts5.db");
 * @internal
 */
export async function preflightSqliteArtifactFamily(mainFile: string): Promise<boolean> {
  const targets = [mainFile, `${mainFile}-wal`, `${mainFile}-shm`, `${mainFile}-journal`];
  const present: boolean[] = [];
  for (const target of targets) {
    let entry: import("node:fs").BigIntStats;
    try {
      entry = await fs.lstat(target, { bigint: true });
    } catch (err) {
      if (errnoCode(err) === "ENOENT") {
        present.push(false);
        continue;
      }
      throw new Error("SQLite artifact family could not be inspected", { cause: err });
    }
    if (!entry.isFile() || entry.nlink !== 1n) {
      throw new Error("Refusing an unsafe SQLite artifact family");
    }
    present.push(true);
  }
  const mainExists = present[0] === true;
  if (!mainExists && present.slice(1).some(Boolean)) {
    throw new Error("Refusing SQLite sidecars without their main file");
  }
  return mainExists;
}

/**
 * Recover the final artifact basename encoded in a publisher temp/stage name.
 *
 * @param entryBasename - One directory-entry basename.
 * @returns The final artifact basename, or `null` for names outside the reserved namespace.
 * @example
 * sensitiveArtifactFinalBasename("cache.json.enquire-tmp-0123456789abcdef0123456789abcdef0123456789abcdef");
 * // "cache.json"
 * @internal
 */
export function sensitiveArtifactFinalBasename(entryBasename: string): string | null {
  return parseGeneratedEntry(entryBasename)?.finalBasename ?? null;
}

/**
 * Validate one generated temp/stage without modifying it.
 *
 * @param entryPath - Exact generated temp or stage path.
 * @returns `true` when a recognized entry exists, `false` when it is absent.
 * @throws If the name or on-disk shape is outside the reserved namespace.
 * @example
 * await preflightSensitiveArtifactTempEntry("/tmp/cache.json.enquire-tmp-<48-hex>");
 * @internal
 */
export async function preflightSensitiveArtifactTempEntry(entryPath: string): Promise<boolean> {
  return (await inspectSensitiveArtifactTempEntry(entryPath)) !== null;
}

/**
 * Remove one crash-leftover publisher temp/stage entry by its exact generated name.
 *
 * Regular temps and symlink leaves are unlinked directly. A stage is removed
 * only when it is a non-symlink directory containing either the single fixed
 * staged-artifact entry or, for an `.embed.db` target, that exact main plus its
 * recognized SQLite sidecars; recursive deletion is never used.
 *
 * @param entryPath - Exact generated temp or stage path.
 * @returns `true` when an entry was removed, `false` when it was already absent.
 * @throws If the name or on-disk shape is outside the reserved publisher namespace.
 * @example
 * await removeSensitiveArtifactTempEntry("/tmp/cache.json.enquire-stage-<48-hex>");
 * @internal
 */
export async function removeSensitiveArtifactTempEntry(entryPath: string): Promise<boolean> {
  const inspected = await inspectSensitiveArtifactTempEntry(entryPath);
  if (!inspected) return false;
  if (inspected.generated.kind === "tmp") {
    await removeArtifact(entryPath, "generated temporary artifact");
    return true;
  }
  await removeInspectedEmptyEmbedLeaseNamespace(entryPath, inspected.leaseScopeDirectories);
  for (const child of orderedStagedChildrenForRemoval(inspected)) {
    await removeArtifact(path.join(entryPath, child), "staged generation member");
  }
  await removeArtifactDirectory(entryPath, "staged generation directory");
  return true;
}

async function inspectSensitiveArtifactTempEntry(entryPath: string): Promise<InspectedGeneratedEntry | null> {
  const generated = parseGeneratedEntry(path.basename(entryPath));
  if (!generated) throw new Error("Refusing to erase an unrecognized sensitive-artifact temporary entry");
  let entryStat: import("node:fs").Stats;
  try {
    entryStat = await fs.lstat(entryPath);
  } catch (err) {
    if (errnoCode(err) === "ENOENT") return null;
    throw err;
  }
  if (generated.kind === "tmp") {
    if (!entryStat.isFile() && !entryStat.isSymbolicLink()) {
      throw new Error("Refusing to erase a malformed sensitive-artifact temporary entry");
    }
    return { generated, stagedChildren: [], leaseScopeDirectories: [] };
  }
  if (entryStat.isSymbolicLink() || !entryStat.isDirectory()) {
    throw new Error("Refusing to erase a malformed sensitive-artifact staging directory");
  }
  const children = await fs.readdir(entryPath);
  const expectedChildren = stagedArtifactFamilyBasenames(generated.finalBasename);
  const matchedExpected = new Set<string>();
  let leaseScopeDirectories: string[] = [];
  for (const child of children) {
    const childPath = path.join(entryPath, child);
    if (
      stagedArtifactMainBasename(generated.finalBasename) === STAGED_EMBED_ARTIFACT_BASENAME &&
      child === STAGED_LEASE_ROOT_BASENAME
    ) {
      if (leaseScopeDirectories.length > 0) {
        throw new Error("Refusing to erase a sensitive-artifact stage with an ambiguous lease namespace");
      }
      leaseScopeDirectories = await inspectEmptyEmbedLeaseNamespace(entryPath);
      continue;
    }
    let expectedChild = expectedChildren.find((candidate) => candidate === child);
    if (!expectedChild) {
      const aliases: string[] = [];
      for (const candidate of expectedChildren) {
        if (await sameCanonicalDirectoryEntry(childPath, path.join(entryPath, candidate))) aliases.push(candidate);
      }
      if (aliases.length !== 1) {
        if (
          expectedChildren.some((candidate) => normalizedEntrySpelling(candidate) === normalizedEntrySpelling(child))
        ) {
          throw new Error("Refusing to erase a sensitive-artifact stage with an ambiguous child entry");
        }
        throw new Error("Refusing to erase a sensitive-artifact stage with unexpected entries");
      }
      expectedChild = aliases[0];
    }
    if (!expectedChild || matchedExpected.has(expectedChild)) {
      throw new Error("Refusing to erase a sensitive-artifact stage with an ambiguous child entry");
    }
    matchedExpected.add(expectedChild);
    const childStat = await fs.lstat(childPath);
    if (!childStat.isFile() && !childStat.isSymbolicLink()) {
      throw new Error("Refusing to erase a malformed sensitive-artifact staged file");
    }
  }
  return {
    generated,
    stagedChildren: children.filter((child) => child !== STAGED_LEASE_ROOT_BASENAME),
    leaseScopeDirectories
  };
}

function orderedStagedChildrenForRemoval(inspected: InspectedGeneratedEntry): string[] {
  const mainBasename = stagedArtifactMainBasename(inspected.generated.finalBasename);
  return [...inspected.stagedChildren].sort(
    (left, right) => Number(left === mainBasename) - Number(right === mainBasename)
  );
}

/**
 * Remove every recognized crash-leftover temp/stage for one final artifact.
 *
 * @param finalPath - Final artifact whose generated siblings should be erased.
 * @returns Number of generated sibling entries removed.
 * @example
 * await removeSensitiveArtifactTemps("/tmp/cache.json");
 * @internal
 */
export async function removeSensitiveArtifactTemps(finalPath: string): Promise<number> {
  const plan = await planSensitiveArtifactTemps(finalPath);
  let removed = 0;
  for (const entryPath of plan) {
    if (await removeSensitiveArtifactTempEntry(entryPath)) removed += 1;
  }
  return removed;
}

/**
 * Validate every generated crash-leftover sibling before an eraser commits.
 *
 * @param finalPath - Final artifact whose generated siblings should be checked.
 * @returns `true` when at least one generated sibling exists.
 * @throws If any recognized sibling has an unsafe shape.
 * @example
 * await preflightSensitiveArtifactTemps("/tmp/cache.json");
 * @internal
 */
export async function preflightSensitiveArtifactTemps(finalPath: string): Promise<boolean> {
  return (await planSensitiveArtifactTemps(finalPath)).length > 0;
}

async function planSensitiveArtifactTemps(finalPath: string): Promise<string[]> {
  const parent = path.dirname(finalPath);
  const finalBasename = path.basename(finalPath);
  let entries: string[];
  try {
    entries = await fs.readdir(parent);
  } catch (err) {
    if (errnoCode(err) === "ENOENT") return [];
    throw err;
  }
  const plan: string[] = [];
  for (const entry of entries) {
    const generated = parseGeneratedEntry(entry);
    if (!generated) continue;
    const expectedEntry = `${finalBasename}.enquire-${generated.kind}-${generated.token}`;
    if (entry !== expectedEntry) {
      if (!(await sameCanonicalDirectoryEntry(path.join(parent, entry), path.join(parent, expectedEntry)))) {
        if (normalizedEntrySpelling(entry) === normalizedEntrySpelling(expectedEntry)) {
          throw new Error("Refusing sensitive-artifact erasure: temporary basename spelling is ambiguous");
        }
        continue;
      }
    }
    const entryPath = path.join(parent, entry);
    await preflightSensitiveArtifactTempEntry(entryPath);
    plan.push(entryPath);
  }
  return plan;
}

async function reserveSiblingTemp(finalPath: string): Promise<OwnedTemp> {
  const parent = path.dirname(finalPath);
  const basename = path.basename(finalPath);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const tempPath = path.join(parent, `${basename}.enquire-tmp-${randomToken()}`);
    let handle: import("node:fs/promises").FileHandle | null = null;
    let tempIdentity: FileIdentity | null = null;
    try {
      handle = await fs.open(tempPath, "wx+", 0o600);
      tempIdentity = fileIdentity(await handle.stat({ bigint: true }));
      assertUsableIdentity(tempIdentity);
      await handle.chmod(0o600);
      return {
        tempPath,
        tempIdentity,
        handle,
        stagePath: null,
        stageIdentity: null
      };
    } catch (err) {
      await handle?.close().catch(() => {});
      if (tempIdentity) {
        await cleanupOwnedTemp({
          tempPath,
          tempIdentity,
          handle: null,
          stagePath: null,
          stageIdentity: null
        });
      }
      if (errnoCode(err) !== "EEXIST" || attempt === 3) throw err;
    }
  }
  throw new Error("Unable to reserve a sensitive-artifact temporary file");
}

async function reserveStagedArtifact(finalPath: string): Promise<OwnedTemp> {
  const parent = path.dirname(finalPath);
  const basename = path.basename(finalPath);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const stagePath = path.join(parent, `${basename}.enquire-stage-${randomToken()}`);
    const tempPath = path.join(stagePath, stagedArtifactMainBasename(basename));
    let stageIdentity: FileIdentity | null = null;
    let tempIdentity: FileIdentity | null = null;
    let handle: import("node:fs/promises").FileHandle | null = null;
    try {
      await fs.mkdir(stagePath, { mode: 0o700 });
      const stage = await fs.lstat(stagePath, { bigint: true });
      if (stage.isSymbolicLink() || !stage.isDirectory()) {
        throw new Error("Sensitive artifact staging path is not the directory just reserved");
      }
      stageIdentity = fileIdentity(stage);
      assertUsableIdentity(stageIdentity);
      // mkdir(0700) can only become more restrictive under umask. Do not chmod
      // this pathname after admission: a path-based chmod would follow a leaf
      // swapped in between checks. An overly restrictive umask instead makes
      // the exclusive child open fail closed.
      handle = await fs.open(tempPath, "wx+", 0o600);
      tempIdentity = fileIdentity(await handle.stat({ bigint: true }));
      assertUsableIdentity(tempIdentity);
      await handle.chmod(0o600);
      return {
        tempPath,
        tempIdentity,
        handle,
        stagePath,
        stageIdentity
      };
    } catch (err) {
      await handle?.close().catch(() => {});
      if (tempIdentity) {
        await cleanupOwnedTemp({ tempPath, tempIdentity, handle: null, stagePath, stageIdentity });
      } else if (stageIdentity) {
        await removeOwnedEmptyStage(stagePath, stageIdentity).catch(() => {});
      }
      if (errnoCode(err) === "EEXIST" && !stageIdentity && attempt < 3) continue;
      throw err;
    }
  }
  throw new Error("Unable to reserve a sensitive-artifact staging directory");
}

async function openRegularNoFollow(file: string): Promise<import("node:fs/promises").FileHandle> {
  const before = await fs.lstat(file, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error("Refusing to open a non-regular sensitive artifact");
  }
  const flags =
    fsConstants.O_RDONLY | (process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  const handle = await fs.open(file, flags);
  try {
    const descriptor = await handle.stat({ bigint: true });
    // On Windows libuv's lstat and descriptor stat can expose different
    // identity surfaces for the same file. The caller's ownership proof is
    // therefore compared fstat-to-fstat; POSIX additionally binds the lstat
    // leaf to the descriptor opened with O_NOFOLLOW.
    if (!descriptor.isFile() || (process.platform !== "win32" && !sameFileIdentity(before, descriptor))) {
      throw new Error("Sensitive artifact changed while being opened");
    }
    return handle;
  } catch (err) {
    await handle.close().catch(() => {});
    throw err;
  }
}

async function assertPathStillOwned(tempPath: string, expected: FileIdentity): Promise<void> {
  const handle = await openRegularNoFollow(tempPath);
  try {
    const actual = await handle.stat({ bigint: true });
    if (!sameFileIdentity(actual, expected)) {
      throw new Error("Sensitive artifact temporary path no longer names the owned inode");
    }
  } finally {
    await handle.close();
  }
}

async function sha256StableHandle(
  handle: import("node:fs/promises").FileHandle,
  maxBytes = Number.MAX_SAFE_INTEGER
): Promise<string> {
  const before = await handle.stat({ bigint: true });
  if (!before.isFile()) throw new Error("Refusing to hash a non-regular sensitive artifact");
  if (before.size > BigInt(maxBytes)) throw new Error("Sensitive artifact exceeds the bounded hash limit");
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  while (true) {
    const remaining = maxBytes - position;
    const requested = remaining >= buffer.length ? buffer.length : remaining + 1;
    const { bytesRead } = await handle.read(buffer, 0, requested, position);
    if (bytesRead === 0) break;
    position += bytesRead;
    if (position > maxBytes) throw new Error("Sensitive artifact exceeds the bounded hash limit");
    hash.update(buffer.subarray(0, bytesRead));
  }
  const after = await handle.stat({ bigint: true });
  if (
    !sameFileIdentity(before, after) ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs
  ) {
    throw new Error("Sensitive artifact changed while being hashed");
  }
  return hash.digest("hex");
}

async function cleanupOwnedTemp(owned: OwnedTemp): Promise<void> {
  if (owned.stagePath && owned.stageIdentity) {
    try {
      await removeOwnedEmptyEmbedLeaseNamespace(owned);
    } catch {
      // A live/malformed lease namespace means the staged database may still
      // be in use. Preserve the complete private stage rather than unlinking
      // its main file out from under an unproved owner.
      return;
    }
    await cleanupOwnedSqliteSidecars(owned).catch(() => {});
  }
  try {
    await assertPathStillOwned(owned.tempPath, owned.tempIdentity);
    await fs.unlink(owned.tempPath);
  } catch {
    // Cleanup is strictly best-effort; never unlink a replacement object.
  }
  if (owned.stagePath) await removeOwnedEmptyStage(owned.stagePath, owned.stageIdentity).catch(() => {});
}

async function removeOwnedEmptyEmbedLeaseNamespace(owned: OwnedTemp): Promise<void> {
  if (!owned.stagePath || !owned.stageIdentity || path.basename(owned.tempPath) !== STAGED_EMBED_ARTIFACT_BASENAME) {
    return;
  }
  const stage = await fs.lstat(owned.stagePath, { bigint: true });
  if (stage.isSymbolicLink() || !stage.isDirectory() || !sameFileIdentity(stage, owned.stageIdentity)) {
    throw new Error("Sensitive artifact staging directory changed before lease cleanup");
  }
  const scopes = await inspectEmptyEmbedLeaseNamespace(owned.stagePath);
  await removeInspectedEmptyEmbedLeaseNamespace(owned.stagePath, scopes);
}

async function inspectEmptyEmbedLeaseNamespace(stagePath: string): Promise<string[]> {
  const leaseRoot = path.join(stagePath, STAGED_LEASE_ROOT_BASENAME);
  let root: import("node:fs").BigIntStats;
  try {
    root = await fs.lstat(leaseRoot, { bigint: true });
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return [];
    throw error;
  }
  if (root.isSymbolicLink() || !root.isDirectory()) {
    throw new Error("Sensitive artifact staged lease root is not a real directory");
  }
  if (process.platform !== "win32" && (root.mode & 0o777n) !== 0o700n) {
    throw new Error("Sensitive artifact staged lease root is not private");
  }
  const scopes = await fs.readdir(leaseRoot);
  if (
    scopes.length !== STAGED_EMBED_LEASE_SCOPE_COUNT ||
    scopes.some((scope) => !STAGED_LEASE_SCOPE_BASENAME_PATTERN.test(scope))
  ) {
    throw new Error("Sensitive artifact staged lease namespace is not an exact released family");
  }
  for (const scope of scopes) {
    const scopePath = path.join(leaseRoot, scope);
    const entry = await fs.lstat(scopePath, { bigint: true });
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error("Sensitive artifact staged lease scope is not a real directory");
    }
    if (process.platform !== "win32" && (entry.mode & 0o777n) !== 0o700n) {
      throw new Error("Sensitive artifact staged lease scope is not private");
    }
    if ((await fs.readdir(scopePath)).length !== 0) {
      throw new Error("Sensitive artifact staged lease scope is still active");
    }
  }
  return scopes;
}

async function removeInspectedEmptyEmbedLeaseNamespace(stagePath: string, scopes: readonly string[]): Promise<void> {
  if (scopes.length === 0) return;
  const leaseRoot = path.join(stagePath, STAGED_LEASE_ROOT_BASENAME);
  for (const scope of scopes) await fs.rmdir(path.join(leaseRoot, scope));
  await fs.rmdir(leaseRoot);
}

async function cleanupOwnedSqliteSidecars(owned: OwnedTemp): Promise<void> {
  if (!owned.stagePath || !owned.stageIdentity || path.basename(owned.tempPath) !== STAGED_EMBED_ARTIFACT_BASENAME) {
    return;
  }
  const stage = await fs.lstat(owned.stagePath, { bigint: true });
  if (stage.isSymbolicLink() || !stage.isDirectory() || !sameFileIdentity(stage, owned.stageIdentity)) return;
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    const sidecar = `${owned.tempPath}${suffix}`;
    let entry: import("node:fs").Stats;
    try {
      entry = await fs.lstat(sidecar);
    } catch (err) {
      if (errnoCode(err) === "ENOENT") continue;
      throw err;
    }
    if (!entry.isFile() && !entry.isSymbolicLink()) return;
    await fs.unlink(sidecar);
  }
}

async function removeOwnedEmptyStage(stagePath: string, expected: FileIdentity | null): Promise<void> {
  if (!expected) return;
  const stage = await fs.lstat(stagePath, { bigint: true });
  if (stage.isSymbolicLink() || !stage.isDirectory() || !sameFileIdentity(stage, expected)) return;
  await fs.rmdir(stagePath);
}

async function assertNoStagedSqliteSidecars(stagedPath: string): Promise<void> {
  if (path.basename(stagedPath) !== STAGED_EMBED_ARTIFACT_BASENAME) return;
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    try {
      await fs.lstat(`${stagedPath}${suffix}`);
    } catch (err) {
      if (errnoCode(err) === "ENOENT") continue;
      throw err;
    }
    throw new Error("Sensitive artifact SQLite stage retains sidecars before commit");
  }
}

function stagedArtifactMainBasename(finalBasename: string): string {
  return finalBasename.endsWith(".embed.db") ? STAGED_EMBED_ARTIFACT_BASENAME : STAGED_ARTIFACT_BASENAME;
}

function stagedArtifactFamilyBasenames(finalBasename: string): string[] {
  const mainBasename = stagedArtifactMainBasename(finalBasename);
  if (mainBasename !== STAGED_EMBED_ARTIFACT_BASENAME) return [mainBasename];
  return [mainBasename, ...SQLITE_SIDECAR_SUFFIXES.map((suffix) => `${mainBasename}${suffix}`)];
}

function parseGeneratedEntry(entryBasename: string): GeneratedEntry | null {
  const match = GENERATED_ENTRY_PATTERN.exec(entryBasename);
  // JavaScript `$` can match immediately before one final line terminator.
  // Require a byte-for-byte whole-string match so an appended newline cannot
  // smuggle a foreign basename into the reserved deletion namespace.
  if (match?.[0] !== entryBasename) return null;
  const finalBasename = match?.[1];
  const kind = match?.[2]?.toLowerCase();
  const token = match?.[3]?.toLowerCase();
  if (!finalBasename || (kind !== "tmp" && kind !== "stage") || !token) return null;
  return { finalBasename, kind, token };
}

function normalizedEntrySpelling(value: string): string {
  return value.normalize("NFC").toLowerCase();
}

function randomToken(): string {
  return randomBytes(TOKEN_BYTES).toString("hex");
}

function fileIdentity(stat: import("node:fs").BigIntStats): FileIdentity {
  return { dev: stat.dev, ino: stat.ino };
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  // Some unusual filesystems report a non-identifying 0/0 pair. Treat that as
  // unprovable and fail closed instead of accepting any replacement as equal.
  return left.ino !== 0n && left.dev === right.dev && left.ino === right.ino;
}

function sameStableFileReceipt(left: import("node:fs").BigIntStats, right: import("node:fs").BigIntStats): boolean {
  return (
    left.isFile() &&
    right.isFile() &&
    sameFileIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

/**
 * Prove that two path spellings resolve to one canonical directory entry.
 *
 * Equal inode numbers alone are insufficient because distinct hardlink names
 * share an inode. This helper therefore requires one canonical parent, a
 * stable directory snapshot containing at most one of the supplied spellings,
 * and a usable BigInt device/inode pair. It deliberately does not `realpath`
 * the leaf: recognized dangling symlink aliases must remain safely erasable.
 * Errors and unverifiable identities return `false` so destructive callers
 * fail closed.
 *
 * @param leftPath - First existing path spelling.
 * @param rightPath - Second path spelling expected to alias the first.
 * @returns `true` only when both spellings name one canonical entry.
 * @example
 * await sameCanonicalDirectoryEntry("/tmp/Cache.json", "/tmp/cache.json");
 * @internal
 */
export async function sameCanonicalDirectoryEntry(leftPath: string, rightPath: string): Promise<boolean> {
  try {
    const [left, right, leftParentReal, rightParentReal] = await Promise.all([
      fs.lstat(leftPath, { bigint: true }),
      fs.lstat(rightPath, { bigint: true }),
      fs.realpath(path.dirname(leftPath)),
      fs.realpath(path.dirname(rightPath))
    ]);
    if (leftParentReal !== rightParentReal) return false;
    const leftBasename = path.basename(leftPath);
    const rightBasename = path.basename(rightPath);
    if (leftBasename !== rightBasename) {
      const entries = await fs.readdir(leftParentReal);
      // A native case/normalization alias has only one directory entry; two
      // exact spellings in the same stable-parent snapshot prove distinction,
      // including two hardlink names for one regular file or symlink inode.
      if (entries.includes(leftBasename) && entries.includes(rightBasename)) return false;
    }
    return sameFileIdentity(left, right);
  } catch {
    return false;
  }
}

function assertUsableIdentity(identity: FileIdentity): void {
  if (identity.ino === 0n) throw new Error("Filesystem did not provide a usable temporary-file identity");
}

function errnoCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null || !("code" in err)) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
