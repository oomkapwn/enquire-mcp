#!/usr/bin/env node

// Build the Basic read-only MCPB on a disposable CI runner.
//
// The upstream 2.1.2 packer writes the current time into ZIP metadata, so the
// .mcpb byte stream is intentionally not described as reproducible. Instead we
// record a sorted SHA-256 inventory of every logical bundle file; release
// automation records the final artifact SHA separately.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  constants,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";
import sharp from "sharp";
import { isEntrypoint } from "./lib/entrypoint.mjs";
import {
  nativeBinaryReason,
  portableArchiveKey,
  portableArchivePath,
  resolveRequiredDependencyRefs
} from "./lib/mcpb-safety.mjs";

export const MCPB_PACKER_VERSION = "2.1.2";
export const MCPB_SPEC_COMMIT = "70fe3b34cd6dff1b3bba046638edc72a6467a4fb";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STAGE_PARENT = path.join(ROOT, ".mcpb-stage");
const STAGE = path.join(STAGE_PARENT, "basic");
const SERVER = path.join(STAGE, "server");
const ARTIFACTS = path.join(ROOT, "artifacts");
const STAGE_OWNER = path.join(STAGE_PARENT, ".enquire-mcpb-owned-v1");
const STAGE_OWNER_CONTENT = "enquire-mcp Basic staging root v1\n";
const DRAFT_ARTIFACT = path.join(STAGE_PARENT, "basic-draft.mcpb");
const OPTIONAL_DEPENDENCIES = [
  "@huggingface/transformers",
  "@napi-rs/canvas",
  "better-sqlite3",
  "hnswlib-node",
  "pdfjs-dist",
  "tesseract.js"
];
const OPTIONAL_DEPENDENCY_SET = new Set(OPTIONAL_DEPENDENCIES);

function run(command, args, cwd = ROOT) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: process.env,
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

function modulePath(root, name) {
  return path.join(root, "node_modules", ...name.split("/"));
}

function assertPlainDirectory(target, label) {
  const stat = lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} must be a real directory, not a symlink or special file: ${target}`);
  }
}

function assertPlainFile(target, label) {
  const stat = lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${label} must be a regular file, not a symlink or special file: ${target}`);
  }
  return stat;
}

function prepareOwnedStage() {
  const expected = path.resolve(ROOT, ".mcpb-stage", "basic");
  if (path.resolve(STAGE) !== expected || path.dirname(expected) !== path.resolve(STAGE_PARENT)) {
    throw new Error(`refusing unexpected MCPB staging target: ${STAGE}`);
  }
  if (existsSync(STAGE_PARENT)) {
    assertPlainDirectory(STAGE_PARENT, "MCPB staging parent");
    if (!existsSync(STAGE_OWNER)) {
      throw new Error(`refusing unowned staging parent: ${STAGE_PARENT}`);
    }
    assertPlainFile(STAGE_OWNER, "MCPB staging ownership marker");
    if (readFileSync(STAGE_OWNER, "utf8") !== STAGE_OWNER_CONTENT) {
      throw new Error(`refusing staging parent with an invalid ownership marker: ${STAGE_PARENT}`);
    }
  } else {
    mkdirSync(STAGE_PARENT, { recursive: false });
    writeFileSync(STAGE_OWNER, STAGE_OWNER_CONTENT, { encoding: "utf8", flag: "wx" });
  }
  if (existsSync(STAGE)) {
    throw new Error(`MCPB staging target already exists; refusing recursive cleanup: ${STAGE}`);
  }
  mkdirSync(SERVER, { recursive: true });
}

function prepareArtifactDirectory() {
  if (existsSync(ARTIFACTS)) assertPlainDirectory(ARTIFACTS, "MCPB artifact directory");
  else mkdirSync(ARTIFACTS, { recursive: false });
}

function assertOwnedOutputAbsent(target) {
  if (path.dirname(path.resolve(target)) !== path.resolve(ARTIFACTS)) {
    throw new Error(`refusing MCPB output outside the owned artifact directory: ${target}`);
  }
  if (existsSync(target)) {
    throw new Error(`MCPB output already exists; refusing overwrite: ${target}`);
  }
}

function assertOwnedStageFileAbsent(target) {
  if (path.dirname(path.resolve(target)) !== path.resolve(STAGE_PARENT)) {
    throw new Error(`refusing temporary MCPB output outside the owned staging parent: ${target}`);
  }
  if (existsSync(target)) {
    throw new Error(`temporary MCPB output already exists; refusing overwrite: ${target}`);
  }
}

