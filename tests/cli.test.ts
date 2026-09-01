import { Buffer } from "node:buffer";
import { execFileSync, spawnSync } from "node:child_process";
import { promises as fs, type Stats } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EmbedDb, hnswPersistBase, peekEmbedDbMeta } from "../src/embed-db.js";
import { FeedbackStore } from "../src/feedback.js";
import { defaultIndexFile, peekFtsMetaSafe } from "../src/fts5.js";
import { parsePositiveInt, parseQuantizationMode, prepareServerDeps } from "../src/index.js";
import { acquirePersistenceNamespaceEraser } from "../src/persistence-coordination.js";
import {
  armWatcherActivationGuard,
  releaseWatcherActivationGuard,
  watcherActivationGuardPath
} from "../src/watcher-activation-guard.js";

function mutationFingerprint(stat: Stats) {
  return {
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs
  };
}

describe("parsePositiveInt — CLI numeric flag validation (audit P2-2)", () => {
  it("accepts a positive integer string", () => {
    expect(parsePositiveInt("100", "--max-file-bytes")).toBe(100);
  });

  it("accepts a large integer", () => {
    expect(parsePositiveInt("5242880", "--max-file-bytes")).toBe(5242880);
  });

  it("accepts the caller-supplied inclusive maximum", () => {
    expect(parsePositiveInt("4294967295", "--hnsw-ef", 0xffff_ffff)).toBe(0xffff_ffff);
  });

  it("rejects NaN literal", () => {
    expect(() => parsePositiveInt("NaN", "--max-file-bytes")).toThrow(/positive integer/);
  });

  it("rejects Infinity literal", () => {
    expect(() => parsePositiveInt("Infinity", "--max-file-bytes")).toThrow(/positive integer/);
  });

  it("rejects -Infinity literal", () => {
    expect(() => parsePositiveInt("-Infinity", "--max-file-bytes")).toThrow(/positive integer/);
  });

  it("rejects non-numeric strings", () => {
    expect(() => parsePositiveInt("abc", "--max-file-bytes")).toThrow(/positive integer/);
  });

  it("rejects empty string", () => {
    expect(() => parsePositiveInt("", "--max-file-bytes")).toThrow(/positive integer/);
  });

  it("rejects zero", () => {
    expect(() => parsePositiveInt("0", "--cache-size")).toThrow(/positive integer/);
  });

  it("rejects negative", () => {
    expect(() => parsePositiveInt("-1", "--cache-size")).toThrow(/positive integer/);
  });

  it("rejects non-integer floats", () => {
    expect(() => parsePositiveInt("1.5", "--max-file-bytes")).toThrow(/positive integer/);
  });

  it.each(["9007199254740992", "9007199254740993"])("rejects unsafe integer spelling %s", (raw) => {
    expect(() => parsePositiveInt(raw, "--max-file-bytes")).toThrow(/positive integer/);
  });

  it.each([" 1", "1 ", "+1", "01", "1.0", "1e3", "0x10", "0b10"])(
    "rejects non-canonical decimal spelling %j",
    (raw) => {
      expect(() => parsePositiveInt(raw, "--max-file-bytes")).toThrow(/positive integer/);
    }
  );

  it("rejects a value above the caller-supplied native maximum", () => {
    expect(() => parsePositiveInt("4294967296", "--hnsw-ef", 0xffff_ffff)).toThrow(/4294967295/);
  });

  it.each([0, Number.NaN, Number.POSITIVE_INFINITY, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects an invalid parser maximum %s",
    (maximum) => {
      expect(() => parsePositiveInt("1", "--limit", maximum)).toThrow(
        new TypeError("parsePositiveInt maximum must be a positive safe integer")
      );
    }
  );

  it("includes the flag name in the error", () => {
    expect(() => parsePositiveInt("oops", "--cache-size")).toThrow(/--cache-size/);
  });
});

describe("prepareServerDeps — runtime authority admission", () => {
  it.each([
    ["enableWrite", "false", "a boolean"],
    ["persistentCache", "false", "a boolean"],
    ["watch", 1, "a boolean"],
    ["disabledTools", "obsidian_read_note", "an array of strings"],
    ["enabledTools", "obsidian_read_note", "an array of strings"]
  ] as const)("rejects malformed programmatic option %s before vault I/O", async (name, value, expected) => {
    await expect(
      prepareServerDeps({
        vault: "/not-opened-because-runtime-admission-fails",
        [name]: value
      } as never)
    ).rejects.toThrow(new TypeError(`Serve option ${name} must be ${expected}`));
  });

  it("rejects an explicit empty read-path allowlist before vault I/O", async () => {
    await expect(
      prepareServerDeps({ vault: "/not-opened-because-runtime-admission-fails", readPaths: [] })
    ).rejects.toThrow(new TypeError("Serve option readPaths must not be an empty allowlist"));
  });

  it.each(["disabledTools", "enabledTools"] as const)("rejects empty names in %s before vault I/O", async (name) => {
    await expect(
      prepareServerDeps({
        vault: "/not-opened-because-runtime-admission-fails",
        [name]: [" "]
      })
    ).rejects.toThrow(new TypeError(`Serve option ${name} must contain canonical tool names without outer whitespace`));
  });

  it.each(["readPath", "excludeGlobs", "disabledTool"])(
    "rejects unknown programmatic option %s before vault I/O",
    async (name) => {
      await expect(
        prepareServerDeps({
          vault: "/not-opened-because-runtime-admission-fails",
          [name]: ["Public/**"]
        } as never)
      ).rejects.toThrow(new TypeError(`Unknown serve option ${name}`));
    }
  );
});

describe("parseQuantizationMode — v2.17.0 --quantize-embeddings validation", () => {
  it("returns undefined for undefined input (CLI flag absent)", () => {
    expect(parseQuantizationMode(undefined)).toBeUndefined();
  });

  it("normalizes 'f32' to f32", () => {
    expect(parseQuantizationMode("f32")).toBe("f32");
  });

  it("accepts 'float32' and 'none' as f32 aliases", () => {
    expect(parseQuantizationMode("float32")).toBe("f32");
    expect(parseQuantizationMode("none")).toBe("f32");
  });

  it("normalizes 'int8' to int8", () => {
    expect(parseQuantizationMode("int8")).toBe("int8");
  });

  it("accepts 'q8' and 'i8' as int8 aliases", () => {
    expect(parseQuantizationMode("q8")).toBe("int8");
    expect(parseQuantizationMode("i8")).toBe("int8");
  });

  it("is case-insensitive", () => {
    expect(parseQuantizationMode("INT8")).toBe("int8");
    expect(parseQuantizationMode("F32")).toBe("f32");
    expect(parseQuantizationMode("Float32")).toBe("f32");
  });

  it("trims surrounding whitespace", () => {
    expect(parseQuantizationMode("  int8  ")).toBe("int8");
  });

  it("treats empty string as default f32 (commander emits '' for `--flag ''`)", () => {
    expect(parseQuantizationMode("")).toBe("f32");
  });

  it("rejects unknown modes with the accepted-values list in the error", () => {
    expect(() => parseQuantizationMode("int4")).toThrow(/--quantize-embeddings must be "f32" or "int8"/);
    expect(() => parseQuantizationMode("fp16")).toThrow(/got "fp16"/);
  });

  it("rejects nonsense input", () => {
    expect(() => parseQuantizationMode("yes please")).toThrow(/--quantize-embeddings/);
  });
});

describe("CLI entry-point guard (audit v0.7.5 P0)", () => {
  let tmpdir: string;
  const distEntry = path.resolve(__dirname, "..", "dist", "index.js");

  beforeEach(async () => {
    tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-cli-guard-"));
  });
  afterEach(async () => {
    await fs.rm(tmpdir, { recursive: true, force: true });
  });

  it("invokes main() when run via a symlink (e.g. npm bin shim)", async (ctx) => {
    const exists = await fs
      .stat(distEntry)
      .then(() => true)
      .catch(() => false);
    if (!exists) return ctx.skip(); // dist not built (dev watch) — VISIBLE skip (rc.14); e2e-handlers CI-GUARD asserts dist in CI
    const link = path.join(tmpdir, "enquire-mcp");
    await fs.symlink(distEntry, link);
    const out = execFileSync(process.execPath, [link, "--version"], { encoding: "utf8" });
    expect(out.trim()).toMatch(/^\d+\.\d+\.\d+(-[a-z0-9.]+)?$/);

    const vault = path.join(tmpdir, "vault");
    await fs.mkdir(vault);
    const configured = execFileSync(
      process.execPath,
      [link, "configure", "--vault", vault, "--client", "claude-desktop", "--tier", "basic"],
      { encoding: "utf8" }
    );
    const json = configured.slice(configured.indexOf("{"), configured.lastIndexOf("}") + 1);
    const parsed = JSON.parse(json) as { mcpServers: Record<string, { command: string; args: string[] }> };
    expect(parsed.mcpServers.obsidian?.command).toBe(process.execPath);
    expect(parsed.mcpServers.obsidian?.args[0]).toBe(await fs.realpath(distEntry));
    expect(parsed.mcpServers.obsidian?.args[0]).not.toBe(link);
  });

  it("captures the physical CLI entry once and forbids later argv symlink re-resolution", async () => {
    const indexSource = await fs.readFile(path.resolve(__dirname, "../src/index.ts"), "utf8");
    const cliSource = await fs.readFile(path.resolve(__dirname, "../src/cli.ts"), "utf8");
    const repeatedArgvRealpath = /(?:fs\.)?realpath(?:Sync)?\(\s*process\.argv\[1\]\s*\)/;

    expect(indexSource).toContain("cliInvocation = { command: process.execPath, argsPrefix: [argv] }");
    expect(indexSource).toContain("main(cliInvocation)");
    expect(repeatedArgvRealpath.test(cliSource)).toBe(false);

    // NEGATIVE control: the detector catches the former action-time
    // re-resolution that allowed a symlink retarget after the entry guard.
    expect(repeatedArgvRealpath.test("const entry = await fs.realpath(process.argv[1]);")).toBe(true);
  });

  it("invokes main() when run via /tmp on macOS (which itself is a symlink to /private/tmp)", async (ctx) => {
    const exists = await fs
      .stat(distEntry)
      .then(() => true)
      .catch(() => false);
    if (!exists) return ctx.skip(); // rc.14 — visible skip
    // tmpdir already lives under /tmp on macOS — execFile via /tmp path
    // exercises the same realpath divergence.
    if (process.platform !== "darwin") return ctx.skip(); // only macOS has the /tmp symlink (rc.14 — visible platform skip)
    const out = execFileSync(process.execPath, [distEntry, "--version"], {
      encoding: "utf8",
      cwd: tmpdir
    });
    expect(out.trim()).toMatch(/^\d+\.\d+\.\d+(-[a-z0-9.]+)?$/);
  });
});

describe("CLI subcommands E2E (against built dist/)", () => {
  let tmpdir: string;
  let vault: string;
  let canRunFts5 = true;
  const distEntry = path.resolve(__dirname, "..", "dist", "index.js");

  beforeEach(async () => {
    tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-cli-e2e-"));
    vault = path.join(tmpdir, "vault");
    await fs.mkdir(vault, { recursive: true });
    await fs.writeFile(
      path.join(vault, "Apollo.md"),
      "---\ntitle: Apollo\ntags: [project]\n---\n\nApollo project notes\n\nSecond paragraph mentions rocketry.\n"
    );
    await fs.writeFile(path.join(vault, "Hermes.md"), "---\ntitle: Hermes\n---\n\nHermes is unrelated to Apollo.\n");
    // v2.0.0-beta.1 P2 fix: import success is not enough — the JS package
    // can resolve while the *.node binary fails to load (--ignore-scripts,
    // unsupported platform, broken native build). Probe the constructor
    // against an in-memory DB so canRunFts5 actually reflects whether FTS5
    // tests will succeed. Pre-fix, FTS5 E2E tests ran and emitted scary
    // bindings stack traces from the dist binary.
    try {
      const mod = (await import("better-sqlite3")) as { default?: new (file: string) => { close?: () => void } };
      if (!mod.default) {
        canRunFts5 = false;
      } else {
        const probe = new mod.default(":memory:");
        probe.close?.();
      }
    } catch {
      canRunFts5 = false;
    }
  });
  afterEach(async () => {
    await fs.rm(tmpdir, { recursive: true, force: true });
  });

  function distExists(): boolean {
    try {
      execFileSync(process.execPath, [distEntry, "--version"], { encoding: "utf8" });
      return true;
    } catch {
      return false;
    }
  }

  // v3.9.0-rc.26 (rc.25-audit HIGH-2) — CI-GUARD tripwire. The CLI E2E tests
  // below (incl. the bearer-auth ≥16 security checks and the K-1 FTS5-preservation
  // correctness test) skip via ctx.skip() when dist/ isn't built or FTS5 is
  // unavailable. That's correct for local dev, but it would SILENTLY no-op the
  // entire file in CI if a precondition regressed (e.g. the `prepare` build hook
  // stops running). This tripwire HARD-FAILS in CI if the preconditions vanish,
  // so the skips can never hide a coverage loss. Mirrors the rc.8/rc.23 pattern
  // in security.test.ts / fts5.test.ts / e2e-handlers.test.ts.
  it("CI GUARD — dist/ built + FTS5 available in CI so the CLI E2E + bearer-auth + K-1 tests run", () => {
    if (!process.env.CI) return;
    expect(distExists()).toBe(true);
    expect(canRunFts5).toBe(true);
  });

  it("`enquire-mcp --version` prints the package version", (ctx) => {
    if (!distExists()) return ctx.skip();
    const out = execFileSync(process.execPath, [distEntry, "--version"], { encoding: "utf8" });
    expect(out.trim()).toMatch(/^\d+\.\d+\.\d+(-[a-z0-9.]+)?$/);
  });

  it("`enquire-mcp --help` shows all subcommands (serve / clear-cache / clear-index / index)", (ctx) => {
    if (!distExists()) return ctx.skip();
    const out = execFileSync(process.execPath, [distEntry, "--help"], { encoding: "utf8" });
    // commander's auto-help lists subcommands in a Commands: section.
    expect(out).toContain("serve");
    expect(out).toContain("clear-cache");
    expect(out).toContain("clear-index");
    expect(out).toContain("index");
    expect(out).toContain("configure"); // v3.11.6-rc.4 activation command
    expect(out).toContain("first-run"); // v3.12.0-rc.2 preview/apply orchestrator
    expect(out).toContain("eval-compare");
  });

  it("`eval-compare` accepts a matching improvement and rejects regression or cohort drift", async (ctx) => {
    if (!distExists()) return ctx.skip();
    const fingerprint = `sha256:${"a".repeat(64)}`;
    const result = (label: string, score: number, cohort = fingerprint) => ({
      label,
      k: 10,
      query_count: 1,
      query_errors: 0,
      query_set_fingerprint: cohort,
      per_query: [
        {
          id: "q1",
          query: "Apollo",
          ndcg_at_k: score,
          recall_at_k: score,
          mrr: score,
          hits_relevant: 1,
          hits_total_relevant: 1,
          latency_ms: 1,
          failure_bucket: "hit_rank_1",
          hit_at_1: true,
          hit_at_k: true,
          all_relevant_at_k: true
        }
      ],
      mean_ndcg: score,
      mean_recall: score,
      mean_mrr: score,
      mean_latency_ms: 1,
      total_wall_ms: 1,
      mean_hit_at_1: 1,
      mean_hit_at_k: 1,
      all_rel_at_k: 1
    });
    const baselineFile = path.join(tmpdir, "baseline.json");
    const betterFile = path.join(tmpdir, "better-matrix.json");
    const worseFile = path.join(tmpdir, "worse.json");
    const mismatchFile = path.join(tmpdir, "mismatch.json");
    const malformedFile = path.join(tmpdir, "malformed.json");
    const malformed = {
      ...result("malformed", 0.6),
      mean_ndcg: 2,
      diagnostics: {
        failure_buckets: { hit_rank_1: 0, hit_top_k: 0, miss: 0, no_labels: 0, error: 1 }
      },
      per_query: [
        {
          ...result("malformed", 0.6).per_query[0],
          error: true,
          failure_bucket: "error"
        }
      ]
    };
    await Promise.all([
      fs.writeFile(baselineFile, JSON.stringify(result("baseline", 0.5))),
      // Preserve the previous npm wrapper's matrix behavior: compare the
      // first result when `eval --matrix --output` writes an array.
      fs.writeFile(betterFile, JSON.stringify([result("better", 0.6)])),
      fs.writeFile(worseFile, JSON.stringify(result("worse", 0.4))),
      fs.writeFile(mismatchFile, JSON.stringify(result("mismatch", 0.6, `sha256:${"b".repeat(64)}`))),
      fs.writeFile(malformedFile, JSON.stringify(malformed))
    ]);

    const improved = spawnSync(process.execPath, [distEntry, "eval-compare", baselineFile, betterFile], {
      encoding: "utf8"
    });
    expect(improved.status).toBe(0);
    expect(improved.stdout).toContain("baseline → better");
    expect(improved.stdout).toContain("+0.1000");

    const regressed = spawnSync(process.execPath, [distEntry, "eval-compare", baselineFile, worseFile], {
      encoding: "utf8"
    });
    expect(regressed.status).toBe(1);
    expect(regressed.stdout).toContain("regression");

    const mismatched = spawnSync(process.execPath, [distEntry, "eval-compare", baselineFile, mismatchFile], {
      encoding: "utf8"
    });
    expect(mismatched.status).toBe(1);
    expect(mismatched.stderr).toMatch(/different query cohorts/);

    const invalid = spawnSync(process.execPath, [distEntry, "eval-compare", baselineFile, malformedFile], {
      encoding: "utf8"
    });
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toMatch(/malformed after eval result/);
  });

  // v3.11.6-rc.4 (activation, audit P0) — `configure` prints a ready-to-paste
  // MCP client config for the given vault. Non-destructive (writes nothing).
  it("`configure --vault <v> --client cursor` prints parseable mcpServers JSON, exit 0", async (ctx) => {
    if (!distExists()) return ctx.skip();
    const res = spawnSync(process.execPath, [distEntry, "configure", "--vault", vault, "--client", "cursor"], {
      encoding: "utf8",
      timeout: 15000
    });
    expect(res.status).toBe(0);
    const out = res.stdout ?? "";
    // extract the fenced JSON body and assert it parses with the vault wired in
    const json = out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1);
    const parsed = JSON.parse(json) as { mcpServers: Record<string, { command: string; args: string[] }> };
    expect(parsed.mcpServers.obsidian?.args).toContain(await fs.realpath(vault));
    expect(parsed.mcpServers.obsidian?.command).toBe(process.execPath);
    expect(parsed.mcpServers.obsidian?.args[0]).toBe(distEntry);
    expect(parsed.mcpServers.obsidian?.args).not.toContain("@oomkapwn/enquire-mcp@latest");
    expect(parsed.mcpServers.obsidian?.args).not.toContain("--exclude-glob");
    expect(parsed.mcpServers.obsidian?.args).not.toContain("--read-paths");
  });

  it("`configure` preserves privacy policy in runtime, setup, and doctor commands", (ctx) => {
    if (!distExists()) return ctx.skip();
    const res = spawnSync(
      process.execPath,
      [
        distEntry,
        "configure",
        "--vault",
        vault,
        "--client",
        "cursor",
        "--exclude-glob",
        "Private/**",
        "semi;colon/**",
        "--read-paths",
        "Projects/**"
      ],
      { encoding: "utf8", timeout: 15000 }
    );
    expect(res.status).toBe(0);
    const out = res.stdout ?? "";
    const json = out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1);
    const parsed = JSON.parse(json) as { mcpServers: Record<string, { args: string[] }> };
    const args = parsed.mcpServers.obsidian?.args ?? [];
    expect(args.slice(-5)).toEqual(["--exclude-glob", "Private/**", "semi;colon/**", "--read-paths", "Projects/**"]);
    expect(out.match(/--exclude-glob/g)).toHaveLength(3);
    expect(out.match(/--read-paths/g)).toHaveLength(3);
  });

  it("`configure --tier bogus` fails fast (exit 1) with valid tiers listed", (ctx) => {
    if (!distExists()) return ctx.skip();
    const res = spawnSync(process.execPath, [distEntry, "configure", "--vault", vault, "--tier", "bogus"], {
      encoding: "utf8",
      timeout: 15000
    });
    expect(res.status).toBe(1);
    expect(`${res.stdout ?? ""}${res.stderr ?? ""}`).toMatch(/basic \| hybrid \| hybrid-live/);

    const unsafeName = spawnSync(
      process.execPath,
      [distEntry, "configure", "--vault", vault, "--name", "safe;touch_BAD"],
      { encoding: "utf8", timeout: 15000 }
    );
    expect(unsafeName.status).toBe(1);
    expect(`${unsafeName.stdout ?? ""}${unsafeName.stderr ?? ""}`).toMatch(/invalid --name/);
    expect(unsafeName.stdout ?? "").not.toContain("touch_BAD -- npx");
  });

  it("`configure` rejects invalid vaults/privacy and incompatible HTTP clients before output", async (ctx) => {
    if (!distExists()) return ctx.skip();
    const missing = spawnSync(
      process.execPath,
      [distEntry, "configure", "--vault", path.join(tmpdir, "missing"), "--client", "cursor"],
      { encoding: "utf8", timeout: 15000 }
    );
    expect(missing.status).toBe(1);
    expect(missing.stderr ?? "").toMatch(/Vault not found/);
    expect(missing.stdout ?? "").not.toContain("# enquire-mcp configure");

    const fileVault = spawnSync(
      process.execPath,
      [distEntry, "configure", "--vault", path.join(vault, "Apollo.md"), "--client", "cursor"],
      { encoding: "utf8", timeout: 15000 }
    );
    expect(fileVault.status).toBe(1);
    expect(fileVault.stderr ?? "").toMatch(/not a directory/);

    const invalidPrivacy = spawnSync(
      process.execPath,
      [distEntry, "configure", "--vault", vault, "--client", "cursor", "--exclude-glob", "   "],
      { encoding: "utf8", timeout: 15000 }
    );
    expect(invalidPrivacy.status).toBe(1);
    expect(invalidPrivacy.stderr ?? "").toMatch(/whitespace-only patterns/);
    expect(invalidPrivacy.stdout ?? "").not.toContain("serve --vault");

    if (process.platform !== "win32") {
      const controlVault = path.join(tmpdir, "line\nbreak");
      await fs.mkdir(controlVault);
      const controlPath = spawnSync(
        process.execPath,
        [distEntry, "configure", "--vault", controlVault, "--client", "cursor"],
        { encoding: "utf8", timeout: 15000 }
      );
      expect(controlPath.status).toBe(1);
      expect(controlPath.stderr ?? "").toMatch(/control characters/);
      expect(controlPath.stdout ?? "").not.toContain("# enquire-mcp configure");
    }

    const codexHttp = spawnSync(
      process.execPath,
      [distEntry, "configure", "--vault", vault, "--client", "codex", "--http"],
      { encoding: "utf8", timeout: 15000 }
    );
    expect(codexHttp.status).toBe(1);
    expect(codexHttp.stderr ?? "").toMatch(/--http is incompatible with --client codex/);
    expect(codexHttp.stdout ?? "").not.toContain("[mcp_servers.");
  });

  it("`doctor --tier basic --json` reports basic READY on an unprepared accessible vault", async (ctx) => {
    if (!distExists()) return ctx.skip();
    const cache = path.join(tmpdir, "doctor-cache");
    const res = spawnSync(process.execPath, [distEntry, "doctor", "--vault", vault, "--tier", "basic", "--json"], {
      encoding: "utf8",
      timeout: 30000,
      env: { ...process.env, XDG_CACHE_HOME: cache }
    });
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout ?? "{}") as { tier?: string; ready?: boolean };
    expect(parsed).toMatchObject({ tier: "basic", ready: true });
    expect(
      await fs
        .stat(cache)
        .then(() => true)
        .catch(() => false)
    ).toBe(false);
  });

  it("`doctor` defaults to hybrid and blocks the same unprepared vault", (ctx) => {
    if (!distExists()) return ctx.skip();
    const res = spawnSync(process.execPath, [distEntry, "doctor", "--vault", vault, "--json"], {
      encoding: "utf8",
      timeout: 30000,
      env: { ...process.env, XDG_CACHE_HOME: path.join(tmpdir, "doctor-default-cache") }
    });
    expect(res.status).toBe(1);
    const parsed = JSON.parse(res.stdout ?? "{}") as { tier?: string; ready?: boolean };
    expect(parsed).toMatchObject({ tier: "hybrid", ready: false });
  });

  it("`doctor --tier bogus` fails before probes and creates no cache artifacts", async (ctx) => {
    if (!distExists()) return ctx.skip();
    const cache = path.join(tmpdir, "doctor-invalid-cache");
    const res = spawnSync(process.execPath, [distEntry, "doctor", "--vault", vault, "--tier", "bogus", "--json"], {
      encoding: "utf8",
      timeout: 15000,
      env: { ...process.env, XDG_CACHE_HOME: cache }
    });
    expect(res.status).toBe(1);
    expect(`${res.stdout ?? ""}${res.stderr ?? ""}`).toMatch(/basic \| hybrid \| hybrid-live/);
    expect(
      await fs
        .stat(cache)
        .then(() => true)
        .catch(() => false)
    ).toBe(false);
  });

  it.for([
    { flag: "--index-file", expected: /FTS index file must end exactly in '\.fts5\.db'/ },
    { flag: "--embed-file", expected: /Embedding index file must end exactly in '\.embed\.db'/ }
  ])("`doctor $flag ''` preserves the invalid empty value through CLI admission", async ({ flag, expected }, ctx) => {
    if (!distExists()) return ctx.skip();
    const missingVault = path.join(tmpdir, `doctor-empty-${flag.slice(2)}-vault`);
    const cache = path.join(tmpdir, `doctor-empty-${flag.slice(2)}-cache`);
    const res = spawnSync(process.execPath, [distEntry, "doctor", "--vault", missingVault, flag, "", "--json"], {
      encoding: "utf8",
      timeout: 15000,
      env: { ...process.env, XDG_CACHE_HOME: cache }
    });
    const output = `${res.stdout ?? ""}${res.stderr ?? ""}`;
    expect(res.status).not.toBe(0);
    expect(output).toMatch(expected);
    expect(output).not.toMatch(/Vault not found/);
    expect(
      await fs
        .stat(cache)
        .then(() => true)
        .catch(() => false)
    ).toBe(false);
  });

  it("`doctor --help` documents all tiers and the hybrid default", (ctx) => {
    if (!distExists()) return ctx.skip();
    const out = execFileSync(process.execPath, [distEntry, "doctor", "--help"], { encoding: "utf8" });
    expect(out).toContain("basic (live scan, zero setup)");
    expect(out).toContain("hybrid-live");
    expect(out).toMatch(/Default:\s+hybrid/);
  });

  // v3.10.0-rc.13 (bug-report Issue 3) — install-model now resolves BOTH the
  // embedding and reranker catalogs so the ~110MB cross-encoder can be
  // pre-cached (`install-model rerank-bge`). An unknown alias must fail fast
  // (no download) with BOTH catalogs listed so the naming is unambiguous.
  it("`install-model <bogus>` exits non-zero listing both embedding + reranker aliases", (ctx) => {
    if (!distExists()) return ctx.skip();
    const res = spawnSync(process.execPath, [distEntry, "install-model", "totally-bogus-xyz"], {
      encoding: "utf8",
      timeout: 20000
    });
    expect(res.status).not.toBe(0);
    const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
    expect(out).toMatch(/Embedding aliases/);
    expect(out).toMatch(/reranker aliases/);
    // The default cross-encoder must be offered as a pre-cache target.
    expect(out).toMatch(/rerank-bge/);
  });

  // v3.10.0-rc.14 (bug-report Issue 4) — one-shot CLI search for smoke-tests.
  // The spawn inherits XDG_CACHE_HOME from tests/setup.ts (rc.11 hermetic
  // cache), so it builds its index in the throwaway test cache, not the real one.
  it("`query <text> --vault` runs a hybrid search and prints results", (ctx) => {
    if (!distExists()) return ctx.skip();
    const res = spawnSync(process.execPath, [distEntry, "query", "the", "--vault", vault, "--limit", "3"], {
      encoding: "utf8",
      timeout: 30000
    });
    expect(res.status).toBe(0);
    // Prints a result count line whether or not the vault matched the query.
    expect(res.stdout).toMatch(/result\(s\) for/);
  });

  // v3.10.0-rc.14 (bug-report Issue 8) — `prune` is DRY-RUN by default: it must
  // never delete without --yes. Asserts a clean exit + a preview, never a
  // "removed" line.
  it("`prune --vault` previews by default and deletes nothing", (ctx) => {
    if (!distExists()) return ctx.skip();
    const res = spawnSync(process.execPath, [distEntry, "prune", "--vault", vault], {
      encoding: "utf8",
      timeout: 20000
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/DRY RUN|already clean|no cache directory/);
    expect(res.stdout).not.toMatch(/enquire prune: removed/);
  });

  it("`prune` dry-run does not create a lease namespace or mutate the planned artifact", async (ctx) => {
    if (!distExists()) return ctx.skip();
    const cacheRoot = path.join(tmpdir, "prune-dry-run-root");
    const enquireDir = path.join(cacheRoot, "enquire");
    await fs.mkdir(enquireDir, { recursive: true });
    const keepHash = path.basename(defaultIndexFile(await fs.realpath(vault))).slice(0, 12);
    const otherHash = keepHash === "bbbbbbbbbbbb" ? "cccccccccccc" : "bbbbbbbbbbbb";
    const artifact = path.join(enquireDir, `${otherHash}.json`);
    await fs.writeFile(artifact, "DRY_RUN_SENTINEL", { mode: 0o600 });
    const before = mutationFingerprint(await fs.lstat(artifact));

    const res = spawnSync(process.execPath, [distEntry, "prune", "--vault", vault], {
      encoding: "utf8",
      timeout: 20_000,
      env: { ...process.env, XDG_CACHE_HOME: cacheRoot }
    });
    expect(res.status, `${res.stdout ?? ""}${res.stderr ?? ""}`).toBe(0);
    expect(res.stdout).toMatch(/DRY RUN/);
    expect(mutationFingerprint(await fs.lstat(artifact))).toEqual(before);
    expect(await fs.readFile(artifact, "utf8")).toBe("DRY_RUN_SENTINEL");
    await expect(fs.lstat(path.join(enquireDir, ".enquire-mcp-leases"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.for(["nonempty generated stage"])("`prune --yes` safely removes a %s", async (_fixture, { skip }) => {
    if (!distExists()) {
      skip("dist not built");
      return;
    }
    const cacheRoot = path.join(tmpdir, "prune-cache-root");
    const enquireDir = path.join(cacheRoot, "enquire");
    await fs.mkdir(enquireDir, { recursive: true });
    const keepHash = path.basename(defaultIndexFile(await fs.realpath(vault))).slice(0, 12);
    const otherHash = keepHash === "bbbbbbbbbbbb" ? "cccccccccccc" : "bbbbbbbbbbbb";
    const stage = path.join(enquireDir, `${otherHash}.json.enquire-stage-${"a".repeat(48)}`);
    const sentinel = path.join(cacheRoot, "outside-prune-sentinel.txt");
    await fs.mkdir(stage, { mode: 0o700 });
    await fs.writeFile(path.join(stage, "artifact"), "SENSITIVE_PARSE_CACHE_BYTES", { mode: 0o600 });
    await fs.writeFile(sentinel, "OUTSIDE_SENTINEL");

    const res = spawnSync(process.execPath, [distEntry, "prune", "--vault", vault, "--yes"], {
      encoding: "utf8",
      timeout: 20000,
      env: { ...process.env, XDG_CACHE_HOME: cacheRoot }
    });
    expect(res.status, `${res.stdout ?? ""}${res.stderr ?? ""}`).toBe(0);
    await expect(fs.lstat(stage)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(sentinel, "utf8")).toBe("OUTSIDE_SENTINEL");
  });

  it("`prune --yes` cannot erase a live feedback family, then proceeds after awaited close", async (ctx) => {
    if (!distExists()) return ctx.skip();
    const cacheRoot = path.join(tmpdir, "prune-live-feedback-root");
    const enquireDir = path.join(cacheRoot, "enquire");
    await fs.mkdir(enquireDir, { recursive: true });
    const keepHash = path.basename(defaultIndexFile(await fs.realpath(vault))).slice(0, 12);
    const otherHash = keepHash === "bbbbbbbbbbbb" ? "cccccccccccc" : "bbbbbbbbbbbb";
    const feedbackFile = path.join(enquireDir, `${otherHash}.feedback.json`);
    const store = await FeedbackStore.open(feedbackFile, "/causal/other-vault");
    try {
      await store.record(["Durable.md"], true, "2026-08-21T00:00:00.000Z");
      const before = await fs.readFile(feedbackFile);
      const blocked = spawnSync(process.execPath, [distEntry, "prune", "--vault", vault, "--yes"], {
        encoding: "utf8",
        timeout: 20_000,
        env: { ...process.env, XDG_CACHE_HOME: cacheRoot }
      });
      expect(blocked.status).not.toBe(0);
      expect(`${blocked.stdout ?? ""}${blocked.stderr ?? ""}`).toMatch(/conflicts with active role\(s\): shared/i);
      expect(await fs.readFile(feedbackFile)).toEqual(before);

      await store.close();
      const allowed = spawnSync(process.execPath, [distEntry, "prune", "--vault", vault, "--yes"], {
        encoding: "utf8",
        timeout: 20_000,
        env: { ...process.env, XDG_CACHE_HOME: cacheRoot }
      });
      expect(allowed.status, `${allowed.stdout ?? ""}${allowed.stderr ?? ""}`).toBe(0);
      await expect(fs.lstat(feedbackFile)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await store.close();
    }
  });

  it.for(["reserved directory"])(
    "`prune --yes` refuses an exact %s before deleting any sibling",
    async (_fixture, { skip }) => {
      if (!distExists()) {
        skip("dist not built");
        return;
      }
      const cacheRoot = path.join(tmpdir, "prune-unsafe-shape-root");
      const enquireDir = path.join(cacheRoot, "enquire");
      await fs.mkdir(enquireDir, { recursive: true });
      const keepHash = path.basename(defaultIndexFile(await fs.realpath(vault))).slice(0, 12);
      const otherHash = keepHash === "bbbbbbbbbbbb" ? "cccccccccccc" : "bbbbbbbbbbbb";
      const firstSibling = path.join(enquireDir, `${otherHash}.json`);
      const unsafeDirectory = path.join(enquireDir, `${otherHash}.fts5.db`);
      await fs.writeFile(firstSibling, "PARSE_CACHE_SENTINEL");
      await fs.mkdir(unsafeDirectory);

      const res = spawnSync(process.execPath, [distEntry, "prune", "--vault", vault, "--yes"], {
        encoding: "utf8",
        timeout: 20000,
        env: { ...process.env, XDG_CACHE_HOME: cacheRoot }
      });
      expect(res.status).not.toBe(0);
      expect(`${res.stdout ?? ""}${res.stderr ?? ""}`).toMatch(/not a regular file or symlink leaf/i);
      expect(await fs.readFile(firstSibling, "utf8")).toBe("PARSE_CACHE_SENTINEL");
      expect((await fs.lstat(unsafeDirectory)).isDirectory()).toBe(true);
    }
  );

  it.for(["non-ENOENT unlink failure"])("`prune --yes` exits nonzero on a %s", async (_fixture, { skip }) => {
    if (!distExists()) {
      skip("dist not built");
      return;
    }
    if (process.platform === "win32") {
      skip("POSIX directory write-mode control");
      return;
    }
    const cacheRoot = path.join(tmpdir, "prune-unlink-failure-root");
    const enquireDir = path.join(cacheRoot, "enquire");
    await fs.mkdir(enquireDir, { recursive: true });
    const keepHash = path.basename(defaultIndexFile(await fs.realpath(vault))).slice(0, 12);
    const otherHash = keepHash === "bbbbbbbbbbbb" ? "cccccccccccc" : "bbbbbbbbbbbb";
    const artifact = path.join(enquireDir, `${otherHash}.json`);
    await fs.writeFile(artifact, "UNLINK_FAILURE_SENTINEL");
    const initializer = await acquirePersistenceNamespaceEraser({ parentPath: enquireDir });
    await initializer.release();
    await fs.chmod(enquireDir, 0o500);
    const capabilityProbe = path.join(enquireDir, "write-capability-probe");
    try {
      await fs.writeFile(capabilityProbe, "probe", { flag: "wx" });
      await fs.unlink(capabilityProbe);
      await fs.chmod(enquireDir, 0o700);
      skip("filesystem identity can still write through a mode-0500 directory");
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EACCES" && code !== "EPERM") {
        await fs.chmod(enquireDir, 0o700);
        throw error;
      }
    }
    try {
      const res = spawnSync(process.execPath, [distEntry, "prune", "--vault", vault, "--yes"], {
        encoding: "utf8",
        timeout: 20000,
        env: { ...process.env, XDG_CACHE_HOME: cacheRoot }
      });
      expect(res.status).not.toBe(0);
      expect(`${res.stdout ?? ""}${res.stderr ?? ""}`).toMatch(/Unable to remove a preflighted cache artifact/);
      expect(await fs.readFile(artifact, "utf8")).toBe("UNLINK_FAILURE_SENTINEL");
    } finally {
      await fs.chmod(enquireDir, 0o700);
    }
  });

  // v3.9.0-rc.9 audit — the bearer min-length check now fires in the CLI
  // action (reconciled with startHttpServer's ≥16 throw) so the user gets a
  // friendly hint + clean exit(1) before any server setup. Both branches exit
  // before binding, so spawnSync returns fast.
  it("`serve-http --bearer-token <short>` exits 1 with a ≥16-char hint (NEGATIVE control)", async (ctx) => {
    if (!distExists()) return ctx.skip();
    const rejectedIndex = path.join(tmpdir, "invalid-tokenizer-http.fts5.db");
    const invalidTokenizer = spawnSync(
      process.execPath,
      [
        distEntry,
        "serve-http",
        "--vault",
        vault,
        "--persistent-index",
        "--index-file",
        rejectedIndex,
        "--tokenize",
        "porter",
        "--bearer-token",
        "0123456789abcdef",
        "--port",
        "0"
      ],
      { encoding: "utf8", timeout: 20000 }
    );
    expect(invalidTokenizer.status).not.toBe(0);
    expect(`${invalidTokenizer.stdout ?? ""}${invalidTokenizer.stderr ?? ""}`).toMatch(
      /--tokenize.*unicode61.*trigram.*porter/is
    );
    await expect(fs.stat(rejectedIndex)).rejects.toThrow();

    const rejectedStdioIndex = path.join(tmpdir, "invalid-tokenizer-stdio.fts5.db");
    const invalidStdioTokenizer = spawnSync(
      process.execPath,
      [
        distEntry,
        "serve",
        "--vault",
        vault,
        "--persistent-index",
        "--index-file",
        rejectedStdioIndex,
        "--tokenize",
        "porter"
      ],
      { encoding: "utf8", timeout: 20_000 }
    );
    expect(invalidStdioTokenizer.status).not.toBe(0);
    expect(`${invalidStdioTokenizer.stdout ?? ""}${invalidStdioTokenizer.stderr ?? ""}`).toMatch(
      /--tokenize.*unicode61.*trigram.*porter/is
    );
    await expect(fs.stat(rejectedStdioIndex)).rejects.toThrow();

    const res = spawnSync(process.execPath, [distEntry, "serve-http", "--vault", vault, "--bearer-token", "short"], {
      encoding: "utf8",
      timeout: 20000
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/≥16 chars|must be ≥16/i);
    expect(res.stderr).toContain("gen-token");
  });

  it("`serve-http` with NO bearer token exits 1 with a 'required' message (contrast control)", (ctx) => {
    if (!distExists()) return ctx.skip();
    const res = spawnSync(process.execPath, [distEntry, "serve-http", "--vault", vault], {
      encoding: "utf8",
      timeout: 20000
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/is required/i);
    // The length-specific error must NOT fire when the token is simply absent.
    expect(res.stderr).not.toMatch(/≥16 chars/);
  });

  it("projects raw HTTP-only CLI fields away before strict ServeOptions admission", (ctx) => {
    if (!distExists()) return ctx.skip();
    const missingVault = path.join(tmpdir, "missing-http-cli-projection-vault");
    const res = spawnSync(
      process.execPath,
      [
        distEntry,
        "serve-http",
        "--vault",
        missingVault,
        "--bearer-token-env",
        "ENQUIRE_HTTP_PROJECTION_TOKEN",
        "--port",
        "0",
        "--rate-limit",
        "0",
        "--cors-origin",
        "https://example.com"
      ],
      {
        encoding: "utf8",
        timeout: 20_000,
        env: { ...process.env, ENQUIRE_HTTP_PROJECTION_TOKEN: "0123456789abcdef" }
      }
    );
    const output = `${res.stdout ?? ""}${res.stderr ?? ""}`;
    expect(res.status).not.toBe(0);
    expect(output).toMatch(/Vault not found/);
    expect(output).not.toMatch(/Unknown serve option (?:rateLimit|bearerTokenEnv|corsOrigin)/);
  });

  it("`enquire-mcp clear-cache` reports 'no cache file' when none exists", (ctx) => {
    if (!distExists()) return ctx.skip();
    const cacheFile = path.join(tmpdir, "no-such.json");
    const out = execFileSync(
      process.execPath,
      [distEntry, "clear-cache", "--vault", vault, "--cache-file", cacheFile],
      { encoding: "utf8" }
    );
    expect(out).toContain("no cache file");
  });

  it("`enquire-mcp clear-cache --cache-file` erases after the vault root disappeared", async (ctx) => {
    if (!distExists()) return ctx.skip();
    const cacheFile = path.join(tmpdir, "orphaned-vault-cache.json");
    await fs.writeFile(cacheFile, '{"sentinel":"raw note body"}');
    await fs.rm(vault, { recursive: true, force: true });

    const out = execFileSync(
      process.execPath,
      [distEntry, "clear-cache", "--vault", vault, "--cache-file", cacheFile],
      { encoding: "utf8" }
    );
    expect(out).toContain("removed cache file");
    await expect(fs.lstat(cacheFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("`enquire-mcp clear-index` reports 'no fts5 index' when none exists", (ctx) => {
    if (!distExists()) return ctx.skip();
    const indexFile = path.join(tmpdir, "no-such.fts5.db");
    const out = execFileSync(
      process.execPath,
      [distEntry, "clear-index", "--vault", vault, "--index-file", indexFile],
      { encoding: "utf8" }
    );
    expect(out).toContain("no fts5 index");
  });

  it("query and persistent eval apply the same privacy policy to responses and FTS bytes", async (ctx) => {
    if (!distExists()) return ctx.skip();
    if (!canRunFts5) return ctx.skip();
    await fs.mkdir(path.join(vault, "Public"), { recursive: true });
    await fs.mkdir(path.join(vault, "Private"), { recursive: true });
    await fs.writeFile(path.join(vault, "Public", "Visible.md"), "zephyrprivacy visible evidence\n");
    await fs.writeFile(path.join(vault, "Private", "Secret.md"), "zephyrprivacy forbidden evidence\n");
    const queryIndex = path.join(tmpdir, "query-privacy.fts5.db");
    const queryRun = spawnSync(
      process.execPath,
      [
        distEntry,
        "query",
        "zephyrprivacy",
        "--vault",
        vault,
        "--index-file",
        queryIndex,
        "--read-paths",
        "Public/**",
        "--json"
      ],
      { encoding: "utf8", timeout: 20_000 }
    );
    expect(queryRun.status, queryRun.stderr).toBe(0);
    const queryResult = JSON.parse(queryRun.stdout) as { matches?: Array<{ path?: string }> };
    expect(queryResult.matches?.some((match) => match.path === "Public/Visible.md")).toBe(true);
    expect(queryResult.matches?.some((match) => match.path === "Private/Secret.md")).toBe(false);

    const queriesFile = path.join(tmpdir, "privacy-eval.jsonl");
    const evalIndex = path.join(tmpdir, "eval-privacy.fts5.db");
    await fs.writeFile(
      queriesFile,
      `${JSON.stringify({ id: "privacy", query: "zephyrprivacy", relevant: ["Public/Visible.md"] })}\n`
    );
    const evalRun = spawnSync(
      process.execPath,
      [
        distEntry,
        "eval",
        "--vault",
        vault,
        "--queries",
        queriesFile,
        "--persistent-index",
        "--index-file",
        evalIndex,
        "--read-paths",
        "Public/**",
        "--json"
      ],
      { encoding: "utf8", timeout: 20_000 }
    );
    expect(evalRun.status, evalRun.stderr).toBe(0);

    const Database = (await import("better-sqlite3")).default;
    for (const file of [queryIndex, evalIndex]) {
      const db = new Database(file, { readonly: true, fileMustExist: true });
      try {
        const rows = db.prepare("SELECT DISTINCT rel_path FROM chunks ORDER BY rel_path").all() as Array<{
          rel_path: string;
        }>;
        expect(rows.map((row) => row.rel_path)).toContain("Public/Visible.md");
        expect(rows.map((row) => row.rel_path)).not.toContain("Private/Secret.md");
      } finally {
        db.close();
      }
    }

    // Shared default index: privacy flags must filter hits without deleting
    // rows that a later unfiltered serve/query still needs. Seed the default
    // path with both notes, then re-run query/eval with --read-paths only.
    const sharedIndex = defaultIndexFile(await fs.realpath(vault));
    const seedRun = spawnSync(process.execPath, [distEntry, "query", "zephyrprivacy", "--vault", vault, "--json"], {
      encoding: "utf8",
      timeout: 20_000
    });
    expect(seedRun.status, seedRun.stderr).toBe(0);
    const assertSharedRows = (expectPrivate: boolean) => {
      const db = new Database(sharedIndex, { readonly: true, fileMustExist: true });
      try {
        const rows = db.prepare("SELECT DISTINCT rel_path FROM chunks ORDER BY rel_path").all() as Array<{
          rel_path: string;
        }>;
        const paths = rows.map((row) => row.rel_path);
        expect(paths).toContain("Public/Visible.md");
        if (expectPrivate) expect(paths).toContain("Private/Secret.md");
        else expect(paths).not.toContain("Private/Secret.md");
      } finally {
        db.close();
      }
    };
    assertSharedRows(true);

    const sharedQuery = spawnSync(
      process.execPath,
      [distEntry, "query", "zephyrprivacy", "--vault", vault, "--read-paths", "Public/**", "--json"],
      { encoding: "utf8", timeout: 20_000 }
    );
    expect(sharedQuery.status, sharedQuery.stderr).toBe(0);
    const sharedQueryResult = JSON.parse(sharedQuery.stdout) as { matches?: Array<{ path?: string }> };
    expect(sharedQueryResult.matches?.some((match) => match.path === "Public/Visible.md")).toBe(true);
    expect(sharedQueryResult.matches?.some((match) => match.path === "Private/Secret.md")).toBe(false);
    assertSharedRows(true);

    const sharedExcludeQuery = spawnSync(
      process.execPath,
      [distEntry, "query", "zephyrprivacy", "--vault", vault, "--exclude-glob", "Private/**", "--json"],
      { encoding: "utf8", timeout: 20_000 }
    );
    expect(sharedExcludeQuery.status, sharedExcludeQuery.stderr).toBe(0);
    const sharedExcludeResult = JSON.parse(sharedExcludeQuery.stdout) as { matches?: Array<{ path?: string }> };
    expect(sharedExcludeResult.matches?.some((match) => match.path === "Public/Visible.md")).toBe(true);
    expect(sharedExcludeResult.matches?.some((match) => match.path === "Private/Secret.md")).toBe(false);
    assertSharedRows(true);

    const sharedExplicitDefault = spawnSync(
      process.execPath,
      [
        distEntry,
        "query",
        "zephyrprivacy",
        "--vault",
        vault,
        "--index-file",
        sharedIndex,
        "--read-paths",
        "Public/**",
        "--json"
      ],
      { encoding: "utf8", timeout: 20_000 }
    );
    expect(sharedExplicitDefault.status, sharedExplicitDefault.stderr).toBe(0);
    const sharedExplicitResult = JSON.parse(sharedExplicitDefault.stdout) as { matches?: Array<{ path?: string }> };
    expect(sharedExplicitResult.matches?.some((match) => match.path === "Public/Visible.md")).toBe(true);
    expect(sharedExplicitResult.matches?.some((match) => match.path === "Private/Secret.md")).toBe(false);
    assertSharedRows(true);

    const sharedEval = spawnSync(
      process.execPath,
      [
        distEntry,
        "eval",
        "--vault",
        vault,
        "--queries",
        queriesFile,
        "--persistent-index",
        "--read-paths",
        "Public/**",
        "--json"
      ],
      { encoding: "utf8", timeout: 20_000 }
    );
    expect(sharedEval.status, sharedEval.stderr).toBe(0);
    assertSharedRows(true);

    // Privacy query must not DROP+rebuild a legacy shared default. Seed a
    // physical schema-v5 file (same admission shape as fts5.test.ts) and
    // require the stamp and private row to survive.
    const realVault = await fs.realpath(vault);
    for (const sidecar of [sharedIndex, `${sharedIndex}-wal`, `${sharedIndex}-shm`, `${sharedIndex}-journal`]) {
      await fs.rm(sidecar, { force: true });
    }
    {
      const legacy = new Database(sharedIndex);
      try {
        legacy.exec(`
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE VIRTUAL TABLE chunks USING fts5(
          content,
          title,
          aliases,
          rel_path UNINDEXED,
          chunk_index UNINDEXED,
          line_start UNINDEXED,
          line_end UNINDEXED,
          tags UNINDEXED,
          raw_content UNINDEXED,
          kind UNINDEXED,
          tokenize='unicode61 remove_diacritics 2'
        );
        CREATE TABLE source_state (
          rel_path TEXT PRIMARY KEY,
          mtime_ms INTEGER NOT NULL,
          n_chunks INTEGER NOT NULL,
          kind TEXT NOT NULL DEFAULT 'md',
          indexed_at TEXT NOT NULL
        );
      `);
        const insertMeta = legacy.prepare("INSERT INTO meta VALUES (?, ?)");
        insertMeta.run("schema_version", "5");
        insertMeta.run("vault_root", realVault);
        insertMeta.run("tokenize_mode", "unicode61");
        const insertChunk = legacy.prepare(
          "INSERT INTO chunks (content, title, aliases, rel_path, chunk_index, line_start, line_end, tags, raw_content, kind) VALUES (?, ?, '', ?, 0, 1, 1, '', ?, 'md')"
        );
        insertChunk.run(
          "zephyrprivacy visible evidence",
          "Visible",
          "Public/Visible.md",
          "zephyrprivacy visible evidence"
        );
        insertChunk.run(
          "zephyrprivacy forbidden evidence",
          "Secret",
          "Private/Secret.md",
          "zephyrprivacy forbidden evidence"
        );
        const insertState = legacy.prepare(
          "INSERT INTO source_state (rel_path, mtime_ms, n_chunks, kind, indexed_at) VALUES (?, 1000, 1, 'md', 'now')"
        );
        insertState.run("Public/Visible.md");
        insertState.run("Private/Secret.md");
      } finally {
        legacy.close();
      }
    }
    const legacyQuery = spawnSync(
      process.execPath,
      [distEntry, "query", "zephyrprivacy", "--vault", vault, "--read-paths", "Public/**", "--json"],
      { encoding: "utf8", timeout: 20_000 }
    );
    expect(legacyQuery.status, legacyQuery.stderr).toBe(0);
    const legacyResult = JSON.parse(legacyQuery.stdout) as { matches?: Array<{ path?: string }> };
    expect(legacyResult.matches?.some((match) => match.path === "Public/Visible.md")).toBe(true);
    expect(legacyResult.matches?.some((match) => match.path === "Private/Secret.md")).toBe(false);
    {
      const db = new Database(sharedIndex, { readonly: true, fileMustExist: true });
      try {
        expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: "5" });
        const paths = (
          db.prepare("SELECT DISTINCT rel_path FROM chunks ORDER BY rel_path").all() as Array<{ rel_path: string }>
        ).map((row) => row.rel_path);
        expect(paths).toContain("Public/Visible.md");
        expect(paths).toContain("Private/Secret.md");
      } finally {
        db.close();
      }
    }

    // Missing shared default: privacy query must not CREATE an empty file.
    for (const sidecar of [sharedIndex, `${sharedIndex}-wal`, `${sharedIndex}-shm`, `${sharedIndex}-journal`]) {
      await fs.rm(sidecar, { force: true });
    }
    const missingQuery = spawnSync(
      process.execPath,
      [distEntry, "query", "zephyrprivacy", "--vault", vault, "--read-paths", "Public/**", "--json"],
      { encoding: "utf8", timeout: 20_000 }
    );
    expect(missingQuery.status, missingQuery.stderr).toBe(0);
    const missingResult = JSON.parse(missingQuery.stdout) as { matches?: Array<{ path?: string }> };
    expect(missingResult.matches?.some((match) => match.path === "Public/Visible.md")).toBe(true);
    expect(missingResult.matches?.some((match) => match.path === "Private/Secret.md")).toBe(false);
    await expect(fs.stat(sharedIndex)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("privacy query/eval preserve the shared FTS through a parent symlink alias", async (ctx) => {
    if (!distExists()) return ctx.skip();
    if (!canRunFts5) return ctx.skip();
    await fs.mkdir(path.join(vault, "Public"), { recursive: true });
    await fs.mkdir(path.join(vault, "Private"), { recursive: true });
    await fs.writeFile(path.join(vault, "Public", "Visible.md"), "aliasprivacy visible evidence\n");
    await fs.writeFile(path.join(vault, "Private", "Secret.md"), "aliasprivacy forbidden evidence\n");

    const realVault = await fs.realpath(vault);
    const sharedIndex = defaultIndexFile(realVault);
    const seed = spawnSync(process.execPath, [distEntry, "query", "aliasprivacy", "--vault", vault, "--json"], {
      encoding: "utf8",
      timeout: 20_000
    });
    expect(seed.status, seed.stderr).toBe(0);

    const Database = (await import("better-sqlite3")).default;
    const readPaths = (file: string): string[] => {
      const db = new Database(file, { readonly: true, fileMustExist: true });
      try {
        return (
          db.prepare("SELECT DISTINCT rel_path FROM chunks ORDER BY rel_path").all() as Array<{ rel_path: string }>
        ).map((row) => row.rel_path);
      } finally {
        db.close();
      }
    };
    expect(readPaths(sharedIndex)).toEqual(expect.arrayContaining(["Public/Visible.md", "Private/Secret.md"]));

    const sharedParentAlias = path.join(tmpdir, "shared-index-parent-alias");
    try {
      await fs.symlink(path.dirname(sharedIndex), sharedParentAlias, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return ctx.skip();
      throw error;
    }
    const aliasedSharedIndex = path.join(sharedParentAlias, path.basename(sharedIndex));
    const privacyArgs = ["--read-paths", "Public/**", "--json"];

    const query = spawnSync(
      process.execPath,
      [distEntry, "query", "aliasprivacy", "--vault", vault, "--index-file", aliasedSharedIndex, ...privacyArgs],
      { encoding: "utf8", timeout: 20_000 }
    );
    expect(query.status, query.stderr).toBe(0);
    const queryResult = JSON.parse(query.stdout) as { matches?: Array<{ path?: string }> };
    expect(queryResult.matches?.some((match) => match.path === "Public/Visible.md")).toBe(true);
    expect(queryResult.matches?.some((match) => match.path === "Private/Secret.md")).toBe(false);
    expect(readPaths(sharedIndex)).toEqual(expect.arrayContaining(["Public/Visible.md", "Private/Secret.md"]));

    const queriesFile = path.join(tmpdir, "alias-privacy-eval.jsonl");
    await fs.writeFile(
      queriesFile,
      `${JSON.stringify({ id: "alias", query: "aliasprivacy", relevant: ["Public/Visible.md"] })}\n`
    );
    const evalRun = spawnSync(
      process.execPath,
      [
        distEntry,
        "eval",
        "--vault",
        vault,
        "--queries",
        queriesFile,
        "--persistent-index",
        "--index-file",
        aliasedSharedIndex,
        ...privacyArgs
      ],
      { encoding: "utf8", timeout: 20_000 }
    );
    expect(evalRun.status, evalRun.stderr).toBe(0);
    expect(readPaths(sharedIndex)).toEqual(expect.arrayContaining(["Public/Visible.md", "Private/Secret.md"]));

    // NEGATIVE control: a parent symlink alone is not enough to suppress
    // persistence. A target under a physically distinct parent remains a
    // caller-owned privacy index and must contain only admitted rows.
    const dedicatedParent = path.join(tmpdir, "dedicated-index-parent");
    const dedicatedParentAlias = path.join(tmpdir, "dedicated-index-parent-alias");
    await fs.mkdir(dedicatedParent);
    await fs.symlink(dedicatedParent, dedicatedParentAlias, process.platform === "win32" ? "junction" : "dir");
    const dedicatedIndex = path.join(dedicatedParent, "dedicated.fts5.db");
    const aliasedDedicatedIndex = path.join(dedicatedParentAlias, path.basename(dedicatedIndex));
    const dedicatedRun = spawnSync(
      process.execPath,
      [distEntry, "query", "aliasprivacy", "--vault", vault, "--index-file", aliasedDedicatedIndex, ...privacyArgs],
      { encoding: "utf8", timeout: 20_000 }
    );
    expect(dedicatedRun.status, dedicatedRun.stderr).toBe(0);
    expect(readPaths(dedicatedIndex)).toContain("Public/Visible.md");
    expect(readPaths(dedicatedIndex)).not.toContain("Private/Secret.md");

    // The lease scope NFC-normalizes its identity, but that identity is not a
    // storage pathname. On filesystems where NFC and NFD leaves are distinct,
    // preserve the exact selected NFD leaf and never create an NFC sibling.
    const normalizationParent = path.join(tmpdir, "normalization-sensitive-index-parent");
    await fs.mkdir(normalizationParent);
    const nfdIndex = path.join(normalizationParent, "cafe\u0301.fts5.db");
    const nfcIndex = path.join(normalizationParent, path.basename(nfdIndex).normalize("NFC"));
    await fs.writeFile(nfdIndex, "");
    const aliasesNfc = await fs
      .lstat(nfcIndex)
      .then(() => true)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      });
    if (!aliasesNfc) {
      const normalizedRun = spawnSync(
        process.execPath,
        [distEntry, "query", "aliasprivacy", "--vault", vault, "--index-file", nfdIndex, ...privacyArgs],
        { encoding: "utf8", timeout: 20_000 }
      );
      expect(normalizedRun.status, normalizedRun.stderr).toBe(0);
      expect(readPaths(nfdIndex)).toContain("Public/Visible.md");
      expect(readPaths(nfdIndex)).not.toContain("Private/Secret.md");
      await expect(fs.lstat(nfcIndex)).rejects.toMatchObject({ code: "ENOENT" });
    }

    // Identity uncertainty fails closed: without a resolvable persistence
    // parent the CLI still serves privacy-filtered in-memory results, but it
    // must not create or synchronize the requested persistent index.
    const unprovenIndex = path.join(tmpdir, "missing-index-parent", "unproven.fts5.db");
    const unprovenRun = spawnSync(
      process.execPath,
      [distEntry, "query", "aliasprivacy", "--vault", vault, "--index-file", unprovenIndex, ...privacyArgs],
      { encoding: "utf8", timeout: 20_000 }
    );
    expect(unprovenRun.status, unprovenRun.stderr).toBe(0);
    await expect(fs.lstat(unprovenIndex)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("`enquire-mcp index` builds the FTS5 index and reports per-status counts", async (ctx) => {
    if (!distExists()) return ctx.skip();
    if (!canRunFts5) return ctx.skip();
    const indexFile = path.join(tmpdir, "test.fts5.db");
    const out = execFileSync(process.execPath, [distEntry, "index", "--vault", vault, "--index-file", indexFile], {
      encoding: "utf8"
    });
    expect(out).toMatch(/added=2 updated=0 deleted=0 unchanged=0 total_chunks=\d+/);
    expect(out).toContain(indexFile);

    // Discriminated discovery must keep present zero-byte and schema-empty
    // files in the safe initialization class. The old peek-null + exists gate
    // falsely refused both even though live-handle admission classifies them
    // as empty and permits bootstrap.
    const zeroByteIndex = path.join(tmpdir, "zero-byte.fts5.db");
    await fs.writeFile(zeroByteIndex, "");
    const schemaEmptyIndex = path.join(tmpdir, "schema-empty.fts5.db");
    const { default: Database } = await import("better-sqlite3");
    const schemaEmpty = new Database(schemaEmptyIndex);
    schemaEmpty.close();
    for (const emptyIndex of [zeroByteIndex, schemaEmptyIndex]) {
      const emptyOut = execFileSync(
        process.execPath,
        [distEntry, "index", "--vault", vault, "--index-file", emptyIndex],
        { encoding: "utf8" }
      );
      expect(emptyOut).toMatch(/added=2 updated=0 deleted=0 unchanged=0/);
      expect((await peekFtsMetaSafe(emptyIndex))?.tokenize_mode).toBe("unicode61");
    }
  });

  it("`enquire-mcp clear-index` removes db + WAL/SHM/rollback journal after a build", async (ctx) => {
    if (!distExists()) return ctx.skip();
    if (!canRunFts5) return ctx.skip();
    const indexFile = path.join(tmpdir, "purge.fts5.db");
    execFileSync(process.execPath, [distEntry, "index", "--vault", vault, "--index-file", indexFile], {
      encoding: "utf8"
    });
    const dbExisted = await fs
      .stat(indexFile)
      .then(() => true)
      .catch(() => false);
    expect(dbExisted).toBe(true);
    const rollbackJournal = `${indexFile}-journal`;
    await fs.writeFile(rollbackJournal, "ROLLBACK_JOURNAL_SENTINEL");

    const out = execFileSync(
      process.execPath,
      [distEntry, "clear-index", "--vault", vault, "--index-file", indexFile],
      { encoding: "utf8" }
    );
    expect(out).toContain("removed fts5 index");

    const dbStillThere = await fs
      .stat(indexFile)
      .then(() => true)
      .catch(() => false);
    expect(dbStillThere).toBe(false);
    await expect(fs.lstat(rollbackJournal)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("`enquire-mcp index` then second call reports unchanged=N (incremental skips unchanged files)", (ctx) => {
    if (!distExists()) return ctx.skip();
    if (!canRunFts5) return ctx.skip();
    const indexFile = path.join(tmpdir, "incremental.fts5.db");
    execFileSync(process.execPath, [distEntry, "index", "--vault", vault, "--index-file", indexFile], {
      encoding: "utf8"
    });
    const out2 = execFileSync(process.execPath, [distEntry, "index", "--vault", vault, "--index-file", indexFile], {
      encoding: "utf8"
    });
    // No file changed between runs → both files appear in `unchanged`, none in added/updated.
    expect(out2).toMatch(/added=0 updated=0 deleted=0 unchanged=2/);
  });

  const preserveTrigramTestName =
    "`enquire-mcp index --tokenize trigram` then re-run WITHOUT --tokenize " + "PRESERVES trigram (v3.6.4 K-1 fix)";
  it(preserveTrigramTestName, async (ctx) => {
    if (!distExists()) return ctx.skip();
    if (!canRunFts5) return ctx.skip();
    const rejectedCustom = path.join(tmpdir, "invalid-tokenizer-custom.fts5.db");
    const invalidCustom = spawnSync(
      process.execPath,
      [distEntry, "index", "--vault", vault, "--index-file", rejectedCustom, "--tokenize", "porter"],
      { encoding: "utf8", timeout: 20000 }
    );
    expect(invalidCustom.status).not.toBe(0);
    expect(`${invalidCustom.stdout ?? ""}${invalidCustom.stderr ?? ""}`).toMatch(
      /--tokenize.*unicode61.*trigram.*porter/is
    );
    await expect(fs.stat(rejectedCustom)).rejects.toThrow();

    const rejectedDefault = defaultIndexFile(await fs.realpath(vault));
    const invalidDefault = spawnSync(process.execPath, [distEntry, "index", "--vault", vault, "--tokenize", "porter"], {
      encoding: "utf8",
      timeout: 20000
    });
    expect(invalidDefault.status).not.toBe(0);
    expect(`${invalidDefault.stdout ?? ""}${invalidDefault.stderr ?? ""}`).toMatch(
      /--tokenize.*unicode61.*trigram.*porter/is
    );
    await expect(fs.stat(rejectedDefault)).rejects.toThrow();

    const rejectedProgrammatic = path.join(tmpdir, "invalid-tokenizer-programmatic.fts5.db");
    await expect(
      prepareServerDeps({
        vault,
        persistentIndex: true,
        indexFile: rejectedProgrammatic,
        tokenize: "porter" as unknown as "unicode61" | "trigram"
      })
    ).rejects.toThrow(/tokenize option.*unicode61.*trigram.*porter/is);
    await expect(fs.stat(rejectedProgrammatic)).rejects.toThrow();

    const indexFile = path.join(tmpdir, "tokenize-flip.fts5.db");
    execFileSync(
      process.execPath,
      [distEntry, "index", "--vault", vault, "--index-file", indexFile, "--tokenize", "trigram"],
      { encoding: "utf8" }
    );
    // v3.6.4 K-1 closure: a refresh-style re-run (no --tokenize flag) must
    // PRESERVE the existing trigram-built index, not silently destroy and
    // rebuild as unicode61. Pre-v3.6.4: out2 matched `added=2 updated=0`
    // (rebuild). Post-v3.6.4: out2 matches `unchanged=2` (preservation).
    const out2 = execFileSync(process.execPath, [distEntry, "index", "--vault", vault, "--index-file", indexFile], {
      encoding: "utf8"
    });
    expect(out2).toMatch(/unchanged=2/);
    // Honor message announced on stderr (combined output check is more robust).
    // Don't strictly assert the warning text — the behavior (preservation) is
    // what matters for the K-1 contract.
  });

  it("`enquire-mcp index --tokenize trigram` then re-run WITH explicit --tokenize unicode61 DOES rebuild (v3.6.4 forced-rebuild path)", (ctx) => {
    if (!distExists()) return ctx.skip();
    if (!canRunFts5) return ctx.skip();
    const indexFile = path.join(tmpdir, "tokenize-flip-forced.fts5.db");
    execFileSync(
      process.execPath,
      [distEntry, "index", "--vault", vault, "--index-file", indexFile, "--tokenize", "trigram"],
      { encoding: "utf8" }
    );
    // With explicit --tokenize unicode61 the user opts INTO a rebuild — this
    // is the only path that should destroy + re-add.
    const out2 = execFileSync(
      process.execPath,
      [distEntry, "index", "--vault", vault, "--index-file", indexFile, "--tokenize", "unicode61"],
      { encoding: "utf8" }
    );
    expect(out2).toMatch(/added=2/);
  });

  // v3.7.0 M-1 — E2E preservation tests for the remaining K-1 callsites that
  // v3.6.4 fixed but didn't yet have behavior-level coverage. The v3.6.4 K-1
  // closure added peek-before-open at cli.ts:514,554 (setup), 398 (build-
  // embeddings), and 638 (eval). v3.6.4 shipped E2E pairs only for `index`
  // (above). These tests close the gap for the other three commands.
  //
  // Note: where the command path requires loading the embedder model (which
  // depends on a network-cached HuggingFace download), we don't assert exit
  // code — we capture stderr and assert the K-1 honoring message fires
  // BEFORE the embedder load. That proves configuration discovery and honoring ran
  // even when the test environment can't complete the full subcommand.

  it("`enquire-mcp setup --skip-embeddings` PRESERVES existing --tokenize trigram FTS5 index (v3.7.0 M-1)", async (ctx) => {
    if (!distExists()) return ctx.skip();
    if (!canRunFts5) return ctx.skip();
    // setup uses `defaultIndexFile(v.root)` where v.root is the REALPATH of
    // the vault (Vault.ensureExists() does fs.realpath). On macOS,
    // tmpdir/.../vault → /private/var/.../vault. To make our peek and
    // setup look at the same file, use a pinned index location instead of
    // relying on the hash-derived default. But setup has no `--index-file`
    // flag, so we pre-seed via the default path computed against vault's
    // realpath.
    const realVault = await fs.realpath(vault);
    const { defaultIndexFile } = await import("../src/fts5.js");
    const { embedDbPath } = await import("../src/tool-registry.js");
    const indexFile = defaultIndexFile(realVault);
    const embedFile = embedDbPath(realVault);
    const guardPath = watcherActivationGuardPath(embedFile);
    await fs.mkdir(path.dirname(indexFile), { recursive: true });
    // Build FTS5 with trigram at the default location.
    execFileSync(process.execPath, [distEntry, "index", "--vault", vault, "--tokenize", "trigram"], {
      encoding: "utf8"
    });
    // Sanity: peek shows trigram before setup runs.
    const metaBefore = await peekFtsMetaSafe(indexFile);
    expect(metaBefore?.tokenize_mode).toBe("trigram");
    await expect(fs.lstat(guardPath)).rejects.toThrow();
    // Re-run `setup --skip-embeddings`. Pre-v3.6.4 this would silently
    // destroy trigram and rebuild as unicode61. Post-v3.6.4: preservation.
    const setupResult = spawnSync(
      process.execPath,
      [
        distEntry,
        "setup",
        "--vault",
        vault,
        "--skip-embeddings",
        "--exclude-glob",
        "Private/**",
        "--read-paths",
        "*.md"
      ],
      { encoding: "utf8" }
    );
    // v3.6.4 setup emits an info line when honoring trigram. Assert via
    // combined stdout/stderr.
    const combined = (setupResult.stdout ?? "") + (setupResult.stderr ?? "");
    expect(combined).toMatch(/honoring existing tokenize_mode=trigram/);
    expect(combined.match(/--exclude-glob 'Private\/\*\*'/g)).toHaveLength(1);
    expect(combined.match(/--read-paths '\*\.md'/g)).toHaveLength(1);
    expect(combined).toMatch(/setup --vault .* --exclude-glob 'Private\/\*\*' --read-paths '\*\.md'/);
    // The on-disk meta must still be trigram after setup.
    const metaAfter = await peekFtsMetaSafe(indexFile);
    expect(metaAfter?.tokenize_mode).toBe("trigram");
    expect(setupResult.status).toBe(0);
    await expect(fs.lstat(guardPath)).rejects.toThrow();

    // NEGATIVE control: setup must inspect the embedding-generation interlock
    // before opening or syncing FTS5, even with --skip-embeddings. A new vault
    // note makes any accidental Step 1 execution byte-observable.
    await fs.writeFile(path.join(vault, "Blocked.md"), "# Must not be indexed\n\nsetupguardmarker\n");
    const guard = await armWatcherActivationGuard(embedFile);
    try {
      const ftsBytesBeforeRefusal = await fs.readFile(indexFile);
      const ftsStatBeforeRefusal = mutationFingerprint(await fs.stat(indexFile));
      const cacheEntriesBeforeRefusal = (await fs.readdir(path.dirname(indexFile))).sort();
      const registerFixture = path.resolve(__dirname, "fixtures", "transformers-test-loader", "register.mjs");
      const networkMarker = path.join(tmpdir, "setup-guard.network");
      const modelMarker = path.join(tmpdir, "setup-guard.model");
      const nodeOptions = [process.env.NODE_OPTIONS, `--import=${pathToFileURL(registerFixture).href}`]
        .filter(Boolean)
        .join(" ");
      const guardedSetup = spawnSync(
        process.execPath,
        [
          distEntry,
          "setup",
          "--vault",
          vault,
          "--skip-embeddings",
          "--exclude-glob",
          "Private/**",
          "--read-paths",
          "*.md"
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            NODE_OPTIONS: nodeOptions,
            ENQUIRE_TEST_MODEL_STATE: "missing",
            ENQUIRE_TEST_MODEL_MARKER: modelMarker,
            ENQUIRE_TEST_NETWORK_MARKER: networkMarker
          },
          timeout: 10_000
        }
      );
      const refusal = `${guardedSetup.stdout ?? ""}${guardedSetup.stderr ?? ""}`;

      expect(guardedSetup.error, guardedSetup.stderr).toBeUndefined();
      expect(guardedSetup.status).not.toBe(0);
      expect(refusal).toMatch(/enquire setup:.*incomplete watcher startup quarantined/is);
      expect(refusal).toMatch(/strict.*clear-embeddings --vault <vault>/is);
      expect(refusal).toMatch(/refuses unsafe or foreign interlock shapes/i);
      expect(refusal).toMatch(/If FTS setup is needed.*--skip-embeddings/is);
      expect(refusal).toMatch(
        /rebuild embeddings separately.*build-embeddings --vault <vault>.*same model, quantization, late-chunk, privacy and PDF settings/is
      );
      expect(refusal).not.toMatch(/rerun this setup command.*late-chunk/is);
      expect(refusal).not.toContain("Step 1/3");
      for (const sensitivePath of [vault, realVault, indexFile, embedFile, guardPath]) {
        expect(refusal).not.toContain(sensitivePath);
      }

      expect(await fs.readFile(indexFile)).toEqual(ftsBytesBeforeRefusal);
      expect(mutationFingerprint(await fs.stat(indexFile))).toEqual(ftsStatBeforeRefusal);
      expect((await fs.readdir(path.dirname(indexFile))).sort()).toEqual(cacheEntriesBeforeRefusal);
      expect((await peekFtsMetaSafe(indexFile))?.tokenize_mode).toBe("trigram");
      await expect(fs.stat(embedFile)).rejects.toThrow();
      await expect(fs.stat(modelMarker)).rejects.toThrow();
      await expect(fs.stat(networkMarker)).rejects.toThrow();
      expect((await fs.lstat(guardPath)).isDirectory()).toBe(true);
    } finally {
      await releaseWatcherActivationGuard(guard);
    }
    await expect(fs.lstat(guardPath)).rejects.toThrow();

    // Combined ownership + guard negative: recovery guidance is safe only for
    // a missing or exactly-owned EmbedDb. A foreign default artifact must win
    // with the generic class refusal while the guard and logical cells remain.
    const foreignSetupRoot = path.join(tmpdir, "setup-foreign-root");
    await fs.mkdir(foreignSetupRoot);
    const canonicalForeignSetupRoot = await fs.realpath(foreignSetupRoot);
    const foreignSetupDb = new EmbedDb({
      file: embedFile,
      vaultRoot: canonicalForeignSetupRoot,
      modelAlias: "multilingual",
      dim: 2
    });
    await foreignSetupDb.open();
    foreignSetupDb.upsertNote("Foreign.md", 1, [
      {
        chunkIndex: 0,
        lineStart: 1,
        lineEnd: 1,
        textPreview: "setup-foreign-cell",
        vector: new Float32Array([1, 0])
      }
    ]);
    foreignSetupDb.close();
    const Database = (await import("better-sqlite3")).default;
    const setupLogicalSnapshot = () => {
      const inspect = new Database(embedFile, { readonly: true, fileMustExist: true });
      try {
        return {
          schema: inspect
            .prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY type, name")
            .all(),
          meta: inspect.prepare("SELECT key, value FROM meta ORDER BY key").all(),
          rows: inspect
            .prepare("SELECT rel_path, text_preview, hex(vector) AS vector_hex FROM embeddings ORDER BY id")
            .all()
        };
      } finally {
        inspect.close();
      }
    };
    const setupLogicalBefore = setupLogicalSnapshot();
    const combinedSetupGuard = await armWatcherActivationGuard(embedFile);
    try {
      const combinedSetup = spawnSync(process.execPath, [distEntry, "setup", "--vault", vault, "--skip-embeddings"], {
        encoding: "utf8",
        timeout: 10_000
      });
      const combinedRefusal = `${combinedSetup.stdout ?? ""}${combinedSetup.stderr ?? ""}`;
      expect(combinedSetup.status).not.toBe(0);
      expect(combinedRefusal).toMatch(/Embedding index ownership could not be verified/i);
      expect(combinedRefusal).not.toMatch(/clear-embeddings|incomplete watcher startup|strict recovery/i);
      for (const sensitivePath of [
        vault,
        realVault,
        foreignSetupRoot,
        canonicalForeignSetupRoot,
        embedFile,
        guardPath
      ]) {
        expect(combinedRefusal).not.toContain(sensitivePath);
      }
      expect(setupLogicalSnapshot()).toEqual(setupLogicalBefore);
      expect((await fs.lstat(guardPath)).isDirectory()).toBe(true);
    } finally {
      await releaseWatcherActivationGuard(combinedSetupGuard);
    }
    await Promise.all(
      [embedFile, `${embedFile}-wal`, `${embedFile}-shm`].map((artifact) => fs.rm(artifact, { force: true }))
    );

    // Fail-soft discovery negative: a present same-root index whose metadata
    // cannot be classified must not be laundered through the unicode61
    // fallback. Setup has no explicit tokenizer override, so it refuses before
    // FtsIndex construction and preserves every logical row.
    const corruptFtsMeta = new Database(indexFile);
    corruptFtsMeta.prepare("UPDATE meta SET value = ? WHERE key = 'tokenize_mode'").run("porter/path-secret");
    corruptFtsMeta.close();
    expect(await peekFtsMetaSafe(indexFile, realVault)).toBeNull();
    const ftsLogicalSnapshot = () => {
      const inspect = new Database(indexFile, { readonly: true, fileMustExist: true });
      try {
        return {
          schema: inspect
            .prepare(
              `SELECT type, name, sql
               FROM sqlite_master
               WHERE name NOT GLOB 'sqlite_*'
               ORDER BY type, name`
            )
            .all(),
          meta: inspect.prepare("SELECT key, value FROM meta ORDER BY key").all(),
          chunks: inspect
            .prepare(
              `SELECT rowid, content, title, aliases, scope_tokens, rel_path,
                      chunk_index, line_start, line_end, tags, raw_content, kind
               FROM chunks
               ORDER BY rowid`
            )
            .all(),
          sourceState: inspect.prepare("SELECT * FROM source_state ORDER BY rel_path, kind").all()
        };
      } finally {
        inspect.close();
      }
    };
    const ftsLogicalBeforeRefusal = ftsLogicalSnapshot();
    const unverifiedSetup = spawnSync(process.execPath, [distEntry, "setup", "--vault", vault, "--skip-embeddings"], {
      encoding: "utf8",
      timeout: 10_000
    });
    const unverifiedFtsRefusal = `${unverifiedSetup.stdout ?? ""}${unverifiedSetup.stderr ?? ""}`;
    expect(unverifiedSetup.status).not.toBe(0);
    expect(unverifiedFtsRefusal).toMatch(/FTS index configuration could not be verified/i);
    expect(unverifiedFtsRefusal).not.toContain("porter/path-secret");
    for (const sensitivePath of [vault, realVault, indexFile]) {
      expect(unverifiedFtsRefusal).not.toContain(sensitivePath);
    }
    expect(ftsLogicalSnapshot()).toEqual(ftsLogicalBeforeRefusal);
    await Promise.all(
      [indexFile, `${indexFile}-wal`, `${indexFile}-shm`].map((artifact) => fs.rm(artifact, { force: true }))
    );
  });

  it("`enquire-mcp eval --persistent-index` PRESERVES existing --tokenize trigram FTS5 index (v3.7.0 M-1)", async (ctx) => {
    if (!distExists()) return ctx.skip();
    if (!canRunFts5) return ctx.skip();
    // eval uses defaultIndexFile(v.root) — same realpath concern as setup.
    const realVault = await fs.realpath(vault);
    const { defaultIndexFile } = await import("../src/fts5.js");
    const indexFile = defaultIndexFile(realVault);
    // Build FTS5 with trigram at the default location so eval finds it.
    execFileSync(process.execPath, [distEntry, "index", "--vault", vault, "--tokenize", "trigram"], {
      encoding: "utf8"
    });
    // Minimal queries.jsonl — eval supports BM25-only via --persistent-index
    // when no embed-db exists, so the embedder is not required here.
    const queriesFile = path.join(tmpdir, "queries.jsonl");
    await fs.writeFile(queriesFile, '{"query":"Apollo","relevant":["Apollo.md"]}\n');
    // Run eval. K-1 contract: must not destroy the trigram-built FTS5 index.
    const evalResult = spawnSync(
      process.execPath,
      [distEntry, "eval", "--vault", vault, "--persistent-index", "--queries", queriesFile, "--k", "5"],
      { encoding: "utf8" }
    );
    // Assert eval ran (status 0 expected for BM25-only path).
    expect(evalResult.status).toBe(0);
    // Critical assertion: the on-disk FTS5 index after eval still has
    // tokenize_mode=trigram. Pre-v3.6.4 it would have been rebuilt as
    // unicode61 by eval's destructive bootstrapSchema path.
    const metaAfter = await peekFtsMetaSafe(indexFile);
    expect(metaAfter?.tokenize_mode).toBe("trigram");
  });

  // v3.12.0-rc.11 — this process-level regression must never depend on a
  // developer's model cache or Hugging Face availability. A registered ESM
  // loader swaps only @huggingface/transformers for a deterministic embedder;
  // the network tripwire covers fetch/http/https in the child process.
  it("`enquire-mcp build-embeddings` (no --embedding-model) HONORS existing model_alias=bge in stderr message (v3.7.0 M-1)", async (ctx) => {
    if (!distExists()) return ctx.skip();
    if (!canRunFts5) return ctx.skip();
    // build-embeddings uses embedDbPath(vault.root) — same realpath concern.
    const realVault = await fs.realpath(vault);
    const { defaultIndexFile } = await import("../src/fts5.js");
    const { embedDbPath } = await import("../src/tool-registry.js");
    const embedFile = embedDbPath(realVault);
    const indexFile = defaultIndexFile(realVault);
    const guardPath = watcherActivationGuardPath(embedFile);
    const customEmbedFile = path.join(tmpdir, "guarded-custom.embed.db");
    const customGuardPath = watcherActivationGuardPath(customEmbedFile);
    await fs.mkdir(path.dirname(embedFile), { recursive: true });
    await expect(fs.lstat(guardPath)).rejects.toThrow();
    await expect(fs.lstat(customGuardPath)).rejects.toThrow();
    // Pre-create a meta-only embed-db via direct EmbedDb construction (no
    // embedder load required — EmbedDb writes only the meta row at open
    // time; vectors would come from a later syncEmbedDb call which we skip).
    const seedDb = new EmbedDb({ file: embedFile, vaultRoot: realVault, modelAlias: "bge", dim: 384 });
    await seedDb.open();
    seedDb.close();
    // Sanity: meta is bge.
    const metaBefore = await peekEmbedDbMeta(embedFile);
    expect(metaBefore?.model_alias).toBe("bge");
    // Run `build-embeddings` without --embedding-model flag. The Commander
    // default is "multilingual" — pre-v3.6.4 this would silently destroy
    // bge and rebuild as multilingual. Current behavior: discover + honor + emit
    // stderr line BEFORE embedder load.
    //
    const registerFixture = path.resolve(__dirname, "fixtures", "transformers-test-loader", "register.mjs");
    const networkMarker = path.join(tmpdir, "build-embeddings.network");
    const nodeOptions = [process.env.NODE_OPTIONS, `--import=${pathToFileURL(registerFixture).href}`]
      .filter(Boolean)
      .join(" ");
    const hermeticEnv = {
      ...process.env,
      NODE_OPTIONS: nodeOptions,
      ENQUIRE_TEST_MODEL_STATE: "present",
      ENQUIRE_TEST_NETWORK_MARKER: networkMarker
    };
    const buildResult = spawnSync(process.execPath, [distEntry, "build-embeddings", "--vault", vault], {
      encoding: "utf8",
      env: hermeticEnv,
      timeout: 10_000
    });
    expect(buildResult.error, buildResult.stderr).toBeUndefined();
    expect(buildResult.status, buildResult.stderr).toBe(0);
    const stderr = buildResult.stderr ?? "";
    expect(stderr).toMatch(/honoring existing model_alias=bge/);
    await expect(fs.stat(networkMarker)).rejects.toThrow();
    // After the hermetic successful run, the on-disk meta must NOT have
    // been silently rewritten to "multilingual".
    const metaAfter = await peekEmbedDbMeta(embedFile);
    expect(metaAfter?.model_alias).toBe("bge");
    await expect(fs.lstat(guardPath)).rejects.toThrow();

    // Guard refusal must happen before embed-db open/model load/network access.
    // Snapshot both bytes and source metadata after the successful positive
    // control, then prove the failed child leaves every observable surface
    // unchanged while retaining the exact interlock.
    const guard = await armWatcherActivationGuard(customEmbedFile);
    try {
      const embedBytesBeforeRefusal = await fs.readFile(embedFile);
      const embedStatBeforeRefusal = mutationFingerprint(await fs.stat(embedFile));
      const cacheEntriesBeforeRefusal = (await fs.readdir(path.dirname(embedFile))).sort();
      const guardedNetworkMarker = path.join(tmpdir, "build-embeddings-guard.network");
      const guardedModelMarker = path.join(tmpdir, "build-embeddings-guard.model");
      const guardedBuild = spawnSync(
        process.execPath,
        [distEntry, "build-embeddings", "--vault", vault, "--embed-file", customEmbedFile],
        {
          encoding: "utf8",
          env: {
            ...hermeticEnv,
            ENQUIRE_TEST_MODEL_STATE: "missing",
            ENQUIRE_TEST_MODEL_MARKER: guardedModelMarker,
            ENQUIRE_TEST_NETWORK_MARKER: guardedNetworkMarker
          },
          timeout: 10_000
        }
      );
      const refusal = `${guardedBuild.stdout ?? ""}${guardedBuild.stderr ?? ""}`;

      expect(guardedBuild.error, guardedBuild.stderr).toBeUndefined();
      expect(guardedBuild.status).not.toBe(0);
      expect(refusal).toMatch(/enquire build-embeddings:.*incomplete watcher startup quarantined/is);
      expect(refusal).toMatch(/strict.*clear-embeddings --vault <vault>/is);
      expect(refusal).toMatch(/refuses unsafe or foreign interlock shapes/i);
      expect(refusal).toMatch(
        /custom embedding index.*same `--embed-file` option.*`clear-embeddings`.*rebuild command/is
      );
      expect(refusal).toMatch(/absolute path is intentionally omitted/i);
      expect(refusal).toMatch(
        /rerun this build-embeddings command.*same model, quantization, late-chunk, privacy and PDF settings/is
      );
      expect(refusal).not.toMatch(/honoring existing model_alias|loading embedder|fixture model/i);
      for (const sensitivePath of [
        vault,
        realVault,
        indexFile,
        embedFile,
        guardPath,
        customEmbedFile,
        customGuardPath
      ]) {
        expect(refusal).not.toContain(sensitivePath);
      }

      expect(await fs.readFile(embedFile)).toEqual(embedBytesBeforeRefusal);
      expect(mutationFingerprint(await fs.stat(embedFile))).toEqual(embedStatBeforeRefusal);
      expect((await fs.readdir(path.dirname(embedFile))).sort()).toEqual(cacheEntriesBeforeRefusal);
      await expect(fs.stat(customEmbedFile)).rejects.toThrow();
      await expect(fs.stat(indexFile)).rejects.toThrow();
      await expect(fs.stat(guardedModelMarker)).rejects.toThrow();
      await expect(fs.stat(guardedNetworkMarker)).rejects.toThrow();
      expect((await fs.lstat(customGuardPath)).isDirectory()).toBe(true);
      expect((await peekEmbedDbMeta(embedFile))?.model_alias).toBe("bge");
    } finally {
      await releaseWatcherActivationGuard(guard);
    }
    await expect(fs.lstat(customGuardPath)).rejects.toThrow();

    // Combined malformed-class + guard control: even fully explicit writer
    // configuration cannot turn recovery guidance into authority over an
    // unrelated SQLite file. The payload BLOB and guard both remain exact.
    const { default: Database } = await import("better-sqlite3");
    const wrongClass = new Database(customEmbedFile);
    wrongClass.exec("CREATE TABLE payload (id INTEGER PRIMARY KEY, value BLOB NOT NULL)");
    wrongClass.prepare("INSERT INTO payload (id, value) VALUES (?, ?)").run(7, Buffer.from([0, 1, 127, 255]));
    wrongClass.close();
    const wrongClassSnapshot = () => {
      const inspect = new Database(customEmbedFile, { readonly: true, fileMustExist: true });
      try {
        return {
          schema: inspect
            .prepare(
              `SELECT type, name, sql
               FROM sqlite_master
               WHERE name NOT GLOB 'sqlite_*'
               ORDER BY type, name`
            )
            .all(),
          payload: inspect.prepare("SELECT id, hex(value) AS value_hex FROM payload ORDER BY id").all()
        };
      } finally {
        inspect.close();
      }
    };
    const wrongClassBefore = wrongClassSnapshot();
    const wrongClassGuard = await armWatcherActivationGuard(customEmbedFile);
    try {
      const wrongClassModelMarker = path.join(tmpdir, "build-embeddings-wrong-class.model");
      const wrongClassNetworkMarker = path.join(tmpdir, "build-embeddings-wrong-class.network");
      const refusedWrongClass = spawnSync(
        process.execPath,
        [
          distEntry,
          "build-embeddings",
          "--vault",
          vault,
          "--embed-file",
          customEmbedFile,
          "--embedding-model",
          "multilingual",
          "--quantize-embeddings",
          "f32"
        ],
        {
          encoding: "utf8",
          env: {
            ...hermeticEnv,
            ENQUIRE_TEST_MODEL_STATE: "missing",
            ENQUIRE_TEST_MODEL_MARKER: wrongClassModelMarker,
            ENQUIRE_TEST_NETWORK_MARKER: wrongClassNetworkMarker
          },
          timeout: 10_000
        }
      );
      const wrongClassRefusal = `${refusedWrongClass.stdout ?? ""}${refusedWrongClass.stderr ?? ""}`;
      expect(refusedWrongClass.error, refusedWrongClass.stderr).toBeUndefined();
      expect(refusedWrongClass.status).not.toBe(0);
      expect(wrongClassRefusal).toMatch(/Embedding index ownership could not be verified/i);
      expect(wrongClassRefusal).not.toMatch(/clear-embeddings|incomplete watcher startup|strict recovery/i);
      for (const sensitivePath of [vault, realVault, customEmbedFile, customGuardPath]) {
        expect(wrongClassRefusal).not.toContain(sensitivePath);
      }
      expect(wrongClassSnapshot()).toEqual(wrongClassBefore);
      expect((await fs.lstat(customGuardPath)).isDirectory()).toBe(true);
      await expect(fs.stat(wrongClassModelMarker)).rejects.toThrow();
      await expect(fs.stat(wrongClassNetworkMarker)).rejects.toThrow();
    } finally {
      await releaseWatcherActivationGuard(wrongClassGuard);
    }
    await Promise.all(
      [customEmbedFile, `${customEmbedFile}-wal`, `${customEmbedFile}-shm`].map((file) => fs.rm(file, { force: true }))
    );

    // NEGATIVE control: prove the same child-process tripwire would record
    // and reject a real outbound attempt instead of merely leaving no marker.
    const controlMarker = path.join(tmpdir, "network-control.marker");
    const control = spawnSync(process.execPath, ["-e", "fetch('https://example.invalid/model')"], {
      encoding: "utf8",
      env: { ...hermeticEnv, ENQUIRE_TEST_NETWORK_MARKER: controlMarker },
      timeout: 5_000
    });
    expect(control.status).not.toBe(0);
    expect(await fs.readFile(controlMarker, "utf8")).toMatch(/fetch: https:\/\/example\.invalid\/model/);
    expect(control.stderr).toMatch(/TEST NETWORK TRIPWIRE/);
  }, 15_000);

  it("`build-embeddings` preserves the exact usable generation through model and corpus failures", async (ctx) => {
    if (!distExists()) return ctx.skip();
    if (!canRunFts5) return ctx.skip();
    const realVault = await fs.realpath(vault);
    const registerFixture = path.resolve(__dirname, "fixtures", "transformers-test-loader", "register.mjs");
    const nodeOptions = [process.env.NODE_OPTIONS, `--import=${pathToFileURL(registerFixture).href}`]
      .filter(Boolean)
      .join(" ");
    const Database = (await import("better-sqlite3")).default;
    const logicalSnapshot = (file: string): unknown => {
      const db = new Database(file, { readonly: true, fileMustExist: true });
      try {
        return {
          meta: db.prepare("SELECT key, value FROM meta ORDER BY key").all(),
          embeddings: db
            .prepare(
              `SELECT id, rel_path, chunk_index, line_start, line_end, text_preview,
                      hex(vector) AS vector_hex, kind
               FROM embeddings
               ORDER BY id`
            )
            .all(),
          sourceState: db.prepare("SELECT * FROM source_state ORDER BY rel_path, kind").all(),
          sourceQuarantine: db.prepare("SELECT * FROM source_quarantine ORDER BY rel_path, kind").all(),
          sourceRevision: db.prepare("SELECT * FROM source_revision ORDER BY rel_path, kind").all()
        };
      } finally {
        db.close();
      }
    };

    for (const scenario of [
      { label: "missing model", modelState: "missing", failMatch: undefined, expected: /fixture model missing/i },
      { label: "corrupt model", modelState: "corrupt", failMatch: undefined, expected: /fixture model corrupt/i },
      {
        label: "corpus inference",
        modelState: "present",
        failMatch: "Apollo project notes",
        expected: /replacement Markdown embed sync rejected Apollo\.md/i
      }
    ] as const) {
      const embedFile = path.join(tmpdir, `${scenario.modelState}-${scenario.label.replaceAll(" ", "-")}.embed.db`);
      const seed = new EmbedDb({
        file: embedFile,
        vaultRoot: realVault,
        modelAlias: "bge",
        dim: 384,
        quantization: "f32"
      });
      await seed.open();
      try {
        const oldVector = new Float32Array(384);
        oldVector[0] = 1;
        seed.upsertNote("Legacy.md", 1, [
          {
            chunkIndex: 0,
            lineStart: 1,
            lineEnd: 1,
            textPreview: `OLD_USABLE_${scenario.label}`,
            vector: oldVector
          }
        ]);
      } finally {
        await seed.closeAndRelease();
      }

      const hnswBase = hnswPersistBase(embedFile);
      const hnswArtifacts = [`${hnswBase}.bin`, `${hnswBase}.meta.json`, `${hnswBase}.${"b".repeat(48)}.bin`];
      for (const [index, artifact] of hnswArtifacts.entries()) {
        await fs.writeFile(artifact, `HNSW_${scenario.label}_${index}`, { mode: 0o600 });
      }
      const beforeLogical = logicalSnapshot(embedFile);
      const beforeBytes = await fs.readFile(embedFile);
      const beforeStat = mutationFingerprint(await fs.stat(embedFile));
      const hnswBefore = await Promise.all(hnswArtifacts.map((artifact) => fs.readFile(artifact)));
      const networkMarker = path.join(tmpdir, `${scenario.modelState}-${scenario.label}.network`);
      const modelMarker = path.join(tmpdir, `${scenario.modelState}-${scenario.label}.model`);

      const result = spawnSync(
        process.execPath,
        [
          distEntry,
          "build-embeddings",
          "--vault",
          vault,
          "--embed-file",
          embedFile,
          "--embedding-model",
          "multilingual",
          "--quantize-embeddings",
          "f32"
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            NODE_OPTIONS: nodeOptions,
            ENQUIRE_TEST_MODEL_STATE: scenario.modelState,
            ENQUIRE_TEST_MODEL_MARKER: modelMarker,
            ENQUIRE_TEST_NETWORK_MARKER: networkMarker,
            ...(scenario.failMatch === undefined ? {} : { ENQUIRE_TEST_EMBED_FAIL_MATCH: scenario.failMatch })
          },
          timeout: 10_000
        }
      );
      const diagnostic = `${result.stdout ?? ""}${result.stderr ?? ""}`;

      expect(result.error, result.stderr).toBeUndefined();
      expect(result.status, diagnostic).not.toBe(0);
      expect(diagnostic).toMatch(scenario.expected);
      expect(await fs.readFile(modelMarker, "utf8")).toContain("@huggingface/transformers");
      await expect(fs.lstat(networkMarker)).rejects.toMatchObject({ code: "ENOENT" });
      expect(logicalSnapshot(embedFile)).toEqual(beforeLogical);
      expect(await fs.readFile(embedFile)).toEqual(beforeBytes);
      expect(mutationFingerprint(await fs.stat(embedFile))).toEqual(beforeStat);
      for (const [index, artifact] of hnswArtifacts.entries()) {
        expect(await fs.readFile(artifact)).toEqual(hnswBefore[index]);
      }
      expect(
        (await fs.readdir(path.dirname(embedFile))).filter((entry) =>
          entry.startsWith(`${path.basename(embedFile)}.enquire-stage-`)
        )
      ).toEqual([]);
    }
  }, 20_000);
});
