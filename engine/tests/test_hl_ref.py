"""Tests for markout/hl_ref.py (M1 module A: HL-referenced markouts).

    uv run pytest tests/test_hl_ref.py -q
"""

from __future__ import annotations

import sys
from datetime import date, datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # engine/ on the path (no shared conftest / pytest pythonpath yet)

import numpy as np
import polars as pl
import pytest

from markout import hl_ref as H

ET = H.ET


def _ts(y, m, d, hh, mm=0, ss=0) -> float:
    return datetime(y, m, d, hh, mm, ss, tzinfo=ET).timestamp()


def _ref(ts, px, res) -> pl.DataFrame:
    ts = np.asarray(ts, dtype=float)
    return pl.DataFrame({"ts": ts, "px": np.asarray(px, dtype=float), "res": np.broadcast_to(float(res), ts.shape).copy(), "ts_old": ts})


# ───────────── synthetic market: Mon 2026-09-14 → Fri 2026-09-18, 1-minute HL points, pool swaps every 20 s ─────────────

T0, T1 = _ts(2026, 9, 14, 0), _ts(2026, 9, 18, 23)


def _synthetic(seed: int = 0):
    rng = np.random.default_rng(seed)
    hl_t = np.arange(T0, T1, 60.0)
    hl_px = 200 * np.exp(np.cumsum(rng.normal(0, 3e-4, hl_t.size)))
    ref = _ref(hl_t, hl_px, 60)
    sw_t = np.arange(T0 + 7, T1, 20.0)
    basis = 1.0012
    mid = basis * np.interp(sw_t, hl_t, hl_px) * np.exp(rng.normal(0, 2e-4, sw_t.size))
    pool_mid = pl.DataFrame({"ts": sw_t, "mid": mid})
    return ref, pool_mid


def _perturb_after(ref: pl.DataFrame, pool_mid: pl.DataFrame, t: float):
    ref2 = ref.with_columns(pl.when(pl.col("ts") > t).then(pl.col("px") * 1.5).otherwise(pl.col("px")).alias("px"))
    pm2 = pool_mid.with_columns(pl.when(pl.col("ts") > t).then(pl.col("mid") * 0.7).otherwise(pl.col("mid")).alias("mid"))
    # also add extra points after t
    ref2 = pl.concat([ref2, _ref([t + 0.5, t + 1.5], [1.0, 2.0], 1)]).sort("ts")
    return ref2, pm2


# ───────────── basis k ─────────────

@pytest.mark.parametrize("t", [
    _ts(2026, 9, 16, 12, 0),        # mid-session Wed → uses Tue's session
    _ts(2026, 9, 16, 16, 0, 1),     # 1 s after Wed close → uses Wed's session
    _ts(2026, 9, 16, 16, 0),        # exactly at Wed close → still Tue's (strictly before t)
    _ts(2026, 9, 18, 21, 0),        # Friday evening
])
def test_k_no_lookahead_synthetic(t):
    ref, pm = _synthetic()
    k1 = H.k_at([t], H.calibrate_k(pm, ref, date(2026, 9, 14), date(2026, 9, 18)))
    ref2, pm2 = _perturb_after(ref, pm, t)
    k2 = H.k_at([t], H.calibrate_k(pm2, ref2, date(2026, 9, 14), date(2026, 9, 18)))
    assert k1["k"][0] == pytest.approx(k2["k"][0], abs=0, rel=0)
    assert k1["k_session"][0] == k2["k_session"][0]
    assert not k1["k_lookahead"][0]
    assert k1["k"][0] == pytest.approx(1.0012, rel=2e-4)


def test_k_session_assignment_and_flag():
    ref, pm = _synthetic()
    sess = H.calibrate_k(pm, ref, date(2026, 9, 14), date(2026, 9, 18))
    assert sess.height == 5 and (sess["n_points"] == 391).all()  # 09:30…16:00 inclusive, 1-minute points
    k = H.k_at([_ts(2026, 9, 14, 12), _ts(2026, 9, 16, 12), _ts(2026, 9, 16, 16), _ts(2026, 9, 16, 16, 0, 1)], sess)
    assert k["k_lookahead"].to_list() == [True, False, False, False]
    assert k["k_session"].to_list() == [date(2026, 9, 14), date(2026, 9, 15), date(2026, 9, 15), date(2026, 9, 16)]


