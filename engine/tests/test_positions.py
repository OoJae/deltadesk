"""Unit tests for positions/ (synthetic inputs, no data needed)."""

from __future__ import annotations

import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # engine/ on the path (no shared conftest / pytest pythonpath yet)

import numpy as np
import polars as pl
import pytest

from positions.attribute import METRICS, MI, NM, NR, hodl_walk, segment_accruals, sweep
from positions.reconstruct import (_hex_word_float, _hex_word_i24, _lifecycle_ids, amounts_for_liquidity, order_key, signed,
                                   tick_to_sqrtp, topic_i24, words)
from positions.tearsheet import short_id, union_seconds, width_class


# ------------------------------------------------------------------------------------------------------------ decoding
def _word(x: int) -> str:
    return format(x & (2**256 - 1), "064x")


def test_int24_sign_extension_in_topics_and_data():
    for t in (-887272, -200180, -1, 0, 1, 223058, 887272):
        topic = "0x" + _word(t)
        assert topic_i24(topic) == t
        assert signed(int(topic, 16)) == t
    data = "0x" + _word(5) + _word(-219464) + _word(2**100 + 7)
    df = pl.DataFrame({"data": [data]})
    assert df.select(_hex_word_i24("data", 1))[0, 0] == -219464
    assert df.select(_hex_word_i24("data", 0))[0, 0] == 5
    assert words(data)[2] == 2**100 + 7
    assert math.isclose(df.select(_hex_word_float("data", 2))[0, 0], float(2**100 + 7), rel_tol=1e-15)


def test_uint160_sqrt_price_float_decode():
    sqrtp_x96 = 0x1105EF700C8DF0495DD49F9E4C798  # NVDA/USDG Initialize
    df = pl.DataFrame({"data": ["0x" + _word(sqrtp_x96) + _word(223058)]})
    assert math.isclose(df.select(_hex_word_float("data", 0))[0, 0], float(sqrtp_x96), rel_tol=1e-15)
    # the Initialize tick must be floor(log_1.0001 P)
    p = (sqrtp_x96 / 2**96) ** 2
    assert math.floor(math.log(p, 1.0001)) == 223058


def test_order_key_is_monotone():
    assert order_key(10, 0, 5) < order_key(10, 1, 0) < order_key(11, 0, 0)


def test_lifecycles_split_on_reopen():
    k = ("0xabc", -10, 10)
    ids, live = _lifecycle_ids([k, k, k, k], [5, -5, 3, -1], "P:v3")
    assert ids == ["P:v3:0xabc:-10:10#1", "P:v3:0xabc:-10:10#1", "P:v3:0xabc:-10:10#2", "P:v3:0xabc:-10:10#2"]
    assert live[k] == 2


# ----------------------------------------------------------------------------------------------------------- liquidity math
def test_amounts_for_liquidity_regions():
    L = 1e18
    lo, hi = tick_to_sqrtp(-100), tick_to_sqrtp(100)
    a0, a1 = amounts_for_liquidity(L, lo, hi, 1.0)  # in range, price 1
    assert math.isclose(a0, L * (1 - 1 / hi), rel_tol=1e-12) and math.isclose(a1, L * (1 - lo), rel_tol=1e-12)
    b0, b1 = amounts_for_liquidity(L, lo, hi, tick_to_sqrtp(-500))  # below range: all token0
    assert b1 == 0 and math.isclose(b0, L * (1 / lo - 1 / hi), rel_tol=1e-12)
    c0, c1 = amounts_for_liquidity(L, lo, hi, tick_to_sqrtp(500))   # above range: all token1
    assert c0 == 0 and math.isclose(c1, L * (hi - lo), rel_tol=1e-12)


def test_hodl_walk_prorata_withdrawal():
    d0, d1 = 1e6, 1e18
    rows = [("inc", 1000, 100e6, 1e18, 1.0, 100.0),   # deposit $100 USDG + 1 NVDA @100
            ("dec", 500, 0.0, 0.0, 1.0, 120.0)]         # withdraw half the liquidity when NVDA = 120
    b0, b1, hw = hodl_walk(rows, d0, d1)
    assert math.isclose(hw, 0.5 * (100 + 120))
    assert math.isclose(b0, 50e6) and math.isclose(b1, 0.5e18)
    hodl_end = b0 / d0 * 1.0 + b1 / d1 * 150.0
    assert math.isclose(hw + hodl_end, 110 + 125)


# ------------------------------------------------------------------------------------------------------------- the sweep
def _swaps(rows):
    """rows: (ord, tick_before, tick, sqrtp_before, sqrtp_after, fee_usd, reg)."""
    base = {m: [0.0] * len(rows) for m in METRICS}
    base["fee_usd"] = [r[5] for r in rows]
    base["picked_1h"] = [r[5] / 2 for r in rows]
    return pl.DataFrame({"ord": [r[0] for r in rows], "tick_before": [r[1] for r in rows], "tick": [r[2] for r in rows],
                         "sqrtp_before": [r[3] for r in rows], "sqrtp_after": [r[4] for r in rows], "reg": [r[6] for r in rows],
                         "liquidity": [0.0] * len(rows), **base})


