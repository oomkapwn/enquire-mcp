// v3.6.4 K-1 class invariant — methodological guard.
// (v3.7.2 audit response: file header originally said "v3.6.3" — that
//  was the 4th instance of the version-attribution drift class, since
//  v3.6.3 was the marketing-only patch and K-1 actually closed in v3.6.4.
//  Strengthened to v3.7.0 with the AST def-use trace sibling test.)
//
// META-INVARIANT-EXEMPT: K-1/AH-2 index admission is structurally enforced at
// 6 levels (grep / AST / caller-pattern / fixture / version / admission-order).
// NEGATIVE control coverage includes mutation-backed tokenizer
// caller/order/path checks inline below, plus historical siblings:
//   - tests/k1-ast-invariant.test.ts (2 NEGATIVE blocks)
//   - tests/k1-version-stamp-consistency.test.ts (1 NEGATIVE block via scanK1Stamps fixture)
//   - tests/peek-meta.test.ts (4+ caller-pattern NEGATIVE controls)
// The exempt marker remains required by the rc.16 META-invariant because
// this file is itself the class-level invariant under review.
//
// Background. v3.6.1 fixed ONE callsite of the destructive-bootstrap-schema
// class and claimed "CRIT-1 closed" — overclaim; 9 callsites remained.
// v3.6.2 fixed 3 more callsites and claimed "all 10 callsites" — still an
// overclaim; cli.ts had 5 residual sites. v3.6.3 shipped marketing-only;
// v3.6.4 closes the residual AND adds this test as a class-level guard so
// the overclaim pattern can't repeat: every `new EmbedDb(...)` /
// `new FtsIndex(...)` in src/ must be preceded by either a discriminated
// configuration-discovery call OR an explicit `// SAFE BY DESIGN` comment within
// 40 lines of
// context (raised from 20 in v3.6.4, then to 128 for pre-progress discriminated discovery +
// supported-config projection before construction).
//
// This is a grep-based invariant — not perfect (e.g. doesn't follow control
// flow), but catches the specific class of bug v3.6.1 → v3.6.2 → v3.6.3
// chased: constructing the SQLite wrapper without first admitting the
// on-disk configuration. Test files are exempt (they're explicitly setting up
// known-good state).

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { replaceAllExactly, replaceExactly } from "./helpers/exact-source-mutation.js";

