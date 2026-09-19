"""Aerodrome NVDAc/USDC (Base) pool study (M1.3 step 1).

Slipstream pays LPs two ways, and which one depends on staking:
  * unstaked liquidity earns its pro-rata share of the swap fee minus `unstakedFee` (10%, sent to the gauge);
  * staked liquidity (NFT deposited in the gauge) earns no fees (its share goes to the gauge, i.e. to veAERO voters)
    and earns AERO emissions instead, pro rata to in-range staked liquidity.
So "LP fees" here are gross swap fees minus what the gauge took (CollectFees events + still-uncollected gaugeFees()),
and the LP's other income is the gauge's AERO emissions, valued with the AERO/USDC pool.

Gauge rules (CLGauge 0x434bcc…790f7b source via Blockscout; factory values read 2026-09-19):
  * deposit / withdraw both NPM-collect the position's fees to the owner first;
  * rewards accrue per unit of in-range STAKED liquidity (pool rewardGrowthInside); while none is in range they roll
    over into the next NotifyReward amount (so Σ rate·dt over time double-counts rollovers; positions do not);
  * a claim within minStakeTimes(pool) = 300 s of deposit forfeits penaltyRate = 100% of the reward to the minter
    (EarlyWithdrawPenalty instead of ClaimRewards): an anti-JIT rule for emissions.

Outputs (data/study/m1/aero/):
  swaps.parquet        NVDAc/USDC swaps in the M0 shape (fee_q/fee_usd = GROSS fee: all in-range liquidity's share)
  hl_markouts.parquet  HL-referenced markouts (xyz:NVDA · k, k calibrated per US session, as markout.hl_ref)
  aero_price.parquet   AERO/USDC mid after every swap (USDC per AERO)
  emissions.parquet    reconstructed gauge reward-rate schedule (piecewise constant, AERO/s) and its USD value by day
  by_pool / by_regime / by_how / pool_summary.json

    uv run python -m aero.study
"""

from __future__ import annotations

import json
import time
from datetime import datetime, timezone

import httpx
import numpy as np
import polars as pl

from markout.hl_ref import KEY, build_references, calibrate_k, edge_table, how_expr, mark_swaps
from markout.pools import BASE_POOLS, DATA, Pool, _words, decode_swaps, scan_raw
from markout.study import add_markouts, regime_expr

OUT = DATA / "study" / "m1" / "aero"
RPC = "https://mainnet.base.org"
NVDA = BASE_POOLS[0]
AERO_USDC = Pool("AERO/USDC", "base_aero_usdc", "v3", "0xccd9cc53b63662088c738b8bc06e9078fb8d9ad4", "AERO", "USDC", False, 6, 18, 3000, chain="base")
GAUGE = "0x30d1e5af5ce39863e6f69a1f73ffb0e1ac9771a8"
UNSTAKED_FEE = 0.10  # pool.unstakedFee() = 100_000 pips (read 2026-09-19; no change event in the pool's logs)
MIN_STAKE_S = 300    # gaugeFactory.minStakeTimes(pool)
PENALTY_RATE = 1.0   # gaugeFactory.penaltyRate() = 10_000 bps
WEEK = 7 * 86400

T_COLLECT_FEES = "0x205860e66845f2bbc0966bfab80db9bf93fca93862ea2b9fcf6945748352b4a3"    # CollectFees(address,uint128,uint128) (pool → gauge)
T_NOTIFY_REWARD = "0x095667752957714306e1a6ad83495404412df6fdb932fca6dc849a7ee910d4c1"   # NotifyReward(address,uint256)
T_CLAIM_REWARDS = "0x1f89f96333d3133000ee447473151fa9606543368f02271c9d95ae14f13bcc67"   # ClaimRewards(address,uint256)
T_DEPOSIT = "0x1c8ab8c7f45390d58f58f1d655213a82cca5d12179761a87c16f098813b8f211"         # Deposit(address,uint256,uint128), all indexed
T_WITHDRAW = "0x8903a5b5d08a841e7f68438387f1da20c84dea756379ed37e633ff3854b99b84"        # Withdraw(address,uint256,uint128), all indexed
T_EARLY_PENALTY = "0x84d24bc2eee194c09c5b44197d9c64101dca6178c60ee7544cd3b7016360be87"  # EarlyWithdrawPenalty(address,uint256,uint256)


def m0_swaps(pool: Pool) -> pl.DataFrame:
    """Decoded swaps in the M0 swaps.parquet shape (USDC quote = $1)."""
    sw = decode_swaps(pool, scan_raw(pool.source)).sort(["block", "tx_index", "log_index"])
    sw = add_markouts(sw).with_columns(pl.lit(1.0).alias("quote_usd"))
    return sw.with_columns(
        (pl.col("quote_amt") * pl.col("quote_usd")).alias("vol_usd"),
        (pl.col("fee_q") * pl.col("quote_usd")).alias("fee_usd"),
        *[(pl.col(f"picked_q_{h}") * pl.col("quote_usd")).alias(f"picked_usd_{h}") for h in ("1m", "5m", "1h")],
        *regime_expr(),
    )


