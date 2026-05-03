#!/usr/bin/env bash
# One-shot GitHub repo polish: description, homepage, topics, and create the latest release.
# Run after `gh auth login` (GH CLI not authenticated on this machine).

set -euo pipefail

REPO="oomkapwn/enquire-mcp"

echo "== Setting description + homepage =="
gh repo edit "$REPO" \
  --description "enquire — MCP server for Obsidian vaults. Wikilinks, backlinks, frontmatter, basic Dataview, MCP resources & prompts. Read-only by default; opt-in writes. For Claude Code, Cursor, Codex, Devin and any MCP-compatible client." \
  --homepage "https://www.npmjs.com/package/@oomkapwn/enquire-mcp"

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
echo
echo "MANUAL STEP — Social preview image:"
echo "  GitHub doesn't expose a 'set social preview' API, so this one needs"
echo "  the web UI:"
echo "    1. https://github.com/$REPO/settings"
echo "    2. Scroll to 'Social preview' → 'Edit' → 'Upload an image…'"
echo "    3. Pick assets/social-preview.png from the repo (1280×640, ~150kB)."
echo "  Regenerate with: npm run render:preview"
