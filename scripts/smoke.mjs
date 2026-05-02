#!/usr/bin/env node
// Smoke test: spawn the built MCP server, run the JSON-RPC handshake,
// then call a few tools. Prints PASS/FAIL summary and exits non-zero on failure.
import { spawn } from "node:child_process";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const bin = path.join(root, "dist", "index.js");
const vault = process.argv[2] ?? path.join(os.homedir(), "Documents", "Obsidian Vault");

const proc = spawn("node", [bin, "serve", "--vault", vault], {
  stdio: ["pipe", "pipe", "pipe"]
});

let stderr = "";
proc.stderr.on("data", (d) => { stderr += d.toString(); });

let buf = "";
const pending = new Map();
proc.stdout.on("data", (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve } = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg);
      }
    } catch (e) {
      console.error("Failed to parse server line:", line, e.message);
    }
  }
});

let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    proc.stdin.write(payload);
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`Timeout on ${method}`));
      }
    }, 15000);
  });
}

const failures = [];
function check(label, ok, detail) {
  if (ok) console.log(`PASS  ${label}`);
  else { console.log(`FAIL  ${label} — ${detail}`); failures.push(label); }
}

try {
  const init = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0.0.1" }
  });
  check("initialize", !!init.result?.serverInfo?.name, JSON.stringify(init).slice(0, 200));
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const list = await rpc("tools/list", {});
  const names = (list.result?.tools ?? []).map(t => t.name).sort();
  check("tools/list returns 7 tools", names.length === 7, `got ${JSON.stringify(names)}`);
  const expected = [
    "obsidian_dataview_query",
    "obsidian_get_backlinks",
    "obsidian_get_recent_edits",
    "obsidian_list_notes",
    "obsidian_read_note",
    "obsidian_resolve_wikilink",
    "obsidian_search_text"
  ];
  check("tool names match spec", JSON.stringify(names) === JSON.stringify(expected), JSON.stringify(names));

  const recent = await rpc("tools/call", {
    name: "obsidian_get_recent_edits",
    arguments: { limit: 3 }
  });
  const recentText = recent.result?.content?.[0]?.text ?? "";
  const recentParsed = JSON.parse(recentText);
  check("get_recent_edits returns array", Array.isArray(recentParsed), recentText.slice(0, 200));
  check("get_recent_edits has at least 1 note", recentParsed.length > 0, `len=${recentParsed.length}`);
  console.log(`      → newest: "${recentParsed[0]?.title}" (${recentParsed[0]?.path})`);

  const listNotes = await rpc("tools/call", {
    name: "obsidian_list_notes",
    arguments: { limit: 5 }
  });
  const listText = listNotes.result?.content?.[0]?.text ?? "";
  const listParsed = JSON.parse(listText);
  check("list_notes returns array", Array.isArray(listParsed), listText.slice(0, 200));
  console.log(`      → first 3: ${listParsed.slice(0, 3).map(n => n.title).join(", ")}`);

  // Pick something likely searchable from the vault.
  const search = await rpc("tools/call", {
    name: "obsidian_search_text",
    arguments: { query: "obsidian", limit: 3 }
  });
  const searchText = search.result?.content?.[0]?.text ?? "";
  const searchParsed = JSON.parse(searchText);
  check("search_text returns array", Array.isArray(searchParsed), searchText.slice(0, 200));
  console.log(`      → search hits: ${searchParsed.length}`);

  // Read the first listed note round-trip.
  if (listParsed[0]) {
    const read = await rpc("tools/call", {
      name: "obsidian_read_note",
      arguments: { path: listParsed[0].path }
    });
    const readText = read.result?.content?.[0]?.text ?? "";
    const readParsed = JSON.parse(readText);
    check("read_note round-trip", readParsed.title === listParsed[0].title, `title=${readParsed.title}`);
  }

  // Try resolving the first wikilink we see in any note.
  let wikilinkSample = null;
  for (const note of listParsed) {
    const r = await rpc("tools/call", {
      name: "obsidian_read_note",
      arguments: { path: note.path }
    });
    const p = JSON.parse(r.result.content[0].text);
    if (p.wikilinks?.length) { wikilinkSample = { from: note.path, link: p.wikilinks[0] }; break; }
  }
  if (wikilinkSample) {
    const res = await rpc("tools/call", {
      name: "obsidian_resolve_wikilink",
      arguments: { wikilink: wikilinkSample.link.target, from_note: wikilinkSample.from, include_content: false }
    });
    const parsed = JSON.parse(res.result.content[0].text);
    console.log(`      → wikilink "[[${wikilinkSample.link.target}]]" from ${wikilinkSample.from}: found=${parsed.found} path=${parsed.path}`);
    check("resolve_wikilink returns shape", typeof parsed.found === "boolean", JSON.stringify(parsed).slice(0, 200));
  } else {
    console.log("      (no wikilinks found in first batch — skipping resolve test)");
  }

  // Pick a target with at least one inbound link from our list_notes scan and try backlinks.
  if (listParsed[0]) {
    const back = await rpc("tools/call", {
      name: "obsidian_get_backlinks",
      arguments: { path: listParsed[0].path, limit: 5 }
    });
    const backParsed = JSON.parse(back.result.content[0].text);
    check("get_backlinks returns array", Array.isArray(backParsed), back.result.content[0].text.slice(0, 200));
    console.log(`      → backlinks to "${listParsed[0].title}": ${backParsed.length} hits`);
  }

  // Run a tiny dataview query.
  const dql = await rpc("tools/call", {
    name: "obsidian_dataview_query",
    arguments: { query: "LIST SORT file.mtime DESC LIMIT 3" }
  });
  const dqlParsed = JSON.parse(dql.result.content[0].text);
  check("dataview_query returns rows", Array.isArray(dqlParsed.rows), dql.result.content[0].text.slice(0, 200));
  console.log(`      → dql top 3 by mtime: ${dqlParsed.rows.map(r => r["file.name"]).join(", ")}`);
} catch (err) {
  console.error("Smoke test threw:", err);
  failures.push(err.message);
} finally {
  proc.stdin.end();
  proc.kill();
}

if (stderr) console.error("--- server stderr ---\n" + stderr);

if (failures.length) {
  console.log(`\n${failures.length} failure(s)`);
  process.exit(1);
} else {
  console.log("\nAll smoke checks passed.");
}
