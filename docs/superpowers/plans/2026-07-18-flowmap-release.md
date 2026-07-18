# FlowMap Release Prep Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use
> checkbox (`- [ ]`) syntax. Spec: `docs/superpowers/specs/2026-07-18-flowmap-release-design.md`
> (read it first). Repo root `/Users/nazmi/flowmap` (symlink → `/Volumes/disk 2/...`), branch
> `main` (== v2). Opsera commit gate: `touch /tmp/.opsera-pre-commit-scan-passed` as its OWN Bash
> call, then `git commit` as a SEPARATE call (the opsera MCP tool is unavailable in this
> non-interactive session — run `semgrep --config auto` on changed files as the sanctioned
> fallback and note 0 findings). NO Claude co-author trailer on any commit.

**Goal:** Ship FlowMap as a public product: strip the internal `v2` label and the retired brand name,
build a double-clickable macOS `.dmg` with a crafted icon, make the source publicly installable,
and publish (push + GitHub release).

**Architecture:** Identity is text edits + a version bump. The desktop app is Tauri (Rust +
WKWebView) wrapping the built `client/dist` and spawning a bundled relocatable-Python virtualenv
running `flowmap_server` as a sidecar. The icon is a hand-authored SVG → `.icns`. Public install
comes from swapping local path deps for pinned public git deps. Publish is `git push` + `gh release`.

**Tech Stack:** existing (Python 3.13/uv server, TS/Vite/WebGL2 client) + Tauri 2 (cargo/rustc
present), `python-build-standalone`, `rsvg-convert`/`sips`/`iconutil`, `gh` CLI.

---

### Task 1: Identity cleanup — remove "v2", remove the retired brand name, version 1.0.0

**Files:**
- Modify: `client/src/ui/TopBar.tsx` (the `FlowMap` logo), `client/index.html` (`<title>`),
  `client/src/gl/mips.ts`, `client/src/ui/theme.css`, `client/tests/e2e/mips.spec.ts`,
  `server/src/flowmap_server/proto/__init__.py`, `server/tests/core/test_session.py`,
  and any other tracked file that still names the retired brand (incl. `README.md`,
  `docs/superpowers/**`). Version: `server/pyproject.toml`, `client/package.json`,
  `server/src/flowmap_server/__init__.py`.

- [ ] **Step 1: Enumerate the references.**
  Enumerate: grep the tree (case-insensitive) for the retired brand name, for the
  milestone-labelled logo/title string, and for any stray `v2` in `client/src/ui/TopBar.tsx`
  and `client/index.html`.
  Record every hit; each must be resolved below.

- [ ] **Step 2: Logo/title — drop "v2".**
  In `client/src/ui/TopBar.tsx`, change the logo markup `FlowMap <em>v2</em>` (and its CSS hook if
  the `<em>` is now empty/unused) to just `FlowMap`. In `client/index.html` change
  the `<title>` to `<title>FlowMap</title>`. If `TopBar.tsx` has a test asserting the
  "v2" text, update it to assert "FlowMap".

- [ ] **Step 3: Remove the retired brand name everywhere.**
  For each tracked file that still names the retired brand, replace the brand term with
  market-neutral wording: "<brand>-standard" → "professional order-flow" /
  "institutional-grade order-flow"; "<brand>-style" → "order-flow heatmap"; "like <brand>" →
  "order-flow terminals"; a bare mention in a comment → "order-flow heatmap tools". Preserve the
  sentence's technical meaning. Applies to code comments, `theme.css` comments, test
  docstrings/names (rename a test like `test_<brand>_*` → `test_orderflow_*` and update
  references), the proto `__init__` docstring, README, and the `docs/superpowers/**` specs/plans
  (historical, but the repo is public — clean them too).

- [ ] **Step 4: Version → 1.0.0.**
  `server/pyproject.toml`: `version = "1.0.0"`. `client/package.json`: `"version": "1.0.0"`.
  `server/src/flowmap_server/__init__.py`: `__version__ = "1.0.0"` (the REST `/api/health` returns
  it — the `test_rest.py` health test asserts the version string; update that test to `1.0.0`).
  Search for any other occurrence of the old pre-release version string and update.

