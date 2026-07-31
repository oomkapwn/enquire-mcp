import { promises as fs } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { createToolRegistrationAdapter } from "../src/mcp-registration.js";

const TOOL_MODES = new Map<string, "finish" | "rollback">([
  ["obsidian_mark_useful", "finish"],
  ["obsidian_create_note", "finish"],
  ["obsidian_append_to_note", "finish"],
  ["obsidian_rename_note", "rollback"],
  ["obsidian_replace_in_notes", "rollback"],
  ["obsidian_archive_note", "rollback"],
  ["obsidian_chat_thread_append", "finish"],
  ["obsidian_frontmatter_set", "finish"]
]);

function registrationBlock(source: string, toolName: string): string | null {
  const marker = `server.registerTool(\n    "${toolName}"`;
  const start = source.indexOf(marker);
  if (start < 0) return null;
  const next = source.indexOf("\n  server.registerTool(", start + marker.length);
  return source.slice(start, next < 0 ? source.length : next);
}

function manifestPersistentTools(manifestSource: string): string[] {
  return [...manifestSource.matchAll(/\{\s*name:\s*"([^"]+)",\s*kind:\s*"(?:write|feedback)"/g)].flatMap((match) =>
    match[1] ? [match[1]] : []
  );
}

function writeLifecycleProblems(registrySource: string, serverSource: string, manifestSource: string): string[] {
  const problems: string[] = [];
  const manifestNames = new Set(manifestPersistentTools(manifestSource));
  for (const name of manifestNames) {
    if (!TOOL_MODES.has(name)) problems.push(`${name}: persistent manifest tool lacks a lifecycle classification`);
  }
  for (const name of TOOL_MODES.keys()) {
    if (!manifestNames.has(name)) problems.push(`${name}: lifecycle classification is absent from the manifest`);
  }
  for (const [toolName, mode] of TOOL_MODES) {
    const block = registrationBlock(registrySource, toolName);
    if (!block) {
      problems.push(`${toolName}: registration missing`);
      continue;
    }
    if (!block.includes("runTrackedWrite(")) {
      problems.push(`${toolName}: callback bypasses runTrackedWrite`);
    }
    if (!block.includes(`"${mode}"`)) {
      problems.push(`${toolName}: expected ${mode} cancellation mode`);
    }
    if (mode === "rollback" && !block.includes("{ signal }")) {
      problems.push(`${toolName}: rollback signal is not forwarded to the batch implementation`);
    }
  }
  if (!serverSource.includes("registerFeedbackTool(server, deps.feedbackStore, writeTracker)")) {
    problems.push("server: feedback tracker wiring missing");
  }
  if (!serverSource.includes("registerWriteTools(server, deps.vault, writeTracker)")) {
    problems.push("server: vault-write tracker wiring missing");
  }
  return problems;
}

function registrationSeamProblems(serverSource: string): string[] {
  const problems: string[] = [];
  const start = serverSource.indexOf("export function buildMcpServer(");
  const end = serverSource.indexOf("\nexport async function startServer(", Math.max(0, start));
  const builder = start >= 0 && end > start ? serverSource.slice(start, end).trimEnd() : "";
  if (!builder.includes("server = createToolRegistrationAdapter(mcpServer,")) {
    problems.push("server: project-owned tool registration adapter is missing");
  }
  if (!builder.endsWith("return server;\n}")) {
    problems.push("server: gated facade is not returned after registration");
  }
  if (/\.registerTool\s*=/.test(builder)) {
    problems.push("server: SDK registerTool is overwritten in place");
  }
  return problems;
}

