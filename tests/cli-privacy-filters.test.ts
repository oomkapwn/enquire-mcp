// v3.6.2 audit M-8 — `index` and `setup` subcommands MUST honor
// `--exclude-glob` and `--read-paths` so private content never reaches
// `.fts5.db` / `.embed.db` at rest. Pre-fix, only `serve` and
// `build-embeddings` constructed Vault with these filters; `index` and
// `setup` did not, violating the SECURITY.md "filter at indexing time"
// guarantee even though runtime search still stripped the hits.
//
// Coverage:
//   • `index --exclude-glob 'private/**'` skips files under private/
//   • `index --read-paths 'public/**'` indexes ONLY public/
//   • `setup --exclude-glob 'private/**'` (with --skip-embeddings to
//     keep the test under 5s) skips private/ in the FTS5 phase
//   • Same for `setup --read-paths 'public/**'`

import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("CLI privacy filters on `index` / `setup` (audit M-8)", () => {
  let tmpdir: string;
  let vault: string;
  let xdgCache: string;
  let canRunFts5 = true;
  const distEntry = path.resolve(__dirname, "..", "dist", "index.js");

  beforeEach(async () => {
    tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-cli-privacy-"));
    vault = path.join(tmpdir, "vault");
    xdgCache = path.join(tmpdir, "xdg-cache");
    await fs.mkdir(path.join(vault, "public"), { recursive: true });
    await fs.mkdir(path.join(vault, "private"), { recursive: true });
    await fs.mkdir(xdgCache, { recursive: true });
    await fs.writeFile(
      path.join(vault, "public", "Apollo.md"),
      "---\ntitle: Apollo\n---\n\nPublic project notes about rockets.\n"
    );
    await fs.writeFile(path.join(vault, "public", "Hermes.md"), "---\ntitle: Hermes\n---\n\nAnother public note.\n");
    await fs.writeFile(
      path.join(vault, "private", "Diary.md"),
      "---\ntitle: Diary\n---\n\nPrivate diary entry — should NEVER be indexed.\n"
    );
    // v2.0.0-beta.1 P2 fix repeated here: probe better-sqlite3 binding so
    // we don't run E2E tests that would emit scary bindings stack traces
    // when the native binary is missing (--ignore-scripts, alien platform).
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

  // v3.9.0-rc.8 (audit T1) — CI GUARD. The privacy-boundary tests below
  // soft-skip (via `ctx.skip()`) when `dist/` or better-sqlite3 is absent.
  // Pre-rc.8 they used a silent `return`, so a build-less run green-passed
  // the entire privacy-at-indexing-time security surface with ZERO
  // assertions and NO skip count to reveal it. In CI those preconditions
  // are guaranteed (ci.yml: `npm ci` → `npm run build` → `npm test`), so if
  // either is missing here, fail LOUD rather than silently skipping the
  // security tests. Outside CI (local dev without a build) this is a no-op.
  it("CI GUARD — build + better-sqlite3 present so privacy tests actually run", () => {
    if (!process.env.CI) return;
    expect(distExists(), "dist/index.js must exist in CI (npm run build runs before npm test)").toBe(true);
    expect(canRunFts5, "better-sqlite3 must load in CI so privacy-at-indexing tests execute, not silently skip").toBe(
      true
    );
  });

  it("`enquire-mcp index --exclude-glob 'private/**'` skips files under private/", (ctx) => {
    if (!distExists() || !canRunFts5) return ctx.skip();
    const indexFile = path.join(tmpdir, "denylist.fts5.db");
    const out = execFileSync(
      process.execPath,
      [distEntry, "index", "--vault", vault, "--index-file", indexFile, "--exclude-glob", "private/**"],
      { encoding: "utf8" }
    );
    // Vault has 3 .md files; --exclude-glob 'private/**' drops 1 → added=2.
    expect(out).toMatch(/added=2 /);
    expect(out).not.toMatch(/added=3 /);
  });

  it("`enquire-mcp index --read-paths 'public/**'` indexes ONLY public/", (ctx) => {
    if (!distExists() || !canRunFts5) return ctx.skip();
    const indexFile = path.join(tmpdir, "allowlist.fts5.db");
    const out = execFileSync(
      process.execPath,
      [distEntry, "index", "--vault", vault, "--index-file", indexFile, "--read-paths", "public/**"],
      { encoding: "utf8" }
    );
    expect(out).toMatch(/added=2 /);
    expect(out).not.toMatch(/added=3 /);
  });

  it("`enquire-mcp index` without filters indexes everything (baseline sanity)", (ctx) => {
    if (!distExists() || !canRunFts5) return ctx.skip();
    const indexFile = path.join(tmpdir, "baseline.fts5.db");
    const out = execFileSync(process.execPath, [distEntry, "index", "--vault", vault, "--index-file", indexFile], {
      encoding: "utf8"
    });
    // No filter → all 3 indexed.
    expect(out).toMatch(/added=3 /);
  });

  it("`enquire-mcp setup --exclude-glob 'private/**' --skip-embeddings` skips private/ in FTS5 phase", (ctx) => {
    if (!distExists() || !canRunFts5) return ctx.skip();
    const out = execFileSync(
      process.execPath,
      [
        distEntry,
        "setup",
        "--vault",
        vault,
        "--exclude-glob",
        "private/**",
        // Skip the embedding phase: it would download a model on first
        // call and blow past any reasonable test budget. The FTS5 step
        // is enough to assert M-8 behavior.
        "--skip-embeddings"
      ],
      { encoding: "utf8", env: { ...process.env, XDG_CACHE_HOME: xdgCache } }
    );
    // FTS5 step prints `added=N` — must be 2 with private/ excluded.
    expect(out).toMatch(/added=2 /);
    expect(out).not.toMatch(/added=3 /);
  });

  it("`enquire-mcp setup --read-paths 'public/**' --skip-embeddings` indexes ONLY public/", (ctx) => {
    if (!distExists() || !canRunFts5) return ctx.skip();
    const out = execFileSync(
      process.execPath,
      [distEntry, "setup", "--vault", vault, "--read-paths", "public/**", "--skip-embeddings"],
      { encoding: "utf8", env: { ...process.env, XDG_CACHE_HOME: xdgCache } }
    );
    expect(out).toMatch(/added=2 /);
    expect(out).not.toMatch(/added=3 /);
  });

  it("`enquire-mcp setup --skip-embeddings` without filters indexes everything (baseline sanity)", (ctx) => {
    if (!distExists() || !canRunFts5) return ctx.skip();
    const out = execFileSync(process.execPath, [distEntry, "setup", "--vault", vault, "--skip-embeddings"], {
      encoding: "utf8",
      env: { ...process.env, XDG_CACHE_HOME: xdgCache }
    });
    expect(out).toMatch(/added=3 /);
  });
});
