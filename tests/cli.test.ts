import { execFileSync, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EmbedDb, peekEmbedDbMeta } from "../src/embed-db.js";
import { peekFtsMetaSafe } from "../src/fts5.js";
import { parsePositiveInt, parseQuantizationMode } from "../src/index.js";

describe("parsePositiveInt — CLI numeric flag validation (audit P2-2)", () => {
  it("accepts a positive integer string", () => {
    expect(parsePositiveInt("100", "--max-file-bytes")).toBe(100);
  });

  it("accepts a large integer", () => {
    expect(parsePositiveInt("5242880", "--max-file-bytes")).toBe(5242880);
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

  it("includes the flag name in the error", () => {
    expect(() => parsePositiveInt("oops", "--cache-size")).toThrow(/--cache-size/);
  });
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

  it("invokes main() when run via a symlink (e.g. npm bin shim)", async () => {
    const exists = await fs
      .stat(distEntry)
      .then(() => true)
      .catch(() => false);
    if (!exists) return; // dist not built yet — skip in dev watch loops
    const link = path.join(tmpdir, "enquire-mcp");
    await fs.symlink(distEntry, link);
    const out = execFileSync(process.execPath, [link, "--version"], { encoding: "utf8" });
    expect(out.trim()).toMatch(/^\d+\.\d+\.\d+(-[a-z0-9.]+)?$/);
  });

  it("invokes main() when run via /tmp on macOS (which itself is a symlink to /private/tmp)", async () => {
    const exists = await fs
      .stat(distEntry)
      .then(() => true)
      .catch(() => false);
    if (!exists) return;
    // tmpdir already lives under /tmp on macOS — execFile via /tmp path
    // exercises the same realpath divergence.
    if (process.platform !== "darwin") return; // only macOS has the /tmp symlink
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
    expect(res.stdout).toMatch(/DRY RUN|already clean/);
    expect(res.stdout).not.toMatch(/enquire prune: removed/);
  });

  // v3.9.0-rc.9 audit — the bearer min-length check now fires in the CLI
  // action (reconciled with startHttpServer's ≥16 throw) so the user gets a
  // friendly hint + clean exit(1) before any server setup. Both branches exit
  // before binding, so spawnSync returns fast.
  it("`serve-http --bearer-token <short>` exits 1 with a ≥16-char hint (NEGATIVE control)", (ctx) => {
    if (!distExists()) return ctx.skip();
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

  it("`enquire-mcp index` builds the FTS5 index and reports per-status counts", (ctx) => {
    if (!distExists()) return ctx.skip();
    if (!canRunFts5) return ctx.skip();
    const indexFile = path.join(tmpdir, "test.fts5.db");
    const out = execFileSync(process.execPath, [distEntry, "index", "--vault", vault, "--index-file", indexFile], {
      encoding: "utf8"
    });
    expect(out).toMatch(/added=2 updated=0 deleted=0 unchanged=0 total_chunks=\d+/);
    expect(out).toContain(indexFile);
  });

  it("`enquire-mcp clear-index` removes db + WAL/SHM after a build", async (ctx) => {
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

  it("`enquire-mcp index --tokenize trigram` then re-run WITHOUT --tokenize PRESERVES trigram (v3.6.4 K-1 fix)", (ctx) => {
    if (!distExists()) return ctx.skip();
    if (!canRunFts5) return ctx.skip();
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
  // BEFORE the embedder load. That proves the peek-and-honor logic ran
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
    const indexFile = defaultIndexFile(realVault);
    await fs.mkdir(path.dirname(indexFile), { recursive: true });
    // Build FTS5 with trigram at the default location.
    execFileSync(process.execPath, [distEntry, "index", "--vault", vault, "--tokenize", "trigram"], {
      encoding: "utf8"
    });
    // Sanity: peek shows trigram before setup runs.
    const metaBefore = await peekFtsMetaSafe(indexFile);
    expect(metaBefore?.tokenize_mode).toBe("trigram");
    // Re-run `setup --skip-embeddings`. Pre-v3.6.4 this would silently
    // destroy trigram and rebuild as unicode61. Post-v3.6.4: preservation.
    const setupResult = spawnSync(process.execPath, [distEntry, "setup", "--vault", vault, "--skip-embeddings"], {
      encoding: "utf8"
    });
    // v3.6.4 setup emits an info line when honoring trigram. Assert via
    // combined stdout/stderr.
    const combined = (setupResult.stdout ?? "") + (setupResult.stderr ?? "");
    expect(combined).toMatch(/honoring existing tokenize_mode=trigram/);
    // The on-disk meta must still be trigram after setup.
    const metaAfter = await peekFtsMetaSafe(indexFile);
    expect(metaAfter?.tokenize_mode).toBe("trigram");
    expect(setupResult.status).toBe(0);
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

  // v3.8.0-rc.6 T-FLAKE-1 — per-it timeout MUST exceed the spawnSync
  // timeout, otherwise vitest kills the test before the subprocess
  // finishes (subprocess loads the embedder which can take 30-60s cold
  // on macOS CI). Round-23 external audit caught the mismatch: vitest
  // global testTimeout=15s vs spawnSync=60s. Per-it override to 90s
  // gives subprocess room to finish + 30s assertion budget after.
  it("`enquire-mcp build-embeddings` (no --embedding-model) HONORS existing model_alias=bge in stderr message (v3.7.0 M-1)", async (ctx) => {
    if (!distExists()) return ctx.skip();
    if (!canRunFts5) return ctx.skip();
    // build-embeddings uses embedDbPath(vault.root) — same realpath concern.
    const realVault = await fs.realpath(vault);
    const { embedDbPath } = await import("../src/tool-registry.js");
    const embedFile = embedDbPath(realVault);
    await fs.mkdir(path.dirname(embedFile), { recursive: true });
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
    // bge and rebuild as multilingual. Post-v3.6.4: peek + honor + emit
    // stderr line BEFORE embedder load.
    //
    // We don't assert exit code because the embedder may fail to load in
    // CI environments without the model cached. The stderr line is the
    // ground-truth proof that v3.6.4 peek-honor logic ran.
    const buildResult = spawnSync(process.execPath, [distEntry, "build-embeddings", "--vault", vault], {
      encoding: "utf8",
      timeout: 60_000
    });
    const stderr = buildResult.stderr ?? "";
    expect(stderr).toMatch(/honoring existing model_alias=bge/);
    // After the run (success OR embedder-load failure), the on-disk meta
    // must NOT have been silently rewritten to "multilingual".
    const metaAfter = await peekEmbedDbMeta(embedFile);
    expect(metaAfter?.model_alias).toBe("bge");
  }, 90_000);
});
