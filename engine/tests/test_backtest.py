"""Tests for backtest/gap_exclusion.py (M1 module D: gap-exclusion backtest).

    uv run pytest tests/test_backtest.py -q
"""

from __future__ import annotations

import math
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # engine/ on the path (no shared conftest / pytest pythonpath yet)

import numpy as np
import polars as pl
import pytest

from backtest import gap_exclusion as G
from markout import hl_ref as H
from markout.study import regime_expr

ET = G.ET
NV = "NVDA/USDG"
OUT = G.OUT
HAVE_DATA = G.SWAPS.exists() and G.HL_MARKOUTS.exists()
HAVE_OUT = (OUT / "results.parquet").exists() and (OUT / "phi.parquet").exists()
M0_BY_POOL = G.DATA / "study" / "m0" / "by_pool.parquet"
HL_BY_POOL = G.DATA / "study" / "m1" / "hl_ref" / "by_pool.parquet"


def _ts(y, m, d, hh, mm=0, ss=0.0) -> float:
    return datetime(y, m, d, hh, mm, int(ss), int(round((ss % 1) * 1e6)), tzinfo=ET).timestamp()


def _pre(ts, gap, ok=None, pool=NV) -> pl.DataFrame:
    ts = np.asarray(ts, dtype=float)
    gap = np.broadcast_to(np.asarray(gap, dtype=float), ts.shape)
    ok = np.ones(ts.shape, bool) if ok is None else np.broadcast_to(np.asarray(ok, bool), ts.shape)
    return (pl.DataFrame({"pool": [pool] * len(ts), "ts": ts, "gap_bps": gap, "gap_ok": ok})
            .with_columns(*regime_expr()).with_columns(G.group_expr()))


def _phi(value: float, pool=NV) -> pl.DataFrame:
    return pl.DataFrame({"pool": [pool] * 4, "grp": G.GROUPS, "phi": [float(value)] * 4})


# ───────────── calendar windows (ET, DST aware) ─────────────

@pytest.mark.parametrize("t,expect", [
    (_ts(2026, 9, 14, 8, 59, 59), False),   # Mon, EDT
    (_ts(2026, 9, 14, 9, 0), True),
    (_ts(2026, 9, 14, 10, 59, 59), True),
    (_ts(2026, 9, 14, 11, 0), False),
    (_ts(2026, 9, 18, 10, 30), True),       # Fri
    (_ts(2026, 9, 19, 9, 30), False),       # Sat
    (_ts(2026, 9, 13, 10, 0), False),       # Sun
    (_ts(2026, 9, 7, 9, 30), True),         # Labor Day: a fixed weekday schedule still applies
    (_ts(2026, 11, 16, 9, 0), True),        # Mon, EST (= 14:00 UTC)
    (_ts(2026, 11, 16, 8, 30), False),      # 13:30 UTC: would be 09:30 in EDT
])
def test_r1_window_dst(t, expect):
    got = pl.DataFrame({"ts": [t]}).select(G.r1_window_expr()).item()
    assert got is expect


@pytest.mark.parametrize("t,expect", [
    (_ts(2026, 9, 13, 19, 49, 59), False),  # Sun EDT
    (_ts(2026, 9, 13, 19, 50), True),
    (_ts(2026, 9, 13, 20, 14, 59), True),
    (_ts(2026, 9, 13, 20, 15), False),
    (_ts(2026, 9, 14, 9, 19, 59), False),   # Mon
    (_ts(2026, 9, 14, 9, 20), True),
    (_ts(2026, 9, 16, 9, 44, 59), True),    # Wed
    (_ts(2026, 9, 16, 9, 45), False),
    (_ts(2026, 9, 19, 9, 30), False),       # Sat
    (_ts(2026, 11, 15, 19, 55), True),      # Sun EST
    (_ts(2026, 11, 17, 9, 30), True),       # Tue EST
])
def test_r3_window_dst(t, expect):
    got = pl.DataFrame({"ts": [t]}).select(G.r3_window_expr()).item()
    assert got is expect


def test_group_mapping():
    df = pl.DataFrame({"regime": ["REGULAR", "EXTENDED", "OVERNIGHT", "WEEKEND_DARK", "HOLIDAY"]})
    assert df.select(G.group_expr())["grp"].to_list() == ["REGULAR", "EXTENDED", "OVERNIGHT", "DARK", "DARK"]


def test_period_bounds():
    from datetime import date
    df = pl.DataFrame({"date_et": [date(2026, 7, 27), date(2026, 7, 28), date(2026, 8, 31), date(2026, 9, 1), date(2026, 9, 18), date(2026, 9, 19)]})
    assert df.select(G.period_expr())["period"].to_list() == [None, "TRAIN", "TRAIN", "TEST", "TEST", None]


# ───────────── decisions ─────────────

def test_gap_rule_threshold_and_no_signal():
    t = _ts(2026, 9, 16, 12, 0)                 # Wed REGULAR, outside every fixed window
    pre = _pre([t] * 6, [4.9, 5.0, 5.1, -5.1, 50.0, float("nan")], ok=[True, True, True, True, False, False])
    a = G.decide(pre, None, _phi(5.0)).to_list()
    assert a == [False, False, True, True, False, False]  # strict >, both signs, no signal ⇒ present
    assert G.decide(pre, None, None).to_list() == [False] * 6                     # R0
    other = _phi(5.0, pool="SPY/USDG")                                            # no φ for this pool ⇒ ∞
    assert G.decide(pre, None, other).to_list() == [False] * 6
    assert G.decide(pre, None, _phi(0.0)).to_list() == [True, True, True, True, False, False]
    assert G.decide(pre, None, _phi(math.inf)).to_list() == [False] * 6


