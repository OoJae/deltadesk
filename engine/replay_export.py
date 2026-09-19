"""Replay inputs for the desk agent's replay CLI (agent/scripts/replay.ts). Read-only over data/ and engine code.

For each historical window it writes data/replay/input/<id>.json with, per minute:
    pool mid / tick / active liquidity   latest swap ≤ t in data/study/m0/swaps.parquet (mid_after, tick, liquidity)
    HL reference                          markout.hl_ref's merged candle series (5m from Sep 1, 15m from Jul 28, 1h from
                                          Jul 1), a candle's close stamped at its END boundary: never a look-ahead
    basis k                               data/study/m1/hl_ref/k_sessions.parquet, the most recent COMPLETED regular session
                                          strictly before t (markout.hl_ref.k_at: the M1 no-look-ahead rule)
    Chainlink                             latest AnswerUpdated ≤ t of the pool's stock aggregator (data/raw/chainlink)
and, per window, the pool-wide LP picked-off during the closed window (calendar WEEKEND_DARK or HOLIDAY):
    Σ picked_hl_1h (valid only, data/study/m1/hl_ref/hl_markouts.parquet) and Σ LP fees over the closed-window swaps,
    plus a CONTROL LANE: $1k in a ±100-tick straddle kept centred on the pool price (always in range), which takes each
    swap pro rata to its share of the active liquidity at tick_before (the M1 attribution rule, positions/attribute.py).

    cd engine && uv run python replay_export.py
"""

from __future__ import annotations

import json
import math
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
import polars as pl

from markout.calendar import regime_expr
from markout.hl_ref import INTERVALS, asof_lookup, k_at, load_candles, merge_sources
from markout.pools import DATA

ET = ZoneInfo("America/New_York")
OUT = DATA / "replay" / "input"
SWAPS = DATA / "study" / "m0" / "swaps.parquet"
HL_MARKOUTS = DATA / "study" / "m1" / "hl_ref" / "hl_markouts.parquet"
K_SESSIONS = DATA / "study" / "m1" / "hl_ref" / "k_sessions.parquet"
CHAINLINK = DATA / "raw" / "chainlink"
CADENCE_S = 60
WARMUP_S = 3600  # rows before the window start, so the gate machine's startup dwell is over when the window opens
CONTROL_USD = 1_000.0
CONTROL_HALF_WIDTH = 100  # ticks: lane A's straddle half-width (STRATEGY_DEFAULTS.halfWidthTicks)
CLOSED = ("WEEKEND_DARK", "HOLIDAY")

POOL_META = {
    # HL coin, Chainlink aggregator (AnswerUpdated), base is token0?, dec0, dec1
    "NVDA/USDG": {"coin": "xyz:NVDA", "aggregator": "0xc9d16e4f2569b9e3ea0468fd85844953713dc2a2", "base_is_0": False, "dec0": 6, "dec1": 18},
    "SPY/USDG": {"coin": "xyz:SP500", "aggregator": "0x78bcb218fa04b9b3a278ebc865ed320bf8defbac", "base_is_0": True, "dec0": 18, "dec1": 6},
}

WINDOWS = [
    {
        "id": "weekend-2026-09-11",
        "title": "Weekend: Fri Sep 11 16:00 ET → Mon Sep 14 09:45 ET",
        "pool": "NVDA/USDG",
        "start": datetime(2026, 9, 11, 16, 0, tzinfo=ET),
        "end": datetime(2026, 9, 14, 9, 45, tzinfo=ET),
        "note": "An ordinary weekend: Chainlink freezes Friday afternoon, the pool and Hyperliquid keep trading.",
    },
    {
        "id": "labor-day-2026-09-04",
        "title": "Labor Day: Fri Sep 4 16:00 ET → Tue Sep 8 10:00 ET",
        "pool": "NVDA/USDG",
        "start": datetime(2026, 9, 4, 16, 0, tzinfo=ET),
        "end": datetime(2026, 9, 8, 10, 0, tzinfo=ET),
        "note": "A holiday weekend: Mon Sep 7 is an NYSE holiday, so the session Sun 20:00 → Mon 20:00 ET is HOLIDAY.",
    },
    {
        "id": "spy-premium-2026-08-29",
        "title": "SPY premium: Sat Aug 29 00:00 ET → Mon Aug 31 16:00 ET",
        "pool": "SPY/USDG",
        "start": datetime(2026, 8, 29, 0, 0, tzinfo=ET),
        "end": datetime(2026, 8, 31, 16, 0, tzinfo=ET),
        "note": "The SPY/USDG pool drifted above fair value over the weekend. WRAPPER-PREMIUM is a stub in M2 (not armed).",
    },
]


def iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, ZoneInfo("UTC")).strftime("%Y-%m-%dT%H:%M:%SZ")


def fnum(x, digits: int | None = None):
    if x is None:
        return None
    x = float(x)
    if not math.isfinite(x):
        return None
    return round(x, digits) if digits is not None else x


def load_swaps(pool: str, t0: float, t1: float) -> pl.DataFrame:
    """One pool's swaps in [t0, t1], chain order. `regime` is recomputed with the shared calendar (markout/calendar.py):
    the M0 table's own column predates the session-model fix (it labels Mon Sep 7 20:00-24:00 ET HOLIDAY)."""
    cols = ["block", "tx_index", "log_index", "ts", "mid_after", "tick", "tick_before", "liquidity", "fee_usd", "vol_usd"]
    return (pl.scan_parquet(SWAPS).filter((pl.col("pool") == pool) & pl.col("ts").is_between(t0, t1)).select(cols)
            .collect().sort(["block", "tx_index", "log_index"]).with_columns(regime_expr("ts")[0]))


def hl_reference(coin: str) -> pl.DataFrame:
    return merge_sources([load_candles(coin, iv) for iv in INTERVALS])


def chainlink_series(aggregator: str) -> pl.DataFrame:
    """AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt): price and updatedAt per update."""
    df = (pl.scan_parquet(sorted(CHAINLINK.glob("hs_*.parquet"))).filter(pl.col("address") == aggregator)
          .select("block", "log_index", "ts", "topic1", "data").collect().sort(["block", "log_index"]))
    rows = []
    for ts, t1, data in df.select("ts", "topic1", "data").iter_rows():
        ans = int(t1, 16)
        if ans >= 1 << 255:
            ans -= 1 << 256
        dec = 18 if ans > 10**15 else 8  # proxy decimals moved 18 → 8 on 2026-06-23 (ChainlinkFence reads them live)
        rows.append((float(ts), ans / 10**dec, int(data[2:66], 16), dec))
    return pl.DataFrame(rows, schema={"ts": pl.Float64, "price": pl.Float64, "updated_at": pl.Int64, "decimals": pl.Int64}, orient="row")


