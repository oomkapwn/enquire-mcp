// v3.10.0-rc.19 (audit M3) — graceful-shutdown teardown helper for the stdio
// transport, extracted so it is unit-testable.
//
// src/server.ts is in the no-internal-imports RESTRICTED_MODULES list (the
// "registration boilerplate" rule in tests/no-internal-imports.test.ts), so a
// helper living there can't be imported by a test — the SAME reason
// embed-pipeline.ts was split out of server.ts in v3.8.0-rc.4. The stdio
// signal-teardown ORDERING is the audit-M3 fix (one orchestrator that awaits
// every async close before exit, instead of three separate SIGINT/SIGTERM
// handlers where the cache-flush one called process.exit(0) on its own and raced
// the others). Hosting it here lets tests/shutdown.test.ts exercise the ordering
// + best-effort semantics directly, with no import cycle: the deps are described
// by a minimal structural interface declared here, NOT imported from server.ts.

import { drainProcessPersistenceLeaseDebts } from "./persistence-lease.js";

/**
 * Minimal structural view of the {@link import("./server.js").ServerDeps}
 * handles that {@link shutdownStdioDeps} touches. Declared locally (rather than
 * importing `ServerDeps`) so this module stays free of any cycle with the
 * restricted server-registration module. Its only runtime dependency is the
 * leaf persistence-debt drain. `ServerDeps` structurally satisfies this shape,
 * so `startServer` passes its `deps` directly.
 */
export interface StdioShutdownDeps {
  feedbackStore?: { close(): Promise<void> } | null;
  vault: {
    persistentCacheEnabled: boolean;
    saveDiskCache(): Promise<void>;
    closePersistence(): Promise<void>;
  };
  ftsIndex?: { closeAndRelease(): Promise<void> } | null;
  watcher?: { close(): Promise<void> } | null;
  watcherEmbedDb?: { closeAndRelease(): Promise<void> } | null;
  hnswContext?: { persistenceLifetime?: { release(): Promise<void> } } | null;
}

/** Exact cleanup stage and its retained failure. */
export interface ServerResourceCleanupFailure {
  /** Ordered cleanup stage that rejected or threw. */
  readonly stage:
    | "feedback"
    | "watcher"
    | "watcher-embed-db"
    | "hnsw-lifetime"
    | "vault-cache-flush"
    | "vault-persistence"
    | "fts-index"
    | "process-persistence-debt";
  /** Original failure, retained without replacing a startup error. */
  readonly error: unknown;
}

/** Options for {@link cleanupPreparedServerDeps}. */
export interface ServerResourceCleanupOptions {
  /** Persist the current vault parse cache before closing its admission. */
  readonly flushVaultCache: boolean;
  /** Optional observer used by user-facing shutdown paths for flush diagnostics. */
  readonly onCacheFlushError?: (error: unknown) => void;
}

/** Retryable owner for one exact prepared server dependency graph. */
export interface PreparedServerCleanupOwner {
  /** True only after every applicable cleanup stage has completed successfully. */
  readonly complete: boolean;
  /** Ordered stages that still retain their exact original owner. */
  readonly pendingStages: readonly ServerResourceCleanupFailure["stage"][];
  /**
   * Attempt every incomplete stage once. Successful stages become terminal;
   * failed stages retain the same captured handle for a later call.
   *
   * @returns Failures from this bounded attempt only.
   */
  cleanup(): Promise<readonly ServerResourceCleanupFailure[]>;
}

/** Failure that keeps the exact resumable dependency owner reachable. */
export class PreparedServerCleanupError extends AggregateError {
  /** Exact owner whose failed stages may be retried without rediscovery. */
  readonly cleanupOwner: PreparedServerCleanupOwner;
  /** Failures from the bounded attempt that raised this error. */
  readonly failures: readonly ServerResourceCleanupFailure[];

