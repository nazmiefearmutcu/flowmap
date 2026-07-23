"""Price<->row scale (spec §8.1) — the map between a grid row and a price.

Until now this was a single LINEAR affine, ``price = p0 + row * step``, inlined
at every consumer. That is fine for a narrow grid, but it makes range and
resolution the SAME knob: over a fixed row count, covering -99%/+1000% of a $60k
mid forces ~$322 per row, at which the live book collapses into a couple of rows
and the chart stops being a trading view.

This module adds a second scale kind that breaks that tie:

    rows [0, dn_rows)                    lower LOG wing  -- lo_price -> core_lo
    rows [dn_rows, dn_rows+core_rows)    linear CORE     -- core_p0 + k*core_step
    rows [dn_rows+core_rows, rows)       upper LOG wing  -- core_hi -> hi_price

continuous at both joins. The point is that resolution is spent where it is
read: with ``rows=4096`` and ``core_rows=2048`` on BTC at $60k with a $0.50
tick, the CORE is +/-0.853% at $0.50/row -- byte-for-byte the resolution AND
coverage of the old narrow grid -- while the remaining 2048 rows reach
-99%/+1000% at ~0.34%/row. Nothing is lost near the money; the far field is
gained.

This is the exact mirror of ``client/src/gl/priceScale.ts``; the two must agree
bit-for-bit on every mapping, because the server bins liquidity into rows and
the client labels those same rows back into prices. Pure functions only -- no
numpy, no session state -- so both halves are unit-testable in isolation.
"""

from __future__ import annotations

import math

import msgspec

# Scale-kind discriminators, carried on the wire in EpochParams.
SCALE_LINEAR = 0
SCALE_HYBRID = 1


class PriceScale(msgspec.Struct, frozen=True):
    """A row<->price map.

    ``kind == SCALE_LINEAR`` uses only ``p0`` / ``step`` and is the legacy
    affine VERBATIM, so a grid that never opts in is bit-identical to before.
    The hybrid fields are ignored (and default to zero) in that case.
    """

    kind: int
    rows: int
    # linear
    p0: float = 0.0
    step: float = 0.0
    # hybrid
    dn_rows: int = 0
    core_rows: int = 0
    core_p0: float = 0.0
    core_step: float = 0.0
    lo_price: float = 0.0
    hi_price: float = 0.0

    @property
    def core_hi(self) -> float:
        """Price at row ``dn_rows + core_rows`` (top of the linear core)."""
        return self.core_p0 + self.core_rows * self.core_step

    @property
    def up_rows(self) -> int:
        """Rows in the upper log wing; may be 0."""
        return max(0, self.rows - self.dn_rows - self.core_rows)

    @property
    def usable(self) -> bool:
        """Whether this scale produces a finite, strictly-increasing map.

        A malformed hybrid (non-positive ``lo_price``, an inverted wing, a zero
        core) would yield NaN or a non-monotone map, which would silently
        scatter liquidity across the grid -- so callers fall back to the linear
        branch rather than trust it.
        """
        if self.kind == SCALE_LINEAR:
            return math.isfinite(self.step) and self.step > 0.0 and self.rows > 0
        return (
            self.rows > 0
            and math.isfinite(self.lo_price)
            and self.lo_price > 0.0
            and math.isfinite(self.core_p0)
            and math.isfinite(self.core_step)
            and self.core_step > 0.0
            and self.core_rows >= 1
            and self.dn_rows >= 0
            and self.rows >= self.dn_rows + self.core_rows
            and self.core_p0 > self.lo_price
            and (
                self.up_rows == 0
                or (math.isfinite(self.hi_price) and self.hi_price > self.core_hi)
            )
        )


def linear_scale(p0: float, step: float, rows: int) -> PriceScale:
    """The legacy affine."""
    return PriceScale(kind=SCALE_LINEAR, rows=rows, p0=p0, step=step)


def row_to_price(s: PriceScale, row: float) -> float:
    """Price at a (fractional) row.

    Total and monotonically increasing across the whole domain INCLUDING outside
    ``[0, rows]``: the client camera can overscroll a full viewport past either
    edge and must keep labelling the axis sanely there, so both wings
    extrapolate geometrically rather than clamping.
    """
    if s.kind == SCALE_LINEAR:
        return s.p0 + row * s.step
    if not s.usable:
        return math.nan

    core_lo = s.core_p0
    core_hi = s.core_hi
    core_end = s.dn_rows + s.core_rows

    if s.dn_rows <= row <= core_end:
        return core_lo + (row - s.dn_rows) * s.core_step
    if row < s.dn_rows:
        if s.dn_rows <= 0:
            return core_lo * math.exp((row - s.dn_rows) * (s.core_step / core_lo))
        return core_lo * math.exp(
            ((row - s.dn_rows) / s.dn_rows) * math.log(core_lo / s.lo_price)
        )
    up = s.up_rows
    if up <= 0:
        return core_hi * math.exp((row - core_end) * (s.core_step / core_hi))
    return core_hi * math.exp(((row - core_end) / up) * math.log(s.hi_price / core_hi))


