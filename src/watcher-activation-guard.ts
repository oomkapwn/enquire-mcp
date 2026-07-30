import { randomBytes } from "node:crypto";
import { promises as fs, constants as fsConstants } from "node:fs";
import * as path from "node:path";

const ACTIVATION_GUARD_VERSION = 1;
const ACTIVATION_GUARD_SUFFIX = ".watcher-activation.guard";
const ACTIVE_CHILD_SUFFIX = ".active";
const MAX_GUARD_BYTES = 1024;
const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const ACTIVE_CHILD_PATTERN = /^([0-9a-f]{64})\.active$/;

interface ActivationGuardPayload {
  version: typeof ACTIVATION_GUARD_VERSION;
  token: string;
}

interface RecoverableActivationGuard {
  guardPath: string;
  childName: string | null;
}

/**
 * In-memory ownership proof for one watcher-activation guard.
 *
 * The exact embedding-database path is retained only in memory. The on-disk
 * directory and payload deliberately contain no vault or note paths.
 */
export interface WatcherActivationGuard {
  /** Exact embedding-database path from which the guard path is derived. */
  readonly embedDbFile: string;
  /** Cryptographically random token naming and authenticating the active child. */
  readonly token: string;
}

/**
 * Derive the watcher-activation guard path from an exact embedding-database file.
 *
 * @param embedDbFile - Exact path used to open the embedding database.
 * @returns A deterministic sidecar path unique to that exact database path.
 * @example
 * watcherActivationGuardPath("/tmp/vault.embed.db");
 * // "/tmp/vault.embed.db.watcher-activation.guard"
 */
export function watcherActivationGuardPath(embedDbFile: string): string {
  return `${embedDbFile}${ACTIVATION_GUARD_SUFFIX}`;
}

/**
 * Assert that no watcher-activation guard object exists.
 *
 * A directory is the expected armed representation, but every object type
 * blocks startup. This makes a partial create, malformed guard, symlink, FIFO,
 * or foreign replacement fail closed without reading through it.
 *
 * @param embedDbFile - Exact embedding-database path to check.
 * @returns A promise that resolves only when the derived guard path is absent.
 * @throws When any object exists at the guard path or the path cannot be checked.
 * @example
 * await assertWatcherActivationGuardClear("/tmp/vault.embed.db");
 */
export async function assertWatcherActivationGuardClear(embedDbFile: string): Promise<void> {
  const guardPath = watcherActivationGuardPath(embedDbFile);
  try {
    await fs.lstat(guardPath);
  } catch (err) {
    if (errnoCode(err) === "ENOENT") return;
    throw new Error("Unable to verify that the watcher activation guard is clear", { cause: err });
  }
  throw new Error("Watcher activation guard exists; derived indexes require explicit recovery before startup");
}

/**
 * Arm a watcher-activation guard as an exclusive mode-0700 directory.
 *
 * The directory contains one mode-0600 child named by a random token; its
 * payload contains only the schema version and the same token. The child and,
 * on POSIX, both directory entries are fsynced before this function returns.
 * A process crash at any intermediate step leaves an object at the stable guard
 * path, so an automatic restart blocks before publishing derived indexes.
 *
 * This is a process-restart interlock, not a defense against a hostile process
 * running concurrently as the same OS account.
 *
 * @param embedDbFile - Exact embedding-database path from which to derive the guard.
 * @returns The in-memory ownership proof required for release.
 * @throws When any object already occupies the guard path or persistence fails.
 * @example
 * const guard = await armWatcherActivationGuard("/tmp/vault.embed.db");
 */
