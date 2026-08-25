import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { discoverFtsIndexConfig, FtsIndex } from "../src/fts5.js";
import { foldName } from "../src/name-fold.js";
import {
  acquirePersistenceNamespaceEraser,
  inspectPersistenceNamespaceLeases
} from "../src/persistence-coordination.js";
import {
  inspectPersistenceLeases,
  PersistenceLeaseConflictError,
  recoverPersistenceLease
} from "../src/persistence-lease.js";
import { replaceExactly } from "./helpers/exact-source-mutation.js";

const childFixture = path.resolve(__dirname, "fixtures", "fts-persistence-child.mjs");
const roots: string[] = [];
const children = new Set<ChildProcessWithoutNullStreams>();
let canRunFts5 = true;

interface ChildMessage {
  readonly event: "ready" | "closed" | "mutated" | "mutation-refused";
  readonly message?: string;
}

beforeAll(async () => {
  try {
    await import("better-sqlite3");
  } catch {
    canRunFts5 = false;
  }
});

function waitForMessage(child: ChildProcessWithoutNullStreams, event: ChildMessage["event"]): Promise<ChildMessage> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`FTS child timed out waiting for ${event}: ${stderr}`));
    }, 10_000);
    const onStdout = (chunk: Buffer): void => {
      stdout += chunk.toString("utf8");
      while (true) {
        const newline = stdout.indexOf("\n");
        if (newline < 0) return;
        const line = stdout.slice(0, newline);
        stdout = stdout.slice(newline + 1);
        try {
          const message = JSON.parse(line) as ChildMessage;
          if (message.event === event) {
            cleanup();
            resolve(message);
            return;
          }
        } catch {
          // Ignore non-protocol stdout; stderr is included on failure.
        }
      }
    };
    const onStderr = (chunk: Buffer): void => {
      stderr += chunk.toString("utf8");
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      reject(new Error(`FTS child exited before ${event}: code=${code}, signal=${signal}, stderr=${stderr}`));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("exit", onExit);
    };
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("exit", onExit);
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<{
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function makeRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function spawnHolder(mode: "hold" | "late", file: string): Promise<ChildProcessWithoutNullStreams> {
  const child = spawn(process.execPath, [childFixture, mode, file, "/vault/fts-coordination"], {
    stdio: ["pipe", "pipe", "pipe"]
  });
  children.add(child);
  await waitForMessage(child, "ready");
  return child;
}

function leaseTargetFor(file: string): string {
  const absolute = path.resolve(file);
  const digest = createHash("sha256")
    .update(`fts5-v1\0${foldName(path.basename(absolute))}`, "utf8")
    .digest("hex");
  return path.join(path.dirname(absolute), `.enquire-mcp-fts5-${digest}`);
}

async function closeChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  const closed = waitForMessage(child, "closed");
  child.stdin.write("close\n");
  await closed;
  const exit = await waitForExit(child);
  expect(exit).toEqual({ code: 0, signal: null });
  children.delete(child);
}

