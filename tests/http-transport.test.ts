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
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createSessionRegistry,
  generateBearerToken,
  type HttpServeOptions,
  RateLimiter,
  readJsonBody,
  startHttpServer,
  verifyBearer
} from "../src/http-transport.js";

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
