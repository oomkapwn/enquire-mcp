// v3.12.0-rc.25 S-8c — the filesystem watcher starts before the optional
// embedding model and HNSW snapshot are ready. During that boot window it must
// capture paths, then cross one activation barrier only after every late-bound
// sink has been attached. Otherwise an edit can land in FTS5 but be absent from
// EmbedDb/HNSW for the lifetime of the server.
//
// `src/server.ts` is intentionally checked as source instead of value-imported
// (it is a restricted integration root). The pure AST predicate below is also
// exercised with positive and NEGATIVE synthetic controls so the ordering
// invariant cannot pass vacuously.

import { readFileSync } from "node:fs";
import * as path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "..");

interface WatcherCall {
  call: ts.CallExpression;
  position: number;
}

type WatcherMethod =
  | "start"
  | "attachEmbed"
  | "captureAttachedSinkDrift"
  | "setOcrPdfs"
  | "attachHnsw"
  | "activate"
  | "close";

/** Return true only for the nullable-watcher existence guards under which
 * activation is still unconditional whenever a production watcher exists. */
function isWatcherExistenceGuard(expression: ts.Expression, sourceFile: ts.SourceFile): boolean {
  const compact = expression.getText(sourceFile).replace(/\s+/g, "");
  return ["watcher", "watcher!==null", "watcher!=null", "null!==watcher", "null!=watcher"].includes(compact);
}

/** Whether `node` is within `container`, based on source spans. */
function isWithin(node: ts.Node, container: ts.Node): boolean {
  return node.pos >= container.pos && node.end <= container.end;
}

/** Find the production dependency-preparation function in a source file. */
function findFunction(
  sourceFile: ts.SourceFile,
  name: string
): ts.FunctionDeclaration | undefined {
  return sourceFile.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name
  );
}

/** Find the production dependency-preparation function in a source file. */
function findPrepareServerDeps(sourceFile: ts.SourceFile): ts.FunctionDeclaration | undefined {
  return findFunction(sourceFile, "prepareServerDeps");
}

/** Collect direct watcher method calls while ignoring nested function bodies. */
function collectWatcherCalls(
  fn: ts.FunctionDeclaration,
  sourceFile: ts.SourceFile,
  method: WatcherMethod
): WatcherCall[] {
  const calls: WatcherCall[] = [];
  const visit = (node: ts.Node): void => {
    if (node !== fn.body && ts.isFunctionLike(node)) return;
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "watcher" &&
      node.expression.name.text === method
    ) {
      calls.push({ call: node, position: node.getStart(sourceFile) });
    }
    ts.forEachChild(node, visit);
  };
  if (fn.body) visit(fn.body);
  return calls;
}

/** Collect direct calls to one imported lifecycle helper. */
function collectIdentifierCalls(
  fn: ts.FunctionDeclaration,
  sourceFile: ts.SourceFile,
  functionName: string
): WatcherCall[] {
  const calls: WatcherCall[] = [];
  const visit = (node: ts.Node): void => {
    if (node !== fn.body && ts.isFunctionLike(node)) return;
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === functionName
    ) {
      calls.push({ call: node, position: node.getStart(sourceFile) });
    }
    ts.forEachChild(node, visit);
  };
  if (fn.body) visit(fn.body);
  return calls;
}

/** A direct `await watcher.method()` call, not a fire-and-forget promise. */
function isDirectlyAwaited(call: ts.CallExpression): boolean {
  return ts.isAwaitExpression(call.parent) && call.parent.expression === call;
}

/** Whether a call's result is awaited directly or through a chained promise. */
function isAwaitedWithin(call: ts.CallExpression, boundary: ts.Node): boolean {
  for (let parent = call.parent; parent && parent !== boundary; parent = parent.parent) {
    if (ts.isAwaitExpression(parent)) return true;
  }
  return false;
}

/** Find the nearest try whose successful try block contains `node`. */
function findContainingTryBlock(node: ts.Node, boundary: ts.Node): ts.TryStatement | undefined {
  for (let parent = node.parent; parent && parent !== boundary; parent = parent.parent) {
    if (ts.isTryStatement(parent) && isWithin(node, parent.tryBlock)) return parent;
  }
  return undefined;
}

/** Catch/finally are failure-only paths and may never release the guard. */
function isWithinCatchOrFinally(node: ts.Node, boundary: ts.Node): boolean {
  for (let parent = node.parent; parent && parent !== boundary; parent = parent.parent) {
    if (ts.isCatchClause(parent)) return true;
    if (ts.isTryStatement(parent) && parent.finallyBlock && isWithin(node, parent.finallyBlock)) {
      return true;
    }
  }
  return false;
}

/** Directly rethrow the caught error, optionally wrapped in the recovery diagnostic. */
function isActivationRecoveryRethrow(statement: ts.ThrowStatement, caughtName: string): boolean {
  const expression = statement.expression;
  if (!expression) return false;
  if (ts.isIdentifier(expression)) return expression.text === caughtName;
  if (!ts.isCallExpression(expression)) return false;
  const argument = expression.arguments[0];
  return (
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "watcherActivationRecoveryError" &&
    expression.arguments.length === 1 &&
    argument !== undefined &&
    ts.isIdentifier(argument) &&
    argument.text === caughtName
  );
}

/**
 * Report startup-order violations for a `prepareServerDeps`-shaped source.
 * Empty means the watcher is capture-first and crosses exactly one barrier
 * after every late attachment, before any prepared dependency can escape.
 */
