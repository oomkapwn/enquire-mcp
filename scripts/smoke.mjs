#!/usr/bin/env node
// Smoke test: spawn the built MCP server, run the JSON-RPC handshake,
// then call a few tools. Prints PASS/FAIL summary and exits non-zero on failure.
import { spawn } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { TOOL_MANIFEST } from "../dist/tool-manifest.js";

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

// v2.0.0-beta.3: enable --diagnostic-search-tools so smoke exercises the
// full historical surface (5 search tools, including the 4 single-ranker
// diagnostics gated behind the new flag in v2.0.0-beta.3+).
const serveArgs = [bin, "serve", "--vault", vault, "--diagnostic-search-tools"];
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
  // v3.10.0-rc.3: the expected read-tool set is DERIVED from TOOL_MANIFEST, not
  // hardcoded — so adding a tool can no longer silently break smoke (the rc.2
  // gate-gap). smoke launches serve with `--diagnostic-search-tools` (+
  // `--persistent-index` when `--with-fts`) and NOT `--enable-write`, so the
  // registered surface is exactly: gating "always" + "--diagnostic-search-tools"
  // (+ the single fts tool when withFts). This mirrors the registry's gating.
  const expected = TOOL_MANIFEST.filter(
    (t) =>
      t.gating === "always" ||
      t.gating === "--diagnostic-search-tools" ||
      (withFts && t.gating.includes("--persistent-index"))
  )
    .map((t) => t.name)
    .sort();
  check(
    `tools/list returns ${expected.length} read tools (derived from TOOL_MANIFEST)`,
    names.length === expected.length,
    `expected ${expected.length}, got ${names.length}: ${JSON.stringify(names)}`
  );
  check(
    "tool names match TOOL_MANIFEST-derived set",
    JSON.stringify(names) === JSON.stringify(expected),
    JSON.stringify(names)
  );
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
  // v3.1.0: 19 prompts (17 from v2.5.0 + vault_research + vault_synthesis_page).
  // 10 v1.x base + search_with_query_expansion + vault_synth + vault_wiki_compile
  // + vault_lint_extended + vault_capture + vault_persona_search + vault_automation_setup
  // + vault_research (v3.1.0 sub-question decomposition)
  // + vault_synthesis_page (v3.1.0 Karpathy synthesis loop).
  check("prompts/list returns 19 prompts", promptNames.length === 19, JSON.stringify(promptNames));
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

  // v1.7 — canvas tools. The CI synthetic vault has Boards/Apollo Board.canvas;
  // a developer's real vault may have zero canvases. Both paths are smoke-OK
  // — we just verify the tool returns an array, and exercise read_canvas only
  // when at least one canvas exists.
  const canvases = await rpc("tools/call", { name: "obsidian_list_canvases", arguments: {} });
  const canvasesParsed = JSON.parse(canvases.result.content[0].text);
  check(
    "list_canvases returns an array (zero or more .canvas files)",
    Array.isArray(canvasesParsed) && (canvasesParsed.length === 0 || canvasesParsed[0].path?.endsWith(".canvas")),
    canvases.result.content[0].text.slice(0, 200)
  );
  console.log(`      → list_canvases: ${canvasesParsed.length} .canvas file(s)`);
  if (canvasesParsed[0]?.path) {
    const canvas = await rpc("tools/call", {
      name: "obsidian_read_canvas",
      arguments: { path: canvasesParsed[0].path }
    });
    const canvasParsed = JSON.parse(canvas.result.content[0].text);
    check(
      "read_canvas returns typed nodes + edges + summary",
      typeof canvasParsed === "object" &&
        Array.isArray(canvasParsed.nodes) &&
        Array.isArray(canvasParsed.edges) &&
        typeof canvasParsed.summary === "object",
      canvas.result.content[0].text.slice(0, 200)
    );
    console.log(
      `      → canvas "${canvasParsed.name}": ${canvasParsed.nodes.length} nodes (${Object.entries(canvasParsed.summary)
        .filter(([, v]) => v > 0)
        .map(([k, v]) => `${v} ${k}`)
        .join(", ")}), ${canvasParsed.edges.length} edges`
    );
  }

  // v1.8 — semantic search.
  const sem = await rpc("tools/call", {
    name: "obsidian_semantic_search",
    arguments: { query: "Apollo project", limit: 3 }
  });
  const semParsed = JSON.parse(sem.result.content[0].text);
  check(
    "semantic_search returns tfidf-cosine matches",
    typeof semParsed === "object" && semParsed.method === "tfidf-cosine" && Array.isArray(semParsed.matches),
    sem.result.content[0].text.slice(0, 200)
  );
  console.log(
    `      → semantic_search "${semParsed.query}": ${semParsed.matches.length}/${semParsed.total_docs} hit(s)`
  );

  // v2.0 beta — hybrid RRF tool. Without --persistent-index or build-embeddings,
  // it should still degrade to TF-IDF-only and return matches.
  const hybrid = await rpc("tools/call", {
    name: "obsidian_search",
    arguments: { query: "Apollo project", limit: 3 }
  });
  const hybridText = hybrid.result?.content?.[0]?.text ?? "";
  const hybridParsed = JSON.parse(hybridText);
  check(
    "obsidian_search (hybrid RRF) returns matches with method='rrf'",
    typeof hybridParsed === "object" &&
      hybridParsed.method === "rrf" &&
      Array.isArray(hybridParsed.signals_used) &&
      Array.isArray(hybridParsed.matches),
    hybridText.slice(0, 200)
  );
  console.log(
    `      → obsidian_search "${hybridParsed.query}": ${hybridParsed.matches.length} hit(s) via [${hybridParsed.signals_used.join(",")}]`
  );

  // v1.10 — periodic-alias resolver via read_note(title:"2026-05-02").
  // Synthetic vault seeds .obsidian/daily-notes.json + 99_Daily/2026-05-02.md
  // so this exercises the plugin-aware codepath (loadPeriodicConfig +
  // formatMoment) — without this probe, regressions in the lazy-load codepath
  // wouldn't fail CI. We only check that the resolver returns a path ending
  // in 2026-05-02.md (any folder); the synthetic vault always produces
  // 99_Daily/2026-05-02.md, but real vaults may have a different layout.
  const aliasReq = await rpc("tools/call", {
    name: "obsidian_read_note",
    arguments: { title: "2026-05-02", format: "map" }
  });
  const aliasText = aliasReq.result?.content?.[0]?.text ?? "";
  const aliasParsed = JSON.parse(aliasText);
  check(
    "read_note resolves a daily-notes basename (plugin-config folder honored)",
    typeof aliasParsed === "object" &&
      typeof aliasParsed.path === "string" &&
      aliasParsed.path.endsWith("2026-05-02.md"),
    aliasText.slice(0, 200)
  );
  console.log(`      → read_note title:2026-05-02 → "${aliasParsed.path}"`);

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

