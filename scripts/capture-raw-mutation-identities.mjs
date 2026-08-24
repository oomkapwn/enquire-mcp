import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";

const META_PATH = "tests/meta-invariant-coverage.test.ts";
const RELEASE_AUDIT_PATH = "tests/release-mutation-identity-audit.ts";
const RELEASE_INTEGRITY_PATH = "tests/release-integrity.test.ts";
const TRANSITION_FIXTURE_PATH = "tests/fixtures/release-mutation-transition.v3.json";
const EXACT_MUTATION_HELPERS = new Set([
  "replaceExactly",
  "replaceAllExactly",
  "replaceIntegerAllExactly"
]);

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

function replaceOne(source, pattern, replacement, label) {
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) throw new Error(`${label}: expected one match, found ${matches.length}`);
  return source.replace(pattern, replacement);
}

function unwrapStaticExpression(node) {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function expressionReceiverRoot(expression) {
  const current = unwrapStaticExpression(expression);
  if (ts.isIdentifier(current)) return current.text;
  if (ts.isCallExpression(current)) return expressionReceiverRoot(current.expression);
  if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    return expressionReceiverRoot(current.expression);
  }
  return null;
}

function sourceOwnerSha256(id, node, sourceFile) {
  return sha256(
    JSON.stringify({
      id,
      source: ts.isSourceFile(node) ? node.getFullText() : node.getText(sourceFile),
      start: node.getStart(sourceFile)
    })
  );
}

function mutationHelperCallOwner(node) {
  let current = node;
  let nearestStatement = null;
  while (current !== undefined) {
    if (ts.isStatement(current) && nearestStatement === null) nearestStatement = current;
    if (ts.isFunctionDeclaration(current) && current.name !== undefined) {
      return { id: `function:${current.name.text}`, node: current };
    }
    if (ts.isMethodDeclaration(current) && ts.isIdentifier(current.name)) {
      return { id: `function:${current.name.text}`, node: current };
    }
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      if (ts.isVariableDeclaration(current.parent) && ts.isIdentifier(current.parent.name)) {
        return { id: `function:${current.parent.name.text}`, node: current };
      }
      const call = current.parent;
      if (ts.isCallExpression(call) && call.arguments.includes(current)) {
        const root = expressionReceiverRoot(call.expression) ?? "call";
        const title = call.arguments.find((argument) => ts.isStringLiteralLike(argument));
        return {
          id: title !== undefined && ts.isStringLiteralLike(title) ? `${root}:${title.text}` : `callback:${root}`,
          node: current
        };
      }
      return { id: "anonymous-function", node: current };
    }
    current = current.parent;
  }
  return { id: "source-statement", node: nearestStatement ?? node.getSourceFile() };
}

function ordinaryTransformOwner(node) {
  let current = node;
  while (current !== undefined) {
    if (ts.isFunctionDeclaration(current) && current.name !== undefined) {
      return { id: `function:${current.name.text}`, node: current };
    }
    if (ts.isMethodDeclaration(current) && ts.isIdentifier(current.name)) {
      return { id: `function:${current.name.text}`, node: current };
    }
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      if (ts.isVariableDeclaration(current.parent) && ts.isIdentifier(current.parent.name)) {
        return { id: `function:${current.parent.name.text}`, node: current };
      }
      const call = current.parent;
      if (ts.isCallExpression(call) && call.arguments.includes(current)) {
        const root = expressionReceiverRoot(call.expression);
        const title = call.arguments[0];
        if ((root === "it" || root === "test") && title !== undefined && ts.isStringLiteralLike(title)) {
          return { id: `test:${title.text}`, node: current };
        }
      }
    }
    current = current.parent;
  }
  return null;
}

function topLevelExecutableOwner(node, sourceFile) {
  let current = node;
  while (current.parent !== undefined && current.parent !== sourceFile) current = current.parent;
  return current.parent === sourceFile ? current : sourceFile;
}

function exactMutationHelperCallCensus(filename, source) {
  const sourceFile = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const records = [];
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      EXACT_MUTATION_HELPERS.has(node.expression.text)
    ) {
      const owner = mutationHelperCallOwner(node);
      const authorityOwner =
        filename === "meta-invariant-coverage.test.ts"
          ? topLevelExecutableOwner(node, sourceFile)
          : sourceFile;
      records.push({
        call: node.getText(sourceFile),
        callStart: node.getStart(sourceFile),
        owner: owner.id,
        ownerSha256: sourceOwnerSha256(owner.id, authorityOwner, sourceFile)
      });
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return { count: records.length, sha256: sha256(JSON.stringify(records)) };
}

function findArrayInitializer(sourceFile, binding) {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== binding || declaration.initializer === undefined) {
        continue;
      }
      const initializer = unwrapStaticExpression(declaration.initializer);
      if (!ts.isArrayLiteralExpression(initializer)) throw new Error(`${binding} is not an array literal`);
      return initializer;
    }
  }
  throw new Error(`missing ${binding}`);
}

