// v3.11.7-rc.5 — generalized emitted MCP schema-conformance gate.
//
// The rc.17 fix for issues #354/#360 rejected one known-bad shape
// (`items: [...]`) but did not pin the rest of the tools/list contract. This
// gate now captures the maximally-enabled built server and checks:
//   1. exact deterministic schema inventory (every tool, every schema node),
//   2. project-owned dialect/root/size/depth policy, and
//   3. versioned, evidence-backed per-client rules.
//
// Client constraints are intentionally NOT promoted to a universal lowest
// common denominator. Negative controls below prove both directions: known
// array-items regressions fail the three reported clients, while anyOf/$ref/
// additionalProperties remain allowed absent evidence for a specific client.

import { existsSync, promises as fs } from "node:fs";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error — .mjs audit helper, no type declarations (CLI guarded by isEntrypoint).
import {
  buildSchemaInventory,
  captureEmittedSchemaInventory,
  compareSchemaInventories,
  evaluateClientProfiles,
  findArrayItems,
  SCHEMA_LIMITS,
  validateClientProfileDocument,
  validateProjectSchemaPolicy
} from "../scripts/lib/mcp-schema-conformance.mjs";
import { MAX_RESEARCH_SUBQUERIES } from "../src/research-protocol.js";

const repoRoot = path.resolve(__dirname, "..");
const distEntry = path.join(repoRoot, "dist", "index.js");
const inventoryFixture = path.join(repoRoot, "tests", "fixtures", "mcp-schema-inventory.v1.json");
const profilesFixture = path.join(repoRoot, "tests", "fixtures", "mcp-client-profiles.v1.json");
const distExists = (): boolean => existsSync(distEntry);

interface SchemaObject extends Record<string, unknown> {
  $schema?: string;
  type?: string;
  properties?: Record<string, SchemaObject>;
  items?: unknown;
}

interface SchemaTool {
  name: string;
  inputSchema: SchemaObject;
  outputSchema?: SchemaObject;
}

interface SchemaInventory {
  formatVersion: number;
  schemaDigest: string;
  toolCount: number;
  tools: SchemaTool[];
}

interface ClientRestriction {
  rule: string;
  evidence: unknown[];
}

interface ClientProfile {
  id: string;
  restrictions: ClientRestriction[];
}

interface ClientProfileDocument {
  formatVersion: number;
  policy: {
    mode: string;
    universalLowestCommonDenominator: boolean;
    realClientSmokeTargetIds: string[];
  };
  profiles: ClientProfile[];
  nonBindingEvidence: Array<{ enforced: boolean }>;
}

let inventory: SchemaInventory | null = null;
let profiles: ClientProfileDocument;

async function readJson<T>(filename: string): Promise<T> {
  return JSON.parse(await fs.readFile(filename, "utf8")) as T;
}

function clonedTools(): SchemaTool[] {
  if (!inventory) throw new Error("schema inventory was not captured");
  return structuredClone(inventory.tools);
}

