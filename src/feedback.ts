// v3.11.0 — closed-loop retrieval feedback (the "Karpathy loop"). An agent calls
// `obsidian_mark_useful` to record which recalled notes actually helped answer a
// query; the per-note useful / not-useful tally feeds an OPT-IN additive rank
// boost in `obsidian_search` (`--feedback-weight`, default 0 = provable no-op,
// mirroring the v3.10.0-rc.5 recency boost).
//
// PRIVACY (data-at-rest): state lives in a single routing-key-scoped JSON sidecar
// in the cache dir (`<hash>.feedback.json`) holding the canonical absolute vault root
// plus relative note-path keys, integer counts, and an ISO timestamp per entry
// — NO note content, snippets, or query text. It is lower-sensitivity than the
// content indexes, and it matches the `ENQUIRE_CACHE_ARTIFACT` pattern so a
// cross-stem `prune` erases it alongside the parse cache / FTS index / embed-db
// sidecars for non-colliding roots. The legacy SHA1-12 stem is routing, not exact
// root identity; the erasure-invariant
// (`tests/erasure-invariant.test.ts`) pins that prune coverage. It is preserved
// across `clear-cache` (it is user-generated signal, not regenerable cache).

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { removeArtifact } from "./erasure-receipt.js";
import {
  acquirePersistenceFamilyLease,
  acquirePersistenceFamilyLeaseInScopes,
  type PersistenceFamilyLeaseHandle,
  type PersistenceFamilyScopes
} from "./persistence-coordination.js";
import { PersistenceLeaseConflictError, revalidatePersistenceLeaseScope } from "./persistence-lease.js";
import { assertFeedbackFilePath } from "./persistence-path.js";
import {
  preflightSensitiveArtifactTemps,
  publishSensitiveArtifact,
  readSensitiveArtifactText,
  removeSensitiveArtifactTemps
} from "./sensitive-artifact.js";

/** Per-note usefulness tally. `lastMarked` is an ISO-8601 timestamp (or "" if a
 *  loaded legacy/partial entry lacked one). */
export interface FeedbackEntry {
  useful: number;
  notUseful: number;
  lastMarked: string;
}

interface FeedbackData {
  version: 1;
  /**
   * v3.11.6-rc.8 (RFC-surfaced latent bug) — the canonical vault root recorded by
   * this store. It is verified on open so mismatched entries are not admitted
   * (mirrors the `data.root !== this.root` guard fts5/embed-db already have), but
   * does not make a shared SHA1-12 path collision-proof. Optional so pre-rc.8
   * sidecars (no `vault_root`) still load.
   */
  vault_root?: string;
  entries: Record<string, FeedbackEntry>;
}

/** Upper bound on distinct marked notes the store will hold. Far beyond any real
 *  vault's useful-marked set; bounds disk growth from a misbehaving client that
 *  marks unbounded fake paths over a long `serve-http` session (a mild fill-DoS).
 *  At the cap, EXISTING entries still update; NEW paths are ignored. */
export const MAX_FEEDBACK_ENTRIES = 100_000;
/** v3.11.0-rc.24 (Goose FIND-2) — upper bound on the sidecar file size read at `open()`.
 *  At MAX_FEEDBACK_ENTRIES × ~200 B/entry the legitimate file is ~20 MB; 64 MB is generous
 *  and bounds a corrupt/hostile file before readFile+JSON.parse (defense-in-depth — the
 *  sidecar is operator-controlled, not bearer-reachable). */
