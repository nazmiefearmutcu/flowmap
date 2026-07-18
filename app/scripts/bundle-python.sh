#!/usr/bin/env bash
#
# bundle-python.sh — build a relocatable, self-contained Python runtime that runs
# the FlowMap server, for embedding in FlowMap.app as a Tauri resource.
#
# Strategy: download astral's `python-build-standalone` CPython 3.13
# (aarch64-apple-darwin, the `install_only` tarball — already relocatable) into
# app/src-tauri/resources/pyruntime, then install the flowmap-server + its deps
# INTO that runtime's own site-packages so the whole tree is self-contained.
# Dependencies (incl. the git-pinned crypcodile/stockodile) come from the
# server's uv.lock so the bundle matches the tested resolution exactly.
#
# Idempotent: re-running rebuilds the runtime from a cached tarball. Pass
# --clean to also drop the cached tarball.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SERVER_DIR="$REPO_ROOT/server"
RES_DIR="$REPO_ROOT/app/src-tauri/resources"
PYRUNTIME="$RES_DIR/pyruntime"
CACHE_DIR="$RES_DIR/.cache"

PBS_TAG="20260623"          # python-build-standalone release tag
PY_SERIES="3.13"           # CPython series to bundle

echo "==> FlowMap Python runtime bundler"
echo "    repo:      $REPO_ROOT"
echo "    pyruntime: $PYRUNTIME"

if [[ "${1:-}" == "--clean" ]]; then
  rm -rf "$CACHE_DIR"
fi
mkdir -p "$CACHE_DIR"

# --- 1. Resolve + download the install_only tarball ---------------------------
# Match the GitHub download URL for the plain (non-freethreaded, non-stripped)
# install_only tarball. The `+` in the version is URL-encoded as `%2B`.
ASSET_RE="cpython-${PY_SERIES}\.[0-9]+(%2B|\+)${PBS_TAG}-aarch64-apple-darwin-install_only\.tar\.gz"
echo "==> Resolving python-build-standalone asset (tag $PBS_TAG)"
ASSET_URL="$(curl -fsSL "https://api.github.com/repos/astral-sh/python-build-standalone/releases/tags/${PBS_TAG}" \
  | grep -oE "https://github.com/[^\"]*${ASSET_RE}" | grep -v freethreaded | grep -v stripped | head -1)"
if [[ -z "$ASSET_URL" ]]; then
  echo "ERROR: could not resolve a ${PY_SERIES} aarch64 install_only asset for tag ${PBS_TAG}" >&2
  exit 1
fi
TARBALL="$CACHE_DIR/$(basename "$ASSET_URL")"
echo "    asset: $ASSET_URL"
if [[ ! -f "$TARBALL" ]]; then
  echo "==> Downloading $(basename "$TARBALL")"
  curl -fSL --retry 3 -o "$TARBALL" "$ASSET_URL"
else
  echo "    (cached)"
fi

# --- 2. Extract into resources/pyruntime --------------------------------------
echo "==> Extracting runtime"
rm -rf "$PYRUNTIME"
mkdir -p "$PYRUNTIME"
# The tarball extracts to a top-level `python/` dir; flatten it into pyruntime.
TMP_EXTRACT="$(mktemp -d)"
tar -xzf "$TARBALL" -C "$TMP_EXTRACT"
mv "$TMP_EXTRACT/python/"* "$PYRUNTIME/"
rm -rf "$TMP_EXTRACT"

PY="$PYRUNTIME/bin/python3.13"
[[ -x "$PY" ]] || PY="$PYRUNTIME/bin/python3"
echo "    interpreter: $PY"
"$PY" -c "import sys; print('    python', sys.version.split()[0])"

# Ensure pip is present in the standalone runtime.
if ! "$PY" -m pip --version >/dev/null 2>&1; then
  echo "==> Bootstrapping pip"
  "$PY" -m ensurepip --upgrade
fi

# --- 3. Install the server + its deps into the runtime ------------------------
echo "==> Exporting locked requirements from server/uv.lock"
REQS="$CACHE_DIR/flowmap-reqs.txt"
( cd "$SERVER_DIR" && uv export --frozen --no-dev --no-emit-project --no-hashes -o "$REQS" )
echo "    $(grep -cvE '^\s*(#|$)' "$REQS") requirement lines"

echo "==> Installing dependencies into the runtime (this fetches native wheels)"
"$PY" -m pip install --no-warn-script-location --disable-pip-version-check -r "$REQS"

echo "==> Building + installing flowmap-server wheel"
WHEEL_DIR="$CACHE_DIR/wheel"
rm -rf "$WHEEL_DIR"
( cd "$SERVER_DIR" && uv build --wheel -o "$WHEEL_DIR" )
"$PY" -m pip install --no-warn-script-location --disable-pip-version-check --no-deps "$WHEEL_DIR"/flowmap_server-*.whl

# --- 4. Slim the runtime (optional, safe removals) ----------------------------
echo "==> Slimming runtime (pyc caches, pip/test cruft)"
find "$PYRUNTIME" -type d -name "__pycache__" -prune -exec rm -rf {} + 2>/dev/null || true
find "$PYRUNTIME" -type d -name "tests" -path "*/site-packages/*" -prune -exec rm -rf {} + 2>/dev/null || true

# --- 5. Verify the bundled runtime boots the server ---------------------------
echo "==> Verifying bundled runtime"
"$PY" -c "import flowmap_server; print('    flowmap_server', flowmap_server.__version__)"
"$PY" -c "import flowmap_server.__main__; print('    flowmap_server.__main__ imports OK')"
"$PY" - <<'PYEOF'
mods = ["numpy", "polars", "fastapi", "uvicorn", "msgspec", "crypcodile", "stockodile"]
import importlib
ok = []
for m in mods:
    try:
        importlib.import_module(m)
        ok.append(m)
    except Exception as e:  # noqa: BLE001
        print(f"    MISSING: {m}: {e}")
        raise
print("    imports OK:", ", ".join(ok))
PYEOF

SIZE="$(du -sh "$PYRUNTIME" | cut -f1)"
echo "==> Done. Bundled runtime size: $SIZE"
echo "    symlinks in tree: $(find "$PYRUNTIME" -type l | wc -l | tr -d ' ')"
