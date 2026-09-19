"""Aerodrome NVDAc/USDC positions: staked / unstaked fee attribution, AERO rewards, early-withdraw penalties (M1.3 step 2).

Built on the Uniswap-v3 machinery in positions/ (reconstruction, feeGrowth-style sweep, valuation), chain = "base":
  * Staking is an NFT transfer to the gauge, so positions.segments() already splits a position at every deposit /
    withdraw; a segment whose holder is the gauge is STAKED, and its beneficiary is the depositor (the `from` of the
    transfer into the gauge).
  * Fees (Slipstream CLPool.calculateFees / NPM `if (!isStaked)`): the sweep attributes each swap's GROSS fee pro rata
    to all in-range liquidity. An unstaked segment keeps (1 − unstakedFee) of its share; a staked segment keeps none
    (it goes to the gauge, i.e. veAERO voters). Markouts (value picked off) hit staked and unstaked liquidity alike.
  * AERO: the pool's rewardGrowthInside, rebuilt as a time sweep. Between consecutive events (swap = tick change,
    staked-segment start / end, reward-rate change) the reward rate r is paid to the tick bucket holding the current
    tick, per unit of STAKED liquidity covering that bucket: G[b] += r·dt / L_staked[b] (and the same in USD at the
    AERO price at that time). A staked segment earns L · Δ Σ_{b in range} G[b]. With no staked liquidity in range
    nothing accrues (the gauge rolls it over), exactly as onchain.
  * Early-withdraw penalty (gaugeFactory.penaltyRate = 100% within minStakeTimes = 300 s): the forfeited AERO per
    tokenId comes from EarlyWithdrawPenalty(owner, tokenId, penalty); AERO received = earned − forfeited.
  * Reconciliation: (a) unstaked closed positions: onchain collected − principal vs (1 − unstakedFee) · attributed;
    (b) AERO per depositor with no staked position open at the data end: Σ computed vs Σ ClaimRewards + penalties.

    uv run python -m aero.positions      →  data/study/m1/aero/{positions,segments,attribution,owners}.parquet, reconciliation.json
"""

from __future__ import annotations

import json
import time
from datetime import datetime, timezone

import numpy as np
import polars as pl

from aero.study import (GAUGE, NVDA, OUT, T_CLAIM_REWARDS, T_DEPOSIT, T_EARLY_PENALTY, T_WITHDRAW, UNSTAKED_FEE, aero_price,
                        gauge_logs, price_at, reward_schedule)
from positions.attribute import finalize, gas_by_position, owners_table, run_pool
from positions.reconstruct import CHAINS, price_path

FEE_METRICS = ["fee0", "fee1", "fee_usd", "fee_usd_v1h", "fee_usd_hlv1h"]  # scaled by the LP keep-share; picked_* are not


def staked_segments(seg: pl.DataFrame, transfers: pl.DataFrame) -> pl.DataFrame:
    """Flag staked segments and attach the depositor (from of the latest transfer into the gauge at or before start)."""
    into = (transfers.filter(pl.col("to") == GAUGE).select("pos_id", pl.col("ord").alias("start_ord"), pl.col("from").alias("depositor"))
            .sort("start_ord"))
    s = seg.with_columns((pl.col("seg_owner") == GAUGE).alias("staked")).sort("start_ord")
    s = s.join_asof(into, on="start_ord", by="pos_id", strategy="backward", check_sortedness=False)
    return s.with_columns(pl.when(pl.col("staked")).then(pl.col("depositor")).otherwise(None).alias("depositor"),
                          pl.when(pl.col("staked")).then(pl.col("depositor")).otherwise(pl.col("seg_owner")).alias("beneficiary"))


