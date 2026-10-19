// AH-7 — the resource handlers the MCP SDK actually dispatches to.
//
// The registry has always had three resource registrations, and the audit
// confirmed by reading that `obsidian://note/{+notePath}` routes through the
// full `resolveSafePath` privacy pipeline. Reading is not evidence. These
// controls DRIVE the registered callbacks the way the SDK does — capture what
// `registerResource` was handed, then invoke it — so a renamed resource, a
// dropped registration, a lost array-join on the greedy `{+notePath}`, or a
// privacy bypass in the resource path all fail here rather than in production.

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerChunkResource, registerResources } from "../src/tool-registry.js";
import { Vault } from "../src/vault.js";

interface CapturedRegistration {
  readonly name: string;
  readonly uriOrTemplate: unknown;
  readonly metadata: Record<string, unknown> | undefined;
  readonly handler: (
    uri: URL,
    params: Record<string, string | string[]>
  ) => Promise<{ contents: Array<{ uri: string; mimeType: string; text: string }> }>;
}

/**
 * Capture what the registry hands the SDK. `registerResource` is overloaded for
 * a static URI and a `ResourceTemplate`, but both take (name, uriOrTemplate,
 * metadata, handler), so one capture serves every registration.
 */
function captureServer(): {
  server: unknown;
  registrations: CapturedRegistration[];
} {
  const registrations: CapturedRegistration[] = [];
  const server = {
    registerResource(
      name: string,
      uriOrTemplate: unknown,
      metadata: Record<string, unknown> | undefined,
      handler: CapturedRegistration["handler"]
    ): void {
      registrations.push({ name, uriOrTemplate, metadata, handler });
    }
  };
  return { server: server as never, registrations };
}

describe("AH-7: resource handlers behave as registered", () => {
  const roots: string[] = [];
  let vault: Vault;

  beforeEach(async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "enquire-resource-handler-"));
    roots.push(root);
    vault = new Vault(root);
    const base = roots[0] ?? root;
    await fs.mkdir(path.join(base, "Projects"), { recursive: true });
    await fs.writeFile(path.join(base, "Projects", "plan.md"), "# Plan\n\nship it\n");
  });

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  const url = (href: string): URL => new URL(href);

  it("registers exactly the three documented resources", () => {
    const { server, registrations } = captureServer();
    registerResources(server, vault);
    registerChunkResource(server, {} as never, vault);

    expect(registrations.map((r) => r.name)).toEqual(["vault-info", "vault-note", "vault-chunk"]);
    // The greedy `{+notePath}` form is what makes `Projects/plan.md` addressable
    // as ONE parameter; a single-segment template would silently stop resolving.
    const templateOf = (name: string): string => {
      const found = registrations.find((r) => r.name === name);
      const template = found?.uriOrTemplate as { uriTemplate?: { template?: string } } | undefined;
      return String(template?.uriTemplate?.template ?? "");
    };
    expect(templateOf("vault-note")).toContain("{+notePath}");
    expect(templateOf("vault-chunk")).toContain("{chunkIndex}");
    expect(templateOf("vault-chunk")).toContain("{+notePath}");
  });

  it("reads a note through the registered vault-note handler", async () => {
    const { server, registrations } = captureServer();
    registerResources(server, vault);
    const handler = registrations.find((r) => r.name === "vault-note")?.handler;

    const result = await handler!(url("obsidian://note/Projects%2Fplan.md"), { notePath: ["Projects", "plan.md"] });

    // The greedy parameter arrives as an ARRAY; joining it is the branch that
    // keeps multi-segment paths working.
    expect(result.contents[0]?.mimeType).toBe("text/markdown");
    expect(result.contents[0]?.text).toContain("ship it");
    expect(result.contents[0]?.uri).toBe("obsidian://note/Projects%2Fplan.md");
  });

  it("NEGATIVE: the resource path cannot reach an excluded or escaping note", async () => {
    const { server, registrations } = captureServer();
    registerResources(server, vault);
    const handler = registrations.find((r) => r.name === "vault-note")?.handler;

    // A hidden directory is excluded from every listing and read path; if the
    // resource handler bypassed `resolveSafePath`, these would resolve.
    const base = roots[0] ?? "";
    await fs.mkdir(path.join(base, ".private"), { recursive: true });
    await fs.writeFile(path.join(base, ".private", "secret.md"), "SECRET\n");
    await fs.writeFile(path.join(base, "outside.md"), "OUTSIDE\n");

    const hidden = url("obsidian://note/.private%2Fsecret.md");
    await expect(handler!(hidden, { notePath: [".private", "secret.md"] })).rejects.toThrow();

    const traversal = url("obsidian://note/%2E%2E%2Foutside.md");
    await expect(handler!(traversal, { notePath: ["..", "outside.md"] })).rejects.toThrow();
  });

  it("the registered vault-info handler returns the version as JSON", async () => {
    const { server, registrations } = captureServer();
    registerResources(server, vault);
    const handler = registrations.find((r) => r.name === "vault-info")?.handler;

    const result = await handler!(url("obsidian://vault/info"), {});
    const payload = JSON.parse(result.contents[0]?.text ?? "{}") as { version?: string };

    expect(result.contents[0]?.mimeType).toBe("application/json");
    expect(payload.version).toMatch(/^\d+\.\d+\.\d+/u);
  });

  it("NEGATIVE: a non-canonical chunk index is refused before the index is consulted", async () => {
    const { server, registrations } = captureServer();
    registerResources(server, vault);
    registerChunkResource(server, {} as never, vault);
    const handler = registrations.find((r) => r.name === "vault-chunk")?.handler;

    // The index is a deliberate dummy: validation must reject these BEFORE any
    // index access, so a stub that would throw anyway proves nothing.
    for (const chunkIndex of ["", "007", "+1", "1.5", "-0", "1e3", "0x1"]) {
      const href = `obsidian://chunk/${chunkIndex}/Projects%2Fplan.md`;
      const request = handler!(url(href), { chunkIndex, notePath: "Projects/plan.md" });
      await expect(request, chunkIndex).rejects.toThrow(/Invalid chunk index in URI/u);
    }
  });
});