  /**
   * Create an ownership-carrying cleanup failure.
   *
   * @param message - Path-safe lifecycle diagnostic.
   * @param failures - Failures from one bounded cleanup attempt.
   * @param cleanupOwner - Exact resumable owner retained by the failure.
   * @param precedingCauses - Earlier startup/protocol failures to retain first.
   */
  constructor(
    message: string,
    failures: readonly ServerResourceCleanupFailure[],
    cleanupOwner: PreparedServerCleanupOwner,
    precedingCauses: readonly unknown[] = []
  ) {
    super([...precedingCauses, ...failures.map(({ error }) => error)], message);
    this.name = "PreparedServerCleanupError";
    this.failures = [...failures];
    this.cleanupOwner = cleanupOwner;
  }
}

interface PreparedServerCleanupStage {
  readonly stage: ServerResourceCleanupFailure["stage"];
  readonly action: () => void | Promise<void>;
}

/**
 * Capture the exact handles owned by one prepared server generation and make
 * their cleanup resumable. The owner is deliberately stateful: a retry never
 * repeats a stage that already succeeded, while a rejected stage calls the
 * same captured object again instead of rediscovering or reacquiring it.
 *
 * Calls are single-flight. There is no automatic retry, sleep, or loop; the
 * process lifecycle owner decides when to make another bounded attempt.
 *
 * @param deps - Exact dependency graph returned (or partially assembled) by preparation.
 * @param options - Cache publication policy fixed for this generation.
 * @returns A resumable cleanup owner.
 */
export function createPreparedServerCleanupOwner(
  deps: StdioShutdownDeps,
  options: ServerResourceCleanupOptions
): PreparedServerCleanupOwner {
  // Capture every concrete owner now. Reading `deps.*` again on retry could
  // accidentally follow a replaced field rather than discharge the original
  // generation's debt.
  const feedbackStore = deps.feedbackStore;
  const watcher = deps.watcher;
  const watcherEmbedDb = deps.watcherEmbedDb;
  const hnswLifetime = deps.hnswContext?.persistenceLifetime;
  const vault = deps.vault;
  const ftsIndex = deps.ftsIndex;
  const stages: PreparedServerCleanupStage[] = [];
  if (feedbackStore) stages.push({ stage: "feedback", action: () => feedbackStore.close() });
  if (watcher) stages.push({ stage: "watcher", action: () => watcher.close() });
  if (watcherEmbedDb) {
    stages.push({ stage: "watcher-embed-db", action: () => watcherEmbedDb.closeAndRelease() });
  }
  if (hnswLifetime) stages.push({ stage: "hnsw-lifetime", action: () => hnswLifetime.release() });
  if (options.flushVaultCache && vault.persistentCacheEnabled) {
    stages.push({ stage: "vault-cache-flush", action: () => vault.saveDiskCache() });
  }
  stages.push({ stage: "vault-persistence", action: () => vault.closePersistence() });
  if (ftsIndex) stages.push({ stage: "fts-index", action: () => ftsIndex.closeAndRelease() });
  stages.push({
    stage: "process-persistence-debt",
    action: async () => {
      const report = await drainProcessPersistenceLeaseDebts();
      if (
        report.failures.length > 0 ||
        report.status.ownerCount > 0 ||
        report.status.artifactCount > 0 ||
        report.status.saturated
      ) {
        throw new AggregateError(
          report.failures.map(({ error }) => error),
          "Process persistence cleanup retained exact ownership debt"
        );
      }
    }
  });

  const completed = new Set<ServerResourceCleanupFailure["stage"]>();
  let activeAttempt: Promise<readonly ServerResourceCleanupFailure[]> | undefined;
  const owner: PreparedServerCleanupOwner = {
    get complete() {
      return completed.size === stages.length;
    },
    get pendingStages() {
      return stages.filter(({ stage }) => !completed.has(stage)).map(({ stage }) => stage);
    },
    cleanup: () => {
      if (activeAttempt) return activeAttempt;
      const attempt = (async (): Promise<readonly ServerResourceCleanupFailure[]> => {
        const failures: ServerResourceCleanupFailure[] = [];
        for (const { stage, action } of stages) {
          if (completed.has(stage)) continue;
          try {
            await action();
            completed.add(stage);
          } catch (error) {
            failures.push({ stage, error });
            if (stage === "vault-cache-flush") {
              try {
                options.onCacheFlushError?.(error);
              } catch {
                // Reporting must never prevent the remaining owners from closing.
              }
            }
          }
        }
        return failures;
      })();
      activeAttempt = attempt;
      void attempt.then(
        () => {
          if (activeAttempt === attempt) activeAttempt = undefined;
        },
        () => {
          // Each action is caught above. Keep the guard defensive if a future
          // refactor adds orchestration outside that boundary.
          if (activeAttempt === attempt) activeAttempt = undefined;
        }
      );
      return attempt;
    }
  };
  return owner;
}

