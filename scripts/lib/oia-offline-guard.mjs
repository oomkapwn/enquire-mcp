// Pure structural analyzer for OIA Check 4f.
//
// TypeScript's parser deliberately excludes comments from the AST. That makes
// these checks resistant to a documented `setEmbeddingsOffline()` /
// `applyOfflineEnv()` mention being mistaken for executable enforcement. A
// direct-statement requirement also rejects conditional runtime guards, while
// source positions prove the guard runs before the model/query path.

import ts from "typescript";

const RUNTIME_PATHS = {
  serve: "startServer",
  "serve-http": "startHttpServer",
  query: "searchHybrid",
  eval: "runEval"
};

function parse(source, fileName) {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function visit(node, callback) {
  callback(node);
  node.forEachChild((child) => visit(child, callback));
}

function callName(node) {
  if (!ts.isCallExpression(node)) return undefined;
  if (ts.isIdentifier(node.expression)) return node.expression.text;
  if (ts.isPropertyAccessExpression(node.expression)) return node.expression.name.text;
  return undefined;
}

function isIdentifierCall(node, name) {
  return ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name;
}

function isOfflineEnableCall(node) {
  if (!isIdentifierCall(node, "setEmbeddingsOffline")) return false;
  if (node.arguments.length === 0) return true;
  return node.arguments.length === 1 && unwrapParentheses(node.arguments[0]).kind === ts.SyntaxKind.TrueKeyword;
}

function firstIdentifierCall(node, name) {
  let found;
  visit(node, (candidate) => {
    if (!found && isIdentifierCall(candidate, name)) found = candidate;
  });
  return found;
}

function directCall(block, name) {
  if (!ts.isBlock(block)) return undefined;
  for (const statement of block.statements) {
    if (ts.isExpressionStatement(statement) && isIdentifierCall(statement.expression, name)) {
      return statement.expression;
    }
  }
  return undefined;
}

function directOfflineEnableCall(block) {
  if (!ts.isBlock(block)) return undefined;
  for (const statement of block.statements) {
    if (ts.isExpressionStatement(statement) && isOfflineEnableCall(statement.expression)) {
      return statement.expression;
    }
  }
  return undefined;
}

function findFunction(sourceFile, name) {
  let found;
  visit(sourceFile, (node) => {
    if (!found && ts.isFunctionDeclaration(node) && node.name?.text === name) found = node;
  });
  return found;
}

function hasOfflineSetterImport(sourceFile) {
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "./embeddings.js"
    ) {
      continue;
    }
    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) {
      continue;
    }
    for (const specifier of clause.namedBindings.elements) {
      const importedName = specifier.propertyName?.text ?? specifier.name.text;
      if (!specifier.isTypeOnly && importedName === "setEmbeddingsOffline" && specifier.name.text === importedName) {
        return true;
      }
    }
  }
  return false;
}

function bindingNameContains(node, name) {
  if (ts.isIdentifier(node)) return node.text === name;
  if (ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node)) {
    return node.elements.some((element) => ts.isBindingElement(element) && bindingNameContains(element.name, name));
  }
  return false;
}

function isCanonicalOfflineImportSpecifier(node) {
  if (
    !ts.isImportSpecifier(node) ||
    node.isTypeOnly ||
    node.name.text !== "setEmbeddingsOffline" ||
    (node.propertyName?.text ?? node.name.text) !== "setEmbeddingsOffline"
  ) {
    return false;
  }
  let parent = node.parent;
  while (parent && !ts.isImportDeclaration(parent) && !ts.isSourceFile(parent)) parent = parent.parent;
  return (
    ts.isImportDeclaration(parent) &&
    !parent.importClause?.isTypeOnly &&
    ts.isStringLiteral(parent.moduleSpecifier) &&
    parent.moduleSpecifier.text === "./embeddings.js"
  );
}

