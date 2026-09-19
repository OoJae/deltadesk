"""Swap -> taker joins and per-taker / per-taker x pool features.

Taker = tx.from of the swap's transaction (originating wallet). `sender` (swap msg.sender) is the router.
All USD sums use M0's conventions: fees over all swaps, picked over swaps whose markout horizon is valid,
edge = fees / picked (null when picked <= 0).
"""

from __future__ import annotations

import math

import polars as pl

from flow.hl import GAP_MAX_AGE_S, GAP_MIN_BPS
from flow.io import HORIZONS

HOW_BINS = 168  # hours in a week

# A router (swap msg.sender) is PUBLIC when many distinct wallets use it casually: it serves >= PUBLIC_MIN_TAKERS
# wallets and the median wallet sends <= PUBLIC_MAX_MED_SWAPS swaps through it. Everything else is PRIVATE
# (a bot's own contract, including contracts shared by a bot's fleet of EOAs, whose median wallet is heavy).
PUBLIC_MIN_TAKERS = 50
PUBLIC_MAX_MED_SWAPS = 20


def join_takers(sw: pl.DataFrame, txs: pl.DataFrame) -> pl.DataFrame:
    """Left-join tx.from/to/gas onto swaps by tx_hash. Adds `taker` (= tx.from) and `to`."""
    return sw.join(
        txs.select("tx_hash", pl.col("from").alias("taker"), "to", "gas_used", "gas_price_wei"), on="tx_hash", how="left"
    )


def add_mid_before(sw: pl.DataFrame) -> pl.DataFrame:
    """Pool mid just before each swap = the previous swap's mid_after in the same pool (chain order)."""
    return sw.sort(["pool", "block", "log_index"]).with_columns(pl.col("mid_after").shift(1).over("pool").alias("mid_before"))


def router_stats(sw: pl.DataFrame) -> pl.DataFrame:
    """Per router (sender): distinct takers, median swaps per taker, public flag."""
    per = sw.group_by("sender", "taker").agg(pl.len().alias("n"))
    return (
        per.group_by("sender")
        .agg(pl.len().alias("router_takers"), pl.col("n").sum().alias("router_swaps"), pl.col("n").median().alias("router_med_swaps_per_taker"))
        .with_columns(((pl.col("router_takers") >= PUBLIC_MIN_TAKERS) & (pl.col("router_med_swaps_per_taker") <= PUBLIC_MAX_MED_SWAPS)).alias("router_public"))
    )


