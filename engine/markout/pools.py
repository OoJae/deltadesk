"""Decode raw pool logs into a normalized swap table.

Every swap row is expressed from the TAKER's side in the pool's natural units:
    q      = stock (base) quantity, human units, > 0
    s      = +1 if the taker bought the base asset, -1 if they sold it
    p_exec = quote paid per base, fees included
    p_ex   = quote per base excluding ALL fees (the price the curve actually moved through)
    fee_q  = fee that accrues to LPs, in quote units
    proto_q = protocol fee (paid by the taker, not earned by LPs), in quote units
    mid_after = pool mid price (quote per base) right after the swap
    tick_before / tick = pool tick before / after the swap (raw token1/token0 space, same as position ticks)

v3 Swap amounts are the POOL's balance deltas (+ = pool received).
v4 Swap amounts are the SWAPPER's deltas (+ = swapper received), i.e. the opposite sign.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
import polars as pl

DATA = Path(__file__).resolve().parents[2] / "data"

V3_SWAP = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67"
V4_SWAP = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f"
V3_SET_FEE_PROTOCOL = "0x973d8d92bb299f4af6ce49b52a8adb85ae46b9f214c4c4fc06ac77401237b133"


@dataclass(frozen=True)
class Pool:
    key: str            # short name used in outputs
    source: str         # raw/<source>/ directory
    venue: str          # "v3" | "v4"
    pool_id: str        # v3 address or v4 poolId
    base: str           # the asset whose price we mark (stock, or QQQ for QQQ/SPY)
    quote: str          # USDG, or SPY for QQQ/SPY
    base_is_0: bool     # base is token0/currency0
    dec0: int
    dec1: int
    lp_fee_pips: int    # pool fee tier in pips (1e6 = 100%); v3: total fee (protocol cut comes out of it), v4: LP fee
    v3_fee_protocol_now: int = 0  # slot0.feeProtocol today; used for history only if no SetFeeProtocol events exist


POOLS = [
    Pool("NVDA/USDG", "v3_nvda_usdg", "v3", "0xd4eb21209c4d6093f80b5b84f5c45cc093ea14a3", "NVDA", "USDG", False, 6, 18, 500, v3_fee_protocol_now=68),
    Pool("SPY/USDG", "v4_pools", "v4", "0xe5923c8a8be481ec89a2ca784a2bbfa4235de6d88f92260fd66b660c4babf907", "SPY", "USDG", True, 18, 6, 500),
    Pool("TSLA/USDG", "v4_pools", "v4", "0x8517f8071ae5b831b738052f12125e8e3d6c158b78728aa44ce3b25e5104d32e", "TSLA", "USDG", True, 18, 6, 3000),
    # QQQ/SPY: SPY (0x117c…) sorts before QQQ (0xD5f3…), so currency0 = SPY, currency1 = QQQ. Base = QQQ, quote = SPY.
    Pool("QQQ/SPY", "v4_pools", "v4", "0x8493982435e4273028008cd181c84c0d6a548f96792fdb5acddcbb6a8c82d305", "QQQ", "SPY", False, 18, 18, 200),
]


def _words(hexdata: str) -> list[int]:
    b = bytes.fromhex(hexdata[2:])
    return [int.from_bytes(b[i : i + 32], "big") for i in range(0, len(b), 32)]


def _signed(x: int, bits: int = 256) -> int:
    return x - (1 << bits) if x >= 1 << (bits - 1) else x


def load_raw(source: str) -> pl.DataFrame:
    files = sorted((DATA / "raw" / source).glob("hs_*.parquet")) or sorted((DATA / "raw" / source).glob("*.parquet"))
    if not files:
        raise FileNotFoundError(f"no raw data for {source}")
    return pl.concat([pl.read_parquet(f) for f in files]).sort(["block", "tx_index", "log_index"])


def block_to_ts() -> tuple[np.ndarray, np.ndarray]:
    files = sorted((DATA / "raw" / "block_ts").glob("*.parquet"))
    df = pl.concat([pl.read_parquet(f) for f in files]).unique("block").sort("block")
    return df["block"].to_numpy(), df["ts"].to_numpy()


def decode_swaps(pool: Pool, raw: pl.DataFrame, anchors: tuple[np.ndarray, np.ndarray] | None = None) -> pl.DataFrame:
    if pool.venue == "v3":
        sel = raw.filter((pl.col("address") == pool.pool_id) & (pl.col("topic0") == V3_SWAP))
    else:
        sel = raw.filter((pl.col("topic0") == V4_SWAP) & (pl.col("topic1") == pool.pool_id))

    # v3 protocol fee: the pool keeps 1/N of each swap fee (N = 4..10, 0 = off), separately per input token.
    fp_blocks, fp0s, fp1s = [0], [0], [0]
    if pool.venue == "v3":
        ev = raw.filter((pl.col("address") == pool.pool_id) & (pl.col("topic0") == V3_SET_FEE_PROTOCOL)).sort("block")
        for blk, data in ev.select(["block", "data"]).iter_rows():
            w = _words(data)
            fp_blocks.append(blk); fp0s.append(w[2]); fp1s.append(w[3])
        if len(fp_blocks) == 1 and pool.v3_fee_protocol_now:
            fp0s[0], fp1s[0] = pool.v3_fee_protocol_now % 16, pool.v3_fee_protocol_now >> 4
            print(f"{pool.key}: no SetFeeProtocol events; assuming feeProtocol={pool.v3_fee_protocol_now} for all history")
    fp_blocks_np = np.array(fp_blocks)

    recs = []
    prev_tick = None
    for blk, txi, li, txh, data, sender in sel.select(["block", "tx_index", "log_index", "tx_hash", "data", "topic2" if pool.venue == "v4" else "topic1"]).iter_rows():
        w = _words(data)
        a0, a1 = _signed(w[0]), _signed(w[1])
        sqrtp = w[2]
        liq = w[3]
        # Only swaps move the tick, so the previous swap's post-swap tick is the pool tick this swap started from.
        # Tracked across dust swaps too (they still move the price).
        tick = _signed(w[4])
        tick_before = prev_tick if prev_tick is not None else tick
        prev_tick = tick
        if pool.venue == "v4":
            a0, a1 = -a0, -a1  # convert swapper deltas → pool deltas (+ = pool received)
        # human amounts, pool perspective
        x0 = a0 / 10**pool.dec0
        x1 = a1 / 10**pool.dec1
        base_pool, quote_pool = (x0, x1) if pool.base_is_0 else (x1, x0)
        if base_pool == 0 or quote_pool == 0 or abs(quote_pool) * (1 if pool.quote == "USDG" else 700) < 0.01:
            continue  # dust: sub-cent swaps carry rounding-dominated prices
        s = 1 if base_pool < 0 else -1  # pool paid out base → taker bought base
        q = abs(base_pool)
        quote_amt = abs(quote_pool)
        p_exec = quote_amt / q
        # Fees are charged on the input token. total_pips = everything the taker paid on top of the curve;
        # lp_share = the fraction of it that accrues to LPs (the rest is protocol fee).
        input_is_0 = (s == 1) != pool.base_is_0  # taker pays quote when buying base
        if pool.venue == "v3":
            total_pips = pool.lp_fee_pips
            k = int(np.searchsorted(fp_blocks_np, blk, side="right")) - 1
            n = fp0s[k] if input_is_0 else fp1s[k]
            lp_share = 1 - (1 / n if n else 0)
        else:
            total_pips = w[5]  # v4 Swap.fee = swapFee = protocolFee + lpFee·(1 − protocolFee/1e6)
            proto = (total_pips - pool.lp_fee_pips) / (1 - pool.lp_fee_pips / 1e6)
            lp_share = (total_pips - proto) / total_pips if total_pips else 0.0
        f = total_pips / 1e6
        if s == 1:  # taker paid quote (input) incl. fee
            fee_all_q = quote_amt * f
            p_ex = (quote_amt - fee_all_q) / q
        else:  # taker paid base (input) incl. fee; fee taken in base, valued at exec price
            fee_base = q * f
            fee_all_q = fee_base * p_exec
            p_ex = quote_amt / (q - fee_base)
        fee_q = fee_all_q * lp_share
        proto_q = fee_all_q - fee_q
        # pool mid after swap: raw price token1/token0 = (sqrtP / 2^96)^2
        raw_p = (sqrtp / 2**96) ** 2 * 10 ** (pool.dec0 - pool.dec1)  # human token1 per token0
        mid_after = raw_p if pool.base_is_0 else 1 / raw_p  # quote per base
        recs.append((blk, txi, li, txh, (sender or "")[-40:], s, q, quote_amt, p_exec, p_ex, fee_q, proto_q, mid_after, float(liq), tick_before, tick))

    df = pl.DataFrame(
        recs,
        schema=["block", "tx_index", "log_index", "tx_hash", "sender", "s", "q", "quote_amt", "p_exec", "p_ex", "fee_q", "proto_q", "mid_after", "liquidity", "tick_before", "tick"],
        orient="row",
    )
    if "ts" in raw.columns:  # HyperSync: exact block timestamps
        bts = raw.select("block", pl.col("ts").cast(pl.Float64)).unique("block")
        df = df.join(bts, on="block", how="left")
    else:  # RPC segments: interpolate from sampled block-timestamp anchors
        bk, ts = anchors if anchors is not None else block_to_ts()
        df = df.with_columns(pl.Series("ts", np.interp(df["block"].to_numpy(), bk, ts)).cast(pl.Float64))
    return df.with_columns(pl.lit(pool.key).alias("pool"))