// v3.7.0 M-3: scan ALL of src/ recursively (was hardcoded ["src", "src/tools"]
// in v3.6.4). When new sub-directories are added (e.g. src/managers/), they
// auto-fall under invariant coverage instead of silently slipping past.
const SRC_ROOT = "src";
const CONSTRUCTOR_PATTERNS = [/\bnew EmbedDb\s*\(/g, /\bnew FtsIndex\s*\(/g];
const DISCOVERY_MARKERS = ["discoverEmbedDbConfig", "discoverEmbedDbConfigCached", "discoverFtsIndexConfig"];
const SAFE_MARKER = "SAFE BY DESIGN";
// Context window — must accommodate discovery, fail-closed state branching,
// and supported-config projection before construction. The caller-pattern
// inventory below separately proves exact def-use/order at all eleven sites.
const CONTEXT_LINES = 128;

interface ConstructorSite {
  file: string;
  line: number;
  text: string;
}

interface SourceSection {
  label: string;
  text: string;
}

interface ProductionConfigurationCall {
  file: string;
  name: string;
  line: number;
}

const EXPECTED_PRODUCTION_DISCOVERY_CALLS: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  "src/cli.ts": { discoverEmbedDbConfig: 2, discoverFtsIndexConfig: 4 },
  "src/server.ts": { discoverEmbedDbConfig: 3, discoverFtsIndexConfig: 1 },
  "src/tools/search.ts": { discoverEmbedDbConfigCached: 1 }
};
const CONFIGURATION_DEFINING_MODULES = new Set(["src/embed-db.ts", "src/fts5.ts"]);
const RAW_PEEK_CALLS = new Set(["peekEmbedDbMeta", "peekEmbedDbMetaCached", "peekFtsMetaSafe"]);

/** Collect real identifier call expressions, excluding definitions and prose. */
function productionConfigurationCalls(file: string, source: string): ProductionConfigurationCall[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const calls: ProductionConfigurationCall[] = [];
  const visit = (node: ts.Node): void => {
    const callName = ts.isCallExpression(node)
      ? ts.isIdentifier(node.expression)
        ? node.expression.text
        : ts.isPropertyAccessExpression(node.expression)
          ? node.expression.name.text
          : null
      : null;
    if (callName !== null && (DISCOVERY_MARKERS.includes(callName) || RAW_PEEK_CALLS.has(callName))) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      calls.push({ file, name: callName, line: line + 1 });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return calls;
}

/** Pin all production callers to the reviewed eleven-site fail-closed inventory. */
function productionConfigurationInventoryProblems(calls: readonly ProductionConfigurationCall[]): string[] {
  const problems: string[] = [];
  const counts = new Map<string, number>();
  let productionDiscoveryTotal = 0;
  for (const call of calls) {
    if (CONFIGURATION_DEFINING_MODULES.has(call.file)) continue;
    if (RAW_PEEK_CALLS.has(call.name)) {
      problems.push(`raw production configuration peek is forbidden: ${call.file}:${call.line} ${call.name}`);
      continue;
    }
    productionDiscoveryTotal++;
    const expected = EXPECTED_PRODUCTION_DISCOVERY_CALLS[call.file]?.[call.name];
    if (expected === undefined) {
      problems.push(`uncatalogued production discovery caller: ${call.file}:${call.line} ${call.name}`);
    }
    const key = `${call.file}\0${call.name}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const [file, names] of Object.entries(EXPECTED_PRODUCTION_DISCOVERY_CALLS)) {
    for (const [name, expected] of Object.entries(names)) {
      const actual = counts.get(`${file}\0${name}`) ?? 0;
      if (actual !== expected) problems.push(`${file} ${name}: expected ${expected}, found ${actual}`);
    }
  }
  if (productionDiscoveryTotal !== 11) {
    problems.push(`global production discovery inventory: expected 11, found ${productionDiscoveryTotal}`);
  }
  return problems;
}

function sectionBetween(source: string, label: string, start: string, end: string): SourceSection {
  const startAt = source.indexOf(start);
  const endAt = source.indexOf(end, Math.max(0, startAt + start.length));
  return { label, text: startAt >= 0 && endAt > startAt ? source.slice(startAt, endAt) : "" };
}

function countLiteral(source: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let cursor = 0;
  while (true) {
    const at = source.indexOf(needle, cursor);
    if (at < 0) return count;
    count++;
    cursor = at + needle.length;
  }
}

/**
 * Structural caller-side admission contract for the FTS tokenizer.
 *
 * The FtsIndex constructor is the final authority, but raw CLI and public
 * server inputs must still reject invalid modes before vault/path preparation.
 * This also inventories every writable FTS path family: explicit overrides
 * retain their hashed-default fallback, while setup/eval stay default-only.
 */
function tokenizerCallerProblems(cliSource: string, serverSource: string): string[] {
  const problems: string[] = [];
  const cliSections = [
    sectionBetween(cliSource, "serve", '.command("serve",', "// v2.6.0 — remote-MCP HTTP transport"),
    sectionBetween(cliSource, "serve-http", '.command("serve-http")', "// v2.6.0 — convenience helper"),
    sectionBetween(cliSource, "index", '.command("index")', '.command("install-model")')
  ];
  const serverSection = sectionBetween(
    serverSource,
    "prepareServerDeps",
    "export async function prepareServerDeps",
    "\nexport function buildMcpServer"
  );
  const ordered: Array<{ section: SourceSection; validator: string; acquisition: string }> = [
    {
      section: cliSections[0] ?? { label: "serve", text: "" },
      validator: 'assertTokenizeMode(rawTokenize, "--tokenize")',
      acquisition: "await startServer(serveOpts)"
    },
    {
      section: cliSections[1] ?? { label: "serve-http", text: "" },
      validator: 'assertTokenizeMode(rawTokenize, "--tokenize")',
      acquisition: "await startHttpServer(httpOpts)"
    },
    {
      section: cliSections[2] ?? { label: "index", text: "" },
      validator: 'assertTokenizeMode(opts.tokenize, "--tokenize")',
      acquisition: "new Vault(opts.vault"
    },
    {
      section: serverSection,
      validator: 'assertTokenizeMode(opts.tokenize, "tokenize option")',
      acquisition: "new Vault(opts.vault"
    }
  ];

  for (const contract of ordered) {
    if (contract.section.text.length === 0) {
      problems.push(`${contract.section.label}: source section is missing`);
      continue;
    }
    const validatorAt = contract.section.text.indexOf(contract.validator);
    const acquisitionAt = contract.section.text.indexOf(contract.acquisition);
    if (validatorAt < 0) problems.push(`${contract.section.label}: exact tokenizer validation is missing`);
    if (acquisitionAt < 0) problems.push(`${contract.section.label}: acquisition boundary is missing`);
    if (validatorAt >= 0 && acquisitionAt >= 0 && validatorAt > acquisitionAt) {
      problems.push(`${contract.section.label}: tokenizer validation runs after acquisition`);
    }
  }

  const serve = cliSections[0]?.text ?? "";
  const serveHttp = cliSections[1]?.text ?? "";
  const index = cliSections[2]?.text ?? "";
  if (!serve.includes("const { tokenize: rawTokenize, ...serveBaseOpts } = opts;")) {
    problems.push("serve: raw tokenizer is not removed before forwarding validated options");
  }
  if (!serve.includes("...(tokenize !== undefined ? { tokenize } : {})")) {
    problems.push("serve: validated tokenizer is not forwarded");
  }
  const httpRawProjections = [
    ["tokenize", "rawTokenize"],
    ["port", "rawPort"],
    ["host", "rawHost"],
    ["bearerToken", "rawBearerToken"],
    ["bearerTokenEnv", "rawBearerTokenEnv"],
    ["mcpPath", "rawMcpPath"],
    ["rateLimit", "rawRateLimit"],
    ["corsOrigin", "rawCorsOrigins"],
    ["healthPath", "rawHealthPath"],
    ["stateful", "rawStateful"],
    ["sessionIdleTimeoutMs", "rawSessionIdleTimeoutMs"],
    ["maxSessions", "rawMaxSessions"],
    ["quantizeEmbeddings", "rawQuantizeEmbeddings"]
  ] as const;
  for (const [option, local] of httpRawProjections) {
    if (!serveHttp.includes(`${option}: ${local},`)) {
      problems.push(`serve-http: raw HTTP option ${option} is not projected before forwarding`);
    }
  }
  if (
    !serveHttp.includes("        ...serveBaseOpts\n      } = opts;") ||
    !serveHttp.includes("        ...serveBaseOpts,\n        ...(tokenize !== undefined ? { tokenize } : {})")
  ) {
    problems.push("serve-http: projected ServeOptions rest is not captured and forwarded");
  }
  if (!serveHttp.includes("...(tokenize !== undefined ? { tokenize } : {})")) {
    problems.push("serve-http: validated tokenizer is not forwarded");
  }
  if (!index.includes("if (requestedTokenize !== undefined)")) {
    problems.push("index: validated tokenizer does not control the explicit override branch");
  }
  if (serverSection.text.includes('opts.tokenize === "trigram" ? "trigram" : "unicode61"')) {
    problems.push("prepareServerDeps: invalid tokenizer still coerces to unicode61");
  }
  if (!serverSection.text.includes('requestedTokenize ?? (discovered.kind === "owned"')) {
    problems.push("prepareServerDeps: validated tokenizer does not control FTS construction");
  }

  const pathInventory = [
    {
      label: "cli custom/default vault-root FTS paths",
      source: cliSource,
      needle: "const indexFile = opts.indexFile ?? defaultIndexFile(vault.root);",
      expected: 2
    },
    {
      label: "cli custom/default canonical-root FTS path",
      source: cliSource,
      needle: "const indexFile = opts.indexFile ?? defaultIndexFile(v.root);",
      expected: 2
    },
    {
      label: "cli default-only canonical-root FTS paths",
      source: cliSource,
      needle: "const indexFile = defaultIndexFile(v.root);",
      expected: 1
    },
    {
      label: "programmatic custom/default FTS path",
      source: serverSource,
      needle: "const indexFile = opts.indexFile ?? defaultIndexFile(vault.root);",
      expected: 1
    },
    {
      label: "cli FTS constructor paths",
      source: cliSource,
      needle: "new FtsIndex({ file: indexFile",
      expected: 5
    },
    {
      label: "programmatic FTS constructor path",
      source: serverSource,
      needle: "new FtsIndex({ file: indexFile",
      expected: 1
    }
  ];
  for (const entry of pathInventory) {
    const actual = countLiteral(entry.source, entry.needle);
    if (actual !== entry.expected) problems.push(`${entry.label}: expected ${entry.expected}, found ${actual}`);
  }
  return problems;
}

/** Inventory every production configuration discovery that can influence an open. */
function configurationDiscoveryRootProblems(cliSource: string, serverSource: string, searchSource: string): string[] {
  const problems: string[] = [];
  const inventory = [
    {
      label: "CLI FTS canonical-root discoveries",
      source: cliSource,
      needle: "discoverFtsIndexConfig(indexFile, v.root)",
      expected: 3
    },
    {
      label: "CLI FTS vault-root discovery",
      source: cliSource,
      needle: "discoverFtsIndexConfig(indexFile, vault.root)",
      expected: 1
    },
    {
      label: "CLI Embed canonical-root discovery",
      source: cliSource,
      needle: "discoverEmbedDbConfig(embedFile, v.root)",
      expected: 1
    },
    {
      label: "CLI Embed vault-root discovery",
      source: cliSource,
      needle: "discoverEmbedDbConfig(embedFile, vault.root)",
      expected: 1
    },
    {
      label: "server FTS canonical-root discovery",
      source: serverSource,
      needle: "discoverFtsIndexConfig(indexFile, vault.root)",
      expected: 1
    },
    {
      label: "server Embed canonical-root discoveries",
      source: serverSource,
      needle: "discoverEmbedDbConfig(embedFile, vault.root)",
      expected: 2
    },
    {
      label: "server non-HNSW integrity Embed canonical-root discovery",
      source: serverSource,
      needle: "discoverEmbedDbConfig(startupEmbedFile, vault.root)",
      expected: 1
    },
    {
      label: "search cached Embed canonical-root discovery",
      source: searchSource,
      needle: "discoverEmbedDbConfigCached(embedFile, vault.root)",
      expected: 1
    }
  ];
  for (const entry of inventory) {
    const actual = countLiteral(entry.source, entry.needle);
    if (actual !== entry.expected) problems.push(`${entry.label}: expected ${entry.expected}, found ${actual}`);
  }

  for (const entry of [
    { label: "CLI FTS", source: cliSource, marker: "discoverFtsIndexConfig(", expected: 4 },
    { label: "CLI Embed", source: cliSource, marker: "discoverEmbedDbConfig(", expected: 2 },
    { label: "server FTS", source: serverSource, marker: "discoverFtsIndexConfig(", expected: 1 },
    { label: "server Embed", source: serverSource, marker: "discoverEmbedDbConfig(", expected: 3 },
    { label: "search cached Embed", source: searchSource, marker: "discoverEmbedDbConfigCached(", expected: 1 },
    { label: "CLI legacy FTS peek", source: cliSource, marker: "peekFtsMetaSafe(", expected: 0 },
    { label: "CLI legacy Embed peek", source: cliSource, marker: "peekEmbedDbMeta(", expected: 0 },
    { label: "server legacy FTS peek", source: serverSource, marker: "peekFtsMetaSafe(", expected: 0 },
    { label: "server legacy Embed peek", source: serverSource, marker: "peekEmbedDbMeta(", expected: 0 },
    { label: "search legacy Embed peek", source: searchSource, marker: "peekEmbedDbMetaCached(", expected: 0 }
  ]) {
    const actual = countLiteral(entry.source, entry.marker);
    if (actual !== entry.expected) {
      problems.push(`${entry.label} production discovery inventory: expected ${entry.expected}, found ${actual}`);
    }
  }
  const uncachedEmbedDiscoveries =
    countLiteral(cliSource, "discoverEmbedDbConfig(") +
    countLiteral(serverSource, "discoverEmbedDbConfig(") +
    countLiteral(searchSource, "discoverEmbedDbConfig(");
  if (uncachedEmbedDiscoveries !== 5) {
    problems.push(`uncached Embed discovery inventory: expected 5, found ${uncachedEmbedDiscoveries}`);
  }
  return problems;
}

interface FailClosedCallerSpec {
  label: string;
  source: string;
  start: string;
  end: string;
  discovery: string;
  refusal: string;
  refusalBranch?: string;
  refusalEffect: string;
  refusalEffectKind?: "throw" | "stderr";
  acquisitionMustBeInElse?: boolean;
  reviewedTryAncestors?: number;
  resolver?: string;
  acquisition: string;
  className: "EmbedDb" | "FtsIndex";
  discoveryBinding: string;
  constructorBinding?: string;
  instanceBinding: string;
  nullableDiscovery?: boolean;
  openTryAncestors?: number;
  openFailurePolicy?: "finally-propagate" | "rethrow" | "fail-soft-null";
}

/** Build the reviewed one-to-one fail-closed contract for all eleven production callers. */
function failClosedCallerSpecs(cliSource: string, serverSource: string, searchSource: string): FailClosedCallerSpec[] {
  return [
    {
      label: "CLI query FTS",
      source: cliSource,
      start: '.command("query")',
      end: '.command("prune")',
      discovery: "discoverFtsIndexConfig(indexFile, v.root)",
      refusal: 'if (discovered.kind === "refused")',
      refusalEffect: 'throw new Error("FTS index configuration could not be verified");',
      acquisition: "new FtsIndex({ file: indexFile",
      className: "FtsIndex",
      discoveryBinding: "discovered",
      instanceBinding: "ftsIndex",
      openTryAncestors: 1,
      openFailurePolicy: "finally-propagate"
    },
    {
      label: "CLI index FTS omitted tokenizer",
      source: cliSource,
      start: '.command("index")',
      end: '.command("install-model")',
      discovery: "discoverFtsIndexConfig(indexFile, vault.root)",
      refusal: 'if (discovered.kind === "refused")',
      refusalEffect: 'throw new Error("FTS index configuration could not be verified");',
      acquisition: "new FtsIndex({ file: indexFile",
      className: "FtsIndex",
      discoveryBinding: "discovered",
      instanceBinding: "idx"
    },
    {
      label: "CLI build Embed omitted configuration",
      source: cliSource,
      start: '.command("build-embeddings")',
      end: '.command("clear-embeddings")',
      discovery: "discoverEmbedDbConfig(embedFile, vault.root)",
      refusal: 'if (discovered.kind === "refused")',
      refusalEffect: 'throw new Error("Embedding index configuration could not be verified");',
      resolver: "resolveStoredEmbeddingConfiguration(discovered.meta)",
      acquisition: "new EmbedDb({",
      className: "EmbedDb",
      discoveryBinding: "discovered",
      instanceBinding: "db"
    },
    {
      label: "CLI setup FTS",
      source: cliSource,
      start: '.command("setup")',
      end: '.command("eval")',
      discovery: "discoverFtsIndexConfig(indexFile, v.root)",
      refusal: 'if (discoveredFts.kind === "refused")',
      refusalEffect: 'throw new Error("FTS index configuration could not be verified");',
      acquisition: "new FtsIndex({ file: indexFile",
      className: "FtsIndex",
      discoveryBinding: "discoveredFts",
      instanceBinding: "idx"
    },
    {
      label: "CLI setup Embed omitted configuration",
      source: cliSource,
      start: '.command("setup")',
      end: '.command("eval")',
      discovery: "discoverEmbedDbConfig(embedFile, v.root)",
      refusal: 'if (discoveredEmbed?.kind === "refused")',
      refusalEffect: 'throw new Error("Embedding index configuration could not be verified");',
      resolver: "resolveStoredEmbeddingConfiguration(discoveredEmbed.meta)",
      acquisition: "process.stdout.write(`enquire setup",
      className: "EmbedDb",
      discoveryBinding: "discoveredEmbed",
      instanceBinding: "db",
      nullableDiscovery: true
    },
    {
      label: "CLI eval FTS",
      source: cliSource,
      start: '.command("eval")',
      end: '.command("eval-compare")',
      discovery: "discoverFtsIndexConfig(indexFile, v.root)",
      refusal: 'if (discovered.kind === "refused")',
      refusalEffect: 'throw new Error("FTS index configuration could not be verified");',
      acquisition: "new FtsIndex({ file: indexFile",
      className: "FtsIndex",
      discoveryBinding: "discovered",
      instanceBinding: "ftsIndex",
      openTryAncestors: 1,
      openFailurePolicy: "rethrow"
    },
    {
      label: "server persistent FTS omitted tokenizer",
      source: serverSource,
      start: "if (opts.persistentIndex) {",
      end: "// Optional watcher",
      discovery: "discoverFtsIndexConfig(indexFile, vault.root)",
      refusal: 'const refusedFts = discovered.kind === "refused"',
      refusalBranch: "if (refusedFts)",
      refusalEffect: "FTS5/BM25 configuration could not be verified — degrading to TF-IDF search",
      refusalEffectKind: "stderr",
      acquisitionMustBeInElse: true,
      acquisition: "new FtsIndex({ file: indexFile",
      className: "FtsIndex",
      discoveryBinding: "discovered",
      instanceBinding: "ftsIndex",
      openTryAncestors: 1,
      openFailurePolicy: "fail-soft-null"
    },
    {
      label: "server watcher Embed",
      source: serverSource,
      start: "if (opts.watch) {",
      end: "// v2.13.0 — opt-in HNSW",
      discovery: "discoverEmbedDbConfig(embedFile, vault.root)",
      refusal: 'if (discovered.kind === "missing" || discovered.kind === "refused")',
      refusalEffect: 'throw new Error("Embedding index configuration could not be verified");',
      reviewedTryAncestors: 1,
      resolver: "resolveStoredEmbeddingConfiguration(discovered.meta)",
      acquisition: "new EmbedDb({",
      className: "EmbedDb",
      discoveryBinding: "discovered",
      instanceBinding: "watcherEmbedDb"
    },
    {
      label: "server non-HNSW integrity Embed",
      source: serverSource,
      start: "if (startupEmbedDbAvailable && !opts.useHnsw) {",
      end: "// v2.13.0 — opt-in HNSW",
      discovery: "discoverEmbedDbConfig(startupEmbedFile, vault.root)",
      refusal: 'if (discovered.kind === "missing" || discovered.kind === "refused")',
      refusalEffect: 'throw new EmbedSnapshotIntegrityError("Embedding index configuration could not be verified");',
      reviewedTryAncestors: 1,
      resolver: "resolveStoredEmbeddingConfiguration(discovered.meta)",
      acquisition: "new EmbedDb({",
      className: "EmbedDb",
      discoveryBinding: "discovered",
      instanceBinding: "integrityDb"
    },
    {
      label: "server HNSW Embed",
      source: serverSource,
      start: "if (opts.useHnsw) {",
      end: "// v3.12.0-rc.25 — the one startup linearization point",
      discovery: "discoverEmbedDbConfig(embedFile, vault.root)",
      refusal: 'if (discovered.kind === "missing" || discovered.kind === "refused")',
      refusalEffect: 'throw new Error("Embedding index configuration could not be verified");',
      reviewedTryAncestors: 1,
      resolver: "resolveStoredEmbeddingConfiguration(discovered.meta)",
      acquisition: "new EmbedDb({",
      className: "EmbedDb",
      discoveryBinding: "discovered",
      constructorBinding: "hnswSnapshotDb",
      instanceBinding: "db"
    },
    {
      label: "search Embed",
      source: searchSource,
      start: "export async function embeddingsSearch(",
      end: "export async function searchHybrid(",
      discovery: "discoverEmbedDbConfigCached(embedFile, vault.root)",
      refusal: 'if (discovered.kind === "refused")',
      refusalEffect: 'throw new Error("Embedding index configuration could not be verified");',
      resolver: "resolveStoredEmbeddingConfiguration(discovered.meta)",
      acquisition: "new EmbedDb({",
      className: "EmbedDb",
      discoveryBinding: "discovered",
      instanceBinding: "db"
    }
  ];
}

interface BoundRefusalBranch {
  branchAt: number;
  acquisitionInElse: boolean;
}

interface RefusalDiscoveryBinding {
  block: ts.Block;
  name: string;
  statement: ts.VariableStatement;
}

/** Locate the one direct variable binding initialized by the reviewed discovery call. */
function refusalDiscoveryBinding(sourceFile: ts.SourceFile, discovery: string): RefusalDiscoveryBinding | null {
  const matches: RefusalDiscoveryBinding[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      let containsDiscovery = false;
      const inspectInitializer = (candidate: ts.Node): void => {
        if (ts.isCallExpression(candidate) && candidate.getText(sourceFile) === discovery) {
          containsDiscovery = true;
          return;
        }
        ts.forEachChild(candidate, inspectInitializer);
      };
      inspectInitializer(node.initializer);
      const declarationList = node.parent;
      const statement = declarationList.parent;
      if (containsDiscovery && ts.isVariableStatement(statement) && ts.isBlock(statement.parent)) {
        matches.push({ block: statement.parent, name: node.name.text, statement });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

function staticallyKnownBoolean(expression: ts.Expression): boolean | null {
  if (ts.isParenthesizedExpression(expression)) return staticallyKnownBoolean(expression.expression);
  if (expression.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (expression.kind === ts.SyntaxKind.FalseKeyword || expression.kind === ts.SyntaxKind.NullKeyword) return false;
  if (ts.isNumericLiteral(expression)) return Number(expression.text) !== 0;
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return expression.text.length > 0;
  }
  if (ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.ExclamationToken) {
    const operand = staticallyKnownBoolean(expression.operand);
    return operand === null ? null : !operand;
  }
  return null;
}

/** Reject added dead/catching ancestry while preserving explicitly reviewed outer server tries. */
function isDirectReachableCallerBlock(block: ts.Block, reviewedTryAncestors: number): boolean {
  let current: ts.Node = block;
  let tryAncestors = 0;
  while (!ts.isSourceFile(current.parent)) {
    const parent = current.parent;
    if (ts.isCatchClause(parent)) return false;
    if (ts.isTryStatement(parent)) {
      if (current !== parent.tryBlock) return false;
      tryAncestors++;
    }
    if (ts.isIfStatement(parent)) {
      const condition = staticallyKnownBoolean(parent.expression);
      if (current === parent.thenStatement && condition === false) return false;
      if (current === parent.elseStatement && condition === true) return false;
    }
    if (ts.isConditionalExpression(parent)) {
      const condition = staticallyKnownBoolean(parent.condition);
      if (current === parent.whenTrue && condition === false) return false;
      if (current === parent.whenFalse && condition === true) return false;
    }
    if (ts.isWhileStatement(parent) && current === parent.statement) {
      if (staticallyKnownBoolean(parent.expression) === false) return false;
    }
    if (ts.isForStatement(parent) && current === parent.statement && parent.condition) {
      if (staticallyKnownBoolean(parent.condition) === false) return false;
    }
    current = parent;
  }
  return tryAncestors === reviewedTryAncestors;
}

/** Locate a reachable direct effect in the exact, discovery-bound refused branch. */
function boundRefusalBranch(
  section: string,
  discovery: string,
  refusal: string,
  branch: string,
  effect: string,
  effectKind: "throw" | "stderr",
  acquisition: string,
  reviewedTryAncestors: number
): BoundRefusalBranch | null {
  const sourceFile = ts.createSourceFile("refusal-section.ts", section, ts.ScriptTarget.Latest, true);
  const discoveryBinding = refusalDiscoveryBinding(sourceFile, discovery);
  if (!discoveryBinding || !isDirectReachableCallerBlock(discoveryBinding.block, reviewedTryAncestors)) {
    return null;
  }
  let found: BoundRefusalBranch | null = null;

  function directStatements(statement: ts.Statement): readonly ts.Statement[] {
    return ts.isBlock(statement) ? statement.statements : [statement];
  }

  function hasDirectEffect(statement: ts.Statement): boolean {
    if (effectKind === "throw") {
      return ts.isThrowStatement(statement) && statement.getText(sourceFile) === effect;
    }
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return false;
    const call = statement.expression;
    if (call.expression.getText(sourceFile) !== "process.stderr.write") return false;
    const message = call.arguments[0];
    return (
      message !== undefined &&
      (ts.isStringLiteral(message) || ts.isNoSubstitutionTemplateLiteral(message)) &&
      message.text.includes(effect)
    );
  }

  function hasDirectAcquisition(statement: ts.Statement): boolean {
    if (!ts.isExpressionStatement(statement) || !ts.isBinaryExpression(statement.expression)) return false;
    const assignment = statement.expression;
    return ts.isNewExpression(assignment.right) && assignment.getText(sourceFile).includes(acquisition);
  }

  function isBoundRefusalCondition(node: ts.IfStatement): boolean {
    const condition = node.expression.getText(sourceFile);
    if (`if (${condition})` !== branch) return false;
    if (refusal.startsWith("if (")) {
      let usesDiscoveryBinding = false;
      const visitCondition = (candidate: ts.Node): void => {
        if (ts.isIdentifier(candidate) && candidate.text === discoveryBinding.name) {
          usesDiscoveryBinding = true;
        }
        ts.forEachChild(candidate, visitCondition);
      };
      visitCondition(node.expression);
      return usesDiscoveryBinding;
    }

    const refusalBinding = discoveryBinding.block.statements.find((statement) => {
      if (!ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1) return false;
      const declaration = statement.declarationList.declarations[0];
      return (
        declaration !== undefined &&
        ts.isIdentifier(declaration.name) &&
        ts.isIdentifier(node.expression) &&
        declaration.name.text === node.expression.text &&
        statement.getText(sourceFile).replace(/;$/u, "") === refusal &&
        declaration.initializer?.getText(sourceFile).includes(discoveryBinding.name) === true
      );
    });
    return refusalBinding !== undefined && refusalBinding.getStart(sourceFile) < node.getStart(sourceFile);
  }

  function visit(node: ts.Node): void {
    if (found) return;
    if (
      ts.isIfStatement(node) &&
      node.parent === discoveryBinding.block &&
      discoveryBinding.statement.getStart(sourceFile) < node.getStart(sourceFile) &&
      isBoundRefusalCondition(node)
    ) {
      if (directStatements(node.thenStatement).some(hasDirectEffect)) {
        const acquisitionInElse =
          node.elseStatement !== undefined && directStatements(node.elseStatement).some(hasDirectAcquisition);
        found = { branchAt: node.getStart(sourceFile), acquisitionInElse };
        return;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return found;
}

/** Require every fail-soft discovery caller to distinguish missing from present-but-unverified. */
function configurationDiscoveryFailClosedProblems(
  cliSource: string,
  serverSource: string,
  searchSource: string
): string[] {
  const problems: string[] = [];
  const specs = failClosedCallerSpecs(cliSource, serverSource, searchSource);

  for (const spec of specs) {
    const section = sectionBetween(spec.source, spec.label, spec.start, spec.end).text;
    if (section.length === 0) {
      problems.push(`${spec.label}: source section is missing`);
      continue;
    }
    const discoveryAt = section.indexOf(spec.discovery);
    const refusalAt = section.indexOf(spec.refusal);
    const refusalBranch = boundRefusalBranch(
      section,
      spec.discovery,
      spec.refusal,
      spec.refusalBranch ?? spec.refusal,
      spec.refusalEffect,
      spec.refusalEffectKind ?? "throw",
      spec.acquisition,
      spec.reviewedTryAncestors ?? 0
    );
    const refusalBranchAt = refusalBranch?.branchAt ?? -1;
    const resolverAt = spec.resolver ? section.indexOf(spec.resolver) : refusalAt;
    const acquisitionAt = section.indexOf(spec.acquisition);
    if (discoveryAt < 0) problems.push(`${spec.label}: root-scoped configuration discovery is missing`);
    if (refusalAt < 0) problems.push(`${spec.label}: refused discovery refusal/degrade is missing`);
    if (refusalBranchAt < 0) {
      problems.push(`${spec.label}: refused-state terminal/degrade effect is not bound to refused branch`);
    }
    if (spec.acquisitionMustBeInElse && !refusalBranch?.acquisitionInElse) {
      problems.push(`${spec.label}: degrade branch no longer excludes constructor acquisition`);
    }
    if (spec.resolver && resolverAt < 0) problems.push(`${spec.label}: supported stored-config resolver is missing`);
    if (acquisitionAt < 0) problems.push(`${spec.label}: constructor acquisition is missing`);
    if (discoveryAt >= 0 && refusalAt >= 0 && discoveryAt > refusalAt) {
      problems.push(`${spec.label}: refused-state check runs before discovery`);
    }
    if (refusalAt >= 0 && acquisitionAt >= 0 && refusalAt > acquisitionAt) {
      problems.push(`${spec.label}: constructor runs before refused-state check`);
    }
    if (refusalBranchAt >= 0 && acquisitionAt >= 0 && refusalBranchAt > acquisitionAt) {
      problems.push(`${spec.label}: constructor runs before refused-state terminal/degrade effect`);
    }
    if (resolverAt >= 0 && acquisitionAt >= 0 && resolverAt > acquisitionAt) {
      problems.push(`${spec.label}: constructor runs before supported stored-config resolution`);
    }
  }

  const index = sectionBetween(cliSource, "CLI index", '.command("index")', '.command("install-model")').text;
  const indexDiscoveryAt = index.indexOf("discoverFtsIndexConfig(indexFile, vault.root)");
  const explicitTokenizerAt = index.indexOf("if (requestedTokenize !== undefined)");
  if (!(indexDiscoveryAt >= 0 && explicitTokenizerAt > indexDiscoveryAt)) {
    problems.push("CLI index FTS: authoritative discovery no longer precedes the explicit-tokenizer branch");
  }
  return problems;
}

/** Bind the global discovery census one-to-one to the reviewed fail-closed specs. */
function failClosedSpecInventoryProblems(
  cliSource: string,
  serverSource: string,
  searchSource: string,
  calls: readonly ProductionConfigurationCall[]
): string[] {
  const specs = failClosedCallerSpecs(cliSource, serverSource, searchSource);
  const productionCalls = calls.filter(
    (call) => !CONFIGURATION_DEFINING_MODULES.has(call.file) && !RAW_PEEK_CALLS.has(call.name)
  );
  const specCounts = new Map<string, number>();
  for (const spec of specs) {
    const file =
      spec.source === cliSource
        ? "src/cli.ts"
        : spec.source === serverSource
          ? "src/server.ts"
          : spec.source === searchSource
            ? "src/tools/search.ts"
            : "<unknown>";
    const name = spec.discovery.startsWith("discoverEmbedDbConfigCached")
      ? "discoverEmbedDbConfigCached"
      : spec.discovery.startsWith("discoverEmbedDbConfig")
        ? "discoverEmbedDbConfig"
        : spec.discovery.startsWith("discoverFtsIndexConfig")
          ? "discoverFtsIndexConfig"
          : "<unknown>";
    const key = `${file}\0${name}`;
    specCounts.set(key, (specCounts.get(key) ?? 0) + 1);
  }
  const callCounts = new Map<string, number>();
  for (const call of productionCalls) {
    const key = `${call.file}\0${call.name}`;
    callCounts.set(key, (callCounts.get(key) ?? 0) + 1);
  }
  const problems: string[] = [];
  for (const key of new Set([...specCounts.keys(), ...callCounts.keys()])) {
    const expected = callCounts.get(key) ?? 0;
    const actual = specCounts.get(key) ?? 0;
    if (actual !== expected) {
      const [file, name] = key.split("\0");
      problems.push(`${file} ${name}: expected ${expected} fail-closed specs, found ${actual}`);
    }
  }
  if (specs.length !== productionCalls.length) {
    problems.push(
      `fail-closed caller spec inventory: ${specs.length} specs for ${productionCalls.length} production discoveries`
    );
  }
  return problems;
}

const ASSIGNMENT_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken
]);

function isNestedExecutionBoundary(node: ts.Node): boolean {
  return (
    ts.isArrowFunction(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  );
}

/** Visit the current lexical execution body without accepting nested-function decoys. */
function visitExecutionBody(root: ts.Node, visitor: (node: ts.Node) => void): void {
  const visit = (node: ts.Node): void => {
    if (node !== root && isNestedExecutionBoundary(node)) return;
    visitor(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
}

function exactAwaitedDiscoveryInitializer(
  initializer: ts.Expression,
  sourceFile: ts.SourceFile,
  spec: FailClosedCallerSpec
): boolean {
  const isExactAwait = (candidate: ts.Expression): boolean =>
    ts.isAwaitExpression(candidate) &&
    ts.isCallExpression(candidate.expression) &&
    candidate.expression.getText(sourceFile) === spec.discovery;
  if (!spec.nullableDiscovery) return isExactAwait(initializer);
  return (
    ts.isConditionalExpression(initializer) &&
    initializer.condition.getText(sourceFile) === "opts.skipEmbeddings" &&
    initializer.whenTrue.kind === ts.SyntaxKind.NullKeyword &&
    isExactAwait(initializer.whenFalse)
  );
}

interface BoundConstructor {
  expression: ts.NewExpression;
  binding: ts.Identifier;
}

function boundConstructor(node: ts.NewExpression, spec: FailClosedCallerSpec): BoundConstructor | null {
  if (!ts.isIdentifier(node.expression) || node.expression.text !== spec.className) return null;
  const constructorBinding = spec.constructorBinding ?? spec.instanceBinding;
  const parent = node.parent;
  if (
    ts.isVariableDeclaration(parent) &&
    parent.initializer === node &&
    ts.isIdentifier(parent.name) &&
    parent.name.text === constructorBinding
  ) {
    return { expression: node, binding: parent.name };
  }
  if (
    ts.isBinaryExpression(parent) &&
    parent.right === node &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isIdentifier(parent.left) &&
    parent.left.text === constructorBinding
  ) {
    return { expression: node, binding: parent.left };
  }
  return null;
}

function rootAssignedIdentifier(expression: ts.Expression): ts.Identifier | null {
  let current = expression;
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    current = current.expression;
  }
  return ts.isIdentifier(current) ? current : null;
}

function bindingMutationBetween(
  root: ts.Node,
  sourceFile: ts.SourceFile,
  name: string,
  start: number,
  end: number
): boolean {
  let mutated = false;
  const visit = (node: ts.Node): void => {
    if (mutated || node.getStart(sourceFile) <= start || node.getStart(sourceFile) >= end) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      mutated = true;
      return;
    }
    if (
      ts.isBinaryExpression(node) &&
      ASSIGNMENT_OPERATORS.has(node.operatorToken.kind) &&
      rootAssignedIdentifier(node.left)?.text === name
    ) {
      mutated = true;
      return;
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) &&
      ts.isIdentifier(node.operand) &&
      node.operand.text === name
    ) {
      mutated = true;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(root, visit);
  return mutated;
}

function nodeContains(ancestor: ts.Node, descendant: ts.Node): boolean {
  return ancestor.pos <= descendant.pos && ancestor.end >= descendant.end;
}

function isStaticallyReachableWithin(node: ts.Node, root: ts.Node): boolean {
  let current = node;
  while (current !== root && current.parent) {
    const parent = current.parent;
    if (ts.isCatchClause(parent)) return false;
    if (ts.isTryStatement(parent) && current !== parent.tryBlock) return false;
    if (ts.isIfStatement(parent)) {
      const known = staticallyKnownBoolean(parent.expression);
      if (current === parent.thenStatement && known === false) return false;
      if (current === parent.elseStatement && known === true) return false;
    }
    if (ts.isConditionalExpression(parent)) {
      const known = staticallyKnownBoolean(parent.condition);
      if (current === parent.whenTrue && known === false) return false;
      if (current === parent.whenFalse && known === true) return false;
    }
    if (
      ts.isWhileStatement(parent) &&
      current === parent.statement &&
      staticallyKnownBoolean(parent.expression) === false
    ) {
      return false;
    }
    if (
      ts.isForStatement(parent) &&
      current === parent.statement &&
      parent.condition !== undefined &&
      staticallyKnownBoolean(parent.condition) === false
    ) {
      return false;
    }
    current = parent;
  }
  return current === root;
}

/** Every conditional branch that creates the instance must also contain its open. */
function constructionControlPathContainsOpen(construction: ts.Node, open: ts.Node, root: ts.Node): boolean {
  let current = construction;
  while (current !== root && current.parent) {
    const parent = current.parent;
    if (
      (ts.isIfStatement(parent) ||
        ts.isConditionalExpression(parent) ||
        ts.isWhileStatement(parent) ||
        ts.isDoStatement(parent) ||
        ts.isForStatement(parent) ||
        ts.isForInStatement(parent) ||
        ts.isForOfStatement(parent)) &&
      !nodeContains(current, open)
    ) {
      return false;
    }
    current = parent;
  }
  return current === root;
}

interface ConditionalControlStep {
  owner: ts.Node;
  branch: ts.Node;
}

function conditionalControlPath(node: ts.Node, root: ts.Node): ConditionalControlStep[] | null {
  const path: ConditionalControlStep[] = [];
  let current = node;
  while (current !== root && current.parent) {
    const parent = current.parent;
    if (
      ts.isIfStatement(parent) ||
      ts.isConditionalExpression(parent) ||
      ts.isWhileStatement(parent) ||
      ts.isDoStatement(parent) ||
      ts.isForStatement(parent) ||
      ts.isForInStatement(parent) ||
      ts.isForOfStatement(parent)
    ) {
      path.push({ owner: parent, branch: current });
    }
    if (ts.isCaseClause(parent) || ts.isDefaultClause(parent)) {
      path.push({ owner: parent.parent, branch: parent });
    }
    current = parent;
  }
  return current === root ? path.reverse() : null;
}

function exactConditionalControlPath(left: ts.Node, right: ts.Node, root: ts.Node): boolean {
  const leftPath = conditionalControlPath(left, root);
  const rightPath = conditionalControlPath(right, root);
  return (
    leftPath !== null &&
    rightPath !== null &&
    leftPath.length === rightPath.length &&
    leftPath.every((step, index) => step.owner === rightPath[index]?.owner && step.branch === rightPath[index]?.branch)
  );
}

function tryBlockAncestorCount(node: ts.Node, root: ts.Node): number | null {
  let count = 0;
  let current = node;
  while (current !== root && current.parent) {
    const parent = current.parent;
    if (ts.isCatchClause(parent)) return null;
    if (ts.isTryStatement(parent)) {
      if (current !== parent.tryBlock) return null;
      count++;
    }
    current = parent;
  }
  return current === root ? count : null;
}

function nearestOpenTry(node: ts.Node, root: ts.Node): ts.TryStatement | null {
  let current = node;
  while (current !== root && current.parent) {
    const parent = current.parent;
    if (ts.isTryStatement(parent) && current === parent.tryBlock) return parent;
    current = parent;
  }
  return null;
}

function reviewedOpenFailurePolicy(
  openCall: ts.CallExpression,
  sourceFile: ts.SourceFile,
  root: ts.Node,
  spec: FailClosedCallerSpec
): boolean {
  const policy = spec.openFailurePolicy;
  if (!policy) return nearestOpenTry(openCall, root) === null;
  const enclosingTry = nearestOpenTry(openCall, root);
  if (!enclosingTry) return false;

  if (policy === "finally-propagate") {
    const finallyBlock = enclosingTry.finallyBlock;
    return (
      enclosingTry.catchClause === undefined &&
      finallyBlock !== undefined &&
      finallyBlock.statements.length === 1 &&
      finallyBlock.statements[0]?.getText(sourceFile) === `await ${spec.instanceBinding}.closeAndRelease();`
    );
  }

  const catchClause = enclosingTry.catchClause;
  if (
    !catchClause ||
    enclosingTry.finallyBlock !== undefined ||
    !catchClause.variableDeclaration ||
    !ts.isIdentifier(catchClause.variableDeclaration.name) ||
    catchClause.variableDeclaration.name.text !== "err"
  ) {
    return false;
  }
  const catchStatements = catchClause.block.statements;
  if (policy === "rethrow") {
    return (
      catchStatements.length === 2 &&
      catchStatements[0]?.getText(sourceFile) === `await ${spec.instanceBinding}.closeAndRelease();` &&
      catchStatements[1]?.getText(sourceFile) === "throw err;"
    );
  }

  if (catchStatements.length !== 3) return false;
  const cleanup = catchStatements[0];
  const nullAssignment = catchStatements[1];
  const diagnostic = catchStatements[2];
  const cleanupCatch = cleanup && ts.isTryStatement(cleanup) ? cleanup.catchClause : undefined;
  const cleanupErrorBinding = cleanupCatch?.variableDeclaration?.name;
  const cleanupThrow = cleanupCatch?.block.statements[0];
  const aggregate = cleanupThrow && ts.isThrowStatement(cleanupThrow) ? cleanupThrow.expression : undefined;
  const aggregateErrors =
    aggregate && ts.isNewExpression(aggregate) && aggregate.arguments?.length === 2
      ? aggregate.arguments[0]
      : undefined;
  const aggregateMessage =
    aggregate && ts.isNewExpression(aggregate) && aggregate.arguments?.length === 2
      ? aggregate.arguments[1]
      : undefined;
  const cleanupFailureIsCausal =
    cleanupCatch !== undefined &&
    cleanupCatch.block.statements.length === 1 &&
    cleanupErrorBinding !== undefined &&
    ts.isIdentifier(cleanupErrorBinding) &&
    cleanupErrorBinding.text === "cleanupError" &&
    aggregate !== undefined &&
    ts.isNewExpression(aggregate) &&
    aggregate.expression.getText(sourceFile) === "AggregateError" &&
    aggregateErrors !== undefined &&
    ts.isArrayLiteralExpression(aggregateErrors) &&
    aggregateErrors.elements.length === 2 &&
    aggregateErrors.elements[0]?.getText(sourceFile) === "err" &&
    aggregateErrors.elements[1]?.getText(sourceFile) === "cleanupError" &&
    aggregateMessage !== undefined &&
    ts.isStringLiteral(aggregateMessage) &&
    aggregateMessage.text === "FTS startup failed and its persistence lifetime could not be released";
  return (
    cleanup !== undefined &&
    ts.isTryStatement(cleanup) &&
    cleanup.finallyBlock === undefined &&
    cleanup.tryBlock.statements.length === 1 &&
    cleanup.tryBlock.statements[0]?.getText(sourceFile) === `await ${spec.instanceBinding}?.closeAndRelease();` &&
    cleanupFailureIsCausal &&
    nullAssignment?.getText(sourceFile) === `${spec.instanceBinding} = null;` &&
    diagnostic !== undefined &&
    ts.isExpressionStatement(diagnostic) &&
    ts.isCallExpression(diagnostic.expression) &&
    diagnostic.expression.expression.getText(sourceFile) === "process.stderr.write" &&
    diagnostic.getText(sourceFile).includes("degrading to TF-IDF search")
  );
}

function subtreeContainsIdentifier(root: ts.Node, name: string): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(node) && node.text === name) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

/** Reject hoisted function bodies that can pre-open the reviewed instance. */
function hoistedInstanceCaptureInvokedBeforeOpen(
  declarationRoot: ts.Node,
  executionRoot: ts.Node,
  sourceFile: ts.SourceFile,
  instanceName: string,
  openAt: number
): boolean {
  const capturingDeclarations = new Map<string, ts.Identifier>();
  const collect = (node: ts.Node): void => {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name &&
      node.body &&
      subtreeContainsIdentifier(node.body, instanceName)
    ) {
      capturingDeclarations.set(node.name.text, node.name);
    }
    ts.forEachChild(node, collect);
  };
  collect(declarationRoot);
  if (capturingDeclarations.size === 0) return false;

  let referencedBeforeOpen = false;
  visitExecutionBody(executionRoot, (node) => {
    if (
      ts.isIdentifier(node) &&
      node.getStart(sourceFile) < openAt &&
      capturingDeclarations.has(node.text) &&
      capturingDeclarations.get(node.text) !== node
    ) {
      referencedBeforeOpen = true;
    }
  });
  return referencedBeforeOpen;
}

/**
 * Bind each of the eleven preflight reads to exactly one constructor and its
 * first awaited open. Textual proximity is insufficient: the same const
 * binding must cross the discovery -> constructor -> open boundary unchanged.
 */
function configurationDiscoveryOpenBindingProblems(
  cliSource: string,
  serverSource: string,
  searchSource: string
): string[] {
  const problems: string[] = [];
  const specs = failClosedCallerSpecs(cliSource, serverSource, searchSource);
  for (const spec of specs) {
    const section = sectionBetween(spec.source, spec.label, spec.start, spec.end).text;
    if (section.length === 0) {
      problems.push(`${spec.label}: source section is missing for discovery/open binding`);
      continue;
    }
    const sourceFile = ts.createSourceFile(`${spec.label}.ts`, section, ts.ScriptTarget.Latest, true);
    const discovery = refusalDiscoveryBinding(sourceFile, spec.discovery);
    if (!discovery || discovery.name !== spec.discoveryBinding) {
      problems.push(`${spec.label}: exact discovery lexical binding is missing`);
      continue;
    }
    const declarations = discovery.statement.declarationList.declarations;
    const declaration = declarations.length === 1 ? declarations[0] : undefined;
    if (
      !declaration?.initializer ||
      (discovery.statement.declarationList.flags & ts.NodeFlags.Const) === 0 ||
      !exactAwaitedDiscoveryInitializer(declaration.initializer, sourceFile, spec)
    ) {
      problems.push(`${spec.label}: discovery is not an exact awaited const initializer`);
    }

    const classConstructions: ts.NewExpression[] = [];
    const boundConstructions: BoundConstructor[] = [];
    const instanceOpenCalls: ts.CallExpression[] = [];
    visitExecutionBody(discovery.block, (node) => {
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === spec.className) {
        classConstructions.push(node);
        const bound = boundConstructor(node, spec);
        if (bound) boundConstructions.push(bound);
      }
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === spec.instanceBinding &&
        node.expression.name.text === "open"
      ) {
        instanceOpenCalls.push(node);
      }
    });

    if (classConstructions.length !== 1 || boundConstructions.length !== 1) {
      problems.push(
        `${spec.label}: constructor is not uniquely bound to ${spec.constructorBinding ?? spec.instanceBinding}`
      );
      continue;
    }
    const construction = boundConstructions[0];
    if (!construction) continue;
    if (instanceOpenCalls.length !== 1) {
      problems.push(`${spec.label}: ${spec.instanceBinding}.open call is not unique`);
      continue;
    }
    const openCall = instanceOpenCalls[0];
    if (!openCall) continue;
    let instanceAliasBinding: ts.Identifier | null = null;
    if (spec.constructorBinding && spec.constructorBinding !== spec.instanceBinding) {
      const aliases: ts.Identifier[] = [];
      visitExecutionBody(discovery.block, (node) => {
        if (
          ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name) &&
          node.name.text === spec.instanceBinding &&
          node.initializer !== undefined &&
          ts.isIdentifier(node.initializer) &&
          node.initializer.text === spec.constructorBinding &&
          (node.parent.flags & ts.NodeFlags.Const) !== 0
        ) {
          aliases.push(node.name);
        }
      });
      instanceAliasBinding = aliases.length === 1 ? (aliases[0] ?? null) : null;
      if (
        !instanceAliasBinding ||
        !(
          construction.expression.getStart(sourceFile) < instanceAliasBinding.getStart(sourceFile) &&
          instanceAliasBinding.getStart(sourceFile) < openCall.getStart(sourceFile)
        ) ||
        bindingMutationBetween(
          discovery.block,
          sourceFile,
          spec.constructorBinding,
          construction.expression.end,
          openCall.getStart(sourceFile)
        )
      ) {
        problems.push(
          `${spec.label}: constructor authority is not passed through one immutable ${spec.instanceBinding} alias`
        );
      }
    }
    const openArgument = openCall.arguments[0];
    const awaitedOpen = ts.isAwaitExpression(openCall.parent) ? openCall.parent : null;
    const exactOpen =
      awaitedOpen !== null &&
      ts.isExpressionStatement(awaitedOpen.parent) &&
      awaitedOpen.parent.expression === awaitedOpen &&
      openCall.arguments.length === 1 &&
      openArgument !== undefined &&
      ts.isIdentifier(openArgument) &&
      openArgument.text === spec.discoveryBinding;
    if (!exactOpen) {
      problems.push(`${spec.label}: awaited open is not bound to the exact discovery const`);
    }

    const discoveryAt = discovery.statement.getStart(sourceFile);
    const constructionAt = construction.expression.getStart(sourceFile);
    const openAt = openCall.getStart(sourceFile);
    if (!(discoveryAt < constructionAt && constructionAt < openAt)) {
      problems.push(`${spec.label}: discovery -> constructor -> open order changed`);
    }
    if (
      !isStaticallyReachableWithin(construction.expression, discovery.block) ||
      !isStaticallyReachableWithin(openCall, discovery.block) ||
      !constructionControlPathContainsOpen(construction.expression, openCall, discovery.block) ||
      !exactConditionalControlPath(construction.expression, openCall, discovery.block) ||
      tryBlockAncestorCount(openCall, discovery.block) !== (spec.openTryAncestors ?? 0)
    ) {
      problems.push(`${spec.label}: constructor/open pair is not on one reachable control path`);
    }
    if (!reviewedOpenFailurePolicy(openCall, sourceFile, discovery.block, spec)) {
      problems.push(`${spec.label}: reviewed open failure policy changed`);
    }
    if (bindingMutationBetween(discovery.block, sourceFile, spec.discoveryBinding, discovery.statement.end, openAt)) {
      problems.push(`${spec.label}: discovery binding is reassigned before open`);
    }

    let instanceUsedBeforeOpen = false;
    const visitInstanceUse = (node: ts.Node): void => {
      const at = node.getStart(sourceFile);
      if (
        ts.isIdentifier(node) &&
        node.text === spec.instanceBinding &&
        node !== construction.binding &&
        node !== instanceAliasBinding &&
        at >= discovery.block.getStart(sourceFile) &&
        at < openAt
      ) {
        instanceUsedBeforeOpen = true;
      }
      ts.forEachChild(node, visitInstanceUse);
    };
    ts.forEachChild(discovery.block, visitInstanceUse);
    if (
      hoistedInstanceCaptureInvokedBeforeOpen(sourceFile, discovery.block, sourceFile, spec.instanceBinding, openAt)
    ) {
      instanceUsedBeforeOpen = true;
    }
    if (instanceUsedBeforeOpen) {
      problems.push(`${spec.label}: constructed instance is used or reassigned before open`);
    }
  }
  if (specs.length !== 11) {
    problems.push(`discovery/open binding inventory: expected 11 specs, found ${specs.length}`);
  }
  return problems;
}

function realSafeMarkerCount(source: string): number {
  const sourceFile = ts.createSourceFile("safe-by-design-census.ts", source, ts.ScriptTarget.Latest, true);
  const ranges = new Map<string, ts.CommentRange>();
  const collect = (comments: readonly ts.CommentRange[] | undefined): void => {
    for (const comment of comments ?? []) {
      ranges.set(`${comment.pos}:${comment.end}`, comment);
    }
  };
  const visit = (node: ts.Node): void => {
    collect(ts.getLeadingCommentRanges(source, node.getFullStart()));
    collect(ts.getTrailingCommentRanges(source, node.getEnd()));
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...ranges.values()].filter(
    (comment) =>
      (comment.kind === ts.SyntaxKind.SingleLineCommentTrivia ||
        comment.kind === ts.SyntaxKind.MultiLineCommentTrivia) &&
      source.slice(comment.pos, comment.end).includes(SAFE_MARKER)
  ).length;
}

/** Keep the two clear-only exemptions closed over a real `.open()` call. */
function safeByDesignOpenProblems(cliSource: string): string[] {
  const problems: string[] = [];
  const specs = [
    {
      label: "CLI clear-index",
      start: '.command("clear-index")',
      end: "// v3.10.0-rc.14",
      className: "FtsIndex",
      instance: "idx"
    },
    {
      label: "CLI clear-embeddings",
      start: '.command("clear-embeddings")',
      end: "// v2.11.0",
      className: "EmbedDb",
      instance: "db"
    }
  ] as const;
  if (realSafeMarkerCount(cliSource) !== 2) {
    problems.push("SAFE BY DESIGN inventory: expected exactly two real comments");
  }
  for (const spec of specs) {
    const section = sectionBetween(cliSource, spec.label, spec.start, spec.end).text;
    if (section.length === 0 || realSafeMarkerCount(section) !== 1) {
      problems.push(`${spec.label}: exact real SAFE BY DESIGN comment is missing`);
      continue;
    }
    const sourceFile = ts.createSourceFile(`${spec.label}.ts`, section, ts.ScriptTarget.Latest, true);
    let constructors = 0;
    let constructorBinding: ts.Identifier | null = null;
    let clearCalls = 0;
    let clearReceiver: ts.Identifier | null = null;
    const instanceIdentifiers: ts.Identifier[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && node.text === spec.instance) {
        instanceIdentifiers.push(node);
      }
      if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === spec.className &&
        ts.isVariableDeclaration(node.parent) &&
        ts.isIdentifier(node.parent.name) &&
        node.parent.name.text === spec.instance
      ) {
        constructors++;
        constructorBinding = node.parent.name;
      }
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === spec.instance &&
        node.expression.name.text === "clearOnDisk" &&
        node.arguments.length === 0 &&
        ts.isAwaitExpression(node.parent) &&
        ts.isVariableDeclaration(node.parent.parent) &&
        node.parent.parent.initializer === node.parent &&
        ts.isIdentifier(node.parent.parent.name) &&
        node.parent.parent.name.text === "removed" &&
        (node.parent.parent.parent.flags & ts.NodeFlags.Const) !== 0
      ) {
        clearCalls++;
        clearReceiver = node.expression.expression;
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    if (constructors !== 1) problems.push(`${spec.label}: safe constructor binding changed`);
    if (clearCalls !== 1) problems.push(`${spec.label}: exact awaited clearOnDisk call changed`);
    if (
      constructorBinding === null ||
      clearReceiver === null ||
      instanceIdentifiers.length !== 2 ||
      !instanceIdentifiers.includes(constructorBinding) ||
      !instanceIdentifiers.includes(clearReceiver)
    ) {
      problems.push(`${spec.label}: safe instance use escaped sole clearOnDisk call`);
    }
  }
  return problems;
}

/** Pin the path-free supported-model projection used after full-class storage discovery. */
function storedEmbeddingConfigurationHelperProblems(source: string): string[] {
  const problems: string[] = [];
  const resolver = sectionBetween(
    source,
    "shared stored Embed resolver",
    "export function resolveStoredEmbeddingConfiguration(",
    "\n}\n"
  ).text;
  const needles = [
    ["schema-version presence check", "meta.schema_version === undefined"],
    ["model alias presence check", "meta.model_alias === undefined"],
    ["dimension presence check", "meta.dim === undefined"],
    ["legacy v1 f32 normalization", 'meta.schema_version === "1"'],
    ["legacy v2 f32 normalization", 'meta.schema_version === "2"'],
    ["f32 quantization check", 'quantization !== "f32"'],
    ["int8 quantization check", 'quantization !== "int8"'],
    ["catalog resolution", "resolveModel(meta.model_alias)"],
    ["catalog dimension comparison", "String(model.dim) !== meta.dim"],
    ["generic path-free refusal", 'throw new Error("Embedding index configuration could not be verified")']
  ] as const;
  if (resolver.length === 0) return ["shared stored Embed configuration resolver is missing"];
  for (const [problem, needle] of needles) {
    if (!resolver.includes(needle)) problems.push(`shared stored Embed resolver: ${problem} is missing`);
  }
  if (/`[^`]*\$\{\s*meta\./u.test(resolver)) {
    problems.push("shared stored Embed resolver: stored metadata is interpolated into an error");
  }
  return problems;
}

interface AdmissionOrderSpec {
  label: "Embed" | "FTS";
  className: "EmbedDb" | "FtsIndex";
  mutatingOpenStart: string;
  mutatingOpenEnd: string;
  publicOpenParameterType: "EmbedDbConfigDiscovery" | "FtsIndexDiscovery";
  cloneStatement: string;
  liveFastPath: string;
  initialJoin: string;
  unsafeInitialJoin: string;
  closeDrain: string;
  closeCondition: string;
  closeTokenCapture: string;
  closeFinish: string;
  closeSupersededGuard: string;
  closeReset: readonly string[];
  postDrainJoin: string;
  delegation: string;
  attemptSentinel: "null" | "undefined";
  admissionContainer: "direct" | "try";
  freshMkdir: string;
  handle: string;
  firstGuard: string;
  firstAssert?: string;
  expectedAssert: string;
  bootstrapCall: string;
  bootstrapStart: string;
  bootstrapEnd: string;
  bootstrapPrefix: readonly string[];
  secondGuard: string;
  secondAssert?: string;
  continuityCheck: string;
  continuityThrow: string;
}

interface BoundedAdmissionSpec {
  label: "Embed" | "FTS";
  start: string;
  end: string;
  nameCap: string;
  sqlCap: string;
  objectCap: string;
  valueCap: string;
}

/** Guard bounded SQL projections, not merely rejection after unbounded reads. */
function boundedAdmissionProjectionProblems(source: string, spec: BoundedAdmissionSpec): string[] {
  const problems: string[] = [];
  const admission = sectionBetween(source, `${spec.label} admission`, spec.start, spec.end).text;
  const metaProjectionAt = admission.indexOf("substr(key, 1, ?) AS key");
  const schemaRegion = admission.slice(0, metaProjectionAt >= 0 ? metaProjectionAt : admission.length);
  const metaRegion = metaProjectionAt >= 0 ? admission.slice(metaProjectionAt) : "";
  const schemaNeedles = [
    ["bounded sqlite_master name projection", "substr(name, 1, ?) AS name"],
    ["bounded sqlite_master SQL projection", "substr(sql, 1, ?) AS sql"],
    ["sqlite_master source", "FROM sqlite_master"],
    ["sqlite_master row limit", "LIMIT ?"],
    ["sqlite_master name cap sentinel", `${spec.nameCap} + 1`],
    ["sqlite_master SQL cap sentinel", `${spec.sqlCap} + 1`],
    ["sqlite_master object cap sentinel", `${spec.objectCap} + 1`]
  ] as const;
  const metaNeedles = [
    ["bounded meta key projection", "substr(key, 1, ?) AS key"],
    ["bounded meta value projection", "substr(value, 1, ?) AS value"],
    ["meta source", "FROM meta"],
    ["meta row limit", "LIMIT"],
    ["meta key cap sentinel", `${spec.nameCap} + 1`],
    ["meta value cap sentinel", `${spec.valueCap} + 1`]
  ] as const;
  for (const [label, needle] of schemaNeedles) {
    if (!schemaRegion.includes(needle)) problems.push(`${spec.label} admission: ${label} is missing`);
  }
  for (const [label, needle] of metaNeedles) {
    if (!metaRegion.includes(needle)) problems.push(`${spec.label} admission: ${label} is missing`);
  }
  const schemaProjectionAt = admission.indexOf("substr(name, 1, ?) AS name");
  const schemaSourceAt = admission.indexOf("FROM sqlite_master");
  const metaSourceAt = admission.indexOf("FROM meta");
  if (schemaProjectionAt >= 0 && schemaSourceAt >= 0 && schemaProjectionAt > schemaSourceAt) {
    problems.push(`${spec.label} admission: sqlite_master projection is not applied before source read`);
  }
  if (metaProjectionAt >= 0 && metaSourceAt >= 0 && metaProjectionAt > metaSourceAt) {
    problems.push(`${spec.label} admission: meta projection is not applied before source read`);
  }
  return problems;
}

const EMBED_BOUNDED_ADMISSION: BoundedAdmissionSpec = {
  label: "Embed",
  start: "function inspectEmbedAdmission(db: Db, expectedVaultRoot: string): EmbedAdmission {",
  end: "function assertEmbedAdmission(",
  nameCap: "MAX_EMBED_ADMISSION_NAME_CHARS",
  sqlCap: "MAX_EMBED_ADMISSION_SQL_CHARS",
  objectCap: "MAX_EMBED_ADMISSION_OBJECTS",
  valueCap: "MAX_EMBED_META_VALUE_CHARS"
};

const FTS_BOUNDED_ADMISSION: BoundedAdmissionSpec = {
  label: "FTS",
  start: "  protected inspectAdmission(",
  end: "  private writeMeta(",
  nameCap: "MAX_FTS_ADMISSION_NAME_CHARS",
  sqlCap: "MAX_FTS_ADMISSION_SQL_CHARS",
  objectCap: "MAX_FTS_ADMISSION_OBJECTS",
  valueCap: "MAX_FTS_META_VALUE_CHARS"
};

function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .trim();
}

