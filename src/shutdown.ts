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

/**
 * Minimal structural view of the {@link import("./server.js").ServerDeps}
 * handles that {@link shutdownStdioDeps} touches. Declared locally (rather than
 * importing `ServerDeps`) so this module stays dependency-free and free of any
 * import cycle with the restricted server-registration module. `ServerDeps`
 * structurally satisfies this shape, so `startServer` passes its `deps` directly.
 */
export interface StdioShutdownDeps {
  vault: { persistentCacheEnabled: boolean; saveDiskCache(): Promise<void> };
  ftsIndex?: { close(): void } | null;
  watcher?: { close(): Promise<void> } | null;
  watcherEmbedDb?: { close(): void } | null;
}

/**
 * v3.10.0-rc.19 (audit M3) — single graceful-shutdown teardown for the stdio
 * transport, mirroring {@link import("./http-transport.js").shutdownHttpServer}'s
 * ordering. Closes the watcher (async chokidar) + its embed-db handle, flushes
 * the persistent disk cache, then closes the fts5 index — **awaiting each async
 * step** so a fast cache flush can't race ahead and let `process.exit` kill the
 * others mid-flight.
 *
 * Pre-rc.19, stdio mode registered three separate SIGINT/SIGTERM handlers
 * (flush / watcher / fts) and the flush handler called `process.exit(0)` the
 * moment its `saveDiskCache` resolved — racing the (async) `watcher.close()`.
 *
 * Best-effort: a throw/rejection in any one step is swallowed so the remaining
 * steps still run (a watcher that fails to close must not block the cache flush
 * or the fts checkpoint). Cache-flush failures are surfaced on stderr because
 * losing the persistent cache silently would degrade the next cold start.
 */
export async function shutdownStdioDeps(deps: StdioShutdownDeps): Promise<void> {
  try {
    await deps.watcher?.close();
  } catch {
    /* best-effort */
  }
  try {
    // v3.8.0-rc.2 R-7 — WAL checkpoint happens at close, so no data loss.
    deps.watcherEmbedDb?.close();
  } catch {
    /* best-effort */
  }
  if (deps.vault.persistentCacheEnabled) {
    try {
      await deps.vault.saveDiskCache();
    } catch (err) {
      process.stderr.write(`enquire: cache flush failed — ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  try {
    deps.ftsIndex?.close();
  } catch {
    /* best-effort */
  }
}
