#!/usr/bin/env node
// Cross-platform consumer gate for the timestamped MCPB artifact produced by
// scripts/build-mcpb.mjs. It validates logical content hashes, extracts only
// safe regular files into a runner tempdir, and drives the official MCP client
// through the bundle's exact manifest configuration.

import { strict as assert } from "node:assert";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { unzipSync } from "fflate";
import { isEntrypoint } from "./lib/entrypoint.mjs";
import { nativeBinaryReason, portableArchiveKey, portableArchivePath } from "./lib/mcpb-safety.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALL_ROOT_PLACEHOLDER = `\${__dirname}`;
const VAULT_ROOT_PLACEHOLDER = `\${user_config.vault}`;
export const SCRATCH_MARKER = ".enquire-mcpb-consumer-owned-v1";
export const BASIC_TOOLS = [
  "obsidian_frontmatter_get",
  "obsidian_frontmatter_search",
  "obsidian_get_backlinks",
  "obsidian_get_outbound_links",
  "obsidian_get_recent_edits",
  "obsidian_list_notes",
  "obsidian_list_tags",
  "obsidian_read_note",
  "obsidian_resolve_wikilink",
  "obsidian_search",
  "obsidian_search_text",
  "obsidian_stale_notes",
  "obsidian_stats"
].sort((left, right) => left.localeCompare(right));

const OPTIONAL_DEPENDENCIES = [
  "@huggingface/transformers",
  "@napi-rs/canvas",
  "better-sqlite3",
  "hnswlib-node",
  "pdfjs-dist",
  "tesseract.js"
];
const OPTIONAL_DEPENDENCY_SET = new Set(OPTIONAL_DEPENDENCIES);

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function packagePurl(name, version) {
  const encodedName = name.startsWith("@")
    ? `%40${encodeURIComponent(name.slice(1).split("/")[0] ?? "")}/${encodeURIComponent(name.split("/")[1] ?? "")}`
    : encodeURIComponent(name);
  return `pkg:npm/${encodedName}@${encodeURIComponent(version)}`;
}

export function createOwnedScratch() {
  const resolved = path.resolve(mkdtempSync(path.join(tmpdir(), "enquire-mcpb-consumer-")));
  const stat = lstatSync(resolved);
  assert.ok(!stat.isSymbolicLink() && stat.isDirectory(), `consumer scratch is not a real directory: ${resolved}`);
  const token = randomUUID();
  writeFileSync(path.join(resolved, SCRATCH_MARKER), `enquire-mcpb consumer scratch v1\n${token}\n`, {
    encoding: "utf8",
    flag: "wx"
  });
  return { path: resolved, dev: stat.dev, ino: stat.ino, token };
}

export function removeOwnedScratch(owned) {
  const resolved = path.resolve(owned.path);
  if (
    path.dirname(resolved) !== path.resolve(tmpdir()) ||
    !path.basename(resolved).startsWith("enquire-mcpb-consumer-")
  ) {
    throw new Error(`refusing recursive cleanup of unexpected consumer target: ${resolved}`);
  }
  const stat = lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory() || stat.dev !== owned.dev || stat.ino !== owned.ino) {
    throw new Error(`refusing recursive cleanup after consumer scratch identity changed: ${resolved}`);
  }
  const marker = path.join(resolved, SCRATCH_MARKER);
  const markerStat = lstatSync(marker);
  if (markerStat.isSymbolicLink() || !markerStat.isFile()) {
    throw new Error(`refusing recursive cleanup without a regular ownership marker: ${resolved}`);
  }
  if (readFileSync(marker, "utf8") !== `enquire-mcpb consumer scratch v1\n${owned.token}\n`) {
    throw new Error(`refusing recursive cleanup after ownership token changed: ${resolved}`);
  }
  rmSync(resolved, { recursive: true, force: false });
}