def test_decide_reads_only_pre_columns():
    rng = np.random.default_rng(1)
    ts = _ts(2026, 9, 14, 0) + np.sort(rng.uniform(0, 6 * 86400, 5000))
    pre = _pre(ts, rng.normal(0, 8, ts.size), ok=rng.uniform(size=ts.size) > 0.1)
    junk = pre.with_columns(pl.Series("F_1h", rng.normal(size=ts.size)), pl.Series("picked_hl_1h", rng.normal(size=ts.size)),
                            pl.Series("mid_after", rng.normal(size=ts.size)), pl.Series("s", rng.choice([-1, 1], ts.size)))
    junk2 = junk.with_columns(pl.col("F_1h") * 7 + 3, -pl.col("picked_hl_1h"), pl.col("mid_after") ** 2, -pl.col("s"))
    phi = pl.DataFrame({"pool": [NV] * 4, "grp": G.GROUPS, "phi": [3.0, 6.0, 9.0, 12.0]})
    for win in [None, "R1", "R3"]:
        base = G.decide(pre.select(G.PRE_COLS), win, phi)
        assert base.sum() > 0
        assert G.decide(junk, win, phi).equals(base)
        assert G.decide(junk2, win, phi).equals(base)


def test_unions_are_unions():
    rng = np.random.default_rng(2)
    ts = _ts(2026, 9, 13, 0) + np.arange(0, 7 * 86400, 37.0)
    pre = _pre(ts, rng.normal(0, 10, ts.size))
    phi = _phi(8.0)
    gap = G.decide(pre, None, phi)
    for win in ["R1", "R3"]:
        assert G.decide(pre, win, phi).equals(G.decide(pre, win, None) | gap)
        assert G.decide(pre, win, None).sum() > 0


# ───────────── φ grid search ─────────────

def _fit_frame(seed: int = 0, n: int = 40_000) -> pl.DataFrame:
    """Synthetic universe with TRAIN and TEST rows and every state variant's gap columns."""
    rng = np.random.default_rng(seed)
    t_train = _ts(2026, 8, 3, 0) + np.sort(rng.uniform(0, 20 * 86400, n))
    t_test = _ts(2026, 9, 2, 0) + np.sort(rng.uniform(0, 12 * 86400, n))
    ts = np.concatenate([t_train, t_test])
    df = _pre(ts, 0.0).drop("gap_bps", "gap_ok").with_columns(G.period_expr(), pl.lit(True).alias("in_universe"))
    for st in G.STATES:
        gap = rng.normal(0, 10, ts.size)
        df = df.with_columns(pl.Series(f"gap_bps_{st.key}", gap), pl.Series(f"gap_ok_{st.key}", rng.uniform(size=ts.size) > 0.05))
    # informed flow: large |gap| loses money for the LP
    g0 = np.abs(df["gap_bps_L0"].to_numpy())
    return df.with_columns(pl.Series("net", 1.0 - 0.15 * g0 + rng.normal(0, 1.0, ts.size)))


def test_phi_curve_matches_brute_force():
    df = _fit_frame(3, 5_000).filter(pl.col("period") == "TRAIN")
    pre = G.pre_view(df, "L0")
    for win in [None, "R1"]:
        curve = G.phi_curve(pre, df["net"], win)
        w = pre.select(G.WINDOWS[win]() if win else pl.lit(False)).to_series().to_numpy() if win else np.zeros(pre.height, bool)
        g, ok, net, grp = pre["gap_bps"].to_numpy(), pre["gap_ok"].to_numpy(), df["net"].to_numpy(), pre["grp"].to_numpy()
        for phi in [0.0, 3.0, 12.0, math.inf]:
            for k in ["REGULAR", "DARK"]:
                keep = ~w & ~(ok & (np.abs(g) > phi)) & (grp == k)
                row = curve.filter((pl.col("grp") == k) & (pl.col("phi") == phi))
                assert row["net_kept"].item() == pytest.approx(net[keep].sum(), rel=1e-9, abs=1e-9)


def test_choose_phi_ties_go_to_larger_phi():
    curve = pl.DataFrame({"pool": [NV] * 8, "grp": ["REGULAR"] * 4 + ["DARK"] * 4,
                          "phi": [5.0, 10.0, 20.0, math.inf] * 2, "net_kept": [3.0, 7.0, 7.0, 1.0, 2.0, 2.0, 2.0, 2.0]})
    best = G.choose_phi(curve).sort("grp")
    assert best.filter(pl.col("grp") == "REGULAR")["phi"].item() == 20.0
    assert best.filter(pl.col("grp") == "DARK")["phi"].item() == math.inf


