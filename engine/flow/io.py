"""Inputs for the Flow X-ray: swaps (M0), swap-tx senders, LP logs/txs, HL candles, optional HL markouts.

All data under data/raw and data/tape is read-only; outputs go to data/study/m1/flow/.
"""

from __future__ import annotations

import re
from pathlib import Path

import polars as pl

from markout.pools import DATA

RAW = DATA / "raw"
SWAPS = DATA / "study" / "m0" / "swaps.parquet"
HL_MARKOUTS = DATA / "study" / "m1" / "hl_ref" / "hl_markouts.parquet"
OUT = DATA / "study" / "m1" / "flow"

HORIZONS = ("1m", "5m", "1h")

SWAP_COLS = [
    "pool", "block", "tx_index", "log_index", "tx_hash", "sender", "s", "q", "ts", "mid_after",
    "vol_usd", "fee_usd",
    *[f"picked_usd_{h}" for h in HORIZONS], *[f"valid_{h}" for h in HORIZONS],
    "regime", "reopen_window", "how", "date_et",
]

_CHUNK = re.compile(r"tx_(\d+)_(\d+)\.parquet$")


def load_swaps(path: Path = SWAPS) -> pl.DataFrame:
    return pl.scan_parquet(path).select(SWAP_COLS).collect()


def tx_chunks(source: str = "swap_txs") -> list[tuple[int, int, Path]]:
    """(first_block, last_block, path) of every tx chunk file, sorted by first block."""
    out = []
    for f in (RAW / source).glob("tx_*.parquet"):
        m = _CHUNK.search(f.name)
        if m:
            out.append((int(m.group(1)), int(m.group(2)), f))
    return sorted(out)


def covered_block(blocks: pl.Expr, chunks: list[tuple[int, int, Path]]) -> pl.Expr:
    """True where a block falls inside a tx chunk that is on disk."""
    cond = pl.lit(False)
    for lo, hi, _ in chunks:
        cond = cond | blocks.is_between(lo, hi)
    return cond


def load_txs(source: str = "swap_txs") -> pl.DataFrame:
    chunks = tx_chunks(source)
    if not chunks:
        raise FileNotFoundError(f"no tx files in raw/{source}")
    return (
        pl.concat([pl.scan_parquet(p) for _, _, p in chunks])
        .select("tx_hash", "from", "to", "gas_used", "gas_price_wei")
        .unique("tx_hash", keep="first")
        .collect()
    )


def load_lp_logs() -> pl.DataFrame:
    files = sorted((RAW / "lp_txs").glob("hs_*.parquet"))
    return pl.concat([pl.read_parquet(f) for f in files]) if files else pl.DataFrame()


def load_lp_txs() -> pl.DataFrame:
    chunks = tx_chunks("lp_txs")
    return pl.concat([pl.read_parquet(p) for _, _, p in chunks]).unique("tx_hash") if chunks else pl.DataFrame()


def load_candles(sym: str, iv: str) -> pl.DataFrame | None:
    f = RAW / "hl_candles" / f"xyz_{sym}_{iv}.parquet"
    return pl.read_parquet(f) if f.exists() else None


HL_KEYS = ["pool", "block", "log_index"]


def load_hl_markouts(path: Path = HL_MARKOUTS) -> pl.DataFrame | None:
    """Optional HL-referenced markouts built by markout/hl_ref.py (M1 module A). None if absent or unusable.

    Returns [pool, block, log_index, picked_hl_<h> (null where valid_hl_<h> is false), hl_ref_gap_bps (null where
    valid_pre is false), hl_ref_gap_age_s]. hl_ref's gap_pre_bps = 1e4·ln(F_pre / P_pool_before): > 0 means fair is
    ABOVE the pool.
    """
    if not path.exists():
        return None
    cols = pl.scan_parquet(path).collect_schema().names()
    if not all(k in cols for k in HL_KEYS):
        return None
    sel: list[pl.Expr] = [pl.col(k).cast(pl.Int64) if k != "pool" else pl.col(k) for k in HL_KEYS]
    for h in HORIZONS:
        c, v = f"picked_hl_{h}", f"valid_hl_{h}"
        if c in cols:
            sel.append(pl.when(pl.col(v)).then(pl.col(c)).alias(c) if v in cols else pl.col(c))
    if "gap_pre_bps" in cols:
        g = pl.col("gap_pre_bps")
        sel.append((pl.when(pl.col("valid_pre")).then(g) if "valid_pre" in cols else g).alias("hl_ref_gap_bps"))
        if "pre_age_s" in cols:  # age of the HL point behind F_pre (s); the gap is only trusted when fresh
            sel.append(pl.col("pre_age_s").cast(pl.Float64).alias("hl_ref_gap_age_s"))
    return pl.scan_parquet(path).select(sel).collect()
