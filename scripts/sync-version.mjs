#!/usr/bin/env node
// Run by `npm version --no-git-tag-version <version>` (via the `version`
// lifecycle hook) to keep all version surfaces in sync without creating a tag
// on a pre-merge topic commit. npm itself bumps package.json; this script:
//
//   1. Mirrors the new version into the `VERSION` constant in `src/index.ts`
//      (otherwise the binary's `--version` lies and `version-consistency` CI
//      fails).
//   2. Mirrors it into server.json and mcpb/manifest.json.
//   3. Updates only the lockfile root + packages[""].version leaves. It never
//      invokes npm or re-resolves the dependency graph.
//   4. Warns (without failing) if `CHANGELOG.md` doesn't have a matching
//      `## [<version>]` heading yet — that's a manual content step.
//
// After this script runs, review the staged files in the topic PR. Create the
// annotated `v<version>` tag only on the final squash-merge SHA on main; the
// release preflight rejects lightweight and pre-merge tags.

import { randomUUID } from "node:crypto";
import { chmod, open, readFile, rename, stat, unlink } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { isCanonicalVersion, parseJsonStrict } from "./check-version-consistency.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const OWN = Object.prototype.hasOwnProperty;
const VERSION_DECLARATION_RE =
  /^[ \t]*(?:export[ \t]+)?const[ \t]+VERSION[ \t]*=[ \t]*("[^"\\\r\n]*"|[^;\r\n]+?)[ \t]*;/gm;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value, label) {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function requireOwn(container, key, label) {
  if (!isRecord(container) && !Array.isArray(container)) throw new Error(`${label} parent must be an object`);
  if (!OWN.call(container, key)) throw new Error(`${label} is missing`);
  return container[key];
}

function requireCanonicalVersion(value, label) {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  if (!isCanonicalVersion(value)) throw new Error(`${label} must be canonical SemVer, got ${JSON.stringify(value)}`);
  return value;
}

function requireSpan(parsed, pointer, label) {
  const span = parsed.spans.get(pointer);
  if (!span) throw new Error(`${label} source token is missing`);
  return span;
}

function replaceSpans(source, replacements) {
  const sorted = [...replacements].sort((left, right) => right.span.start - left.span.start);
  let previousStart = source.length + 1;
  let output = source;
  for (const replacement of sorted) {
    if (replacement.span.end > previousStart) throw new Error("sync-version: replacement spans overlap");
    output = `${output.slice(0, replacement.span.start)}${replacement.value}${output.slice(replacement.span.end)}`;
    previousStart = replacement.span.start;
  }
  return output;
}

function indexVersionToken(source) {
  const matches = [...source.matchAll(VERSION_DECLARATION_RE)];
  if (matches.length !== 1) {
    throw new Error(`src/index.ts must contain exactly one VERSION declaration, found ${matches.length}`);
  }
  const match = matches[0];
  const expression = match?.[1]?.trim() ?? "";
  if (!/^"[^"\\]*"$/.test(expression)) {
    throw new Error("src/index.ts VERSION must be one direct double-quoted string literal");
  }
  const fullMatch = match?.[0] ?? "";
  const matchStart = match?.index ?? -1;
  const relativeStart = fullMatch.indexOf(expression);
  if (matchStart < 0 || relativeStart < 0) throw new Error("src/index.ts VERSION source token is missing");
  return {
    version: requireCanonicalVersion(expression.slice(1, -1), "src/index.ts VERSION"),
    span: { start: matchStart + relativeStart, end: matchStart + relativeStart + expression.length }
  };
}

function parseManifest(source, label) {
  const parsed = parseJsonStrict(source, label);
  requireRecord(parsed.value, `${label} root`);
  return parsed;
}

async function readInput(repoRoot, relativePath) {
  const absolutePath = path.join(repoRoot, relativePath);
  const [source, metadata] = await Promise.all([readFile(absolutePath, "utf8"), stat(absolutePath)]);
  if (!metadata.isFile()) throw new Error(`${relativePath} must be a regular file`);
  return { absolutePath, mode: metadata.mode & 0o777, relativePath, source };
}

async function unlinkIfPresent(target) {
  try {
    await unlink(target);
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
  }
}

function transactionPath(target, token, suffix) {
  return path.join(path.dirname(target), `.${path.basename(target)}.sync-version-${token}.${suffix}`);
}