def reward_sweep(seg: pl.DataFrame, path: pl.DataFrame, sched: pl.DataFrame, prices: pl.DataFrame, ticks: np.ndarray,
                 t_end: float) -> tuple[np.ndarray, np.ndarray, dict]:
    """AERO (and USD at accrual) earned by every STAKED segment; zeros elsewhere. See module docstring."""
    # a segment starting after the data end has seen nothing yet; without this its (clipped) end would be snapshot
    # against an unset start and earn every reward since launch
    live = seg["staked"].to_numpy() & (seg["start_ts"].cast(pl.Float64).to_numpy() <= t_end)
    st = seg.filter(pl.Series(live))
    idx = np.flatnonzero(live)
    s0 = st["start_ts"].cast(pl.Float64).to_numpy()
    s1 = np.minimum(st["end_ts"].cast(pl.Float64).fill_null(t_end).to_numpy(), t_end)
    L = st["L"].to_numpy().astype(np.float64)
    a_lo, a_hi = st["a_lo"].to_numpy(), st["a_hi"].to_numpy()
    nb = len(ticks) + 1

    # event times: tick changes, staked L changes, rate changes; each with its payload
    p_ts = path["ts"].to_numpy().astype(np.float64)
    p_b = np.searchsorted(ticks, path["tick"].to_numpy(), side="right")
    r_ts = sched["start_ts"].to_numpy()
    r_end = sched["end_ts"].to_numpy()
    r_rate = sched["rate_aero_s"].to_numpy()
    # rate at time t: latest schedule row with start ≤ t, and 0 once past its end
    kinds = np.concatenate([np.zeros(len(p_ts)), np.ones(len(s0)), np.full(len(s1), 2), np.full(len(r_ts), 3), np.full(len(r_end), 3)])
    times = np.concatenate([p_ts, s0, s1, r_ts, r_end])
    ref = np.concatenate([np.arange(len(p_ts)), np.arange(len(s0)), np.arange(len(s1)), np.arange(len(r_ts)), np.arange(len(r_end))])
    # stop at the data end (a final no-op event there closes the last interval); nothing after it is observed
    keep = times <= t_end
    kinds, times, ref = np.append(kinds[keep], 3), np.append(times[keep], t_end), np.append(ref[keep], 0)
    order = np.lexsort((kinds, times))  # at equal times: tick, then starts, then ends, then rate changes
    G = np.zeros(nb)
    Gu = np.zeros(nb)
    SL = np.zeros(nb)
    snap0 = np.zeros(len(s0)); snap0u = np.zeros(len(s0))
    earned = np.zeros(len(s0)); earned_u = np.zeros(len(s0))
    cur_b, cur_t, rate = int(p_b[0]) if len(p_b) else 0, float(times[order[0]]) if len(order) else 0.0, 0.0
    paid, unpaid = 0.0, 0.0
    for k in order:
        t = times[k]
        if t > cur_t:
            dt = t - cur_t
            if rate > 0:
                if SL[cur_b] > 0:
                    px = float(price_at(prices, np.array([cur_t + dt / 2]))[0])
                    G[cur_b] += rate * dt / SL[cur_b]
                    Gu[cur_b] += rate * dt * px / SL[cur_b]
                    paid += rate * dt
                else:
                    unpaid += rate * dt
            cur_t = t
        kind, j = kinds[k], ref[k]
        if kind == 0:
            cur_b = int(p_b[j])
        elif kind == 1:
            snap0[j] = G[a_lo[j]:a_hi[j]].sum(); snap0u[j] = Gu[a_lo[j]:a_hi[j]].sum()
            SL[a_lo[j]:a_hi[j]] += L[j]
        elif kind == 2:
            earned[j] = L[j] * (G[a_lo[j]:a_hi[j]].sum() - snap0[j]); earned_u[j] = L[j] * (Gu[a_lo[j]:a_hi[j]].sum() - snap0u[j])
            SL[a_lo[j]:a_hi[j]] -= L[j]
            SL[a_lo[j]:a_hi[j]] = np.where(np.abs(SL[a_lo[j]:a_hi[j]]) < 1e-6 * max(L[j], 1.0), 0.0, SL[a_lo[j]:a_hi[j]])
        else:
            # rate for t ≥ this point: the latest schedule row that has started and not ended
            live = (r_ts <= t) & (t < r_end)
            rate = float(r_rate[np.flatnonzero(live)[-1]]) if live.any() else 0.0
    aero = np.zeros(seg.height); usd = np.zeros(seg.height)
    aero[idx], usd[idx] = earned, earned_u
    return aero, usd, {"aero_paid_to_staked": paid, "aero_unpaid_no_staked_in_range": unpaid, "aero_attributed": float(earned.sum())}


