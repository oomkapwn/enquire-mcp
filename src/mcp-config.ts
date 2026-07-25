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

/** Fallback package spec for programmatic callers. The CLI supplies its exact
 * running version so setup/doctor/runtime share one package-local model cache. */
export const PKG_SPEC = "@oomkapwn/enquire-mcp@latest";

/** Supported capability tiers shared by configure and doctor. */
export const CONFIG_TIERS = ["basic", "hybrid", "hybrid-live"] as const;

/** Capability tier used by generated MCP configs and readiness diagnostics. */
export type ConfigTier = (typeof CONFIG_TIERS)[number];

/**
 * Test whether an arbitrary CLI/programmatic value is a supported capability
 * tier.
 *
 * @param value - Candidate tier string.
 * @returns True when `value` is one of {@link CONFIG_TIERS}.
 */
export function isConfigTier(value: string): value is ConfigTier {
  return CONFIG_TIERS.includes(value as ConfigTier);
}

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

/** Installation affordance emitted for a generated client configuration. */
export type ClientInstallMode = "command" | "uri" | "copy-only";

/** A client-specific install route plus its user-facing safety boundary. */
export interface ClientInstallAction {
  /** Whether the route is a runnable command, client URI, or manual copy step. */
  mode: ClientInstallMode;
  /** Short explanation printed immediately before the generated config. */
  summary: string;
  /** Generated command or URI when the client exposes a verified route. */
  value?: string;
}

/**
 * Dated source evidence for every client install mode.
 *
 * Keep this map exhaustive: adding a client without classifying its current,
 * official install contract must fail TypeScript rather than silently inherit
 * an invented deeplink. Re-verify when a vendor changes its MCP onboarding.
 */
export const CLIENT_INSTALL_EVIDENCE = {
  "claude-code": {
    checked: "2026-07-25",
    source: "https://code.claude.com/docs/en/mcp#installing-mcp-servers",
    route: "command"
  },
  "claude-desktop": {
    checked: "2026-07-25",
    source: "https://modelcontextprotocol.io/quickstart/user",
    route: "copy-only"
  },
  cursor: {
    checked: "2026-07-25",
    source: "https://cursor.com/docs/mcp",
    route: "copy-only"
  },
  windsurf: {
    checked: "2026-07-25",
    source: "https://docs.windsurf.com/windsurf/cascade/mcp#one-click-install-via-deeplink",
    route: "copy-only"
  },
  vscode: {
    checked: "2026-07-25",
    client: "VS Code 1.130.0 arm64 (`--add-mcp`, isolated user data)",
    source: "https://code.visualstudio.com/api/extension-guides/ai/mcp#create-an-mcp-installation-url",
    route: "uri"
  },
  codex: {
    checked: "2026-07-25",
    client: "codex-cli 0.146.0-alpha.3.1 (`mcp add --help`)",
    source: "https://learn.chatgpt.com/docs/extend/mcp#configure-with-the-cli",
    route: "command"
  },
  http: {
    checked: "2026-07-25",
    source: "https://modelcontextprotocol.io/docs/develop/connect-remote-servers",
    route: "copy-only"
  }
} as const satisfies Record<
  ConfigClient,
  {
    checked: `${number}-${number}-${number}`;
    client?: string;
    source: `https://${string}`;
    route: ClientInstallMode;
  }
>;

// Project safety ceiling, not a vendor-claimed maximum. Oversized definitions
// retain the complete JSON fallback instead of depending on OS URI handling.
const MAX_GENERATED_INSTALL_URI_CHARS = 8_192;

