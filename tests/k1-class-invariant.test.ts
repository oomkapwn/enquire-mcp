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
// inventory below separately proves exact def-use/order at all ten sites.
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
  "src/server.ts": { discoverEmbedDbConfig: 2, discoverFtsIndexConfig: 1 },
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

/** Pin all production callers to the reviewed ten-site fail-closed inventory. */
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
  if (productionDiscoveryTotal !== 10) {
    problems.push(`global production discovery inventory: expected 10, found ${productionDiscoveryTotal}`);
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
  if (!serveHttp.includes("const { tokenize: rawTokenize, ...httpBaseOpts } = opts;")) {
    problems.push("serve-http: raw tokenizer is not removed before forwarding validated options");
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
      expected: 1
    },
    {
      label: "cli default-only canonical-root FTS paths",
      source: cliSource,
      needle: "const indexFile = defaultIndexFile(v.root);",
      expected: 2
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
    { label: "server Embed", source: serverSource, marker: "discoverEmbedDbConfig(", expected: 2 },
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
  if (uncachedEmbedDiscoveries !== 4) {
    problems.push(`uncached Embed discovery inventory: expected 4, found ${uncachedEmbedDiscoveries}`);
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
  instanceBinding: string;
  nullableDiscovery?: boolean;
  openTryAncestors?: number;
  openFailurePolicy?: "finally-propagate" | "rethrow" | "fail-soft-null";
}

/** Build the reviewed one-to-one fail-closed contract for all ten production callers. */
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
  const parent = node.parent;
  if (
    ts.isVariableDeclaration(parent) &&
    parent.initializer === node &&
    ts.isIdentifier(parent.name) &&
    parent.name.text === spec.instanceBinding
  ) {
    return { expression: node, binding: parent.name };
  }
  if (
    ts.isBinaryExpression(parent) &&
    parent.right === node &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isIdentifier(parent.left) &&
    parent.left.text === spec.instanceBinding
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
      finallyBlock.statements[0]?.getText(sourceFile) === `${spec.instanceBinding}.close();`
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
      catchStatements[0]?.getText(sourceFile) === `${spec.instanceBinding}.close();` &&
      catchStatements[1]?.getText(sourceFile) === "throw err;"
    );
  }

  if (catchStatements.length !== 3) return false;
  const cleanup = catchStatements[0];
  const nullAssignment = catchStatements[1];
  const diagnostic = catchStatements[2];
  return (
    cleanup !== undefined &&
    ts.isTryStatement(cleanup) &&
    cleanup.finallyBlock === undefined &&
    cleanup.tryBlock.statements.length === 1 &&
    cleanup.tryBlock.statements[0]?.getText(sourceFile) === `${spec.instanceBinding}?.close();` &&
    cleanup.catchClause?.block.statements.length === 0 &&
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
 * Bind each of the ten preflight reads to exactly one constructor and its
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
      problems.push(`${spec.label}: constructor is not uniquely bound to ${spec.instanceBinding}`);
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
  if (specs.length !== 10) {
    problems.push(`discovery/open binding inventory: expected 10 specs, found ${specs.length}`);
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
  openStart: string;
  openEnd: string;
  openParameterType: "EmbedDbConfigDiscovery" | "FtsIndexDiscovery";
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
  const open = sectionBetween(source, `${spec.label} open`, spec.openStart, spec.openEnd).text;
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
      problems.push(`${spec.label} open: ${step.label} is missing`);
      continue;
    }
    if (at < previousAt) {
      problems.push(`${spec.label} open: ${step.label} runs before ${previousLabel}`);
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
  const openMethod = exactClassMethod(sourceFile, spec.className, "open");
  if (!openMethod?.body) {
    problems.push(`${spec.label} open: exact AST method is missing`);
  } else {
    const parameter = openMethod.parameters.length === 1 ? openMethod.parameters[0] : undefined;
    const signatureIsExact =
      openMethod.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) === true &&
      parameter !== undefined &&
      ts.isIdentifier(parameter.name) &&
      parameter.name.text === "expectedDiscovery" &&
      parameter.questionToken !== undefined &&
      parameter.dotDotDotToken === undefined &&
      parameter.initializer === undefined &&
      parameter.type?.getText(sourceFile) === spec.openParameterType &&
      openMethod.type?.getText(sourceFile) === "Promise<void>";
    if (!signatureIsExact) {
      problems.push(`${spec.label} open: exact optional-discovery signature changed`);
    }
    const handles = statementsWithExactText(openMethod.body, sourceFile, spec.handle);
    const firstGuards = statementsWithExactText(openMethod.body, sourceFile, spec.firstGuard);
    const firstAssertions = spec.firstAssert
      ? statementsWithExactText(openMethod.body, sourceFile, spec.firstAssert)
      : [];
    const expectedAssertions = statementsWithExactText(openMethod.body, sourceFile, spec.expectedAssert);
    const bootstraps = statementsWithExactText(openMethod.body, sourceFile, spec.bootstrapCall);
    if (handles.length !== 1) {
      problems.push(`${spec.label} open: exact AST live-handle assignment is not unique`);
    }
    if (firstGuards.length !== 1) {
      problems.push(`${spec.label} open: exact AST first guard is not unique`);
    }
    if (spec.firstAssert && firstAssertions.length !== 1) {
      problems.push(`${spec.label} open: exact AST first guard assertion is not unique`);
    }
    if (expectedAssertions.length !== 1) {
      problems.push(`${spec.label} open: exact AST expected-discovery assertion is not unique`);
    }
    if (bootstraps.length !== 1) {
      problems.push(`${spec.label} open: exact AST bootstrap call is not unique`);
    }
    const handle = handles[0];
    const firstGuard = firstGuards[0];
    if (handle && firstGuard) {
      if (handle.end >= firstGuard.getStart(sourceFile)) {
        problems.push(`${spec.label} open: AST first guard does not follow live handle`);
      } else if (callCountBetween(openMethod.body, sourceFile, handle.end, firstGuard.getStart(sourceFile)) > 0) {
        problems.push(`${spec.label} open: call runs between live handle and first guard`);
      }
    }
    const handleTry = handle ? directTryStatement(handle) : null;
    const admissionTry = firstGuard ? directTryStatement(firstGuard) : null;
    const openStatements = openMethod.body.statements;
    const handleTryAt = handleTry ? openStatements.indexOf(handleTry) : -1;
    const admissionTryAt = admissionTry ? openStatements.indexOf(admissionTry) : -1;
    const guardedStatements = [
      firstGuard,
      ...(spec.firstAssert ? [firstAssertions[0]] : []),
      expectedAssertions[0],
      bootstraps[0]
    ];
    const guardedSequenceIsExact = guardedStatements.every(
      (statement, index) => statement !== undefined && admissionTry?.tryBlock.statements[index] === statement
    );
    if (
      handleTry?.tryBlock.statements.length !== 1 ||
      handleTry.tryBlock.statements[0] !== handle ||
      !admissionTry ||
      handleTryAt < 0 ||
      admissionTryAt !== handleTryAt + 1 ||
      !guardedSequenceIsExact
    ) {
      problems.push(`${spec.label} open: exact guarded admission sequence changed`);
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

const FTS_ADMISSION_ORDER: AdmissionOrderSpec = {
  label: "FTS",
  className: "FtsIndex",
  openStart: "  async open(expectedDiscovery?: FtsIndexDiscovery): Promise<void> {",
  openEnd: "  /** Remove the index file",
  openParameterType: "FtsIndexDiscovery",
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
  openStart: "  async open(expectedDiscovery?: EmbedDbConfigDiscovery): Promise<void> {",
  openEnd: "  /**\n   * Remove the embed db",
  openParameterType: "EmbedDbConfigDiscovery",
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
  const ftsOpen = sectionBetween(
    ftsSource,
    "FTS open",
    FTS_ADMISSION_ORDER.openStart,
    FTS_ADMISSION_ORDER.openEnd
  ).text;
  const embedOpen = sectionBetween(
    embedSource,
    "Embed open",
    EMBED_ADMISSION_ORDER.openStart,
    EMBED_ADMISSION_ORDER.openEnd
  ).text;

  for (const entry of [
    { label: "FTS", open: ftsOpen, handle: FTS_ADMISSION_ORDER.handle },
    { label: "Embed", open: embedOpen, handle: EMBED_ADMISSION_ORDER.handle }
  ]) {
    const targetProof = entry.open.indexOf("await fs.lstat(this.file);");
    const freshGuard = entry.open.indexOf("if (!fileExisted) {");
    const handleAt = entry.open.indexOf(entry.handle);
    const freshBlock = sectionBetween(
      entry.open,
      `${entry.label} fresh-parent block`,
      "if (!fileExisted) {",
      "\n    try {\n      this.db = new Ctor"
    ).text;
    if (!(targetProof >= 0 && targetProof < freshGuard && freshGuard < handleAt)) {
      problems.push(`${entry.label} open: fresh-parent preparation lacks a pre-handle target existence proof`);
    }
    if (!freshBlock.includes("await fs.mkdir(parentDir") || !freshBlock.includes("if (!parentExisted) {")) {
      problems.push(`${entry.label} open: parent creation is not contained by the fresh-file branch`);
    }
    if (!freshBlock.includes("await fs.chmod(parentDir, 0o700)")) {
      problems.push(`${entry.label} open: parent chmod is not limited to a newly-created fresh-file parent`);
    }
    if (countLiteral(entry.open, "fs.chmod(parentDir") !== 1) {
      problems.push(`${entry.label} open: parent chmod escaped its single fresh-file exception`);
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
    expect(countLiteral(serverSource, "resolveStoredEmbeddingConfiguration(")).toBe(2);
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

    const serverRootFiltersRemoved = replaceAllExactly(
      replaceExactly(
        serverSource,
        "discoverFtsIndexConfig(indexFile, vault.root)",
        "discoverFtsIndexConfig(indexFile)"
      ),
      "discoverEmbedDbConfig(embedFile, vault.root)",
      "discoverEmbedDbConfig(embedFile)",
      2
    );
    expect(configurationDiscoveryRootProblems(cliSource, serverRootFiltersRemoved, searchSource)).toEqual(
      expect.arrayContaining([
        "server FTS canonical-root discovery: expected 1, found 0",
        "server Embed canonical-root discoveries: expected 2, found 0"
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
        "uncached Embed discovery inventory: expected 4, found 5"
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
        "global production discovery inventory: expected 10, found 9"
      ])
    );
    expect(failClosedSpecInventoryProblems(rawPeekCli, serverSource, searchSource, rawPeekCalls)).toContain(
      "fail-closed caller spec inventory: 10 specs for 9 production discoveries"
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
        "global production discovery inventory: expected 10, found 11"
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
        "fail-closed caller spec inventory: 10 specs for 11 production discoveries"
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
      "      } finally {\n        ftsIndex.close();",
      "      } catch {} finally {\n        ftsIndex.close();"
    );
    expect(configurationDiscoveryOpenBindingProblems(queryOpenFailureSwallowed, serverSource, searchSource)).toContain(
      "CLI query FTS: reviewed open failure policy changed"
    );

    const evalOpenRethrowRemoved = replaceExactly(
      cliSource,
      "          } catch (err) {\n            ftsIndex.close();\n            throw err;\n          }",
      "          } catch {}"
    );
    expect(configurationDiscoveryOpenBindingProblems(evalOpenRethrowRemoved, serverSource, searchSource)).toContain(
      "CLI eval FTS: reviewed open failure policy changed"
    );

    const serverOpenFailSoftNullRemoved = replaceExactly(serverSource, "        ftsIndex = null;\n", "");
    expect(configurationDiscoveryOpenBindingProblems(cliSource, serverOpenFailSoftNullRemoved, searchSource)).toContain(
      "server persistent FTS omitted tokenizer: reviewed open failure policy changed"
    );

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

    const serverEmbedFallbackReenabled = replaceExactly(
      serverSource,
      'if (discovered.kind === "missing" || discovered.kind === "refused")',
      "if (false)",
      2
    );
    expect(configurationDiscoveryFailClosedProblems(cliSource, serverEmbedFallbackReenabled, searchSource)).toEqual(
      expect.arrayContaining([
        "server watcher Embed: refused discovery refusal/degrade is missing",
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
      searchSource,
      "  const discovered = await discoverEmbedDbConfigCached(embedFile, vault.root);\n" +
        '  if (discovered.kind === "refused") {\n' +
        '    throw new Error("Embedding index configuration could not be verified");\n' +
        "  }\n",
      "  try {\n" +
        "    {\n" +
        "      const discovered = await discoverEmbedDbConfigCached(embedFile, vault.root);\n" +
        '      if (discovered.kind === "refused") {\n' +
        '        throw new Error("Embedding index configuration could not be verified");\n' +
        "      }\n" +
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

    const cliFtsRefusalsRemoved = replaceExactly(cliSource, 'if (discovered.kind === "refused")', "if (false)", 4);
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
      "    } else {\n      ftsIndex = new FtsIndex({ file: indexFile, vaultRoot: vault.root, tokenize });",
      "    }\n    {\n      ftsIndex = new FtsIndex({ file: indexFile, vaultRoot: vault.root, tokenize });"
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
      "        const indexFile = opts.indexFile ?? defaultIndexFile(vault.root);\n" +
        "        // v3.6.4 K-1 closure: if user passed --tokenize, honor user's intent.",
      "        const indexFile = defaultIndexFile(vault.root);\n" +
        "        // v3.6.4 K-1 closure: if user passed --tokenize, honor user's intent."
    );
    expect(tokenizerCallerProblems(customPathDropped, serverSource)).toContain(
      "cli custom/default vault-root FTS paths: expected 2, found 1"
    );

    const ftsSource = await fs.readFile(path.resolve(process.cwd(), "src", "fts5.ts"), "utf8");
    const embedSource = await fs.readFile(path.resolve(process.cwd(), "src", "embed-db.ts"), "utf8");
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
    expect(admissionOrderProblems(ftsOpenSignatureDropped, FTS_ADMISSION_ORDER)).toContain(
      "FTS open: exact optional-discovery signature changed"
    );
    const embedOpenSignatureWrongType = replaceExactly(
      embedSource,
      "  async open(expectedDiscovery?: EmbedDbConfigDiscovery): Promise<void> {",
      "  async open(expectedDiscovery?: FtsIndexDiscovery): Promise<void> {"
    );
    expect(admissionOrderProblems(embedOpenSignatureWrongType, EMBED_ADMISSION_ORDER)).toContain(
      "Embed open: exact optional-discovery signature changed"
    );

    const ftsOpenCallBeforeGuard = replaceExactly(
      ftsSource,
      "      this.db = new Ctor(this.file) as Db;\n",
      "      this.db = new Ctor(this.file) as Db;\n" + '      this.db.exec("CREATE TABLE admission_bypass(x)");\n'
    );
    expect(admissionOrderProblems(ftsOpenCallBeforeGuard, FTS_ADMISSION_ORDER)).toContain(
      "FTS open: call runs between live handle and first guard"
    );
    const embedOpenCallBeforeGuard = replaceExactly(
      embedSource,
      "      this.db = new Ctor(this.file) as Db;\n",
      "      this.db = new Ctor(this.file) as Db;\n" + '      this.db.prepare("DELETE FROM embeddings").run();\n'
    );
    expect(admissionOrderProblems(embedOpenCallBeforeGuard, EMBED_ADMISSION_ORDER)).toContain(
      "Embed open: call runs between live handle and first guard"
    );

    const embedOpenCallBetweenGuardAndAssert = replaceExactly(
      embedSource,
      "      const admission = inspectEmbedAdmission(this.db, this.vaultRoot);\n" +
        "      assertEmbedAdmission(admission);",
      "      const admission = inspectEmbedAdmission(this.db, this.vaultRoot);\n" +
        '      this.db.prepare("DELETE FROM embeddings").run();\n' +
        "      assertEmbedAdmission(admission);"
    );
    expect(admissionOrderProblems(embedOpenCallBetweenGuardAndAssert, EMBED_ADMISSION_ORDER)).toContain(
      "Embed open: exact guarded admission sequence changed"
    );

    const ftsOpenCallBetweenGuardAndBootstrap = replaceExactly(
      ftsSource,
      "      const initialAdmission = this.inspectAdmission();\n" +
        "      assertExpectedFtsDiscovery(expected, fileExisted, initialAdmission);",
      "      const initialAdmission = this.inspectAdmission();\n" +
        '      this.db.exec("CREATE TABLE admission_bypass(x)");\n' +
        "      assertExpectedFtsDiscovery(expected, fileExisted, initialAdmission);"
    );
    expect(admissionOrderProblems(ftsOpenCallBetweenGuardAndBootstrap, FTS_ADMISSION_ORDER)).toContain(
      "FTS open: exact guarded admission sequence changed"
    );

    const embedOpenCallBetweenAssertAndBootstrap = replaceExactly(
      embedSource,
      "      assertExpectedEmbedDiscovery(expected, fileExisted, admission);\n" +
        "      this.bootstrapSchema(admission.kind, admission.signature);",
      "      assertExpectedEmbedDiscovery(expected, fileExisted, admission);\n" +
        '      this.db.prepare("DELETE FROM embeddings").run();\n' +
        "      this.bootstrapSchema(admission.kind, admission.signature);"
    );
    expect(admissionOrderProblems(embedOpenCallBetweenAssertAndBootstrap, EMBED_ADMISSION_ORDER)).toContain(
      "Embed open: exact guarded admission sequence changed"
    );

    const ftsExpectedDiscoveryAssertionRemoved = replaceExactly(
      ftsSource,
      "      assertExpectedFtsDiscovery(expected, fileExisted, initialAdmission);\n",
      ""
    );
    expect(admissionOrderProblems(ftsExpectedDiscoveryAssertionRemoved, FTS_ADMISSION_ORDER)).toContain(
      "FTS open: exact AST expected-discovery assertion is not unique"
    );
    const embedExpectedDiscoveryAssertionRemoved = replaceExactly(
      embedSource,
      "      assertExpectedEmbedDiscovery(expected, fileExisted, admission);\n",
      ""
    );
    expect(admissionOrderProblems(embedExpectedDiscoveryAssertionRemoved, EMBED_ADMISSION_ORDER)).toContain(
      "Embed open: exact AST expected-discovery assertion is not unique"
    );

    const ftsExpectedDiscoveryAssertionReordered = replaceExactly(
      ftsSource,
      "      assertExpectedFtsDiscovery(expected, fileExisted, initialAdmission);\n" +
        "      this.bootstrapSchema(initialAdmission);",
      "      this.bootstrapSchema(initialAdmission);\n" +
        "      assertExpectedFtsDiscovery(expected, fileExisted, initialAdmission);"
    );
    expect(admissionOrderProblems(ftsExpectedDiscoveryAssertionReordered, FTS_ADMISSION_ORDER)).toContain(
      "FTS open: exact guarded admission sequence changed"
    );
    const embedExpectedDiscoveryAssertionReordered = replaceExactly(
      embedSource,
      "      assertEmbedAdmission(admission);\n" +
        "      assertExpectedEmbedDiscovery(expected, fileExisted, admission);",
      "      assertExpectedEmbedDiscovery(expected, fileExisted, admission);\n" +
        "      assertEmbedAdmission(admission);"
    );
    expect(admissionOrderProblems(embedExpectedDiscoveryAssertionReordered, EMBED_ADMISSION_ORDER)).toContain(
      "Embed open: exact guarded admission sequence changed"
    );

    const ftsExpectedDiscoveryAssertionDecoy = replaceExactly(
      ftsSource,
      "      assertExpectedFtsDiscovery(expected, fileExisted, initialAdmission);",
      "      if (false) {\n" +
        "        assertExpectedFtsDiscovery(expected, fileExisted, initialAdmission);\n" +
        "      }"
    );
    expect(admissionOrderProblems(ftsExpectedDiscoveryAssertionDecoy, FTS_ADMISSION_ORDER)).toContain(
      "FTS open: exact guarded admission sequence changed"
    );
    const embedExpectedDiscoveryAssertionDecoy = replaceExactly(
      embedSource,
      "      assertExpectedEmbedDiscovery(expected, fileExisted, admission);",
      '      const expectedDiscoveryDecoy = "assertExpectedEmbedDiscovery(expected, fileExisted, admission);";\n' +
        "      void expectedDiscoveryDecoy;"
    );
    expect(admissionOrderProblems(embedExpectedDiscoveryAssertionDecoy, EMBED_ADMISSION_ORDER)).toContain(
      "Embed open: exact AST expected-discovery assertion is not unique"
    );

    const ftsBootstrapCallBeforeTxn = replaceExactly(
      ftsSource,
      '    const tokenizeArg = this.tokenize === "trigram" ? "trigram" : "unicode61 remove_diacritics 2";\n' +
        "    const txn = db.transaction(() => {",
      '    const tokenizeArg = this.tokenize === "trigram" ? "trigram" : "unicode61 remove_diacritics 2";\n' +
        '    db.exec("CREATE TABLE admission_bypass(x)");\n' +
        "    const txn = db.transaction(() => {"
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

    const ftsJournalBeforeGuard = replaceExactly(
      ftsSource,
      "      const initialAdmission = this.inspectAdmission();",
      '      this.db.pragma("journal_mode = WAL");\n      const initialAdmission = this.inspectAdmission();'
    );
    expect(admissionOrderProblems(ftsJournalBeforeGuard, FTS_ADMISSION_ORDER)).toContain(
      "FTS open: journal_mode runs before bootstrap"
    );
    const embedJournalBeforeGuard = replaceExactly(
      embedSource,
      "      const admission = inspectEmbedAdmission(this.db, this.vaultRoot);",
      '      this.db.pragma("journal_mode = WAL");\n' +
        "      const admission = inspectEmbedAdmission(this.db, this.vaultRoot);"
    );
    expect(admissionOrderProblems(embedJournalBeforeGuard, EMBED_ADMISSION_ORDER)).toContain(
      "Embed open: journal_mode runs before bootstrap"
    );

    const artifactChmodBlock =
      "    await Promise.all(\n" +
      `      [this.file, \`\${this.file}-wal\`, \`\${this.file}-shm\`].map((p) => fs.chmod(p, 0o600).catch(() => {}))\n` +
      "    );\n";
    const earlyArtifactChmod =
      "      await Promise.all(\n" +
      `        [this.file, \`\${this.file}-wal\`, \`\${this.file}-shm\`].map((p) => fs.chmod(p, 0o600).catch(() => {}))\n` +
      "      );\n";
    const ftsChmodBeforeGuard = replaceExactly(
      replaceExactly(ftsSource, artifactChmodBlock, ""),
      "      const initialAdmission = this.inspectAdmission();",
      `${earlyArtifactChmod}      const initialAdmission = this.inspectAdmission();`
    );
    expect(admissionOrderProblems(ftsChmodBeforeGuard, FTS_ADMISSION_ORDER)).toContain(
      "FTS open: artifact chmod runs before synchronous"
    );
    const embedChmodBeforeGuard = replaceExactly(
      replaceExactly(embedSource, artifactChmodBlock, ""),
      "      const admission = inspectEmbedAdmission(this.db, this.vaultRoot);",
      `${earlyArtifactChmod}      const admission = inspectEmbedAdmission(this.db, this.vaultRoot);`
    );
    expect(admissionOrderProblems(embedChmodBeforeGuard, EMBED_ADMISSION_ORDER)).toContain(
      "Embed open: artifact chmod runs before synchronous"
    );

    const ftsFreshGuardRemoved = replaceExactly(ftsSource, "if (!fileExisted) {", "if (true) {");
    expect(freshParentPreparationProblems(ftsFreshGuardRemoved, embedSource)).toContain(
      "FTS open: fresh-parent preparation lacks a pre-handle target existence proof"
    );
    const embedFreshGuardRemoved = replaceExactly(embedSource, "if (!fileExisted) {", "if (true) {");
    expect(freshParentPreparationProblems(ftsSource, embedFreshGuardRemoved)).toContain(
      "Embed open: fresh-parent preparation lacks a pre-handle target existence proof"
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
