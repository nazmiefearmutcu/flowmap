# FLOWMAP — AGENT HANDOFF (2026-09-03, post review+fix campaign)

Read this fully before touching anything. It compresses a multi-session campaign
(review → 3 fix waves → verification) plus every environment trap that cost time.

## 1. Where things are

| What | Path |
|---|---|
| Working clone (ALL work is here) | `C:\Users\Kullanıcı\.zcode\workspace\default\flowmap` (main + 5 local commits, see §3) |
| Review artifacts (also copied in-repo at `docs/review-2026-09-03/`) | `C:\Users\Kullanıcı\.zcode\workspace\default\flowmap-review\` (MASTER-REVIEW.md is the index) |
| Screenshots (pre-fix / post-fix live evidence) | `flowmap-review\shots\out\` and `flowmap-review\shots\out-fixed\` (12 PNGs each) |
| Capture kit (boot server+vite+drive UI in ONE shot) | `flowmap-review\shots\run-capture.sh` + `capture.mjs` |
| Server test venv | `<clone>\.venv-server` (pyruntime-based, system-site-packages + pytest; gitignored) |
| User's installed desktop app (DO NOT break) | `C:\Users\Kullanıcı\Desktop\FlowMap\` (exe + pyruntime) — its pyruntime supplies Python 3.13 + all server deps |
| Canonical memory (MUST read at session start per AGENTS.md) | `C:\Users\Kullanıcı\HAFIZA.md` — section "2026-09-03 flowmap" has this campaign's full log |
| Design doc for the replay engine | `<clone>\docs\superpowers\specs\2026-09-03-replay-engine-design.md` |

## 2. Environment traps (read twice)

1. **PYTHONPATH MUST point at the clone** when running anything that imports
   `flowmap_server`: `PYTHONPATH="C:/Users/Kullanıcı/.zcode/workspace/default/flowmap/server/src"`.
   The Desktop pyruntime has an EDITABLE `.pth` pointing at
   `Temp\opencode\flowmap\server\src` (an OLD copy) — without PYTHONPATH you
   silently test/import the WRONG repo. (Plain-path .pth, so PYTHONPATH wins;
   verify with `python -c "import flowmap_server; print(flowmap_server.__file__)"`.)
2. **Run the server with the Desktop pyruntime interpreter**:
   `"C:/Users/Kullanıcı/Desktop/FlowMap/pyruntime/python.exe" -m flowmap_server`
   with env `FLOWMAP_PORT=8720 FLOWMAP_RECORDING_ENABLED=0`. Client tests:
   `<clone>\.venv-server\Scripts\python.exe -m pytest tests` (from `server/`,
   WITH the PYTHONPATH above).
3. **Turkish "Kullanıcı" in paths breaks `new URL().pathname` percent-decoding
   in Node** (EPERM on mkdir of a mangled path). In Node scripts use
   `process.cwd()`/`process.env`, never URL→path conversion.
4. **Background bash processes DO NOT survive turn boundaries** in this
   environment. Boot server+vite+drive+teardown in ONE script
   (`run-capture.sh` pattern: health-poll → capture → trap-cleanup).
5. **Playwright**: client pins @playwright/test 1.61 → chromium_headless_shell-1228
   (already installed). WebGL2 renders headless only with SwiftShader flags —
   copy them from `client/playwright.config.ts`
   (`--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader`).
6. **Ports 8720/5173**: check `netstat` for stale listeners before booting.
7. **Push is NOT possible from this box**: no `gh` CLI, git credential dialog
   cannot open ("User cancelled dialog", no /dev/tty). 5 local commits wait on
   main; the user must push (or store a PAT) themselves.
8. **Git identity** is set LOCALLY in the clone:
   `Nazmi Efe Armutcu <nazmiefearmutcu@users.noreply.github.com>`.
9. **User rules**: conversation in Turkish; memory files in English; ALL
   subagents must be GLM-5.3-Flash (in-chat Agent tool inherits the session
   model = compliant) and max **2 concurrent** — 6-parallel waves died to API
   rate limit [1302] three times; brainstorming skill (at `~/.claude/skills/`)
   before creative work — note the user later granted blanket "don't ask"
   approval for this campaign, which is NOT a standing rule for new features.

## 3. Commit state (local main, on top of upstream `7ae45a1`)

```
bd71738 feat(server): recording-backed replay engine (design + impl + e2e)
ddc7918 chore: prune single-flight cache locks, untrack perf artifact (review Lows)
eae87d6 fix: honest replay refusal + ws liveness + reconnect race (review wave 2)
8a581ce fix(client): review wave F1-F3 + UX — WebGL2 fallback, topbar responsive, replay honesty
69249f6 fix(server): review wave A1-C4 — f16 saturation, hybrid-scale persistence, boot-teardown race, columnar tail decode
```
(Plus this handoff/review-docs commit.) Nothing is pushed — see trap 7.

## 4. What the campaign did (details in docs/review-2026-09-03/)

**Wave 1 — server core + frontend review, then fixes (69249f6, 8a581ce):**
- Server: f16 saturation clamp in `Grid._finalize_current` (raw units >65504
  used to poison the whole heatmap with +inf); hybrid price scale persisted in
  `_EPOCHS_SCHEMA` + rebuilt in `preload` via `scale_of` (deep-band restarts
  used to mis-bin forever); `Session.start()` rechecks `_closed` after boot +
  `SessionManager.subscribe` single retry (boot-teardown race leaked an
  unkillable feed task + 256-512MiB ring); `load_tail` decodes bid/ask
  columnarly via `list.explode().to_numpy()` (per-row Python walk froze the
  first attach for tens of seconds); `_apply_tail` returns success so a failed
  tail still runs candle backfill; preload accepts tails spanning the first
  band anchor; backfill clamps candle row bands (one absurd candle hung boot).
- Client: WebGL2-unavailable no longer black-screens the app (renderer init
  try/catch → stage fallback panel, session still connects, DOM panels live;
  root `ui/ErrorBoundary.tsx`); topbar stepped media queries (1180/1060/960/880
  — Settings was UNREACHABLE below ~1000px); replay empty-state honesty;
  `keys.ts` dialog gate (Space// inert inside modals, ⌘K passes); Tape HELD
  hover badge; sim stream clock no longer claims UTC; Settings keyboard
  reference; `100dvh`; index.html meta.

**Wave 2 — new findings fixed (eae87d6):**
- ws dead-peer liveness (`_send` 10s timeout; 30s without ANY inbound frame →
  abort; session released), `connection.ts` reconnect-timer vs manual-connect
  double-socket race, Replay refused honestly (`ReplayUnavailableError` →
  Status{degraded} + close 1003) and client Replay toggle gated on
  `capability.replay === true`.

**Wave 3 — replay engine + Lows (bd71738, ddc7918):**
- `feeds/replay.py::ReplayFeed` (see the design doc §details): replays a
  recording as paced BookState snapshots through the STOCK session machinery;
  `_Clock` pacing; `control(Seek/SetSpeed/Pause/Resume)`; end-of-recording
  PARKS (a normal end would tear the session down); Seek rewinds.
  `Recorder.load_all` = load_tail without window/cap. `SessionManager.subscribe`
  builds it for `mode='replay'` (refusal when no store/no recording).
  `Session.feed_control` forwards controls; ws dispatch routes them.
  `Session._capability()` merges the server badge `replay: True` into every
  Hello/Status → the client toggle appears and WORKS.
- Semantics pinned by tests: SetSpeed alone does NOT un-pause.
- Lows: market_cache single-flight locks pruned once free; perf_report.json
  untracked+ignored.

## 5. Verification state (how to reproduce)

- Server: `cd server` + PYTHONPATH (trap 1) +
  `.venv-server\Scripts\python.exe -m pytest tests -q --timeout=120`
  → **422 passed, 1 failed**: `tests/test_config.py::test_data_dir_env_override_expands_user`
  fails on the PRISTINE clone too (Windows path separator; proven via
  `git stash` round-trip). Do NOT "fix" it blind — it predates the campaign.
- Client: `cd client` → `npx tsc -b` clean; `npx vitest run` → **593/593**.
- Live smoke: `bash flowmap-review/shots/run-capture.sh` (boots 8720+5173,
  drives 12 UI states headless, writes PNGs + console/pageerror dump, tears
  down). Post-fix run: 0 pageerrors, WebGL2-less context shows the fallback
  panel with LIVE DOM panels, 620px topbar wraps with all controls reachable.

## 6. Explicitly deferred (with reasons — do not "just do" them blind)

1. **Tauri `csp: null`** — hardening needs a PACKAGED-app smoke test; a wrong
   CSP silently bricks API/WS calls in the exe. Path: set CSP → `vite build` →
   `tauri.js build` (remember: `beforeBuildCommand` is EMPTY, build client
   first; touch `app/src-tauri/src/main.rs` or cargo embeds stale dist) →
   run the exe (computer-use) → verify live data + palette + settings.
2. **`beforeBuildCommand: ""` trap** — documented; fixing means a reliable
   cross-shell build command (`cd ../client && npm run build` semantics).
3. **`tests/test_config.py` Windows path failure** — pre-existing (§5).
4. **Tape row key `${tsNs}-${i}`** — functionally correct (no row identity/
   animation); change adds risk, zero user-visible gain.
5. **Deep reviews not yet done**: client GL renderer full read (surface pass
   only: context-loss/resource-deletion/highp all healthy), server
   feeds/crypto.py + equity.py full read (targeted scan clean), build/packaging
   deep pass.
6. **Replay v2 ideas** (only with a fresh brainstorming design): seek bumps
   epoch + re-snapshots clients (v1 continues the same epoch; client sees new
   col_seqs overwrite left-to-right), client timeline integration with
   recorded extent, per-symbol replay availability surfaced in the palette.

## 7. Ground rules for this repo

- §7 HONESTY principle is load-bearing: never present synthesized/polled/
  snapshot data as real — SYNTH amber, honest capability chips, failed ≠ empty
  states, spread only when both sides exist. Every UI surface follows it; keep
  it that way.
- High-frequency data NEVER enters React state (module stores + value-diff
  polls + rAF coalescing). Keep it out.
- Tests are the contract: golden wire vectors are byte-level cross-language
  commitments (`client/tests/golden/` ↔ `server/tests/proto/golden/`) — any
  wire change regenerates BOTH via `client/scripts/sync-golden.mjs`.
- Affects capability dicts? Update the client gating tests (`TopBar.test.tsx`)
  and the `_capability()` badge list together.