function archiveEntries(artifact) {
  const entries = unzipSync(readFileSync(artifact));
  const normalized = new Map();
  const portableNames = new Set();
  for (const [rawName, data] of Object.entries(entries)) {
    const name = portableArchivePath(rawName);
    assert.ok(!normalized.has(name), `duplicate normalized entry: ${name}`);
    const portableName = portableArchiveKey(name);
    assert.ok(!portableNames.has(portableName), `case-colliding entry: ${name}`);
    normalized.set(name, Buffer.from(data));
    portableNames.add(portableName);
  }
  return normalized;
}

function textFromToolResult(result) {
  return Array.isArray(result?.content)
    ? result.content
        .filter((item) => item?.type === "text" && typeof item.text === "string")
        .map((item) => item.text)
        .join("\n")
    : "";
}

function writeArchive(entries, destination) {
  for (const [name, data] of entries) {
    const target = path.resolve(destination, ...name.split("/"));
    assert.ok(target.startsWith(`${path.resolve(destination)}${path.sep}`), `entry escaped extraction root: ${name}`);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, data, { flag: "wx" });
  }
}

function snapshotRegularTree(root) {
  const entries = [];
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort((left, right) => left.localeCompare(right))) {
      const target = path.join(directory, name);
      const stat = lstatSync(target);
      assert.ok(!stat.isSymbolicLink(), `vault snapshot refuses symlink: ${target}`);
      const relative = path.relative(root, target).replaceAll(path.sep, "/");
      if (stat.isDirectory()) {
        entries.push({
          path: relative,
          type: "directory",
          dev: stat.dev,
          ino: stat.ino,
          mode: stat.mode,
          mtime_ms: stat.mtimeMs,
          ctime_ms: stat.ctimeMs
        });
        visit(target);
      } else {
        assert.ok(stat.isFile(), `vault snapshot refuses special file: ${target}`);
        const data = readFileSync(target);
        entries.push({
          path: relative,
          type: "file",
          dev: stat.dev,
          ino: stat.ino,
          mode: stat.mode,
          mtime_ms: stat.mtimeMs,
          ctime_ms: stat.ctimeMs,
          size: data.length,
          sha256: sha256(data)
        });
      }
    }
  };
  const rootStat = lstatSync(root);
  assert.ok(!rootStat.isSymbolicLink() && rootStat.isDirectory(), `vault root is not a real directory: ${root}`);
  entries.push({
    path: ".",
    type: "directory",
    dev: rootStat.dev,
    ino: rootStat.ino,
    mode: rootStat.mode,
    mtime_ms: rootStat.mtimeMs,
    ctime_ms: rootStat.ctimeMs
  });
  visit(root);
  return entries;
}

function snapshotRegularFile(target) {
  const stat = lstatSync(target);
  assert.ok(!stat.isSymbolicLink() && stat.isFile(), `canary is not a regular file: ${target}`);
  const data = readFileSync(target);
  return {
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    mtime_ms: stat.mtimeMs,
    ctime_ms: stat.ctimeMs,
    size: data.length,
    sha256: sha256(data)
  };
}

function resolveManifestArgs(args, installRoot, vaultRoot) {
  return args.map((value) =>
    value.replace(INSTALL_ROOT_PLACEHOLDER, installRoot).replace(VAULT_ROOT_PLACEHOLDER, vaultRoot)
  );
}

async function expectRefused(label, operation) {
  let result;
  try {
    result = await operation();
  } catch (error) {
    assert.match(String(error), /not found|invalid path|outside vault|escapes vault root|unknown tool/i, label);
    return;
  }
  assert.equal(result?.isError, true, `${label}: unexpectedly succeeded`);
  assert.match(
    textFromToolResult(result),
    /not found|invalid path|outside vault|escapes vault root|unknown tool/i,
    label
  );
}

async function expectTraversalRefused(operation, canaryMarker) {
  let result;
  try {
    result = await operation();
  } catch (error) {
    const message = String(error);
    assert.match(message, /invalid path|outside vault|escapes vault root/i, "traversal must be explicitly refused");
    assert.ok(!message.includes(canaryMarker), "traversal refusal leaked outside-vault canary");
    return;
  }
  const message = textFromToolResult(result);
  assert.equal(result?.isError, true, "traversal unexpectedly succeeded");
  assert.match(message, /invalid path|outside vault|escapes vault root/i, "traversal must be explicitly refused");
  assert.ok(!message.includes(canaryMarker), "traversal response leaked outside-vault canary");
}

