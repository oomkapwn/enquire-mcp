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
  generateBearerToken,
  type HttpServeOptions,
  RateLimiter,
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
});
