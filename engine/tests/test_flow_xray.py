"""Tests for flow/ (M1 module B: Flow X-ray).

    uv run pytest tests/test_flow_xray.py -q
"""

from __future__ import annotations

import math
import sys
from datetime import date
from pathlib import Path

import numpy as np
import polars as pl
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from flow import cluster as fcluster  # noqa: E402
from flow import features, hl, io, jit, labels  # noqa: E402
from indexer.hs_backfill import NVDA_POOL, POOL_MANAGER, T_V3_BURN, T_V3_MINT, T_V4_MODIFY  # noqa: E402

SPY_ID = "0xe5923c8a8be481ec89a2ca784a2bbfa4235de6d88f92260fd66b660c4babf907"


# ----------------------------------------------------------------------------------------------- helpers

def swap_rows(rows: list[dict]) -> pl.DataFrame:
    """Synthetic swaps with every column enrich_swaps/aggregate need; per-row overrides via dict keys."""
    base = dict(pool="NVDA/USDG", block=1, tx_index=0, log_index=0, tx_hash="0xa", sender="r" * 40, s=1, q=1.0, ts=1_788_300_000.0,
                mid_after=100.0, vol_usd=100.0, fee_usd=0.05, picked_usd_1m=0.0, picked_usd_5m=0.0, picked_usd_1h=0.0,
                valid_1m=True, valid_5m=True, valid_1h=True, regime="REGULAR", reopen_window=False, how=10, date_et=date(2026, 9, 2),
                taker="0xt", to="0x" + "r" * 40, gas_used=100_000, gas_price_wei=1e7,
                hl_sign_1m=None, hl_sign_5m=None, hl_sign_15m=None, hl_gap_bps=None, hl_gap_age_s=30.0)
    recs = [{**base, **r} for r in rows]
    schema = {"hl_sign_1m": pl.Int8, "hl_sign_5m": pl.Int8, "hl_sign_15m": pl.Int8, "hl_gap_bps": pl.Float64, "hl_gap_age_s": pl.Float64, "date_et": pl.Date}
    return pl.DataFrame(recs, schema_overrides=schema)


def word(x: int) -> str:
    return format(x % (1 << 256), "064x")


def topic(x: int) -> str:
    return "0x" + word(x)


def log(block, log_index, tx_hash, address, t0, t1=None, t2=None, t3=None, data="0x", ts=None):
    return dict(block=block, tx_index=0, log_index=log_index, tx_hash=tx_hash, address=address, topic0=t0, topic1=t1, topic2=t2, topic3=t3,
                data=data, ts=ts if ts is not None else 1_788_300_000 + block)


def v3_mint(block, li, txh, owner, tl, tu, amount):
    return log(block, li, txh, NVDA_POOL, T_V3_MINT, topic(owner), topic(tl), topic(tu), "0x" + word(0xAB) + word(amount) + word(1) + word(1))


def v3_burn(block, li, txh, owner, tl, tu, amount):
    return log(block, li, txh, NVDA_POOL, T_V3_BURN, topic(owner), topic(tl), topic(tu), "0x" + word(amount) + word(1) + word(1))


def v4_modify(block, li, txh, sender, tl, tu, delta, salt=7, ts=None):
    return log(block, li, txh, POOL_MANAGER, T_V4_MODIFY, SPY_ID, topic(sender), None, "0x" + word(tl) + word(tu) + word(delta) + word(salt), ts)


# ----------------------------------------------------------------------------------------------- join coverage (real data)

@pytest.mark.skipif(not io.SWAPS.exists() or not io.tx_chunks(), reason="no local swaps / swap_txs data")
def test_join_coverage_on_present_data():
    chunks = io.tx_chunks()
    sw = pl.scan_parquet(io.SWAPS).select("block", "tx_hash").filter(io.covered_block(pl.col("block"), chunks)).collect()
    assert sw.height > 0
    joined = features.join_takers(sw, io.load_txs())
    coverage = joined["taker"].is_not_null().mean()
    assert coverage >= 0.99, f"only {coverage:.4%} of swaps in backfilled blocks got a tx.from"
    assert joined.height == sw.height  # tx_hash is unique on the tx side: the join never duplicates swaps


# ----------------------------------------------------------------------------------------------- HL signals