export const MAX_FEEDBACK_FILE_BYTES = 64 * 1024 * 1024;
const MAX_FEEDBACK_PATH_CHARS = 1024;
const MAX_FEEDBACK_TIMESTAMP_CHARS = 64;
const FEEDBACK_PERSISTENCE_FAMILY = "feedback-v1";
const FEEDBACK_PUBLISH_WAIT_MS = 5_000;
const FEEDBACK_PUBLISH_POLL_MS = 10;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isCanonicalFeedbackTimestamp(value: string): boolean {
  if (value === "") return true;
  if (value.length > MAX_FEEDBACK_TIMESTAMP_CHARS) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function parseFeedbackEntry(value: unknown): FeedbackEntry | null {
  if (!isPlainRecord(value)) return null;
  if (Object.keys(value).some((key) => key !== "useful" && key !== "notUseful" && key !== "lastMarked")) {
    return null;
  }
  const useful = value.useful;
  const notUseful = value.notUseful;
  const lastMarked = value.lastMarked === undefined ? "" : value.lastMarked;
  if (
    !Number.isSafeInteger(useful) ||
    !Number.isSafeInteger(notUseful) ||
    (useful as number) < 0 ||
    (notUseful as number) < 0 ||
    (useful as number) + (notUseful as number) > Number.MAX_SAFE_INTEGER - 1 ||
    typeof lastMarked !== "string" ||
    !isCanonicalFeedbackTimestamp(lastMarked)
  ) {
    return null;
  }
  return { useful: useful as number, notUseful: notUseful as number, lastMarked };
}

function feedbackEntryPairBytes(relPath: string, entry: FeedbackEntry): number {
  return Buffer.byteLength(`${JSON.stringify(relPath)}:${JSON.stringify(entry)}`, "utf8");
}

function feedbackDataBytes(data: FeedbackData): number {
  return Buffer.byteLength(JSON.stringify(data), "utf8");
}

function emptyFeedbackData(vaultRoot?: string): FeedbackData {
  return {
    version: 1,
    ...(vaultRoot ? { vault_root: vaultRoot } : {}),
    entries: Object.create(null) as Record<string, FeedbackEntry>
  };
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const { code } = error as { code?: unknown };
  return typeof code === "string" ? code : undefined;
}

function admitFeedbackData(parsed: unknown, vaultRoot?: string): FeedbackData | null {
  if (!isPlainRecord(parsed) || parsed.version !== 1 || !isPlainRecord(parsed.entries)) return null;
  if (Object.keys(parsed).some((key) => key !== "version" && key !== "vault_root" && key !== "entries")) {
    return null;
  }
  const hasStoredRoot = Object.hasOwn(parsed, "vault_root");
  const storedRoot = parsed.vault_root;
  if (hasStoredRoot && (typeof storedRoot !== "string" || storedRoot.length === 0)) return null;
  if (vaultRoot && hasStoredRoot && storedRoot !== vaultRoot) return null;
  const entries: Record<string, FeedbackEntry> = Object.create(null);
  let inspectedEntryCount = 0;
  for (const [key, rawEntry] of Object.entries(parsed.entries)) {
    if (inspectedEntryCount >= MAX_FEEDBACK_ENTRIES) break;
    inspectedEntryCount += 1;
    if (key.length === 0 || key.length > MAX_FEEDBACK_PATH_CHARS) continue;
    const entry = parseFeedbackEntry(rawEntry);
    if (entry) entries[key] = entry;
  }
  return { version: 1, ...(vaultRoot ? { vault_root: vaultRoot } : {}), entries };
}

async function loadFeedbackData(file: string, vaultRoot?: string, failSoft = true): Promise<FeedbackData> {
  const empty = emptyFeedbackData(vaultRoot);
  let stat: import("node:fs").Stats;
  try {
    stat = await fs.stat(file);
  } catch (error) {
    if (errorCode(error) === "ENOENT" || failSoft) return empty;
    throw error;
  }
  if (stat.size > MAX_FEEDBACK_FILE_BYTES) {
    if (failSoft) return empty;
    throw new Error("feedback snapshot exceeds the persistent read limit");
  }
  let raw: string;
  try {
    raw = await readSensitiveArtifactText(file, MAX_FEEDBACK_FILE_BYTES);
  } catch (error) {
    if (failSoft) return empty;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    if (failSoft) return empty;
    throw new Error("Feedback snapshot is not valid JSON", { cause: error });
  }
  const admitted = admitFeedbackData(parsed, vaultRoot);
  if (admitted) return admitted;
  if (failSoft) return empty;
  throw new Error("Feedback snapshot failed strict admission");
}

async function acquireFeedbackPublisher(scopes: PersistenceFamilyScopes): Promise<PersistenceFamilyLeaseHandle> {
  const started = performance.now();
  while (true) {
    try {
      return await acquirePersistenceFamilyLeaseInScopes(scopes, {
        role: "publisher",
        gateTimeoutMs: 2_000,
        gatePollMs: FEEDBACK_PUBLISH_POLL_MS
      });
    } catch (error) {
      if (!(error instanceof PersistenceLeaseConflictError)) throw error;
      const elapsed = performance.now() - started;
      if (elapsed >= FEEDBACK_PUBLISH_WAIT_MS) {
        throw new Error("Feedback publisher lease remained conflicted for 5000 ms", { cause: error });
      }
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.min(FEEDBACK_PUBLISH_POLL_MS, FEEDBACK_PUBLISH_WAIT_MS - elapsed))
      );
    }
  }
}

