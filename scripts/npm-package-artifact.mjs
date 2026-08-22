#!/usr/bin/env node
// Canonical npm-package artifact receipt shared by CI consumers and release.
// The receipt binds one tarball byte string to one exact source workflow run.

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { isEntrypoint } from "./lib/entrypoint.mjs";

export const NPM_PACKAGE_ARTIFACT_SCHEMA = "https://oomkapwn.github.io/enquire-mcp/npm-package-artifact.v1";
export const NPM_PACKAGE_ARTIFACT_TARBALL = "enquire-mcp-npm.tgz";
export const NPM_PACKAGE_ARTIFACT_MANIFEST = "npm-package-manifest.json";
export const MAX_NPM_PACKAGE_TARBALL_BYTES = 64 * 1024 * 1024;
export const MAX_NPM_PACKAGE_UNPACKED_BYTES = 128 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_PACK_METADATA_BYTES = 8 * 1024 * 1024;
const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;
const PACKAGE_NAME = "@oomkapwn/enquire-mcp";
const CI_WORKFLOW_PATH = ".github/workflows/ci.yml";
const TAR_BLOCK_BYTES = 512;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactRecord(value, keys, label) {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} must contain exactly ${expected.join(", ")}`);
  }
  return value;
}

function canonicalPositiveDecimal(value, label) {
  if (typeof value !== "string" || !/^[1-9]\d*$/u.test(value)) {
    throw new Error(`${label} must be one canonical positive decimal string`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || String(parsed) !== value) {
    throw new Error(`${label} must be one canonical positive safe-integer string`);
  }
  return value;
}

function exactSourceSha(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/u.test(value)) {
    throw new Error(`${label} must be one exact lowercase SHA-1`);
  }
  return value;
}

function canonicalSha256(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`${label} must be one exact lowercase SHA-256`);
  }
  return value;
}

function canonicalSha512Sri(value, label) {
  if (typeof value !== "string" || !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(value)) {
    throw new Error(`${label} must be one canonical SHA-512 SRI`);
  }
  const encoded = value.slice("sha512-".length);
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.length !== 64 || decoded.toString("base64") !== encoded) {
    throw new Error(`${label} must be one canonical SHA-512 SRI`);
  }
  return value;
}

function portableRelativePath(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^(?:[A-Za-z]:|\\\\)/u.test(value)
  ) {
    throw new Error(`${label} must be one portable relative path`);
  }
  const parts = value.split("/");
  if (value.normalize("NFC") !== value || parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new Error(`${label} must be one normalized portable relative path`);
  }
  return value;
}

function portablePathKey(value) {
  return value.normalize("NFC").toLowerCase();
}

function tarHeaderString(header, start, length, label) {
  const field = header.subarray(start, start + length);
  const nul = field.indexOf(0);
  const bytes = field.subarray(0, nul < 0 ? field.length : nul);
  const value = bytes.toString("utf8");
  if (!Buffer.from(value, "utf8").equals(bytes)) throw new Error(`${label} must contain canonical UTF-8`);
  return value;
}

function tarHeaderOctal(header, start, length, label) {
  const raw = header.subarray(start, start + length);
  if ((raw[0] ?? 0) >= 0x80) throw new Error(`${label} uses unsupported base-256 encoding`);
  const value = raw.toString("ascii").replace(/\0.*$/u, "").trim();
  if (!/^[0-7]+$/u.test(value)) throw new Error(`${label} must be one canonical octal integer`);
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} exceeds safe integer bounds`);
  return parsed;
}

function assertTarHeaderChecksum(header, entryIndex) {
  const expected = tarHeaderOctal(header, 148, 8, `tar entry ${entryIndex} checksum`);
  let actual = 0;
  for (let index = 0; index < header.length; index++) {
    actual += index >= 148 && index < 156 ? 0x20 : (header[index] ?? 0);
  }
  if (actual !== expected) throw new Error(`tar entry ${entryIndex} header checksum differs`);
}

