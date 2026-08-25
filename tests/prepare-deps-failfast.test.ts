// v3.11.5-rc.1 (CRL-1) — prepareServerDeps must validate the advanced-retrieval flags
// (--feedback-weight / --recency-weight / --stale-days) BEFORE it acquires any resource
// (the vault cache via `new Vault(...)`, the FTS5 handle, the watcher, the embed-db, the
// HNSW index). Pre-fix the --feedback-weight parse sat near the END of prepareServerDeps —
// AFTER ftsIndex.open()/watcher.start()/embed-db.open() — so a typo'd weight threw only
// after those handles were open, leaking a SQLite handle / running watcher for the process
// lifetime.
//
// `src/server.ts` is on the `no-internal-imports` RESTRICTED list (tests may not value-import
// it), so — mirroring cli-parity.test.ts + the retrieval-opts leaf-module split from rc.62 —
// this is a STRUCTURAL source-order guard: the parseFeedbackConfig / parseRecencyConfig calls
// must appear before the first `new Vault(` inside prepareServerDeps. The pure helper is
// exercised by a NEGATIVE control so the invariant can't go vacuous.
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { type ServerDeps, startServer } from "../src/index.js";
import { PreparedServerCleanupError } from "../src/shutdown.js";
import { replaceExactly } from "./helpers/exact-source-mutation.js";

const stdioHarness = vi.hoisted(() => ({ serveStdio: vi.fn() }));
vi.mock("@modelcontextprotocol/server/stdio", () => ({ serveStdio: stdioHarness.serveStdio }));

const repoRoot = path.resolve(__dirname, "..");

/**
 * Given the full source of a `prepareServerDeps`-shaped function, return a list of
 * ordering violations: each validator (`parseFeedbackConfig` / `parseRecencyConfig`) that
 * is called at/after the first resource acquisition (`new Vault(`) — or not called at all.
 * A pure, testable predicate (empty array = fail-fast ordering holds).
 */
function acquisitionOrderViolations(fnSrc: string): string[] {
  const out: string[] = [];
  const acquireAt = fnSrc.indexOf("new Vault(");
  if (acquireAt < 0) return ["no `new Vault(` acquisition found — cannot verify ordering"];
  for (const validator of ["parseFeedbackConfig", "parseRecencyConfig"]) {
    const at = fnSrc.indexOf(`${validator}(opts)`);
    if (at < 0) out.push(`${validator}(opts) is never called before acquisition`);
    else if (at > acquireAt) out.push(`${validator}(opts) runs AFTER \`new Vault(\` (leaks handles on throw)`);
  }
  return out;
}

/** Slice out the prepareServerDeps function body (best-effort: from its declaration to the
 *  next top-level `export ` that follows). */
function extractPrepareServerDeps(src: string): string {
  const start = src.indexOf("export async function prepareServerDeps");
  if (start < 0) return "";
  const after = src.indexOf("\nexport ", start + 1);
  return src.slice(start, after < 0 ? undefined : after);
}

function extractBuildMcpServer(src: string): string {
  const start = src.indexOf("export function buildMcpServer");
  if (start < 0) return "";
  const after = src.indexOf("\nexport ", start + 1);
  return src.slice(start, after < 0 ? undefined : after);
}

function extractStartServer(src: string): string {
  const start = src.indexOf("export async function startServer");
  if (start < 0) return "";
  const after = src.indexOf("\nexport ", start + 1);
  return src.slice(start, after < 0 ? undefined : after);
}

function extractStartHttpServer(src: string): string {
  const start = src.indexOf("export async function startHttpServer");
  if (start < 0) return "";
  const after = src.indexOf("\nexport ", start + 1);
  return src.slice(start, after < 0 ? undefined : after);
}

function preparedDependencyCleanupAt(source: string, fromIndex = 0): number {
  const candidates = [
    source.indexOf("createPreparedServerCleanupOwner(", fromIndex),
    source.indexOf("cleanupPreparedServerDeps(", fromIndex)
  ].filter((index) => index >= 0);
  return candidates.length === 0 ? -1 : Math.min(...candidates);
}

function hasPreparedDependencyCleanup(source: string): boolean {
  return preparedDependencyCleanupAt(source) >= 0;
}

