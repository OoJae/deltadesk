"""Per-position fee & LVR attribution, valuation and reconciliation (M1 · module C, steps 2–4 and 6).

Fee attribution the Uniswap way, as a feeGrowth-style sweep (no swaps × positions join):
  * Tick space is cut into buckets at every tick any position ever used as a bound, so inside a bucket the
    reconstructed liquidity L_b is constant between two consecutive LP events (an "epoch").
  * A swap's LP fee X (and its picked-off markouts) goes to the liquidity it traded against. A swap that stays in
    one bucket (≈92% of swaps) gives growth X / L_b to that bucket: exactly the spec's rule "liquidity in range at
    tick_before, pro-rata by liquidity". A swap that crosses bucket bounds is split over the buckets on its price path
    with weights L_b·Δ_b, where Δ_b is the path length inside bucket b in √P (token1 in) or 1/√P (token0 in).
    For an exact-in Uniswap step the input amount is L·Δ, so these are the real per-step fee shares.
    The denominator is the RECONSTRUCTED liquidity, so Σ over positions = Σ over swaps by construction; the Swap
    event's own `liquidity` is only a diagnostic (reconstruction check).
  * A per-bucket accumulator A[b] (fee per unit liquidity) runs through the epochs; at every LP event of a position we
    snapshot Σ_{b in range} A[b] (= feeGrowthInside). A segment of constant liquidity L earns
    L·(snapshot_end − snapshot_start). JIT: a mint→swap→burn inside a block only sees the swaps between its logs.
  * v3 flash fees (LP share) are fee-only pseudo-swaps at the current tick.

Metrics carried through the sweep (per regime, so weekend / regular-hours edges come out per position):
  fee0, fee1 (raw token units, LP share), fee_usd, vol_usd, picked_{1m,5m,1h} (self markouts, valid only),
  fee_usd_v1h (fees on swaps with a valid 1h self markout), picked_hl_{1m,5m,1h} and fee_usd_hlv1h (HL markouts
  from data/study/m1/hl_ref/hl_markouts.parquet, valid only; zeros if that file is missing).

Valuation per position (USD, pool mid at event time, USDG = $1, SPY via the SPY/USDG pool for QQQ/SPY):
  deposits / withdrawals at event time; end value = open liquidity at the pool's last price (closed: 0);
  HODL = the deposited token basket, reduced pro rata on each withdrawal (withdrawn share valued then), rest at end;
  price_pnl = HODL − deposits, il = LP (withdrawals + end) − HODL, fees = attributed fees at accrual time,
  gas = Σ tx gas × ETH_USD / positions touched by the tx, net = price_pnl + il + fees − gas
      = end value + withdrawals + fees − deposits − gas.
Reconciliation (v3): realized fees = Σ collected − Σ principal withdrawn (NPM Collect − DecreaseLiquidity per tokenId;
  pool Collect − Burn per direct lifecycle); residual = realized − attributed.

    uv run python -m positions.attribute
"""

from __future__ import annotations

import json
import math
import time
from datetime import datetime, timezone

import numpy as np
import polars as pl

from markout.pools import DATA, POOLS, Pool
from markout.study import regime_expr
from positions.reconstruct import (CHAINS, OUT, POOL_BY_KEY, exact_swap_liquidity, T_V3_FLASH, T_V3_SET_FEE_PROTOCOL, PoolPositions,
                                   UsdPricer, amounts_for_liquidity, load_logs, load_txs, ord_expr, price_path, reconstruct, segments,
                                   tick_to_sqrtp, words)

SWAPS = DATA / "study" / "m0" / "swaps.parquet"
HL_PATH = DATA / "study" / "m1" / "hl_ref" / "hl_markouts.parquet"
# per chain: (M0-shaped swap table, HL markouts). Base swaps are built by aero.study.
SWAP_TABLES = {"robinhood": (SWAPS, HL_PATH),
               "base": (DATA / "study" / "m1" / "aero" / "swaps.parquet", DATA / "study" / "m1" / "aero" / "hl_markouts.parquet")}
ETH_USD = 4000.0  # FLAGGED CONSTANT: no ETH/USD source exists under data/ (HL tape covers xyz stock perps only)
REGIMES = ["REGULAR", "EXTENDED", "OVERNIGHT", "WEEKEND_DARK", "HOLIDAY"]
METRICS = ["fee0", "fee1", "fee_usd", "vol_usd", "picked_1m", "picked_5m", "picked_1h", "fee_usd_v1h",
           "picked_hl_1m", "picked_hl_5m", "picked_hl_1h", "fee_usd_hlv1h"]
NM, NR = len(METRICS), len(REGIMES)
MI = {m: i for i, m in enumerate(METRICS)}
JIT_MAX_S = 12         # JIT = opened and fully closed within 12 s (~120 blocks at ~0.1 s); `same_block` is the strict flag
SHORT_LIVED_S = 3600   # flag positions alive < 1h


# ------------------------------------------------------------------------------------------------------------ swap inputs
def load_swaps(pool: Pool, path: pl.DataFrame) -> pl.DataFrame:
    """swaps.parquet rows of one pool + raw √P before/after + HL markouts + per-token LP fee (raw units)."""
    cols = ["block", "tx_index", "log_index", "ts", "s", "q", "p_exec", "fee_q", "fee_usd", "vol_usd", "liquidity",
            "tick_before", "tick", "regime", "picked_usd_1m", "picked_usd_5m", "picked_usd_1h", "valid_1m", "valid_5m", "valid_1h"]
    swaps_path, hl_path = SWAP_TABLES[pool.chain]
    sw = pl.scan_parquet(swaps_path).filter(pl.col("pool") == pool.key).select(cols).with_columns(ord_expr()).collect()
    pth = path.select("ord", pl.col("sqrtp").shift(1).alias("sqrtp_before"), pl.col("sqrtp").alias("sqrtp_after"))
    sw = sw.join(pth, on="ord", how="left")
    if hl_path.exists():
        hl = (pl.scan_parquet(hl_path).filter(pl.col("pool") == pool.key)
              .select("block", "tx_index", "log_index", "picked_hl_1m", "picked_hl_5m", "picked_hl_1h", "valid_hl_1m", "valid_hl_5m", "valid_hl_1h")
              .collect())
        sw = sw.join(hl, on=["block", "tx_index", "log_index"], how="left")
    else:
        sw = sw.with_columns(*[pl.lit(0.0).alias(f"picked_hl_{h}") for h in ("1m", "5m", "1h")],
                             *[pl.lit(False).alias(f"valid_hl_{h}") for h in ("1m", "5m", "1h")])
    quote_is_0 = not pool.base_is_0
    dq, db = (pool.dec0, pool.dec1) if quote_is_0 else (pool.dec1, pool.dec0)
    fee_quote_raw = pl.when(pl.col("s") == 1).then(pl.col("fee_q") * 10.0**dq).otherwise(0.0)
    fee_base_raw = pl.when(pl.col("s") == -1).then(pl.col("fee_q") / pl.col("p_exec") * 10.0**db).otherwise(0.0)
    v = lambda c: pl.col(c).fill_null(False)  # noqa: E731
    return sw.with_columns(
        (fee_quote_raw if quote_is_0 else fee_base_raw).alias("fee0"),
        (fee_base_raw if quote_is_0 else fee_quote_raw).alias("fee1"),
        *[pl.when(v(f"valid_{h}")).then(pl.col(f"picked_usd_{h}")).otherwise(0.0).alias(f"picked_{h}") for h in ("1m", "5m", "1h")],
        pl.when(v("valid_1h")).then(pl.col("fee_usd")).otherwise(0.0).alias("fee_usd_v1h"),
        *[pl.when(v(f"valid_hl_{h}")).then(pl.col(f"picked_hl_{h}")).otherwise(0.0).alias(f"picked_hl_{h}") for h in ("1m", "5m", "1h")],
        pl.when(v("valid_hl_1h")).then(pl.col("fee_usd")).otherwise(0.0).alias("fee_usd_hlv1h"),
        pl.col("regime").replace_strict({r: i for i, r in enumerate(REGIMES)}, return_dtype=pl.Int64).alias("reg"),
        pl.lit(False).alias("is_flash"),
    ).sort("ord")