function stdioV2ServingProblems(serverSource: string): string[] {
  const problems: string[] = [];
  if (!serverSource.includes('import { McpServer } from "@modelcontextprotocol/server";')) {
    problems.push("server: McpServer is not imported from the SDK v2 server package");
  }
  if (!serverSource.includes('import { serveStdio } from "@modelcontextprotocol/server/stdio";')) {
    problems.push("server: SDK v2 serveStdio entry is missing");
  }
  if (!serverSource.includes('import { WriteRequestTracker } from "./write-lifecycle.js";')) {
    problems.push("server: stdio persistent-write tracker import is missing");
  }
  if (serverSource.includes("StdioServerTransport")) {
    problems.push("server: legacy hand-wired stdio transport remains");
  }

  const start = serverSource.indexOf("export async function startServer(");
  const end = serverSource.indexOf("\n/**\n * Shared \"ready\" banner", Math.max(0, start));
  const starter = start >= 0 && end > start ? serverSource.slice(start, end) : "";
  if ((starter.match(/prepareServerDeps\(opts\)/g) ?? []).length !== 1) {
    problems.push("server: stdio must prepare one shared dependency generation");
  }
  if ((starter.match(/new WriteRequestTracker\(\)/g) ?? []).length !== 1) {
    problems.push("server: stdio must own exactly one aggregate persistent-write tracker");
  }
  if (!starter.includes("serveStdio(() => buildMcpServer(deps, opts, writeTracker), {")) {
    problems.push("server: stdio factory must build only a fresh server over shared deps");
  }
  if (starter.includes(".connect(")) {
    problems.push("server: legacy direct server.connect wiring remains");
  }
  if (
    !starter.includes("let shutdownPromise: Promise<void> | undefined;") ||
    !starter.includes("if (shutdownPromise) return shutdownPromise;") ||
    !starter.includes("shutdownPromise = (async () => {")
  ) {
    problems.push("server: stdio shutdown is not memoized across every exit path");
  }
  if (
    !starter.includes("let signalExitScheduled = false;") ||
    !starter.includes("if (signalExitScheduled) return;")
  ) {
    problems.push("server: stdio signal and beforeExit paths do not share one shutdown latch");
  }
  const closeAdmission = starter.indexOf("writeTracker.closeAdmission(");
  const startProtocolClose = starter.indexOf("const protocolClose = Promise.resolve()");
  const abortRollback = starter.indexOf("await writeTracker.abortRollbackSafe(");
  const waitForWrites = starter.indexOf("await writeTracker.waitForAll();");
  const boundedProtocolClose = starter.indexOf("await waitForStdioProtocolClose(protocolClose)");
  const closeDeps = starter.indexOf("await shutdownStdioDeps(deps);");
  if (
    !(
      closeAdmission >= 0 &&
      closeAdmission < startProtocolClose &&
      startProtocolClose < abortRollback &&
      abortRollback < waitForWrites &&
      waitForWrites < boundedProtocolClose &&
      boundedProtocolClose < closeDeps
    )
  ) {
    problems.push("server: stdio write integrity and bounded protocol close must precede shared dependency close");
  }
  return problems;
}