function runtimeAdmissionOrderViolations(fnSrc: string, boundary: string): string[] {
  const admissionAt = fnSrc.indexOf("assertServeOptionsRuntime(opts)");
  const boundaryAt = fnSrc.indexOf(boundary);
  if (admissionAt < 0) return ["runtime ServeOptions admission is missing"];
  if (boundaryAt < 0) return [`boundary ${boundary} is missing`];
  return admissionAt < boundaryAt ? [] : [`runtime ServeOptions admission runs after ${boundary}`];
}

/** Verify that the ownership catch begins before the first acquired Vault operation
 * and closes every owner without publishing a partially prepared cache generation. */
function prepareOwnershipCleanupViolations(fnSrc: string): string[] {
  const problems: string[] = [];
  const acquireAt = fnSrc.indexOf("const vault = new Vault(");
  const ensureAt = fnSrc.indexOf("await vault.ensureExists()", acquireAt);
  const outerTryAt = fnSrc.indexOf("try {", acquireAt);
  const outerCatchAt = fnSrc.lastIndexOf("} catch (error)");
  const cleanupAt = preparedDependencyCleanupAt(fnSrc, outerCatchAt);
  if (acquireAt < 0) problems.push("Vault acquisition is missing");
  if (ensureAt < 0) problems.push("first acquired Vault operation is missing");
  if (outerTryAt < 0 || (ensureAt >= 0 && outerTryAt > ensureAt)) {
    problems.push("outer ownership try does not begin before the first acquired Vault operation");
  }
  if (outerCatchAt < 0 || outerCatchAt < outerTryAt) problems.push("outer ownership catch is missing");
  if (cleanupAt < 0) problems.push("outer ownership catch does not call cleanupPreparedServerDeps");
  const cleanupWindow = cleanupAt < 0 ? "" : fnSrc.slice(cleanupAt, cleanupAt + 800);
  for (const owner of ["feedbackStore", "vault", "ftsIndex", "watcher", "watcherEmbedDb", "hnswContext"]) {
    if (!cleanupWindow.includes(owner)) problems.push(`outer ownership cleanup omits ${owner}`);
  }
  if (!cleanupWindow.includes("flushVaultCache: false")) {
    problems.push("startup rollback can publish a partially prepared Vault cache");
  }
  return problems;
}

/** Verify that every stdio post-connect operation remains inside one ownership try. */
function stdioSetupCleanupViolations(fnSrc: string): string[] {
  const problems: string[] = [];
  const serveAt = fnSrc.indexOf("serveStdio(");
  const readyAt = fnSrc.indexOf("formatReadyBanner(deps)", serveAt);
  const signalAt = fnSrc.indexOf('process.once("SIGINT"', serveAt);
  const returnAt = fnSrc.indexOf("return;", readyAt);
  const tryAt = fnSrc.lastIndexOf("try {", serveAt);
  const catchAt = fnSrc.lastIndexOf("} catch (error)");
  if (serveAt < 0) return ["serveStdio setup is missing"];
  if (tryAt < 0 || tryAt > serveAt) problems.push("serveStdio setup is not inside an ownership try");
  if (
    catchAt < 0 ||
    readyAt < serveAt ||
    signalAt < serveAt ||
    returnAt < readyAt ||
    readyAt > catchAt ||
    signalAt > catchAt ||
    returnAt > catchAt
  ) {
    problems.push("stdio ownership catch does not cover ready, shutdown-owner installation, and return");
  }
  const catchWindow = catchAt < 0 ? "" : fnSrc.slice(catchAt);
  const protocolCloseAt = catchWindow.indexOf("rollbackHandle.close()");
  const dependencyCloseAt = preparedDependencyCleanupAt(catchWindow);
  if (protocolCloseAt < 0) problems.push("stdio startup rollback does not close the acquired protocol handle");
  if (!hasPreparedDependencyCleanup(catchWindow)) {
    problems.push("stdio setup catch does not clean prepared deps");
  }
  if (!catchWindow.includes("flushVaultCache: false")) {
    problems.push("stdio setup rollback can publish a cache generation that never served");
  }
  if (protocolCloseAt >= 0 && dependencyCloseAt >= 0 && protocolCloseAt > dependencyCloseAt) {
    problems.push("stdio startup rollback closes shared deps before the protocol owner");
  }
  return problems;
}

/** Verify every HTTP operation from handler acquisition through return remains in
 * one rollback boundary, with protocol/listener owners closed before shared deps. */