function watcherStartupOrderViolations(source: string): string[] {
  const sourceFile = ts.createSourceFile("server.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const fn = findPrepareServerDeps(sourceFile);
  if (!fn?.body) return ["prepareServerDeps function is missing"];

  const violations: string[] = [];
  const constructors: ts.NewExpression[] = [];
  const resourceAcquisitionPositions: number[] = [];
  const feedbackDeclarations: ts.VariableDeclaration[] = [];
  const returns: ts.ReturnStatement[] = [];

  const visit = (node: ts.Node): void => {
    if (node !== fn.body && ts.isFunctionLike(node)) return;
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "VaultWatcher"
    ) {
      constructors.push(node);
    }
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      ["FtsIndex", "VaultWatcher", "EmbedDb"].includes(node.expression.text)
    ) {
      resourceAcquisitionPositions.push(node.getStart(sourceFile));
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "feedbackStore") {
      feedbackDeclarations.push(node);
    }
    if (ts.isReturnStatement(node)) returns.push(node);
    ts.forEachChild(node, visit);
  };
  visit(fn.body);

  if (constructors.length !== 1) {
    violations.push(`expected exactly one production VaultWatcher constructor, found ${constructors.length}`);
  }
  const constructor = constructors[0];
  if (constructor) {
    const options = constructor.arguments?.[0];
    const deferred =
      options &&
      ts.isObjectLiteralExpression(options) &&
      options.properties.some(
        (property) =>
          ts.isPropertyAssignment(property) &&
          ((ts.isIdentifier(property.name) && property.name.text === "deferActivation") ||
            (ts.isStringLiteral(property.name) && property.name.text === "deferActivation")) &&
          property.initializer.kind === ts.SyntaxKind.TrueKeyword
      );
    if (!deferred) violations.push("production VaultWatcher must set deferActivation: true");
  }

  const starts = collectWatcherCalls(fn, sourceFile, "start");
  const attachEmbed = collectWatcherCalls(fn, sourceFile, "attachEmbed");
  const captureAttachedSinkDrift = collectWatcherCalls(fn, sourceFile, "captureAttachedSinkDrift");
  const setOcrPdfs = collectWatcherCalls(fn, sourceFile, "setOcrPdfs");
  const attachHnsw = collectWatcherCalls(fn, sourceFile, "attachHnsw");
  const activations = collectWatcherCalls(fn, sourceFile, "activate");
  const watcherCloses = collectWatcherCalls(fn, sourceFile, "close");
  const guardClearChecks = collectIdentifierCalls(fn, sourceFile, "assertWatcherActivationGuardClear");
  const guardArms = collectIdentifierCalls(fn, sourceFile, "armWatcherActivationGuard");
  const guardReleases = collectIdentifierCalls(fn, sourceFile, "releaseWatcherActivationGuard");
  const hnswAcquisitionPositions = [
    ...collectIdentifierCalls(fn, sourceFile, "loadHnswFromDisk").map(({ position }) => position),
    ...collectIdentifierCalls(fn, sourceFile, "buildHnsw").map(({ position }) => position)
  ];
  resourceAcquisitionPositions.push(...hnswAcquisitionPositions);

  if (starts.length !== 1) violations.push(`expected exactly one watcher.start() call, found ${starts.length}`);
  const start = starts[0];
  if (start && !isDirectlyAwaited(start.call)) violations.push("watcher.start() must be directly awaited");
  if (guardClearChecks.length !== 1) {
    violations.push(`expected exactly one activation-guard clear assertion, found ${guardClearChecks.length}`);
  }
  const guardClear = guardClearChecks[0];
  if (guardClear && !isDirectlyAwaited(guardClear.call)) {
    violations.push("assertWatcherActivationGuardClear() must be directly awaited");
  }
  if (
    guardClear &&
    resourceAcquisitionPositions.some((position) => position <= guardClear.position)
  ) {
    violations.push("activation guard must be asserted clear before FTS/watcher/HNSW acquisition");
  }
  if (guardArms.length !== 1) {
    violations.push(`expected exactly one activation-guard arm, found ${guardArms.length}`);
  }
  const guardArm = guardArms[0];
  if (guardArm && !isDirectlyAwaited(guardArm.call)) {
    violations.push("armWatcherActivationGuard() must be directly awaited");
  }
  if (guardArm && start && guardArm.position >= start.position) {
    violations.push("activation guard must be armed before watcher.start()");
  }
  if (guardArm && isWithinCatchOrFinally(guardArm.call, fn)) {
    violations.push("activation guard arm must stay on the watcher startup success path");
  }
  if (attachEmbed.length === 0) violations.push("watcher.attachEmbed() branch is missing");
  if (captureAttachedSinkDrift.length !== 1) {
    violations.push(
      `expected exactly one watcher.captureAttachedSinkDrift() call, found ${captureAttachedSinkDrift.length}`
    );
  }
  const driftCapture = captureAttachedSinkDrift[0];
  if (driftCapture && !isDirectlyAwaited(driftCapture.call)) {
    violations.push("watcher.captureAttachedSinkDrift() must be directly awaited");
  }
  if (driftCapture && isWithinCatchOrFinally(driftCapture.call, fn)) {
    violations.push("watcher.captureAttachedSinkDrift() must stay on the watcher startup success path");
  }
  if (setOcrPdfs.length === 0) violations.push("watcher.setOcrPdfs() branch is missing");
  if (attachHnsw.length === 0) violations.push("watcher.attachHnsw() branch is missing");
  if (activations.length !== 1) {
    violations.push(`expected exactly one watcher.activate() barrier, found ${activations.length}`);
  }

  const activation = activations[0];
  const activationTry = activation ? findContainingTryBlock(activation.call, fn) : undefined;
  if (activation && !isDirectlyAwaited(activation.call)) {
    violations.push("watcher.activate() must be directly awaited");
  }
  if (guardReleases.length !== 1) {
    violations.push(`expected exactly one activation-guard release, found ${guardReleases.length}`);
  }
  const guardRelease = guardReleases[0];
  if (guardRelease && !isDirectlyAwaited(guardRelease.call)) {
    violations.push("releaseWatcherActivationGuard() must be directly awaited");
  }

  if (constructor && start && constructor.getStart(sourceFile) >= start.position) {
    violations.push("VaultWatcher must be constructed before watcher.start()");
  }
  if (
    driftCapture &&
    attachEmbed.some(({ position }) => position >= driftCapture.position)
  ) {
    violations.push("watcher.captureAttachedSinkDrift() must run after watcher.attachEmbed()");
  }
  if (driftCapture && start && driftCapture.position <= start.position) {
    violations.push("watcher.captureAttachedSinkDrift() must run after awaited watcher.start()");
  }
  if (
    driftCapture &&
    hnswAcquisitionPositions.some((position) => position <= driftCapture.position)
  ) {
    violations.push("watcher.captureAttachedSinkDrift() must run before HNSW load/build");
  }
  if (driftCapture && activation && driftCapture.position >= activation.position) {
    violations.push("watcher.captureAttachedSinkDrift() must run before watcher.activate()");
  }
  const attachments = [...attachEmbed, ...setOcrPdfs, ...attachHnsw];
  if (start) {
    for (const attachment of attachments) {
      if (attachment.position <= start.position) {
        violations.push("watcher.start() must run before every late attachment");
        break;
      }
    }
  }
  if (activation) {
    if (start) {
      for (const [callName, calls] of [
        ["syncFtsIndex", collectIdentifierCalls(fn, sourceFile, "syncFtsIndex")],
        ["syncPdfFtsIndex", collectIdentifierCalls(fn, sourceFile, "syncPdfFtsIndex")]
      ] as const) {
        const postReady = calls.filter(({ position }) => position > start.position);
        if (postReady.length !== 1) {
          violations.push(
            `expected exactly one post-ready ${callName} reconciliation before activation, found ${postReady.length}`
          );
        } else if (postReady[0]) {
          if (postReady[0].position >= activation.position) {
            violations.push(`post-ready ${callName} reconciliation must run before watcher.activate()`);
          }
          if (!isDirectlyAwaited(postReady[0].call)) {
            violations.push(`post-ready ${callName} reconciliation must be directly awaited`);
          }
          if (isWithinCatchOrFinally(postReady[0].call, fn)) {
            violations.push(`post-ready ${callName} reconciliation must stay on the startup success path`);
          }
        }
      }
    }
    for (const attachment of attachments) {
      if (attachment.position >= activation.position) {
        violations.push(
          "watcher.activate() must run after every attachEmbed()/setOcrPdfs()/attachHnsw() branch"
        );
        break;
      }
    }

    // The only permitted conditional ancestor is the unavoidable null guard:
    // `if (watcher) await watcher.activate()`. In particular, activation must
    // not be trapped inside `if (opts.useHnsw)`, an error/catch path, a loop,
    // or a ternary branch.
    for (let parent = activation.call.parent; parent && parent !== fn; parent = parent.parent) {
      if (ts.isIfStatement(parent)) {
        if (
          !isWithin(activation.call, parent.thenStatement) ||
          !isWatcherExistenceGuard(parent.expression, sourceFile)
        ) {
          violations.push("watcher.activate() is conditionally gated beyond watcher existence");
          break;
        }
      }
      if (
        ts.isCatchClause(parent) ||
        ts.isConditionalExpression(parent) ||
        ts.isSwitchStatement(parent) ||
        ts.isCaseClause(parent) ||
        ts.isDefaultClause(parent) ||
        ts.isIterationStatement(parent, false)
      ) {
        violations.push("watcher.activate() is not on the unconditional startup path");
        break;
      }
    }

    const failureCatch = activationTry?.catchClause;
    if (!failureCatch) {
      violations.push("watcher.activate() failure must be cleaned up and rethrown");
    } else {
      const caughtName =
        failureCatch.variableDeclaration && ts.isIdentifier(failureCatch.variableDeclaration.name)
          ? failureCatch.variableDeclaration.name.text
          : null;
      const closeCalls: WatcherCall[] = [];
      const throws: ts.ThrowStatement[] = [];
      const visitFailurePath = (node: ts.Node): void => {
        if (node !== failureCatch.block && ts.isFunctionLike(node)) return;
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === "watcher" &&
          node.expression.name.text === "close"
        ) {
          closeCalls.push({ call: node, position: node.getStart(sourceFile) });
        }
        if (ts.isThrowStatement(node)) throws.push(node);
        ts.forEachChild(node, visitFailurePath);
      };
      visitFailurePath(failureCatch.block);

      const rethrow = caughtName
        ? throws.find(
            (statement) =>
              statement.parent === failureCatch.block &&
              isActivationRecoveryRethrow(statement, caughtName)
          )
        : undefined;
      if (!rethrow) {
        violations.push("watcher.activate() failure must rethrow the caught error after cleanup");
      } else {
        const rethrowPosition = rethrow.getStart(sourceFile);
        const cleanupCompleted = closeCalls.some(
          ({ call, position }) =>
            position < rethrowPosition && isAwaitedWithin(call, failureCatch.block)
        );
        if (!cleanupCompleted) {
          violations.push(
            "watcher.close() cleanup must complete before activation failure is rethrown"
          );
        }
      }
    }

    if (guardRelease) {
      if (guardRelease.position <= activation.position) {
        violations.push("activation guard release must run after awaited watcher.activate()");
      }
      const releaseTry = findContainingTryBlock(guardRelease.call, fn);
      if (
        !activationTry ||
        releaseTry !== activationTry ||
        isWithinCatchOrFinally(guardRelease.call, fn)
      ) {
        violations.push(
          "activation guard release must stay on watcher.activate() successful try path"
        );
      }
      if (
        activationTry &&
        watcherCloses.some(
          ({ call, position }) =>
            position < guardRelease.position && isWithin(call, activationTry.tryBlock)
        )
      ) {
        violations.push("activation guard release may not run after watcher.close()");
      }
    }

    if (feedbackDeclarations.length !== 1) {
      violations.push(`expected exactly one feedbackStore declaration, found ${feedbackDeclarations.length}`);
    } else if ((feedbackDeclarations[0]?.getStart(sourceFile) ?? -1) <= activation.position) {
      violations.push("feedbackStore must open only after watcher.activate()");
    }
    if (returns.length === 0) {
      violations.push("prepareServerDeps return is missing");
    } else if (returns.some((statement) => statement.getStart(sourceFile) <= activation.position)) {
      violations.push("watcher.activate() must run before every prepareServerDeps return");
    }
    if (guardRelease) {
      if (
        feedbackDeclarations.length === 1 &&
        (feedbackDeclarations[0]?.getStart(sourceFile) ?? -1) <= guardRelease.position
      ) {
        violations.push("feedbackStore must open only after activation guard release");
      }
      if (returns.some((statement) => statement.getStart(sourceFile) <= guardRelease.position)) {
        violations.push("activation guard release must run before every prepareServerDeps return");
      }
    }
  }

  return violations;
}

