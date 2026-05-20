#!/usr/bin/env bash
# DEPRECATED — one-time bootstrap script from v0.3.1 (initial public release).
#
# Originally set the GitHub repo's description / homepage / topics +
# created the first GitHub Release. The current repo state (v3.7.x) has
# DIFFERENT topics + description, all updated via `gh repo edit` runs
# documented in CHANGELOG (round-9 / round-11 marketing calibration).
#
# v3.7.18 round-20 audit caught this script as STALE:
#   - Description: v0.3.1 stub ("MCP server for Obsidian vaults...")
#     vs current "The most advanced Obsidian MCP — long-term memory for
#     AI agents..." (gated by `tests/github-metadata-invariant.test.ts`).
#   - Topics: only ~15 v0.3.x topics vs current 20 (8 hype-keyword set
#     from v3.6.3 + 8 keyword set from v3.7.8/9 calibration).
#   - Release: hardcoded to v0.3.1.
#
# Running it today would CLOBBER the current marketing surface with
# stale data. Hence the explicit refusal below.
#
# To inspect / modify the current repo metadata, use:
#   gh repo view oomkapwn/enquire-mcp --json description,homepageUrl,repositoryTopics
# or the GitHub UI.

set -euo pipefail

echo "DEPRECATED: scripts/repo-setup.sh is a v0.3.1 bootstrap artifact."
echo "Running it now would CLOBBER the current repo metadata (description,"
echo "topics, release) with v0.3.x stale values."
echo ""
echo "Current metadata is gated by tests/github-metadata-invariant.test.ts;"
echo "to audit / modify, use:"
echo "  gh repo view oomkapwn/enquire-mcp --json description,homepageUrl,repositoryTopics"
echo "or the GitHub UI."
exit 1