function httpStartupCleanupViolations(fnSrc: string): string[] {
  const problems: string[] = [];
  const handlerAt = fnSrc.indexOf("createHttpHandler(");
  const mapAt = fnSrc.indexOf("httpServerExtras.set(", handlerAt);
  const listenAt = fnSrc.indexOf("httpServer.listen(", handlerAt);
  const listenerListenAt = fnSrc.indexOf("listener.listen(", handlerAt);
  const effectiveListenAt = listenAt >= 0 ? listenAt : listenerListenAt;
  const readyAt = fnSrc.indexOf("formatReadyBanner(deps)", effectiveListenAt);
  const returnAt = fnSrc.indexOf("return listener", readyAt);
  const catchAt = fnSrc.lastIndexOf("} catch (error)");
  const tryAt = fnSrc.lastIndexOf("try {", handlerAt);
  if (handlerAt < 0) return ["createHttpHandler setup is missing"];
  if (tryAt < 0 || tryAt > handlerAt) problems.push("HTTP handler/server creation is not inside an ownership try");
  if (
    mapAt < 0 ||
    effectiveListenAt < mapAt ||
    readyAt < effectiveListenAt ||
    returnAt < readyAt ||
    catchAt < returnAt
  ) {
    problems.push("HTTP ownership catch does not cover handler, listen, ready, and return");
  }
  const catchWindow = catchAt < 0 ? "" : fnSrc.slice(catchAt);
  for (const cleanup of [
    "handlerOut.modern?.close()",
    "handlerOut.registry?.closeAll()",
    "shutdownHttpServer(httpServer)",
    "createPreparedServerCleanupOwner(deps"
  ]) {
    if (!catchWindow.includes(cleanup)) problems.push(`HTTP startup rollback omits ${cleanup}`);
  }
  if (!catchWindow.includes("flushVaultCache: false")) {
    problems.push("HTTP startup rollback can publish the Vault cache");
  }
  if (effectiveListenAt < 0) problems.push("HTTP listen boundary is missing");
  for (const registration of ['process.once("SIGINT"', 'process.once("SIGTERM"', 'process.on("beforeExit"']) {
    const at = fnSrc.indexOf(registration);
    if (at < 0 || at < effectiveListenAt || at > catchAt) {
      problems.push(`${registration} is not inside the post-listen ownership boundary`);
    }
  }
  return problems;
}

/** Find synchronous `close()` calls on values constructed as FtsIndex (or on a
 * ServerDeps.ftsIndex property). Lifecycle owners must await closeAndRelease(). */
function synchronousFtsCloseSites(file: string, source: string): string[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const constructedNames = new Set<string>();
  const sites: string[] = [];
  const isFtsConstruction = (node: ts.Node | undefined): node is ts.NewExpression =>
    node !== undefined && ts.isNewExpression(node) && node.expression.getText(sourceFile) === "FtsIndex";

  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && isFtsConstruction(node.initializer)) {
      constructedNames.add(node.name.text);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      isFtsConstruction(node.right)
    ) {
      constructedNames.add(node.left.text);
    }
    ts.forEachChild(node, collect);
  };
  collect(sourceFile);

  const inspect = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "close"
    ) {
      const receiver = node.expression.expression;
      const targetsFts =
        (ts.isIdentifier(receiver) && constructedNames.has(receiver.text)) ||
        (ts.isPropertyAccessExpression(receiver) && receiver.name.text === "ftsIndex");
      if (targetsFts) {
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
        sites.push(`${file}:${line}`);
      }
    }
    ts.forEachChild(node, inspect);
  };
  inspect(sourceFile);
  return sites;
}

