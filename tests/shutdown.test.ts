// v3.10.0-rc.19 (audit M3) — stdio graceful-shutdown orchestration tests.
//
// The fix consolidates three separate SIGINT/SIGTERM handlers (flush / watcher /
// fts) — where the cache-flush handler called process.exit(0) the moment its
// fast flush resolved, racing the async watcher close — into ONE orchestrator
// (shutdownStdioDeps) that AWAITS every async close before the caller exits.
// shutdownStdioDeps was extracted to src/shutdown.ts precisely so it's
// importable here (src/server.ts is in no-internal-imports' RESTRICTED_MODULES).

import { describe, expect, it } from "vitest";
import {
  cleanupPreparedServerDeps,
  createPreparedServerCleanupOwner,
  PreparedServerCleanupError,
  retryIncompleteShutdownOnce,
  shutdownStdioDeps
} from "../src/shutdown.js";

/** Force a macrotask boundary so a fire-and-forget (non-awaited) async step
 *  visibly completes AFTER any synchronous follow-on work. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("shutdownStdioDeps (rc.19 M3)", () => {
  it("awaits every async close in the complete persistence-owner order", async () => {
    const order: string[] = [];
    await shutdownStdioDeps({
      feedbackStore: {
        close: async () => {
          await tick();
          order.push("feedback");
        }
      },
      // Both async steps yield a macrotask before recording — so if the
      // orchestrator did NOT await them, the later SYNC steps (embeddb, fts)
      // would record first and the order assertion would fail.
      watcher: {
        close: async () => {
          await tick();
          order.push("watcher");
        }
      },
      watcherEmbedDb: {
        closeAndRelease: async () => {
          await tick();
          order.push("embeddb");
        }
      },
      hnswContext: {
        persistenceLifetime: {
          release: async () => {
            await tick();
            order.push("hnsw");
          }
        }
      },
      vault: {
        persistentCacheEnabled: true,
        saveDiskCache: async () => {
          await tick();
          order.push("savecache");
        },
        closePersistence: async () => {
          await tick();
          order.push("vault");
        }
      },
      ftsIndex: {
        closeAndRelease: async () => {
          await tick();
          order.push("fts");
        }
      }
    });
    expect(order).toEqual(["feedback", "watcher", "embeddb", "hnsw", "savecache", "vault", "fts"]);
  });

  it("skips only the cache flush when persistent caching is disabled", async () => {
    const order: string[] = [];
    await shutdownStdioDeps({
      vault: {
        persistentCacheEnabled: false,
        saveDiskCache: async () => {
          order.push("savecache");
        },
        closePersistence: async () => {
          order.push("vault");
        }
      },
      ftsIndex: {
        closeAndRelease: async () => {
          order.push("fts");
        }
      }
    });
    expect(order).toEqual(["vault", "fts"]);
  });

  it("is best-effort and retains every failure without blocking later owners", async () => {
    const order: string[] = [];
    const failures = await cleanupPreparedServerDeps(
      {
        feedbackStore: {
          close: async () => {
            order.push("feedback");
            throw new Error("feedback boom");
          }
        },
        watcher: {
          close: async () => {
            order.push("watcher");
            throw new Error("watcher boom");
          }
        },
        watcherEmbedDb: {
          closeAndRelease: async () => {
            order.push("embeddb");
            throw new Error("embed-db boom");
          }
        },
        hnswContext: {
          persistenceLifetime: {
            release: async () => {
              order.push("hnsw");
              throw new Error("hnsw boom");
            }
          }
        },
        vault: {
          persistentCacheEnabled: true,
          saveDiskCache: async () => {
            order.push("savecache");
            throw new Error("cache boom");
          },
          closePersistence: async () => {
            order.push("vault");
            throw new Error("vault boom");
          }
        },
        ftsIndex: {
          closeAndRelease: async () => {
            order.push("fts");
            throw new Error("fts boom");
          }
        }
      },
      {
        flushVaultCache: true,
        // A broken observer must not interrupt ownership cleanup either.
        onCacheFlushError: () => {
          throw new Error("observer boom");
        }
      }
    );

    expect(order).toEqual(["feedback", "watcher", "embeddb", "hnsw", "savecache", "vault", "fts"]);
    expect(failures.map(({ stage }) => stage)).toEqual([
      "feedback",
      "watcher",
      "watcher-embed-db",
      "hnsw-lifetime",
      "vault-cache-flush",
      "vault-persistence",
      "fts-index"
    ]);
    expect(failures.map(({ error }) => (error as Error).message)).toEqual([
      "feedback boom",
      "watcher boom",
      "embed-db boom",
      "hnsw boom",
      "cache boom",
      "vault boom",
      "fts boom"
    ]);
  });

  it("startup rollback never publishes the Vault cache but still releases every owner", async () => {
    const order: string[] = [];
    const failures = await cleanupPreparedServerDeps(
      {
        feedbackStore: { close: async () => void order.push("feedback") },
        watcher: { close: async () => void order.push("watcher") },
        watcherEmbedDb: { closeAndRelease: async () => void order.push("embeddb") },
        hnswContext: {
          persistenceLifetime: { release: async () => void order.push("hnsw") }
        },
        vault: {
          persistentCacheEnabled: true,
          saveDiskCache: async () => void order.push("savecache"),
          closePersistence: async () => void order.push("vault")
        },
        ftsIndex: { closeAndRelease: async () => void order.push("fts") }
      },
      { flushVaultCache: false }
    );

    expect(failures).toEqual([]);
    expect(order).toEqual(["feedback", "watcher", "embeddb", "hnsw", "vault", "fts"]);
  });

  it("retries only a failed stage through the same exact captured owner", async () => {
    const calls = { watcher: 0, embed: 0, vault: 0, fts: 0 };
    const exactEmbedOwner = {
      closeAndRelease: async () => {
        calls.embed++;
        if (calls.embed === 1) throw new Error("transient embed release");
      }
    };
    const owner = createPreparedServerCleanupOwner(
      {
        watcher: { close: async () => void calls.watcher++ },
        watcherEmbedDb: exactEmbedOwner,
        vault: {
          persistentCacheEnabled: false,
          saveDiskCache: async () => {},
          closePersistence: async () => void calls.vault++
        },
        ftsIndex: { closeAndRelease: async () => void calls.fts++ }
      },
      { flushVaultCache: true }
    );

    await expect(owner.cleanup()).resolves.toEqual([
      expect.objectContaining({ stage: "watcher-embed-db", error: expect.any(Error) })
    ]);
    expect(owner.complete).toBe(false);
    expect(owner.pendingStages).toEqual(["watcher-embed-db"]);
    expect(calls).toEqual({ watcher: 1, embed: 1, vault: 1, fts: 1 });

    await expect(owner.cleanup()).resolves.toEqual([]);
    expect(owner.complete).toBe(true);
    expect(calls).toEqual({ watcher: 1, embed: 2, vault: 1, fts: 1 });

    // Idempotence control: terminal stages and the recovered stage are never
    // called a third time after complete cleanup.
    await expect(owner.cleanup()).resolves.toEqual([]);
    expect(calls).toEqual({ watcher: 1, embed: 2, vault: 1, fts: 1 });
  });

  it("never reports stdio cleanup success while an exact release remains retryable", async () => {
    let attempts = 0;
    const deps = {
      vault: {
        persistentCacheEnabled: false,
        saveDiskCache: async () => {},
        closePersistence: async () => {
          attempts++;
          if (attempts === 1) throw new Error("transient vault release");
        }
      }
    };
    const owner = createPreparedServerCleanupOwner(deps, { flushVaultCache: true });

    await expect(shutdownStdioDeps(deps, owner)).rejects.toBeInstanceOf(PreparedServerCleanupError);
    expect(owner.pendingStages).toEqual(["vault-persistence"]);
    await expect(shutdownStdioDeps(deps, owner)).resolves.toBeUndefined();
    expect(attempts).toBe(2);
  });

  it("uses the retained owner for one bounded signal retry", async () => {
    let attempts = 0;
    await expect(
      retryIncompleteShutdownOnce(async () => {
        attempts++;
        if (attempts === 1) throw new Error("transient cleanup failure");
      })
    ).resolves.toBeUndefined();
    expect(attempts).toBe(2);
  });

  it("NEGATIVE control — persistent signal cleanup failure remains non-success after the bounded retry", async () => {
    let attempts = 0;
    await expect(
      retryIncompleteShutdownOnce(async () => {
        attempts++;
        throw new Error(`persistent cleanup failure ${attempts}`);
      })
    ).rejects.toMatchObject({
      errors: [
        expect.objectContaining({ message: "persistent cleanup failure 1" }),
        expect.objectContaining({ message: "persistent cleanup failure 2" })
      ]
    });
    expect(attempts).toBe(2);
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
