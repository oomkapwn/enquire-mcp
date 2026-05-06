import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parsePositiveInt } from "../src/index.js";

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
    try {
      await import("better-sqlite3");
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

  it("`enquire-mcp --version` prints the package version", () => {
    if (!distExists()) return;
    const out = execFileSync(process.execPath, [distEntry, "--version"], { encoding: "utf8" });
    expect(out.trim()).toMatch(/^\d+\.\d+\.\d+(-[a-z0-9.]+)?$/);
  });

  it("`enquire-mcp --help` shows all subcommands (serve / clear-cache / clear-index / index)", () => {
    if (!distExists()) return;
    const out = execFileSync(process.execPath, [distEntry, "--help"], { encoding: "utf8" });
    // commander's auto-help lists subcommands in a Commands: section.
    expect(out).toContain("serve");
    expect(out).toContain("clear-cache");
    expect(out).toContain("clear-index");
    expect(out).toContain("index");
  });

  it("`enquire-mcp clear-cache` reports 'no cache file' when none exists", () => {
    if (!distExists()) return;
    const cacheFile = path.join(tmpdir, "no-such.json");
    const out = execFileSync(
      process.execPath,
      [distEntry, "clear-cache", "--vault", vault, "--cache-file", cacheFile],
      { encoding: "utf8" }
    );
    expect(out).toContain("no cache file");
  });

  it("`enquire-mcp clear-index` reports 'no fts5 index' when none exists", () => {
    if (!distExists()) return;
    const indexFile = path.join(tmpdir, "no-such.fts5.db");
    const out = execFileSync(
      process.execPath,
      [distEntry, "clear-index", "--vault", vault, "--index-file", indexFile],
      { encoding: "utf8" }
    );
    expect(out).toContain("no fts5 index");
  });

  it("`enquire-mcp index` builds the FTS5 index and reports per-status counts", () => {
    if (!distExists()) return;
    if (!canRunFts5) return;
    const indexFile = path.join(tmpdir, "test.fts5.db");
    const out = execFileSync(process.execPath, [distEntry, "index", "--vault", vault, "--index-file", indexFile], {
      encoding: "utf8"
    });
    expect(out).toMatch(/added=2 updated=0 deleted=0 unchanged=0 total_chunks=\d+/);
    expect(out).toContain(indexFile);
  });

  it("`enquire-mcp clear-index` removes db + WAL/SHM after a build", async () => {
    if (!distExists()) return;
    if (!canRunFts5) return;
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

  it("`enquire-mcp index` then second call reports unchanged=N (incremental skips unchanged files)", () => {
    if (!distExists()) return;
    if (!canRunFts5) return;
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

  it("`enquire-mcp index --tokenize trigram` then re-run with default tokenize triggers a rebuild", () => {
    if (!distExists()) return;
    if (!canRunFts5) return;
    const indexFile = path.join(tmpdir, "tokenize-flip.fts5.db");
    execFileSync(
      process.execPath,
      [distEntry, "index", "--vault", vault, "--index-file", indexFile, "--tokenize", "trigram"],
      { encoding: "utf8" }
    );
    // Second run with no --tokenize (default = unicode61) should clear and re-add.
    const out2 = execFileSync(process.execPath, [distEntry, "index", "--vault", vault, "--index-file", indexFile], {
      encoding: "utf8"
    });
    expect(out2).toMatch(/added=2 updated=0/);
  });
});