def test_fit_uses_only_train():
    df = _fit_frame()
    phis, grid, guards = G.fit_all(df)
    assert phis[("R2", "L0", "TRAIN")].filter(pl.col("phi") < math.inf).height > 0     # the synthetic signal is found
    assert guards.filter(pl.col("guard_pass")).height > 0                              # a broad synthetic signal passes the guard
    # scramble every TEST outcome: TRAIN-fitted φ, guarded φ and the guard itself must not move
    df2 = df.with_columns(pl.when(pl.col("period") == "TEST").then(-5 * pl.col("net") + 3).otherwise(pl.col("net")).alias("net"))
    phis2, _, guards2 = G.fit_all(df2)
    for key, tab in phis.items():
        if key[2] in ("TRAIN", "TRAIN_GUARDED"):
            assert phis2[key].sort("pool", "grp").equals(tab.sort("pool", "grp")), key
    assert guards2.sort("family", "state", "pool", "grp").equals(guards.sort("family", "state", "pool", "grp"))
    assert not phis2[("R2", "L0", "TEST")].sort("pool", "grp").equals(phis[("R2", "L0", "TEST")].sort("pool", "grp"))
    # and TRAIN outcomes do move it (non-vacuous)
    df3 = df.with_columns(pl.when(pl.col("period") == "TRAIN").then(-5 * pl.col("net") + 3).otherwise(pl.col("net")).alias("net"))
    phis3, _, _ = G.fit_all(df3)
    assert not phis3[("R2", "L0", "TRAIN")].sort("pool", "grp").equals(phis[("R2", "L0", "TRAIN")].sort("pool", "grp"))


def _guard_frame() -> tuple[pl.DataFrame, pl.Series, pl.Series]:
    """Three NVDA cells over 10 ET weekdays with gap 20 bp (> φ = 10) on every swap: 12:00 (REGULAR) gains $100/day (broad),
    18:00 gains $900 on one day and $10 on the others (one event), 02:00 gains $1/day (tiny)."""
    rows = []
    weekdays = [3, 4, 5, 6, 7, 10, 11, 12, 13, 14]                # Mon–Fri Aug 3–7 and 10–14, 2026
    for i, day in enumerate(weekdays):
        for hh, gain in [(12, 100.0), (18, 900.0 if i == 3 else 10.0), (2, 1.0)]:
            rows.append((_ts(2026, 8, day, hh), -gain))            # net = −gain: taking the swap out gains `gain`
    ts, net = zip(*rows)
    pre = _pre(list(ts), 20.0)
    dates = pre.select(G.et_date_expr()).to_series()
    return pre, pl.Series("net", list(net)), dates


def test_phi_guard_flags_thin_cells():
    pre, net, dates = _guard_frame()
    grps = pre["grp"].unique().to_list()
    phi = pl.DataFrame({"pool": [NV] * len(grps), "grp": grps, "phi": [10.0] * len(grps)})
    gd = G.phi_guard(pre, net, dates, None, phi, min_gain=250.0, max_top_day=0.5)
    row = {r["grp"]: r for r in gd.iter_rows(named=True)}
    assert len(grps) == 3 and "REGULAR" in grps
    reg = "REGULAR"
    assert row[reg]["gain"] == pytest.approx(1000.0) and row[reg]["top_day_share"] == pytest.approx(0.1) and row[reg]["guard_pass"]
    assert row[reg]["days_out"] == 10 and row[reg]["days_pos"] == 10
    others = [g for g in grps if g != reg]
    for g in others:
        assert not row[g]["guard_pass"]                        # one-event cell and tiny cell both fail
    ext = [g for g in others if row[g]["gain"] > 500][0]
    assert row[ext]["top_day_share"] == pytest.approx(900 / 990) and str(row[ext]["top_day"]) == "2026-08-06"
    # the guard's gain equals the φ-curve gain net_kept(φ) − net_kept(∞)
    curve = G.phi_curve(pre, net, None, [10.0, math.inf])
    for g in grps:
        c = curve.filter(pl.col("grp") == g)
        assert row[g]["gain"] == pytest.approx(c.filter(pl.col("phi") == 10.0)["net_kept"].item() - c.filter(pl.col("phi") == math.inf)["net_kept"].item())
    gphi = {r["grp"]: r["phi"] for r in G.guarded(gd).iter_rows(named=True)}
    assert gphi[reg] == 10.0 and all(math.isinf(gphi[g]) for g in others)
    # a window leg: swaps inside the window are not credited to the gap leg
    gw = G.phi_guard(pre, net, dates, "R1", phi)
    assert gw.filter(pl.col("grp") == reg)["gain"].item() == pytest.approx(1000.0)   # 12:00 is outside R1


def test_fixed_window_slices():
    cases = [(_ts(2026, 9, 13, 19, 55), "in R3"), (_ts(2026, 9, 14, 9, 30), "in R3"), (_ts(2026, 9, 14, 9, 10), "in R1 not R3"),
             (_ts(2026, 9, 14, 10, 30), "in R1 not R3"), (_ts(2026, 9, 14, 12, 0), "outside both"), (_ts(2026, 9, 19, 9, 30), "outside both"),
             (_ts(2026, 11, 16, 9, 25), "in R3"), (_ts(2026, 11, 16, 8, 25), "outside both")]      # EST
    got = pl.DataFrame({"ts": [c[0] for c in cases]}).select(G.fixed_window_expr())["fixed_win"].to_list()
    assert got == [c[1] for c in cases]
    assert pl.DataFrame({"ts": [_ts(2026, 9, 14, 9, 59, 59)]}).select(G.hour_et_expr()).item() == 9


