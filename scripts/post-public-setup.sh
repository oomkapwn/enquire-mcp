#!/usr/bin/env bash
# Settings that GitHub gates behind a public repo on the free plan.
# Run once, immediately after you flip the repo public.
# Requires `gh auth login`.

set -euo pipefail
REPO="oomkapwn/enquire-mcp"

echo "== Verifying repo is public =="
VIS=$(gh repo view "$REPO" --json visibility -q .visibility)
if [ "$VIS" != "PUBLIC" ]; then
  echo "Repo is still $VIS. Flip to public first, then re-run."
  exit 1
fi

echo "== Branch ruleset for main: block deletion + force-push + require PR + require CI =="
gh api -X POST "repos/$REPO/rulesets" \
  -H "Accept: application/vnd.github+json" \
  --input - <<'EOF'
{
  "name": "main-protection",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": false
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": false,
        "required_status_checks": [
          { "context": "lint",      "integration_id": 15368 },
          { "context": "test (20)", "integration_id": 15368 },
          { "context": "test (22)", "integration_id": 15368 },
          { "context": "test (24)", "integration_id": 15368 },
          { "context": "smoke",     "integration_id": 15368 },
          { "context": "audit",     "integration_id": 15368 },
          { "context": "coverage",  "integration_id": 15368 }
        ]
      }
    }
  ],
  "bypass_actors": [
    { "actor_type": "RepositoryRole", "actor_id": 5, "bypass_mode": "always" }
  ]
}
EOF

echo "== Allow auto-merge (rejected on private free) =="
gh api -X PATCH "repos/$REPO" -F allow_auto_merge=true >/dev/null

echo "== Enable private vulnerability reporting (matches SECURITY.md) =="
gh api -X PUT "repos/$REPO/private-vulnerability-reporting" >/dev/null

echo "== Enable secret scanning push protection =="
gh api -X PATCH "repos/$REPO" \
  -H "Accept: application/vnd.github+json" \
  --input - <<'EOF' >/dev/null
{
  "security_and_analysis": {
    "secret_scanning": { "status": "enabled" },
    "secret_scanning_push_protection": { "status": "enabled" }
  }
}
EOF

echo
echo "Done. Verify at https://github.com/$REPO/settings/rules"
echo
echo "MANUAL STEPS — must use the web UI:"
echo "  1. Code scanning (CodeQL):"
echo "     https://github.com/$REPO/settings/security_analysis"
echo "     → 'Code scanning' → 'Set up' → choose 'Default'."
echo "  2. Social preview image (if not already done):"
echo "     https://github.com/$REPO/settings"
echo "     → scroll to 'Social preview' → 'Edit' → upload assets/social-preview.png"