describe("emitted MCP schema conformance (v3.11.7-rc.5)", () => {
  beforeAll(async () => {
    profiles = await readJson<ClientProfileDocument>(profilesFixture);
    if (distExists()) {
      inventory = (await captureEmittedSchemaInventory(distEntry)) as SchemaInventory;
    }
  }, 60_000);

  // CI-GUARD: dist is always built before `npm test` in CI, so this behavioral
  // gate MUST run there — fail loud if the precondition vanishes.
  it("CI GUARD — dist is built in CI so the emitted-schema gate actually runs", () => {
    if (!process.env.CI) return;
    expect(distExists(), "dist must be built in CI so tools/list is inspectable").toBe(true);
  });

  it("the maximally-enabled tools/list exactly matches the committed deterministic inventory", async (ctx) => {
    if (!inventory) return ctx.skip();
    const expected = await readJson<SchemaInventory>(inventoryFixture);
    const comparison = compareSchemaInventories(inventory, expected);
    expect(comparison.matches, comparison.summary).toBe(true);
    expect(inventory).toEqual(expected);
    expect(inventory.toolCount).toBeGreaterThan(30);
    expect(buildSchemaInventory([...inventory.tools].reverse())).toEqual(inventory);
  });

  it("every emitted schema satisfies the declared-dialect, object-root, size, and depth policy", (ctx) => {
    if (!inventory) return ctx.skip();
    expect(validateProjectSchemaPolicy(inventory.tools)).toEqual([]);
  });

  it("the five versioned client profiles are valid and the emitted inventory passes their evidenced rules", (ctx) => {
    if (!inventory) return ctx.skip();
    expect(validateClientProfileDocument(profiles)).toEqual([]);
    expect(profiles.policy.mode).toBe("per-client-evidence");
    expect(profiles.policy.universalLowestCommonDenominator).toBe(false);
    expect([...profiles.policy.realClientSmokeTargetIds].sort()).toEqual(
      ["chatgpt-hosted-mcp", "claude-desktop-mcp", "cursor-mcp", "gemini-hosted-mcp", "grok-hosted-mcp"].sort()
    );
    expect(evaluateClientProfiles(inventory.tools, profiles)).toEqual([]);
  });

  it("the PDF tools' pages is a homogeneous 2-array in the real emitted schema", (ctx) => {
    if (!inventory) return ctx.skip();
    for (const name of ["obsidian_read_pdf", "obsidian_ocr_pdf"]) {
      const tool = inventory.tools.find((entry) => entry.name === name);
      expect(tool, `${name} must be registered`).toBeDefined();
      const pages = tool?.inputSchema.properties?.pages;
      expect(pages?.type, `${name}.pages type`).toBe("array");
      expect(Array.isArray(pages?.items), `${name}.pages.items must NOT be an array`).toBe(false);
      expect(typeof pages?.items, `${name}.pages.items must be a schema object`).toBe("object");
    }
  });

  it("context_pack exposes the bearer-reachable subquery fan-out cap in its real emitted schema", (ctx) => {
    if (!inventory) return ctx.skip();
    const tool = inventory.tools.find((entry) => entry.name === "obsidian_context_pack");
    expect(tool, "obsidian_context_pack must be registered").toBeDefined();
    const subqueries = tool?.inputSchema.properties?.subqueries;
    expect(subqueries?.type).toBe("array");
    expect(subqueries?.maxItems).toBe(MAX_RESEARCH_SUBQUERIES);
    expect((subqueries?.items as SchemaObject | undefined)?.maxLength).toBe(4096);
  });

  it("NEGATIVE: an array-valued items mutation is rejected by the three reported clients", (ctx) => {
    if (!inventory) return ctx.skip();
    const mutant = clonedTools();
    const pdf = mutant.find((entry) => entry.name === "obsidian_read_pdf");
    const pages = pdf?.inputSchema.properties?.pages;
    expect(pages).toBeDefined();
    if (pages) pages.items = [{ type: "integer" }, { type: "integer" }];

    // Important boundary: draft-07 tuple items is valid JSON Schema and remains
    // within project resource bounds. The rejection belongs to named profiles.
    expect(validateProjectSchemaPolicy(mutant)).toEqual([]);
    expect(findArrayItems(mutant)).toHaveLength(1);
    const violations = evaluateClientProfiles(mutant, profiles);
    expect(violations.map((entry: { profileId: string }) => entry.profileId).sort()).toEqual(
      ["chatgpt-hosted-mcp", "gemini-hosted-mcp", "grok-hosted-mcp"].sort()
    );
  });

  it("NEGATIVE: any single emitted-schema mutation produces a named inventory diff", (ctx) => {
    if (!inventory) return ctx.skip();
    const mutant = clonedTools();
    const listNotes = mutant.find((entry) => entry.name === "obsidian_list_notes");
    expect(listNotes).toBeDefined();
    if (listNotes) {
      listNotes.inputSchema.properties = {
        ...listNotes.inputSchema.properties,
        _inventory_negative_control: { type: "string" }
      };
    }
    const changed = buildSchemaInventory(mutant) as SchemaInventory;
    const comparison = compareSchemaInventories(changed, inventory);
    expect(comparison.matches).toBe(false);
    expect(comparison.changed).toEqual(["obsidian_list_notes"]);
    expect(comparison.summary).toContain("obsidian_list_notes");
  });

  it("NEGATIVE: missing dialect, non-object root, and resource-bound mutations trip project policy", (ctx) => {
    if (!inventory) return ctx.skip();
    const malformed = clonedTools();
    const malformedTarget = malformed[0];
    expect(malformedTarget).toBeDefined();
    if (malformedTarget) {
      delete malformedTarget.inputSchema.$schema;
      malformedTarget.inputSchema.type = "string";
    }
    const malformedErrors = validateProjectSchemaPolicy(malformed).join("\n");
    expect(malformedErrors).toMatch(/must declare its JSON Schema dialect/);
    expect(malformedErrors).toMatch(/root type must be object/);

    const oversized = clonedTools();
    const first = oversized[0];
    expect(first).toBeDefined();
    if (first) first.inputSchema.description = "x".repeat(SCHEMA_LIMITS.maxToolBytes);
    expect(validateProjectSchemaPolicy(oversized).join("\n")).toMatch(/schema bytes .* exceed/);

    const overDeep = clonedTools();
    const deepTarget = overDeep[0];
    expect(deepTarget).toBeDefined();
    let nested: SchemaObject = { type: "string" };
    for (let index = 0; index <= SCHEMA_LIMITS.maxDepth; index++) nested = { anyOf: [nested] };
    if (deepTarget) {
      deepTarget.inputSchema.properties = {
        ...deepTarget.inputSchema.properties,
        _depth_negative_control: nested
      };
    }
    expect(validateProjectSchemaPolicy(overDeep).join("\n")).toMatch(/schema depth .* exceeds/);
  });

  it("NEGATIVE: missing evidence, unknown rules, and binding generic docs fail closed", () => {
    const noEvidence = structuredClone(profiles);
    const firstRestriction = noEvidence.profiles[0]?.restrictions[0];
    expect(firstRestriction).toBeDefined();
    if (firstRestriction) firstRestriction.evidence = [];
    expect(() => evaluateClientProfiles([], noEvidence)).toThrow(/evidence must contain at least one source/);

    const unknownRule = structuredClone(profiles);
    const unknownRestriction = unknownRule.profiles[0]?.restrictions[0];
    expect(unknownRestriction).toBeDefined();
    if (unknownRestriction) unknownRestriction.rule = "ban-everything-unverified";
    expect(() => evaluateClientProfiles([], unknownRule)).toThrow(/rule is unsupported/);

    const bindingGenericDocs = structuredClone(profiles);
    const genericEvidence = bindingGenericDocs.nonBindingEvidence[0];
    expect(genericEvidence).toBeDefined();
    if (genericEvidence) genericEvidence.enforced = true;
    expect(() => evaluateClientProfiles([], bindingGenericDocs)).toThrow(/enforced must be false/);
  });

  it("NEGATIVE: client profiles do not blanket-ban anyOf, refs, or additionalProperties", () => {
    const supportedConstructs: SchemaTool[] = [
      {
        name: "schema_feature_negative_control",
        inputSchema: {
          $schema: "http://json-schema.org/draft-07/schema#",
          type: "object",
          definitions: {
            scalar: {
              anyOf: [{ type: "string" }, { type: "number" }]
            }
          },
          properties: {
            value: { $ref: "#/definitions/scalar" },
            labels: { type: "object", additionalProperties: { type: "string" } }
          }
        }
      }
    ];
    expect(validateProjectSchemaPolicy(supportedConstructs)).toEqual([]);
    expect(evaluateClientProfiles(supportedConstructs, profiles)).toEqual([]);
  });
});
