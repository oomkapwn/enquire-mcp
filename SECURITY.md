# Security policy

## Reporting a vulnerability

If you've found a security issue in obsidian-mcp, **please don't open a public GitHub issue**. Instead:

1. Email the maintainer at `oomkapwn@gmail.com` with the subject `obsidian-mcp security`.
2. Include a reproducer if you have one — vault layout, exact CLI flags, the operation that triggered the issue.
3. Expect an acknowledgement within 72 hours.

I'll work on a fix in private, cut a patch release, and then publicly disclose with credit (or anonymously, your call).

## Scope

In scope:
- Path traversal, symlink-escape, or any way to read/write files outside the configured vault root
- Resource exhaustion (DoS) via crafted markdown, frontmatter, or DQL input
- Unintended code execution via YAML, regex, or input parsing
- Cache or memory issues that grow unbounded under attacker-controlled input

Out of scope (won't accept reports):
- Behavior controlled by `--enable-write` — yes, write tools can write notes; that's the point. Reports here need to show writes outside the vault or other privilege escalation.
- Issues that require a malicious MCP client (the client is the trusted party; if it's compromised, all bets are off).
- Vulnerabilities in dependencies — please report those upstream first.

## Supported versions

Only the latest minor release receives security patches. We bump the patch version for security fixes and call them out clearly in [CHANGELOG.md](./CHANGELOG.md).

## Hardening already in place

- Realpath-based check on every read and write target — symlinks inside the vault that resolve outside are rejected.
- Walker skips symlinks entirely.
- Default 5 MB cap on any single file read or write (configurable via `--max-file-bytes`).
- Bounded parsed-note cache (default 1024 entries, LRU eviction).
- Read-only by default; write tools require an explicit CLI flag.
- YAML parsed via `gray-matter` (`js-yaml` safeLoad) — no code execution.
- DQL parser respects quoted strings; no shell, no `eval`, no template expansion.