// v2.6.0 — HTTP transport smoke. Spawns `enquire-mcp serve-http` on a
// kernel-assigned port, hits /health (no auth), then exercises 401 on
// missing-bearer + a successful authenticated initialize. Skipped on
// --skip-http for stdio-only smoke runs (e.g. corporate networks where
// binding even 127.0.0.1 is blocked).
if (!args.includes("--skip-http")) {
  console.log("\n=== smoke variant: serve-http (Streamable HTTP transport) ===");
  const httpFailures = await smokeHttp(vault, bin);
  for (const f of httpFailures) failures.push(f);
}

if (failures.length) {
  console.log(`\n${failures.length} failure(s)`);
  process.exit(1);
} else {
  console.log("\nAll smoke checks passed.");
}

async function smokeHttp(vaultPath, binPath) {
  const localFailures = [];
  function httpCheck(label, ok, detail) {
    if (ok) console.log(`PASS  ${label}`);
    else {
      console.log(`FAIL  ${label} — ${detail}`);
      localFailures.push(label);
    }
  }
  // Generate a strong test token via the gen-token subcommand (smoke for
  // the helper too) instead of hardcoding.
  const genProc = spawn("node", [binPath, "gen-token"], { stdio: ["ignore", "pipe", "pipe"] });
  let tokenOut = "";
  for await (const chunk of genProc.stdout) tokenOut += chunk.toString();
  await new Promise((resolve) => genProc.once("exit", resolve));
  const TOKEN = tokenOut.trim();
  httpCheck(
    "gen-token produces a 43-char base64url string",
    /^[A-Za-z0-9_-]{43}$/.test(TOKEN),
    `got ${TOKEN.length} chars`
  );

  // Bind to ephemeral port via --port 0; capture the assigned port from
  // the ready banner.
  const httpProc = spawn(
    "node",
    [binPath, "serve-http", "--vault", vaultPath, "--port", "0", "--bearer-token", TOKEN, "--rate-limit", "0"],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  let httpStderr = "";
  let port = 0;
  const portKnown = new Promise((resolve) => {
    httpProc.stderr.on("data", (d) => {
      const text = d.toString();
      httpStderr += text;
      const m = /bound=http:\/\/[^:]+:(\d+)/.exec(text);
      if (m && !port) {
        port = Number.parseInt(m[1], 10);
        resolve();
      }
    });
  });
  // Bound the wait so we don't hang the smoke if startup fails.
  await Promise.race([
    portKnown,
    new Promise((_, rej) => setTimeout(() => rej(new Error("serve-http startup timeout")), 8000))
  ]).catch((err) => {
    localFailures.push(err.message);
    console.log(`FAIL  serve-http startup — ${err.message}\n${httpStderr}`);
  });
  if (port) {
    try {
      // /health (unauthenticated) — should be 200.
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      httpCheck(
        "/health returns 200 ok",
        health.status === 200 && (await health.text()) === "ok",
        `status=${health.status}`
      );

      // Missing token → 401.
      const noauth = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}"
      });
      // CodeQL guard: don't echo response bodies/headers from auth-related
      // requests into log output. The detail messages here describe what
      // we expected, not what we got, so a smoke fail doesn't leak any
      // server-controlled data into CI logs.
      const noauthOk = noauth.status === 401;
      httpCheck("missing-bearer returns 401", noauthOk, "expected HTTP 401 on POST /mcp without Authorization header");
      const wwwAuth = noauth.headers.get("WWW-Authenticate") ?? "";
      httpCheck(
        "401 response carries WWW-Authenticate header",
        wwwAuth.includes("Bearer"),
        "expected WWW-Authenticate header to start with 'Bearer'"
      );

      // Auth'd initialize → 200.
      const init = await fetch(`http://127.0.0.1:${port}/mcp`, {
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
            clientInfo: { name: "smoke-http", version: "0.0.1" }
          }
        })
      });
      httpCheck(
        "authenticated initialize returns 200",
        init.status === 200,
        "expected HTTP 200 on authenticated initialize"
      );
      const initText = await init.text();
      httpCheck(
        "initialize response mentions enquire",
        initText.includes("enquire"),
        "expected response body to contain server name 'enquire'"
      );
    } catch (err) {
      console.log(`FAIL  http smoke — ${err.message}`);
      localFailures.push(err.message);
    }
  }
  // The process may have already exited (e.g. startup error). Guard the
  // exit listener so we don't hang if the exit event already fired.
  if (httpProc.exitCode === null && httpProc.signalCode === null) {
    httpProc.kill("SIGTERM");
    await new Promise((resolve) => {
      const t = setTimeout(resolve, 2000); // hard cap — never block smoke
      httpProc.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
  return localFailures;
}
