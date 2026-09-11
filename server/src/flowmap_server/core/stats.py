"""Server-side operational statistics producer (campaign contract C1).

Every drop/restart counter the server already maintained was write-only:
:class:`~flowmap_server.feeds.base.BoundedFeedQueue.dropped`,
``_BridgeSink.dropped_ts``, the ``ClientTx`` lag drops, feed restarts and
recording flush failures all happened silently. :class:`SessionStats` is the
single aggregate they feed, mounted as ``SessionManager.stats``; the API layer
surfaces ``stats.snapshot()`` verbatim (``/api/health`` v3) and the WS layer
feeds per-connection measurements through the hooks.

The snapshot shape is FROZEN (contract C1 — SB renders it verbatim, must not
reshape it)::

    {
        "drops":       {"feed": int, "tx_lag": int, "snapshot": int},
        "restarts":    int,
        "sessions":    {"active": int, "rejected": int},
        "latency_ms":  float,          # EMA over measured connection RTT/2
        "staleness_ms": {key: float},  # per session, see below
        "clock_skew_ms": float,        # latest client-minus-server wall skew
        "recording":   {"enabled": bool, "flush_failures": int,
                        "last_flush_ts": int | None},
    }

Counter semantics (where each number comes from):

- ``drops.feed`` — drop-OLDEST evictions from the bounded connector->consumer
  fan-in queues (:class:`BoundedFeedQueue`): a stalled session consumer
  discarding live events.
- ``drops.tx_lag`` — whole finalized columns dropped oldest-first from a
  client send queue once their unsent age exceeded the lag bound
  (``ClientTx._evict_lagged``); counted per COLUMN (a depth+bar pair sharing
  ``t0_ns`` counts once), exactly what the gap Markers tell the client.
- ``drops.snapshot`` — live-ingest records discarded by the venue timestamp
  sanity gate (``_BridgeSink.dropped_ts`` / ``_EquitySink.dropped_ts``):
  implausible venue stamps (ms-in-ns, pre-2010, >24 h in the future).
- ``restarts`` — feed crash restarts (the exponential-backoff loop in
  ``Session.run``).
- ``sessions.active`` — live callback into the manager's session table;
  ``sessions.rejected`` — subscribes refused (session limit, replay
  unavailable/stale, invalid symbol).
- ``latency_ms`` — EMA (alpha 0.25, first sample seeds) of the WS-measured
  round-trip half-delay fed via :meth:`record_rtt`.
- ``staleness_ms`` — a DICT keyed by session id: age (wall-clock ms) of the
  last feed event arrival per active session. A session that has not received
  any event yet ages from its creation — a feed that died silently shows a
  growing age instead of looking fresh. Entries are removed when the session
  leaves the manager's table.
- ``clock_skew_ms`` — latest ``client_wall_ns - server_wall_ns`` measurement
  (positive = client ahead); latest-wins because re-subscribes legitimately
  reset it.
- ``recording.enabled`` — true while any active session has an open session
  recorder; ``flush_failures`` — Parquet write failures (transient disk/AV
  conditions, retried with backoff by the session); ``last_flush_ts`` — wall
  ns of the most recent successful recording flush.

Threading: every mutator runs on the event-loop thread (counters are plain
int increments, no locks on the hot path). ``snapshot()`` may be called from
a worker thread (the health handler runs in the FastAPI threadpool), so the
staleness dict is copied defensively — a dict growing during iteration is
retried rather than raced.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable

__all__ = ["SessionStats"]

logger = logging.getLogger(__name__)

Clock = Callable[[], int]  # monotonic or wall ns

# EMA smoothing for the connection RTT. 0.25 ≈ a ~4-ping memory: responsive
# enough to catch a latency regression, smooth enough that one slow pong (AV
# scan, GC pause) does not dominate the headline number.
_RTT_EMA_ALPHA = 0.25


class SessionStats:
    """Aggregate server telemetry; mounted as ``SessionManager.stats``."""

    def __init__(
        self,
        *,
        clock: Clock = time.monotonic_ns,
        wall_clock: Clock = time.time_ns,
        active_sessions: Callable[[], int] | None = None,
    ) -> None:
        self._clock = clock
        self._wall_clock = wall_clock
        self._active_fn = active_sessions

        self._drops_feed = 0
        self._drops_tx_lag = 0
        self._drops_snapshot = 0
        self._restarts = 0
        self._rejected = 0
        self._flush_failures = 0

        self._latency_ms = 0.0
        self._clock_skew_ms = 0.0
        self._has_rtt = False

        # Per-session liveness: key -> last-event wall ns (and creation wall
        # ns for sessions that have not seen an event yet).
        self._last_sample_ns: dict[str, int] = {}
        self._started_ns: dict[str, int] = {}
        # Session ids with an open session recorder.
        self._recording: set[str] = set()
        self._last_flush_ts: int | None = None

    # -- counter increments (hot path: plain int adds) -------------------------

    def inc_feed_drops(self, n: int = 1) -> None:
        self._drops_feed += n

    def inc_tx_lag_drops(self, n: int = 1) -> None:
        self._drops_tx_lag += n

    def inc_snapshot_drops(self, n: int = 1) -> None:
        self._drops_snapshot += n

    def inc_restart(self) -> None:
        self._restarts += 1

    def inc_rejected(self) -> None:
        self._rejected += 1

    def inc_flush_failure(self) -> None:
        self._flush_failures += 1

    # -- per-connection measurement hooks (fed by the WS layer) ----------------

    def record_rtt(self, latency_ms: float) -> None:
        """Feed one measured connection round-trip half-delay (ms)."""
        ms = float(latency_ms)
        if ms != ms or ms in (float("inf"), float("-inf")) or ms < 0.0:
            return  # never let a hostile measurement poison the EMA
        if self._has_rtt:
            self._latency_ms += _RTT_EMA_ALPHA * (ms - self._latency_ms)
        else:
            self._latency_ms = ms
            self._has_rtt = True

    def record_clock_skew(self, skew_ms: float) -> None:
        """Feed the latest client-minus-server wall-clock skew (ms)."""
        ms = float(skew_ms)
        if ms != ms or ms in (float("inf"), float("-inf")):
            return
        self._clock_skew_ms = ms

    # -- session liveness -------------------------------------------------------

    def note_session(self, key: str) -> None:
        """Register a session for staleness tracking (at creation)."""
        self._started_ns[key] = self._wall_clock()
        self._last_sample_ns.pop(key, None)

    def forget_session(self, key: str) -> None:
        """Drop a session's staleness entry (it left the manager's table)."""
        self._started_ns.pop(key, None)
        self._last_sample_ns.pop(key, None)

    def note_live_sample(self, key: str) -> None:
        """Record a feed-event arrival for *key* (called per consumed event)."""
        self._last_sample_ns[key] = self._wall_clock()

    # -- recording --------------------------------------------------------------

    def note_recording(self, key: str, enabled: bool) -> None:
        if enabled:
            self._recording.add(key)
        else:
            self._recording.discard(key)

    def note_flush(self) -> None:
        """Record a successful recording flush (wall-clock stamped)."""
        self._last_flush_ts = self._wall_clock()

    # -- snapshot (contract C1 — shape frozen) -----------------------------------

    def snapshot(self) -> dict[str, object]:
        """The frozen C1 dict; rendered verbatim by ``/api/health`` v3."""
        now = self._wall_clock()
        try:
            started = dict(self._started_ns)
            last = dict(self._last_sample_ns)
        except RuntimeError:  # pragma: no cover — dict mutated mid-copy
            started = {k: self._started_ns[k] for k in list(self._started_ns)}
            last = {k: self._last_sample_ns[k] for k in list(self._last_sample_ns)}
        staleness = {
            key: round((now - last.get(key, birth)) / 1e6, 1)
            for key, birth in started.items()
        }
        active = self._active_fn() if self._active_fn is not None else len(started)
        return {
            "drops": {
                "feed": self._drops_feed,
                "tx_lag": self._drops_tx_lag,
                "snapshot": self._drops_snapshot,
            },
            "restarts": self._restarts,
            "sessions": {"active": active, "rejected": self._rejected},
            "latency_ms": round(self._latency_ms, 3),
            "staleness_ms": staleness,
            "clock_skew_ms": round(self._clock_skew_ms, 3),
            "recording": {
                "enabled": bool(self._recording),
                "flush_failures": self._flush_failures,
                "last_flush_ts": self._last_flush_ts,
            },
        }