def test_hourly_delta_and_top_hours():
    ts = [_ts(2026, 9, 8, 9, 35), _ts(2026, 9, 8, 9, 40), _ts(2026, 9, 8, 13, 5), _ts(2026, 9, 9, 13, 5), _ts(2026, 9, 9, 14, 0)]
    d = pl.DataFrame({"pool": [NV] * 5, "ts": ts, "net": [-50.0, -30.0, 5.0, -1.0, 7.0],
                      "gap_bps_L0": [99.0, -40.0, 3.0, 20.0, 1.0], "gap_ok_L0": [True] * 5}).with_columns(
        G.et_date_expr(), G.hour_et_expr(), G.fixed_window_expr())
    a = pl.Series([True, True, True, True, False])
    h = G.hourly_delta(d, a)
    nv = h.filter(pl.col("pool") == NV)
    assert nv["delta"].sum() == pytest.approx(76.0)                        # −Σ net over absent swaps = Δ vs R0
    top = nv.sort("delta", descending=True).row(0, named=True)
    assert top["hour_et"] == 9 and top["delta"] == pytest.approx(80.0) and top["n_absent"] == 2
    assert top["share_in_r3"] == pytest.approx(1.0) and top["share_in_r1"] == pytest.approx(1.0)
    assert top["med_abs_gap_fine"] == pytest.approx(69.5)
    th = G.top_hours(h.with_columns(pl.lit("TEST").alias("period"), pl.lit("R2").alias("rule")), k=2)
    x = th.filter(pl.col("pool") == NV)
    assert x["rank"].to_list() == [1, 2] and x["delta"][0] >= x["delta"][1]
    assert x["delta_period"][0] == pytest.approx(76.0)


def test_concentration_by_period():
    rows = []
    for per, days, r0, r1 in [("TRAIN", ["2026-08-03", "2026-08-04", "2026-08-05"], [0.0, 0.0, 0.0], [10.0, 5.0, -3.0]),
                              ("TEST", ["2026-09-01", "2026-09-02"], [0.0, 0.0], [-1.0, 4.0])]:
        for dte, a, b in zip(days, r0, r1):
            rows += [{"period": per, "pool": NV, "rule": "R0", "date_et": dte, "net_kept": a},
                     {"period": per, "pool": NV, "rule": "R1", "date_et": dte, "net_kept": b}]
    daily = pl.DataFrame(rows).with_columns(pl.col("date_et").str.to_date())
    tr = G._concentration(daily, "TRAIN").row(0, named=True)
    assert tr["delta"] == pytest.approx(12.0) and tr["best_day"] == "2026-08-03" and tr["second_day"] == "2026-08-04"
    assert tr["top2_share"] == pytest.approx(15 / 12) and tr["delta_ex_best"] == pytest.approx(2.0) and tr["days"] == 3
    te = G._concentration(daily, "TEST").row(0, named=True)
    assert te["best_day"] == "2026-09-02" and te["delta"] == pytest.approx(3.0) and te["days_neg"] == 1


def test_significance_sentence_is_generated_from_bootstrap():
    base = {"period": "TEST", "days": 18, "p_pos": 0.5, "scope": "all swaps"}
    boot = pl.DataFrame([
        {**base, "pool": NV, "rule": "R1", "vs": "R0", "delta": 13.0, "lo95": -36.0, "hi95": 78.0},
        {**base, "pool": "SPY/USDG", "rule": "R1", "vs": "R0", "delta": -1100.0, "lo95": -2100.0, "hi95": -237.0},
        {**base, "pool": "SPY/USDG", "rule": "R2@1s", "vs": "R0", "delta": -900.0, "lo95": -1000.0, "hi95": -800.0},   # not a listed pair
        {**base, "pool": NV, "rule": "R2", "vs": "R0", "delta": 3000.0, "lo95": 100.0, "hi95": 5000.0, "scope": "outside fixed windows"},
    ])
    sig = G.significant(boot)
    assert sig.height == 1 and sig["pool"].item() == "SPY/USDG"
    txt = G.significance_sentence(boot)
    assert "Of 2 bootstrapped comparisons, 1 have" in txt and "no NVDA/USDG or all-pool difference excludes zero" in txt
    assert "on SPY/USDG: R1 − R0 −$1.1k [−$2.1k, −$237]" in txt
    boot2 = boot.with_columns(pl.when((pl.col("pool") == NV) & (pl.col("rule") == "R1")).then(1.0).otherwise(pl.col("lo95")).alias("lo95"))
    assert "on NVDA/USDG: R1 − R0" in G.significance_sentence(boot2)


# ───────────── metrics ─────────────

def test_metrics_by_hand():
    df = pl.DataFrame({"pool": [NV] * 4, "vol_usd": [100.0, 200.0, 300.0, 400.0], "fee_usd": [1.0, 2.0, 3.0, 4.0],
                       "picked_hl_1h": [0.5, 5.0, -1.0, 2.0], "picked_usd_1h": [0.4, 4.0, 0.0, 1.0],
                       "picked_hl_5m": [0.1, 1.0, 0.2, 9.9], "valid_hl_5m": [True, True, True, False]})
    a = pl.Series([False, True, False, False])
    e = G.evaluate(df, a, ["pool"]).row(0, named=True)
    assert e["n_absent"] == 1 and e["fees_kept_pct"] == pytest.approx(8 / 10)
    assert e["avoided_hl_1h_pct"] == pytest.approx(5.0 / 6.5)
    assert e["edge_hl_1h"] == pytest.approx(8 / 1.5) and e["net_hl_1h"] == pytest.approx(6.5)
    assert e["d_net_hl_1h"] == pytest.approx(6.5 - 3.5)
    assert e["net_bps_vol"] == pytest.approx(6.5 / 1000 * 1e4) and e["net_bps_kept_vol"] == pytest.approx(6.5 / 800 * 1e4)
    assert e["fees_5m"] == pytest.approx(6.0) and e["picked_hl_5m_kept"] == pytest.approx(0.3)   # 5m only where valid
    assert e["avoided_self_1h_pct"] == pytest.approx(4.0 / 5.4)
    out = G.evaluate(df, pl.Series([True] * 4), ["pool"]).row(0, named=True)
    assert out["fees_kept_pct"] == 0 and out["net_hl_1h"] == 0 and out["avoided_hl_1h_pct"] == pytest.approx(1.0)