def forfeits() -> pl.DataFrame:
    """Per tokenId: AERO forfeited by early withdrawal, and AERO claimed in withdraw txs."""
    g = gauge_logs([T_EARLY_PENALTY, T_CLAIM_REWARDS, T_WITHDRAW, T_DEPOSIT])
    amt = pl.Series([int(d, 16) / 1e18 if d and d != "0x" else 0.0 for d in g["data"]], dtype=pl.Float64)
    g = g.with_columns(amt.alias("amount"), ("0x" + pl.col("topic1").str.slice(26)).alias("user"),
                       pl.col("topic2").str.slice(2).str.to_integer(base=16, strict=False).cast(pl.Utf8).alias("token_id"))
    pen = (g.filter(pl.col("topic0") == T_EARLY_PENALTY).group_by("token_id")
           .agg(pl.col("amount").sum().alias("aero_forfeited"), pl.len().alias("n_early_withdrawals")))
    return pen


def claims_by_user() -> pl.DataFrame:
    g = gauge_logs([T_CLAIM_REWARDS, T_EARLY_PENALTY])
    amt = pl.Series([int(d, 16) / 1e18 for d in g["data"]], dtype=pl.Float64)
    g = g.with_columns(amt.alias("amount"), ("0x" + pl.col("topic1").str.slice(26)).alias("user"))
    return g.group_by("user").agg(pl.col("amount").filter(pl.col("topic0") == T_CLAIM_REWARDS).sum().alias("aero_claimed"),
                                  pl.col("amount").filter(pl.col("topic0") == T_EARLY_PENALTY).sum().alias("aero_forfeited"))