function hasOfflineSetterValueShadow(sourceFile) {
  let shadowed = false;
  visit(sourceFile, (node) => {
    if (shadowed) return;
    if (ts.isImportSpecifier(node) && node.name.text === "setEmbeddingsOffline") {
      shadowed = !isCanonicalOfflineImportSpecifier(node);
      return;
    }
    if (
      (ts.isImportClause(node) || ts.isNamespaceImport(node) || ts.isImportEqualsDeclaration(node)) &&
      node.name?.text === "setEmbeddingsOffline"
    ) {
      shadowed = true;
      return;
    }
    if (
      (ts.isVariableDeclaration(node) || ts.isParameter(node)) &&
      bindingNameContains(node.name, "setEmbeddingsOffline")
    ) {
      shadowed = true;
      return;
    }
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isClassDeclaration(node) ||
        ts.isClassExpression(node) ||
        ts.isEnumDeclaration(node) ||
        ts.isModuleDeclaration(node)) &&
      node.name?.text === "setEmbeddingsOffline"
    ) {
      shadowed = true;
      return;
    }
    if (
      ts.isCatchClause(node) &&
      node.variableDeclaration &&
      bindingNameContains(node.variableDeclaration.name, "setEmbeddingsOffline")
    ) {
      shadowed = true;
    }
  });
  return shadowed;
}

function isExported(node) {
  return node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true;
}

function identifierNames(node) {
  const names = new Set();
  visit(node, (candidate) => {
    if (ts.isIdentifier(candidate)) names.add(candidate.text);
  });
  return names;
}

function unwrapParentheses(node) {
  let current = node;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

function isTruthyCondition(node, identifiers) {
  const expression = unwrapParentheses(node);
  if (identifiers.length === 1) {
    return ts.isIdentifier(expression) && expression.text === identifiers[0];
  }
  if (
    identifiers.length !== 2 ||
    !ts.isBinaryExpression(expression) ||
    expression.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken
  ) {
    return false;
  }
  const left = unwrapParentheses(expression.left);
  const right = unwrapParentheses(expression.right);
  if (!ts.isIdentifier(left) || !ts.isIdentifier(right)) return false;
  return (
    new Set([left.text, right.text]).size === 2 &&
    identifiers.every((name) => left.text === name || right.text === name)
  );
}

function isApplyOfflineCall(node) {
  return (
    isIdentifierCall(node, "applyOfflineEnv") &&
    ts.isIdentifier(node.arguments[0]) &&
    node.arguments[0].text === "transformersModule"
  );
}

function conditionalApplyCall(statement) {
  if (!ts.isIfStatement(statement) || !isTruthyCondition(statement.expression, ["transformersModule"])) {
    return undefined;
  }
  if (ts.isExpressionStatement(statement.thenStatement) && isApplyOfflineCall(statement.thenStatement.expression)) {
    return statement.thenStatement.expression;
  }
  if (ts.isBlock(statement.thenStatement)) {
    const call = directCall(statement.thenStatement, "applyOfflineEnv");
    return call && isApplyOfflineCall(call) ? call : undefined;
  }
  return undefined;
}

function cachedBranchGuard(sourceFile, functionName, conditionIdentifiers, returnIdentifiers) {
  const fn = findFunction(sourceFile, functionName);
  if (!fn?.body) return false;
  let branch;
  visit(fn.body, (node) => {
    if (branch || !ts.isIfStatement(node)) return;
    if (isTruthyCondition(node.expression, conditionIdentifiers)) branch = node.thenStatement;
  });
  if (!branch || !ts.isBlock(branch)) return false;

  let guard;
  let guardedReturn;
  for (const statement of branch.statements) {
    if (!guard) guard = conditionalApplyCall(statement);
    if (!guardedReturn && ts.isReturnStatement(statement) && statement.expression) {
      const returnedNames = identifierNames(statement.expression);
      if (returnIdentifiers.every((name) => returnedNames.has(name))) {
        guardedReturn = statement;
      }
    }
  }
  return Boolean(guard && guardedReturn && guard.getStart(sourceFile) < guardedReturn.getStart(sourceFile));
}

function orderedFunctionBoundary(sourceFile, functionName, pathName) {
  if (!hasOfflineSetterImport(sourceFile) || hasOfflineSetterValueShadow(sourceFile)) return false;
  const fn = findFunction(sourceFile, functionName);
  if (!fn?.body) return false;
  const guard = directOfflineEnableCall(fn.body);
  const path = firstIdentifierCall(fn.body, pathName);
  return Boolean(guard && path && guard.getStart(sourceFile) < path.getStart(sourceFile));
}

function runtimeActionStatus(cliSourceFile) {
  const commandStarts = [];
  visit(cliSourceFile, (node) => {
    if (callName(node) !== "command" || !ts.isCallExpression(node)) return;
    const command = node.arguments[0];
    if (!ts.isStringLiteralLike(command)) return;
    commandStarts.push({ command: command.text, start: node.getStart(cliSourceFile) });
  });
  commandStarts.sort((a, b) => a.start - b.start);

  const status = {};
  for (const [command, pathName] of Object.entries(RUNTIME_PATHS)) {
    const position = commandStarts.findIndex((entry) => entry.command === command);
    if (position < 0) {
      status[command] = false;
      continue;
    }
    const start = commandStarts[position].start;
    const end = commandStarts[position + 1]?.start ?? cliSourceFile.end;
    let callback;
    visit(cliSourceFile, (node) => {
      if (callback || node.getStart(cliSourceFile) < start || node.end > end) return;
      if (callName(node) !== "action" || !ts.isCallExpression(node)) return;
      const candidate = node.arguments.find(
        (argument) => ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)
      );
      if (candidate) callback = candidate;
    });
    if (!callback || !hasOfflineSetterImport(cliSourceFile) || hasOfflineSetterValueShadow(cliSourceFile)) {
      status[command] = false;
      continue;
    }
    const guard = directOfflineEnableCall(callback.body);
    const path = firstIdentifierCall(callback, pathName);
    status[command] = Boolean(guard && path && guard.getStart(cliSourceFile) < path.getStart(cliSourceFile));
  }
  return status;
}

