"""Fetch Hyperliquid trade.xyz candles for the reference/hedge markets.

HL serves at most ~5,000 candles per (coin, interval), so fine intervals only reach back a few days/weeks:
1m ≈ 3.5 days, 5m ≈ 17 days, 15m ≈ 52 days, 1h ≈ 208 days. We pull every interval as far back as it goes;
the live 1-second tape (recorder/tape.mjs) takes over from here on.

    uv run python -m indexer.hl_candles
"""

from __future__ import annotations

import time
from pathlib import Path

import httpx
import polars as pl

OUT = Path(__file__).resolve().parents[2] / "data" / "raw" / "hl_candles"
COINS = ["xyz:NVDA", "xyz:SP500", "xyz:XYZ100", "xyz:TSLA", "xyz:AAPL", "xyz:META", "xyz:GOOGL", "xyz:HIMS", "xyz:SPCX"]
INTERVALS = {"1m": 60, "5m": 300, "15m": 900, "1h": 3600}
START_MS = 1_782_864_000_000  # 2026-07-01T00:00Z


def fetch(coin: str, interval: str) -> pl.DataFrame:
    step = INTERVALS[interval] * 1000
    end = int(time.time() * 1000)
    rows, cursor = [], START_MS
    with httpx.Client(timeout=30) as c:
        while cursor < end:
            r = c.post("https://api.hyperliquid.xyz/info", json={"type": "candleSnapshot", "req": {"coin": coin, "interval": interval, "startTime": cursor, "endTime": end}})
            r.raise_for_status()
            batch = r.json()
            if not batch:
                break
            rows += batch
            nxt = batch[-1]["t"] + step
            if nxt <= cursor:
                break
            cursor = nxt
            time.sleep(0.3)
    if not rows:
        return pl.DataFrame()
    df = pl.DataFrame(rows).select(
        pl.col("t").alias("t_open_ms"),
        pl.col("T").alias("t_close_ms"),
        pl.col("o").cast(pl.Float64),
        pl.col("h").cast(pl.Float64),
        pl.col("l").cast(pl.Float64),
        pl.col("c").cast(pl.Float64),
        pl.col("v").cast(pl.Float64),
        pl.col("n").cast(pl.Int64),
    )
    return df.unique("t_open_ms").sort("t_open_ms").with_columns(pl.lit(coin).alias("coin"), pl.lit(interval).alias("interval"))


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for coin in COINS:
        for iv in INTERVALS:
            df = fetch(coin, iv)
            if df.is_empty():
                print(f"{coin} {iv}: none")
                continue
            df.write_parquet(OUT / f"{coin.replace(':', '_')}_{iv}.parquet")
            first = time.strftime("%Y-%m-%d %H:%M", time.gmtime(df["t_open_ms"][0] / 1000))
            print(f"{coin} {iv}: {df.height:,} candles from {first}Z")


if __name__ == "__main__":
    main()
