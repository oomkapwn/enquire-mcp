// v3.11.6-rc.20 (external audit H-2) — stateful `DELETE /mcp` must NOT abort an
// in-flight tool call on the same session.
//
// Pre-rc.20 the DELETE handler routed the termination into the shared SDK
// transport (`handleRequest`, which tears the transport down) BEFORE waiting for
// pre-existing in-flight requests to drain. A DELETE racing an active call
// therefore aborted that call's response channel: a read returned an empty HTTP
// 200, and a multi-file write was interrupted mid-execution — a PARTIAL mutation
// (the auditor measured ~321/1500 files changed) with no response boundary the
// client could reconcile. The fix drains pre-existing in-flight requests first,
// so the running call completes (delivering its full response / finishing its
// mutation) before the session terminates.
//
// These are BEHAVIORAL regression tests (real loopback HTTP, real tool calls) —
// the transport-abort ordering is invisible to the refcount/DELETE unit tests
// that were green while this shipped. Mutation-verified: reverting the drain
// reorder makes the read-race body empty and the write-race partial.

import { promises as fs } from "node:fs";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHttpServer } from "../src/http-transport.js";

const TOKEN = "delete-race-token-1234567890abcdef";
const N_NOTES = 500;
let root: string;
let server: import("node:http").Server;
let url: string;

/** Extract the JSON-RPC payload text from an MCP HTTP response, tolerating both
 *  `application/json` and SSE (`event: message\ndata: {…}`) framing. */
function extractPayload(bodyText: string): string {
  const idx = bodyText.indexOf("data:");
  if (idx >= 0) return bodyText.slice(idx + 5).trim();
  return bodyText.trim();
}

async function post(body: unknown, sessionId?: string): Promise<Response> {
  return fetch(`${url}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${TOKEN}`,
      ...(sessionId ? { "Mcp-Session-Id": sessionId } : {})
    },
    body: JSON.stringify(body)
  });
}

/** initialize a fresh stateful session → return its Mcp-Session-Id. */
async function initSession(): Promise<string> {
  const res = await post({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "delete-race", version: "1" } }
  });
  const sid = res.headers.get("Mcp-Session-Id");
  await res.text();
  if (!sid) throw new Error("no Mcp-Session-Id from initialize");
  await post({ jsonrpc: "2.0", method: "notifications/initialized" }, sid);
  return sid;
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-delrace-"));
  await Promise.all(
    Array.from({ length: N_NOTES }, (_, i) =>
      fs.writeFile(
        path.join(root, `n${i}.md`),
        `# Note ${i}\n\nalpha beta gamma delta kubernetes ingress topic note ${i} body content. REPLACEME token here.\n`
      )
    )
  );
  server = await startHttpServer({
    vault: root,
    port: 0,
    host: "127.0.0.1",
    bearerToken: TOKEN,
    mcpPath: "/mcp",
    healthPath: "/health",
    rateLimitPerMinute: 0,
    corsOrigins: [],
    installSignalHandlers: false,
    stateful: true,
    enableWrite: true
  });
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60000);

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (root) await fs.rm(root, { recursive: true, force: true }).catch(() => {});
});

describe("DELETE /mcp must not abort an in-flight call (audit H-2, rc.20)", () => {
  const searchArgs = {
    name: "obsidian_search",
    arguments: {
      query: "alpha kubernetes",
      queries: [
        "beta ingress",
        "gamma topic",
        "delta note",
        "alpha beta",
        "kubernetes ingress",
        "gamma delta",
        "topic content",
        "alpha delta"
      ],
      limit: 10
    }
  };

  it("a READ (obsidian_search) racing DELETE still returns a COMPLETE JSON-RPC result", async () => {
    const sid = await initSession();
    // Fire the search WITHOUT awaiting, then DELETE 10 ms later (the auditor's race).
    const searchP = post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: searchArgs }, sid);
    await new Promise((r) => setTimeout(r, 10));
    const delP = fetch(`${url}/mcp`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${TOKEN}`, "Mcp-Session-Id": sid }
    });
    const [searchRes, delRes] = await Promise.all([searchP, delP]);
    const bodyText = await searchRes.text();
    await delRes.text();

    // Pre-rc.20: bodyText is EMPTY (transport aborted mid-flight). Post-fix: the
    // full response is delivered.
    expect(searchRes.status).toBe(200);
    expect(bodyText.length, "raced search response must not be empty (H-2)").toBeGreaterThan(0);
    const payload = JSON.parse(extractPayload(bodyText));
    expect(payload.result, "raced search must carry a complete JSON-RPC result").toBeDefined();
    expect(payload.error).toBeUndefined();
  });

  it("a WRITE (obsidian_replace_in_notes) racing DELETE completes fully — no PARTIAL mutation", async () => {
    const sid = await initSession();
    const writeP = post(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "obsidian_replace_in_notes",
          arguments: { search: "REPLACEME", replace: "REPLACED" }
        }
      },
      sid
    );
    await new Promise((r) => setTimeout(r, 10));
    const delP = fetch(`${url}/mcp`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${TOKEN}`, "Mcp-Session-Id": sid }
    });
    const [writeRes, delRes] = await Promise.all([writeP, delP]);
    await writeRes.text();
    await delRes.text();

    // Give any (incorrectly) still-running work a beat, then assert the mutation
    // is ALL-OR-NOTHING: every note was rewritten (0 left with REPLACEME).
    // Pre-rc.20 the write was interrupted mid-loop → a partial subset remained.
    await new Promise((r) => setTimeout(r, 200));
    const files = await fs.readdir(root);
    let stillUnreplaced = 0;
    for (const f of files) {
      if (!f.endsWith(".md")) continue;
      const txt = await fs.readFile(path.join(root, f), "utf8");
      if (txt.includes("REPLACEME")) stillUnreplaced += 1;
    }
    expect(stillUnreplaced, "DELETE must not leave a PARTIAL write (H-2 data-integrity)").toBe(0);
  });
});