def aero_price() -> pl.DataFrame:
    """USDC per AERO after every AERO/USDC swap: (ts, aero_usd)."""
    sw = decode_swaps(AERO_USDC, scan_raw(AERO_USDC.source))
    return sw.select("ts", pl.col("mid_after").alias("aero_usd")).sort("ts")


def price_at(prices: pl.DataFrame, ts: np.ndarray) -> np.ndarray:
    t, p = prices["ts"].to_numpy(), prices["aero_usd"].to_numpy()
    return p[np.clip(np.searchsorted(t, np.asarray(ts, dtype=np.float64), side="right") - 1, 0, len(t) - 1)]


def gauge_logs(topic0: list[str]) -> pl.DataFrame:
    lf = scan_raw("base_aero_gauge").filter(pl.col("topic0").is_in(topic0))
    return lf.collect().sort(["block", "tx_index", "log_index"])


def epoch_next(ts: float) -> float:
    """Aerodrome epochs flip every Thursday 00:00 UTC (unix epoch 0 was a Thursday)."""
    return (int(ts) // WEEK + 1) * WEEK


def reward_schedule() -> pl.DataFrame:
    """Piecewise-constant gauge reward rate from NotifyReward events (CLGauge.notifyRewardAmount):
    rate = (amount + leftover of the running period) / time to the next epoch flip; the period ends at the flip.
    Rollover of rewards emitted while no staked liquidity was in range is folded in by the gauge on the next notify and
    is not visible here, so the reconstruction is checked against the live rewardRate()."""
    ev = gauge_logs([T_NOTIFY_REWARD])
    rows, rate, finish = [], 0.0, 0.0
    for ts, data in ev.select(pl.col("ts").cast(pl.Float64), "data").iter_rows():
        amount = _words(data)[0] / 1e18
        leftover = (finish - ts) * rate if ts < finish else 0.0
        nxt = epoch_next(ts)
        rate = (amount + leftover) / (nxt - ts)
        finish = nxt
        rows.append({"start_ts": ts, "end_ts": nxt, "rate_aero_s": rate, "notified_aero": amount, "leftover_aero": leftover})
    df = pl.DataFrame(rows, schema={"start_ts": pl.Float64, "end_ts": pl.Float64, "rate_aero_s": pl.Float64, "notified_aero": pl.Float64, "leftover_aero": pl.Float64})
    # a later notify inside the same period supersedes the earlier rate from its own timestamp on
    return df.with_columns(pl.min_horizontal(pl.col("end_ts"), pl.col("start_ts").shift(-1).fill_null(float("inf"))).alias("end_ts"))


def emissions_by_day(sched: pl.DataFrame, prices: pl.DataFrame, t_end: float, step: float = 3600.0) -> pl.DataFrame:
    """AERO emitted and its USD value (at accrual time, hourly) per UTC day."""
    rows = []
    for s0, s1, r in sched.select("start_ts", "end_ts", "rate_aero_s").iter_rows():
        s1 = min(s1, t_end)
        if s1 <= s0:
            continue
        t = np.arange(s0, s1, step)
        dt = np.minimum(t + step, s1) - t
        rows.append(pl.DataFrame({"ts": t, "aero": r * dt, "usd": r * dt * price_at(prices, t + dt / 2)}))
    df = pl.concat(rows) if rows else pl.DataFrame(schema={"ts": pl.Float64, "aero": pl.Float64, "usd": pl.Float64})
    return (df.with_columns(pl.from_epoch(pl.col("ts").cast(pl.Int64)).dt.date().alias("date"))
            .group_by("date").agg(pl.col("aero").sum(), pl.col("usd").sum()).sort("date"))


def voter_fees(prices_nvda: pl.DataFrame) -> dict:
    """Fees the gauge took (staked liquidity's share + unstakedFee): CollectFees to date + uncollected gaugeFees()."""
    cf = scan_raw(NVDA.source).filter((pl.col("address") == NVDA.pool_id) & (pl.col("topic0") == T_COLLECT_FEES)).collect()
    usd = 0.0
    for ts, data in cf.select(pl.col("ts").cast(pl.Float64), "data").iter_rows():
        w = _words(data)
        mid = float(prices_nvda.filter(pl.col("ts") <= ts)["mid_after"][-1])
        usd += w[0] / 10**NVDA.dec0 + w[1] / 10**NVDA.dec1 * mid
    unc = rpc_call(NVDA.pool_id, "0x293833ba")  # gaugeFees() → (uint128 token0, uint128 token1)
    u0, u1 = (int(unc[2:66], 16), int(unc[66:130], 16)) if unc else (0, 0)
    last_mid = float(prices_nvda["mid_after"][-1])
    unc_usd = u0 / 10**NVDA.dec0 + u1 / 10**NVDA.dec1 * last_mid
    return {"collected_events": cf.height, "collected_usd": usd, "uncollected_usd": unc_usd, "total_usd": usd + unc_usd}


def rpc_call(to: str, data: str) -> str | None:
    try:
        r = httpx.post(RPC, json={"jsonrpc": "2.0", "id": 1, "method": "eth_call", "params": [{"to": to, "data": data}, "latest"]}, timeout=20)
        return r.json().get("result")
    except Exception:
        return None


def run() -> dict:
    OUT.mkdir(parents=True, exist_ok=True)
    sw = m0_swaps(NVDA)
    sw.write_parquet(OUT / "swaps.parquet")

    refs, _ = build_references()
    ref = refs["NVDA/USDG"]  # xyz:NVDA; k absorbs NVDAc's per-share scale and any Base premium
    sessions = calibrate_k(sw.select("ts", pl.col("mid_after").alias("mid")), ref)
    m = mark_swaps(sw, ref, sessions).with_columns(how_expr())
    m.select(*KEY, "ts", "F_pre", "gap_pre_bps", "valid_pre", "k", "k_session", "k_lookahead",
             "picked_hl_1m", "picked_hl_5m", "picked_hl_1h", "valid_hl_1m", "valid_hl_5m", "valid_hl_1h").write_parquet(OUT / "hl_markouts.parquet")
    by_pool, by_regime, by_how = edge_table(m, ["pool"]), edge_table(m, ["pool", "regime"]), edge_table(m, ["pool", "how"])
    sessions.with_columns(pl.lit(NVDA.key).alias("pool")).write_parquet(OUT / "k_sessions.parquet")

    prices = aero_price()
    prices.write_parquet(OUT / "aero_price.parquet")
    sched = reward_schedule()
    t_end = float(sw["ts"].max())
    emis = emissions_by_day(sched.filter(pl.col("start_ts") >= float(sw["ts"].min()) - WEEK), prices, t_end)
    sched.write_parquet(OUT / "reward_schedule.parquet")
    emis.write_parquet(OUT / "emissions.parquet")

    live_rate = rpc_call(GAUGE, "0x7b0a47ee")  # rewardRate()
    live_rate = int(live_rate, 16) / 1e18 if live_rate else None
    vf = voter_fees(sw.select("ts", "mid_after"))
    gross = float(sw["fee_usd"].sum())
    hl_ok = m.filter(pl.col("valid_hl_1h"))
    picked_hl = float(hl_ok["picked_hl_1h"].sum())
    fee_hlv = float(hl_ok["fee_usd"].sum())
    lp_fees = gross - vf["total_usd"]
    emis_usd, emis_aero = float(emis["usd"].sum()), float(emis["aero"].sum())
    summary = {
        "generated_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "pool": NVDA.key, "swaps": sw.height, "first_utc": datetime.fromtimestamp(float(sw["ts"].min()), timezone.utc).isoformat(),
        "last_utc": datetime.fromtimestamp(t_end, timezone.utc).isoformat(), "vol_usd": float(sw["vol_usd"].sum()),
        "fees_gross_usd": gross, "fees_to_voters_usd": vf["total_usd"], "fees_to_voters": vf, "fees_to_lps_usd": lp_fees,
        "emissions_aero": emis_aero, "emissions_usd": emis_usd,
        "picked_hl_1h_usd": picked_hl, "fees_gross_on_valid_hl_1h_usd": fee_hlv,
        "edge_gross_hl_1h": fee_hlv / picked_hl if picked_hl > 0 else None,
        # LP income per $ picked off: fees kept by LPs + emissions (pool-level, all-period totals)
        "edge_lp_income_hl_1h": (lp_fees + emis_usd) / picked_hl if picked_hl > 0 else None,
        "reward_rate_reconstructed_aero_s": float(sched["rate_aero_s"][-1]) if sched.height else None,
        "reward_rate_live_aero_s": live_rate, "unstaked_fee": UNSTAKED_FEE,
        "hl_valid_1h_share": float(m["valid_hl_1h"].mean()),
    }
    for name, df in [("by_pool", by_pool), ("by_regime", by_regime), ("by_how", by_how)]:
        df.write_parquet(OUT / f"{name}.parquet")
    (OUT / "pool_summary.json").write_text(json.dumps(summary, indent=1, default=str))
    return summary


def main():
    t0 = time.time()
    s = run()
    print(json.dumps({k: v for k, v in s.items() if k != "fees_to_voters"}, indent=1, default=str))
    print(f"({time.time() - t0:.0f}s)")


if __name__ == "__main__":
    main()