export interface ConfigInput {
  /** Absolute vault path (the caller resolves it). */
  vault: string;
  /** Privacy denylist propagated unchanged to setup, doctor, and runtime. */
  excludeGlobs?: string[];
  /** Privacy allowlist propagated unchanged to setup, doctor, and runtime. */
  readPaths?: string[];
  /** Capability tier → which serve flags the generated config carries. */
  tier: ConfigTier;
  /** MCP server key / name in the client config. */
  name: string;
  /** Emit the serve-http (remote) form instead of stdio. */
  http: boolean;
  /**
   * Exact npm package spec used by every generated setup/doctor/runtime
   * invocation when no physical invocation is supplied.
   */
  packageSpec?: string;
  /**
   * Exact executable identity for CLI-generated configs. When present, every
   * setup/doctor/runtime command uses this command + argument prefix instead of
   * npx resolution, so package-local caches cannot drift with the caller's cwd.
   */
  invocation?: { command: string; argsPrefix: string[] };
  /**
   * Platform whose interactive shell will receive generated copy-paste
   * commands. `win32` emits explicit PowerShell syntax; every other platform
   * emits POSIX-shell syntax. JSON and TOML argument arrays are unaffected.
   */
  platform?: NodeJS.Platform;
  /** Bearer token to put in the serve-http example (http tier only). */
  token?: string;
}

/**
 * Whether a server name is safe in shell, CLI positional, TOML-section, and
 * JSON-key forms.
 *
 * @param name - Candidate MCP server name.
 * @returns True when the name is safe on every generated config surface.
 */
export function isValidServerName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name);
}

function requireValidServerName(name: string): void {
  if (!isValidServerName(name)) {
    throw new Error(
      "MCP server name must start with a letter or digit and contain only letters, digits, dot, underscore, or hyphen"
    );
  }
}

function packageSpec(input: ConfigInput): string {
  return input.packageSpec ?? PKG_SPEC;
}

function npxShellPrefix(input: ConfigInput): string {
  return renderShellCommand("npx", ["-y", packageSpec(input)], input.platform);
}

function invocationShellPrefix(input: ConfigInput): string {
  if (!input.invocation) return npxShellPrefix(input);
  return renderShellCommand(input.invocation.command, input.invocation.argsPrefix, input.platform);
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

/**
 * Build the canonical privacy argument vector shared by setup, doctor, repair
 * hints, and generated runtime configs.
 *
 * @param input - Privacy patterns to preserve across every activation step.
 * @returns Raw CLI arguments; renderers remain responsible for shell quoting.
 */
export function buildPrivacyArgs(input: Pick<ConfigInput, "excludeGlobs" | "readPaths">): string[] {
  const args: string[] = [];
  if (input.excludeGlobs?.length) args.push("--exclude-glob", ...input.excludeGlobs);
  if (input.readPaths?.length) args.push("--read-paths", ...input.readPaths);
  return args;
}

/** The `serve` / `serve-http` argument vector (after the package spec). */
export function buildServeArgs(input: ConfigInput): string[] {
  const sub = input.http ? "serve-http" : "serve";
  return [sub, "--vault", input.vault, ...tierServeFlags(input.tier), ...buildPrivacyArgs(input)];
}

/** The full local-stdio command + args (`npx -y <pkg> serve …`). */
export function npxCommandArgs(input: ConfigInput): { command: string; args: string[] } {
  return { command: "npx", args: ["-y", packageSpec(input), ...buildServeArgs(input)] };
}

/**
 * Build the runtime command and arguments, preferring a caller-supplied
 * physical executable identity.
 *
 * @param input - Validated client-config input.
 * @returns The executable command and argument vector for the selected tier.
 */
export function runtimeCommandArgs(input: ConfigInput): { command: string; args: string[] } {
  if (!input.invocation) return npxCommandArgs(input);
  return {
    command: input.invocation.command,
    args: [...input.invocation.argsPrefix, ...buildServeArgs(input)]
  };
}

/**
 * Quote one argument for a copy-paste command on the selected platform.
 *
 * Windows output deliberately targets PowerShell, whose single-quoted
 * literals escape an apostrophe by doubling it. Other platforms use POSIX
 * single-quote escaping.
 *
 * @param arg - Raw command argument.
 * @param platform - Target platform; `win32` selects PowerShell syntax.
 * @returns A shell-safe representation of the argument.
 */
export function shellQuote(arg: string, platform?: NodeJS.Platform): string {
  if (platform === "win32") {
    return /^[A-Za-z0-9_./\\:-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "''")}'`;
  }
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'"'"'`)}'`;
}

