#!/usr/bin/env node
// Fresh npm-tarball consumer gate. CI passes one previously built canonical
// tarball to Linux, Windows, and macOS; consumers never repack that checkout.

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isEntrypoint } from "./lib/entrypoint.mjs";
import { MAX_NPM_PACKAGE_TARBALL_BYTES, verifyNpmPackageArtifactManifest } from "./npm-package-artifact.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_NAME = "@oomkapwn/enquire-mcp";
const PACKAGE_DIR_PARTS = ["node_modules", "@oomkapwn", "enquire-mcp"];
const TEXT_EXTENSIONS = new Set([".cjs", ".js", ".json", ".map", ".md", ".mjs", ".txt", ".ts"]);

/** Closed-world Node-compatible import and capability probes for every optional dependency. */
export const OPTIONAL_DEPENDENCY_PROBES = Object.freeze([
  { packageName: "@huggingface/transformers", specifier: "@huggingface/transformers", exportPaths: [["pipeline"]] },
  { packageName: "@napi-rs/canvas", specifier: "@napi-rs/canvas", exportPaths: [["createCanvas"]] },
  {
    packageName: "better-sqlite3",
    specifier: "better-sqlite3",
    exportPaths: [["default"]],
    probeKind: "sqlite-memory"
  },
  {
    packageName: "hnswlib-node",
    specifier: "hnswlib-node",
    exportPaths: [["HierarchicalNSW"], ["default", "HierarchicalNSW"]],
    allowedMissingPlatforms: Object.freeze(["win32"])
  },
  { packageName: "pdfjs-dist", specifier: "pdfjs-dist/legacy/build/pdf.mjs", exportPaths: [["getDocument"]] },
  { packageName: "tesseract.js", specifier: "tesseract.js", exportPaths: [["createWorker"]] }
]);

/**
 * Decide whether npm may legitimately remove one failed optional native build.
 *
 * `hnswlib-node` is source-built during install and npm removes it after a
 * Windows toolchain/ABI failure because it is optional. Every other declared
 * optional dependency remains required by the full consumer lane, and an HNSW
 * package that is present is still resolved and exercised below.
 *
 * @param probe - One closed-world optional dependency probe.
 * @param platform - Node platform being verified.
 * @returns Whether absence is explicitly admitted for this exact pair.
 */
export function optionalDependencyMayBeMissing(probe, platform = process.platform) {
  return probe.allowedMissingPlatforms?.includes(platform) === true;
}

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

/**
 * Resolve the installed package bin shim without bypassing npm's generated
 * consumer-facing launcher. Windows `.cmd` shims require `cmd.exe`; the fixed
 * command string contains no path-derived shell text.
 */
