"""LP League: who actually makes money making markets in tokenized stocks?

Ranks LP *managers*, the wallet that sends the liquidity transactions (positions.operator), not the NFT holder: aggregator
contracts hold positions run by hundreds of different operators, so the holder is not the decision-maker.

Score = LP result vs simply holding the deposited tokens (fees − impermanent loss, which includes the value picked off by
informed flow), per $1k of capital per day deployed. Stock price moves cancel out of this comparison, so it measures
market-making skill rather than a directional bet.

    uv run python -m league.build     →  data/study/m1/league/league.parquet
"""

from __future__ import annotations

from pathlib import Path

import polars as pl

DATA = Path(__file__).resolve().parents[2] / "data"
POS = DATA / "study" / "m1" / "positions" / "positions.parquet"
OUT = DATA / "study" / "m1" / "league"

MIN_CAPITAL_DAYS = 1_500.0  # e.g. ≥ $500 deployed for ≥ 3 days
MIN_SPAN_DAYS = 3.0


def build() -> pl.DataFrame:
    p = pl.read_parquet(POS).filter(pl.col("operator").is_not_null() & (pl.col("notional_seconds") > 0))
    per_1k_day = lambda c: (pl.col(c).sum() / (pl.col("notional_seconds").sum() / 86_400 / 1_000))  # noqa: E731
    g = (
        p.group_by("operator")
        .agg(
            pl.len().alias("positions"),
            pl.col("pool").unique().sort().str.join(", ").alias("pools"),
            pl.col("owner").n_unique().alias("nft_holders"),
            (pl.col("notional_seconds").sum() / 86_400).alias("capital_days_usd"),
            ((pl.col("ts_last").max() - pl.col("ts_open").min()) / 86_400).alias("span_days"),
            pl.col("fee_usd").sum().alias("fees_usd"),
            pl.col("picked_hl_1h").sum().alias("picked_off_hl_usd"),
            pl.col("picked_1h").sum().alias("picked_off_self_usd"),
            pl.col("vs_hodl_usd").sum().alias("vs_hodl_usd"),
            pl.col("gas_usd").sum().alias("gas_usd"),
            per_1k_day("vs_hodl_usd").alias("vs_hodl_per_1k_day"),
            per_1k_day("fee_usd").alias("fees_per_1k_day"),
            per_1k_day("picked_hl_1h").alias("picked_off_per_1k_day"),
            pl.col("width_ticks").median().alias("median_width_ticks"),
            pl.col("weekend_share").mean().alias("weekend_share"),
            pl.col("is_jit").mean().alias("jit_share"),
            pl.col("ts_open").min().alias("first_ts"),
            pl.col("ts_last").max().alias("last_ts"),
        )
        .with_columns(
            (pl.col("positions") / pl.col("span_days").clip(lower_bound=1 / 24)).alias("positions_per_day"),
            pl.when(pl.col("picked_off_hl_usd") > 0).then(pl.col("fees_usd") / pl.col("picked_off_hl_usd")).otherwise(None).alias("edge_hl"),
            (pl.col("fees_usd") - pl.col("picked_off_hl_usd")).alias("fees_minus_picked_usd"),
        )
        .filter((pl.col("capital_days_usd") >= MIN_CAPITAL_DAYS) & (pl.col("span_days") >= MIN_SPAN_DAYS))
        .sort("vs_hodl_per_1k_day", descending=True)
        .with_row_index("rank", offset=1)
        .rename({"operator": "manager"})
    )
    return g


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    g = build()
    g.write_parquet(OUT / "league.parquet")
    pl.Config.set_tbl_cols(12)
    pl.Config.set_tbl_width_chars(220)
    print(f"{g.height} qualifying managers")
    print(g.select("rank", "manager", "positions", "pools", "capital_days_usd", "vs_hodl_per_1k_day", "fees_per_1k_day", "picked_off_per_1k_day", "edge_hl", "median_width_ticks").head(15))
    print("bottom 5:")
    print(g.select("rank", "manager", "positions", "vs_hodl_per_1k_day", "fees_per_1k_day", "picked_off_per_1k_day", "edge_hl").tail(5))


if __name__ == "__main__":
    main()