- [ ] **Step 5: Verify + tests.**
  Grep the tree (case-insensitive) for the retired brand name → **no output** (0 hits).
  The milestone-labelled logo/title string → no output. Then:
  `cd server && uv run python -m pytest -q` → all pass (health test now 1.0.0);
  `cd ../client && npm test` → all pass; `npm run build` → clean.
  Boot the app briefly (`cd server && FLOWMAP_PORT=8720 uv run python -m flowmap_server &` +
  `cd client && npm run dev`), confirm the top bar reads "FlowMap" (no v2) in the browser pane,
  screenshot, kill servers.

- [ ] **Step 6: Commit** (Opsera two-step; semgrep fallback):
  `git add -A && git commit -m "feat: FlowMap 1.0.0 identity — drop v2 label, remove legacy brand name"`.

### Task 2: App icon — hand-authored SVG → .icns

**Files:**
- Create: `app/icons/flowmap.svg` (the source), `app/icons/` iconset outputs, `app/icons/scripts/build-icns.sh`.
- Modify: `client/index.html` (favicon), `client/public/` (favicon asset) if present.

- [ ] **Step 1: Author the SVG icon by hand.**
  Create `app/icons/flowmap.svg`, 1024×1024, macOS superellipse tile (rounded-square with the
  Apple squircle corner radius ≈ 22.37% of the side). Background near-black `#050709` with a subtle
  top-lit vertical gradient to `#0b0f14`. Foreground: an **order-flow liquidity motif** — 5–7
  horizontal density bands of varying width/opacity spanning the tile (evoking the heatmap), two of
  them bright "liquidity walls" as crisp thin lines, drawn in the product palette
  `#1fb6a6` (teal) → `#37d0c0` (cyan) with one `#d6a13a` (amber) accent band and a single
  `#d3524f` (red) tick. Add a faint 1px inner stroke for definition. Geometric and restrained — NO
  gradient orbs, glows-as-decoration, candles, or clip-art. Hand-place every element with intent.
  (This is authored SVG markup, not an AI-generated raster.)

- [ ] **Step 2: Build the iconset → .icns.**
  Write `app/icons/scripts/build-icns.sh`: render the SVG to PNGs at
  16,32,64,128,256,512,1024 (+ @2x = 32,64,256,512,1024) with `rsvg-convert` (or `sips`/
  `qlmanage` fallback), lay them out as `FlowMap.iconset/icon_16x16.png` … `icon_512x512@2x.png`
  per Apple's naming, then `iconutil -c icns FlowMap.iconset -o app/icons/FlowMap.icns`. Also
  emit `app/icons/icon-512.png` and `app/icons/icon-32.png` for Tauri + the favicon.
  Run it. Assert `app/icons/FlowMap.icns` exists and `file` reports "Mac OS X icon".

- [ ] **Step 3: Favicon.**
  Replace the client browser-tab favicon with a simplified 32px version of the mark
  (`client/public/favicon.svg` or `.png`), wire it in `client/index.html`
  (`<link rel="icon" ...>`). `npm run build` clean.

- [ ] **Step 4: Visual check.**
  Open `FlowMap.icns` (or the 1024 PNG) and the 32px PNG; confirm the crafted motif reads at both
  sizes (screenshot). If it looks like AI-slop / generic, iterate the SVG before proceeding.

- [ ] **Step 5: Commit:** `git add app/icons client/index.html client/public && git commit -m "feat: hand-authored FlowMap app icon + favicon"`.

### Task 3: Publicly installable — pinned git deps + fresh-clone smoke

**Files:**
- Modify: `server/pyproject.toml` (`[tool.uv.sources]`), `server/uv.lock` (regenerated).

- [ ] **Step 1: Pin the public commit SHAs.**
  Run `cd /Users/nazmi/Crypcodile && git rev-parse HEAD` and
  `cd /Users/nazmi/stockodile && git rev-parse HEAD`; also confirm those commits are **pushed to
  the public repos** (`git branch -r --contains HEAD` shows `origin/main`; if not, the deps aren't
  actually public yet — STOP and report, since a git-dep to an unpushed SHA won't resolve for
  others). Record both SHAs.