function exactClassMethod(
  sourceFile: ts.SourceFile,
  className: string,
  methodName: string
): ts.MethodDeclaration | null {
  const classDeclarations = sourceFile.statements.filter(
    (statement): statement is ts.ClassDeclaration =>
      ts.isClassDeclaration(statement) && statement.name?.text === className
  );
  const classDeclaration = classDeclarations.length === 1 ? classDeclarations[0] : undefined;
  if (!classDeclaration) return null;
  const methods = classDeclaration.members.filter(
    (member): member is ts.MethodDeclaration =>
      ts.isMethodDeclaration(member) && ts.isIdentifier(member.name) && member.name.text === methodName
  );
  return methods.length === 1 ? (methods[0] ?? null) : null;
}

function directStatementsWithExactText(
  method: ts.MethodDeclaration,
  sourceFile: ts.SourceFile,
  expected: string
): ts.Statement[] {
  return method.body?.statements.filter((statement) => statement.getText(sourceFile) === expected) ?? [];
}

/**
 * Protect the stable public API and its single-flight orchestration separately
 * from the mutating admission performed by `openOnce`. Keeping these checks
 * separate prevents a future refactor from satisfying the admission invariant
 * with a decoy in the public wrapper while bypassing its join/close state
 * machine.
 */
function publicOpenWrapperProblems(source: string, spec: AdmissionOrderSpec): string[] {
  const problems: string[] = [];
  const sourceFile = ts.createSourceFile(
    `${spec.className}.ts`,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const method = exactClassMethod(sourceFile, spec.className, "open");
  if (!method?.body) return [`${spec.label} public open: exact AST method is missing`];

  const parameter = method.parameters.length === 1 ? method.parameters[0] : undefined;
  const modifiers = method.modifiers?.map((modifier) => modifier.kind) ?? [];
  const signatureIsExact =
    modifiers.length === 1 &&
    modifiers.includes(ts.SyntaxKind.AsyncKeyword) &&
    !modifiers.includes(ts.SyntaxKind.PrivateKeyword) &&
    !modifiers.includes(ts.SyntaxKind.ProtectedKeyword) &&
    !modifiers.includes(ts.SyntaxKind.StaticKeyword) &&
    parameter !== undefined &&
    ts.isIdentifier(parameter.name) &&
    parameter.name.text === "expectedDiscovery" &&
    parameter.questionToken !== undefined &&
    parameter.dotDotDotToken === undefined &&
    parameter.initializer === undefined &&
    parameter.type?.getText(sourceFile) === spec.publicOpenParameterType &&
    method.type?.getText(sourceFile) === "Promise<void>";
  if (!signatureIsExact) {
    problems.push(`${spec.label} public open: exact optional-discovery API signature changed`);
  }

  const statements = method.body.statements;
  const direct = (text: string): ts.Statement[] => directStatementsWithExactText(method, sourceFile, text);
  const liveFastPaths = direct(spec.liveFastPath);
  const joinTextIsShared = spec.initialJoin === spec.postDrainJoin;
  const initialJoinCandidates = direct(spec.initialJoin);
  const initialJoins = joinTextIsShared ? initialJoinCandidates.slice(0, 1) : initialJoinCandidates;
  const clones = direct(spec.cloneStatement);
  const closeDrains = direct(spec.closeDrain);
  const closeBranches = statements.filter(
    (statement): statement is ts.IfStatement =>
      ts.isIfStatement(statement) && statement.expression.getText(sourceFile) === spec.closeCondition
  );
  const closeBranch = closeBranches.length === 1 ? closeBranches[0] : undefined;
  const closeBlock = closeBranch && ts.isBlock(closeBranch.thenStatement) ? closeBranch.thenStatement : undefined;
  const closeStatements = closeBlock?.statements ?? [];
  const closeText = (expected: string): ts.Statement[] =>
    closeStatements.filter((statement) => statement.getText(sourceFile) === expected);
  const tokenCaptures = closeText(spec.closeTokenCapture);
  const privateFinishes = closeText(spec.closeFinish);
  const supersededGuards = closeText(spec.closeSupersededGuard);
  const postDrainJoins = joinTextIsShared ? initialJoinCandidates.slice(1, 2) : direct(spec.postDrainJoin);
  const delegations = direct(spec.delegation);
  const assignments = direct("this.openAttempt = attempt;");
  const trackedTryText =
    `try {\n      await attempt;\n    } finally {\n` +
    `      if (this.openAttempt === attempt) this.openAttempt = ${spec.attemptSentinel};\n` +
    "    }";
  const trackedTries = direct(trackedTryText);
  const openOnceCalls: ts.CallExpression[] = [];
  const awaits: ts.AwaitExpression[] = [];
  const inspectWrapper = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(sourceFile) === "this.openOnce" &&
      node.arguments.length === 1
    ) {
      openOnceCalls.push(node);
    }
    if (ts.isAwaitExpression(node)) awaits.push(node);
    ts.forEachChild(node, inspectWrapper);
  };
  inspectWrapper(method.body);

  if (liveFastPaths.length !== 1) {
    problems.push(`${spec.label} public open: exact live-handle no-op guard is not unique`);
  }
  if (initialJoins.length !== 1 || (joinTextIsShared && initialJoinCandidates.length > 2)) {
    problems.push(`${spec.label} public open: exact pre-drain single-flight join is not unique`);
  }
  if (clones.length !== 1) {
    problems.push(`${spec.label} public open: caller authority snapshot is not unique`);
  }
  if (closeDrains.length !== 1) {
    problems.push(`${spec.label} public open: exact close-drain branch is not unique`);
  }
  if (closeBranches.length !== 1 || !closeBlock) {
    problems.push(`${spec.label} public open: close-drain condition/block changed`);
  }
  if (tokenCaptures.length !== 1) {
    problems.push(`${spec.label} public open: close-request token capture is not unique`);
  }
  if (privateFinishes.length !== 1) {
    problems.push(`${spec.label} public open: private close drain changed`);
  }
  if (supersededGuards.length !== 1) {
    problems.push(`${spec.label} public open: later-close generation guard changed`);
  }
  const expectedCloseSequence = [
    spec.closeTokenCapture,
    spec.closeFinish,
    spec.closeSupersededGuard,
    ...spec.closeReset
  ];
  if (
    closeStatements.length !== expectedCloseSequence.length ||
    expectedCloseSequence.some((expected, index) => closeStatements[index]?.getText(sourceFile) !== expected)
  ) {
    problems.push(`${spec.label} public open: token-capture/drain/compare/reset sequence changed`);
  }
  if (postDrainJoins.length !== 1 || (joinTextIsShared && initialJoinCandidates.length !== 2)) {
    problems.push(`${spec.label} public open: post-drain single-flight recheck is not unique`);
  }
  if (delegations.length !== 1) {
    problems.push(`${spec.label} public open: exact openOnce delegation is not unique`);
  }
  if (openOnceCalls.length !== 1 || openOnceCalls[0]?.getText(sourceFile) !== "this.openOnce(expected)") {
    problems.push(`${spec.label} public open: openOnce call census changed`);
  }
  if (assignments.length !== 1 || trackedTries.length !== 1) {
    problems.push(`${spec.label} public open: tracked single-flight settlement changed`);
  }

  const liveFastPath = liveFastPaths[0];
  const initialJoin = initialJoins[0];
  const clone = clones[0];
  const closeDrain = closeDrains[0];
  const postDrainJoin = postDrainJoins[0];
  const delegation = delegations[0];
  const assignment = assignments[0];
  const trackedTry = trackedTries[0];
  const ordered = [liveFastPath, initialJoin, clone, closeDrain, postDrainJoin, delegation, assignment, trackedTry];
  if (
    ordered.some((statement) => statement === undefined) ||
    ordered.some((statement, index) => index > 0 && statement!.getStart(sourceFile) <= ordered[index - 1]!.end)
  ) {
    problems.push(`${spec.label} public open: fast-path/clone/drain/join/delegate order changed`);
  }
  if (delegation && assignment && statements.indexOf(assignment) !== statements.indexOf(delegation) + 1) {
    problems.push(`${spec.label} public open: openOnce promise is not immediately tracked`);
  }
  if (assignment && trackedTry && statements.indexOf(trackedTry) !== statements.indexOf(assignment) + 1) {
    problems.push(`${spec.label} public open: tracked promise settlement is not adjacent`);
  }
  const firstAwait = awaits.sort((left, right) => left.getStart(sourceFile) - right.getStart(sourceFile))[0];
  if (!clone || (firstAwait && clone.end >= firstAwait.getStart(sourceFile))) {
    problems.push(`${spec.label} public open: caller authority is not snapshotted before the first await`);
  }

  const mutatingTokens = [
    "preflightSqliteArtifactFamily(",
    "loadBetterSqlite()",
    "new Ctor(",
    spec.firstGuard,
    spec.expectedAssert,
    spec.bootstrapCall
  ];
  const methodText = method.getText(sourceFile);
  if (mutatingTokens.some((token) => methodText.includes(token))) {
    problems.push(`${spec.label} public open: mutating admission escaped openOnce`);
  }
  return problems;
}

