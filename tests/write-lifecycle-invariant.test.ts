import { promises as fs } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

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

describe("write lifecycle inventory invariant", () => {
  it("every persistent MCP mutator is serialized and classified for DELETE cancellation", async () => {
    const [registrySource, serverSource, manifestSource] = await Promise.all([
      fs.readFile(path.resolve("src/tool-registry.ts"), "utf8"),
      fs.readFile(path.resolve("src/server.ts"), "utf8"),
      fs.readFile(path.resolve("src/tool-manifest.ts"), "utf8")
    ]);
    expect(writeLifecycleProblems(registrySource, serverSource, manifestSource)).toEqual([]);
  });

  it("(negative-control) detects a write callback that bypasses the shared lifecycle lane", async () => {
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
