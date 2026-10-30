#!/bin/sh
# Daily audit job (docs/runbook.md, "Scheduled checks"): deletes audit files past retention, then checks the
# last 24 hours and opens a GitHub issue on NS_AGENT_ALERT_REPO if an alert fires. Reads local files only.
set -eu
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
set -a
. ./.env
set +a
node_modules/.bin/tsx scripts/audit-log.ts prune
# Exit 1 means an alert fired and the issue was opened; only other codes are job failures.
node_modules/.bin/tsx scripts/audit-log.ts alerts --hours 24 --issue || [ $? -eq 1 ]
