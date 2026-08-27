import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Vault } from "../src/vault.js";
import { VaultWatcher } from "../src/watcher.js";

describe("bounded vault inventories", () => {
  let root = "";

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-bounded-listing-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("returns a complete mixed-extension snapshot below both budgets", async () => {
    await fs.writeFile(path.join(root, "A.md"), "# A\n");
    await fs.writeFile(path.join(root, "B.pdf"), "pdf");
    await fs.writeFile(path.join(root, "ignored.txt"), "ignored");
    const vault = new Vault(root);

    const listing = await vault.listFilesByExtensionsBounded([".md", ".pdf"], 2, 3);

    expect(listing.complete).toBe(true);
    expect(listing.visitedEntries).toBe(3);
    expect(listing.entries.map((entry) => entry.relPath).sort()).toEqual(["A.md", "B.pdf"]);
  });

  it("keeps staging-only markdown reads outside the shared parsed-note cache", async () => {
    await fs.writeFile(path.join(root, "Stage.md"), "# Candidate\n");
    const vault = new Vault(root);
    const cache = (vault as unknown as { cache: ReadonlyMap<string, unknown> }).cache;

    const staged = await vault.readNoteUncached("Stage.md");
    expect(staged.content).toContain("Candidate");
    expect(cache.size).toBe(0);

    await vault.readNote("Stage.md");
    expect(cache.size).toBe(1);
  });

  it("stops at the first admitted file beyond the result cap", async () => {
    for (const name of ["A.md", "B.md", "C.md"]) {
      await fs.writeFile(path.join(root, name), `# ${name}\n`);
    }
    const vault = new Vault(root);

    const listing = await vault.listFilesByExtensionsBounded([".md"], 2, 10);

    expect(listing.complete).toBe(false);
    expect(listing.entries).toHaveLength(2);
    expect(listing.visitedEntries).toBe(3);
  });

  it("bounds traversal even when no visited file has a requested extension", async () => {
    for (const name of ["A.txt", "B.txt", "C.txt", "D.txt"]) {
      await fs.writeFile(path.join(root, name), name);
    }
    const vault = new Vault(root);

    const listing = await vault.listFilesByExtensionsBounded([".md"], 10, 2);

    expect(listing.complete).toBe(false);
    expect(listing.entries).toEqual([]);
    expect(listing.visitedEntries).toBe(3);
  });

  it("marks an unreadable directory snapshot incomplete instead of treating it as empty", async () => {
    const vault = new Vault(root);
    const opendir = vi.spyOn(fs, "opendir").mockRejectedValueOnce(new Error("injected directory read refusal"));

    try {
      const listing = await vault.listFilesByExtensionsBounded([".md"], 10, 10);

      expect(listing).toEqual({ entries: [], visitedEntries: 0, complete: false });
    } finally {
      opendir.mockRestore();
    }
  });

  it("makes exact legacy listing wrappers reject an incomplete bounded receipt", async () => {
    const vault = new Vault(root);
    const listing = vi
      .spyOn(vault, "listFilesByExtensionsBounded")
      .mockResolvedValue({ entries: [], visitedEntries: 11, complete: false });

    await expect(vault.listMarkdown()).rejects.toThrow(/Markdown inventory is incomplete/);
    await expect(vault.listFilesByExtension(".pdf")).rejects.toThrow(/\.pdf inventory is incomplete/);
    expect(listing).toHaveBeenNthCalledWith(1, [".md"], 100_000, 1_000_000, undefined);
    expect(listing).toHaveBeenNthCalledWith(2, [".pdf"], 100_000, 1_000_000, undefined);
  });

  it("keeps exact legacy listing wrappers complete and deterministically path-sorted", async () => {
    await fs.mkdir(path.join(root, "Z"));
    await fs.writeFile(path.join(root, "Z", "Later.md"), "# Later\n");
    await fs.writeFile(path.join(root, "Earlier.md"), "# Earlier\n");
    await fs.writeFile(path.join(root, "Doc.pdf"), "pdf");
    const vault = new Vault(root);

    await expect(vault.listMarkdown()).resolves.toMatchObject([
      { relPath: "Earlier.md" },
      { relPath: path.join("Z", "Later.md") }
    ]);
    await expect(vault.listFilesByExtension(".pdf")).resolves.toMatchObject([{ relPath: "Doc.pdf" }]);
  });

  it("marks a real directory tree beyond the walker depth envelope incomplete", async () => {
    let current = root;
    for (let depth = 0; depth < 65; depth++) {
      current = path.join(current, `d${depth}`);
      await fs.mkdir(current);
    }
    const vault = new Vault(root);

    const listing = await vault.listFilesByExtensionsBounded([".md"], 10, 1_000);

    expect(listing.complete).toBe(false);
    expect(listing.entries).toEqual([]);
    expect(listing.visitedEntries).toBeLessThanOrEqual(65);
  });

  it("makes watcher alias inventory fail before inspecting an over-cap result tail", async () => {
    for (const name of ["A.md", "B.md", "C.md"]) {
      await fs.writeFile(path.join(root, name), `# ${name}\n`);
    }
    const vault = new Vault(root);
    await vault.ensureExists();
    const watcher = new VaultWatcher({
      vault,
      silent: true,
      deferActivation: true,
      activationPathLimit: 2,
      activationScanEntryLimit: 10
    });
    const inventory = watcher as unknown as {
      inspectVisibleAliasInventory(): Promise<unknown>;
    };

    await expect(inventory.inspectVisibleAliasInventory()).rejects.toThrow(/found 3 paths \(limit 2\)/);
    await expect(watcher.close()).resolves.toBeUndefined();
  });

  it("makes activation join an attached-sink drift scan accepted before its first await", async () => {
    const vault = new Vault(root);
    await vault.ensureExists();
    const watcher = new VaultWatcher({ vault, silent: true, deferActivation: true });
    let releaseListing: ((value: { entries: []; visitedEntries: number; complete: boolean }) => void) | undefined;
    const listingGate = new Promise<{ entries: []; visitedEntries: number; complete: boolean }>((resolve) => {
      releaseListing = resolve;
    });
    vi.spyOn(vault, "listFilesByExtensionsBounded").mockImplementation(async () => listingGate);
    (
      watcher as unknown as {
        embedDb: {
          getSourceStates(): [];
          getQuarantinedPaths(): [];
        };
      }
    ).embedDb = {
      getSourceStates: () => [],
      getQuarantinedPaths: () => []
    };

    const capture = watcher.captureAttachedSinkDrift();
    const activation = watcher.activate();
    let activated = false;
    void activation.then(() => {
      activated = true;
    });
    await Promise.resolve();
    expect(activated).toBe(false);

    releaseListing?.({ entries: [], visitedEntries: 0, complete: true });
    await expect(capture).resolves.toBeUndefined();
    await expect(activation).resolves.toBeUndefined();
    expect(activated).toBe(true);
    await expect(watcher.close()).resolves.toBeUndefined();
  });

  it("bounds live distinct-path concurrency and coalesces a pending path to its latest hint", async () => {
    const vault = new Vault(root);
    await vault.ensureExists();
    const watcher = new VaultWatcher({
      vault,
      silent: true,
      liveEventConcurrency: 2,
      liveEventPendingLimit: 2
    });
    const internals = watcher as unknown as {
      handle(absPath: string, kind: "add" | "change" | "unlink"): Promise<void>;
      onFsEvent(absPath: string, kind: "add" | "change" | "unlink"): void;
    };
    let releaseFirstTwo: (() => void) | undefined;
    const firstTwoGate = new Promise<void>((resolve) => {
      releaseFirstTwo = resolve;
    });
    let active = 0;
    let maxActive = 0;
    const calls: Array<readonly [string, "add" | "change" | "unlink"]> = [];
    const handleSpy = vi.spyOn(internals, "handle").mockImplementation(async (absPath, kind) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      calls.push([path.basename(absPath), kind]);
      if (calls.length <= 2) await firstTwoGate;
      active -= 1;
    });

    internals.onFsEvent(path.join(root, "A.md"), "change");
    internals.onFsEvent(path.join(root, "B.md"), "change");
    internals.onFsEvent(path.join(root, "C.md"), "add");
    internals.onFsEvent(path.join(root, "C.md"), "unlink");
    internals.onFsEvent(path.join(root, "D.md"), "change");
    await Promise.resolve();
    expect(calls).toHaveLength(2);

    releaseFirstTwo?.();
    await expect(watcher.close()).resolves.toBeUndefined();

    expect(maxActive).toBe(2);
    expect(calls).toHaveLength(4);
    expect(calls).toContainEqual(["C.md", "unlink"]);
    expect(calls.filter(([name]) => name === "C.md")).toHaveLength(1);
    handleSpy.mockRestore();
  });

  it("fails stop when the bounded live pending-path inventory overflows", async () => {
    const vault = new Vault(root);
    await vault.ensureExists();
    const watcher = new VaultWatcher({
      vault,
      silent: true,
      liveEventConcurrency: 1,
      liveEventPendingLimit: 1
    });
    const internals = watcher as unknown as {
      handle(absPath: string, kind: "add" | "change" | "unlink"): Promise<void>;
      onFsEvent(absPath: string, kind: "add" | "change" | "unlink"): void;
    };
    let releaseActive: (() => void) | undefined;
    const activeGate = new Promise<void>((resolve) => {
      releaseActive = resolve;
    });
    vi.spyOn(internals, "handle").mockImplementation(async () => activeGate);

    internals.onFsEvent(path.join(root, "A.md"), "change");
    internals.onFsEvent(path.join(root, "B.md"), "change");
    expect(() => internals.onFsEvent(path.join(root, "C.md"), "change")).toThrow(/exceeded 1 pending distinct paths/);
    // Queue overflow is the remaining justified global latch: there is no
    // per-path quarantine to fall back on when events are dropped.
    expect(watcher.searchHealth).toEqual({ semanticUsable: false, hnswUsable: false });

    releaseActive?.();
    await expect(watcher.close()).rejects.toThrow(/exceeded 1 pending distinct paths/);
  });
});
