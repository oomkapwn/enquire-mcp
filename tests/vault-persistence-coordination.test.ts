import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PersistenceLeaseConflictError } from "../src/persistence-lease.js";
import { Vault } from "../src/vault.js";

const childFixture = path.resolve(__dirname, "fixtures", "vault-persistence-child.mjs");
const roots: string[] = [];
const children = new Set<ChildProcessWithoutNullStreams>();
const vaults = new Set<Vault>();

interface ChildHarness {
  readonly process: ChildProcessWithoutNullStreams;
  wait(event: "ready" | "publish-paused" | "published" | "closed"): Promise<void>;
  send(command: "release-publish" | "close"): void;
}

function trackedVault(...args: ConstructorParameters<typeof Vault>): Vault {
  const vault = new Vault(...args);
  vaults.add(vault);
  return vault;
}

async function makeRoot(prefix: string): Promise<string> {
  const lexical = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const root = await fs.realpath(lexical);
  roots.push(root);
  return root;
}

function childHarness(mode: "hold" | "pause-save", vaultRoot: string, cacheFile: string): ChildHarness {
  const child = spawn(process.execPath, [childFixture, mode, vaultRoot, cacheFile], {
    stdio: ["pipe", "pipe", "pipe"]
  });
  children.add(child);
  const queued = new Set<string>();
  const waiters = new Map<string, { resolve(): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
    while (true) {
      const newline = stdout.indexOf("\n");
      if (newline < 0) break;
      const line = stdout.slice(0, newline);
      stdout = stdout.slice(newline + 1);
      try {
        const message = JSON.parse(line) as { event?: unknown };
        if (typeof message.event !== "string") continue;
        const waiter = waiters.get(message.event);
        if (waiter) {
          clearTimeout(waiter.timer);
          waiters.delete(message.event);
          waiter.resolve();
        } else {
          queued.add(message.event);
        }
      } catch {
        // Non-protocol stdout is ignored; stderr is included in failures.
      }
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  child.once("exit", (code, signal) => {
    children.delete(child);
    for (const [event, waiter] of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(
        new Error(`Vault persistence child exited before ${event}: code=${code}, signal=${signal}, stderr=${stderr}`)
      );
    }
    waiters.clear();
  });
  return {
    process: child,
    wait: async (event) => {
      if (queued.delete(event)) return;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(event);
          reject(new Error(`Vault persistence child timed out before ${event}: ${stderr}`));
        }, 8_000);
        waiters.set(event, { resolve, reject, timer });
      });
    },
    send: (command) => child.stdin.write(`${command}\n`)
  };
}

async function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

async function seedCache(vaultRoot: string, cacheFile: string): Promise<string> {
  const seed = trackedVault(vaultRoot, { persistentCache: true, cacheFile });
  await seed.ensureExists();
  await seed.readNote(path.join(vaultRoot, "Hello.md"));
  await seed.saveDiskCache();
  const bytes = await fs.readFile(cacheFile, "utf8");
  await seed.closePersistence();
  return bytes;
}