/**
 * Close every persistence owner acquired by server preparation in one fixed
 * order. Every stage is awaited and best-effort: one failure is retained in
 * the returned list while all later owners are still closed.
 *
 * Startup rollback passes `flushVaultCache: false` because a partially
 * prepared generation must not publish cache bytes. Ordinary shutdown passes
 * `true`, then closes Vault persistence admission only after that flush.
 *
 * @param deps - Prepared or partially prepared resource owners.
 * @param options - Whether to flush the Vault cache and how to report a flush failure.
 * @returns Ordered cleanup failures; an empty list proves every attempted stage completed.
 */
export async function cleanupPreparedServerDeps(
  deps: StdioShutdownDeps,
  options: ServerResourceCleanupOptions
): Promise<readonly ServerResourceCleanupFailure[]> {
  return createPreparedServerCleanupOwner(deps, options).cleanup();
}

/**
 * v3.10.0-rc.19 (audit M3) — single graceful-shutdown teardown for the stdio
 * transport, mirroring {@link import("./http-transport.js").shutdownHttpServer}'s
 * ordering. Closes the feedback persistence lifetime, watcher (async chokidar)
 * and its embed-db handle, flushes the persistent disk cache, then closes the
 * fts5 index — **awaiting each async step** so a fast cache flush can't race
 * ahead and let `process.exit` kill the others mid-flight.
 *
 * Pre-rc.19, stdio mode registered three separate SIGINT/SIGTERM handlers
 * (flush / watcher / fts) and the flush handler called `process.exit(0)` the
 * moment its `saveDiskCache` resolved — racing the (async) `watcher.close()`.
 *
 * Best-effort across stages, but never false-success: a rejected stage does not
 * block later stages and the completed attempt rejects with the exact cleanup
 * owner retained for a bounded retry. Cache diagnostics intentionally omit the
 * underlying error text so an absolute persistence path cannot leak to stderr.
 *
 * @param deps - Prepared dependency graph (used only when `owner` is omitted).
 * @param owner - Existing exact owner for a retry of failed stages.
 * @returns A promise that resolves only when every dependency stage is terminal.
 */
export async function shutdownStdioDeps(
  deps: StdioShutdownDeps,
  owner: PreparedServerCleanupOwner = createPreparedServerCleanupOwner(deps, {
    flushVaultCache: true,
    onCacheFlushError: () => {
      process.stderr.write("enquire: cache flush failed; retained for retry\n");
    }
  })
): Promise<void> {
  const failures = await owner.cleanup();
  if (failures.length > 0) {
    throw new PreparedServerCleanupError(
      `Server dependency shutdown was incomplete at stage(s): ${failures.map(({ stage }) => stage).join(", ")}`,
      failures,
      owner
    );
  }
}

/**
 * Retry one incomplete process shutdown exactly once before the signal owner
 * decides its exit status. The callback must retain the same exact cleanup
 * owner across calls; successful stages are therefore not repeated.
 *
 * @param shutdown - One bounded attempt against the retained cleanup owner.
 * @returns After the first successful attempt, including a successful retry.
 * @throws {AggregateError} When both bounded attempts remain incomplete.
 * @example
 * await retryIncompleteShutdownOnce(() => shutdownStdioDeps(deps, owner));
 */
export async function retryIncompleteShutdownOnce(shutdown: () => Promise<void>): Promise<void> {
  let firstFailure: unknown;
  try {
    await shutdown();
    return;
  } catch (error) {
    firstFailure = error;
  }
  try {
    await shutdown();
  } catch (retryFailure) {
    throw new AggregateError([firstFailure, retryFailure], "Shutdown remained incomplete after one bounded retry");
  }
}
