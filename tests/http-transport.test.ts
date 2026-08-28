// v2.6.0 — HTTP transport unit tests.
//
// Coverage:
//   • verifyBearer: missing/wrong/right token, case sensitivity, length-leak
//     resistance (timingSafeEqual), no Bearer prefix.
//   • RateLimiter: under-budget passes, over-budget rejects, sliding window
//     trims old entries, perMinute=0 disables.
//   • startHttpServer end-to-end: Origin admission, 401 missing, 401 wrong,
//     200 init, 429 rate-limit, OPTIONS preflight, /health, 405 GET on /mcp.
//
// We bind to 127.0.0.1:0 (kernel-assigned port) to avoid collisions when
// running tests in parallel. Each test cleans up its server with
// `httpServer.close()`.

import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeServerBounded,
  createHttpHandler,
  createSessionRegistry,
  deriveHttpBodyCap,
  generateBearerToken,
  type HttpServeOptions,
  isInitializeRequest,
  isJsonContentType,
  isPersistentWriteRequest,
  makeHttpShutdownHandler,
  parseMaxFileBytes,
  RateLimiter,
  readJsonBody,
  runWithPendingInit,
  shutdownHttpServer,
  startHttpServer,
  verifyBearer
} from "../src/http-transport.js";
import { DEFAULT_MAX_FILE_BYTES, Vault } from "../src/vault.js";
import { WriteRequestTracker } from "../src/write-lifecycle.js";
import { replaceExactly } from "./helpers/exact-source-mutation.js";

let root: string;

const MODERN_PROTOCOL_VERSION = "2026-07-28";
const MODERN_ENVELOPE = {
  "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION,
  "io.modelcontextprotocol/clientInfo": { name: "enquire-http-test", version: "1.0.0" },
  "io.modelcontextprotocol/clientCapabilities": {}
};

function modernDiscoverBody(id: string | number = 1): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method: "server/discover",
    params: { _meta: MODERN_ENVELOPE }
  };
}

/** In-memory `http.Server` lifecycle for startup rollback tests. It exercises
 * the production ownership orchestration without requiring a sandbox TCP bind. */
function createStartupListenerFixture(options: { listenError?: Error; closeError?: Error } = {}): {
  server: ReturnType<typeof createServer>;
  closeCalls: () => number;
} {
  const emitter = new EventEmitter();
  let listening = false;
  let closes = 0;
  const server = emitter as unknown as ReturnType<typeof createServer>;
  Object.defineProperty(server, "listening", { configurable: true, get: () => listening });
  server.listen = ((...args: unknown[]) => {
    if (options.listenError) {
      queueMicrotask(() => emitter.emit("error", options.listenError));
      return server;
    }
    listening = true;
    const finalArg = args[args.length - 1];
    const callback = typeof finalArg === "function" ? (finalArg as () => void) : undefined;
    queueMicrotask(() => callback?.());
    return server;
  }) as typeof server.listen;
  server.address = (() =>
    listening ? { address: "127.0.0.1", family: "IPv4", port: 43123 } : null) as typeof server.address;
  server.close = ((callback?: (error?: Error) => void) => {
    closes += 1;
    listening = false;
    queueMicrotask(() => callback?.(options.closeError));
    return server;
  }) as typeof server.close;
  server.closeIdleConnections = () => {};
  server.closeAllConnections = () => {};
  return { server, closeCalls: () => closes };
}