afterEach(async () => {
  for (const child of children) child.kill("SIGKILL");
  await Promise.all([...children].map(waitForExit));
  children.clear();
  await Promise.allSettled([...vaults].map((vault) => vault.closePersistence()));
  vaults.clear();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("Vault parse-cache persistence coordination", () => {
  it("keeps live-holder bytes unchanged, then clears only after its awaited close", async () => {
    const vaultRoot = await makeRoot("enquire-vault-holder-");
    const cacheParent = await makeRoot("enquire-vault-cache-");
    const cacheFile = path.join(cacheParent, "cache.json");
    await fs.writeFile(path.join(vaultRoot, "Hello.md"), "holder body\n");
    const before = await seedCache(vaultRoot, cacheFile);

    const holder = childHarness("hold", vaultRoot, cacheFile);
    await holder.wait("ready");
    const eraser = trackedVault(vaultRoot, { persistentCache: true, cacheFile });
    await expect(eraser.clearDiskCache()).rejects.toBeInstanceOf(PersistenceLeaseConflictError);
    expect(await fs.readFile(cacheFile, "utf8")).toBe(before);

    const closed = holder.wait("closed");
    holder.send("close");
    await closed;
    await waitForExit(holder.process);
    await expect(eraser.clearDiskCache()).resolves.toBe(true);
    await expect(fs.lstat(cacheFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not let clear overtake a paused late publisher or resurrect bytes after close", async () => {
    const vaultRoot = await makeRoot("enquire-vault-publisher-");
    const cacheParent = await makeRoot("enquire-vault-cache-");
    const cacheFile = path.join(cacheParent, "cache.json");
    await fs.writeFile(path.join(vaultRoot, "Hello.md"), "old body\n");
    await fs.writeFile(path.join(vaultRoot, "Late.md"), "late body\n");
    const before = await seedCache(vaultRoot, cacheFile);

    const publisher = childHarness("pause-save", vaultRoot, cacheFile);
    await publisher.wait("publish-paused");
    const eraser = trackedVault(vaultRoot, { persistentCache: true, cacheFile });
    await expect(eraser.clearDiskCache()).rejects.toBeInstanceOf(PersistenceLeaseConflictError);
    expect(await fs.readFile(cacheFile, "utf8")).toBe(before);

    const published = publisher.wait("published");
    publisher.send("release-publish");
    await published;
    expect(await fs.readFile(cacheFile, "utf8")).toContain("late body");
    await expect(eraser.clearDiskCache()).rejects.toBeInstanceOf(PersistenceLeaseConflictError);

    const closed = publisher.wait("closed");
    publisher.send("close");
    await closed;
    await waitForExit(publisher.process);
    await expect(eraser.clearDiskCache()).resolves.toBe(true);
    await expect(fs.lstat(cacheFile)).rejects.toMatchObject({ code: "ENOENT" });
    await Promise.resolve();
    await expect(fs.lstat(cacheFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never auto-steals a killed holder orphan and leaves bytes unchanged", async () => {
    const vaultRoot = await makeRoot("enquire-vault-orphan-");
    const cacheParent = await makeRoot("enquire-vault-cache-");
    const cacheFile = path.join(cacheParent, "cache.json");
    await fs.writeFile(path.join(vaultRoot, "Hello.md"), "orphan body\n");
    const before = await seedCache(vaultRoot, cacheFile);

    const holder = childHarness("hold", vaultRoot, cacheFile);
    await holder.wait("ready");
    holder.process.kill("SIGKILL");
    await waitForExit(holder.process);

    const eraser = trackedVault(vaultRoot, { persistentCache: true, cacheFile });
    await expect(eraser.clearDiskCache()).rejects.toBeInstanceOf(PersistenceLeaseConflictError);
    expect(await fs.readFile(cacheFile, "utf8")).toBe(before);
  });

  it("pins an alias target so retargeting the symlink cannot redirect publish or clear", async () => {
    const vaultRoot = await makeRoot("enquire-vault-alias-");
    const cacheRoot = await makeRoot("enquire-vault-cache-");
    const original = path.join(cacheRoot, "original");
    const attacker = path.join(cacheRoot, "attacker");
    const alias = path.join(cacheRoot, "current");
    await fs.mkdir(original);
    await fs.mkdir(attacker);
    await fs.symlink(original, alias, "dir");
    await fs.writeFile(path.join(vaultRoot, "Hello.md"), "pinned body\n");
    const requestedFile = path.join(alias, "cache.json");
    const attackerFile = path.join(attacker, "cache.json");
    await fs.writeFile(attackerFile, "ATTACKER_SENTINEL");

    const vault = trackedVault(vaultRoot, { persistentCache: true, cacheFile: requestedFile });
    await vault.ensureExists();
    await vault.readNote(path.join(vaultRoot, "Hello.md"));
    await fs.unlink(alias);
    await fs.symlink(attacker, alias, "dir");

    await vault.saveDiskCache();
    expect(await fs.readFile(path.join(original, "cache.json"), "utf8")).toContain("pinned body");
    expect(await fs.readFile(attackerFile, "utf8")).toBe("ATTACKER_SENTINEL");
    await expect(vault.clearDiskCache()).resolves.toBe(true);
    await expect(fs.lstat(path.join(original, "cache.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(attackerFile, "utf8")).toBe("ATTACKER_SENTINEL");
  });

  it("retires every same-digest missing case alias before clear", async () => {
    const vaultRoot = await makeRoot("enquire-vault-case-");
    const cacheParent = await makeRoot("enquire-vault-cache-");
    await fs.writeFile(path.join(vaultRoot, "Hello.md"), "case body\n");
    const upper = path.join(cacheParent, "Missing-Case.json");
    const lower = path.join(cacheParent, "missing-case.json");
    const vault = trackedVault(vaultRoot, { persistentCache: true, cacheFile: upper });
    await vault.ensureExists();
    vault.cacheFile = lower;
    await expect(vault.loadDiskCache()).resolves.toBe(0);
    await expect(vault.clearDiskCache()).resolves.toBe(false);
    const internals = vault as unknown as { persistenceTargets: Map<string, unknown> };
    expect(internals.persistenceTargets.size).toBe(0);
  });

  it("retries the exact lifetime after a close release failure", async () => {
    const vaultRoot = await makeRoot("enquire-vault-close-");
    const cacheParent = await makeRoot("enquire-vault-cache-");
    const cacheFile = path.join(cacheParent, "cache.json");
    await fs.writeFile(path.join(vaultRoot, "Hello.md"), "close body\n");
    const vault = trackedVault(vaultRoot, { persistentCache: true, cacheFile });
    await vault.ensureExists();
    const internals = vault as unknown as {
      persistenceTargets: Map<string, { lifetime: { release(): Promise<void> } }>;
    };
    const target = internals.persistenceTargets.get(cacheFile);
    if (!target) throw new Error("Vault persistence lifetime fixture is missing");
    const realRelease = target.lifetime.release.bind(target.lifetime);
    const denied = new Error("simulated lifetime release failure");
    const releaseSpy = vi
      .spyOn(target.lifetime, "release")
      .mockRejectedValueOnce(denied)
      .mockImplementation(realRelease);
    try {
      await expect(vault.closePersistence()).rejects.toThrow(/lifetime release was incomplete/i);
      await expect(vault.saveDiskCache()).rejects.toThrow(/closing or closed/i);
      await expect(vault.closePersistence()).resolves.toBeUndefined();
      expect(releaseSpy).toHaveBeenCalledTimes(2);
    } finally {
      releaseSpy.mockRestore();
    }
  });
});
