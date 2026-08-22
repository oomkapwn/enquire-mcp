import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquirePersistenceLease,
  acquirePersistenceLeaseInScope,
  drainProcessPersistenceLeaseDebts,
  getProcessPersistenceLeaseDebtStatus,
  inspectPersistenceLeases,
  PersistenceLeaseConflictError,
  PersistenceLeaseIntegrityError,
  PersistenceLeaseOwnershipError,
  PersistenceLeaseRecoveryError,
  type PersistenceLeaseRole,
  PersistenceLeaseTimeoutError,
  recoverPersistenceLease,
  resolvePersistenceLeaseScope,
  revalidatePersistenceLeaseScope
} from "../src/persistence-lease.js";

const childFixture = path.resolve(__dirname, "fixtures", "persistence-lease-child.mjs");
const roots: string[] = [];
const children = new Set<ChildProcessWithoutNullStreams>();

interface ChildMessage {
  readonly event: "ready" | "released";
  readonly markerId?: string;
}

interface HeldChild {
  readonly process: ChildProcessWithoutNullStreams;
  readonly markerId: string;
  release(): Promise<void>;
  kill(): Promise<void>;
}

async function fixture(): Promise<{ readonly root: string; readonly targetPath: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-lease-"));
  roots.push(root);
  return { root, targetPath: path.join(root, "vault.embed.db") };
}

async function ownershipFailure(promise: Promise<unknown>): Promise<PersistenceLeaseOwnershipError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(PersistenceLeaseOwnershipError);
    return error as PersistenceLeaseOwnershipError;
  }
  throw new Error("expected a persistence ownership failure");
}

function waitForMessage(child: ChildProcessWithoutNullStreams, event: ChildMessage["event"]): Promise<ChildMessage> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`lease child timed out waiting for ${event}: ${stderr}`));
    }, 8_000);
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
          // Ignore non-protocol output; stderr is included if the child exits.
        }
      }
    };
    const onStderr = (chunk: Buffer): void => {
      stderr += chunk.toString("utf8");
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      reject(new Error(`lease child exited before ${event}: code=${code}, signal=${signal}, stderr=${stderr}`));
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

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once("exit", () => resolve());
  });
}