def enrich_swaps(sw: pl.DataFrame) -> pl.DataFrame:
    """Per-swap context: swaps/pools in the same tx, gas-price percentile within its UTC hour, router class,
    whether the wallet called the router directly (tx.to == sender), HL agreement flags."""
    tx_stats = sw.group_by("tx_hash").agg(pl.len().alias("swaps_in_tx"), pl.col("pool").n_unique().alias("pools_in_tx"))
    txg = (
        sw.select("tx_hash", "ts", "gas_price_wei").unique("tx_hash")
        .with_columns((pl.col("ts") // 3600).alias("_hr"))
        .with_columns(
            pl.when(pl.len().over("_hr") > 1)
            .then((pl.col("gas_price_wei").rank("average").over("_hr") - 1) / (pl.len().over("_hr") - 1))
            .otherwise(0.5)
            .alias("gas_pct")
        )
        .select("tx_hash", "gas_pct")
    )
    rs = router_stats(sw).select("sender", "router_public", "router_takers")
    out = sw.join(tx_stats, on="tx_hash", how="left").join(txg, on="tx_hash", how="left").join(rs, on="sender", how="left")
    out = out.with_columns((pl.col("to") == pl.lit("0x") + pl.col("sender")).alias("direct_call"))
    for iv in ("1m", "5m", "15m"):
        c = f"hl_sign_{iv}"
        if c not in out.columns:
            out = out.with_columns(pl.lit(None, pl.Int8).alias(c))
    # finest candle available at the swap's time: 1m (Sep 15+) > 5m (Sep 1+) > 15m (Jul 28+)
    out = out.with_columns(pl.coalesce("hl_sign_1m", "hl_sign_5m", "hl_sign_15m").alias("hl_sign_best"))
    for iv in ("1m", "5m", "15m", "best"):
        c = f"hl_sign_{iv}"
        out = out.with_columns(
            (pl.col(c).is_not_null() & (pl.col(c) != 0)).alias(f"hl_has_{iv}"),
            (pl.col(c) == pl.col("s")).fill_null(False).alias(f"hl_agree_{iv}"),
        )
    # "fair minus pool" gap in bps (> 0: HL fair above the pool -> buying moves the pool toward HL).
    # Source: hl_ref's gap when its file was joined (session basis k, markout/hl_ref.py), else flow.hl's
    # trailing-basis gap (pool rich = positive there, hence the sign flip). Never mixed per swap.
    # Only FRESH references count (age <= GAP_MAX_AGE_S, see flow.hl).
    if "hl_ref_gap_bps" in out.columns:
        fair_minus_pool, age = pl.col("hl_ref_gap_bps"), (pl.col("hl_ref_gap_age_s") if "hl_ref_gap_age_s" in out.columns else pl.lit(None, pl.Float64))
    elif "hl_gap_bps" in out.columns:
        fair_minus_pool, age = -pl.col("hl_gap_bps"), (pl.col("hl_gap_age_s") if "hl_gap_age_s" in out.columns else pl.lit(None, pl.Float64))
    else:
        fair_minus_pool, age = pl.lit(None, pl.Float64), pl.lit(None, pl.Float64)
    out = out.with_columns(fair_minus_pool.alias("hl_fair_gap_bps"), age.cast(pl.Float64).alias("hl_fair_gap_age_s"))
    gap = pl.col("hl_fair_gap_bps")
    usable = (gap.abs() >= GAP_MIN_BPS) & (pl.col("hl_fair_gap_age_s") <= GAP_MAX_AGE_S)
    out = out.with_columns(
        usable.fill_null(False).alias("hl_gap_has"),
        (usable & (pl.col("s") == gap.sign())).fill_null(False).alias("hl_toward"),
    )
    return out


def _entropy(by: list[str], sw: pl.DataFrame) -> pl.DataFrame:
    """Normalized Shannon entropy of the hour-of-week distribution (0 = one hour, 1 = uniform over 168)
    and the share of swaps in the single busiest hour-of-week."""
    h = sw.group_by([*by, "how"]).agg(pl.len().alias("n"))
    h = h.with_columns((pl.col("n") / pl.col("n").sum().over(by)).alias("p"))
    return h.group_by(by).agg(
        (-(pl.col("p") * pl.col("p").log()).sum() / math.log(HOW_BINS)).alias("how_entropy"),
        pl.col("p").max().alias("how_top_share"),
    )


def aggregate(sw: pl.DataFrame, by: list[str], picked_hl_cols: list[str] | None = None) -> pl.DataFrame:
    """Feature table grouped by `by` (e.g. ["taker"] or ["taker", "pool"])."""
    exprs: list[pl.Expr] = [
        pl.len().alias("swaps"),
        pl.col("tx_hash").n_unique().alias("n_tx"),
        pl.col("date_et").n_unique().alias("active_days"),
        pl.col("ts").min().alias("first_ts"),
        pl.col("ts").max().alias("last_ts"),
        pl.col("vol_usd").sum().alias("vol_usd"),
        pl.col("vol_usd").median().alias("size_med"),
        pl.col("vol_usd").quantile(0.9, "linear").alias("size_p90"),
        pl.col("fee_usd").sum().alias("fee_usd"),
        (pl.col("s") > 0).mean().alias("buy_share"),
    ]
    for h in HORIZONS:
        v = pl.col(f"valid_{h}")
        exprs.append(pl.col(f"picked_usd_{h}").filter(v).sum().alias(f"picked_{h}"))
    v5, v1h = pl.col("valid_5m"), pl.col("valid_1h")
    p1h = pl.col("picked_usd_1h").filter(v1h)
    exprs += [
        (pl.col("picked_usd_5m") > 0).filter(v5).mean().alias("pos5m_share"),
        v1h.sum().alias("n_valid_1h"),
        # t-stat of the per-swap 1h markout (overlapping horizons -> inflated for busy takers; used only as a
        # tolerance for "not informed", never as evidence FOR skill)
        (p1h.mean() / p1h.std() * p1h.count().sqrt()).alias("picked_1h_t"),
    ]
    for c in picked_hl_cols or []:  # picked_hl_<h> is null where hl_ref marked it invalid
        exprs += [pl.col(c).sum().alias(c), pl.col("fee_usd").filter(pl.col(c).is_not_null()).sum().alias(f"fee_on_{c}")]
    for iv in ("1m", "5m", "15m", "best"):
        exprs += [pl.col(f"hl_has_{iv}").sum().alias(f"hl_n_{iv}"), pl.col(f"hl_agree_{iv}").filter(pl.col(f"hl_has_{iv}")).sum().alias(f"hl_agree_{iv}")]
    exprs += [
        pl.col("hl_gap_has").sum().alias("hl_gap_n"),
        pl.col("hl_toward").sum().alias("hl_toward_k"),
        (pl.col("regime") == "REGULAR").mean().alias("share_regular"),
        (pl.col("regime") == "EXTENDED").mean().alias("share_extended"),
        (pl.col("regime") == "OVERNIGHT").mean().alias("share_overnight"),
        (pl.col("regime") == "WEEKEND_DARK").mean().alias("share_weekend"),
        pl.col("reopen_window").mean().alias("share_reopen"),
        pl.col("gas_pct").median().alias("gas_pct_med"),
        pl.col("gas_used").median().alias("gas_used_med"),
        pl.col("swaps_in_tx").mean().alias("swaps_per_tx"),
        (pl.col("swaps_in_tx") > 1).mean().alias("multi_swap_tx_share"),
        (pl.col("pools_in_tx") > 1).mean().alias("multi_pool_tx_share"),
        pl.col("router_public").mean().alias("public_router_share"),
        pl.col("direct_call").mean().alias("direct_call_share"),
        pl.col("sender").unique().sort().alias("routers"),
        pl.col("sender").n_unique().alias("n_routers"),
        pl.col("sender").mode().sort().first().alias("top_router"),
        pl.col("pool").unique().sort().alias("pools"),
    ]
    if "jit_own" in sw.columns:
        exprs.append(pl.col("jit_own").sum().alias("jit_own_swaps_pool"))
    g = sw.group_by(by).agg(exprs)
    top = sw.group_by([*by, "sender"]).agg(pl.len().alias("_n")).group_by(by).agg(pl.col("_n").max().alias("_top_n"))
    g = g.join(top, on=by, how="left").join(_entropy(by, sw), on=by, how="left")
    g = g.with_columns(
        (pl.col("_top_n") / pl.col("swaps")).alias("top_router_share"),
        (pl.col("swaps") / pl.col("active_days")).alias("swaps_per_day"),
        ((pl.col("last_ts") - pl.col("first_ts")) / 86400).alias("span_days"),
        pl.col("pools").list.len().alias("n_pools"),
        *[pl.when(pl.col(f"picked_{h}") > 0).then(pl.col("fee_usd") / pl.col(f"picked_{h}")).alias(f"edge_{h}") for h in HORIZONS],
        (pl.col("picked_1h") / pl.col("vol_usd") * 1e4).alias("picked_bps_1h"),
        (pl.col("fee_usd") / pl.col("vol_usd") * 1e4).alias("fee_bps"),
        *[(pl.col(f"hl_agree_{iv}") / pl.col(f"hl_n_{iv}")).alias(f"hl_lead_{iv}") for iv in ("1m", "5m", "15m", "best")],
        *[pl.when(pl.col(c) > 0).then(pl.col(f"fee_on_{c}") / pl.col(c)).alias(c.replace("picked_", "edge_")) for c in picked_hl_cols or []],
        (pl.col("hl_toward_k") / pl.col("hl_gap_n")).alias("hl_toward"),
        ((pl.col("hl_toward_k") - pl.col("hl_gap_n") / 2) / (pl.col("hl_gap_n") / 4).sqrt()).alias("hl_toward_z"),
    ).drop("_top_n")
    return g.with_columns(hl_lead_expr())


# HL lead used for labelling (`hl_lead`): the lead on the FINEST candle interval where the taker has >= HL_MIN_N
# signed swaps (1m, else 5m, else 15m). Calibration on Sep 1-18 swaps grouped by router: informed private routers
# score 0.62-0.74 on 1m, 0.51-0.66 on 5m, 0.46-0.60 on 15m, while public / uninformed routers sit at 0.50 +- 0.03
# on every interval. The signal dilutes with bar length, and pooling intervals lets the long 15m era swamp the 1m/5m
# evidence (router 520ed467: 1m 0.64, 5m 0.60, pooled 0.54), so the finest well-sampled interval is used on its own.
# `hl_lead_best` (pooled, finest bar per swap) is kept as a diagnostic column.
HL_MIN_N = 30


def hl_lead_expr() -> list[pl.Expr]:
    p1, p5, p15 = (pl.col(f"hl_n_{iv}") >= HL_MIN_N for iv in ("1m", "5m", "15m"))

    def pick(fmt: str) -> pl.Expr:
        return pl.when(p1).then(pl.col(fmt.format("1m"))).when(p5).then(pl.col(fmt.format("5m"))).when(p15).then(pl.col(fmt.format("15m")))

    n, k = pick("hl_n_{}").cast(pl.Float64), pick("hl_agree_{}").cast(pl.Float64)
    return [
        (k / n).alias("hl_lead"),
        ((k - n / 2) / (n / 4).sqrt()).alias("hl_lead_z"),
        n.alias("hl_lead_n"),
        pl.when(p1).then(pl.lit("1m")).when(p5).then(pl.lit("5m")).when(p15).then(pl.lit("15m")).alias("hl_lead_src"),
    ]
