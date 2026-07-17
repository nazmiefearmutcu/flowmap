#!/usr/bin/env python
"""Manual LIVE smoke test for CryptoFeed — real network, NOT a pytest test.

Connects the real CryptoFeed (crypcodile connector + AiohttpWsTransport) to
an exchange, consumes events for ``--duration`` seconds, and reports counts
per event type, event rate, book shape, best bid/ask samples, and trade
count.

Exit status 0 iff at least one two-sided BookState AND at least one Trade
were observed.

Usage::

    .venv/bin/python scripts/live_crypto_smoke.py \
        --exchange binance --market spot --symbol BTCUSDT --duration 30
"""

from __future__ import annotations

import argparse
import asyncio
import sys
import time
from collections import Counter

from flowmap_server.config import Config
from flowmap_server.feeds.base import BookState
from flowmap_server.feeds.crypto import CryptoFeed
from flowmap_server.proto.events import BBO, Marker, Trade


async def run(args: argparse.Namespace) -> int:
    cfg = Config()
    feed = CryptoFeed(
        exchange=args.exchange, symbol=args.symbol, market=args.market, cfg=cfg
    )
    print(
        f"connecting: market={feed.market} symbol={feed.symbol} "
        f"duration={args.duration:.0f}s capability={feed.capability}"
    )

    counts: Counter[str] = Counter()
    two_sided_books = 0
    last_book: BookState | None = None
    bbo_sample: BBO | None = None
    trade_sample: Trade | None = None
    marker_kinds: Counter[str] = Counter()

    t0 = time.monotonic()
    deadline = t0 + args.duration
    gen = feed.events()
    try:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            try:
                ev = await asyncio.wait_for(anext(gen), timeout=remaining)
            except (StopAsyncIteration, TimeoutError):
                break
            counts[type(ev).__name__] += 1
            if isinstance(ev, BookState):
                last_book = ev
                if len(ev.bid_px) and len(ev.ask_px):
                    two_sided_books += 1
            elif isinstance(ev, Trade):
                trade_sample = trade_sample or ev
            elif isinstance(ev, BBO):
                bbo_sample = ev
            elif isinstance(ev, Marker):
                marker_kinds[ev.kind] += 1
    finally:
        await gen.aclose()

    elapsed = max(time.monotonic() - t0, 1e-9)
    total = sum(counts.values())
    print(f"\n--- results after {elapsed:.1f}s ---")
    for name in sorted(counts):
        print(f"  {name:<10} {counts[name]:>7}  ({counts[name] / elapsed:.1f}/s)")
    print(f"  total      {total:>7}  ({total / elapsed:.1f}/s)")
    if marker_kinds:
        print(f"  marker kinds: {dict(marker_kinds)}")
    print(
        f"grid columns/sec at dt={cfg.dt_crypto_ns / 1e6:.0f}ms: "
        f"{1e9 / cfg.dt_crypto_ns:.1f} (book updates arrive at "
        f"{counts['BookState'] / elapsed:.1f}/s to time-weight into them)"
    )
    if last_book is not None:
        bb = float(last_book.bid_px.max()) if len(last_book.bid_px) else float("nan")
        ba = float(last_book.ask_px.min()) if len(last_book.ask_px) else float("nan")
        print(
            f"book levels: {len(last_book.bid_px)} bid / {len(last_book.ask_px)} ask; "
            f"best bid/ask sample: {bb:.2f} / {ba:.2f} "
            f"(spread {ba - bb:.2f}, two-sided books: {two_sided_books})"
        )
    if trade_sample is not None:
        print(
            f"first trade: px={trade_sample.price} sz={trade_sample.size} "
            f"side={trade_sample.side} side_src={trade_sample.side_src} "
            f"venue={trade_sample.venue}"
        )
    if bbo_sample is not None:
        print(
            f"last bbo: {bbo_sample.bid_px} x {bbo_sample.bid_sz} / "
            f"{bbo_sample.ask_px} x {bbo_sample.ask_sz}"
        )
    print(f"trade count: {counts['Trade']}")

    ok = two_sided_books >= 1 and counts["Trade"] >= 1
    print(f"SMOKE {'PASS' if ok else 'FAIL'}")
    return 0 if ok else 1


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--exchange", default="binance")
    ap.add_argument("--symbol", default="BTCUSDT")
    ap.add_argument("--market", default="spot", help="spot | usdm | '' (bare exchange)")
    ap.add_argument("--duration", type=float, default=30.0, help="seconds")
    args = ap.parse_args()
    return asyncio.run(run(args))


if __name__ == "__main__":
    sys.exit(main())