# ───────────── causal pre-trade state & timeline (synthetic) ─────────────

T0, T1 = _ts(2026, 9, 13, 12), _ts(2026, 9, 19, 12)


def _market(seed: int = 0):
    rng = np.random.default_rng(seed)
    hl_t = np.arange(T0, T1, 60.0)
    hl_px = 200 * np.exp(np.cumsum(rng.normal(0, 4e-4, hl_t.size)))
    ref = pl.DataFrame({"ts": hl_t, "px": hl_px, "res": np.full(hl_t.size, 60.0), "ts_old": hl_t})
    sw_t = np.sort(np.concatenate([np.arange(T0 + 7, T1, 20.0), np.arange(T0 + 7, T1, 20.0)[::5]]))  # some same-second pairs
    mid = 1.001 * np.interp(sw_t, hl_t, hl_px) * np.exp(rng.normal(0, 6e-4, sw_t.size))
    return ref, pl.DataFrame({"ts": sw_t, "mid_after": mid})


def _perturb(ref: pl.DataFrame, sw: pl.DataFrame, t: float):
    ref2 = pl.concat([ref.with_columns(pl.when(pl.col("ts") > t).then(pl.col("px") * 1.5).otherwise(pl.col("px")).alias("px")),
                      pl.DataFrame({"ts": [t + 0.5, t + 1.5], "px": [1.0, 2.0], "res": [1.0, 1.0], "ts_old": [t + 0.5, t + 1.5]})]).sort("ts")
    sw2 = sw.with_columns(pl.when(pl.col("ts") > t).then(pl.col("mid_after") * 0.7).otherwise(pl.col("mid_after")).alias("mid_after"))
    return ref2, sw2


def _states(ref, sw, lag):
    sessions = H.calibrate_k(sw.select("ts", pl.col("mid_after").alias("mid")), ref)
    return G.pre_trade_state(sw, ref, sessions, lag)


@pytest.mark.parametrize("lag", [0.0, 1.0, 5.0])
@pytest.mark.parametrize("cut", [_ts(2026, 9, 16, 12, 3, 17.5), _ts(2026, 9, 17, 16, 0, 0.5), _ts(2026, 9, 18, 9, 31, 59.5)])
def test_no_lookahead_synthetic(lag, cut):
    ref, sw = _market()
    ref2, sw2 = _perturb(ref, sw, cut)
    a, b = _states(ref, sw, lag), _states(ref2, sw2, lag)
    before = (sw["ts"] <= cut).to_numpy()
    assert a.filter(pl.Series(before)).equals(b.filter(pl.Series(before)))
    pre_a = _pre(sw["ts"], a["gap_bps"].fill_null(0.0), a["gap_ok"])
    pre_b = _pre(sw["ts"], b["gap_bps"].fill_null(0.0), b["gap_ok"])
    for win in [None, "R1", "R3"]:
        da, db = G.decide(pre_a, win, _phi(3.0)), G.decide(pre_b, win, _phi(3.0))
        assert da.filter(pl.Series(before)).equals(db.filter(pl.Series(before)))
        assert da.filter(pl.Series(before)).sum() > 0
    assert not da.filter(pl.Series(~before)).equals(db.filter(pl.Series(~before)))   # the perturbation is visible after the cut


def test_lag_uses_state_strictly_before():
    ref, sw = _market()
    s1 = _states(ref, sw, 1.0)
    # with a 1 s lag the pool price used for a swap is never from the same second
    sessions = H.calibrate_k(sw.select("ts", pl.col("mid_after").alias("mid")), ref)
    k = H.k_at(sw["ts"].to_numpy() - 1.0, sessions)
    F = (k["k"] * H.asof_lookup(ref, sw["ts"].to_numpy() - 1.0)["px"]).to_numpy()
    P = F / np.exp(s1["gap_bps"].to_numpy() / 1e4)
    pm = sw.unique("ts", keep="last", maintain_order=True)
    exp = (pl.DataFrame({"tq": sw["ts"] - 1.0}).with_row_index()
           .sort("tq").join_asof(pm.rename({"ts": "tq"}), on="tq", strategy="backward").sort("index")["mid_after"].to_numpy())
    m = np.isfinite(P) & np.isfinite(exp)
    assert m.sum() > 1000 and np.allclose(P[m], exp[m], rtol=1e-12)


def test_timeline_fixed_window_hours():
    ref, sw = _market()
    sessions = H.calibrate_k(sw.select("ts", pl.col("mid_after").alias("mid")), ref)
    tl = G.timeline(sw, ref, sessions).with_columns(pl.lit(NV).alias("pool"))
    assert tl["dur"].sum() == pytest.approx(sw["ts"].max() - sw["ts"].min())
    hours = lambda win: tl.filter(G.decide(tl, win, None))["dur"].sum() / 3600
    assert hours("R1") == pytest.approx(10.0)                    # Mon–Fri × 2 h
    assert hours("R3") == pytest.approx((25 + 5 * 25) / 60)      # Sun 19:50–20:15 + 5 × 09:20–09:45
    assert hours(None) == 0.0