describe("prepareServerDeps validates retrieval flags before acquiring resources (v3.11.5-rc.1 CRL-1)", () => {
  it("admits runtime ServeOptions before prepare/build can acquire or register anything", async () => {
    const src = await fs.readFile(path.join(repoRoot, "src", "server.ts"), "utf8");
    expect(runtimeAdmissionOrderViolations(extractPrepareServerDeps(src), "new Vault(")).toEqual([]);
    expect(runtimeAdmissionOrderViolations(extractBuildMcpServer(src), "setEmbeddingsOffline()")).toEqual([]);
  });

  it("NEGATIVE control — runtime admission after acquisition or registration is rejected", () => {
    expect(
      runtimeAdmissionOrderViolations(
        "export async function prepareServerDeps(opts) { new Vault(opts.vault); assertServeOptionsRuntime(opts); }",
        "new Vault("
      )
    ).toEqual(["runtime ServeOptions admission runs after new Vault("]);
    expect(
      runtimeAdmissionOrderViolations(
        "export function buildMcpServer(deps, opts) { setEmbeddingsOffline(); assertServeOptionsRuntime(opts); }",
        "setEmbeddingsOffline()"
      )
    ).toEqual(["runtime ServeOptions admission runs after setEmbeddingsOffline()"]);
  });

  it("parseFeedbackConfig + parseRecencyConfig run BEFORE the first `new Vault(` acquisition", async () => {
    const src = await fs.readFile(path.join(repoRoot, "src", "server.ts"), "utf8");
    const fnSrc = extractPrepareServerDeps(src);
    expect(fnSrc, "prepareServerDeps must exist in src/server.ts").not.toBe("");
    expect(acquisitionOrderViolations(fnSrc)).toEqual([]);
  });

  it("NEGATIVE control — the helper flags the pre-fix ordering (validators AFTER new Vault)", () => {
    const preFix = [
      "export async function prepareServerDeps(opts) {",
      "  const vault = new Vault(opts.vault, {});",
      "  await ftsIndex.open();",
      "  const feedbackStore = parseFeedbackConfig(opts) !== null ? await open() : null;",
      "  const recencyConfig = parseRecencyConfig(opts);",
      "}"
    ].join("\n");
    const violations = acquisitionOrderViolations(preFix);
    expect(violations.length).toBe(2);
    expect(violations.join(" ")).toMatch(/parseFeedbackConfig.*AFTER|AFTER.*parseFeedbackConfig/);
  });

  it("NEGATIVE control — the helper flags a validator that is never called", () => {
    const missing =
      "export async function prepareServerDeps(opts) {\n  const vault = new Vault(opts.vault, {});\n  parseRecencyConfig(opts);\n}";
    expect(acquisitionOrderViolations(missing)).toContain(
      "parseFeedbackConfig(opts) is never called before acquisition"
    );
  });

  // v3.11.5-rc.4 (post-rc.3 re-sweep) — CRL-1 sibling: --reranker-top-n was validated only in
  // buildMcpServer (one call-frame later), which stdio `serve` invokes AFTER prepareServerDeps
  // acquired the FTS5 handle / watcher / embed-db / HNSW, so a bad value leaked them. It is now
  // hoisted into prepareServerDeps' fail-fast block — this pins that ordering structurally.
  it("--reranker-top-n is validated BEFORE the first `new Vault(` acquisition (CRL-1 sibling)", async () => {
    const src = await fs.readFile(path.join(repoRoot, "src", "server.ts"), "utf8");
    const fnSrc = extractPrepareServerDeps(src);
    const acquireAt = fnSrc.indexOf("new Vault(");
    const validateAt = fnSrc.indexOf("parsePositiveInt(opts.rerankerTopN");
    expect(validateAt, "prepareServerDeps must validate --reranker-top-n at boot").toBeGreaterThan(-1);
    expect(validateAt).toBeLessThan(acquireAt); // before any resource is acquired
  });
});

