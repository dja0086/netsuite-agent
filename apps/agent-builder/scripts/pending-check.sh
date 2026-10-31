#!/bin/sh
# Every 15 minutes (launchd, docs/agent-builder.md): open a GitHub issue for each builder run waiting on an approval.
# Uses the `ant auth login` profile for the Anthropic API and the `gh` login for issues.
set -eu
cd "$(dirname "$0")/.."
exec ../../node_modules/.bin/tsx src/pending-check.ts
