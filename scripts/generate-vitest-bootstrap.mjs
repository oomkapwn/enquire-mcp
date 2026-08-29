#!/usr/bin/env node
// Regenerates the trusted Vitest bootstrap receipt and its single CI carrier.
//
// BACKLOG §1.CC A8: package.json + package-lock.json are byte-frozen in
// `.github/trusted-vitest-bootstrap.sha256`, verified as the first lint step
// before setup-node. This script is the reviewed regeneration path. It does not
// expand the 16-file census; path-sha and line-count pins stay fail-closed.

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isEntrypoint } from "./lib/entrypoint.mjs";
import {
  ciWorkflowReceiptDigest,
  EXPECTED_VITEST_BOOTSTRAP_FILES,
  VITEST_BOOTSTRAP_MANIFEST
} from "./lib/oia-vitest-bootstrap.mjs";

const DEFAULT_REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CI_WORKFLOW = ".github/workflows/ci.yml";
const SHA256 = /^[0-9a-f]{64}$/u;
const MANIFEST_CARRIER_RE = /^ {10}expected_manifest_sha=([0-9a-f]{64})$/gmu;
const PATH_SHA_RE = /^ {10}expected_path_sha=([0-9a-f]{64})$/gmu;
const LINE_COUNT_RE = /^ {10}\[\[ "\$line_count" -eq (\d+) \]\]$/gmu;
const PATH_COUNT_RE = /^ {10}\[\[ \$\{#paths\[@\]\} -eq (\d+) \]\]$/gmu;

function fail(message) {
  throw new Error(`vitest bootstrap generator: ${message}`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function physicalFile(root, relativePath) {
  const absolute = join(root, relativePath);
  let stat;
  try {
    stat = lstatSync(absolute);
  } catch (error) {
    fail(
      error && typeof error === "object" && "code" in error && error.code === "ENOENT"
        ? `${relativePath} is missing`
        : `${relativePath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (stat === undefined || stat.isSymbolicLink() || !stat.isFile()) {
    fail(`${relativePath} must be a physical non-symlink file`);
  }
  return absolute;
}

function uniqueMatch(source, pattern, label) {
  pattern.lastIndex = 0;
  const matches = [...source.matchAll(pattern)];
  const match = matches[0];
  if (matches.length !== 1 || match?.[1] === undefined) {
    fail(`expected one ${label} pin, found ${matches.length}`);
  }
  return match[1];
}

/**
 * Render the exact trusted Vitest bootstrap receipt for one repository root.
 *
 * @param {string} root Repository root whose reviewed bootstrap files are hashed.
 * @returns {string} LF-terminated receipt with one line per reviewed path.
 */
export function renderVitestBootstrapManifest(root) {
  if (EXPECTED_VITEST_BOOTSTRAP_FILES.at(-1) !== CI_WORKFLOW) {
    fail("CI workflow must remain the final receipt path so raw file hashes stay checkable");
  }
  const lines = EXPECTED_VITEST_BOOTSTRAP_FILES.map((relativePath) => {
    const absolute = physicalFile(root, relativePath);
    const digest =
      relativePath === CI_WORKFLOW
        ? ciWorkflowReceiptDigest(readFileSync(absolute, "utf8"))
        : sha256(readFileSync(absolute));
    return `${digest}  ${relativePath}`;
  });
  const manifest = `${lines.join("\n")}\n`;
  if (manifest.includes("\r") || !manifest.endsWith("\n")) {
    fail("receipt must be LF-only with one final LF");
  }
  return manifest;
}

/**
 * Replace the lint job's single receipt-SHA carrier.
 *
 * @param {string} source Raw `.github/workflows/ci.yml` source.
 * @param {string} manifestDigest SHA-256 of the raw receipt bytes.
 * @returns {string} Workflow source with the carrier updated.
 */
export function replaceVitestBootstrapCarrier(source, manifestDigest) {
  if (!SHA256.test(manifestDigest)) fail("manifest digest is not lowercase SHA-256");
  MANIFEST_CARRIER_RE.lastIndex = 0;
  const matches = [...source.matchAll(MANIFEST_CARRIER_RE)];
  const match = matches[0];
  if (matches.length !== 1 || match?.index === undefined) {
    fail(`expected one canonical receipt carrier, found ${matches.length}`);
  }
  return (
    source.slice(0, match.index) +
    `          expected_manifest_sha=${manifestDigest}` +
    source.slice(match.index + match[0].length)
  );
}

/**
 * Write the trusted Vitest bootstrap receipt and update its single CI carrier.
 *
 * Path-census pins stay fail-closed: expanding EXPECTED_VITEST_BOOTSTRAP_FILES
 * requires a reviewed change to expected_path_sha and the two line-count pins.
 *
 * @param {string} root Repository root to regenerate.
 * @returns {string} SHA-256 of the written receipt bytes.
 */
export function generateVitestBootstrapReceipt(root) {
  const ciPath = physicalFile(root, CI_WORKFLOW);
  const ciSource = readFileSync(ciPath, "utf8");
  const expectedCount = String(EXPECTED_VITEST_BOOTSTRAP_FILES.length);
  const lineCount = uniqueMatch(ciSource, LINE_COUNT_RE, "line_count");
  const pathCount = uniqueMatch(ciSource, PATH_COUNT_RE, "paths length");
  const expectedPathSha = uniqueMatch(ciSource, PATH_SHA_RE, "expected_path_sha");
  const actualPathSha = sha256(`${EXPECTED_VITEST_BOOTSTRAP_FILES.join("\n")}\n`);
  if (lineCount !== expectedCount || pathCount !== expectedCount) {
    fail(
      `CI path census pins are line_count=${lineCount} paths=${pathCount}; ` +
        `EXPECTED_VITEST_BOOTSTRAP_FILES has ${expectedCount}. Expanding the freeze is a reviewed inventory change.`
    );
  }
  if (actualPathSha !== expectedPathSha) {
    fail(
      `CI expected_path_sha=${expectedPathSha} but census digest is ${actualPathSha}. ` +
        "Expanding the freeze is a reviewed inventory change."
    );
  }

  const manifest = renderVitestBootstrapManifest(root);
  const manifestDigest = sha256(manifest);
  const nextCi = replaceVitestBootstrapCarrier(ciSource, manifestDigest);
  writeFileSync(join(root, VITEST_BOOTSTRAP_MANIFEST), manifest);
  if (nextCi !== ciSource) writeFileSync(ciPath, nextCi);
  return manifestDigest;
}

function parseRoot(argv) {
  if (argv.length > 1) fail("usage: node scripts/generate-vitest-bootstrap.mjs [repo-root]");
  return argv[0] === undefined ? DEFAULT_REPO_ROOT : resolve(argv[0]);
}

if (isEntrypoint(import.meta.url)) {
  try {
    process.stdout.write(`${generateVitestBootstrapReceipt(parseRoot(process.argv.slice(2)))}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
