// v3.8.5 — End-to-end handler tests (T-2, T-3, T-4).
//
// Background: smoke.mjs already E2E-tests several read tools by spawning
// dist/index.js + JSON-RPC. But these three were listed as backlog items
// in v3.8.0 because they need additional setup (synthetic graph for T-2,
// optional embedder for T-3, HTTP transport for T-4) that the basic smoke
// test skipped.
//
// Pattern: spawn dist/, do MCP initialize handshake, call the target
// tool via tools/call RPC, assert response structure. Same shape as
// scripts/smoke.mjs check helpers.
//
// Skip behavior: if dist/index.js isn't built (e.g. running tests against
// fresh checkout without `npm run build`), tests skip gracefully — same
// pattern as cli.test.ts `if (!distExists()) return`.

import { spawn } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "..");
const distEntry = path.join(repoRoot, "dist", "index.js");

function distExists(): boolean {
  return existsSync(distEntry);
}

interface RpcClient {
  rpc: (method: string, params?: unknown) => Promise<{ result?: unknown; error?: { message?: string } }>;
  close: () => void;
}

/** Spawn `enquire-mcp serve --vault <path>` and return a JSON-RPC client.
 *  Mirrors the smoke.mjs handshake pattern but reusable across tests. */
async function spawnServer(vaultPath: string, extraArgs: string[] = []): Promise<RpcClient> {
  const args = [distEntry, "serve", "--vault", vaultPath, "--diagnostic-search-tools", ...extraArgs];
  const proc = spawn("node", args, { stdio: ["pipe", "pipe", "pipe"] });
  let buf = "";
  type RpcMsg = { result?: unknown; error?: { message?: string } };
  const pending = new Map<number, { resolve: (m: RpcMsg) => void; reject: (e: Error) => void }>();
  proc.stdout.on("data", (d) => {
    buf += d.toString();
    while (true) {
      const nl = buf.indexOf("\n");
      if (nl === -1) break;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (typeof msg.id === "number" && pending.has(msg.id)) {
          const { resolve } = pending.get(msg.id) ?? {};
          pending.delete(msg.id);
          resolve?.(msg);
        }
      } catch {
        // ignore non-JSON lines (banner etc.)
      }
    }
  });
  let nextId = 1;
  const rpc = (method: string, params?: unknown): Promise<{ result?: unknown; error?: { message?: string } }> => {
    const id = nextId++;
    const payload = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      proc.stdin.write(payload);
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`Timeout on ${method}`));
        }
      }, 20000);
    });
  };
  // Initialize handshake.
  await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "e2e-test", version: "0.0.1" }
  });
  proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  return {
    rpc,
    close: () => {
      try {
        proc.kill();
      } catch {
        // ignore
      }
    }
  };
}

/** Create a synthetic vault with wikilink structure. Returns the vault root path.
 *  Used by T-2 (communities) — needs a known graph for community detection. */
async function makeWikilinkVault(name: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `enquire-e2e-${name}-`));
  // Two clusters: {A, B, C} interlinked, {X, Y, Z} interlinked, with one bridge A↔X.
  // Louvain should detect 2 communities with high modularity.
  const notes: Record<string, string> = {
    "A.md": "# A\n\nLinks: [[B]] [[C]] [[X]]\n",
    "B.md": "# B\n\nLinks: [[A]] [[C]]\n",
    "C.md": "# C\n\nLinks: [[A]] [[B]]\n",
    "X.md": "# X\n\nLinks: [[Y]] [[Z]] [[A]]\n",
    "Y.md": "# Y\n\nLinks: [[X]] [[Z]]\n",
    "Z.md": "# Z\n\nLinks: [[X]] [[Y]]\n"
  };
  for (const [rel, body] of Object.entries(notes)) {
    await fs.writeFile(path.join(dir, rel), body);
  }
  return dir;
}

/** Create a synthetic vault with content suitable for HyDE retrieval testing.
 *  Used by T-3 (HyDE) — needs notes with distinct semantic topics. */
