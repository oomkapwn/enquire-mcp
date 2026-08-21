import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import {
  BodyTooLargeError,
  createHttpHandler,
  deriveHttpBodyCap,
  type HttpServeOptions,
  normalizeHttpServeOptions,
  readJsonBody,
  startHttpServer
} from "../src/http-transport.js";

const BASE_OPTIONS = {
  vault: "/not-opened-by-http-admission-tests",
  port: 0,
  host: "127.0.0.1",
  bearerToken: "http-admission-test-token"
} satisfies HttpServeOptions;

function withOption(name: string, value: unknown): unknown {
  return { ...BASE_OPTIONS, [name]: value };
}

function requestWithBody(
  chunks: readonly Buffer[],
  headers: Record<string, string> = {},
  onIterate?: () => void
): IncomingMessage {
  return {
    method: "POST",
    url: "/mcp",
    headers: {
      authorization: `Bearer ${BASE_OPTIONS.bearerToken}`,
      "content-type": "application/json",
      ...headers
    },
    async *[Symbol.asyncIterator]() {
      onIterate?.();
      for (const chunk of chunks) yield chunk;
    }
  } as unknown as IncomingMessage;
}

function responseCapture(): { response: ServerResponse; body: () => string } {
  let responseBody = "";
  const response = {
    headersSent: false,
    statusCode: 200,
    setHeader() {
      return this;
    },
    end(value?: string | Buffer) {
      responseBody = value === undefined ? "" : String(value);
      this.headersSent = true;
      return this;
    }
  } as unknown as ServerResponse;
  return { response, body: () => responseBody };
}

describe("HTTP serve option runtime admission", () => {
  it("normalizes valid defaults, exact arrays, booleans, routes, and integer boundaries", () => {
    const normalized = normalizeHttpServeOptions({
      ...BASE_OPTIONS,
      port: 65_535,
      rateLimitPerMinute: Number.MAX_SAFE_INTEGER,
      sessionIdleTimeoutMs: 1,
      maxSessions: Number.MAX_SAFE_INTEGER,
      stateful: false,
      installSignalHandlers: false,
      corsOrigins: ["https://claude.ai", "https://claude.ai"],
      mcpPath: "/rpc/v1",
      healthPath: "/ready"
    });

    expect(normalized).toMatchObject({
      port: 65_535,
      rateLimitPerMinute: Number.MAX_SAFE_INTEGER,
      sessionIdleTimeoutMs: 1,
      maxSessions: Number.MAX_SAFE_INTEGER,
      stateful: false,
      installSignalHandlers: false,
      corsOrigins: ["https://claude.ai"],
      mcpPath: "/rpc/v1",
      healthPath: "/ready"
    });
    expect(normalizeHttpServeOptions(BASE_OPTIONS)).toMatchObject({
      mcpPath: "/mcp",
      healthPath: "/health",
      corsOrigins: []
    });
  });

  it.each([[null], [[]], ["serve"]])("rejects a non-object options root %#", (value) => {
    expect(() => normalizeHttpServeOptions(value)).toThrow(/must be an object/);
  });

  it.each([
    ["stateful", "false", /stateful must be a boolean/],
    ["installSignalHandlers", 0, /installSignalHandlers must be a boolean/],
    ["host", ["127.0.0.1"], /host must be a string/],
    ["host", " 127.0.0.1", /host must be non-empty/],
    ["bearerToken", { token: "secret" }, /bearerToken must be a string/],
    ["bearerToken", "short", /must be ≥16 chars/],
    ["bearerToken", " http-admission-test-token", /outer whitespace/],
    ["corsOrigins", "https://claude.ai", /corsOrigins must be an array of strings/],
    ["corsOrigins", ["https://claude.ai", 7], /corsOrigins must be an array of strings/],
    ["corsOrigins", ["*"], /--cors-origin/],
    ["mcpPath", null, /mcpPath must be a string/],
    ["healthPath", false, /healthPath must be a string/]
  ])("rejects non-exact %s admission", (name, value, message) => {
    expect(() => normalizeHttpServeOptions(withOption(name as string, value))).toThrow(message as RegExp);
  });

  it.each([
    ["port", -1],
    ["port", 65_536],
    ["port", "3000"],
    ["port", Number.NaN],
    ["rateLimitPerMinute", -1],
    ["rateLimitPerMinute", Number.POSITIVE_INFINITY],
    ["rateLimitPerMinute", Number.MAX_SAFE_INTEGER + 1],
    ["sessionIdleTimeoutMs", 0],
    ["sessionIdleTimeoutMs", 1.5],
    ["maxSessions", 0],
    ["maxSessions", Number.NEGATIVE_INFINITY]
  ])("rejects unsafe or out-of-range integer %s=%s", (name, value) => {
    expect(() => normalizeHttpServeOptions(withOption(name as string, value))).toThrow(/must be a safe integer/);
  });

  it.each([
    ["mcp"],
    ["https://example.com/mcp"],
    ["//example.com/mcp"],
    ["/api/../mcp"],
    ["/mcp?mode=write"],
    ["/mcp#fragment"],
    ["/mcp\\child"],
    [" /mcp"],
    ["/mcp%"]
  ])("rejects non-canonical MCP route %j", (mcpPath) => {
    expect(() => normalizeHttpServeOptions({ ...BASE_OPTIONS, mcpPath })).toThrow(/canonical absolute pathname/);
  });

  it("rejects MCP and unauthenticated health route aliasing after defaults", () => {
    expect(() => normalizeHttpServeOptions({ ...BASE_OPTIONS, mcpPath: "/health" })).toThrow(/must be distinct/);
    expect(() => normalizeHttpServeOptions({ ...BASE_OPTIONS, healthPath: "/mcp" })).toThrow(/must be distinct/);
  });

  it("createHttpHandler validates before touching dependencies, with a valid-handler negative control", async () => {
    const untouchedDeps = new Proxy({} as Parameters<typeof createHttpHandler>[0], {
      get() {
        throw new Error("dependencies were touched before HTTP admission");
      }
    });
    expect(() =>
      createHttpHandler(untouchedDeps, {
        ...BASE_OPTIONS,
        stateful: "false"
      } as unknown as HttpServeOptions)
    ).toThrow(/stateful must be a boolean/);
    expect(() =>
      createHttpHandler(untouchedDeps, {
        ...BASE_OPTIONS,
        maxFileBytes: String(12 * 1024 * 1024)
      })
    ).toThrow(/request ceiling/);

    const out: NonNullable<Parameters<typeof createHttpHandler>[2]> = { registry: null };
    const handler = createHttpHandler({} as Parameters<typeof createHttpHandler>[0], BASE_OPTIONS, out, {
      modernDrainMs: 0,
      modernCloseMs: 0,
      modernHandlerClose: async () => {}
    });
    expect(handler).toBeTypeOf("function");
    await out.modern?.close();
  });

  it("startHttpServer rejects route aliasing before vault preparation or listener creation", async () => {
    await expect(
      startHttpServer({
        ...BASE_OPTIONS,
        mcpPath: "/same",
        healthPath: "/same",
        installSignalHandlers: false
      })
    ).rejects.toThrow(/must be distinct/);
  });

  it("rejects an impossible HTTP file/body budget before vault preparation or listener creation", async () => {
    await expect(
      startHttpServer({
        ...BASE_OPTIONS,
        maxFileBytes: String(12 * 1024 * 1024),
        installSignalHandlers: false
      })
    ).rejects.toThrow(/request ceiling/);
  });
});