# ───────────── real data ─────────────

@pytest.fixture(scope="module")
def nvda_real():
    if not HAVE_DATA:
        pytest.skip("real data not available")
    t_from = _ts(2026, 9, 8, 0)
    sw = (pl.scan_parquet(G.SWAPS).filter((pl.col("pool") == NV) & (pl.col("ts") >= t_from))
          .select("block", "tx_index", "log_index", "ts", "mid_after").collect().sort("block", "tx_index", "log_index"))
    refs = G.build_refs()
    return sw, {k: v[NV] for k, v in refs.items()}


def test_lag0_equals_hl_ref_gap(nvda_real):
    sw, refs = nvda_real
    s = _states(refs["fine"], sw, 0.0)
    hm = (pl.scan_parquet(G.HL_MARKOUTS).filter(pl.col("pool") == NV)
          .select("block", "tx_index", "log_index", "gap_pre_bps").collect())
    # sessions are rebuilt from Sep 8 on here, so compare after the Sep 8 close (earlier k needs earlier sessions)
    j = (sw.with_columns(s["gap_bps"]).join(hm, on=["block", "tx_index", "log_index"], how="left")
         .filter(pl.col("ts") > _ts(2026, 9, 8, 16, 0)))
    assert j.height > 500_000
    # identical computation; only libm ulp noise when hl_markouts was written on another platform (e.g. the Linux server)
    assert j.select((pl.col("gap_bps") - pl.col("gap_pre_bps")).abs().max()).item() < 1e-9


@pytest.mark.parametrize("ref_kind,lag", [("fine", 0.0), ("fine", 1.0), ("fine", 5.0), ("15m", 0.0)])
def test_no_lookahead_real_nvda(nvda_real, ref_kind, lag):
    """Perturb every HL point and every pool price after a cutoff: decisions for swaps up to the cutoff are identical."""
    sw, refs = nvda_real
    cut = _ts(2026, 9, 16, 14, 3, 17.5)
    ref2, sw2 = _perturb(refs[ref_kind], sw.select("ts", "mid_after"), cut)
    a, b = _states(refs[ref_kind], sw.select("ts", "mid_after"), lag), _states(ref2, sw2, lag)
    before = pl.Series((sw["ts"] <= cut).to_numpy())
    assert a.filter(before).equals(b.filter(before))
    pre_a, pre_b = (_pre(sw["ts"], x["gap_bps"].fill_nan(0.0).fill_null(0.0), x["gap_ok"]) for x in (a, b))
    for win in [None, "R1", "R3"]:
        da, db = G.decide(pre_a, win, _phi(5.0)), G.decide(pre_b, win, _phi(5.0))
        assert da.filter(before).equals(db.filter(before))
    assert G.decide(pre_a, None, _phi(5.0)).filter(before).sum() > 1000
    assert not G.decide(pre_a, None, _phi(5.0)).filter(~before).equals(G.decide(pre_b, None, _phi(5.0)).filter(~before))


def test_pipeline_decisions_ignore_outcome_columns():
    """Real SPY/USDG frame through the real pipeline pieces: scrambling every post-trade column changes no decision."""
    if not HAVE_DATA:
        pytest.skip("real data not available")
    df = G.load_inputs(pools=["SPY/USDG"])
    refs = G.build_refs()
    df, _, checks = G.add_states(df, {k: {"SPY/USDG": v["SPY/USDG"]} for k, v in refs.items()})
    assert checks["SPY/USDG"]["max_abs_gap_diff_bps"] < 1e-9 and checks["SPY/USDG"]["ok_flag_mismatches"] == 0
    post = ["mid_after", "vol_usd", "fee_usd", "picked_usd_1h", "picked_hl_1h", "picked_hl_5m", "net"]
    df2 = df.with_columns([(pl.col(c) * -3.0 + 1.0) for c in post] + [~pl.col("valid_1h"), ~pl.col("valid_hl_1h"), ~pl.col("valid_hl_5m")])
    phi = _phi(10.0, pool="SPY/USDG")
    for st in G.STATES:
        for win in [None, "R1", "R3"]:
            assert G.decide(G.pre_view(df, st.key), win, phi).equals(G.decide(G.pre_view(df2, st.key), win, phi))


