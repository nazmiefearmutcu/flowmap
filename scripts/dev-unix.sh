#!/usr/bin/env bash
# FlowMap one-shot dev boot for macOS / Linux / WSL / Git Bash.
# Starts the server (127.0.0.1:${FLOWMAP_PORT:-8720}, recording disabled) and
# the vite dev server (:5173, which proxies /api and /ws to the server).
# Ctrl-C stops both. Requires: npm (Node 22). Server prefers uv; without it,
# any Python 3.13 with the server deps installed is used via PYTHONPATH.
set -u

PORT="${FLOWMAP_PORT:-8720}"
if [ "${FLOWMAP_RECORDING_ENABLED:-0}" = "1" ]; then REC=1; else REC=0; fi

# Canonical repo root (real path — avoids symlinked-cwd surprises).
SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPTS_DIR/.." && pwd)"
cd "$ROOT"

SERVER_PID=""
CLIENT_PID=""

cleanup() {
  echo
  echo "stopping flowmap dev…"
  [ -n "$CLIENT_PID" ] && kill "$CLIENT_PID" 2>/dev/null
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null
  wait 2>/dev/null
  echo "flowmap dev stopped."
}
trap cleanup EXIT INT TERM

export FLOWMAP_PORT="$PORT"
export FLOWMAP_RECORDING_ENABLED="$REC"
export FLOWMAP_LOG_LEVEL="${FLOWMAP_LOG_LEVEL:-info}"

# --- server -----------------------------------------------------------------
cd "$ROOT/server" || exit 1
if command -v uv >/dev/null 2>&1; then
  uv run python -m flowmap_server &
  SERVER_PID=$!
else
  # Plain-Python path: the server package lives in server/src.
  export PYTHONPATH="$ROOT/server/src${PYTHONPATH:+:$PYTHONPATH}"
  echo "uv not found - using python3 with PYTHONPATH=$PYTHONPATH"
  echo "(install server deps first: see server/pyproject.toml)"
  python3 -m flowmap_server &
  SERVER_PID=$!
fi
cd "$ROOT"

# --- wait for /api/health (up to ~30 s) --------------------------------------
ready=0
for _ in $(seq 1 60); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then break; fi
  if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    ready=1; break
  fi
  sleep 0.5
done
if [ "$ready" -ne 1 ]; then
  echo "server did not become healthy on http://127.0.0.1:$PORT/api/health" >&2
  exit 1
fi
echo "server up on :$PORT"

# --- client (vite; proxies /api + /ws to the server) -------------------------
cd "$ROOT/client" || exit 1
[ -d node_modules ] || npm install
npm run dev &
CLIENT_PID=$!
cd "$ROOT"

echo
echo "FlowMap dev: open http://localhost:5173  (Ctrl-C stops both)"
echo

# Exit when either child dies; the trap tears the other one down.
wait -n "$SERVER_PID" "$CLIENT_PID" 2>/dev/null || wait "$CLIENT_PID"
