#!/usr/bin/env node

import { isEntrypoint } from "./lib/entrypoint.mjs";

/** The complete, reviewed mutation scope for the one-shot maintenance job. */
export const DIST_TAG_MAINTENANCE_TARGETS = Object.freeze(["alpha", "beta"]);

const MAX_INPUT_BYTES = 64 * 1024;
const MAX_TAGS = 256;
const MAX_TAG_NAME_CHARS = 128;
const MAX_VERSION_CHARS = 256;
const TAG_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/u;

function fail(message) {
  throw new Error(`[dist-tag-policy] ${message}`);
}

/**
 * Parse the bounded `npm view ... dist-tags --json` response used by the
 * maintenance workflow.
 *
 * The registry response is treated as untrusted input: only one plain JSON
 * mapping with bounded, printable tag/version strings is admitted. The
 * workflow never interpolates either registry field into a shell command; the
 * only mutation targets remain the two reviewed constants above.
 *
 * @param {string} source JSON received from npm
 * @returns {Readonly<Record<string, string>>} validated dist-tag mapping
 */
export function parseDistTagsJson(source) {
  if (typeof source !== "string") fail("input must be a UTF-8 string");
  if (Buffer.byteLength(source, "utf8") > MAX_INPUT_BYTES) {
    fail(`input exceeds ${MAX_INPUT_BYTES} bytes`);
  }
  if (source.trim().length === 0) fail("registry returned an empty response");

  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    fail("registry response is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    fail("registry response must be one JSON object");
  }

  const entries = Object.entries(parsed);
  if (entries.length > MAX_TAGS) fail(`registry response exceeds ${MAX_TAGS} tags`);
  const result = Object.create(null);
  for (const [tag, version] of entries) {
    if (
      tag.length === 0 ||
      tag.length > MAX_TAG_NAME_CHARS ||
      !TAG_NAME_PATTERN.test(tag) ||
      tag === "__proto__" ||
      tag === "constructor" ||
      tag === "prototype"
    ) {
      fail(`registry response contains an invalid tag name: ${JSON.stringify(tag)}`);
    }
    if (
      typeof version !== "string" ||
      version.length === 0 ||
      version.length > MAX_VERSION_CHARS ||
      !VERSION_PATTERN.test(version)
    ) {
      fail(`registry response contains an invalid version for tag ${JSON.stringify(tag)}`);
    }
    result[tag] = version;
  }
  return Object.freeze(result);
}

/**
 * Classify which reviewed maintenance targets are present.
 *
 * @param {string} source validated npm dist-tags JSON source
 * @returns {{ alphaPresent: boolean, betaPresent: boolean }} fixed decisions
 */
export function classifyMaintenanceTargets(source) {
  const tags = parseDistTagsJson(source);
  return {
    alphaPresent: Object.hasOwn(tags, "alpha"),
    betaPresent: Object.hasOwn(tags, "beta")
  };
}

/**
 * Assert the cleanup postcondition against a fresh registry observation.
 *
 * @param {string} source validated npm dist-tags JSON source
 * @returns {void}
 */
export function assertMaintenanceTargetsAbsent(source) {
  const classification = classifyMaintenanceTargets(source);
  const remaining = [];
  if (classification.alphaPresent) remaining.push("alpha");
  if (classification.betaPresent) remaining.push("beta");
  if (remaining.length > 0) fail(`postcondition failed; tags still present: ${remaining.join(", ")}`);
}

async function readBoundedStdin() {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += bytes.length;
    if (totalBytes > MAX_INPUT_BYTES) fail(`input exceeds ${MAX_INPUT_BYTES} bytes`);
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, totalBytes).toString("utf8");
}

async function main() {
  const [mode, ...extra] = process.argv.slice(2);
  if (extra.length !== 0 || (mode !== "classify" && mode !== "assert-absent")) {
    fail("usage: npm-dist-tag-policy.mjs <classify|assert-absent>");
  }
  const source = await readBoundedStdin();
  if (mode === "classify") {
    const result = classifyMaintenanceTargets(source);
    process.stdout.write(`alpha_present=${String(result.alphaPresent)}\n`);
    process.stdout.write(`beta_present=${String(result.betaPresent)}\n`);
    return;
  }
  assertMaintenanceTargetsAbsent(source);
  process.stdout.write("dist-tag postcondition satisfied\n");
}

if (isEntrypoint(import.meta.url)) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : "unknown failure";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
