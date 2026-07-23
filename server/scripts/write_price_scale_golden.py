"""Emit the price-scale golden vectors the CLIENT test asserts against.

The server bins liquidity into rows and the client labels those same rows back
into prices, so the two implementations of the scale must agree numerically or
prices are quietly wrong. This writes the server's answers to a JSON fixture
that client/src/gl/priceScale.test.ts loads — the same golden-vector convention
the wire protocol already uses (server/tests/proto/golden/*.bin).

Regenerate with:  uv run python scripts/write_price_scale_golden.py
"""

from __future__ import annotations

import json
from pathlib import Path

from flowmap_server.core.price_scale import (
    linear_scale,
    make_hybrid,
    price_to_row,
    row_to_price,
    step_at_row,
)

OUT = Path(__file__).resolve().parents[2] / "client" / "src" / "gl" / "priceScale.golden.json"

CASES = [
    # (name, scale, rows to sample, prices to sample)
    (
        "btc_hybrid",
        make_hybrid(mid=60_000.0, rows=4096, core_rows=2048, core_step=0.5,
                    up_mult=11.0, dn_floor=0.01),
        [0, 1, 137, 512, 1000, 1348, 1349, 2372, 3396, 3397, 3800, 4095, 4096, -50, 4200],
        [700.0, 6_000.0, 45_000.0, 59_900.0, 60_000.0, 60_400.0, 120_000.0, 400_000.0,
         650_000.0, 0.6],
    ),
    (
        "alt_hybrid",
        make_hybrid(mid=0.5, rows=4096, core_rows=2048, core_step=1e-5,
                    up_mult=11.0, dn_floor=0.01),
        [0, 500, 1500, 2048, 3000, 4096],
        [0.006, 0.05, 0.4999, 0.5, 0.51, 2.0, 5.4],
    ),
    (
        "legacy_linear",
        linear_scale(p0=-412.0, step=0.5, rows=2048),
        [0, 1, 1024, 2047, 2048, -10],
        [100.0, 0.0, -400.0, 600.0],
    ),
]


def main() -> None:
    out: dict[str, object] = {}
    for name, s, rows, prices in CASES:
        assert s is not None, name
        out[name] = {
            "scale": {
                "kind": s.kind,
                "rows": s.rows,
                "p0": s.p0,
                "step": s.step,
                "dnRows": s.dn_rows,
                "coreRows": s.core_rows,
                "coreP0": s.core_p0,
                "coreStep": s.core_step,
                "loPrice": s.lo_price,
                "hiPrice": s.hi_price,
            },
            "rows": rows,
            "rowToPrice": [row_to_price(s, r) for r in rows],
            "stepAtRow": [step_at_row(s, r) for r in rows],
            "prices": prices,
            "priceToRow": [price_to_row(s, p) for p in prices],
        }
    OUT.write_text(json.dumps(out, indent=2) + "\n")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
