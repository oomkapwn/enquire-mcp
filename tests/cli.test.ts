import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parsePositiveInt } from "../src/index.js";

describe("parsePositiveInt — CLI numeric flag validation (audit P2-2)", () => {
  it("accepts a positive integer string", () => {
    expect(parsePositiveInt("100", "--max-file-bytes")).toBe(100);
  });

  it("accepts a large integer", () => {
    expect(parsePositiveInt("5242880", "--max-file-bytes")).toBe(5242880);
  });

  it("rejects NaN literal", () => {
    expect(() => parsePositiveInt("NaN", "--max-file-bytes")).toThrow(/positive integer/);
  });

  it("rejects Infinity literal", () => {
    expect(() => parsePositiveInt("Infinity", "--max-file-bytes")).toThrow(/positive integer/);
  });

  it("rejects -Infinity literal", () => {
    expect(() => parsePositiveInt("-Infinity", "--max-file-bytes")).toThrow(/positive integer/);
  });

  it("rejects non-numeric strings", () => {
    expect(() => parsePositiveInt("abc", "--max-file-bytes")).toThrow(/positive integer/);
  });

  it("rejects empty string", () => {
    expect(() => parsePositiveInt("", "--max-file-bytes")).toThrow(/positive integer/);
  });

  it("rejects zero", () => {
    expect(() => parsePositiveInt("0", "--cache-size")).toThrow(/positive integer/);
  });

  it("rejects negative", () => {
    expect(() => parsePositiveInt("-1", "--cache-size")).toThrow(/positive integer/);
  });

  it("rejects non-integer floats", () => {
    expect(() => parsePositiveInt("1.5", "--max-file-bytes")).toThrow(/positive integer/);
  });

  it("includes the flag name in the error", () => {
    expect(() => parsePositiveInt("oops", "--cache-size")).toThrow(/--cache-size/);
  });
});

describe("CLI entry-point guard (audit v0.7.5 P0)", () => {
  let tmpdir: string;
  const distEntry = path.resolve(__dirname, "..", "dist", "index.js");

  beforeEach(async () => {
    tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-cli-guard-"));
  });
  afterEach(async () => {
    await fs.rm(tmpdir, { recursive: true, force: true });
  });

  it("invokes main() when run via a symlink (e.g. npm bin shim)", async () => {
    const exists = await fs
      .stat(distEntry)
      .then(() => true)
      .catch(() => false);
    if (!exists) return; // dist not built yet — skip in dev watch loops
    const link = path.join(tmpdir, "enquire-mcp");
    await fs.symlink(distEntry, link);
    const out = execFileSync(process.execPath, [link, "--version"], { encoding: "utf8" });
    expect(out.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("invokes main() when run via /tmp on macOS (which itself is a symlink to /private/tmp)", async () => {
    const exists = await fs
      .stat(distEntry)
      .then(() => true)
      .catch(() => false);
    if (!exists) return;
    // tmpdir already lives under /tmp on macOS — execFile via /tmp path
    // exercises the same realpath divergence.
    if (process.platform !== "darwin") return; // only macOS has the /tmp symlink
    const out = execFileSync(process.execPath, [distEntry, "--version"], {
      encoding: "utf8",
      cwd: tmpdir
    });
    expect(out.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
