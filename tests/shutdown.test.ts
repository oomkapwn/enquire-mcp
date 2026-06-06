// v3.10.0-rc.19 (audit M3) — stdio graceful-shutdown orchestration tests.
//
// The fix consolidates three separate SIGINT/SIGTERM handlers (flush / watcher /
// fts) — where the cache-flush handler called process.exit(0) the moment its
// fast flush resolved, racing the async watcher close — into ONE orchestrator
// (shutdownStdioDeps) that AWAITS every async close before the caller exits.
// shutdownStdioDeps was extracted to src/shutdown.ts precisely so it's
// importable here (src/server.ts is in no-internal-imports' RESTRICTED_MODULES).

import { describe, expect, it } from "vitest";
import { shutdownStdioDeps } from "../src/shutdown.js";

/** Force a macrotask boundary so a fire-and-forget (non-awaited) async step
 *  visibly completes AFTER any synchronous follow-on work. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("shutdownStdioDeps (rc.19 M3)", () => {
  it("awaits every async close, in order: watcher → embed-db → cache → fts", async () => {
    const order: string[] = [];
    await shutdownStdioDeps({
      // Both async steps yield a macrotask before recording — so if the
      // orchestrator did NOT await them, the later SYNC steps (embeddb, fts)
      // would record first and the order assertion would fail.
      watcher: {
        close: async () => {
          await tick();
          order.push("watcher");
        }
      },
      watcherEmbedDb: { close: () => order.push("embeddb") },
      vault: {
        persistentCacheEnabled: true,
        saveDiskCache: async () => {
          await tick();
          order.push("savecache");
        }
      },
      ftsIndex: { close: () => order.push("fts") }
    });
    expect(order).toEqual(["watcher", "embeddb", "savecache", "fts"]);
  });

  it("skips the cache flush when the persistent cache is disabled", async () => {
    let flushed = false;
    await shutdownStdioDeps({
      vault: {
        persistentCacheEnabled: false,
        saveDiskCache: async () => {
          flushed = true;
        }
      }
    });
    expect(flushed).toBe(false);
  });

  it("is best-effort — a throwing step never blocks the remaining steps", async () => {
    const order: string[] = [];
    await expect(
      shutdownStdioDeps({
        watcher: {
          close: async () => {
            throw new Error("watcher boom");
          }
        },
        watcherEmbedDb: {
          close: () => {
            throw new Error("embed-db boom");
          }
        },
        vault: {
          persistentCacheEnabled: true,
          saveDiskCache: async () => {
            order.push("savecache");
          }
        },
        ftsIndex: { close: () => order.push("fts") }
      })
    ).resolves.toBeUndefined();
    // The cache flush + fts close STILL ran despite the two earlier throws.
    expect(order).toEqual(["savecache", "fts"]);
  });

  // NEGATIVE control — proves the ordering assertion in the first test genuinely
  // depends on AWAITING the async steps. A non-awaiting teardown (the pre-rc.19
  // shape) lets a synchronous "exit"/follow-on step run BEFORE the async close
  // finishes, producing the racy order the rc.19 await prevents.
  it("NEGATIVE control — a non-awaiting teardown records sync steps before async ones finish", async () => {
    const order: string[] = [];
    const watcherClose = async () => {
      await tick();
      order.push("watcher");
    };
    // Buggy/pre-rc.19 shape: fire-and-forget the async close, then "exit".
    void watcherClose();
    order.push("exit");
    // At "exit" time the async watcher close has NOT completed yet.
    expect(order).toEqual(["exit"]);
    // It only lands on a later macrotask — exactly the race shutdownStdioDeps removes.
    await tick();
    await tick();
    expect(order).toEqual(["exit", "watcher"]);
  });
});
