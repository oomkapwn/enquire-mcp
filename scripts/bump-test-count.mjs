#!/usr/bin/env node
// Recompute the exact source-test count and rewrite every declared surface in one command.
//
// Usage:
//   node scripts/bump-test-count.mjs            rewrite every surface that holds the old count
//   node scripts/bump-test-count.mjs --check    exit 1 and list stale surfaces; writes nothing
//   node scripts/bump-test-count.mjs --dry-run  report the plan, write nothing
//
// The count rule is the one `tests/docs-consistency.test.ts::countActualTests` uses, so this
// script and that invariant can never disagree about the number: every `tests/**/*.test.ts` file,
// counting lines that begin an `it(` registration. This file lives in `scripts/`, so the script
// itself contributes nothing to the census — adding a test moves the number, running this moves
// the surfaces back into agreement.
//
// Two files deliberately hold the digits of the current count without declaring a test count:
// `tests/fixtures/release-mutation-identity.v2.json` (sha256 digests and byte offsets) and
// `tests/fixtures/release-mutation-transition.v3.json`. A global search-and-replace would corrupt
// those machine-generated pins and break the release-mutation identity seal, which is why the
// surfaces below are an explicit table instead of a sweep over the tree.
//
// `CHANGELOG.md` and `CLAUDE.md` get scoped handlers because both carry RELEASE HISTORY next to
// their current claim. The invariant reads only `Unreleased` + the newest `## [` section of the
// changelog, and only the `**Current state` line plus the bullet for the current `package.json`
// version in the agent guide. A blind replace would rewrite a historical arrow's SOURCE or target
// (`2228 → 2272` becoming `2280 → 2280`) and silently falsify the record. Every other surface
// declares the count in current-tense prose only, so a whole-token replace is exact there.
//
// The social preview PNG stays as CI renders it; the tracked SVG carries the number and is listed.

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isEntrypoint } from "./lib/entrypoint.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");

/** The exact census `countActualTests()` performs; changing it would desynchronise the invariant. */
const IT_REGISTRATION = /^\s*it\s*[(]/gm;

const TESTS_DIR = "tests";
const TEST_FILE_SUFFIX = ".test.ts";

/**
 * Files that may carry the declared count. A surface holding none is a hard error: it means the
 * table and the tree disagree, and a silently skipped surface is the failure this script exists
 * to remove. Historical release-mutation fixtures are intentionally absent.
 */
const SURFACES = [
  "AGENTS.md",
  "CHANGELOG.md",
  "CLAUDE.md",
  "README.ar.md",
  "README.de.md",
  "README.es.md",
  "README.fr.md",
  "README.hi.md",
  "README.ja.md",
  "README.ko.md",
  "README.md",
  "README.pt.md",
  "README.ru.md",
  "README.zh.md",
  "ROADMAP.md",
  "assets/social-preview.svg",
  "docs/COMPARISON.md",
  "llms-ctx.txt",
  "llms.txt",
  "package.json"
];

/** Machine-generated pins whose digits must survive; reported, never rewritten. */
const EXCLUDED = [
  "tests/fixtures/release-mutation-identity.v2.json",
  "tests/fixtures/release-mutation-transition.v3.json"
];

/** Two independent declarations of the current count; they must agree before anything is written. */
const ANCHORS = ["package.json", "AGENTS.md"];

/** `→ N source tests` — the invariant reads the arrow's TARGET; the source is history. */
const ARROW_CLAIM = /→\s*(\d+)\s+source tests/g;

/** `### Tests (N)` — the invariant reads the number in parentheses. */
const TESTS_HEADING = /^### Tests \((\d+)\)/gm;

/** The one CLAUDE.md slot the invariant reads as the guide's current total. */
const CLAUDE_CURRENT_STATE_SLOT = /·\s*(\d+)\s+tests\s*·\s*11 languages/;

/** The one CLAUDE.md line the invariant reads as the current release bullet. */
const CLAUDE_CURRENT_STATE_PREFIX = "**Current state";

function fail(message) {
  throw new Error(`bump-test-count: ${message}`);
}

function read(repoRoot, relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function collectTestFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...collectTestFiles(full));
    else if (entry.name.endsWith(TEST_FILE_SUFFIX)) found.push(full);
  }
  return found;
}