function parsePaxPath(payload, entryIndex) {
  let offset = 0;
  let path = null;
  while (offset < payload.length) {
    const space = payload.indexOf(0x20, offset);
    if (space < 0) throw new Error(`tar PAX entry ${entryIndex} has no record length delimiter`);
    const lengthText = payload.subarray(offset, space).toString("ascii");
    if (!/^[1-9]\d*$/u.test(lengthText)) throw new Error(`tar PAX entry ${entryIndex} has invalid length`);
    const length = Number(lengthText);
    if (!Number.isSafeInteger(length) || length <= space - offset + 2 || offset + length > payload.length) {
      throw new Error(`tar PAX entry ${entryIndex} exceeds its payload`);
    }
    const record = payload.subarray(space + 1, offset + length);
    if (record.at(-1) !== 0x0a) throw new Error(`tar PAX entry ${entryIndex} record lacks LF termination`);
    const equals = record.indexOf(0x3d);
    if (equals <= 0) throw new Error(`tar PAX entry ${entryIndex} record has no key/value delimiter`);
    const keyBytes = record.subarray(0, equals);
    if (!keyBytes.equals(Buffer.from("path", "ascii"))) {
      throw new Error(`tar PAX entry ${entryIndex} may contain only one canonical path record`);
    }
    if (path !== null) throw new Error(`tar PAX entry ${entryIndex} repeats path`);
    const bytes = record.subarray(equals + 1, -1);
    path = bytes.toString("utf8");
    if (!Buffer.from(path, "utf8").equals(bytes)) {
      throw new Error(`tar PAX entry ${entryIndex} path must contain canonical UTF-8`);
    }
    offset += length;
  }
  if (path === null) throw new Error(`tar PAX entry ${entryIndex} must contain exactly one canonical path record`);
  return path;
}

function archiveRelativePath(archivePath, type, entryIndex) {
  if (!archivePath.startsWith("package/")) {
    throw new Error(`tar entry ${entryIndex} is outside the canonical package/ root: ${archivePath}`);
  }
  let relative = archivePath.slice("package/".length);
  if (type === "5") relative = relative.replace(/\/$/u, "");
  if (relative.length === 0 && type === "5") return null;
  return portableRelativePath(relative, `tar entry ${entryIndex} path`);
}

