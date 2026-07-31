#!/usr/bin/env node
// GitHub-hosted, end-to-end protocol gate for the exact MCP v2 client.
//
// This deliberately runs outside Vitest: it launches the built package through
// both public transports and proves the wire contract a registry consumer sees.
// It only creates and removes its own synthetic vault under the runner tmpdir.

import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createSyntheticVault } from "./synthetic-vault.mjs";
import { isEntrypoint } from "./lib/entrypoint.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = path.join(ROOT, "dist", "index.js");
const BEARER_TOKEN = "enquire-protocol-conformance-token-2026";
const READ_PATH = "01_Projects/Hermes.md";
const READ_MARKER = "search-target-ABC";

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function textFromToolResult(result) {
  if (!Array.isArray(result?.content)) return "";
  return result.content
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
}

async function expectRefused(label, operation) {
  let result;
  try {
    result = await operation();
  } catch (error) {
    assert.match(
      String(error),
      /escapes vault root|outside vault|privacy|not found|invalid (?:path|params)|path traversal/i,
      `${label} failed through an unexpected transport/server error`
    );
    return;
  }
  assert.equal(result?.isError, true, `${label} unexpectedly succeeded`);
  assert.match(
    textFromToolResult(result),
    /escapes vault root|outside vault|privacy|not found|invalid (?:path|params)|path traversal/i,
    `${label} returned an unrelated tool error`
  );
}

async function exerciseClient(label, client, transport, expectedEra, sessionExpectation = "not-applicable") {
  try {
    await client.connect(transport);
    assert.equal(client.getProtocolEra(), expectedEra, `${label}: wrong negotiated protocol era`);
    if (expectedEra === "modern") {
      assert.equal(
        client.getNegotiatedProtocolVersion(),
        "2026-07-28",
        `${label}: modern connection did not negotiate the pinned GA revision`
      );
      assert.ok(client.getDiscoverResult(), `${label}: modern connection did not retain server/discover evidence`);
    } else {
      assert.equal(
        client.getDiscoverResult(),
        undefined,
        `${label}: legacy connection unexpectedly used server/discover`
      );
    }
    if (sessionExpectation === "present") {
      assert.match(transport.sessionId ?? "", /^[0-9a-f]{32}$/i, `${label}: legacy stateful session id is missing`);
    } else if (sessionExpectation === "absent") {
      assert.equal(
        transport.sessionId,
        undefined,
        `${label}: modern/stateless request entered the legacy session registry`
      );
    }

    const [toolPage, promptPage, resourcePage, templatePage] = await Promise.all([
      client.listTools(),
      client.listPrompts(),
      client.listResources(),
      client.listResourceTemplates()
    ]);
    const inventory = {
      tools: sorted(toolPage.tools.map((tool) => tool.name)),
      prompts: sorted(promptPage.prompts.map((prompt) => prompt.name)),
      resources: sorted(resourcePage.resources.map((resource) => resource.uri)),
      resourceTemplates: sorted(templatePage.resourceTemplates.map((template) => template.uriTemplate))
    };

    assert.equal(inventory.tools.length, 34, `${label}: default read-only tool inventory drifted`);
    assert.equal(inventory.prompts.length, 19, `${label}: prompt inventory drifted`);
    assert.ok(inventory.tools.includes("obsidian_read_note"), `${label}: read tool is missing`);
    assert.ok(inventory.tools.includes("obsidian_search"), `${label}: default search tool is missing`);
    assert.ok(!inventory.tools.includes("obsidian_create_note"), `${label}: write tool leaked into read-only default`);
    assert.ok(
      inventory.resources.includes("obsidian://vault/info"),
      `${label}: fixed vault metadata resource is missing`
    );
    assert.ok(
      inventory.resources.includes("obsidian://note/01_Projects/Hermes.md"),
      `${label}: synthetic note resource is missing`
    );
    assert.ok(
      inventory.resourceTemplates.includes("obsidian://note/{+notePath}"),
      `${label}: note resource template is missing`
    );

    const read = await client.callTool({
      name: "obsidian_read_note",
      arguments: { path: READ_PATH }
    });
    assert.notEqual(read.isError, true, `${label}: real read-only call returned an error`);
    assert.match(
      textFromToolResult(read),
      new RegExp(READ_MARKER),
      `${label}: real read-only call returned wrong content`
    );

    const resource = await client.readResource({ uri: "obsidian://note/01_Projects/Hermes.md" });
    assert.match(
      JSON.stringify(resource.contents),
      new RegExp(READ_MARKER),
      `${label}: resource read returned wrong content`
    );
    const prompt = await client.getPrompt({
      name: "summarize_recent_edits",
      arguments: { since_minutes: "60" }
    });
    assert.match(
      JSON.stringify(prompt.messages),
      /obsidian_get_recent_edits/,
      `${label}: prompt retrieval returned the wrong recipe`
    );

    await expectRefused(`${label}: traversal negative control`, () =>
      client.callTool({ name: "obsidian_read_note", arguments: { path: "../outside.md" } })
    );
    const afterNegative = await client.callTool({
      name: "obsidian_read_note",
      arguments: { path: READ_PATH }
    });
    assert.notEqual(afterNegative.isError, true, `${label}: server was not live after traversal refusal`);
    assert.match(
      textFromToolResult(afterNegative),
      new RegExp(READ_MARKER),
      `${label}: post-negative liveness read returned wrong content`
    );
    return inventory;
  } finally {
    if (typeof transport.terminateSession === "function" && transport.sessionId) {
      await transport.terminateSession().catch(() => {});
    }
    await client.close().catch(() => {});
  }
}

