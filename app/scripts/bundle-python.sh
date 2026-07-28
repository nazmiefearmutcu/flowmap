#!/usr/bin/env bash
#
# bundle-python.sh — build a relocatable, self-contained Python runtime that runs
# the FlowMap server, for embedding in the FlowMap desktop app as a Tauri
# resource. Cross-platform: macOS (arm64/intel), Windows (x86_64) and Linux
# (x86_64/arm64).
#
# Strategy: download astral's `python-build-standalone` CPython 3.13 for the
# requested target triple (the `install_only` tarball — already relocatable)
# into app/src-tauri/resources/pyruntime, then install the flowmap-server + its
# deps INTO that runtime's own site-packages so the whole tree is
# self-contained. Dependencies (incl. the git-pinned crocodile engine) come
# from the server's uv.lock so the bundle matches the tested resolution exactly.
#
# Because native wheels (numpy/polars/msgspec/curl-cffi …) are platform-specific,
# each OS's runtime MUST be built on that OS — this is why the release workflow
# runs this script once per matrix runner rather than cross-building.
#
# Usage:
#   bundle-python.sh [TARGET_TRIPLE] [--clean]
#
#   TARGET_TRIPLE (default: aarch64-apple-darwin — keeps the historic macOS
#   arm64 behavior when invoked with no arguments). Supported:
#     aarch64-apple-darwin      x86_64-apple-darwin
#     x86_64-pc-windows-msvc
#     x86_64-unknown-linux-gnu  aarch64-unknown-linux-gnu
#
#   --clean   also drop the cached tarball before rebuilding.
#
# On Windows this script is designed to run under Git-Bash (the shell that ships
# with GitHub's windows runners); paths handed to the native `uv`/`python.exe`
# executables are converted to native form via `cygpath`.
#
# Idempotent: re-running rebuilds the runtime from a cached tarball.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SERVER_DIR="$REPO_ROOT/server"
RES_DIR="$REPO_ROOT/app/src-tauri/resources"
PYRUNTIME="$RES_DIR/pyruntime"
CACHE_DIR="$RES_DIR/.cache"

PBS_TAG="20260623"          # python-build-standalone release tag
PY_SERIES="3.13"           # CPython series to bundle

# --- Parse args (triple and/or --clean, order-independent) --------------------
TRIPLE=""
CLEAN=0
for arg in "$@"; do
  case "$arg" in
    --clean) CLEAN=1 ;;
    -*)      echo "ERROR: unknown flag '$arg'" >&2; exit 2 ;;
    *)
      if [[ -n "$TRIPLE" ]]; then
        echo "ERROR: multiple target triples given ('$TRIPLE', '$arg')" >&2; exit 2
      fi
      TRIPLE="$arg"
      ;;
  esac
done
TRIPLE="${TRIPLE:-aarch64-apple-darwin}"

case "$TRIPLE" in
  *windows*) OS_KIND="windows" ;;
  *apple*)   OS_KIND="macos" ;;
  *linux*)   OS_KIND="linux" ;;
  *) echo "ERROR: unrecognized/unsupported target triple '$TRIPLE'" >&2; exit 2 ;;
esac

# Convert a path to the native form the platform's tools expect. On Windows +
# Git-Bash the native `uv`/`python.exe` need Windows paths (C:\…), not the MSYS
# `/c/…` form; everywhere else this is the identity function.
native_path() {
  if [[ "$OS_KIND" == "windows" ]] && command -v cygpath >/dev/null 2>&1; then
    cygpath -w "$1"
  else
    printf '%s' "$1"
  fi
}

echo "==> FlowMap Python runtime bundler"
echo "    triple:    $TRIPLE ($OS_KIND)"
echo "    repo:      $REPO_ROOT"
echo "    pyruntime: $PYRUNTIME"

if [[ "$CLEAN" == "1" ]]; then
  rm -rf "$CACHE_DIR"
fi
mkdir -p "$CACHE_DIR"

