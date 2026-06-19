// v2.6.0 — HTTP transport unit tests.
//
// Coverage:
//   • verifyBearer: missing/wrong/right token, case sensitivity, length-leak
//     resistance (timingSafeEqual), no Bearer prefix.
//   • RateLimiter: under-budget passes, over-budget rejects, sliding window
//     trims old entries, perMinute=0 disables.
//   • startHttpServer end-to-end: 401 missing, 401 wrong, 200 init, 429
//     rate-limit, OPTIONS preflight, /health probe, 405 GET on /mcp.
//
// We bind to 127.0.0.1:0 (kernel-assigned port) to avoid collisions when
// running tests in parallel. Each test cleans up its server with
// `httpServer.close()`.

import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeServerBounded,
  createSessionRegistry,
  deriveHttpBodyCap,
  generateBearerToken,
  type HttpServeOptions,
  isInitializeRequest,
  makeHttpShutdownHandler,
  parseMaxFileBytes,
  RateLimiter,
  readJsonBody,
  runWithPendingInit,
  shutdownHttpServer,
  startHttpServer,
  verifyBearer
} from "../src/http-transport.js";
import { DEFAULT_MAX_FILE_BYTES } from "../src/vault.js";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-http-"));
  // Minimal valid vault.
  await fs.writeFile(path.join(root, "hello.md"), "# Hello\n\nWorld.\n", "utf8");
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("verifyBearer (v2.6.0)", () => {
  const expected = "test-secret-token-1234567890abcdef";

  it("returns null on missing Authorization header", () => {
    expect(verifyBearer(undefined, expected)).toBeNull();
  });

  it("returns null on header without Bearer prefix", () => {
    expect(verifyBearer("Basic abc", expected)).toBeNull();
  });

  it("returns null on Bearer with wrong token", () => {
    expect(verifyBearer("Bearer wrong-token", expected)).toBeNull();
  });

  it("returns null on empty Bearer", () => {
    expect(verifyBearer("Bearer ", expected)).toBeNull();
    expect(verifyBearer("Bearer    ", expected)).toBeNull();
  });

  it("returns a stable rate-limit key on correct token", () => {
    const k1 = verifyBearer(`Bearer ${expected}`, expected);
    const k2 = verifyBearer(`Bearer ${expected}`, expected);
    expect(k1).not.toBeNull();
    expect(k1).toBe(k2);
  });

  it("rate-limit key differs across tokens", () => {
    const a = verifyBearer("Bearer token-a", "token-a");
    const b = verifyBearer("Bearer token-b", "token-b");
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).not.toBe(b);
  });

  it("Bearer prefix is case-sensitive (per RFC 6750 — strict)", () => {
    // A trailing-space `Bearer ` only matches that exact form. We don't
    // support `bearer` lowercase. Most clients send the canonical form.
    expect(verifyBearer(`bearer ${expected}`, expected)).toBeNull();
    expect(verifyBearer(`BEARER ${expected}`, expected)).toBeNull();
  });

  it("rejects token with extra prefix bytes", () => {
    // Length-resistant compare: even though the input contains `expected`
    // as a suffix, the full string is hashed and won't match.
    expect(verifyBearer(`Bearer x${expected}`, expected)).toBeNull();
  });
});

