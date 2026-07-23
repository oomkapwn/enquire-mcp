// v3.11.6-rc.17 (issues #354 + #360) — MCP tool-schema compatibility invariant.
//
// Two independent users reported that `obsidian_read_pdf` / `obsidian_ocr_pdf`
// broke the ChatGPT / Gemini / Grok connectors ENTIRELY (not just PDF calls —
// all tool schemas are sent to the provider up front). Root cause: the `pages`
// parameter used `z.tuple([A, B])`, which serialises to JSON Schema draft-4
// TUPLE form — `items: [schemaA, schemaB]`, an ARRAY of schemas. Those clients
// reject it ("'items' must be a schema, not an array; for tuple validation use
// 'prefixItems'"). The fix is a homogeneous `z.array(...).length(2)` →
// `items: {schema}` + minItems/maxItems, which every MCP client accepts.
//
// This is the DURABLE class gate: it spawns the real server, reads the exact
// JSON Schema every client sees (`tools/list`), and asserts NO tool property
// (recursively) ships `items` as an array. It catches any future `z.tuple` in
// any registered tool, however introduced — a behavioral MCP-contract invariant,
// not a source grep. (mutation-verified: reverting `pages` to `z.tuple` fails it.)

import { spawn } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_RESEARCH_SUBQUERIES } from "../src/research-protocol.js";

const repoRoot = path.resolve(__dirname, "..");
const distEntry = path.join(repoRoot, "dist", "index.js");
const distExists = (): boolean => existsSync(distEntry);

interface Tool {
  name: string;
  inputSchema?: unknown;
}

let tools: Tool[] = [];
let vaultDir: string | null = null;

/** Spawn `serve --include-pdfs` (so the PDF tools register), handshake, and
 *  return the tools/list array. Minimal self-contained JSON-RPC over stdio. */
async function fetchTools(vaultPath: string): Promise<Tool[]> {
  const proc = spawn(
    "node",
    [distEntry, "serve", "--vault", vaultPath, "--include-pdfs", "--diagnostic-search-tools"],
    { stdio: ["pipe", "pipe", "pipe"] }
  );
  let buf = "";
  const pending = new Map<number, (m: { result?: unknown }) => void>();
  proc.stdout.on("data", (d) => {
    buf += d.toString();
    for (let nl = buf.indexOf("\n"); nl !== -1; nl = buf.indexOf("\n")) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (typeof msg.id === "number" && pending.has(msg.id)) {
          pending.get(msg.id)?.(msg);
          pending.delete(msg.id);
        }
      } catch {
        // banner / non-JSON — ignore
      }
    }
  });
  let nextId = 1;
  const rpc = (method: string, params?: unknown): Promise<{ result?: unknown }> => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, resolve);
      proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`Timeout on ${method}`));
        }
      }, 20000);
    });
  };
  try {
    await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "schema-compat-test", version: "0.0.1" }
    });
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const list = await rpc("tools/list", {});
    return ((list.result as { tools?: Tool[] })?.tools ?? []) as Tool[];
  } finally {
    proc.kill();
  }
}

/** Recursively collect every JSON-Schema node whose `items` is an ARRAY (the
 *  draft-4 tuple form MCP clients reject). Returns `where` paths for diagnosis. */
function findArrayItems(node: unknown, at: string, out: string[]): void {
  if (!node || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  if (Array.isArray(obj.items)) out.push(`${at}.items (array of ${obj.items.length} schemas)`);
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === "object") findArrayItems(v, `${at}.${k}`, out);
  }
}

describe("MCP tool-schema client compatibility (rc.17 #354/#360)", () => {
  beforeAll(async () => {
    if (!distExists()) return;
    vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-schema-compat-"));
    await fs.writeFile(path.join(vaultDir, "a.md"), "# a\nhi\n");
    tools = await fetchTools(vaultDir);
  }, 60000);

  afterAll(async () => {
    if (vaultDir) await fs.rm(vaultDir, { recursive: true, force: true }).catch(() => {});
  });

  // CI-GUARD (rc.23 convention): dist is always built before `npm test` in CI, so
  // this behavioral gate MUST run there — fail loud if the precondition vanishes.
  it("CI GUARD — dist is built in CI so the schema-compat gate actually runs", () => {
    if (!process.env.CI) return;
    expect(distExists(), "dist must be built in CI so tools/list is inspectable").toBe(true);
  });

  it("NO tool ships `items` as an ARRAY (the draft-4 tuple form ChatGPT/Gemini/Grok reject)", (ctx) => {
    if (!distExists()) return ctx.skip();
    expect(tools.length).toBeGreaterThan(30); // sanity: the server registered its tools
    const offenders: string[] = [];
    for (const t of tools) findArrayItems(t.inputSchema, t.name, offenders);
    expect(offenders, `tuple-form array-items schemas (use z.array(...).length(N)):\n${offenders.join("\n")}`).toEqual(
      []
    );
  });

  it("the PDF tools' `pages` is a homogeneous 2-array (items is an object, not an array)", (ctx) => {
    if (!distExists()) return ctx.skip();
    for (const name of ["obsidian_read_pdf", "obsidian_ocr_pdf"]) {
      const tool = tools.find((t) => t.name === name);
      expect(tool, `${name} must be registered`).toBeDefined();
      const pages = (tool?.inputSchema as { properties?: Record<string, { items?: unknown; type?: string }> })
        ?.properties?.pages;
      expect(pages?.type, `${name}.pages type`).toBe("array");
      // The fix: items is a SINGLE schema object, not an array of schemas.
      expect(Array.isArray(pages?.items), `${name}.pages.items must NOT be an array`).toBe(false);
      expect(typeof pages?.items, `${name}.pages.items must be a schema object`).toBe("object");
    }
  });

  it("context_pack exposes the bearer-reachable subquery fan-out cap in its real MCP schema", (ctx) => {
    if (!distExists()) return ctx.skip();
    const tool = tools.find((entry) => entry.name === "obsidian_context_pack");
    expect(tool, "obsidian_context_pack must be registered").toBeDefined();
    const subqueries = (
      tool?.inputSchema as {
        properties?: Record<string, { items?: { maxLength?: number }; maxItems?: number; type?: string }>;
      }
    )?.properties?.subqueries;
    expect(subqueries?.type).toBe("array");
    expect(subqueries?.maxItems).toBe(MAX_RESEARCH_SUBQUERIES);
    expect(subqueries?.items?.maxLength).toBe(4096);
  });
});