function removeOwnedStageFile(target) {
  if (path.dirname(path.resolve(target)) !== path.resolve(STAGE_PARENT)) {
    throw new Error(`refusing temporary MCPB cleanup outside the owned staging parent: ${target}`);
  }
  const before = assertPlainFile(target, "temporary MCPB output");
  const identity = { dev: before.dev, ino: before.ino };
  const current = assertPlainFile(target, "temporary MCPB output");
  if (current.dev !== identity.dev || current.ino !== identity.ino) {
    throw new Error(`temporary MCPB output identity changed before cleanup: ${target}`);
  }
  rmSync(target, { force: false });
}

function collectFiles(root) {
  const files = [];
  const visit = (dir) => {
    for (const name of readdirSync(dir).sort((left, right) => left.localeCompare(right))) {
      const target = path.join(dir, name);
      const stat = lstatSync(target);
      if (stat.isSymbolicLink()) throw new Error(`MCPB staging refuses symlink: ${path.relative(root, target)}`);
      if (stat.isDirectory()) visit(target);
      else if (stat.isFile()) files.push(target);
      else throw new Error(`MCPB staging refuses special file: ${path.relative(root, target)}`);
    }
  };
  visit(root);
  return files;
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function inventoryPackedArchive(artifact) {
  const archive = unzipSync(readFileSync(artifact));
  const files = [];
  const seen = new Set();
  const portableNames = new Set();
  for (const [rawName, data] of Object.entries(archive)) {
    let name;
    try {
      name = portableArchivePath(rawName);
    } catch (error) {
      throw new Error(`official MCPB packer emitted non-portable archive path ${rawName}: ${String(error)}`);
    }
    if (seen.has(name)) throw new Error(`official MCPB packer emitted duplicate normalized path: ${name}`);
    const portableName = portableArchiveKey(name);
    if (portableNames.has(portableName)) {
      throw new Error(`official MCPB packer emitted case-colliding archive path: ${name}`);
    }
    seen.add(name);
    portableNames.add(portableName);
    const bytes = Buffer.from(data);
    files.push({ path: name, size: bytes.length, sha256: sha256(bytes) });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function declaredLicense(value) {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (Array.isArray(value)) {
    const parts = value.map(declaredLicense).filter((entry) => entry !== "NOASSERTION");
    if (parts.length > 0) return parts.join(" OR ");
  }
  if (value && typeof value === "object" && typeof value.type === "string" && value.type.trim().length > 0) {
    return value.type.trim();
  }
  return "NOASSERTION";
}

function packagePurl(name, version) {
  const encodedName = name.startsWith("@")
    ? `%40${encodeURIComponent(name.slice(1).split("/")[0] ?? "")}/${encodeURIComponent(name.split("/")[1] ?? "")}`
    : encodeURIComponent(name);
  return `pkg:npm/${encodedName}@${encodeURIComponent(version)}`;
}

function packageNoticeFiles(packageDir) {
  const result = [];
  for (const name of readdirSync(packageDir).sort((left, right) => left.localeCompare(right))) {
    if (!/^(?:licen[cs]e|copying|notice|copyright)(?:[._-].*)?$/i.test(name)) continue;
    const target = path.join(packageDir, name);
    const stat = lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`third-party notice must be a regular file: ${path.relative(STAGE, target)}`);
    }
    const data = readFileSync(target);
    result.push({
      path: path.relative(STAGE, target).replaceAll(path.sep, "/"),
      size: data.length,
      sha256: sha256(data)
    });
  }
  return result;
}

function scanInstalledPackages(nodeModulesDir) {
  const packages = [];
  const visitNodeModules = (modulesDir) => {
    if (!existsSync(modulesDir)) return;
    assertPlainDirectory(modulesDir, "installed node_modules");
    for (const name of readdirSync(modulesDir).sort((left, right) => left.localeCompare(right))) {
      if (name === ".bin") continue;
      const entry = path.join(modulesDir, name);
      const entryStat = lstatSync(entry);
      if (entryStat.isSymbolicLink() || !entryStat.isDirectory()) {
        throw new Error(`installed dependency entry must be a real directory: ${path.relative(STAGE, entry)}`);
      }
      const packageDirs = name.startsWith("@")
        ? readdirSync(entry)
            .sort((left, right) => left.localeCompare(right))
            .map((child) => path.join(entry, child))
        : [entry];
      for (const packageDir of packageDirs) {
        assertPlainDirectory(packageDir, "installed dependency package");
        const manifestPath = path.join(packageDir, "package.json");
        if (!existsSync(manifestPath)) {
          throw new Error(`installed dependency lacks package.json: ${path.relative(STAGE, packageDir)}`);
        }
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        if (typeof manifest.name !== "string" || typeof manifest.version !== "string") {
          throw new Error(`installed dependency has invalid identity: ${path.relative(STAGE, manifestPath)}`);
        }
        if (OPTIONAL_DEPENDENCY_SET.has(manifest.name)) {
          throw new Error(`optional dependency leaked into Basic MCPB dependency tree: ${manifest.name}`);
        }
        const notices = packageNoticeFiles(packageDir);
        const license = declaredLicense(manifest.license ?? manifest.licenses);
        if (license === "NOASSERTION" && notices.length === 0) {
          throw new Error(
            `dependency has neither declared license nor bundled notice: ${manifest.name}@${manifest.version}`
          );
        }
        packages.push({ directory: packageDir, manifest, license, notices });
        visitNodeModules(path.join(packageDir, "node_modules"));
      }
    }
  };
  visitNodeModules(nodeModulesDir);
  return packages;
}

function resolveInstalledDependency(fromDir, dependency, installedByDirectory) {
  let cursor = path.resolve(fromDir);
  const serverRoot = path.resolve(SERVER);
  while (cursor === serverRoot || cursor.startsWith(`${serverRoot}${path.sep}`)) {
    const candidate = path.join(cursor, "node_modules", ...dependency.split("/"));
    const record = installedByDirectory.get(path.resolve(candidate));
    if (record) return packagePurl(record.manifest.name, record.manifest.version);
    if (cursor === serverRoot) break;
    cursor = path.dirname(cursor);
  }
  return null;
}

function writeTransparencyArtifacts(runtimePackage) {
  const installed = scanInstalledPackages(path.join(SERVER, "node_modules"));
  const installedByDirectory = new Map(installed.map((entry) => [path.resolve(entry.directory), entry]));
  const grouped = new Map();
  for (const entry of installed) {
    const ref = packagePurl(entry.manifest.name, entry.manifest.version);
    const current = grouped.get(ref) ?? {
      ref,
      name: entry.manifest.name,
      version: entry.manifest.version,
      licenses: new Set(),
      locations: [],
      notices: [],
      dependsOn: new Set()
    };
    current.licenses.add(entry.license);
    current.locations.push(path.relative(STAGE, entry.directory).replaceAll(path.sep, "/"));
    current.notices.push(...entry.notices);
    const requiredRefs = resolveRequiredDependencyRefs(entry.manifest, (dependency) =>
      resolveInstalledDependency(entry.directory, dependency, installedByDirectory)
    );
    for (const ref of requiredRefs) current.dependsOn.add(ref);
    for (const dependency of Object.keys({
      ...(entry.manifest.optionalDependencies ?? {}),
      ...(entry.manifest.peerDependencies ?? {})
    }).sort()) {
      const resolved = resolveInstalledDependency(entry.directory, dependency, installedByDirectory);
      if (resolved) current.dependsOn.add(resolved);
    }
    grouped.set(ref, current);
  }

  const rootRef = `urn:enquire-mcpb-basic:${runtimePackage.version}`;
  const directRefs = Object.keys(runtimePackage.dependencies ?? {})
    .map((dependency) => resolveInstalledDependency(SERVER, dependency, installedByDirectory))
    .filter((ref) => ref !== null)
    .sort();
  if (directRefs.length !== Object.keys(runtimePackage.dependencies ?? {}).length) {
    throw new Error("MCPB SBOM could not resolve every direct runtime dependency");
  }

  const packageRows = [...grouped.values()].sort((left, right) => left.ref.localeCompare(right.ref));
  const rootHash = sha256(Buffer.from(rootRef));
  const sbom = {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber:
      `urn:uuid:${rootHash.slice(0, 8)}-${rootHash.slice(8, 12)}-` +
      `4${rootHash.slice(13, 16)}-8${rootHash.slice(17, 20)}-${rootHash.slice(20, 32)}`,
    version: 1,
    metadata: {
      component: {
        type: "application",
        "bom-ref": rootRef,
        name: "enquire-mcp-basic",
        version: runtimePackage.version
      },
      properties: [
        { name: "enquire:mcpb:spec-commit", value: MCPB_SPEC_COMMIT },
        { name: "enquire:mcpb:packer", value: `@anthropic-ai/mcpb@${MCPB_PACKER_VERSION}` }
      ]
    },
    components: packageRows.map((entry) => ({
      type: "library",
      "bom-ref": entry.ref,
      name: entry.name,
      version: entry.version,
      purl: entry.ref,
      licenses: [...entry.licenses].sort().map((expression) => ({ expression })),
      properties: [
        {
          name: "enquire:mcpb:install-paths",
          value: [...new Set(entry.locations)].sort().join("\n")
        }
      ]
    })),
    dependencies: [
      { ref: rootRef, dependsOn: [...new Set(directRefs)] },
      ...packageRows.map((entry) => ({ ref: entry.ref, dependsOn: [...entry.dependsOn].sort() }))
    ]
  };
  const licenses = {
    format: 1,
    package: `enquire-mcp-basic@${runtimePackage.version}`,
    scope: "all installed production dependencies in the MCPB server runtime",
    packages: packageRows.map((entry) => {
      const files = [...new Map(entry.notices.map((notice) => [notice.path, notice])).values()].sort((left, right) =>
        left.path.localeCompare(right.path)
      );
      return {
        name: entry.name,
        version: entry.version,
        purl: entry.ref,
        direct: Object.hasOwn(runtimePackage.dependencies ?? {}, entry.name),
        declared_license: [...entry.licenses].sort().join(" OR "),
        locations: [...new Set(entry.locations)].sort(),
        license_files: files.filter((file) => /(?:licen[cs]e|copying|copyright)/i.test(path.basename(file.path))),
        notice_files: files.filter((file) => /notice/i.test(path.basename(file.path)))
      };
    })
  };
  writeFileSync(path.join(STAGE, "sbom.cdx.json"), `${JSON.stringify(sbom, null, 2)}\n`, "utf8");
  writeFileSync(path.join(STAGE, "third-party-licenses.json"), `${JSON.stringify(licenses, null, 2)}\n`, "utf8");
}

export async function buildBasicMcpb() {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const manifestSource = JSON.parse(readFileSync(path.join(ROOT, "mcpb", "manifest.json"), "utf8"));
  if (manifestSource.version !== pkg.version) {
    throw new Error(`mcpb/manifest.json version ${manifestSource.version} differs from package ${pkg.version}`);
  }
  if (!existsSync(path.join(ROOT, "dist", "index.js"))) {
    throw new Error("dist/index.js is missing; build the TypeScript project on the CI runner first");
  }

  prepareOwnedStage();
  prepareArtifactDirectory();
  cpSync(path.join(ROOT, "dist"), path.join(SERVER, "dist"), { recursive: true, dereference: false });
  cpSync(path.join(ROOT, "package.json"), path.join(SERVER, "package.json"));
  cpSync(path.join(ROOT, "package-lock.json"), path.join(SERVER, "package-lock.json"));
  cpSync(path.join(ROOT, "LICENSE"), path.join(STAGE, "LICENSE"));
  writeFileSync(path.join(STAGE, "manifest.json"), `${JSON.stringify(manifestSource, null, 2)}\n`, "utf8");

  // Install the exact production graph from the repository lock, without the
  // heavy/native optional set or any lifecycle script. This runs only on CI.
  const npm = npmProcessSpec();
  run(
    npm.command,
    [
      ...npm.argsPrefix,
      "ci",
      "--omit=dev",
      "--omit=optional",
      "--ignore-scripts",
      "--no-bin-links",
      "--no-audit",
      "--no-fund"
    ],
    SERVER
  );

  for (const dependency of OPTIONAL_DEPENDENCIES) {
    if (existsSync(modulePath(SERVER, dependency))) {
      throw new Error(`optional dependency leaked into Basic MCPB: ${dependency}`);
    }
  }

  // Keep runtime metadata honest: the artifact contains only production deps,
  // no install hooks, no optional/native declarations, and no dev graph.
  const runtimePackage = {
    name: "@oomkapwn/enquire-mcp-mcpb-basic-runtime",
    version: pkg.version,
    private: true,
    type: "module",
    engines: pkg.engines,
    dependencies: pkg.dependencies,
    overrides: {
      "@hono/node-server": pkg.overrides?.["@hono/node-server"],
      hono: pkg.overrides?.hono
    }
  };
  if (Object.values(runtimePackage.overrides).some((value) => typeof value !== "string" || value.length === 0)) {
    throw new Error("Basic MCPB runtime requires the narrow hono security overrides from package.json");
  }
  writeFileSync(path.join(SERVER, "package.json"), `${JSON.stringify(runtimePackage, null, 2)}\n`, "utf8");
  rmSync(path.join(SERVER, "package-lock.json"), { force: true });
  rmSync(path.join(SERVER, "node_modules", ".package-lock.json"), { force: true });
  writeTransparencyArtifacts(runtimePackage);

  // Render a square brand icon remotely. The source stays inspectable SVG;
  // the official v0.3 validator requires the bundled icon itself to be PNG.
  await sharp(path.join(ROOT, "mcpb", "icon.svg"))
    .resize(512, 512)
    .png()
    .toFile(path.join(STAGE, "icon.png"));

  // Safety-walk the complete source tree, but derive the logical inventory
  // from a first official-pack pass. mcpb 2.1.2 intentionally excludes files
  // such as node_modules/.bin, *.map, and *.d.ts; inventorying the raw stage
  // would therefore describe bytes that the actual bundle does not contain.
  const stagedFiles = collectFiles(STAGE);
  for (const file of stagedFiles) {
    const relative = path.relative(STAGE, file).replaceAll(path.sep, "/");
    const binaryReason = nativeBinaryReason(relative, readFileSync(file));
    if (binaryReason) {
      throw new Error(`native executable leaked into Basic MCPB: ${relative} (${binaryReason})`);
    }
  }
  const packerCli = path.join(ROOT, "node_modules", "@anthropic-ai", "mcpb", "dist", "cli", "cli.js");
  if (!existsSync(packerCli)) throw new Error(`pinned MCPB packer is missing: ${packerCli}`);
  run(process.execPath, [packerCli, "validate", STAGE]);
  assertOwnedStageFileAbsent(DRAFT_ARTIFACT);
  let inventory;
  try {
    run(process.execPath, [packerCli, "pack", STAGE, DRAFT_ARTIFACT]);
    inventory = inventoryPackedArchive(DRAFT_ARTIFACT);
  } finally {
    if (existsSync(DRAFT_ARTIFACT)) removeOwnedStageFile(DRAFT_ARTIFACT);
  }
  writeFileSync(
    path.join(STAGE, "content-manifest.json"),
    `${JSON.stringify(
      {
        format: 1,
        package: `enquire-mcp-basic@${pkg.version}`,
        mcpb_spec_commit: MCPB_SPEC_COMMIT,
        packer: `@anthropic-ai/mcpb@${MCPB_PACKER_VERSION}`,
        reproducibility: "deterministic-content-inventory; archive bytes include upstream pack-time mtime",
        files: inventory
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  run(process.execPath, [packerCli, "validate", STAGE]);

  const artifact = path.join(ARTIFACTS, `enquire-mcp-basic-${pkg.version}.mcpb`);
  const contentArtifact = path.join(ARTIFACTS, `enquire-mcp-basic-${pkg.version}.content-manifest.json`);
  const sbomArtifact = path.join(ARTIFACTS, `enquire-mcp-basic-${pkg.version}.sbom.cdx.json`);
  const licensesArtifact = path.join(ARTIFACTS, `enquire-mcp-basic-${pkg.version}.third-party-licenses.json`);
  for (const output of [artifact, contentArtifact, sbomArtifact, licensesArtifact]) assertOwnedOutputAbsent(output);
  run(process.execPath, [packerCli, "pack", STAGE, artifact]);
  copyFileSync(path.join(STAGE, "content-manifest.json"), contentArtifact, constants.COPYFILE_EXCL);
  copyFileSync(path.join(STAGE, "sbom.cdx.json"), sbomArtifact, constants.COPYFILE_EXCL);
  copyFileSync(path.join(STAGE, "third-party-licenses.json"), licensesArtifact, constants.COPYFILE_EXCL);
  const artifactBytes = readFileSync(artifact);
  const result = {
    artifact,
    artifact_sha256: sha256(artifactBytes),
    artifact_size: artifactBytes.length,
    content_manifest: contentArtifact,
    sbom: sbomArtifact,
    third_party_licenses: licensesArtifact
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (isEntrypoint(import.meta.url)) {
  await buildBasicMcpb();
}