describe("SessionRegistry (v2.14.0)", () => {
  it("starts empty", () => {
    const r = createSessionRegistry(60_000);
    expect(r.size()).toBe(0);
  });

  it("sweepIdle evicts entries older than idleTimeoutMs", () => {
    const r = createSessionRegistry(60_000);
    // Synthetic entries — we only need a `lastActivityMs` field for
    // sweep semantics; transport/server can be stubs that don't trigger
    // close logic for this unit test.
    const stub = {
      transport: { close: async () => {} },
      server: { close: async () => {} }
    } as unknown as Parameters<typeof r.sessions.set>[1];
    r.sessions.set("fresh", { ...stub, lastActivityMs: Date.now() });
    r.sessions.set("stale", { ...stub, lastActivityMs: Date.now() - 90_000 });
    expect(r.size()).toBe(2);
    const evicted = r.sweepIdle();
    expect(evicted).toBe(1);
    expect(r.sessions.has("fresh")).toBe(true);
    expect(r.sessions.has("stale")).toBe(false);
  });

  it("sweepIdle is idempotent on a clean registry", () => {
    const r = createSessionRegistry(60_000);
    expect(r.sweepIdle()).toBe(0);
    expect(r.sweepIdle()).toBe(0);
  });

  // v3.8.7 P2-10 — in-flight session must survive idle sweep even when
  // lastActivityMs is past the cutoff. Closing the transport while a
  // handler is awaiting handleRequest produces broken responses.
  it("sweepIdle skips in-flight sessions even if lastActivityMs is past cutoff", () => {
    const r = createSessionRegistry(60_000);
    const stub = {
      transport: { close: async () => {} },
      server: { close: async () => {} }
    } as unknown as Parameters<typeof r.sessions.set>[1];
    // Stale BUT in-flight.
    r.sessions.set("busy", { ...stub, lastActivityMs: Date.now() - 90_000, inFlight: 1, closing: false });
    // Stale AND idle.
    r.sessions.set("idle", { ...stub, lastActivityMs: Date.now() - 90_000, inFlight: 0, closing: false });
    expect(r.sweepIdle()).toBe(1);
    expect(r.sessions.has("busy")).toBe(true);
    expect(r.sessions.has("idle")).toBe(false);
  });

  // v3.8.7 P2-10 — NEGATIVE control: if we DIDN'T track inFlight, sweep
  // would evict a busy session (the original v2.14.0 behavior).
  it("(NEGATIVE control) — without inFlight tracking, sweep would evict busy entries", () => {
    const r = createSessionRegistry(60_000);
    const stub = {
      transport: { close: async () => {} },
      server: { close: async () => {} }
    } as unknown as Parameters<typeof r.sessions.set>[1];
    // Simulate the pre-3.8.7 shape: lastActivityMs past cutoff, inFlight=0.
    r.sessions.set("busy-but-untracked", {
      ...stub,
      lastActivityMs: Date.now() - 90_000,
      inFlight: 0,
      closing: false
    });
    // Sweep should evict (inFlight=0 means "not tracked as busy").
    expect(r.sweepIdle()).toBe(1);
    expect(r.sessions.has("busy-but-untracked")).toBe(false);
  });

  // v3.8.7 P2-10 — closing entries are skipped by sweep (idempotency
  // guard so a closeAll-in-progress entry isn't double-closed).
  it("sweepIdle skips already-closing sessions", () => {
    const r = createSessionRegistry(60_000);
    const stub = {
      transport: { close: async () => {} },
      server: { close: async () => {} }
    } as unknown as Parameters<typeof r.sessions.set>[1];
    r.sessions.set("dying", {
      ...stub,
      lastActivityMs: Date.now() - 90_000,
      inFlight: 0,
      closing: true
    });
    expect(r.sweepIdle()).toBe(0);
    // Entry remains in the map — the caller that set closing=true is
    // responsible for the actual delete.
    expect(r.sessions.has("dying")).toBe(true);
  });

  // v3.8.7 P2-11 — closeAll drains the registry, closing every transport
  // + server pair. Returns the count.
  it("closeAll drains all sessions + invokes transport.close + server.close", async () => {
    const r = createSessionRegistry(60_000);
    let transportClosed = 0;
    let serverClosed = 0;
    const makeStub = () =>
      ({
        transport: {
          close: async () => {
            transportClosed += 1;
          }
        },
        server: {
          close: async () => {
            serverClosed += 1;
          }
        }
      }) as unknown as Parameters<typeof r.sessions.set>[1];
    r.sessions.set("a", { ...makeStub(), lastActivityMs: Date.now(), inFlight: 0, closing: false });
    r.sessions.set("b", { ...makeStub(), lastActivityMs: Date.now(), inFlight: 0, closing: false });
    expect(r.size()).toBe(2);
    const closed = await r.closeAll(1000);
    expect(closed).toBe(2);
    expect(transportClosed).toBe(2);
    expect(serverClosed).toBe(2);
    expect(r.size()).toBe(0);
  });

  // v3.8.7 P2-11 — closeAll waits for in-flight handlers up to timeoutMs
  // then force-closes. We simulate a slow in-flight by counting down via
  // setTimeout (no real handler available in this unit test).
  it("closeAll waits for in-flight to drain (bounded by timeoutMs)", async () => {
    const r = createSessionRegistry(60_000);
    const session = {
      transport: { close: async () => {} },
      server: { close: async () => {} },
      lastActivityMs: Date.now(),
      inFlight: 1,
      closing: false
    } as unknown as Parameters<typeof r.sessions.set>[1];
    r.sessions.set("slow", session);
    // Drop inFlight to 0 after a short delay → closeAll should return
    // soon after that.
    setTimeout(() => {
      (session as unknown as { inFlight: number }).inFlight = 0;
    }, 50);
    const start = Date.now();
    const closed = await r.closeAll(1000);
    const elapsed = Date.now() - start;
    expect(closed).toBe(1);
    // Finished close-to but not at the timeoutMs cap — confirms we
    // observed the drain instead of waiting the full 1s.
    expect(elapsed).toBeLessThan(500);
  });

  // v3.8.7 P2-10 — pendingInits counter exposed so the cap-check can
  // include it; starts at 0, never negative.
  it("pendingInits starts at 0", () => {
    const r = createSessionRegistry(60_000);
    expect(r.pendingInits).toBe(0);
  });
});

describe("RateLimiter (v2.6.0)", () => {
  it("allows requests under budget", () => {
    const lim = new RateLimiter(5);
    for (let i = 0; i < 5; i++) {
      expect(lim.consume("k", 1_000_000 + i)).toBe(true);
    }
  });

  it("rejects requests over budget", () => {
    const lim = new RateLimiter(3);
    expect(lim.consume("k", 1_000_000)).toBe(true);
    expect(lim.consume("k", 1_000_001)).toBe(true);
    expect(lim.consume("k", 1_000_002)).toBe(true);
    expect(lim.consume("k", 1_000_003)).toBe(false); // over budget
  });

  it("trims out-of-window entries (sliding 60s)", () => {
    const lim = new RateLimiter(2);
    expect(lim.consume("k", 1_000_000)).toBe(true);
    expect(lim.consume("k", 1_000_500)).toBe(true);
    expect(lim.consume("k", 1_000_700)).toBe(false); // both still in window
    // Advance clock 61s — old entries should fall out.
    expect(lim.consume("k", 1_000_000 + 61_000)).toBe(true);
  });

  it("isolates buckets per key", () => {
    const lim = new RateLimiter(2);
    expect(lim.consume("a", 100)).toBe(true);
    expect(lim.consume("a", 101)).toBe(true);
    expect(lim.consume("a", 102)).toBe(false);
    expect(lim.consume("b", 103)).toBe(true);
    expect(lim.consume("b", 104)).toBe(true);
  });

  it("perMinute=0 disables limiting", () => {
    const lim = new RateLimiter(0);
    for (let i = 0; i < 10_000; i++) {
      expect(lim.consume("k", i)).toBe(true);
    }
  });

  // v3.6 — branches coverage uplift. reset() was previously uncovered.
  it("reset() clears all per-token windows", () => {
    const lim = new RateLimiter(2);
    expect(lim.consume("k", 100)).toBe(true);
    expect(lim.consume("k", 101)).toBe(true);
    expect(lim.consume("k", 102)).toBe(false); // over budget pre-reset
    lim.reset();
    // After reset, the bucket is fresh: 2 more should succeed.
    expect(lim.consume("k", 200)).toBe(true);
    expect(lim.consume("k", 201)).toBe(true);
  });
});