def price_to_row(s: PriceScale, price: float) -> float:
    """Row carrying ``price`` -- the exact inverse of :func:`row_to_price`.

    Returns NaN for a non-positive price on a hybrid scale (log space has no
    zero). Callers MUST treat NaN as "off the grid" rather than coercing it to
    row 0, which would pile far-out liquidity onto the bottom row.
    """
    if s.kind == SCALE_LINEAR:
        return math.nan if s.step == 0.0 else (price - s.p0) / s.step
    if not s.usable or not price > 0.0:
        return math.nan

    core_lo = s.core_p0
    core_hi = s.core_hi
    core_end = s.dn_rows + s.core_rows

    if core_lo <= price <= core_hi:
        return s.dn_rows + (price - core_lo) / s.core_step
    if price < core_lo:
        if s.dn_rows <= 0:
            return s.dn_rows + (core_lo / s.core_step) * math.log(price / core_lo)
        return s.dn_rows * (
            1.0 + math.log(price / core_lo) / math.log(core_lo / s.lo_price)
        )
    up = s.up_rows
    if up <= 0:
        return core_end + (core_hi / s.core_step) * math.log(price / core_hi)
    return core_end + up * (math.log(price / core_hi) / math.log(s.hi_price / core_hi))


def step_at_row(s: PriceScale, row: float) -> float:
    """LOCAL price height of one row at ``row`` -- what a "tick" is worth there.

    Constant on a linear scale; grows geometrically through the wings on a
    hybrid one. Consumers that used to reach for ``step`` to size a DOM rung, a
    profile bin or a tick label must use this instead, because under a hybrid
    scale those quantities are genuinely position dependent.
    """
    if s.kind == SCALE_LINEAR:
        return s.step
    if not s.usable:
        return math.nan
    return row_to_price(s, row + 0.5) - row_to_price(s, row - 0.5)


def make_hybrid(
    mid: float,
    rows: int,
    core_rows: int,
    core_step: float,
    up_mult: float,
    dn_floor: float,
) -> PriceScale | None:
    """Build a hybrid scale centred on ``mid``.

    The core is placed symmetrically around ``mid`` at the instrument's native
    step, and the leftover rows are split between the wings IN PROPORTION TO
    THEIR LOG SPAN, so both wings get the same percentage height per row -- a 1%
    move is the same distance above and below.

    Returns ``None`` for a degenerate request (non-finite mid, no rows left for
    the wings, a band narrower than the core), so the caller falls back to the
    linear grid rather than shipping a broken map. Never raises: it is reached
    from feed data.
    """
    if not math.isfinite(mid) or mid <= 0.0:
        return None
    if not math.isfinite(core_step) or core_step <= 0.0:
        return None
    if rows <= core_rows or core_rows < 1:
        return None
    if not up_mult > 1.0 or not 0.0 < dn_floor < 1.0:
        return None

    core_span = core_rows * core_step
    core_p0 = mid - core_span / 2.0
    core_hi = core_p0 + core_span
    lo_price = mid * dn_floor
    hi_price = mid * up_mult
    # The wings must actually BE wings: a band narrower than the core means the
    # caller should just use the linear grid.
    if lo_price <= 0.0 or lo_price >= core_p0 or hi_price <= core_hi:
        return None

    log_dn = math.log(core_p0 / lo_price)
    log_up = math.log(hi_price / core_hi)
    if log_dn <= 0.0 or log_up <= 0.0:
        return None

    wing = rows - core_rows
    dn_rows = round(wing * log_dn / (log_dn + log_up))
    dn_rows = min(wing - 1, max(1, dn_rows))

    scale = PriceScale(
        kind=SCALE_HYBRID,
        rows=rows,
        dn_rows=dn_rows,
        core_rows=core_rows,
        core_p0=core_p0,
        core_step=core_step,
        lo_price=lo_price,
        hi_price=hi_price,
    )
    return scale if scale.usable else None


def scale_of(ep) -> PriceScale:
    """The :class:`PriceScale` an ``EpochParams`` denotes.

    The single place the "missing / unknown fields means today's behaviour" rule
    lives. An epoch whose ``scale_kind`` is 0, absent, or a kind this build does
    not know falls back to the linear affine — which is what lets a hybrid
    server talk to an older client without it silently mis-reading a piecewise
    grid as a uniform one. An unusable hybrid falls back the same way.
    """
    kind = getattr(ep, "scale_kind", 0)
    linear = linear_scale(ep.p0, ep.tick * ep.tick_multiple, ep.rows)
    if kind != SCALE_HYBRID:
        return linear
    s = PriceScale(
        kind=SCALE_HYBRID,
        rows=ep.rows,
        dn_rows=ep.dn_rows,
        core_rows=ep.core_rows,
        core_p0=ep.core_p0,
        core_step=ep.core_step,
        lo_price=ep.lo_price,
        hi_price=ep.hi_price,
    )
    return s if s.usable else linear


def epoch_scale_fields(s: PriceScale) -> dict:
    """The seven wire fields for a scale, ready to splat into ``EpochParams``.

    A linear scale yields every field at its default, so ``omit_defaults``
    drops them all and the encoded bytes are unchanged.
    """
    if s.kind != SCALE_HYBRID:
        return {}
    return {
        "scale_kind": SCALE_HYBRID,
        "dn_rows": s.dn_rows,
        "core_rows": s.core_rows,
        "core_p0": s.core_p0,
        "core_step": s.core_step,
        "lo_price": s.lo_price,
        "hi_price": s.hi_price,
    }
