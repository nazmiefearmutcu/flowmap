# FlowMap — Release Prep & Public Distribution — Design

**Date:** 2026-07-18 · **Status:** Approved (user) · **Branch:** `main` (== v2 after the cutover)

Prepare FlowMap for public release: strip the internal `v2` milestone label and the retired brand
name from everything shipped, ship a double-clickable macOS `.dmg`, design a crafted app icon,
make the code publicly installable, and publish (push + GitHub release).

## Goals
- **G1 — Clean product identity:** the product is "FlowMap" everywhere. No "v2" in the logo/title,
  no retired brand name anywhere in shipped code, UI, docs, or README. A real public version (`1.0.0`).
- **G2 — Installable macOS app:** a `FlowMap.dmg` that installs `FlowMap.app` — double-click to
  run, no separate Python/Node install required by the user.
- **G3 — Crafted app icon:** a hand-authored (not AI-generated) icon, order-flow heatmap motif,
  in the app's palette, shipped as `.icns` across all required sizes.
- **G4 — Publicly installable source:** anyone can clone + run from source (`uv sync` resolves,
  `npm install` works) — no local-only path dependencies.
- **G5 — Published:** `main` pushed to the public GitHub repo + a `v1.0.0` Release with the DMG.

## Non-goals
- Apple notarization / a signed "no-warning" DMG (requires a paid Apple Developer ID — only an
  Apple Development identity is available). The DMG is ad-hoc signed; the Gatekeeper bypass is
  documented.
- Windows/Linux installers (macOS first).
- App Store distribution.
- Any change to the renderer/server behavior — this is packaging + identity only.

## Workstreams

### 1. Identity cleanup (mechanical, low-risk)
- **Remove "v2" from the logo/title:** `client/src/ui/TopBar.tsx` (logo reads `FlowMap`),
  `client/index.html` (`<title>` reads `FlowMap`). Keep the internal package/version
  numbers separate (see versioning).
- **Remove the retired brand name** from every tracked file that contains it (README.md,
  `client/src/gl/mips.ts`, `client/src/ui/theme.css`, `client/src/gl/**` comments,
  `client/tests/e2e/mips.spec.ts`, `server/src/flowmap_server/proto/__init__.py`,
  `server/tests/core/test_session.py`, and the `docs/superpowers/specs|plans/**` design docs).
  Replace with market-neutral language: "order-flow heatmap", "liquidity heatmap",
  "professional order-flow terminal", "tick-grouping". Preserve meaning; only the brand name goes.
  Verify the retired brand name greps to 0 hits at the end.
- **Name consistency:** "FlowMap" (one word, capital F/M) everywhere user-facing. Any stray
  "Flowmap"/"flow map" fixed. (Package/dir identifiers like `flowmap_server`, `flowmap-client`,
  the repo dir stay as-is — those are code identifiers, not the display name.)
- **Versioning:** set the public version `1.0.0` — `server/pyproject.toml` (`version = "1.0.0"`),
  `client/package.json` (`"version": "1.0.0"`), and any `__version__` (`flowmap_server.__init__`).
  The Tauri app version = `1.0.0`. Hello's `protocol_version` is unrelated and unchanged.

### 2. macOS `.dmg` via Tauri + bundled Python sidecar
- **Shell:** a Tauri app (`app/` at repo root, or `desktop/`) — Rust + macOS native WKWebView. It
  loads the built client (`client/dist`, bundled as Tauri frontend assets) and, on startup, spawns
  the FlowMap server as a **sidecar**, then points the webview at `http://127.0.0.1:<port>`.
- **Python sidecar (the crux):** bundle a **relocatable Python** (astral `python-build-standalone`)
  + a pre-built virtualenv containing the server and its deps (msgspec, numpy, polars, pyarrow,
  duckdb, fastapi, uvicorn, websockets, aiohttp, certifi, + crypcodile[core] + stockodile[core]).
  This is more robust than PyInstaller-freezing polars/duckdb native wheels. A small launcher
  script (the Tauri "sidecar" binary or a shim) runs `<bundled-python> -m flowmap_server` with the
  app's data dir and a chosen loopback port. Health-poll `/api/health` before showing the window;
  kill the sidecar on app exit.
- **Port:** the app picks a free loopback port (or fixed 8720 with a fallback) and passes it to
  both the sidecar (`FLOWMAP_PORT`) and the webview URL. Recording data dir under
  `~/Library/Application Support/FlowMap/`.