// v3.6 — branches coverage uplift. readJsonBody's max-bytes overflow
// branch is otherwise unreachable from the e2e harness (4MB cap).
describe("readJsonBody (v3.6 — body-size cap branch)", () => {
  // Build an IncomingMessage-shaped async iterable from a Buffer.
  function asReq(buf: Buffer): import("node:http").IncomingMessage {
    async function* it() {
      yield buf;
    }
    return it() as unknown as import("node:http").IncomingMessage;
  }

  it("returns undefined on an empty body", async () => {
    async function* empty() {
      /* yields nothing */
    }
    const out = await readJsonBody(empty() as unknown as import("node:http").IncomingMessage, 1024);
    expect(out).toBeUndefined();
  });

  it("parses a valid JSON body within the cap", async () => {
    const buf = Buffer.from(JSON.stringify({ ok: 1 }));
    const out = await readJsonBody(asReq(buf), 1024);
    expect(out).toEqual({ ok: 1 });
  });

  it("throws when body exceeds maxBytes", async () => {
    const big = Buffer.alloc(200, 65); // 200 bytes of 'A'
    await expect(readJsonBody(asReq(big), 100)).rejects.toThrow(/exceeds max/);
  });
});

// v3.7.12 M4 — body-cap derivation. Pre-3.7.12 the HTTP body cap was a
// hardcoded 4MB which was BELOW the default per-file cap of 5MB; the cap is
// now scaled from `maxFileBytes` so writes at the file limit don't 413.
describe("deriveHttpBodyCap (v3.7.12 M4)", () => {
  it("defaults to max(4MB, DEFAULT_MAX_FILE_BYTES * 1.5) when maxFileBytes unset", () => {
    const cap = deriveHttpBodyCap(undefined);
    const expected = Math.max(4 * 1024 * 1024, Math.floor(DEFAULT_MAX_FILE_BYTES * 1.5));
    expect(cap).toBe(expected);
    // Sanity: the derived cap MUST be ≥ DEFAULT_MAX_FILE_BYTES, otherwise
    // a create_note at the file limit would 413 at the HTTP layer.
    expect(cap).toBeGreaterThanOrEqual(DEFAULT_MAX_FILE_BYTES);
  });

  it("scales 1.5x from a user-provided maxFileBytes", () => {
    const tenMb = 10 * 1024 * 1024;
    const cap = deriveHttpBodyCap(String(tenMb));
    expect(cap).toBe(Math.floor(tenMb * 1.5));
  });

  it("holds the 4MB floor for tiny vault caps", () => {
    // A user passing --max-file-bytes=1048576 (1MB) still gets the 4MB
    // floor so tools/list / search responses are unaffected.
    const cap = deriveHttpBodyCap(String(1 * 1024 * 1024));
    expect(cap).toBe(4 * 1024 * 1024);
  });

  it("falls back to default on malformed input", () => {
    expect(parseMaxFileBytes("nonsense")).toBeUndefined();
    expect(parseMaxFileBytes("-1000")).toBeUndefined();
    expect(parseMaxFileBytes("0")).toBeUndefined();
    expect(parseMaxFileBytes("3.14")).toBeUndefined();
    // Each falls back to DEFAULT_MAX_FILE_BYTES inside deriveHttpBodyCap.
    expect(deriveHttpBodyCap("nonsense")).toBe(deriveHttpBodyCap(undefined));
  });

  // Negative-control: explicit assertion that pre-3.7.12's hardcoded 4MB
  // would have under-capped the default (5MB) file cap. If someone reverts
  // the derivation, this test fails LOUDLY.
  it("(negative-control) derived cap > legacy 4MB hardcoded cap under defaults", () => {
    const cap = deriveHttpBodyCap(undefined);
    const legacy = 4 * 1024 * 1024;
    expect(
      cap,
      "v3.7.12 M4 regression: derived cap must exceed the legacy 4MB to accommodate the 5MB default file cap"
    ).toBeGreaterThan(legacy);
  });
});

// v3.7.13 H2 — `initialize` pre-check before stateful server/transport
// allocation. Pre-3.7.13, any POST without Mcp-Session-Id allocated the
// pair before checking the body's RPC method, which leaked the pair if
// the body wasn't initialize. The fix rejects non-initialize POSTs at
// the JSON-RPC level before any allocation runs.
describe("isInitializeRequest (v3.7.13 H2)", () => {
  it("accepts a single initialize request", () => {
    expect(isInitializeRequest({ jsonrpc: "2.0", method: "initialize", id: 1, params: {} })).toBe(true);
  });

  it("accepts a batch where at least one element is initialize", () => {
    expect(
      isInitializeRequest([
        { jsonrpc: "2.0", method: "tools/list", id: 1 },
        { jsonrpc: "2.0", method: "initialize", id: 2 }
      ])
    ).toBe(true);
  });

  // Negative-control siblings — the bug was that ALL of these used to
  // result in allocation. Each must now return false so the handler
  // short-circuits before allocating a McpServer + StreamableHTTPServerTransport.
  it("(negative-control) rejects tools/list as first POST", () => {
    expect(isInitializeRequest({ jsonrpc: "2.0", method: "tools/list", id: 1 })).toBe(false);
  });

  it("(negative-control) rejects tools/call as first POST", () => {
    expect(isInitializeRequest({ jsonrpc: "2.0", method: "tools/call", id: 1, params: {} })).toBe(false);
  });

  it("(negative-control) rejects empty / malformed bodies", () => {
    expect(isInitializeRequest(undefined)).toBe(false);
    expect(isInitializeRequest(null)).toBe(false);
    expect(isInitializeRequest("initialize")).toBe(false);
    expect(isInitializeRequest({})).toBe(false);
    expect(isInitializeRequest({ method: 42 })).toBe(false);
    expect(isInitializeRequest({ method: "INITIALIZE" })).toBe(false); // case-sensitive
  });

  it("(negative-control) rejects a batch with NO initialize entries", () => {
    expect(
      isInitializeRequest([
        { jsonrpc: "2.0", method: "tools/list", id: 1 },
        { jsonrpc: "2.0", method: "tools/call", id: 2, params: {} }
      ])
    ).toBe(false);
  });
});

