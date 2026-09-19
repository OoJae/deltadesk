"""Liquidity events from lp_txs and JIT detection.

A position is keyed by (pool, tx.from, owner/sender, tickLower, tickUpper[, salt]):
  v3 NVDA/USDG  Mint / Burn (amount > 0; zero-amount Burns are fee pokes)  owner = topic1, ticks = topic2/topic3
  v4 pools      ModifyLiquidity (liquidityDelta != 0)                      sender = topic2, ticks/salt from data
Every add is paired with the NEXT event of the same key; if that is a remove, the pair is a liquidity window.

JIT (strict, as specified): a window whose add and remove are in the SAME block, add BEFORE remove, with >= 1 swap in
that pool strictly between them. A taker's swap is `jit_own` when it sits inside a strict JIT window opened by the
same tx.from. Remove -> swap -> add in one tx is an LP *rebalance*, not JIT (different keys, remove first).
Relaxed variant (diagnostic): add -> remove of the same key within SHORT_LIVED_S seconds with >= 1 swap between.
Ordering inside a block uses log_index (block-global in EVM).
"""

from __future__ import annotations

import duckdb
import polars as pl

from indexer.hs_backfill import NVDA_POOL, POOL_MANAGER, T_V3_BURN, T_V3_MINT, T_V4_MODIFY
from markout.pools import POOLS

SHORT_LIVED_S = 60
ORD = 1_000_000  # ord = block * ORD + log_index


def _word(i: int) -> pl.Expr:
    return pl.col("data").str.slice(2 + 64 * i, 64)


def decode_lp_events(logs: pl.DataFrame, txs: pl.DataFrame) -> pl.DataFrame:
    """[pool, block, tx_index, log_index, ts, tx_hash, from, kind(add|remove), key] for covered pools."""
    empty = pl.DataFrame(schema={"pool": pl.Utf8, "block": pl.Int64, "tx_index": pl.Int32, "log_index": pl.Int32, "ts": pl.Int64,
                                 "tx_hash": pl.Utf8, "from": pl.Utf8, "kind": pl.Utf8, "key": pl.Utf8})
    if logs.is_empty():
        return empty
    v4_ids = {p.pool_id: p.key for p in POOLS if p.venue == "v4"}
    zero = "^0+$"
    v3 = (
        logs.filter((pl.col("address") == NVDA_POOL) & pl.col("topic0").is_in([T_V3_MINT, T_V3_BURN]))
        .with_columns(
            pl.when(pl.col("topic0") == T_V3_MINT).then(_word(1)).otherwise(_word(0)).alias("amt"),
            pl.when(pl.col("topic0") == T_V3_MINT).then(pl.lit("add")).otherwise(pl.lit("remove")).alias("kind"),
            pl.lit(next(p.key for p in POOLS if p.venue == "v3")).alias("pool"),
        )
        .filter(~pl.col("amt").str.contains(zero))
        .with_columns(pl.concat_str([pl.col("topic1"), pl.col("topic2"), pl.col("topic3")], separator="|").alias("pkey"))
    )
    v4 = (
        logs.filter((pl.col("address") == POOL_MANAGER) & (pl.col("topic0") == T_V4_MODIFY) & pl.col("topic1").is_in(list(v4_ids)))
        .with_columns(_word(2).alias("delta"), pl.col("topic1").replace_strict(v4_ids).alias("pool"))
        .filter(~pl.col("delta").str.contains(zero))
        .with_columns(
            pl.when(pl.col("delta").str.slice(0, 1).is_in(["8", "9", "a", "b", "c", "d", "e", "f"])).then(pl.lit("remove")).otherwise(pl.lit("add")).alias("kind"),
            pl.concat_str([pl.col("topic2"), _word(0), _word(1), _word(3)], separator="|").alias("pkey"),
        )
    )
    cols = ["pool", "block", "tx_index", "log_index", "ts", "tx_hash", "kind", "pkey"]
    ev = pl.concat([v3.select(cols), v4.select(cols)]).join(txs.select("tx_hash", "from"), on="tx_hash", how="left")
    ev = ev.with_columns(pl.concat_str([pl.col("pool"), pl.col("from").fill_null("?"), pl.col("pkey")], separator="|").alias("key"))
    return ev.select(empty.columns).sort(["block", "log_index"])