async function holdInChild(
  targetPath: string,
  role: PersistenceLeaseRole | "candidate",
  familyKey = "embed-db"
): Promise<HeldChild> {
  const child = spawn(process.execPath, [childFixture, targetPath, familyKey, role], {
    stdio: ["pipe", "pipe", "pipe"]
  });
  children.add(child);
  const ready = await waitForMessage(child, "ready");
  const markerId = ready.markerId;
  if (!markerId) throw new Error("lease child did not return a marker ID");
  return {
    process: child,
    markerId,
    release: async () => {
      const released = waitForMessage(child, "released");
      child.stdin.write("release\n");
      await released;
      await waitForExit(child);
      children.delete(child);
    },
    kill: async () => {
      child.kill("SIGKILL");
      await waitForExit(child);
      children.delete(child);
    }
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  const debtDrain = await drainProcessPersistenceLeaseDebts();
  expect(debtDrain.failures).toEqual([]);
  for (const child of children) child.kill("SIGKILL");
  await Promise.all([...children].map(waitForExit));
  children.clear();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("portable cross-process persistence lease", () => {
  it("keeps stable path and descriptor identity surfaces separate while publishing", async () => {
    const { targetPath } = await fixture();
    const realLstat = fs.lstat.bind(fs);
    const identityOffset = 2n ** 60n;
    let markerPathReads = 0;
    vi.spyOn(fs, "lstat").mockImplementation(async (filePath, options) => {
      const stats = await realLstat(filePath, options);
      const basename = path.basename(filePath.toString());
      if (basename === ".gate" || basename.startsWith(".candidate.") || basename.startsWith("lease.")) {
        markerPathReads++;
        return new Proxy(stats, {
          get(target, property, receiver) {
            const value = Reflect.get(target, property, receiver);
            return (property === "dev" || property === "ino") && typeof value === "bigint"
              ? value + identityOffset
              : value;
          }
        });
      }
      return stats;
    });

    const lease = await acquirePersistenceLease({ targetPath, familyKey: "embed-db", role: "shared" });
    await lease.release();

    expect(markerPathReads).toBeGreaterThan(0);
    expect(await inspectPersistenceLeases({ targetPath, familyKey: "embed-db" })).toMatchObject({
      gate: null,
      leases: [],
      candidates: []
    });
  });

  it("rejects a marker whose path identity surface changes during publication", async () => {
    const { targetPath } = await fixture();
    const realLstat = fs.lstat.bind(fs);
    let finalPathReads = 0;
    vi.spyOn(fs, "lstat").mockImplementation(async (filePath, options) => {
      const stats = await realLstat(filePath, options);
      if (path.basename(filePath.toString()).startsWith("lease.shared.") && finalPathReads < 2) {
        finalPathReads++;
        const identityDelta = BigInt(finalPathReads);
        return new Proxy(stats, {
          get(target, property, receiver) {
            const value = Reflect.get(target, property, receiver);
            return property === "ino" && typeof value === "bigint" ? value + identityDelta : value;
          }
        });
      }
      return stats;
    });

    await expect(acquirePersistenceLease({ targetPath, familyKey: "embed-db", role: "shared" })).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof PersistenceLeaseIntegrityError && !(error instanceof PersistenceLeaseOwnershipError)
    );
    expect(finalPathReads).toBe(2);
    vi.restoreAllMocks();
    expect(await inspectPersistenceLeases({ targetPath, familyKey: "embed-db" })).toMatchObject({
      gate: null,
      leases: [],
      candidates: []
    });
  });

  it("exactly removes a just-linked marker when final verification fails transiently", async () => {
    const { targetPath } = await fixture();
    const realLink = fs.link.bind(fs);
    const realLstat = fs.lstat.bind(fs);
    let leaseLinked = false;
    let finalVerificationFaults = 0;
    vi.spyOn(fs, "link").mockImplementation(async (existingPath, newPath) => {
      await realLink(existingPath, newPath);
      if (path.basename(newPath.toString()).startsWith("lease.shared.")) leaseLinked = true;
    });
    vi.spyOn(fs, "lstat").mockImplementation(async (filePath, options) => {
      if (
        leaseLinked &&
        path.basename(filePath.toString()).startsWith("lease.shared.") &&
        finalVerificationFaults === 0
      ) {
        finalVerificationFaults++;
        throw Object.assign(new Error("injected final verification failure"), { code: "EIO" });
      }
      return realLstat(filePath, options);
    });

    await expect(acquirePersistenceLease({ targetPath, familyKey: "embed-db", role: "shared" })).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof PersistenceLeaseIntegrityError && !(error instanceof PersistenceLeaseOwnershipError)
    );
    expect(finalVerificationFaults).toBe(1);
    vi.restoreAllMocks();
    expect(await inspectPersistenceLeases({ targetPath, familyKey: "embed-db" })).toMatchObject({
      gate: null,
      leases: [],
      candidates: []
    });
    const shared = await acquirePersistenceLease({ targetPath, familyKey: "embed-db", role: "shared" });
    await shared.release();
  });

  it("retains a retryable owner when post-link publication and exact rollback both fail", async () => {
    const { targetPath } = await fixture();
    const realLink = fs.link.bind(fs);
    const realUnlink = fs.unlink.bind(fs);
    let leaseLinked = false;
    let candidateCleanupFaults = 0;
    let finalCleanupFaults = 0;
    vi.spyOn(fs, "link").mockImplementation(async (existingPath, newPath) => {
      await realLink(existingPath, newPath);
      if (path.basename(newPath.toString()).startsWith("lease.shared.")) leaseLinked = true;
    });
    vi.spyOn(fs, "unlink").mockImplementation(async (filePath) => {
      const basename = path.basename(filePath.toString());
      if (leaseLinked && basename.startsWith(".candidate.")) {
        candidateCleanupFaults++;
        throw Object.assign(new Error("injected candidate cleanup failure"), { code: "EIO" });
      }
      if (leaseLinked && basename.startsWith("lease.shared.")) {
        finalCleanupFaults++;
        throw Object.assign(new Error("injected final cleanup failure"), { code: "EIO" });
      }
      return realUnlink(filePath);
    });

    const failure = await ownershipFailure(
      acquirePersistenceLease({ targetPath, familyKey: "embed-db", role: "shared", gateTimeoutMs: 40, gatePollMs: 5 })
    );
    expect({ candidateCleanupFaults, finalCleanupFaults }).toEqual({
      candidateCleanupFaults: 2,
      finalCleanupFaults: 1
    });
    expect(failure.debtOwner.artifacts.map(({ marker }) => marker.kind).sort()).toEqual(["candidate", "gate", "lease"]);

    const retained = await inspectPersistenceLeases({ targetPath, familyKey: "embed-db" });
    expect(retained.gate).not.toBeNull();
    expect(retained.leases).toHaveLength(1);
    expect(retained.candidates).toHaveLength(1);
    await expect(
      acquirePersistenceLease({
        targetPath,
        familyKey: "embed-db",
        role: "eraser",
        gateTimeoutMs: 30,
        gatePollMs: 5
      })
    ).rejects.toBeInstanceOf(PersistenceLeaseOwnershipError);

    vi.restoreAllMocks();
    await failure.debtOwner.release();
    await failure.debtOwner.release();
    expect(await inspectPersistenceLeases({ targetPath, familyKey: "embed-db" })).toMatchObject({
      gate: null,
      leases: [],
      candidates: []
    });
    const eraser = await acquirePersistenceLease({ targetPath, familyKey: "embed-db", role: "eraser" });
    await eraser.release();
  });

  it("retains both the published lease and its gate when gate release fails", async () => {
    const { targetPath } = await fixture();
    const realLink = fs.link.bind(fs);
    const realUnlink = fs.unlink.bind(fs);
    let leaseLinked = false;
    let gateReleaseFaults = 0;
    vi.spyOn(fs, "link").mockImplementation(async (existingPath, newPath) => {
      await realLink(existingPath, newPath);
      if (path.basename(newPath.toString()).startsWith("lease.publisher.")) leaseLinked = true;
    });
    vi.spyOn(fs, "unlink").mockImplementation(async (filePath) => {
      if (leaseLinked && path.basename(filePath.toString()) === ".gate") {
        gateReleaseFaults++;
        throw Object.assign(new Error("injected gate release failure"), { code: "EIO" });
      }
      return realUnlink(filePath);
    });

    const failure = await ownershipFailure(
      acquirePersistenceLease({
        targetPath,
        familyKey: "embed-db",
        role: "publisher",
        gateTimeoutMs: 40,
        gatePollMs: 5
      })
    );
    expect(gateReleaseFaults).toBe(1);
    expect(failure.debtOwner.artifacts.map(({ marker }) => marker.kind)).toEqual(["gate", "lease"]);

    const retained = await inspectPersistenceLeases({ targetPath, familyKey: "embed-db" });
    expect(retained.gate).not.toBeNull();
    expect(retained.leases.map((marker) => marker.role)).toEqual(["publisher"]);
    await expect(
      acquirePersistenceLease({
        targetPath,
        familyKey: "embed-db",
        role: "shared",
        gateTimeoutMs: 30,
        gatePollMs: 5
      })
    ).rejects.toBeInstanceOf(PersistenceLeaseOwnershipError);

    vi.restoreAllMocks();
    await failure.debtOwner.release();
    expect(await inspectPersistenceLeases({ targetPath, familyKey: "embed-db" })).toMatchObject({
      gate: null,
      leases: [],
      candidates: []
    });
    const shared = await acquirePersistenceLease({ targetPath, familyKey: "embed-db", role: "shared" });
    await shared.release();
  });

  it("releases monotonically while a caller concurrently removes the persistence parent", async () => {
    const { root, targetPath } = await fixture();
    const lease = await acquirePersistenceLease({ targetPath, familyKey: "embed-db", role: "shared" });
    const realLink = fs.link.bind(fs);
    const linkedDuringRelease: string[] = [];
    vi.spyOn(fs, "link").mockImplementation(async (existingPath, newPath) => {
      linkedDuringRelease.push(path.basename(newPath.toString()));
      return realLink(existingPath, newPath);
    });
    const realUnlink = fs.unlink.bind(fs);
    let markerUnlinkReached: (() => void) | undefined;
    const markerUnlinkStarted = new Promise<void>((resolve) => {
      markerUnlinkReached = resolve;
    });
    let allowMarkerUnlink: (() => void) | undefined;
    const markerUnlinkAllowed = new Promise<void>((resolve) => {
      allowMarkerUnlink = resolve;
    });
    vi.spyOn(fs, "unlink").mockImplementation(async (filePath) => {
      if (path.basename(filePath.toString()) === lease.marker.id) {
        markerUnlinkReached?.();
        await markerUnlinkAllowed;
      }
      return realUnlink(filePath);
    });

    const releasing = lease.release();
    await markerUnlinkStarted;
    try {
      await fs.rm(root, { recursive: true, force: true });
    } finally {
      allowMarkerUnlink?.();
    }
    await releasing;

    expect(linkedDuringRelease).toEqual([]);
    await expect(fs.lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("drains a transient same-scope release debt after the ephemeral caller discards its error", async () => {
    const { targetPath } = await fixture();
    const lease = await acquirePersistenceLease({ targetPath, familyKey: "embed-db", role: "shared" });
    expect(getProcessPersistenceLeaseDebtStatus()).toMatchObject({ ownerCount: 0, artifactCount: 0 });
    const realLink = fs.link.bind(fs);
    let releaseLinks = 0;
    vi.spyOn(fs, "link").mockImplementation(async (existingPath, newPath) => {
      releaseLinks++;
      return realLink(existingPath, newPath);
    });
    const realUnlink = fs.unlink.bind(fs);
    let markerReleaseFaults = 0;
    vi.spyOn(fs, "unlink").mockImplementation(async (filePath) => {
      if (path.basename(filePath.toString()) === lease.marker.id) {
        markerReleaseFaults++;
        throw Object.assign(new Error("injected marker release failure"), { code: "EIO" });
      }
      return realUnlink(filePath);
    });

    await lease.release().catch((error: unknown) => {
      expect(error).toBeInstanceOf(PersistenceLeaseOwnershipError);
    });
    expect(markerReleaseFaults).toBe(1);
    expect(releaseLinks).toBe(0);
    expect(getProcessPersistenceLeaseDebtStatus()).toMatchObject({ ownerCount: 1, artifactCount: 1 });
    expect(await inspectPersistenceLeases({ targetPath, familyKey: "embed-db" })).toMatchObject({
      gate: null,
      leases: [{ id: lease.marker.id }],
      candidates: []
    });

    vi.restoreAllMocks();
    const eraser = await acquirePersistenceLease({ targetPath, familyKey: "embed-db", role: "eraser" });
    expect(getProcessPersistenceLeaseDebtStatus()).toMatchObject({ ownerCount: 0, artifactCount: 0 });
    await eraser.release();
  });

  it("does not drain or block an unrelated exact scope", async () => {
    const first = await fixture();
    const second = await fixture();
    const lease = await acquirePersistenceLease({
      targetPath: first.targetPath,
      familyKey: "embed-db",
      role: "shared"
    });
    const realUnlink = fs.unlink.bind(fs);
    vi.spyOn(fs, "unlink").mockImplementation(async (filePath) => {
      if (path.basename(filePath.toString()) === lease.marker.id) {
        throw Object.assign(new Error("injected unrelated-scope debt"), { code: "EIO" });
      }
      return realUnlink(filePath);
    });
    await lease.release().catch((error: unknown) => {
      expect(error).toBeInstanceOf(PersistenceLeaseOwnershipError);
    });
    expect(getProcessPersistenceLeaseDebtStatus()).toMatchObject({ ownerCount: 1, artifactCount: 1 });

    vi.restoreAllMocks();
    const unrelated = await acquirePersistenceLease({
      targetPath: second.targetPath,
      familyKey: "embed-db",
      role: "eraser"
    });
    expect(getProcessPersistenceLeaseDebtStatus()).toMatchObject({ ownerCount: 1, artifactCount: 1 });
    await unrelated.release();

    const drained = await drainProcessPersistenceLeaseDebts();
    expect(drained).toMatchObject({
      attemptedOwners: 1,
      releasedOwners: 1,
      failures: [],
      status: { ownerCount: 0, artifactCount: 0, saturated: false }
    });
    const repeated = await drainProcessPersistenceLeaseDebts();
    expect(repeated).toMatchObject({ attemptedOwners: 0, releasedOwners: 0, failures: [] });
    const firstEraser = await acquirePersistenceLease({
      targetPath: first.targetPath,
      familyKey: "embed-db",
      role: "eraser"
    });
    await firstEraser.release();
  });

  it("keeps persistent same-scope debt deduplicated and refuses a new marker", async () => {
    const { targetPath } = await fixture();
    const lease = await acquirePersistenceLease({ targetPath, familyKey: "embed-db", role: "shared" });
    const realLink = fs.link.bind(fs);
    const realUnlink = fs.unlink.bind(fs);
    let forbiddenEraserLinks = 0;
    vi.spyOn(fs, "link").mockImplementation(async (existingPath, newPath) => {
      if (path.basename(newPath.toString()).startsWith("lease.eraser.")) forbiddenEraserLinks++;
      return realLink(existingPath, newPath);
    });
    vi.spyOn(fs, "unlink").mockImplementation(async (filePath) => {
      if (path.basename(filePath.toString()) === lease.marker.id) {
        throw Object.assign(new Error("persistent injected release failure"), { code: "EIO" });
      }
      return realUnlink(filePath);
    });
    await lease.release().catch((error: unknown) => {
      expect(error).toBeInstanceOf(PersistenceLeaseOwnershipError);
    });

    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(
        acquirePersistenceLease({ targetPath, familyKey: "embed-db", role: "eraser" })
      ).rejects.toBeInstanceOf(PersistenceLeaseOwnershipError);
      expect(getProcessPersistenceLeaseDebtStatus()).toMatchObject({ ownerCount: 1, artifactCount: 1 });
    }
    expect(forbiddenEraserLinks).toBe(0);
    const retained = await inspectPersistenceLeases({ targetPath, familyKey: "embed-db" });
    expect(retained.gate).toBeNull();
    expect(retained.leases.map((marker) => marker.id)).toEqual([lease.marker.id]);
    const failedDrain = await drainProcessPersistenceLeaseDebts();
    expect(failedDrain).toMatchObject({
      attemptedOwners: 1,
      releasedOwners: 0,
      status: {
        ownerCount: 1,
        artifactCount: 1,
        maxOwners: 256,
        maxArtifacts: 1_024,
        saturated: false
      }
    });
    expect(failedDrain.failures).toHaveLength(1);

    vi.restoreAllMocks();
    const drained = await drainProcessPersistenceLeaseDebts();
    expect(drained).toMatchObject({ attemptedOwners: 1, releasedOwners: 1, failures: [] });
    expect(getProcessPersistenceLeaseDebtStatus()).toMatchObject({
      ownerCount: 0,
      artifactCount: 0,
      saturated: false
    });
    const eraser = await acquirePersistenceLease({ targetPath, familyKey: "embed-db", role: "eraser" });
    await eraser.release();
  });

  it("admits two shared child-process holders and admits an exclusive eraser only after both release", async () => {
    const { targetPath } = await fixture();
    const first = await holdInChild(targetPath, "shared");
    const second = await holdInChild(targetPath, "shared");

    const snapshot = await inspectPersistenceLeases({ targetPath, familyKey: "embed-db" });
    expect(snapshot.leases.map((marker) => marker.role)).toEqual(["shared", "shared"]);
    const publisher = await acquirePersistenceLease({ targetPath, familyKey: "embed-db", role: "publisher" });
    await expect(
      acquirePersistenceLease({ targetPath, familyKey: "embed-db", role: "publisher" })
    ).rejects.toBeInstanceOf(PersistenceLeaseConflictError);
    await expect(acquirePersistenceLease({ targetPath, familyKey: "embed-db", role: "eraser" })).rejects.toBeInstanceOf(
      PersistenceLeaseConflictError
    );

    await publisher.release();
    await first.release();
    await second.release();
    const eraser = await acquirePersistenceLease({ targetPath, familyKey: "embed-db", role: "eraser" });
    await eraser.release();
    expect((await inspectPersistenceLeases({ targetPath, familyKey: "embed-db" })).leases).toEqual([]);
  });

  it("makes an exclusive child-process eraser block shared and publisher roles", async () => {
    const { targetPath } = await fixture();
    const eraser = await holdInChild(targetPath, "eraser");

    await expect(acquirePersistenceLease({ targetPath, familyKey: "embed-db", role: "shared" })).rejects.toBeInstanceOf(
      PersistenceLeaseConflictError
    );
    await expect(
      acquirePersistenceLease({ targetPath, familyKey: "embed-db", role: "publisher" })
    ).rejects.toBeInstanceOf(PersistenceLeaseConflictError);

    await eraser.release();
  });

  it("admits only exact marker finalization and confirmed release during contention", async () => {
    {
      const { targetPath } = await fixture();
      const realLink = fs.link.bind(fs);
      let injectedAba = false;
      const linkSpy = vi.spyOn(fs, "link").mockImplementation(async (existingPath, newPath) => {
        if (!injectedAba && path.basename(newPath.toString()) === ".gate") {
          injectedAba = true;
          throw Object.assign(new Error("gate owner released before inspection"), { code: "EEXIST" });
        }
        return realLink(existingPath, newPath);
      });
      try {
        const lease = await acquirePersistenceLease({ targetPath, familyKey: "embed-db", role: "shared" });
        expect(injectedAba).toBe(true);
        await lease.release();
      } finally {
        linkSpy.mockRestore();
      }
    }

    {
      const { targetPath } = await fixture();
      const realLink = fs.link.bind(fs);
      let gateLinkAttempts = 0;
      const linkSpy = vi.spyOn(fs, "link").mockImplementation(async (existingPath, newPath) => {
        if (path.basename(newPath.toString()) !== ".gate") return realLink(existingPath, newPath);
        gateLinkAttempts++;
        if (gateLinkAttempts === 1) {
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
          throw Object.assign(new Error("delayed absent gate contention"), { code: "EEXIST" });
        }
        throw Object.assign(new Error("gate retry crossed its deadline"), { code: "EIO" });
      });
      try {
        await expect(
          acquirePersistenceLease({
            targetPath,
            familyKey: "embed-db",
            role: "shared",
            gateTimeoutMs: 1,
            gatePollMs: 1
          })
        ).rejects.toBeInstanceOf(PersistenceLeaseTimeoutError);
        expect(gateLinkAttempts).toBe(1);
      } finally {
        linkSpy.mockRestore();
      }
    }

    const createFixedGate = async (): Promise<{
      readonly gateBytes: string;
      readonly gatePath: string;
      readonly targetPath: string;
    }> => {
      const { targetPath } = await fixture();
      const initializer = await acquirePersistenceLease({ targetPath, familyKey: "embed-db", role: "shared" });
      const { scope } = initializer;
      await initializer.release();
      const gatePath = path.join(scope.directory, ".gate");
      const gateBytes = `${JSON.stringify({
        version: 1,
        scopeDigest: scope.digest,
        kind: "gate",
        hostname: os.hostname(),
        pid: process.pid,
        nonce: "a".repeat(32),
        createdAt: "2026-08-22T00:00:00.000Z"
      })}\n`;
      await fs.writeFile(gatePath, gateBytes, { flag: "wx", mode: 0o600 });
      return { gateBytes, gatePath, targetPath };
    };
    const injectFirstGateDescriptorTransition = (
      firstNlink: bigint
    ): { readonly calls: () => number; readonly restore: () => void } => {
      const realOpen = fs.open.bind(fs);
      let firstGateHandleWrapped = false;
      let statCalls = 0;
      const openSpy = vi.spyOn(fs, "open").mockImplementation(async (candidate, ...args) => {
        const handle = await realOpen(candidate, ...args);
        if (firstGateHandleWrapped || path.basename(candidate.toString()) !== ".gate") return handle;
        firstGateHandleWrapped = true;
        const realStat = handle.stat.bind(handle);
        const mutableHandle = handle as unknown as {
          stat(options: { bigint: true }): Promise<import("node:fs").BigIntStats>;
        };
        mutableHandle.stat = async (options) => {
          const stats = await realStat(options);
          statCalls++;
          if (statCalls !== 1) return stats;
          return new Proxy(stats, {
            get(target, property) {
              if (property === "nlink") return firstNlink;
              if (property === "ctimeNs") return target.ctimeNs - 1n;
              const value = Reflect.get(target, property, target);
              return typeof value === "function" ? value.bind(target) : value;
            }
          });
        };
        return handle;
      });
      return { calls: () => statCalls, restore: () => openSpy.mockRestore() };
    };
    const injectFirstDescriptorUnlink = (
      markerPath: string,
      replacementBytes?: string,
      options: { readonly injectCloseEnoent?: boolean; readonly unlinkOnSecondStat?: boolean } = {}
    ): {
      readonly calls: () => number;
      readonly closeFaults: () => number;
      readonly closeLeaked: () => Promise<void>;
      readonly restore: () => void;
      readonly unlinked: () => boolean;
    } => {
      const realOpen = fs.open.bind(fs);
      let firstMarkerHandleWrapped = false;
      let statCalls = 0;
      let closeFaults = 0;
      let leakedClose: (() => Promise<void>) | undefined;
      let unlinked = false;
      const { injectCloseEnoent = false, unlinkOnSecondStat = true } = options;
      const openSpy = vi.spyOn(fs, "open").mockImplementation(async (candidate, ...args) => {
        const handle = await realOpen(candidate, ...args);
        if (firstMarkerHandleWrapped || candidate.toString() !== markerPath) return handle;
        firstMarkerHandleWrapped = true;
        const realStat = handle.stat.bind(handle);
        const realClose = handle.close.bind(handle);
        const mutableHandle = handle as unknown as {
          close(): Promise<void>;
          stat(options: { bigint: true }): Promise<import("node:fs").BigIntStats>;
        };
        mutableHandle.close = async () => {
          if (injectCloseEnoent && closeFaults === 0) {
            closeFaults++;
            leakedClose = realClose;
            throw Object.assign(new Error("injected marker descriptor close failure"), { code: "ENOENT" });
          }
          leakedClose = undefined;
          return realClose();
        };
        mutableHandle.stat = async (options) => {
          statCalls++;
          if (statCalls === 2 && unlinkOnSecondStat) {
            await fs.unlink(markerPath);
            unlinked = true;
            if (replacementBytes !== undefined) {
              await fs.writeFile(markerPath, replacementBytes, { flag: "wx", mode: 0o600 });
            }
          }
          return realStat(options);
        };
        return handle;
      });
      return {
        calls: () => statCalls,
        closeFaults: () => closeFaults,
        closeLeaked: async () => {
          const close = leakedClose;
          leakedClose = undefined;
          await close?.();
        },
        restore: () => openSpy.mockRestore(),
        unlinked: () => unlinked
      };
    };
    const removeIfPresent = async (filePath: string): Promise<void> => {
      try {
        await fs.unlink(filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    };

    {
      const { gatePath, targetPath } = await createFixedGate();
      const transition = injectFirstGateDescriptorTransition(2n);
      try {
        await expect(
          acquirePersistenceLease({
            targetPath,
            familyKey: "embed-db",
            role: "shared",
            gateTimeoutMs: 30,
            gatePollMs: 5
          })
        ).rejects.toBeInstanceOf(PersistenceLeaseTimeoutError);
        expect(transition.calls()).toBe(2);
      } finally {
        transition.restore();
        await fs.unlink(gatePath);
      }
    }

    {
      const { gatePath, targetPath } = await createFixedGate();
      const transition = injectFirstGateDescriptorTransition(1n);
      try {
        await expect(
          acquirePersistenceLease({
            targetPath,
            familyKey: "embed-db",
            role: "shared",
            gateTimeoutMs: 30,
            gatePollMs: 5
          })
        ).rejects.toBeInstanceOf(PersistenceLeaseIntegrityError);
        expect(transition.calls()).toBe(2);
      } finally {
        transition.restore();
        await fs.unlink(gatePath);
      }
    }

    {
      const { gatePath, targetPath } = await createFixedGate();
      const transition = injectFirstGateDescriptorTransition(3n);
      try {
        await expect(
          acquirePersistenceLease({
            targetPath,
            familyKey: "embed-db",
            role: "shared",
            gateTimeoutMs: 30,
            gatePollMs: 5
          })
        ).rejects.toBeInstanceOf(PersistenceLeaseIntegrityError);
        expect(transition.calls()).toBe(2);
      } finally {
        transition.restore();
        await fs.unlink(gatePath);
      }
    }

    {
      const { gatePath, targetPath } = await createFixedGate();
      const transition = injectFirstDescriptorUnlink(gatePath);
      try {
        const lease = await acquirePersistenceLease({
          targetPath,
          familyKey: "embed-db",
          role: "shared",
          gateTimeoutMs: 100,
          gatePollMs: 5
        });
        expect(transition.calls()).toBe(2);
        expect(transition.unlinked()).toBe(true);
        await lease.release();
      } finally {
        transition.restore();
        await removeIfPresent(gatePath);
      }
    }

    {
      const { gatePath, targetPath } = await createFixedGate();
      const transition = injectFirstDescriptorUnlink(gatePath, undefined, { injectCloseEnoent: true });
      try {
        await expect(
          acquirePersistenceLease({
            targetPath,
            familyKey: "embed-db",
            role: "shared",
            gateTimeoutMs: 100,
            gatePollMs: 5
          })
        ).rejects.toBeInstanceOf(AggregateError);
        expect(transition.calls()).toBe(2);
        expect(transition.closeFaults()).toBe(1);
        expect(transition.unlinked()).toBe(true);
      } finally {
        await transition.closeLeaked();
        transition.restore();
        await removeIfPresent(gatePath);
      }
    }

    {
      const { gatePath, targetPath } = await createFixedGate();
      const transition = injectFirstDescriptorUnlink(gatePath, undefined, {
        injectCloseEnoent: true,
        unlinkOnSecondStat: false
      });
      try {
        await expect(
          acquirePersistenceLease({
            targetPath,
            familyKey: "embed-db",
            role: "shared",
            gateTimeoutMs: 100,
            gatePollMs: 5
          })
        ).rejects.toMatchObject({ code: "ENOENT" });
        expect(transition.calls()).toBe(2);
        expect(transition.closeFaults()).toBe(1);
        expect(transition.unlinked()).toBe(false);
      } finally {
        await transition.closeLeaked();
        transition.restore();
        await removeIfPresent(gatePath);
      }
    }

    {
      const { gatePath, targetPath } = await createFixedGate();
      const transition = injectFirstDescriptorUnlink(gatePath);
      const realLstat = fs.lstat.bind(fs);
      let injectedEio = false;
      const lstatSpy = vi.spyOn(fs, "lstat").mockImplementation(async (candidate, options) => {
        if (!injectedEio && transition.unlinked() && candidate.toString() === gatePath) {
          injectedEio = true;
          throw Object.assign(new Error("injected gate disappearance confirmation failure"), { code: "EIO" });
        }
        return realLstat(candidate, options);
      });
      try {
        await expect(
          acquirePersistenceLease({
            targetPath,
            familyKey: "embed-db",
            role: "shared",
            gateTimeoutMs: 100,
            gatePollMs: 5
          })
        ).rejects.toMatchObject({ code: "EIO" });
        expect(transition.calls()).toBe(2);
        expect(injectedEio).toBe(true);
      } finally {
        lstatSpy.mockRestore();
        transition.restore();
        await removeIfPresent(gatePath);
      }
    }

    {
      const { gateBytes, gatePath, targetPath } = await createFixedGate();
      const transition = injectFirstDescriptorUnlink(gatePath, gateBytes);
      try {
        await expect(
          acquirePersistenceLease({
            targetPath,
            familyKey: "embed-db",
            role: "shared",
            gateTimeoutMs: 100,
            gatePollMs: 5
          })
        ).rejects.toThrow(/reappeared after it disappeared/u);
        expect(transition.calls()).toBe(2);
        expect(transition.unlinked()).toBe(true);
      } finally {
        transition.restore();
        await removeIfPresent(gatePath);
      }
    }

    {
      const { targetPath } = await fixture();
      const retained = await acquirePersistenceLease({ targetPath, familyKey: "embed-db", role: "shared" });
      const markerPath = path.join(retained.scope.directory, retained.marker.id);
      const transition = injectFirstDescriptorUnlink(markerPath);
      try {
        await expect(inspectPersistenceLeases({ targetPath, familyKey: "embed-db" })).rejects.toBeInstanceOf(
          PersistenceLeaseIntegrityError
        );
        expect(transition.calls()).toBe(2);
        expect(transition.unlinked()).toBe(true);
      } finally {
        transition.restore();
        await retained.release();
      }
    }

    {
      const { targetPath } = await fixture();
      const departing = await acquirePersistenceLease({ targetPath, familyKey: "embed-db", role: "publisher" });
      const markerPath = path.join(departing.scope.directory, departing.marker.id);
      const realLstat = fs.lstat.bind(fs);
      let releasedDuringScan = false;
      const lstatSpy = vi.spyOn(fs, "lstat").mockImplementation(async (candidate, options) => {
        if (!releasedDuringScan && candidate.toString() === markerPath) {
          releasedDuringScan = true;
          await departing.release();
        }
        return realLstat(candidate, options);
      });
      try {
        const replacement = await acquirePersistenceLease({
          targetPath,
          familyKey: "embed-db",
          role: "publisher"
        });
        expect(releasedDuringScan).toBe(true);
        await replacement.release();
      } finally {
        lstatSpy.mockRestore();
        await departing.release();
      }
    }

    {
      const { targetPath } = await fixture();
      const retained = await acquirePersistenceLease({ targetPath, familyKey: "embed-db", role: "publisher" });
      const markerPath = path.join(retained.scope.directory, retained.marker.id);
      const realLstat = fs.lstat.bind(fs);
      let injectedEio = false;
      const lstatSpy = vi.spyOn(fs, "lstat").mockImplementation(async (candidate, options) => {
        if (!injectedEio && candidate.toString() === markerPath) {
          injectedEio = true;
          throw Object.assign(new Error("injected lifetime marker inspection failure"), { code: "EIO" });
        }
        return realLstat(candidate, options);
      });
      try {
        await expect(
          acquirePersistenceLease({ targetPath, familyKey: "embed-db", role: "publisher" })
        ).rejects.toMatchObject({ code: "EIO" });
        expect(injectedEio).toBe(true);
      } finally {
        lstatSpy.mockRestore();
        await retained.release();
      }
    }

    {
      const { targetPath } = await fixture();
      const departing = await acquirePersistenceLease({ targetPath, familyKey: "embed-db", role: "publisher" });
      const markerPath = path.join(departing.scope.directory, departing.marker.id);
      const markerBytes = await fs.readFile(markerPath, "utf8");
      const realLstat = fs.lstat.bind(fs);
      let replacedDuringScan = false;
      const lstatSpy = vi.spyOn(fs, "lstat").mockImplementation(async (candidate, options) => {
        if (!replacedDuringScan && candidate.toString() === markerPath) {
          replacedDuringScan = true;
          await departing.release();
          await fs.writeFile(markerPath, markerBytes, { flag: "wx", mode: 0o600 });
          throw Object.assign(new Error("injected released-marker path miss"), { code: "ENOENT" });
        }
        return realLstat(candidate, options);
      });
      try {
        await expect(acquirePersistenceLease({ targetPath, familyKey: "embed-db", role: "publisher" })).rejects.toThrow(
          /reappeared after it disappeared/u
        );
        expect(replacedDuringScan).toBe(true);
      } finally {
        lstatSpy.mockRestore();
        await departing.release();
        await removeIfPresent(markerPath);
      }
    }
  });

  it("never auto-steals a crashed marker and recovers it only after ESRCH plus explicit quiescence", async () => {
    const { targetPath } = await fixture();
    const child = await holdInChild(targetPath, "shared");
    await child.kill();
    expect(getProcessPersistenceLeaseDebtStatus()).toMatchObject({ ownerCount: 0, artifactCount: 0 });

    await expect(acquirePersistenceLease({ targetPath, familyKey: "embed-db", role: "eraser" })).rejects.toBeInstanceOf(
      PersistenceLeaseConflictError
    );
    const snapshot = await inspectPersistenceLeases({ targetPath, familyKey: "embed-db" });
    expect(snapshot.leases.map((marker) => marker.id)).toContain(child.markerId);
    await expect(
      recoverPersistenceLease({
        targetPath,
        familyKey: "embed-db",
        markerId: child.markerId,
        assertQuiescent: async () => false
      })
    ).rejects.toBeInstanceOf(PersistenceLeaseRecoveryError);
    expect((await inspectPersistenceLeases({ targetPath, familyKey: "embed-db" })).leases).toHaveLength(1);

    await recoverPersistenceLease({
      targetPath,
      familyKey: "embed-db",
      markerId: child.markerId,
      assertQuiescent: async ({ marker }) => marker.pid === child.process.pid
    });

    const gateNonce = "a".repeat(32);
    await fs.writeFile(
      path.join(snapshot.scope.directory, ".gate"),
      `${JSON.stringify({
        version: 1,
        scopeDigest: snapshot.scope.digest,
        kind: "gate",
        hostname: os.hostname(),
        pid: child.process.pid,
        nonce: gateNonce,
        createdAt: new Date().toISOString()
      })}\n`,
      { flag: "wx", mode: 0o600 }
    );
    await expect(
      acquirePersistenceLease({
        targetPath,
        familyKey: "embed-db",
        role: "publisher",
        gateTimeoutMs: 30,
        gatePollMs: 5
      })
    ).rejects.toBeInstanceOf(PersistenceLeaseTimeoutError);
    await recoverPersistenceLease({
      targetPath,
      familyKey: "embed-db",
      markerId: ".gate",
      assertQuiescent: async () => true
    });

    const candidateChild = await holdInChild(targetPath, "candidate");
    await candidateChild.kill();
    const candidateSnapshot = await inspectPersistenceLeases({ targetPath, familyKey: "embed-db" });
    expect(candidateSnapshot.candidates.map((marker) => marker.id)).toContain(candidateChild.markerId);
    await expect(
      recoverPersistenceLease({
        targetPath,
        familyKey: "embed-db",
        markerId: candidateChild.markerId,
        assertQuiescent: async () => false
      })
    ).rejects.toBeInstanceOf(PersistenceLeaseRecoveryError);
    await recoverPersistenceLease({
      targetPath,
      familyKey: "embed-db",
      markerId: candidateChild.markerId,
      assertQuiescent: async ({ marker }) => marker.pid === candidateChild.process.pid
    });
    expect((await inspectPersistenceLeases({ targetPath, familyKey: "embed-db" })).candidates).toEqual([]);

    const publisher = await acquirePersistenceLease({ targetPath, familyKey: "embed-db", role: "publisher" });
    await publisher.release();
  });

  it("retains an exact recovery gate debt after the orphan removal commits", async () => {
    const { targetPath } = await fixture();
    const child = await holdInChild(targetPath, "shared");
    await child.kill();
    const realUnlink = fs.unlink.bind(fs);
    let gateReleaseFaults = 0;
    vi.spyOn(fs, "unlink").mockImplementation(async (filePath) => {
      if (path.basename(filePath.toString()) === ".gate") {
        gateReleaseFaults++;
        throw Object.assign(new Error("injected recovery gate release failure"), { code: "EIO" });
      }
      return realUnlink(filePath);
    });

    const failure = await ownershipFailure(
      recoverPersistenceLease({
        targetPath,
        familyKey: "embed-db",
        markerId: child.markerId,
        assertQuiescent: async () => true
      })
    );
    expect(gateReleaseFaults).toBe(1);
    expect(failure.debtOwner.artifacts.map(({ marker }) => marker.id)).toEqual([".gate"]);
    expect(getProcessPersistenceLeaseDebtStatus()).toMatchObject({ ownerCount: 1, artifactCount: 1 });
    const committed = await inspectPersistenceLeases({ targetPath, familyKey: "embed-db" });
    expect(committed.leases).toEqual([]);
    expect(committed.gate?.id).toBe(".gate");

    vi.restoreAllMocks();
    const drained = await drainProcessPersistenceLeaseDebts();
    expect(drained).toMatchObject({
      attemptedOwners: 1,
      releasedOwners: 1,
      failures: [],
      status: { ownerCount: 0, artifactCount: 0, saturated: false }
    });
  });

  it("NEGATIVE control — rejected recovery with terminal gate cleanup creates no process debt", async () => {
    const { targetPath } = await fixture();
    const child = await holdInChild(targetPath, "shared");
    await child.kill();

    await expect(
      recoverPersistenceLease({
        targetPath,
        familyKey: "embed-db",
        markerId: child.markerId,
        assertQuiescent: async () => false
      })
    ).rejects.toBeInstanceOf(PersistenceLeaseRecoveryError);
    expect(getProcessPersistenceLeaseDebtStatus()).toMatchObject({ ownerCount: 0, artifactCount: 0 });
    expect((await inspectPersistenceLeases({ targetPath, familyKey: "embed-db" })).leases).toHaveLength(1);

    await recoverPersistenceLease({
      targetPath,
      familyKey: "embed-db",
      markerId: child.markerId,
      assertQuiescent: async () => true
    });
  });

  it("converges lexical and parent-symlink aliases on one canonical scope", async (ctx) => {
    const { root, targetPath } = await fixture();
    const alias = path.join(root, "parent-alias");
    try {
      await fs.symlink(root, alias, "dir");
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
      if (code === "EPERM" || code === "EACCES") return ctx.skip("filesystem cannot create a directory symlink");
      throw error;
    }
    const lexical = path.join(root, "missing", "..", path.basename(targetPath));
    const aliased = path.join(alias, path.basename(targetPath));
    const [directScope, lexicalScope, aliasScope] = await Promise.all([
      resolvePersistenceLeaseScope({ targetPath, familyKey: "embed-db" }),
      resolvePersistenceLeaseScope({ targetPath: lexical, familyKey: "embed-db" }),
      resolvePersistenceLeaseScope({ targetPath: aliased, familyKey: "embed-db" })
    ]);
    expect(lexicalScope.directory).toBe(directScope.directory);
    expect(aliasScope.directory).toBe(directScope.directory);

    const shared = await acquirePersistenceLease({ targetPath: aliased, familyKey: "embed-db", role: "shared" });
    await expect(
      acquirePersistenceLease({ targetPath: lexical, familyKey: "embed-db", role: "eraser" })
    ).rejects.toBeInstanceOf(PersistenceLeaseConflictError);
    await shared.release();
  });

  it("converges missing case aliases before either spelling creates the target", async () => {
    const { root } = await fixture();
    const upperTarget = path.join(root, "Vault.Embed.DB");
    const lowerTarget = path.join(root, "vault.embed.db");
    const [upperScope, lowerScope] = await Promise.all([
      resolvePersistenceLeaseScope({ targetPath: upperTarget, familyKey: "embed-db" }),
      resolvePersistenceLeaseScope({ targetPath: lowerTarget, familyKey: "embed-db" })
    ]);

    expect(upperScope.targetName).not.toBe(lowerScope.targetName);
    expect(upperScope.digest).toBe(lowerScope.digest);
    expect(upperScope.directory).toBe(lowerScope.directory);

    const shared = await acquirePersistenceLease({ targetPath: upperTarget, familyKey: "embed-db", role: "shared" });
    await expect(
      acquirePersistenceLease({ targetPath: lowerTarget, familyKey: "embed-db", role: "eraser" })
    ).rejects.toBeInstanceOf(PersistenceLeaseConflictError);
    await shared.release();
  });

  it("rejects existing hard-link aliases before they can split one target across parent scopes", async (ctx) => {
    const { root } = await fixture();
    const firstParent = path.join(root, "first");
    const secondParent = path.join(root, "second");
    await Promise.all([fs.mkdir(firstParent), fs.mkdir(secondParent)]);
    const firstTarget = path.join(firstParent, "vault.embed.db");
    const secondTarget = path.join(secondParent, "vault.embed.db");
    await fs.writeFile(firstTarget, "db", { mode: 0o600 });
    const preAliasScope = await resolvePersistenceLeaseScope({ targetPath: firstTarget, familyKey: "embed-db" });
    expect(preAliasScope.targetName).toBe("vault.embed.db");
    try {
      await fs.link(firstTarget, secondTarget);
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
      if (code === "EPERM" || code === "EACCES" || code === "ENOTSUP") {
        return ctx.skip("filesystem cannot create hard links");
      }
      throw error;
    }

    await expect(
      acquirePersistenceLease({ targetPath: firstTarget, familyKey: "embed-db", role: "publisher" })
    ).rejects.toBeInstanceOf(PersistenceLeaseIntegrityError);
    await expect(acquirePersistenceLeaseInScope(preAliasScope, { role: "publisher" })).rejects.toBeInstanceOf(
      PersistenceLeaseIntegrityError
    );
    await expect(
      acquirePersistenceLease({ targetPath: secondTarget, familyKey: "embed-db", role: "publisher" })
    ).rejects.toBeInstanceOf(PersistenceLeaseIntegrityError);
    await expect(fs.lstat(path.join(firstParent, ".enquire-mcp-leases"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.lstat(path.join(secondParent, ".enquire-mcp-leases"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves exact parent identities above Number.MAX_SAFE_INTEGER", async () => {
    const { root, targetPath } = await fixture();
    const canonicalRoot = await fs.realpath(root);
    const realLstat = fs.lstat.bind(fs);
    const exactDev = 2n ** 60n + 3n;
    const exactIno = 2n ** 61n + 5n;
    const namespacePaths = new Set<string>();
    let parentReads = 0;
    vi.spyOn(fs, "lstat").mockImplementation(async (filePath, options) => {
      const stats = await realLstat(filePath, options);
      const resolvedPath = path.resolve(filePath.toString());
      if (resolvedPath !== canonicalRoot && !namespacePaths.has(resolvedPath)) return stats;
      if (resolvedPath === canonicalRoot) parentReads++;
      return new Proxy(stats, {
        get(target, property, receiver) {
          if (property === "dev") return exactDev;
          if (property === "ino") {
            const value = Reflect.get(target, property, receiver);
            return resolvedPath === canonicalRoot || typeof value !== "bigint" ? exactIno : value + 2n ** 62n;
          }
          return Reflect.get(target, property, receiver);
        }
      });
    });

    const scope = await resolvePersistenceLeaseScope({ targetPath, familyKey: "embed-db" });
    expect(scope.parentIdentity).toEqual({ dev: exactDev, ino: exactIno });
    await revalidatePersistenceLeaseScope(scope);
    namespacePaths.add(scope.rootDirectory);
    namespacePaths.add(scope.directory);
    const lease = await acquirePersistenceLeaseInScope(scope, { role: "shared" });
    expect(lease.scope.namespaceIdentity?.root.ino).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
    expect(lease.scope.namespaceIdentity?.family.ino).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
    await lease.release();
    expect(parentReads).toBeGreaterThanOrEqual(2);
  });

  it("rejects a zero inode instead of accepting an ambiguous parent identity", async () => {
    const { root, targetPath } = await fixture();
    const canonicalRoot = await fs.realpath(root);
    const realLstat = fs.lstat.bind(fs);
    vi.spyOn(fs, "lstat").mockImplementation(async (filePath, options) => {
      const stats = await realLstat(filePath, options);
      if (path.resolve(filePath.toString()) !== canonicalRoot) return stats;
      return new Proxy(stats, {
        get(target, property, receiver) {
          return property === "ino" ? 0n : Reflect.get(target, property, receiver);
        }
      });
    });

    await expect(resolvePersistenceLeaseScope({ targetPath, familyKey: "embed-db" })).rejects.toThrow(
      /no exact filesystem identity/i
    );
    await expect(fs.lstat(path.join(root, ".enquire-mcp-leases"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("pins parent dev/ino and rejects later operations after rename plus same-path replacement", async () => {
    const { root } = await fixture();
    const parent = path.join(root, "storage");
    const displaced = path.join(root, "storage-original");
    const replacement = path.join(root, "storage-replacement");
    await fs.mkdir(parent);
    const targetPath = path.join(parent, "vault.embed.db");
    const lifetime = await acquirePersistenceLease({ targetPath, familyKey: "embed-db", role: "shared" });

    await fs.rename(parent, displaced);
    await fs.mkdir(parent);
    await expect(revalidatePersistenceLeaseScope(lifetime.scope)).rejects.toBeInstanceOf(
      PersistenceLeaseIntegrityError
    );
    await expect(acquirePersistenceLeaseInScope(lifetime.scope, { role: "publisher" })).rejects.toBeInstanceOf(
      PersistenceLeaseIntegrityError
    );
    expect(await fs.readdir(parent)).toEqual([]);
    const replacementScope = await resolvePersistenceLeaseScope({ targetPath, familyKey: "embed-db" });
    expect(replacementScope.parentIdentity).not.toEqual(lifetime.scope.parentIdentity);

    await fs.rename(parent, replacement);
    await fs.rename(displaced, parent);
    await revalidatePersistenceLeaseScope(lifetime.scope);
    await lifetime.release();
  });

  it.each(["root", "family"] as const)(
    "pins the lease %s directory identity and rejects same-path replacement before gate creation",
    async (component) => {
      const { root, targetPath } = await fixture();
      const lifetime = await acquirePersistenceLease({ targetPath, familyKey: "embed-db", role: "shared" });
      expect(lifetime.scope.namespaceIdentity).toBeDefined();
      const attacked = component === "root" ? lifetime.scope.rootDirectory : lifetime.scope.directory;
      const displaced = path.join(root, `${component}-namespace-original`);
      const replacement = path.join(root, `${component}-namespace-replacement`);

      await fs.rename(attacked, displaced);
      await fs.mkdir(attacked, { mode: 0o700 });
      if (component === "root") await fs.mkdir(lifetime.scope.directory, { mode: 0o700 });

      await expect(revalidatePersistenceLeaseScope(lifetime.scope)).rejects.toBeInstanceOf(
        PersistenceLeaseIntegrityError
      );
      await expect(acquirePersistenceLeaseInScope(lifetime.scope, { role: "eraser" })).rejects.toBeInstanceOf(
        PersistenceLeaseIntegrityError
      );
      await expect(lifetime.release()).rejects.toBeInstanceOf(PersistenceLeaseIntegrityError);
      expect(await fs.readdir(lifetime.scope.directory)).toEqual([]);

      await fs.rename(attacked, replacement);
      await fs.rename(displaced, attacked);
      await Promise.resolve();
      await revalidatePersistenceLeaseScope(lifetime.scope);
      await lifetime.release();
    }
  );

  it("rejects target, namespace, and marker symlinks or special files", async (ctx) => {
    const { root, targetPath } = await fixture();
    const regular = path.join(root, "regular.embed.db");
    const targetAlias = path.join(root, "alias.embed.db");
    await fs.writeFile(regular, "db", { mode: 0o600 });
    try {
      await fs.symlink(regular, targetAlias, "file");
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
      if (code === "EPERM" || code === "EACCES") return ctx.skip("filesystem cannot create symlinks");
      throw error;
    }
    await expect(
      resolvePersistenceLeaseScope({ targetPath: targetAlias, familyKey: "embed-db" })
    ).rejects.toBeInstanceOf(PersistenceLeaseIntegrityError);

    const specialTarget = path.join(root, "directory.embed.db");
    await fs.mkdir(specialTarget);
    await expect(
      resolvePersistenceLeaseScope({ targetPath: specialTarget, familyKey: "embed-db" })
    ).rejects.toBeInstanceOf(PersistenceLeaseIntegrityError);

    const markerFixture = await fixture();
    const initializer = await acquirePersistenceLease({
      targetPath: markerFixture.targetPath,
      familyKey: "embed-db",
      role: "shared"
    });
    const markerScope = initializer.scope;
    await initializer.release();
    const markerSentinel = path.join(markerFixture.root, "marker-sentinel");
    await fs.writeFile(markerSentinel, "not-a-marker", { mode: 0o600 });
    await fs.symlink(
      markerSentinel,
      path.join(markerScope.directory, `lease.shared.999999.${"0".repeat(32)}.json`),
      "file"
    );
    await expect(
      inspectPersistenceLeases({ targetPath: markerFixture.targetPath, familyKey: "embed-db" })
    ).rejects.toBeInstanceOf(PersistenceLeaseIntegrityError);

    const scope = await resolvePersistenceLeaseScope({ targetPath, familyKey: "embed-db" });
    const outside = path.join(root, "outside");
    await fs.mkdir(outside, { mode: 0o700 });
    await fs.symlink(outside, scope.rootDirectory, "dir");
    await expect(acquirePersistenceLease({ targetPath, familyKey: "embed-db", role: "shared" })).rejects.toBeInstanceOf(
      PersistenceLeaseIntegrityError
    );
  });

  it("does not let an older release delete a later replacement marker", async () => {
    const { targetPath } = await fixture();
    const lease = await acquirePersistenceLease({ targetPath, familyKey: "embed-db", role: "shared" });
    const markerPath = path.join(lease.scope.directory, lease.marker.id);
    await fs.unlink(markerPath);
    await fs.writeFile(markerPath, "later-marker\n", { flag: "wx", mode: 0o600 });
    await fs.chmod(markerPath, 0o600);

    await expect(lease.release()).rejects.toBeInstanceOf(PersistenceLeaseIntegrityError);
    expect(await fs.readFile(markerPath, "utf8")).toBe("later-marker\n");
  });

  it("creates private 0700 directories and 0600 authoritative markers", async () => {
    const { targetPath } = await fixture();
    const lease = await acquirePersistenceLease({ targetPath, familyKey: "embed-db", role: "shared" });
    await expect(
      recoverPersistenceLease({
        targetPath,
        familyKey: "embed-db",
        markerId: lease.marker.id,
        assertQuiescent: async () => true
      })
    ).rejects.toBeInstanceOf(PersistenceLeaseRecoveryError);
    if (process.platform !== "win32") {
      const rootMode = (await fs.lstat(lease.scope.rootDirectory)).mode & 0o777;
      const familyMode = (await fs.lstat(lease.scope.directory)).mode & 0o777;
      const markerMode = (await fs.lstat(path.join(lease.scope.directory, lease.marker.id))).mode & 0o777;
      expect({ rootMode, familyMode, markerMode }).toEqual({ rootMode: 0o700, familyMode: 0o700, markerMode: 0o600 });
    }
    await lease.release();
  });
});