function statementsWithExactText(root: ts.Node, sourceFile: ts.SourceFile, expected: string): ts.Statement[] {
  const matches: ts.Statement[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isExpressionStatement(node) || ts.isVariableStatement(node)) && node.getText(sourceFile) === expected) {
      matches.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return matches;
}

function callCountBetween(root: ts.Node, sourceFile: ts.SourceFile, start: number, end: number): number {
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.getStart(sourceFile) >= start && node.end <= end) count++;
    ts.forEachChild(node, visit);
  };
  visit(root);
  return count;
}

function exactTransactionCallback(method: ts.MethodDeclaration, sourceFile: ts.SourceFile): ts.Block | null {
  if (!method.body) return null;
  const candidates: ts.Block[] = [];
  for (const statement of method.body.statements) {
    if (!ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1) continue;
    const declaration = statement.declarationList.declarations[0];
    if (!declaration || !ts.isIdentifier(declaration.name) || declaration.name.text !== "txn") continue;
    const initializer = declaration.initializer;
    if (!initializer || !ts.isCallExpression(initializer)) continue;
    if (initializer.expression.getText(sourceFile) !== "db.transaction" || initializer.arguments.length !== 1) {
      continue;
    }
    const callback = initializer.arguments[0];
    if (callback && ts.isArrowFunction(callback) && ts.isBlock(callback.body)) candidates.push(callback.body);
  }
  return candidates.length === 1 ? (candidates[0] ?? null) : null;
}

function directTryStatement(statement: ts.Statement): ts.TryStatement | null {
  const block = statement.parent;
  if (!ts.isBlock(block)) return null;
  const candidate = block.parent;
  return ts.isTryStatement(candidate) && candidate.tryBlock === block ? candidate : null;
}

function isExactTransactionDeclaration(
  statement: ts.Statement | undefined,
  sourceFile: ts.SourceFile,
  callback: ts.Block | null
): boolean {
  if (!statement || !ts.isVariableStatement(statement)) return false;
  if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) return false;
  if (statement.declarationList.declarations.length !== 1) return false;
  const declaration = statement.declarationList.declarations[0];
  if (!declaration || !ts.isIdentifier(declaration.name) || declaration.name.text !== "txn") return false;
  const initializer = declaration.initializer;
  if (!initializer || !ts.isCallExpression(initializer)) return false;
  if (initializer.expression.getText(sourceFile) !== "db.transaction" || initializer.arguments.length !== 1) {
    return false;
  }
  const transactionCallback = initializer.arguments[0];
  return (
    transactionCallback !== undefined &&
    ts.isArrowFunction(transactionCallback) &&
    ts.isBlock(transactionCallback.body) &&
    transactionCallback.body === callback
  );
}

function isExactContinuityGuard(
  statement: ts.Statement | undefined,
  sourceFile: ts.SourceFile,
  condition: string,
  directThrow: string
): boolean {
  if (!statement || !ts.isIfStatement(statement) || statement.elseStatement) return false;
  if (`if (${statement.expression.getText(sourceFile)})` !== condition) return false;
  const directStatements = ts.isBlock(statement.thenStatement)
    ? statement.thenStatement.statements
    : [statement.thenStatement];
  const onlyStatement = directStatements.length === 1 ? directStatements[0] : undefined;
  return (
    onlyStatement !== undefined &&
    ts.isThrowStatement(onlyStatement) &&
    onlyStatement.getText(sourceFile) === directThrow
  );
}