function canonicalInventory(value, label) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must list emitted files`);
  const seen = new Set();
  const inventory = value.map((candidate, index) => {
    const entry = exactRecord(candidate, ["path", "size", "mode"], `${label}[${index}]`);
    const path = portableRelativePath(entry.path, `${label}[${index}].path`).replace(/^\.\//u, "");
    if (seen.has(path)) throw new Error(`${label} contains duplicate path ${path}`);
    seen.add(path);
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
      throw new Error(`${label}[${index}].size must be a non-negative safe integer`);
    }
    if (!Number.isSafeInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o7777) {
      throw new Error(`${label}[${index}].mode must be a bounded non-negative integer`);
    }
    return { path, size: entry.size, mode: entry.mode };
  });
  const sorted = inventory.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  assertUnambiguousTarTree(sorted, [], label);
  return sorted;
}

function assertUnambiguousTarTree(files, directories, label) {
  const nodes = new Map();
  for (const [type, paths] of [
    ["file", files.map((entry) => entry.path)],
    ["directory", directories]
  ]) {
    for (const path of paths) {
      const key = portablePathKey(path);
      const previous = nodes.get(key);
      if (previous !== undefined) {
        throw new Error(`${label} contains ambiguous normalized entries ${previous.path} and ${path}`);
      }
      nodes.set(key, { path, type });
    }
  }
  const fileKeys = new Set(files.map((entry) => portablePathKey(entry.path)));
  for (const { path } of nodes.values()) {
    const segments = portablePathKey(path).split("/");
    for (let length = 1; length < segments.length; length++) {
      const ancestor = segments.slice(0, length).join("/");
      if (fileKeys.has(ancestor)) {
        const ancestorPath = nodes.get(ancestor)?.path ?? ancestor;
        throw new Error(`${label} uses file ${ancestorPath} as an ancestor of ${path}`);
      }
    }
  }
}

function inspectNpmTarEntries(tarballBytes) {
  tarballReceipt(tarballBytes);
  let archive;
  try {
    archive = gunzipSync(tarballBytes, { maxOutputLength: MAX_NPM_PACKAGE_UNPACKED_BYTES });
  } catch {
    throw new Error("npm tarball must be one bounded valid gzip stream");
  }
  if (archive.length === 0 || archive.length % TAR_BLOCK_BYTES !== 0) {
    throw new Error("npm tarball must contain one block-aligned tar archive");
  }
  const files = [];
  const directories = [];
  let entryIndex = 0;
  let offset = 0;
  let pendingPath = null;
  let zeroBlocks = 0;
  while (offset < archive.length) {
    const header = archive.subarray(offset, offset + TAR_BLOCK_BYTES);
    if (header.every((byte) => byte === 0)) {
      zeroBlocks++;
      offset += TAR_BLOCK_BYTES;
      if (zeroBlocks === 2) {
        if (!archive.subarray(offset).every((byte) => byte === 0)) {
          throw new Error("npm tarball contains data after its end-of-archive marker");
        }
        break;
      }
      continue;
    }
    if (zeroBlocks !== 0) throw new Error("npm tarball contains a partial end-of-archive marker");
    entryIndex++;
    assertTarHeaderChecksum(header, entryIndex);
    const name = tarHeaderString(header, 0, 100, `tar entry ${entryIndex} name`);
    const prefix = tarHeaderString(header, 345, 155, `tar entry ${entryIndex} prefix`);
    const headerPath = prefix.length > 0 ? `${prefix}/${name}` : name;
    const mode = tarHeaderOctal(header, 100, 8, `tar entry ${entryIndex} mode`);
    const size = tarHeaderOctal(header, 124, 12, `tar entry ${entryIndex} size`);
    const typeByte = header[156] ?? 0;
    const type = typeByte === 0 ? "0" : String.fromCharCode(typeByte);
    const payloadStart = offset + TAR_BLOCK_BYTES;
    const payloadEnd = payloadStart + size;
    const nextOffset = payloadStart + Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
    if (payloadEnd > archive.length || nextOffset > archive.length) {
      throw new Error(`tar entry ${entryIndex} exceeds the bounded archive`);
    }
    const payload = archive.subarray(payloadStart, payloadEnd);
    if (type === "x") {
      if (pendingPath !== null) throw new Error(`tar entry ${entryIndex} repeats a pending path override`);
      const paxPath = parsePaxPath(payload, entryIndex);
      pendingPath = paxPath;
    } else if (type === "L") {
      if (pendingPath !== null) throw new Error(`tar entry ${entryIndex} repeats a pending path override`);
      const nul = payload.indexOf(0);
      if (nul <= 0 || nul !== payload.length - 1) {
        throw new Error(`tar entry ${entryIndex} long path must have one terminal NUL`);
      }
      const bytes = payload.subarray(0, nul);
      pendingPath = bytes.toString("utf8");
      if (!Buffer.from(pendingPath, "utf8").equals(bytes)) {
        throw new Error(`tar entry ${entryIndex} long path must contain canonical UTF-8`);
      }
    } else {
      if (type !== "0" && type !== "5") {
        throw new Error(`tar entry ${entryIndex} uses forbidden type ${JSON.stringify(type)}`);
      }
      if (type === "5" && size !== 0) {
        throw new Error(`tar directory entry ${entryIndex} must have an empty payload`);
      }
      const relative = archiveRelativePath(pendingPath ?? headerPath, type, entryIndex);
      pendingPath = null;
      if (type === "0") files.push({ path: relative, size, mode });
      else if (relative !== null) directories.push(relative);
    }
    offset = nextOffset;
  }
  if (zeroBlocks < 2) throw new Error("npm tarball lacks its two-block end-of-archive marker");
  if (pendingPath !== null) throw new Error("npm tarball ends with an unused path override");
  const fileInventory = canonicalInventory(files, "npm tarball inventory");
  const directoryInventory = [...new Set(directories)].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0
  );
  if (directoryInventory.length !== directories.length) {
    throw new Error("npm tarball inventory contains duplicate directory entries");
  }
  assertUnambiguousTarTree(fileInventory, directoryInventory, "npm tarball inventory");
  return { directories: directoryInventory, files: fileInventory };
}

/**
 * Parse the exact regular-file inventory carried by one npm `.tgz` archive.
 * This intentionally accepts only the tar entry kinds npm packages need and
 * rejects links, devices, duplicate paths, malformed checksums, and extra roots.
 *
 * @param {Buffer} tarballBytes Exact gzip-compressed npm tarball bytes.
 * @returns {Array<{path:string,size:number,mode:number}>} Canonical sorted file inventory.
 */
export function inspectNpmTarballInventory(tarballBytes) {
  return inspectNpmTarEntries(tarballBytes).files;
}

function packageMetadata(packageJson) {
  const pkg = exactRecord(packageJson, Object.keys(packageJson ?? {}), "source package metadata");
  if (pkg.name !== PACKAGE_NAME || typeof pkg.version !== "string" || pkg.version.length === 0) {
    throw new Error(`source package identity must be ${PACKAGE_NAME}@<version>`);
  }
  if (!Array.isArray(pkg.files) || pkg.files.length === 0) {
    throw new Error("source package must declare a non-empty files allowlist");
  }
  const allowlist = pkg.files.map((entry, index) => portableRelativePath(entry, `package files[${index}]`));
  return { allowlist, name: pkg.name, version: pkg.version };
}

function assertPackedFileAllowlist(files, allowlist) {
  const inventory = canonicalInventory(files, "npm pack files");
  const seen = new Set(inventory.map((entry) => entry.path));
  for (const entry of inventory) {
    const candidate = entry.path;
    if (
      candidate !== "package.json" &&
      !allowlist.some((allowed) => candidate === allowed || candidate.startsWith(`${allowed}/`))
    ) {
      throw new Error(`npm tarball path is outside package.json files allowlist: ${candidate}`);
    }
  }
  for (const required of ["package.json", "dist/index.js"]) {
    if (!seen.has(required)) throw new Error(`npm tarball is missing required path ${required}`);
  }
  return inventory;
}

function assertActualTarballInventory(tarballBytes, expectedInventory, allowlist) {
  const tarEntries = inspectNpmTarEntries(tarballBytes);
  const actualInventory = tarEntries.files;
  for (const directory of tarEntries.directories) {
    if (
      !allowlist.some(
        (allowed) => directory === allowed || directory.startsWith(`${allowed}/`) || allowed.startsWith(`${directory}/`)
      )
    ) {
      throw new Error(`npm tarball directory is outside package.json files allowlist: ${directory}`);
    }
  }
  assertPackedFileAllowlist(actualInventory, allowlist);
  if (JSON.stringify(actualInventory) !== JSON.stringify(expectedInventory)) {
    throw new Error("actual npm tarball inventory differs from declared file metadata");
  }
  return actualInventory;
}

function tarballReceipt(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new Error("npm tarball must contain non-empty bytes");
  if (bytes.length > MAX_NPM_PACKAGE_TARBALL_BYTES) {
    throw new Error(`npm tarball exceeds ${MAX_NPM_PACKAGE_TARBALL_BYTES} bytes`);
  }
  return {
    bytes: bytes.length,
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    sha256: createHash("sha256").update(bytes).digest("hex")
  };
}

/**
 * Build the canonical receipt for one npm-pack result and tarball byte string.
 *
 * @param {unknown} packJson Parsed stdout from `npm pack --json`.
 * @param {Buffer} tarballBytes Exact bytes emitted by npm pack.
 * @param {unknown} packageJson Parsed source package.json.
 * @param {{sourceSha:string,runId:string,runAttempt:string}} context Exact CI identity.
 * @returns {Record<string, unknown>} Canonical manifest object.
 */
export function createNpmPackageArtifactManifest(packJson, tarballBytes, packageJson, context) {
  if (!Array.isArray(packJson) || packJson.length !== 1) {
    throw new Error("npm pack must return exactly one metadata record");
  }
  const packed = exactRecord(
    packJson[0],
    [
      "id",
      "name",
      "version",
      "size",
      "unpackedSize",
      "shasum",
      "integrity",
      "filename",
      "files",
      "entryCount",
      "bundled"
    ],
    "npm pack metadata"
  );
  const source = packageMetadata(packageJson);
  if (packed.name !== source.name || packed.version !== source.version) {
    throw new Error("npm pack metadata differs from source package identity");
  }
  if (typeof packed.filename !== "string" || basename(packed.filename) !== packed.filename) {
    throw new Error("npm pack filename must be one basename");
  }
  if (!Number.isSafeInteger(packed.size) || packed.size <= 0 || packed.size !== tarballBytes.length) {
    throw new Error("npm pack metadata size differs from tarball bytes");
  }
  const declaredInventory = assertPackedFileAllowlist(packed.files, source.allowlist);
  if (packed.entryCount !== declaredInventory.length) {
    throw new Error("npm pack entry count differs from declared file metadata");
  }
  if (
    !Number.isSafeInteger(packed.unpackedSize) ||
    packed.unpackedSize < 0 ||
    packed.unpackedSize !== declaredInventory.reduce((total, entry) => total + entry.size, 0)
  ) {
    throw new Error("npm pack unpacked size differs from declared file metadata");
  }
  const inventory = assertActualTarballInventory(tarballBytes, declaredInventory, source.allowlist);
  const receipt = tarballReceipt(tarballBytes);
  if (canonicalSha512Sri(packed.integrity, "npm pack integrity") !== receipt.integrity) {
    throw new Error("npm pack integrity differs from tarball bytes");
  }
  const sourceSha = exactSourceSha(context?.sourceSha, "artifact source SHA");
  const runId = canonicalPositiveDecimal(context?.runId, "artifact run id");
  const runAttempt = canonicalPositiveDecimal(context?.runAttempt, "artifact run attempt");
  return {
    schema: NPM_PACKAGE_ARTIFACT_SCHEMA,
    package: { name: source.name, version: source.version },
    source: { sha: sourceSha, workflow: CI_WORKFLOW_PATH, run_id: runId, run_attempt: runAttempt },
    tarball: { name: NPM_PACKAGE_ARTIFACT_TARBALL, ...receipt },
    files: inventory
  };
}

/**
 * Verify a canonical npm-package artifact before consumer install or publish.
 *
 * @param {unknown} manifest Parsed artifact manifest.
 * @param {Buffer} tarballBytes Exact downloaded tarball bytes.
 * @param {unknown} packageJson Parsed checkout package.json.
 * @param {{sourceSha:string,runId:string,runAttempt:string}} expected Trusted workflow identity.
 * @returns {{bytes:number,integrity:string,sha256:string,name:string,version:string}} Verified identity.
 */
export function verifyNpmPackageArtifactManifest(manifest, tarballBytes, packageJson, expected) {
  const root = exactRecord(manifest, ["schema", "package", "source", "tarball", "files"], "npm artifact manifest");
  if (root.schema !== NPM_PACKAGE_ARTIFACT_SCHEMA) throw new Error("npm artifact manifest schema is unsupported");
  const sourcePackage = packageMetadata(packageJson);
  const pkg = exactRecord(root.package, ["name", "version"], "npm artifact package");
  if (pkg.name !== sourcePackage.name || pkg.version !== sourcePackage.version) {
    throw new Error("npm artifact package identity differs from checkout");
  }
  const source = exactRecord(root.source, ["sha", "workflow", "run_id", "run_attempt"], "npm artifact source");
  if (source.workflow !== CI_WORKFLOW_PATH) throw new Error("npm artifact source workflow is not ci.yml");
  if (
    exactSourceSha(source.sha, "npm artifact source SHA") !== exactSourceSha(expected?.sourceSha, "expected source SHA")
  ) {
    throw new Error("npm artifact source SHA differs from expected release source");
  }
  if (
    canonicalPositiveDecimal(source.run_id, "npm artifact run id") !==
    canonicalPositiveDecimal(expected?.runId, "expected run id")
  ) {
    throw new Error("npm artifact run id differs from selected CI run");
  }
  if (
    canonicalPositiveDecimal(source.run_attempt, "npm artifact run attempt") !==
    canonicalPositiveDecimal(expected?.runAttempt, "expected run attempt")
  ) {
    throw new Error("npm artifact run attempt differs from selected producer attempt");
  }
  const tarball = exactRecord(root.tarball, ["name", "bytes", "integrity", "sha256"], "npm artifact tarball");
  if (tarball.name !== NPM_PACKAGE_ARTIFACT_TARBALL) throw new Error("npm artifact tarball name is not canonical");
  if (!Number.isSafeInteger(tarball.bytes) || tarball.bytes <= 0) {
    throw new Error("npm artifact tarball byte count must be a positive safe integer");
  }
  const receipt = tarballReceipt(tarballBytes);
  if (tarball.bytes !== receipt.bytes) throw new Error("npm artifact tarball byte count differs from bytes");
  if (canonicalSha256(tarball.sha256, "npm artifact SHA-256") !== receipt.sha256) {
    throw new Error("npm artifact SHA-256 differs from tarball bytes");
  }
  if (canonicalSha512Sri(tarball.integrity, "npm artifact integrity") !== receipt.integrity) {
    throw new Error("npm artifact SHA-512 integrity differs from tarball bytes");
  }
  const manifestInventory = assertPackedFileAllowlist(root.files, sourcePackage.allowlist);
  const inventory = assertActualTarballInventory(tarballBytes, manifestInventory, sourcePackage.allowlist);
  return { ...receipt, files: inventory, name: pkg.name, version: pkg.version };
}

function regularFileBytes(path, label, maximumBytes) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
  if (!Number.isSafeInteger(stat.size) || stat.size <= 0 || stat.size > maximumBytes) {
    throw new Error(`${label} must contain 1..${maximumBytes} bytes`);
  }
  return readFileSync(path);
}

function readJsonFile(path, label, maximumBytes) {
  let value;
  try {
    value = JSON.parse(regularFileBytes(path, label, maximumBytes).toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label} must contain valid JSON`);
    throw error;
  }
  return value;
}

