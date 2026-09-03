# Replay Engine — Design (2026-09-03)

Status: implemented (this commit). Owner: review-fix campaign, wave 3.

## Problem

The client ships a full replay transport (Live/Replay toggle, play/pause,
speed, seek scrubber) but the server had no engine behind it: `build_feed`
routed by market only, so `mode='replay'` served the SAME live feed under a
replay label, and Seek/SetSpeed/Pause/Resume were decoded then dropped
("inert at M1"). Dead controls presented as active — the exact §7 honesty
violation the project elsewhere refuses.

## Approaches considered

1. **Synthesizing feed (CHOSEN)** — replay a recording through the STOCK
   session machinery: a feed that emits `BookState` snapshots synthesized
   from recorded density columns; the grid re-integrates them exactly like
   live books. Zero changes to Session/ClientTx/wire; controls ride a small
   optional `feed.control()` surface.
2. Dedicated ReplaySession serving pre-computed columns directly to
   ClientTx — avoids re-integration but duplicates snapshot/history/
   broadcast logic (~300 lines of parallel infra). Rejected: YAGNI for v1.
3. Keep the refusal + hide the client toggle — shipped as the interim
   honesty fix; superseded by (1) but kept as the fallback when a symbol has
   NO recording (an explicit refusal, never a fake).

## Design

- **`feeds/replay.py::ReplayFeed`** — constructed from a `TailData` (the
  symbol's full recording). `events()` walks the recorded columns in order:
  per column, one synthesized `BookState` at the column's `t0_ns` (nonzero
  density rows → levels at `row_to_price`; f16→f64 lossless) plus the
  interval's trades/markers. Pacing: wall-clock `_Clock` (position + speed +
  pause), so `await`-free `control()` mutates state the generator observes
  between ticks.
- **Controls.** `Seek{t}` moves the clock and the cursor (first column whose
  interval contains t); `SetSpeed{x}` scales pacing; `Pause/Resume` freeze/
  release. Speed alone does NOT un-pause (pause yields only to Resume).
  End-of-recording PARKS the feed (StopAsyncIteration would tear the session
  down); a Seek rewinds and iteration continues.
- **Wiring.** `SessionManager.subscribe` builds a ReplayFeed from
  `recorder.load_all(...)` for `mode='replay'` (raises
  `ReplayUnavailableError` when no store / no recording → ws refusal
  Status{degraded} + 1003). Replay sessions keep `recorder=None` and no
  backfill (already gated on mode=='live'). `Session.feed_control(ev)`
  forwards to the feed when it has a `control` surface; ws dispatch routes
  Seek/SetSpeed/Pause/Resume there.
- **Client gating.** `_capability()` now merges `replay: True` into every
  Hello/Status capability (server-level truth); the client renders the
  Replay toggle only when `capability.replay === true`.
- **Fidelity note (deliberate).** Replay resynthesizes book snapshots from
  finalized densities; the grid re-integrates at its own cadence. Column
  shape and prices match the recording; within-interval microstructure does
  not. Replay is for study, not tick forensics.

## Tests

- `tests/feeds/test_replay.py` — fast delivery/ordering, pause freeze,
  seek cursor+stream, set-speed acceleration, end-of-recording parking.
- `tests/api/test_ws_e2e.py::test_replay_engine_streams_recorded_session` —
  real uvicorn: pre-seeded recording → Hello(capability.replay) → finals at
  recorded pace → Pause stalls → SetSpeed alone does not un-pause → Resume
  burns through the rest, col_seq strictly increasing.
- `test_replay_subscribe_refused_with_1003` — the no-recording refusal.