export async function verifyBasicMcpb(artifact) {
  const rootPackage = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(
    path.basename(artifact),
    `enquire-mcp-basic-${rootPackage.version}.mcpb`,
    "MCPB artifact filename does not match the current package version"
  );
  const entries = archiveEntries(artifact);
  const manifest = JSON.parse(entries.get("manifest.json")?.toString("utf8") ?? "null");
  const content = JSON.parse(entries.get("content-manifest.json")?.toString("utf8") ?? "null");
  assert.equal(manifest.manifest_version, "0.3");
  assert.equal(manifest.name, "enquire-mcp-basic");
  assert.equal(manifest.version, rootPackage.version);
  assert.match(manifest.$schema, /70fe3b34cd6dff1b3bba046638edc72a6467a4fb/);
  assert.equal(manifest.server.entry_point, "server/dist/index.js");
  assert.equal(manifest.server.mcp_config.command, "node");
  assert.deepEqual(
    manifest.tools.map((tool) => tool.name).sort((left, right) => left.localeCompare(right)),
    BASIC_TOOLS
  );
  assert.deepEqual(manifest.prompts, []);
  assert.equal(manifest.prompts_generated, false);
  assert.equal(manifest.tools_generated, false);
  assert.deepEqual(manifest.compatibility.platforms, ["darwin", "win32", "linux"]);
  assert.equal(manifest.compatibility.runtimes.node, ">=22.13.0");
  assert.equal(manifest.user_config.vault.type, "directory");
  assert.equal(manifest.user_config.vault.required, true);
  assert.equal(manifest.user_config.vault.multiple, false);

  const args = manifest.server.mcp_config.args;
  assert.deepEqual(args.slice(0, 8), [
    `${INSTALL_ROOT_PLACEHOLDER}/server/dist/index.js`,
    "serve",
    "--vault",
    VAULT_ROOT_PLACEHOLDER,
    "--no-prompts",
    "--no-embedding-index",
    "--diagnostic-search-tools",
    "--enabled-tools"
  ]);
  assert.deepEqual(
    args.slice(8).sort((left, right) => left.localeCompare(right)),
    BASIC_TOOLS
  );
  assert.ok(
    !args.some((value) => /--enable-write|--feedback-weight|--watch|--persistent-index|--include-pdfs/.test(value))
  );

  const expectedEntries = new Set(["content-manifest.json", ...content.files.map((entry) => entry.path)]);
  assert.deepEqual([...entries.keys()].sort(), [...expectedEntries].sort(), "archive differs from content inventory");
  for (const expected of content.files) {
    const data = entries.get(expected.path);
    assert.ok(data, `inventoried file missing: ${expected.path}`);
    assert.equal(data.length, expected.size, `${expected.path}: size drift`);
    assert.equal(sha256(data), expected.sha256, `${expected.path}: SHA-256 drift`);
  }
  assert.equal(
    content.reproducibility,
    "deterministic-content-inventory; archive bytes include upstream pack-time mtime"
  );
  assert.equal(content.format, 1);
  assert.equal(content.package, `enquire-mcp-basic@${rootPackage.version}`);
  assert.equal(content.mcpb_spec_commit, "70fe3b34cd6dff1b3bba046638edc72a6467a4fb");
  assert.equal(content.packer, "@anthropic-ai/mcpb@2.1.2");

  const sbomBytes = entries.get("sbom.cdx.json");
  const licenseBytes = entries.get("third-party-licenses.json");
  assert.ok(sbomBytes, "CycloneDX SBOM missing from MCPB");
  assert.ok(licenseBytes, "third-party license/notices inventory missing from MCPB");
  const sbom = JSON.parse(sbomBytes.toString("utf8"));
  const licenses = JSON.parse(licenseBytes.toString("utf8"));
  assert.equal(sbom.bomFormat, "CycloneDX");
  assert.equal(sbom.specVersion, "1.5");
  assert.equal(sbom.version, 1);
  assert.equal(sbom.metadata.component.name, "enquire-mcp-basic");
  assert.equal(sbom.metadata.component.version, manifest.version);
  assert.equal(licenses.format, 1);
  assert.equal(licenses.package, `enquire-mcp-basic@${manifest.version}`);
  assert.ok(Array.isArray(sbom.components) && sbom.components.length > 0, "SBOM dependency inventory is empty");
  assert.ok(Array.isArray(licenses.packages) && licenses.packages.length > 0, "license inventory is empty");

  const archivedPackageRefs = new Set();
  const archivedPackageVersions = new Map();
  const packageManifestPattern =
    /^server\/node_modules\/(?:@[^/]+\/)?[^/]+(?:\/node_modules\/(?:@[^/]+\/)?[^/]+)*\/package\.json$/;
  for (const [name, data] of entries) {
    if (!packageManifestPattern.test(name)) continue;
    const dependency = JSON.parse(data.toString("utf8"));
    assert.equal(typeof dependency.name, "string", `${name}: package name missing`);
    assert.equal(typeof dependency.version, "string", `${name}: package version missing`);
    assert.ok(!OPTIONAL_DEPENDENCY_SET.has(dependency.name), `optional dependency identity leaked: ${dependency.name}`);
    archivedPackageRefs.add(packagePurl(dependency.name, dependency.version));
    const versions = archivedPackageVersions.get(dependency.name) ?? new Set();
    versions.add(dependency.version);
    archivedPackageVersions.set(dependency.name, versions);
  }
  const licenseRefs = new Set(licenses.packages.map((entry) => entry.purl));
  const componentRefs = new Set(sbom.components.map((component) => component["bom-ref"]));
  assert.deepEqual(
    [...licenseRefs].sort(),
    [...archivedPackageRefs].sort(),
    "license inventory misses installed packages"
  );
  assert.deepEqual([...componentRefs].sort(), [...archivedPackageRefs].sort(), "SBOM misses installed packages");
  assert.deepEqual(
    [...(archivedPackageVersions.get("@hono/node-server") ?? [])],
    ["2.0.11"],
    "MCPB must bundle only patched @hono/node-server 2.0.11"
  );
  assert.deepEqual(
    [...(archivedPackageVersions.get("hono") ?? [])],
    ["4.12.34"],
    "MCPB must bundle only patched hono 4.12.34"
  );
  for (const entry of licenses.packages) {
    assert.equal(typeof entry.declared_license, "string");
    assert.ok(entry.declared_license.length > 0);
    assert.ok(Array.isArray(entry.locations) && entry.locations.length > 0, `${entry.purl}: install location missing`);
    for (const location of entry.locations) {
      const packageJson = entries.get(`${location}/package.json`);
      assert.ok(packageJson, `${entry.purl}: package location missing: ${location}`);
      const identity = JSON.parse(packageJson.toString("utf8"));
      assert.equal(packagePurl(identity.name, identity.version), entry.purl, `${entry.purl}: location identity drift`);
    }
    for (const notice of [...entry.license_files, ...entry.notice_files]) {
      const data = entries.get(notice.path);
      assert.ok(data, `${entry.purl}: notice file missing: ${notice.path}`);
      assert.equal(data.length, notice.size, `${notice.path}: notice size drift`);
      assert.equal(sha256(data), notice.sha256, `${notice.path}: notice SHA-256 drift`);
    }
  }
  const validDependencyRefs = new Set([sbom.metadata.component["bom-ref"], ...componentRefs]);
  assert.ok(Array.isArray(sbom.dependencies) && sbom.dependencies.length === componentRefs.size + 1);
  for (const dependency of sbom.dependencies) {
    assert.ok(validDependencyRefs.has(dependency.ref), `SBOM dependency has unknown ref: ${dependency.ref}`);
    for (const ref of dependency.dependsOn) {
      assert.ok(componentRefs.has(ref), `SBOM dependency points outside components: ${ref}`);
    }
  }

  const sidecarStem = artifact.endsWith(".mcpb") ? artifact.slice(0, -".mcpb".length) : artifact;
  const contentSidecar = `${sidecarStem}.content-manifest.json`;
  const sbomSidecar = `${sidecarStem}.sbom.cdx.json`;
  const licensesSidecar = `${sidecarStem}.third-party-licenses.json`;
  assert.ok(existsSync(contentSidecar), `MCPB content inventory sidecar missing: ${contentSidecar}`);
  assert.ok(existsSync(sbomSidecar), `MCPB SBOM sidecar missing: ${sbomSidecar}`);
  assert.ok(existsSync(licensesSidecar), `MCPB license sidecar missing: ${licensesSidecar}`);
  assert.deepEqual(
    readFileSync(contentSidecar),
    entries.get("content-manifest.json"),
    "content inventory sidecar differs from bundled inventory"
  );
  assert.deepEqual(readFileSync(sbomSidecar), sbomBytes, "SBOM sidecar differs from bundled SBOM");
  assert.deepEqual(readFileSync(licensesSidecar), licenseBytes, "license sidecar differs from bundled inventory");

  for (const dependency of OPTIONAL_DEPENDENCIES) {
    const prefix = `server/node_modules/${dependency}/`;
    assert.ok(
      ![...entries.keys()].some((name) => name.startsWith(prefix)),
      `optional dependency leaked: ${dependency}`
    );
  }
  for (const [name, data] of entries) {
    const binaryReason = nativeBinaryReason(name, data);
    assert.equal(binaryReason, null, `native executable leaked into Basic MCPB: ${name} (${binaryReason})`);
  }
  for (const forbidden of ["src/", "tests/", "docs/", "coverage/", "bench/", ".git/", ".env"]) {
    assert.ok(
      ![...entries.keys()].some((name) => name === forbidden || name.startsWith(forbidden)),
      `forbidden path: ${forbidden}`
    );
  }
  assert.ok(!entries.has("server/package-lock.json"));
  assert.ok(!entries.has("server/node_modules/.package-lock.json"));
  assert.ok(entries.has("server/dist/index.js"));
  assert.ok(entries.has("server/node_modules/@modelcontextprotocol/server/package.json"));
  const runtimePackage = JSON.parse(entries.get("server/package.json")?.toString("utf8") ?? "null");
  assert.equal(runtimePackage.name, "@oomkapwn/enquire-mcp-mcpb-basic-runtime");
  assert.equal(runtimePackage.version, rootPackage.version);
  assert.equal(runtimePackage.engines?.node, rootPackage.engines?.node);
  assert.deepEqual(Object.keys(runtimePackage).sort(), [
    "dependencies",
    "engines",
    "name",
    "overrides",
    "private",
    "type",
    "version"
  ]);
  assert.deepEqual(runtimePackage.overrides, {
    "@hono/node-server": "^2.0.11",
    hono: "^4.12.34"
  });

  const scratch = createOwnedScratch();
  try {
    const installRoot = path.join(scratch.path, "installed");
    const vaultRoot = path.join(scratch.path, "vault");
    const canaryPath = path.join(scratch.path, "outside.md");
    const canaryMarker = "MCPB-outside-vault-canary-must-never-leak\n";
    writeFileSync(canaryPath, canaryMarker, { flag: "wx" });
    const canaryBefore = snapshotRegularFile(canaryPath);
    mkdirSync(path.join(vaultRoot, "Projects"), { recursive: true });
    writeFileSync(
      path.join(vaultRoot, "Home.md"),
      "---\ntags: [home]\nstatus: active\n---\n# Home\n[[Projects/Hermes]]\n"
    );
    writeFileSync(
      path.join(vaultRoot, "Projects", "Hermes.md"),
      "---\ntags: [project]\nstatus: active\n---\n# Hermes\nMCPB-basic-search-target\n"
    );
    const cacheRoot = path.join(scratch.path, "cache");
    const cacheDir = path.join(cacheRoot, "enquire");
    const vaultHash = createHash("sha1").update(vaultRoot).digest("hex").slice(0, 12);
    const strandedEmbedDb = path.join(cacheDir, `${vaultHash}.embed.db`);
    const strandedGuard = `${strandedEmbedDb}.watcher-activation.guard`;
    mkdirSync(strandedGuard, { recursive: true });
    writeFileSync(strandedEmbedDb, "stranded embedding index and activation guard\n", { flag: "wx" });
    writeFileSync(path.join(strandedGuard, "sentinel"), "must remain untouched\n", { flag: "wx" });
    mkdirSync(installRoot, { recursive: true });
    writeArchive(entries, installRoot);
    const vaultBefore = snapshotRegularTree(vaultRoot);
    const cacheBefore = snapshotRegularTree(cacheRoot);

    const expanded = resolveManifestArgs(args, installRoot, vaultRoot);
    const entry = expanded[0];
    assert.equal(path.normalize(entry), path.join(installRoot, "server", "dist", "index.js"));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: expanded,
      cwd: installRoot,
      env: { ...process.env, ...manifest.server.mcp_config.env, XDG_CACHE_HOME: cacheRoot },
      stderr: "ignore"
    });
    const client = new Client({ name: "enquire-mcpb-consumer", version: "1.0.0" });
    let connected = false;
    let operationError;
    try {
      await client.connect(transport);
      connected = true;
      const [tools, prompts, resources, templates] = await Promise.all([
        client.listTools(),
        client.listPrompts(),
        client.listResources(),
        client.listResourceTemplates()
      ]);
      assert.deepEqual(
        tools.tools.map((tool) => tool.name).sort((left, right) => left.localeCompare(right)),
        BASIC_TOOLS
      );
      for (const tool of tools.tools) {
        assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name}: live tool is not annotated read-only`);
      }
      assert.deepEqual(prompts.prompts, []);
      assert.ok(resources.resources.some((resource) => resource.uri === "obsidian://vault/info"));
      assert.ok(resources.resources.some((resource) => resource.uri === "obsidian://note/Projects/Hermes.md"));
      assert.deepEqual(
        templates.resourceTemplates.map((template) => template.uriTemplate),
        ["obsidian://note/{+notePath}"]
      );

      const positiveCalls = [
        {
          name: "obsidian_frontmatter_get",
          arguments: { path: "Projects/Hermes.md", key: "status" },
          expected: /"value":\s*"active"/
        },
        {
          name: "obsidian_frontmatter_search",
          arguments: { key: "status", equals: "active" },
          expected: /Projects\/Hermes\.md/
        },
        {
          name: "obsidian_get_backlinks",
          arguments: { path: "Projects/Hermes.md" },
          expected: /Home\.md/
        },
        {
          name: "obsidian_get_outbound_links",
          arguments: { path: "Home.md" },
          expected: /Projects\/Hermes\.md/
        },
        { name: "obsidian_get_recent_edits", arguments: { limit: 5 }, expected: /Projects\/Hermes\.md/ },
        { name: "obsidian_list_notes", arguments: { tag: "project" }, expected: /Projects\/Hermes\.md/ },
        { name: "obsidian_list_tags", arguments: {}, expected: /"tag":\s*"project"/ },
        {
          name: "obsidian_read_note",
          arguments: { path: "Projects/Hermes.md" },
          expected: /MCPB-basic-search-target/
        },
        {
          name: "obsidian_resolve_wikilink",
          arguments: { wikilink: "Projects/Hermes", from_note: "Home.md" },
          expected: /"found":\s*true[\s\S]*Projects\/Hermes\.md/
        },
        {
          name: "obsidian_search_text",
          arguments: { query: "MCPB-basic-search-target" },
          expected: /Projects\/Hermes\.md/
        },
        {
          name: "obsidian_search",
          arguments: { query: "MCPB-basic-search-target", limit: 5 },
          expected: /"signals_used":\s*\[\s*"tfidf"\s*\][\s\S]*"path":\s*"Projects\/Hermes\.md"/
        },
        {
          name: "obsidian_stale_notes",
          arguments: { stale_days: 36500, limit: 5 },
          expected: /"scanned_notes":\s*2/
        },
        { name: "obsidian_stats", arguments: {}, expected: /"total_notes":\s*2/ }
      ];
      assert.deepEqual(
        positiveCalls.map((entry) => entry.name).sort((left, right) => left.localeCompare(right)),
        BASIC_TOOLS,
        "positive consumer calls must cover every Basic tool exactly once"
      );
      for (const call of positiveCalls) {
        const result = await client.callTool({ name: call.name, arguments: call.arguments });
        assert.notEqual(result.isError, true, `${call.name}: positive call failed`);
        assert.match(textFromToolResult(result), call.expected, `${call.name}: response contract drift`);
      }

      const noMatchSearch = await client.callTool({
        name: "obsidian_search",
        arguments: { query: "MCPB-definitely-absent-search-sentinel", limit: 5 }
      });
      assert.notEqual(noMatchSearch.isError, true, "obsidian_search: negative-control call failed");
      const noMatchText = textFromToolResult(noMatchSearch);
      assert.match(noMatchText, /"matches":\s*\[\s*\]/, "obsidian_search: absent-token query returned matches");
      assert.ok(!noMatchText.includes("Projects/Hermes.md"), "obsidian_search: negative control leaked a false hit");

      const resource = await client.readResource({ uri: "obsidian://note/Projects/Hermes.md" });
      assert.match(JSON.stringify(resource.contents), /MCPB-basic-search-target/);

      await expectRefused("write surface must stay absent", () =>
        client.callTool({ name: "obsidian_create_note", arguments: { path: "No.md", content: "no" } })
      );
      await expectTraversalRefused(
        () => client.callTool({ name: "obsidian_read_note", arguments: { path: "../outside.md" } }),
        canaryMarker
      );
      await expectTraversalRefused(
        () => client.readResource({ uri: "obsidian://note/%2E%2E%2Foutside.md" }),
        canaryMarker
      );
      const live = await client.callTool({ name: "obsidian_read_note", arguments: { path: "Projects/Hermes.md" } });
      assert.match(textFromToolResult(live), /MCPB-basic-search-target/, "server died after negative controls");
    } catch (error) {
      operationError = error;
    }

    let cleanupError;
    try {
      if (connected) await client.close();
      else await client.close().catch(() => {});
    } catch (error) {
      cleanupError = error;
    }
    try {
      assert.deepEqual(
        snapshotRegularTree(vaultRoot),
        vaultBefore,
        "Basic session changed vault paths, physical identities, bytes, modes, or timestamps"
      );
      assert.deepEqual(snapshotRegularFile(canaryPath), canaryBefore, "outside-vault canary identity changed");
      assert.equal(readFileSync(canaryPath, "utf8"), canaryMarker, "outside-vault canary bytes changed");
      assert.deepEqual(
        snapshotRegularTree(cacheRoot),
        cacheBefore,
        "Basic session changed isolated cache sentinel paths"
      );
    } catch (error) {
      cleanupError = cleanupError
        ? new AggregateError([cleanupError, error], "Basic MCPB close and state-integrity checks both failed")
        : error;
    }
    if (operationError && cleanupError) {
      throw new AggregateError([operationError, cleanupError], "Basic MCPB operation and cleanup both failed");
    }
    if (operationError) throw operationError;
    if (cleanupError) throw cleanupError;
  } finally {
    removeOwnedScratch(scratch);
  }

  const result = { artifact, artifact_sha256: sha256(readFileSync(artifact)), tools: BASIC_TOOLS.length };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (isEntrypoint(import.meta.url)) {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const artifact = process.argv[2] ?? path.join(ROOT, "artifacts", `enquire-mcp-basic-${pkg.version}.mcpb`);
  assert.ok(existsSync(artifact), `MCPB artifact missing: ${artifact}`);
  await verifyBasicMcpb(artifact);
}