def _candles(closes: list[float], secs: int, t0: int) -> pl.DataFrame:
    return pl.DataFrame({"t_open_ms": [(t0 + i * secs) * 1000 for i in range(len(closes))],
                         "t_close_ms": [(t0 + (i + 1) * secs) * 1000 - 1 for i in range(len(closes))], "c": closes})


def test_hl_sign_uses_last_completed_bar_only():
    t0 = 1_788_300_000
    bars = _candles([100.0, 101.0, 100.5, 100.5], 60, t0)  # bars end at t0+60, +120, +180, +240
    loader = lambda sym, iv: bars if (sym == "NVDA" and iv == "1m") else None  # noqa: E731
    sw = pl.DataFrame({"pool": ["NVDA/USDG"] * 5, "ts": [t0 + 119.9, t0 + 130.0, t0 + 200.0, t0 + 250.0, t0 + 1000.0], "s": [1] * 5})
    out = hl.add_hl_signs(sw, loader)
    # 119.9: last completed bar is bar 0 (no previous close -> no return); 130: bar 1 (+); 200: bar 2 (-);
    # 250: bar 3 flat (0); 1000: last bar ended 760 s earlier (> one interval) -> no signal
    assert out["hl_sign_1m"].to_list() == [None, 1, -1, 0, None]
    assert out["hl_sign_5m"].null_count() == 5 and out["ts"].to_list() == sw["ts"].to_list()


def test_hl_gap_direction_and_toward_flag():
    t0 = 1_788_300_000 - (1_788_300_000 % 3600)
    hl_c = 50.0
    ts = [t0 + 600 * i for i in range(36)]  # 6 hours of swaps, one every 10 min
    closes = _candles([hl_c] * 400, 60, t0 - 60)
    loader = lambda sym, iv: closes if (sym == "NVDA" and iv == "1m") else None  # noqa: E731
    mid = [2 * hl_c] * 35 + [2 * hl_c * 1.001]  # basis 2; the last swap sees the pool 10 bp rich vs HL
    sw = pl.DataFrame({"pool": ["NVDA/USDG"] * 36, "ts": [float(x) for x in ts], "mid_before": mid, "s": [1] * 35 + [-1]})
    out = hl.add_hl_signs(sw, loader)
    gap = out["hl_gap_bps"].to_list()
    assert all(g is None for g in gap[:18])  # < 3 prior hours of basis
    assert abs(gap[-1] - 10.0) < 1e-6 and abs(gap[-2]) < 1e-9
    assert out["hl_gap_age_s"].to_list()[-1] == pytest.approx(0.0)  # a 1m bar closed exactly at the swap second
    # selling while the pool is rich moves it toward HL; a stale reference or a sub-threshold gap does not count
    e = features.enrich_swaps(swap_rows([
        {"ts": float(ts[-1]), "s": -1, "hl_gap_bps": gap[-1]},
        {"ts": float(ts[-1]), "s": 1, "hl_gap_bps": gap[-1], "log_index": 1},
        {"ts": float(ts[-2]), "s": 1, "hl_gap_bps": 0.5, "log_index": 2},
        {"ts": float(ts[-1]), "s": -1, "hl_gap_bps": gap[-1], "hl_gap_age_s": hl.GAP_MAX_AGE_S + 1, "log_index": 3},
    ]))
    assert e["hl_fair_gap_bps"].to_list()[0] == pytest.approx(-10.0)
    assert e["hl_toward"].to_list() == [True, False, False, False] and e["hl_gap_has"].to_list() == [True, True, False, False]


# ----------------------------------------------------------------------------------------------- features