/**
 * Render an executable and argument vector for an interactive shell.
 *
 * A quoted executable is data in PowerShell unless invoked with its call
 * operator, so direct Windows commands receive `&`. Set `executable` to false
 * when the vector is data for another command (notably everything after
 * `claude mcp add … --`), where `&` would become an incorrect extra argument.
 *
 * @param command - Executable path or command name.
 * @param args - Raw argument vector.
 * @param platform - Target platform; `win32` selects PowerShell syntax.
 * @param executable - Whether this vector is executed directly by the shell.
 * @returns A shell-safe copy-paste command fragment.
 */
export function renderShellCommand(
  command: string,
  args: readonly string[],
  platform?: NodeJS.Platform,
  executable = true
): string {
  const rendered = [command, ...args].map((arg) => shellQuote(arg, platform)).join(" ");
  return platform === "win32" && executable ? `& ${rendered}` : rendered;
}

/** TOML basic string with quotes, backslashes, and forbidden controls escaped. */
function tomlStr(s: string): string {
  let escaped = "";
  for (const character of s) {
    const codePoint = character.codePointAt(0) ?? 0;
    switch (character) {
      case "\b":
        escaped += "\\b";
        break;
      case "\t":
        escaped += "\\t";
        break;
      case "\n":
        escaped += "\\n";
        break;
      case "\f":
        escaped += "\\f";
        break;
      case "\r":
        escaped += "\\r";
        break;
      case '"':
        escaped += '\\"';
        break;
      case "\\":
        escaped += "\\\\";
        break;
      default:
        escaped +=
          codePoint <= 0x1f || codePoint === 0x7f ? `\\u${codePoint.toString(16).padStart(4, "0")}` : character;
    }
  }
  return `"${escaped}"`;
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

/**
 * Build the verified install affordance for one generated client config.
 *
 * VS Code's official URI accepts one server definition encoded as JSON.
 * Claude Code and Codex expose CLI installers. Cursor and Windsurf only expose
 * one-click routes for marketplace/registry entries, so an arbitrary
 * vault-specific local command remains explicitly copy-only.
 *
 * @param client - Target MCP client.
 * @param input - Validated vault/runtime configuration.
 * @returns The install mode, explanation, and optional generated command/URI.
 */
export function clientInstallAction(client: ConfigClient, input: ConfigInput): ClientInstallAction {
  requireValidServerName(input.name);
  const { command, args } = runtimeCommandArgs(input);

  switch (client) {
    case "claude-code":
      return {
        mode: "command",
        summary: "Install action: copy and run the command below; Claude Code saves the reviewed entry."
      };
    case "codex":
      return {
        mode: "command",
        summary: "Install action: copy and run this Codex command; the TOML block remains the copy-only fallback.",
        value: `codex mcp add ${input.name} -- ${renderShellCommand(command, args, input.platform, false)}`
      };
    case "vscode": {
      if (input.http) {
        throw new Error("VS Code install URI supports this generated local stdio form only; use --client http");
      }
      const definition = { name: input.name, command, args };
      const value = `vscode:mcp/install?${encodeURIComponent(JSON.stringify(definition))}`;
      if (value.length > MAX_GENERATED_INSTALL_URI_CHARS) {
        return {
          mode: "copy-only",
          summary:
            "Install action: copy-only — this generated definition exceeds enquire's bounded install-URI size; paste the complete JSON block."
        };
      }
      return {
        mode: "uri",
        summary: "Install action: open this URI in VS Code, review the exact command and vault path, then approve.",
        value
      };
    }
    case "claude-desktop":
      return {
        mode: "copy-only",
        summary: "Install action: copy-only — paste the generated block into Claude Desktop's config, then restart."
      };
    case "cursor":
      return {
        mode: "copy-only",
        summary:
          "Install action: copy-only — Cursor one-click installs require a Marketplace entry; paste this vault-specific block."
      };
    case "windsurf":
      return {
        mode: "copy-only",
        summary:
          "Install action: copy-only — Windsurf deeplinks open Registry entries; paste this vault-specific block."
      };
    case "http":
      return {
        mode: "copy-only",
        summary: "Install action: copy-only — start the authenticated endpoint, then add its URL in the remote client."
      };
  }
}

/** Render the config body (no header) for one client. */
export function renderClientBody(client: ConfigClient, input: ConfigInput): string {
  requireValidServerName(input.name);
  if (client === "codex" && input.http) {
    throw new Error("Codex config supports stdio only; use the HTTP client form instead of --client codex --http");
  }
  const { command, args } = runtimeCommandArgs(input);
  const name = input.name;

  if (client === "claude-code") {
    const argumentVector = renderShellCommand(command, args, input.platform, false);
    return `claude mcp add ${name} -- ${argumentVector}`;
  }

  if (client === "claude-desktop" || client === "cursor" || client === "windsurf") {
    return JSON.stringify({ mcpServers: { [name]: { command, args } } }, null, 2);
  }

  if (client === "vscode") {
    return JSON.stringify({ servers: { [name]: { type: "stdio", command, args } } }, null, 2);
  }

  if (client === "codex") {
    const argsToml = `[${args.map(tomlStr).join(", ")}]`;
    return `[mcp_servers.${tomlStr(name)}]\ncommand = ${tomlStr(command)}\nargs = ${argsToml}`;
  }

  // client === "http"
  const httpInput: ConfigInput = { ...input, http: true };
  const prefix = invocationShellPrefix(httpInput);
  const serveHttpCmd = `${prefix} ${buildServeArgs(httpInput)
    .map((arg) => shellQuote(arg, input.platform))
    .join(" ")} --bearer-token ${shellQuote(input.token ?? "<TOKEN>", input.platform)} --port 3000`;
  const url = "http://127.0.0.1:3000/mcp";
  const remoteJson = JSON.stringify(
    { mcpServers: { [name]: { url, headers: { Authorization: `Bearer ${input.token ?? "<TOKEN>"}` } } } },
    null,
    2
  );
  return (
    `# 1. generate a bearer token:  ${prefix} gen-token\n` +
    `# 2. start the HTTP server:\n${serveHttpCmd}\n\n` +
    `# 3. point an HTTP-capable MCP client at it (URL form):\n${remoteJson}`
  );
}

/** Render one client's full block (title + location + body), markdown-fenced. */
export function renderClientConfig(client: ConfigClient, input: ConfigInput): string {
  const meta = clientMeta(client);
  const action = clientInstallAction(client, input);
  const shellFence = input.platform === "win32" ? "powershell" : "bash";
  const fence = client === "codex" ? "toml" : client === "claude-code" || client === "http" ? shellFence : "json";
  const actionValue = action.value
    ? action.mode === "command"
      ? `\n\n\`\`\`${shellFence}\n${action.value}\n\`\`\``
      : `\n${action.value}`
    : "";
  return `## ${meta.title}\n${meta.location}\n\n${action.summary}${actionValue}\n\n\`\`\`${fence}\n${renderClientBody(client, input)}\n\`\`\``;
}

/** Render every client (used when `--client all` / no client given). */
export function renderAllClients(input: ConfigInput): string {
  return CONFIG_CLIENTS.map((c) => renderClientConfig(c, input)).join("\n\n");
}

/** A one-line "what to run first" preflight hint for the chosen tier. */
export function preflightHint(input: ConfigInput): string {
  const prefix = invocationShellPrefix(input);
  const shellLabel = input.platform === "win32" ? " (PowerShell)" : "";
  const command = (args: readonly string[]) =>
    `${prefix} ${args.map((arg) => shellQuote(arg, input.platform)).join(" ")}`;
  const privacyArgs = buildPrivacyArgs(input);
  if (input.tier === "basic") {
    return `Basic tier needs no indexing — it scans the vault live. Verify anytime${shellLabel}: ${command([
      "doctor",
      "--tier",
      "basic",
      "--vault",
      input.vault,
      ...privacyArgs
    ])}`;
  }
  const setupArgs = [
    "setup",
    "--vault",
    input.vault,
    ...(input.tier === "hybrid-live" ? ["--include-pdfs"] : []),
    ...privacyArgs
  ];
  return (
    `Before this works, build the indexes and pre-cache both offline ML models (~120MB embedder + ~110MB reranker)${shellLabel}:\n` +
    `  ${command(setupArgs)}\n` +
    `  ${command(["install-model", "rerank-bge"])}\n` +
    `Then verify readiness:\n` +
    `  ${command(["doctor", "--tier", input.tier, "--vault", input.vault, ...privacyArgs])}`
  );
}
