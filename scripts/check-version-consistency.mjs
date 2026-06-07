#!/usr/bin/env node
// Asserts that the version is identical across all surfaces that publish it:
//   - package.json
//   - package-lock.json (root + packages[""])
//   - src/index.ts VERSION constant
//   - latest CHANGELOG.md heading
//   - server.json (MCP Registry manifest — added v3.8.0-rc.18 per external
//     audit M-REG-1: rc.13 server.json was 4 RCs behind npm before this
//     gate caught it)
// Run as part of CI so a forgotten bump in any one place fails the build
// instead of shipping silent drift (which we hit on v0.7.4 → 0.7.5 + the
// 4-RC server.json drift caught by the M-REG-1 external-audit finding on rc.15).

import { readFile } from "node:fs/promises";

const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
const indexSrc = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
const changelog = await readFile(new URL("../CHANGELOG.md", import.meta.url), "utf8");
// v3.8.0-rc.18 M-REG-1 — extend gate to server.json (MCP Registry manifest).
const serverJson = JSON.parse(await readFile(new URL("../server.json", import.meta.url), "utf8"));

const versionFromIndex = /const VERSION = "([^"]+)"/.exec(indexSrc)?.[1];
const latestChangelog = /^## \[([^\]]+)\]/m.exec(changelog)?.[1];

const surfaces = {
  "package.json:version": pkg.version,
  "package-lock.json:root version": lock.version,
  'package-lock.json:packages[""].version': lock.packages?.[""]?.version,
  "src/index.ts:VERSION": versionFromIndex,
  "CHANGELOG.md:latest heading": latestChangelog,
  "server.json:version": serverJson.version,
  "server.json:packages[0].version": serverJson.packages?.[0]?.version
};

const errors = [];

const distinct = new Set(Object.values(surfaces));
if (distinct.size !== 1) {
  errors.push("Version drift across published surfaces:");
  for (const [where, v] of Object.entries(surfaces)) errors.push(`  ${where}: ${v ?? "(missing)"}`);
}

// v3.10.0-rc.32 — CLAUDE.md status roll-up `@rc`=<version> currency guard.
// This is NOT one of the published-version surfaces above; it's the status-
// summary claim that recurringly went stale (the documented "α-class": the
// roll-up froze at rc.12 / rc.4 / v3.7.4 / v3.7.9 / v3.8.4 — and again post-
// rc.31, frozen at `@rc`=rc.26 while the real @rc was rc.31, because no gate
// pinned the roll-up's RC version). Only enforced on an `-rc.N` build (on a
// stable release the roll-up's `@rc` legitimately refers to the prior RC line).
// The roll-up MUST carry the marker `... (current roll-up; \`@rc\`=X.Y.Z-rc.N ...`.
if (/-rc\.\d+$/.test(pkg.version)) {
  const claudeMd = await readFile(new URL("../CLAUDE.md", import.meta.url), "utf8");
  const rollupRc = /current roll-up;\s*`@rc`\s*=\s*(\d+\.\d+\.\d+-rc\.\d+)/.exec(claudeMd)?.[1];
  if (rollupRc !== pkg.version) {
    errors.push(
      `CLAUDE.md status roll-up \`@rc\`=${rollupRc ?? "(marker missing)"} but package.json is ${pkg.version} — ` +
        "advance the roll-up's `(current roll-up; `@rc`=<version>...)` marker (and its RC range + summary) to the " +
        "current release. This is the α-class status-stale guard (added v3.10.0-rc.32)."
    );
  }
}

if (errors.length === 0) {
  process.stdout.write(
    `OK — version ${pkg.version} consistent across ${Object.keys(surfaces).length} surfaces + CLAUDE.md roll-up @rc currency\n`
  );
  process.exit(0);
}

process.stderr.write(`${errors.join("\n")}\n`);
process.exit(1);