def test_feature_sanity_synthetic():
    rows = [
        # taker A: 4 swaps, two in the same tx, one invalid 1h markout
        dict(taker="0xa", tx_hash="0x1", log_index=0, vol_usd=100.0, fee_usd=0.05, picked_usd_1h=1.0, picked_usd_5m=0.5, s=1, hl_sign_5m=1, how=5),
        dict(taker="0xa", tx_hash="0x1", log_index=1, vol_usd=200.0, fee_usd=0.10, picked_usd_1h=2.0, picked_usd_5m=-0.5, s=-1, hl_sign_5m=1, how=5),
        dict(taker="0xa", tx_hash="0x2", log_index=2, vol_usd=300.0, fee_usd=0.15, picked_usd_1h=3.0, picked_usd_5m=0.5, s=1, hl_sign_5m=1, how=5,
             regime="WEEKEND_DARK", date_et=date(2026, 9, 5)),
        dict(taker="0xa", tx_hash="0x3", log_index=3, vol_usd=400.0, fee_usd=0.20, picked_usd_1h=100.0, valid_1h=False, s=1, hl_sign_5m=0, how=5,
             reopen_window=True),
        # taker B: loses to LPs, one swap per hour-of-week bin -> uniform
        *[dict(taker="0xb", tx_hash=f"0xb{i}", log_index=10 + i, vol_usd=10.0, fee_usd=0.01, picked_usd_1h=-0.1, how=i, sender="p" * 40, to="0xagg")
          for i in range(168)],
    ]
    sw = features.enrich_swaps(swap_rows(rows))
    t = features.aggregate(sw, ["taker"]).sort("taker")
    a, b = t.row(0, named=True), t.row(1, named=True)
    assert a["swaps"] == 4 and a["n_tx"] == 3 and a["active_days"] == 2
    assert a["vol_usd"] == 1000.0 and a["size_med"] == 250.0 and a["size_p90"] == pytest.approx(370.0)
    assert a["fee_usd"] == pytest.approx(0.5)
    assert a["picked_1h"] == pytest.approx(6.0)  # invalid 1h markout excluded
    assert a["edge_1h"] == pytest.approx(0.5 / 6.0)
    assert a["pos5m_share"] == pytest.approx(0.5)  # 2 of 4 swaps with a positive 5m markout
    assert a["hl_n_5m"] == 3 and a["hl_lead_5m"] == pytest.approx(2 / 3)  # flat bar excluded; the sell disagrees
    assert a["hl_lead"] is None  # < HL_MIN_N signed swaps
    assert a["hl_n_best"] == 3 and a["hl_lead_best"] == pytest.approx(2 / 3)
    assert a["how_entropy"] == pytest.approx(0.0) and a["how_top_share"] == 1.0
    assert a["share_regular"] == 0.75 and a["share_weekend"] == 0.25 and a["share_reopen"] == 0.25
    assert a["swaps_per_tx"] == pytest.approx((2 + 2 + 1 + 1) / 4) and a["multi_swap_tx_share"] == 0.5
    assert a["direct_call_share"] == 1.0 and a["n_routers"] == 1 and a["top_router_share"] == 1.0
    assert a["buy_share"] == 0.75 and a["swaps_per_day"] == 2.0
    assert b["how_entropy"] == pytest.approx(1.0) and b["edge_1h"] is None and b["picked_1h"] < 0
    assert b["direct_call_share"] == 0.0
    # per taker x pool == per taker when each taker trades one pool
    tp = features.aggregate(sw, ["taker", "pool"]).sort("taker")
    assert tp["swaps"].to_list() == t["swaps"].to_list() and tp["picked_1h"].to_list() == t["picked_1h"].to_list()


def test_hl_lead_prefers_finest_bar():
    # 40 buys: the 1m bar (when present) says up, the 5m bar always says down -> finest bar wins where available
    rows = [dict(taker="0xa", log_index=i, tx_hash=f"0x{i}", s=1, hl_sign_1m=(1 if i < 30 else None), hl_sign_5m=-1) for i in range(40)]
    t = features.aggregate(features.enrich_swaps(swap_rows(rows)), ["taker"]).row(0, named=True)
    assert t["hl_n_best"] == 40 and t["hl_lead_best"] == pytest.approx(30 / 40)  # pooled diagnostic
    assert t["hl_lead_5m"] == 0.0 and t["hl_lead_1m"] == 1.0
    assert t["hl_lead"] == 1.0 and t["hl_lead_src"] == "1m" and t["hl_lead_n"] == 30  # finest interval with >= HL_MIN_N
    assert t["hl_lead_z"] == pytest.approx((30 - 15) / math.sqrt(7.5))
    # too few 1m swaps -> falls back to 5m
    rows = [dict(taker="0xb", log_index=i, tx_hash=f"0x{i}", s=1, hl_sign_1m=(1 if i < 10 else None), hl_sign_5m=-1) for i in range(40)]
    t = features.aggregate(features.enrich_swaps(swap_rows(rows)), ["taker"]).row(0, named=True)
    assert t["hl_lead_src"] == "5m" and t["hl_lead"] == 0.0 and t["hl_lead_n"] == 40


