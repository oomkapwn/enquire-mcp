// v3.11.6-rc.4 — tests for the `enquire configure` MCP client-config generators.
//
// The activation (audit P0) feature: `configure` prints a ready-to-paste config
// for the user's own vault + tier + client. These pure functions carry all the
// logic (the CLI action is a thin wrapper), so they are exhaustively tested here
// with POSITIVE assertions (each client's format is correct + parseable) and
// NEGATIVE controls (a client's format does NOT leak another's shape).

import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  buildPrivacyArgs,
  buildServeArgs,
  CLIENT_INSTALL_EVIDENCE,
  CONFIG_CLIENTS,
  CONFIG_TIERS,
  type ConfigClient,
  type ConfigInput,
  clientInstallAction,
  isConfigTier,
  isValidServerName,
  npxCommandArgs,
  PKG_SPEC,
  preflightHint,
  renderAllClients,
  renderClientBody,
  renderClientConfig,
  renderShellCommand,
  runtimeCommandArgs,
  shellQuote,
  tierServeFlags
} from "../src/mcp-config.js";

const EXACT_SPEC = "@oomkapwn/enquire-mcp@3.12.0-rc.2";
const base: ConfigInput = {
  vault: "/abs/My Vault",
  tier: "hybrid",
  name: "obsidian",
  http: false,
  packageSpec: EXACT_SPEC,
  invocation: { command: "/usr/bin/node", argsPrefix: ["/opt/enquire/dist/index.js"] }
};
const windowsBase: ConfigInput = {
  ...base,
  vault: "C:\\Users\\O'Brien\\Vault & Notes;$(BAD)",
  platform: "win32",
  invocation: {
    command: "C:\\Program Files\\nodejs\\node.exe",
    argsPrefix: ["C:\\Program Files\\enquire's runtime\\dist\\index.js"]
  }
};
const privacyBase: ConfigInput = {
  ...base,
  excludeGlobs: ["Private/**", "semi;colon/**"],
  readPaths: ["Projects/**", "O'Brien.md"]
};

describe("mcp-config — tier flags + serve args", () => {
  it("exports one canonical tier vocabulary for configure and doctor", () => {
    expect(CONFIG_TIERS).toEqual(["basic", "hybrid", "hybrid-live"]);
    expect(CONFIG_TIERS.every(isConfigTier)).toBe(true);
    expect(isConfigTier("tier-1")).toBe(false);
  });
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
  it("uses one lossless privacy vector for generated runtime commands", () => {
    const privacy = buildPrivacyArgs(privacyBase);
    expect(privacy).toEqual([
      "--exclude-glob",
      "Private/**",
      "semi;colon/**",
      "--read-paths",
      "Projects/**",
      "O'Brien.md"
    ]);
    expect(buildServeArgs(privacyBase).slice(-privacy.length)).toEqual(privacy);
    expect(runtimeCommandArgs(privacyBase).args.slice(-privacy.length)).toEqual(privacy);
    // NEGATIVE control: an unfiltered config must not synthesize privacy flags.
    expect(buildPrivacyArgs(base)).toEqual([]);
    expect(buildServeArgs(base)).not.toContain("--exclude-glob");
    expect(buildServeArgs(base)).not.toContain("--read-paths");
  });
  it("rejects privacy inputs that cannot be represented fail-closed", () => {
    expect(() => buildPrivacyArgs({ readPaths: [] })).toThrow(
      new TypeError("Privacy config readPaths must not be an empty allowlist")
    );
    expect(() => buildPrivacyArgs({ readPaths: "Public/**" } as never)).toThrow(
      new TypeError("Privacy config readPaths must be an array of strings")
    );
    expect(() => buildPrivacyArgs({ excludeGlobs: ["Private/**", " "] })).toThrow(
      new TypeError("Privacy config excludeGlobs must not contain an empty pattern")
    );
    expect(buildPrivacyArgs({ excludeGlobs: [] })).toEqual([]);
  });
  it("npxCommandArgs wraps the serve args after the pinned package spec", () => {
    const fallback = { ...base, invocation: undefined };
    const { command, args } = npxCommandArgs(fallback);
    expect(command).toBe("npx");
    expect(args.slice(0, 3)).toEqual(["-y", EXACT_SPEC, "serve"]);
    const physical = runtimeCommandArgs(base);
    expect(physical.command).toBe("/usr/bin/node");
    expect(physical.args.slice(0, 2)).toEqual(["/opt/enquire/dist/index.js", "serve"]);
    expect(runtimeCommandArgs(fallback)).toEqual({ command, args });
    expect(PKG_SPEC).toBe("@oomkapwn/enquire-mcp@latest");
    expect(shellQuote("/abs/My Vault")).toBe("'/abs/My Vault'");
    expect(shellQuote("/abs/vault;touch_BAD")).toBe("'/abs/vault;touch_BAD'");
    expect(shellQuote("/abs/plain-vault")).toBe("/abs/plain-vault");
    expect(shellQuote("C:\\Program Files\\O'Brien & Sons", "win32")).toBe("'C:\\Program Files\\O''Brien & Sons'");
    expect(
      renderShellCommand(
        "C:\\Program Files\\nodejs\\node.exe",
        ["C:\\Program Files\\enquire's runtime\\index.js", "--flag", "$(BAD); & whoami"],
        "win32"
      )
    ).toBe(
      "& 'C:\\Program Files\\nodejs\\node.exe' 'C:\\Program Files\\enquire''s runtime\\index.js' --flag '$(BAD); & whoami'"
    );
    expect(
      renderShellCommand("C:\\Program Files\\nodejs\\node.exe", ["C:\\Program Files\\index.js"], "win32", false)
    ).toBe("'C:\\Program Files\\nodejs\\node.exe' 'C:\\Program Files\\index.js'");
  });
  it("POSIX quoting round-trips through /bin/sh", (ctx) => {
    if (process.platform === "win32") return ctx.skip();
    for (const tricky of ["/abs/Vault!/Notes", "/abs/it's-safe", "$(printf INJECTED);`printf BAD`"]) {
      const roundTrip = execFileSync("/bin/sh", ["-c", `set -- ${shellQuote(tricky)}; printf %s "$1"`], {
        encoding: "utf8"
      });
      expect(roundTrip, tricky).toBe(tricky);
    }
  });
});

