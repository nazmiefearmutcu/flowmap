"""Unit tests for replay materialize OOM cap (FIND-P239-03).

Covers:
- ``_consume_iter_capped`` truncates long generators at max_records
- short iterables are fully consumed (not truncated)
- max_records None / <= 0 means unlimited
- env ``FLOWMAP_REPLAY_MAX_RECORDS``: default 2_000_000, 0 => unlimited
"""

from __future__ import annotations

import os
import unittest
from unittest import mock

from flowmap.data.crypcodile_replay import (
    _consume_iter_capped,
    _replay_max_records,
)


def _count_gen(n: int):
    """Yield 0..n-1; tracks how far the generator was driven."""
    for i in range(n):
        yield i


class TestConsumeIterCapped(unittest.TestCase):
    def test_truncates_long_generator(self):
        items, truncated = _consume_iter_capped(_count_gen(10_000), max_records=100)
        self.assertEqual(len(items), 100)
        self.assertEqual(items, list(range(100)))
        self.assertTrue(truncated)

    def test_does_not_drive_past_cap(self):
        """Cap must stop iteration early so OOM materialize cannot run away."""
        driven = []

        def gen():
            for i in range(1_000_000):
                driven.append(i)
                yield i

        items, truncated = _consume_iter_capped(gen(), max_records=50)
        self.assertEqual(len(items), 50)
        self.assertTrue(truncated)
        # At most one extra peek for truncation detection is acceptable,
        # but must not exhaust the generator.
        self.assertLessEqual(len(driven), 51)
        self.assertGreaterEqual(len(driven), 50)

    def test_short_iterable_not_truncated(self):
        items, truncated = _consume_iter_capped(_count_gen(10), max_records=100)
        self.assertEqual(items, list(range(10)))
        self.assertFalse(truncated)

    def test_exact_cap_length_not_truncated_if_exhausted(self):
        """Exactly N items available and max_records=N → full consume, not truncated."""
        items, truncated = _consume_iter_capped(_count_gen(5), max_records=5)
        self.assertEqual(items, list(range(5)))
        self.assertFalse(truncated)

    def test_none_is_unlimited(self):
        items, truncated = _consume_iter_capped(_count_gen(200), max_records=None)
        self.assertEqual(len(items), 200)
        self.assertFalse(truncated)

    def test_zero_or_negative_is_unlimited(self):
        for cap in (0, -1):
            items, truncated = _consume_iter_capped(_count_gen(50), max_records=cap)
            self.assertEqual(len(items), 50, msg=f"cap={cap}")
            self.assertFalse(truncated, msg=f"cap={cap}")


class TestReplayMaxRecordsEnv(unittest.TestCase):
    def test_default_is_two_million(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("FLOWMAP_REPLAY_MAX_RECORDS", None)
            self.assertEqual(_replay_max_records(), 2_000_000)

    def test_env_override(self):
        with mock.patch.dict(os.environ, {"FLOWMAP_REPLAY_MAX_RECORDS": "12345"}):
            self.assertEqual(_replay_max_records(), 12345)

    def test_env_zero_is_unlimited(self):
        """FLOWMAP_REPLAY_MAX_RECORDS=0 → unlimited (None)."""
        with mock.patch.dict(os.environ, {"FLOWMAP_REPLAY_MAX_RECORDS": "0"}):
            self.assertIsNone(_replay_max_records())


if __name__ == "__main__":
    unittest.main()
