"""M0 kill-test: pool-level markout LVR vs LP fees on Robinhood Chain stock pools.

For every swap:  fee_usd            = LP fee paid by the taker
                 picked_usd(h)      = s·q·(P_ref(t+h) − p_ex) · quote_usd   (what the taker gained vs the ex-fee price)
                 lp_net_usd(h)      = fee_usd − picked_usd(h)
P_ref is the pool's OWN mid h seconds later (self-markout); the HL-referenced markout is added once the tape/candles
are joined (M1). Summing over swaps gives the LPs' aggregate edge: fees / picked.

    uv run python -m markout.study
"""

from __future__ import annotations

from datetime import date
from pathlib import Path

import polars as pl

from markout.pools import DATA, POOLS, decode_swaps, scan_raw

OUT = DATA / "study" / "m0"
HORIZONS = {"1m": 60, "5m": 300, "1h": 3600}
HOLIDAYS = {date(2026, 7, 3), date(2026, 9, 7)}  # NYSE closed (Independence Day observed, Labor Day)


def regime_expr() -> pl.Expr:
    et = pl.from_epoch(pl.col("ts").cast(pl.Int64), time_unit="s").dt.replace_time_zone("UTC").dt.convert_time_zone("America/New_York")
    dow = et.dt.weekday()  # 1=Mon … 7=Sun
    mins = et.dt.hour().cast(pl.Int32) * 60 + et.dt.minute().cast(pl.Int32)
    holiday = et.dt.date().is_in(list(HOLIDAYS))
    weekend_dark = ((dow == 5) & (mins >= 20 * 60)) | (dow == 6) | ((dow == 7) & (mins < 20 * 60))
    regular = (dow <= 5) & (mins >= 9 * 60 + 30) & (mins < 16 * 60)
    extended = (dow <= 5) & (((mins >= 4 * 60) & (mins < 9 * 60 + 30)) | ((mins >= 16 * 60) & (mins < 20 * 60)))
    reopen = ((dow == 7) & (mins >= 19 * 60 + 50)) | ((dow == 1) & (mins < 20)) | ((dow <= 5) & (mins >= 9 * 60 + 20) & (mins < 9 * 60 + 45))
    return (
        pl.when(holiday).then(pl.lit("HOLIDAY"))
        .when(weekend_dark).then(pl.lit("WEEKEND_DARK"))
        .when(regular).then(pl.lit("REGULAR"))
        .when(extended).then(pl.lit("EXTENDED"))
        .otherwise(pl.lit("OVERNIGHT"))
        .alias("regime"),
        reopen.alias("reopen_window"),
        ((dow - 1) * 24 + et.dt.hour().cast(pl.Int32)).alias("how"),  # hour of week, Mon 00:00 ET = 0
        et.dt.date().alias("date_et"),
    )


def add_markouts(sw: pl.DataFrame) -> pl.DataFrame:
    mids = sw.select(pl.col("ts").alias("t_ref"), pl.col("mid_after").alias("p_ref")).sort("t_ref")
    t_end = mids["t_ref"].max()
    for name, h in HORIZONS.items():
        tgt = sw.select(pl.int_range(pl.len()).alias("row"), (pl.col("ts") + h).alias("t_ref")).sort("t_ref")
        ref = tgt.join_asof(mids, on="t_ref", strategy="backward").sort("row")
        sw = sw.with_columns(
            pl.Series(f"p_ref_{name}", ref["p_ref"]),
            pl.Series(f"valid_{name}", (ref["t_ref"] <= t_end)),
        )
        sw = sw.with_columns((pl.col("s") * pl.col("q") * (pl.col(f"p_ref_{name}") - pl.col("p_ex"))).alias(f"picked_q_{name}"))
    return sw


