// v3.12.0-rc.2 — first-run orchestration contract.
//
// Pure plan/executor tests prove exact argument propagation, preview gating,
// ordered apply, and stop/resume behavior. Dist-level tests prove the default
// preview and basic apply paths do not create index/model-cache state.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { access, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildFirstRunPlan,
  executeFirstRunPlan,
  type FirstRunPlanInput,
  type FirstRunStepId,
  renderFirstRunStep
} from "../src/first-run.js";

const invocation = {
  command: "/usr/bin/node",
  argsPrefix: ["/opt/enquire runtime/dist/index.js"]
};
const base: FirstRunPlanInput = {
  vault: "/abs/My Vault",
  tier: "hybrid",
  client: "cursor",
  name: "obsidian",
  http: false,
  excludeGlobs: ["Private/**", "semi;colon/**"],
  readPaths: ["Projects/**", "O'Brien.md"],
  invocation
};

describe("first-run plan", () => {
  it("builds one exact hybrid-live configure → setup → reranker → doctor chain", () => {
    const plan = buildFirstRunPlan({
      ...base,
      tier: "hybrid-live",
      embeddingModel: "bge",
      quantizeEmbeddings: "int8"
    });
    expect(plan.steps.map((step) => step.id)).toEqual(["configure", "setup", "reranker", "doctor"]);
    expect(plan.steps.every((step) => step.command === invocation.command)).toBe(true);
    expect(plan.steps.every((step) => step.args[0] === invocation.argsPrefix[0])).toBe(true);

    const configure = plan.steps[0];
    expect(configure?.args).toEqual([
      invocation.argsPrefix[0],
      "configure",
      "--vault",
      "/abs/My Vault",
      "--tier",
      "hybrid-live",
      "--name",
      "obsidian",
      "--client",
      "cursor",
      "--exclude-glob",
      "Private/**",
      "semi;colon/**",
      "--read-paths",
      "Projects/**",
      "O'Brien.md"
    ]);
    const setup = plan.steps[1];
    expect(setup?.args).toContain("--include-pdfs");
    expect(setup?.args).toContain("bge");
    expect(setup?.args).toContain("int8");
    expect(setup?.args.slice(-6)).toEqual([
      "--exclude-glob",
      "Private/**",
      "semi;colon/**",
      "--read-paths",
      "Projects/**",
      "O'Brien.md"
    ]);
    expect(plan.steps[2]?.args.slice(-2)).toEqual(["install-model", "rerank-bge"]);
    expect(plan.steps[3]?.args).toContain("hybrid-live");
    expect(plan.previewCommand.args).not.toContain("--apply");
    expect(plan.applyCommand.args.at(-1)).toBe("--apply");
    expect(renderFirstRunStep(setup ?? plan.steps[0] ?? plan.applyCommand)).toContain("'semi;colon/**'");
  });

  it("NEGATIVE control — basic tier omits every index/model acquisition step", () => {
    const plan = buildFirstRunPlan({ ...base, tier: "basic" });
    expect(plan.steps.map((step) => step.id)).toEqual(["configure", "doctor"]);
    const flattened = plan.steps.flatMap((step) => step.args);
    expect(flattened).not.toContain("setup");
    expect(flattened).not.toContain("install-model");
    expect(flattened).not.toContain("--include-pdfs");
    expect(plan.steps.every((step) => step.mutatesLocalState === false)).toBe(true);
  });
});

describe("first-run executor", () => {
  it("preview executes only configure and explicitly skips the remaining plan", async () => {
    const plan = buildFirstRunPlan(base);
    const ran: FirstRunStepId[] = [];
    const result = await executeFirstRunPlan(plan, false, async (step) => {
      ran.push(step.id);
      return 0;
    });
    expect(result).toEqual({
      ok: true,
      completed: ["configure"],
      skipped: ["setup", "reranker", "doctor"]
    });
    expect(ran).toEqual(["configure"]);
  });

  it("apply executes every step in order", async () => {
    const plan = buildFirstRunPlan(base);
    const ran: FirstRunStepId[] = [];
    const result = await executeFirstRunPlan(plan, true, async (step) => {
      ran.push(step.id);
      return 0;
    });
    expect(result.ok).toBe(true);
    expect(ran).toEqual(["configure", "setup", "reranker", "doctor"]);
  });

  it("NEGATIVE control — a failed setup stops before downloads/doctor and preserves the ledger", async () => {
    const plan = buildFirstRunPlan(base);
    const ran: FirstRunStepId[] = [];
    const result = await executeFirstRunPlan(plan, true, async (step) => {
      ran.push(step.id);
      return step.id === "setup" ? 7 : 0;
    });
    expect(result).toMatchObject({
      ok: false,
      completed: ["configure"],
      skipped: [],
      failedStep: { id: "setup" },
      exitCode: 7
    });
    expect(ran).toEqual(["configure", "setup"]);
  });

  it("normalizes a runner launch exception into a resumable failure", async () => {
    const plan = buildFirstRunPlan(base);
    const result = await executeFirstRunPlan(plan, true, async () => {
      throw new Error("spawn ENOENT");
    });
    expect(result).toMatchObject({
      ok: false,
      completed: [],
      failedStep: { id: "configure" },
      exitCode: 1,
      error: "spawn ENOENT"
    });
  });
});