/**
 * Count `it(` registrations exactly as the docs-consistency invariant does.
 *
 * @param {string} repoRoot Absolute repository root.
 * @returns {number} The exact source-test count.
 */
export function countSourceTests(repoRoot) {
  const dir = path.join(repoRoot, TESTS_DIR);
  try {
    statSync(dir);
  } catch {
    fail(`no ${TESTS_DIR}/ directory at ${dir}`);
  }
  let total = 0;
  let files = 0;
  for (const file of collectTestFiles(dir).sort()) {
    total += [...readFileSync(file, "utf8").matchAll(IT_REGISTRATION)].length;
    files += 1;
  }
  process.stdout.write(`bump-test-count: ${files} test files, ${total} source tests\n`);
  return total;
}

/** Whole-word integer match so a 4-digit count never matches inside a 5- or 6-digit neighbour. */
function tokenPattern(count) {
  return new RegExp(`(?<![\\d])${count}(?![\\d])`, "g");
}

/**
 * The changelog spans the invariant treats as current: `## Unreleased` when present PLUS the
 * newest `## [` section. Both carry claims the invariant checks, so both are rewritten; older
 * sections are history and are returned as neither span nor rewrite target.
 *
 * @param {string} changelog Full CHANGELOG.md text.
 * @returns {{ start: number, end: number }[]} Ordered, non-overlapping spans of the current sections.
 */
export function currentChangelogSpans(changelog) {
  const first = changelog.indexOf("\n## [");
  const next = first < 0 ? -1 : changelog.indexOf("\n## [", first + 1);
  const unreleasedHeading = changelog.indexOf("\n## Unreleased");
  const hasUnreleased = unreleasedHeading >= 0 && (first < 0 || unreleasedHeading < first);
  const latest = first < 0 ? null : { start: first, end: next < 0 ? changelog.length : next };
  if (!hasUnreleased) {
    if (latest === null) return [];
    return [latest];
  }
  const unreleased = { start: unreleasedHeading, end: first < 0 ? changelog.length : first };
  return latest === null ? [unreleased] : [unreleased, latest];
}

/**
 * Rewrite an arrow target and the Tests heading inside one slice, leaving arrow sources alone.
 *
 * @param {string} text Slice to rewrite.
 * @param {number} next Newly derived count.
 * @returns {{ text: string, replaced: number }} Rewritten slice and replacement count.
 */
function rewriteClaimSlots(text, next) {
  let replaced = 0;
  const rewriteArrow = (match, digits) => {
    replaced += 1;
    // The digit run the regex captured IS the target: nothing numeric precedes it in the match.
    return match.replace(digits, () => String(next));
  };
  const rewriteHeading = (match, digits) => {
    replaced += 1;
    return match.replace(digits, () => String(next));
  };
  const nextText = text.replace(ARROW_CLAIM, rewriteArrow).replace(TESTS_HEADING, rewriteHeading);
  return { text: nextText, replaced };
}

/**
 * Rewrite the two CLAUDE.md slots the invariant reads: the `**Current state` line's test total and
 * the current version bullet's arrow targets. Every other bullet is history and is left byte-exact.
 *
 * @param {string} source CLAUDE.md text.
 * @param {string} version Current `package.json` version.
 * @param {number} next Newly derived count.
 * @returns {{ text: string, replaced: number }} Rewritten text and replacement count.
 */
export function rewriteClaudeSurface(source, version, next) {
  const bulletPrefix = `- **v${version} `;
  let stateSeen = false;
  let stateReplaced = 0;
  let bulletSeen = false;
  let bulletReplaced = 0;
  const lines = source.split("\n").map((line) => {
    if (!stateSeen && line.startsWith(CLAUDE_CURRENT_STATE_PREFIX)) {
      stateSeen = true;
      if (!CLAUDE_CURRENT_STATE_SLOT.test(line)) {
        fail(`CLAUDE.md ${CLAUDE_CURRENT_STATE_PREFIX} line has no \`· N tests · 11 languages\` slot`);
      }
      stateReplaced += 1;
      return line.replace(/(\d+)(?=\s+tests\s*·\s*11 languages)/, () => String(next));
    }
    if (!bulletSeen && line.startsWith(bulletPrefix)) {
      bulletSeen = true;
      const rewritten = rewriteClaimSlots(line, next);
      bulletReplaced += rewritten.replaced;
      return rewritten.text;
    }
    return line;
  });
  if (!stateSeen) fail(`CLAUDE.md has no \`${CLAUDE_CURRENT_STATE_PREFIX}\` line`);
  if (!bulletSeen) fail(`CLAUDE.md has no \`${bulletPrefix}\` bullet for version ${version}`);
  if (bulletReplaced === 0) fail(`CLAUDE.md bullet for ${version} declares no \`→ N source tests\` claim`);
  return { text: lines.join("\n"), replaced: stateReplaced + bulletReplaced };
}

