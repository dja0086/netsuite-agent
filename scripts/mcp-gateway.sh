#!/bin/sh
# Starts the MCP gateway on stdio for an agent host (Claude Code reads .mcp.json).
# Loads .env from the repo root; stdout carries the MCP protocol, so nothing else may print to it.
set -e
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
set -a
. ./.env
set +a
exec node_modules/.bin/tsx apps/mcp-gateway/src/main.ts