function admissionOrderProblems(source: string, spec: AdmissionOrderSpec): string[] {
  const problems: string[] = [];
  const open = sectionBetween(
    source,
    `${spec.label} mutating openOnce`,
    spec.mutatingOpenStart,
    spec.mutatingOpenEnd
  ).text;
  const bootstrap = sectionBetween(source, `${spec.label} bootstrap`, spec.bootstrapStart, spec.bootstrapEnd).text;
  const artifactChmod = `[this.file, \`\${this.file}-wal\`, \`\${this.file}-shm\`].map((p) => fs.chmod`;
  const openSteps = [
    { label: "live handle", needle: spec.handle },
    { label: "first guard", needle: spec.firstGuard },
    ...(spec.firstAssert ? [{ label: "first guard assertion", needle: spec.firstAssert }] : []),
    { label: "expected-discovery assertion", needle: spec.expectedAssert },
    { label: "bootstrap", needle: spec.bootstrapCall },
    { label: "journal_mode", needle: 'this.db.pragma("journal_mode = WAL")' },
    { label: "synchronous", needle: 'this.db.pragma("synchronous = NORMAL")' },
    { label: "artifact chmod", needle: artifactChmod }
  ];
  let previousAt = -1;
  let previousLabel = "method start";
  for (const step of openSteps) {
    const at = open.indexOf(step.needle);
    if (at < 0) {
      problems.push(`${spec.label} openOnce: ${step.label} is missing`);
      continue;
    }
    if (at < previousAt) {
      problems.push(`${spec.label} openOnce: ${step.label} runs before ${previousLabel}`);
    }
    previousAt = at;
    previousLabel = step.label;
  }

  const sourceFile = ts.createSourceFile(
    `${spec.className}.ts`,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const openMethod = exactClassMethod(sourceFile, spec.className, "openOnce");
  if (!openMethod?.body) {
    problems.push(`${spec.label} openOnce: exact AST method is missing`);
  } else {
    const parameter = openMethod.parameters.length === 1 ? openMethod.parameters[0] : undefined;
    const modifiers = openMethod.modifiers?.map((modifier) => modifier.kind) ?? [];
    const signatureIsExact =
      modifiers.length === 2 &&
      modifiers[0] === ts.SyntaxKind.PrivateKeyword &&
      modifiers[1] === ts.SyntaxKind.AsyncKeyword &&
      modifiers.includes(ts.SyntaxKind.PrivateKeyword) &&
      modifiers.includes(ts.SyntaxKind.AsyncKeyword) &&
      !modifiers.includes(ts.SyntaxKind.PublicKeyword) &&
      !modifiers.includes(ts.SyntaxKind.ProtectedKeyword) &&
      !modifiers.includes(ts.SyntaxKind.StaticKeyword) &&
      parameter !== undefined &&
      ts.isIdentifier(parameter.name) &&
      parameter.name.text === "expected" &&
      parameter.questionToken === undefined &&
      parameter.dotDotDotToken === undefined &&
      parameter.initializer === undefined &&
      parameter.type?.getText(sourceFile) === `${spec.publicOpenParameterType} | null` &&
      openMethod.type?.getText(sourceFile) === "Promise<void>";
    if (!signatureIsExact) {
      problems.push(`${spec.label} openOnce: exact private mutating signature changed`);
    }
    const handles = statementsWithExactText(openMethod.body, sourceFile, spec.handle);
    const firstGuards = statementsWithExactText(openMethod.body, sourceFile, spec.firstGuard);
    const firstAssertions = spec.firstAssert
      ? statementsWithExactText(openMethod.body, sourceFile, spec.firstAssert)
      : [];
    const expectedAssertions = statementsWithExactText(openMethod.body, sourceFile, spec.expectedAssert);
    const bootstraps = statementsWithExactText(openMethod.body, sourceFile, spec.bootstrapCall);
    const familyPreflights = statementsWithExactText(
      openMethod.body,
      sourceFile,
      "fileExisted = await preflightSqliteArtifactFamily(this.file);"
    );
    if (handles.length !== 1) {
      problems.push(`${spec.label} openOnce: exact AST live-handle assignment is not unique`);
    }
    if (firstGuards.length !== 1) {
      problems.push(`${spec.label} openOnce: exact AST first guard is not unique`);
    }
    if (spec.firstAssert && firstAssertions.length !== 1) {
      problems.push(`${spec.label} openOnce: exact AST first guard assertion is not unique`);
    }
    if (expectedAssertions.length !== 1) {
      problems.push(`${spec.label} openOnce: exact AST expected-discovery assertion is not unique`);
    }
    if (bootstraps.length !== 1) {
      problems.push(`${spec.label} openOnce: exact AST bootstrap call is not unique`);
    }
    const handle = handles[0];
    const firstGuard = firstGuards[0];
    if (handle && firstGuard) {
      if (handle.end >= firstGuard.getStart(sourceFile)) {
        problems.push(`${spec.label} openOnce: AST first guard does not follow live handle`);
      } else if (callCountBetween(openMethod.body, sourceFile, handle.end, firstGuard.getStart(sourceFile)) > 0) {
        problems.push(`${spec.label} openOnce: call runs between live handle and first guard`);
      }
    }
    const handleTry = handle ? directTryStatement(handle) : null;
    const finalPreflight = familyPreflights.find(
      (statement) => handleTry !== null && directTryStatement(statement) === handleTry
    );
    const admissionTry = firstGuard && spec.admissionContainer === "try" ? directTryStatement(firstGuard) : null;
    const directBlock = handleTry?.parent;
    const peerStatements = directBlock && ts.isBlock(directBlock) ? directBlock.statements : undefined;
    const handleTryAt = handleTry && peerStatements ? peerStatements.indexOf(handleTry) : -1;
    const admissionTryAt = admissionTry && peerStatements ? peerStatements.indexOf(admissionTry) : -1;
    const guardedStatements = [
      firstGuard,
      ...(spec.firstAssert ? [firstAssertions[0]] : []),
      expectedAssertions[0],
      bootstraps[0]
    ];
    const guardedSequenceIsExact = guardedStatements.every((statement, index) => {
      if (statement === undefined) return false;
      if (spec.admissionContainer === "try") return admissionTry?.tryBlock.statements[index] === statement;
      return peerStatements?.[handleTryAt + 1 + index] === statement;
    });
    if (
      handleTry?.tryBlock.statements.length !== 2 ||
      handleTry.tryBlock.statements[0] !== finalPreflight ||
      handleTry.tryBlock.statements[1] !== handle
    ) {
      problems.push(`${spec.label} openOnce: final SQLite family preflight is not immediately before live handle`);
    }
    const admissionPlacementIsExact =
      spec.admissionContainer === "try"
        ? admissionTry !== null && admissionTry.parent === directBlock && admissionTryAt === handleTryAt + 1
        : firstGuard?.parent === directBlock;
    if (handleTryAt < 0 || !admissionPlacementIsExact || !guardedSequenceIsExact) {
      problems.push(`${spec.label} openOnce: exact guarded admission sequence changed`);
    }
  }

  const bootstrapMethod = exactClassMethod(sourceFile, spec.className, "bootstrapSchema");
  const callback = bootstrapMethod ? exactTransactionCallback(bootstrapMethod, sourceFile) : null;
  if (!bootstrapMethod?.body) {
    problems.push(`${spec.label} bootstrap: exact AST method is missing`);
  } else if (!callback) {
    problems.push(`${spec.label} bootstrap: exact db.transaction arrow callback is missing`);
  } else {
    const topLevelStatements = bootstrapMethod.body.statements;
    const prefixIsExact = spec.bootstrapPrefix.every(
      (expected, index) => topLevelStatements[index]?.getText(sourceFile) === expected
    );
    const transactionAt = spec.bootstrapPrefix.length;
    const immediateAt = transactionAt + 1;
    if (
      topLevelStatements.length !== immediateAt + 1 ||
      !prefixIsExact ||
      !isExactTransactionDeclaration(topLevelStatements[transactionAt], sourceFile, callback) ||
      topLevelStatements[immediateAt]?.getText(sourceFile) !== "txn.immediate();"
    ) {
      problems.push(`${spec.label} bootstrap: exact top-level sequence changed`);
    }

    const callbackStatements = callback.statements;
    const guardIsExact = callbackStatements[0]?.getText(sourceFile) === spec.secondGuard;
    const assertionOffset = spec.secondAssert ? 1 : 0;
    const assertionIsExact =
      spec.secondAssert === undefined || callbackStatements[1]?.getText(sourceFile) === spec.secondAssert;
    const continuityIsExact = isExactContinuityGuard(
      callbackStatements[1 + assertionOffset],
      sourceFile,
      spec.continuityCheck,
      spec.continuityThrow
    );
    if (!guardIsExact || !assertionIsExact || !continuityIsExact) {
      problems.push(`${spec.label} bootstrap: guarded callback leading statement grammar changed`);
    }
  }

  const transactionNeedle = "const txn = db.transaction(() => {";
  const transactionAt = bootstrap.indexOf(transactionNeedle);
  const secondGuardAt = bootstrap.indexOf(spec.secondGuard);
  const secondAssertAt = spec.secondAssert ? bootstrap.indexOf(spec.secondAssert) : secondGuardAt;
  const continuityAt = bootstrap.indexOf(spec.continuityCheck);
  const firstDdlAt = bootstrap.indexOf("db.exec(`");
  const writeMetaAt = bootstrap.indexOf("this.writeMeta({");
  const immediateAt = bootstrap.indexOf("txn.immediate();");
  for (const [label, at] of [
    ["IMMEDIATE transaction wrapper", transactionAt],
    ["second guard", secondGuardAt],
    ["second guard assertion", secondAssertAt],
    ["guard continuity comparison", continuityAt],
    ["first DDL", firstDdlAt],
    ["metadata write", writeMetaAt],
    ["IMMEDIATE invocation", immediateAt]
  ] as const) {
    if (at < 0) problems.push(`${spec.label} bootstrap: ${label} is missing`);
  }
  if (transactionAt >= 0 && secondGuardAt >= 0) {
    const callbackPrefix = bootstrap.slice(transactionAt + transactionNeedle.length, secondGuardAt);
    if (withoutComments(callbackPrefix).length > 0) {
      problems.push(`${spec.label} bootstrap: second guard is not the first callback action`);
    }
  }
  if (secondGuardAt >= 0 && firstDdlAt >= 0 && secondGuardAt > firstDdlAt) {
    problems.push(`${spec.label} bootstrap: second guard is not before first DDL`);
  }
  if (secondAssertAt >= 0 && firstDdlAt >= 0 && secondAssertAt > firstDdlAt) {
    problems.push(`${spec.label} bootstrap: second guard assertion is not before first DDL`);
  }
  if (continuityAt >= 0 && firstDdlAt >= 0 && continuityAt > firstDdlAt) {
    problems.push(`${spec.label} bootstrap: guard continuity comparison is not before first DDL`);
  }
  if (firstDdlAt >= 0 && writeMetaAt >= 0 && firstDdlAt > writeMetaAt) {
    problems.push(`${spec.label} bootstrap: metadata write precedes first DDL`);
  }
  if (writeMetaAt >= 0 && immediateAt >= 0 && writeMetaAt > immediateAt) {
    problems.push(`${spec.label} bootstrap: IMMEDIATE invocation does not wrap metadata write`);
  }
  if (bootstrap.includes("\n    txn();")) {
    problems.push(`${spec.label} bootstrap: deferred transaction invocation remains`);
  }
  return problems;
}

function mutateOpenOnceExactly(
  source: string,
  spec: AdmissionOrderSpec,
  needle: string,
  replacement: string,
  expectedOccurrences = 1
): string {
  const openOnce = sectionBetween(
    source,
    `${spec.label} mutating openOnce mutation`,
    spec.mutatingOpenStart,
    spec.mutatingOpenEnd
  ).text;
  const mutantOpenOnce = replaceExactly(openOnce, needle, replacement, expectedOccurrences);
  return replaceExactly(source, openOnce, mutantOpenOnce);
}

function mutatePublicOpenExactly(
  source: string,
  spec: AdmissionOrderSpec,
  needle: string,
  replacement: string,
  expectedOccurrences = 1
): string {
  const publicOpen = sectionBetween(
    source,
    `${spec.label} public open mutation`,
    `  async open(expectedDiscovery?: ${spec.publicOpenParameterType}): Promise<void> {`,
    spec.mutatingOpenStart
  ).text;
  const mutantPublicOpen = replaceExactly(publicOpen, needle, replacement, expectedOccurrences);
  return replaceExactly(source, publicOpen, mutantPublicOpen);
}

const FTS_ADMISSION_ORDER: AdmissionOrderSpec = {
  label: "FTS",
  className: "FtsIndex",
  mutatingOpenStart: "  private async openOnce(expected: FtsIndexDiscovery | null): Promise<void> {",
  mutatingOpenEnd: "  /**\n   * Remove the index file",
  publicOpenParameterType: "FtsIndexDiscovery",
  cloneStatement: "const expected = cloneFtsIndexDiscovery(expectedDiscovery);",
  liveFastPath: "if (this.db && !this.closeRequested) return;",
  initialJoin:
    "if (this.openAttempt !== undefined && !this.closeRequested && this.closeAttempt === undefined) {\n" +
    "      return this.openAttempt;\n" +
    "    }",
  unsafeInitialJoin: "if (this.openAttempt !== undefined) return this.openAttempt;",
  closeDrain:
    "if (this.closeRequested || this.closeAttempt !== undefined) {\n" +
    "      const observedCloseRequest = this.closeRequestToken;\n" +
    "      await this.finishCloseAndRelease();\n" +
    "      if (this.closeRequestToken !== observedCloseRequest) {\n" +
    '        throw new Error("FTS index reopen was superseded by a later close request");\n' +
    "      }\n" +
    "      this.closeAttempt = undefined;\n" +
    "      this.closeAttemptFailed = false;\n" +
    "      this.closeRequested = false;\n" +
    "    }",
  closeCondition: "this.closeRequested || this.closeAttempt !== undefined",
  closeTokenCapture: "const observedCloseRequest = this.closeRequestToken;",
  closeFinish: "await this.finishCloseAndRelease();",
  closeSupersededGuard:
    "if (this.closeRequestToken !== observedCloseRequest) {\n" +
    '        throw new Error("FTS index reopen was superseded by a later close request");\n' +
    "      }",
  closeReset: ["this.closeAttempt = undefined;", "this.closeAttemptFailed = false;", "this.closeRequested = false;"],
  postDrainJoin: "if (this.openAttempt !== undefined) return this.openAttempt;",
  delegation: "const attempt = this.openOnce(expected);",
  attemptSentinel: "undefined",
  admissionContainer: "try",
  freshMkdir: "fs.mkdir(parentDir, { recursive: true, mode: 0o700 })",
  handle: "this.db = new Ctor(this.file) as Db;",
  firstGuard: "const initialAdmission = this.inspectAdmission();",
  expectedAssert: "assertExpectedFtsDiscovery(expected, fileExisted, initialAdmission);",
  bootstrapCall: "this.bootstrapSchema(initialAdmission);",
  bootstrapStart: "  private bootstrapSchema(initialAdmission: FtsAdmission): void {",
  bootstrapEnd: "  protected inspectAdmission(",
  bootstrapPrefix: [
    "const db = this.requireDb();",
    'const tokenizeArg = this.tokenize === "trigram" ? "trigram" : "unicode61 remove_diacritics 2";'
  ],
  secondGuard: "const admission = this.inspectAdmission();",
  continuityCheck:
    "if (admission.kind !== initialAdmission.kind || admission.signature !== initialAdmission.signature)",
  continuityThrow: 'throw new Error("FTS index ownership changed during admission");'
};

const EMBED_ADMISSION_ORDER: AdmissionOrderSpec = {
  label: "Embed",
  className: "EmbedDb",
  mutatingOpenStart: "  private async openOnce(expected: EmbedDbConfigDiscovery | null): Promise<void> {",
  mutatingOpenEnd: "  /**\n   * Remove the embed db",
  publicOpenParameterType: "EmbedDbConfigDiscovery",
  cloneStatement: "const expected = cloneEmbedDbOpenDiscovery(expectedDiscovery);",
  liveFastPath: "if (this.db && !this.closeRequested) return;",
  initialJoin: "if (this.openAttempt && !this.closeRequested && !this.closeAttempt) return this.openAttempt;",
  unsafeInitialJoin: "if (this.openAttempt) return this.openAttempt;",
  closeDrain:
    "if (this.closeRequested || this.closeAttempt) {\n" +
    "      const observedCloseRequest = this.closeRequestToken;\n" +
    "      await this.finishCloseAndRelease();\n" +
    "      if (this.closeRequestToken !== observedCloseRequest) {\n" +
    '        throw new Error("Embedding index reopen was superseded by a later close request");\n' +
    "      }\n" +
    "      this.closeAttempt = null;\n" +
    "      this.closeAttemptFailed = false;\n" +
    "      this.closeRequested = false;\n" +
    "    }",
  closeCondition: "this.closeRequested || this.closeAttempt",
  closeTokenCapture: "const observedCloseRequest = this.closeRequestToken;",
  closeFinish: "await this.finishCloseAndRelease();",
  closeSupersededGuard:
    "if (this.closeRequestToken !== observedCloseRequest) {\n" +
    '        throw new Error("Embedding index reopen was superseded by a later close request");\n' +
    "      }",
  closeReset: ["this.closeAttempt = null;", "this.closeAttemptFailed = false;", "this.closeRequested = false;"],
  postDrainJoin: "if (this.openAttempt) return this.openAttempt;",
  delegation: "const attempt = this.openOnce(expected);",
  attemptSentinel: "null",
  admissionContainer: "direct",
  freshMkdir: "fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 })",
  handle: "this.db = new Ctor(this.file) as Db;",
  firstGuard: "const admission = inspectEmbedAdmission(this.db, this.vaultRoot);",
  firstAssert: "assertEmbedAdmission(admission);",
  expectedAssert: "assertExpectedEmbedDiscovery(expected, fileExisted, admission);",
  bootstrapCall: "this.bootstrapSchema(admission.kind, admission.signature);",
  bootstrapStart: '  private bootstrapSchema(initialKind: "empty" | "owned", initialSignature: string): void {',
  bootstrapEnd: "  private writeMeta(",
  bootstrapPrefix: ["const db = this.requireDb();"],
  secondGuard: "const admission = inspectEmbedAdmission(db, this.vaultRoot);",
  secondAssert: "assertEmbedAdmission(admission);",
  continuityCheck: "if (admission.kind !== initialKind || admission.signature !== initialSignature)",
  continuityThrow: 'throw new Error("Embedding index ownership changed during admission");'
};

function freshParentPreparationProblems(ftsSource: string, embedSource: string): string[] {
  const problems: string[] = [];
  const familyPreflight = "fileExisted = await preflightSqliteArtifactFamily(this.file);";
  const ftsOpen = sectionBetween(
    ftsSource,
    "FTS mutating openOnce",
    FTS_ADMISSION_ORDER.mutatingOpenStart,
    FTS_ADMISSION_ORDER.mutatingOpenEnd
  ).text;
  const embedOpen = sectionBetween(
    embedSource,
    "Embed mutating openOnce",
    EMBED_ADMISSION_ORDER.mutatingOpenStart,
    EMBED_ADMISSION_ORDER.mutatingOpenEnd
  ).text;

  for (const entry of [
    {
      label: "FTS",
      source: ftsSource,
      className: FTS_ADMISSION_ORDER.className,
      open: ftsOpen,
      freshMkdir: FTS_ADMISSION_ORDER.freshMkdir
    },
    {
      label: "Embed",
      source: embedSource,
      className: EMBED_ADMISSION_ORDER.className,
      open: embedOpen,
      freshMkdir: EMBED_ADMISSION_ORDER.freshMkdir
    }
  ]) {
    const sourceFile = ts.createSourceFile(
      `${entry.className}.ts`,
      entry.source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );
    const openMethod = exactClassMethod(sourceFile, entry.className, "openOnce");
    const preflights = openMethod?.body ? statementsWithExactText(openMethod.body, sourceFile, familyPreflight) : [];
    const initialPreflight = preflights[0];
    const initialTry = initialPreflight ? directTryStatement(initialPreflight) : null;
    const loadStatements = openMethod?.body
      ? statementsWithExactText(openMethod.body, sourceFile, "const Ctor = await loadBetterSqlite();")
      : [];
    const freshBranches: ts.IfStatement[] = [];
    if (openMethod?.body) {
      const visit = (node: ts.Node): void => {
        if (ts.isIfStatement(node) && node.expression.getText(sourceFile) === "!fileExisted") {
          freshBranches.push(node);
        }
        ts.forEachChild(node, visit);
      };
      visit(openMethod.body);
    }
    const loadStatement = loadStatements[0];
    const freshBranch = freshBranches[0];
    const freshBlock = freshBranch?.getText(sourceFile) ?? "";
    if (preflights.length !== 2) {
      problems.push(`${entry.label} openOnce: expected exactly two SQLite family preflights`);
    }
    if (
      initialTry?.tryBlock.statements.length !== 1 ||
      initialTry.tryBlock.statements[0] !== initialPreflight ||
      loadStatements.length !== 1 ||
      freshBranches.length !== 1 ||
      !initialPreflight ||
      !loadStatement ||
      !freshBranch ||
      !(
        initialPreflight.getStart(sourceFile) < loadStatement.getStart(sourceFile) &&
        loadStatement.getStart(sourceFile) < freshBranch.getStart(sourceFile)
      )
    ) {
      problems.push(
        `${entry.label} openOnce: initial SQLite family preflight must precede dependency load and fresh branch`
      );
    }
    if (!freshBlock.includes(`await ${entry.freshMkdir};`)) {
      problems.push(`${entry.label} openOnce: mode-0700 mkdir is not contained by the fresh-file branch`);
    }
    if (
      freshBlock.includes("parentExisted") ||
      freshBlock.includes("fs.stat(parentDir") ||
      freshBlock.includes("fs.lstat(parentDir")
    ) {
      problems.push(`${entry.label} openOnce: parent ownership is inferred from a racy path stat`);
    }
    if (entry.open.includes("fs.chmod(parentDir")) {
      problems.push(`${entry.label} openOnce: path chmod can mutate an existing/custom parent`);
    }
    if (countLiteral(entry.open, entry.freshMkdir) !== 1) {
      problems.push(`${entry.label} openOnce: fresh parent must have one bounded recursive mode-0700 mkdir`);
    }
  }
  return problems;
}

/**
 * v3.7.0 M-3 — recursive TypeScript implementation-file walker for `src/`.
 *
 * Pre-v3.7.0 the invariant scanned only `["src", "src/tools"]` (hardcoded).
 * Any new sub-directory under `src/` would silently fall outside invariant
 * scope. Now: walks the entire `src/` tree, skipping nothing.
 *
 * Excludes declaration files (no runtime constructor calls)
 * and directories named `node_modules` or starting with `.` (paranoia for
 * unexpected nested package layouts).
 */
function isTypeScriptImplementationFile(name: string): boolean {
  if (/\.d\.(?:cts|mts|ts)$/.test(name)) return false;
  return /\.(?:cts|mts|ts|tsx)$/.test(name);
}

async function collectTsFiles(dir: string): Promise<string[]> {
  const here = path.resolve(process.cwd(), dir);
  const out: string[] = [];
  const stack: string[] = [here];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur) continue;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(cur, { withFileTypes: true });
    } catch {
      continue; // Missing dir — skip gracefully.
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name.startsWith(".")) continue;
        stack.push(path.join(cur, e.name));
        continue;
      }
      if (!e.isFile()) continue;
      if (!isTypeScriptImplementationFile(e.name)) continue;
      out.push(path.join(cur, e.name));
    }
  }
  return out;
}

/**
 * Returns the set of line indices (0-based) that are INSIDE a JSDoc/TSDoc
 * `/** ... *‍/` block. Matches inside doc-comment `@example` code blocks are
 * documentation, not real call sites, and must not trigger the invariant.
 *
 * The opener regex anchors `/**` to the start of the trimmed line (typical
 * JSDoc convention) so `/**` substrings inside string literals (e.g. glob
 * patterns like `Projects/**` in help text) don't get false-detected as
 * doc-block openings.
 */
function jsdocLineSet(text: string): Set<number> {
  const lines = text.split(/\r?\n/);
  const inDoc = new Set<number>();
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    // Open: `/**` at line start (after optional whitespace), and NOT
    // immediately closed on same line.
    if (/^\s*\/\*\*(?!.*\*\/)/.test(line)) depth++;
    if (depth > 0) inDoc.add(i);
    // Close: ` */` at line start or after `* ` (JSDoc continuation).
    // Anchored to defend against `*/` appearing inside string literals.
    if (depth > 0 && /^\s*\*?\/?\s*\*\//.test(line)) depth = Math.max(0, depth - 1);
  }
  return inDoc;
}

async function findConstructorSites(file: string): Promise<ConstructorSite[]> {
  const text = await fs.readFile(file, "utf8");
  const lines = text.split(/\r?\n/);
  const docLines = jsdocLineSet(text);
  const hits: ConstructorSite[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (docLines.has(i)) continue; // skip JSDoc @example bodies
    const line = lines[i] ?? "";
    for (const pattern of CONSTRUCTOR_PATTERNS) {
      pattern.lastIndex = 0;
      if (pattern.test(line)) {
        hits.push({ file, line: i + 1, text: line });
      }
    }
  }
  return hits;
}

function hasGuard(text: string, site: ConstructorSite): "discovery" | "safe" | null {
  const lines = text.split(/\r?\n/);
  const start = Math.max(0, site.line - 1 - CONTEXT_LINES);
  const end = Math.min(lines.length, site.line - 1 + 2); // include the construct line itself + 1 next
  const windowLines = lines.slice(start, end);
  const window = windowLines.join("\n");
  if (DISCOVERY_MARKERS.some((m) => window.includes(m))) return "discovery";
  if (windowLines.some((line) => /^\s*\/\/.*SAFE BY DESIGN/u.test(line))) return "safe";
  return null;
}

