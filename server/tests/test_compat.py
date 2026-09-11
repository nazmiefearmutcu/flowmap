"""The Windows ``now_ns`` shim: crocodile reads CLOCK_REALTIME through
``time.clock_gettime_ns``, which CPython lacks on Windows (a fresh venv on the
Windows CI leg hung the bookstate bridge test forever)."""

import sys
import time
import types

from flowmap_server import _compat


def _fake_crocodile(monkeypatch):
    def original() -> int:
        return 1

    ctime = types.ModuleType("crocodile.core.util.time")
    ctime.now_ns = original
    consumer = types.ModuleType("crocodile.fake_consumer")
    consumer.now_ns = original  # `from crocodile.core.util.time import now_ns`
    monkeypatch.setitem(sys.modules, "crocodile.core.util.time", ctime)
    monkeypatch.setitem(sys.modules, "crocodile.fake_consumer", consumer)
    return original, ctime, consumer


def test_rebinds_now_ns_when_clock_gettime_ns_is_missing(monkeypatch):
    monkeypatch.delattr(time, "clock_gettime_ns", raising=False)
    original, ctime, consumer = _fake_crocodile(monkeypatch)
    assert _compat.apply_crocodile_now_ns() is True
    assert ctime.now_ns is time.time_ns
    assert consumer.now_ns is time.time_ns, "already-bound consumers are rebound too"
    assert original() == 1, "the original is left callable, just unreferenced"


def test_noop_when_clock_gettime_ns_exists(monkeypatch):
    monkeypatch.setattr(time, "clock_gettime_ns", lambda *_a: 0, raising=False)
    _, ctime, _ = _fake_crocodile(monkeypatch)
    assert _compat.apply_crocodile_now_ns() is False
    assert ctime.now_ns is not time.time_ns


def test_idempotent_second_apply(monkeypatch):
    monkeypatch.delattr(time, "clock_gettime_ns", raising=False)
    _fake_crocodile(monkeypatch)
    assert _compat.apply_crocodile_now_ns() is True
    assert _compat.apply_crocodile_now_ns() is False


def test_real_crocodile_now_ns_stamps_on_this_platform():
    from crocodile.core.util.time import now_ns

    assert now_ns() > 1_600_000_000 * 10**9
