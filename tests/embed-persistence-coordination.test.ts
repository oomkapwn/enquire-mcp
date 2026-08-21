import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { EmbedDb } from "../src/embed-db.js";
import { PersistenceLeaseConflictError } from "../src/persistence-lease.js";

const fixture = path.resolve(__dirname, "fixtures", "embed-persistence-child.mjs");
const repoRoot = path.resolve(__dirname, "..");
const children = new Set<ChildProcessWithoutNullStreams>();
const roots: string[] = [];
let canRun = true;

beforeAll(async () => {
  try {
    await import("better-sqlite3");
  } catch {
    canRun = false;
  }
});

function waitFor(child: ChildProcessWithoutNullStreams, event: "ready" | "closed"): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = "";
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`EmbedDb child timeout: ${stderr}`)), 10_000);
    const cleanup = (): void => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.stderr.off("data", onError);
      child.off("exit", onExit);
    };
    const onData = (chunk: Buffer): void => {
      output += chunk.toString("utf8");
      for (const line of output.split("\n")) {
        try {
          if ((JSON.parse(line) as { event?: string }).event === event) {
            cleanup();
            resolve();
          }
        } catch {}
      }
    };
    const onError = (chunk: Buffer): void => {
      stderr += chunk.toString("utf8");
    };
    const onExit = (): void => {
      cleanup();
      reject(new Error(`EmbedDb child exited before ${event}: ${stderr}`));
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onError);
    child.once("exit", onExit);
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once("exit", () => resolve());
  });
}

async function holder(mode: "db" | "context", file: string): Promise<ChildProcessWithoutNullStreams> {
  const child = spawn(process.execPath, [fixture, mode, file], { stdio: ["pipe", "pipe", "pipe"] });
  children.add(child);
  await waitFor(child, "ready");
  return child;
}

afterEach(async () => {
  for (const child of children) child.kill("SIGKILL");
  await Promise.all([...children].map(waitForExit));
  children.clear();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("EmbedDb cross-process semantic-family coordination", () => {
  it("awaits every production request/CLI EmbedDb release and closes clear-cache persistence", async () => {
    const [cliSource, searchSource] = await Promise.all([
      fs.readFile(path.join(repoRoot, "src", "cli.ts"), "utf8"),
      fs.readFile(path.join(repoRoot, "src", "tools", "search.ts"), "utf8")
    ]);
    const lifecycleProblems = (cli: string, search: string): string[] => {
      const problems: string[] = [];
      const cliAwaited = cli.match(/\bawait db\.closeAndRelease\(\);/gu) ?? [];
      const searchAwaited = search.match(/\bawait db\.closeAndRelease\(\);/gu) ?? [];
      if (cliAwaited.length !== 2) problems.push(`expected 2 awaited CLI EmbedDb releases, found ${cliAwaited.length}`);
      if (searchAwaited.length !== 1) {
        problems.push(`expected 1 awaited per-request EmbedDb release, found ${searchAwaited.length}`);
      }
      if (/\bdb\.close\(\);/u.test(cli) || /\bdb\.close\(\);/u.test(search)) {
        problems.push("production EmbedDb owner still uses synchronous close");
      }
      const clearStart = cli.indexOf('.command("clear-cache")');
      const clearEnd = cli.indexOf('.command("clear-index")', clearStart);
      const clearBlock = clearStart < 0 ? "" : cli.slice(clearStart, clearEnd < 0 ? undefined : clearEnd);
      if (!/finally\s*\{\s*await vault\.closePersistence\(\);\s*\}/u.test(clearBlock)) {
        problems.push("clear-cache does not release Vault persistence in finally");
      }
      return problems;
    };

    expect(lifecycleProblems(cliSource, searchSource)).toEqual([]);
    expect(lifecycleProblems(cliSource.replace("await db.closeAndRelease();", "db.close();"), searchSource)).toContain(
      "production EmbedDb owner still uses synchronous close"
    );
    expect(lifecycleProblems(cliSource.replace("await vault.closePersistence();", "void 0;"), searchSource)).toContain(
      "clear-cache does not release Vault persistence in finally"
    );
  });

  it.each(["db", "context"] as const)(
    "live %s lifetime blocks clear byte-for-byte until awaited release",
    async (mode) => {
      if (!canRun) return;
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-embed-holder-"));
      roots.push(root);
      const file = path.join(root, "state.embed.db");
      const child = await holder(mode, file);
      const before = await fs.readFile(file);
      const clearer = new EmbedDb({ file, vaultRoot: "/vault/embed-coordination", modelAlias: "multilingual", dim: 4 });
      await expect(clearer.clearOnDisk()).rejects.toBeInstanceOf(PersistenceLeaseConflictError);
      expect(await fs.readFile(file)).toEqual(before);

      const closed = waitFor(child, "closed");
      child.stdin.write("close\n");
      await closed;
      await waitForExit(child);
      children.delete(child);
      await expect(clearer.clearOnDisk()).resolves.toBe(true);
      await expect(fs.lstat(file)).rejects.toMatchObject({ code: "ENOENT" });
    }
  );

  it("does not steal a killed holder's orphan markers or alter its database bytes", async () => {
    if (!canRun) return;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-embed-orphan-"));
    roots.push(root);
    const file = path.join(root, "state.embed.db");
    const child = await holder("db", file);
    const before = await fs.readFile(file);
    child.kill("SIGKILL");
    await waitForExit(child);
    children.delete(child);

    const clearer = new EmbedDb({ file, vaultRoot: "/vault/embed-coordination", modelAlias: "multilingual", dim: 4 });
    await expect(clearer.clearOnDisk()).rejects.toBeInstanceOf(PersistenceLeaseConflictError);
    await expect(clearer.clearOnDisk()).rejects.toBeInstanceOf(PersistenceLeaseConflictError);
    expect(await fs.readFile(file)).toEqual(before);
  });
});