def per_minute(window: dict) -> tuple[list[dict], dict]:
    pool = window["pool"]
    meta = POOL_META[pool]
    t0, t1 = window["start"].timestamp() - WARMUP_S, window["end"].timestamp()
    grid = np.arange(t0, t1 + 1, CADENCE_S, dtype=np.float64)

    sw = load_swaps(pool, t0 - 6 * 3600, t1)
    state = (sw.select(pl.col("ts").alias("tq"), "mid_after", "tick", "liquidity", pl.col("ts").alias("swap_ts"))
             .unique("tq", keep="last", maintain_order=True).sort("tq"))
    q = pl.DataFrame({"tq": grid}).join_asof(state, on="tq", strategy="backward")

    ref = hl_reference(meta["coin"])
    hl = asof_lookup(ref, grid)

    sessions = pl.read_parquet(K_SESSIONS).filter(pl.col("pool") == pool).sort("close_ts")
    k = k_at(grid, sessions)

    cl = chainlink_series(meta["aggregator"]).select(pl.col("ts").alias("tq"), "price", "updated_at")
    clq = pl.DataFrame({"tq": grid}).join_asof(cl.sort("tq"), on="tq", strategy="backward")

    rows = []
    for i, t in enumerate(grid):
        r = q.row(i, named=True)
        h = hl.row(i, named=True)
        kr = k.row(i, named=True)
        c = clq.row(i, named=True)
        rows.append({
            "ts": int(t),
            "poolMid": fnum(r["mid_after"]),
            "poolTick": None if r["tick"] is None else int(r["tick"]),
            "poolLiquidity": fnum(r["liquidity"]),
            "lastSwapTs": fnum(r["swap_ts"], 3),
            "hl": fnum(h["px"]),
            "hlResS": fnum(h["res"]),
            "hlPointTs": fnum(h["pt_ts"], 3),
            "k": fnum(kr["k"]),
            "kSession": None if kr["k_session"] is None else str(kr["k_session"]),
            "kLookahead": bool(kr["k_lookahead"]),
            "chainlinkPrice": fnum(c["price"]),
            "chainlinkUpdatedAt": None if c["updated_at"] is None else int(c["updated_at"]),
        })
    coverage = {
        "hlResolutionsS": sorted({int(x) for x in hl["res"].drop_nulls().to_list()}),
        "swapsInWindow": int(sw.filter(pl.col("ts") >= window["start"].timestamp()).height),
        "chainlinkUpdatesInWindow": int(cl.filter(pl.col("tq").is_between(window["start"].timestamp(), t1)).height),
    }
    return rows, coverage


