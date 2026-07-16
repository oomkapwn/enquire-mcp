// v3.11.6-rc.4 — tests for the `enquire configure` MCP client-config generators.
//
// The activation (audit P0) feature: `configure` prints a ready-to-paste config
// for the user's own vault + tier + client. These pure functions carry all the
// logic (the CLI action is a thin wrapper), so they are exhaustively tested here
// with POSITIVE assertions (each client's format is correct + parseable) and
// NEGATIVE controls (a client's format does NOT leak another's shape).

import { describe, expect, it } from "vitest";
import {
  buildServeArgs,
  CONFIG_CLIENTS,
  type ConfigClient,
  type ConfigInput,
  npxCommandArgs,
  PKG_SPEC,
  preflightHint,
  renderAllClients,
  renderClientBody,
  renderClientConfig,
  tierServeFlags
} from "../src/mcp-config.js";

const base: ConfigInput = { vault: "/abs/My Vault", tier: "hybrid", name: "obsidian", http: false };

describe("mcp-config — tier flags + serve args", () => {
  it("basic tier adds no retrieval flags (live scan, zero setup)", () => {
    expect(tierServeFlags("basic")).toEqual([]);
  });
  it("hybrid tier adds persistent-index + reranker + hnsw", () => {
    expect(tierServeFlags("hybrid")).toEqual(["--persistent-index", "--enable-reranker", "--use-hnsw"]);
  });
  it("hybrid-live adds PDFs + watch on top of hybrid", () => {
    expect(tierServeFlags("hybrid-live")).toEqual([
      "--persistent-index",
      "--enable-reranker",
      "--use-hnsw",
      "--include-pdfs",
      "--watch"
    ]);
  });
  it("buildServeArgs uses `serve` for stdio and `serve-http` for http", () => {
    expect(buildServeArgs(base)[0]).toBe("serve");
    expect(buildServeArgs({ ...base, http: true })[0]).toBe("serve-http");
    expect(buildServeArgs(base)).toContain("--vault");
    expect(buildServeArgs(base)).toContain("/abs/My Vault");
  });
  it("npxCommandArgs wraps the serve args after the pinned package spec", () => {
    const { command, args } = npxCommandArgs(base);
    expect(command).toBe("npx");
    expect(args.slice(0, 3)).toEqual(["-y", PKG_SPEC, "serve"]);
  });
});

describe("mcp-config — per-client rendering", () => {
  it("claude-code emits a `claude mcp add … -- npx …` one-liner, spaces quoted", () => {
    const body = renderClientBody("claude-code", base);
    expect(body).toMatch(/^claude mcp add obsidian -- npx -y /);
    expect(body).toContain('"/abs/My Vault"'); // space-containing path is shell-quoted
    expect(body).not.toContain("mcpServers"); // NEGATIVE: not a JSON client
  });

  it("claude-desktop / cursor / windsurf emit parseable `mcpServers` JSON with command+args", () => {
    for (const client of ["claude-desktop", "cursor", "windsurf"] as ConfigClient[]) {
      const parsed = JSON.parse(renderClientBody(client, base)) as {
        mcpServers: Record<string, { command: string; args: string[] }>;
      };
      expect(parsed.mcpServers.obsidian?.command).toBe("npx");
      expect(parsed.mcpServers.obsidian?.args).toContain("/abs/My Vault"); // native JSON string, NOT shell-quoted
      // NEGATIVE: the stdio JSON clients don't carry VS Code's `type`/`servers` shape.
      expect(parsed).not.toHaveProperty("servers");
    }
  });

  it("vscode emits `servers` (not mcpServers) with type:stdio", () => {
    const parsed = JSON.parse(renderClientBody("vscode", base)) as {
      servers: Record<string, { type: string; command: string; args: string[] }>;
    };
    expect(parsed.servers.obsidian?.type).toBe("stdio");
    expect(parsed.servers.obsidian?.command).toBe("npx");
    // NEGATIVE control: VS Code does NOT use the mcpServers key.
    expect(parsed).not.toHaveProperty("mcpServers");
  });

  it("codex emits a TOML [mcp_servers.<name>] block with quoted args", () => {
    const body = renderClientBody("codex", base);
    expect(body).toContain("[mcp_servers.obsidian]");
    expect(body).toMatch(/command = "npx"/);
    expect(body).toMatch(/args = \[/);
    expect(body).toContain('"/abs/My Vault"'); // TOML string, quoted
    expect(body).not.toContain("{"); // NEGATIVE: TOML, not JSON
  });

  it("http tier explains the serve-http bearer flow + a URL-form config", () => {
    const body = renderClientBody("http", { ...base, token: "SECRETTOKEN" });
    expect(body).toMatch(/gen-token/);
    expect(body).toMatch(/serve-http/);
    expect(body).toContain("Bearer SECRETTOKEN");
    expect(body).toContain("http://127.0.0.1:3000/mcp");
  });

  it("respects a custom server --name across every client", () => {
    const named: ConfigInput = { ...base, name: "myvault" };
    expect(renderClientBody("claude-code", named)).toContain("claude mcp add myvault");
    expect(renderClientBody("cursor", named)).toContain('"myvault"');
    expect(renderClientBody("vscode", named)).toContain('"myvault"');
    expect(renderClientBody("codex", named)).toContain("[mcp_servers.myvault]");
  });

  it("renderClientConfig wraps the body in a titled, correctly-fenced block", () => {
    expect(renderClientConfig("codex", base)).toContain("```toml");
    expect(renderClientConfig("cursor", base)).toContain("```json");
    expect(renderClientConfig("claude-code", base)).toContain("```bash");
  });

  it("renderAllClients includes every declared client exactly once", () => {
    const all = renderAllClients(base);
    // one `## ` section header per client (proves all rendered, none duplicated).
    expect((all.match(/^## /gm) ?? []).length).toBe(CONFIG_CLIENTS.length);
    // Spot-check the distinctive markers for each format are all present.
    expect(all).toContain("claude mcp add"); // claude-code
    expect(all).toContain('"mcpServers"'); // desktop/cursor/windsurf
    expect(all).toContain('"servers"'); // vscode
    expect(all).toContain("[mcp_servers.obsidian]"); // codex
    expect(all).toContain("serve-http"); // http
  });
});

describe("mcp-config — preflight hint", () => {
  it("hybrid tier tells the user to run setup first", () => {
    expect(preflightHint(base)).toMatch(/enquire-mcp setup --vault/);
    expect(preflightHint(base)).toMatch(/enquire-mcp doctor --vault/);
  });
  it("NEGATIVE control — basic tier does NOT tell the user to run setup", () => {
    const hint = preflightHint({ ...base, tier: "basic" });
    expect(hint).not.toMatch(/enquire-mcp setup/);
    expect(hint).toMatch(/no indexing/i);
  });
});