describe("mcp-config — per-client rendering", () => {
  it("claude-code emits a one-liner pinned to the exact executable, spaces quoted", () => {
    const body = renderClientBody("claude-code", base);
    expect(body).toMatch(/^claude mcp add obsidian -- \/usr\/bin\/node \/opt\/enquire\/dist\/index\.js /);
    expect(body).toContain("'/abs/My Vault'"); // space-containing path is shell-quoted
    expect(body).not.toContain("mcpServers"); // NEGATIVE: not a JSON client

    const powershell = renderClientBody("claude-code", windowsBase);
    expect(powershell).toContain(
      "claude mcp add obsidian -- 'C:\\Program Files\\nodejs\\node.exe' 'C:\\Program Files\\enquire''s runtime\\dist\\index.js'"
    );
    expect(powershell).toContain("'C:\\Users\\O''Brien\\Vault & Notes;$(BAD)'");
    expect(powershell).not.toContain("-- & "); // `&` would be an argument to Claude, not a call operator.
    expect(powershell).not.toContain(`'"'"'`); // NEGATIVE: never leak POSIX apostrophe escaping into PowerShell.
    const npxArgumentVector = renderClientBody("claude-code", { ...windowsBase, invocation: undefined });
    expect(npxArgumentVector).toContain(`claude mcp add obsidian -- npx -y '${EXACT_SPEC}' serve`);
    expect(npxArgumentVector).not.toContain("-- & npx");
  });

  it("claude-desktop / cursor / windsurf emit parseable `mcpServers` JSON with command+args", () => {
    for (const client of ["claude-desktop", "cursor", "windsurf"] as ConfigClient[]) {
      const parsed = JSON.parse(renderClientBody(client, base)) as {
        mcpServers: Record<string, { command: string; args: string[] }>;
      };
      expect(parsed.mcpServers.obsidian?.command).toBe("/usr/bin/node");
      expect(parsed.mcpServers.obsidian?.args[0]).toBe("/opt/enquire/dist/index.js");
      expect(parsed.mcpServers.obsidian?.args).toContain("/abs/My Vault"); // native JSON string, NOT shell-quoted
      // NEGATIVE: the stdio JSON clients don't carry VS Code's `type`/`servers` shape.
      expect(parsed).not.toHaveProperty("servers");
    }
    const windowsJson = JSON.parse(renderClientBody("cursor", windowsBase)) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(windowsJson.mcpServers.obsidian).toEqual({
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: [
        "C:\\Program Files\\enquire's runtime\\dist\\index.js",
        "serve",
        "--vault",
        "C:\\Users\\O'Brien\\Vault & Notes;$(BAD)",
        "--persistent-index",
        "--enable-reranker",
        "--use-hnsw"
      ]
    });
    expect(renderClientBody("cursor", windowsBase)).not.toContain("& 'C:\\Program Files"); // JSON is not shell syntax.
  });

  it("vscode emits `servers` (not mcpServers) with type:stdio", () => {
    const parsed = JSON.parse(renderClientBody("vscode", base)) as {
      servers: Record<string, { type: string; command: string; args: string[] }>;
    };
    expect(parsed.servers.obsidian?.type).toBe("stdio");
    expect(parsed.servers.obsidian?.command).toBe("/usr/bin/node");
    // NEGATIVE control: VS Code does NOT use the mcpServers key.
    expect(parsed).not.toHaveProperty("mcpServers");
  });

  it("codex emits a TOML [mcp_servers.<name>] block with quoted args", () => {
    const body = renderClientBody("codex", base);
    expect(body).toContain('[mcp_servers."obsidian"]');
    expect(body).toMatch(/command = "\/usr\/bin\/node"/);
    expect(body).toMatch(/args = \[/);
    expect(body).toContain('"/abs/My Vault"'); // TOML string, quoted
    expect(body).not.toContain("{"); // NEGATIVE: TOML, not JSON
    const windowsToml = renderClientBody("codex", windowsBase);
    expect(windowsToml).toContain('command = "C:\\\\Program Files\\\\nodejs\\\\node.exe"');
    expect(windowsToml).toContain('"C:\\\\Users\\\\O\'Brien\\\\Vault & Notes;$(BAD)"');
    expect(windowsToml).not.toContain('command = "& ');

    const controlToml = renderClientBody("codex", {
      ...base,
      vault: "/abs/line\nwith\ttab\u0001and\u007fdel"
    });
    const argsLine = controlToml.split("\n").find((line) => line.startsWith("args = ")) ?? "";
    expect(argsLine).toContain('"/abs/line\\nwith\\ttab\\u0001and\\u007fdel"');
    expect(argsLine).not.toContain("\u0001");
    expect(argsLine).not.toContain("\u007f");
    expect(() => renderClientBody("codex", { ...base, http: true })).toThrow(/stdio only/);
  });

  it("preserves privacy arrays as native args in JSON clients", () => {
    const parsed = JSON.parse(renderClientBody("cursor", privacyBase)) as {
      mcpServers: Record<string, { args: string[] }>;
    };
    const args = parsed.mcpServers.obsidian?.args ?? [];
    expect(args.slice(-6)).toEqual(buildPrivacyArgs(privacyBase));
    expect(args).toContain("O'Brien.md");
    // NEGATIVE control: JSON args are raw values, never shell-quoted copies.
    expect(args).not.toContain(`'O'"'"'Brien.md'`);
  });

  it("http tier explains the serve-http bearer flow + a URL-form config", () => {
    const body = renderClientBody("http", { ...base, token: "SECRETTOKEN" });
    expect(body).toMatch(/gen-token/);
    expect(body).toMatch(/serve-http/);
    expect(body).toContain("Bearer SECRETTOKEN");
    expect(body).toContain("http://127.0.0.1:3000/mcp");
    const placeholder = renderClientBody("http", base);
    expect(placeholder).toContain("--bearer-token '<TOKEN>'");
    expect(renderClientBody("http", { ...base, token: "safe;touch_BAD" })).toContain("--bearer-token 'safe;touch_BAD'");
    const powershell = renderClientBody("http", { ...windowsBase, token: "tok'en;&$(BAD)" });
    expect(powershell).toContain("\n& 'C:\\Program Files\\nodejs\\node.exe'");
    expect(powershell).toContain("--bearer-token 'tok''en;&$(BAD)'");
    expect(powershell).not.toContain(`'"'"'`);
  });

  it("respects a custom server --name across every client", () => {
    const named: ConfigInput = { ...base, name: "myvault" };
    expect(renderClientBody("claude-code", named)).toContain("claude mcp add myvault");
    expect(renderClientBody("cursor", named)).toContain('"myvault"');
    expect(renderClientBody("vscode", named)).toContain('"myvault"');
    expect(renderClientBody("codex", named)).toContain('[mcp_servers."myvault"]');
    expect(renderClientBody("codex", { ...named, name: "safe.name" })).toContain('[mcp_servers."safe.name"]');
    expect(renderClientBody("codex", { ...named, name: "safe.name" })).not.toContain("[mcp_servers.safe.name]");
    expect(isValidServerName("safe.name_1-x")).toBe(true);
    for (const unsafe of [
      "",
      "--help",
      "-scope",
      ".hidden",
      "safe;touch_BAD",
      "name with spaces",
      'x]\ncommand="evil"'
    ]) {
      expect(isValidServerName(unsafe), unsafe).toBe(false);
      expect(() => renderClientBody("claude-code", { ...base, name: unsafe }), unsafe).toThrow(/server name/);
      expect(() => renderClientBody("codex", { ...base, name: unsafe }), unsafe).toThrow(/server name/);
    }
  });

  it("renderClientConfig wraps the body in a titled, correctly-fenced block", () => {
    expect(renderClientConfig("codex", base)).toContain("```toml");
    expect(renderClientConfig("codex", base)).toContain("codex mcp add obsidian -- /usr/bin/node");
    const windowsCodexAction = clientInstallAction("codex", windowsBase);
    expect(windowsCodexAction.value).toContain(
      "codex mcp add obsidian -- 'C:\\Program Files\\nodejs\\node.exe' 'C:\\Program Files\\enquire''s runtime\\dist\\index.js'"
    );
    expect(windowsCodexAction.value).not.toContain("-- & "); // command vector is data for `codex mcp add`.
    expect(renderClientConfig("cursor", base)).toContain("```json");
    expect(renderClientConfig("cursor", base)).toContain("copy-only");
    expect(renderClientConfig("claude-code", base)).toContain("```bash");
    expect(renderClientConfig("claude-code", windowsBase)).toContain("```powershell");
    expect(renderClientConfig("http", windowsBase)).toContain("```powershell");
    expect(renderClientConfig("cursor", windowsBase)).toContain("```json");

    const vscodeAction = clientInstallAction("vscode", base);
    expect(vscodeAction.mode).toBe("uri");
    expect(vscodeAction.value).toMatch(/^vscode:mcp\/install\?/);
    const encodedDefinition = vscodeAction.value?.slice("vscode:mcp/install?".length) ?? "";
    expect(JSON.parse(decodeURIComponent(encodedDefinition))).toEqual({
      name: "obsidian",
      command: "/usr/bin/node",
      args: runtimeCommandArgs(base).args
    });
    expect(renderClientConfig("vscode", base)).toContain(vscodeAction.value);

    // NEGATIVE controls: marketplace/registry-only clients must never receive
    // an invented vault-bearing deeplink, and HTTP must not masquerade as a
    // local VS Code install URI.
    for (const client of ["claude-desktop", "cursor", "windsurf", "http"] as ConfigClient[]) {
      const action = clientInstallAction(client, base);
      expect(action.mode, client).toBe("copy-only");
      expect(action.value, client).toBeUndefined();
    }
    expect(() => clientInstallAction("vscode", { ...base, http: true })).toThrow(/local stdio/);
    const oversizedVscodeAction = clientInstallAction("vscode", {
      ...base,
      excludeGlobs: [`Private/${"x".repeat(8_192)}`]
    });
    expect(oversizedVscodeAction.mode).toBe("copy-only");
    expect(oversizedVscodeAction.value).toBeUndefined();
    expect(renderClientConfig("vscode", { ...base, excludeGlobs: [`Private/${"x".repeat(8_192)}`] })).toContain(
      '"--exclude-glob"'
    );
    expect(Object.keys(CLIENT_INSTALL_EVIDENCE).sort()).toEqual([...CONFIG_CLIENTS].sort());
    expect(Object.values(CLIENT_INSTALL_EVIDENCE).every((evidence) => evidence.checked === "2026-07-25")).toBe(true);
    expect(CLIENT_INSTALL_EVIDENCE.vscode.client).toContain("1.130.0");
    expect(CLIENT_INSTALL_EVIDENCE.codex.client).toContain("0.146.0-alpha.3.1");
    expect(Object.values(CLIENT_INSTALL_EVIDENCE).map((evidence) => evidence.route)).toEqual(
      CONFIG_CLIENTS.map((client) => clientInstallAction(client, base).mode)
    );
  });

  it("renderAllClients includes every declared client exactly once", () => {
    const all = renderAllClients(base);
    // one `## ` section header per client (proves all rendered, none duplicated).
    expect((all.match(/^## /gm) ?? []).length).toBe(CONFIG_CLIENTS.length);
    // Spot-check the distinctive markers for each format are all present.
    expect(all).toContain("claude mcp add"); // claude-code
    expect(all).toContain('"mcpServers"'); // desktop/cursor/windsurf
    expect(all).toContain('"servers"'); // vscode
    expect(all).toContain('[mcp_servers."obsidian"]'); // codex
    expect(all).toContain("serve-http"); // http
  });
});

describe("mcp-config — preflight hint", () => {
  it("hybrid builds indexes, pre-caches its offline reranker, then verifies the same tier", () => {
    const hint = preflightHint(base);
    expect(hint).toContain("/usr/bin/node /opt/enquire/dist/index.js setup --vault");
    expect(hint).not.toContain("--include-pdfs");
    expect(hint).toContain("/usr/bin/node /opt/enquire/dist/index.js install-model rerank-bge");
    expect(hint).toContain("/usr/bin/node /opt/enquire/dist/index.js doctor --tier hybrid --vault");
    expect(hint).not.toMatch(/(?:^|\n)\s*enquire-mcp /);
    expect(renderClientBody("cursor", base)).toContain("/opt/enquire/dist/index.js");
    expect(renderClientBody("cursor", base)).not.toContain(EXACT_SPEC);

    const powershell = preflightHint(windowsBase);
    expect(powershell).toContain("(PowerShell):");
    expect(powershell).toContain(
      "& 'C:\\Program Files\\nodejs\\node.exe' 'C:\\Program Files\\enquire''s runtime\\dist\\index.js' setup"
    );
    expect(powershell).toContain("--vault 'C:\\Users\\O''Brien\\Vault & Notes;$(BAD)'");
    expect(powershell).not.toContain(`'"'"'`);
    expect(powershell).not.toMatch(/(?:^|\n)\s*'C:\\Program Files\\nodejs\\node\.exe'/); // missing `&` is not executable.
    expect(preflightHint({ ...windowsBase, invocation: undefined })).toContain(`& npx -y '${EXACT_SPEC}' setup`);
  });
  it("hybrid-live includes PDFs and verifies hybrid-live", () => {
    const hint = preflightHint({ ...base, tier: "hybrid-live" });
    expect(hint).toMatch(/\/usr\/bin\/node .* setup --vault .* --include-pdfs/);
    expect(hint).toContain("/opt/enquire/dist/index.js install-model rerank-bge");
    expect(hint).toContain("/opt/enquire/dist/index.js doctor --tier hybrid-live --vault");
  });
  it("propagates the same privacy policy through setup and doctor hints", () => {
    const hint = preflightHint(privacyBase);
    const expectedPrivacy = "--exclude-glob 'Private/**' 'semi;colon/**' --read-paths 'Projects/**' 'O'\"'\"'Brien.md'";
    expect(hint.match(/--exclude-glob/g)).toHaveLength(2);
    expect(hint.match(/--read-paths/g)).toHaveLength(2);
    expect(hint).toContain(`setup --vault '/abs/My Vault' ${expectedPrivacy}`);
    expect(hint).toContain(`doctor --tier hybrid --vault '/abs/My Vault' ${expectedPrivacy}`);
    // NEGATIVE control: install-model is vault-independent and carries no privacy args.
    expect(hint).toMatch(/install-model rerank-bge\nThen verify/);
  });
  it("NEGATIVE control — basic tier does NOT tell the user to run setup", () => {
    const hint = preflightHint({ ...base, tier: "basic" });
    expect(hint).not.toMatch(/ setup/);
    expect(hint).not.toContain("install-model rerank-bge");
    expect(hint).toContain("/opt/enquire/dist/index.js doctor --tier basic");
    expect(hint).toMatch(/no indexing/i);
  });
});