async function makeSemanticVault(name: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `enquire-e2e-${name}-`));
  const notes: Record<string, string> = {
    "Cooking.md": "# Cooking\n\nRecipes for pasta, bread, and sauces. Italian cuisine basics.\n",
    "Music.md": "# Music\n\nClassical music history. Beethoven and Mozart symphonies.\n",
    "Code.md": "# Code\n\nTypeScript programming patterns. React hooks and state management.\n"
  };
  for (const [rel, body] of Object.entries(notes)) {
    await fs.writeFile(path.join(dir, rel), body);
  }
  return dir;
}

/** Pick a free TCP port for HTTP smoke. */
async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("Could not get port")));
      }
    });
  });
}

// ─── T-2: communities handler E2E ─────────────────────────────────────
describe("T-2 — obsidian_get_communities E2E (v3.8.5)", () => {
  let vault: string;
  let client: RpcClient | null = null;
  // v3.9.0-rc.23 — CI-GUARD: ci.yml builds dist/ before `npm test`, so these
  // E2E handler tests (incl. the 401-without-bearer auth check) MUST run, not
  // silently `return` on a missing build. Fail loud if dist is absent in CI.
  beforeAll(async () => {
    if (!distExists()) return;
    vault = await makeWikilinkVault("comm");
    client = await spawnServer(vault);
  }, 30000);
  // v3.9.0-rc.23 / v3.10.0-rc.22 (audit M8b) — CI-GUARD: ci.yml builds dist/
  // before `npm test`, so these E2E handler tests MUST run, not silently `return`
  // on a missing build OR a failed spawn. rc.22 strengthened this from
  // distExists-only to ALSO assert the server actually spawned (client non-null),
  // so a spawn failure in CI fails loud here instead of making every test body's
  // `if (!client) return` skip the whole suite vacuously.
  it("CI GUARD — dist built + server spawned in CI so E2E tests actually run", () => {
    if (!process.env.CI) return;
    expect(distExists(), "dist/index.js must exist in CI (npm run build precedes npm test)").toBe(true);
    expect(client, "serve must spawn in CI so the E2E test bodies run (not silently skip)").not.toBeNull();
  });
  afterAll(async () => {
    client?.close();
    if (vault) await fs.rm(vault, { recursive: true, force: true });
  });

  it("returns 2 communities on a planted 2-cluster graph with high modularity", async () => {
    if (!distExists() || !client) return;
    const res = await client.rpc("tools/call", {
      name: "obsidian_get_communities",
      arguments: {}
    });
    expect(res.error, JSON.stringify(res.error)).toBeUndefined();
    const text = res.result?.content?.[0]?.text;
    expect(text, "no text content in response").toBeDefined();
    const parsed = JSON.parse(text);
    expect(parsed.community_count, JSON.stringify(parsed)).toBeGreaterThanOrEqual(2);
    expect(parsed.modularity).toBeGreaterThan(0.2); // planted clusters should give strong structure
    expect(Array.isArray(parsed.communities)).toBe(true);
    expect(parsed.node_count).toBe(6);
    // v3.9.0-rc.16 — the convergence flag is surfaced to MCP callers (a small
    // planted graph converges well before the 50-pass cap).
    expect(parsed.converged).toBe(true);
    // Each community has the required fields.
    for (const c of parsed.communities) {
      expect(typeof c.id).toBe("number");
      expect(typeof c.size).toBe("number");
      expect(Array.isArray(c.members)).toBe(true);
      expect(typeof c.representative).toBe("string");
    }
    // Membership keys cover all 6 notes (or close — some may be filtered if min_size > 1).
    expect(Object.keys(parsed.membership).length).toBeGreaterThanOrEqual(6);
  });

  it("min_size filter drops singletons (NEGATIVE control — exercises min_size arg path)", async () => {
    if (!distExists() || !client) return;
    // With min_size=10, no community is large enough → empty communities array,
    // but counts/modularity still computed.
    const res = await client.rpc("tools/call", {
      name: "obsidian_get_communities",
      arguments: { min_size: 10 }
    });
    const parsed = JSON.parse(res.result?.content?.[0]?.text ?? "{}");
    expect(parsed.communities).toEqual([]);
    expect(parsed.community_count).toBeGreaterThanOrEqual(2); // raw count before filter
  });
});