function usage() {
  return [
    "Usage: npm-package-artifact.mjs",
    "create <pack-json> <tarball> <manifest> <source-sha> <run-id> <run-attempt> |",
    "verify <manifest> <tarball> <source-sha> <run-id> <run-attempt>"
  ].join(" ");
}

if (isEntrypoint(import.meta.url)) {
  try {
    const [mode, ...args] = process.argv.slice(2);
    const packageJson = readJsonFile(resolve("package.json"), "source package.json", MAX_PACKAGE_JSON_BYTES);
    if (mode === "create" && args.length === 6) {
      const [packPath, tarballPath, manifestPath, sourceSha, runId, runAttempt] = args;
      const manifest = createNpmPackageArtifactManifest(
        readJsonFile(resolve(packPath), "npm pack metadata", MAX_PACK_METADATA_BYTES),
        regularFileBytes(resolve(tarballPath), "npm tarball", MAX_NPM_PACKAGE_TARBALL_BYTES),
        packageJson,
        { sourceSha, runId, runAttempt }
      );
      writeFileSync(resolve(manifestPath), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
      console.log(JSON.stringify(manifest));
    } else if (mode === "verify" && args.length === 5) {
      const [manifestPath, tarballPath, sourceSha, runId, runAttempt] = args;
      console.log(
        JSON.stringify(
          verifyNpmPackageArtifactManifest(
            readJsonFile(resolve(manifestPath), "npm artifact manifest", MAX_MANIFEST_BYTES),
            regularFileBytes(resolve(tarballPath), "npm tarball", MAX_NPM_PACKAGE_TARBALL_BYTES),
            packageJson,
            { sourceSha, runId, runAttempt }
          )
        )
      );
    } else {
      throw new Error(usage());
    }
  } catch (error) {
    console.error(`[npm-package-artifact] FAIL — ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
