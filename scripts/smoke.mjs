#!/usr/bin/env node
// Smoke test: spawn the built MCP server, run the JSON-RPC handshake,
// then call a few tools. Prints PASS/FAIL summary and exits non-zero on failure.
import { spawn } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const bin = path.join(root, "dist", "index.js");

// Args: first non-flag positional is the vault path; --with-fts flips on
// --persistent-index and exercises the FTS5-only surface (extra tool +
// chunk resource).
const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith("--"));
const vault = positional[0] ?? path.join(os.homedir(), "Documents", "Obsidian Vault");
const withFts = args.includes("--with-fts");

const serveArgs = [bin, "serve", "--vault", vault];
if (withFts) serveArgs.push("--persistent-index");

if (withFts) {
  console.log("=== smoke variant: --persistent-index (FTS5 path) ===");
} else {
  console.log("=== smoke variant: scan (no --persistent-index) ===");
}

const proc = spawn("node", serveArgs, {
  stdio: ["pipe", "pipe", "pipe"]
});

let stderr = "";
proc.stderr.on("data", (d) => {
  stderr += d.toString();
});

let buf = "";
const pending = new Map();
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
  const payload = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
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
  else {
    console.log(`FAIL  ${label} — ${detail}`);
    failures.push(label);
  }
}