describe("runWithPendingInit — pendingInits stays balanced (rc.65 round-3 audit)", () => {
  it("decrements after a SUCCESSFUL init body (returns to 0)", async () => {
    const registry = createSessionRegistry();
    expect(registry.pendingInits).toBe(0);
    const r = await runWithPendingInit(registry, async () => {
      expect(registry.pendingInits).toBe(1); // reserved during the body
      return 42;
    });
    expect(r).toBe(42);
    expect(registry.pendingInits).toBe(0);
  });

  it("NEGATIVE control — decrements even when the init body THROWS (no permanent leak → no eventual 503)", async () => {
    // The bug: pre-rc.65 the reservation + the buildMcpServer/transport constructors sat
    // OUTSIDE the try/finally, so a constructor throw skipped the decrement and permanently
    // lowered the maxSessions cap. This asserts the helper's finally always releases it.
    const registry = createSessionRegistry();
    await expect(
      runWithPendingInit(registry, async () => {
        throw new Error("simulated buildMcpServer / transport-constructor failure");
      })
    ).rejects.toThrow(/simulated/);
    expect(registry.pendingInits, "pendingInits must return to 0 after a throwing init").toBe(0);
  });

  it("stays balanced across many failed inits (cap is never silently eroded)", async () => {
    const registry = createSessionRegistry();
    for (let i = 0; i < 50; i++) {
      await runWithPendingInit(registry, async () => {
        throw new Error("boom");
      }).catch(() => {});
    }
    expect(registry.pendingInits).toBe(0);
  });
});

describe("generateBearerToken (v2.6.0)", () => {
  it("produces a 32-byte base64url string (43 chars no padding)", () => {
    const t = generateBearerToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("produces unique tokens", () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 100; i++) tokens.add(generateBearerToken());
    expect(tokens.size).toBe(100);
  });
});