function stdioTransport(vaultRoot) {
  return new StdioClientTransport({
    command: process.execPath,
    args: [ENTRY, "serve", "--vault", vaultRoot],
    cwd: ROOT,
    env: {
      ...process.env,
      HF_HUB_OFFLINE: "1",
      TRANSFORMERS_OFFLINE: "1"
    },
    // This gate does not consume child diagnostics. Ignoring them prevents a
    // spawned server from ever blocking on a full stderr pipe.
    stderr: "ignore"
  });
}

function httpTransport(url, token = BEARER_TOKEN) {
  return new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } }
  });
}

function startHttpProcess(vaultRoot, stateful) {
  const args = [
    ENTRY,
    "serve-http",
    "--vault",
    vaultRoot,
    "--host",
    "127.0.0.1",
    "--port",
    "0",
    "--bearer-token",
    BEARER_TOKEN,
    "--rate-limit",
    "0"
  ];
  if (stateful) args.push("--stateful");
  return spawn(process.execPath, args, {
    cwd: ROOT,
    env: { ...process.env, HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" },
    stdio: ["ignore", "ignore", "pipe"]
  });
}

const MODERN_ENVELOPE = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "enquire-protocol-conformance", version: "1.0.0" },
  "io.modelcontextprotocol/clientCapabilities": {}
};

async function assertRawHttpBoundaries(url) {
  const auth = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: "Bearer wrong-token-that-is-long-enough",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
  });
  assert.equal(auth.status, 401, "HTTP wrong-token negative control did not return exact 401");
  assert.match(auth.headers.get("WWW-Authenticate") ?? "", /^Bearer\b/, "HTTP 401 omitted the bearer challenge");
  await auth.text();

  const mediaType = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${BEARER_TOKEN}`,
      Accept: "application/json, text/event-stream",
      "Content-Type": "text/plain; example=application/json",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": "tools/list"
    },
    body: "{not valid json"
  });
  assert.equal(mediaType.status, 415, "invalid Content-Type did not win before JSON parsing and era routing");
  const mediaTypeBody = await mediaType.json();
  assert.equal(mediaTypeBody?.error?.code, -32000, "415 response carried the wrong JSON-RPC error code");

  const malformedModern = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${BEARER_TOKEN}`,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "Mcp-Session-Id": "bogus-legacy-session",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": "tools/list"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": "malformed-on-purpose"
        }
      }
    })
  });
  assert.equal(malformedModern.status, 400, "malformed modern envelope did not fail at the modern boundary");
  const malformedModernBody = await malformedModern.json();
  assert.equal(malformedModernBody?.error?.code, -32602, "malformed modern envelope returned the wrong error code");
  assert.match(JSON.stringify(malformedModernBody?.error?.data), /_meta/, "modern error omitted the envelope defect");
  assert.doesNotMatch(
    JSON.stringify(malformedModernBody),
    /unknown session/i,
    "malformed modern claim was downgraded into legacy session lookup"
  );

  const unsupportedEnvelope = {
    ...MODERN_ENVELOPE,
    "io.modelcontextprotocol/protocolVersion": "2099-01-01"
  };
  const unsupportedModern = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${BEARER_TOKEN}`,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "Mcp-Session-Id": "bogus-legacy-session",
      "MCP-Protocol-Version": "2099-01-01",
      "Mcp-Method": "server/discover"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "unsupported-modern-version",
      method: "server/discover",
      params: { _meta: unsupportedEnvelope }
    })
  });
  assert.ok(
    unsupportedModern.status === 200 || unsupportedModern.status === 400,
    `unsupported modern revision returned unexpected HTTP ${unsupportedModern.status}`
  );
  assert.equal(
    unsupportedModern.headers.get("Mcp-Session-Id"),
    null,
    "unsupported modern claim allocated a legacy session"
  );
  const unsupportedBody = await unsupportedModern.text();
  assert.doesNotMatch(unsupportedBody, /unknown session/i, "unsupported modern claim entered legacy session lookup");
  assert.match(
    unsupportedBody,
    /2026-07-28|supported|protocol/i,
    "unsupported modern response did not carry modern version evidence"
  );

  const sessionlessDelete = await fetch(url, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${BEARER_TOKEN}` }
  });
  assert.equal(sessionlessDelete.status, 400, "stateful DELETE without a legacy session id did not fail closed");
  assert.match(
    await sessionlessDelete.text(),
    /Mcp-Session-Id/,
    "sessionless DELETE omitted its exact missing-header cause"
  );
}

