#!/usr/bin/env bash
# One-shot GitHub repo polish: description, homepage, topics, and the v0.3.1 release.
# Run after `gh auth login` (GH CLI not authenticated on this machine).

set -euo pipefail

REPO="oomkapwn/obsidian-mcp"

echo "== Setting description + homepage =="
gh repo edit "$REPO" \
  --description "MCP server for Obsidian vaults — wikilinks, backlinks, frontmatter, tags, basic Dataview. Read-only by default; opt-in writes. For Claude Code, Cursor, Devin." \
  --homepage "https://www.npmjs.com/package/@oomkapwn/obsidian-mcp"

echo "== Setting topics =="
gh repo edit "$REPO" \
  --add-topic mcp \
  --add-topic model-context-protocol \
  --add-topic obsidian \
  --add-topic claude \
  --add-topic claude-code \
  --add-topic cursor \
  --add-topic typescript \
  --add-topic markdown \
  --add-topic wikilinks \
  --add-topic backlinks \
  --add-topic dataview \
  --add-topic frontmatter \
  --add-topic pkm \
  --add-topic knowledge-management \
  --add-topic ai-agent

echo "== Enabling Discussions (for the FAQ link in issue templates) =="
gh repo edit "$REPO" --enable-discussions

echo "== Creating GitHub Release for v0.3.1 =="
RELEASE_NOTES=$(awk '
  /^## \[0\.3\.1\]/ { capture=1; next }
  /^## \[/ && capture { exit }
  capture { print }
' CHANGELOG.md)

gh release create v0.3.1 \
  --repo "$REPO" \
  --title "v0.3.1 — audit pass, launch-ready hardening + docs" \
  --notes "$RELEASE_NOTES"

echo
echo "Done. Verify at https://github.com/$REPO"