def test_r0_reproduces_baselines():
    if not (HAVE_DATA and M0_BY_POOL.exists() and HL_BY_POOL.exists()):
        pytest.skip("real data not available")
    df = G.load_inputs()
    m0 = pl.read_parquet(M0_BY_POOL)
    hl = pl.read_parquet(HL_BY_POOL)
    none = lambda d: pl.Series([False] * d.height)
    # M0: fees over every swap, self picked over valid_1h swaps
    e_all = G.evaluate(df, none(df), ["pool"])
    v = df.filter(pl.col("valid_1h"))
    e_v = G.evaluate(v, none(v), ["pool"])
    # hl_ref same-swap table: swaps valid for both the HL and the self 1h markout = this module's universe
    u = df.filter(pl.col("in_universe"))
    e_u = G.evaluate(u, none(u), ["pool"])
    for pool in m0["pool"].to_list():
        r = m0.filter(pl.col("pool") == pool).row(0, named=True)
        a = e_all.filter(pl.col("pool") == pool).row(0, named=True)
        b = e_v.filter(pl.col("pool") == pool).row(0, named=True)
        assert a["n_swaps"] == r["swaps"] and a["fees"] == pytest.approx(r["fee_usd"], rel=1e-12)
        assert b["picked_self_1h"] == pytest.approx(r["picked_1h"], rel=1e-12)
        h = hl.filter(pl.col("pool") == pool).row(0, named=True)
        c = e_u.filter(pl.col("pool") == pool).row(0, named=True)
        assert c["n_swaps"] == h["n_1h"]
        assert c["fees"] == pytest.approx(h["fee_1h"], rel=1e-12)
        assert c["picked_hl_1h"] == pytest.approx(h["picked_hl_1h"], rel=1e-12)
        assert c["picked_self_1h"] == pytest.approx(h["picked_self_1h"], rel=1e-12)
        assert c["edge_hl_1h_r0"] == pytest.approx(h["edge_hl_1h"], rel=1e-12)


# ───────────── the written outputs ─────────────

@pytest.fixture(scope="module")
def outputs():
    if not HAVE_OUT:
        pytest.skip("run `uv run python -m backtest.gap_exclusion` first")
    names = ["results", "phi", "grid", "daily", "bootstrap", "bursts", "gap_dist"]
    if not all((OUT / f"{n}.parquet").exists() for n in names):
        pytest.skip("outputs predate this version; re-run `uv run python -m backtest.gap_exclusion`")
    return {n: pl.read_parquet(OUT / f"{n}.parquet") for n in names}


def test_outputs_r0_full_matches_hl_ref(outputs):
    if not HL_BY_POOL.exists():
        pytest.skip("hl_ref outputs missing")
    res, hl = outputs["results"], pl.read_parquet(HL_BY_POOL)
    for h in hl.iter_rows(named=True):
        r = res.filter((pl.col("period") == "FULL") & (pl.col("rule") == "R0") & (pl.col("pool") == h["pool"])
                       & (pl.col("slice_kind") == "all")).row(0, named=True)
        assert r["n_swaps"] == h["n_1h"] and r["fees"] == pytest.approx(h["fee_1h"], rel=1e-12)
        assert r["picked_hl_1h"] == pytest.approx(h["picked_hl_1h"], rel=1e-12)
        assert r["d_net_hl_1h"] == 0 and r["n_absent"] == 0 and r["hours_absent"] == 0


def test_outputs_structure(outputs):
    res = outputs["results"]
    a = res.filter(pl.col("slice_kind") == "all")
    for per in ["TRAIN", "TEST"]:
        for pool in [NV, "TSLA/USDG", "SPY/USDG", "ALL"]:
            got = set(a.filter((pl.col("period") == per) & (pl.col("pool") == pool))["rule"].to_list())
            assert {"R0", "R1", "R2", "R3", "R4", "R5", "R2@1s", "R2@5s", "R2/15m", "R2g", "R2g/15m"} <= got
    assert set(a.filter(pl.col("rule") == "R2*")["period"].unique().to_list()) == {"TEST"}
    r0 = a.filter(pl.col("rule") == "R0")
    assert (r0["n_absent"] == 0).all() and (r0["d_net_hl_1h"].abs() < 1e-9).all()
    per_pool = a.filter(pl.col("pool") != "ALL")
    assert per_pool["hours_absent"].null_count() == 0
    # ALL = sum of pools
    for per in ["TRAIN", "TEST"]:
        for rule in ["R1", "R2"]:
            x = a.filter((pl.col("period") == per) & (pl.col("rule") == rule))
            assert x.filter(pl.col("pool") == "ALL")["net_hl_1h"].item() == pytest.approx(
                x.filter(pl.col("pool") != "ALL")["net_hl_1h"].sum(), rel=1e-9)
    # the regime-group slices add up to the pool total
    g = res.filter((pl.col("period") == "TEST") & (pl.col("pool") == NV) & (pl.col("rule") == "R2") & (pl.col("slice_kind") == "regime_group"))
    tot = a.filter((pl.col("period") == "TEST") & (pl.col("pool") == NV) & (pl.col("rule") == "R2"))
    assert g["net_hl_1h"].sum() == pytest.approx(tot["net_hl_1h"].item(), rel=1e-9)
    assert g["hours_absent"].sum() == pytest.approx(tot["hours_absent"].item(), rel=1e-9)


def test_outputs_phi_is_the_train_argmax(outputs):
    phi, grid = outputs["phi"], outputs["grid"]
    for fam in ["R2", "R4", "R5"]:
        for st in G.STATES:
            chosen = (phi.filter((pl.col("family") == fam) & (pl.col("state") == st.key) & (pl.col("fit_on") == "TRAIN")
                                 & (pl.col("period") == "TRAIN")).select("pool", "grp", "phi").sort("pool", "grp"))
            refit = G.choose_phi(grid.filter((pl.col("family") == fam) & (pl.col("state") == st.key) & (pl.col("period") == "TRAIN"))
                                 .select("pool", "grp", "n", "phi", "net_kept", "n_absent")).sort("pool", "grp")
            assert chosen.equals(refit), (fam, st.key)


