"""HDBSCAN clustering of takers with >= MIN_SWAPS swaps on standardized (log-)features.

Heavy-tailed magnitudes are log1p'd, signed per-volume markouts go through asinh, shares/ratios stay in [0, 1];
everything is z-scored (StandardScaler) before HDBSCAN. Takers with fewer swaps are "long tail"; HDBSCAN noise
is "noise". Cluster ids are made deterministic: input sorted by taker address, clusters renumbered C1, C2, ...
by descending 1h picked-off USD.
"""

from __future__ import annotations

import numpy as np
import polars as pl
from sklearn.cluster import HDBSCAN
from sklearn.preprocessing import StandardScaler

MIN_SWAPS = 20
MIN_CLUSTER_SIZE = 15
MIN_SAMPLES = 5

LOG_FEATURES = ["swaps", "active_days", "swaps_per_day", "vol_usd", "size_med", "size_p90", "fee_usd", "n_routers", "swaps_per_tx", "gas_used_med"]
SHARE_FEATURES = [
    "pos5m_share", "hl_lead", "hl_toward", "how_entropy", "share_regular", "share_weekend", "share_reopen",
    "public_router_share", "direct_call_share", "buy_share", "gas_pct_med", "multi_swap_tx_share",
]
SIGNED_FEATURES = {"picked_bps_1h": 10.0}  # asinh(x / scale)

LONG_TAIL = "long tail"
NOISE = "noise"


def design_matrix(t: pl.DataFrame) -> np.ndarray:
    cols = []
    for c in LOG_FEATURES:
        cols.append(np.log1p(t[c].cast(pl.Float64).fill_null(0).fill_nan(0).clip(lower_bound=0).to_numpy()))
    for c in SHARE_FEATURES:
        cols.append(t[c].cast(pl.Float64).fill_null(0.5 if c.startswith("hl_") else 0.0).fill_nan(0.0).to_numpy())
    for c, scale in SIGNED_FEATURES.items():
        cols.append(np.arcsinh(t[c].cast(pl.Float64).fill_null(0).fill_nan(0).to_numpy() / scale))
    return StandardScaler().fit_transform(np.column_stack(cols))


def cluster_takers(t: pl.DataFrame, min_cluster_size: int = MIN_CLUSTER_SIZE, min_samples: int = MIN_SAMPLES) -> pl.DataFrame:
    """Add `cluster` (str) to the taker table. Deterministic for a given set of takers."""
    t = t.sort("taker")
    big = t.filter(pl.col("swaps") >= MIN_SWAPS)
    small = t.filter(pl.col("swaps") < MIN_SWAPS).with_columns(pl.lit(LONG_TAIL).alias("cluster"))
    if big.height < max(min_cluster_size, 2):
        return pl.concat([big.with_columns(pl.lit(NOISE).alias("cluster")), small])
    raw = HDBSCAN(min_cluster_size=min_cluster_size, min_samples=min_samples, copy=True).fit_predict(design_matrix(big))
    big = big.with_columns(pl.Series("_raw", raw))
    order = (
        big.filter(pl.col("_raw") >= 0).group_by("_raw").agg(pl.col("picked_1h").sum().alias("_p"), pl.col("taker").min().alias("_first"))
        .sort(["_p", "_first"], descending=[True, False])
        .with_row_index("_rank", offset=1)
        .select("_raw", pl.concat_str([pl.lit("C"), pl.col("_rank").cast(pl.Utf8)]).alias("cluster"))
    )
    big = big.join(order, on="_raw", how="left").with_columns(pl.col("cluster").fill_null(NOISE)).drop("_raw")
    return pl.concat([big, small]).sort("taker")
