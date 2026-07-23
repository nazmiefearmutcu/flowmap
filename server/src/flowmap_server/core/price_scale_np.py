"""Vectorized price->row binning for the ingest path.

Deliberately SEPARATE from ``price_scale.py``, whose contract is "pure Python,
no numpy, mirrors the TypeScript bit-for-bit". This module is the one place the
scalar map is re-expressed over arrays, which makes it the single most dangerous
seam in the whole price-scale change: a divergence here does not merely display
wrong, it writes permanently wrong rows into the recorded ring. Hence
``test_price_scale_np.py`` asserts elementwise agreement with the scalar
``price_to_row`` across a dense sweep spanning both joins and both wings.
"""

from __future__ import annotations

import numpy as np

from flowmap_server.core.price_scale import SCALE_HYBRID, PriceScale


def rows_for_prices(scale: PriceScale, px: np.ndarray) -> np.ndarray:
    """Fractional rows for an array of prices — the vector form of
    :func:`price_scale.price_to_row`.

    Non-positive prices yield NaN on a hybrid scale (log space has no zero), so
    the caller's finite-mask drops them instead of binning them onto row 0.
    """
    px64 = np.asarray(px, dtype=np.float64)
    if scale.kind != SCALE_HYBRID:
        if scale.step == 0.0:
            return np.full(px64.shape, np.nan)
        return (px64 - scale.p0) / scale.step
    if not scale.usable:
        return np.full(px64.shape, np.nan)

    core_lo = scale.core_p0
    core_hi = scale.core_hi
    core_end = scale.dn_rows + scale.core_rows
    up = scale.up_rows

    out = np.full(px64.shape, np.nan, dtype=np.float64)
    pos = px64 > 0.0

    core = pos & (px64 >= core_lo) & (px64 <= core_hi)
    out[core] = scale.dn_rows + (px64[core] - core_lo) / scale.core_step

    low = pos & (px64 < core_lo)
    if np.any(low):
        if scale.dn_rows <= 0:
            out[low] = scale.dn_rows + (core_lo / scale.core_step) * np.log(
                px64[low] / core_lo
            )
        else:
            out[low] = scale.dn_rows * (
                1.0 + np.log(px64[low] / core_lo) / np.log(core_lo / scale.lo_price)
            )

    high = pos & (px64 > core_hi)
    if np.any(high):
        if up <= 0:
            out[high] = core_end + (core_hi / scale.core_step) * np.log(
                px64[high] / core_hi
            )
        else:
            out[high] = core_end + up * (
                np.log(px64[high] / core_hi) / np.log(scale.hi_price / core_hi)
            )
    return out
