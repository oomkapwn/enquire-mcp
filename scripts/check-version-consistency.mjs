#!/usr/bin/env node
// Asserts that the version is identical across all surfaces that publish it:
//   - package.json
//   - package-lock.json (root + packages[""])
//   - src/index.ts VERSION constant
//   - latest CHANGELOG.md heading
//   - server.json (MCP Registry manifest — added v3.8.0-rc.18 per external
//     audit M-REG-1: rc.13 server.json was 4 RCs behind npm before this
//     gate caught it)
//   - mcpb/manifest.json (Basic desktop bundle — added v4.0.0-rc.2)
// Run as part of CI so a forgotten bump in any one place fails the build
// instead of shipping silent drift (which we hit on v0.7.4 → 0.7.5 + the
// 4-RC server.json drift caught by the M-REG-1 external-audit finding on rc.15).

import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const OWN = Object.prototype.hasOwnProperty;
const JSON_WHITESPACE_RE = /[\t\n\r ]/;
const JSON_NUMBER_RE = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const VERSION_DECLARATION_RE = /^[ \t]*(?:export[ \t]+)?const[ \t]+VERSION[ \t]*=[ \t]*([^;\r\n]+)[ \t]*;/gm;
const CHANGELOG_HEADING_RE = /^## \[([^\]\r\n]+)\]/gm;

// SemVer 2.0.0 without aliases or leading zeroes in numeric identifiers.
const CORE_NUMBER = "(?:0|[1-9]\\d*)";
const PRERELEASE_IDENTIFIER = "(?:0|[1-9]\\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)";
const BUILD_IDENTIFIER = "[0-9A-Za-z-]+";
const CANONICAL_SEMVER_RE = new RegExp(
  `^${CORE_NUMBER}\\.${CORE_NUMBER}\\.${CORE_NUMBER}` +
    `(?:-${PRERELEASE_IDENTIFIER}(?:\\.${PRERELEASE_IDENTIFIER})*)?` +
    `(?:\\+${BUILD_IDENTIFIER}(?:\\.${BUILD_IDENTIFIER})*)?$`
);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonPointer(pathSegments) {
  return pathSegments.map((segment) => `/${String(segment).replaceAll("~", "~0").replaceAll("/", "~1")}`).join("");
}

/**
 * Parse JSON while rejecting duplicate object keys and non-finite numeric
 * results. JSON-pointer spans identify exact source tokens for safe leaf edits.
 *
 * @param {string} source JSON source text.
 * @param {string} label Human-readable input label for errors.
 * @returns {{ value: unknown, spans: Map<string, { start: number, end: number }> }} Parsed value and token spans.
 */
export function parseJsonStrict(source, label = "JSON") {
  if (typeof source !== "string") throw new TypeError(`${label}: source must be a string`);

  let offset = 0;
  const spans = new Map();

  const fail = (message) => {
    throw new Error(`${label}: ${message} at byte ${offset}`);
  };

  const skipWhitespace = () => {
    while (offset < source.length && JSON_WHITESPACE_RE.test(source[offset] ?? "")) offset += 1;
  };

  const parseString = () => {
    if (source[offset] !== '"') fail("expected a JSON string");
    const start = offset;
    offset += 1;
    let escaped = false;
    while (offset < source.length) {
      const character = source[offset] ?? "";
      offset += 1;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        continue;
      }
      if (character === '"') {
        const raw = source.slice(start, offset);
        try {
          return JSON.parse(raw);
        } catch (error) {
          fail(`invalid JSON string (${error instanceof Error ? error.message : String(error)})`);
        }
      }
    }
    fail("unterminated JSON string");
  };

  const parseValue = (pathSegments) => {
    skipWhitespace();
    const start = offset;
    const character = source[offset];
    let value;

    if (character === '"') {
      value = parseString();
    } else if (character === "{") {
      value = parseObject(pathSegments);
    } else if (character === "[") {
      value = parseArray(pathSegments);
    } else if (source.startsWith("true", offset)) {
      offset += 4;
      value = true;
    } else if (source.startsWith("false", offset)) {
      offset += 5;
      value = false;
    } else if (source.startsWith("null", offset)) {
      offset += 4;
      value = null;
    } else {
      JSON_NUMBER_RE.lastIndex = offset;
      const numberMatch = JSON_NUMBER_RE.exec(source);
      if (!numberMatch || numberMatch.index !== offset) fail("expected a JSON value");
      offset = JSON_NUMBER_RE.lastIndex;
      value = Number(numberMatch[0]);
      if (!Number.isFinite(value)) fail("number must be finite");
    }

    spans.set(jsonPointer(pathSegments), { start, end: offset });
    return value;
  };

  const parseObject = (pathSegments) => {
    const value = Object.create(null);
    const keys = new Set();
    offset += 1;
    skipWhitespace();
    if (source[offset] === "}") {
      offset += 1;
      return value;
    }

    while (offset < source.length) {
      skipWhitespace();
      const key = parseString();
      if (keys.has(key)) fail(`duplicate object key ${JSON.stringify(key)} at ${jsonPointer(pathSegments) || "/"}`);
      keys.add(key);
      skipWhitespace();
      if (source[offset] !== ":") fail("expected ':' after object key");
      offset += 1;
      const childPath = [...pathSegments, key];
      const childValue = parseValue(childPath);
      Object.defineProperty(value, key, { configurable: true, enumerable: true, value: childValue, writable: true });
      skipWhitespace();
      if (source[offset] === "}") {
        offset += 1;
        return value;
      }
      if (source[offset] !== ",") fail("expected ',' or '}' in object");
      offset += 1;
    }
    fail("unterminated JSON object");
  };

  const parseArray = (pathSegments) => {
    const value = [];
    offset += 1;
    skipWhitespace();
    if (source[offset] === "]") {
      offset += 1;
      return value;
    }

    while (offset < source.length) {
      value.push(parseValue([...pathSegments, value.length]));
      skipWhitespace();
      if (source[offset] === "]") {
        offset += 1;
        return value;
      }
      if (source[offset] !== ",") fail("expected ',' or ']' in array");
      offset += 1;
    }
    fail("unterminated JSON array");
  };

  const value = parseValue([]);
  skipWhitespace();
  if (offset !== source.length) fail("unexpected trailing content");
  return { value, spans };
}

