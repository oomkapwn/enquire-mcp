import { createHash, randomBytes } from "node:crypto";
import { promises as fs, constants as fsConstants } from "node:fs";
import * as path from "node:path";

const TOKEN_BYTES = 24;
const TOKEN_HEX_LENGTH = TOKEN_BYTES * 2;
const STAGED_ARTIFACT_BASENAME = "artifact";
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
  hasStagedChild: boolean;
}

/** Result of publishing one sensitive filesystem artifact. @internal */
export interface SensitiveArtifactReceipt {
  /** SHA-256 of the held staged descriptor after the producer returns. */
  sha256: string;
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
 * @returns SHA-256 receipt for the promoted staged generation under that stability boundary.
 * @throws If exclusive reservation, writing, identity validation, sync, or rename fails.
 * @example
 * await publishSensitiveArtifact("/tmp/cache.json", JSON.stringify({ version: 1 }));
 * @internal
 */
export async function publishSensitiveArtifact(
  finalPath: string,
  source: string | Uint8Array | SensitiveArtifactPathWriter
): Promise<SensitiveArtifactReceipt> {
  const owned =
    typeof source === "function" ? await reserveStagedArtifact(finalPath) : await reserveSiblingTemp(finalPath);
  let published = false;
  try {
    if (typeof source === "function") {
      await source(owned.tempPath);
    } else {
      await owned.handle?.writeFile(source);
    }

    const handle = owned.handle;
    if (!handle) throw new Error("Sensitive artifact publisher lost its owned file descriptor");
    const afterWrite = await handle.stat({ bigint: true });
    if (!afterWrite.isFile() || !sameFileIdentity(afterWrite, owned.tempIdentity)) {
      throw new Error("Sensitive artifact producer replaced its owned temporary file");
    }
    await handle.chmod(0o600);
    await handle.sync();
    const sha256 = await sha256StableHandle(handle);
    await handle.close();
    owned.handle = null;

    await assertPathStillOwned(owned.tempPath, owned.tempIdentity);
    await assertReplaceableFinalLeaf(finalPath);
    await fs.rename(owned.tempPath, finalPath);
    published = true;
    // Publication committed at rename. A best-effort empty-stage cleanup must
    // never turn that committed success into a reported failure/retry ambiguity.
    if (owned.stagePath) await removeOwnedEmptyStage(owned.stagePath, owned.stageIdentity).catch(() => {});
    return { sha256 };
  } finally {
    if (owned.handle) await owned.handle.close().catch(() => {});
    if (!published) await cleanupOwnedTemp(owned);
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
 * @returns Lowercase SHA-256 hex for a stable descriptor snapshot.
 * @throws If the path is a symlink/non-file, changes while read, or cannot be read safely.
 * @example
 * const digest = await sha256SensitiveArtifact("/tmp/index.hnsw.bin");
 * @internal
 */
export async function sha256SensitiveArtifact(file: string): Promise<string> {
  const handle = await openRegularNoFollow(file);
  try {
    return await sha256StableHandle(handle);
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
 * only when it is a non-symlink directory containing at most the single fixed
 * staged-artifact entry; recursive deletion is never used.
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
    await fs.unlink(entryPath);
    return true;
  }
  if (inspected.hasStagedChild) {
    const childPath = path.join(entryPath, STAGED_ARTIFACT_BASENAME);
    await fs.unlink(childPath);
  }
  await fs.rmdir(entryPath);
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
    return { generated, hasStagedChild: false };
  }
  if (entryStat.isSymbolicLink() || !entryStat.isDirectory()) {
    throw new Error("Refusing to erase a malformed sensitive-artifact staging directory");
  }
  const children = await fs.readdir(entryPath);
  const child = children[0];
  if (children.length > 1) {
    throw new Error("Refusing to erase a sensitive-artifact stage with unexpected entries");
  }
  if (child) {
    const childPath = path.join(entryPath, child);
    const expectedChildPath = path.join(entryPath, STAGED_ARTIFACT_BASENAME);
    if (child !== STAGED_ARTIFACT_BASENAME && !(await sameCanonicalDirectoryEntry(childPath, expectedChildPath))) {
      throw new Error("Refusing to erase a sensitive-artifact stage with an ambiguous child entry");
    }
    const childStat = await fs.lstat(childPath);
    if (!childStat.isFile() && !childStat.isSymbolicLink()) {
      throw new Error("Refusing to erase a malformed sensitive-artifact staged file");
    }
  }
  return { generated, hasStagedChild: child !== undefined };
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
    const tempPath = path.join(stagePath, STAGED_ARTIFACT_BASENAME);
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
  const flags = fsConstants.O_RDONLY | (process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
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

async function sha256StableHandle(handle: import("node:fs/promises").FileHandle): Promise<string> {
  const before = await handle.stat({ bigint: true });
  if (!before.isFile()) throw new Error("Refusing to hash a non-regular sensitive artifact");
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  while (true) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
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
  try {
    await assertPathStillOwned(owned.tempPath, owned.tempIdentity);
    await fs.unlink(owned.tempPath);
  } catch {
    // Cleanup is strictly best-effort; never unlink a replacement object.
  }
  if (owned.stagePath) await removeOwnedEmptyStage(owned.stagePath, owned.stageIdentity).catch(() => {});
}

async function removeOwnedEmptyStage(stagePath: string, expected: FileIdentity | null): Promise<void> {
  if (!expected) return;
  const stage = await fs.lstat(stagePath, { bigint: true });
  if (stage.isSymbolicLink() || !stage.isDirectory() || !sameFileIdentity(stage, expected)) return;
  await fs.rmdir(stagePath);
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