const distEntry = path.resolve("dist/index.js");
const tempRoots: string[] = [];

async function makeVault(): Promise<{ root: string; vault: string; cache: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "enquire-first-run-"));
  tempRoots.push(root);
  const vault = path.join(root, "Vault ; safe");
  await mkdir(vault);
  await writeFile(path.join(vault, "Note.md"), "# Note\n\nhello\n", "utf8");
  return { root, vault, cache: path.join(root, "cache") };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("first-run CLI E2E (built dist)", () => {
  it("default hybrid-live preview renders the exact plan without creating local state", async (ctx) => {
    if (!existsSync(distEntry)) return ctx.skip();
    const { root, vault, cache } = await makeVault();
    const vaultAlias = path.join(root, "Vault alias");
    await symlink(vault, vaultAlias, "dir");
    const sentinel = path.join(root, "SHOULD_NOT_EXIST");
    const dangerousLiteral = `$(touch ${sentinel})/**`;
    const result = spawnSync(
      process.execPath,
      [
        distEntry,
        "first-run",
        "--vault",
        vaultAlias,
        "--tier",
        "hybrid-live",
        "--client",
        "cursor",
        "--exclude-glob",
        dangerousLiteral,
        "--read-paths",
        "**/*.md"
      ],
      {
        encoding: "utf8",
        env: { ...process.env, XDG_CACHE_HOME: cache }
      }
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("first-run — preview (hybrid-live)");
    expect(result.stdout).toContain("# enquire-mcp configure");
    expect(result.stdout).toContain("Planned after explicit --apply");
    expect(result.stdout).toContain("install-model rerank-bge");
    expect(result.stdout).toContain("doctor --tier hybrid-live");
    expect(result.stdout).toContain("--include-pdfs");
    expect(result.stdout).toContain(dangerousLiteral);
    expect(result.stdout).toContain(vault);
    expect(result.stdout).not.toContain(vaultAlias);
    expect(await readdir(vault)).toEqual(["Note.md"]);
    await expect(access(cache)).rejects.toThrow();
    await expect(access(sentinel)).rejects.toThrow();
  });

  it("basic --apply completes configure + doctor without index/model-cache writes", async (ctx) => {
    if (!existsSync(distEntry)) return ctx.skip();
    const { vault, cache } = await makeVault();
    const result = spawnSync(
      process.execPath,
      [
        distEntry,
        "first-run",
        "--vault",
        vault,
        "--tier",
        "basic",
        "--client",
        "cursor",
        "--exclude-glob",
        "Private/**",
        "--read-paths",
        "*.md",
        "--apply"
      ],
      {
        encoding: "utf8",
        env: { ...process.env, XDG_CACHE_HOME: cache }
      }
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("first-run — apply (basic)");
    expect(result.stdout).toContain("READY for basic");
    expect(result.stdout).toContain("✓ first-run complete");
    expect(result.stdout).not.toContain("Build the FTS5 and embedding indexes");
    expect(result.stdout).not.toContain("Cache the verified reranker model");
    expect(result.stdout).toContain("--exclude-glob 'Private/**' --read-paths '*.md'");
    await expect(access(cache)).rejects.toThrow();
  });

  it("NEGATIVE control — invalid setup options fail before configure or local-state access", async (ctx) => {
    if (!existsSync(distEntry)) return ctx.skip();
    const { vault, cache } = await makeVault();
    const result = spawnSync(
      process.execPath,
      [distEntry, "first-run", "--vault", vault, "--embedding-model", "unsupported-model"],
      {
        encoding: "utf8",
        env: { ...process.env, XDG_CACHE_HOME: cache }
      }
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("invalid setup option");
    expect(result.stderr).toContain("Unknown embedding model alias");
    expect(result.stdout).not.toContain("# enquire-mcp configure");
    await expect(access(cache)).rejects.toThrow();
  });
});