/**
 * Guard the frozen per-generation EmbedDb capability across preparation and
 * cheap per-session server construction.
 */
function frozenEmbedCapabilityViolations(source: string): string[] {
  const sourceFile = ts.createSourceFile("server.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const prepare = findPrepareServerDeps(sourceFile);
  const build = findFunction(sourceFile, "buildMcpServer");
  const violations: string[] = [];
  if (!prepare?.body) return ["prepareServerDeps function is missing"];
  if (!build?.body) return ["buildMcpServer function is missing"];

  const existsCalls = collectIdentifierCalls(prepare, sourceFile, "existsSync");
  if (existsCalls.length !== 1) {
    violations.push(`expected exactly one frozen EmbedDb existsSync snapshot, found ${existsCalls.length}`);
  }
  const existsCall = existsCalls[0]?.call;
  const existsArgument = existsCall?.arguments[0];
  const snapshotDeclaration = existsCall?.parent;
  if (
    !existsCall ||
    !existsArgument ||
    !ts.isIdentifier(existsArgument) ||
    existsArgument.text !== "startupEmbedFile" ||
    !snapshotDeclaration ||
    !ts.isVariableDeclaration(snapshotDeclaration) ||
    snapshotDeclaration.initializer !== existsCall ||
    !ts.isIdentifier(snapshotDeclaration.name) ||
    snapshotDeclaration.name.text !== "startupEmbedDbAvailable"
  ) {
    violations.push(
      "prepareServerDeps must snapshot existsSync(startupEmbedFile) once as startupEmbedDbAvailable"
    );
  }

  const embedDbFileProperties: ts.PropertyAssignment[] = [];
  const visitPrepare = (node: ts.Node): void => {
    if (node !== prepare.body && ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node) && node.expression && ts.isObjectLiteralExpression(node.expression)) {
      const visitReturnExpression = (property: ts.Node): void => {
        if (property !== node.expression && ts.isFunctionLike(property)) return;
        if (
          ts.isPropertyAssignment(property) &&
          ((ts.isIdentifier(property.name) && property.name.text === "embedDbFile") ||
            (ts.isStringLiteral(property.name) && property.name.text === "embedDbFile"))
        ) {
          embedDbFileProperties.push(property);
        }
        ts.forEachChild(property, visitReturnExpression);
      };
      visitReturnExpression(node.expression);
    }
    ts.forEachChild(node, visitPrepare);
  };
  visitPrepare(prepare.body);
  const embedDbFileProperty = embedDbFileProperties[0];
  const frozenReturn = embedDbFileProperty?.initializer;
  if (
    embedDbFileProperties.length !== 1 ||
    !frozenReturn ||
    !ts.isConditionalExpression(frozenReturn) ||
    !ts.isIdentifier(frozenReturn.condition) ||
    frozenReturn.condition.text !== "startupEmbedDbAvailable" ||
    !ts.isIdentifier(frozenReturn.whenTrue) ||
    frozenReturn.whenTrue.text !== "startupEmbedFile" ||
    frozenReturn.whenFalse.kind !== ts.SyntaxKind.NullKeyword
  ) {
    violations.push("prepareServerDeps must return the frozen embedDbFile capability");
  }
  if (embedDbFileProperty) {
    const capabilityObject = embedDbFileProperty.parent;
    const watchConditional = capabilityObject.parent;
    let spread: ts.Node = watchConditional.parent;
    while (ts.isParenthesizedExpression(spread)) spread = spread.parent;
    const returnedObject = spread.parent;
    const watchCondition =
      ts.isConditionalExpression(watchConditional) &&
      watchConditional.whenTrue === capabilityObject &&
      ts.isPropertyAccessExpression(watchConditional.condition) &&
      ts.isIdentifier(watchConditional.condition.expression) &&
      watchConditional.condition.expression.text === "opts" &&
      watchConditional.condition.name.text === "watch";
    const emptyNonWatchBranch =
      ts.isConditionalExpression(watchConditional) &&
      ts.isObjectLiteralExpression(watchConditional.whenFalse) &&
      watchConditional.whenFalse.properties.length === 0;
    if (
      !ts.isObjectLiteralExpression(capabilityObject) ||
      !watchCondition ||
      !emptyNonWatchBranch ||
      !ts.isSpreadAssignment(spread) ||
      (spread.expression !== watchConditional &&
        (!ts.isParenthesizedExpression(spread.expression) ||
          spread.expression.expression !== watchConditional)) ||
      !ts.isObjectLiteralExpression(returnedObject) ||
      spread.parent !== returnedObject ||
      !ts.isReturnStatement(returnedObject.parent)
    ) {
      violations.push("prepareServerDeps must expose embedDbFile only through the opts.watch return spread");
    }
  }

  const registerReadCalls = collectIdentifierCalls(build, sourceFile, "registerReadTools");
  if (registerReadCalls.length !== 1) {
    violations.push(`expected exactly one registerReadTools() call, found ${registerReadCalls.length}`);
  }
  const registerReadCall = registerReadCalls[0]?.call;
  const finalArgument =
    registerReadCall?.arguments[(registerReadCall?.arguments.length ?? 0) - 1];
  if (
    !finalArgument ||
    !ts.isPropertyAccessExpression(finalArgument) ||
    !ts.isIdentifier(finalArgument.expression) ||
    finalArgument.expression.text !== "deps" ||
    finalArgument.name.text !== "embedDbFile"
  ) {
    violations.push("buildMcpServer must forward deps.embedDbFile without a late disk probe");
  }

  return violations;
}