function modernHttpV2Problems(source: string): string[] {
  const problems: string[] = [];
  const lifecycleStart = source.indexOf("function createModernHttpLifecycle(");
  const handlerStart = source.indexOf("export function createHttpHandler(");
  const shutdownStart = source.indexOf("export async function shutdownHttpServer(");
  const shutdownEnd = source.indexOf("export function makeHttpShutdownHandler(", Math.max(0, shutdownStart));
  const lifecycle =
    lifecycleStart >= 0 && handlerStart > lifecycleStart ? source.slice(lifecycleStart, handlerStart) : "";
  const handler = handlerStart >= 0 && shutdownStart > handlerStart ? source.slice(handlerStart, shutdownStart) : "";
  const shutdown = shutdownStart >= 0 && shutdownEnd > shutdownStart ? source.slice(shutdownStart, shutdownEnd) : "";

  if (!lifecycle.includes("createMcpHandler(() => buildMcpServer(deps, opts, writeTracker), {")) {
    problems.push("modern: factory does not attach the aggregate write tracker");
  }
  if (!lifecycle.includes('legacy: "reject"')) {
    problems.push("modern: handler is not strict against legacy fallback");
  }
  const closeAdmission = lifecycle.indexOf("writeTracker.closeAdmission(");
  const abortRollback = lifecycle.indexOf("await writeTracker.abortRollbackSafe(");
  const waitForWrites = lifecycle.indexOf("await writeTracker.waitForAll();");
  const closeHandler = lifecycle.indexOf("const closeTask = Promise.resolve()");
  const boundedClose = lifecycle.indexOf("await waitForBoundedSettlement(closeTask, closeMs)");
  if (
    !(
      closeAdmission >= 0 &&
      closeAdmission < abortRollback &&
      abortRollback < waitForWrites &&
      waitForWrites < closeHandler &&
      closeHandler < boundedClose
    )
  ) {
    problems.push("modern: write integrity tail does not precede bounded handler close");
  }
  if (!lifecycle.includes("handleStatelessRequest(req, res, deps, opts, body, writeTracker)")) {
    problems.push("legacy stateless: dispatch is not owned by the shared write tracker");
  }
  if (!handler.includes("const server = buildMcpServer(deps, opts, writeTracker);")) {
    problems.push("legacy stateless: server factory bypasses the shared write tracker");
  }
  const contentGuard = handler.indexOf(
    'if (req.method === "POST" && !isJsonContentType(req.headers["content-type"])) {'
  );
  const bodyRead = handler.indexOf("body = await readJsonBody(req, maxBodyBytes);");
  const classifier = handler.indexOf("if (!(await isLegacyRequest(probe, body))) {");
  const legacySessions = handler.indexOf("registry.sweepIdle();");
  if (!(contentGuard >= 0 && contentGuard < bodyRead)) {
    problems.push("routing: Content-Type 415 guard does not precede JSON parsing");
  }
  if ((handler.match(/readJsonBody\(req, maxBodyBytes\)/g) ?? []).length !== 1) {
    problems.push("routing: Node request body is not read exactly once");
  }
  if (
    !handler.includes("const probe = await toWebRequest(req, body);") ||
    !handler.includes("await modern.serve(req, res, body);")
  ) {
    problems.push("routing: parsed body is not forwarded to modern classification and dispatch");
  }
  if (!(classifier >= 0 && classifier < legacySessions)) {
    problems.push("routing: official classifier does not precede legacy session requirements");
  }
  const awaitProtocolOwners = shutdown.indexOf("await Promise.all([modernClose, legacyClose]);");
  const closeTcp = shutdown.indexOf("await closeServerBounded(server);", Math.max(0, awaitProtocolOwners));
  const captureSharedDeps = shutdown.indexOf("extras.cleanupOwner ??= createPreparedServerCleanupOwner(");
  const closeSharedDeps = shutdown.indexOf("await extras.cleanupOwner.cleanup();", Math.max(0, captureSharedDeps));
  if (
    !(
      awaitProtocolOwners >= 0 &&
      awaitProtocolOwners < closeTcp &&
      closeTcp < captureSharedDeps &&
      captureSharedDeps < closeSharedDeps
    )
  ) {
    problems.push("shutdown: protocol owners do not close before shared dependencies");
  }
  if (
    !source.includes("const httpServerShutdowns = new WeakMap<HttpServer, Promise<void>>();") ||
    !shutdown.includes("const existingShutdown = httpServerShutdowns.get(server);") ||
    !shutdown.includes("if (existingShutdown) return existingShutdown;") ||
    !shutdown.includes("httpServerShutdowns.set(server, shutdownTask);") ||
    !shutdown.includes("return shutdownTask;")
  ) {
    problems.push("shutdown: concurrent callers do not join one memoized teardown");
  }
  return problems;
}

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
  it("closeAll drains sessions, waits the write-integrity tail, then closes transports + servers", async () => {
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
    const writeTracker = new WriteRequestTracker();
    const finishGate = (() => {
      let release: (() => void) | undefined;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { promise, release: () => release?.() };
    })();
    const finishWrite = writeTracker.run(1, new AbortController().signal, "finish", async () => {
      await finishGate.promise;
    });
    await Promise.resolve();
    r.sessions.set("a", {
      ...makeStub(),
      lastActivityMs: Date.now(),
      inFlight: 1,
      inFlightCalls: 1,
      inFlightWrites: 1,
      writeTracker,
      closing: false
    });
    r.sessions.set("b", { ...makeStub(), lastActivityMs: Date.now(), inFlight: 0, closing: false });
    expect(r.size()).toBe(2);
    let closeSettled = false;
    const closing = r.closeAll(0).then((count) => {
      closeSettled = true;
      return count;
    });
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    expect(transportClosed).toBe(0);
    finishGate.release();
    await finishWrite;
    const closed = await closing;
    expect(closed).toBe(2);
    expect(transportClosed).toBe(2);
    expect(serverClosed).toBe(2);
    expect(r.size()).toBe(0);

    const hung = createSessionRegistry(60_000, 25);
    let resolveHang: (() => void) | undefined;
    const hang = new Promise<void>((resolve) => {
      resolveHang = resolve;
    });
    hung.sessions.set("stuck", {
      transport: {
        close: async () => hang
      },
      server: {
        close: async () => {}
      },
      lastActivityMs: Date.now(),
      inFlight: 0,
      closing: false
    } as unknown as Parameters<typeof hung.sessions.set>[1]);
    const started = Date.now();
    const hungClosed = await hung.closeAll(0);
    expect(hungClosed).toBe(1);
    expect(Date.now() - started).toBeLessThan(1000);
    resolveHang?.();
  });

  // v3.8.7 P2-11 — closeAll waits for in-flight handlers up to timeoutMs
  // then force-closes. We simulate a slow in-flight by counting down via
  // setTimeout (no real handler available in this unit test).
  it("closeAll waits for in-flight CALLS to drain (bounded by timeoutMs)", async () => {
    const r = createSessionRegistry(60_000);
    const session = {
      transport: { close: async () => {} },
      server: { close: async () => {} },
      lastActivityMs: Date.now(),
      inFlight: 1,
      inFlightCalls: 1, // an in-flight POST tool call — closeAll must wait for it
      closing: false
    } as unknown as Parameters<typeof r.sessions.set>[1];
    r.sessions.set("slow", session);
    // Drop the call refcount to 0 after a short delay → closeAll should return
    // soon after that (rc.21: closeAll drains `inFlightCalls`, not `inFlight`).
    setTimeout(() => {
      (session as unknown as { inFlightCalls: number }).inFlightCalls = 0;
    }, 50);
    const start = Date.now();
    const closed = await r.closeAll(1000);
    const elapsed = Date.now() - start;
    expect(closed).toBe(1);
    // Finished close-to but not at the timeoutMs cap — confirms we
    // observed the drain instead of waiting the full 1s.
    expect(elapsed).toBeLessThan(500);
  });

  // v3.11.6-rc.21 (rc.20 re-sweep F1) — closeAll must NOT block on a long-lived
  // GET SSE stream (inFlight>0 but inFlightCalls===0): shutdown terminates the
  // stream, it doesn't wait for it. Pre-rc.21 closeAll drained `inFlight`, so a
  // single open notification stream pinned every shutdown for the full bound.
  it("closeAll does NOT wait for an open SSE stream (inFlight>0, no in-flight calls)", async () => {
    const r = createSessionRegistry(60_000);
    const session = {
      transport: { close: async () => {} },
      server: { close: async () => {} },
      lastActivityMs: Date.now(),
      inFlight: 1, // an open SSE GET holds inFlight...
      inFlightCalls: 0, // ...but it is NOT a drainable call
      closing: false
    } as unknown as Parameters<typeof r.sessions.set>[1];
    r.sessions.set("sse", session);
    const start = Date.now();
    const closed = await r.closeAll(1000);
    const elapsed = Date.now() - start;
    expect(closed).toBe(1);
    expect(elapsed, "an open SSE must not pin shutdown for the full bound").toBeLessThan(200);
  });

  // v3.8.7 P2-10 — pendingInits counter exposed so the cap-check can
  // include it; starts at 0, never negative.
  it("pendingInits starts at 0", () => {
    const r = createSessionRegistry(60_000);
    expect(r.pendingInits).toBe(0);
  });

  // v3.11.7-rc.1 (whole-repo audit A11) — closeAll must include an
  // initialize body already reserved when shutdown begins. Pre-fix it could
  // return while this body was still live.
  it("closeAll waits for an already-reserved initialize already present in its snapshot", async () => {
    const r = createSessionRegistry(60_000);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let transportClosed = 0;
    const session = {
      transport: {
        close: async () => {
          transportClosed += 1;
        }
      },
      server: { close: async () => {} },
      lastActivityMs: Date.now(),
      inFlight: 0,
      inFlightCalls: 0,
      closing: false
    } as unknown as Parameters<typeof r.sessions.set>[1];

    const init = runWithPendingInit(r, async () => {
      expect(r.registerSession("reserved", session)).toBe(true);
      await gate;
    });
    expect(r.pendingInits).toBe(1);

    let closeSettled = false;
    const closing = r.closeAll(1000).then((count) => {
      closeSettled = true;
      return count;
    });
    expect(r.size(), "already-live sessions must become unreachable synchronously").toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(closeSettled, "shutdown must not finish ahead of the reserved init body").toBe(false);

    release?.();
    await init;
    expect(await closing).toBe(1);
    expect(transportClosed).toBe(1);
    expect(r.size()).toBe(0);
    expect(r.pendingInits).toBe(0);
  });

  it("a late initialize cannot publish a session after closeAll closes the gate", async () => {
    const r = createSessionRegistry(60_000);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let registered: boolean | undefined;
    const session = {
      transport: { close: async () => {} },
      server: { close: async () => {} },
      lastActivityMs: Date.now(),
      inFlight: 0,
      inFlightCalls: 0,
      closing: false
    } as unknown as Parameters<typeof r.sessions.set>[1];

    const init = runWithPendingInit(r, async () => {
      await gate;
      registered = r.registerSession("too-late", session);
    });
    expect(r.pendingInits).toBe(1);
    const closing = r.closeAll(1000);
    expect(r.acceptingInits).toBe(false);
    expect(r.size(), "live sessions must become unreachable synchronously at shutdown").toBe(0);
    release?.();
    await init;
    expect(await closing).toBe(0);
    expect(registered).toBe(false);
    expect(session.closing).toBe(true);
    expect(r.size()).toBe(0);

    // NEGATIVE control: shutdown is terminal; a new reservation cannot
    // re-open the registry or run its body after closeAll.
    let bodyRan = false;
    await expect(
      runWithPendingInit(r, async () => {
        bodyRan = true;
      })
    ).rejects.toThrow(/shutting down/);
    expect(bodyRan).toBe(false);
    expect(r.pendingInits).toBe(0);
  });

  it("the real stateful HTTP handler routes late publication through the terminal gate", async () => {
    const vault = new Vault(root);
    await vault.ensureExists();
    const deps: Parameters<typeof createHttpHandler>[0] = {
      vault,
      ftsIndex: null,
      watcher: null,
      watcherEmbedDb: null,
      feedbackStore: null,
      disabledTools: new Set(),
      enabledTools: new Set(),
      warningTracker: { printed: false },
      hnswContext: null
    };
    const out: { registry: ReturnType<typeof createSessionRegistry> | null } = { registry: null };
    const handler = createHttpHandler(
      deps,
      {
        vault: root,
        port: 0,
        host: "127.0.0.1",
        bearerToken: "late-registration-test-token-1234567890",
        stateful: true,
        rateLimitPerMinute: 0,
        installSignalHandlers: false
      },
      out
    );
    const httpServer = createServer((req, res) => void handler(req, res));
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const registry = out.registry;
    if (!registry) throw new Error("stateful handler did not expose its registry");

    // Trigger shutdown at the exact SDK publication callback. This is a
    // handler-level mutation guard: replacing registerSession with the old
    // `sessions.set` bypass would leave registerCalls=0 and fail this test even
    // though the lower-level registry unit tests still passed.
    const originalRegister = registry.registerSession.bind(registry);
    let registerCalls = 0;
    let closing: Promise<number> | undefined;
    registry.registerSession = (sid, session) => {
      registerCalls += 1;
      closing ??= registry.closeAll(1000);
      return originalRegister(sid, session);
    };

    try {
      const addr = httpServer.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${addr.port}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: "Bearer late-registration-test-token-1234567890"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "late-registration-test", version: "0" }
          }
        })
      });
      expect(response.status).toBe(200);
      await response.text();
      expect(registerCalls).toBe(1);
      if (!closing) throw new Error("registration callback did not trigger shutdown");
      expect(await closing).toBe(0);
      expect(registry.size()).toBe(0);
      expect(registry.pendingInits).toBe(0);
      expect(registry.acceptingInits).toBe(false);
    } finally {
      await closeServerBounded(httpServer);
    }

    const hangHandler = createHttpHandler(deps, {
      vault: root,
      port: 0,
      host: "127.0.0.1",
      bearerToken: "late-registration-test-token-1234567890",
      stateful: true,
      rateLimitPerMinute: 0,
      installSignalHandlers: false
    });
    const originalHandleRequest = NodeStreamableHTTPServerTransport.prototype.handleRequest;
    const injectResponses = new WeakSet<ServerResponse>();
    NodeStreamableHTTPServerTransport.prototype.handleRequest = async function (req, res, parsedBody) {
      if (!injectResponses.has(res)) {
        return originalHandleRequest.call(this, req, res, parsedBody);
      }
      const writeHead = res.writeHead.bind(res);
      const end = res.end.bind(res);
      // Close-delimited head so finishCaughtHttpResponse can complete the body.
      // Leave end uncommitted during the Hono listener — a throw from
      // write/end is swallowed by @hono/node-server and never reaches the
      // product catch. Throw after that listener returns, still inside the
      // product's await tr.handleRequest.
      res.writeHead = ((statusCode: number, ..._rest: unknown[]) =>
        writeHead(statusCode, { Connection: "close" })) as typeof res.writeHead;
      res.end = ((..._args: unknown[]) => res) as typeof res.end;
      try {
        await originalHandleRequest.call(this, req, res, parsedBody);
      } finally {
        res.end = end;
      }
      if (res.headersSent && !res.writableEnded) {
        throw new Error("injected post-header failure");
      }
    };
    const hangServer = createServer((req, res) => {
      injectResponses.add(res);
      void hangHandler(req, res);
    });
    const hangStderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await new Promise<void>((resolve) => hangServer.listen(0, "127.0.0.1", resolve));
      const addr = hangServer.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${addr.port}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: "Bearer late-registration-test-token-1234567890"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "late-registration-test", version: "0" }
          }
        }),
        signal: AbortSignal.timeout(3000)
      });
      await response.text();
      const log = hangStderr.mock.calls.map(([chunk]) => String(chunk)).join("");
      expect(log).toMatch(/stateful initialize error.*injected post-header failure/is);
    } finally {
      NodeStreamableHTTPServerTransport.prototype.handleRequest = originalHandleRequest;
      hangStderr.mockRestore();
      await closeServerBounded(hangServer);
    }
  });
});

