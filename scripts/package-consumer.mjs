#!/usr/bin/env node
// Fresh npm-tarball consumer gate. CI runs this unchanged on Linux, Windows,
// and macOS; each runner verifies both normal and --omit=optional installs.

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isEntrypoint } from "./lib/entrypoint.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_NAME = "@oomkapwn/enquire-mcp";
const PACKAGE_DIR_PARTS = ["node_modules", "@oomkapwn", "enquire-mcp"];
const TEXT_EXTENSIONS = new Set([".cjs", ".js", ".json", ".md", ".mjs", ".txt", ".ts"]);

/**
 * Resolve npm without handing a `.cmd` shim to `spawnSync` on Windows.
 * Prefer npm's own JavaScript entrypoint and execute it with the current Node;
 * fall back to the PATH executable only on platforms where that is directly
 * spawnable.
 */
function npmProcessSpec(platform = process.platform, env = process.env, execPath = process.execPath) {
  const configured = typeof env.npm_execpath === "string" ? env.npm_execpath : "";
  const binDir = path.dirname(execPath);
  const candidates = [
    configured,
    path.join(binDir, "node_modules", "npm", "bin", "npm-cli.js"),
    path.resolve(binDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")
  ].filter(Boolean);
  const npmCli = candidates.find((candidate) => existsSync(candidate));
  if (npmCli) return { command: execPath, argsPrefix: [npmCli] };
  if (platform === "win32") {
    throw new Error("npm CLI JavaScript entrypoint unavailable on Windows; refusing to invoke a .cmd shim");
  }
  return { command: "npm", argsPrefix: [] };
}

const NPM = npmProcessSpec();

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    encoding: "utf8",
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with status ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    );
  }
  return result.stdout;
}

function runNpm(args, options = {}) {
  return run(NPM.command, [...NPM.argsPrefix, ...args], options);
}