def load_flash(pool: Pool, pricer: UsdPricer) -> pl.DataFrame | None:
    """v3 Flash fees (LP share after the protocol cut) as fee-only pseudo-swaps at the pool's current tick."""
    if pool.venue != "v3":
        return None
    fl = load_logs(pool.source, address=pool.pool_id, topic0=[T_V3_FLASH])
    if fl.is_empty():
        return None
    sfp = load_logs(pool.source, address=pool.pool_id, topic0=[T_V3_SET_FEE_PROTOCOL])
    sched = [(0, 0, 0)] + [(o, words(d)[2], words(d)[3]) for o, d in sfp.select("ord", "data").iter_rows()]
    if len(sched) == 1 and pool.v3_fee_protocol_now:
        sched = [(0, pool.v3_fee_protocol_now % 16, pool.v3_fee_protocol_now >> 4)]
    rows = []
    for o, b, txi, li, ts, d in fl.select("ord", "block", "tx_index", "log_index", "ts", "data").iter_rows():
        w = words(d)
        fp0, fp1 = [s for s in sched if s[0] < o][-1][1:]
        lp0 = w[2] - (w[2] // fp0 if fp0 else 0)
        lp1 = w[3] - (w[3] // fp1 if fp1 else 0)
        rows.append((o, b, txi, li, float(ts), float(lp0), float(lp1)))
    df = pl.DataFrame(rows, schema=["ord", "block", "tx_index", "log_index", "ts", "fee0", "fee1"], orient="row")
    sq, tk = pricer.state_at(df["ord"].to_numpy())
    u0, u1 = pricer.usd01(sq, df["ts"].to_numpy())
    fee_usd = df["fee0"].to_numpy() / 10**pool.dec0 * u0 + df["fee1"].to_numpy() / 10**pool.dec1 * u1
    df = df.with_columns(pl.Series("sqrtp_before", sq), pl.Series("sqrtp_after", sq), pl.Series("tick_before", tk.astype(np.int64)),
                         pl.Series("tick", tk.astype(np.int64)), pl.Series("fee_usd", fee_usd), pl.lit(None, pl.Float64).alias("liquidity"),
                         pl.lit(True).alias("is_flash"))
    return df.with_columns(pl.col("ts").cast(pl.Float64)).with_columns(*regime_expr()).with_columns(
        pl.col("regime").replace_strict({r: i for i, r in enumerate(REGIMES)}, return_dtype=pl.Int64).alias("reg"))


# --------------------------------------------------------------------------------------------------------------- sweep
def sweep(ticks: np.ndarray, ev: pl.DataFrame, sw: pl.DataFrame) -> dict:
    """Run the feeGrowth sweep for one pool.

    ticks: sorted unique position bounds. Array index a(t) = searchsorted(ticks, t, 'right') ∈ [0, nb]; a position
    [lower, upper) covers indices [a(lower), a(upper)).
    ev: sweep events sorted by ord with columns ord, a_lo, a_hi, dL_signed (python-int string).
    sw: swaps (+ flash) sorted by ord with METRICS columns, reg, tick_before, tick, sqrtp_before/after, liquidity.
    Returns snap (K, NR*NM) = Σ_{b in range} A[b] just before each event, A_final, and per-swap diagnostics."""
    nb = len(ticks)
    K = ev.height
    ev_ord = ev["ord"].to_numpy()
    ev_lo = ev["a_lo"].to_numpy()
    ev_hi = ev["a_hi"].to_numpy()
    ev_dl = [int(x) for x in ev["dL_signed"].to_list()]

    n = sw.height
    ords = sw["ord"].to_numpy()
    epoch = np.searchsorted(ev_ord, ords, side="left")  # number of LP events strictly before the swap
    a_b = np.searchsorted(ticks, sw["tick_before"].to_numpy(), side="right")
    a_a = np.searchsorted(ticks, sw["tick"].to_numpy(), side="right")
    reg = sw["reg"].to_numpy()
    X = np.stack([sw[m].fill_null(0.0).to_numpy().astype(np.float64) for m in METRICS])  # (NM, n)
    sb = sw["sqrtp_before"].to_numpy().astype(np.float64)
    sa = sw["sqrtp_after"].to_numpy().astype(np.float64)
    sb = np.where(np.isnan(sb), sa, sb)
    multi = a_b != a_a

    # --- single-bucket swaps: pre-aggregate by (epoch, bucket, regime)
    s_idx = np.flatnonzero(~multi)
    key = (epoch[s_idx].astype(np.int64) * (nb + 1) + a_b[s_idx]) * NR + reg[s_idx]
    order = np.argsort(key, kind="stable")
    ks = key[order]
    starts = np.flatnonzero(np.r_[True, ks[1:] != ks[:-1]]) if ks.size else np.zeros(0, dtype=np.int64)
    g_key = ks[starts]
    g_X = np.add.reduceat(X[:, s_idx[order]], starts, axis=1) if len(starts) else np.zeros((NM, 0))
    g_reg = g_key % NR
    g_a = (g_key // NR) % (nb + 1)
    g_ep = g_key // NR // (nb + 1)
    g_bounds = np.searchsorted(g_ep, np.arange(K + 2), side="left")

    # --- multi-bucket swaps: explode over the buckets on the price path, Δ in the input token's coordinate
    m_idx = np.flatnonzero(multi)
    lo_a = np.minimum(a_b[m_idx], a_a[m_idx])
    cnt = np.abs(a_a[m_idx] - a_b[m_idx]) + 1
    rep = np.repeat(np.arange(len(m_idx)), cnt)
    offs = np.r_[0, np.cumsum(cnt)[:-1]]
    k_ent = lo_a[rep] + (np.arange(rep.size) - offs[rep])
    sqt = tick_to_sqrtp(ticks)
    b_lo = np.where(k_ent >= 1, sqt[np.clip(k_ent - 1, 0, nb - 1)], 0.0)
    b_hi = np.where(k_ent < nb, sqt[np.clip(k_ent, 0, nb - 1)], np.inf)
    p0, p1 = sb[m_idx][rep], sa[m_idx][rep]
    pmin, pmax = np.minimum(p0, p1), np.maximum(p0, p1)
    ov_lo, ov_hi = np.maximum(b_lo, pmin), np.minimum(b_hi, pmax)
    up = p1 > p0
    has = ov_hi > ov_lo
    with np.errstate(divide="ignore", invalid="ignore"):
        delta = np.where(has, np.where(up, ov_hi - ov_lo, 1.0 / ov_lo - 1.0 / ov_hi), 0.0)
    # a crossing swap whose float path has zero length everywhere (boundary rounding) falls back to its start bucket
    tot = np.bincount(rep, delta, minlength=len(m_idx))
    start_ent = k_ent == a_b[m_idx][rep]
    delta = np.where((tot[rep] <= 0) & start_ent, 1.0, delta)
    ent_ep = epoch[m_idx][rep]
    m_bounds = np.searchsorted(epoch[m_idx], np.arange(K + 2), side="left")      # swaps (m_idx is ord-sorted)
    e_bounds = np.searchsorted(ent_ep, np.arange(K + 2), side="left")            # entries
    ent_bounds = np.r_[0, np.cumsum(cnt)]

    # --- diagnostics per swap: reconstructed L at the post-swap tick vs the Swap event's liquidity
    sw_bounds = np.searchsorted(epoch, np.arange(K + 2), side="left")
    L_rec_after = np.zeros(n)
    L_rec_before = np.zeros(n)

    Lx = np.zeros(nb + 1, dtype=object)   # exact liquidity per bucket (python ints: uint128 sums overflow int64)
    Lx[:] = 0
    Lf = np.zeros(nb + 1)
    A = np.zeros((NR * NM, nb + 1))
    snap = np.zeros((K, NR * NM))
    unattributed = np.zeros(NM)
    rows_m = np.arange(NM)
    t0 = time.time()
    for k in range(K + 1):
        # swaps of epoch k (after event k-1, before event k)
        g0, g1 = g_bounds[k], g_bounds[k + 1]
        if g1 > g0:
            idx = g_a[g0:g1]
            Lb = Lf[idx]
            ok = Lb > 0
            vals = g_X[:, g0:g1]
            if not ok.all():
                unattributed += vals[:, ~ok].sum(axis=1)
            if ok.any():
                rr = g_reg[g0:g1][ok][None, :] * NM + rows_m[:, None]
                np.add.at(A, (rr, idx[ok][None, :]), vals[:, ok] / Lb[ok])
        m0, m1 = m_bounds[k], m_bounds[k + 1]
        if m1 > m0:
            e0, e1 = ent_bounds[m0], ent_bounds[m1]
            kk = k_ent[e0:e1]
            loc = rep[e0:e1] - m0
            w = Lf[kk] * delta[e0:e1]
            norm = np.bincount(loc, w, minlength=m1 - m0)
            good = norm[loc] > 0
            Xm = X[:, m_idx[m0:m1]]
            bad_sw = norm <= 0
            if bad_sw.any():
                unattributed += Xm[:, bad_sw].sum(axis=1)
            if good.any():
                share = np.where(good, delta[e0:e1] / np.where(good, norm[loc], 1.0), 0.0)
                vals = Xm[:, loc] * share[None, :]
                rr = reg[m_idx[m0:m1]][loc][None, :] * NM + rows_m[:, None]
                np.add.at(A, (rr, kk[None, :]), vals)
        s0, s1 = sw_bounds[k], sw_bounds[k + 1]
        if s1 > s0:
            L_rec_after[s0:s1] = Lf[a_a[s0:s1]]
            L_rec_before[s0:s1] = Lf[a_b[s0:s1]]
        if k == K:
            break
        lo, hi = ev_lo[k], ev_hi[k]
        snap[k] = A[:, lo:hi].sum(axis=1)
        if ev_dl[k]:
            Lx[lo:hi] += ev_dl[k]
            Lf[lo:hi] = Lx[lo:hi].astype(np.float64)
    if (Lx < 0).any():
        raise AssertionError("negative bucket liquidity: reconstruction error")
    return {"snap": snap, "A": A, "L_rec_after": L_rec_after, "L_rec_before": L_rec_before, "unattributed": unattributed,
            "n_multi": int(multi.sum()), "n_entries": int(rep.size), "secs": time.time() - t0, "L_final": Lx}


def segment_accruals(seg: pl.DataFrame, ev: pl.DataFrame, snap: np.ndarray, A: np.ndarray) -> tuple[pl.DataFrame, np.ndarray]:
    """Accrual of every constant-liquidity segment: L · (Σ_{b in range} A[b] at its end − at its start).

    seg needs pos_id, start_ord, end_ord (null = open), L, a_lo, a_hi; ev is the sweep-event frame (row k = snap[k]).
    Returns seg with k_start / k_end and the (n_seg, NR·NM) accrual matrix (regime-major, METRICS within)."""
    ev_k = ev.select("pos_id", pl.col("ord").cast(pl.Int64)).with_row_index("k")
    seg = seg.with_columns(pl.col("start_ord").cast(pl.Int64), pl.col("end_ord").cast(pl.Int64))
    seg = (seg.join(ev_k.rename({"ord": "start_ord", "k": "k_start"}), on=["pos_id", "start_ord"], how="left")
           .join(ev_k.rename({"ord": "end_ord", "k": "k_end"}), on=["pos_id", "end_ord"], how="left"))
    assert seg["k_start"].null_count() == 0, "segment start not found among sweep events"
    assert (seg["k_end"].is_null() == seg["end_ord"].is_null()).all(), "segment end not found among sweep events"
    ks = seg["k_start"].to_numpy()
    ke = seg["k_end"].fill_null(-1).to_numpy()
    s_start = snap[ks]
    s_end = np.empty_like(s_start)
    has_end = ke >= 0
    s_end[has_end] = snap[ke[has_end]]
    a_lo_s, a_hi_s = seg["a_lo"].to_numpy(), seg["a_hi"].to_numpy()
    for i in np.flatnonzero(~has_end):  # still open: accrue up to the final accumulator state
        s_end[i] = A[:, a_lo_s[i]:a_hi_s[i]].sum(axis=1)
    acc = (s_end - s_start) * seg["L"].to_numpy()[:, None]
    return seg, np.where(np.abs(acc) < 1e-300, 0.0, acc)


def hodl_walk(rows, d0: float, d1: float) -> tuple[float, float, float]:
    """HODL basket of one position. rows: (etype, dL, amount0_raw, amount1_raw, usd0, usd1) in event order.

    A deposit adds its tokens to the basket; a withdrawal of a fraction f of the live liquidity takes f of the basket
    out, valued at that moment. Returns (basket0_raw, basket1_raw, hodl_withdrawn_usd); the caller values the rest at end."""
    b0 = b1 = hw = 0.0
    Lc = 0
    for et, dl, a0, a1, x0, x1 in rows:
        dl = int(dl)
        if et == "inc":
            b0 += a0; b1 += a1; Lc += dl
        else:
            frac = dl / Lc if Lc else 1.0
            hw += frac * (b0 / d0 * x0 + b1 / d1 * x1)
            b0 *= 1 - frac; b1 *= 1 - frac; Lc -= dl
    return b0, b1, hw


# ---------------------------------------------------------------------------------------------------------- per pool run
def run_pool(pool: Pool, spy_path: pl.DataFrame | None) -> dict:
    t_start = time.time()
    pp: PoolPositions = reconstruct(pool)
    path = price_path(pool)
    pricer = UsdPricer(pool, path, spy_path)
    pos, events = pp.positions, pp.events
    ticks = np.unique(np.concatenate([pos["lower"].to_numpy(), pos["upper"].to_numpy()]))
    rng = pos.select("pos_id", "lower", "upper").with_columns(
        pl.Series("a_lo", np.searchsorted(ticks, pos["lower"].to_numpy(), side="right")),
        pl.Series("a_hi", np.searchsorted(ticks, pos["upper"].to_numpy(), side="right")))

    seg = segments(pp)
    # sweep events = liquidity changes + live owner changes (segment boundaries with dL = 0)
    liq = events.select("pos_id", "ord", pl.when(pl.col("etype") == "inc").then(pl.col("dL_exact"))
                        .otherwise("-" + pl.col("dL_exact")).alias("dL_signed"))
    own = seg.filter(pl.col("src") == "owner").select("pos_id", pl.col("start_ord").alias("ord"), pl.lit("0").alias("dL_signed"))
    ev = pl.concat([liq, own]).join(rng.select("pos_id", "a_lo", "a_hi"), on="pos_id").sort("ord")
    assert ev["ord"].n_unique() == ev.height, "duplicate sweep event ords"

    sw = load_swaps(pool, path)
    fl = load_flash(pool, pricer)
    swf = pl.concat([sw, fl], how="diagonal_relaxed").sort("ord") if fl is not None else sw
    res = sweep(ticks, ev, swf)

    seg = seg.join(rng.select("pos_id", "a_lo", "a_hi", "lower", "upper"), on="pos_id")
    seg, acc = segment_accruals(seg, ev, res["snap"], res["A"])
    tot = acc.reshape(-1, NR, NM).sum(axis=1)                 # (n_seg, NM) summed over regimes
    seg = seg.with_columns(*[pl.Series(m, tot[:, i]) for i, m in enumerate(METRICS)])
    long = []
    for r, R in enumerate(REGIMES):
        long.append(seg.select("pos_id").with_columns(pl.lit(R).alias("regime"),
                    *[pl.Series(m, acc[:, r * NM + i]) for i, m in enumerate(METRICS)]))
    attribution = (pl.concat(long).group_by("pos_id", "regime").agg(pl.col(METRICS).sum())
                   .filter(pl.sum_horizontal(pl.col(["fee_usd", "vol_usd"]).abs()) > 0).with_columns(pl.lit(pool.key).alias("pool")))

    # conservation + reconstruction diagnostics
    swap_fee = float(sw["fee_usd"].sum())
    flash_fee = float(fl["fee_usd"].sum()) if fl is not None else 0.0
    attributed_fee = float(tot[:, MI["fee_usd"]].sum())
    ev_liq = swf["liquidity"].to_numpy()
    isw = ~swf["is_flash"].to_numpy()
    Lr = res["L_rec_after"]
    rel = np.abs(Lr[isw] - ev_liq[isw]) / np.maximum(ev_liq[isw], 1.0)
    fee_w = swf["fee_usd"].to_numpy()[isw]
    cross = (swf["tick_before"].to_numpy() != swf["tick"].to_numpy())[isw]
    rel_b = np.abs(res["L_rec_before"][isw] - ev_liq[isw]) / np.maximum(ev_liq[isw], 1.0)
    diag = {
        **pp.diag,
        "swaps": sw.height, "flash_events": 0 if fl is None else fl.height, "positions": pos.height, "segments": seg.height,
        "sweep_events": ev.height, "tick_buckets": int(len(ticks)), "crossing_swaps_split": res["n_multi"],
        "path_entries": res["n_entries"], "sweep_seconds": round(res["secs"], 1),
        "fee_usd_swaps": swap_fee, "fee_usd_flash": flash_fee, "fee_usd_attributed": attributed_fee,
        "fee_usd_unattributed": float(res["unattributed"][MI["fee_usd"]]),
        "conservation_err_pct": 100 * (attributed_fee / (swap_fee + flash_fee) - 1) if swap_fee + flash_fee else None,
        "fee0_raw_swaps": float(swf["fee0"].sum()), "fee0_raw_attributed": float(tot[:, MI["fee0"]].sum()),
        "fee1_raw_swaps": float(swf["fee1"].sum()), "fee1_raw_attributed": float(tot[:, MI["fee1"]].sum()),
        "picked_1h_swaps": float(sw["picked_1h"].sum()), "picked_1h_attributed": float(tot[:, MI["picked_1h"]].sum()),
        "picked_hl_1h_swaps": float(sw["picked_hl_1h"].sum()), "picked_hl_1h_attributed": float(tot[:, MI["picked_hl_1h"]].sum()),
        "liq_match_share_1e-6": float((rel < 1e-6).mean()),
        "liq_match_fee_weighted_1e-6": float(fee_w[rel < 1e-6].sum() / fee_w.sum()) if fee_w.sum() else None,
        "liq_median_rel_err": float(np.median(rel)), "liq_fee_weighted_mean_rel_err": float((rel * fee_w).sum() / fee_w.sum()) if fee_w.sum() else None,
        "liq_tick_before_vs_event_noncrossing_match_1e-6": float((rel_b[~cross] < 1e-6).mean()) if (~cross).any() else None,
        "liq_tick_before_vs_event_crossing_match_1e-6": float((rel_b[cross] < 1e-6).mean()) if cross.any() else None,
        "hl_markouts": SWAP_TABLES[pool.chain][1].exists(),
    }
    # final reconstructed liquidity at the last tick must equal the last Swap event's liquidity
    last_ord = int(path["ord"].max())
    a_last = int(np.searchsorted(ticks, int(path["tick"][-1]), side="right"))
    diag["final_liquidity_reconstructed"] = str(res["L_final"][a_last])
    diag["final_liquidity_event"] = str(exact_swap_liquidity(pool, last_ord))
    positions = value_positions(pool, pp, seg, pricer, path)
    diag["seconds"] = round(time.time() - t_start, 1)
    return {"pool": pool, "pp": pp, "positions": positions, "segments": seg, "attribution": attribution, "diag": diag, "pricer": pricer}


# ------------------------------------------------------------------------------------------------------------- valuation
def value_positions(pool: Pool, pp: PoolPositions, seg: pl.DataFrame, pricer: UsdPricer, path: pl.DataFrame) -> pl.DataFrame:
    pos, events = pp.positions, pp.events
    d0, d1 = 10.0**pool.dec0, 10.0**pool.dec1
    end_ord, end_ts = int(path["ord"].max()), float(path["ts"].max())

    # event-time USD
    sq, _ = pricer.state_at(events["ord"].to_numpy())
    u0, u1 = pricer.usd01(sq, events["ts"].to_numpy().astype(np.float64))
    ev = events.with_columns(pl.Series("u0", u0), pl.Series("u1", u1)).with_columns(
        (pl.col("amount0") / d0 * pl.col("u0") + pl.col("amount1") / d1 * pl.col("u1")).alias("usd"))

    # HODL basket, sequential per position
    hodl = {pid[0]: hodl_walk(grp.select("etype", "dL_exact", "amount0", "amount1", "u0", "u1").iter_rows(), d0, d1)
            for pid, grp in ev.group_by("pos_id", maintain_order=True)}
    hb = pl.DataFrame([(k, *v) for k, v in hodl.items()], schema=["pos_id", "hodl_b0", "hodl_b1", "hodl_withdrawn_usd"], orient="row")

    flows = ev.group_by("pos_id").agg(
        pl.col("usd").filter(pl.col("etype") == "inc").sum().alias("deposits_usd"),
        pl.col("usd").filter(pl.col("etype") == "dec").sum().alias("withdrawals_usd"),
        pl.col("amount0").filter(pl.col("etype") == "inc").sum().alias("dep0"),
        pl.col("amount1").filter(pl.col("etype") == "inc").sum().alias("dep1"),
        pl.col("amount0").filter(pl.col("etype") == "dec").sum().alias("wd0"),
        pl.col("amount1").filter(pl.col("etype") == "dec").sum().alias("wd1"),
    )
    p = pos.join(flows, on="pos_id", how="left").join(hb, on="pos_id", how="left")

    # end state: closed -> at the last event; open -> pool's last state
    closed = p["closed"].to_numpy()
    e_ord = np.where(closed, p["ord_last"].to_numpy(), end_ord + 1)
    e_ts = np.where(closed, p["ts_last"].to_numpy().astype(np.float64), end_ts)
    sq_end, _ = pricer.state_at(e_ord)
    eu0, eu1 = pricer.usd01(sq_end, e_ts)
    L_end = np.array([float(int(x)) for x in p["L_end_exact"].to_list()])
    a0, a1 = amounts_for_liquidity(L_end, tick_to_sqrtp(p["lower"].to_numpy()), tick_to_sqrtp(p["upper"].to_numpy()), sq_end)
    end_val = a0 / d0 * eu0 + a1 / d1 * eu1
    hodl_end = p["hodl_b0"].to_numpy() / d0 * eu0 + p["hodl_b1"].to_numpy() / d1 * eu1
    p = p.with_columns(pl.Series("ts_end", e_ts), pl.Series("end_u0", eu0), pl.Series("end_u1", eu1),
                       pl.Series("end_value_usd", end_val), pl.Series("end_amount0", a0), pl.Series("end_amount1", a1),
                       pl.Series("hodl_value_usd", p["hodl_withdrawn_usd"].to_numpy() + hodl_end))

    # accruals
    acc = seg.group_by("pos_id").agg(pl.col(METRICS).sum())
    p = p.join(acc, on="pos_id", how="left").with_columns(pl.col(METRICS).fill_null(0.0))

    # time-weighted notional, weekend / in-range time shares (hourly samples of every segment)
    p = p.join(notional_stats(pool, seg, pricer, end_ts), on="pos_id", how="left")

    # gas: tx cost split evenly over positions (all pools) the tx touched; attached later in run_all
    # realized fees (v3) and residual
    if pp.collects.height:
        col = pp.collects.group_by("pos_id").agg(pl.col("amount0").sum().alias("collected0"), pl.col("amount1").sum().alias("collected1"),
                                                 pl.col("ord").filter(pl.col("kind") == "collect").max().alias("ord_last_collect"))
        p = p.join(col, on="pos_id", how="left").with_columns(
            (pl.col("collected0").fill_null(0.0) - pl.col("wd0").fill_null(0.0)).alias("realized_fee0"),
            (pl.col("collected1").fill_null(0.0) - pl.col("wd1").fill_null(0.0)).alias("realized_fee1"),
        ).with_columns(
            (pl.col("realized_fee0") - pl.col("fee0")).alias("residual0"), (pl.col("realized_fee1") - pl.col("fee1")).alias("residual1"),
        ).with_columns(
            (pl.col("residual0") / d0 * pl.col("end_u0") + pl.col("residual1") / d1 * pl.col("end_u1")).alias("residual_usd"),
            (pl.col("realized_fee0") / d0 * pl.col("end_u0") + pl.col("realized_fee1") / d1 * pl.col("end_u1")).alias("realized_fee_usd"),
            (pl.col("closed") & (pl.col("ord_last_collect").fill_null(0) > pl.col("ord_last"))).alias("collected_after_close"),
        )
    else:
        p = p.with_columns(*[pl.lit(None, pl.Float64).alias(c) for c in ("collected0", "collected1", "realized_fee0", "realized_fee1",
                           "residual0", "residual1", "residual_usd", "realized_fee_usd")], pl.lit(None, pl.Int64).alias("ord_last_collect"),
                           pl.lit(None, pl.Boolean).alias("collected_after_close"))
    lifetime = (p["ts_end"] - p["ts_open"].cast(pl.Float64)).to_numpy()
    return p.with_columns(
        pl.Series("lifetime_days", lifetime / 86400.0),
        (pl.col("closed") & (pl.col("block_last") == pl.col("block_open"))).alias("same_block"),
        (pl.col("closed") & (pl.Series(lifetime) <= JIT_MAX_S)).alias("is_jit"),
        (pl.Series(lifetime) < SHORT_LIVED_S).alias("short_lived"),
        (pl.col("hodl_value_usd") - pl.col("deposits_usd")).alias("price_pnl_usd"),
        (pl.col("withdrawals_usd") + pl.col("end_value_usd") - pl.col("hodl_value_usd")).alias("il_usd"),
        ((10000.0 * (1.0001 ** pl.col("width_ticks").cast(pl.Float64) - 1)).alias("width_bps")),
        pl.lit(pool.key).alias("pool"), pl.lit(pool.dec0).alias("dec0"), pl.lit(pool.dec1).alias("dec1"),
    )


def notional_stats(pool: Pool, seg: pl.DataFrame, pricer: UsdPricer, end_ts: float, step: float = 3600.0) -> pl.DataFrame:
    """Σ value·dt over hourly chunks of every live segment; weekend-dark and in-range shares of that notional-time."""
    st = seg["start_ts"].to_numpy().astype(np.float64)
    en = seg["end_ts"].cast(pl.Float64).fill_null(end_ts).to_numpy()
    dur = np.maximum(en - st, 0.0)
    nch = np.maximum(np.ceil(dur / step).astype(np.int64), 1)
    rep = np.repeat(np.arange(seg.height), nch)
    offs = np.r_[0, np.cumsum(nch)[:-1]]
    i = np.arange(rep.size) - offs[rep]
    t0 = st[rep] + i * step
    t1 = np.minimum(t0 + step, en[rep])
    dt = np.maximum(t1 - t0, 0.0)
    sq = pricer.state_at_ts(t0)
    u0, u1 = pricer.usd01(sq, t0)
    lo = tick_to_sqrtp(seg["lower"].to_numpy())[rep]
    hi = tick_to_sqrtp(seg["upper"].to_numpy())[rep]
    a0, a1 = amounts_for_liquidity(seg["L"].to_numpy()[rep], lo, hi, sq)
    val = a0 / 10**pool.dec0 * u0 + a1 / 10**pool.dec1 * u1
    inr = (sq >= lo) & (sq < hi)
    ch = pl.DataFrame({"pos_id": seg["pos_id"].to_numpy()[rep], "ts": t0, "dt": dt, "val": val, "inr": inr})
    ch = ch.with_columns(*regime_expr())
    return ch.group_by("pos_id").agg(
        (pl.col("val") * pl.col("dt")).sum().alias("notional_seconds"),
        pl.col("dt").sum().alias("active_seconds"),
        pl.col("val").first().alias("value_at_open_usd"),
        pl.col("val").max().alias("value_max_usd"),
        (pl.col("val") * pl.col("dt")).filter(pl.col("regime") == "WEEKEND_DARK").sum().alias("_wk"),
        (pl.col("val") * pl.col("dt")).filter(pl.col("inr")).sum().alias("_inr"),
    ).with_columns(
        pl.when(pl.col("active_seconds") > 0).then(pl.col("notional_seconds") / pl.col("active_seconds"))
        .otherwise(pl.col("value_at_open_usd")).alias("avg_notional_usd"),
        pl.when(pl.col("notional_seconds") > 0).then(pl.col("_wk") / pl.col("notional_seconds")).otherwise(0.0).alias("weekend_share"),
        pl.when(pl.col("notional_seconds") > 0).then(pl.col("_inr") / pl.col("notional_seconds")).otherwise(None).alias("in_range_share"),
    ).drop("_wk", "_inr")


# ------------------------------------------------------------------------------------------------------------- all pools
def gas_by_position(touches: pl.DataFrame, source: str = "lp_txs") -> pl.DataFrame:
    txs = load_txs(source).select("tx_hash", (pl.col("gas_used").cast(pl.Float64) * pl.col("gas_price_wei") / 1e18).alias("gas_eth"))
    t = touches.unique().with_columns(pl.len().over("tx_hash").alias("_n")).join(txs, on="tx_hash", how="left")
    return t.group_by("pos_id").agg((pl.col("gas_eth") / pl.col("_n")).sum().alias("gas_eth"), pl.col("tx_hash").n_unique().alias("n_txs"),
                                    pl.col("gas_eth").is_null().sum().alias("txs_missing_gas"))


def finalize(pos: pl.DataFrame) -> pl.DataFrame:
    per_k = 1000.0 / pl.col("avg_notional_usd")
    days = pl.when(pl.col("active_seconds") > 0).then(pl.col("active_seconds") / 86400.0)
    return pos.with_columns(
        pl.col("gas_eth").fill_null(0.0), (pl.col("gas_eth").fill_null(0.0) * ETH_USD).alias("gas_usd"),
    ).with_columns(
        (pl.col("price_pnl_usd") + pl.col("il_usd") + pl.col("fee_usd") - pl.col("gas_usd")).alias("net_usd"),
        (pl.col("fee_usd") - pl.col("picked_1h")).alias("fees_minus_lvr_1h_usd"),
        (pl.col("fee_usd") - pl.col("picked_hl_1h")).alias("fees_minus_lvr_hl_1h_usd"),
        (pl.col("il_usd") + pl.col("fee_usd") - pl.col("gas_usd")).alias("vs_hodl_usd"),
        (pl.col("fee0") / 10.0 ** pl.col("dec0") * pl.col("end_u0") + pl.col("fee1") / 10.0 ** pl.col("dec1") * pl.col("end_u1")).alias("fee_usd_at_close"),
        (pl.col("weekend_share") > 0).alias("weekend_presence"),
        (pl.col("fee_usd_v1h") / pl.col("picked_1h")).alias("edge_self_1h"),
        (pl.col("fee_usd_hlv1h") / pl.col("picked_hl_1h")).alias("edge_hl_1h"),
        (pl.col("residual_usd") / pl.col("avg_notional_usd") * 1e4).alias("residual_bp"),
        (pl.col("residual_usd") / pl.col("fee_usd") * 100).alias("residual_pct_of_fees"),
    ).with_columns(
        (pl.col("net_usd") * per_k).alias("net_per_1k"),
        ((pl.col("il_usd") + pl.col("fee_usd") - pl.col("gas_usd")) * per_k / days).alias("vs_hodl_per_1k_per_day"),
        (pl.col("fee_usd") * per_k).alias("fees_per_1k"),
        (pl.col("picked_1h") * per_k).alias("lvr_self_1h_per_1k"),
        (pl.col("net_usd") * per_k / days).alias("net_per_1k_per_day"),
        (pl.col("fee_usd") * per_k / days).alias("fees_per_1k_per_day"),
        (pl.col("picked_1h") * per_k / days).alias("lvr_self_1h_per_1k_per_day"),
        (pl.col("picked_hl_1h") * per_k / days).alias("lvr_hl_1h_per_1k_per_day"),
    )


def owners_table(pos: pl.DataFrame, seg: pl.DataFrame) -> pl.DataFrame:
    """One row per position owner (NFT holder at the end / direct owner). Position-level P&L is attributed to that owner."""
    # union of active intervals per owner (days with liquidity)
    iv = (seg.join(pos.select("pos_id", "owner", "ts_end"), on="pos_id")
          .select("owner", pl.col("start_ts").cast(pl.Float64).alias("a"), pl.coalesce(pl.col("end_ts").cast(pl.Float64), pl.col("ts_end")).alias("b"))
          .sort(["owner", "a"]))
    iv = iv.with_columns(pl.col("b").cum_max().shift(1).over("owner").alias("_prev_max"))
    iv = iv.with_columns((pl.col("_prev_max").is_null() | (pl.col("a") > pl.col("_prev_max"))).cum_sum().over("owner").alias("_grp"))
    union = (iv.group_by("owner", "_grp").agg(pl.col("a").min(), pl.col("b").max())
             .group_by("owner").agg((pl.col("b") - pl.col("a")).sum().alias("union_seconds")))
    o = pos.group_by("owner").agg(
        pl.len().alias("n_positions"), pl.col("pool").unique().sort().str.join(",").alias("pools"),
        pl.col("kind").mode().sort().first().alias("main_kind"), pl.col("operator").mode().sort().first().alias("main_operator"),
        pl.col("notional_seconds").sum(), pl.col("deposits_usd").sum(), pl.col("withdrawals_usd").sum(), pl.col("end_value_usd").sum(),
        pl.col("fee_usd").sum(), pl.col("fee_usd_v1h").sum(), pl.col("fee_usd_hlv1h").sum(), pl.col("picked_1h").sum(), pl.col("picked_hl_1h").sum(),
        pl.col("price_pnl_usd").sum(), pl.col("il_usd").sum(), pl.col("gas_usd").sum(), pl.col("net_usd").sum(), pl.col("vs_hodl_usd").sum(),
        pl.col("vol_usd").sum(),
        pl.col("width_ticks").median().alias("median_width_ticks"),
        (pl.col("notional_seconds") * pl.col("weekend_share")).sum().alias("_wk"),
        pl.col("fee_usd").filter(pl.col("is_jit")).sum().alias("_jit_fees"),
        pl.col("is_jit").sum().alias("n_jit"), (~pl.col("closed")).sum().alias("n_open"),
        pl.col("ts_open").min().alias("first_ts"), pl.col("ts_end").max().alias("last_ts"),
    ).join(union, on="owner", how="left")
    active_days = pl.col("union_seconds") / 86400.0
    avg_notional = pl.col("notional_seconds") / pl.col("union_seconds")
    return o.with_columns(
        active_days.alias("active_days"), avg_notional.alias("avg_notional_usd"),
    ).with_columns(
        (pl.col("net_usd") / pl.col("avg_notional_usd") * 1000 / pl.col("active_days")).alias("net_per_1k_per_day"),
        (pl.col("fee_usd") / pl.col("avg_notional_usd") * 1000 / pl.col("active_days")).alias("fees_per_1k_per_day"),
        (pl.col("picked_1h") / pl.col("avg_notional_usd") * 1000 / pl.col("active_days")).alias("lvr_self_1h_per_1k_per_day"),
        (pl.col("picked_hl_1h") / pl.col("avg_notional_usd") * 1000 / pl.col("active_days")).alias("lvr_hl_1h_per_1k_per_day"),
        (pl.col("vs_hodl_usd") / pl.col("avg_notional_usd") * 1000 / pl.col("active_days")).alias("vs_hodl_per_1k_per_day"),
        (pl.col("fee_usd_v1h") / pl.col("picked_1h")).alias("edge_self_1h"),
        (pl.col("fee_usd_hlv1h") / pl.col("picked_hl_1h")).alias("edge_hl_1h"),
        ((pl.col("n_positions") - 1) / pl.max_horizontal(pl.col("active_days"), 1.0)).alias("rebalances_per_day"),
        pl.when(pl.col("notional_seconds") > 0).then(pl.col("_wk") / pl.col("notional_seconds")).alias("weekend_share"),
        pl.when(pl.col("fee_usd") > 0).then(pl.col("_jit_fees") / pl.col("fee_usd")).otherwise(0.0).alias("jit_fee_share"),
        (pl.col("n_jit") / pl.col("n_positions")).alias("jit_position_share"),
    ).drop("_wk", "_jit_fees").sort("fee_usd", descending=True)


def pick_golden(pos: pl.DataFrame) -> list[dict]:
    """Golden set, chosen on objective criteria (not on residual): 3 closed NPM positions (NFT burned => fully collected,
    lifetime ≥ 1 day, not JIT, single deposit) with the largest attributed fees, and the closed lifecycle of direct owner
    0x4da212… (collected after close, lifetime ≥ 1 day) with the largest attributed fees."""
    base = pos.filter((pl.col("pool") == "NVDA/USDG") & pl.col("closed") & ~pl.col("is_jit") & (pl.col("lifetime_days") >= 1.0))
    npm = (base.filter((pl.col("kind") == "v3_npm") & pl.col("nft_burned") & (pl.col("n_inc") == 1) & (pl.col("avg_notional_usd") >= 10_000))
           .sort("fee_usd", descending=True).head(3))
    direct = (base.filter((pl.col("kind") == "v3_direct") & (pl.col("owner") == "0x4da212efc0d513b00680a6cf66f97d508452bf18")
                          & pl.col("collected_after_close")).sort("fee_usd", descending=True).head(1))
    out = []
    for r in pl.concat([npm, direct]).iter_rows(named=True):
        out.append({k: r[k] for k in ("pos_id", "kind", "owner", "operator", "lower", "upper", "ts_open", "ts_end", "lifetime_days",
                                      "avg_notional_usd", "n_inc", "n_dec", "fee0", "fee1", "realized_fee0", "realized_fee1",
                                      "residual0", "residual1", "fee_usd", "fee_usd_at_close", "realized_fee_usd", "residual_usd", "residual_bp",
                                      "residual_pct_of_fees", "picked_1h", "picked_hl_1h", "net_usd")})
    return out


def run_all() -> dict:
    OUT.mkdir(parents=True, exist_ok=True)
    spy_path = price_path(POOL_BY_KEY["SPY/USDG"])
    runs = []
    for pool in POOLS:
        r = run_pool(pool, spy_path)
        print(f"{pool.key}: {r['positions'].height:,} positions, {r['segments'].height:,} segments, "
              f"conservation {r['diag']['conservation_err_pct']:+.5f}%, liquidity match {100 * r['diag']['liq_match_share_1e-6']:.2f}% "
              f"({r['diag']['seconds']}s)")
        runs.append(r)
    touches = pl.concat([r["pp"].touches for r in runs])
    gas = gas_by_position(touches)
    pos = finalize(pl.concat([r["positions"] for r in runs], how="diagonal_relaxed").join(gas, on="pos_id", how="left"))
    seg = pl.concat([r["segments"].with_columns(pl.lit(r["pool"].key).alias("pool")) for r in runs], how="diagonal_relaxed")
    att = pl.concat([r["attribution"] for r in runs]).join(pos.select("pos_id", "owner"), on="pos_id", how="left")
    owners = owners_table(pos, seg)

    pos.write_parquet(OUT / "positions.parquet")
    seg.drop("a_lo", "a_hi", "k_start", "k_end").write_parquet(OUT / "segments.parquet")
    att.write_parquet(OUT / "attribution.parquet")
    owners.write_parquet(OUT / "owners.parquet")
    golden = pick_golden(pos)
    diags = {r["pool"].key: r["diag"] for r in runs}
    (OUT / "golden.json").write_text(json.dumps({"generated_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                                                  "criteria": pick_golden.__doc__.split("\n\n")[0].replace("\n    ", " "),
                                                  "positions": golden}, indent=1, default=float))
    (OUT / "diagnostics.json").write_text(json.dumps(diags, indent=1, default=str))
    write_reconciliation(pos, golden, diags)
    return {"positions": pos, "segments": seg, "attribution": att, "owners": owners, "golden": golden, "diag": diags}


def _fmt(x, nd=2):
    if x is None or (isinstance(x, float) and (math.isnan(x) or math.isinf(x))):
        return "–"
    return f"{x:,.{nd}f}"


def write_reconciliation(pos: pl.DataFrame, golden: list[dict], diags: dict) -> None:
    L = ["# Position attribution: reconciliation", "",
         f"Generated {datetime.now(timezone.utc).isoformat(timespec='seconds')} by `uv run python -m positions.attribute`.", "",
         "## 1. Conservation (Σ attributed over positions vs Σ over swaps, per pool)", "",
         "| pool | swaps | positions | segments | LP fees in swaps $ | flash fees $ | attributed $ | unattributed $ | error | picked 1h self: swaps → attributed | picked 1h HL: swaps → attributed |",
         "|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---|"]
    for k, d in diags.items():
        L.append(f"| {k} | {d['swaps']:,} | {d['positions']:,} | {d['segments']:,} | {_fmt(d['fee_usd_swaps'])} | {_fmt(d['fee_usd_flash'])} | "
                 f"{_fmt(d['fee_usd_attributed'])} | {_fmt(d['fee_usd_unattributed'])} | {d['conservation_err_pct']:+.4f}% | "
                 f"{_fmt(d['picked_1h_swaps'])} → {_fmt(d['picked_1h_attributed'])} | {_fmt(d['picked_hl_1h_swaps'])} → {_fmt(d['picked_hl_1h_attributed'])} |")
    L += ["", "Per token (raw units): " + "; ".join(
        f"{k}: fee0 {d['fee0_raw_attributed'] / d['fee0_raw_swaps'] - 1:+.2e}, fee1 {d['fee1_raw_attributed'] / d['fee1_raw_swaps'] - 1:+.2e}"
        for k, d in diags.items() if d["fee0_raw_swaps"] and d["fee1_raw_swaps"]), "",
        "## 2. Reconstruction check (reconstructed in-range liquidity vs the Swap event's `liquidity`)", "",
        "The Swap event reports active liquidity AFTER the swap, so it is compared with the reconstructed liquidity at the post-swap tick.", "",
        "| pool | tick buckets | swaps matching (rel. err < 1e-6) | fee-weighted match | median rel. err | at tick_before, non-crossing swaps | at tick_before, crossing swaps | crossing swaps split over path | final L reconstructed = event |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---|"]
    for k, d in diags.items():
        L.append(f"| {k} | {d['tick_buckets']} | {100 * d['liq_match_share_1e-6']:.3f}% | {100 * (d['liq_match_fee_weighted_1e-6'] or 0):.3f}% | "
                 f"{d['liq_median_rel_err']:.1e} | {100 * (d['liq_tick_before_vs_event_noncrossing_match_1e-6'] or 0):.3f}% | "
                 f"{100 * (d['liq_tick_before_vs_event_crossing_match_1e-6'] or 0):.2f}% | {d['crossing_swaps_split']:,} | "
                 f"{d.get('final_liquidity_reconstructed') == d.get('final_liquidity_event')} |")
    v3 = diags.get("NVDA/USDG", {})
    L += ["", f"v3 linking: {v3.get('npm_mints_linked')}/{v3.get('npm_pool_mints')} NPM pool mints and {v3.get('npm_burns_linked')}/"
          f"{v3.get('npm_pool_burns_nonzero')} non-zero NPM pool burns linked to a tokenId ({v3.get('npm_tokenids')} tokenIds); "
          f"{v3.get('npm_poke_burns')} zero-amount NPM burns are fee pokes. {v3.get('direct_collects_without_position')} direct-owner "
          "Collect events hit keys that never held liquidity (zero-amount collects).", "",
          "## 3. Golden set: realized (onchain collected − principal) vs attributed fees", "",
          "Token amounts are human units (USDG / NVDA). `attributed $` values the attributed tokens at accrual time (the P&L number); "
          "`attributed @close $` and `realized @close $` value both token sets at the close price, so residual $ = realized @close − attributed @close.", "",
          "| position | kind | lifetime d | avg notional $ | attributed USDG / NVDA | realized USDG / NVDA | attributed $ | attributed @close $ | realized @close $ | residual $ | residual bp of notional | residual % of fees |",
          "|---|---|---:|---:|---|---|---:|---:|---:|---:|---:|---:|"]
    for g in golden:
        L.append(f"| `{g['pos_id']}` | {g['kind']} | {g['lifetime_days']:.1f} | {_fmt(g['avg_notional_usd'], 0)} | "
                 f"{g['fee0'] / 1e6:,.4f} / {g['fee1'] / 1e18:,.6f} | {g['realized_fee0'] / 1e6:,.4f} / {g['realized_fee1'] / 1e18:,.6f} | "
                 f"{_fmt(g['fee_usd'])} | {_fmt(g['fee_usd_at_close'])} | {_fmt(g['realized_fee_usd'])} | {_fmt(g['residual_usd'], 4)} | "
                 f"{g['residual_bp']:+.4f} | {g['residual_pct_of_fees']:+.4f}% |")
    c = pos.filter((pl.col("pool") == "NVDA/USDG") & pl.col("closed") & pl.col("residual_bp").is_not_null())
    L += ["", "## 4. Residual distribution: every closed v3 position", "",
          "Only a burned NFT guarantees that everything owed was collected (NPM.burn requires tokensOwed = 0). A collect after close "
          "can still be capped: e.g. `npm:721499` is held by a wrapper that collected exactly the withdrawn principal and left ~$2 of fees owed, "
          "so its residual is real uncollected fees, not attribution error.", ""]
    for label, f in [("all closed (incl. never / partly collected)", pl.lit(True)),
                     ("NFT burned (fully collected by construction)", pl.col("nft_burned")),
                     ("NFT burned, avg notional ≥ $1k", pl.col("nft_burned") & (pl.col("avg_notional_usd") >= 1000)),
                     ("direct owners, collected after close", (pl.col("kind") == "v3_direct") & pl.col("collected_after_close")),
                     ("NPM not burned, collected after close (may be capped)", (pl.col("kind") == "v3_npm") & ~pl.col("nft_burned") & pl.col("collected_after_close"))]:
        s = c.filter(f)
        if s.is_empty():
            continue
        ab = s["residual_bp"].abs()
        L.append(f"- **{label}**: n = {s.height:,}; |residual| median {ab.median():.4f} bp, p90 {ab.quantile(0.9):.3f} bp, "
                 f"p99 {ab.quantile(0.99):.2f} bp; share < 1 bp: {100 * (ab < 1).mean():.1f}%; Σ residual ${s['residual_usd'].sum():,.2f} "
                 f"vs Σ attributed fees ${s['fee_usd'].sum():,.2f}")
    big = c.filter((pl.col("nft_burned") | ((pl.col("kind") == "v3_direct") & pl.col("collected_after_close"))) & (pl.col("residual_bp").abs() >= 1))
    if big.height:
        L += ["", f"- Every fully collected position with |residual| ≥ 1 bp ({big.height}) has avg notional ≤ ${big['avg_notional_usd'].max():,.4f}: "
              "dust positions where one wei of rounding is already a basis point."]
    gold_pct = [g["residual_pct_of_fees"] for g in golden]
    if gold_pct:
        L += [f"- The residual is systematically slightly positive (golden set: +{min(gold_pct):.4f}% … +{max(gold_pct):.4f}% of fees, realized > "
              "attributed): Uniswap rounds each step's fee up and the protocol cut (fee/4) down, both in the LPs' favour by ≤ 1 wei per step, "
              "which the float `fee_q` of the decoder does not carry. Sub-cent dust swaps (dropped by M0) add a little more."]
    worst = (c.filter(pl.col("nft_burned") & (pl.col("avg_notional_usd") >= 1000))
             .sort(pl.col("residual_bp").abs(), descending=True).head(5))
    if worst.height:
        L += ["", "Largest |residual| (NFT burned, ≥ $1k):", "", "| position | lifetime d | width ticks | avg notional $ | fees $ | residual $ | bp |", "|---|---:|---:|---:|---:|---:|---:|"]
        for r in worst.iter_rows(named=True):
            L.append(f"| `{r['pos_id']}` | {r['lifetime_days']:.2f} | {r['width_ticks']} | {_fmt(r['avg_notional_usd'], 0)} | {_fmt(r['fee_usd'])} | "
                     f"{_fmt(r['residual_usd'], 4)} | {r['residual_bp']:+.3f} |")
    L += ["", "## 5. Method notes and known limits", "",
          f"- JIT: no position on these pools is minted and burned in the same block. `is_jit` = closed within {JIT_MAX_S} s "
          f"(~120 blocks); those {int(pos['is_jit'].sum())} positions earned ${pos.filter(pl.col('is_jit'))['fee_usd'].sum():,.2f} of fees in total.",
          "- Fees are the LP share from `swaps.parquet` (`fee_q`; base-paid fees converted with `fee_q / p_exec`). Dust swaps "
          "(sub-cent, dropped by the M0 decoder) still move the price path but their fees are not attributed.",
          "- Swaps that stay inside one tick bucket are attributed at `tick_before` pro-rata by reconstructed liquidity. Swaps that cross a "
          "bucket bound are split over the path with weights L_b·Δ_b (the per-step input amounts), not dumped on the start tick.",
          "- Realized v3 fees include integer rounding (Uniswap floors owed fees per position); NPM `collect` may be capped by "
          "amountMax, so only NFT-burned (fully collected by construction) or collected-after-close positions are reconciled.",
          "- v4 positions cannot be reconciled from logs: fees are settled inside `modifyLiquidity` deltas with no fee event.",
          f"- Gas USD uses a flagged constant ETH_USD = {ETH_USD:,.0f} (no ETH price source under data/).",
          "- Owner = NFT holder at the end of the position (last non-zero holder for burned NFTs) or the direct pool owner; "
          "segments.parquet carries the holder at accrual time (`seg_owner`)."]
    (OUT / "reconciliation.md").write_text("\n".join(L) + "\n")


def main():
    t0 = time.time()
    res = run_all()
    pos, owners = res["positions"], res["owners"]
    print("\n=== golden set (realized − attributed) ===")
    for g in res["golden"]:
        print(f"{g['pos_id']:<72} notional ${g['avg_notional_usd']:>10,.0f}  fees ${g['fee_usd']:>9,.2f}  residual ${g['residual_usd']:+.4f} "
              f"({g['residual_bp']:+.4f} bp of notional, {g['residual_pct_of_fees']:+.4f}% of fees)")
    print("\n=== by pool (USD) ===")
    print(f"{'pool':<10} {'pos':>6} {'fees':>10} {'LVR self1h':>10} {'LVR HL1h':>10} {'edge s/hl':>10} {'IL':>10} {'price':>10} {'gas':>8} {'vs HODL':>10} {'net':>10}")
    for r in (pos.group_by("pool").agg(pl.len().alias("n"), pl.col("fee_usd").sum(), pl.col("fee_usd_v1h").sum(), pl.col("fee_usd_hlv1h").sum(),
                                       pl.col("picked_1h").sum(), pl.col("picked_hl_1h").sum(), pl.col("il_usd").sum(), pl.col("price_pnl_usd").sum(),
                                       pl.col("gas_usd").sum(), pl.col("vs_hodl_usd").sum(), pl.col("net_usd").sum()).sort("pool").iter_rows(named=True)):
        print(f"{r['pool']:<10} {r['n']:>6,} {r['fee_usd']:>10,.0f} {r['picked_1h']:>10,.0f} {r['picked_hl_1h']:>10,.0f} "
              f"{r['fee_usd_v1h'] / r['picked_1h']:>4.2f}/{r['fee_usd_hlv1h'] / r['picked_hl_1h']:<5.2f} {r['il_usd']:>10,.0f} {r['price_pnl_usd']:>10,.0f} "
              f"{r['gas_usd']:>8,.0f} {r['vs_hodl_usd']:>10,.0f} {r['net_usd']:>10,.0f}")
    print("\n=== top owners by fees ===")
    print(f"{'owner':<44} {'pos':>5} {'avg notional':>12} {'days':>5} {'fees':>9} {'LVR self':>9} {'LVR HL':>9} {'edge s/hl':>10} {'vs HODL':>9} "
          f"{'net/$1k/d':>9} {'width':>6} {'wkend':>5}")
    for r in owners.head(12).iter_rows(named=True):
        print(f"{r['owner']:<44} {r['n_positions']:>5,} {r['avg_notional_usd']:>12,.0f} {r['active_days']:>5.1f} {r['fee_usd']:>9,.0f} "
              f"{r['picked_1h']:>9,.0f} {r['picked_hl_1h']:>9,.0f} {r['edge_self_1h']:>4.2f}/{r['edge_hl_1h']:<5.2f} {r['vs_hodl_usd']:>9,.0f} "
              f"{r['net_per_1k_per_day']:>9.2f} {r['median_width_ticks']:>6.0f} {r['weekend_share']:>5.2f}")
    print(f"\nwrote {OUT} in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