/** Return the variable that directly owns a validation call's initializer. */
function containingVariableDeclaration(
  call: ts.CallExpression,
  boundary: ts.Node
): ts.VariableDeclaration | undefined {
  for (let parent = call.parent; parent && parent !== boundary; parent = parent.parent) {
    if (ts.isVariableDeclaration(parent)) return parent;
    if (ts.isFunctionLike(parent)) return undefined;
  }
  return undefined;
}

/**
 * Keep deterministic watcher/HNSW option validation ahead of the first guard
 * check or resource acquisition. A rejected option must not leave an open
 * vault/index/watcher generation behind.
 */
function startupPureValidationViolations(source: string): string[] {
  const sourceFile = ts.createSourceFile("server.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const fn = findPrepareServerDeps(sourceFile);
  if (!fn?.body) return ["prepareServerDeps function is missing"];

  const violations: string[] = [];
  const acquisitionPositions: number[] = [];
  const includePdfGates: ts.IfStatement[] = [];
  const visit = (node: ts.Node): void => {
    if (node !== fn.body && ts.isFunctionLike(node)) return;
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      ["Vault", "FtsIndex", "VaultWatcher", "EmbedDb"].includes(node.expression.text)
    ) {
      acquisitionPositions.push(node.getStart(sourceFile));
    }
    if (ts.isIfStatement(node)) {
      const condition = node.expression.getText(sourceFile).replace(/\s+/g, "");
      if (
        condition === "opts.watch&&opts.ocrPdfs&&!opts.includePdfs" &&
        node.thenStatement.getText(sourceFile).includes("--ocr-pdfs requires --include-pdfs")
      ) {
        includePdfGates.push(node);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(fn.body);

  acquisitionPositions.push(
    ...collectIdentifierCalls(fn, sourceFile, "loadHnswFromDisk").map(({ position }) => position),
    ...collectIdentifierCalls(fn, sourceFile, "buildHnsw").map(({ position }) => position)
  );
  const guardChecks = collectIdentifierCalls(fn, sourceFile, "assertWatcherActivationGuardClear");
  const guardArms = collectIdentifierCalls(fn, sourceFile, "armWatcherActivationGuard");
  const boundary = Math.min(
    ...acquisitionPositions,
    ...guardChecks.map(({ position }) => position),
    ...guardArms.map(({ position }) => position)
  );
  if (!Number.isFinite(boundary)) {
    violations.push("startup guard/resource boundary is missing");
  }

  if (includePdfGates.length !== 1) {
    violations.push(
      `expected exactly one --watch/--ocr-pdfs/--include-pdfs compatibility gate, found ${includePdfGates.length}`
    );
  } else if (includePdfGates[0] && includePdfGates[0].getStart(sourceFile) >= boundary) {
    violations.push("--ocr-pdfs compatibility validation must run before startup guard/resource acquisition");
  }

  const parseCalls = collectIdentifierCalls(fn, sourceFile, "parsePositiveInt");
  for (const [flag, binding] of [
    ["--late-chunk-context", "validatedLateChunkContext"],
    ["--ocr-max-pages", "validatedOcrMaxPages"],
    ["--hnsw-ef", "validatedHnswEf"]
  ] as const) {
    const matching = parseCalls.filter(({ call }) => {
      const flagArgument = call.arguments[1];
      return flagArgument !== undefined && ts.isStringLiteralLike(flagArgument) && flagArgument.text === flag;
    });
    if (matching.length !== 1) {
      violations.push(`expected exactly one early ${flag} validation, found ${matching.length}`);
      continue;
    }
    const validation = matching[0];
    const declaration = validation
      ? containingVariableDeclaration(validation.call, fn)
      : undefined;
    if (!declaration || !ts.isIdentifier(declaration.name) || declaration.name.text !== binding) {
      violations.push(`${flag} validation must initialize ${binding}`);
    }
    if (validation && validation.position >= boundary) {
      violations.push(`${flag} validation must run before startup guard/resource acquisition`);
    }
  }

  return violations;
}

const REQUIRED_PURE_VALIDATION_BLOCK = `  if (opts.watch && opts.ocrPdfs && !opts.includePdfs) {
    throw new Error("enquire: --ocr-pdfs requires --include-pdfs when --watch is enabled");
  }
  const validatedLateChunkContext =
    opts.watch && opts.lateChunkContext !== undefined
      ? parsePositiveInt(opts.lateChunkContext, "--late-chunk-context")
      : 0;
  const validatedOcrMaxPages =
    opts.watch && opts.ocrPdfs && opts.ocrMaxPages !== undefined
      ? parsePositiveInt(opts.ocrMaxPages, "--ocr-max-pages")
      : undefined;
  const validatedHnswEf =
    opts.useHnsw && opts.hnswEf !== undefined
      ? parsePositiveInt(opts.hnswEf, "--hnsw-ef")
      : undefined;
`;

const GOOD_STARTUP = `
export async function prepareServerDeps(opts) {
${REQUIRED_PURE_VALIDATION_BLOCK}
  let watcher = null;
  let watcherActivationGuard = null;
  await assertWatcherActivationGuardClear(embedFile);
  const startupEmbedDbAvailable = existsSync(embedFile);
  if (opts.watch) {
    watcher = new VaultWatcher({ vault, ftsIndex, deferActivation: true });
    if (startupEmbedDbAvailable) {
      watcherActivationGuard = await armWatcherActivationGuard(embedFile);
    }
    await watcher.start();
    if (ftsIndex) {
      await syncFtsIndex(vault, ftsIndex);
      if (opts.includePdfs) {
        await syncPdfFtsIndex(vault, ftsIndex);
      }
    }
    try {
      watcher.attachEmbed(embedDb, embedder, 0);
      if (opts.ocrPdfs) {
        watcher.setOcrPdfs(true, opts.ocrLangs);
      }
    } catch (error) {
      warn(error);
    }
    await watcher.captureAttachedSinkDrift();
  }
  if (opts.useHnsw) {
    if (loaded && watcher) {
      watcher.attachHnsw(loaded.index, loaded.rows);
    } else if (watcher) {
      watcher.attachHnsw(index, rows);
    }
  }
  if (watcher) {
    try {
      await watcher.activate();
      if (watcherActivationGuard) {
        await releaseWatcherActivationGuard(watcherActivationGuard);
        watcherActivationGuard = null;
      }
    } catch (error) {
      await watcher.close();
      throw error;
    }
  }
  const feedbackStore = await openFeedback();
  return {
    watcher,
    embedDbFile: startupEmbedDbAvailable ? embedFile : null,
    feedbackStore
  };
}
`;

const GOOD_FROZEN_CAPABILITY = `
export async function prepareServerDeps(opts) {
  const startupEmbedFile = embedDbPath(opts.vault);
  const startupEmbedDbAvailable = existsSync(startupEmbedFile);
  return {
    ...(opts.watch
      ? { embedDbFile: startupEmbedDbAvailable ? startupEmbedFile : null }
      : {})
  };
}
export function buildMcpServer(deps) {
  registerReadTools(server, vault, deps.embedDbFile);
}
`;

describe("watcher startup activation ordering (v3.12.0-rc.25 S-8c)", () => {
  it("accepts capture-first startup followed by all late attachments and one activation barrier", () => {
    expect(watcherStartupOrderViolations(GOOD_STARTUP)).toEqual([]);
    expect(frozenEmbedCapabilityViolations(GOOD_FROZEN_CAPABILITY)).toEqual([]);
    expect(startupPureValidationViolations(GOOD_STARTUP)).toEqual([]);

    const wrappedRecovery = GOOD_STARTUP.replace(
      "      throw error;",
      "      throw watcherActivationRecoveryError(error);"
    );
    expect(watcherStartupOrderViolations(wrappedRecovery)).toEqual([]);
  });

  it("src/server.ts preserves the production activation order", () => {
    const source = readFileSync(path.join(repoRoot, "src", "server.ts"), "utf8");
    expect(watcherStartupOrderViolations(source)).toEqual([]);
    expect(frozenEmbedCapabilityViolations(source)).toEqual([]);
    expect(startupPureValidationViolations(source)).toEqual([]);
  });

  it("NEGATIVE: rejects a missing barrier or an activation failure swallowed before cleanup", () => {
    const source = GOOD_STARTUP.replace("      await watcher.activate();\n", "");
    expect(watcherStartupOrderViolations(source)).toContain("expected exactly one watcher.activate() barrier, found 0");

    const swallowed = GOOD_STARTUP.replace("      throw error;\n", "");
    expect(watcherStartupOrderViolations(swallowed)).toContain(
      "watcher.activate() failure must rethrow the caught error after cleanup"
    );

    const conditionallyRethrown = GOOD_STARTUP.replace(
      "      throw error;",
      "      if (opts.strict) throw error;"
    );
    expect(watcherStartupOrderViolations(conditionallyRethrown)).toContain(
      "watcher.activate() failure must rethrow the caught error after cleanup"
    );

    const rethrownBeforeCleanup = GOOD_STARTUP.replace(
      "      await watcher.close();\n      throw error;",
      "      throw error;\n      await watcher.close();"
    );
    expect(watcherStartupOrderViolations(rethrownBeforeCleanup)).toContain(
      "watcher.close() cleanup must complete before activation failure is rethrown"
    );

    const missingDriftCapture = GOOD_STARTUP.replace(
      "    await watcher.captureAttachedSinkDrift();\n",
      ""
    );
    expect(watcherStartupOrderViolations(missingDriftCapture)).toContain(
      "expected exactly one watcher.captureAttachedSinkDrift() call, found 0"
    );

    const unawaitedDriftCapture = GOOD_STARTUP.replace(
      "await watcher.captureAttachedSinkDrift()",
      "watcher.captureAttachedSinkDrift()"
    );
    expect(watcherStartupOrderViolations(unawaitedDriftCapture)).toContain(
      "watcher.captureAttachedSinkDrift() must be directly awaited"
    );

    const missingPostReadyFts = GOOD_STARTUP.replace("      await syncFtsIndex(vault, ftsIndex);\n", "");
    expect(watcherStartupOrderViolations(missingPostReadyFts)).toContain(
      "expected exactly one post-ready syncFtsIndex reconciliation before activation, found 0"
    );

    const missingPostReadyPdf = GOOD_STARTUP.replace(
      "        await syncPdfFtsIndex(vault, ftsIndex);\n",
      ""
    );
    expect(watcherStartupOrderViolations(missingPostReadyPdf)).toContain(
      "expected exactly one post-ready syncPdfFtsIndex reconciliation before activation, found 0"
    );
  });

  it("NEGATIVE: rejects unawaited barriers and misplaced durable-guard transitions", () => {
    const source = GOOD_STARTUP.replace("await watcher.activate()", "watcher.activate()");
    expect(watcherStartupOrderViolations(source)).toContain("watcher.activate() must be directly awaited");

    const missingClearAssertion = GOOD_STARTUP.replace(
      "  await assertWatcherActivationGuardClear(embedFile);\n",
      ""
    );
    expect(watcherStartupOrderViolations(missingClearAssertion)).toContain(
      "expected exactly one activation-guard clear assertion, found 0"
    );

    const unawaitedClearAssertion = GOOD_STARTUP.replace(
      "await assertWatcherActivationGuardClear(embedFile)",
      "assertWatcherActivationGuardClear(embedFile)"
    );
    expect(watcherStartupOrderViolations(unawaitedClearAssertion)).toContain(
      "assertWatcherActivationGuardClear() must be directly awaited"
    );

    const lateClearAssertion = GOOD_STARTUP.replace(
      "  await assertWatcherActivationGuardClear(embedFile);\n",
      ""
    ).replace(
      "    await watcher.start();",
      "    await watcher.start();\n    await assertWatcherActivationGuardClear(embedFile);"
    );
    expect(watcherStartupOrderViolations(lateClearAssertion)).toContain(
      "activation guard must be asserted clear before FTS/watcher/HNSW acquisition"
    );

    const unawaitedArm = GOOD_STARTUP.replace(
      "await armWatcherActivationGuard(embedFile)",
      "armWatcherActivationGuard(embedFile)"
    );
    expect(watcherStartupOrderViolations(unawaitedArm)).toContain(
      "armWatcherActivationGuard() must be directly awaited"
    );

    const armAfterStart = GOOD_STARTUP.replace(
      "    if (startupEmbedDbAvailable) {\n      watcherActivationGuard = await armWatcherActivationGuard(embedFile);\n    }\n    await watcher.start();",
      "    await watcher.start();\n    if (startupEmbedDbAvailable) {\n      watcherActivationGuard = await armWatcherActivationGuard(embedFile);\n    }"
    );
    expect(watcherStartupOrderViolations(armAfterStart)).toContain(
      "activation guard must be armed before watcher.start()"
    );

    const releaseBeforeActivation = GOOD_STARTUP.replace(
      "      await watcher.activate();\n      if (watcherActivationGuard) {\n        await releaseWatcherActivationGuard(watcherActivationGuard);\n        watcherActivationGuard = null;\n      }",
      "      if (watcherActivationGuard) {\n        await releaseWatcherActivationGuard(watcherActivationGuard);\n        watcherActivationGuard = null;\n      }\n      await watcher.activate();"
    );
    expect(watcherStartupOrderViolations(releaseBeforeActivation)).toContain(
      "activation guard release must run after awaited watcher.activate()"
    );

    const unawaitedRelease = GOOD_STARTUP.replace(
      "await releaseWatcherActivationGuard(watcherActivationGuard)",
      "releaseWatcherActivationGuard(watcherActivationGuard)"
    );
    expect(watcherStartupOrderViolations(unawaitedRelease)).toContain(
      "releaseWatcherActivationGuard() must be directly awaited"
    );

    const swallowedRelease = GOOD_STARTUP.replace(
      "        await releaseWatcherActivationGuard(watcherActivationGuard);",
      "        try {\n          await releaseWatcherActivationGuard(watcherActivationGuard);\n        } catch (releaseError) {\n          warn(releaseError);\n        }"
    );
    expect(watcherStartupOrderViolations(swallowedRelease)).toContain(
      "activation guard release must stay on watcher.activate() successful try path"
    );

    const releaseAfterClose = GOOD_STARTUP.replace(
      "      await watcher.activate();",
      "      await watcher.activate();\n      await watcher.close();"
    );
    expect(watcherStartupOrderViolations(releaseAfterClose)).toContain(
      "activation guard release may not run after watcher.close()"
    );

    const releaseInFailureCatch = GOOD_STARTUP.replace(
      "      if (watcherActivationGuard) {\n        await releaseWatcherActivationGuard(watcherActivationGuard);\n        watcherActivationGuard = null;\n      }\n",
      ""
    ).replace(
      "    } catch (error) {\n      await watcher.close();",
      "    } catch (error) {\n      if (watcherActivationGuard) {\n        await releaseWatcherActivationGuard(watcherActivationGuard);\n        watcherActivationGuard = null;\n      }\n      await watcher.close();"
    );
    expect(watcherStartupOrderViolations(releaseInFailureCatch)).toContain(
      "activation guard release must stay on watcher.activate() successful try path"
    );

    const omittedFrozenCapability = GOOD_FROZEN_CAPABILITY.replace(
      "  registerReadTools(server, vault, deps.embedDbFile);",
      "  registerReadTools(server, vault);"
    );
    expect(frozenEmbedCapabilityViolations(omittedFrozenCapability)).toContain(
      "buildMcpServer must forward deps.embedDbFile without a late disk probe"
    );

    const dynamicLateCapability = GOOD_FROZEN_CAPABILITY.replace(
      "  registerReadTools(server, vault, deps.embedDbFile);",
      "  registerReadTools(server, vault, existsSync(embedDbPath(deps.vault.root)) ? embedDbPath(deps.vault.root) : null);"
    );
    expect(frozenEmbedCapabilityViolations(dynamicLateCapability)).toContain(
      "buildMcpServer must forward deps.embedDbFile without a late disk probe"
    );

    const resampledCapability = GOOD_FROZEN_CAPABILITY.replace(
      "startupEmbedDbAvailable ? startupEmbedFile : null",
      "existsSync(startupEmbedFile) ? startupEmbedFile : null"
    );
    expect(frozenEmbedCapabilityViolations(resampledCapability)).toContain(
      "expected exactly one frozen EmbedDb existsSync snapshot, found 2"
    );

    const unconditionalFrozenCapability = GOOD_FROZEN_CAPABILITY.replace(
      `    ...(opts.watch
      ? { embedDbFile: startupEmbedDbAvailable ? startupEmbedFile : null }
      : {})`,
      "    embedDbFile: startupEmbedDbAvailable ? startupEmbedFile : null"
    );
    expect(frozenEmbedCapabilityViolations(unconditionalFrozenCapability)).toContain(
      "prepareServerDeps must expose embedDbFile only through the opts.watch return spread"
    );

    const latePureValidation = GOOD_STARTUP.replace(REQUIRED_PURE_VALIDATION_BLOCK, "").replace(
      "    await watcher.start();",
      `    await watcher.start();
${REQUIRED_PURE_VALIDATION_BLOCK}`
    );
    expect(startupPureValidationViolations(latePureValidation)).toContain(
      "--ocr-pdfs compatibility validation must run before startup guard/resource acquisition"
    );
    expect(startupPureValidationViolations(latePureValidation)).toContain(
      "--late-chunk-context validation must run before startup guard/resource acquisition"
    );
    expect(startupPureValidationViolations(latePureValidation)).toContain(
      "--ocr-max-pages validation must run before startup guard/resource acquisition"
    );
    expect(startupPureValidationViolations(latePureValidation)).toContain(
      "--hnsw-ef validation must run before startup guard/resource acquisition"
    );
  });

  it("NEGATIVE: rejects activation before any late-bound watcher setup", () => {
    const lateHnsw = GOOD_STARTUP.replace(
      "    try {\n      await watcher.activate();",
      "    watcher.attachHnsw(lateIndex, lateRows);\n    try {\n      await watcher.activate();"
    ).replace(
      "  const feedbackStore = await openFeedback();",
      "  watcher.attachHnsw(latestIndex, latestRows);\n  const feedbackStore = await openFeedback();"
    );
    expect(watcherStartupOrderViolations(lateHnsw)).toContain(
      "watcher.activate() must run after every attachEmbed()/setOcrPdfs()/attachHnsw() branch"
    );

    const lateOcr = GOOD_STARTUP.replace(
      "        watcher.setOcrPdfs(true, opts.ocrLangs);\n",
      ""
    ).replace(
      "  const feedbackStore = await openFeedback();",
      "  watcher.setOcrPdfs(true, opts.ocrLangs);\n  const feedbackStore = await openFeedback();"
    );
    expect(watcherStartupOrderViolations(lateOcr)).toContain(
      "watcher.activate() must run after every attachEmbed()/setOcrPdfs()/attachHnsw() branch"
    );
  });

  it("NEGATIVE: rejects activation gated by --use-hnsw", () => {
    const source = GOOD_STARTUP.replace(
      "  if (watcher) {\n    try {\n      await watcher.activate();",
      "  if (opts.useHnsw) {\n    try {\n      await watcher.activate();"
    );
    expect(watcherStartupOrderViolations(source)).toContain(
      "watcher.activate() is conditionally gated beyond watcher existence"
    );
  });
});