async function writeExclusiveFile(target, contents, mode) {
  let created = false;
  try {
    const handle = await open(target, "wx", mode);
    created = true;
    try {
      await handle.writeFile(contents, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(target, mode);
  } catch (error) {
    if (created) await unlinkIfPresent(target);
    throw error;
  }
}

async function stageChanges(changes, token) {
  const staged = [];
  try {
    for (const change of changes) {
      const temporaryPath = transactionPath(change.absolutePath, token, `${staged.length}.new`);
      const backupPath = transactionPath(change.absolutePath, token, `${staged.length}.bak`);
      await writeExclusiveFile(temporaryPath, change.output, change.mode);
      try {
        await writeExclusiveFile(backupPath, change.source, change.mode);
      } catch (error) {
        await unlinkIfPresent(temporaryPath);
        throw error;
      }
      staged.push({ ...change, backupPath, published: false, temporaryPath });
    }
    return staged;
  } catch (error) {
    await Promise.allSettled(
      staged.flatMap((entry) => [unlinkIfPresent(entry.temporaryPath), unlinkIfPresent(entry.backupPath)])
    );
    throw error;
  }
}

async function rollback(staged) {
  const rollbackErrors = [];
  for (const entry of [...staged].reverse()) {
    if (!entry.published) continue;
    try {
      await rename(entry.backupPath, entry.absolutePath);
      entry.published = false;
    } catch (error) {
      rollbackErrors.push(`${entry.relativePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  await Promise.allSettled(
    staged.flatMap((entry) => [unlinkIfPresent(entry.temporaryPath), unlinkIfPresent(entry.backupPath)])
  );
  if (rollbackErrors.length > 0) throw new Error(`sync-version rollback failed: ${rollbackErrors.join("; ")}`);
}

async function commitChanges(changes, afterPublish) {
  if (changes.length === 0) return [];
  const token = randomUUID();
  const staged = await stageChanges(changes, token);
  try {
    let publishedCount = 0;
    for (const entry of staged) {
      const current = await readFile(entry.absolutePath, "utf8");
      if (current !== entry.source) throw new Error(`${entry.relativePath} changed after preflight`);
      await rename(entry.temporaryPath, entry.absolutePath);
      entry.published = true;
      publishedCount += 1;
      if (afterPublish)
        await afterPublish({ path: entry.absolutePath, publishedCount, relativePath: entry.relativePath });
    }
  } catch (error) {
    try {
      await rollback(staged);
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "sync-version failed and rollback was incomplete");
    }
    throw error;
  }

  const cleanupResults = await Promise.allSettled(staged.map((entry) => unlinkIfPresent(entry.backupPath)));
  return cleanupResults.flatMap((result, index) =>
    result.status === "rejected"
      ? [`sync-version: WARN — committed ${staged[index]?.relativePath ?? "file"} but could not remove its backup`]
      : []
  );
}

async function buildSyncPlan(repoRoot) {
  const relativePaths = [
    "package.json",
    "package-lock.json",
    "src/index.ts",
    "server.json",
    "mcpb/manifest.json",
    "CHANGELOG.md"
  ];
  const entries = await Promise.all(relativePaths.map((relativePath) => readInput(repoRoot, relativePath)));
  const inputs = new Map(entries.map((entry) => [entry.relativePath, entry]));
  const input = (relativePath) => {
    const entry = inputs.get(relativePath);
    if (!entry) throw new Error(`${relativePath} input is missing`);
    return entry;
  };

  const packageInput = input("package.json");
  const packageParsed = parseManifest(packageInput.source, "package.json");
  const version = requireCanonicalVersion(
    requireOwn(packageParsed.value, "version", "package.json version"),
    "package.json version"
  );

  const lockInput = input("package-lock.json");
  const lockParsed = parseManifest(lockInput.source, "package-lock.json");
  const previousLockRoot = requireCanonicalVersion(
    requireOwn(lockParsed.value, "version", "package-lock.json root version"),
    "package-lock.json root version"
  );
  const lockPackages = requireRecord(
    requireOwn(lockParsed.value, "packages", "package-lock.json packages"),
    "package-lock.json packages"
  );
  const lockRootPackage = requireRecord(
    requireOwn(lockPackages, "", 'package-lock.json packages[""]'),
    'package-lock.json packages[""]'
  );
  const previousLockPackage = requireCanonicalVersion(
    requireOwn(lockRootPackage, "version", 'package-lock.json packages[""].version'),
    'package-lock.json packages[""].version'
  );

  const indexInput = input("src/index.ts");
  const indexToken = indexVersionToken(indexInput.source);

  const serverInput = input("server.json");
  const serverParsed = parseManifest(serverInput.source, "server.json");
  const previousServerRoot = requireCanonicalVersion(
    requireOwn(serverParsed.value, "version", "server.json version"),
    "server.json version"
  );
  const serverPackages = requireOwn(serverParsed.value, "packages", "server.json packages");
  if (!Array.isArray(serverPackages)) throw new Error("server.json packages must be an array");
  const serverPackage = requireRecord(
    requireOwn(serverPackages, 0, "server.json packages[0]"),
    "server.json packages[0]"
  );
  const previousServerPackage = requireCanonicalVersion(
    requireOwn(serverPackage, "version", "server.json packages[0].version"),
    "server.json packages[0].version"
  );

  const mcpbInput = input("mcpb/manifest.json");
  const mcpbParsed = parseManifest(mcpbInput.source, "mcpb/manifest.json");
  const mcpbName = requireOwn(mcpbParsed.value, "name", "mcpb/manifest.json name");
  if (typeof mcpbName !== "string" || mcpbName.length === 0) {
    throw new Error("mcpb/manifest.json name must be a non-empty string");
  }
  const previousMcpb = requireCanonicalVersion(
    requireOwn(mcpbParsed.value, "version", "mcpb/manifest.json version"),
    "mcpb/manifest.json version"
  );

  const versionLiteral = JSON.stringify(version);
  const lockOutput = replaceSpans(lockInput.source, [
    {
      span: requireSpan(lockParsed, "/packages//version", 'package-lock.json packages[""].version'),
      value: versionLiteral
    },
    { span: requireSpan(lockParsed, "/version", "package-lock.json root version"), value: versionLiteral }
  ]);
  const indexOutput = replaceSpans(indexInput.source, [{ span: indexToken.span, value: versionLiteral }]);
  const serverOutput = replaceSpans(serverInput.source, [
    {
      span: requireSpan(serverParsed, "/packages/0/version", "server.json packages[0].version"),
      value: versionLiteral
    },
    { span: requireSpan(serverParsed, "/version", "server.json version"), value: versionLiteral }
  ]);
  const mcpbOutput = replaceSpans(mcpbInput.source, [
    { span: requireSpan(mcpbParsed, "/version", "mcpb/manifest.json version"), value: versionLiteral }
  ]);

  // Re-parse every computed JSON file before any staging write. This catches a
  // bad span calculation inside the same preflight transaction boundary.
  for (const [label, output] of [
    ["package-lock.json", lockOutput],
    ["server.json", serverOutput],
    ["mcpb/manifest.json", mcpbOutput]
  ]) {
    parseManifest(output, `${label} computed output`);
  }

  const outputs = new Map([
    ["src/index.ts", indexOutput],
    ["server.json", serverOutput],
    ["mcpb/manifest.json", mcpbOutput],
    ["package-lock.json", lockOutput]
  ]);
  const changes = [...outputs]
    .map(([relativePath, output]) => ({ ...input(relativePath), output }))
    .filter((change) => change.source !== change.output);
  const changelog = input("CHANGELOG.md").source;
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const hasChangelogHeading = new RegExp(`^## \\[${escapedVersion}\\]`, "m").test(changelog);

  return {
    changes,
    hasChangelogHeading,
    messages: [
      `sync-version: src/index.ts ${indexToken.version} → ${version}`,
      `sync-version: server.json ${previousServerRoot}/${previousServerPackage} → ${version}`,
      `sync-version: mcpb/manifest.json ${previousMcpb} → ${version}`,
      `sync-version: package-lock.json ${previousLockRoot}/${previousLockPackage} → ${version}`
    ],
    version
  };
}

/**
 * Synchronize version leaves without invoking npm or resolving dependencies.
 * All inputs are validated and outputs computed before a transactional publish.
 *
 * @param {{ repoRoot?: string, afterPublish?: (event: { path: string, relativePath: string, publishedCount: number }) => void | Promise<void> }} options Options and optional test fault hook.
 * @returns {Promise<{ changedFiles: string[], hasChangelogHeading: boolean, messages: string[], version: string, warnings: string[] }>} Sync result.
 */
export async function syncVersion(options = {}) {
  const repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT;
  if (typeof repoRoot !== "string" || repoRoot.length === 0)
    throw new TypeError("sync-version repoRoot must be a non-empty string");
  if (options.afterPublish !== undefined && typeof options.afterPublish !== "function") {
    throw new TypeError("sync-version afterPublish must be a function");
  }

  const plan = await buildSyncPlan(path.resolve(repoRoot));
  const warnings = await commitChanges(plan.changes, options.afterPublish);
  return {
    changedFiles: plan.changes.map((change) => change.relativePath),
    hasChangelogHeading: plan.hasChangelogHeading,
    messages: plan.messages,
    version: plan.version,
    warnings
  };
}

async function main() {
  try {
    const result = await syncVersion();
    for (const message of result.messages) process.stdout.write(`${message}\n`);
    for (const warning of result.warnings) process.stderr.write(`${warning}\n`);
    if (!result.hasChangelogHeading) {
      process.stderr.write(
        `sync-version: WARN — CHANGELOG.md is missing a "## [${result.version}]" heading. Add one before pushing the tag.\n`
      );
    } else {
      process.stdout.write(`sync-version: CHANGELOG.md has a heading for ${result.version} OK\n`);
    }
    return 0;
  } catch (error) {
    process.stderr.write(`sync-version: ${error instanceof Error ? error.message : String(error)} — aborting\n`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) process.exitCode = await main();