/**
 * Replace the current count, returning the rewritten text and how many slots moved.
 *
 * @param {string} source File text.
 * @param {string} relativePath Surface path, used only for messages.
 * @param {number} previous Currently declared count.
 * @param {number} next Newly derived count.
 * @param {string} version Current `package.json` version, for the CLAUDE.md scoping.
 * @returns {{ text: string, replaced: number }} Rewritten text and replacement count.
 */
export function rewriteSurface(source, relativePath, previous, next, version) {
  if (relativePath === "CHANGELOG.md") {
    const spans = currentChangelogSpans(source);
    if (spans.length === 0) {
      fail("CHANGELOG.md has no `## [` or `## Unreleased` heading to scope the current section");
    }
    let replaced = 0;
    let cursor = 0;
    const pieces = [];
    for (const span of spans) {
      pieces.push(source.slice(cursor, span.start));
      const scoped = rewriteClaimSlots(source.slice(span.start, span.end), next);
      pieces.push(scoped.text);
      replaced += scoped.replaced;
      cursor = span.end;
    }
    pieces.push(source.slice(cursor));
    if (replaced === 0) fail("CHANGELOG.md current sections declare no test count to rewrite");
    return { text: pieces.join(""), replaced };
  }
  if (relativePath === "CLAUDE.md") {
    return rewriteClaudeSurface(source, version, next);
  }
  const pattern = tokenPattern(previous);
  const matches = [...source.matchAll(pattern)];
  if (matches.length === 0) fail(`${relativePath} declares no current test count (${previous})`);
  return { text: source.replace(pattern, String(next)), replaced: matches.length };
}

/**
 * Read the currently declared count from the two anchors and require them to agree.
 *
 * @param {string} [repoRoot] Absolute repository root.
 * @returns {number} The declared count.
 */
export function readDeclaredCount(repoRoot = DEFAULT_REPO_ROOT) {
  const found = new Map();
  for (const relativePath of ANCHORS) {
    const match = read(repoRoot, relativePath).match(/(?<![\d])(\d{3,5})(?=\s*\+?\s*tests?\b)/i);
    if (match === null) fail(`${relativePath} does not declare a recognisable test count`);
    found.set(relativePath, Number(match[1]));
  }
  const values = [...new Set(found.values())];
  if (values.length > 1) {
    fail(`anchors disagree about the declared count: ${[...found].map(([k, v]) => `${k}=${v}`).join(", ")}`);
  }
  return values[0];
}

/**
 * Read the version whose CLAUDE.md bullet the invariant treats as current.
 *
 * @param {string} [repoRoot] Absolute repository root.
 * @returns {string} The `package.json` version.
 */
export function readCurrentVersion(repoRoot = DEFAULT_REPO_ROOT) {
  const version = JSON.parse(read(repoRoot, "package.json")).version;
  if (typeof version !== "string" || version === "") fail("package.json declares no version");
  return version;
}

/**
 * Compute every change before writing anything, so a bad surface aborts the whole run.
 *
 * @param {string} [repoRoot] Absolute repository root.
 * @returns {{ declared: number, actual: number, version: string, changes: { relativePath: string, before: string, after: string, replaced: number }[], excludedHits: { relativePath: string, hits: number }[], staleSurfaces: string[] }} The plan.
 */