- [ ] **Step 2: Swap local path deps → git deps.**
  In `server/pyproject.toml` `[tool.uv.sources]` replace:
  ```toml
  crypcodile = { git = "https://github.com/nazmiefearmutcu/Crypcodile.git", rev = "<CRYPCODILE_SHA>" }
  stockodile = { git = "https://github.com/nazmiefearmutcu/stockodile.git", rev = "<STOCKODILE_SHA>" }
  ```
  Keep `dependencies` as `crypcodile`/`stockodile` (the `[project]` names). If the server needs the
  `core` extras, express them: `crypcodile[core]` / `stockodile[core]` in `dependencies` (verify
  which form the current install uses).

- [ ] **Step 3: Relock + local verify.**
  `cd /Users/nazmi/flowmap/server && uv lock && uv sync` → resolves from git. `uv run python -m pytest -q` → all pass.

- [ ] **Step 4: Fresh-clone smoke (proves no local-path leakage).**
  ```bash
  TMP=$(mktemp -d); git -C /Users/nazmi/flowmap archive --format=tar main | tar -x -C "$TMP"
  cd "$TMP/server" && uv sync && FLOWMAP_PORT=8791 uv run python -m flowmap_server &
  sleep 8 && curl -fsS http://127.0.0.1:8791/api/health && echo OK
  ```
  (Using `git archive` of the tree simulates a clean checkout without the local worktree paths.)
  Expect `{"status":"ok","version":"1.0.0"}`. Kill it; `rm -rf "$TMP"`. If `uv sync` pulls the git
  deps and health returns ok, public install works.

- [ ] **Step 5: Commit:** `git add server/pyproject.toml server/uv.lock && git commit -m "build: pin public git deps (Crypcodile/stockodile) for public install"`.

### Task 4: Tauri desktop app + bundled Python sidecar + DMG

**Files:**
- Create: `app/` — a Tauri 2 project: `app/src-tauri/tauri.conf.json`, `app/src-tauri/Cargo.toml`,
  `app/src-tauri/src/main.rs` (spawn/health-poll/teardown the sidecar), `app/src-tauri/build.rs`,
  `app/scripts/bundle-python.sh` (build the relocatable python venv), `app/scripts/build-dmg.sh`
  (orchestrate: client build → python bundle → tauri build → dmg), `app/README.md`.

- [ ] **Step 1: Scaffold Tauri 2.**
  `cd /Users/nazmi/flowmap && cargo install create-tauri-app --locked` (if absent) or use
  `npm create tauri-app`; create the project under `app/` with the frontend pointed at the built
  `client/dist` (Tauri `frontendDist: "../client/dist"`, `beforeBuildCommand` runs the client
  build). App identifier `com.nazmiefearmutcu.flowmap`, product name `FlowMap`, version `1.0.0`,
  window title `FlowMap`, icons from `app/icons/` (Task 2). `cargo build` in `app/src-tauri` compiles.

- [ ] **Step 2: Bundle a relocatable Python venv (`app/scripts/bundle-python.sh`).**
  Download `python-build-standalone` (cpython 3.13, aarch64-apple-darwin) into
  `app/src-tauri/resources/pyruntime/`; create a venv from it; `pip install` the server
  (`/Users/nazmi/flowmap/server` with its now-git deps, or the built wheel) + its runtime deps into
  that venv. Verify `resources/pyruntime/bin/python -m flowmap_server --help`-equivalent import
  works (`... -c "import flowmap_server; print(flowmap_server.__version__)"` → `1.0.0`). The venv is
  bundled as a Tauri `resource`. Document the size.

- [ ] **Step 3: Sidecar lifecycle in `main.rs`.**
  On app setup: pick a free loopback port; spawn `resources/pyruntime/bin/python -m flowmap_server`
  with env `FLOWMAP_PORT=<port>`, `FLOWMAP_HOST=127.0.0.1`,
  `FLOWMAP_DATA_DIR=<app data dir>/recordings`; poll `http://127.0.0.1:<port>/api/health` (up to
  ~30s) before creating/showing the webview; navigate the window to that URL. On window-close/app-
  exit, kill the sidecar child (no orphan). Use Tauri's shell/process APIs (or `std::process`).
  Handle the resource path correctly inside the `.app` bundle (`resolve_resource`).

