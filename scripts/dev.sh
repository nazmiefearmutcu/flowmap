#!/usr/bin/env bash
# Boot the FlowMap gateway (:8720) + the client dev server (:5173) together.
# Ctrl-C stops both. Requires: uv (Python 3.13), npm (Node 22).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${FLOWMAP_PORT:-8720}"

echo "FlowMap — booting server (:$PORT) + client (:5173)"

cleanup() {
  echo; echo "stopping…"
  [[ -n "${SERVER_PID:-}" ]] && kill "$SERVER_PID" 2>/dev/null || true
  [[ -n "${CLIENT_PID:-}" ]] && kill "$CLIENT_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# --- server ---
( cd "$ROOT/server" && uv sync -q && FLOWMAP_PORT="$PORT" uv run python -m flowmap_server ) &
SERVER_PID=$!

# wait for the server to answer /api/health (up to ~30s)
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    echo "server up on :$PORT"; break
  fi
  sleep 0.5
done

# --- client (vite proxies /api + /ws to the server) ---
( cd "$ROOT/client" && [[ -d node_modules ]] || npm install; npm run dev ) &
CLIENT_PID=$!

echo "open http://localhost:5173"
wait