function objectStringProperty(object, propertyName) {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = property.name;
    const staticName = ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : null;
    if (staticName !== propertyName || !ts.isStringLiteralLike(property.initializer)) continue;
    return property.initializer.text;
  }
  return null;
}

function objectStaticStringProperty(object, propertyName, sourceFile) {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = property.name;
    const staticName = ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : null;
    if (staticName !== propertyName) continue;
    if (ts.isStringLiteralLike(property.initializer)) return property.initializer.text;
    if (
      ts.isTaggedTemplateExpression(property.initializer) &&
      ts.isPropertyAccessExpression(property.initializer.tag) &&
      ts.isIdentifier(property.initializer.tag.expression) &&
      property.initializer.tag.expression.text === "String" &&
      property.initializer.tag.name.text === "raw" &&
      ts.isNoSubstitutionTemplateLiteral(property.initializer.template)
    ) {
      const text = property.initializer.template.getText(sourceFile);
      return text.slice(1, -1);
    }
    return null;
  }
  return null;
}

function callCensusFilenames(sourceFile) {
  const filenames = [];
  for (const element of findArrayInitializer(sourceFile, "EXPECTED_REPOSITORY_MUTATION_HELPER_CALL_ENTRIES").elements) {
    if (!ts.isArrayLiteralExpression(element) || !ts.isStringLiteralLike(element.elements[0])) {
      throw new Error("mutation helper call entry is not a literal tuple");
    }
    filenames.push(element.elements[0].text);
  }
  if (new Set(filenames).size !== filenames.length) throw new Error("duplicate mutation helper call filename");
  return filenames;
}

function ordinaryOwnerRows(sourceFile) {
  const rows = [];
  for (const element of findArrayInitializer(sourceFile, "REVIEWED_ORDINARY_TRANSFORMS").elements) {
    if (!ts.isObjectLiteralExpression(element)) throw new Error("reviewed ordinary transform is not an object literal");
    const filename = objectStringProperty(element, "filename");
    const id = objectStringProperty(element, "id");
    const method = objectStringProperty(element, "method");
    const owner = objectStringProperty(element, "owner");
    const pattern = objectStaticStringProperty(element, "pattern", sourceFile);
    const receiverRoot = objectStringProperty(element, "receiverRoot");
    const replacement = objectStringProperty(element, "replacement");
    if (filename === null || id === null) throw new Error("reviewed ordinary transform lacks filename/id");
    if (
      (method !== "replace" && method !== "replaceAll") ||
      owner === null ||
      pattern === null ||
      receiverRoot === null ||
      replacement === null
    ) {
      throw new Error(`reviewed transform ${id} lacks a static call-shape field`);
    }
    rows.push({ filename, id, method, owner, pattern, receiverRoot, replacement });
  }
  if (new Set(rows.map((row) => row.id)).size !== rows.length) {
    throw new Error("duplicate reviewed ordinary transform id");
  }
  return rows;
}