/**
 * Return whether a value is one canonical SemVer string.
 *
 * @param {unknown} value Candidate version.
 * @returns {value is string} True only for canonical SemVer.
 */
export function isCanonicalVersion(value) {
  return typeof value === "string" && CANONICAL_SEMVER_RE.test(value);
}

function ownValue(container, key, label, errors) {
  if (!isRecord(container)) {
    errors.push(`${label}: parent must be an object`);
    return undefined;
  }
  if (!OWN.call(container, key)) {
    errors.push(`${label}: missing`);
    return undefined;
  }
  return container[key];
}

function validateVersionSurface(value, label, errors) {
  if (typeof value !== "string") {
    if (value !== undefined) errors.push(`${label}: expected a string, got ${value === null ? "null" : typeof value}`);
    return;
  }
  if (!isCanonicalVersion(value)) errors.push(`${label}: non-canonical SemVer ${JSON.stringify(value)}`);
}

function declarationsFromIndex(source) {
  return [...source.matchAll(VERSION_DECLARATION_RE)].map((match) => ({ expression: match[1]?.trim() ?? "" }));
}

function versionFromDeclaration(expression, errors) {
  if (!/^"[^"\\]*"$/.test(expression)) {
    errors.push("src/index.ts:VERSION: expected one direct double-quoted string literal");
    return undefined;
  }
  return expression.slice(1, -1);
}

async function readRequired(repoRoot, relativePath, errors) {
  try {
    return await readFile(path.join(repoRoot, relativePath), "utf8");
  } catch (error) {
    errors.push(`${relativePath}: unreadable (${error instanceof Error ? error.message : String(error)})`);
    return undefined;
  }
}

