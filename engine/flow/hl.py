"""HL lead signal: did the taker trade in the direction HL had just moved?

For every swap at time t and interval iv in {1m, 5m, 15m}, take the LAST COMPLETED Hyperliquid (trade.xyz) candle,
i.e. the bar whose end (t_open + iv) is <= t and > t - iv, and its close-to-close return r. No look-ahead: the bar
closed before the swap's block. hl_sign_<iv> = sign(r) (0 = flat bar, no signal; null = no candle coverage).
A swap "agrees" with HL when s == hl_sign. Random flow agrees ~50% of the time; flow that arbitrages the pool
toward HL agrees more.

Coverage (HL keeps ~5,000 candles per interval): 1m from Sep 15, 5m from Sep 1, 15m from Jul 28 (2026).
Pool -> HL market: NVDA->xyz:NVDA, SPY->xyz:SP500, TSLA->xyz:TSLA, QQQ/SPY-> xyz:XYZ100 / xyz:SP500 (ratio).
"""

from __future__ import annotations

import polars as pl

from flow.io import load_candles

HL_MARKETS: dict[str, tuple[str, str | None]] = {
    "NVDA/USDG": ("NVDA", None),
    "SPY/USDG": ("SP500", None),
    "TSLA/USDG": ("TSLA", None),
    "QQQ/SPY": ("XYZ100", "SP500"),
}
INTERVALS: dict[str, int] = {"1m": 60, "5m": 300, "15m": 900}


def bar_closes(candles: pl.DataFrame, secs: int) -> pl.DataFrame:
    """[t_end (unix s, float), c] one row per bar, deduplicated and sorted."""
    return (
        candles.unique("t_open_ms", keep="last")
        .sort("t_open_ms")
        .select((pl.col("t_open_ms") / 1000 + secs).alias("t_end"), pl.col("c").cast(pl.Float64))
    )


def bar_returns(closes: pl.DataFrame) -> pl.DataFrame:
    """[t_end, ret]: close-to-close return of each bar (the first bar has none)."""
    return closes.sort("t_end").with_columns((pl.col("c") / pl.col("c").shift(1) - 1).alias("ret")).drop_nulls("ret").select("t_end", "ret")


def sign_for_swaps(sw: pl.DataFrame, rets: pl.DataFrame, secs: int) -> pl.Series:
    """hl sign of the last completed bar for each swap row in `sw` (must have `ts`), preserving row order."""
    left = sw.select(pl.int_range(pl.len()).alias("_row"), pl.col("ts").cast(pl.Float64)).sort("ts")
    j = left.join_asof(rets.sort("t_end"), left_on="ts", right_on="t_end", strategy="backward", tolerance=float(secs))
    return j.sort("_row").select(pl.col("ret").sign().cast(pl.Int8))["ret"]


def market_closes(pool: str, iv: str, loader=load_candles) -> pl.DataFrame | None:
    """[t_end, c] for the pool's HL market (ratio for QQQ/SPY); None when candles are missing."""
    num_sym, den_sym = HL_MARKETS.get(pool, (None, None))
    if num_sym is None:
        return None
    secs = INTERVALS[iv]
    num = loader(num_sym, iv)
    den = loader(den_sym, iv) if den_sym else None
    if num is None or (den_sym and den is None):
        return None
    n = bar_closes(num, secs)
    if den is None:
        return n
    return n.join(bar_closes(den, secs), on="t_end", how="inner", suffix="_den").select("t_end", (pl.col("c") / pl.col("c_den")).alias("c"))


def last_close_for_swaps(g: pl.DataFrame, closes: pl.DataFrame, secs: int) -> pl.DataFrame:
    """[c, age_s] of the last completed bar (ended within `secs` before the swap), row order preserved."""
    left = g.select(pl.int_range(pl.len()).alias("_row"), pl.col("ts").cast(pl.Float64)).sort("ts")
    j = left.join_asof(closes.sort("t_end"), left_on="ts", right_on="t_end", strategy="backward", tolerance=float(secs))
    return j.sort("_row").select("c", (pl.col("ts") - pl.col("t_end")).alias("age_s"))