describe("K-1 class invariant (v3.6.3 methodological guard; recursive scan since v3.7.0 M-3)", () => {
  // Squash-main coverage run 32542057599 measured this unchanged exhaustive
  // scan at 17.376s after the PR run completed it in 13.979s. Keep the global
  // 15s breaker for ordinary tests and give only this measured scan 30s.
  // biome-ignore format: Keep the exhaustive callback inline without reformatting its mutation corpus.
  it("every `new EmbedDb` / `new FtsIndex` in src/ is preceded by discovery or // SAFE BY DESIGN", async () => {
    const files = await collectTsFiles(SRC_ROOT);
    const unguarded: string[] = [];
    for (const file of files) {
      const sites = await findConstructorSites(file);
      if (sites.length === 0) continue;
      const text = await fs.readFile(file, "utf8");
      for (const site of sites) {
        const guard = hasGuard(text, site);
        if (!guard) {
          unguarded.push(
            `${path.relative(process.cwd(), site.file)}:${site.line}\n    ${site.text.trim()}\n    (no configuration discovery or SAFE BY DESIGN comment within ${CONTEXT_LINES} lines above)`
          );
        }
      }
    }
    if (unguarded.length > 0) {
      const detail = unguarded.join("\n\n");
      expect.fail(
        `K-1 class invariant violated. The following EmbedDb/FtsIndex constructions have no discovery guard:\n\n${detail}\n\nFix: add a root-scoped \`discover*Config(file, vaultRoot)\` call before the constructor, OR add a \`// SAFE BY DESIGN: <reason>\` comment if the constructor demonstrably does not trigger bootstrapSchema (e.g. .clearOnDisk-only path).`
      );
    }

    const cliSource = await fs.readFile(path.resolve(process.cwd(), "src", "cli.ts"), "utf8");
    const serverSource = await fs.readFile(path.resolve(process.cwd(), "src", "server.ts"), "utf8");
    const searchSource = await fs.readFile(path.resolve(process.cwd(), "src", "tools", "search.ts"), "utf8");
    const embeddingsSource = await fs.readFile(path.resolve(process.cwd(), "src", "embeddings.ts"), "utf8");
    const productionSources = await Promise.all(
      files.map(async (file) => ({
        file: path.relative(process.cwd(), file).split(path.sep).join("/"),
        source: await fs.readFile(file, "utf8")
      }))
    );
    const configurationCalls = productionSources.flatMap(({ file, source }) =>
      productionConfigurationCalls(file, source)
    );
    expect(tokenizerCallerProblems(cliSource, serverSource)).toEqual([]);
    expect(configurationDiscoveryRootProblems(cliSource, serverSource, searchSource)).toEqual([]);
    expect(configurationDiscoveryFailClosedProblems(cliSource, serverSource, searchSource)).toEqual([]);
    expect(configurationDiscoveryOpenBindingProblems(cliSource, serverSource, searchSource)).toEqual([]);
    expect(safeByDesignOpenProblems(cliSource)).toEqual([]);
    expect(productionConfigurationInventoryProblems(configurationCalls)).toEqual([]);
    expect(failClosedSpecInventoryProblems(cliSource, serverSource, searchSource, configurationCalls)).toEqual([]);
    expect(storedEmbeddingConfigurationHelperProblems(embeddingsSource)).toEqual([]);
    expect(countLiteral(cliSource, "resolveStoredEmbeddingConfiguration(")).toBe(2);
    expect(countLiteral(serverSource, "resolveStoredEmbeddingConfiguration(")).toBe(3);
    expect(countLiteral(searchSource, "resolveStoredEmbeddingConfiguration(")).toBe(1);

    const cliRootFiltersRemoved = replaceExactly(
      replaceExactly(
        replaceExactly(
          replaceAllExactly(
            cliSource,
            "discoverFtsIndexConfig(indexFile, v.root)",
            "discoverFtsIndexConfig(indexFile)",
            3
          ),
          "discoverFtsIndexConfig(indexFile, vault.root)",
          "discoverFtsIndexConfig(indexFile)"
        ),
        "discoverEmbedDbConfig(embedFile, v.root)",
        "discoverEmbedDbConfig(embedFile)"
      ),
      "discoverEmbedDbConfig(embedFile, vault.root)",
      "discoverEmbedDbConfig(embedFile)"
    );
    expect(configurationDiscoveryRootProblems(cliRootFiltersRemoved, serverSource, searchSource)).toEqual(
      expect.arrayContaining([
        "CLI FTS canonical-root discoveries: expected 3, found 0",
        "CLI Embed vault-root discovery: expected 1, found 0"
      ])
    );

    const serverRootFiltersRemoved = replaceExactly(
      replaceAllExactly(
        replaceExactly(
          serverSource,
          "discoverFtsIndexConfig(indexFile, vault.root)",
          "discoverFtsIndexConfig(indexFile)"
        ),
        "discoverEmbedDbConfig(embedFile, vault.root)",
        "discoverEmbedDbConfig(embedFile)",
        2
      ),
      "discoverEmbedDbConfig(startupEmbedFile, vault.root)",
      "discoverEmbedDbConfig(startupEmbedFile)"
    );
    expect(configurationDiscoveryRootProblems(cliSource, serverRootFiltersRemoved, searchSource)).toEqual(
      expect.arrayContaining([
        "server FTS canonical-root discovery: expected 1, found 0",
        "server Embed canonical-root discoveries: expected 2, found 0",
        "server non-HNSW integrity Embed canonical-root discovery: expected 1, found 0"
      ])
    );

    const searchRootFilterRemoved = replaceExactly(
      searchSource,
      "discoverEmbedDbConfigCached(embedFile, vault.root)",
      "discoverEmbedDbConfigCached(embedFile)"
    );
    expect(configurationDiscoveryRootProblems(cliSource, serverSource, searchRootFilterRemoved)).toContain(
      "search cached Embed canonical-root discovery: expected 1, found 0"
    );

    const searchCacheRemoved = replaceExactly(
      searchSource,
      "discoverEmbedDbConfigCached(embedFile, vault.root)",
      "discoverEmbedDbConfig(embedFile, vault.root)"
    );
    expect(configurationDiscoveryRootProblems(cliSource, serverSource, searchCacheRemoved)).toEqual(
      expect.arrayContaining([
        "search cached Embed canonical-root discovery: expected 1, found 0",
        "uncached Embed discovery inventory: expected 5, found 6"
      ])
    );

    const rawPeekCli = replaceExactly(
      cliSource,
      "const discoveredFts = await discoverFtsIndexConfig(indexFile, v.root);",
      "const discoveredFts = await peekFtsMetaSafe(indexFile, v.root);"
    );
    const rawPeekCalls = productionSources.flatMap(({ file, source }) =>
      productionConfigurationCalls(file, file === "src/cli.ts" ? rawPeekCli : source)
    );
    const rawPeekProblems = productionConfigurationInventoryProblems(rawPeekCalls);
    expect(
      rawPeekProblems.some((problem) => problem.startsWith("raw production configuration peek is forbidden:"))
    ).toBe(true);
    expect(rawPeekProblems).toEqual(
      expect.arrayContaining([
        "src/cli.ts discoverFtsIndexConfig: expected 4, found 3",
        "global production discovery inventory: expected 11, found 10"
      ])
    );
    expect(failClosedSpecInventoryProblems(rawPeekCli, serverSource, searchSource, rawPeekCalls)).toContain(
      "fail-closed caller spec inventory: 11 specs for 10 production discoveries"
    );

    const uncataloguedCaller = productionConfigurationCalls(
      "src/new-index-caller.ts",
      `async function openNewIndex(file, vaultRoot) {
  const discovery = await discoverFtsIndexConfig(file, vaultRoot);
  return new FtsIndex({ file, vaultRoot, tokenize: discovery.meta.tokenize_mode });
}`
    );
    expect(productionConfigurationInventoryProblems([...configurationCalls, ...uncataloguedCaller])).toEqual(
      expect.arrayContaining([
        "uncatalogued production discovery caller: src/new-index-caller.ts:2 discoverFtsIndexConfig",
        "global production discovery inventory: expected 11, found 12"
      ])
    );
    expect(
      failClosedSpecInventoryProblems(cliSource, serverSource, searchSource, [
        ...configurationCalls,
        ...uncataloguedCaller
      ])
    ).toEqual(
      expect.arrayContaining([
        "src/new-index-caller.ts discoverFtsIndexConfig: expected 1 fail-closed specs, found 0",
        "fail-closed caller spec inventory: 11 specs for 12 production discoveries"
      ])
    );

    const searchOpenArgumentDropped = replaceExactly(
      searchSource,
      "  await db.open(discovered);",
      "  await db.open();"
    );
    expect(configurationDiscoveryOpenBindingProblems(cliSource, serverSource, searchOpenArgumentDropped)).toContain(
      "search Embed: awaited open is not bound to the exact discovery const"
    );

    const watcherWrongDiscovery = replaceExactly(
      serverSource,
      "        await watcherEmbedDb.open(discovered);",
      "        await watcherEmbedDb.open(discoveredEmbed);"
    );
    expect(configurationDiscoveryOpenBindingProblems(cliSource, watcherWrongDiscovery, searchSource)).toContain(
      "server watcher Embed: awaited open is not bound to the exact discovery const"
    );

    const hnswConstructorAliasDropped = replaceExactly(
      serverSource,
      "          const db = hnswSnapshotDb;",
      "          const db = hnswSnapshotDb!;"
    );
    expect(configurationDiscoveryOpenBindingProblems(cliSource, hnswConstructorAliasDropped, searchSource)).toContain(
      "server HNSW Embed: constructor authority is not passed through one immutable db alias"
    );

    const integrityWrongDiscovery = replaceExactly(
      serverSource,
      "      await integrityDb.open(discovered);",
      "      await integrityDb.open(discoveredEmbed);"
    );
    expect(configurationDiscoveryOpenBindingProblems(cliSource, integrityWrongDiscovery, searchSource)).toContain(
      "server non-HNSW integrity Embed: awaited open is not bound to the exact discovery const"
    );

    const searchDeadOpenDecoy = replaceExactly(
      searchSource,
      "  await db.open(discovered);",
      "  if (false) {\n    await db.open(discovered);\n  }"
    );
    expect(configurationDiscoveryOpenBindingProblems(cliSource, serverSource, searchDeadOpenDecoy)).toContain(
      "search Embed: constructor/open pair is not on one reachable control path"
    );

    const searchConditionalOpen = replaceExactly(
      searchSource,
      "  await db.open(discovered);",
      "  if (args.model) {\n    await db.open(discovered);\n  }"
    );
    expect(configurationDiscoveryOpenBindingProblems(cliSource, serverSource, searchConditionalOpen)).toContain(
      "search Embed: constructor/open pair is not on one reachable control path"
    );

    const searchSwallowedOpen = replaceExactly(
      searchSource,
      "  await db.open(discovered);",
      "  try {\n    await db.open(discovered);\n  } catch {}"
    );
    expect(configurationDiscoveryOpenBindingProblems(cliSource, serverSource, searchSwallowedOpen)).toContain(
      "search Embed: constructor/open pair is not on one reachable control path"
    );

    const queryOpenFailureSwallowed = replaceExactly(
      cliSource,
      "        } finally {\n          await ftsIndex.closeAndRelease();",
      "        } catch {} finally {\n          await ftsIndex.closeAndRelease();"
    );
    expect(configurationDiscoveryOpenBindingProblems(queryOpenFailureSwallowed, serverSource, searchSource)).toContain(
      "CLI query FTS: reviewed open failure policy changed"
    );

    const evalOpenRethrowRemoved = replaceExactly(
      cliSource,
      "          } catch (err) {\n            await ftsIndex.closeAndRelease();\n            throw err;\n          }",
      "          } catch {}"
    );
    expect(configurationDiscoveryOpenBindingProblems(evalOpenRethrowRemoved, serverSource, searchSource)).toContain(
      "CLI eval FTS: reviewed open failure policy changed"
    );

    const serverOpenFailSoftNullRemoved = replaceExactly(serverSource, "        ftsIndex = null;\n", "");
    expect(configurationDiscoveryOpenBindingProblems(cliSource, serverOpenFailSoftNullRemoved, searchSource)).toContain(
      "server persistent FTS omitted tokenizer: reviewed open failure policy changed"
    );

    const serverOpenCleanupDowngraded = replaceExactly(
      serverSource,
      "          await ftsIndex?.closeAndRelease(); // open() may have retained a retryable lifetime",
      "          ftsIndex?.close();"
    );
    expect(configurationDiscoveryOpenBindingProblems(cliSource, serverOpenCleanupDowngraded, searchSource)).toContain(
      "server persistent FTS omitted tokenizer: reviewed open failure policy changed"
    );

    const serverOpenCleanupFailureSwallowed = replaceExactly(
      serverSource,
      "          } catch (cleanupError) {\n" +
        "            throw new AggregateError(\n" +
        "              [err, cleanupError],\n" +
        '              "FTS startup failed and its persistence lifetime could not be released"\n' +
        "            );\n" +
        "          }",
      "          } catch {}"
    );
    expect(
      configurationDiscoveryOpenBindingProblems(cliSource, serverOpenCleanupFailureSwallowed, searchSource)
    ).toContain("server persistent FTS omitted tokenizer: reviewed open failure policy changed");

    const searchDiscoveryReassigned = replaceExactly(
      replaceExactly(
        searchSource,
        "  const discovered = await discoverEmbedDbConfigCached(embedFile, vault.root);",
        "  let discovered = await discoverEmbedDbConfigCached(embedFile, vault.root);"
      ),
      "  await db.open(discovered);",
      '  discovered = { kind: "missing" };\n  await db.open(discovered);'
    );
    expect(configurationDiscoveryOpenBindingProblems(cliSource, serverSource, searchDiscoveryReassigned)).toContain(
      "search Embed: discovery binding is reassigned before open"
    );

    const searchDiscoveryMutatedByClosure = replaceExactly(
      replaceExactly(
        searchSource,
        "  const discovered = await discoverEmbedDbConfigCached(embedFile, vault.root);",
        "  let discovered = await discoverEmbedDbConfigCached(embedFile, vault.root);"
      ),
      "  await db.open(discovered);",
      "  const mutateDiscovery = () => {\n" +
        '    discovered = { kind: "missing" };\n' +
        "  };\n" +
        "  mutateDiscovery();\n" +
        "  await db.open(discovered);"
    );
    expect(
      configurationDiscoveryOpenBindingProblems(cliSource, serverSource, searchDiscoveryMutatedByClosure)
    ).toContain("search Embed: discovery binding is reassigned before open");

    const searchInstanceUsedBeforeOpen = replaceExactly(
      searchSource,
      "  await db.open(discovered);",
      "  db.totalChunks();\n  await db.open(discovered);"
    );
    expect(configurationDiscoveryOpenBindingProblems(cliSource, serverSource, searchInstanceUsedBeforeOpen)).toContain(
      "search Embed: constructed instance is used or reassigned before open"
    );

    const searchInvokedClosurePreopens = replaceExactly(
      searchSource,
      "  await db.open(discovered);",
      "  const preopen = async () => {\n" +
        "    await db.open();\n" +
        "  };\n" +
        "  await preopen();\n" +
        "  await db.open(discovered);"
    );
    expect(configurationDiscoveryOpenBindingProblems(cliSource, serverSource, searchInvokedClosurePreopens)).toContain(
      "search Embed: constructed instance is used or reassigned before open"
    );

    const searchInvokedClosureAliasCastPreopens = replaceExactly(
      searchSource,
      "  await db.open(discovered);",
      "  const preopen = async () => {\n" +
        "    const alias = db;\n" +
        '    await (alias as EmbedDb)["open"]();\n' +
        "  };\n" +
        "  await preopen();\n" +
        "  await db.open(discovered);"
    );
    expect(
      configurationDiscoveryOpenBindingProblems(cliSource, serverSource, searchInvokedClosureAliasCastPreopens)
    ).toContain("search Embed: constructed instance is used or reassigned before open");

    const searchEarlyClosurePreopens = replaceExactly(
      replaceExactly(
        searchSource,
        "  const db = new EmbedDb({",
        "  const preopen = async () => {\n    await db.open();\n  };\n  const db = new EmbedDb({"
      ),
      "  await db.open(discovered);",
      "  await preopen();\n  await db.open(discovered);"
    );
    expect(configurationDiscoveryOpenBindingProblems(cliSource, serverSource, searchEarlyClosurePreopens)).toContain(
      "search Embed: constructed instance is used or reassigned before open"
    );

    const searchPrediscoveryClosurePreopens = replaceExactly(
      replaceExactly(
        searchSource,
        "  const discovered = await discoverEmbedDbConfigCached(embedFile, vault.root);",
        "  const preopen = async () => {\n" +
          "    await db.open();\n" +
          "  };\n" +
          "  const discovered = await discoverEmbedDbConfigCached(embedFile, vault.root);"
      ),
      "  await db.open(discovered);",
      "  await preopen();\n  await db.open(discovered);"
    );
    expect(
      configurationDiscoveryOpenBindingProblems(cliSource, serverSource, searchPrediscoveryClosurePreopens)
    ).toContain("search Embed: constructed instance is used or reassigned before open");

    const searchHoistedPostopenClosurePreopens = replaceExactly(
      searchSource,
      "  await db.open(discovered);",
      "  await preopen();\n" +
        "  await db.open(discovered);\n" +
        "  async function preopen() {\n" +
        "    await db.open();\n" +
        "  }"
    );
    expect(
      configurationDiscoveryOpenBindingProblems(cliSource, serverSource, searchHoistedPostopenClosurePreopens)
    ).toContain("search Embed: constructed instance is used or reassigned before open");

    const safeCommentWithOpen = replaceExactly(
      cliSource,
      "      const removed = await idx.clearOnDisk();",
      "      await idx.open();\n      const removed = await idx.clearOnDisk();"
    );
    expect(safeByDesignOpenProblems(safeCommentWithOpen)).toContain(
      "CLI clear-index: safe instance use escaped sole clearOnDisk call"
    );
    const safeAliasWithOpen = replaceExactly(
      cliSource,
      "      const removed = await idx.clearOnDisk();",
      "      const alias = idx;\n      await alias.open();\n      const removed = await idx.clearOnDisk();"
    );
    expect(safeByDesignOpenProblems(safeAliasWithOpen)).toContain(
      "CLI clear-index: safe instance use escaped sole clearOnDisk call"
    );
    const safeCastWithOpen = replaceExactly(
      cliSource,
      "      const removed = await idx.clearOnDisk();",
      "      await (idx as FtsIndex).open();\n      const removed = await idx.clearOnDisk();"
    );
    expect(safeByDesignOpenProblems(safeCastWithOpen)).toContain(
      "CLI clear-index: safe instance use escaped sole clearOnDisk call"
    );
    const safeComputedOpen = replaceExactly(
      cliSource,
      "      const removed = await idx.clearOnDisk();",
      '      await idx["open"]();\n      const removed = await idx.clearOnDisk();'
    );
    expect(safeByDesignOpenProblems(safeComputedOpen)).toContain(
      "CLI clear-index: safe instance use escaped sole clearOnDisk call"
    );
    expect(realSafeMarkerCount("// SAFE BY DESIGN: real comment\nconst value = 1;\n")).toBe(1);
    expect(realSafeMarkerCount("const decoy = `// SAFE BY DESIGN: string only`;\n")).toBe(0);

    const cliSetupFtsRefusalRemoved = replaceExactly(
      cliSource,
      '        if (discoveredFts.kind === "refused") {\n' +
        '          throw new Error("FTS index configuration could not be verified");\n' +
        "        }\n",
      ""
    );
    expect(configurationDiscoveryFailClosedProblems(cliSetupFtsRefusalRemoved, serverSource, searchSource)).toContain(
      "CLI setup FTS: refused discovery refusal/degrade is missing"
    );

    const writerFallbackReenabled = replaceExactly(
      cliSource,
      '        if (discovered.kind === "refused") {\n' +
        '          throw new Error("Embedding index configuration could not be verified");\n' +
        "        }\n",
      ""
    );
    expect(configurationDiscoveryFailClosedProblems(writerFallbackReenabled, serverSource, searchSource)).toContain(
      "CLI build Embed omitted configuration: refused discovery refusal/degrade is missing"
    );

    const setupResolverAfterProgress = replaceExactly(
      replaceExactly(
        cliSource,
        "            ? resolveStoredEmbeddingConfiguration(discoveredEmbed.meta)\n            : null;",
        "            ? null\n            : null;"
      ),
      `        process.stdout.write(\`enquire setup — \${opts.vault}\\n\\n\`);`,
      `        process.stdout.write(\`enquire setup — \${opts.vault}\\n\\n\`);\n` +
        "        resolveStoredEmbeddingConfiguration(discoveredEmbed.meta);"
    );
    expect(configurationDiscoveryFailClosedProblems(setupResolverAfterProgress, serverSource, searchSource)).toContain(
      "CLI setup Embed omitted configuration: constructor runs before supported stored-config resolution"
    );

    const serverEmbedFallbackReenabled = replaceAllExactly(
      serverSource,
      'if (discovered.kind === "missing" || discovered.kind === "refused")',
      "if (false)",
      3
    );
    expect(configurationDiscoveryFailClosedProblems(cliSource, serverEmbedFallbackReenabled, searchSource)).toEqual(
      expect.arrayContaining([
        "server watcher Embed: refused discovery refusal/degrade is missing",
        "server non-HNSW integrity Embed: refused discovery refusal/degrade is missing",
        "server HNSW Embed: refused discovery refusal/degrade is missing"
      ])
    );

    const searchFallbackReenabled = replaceExactly(
      searchSource,
      '  if (discovered.kind === "refused") {\n' +
        '    throw new Error("Embedding index configuration could not be verified");\n' +
        "  }\n",
      ""
    );
    expect(configurationDiscoveryFailClosedProblems(cliSource, serverSource, searchFallbackReenabled)).toContain(
      "search Embed: refused discovery refusal/degrade is missing"
    );

    const searchRefusalEffectRemoved = replaceExactly(
      searchSource,
      '  if (discovered.kind === "refused") {\n' +
        '    throw new Error("Embedding index configuration could not be verified");\n' +
        "  }\n",
      '  if (discovered.kind === "refused") {\n    void 0;\n  }\n'
    );
    expect(configurationDiscoveryFailClosedProblems(cliSource, serverSource, searchRefusalEffectRemoved)).toContain(
      "search Embed: refused-state terminal/degrade effect is not bound to refused branch"
    );

    const searchRefusalEffectDecoupled = replaceExactly(
      searchSource,
      '  if (discovered.kind === "refused") {\n' +
        '    throw new Error("Embedding index configuration could not be verified");\n' +
        "  }\n",
      '  if (discovered.kind === "refused") {\n' +
        "    void 0;\n" +
        "  }\n" +
        "  if (false) {\n" +
        '    throw new Error("Embedding index configuration could not be verified");\n' +
        "  }\n"
    );
    expect(configurationDiscoveryFailClosedProblems(cliSource, serverSource, searchRefusalEffectDecoupled)).toContain(
      "search Embed: refused-state terminal/degrade effect is not bound to refused branch"
    );

    const searchRefusalStringDecoy = replaceExactly(
      searchSource,
      '  if (discovered.kind === "refused") {\n' +
        '    throw new Error("Embedding index configuration could not be verified");\n' +
        "  }\n",
      '  if (discovered.kind === "refused") {\n' +
        "    const decoy = 'throw new Error(\"Embedding index configuration could not be verified\");';\n" +
        "    void decoy;\n" +
        "  }\n"
    );
    expect(configurationDiscoveryFailClosedProblems(cliSource, serverSource, searchRefusalStringDecoy)).toContain(
      "search Embed: refused-state terminal/degrade effect is not bound to refused branch"
    );

    const searchRefusalDeadNested = replaceExactly(
      searchSource,
      '  if (discovered.kind === "refused") {\n' +
        '    throw new Error("Embedding index configuration could not be verified");\n' +
        "  }\n",
      '  if (discovered.kind === "refused") {\n' +
        "    if (false) {\n" +
        '      throw new Error("Embedding index configuration could not be verified");\n' +
        "    }\n" +
        "  }\n"
    );
    expect(configurationDiscoveryFailClosedProblems(cliSource, serverSource, searchRefusalDeadNested)).toContain(
      "search Embed: refused-state terminal/degrade effect is not bound to refused branch"
    );

    const searchRefusalOuterDead = replaceExactly(
      searchSource,
      '  if (discovered.kind === "refused") {\n' +
        '    throw new Error("Embedding index configuration could not be verified");\n' +
        "  }\n",
      "  if (false) {\n" +
        '    if (discovered.kind === "refused") {\n' +
        '      throw new Error("Embedding index configuration could not be verified");\n' +
        "    }\n" +
        "  }\n"
    );
    expect(configurationDiscoveryFailClosedProblems(cliSource, serverSource, searchRefusalOuterDead)).toContain(
      "search Embed: refused-state terminal/degrade effect is not bound to refused branch"
    );

    const searchRefusalSwallowed = replaceExactly(
      searchSource,
      '  if (discovered.kind === "refused") {\n' +
        '    throw new Error("Embedding index configuration could not be verified");\n' +
        "  }\n",
      "  try {\n" +
        '    if (discovered.kind === "refused") {\n' +
        '      throw new Error("Embedding index configuration could not be verified");\n' +
        "    }\n" +
        "  } catch {}\n"
    );
    expect(configurationDiscoveryFailClosedProblems(cliSource, serverSource, searchRefusalSwallowed)).toContain(
      "search Embed: refused-state terminal/degrade effect is not bound to refused branch"
    );

    const searchRefusalNestedBlockSwallowed = replaceExactly(
      replaceExactly(
        searchSource,
        "  const discovered = await discoverEmbedDbConfigCached(embedFile, vault.root);\n",
        "  try {\n    {\n      const discovered = await discoverEmbedDbConfigCached(embedFile, vault.root);\n"
      ),
      '  if (discovered.kind === "refused") {\n' +
        '    throw new Error("Embedding index configuration could not be verified");\n' +
        "  }\n",
      '  if (discovered.kind === "refused") {\n' +
        '    throw new Error("Embedding index configuration could not be verified");\n' +
        "  }\n" +
        "    }\n" +
        "  } catch {}\n"
    );
    expect(
      configurationDiscoveryFailClosedProblems(cliSource, serverSource, searchRefusalNestedBlockSwallowed)
    ).toContain("search Embed: refused-state terminal/degrade effect is not bound to refused branch");

    const searchStoredConfigResolverRemoved = replaceExactly(
      searchSource,
      "resolveStoredEmbeddingConfiguration(discovered.meta)",
      "{ model: resolveModel(discovered.meta.model_alias), quantization: discovered.meta.quantization }"
    );
    expect(
      configurationDiscoveryFailClosedProblems(cliSource, serverSource, searchStoredConfigResolverRemoved)
    ).toContain("search Embed: supported stored-config resolver is missing");

    const callerDimCheckRemoved = replaceExactly(
      embeddingsSource,
      '    if (String(model.dim) !== meta.dim) throw new Error("inconsistent");\n',
      ""
    );
    expect(storedEmbeddingConfigurationHelperProblems(callerDimCheckRemoved)).toContain(
      "shared stored Embed resolver: catalog dimension comparison is missing"
    );

    const legacyV2NormalizationRemoved = replaceExactly(
      embeddingsSource,
      'meta.schema_version === "1" || meta.schema_version === "2"',
      'meta.schema_version === "1"'
    );
    expect(storedEmbeddingConfigurationHelperProblems(legacyV2NormalizationRemoved)).toContain(
      "shared stored Embed resolver: legacy v2 f32 normalization is missing"
    );
    const legacyV1NormalizationRemoved = replaceExactly(
      embeddingsSource,
      'meta.schema_version === "1" || meta.schema_version === "2"',
      'meta.schema_version === "2"'
    );
    expect(storedEmbeddingConfigurationHelperProblems(legacyV1NormalizationRemoved)).toContain(
      "shared stored Embed resolver: legacy v1 f32 normalization is missing"
    );

    const cliFtsRefusalsRemoved = replaceAllExactly(cliSource, 'if (discovered.kind === "refused")', "if (false)", 4);
    expect(configurationDiscoveryFailClosedProblems(cliFtsRefusalsRemoved, serverSource, searchSource)).toEqual(
      expect.arrayContaining([
        "CLI query FTS: refused discovery refusal/degrade is missing",
        "CLI index FTS omitted tokenizer: refused discovery refusal/degrade is missing",
        "CLI eval FTS: refused discovery refusal/degrade is missing"
      ])
    );

    const serverFtsRefusalRemoved = replaceExactly(
      serverSource,
      'const refusedFts = discovered.kind === "refused";',
      "const refusedFts = false;"
    );
    expect(configurationDiscoveryFailClosedProblems(cliSource, serverFtsRefusalRemoved, searchSource)).toContain(
      "server persistent FTS omitted tokenizer: refused discovery refusal/degrade is missing"
    );

    const serverFtsAcquisitionMovedAfterDegrade = replaceExactly(
      serverSource,
      "      } else {\n        ftsIndex = new FtsIndex({ file: indexFile, vaultRoot: vault.root, tokenize });",
      "      }\n      {\n        ftsIndex = new FtsIndex({ file: indexFile, vaultRoot: vault.root, tokenize });"
    );
    expect(
      configurationDiscoveryFailClosedProblems(cliSource, serverFtsAcquisitionMovedAfterDegrade, searchSource)
    ).toContain("server persistent FTS omitted tokenizer: degrade branch no longer excludes constructor acquisition");

    const rawCliFailOpen = replaceExactly(
      cliSource,
      'assertTokenizeMode(rawTokenize, "--tokenize")',
      "rawTokenize as TokenizeMode",
      2
    );
    expect(tokenizerCallerProblems(rawCliFailOpen, serverSource)).toContain(
      "serve: exact tokenizer validation is missing"
    );

    const rawHttpProjectionDropped = replaceExactly(cliSource, "        rateLimit: rawRateLimit,\n", "");
    expect(tokenizerCallerProblems(rawHttpProjectionDropped, serverSource)).toContain(
      "serve-http: raw HTTP option rateLimit is not projected before forwarding"
    );

    const serverValidation =
      "  const requestedTokenize =\n" +
      '    opts.tokenize === undefined ? undefined : assertTokenizeMode(opts.tokenize, "tokenize option");\n';
    const validationAfterAcquire = replaceExactly(
      replaceExactly(serverSource, serverValidation, ""),
      "  await vault.ensureExists();\n",
      `  await vault.ensureExists();\n${serverValidation}`
    );
    expect(tokenizerCallerProblems(cliSource, validationAfterAcquire)).toContain(
      "prepareServerDeps: tokenizer validation runs after acquisition"
    );

    const customPathDropped = replaceExactly(
      cliSource,
      "        const indexFile = opts.indexFile ?? defaultIndexFile(vault.root);",
      "        const indexFile = defaultIndexFile(vault.root);"
    );
    expect(tokenizerCallerProblems(customPathDropped, serverSource)).toContain(
      "cli custom/default vault-root FTS paths: expected 2, found 1"
    );

    const queryCustomPathDropped = replaceExactly(
      cliSource,
      "const indexFile = opts.indexFile ?? defaultIndexFile(v.root);",
      "const indexFile = defaultIndexFile(v.root);",
      2
    );
    expect(tokenizerCallerProblems(queryCustomPathDropped, serverSource)).toEqual(
      expect.arrayContaining([
        "cli custom/default canonical-root FTS path: expected 2, found 1",
        "cli default-only canonical-root FTS paths: expected 1, found 2"
      ])
    );

    const ftsSource = await fs.readFile(path.resolve(process.cwd(), "src", "fts5.ts"), "utf8");
    const embedSource = await fs.readFile(path.resolve(process.cwd(), "src", "embed-db.ts"), "utf8");
    expect(publicOpenWrapperProblems(ftsSource, FTS_ADMISSION_ORDER)).toEqual([]);
    expect(publicOpenWrapperProblems(embedSource, EMBED_ADMISSION_ORDER)).toEqual([]);
    expect(admissionOrderProblems(ftsSource, FTS_ADMISSION_ORDER)).toEqual([]);
    expect(admissionOrderProblems(embedSource, EMBED_ADMISSION_ORDER)).toEqual([]);
    expect(freshParentPreparationProblems(ftsSource, embedSource)).toEqual([]);
    expect(boundedAdmissionProjectionProblems(ftsSource, FTS_BOUNDED_ADMISSION)).toEqual([]);
    expect(boundedAdmissionProjectionProblems(embedSource, EMBED_BOUNDED_ADMISSION)).toEqual([]);

    const ftsOpenSignatureDropped = replaceExactly(
      ftsSource,
      "  async open(expectedDiscovery?: FtsIndexDiscovery): Promise<void> {",
      "  async open(): Promise<void> {"
    );
    expect(publicOpenWrapperProblems(ftsOpenSignatureDropped, FTS_ADMISSION_ORDER)).toContain(
      "FTS public open: exact optional-discovery API signature changed"
    );
    const embedOpenSignatureWrongType = replaceExactly(
      embedSource,
      "  async open(expectedDiscovery?: EmbedDbConfigDiscovery): Promise<void> {",
      "  async open(expectedDiscovery?: FtsIndexDiscovery): Promise<void> {"
    );
    expect(publicOpenWrapperProblems(embedOpenSignatureWrongType, EMBED_ADMISSION_ORDER)).toContain(
      "Embed public open: exact optional-discovery API signature changed"
    );

    const ftsOpenCallBeforeGuard = mutateOpenOnceExactly(
      ftsSource,
      FTS_ADMISSION_ORDER,
      "this.db = new Ctor(this.file) as Db;\n",
      "this.db = new Ctor(this.file) as Db;\n" + 'this.db.exec("CREATE TABLE admission_bypass(x)");\n'
    );
    expect(admissionOrderProblems(ftsOpenCallBeforeGuard, FTS_ADMISSION_ORDER)).toContain(
      "FTS openOnce: call runs between live handle and first guard"
    );
    const embedOpenCallBeforeGuard = mutateOpenOnceExactly(
      embedSource,
      EMBED_ADMISSION_ORDER,
      "this.db = new Ctor(this.file) as Db;\n",
      "this.db = new Ctor(this.file) as Db;\n" + 'this.db.prepare("DELETE FROM embeddings").run();\n'
    );
    expect(admissionOrderProblems(embedOpenCallBeforeGuard, EMBED_ADMISSION_ORDER)).toContain(
      "Embed openOnce: call runs between live handle and first guard"
    );

    const embedOpenCallBetweenGuardAndAssert = mutateOpenOnceExactly(
      embedSource,
      EMBED_ADMISSION_ORDER,
      EMBED_ADMISSION_ORDER.firstGuard,
      `${EMBED_ADMISSION_ORDER.firstGuard}\nthis.db.prepare("DELETE FROM embeddings").run();`
    );
    expect(admissionOrderProblems(embedOpenCallBetweenGuardAndAssert, EMBED_ADMISSION_ORDER)).toContain(
      "Embed openOnce: exact guarded admission sequence changed"
    );

    const ftsOpenCallBetweenGuardAndBootstrap = mutateOpenOnceExactly(
      ftsSource,
      FTS_ADMISSION_ORDER,
      FTS_ADMISSION_ORDER.firstGuard,
      `${FTS_ADMISSION_ORDER.firstGuard}\nthis.db.exec("CREATE TABLE admission_bypass(x)");`
    );
    expect(admissionOrderProblems(ftsOpenCallBetweenGuardAndBootstrap, FTS_ADMISSION_ORDER)).toContain(
      "FTS openOnce: exact guarded admission sequence changed"
    );

    const embedOpenCallBetweenAssertAndBootstrap = mutateOpenOnceExactly(
      embedSource,
      EMBED_ADMISSION_ORDER,
      EMBED_ADMISSION_ORDER.expectedAssert,
      `${EMBED_ADMISSION_ORDER.expectedAssert}\nthis.db.prepare("DELETE FROM embeddings").run();`
    );
    expect(admissionOrderProblems(embedOpenCallBetweenAssertAndBootstrap, EMBED_ADMISSION_ORDER)).toContain(
      "Embed openOnce: exact guarded admission sequence changed"
    );

    const ftsExpectedDiscoveryAssertionRemoved = mutateOpenOnceExactly(
      ftsSource,
      FTS_ADMISSION_ORDER,
      FTS_ADMISSION_ORDER.expectedAssert,
      ""
    );
    expect(admissionOrderProblems(ftsExpectedDiscoveryAssertionRemoved, FTS_ADMISSION_ORDER)).toContain(
      "FTS openOnce: exact AST expected-discovery assertion is not unique"
    );
    const embedExpectedDiscoveryAssertionRemoved = mutateOpenOnceExactly(
      embedSource,
      EMBED_ADMISSION_ORDER,
      EMBED_ADMISSION_ORDER.expectedAssert,
      ""
    );
    expect(admissionOrderProblems(embedExpectedDiscoveryAssertionRemoved, EMBED_ADMISSION_ORDER)).toContain(
      "Embed openOnce: exact AST expected-discovery assertion is not unique"
    );

    const ftsExpectedDiscoveryAssertionReordered = mutateOpenOnceExactly(
      ftsSource,
      FTS_ADMISSION_ORDER,
      `${FTS_ADMISSION_ORDER.expectedAssert}\n        ${FTS_ADMISSION_ORDER.bootstrapCall}`,
      `${FTS_ADMISSION_ORDER.bootstrapCall}\n        ${FTS_ADMISSION_ORDER.expectedAssert}`
    );
    expect(admissionOrderProblems(ftsExpectedDiscoveryAssertionReordered, FTS_ADMISSION_ORDER)).toContain(
      "FTS openOnce: exact guarded admission sequence changed"
    );
    const embedExpectedDiscoveryAssertionReordered = mutateOpenOnceExactly(
      embedSource,
      EMBED_ADMISSION_ORDER,
      `${EMBED_ADMISSION_ORDER.firstAssert}\n      ${EMBED_ADMISSION_ORDER.expectedAssert}`,
      `${EMBED_ADMISSION_ORDER.expectedAssert}\n      ${EMBED_ADMISSION_ORDER.firstAssert}`
    );
    expect(admissionOrderProblems(embedExpectedDiscoveryAssertionReordered, EMBED_ADMISSION_ORDER)).toContain(
      "Embed openOnce: exact guarded admission sequence changed"
    );

    const ftsExpectedDiscoveryAssertionDecoy = mutateOpenOnceExactly(
      ftsSource,
      FTS_ADMISSION_ORDER,
      FTS_ADMISSION_ORDER.expectedAssert,
      `if (false) {\n${FTS_ADMISSION_ORDER.expectedAssert}\n}`
    );
    expect(admissionOrderProblems(ftsExpectedDiscoveryAssertionDecoy, FTS_ADMISSION_ORDER)).toContain(
      "FTS openOnce: exact guarded admission sequence changed"
    );
    const embedExpectedDiscoveryAssertionDecoy = mutateOpenOnceExactly(
      embedSource,
      EMBED_ADMISSION_ORDER,
      EMBED_ADMISSION_ORDER.expectedAssert,
      'const expectedDiscoveryDecoy = "assertExpectedEmbedDiscovery(expected, fileExisted, admission);";\n' +
        "void expectedDiscoveryDecoy;"
    );
    expect(admissionOrderProblems(embedExpectedDiscoveryAssertionDecoy, EMBED_ADMISSION_ORDER)).toContain(
      "Embed openOnce: exact AST expected-discovery assertion is not unique"
    );

    const ftsBootstrapCallBeforeTxn = replaceExactly(
      ftsSource,
      '    const tokenizeArg = this.tokenize === "trigram" ? "trigram" : "unicode61 remove_diacritics 2";\n',
      '    const tokenizeArg = this.tokenize === "trigram" ? "trigram" : "unicode61 remove_diacritics 2";\n' +
        '    db.exec("CREATE TABLE admission_bypass(x)");\n'
    );
    expect(admissionOrderProblems(ftsBootstrapCallBeforeTxn, FTS_ADMISSION_ORDER)).toContain(
      "FTS bootstrap: exact top-level sequence changed"
    );

    const embedBootstrapCallBeforeTxn = replaceExactly(
      embedSource,
      '  private bootstrapSchema(initialKind: "empty" | "owned", initialSignature: string): void {\n' +
        "    const db = this.requireDb();\n" +
        "    const txn = db.transaction(() => {",
      '  private bootstrapSchema(initialKind: "empty" | "owned", initialSignature: string): void {\n' +
        "    const db = this.requireDb();\n" +
        '    db.prepare("DELETE FROM embeddings").run();\n' +
        "    const txn = db.transaction(() => {"
    );
    expect(admissionOrderProblems(embedBootstrapCallBeforeTxn, EMBED_ADMISSION_ORDER)).toContain(
      "Embed bootstrap: exact top-level sequence changed"
    );

    const ftsBootstrapCallBeforeImmediate = replaceExactly(
      ftsSource,
      "    });\n    txn.immediate();",
      '    });\n    db.prepare("DELETE FROM chunks").run();\n    txn.immediate();'
    );
    expect(admissionOrderProblems(ftsBootstrapCallBeforeImmediate, FTS_ADMISSION_ORDER)).toContain(
      "FTS bootstrap: exact top-level sequence changed"
    );

    const embedBootstrapCallBeforeImmediate = replaceExactly(
      embedSource,
      "    });\n    txn.immediate();",
      '    });\n    db.exec("CREATE TABLE admission_bypass(x)");\n    txn.immediate();'
    );
    expect(admissionOrderProblems(embedBootstrapCallBeforeImmediate, EMBED_ADMISSION_ORDER)).toContain(
      "Embed bootstrap: exact top-level sequence changed"
    );

    const ftsTxnCallBetweenGuardAndContinuity = replaceExactly(
      ftsSource,
      "      const admission = this.inspectAdmission();\n",
      "      const admission = this.inspectAdmission();\n" + '      db.exec("CREATE TABLE admission_bypass(x)");\n'
    );
    expect(admissionOrderProblems(ftsTxnCallBetweenGuardAndContinuity, FTS_ADMISSION_ORDER)).toContain(
      "FTS bootstrap: guarded callback leading statement grammar changed"
    );
    const embedTxnCallBetweenGuardAndAssert = replaceExactly(
      embedSource,
      "      const admission = inspectEmbedAdmission(db, this.vaultRoot);\n" +
        "      assertEmbedAdmission(admission);\n",
      "      const admission = inspectEmbedAdmission(db, this.vaultRoot);\n" +
        '      db.prepare("DELETE FROM embeddings").run();\n' +
        "      assertEmbedAdmission(admission);\n"
    );
    expect(admissionOrderProblems(embedTxnCallBetweenGuardAndAssert, EMBED_ADMISSION_ORDER)).toContain(
      "Embed bootstrap: guarded callback leading statement grammar changed"
    );
    const embedTxnCallBetweenAssertAndContinuity = replaceExactly(
      embedSource,
      "      const admission = inspectEmbedAdmission(db, this.vaultRoot);\n" +
        "      assertEmbedAdmission(admission);\n",
      "      const admission = inspectEmbedAdmission(db, this.vaultRoot);\n" +
        "      assertEmbedAdmission(admission);\n" +
        '      db.prepare("DELETE FROM embeddings").run();\n'
    );
    expect(admissionOrderProblems(embedTxnCallBetweenAssertAndContinuity, EMBED_ADMISSION_ORDER)).toContain(
      "Embed bootstrap: guarded callback leading statement grammar changed"
    );

    const ftsUnboundedSchema = replaceExactly(
      ftsSource,
      "                  substr(name, 1, ?) AS name,\n                  substr(sql, 1, ?) AS sql",
      "                  name,\n                  sql"
    );
    expect(boundedAdmissionProjectionProblems(ftsUnboundedSchema, FTS_BOUNDED_ADMISSION)).toContain(
      "FTS admission: bounded sqlite_master name projection is missing"
    );
    const embedUnboundedSchema = replaceExactly(
      embedSource,
      "                substr(name, 1, ?) AS name,\n                substr(sql, 1, ?) AS sql",
      "                name,\n                sql"
    );
    expect(boundedAdmissionProjectionProblems(embedUnboundedSchema, EMBED_BOUNDED_ADMISSION)).toContain(
      "Embed admission: bounded sqlite_master SQL projection is missing"
    );
    const ftsUnboundedMeta = replaceExactly(
      ftsSource,
      "SELECT substr(key, 1, ?) AS key, substr(value, 1, ?) AS value FROM meta LIMIT 4",
      "SELECT key, value FROM meta LIMIT 4",
      2
    );
    expect(boundedAdmissionProjectionProblems(ftsUnboundedMeta, FTS_BOUNDED_ADMISSION)).toContain(
      "FTS admission: bounded meta value projection is missing"
    );
    const embedUnboundedMeta = replaceExactly(
      embedSource,
      "        `SELECT substr(key, 1, ?) AS key,\n                substr(value, 1, ?) AS value",
      "        `SELECT key,\n                value",
      2
    );
    expect(boundedAdmissionProjectionProblems(embedUnboundedMeta, EMBED_BOUNDED_ADMISSION)).toContain(
      "Embed admission: bounded meta key projection is missing"
    );

    const ftsDdlBeforeGuard = replaceExactly(
      ftsSource,
      "      const admission = this.inspectAdmission();",
      "      db.exec(`CREATE TABLE admission_bypass(x)`);\n      const admission = this.inspectAdmission();"
    );
    expect(admissionOrderProblems(ftsDdlBeforeGuard, FTS_ADMISSION_ORDER)).toEqual(
      expect.arrayContaining([
        "FTS bootstrap: second guard is not the first callback action",
        "FTS bootstrap: second guard is not before first DDL"
      ])
    );

    const embedDdlBeforeGuard = replaceExactly(
      embedSource,
      "      const admission = inspectEmbedAdmission(db, this.vaultRoot);",
      "      db.exec(`CREATE TABLE admission_bypass(x)`);\n" +
        "      const admission = inspectEmbedAdmission(db, this.vaultRoot);"
    );
    expect(admissionOrderProblems(embedDdlBeforeGuard, EMBED_ADMISSION_ORDER)).toEqual(
      expect.arrayContaining([
        "Embed bootstrap: second guard is not the first callback action",
        "Embed bootstrap: second guard is not before first DDL"
      ])
    );

    const ftsDeferred = replaceExactly(ftsSource, "    txn.immediate();", "    txn();");
    expect(admissionOrderProblems(ftsDeferred, FTS_ADMISSION_ORDER)).toEqual(
      expect.arrayContaining([
        "FTS bootstrap: IMMEDIATE invocation is missing",
        "FTS bootstrap: deferred transaction invocation remains"
      ])
    );
    const embedDeferred = replaceExactly(embedSource, "    txn.immediate();", "    txn();");
    expect(admissionOrderProblems(embedDeferred, EMBED_ADMISSION_ORDER)).toEqual(
      expect.arrayContaining([
        "Embed bootstrap: IMMEDIATE invocation is missing",
        "Embed bootstrap: deferred transaction invocation remains"
      ])
    );

    const ftsJournalBeforeGuard = mutateOpenOnceExactly(
      ftsSource,
      FTS_ADMISSION_ORDER,
      FTS_ADMISSION_ORDER.firstGuard,
      `this.db.pragma("journal_mode = WAL");\n${FTS_ADMISSION_ORDER.firstGuard}`
    );
    expect(admissionOrderProblems(ftsJournalBeforeGuard, FTS_ADMISSION_ORDER)).toContain(
      "FTS openOnce: journal_mode runs before bootstrap"
    );
    const embedJournalBeforeGuard = mutateOpenOnceExactly(
      embedSource,
      EMBED_ADMISSION_ORDER,
      EMBED_ADMISSION_ORDER.firstGuard,
      `this.db.pragma("journal_mode = WAL");\n${EMBED_ADMISSION_ORDER.firstGuard}`
    );
    expect(admissionOrderProblems(embedJournalBeforeGuard, EMBED_ADMISSION_ORDER)).toContain(
      "Embed openOnce: journal_mode runs before bootstrap"
    );

    const artifactChmodBlock =
      "await Promise.all(\n" +
      `        [this.file, \`\${this.file}-wal\`, \`\${this.file}-shm\`].map((p) => fs.chmod(p, 0o600).catch(() => {}))\n` +
      "      );";
    const earlyArtifactChmod =
      "await Promise.all(\n" +
      `  [this.file, \`\${this.file}-wal\`, \`\${this.file}-shm\`].map((p) => fs.chmod(p, 0o600).catch(() => {}))\n` +
      ");\n";
    const ftsChmodBeforeGuard = mutateOpenOnceExactly(
      mutateOpenOnceExactly(ftsSource, FTS_ADMISSION_ORDER, artifactChmodBlock, ""),
      FTS_ADMISSION_ORDER,
      FTS_ADMISSION_ORDER.firstGuard,
      `${earlyArtifactChmod}${FTS_ADMISSION_ORDER.firstGuard}`
    );
    expect(admissionOrderProblems(ftsChmodBeforeGuard, FTS_ADMISSION_ORDER)).toContain(
      "FTS openOnce: artifact chmod runs before synchronous"
    );
    const embedChmodBeforeGuard = mutateOpenOnceExactly(
      mutateOpenOnceExactly(embedSource, EMBED_ADMISSION_ORDER, artifactChmodBlock, ""),
      EMBED_ADMISSION_ORDER,
      EMBED_ADMISSION_ORDER.firstGuard,
      `${earlyArtifactChmod}${EMBED_ADMISSION_ORDER.firstGuard}`
    );
    expect(admissionOrderProblems(embedChmodBeforeGuard, EMBED_ADMISSION_ORDER)).toContain(
      "Embed openOnce: artifact chmod runs before synchronous"
    );

    const ftsFreshGuardRemoved = mutateOpenOnceExactly(
      ftsSource,
      FTS_ADMISSION_ORDER,
      "if (!fileExisted) {",
      "if (true) {"
    );
    expect(freshParentPreparationProblems(ftsFreshGuardRemoved, embedSource)).toContain(
      "FTS openOnce: initial SQLite family preflight must precede dependency load and fresh branch"
    );
    const embedFreshGuardRemoved = mutateOpenOnceExactly(
      embedSource,
      EMBED_ADMISSION_ORDER,
      "if (!fileExisted) {",
      "if (true) {"
    );
    expect(freshParentPreparationProblems(ftsSource, embedFreshGuardRemoved)).toContain(
      "Embed openOnce: initial SQLite family preflight must precede dependency load and fresh branch"
    );

    const ftsContinuityDropped = replaceExactly(
      ftsSource,
      "if (admission.kind !== initialAdmission.kind || admission.signature !== initialAdmission.signature)",
      "if (admission.kind !== initialAdmission.kind)"
    );
    expect(admissionOrderProblems(ftsContinuityDropped, FTS_ADMISSION_ORDER)).toContain(
      "FTS bootstrap: guard continuity comparison is missing"
    );
    const embedContinuityDropped = replaceExactly(
      embedSource,
      "if (admission.kind !== initialKind || admission.signature !== initialSignature)",
      "if (admission.kind !== initialKind)"
    );
    expect(admissionOrderProblems(embedContinuityDropped, EMBED_ADMISSION_ORDER)).toContain(
      "Embed bootstrap: guard continuity comparison is missing"
    );
  }, 30_000);

  it.for([
    { store: "FTS" as const, file: "fts5.ts", spec: FTS_ADMISSION_ORDER },
    { store: "Embed" as const, file: "embed-db.ts", spec: EMBED_ADMISSION_ORDER }
  ])("rejects a $store public-open delegation that no longer tracks openOnce", async ({ file, spec }) => {
    const source = await fs.readFile(path.resolve(process.cwd(), "src", file), "utf8");
    const mutant = replaceExactly(source, spec.delegation, "const attempt = Promise.resolve();");
    expect(publicOpenWrapperProblems(mutant, spec)).toContain(
      `${spec.label} public open: exact openOnce delegation is not unique`
    );
  });

  it.for([
    { store: "FTS" as const, file: "fts5.ts", spec: FTS_ADMISSION_ORDER },
    { store: "Embed" as const, file: "embed-db.ts", spec: EMBED_ADMISSION_ORDER }
  ])("rejects a $store authority snapshot after the first await", async ({ file, spec }) => {
    const source = await fs.readFile(path.resolve(process.cwd(), "src", file), "utf8");
    const mutant = replaceExactly(source, spec.cloneStatement, `await Promise.resolve();\n    ${spec.cloneStatement}`);
    expect(publicOpenWrapperProblems(mutant, spec)).toContain(
      `${spec.label} public open: caller authority is not snapshotted before the first await`
    );
  });

  it.for([
    { store: "FTS" as const, file: "fts5.ts", spec: FTS_ADMISSION_ORDER },
    { store: "Embed" as const, file: "embed-db.ts", spec: EMBED_ADMISSION_ORDER }
  ])("rejects a $store public wrapper with a second hidden openOnce call", async ({ file, spec }) => {
    const source = await fs.readFile(path.resolve(process.cwd(), "src", file), "utf8");
    const mutant = replaceExactly(source, spec.delegation, `${spec.delegation}\n    void this.openOnce(expected);`);
    expect(publicOpenWrapperProblems(mutant, spec)).toContain(
      `${spec.label} public open: openOnce call census changed`
    );
  });

  it.for([
    { store: "FTS" as const, file: "fts5.ts", spec: FTS_ADMISSION_ORDER },
    { store: "Embed" as const, file: "embed-db.ts", spec: EMBED_ADMISSION_ORDER }
  ])("rejects a $store public wrapper without the post-drain join", async ({ file, spec }) => {
    const source = await fs.readFile(path.resolve(process.cwd(), "src", file), "utf8");
    const publicOpen = sectionBetween(
      source,
      `${spec.label} public-open mutation fixture`,
      `  async open(expectedDiscovery?: ${spec.publicOpenParameterType}): Promise<void> {`,
      spec.mutatingOpenStart
    ).text;
    const postDrainAt = publicOpen.lastIndexOf(spec.postDrainJoin);
    expect(postDrainAt).toBeGreaterThanOrEqual(0);
    const mutantOpen = `${publicOpen.slice(0, postDrainAt)}void 0;${publicOpen.slice(
      postDrainAt + spec.postDrainJoin.length
    )}`;
    const mutant = replaceExactly(source, publicOpen, mutantOpen);
    expect(publicOpenWrapperProblems(mutant, spec)).toContain(
      `${spec.label} public open: post-drain single-flight recheck is not unique`
    );
  });

  it.for([
    { store: "FTS" as const, file: "fts5.ts", spec: FTS_ADMISSION_ORDER },
    { store: "Embed" as const, file: "embed-db.ts", spec: EMBED_ADMISSION_ORDER }
  ])("rejects a $store pre-drain join that can return a close-doomed attempt", async ({ file, spec }) => {
    const source = await fs.readFile(path.resolve(process.cwd(), "src", file), "utf8");
    const mutant = replaceExactly(source, spec.initialJoin, spec.unsafeInitialJoin);
    expect(publicOpenWrapperProblems(mutant, spec)).toContain(
      `${spec.label} public open: exact pre-drain single-flight join is not unique`
    );
  });

  it.for([
    { store: "FTS" as const, file: "fts5.ts", spec: FTS_ADMISSION_ORDER },
    { store: "Embed" as const, file: "embed-db.ts", spec: EMBED_ADMISSION_ORDER }
  ])("rejects a $store reopen that drops the later-close generation comparison", async ({ file, spec }) => {
    const source = await fs.readFile(path.resolve(process.cwd(), "src", file), "utf8");
    const mutant = mutatePublicOpenExactly(source, spec, spec.closeSupersededGuard, "void 0;");
    expect(publicOpenWrapperProblems(mutant, spec)).toContain(
      `${spec.label} public open: later-close generation guard changed`
    );
  });

  it.for([
    { store: "FTS" as const, file: "fts5.ts", spec: FTS_ADMISSION_ORDER },
    { store: "Embed" as const, file: "embed-db.ts", spec: EMBED_ADMISSION_ORDER }
  ])("rejects a $store reopen that re-enters public closeAndRelease", async ({ file, spec }) => {
    const source = await fs.readFile(path.resolve(process.cwd(), "src", file), "utf8");
    const mutant = mutatePublicOpenExactly(source, spec, spec.closeFinish, "await this.closeAndRelease();");
    expect(publicOpenWrapperProblems(mutant, spec)).toContain(`${spec.label} public open: private close drain changed`);
  });

  it.for([
    { store: "FTS" as const, file: "fts5.ts", spec: FTS_ADMISSION_ORDER },
    { store: "Embed" as const, file: "embed-db.ts", spec: EMBED_ADMISSION_ORDER }
  ])("rejects a $store later-close comparison moved after flag clearing", async ({ file, spec }) => {
    const source = await fs.readFile(path.resolve(process.cwd(), "src", file), "utf8");
    const resetSequence = spec.closeReset.join("\n      ");
    const reorderedDrain = replaceExactly(
      spec.closeDrain,
      `${spec.closeSupersededGuard}\n      ${resetSequence}`,
      `${resetSequence}\n      ${spec.closeSupersededGuard}`
    );
    const mutant = mutatePublicOpenExactly(source, spec, spec.closeDrain, reorderedDrain);
    expect(publicOpenWrapperProblems(mutant, spec)).toContain(
      `${spec.label} public open: token-capture/drain/compare/reset sequence changed`
    );
  });

  it.for([
    { store: "FTS" as const, file: "fts5.ts", spec: FTS_ADMISSION_ORDER },
    { store: "Embed" as const, file: "embed-db.ts", spec: EMBED_ADMISSION_ORDER }
  ])("rejects a $store openOnce that loses its private mutating signature", async ({ file, spec }) => {
    const source = await fs.readFile(path.resolve(process.cwd(), "src", file), "utf8");
    const mutant = replaceExactly(source, spec.mutatingOpenStart, spec.mutatingOpenStart.replace("private ", ""));
    expect(admissionOrderProblems(mutant, spec)).toContain(
      `${spec.label} openOnce: exact private mutating signature changed`
    );
  });

  it.for([
    { store: "FTS" as const, file: "fts5.ts", spec: FTS_ADMISSION_ORDER },
    { store: "Embed" as const, file: "embed-db.ts", spec: EMBED_ADMISSION_ORDER }
  ])("rejects a $store admission guard removed from openOnce", async ({ file, spec }) => {
    const source = await fs.readFile(path.resolve(process.cwd(), "src", file), "utf8");
    const mutant = replaceExactly(source, spec.firstGuard, "void 0;");
    expect(admissionOrderProblems(mutant, spec)).toContain(
      `${spec.label} openOnce: exact AST first guard is not unique`
    );
  });

  it.for([
    { store: "FTS" as const, file: "fts5.ts", spec: FTS_ADMISSION_ORDER },
    { store: "Embed" as const, file: "embed-db.ts", spec: EMBED_ADMISSION_ORDER }
  ])("rejects a $store admission guard moved from openOnce into public open", async ({ file, spec }) => {
    const source = await fs.readFile(path.resolve(process.cwd(), "src", file), "utf8");
    const removed = replaceExactly(source, spec.firstGuard, "void 0;");
    const mutant = replaceExactly(removed, spec.cloneStatement, `${spec.firstGuard}\n    ${spec.cloneStatement}`);
    expect(admissionOrderProblems(mutant, spec)).toContain(
      `${spec.label} openOnce: exact AST first guard is not unique`
    );
    expect(publicOpenWrapperProblems(mutant, spec)).toContain(
      `${spec.label} public open: mutating admission escaped openOnce`
    );
  });

  it.for([
    { store: "FTS" as const, phase: "initial" as const, mutation: "missing" as const },
    { store: "FTS" as const, phase: "initial" as const, mutation: "reordered" as const },
    { store: "FTS" as const, phase: "final" as const, mutation: "missing" as const },
    { store: "FTS" as const, phase: "final" as const, mutation: "reordered" as const },
    { store: "Embed" as const, phase: "initial" as const, mutation: "missing" as const },
    { store: "Embed" as const, phase: "initial" as const, mutation: "reordered" as const },
    { store: "Embed" as const, phase: "final" as const, mutation: "missing" as const },
    { store: "Embed" as const, phase: "final" as const, mutation: "reordered" as const }
  ])("rejects a $store $phase family-preflight that is $mutation", async ({ store, phase, mutation }) => {
    const ftsSource = await fs.readFile(path.resolve(process.cwd(), "src", "fts5.ts"), "utf8");
    const embedSource = await fs.readFile(path.resolve(process.cwd(), "src", "embed-db.ts"), "utf8");
    const source = store === "FTS" ? ftsSource : embedSource;
    const admissionSpec = store === "FTS" ? FTS_ADMISSION_ORDER : EMBED_ADMISSION_ORDER;
    const handle = admissionSpec.handle;
    const preflight = "fileExisted = await preflightSqliteArtifactFamily(this.file);";
    const dependencyLoad = "const Ctor = await loadBetterSqlite();";
    const openOnce = sectionBetween(
      source,
      `${store} mutating openOnce mutation fixture`,
      admissionSpec.mutatingOpenStart,
      admissionSpec.mutatingOpenEnd
    ).text;
    const offsets: number[] = [];
    for (
      let offset = openOnce.indexOf(preflight);
      offset >= 0;
      offset = openOnce.indexOf(preflight, offset + preflight.length)
    ) {
      offsets.push(offset);
    }
    expect(offsets).toHaveLength(2);
    const mutateOccurrence = (body: string, occurrence: number, replacement: string): string => {
      const at = offsets[occurrence];
      expect(at).toBeTypeOf("number");
      return body.slice(0, at) + replacement + body.slice((at ?? -1) + preflight.length);
    };

    let mutantOpen: string;
    if (phase === "initial" && mutation === "missing") {
      mutantOpen = mutateOccurrence(openOnce, 0, "fileExisted = false;");
    } else if (phase === "initial") {
      mutantOpen = mutateOccurrence(openOnce, 0, "fileExisted = false;");
      mutantOpen = replaceExactly(mutantOpen, dependencyLoad, `${dependencyLoad}\n      ${preflight}`);
    } else if (mutation === "missing") {
      mutantOpen = mutateOccurrence(openOnce, 1, "fileExisted = false;");
    } else {
      mutantOpen = mutateOccurrence(openOnce, 1, "fileExisted = false;");
      mutantOpen = replaceExactly(mutantOpen, handle, `${handle}\n      ${preflight}`);
    }
    const mutant = replaceExactly(source, openOnce, mutantOpen);

    const ftsCandidate = store === "FTS" ? mutant : ftsSource;
    const embedCandidate = store === "Embed" ? mutant : embedSource;
    if (phase === "initial") {
      expect(freshParentPreparationProblems(ftsCandidate, embedCandidate)).toContain(
        mutation === "missing"
          ? `${store} openOnce: expected exactly two SQLite family preflights`
          : `${store} openOnce: initial SQLite family preflight must precede dependency load and fresh branch`
      );
    } else {
      expect(admissionOrderProblems(mutant, admissionSpec)).toContain(
        `${store} openOnce: final SQLite family preflight is not immediately before live handle`
      );
    }
  });

  it("at least 6 EmbedDb/FtsIndex sites are tracked (sanity — invariant has scope)", async () => {
    const files = await collectTsFiles(SRC_ROOT);
    let total = 0;
    for (const file of files) {
      total += (await findConstructorSites(file)).length;
    }
    // As of v3.6.3 we have ≥ 11 sites across src/ + src/tools/. Lower bound
    // catches accidental file deletion that would silently shrink invariant
    // coverage. Adjust upward when adding new sites; never downward without
    // documenting the architectural removal in CHANGELOG.
    expect(total).toBeGreaterThanOrEqual(6);
  });

  // v3.7.0 M-3 — guards the recursive walker itself. If someone replaces
  // `collectTsFiles` with a non-recursive version, this catches the
  // regression by asserting that files in a known sub-directory (src/tools/)
  // appear in the collected set.
  it("recursive walker actually reaches src/tools/ (regression guard for M-3 fix)", async () => {
    const files = await collectTsFiles(SRC_ROOT);
    const hasToolsFile = files.some((f) => f.includes(`${path.sep}src${path.sep}tools${path.sep}`));
    expect(hasToolsFile, "recursive walker should pick up src/tools/*.ts").toBe(true);
    expect(["caller.ts", "caller.tsx", "caller.mts", "caller.cts"].every(isTypeScriptImplementationFile)).toBe(true);
    expect(["caller.d.ts", "caller.d.mts", "caller.d.cts"].some(isTypeScriptImplementationFile)).toBe(false);

    const extensionRoot = await fs.mkdtemp(path.join(tmpdir(), "enquire-k1-class-walker-"));
    try {
      const included = ["caller.ts", "caller.tsx", "caller.mts", "caller.cts"];
      const excluded = ["caller.d.ts", "caller.d.mts", "caller.d.cts", "caller.js"];
      await Promise.all([...included, ...excluded].map((name) => fs.writeFile(path.join(extensionRoot, name), "")));
      const collected = (await collectTsFiles(extensionRoot)).map((file) => path.basename(file)).sort();
      expect(collected).toEqual([...included].sort());
    } finally {
      await fs.rm(extensionRoot, { force: true, recursive: true });
    }
  });
});
