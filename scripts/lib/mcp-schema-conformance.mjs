// v3.11.7-rc.5 — deterministic MCP tool-schema inventory + evidence-backed
// per-client compatibility profiles.
//
// This module deliberately keeps three different contracts separate:
//   1. project schema policy (declared dialect, object root, resource bounds),
//   2. exact emitted-schema inventory drift, and
//   3. client-specific restrictions supported by named evidence.
//
// A provider report must never silently become a universal JSON-Schema ban.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const INVENTORY_FORMAT_VERSION = 1;
export const CLIENT_PROFILE_FORMAT_VERSION = 1;
export const INVENTORY_PROTOCOL_VERSION = "2025-06-18";

export const SCHEMA_LIMITS = Object.freeze({
  maxToolBytes: 16 * 1024,
  maxTotalBytes: 128 * 1024,
  maxDepth: 16
});

const PROJECT_DIALECTS = new Set([
  "http://json-schema.org/draft-07/schema#",
  "https://json-schema.org/draft-07/schema#",
  "https://json-schema.org/draft/2020-12/schema",
  "https://json-schema.org/draft/2020-12/schema#"
]);

const TRACKED_KEYWORDS = [
  "$defs",
  "$ref",
  "additionalProperties",
  "allOf",
  "anyOf",
  "const",
  "definitions",
  "enum",
  "format",
  "items",
  "maxItems",
  "maxLength",
  "maximum",
  "minItems",
  "minLength",
  "minimum",
  "not",
  "oneOf",
  "patternProperties",
  "prefixItems",
  "required"
];

const SUPPORTED_CLIENT_RULES = new Set(["forbid-array-items"]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Recursively sort object keys while preserving array order.
 * Throws for values that cannot be represented faithfully in JSON.
 * @param {unknown} value
 * @returns {unknown}
 */
export function canonicalize(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non-finite numbers are not valid inventory JSON");
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry));
  if (isRecord(value)) {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      const entry = value[key];
      if (entry === undefined) throw new TypeError(`undefined is not valid inventory JSON (${key})`);
      out[key] = canonicalize(entry);
    }
    return out;
  }
  throw new TypeError(`unsupported inventory value: ${typeof value}`);
}

/**
 * Canonical compact JSON used for byte accounting and hashes.
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

/**
 * Stable human-readable JSON used by the committed fixtures.
 * @param {unknown} value
 * @returns {string}
 */
export function stablePrettyJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function jsonDepth(value) {
  if (!isRecord(value) && !Array.isArray(value)) return 0;
  const children = Array.isArray(value) ? value : Object.values(value);
  if (children.length === 0) return 1;
  return 1 + Math.max(...children.map((entry) => jsonDepth(entry)));
}

function schemaEnvelope(tool) {
  const envelope = { inputSchema: tool.inputSchema };
  if (tool.outputSchema !== undefined) envelope.outputSchema = tool.outputSchema;
  return envelope;
}