describe("modern HTTP lifecycle (SDK v2)", () => {
  function makeLifecycle(writeTracker: WriteRequestTracker, handlerClose?: () => Promise<void>) {
    const out: NonNullable<Parameters<typeof createHttpHandler>[2]> = { registry: null };
    createHttpHandler(
      {} as Parameters<typeof createHttpHandler>[0],
      {
        vault: "/unused-modern-lifecycle-test",
        port: 0,
        host: "127.0.0.1",
        bearerToken: "modern-lifecycle-test-token-1234567890",
        rateLimitPerMinute: 0,
        installSignalHandlers: false
      },
      out,
      {
        modernDrainMs: 0,
        modernWriteTracker: writeTracker,
        ...(handlerClose ? { modernCloseMs: 0, modernHandlerClose: handlerClose } : {})
      }
    );
    if (!out.modern) throw new Error("modern lifecycle was not published");
    return out.modern;
  }

  it("waits for an owned finish-only write before closing the SDK handler", async () => {
    const tracker = new WriteRequestTracker();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const activeWrite = tracker.run("modern-write", new AbortController().signal, "finish", async () => gate);
    expect(tracker.activeCount).toBe(1);

    const lifecycle = makeLifecycle(tracker);
    let closeSettled = false;
    const firstClose = lifecycle.close();
    expect(lifecycle.close()).toBe(firstClose);
    const closing = firstClose.then(() => {
      closeSettled = true;
    });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(closeSettled, "finish-only mutation must outlive the ordinary zero-ms grace").toBe(false);

    release?.();
    await activeWrite;
    await closing;
    expect(tracker.activeCount).toBe(0);
    await expect(
      tracker.run("late-write", new AbortController().signal, "finish", async () => undefined)
    ).rejects.toThrow(/cancelled before mutation/);
  });

  it("negative control: does not mistake an unrelated tracker for an owned modern write", async () => {
    const owned = new WriteRequestTracker();
    const unrelated = new WriteRequestTracker();
    let release: (() => void) | undefined;
    const activeWrite = unrelated.run("foreign-write", new AbortController().signal, "finish", async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    expect(unrelated.activeCount).toBe(1);

    await makeLifecycle(owned).close();
    expect(unrelated.activeCount).toBe(1);
    release?.();
    await activeWrite;

    // A protocol close that never settles must not pin the lifecycle after
    // persistent-write integrity is already complete.
    let closeCalls = 0;
    const neverClosing = new Promise<void>(() => {});
    const bounded = makeLifecycle(new WriteRequestTracker(), () => {
      closeCalls += 1;
      return neverClosing;
    });
    await bounded.close();
    expect(closeCalls).toBe(1);
  });
});

describe("modern HTTP dual-era structural invariant", () => {
  it("keeps official routing and write-safe shutdown in the production path", async () => {
    const source = await fs.readFile(path.resolve("src/http-transport.ts"), "utf8");
    expect(modernHttpV2Problems(source)).toEqual([]);
  });

  it("negative control: each tracker, shutdown, and routing regression is independently causal", async () => {
    const source = await fs.readFile(path.resolve("src/http-transport.ts"), "utf8");
    const mutations = [
      {
        label: "modern factory tracker bypass",
        needle: "createMcpHandler(() => buildMcpServer(deps, opts, writeTracker), {",
        replacement: "createMcpHandler(() => buildMcpServer(deps, opts), {",
        expectedProblems: ["modern: factory does not attach the aggregate write tracker"]
      },
      {
        label: "unawaited aggregate write drain",
        needle:
          'await writeTracker.abortRollbackSafe("Modern HTTP shutdown exceeded the request-drain deadline");\n' +
          "        await writeTracker.waitForAll();",
        replacement:
          'await writeTracker.abortRollbackSafe("Modern HTTP shutdown exceeded the request-drain deadline");\n' +
          "        void writeTracker.waitForAll();",
        expectedProblems: ["modern: write integrity tail does not precede bounded handler close"]
      },
      {
        label: "legacy stateless tracker bypass",
        needle: "handleStatelessRequest(req, res, deps, opts, body, writeTracker)",
        replacement: "handleStatelessRequest(req, res, deps, opts, body)",
        expectedProblems: ["legacy stateless: dispatch is not owned by the shared write tracker"]
      },
      {
        label: "legacy stateless server tracker bypass",
        needle: "const server = buildMcpServer(deps, opts, writeTracker);",
        replacement: "const server = buildMcpServer(deps, opts);",
        expectedProblems: ["legacy stateless: server factory bypasses the shared write tracker"]
      },
      {
        label: "unbounded modern handler close",
        needle: "await waitForBoundedSettlement(closeTask, closeMs)",
        replacement: "await closeTask",
        expectedProblems: ["modern: write integrity tail does not precede bounded handler close"]
      },
      {
        label: "missing content-type guard",
        needle: 'if (req.method === "POST" && !isJsonContentType(req.headers["content-type"])) {',
        replacement: 'if (req.method === "POST") {',
        expectedProblems: ["routing: Content-Type 415 guard does not precede JSON parsing"]
      },
      {
        label: "disabled official classifier",
        needle: "if (!(await isLegacyRequest(probe, body))) {",
        replacement: "if (false) {",
        expectedProblems: ["routing: official classifier does not precede legacy session requirements"]
      },
      {
        label: "duplicate body read and dropped parsed-body forwarding",
        needle: "const probe = await toWebRequest(req, body);",
        replacement: "await readJsonBody(req, maxBodyBytes);\n          const probe = await toWebRequest(req);",
        expectedProblems: [
          "routing: Node request body is not read exactly once",
          "routing: parsed body is not forwarded to modern classification and dispatch"
        ]
      },
      {
        label: "unawaited protocol-owner close",
        needle: "await Promise.all([modernClose, legacyClose]);",
        replacement: "void modernClose; void legacyClose;",
        expectedProblems: ["shutdown: protocol owners do not close before shared dependencies"]
      },
      {
        label: "unmemoized concurrent shutdown",
        needle: "httpServerShutdowns.set(server, shutdownTask);",
        replacement: "void shutdownTask;",
        expectedProblems: ["shutdown: concurrent callers do not join one memoized teardown"]
      }
    ] as const;

    for (const mutation of mutations) {
      const broken = replaceExactly(source, mutation.needle, mutation.replacement);
      expect(broken, `${mutation.label} must change the production source`).not.toBe(source);
      expect(modernHttpV2Problems(broken), mutation.label).toEqual(mutation.expectedProblems);
    }
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

describe("isJsonContentType (SDK v2 HTTP admission)", () => {
  it("accepts the JSON essence with case variants and parameters", () => {
    expect(isJsonContentType("application/json")).toBe(true);
    expect(isJsonContentType("Application/JSON; charset=utf-8")).toBe(true);
    expect(isJsonContentType("application/json;")).toBe(true);
    expect(isJsonContentType('application/json; note="a,b"')).toBe(true);
    expect(isJsonContentType('application/json; note="a\\",b"')).toBe(true);
    // Match the SDK parser fallback: a malformed parameter tail does not
    // obscure an otherwise unambiguous JSON media-type essence.
    expect(isJsonContentType("application/json; charset=")).toBe(true);
    expect(isJsonContentType('application/json; note="unfinished')).toBe(true);
  });

  it("rejects missing, misleading, duplicate, and non-JSON media types", () => {
    expect(isJsonContentType(undefined)).toBe(false);
    expect(isJsonContentType("")).toBe(false);
    expect(isJsonContentType(["application/json", "text/plain"])).toBe(false);
    expect(isJsonContentType("text/plain; example=application/json")).toBe(false);
    expect(isJsonContentType("application/json; charset=utf-8, text/plain")).toBe(false);
    expect(isJsonContentType('application/json; note="a,b", text/plain')).toBe(false);
    expect(isJsonContentType('application/json; note="a,b')).toBe(false);
    expect(isJsonContentType("application/problem+json")).toBe(false);
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
    await expect(readJsonBody(asReq(big), 100)).rejects.toMatchObject({ name: "BodyTooLargeError" });
  });
});

// The decoded file budget and its JSON wire representation are different
// units: an ASCII control byte can expand to the six-byte `\u00xx` spelling.
describe("deriveHttpBodyCap", () => {
  it("covers worst-case JSON escaping plus a bounded envelope under defaults", () => {
    const cap = deriveHttpBodyCap(undefined);
    const expected = Math.max(4 * 1024 * 1024, DEFAULT_MAX_FILE_BYTES * 6 + 64 * 1024);
    expect(cap).toBe(expected);
    expect(cap).toBeGreaterThanOrEqual(DEFAULT_MAX_FILE_BYTES * 6 + 2);
  });

  it("admits a 10 MiB decoded file without exceeding the operational ceiling", () => {
    const tenMb = 10 * 1024 * 1024;
    const cap = deriveHttpBodyCap(String(tenMb));
    expect(cap).toBe(tenMb * 6 + 64 * 1024);
    expect(cap).toBeLessThanOrEqual(64 * 1024 * 1024);
  });

  it("holds the 4 MiB floor for a tiny decoded file cap", () => {
    const cap = deriveHttpBodyCap("1");
    expect(cap).toBe(4 * 1024 * 1024);
  });

  it("rejects a decoded file budget whose worst-case wire form exceeds 64 MiB", () => {
    expect(() => deriveHttpBodyCap(String(12 * 1024 * 1024))).toThrow(/request ceiling/);
  });

  it("falls back to default on malformed input", () => {
    expect(parseMaxFileBytes("nonsense")).toBeUndefined();
    expect(parseMaxFileBytes("-1000")).toBeUndefined();
    expect(parseMaxFileBytes("0")).toBeUndefined();
    expect(parseMaxFileBytes("3.14")).toBeUndefined();
    // Each falls back to DEFAULT_MAX_FILE_BYTES inside deriveHttpBodyCap.
    expect(deriveHttpBodyCap("nonsense")).toBe(deriveHttpBodyCap(undefined));
  });

  // Negative-control: the superseded 1.5x formula cannot carry worst-case
  // escaped content even though the decoded content itself is within limit.
  it("(negative-control) rejects the legacy 1.5x escaping assumption", () => {
    const cap = deriveHttpBodyCap(undefined);
    const legacy = Math.floor(DEFAULT_MAX_FILE_BYTES * 1.5);
    expect(legacy).toBeLessThan(DEFAULT_MAX_FILE_BYTES * 6 + 2);
    expect(cap).toBeGreaterThan(legacy);
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

describe("isPersistentWriteRequest (H-2 durable lifecycle)", () => {
  it("detects vault writes, feedback-sidecar writes, and a write inside a JSON-RPC batch", () => {
    expect(
      isPersistentWriteRequest({
        jsonrpc: "2.0",
        method: "tools/call",
        id: 1,
        params: { name: "obsidian_replace_in_notes", arguments: {} }
      })
    ).toBe(true);
    expect(
      isPersistentWriteRequest({
        jsonrpc: "2.0",
        method: "tools/call",
        id: 2,
        params: { name: "obsidian_mark_useful", arguments: {} }
      })
    ).toBe(true);
    expect(
      isPersistentWriteRequest([
        { jsonrpc: "2.0", method: "tools/list", id: 3 },
        {
          jsonrpc: "2.0",
          method: "tools/call",
          id: 4,
          params: { name: "obsidian_frontmatter_set", arguments: {} }
        }
      ])
    ).toBe(true);
  });

  it("(negative-control) rejects read tools, unknown tools, and misleading non-call payloads", () => {
    expect(
      isPersistentWriteRequest({
        jsonrpc: "2.0",
        method: "tools/call",
        id: 1,
        params: { name: "obsidian_read_note", arguments: {} }
      })
    ).toBe(false);
    expect(
      isPersistentWriteRequest({
        jsonrpc: "2.0",
        method: "tools/call",
        id: 2,
        params: { name: "obsidian_not_real", arguments: {} }
      })
    ).toBe(false);
    expect(
      isPersistentWriteRequest({
        jsonrpc: "2.0",
        method: "notifications/progress",
        params: { name: "obsidian_replace_in_notes" }
      })
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

  it("causally rolls pre-bind and post-listen faults back without masking the startup cause", async () => {
    const order: string[] = [];
    const startupError = new Error("injected post-listen failure");
    const protocolClose = vi.fn(async () => void order.push("protocol"));
    const listenerFixture = createStartupListenerFixture();
    const signalCounts = {
      sigint: process.listenerCount("SIGINT"),
      sigterm: process.listenerCount("SIGTERM"),
      beforeExit: process.listenerCount("beforeExit")
    };
    let listener: ReturnType<typeof createServer> | undefined;
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      // Positive regression: a real Node Server reports ERR_SERVER_NOT_RUNNING
      // when cleanup closes it after listen() failed. That state is terminal,
      // so the original bind error must remain the exact public failure.
      const bindError = Object.assign(new Error("injected bind failure"), { code: "EADDRINUSE" });
      const notRunning = Object.assign(new Error("Server is not running."), { code: "ERR_SERVER_NOT_RUNNING" });
      const failedBindFixture = createStartupListenerFixture({ listenError: bindError, closeError: notRunning });
      const failedBindProtocolClose = vi.fn(async () => {});
      await expect(
        startHttpServer(
          {
            vault: root,
            port: 0,
            host: "127.0.0.1",
            bearerToken: TOKEN,
            installSignalHandlers: true,
            embeddingIndex: false,
            persistentIndex: false
          },
          {
            modernHandlerClose: failedBindProtocolClose,
            httpServerFactory: () => failedBindFixture.server
          }
        )
      ).rejects.toBe(bindError);
      expect(failedBindProtocolClose).toHaveBeenCalledTimes(1);
      expect(failedBindFixture.closeCalls()).toBe(1);
      expect(failedBindFixture.server.listening).toBe(false);

      await expect(
        startHttpServer(
          {
            vault: root,
            port: 0,
            host: "127.0.0.1",
            bearerToken: TOKEN,
            installSignalHandlers: true,
            embeddingIndex: false,
            persistentIndex: false
          },
          {
            modernHandlerClose: protocolClose,
            httpServerFactory: () => listenerFixture.server,
            beforeStartupCommit: (server, deps) => {
              listener = server;
              const closePersistence = deps.vault.closePersistence.bind(deps.vault);
              deps.vault.closePersistence = async () => {
                order.push("deps");
                await closePersistence();
              };
              throw startupError;
            }
          }
        )
      ).rejects.toBe(startupError);
      expect(protocolClose).toHaveBeenCalledTimes(1);
      expect(listener?.listening).toBe(false);
      expect(listener?.address()).toBeNull();
      expect(listenerFixture.closeCalls()).toBe(1);
      expect(order).toEqual(["protocol", "deps"]);
      expect(process.listenerCount("SIGINT")).toBe(signalCounts.sigint);
      expect(process.listenerCount("SIGTERM")).toBe(signalCounts.sigterm);
      expect(process.listenerCount("beforeExit")).toBe(signalCounts.beforeExit);
      expect(stderr.mock.calls.some(([message]) => String(message).includes("transport=http"))).toBe(false);
    } finally {
      stderr.mockRestore();
    }
  });

  it("aggregates a post-listen fault with a shared-dependency cleanup failure", async () => {
    const startupError = new Error("injected post-listen failure");
    const dependencyError = new Error("injected dependency release failure");
    const listenerFixture = createStartupListenerFixture();
    let listener: ReturnType<typeof createServer> | undefined;
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      let thrown: unknown;
      try {
        await startHttpServer(
          {
            vault: root,
            port: 0,
            host: "127.0.0.1",
            bearerToken: TOKEN,
            installSignalHandlers: false,
            embeddingIndex: false,
            persistentIndex: false
          },
          {
            httpServerFactory: () => listenerFixture.server,
            beforeStartupCommit: (server, deps) => {
              listener = server;
              deps.ftsIndex = {
                closeAndRelease: async () => {
                  throw dependencyError;
                }
              } as unknown as NonNullable<Parameters<typeof createHttpHandler>[0]["ftsIndex"]>;
              throw startupError;
            }
          }
        );
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AggregateError);
      expect((thrown as AggregateError).errors).toEqual([startupError, dependencyError]);
      expect(listener?.listening).toBe(false);
      expect(listener?.address()).toBeNull();
      expect(listenerFixture.closeCalls()).toBe(1);

      // NEGATIVE control: only Node's idempotent terminal code is swallowed.
      // A genuine listener-cleanup failure must remain aggregated after the
      // exact startup cause, or the ownership gate would false-green debt.
      const bindError = Object.assign(new Error("injected bind failure"), { code: "EADDRINUSE" });
      const listenerCleanupError = new Error("injected listener cleanup failure");
      const failedBindFixture = createStartupListenerFixture({
        listenError: bindError,
        closeError: listenerCleanupError
      });
      let failedBindThrown: unknown;
      try {
        await startHttpServer(
          {
            vault: root,
            port: 0,
            host: "127.0.0.1",
            bearerToken: TOKEN,
            installSignalHandlers: false,
            embeddingIndex: false,
            persistentIndex: false
          },
          { httpServerFactory: () => failedBindFixture.server }
        );
      } catch (error) {
        failedBindThrown = error;
      }
      expect(failedBindThrown).toBeInstanceOf(AggregateError);
      expect((failedBindThrown as AggregateError).errors).toEqual([bindError, listenerCleanupError]);
      expect(failedBindFixture.closeCalls()).toBe(1);
    } finally {
      stderr.mockRestore();
    }
  });

  it("NEGATIVE control — successful post-listen commit does not run rollback before return", async () => {
    const protocolClose = vi.fn(async () => {});
    const dependencyClose = vi.fn(async () => {});
    const listenerFixture = createStartupListenerFixture();
    let hookCalls = 0;
    const httpServer = await startHttpServer(
      {
        vault: root,
        port: 0,
        host: "127.0.0.1",
        bearerToken: TOKEN,
        installSignalHandlers: false,
        embeddingIndex: false,
        persistentIndex: false
      },
      {
        modernHandlerClose: protocolClose,
        httpServerFactory: () => listenerFixture.server,
        beforeStartupCommit: (_server, deps) => {
          hookCalls += 1;
          const closePersistence = deps.vault.closePersistence.bind(deps.vault);
          deps.vault.closePersistence = async () => {
            await dependencyClose();
            await closePersistence();
          };
        }
      }
    );
    try {
      expect(hookCalls).toBe(1);
      expect(httpServer.listening).toBe(true);
      expect(listenerFixture.closeCalls()).toBe(0);
      expect(protocolClose).not.toHaveBeenCalled();
      expect(dependencyClose).not.toHaveBeenCalled();
    } finally {
      await shutdownHttpServer(httpServer);
    }
    expect(protocolClose).toHaveBeenCalledTimes(1);
    expect(dependencyClose).toHaveBeenCalledTimes(1);
    expect(listenerFixture.closeCalls()).toBe(1);
  });

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

  it("serves modern server/discover without initialize or a session id", async () => {
    const s = await spawn();
    try {
      const response = await fetch(`${s.url}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${TOKEN}`,
          "MCP-Protocol-Version": MODERN_PROTOCOL_VERSION,
          "Mcp-Method": "server/discover"
        },
        body: JSON.stringify(modernDiscoverBody("discover-1"))
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("Mcp-Session-Id")).toBeNull();
      const body = (await response.json()) as { result: { supportedVersions: string[] } };
      expect(body.result.supportedVersions).toContain(MODERN_PROTOCOL_VERSION);
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
      expect(res.headers.get("Access-Control-Allow-Headers")).toContain("MCP-Protocol-Version");
      expect(res.headers.get("Access-Control-Allow-Headers")).toContain("Mcp-Method");
      expect(res.headers.get("Access-Control-Allow-Headers")).toContain("Mcp-Name");
      // v3.10.0-rc.62 (HTTP-CORS-EXPOSE-SESSION-ID) — a browser MCP client must be able to READ
      // the Mcp-Session-Id the server returns on `initialize`; that requires it in Expose-Headers.
      expect(res.headers.get("Access-Control-Expose-Headers")).toContain("Mcp-Session-Id");
      expect(res.headers.get("Access-Control-Expose-Headers")).toContain("WWW-Authenticate");
      expect(res.headers.get("Access-Control-Expose-Headers")).toContain("Last-Event-ID");
      expect(res.headers.get("Access-Control-Expose-Headers")).toContain("MCP-Protocol-Version");
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
      expect(res.headers.get("Access-Control-Expose-Headers")).toBe(
        "Mcp-Session-Id, WWW-Authenticate, Last-Event-ID, MCP-Protocol-Version"
      );
    } finally {
      await s.close();
    }
  });

  it("refuses wildcard, opaque, malformed, and non-origin CORS configuration before opening the vault", async () => {
    const invalidConfigs = [
      ["*"],
      ["https://claude.ai", "*"],
      ["null"],
      ["https://claude.ai/path"],
      ["https://claude.ai?query=1"],
      ["https://claude.ai#fragment"],
      [" https://claude.ai"],
      ["ftp://claude.ai"],
      ["not-an-origin"]
    ];
    for (const corsOrigins of invalidConfigs) {
      await expect(
        startHttpServer({
          // The missing path is a negative control for startup order: an
          // Origin-policy error must win before vault preparation can fail.
          vault: path.join(root, "missing-vault"),
          port: 0,
          host: "127.0.0.1",
          bearerToken: TOKEN,
          corsOrigins,
          installSignalHandlers: false
        })
      ).rejects.toThrow(/--cors-origin/);
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

  it("rejects every disallowed Origin with 403 before routes, auth, body parsing, rate-limit, or MCP dispatch", async () => {
    const s = await spawn({ corsOrigins: ["https://claude.ai"], rateLimitPerMinute: 1 });
    try {
      const initBody = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "vitest-origin", version: "0.0.0" }
        }
      });

      const preflight = await fetch(`${s.url}/mcp`, {
        method: "OPTIONS",
        headers: {
          Origin: "https://evil.example.com",
          "Access-Control-Request-Method": "POST"
        }
      });
      expect(preflight.status).toBe(403);
      expect(preflight.headers.get("Access-Control-Allow-Origin")).toBeNull();
      expect(await preflight.text()).not.toContain("evil.example.com");

      const health = await fetch(`${s.url}/health`, {
        headers: { Origin: "https://evil.example.com" }
      });
      expect(health.status).toBe(403);

      for (const origin of ["null", "not an origin", "https://evil.example.com, https://other.example.com"]) {
        const malformed = await fetch(`${s.url}/mcp`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: origin },
          body: "{"
        });
        // 403 instead of 401/400 proves Origin admission precedes auth and
        // body parsing. Opaque/malformed/multiple values cannot be admitted.
        expect(malformed.status, origin).toBe(403);
      }

      const hostilePost = await fetch(`${s.url}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${TOKEN}`,
          Origin: "https://evil.example.com"
        },
        body: initBody
      });
      expect(hostilePost.status).toBe(403);

      const allowedHeaders = {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${TOKEN}`,
        Origin: "https://claude.ai"
      };
      const allowed = await fetch(`${s.url}/mcp`, {
        method: "POST",
        headers: allowedHeaders,
        body: initBody
      });
      expect(allowed.status).toBe(200);
      expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe("https://claude.ai");
      await allowed.text();

      const overBudget = await fetch(`${s.url}/mcp`, {
        method: "POST",
        headers: allowedHeaders,
        body: initBody
      });
      // The single admitted request consumed the one-request budget; all
      // rejected Origin probes above consumed none.
      expect(overBudget.status).toBe(429);
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
  it("returns 415 before parsing or era fallback for an invalid Content-Type", async () => {
    const s = await spawn();
    try {
      const res = await fetch(`${s.url}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "text/plain; example=application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${TOKEN}`,
          "MCP-Protocol-Version": MODERN_PROTOCOL_VERSION,
          "Mcp-Method": "tools/list"
        },
        // Malformed bytes are deliberate: 415 must win over JSON parse 400,
        // and the modern header must not send this request to legacy routing.
        body: "{not valid json"
      });
      expect(res.status).toBe(415);
      const body = (await res.json()) as { error: { code: number; message: string } };
      expect(body.error.code).toBe(-32000);
      expect(body.error.message).toContain("Content-Type must be application/json");
    } finally {
      await s.close();
    }
  });

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

  it("routes modern traffic before legacy session lookup even when a legacy session id is supplied", async () => {
    const s = await spawnStateful();
    try {
      const response = await fetch(`${s.url}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${TOKEN}`,
          "Mcp-Session-Id": "bogus-legacy-session",
          "MCP-Protocol-Version": MODERN_PROTOCOL_VERSION,
          "Mcp-Method": "server/discover"
        },
        body: JSON.stringify(modernDiscoverBody("stateful-modern"))
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("Mcp-Session-Id")).toBeNull();
      const body = (await response.json()) as { result: { supportedVersions: string[] } };
      expect(body.result.supportedVersions).toContain(MODERN_PROTOCOL_VERSION);
    } finally {
      await s.close();
    }
  });

  it("does not downgrade a malformed modern claim into legacy session routing", async () => {
    const s = await spawnStateful();
    try {
      const response = await fetch(`${s.url}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${TOKEN}`,
          "Mcp-Session-Id": "bogus-legacy-session",
          "MCP-Protocol-Version": MODERN_PROTOCOL_VERSION,
          "Mcp-Method": "tools/list"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 7,
          method: "tools/list",
          params: {
            _meta: {
              "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION,
              "io.modelcontextprotocol/clientCapabilities": "malformed-on-purpose"
            }
          }
        })
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { code: number; data?: unknown } };
      expect(body.error.code).toBe(-32602);
      expect(JSON.stringify(body)).not.toMatch(/unknown session/i);
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

    const idleTimeoutMs = 25;
    const occupied = await startHttpServer(
      {
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
        sessionIdleTimeoutMs: idleTimeoutMs,
        installSignalHandlers: false
      },
      {
        afterStatefulRequestAdmitted: async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, idleTimeoutMs + 20));
        }
      }
    );
    try {
      const addr = occupied.address() as AddressInfo;
      const url = `http://127.0.0.1:${addr.port}`;
      const { sessionId, rawResponse } = await initSession(url);
      await rawResponse.text();
      const followUp = await fetch(`${url}/mcp`, {
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
      expect(followUp.status).toBeLessThan(300);
      await followUp.text();
    } finally {
      await shutdownHttpServer(occupied);
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

  it("gives an admitted modern exchange a bounded grace before handler close", async () => {
    let markAdmitted: (() => void) | undefined;
    const admitted = new Promise<void>((resolve) => {
      markAdmitted = resolve;
    });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const httpServer = await startHttpServer(
      {
        vault: root,
        port: 0,
        host: "127.0.0.1",
        bearerToken: TOKEN,
        mcpPath: "/mcp",
        rateLimitPerMinute: 0,
        stateful: true,
        installSignalHandlers: false
      },
      {
        modernDrainMs: 1000,
        afterModernRequestAdmitted: async () => {
          markAdmitted?.();
          await gate;
        }
      }
    );
    const addr = httpServer.address() as AddressInfo;
    const responsePromise = fetch(`http://127.0.0.1:${addr.port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${TOKEN}`,
        "MCP-Protocol-Version": MODERN_PROTOCOL_VERSION,
        "Mcp-Method": "server/discover"
      },
      body: JSON.stringify(modernDiscoverBody("grace-positive"))
    });
    await admitted;
    let shutdownSettled = false;
    const shutdown = shutdownHttpServer(httpServer).then(() => {
      shutdownSettled = true;
    });
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      expect(shutdownSettled).toBe(false);
      release?.();
      const response = await responsePromise;
      expect(response.status).toBe(200);
      await response.text();
      await shutdown;
    } finally {
      release?.();
      await shutdown.catch(() => {});
    }
  });

  it("negative control: zero modern grace closes an admitted exchange before dispatch", async () => {
    let markAdmitted: (() => void) | undefined;
    const admitted = new Promise<void>((resolve) => {
      markAdmitted = resolve;
    });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const httpServer = await startHttpServer(
      {
        vault: root,
        port: 0,
        host: "127.0.0.1",
        bearerToken: TOKEN,
        mcpPath: "/mcp",
        rateLimitPerMinute: 0,
        stateful: true,
        installSignalHandlers: false
      },
      {
        modernDrainMs: 0,
        afterModernRequestAdmitted: async () => {
          markAdmitted?.();
          await gate;
        }
      }
    );
    const addr = httpServer.address() as AddressInfo;
    const responsePromise = fetch(`http://127.0.0.1:${addr.port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${TOKEN}`,
        "MCP-Protocol-Version": MODERN_PROTOCOL_VERSION,
        "Mcp-Method": "server/discover"
      },
      body: JSON.stringify(modernDiscoverBody("grace-negative"))
    });
    await admitted;
    const shutdown = shutdownHttpServer(httpServer);
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      release?.();
      const response = await responsePromise;
      expect(response.status).toBe(500);
      await response.text();
      await shutdown;
    } finally {
      release?.();
      await shutdown.catch(() => {});
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

    const signalCounts = {
      sigint: process.listenerCount("SIGINT"),
      sigterm: process.listenerCount("SIGTERM"),
      beforeExit: process.listenerCount("beforeExit")
    };
    const owned = await startHttpServer({
      vault: root,
      port: 0,
      host: "127.0.0.1",
      bearerToken: TOKEN,
      mcpPath: "/mcp",
      rateLimitPerMinute: 0,
      stateful: false,
      installSignalHandlers: true
    });
    try {
      expect(process.listenerCount("SIGINT")).toBeGreaterThan(signalCounts.sigint);
      expect(process.listenerCount("SIGTERM")).toBeGreaterThan(signalCounts.sigterm);
      expect(process.listenerCount("beforeExit")).toBeGreaterThan(signalCounts.beforeExit);
    } finally {
      await shutdownHttpServer(owned);
    }
    expect(process.listenerCount("SIGINT")).toBe(signalCounts.sigint);
    expect(process.listenerCount("SIGTERM")).toBe(signalCounts.sigterm);
    expect(process.listenerCount("beforeExit")).toBe(signalCounts.beforeExit);
  });

  // v3.8.7 P2-11 + v4 — concurrent/later shutdown calls join one safe task.
  it("shutdownHttpServer is idempotent across concurrent and later calls", async () => {
    const httpServer = await startHttpServer({
      vault: root,
      port: 0,
      host: "127.0.0.1",
      bearerToken: TOKEN,
      stateful: true,
      installSignalHandlers: false
    });
    // Concurrent callers must join the same teardown rather than letting the
    // second call close TCP while the first still drains protocol/write owners.
    const first = shutdownHttpServer(httpServer);
    const concurrent = shutdownHttpServer(httpServer);
    await expect(Promise.all([first, concurrent])).resolves.toEqual([undefined, undefined]);
    // A later call must remain a safe no-op over the completed memoized task.
    await expect(shutdownHttpServer(httpServer)).resolves.toBeUndefined();
  });

  it("does not memoize a listener close error as success and retries the same listener", async () => {
    const listenerFixture = createStartupListenerFixture();
    const exactListener = listenerFixture.server;
    let attempts = 0;
    exactListener.close = ((callback?: (error?: Error) => void) => {
      attempts++;
      queueMicrotask(() => callback?.(attempts === 1 ? new Error("transient listener close") : undefined));
      return exactListener;
    }) as typeof exactListener.close;

    await expect(shutdownHttpServer(exactListener)).rejects.toThrow("transient listener close");
    await expect(shutdownHttpServer(exactListener)).resolves.toBeUndefined();
    expect(attempts).toBe(2);
    // Completed listener closure remains memoized and is not repeated.
    await expect(shutdownHttpServer(exactListener)).resolves.toBeUndefined();
    expect(attempts).toBe(2);
  });

  it("retries failed HTTP dependency ownership once before choosing the signal exit status", async () => {
    let vaultReleaseAttempts = 0;
    let cacheFlushes = 0;
    const listenerFixture = createStartupListenerFixture();
    const httpServer = await startHttpServer(
      {
        vault: root,
        port: 0,
        host: "127.0.0.1",
        bearerToken: TOKEN,
        stateful: false,
        persistentCache: true,
        installSignalHandlers: false
      },
      {
        httpServerFactory: () => listenerFixture.server,
        beforeStartupCommit: (_listener, deps) => {
          const exactClose = deps.vault.closePersistence.bind(deps.vault);
          const exactSave = deps.vault.saveDiskCache.bind(deps.vault);
          deps.vault.closePersistence = async () => {
            vaultReleaseAttempts++;
            if (vaultReleaseAttempts === 1) throw new Error("transient exact vault release");
            await exactClose();
          };
          deps.vault.saveDiskCache = async () => {
            cacheFlushes++;
            await exactSave();
          };
        }
      }
    );

    let exitCode: number | undefined;
    makeHttpShutdownHandler(httpServer, (code) => {
      exitCode = code;
    })();
    await vi.waitFor(() => expect(exitCode).toBe(0));
    expect(httpServer.address()).toBeNull();
    expect(vaultReleaseAttempts).toBe(2);
    expect(cacheFlushes).toBe(1);

    // The bounded retry used the retained owner. Only the failed Vault stage
    // ran twice; already-terminal stages were not repeated.
    await expect(shutdownHttpServer(httpServer)).resolves.toBeUndefined();
    expect(vaultReleaseAttempts).toBe(2);
    expect(cacheFlushes).toBe(1);
    // Completed cleanup remains an idempotent no-op.
    await expect(shutdownHttpServer(httpServer)).resolves.toBeUndefined();
    expect(vaultReleaseAttempts).toBe(2);
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
    // Bind-failure control: this is Node's real callback behavior after a
    // listener never started (`ERR_SERVER_NOT_RUNNING`). It is already a
    // terminal owner state and must be idempotent cleanup success.
    const neverBound = createServer();
    await expect(closeServerBounded(neverBound, 5000)).resolves.toBeUndefined();
    expect(neverBound.listening).toBe(false);

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