def run() -> dict:
    t0 = time.time()
    OUT.mkdir(parents=True, exist_ok=True)
    r = run_pool(NVDA, None)
    pp, seg, pos, att = r["pp"], r["segments"], r["positions"], r["attribution"]
    path = price_path(NVDA)
    t_end = float(path["ts"].max())
    ticks = np.unique(np.concatenate([pos["lower"].to_numpy(), pos["upper"].to_numpy()]))

    seg = staked_segments(seg, pp.transfers)
    keep = pl.when(pl.col("staked")).then(0.0).otherwise(1.0 - UNSTAKED_FEE)
    gross = seg.select("pos_id", *[pl.col(m).alias(f"{m}_gross") for m in FEE_METRICS])
    seg = seg.with_columns(*[pl.col(m).alias(f"{m}_gross") for m in FEE_METRICS]).with_columns(*[(pl.col(m) * keep).alias(m) for m in FEE_METRICS])

    sched, prices = reward_schedule(), aero_price()
    aero, aero_usd, rdiag = reward_sweep(seg, path, sched, prices, ticks, t_end)
    seg = seg.with_columns(pl.Series("aero_earned", aero), pl.Series("aero_earned_usd", aero_usd))

    # position-level: replace gross fee metrics by what the LP kept, add AERO, penalties, voter fees, staked share
    agg = seg.group_by("pos_id").agg(
        *[pl.col(m).sum() for m in FEE_METRICS], pl.col("fee_usd_gross").sum(), pl.col("aero_earned").sum(), pl.col("aero_earned_usd").sum(),
        (pl.col("L") * (pl.col("end_ts").cast(pl.Float64).fill_null(t_end) - pl.col("start_ts").cast(pl.Float64))).filter(pl.col("staked")).sum().alias("_st"),
        (pl.col("L") * (pl.col("end_ts").cast(pl.Float64).fill_null(t_end) - pl.col("start_ts").cast(pl.Float64))).sum().alias("_all"),
        pl.col("depositor").drop_nulls().last().alias("depositor"),
    )
    pos = pos.drop(FEE_METRICS).join(agg, on="pos_id", how="left").join(forfeits(), on="token_id", how="left").with_columns(
        pl.col("aero_forfeited").fill_null(0.0), pl.col("n_early_withdrawals").fill_null(0),
        pl.when(pl.col("_all") > 0).then(pl.col("_st") / pl.col("_all")).otherwise(0.0).alias("staked_share"),
    ).drop("_st", "_all")
    pos = pos.with_columns(
        (pl.col("fee_usd_gross") - pl.col("fee_usd")).alias("fees_to_voters_usd"),
        pl.when(pl.col("aero_earned") > 0).then(pl.col("aero_earned_usd") * (1 - (pl.col("aero_forfeited") / pl.col("aero_earned")).clip(0, 1)))
        .otherwise(0.0).alias("aero_usd"),
        # a staked NFT's holder at the end is the gauge: the owner is its depositor
        pl.when(pl.col("owner") == GAUGE).then(pl.col("depositor")).otherwise(pl.col("owner")).alias("owner"),
    )
    # realized-fee residual with the LP keep-share (unstaked closed positions; staked ones earn no fees)
    d0, d1 = 10.0 ** NVDA.dec0, 10.0 ** NVDA.dec1
    pos = pos.with_columns(
        (pl.col("realized_fee0") - pl.col("fee0")).alias("residual0"), (pl.col("realized_fee1") - pl.col("fee1")).alias("residual1"),
    ).with_columns((pl.col("residual0") / d0 * pl.col("end_u0") + pl.col("residual1") / d1 * pl.col("end_u1")).alias("residual_usd"))

    gas = gas_by_position(pp.touches, CHAINS["base"].txs)
    pos = finalize(pos.join(gas, on="pos_id", how="left"))
    # AERO is LP income: add it to net / vs-HODL and their normalisations
    per_k = 1000.0 / pl.col("avg_notional_usd")
    days = pl.when(pl.col("active_seconds") > 0).then(pl.col("active_seconds") / 86400.0)
    pos = pos.with_columns((pl.col("net_usd") + pl.col("aero_usd")).alias("net_usd"), (pl.col("vs_hodl_usd") + pl.col("aero_usd")).alias("vs_hodl_usd")).with_columns(
        (pl.col("net_usd") * per_k).alias("net_per_1k"), (pl.col("net_usd") * per_k / days).alias("net_per_1k_per_day"),
        (pl.col("vs_hodl_usd") * per_k / days).alias("vs_hodl_per_1k_per_day"), (pl.col("aero_usd") * per_k / days).alias("aero_per_1k_per_day"),
        ((pl.col("fee_usd_hlv1h") + pl.col("aero_usd")) / pl.col("picked_hl_1h")).alias("edge_hl_1h_incl_aero"),
    )
    # per-regime attribution comes out of run_pool with GROSS fees; scale by the position's kept / gross ratio (exact for
    # positions that were only ever staked or only unstaked; for mixed ones it assumes the same mix in every regime)
    ratio = pos.select("pos_id", pl.when(pl.col("fee_usd_gross") > 0).then(pl.col("fee_usd") / pl.col("fee_usd_gross")).otherwise(0.0).alias("_keep"), "owner")
    att = att.join(ratio, on="pos_id", how="left").with_columns(*[(pl.col(m) * pl.col("_keep")).alias(m) for m in FEE_METRICS]).drop("_keep")
    owners = owners_table(pos, seg)

    # reconciliation
    # deposit / withdraw NPM-collect first and a staked tokenId accrues nothing in the NPM, so realized = kept fees for
    # every fully collected position; the unstaked-only subset is reported separately
    full = pos.filter(pl.col("closed") & pl.col("residual_usd").is_not_null() & (pl.col("nft_burned") | pl.col("collected_after_close").fill_null(False)))
    rec_fee = full.filter(pl.col("staked_share") == 0)
    open_staked = set(seg.filter(pl.col("staked") & pl.col("end_ts").is_null())["depositor"].drop_nulls().to_list())
    per_user = (seg.filter(pl.col("staked")).group_by(pl.col("depositor").alias("user")).agg(pl.col("aero_earned").sum().alias("aero_computed"))
                .join(claims_by_user(), on="user", how="full", coalesce=True).fill_null(0.0)
                .with_columns((pl.col("aero_claimed") + pl.col("aero_forfeited")).alias("aero_onchain"))
                .with_columns(pl.col("user").is_in(list(open_staked)).alias("has_open_stake")))
    closed_users = per_user.filter(~pl.col("has_open_stake"))
    recon = {
        "generated_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "diag": {k: v for k, v in r["diag"].items() if isinstance(v, (int, float, str, bool)) or v is None},
        "rewards": {**rdiag, "aero_claimed_onchain": float(per_user["aero_claimed"].sum()), "aero_forfeited_onchain": float(per_user["aero_forfeited"].sum())},
        "aero_users_fully_closed": {"n": closed_users.height, "computed": float(closed_users["aero_computed"].sum()),
                                    "onchain": float(closed_users["aero_onchain"].sum()),
                                    "rel_err": float(closed_users["aero_computed"].sum() / closed_users["aero_onchain"].sum() - 1) if closed_users["aero_onchain"].sum() else None},
        "fees_all_fully_collected": {"n": full.height, "attributed_usd": float(full["fee_usd"].sum()), "residual_usd": float(full["residual_usd"].sum()),
                                     "abs_residual_bp_median": float(full["residual_bp"].abs().median()) if full.height else None,
                                     "share_under_1bp": float((full["residual_bp"].abs() < 1).mean()) if full.height else None},
        "fees_unstaked_closed": {"n": rec_fee.height, "attributed_usd": float(rec_fee["fee_usd"].sum()), "residual_usd": float(rec_fee["residual_usd"].sum()),
                                 "abs_residual_bp_median": float(rec_fee["residual_bp"].abs().median()) if rec_fee.height else None,
                                 "share_under_1bp": float((rec_fee["residual_bp"].abs() < 1).mean()) if rec_fee.height else None},
        "seconds": round(time.time() - t0, 1),
    }
    # exact LP emissions for the pool summary: AERO actually distributed to staked liquidity (the schedule total in
    # aero.study double-counts rollovers), minus what early withdrawals forfeited
    summ_f = OUT / "pool_summary.json"
    if summ_f.exists():
        summ = json.loads(summ_f.read_text())
        rec_usd = float(pos["aero_usd"].sum())
        summ.update({"aero_distributed": rdiag["aero_paid_to_staked"], "aero_forfeited": float(pos["aero_forfeited"].sum()),
                     "aero_received_usd": rec_usd, "positions": pos.height, "positions_ever_staked": int((pos["staked_share"] > 0).sum()),
                     "lp_vs_hodl_usd": float(pos["vs_hodl_usd"].sum()),
                     "edge_lp_income_hl_1h": (summ["fees_to_lps_usd"] + rec_usd) / summ["picked_hl_1h_usd"] if summ.get("picked_hl_1h_usd") else None,
                     "edge_lp_income_basis": "fees kept by LPs + AERO received (earned − forfeited), valued at accrual"})
        summ_f.write_text(json.dumps(summ, indent=1, default=str))
    pos.write_parquet(OUT / "positions.parquet")
    seg.drop("a_lo", "a_hi", "k_start", "k_end", strict=False).write_parquet(OUT / "segments.parquet")
    att.write_parquet(OUT / "attribution.parquet")
    owners.write_parquet(OUT / "owners.parquet")
    per_user.write_parquet(OUT / "aero_by_user.parquet")
    (OUT / "reconciliation.json").write_text(json.dumps(recon, indent=1, default=str))
    return {"positions": pos, "segments": seg, "recon": recon}


def main():
    res = run()
    print(json.dumps(res["recon"], indent=1, default=str))
    pos = res["positions"]
    print(pos.select(pl.len().alias("positions"), pl.col("closed").sum(), (pl.col("staked_share") > 0).sum().alias("ever_staked"),
                     pl.col("fee_usd_gross").sum(), pl.col("fee_usd").sum().alias("fees_kept"), pl.col("fees_to_voters_usd").sum(),
                     pl.col("aero_earned").sum(), pl.col("aero_usd").sum(), pl.col("picked_hl_1h").sum(), pl.col("il_usd").sum(),
                     pl.col("gas_usd").sum(), pl.col("vs_hodl_usd").sum()))


if __name__ == "__main__":
    main()