def to_usd(sw: pl.DataFrame, pool_key: str, spy_mid: pl.DataFrame | None) -> pl.DataFrame:
    if pool_key.endswith("/USDG"):
        return sw.with_columns(pl.lit(1.0).alias("quote_usd"))
    # QQQ/SPY: quote is SPY → value with the SPY/USDG pool mid at the same time.
    j = sw.sort("ts").join_asof(spy_mid.rename({"t_ref": "ts", "p_ref": "quote_usd"}), on="ts", strategy="backward")
    return j


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    raws: dict[str, pl.LazyFrame] = {}
    swaps = []
    spy_mid = None
    # SPY/USDG first so QQQ/SPY can be valued in USD.
    order = sorted(POOLS, key=lambda p: 0 if p.key == "SPY/USDG" else 1)
    for pool in order:
        if pool.source not in raws:
            raws[pool.source] = scan_raw(pool.source)
        sw = decode_swaps(pool, raws[pool.source]).sort(["block", "tx_index", "log_index"])
        if sw.is_empty():
            print(f"{pool.key}: no swaps")
            continue
        sw = add_markouts(sw)
        if pool.key == "SPY/USDG":
            spy_mid = sw.select(pl.col("ts").alias("t_ref"), pl.col("mid_after").alias("p_ref")).sort("t_ref")
        sw = to_usd(sw, pool.key, spy_mid)
        sw = sw.with_columns(
            (pl.col("quote_amt") * pl.col("quote_usd")).alias("vol_usd"),
            (pl.col("fee_q") * pl.col("quote_usd")).alias("fee_usd"),
            *[(pl.col(f"picked_q_{h}") * pl.col("quote_usd")).alias(f"picked_usd_{h}") for h in HORIZONS],
            *regime_expr(),
        )
        print(f"{pool.key}: {sw.height:,} swaps  {sw['ts'].min():.0f}..{sw['ts'].max():.0f}")
        swaps.append(sw)

    allsw = pl.concat(swaps, how="diagonal_relaxed")
    allsw.write_parquet(OUT / "swaps.parquet")

    def agg(by: list[str]) -> pl.DataFrame:
        exprs = [pl.len().alias("swaps"), pl.col("vol_usd").sum(), pl.col("fee_usd").sum()]
        for h in HORIZONS:
            v = pl.col(f"valid_{h}")
            exprs += [
                pl.col(f"picked_usd_{h}").filter(v).sum().alias(f"picked_{h}"),
                (pl.col("fee_usd").filter(v).sum() - pl.col(f"picked_usd_{h}").filter(v).sum()).alias(f"lp_net_{h}"),
            ]
        return (
            allsw.group_by(by).agg(exprs)
            .with_columns(*[(pl.col("fee_usd") / pl.col(f"picked_{h}")).alias(f"edge_{h}") for h in HORIZONS])
            .with_columns(*[(pl.col(f"lp_net_{h}") / pl.col("vol_usd") * 1e4).alias(f"lp_net_bps_{h}") for h in HORIZONS])
            .sort(by)
        )

    by_regime = agg(["pool", "regime"])
    by_pool = agg(["pool"])
    by_reopen = agg(["pool", "reopen_window"])
    by_how = agg(["pool", "how"])
    by_day = agg(["pool", "date_et"])
    by_sender = agg(["pool", "sender"]).sort(["pool", "picked_5m"], descending=[False, True])
    for name, df in [("by_regime", by_regime), ("by_pool", by_pool), ("by_reopen", by_reopen), ("by_how", by_how), ("by_day", by_day), ("by_sender", by_sender)]:
        df.write_parquet(OUT / f"{name}.parquet")

    pl.Config.set_tbl_rows(60)
    pl.Config.set_tbl_cols(20)
    pl.Config.set_fmt_str_lengths(20)
    show = ["swaps", "vol_usd", "fee_usd", "picked_5m", "edge_1m", "edge_5m", "edge_1h", "lp_net_bps_5m", "lp_net_bps_1h"]
    print("\n=== by pool ===");   print(by_pool.select(["pool", *show]))
    print("\n=== by pool × regime ===");  print(by_regime.select(["pool", "regime", *show]))
    print("\n=== reopen windows (Sun 19:50–Mon 00:20, weekday 09:20–09:45 ET) ===");  print(by_reopen.select(["pool", "reopen_window", *show]))
    print("\n=== top takers by 5m picked-off (per pool) ===")
    print(by_sender.group_by("pool").head(5).select(["pool", "sender", "swaps", "vol_usd", "fee_usd", "picked_5m", "edge_5m"]))


if __name__ == "__main__":
    main()