export async function armWatcherActivationGuard(embedDbFile: string): Promise<WatcherActivationGuard> {
  const guardPath = watcherActivationGuardPath(embedDbFile);
  const token = randomBytes(TOKEN_BYTES).toString("hex");
  const childPath = activationGuardChildPath(guardPath, token);
  const payload: ActivationGuardPayload = { version: ACTIVATION_GUARD_VERSION, token };

  try {
    await fs.mkdir(guardPath, { mode: 0o700 });
    await fs.chmod(guardPath, 0o700);
    await syncDirectory(path.dirname(guardPath));
  } catch (err) {
    if (errnoCode(err) === "EEXIST") {
      throw new Error("Watcher activation guard already exists; refusing to replace it", { cause: err });
    }
    throw new Error("Unable to create watcher activation guard", { cause: err });
  }

  let handle: import("node:fs/promises").FileHandle | null = null;
  try {
    handle = await fs.open(childPath, "wx", 0o600);
    await handle.chmod(0o600);
    await handle.writeFile(`${JSON.stringify(payload)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await syncDirectory(guardPath);
  } catch (err) {
    // Fail closed. The exclusive directory (and possibly a partial child)
    // remains in place and blocks every later startup until explicit recovery.
    throw new Error("Unable to persist watcher activation guard", { cause: err });
  } finally {
    if (handle) await handle.close().catch(() => {});
  }

  return Object.freeze({ embedDbFile, token });
}

/**
 * Release a watcher-activation guard owned by the supplied proof.
 *
 * Only the random token child is unlinked, then the stable directory is removed
 * with `rmdir` (never recursive deletion). `rmdir` succeeds only while the
 * directory is empty, so an unexpected concurrent entry fails closed. Child
 * identity is compared descriptor-to-descriptor, avoiding the divergent
 * lstat/fstat identity surfaces observed on Windows.
 *
 * @param guard - Ownership proof returned by {@link armWatcherActivationGuard}.
 * @returns A promise that resolves after the owned guard directory is removed.
 * @throws When the guard is missing, unsafe, malformed, replaced, or not owned.
 * @example
 * const guard = await armWatcherActivationGuard("/tmp/vault.embed.db");
 * await releaseWatcherActivationGuard(guard);
 */
export async function releaseWatcherActivationGuard(guard: WatcherActivationGuard): Promise<void> {
  if (!TOKEN_PATTERN.test(guard.token)) {
    throw new Error("Refusing to release watcher activation guard: malformed ownership token");
  }
  const guardPath = watcherActivationGuardPath(guard.embedDbFile);
  const childName = activationGuardChildName(guard.token);
  const childPath = path.join(guardPath, childName);
  const directoryBefore = await lstatGuard(guardPath);
  if (directoryBefore.isSymbolicLink() || !directoryBefore.isDirectory()) {
    throw new Error("Refusing to release watcher activation guard: guard is not a regular non-symlink directory");
  }
  await assertExactGuardEntry(guardPath, childName);

  const first = await openGuardChild(childPath);
  let firstStat: import("node:fs").Stats;
  try {
    firstStat = await validateGuardChild(first, guard.token);
  } finally {
    await first.close();
  }

  // Re-open the final path and compare fstat↔fstat. Do not compare lstat with
  // FileHandle.stat on Windows: those libuv/Win32 surfaces can disagree for the
  // same file. Keeping the token in an unguessable child name also limits the
  // accidental replacement surface between this check and unlink.
  await assertExactGuardEntry(guardPath, childName);
  const second = await openGuardChild(childPath);
  try {
    const secondStat = await validateGuardChild(second, guard.token);
    if (!sameFileIdentity(firstStat, secondStat)) {
      throw new Error("Refusing to release watcher activation guard: active child identity changed");
    }
  } finally {
    // Windows does not reliably permit unlinking an open file.
    await second.close();
  }

  const directoryAfter = await lstatGuard(guardPath);
  if (
    directoryAfter.isSymbolicLink() ||
    !directoryAfter.isDirectory() ||
    !sameFileIdentity(directoryBefore, directoryAfter)
  ) {
    throw new Error("Refusing to release watcher activation guard: guard directory identity changed");
  }
  await assertExactGuardEntry(guardPath, childName);
  await fs.unlink(childPath);
  await syncDirectory(guardPath);
  try {
    await fs.rmdir(guardPath);
  } catch (err) {
    throw new Error("Refusing to release watcher activation guard: guard directory is not empty or changed", {
      cause: err
    });
  }
  await syncParentAfterGuardRemoval(guardPath);
}

/**
 * Read-only preflight for explicit watcher-activation recovery.
 *
 * An absent guard is safe and returns `false`. A present guard is accepted only
 * when it has the narrow shape that {@link clearWatcherActivationGuard} owns:
 * an empty non-symlink directory or one bounded regular `<64-hex>.active`
 * child. The filesystem is not modified. `EmbedDb.clearOnDisk()` calls this
 * before deleting any database/HNSW artifact so an unsafe foreign object cannot
 * trigger a destructive partial recovery.
 *
 * @param embedDbFile - Exact embedding-database path owning the guard.
 * @returns `true` when a recoverable guard exists, otherwise `false`.
 * @throws When the guard exists but is unsafe, foreign, inaccessible, or changes during inspection.
 * @example
 * await preflightWatcherActivationGuardRecovery("/tmp/vault.embed.db");
 */
export async function preflightWatcherActivationGuardRecovery(embedDbFile: string): Promise<boolean> {
  return (await inspectRecoverableActivationGuard(embedDbFile)) !== null;
}

/**
 * Strictly remove a stranded watcher-activation guard during explicit recovery.
 *
 * Only an empty partial directory or a directory containing exactly one
 * regular `<64-hex>.active` child of bounded size is accepted. No recursive
 * deletion is used; unexpected objects or entries throw and remain on disk.
 *
 * @param embedDbFile - Exact embedding-database path owning the guard.
 * @returns `true` when a guard directory was removed, otherwise `false`.
 * @example
 * await clearWatcherActivationGuard("/tmp/vault.embed.db");
 */
export async function clearWatcherActivationGuard(embedDbFile: string): Promise<boolean> {
  // Re-run the complete read-only shape validation here even when a caller
  // preflighted earlier. Recovery deletes derived artifacts first but must
  // validate the final guard state again immediately before touching it.
  const recovery = await inspectRecoverableActivationGuard(embedDbFile);
  if (!recovery) return false;
  const { guardPath, childName } = recovery;

  if (childName) {
    await fs.unlink(path.join(guardPath, childName));
    await syncDirectory(guardPath);
  }

  try {
    await fs.rmdir(guardPath);
  } catch (err) {
    throw new Error("Unable to remove watcher activation guard directory during recovery", { cause: err });
  }
  await syncParentAfterGuardRemoval(guardPath);
  return true;
}

async function inspectRecoverableActivationGuard(embedDbFile: string): Promise<RecoverableActivationGuard | null> {
  const guardPath = watcherActivationGuardPath(embedDbFile);
  let guardStat: import("node:fs").Stats;
  try {
    guardStat = await fs.lstat(guardPath);
  } catch (err) {
    if (errnoCode(err) === "ENOENT") return null;
    throw new Error("Unable to inspect watcher activation guard during recovery", { cause: err });
  }
  if (guardStat.isSymbolicLink() || !guardStat.isDirectory()) {
    throw new Error("Refusing to clear watcher activation guard: expected a non-symlink directory");
  }

  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(guardPath, { withFileTypes: true });
  } catch (err) {
    throw new Error("Unable to inspect watcher activation guard directory during recovery", { cause: err });
  }
  if (entries.length > 1) {
    throw new Error("Refusing to clear watcher activation guard: unexpected directory entries");
  }
  const entry = entries[0];
  let childName: string | null = null;
  if (entry) {
    const match = ACTIVE_CHILD_PATTERN.exec(entry.name);
    if (!match || !entry.isFile() || entry.isSymbolicLink()) {
      throw new Error("Refusing to clear watcher activation guard: unexpected directory entry");
    }
    const childPath = path.join(guardPath, entry.name);
    let childStat: import("node:fs").Stats;
    try {
      childStat = await fs.lstat(childPath);
    } catch (err) {
      throw new Error("Unable to inspect watcher activation guard child during recovery", { cause: err });
    }
    if (childStat.isSymbolicLink() || !childStat.isFile() || childStat.size > MAX_GUARD_BYTES) {
      throw new Error("Refusing to clear watcher activation guard: unsafe active child");
    }
    childName = entry.name;
  }

  let guardAfter: import("node:fs").Stats;
  try {
    guardAfter = await fs.lstat(guardPath);
  } catch (err) {
    throw new Error("Unable to revalidate watcher activation guard during recovery", { cause: err });
  }
  if (guardAfter.isSymbolicLink() || !guardAfter.isDirectory() || !sameFileIdentity(guardStat, guardAfter)) {
    throw new Error("Refusing to clear watcher activation guard: guard directory identity changed");
  }
  return { guardPath, childName };
}

function activationGuardChildName(token: string): string {
  return `${token}${ACTIVE_CHILD_SUFFIX}`;
}

function activationGuardChildPath(guardPath: string, token: string): string {
  return path.join(guardPath, activationGuardChildName(token));
}

async function assertExactGuardEntry(guardPath: string, expectedName: string): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(guardPath, { withFileTypes: true });
  } catch (err) {
    throw new Error("Refusing to release watcher activation guard: guard directory is inaccessible", {
      cause: err
    });
  }
  const entry = entries[0];
  if (entries.length !== 1 || !entry || entry.name !== expectedName || !entry.isFile() || entry.isSymbolicLink()) {
    throw new Error("Refusing to release watcher activation guard: unexpected guard directory entries");
  }
}

async function openGuardChild(childPath: string): Promise<import("node:fs/promises").FileHandle> {
  const safeReadFlags =
    fsConstants.O_RDONLY | (process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  try {
    return await fs.open(childPath, safeReadFlags);
  } catch (err) {
    throw new Error("Refusing to release watcher activation guard: active child could not be opened safely", {
      cause: err
    });
  }
}

async function validateGuardChild(
  handle: import("node:fs/promises").FileHandle,
  expectedToken: string
): Promise<import("node:fs").Stats> {
  const descriptor = await handle.stat();
  if (!descriptor.isFile() || descriptor.size > MAX_GUARD_BYTES) {
    throw new Error("Refusing to release watcher activation guard: malformed guard payload");
  }
  const buffer = Buffer.alloc(MAX_GUARD_BYTES + 1);
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
  if (bytesRead > MAX_GUARD_BYTES) {
    throw new Error("Refusing to release watcher activation guard: malformed guard payload");
  }
  const payload = parseGuardPayload(buffer.subarray(0, bytesRead).toString("utf8"));
  if (payload.token !== expectedToken) {
    throw new Error("Refusing to release watcher activation guard: ownership token mismatch");
  }
  return descriptor;
}

function parseGuardPayload(raw: string): ActivationGuardPayload {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    throw new Error("Refusing to release watcher activation guard: malformed guard payload", { cause: err });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Refusing to release watcher activation guard: malformed guard payload");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== "token" ||
    keys[1] !== "version" ||
    record.version !== ACTIVATION_GUARD_VERSION ||
    typeof record.token !== "string" ||
    !TOKEN_PATTERN.test(record.token)
  ) {
    throw new Error("Refusing to release watcher activation guard: malformed guard payload");
  }
  return { version: ACTIVATION_GUARD_VERSION, token: record.token };
}

async function lstatGuard(guardPath: string): Promise<import("node:fs").Stats> {
  try {
    return await fs.lstat(guardPath);
  } catch (err) {
    throw new Error("Refusing to release watcher activation guard: guard is missing or inaccessible", { cause: err });
  }
}

async function syncDirectory(directoryPath: string): Promise<void> {
  if (process.platform === "win32") return;
  let handle: import("node:fs/promises").FileHandle;
  try {
    handle = await fs.open(directoryPath, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
  } catch (err) {
    throw new Error("Unable to open watcher activation guard directory for sync", { cause: err });
  }
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Make a completed guard-directory removal durable when the filesystem allows
 * it. If the final parent sync fails but the stable path is already absent,
 * treat this process generation as released: a crash can at worst resurrect
 * the guard and make the next startup fail closed. An existing or unverifiable
 * path is still an error because release cannot prove the interlock is gone.
 */
async function syncParentAfterGuardRemoval(guardPath: string): Promise<void> {
  try {
    await syncDirectory(path.dirname(guardPath));
  } catch (syncError) {
    try {
      await fs.lstat(guardPath);
    } catch (verifyError) {
      if (errnoCode(verifyError) === "ENOENT") return;
      throw new Error("Unable to verify watcher activation guard absence after parent-directory sync failure", {
        cause: syncError
      });
    }
    throw new Error("Watcher activation guard still exists after its parent directory failed to sync", {
      cause: syncError
    });
  }
}

function sameFileIdentity(left: import("node:fs").Stats, right: import("node:fs").Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function errnoCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null || !("code" in err)) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
