#!/usr/bin/env node
// v3.11.7-rc.5 — regenerate/check the deterministic emitted MCP schema inventory.

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { isEntrypoint } from "./lib/entrypoint.mjs";
import {
  captureEmittedSchemaInventory,
  compareSchemaInventories,
  evaluateClientProfiles,
  stablePrettyJson,
  validateClientProfileDocument,
  validateProjectSchemaPolicy
} from "./lib/mcp-schema-conformance.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const distEntry = path.join(repoRoot, "dist", "index.js");
const inventoryPath = path.join(repoRoot, "tests", "fixtures", "mcp-schema-inventory.v1.json");
const profilesPath = path.join(repoRoot, "tests", "fixtures", "mcp-client-profiles.v1.json");

async function readJson(filename) {
  return JSON.parse(await readFile(filename, "utf8"));
}

async function main() {
  const write = process.argv.slice(2).includes("--write");
  const unknown = process.argv.slice(2).filter((arg) => arg !== "--write");
  if (unknown.length > 0) throw new Error(`unknown argument(s): ${unknown.join(", ")}`);
  if (!existsSync(distEntry)) {
    throw new Error(`dist/index.js is missing; run npm run build first`);
  }

  const profiles = await readJson(profilesPath);
  const profileErrors = validateClientProfileDocument(profiles);
  if (profileErrors.length > 0) {
    throw new Error(`invalid client profiles:\n${profileErrors.join("\n")}`);
  }

  const actual = await captureEmittedSchemaInventory(distEntry);
  const policyErrors = validateProjectSchemaPolicy(actual.tools);
  const clientViolations = evaluateClientProfiles(actual.tools, profiles);
  if (policyErrors.length > 0 || clientViolations.length > 0) {
    const messages = [
      ...policyErrors,
      ...clientViolations.map((entry) => `${entry.profileId} (${entry.client}) rejects ${entry.path} via ${entry.rule}`)
    ];
    throw new Error(`schema conformance failed:\n${messages.join("\n")}`);
  }

  if (write) {
    await writeFile(inventoryPath, stablePrettyJson(actual));
    console.log(`[schema-inventory] wrote ${inventoryPath}`);
    console.log(`[schema-inventory] ${actual.toolCount} tools · ${actual.schemaDigest}`);
    return;
  }

  const expected = await readJson(inventoryPath);
  const comparison = compareSchemaInventories(actual, expected);
  if (!comparison.matches) {
    throw new Error(`${comparison.summary}\nRegenerate intentionally with: npm run schema:inventory -- --write`);
  }
  console.log(`[schema-inventory] OK — ${comparison.summary}`);
}

if (isEntrypoint(import.meta.url)) {
  main().catch((error) => {
    console.error(`[schema-inventory] FAIL — ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