- **Output:** `tauri build` → `FlowMap.app` → `FlowMap.dmg` (Tauri's dmg bundler; a simple
  drag-to-Applications layout). **Ad-hoc code-signed** (`codesign -s -` / Tauri's default) since no
  Developer ID — the DMG is unsigned/unnotarized.
- **Install UX + honesty:** README + the release notes document the first-run Gatekeeper step
  (right-click → Open, or `xattr -cr /Applications/FlowMap.app`) because the app is not notarized.
- **Fallback:** the `scripts/dev.sh` "run from source" path remains the documented alternative for
  users who prefer it or aren't on macOS.

### 3. App icon (hand-authored)
- **Concept:** macOS superellipse tile, near-black (`#050709`) background, an **order-flow
  liquidity motif** — a few parallel horizontal density bands (the heatmap itself) with one bright
  liquidity-wall line, rendered in the product's **teal → cyan → amber thermal** accents
  (`#1fb6a6`/`#d3524f`/`#d6a13a`). Geometric, restrained, purposeful — reads as an order-flow
  instrument at 32px and looks crafted at 1024px. Explicitly NOT a generic glowing orb / gradient
  blob / clip-art candle.
- **Production:** authored by hand as an **SVG** (`app/icons/flowmap.svg`) → rasterized to the
  macOS iconset sizes (16, 32, 64, 128, 256, 512, 1024 incl. @2x) via `rsvg-convert`/`sips` →
  `iconutil -c icns` → `FlowMap.icns`, wired into the Tauri bundle (`tauri.conf.json` icon set,
  incl. the `.ico`/png sizes Tauri wants). Reviewed for craft; iterate if the user dislikes it.
- **Favicon:** the same mark, simplified, replaces the client's browser-tab favicon.

### 4. Publicly installable + publish
- **Dependency de-localization (the public-install blocker):** `server/pyproject.toml`
  `[tool.uv.sources]` currently points crypcodile/stockodile at `/Users/nazmi/...` local paths.
  Both repos are already public on GitHub. Change to **pinned git dependencies**:
  `crypcodile = { git = "https://github.com/nazmiefearmutcu/Crypcodile.git", rev = "<sha>" }` and
  the same for stockodile (the `core` extra). Pin to the exact commits with the M1 dependency
  splits. Regenerate `uv.lock`; verify a **clean clone in a fresh dir** resolves + the server boots
  + the full suite passes (proves no local-path leakage).
- **Publish (outward-facing — final confirmation before executing):**
  1. Push `main` to `origin` (`github.com/nazmiefearmutcu/flowmap`, already public) — normal
     fast-forward, never `--force`.
  2. Tag `v1.0.0`; create a **GitHub Release** (`gh release create v1.0.0`) with the built
     `FlowMap.dmg` attached + notes (what it is, dual-market, the honest keyless-equity + unsigned-
     DMG caveats, run-from-source instructions, verification links).
  - This distributes all code (incl. the v1→v2 cutover history). The user authorized public
    release; still confirm the exact push + release action at execution time.

## Testing / verification
- After identity cleanup: the retired brand name greps to 0; the client + server suites still pass
  (240 vitest + 18 e2e; 152 pytest); `npm run build` clean; the UI shows "FlowMap" with no "v2".
- DMG: build it, install `FlowMap.app` from the DMG on this machine, launch it, confirm the
  window shows the live heatmap (sim + a market switch), the bundled server started (health), and
  quitting kills the sidecar (no orphan process). Screenshot the running app.
- Public-install: fresh-clone smoke — clone to a temp dir, `cd server && uv sync` (git deps
  resolve), boot, `curl /api/health`; `cd client && npm install && npm run build`.
- Icon: render the `.icns`, view it at 1024 and 32px, confirm it's the crafted motif (screenshot).
- Publish: dry-run the release (build artifacts present), then execute after the user's final ok.

## Risks / honest limitations
- **Unsigned DMG** → Gatekeeper warning; documented bypass. Not a bug — a consequence of no paid
  Developer ID.
- **Sidecar Python bundling** is the highest-effort, most-fragile piece (relocatable python + native
  wheels + path handling inside a `.app`). If Tauri sidecar bundling proves too fragile in the time
  budget, the fallback is a still-real `.dmg` that contains `FlowMap.app` which requires a one-time
  `uv`/Python bootstrap on first launch — but the goal is fully self-contained; that fallback is
  documented only if the bundled route genuinely can't be made to work.
- **Public git history** contains the v1 tree + local usernames in old commits — acceptable for a
  personal public repo; noted.

## Milestones (implementation order)
1. **Identity** (rename/brand/version) — fast, low-risk, verifiable first.
2. **Icon** (SVG → icns) — needed by the Tauri bundle.
3. **De-localize deps + fresh-clone smoke** — unblocks public install, independent of the DMG.
4. **Tauri app + Python sidecar + DMG** — the big one; build + install + run-verify locally.
5. **Publish** — push `main` + `v1.0.0` release with the DMG, after final user confirmation.