function normalizeTools(tools) {
  if (!Array.isArray(tools)) throw new TypeError("tools/list result must contain a tools array");
  const normalized = tools.map((tool, index) => {
    if (!isRecord(tool)) throw new TypeError(`tools[${index}] must be an object`);
    if (typeof tool.name !== "string" || tool.name.length === 0) {
      throw new TypeError(`tools[${index}].name must be a non-empty string`);
    }
    if (!isRecord(tool.inputSchema)) {
      throw new TypeError(`${tool.name}.inputSchema must be a JSON Schema object`);
    }
    const entry = {
      name: tool.name,
      inputSchema: canonicalize(tool.inputSchema)
    };
    if (tool.outputSchema !== undefined) {
      if (!isRecord(tool.outputSchema)) {
        throw new TypeError(`${tool.name}.outputSchema must be a JSON Schema object when present`);
      }
      entry.outputSchema = canonicalize(tool.outputSchema);
    }
    return entry;
  });
  // Code-unit comparison is locale-independent; localeCompare can vary with
  // the runner's ICU/locale and would make the committed inventory non-portable.
  return normalized.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function walkJson(node, at, visit) {
  if (!isRecord(node) && !Array.isArray(node)) return;
  visit(node, at);
  if (Array.isArray(node)) {
    for (let index = 0; index < node.length; index++) {
      walkJson(node[index], `${at}[${index}]`, visit);
    }
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    walkJson(value, `${at}.${key}`, visit);
  }
}

/**
 * Return every tracked JSON-Schema keyword path in a normalized tool list.
 * @param {Array<object>} tools
 * @returns {Record<string, string[]>}
 */
export function collectSchemaKeywordPaths(tools) {
  const out = Object.fromEntries(TRACKED_KEYWORDS.map((keyword) => [keyword, []]));
  for (const tool of tools) {
    for (const schemaKey of ["inputSchema", "outputSchema"]) {
      const schema = tool[schemaKey];
      if (!isRecord(schema)) continue;
      walkJson(schema, `${tool.name}.${schemaKey}`, (node, at) => {
        if (!isRecord(node)) return;
        for (const keyword of TRACKED_KEYWORDS) {
          if (Object.hasOwn(node, keyword)) out[keyword].push(`${at}.${keyword}`);
        }
      });
    }
  }
  return out;
}

function calculateMetrics(tools) {
  const perTool = tools.map((tool) => {
    const envelope = schemaEnvelope(tool);
    return {
      name: tool.name,
      bytes:
        Buffer.byteLength(canonicalJson(envelope.inputSchema)) +
        (envelope.outputSchema === undefined ? 0 : Buffer.byteLength(canonicalJson(envelope.outputSchema))),
      depth: Math.max(
        jsonDepth(envelope.inputSchema),
        envelope.outputSchema === undefined ? 0 : jsonDepth(envelope.outputSchema)
      )
    };
  });
  const maxBytes = perTool.reduce((largest, current) => (current.bytes > largest.bytes ? current : largest), {
    name: "",
    bytes: 0,
    depth: 0
  });
  const maxDepth = perTool.reduce((deepest, current) => (current.depth > deepest.depth ? current : deepest), {
    name: "",
    bytes: 0,
    depth: 0
  });
  const keywordPaths = collectSchemaKeywordPaths(tools);
  return {
    totalSchemaBytes: perTool.reduce((sum, entry) => sum + entry.bytes, 0),
    maxSchemaBytes: { name: maxBytes.name, bytes: maxBytes.bytes },
    maxSchemaDepth: { name: maxDepth.name, depth: maxDepth.depth },
    keywordCounts: Object.fromEntries(TRACKED_KEYWORDS.map((keyword) => [keyword, keywordPaths[keyword].length])),
    perTool
  };
}

/**
 * Build the deterministic, committed inventory from the exact tools/list payload.
 * Descriptions and annotations are intentionally excluded: this gate owns schemas.
 * @param {Array<object>} tools
 * @returns {object}
 */
export function buildSchemaInventory(tools) {
  const normalized = normalizeTools(tools);
  return canonicalize({
    formatVersion: INVENTORY_FORMAT_VERSION,
    schemaDigest: sha256(normalized),
    toolCount: normalized.length,
    metrics: calculateMetrics(normalized),
    tools: normalized
  });
}

/**
 * Compare two inventory documents without trusting their embedded digest fields.
 * @param {object} actual
 * @param {object} expected
 * @returns {{matches:boolean, added:string[], removed:string[], changed:string[], summary:string}}
 */
export function compareSchemaInventories(actual, expected) {
  const actualTools = new Map((actual?.tools ?? []).map((tool) => [tool.name, tool]));
  const expectedTools = new Map((expected?.tools ?? []).map((tool) => [tool.name, tool]));
  const added = [...actualTools.keys()].filter((name) => !expectedTools.has(name)).sort();
  const removed = [...expectedTools.keys()].filter((name) => !actualTools.has(name)).sort();
  const changed = [...actualTools.keys()]
    .filter((name) => expectedTools.has(name))
    .filter((name) => canonicalJson(actualTools.get(name)) !== canonicalJson(expectedTools.get(name)))
    .sort();
  const matches = canonicalJson(actual) === canonicalJson(expected);
  const detail = [
    added.length ? `added=${added.join(",")}` : "",
    removed.length ? `removed=${removed.join(",")}` : "",
    changed.length ? `changed=${changed.join(",")}` : ""
  ].filter(Boolean);
  return {
    matches,
    added,
    removed,
    changed,
    summary: matches
      ? `inventory matches ${actual?.schemaDigest ?? "(no digest)"}`
      : `schema inventory drift${detail.length ? `: ${detail.join("; ")}` : " (metadata or digest changed)"}`
  };
}

/**
 * Project-owned schema policy. This is intentionally not called a universal
 * client contract: tuple-form draft-07 schemas, for example, are valid JSON
 * Schema even though three hosted-client reports reject them.
 * @param {Array<object>} tools
 * @param {{maxToolBytes:number,maxTotalBytes:number,maxDepth:number}} limits
 * @returns {string[]}
 */
export function validateProjectSchemaPolicy(tools, limits = SCHEMA_LIMITS) {
  const errors = [];
  let normalized;
  try {
    normalized = normalizeTools(tools);
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
  if (normalized.length === 0) errors.push("tools/list emitted zero tools");
  const seen = new Set();
  for (const tool of normalized) {
    if (seen.has(tool.name)) errors.push(`duplicate tool name: ${tool.name}`);
    seen.add(tool.name);
    for (const schemaKey of ["inputSchema", "outputSchema"]) {
      const schema = tool[schemaKey];
      if (schema === undefined) continue;
      if (schema.$schema === undefined) {
        errors.push(`${tool.name}.${schemaKey} must declare its JSON Schema dialect`);
      } else if (!PROJECT_DIALECTS.has(schema.$schema)) {
        errors.push(`${tool.name}.${schemaKey} uses unsupported project dialect: ${schema.$schema}`);
      }
      if (schema.type !== "object") {
        errors.push(`${tool.name}.${schemaKey} root type must be object`);
      }
    }
  }
  const metrics = calculateMetrics(normalized);
  if (metrics.totalSchemaBytes > limits.maxTotalBytes) {
    errors.push(`total schema bytes ${metrics.totalSchemaBytes} exceed ${limits.maxTotalBytes}`);
  }
  if (metrics.maxSchemaBytes.bytes > limits.maxToolBytes) {
    errors.push(
      `${metrics.maxSchemaBytes.name} schema bytes ${metrics.maxSchemaBytes.bytes} exceed ${limits.maxToolBytes}`
    );
  }
  if (metrics.maxSchemaDepth.depth > limits.maxDepth) {
    errors.push(
      `${metrics.maxSchemaDepth.name} schema depth ${metrics.maxSchemaDepth.depth} exceeds ${limits.maxDepth}`
    );
  }
  return errors;
}

/**
 * Paths where draft-04/07 tuple validation uses an array-valued `items`.
 * This is valid in draft-07; client profiles decide whether it is rejected.
 * @param {Array<object>} tools
 * @returns {string[]}
 */
export function findArrayItems(tools) {
  const out = [];
  for (const tool of tools) {
    for (const schemaKey of ["inputSchema", "outputSchema"]) {
      const schema = tool[schemaKey];
      if (!isRecord(schema)) continue;
      walkJson(schema, `${tool.name}.${schemaKey}`, (node, at) => {
        if (isRecord(node) && Array.isArray(node.items)) {
          out.push(`${at}.items (array of ${node.items.length} schemas)`);
        }
      });
    }
  }
  return out;
}

/**
 * Validate profile metadata before any rule is evaluated. Unknown rules fail
 * closed instead of being silently skipped.
 * @param {unknown} document
 * @returns {string[]}
 */
export function validateClientProfileDocument(document) {
  const errors = [];
  if (!isRecord(document)) return ["client profile document must be an object"];
  if (document.formatVersion !== CLIENT_PROFILE_FORMAT_VERSION) {
    errors.push(`client profile formatVersion must be ${CLIENT_PROFILE_FORMAT_VERSION}, got ${document.formatVersion}`);
  }
  if (!isRecord(document.policy)) {
    errors.push("client profile policy must be an object");
  } else {
    if (document.policy.mode !== "per-client-evidence") {
      errors.push("client profile policy.mode must be per-client-evidence");
    }
    if (document.policy.universalLowestCommonDenominator !== false) {
      errors.push("client profile policy must explicitly disable a universal lowest-common-denominator");
    }
  }
  if (!Array.isArray(document.profiles) || document.profiles.length === 0) {
    errors.push("client profile document must contain profiles");
    return errors;
  }
  const ids = new Set();
  for (const [index, profile] of document.profiles.entries()) {
    const at = `profiles[${index}]`;
    if (!isRecord(profile)) {
      errors.push(`${at} must be an object`);
      continue;
    }
    if (typeof profile.id !== "string" || profile.id.length === 0) errors.push(`${at}.id must be non-empty`);
    else if (ids.has(profile.id)) errors.push(`duplicate client profile id: ${profile.id}`);
    else ids.add(profile.id);
    if (typeof profile.client !== "string" || profile.client.length === 0) {
      errors.push(`${at}.client must be non-empty`);
    }
    if (!Number.isInteger(profile.profileRevision) || profile.profileRevision < 1) {
      errors.push(`${at}.profileRevision must be a positive integer`);
    }
    if (typeof profile.clientVersion !== "string" || profile.clientVersion.length === 0) {
      errors.push(`${at}.clientVersion must be explicit (use unverified when unknown)`);
    }
    if (
      !isRecord(profile.verification) ||
      !["reported", "unverified", "verified"].includes(profile.verification.status)
    ) {
      errors.push(`${at}.verification.status must be reported, verified, or unverified`);
    }
    if (!Array.isArray(profile.restrictions)) {
      errors.push(`${at}.restrictions must be an array`);
      continue;
    }
    if (profile.verification?.status === "unverified" && profile.restrictions.length > 0) {
      errors.push(`${at} cannot enforce restrictions while verification is unverified`);
    }
    for (const [ruleIndex, restriction] of profile.restrictions.entries()) {
      const ruleAt = `${at}.restrictions[${ruleIndex}]`;
      if (!isRecord(restriction)) {
        errors.push(`${ruleAt} must be an object`);
        continue;
      }
      if (typeof restriction.id !== "string" || restriction.id.length === 0) {
        errors.push(`${ruleAt}.id must be non-empty`);
      }
      if (!SUPPORTED_CLIENT_RULES.has(restriction.rule)) {
        errors.push(`${ruleAt}.rule is unsupported: ${restriction.rule}`);
      }
      if (restriction.scope !== "tools/list.inputSchema") {
        errors.push(`${ruleAt}.scope must be tools/list.inputSchema`);
      }
      if (!Array.isArray(restriction.evidence) || restriction.evidence.length === 0) {
        errors.push(`${ruleAt}.evidence must contain at least one source`);
        continue;
      }
      for (const [evidenceIndex, evidence] of restriction.evidence.entries()) {
        const evidenceAt = `${ruleAt}.evidence[${evidenceIndex}]`;
        if (!isRecord(evidence)) {
          errors.push(`${evidenceAt} must be an object`);
          continue;
        }
        if (typeof evidence.kind !== "string" || evidence.kind.length === 0) {
          errors.push(`${evidenceAt}.kind must be non-empty`);
        }
        if (typeof evidence.observedAt !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(evidence.observedAt)) {
          errors.push(`${evidenceAt}.observedAt must be YYYY-MM-DD`);
        }
        if (typeof evidence.url !== "string" || !/^https:\/\//.test(evidence.url)) {
          errors.push(`${evidenceAt}.url must be an https URL`);
        }
      }
    }
  }
  const smokeTargets = document.policy?.realClientSmokeTargetIds;
  if (!Array.isArray(smokeTargets) || smokeTargets.length === 0) {
    errors.push("client profile policy.realClientSmokeTargetIds must be non-empty");
  } else {
    for (const id of smokeTargets) {
      if (typeof id !== "string" || id.length === 0) {
        errors.push("real-client smoke target ids must be non-empty strings");
        continue;
      }
      if (!ids.has(id)) errors.push(`real-client smoke target has no profile: ${id}`);
    }
    if (new Set(smokeTargets).size !== smokeTargets.length) {
      errors.push("real-client smoke target ids must be unique");
    }
  }
  if (!Array.isArray(document.nonBindingEvidence) || document.nonBindingEvidence.length === 0) {
    errors.push("nonBindingEvidence must record the sources that are intentionally not enforced");
  } else {
    for (const [index, evidence] of document.nonBindingEvidence.entries()) {
      const at = `nonBindingEvidence[${index}]`;
      if (!isRecord(evidence)) {
        errors.push(`${at} must be an object`);
        continue;
      }
      if (evidence.enforced !== false) {
        errors.push(`${at}.enforced must be false`);
      }
      if (typeof evidence.scope !== "string" || evidence.scope.length === 0) {
        errors.push(`${at}.scope must be non-empty`);
      }
      if (typeof evidence.url !== "string" || !/^https:\/\//.test(evidence.url)) {
        errors.push(`${at}.url must be an https URL`);
      }
    }
  }
  return errors;
}

/**
 * Evaluate only the rules explicitly carried by each evidence-backed profile.
 * @param {Array<object>} tools
 * @param {unknown} document
 * @returns {Array<{profileId:string,client:string,rule:string,path:string}>}
 */
export function evaluateClientProfiles(tools, document) {
  const metadataErrors = validateClientProfileDocument(document);
  if (metadataErrors.length > 0) {
    throw new Error(`invalid client profile document:\n${metadataErrors.join("\n")}`);
  }
  const violations = [];
  const arrayItems = findArrayItems(tools);
  for (const profile of document.profiles) {
    for (const restriction of profile.restrictions) {
      if (restriction.rule === "forbid-array-items") {
        for (const schemaPath of arrayItems) {
          if (!schemaPath.includes(".inputSchema.")) continue;
          violations.push({
            profileId: profile.id,
            client: profile.client,
            rule: restriction.rule,
            path: schemaPath
          });
        }
      }
    }
  }
  return violations;
}

function rpcError(method, message, stderr) {
  const suffix = stderr.trim() ? `\nserver stderr:\n${stderr.trim().slice(-4000)}` : "";
  return new Error(`${method}: ${message}${suffix}`);
}

async function stopChild(proc) {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  proc.kill("SIGTERM");
  const closed = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 1000);
    proc.once("close", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  if (!closed && proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
}

/**
 * Spawn the built server against an isolated synthetic vault and capture the
 * exact maximally-enabled tools/list schemas clients receive.
 * @param {string} distEntry
 * @param {{timeoutMs?:number}} options
 * @returns {Promise<object>}
 */
export async function captureEmittedSchemaInventory(distEntry, options = {}) {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-schema-inventory-"));
  const vault = path.join(tempRoot, "vault");
  await fs.mkdir(vault);
  await fs.writeFile(path.join(vault, "a.md"), "# schema inventory\nsynthetic vault\n");
  const proc = spawn(
    process.execPath,
    [
      distEntry,
      "serve",
      "--vault",
      vault,
      "--include-pdfs",
      "--diagnostic-search-tools",
      "--persistent-index",
      "--enable-write",
      "--feedback-weight",
      "0.1"
    ],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, XDG_CACHE_HOME: path.join(tempRoot, "cache") }
    }
  );
  let stdoutBuffer = "";
  let stderr = "";
  let nextId = 1;
  const pending = new Map();

  const rejectPending = (error) => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  };
  proc.on("error", (error) => rejectPending(error));
  proc.on("exit", (code, signal) => {
    if (pending.size > 0) {
      rejectPending(rpcError("server", `exited before replying (code=${code}, signal=${signal})`, stderr));
    }
  });
  proc.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-8000);
  });
  proc.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString();
    for (;;) {
      const newline = stdoutBuffer.indexOf("\n");
      if (newline === -1) break;
      const line = stdoutBuffer.slice(0, newline);
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line);
        if (typeof message.id !== "number") continue;
        const entry = pending.get(message.id);
        if (!entry) continue;
        pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error) {
          entry.reject(rpcError(entry.method, JSON.stringify(message.error), stderr));
        } else {
          entry.resolve(message);
        }
      } catch {
        // The CLI may print a human-readable banner; only JSON-RPC lines matter.
      }
    }
  });

  const rpc = (method, params = {}) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!pending.delete(id)) return;
        reject(rpcError(method, `timed out after ${timeoutMs}ms`, stderr));
      }, timeoutMs);
      pending.set(id, { method, resolve, reject, timer });
      proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (error) => {
        if (!error) return;
        const entry = pending.get(id);
        if (!entry) return;
        pending.delete(id);
        clearTimeout(entry.timer);
        reject(rpcError(method, error.message, stderr));
      });
    });
  };

  try {
    await rpc("initialize", {
      protocolVersion: INVENTORY_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "enquire-schema-inventory", version: "1" }
    });
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const response = await rpc("tools/list");
    return buildSchemaInventory(response.result?.tools);
  } finally {
    rejectPending(new Error("schema inventory capture finished"));
    await stopChild(proc);
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}
