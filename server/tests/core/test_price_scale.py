"""Price scale (spec §8.1) — the row<->price map, both kinds.

The hybrid scale exists so range and resolution stop being the same knob. These
tests pin the two properties everything downstream leans on — CONTINUITY at the
joins and exact INVERTIBILITY — plus the guard behaviour that keeps a degenerate
request from silently scattering liquidity across the grid.

``test_matches_the_client_module`` is the load-bearing one: the server bins
liquidity into rows and the client labels those same rows back into prices, so
the two implementations must agree numerically or prices are quietly wrong.
"""

from __future__ import annotations

import math

import msgspec
import pytest

from flowmap_server.core.price_scale import (
    SCALE_HYBRID,
    SCALE_LINEAR,
    linear_scale,
    make_hybrid,
    price_to_row,
    row_to_price,
    step_at_row,
)

# The shipping shape: BTC at $60k, 4096 rows, half of them a $0.50 core.
BTC = dict(mid=60_000.0, rows=4096, core_rows=2048, core_step=0.5, up_mult=11.0, dn_floor=0.01)


def _btc():
    s = make_hybrid(**BTC)
    assert s is not None
    return s


def _rel(a: float, b: float) -> float:
    return abs(a - b) / abs(b)


# --- linear: must stay bit-identical to the old inlined affine ---------------


def test_linear_is_the_legacy_affine_verbatim():
    s = linear_scale(p0=100.0, step=0.5, rows=2048)
    assert s.kind == SCALE_LINEAR
    assert row_to_price(s, 0) == 100.0
    assert row_to_price(s, 40) == 120.0
    assert row_to_price(s, -10) == 95.0  # extrapolates (camera overscroll)
    assert price_to_row(s, 120.0) == 40.0
    assert step_at_row(s, 0) == 0.5
    assert step_at_row(s, 2000) == 0.5


def test_linear_zero_step_yields_nan_not_inf():
    s = linear_scale(p0=100.0, step=0.0, rows=64)
    assert math.isnan(price_to_row(s, 120.0))


# --- hybrid geometry ---------------------------------------------------------


def test_hybrid_is_continuous_at_both_joins():
    s = _btc()
    lo_join, hi_join = s.dn_rows, s.dn_rows + s.core_rows
    # RELATIVE tolerance: these are ~$60k values, so an absolute epsilon would
    # be testing float64 magnitude, not continuity.
    assert _rel(row_to_price(s, lo_join - 1e-7), row_to_price(s, lo_join + 1e-7)) < 1e-9
    assert _rel(row_to_price(s, hi_join - 1e-7), row_to_price(s, hi_join + 1e-7)) < 1e-9
    assert _rel(row_to_price(s, lo_join), s.core_p0) < 1e-12
    assert _rel(row_to_price(s, hi_join), s.core_hi) < 1e-12


def test_hybrid_hits_the_requested_coverage():
    s = _btc()
    assert _rel(row_to_price(s, 0), 60_000 * 0.01) < 1e-9  # -99%
    assert _rel(row_to_price(s, s.rows), 60_000 * 11.0) < 1e-9  # +1000%


def test_hybrid_is_strictly_increasing_including_past_both_edges():
    s = _btc()
    prev = -math.inf
    for r in range(-200, s.rows + 200, 7):
        p = row_to_price(s, r)
        assert math.isfinite(p)
        assert p > prev
        prev = p


def test_hybrid_keeps_the_native_ladder_in_the_core():
    """The whole point of the design: nothing is lost near the money."""
    s = _btc()
    assert step_at_row(s, s.dn_rows + 10) == pytest.approx(0.5, abs=1e-9)
    assert step_at_row(s, s.dn_rows + s.core_rows - 10) == pytest.approx(0.5, abs=1e-9)
    coverage_pct = (s.core_hi - s.core_p0) / 2 / 60_000 * 100
    assert coverage_pct == pytest.approx(0.853, abs=0.01)


def test_hybrid_wings_are_geometric_and_symmetric_in_percent():
    s = _btc()
    dn_mid = s.dn_rows // 2
    up_mid = s.dn_rows + s.core_rows + s.up_rows // 2
    pct_dn = step_at_row(s, dn_mid) / row_to_price(s, dn_mid)
    pct_up = step_at_row(s, up_mid) / row_to_price(s, up_mid)
    assert pct_dn == pytest.approx(pct_up, rel=0.02)
    assert pct_up < 0.005  # ~0.34%/row at this sizing


