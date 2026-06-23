import unittest
from flowmap.core import BBO, Side, BookLevel
from flowmap.core.order_book import OrderBook

class TestBBOPipeline(unittest.TestCase):
    def test_apply_bbo_updates_state(self):
        ob = OrderBook(symbol="BTCUSDT", depth=20)
        
        # Initially BBO is empty
        self.assertEqual(ob._best_bid, 0.0)
        self.assertEqual(ob._best_ask, 0.0)
        
        # Apply a BBO update
        bbo1 = BBO(
            timestamp=1000.0,
            symbol="BTCUSDT",
            bid=99000.0,
            ask=99010.0,
            bid_size=1.5,
            ask_size=2.0,
            receive_timestamp=1000.1
        )
        ob.apply_bbo(bbo1)
        
        # Verify best bid/ask variables are set
        self.assertEqual(ob._best_bid, 99000.0)
        self.assertEqual(ob._best_ask, 99010.0)
        self.assertEqual(ob._best_bid_size, 1.5)
        self.assertEqual(ob._best_ask_size, 2.0)
        
        # Verify the prices are added to the bids/asks dictionaries
        self.assertIn(99000.0, ob._bids)
        self.assertIn(99010.0, ob._asks)
        self.assertEqual(ob._bids[99000.0], 1.5)
        self.assertEqual(ob._asks[99010.0], 2.0)

    def test_apply_bbo_prunes_stale_levels(self):
        ob = OrderBook(symbol="BTCUSDT", depth=20)
        
        # Feed some bid/ask levels manually via SortedDict
        ob._bids[99000.0] = 1.0
        ob._bids[99005.0] = 0.5  # Higher than 99000.0
        ob._bids[98990.0] = 2.0  # Lower than 99000.0
        
        ob._asks[99010.0] = 2.0
        ob._asks[99008.0] = 1.0  # Lower than 99010.0
        ob._asks[99020.0] = 3.0  # Higher than 99010.0
        
        # Now apply a new BBO where best bid is 99000.0 and best ask is 99010.0
        bbo = BBO(
            timestamp=1001.0,
            symbol="BTCUSDT",
            bid=99000.0,
            ask=99010.0,
            bid_size=1.5,
            ask_size=2.5
        )
        ob.apply_bbo(bbo)
        
        # The bid at 99005.0 should be pruned because it is > new best bid (99000.0)
        # The bid at 98990.0 should remain because it is <= new best bid (99000.0)
        self.assertNotIn(99005.0, ob._bids)
        self.assertIn(98990.0, ob._bids)
        self.assertIn(99000.0, ob._bids)
        self.assertEqual(ob._bids[99000.0], 1.5)
        
        # The ask at 99008.0 should be pruned because it is < new best ask (99010.0)
        # The ask at 99020.0 should remain because it is >= new best ask (99010.0)
        self.assertNotIn(99008.0, ob._asks)
        self.assertIn(99020.0, ob._asks)
        self.assertIn(99010.0, ob._asks)
        self.assertEqual(ob._asks[99010.0], 2.5)

if __name__ == '__main__':
    unittest.main()
