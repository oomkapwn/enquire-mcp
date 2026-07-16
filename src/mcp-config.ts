// v3.11.6-rc.4 — MCP client-config generators for `enquire-mcp configure`.
//
// The activation gap the 2026-07-15 external audit named as the #1 P0: a user
// who has installed enquire-mcp still has to hand-assemble the right MCP config
// for their client (Claude Code / Cursor / VS Code / Codex / …), with the right
// vault path, the right flags, and the right file location + top-level key —
// which differs per client. `configure` closes that: one command emits a
// ready-to-paste config for the user's own vault + capability tier + client.
//
// These functions are PURE (no fs, no process) so they are exhaustively unit
// tested without spawning anything. The CLI action (src/cli.ts) is a thin
// wrapper that resolves the vault path and prints the rendered string.
//
// Client config formats verified against the vendors' current docs (2026-07):
//   • Claude Code   — `claude mcp add <name> -- <cmd> <args…>` (CLI)
//   • Claude Desktop / Cursor / Windsurf — `{ "mcpServers": { "<name>": { command, args, env? } } }`
//   • VS Code       — `.vscode/mcp.json` → `{ "servers": { "<name>": { "type": "stdio", command, args } } }`
//   • Codex CLI     — `~/.codex/config.toml` → `[mcp_servers.<name>]` command + args (stdio only)
//   • HTTP / remote — `serve-http` + bearer token; streamable-HTTP URL form

/** Package spec used in generated `npx` invocations. `@latest` pins nothing but
 *  always resolves the newest published — the right default for a copy-paste. */
export const PKG_SPEC = "@oomkapwn/enquire-mcp@latest";

export type ConfigTier = "basic" | "hybrid" | "hybrid-live";

export const CONFIG_CLIENTS = [
  "claude-code",
  "claude-desktop",
  "cursor",
  "windsurf",
  "vscode",
  "codex",
  "http"
] as const;
export type ConfigClient = (typeof CONFIG_CLIENTS)[number];

export interface ConfigInput {
  /** Absolute vault path (the caller resolves it). */
  vault: string;
  /** Capability tier → which serve flags the generated config carries. */
  tier: ConfigTier;
  /** MCP server key / name in the client config. */
  name: string;
  /** Emit the serve-http (remote) form instead of stdio. */
  http: boolean;
  /** Bearer token to put in the serve-http example (http tier only). */
  token?: string;
}

/** The retrieval flags a tier adds to `serve`. `basic` = scan mode (no setup
 *  required); `hybrid` = persistent FTS5 + reranker + HNSW (needs `setup`);
 *  `hybrid-live` = hybrid + PDFs + a filesystem watcher for live re-index. */
export function tierServeFlags(tier: ConfigTier): string[] {
  switch (tier) {
    case "basic":
      return [];
    case "hybrid":
      return ["--persistent-index", "--enable-reranker", "--use-hnsw"];
    case "hybrid-live":
      return ["--persistent-index", "--enable-reranker", "--use-hnsw", "--include-pdfs", "--watch"];
  }
}

/** The `serve` / `serve-http` argument vector (after the package spec). */
export function buildServeArgs(input: ConfigInput): string[] {
  const sub = input.http ? "serve-http" : "serve";
  return [sub, "--vault", input.vault, ...tierServeFlags(input.tier)];
}

/** The full local-stdio command + args (`npx -y <pkg> serve …`). */
export function npxCommandArgs(input: ConfigInput): { command: string; args: string[] } {
  return { command: "npx", args: ["-y", PKG_SPEC, ...buildServeArgs(input)] };
}

/** Shell-quote a single argument if it contains whitespace (for CLI forms). */
function shQuote(arg: string): string {
  return /\s/.test(arg) ? `"${arg.replace(/(["\\$`])/g, "\\$1")}"` : arg;
}

