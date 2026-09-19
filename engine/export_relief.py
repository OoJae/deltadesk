"""The landing page's "Engraved Book": the NVDA/USDG pool's real liquidity through the Sep 11–14 2026 weekend.

For one frame every 30 minutes from Fri 2026-09-11 16:00 ET to Mon 2026-09-14 09:45 ET it writes
web/public/relief/weekend-2026-09-11.json with:

    liquidity per tick bucket     Σ L of every position segment active at t (start_ts ≤ t < end_ts) that covers the
                                  bucket, from data/study/m1/positions/segments.parquet (NPM and direct v3 positions,
                                  rebuilt from Mint/Burn/Transfer logs). Buckets are 10 ticks (the pool's spacing), on
                                  one fixed grid that holds every frame's ±600-tick window around its pool tick.
    pool tick / mid / liquidity   the latest swap ≤ t (data/study/m0/swaps.parquet, Swap event fields)
    fair, gap, regime, gates,     the agent's replay, web/public/replays/weekend-2026-09-11.json (5-minute rows; the
    risk-adding, fence, lane      nearest row ≤ t)
    the lane's range              reconstructed from the replay's one planned action (the warm-up initial mint: a
                                  straddle of ±100 ticks centred on fair value, snapped outward to spacing 10) and
                                  checked against every row's inRange flag
    informed flow                 the closed-window swaps that took the most from LPs (picked_hl_1h > 0, valid HL 1 h
                                  markouts, data/study/m1/hl_ref/hl_markouts.parquet), a few per frame, plus the
                                  $1k always-in-range control lane's running picked-off and fees (replay_export's rule)

Prices ↔ ticks: token0 = USDG (6 dec), token1 = NVDA (18 dec); the mid is USDG per NVDA, so
tick = log_1.0001(NVDA_raw / USDG_raw) = log_1.0001(1e12 / mid). A higher tick is a LOWER NVDA price.

Sanity: at every frame, Σ L of the segments covering the pool tick is compared with the pool's own liquidity as the
latest Swap event logged it. With --rpc, three frames are also compared with liquidity() read by eth_call at that
swap's block on the archive RPC in $RH_ARCHIVE_RPC (the URL is never printed).

    cd engine && uv run python export_relief.py [--rpc]
"""

from __future__ import annotations

import json
import math
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
import polars as pl

from markout.calendar import regime_expr
from markout.pools import DATA

ROOT = Path(__file__).resolve().parents[1]
ET = ZoneInfo("America/New_York")
POOL = "NVDA/USDG"
POOL_ADDRESS = "0xd4eb21209c4d6093f80b5b84f5c45cc093ea14a3"
SEGMENTS = DATA / "study" / "m1" / "positions" / "segments.parquet"
SWAPS = DATA / "study" / "m0" / "swaps.parquet"
HL_MARKOUTS = DATA / "study" / "m1" / "hl_ref" / "hl_markouts.parquet"
REPLAY = ROOT / "web" / "public" / "replays" / "weekend-2026-09-11.json"
REPLAY_INPUT = DATA / "replay" / "input" / "weekend-2026-09-11.json"
OUT = ROOT / "web" / "public" / "relief" / "weekend-2026-09-11.json"

START = datetime(2026, 9, 11, 16, 0, tzinfo=ET)
END = datetime(2026, 9, 14, 9, 45, tzinfo=ET)
STEP_S = 1800
SPACING = 10
BUCKET = 10          # ticks per bucket (= spacing: liquidity is constant inside a bucket)
HALF_WINDOW = 600    # ticks around each frame's pool tick
LANE_HALF_WIDTH = 100
CONTROL_USD = 1_000.0
CONTROL_HALF_WIDTH = 100
CLOSED = ("WEEKEND_DARK", "HOLIDAY")
FLOW_PER_FRAME = 5   # strongest informed swaps kept per 30-minute frame
Q_MAX = 9999         # liquidity quantisation: 0..9999 of the window's peak bucket
DEC0, DEC1 = 6, 18
LOG_B = math.log(1.0001)
REGIMES = ["REGULAR", "EXTENDED", "OVERNIGHT", "WEEKEND_DARK", "HOLIDAY"]


