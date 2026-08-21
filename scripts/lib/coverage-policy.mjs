import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const MAX_SOURCE_ENTRIES = 10_000;
const MAX_SOURCE_DEPTH = 64;

/** Exact registration/bootstrap files intentionally excluded from coverage. */
export const COVERAGE_EXCLUDED_SOURCE_FILES = Object.freeze([
  "src/cli.ts",
  "src/index.ts",
  "src/prompts.ts",
  "src/server.ts",
  "src/tool-manifest.ts",
  "src/tool-registry.ts"
]);

/** Vitest exclusions derived from the same exact inventory OIA verifies. */
export const COVERAGE_EXCLUDE_PATTERNS = Object.freeze([...COVERAGE_EXCLUDED_SOURCE_FILES, "**/*.test.ts"]);

function toPosix(value) {
  return value.split(sep).join("/");
}

function isOutside(relativePath) {
  return relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath);
}

/**
 * Discover the exact TypeScript source universe without following aliases.
 *
 * Symlinks and special files fail closed: a coverage producer must not be able
 * to hide or duplicate source through a filesystem alias.
 */
export function discoverTypeScriptSources(repoRoot) {
  const absoluteRoot = realpathSync(resolve(repoRoot));
  const sourceRoot = join(absoluteRoot, "src");
  const found = [];
  let visitedEntries = 0;

  const sourceStat = lstatSync(sourceRoot);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error("coverage source inventory requires src to be one physical directory");
  }

  function walk(directory, depth) {
    if (depth > MAX_SOURCE_DEPTH) throw new Error(`coverage source inventory exceeded depth ${MAX_SOURCE_DEPTH}`);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      visitedEntries++;
      if (visitedEntries > MAX_SOURCE_ENTRIES) {
        throw new Error(`coverage source inventory exceeded ${MAX_SOURCE_ENTRIES} entries`);
      }
      const absolute = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`coverage source inventory rejects symlink: ${toPosix(relative(absoluteRoot, absolute))}`);
      }
      if (entry.isDirectory()) {
        walk(absolute, depth + 1);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(
          `coverage source inventory rejects special entry: ${toPosix(relative(absoluteRoot, absolute))}`
        );
      }
      if (entry.name.endsWith(".ts")) found.push(toPosix(relative(absoluteRoot, absolute)));
    }
  }

  walk(sourceRoot, 0);
  return found.sort();
}

/** Exact files that the configured coverage producer must report. */
export function expectedCoverageSourceFiles(repoRoot) {
  const excluded = new Set(COVERAGE_EXCLUDED_SOURCE_FILES);
  return discoverTypeScriptSources(repoRoot).filter((file) => !excluded.has(file));
}

/** Normalize one Istanbul path only when it identifies a file inside this checkout. */
export function normalizeCoverageReportedPath(repoRoot, reportedPath) {
  if (typeof reportedPath !== "string" || reportedPath.length === 0 || reportedPath.includes("\0")) return null;
  const absoluteRoot = realpathSync(resolve(repoRoot));
  const portablePath = reportedPath.replaceAll("\\", sep).replaceAll("/", sep);
  let absoluteReported;
  try {
    absoluteReported = realpathSync(
      isAbsolute(portablePath) ? resolve(portablePath) : resolve(absoluteRoot, portablePath)
    );
  } catch {
    return null;
  }
  const relativePath = relative(absoluteRoot, absoluteReported);
  if (isOutside(relativePath)) return null;
  return toPosix(relativePath);
}
