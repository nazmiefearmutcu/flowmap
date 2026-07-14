"""Unit tests for adaptive GUI drain + session epoch filtering (Task 9).

FIND-P214 residual — adaptive drain limit
FIND-P222-02 — session stamp / stale drop
"""

from __future__ import annotations

import queue
import unittest

from flowmap.ui.source_manager import (
    DRAIN_MAX,
    DRAIN_MIN,
    SessionStampQueue,
    adaptive_drain_limit,
    parse_queue_item,
)


class TestAdaptiveDrainLimit(unittest.TestCase):
    def test_floor_at_min(self):
        self.assertEqual(adaptive_drain_limit(0), DRAIN_MIN)
        self.assertEqual(adaptive_drain_limit(1), DRAIN_MIN)
        self.assertEqual(adaptive_drain_limit(999), DRAIN_MIN)

    def test_grows_with_qsize(self):
        # limit = min(5000, max(1000, qsize+1))
        self.assertEqual(adaptive_drain_limit(1500), 1501)
        self.assertEqual(adaptive_drain_limit(4999), 5000)

    def test_cap_at_max(self):
        self.assertEqual(adaptive_drain_limit(10_000), DRAIN_MAX)
        self.assertEqual(adaptive_drain_limit(1_000_000), DRAIN_MAX)

    def test_negative_and_bad_input(self):
        self.assertEqual(adaptive_drain_limit(-5), DRAIN_MIN)
        self.assertEqual(adaptive_drain_limit("x"), DRAIN_MIN)  # type: ignore[arg-type]
        self.assertEqual(adaptive_drain_limit(None), DRAIN_MIN)  # type: ignore[arg-type]


class TestParseQueueItem(unittest.TestCase):
    def test_legacy_2tuple_always_accepted(self):
        self.assertEqual(parse_queue_item(("trade", "T1"), 0), ("trade", "T1"))
        self.assertEqual(parse_queue_item(("trade", "T1"), 99), ("trade", "T1"))

    def test_triple_matching_session(self):
        self.assertEqual(
            parse_queue_item(("snapshot", "S", 3), 3),
            ("snapshot", "S"),
        )

    def test_triple_stale_session_dropped(self):
        self.assertIsNone(parse_queue_item(("update", "U", 1), 2))
        self.assertIsNone(parse_queue_item(("trade", "T", 0), 1))

    def test_invalid_shapes(self):
        self.assertIsNone(parse_queue_item(None, 0))
        self.assertIsNone(parse_queue_item("x", 0))
        self.assertIsNone(parse_queue_item(("only",), 0))
        self.assertIsNone(parse_queue_item([], 0))


class TestSessionStampQueue(unittest.TestCase):
    def test_stamps_2tuples(self):
        raw: queue.Queue = queue.Queue()
        stamp = SessionStampQueue(raw, stamp_session=7)
        stamp.put(("bbo", "B"))
        item = raw.get_nowait()
        self.assertEqual(item, ("bbo", "B", 7))

    def test_leaves_triples_alone(self):
        raw: queue.Queue = queue.Queue()
        stamp = SessionStampQueue(raw, stamp_session=1)
        stamp.put(("trade", "T", 99))
        self.assertEqual(raw.get_nowait(), ("trade", "T", 99))

    def test_late_put_after_stamp_frozen_is_stale(self):
        """After stop, stamp stays old while current_session bumps → drop."""
        raw: queue.Queue = queue.Queue()
        stamp = SessionStampQueue(raw, stamp_session=5)
        current_session = 5
        stamp.put(("update", "U1"))
        # stop: bump session, do not change stamp
        current_session = 6
        stamp.put(("update", "U2"))  # still stamped 5
        a = parse_queue_item(raw.get_nowait(), current_session)
        b = parse_queue_item(raw.get_nowait(), current_session)
        self.assertIsNone(a)
        self.assertIsNone(b)

    def test_recapture_accepts_new_puts(self):
        raw: queue.Queue = queue.Queue()
        stamp = SessionStampQueue(raw, stamp_session=0)
        current = 0
        stamp.put(("trade", "old"))
        current = 1
        stamp.stamp_session = current  # capture on start
        stamp.put(("trade", "new"))
        self.assertIsNone(parse_queue_item(raw.get_nowait(), current))
        self.assertEqual(parse_queue_item(raw.get_nowait(), current), ("trade", "new"))


if __name__ == "__main__":
    unittest.main()