def test_router_public_rule():
    heavy = [dict(taker=f"0xh{i % 3}", sender="b" * 40, log_index=i, tx_hash=f"0xh{i}") for i in range(300)]
    casual = [dict(taker=f"0xc{i}", sender="c" * 40, log_index=1000 + i, tx_hash=f"0xc{i}") for i in range(features.PUBLIC_MIN_TAKERS)]
    rs = features.router_stats(swap_rows(heavy + casual)).sort("sender")
    assert rs["router_public"].to_list() == [False, True]


# ----------------------------------------------------------------------------------------------- JIT

def test_jit_detection_synthetic():
    W, R, S, V = 0xAAA, 0xBBB, 0xCCC, 0xDDD
    logs = pl.DataFrame([
        # A) wallet W: v3 add -> own swap -> remove, same block 100 (JIT)
        v3_mint(100, 1, "0xw1", W, -100, 100, 5), v3_burn(100, 3, "0xw2", W, -100, 100, 5),
        # B) wallet R: remove K1 -> own swap -> add K2 in one tx (rebalance, NOT JIT); plus a zero-amount poke
        v3_burn(200, 1, "0xr1", R, -50, 50, 9), v3_mint(200, 3, "0xr1", R, -60, 40, 9), v3_burn(200, 4, "0xr1", R, -60, 40, 0),
        # C) wallet S: add at block 300, someone else's swap at 301, remove at 310 (30 s later): short-lived, not same block
        v3_mint(300, 1, "0xs1", S, -10, 10, 3), v3_burn(310, 1, "0xs2", S, -10, 10, 3),
        # D) wallet V on v4 SPY/USDG: add (+delta) -> own swap -> remove (-delta) in block 400 (JIT)
        v4_modify(400, 1, "0xv1", V, -20, 20, 1000), v4_modify(400, 5, "0xv2", V, -20, 20, -1000),
    ]).with_columns(pl.col("tx_index").cast(pl.Int32), pl.col("log_index").cast(pl.Int32), pl.col("ts").cast(pl.Int64))
    logs = logs.with_columns(pl.when(pl.col("block") == 310).then(pl.lit(1_788_300_000 + 300 + 30)).otherwise(pl.col("ts")).alias("ts"))
    txs = pl.DataFrame({"tx_hash": ["0xw1", "0xw2", "0xr1", "0xs1", "0xs2", "0xv1", "0xv2"],
                        "from": ["0xw", "0xw", "0xr", "0xs", "0xs", "0xv", "0xv"]})
    ev = jit.decode_lp_events(logs, txs)
    assert ev.height == 8  # the zero-amount burn is a fee poke, not a remove
    assert set(ev["pool"]) == {"NVDA/USDG", "SPY/USDG"}
    assert ev.filter(pl.col("tx_hash") == "0xv2")["kind"].to_list() == ["remove"]
    swaps = pl.DataFrame({
        "pool": ["NVDA/USDG", "NVDA/USDG", "NVDA/USDG", "SPY/USDG"], "block": [100, 200, 301, 400], "log_index": [2, 2, 1, 3],
        "ts": [0.0, 0.0, 0.0, 0.0], "taker": ["0xw", "0xr", "0xo", "0xv"], "tx_hash": ["0xw3", "0xr1", "0xo1", "0xv3"],
    })
    win = jit.liquidity_windows(ev, swaps).sort("from")
    assert win["from"].to_list() == ["0xs", "0xv", "0xw"]
    assert win["same_block"].to_list() == [False, True, True]
    assert win["n_swaps"].to_list() == [1, 1, 1] and win["n_own_swaps"].to_list() == [0, 1, 1]
    own = jit.own_jit_swaps(win, swaps).sort("block")
    assert own["block"].to_list() == [100, 400]
    f = jit.taker_lp_features(ev, win, swaps).sort("taker")
    got = {r["taker"]: r for r in f.iter_rows(named=True)}
    assert got["0xw"]["jit_own_swaps"] == 1 and got["0xv"]["jit_own_swaps"] == 1
    assert got["0xr"]["jit_own_swaps"] == 0 and got["0xr"]["lp_tx_swaps"] == 1 and got["0xr"]["is_lp"]
    assert got["0xo"]["jit_own_swaps"] == 0 and not got["0xo"]["is_lp"]