def mid_to_tick(mid: float) -> int:
    """The greatest tick t with 1.0001^t ≤ raw (agent/src/units.ts priceToTick)."""
    raw = 10 ** (DEC1 - DEC0) / mid
    t = math.floor(math.log(raw) / LOG_B)
    if 1.0001 ** (t + 1) <= raw:
        t += 1
    elif 1.0001 ** t > raw:
        t -= 1
    return t


def tick_to_mid(tick: float) -> float:
    return 10 ** (DEC1 - DEC0) / 1.0001 ** tick


def floor_s(x: int, s: int = SPACING) -> int:
    return (x // s) * s


def ceil_s(x: int, s: int = SPACING) -> int:
    return -((-x) // s) * s


def et_label(ts: float) -> str:
    return datetime.fromtimestamp(ts, ET).strftime("%a %H:%M")


def frame_times() -> list[int]:
    t0, t1 = int(START.timestamp()), int(END.timestamp())
    ts = list(range(t0, t1 + 1, STEP_S))
    if ts[-1] != t1:
        ts.append(t1)
    return ts


def load_segments() -> dict[str, np.ndarray]:
    s = (pl.scan_parquet(SEGMENTS).filter(pl.col("pool") == POOL)
         .select("start_ts", "end_ts", "L", "lower", "upper").collect())
    far = np.iinfo(np.int64).max
    return {
        "start": s["start_ts"].to_numpy(),
        "end": s["end_ts"].fill_null(far).to_numpy(),
        "L": s["L"].to_numpy(),
        "lower": s["lower"].to_numpy(),
        "upper": s["upper"].to_numpy(),
    }


def load_swaps(t0: float, t1: float) -> pl.DataFrame:
    cols = ["block", "tx_index", "log_index", "ts", "mid_after", "tick", "tick_before", "liquidity", "fee_usd", "vol_usd"]
    return (pl.scan_parquet(SWAPS).filter((pl.col("pool") == POOL) & pl.col("ts").is_between(t0, t1)).select(cols)
            .collect().sort(["block", "tx_index", "log_index"]).with_columns(regime_expr("ts")[0]))


def replay_at(rows: list[dict], t: int) -> dict:
    """The nearest replay row at or before t."""
    best = rows[0]
    for r in rows:
        if r["ts"] <= t:
            best = r
        else:
            break
    return best


def lane_range(replay: dict) -> dict:
    """Lane A's only planned action in this window is the warm-up initial mint: a straddle on F (bands.ts planBands:
    snapRangeOutward(fTick − 100, fTick + 100, 10)). F = HL × k at that minute (the replay input's rows)."""
    mint = next(e for e in replay["events"] if e["kind"] == "action" and e.get("action") == "re-center")
    inp = json.loads(REPLAY_INPUT.read_text())
    row = max((r for r in inp["rows"] if r["ts"] <= mint["ts"]), key=lambda r: r["ts"])
    fair = row["hl"] * row["k"]
    f_tick = mid_to_tick(fair)
    lower, upper = floor_s(f_tick - LANE_HALF_WIDTH), ceil_s(f_tick + LANE_HALF_WIDTH)
    # Check the reconstruction against every replay row's inRange flag (pool tick = latest swap ≤ row ts).
    by_ts = {r["ts"]: r for r in inp["rows"]}
    agree = total = 0
    for r in replay["rows"]:
        src = by_ts.get(r["ts"])
        flag = r["lane"]["inRange"]
        if src is None or src["poolTick"] is None or flag is None:
            continue
        total += 1
        agree += int((lower <= src["poolTick"] < upper) == flag)
    return {"lower": lower, "upper": upper, "placedTs": int(mint["ts"]), "placedFair": round(fair, 4), "fairTick": f_tick,
            "inRangeAgreement": f"{agree}/{total}"}


def control_lane(sw: pl.DataFrame, frames: list[int]) -> tuple[list[int], list[int], pl.DataFrame]:
    """replay_export.control_lane_lvr, cumulated per frame: $1k in a ±100-tick straddle kept centred on the pool price,
    taking each closed-window swap pro rata to its share of the active liquidity at tick_before."""
    sw = sw.with_columns(pl.col("liquidity").shift(1).alias("L_before"))
    t0, t1 = frames[0], frames[-1]
    sw = sw.filter(pl.col("ts").is_between(t0, t1) & pl.col("regime").is_in(list(CLOSED)))
    hl = (pl.scan_parquet(HL_MARKOUTS).filter((pl.col("pool") == POOL) & pl.col("ts").is_between(t0, t1))
          .select("block", "tx_index", "log_index", "picked_hl_1h", "valid_hl_1h", "P_pool_before").collect())
    sw = sw.join(hl, on=["block", "tx_index", "log_index"], how="left")
    tc = sw["tick_before"].to_numpy().astype(np.float64)
    mid = sw["P_pool_before"].fill_null(sw["mid_after"]).to_numpy()
    L = sw["L_before"].fill_null(sw["liquidity"]).to_numpy()
    sp = 1.0001 ** (tc / 2)
    sa = 1.0001 ** ((tc - CONTROL_HALF_WIDTH) / 2)
    sb = 1.0001 ** ((tc + CONTROL_HALF_WIDTH) / 2)
    a0 = (sb - sp) / (sp * sb)
    a1 = sp - sa
    usd_per_L = a0 / 10 ** DEC0 + a1 / 10 ** DEC1 * mid
    share = np.where((L > 0) & (usd_per_L > 0), (CONTROL_USD / usd_per_L) / L, 0.0)
    valid = sw["valid_hl_1h"].fill_null(False).to_numpy()
    picked = np.where(valid, sw["picked_hl_1h"].fill_null(0.0).to_numpy(), 0.0)
    fees = np.where(valid, sw["fee_usd"].fill_null(0.0).to_numpy(), 0.0)
    ts = sw["ts"].to_numpy()
    c_picked, c_fees = np.cumsum(share * picked), np.cumsum(share * fees)
    cum_p, cum_f = [], []
    for t in frames:
        i = int(np.searchsorted(ts, t, side="right")) - 1
        cum_p.append(0 if i < 0 else round(float(c_picked[i]) * 100))  # cents
        cum_f.append(0 if i < 0 else round(float(c_fees[i]) * 100))
    flows = sw.with_columns(pl.Series("picked", picked), pl.Series("fee_v", fees))
    return cum_p, cum_f, flows


def informed_flow(flows: pl.DataFrame, frames: list[int]) -> tuple[list[list[int]], list[list[int]]]:
    """The strongest informed swaps per frame [frameIndex, tickBefore, tickAfter, pickedCents] and per-frame pool-wide
    [pickedCents (positive part), feeCents] over the closed window."""
    edges = np.array(frames[1:] + [frames[-1] + STEP_S])
    ts = flows["ts"].to_numpy()
    idx = np.searchsorted(edges, ts, side="right")  # frame i covers [frames[i], frames[i+1])
    flows = flows.with_columns(pl.Series("frame", idx))
    strokes: list[list[int]] = []
    per_frame: list[list[int]] = [[0, 0] for _ in frames]
    for (fi,), g in flows.group_by(["frame"], maintain_order=True):
        fi = int(fi)
        if fi >= len(frames):
            continue
        per_frame[fi] = [round(float(g["picked"].clip(lower_bound=0).sum()) * 100), round(float(g["fee_v"].sum()) * 100)]
        top = g.filter(pl.col("picked") > 0).sort("picked", descending=True).head(FLOW_PER_FRAME)
        for r in top.iter_rows(named=True):
            strokes.append([fi, int(r["tick_before"]), int(r["tick"]), round(float(r["picked"]) * 100)])
    strokes.sort()
    return strokes, per_frame


def rpc_check(samples: list[dict]) -> list[dict]:
    """liquidity() (0x1a686502) at the sampled swaps' blocks, read-only, on the archive RPC. The URL is never printed."""
    import httpx

    url = os.environ.get("RH_ARCHIVE_RPC", "")
    if not url:
        return [{"error": "RH_ARCHIVE_RPC not set; rpc check skipped"}]
    out = []
    with httpx.Client(timeout=20) as c:
        for s in samples:
            body = {"jsonrpc": "2.0", "id": 1, "method": "eth_call",
                    "params": [{"to": POOL_ADDRESS, "data": "0x1a686502"}, hex(s["block"])]}
            try:
                res = c.post(url, json=body).json()
                onchain = int(res["result"], 16)
                dev = (s["segmentsL"] - onchain) / onchain * 100 if onchain else None
                out.append({"frame": s["frame"], "et": s["et"], "block": s["block"], "liquidityOnchain": str(onchain),
                            "segmentsL": f"{s['segmentsL']:.6e}", "deviationPct": None if dev is None else round(dev, 4)})
            except Exception as e:  # noqa: BLE001  (report, never leak the URL)
                out.append({"frame": s["frame"], "block": s["block"], "error": type(e).__name__})
    return out


def main() -> None:
    use_rpc = "--rpc" in sys.argv
    replay = json.loads(REPLAY.read_text())
    rows = replay["rows"]
    frames = frame_times()
    seg = load_segments()
    sw = load_swaps(frames[0] - 6 * 3600, frames[-1])

    # Pool state at each frame: the latest swap ≤ t.
    sw_ts = sw["ts"].to_numpy()
    state = []
    for t in frames:
        i = int(np.searchsorted(sw_ts, t, side="right")) - 1
        r = sw.row(i, named=True)
        state.append({"tick": int(r["tick"]), "liq": float(r["liquidity"]), "block": int(r["block"]), "swapTs": float(r["ts"]),
                      "mid": float(r["mid_after"])})

    ticks = [s["tick"] for s in state]
    lo = floor_s(min(ticks) - HALF_WINDOW, BUCKET)
    hi = ceil_s(max(ticks) + HALF_WINDOW + 1, BUCKET)
    n = (hi - lo) // BUCKET

    liq = np.zeros((len(frames), n))
    at_tick, checks = [], []
    for fi, t in enumerate(frames):
        act = (seg["start"] <= t) & (seg["end"] > t)
        L, a, b = seg["L"][act], seg["lower"][act], seg["upper"][act]
        # Difference array over the bucket grid: +L at the bucket of `lower`, −L at the bucket of `upper`.
        ia = np.clip((a - lo) // BUCKET, 0, n)
        ib = np.clip((b - lo) // BUCKET, 0, n)
        d = np.zeros(n + 1)
        np.add.at(d, ia, L)
        np.add.at(d, ib, -L)
        liq[fi] = np.cumsum(d)[:n]
        tick = state[fi]["tick"]
        l_tick = float(L[(a <= tick) & (b > tick)].sum())
        at_tick.append(l_tick)
        pool_l = state[fi]["liq"]
        checks.append((l_tick - pool_l) / pool_l * 100 if pool_l else float("nan"))

    peak = float(liq.max())
    l_scale = peak / Q_MAX
    q = np.rint(liq / l_scale).astype(int)

    lane = lane_range(replay)
    cum_p, cum_f, flows = control_lane(sw, frames)
    strokes, per_frame_flow = informed_flow(flows, frames)

    fr = []
    for fi, t in enumerate(frames):
        r = replay_at(rows, t)
        fr.append({
            "ts": t,
            "et": et_label(t),
            "poolTick": state[fi]["tick"],
            "poolMid": round(state[fi]["mid"], 4),
            "fair": round(r["fair"], 4),
            "fairTick": mid_to_tick(r["fair"]),
            "gapBps": round(r["gapBps"], 2),
            "regime": r["regime"],
            "gates": r["activeGates"],
            "risk": 1 if r["riskAddingAllowed"] else 0,
            "fence": r["fenceCode"],
            "clFrozen": 1 if r["chainlink"]["frozen"] else 0,
            "laneIn": None if r["lane"]["inRange"] is None else (1 if r["lane"]["inRange"] else 0),
            "laneUsd": r["lane"]["deployedUsd"],
        })

    dev = np.array(checks)
    worst = int(np.nanargmax(np.abs(dev)))
    picks = sorted({0, len(frames) // 2, len(frames) - 1})
    samples = [{"frame": i, "et": fr[i]["et"], "block": state[i]["block"], "segmentsL": at_tick[i]} for i in picks]
    rpc = rpc_check(samples) if use_rpc else []

    s = replay["summary"]
    doc = {
        "label": "Replay · Sep 11–14 2026 · NVDA/USDG pool (on-chain liquidity)",
        "kind": "deltadesk-relief",
        "version": 1,
        "id": "weekend-2026-09-11",
        "title": replay["title"],
        "pool": POOL,
        "poolAddress": POOL_ADDRESS,
        "chainId": 4663,
        "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "sources": [
            "data/study/m1/positions/segments.parquet (every NVDA/USDG position segment: L, lower, upper, start_ts, end_ts; rebuilt from the pool's and the NPM's Mint/Burn/Transfer logs on Robinhood Chain 4663)",
            "data/study/m0/swaps.parquet (pool tick, mid and liquidity as logged by the latest Swap ≤ t)",
            "web/public/replays/weekend-2026-09-11.json (the agent's replay: fair value, gap, regime, gates, risk-adding, fence code, lane state; nearest 5-minute row ≤ t)",
            "data/study/m1/hl_ref/hl_markouts.parquet (picked_hl_1h: Hyperliquid-referenced 1 h markout per swap)",
        ],
        "units": {
            "tick": "log_1.0001(NVDA_raw / USDG_raw); token0 USDG (6 dec), token1 NVDA (18 dec); higher tick = lower NVDA price",
            "liq": "active liquidity L per 10-tick bucket, quantised: L = q × lScale",
            "flow": "[frameIndex, tickBefore, tickAfter, pickedCents] strongest informed swaps (picked_hl_1h > 0) per frame, closed window only",
            "flowFrame": "[pickedCents (positive part), lpFeeCents] pool-wide per frame, closed window only",
            "control": "running totals in cents for the $1k always-in-range control lane (replay lvr.controlLane definition)",
            "fence": "ChainlinkFence code: 0 OK, 2 FEED_DEAD, 5 MARKET_CLOSED",
        },
        "tickSpacing": SPACING,
        "bucketTicks": BUCKET,
        "grid": {"tick0": lo, "n": n, "halfWindow": HALF_WINDOW},
        "lScale": float(f"{l_scale:.6e}"),
        "frames": fr,
        "liq": q.tolist(),
        "lane": {**lane, "halfWidth": LANE_HALF_WIDTH, "usd": s["lane"]["usd"], "closedInRangeShare": s["lane"]["closedInRangeShare"],
                 "note": "Lane A: $50 straddle placed on fair value before the close; held (not exited, not re-centred) through the closed window. After the window it planned a straddle on fair value, and the cost hurdle held it (benefit < 2× gas)."},
        "flow": strokes,
        "flowFrame": per_frame_flow,
        "control": {"pickedCents": cum_p, "feeCents": cum_f},
        "lvr": replay["lvr"],
        "summary": {
            "closedWindow": s["closedWindow"],
            "gap": s["gap"],
            "riskAdding": s["riskAdding"],
            "chainlink": s["chainlink"],
        },
        "events": [e for e in replay["events"] if not e.get("warmup")],
        "check": {
            "method": "Σ L of the segments covering the pool tick vs the pool's liquidity logged by the latest Swap ≤ t",
            "frames": len(frames),
            "medianAbsDeviationPct": round(float(np.nanmedian(np.abs(dev))), 4),
            "maxAbsDeviationPct": round(float(np.abs(dev[worst])), 4),
            "maxAt": fr[worst]["et"],
            "within1pct": int((np.abs(dev) <= 1).sum()),
            "rpc": rpc,
        },
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(doc, separators=(",", ":")))
    print(f"{OUT.relative_to(ROOT)}: {len(frames)} frames × {n} buckets (ticks {lo}..{hi}), {len(strokes)} flow strokes, "
          f"{OUT.stat().st_size / 1024:.0f} KB")
    print(f"lane [{lane['lower']}, {lane['upper']}) placed {et_label(lane['placedTs'])} on F {lane['placedFair']}; "
          f"inRange agreement {lane['inRangeAgreement']}")
    print(f"control lane: picked ${cum_p[-1] / 100:.2f}, fees ${cum_f[-1] / 100:.2f} "
          f"(replay: ${replay['lvr']['controlLane']['pickedOffUsd']:.2f}, ${replay['lvr']['controlLane']['feesUsd']:.2f})")
    print(f"check vs swap-logged liquidity: median |dev| {doc['check']['medianAbsDeviationPct']}%, "
          f"max {doc['check']['maxAbsDeviationPct']}% at {doc['check']['maxAt']}, within 1%: {doc['check']['within1pct']}/{len(frames)}")
    for i in picks:
        print(f"  frame {i} {fr[i]['et']}: tick {state[i]['tick']} block {state[i]['block']} segments {at_tick[i]:.6e} "
              f"swap-log {state[i]['liq']:.6e} ({checks[i]:+.4f}%)")
    for r in rpc:
        print("  rpc", {k: v for k, v in r.items()})


if __name__ == "__main__":
    main()