try {
  const init = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0.0.1" }
  });
  check("initialize", !!init.result?.serverInfo?.name, JSON.stringify(init).slice(0, 200));
  proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

  const list = await rpc("tools/list", {});
  const names = (list.result?.tools ?? []).map((t) => t.name).sort();
  const expectedCount = withFts ? 22 : 21;
  check(
    `tools/list returns ${expectedCount} read tools`,
    names.length === expectedCount,
    `got ${JSON.stringify(names)}`
  );
  const baseTools = [
    "obsidian_dataview_query",
    "obsidian_find_path",
    "obsidian_find_similar",
    "obsidian_get_backlinks",
    "obsidian_get_note_neighbors",
    "obsidian_get_outbound_links",
    "obsidian_get_recent_edits",
    "obsidian_get_unresolved_wikilinks",
    "obsidian_lint_wiki",
    "obsidian_list_canvases",
    "obsidian_list_notes",
    "obsidian_list_tags",
    "obsidian_open_in_ui",
    "obsidian_open_questions",
    "obsidian_paper_audit",
    "obsidian_read_canvas",
    "obsidian_read_note",
    "obsidian_resolve_wikilink",
    "obsidian_search_text",
    "obsidian_stats",
    "obsidian_validate_note_proposal"
  ];
  const expected = withFts ? [...baseTools, "obsidian_full_text_search"].sort() : baseTools;
  check("tool names match spec", JSON.stringify(names) === JSON.stringify(expected), JSON.stringify(names));
  const allReadOnly = (list.result?.tools ?? []).every((t) => t.annotations?.readOnlyHint === true);
  check("read tools all have readOnlyHint=true", allReadOnly, "missing annotations");

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
  console.log(
    `      → first 3: ${listParsed
      .slice(0, 3)
      .map((n) => n.title)
      .join(", ")}`
  );

  // Pick something likely searchable from the vault. Since v0.9.0 the
  // response is structured: {query, mode, scanned_notes, matches[]}.
  // Use a token that actually appears (synthetic vault has "Apollo").
  const search = await rpc("tools/call", {
    name: "obsidian_search_text",
    arguments: { query: "Apollo", limit: 3 }
  });
  const searchText = search.result?.content?.[0]?.text ?? "";
  const searchParsed = JSON.parse(searchText);
  check(
    "search_text returns structured response",
    typeof searchParsed === "object" &&
      Array.isArray(searchParsed.matches) &&
      typeof searchParsed.scanned_notes === "number",
    searchText.slice(0, 200)
  );
  console.log(
    `      → search hits: ${searchParsed.matches.length} of ${searchParsed.scanned_notes} scanned (mode=${searchParsed.mode})`
  );

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
    if (p.wikilinks?.length) {
      wikilinkSample = { from: note.path, link: p.wikilinks[0] };
      break;
    }
  }
  if (wikilinkSample) {
    const res = await rpc("tools/call", {
      name: "obsidian_resolve_wikilink",
      arguments: { wikilink: wikilinkSample.link.target, from_note: wikilinkSample.from, include_content: false }
    });
    const parsed = JSON.parse(res.result.content[0].text);
    console.log(
      `      → wikilink "[[${wikilinkSample.link.target}]]" from ${wikilinkSample.from}: found=${parsed.found} path=${parsed.path}`
    );
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
  console.log(`      → dql top 3 by mtime: ${dqlParsed.rows.map((r) => r["file.name"]).join(", ")}`);

  // List tags.
  const tags = await rpc("tools/call", {
    name: "obsidian_list_tags",
    arguments: { limit: 5 }
  });
  const tagsParsed = JSON.parse(tags.result.content[0].text);
  check("list_tags returns array", Array.isArray(tagsParsed), tags.result.content[0].text.slice(0, 200));
  console.log(`      → top tags: ${tagsParsed.map((t) => `#${t.tag}(${t.count})`).join(" ")}`);

  // Resources: vault info.
  const resources = await rpc("resources/list", {});
  const staticResources = resources.result?.resources ?? [];
  check(
    "resources/list returns vault info",
    staticResources.some((r) => r.uri === "obsidian://vault/info"),
    JSON.stringify(staticResources).slice(0, 200)
  );

  const vaultInfo = await rpc("resources/read", { uri: "obsidian://vault/info" });
  const vaultInfoText = vaultInfo.result?.contents?.[0]?.text ?? "";
  const vaultInfoParsed = JSON.parse(vaultInfoText);
  check("vault/info has note_count", typeof vaultInfoParsed.note_count === "number", vaultInfoText.slice(0, 200));
  console.log(
    `      → vault/info: ${vaultInfoParsed.note_count} notes, write_enabled=${vaultInfoParsed.write_enabled}`
  );

  // Resources: list note templates and read one back.
  const tmpl = await rpc("resources/templates/list", {});
  const templates = tmpl.result?.resourceTemplates ?? [];
  check(
    "resource template registered",
    templates.some((t) => String(t.uriTemplate ?? t.uri ?? "").startsWith("obsidian://note/")),
    JSON.stringify(templates).slice(0, 200)
  );

  // Prompts.
  const prompts = await rpc("prompts/list", {});
  const promptNames = (prompts.result?.prompts ?? []).map((p) => p.name).sort();
  check("prompts/list returns 10 prompts", promptNames.length === 10, JSON.stringify(promptNames));
  console.log(`      → prompts: ${promptNames.join(", ")}`);

  // Sanity-check the new D / E tools.
  if (listParsed[0]) {
    const outbound = await rpc("tools/call", {
      name: "obsidian_get_outbound_links",
      arguments: { path: listParsed[0].path, include_unresolved: true }
    });
    const outboundParsed = JSON.parse(outbound.result.content[0].text);
    check(
      "get_outbound_links returns links array",
      Array.isArray(outboundParsed.links),
      outbound.result.content[0].text.slice(0, 200)
    );
    console.log(`      → outbound from "${listParsed[0].title}": ${outboundParsed.links.length} link(s)`);
  }
  const unresolved = await rpc("tools/call", {
    name: "obsidian_get_unresolved_wikilinks",
    arguments: { limit: 5 }
  });
  const unresolvedParsed = JSON.parse(unresolved.result.content[0].text);
  check(
    "get_unresolved_wikilinks returns array",
    Array.isArray(unresolvedParsed),
    unresolved.result.content[0].text.slice(0, 200)
  );
  console.log(`      → unresolved wikilinks (vault-wide): ${unresolvedParsed.length}`);

  // v0.13.0 — graph-aware context tools.
  const stats = await rpc("tools/call", { name: "obsidian_stats", arguments: {} });
  const statsParsed = JSON.parse(stats.result.content[0].text);
  check(
    "stats returns vault dashboard with total_notes",
    typeof statsParsed === "object" &&
      typeof statsParsed.total_notes === "number" &&
      Array.isArray(statsParsed.top_tags) &&
      typeof statsParsed.broken_wikilinks === "number",
    stats.result.content[0].text.slice(0, 200)
  );
  console.log(
    `      → stats: ${statsParsed.total_notes} notes · ${statsParsed.total_tags} tags · ${statsParsed.broken_wikilinks} broken links`
  );

  if (listParsed[0]) {
    const similar = await rpc("tools/call", {
      name: "obsidian_find_similar",
      arguments: { path: listParsed[0].path, limit: 5 }
    });
    const similarParsed = JSON.parse(similar.result.content[0].text);
    check(
      "find_similar returns ranked list with signals",
      Array.isArray(similarParsed) && (similarParsed.length === 0 || typeof similarParsed[0].signals === "object"),
      similar.result.content[0].text.slice(0, 200)
    );
    console.log(`      → find_similar from "${listParsed[0].title}": ${similarParsed.length} hit(s)`);

    const neighbors = await rpc("tools/call", {
      name: "obsidian_get_note_neighbors",
      arguments: { path: listParsed[0].path }
    });
    const neighborsParsed = JSON.parse(neighbors.result.content[0].text);
    check(
      "get_note_neighbors returns center + outbound + inbound + tag_siblings",
      typeof neighborsParsed === "object" &&
        typeof neighborsParsed.center === "object" &&
        Array.isArray(neighborsParsed.outbound) &&
        Array.isArray(neighborsParsed.inbound) &&
        Array.isArray(neighborsParsed.tag_siblings),
      neighbors.result.content[0].text.slice(0, 200)
    );
    console.log(
      `      → neighbors of "${neighborsParsed.center.title}": ${neighborsParsed.outbound.length} out, ${neighborsParsed.inbound.length} in, ${neighborsParsed.tag_siblings.length} tag-sibling(s)`
    );
  }

  // FTS5-only surface: full_text_search tool + chunk resource template.
  if (withFts) {
    const fts = await rpc("tools/call", {
      name: "obsidian_full_text_search",
      arguments: { query: "Apollo", limit: 3 }
    });
    const ftsText = fts.result?.content?.[0]?.text ?? "";
    const ftsParsed = JSON.parse(ftsText);
    check(
      "full_text_search returns structured BM25 response",
      typeof ftsParsed === "object" &&
        Array.isArray(ftsParsed.matches) &&
        typeof ftsParsed.total_chunks === "number" &&
        typeof ftsParsed.applied_filters === "object",
      ftsText.slice(0, 200)
    );
    console.log(
      `      → fts5 hits: ${ftsParsed.matches.length} of ${ftsParsed.total_chunks} chunks across ${ftsParsed.total_files} files`
    );

    // Chunk resource — construct URI from a hit and read it back.
    if (ftsParsed.matches.length > 0) {
      const m = ftsParsed.matches[0];
      const chunkUri = `obsidian://chunk/${m.chunk_index}/${m.rel_path}`;
      const chunk = await rpc("resources/read", { uri: chunkUri });
      const chunkText = chunk.result?.contents?.[0]?.text ?? "";
      const chunkParsed = JSON.parse(chunkText);
      check(
        "obsidian://chunk URI returns raw chunk content (no [wikilink_targets] enrichment leak)",
        typeof chunkParsed.content === "string" && !chunkParsed.content.includes("[wikilink_targets:"),
        chunkText.slice(0, 200)
      );
      console.log(
        `      → chunk ${m.chunk_index}/${m.rel_path}: ${chunkParsed.content.length} chars (line ${chunkParsed.line_start}–${chunkParsed.line_end})`
      );
    }

    // FTS5 chunks template should be registered when --persistent-index is on.
    const tmpl2 = await rpc("resources/templates/list", {});
    const templates2 = tmpl2.result?.resourceTemplates ?? [];
    check(
      "fts5 chunk resource template registered",
      templates2.some((t) => String(t.uriTemplate ?? t.uri ?? "").startsWith("obsidian://chunk/")),
      JSON.stringify(templates2).slice(0, 200)
    );
  }
} catch (err) {
  console.error("Smoke test threw:", err);
  failures.push(err.message);
} finally {
  proc.stdin.end();
  proc.kill();
}

if (stderr) console.error(`--- server stderr ---\n${stderr}`);

if (failures.length) {
  console.log(`\n${failures.length} failure(s)`);
  process.exit(1);
} else {
  console.log("\nAll smoke checks passed.");
}
