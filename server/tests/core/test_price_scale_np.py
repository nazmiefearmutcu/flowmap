"""The scalar<->vector seam.

``rows_for_prices`` re-expresses ``price_to_row`` over numpy arrays for the
ingest binner. A divergence between the two does not merely display wrong — it
writes permanently wrong rows into the recorded ring — so it is asserted
elementwise over a dense sweep, not spot-checked.
"""

from __future__ import annotations

import math

import numpy as np
import pytest

from flowmap_server.core.price_scale import linear_scale, make_hybrid, price_to_row
from flowmap_server.core.price_scale_np import rows_for_prices


def _btc():
    s = make_hybrid(mid=60_000.0, rows=4096, core_rows=2048, core_step=0.5,
                    up_mult=11.0, dn_floor=0.01)
    assert s is not None
    return s


def _sweep(s):
    """Prices spanning both wings, both joins, and the core."""
    core_lo, core_hi = s.core_p0, s.core_hi
    return np.concatenate([
        np.geomspace(s.lo_price, core_lo, 400),        # lower wing
        np.linspace(core_lo, core_hi, 400),            # core
        np.geomspace(core_hi, s.hi_price, 400),        # upper wing
        np.array([core_lo, core_hi,                    # exact joins
                  np.nextafter(core_lo, 0), np.nextafter(core_lo, math.inf),
                  np.nextafter(core_hi, 0), np.nextafter(core_hi, math.inf)]),
    ])


def test_vector_agrees_with_scalar_elementwise_on_a_hybrid():
    s = _btc()
    px = _sweep(s)
    vec = rows_for_prices(s, px)
    sca = np.array([price_to_row(s, float(p)) for p in px])
    assert np.all(np.isfinite(vec))
    # Relative, because these rows run to ~4096 and the prices to ~660k.
    assert np.max(np.abs(vec - sca) / np.maximum(np.abs(sca), 1e-9)) < 1e-12


def test_vector_agrees_with_scalar_on_a_linear_scale():
    s = linear_scale(p0=-412.0, step=0.5, rows=2048)
    px = np.linspace(-500.0, 700.0, 1000)
    vec = rows_for_prices(s, px)
    sca = np.array([price_to_row(s, float(p)) for p in px])
    assert np.array_equal(vec, sca)  # exact: same arithmetic, no logs


def test_non_positive_prices_become_nan_not_row_zero():
    """The failure that would silently pile far-out liquidity onto the bottom
    row. The ingest binner's finite-mask must be able to drop these."""
    s = _btc()
    out = rows_for_prices(s, np.array([-5.0, 0.0, 1e-9, 60_000.0]))
    assert math.isnan(out[0])
    assert math.isnan(out[1])
    assert np.isfinite(out[2])  # tiny but positive: extrapolates, still finite
    assert np.isfinite(out[3])


def test_unusable_scale_yields_all_nan():
    import msgspec

    s = msgspec.structs.replace(_btc(), lo_price=0.0)
    out = rows_for_prices(s, np.array([100.0, 60_000.0]))
    assert np.all(np.isnan(out))


def test_degenerate_linear_step_yields_nan():
    s = linear_scale(p0=0.0, step=0.0, rows=64)
    assert np.all(np.isnan(rows_for_prices(s, np.array([1.0, 2.0]))))


def test_empty_input_is_handled():
    assert rows_for_prices(_btc(), np.array([])).shape == (0,)


@pytest.mark.parametrize("mid", [0.5, 3.25, 60_000.0, 1_250_000.0])
def test_agreement_holds_across_instrument_scales(mid):
    s = make_hybrid(mid=mid, rows=4096, core_rows=2048, core_step=mid / 120_000.0,
                    up_mult=11.0, dn_floor=0.01)
    assert s is not None
    px = _sweep(s)
    vec = rows_for_prices(s, px)
    sca = np.array([price_to_row(s, float(p)) for p in px])
    assert np.max(np.abs(vec - sca) / np.maximum(np.abs(sca), 1e-9)) < 1e-12
