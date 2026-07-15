"""Run Phase-4 order-book / density / BBO unit tests (unittest, no pytest needed).

Usage:
  /Users/nazmi/flowmap/.venv/bin/python tests/_run_phase4_live_reconnect.py
"""
from __future__ import annotations

import pathlib
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def main() -> int:
    loader = unittest.TestLoader()
    suite = unittest.TestSuite()
    for name in (
        "tests.test_order_book_fixes",
        "tests.test_density_midmask",
        "tests.test_bbo_pipeline",
    ):
        suite.addTests(loader.loadTestsFromName(name))
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())