- [ ] **Step 4: Build the DMG (`app/scripts/build-dmg.sh`).**
  Orchestrate: `cd client && npm ci && npm run build` → `bash app/scripts/bundle-python.sh` →
  `cd app/src-tauri && cargo tauri build` (or `npm run tauri build`) producing `FlowMap.app` +
  `FlowMap.dmg` under `app/src-tauri/target/release/bundle/`. Ad-hoc sign (`codesign --force
  --deep -s - FlowMap.app` if Tauri didn't) since no Developer ID. Run it.

- [ ] **Step 5: Install + run-verify the DMG on THIS machine.**
  Mount `FlowMap.dmg`, copy `FlowMap.app` to `/Applications` (or run in place), clear quarantine
  (`xattr -cr FlowMap.app`), launch it. CONFIRM: the window opens showing the live sim heatmap;
  the bundled sidecar server started (its health served the client — no separate server running);
  switch a symbol works; quitting the app kills the sidecar (`pgrep -f flowmap_server` → none).
  Screenshot the running native app. Note the DMG size + the first-run Gatekeeper step.

- [ ] **Step 6: Commit:** `git add app && git commit -m "feat: macOS FlowMap.app + DMG (Tauri shell + bundled Python sidecar)"`.
  (If the `.dmg`/venv artifacts are large, gitignore the build outputs — commit the Tauri project
  + scripts, not the built binaries; the DMG ships via the GitHub Release, not git.)

### Task 5: Publish — README, run-from-source + install docs, push, release

**Files:**
- Modify: `README.md` (install-from-DMG + Gatekeeper note + run-from-source + honest caveats).
- Create: release notes (inline in the `gh release` command).

- [ ] **Step 1: README install section.**
  Add a "Download" section: the DMG (from the GitHub Release), the first-run Gatekeeper bypass
  (right-click → Open, or `xattr -cr /Applications/FlowMap.app`, because the app is unsigned/
  unnotarized — no paid Apple Developer ID), and the existing run-from-source path
  (`./scripts/dev.sh`). Keep the honest keyless-equity + weekend-closed notes. The retired brand
  name stays at 0 hits.

- [ ] **Step 2: Final pre-publish verification.**
  `cd server && uv run pytest -q` (152+), `cd client && npm test && npm run build && npm run e2e`
  (all green), the retired brand name and the milestone-labelled logo/title grep to 0. Confirm the DMG exists and installs
  (Task 4 Step 5). Commit the README: `git add README.md && git commit -m "docs: install-from-DMG + Gatekeeper + run-from-source"`.

- [ ] **Step 3: PUBLISH — after the user's final confirmation (outward-facing).**
  Present the exact actions and get an explicit "yes" before running:
  1. `git push origin main` (fast-forward to the public repo; never `--force`).
  2. `git tag v1.0.0 && git push origin v1.0.0`.
  3. `gh release create v1.0.0 <path>/FlowMap.dmg --title "FlowMap 1.0.0" --notes "<notes>"`
     where notes cover: what FlowMap is (dual-market order-flow terminal), install (DMG +
     Gatekeeper bypass, or run-from-source), the honest keyless-equity SYNTH tier + unsigned-DMG
     caveats, and links to the verification docs.
  - Do NOT run these until the user explicitly confirms in chat. If they decline, stop and leave
    everything committed locally.

---

## Notes for the executor
- Tasks 1–3 are low-risk and independently verifiable; do them first. Task 4 (Tauri + Python
  sidecar) is the hard one — if the bundled-Python route proves intractable in the time budget,
  report BLOCKED with specifics rather than shipping a broken DMG; the run-from-source path still
  fully works and the release can ship source-first with the DMG as a follow-up.
- Never `git push --force`. Never publish (Task 5 Step 3) without the user's explicit in-chat ok.
- Keep the renderer/server behavior unchanged — this milestone is identity + packaging + publish.
