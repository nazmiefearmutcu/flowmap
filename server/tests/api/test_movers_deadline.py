"""A2-5 hardening: bounded movers sweep + explicit network timeouts.

- ``_bounded_quote_sweep`` (the production movers fetch set) must respect a
  wall-clock deadline: a hung/slow provider cancels past the deadline and the
  sweep serves whatever already finished, instead of hanging the endpoint for
  the full (previously unbounded) duration.
- The backfill REST session must carry an explicit total timeout (the boot
  path holds the session's start lock while it runs).
"""

from __future__ import annotations

import asyncio
import time

from flowmap_server.api.market_cache import QuoteData, _bounded_quote_sweep


def _quote(symbol: str) -> QuoteData:
    return QuoteData(market="crypto", symbol=symbol, price=1.0, change_pct=1.0)


async def test_sweep_all_fast_fetches_return_every_result():
    async def fetch(symbol: str) -> QuoteData:
        return _quote(symbol)

    got = await _bounded_quote_sweep(fetch, ["A", "B", "C"], deadline_s=5.0)
    assert [q.symbol for q in got] == ["A", "B", "C"]


async def test_sweep_respects_deadline_and_serves_partial_results():
    started = time.monotonic()

    async def fetch(symbol: str) -> QuoteData:
        if symbol == "HANG":
            await asyncio.sleep(30.0)  # a hung endpoint: far past the deadline
        return _quote(symbol)

    got = await _bounded_quote_sweep(
        fetch, ["A", "HANG", "B"], deadline_s=0.05
    )
    elapsed = time.monotonic() - started
    # No hang: the sweep returned near the deadline, not near the 30 s fetch.
    assert elapsed < 5.0
    # The finished fetches survived, in order; the hung one is a hole.
    assert [q.symbol if q is not None else None for q in got] == ["A", None, "B"]


async def test_sweep_swallows_per_symbol_errors():
    async def fetch(symbol: str) -> QuoteData:
        if symbol == "BAD":
            raise RuntimeError("provider 500")
        return _quote(symbol)

    got = await _bounded_quote_sweep(fetch, ["A", "BAD"], deadline_s=5.0)
    assert [q.symbol if q is not None else None for q in got] == ["A", None]


async def test_sweep_empty_candidates_is_empty():
    async def fetch(symbol: str) -> QuoteData:
        raise AssertionError("never called")

    assert await _bounded_quote_sweep(fetch, [], deadline_s=5.0) == []


async def test_backfill_session_carries_explicit_total_timeout():
    from flowmap_server.core.backfill import _HTTP_TIMEOUT_S, _hardened_backfill

    bf, session = _hardened_backfill("binance", "usdm")
    try:
        assert bf is not None and session is not None
        assert session.timeout.total == _HTTP_TIMEOUT_S
        assert 10.0 <= session.timeout.total <= 15.0
    finally:
        await session.close()