# ----------------------------------------------------------------------------------------------- labels

def feature_row(**kw) -> dict:
    base = dict(taker="0x0", swaps=10, swaps_per_day=1.0, size_med=300.0, picked_1h=-1.0, picked_bps_1h=-5.0, picked_1h_t=-0.5, pos5m_share=0.4,
                hl_toward=None, hl_toward_z=None, hl_lead=None, hl_lead_z=None, public_router_share=1.0, jit_own_swaps=0, short_lived_own_windows=0)
    return {**base, **kw}


LABEL_CASES = [
    ("0x01", dict(jit_own_swaps=2, swaps=500, swaps_per_day=50.0, hl_toward=0.9, hl_toward_z=10.0, picked_1h=100.0, pos5m_share=0.8), "JIT-LP"),
    ("0x02", dict(swaps=5000, swaps_per_day=300.0, size_med=800.0, picked_1h=5000.0, picked_bps_1h=8.0, pos5m_share=0.75, hl_toward=0.7, hl_toward_z=20.0,
                  public_router_share=0.0), "HL-arb"),
    ("0x03", dict(swaps=400, swaps_per_day=20.0, picked_1h=900.0, pos5m_share=0.7, hl_lead=0.6, hl_lead_z=4.0, public_router_share=0.0), "HL-arb"),
    ("0x04", dict(), "retail"),
    ("0x05", dict(swaps=30, swaps_per_day=2.0, picked_1h=50.0, picked_bps_1h=30.0, picked_1h_t=1.0), "retail"),  # positive but not significant
    ("0x06", dict(size_med=20_000.0, swaps=15), "aggregator"),
    ("0x07", dict(swaps=3000, swaps_per_day=100.0, picked_1h=2000.0, pos5m_share=0.72, public_router_share=0.0, hl_toward=0.52, hl_toward_z=1.0), "informed-bot"),
    ("0x08", dict(swaps=3000, swaps_per_day=100.0, picked_1h=-200.0, pos5m_share=0.45, public_router_share=0.0), "bot/other"),
    ("0x09", dict(swaps=3000, swaps_per_day=5.0, picked_1h=2000.0, pos5m_share=0.72, hl_toward=0.8, hl_toward_z=9.0, public_router_share=0.0), "informed-bot"),  # not frequent
    ("0x10", dict(swaps=8000, swaps_per_day=180.0, size_med=80.0, picked_1h=1800.0, pos5m_share=0.70, public_router_share=0.9), "informed-bot"),  # bot on a public router
    ("0x11", dict(swaps=300, swaps_per_day=3.0, size_med=5000.0, picked_1h=-50.0, pos5m_share=0.45, public_router_share=0.9), "aggregator"),
]


def test_labels_rules_and_determinism():
    t = pl.DataFrame([feature_row(taker=a, **kw) for a, kw, _ in LABEL_CASES])
    want = {a: lab for a, _, lab in LABEL_CASES}
    got = dict(labels.label_takers(t).select("taker", "label").iter_rows())
    assert got == want
    # row-local and order-independent: shuffling or labelling one row at a time gives the same labels
    shuffled = t.sample(fraction=1.0, shuffle=True, seed=3)
    assert dict(labels.label_takers(shuffled).select("taker", "label").iter_rows()) == want
    for i in range(t.height):
        one = labels.label_takers(t.slice(i, 1))
        assert one["label"][0] == want[one["taker"][0]]
    assert labels.label_takers(t).equals(labels.label_takers(t))
    assert set(want.values()) <= set(labels.LABELS)