afterEach(async () => {
  for (const child of children) child.kill("SIGKILL");
  await Promise.all([...children].map(waitForExit));
  children.clear();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("FtsIndex cross-process persistence coordination", () => {
  it("NEGATIVE: pins every CLI FTS owner to awaited lifetime release with a live mutation control", async () => {
    const cliSource = await fs.readFile(path.resolve("src/cli.ts"), "utf8");
    const lifecycleProblems = (source: string): string[] => {
      const awaited = source.match(/\bawait (?:ftsIndex|idx)\.closeAndRelease\(\);/gu) ?? [];
      const problems: string[] = [];
      if (awaited.length !== 5) problems.push(`expected 5 awaited CLI FTS releases, found ${awaited.length}`);
      if (/\b(?:ftsIndex|idx)\.close\(\)/u.test(source)) problems.push("legacy synchronous CLI FTS close remains");
      return problems;
    };
    expect(lifecycleProblems(cliSource)).toEqual([]);
    expect(
      lifecycleProblems(
        replaceExactly(cliSource, "await ftsIndex.closeAndRelease();", "void ftsIndex.closeAndRelease();", 3)
      )
    ).toContain("expected 5 awaited CLI FTS releases, found 4");
  });

  it("awaits exact lifetime rollback when an admitted open fails", async () => {
    if (!canRunFts5) return;
    const root = await makeRoot("enquire-fts-open-rollback-");
    const file = path.join(root, "state.fts5.db");
    await fs.writeFile(file, "not a sqlite database ".repeat(32));
    const index = new FtsIndex({ file, vaultRoot: "/vault/fts-coordination" });
    await expect(index.open()).rejects.toThrow();

    const family = await inspectPersistenceLeases({ targetPath: leaseTargetFor(file), familyKey: "fts5-v1" });
    const namespace = await inspectPersistenceNamespaceLeases(root);
    expect(family.leases).toEqual([]);
    expect(namespace.leases).toEqual([]);
  });

  it("forces a failed open rollback through the same lifetime before retrying open", async () => {
    if (!canRunFts5) return;
    const root = await makeRoot("enquire-fts-open-rollback-retry-");
    const file = path.join(root, "state.fts5.db");
    class RollbackFailingFtsIndex extends FtsIndex {
      admissionAttempts = 0;
      releaseAttempts = 0;

      protected override inspectAdmission(): never {
        this.admissionAttempts += 1;
        if (this.admissionAttempts === 1) {
          const internals = this as unknown as {
            lifetime: { release(): Promise<void> };
          };
          const originalRelease = internals.lifetime.release.bind(internals.lifetime);
          internals.lifetime.release = async () => {
            this.releaseAttempts += 1;
            if (this.releaseAttempts === 1) throw new Error("injected open rollback release failure");
            await originalRelease();
          };
          throw new Error("injected first admission failure");
        }
        throw new Error("injected second admission failure");
      }
    }

    const index = new RollbackFailingFtsIndex({ file, vaultRoot: "/vault/fts-coordination" });
    await expect(index.open()).rejects.toThrow("FTS open failed and lifetime rollback was incomplete");
    expect(index.releaseAttempts).toBe(1);
    await expect(index.open()).rejects.toThrow("injected second admission failure");
    expect(index.releaseAttempts).toBe(2);

    const family = await inspectPersistenceLeases({ targetPath: leaseTargetFor(file), familyKey: "fts5-v1" });
    const namespace = await inspectPersistenceNamespaceLeases(root);
    expect(family.leases).toEqual([]);
    expect(namespace.leases).toEqual([]);
  });

  it("retains a failed best-effort close and retries the exact lifetime on awaited close", async () => {
    if (!canRunFts5) return;
    const root = await makeRoot("enquire-fts-close-retry-");
    const file = path.join(root, "state.fts5.db");
    const index = new FtsIndex({ file, vaultRoot: "/vault/fts-coordination" });
    await index.open();
    index.reindexFile("durable.md", 1, "durable-before-close-failure");
    const internals = index as unknown as {
      closeAttempt?: Promise<void>;
      lifetime: { release(): Promise<void> };
    };
    const originalRelease = internals.lifetime.release.bind(internals.lifetime);
    let attempts = 0;
    internals.lifetime.release = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("injected FTS lifetime release failure");
      await originalRelease();
    };

    index.close();
    await expect(internals.closeAttempt).rejects.toThrow("injected FTS lifetime release failure");
    expect(() => index.reindexFile("late.md", 2, "must-not-write")).toThrow(
      "FtsIndex.open() must be called before use"
    );
    await expect(index.closeAndRelease()).resolves.toBeUndefined();
    expect(attempts).toBe(2);

    const family = await inspectPersistenceLeases({ targetPath: leaseTargetFor(file), familyKey: "fts5-v1" });
    const namespace = await inspectPersistenceNamespaceLeases(root);
    expect(family.leases).toEqual([]);
    expect(namespace.leases).toEqual([]);
  });

  it("releases the exact lifetime even when native SQLite close throws", async () => {
    if (!canRunFts5) return;
    const root = await makeRoot("enquire-fts-native-close-failure-");
    const file = path.join(root, "state.fts5.db");
    const index = new FtsIndex({ file, vaultRoot: "/vault/fts-coordination" });
    await index.open();
    index.reindexFile("durable.md", 1, "durable-before-native-close-error");

    const { default: Database } = await import("better-sqlite3");
    const prototype = Database.prototype as unknown as { close(): void };
    const originalClose = prototype.close;
    prototype.close = function (this: unknown) {
      originalClose.call(this);
      throw new Error("injected native close failure");
    };
    try {
      await expect(index.closeAndRelease()).rejects.toThrow("injected native close failure");
    } finally {
      prototype.close = originalClose;
    }

    const family = await inspectPersistenceLeases({ targetPath: leaseTargetFor(file), familyKey: "fts5-v1" });
    const namespace = await inspectPersistenceNamespaceLeases(root);
    expect(family.leases).toEqual([]);
    expect(namespace.leases).toEqual([]);
    expect(() => index.search("durable-before-native-close-error")).toThrow(
      "FtsIndex.open() must be called before use"
    );
  });

  it("snapshots reopen authority before close drain and single-flights concurrent continuations", async () => {
    if (!canRunFts5) return;
    const root = await makeRoot("enquire-fts-reopen-single-flight-");
    const file = path.join(root, "state.fts5.db");
    const vaultRoot = "/vault/fts-coordination";
    const index = new FtsIndex({ file, vaultRoot });
    await index.open();
    index.reindexFile("durable.md", 1, "durable-reopen-marker");
    const discovery = await discoverFtsIndexConfig(file, vaultRoot);
    expect(discovery.kind).toBe("owned");

    let releaseStartedResolve: (() => void) | undefined;
    const releaseStarted = new Promise<void>((resolve) => {
      releaseStartedResolve = resolve;
    });
    let allowReleaseResolve: (() => void) | undefined;
    const allowRelease = new Promise<void>((resolve) => {
      allowReleaseResolve = resolve;
    });
    const internals = index as unknown as {
      closeAttempt?: Promise<void>;
      lifetime: { release(): Promise<void> };
      openOnce(...args: unknown[]): Promise<void>;
    };
    const originalRelease = internals.lifetime.release.bind(internals.lifetime);
    internals.lifetime.release = async () => {
      releaseStartedResolve?.();
      await allowRelease;
      await originalRelease();
    };

    index.close();
    await releaseStarted;
    const originalOpenOnce = internals.openOnce.bind(index);
    let openOnceCalls = 0;
    internals.openOnce = async (...args: unknown[]) => {
      openOnceCalls += 1;
      await originalOpenOnce(...args);
    };

    const firstReopen = index.open(discovery);
    const secondReopen = index.open(discovery);
    if (discovery.kind === "owned") {
      // The caller retains this object. Both reopen calls must already have
      // copied its authority even though the previous lifetime is still
      // draining; the mutation is a causal control for clone-after-await.
      (discovery.meta as { tokenize_mode: "unicode61" | "trigram" }).tokenize_mode = "trigram";
    }
    allowReleaseResolve?.();
    await Promise.all([firstReopen, secondReopen]);

    expect(openOnceCalls).toBe(1);
    expect(index.search("durable-reopen-marker")).toHaveLength(1);
    await index.closeAndRelease();
    const family = await inspectPersistenceLeases({ targetPath: leaseTargetFor(file), familyKey: "fts5-v1" });
    const namespace = await inspectPersistenceNamespaceLeases(root);
    expect(family.leases).toEqual([]);
    expect(namespace.leases).toEqual([]);
  });

  it("does not join a doomed open after close has requested a fresh generation", async () => {
    if (!canRunFts5) return;
    const root = await makeRoot("enquire-fts-close-during-open-");
    const file = path.join(root, "state.fts5.db");
    const index = new FtsIndex({ file, vaultRoot: "/vault/fts-coordination" });
    const internals = index as unknown as {
      openOnce(...args: unknown[]): Promise<void>;
    };
    const originalOpenOnce = internals.openOnce.bind(index);
    let firstAttemptStartedResolve: (() => void) | undefined;
    const firstAttemptStarted = new Promise<void>((resolve) => {
      firstAttemptStartedResolve = resolve;
    });
    let allowFirstAttemptResolve: (() => void) | undefined;
    const allowFirstAttempt = new Promise<void>((resolve) => {
      allowFirstAttemptResolve = resolve;
    });
    let openOnceCalls = 0;
    internals.openOnce = async (...args: unknown[]) => {
      openOnceCalls += 1;
      if (openOnceCalls === 1) {
        firstAttemptStartedResolve?.();
        await allowFirstAttempt;
      }
      await originalOpenOnce(...args);
    };

    const doomedOpen = index.open();
    await firstAttemptStarted;
    index.close();
    const freshOpen = index.open();
    allowFirstAttemptResolve?.();
    await Promise.all([doomedOpen, freshOpen]);

    // A close-unaware initial join returns the first attempt here, so no new
    // generation is installed and the asynchronously completed close leaves
    // this instance unusable. The fresh caller must instead drain then reopen.
    expect(openOnceCalls).toBe(2);
    index.reindexFile("fresh.md", 2, "fresh-after-close-during-open");
    expect(index.search("fresh-after-close-during-open")).toHaveLength(1);
    await index.closeAndRelease();
  });

  it("does not let an older reopen continuation erase a later close request", async () => {
    if (!canRunFts5) return;
    const root = await makeRoot("enquire-fts-reopen-superseded-");
    const file = path.join(root, "state.fts5.db");
    const index = new FtsIndex({ file, vaultRoot: "/vault/fts-coordination" });
    await index.open();
    await index.closeAndRelease();

    const internals = index as unknown as {
      finishCloseAndRelease(): Promise<void>;
      openOnce(...args: unknown[]): Promise<void>;
    };
    const originalFinish = internals.finishCloseAndRelease.bind(index);
    const originalOpenOnce = internals.openOnce.bind(index);
    let drainedResolve: (() => void) | undefined;
    const drained = new Promise<void>((resolve) => {
      drainedResolve = resolve;
    });
    let allowContinuationResolve: (() => void) | undefined;
    const allowContinuation = new Promise<void>((resolve) => {
      allowContinuationResolve = resolve;
    });
    let openOnceCalls = 0;
    internals.openOnce = async (...args: unknown[]) => {
      openOnceCalls += 1;
      await originalOpenOnce(...args);
    };
    internals.finishCloseAndRelease = async () => {
      await originalFinish();
      drainedResolve?.();
      await allowContinuation;
    };

    const staleReopen = index.open();
    await drained;
    index.close();
    allowContinuationResolve?.();
    await expect(staleReopen).rejects.toThrow("FTS index reopen was superseded by a later close request");
    expect(openOnceCalls).toBe(0);
    expect(() => index.search("anything")).toThrow("FtsIndex.open() must be called before use");
    await index.closeAndRelease();
  });

  it("keeps live bytes intact while a holder blocks both family clear and parent-wide prune", async () => {
    if (!canRunFts5) return;
    const root = await makeRoot("enquire-fts-live-holder-");
    const file = path.join(root, "state.fts5.db");
    const child = await spawnHolder("hold", file);
    const before = await fs.readFile(file);

    const clearer = new FtsIndex({ file, vaultRoot: "/vault/fts-coordination" });
    await expect(clearer.clearOnDisk()).rejects.toBeInstanceOf(PersistenceLeaseConflictError);
    await expect(acquirePersistenceNamespaceEraser({ parentPath: root })).rejects.toBeInstanceOf(
      PersistenceLeaseConflictError
    );
    expect(await fs.readFile(file)).toEqual(before);

    await closeChild(child);
    await expect(clearer.clearOnDisk()).resolves.toBe(true);
    await expect(fs.lstat(file)).rejects.toMatchObject({ code: "ENOENT" });
    const namespace = await inspectPersistenceNamespaceLeases(root);
    expect({ gate: namespace.gate, leases: namespace.leases, candidates: namespace.candidates }).toEqual({
      gate: null,
      leases: [],
      candidates: []
    });
  });

  it("does not let a closed old process mutate or resurrect a successfully cleared generation", async () => {
    if (!canRunFts5) return;
    const root = await makeRoot("enquire-fts-late-mutation-");
    const file = path.join(root, "state.fts5.db");
    const child = await spawnHolder("late", file);

    const closed = waitForMessage(child, "closed");
    child.stdin.write("close\n");
    await closed;
    const clearer = new FtsIndex({ file, vaultRoot: "/vault/fts-coordination" });
    await expect(clearer.clearOnDisk()).resolves.toBe(true);

    const refused = waitForMessage(child, "mutation-refused");
    child.stdin.write("mutate\n");
    const message = await refused;
    expect(message.message).toBe("FtsIndex.open() must be called before use");
    const exit = await waitForExit(child);
    expect(exit).toEqual({ code: 0, signal: null });
    children.delete(child);
    await expect(fs.lstat(file)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never TTL-steals a killed holder and clears only after explicit exact recovery", async () => {
    if (!canRunFts5) return;
    const root = await makeRoot("enquire-fts-orphan-");
    const file = path.join(root, "state.fts5.db");
    const child = await spawnHolder("hold", file);
    const before = await fs.readFile(file);
    child.kill("SIGKILL");
    const killed = await waitForExit(child);
    expect(killed.signal).toBe("SIGKILL");
    children.delete(child);

    const targetPath = leaseTargetFor(file);
    const family = await inspectPersistenceLeases({ targetPath, familyKey: "fts5-v1" });
    const namespace = await inspectPersistenceNamespaceLeases(root);
    expect(family.leases).toHaveLength(1);
    expect(namespace.leases).toHaveLength(1);
    const old = new Date("2000-01-01T00:00:00.000Z");
    for (const marker of [...family.leases, ...namespace.leases]) {
      const scope = family.leases.includes(marker) ? family.scope : namespace.scope;
      await fs.utimes(path.join(scope.directory, marker.id), old, old);
    }

    const clearer = new FtsIndex({ file, vaultRoot: "/vault/fts-coordination" });
    await expect(clearer.clearOnDisk()).rejects.toBeInstanceOf(PersistenceLeaseConflictError);
    await expect(clearer.clearOnDisk()).rejects.toBeInstanceOf(PersistenceLeaseConflictError);
    expect(await fs.readFile(file)).toEqual(before);

    let quiescenceProofs = 0;
    const proveQuiescent = async (): Promise<boolean> => {
      quiescenceProofs += 1;
      return true;
    };
    const familyMarker = family.leases[0];
    const namespaceMarker = namespace.leases[0];
    if (!familyMarker || !namespaceMarker) throw new Error("expected exact FTS crash markers");
    await recoverPersistenceLease({
      targetPath,
      familyKey: "fts5-v1",
      markerId: familyMarker.id,
      assertQuiescent: proveQuiescent
    });
    await recoverPersistenceLease({
      targetPath: path.join(namespace.scope.canonicalParent, namespace.scope.targetName),
      familyKey: namespace.scope.familyKey,
      markerId: namespaceMarker.id,
      assertQuiescent: proveQuiescent
    });
    expect(quiescenceProofs).toBe(2);

    await expect(clearer.clearOnDisk()).resolves.toBe(true);
    await expect(fs.lstat(file)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps erasure on the pinned canonical parent after a lexical alias is retargeted", async (context) => {
    if (!canRunFts5) return;
    const root = await makeRoot("enquire-fts-parent-alias-");
    const firstParent = path.join(root, "first");
    const secondParent = path.join(root, "second");
    const aliasParent = path.join(root, "alias");
    await Promise.all([fs.mkdir(firstParent), fs.mkdir(secondParent)]);
    try {
      await fs.symlink(firstParent, aliasParent, "dir");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES" || code === "ENOSYS") {
        return context.skip(`filesystem cannot create a directory symlink (${code})`);
      }
      throw error;
    }

    const requested = path.join(aliasParent, "state.fts5.db");
    const firstFile = path.join(firstParent, "state.fts5.db");
    const secondFile = path.join(secondParent, "state.fts5.db");
    const index = new FtsIndex({ file: requested, vaultRoot: "/vault/fts-coordination" });
    await index.open();
    index.reindexFile("first.md", 1, "first-parent-generation");
    await index.closeAndRelease();
    await fs.unlink(aliasParent);
    await fs.symlink(secondParent, aliasParent, "dir");
    const secondSentinel = Buffer.from("SECOND_PARENT_MUST_SURVIVE");
    await fs.writeFile(secondFile, secondSentinel);

    await expect(index.clearOnDisk()).resolves.toBe(true);
    await expect(fs.lstat(firstFile)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(secondFile)).toEqual(secondSentinel);
  });

  it("folds synthetic authority for case aliases on a case-insensitive filesystem", async (context) => {
    if (!canRunFts5) return;
    const root = await makeRoot("enquire-fts-case-alias-");
    const probe = path.join(root, "CaseProbe");
    await fs.writeFile(probe, "probe");
    try {
      await fs.lstat(path.join(root, "caseprobe"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return context.skip("filesystem treats case variants as distinct entries");
      }
      throw error;
    } finally {
      await fs.unlink(probe);
    }

    const upper = path.join(root, "CaseAlias.fts5.db");
    const lower = path.join(root, "casealias.fts5.db");
    const child = await spawnHolder("hold", upper);
    const before = await fs.readFile(upper);
    const aliasClearer = new FtsIndex({ file: lower, vaultRoot: "/vault/fts-coordination" });
    await expect(aliasClearer.clearOnDisk()).rejects.toBeInstanceOf(PersistenceLeaseConflictError);
    expect(await fs.readFile(upper)).toEqual(before);
    await closeChild(child);
    await expect(aliasClearer.clearOnDisk()).resolves.toBe(true);
  });
});