describe("write lifecycle inventory invariant", () => {
  it("serializes persistent mutators and preserves registration/stdio factory seams", async () => {
    const [registrySource, serverSource, manifestSource] = await Promise.all([
      fs.readFile(path.resolve("src/tool-registry.ts"), "utf8"),
      fs.readFile(path.resolve("src/server.ts"), "utf8"),
      fs.readFile(path.resolve("src/tool-manifest.ts"), "utf8")
    ]);
    expect(writeLifecycleProblems(registrySource, serverSource, manifestSource)).toEqual([]);
    expect(registrationSeamProblems(serverSource)).toEqual([]);
    expect(stdioV2ServingProblems(serverSource)).toEqual([]);

    // Behavioral positive + negative control: allowed calls reach the raw
    // target with its original `this`; denied calls do not, and the original
    // object remains independently callable (the adapter never patches it).
    const calls: string[] = [];
    class RegistrationTarget {
      readonly #prefix = "raw";

      registerTool(name: string) {
        calls.push(`${this.#prefix}:${name}`);
        return name;
      }

      registerPrompt(name: string) {
        calls.push(`${this.#prefix}:prompt:${name}`);
      }
    }
    const target = new RegistrationTarget();
    const originalRegisterTool = target.registerTool;
    const registrar = createToolRegistrationAdapter(target, (name) => name !== "blocked");
    expect(registrar).not.toBe(target);
    expect(registrar).toBeInstanceOf(RegistrationTarget);
    const firstToolMethod = registrar.registerTool;
    expect(registrar.registerTool).toBe(firstToolMethod);
    expect(registrar.registerTool("allowed")).toBe("allowed");
    expect(registrar.registerTool("blocked")).toBeUndefined();
    registrar.registerTool = firstToolMethod;
    expect(registrar.registerTool).toBe(firstToolMethod);
    expect(registrar.registerTool("after-self-assignment")).toBe("after-self-assignment");
    expect(registrar.registerTool("blocked")).toBeUndefined();
    expect(registrar.valueOf()).toBe(registrar);
    expect(registrar.constructor).toBe(target.constructor);
    expect(registrar.registerPrompt).toBe(registrar.registerPrompt);
    const firstPromptMethod = registrar.registerPrompt;
    registrar.registerPrompt("bounded");
    expect(calls).toEqual(["raw:allowed", "raw:after-self-assignment", "raw:prompt:bounded"]);
    registrar.registerPrompt = function replacement(name: string) {
      calls.push(`replacement:${name}`);
    };
    expect(registrar.registerPrompt).not.toBe(firstPromptMethod);
    registrar.registerPrompt("fresh");
    expect(target.registerTool).toBe(originalRegisterTool);
    expect(target.registerTool("direct")).toBe("direct");
    registrar.registerTool = function replacementTool(name: string) {
      calls.push(`replacement-tool:${name}`);
      return name;
    };
    expect(registrar.registerTool("blocked")).toBeUndefined();
    expect(registrar.registerTool("allowed-again")).toBe("allowed-again");
    expect(calls).toEqual([
      "raw:allowed",
      "raw:after-self-assignment",
      "raw:prompt:bounded",
      "replacement:fresh",
      "raw:direct",
      "replacement-tool:allowed-again"
    ]);
    expect(() => createToolRegistrationAdapter({}, () => true)).toThrow(
      "MCP registration target must expose registerTool()"
    );
  });

  it("(negative-control) detects lifecycle, registration, and stdio seam regressions", async () => {
    const [registrySource, serverSource, manifestSource] = await Promise.all([
      fs.readFile(path.resolve("src/tool-registry.ts"), "utf8"),
      fs.readFile(path.resolve("src/server.ts"), "utf8"),
      fs.readFile(path.resolve("src/tool-manifest.ts"), "utf8")
    ]);
    const block = registrationBlock(registrySource, "obsidian_append_to_note");
    expect(block).not.toBeNull();
    const mutated = registrySource.replace(
      block ?? "",
      (block ?? "").replace("runTrackedWrite(", "runUntrackedWrite(")
    );
    expect(writeLifecycleProblems(mutated, serverSource, manifestSource)).toContain(
      "obsidian_append_to_note: callback bypasses runTrackedWrite"
    );

    const monkeyPatched = serverSource
      .replace("server = createToolRegistrationAdapter(mcpServer, (name) => {", "mcpServer.registerTool = (name) => {")
      .replace("return server;", "return mcpServer;");
    expect(registrationSeamProblems(monkeyPatched)).toEqual([
      "server: project-owned tool registration adapter is missing",
      "server: gated facade is not returned after registration",
      "server: SDK registerTool is overwritten in place"
    ]);

    const legacyStdio = serverSource
      .replace(
        'import { McpServer } from "@modelcontextprotocol/server";',
        'import { McpServer } from "legacy-sdk";'
      )
      .replace('import { serveStdio } from "@modelcontextprotocol/server/stdio";', "")
      .replace('import { WriteRequestTracker } from "./write-lifecycle.js";', "")
      .replace(
        "const handle = serveStdio(() => buildMcpServer(deps, opts, writeTracker), {",
        "const transport = new StdioServerTransport();"
      )
      .replace("const writeTracker = new WriteRequestTracker();", "")
      .replace("writeTracker.closeAdmission(\"Stdio shutdown closed persistent-write admission\");", "")
      .replace(/\s*await writeTracker\.abortRollbackSafe\([^\n]+\);/, "")
      .replace("        await writeTracker.waitForAll();", "");
    expect(stdioV2ServingProblems(legacyStdio)).toEqual(
      expect.arrayContaining([
        "server: McpServer is not imported from the SDK v2 server package",
        "server: SDK v2 serveStdio entry is missing",
        "server: stdio persistent-write tracker import is missing",
        "server: legacy hand-wired stdio transport remains",
        "server: stdio must own exactly one aggregate persistent-write tracker",
        "server: stdio factory must build only a fresh server over shared deps",
        "server: legacy direct server.connect wiring remains",
        "server: stdio write integrity and bounded protocol close must precede shared dependency close"
      ])
    );

    const racyStdio = serverSource
      .replace("if (shutdownPromise) return shutdownPromise;", "")
      .replace("let signalExitScheduled = false;", "")
      .replace("if (signalExitScheduled) return;", "")
      .replace("await waitForStdioProtocolClose(protocolClose)", "await protocolClose.then(() => true)");
    expect(stdioV2ServingProblems(racyStdio)).toEqual(
      expect.arrayContaining([
        "server: stdio shutdown is not memoized across every exit path",
        "server: stdio signal and beforeExit paths do not share one shutdown latch",
        "server: stdio write integrity and bounded protocol close must precede shared dependency close"
      ])
    );

    const duplicatedDeps = serverSource.replace(
      "serveStdio(() => buildMcpServer(deps, opts, writeTracker), {",
      "serveStdio(async () => buildMcpServer(await prepareServerDeps(opts), opts, writeTracker), {"
    );
    expect(stdioV2ServingProblems(duplicatedDeps)).toEqual(
      expect.arrayContaining([
        "server: stdio must prepare one shared dependency generation",
        "server: stdio factory must build only a fresh server over shared deps"
      ])
    );
  });

  it("(negative-control) detects a batch mutator misclassified as finish-only", async () => {
    const [registrySource, serverSource, manifestSource] = await Promise.all([
      fs.readFile(path.resolve("src/tool-registry.ts"), "utf8"),
      fs.readFile(path.resolve("src/server.ts"), "utf8"),
      fs.readFile(path.resolve("src/tool-manifest.ts"), "utf8")
    ]);
    const block = registrationBlock(registrySource, "obsidian_replace_in_notes");
    expect(block).not.toBeNull();
    const mutated = registrySource.replace(block ?? "", (block ?? "").replace('"rollback"', '"finish"'));
    expect(writeLifecycleProblems(mutated, serverSource, manifestSource)).toContain(
      "obsidian_replace_in_notes: expected rollback cancellation mode"
    );
  });

  it("(negative-control) detects a newly manifested persistent tool with no lifecycle owner", async () => {
    const [registrySource, serverSource, manifestSource] = await Promise.all([
      fs.readFile(path.resolve("src/tool-registry.ts"), "utf8"),
      fs.readFile(path.resolve("src/server.ts"), "utf8"),
      fs.readFile(path.resolve("src/tool-manifest.ts"), "utf8")
    ]);
    const mutatedManifest = `${manifestSource}\nconst negativeFixture = {\n  name: "obsidian_untracked_write",\n  kind: "write",\n  gating: "--enable-write",\n  summary: "negative fixture"\n};\n`;
    expect(writeLifecycleProblems(registrySource, serverSource, mutatedManifest)).toContain(
      "obsidian_untracked_write: persistent manifest tool lacks a lifecycle classification"
    );
  });
});
