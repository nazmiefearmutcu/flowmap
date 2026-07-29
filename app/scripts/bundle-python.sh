#!/usr/bin/env bash
#
# bundle-python.sh — build a relocatable, self-contained Python runtime that runs
# the FlowMap server, for embedding in the FlowMap desktop app as a Tauri
# resource. Cross-platform: macOS (arm64/intel), Windows (x86_64/arm64) and Linux
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
#     x86_64-pc-windows-msvc    aarch64-pc-windows-msvc
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

# --- 3b. Per-target dependency exceptions -------------------------------------
# Windows-on-ARM is the one target where the locked resolution is not installable
# as-is: three of the locked distributions publish no `win_arm64` wheel, and
# building them from sdist on an ARM64 runner is either impossible in practice
# (pyarrow = the entire Arrow C++ tree) or needs a from-source OpenSSL
# (cryptography). Each is handled by removing exactly as much as the ARM64 bundle
# can live without — and nothing more:
#
#   pyarrow            Needed by exactly one thing: crocodile's `fmt="arrow"`
#                      export. FlowMap never asks for it — its recording layer is
#                      polars, whose parquet codec is native Rust. Dropped.
#                      Note this only became safe with crocodile 2e22c90: before
#                      it, `crocodile/equity/client/__init__.py` imported the
#                      Arrow writer eagerly, so dropping pyarrow took live equity
#                      collection down with it and this gate caught it. The
#                      writer now loads pyarrow at the point of use.
#   zlib-ng            A ccxt speed-up: aiohttp_fast_zlib swaps aiohttp's gzip
#   aiohttp-fast-zlib  codec for zlib-ng (~2x faster decompression). ccxt imports
#                      it inside `try: … except ImportError: pass`, so its
#                      absence is a documented, supported configuration — the
#                      ARM64 build simply decompresses with stdlib zlib.
#   cryptography       NOT droppable: ccxt imports it eagerly at the top of
#                      base/exchange.py. 46.0.3 is the newest release that still
#                      ships a win_arm64 wheel (47.0.0 onward are win_amd64/win32
#                      only), and ccxt only touches long-stable hazmat primitives
#                      (hashes, ec, ed25519, padding, PEM loading), so it is
#                      pinned back for this target alone.
#
# The exception list is fail-loud: if a name it removes or re-pins is no longer
# in the lock — or cryptography's locked version moves — the build stops instead
# of quietly shipping a different dependency set than the one described here.
# Re-check PyPI for win_arm64 wheels before touching it.
#
# Seeded with the flags every target uses, so the array is never empty — an
# empty array expansion is an "unbound variable" under `set -u` on bash 3.2,
# which is what /bin/bash still is on the macOS runners.
PIP_INSTALL_ARGS=(--no-warn-script-location --disable-pip-version-check)
if [[ "$TRIPLE" == "aarch64-pc-windows-msvc" ]]; then
  echo "==> Applying the win-arm64 dependency exceptions"
  "$PY" - "$(native_path "$REQS")" <<'PYEOF'
import pathlib, re, sys

DROP = ("pyarrow", "zlib-ng", "aiohttp-fast-zlib")
REPIN = {"cryptography": ("49.0.0", "46.0.3")}

path = pathlib.Path(sys.argv[1])
lines = path.read_text().splitlines()
out, dropped, repinned, i = [], set(), set(), 0
while i < len(lines):
    line = lines[i]
    m = re.match(r"^([A-Za-z0-9._-]+)\s*(==|@)", line)
    name = m.group(1).lower().replace("_", "-") if m else None
    if name in DROP:
        dropped.add(name)
        i += 1
        # swallow the indented "# via ..." block that belongs to this pin
        while i < len(lines) and lines[i][:1].isspace() and lines[i].lstrip().startswith("#"):
            i += 1
        continue
    if name in REPIN:
        old, new = REPIN[name]
        if f"=={old}" not in line:
            sys.exit(f"ERROR: win-arm64 exception list expects {name}=={old}, lock has: {line!r}\n"
                     f"       Re-check PyPI for a win_arm64 wheel before adjusting the pin.")
        line = line.replace(f"=={old}", f"=={new}")
        repinned.add(name)
    out.append(line)
    i += 1

stale = (set(DROP) - dropped) | (set(REPIN) - repinned)
if stale:
    sys.exit(f"ERROR: win-arm64 exception list names packages the lock no longer contains: "
             f"{sorted(stale)}\n       The exception is obsolete — remove it from bundle-python.sh.")

path.write_text("\n".join(out) + "\n")
print("    dropped:  " + ", ".join(sorted(dropped)))
print("    re-pinned: " + ", ".join(f"{k}=={v[0]}->{v[1]}" for k, v in sorted(REPIN.items())))
PYEOF
  # The export is already a complete, pinned closure, so resolution adds nothing
  # — and here it would actively undo the exceptions above (pip would re-pull
  # pyarrow and cryptography==49.0.0 to satisfy crocodile's and ccxt's metadata).
  # The import check in step 5 is what proves the resulting tree is sound.
  PIP_INSTALL_ARGS+=(--no-deps)
  # Keep the import gate honest: it must stop asserting what this target
  # deliberately does not ship, and assert everything else exactly as before.
  export FLOWMAP_SKIP_IMPORTS="pyarrow"
fi

# NOTE for the macOS Intel leg: ccxt pins `cryptography==49.0.0` exactly, and
# that release publishes only a `macosx_11_0_arm64` macOS wheel — no x86_64, no
# universal2 (48.0.1 was the last with one). So on x86_64-apple-darwin pip
# BUILDS cryptography from sdist, which needs a Rust toolchain. The release
# workflow installs Rust before this step for Tauri's sake, so the toolchain is
# there; expect this leg to take a few minutes longer than the others.
echo "==> Installing dependencies into the runtime (this fetches native wheels)"
"$PY" -m pip install "${PIP_INSTALL_ARGS[@]}" -r "$(native_path "$REQS")"

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
# The module list lives in app/scripts/import-gate.py, not here: the release
# workflow's smoke test gates on the same closure, and when the list was written
# out twice the copies drifted the first time a target needed an exception.
# Always (re)write the sidecar, so a skip left over from a previous target in the
# same checkout cannot leak into this one.
printf '%s' "${FLOWMAP_SKIP_IMPORTS:-}" > "$RES_DIR/.import-skip"
"$PY" "$REPO_ROOT/app/scripts/import-gate.py"

SIZE="$(du -sh "$PYRUNTIME" | cut -f1)"
echo "==> Done. Bundled runtime size: $SIZE"
echo "    symlinks in tree: $(find "$PYRUNTIME" -type l 2>/dev/null | wc -l | tr -d ' ')"