def control_lane_lvr(window: dict) -> dict | None:
    """Pool-wide picked-off and fees over the closed window, and a $1k ±100-tick control lane's pro-rata share."""
    pool = window["pool"]
    meta = POOL_META[pool]
    t0, t1 = window["start"].timestamp(), window["end"].timestamp()
    sw = load_swaps(pool, t0 - 3600, t1).with_columns(pl.col("liquidity").shift(1).alias("L_before"))
    sw = sw.filter(pl.col("ts").is_between(t0, t1) & pl.col("regime").is_in(list(CLOSED)))
    if sw.is_empty():
        return None
    hl = (pl.scan_parquet(HL_MARKOUTS).filter((pl.col("pool") == pool) & pl.col("ts").is_between(t0, t1))
          .select("block", "tx_index", "log_index", "picked_hl_1h", "valid_hl_1h", "P_pool_before").collect())
    sw = sw.join(hl, on=["block", "tx_index", "log_index"], how="left")
    n, n_valid = sw.height, int(sw["valid_hl_1h"].fill_null(False).sum())
    if n_valid < 0.9 * n:
        return {"derivable": False, "reason": f"only {n_valid}/{n} closed-window swaps have a valid HL 1 h markout"}

    tc = sw["tick_before"].to_numpy().astype(np.float64)
    mid = sw["P_pool_before"].fill_null(sw["mid_after"]).to_numpy()
    L = sw["L_before"].fill_null(sw["liquidity"]).to_numpy()
    sp = 1.0001 ** (tc / 2)
    sa = 1.0001 ** ((tc - CONTROL_HALF_WIDTH) / 2)
    sb = 1.0001 ** ((tc + CONTROL_HALF_WIDTH) / 2)
    a0 = (sb - sp) / (sp * sb)  # token0 per unit of liquidity (raw)
    a1 = sp - sa                # token1 per unit of liquidity (raw)
    if meta["base_is_0"]:       # token0 = stock, token1 = USDG
        usd_per_L = a0 / 10 ** meta["dec0"] * mid + a1 / 10 ** meta["dec1"]
    else:                       # token0 = USDG, token1 = stock
        usd_per_L = a0 / 10 ** meta["dec0"] + a1 / 10 ** meta["dec1"] * mid
    share = np.where((L > 0) & (usd_per_L > 0), (CONTROL_USD / usd_per_L) / L, 0.0)
    valid = sw["valid_hl_1h"].fill_null(False).to_numpy()
    picked = np.where(valid, sw["picked_hl_1h"].fill_null(0.0).to_numpy(), 0.0)
    fees = sw["fee_usd"].fill_null(0.0).to_numpy()
    fees_v = np.where(valid, fees, 0.0)
    c_picked, c_fees = float((share * picked).sum()), float((share * fees_v).sum())
    closed_ts = sw["ts"]
    hours = (float(closed_ts.max()) - float(closed_ts.min())) / 3600
    return {
        "derivable": True,
        "closedWindow": {"from": iso(float(closed_ts.min())), "to": iso(float(closed_ts.max())), "hours": round(hours, 2),
                         "regimes": sorted(set(sw["regime"].to_list()))},
        "swaps": n,
        "swapsWithValidHl1h": n_valid,
        "poolWide": {
            "volumeUsd": round(float(sw["vol_usd"].sum()), 2),
            "lpFeesUsd": round(float(fees_v.sum()), 2),
            "pickedOffHl1hUsd": round(float(picked.sum()), 2),
            "lpNetUsd": round(float(fees_v.sum() - picked.sum()), 2),
        },
        "controlLane": {
            "definition": f"${CONTROL_USD:,.0f} in a ±{CONTROL_HALF_WIDTH}-tick straddle kept centred on the pool price (always in range), "
                          "sharing each swap pro rata to its share of the active liquidity at tick_before (M1 attribution rule); "
                          "picked-off = HL-referenced 1 h markout (picked_hl_1h), valid markouts only",
            "pickedOffUsd": round(c_picked, 4),
            "feesUsd": round(c_fees, 4),
            "netUsd": round(c_fees - c_picked, 4),
            "medianShareOfActiveLiquidity": float(np.median(share[share > 0])) if (share > 0).any() else None,
        },
    }


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for w in WINDOWS:
        rows, coverage = per_minute(w)
        lvr = control_lane_lvr(w)
        doc = {
            "label": "REPLAY (historical data, not live)",
            "kind": "deltadesk-replay-input",
            "version": 1,
            "id": w["id"],
            "title": w["title"],
            "note": w["note"],
            "pool": w["pool"],
            "hlCoin": POOL_META[w["pool"]]["coin"],
            "window": {"startTs": int(w["start"].timestamp()), "endTs": int(w["end"].timestamp()),
                       "startUtc": iso(w["start"].timestamp()), "endUtc": iso(w["end"].timestamp())},
            "cadenceS": CADENCE_S,
            "warmupS": WARMUP_S,
            "sources": [
                "data/study/m0/swaps.parquet (pool mid_after / tick / liquidity, as of the latest swap ≤ t; Robinhood Chain 4663 swap logs)",
                "data/raw/hl_candles/xyz_*_{5m,15m,1h}.parquet via markout.hl_ref.merge_sources (Hyperliquid trade.xyz candle closes, stamped at candle end)",
                "data/study/m1/hl_ref/k_sessions.parquet via markout.hl_ref.k_at (basis k of the last completed regular session)",
                f"data/raw/chainlink AnswerUpdated of {POOL_META[w['pool']]['aggregator']} (Chainlink {w['pool'].split('/')[0]}/USD on 4663)",
                "data/study/m1/hl_ref/hl_markouts.parquet (picked_hl_1h, valid_hl_1h) for the closed-window LVR",
            ],
            "coverage": coverage,
            "lvr": lvr,
            "rows": rows,
        }
        path = OUT / f"{w['id']}.json"
        path.write_text(json.dumps(doc, separators=(",", ":")))
        head = f"{w['id']}: {len(rows)} rows, HL res {coverage['hlResolutionsS']}"
        if lvr and lvr.get("derivable"):
            c = lvr["controlLane"]
            head += f"; closed {lvr['closedWindow']['hours']} h, pool picked ${lvr['poolWide']['pickedOffHl1hUsd']:,.0f} vs fees ${lvr['poolWide']['lpFeesUsd']:,.0f}; control $1k: picked ${c['pickedOffUsd']:.2f}, fees ${c['feesUsd']:.2f}"
        print(head)


if __name__ == "__main__":
    main()
