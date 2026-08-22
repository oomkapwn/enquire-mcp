import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FeedbackStore, MAX_FEEDBACK_FILE_BYTES } from "../src/feedback.js";
import {
  acquirePersistenceNamespaceEraser,
  inspectPersistenceNamespaceLeases
} from "../src/persistence-coordination.js";
import {
  getProcessPersistenceLeaseDebtStatus,
  inspectPersistenceLeases,
  PersistenceLeaseConflictError,
  PersistenceLeaseIntegrityError
} from "../src/persistence-lease.js";

const childFixture = path.resolve(__dirname, "fixtures", "feedback-record-child.mjs");
const roots: string[] = [];
const children = new Set<ChildProcessWithoutNullStreams>();
const feedbackStores = new Set<FeedbackStore>();

interface ChildMessage {
  readonly event: "ready" | "done";
  readonly recorded?: number;
  readonly size?: number;
}

function waitForMessage(child: ChildProcessWithoutNullStreams, event: ChildMessage["event"]): Promise<ChildMessage> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`feedback child timed out waiting for ${event}: ${stderr}`));
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
          // Ignore non-protocol output; stderr is reported if the child exits.
        }
      }
    };
    const onStderr = (chunk: Buffer): void => {
      stderr += chunk.toString("utf8");
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      reject(new Error(`feedback child exited before ${event}: code=${code}, signal=${signal}, stderr=${stderr}`));
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

async function makeRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function openFeedbackStore(file: string, vaultRoot?: string): Promise<FeedbackStore> {
  const store = await FeedbackStore.open(file, vaultRoot);
  feedbackStores.add(store);
  return store;
}

async function spawnRecorder(file: string, relPath: string, nowIso: string): Promise<ChildProcessWithoutNullStreams> {
  const child = spawn(process.execPath, [childFixture, file, relPath, nowIso], {
    stdio: ["pipe", "pipe", "pipe"]
  });
  children.add(child);
  await waitForMessage(child, "ready");
  return child;
}

afterEach(async () => {
  for (const child of children) child.kill("SIGKILL");
  await Promise.all([...children].map(waitForExit));
  children.clear();
  for (const store of [...feedbackStores].reverse()) await store.close();
  feedbackStores.clear();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("FeedbackStore cross-process persistence", () => {
  it("fails open closed while a parent-wide namespace eraser is active", async () => {
    const root = await makeRoot("enquire-feedback-open-conflict-");
    const file = path.join(root, "state.feedback.json");
    const eraser = await acquirePersistenceNamespaceEraser({ parentPath: root });
    await expect(FeedbackStore.open(file)).rejects.toBeInstanceOf(PersistenceLeaseConflictError);
    await eraser.release();
    const store = await openFeedbackStore(file);
    expect(store.size()).toBe(0);
  });

  it("merges two stale-open process increments under one fixed feedback publisher family", async () => {
    const root = await makeRoot("enquire-feedback-process-");
    const file = path.join(root, "state.feedback.json");
    const first = await spawnRecorder(file, "Shared.md", "2026-08-21T00:00:00.000Z");
    const second = await spawnRecorder(file, "Shared.md", "2026-08-21T00:00:01.000Z");
    const firstDone = waitForMessage(first, "done");
    const secondDone = waitForMessage(second, "done");
    first.stdin.write("record\n");
    second.stdin.write("record\n");
    const [firstResult, secondResult] = await Promise.all([firstDone, secondDone]);
    await Promise.all([waitForExit(first), waitForExit(second)]);
    children.delete(first);
    children.delete(second);

    expect(firstResult.recorded).toBe(1);
    expect(secondResult.recorded).toBe(1);
    const persisted = JSON.parse(await fs.readFile(file, "utf8")) as {
      entries: Record<string, { useful: number; notUseful: number }>;
    };
    expect(persisted.entries["Shared.md"]).toMatchObject({ useful: 2, notUseful: 0 });
    const reopened = await openFeedbackStore(file);
    expect(reopened.scores().get("Shared.md")).toBeCloseTo(2 / 3, 10);
    await reopened.close();
    const leaseState = await inspectPersistenceLeases({ targetPath: file, familyKey: "feedback-v1" });
    expect({ gate: leaseState.gate, leases: leaseState.leases, candidates: leaseState.candidates }).toEqual({
      gate: null,
      leases: [],
      candidates: []
    });
  });

  it("reports a durable tally once when publisher cleanup is deferred, then drains it before the next write", async () => {
    const root = await makeRoot("enquire-feedback-post-commit-cleanup-");
    const file = path.join(root, "state.feedback.json");
    const store = await openFeedbackStore(file);
    const realUnlink = fs.unlink.bind(fs);
    let injected = false;
    const unlinkSpy = vi.spyOn(fs, "unlink").mockImplementation(async (candidate) => {
      if (!injected && path.basename(String(candidate)).startsWith("lease.publisher.")) {
        injected = true;
        throw Object.assign(new Error("injected publisher cleanup failure"), { code: "EIO" });
      }
      await realUnlink(candidate);
    });
    try {
      await expect(store.record(["Once.md"], true, "2026-08-21T00:00:00.000Z")).resolves.toBe(1);
      const afterCommit = JSON.parse(await fs.readFile(file, "utf8")) as {
        entries: Record<string, { useful: number; notUseful: number }>;
      };
      expect(afterCommit.entries["Once.md"]).toMatchObject({ useful: 1, notUseful: 0 });
      expect(getProcessPersistenceLeaseDebtStatus().ownerCount).toBeGreaterThan(0);

      await expect(store.record(["Next.md"], true, "2026-08-21T00:00:01.000Z")).resolves.toBe(1);
      const afterDrain = JSON.parse(await fs.readFile(file, "utf8")) as {
        entries: Record<string, { useful: number; notUseful: number }>;
      };
      expect(afterDrain.entries["Once.md"]).toMatchObject({ useful: 1, notUseful: 0 });
      expect(afterDrain.entries["Next.md"]).toMatchObject({ useful: 1, notUseful: 0 });
      expect(getProcessPersistenceLeaseDebtStatus()).toMatchObject({ ownerCount: 0, artifactCount: 0 });
    } finally {
      unlinkSpy.mockRestore();
    }
  });

  it("reports a post-rename tally once when fallible scope revalidation fails", async () => {
    const root = await makeRoot("enquire-feedback-post-commit-revalidation-");
    const file = path.join(root, "state.feedback.json");
    const store = await openFeedbackStore(file);
    const internals = store as unknown as { writeOnce(data?: unknown): Promise<void> };
    const realWriteOnce = internals.writeOnce.bind(store);
    const realLstat = fs.lstat.bind(fs);
    let publishCommitted = false;
    let injected = false;
    const writeSpy = vi.spyOn(internals, "writeOnce").mockImplementation(async (data) => {
      await realWriteOnce(data);
      publishCommitted = true;
    });
    const lstatSpy = vi.spyOn(fs, "lstat").mockImplementation(async (candidate, options) => {
      if (publishCommitted && !injected && String(candidate).includes(".enquire-mcp-leases")) {
        injected = true;
        throw Object.assign(new Error("injected post-commit scope revalidation failure"), { code: "EIO" });
      }
      return realLstat(candidate, options);
    });
    try {
      await expect(store.record(["Once.md"], true, "2026-08-21T00:00:00.000Z")).resolves.toBe(1);
      expect(injected).toBe(true);
      const persisted = JSON.parse(await fs.readFile(file, "utf8")) as {
        entries: Record<string, { useful: number; notUseful: number }>;
      };
      expect(persisted.entries["Once.md"]).toMatchObject({ useful: 1, notUseful: 0 });
      expect(store.scores().get("Once.md")).toBeCloseTo(0.5, 10);
    } finally {
      lstatSpy.mockRestore();
      writeSpy.mockRestore();
    }
  });

  it("NEGATIVE control: still rejects a failure before the feedback rename commits", async () => {
    const root = await makeRoot("enquire-feedback-pre-commit-failure-");
    const file = path.join(root, "state.feedback.json");
    const store = await openFeedbackStore(file);
    const internals = store as unknown as { writeOnce(data?: unknown): Promise<void> };
    const writeSpy = vi
      .spyOn(internals, "writeOnce")
      .mockRejectedValueOnce(Object.assign(new Error("injected pre-commit publication failure"), { code: "EIO" }));
    try {
      await expect(store.record(["MustNotLand.md"], true, "2026-08-21T00:00:00.000Z")).rejects.toThrow(
        "injected pre-commit publication failure"
      );
      await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
      expect(store.size()).toBe(0);
      expect(store.scores().has("MustNotLand.md")).toBe(false);
    } finally {
      writeSpy.mockRestore();
    }

    await expect(store.record(["MustNotLand.md"], true, "2026-08-21T00:00:01.000Z")).resolves.toBe(1);
    const persisted = JSON.parse(await fs.readFile(file, "utf8")) as {
      entries: Record<string, { useful: number; notUseful: number }>;
    };
    expect(persisted.entries["MustNotLand.md"]).toMatchObject({ useful: 1, notUseful: 0 });
  });

  it("NEGATIVE control: does not hide publisher cleanup failure when no generation committed", async () => {
    const root = await makeRoot("enquire-feedback-no-commit-cleanup-");
    const file = path.join(root, "state.feedback.json");
    const store = await openFeedbackStore(file);
    const realUnlink = fs.unlink.bind(fs);
    let injected = false;
    const unlinkSpy = vi.spyOn(fs, "unlink").mockImplementation(async (candidate) => {
      if (!injected && path.basename(String(candidate)).startsWith("lease.publisher.")) {
        injected = true;
        throw Object.assign(new Error("injected empty-transaction cleanup failure"), { code: "EIO" });
      }
      await realUnlink(candidate);
    });
    try {
      await expect(store.record(["  "], true, "2026-08-21T00:00:00.000Z")).rejects.toThrow(
        "injected empty-transaction cleanup failure"
      );
      await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
      expect(getProcessPersistenceLeaseDebtStatus().ownerCount).toBeGreaterThan(0);

      await expect(store.record(["Committed.md"], true, "2026-08-21T00:00:01.000Z")).resolves.toBe(1);
      expect(getProcessPersistenceLeaseDebtStatus()).toMatchObject({ ownerCount: 0, artifactCount: 0 });
    } finally {
      unlinkSpy.mockRestore();
    }
  });

  it("reloads after external deletion instead of resurrecting stale in-memory entries", async () => {
    const root = await makeRoot("enquire-feedback-erasure-");
    const file = path.join(root, "state.feedback.json");
    const store = await openFeedbackStore(file);
    await store.record(["Erased.md"], true, "2026-08-21T00:00:00.000Z");
    (store as unknown as { serializedBytes: number }).serializedBytes = MAX_FEEDBACK_FILE_BYTES;
    await fs.unlink(file);

    await store.record(["New.md"], true, "2026-08-21T00:00:01.000Z");
    const persisted = JSON.parse(await fs.readFile(file, "utf8")) as { entries: Record<string, unknown> };
    expect(Object.keys(persisted.entries)).toEqual(["New.md"]);
    expect(store.scores().has("Erased.md")).toBe(false);
    expect(store.scores().get("New.md")).toBeCloseTo(0.5, 10);
  });

  it("does not overwrite a current generation when its publisher reload fails", async () => {
    const root = await makeRoot("enquire-feedback-reload-");
    const file = path.join(root, "state.feedback.json");
    const store = await openFeedbackStore(file);
    await store.record(["Durable.md"], true, "2026-08-21T00:00:00.000Z");
    const before = await fs.readFile(file);
    const statSpy = vi.spyOn(fs, "stat").mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EACCES" }));
    try {
      await expect(store.record(["MustNotCommit.md"], true, "2026-08-21T00:00:01.000Z")).rejects.toThrow("denied");
    } finally {
      statSpy.mockRestore();
    }
    expect(await fs.readFile(file)).toEqual(before);
    expect(store.scores().has("MustNotCommit.md")).toBe(false);
  });

  it("keeps malformed and foreign-root generations byte-identical when strict publisher admission fails", async () => {
    const root = await makeRoot("enquire-feedback-admission-");
    const malformedFile = path.join(root, "malformed.feedback.json");
    await fs.writeFile(malformedFile, "{ current-but-malformed", { mode: 0o600 });
    const malformed = await openFeedbackStore(malformedFile, "/vault/A");
    const malformedBefore = await fs.readFile(malformedFile);
    await expect(malformed.record(["MustNotCommit.md"], true, "2026-08-21T00:00:00.000Z")).rejects.toThrow(
      "Feedback snapshot is not valid JSON"
    );
    expect(await fs.readFile(malformedFile)).toEqual(malformedBefore);

    const foreignFile = path.join(root, "foreign.feedback.json");
    const owner = await openFeedbackStore(foreignFile, "/vault/A");
    await owner.record(["Owner.md"], true, "2026-08-21T00:00:01.000Z");
    const foreign = await openFeedbackStore(foreignFile, "/vault/B");
    const foreignBefore = await fs.readFile(foreignFile);
    await expect(foreign.record(["MustNotCommit.md"], true, "2026-08-21T00:00:02.000Z")).rejects.toThrow(
      "Feedback snapshot failed strict admission"
    );
    expect(await fs.readFile(foreignFile)).toEqual(foreignBefore);
  });

  it("close joins the admitted persist tail and rejects records while and after closing", async () => {
    const root = await makeRoot("enquire-feedback-close-");
    const file = path.join(root, "state.feedback.json");
    const store = await openFeedbackStore(file);
    const realRename = fs.rename.bind(fs);
    let observeRename: (() => void) | undefined;
    let allowRename: (() => void) | undefined;
    const renameObserved = new Promise<void>((resolve) => {
      observeRename = resolve;
    });
    const renameAllowed = new Promise<void>((resolve) => {
      allowRename = resolve;
    });
    const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(to) === store.file) {
        observeRename?.();
        await renameAllowed;
      }
      await realRename(from, to);
    });
    try {
      const admitted = store.record(["Committed.md"], true, "2026-08-21T00:00:00.000Z");
      await renameObserved;
      let closeSettled = false;
      const closing = store.close().then(() => {
        closeSettled = true;
      });
      await expect(store.record(["Rejected.md"], true, "2026-08-21T00:00:01.000Z")).rejects.toThrow(
        "Feedback store is closing or closed"
      );
      await Promise.resolve();
      expect(closeSettled).toBe(false);

      allowRename?.();
      await admitted;
      await closing;
      expect(closeSettled).toBe(true);
      await expect(store.record(["AlsoRejected.md"], true, "2026-08-21T00:00:02.000Z")).rejects.toThrow(
        "Feedback store is closing or closed"
      );
      expect(JSON.parse(await fs.readFile(file, "utf8")).entries).toHaveProperty("Committed.md");
    } finally {
      allowRename?.();
      renameSpy.mockRestore();
    }
  });

  it("keeps a failed close non-writable and retries the exact lifetime release", async () => {
    const root = await makeRoot("enquire-feedback-close-retry-");
    const file = path.join(root, "state.feedback.json");
    const store = await openFeedbackStore(file);
    const lifetime = (store as unknown as { lifetime: { release(): Promise<void> } }).lifetime;
    const realRelease = lifetime.release.bind(lifetime);
    let releaseCalls = 0;
    const releaseSpy = vi.spyOn(lifetime, "release").mockImplementation(async () => {
      releaseCalls += 1;
      if (releaseCalls === 1) throw new Error("injected lifetime release failure");
      await realRelease();
    });
    try {
      await expect(store.close()).rejects.toThrow("injected lifetime release failure");
      await Promise.resolve();
      await expect(store.record(["Rejected.md"], true, "2026-08-21T00:00:00.000Z")).rejects.toThrow(
        "Feedback store is closing or closed"
      );
      await store.close();
      await store.close();
      expect(releaseCalls).toBe(2);
      expect((await inspectPersistenceNamespaceLeases(root)).leases).toEqual([]);
    } finally {
      releaseSpy.mockRestore();
    }
  });

  it("rejects publication when the anchored parent is renamed and replaced", async () => {
    const root = await makeRoot("enquire-feedback-parent-");
    const parent = path.join(root, "state");
    const original = path.join(root, "state-original");
    const replacement = path.join(root, "state-replacement");
    await fs.mkdir(parent);
    const file = path.join(parent, "state.feedback.json");
    const store = await openFeedbackStore(file);

    await fs.rename(parent, original);
    await fs.mkdir(parent);
    await expect(store.record(["Blocked.md"], true, "2026-08-21T00:00:00.000Z")).rejects.toBeInstanceOf(
      PersistenceLeaseIntegrityError
    );
    expect(await fs.readdir(parent)).toEqual([]);

    await fs.rename(parent, replacement);
    await fs.rename(original, parent);
    await store.record(["Committed.md"], true, "2026-08-21T00:00:01.000Z");
    expect(store.scores().get("Committed.md")).toBeCloseTo(0.5, 10);
  });

  it("publishes through the canonical family parent after a lexical directory alias is retargeted", async (ctx) => {
    const root = await makeRoot("enquire-feedback-alias-");
    const firstParent = path.join(root, "first");
    const secondParent = path.join(root, "second");
    const alias = path.join(root, "cache-alias");
    await Promise.all([fs.mkdir(firstParent), fs.mkdir(secondParent)]);
    try {
      await fs.symlink(firstParent, alias, "dir");
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
      if (code === "EPERM" || code === "EACCES") return ctx.skip("filesystem cannot create directory symlinks");
      throw error;
    }

    const lexicalFile = path.join(alias, "state.feedback.json");
    const canonicalFile = path.join(await fs.realpath(firstParent), "state.feedback.json");
    const replacementFile = path.join(secondParent, "state.feedback.json");
    const store = await openFeedbackStore(lexicalFile);
    expect(store.file).toBe(canonicalFile);
    await fs.unlink(alias);
    await fs.symlink(secondParent, alias, "dir");
    await fs.writeFile(replacementFile, "REPLACEMENT_SENTINEL", { mode: 0o600 });

    await store.record(["Canonical.md"], true, "2026-08-21T00:00:00.000Z");
    expect(await fs.readFile(replacementFile, "utf8")).toBe("REPLACEMENT_SENTINEL");
    const canonical = JSON.parse(await fs.readFile(canonicalFile, "utf8")) as { entries: Record<string, unknown> };
    expect(canonical.entries).toHaveProperty("Canonical.md");
  });
});