// ─── T-3: HyDE search E2E ─────────────────────────────────────────────
//
// HyDE needs an embedder to embed the hypothetical answer. The embedder
// model is downloaded on first call (~120 MB from HuggingFace), too slow
// for default CI. Gate behind ENQUIRE_LOAD_HYDE_E2E=1 — same pattern as
// reranker-smoke.test.ts (which skips unless ENQUIRE_LOAD_RERANKER_SMOKE=1).
//
// Without the gate, the test asserts that hyde_search RETURNS a structured
// error (not a crash) when no embed-db exists. That's the cheap-path check.
describe("T-3 — obsidian_hyde_search E2E (v3.8.5)", () => {
  let vault: string;
  let client: RpcClient | null = null;
  beforeAll(async () => {
    if (!distExists()) return;
    vault = await makeSemanticVault("hyde");
    client = await spawnServer(vault);
  }, 30000);
  afterAll(async () => {
    client?.close();
    if (vault) await fs.rm(vault, { recursive: true, force: true });
  });

  // v3.10.0-rc.22 (audit M8b) — CI-GUARD: T-3 had none (rc.23's propagation
  // missed it). dist built + server spawned in CI, else the test bodies' `if
  // (!client) return` would skip the whole HyDE suite vacuously.
  it("CI GUARD — dist built + server spawned in CI so E2E tests actually run", () => {
    if (!process.env.CI) return;
    expect(distExists(), "dist/index.js must exist in CI").toBe(true);
    expect(client, "serve must spawn in CI so the HyDE E2E test bodies run").not.toBeNull();
  });

  it("returns a guidance error when no embed-db exists (cheap-path check)", async () => {
    if (!distExists() || !client) return;
    const res = await client.rpc("tools/call", {
      name: "obsidian_hyde_search",
      arguments: {
        query: "What music did Beethoven compose?",
        hypothetical_answer: "Beethoven composed nine symphonies and many piano sonatas."
      }
    });
    // Expect either:
    //   (a) error response with guidance about missing embed-db, OR
    //   (b) result with text content (plain string guidance OR JSON with matches)
    // Either way, no crash. We're testing the handler doesn't blow up when
    // there's nothing to search against (cold-vault path).
    if (res.error) {
      expect(res.error.message ?? "").toMatch(/embed|model|index|build/i);
      return;
    }
    const text = res.result?.content?.[0]?.text ?? "";
    expect(text.length).toBeGreaterThan(0);
    // Response might be plain-text guidance ("Embedding model not found ...")
    // OR JSON ({matches: [...], ...}). Both are valid no-crash responses;
    // assert SOMETHING informative is returned.
    expect(text).toMatch(/embed|model|index|matches|build|loaded|guidance/i);
  });

  // Full E2E with real embedder — gated behind env var to avoid CI model download.
  it.skipIf(!process.env.ENQUIRE_LOAD_HYDE_E2E)("returns hits with real embedder (gated)", async () => {
    if (!distExists() || !client) return;
    // Pre-requisite: a previous run did `enquire-mcp build-embeddings --vault <vault>`
    // so embed-db exists. This test asserts the HyDE path actually works
    // when the model is loadable.
    const res = await client.rpc("tools/call", {
      name: "obsidian_hyde_search",
      arguments: {
        query: "music",
        hypothetical_answer: "Beethoven composed many symphonies in classical style."
      }
    });
    const text = res.result?.content?.[0]?.text ?? "";
    const parsed = JSON.parse(text);
    expect(Array.isArray(parsed.matches)).toBe(true);
    // Should rank Music.md higher than Cooking.md / Code.md for music query.
    if (parsed.matches.length > 0) {
      expect(parsed.matches[0].path).toMatch(/Music/);
    }
  });
});