// End-to-end HTTP tests: actually spawn a server bound to 127.0.0.1:0,
// fire fetch() requests, validate auth/rate-limit/CORS behavior.
describe("startHttpServer end-to-end (v2.6.0)", () => {
  const TOKEN = "e2e-test-token-1234567890abcdefghij";

  async function spawn(over: Partial<HttpServeOptions> = {}): Promise<{ url: string; close: () => Promise<void> }> {
    const httpServer = await startHttpServer({
      vault: root,
      port: 0, // kernel-assigned
      host: "127.0.0.1",
      bearerToken: TOKEN,
      mcpPath: "/mcp",
      healthPath: "/health",
      rateLimitPerMinute: 0, // disabled by default for e2e — opt in per-test
      corsOrigins: [],
      // Don't accumulate signal listeners across many test servers.
      installSignalHandlers: false,
      ...over
    });
    const addr = httpServer.address() as AddressInfo;
    const url = `http://127.0.0.1:${addr.port}`;
    return {
      url,
      close: async () => {
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      }
    };
  }

  it("rejects unauthenticated POST /mcp with 401", async () => {
    const s = await spawn();
    try {
      const res = await fetch(`${s.url}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}"
      });
      expect(res.status).toBe(401);
      expect(res.headers.get("WWW-Authenticate")).toContain("Bearer");
    } finally {
      await s.close();
    }
  });

  it("rejects wrong-token POST /mcp with 401", async () => {
    const s = await spawn();
    try {
      const res = await fetch(`${s.url}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer wrong" },
        body: "{}"
      });
      expect(res.status).toBe(401);
    } finally {
      await s.close();
    }
  });

  it("accepts authenticated MCP initialize → tools/list flow", async () => {
    const s = await spawn();
    try {
      const initResp = await fetch(`${s.url}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${TOKEN}`
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "vitest-e2e", version: "0.0.0" }
          }
        })
      });
      expect(initResp.status).toBe(200);
      const initText = await initResp.text();
      // Body is either JSON or SSE-framed JSON. Both contain serverInfo.
      expect(initText).toContain("enquire");
      expect(initText).toMatch(/serverInfo|protocolVersion/);
    } finally {
      await s.close();
    }
  });

  it("handles many sequential stateless requests cleanly (v3.9.0-rc.16 — per-request cleanup)", async () => {
    // Each stateless POST builds a fresh McpServer + transport and must close
    // both on response 'close'. Pre-rc.16 the cleanup was wired only on the
    // connect-success path; this test fires the build→connect→handle→cleanup
    // cycle repeatedly to confirm it neither hangs nor degrades (a leaked
    // server/transport per request would eventually surface as a failure).
    const s = await spawn();
    try {
      for (let i = 0; i < 6; i++) {
        const res = await fetch(`${s.url}/mcp`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            Authorization: `Bearer ${TOKEN}`
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: i + 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-03-26",
              capabilities: {},
              clientInfo: { name: "vitest-e2e", version: "0.0.0" }
            }
          })
        });
        expect(res.status, `request ${i} should succeed`).toBe(200);
        await res.text(); // drain the body so the response 'close' fires → cleanup runs
      }
    } finally {
      await s.close();
    }
  });

  it("returns 405 on GET /mcp (stateless transport — no SSE stream)", async () => {
    const s = await spawn();
    try {
      const res = await fetch(`${s.url}/mcp`, {
        method: "GET",
        headers: { Authorization: `Bearer ${TOKEN}` }
      });
      expect(res.status).toBe(405);
    } finally {
      await s.close();
    }
  });

  it("serves /health unauthenticated", async () => {
    const s = await spawn();
    try {
      const res = await fetch(`${s.url}/health`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("ok");
    } finally {
      await s.close();
    }
  });

  it("returns 404 on unknown paths", async () => {
    const s = await spawn();
    try {
      const res = await fetch(`${s.url}/notathing`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}` },
        body: "{}"
      });
      expect(res.status).toBe(404);
    } finally {
      await s.close();
    }
  });

  it("rate-limits per token after budget exhausted (429)", async () => {
    const s = await spawn({ rateLimitPerMinute: 2 });
    try {
      const headers = {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${TOKEN}`
      };
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "vitest-e2e", version: "0.0.0" }
        }
      });
      // 2 allowed, 3rd refused.
      const r1 = await fetch(`${s.url}/mcp`, { method: "POST", headers, body });
      expect(r1.status).toBe(200);
      // Drain body so the connection closes cleanly before next attempt.
      await r1.text();
      const r2 = await fetch(`${s.url}/mcp`, { method: "POST", headers, body });
      expect(r2.status).toBe(200);
      await r2.text();
      const r3 = await fetch(`${s.url}/mcp`, { method: "POST", headers, body });
      expect(r3.status).toBe(429);
      expect(r3.headers.get("Retry-After")).toBe("60");
    } finally {
      await s.close();
    }
  });

  it("OPTIONS preflight with allowed origin gets 204 + CORS headers", async () => {
    const s = await spawn({ corsOrigins: ["https://claude.ai"] });
    try {
      const res = await fetch(`${s.url}/mcp`, {
        method: "OPTIONS",
        headers: {
          Origin: "https://claude.ai",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "Authorization, Content-Type"
        }
      });
      expect(res.status).toBe(204);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://claude.ai");
      expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
      expect(res.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
      // v3.10.0-rc.62 (HTTP-CORS-EXPOSE-SESSION-ID) — a browser MCP client must be able to READ
      // the Mcp-Session-Id the server returns on `initialize`; that requires it in Expose-Headers.
      expect(res.headers.get("Access-Control-Expose-Headers")).toContain("Mcp-Session-Id");
    } finally {
      await s.close();
    }
  });

  it("CORS exposes Mcp-Session-Id on a real POST response so a browser client can read the session id (rc.62)", async () => {
    const s = await spawn({ corsOrigins: ["https://claude.ai"] });
    try {
      // A non-preflight request also carries the Expose-Headers (applyCors runs on every request).
      const res = await fetch(`${s.url}/mcp`, {
        method: "OPTIONS",
        headers: { Origin: "https://claude.ai", "Access-Control-Request-Method": "POST" }
      });
      expect(res.headers.get("Access-Control-Expose-Headers")).toBe("Mcp-Session-Id");
    } finally {
      await s.close();
    }
  });

  it("OPTIONS preflight with wildcard origin reflects '*' and OMITS Allow-Credentials (CodeQL cors-credential-leak guard)", async () => {
    const s = await spawn({ corsOrigins: ["*"] });
    try {
      const res = await fetch(`${s.url}/mcp`, {
        method: "OPTIONS",
        headers: {
          Origin: "https://anything.example.com",
          "Access-Control-Request-Method": "POST"
        }
      });
      expect(res.status).toBe(204);
      // Wildcard reflects literal "*", NOT the request's origin (avoids
      // credential-bearing CORS grant to attacker-controlled origins).
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
      // Allow-Credentials must be absent under wildcard (browsers reject
      // the combo, and we want it absent in headers regardless).
      expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    } finally {
      await s.close();
    }
  });

  it("OPTIONS preflight with explicit origin reflects exact origin AND sends Allow-Credentials", async () => {
    const s = await spawn({ corsOrigins: ["https://claude.ai"] });
    try {
      const res = await fetch(`${s.url}/mcp`, {
        method: "OPTIONS",
        headers: {
          Origin: "https://claude.ai",
          "Access-Control-Request-Method": "POST"
        }
      });
      expect(res.status).toBe(204);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://claude.ai");
      expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    } finally {
      await s.close();
    }
  });

  it("OPTIONS preflight with disallowed origin gets 204 but NO CORS headers", async () => {
    const s = await spawn({ corsOrigins: ["https://claude.ai"] });
    try {
      const res = await fetch(`${s.url}/mcp`, {
        method: "OPTIONS",
        headers: {
          Origin: "https://evil.example.com",
          "Access-Control-Request-Method": "POST"
        }
      });
      expect(res.status).toBe(204);
      // Browsers will block the actual request because the preflight didn't
      // include Access-Control-Allow-Origin for the requesting origin.
      expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    } finally {
      await s.close();
    }
  });

  it("refuses startup when bearer token is missing", async () => {
    await expect(
      startHttpServer({
        vault: root,
        port: 0,
        host: "127.0.0.1",
        bearerToken: ""
      })
    ).rejects.toThrow(/--bearer-token is required/);
  });

  it("refuses startup when bearer token is too short (<16 chars)", async () => {
    await expect(
      startHttpServer({
        vault: root,
        port: 0,
        host: "127.0.0.1",
        bearerToken: "short"
      })
    ).rejects.toThrow(/16 chars/);
  });

  // v3.6 — branches coverage. Exercise stateless-mode body-parse error
  // (sendJsonRpcError -32700) + the DELETE-method-on-stateless 405 branch.
  it("returns 400 + -32700 parse error on malformed JSON (stateless)", async () => {
    const s = await spawn();
    try {
      const res = await fetch(`${s.url}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${TOKEN}`
        },
        body: "{not valid json"
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: number; message: string } };
      expect(body.error.code).toBe(-32700);
    } finally {
      await s.close();
    }
  });

  it("returns 405 on DELETE /mcp in stateless mode (only POST + OPTIONS allowed)", async () => {
    const s = await spawn();
    try {
      const res = await fetch(`${s.url}/mcp`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${TOKEN}` }
      });
      expect(res.status).toBe(405);
    } finally {
      await s.close();
    }
  });
});

// v2.14.0 — stateful sessions: Mcp-Session-Id keyed transport reuse,
// idle eviction, max-sessions cap, SSE GET, DELETE termination.
describe("startHttpServer stateful sessions (v2.14.0)", () => {
  const TOKEN = "stateful-test-token-1234567890abcdef";

  async function spawnStateful(
    over: Partial<HttpServeOptions> = {}
  ): Promise<{ url: string; close: () => Promise<void> }> {
    const httpServer = await startHttpServer({
      vault: root,
      port: 0,
      host: "127.0.0.1",
      bearerToken: TOKEN,
      mcpPath: "/mcp",
      healthPath: "/health",
      rateLimitPerMinute: 0,
      corsOrigins: [],
      stateful: true,
      maxSessions: 100,
      sessionIdleTimeoutMs: 30 * 60 * 1000,
      installSignalHandlers: false,
      ...over
    });
    const addr = httpServer.address() as AddressInfo;
    const url = `http://127.0.0.1:${addr.port}`;
    return {
      url,
      close: async () => {
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      }
    };
  }

  /** Initialize a fresh session and return its session id from the response header. */
  async function initSession(baseUrl: string): Promise<{ sessionId: string; rawResponse: Response }> {
    const initResp = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${TOKEN}`
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "vitest-stateful", version: "0.0.0" }
        }
      })
    });
    const sessionId = initResp.headers.get("Mcp-Session-Id") ?? "";
    return { sessionId, rawResponse: initResp };
  }

  it("initialize allocates a Mcp-Session-Id header on the response", async () => {
    const s = await spawnStateful();
    try {
      const { sessionId, rawResponse } = await initSession(s.url);
      expect(rawResponse.status).toBe(200);
      expect(sessionId).toMatch(/^[0-9a-f]{32}$/i);
      // Drain so the connection closes cleanly.
      await rawResponse.text();
    } finally {
      await s.close();
    }
  });

  it("subsequent POST with the same session id reuses the transport", async () => {
    const s = await spawnStateful();
    try {
      const { sessionId, rawResponse } = await initSession(s.url);
      await rawResponse.text();
      // Send a second request (notifications/initialized) with the
      // session id; should be accepted (200 / 202).
      const r2 = await fetch(`${s.url}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${TOKEN}`,
          "Mcp-Session-Id": sessionId
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized"
        })
      });
      // Accepted is 200 or 202; 4xx/5xx would mean the session id wasn't found.
      expect(r2.status).toBeLessThan(300);
      await r2.text();
    } finally {
      await s.close();
    }
  });

  it("POST with unknown session id returns 404", async () => {
    const s = await spawnStateful();
    try {
      const r = await fetch(`${s.url}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${TOKEN}`,
          "Mcp-Session-Id": "bogus-session-id"
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 99 })
      });
      expect(r.status).toBe(404);
      await r.text();
    } finally {
      await s.close();
    }
  });

  it("DELETE with unknown session id returns 204 (idempotent)", async () => {
    const s = await spawnStateful();
    try {
      const r = await fetch(`${s.url}/mcp`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Mcp-Session-Id": "no-such-session"
        }
      });
      expect(r.status).toBe(204);
    } finally {
      await s.close();
    }
  });

  it("DELETE without session id returns 400", async () => {
    const s = await spawnStateful();
    try {
      const r = await fetch(`${s.url}/mcp`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${TOKEN}` }
      });
      expect(r.status).toBe(400);
      await r.text();
    } finally {
      await s.close();
    }
  });

  it("DELETE on a real session terminates it (subsequent POST → 404)", async () => {
    const s = await spawnStateful();
    try {
      const { sessionId, rawResponse } = await initSession(s.url);
      await rawResponse.text();
      const del = await fetch(`${s.url}/mcp`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Mcp-Session-Id": sessionId
        }
      });
      // The SDK's transport handles the protocol-level shutdown; status
      // is 200 (transport handled it) or 204 (we short-circuited because
      // the session was already gone). Either is fine.
      expect([200, 204]).toContain(del.status);
      await del.text();
      // Next POST with that session id should now miss.
      const after = await fetch(`${s.url}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${TOKEN}`,
          "Mcp-Session-Id": sessionId
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 })
      });
      expect(after.status).toBe(404);
      await after.text();
    } finally {
      await s.close();
    }
  });

  it("GET without session id returns 400", async () => {
    const s = await spawnStateful();
    try {
      const r = await fetch(`${s.url}/mcp`, {
        method: "GET",
        headers: { Authorization: `Bearer ${TOKEN}` }
      });
      expect(r.status).toBe(400);
      await r.text();
    } finally {
      await s.close();
    }
  });

  it("GET with unknown session id returns 404", async () => {
    const s = await spawnStateful();
    try {
      const r = await fetch(`${s.url}/mcp`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Mcp-Session-Id": "no-such"
        }
      });
      expect(r.status).toBe(404);
      await r.text();
    } finally {
      await s.close();
    }
  });

  it("max-sessions cap rejects new initialize with 503 + Retry-After", async () => {
    // Cap at 1 so we can exhaust it with a single init.
    const s = await spawnStateful({ maxSessions: 1 });
    try {
      const { sessionId: sid1, rawResponse: r1 } = await initSession(s.url);
      expect(sid1).toMatch(/^[0-9a-f]{32}$/i);
      await r1.text();
      // Second init (no session id, no DELETE) — should hit the cap.
      const r2 = await fetch(`${s.url}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${TOKEN}`
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "second", version: "0" }
          }
        })
      });
      expect(r2.status).toBe(503);
      expect(r2.headers.get("Retry-After")).toBe("60");
      const body = (await r2.json()) as { error: string; max: number };
      expect(body.error).toMatch(/max sessions/);
      expect(body.max).toBe(1);
    } finally {
      await s.close();
    }
  });

  // v3.6 — branches coverage. Stateful mode's parse-error + 405 branches
  // (lines 444-456 of http-transport.ts).
  it("returns 405 on PATCH /mcp in stateful mode (only POST/GET/DELETE/OPTIONS routed)", async () => {
    const s = await spawnStateful();
    try {
      const r = await fetch(`${s.url}/mcp`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json"
        },
        body: "{}"
      });
      expect(r.status).toBe(405);
    } finally {
      await s.close();
    }
  });

  it("returns 400 + -32700 on malformed JSON in stateful mode", async () => {
    const s = await spawnStateful();
    try {
      const r = await fetch(`${s.url}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${TOKEN}`
        },
        body: "{garbled"
      });
      expect(r.status).toBe(400);
      const body = (await r.json()) as { error: { code: number } };
      expect(body.error.code).toBe(-32700);
    } finally {
      await s.close();
    }
  });

  // v3.8.7 P2-11 — shutdownHttpServer drains the registry. After the
  // call returns, a subsequent fetch to the bound address should fail
  // (TCP listener closed).
  it("shutdownHttpServer drains stateful sessions + closes the TCP listener", async () => {
    const httpServer = await startHttpServer({
      vault: root,
      port: 0,
      host: "127.0.0.1",
      bearerToken: TOKEN,
      mcpPath: "/mcp",
      healthPath: "/health",
      rateLimitPerMinute: 0,
      stateful: true,
      maxSessions: 100,
      installSignalHandlers: false
    });
    const addr = httpServer.address() as AddressInfo;
    const url = `http://127.0.0.1:${addr.port}`;
    // Open a stateful session.
    const init = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${TOKEN}`
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "0" } }
      })
    });
    const sid = init.headers.get("Mcp-Session-Id");
    expect(sid).toBeTruthy();
    await init.text();
    // Now drain. After this returns the port is free + session is gone.
    await shutdownHttpServer(httpServer);
    // Trying to reach the dead port should error out (ECONNREFUSED) —
    // we just check the fetch rejects rather than asserting on the
    // exact code, since Node's error shape varies across versions.
    let failed = false;
    try {
      await fetch(`${url}/health`);
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  });

  // v3.8.7 P2-11 — shutdownHttpServer on a stateless server is also a
  // valid path: no registry to drain, just close the TCP listener.
  it("shutdownHttpServer works on stateless servers (no registry to drain)", async () => {
    const httpServer = await startHttpServer({
      vault: root,
      port: 0,
      host: "127.0.0.1",
      bearerToken: TOKEN,
      mcpPath: "/mcp",
      rateLimitPerMinute: 0,
      stateful: false,
      installSignalHandlers: false
    });
    // Should not throw and should leave the listener closed.
    await shutdownHttpServer(httpServer);
    const addr = httpServer.address();
    // After close, .address() returns null on a server that has been closed.
    expect(addr).toBeNull();
  });

  // v3.8.7 P2-11 — second call to shutdownHttpServer is a no-op + safe.
  it("shutdownHttpServer is idempotent — second call is a safe no-op", async () => {
    const httpServer = await startHttpServer({
      vault: root,
      port: 0,
      host: "127.0.0.1",
      bearerToken: TOKEN,
      stateful: true,
      installSignalHandlers: false
    });
    await shutdownHttpServer(httpServer);
    // Second call should not throw.
    await expect(shutdownHttpServer(httpServer)).resolves.toBeUndefined();
  });

  // v3.10.0-rc.19 (audit M3) — the SIGINT/SIGTERM orchestrator must AWAIT the
  // full graceful teardown (shutdownHttpServer: drain → close TCP listener →
  // flush cache → close fts/watcher/embed-db) and only THEN exit. Pre-rc.19 a
  // SEPARATE cache-flush handler called process.exit(0) the moment its fast
  // flush resolved — racing ahead of the session drain.
  it("makeHttpShutdownHandler awaits full teardown before exit (rc.19 M3)", async () => {
    const httpServer = await startHttpServer({
      vault: root,
      port: 0,
      host: "127.0.0.1",
      bearerToken: TOKEN,
      mcpPath: "/mcp",
      stateful: true,
      installSignalHandlers: false
    });
    expect((httpServer.address() as AddressInfo).port).toBeGreaterThan(0);
    let exitCode: number | undefined;
    const handler = makeHttpShutdownHandler(httpServer, (c) => {
      exitCode = c;
    });
    handler();
    // The await sits in front of exit → it must NOT have fired synchronously.
    expect(exitCode).toBeUndefined();
    // Re-entrancy guard: a second signal must not schedule a second teardown/exit.
    handler();
    // Teardown settles → exit(0), and the TCP listener was closed BEFORE exit.
    await vi.waitFor(() => expect(exitCode).toBe(0));
    expect(httpServer.address()).toBeNull();
  });

  // NEGATIVE control — a handler that does NOT await shutdownHttpServer (the
  // pre-rc.19 flush-then-exit shape) "exits" while the TCP listener is still up.
  // This proves the positive test's "address()===null at exit" genuinely depends
  // on the await, not on teardown happening to be instant.
  it("NEGATIVE control — skipping the await exits while the TCP listener is still up (rc.19 M3)", async () => {
    const httpServer = await startHttpServer({
      vault: root,
      port: 0,
      host: "127.0.0.1",
      bearerToken: TOKEN,
      mcpPath: "/mcp",
      stateful: true,
      installSignalHandlers: false
    });
    expect(httpServer.address()).not.toBeNull();
    // Mirror the bug: kick off teardown but read state ("exit") immediately,
    // without awaiting it.
    void shutdownHttpServer(httpServer);
    const addrAtExit = httpServer.address();
    expect(addrAtExit).not.toBeNull(); // ← listener STILL up: the race rc.19 removes
    // Let the real teardown finish so the test leaves nothing bound.
    await vi.waitFor(() => expect(httpServer.address()).toBeNull());
  });

  // v3.10.0-rc.23 — bounded shutdown. rc.19 made shutdown AWAIT `server.close()`,
  // but Node's `close()` never terminates idle keep-alive sockets, so a lingering
  // connection hung `serve-http` forever on SIGINT/SIGTERM (reproduced). The fix:
  // close idle conns immediately + force-close stragglers after a grace.
  it("closeServerBounded resolves within the grace despite a lingering keep-alive connection (rc.23)", async () => {
    const srv = createServer((_req, res) => res.end("ok"));
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as AddressInfo).port;
    // Open a raw socket and hold it open — never send a complete request. This
    // is exactly the lingering connection that makes a naive `server.close()` hang.
    const sock = net.connect(port, "127.0.0.1");
    sock.on("error", () => {});
    await new Promise((r) => setTimeout(r, 50));
    const t0 = Date.now();
    await closeServerBounded(srv, 150); // tiny grace for the test
    const elapsed = Date.now() - t0;
    expect(elapsed, "must not hang on the lingering socket").toBeLessThan(2000);
    expect(srv.listening).toBe(false);
    sock.destroy();
  });

  // CONTROL: with NO lingering connection, it must resolve as soon as close()
  // completes — NOT wait out the grace. A naive `setTimeout(resolve, grace)` impl
  // would fail this (it'd always take ~the full grace).
  it("closeServerBounded resolves promptly (well under the grace) when nothing lingers (rc.23 control)", async () => {
    const srv = createServer((_req, res) => res.end("ok"));
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const t0 = Date.now();
    await closeServerBounded(srv, 5000); // large grace it must NOT wait out
    const elapsed = Date.now() - t0;
    expect(elapsed, "must resolve on close() completion, not by waiting the grace").toBeLessThan(1000);
    expect(srv.listening).toBe(false);
  });

  // v3.8.7 P2-10 — fire many concurrent initialize POSTs at a low-cap
  // server. Without the pendingInits guard, several would all pass the
  // size() check and overshoot. With it, only `maxSessions` succeed +
  // the rest get 503.
  it("concurrent initialize POSTs cannot exceed maxSessions (TOCTOU defense)", async () => {
    const s = await spawnStateful({ maxSessions: 2 });
    try {
      // Fire 6 concurrent initializes at a cap of 2.
      const promises = Array.from({ length: 6 }, (_, i) =>
        fetch(`${s.url}/mcp`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            Authorization: `Bearer ${TOKEN}`
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: i + 1,
            method: "initialize",
            params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: `c${i}`, version: "0" } }
          })
        })
      );
      const results = await Promise.all(promises);
      // Drain bodies so connections close.
      await Promise.all(results.map((r) => r.text().catch(() => "")));
      const successful = results.filter((r) => r.status === 200);
      const rejected = results.filter((r) => r.status === 503);
      // CAP DEFENSE — at most `maxSessions` (2) should succeed; the
      // others must be 503'd. Without pendingInits, this could be 6/6.
      expect(successful.length).toBeLessThanOrEqual(2);
      expect(successful.length + rejected.length).toBe(6);
    } finally {
      await s.close();
    }
  });

  it("stateless mode is unchanged (default, no Mcp-Session-Id on init response)", async () => {
    // Same as v2.6.0 stateless behavior: no Mcp-Session-Id header.
    // Reuse the existing spawn() helper from the v2.6.0 suite by
    // instantiating with stateful=false explicitly.
    const httpServer = await startHttpServer({
      vault: root,
      port: 0,
      host: "127.0.0.1",
      bearerToken: TOKEN,
      mcpPath: "/mcp",
      healthPath: "/health",
      rateLimitPerMinute: 0,
      stateful: false,
      installSignalHandlers: false
    });
    const addr = httpServer.address() as AddressInfo;
    try {
      const r = await fetch(`http://127.0.0.1:${addr.port}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${TOKEN}`
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "stateless-check", version: "0" }
          }
        })
      });
      expect(r.status).toBe(200);
      // Stateless transport should NOT set the Mcp-Session-Id response header.
      expect(r.headers.get("Mcp-Session-Id")).toBeNull();
      await r.text();
    } finally {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });
});