/**
 * Cache-dir location of the routing-key-scoped feedback sidecar. MIRRORS `defaultIndexFile`
 * (fts5.ts): same `enquire` cache dir (honoring `$XDG_CACHE_HOME`) under the same
 * first-12-hex sha1(vaultRoot) key, so the file sits beside the other stem-scoped
 * artifacts and `prune`'s `ENQUIRE_CACHE_ARTIFACT` pattern recognizes it. The
 * truncated key is not collision-proof root identity; the dir+key parity with
 * `defaultIndexFile` is pinned by `tests/feedback.test.ts`.
 *
 * @param vaultRoot Absolute path to the vault root.
 * @returns Absolute path to `<cacheDir>/<hash>.feedback.json`.
 */
export function defaultFeedbackFile(vaultRoot: string): string {
  const base =
    process.env.XDG_CACHE_HOME ??
    (process.platform === "darwin" ? path.join(os.homedir(), "Library", "Caches") : path.join(os.homedir(), ".cache"));
  const hash = createHash("sha1").update(vaultRoot).digest("hex").slice(0, 12);
  return path.join(base, "enquire", `${hash}.feedback.json`);
}

/**
 * A note's feedback score in [0, 1): `useful / (useful + notUseful + 1)`. The +1
 * Laplace term keeps a single positive mark modest (0.5) and an unmarked note at
 * 0, so the search boost is gentle and monotonically increasing in NET
 * usefulness (more useful marks raise it; not-useful marks lower it).
 */
export function feedbackScore(e: FeedbackEntry): number {
  const denom = e.useful + e.notUseful + 1;
  return denom > 0 ? e.useful / denom : 0;
}

/**
 * Root-checked feedback store at one admitted path. Holds the tally in memory,
 * so a `mark_useful` during a `serve` session immediately influences the next
 * `obsidian_search` boost, and attempts each persisted generation atomically.
 *
 * Concurrency: `record` serializes locally, acquires the fixed feedback-family
 * cross-process publisher role, reloads the latest generation while holding it,
 * then performs bounded admission, atomic publication, and the in-memory commit.
 * A size, admission, acquisition, or publication failure rejects without
 * creating an ephemeral score. If publisher-marker cleanup fails only after
 * the durable and in-memory commits, the call still succeeds exactly once;
 * the process lease-debt registry owns that exact cleanup for targeted retry.
 */
export class FeedbackStore {
  private entryCount: number;
  private lifecycle: "open" | "closing" | "closed" = "open";
  private closePromise: Promise<void> | undefined;

  private constructor(
    readonly file: string,
    private data: FeedbackData,
    private readonly vaultRoot: string | undefined,
    private readonly lifetime: PersistenceFamilyLeaseHandle
  ) {
    this.entryCount = Object.keys(data.entries).length;
  }

