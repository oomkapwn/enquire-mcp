#!/usr/bin/env bash
# DEPRECATED — one-time bootstrap script from v0.3.x repo-public flip.
#
# Originally configured the GitHub branch ruleset (block deletion +
# force-push + require PR + require CI green) immediately after the repo
# was flipped from private to public on the free GitHub plan.
#
# It has been run ONCE. The ruleset it created lives on at:
#   gh api repos/oomkapwn/enquire-mcp/rulesets
#
# v3.7.18 round-20 audit caught this script as STALE — it still required
# the `test (20)` CI gate (Node 20 was dropped in v3.5.11) and didn't
# require the `docs` gate (added v3.7.10). Running it today would
# DOWNGRADE branch protection. Hence the explicit refusal below.
#
# To inspect or modify the current ruleset, use the GitHub UI
# (Settings → Rules → Rulesets) or `gh api` directly with the live
# JSON state — don't run this archived script.

set -euo pipefail

echo "DEPRECATED: scripts/post-public-setup.sh is a v0.3.x bootstrap artifact."
echo "Running it now would clobber the current main-branch ruleset with"
echo "stale CI-gate requirements (missing 'docs' gate, includes dropped 'test (20)')."
echo ""
echo "To audit / modify the current ruleset, use:"
echo "  gh api repos/oomkapwn/enquire-mcp/rulesets"
echo "or the GitHub UI: Settings → Rules → Rulesets."
exit 1