describe("HTTP JSON body admission", () => {
  it("derives a worst-case-safe cap without allocating a correspondingly large body", () => {
    const decodedControlText = "\0".repeat(16);
    expect(Buffer.byteLength(JSON.stringify(decodedControlText), "utf8")).toBe(
      Buffer.byteLength(decodedControlText, "utf8") * 6 + 2
    );

    const decodedBytes = 1024 * 1024;
    expect(deriveHttpBodyCap(String(decodedBytes))).toBe(decodedBytes * 6 + 64 * 1024);
    expect(Math.floor(decodedBytes * 1.5)).toBeLessThan(decodedBytes * 6 + 2);
  });

  it("rejects an oversized Content-Length before consuming the request stream", async () => {
    let iterated = false;
    const request = requestWithBody([Buffer.from("{}")], { "content-length": "0009" }, () => {
      iterated = true;
    });

    await expect(readJsonBody(request, 8)).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(iterated).toBe(false);
  });

  it("parses an exact-boundary body and catches an under-declared streamed overflow", async () => {
    const admitted = Buffer.from('{"ok":1}');
    await expect(
      readJsonBody(requestWithBody([admitted], { "content-length": String(admitted.length) }), admitted.length)
    ).resolves.toEqual({ ok: 1 });

    const oversized = Buffer.from('{"ok":"still-valid-json"}');
    await expect(
      readJsonBody(
        requestWithBody([oversized.subarray(0, 5), oversized.subarray(5)], { "content-length": "2" }),
        oversized.length - 1
      )
    ).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it("maps a well-formed streamed overflow to a generic 413 response", async () => {
    const out: NonNullable<Parameters<typeof createHttpHandler>[2]> = { registry: null };
    const handler = createHttpHandler({} as Parameters<typeof createHttpHandler>[0], BASE_OPTIONS, out, {
      maxBodyBytes: 32,
      modernDrainMs: 0,
      modernCloseMs: 0,
      modernHandlerClose: async () => {}
    });
    const { response, body } = responseCapture();
    try {
      const validJson = Buffer.from(JSON.stringify({ value: "x".repeat(40) }));
      await handler(requestWithBody([validJson.subarray(0, 16), validJson.subarray(16)]), response);

      expect(response.statusCode).toBe(413);
      expect(JSON.parse(body())).toEqual({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Request body too large" },
        id: null
      });
      expect(body()).not.toContain("admitted byte budget");
    } finally {
      await out.modern?.close();
    }
  });
});