function ordinaryCallSites(row, sourceFile) {
  const sites = [];
  function visit(node) {
    if (ts.isPropertyAccessExpression(node) && node.name.text === row.method) {
      const call = node.parent;
      const pattern = ts.isCallExpression(call) ? call.arguments[0] : undefined;
      const replacement = ts.isCallExpression(call) ? call.arguments[1] : undefined;
      if (
        ts.isCallExpression(call) &&
        call.expression === node &&
        call.arguments.length === 2 &&
        pattern !== undefined &&
        replacement !== undefined &&
        expressionReceiverRoot(node.expression) === row.receiverRoot &&
        pattern.getText(sourceFile) === row.pattern &&
        replacement.getText(sourceFile) === row.replacement
      ) {
        const owner = ordinaryTransformOwner(call);
        sites.push({ callStart: call.getStart(sourceFile), owner: owner?.id ?? "<unowned>" });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return sites;
}

function updateMetaCount() {
  const source = readFileSync(META_PATH, "utf8");
  const observed = exactMutationHelperCallCensus("meta-invariant-coverage.test.ts", source);
  const updated = replaceOne(
    source,
    /(\[\s*"meta-invariant-coverage\.test\.ts",\s*\{\s*count:\s*)\d+(,\s*sha256:\s*"[0-9a-f]{64}"\s*\}\s*\])/gu,
    (_match, prefix, suffix) => `${prefix}${observed.count}${suffix}`,
    "meta helper-call count"
  );
  writeFileSync(META_PATH, updated);
  process.stdout.write(`${JSON.stringify({ metaCallCount: observed.count })}\n`);
}

function updateReleasePreFixture() {
  const releaseSha = sha256(readFileSync(RELEASE_INTEGRITY_PATH));
  const auditSource = replaceOne(
    readFileSync(RELEASE_AUDIT_PATH, "utf8"),
    /const CURRENT_HYBRID_SOURCE_SHA256 = "[0-9a-f]{64}";/gu,
    `const CURRENT_HYBRID_SOURCE_SHA256 = "${releaseSha}";`,
    "current hybrid source pin"
  );
  writeFileSync(RELEASE_AUDIT_PATH, auditSource);
  process.stdout.write(`${JSON.stringify({ releaseIntegritySha256: releaseSha })}\n`);
}

function updateReleasePostFixture() {
  const transitionSha = sha256(readFileSync(TRANSITION_FIXTURE_PATH));
  const metaSource = replaceOne(
    readFileSync(META_PATH, "utf8"),
    /const RELEASE_MUTATION_TRANSITION_FIXTURE_SHA256 = "[0-9a-f]{64}";/gu,
    `const RELEASE_MUTATION_TRANSITION_FIXTURE_SHA256 = "${transitionSha}";`,
    "transition fixture meta pin"
  );
  writeFileSync(META_PATH, metaSource);
  const changelogSource = replaceOne(
    readFileSync("CHANGELOG.md", "utf8"),
    /transition v3 at SHA-256 `[0-9a-f]{64}`/gu,
    `transition v3 at SHA-256 \`${transitionSha}\``,
    "transition fixture changelog pin"
  );
  writeFileSync("CHANGELOG.md", changelogSource);
  process.stdout.write(`${JSON.stringify({ transitionFixtureSha256: transitionSha })}\n`);
}

function updateIdentityHashes() {
  let metaSource = readFileSync(META_PATH, "utf8");
  const parsedMeta = ts.createSourceFile(META_PATH, metaSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const callCensuses = {};
  for (const filename of callCensusFilenames(parsedMeta)) {
    const source = filename === "meta-invariant-coverage.test.ts" ? metaSource : readFileSync(`tests/${filename}`, "utf8");
    const observed = exactMutationHelperCallCensus(filename, source);
    callCensuses[filename] = observed;
    const filenamePattern = escapeRegex(JSON.stringify(filename));
    metaSource = replaceOne(
      metaSource,
      new RegExp(
        `(\\[\\s*${filenamePattern},\\s*\\{\\s*count:\\s*[^,]+,\\s*sha256:\\s*")[0-9a-f]{64}("\\s*\\}\\s*\\])`,
        "gu"
      ),
      (_match, prefix, suffix) => `${prefix}${observed.sha256}${suffix}`,
      `${filename} helper-call digest`
    );
  }

  const ordinaryOwners = {};
  const claimedOrdinarySites = new Set();
  for (const row of ordinaryOwnerRows(parsedMeta)) {
    const { filename, id, owner } = row;
    const source = readFileSync(`tests/${filename}`, "utf8");
    const sourceFile = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const observedSites = ordinaryCallSites(row, sourceFile);
    const declaredOwnerSites = observedSites.filter((site) => site.owner === owner);
    if (declaredOwnerSites.length !== 1) {
      const observedSiteSummary = JSON.stringify(observedSites);
      throw new Error(
        `${id}: expected one exact call owned by ${owner}, found ${declaredOwnerSites.length}; all shape-matched sites ${observedSiteSummary}`
      );
    }
    const siteKey = `${filename}:${declaredOwnerSites[0].callStart}`;
    if (claimedOrdinarySites.has(siteKey)) {
      throw new Error(`${id}: exact ordinary-transform site ${siteKey} is already claimed`);
    }
    claimedOrdinarySites.add(siteKey);
    const observed = sourceOwnerSha256(owner, sourceFile, sourceFile);
    ordinaryOwners[id] = { filename, owner, sha256: observed };
    const idPattern = escapeRegex(JSON.stringify(id));
    metaSource = replaceOne(
      metaSource,
      new RegExp(`(\\[\\s*${idPattern},\\s*")[0-9a-f]{64}("\\s*\\])`, "gu"),
      (_match, prefix, suffix) => `${prefix}${observed}${suffix}`,
      `${id} ordinary-owner digest`
    );
  }

  const zeroCarrier = "0".repeat(64);
  if (metaSource.includes(zeroCarrier)) throw new Error("zero identity carrier remains after capture");
  writeFileSync(META_PATH, metaSource);
  process.stdout.write(
    `${JSON.stringify(
      {
        callCensuses,
        ordinaryOwners,
        releaseAuditSha256: sha256(readFileSync(RELEASE_AUDIT_PATH)),
        releaseIntegritySha256: sha256(readFileSync(RELEASE_INTEGRITY_PATH)),
        transitionFixtureSha256: sha256(readFileSync(TRANSITION_FIXTURE_PATH))
      },
      null,
      2
    )}\n`
  );
}

const mode = process.argv[2];
if (mode === "count") updateMetaCount();
else if (mode === "release-pre") updateReleasePreFixture();
else if (mode === "release-post") updateReleasePostFixture();
else if (mode === "hashes") updateIdentityHashes();
else throw new Error("usage: capture-raw-mutation-identities.mjs count|release-pre|release-post|hashes");