def test_sweep_prorata_jit_and_crossing_split():
    ticks = np.array([0, 10, 20])
    a = lambda t: int(np.searchsorted(ticks, t, side="right"))  # noqa: E731
    # A: [0,20) L=100 from ord 10 (open); B: [10,20) L=300 ord 20..40; C (JIT-like): [10,20) L=100 ord 26..28
    ev = pl.DataFrame({
        "pos_id": ["A", "B", "C", "C", "B"], "ord": [10, 20, 26, 28, 40],
        "a_lo": [a(0), a(10), a(10), a(10), a(10)], "a_hi": [a(20), a(20), a(20), a(20), a(20)],
        "dL_signed": ["100", "300", "100", "-100", "-300"],
    })
    s5, s10, s15 = (float(tick_to_sqrtp(t)) for t in (5, 10, 15))
    sw = _swaps([
        (15, 5, 5, s5, s5, 1.0, 0),       # only A in range (bucket [0,10))
        (25, 15, 15, s15, s15, 4.0, 0),   # A:B = 100:300
        (27, 15, 15, s15, s15, 5.0, 3),   # A:B:C = 100:300:100 (C only sees this one), weekend regime
        (30, 5, 15, s5, s15, 10.0, 0),    # crossing 5 -> 15, token1 in: weights L_b·Δ√P per bucket
        (50, 15, 15, s15, s15, 2.0, 0),   # B closed: all A
    ])
    res = sweep(ticks, ev, sw)
    seg = pl.DataFrame({"pos_id": ["A", "B", "C"], "start_ord": [10, 20, 26], "end_ord": [None, 40, 28], "L": [100.0, 300.0, 100.0],
                        "a_lo": [a(0), a(10), a(10)], "a_hi": [a(20), a(20), a(20)]})
    seg, acc = segment_accruals(seg, ev, res["snap"], res["A"])
    tot = acc.reshape(-1, NR, NM).sum(axis=1)
    fee = dict(zip(seg["pos_id"], tot[:, MI["fee_usd"]]))
    w1, w2 = 100 * (s10 - s5), 400 * (s15 - s10)
    x1, x2 = w1 / (w1 + w2), w2 / (w1 + w2)
    assert math.isclose(fee["A"], 1 + 1 + 1 + 10 * (x1 + 0.25 * x2) + 2, rel_tol=1e-12)
    assert math.isclose(fee["B"], 3 + 3 + 10 * 0.75 * x2, rel_tol=1e-12)
    assert math.isclose(fee["C"], 1, rel_tol=1e-12)
    assert math.isclose(sum(fee.values()), 22.0, rel_tol=1e-12)           # conservation by construction
    pk = dict(zip(seg["pos_id"], tot[:, MI["picked_1h"]]))
    assert math.isclose(sum(pk.values()), 11.0, rel_tol=1e-12)             # markouts follow the same shares
    wk = acc.reshape(-1, NR, NM)[:, 3, MI["fee_usd"]]                      # regime 3 = WEEKEND_DARK
    assert math.isclose(dict(zip(seg["pos_id"], wk))["C"], 1.0) and math.isclose(wk.sum(), 5.0)
    assert res["unattributed"][MI["fee_usd"]] == 0
    assert res["L_final"][a(15)] == 100 and res["L_final"][a(5)] == 100


def test_sweep_token0_in_uses_inverse_sqrt_coordinate():
    ticks = np.array([0, 10, 20])
    ev = pl.DataFrame({"pos_id": ["A", "B"], "ord": [1, 2], "a_lo": [1, 2], "a_hi": [2, 3], "dL_signed": ["100", "100"]})
    s15, s10, s5 = (float(tick_to_sqrtp(t)) for t in (15, 10, 5))
    res = sweep(ticks, ev, _swaps([(5, 15, 5, s15, s5, 1.0, 0)]))  # price falls: token0 in
    seg = pl.DataFrame({"pos_id": ["A", "B"], "start_ord": [1, 2], "end_ord": [None, None], "L": [100.0, 100.0], "a_lo": [1, 2], "a_hi": [2, 3]})
    _, acc = segment_accruals(seg, ev, res["snap"], res["A"])
    fa, fb = acc.reshape(-1, NR, NM).sum(axis=1)[:, MI["fee_usd"]]
    da, db = 1 / s5 - 1 / s10, 1 / s10 - 1 / s15   # A covers [0,10), B covers [10,20)
    assert math.isclose(fa / fb, da / db, rel_tol=1e-10)
    assert math.isclose(fa + fb, 1.0, rel_tol=1e-12)


def test_sweep_no_liquidity_is_unattributed_not_lost_silently():
    ticks = np.array([0, 10])
    ev = pl.DataFrame({"pos_id": ["A"], "ord": [10], "a_lo": [1], "a_hi": [2], "dL_signed": ["100"]})
    s = float(tick_to_sqrtp(5))
    res = sweep(ticks, ev, _swaps([(5, 5, 5, s, s, 3.0, 0)]))  # swap before any liquidity
    assert res["unattributed"][MI["fee_usd"]] == 3.0


# --------------------------------------------------------------------------------------------------------------- helpers
def test_union_seconds_and_labels():
    assert union_seconds(np.array([0.0, 5.0, 20.0]), np.array([10.0, 15.0, 30.0])) == 25.0
    assert union_seconds(np.array([]), np.array([])) == 0.0
    assert width_class(10) .startswith("tight") and width_class(1_774_544) == "full-range"
    assert short_id("NVDA/USDG:v3:0x4da212efc0d513b00680a6cf66f97d508452bf18:221880:221940#1") == "NVDA/USDG:v3:0x4da2…bf18:221880:221940#1"


@pytest.mark.parametrize("tick", [-219464, -210000, 0, 222000])
def test_tick_to_sqrtp_matches_definition(tick):
    assert math.isclose(float(tick_to_sqrtp(tick)) ** 2, 1.0001**tick, rel_tol=1e-12)