def test_trading_sessions_skip_weekends_and_holidays():
    s = H.trading_sessions(date(2026, 9, 4), date(2026, 9, 8))  # Fri, Sat, Sun, Mon (Labor Day), Tue
    assert s["session"].to_list() == [date(2026, 9, 4), date(2026, 9, 8)]
    # 09:30 ET in September is 13:30 UTC (EDT)
    assert datetime.fromtimestamp(s["open_ts"][0], timezone.utc).hour == 13


def _real_ok() -> bool:
    return H.SWAPS.exists() and (H.CANDLES / "xyz_NVDA_1h.parquet").exists()


@pytest.fixture(scope="module")
def nvda():
    if not _real_ok():
        pytest.skip("real data not available")
    refs, _ = H.build_references()
    sw = H.load_pool_swaps("NVDA/USDG")
    return refs["NVDA/USDG"], sw


def test_nvda_k_range(nvda):
    ref, sw = nvda
    sess = H.calibrate_k(sw.select("ts", pl.col("mid_after").alias("mid")), ref)
    good = sess.filter(pl.col("k").is_not_null() & (pl.col("n_points") >= H.MIN_SESSION_POINTS))
    assert good.height >= 30
    assert good["k"].min() >= 0.995 and good["k"].max() <= 1.02


def test_nvda_no_lookahead_real(nvda):
    """Perturb every pool mid and HL point after t: k(t) and F_pre(t) must not move."""
    ref, sw = nvda
    t = _ts(2026, 9, 16, 12, 0)
    pm = sw.select("ts", pl.col("mid_after").alias("mid"))
    k1 = H.k_at([t], H.calibrate_k(pm, ref))
    ref2, pm2 = _perturb_after(ref, pm, t)
    k2 = H.k_at([t], H.calibrate_k(pm2, ref2))
    assert k1["k"][0] == k2["k"][0] and k1["k_session"][0] == date(2026, 9, 15)
    f1 = H.asof_lookup(ref, [t])["px"][0]
    f2 = H.asof_lookup(ref2, [t])["px"][0]
    assert f1 == f2


# ───────────── per-swap markouts ─────────────

def _one_swap(s: int, t: float = 10_000.0, p_ex: float = 100.0) -> pl.DataFrame:
    return pl.DataFrame({"ts": [t - 50.0, t], "s": [1, s], "q": [1.0, 2.0], "p_ex": [100.0, p_ex],
                         "mid_after": [100.0, 100.0], "quote_usd": [1.0, 1.0]})


def _sessions_k(k: float = 1.0) -> pl.DataFrame:
    return pl.DataFrame({"session": [date(2026, 1, 1)], "open_ts": [0.0], "close_ts": [1.0], "k": [k], "n_points": [100]},
                        schema_overrides={"n_points": pl.UInt32})


@pytest.mark.parametrize("s", [1, -1])
def test_sign_taker_buys_fair_rises(s):
    t = 10_000.0
    grid = np.arange(t - 600, t + 3700, 1.0)
    px = np.where(grid <= t, 100.0, 101.0)  # HL steps up right after the swap
    ref = _ref(grid, px, 1)
    m = H.mark_swaps(_one_swap(s, t), ref, _sessions_k(1.0)).row(1, named=True)
    for h in H.HORIZONS:
        assert m[f"valid_hl_{h}"]
        assert m[f"F_{h}"] == pytest.approx(101.0)
        # taker bought 2 units at 100, fair went to 101 → taker +$2, LP −$2; seller mirrors it
        assert m[f"picked_hl_{h}"] == pytest.approx(2.0 * s)
        assert (m[f"picked_hl_{h}"] > 0) == (s == 1)
    assert m["F_pre"] == pytest.approx(100.0) and m["gap_pre_bps"] == pytest.approx(0.0)
    assert m["P_pool_before"] == 100.0


def test_basis_scales_fair_and_gap():
    t = 10_000.0
    ref = _ref(np.arange(t - 100, t + 3700, 1.0), np.full(3800, 10.0), 1)  # e.g. an index at 1/10 the ETF price
    m = H.mark_swaps(_one_swap(1, t, p_ex=100.0), ref, _sessions_k(10.02)).row(1, named=True)
    assert m["F_pre"] == pytest.approx(100.2)
    assert m["gap_pre_bps"] == pytest.approx(1e4 * np.log(100.2 / 100.0))
    assert m["picked_hl_5m"] == pytest.approx(2 * 0.2)


