"""M0 exit check: swap-derived LP fees must match the pool's own fee accounting within 0.5%.

Public Robinhood Chain RPCs don't serve historical state, so this runs forward in time:
    uv run python -m indexer.reconcile snap    # record feeGrowthGlobal0/1 at the current block
    ... wait (≥ 30 min for a meaningful sample) ...
    uv run python -m indexer.reconcile check   # snapshot again, decode every swap in between, compare

For a v3 pool, feeGrowthGlobalX128 grows by lpFee_raw · 2^128 / L_active on every swap step (LP share only; the
protocol cut is excluded). We sum lp_fee_raw / L over decoded swaps and compare with ΔfeeGrowthGlobal / 2^128.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import polars as pl

from indexer.backfill import rpc
from markout.pools import POOLS, decode_swaps

SNAP = Path(__file__).resolve().parents[2] / "data" / "reconcile"
POOL = POOLS[0]  # NVDA/USDG v3
SEL = {"feeGrowthGlobal0X128": "0xf3058399", "feeGrowthGlobal1X128": "0x46141319", "liquidity": "0x1a686502"}


def snapshot() -> dict:
    blk = int(rpc("eth_blockNumber", []), 16)
    out = {"block": blk}
    for name, sel in SEL.items():
        out[name] = str(int(rpc("eth_call", [{"to": POOL.pool_id, "data": sel}, hex(blk)]), 16))
    return out


def fetch_logs(lo: int, hi: int) -> pl.DataFrame:
    rows, step, cur = [], 20_000, lo
    while cur <= hi:
        end = min(cur + step - 1, hi)
        for lg in rpc("eth_getLogs", [{"address": POOL.pool_id, "fromBlock": hex(cur), "toBlock": hex(end)}], retries=8):
            t = lg["topics"] + [None] * (4 - len(lg["topics"]))
            rows.append({"block": int(lg["blockNumber"], 16), "tx_index": int(lg["transactionIndex"], 16), "log_index": int(lg["logIndex"], 16),
                         "tx_hash": lg["transactionHash"], "address": lg["address"].lower(), "topic0": t[0], "topic1": t[1], "topic2": t[2],
                         "topic3": t[3], "data": lg["data"]})
        cur = end + 1
    return pl.DataFrame(rows)


def main():
    SNAP.mkdir(parents=True, exist_ok=True)
    cmd = sys.argv[1] if len(sys.argv) > 1 else "snap"
    if cmd == "snap":
        s = snapshot()
        (SNAP / "start.json").write_text(json.dumps(s, indent=1))
        print("snapshot", s)
        return

    a = json.loads((SNAP / "start.json").read_text())
    b = snapshot()
    raw = fetch_logs(a["block"] + 1, b["block"])
    sw = decode_swaps(POOL, raw, (np.array([a["block"], b["block"]]), np.array([0, 1])))
    # Back to raw token units. NVDA/USDG: token0 = USDG (6 dec), token1 = NVDA (18 dec).
    # Taker buys NVDA (s=+1) → pays USDG → fee in token0. Taker sells NVDA → fee in token1.
    fee0_raw = (sw.filter(pl.col("s") == 1)["fee_q"] * 10**POOL.dec0)
    fee1_raw = (sw.filter(pl.col("s") == -1).with_columns((pl.col("fee_q") / pl.col("p_exec")).alias("fee_base"))["fee_base"] * 10**POOL.dec1)
    L0 = sw.filter(pl.col("s") == 1)["liquidity"].cast(pl.Float64)
    L1 = sw.filter(pl.col("s") == -1)["liquidity"].cast(pl.Float64)
    derived0 = float((fee0_raw / L0).sum())
    derived1 = float((fee1_raw / L1).sum())
    onchain0 = (int(b["feeGrowthGlobal0X128"]) - int(a["feeGrowthGlobal0X128"])) / 2**128
    onchain1 = (int(b["feeGrowthGlobal1X128"]) - int(a["feeGrowthGlobal1X128"])) / 2**128
    res = {
        "blocks": [a["block"], b["block"]], "swaps": sw.height,
        "token0_usdg": {"derived": derived0, "onchain": onchain0, "err_pct": 100 * (derived0 / onchain0 - 1) if onchain0 else None},
        "token1_nvda": {"derived": derived1, "onchain": onchain1, "err_pct": 100 * (derived1 / onchain1 - 1) if onchain1 else None},
    }
    (SNAP / f"check_{b['block']}.json").write_text(json.dumps(res, indent=1))
    print(json.dumps(res, indent=1))
    ok = all(abs(v["err_pct"]) < 0.5 for v in (res["token0_usdg"], res["token1_nvda"]) if v["err_pct"] is not None)
    print("PASS" if ok else "FAIL (>0.5%): check tick-crossing swaps / protocol fee schedule")


if __name__ == "__main__":
    main()