// ─── T-4: serve-http HTTP smoke ───────────────────────────────────────
//
// Spawns `enquire-mcp serve-http --vault <path> --bearer-token <tok>`,
// waits for it to bind to its port, makes one HTTP request to confirm
// it speaks JSON-RPC over Streamable HTTP. Closes the subprocess after.
describe("T-4 — serve-http HTTP smoke (v3.8.5)", () => {
  let proc: ReturnType<typeof spawn> | null = null;
  let port: number = 0;
  let vault: string;
  const BEARER = "test-token-e2e-t4";

  beforeAll(async () => {
    if (!distExists()) return;
    vault = await makeSemanticVault("http");
    port = await pickFreePort();
    proc = spawn(
      "node",
      [
        distEntry,
        "serve-http",
        "--vault",
        vault,
        "--port",
        String(port),
        "--host",
        "127.0.0.1",
        "--bearer-token",
        BEARER
      ],
      { stdio: ["pipe", "pipe", "pipe"] }
    );
    // Wait for "Listening" log or ~3s startup
    await new Promise<void>((resolve) => {
      const onStderr = (d: Buffer) => {
        if (d.toString().includes("Listening") || d.toString().includes("listening")) {
          proc?.stderr?.off("data", onStderr);
          resolve();
        }
      };
      proc?.stderr?.on("data", onStderr);
      setTimeout(resolve, 3000); // fallback if no log
    });
  }, 30000);

  afterAll(async () => {
    try {
      proc?.kill();
    } catch {
      // ignore
    }
    if (vault) await fs.rm(vault, { recursive: true, force: true });
  });

  // v3.10.0-rc.22 (audit M8b) — CI-GUARD: T-4 had none. Every test body below
  // does `if (!distExists() || !proc) return` — including the 401-no-bearer auth
  // check — so a failed serve-http spawn in CI would silently skip the whole
  // HTTP suite. Assert dist built + process spawned + a port bound in CI.
  it("CI GUARD — dist built + serve-http spawned in CI so E2E tests actually run", () => {
    if (!process.env.CI) return;
    expect(distExists(), "dist/index.js must exist in CI").toBe(true);
    expect(proc, "serve-http must spawn in CI so the HTTP E2E test bodies (incl. 401 auth) run").not.toBeNull();
    expect(port, "serve-http must bind a port in CI").toBeGreaterThan(0);
  });

  it("health endpoint returns 200 OK", async () => {
    if (!distExists() || !proc) return;
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
  });

  it("MCP endpoint rejects requests without bearer token (401)", async () => {
    if (!distExists() || !proc) return;
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    });
    expect(res.status).toBe(401);
  });

  it("MCP initialize succeeds with valid bearer token", async () => {
    if (!distExists() || !proc) return;
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${BEARER}`
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "t4-smoke", version: "0.0.1" }
        }
      })
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    // Response may be SSE stream or single JSON; both contain server info.
    expect(text).toMatch(/serverInfo|enquire-mcp/);
  });
});

// ─── FTS5 fail-soft on --persistent-index open failure (v3.10.0-rc.33) ───────
// Post-rc.31 audit: a pruned/broken better-sqlite3 + `--persistent-index` used
// to HARD-CRASH serve startup (re-throw). Now it degrades to TF-IDF — parity
// with the embed-db / PDF / HNSW fail-soft paths and the "auto-degrades
// gracefully: works with any subset of signals" guarantee. We force the failure
// with better-sqlite3 PRESENT by pointing --index-file at a DIRECTORY (a dir
// can't be opened as a SQLite DB → `ftsIndex.open()` throws). Pre-fix, serve
// crashed → the spawnServer initialize handshake would time out → client null.
describe("FTS5 fail-soft on --persistent-index open failure (v3.10.0-rc.33)", () => {
  let client: RpcClient | null = null;
  beforeAll(async () => {
    if (!distExists()) return;
    const vault = await makeSemanticVault("fts-failsoft");
    const badIndex = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-bad-ftsindex-"));
    try {
      client = await spawnServer(vault, ["--persistent-index", "--index-file", badIndex]);
    } catch {
      client = null; // pre-fix: startup crash → initialize times out → reject
    }
  });
  afterAll(() => client?.close());

  it("CI GUARD — serve still came up (degraded to TF-IDF) despite the unopenable FTS5 index", () => {
    if (!distExists()) return;
    expect(
      client,
      "serve must complete the MCP handshake despite --persistent-index open failure (fail-soft to TF-IDF)"
    ).not.toBeNull();
  });

  it("tools/list still answers with the umbrella obsidian_search (degraded, not crashed)", async () => {
    if (!client) return;
    const res = await client.rpc("tools/list", {});
    const tools = (res.result as { tools?: { name: string }[] } | undefined)?.tools ?? [];
    expect(tools.some((t) => t.name === "obsidian_search")).toBe(true);
  });
});
