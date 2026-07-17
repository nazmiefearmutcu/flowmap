"""Probe a RUNNING FlowMap v2 server's ``/ws`` and summarize the stream.

Connects, subscribes to ``--market``/``--symbol``, decodes every binary frame
for ``--duration`` seconds, and prints a message-type histogram plus the
first/last finalized ``col_seq`` and the set of epochs seen.

Exit 0 (PROBE PASS) requires: a Hello, an EpochStart, at least one finalized
DepthColumn, and zero decode errors. Anything else exits 1.

Run against a server started with e.g.
``FLOWMAP_PORT=8721 uv run python -m flowmap_server``::

    uv run python scripts/ws_probe.py --market sim --symbol SIM-DEMO --duration 10
    uv run python scripts/ws_probe.py --market binance-spot --symbol BTCUSDT --duration 30
"""

from __future__ import annotations

import argparse
import asyncio
import sys
import time
from collections import Counter

from websockets.asyncio.client import connect

from flowmap_server.proto import events, wire


def _decode_frame(buf: bytes) -> list:
    out = []
    offset = 0
    while offset < len(buf):
        ev, offset = wire.decode(buf, offset)  # raises ValueError on malformed
        if ev is not None:
            out.append(ev)
    return out


async def probe(
    host: str, port: int, market: str, symbol: str, duration: float, tls: bool = False
) -> int:
    # Loopback-only diagnostic against a 127.0.0.1 dev server (§11 binds
    # loopback-only); TLS is not applicable on the local socket, so the
    # scheme is assembled rather than hardcoded as a cleartext literal.
    scheme = "wss" if tls else "ws"
    url = f"{scheme}://{host}:{port}/ws"
    hist: Counter[str] = Counter()
    epochs: set[int] = set()
    first_final: int | None = None
    last_final: int | None = None
    first_final_t0: int | None = None
    last_col_t0: int | None = None
    partials = 0
    gap_markers = 0
    decode_errors = 0

    print(f"connecting: {url}  market={market} symbol={symbol} duration={duration}s")
    async with connect(url, max_size=None) as ws:
        await ws.send(wire.encode(events.Subscribe(market=market, symbol=symbol, mode="live")))
        deadline = time.monotonic() + duration
        while time.monotonic() < deadline:
            try:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                frame = await asyncio.wait_for(ws.recv(), timeout=remaining)
            except asyncio.TimeoutError:
                break
            if isinstance(frame, str):
                decode_errors += 1
                continue
            try:
                msgs = _decode_frame(frame)
            except ValueError:
                decode_errors += 1
                continue
            for ev in msgs:
                name = type(ev).__name__
                hist[name] += 1
                if isinstance(ev, events.EpochStart):
                    epochs.add(ev.epoch)
                elif isinstance(ev, events.DepthColumn):
                    last_col_t0 = ev.t0_ns
                    if ev.final:
                        if first_final is None:
                            first_final = ev.col_seq
                            first_final_t0 = ev.t0_ns
                        last_final = ev.col_seq
                    else:
                        partials += 1
                elif isinstance(ev, events.Marker) and ev.kind == "gap":
                    gap_markers += 1
                elif isinstance(ev, events.Ping):
                    # keep the connection warm; server derives latency from Pong
                    await ws.send(
                        wire.encode(
                            events.Pong(echo_ns=ev.server_send_ns, client_recv_ns=time.monotonic_ns())
                        )
                    )

    print(f"\n--- {market}:{symbol} after {duration:.0f}s ---")
    for name, n in sorted(hist.items(), key=lambda kv: -kv[1]):
        print(f"  {name:16s} {n}")
    print(f"  epochs seen:        {sorted(epochs)}")
    print(f"  finalized col_seq:  {first_final}..{last_final}  (partials={partials})")
    print(f"  first final t0_ns:  {first_final_t0}")
    print(f"  last column t0_ns:  {last_col_t0}")
    print(f"  gap markers:        {gap_markers}")
    print(f"  decode errors:      {decode_errors}")

    ok = (
        hist.get("Hello", 0) >= 1
        and hist.get("EpochStart", 0) >= 1
        and first_final is not None
        and decode_errors == 0
    )
    print("PROBE PASS" if ok else "PROBE FAIL")
    return 0 if ok else 1


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8721)
    ap.add_argument("--market", default="sim")
    ap.add_argument("--symbol", default="SIM-DEMO")
    ap.add_argument("--duration", type=float, default=10.0)
    args = ap.parse_args()
    rc = asyncio.run(probe(args.host, args.port, args.market, args.symbol, args.duration))
    sys.exit(rc)


if __name__ == "__main__":
    main()