def test_labels_use_operator_features_for_fleets():
    op = dict(op_swaps=4000, op_swaps_per_day=400.0, op_picked_1h=9000.0, op_pos5m_share=0.74, op_hl_lead=0.64, op_hl_lead_z=12.0, op_hl_toward=None, op_hl_toward_z=None)
    solo_retail = dict(op_swaps=10, op_swaps_per_day=1.0, op_picked_1h=-1.0, op_pos5m_share=0.4, op_hl_lead=None, op_hl_lead_z=None, op_hl_toward=None, op_hl_toward_z=None)
    t = pl.DataFrame([
        # two thin fleet wallets: individually too small for HL-arb, but their operator is a frequent, HL-leading, profitable bot
        feature_row(taker="0xf1", swaps=40, swaps_per_day=20.0, picked_1h=300.0, pos5m_share=0.7, public_router_share=0.0, **op),
        feature_row(taker="0xf2", swaps=35, swaps_per_day=15.0, picked_1h=-20.0, pos5m_share=0.5, public_router_share=0.0, **op),
        feature_row(taker="0xr", **solo_retail),
    ])
    got = dict(labels.label_takers(t).select("taker", "label").iter_rows())
    assert got == {"0xf1": "HL-arb", "0xf2": "HL-arb", "0xr": "retail"}
    # the same wallets judged on their own features (no op_* columns) are not HL-arb
    own = dict(labels.label_takers(t.select(pl.exclude("^op_.*$"))).select("taker", "label").iter_rows())
    assert own["0xf1"] != "HL-arb" and own["0xf2"] != "HL-arb"


# ----------------------------------------------------------------------------------------------- clusters

def _cluster_input(n_per: int = 60, seed: int = 0) -> pl.DataFrame:
    rng = np.random.default_rng(seed)
    rows = []
    for k, (swaps, size, pub, pos5) in enumerate([(5000, 800, 0.0, 0.75), (40, 300, 1.0, 0.4), (300, 20000, 0.5, 0.5)]):
        for i in range(n_per):
            rows.append(dict(
                taker=f"0x{k}{i:04d}", swaps=int(swaps * rng.uniform(0.8, 1.2)), active_days=int(rng.integers(5, 30)), swaps_per_day=swaps / 20 * rng.uniform(0.8, 1.2),
                vol_usd=swaps * size * rng.uniform(0.8, 1.2), size_med=size * rng.uniform(0.8, 1.2), size_p90=2 * size, fee_usd=swaps * size * 5e-4, n_routers=1 + k,
                swaps_per_tx=1.0, gas_used_med=2e5, pos5m_share=pos5 + rng.normal(0, 0.02), hl_lead=None, hl_toward=0.5 + 0.2 * (k == 0), how_entropy=0.8,
                share_regular=0.3, share_weekend=0.1, share_reopen=0.02, public_router_share=pub, direct_call_share=1.0 - pub, buy_share=0.5, gas_pct_med=0.5,
                multi_swap_tx_share=0.0, picked_bps_1h=(10.0 if k == 0 else -3.0) + rng.normal(0, 1), picked_1h=float(100 - k)))
    rows += [dict(rows[0], taker=f"0xsmall{i}", swaps=5) for i in range(10)]
    return pl.DataFrame(rows)


def test_clusters_deterministic_and_long_tail():
    t = _cluster_input()
    a = fcluster.cluster_takers(t)
    b = fcluster.cluster_takers(t.sample(fraction=1.0, shuffle=True, seed=11))
    assert dict(a.select("taker", "cluster").iter_rows()) == dict(b.select("taker", "cluster").iter_rows())
    assert set(a.filter(pl.col("swaps") < fcluster.MIN_SWAPS)["cluster"]) == {fcluster.LONG_TAIL}
    big = a.filter(pl.col("swaps") >= fcluster.MIN_SWAPS)
    named = [c for c in big["cluster"].unique().to_list() if c.startswith("C")]
    assert len(named) >= 2  # the three synthetic populations are separable
    # each synthetic population lands (mostly) in a single cluster
    for k in range(3):
        grp = big.filter(pl.col("taker").str.starts_with(f"0x{k}"))["cluster"]
        assert grp.value_counts().sort("count", descending=True)["count"][0] / grp.len() >= 0.8


def test_edge_math_matches_m0_convention():
    rows = [dict(taker="0xa", fee_usd=3.0, picked_usd_1h=2.0), dict(taker="0xa", log_index=1, fee_usd=1.0, picked_usd_1h=-1.0, tx_hash="0xb")]
    t = features.aggregate(features.enrich_swaps(swap_rows(rows)), ["taker"])
    assert t["edge_1h"][0] == pytest.approx(4.0 / 1.0) and not math.isnan(t["fee_bps"][0])