export function buildBumpPlan(repoRoot = DEFAULT_REPO_ROOT) {
  const actual = countSourceTests(repoRoot);
  const declared = readDeclaredCount(repoRoot);
  const version = readCurrentVersion(repoRoot);
  const changes = [];
  for (const relativePath of SURFACES) {
    const before = readFileSync(path.join(repoRoot, relativePath), "utf8");
    const { text, replaced } = rewriteSurface(before, relativePath, declared, actual, version);
    if (text !== before) changes.push({ relativePath, before, after: text, replaced });
  }
  const excludedHits = EXCLUDED.map((relativePath) => {
    const text = readFileSync(path.join(repoRoot, relativePath), "utf8");
    return { relativePath, hits: [...text.matchAll(tokenPattern(declared))].length };
  });
  const staleSurfaces = SURFACES.filter((relativePath) => {
    const text = readFileSync(path.join(repoRoot, relativePath), "utf8");
    return [...text.matchAll(tokenPattern(actual))].length === 0;
  });
  return { declared, actual, version, changes, excludedHits, staleSurfaces };
}

/**
 * Rewrite every surface, then re-read the tree to prove the move landed.
 *
 * @param {{ repoRoot?: string, check?: boolean, dryRun?: boolean }} [options] Root plus mode flags.
 * @returns {{ declared: number, actual: number, changedFiles: string[], replacedSlots: number, excludedHits: { relativePath: string, hits: number }[], messages: string[] }} Result summary.
 */
export function bumpTestCount(options = {}) {
  const repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT;
  const plan = buildBumpPlan(repoRoot);
  const messages = [
    `bump-test-count: declared ${plan.declared} → actual ${plan.actual}`,
    `bump-test-count: ${plan.changes.length} surface(s) to rewrite, ${plan.staleSurfaces.length} stale`
  ];
  for (const hit of plan.excludedHits) {
    if (hit.hits > 0) {
      messages.push(`bump-test-count: left ${hit.hits} digit match(es) in ${hit.relativePath} (machine-generated pin)`);
    }
  }
  if (options.check === true || options.dryRun === true) {
    const untouched = {
      declared: plan.declared,
      actual: plan.actual,
      changedFiles: [],
      replacedSlots: 0,
      excludedHits: plan.excludedHits,
      messages
    };
    if (plan.declared === plan.actual) {
      messages.push("bump-test-count: surfaces already agree with the census");
      return untouched;
    }
    const detail = plan.changes
      .map((change) => `bump-test-count: stale ${change.relativePath} (${change.replaced} slot(s))`)
      .join("\n");
    if (options.check === true) {
      fail(`surfaces disagree with the census (${plan.declared} declared, ${plan.actual} actual):\n${detail}`);
    }
    messages.push(detail);
    return untouched;
  }
  for (const change of plan.changes) {
    writeFileSync(path.join(repoRoot, change.relativePath), change.after);
  }
  // Post-write proof: every surface now carries the new count and no longer the old one.
  for (const change of plan.changes) {
    const written = readFileSync(path.join(repoRoot, change.relativePath), "utf8");
    if (!written.includes(String(plan.actual))) {
      fail(`${change.relativePath} does not carry ${plan.actual} after the rewrite — aborting`);
    }
    const staleLeft = [...written.matchAll(tokenPattern(plan.declared))].length;
    const historical = change.relativePath === "CHANGELOG.md" || change.relativePath === "CLAUDE.md";
    if (staleLeft > 0 && !historical) {
      fail(`${change.relativePath} still declares ${plan.declared} in ${staleLeft} place(s) — aborting`);
    }
  }
  return {
    declared: plan.declared,
    actual: plan.actual,
    changedFiles: plan.changes.map((change) => change.relativePath),
    replacedSlots: plan.changes.reduce((sum, change) => sum + change.replaced, 0),
    excludedHits: plan.excludedHits,
    messages
  };
}

/**
 * @returns {number} Process exit code.
 */
async function main() {
  try {
    const options = { check: process.argv.includes("--check"), dryRun: process.argv.includes("--dry-run") };
    const result = bumpTestCount(options);
    for (const message of result.messages) process.stdout.write(`${message}\n`);
    if (result.changedFiles.length > 0) {
      const files = result.changedFiles.length;
      const slots = result.replacedSlots;
      process.stdout.write(`bump-test-count: rewrote ${files} file(s), ${slots} slot(s)\n`);
      for (const relativePath of result.changedFiles) process.stdout.write(`bump-test-count:   ${relativePath}\n`);
    }
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)} — aborting\n`);
    return 1;
  }
}

if (isEntrypoint(import.meta.url)) process.exitCode = await main();
