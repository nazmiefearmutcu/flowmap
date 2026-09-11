"""Runtime compatibility shims, applied when ``flowmap_server`` is imported.

crocodile's ``now_ns`` stamps every BookState / trade ``local_ts`` through
``time.clock_gettime_ns(CLOCK_REALTIME)``, which CPython does not provide on
Windows. Left alone, the feed loop raises ``AttributeError`` on each stamp and
the crypto bridge never produces a column (the packaged Windows pyruntime used to
need a hand-edited copy of crocodile for this). ``time.time_ns`` is the same
realtime reading, so the name is rebound here — before any crocodile module can
bind it — and also on modules that already hold the old binding.
"""

from __future__ import annotations

import importlib
import sys
import time


def apply_crocodile_now_ns() -> bool:
    """Rebind crocodile's ``now_ns`` to ``time.time_ns`` when the platform lacks
    ``clock_gettime_ns``. Returns True when a rebind happened."""
    if hasattr(time, "clock_gettime_ns"):
        return False
    try:
        ctime = importlib.import_module("crocodile.core.util.time")
    except ImportError:
        return False
    original = getattr(ctime, "now_ns", None)
    if original is None or original is time.time_ns:
        return False
    ctime.now_ns = time.time_ns
    for name, mod in list(sys.modules.items()):
        if name.startswith("crocodile") and getattr(mod, "now_ns", None) is original:
            mod.now_ns = time.time_ns
    return True


apply_crocodile_now_ns()