function hasRemoteOffAssignment(embSourceFile) {
  const fn = findFunction(embSourceFile, "applyOfflineEnv");
  if (!fn?.body) return false;
  let found = false;
  visit(fn.body, (node) => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      ts.isIdentifier(node.left.expression) &&
      node.left.expression.text === "env" &&
      node.left.name.text === "allowRemoteModels" &&
      node.right.kind === ts.SyntaxKind.FalseKeyword
    ) {
      found = true;
    }
  });
  return found;
}

/**
 * Inspect the executable TypeScript structure that backs the runtime offline
 * guarantee.
 *
 * @param {{ embSrc: string, cliSrc: string, serverSrc: string }} sources
 * @returns {{
 *   remoteOff: boolean,
 *   setterExported: boolean,
 *   serverBoundary: boolean,
 *   buildServerBoundary: boolean,
 *   cachedPipelineGuard: boolean,
 *   cachedRerankerGuard: boolean,
 *   runtimeActions: Record<string, boolean>,
 *   missingRuntimeActions: string[]
 * }}
 */
export function inspectEmbeddingsOfflineGuards({ embSrc, cliSrc, serverSrc }) {
  const embSourceFile = parse(embSrc, "src/embeddings.ts");
  const cliSourceFile = parse(cliSrc, "src/cli.ts");
  const serverSourceFile = parse(serverSrc, "src/server.ts");
  const setter = findFunction(embSourceFile, "setEmbeddingsOffline");
  const runtimeActions = runtimeActionStatus(cliSourceFile);

  return {
    remoteOff: hasRemoteOffAssignment(embSourceFile),
    setterExported: Boolean(setter && isExported(setter)),
    serverBoundary: orderedFunctionBoundary(serverSourceFile, "prepareServerDeps", "loadEmbedder"),
    buildServerBoundary: orderedFunctionBoundary(serverSourceFile, "buildMcpServer", "registerReadTools"),
    cachedPipelineGuard: cachedBranchGuard(embSourceFile, "loadPipeline", ["pipelineCtor"], ["pipelineCtor"]),
    cachedRerankerGuard: cachedBranchGuard(
      embSourceFile,
      "loadTransformersForRerank",
      ["autoTokenizerCtor", "autoModelForSeqClsCtor"],
      ["autoTokenizerCtor", "autoModelForSeqClsCtor"]
    ),
    runtimeActions,
    missingRuntimeActions: Object.entries(runtimeActions)
      .filter(([, guarded]) => !guarded)
      .map(([command]) => command)
  };
}