export function packageCliProcessSpec(consumerDir, platform = process.platform, env = process.env) {
  const binDirectory = path.join(consumerDir, "node_modules", ".bin");
  if (platform === "win32") {
    return Object.freeze({
      args: ["/d", "/s", "/c", "enquire-mcp.cmd --version"],
      command: typeof env.ComSpec === "string" && env.ComSpec.length > 0 ? env.ComSpec : "cmd.exe",
      cwd: binDirectory,
      shim: path.join(binDirectory, "enquire-mcp.cmd")
    });
  }
  const shim = path.join(binDirectory, "enquire-mcp");
  return Object.freeze({ args: ["--version"], command: shim, cwd: binDirectory, shim });
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
    `import {
  buildMcpServer,
  inspectPersistenceLeases,
  inspectPersistenceNamespaceLeases,
  recoverPersistenceLease,
  recoverPersistenceNamespaceLease,
  VERSION,
  type PersistenceLeaseInspectableMarker,
  type PersistenceLeaseInspection,
  PersistenceLeaseOwnershipError,
  type PersistenceLeaseTarget,
  type RecoverPersistenceNamespaceLeaseOptions,
  type RecoverPersistenceLeaseOptions,
  type ServeOptions
} from "${PACKAGE_NAME}";
import type { McpServer } from "@modelcontextprotocol/server";
import * as Bases from "${PACKAGE_NAME}/bases";
import * as Communities from "${PACKAGE_NAME}/communities";
import * as EmbedDb from "${PACKAGE_NAME}/embed-db";
import * as Fts5 from "${PACKAGE_NAME}/fts5";
import * as Hnsw from "${PACKAGE_NAME}/hnsw";
import { TOOL_MANIFEST, type ToolManifestEntry } from "${PACKAGE_NAME}/tool-manifest";
import { Vault, type CachedNote, type VaultOptions } from "${PACKAGE_NAME}/vault";

const version: string = VERSION;
const options: ServeOptions = { vault: "." };
const vaultOptions: VaultOptions = { readPaths: ["Public/**"] };
const legacyCachedNote: CachedNote = {
  content: "",
  parsed: { frontmatter: {}, body: "", bodyStartLine: 1, wikilinks: [], embeds: [], tags: [] },
  mtimeMs: 0
};
const first: ToolManifestEntry | undefined = TOOL_MANIFEST[0];
const builtServer: McpServer = null as unknown as ReturnType<typeof buildMcpServer>;
const leaseTarget: PersistenceLeaseTarget = { targetPath: "/exact/cache/vault.embed.db", familyKey: "embed-db" };
const leaseInspection: Promise<PersistenceLeaseInspection> = inspectPersistenceLeases(leaseTarget);
const leaseRecoveryOptions: RecoverPersistenceLeaseOptions = {
  ...leaseTarget,
  markerId: "lease.shared.1.00000000000000000000000000000000.json",
  assertQuiescent: async () => false
};
const leaseRecovery: Promise<PersistenceLeaseInspectableMarker> = recoverPersistenceLease(leaseRecoveryOptions);
const namespaceInspection: Promise<PersistenceLeaseInspection> = inspectPersistenceNamespaceLeases("/exact/cache");
const namespaceRecoveryOptions: RecoverPersistenceNamespaceLeaseOptions = {
  parentPath: "/exact/cache",
  markerId: "lease.shared.1.00000000000000000000000000000000.json",
  assertQuiescent: async () => false
};
const namespaceRecovery: Promise<PersistenceLeaseInspectableMarker> = recoverPersistenceNamespaceLease(namespaceRecoveryOptions);
const surfaces = [Bases, Communities, EmbedDb, Fts5, Hnsw, Vault, PersistenceLeaseOwnershipError, buildMcpServer, builtServer, version, options, vaultOptions, legacyCachedNote, first, leaseInspection, leaseRecovery, namespaceInspection, namespaceRecovery];
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
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildMcpServer,
  inspectPersistenceLeases,
  inspectPersistenceNamespaceLeases,
  PersistenceLeaseOwnershipError,
  recoverPersistenceLease,
  recoverPersistenceNamespaceLease,
  VERSION
} from "${PACKAGE_NAME}";
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
assert.equal(
  typeof inspectPersistenceLeases,
  "function",
  "operator lease-inspection export is missing from the installed package"
);
assert.equal(
  typeof recoverPersistenceLease,
  "function",
  "operator lease-recovery export is missing from the installed package"
);
assert.equal(
  typeof inspectPersistenceNamespaceLeases,
  "function",
  "operator namespace lease-inspection export is missing from the installed package"
);
assert.equal(
  typeof recoverPersistenceNamespaceLease,
  "function",
  "operator namespace lease-recovery export is missing from the installed package"
);
assert.equal(
  typeof PersistenceLeaseOwnershipError,
  "function",
  "operator ownership-debt error export is missing from the installed package"
);
assert.equal(TOOL_MANIFEST.length, 46, "tool-manifest subpath returned the wrong inventory");
for (const [name, surface] of Object.entries({ Bases, Communities, EmbedDb, Fts5, Hnsw })) {
  assert.ok(Object.keys(surface).length > 0, name + " subpath exported no runtime surface");
}

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

function writeOptionalLoadabilityProbe(consumerDir, optionalProbes) {
  writeFileSync(
    path.join(consumerDir, "optional-loadability.mjs"),
    `import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const optionalProbes = ${JSON.stringify(optionalProbes)};
const nodeModulesRoot = path.resolve("node_modules");
for (const { packageName, specifier: importSpecifier, exportPaths, probeKind } of optionalProbes) {
  const resolved = import.meta.resolve(importSpecifier);
  assert.match(resolved, /^file:/, packageName + " did not resolve to an installed file");
  const expectedPackageRoot = path.join(nodeModulesRoot, ...packageName.split("/"));
  const relative = path.relative(expectedPackageRoot, fileURLToPath(resolved));
  assert.ok(relative.length > 0 && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep), packageName + " resolved outside its installed package root");
  const loaded = await import(importSpecifier);
  const capability = exportPaths
    .map((exportPath) => exportPath.reduce((value, key) => value?.[key], loaded))
    .find((value) => typeof value === "function");
  assert.equal(typeof capability, "function", packageName + " did not expose its reviewed runtime capability");
  if (probeKind === "sqlite-memory") {
    const database = new capability(":memory:");
    try {
      assert.equal(database.prepare("SELECT 1 AS ok").get().ok, 1, packageName + " native query probe failed");
    } finally {
      database.close();
    }
  }
}
`,
    "utf8"
  );
}

function verifyPackagedCli(consumerDir, packageRoot, expectedVersion, mode) {
  const spec = packageCliProcessSpec(consumerDir);
  const shimStat = lstatSync(spec.shim);
  assert.ok(
    shimStat.isFile() || shimStat.isSymbolicLink(),
    `${mode}: installed node_modules/.bin/enquire-mcp shim is missing`
  );
  if (process.platform !== "win32") {
    assert.equal(
      realpathSync(spec.shim),
      realpathSync(path.join(packageRoot, "dist", "index.js")),
      `${mode}: installed CLI shim does not target the packaged bin entrypoint`
    );
  }
  const version = run(spec.command, spec.args, { cwd: spec.cwd });
  assert.equal(version.trim(), expectedVersion, `${mode}: installed CLI shim returned the wrong version`);
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
  const optionalNames = Object.keys(rootPackage.optionalDependencies ?? {});
  assert.ok(optionalNames.length > 0, `${mode}: root package declares no optional dependency inventory to verify`);
  const optionalProbes = OPTIONAL_DEPENDENCY_PROBES;
  assert.deepEqual(
    optionalProbes.map(({ packageName }) => packageName).sort(),
    [...optionalNames].sort(),
    `${mode}: optional dependency probe inventory differs from package.json`
  );
  if (mode === "omit-optional") {
    for (const { packageName: optionalName } of optionalProbes) {
      assert.ok(
        !existsSync(path.join(consumerDir, "node_modules", ...optionalName.split("/"))),
        `${mode}: ${optionalName} was installed despite --omit=optional`
      );
    }
  } else {
    const loadableOptionalProbes = [];
    for (const optionalProbe of optionalProbes) {
      const optionalName = optionalProbe.packageName;
      const installed = existsSync(path.join(consumerDir, "node_modules", ...optionalName.split("/")));
      if (!installed) {
        assert.ok(
          optionalDependencyMayBeMissing(optionalProbe, process.platform),
          `${mode}: ${optionalName} is absent despite --include=optional`
        );
        continue;
      }
      loadableOptionalProbes.push(optionalProbe);
    }
    writeOptionalLoadabilityProbe(consumerDir, loadableOptionalProbes);
    run(process.execPath, [path.join(consumerDir, "optional-loadability.mjs")], { cwd: consumerDir });
  }
  assert.ok(
    !existsSync(path.join(consumerDir, "node_modules", "@modelcontextprotocol", "sdk")),
    `${mode}: consumer resolution retained the legacy @modelcontextprotocol/sdk package`
  );
  assertNoBuildPathLeak(packageRoot);
  assertNoLegacySdkSpecifiers(packageRoot);
  verifyPackagedCli(consumerDir, packageRoot, rootPackage.version, mode);
  writeConsumerSources(consumerDir);

  const tsc = path.join(ROOT, "node_modules", "typescript-native", "bin", "tsc");
  run(process.execPath, [tsc, "--project", path.join(consumerDir, "tsconfig.json")], { cwd: consumerDir });
  run(process.execPath, [path.join(consumerDir, "runtime.mjs")], {
    cwd: consumerDir,
    env: { ENQUIRE_CONSUMER_MODE: mode }
  });
  console.log(`[package-consumer] OK — ${process.platform}/${process.arch}/${mode}`);
}

/**
 * Parse the closed-world canonical-artifact arguments used by remote CI.
 * An empty argv retains the local developer convenience path; any non-empty
 * invocation must provide every exact provenance binding once.
 */
export function parsePackageConsumerArgs(argv) {
  if (!Array.isArray(argv)) throw new Error("package-consumer argv must be an array");
  if (argv.length === 0) return null;
  const expected = new Set(["--tarball", "--manifest", "--source-sha", "--run-id", "--run-attempt"]);
  if (argv.length !== expected.size * 2) {
    throw new Error("canonical consumer mode requires exactly tarball, manifest, source SHA, run id, and run attempt");
  }
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!expected.delete(flag) || typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
      throw new Error(`invalid or duplicate package-consumer argument ${String(flag)}`);
    }
    values[flag.slice(2).replaceAll("-", "_")] = value;
  }
  if (expected.size !== 0) throw new Error(`missing package-consumer arguments: ${[...expected].join(", ")}`);
  return Object.freeze({
    manifest: path.resolve(values.manifest),
    runAttempt: values.run_attempt,
    runId: values.run_id,
    sourceSha: values.source_sha,
    tarball: path.resolve(values.tarball)
  });
}

function assertSourcePackageGraph(rootPackage) {
  const rootLock = readFileSync(path.join(ROOT, "package-lock.json"), "utf8");
  assert.doesNotMatch(
    JSON.stringify(rootPackage),
    /@modelcontextprotocol\/sdk/,
    "source package.json retains the legacy MCP SDK dependency"
  );
  assert.doesNotMatch(rootLock, /@modelcontextprotocol\/sdk/, "source lockfile retains the legacy MCP SDK graph");
}

export function runPackageConsumer(argv = []) {
  const canonicalArtifact = parsePackageConsumerArgs(argv);
  const tempRoot = mkdtempSync(path.join(tmpdir(), "enquire-package-consumer-"));
  try {
    const rootPackage = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
    assertSourcePackageGraph(rootPackage);
    if (canonicalArtifact !== null) {
      for (const [label, artifactPath, maximumBytes] of [
        ["manifest", canonicalArtifact.manifest, 64 * 1024],
        ["tarball", canonicalArtifact.tarball, MAX_NPM_PACKAGE_TARBALL_BYTES]
      ]) {
        const stat = lstatSync(artifactPath);
        assert.ok(
          stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= maximumBytes,
          `canonical ${label} must be a bounded regular non-symlink file`
        );
      }
      const manifest = JSON.parse(readFileSync(canonicalArtifact.manifest, "utf8"));
      const tarballBytes = readFileSync(canonicalArtifact.tarball);
      verifyNpmPackageArtifactManifest(manifest, tarballBytes, rootPackage, {
        sourceSha: canonicalArtifact.sourceSha,
        runId: canonicalArtifact.runId,
        runAttempt: canonicalArtifact.runAttempt
      });
      verifyConsumer(canonicalArtifact.tarball, "full", rootPackage, tempRoot);
      verifyConsumer(canonicalArtifact.tarball, "omit-optional", rootPackage, tempRoot);
      return;
    }

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
    runPackageConsumer(process.argv.slice(2));
  } catch (error) {
    console.error(
      `[package-consumer] FAIL — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`
    );
    process.exitCode = 1;
  }
}
