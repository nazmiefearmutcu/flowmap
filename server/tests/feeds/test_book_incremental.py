"""Incremental top-N book maintenance in _BridgeSink (campaign item: the old
path sorted the ENTIRE book dict twice per delta - O(N log N) Python at venue
delta rates on the event loop).

The property contract: for ANY delta/snapshot sequence, the emitted BookState
arrays are BYTE-IDENTICAL (same values, same best-first order, same cap) to
the old full-sort-per-delta reference implementation.
"""

from __future__ import annotations

import random

import numpy as np
import pytest

from flowmap_server.feeds.crypto import BOOK_TOP_N, _BridgeSink


class _ReferenceSink:
    """The OLD emit path, verbatim: full sort of the dict, every time."""

    def __init__(self, book_top_n: int = BOOK_TOP_N):
        self._book_top_n = max(1, book_top_n)
        self._bids: dict[float, float] = {}
        self._asks: dict[float, float] = {}
        self.emitted: list = []

    def emit(self, ts_ns: int) -> None:
        cap = self._book_top_n
        bids = sorted(self._bids.items(), key=lambda kv: -kv[0])[:cap]
        asks = sorted(self._asks.items())[:cap]
        bid = np.array(bids, dtype=np.float64).reshape(-1, 2)
        ask = np.array(asks, dtype=np.float64).reshape(-1, 2)
        self.emitted.append((bid[:, 0], bid[:, 1], ask[:, 0], ask[:, 1]))

    # Old static _apply_levels semantics.
    @staticmethod
    def _apply_levels(levels, side):
        for price, amount in levels:
            if not (price > 0.0) or amount < 0.0 or amount != amount:
                continue
            if amount == 0.0:
                side.pop(price, None)
            else:
                side[price] = amount


def _new_sink_emit(sink: _BridgeSink, ts: int):
    """The NEW emit path, driven exactly as put() drives it."""
    sink._emit_book(ts)


def _collect(sink: _BridgeSink):
    out = sink._out
    book = out.pop()
    return (book.bid_px, book.bid_sz, book.ask_px, book.ask_sz)


def _make_sink(cap):
    out: list = []
    sink = _BridgeSink(out.append, book_top_n=cap)
    sink._out = out
    return sink


def _apply_like_delta(sink, bids, asks):
    sink._bid_px = sink._apply_levels(bids, sink._bids, sink._bid_px)
    sink._ask_px = sink._apply_levels(asks, sink._asks, sink._ask_px)
    _new_sink_emit(sink, 1)


def _apply_like_snapshot(sink, bids, asks):
    sink._bids.clear()
    sink._asks.clear()
    sink._bid_px = None
    sink._ask_px = None
    sink._apply_levels(bids, sink._bids, None)
    sink._apply_levels(asks, sink._asks, None)
    _new_sink_emit(sink, 1)


def _random_levels(rng: random.Random, prices: set[float], n: int):
    """A random delta batch: sets, removes, no-ops, malformed entries."""
    levels = []
    pool = sorted(prices)
    for _ in range(n):
        if pool and rng.random() < 0.45:
            p = rng.choice(pool)
            if rng.random() < 0.3:
                levels.append((p, 0.0))  # remove
            else:
                levels.append((p, rng.uniform(0.1, 50.0)))  # set
        else:
            p = round(rng.uniform(90.0, 110.0), 2)
            levels.append((p, rng.uniform(0.1, 50.0)))  # insert (maybe existing)
    # Malformed entries the gate must skip identically on both paths.
    levels.append((0.0, 5.0))
    levels.append((-3.0, 5.0))
    levels.append((100.5, -1.0))
    levels.append((float("nan"), 5.0))
    return levels


@pytest.mark.parametrize("cap", [3, 25, 10_000])
def test_top_n_byte_identical_to_full_sort_reference(cap):
    """Random delta/snapshot storm: every emitted book matches the old
    full-sort implementation exactly (values, order, cap)."""
    rng = random.Random(20260910)
    prices = {round(90.0 + i * 0.25, 2) for i in range(160)}
    new = _make_sink(cap)
    ref = _ReferenceSink(cap)

    # Initial snapshot replace.
    bids = _random_levels(rng, prices, 120)
    asks = _random_levels(rng, prices, 120)
    _apply_like_snapshot(new, bids, asks)
    ref._apply_levels(bids, ref._bids)
    ref._apply_levels(asks, ref._asks)
    ref.emit(1)
    got0 = _collect(new)
    for g, w in zip(got0, ref.emitted[-1]):
        assert np.array_equal(g, w)

    for step in range(60):
        bids = _random_levels(rng, prices, rng.randint(1, 30))
        asks = _random_levels(rng, prices, rng.randint(1, 30))
        if rng.random() < 0.1:  # occasional resync snapshot
            _apply_like_snapshot(new, bids, asks)
            ref._bids.clear()
            ref._asks.clear()
            ref._apply_levels(bids, ref._bids)
            ref._apply_levels(asks, ref._asks)
        else:
            _apply_like_delta(new, bids, asks)
            ref._apply_levels(bids, ref._bids)
            ref._apply_levels(asks, ref._asks)
        ref.emit(1)
        got = _collect(new)
        want = ref.emitted[-1]
        for g, w in zip(got, want):
            assert np.array_equal(g, w), f"mismatch at step {step}"


def test_delta_maintains_index_incrementally():
    """White-box: a delta leaves the price index consistent (NOT dirty), so
    the next emit costs no sort."""
    sink = _make_sink(10)
    _apply_like_delta(sink, [(100.0, 1.0), (99.5, 2.0)], [(101.0, 1.0)])
    assert sink._bid_px is not None
    assert sink._ask_px is not None
    assert sink._bid_px == sorted(sink._bid_px)
    assert sink._ask_px == sorted(sink._ask_px)
    # Index survived the emit (no dirty flag flip).
    assert sink._bid_px is not None


def test_out_of_band_dict_mutation_degrades_to_resort():
    """Direct dict writes (tests / future code) can go stale: the len() check
    at emit forces a one-shot rebuild instead of serving a wrong book."""
    sink = _make_sink(10)
    _apply_like_delta(sink, [(100.0, 1.0)], [(101.0, 1.0)])
    assert sink._bid_px == [100.0]
    # Out-of-band insert changes len: the index must be rebuilt at emit.
    sink._bids[99.0] = 3.0
    _new_sink_emit(sink, 1)
    book = sink._out.pop()
    assert list(book.bid_px) == [100.0, 99.0]  # rebuilt, best-first


def test_top_n_cap_still_keeps_closest_levels():
    """The pre-existing closest-to-touch contract (test_crypto_bridge) holds
    on the incremental path too."""
    out: list = []
    sink = _BridgeSink(out.append, book_top_n=3)
    sink._initialized = True
    for i in range(10):
        sink._bids[100.0 - i] = 1.0
        sink._asks[101.0 + i] = 1.0
    sink._emit_book(123)
    book = out[-1]
    assert list(book.bid_px) == [100.0, 99.0, 98.0]
    assert list(book.ask_px) == [101.0, 102.0, 103.0]