def test_validity_rule():
    t = 1_000_000.0
    last = t + 4000.0
    cases = [
        # (h, res, age of point at t+h, expected)
        (60, 1.0, 45.0, True),       # tape point 45 s old: within max(1, 60)
        (60, 1.0, 61.0, False),      # tape point too stale
        (60, 60.0, 59.0, True),      # 1m candle within one candle
        (60, 60.0, 61.0, False),
        (60, 300.0, 10.0, False),    # 5m candle too coarse for a 1m markout
        (300, 300.0, 299.0, True),
        (300, 300.0, 301.0, False),
        (300, 900.0, 5.0, False),    # 15m candle too coarse for 5m
        (3600, 900.0, 800.0, True),
        (3600, 3600.0, 3500.0, True),
        (3600, 3600.0, 3700.0, False),
    ]
    df = pl.DataFrame({"ts": [t] * len(cases), "h": [c[0] for c in cases], "res": [c[1] for c in cases],
                       "pt": [t + c[0] - c[2] for c in cases]})
    got = [df.slice(i, 1).select(H.validity(pl.col("ts"), float(c[0]), pl.col("res"), pl.col("pt"), last)).item()
           for i, c in enumerate(cases)]
    assert got == [c[3] for c in cases]
    # beyond the end of HL data → invalid even if fresh
    assert pl.DataFrame({"ts": [t], "res": [1.0], "pt": [t + 3600.0]}).select(
        H.validity(pl.col("ts"), 3600.0, pl.col("res"), pl.col("pt"), t + 3599.0)).item() is False


def test_validity_end_to_end_resolution_switch():
    """Swap near the end of 5m data: t+1m falls on 5m points → 1m markout invalid, 5m valid; past the data → invalid."""
    t = 100_000.0
    ref = _ref(np.arange(t - 3000, t + 600, 300.0), np.full(12, 50.0), 300)
    m = H.mark_swaps(_one_swap(1, t, p_ex=50.0), ref, _sessions_k()).row(1, named=True)
    assert not m["valid_hl_1m"] and m["valid_hl_5m"] and not m["valid_hl_1h"]
    assert m["ref_res_s"] == 300.0


# ───────────── reference construction ─────────────

def test_candles_partial_dropped_and_end_stamped(tmp_path):
    step = 60_000
    opens = np.arange(0, 5 * step, step) + 1_700_000_000_000
    df = pl.DataFrame({"t_open_ms": opens, "t_close_ms": opens + step - 1, "o": 1.0, "h": 1.0, "l": 1.0,
                       "c": [1.0, 2.0, 3.0, 4.0, 5.0], "v": 1.0, "n": 1, "coin": "xyz:NVDA", "interval": "1m"})
    df.write_parquet(tmp_path / "xyz_NVDA_1m.parquet")
    cutoff = int(opens[4] + 30_000)  # fetched mid-way through the 5th candle
    r = H.load_candles("xyz:NVDA", "1m", cutoff_ms=cutoff, root=tmp_path)
    assert r["px"].to_list() == [1.0, 2.0, 3.0, 4.0]
    assert r["ts"][0] == pytest.approx((opens[0] + step) / 1000)  # stamped at the candle END boundary
    assert (r["res"] == 60.0).all()


def test_merge_prefers_finer_source():
    coarse = _ref([0.0, 3600.0, 7200.0, 10800.0], [1, 2, 3, 4], 3600)
    fine = _ref(np.arange(7000.0, 11000.0, 60.0), np.full(67, 9.0), 60)
    m = H.merge_sources([fine, coarse])
    assert m.filter(pl.col("res") == 3600)["ts"].to_list() == [0.0, 3600.0]
    assert m["ts"].is_sorted() and m["ts"].n_unique() == m.height


def test_ratio_reference():
    a = _ref([0.0, 10.0, 20.0], [300.0, 330.0, 360.0], 1)
    b = _ref([5.0, 15.0], [100.0, 110.0], 60)
    r = H.ratio_ref(a, b)
    assert r["ts"].to_list() == [5.0, 10.0, 15.0, 20.0]
    assert r["px"].to_list() == pytest.approx([3.0, 3.3, 3.0, 360 / 110])
    assert (r["res"] == 60.0).all()
    assert r["ts_old"].to_list() == [0.0, 5.0, 10.0, 15.0]


def test_how_expr_sunday():
    ts = [_ts(2026, 9, 13, 19), _ts(2026, 9, 14, 9), _ts(2026, 9, 12, 0)]  # Sun 19:00, Mon 09:00, Sat 00:00 ET
    assert pl.DataFrame({"ts": ts}).select(H.how_expr())["how"].to_list() == [6 * 24 + 19, 9, 5 * 24]
