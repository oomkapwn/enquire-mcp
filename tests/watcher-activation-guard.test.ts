import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmbedDb, hnswPersistBase } from "../src/embed-db.js";
import {
  armWatcherActivationGuard,
  assertWatcherActivationGuardClear,
  clearWatcherActivationGuard,
  preflightWatcherActivationGuardRecovery,
  releaseWatcherActivationGuard,
  type WatcherActivationGuard,
  watcherActivationGuardPath
} from "../src/watcher-activation-guard.js";

describe("watcher activation guard", () => {
  let dir: string;
  let embedDbFile: string;
  let guardPath: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-watcher-guard-"));
    embedDbFile = path.join(dir, "exact.embed.db");
    guardPath = watcherActivationGuardPath(embedDbFile);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("derives a distinct sidecar from each exact embedding-database filename", () => {
    expect(guardPath).toBe(`${embedDbFile}.watcher-activation.guard`);
    expect(watcherActivationGuardPath(path.join(dir, "Exact.embed.db"))).not.toBe(guardPath);
  });

  it("assert-clear resolves for an absent path but any existing object blocks", async () => {
    await expect(assertWatcherActivationGuardClear(embedDbFile)).resolves.toBeUndefined();

    await fs.mkdir(guardPath);
    await expect(assertWatcherActivationGuardClear(embedDbFile)).rejects.toThrow(/guard exists/i);

    await fs.rmdir(guardPath);
    const target = path.join(dir, "symlink-target");
    await fs.mkdir(target);
    await fs.symlink(target, guardPath, process.platform === "win32" ? "junction" : "dir");
    await expect(assertWatcherActivationGuardClear(embedDbFile)).rejects.toThrow(/guard exists/i);
  });

  it("arms a private directory with one private token child and no vault content", async () => {
    const privatePathSentinel = "PRIVATE_VAULT_PATH_MUST_NOT_PERSIST";
    embedDbFile = path.join(dir, privatePathSentinel, "exact.embed.db");
    await fs.mkdir(path.dirname(embedDbFile), { recursive: true });
    guardPath = watcherActivationGuardPath(embedDbFile);

    const guard = await armWatcherActivationGuard(embedDbFile);
    const entries = await fs.readdir(guardPath);
    const childPath = path.join(guardPath, `${guard.token}.active`);
    const raw = await fs.readFile(childPath, "utf8");
    const payload = JSON.parse(raw) as Record<string, unknown>;
    const directoryStat = await fs.stat(guardPath);
    const childStat = await fs.stat(childPath);

    expect(entries).toEqual([`${guard.token}.active`]);
    expect(Object.keys(payload).sort()).toEqual(["token", "version"]);
    expect(payload.version).toBe(1);
    expect(payload.token).toBe(guard.token);
    expect(guard.token).toMatch(/^[0-9a-f]{64}$/);
    expect(`${entries.join("")}${raw}`).not.toContain(privatePathSentinel);
    if (process.platform !== "win32") {
      expect(directoryStat.mode & 0o777).toBe(0o700);
      expect(childStat.mode & 0o777).toBe(0o600);
    }
  });

  it("exclusive arm refuses to replace an existing object and preserves its bytes", async () => {
    const sentinel = "existing-object-must-survive";
    await fs.writeFile(guardPath, sentinel);

    await expect(armWatcherActivationGuard(embedDbFile)).rejects.toThrow(/already exists/i);
    await expect(fs.readFile(guardPath, "utf8")).resolves.toBe(sentinel);
  });

  it("forces private child mode and keeps final parent-fsync failure fail-closed", async () => {
    const probe = await fs.open(path.join(dir, "prototype-probe"), "w");
    const fileHandlePrototype = Object.getPrototypeOf(probe) as {
      chmod: (mode: number) => Promise<void>;
      sync: () => Promise<void>;
    };
    await probe.close();
    const chmodSpy = vi.spyOn(fileHandlePrototype, "chmod");
    const syncSpy = vi.spyOn(fileHandlePrototype, "sync");

    try {
      const guard = await armWatcherActivationGuard(embedDbFile);
      expect(chmodSpy).toHaveBeenCalledTimes(1);
      expect(chmodSpy).toHaveBeenCalledWith(0o600);
      expect(syncSpy).toHaveBeenCalledTimes(process.platform === "win32" ? 1 : 3);
      await releaseWatcherActivationGuard(guard);
    } finally {
      chmodSpy.mockRestore();
      syncSpy.mockRestore();
    }

    if (process.platform !== "win32") {
      const released = await armWatcherActivationGuard(embedDbFile);
      let releaseSyncCalls = 0;
      const absentAfterFailureSpy = vi.spyOn(fileHandlePrototype, "sync").mockImplementation(async () => {
        releaseSyncCalls += 1;
        if (releaseSyncCalls === 2) throw new Error("synthetic final parent sync failure");
      });
      try {
        // The guard was already removed. A crash can at worst resurrect it and
        // block the next start, so this completed generation remains successful.
        await expect(releaseWatcherActivationGuard(released)).resolves.toBeUndefined();
        expect(releaseSyncCalls).toBe(2);
        await expect(assertWatcherActivationGuardClear(embedDbFile)).resolves.toBeUndefined();
      } finally {
        absentAfterFailureSpy.mockRestore();
      }

      const replaced = await armWatcherActivationGuard(embedDbFile);
      releaseSyncCalls = 0;
      const presentAfterFailureSpy = vi.spyOn(fileHandlePrototype, "sync").mockImplementation(async () => {
        releaseSyncCalls += 1;
        if (releaseSyncCalls === 2) {
          await fs.mkdir(guardPath);
          throw new Error("synthetic final parent sync failure with replacement");
        }
      });
      try {
        // NEGATIVE control: a path that exists after the same failure is not
        // mistaken for a completed release.
        await expect(releaseWatcherActivationGuard(replaced)).rejects.toThrow(/still exists/i);
        expect((await fs.lstat(guardPath)).isDirectory()).toBe(true);
      } finally {
        presentAfterFailureSpy.mockRestore();
        await fs.rmdir(guardPath);
      }
    }
  });

  it("releases an exactly owned directory and makes assert-clear pass again", async () => {
    const guard = await armWatcherActivationGuard(embedDbFile);
    await expect(assertWatcherActivationGuardClear(embedDbFile)).rejects.toThrow(/guard exists/i);

    await expect(releaseWatcherActivationGuard(guard)).resolves.toBeUndefined();
    await expect(assertWatcherActivationGuardClear(embedDbFile)).resolves.toBeUndefined();
  });

  it("rejects a foreign payload token without deleting the guard directory", async () => {
    const guard = await armWatcherActivationGuard(embedDbFile);
    const childPath = path.join(guardPath, `${guard.token}.active`);
    const differentFirstNibble = guard.token.startsWith("0") ? "1" : "0";
    const foreignToken = `${differentFirstNibble}${guard.token.slice(1)}`;
    await fs.writeFile(childPath, `${JSON.stringify({ version: 1, token: foreignToken })}\n`);

    await expect(releaseWatcherActivationGuard(guard)).rejects.toThrow(/token mismatch/i);
    await expect(fs.lstat(childPath)).resolves.toBeDefined();
    await expect(clearWatcherActivationGuard(embedDbFile)).resolves.toBe(true);

    const exactGuard = await armWatcherActivationGuard(embedDbFile);
    const exactChild = path.join(guardPath, `${exactGuard.token}.active`);
    const foreignEntry = path.join(guardPath, "foreign-entry");
    await fs.writeFile(foreignEntry, "must survive");
    await expect(releaseWatcherActivationGuard(exactGuard)).rejects.toThrow(
      /unexpected guard directory entries/i
    );
    await expect(fs.lstat(exactChild)).resolves.toBeDefined();
    await expect(fs.readFile(foreignEntry, "utf8")).resolves.toBe("must survive");
    await fs.unlink(foreignEntry);
    await expect(releaseWatcherActivationGuard(exactGuard)).resolves.toBeUndefined();
  });

  it("rejects malformed or extended child payloads without deleting them", async () => {
    const token = "a".repeat(64);
    const guard: WatcherActivationGuard = { embedDbFile, token };
    const malformedPayloads = [
      "not json",
      JSON.stringify({ version: 1, token: "short" }),
      JSON.stringify({ version: 2, token }),
      JSON.stringify({ version: 1, token, vaultPath: "/private/vault" })
    ];

    for (const raw of malformedPayloads) {
      await fs.mkdir(guardPath, { mode: 0o700 });
      const childPath = path.join(guardPath, `${token}.active`);
      await fs.writeFile(childPath, raw, { mode: 0o600 });
      await expect(releaseWatcherActivationGuard(guard)).rejects.toThrow(/malformed guard payload/i);
      await expect(fs.readFile(childPath, "utf8")).resolves.toBe(raw);
      await expect(clearWatcherActivationGuard(embedDbFile)).resolves.toBe(true);
    }

    await fs.mkdir(guardPath, { mode: 0o700 });
    const childPath = path.join(guardPath, `${token}.active`);
    const symlinkTarget = path.join(dir, "foreign-active-child-target");
    if (process.platform === "win32") {
      await fs.mkdir(symlinkTarget);
      await fs.writeFile(path.join(symlinkTarget, "sentinel.txt"), "must survive");
      await fs.symlink(symlinkTarget, childPath, "junction");
    } else {
      await fs.writeFile(
        symlinkTarget,
        `${JSON.stringify({ version: 1, token })}\n`
      );
      await fs.symlink(symlinkTarget, childPath, "file");
    }
    await expect(releaseWatcherActivationGuard(guard)).rejects.toThrow(
      /unexpected guard directory entries/i
    );
    if (process.platform === "win32") {
      await expect(fs.readFile(path.join(symlinkTarget, "sentinel.txt"), "utf8")).resolves.toBe("must survive");
    } else {
      await expect(fs.readFile(symlinkTarget, "utf8")).resolves.toContain(token);
    }
    expect((await fs.lstat(childPath)).isSymbolicLink()).toBe(true);
    await fs.unlink(childPath);
    await fs.rmdir(guardPath);
    await fs.rm(symlinkTarget, { recursive: true });
  });

  it("rejects a symlink guard without reading or deleting its target", async () => {
    const target = path.join(dir, "outside-target");
    const sentinel = "symlink-target-must-survive";
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, "sentinel.txt"), sentinel);
    await fs.symlink(target, guardPath, process.platform === "win32" ? "junction" : "dir");
    const guard: WatcherActivationGuard = { embedDbFile, token: "a".repeat(64) };

    await expect(releaseWatcherActivationGuard(guard)).rejects.toThrow(/non-symlink directory/i);
    await expect(fs.readFile(path.join(target, "sentinel.txt"), "utf8")).resolves.toBe(sentinel);
    expect((await fs.lstat(guardPath)).isSymbolicLink()).toBe(true);
  });

  it("rejects a missing guard instead of treating release as an idempotent success", async () => {
    const guard: WatcherActivationGuard = { embedDbFile, token: "a".repeat(64) };

    await expect(releaseWatcherActivationGuard(guard)).rejects.toThrow(/missing or inaccessible/i);
  });

  it("generates a fresh token and child name for every armed generation", async () => {
    const first = await armWatcherActivationGuard(embedDbFile);
    await releaseWatcherActivationGuard(first);
    const second = await armWatcherActivationGuard(embedDbFile);

    expect(second.token).not.toBe(first.token);
    await expect(fs.readdir(guardPath)).resolves.toEqual([`${second.token}.active`]);
    await releaseWatcherActivationGuard(second);
  });

  it("strict recovery accepts only its narrow partial/owned shape and clear-embeddings owns it", async () => {
    const db = new EmbedDb({
      file: embedDbFile,
      vaultRoot: dir,
      modelAlias: "guard-test",
      dim: 4
    });
    await expect(preflightWatcherActivationGuardRecovery(embedDbFile)).resolves.toBe(false);
    await fs.mkdir(guardPath, { mode: 0o700 });
    await expect(preflightWatcherActivationGuardRecovery(embedDbFile)).resolves.toBe(true);
    expect((await fs.lstat(guardPath)).isDirectory()).toBe(true);
    await expect(clearWatcherActivationGuard(embedDbFile)).resolves.toBe(true);

    await fs.mkdir(guardPath, { mode: 0o700 });
    const foreignPath = path.join(guardPath, "foreign-content.txt");
    await fs.writeFile(foreignPath, "must survive");
    await expect(clearWatcherActivationGuard(embedDbFile)).rejects.toThrow(/unexpected directory entry/i);
    await expect(fs.readFile(foreignPath, "utf8")).resolves.toBe("must survive");
    await fs.unlink(foreignPath);
    await fs.rmdir(guardPath);

    const oversizedToken = "b".repeat(64);
    await fs.mkdir(guardPath, { mode: 0o700 });
    const oversizedChild = path.join(guardPath, `${oversizedToken}.active`);
    await fs.writeFile(oversizedChild, "x".repeat(1025), { mode: 0o600 });
    await expect(clearWatcherActivationGuard(embedDbFile)).rejects.toThrow(/unsafe active child/i);
    await expect(fs.stat(oversizedChild)).resolves.toMatchObject({ size: 1025 });
    await fs.unlink(oversizedChild);
    await fs.rmdir(guardPath);

    // Class-level NEGATIVE control: unsafe/foreign guard shapes are rejected by
    // clearOnDisk's read-only preflight before any DB/WAL/HNSW artifact is
    // removed. Each shape remains untouched for manual ownership inspection.
    const hnswBase = hnswPersistBase(embedDbFile);
    const artifactPaths = [
      embedDbFile,
      `${embedDbFile}-wal`,
      `${embedDbFile}-shm`,
      `${hnswBase}.bin`,
      `${hnswBase}.meta.json`
    ];
    const artifactSentinel = "derived-artifact-must-survive-unsafe-guard";
    for (const artifactPath of artifactPaths) {
      await fs.writeFile(artifactPath, artifactSentinel);
    }
    const expectArtifactsPreserved = async (): Promise<void> => {
      for (const artifactPath of artifactPaths) {
        await expect(fs.readFile(artifactPath, "utf8")).resolves.toBe(artifactSentinel);
      }
    };

    await fs.writeFile(guardPath, "foreign guard object");
    await expect(db.clearOnDisk()).rejects.toThrow(/expected a non-symlink directory/i);
    await expectArtifactsPreserved();
    await expect(fs.readFile(guardPath, "utf8")).resolves.toBe("foreign guard object");
    await fs.unlink(guardPath);

    await fs.mkdir(guardPath, { mode: 0o700 });
    const unexpectedEntry = path.join(guardPath, "foreign-content.txt");
    await fs.writeFile(unexpectedEntry, "must survive");
    await expect(db.clearOnDisk()).rejects.toThrow(/unexpected directory entry/i);
    await expectArtifactsPreserved();
    await expect(fs.readFile(unexpectedEntry, "utf8")).resolves.toBe("must survive");
    await fs.unlink(unexpectedEntry);
    await fs.rmdir(guardPath);

    const foreignTarget = path.join(dir, "foreign-guard-target");
    await fs.mkdir(foreignTarget);
    await fs.writeFile(path.join(foreignTarget, "sentinel.txt"), "must survive");
    await fs.symlink(foreignTarget, guardPath, process.platform === "win32" ? "junction" : "dir");
    await expect(db.clearOnDisk()).rejects.toThrow(/expected a non-symlink directory/i);
    await expectArtifactsPreserved();
    await expect(fs.readFile(path.join(foreignTarget, "sentinel.txt"), "utf8")).resolves.toBe("must survive");
    await fs.unlink(guardPath);
    await fs.rm(foreignTarget, { recursive: true });
    for (const artifactPath of artifactPaths) {
      await fs.unlink(artifactPath);
    }

    await armWatcherActivationGuard(embedDbFile);
    await expect(db.clearOnDisk()).resolves.toBe(true);
    await expect(assertWatcherActivationGuardClear(embedDbFile)).resolves.toBeUndefined();

    // NEGATIVE control: derived artifacts are removed before the guard. A
    // deterministic type error at the first artifact must reject and retain
    // the interlock, so the next startup remains quarantined.
    await armWatcherActivationGuard(embedDbFile);
    await fs.mkdir(embedDbFile);
    await expect(db.clearOnDisk()).rejects.toThrow(/Unable to remove embedding-index artifact/i);
    await expect(assertWatcherActivationGuardClear(embedDbFile)).rejects.toThrow(/guard exists/i);
    expect((await fs.lstat(embedDbFile)).isDirectory()).toBe(true);
    expect((await fs.lstat(guardPath)).isDirectory()).toBe(true);
    await fs.rmdir(embedDbFile);
    await expect(clearWatcherActivationGuard(embedDbFile)).resolves.toBe(true);
  });
});
