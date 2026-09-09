#!/usr/bin/env bash
# Build the FlowMap client for production (static bundle in client/dist).
# The server runs from source via `uv run python -m flowmap_server`. The native
# desktop app (Tauri shell + bundled Python sidecar) is real and ships from
# app/src-tauri via .github/workflows/release.yml — this script builds only the
# web bundle that the shell embeds.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "building client…"
cd "$ROOT/client"
[[ -d node_modules ]] || npm install
npm run build

echo
echo "client bundle: $ROOT/client/dist"
echo "serve it behind the gateway, or 'npm run preview' in client/ to smoke-test the build."