function parseRequiredJson(source, label, errors) {
  if (source === undefined) return undefined;
  try {
    return parseJsonStrict(source, label).value;
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

/**
 * Validate and compare every release-version surface under a repository root.
 *
 * @param {string} repoRoot Repository root containing release metadata.
 * @returns {Promise<{ ok: boolean, errors: string[], version?: string, surfaceCount: number }>} Gate result.
 */
export async function checkVersionConsistency(repoRoot = DEFAULT_REPO_ROOT) {
  const errors = [];
  const relativePaths = [
    "package.json",
    "package-lock.json",
    "src/index.ts",
    "CHANGELOG.md",
    "server.json",
    "mcpb/manifest.json"
  ];
  const sources = new Map();
  await Promise.all(
    relativePaths.map(async (relativePath) => {
      sources.set(relativePath, await readRequired(repoRoot, relativePath, errors));
    })
  );

  const pkg = parseRequiredJson(sources.get("package.json"), "package.json", errors);
  const lock = parseRequiredJson(sources.get("package-lock.json"), "package-lock.json", errors);
  const serverJson = parseRequiredJson(sources.get("server.json"), "server.json", errors);
  const mcpbManifest = parseRequiredJson(sources.get("mcpb/manifest.json"), "mcpb/manifest.json", errors);
  const surfaces = Object.create(null);

  surfaces["package.json:version"] = ownValue(pkg, "version", "package.json:version", errors);
  surfaces["package-lock.json:root version"] = ownValue(lock, "version", "package-lock.json:root version", errors);
  const lockPackages = ownValue(lock, "packages", "package-lock.json:packages", errors);
  const lockRootPackage = ownValue(lockPackages, "", 'package-lock.json:packages[""]', errors);
  surfaces['package-lock.json:packages[""].version'] = ownValue(
    lockRootPackage,
    "version",
    'package-lock.json:packages[""].version',
    errors
  );

  const indexSource = sources.get("src/index.ts");
  if (indexSource !== undefined) {
    const declarations = declarationsFromIndex(indexSource);
    if (declarations.length === 0) errors.push("src/index.ts:VERSION: missing");
    else if (declarations.length > 1)
      errors.push(`src/index.ts:VERSION: duplicated (${declarations.length} declarations)`);
    else surfaces["src/index.ts:VERSION"] = versionFromDeclaration(declarations[0]?.expression ?? "", errors);
  }

  const changelog = sources.get("CHANGELOG.md");
  if (changelog !== undefined) {
    const headings = [...changelog.matchAll(CHANGELOG_HEADING_RE)].map((match) => match[1] ?? "");
    if (headings.length === 0) {
      errors.push("CHANGELOG.md:latest heading: missing");
    } else {
      const latest = headings[0] ?? "";
      surfaces["CHANGELOG.md:latest heading"] = latest;
      const duplicateCount = headings.filter((heading) => heading === latest).length;
      if (duplicateCount > 1) {
        errors.push(
          `CHANGELOG.md:latest heading: duplicated (${duplicateCount} headings for ${JSON.stringify(latest)})`
        );
      }
    }
  }

  surfaces["server.json:version"] = ownValue(serverJson, "version", "server.json:version", errors);
  const serverPackages = ownValue(serverJson, "packages", "server.json:packages", errors);
  if (serverPackages !== undefined && !Array.isArray(serverPackages)) {
    errors.push("server.json:packages: expected an array");
  }
  const serverPackage = Array.isArray(serverPackages) ? serverPackages[0] : undefined;
  if (Array.isArray(serverPackages) && !isRecord(serverPackage))
    errors.push("server.json:packages[0]: missing or not an object");
  surfaces["server.json:packages[0].version"] = ownValue(
    serverPackage,
    "version",
    "server.json:packages[0].version",
    errors
  );
  surfaces["mcpb/manifest.json:version"] = ownValue(mcpbManifest, "version", "mcpb/manifest.json:version", errors);

  for (const [label, value] of Object.entries(surfaces)) validateVersionSurface(value, label, errors);

  const surfaceEntries = Object.entries(surfaces);
  if (errors.length === 0) {
    const distinct = new Set(surfaceEntries.map(([, value]) => value));
    if (distinct.size !== 1) {
      errors.push("Version drift across published surfaces:");
      for (const [where, value] of surfaceEntries) errors.push(`  ${where}: ${String(value)}`);
    }
  }

  const packageVersion = surfaces["package.json:version"];
  if (errors.length === 0 && typeof packageVersion === "string" && /-rc\.\d+$/.test(packageVersion)) {
    const claudeMd = await readRequired(repoRoot, "CLAUDE.md", errors);
    if (claudeMd !== undefined) {
      const markerSpecs = [
        {
          label: "CLAUDE.md status roll-up",
          regex: /current roll-up;\s*`@rc`\s*=\s*(\d+\.\d+\.\d+-rc\.\d+)/g
        },
        {
          label: "CLAUDE.md top-header",
          regex: /current header;\s*`@rc`\s*=\s*(\d+\.\d+\.\d+-rc\.\d+)/g
        }
      ];
      for (const { label, regex } of markerSpecs) {
        const matches = [...claudeMd.matchAll(regex)].map((match) => match[1]);
        if (matches.length !== 1) {
          errors.push(`${label}: expected exactly one @rc marker, found ${matches.length}`);
        } else if (matches[0] !== packageVersion) {
          errors.push(`${label}: @rc=${matches[0]} but package.json is ${packageVersion}`);
        }
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    version: typeof packageVersion === "string" ? packageVersion : undefined,
    surfaceCount: surfaceEntries.length
  };
}

async function main() {
  const result = await checkVersionConsistency();
  if (result.ok) {
    process.stdout.write(
      `OK — version ${result.version} consistent across ${result.surfaceCount} surfaces + CLAUDE.md roll-up + header @rc currency\n`
    );
    return 0;
  }
  process.stderr.write(`${result.errors.join("\n")}\n`);
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) process.exitCode = await main();