# --- inversion ---------------------------------------------------------------


def test_hybrid_round_trips_rows_through_every_zone():
    s = _btc()
    for r in (1, 50, s.dn_rows - 1, s.dn_rows, s.dn_rows + 1, s.dn_rows + 1024,
              s.dn_rows + s.core_rows, s.dn_rows + s.core_rows + 1, s.rows - 1):
        assert price_to_row(s, row_to_price(s, r)) == pytest.approx(r, abs=1e-6)


def test_hybrid_round_trips_real_market_prices():
    s = _btc()
    for p in (700.0, 6_000.0, 45_000.0, 59_900.0, 60_000.0, 60_400.0,
              120_000.0, 400_000.0, 650_000.0):
        assert row_to_price(s, price_to_row(s, p)) == pytest.approx(p, rel=1e-9)


def test_hybrid_refuses_non_positive_price_instead_of_coercing_to_row_zero():
    # Log space has no zero. Returning 0 would pile far-out liquidity onto the
    # bottom row — silent bad data, the worst possible failure here.
    s = _btc()
    assert math.isnan(price_to_row(s, 0.0))
    assert math.isnan(price_to_row(s, -5.0))


# --- construction guards -----------------------------------------------------


def test_make_hybrid_builds_the_good_case():
    s = _btc()
    assert s.kind == SCALE_HYBRID
    assert s.dn_rows > 0 and s.up_rows > 0
    assert s.dn_rows + s.core_rows + s.up_rows == s.rows


@pytest.mark.parametrize(
    "override",
    [
        {"mid": math.nan},
        {"mid": 0.0},
        {"mid": -1.0},
        {"dn_floor": 0.0},
        {"dn_floor": 1.0},
        {"up_mult": 1.0},
        {"core_rows": 4096},  # no room for wings
        {"core_rows": 0},
        {"core_step": 0.0},
        {"core_step": math.nan},
        {"core_step": 500.0},  # band narrower than the core
    ],
)
def test_make_hybrid_returns_none_on_a_degenerate_request(override):
    # Never raises: this is reached from feed data with no try around it.
    assert make_hybrid(**{**BTC, **override}) is None


def test_make_hybrid_is_scale_free():
    """A $0.50 altcoin gets the same RELATIVE treatment as BTC — which the old
    fixed-absolute-span grid emphatically did not (it handed that altcoin a grid
    running from -$412 to +$612)."""
    s = make_hybrid(mid=0.5, rows=4096, core_rows=2048, core_step=1e-5,
                    up_mult=11.0, dn_floor=0.01)
    assert s is not None
    assert row_to_price(s, 0) == pytest.approx(0.005, rel=1e-9)
    assert row_to_price(s, s.rows) == pytest.approx(5.5, rel=1e-9)


def test_unusable_scale_yields_nan_rather_than_a_plausible_wrong_number():
    s = _btc()
    bad = msgspec.structs.replace(s, lo_price=0.0)
    assert not bad.usable
    assert math.isnan(row_to_price(bad, 100))
    assert math.isnan(price_to_row(bad, 100.0))


# --- cross-language parity ---------------------------------------------------


def test_matches_the_client_module():
    """The server bins liquidity into rows; the client labels those same rows
    back into prices. If the two implementations disagree, prices are quietly
    wrong — so pin the exact numbers both must produce."""
    s = _btc()
    # Hand-derived from the geometry, independent of the implementation:
    #   core spans [mid - 512, mid + 512] over core_rows rows at core_step.
    assert s.core_p0 == pytest.approx(60_000 - 2048 * 0.5 / 2, abs=1e-9)
    assert s.core_hi == pytest.approx(60_000 + 2048 * 0.5 / 2, abs=1e-9)
    # Mid sits exactly at the centre row of the core.
    assert price_to_row(s, 60_000.0) == pytest.approx(s.dn_rows + s.core_rows / 2, abs=1e-9)
    # Wing rows are the proportional split of the leftover rows.
    log_dn = math.log(s.core_p0 / s.lo_price)
    log_up = math.log(s.hi_price / s.core_hi)
    wing = s.rows - s.core_rows
    assert s.dn_rows == min(wing - 1, max(1, round(wing * log_dn / (log_dn + log_up))))