# --- 1. Resolve + download the install_only tarball ---------------------------
# Match the GitHub download URL for the plain (non-freethreaded, non-stripped)
# install_only tarball for the requested triple. The `+` in the version is
# URL-encoded as `%2B`.
ASSET_RE="cpython-${PY_SERIES}\.[0-9]+(%2B|\+)${PBS_TAG}-${TRIPLE}-install_only\.tar\.gz"
echo "==> Resolving python-build-standalone asset (tag $PBS_TAG)"
# Authenticate the API lookup when a token is available. Unauthenticated GitHub
# API calls are capped at 60/hour PER IP, and CI runners share egress IPs, so
# this request intermittently comes back 403 and fails the whole build. A token
# raises the cap to 5000/hour. --retry-all-errors also covers 403/429, which
# plain --retry ignores.
API_AUTH=()
if [[ -n "${GITHUB_TOKEN:-}" ]]; then
  API_AUTH=(-H "Authorization: Bearer ${GITHUB_TOKEN}")
fi
ASSET_URL="$(curl -fsSL --retry 5 --retry-all-errors --retry-delay 3 "${API_AUTH[@]}" \
  "https://api.github.com/repos/astral-sh/python-build-standalone/releases/tags/${PBS_TAG}" \
  | grep -oE "https://github.com/[^\"]*${ASSET_RE}" | grep -v freethreaded | grep -v stripped | head -1)"
if [[ -z "$ASSET_URL" ]]; then
  echo "ERROR: could not resolve a ${PY_SERIES} ${TRIPLE} install_only asset for tag ${PBS_TAG}" >&2
  exit 1
fi
TARBALL="$CACHE_DIR/$(basename "$ASSET_URL")"
echo "    asset: $ASSET_URL"
if [[ ! -f "$TARBALL" ]]; then
  echo "==> Downloading $(basename "$TARBALL")"
  curl -fSL --retry 5 --retry-all-errors --retry-delay 3 -o "$TARBALL" "$ASSET_URL"
else
  echo "    (cached)"
fi

# --- 2. Extract into resources/pyruntime --------------------------------------
echo "==> Extracting runtime"
rm -rf "$PYRUNTIME"
mkdir -p "$PYRUNTIME"
# The tarball extracts to a top-level `python/` dir (all platforms); flatten it
# into pyruntime.
TMP_EXTRACT="$(mktemp -d)"
tar -xzf "$TARBALL" -C "$TMP_EXTRACT"
mv "$TMP_EXTRACT/python/"* "$PYRUNTIME/"
rm -rf "$TMP_EXTRACT"

# Interpreter location differs per platform: Windows PBS puts `python.exe` at the
# runtime root (no bin/); macOS/Linux put it under bin/.
if [[ "$OS_KIND" == "windows" ]]; then
  PY="$PYRUNTIME/python.exe"
  [[ -e "$PY" ]] || PY="$PYRUNTIME/python3.13.exe"
else
  PY="$PYRUNTIME/bin/python3.13"
  [[ -x "$PY" ]] || PY="$PYRUNTIME/bin/python3"
fi
[[ -e "$PY" ]] || { echo "ERROR: interpreter not found in $PYRUNTIME" >&2; exit 1; }
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
( cd "$SERVER_DIR" && uv export --frozen --no-dev --no-emit-project --no-hashes -o "$(native_path "$REQS")" )
echo "    $(grep -cvE '^\s*(#|$)' "$REQS") requirement lines"

# NOTE for the macOS Intel leg: ccxt pins `cryptography==49.0.0` exactly, and
# that release publishes only a `macosx_11_0_arm64` macOS wheel — no x86_64, no
# universal2 (48.0.1 was the last with one). So on x86_64-apple-darwin pip
# BUILDS cryptography from sdist, which needs a Rust toolchain. The release
# workflow installs Rust before this step for Tauri's sake, so the toolchain is
# there; expect this leg to take a few minutes longer than the others.
echo "==> Installing dependencies into the runtime (this fetches native wheels)"
"$PY" -m pip install --no-warn-script-location --disable-pip-version-check -r "$(native_path "$REQS")"

echo "==> Building + installing flowmap-server wheel"
WHEEL_DIR="$CACHE_DIR/wheel"
rm -rf "$WHEEL_DIR"
( cd "$SERVER_DIR" && uv build --wheel -o "$(native_path "$WHEEL_DIR")" )
WHEEL_FILE="$(ls "$WHEEL_DIR"/flowmap_server-*.whl | head -1)"
[[ -n "$WHEEL_FILE" ]] || { echo "ERROR: flowmap-server wheel not built" >&2; exit 1; }
"$PY" -m pip install --no-warn-script-location --disable-pip-version-check --no-deps "$(native_path "$WHEEL_FILE")"

