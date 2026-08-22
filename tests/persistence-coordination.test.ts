import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquirePersistenceFamilyLease,
  acquirePersistenceFamilyLeaseInScopes,
  acquirePersistenceNamespaceEraser,
  inspectPersistenceNamespaceLeases,
  recoverPersistenceNamespaceLease,
  resolvePersistenceNamespaceLeaseScope
} from "../src/persistence-coordination.js";
import {
  acquirePersistenceLease,
  drainProcessPersistenceLeaseDebts,
  getProcessPersistenceLeaseDebtStatus,
  inspectPersistenceLeases,
  PersistenceLeaseConflictError,
  PersistenceLeaseIntegrityError,
  PersistenceLeaseOwnershipError,
  PersistenceLeaseRecoveryError,
  recoverPersistenceLease,
  resolvePersistenceLeaseScope
} from "../src/persistence-lease.js";

const childFixture = path.resolve(__dirname, "fixtures", "persistence-coordination-child.mjs");
const roots: string[] = [];
const children = new Set<ChildProcessWithoutNullStreams>();

interface ChildMessage {
  readonly event: "ready" | "released";
}

interface HeldChild {
  readonly process: ChildProcessWithoutNullStreams;
  release(): Promise<void>;
}

function waitForMessage(child: ChildProcessWithoutNullStreams, event: ChildMessage["event"]): Promise<void> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`coordination child timed out waiting for ${event}: ${stderr}`));
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
            resolve();
            return;
          }
        } catch {
          // Ignore non-protocol output; stderr is included on failure.
        }
      }
    };
    const onStderr = (chunk: Buffer): void => {
      stderr += chunk.toString("utf8");
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      reject(new Error(`coordination child exited before ${event}: code=${code}, signal=${signal}, stderr=${stderr}`));
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

async function makeRoot(prefix = "enquire-coordination-"): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
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

async function holdChild(
  mode: "shared" | "publisher" | "eraser" | "namespace-eraser",
  parentPath: string,
  targetPath = "-",
  familyKey = "-"
): Promise<HeldChild> {
  const child = spawn(process.execPath, [childFixture, mode, parentPath, targetPath, familyKey], {
    stdio: ["pipe", "pipe", "pipe"]
  });
  children.add(child);
  await waitForMessage(child, "ready");
  return {
    process: child,
    release: async () => {
      const released = waitForMessage(child, "released");
      child.stdin.write("release\n");
      await released;
      await waitForExit(child);
      children.delete(child);
    }
  };
}

async function bounded<T>(promise: Promise<T>, timeoutMs = 1_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`coordination operation exceeded ${timeoutMs} ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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

describe("two-level persistence coordination", () => {
  it("rejects an unknown family role before creating a missing persistence parent", async () => {
    const root = await makeRoot();
    const missingParent = path.join(root, "missing", "enquire");
    await expect(
      acquirePersistenceFamilyLease({
        targetPath: path.join(missingParent, "state.feedback.json"),
        familyKey: "feedback-v1",
        role: "observer" as never
      })
    ).rejects.toBeInstanceOf(TypeError);
    await expect(fs.lstat(missingParent)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates a missing target parent privately without chmodding an existing custom parent", async () => {
    const root = await makeRoot();
    const freshParent = path.join(root, "fresh", "enquire");
    const fresh = await acquirePersistenceFamilyLease({
      targetPath: path.join(freshParent, "state.feedback.json"),
      familyKey: "feedback-v1",
      role: "shared"
    });
    expect((await fs.stat(freshParent)).mode & 0o077).toBe(0);
    await fresh.release();

    const customParent = path.join(root, "custom");
    await fs.mkdir(customParent, { mode: 0o750 });
    await fs.chmod(customParent, 0o750);
    const custom = await acquirePersistenceFamilyLease({
      targetPath: path.join(customParent, "state.feedback.json"),
      familyKey: "feedback-v1",
      role: "shared"
    });
    expect((await fs.stat(customParent)).mode & 0o777).toBe(0o750);
    await custom.release();
  });

  it("lets distinct families share one parent while both causally block its namespace eraser", async () => {
    const parent = await makeRoot();
    const otherParent = await makeRoot("enquire-coordination-other-");
    const first = await holdChild("shared", parent, path.join(parent, "a.feedback.json"), "feedback-v1");
    const second = await holdChild("shared", parent, path.join(parent, "b.embed.db"), "embed-db");

    await expect(acquirePersistenceNamespaceEraser({ parentPath: parent })).rejects.toBeInstanceOf(
      PersistenceLeaseConflictError
    );
    const unrelated = await acquirePersistenceNamespaceEraser({ parentPath: otherParent });
    await unrelated.release();

    await first.release();
    await expect(acquirePersistenceNamespaceEraser({ parentPath: parent })).rejects.toBeInstanceOf(
      PersistenceLeaseConflictError
    );
    await second.release();
    const eraser = await acquirePersistenceNamespaceEraser({ parentPath: parent });
    await eraser.release();
  });

  it("makes a held namespace eraser reject every new family role before an inner marker exists", async () => {
    const parent = await makeRoot();
    const targetPath = path.join(parent, "state.feedback.json");
    const eraser = await holdChild("namespace-eraser", parent);

    for (const role of ["shared", "publisher", "eraser"] as const) {
      await expect(
        bounded(acquirePersistenceFamilyLease({ targetPath, familyKey: "feedback-v1", role }))
      ).rejects.toBeInstanceOf(PersistenceLeaseConflictError);
    }
    const familyScope = await resolvePersistenceLeaseScope({ targetPath, familyKey: "feedback-v1" });
    await expect(fs.lstat(familyScope.directory)).rejects.toMatchObject({ code: "ENOENT" });

    await eraser.release();
    const lifetime = await acquirePersistenceFamilyLease({ targetPath, familyKey: "feedback-v1", role: "shared" });
    await lifetime.release();
  });

  it("exposes both exact scopes for operator recovery and refuses a live namespace owner", async () => {
    const parent = await makeRoot("enquire-coordination-operator-recovery-");
    const targetPath = path.join(parent, "state.feedback.json");
    const familyKey = "feedback-v1";
    const held = await holdChild("shared", parent, targetPath, familyKey);
    const liveNamespace = await inspectPersistenceNamespaceLeases(parent);
    const liveNamespaceMarker = liveNamespace.leases[0];
    if (!liveNamespaceMarker) throw new Error("expected the child namespace marker");
    let liveQuiescenceCalls = 0;
    await expect(
      recoverPersistenceNamespaceLease({
        parentPath: parent,
        markerId: liveNamespaceMarker.id,
        assertQuiescent: async () => {
          liveQuiescenceCalls += 1;
          return true;
        }
      })
    ).rejects.toBeInstanceOf(PersistenceLeaseRecoveryError);
    expect(liveQuiescenceCalls, "liveness must fail before trusting operator quiescence").toBe(0);

    held.process.kill("SIGKILL");
    await waitForExit(held.process);
    children.delete(held.process);

    const family = await inspectPersistenceLeases({ targetPath, familyKey });
    const familyMarker = family.leases[0];
    if (!familyMarker) throw new Error("expected the child family marker");
    await recoverPersistenceLease({
      targetPath,
      familyKey,
      markerId: familyMarker.id,
      assertQuiescent: async ({ scope }) => scope.directory === family.scope.directory
    });

    const crashedNamespace = await inspectPersistenceNamespaceLeases(parent);
    const crashedNamespaceMarker = crashedNamespace.leases[0];
    if (!crashedNamespaceMarker) throw new Error("expected the crashed child namespace marker");
    await recoverPersistenceNamespaceLease({
      parentPath: parent,
      markerId: crashedNamespaceMarker.id,
      assertQuiescent: async ({ scope }) => scope.directory === crashedNamespace.scope.directory
    });

    expect((await inspectPersistenceLeases({ targetPath, familyKey })).leases).toEqual([]);
    expect((await inspectPersistenceNamespaceLeases(parent)).leases).toEqual([]);
  });

  it.each(["namespace", "family"] as const)(
    "pins the composite %s directory and fails closed after rename plus same-path replacement",
    async (component) => {
      const parent = await makeRoot();
      const targetPath = path.join(parent, "state.feedback.json");
      const lifetime = await acquirePersistenceFamilyLease({ targetPath, familyKey: "feedback-v1", role: "shared" });
      const attacked = lifetime.scopes[component].directory;
      const displaced = path.join(parent, `${component}-original`);
      const replacement = path.join(parent, `${component}-replacement`);

      await fs.rename(attacked, displaced);
      await fs.mkdir(attacked, { mode: 0o700 });
      await expect(
        acquirePersistenceFamilyLeaseInScopes(lifetime.scopes, { role: "publisher" })
      ).rejects.toBeInstanceOf(PersistenceLeaseIntegrityError);
      await expect(lifetime.release()).rejects.toBeInstanceOf(PersistenceLeaseIntegrityError);
      expect(await fs.readdir(attacked)).toEqual([]);

      await fs.rename(attacked, replacement);
      await fs.rename(displaced, attacked);
      await Promise.resolve();
      await lifetime.release();
    }
  );

  it("rolls back the outer marker after bounded inner conflict instead of deadlocking", async () => {
    const parent = await makeRoot();
    const targetPath = path.join(parent, "state.feedback.json");
    const rawFamilyEraser = await acquirePersistenceLease({
      targetPath,
      familyKey: "feedback-v1",
      role: "eraser"
    });

    await expect(
      bounded(acquirePersistenceFamilyLease({ targetPath, familyKey: "feedback-v1", role: "shared" }))
    ).rejects.toBeInstanceOf(PersistenceLeaseConflictError);
    const namespace = await inspectPersistenceNamespaceLeases(parent);
    expect(namespace.leases).toEqual([]);

    await rawFamilyEraser.release();
    const lifetime = await bounded(
      acquirePersistenceFamilyLease({ targetPath, familyKey: "feedback-v1", role: "shared" })
    );
    await lifetime.release();
  });

  it("retains the exact outer namespace owner when inner acquire and rollback both fail", async () => {
    const parent = await makeRoot();
    const targetPath = path.join(parent, "state.feedback.json");
    const rawFamilyEraser = await acquirePersistenceLease({
      targetPath,
      familyKey: "feedback-v1",
      role: "eraser"
    });
    const namespaceScope = await resolvePersistenceNamespaceLeaseScope(parent);
    const realUnlink = fs.unlink.bind(fs);
    let namespaceRollbackFaults = 0;
    vi.spyOn(fs, "unlink").mockImplementation(async (filePath) => {
      const candidate = filePath.toString();
      if (
        path.dirname(candidate) === namespaceScope.directory &&
        path.basename(candidate).startsWith("lease.shared.")
      ) {
        namespaceRollbackFaults++;
        throw Object.assign(new Error("injected namespace rollback failure"), { code: "EIO" });
      }
      return realUnlink(filePath);
    });

    const failure = await ownershipFailure(
      bounded(acquirePersistenceFamilyLease({ targetPath, familyKey: "feedback-v1", role: "shared" }))
    );
    expect(namespaceRollbackFaults).toBe(1);
    expect(failure.causes[0]).toBeInstanceOf(PersistenceLeaseConflictError);
    expect(failure.causes[1]).toBeDefined();
    expect(failure.debtOwner.artifacts).toHaveLength(1);
    expect(failure.debtOwner.artifacts[0]?.scope.directory).toBe(namespaceScope.directory);
    expect(getProcessPersistenceLeaseDebtStatus()).toMatchObject({ ownerCount: 1, artifactCount: 1 });

    vi.restoreAllMocks();
    const retained = await inspectPersistenceNamespaceLeases(parent);
    expect(retained.gate).toBeNull();
    expect(retained.leases.map((marker) => marker.role)).toEqual(["shared"]);
    const namespaceEraser = await acquirePersistenceNamespaceEraser({ parentPath: parent });
    expect(getProcessPersistenceLeaseDebtStatus()).toMatchObject({ ownerCount: 0, artifactCount: 0 });
    await failure.debtOwner.release();
    await namespaceEraser.release();
    expect((await inspectPersistenceNamespaceLeases(parent)).leases).toEqual([]);
    await rawFamilyEraser.release();
  });

  it("drains a discarded composed family debt in inner-to-namespace order", async () => {
    const parent = await makeRoot();
    const targetPath = path.join(parent, "state.feedback.json");
    const familyScope = await resolvePersistenceLeaseScope({ targetPath, familyKey: "feedback-v1" });
    const namespaceScope = await resolvePersistenceNamespaceLeaseScope(parent);
    const realLink = fs.link.bind(fs);
    const realUnlink = fs.unlink.bind(fs);
    let innerLinked = false;
    vi.spyOn(fs, "link").mockImplementation(async (existingPath, newPath) => {
      await realLink(existingPath, newPath);
      const candidate = newPath.toString();
      if (
        path.dirname(candidate) === familyScope.directory &&
        path.basename(candidate).startsWith("lease.publisher.")
      ) {
        innerLinked = true;
      }
    });
    vi.spyOn(fs, "unlink").mockImplementation(async (filePath) => {
      const candidate = filePath.toString();
      const basename = path.basename(candidate);
      if (
        innerLinked &&
        path.dirname(candidate) === familyScope.directory &&
        (basename.startsWith("lease.publisher.") || basename.startsWith(".candidate."))
      ) {
        throw Object.assign(new Error("injected inner family ownership failure"), { code: "EIO" });
      }
      return realUnlink(filePath);
    });

    await acquirePersistenceFamilyLease({ targetPath, familyKey: "feedback-v1", role: "publisher" }).catch(
      (error: unknown) => {
        expect(error).toBeInstanceOf(PersistenceLeaseOwnershipError);
      }
    );
    expect(getProcessPersistenceLeaseDebtStatus()).toMatchObject({ ownerCount: 1, artifactCount: 4 });

    vi.restoreAllMocks();
    const authoritativeReleaseOrder: string[] = [];
    vi.spyOn(fs, "unlink").mockImplementation(async (filePath) => {
      const candidate = filePath.toString();
      const basename = path.basename(candidate);
      if (basename.startsWith("lease.")) {
        if (path.dirname(candidate) === familyScope.directory) authoritativeReleaseOrder.push("inner");
        if (path.dirname(candidate) === namespaceScope.directory) authoritativeReleaseOrder.push("namespace");
      }
      return realUnlink(filePath);
    });

    const acquired = await acquirePersistenceFamilyLease({
      targetPath,
      familyKey: "feedback-v1",
      role: "publisher"
    });
    expect(authoritativeReleaseOrder.slice(0, 2)).toEqual(["inner", "namespace"]);
    expect(getProcessPersistenceLeaseDebtStatus()).toMatchObject({ ownerCount: 0, artifactCount: 0 });
    await acquired.release();
  });
});