function normalizePackagePath(value) {
  return String(value).replaceAll("\\", "/").replace(/^\.\//, "");
}

export function assertPrivateFilesExcluded(files) {
  const forbidden = [];
  for (const entry of files) {
    const candidate = normalizePackagePath(typeof entry === "string" ? entry : entry?.path);
    if (
      candidate === ".env" ||
      candidate.startsWith(".env.") ||
      candidate === "coverage" ||
      candidate.startsWith("coverage/") ||
      candidate === "docs/collab" ||
      candidate.startsWith("docs/collab/") ||
      candidate === "docs/audits" ||
      candidate.startsWith("docs/audits/") ||
      candidate === "src" ||
      candidate.startsWith("src/") ||
      candidate === "tests" ||
      candidate.startsWith("tests/")
    ) {
      forbidden.push(candidate);
    }
  }
  if (forbidden.length > 0) {
    throw new Error(`npm tarball contains private or source-only paths: ${forbidden.join(", ")}`);
  }
}

function collectTextFiles(root) {
  const files = [];
  const visit = (dir) => {
    for (const name of readdirSync(dir)) {
      const target = path.join(dir, name);
      const stat = statSync(target);
      if (stat.isDirectory()) visit(target);
      else if (stat.isFile() && TEXT_EXTENSIONS.has(path.extname(name))) files.push(target);
    }
  };
  visit(root);
  return files;
}

function assertNoBuildPathLeak(packageRoot) {
  const exactRoot = ROOT;
  const posixRoot = ROOT.replaceAll("\\", "/");
  for (const file of collectTextFiles(packageRoot)) {
    const body = readFileSync(file, "utf8");
    assert.ok(!body.includes(exactRoot), `${path.relative(packageRoot, file)} leaks the build checkout path`);
    assert.ok(
      !body.includes(posixRoot),
      `${path.relative(packageRoot, file)} leaks the normalized build checkout path`
    );
  }
}

function assertNoLegacySdkSpecifiers(packageRoot) {
  const distRoot = path.join(packageRoot, "dist");
  for (const file of collectTextFiles(distRoot)) {
    const body = readFileSync(file, "utf8");
    assert.doesNotMatch(
      body,
      /["']@modelcontextprotocol\/sdk(?:\/[^"']*)?["']/,
      `${path.relative(packageRoot, file)} retains a legacy MCP SDK import specifier`
    );
  }
  const packedPackage = readFileSync(path.join(packageRoot, "package.json"), "utf8");
  assert.doesNotMatch(
    packedPackage,
    /@modelcontextprotocol\/sdk/,
    "packed dependency graph retains the legacy MCP SDK"
  );
}

function writeConsumerSources(consumerDir) {
  writeFileSync(
    path.join(consumerDir, "consumer.ts"),
    `import { buildMcpServer, VERSION, type ServeOptions } from "${PACKAGE_NAME}";
import type { McpServer } from "@modelcontextprotocol/server";
import * as Bases from "${PACKAGE_NAME}/bases";
import * as Communities from "${PACKAGE_NAME}/communities";
import * as EmbedDb from "${PACKAGE_NAME}/embed-db";
import * as Fts5 from "${PACKAGE_NAME}/fts5";
import * as Hnsw from "${PACKAGE_NAME}/hnsw";
import { TOOL_MANIFEST, type ToolManifestEntry } from "${PACKAGE_NAME}/tool-manifest";
import { Vault, type VaultOptions } from "${PACKAGE_NAME}/vault";

const version: string = VERSION;
const options: ServeOptions = { vault: "." };
const vaultOptions: VaultOptions = { readPaths: ["Public/**"] };
const first: ToolManifestEntry | undefined = TOOL_MANIFEST[0];
const builtServer: McpServer = null as unknown as ReturnType<typeof buildMcpServer>;
const surfaces = [Bases, Communities, EmbedDb, Fts5, Hnsw, Vault, buildMcpServer, builtServer, version, options, vaultOptions, first];
void surfaces;
`,
    "utf8"
  );
  writeFileSync(
    path.join(consumerDir, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          noEmit: true,
          skipLibCheck: false,
          types: ["node"]
        },
        include: ["consumer.ts"]
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  writeFileSync(
    path.join(consumerDir, "runtime.mjs"),
    `import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMcpServer, VERSION } from "${PACKAGE_NAME}";
import * as Bases from "${PACKAGE_NAME}/bases";
import * as Communities from "${PACKAGE_NAME}/communities";
import * as EmbedDb from "${PACKAGE_NAME}/embed-db";
import * as Fts5 from "${PACKAGE_NAME}/fts5";
import * as Hnsw from "${PACKAGE_NAME}/hnsw";
import { TOOL_MANIFEST } from "${PACKAGE_NAME}/tool-manifest";
import { Vault } from "${PACKAGE_NAME}/vault";

const packageJsonPath = fileURLToPath(import.meta.resolve("${PACKAGE_NAME}/package.json"));
const packageRoot = path.dirname(packageJsonPath);
const pkg = JSON.parse(await readFile(packageJsonPath, "utf8"));
assert.equal(VERSION, pkg.version, "root runtime version differs from packaged metadata");
assert.equal(typeof buildMcpServer, "function", "semver-critical root buildMcpServer export is missing");
assert.equal(TOOL_MANIFEST.length, 46, "tool-manifest subpath returned the wrong inventory");
for (const [name, surface] of Object.entries({ Bases, Communities, EmbedDb, Fts5, Hnsw })) {
  assert.ok(Object.keys(surface).length > 0, name + " subpath exported no runtime surface");
}

const cli = spawnSync(process.execPath, [path.join(packageRoot, "dist", "index.js"), "--version"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"]
});
assert.equal(cli.status, 0, "packaged CLI failed: " + cli.stderr);
assert.equal(cli.stdout.trim(), pkg.version, "packaged CLI returned the wrong version");

const vaultRoot = await mkdtemp(path.join(tmpdir(), "enquire-package-consumer-vault-"));
const publicMarker = "public-package-consumer-marker";
const privateMarker = "PRIVATE_PACKAGE_CONSUMER_SENTINEL";
try {
  await mkdir(path.join(vaultRoot, "Public"), { recursive: true });
  await mkdir(path.join(vaultRoot, "Private"), { recursive: true });
  await writeFile(path.join(vaultRoot, "Public", "visible.md"), publicMarker);
  await writeFile(path.join(vaultRoot, "Public", "blocked.md"), privateMarker);
  await writeFile(path.join(vaultRoot, "Private", "secret.md"), privateMarker);
  const vault = new Vault(vaultRoot, {
    readPaths: ["Public/**"],
    excludeGlobs: ["Public/blocked.md"]
  });
  await vault.ensureExists();
  const visible = await vault.listMarkdown();
  assert.deepEqual(visible.map((entry) => entry.relPath), ["Public/visible.md"]);
  assert.match((await vault.readNote("Public/visible.md")).content, new RegExp(publicMarker));
  for (const blockedPath of ["Public/blocked.md", "Private/secret.md", "../outside.md"]) {
    let value;
    let rejection;
    try {
      value = await vault.readNote(blockedPath);
    } catch (error) {
      rejection = error;
    }
    if (rejection === undefined) {
      assert.ok(!JSON.stringify(value).includes(privateMarker), blockedPath + " leaked private content");
      assert.fail(blockedPath + " privacy negative control unexpectedly succeeded");
    }
    assert.ok(!String(rejection).includes(privateMarker), blockedPath + " leaked private content in its error");
  }
  await assert.rejects(
    vault.writeNote("Public/new.md", "must-not-write"),
    /read-only|enable-write/i,
    "published Vault must stay read-only by default"
  );
} finally {
  await rm(vaultRoot, { recursive: true, force: true });
}
`,
    "utf8"
  );
}

function verifyConsumer(tarballPath, mode, rootPackage, tempRoot) {
  const consumerDir = path.join(tempRoot, `consumer-${mode}`);
  mkdirSync(consumerDir);
  writeFileSync(
    path.join(consumerDir, "package.json"),
    `${JSON.stringify(
      {
        name: `enquire-package-consumer-${mode}`,
        private: true,
        type: "module",
        dependencies: { [PACKAGE_NAME]: pathToFileURL(tarballPath).href },
        devDependencies: { "@types/node": rootPackage.devDependencies["@types/node"] }
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  const optionalFlag = mode === "omit-optional" ? "--omit=optional" : "--include=optional";
  runNpm(["install", "--no-audit", "--no-fund", "--include=dev", optionalFlag], { cwd: consumerDir });

  const packageRoot = path.join(consumerDir, ...PACKAGE_DIR_PARTS);
  assert.ok(existsSync(path.join(packageRoot, "dist", "index.js")), `${mode}: packed dist/index.js is missing`);
  assert.ok(!existsSync(path.join(packageRoot, "src")), `${mode}: source directory leaked into the package`);
  if (mode === "omit-optional") {
    const optionalNames = Object.keys(rootPackage.optionalDependencies ?? {});
    assert.ok(optionalNames.length > 0, `${mode}: root package declares no optional dependency inventory to verify`);
    for (const optionalName of optionalNames) {
      assert.ok(
        !existsSync(path.join(consumerDir, "node_modules", optionalName)),
        `${mode}: ${optionalName} was installed despite --omit=optional`
      );
    }
  }
  assert.ok(
    !existsSync(path.join(consumerDir, "node_modules", "@modelcontextprotocol", "sdk")),
    `${mode}: consumer resolution retained the legacy @modelcontextprotocol/sdk package`
  );
  assertNoBuildPathLeak(packageRoot);
  assertNoLegacySdkSpecifiers(packageRoot);
  writeConsumerSources(consumerDir);

  const tsc = path.join(ROOT, "node_modules", "typescript-native", "bin", "tsc");
  run(process.execPath, [tsc, "--project", path.join(consumerDir, "tsconfig.json")], { cwd: consumerDir });
  run(process.execPath, [path.join(consumerDir, "runtime.mjs")], {
    cwd: consumerDir,
    env: { ENQUIRE_CONSUMER_MODE: mode }
  });
  console.log(`[package-consumer] OK — ${process.platform}/${process.arch}/${mode}`);
}

export function runPackageConsumer() {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "enquire-package-consumer-"));
  try {
    const packed = JSON.parse(
      runNpm(["pack", "--json", "--ignore-scripts", "--pack-destination", tempRoot], { cwd: ROOT })
    )?.[0];
    assert.ok(packed && typeof packed.filename === "string", "npm pack returned no artifact metadata");
    assert.equal(packed.name, PACKAGE_NAME, "npm pack returned the wrong package identity");
    assertPrivateFilesExcluded(packed.files ?? []);
    assert.throws(
      () => assertPrivateFilesExcluded([...(packed.files ?? []), { path: "docs/collab/STATE.md" }]),
      /private or source-only paths/,
      "private-file negative control did not detect an injected handoff file"
    );
    const packedPaths = new Set((packed.files ?? []).map((entry) => normalizePackagePath(entry.path)));
    assert.ok(packedPaths.has("package.json"), "npm tarball is missing package.json");
    assert.ok(packedPaths.has("dist/index.js"), "npm tarball is missing dist/index.js");

    const rootPackage = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
    const rootLock = readFileSync(path.join(ROOT, "package-lock.json"), "utf8");
    assert.doesNotMatch(
      JSON.stringify(rootPackage),
      /@modelcontextprotocol\/sdk/,
      "source package.json retains the legacy MCP SDK dependency"
    );
    assert.doesNotMatch(rootLock, /@modelcontextprotocol\/sdk/, "source lockfile retains the legacy MCP SDK graph");
    assert.equal(packed.version, rootPackage.version, "npm tarball version differs from the checkout");
    const tarballPath = path.join(tempRoot, packed.filename);
    verifyConsumer(tarballPath, "full", rootPackage, tempRoot);
    verifyConsumer(tarballPath, "omit-optional", rootPackage, tempRoot);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

if (isEntrypoint(import.meta.url)) {
  try {
    runPackageConsumer();
  } catch (error) {
    console.error(
      `[package-consumer] FAIL — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`
    );
    process.exitCode = 1;
  }
}