# --- 4. Slim the runtime (optional, safe removals) ----------------------------
echo "==> Slimming runtime (pyc caches, test cruft)"
find "$PYRUNTIME" -type d -name "__pycache__" -prune -exec rm -rf {} + 2>/dev/null || true
find "$PYRUNTIME" -type d \( -name "tests" -o -name "test" \) -path "*/site-packages/*" -prune -exec rm -rf {} + 2>/dev/null || true

# Drop Tk/tkinter. FlowMap's server is headless — the UI is the Tauri webview —
# so nothing in the dependency set imports it (see the import check below).
#
# This is not merely a size saving: `_tkinter*.so` links against libtcl9.0 /
# libtk9.0, which python-build-standalone does NOT ship in the install_only
# tarball. On Linux that makes the AppImage bundle fail outright — linuxdeploy
# walks every ELF in the AppDir, cannot resolve libtcl9.0.so, and aborts the
# whole build with "Failed to deploy dependencies for existing files". Removing
# the module removes the dangling dependency at its source, on every platform.
echo "==> Removing unused Tk/tkinter (headless server; breaks AppImage deps)"
find "$PYRUNTIME" -name "_tkinter*.so" -o -name "_tkinter*.pyd" | while IFS= read -r f; do
  [[ -n "$f" ]] && rm -f "$f"
done
find "$PYRUNTIME" -type d \( -name "tkinter" -o -name "idlelib" -o -name "turtledemo" \) \
  -prune -exec rm -rf {} + 2>/dev/null || true
find "$PYRUNTIME" -name "turtle.py" -delete 2>/dev/null || true
# The Tcl/Tk runtime data + shared libraries the removed module was the only
# consumer of (PBS ships these under lib/ and lib/tcl8.6 etc. when present).
find "$PYRUNTIME" -maxdepth 3 -type d \( -name "tcl*" -o -name "tk*" \) \
  -prune -exec rm -rf {} + 2>/dev/null || true
find "$PYRUNTIME" \( -name "libtcl*" -o -name "libtk*" \) -delete 2>/dev/null || true

# Windows installers (MSI/NSIS) cannot carry symlinks. PBS install_only for
# Windows is already symlink-free, but dereference any straggler defensively.
if [[ "$OS_KIND" == "windows" ]]; then
  while IFS= read -r link; do
    [[ -n "$link" ]] || continue
    real="$(readlink -f "$link" 2>/dev/null || true)"
    if [[ -n "$real" && -f "$real" ]]; then
      rm -f "$link"; cp -f "$real" "$link"
    fi
  done < <(find "$PYRUNTIME" -type l 2>/dev/null || true)
fi

# --- 5. Verify the bundled runtime boots the server ---------------------------
echo "==> Verifying bundled runtime"
"$PY" -c "import flowmap_server; print('    flowmap_server', flowmap_server.__version__)"
"$PY" -c "import flowmap_server.__main__; print('    flowmap_server.__main__ imports OK')"
"$PY" - <<'PYEOF'
mods = [
    # Eager: loaded the moment the server boots.
    "flowmap_server", "numpy", "polars", "fastapi", "uvicorn", "msgspec",
    "crocodile", "ccxt", "aiohttp", "certifi",
    # Lazy: imported only on a real subscribe, so booting the server proves
    # nothing about them. A bundle that lost pyarrow or pandas would pass every
    # other gate and die on the first `equity:AAPL`.
    "crocodile.core.connector", "crocodile.core.ingest.transport",
    "crocodile.core.schema.records", "crocodile.core.scheduler.calendar",
    "crocodile.core.sink.memory", "crocodile.crypto.exchanges.factory",
    "crocodile.crypto.client.backfill",
    "crocodile.crypto.exchanges.ccxt_universal.connector",
    "crocodile.crypto.exchanges.binance.backfill",
    "crocodile.equity.providers.factory", "crocodile.equity.providers.yahoo.client",
    "crocodile.equity.client.collect", "crocodile.equity.depth.vap",
    "pandas", "pyarrow", "yfinance", "bs4",
]
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
echo "    symlinks in tree: $(find "$PYRUNTIME" -type l 2>/dev/null | wc -l | tr -d ' ')"