/** TOML string literal (basic string, backslash + quote escaped). */
function tomlStr(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Human title + where the config goes, per client. */
export function clientMeta(client: ConfigClient): { title: string; location: string } {
  switch (client) {
    case "claude-code":
      return { title: "Claude Code (terminal)", location: "run this once; it updates your Claude Code MCP config" };
    case "claude-desktop":
      return {
        title: "Claude Desktop",
        location: "add to claude_desktop_config.json (Settings → Developer → Edit Config), then restart"
      };
    case "cursor":
      return { title: "Cursor", location: "~/.cursor/mcp.json (or a project .cursor/mcp.json)" };
    case "windsurf":
      return { title: "Windsurf", location: "~/.codeium/windsurf/mcp_config.json" };
    case "vscode":
      return { title: "VS Code", location: ".vscode/mcp.json (workspace) or your user mcp.json" };
    case "codex":
      return { title: "Codex CLI", location: "~/.codex/config.toml (stdio servers only)" };
    case "http":
      return {
        title: "Remote / HTTP (ChatGPT, claude.ai, mobile)",
        location: "run serve-http; point the client at the URL"
      };
  }
}

/** Render the config body (no header) for one client. */
export function renderClientBody(client: ConfigClient, input: ConfigInput): string {
  const { command, args } = npxCommandArgs(input);
  const name = input.name;

  if (client === "claude-code") {
    const argStr = buildServeArgs(input).map(shQuote).join(" ");
    return `claude mcp add ${name} -- npx -y ${PKG_SPEC} ${argStr}`;
  }

  if (client === "claude-desktop" || client === "cursor" || client === "windsurf") {
    return JSON.stringify({ mcpServers: { [name]: { command, args } } }, null, 2);
  }

  if (client === "vscode") {
    return JSON.stringify({ servers: { [name]: { type: "stdio", command, args } } }, null, 2);
  }

  if (client === "codex") {
    const argsToml = `[${args.map(tomlStr).join(", ")}]`;
    return `[mcp_servers.${name}]\ncommand = ${tomlStr(command)}\nargs = ${argsToml}`;
  }

  // client === "http"
  const httpInput: ConfigInput = { ...input, http: true };
  const serveHttpCmd = `enquire-mcp ${buildServeArgs(httpInput).map(shQuote).join(" ")} --bearer-token ${input.token ?? "<TOKEN>"} --port 3000`;
  const url = "http://127.0.0.1:3000/mcp";
  const remoteJson = JSON.stringify(
    { mcpServers: { [name]: { url, headers: { Authorization: `Bearer ${input.token ?? "<TOKEN>"}` } } } },
    null,
    2
  );
  return (
    `# 1. generate a bearer token:  enquire-mcp gen-token\n` +
    `# 2. start the HTTP server:\n${serveHttpCmd}\n\n` +
    `# 3. point an HTTP-capable MCP client at it (URL form):\n${remoteJson}`
  );
}

/** Render one client's full block (title + location + body), markdown-fenced. */
export function renderClientConfig(client: ConfigClient, input: ConfigInput): string {
  const meta = clientMeta(client);
  const fence = client === "codex" ? "toml" : client === "claude-code" || client === "http" ? "bash" : "json";
  return `## ${meta.title}\n${meta.location}\n\n\`\`\`${fence}\n${renderClientBody(client, input)}\n\`\`\``;
}

/** Render every client (used when `--client all` / no client given). */
export function renderAllClients(input: ConfigInput): string {
  return CONFIG_CLIENTS.map((c) => renderClientConfig(c, input)).join("\n\n");
}

/** A one-line "what to run first" preflight hint for the chosen tier. */
export function preflightHint(input: ConfigInput): string {
  if (input.tier === "basic") {
    return `Basic tier needs no indexing — it scans the vault live. Verify anytime: enquire-mcp doctor --vault ${shQuote(input.vault)}`;
  }
  return (
    `Before this works, build the indexes once (downloads a ~110MB model, builds FTS5 + embed-db):\n` +
    `  enquire-mcp setup --vault ${shQuote(input.vault)}\n` +
    `Then verify readiness:\n` +
    `  enquire-mcp doctor --vault ${shQuote(input.vault)}`
  );
}