describe("server startup owns every acquired persistence lifetime", () => {
  it("prepareServerDeps has one outer rollback boundary after Vault acquisition", async () => {
    const src = await fs.readFile(path.join(repoRoot, "src", "server.ts"), "utf8");
    expect(prepareOwnershipCleanupViolations(extractPrepareServerDeps(src))).toEqual([]);
  });

  it("NEGATIVE control — preparation without outer cleanup is rejected", () => {
    const leaking = [
      "export async function prepareServerDeps(opts) {",
      "  const vault = new Vault(opts.vault, {});",
      "  await vault.ensureExists();",
      "  return { vault };",
      "}"
    ].join("\n");
    expect(prepareOwnershipCleanupViolations(leaking)).toEqual(
      expect.arrayContaining([
        "outer ownership try does not begin before the first acquired Vault operation",
        "outer ownership catch does not call cleanupPreparedServerDeps"
      ])
    );
  });

  it("startServer owns stdio connect, shutdown registration, ready, and return in one rollback boundary", async () => {
    const src = await fs.readFile(path.join(repoRoot, "src", "server.ts"), "utf8");
    expect(stdioSetupCleanupViolations(extractStartServer(src))).toEqual([]);
  });

  it("NEGATIVE control — a bare serveStdio call strands prepared deps", () => {
    const leaking = [
      "export async function startServer(opts) {",
      "  const deps = await prepareServerDeps(opts);",
      "  const handle = serveStdio(() => buildMcpServer(deps, opts));",
      "  process.stderr.write(formatReadyBanner(deps));",
      "}"
    ].join("\n");
    expect(stdioSetupCleanupViolations(leaking)).toEqual(
      expect.arrayContaining([
        "serveStdio setup is not inside an ownership try",
        "stdio ownership catch does not cover ready, shutdown-owner installation, and return",
        "stdio startup rollback does not close the acquired protocol handle",
        "stdio setup catch does not clean prepared deps"
      ])
    );
  });

  it("causally rolls protocol ownership and partial signal owners back on a pre-ready fault", async () => {
    const vaultRoot = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-stdio-startup-"));
    const order: string[] = [];
    const startupError = new Error("injected ready-banner failure");
    const protocolClose = vi.fn(async () => void order.push("protocol"));
    const signalCounts = {
      sigint: process.listenerCount("SIGINT"),
      sigterm: process.listenerCount("SIGTERM"),
      beforeExit: process.listenerCount("beforeExit")
    };
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => {
      throw startupError;
    });
    stdioHarness.serveStdio.mockReset();
    stdioHarness.serveStdio.mockReturnValue({ close: protocolClose });
    try {
      await fs.writeFile(path.join(vaultRoot, "note.md"), "# startup\n", "utf8");
      await expect(
        startServer(
          { vault: vaultRoot, embeddingIndex: false, persistentIndex: false },
          {
            afterProtocolConnected: (deps) => {
              const closePersistence = deps.vault.closePersistence.bind(deps.vault);
              deps.vault.closePersistence = async () => {
                order.push("deps");
                await closePersistence();
              };
            }
          }
        )
      ).rejects.toBe(startupError);
      expect(protocolClose).toHaveBeenCalledTimes(1);
      expect(order).toEqual(["protocol", "deps"]);
      expect(process.listenerCount("SIGINT")).toBe(signalCounts.sigint);
      expect(process.listenerCount("SIGTERM")).toBe(signalCounts.sigterm);
      expect(process.listenerCount("beforeExit")).toBe(signalCounts.beforeExit);
    } finally {
      stderr.mockRestore();
      await fs.rm(vaultRoot, { recursive: true, force: true });
    }
  });

  it("aggregates the post-connect fault with protocol and dependency cleanup failures", async () => {
    const vaultRoot = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-stdio-startup-errors-"));
    const startupError = new Error("injected post-connect failure");
    const protocolError = new Error("injected protocol close failure");
    const dependencyError = new Error("injected dependency release failure");
    let dependencyReleaseAttempts = 0;
    stdioHarness.serveStdio.mockReset();
    stdioHarness.serveStdio.mockReturnValue({
      close: vi.fn(async () => {
        throw protocolError;
      })
    });
    try {
      await fs.writeFile(path.join(vaultRoot, "note.md"), "# startup\n", "utf8");
      let thrown: unknown;
      try {
        await startServer(
          { vault: vaultRoot, embeddingIndex: false, persistentIndex: false },
          {
            afterProtocolConnected: (deps) => {
              deps.ftsIndex = {
                closeAndRelease: async () => {
                  dependencyReleaseAttempts++;
                  if (dependencyReleaseAttempts === 1) throw dependencyError;
                }
              } as unknown as NonNullable<ServerDeps["ftsIndex"]>;
              throw startupError;
            }
          }
        );
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AggregateError);
      expect((thrown as AggregateError).errors).toEqual([startupError, protocolError, dependencyError]);
      expect(thrown).toBeInstanceOf(PreparedServerCleanupError);
      const retained = thrown as PreparedServerCleanupError;
      expect(retained.cleanupOwner.pendingStages).toEqual(["fts-index"]);
      await expect(retained.cleanupOwner.cleanup()).resolves.toEqual([]);
      expect(dependencyReleaseAttempts).toBe(2);
    } finally {
      await fs.rm(vaultRoot, { recursive: true, force: true });
    }
  });

  it("NEGATIVE control — a successful post-connect hook does not trigger startup rollback", async () => {
    const vaultRoot = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-stdio-startup-ok-"));
    const protocolClose = vi.fn(async () => {});
    const dependencyClose = vi.fn(async () => {});
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let capturedDeps: ServerDeps | undefined;
    const initialListeners = {
      sigint: new Set(process.listeners("SIGINT")),
      sigterm: new Set(process.listeners("SIGTERM")),
      beforeExit: new Set(process.listeners("beforeExit"))
    };
    stdioHarness.serveStdio.mockReset();
    stdioHarness.serveStdio.mockReturnValue({ close: protocolClose });
    try {
      await fs.writeFile(path.join(vaultRoot, "note.md"), "# startup\n", "utf8");
      await expect(
        startServer(
          { vault: vaultRoot, embeddingIndex: false, persistentIndex: false },
          {
            afterProtocolConnected: (deps) => {
              capturedDeps = deps;
              const closePersistence = deps.vault.closePersistence.bind(deps.vault);
              deps.vault.closePersistence = async () => {
                await dependencyClose();
                await closePersistence();
              };
            }
          }
        )
      ).resolves.toBeUndefined();
      expect(protocolClose).not.toHaveBeenCalled();
      expect(dependencyClose).not.toHaveBeenCalled();
    } finally {
      for (const listener of process.listeners("SIGINT")) {
        if (!initialListeners.sigint.has(listener)) process.removeListener("SIGINT", listener);
      }
      for (const listener of process.listeners("SIGTERM")) {
        if (!initialListeners.sigterm.has(listener)) process.removeListener("SIGTERM", listener);
      }
      for (const listener of process.listeners("beforeExit")) {
        if (!initialListeners.beforeExit.has(listener)) process.removeListener("beforeExit", listener);
      }
      await capturedDeps?.vault.closePersistence();
      await protocolClose();
      stderr.mockRestore();
      await fs.rm(vaultRoot, { recursive: true, force: true });
    }
  });

  it("startHttpServer owns handler, listen, shutdown registration, ready, and return in one rollback boundary", async () => {
    const src = await fs.readFile(path.join(repoRoot, "src", "http-transport.ts"), "utf8");
    expect(httpStartupCleanupViolations(extractStartHttpServer(src))).toEqual([]);
  });

  it("NEGATIVE control — missing a direct HTTP owner close is rejected", async () => {
    const src = await fs.readFile(path.join(repoRoot, "src", "http-transport.ts"), "utf8");
    const fnSrc = extractStartHttpServer(src);
    const mutated = replaceExactly(fnSrc, "handlerOut.modern?.close()", "Promise.resolve()");
    expect(mutated).not.toBe(fnSrc);
    expect(httpStartupCleanupViolations(mutated)).toContain("HTTP startup rollback omits handlerOut.modern?.close()");
  });

  it("NEGATIVE control — signal registration before listen is rejected", () => {
    const leaking = [
      "export async function startHttpServer(opts) {",
      "  const deps = await prepareServerDeps(opts);",
      "  const handlerOut = { registry: null };",
      "  let httpServer;",
      "  try {",
      "    const handler = createHttpHandler(deps, opts, handlerOut);",
      "    httpServer = createServer(handler);",
      "    httpServerExtras.set(httpServer, { deps });",
      "  } catch (error) {",
      "    await handlerOut.modern?.close();",
      "    await handlerOut.registry?.closeAll();",
      "    await cleanupPreparedServerDeps(deps, { flushVaultCache: false });",
      "    throw error;",
      "  }",
      '  process.once("SIGINT", onSignal);',
      '  process.once("SIGTERM", onSignal);',
      '  process.on("beforeExit", onBeforeExit);',
      "  httpServer.listen(opts.port);",
      "}"
    ].join("\n");
    expect(httpStartupCleanupViolations(leaking)).toEqual(
      expect.arrayContaining([
        'process.once("SIGINT" is not inside the post-listen ownership boundary',
        'process.once("SIGTERM" is not inside the post-listen ownership boundary',
        'process.on("beforeExit" is not inside the post-listen ownership boundary'
      ])
    );
  });

  it("all production FTS lifecycle sites await closeAndRelease instead of sync close", async () => {
    const files = ["src/server.ts", "src/http-transport.ts", "src/shutdown.ts", "src/cli.ts"];
    const sources = await Promise.all(files.map((file) => fs.readFile(path.join(repoRoot, file), "utf8")));
    expect(files.flatMap((file, index) => synchronousFtsCloseSites(file, sources[index] ?? ""))).toEqual([]);
  });

  it("NEGATIVE control — the FTS lifecycle census detects sync close under an arbitrary alias", () => {
    const leaking = "const durableSearch = new FtsIndex(opts); durableSearch.close();";
    expect(synchronousFtsCloseSites("synthetic.ts", leaking)).toEqual(["synthetic.ts:1"]);
  });
});