function waitForHttpReady(child) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const timeout = setTimeout(() => {
      reject(new Error(`HTTP server readiness timed out. stderr:\n${stderr.slice(-4000)}`));
    }, 30_000);
    const settle = (fn, value) => {
      clearTimeout(timeout);
      child.stderr?.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
      // Keep draining diagnostics after readiness. A long conformance run must
      // never deadlock because the child filled an unconsumed stderr pipe.
      if (fn === resolve) child.stderr?.resume();
      fn(value);
    };
    const onData = (chunk) => {
      stderr += chunk.toString();
      const match = /bound=http:\/\/127\.0\.0\.1:(\d+)\/mcp/.exec(stderr);
      if (match?.[1]) settle(resolve, new URL(`http://127.0.0.1:${match[1]}/mcp`));
    };
    const onError = (error) => settle(reject, error);
    const onExit = (code, signal) =>
      settle(
        reject,
        new Error(`HTTP server exited before readiness (code=${code}, signal=${signal}). stderr:\n${stderr}`)
      );
    child.stderr?.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(value);
    };
    const onExit = () => settle(true);
    const timer = setTimeout(() => settle(false), timeoutMs);
    child.once("exit", onExit);
  });
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const exited = await waitForChildExit(child, 10_000);
  if (exited || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGKILL");
  assert.equal(await waitForChildExit(child, 5_000), true, "HTTP child did not exit after hard termination");
}

export async function runProtocolConformance() {
  const vaultRoot = await createSyntheticVault();
  const statelessHttp = startHttpProcess(vaultRoot, false);
  const statefulHttp = startHttpProcess(vaultRoot, true);

  try {
    const statelessUrl = await waitForHttpReady(statelessHttp);
    const statefulUrl = await waitForHttpReady(statefulHttp);
    await assertRawHttpBoundaries(statefulUrl);

    const lanes = [
      {
        label: "stdio/legacy",
        era: "legacy",
        session: "not-applicable",
        transport: () => stdioTransport(vaultRoot)
      },
      {
        label: "stdio/modern",
        era: "modern",
        session: "not-applicable",
        transport: () => stdioTransport(vaultRoot)
      },
      {
        label: "http-stateless/legacy",
        era: "legacy",
        session: "absent",
        transport: () => httpTransport(statelessUrl)
      },
      {
        label: "http-stateless/modern",
        era: "modern",
        session: "absent",
        transport: () => httpTransport(statelessUrl)
      },
      {
        label: "http-stateful/legacy",
        era: "legacy",
        session: "present",
        transport: () => httpTransport(statefulUrl)
      },
      {
        label: "http-stateful/modern",
        era: "modern",
        session: "absent",
        transport: () => httpTransport(statefulUrl)
      }
    ];
    let reference;
    for (const lane of lanes) {
      const mode = lane.era === "modern" ? "auto" : "legacy";
      const client = new Client(
        { name: "enquire-protocol-conformance", version: "1.0.0" },
        { versionNegotiation: { mode, probe: { timeoutMs: 10_000, maxRetries: 0 } } }
      );
      const inventory = await exerciseClient(lane.label, client, lane.transport(), lane.era, lane.session);
      reference ??= inventory;
      assert.deepEqual(inventory, reference, `${lane.label}: inventory differs from the first protocol lane`);
      console.log(`[protocol-conformance] OK — ${lane.label}`);
    }
    console.log(
      "[protocol-conformance] OK — official client v2 served identical modern/legacy stdio/stateless-HTTP/stateful-HTTP inventories"
    );
  } finally {
    await Promise.all([stopChild(statelessHttp), stopChild(statefulHttp)]);
    await rm(vaultRoot, { recursive: true, force: true });
  }
}

if (isEntrypoint(import.meta.url)) {
  runProtocolConformance().catch((error) => {
    console.error(
      `[protocol-conformance] FAIL — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`
    );
    process.exitCode = 1;
  });
}