def test_outputs_daily_sums_to_period(outputs):
    res, daily = outputs["results"], outputs["daily"]
    for rule in ["R1", "R2", "R5"]:
        s = daily.filter((pl.col("period") == "TEST") & (pl.col("pool") == NV) & (pl.col("rule") == rule))["net_kept"].sum()
        r = res.filter((pl.col("period") == "TEST") & (pl.col("pool") == NV) & (pl.col("rule") == rule) & (pl.col("slice_kind") == "all"))
        assert s == pytest.approx(r["net_hl_1h"].item(), rel=1e-9)


def test_outputs_fixed_window_slices_add_up(outputs):
    res, daily, boot = outputs["results"], outputs["daily"], outputs["bootstrap"]
    for per in ["TRAIN", "TEST"]:
        for pool in [NV, "ALL"]:
            for rule in ["R1", "R2", "R2g", "R5"] + (["R2/15m", "R2*"] if per == "TEST" else []):
                x = res.filter((pl.col("period") == per) & (pl.col("pool") == pool) & (pl.col("rule") == rule))
                tot = x.filter(pl.col("slice_kind") == "all").row(0, named=True)
                sl = x.filter(pl.col("slice_kind") == "fixed_window")
                assert set(sl["slice"].to_list()) <= set(G.FIXED_WIN_SLICES)
                assert sl["d_net_hl_1h"].sum() == pytest.approx(tot["d_net_hl_1h"], rel=1e-9, abs=1e-6)
                assert sl["n_absent"].sum() == tot["n_absent"]
    # R1's exclusions never sit outside both windows; the daily outside-window Δ adds up to the slice and to the bootstrap
    r1 = res.filter((pl.col("rule") == "R1") & (pl.col("slice_kind") == "fixed_window") & (pl.col("slice") == "outside both"))
    assert (r1["n_absent"] == 0).all()
    for rule in ["R2", "R2/15m"]:
        o = res.filter((pl.col("period") == "TEST") & (pl.col("pool") == NV) & (pl.col("rule") == rule)
                       & (pl.col("slice_kind") == "fixed_window") & (pl.col("slice") == "outside both"))["d_net_hl_1h"].item()
        dd = daily.filter((pl.col("period") == "TEST") & (pl.col("pool") == NV) & (pl.col("rule") == rule))["delta_outside_fixed"].sum()
        b = boot.filter((pl.col("scope") == "outside fixed windows") & (pl.col("pool") == NV) & (pl.col("rule") == rule))["delta"].item()
        assert dd == pytest.approx(o, rel=1e-9, abs=1e-6) and b == pytest.approx(o, rel=1e-9, abs=1e-6)


def test_outputs_guard_consistent(outputs):
    phi = outputs["phi"]
    tr = phi.filter((pl.col("fit_on") == "TRAIN") & (pl.col("period") == "TRAIN"))
    assert tr["guard_pass"].null_count() == 0
    # the guard's TRAIN gain is the φ-curve gain of the chosen φ
    fin = tr.filter(pl.col("phi") < math.inf)
    assert np.allclose(fin["train_gain_unguarded"].to_numpy(), fin["gain"].to_numpy(), rtol=1e-9, atol=1e-6)
    # the pass rule, re-applied to the stored columns
    ok = (fin["gain"] >= G.GUARD_MIN_GAIN) & (fin["train_top_day_share"] <= G.GUARD_MAX_TOP_DAY)
    assert (ok.fill_null(False) == fin["guard_pass"]).all()
    # the guarded table = the TRAIN table with failing cells at ∞
    gd = phi.filter((pl.col("fit_on") == "TRAIN_GUARDED") & (pl.col("period") == "TRAIN"))
    j = gd.join(tr.select("family", "state", "pool", "grp", pl.col("phi").alias("phi_train"), pl.col("guard_pass").alias("gp")),
                on=["family", "state", "pool", "grp"])
    assert j.height == gd.height == tr.height
    exp = j.select(pl.when(pl.col("gp")).then(pl.col("phi_train")).otherwise(math.inf)).to_series()
    assert (exp == j["phi"]).all()


def test_outputs_bursts_match_results(outputs):
    res, bursts = outputs["results"], outputs["bursts"]
    b1 = bursts.filter(pl.col("rank") == 1)
    assert b1.height > 0
    for r in b1.filter(pl.col("rule").is_in(["R1", "R2", "R2/15m"])).iter_rows(named=True):
        tot = res.filter((pl.col("period") == r["period"]) & (pl.col("pool") == r["pool"]) & (pl.col("rule") == r["rule"])
                         & (pl.col("slice_kind") == "all"))["d_net_hl_1h"].item()
        assert r["delta_period"] == pytest.approx(tot, rel=1e-9, abs=1e-6)
    x = bursts.filter((pl.col("period") == "TEST") & (pl.col("pool") == NV) & (pl.col("rule") == "R2/15m")).sort("rank")
    assert (x["delta"].diff().drop_nulls() <= 0).all()


def test_outputs_report_claims():
    """The report's claims are generated from the data; the phrases an earlier version hard-coded are gone."""
    md = OUT / "backtest.md"
    if not md.exists():
        pytest.skip("run the module first")
    text = md.read_text()
    for bad in ["The gap signal is real", "transfers when reference quality is held fixed", "the gap signal does transfer",
                "none of the rule differences is statistically distinguishable", "R4/R5 used it", "was positive in both periods: "]:
        assert bad not in text, bad
    assert "Of " in text and "bootstrapped comparisons" in text and "Thin φ cells" in text