  /**
   * Open (or initialize) an admitted `.feedback.json` store. After namespace
   * admission, a missing / unreadable / malformed sidecar yields an EMPTY store
   * (the boost simply has no signal), so corrupt contents cannot break boot.
   * The exact version-1 shape is admitted fail-soft; rootless version-1 is the
   * sole legacy form. Counts must be non-negative safe integers, timestamps
   * must be canonical ISO strings (or the legacy empty value), and malformed
   * entries are dropped. Reopen inspects at most
   * {@link MAX_FEEDBACK_ENTRIES} own enumerable properties and retains the
   * valid entries among that bounded ECMAScript enumeration prefix.
   *
   * @throws {TypeError} If `file` is outside the exact feedback namespace.
   */
  static async open(file: string, vaultRoot?: string): Promise<FeedbackStore> {
    assertFeedbackFilePath(file);
    const lifetime = await acquirePersistenceFamilyLease({
      targetPath: file,
      familyKey: FEEDBACK_PERSISTENCE_FAMILY,
      role: "shared",
      gateTimeoutMs: 2_000,
      gatePollMs: FEEDBACK_PUBLISH_POLL_MS
    });
    try {
      const canonicalFile = path.join(lifetime.scopes.family.canonicalParent, lifetime.scopes.family.targetName);
      const data = await loadFeedbackData(canonicalFile, vaultRoot);
      return new FeedbackStore(canonicalFile, data, vaultRoot, lifetime);
    } catch (error) {
      try {
        await lifetime.release();
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "Feedback open failed and lifetime rollback was incomplete");
      }
      throw error;
    }
  }

  /**
   * Record a usefulness mark for each DISTINCT relative note path. The complete
   * read-modify-write is serialized across processes: after publisher admission,
   * the current file is reloaded and stale in-memory entries are never used as a
   * publication base. An over-limit generation or publication error rejects
   * without changing the live ranking signal. `nowIso` is injected so the module
   * is Date-free and the write is deterministic under test.
   *
   * @returns the count of distinct paths recorded (paths skipped at the entry cap
   *   are still counted if they refer to an EXISTING entry).
   */
  async record(paths: readonly string[], useful: boolean, nowIso: string): Promise<number> {
    if (this.lifecycle !== "open") throw new Error("Feedback store is closing or closed");
    if (!Array.isArray(paths) || paths.some((relPath) => typeof relPath !== "string")) {
      throw new TypeError("Feedback paths must be an array of strings");
    }
    if (typeof useful !== "boolean") throw new TypeError("Feedback useful must be a boolean");
    if (typeof nowIso !== "string" || !isCanonicalFeedbackTimestamp(nowIso)) {
      throw new TypeError("Feedback timestamp must be an exact ISO-8601 string");
    }

    let recorded = 0;
    const transaction = this.persistChain.then(async () => {
      const publisher = await acquireFeedbackPublisher(this.lifetime.scopes);
      let commitComplete = false;
      let operationFailed = false;
      let operationError: unknown;
      try {
        const pinnedScopes = publisher.scopes;
        const latest = await loadFeedbackData(this.file, this.vaultRoot, false);
        const seen = new Set<string>();
        const updates = new Map<string, FeedbackEntry>();
        let projectedBytes = feedbackDataBytes(latest);
        let projectedCount = Object.keys(latest.entries).length;

        for (const relPath of paths) {
          const canonicalPath = relPath.trim();
          if (canonicalPath.length === 0 || seen.has(canonicalPath)) continue;
          if (canonicalPath.length > MAX_FEEDBACK_PATH_CHARS) {
            throw new Error(`Feedback path exceeds ${MAX_FEEDBACK_PATH_CHARS} characters`);
          }
          const existing = updates.get(canonicalPath) ?? latest.entries[canonicalPath];
          if (!existing && projectedCount >= MAX_FEEDBACK_ENTRIES) continue;
          const next: FeedbackEntry = {
            useful: existing?.useful ?? 0,
            notUseful: existing?.notUseful ?? 0,
            lastMarked: nowIso
          };
          if (useful) next.useful += 1;
          else next.notUseful += 1;
          if (!Number.isSafeInteger(next.useful + next.notUseful + 1)) {
            throw new Error("Feedback counter exceeds the safe integer envelope");
          }
          const nextPairBytes = feedbackEntryPairBytes(canonicalPath, next);
          if (existing) {
            projectedBytes += nextPairBytes - feedbackEntryPairBytes(canonicalPath, existing);
          } else {
            projectedBytes += nextPairBytes + (projectedCount > 0 ? 1 : 0);
            projectedCount += 1;
          }
          if (projectedBytes > MAX_FEEDBACK_FILE_BYTES) {
            throw new Error("feedback snapshot exceeds the persistent read limit");
          }
          seen.add(canonicalPath);
          updates.set(canonicalPath, next);
        }

        if (updates.size === 0) {
          this.data = latest;
          this.entryCount = Object.keys(latest.entries).length;
        } else {
          const entries = Object.assign(Object.create(null) as Record<string, FeedbackEntry>, latest.entries);
          for (const [relPath, entry] of updates) entries[relPath] = entry;
          const proposed: FeedbackData = {
            version: 1,
            ...(latest.vault_root ? { vault_root: latest.vault_root } : {}),
            entries
          };
          await revalidatePersistenceLeaseScope(pinnedScopes.namespace);
          await revalidatePersistenceLeaseScope(pinnedScopes.family);
          await this.writeOnce(proposed);
          // publishSensitiveArtifact resolves only after rename has committed.
          // From this point onward the tally is durable and a caller retry would
          // double-apply it, so publish the in-memory/result state before either
          // fallible post-commit scope check. A failed check still makes the next
          // publisher acquisition fail closed if the scope really drifted, but it
          // must not turn this already-committed operation into a retriable error.
          this.data = proposed;
          this.entryCount = projectedCount;
          recorded = updates.size;
          commitComplete = true;
          try {
            await revalidatePersistenceLeaseScope(pinnedScopes.family);
            await revalidatePersistenceLeaseScope(pinnedScopes.namespace);
          } catch {
            // The physical commit already landed. Persistent scope drift is
            // rejected by the next acquire; this call must remain successful
            // so a caller retry cannot double-apply the durable tally.
          }
        }
      } catch (error) {
        operationFailed = true;
        operationError = error;
      }

      let releaseFailed = false;
      let releaseError: unknown;
      try {
        await publisher.release();
      } catch (error) {
        releaseFailed = true;
        releaseError = error;
      }
      if (operationFailed) {
        if (releaseFailed) {
          throw new AggregateError(
            [operationError, releaseError],
            "Feedback transaction failed and publisher cleanup was incomplete"
          );
        }
        throw operationError;
      }
      if (releaseFailed && !commitComplete) {
        throw releaseError;
      }
      // A durable feedback generation must never be reported as failed solely
      // because its exact publisher marker could not be removed afterward: an
      // automatic caller retry would double-apply the tally. release() retained
      // that current-process marker in the bounded debt registry; the next
      // same-scope acquire and shutdown both retry it fail-closed.
    });
    this.persistChain = transaction.catch(() => {});
    await transaction;
    return recorded;
  }

  /**
   * Live snapshot: relPath → score in (0, 1). Recomputed per search call (the map
   * is small — one entry per marked note). Notes with a net-zero or negative score
   * are omitted; the boost treats an absent path as score 0.
   */
  scores(): Map<string, number> {
    const m = new Map<string, number>();
    for (const [k, e] of Object.entries(this.data.entries)) {
      const s = feedbackScore(e);
      if (s > 0) m.set(k, s);
    }
    return m;
  }

  /** Number of notes with any durably recorded feedback (for the tool response). */
  size(): number {
    return this.entryCount;
  }

  /**
   * Stop admitting records, join the current persistence tail, and release the
   * family lifetime before its namespace lifetime. Concurrent calls share one
   * attempt; a failed release keeps the store non-writable and a later call
   * retries the exact remaining marker cleanup.
   *
   * @returns A promise that settles after the exact lifetime markers are gone.
   */
  /**
   * Erase this vault's feedback sidecar and any generated sibling.
   *
   * `clear-cache` deliberately excludes the `.feedback.json` subclass — the
   * sidecar is USER-recorded state, not derived data, so clearing a parse cache
   * must not discard it — and `prune` only reaches stems OTHER than the one
   * kept. Without this the marks a user made for their ACTIVE vault could not
   * be removed by any command, which is the right-to-erasure gap the AH-5
   * post-merge re-sweep named. Follows the receipt rule in
   * `src/erasure-receipt.ts`: only `ENOENT` is idempotent success, any other
   * failure names the artifact, and a removal is believed only once the entry
   * is re-statted absent.
   *
   * BOUNDED: this removes the current generation. A `serve` running with
   * `--feedback-weight > 0` republishes the sidecar on the next recorded mark,
   * so stop the server first when the intent is permanent erasure.
   *
   * @param file - Exact `<hash>.feedback.json` path to erase.
   * @returns `true` when the sidecar or a generated sibling was removed.
   * @throws If the path is outside the feedback namespace, a present leaf is
   *   not a regular file or symlink, or a removal cannot be completed.
   * @example
   * await FeedbackStore.clearOnDisk(defaultFeedbackFile(vault.root));
   */
  static async clearOnDisk(file: string): Promise<boolean> {
    assertFeedbackFilePath(file);
    // Exclusive family role, like every other eraser: a `serve` holding the
    // publisher role must not commit a new generation between the preflight
    // and the unlink.
    const eraser = await acquirePersistenceFamilyLease({
      targetPath: file,
      familyKey: FEEDBACK_PERSISTENCE_FAMILY,
      role: "eraser",
      gateTimeoutMs: 2_000,
      gatePollMs: FEEDBACK_PUBLISH_POLL_MS
    });
    let operationError: unknown;
    let removed = false;
    try {
      const canonicalFile = path.join(eraser.scopes.family.canonicalParent, eraser.scopes.family.targetName);
      // Validate generated siblings BEFORE deleting anything, so a malformed
      // one fails closed instead of turning erasure into a partial delete.
      await preflightSensitiveArtifactTemps(canonicalFile);
      let entry: import("node:fs").Stats | null = null;
      try {
        entry = await fs.lstat(canonicalFile);
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
          throw new Error(`Unable to inspect feedback store artifact before clearing: ${path.basename(file)}`, {
            cause: err
          });
        }
      }
      if (entry !== null && !entry.isFile() && !entry.isSymbolicLink()) {
        throw new Error(`Refusing to clear an unsafe feedback store artifact: ${path.basename(file)}`);
      }
      removed = await removeArtifact(canonicalFile, "feedback store artifact");
      removed = (await removeSensitiveArtifactTemps(canonicalFile)) > 0 || removed;
    } catch (error) {
      operationError = error;
    }
    let releaseError: unknown;
    try {
      await eraser.release();
    } catch (error) {
      releaseError = error;
    }
    if (operationError !== undefined && releaseError !== undefined) {
      throw new AggregateError(
        [operationError, releaseError],
        "Feedback clear failed and eraser release was incomplete"
      );
    }
    if (operationError !== undefined) throw operationError;
    if (releaseError !== undefined) throw releaseError;
    return removed;
  }

  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.lifecycle = "closing";
    const close = async (): Promise<void> => {
      await this.persistChain;
      await this.lifetime.release();
      this.lifecycle = "closed";
    };
    const attempt = close();
    this.closePromise = attempt;
    void attempt.then(
      () => undefined,
      () => {
        if (this.closePromise === attempt) this.closePromise = undefined;
      }
    );
    return attempt;
  }

  /**
   * Serializes feedback transactions behind a per-store promise chain. The
   * store is a SINGLE instance shared across all serve-http sessions, so an
   * older proposal cannot publish after a newer one and a failed proposal does
   * not poison subsequent admission.
   */
  private persistChain: Promise<void> = Promise.resolve();

  private async writeOnce(data: FeedbackData = this.data): Promise<void> {
    // The common publisher creates an unpredictable exclusive mode-0600
    // sibling and renames it over the final leaf. It cannot follow a
    // deterministic temp symlink, and it never chmods the published path.
    const serialized = JSON.stringify(data);
    if (Buffer.byteLength(serialized, "utf8") > MAX_FEEDBACK_FILE_BYTES) {
      throw new Error("feedback snapshot exceeds the persistent read limit");
    }
    await publishSensitiveArtifact(this.file, serialized, MAX_FEEDBACK_FILE_BYTES);
  }
}