# HL gap ("toward HL"): did the swap move the pool toward HL's price? The pool is quoted per token, HL per share
# (and SPY vs the SP500 index), so HL is scaled by a TRAILING basis = median over the previous BASIS_HOURS hours
# (with data) of hourly medians of pool_mid_before / hl_close. gap = pool_mid_before / (hl_close * basis) - 1.
# gap > 0: pool rich vs HL -> an arbitrageur SELLS the base (s = -1). A swap counts only when |gap| >= GAP_MIN_BPS
# and the HL point is FRESH (age <= GAP_MAX_AGE_S): against a stale reference a fast arbitrageur, who trades on moves
# the stale point has not seen yet, looks like it trades AWAY from HL (measured: 0.37 "toward" for the top wallet
# with 15m references vs its 0.58 HL lead).
BASIS_HOURS = 24
GAP_MIN_BPS = 2.0
GAP_MAX_AGE_S = 90.0


def hl_gap_for_pool(g: pl.DataFrame, closes_by_iv: dict[str, pl.DataFrame]) -> pl.DataFrame:
    """g: [ts, mid_before] rows of ONE pool (any order). Returns row-aligned [hl_gap_bps (null = no ref), hl_gap_age_s].
    HL close from the finest interval that has a completed bar within one interval before the swap."""
    ref = pl.DataFrame({"hl_close": pl.Series([None] * g.height, dtype=pl.Float64), "hl_gap_age_s": pl.Series([None] * g.height, dtype=pl.Float64)})
    for iv in ("15m", "5m", "1m"):  # finest wins: overwrite coarser where the finer one exists
        if iv in closes_by_iv and closes_by_iv[iv] is not None:
            c = last_close_for_swaps(g, closes_by_iv[iv], INTERVALS[iv])
            has = c["c"].is_not_null()
            ref = ref.with_columns(
                pl.when(has).then(c["c"]).otherwise(pl.col("hl_close")).alias("hl_close"),
                pl.when(has).then(c["age_s"]).otherwise(pl.col("hl_gap_age_s")).alias("hl_gap_age_s"),
            )
    d = g.select(pl.int_range(pl.len()).alias("_row"), "ts", "mid_before").hstack(ref)
    d = d.with_columns((pl.col("ts") // 3600).cast(pl.Int64).alias("_hr"), (pl.col("mid_before") / pl.col("hl_close")).alias("_ratio"))
    hourly = (
        d.drop_nulls("_ratio").group_by("_hr").agg(pl.col("_ratio").median().alias("_hmed")).sort("_hr")
        .with_columns(pl.col("_hmed").rolling_median(BASIS_HOURS, min_samples=3).shift(1).alias("_basis"))
        .select("_hr", "_basis")
    )
    d = d.sort("_hr").join_asof(hourly.sort("_hr"), on="_hr", strategy="backward").sort("_row")
    return d.select(((pl.col("mid_before") / (pl.col("hl_close") * pl.col("_basis")) - 1) * 1e4).alias("hl_gap_bps"), "hl_gap_age_s")


def add_hl_signs(sw: pl.DataFrame, loader=load_candles) -> pl.DataFrame:
    """Add hl_sign_<iv> (Int8: -1/0/+1, null = no coverage) and, when `mid_before` is present, hl_gap_bps.
    sw needs pool, ts (and mid_before for the gap)."""
    parts = []
    want_gap = "mid_before" in sw.columns
    sw = sw.with_columns(pl.int_range(pl.len()).alias("_orig"))
    keep = ["pool", "ts", "_orig", *(["mid_before"] if want_gap else [])]
    for pool, g in sw.select(keep).group_by("pool", maintain_order=True):
        pool = pool[0]
        cols = {}
        closes = {iv: market_closes(pool, iv, loader) for iv in INTERVALS}
        for iv, secs in INTERVALS.items():
            name = f"hl_sign_{iv}"
            if closes[iv] is None:
                cols[name] = pl.Series(name, [None] * g.height, dtype=pl.Int8)
                continue
            cols[name] = sign_for_swaps(g, bar_returns(closes[iv]), secs).alias(name)
        part = g.select("_orig").with_columns(**cols)
        if want_gap:
            part = part.hstack(hl_gap_for_pool(g, closes))
        parts.append(part)
    signs = pl.concat(parts).sort("_orig")
    return sw.sort("_orig").hstack(signs.drop("_orig")).drop("_orig")
