# L7 — Operational audit (foreground, self)

**Date**: 2026-05-15
**Auditor**: maintainer (foreground)
**Scope**: daily-check infrastructure, log retention, tag reachability, npm registry hygiene, GH release alignment

## TL;DR — All checks pass, 1 known limitation

| Check | Status |
|---|---|
| Daily-check launchd loaded | ✅ |
| Daily-check history (3-day window) | ✅ — 3 files, all parseable |
| Daily-check stderr log | ✅ — empty (no errors) |
| Git tags reachable from main | ✅ — 90/90 (no orphans) |
| npm registry: all versions installable | ✅ — 74 versions (0.7.4 ... 3.6.0) |
| Tag → GH release alignment (last 10) | ✅ — 10/10 have releases |
| Daily-check "fails counted in 24h" heuristic | ⚠️ known limitation |

## Detailed findings

### L7-01 (Info) — Daily-check launchd job operational

`launchctl list | grep enquire` → `com.oomkapwn.enquire-mcp-daily` loaded (exit code 0). History at `~/.local/share/enquire-mcp-monitor/history/` contains 3 files (2026-05-13, -14, -15) — exactly one per day, no gaps. Stderr log empty.

### L7-02 (Info) — Tag reachability

All 90 tags reachable from `main`. No orphan tags pointing to commits not on main.

### L7-03 (Info) — npm registry hygiene

74 versions on npm from `0.7.4` through `3.6.0`. Latest 10 tags (v3.5.10..v3.6.0 + 4 RCs) each have a corresponding GH release. Tag–release alignment 100% in the recently-active range.

### L7-04 (Low — known limitation, defer to v3.7)

**Class**: daily-check 24h-window heuristic counts HISTORICAL CI failures, not regressions on main.

**Evidence**: daily-check on 2026-05-13/-14/-15 each reported "1-2 CI fail за 24ч — проверь" but those fails were:
- `v3.6.0-rc.1 stuck-queued` (infrastructure, retriggered same day)
- `v3.6.0-rc.2 coverage exclude` (fixed in next push)
- `pdfjs v5 CI` (the pre-fix-bug fail; obsoleted by rc.4)

All resolved within minutes of detection by subsequent pushes. The script's 24h-window heuristic doesn't know about "overtaken by subsequent green run", so it flags as if active issue.

**Suggested class fix** (v3.7 backlog): filter failed runs whose `headSha != current main HEAD` OR whose `headSha` has a subsequent successful run on the same workflow.

**Per-instance backfill**: not needed (heuristic is informational, not blocking).

## Sign-off

L7 verdict: **GREEN**. One Low finding deferred to v3.7. Operational infrastructure ready for v3.6.0 stable lifetime.