def liquidity_windows(ev: pl.DataFrame, swaps: pl.DataFrame) -> pl.DataFrame:
    """Pair each add with the next event of the same key; keep add->remove pairs and count swaps inside.

    swaps: [pool, block, log_index, ts, taker].
    Returns [from, pool, key, block_add, block_rm, ord_add, ord_rm, lifetime_s, same_block, n_swaps, n_own_swaps].
    """
    if ev.is_empty():
        return pl.DataFrame(schema={"from": pl.Utf8, "pool": pl.Utf8, "key": pl.Utf8, "block_add": pl.Int64, "block_rm": pl.Int64,
                                    "ord_add": pl.Int64, "ord_rm": pl.Int64, "lifetime_s": pl.Float64, "same_block": pl.Boolean,
                                    "n_swaps": pl.Int64, "n_own_swaps": pl.Int64})
    e = ev.with_columns((pl.col("block") * ORD + pl.col("log_index")).alias("ord")).sort(["key", "ord"])
    e = e.with_columns(
        pl.col("kind").shift(-1).over("key").alias("next_kind"),
        pl.col("ord").shift(-1).over("key").alias("next_ord"),
        pl.col("block").shift(-1).over("key").alias("next_block"),
        pl.col("ts").shift(-1).over("key").alias("next_ts"),
    )
    w = e.filter((pl.col("kind") == "add") & (pl.col("next_kind") == "remove")).select(
        "from", "pool", "key",
        pl.col("block").alias("block_add"), pl.col("next_block").alias("block_rm"),
        pl.col("ord").alias("ord_add"), pl.col("next_ord").alias("ord_rm"),
        (pl.col("next_ts") - pl.col("ts")).cast(pl.Float64).alias("lifetime_s"),
    ).with_columns((pl.col("block_add") == pl.col("block_rm")).alias("same_block"))
    w = w.filter(pl.col("same_block") | (pl.col("lifetime_s") <= SHORT_LIVED_S)).with_row_index("wid")
    if w.is_empty():
        return w.drop("wid").with_columns(pl.lit(0, pl.Int64).alias("n_swaps"), pl.lit(0, pl.Int64).alias("n_own_swaps"))
    s = swaps.select("pool", "block", (pl.col("block") * ORD + pl.col("log_index")).alias("ord"), "taker")
    counts = duckdb.sql(
        """
        SELECT w.wid, count(s.ord) AS n_swaps, count(s.ord) FILTER (WHERE s.taker = w."from") AS n_own_swaps
        FROM w JOIN s ON s.pool = w.pool AND s.block BETWEEN w.block_add AND w.block_rm AND s.ord > w.ord_add AND s.ord < w.ord_rm
        GROUP BY w.wid
        """
    ).pl()
    return (
        w.join(counts, on="wid", how="left")
        .with_columns(pl.col("n_swaps").fill_null(0).cast(pl.Int64), pl.col("n_own_swaps").fill_null(0).cast(pl.Int64))
        .drop("wid")
    )


def own_jit_swaps(windows: pl.DataFrame, swaps: pl.DataFrame) -> pl.DataFrame:
    """Swap keys [pool, block, log_index] that sit inside a strict JIT window opened by the same taker."""
    strict = windows.filter(pl.col("same_block") & (pl.col("n_own_swaps") > 0))
    if strict.is_empty():
        return pl.DataFrame(schema={"pool": pl.Utf8, "block": pl.Int64, "log_index": pl.Int64})
    s = swaps.select("pool", "block", pl.col("log_index").cast(pl.Int64), (pl.col("block") * ORD + pl.col("log_index")).alias("ord"), "taker")
    return duckdb.sql(
        """
        SELECT DISTINCT s.pool, s.block, s.log_index FROM strict w JOIN s
          ON s.pool = w.pool AND s.block = w.block_add AND s.taker = w."from" AND s.ord > w.ord_add AND s.ord < w.ord_rm
        """
    ).pl()


def taker_lp_features(ev: pl.DataFrame, windows: pl.DataFrame, swaps: pl.DataFrame) -> pl.DataFrame:
    """Per taker: is_lp, lp_events, jit_windows (strict, >=1 swap), short_lived_windows (<= SHORT_LIVED_S, >=1 swap),
    jit_own_swaps, lp_tx_swaps (own swaps inside a tx that also changed liquidity in a covered pool)."""
    lp = ev.group_by("from").agg(pl.len().alias("lp_events")).rename({"from": "taker"})
    wj = windows.filter(pl.col("n_swaps") > 0).group_by("from").agg(
        pl.col("same_block").sum().cast(pl.Int64).alias("jit_windows"),
        pl.len().cast(pl.Int64).alias("short_lived_windows"),
        (pl.col("n_own_swaps") > 0).sum().cast(pl.Int64).alias("short_lived_own_windows"),
    ).rename({"from": "taker"})
    own = own_jit_swaps(windows, swaps)
    own_cnt = (
        swaps.select("taker", "pool", "block", pl.col("log_index").cast(pl.Int64))
        .join(own, on=["pool", "block", "log_index"], how="semi")
        .group_by("taker").agg(pl.len().cast(pl.Int64).alias("jit_own_swaps"))
    )
    lp_tx = swaps.join(ev.select("tx_hash").unique(), on="tx_hash", how="semi").group_by("taker").agg(pl.len().cast(pl.Int64).alias("lp_tx_swaps"))
    base = swaps.select("taker").unique()
    out = base.join(lp, on="taker", how="left").join(wj, on="taker", how="left").join(own_cnt, on="taker", how="left").join(lp_tx, on="taker", how="left")
    return out.with_columns(
        pl.col("lp_events").fill_null(0).cast(pl.Int64),
        pl.col("jit_windows").fill_null(0),
        pl.col("short_lived_windows").fill_null(0),
        pl.col("short_lived_own_windows").fill_null(0),
        pl.col("jit_own_swaps").fill_null(0),
        pl.col("lp_tx_swaps").fill_null(0),
    ).with_columns((pl.col("lp_events") > 0).alias("is_lp"))
