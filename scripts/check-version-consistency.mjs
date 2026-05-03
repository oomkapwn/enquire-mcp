#!/usr/bin/env node
// Asserts that the version is identical across all surfaces that publish it:
//   - package.json
//   - package-lock.json (root + packages[""])
//   - src/index.ts VERSION constant
//   - latest CHANGELOG.md heading
// Run as part of CI so a forgotten bump in any one place fails the build
// instead of shipping silent drift (which we hit on v0.7.4 → 0.7.5).

import { readFile } from "node:fs/promises";

const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
const indexSrc = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
const changelog = await readFile(new URL("../CHANGELOG.md", import.meta.url), "utf8");

const versionFromIndex = /const VERSION = "([^"]+)"/.exec(indexSrc)?.[1];
const latestChangelog = /^## \[([^\]]+)\]/m.exec(changelog)?.[1];

const surfaces = {
  "package.json:version": pkg.version,
  "package-lock.json:root version": lock.version,
  'package-lock.json:packages[""].version': lock.packages?.[""]?.version,
  "src/index.ts:VERSION": versionFromIndex,
  "CHANGELOG.md:latest heading": latestChangelog
};

const distinct = new Set(Object.values(surfaces));
if (distinct.size === 1) {
  process.stdout.write(`OK — version ${[...distinct][0]} is consistent across ${Object.keys(surfaces).length} surfaces\n`);
  process.exit(0);
}

process.stderr.write("Version drift detected:\n");
for (const [where, v] of Object.entries(surfaces)) {
  process.stderr.write(`  ${where}: ${v ?? "(missing)"}\n`);
}
process.exit(1);
