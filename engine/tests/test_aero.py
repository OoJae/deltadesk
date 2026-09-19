"""Aerodrome (Base) logic on synthetic data: reward sweep, staking overlay, reward schedule."""

import numpy as np
import polars as pl
import pytest

from aero import positions as AP
from aero import study as AS

G = AS.GAUGE


def _prices(px=2.0):
    return pl.DataFrame({"ts": [0.0], "aero_usd": [px]})


def _sched(rate=1.0, t0=0.0, t1=1_000.0):
    return pl.DataFrame({"start_ts": [t0], "end_ts": [t1], "rate_aero_s": [rate]})


def _seg(rows):
    """rows: (pos_id, start_ts, end_ts|None, L, lower, upper, staked)."""
    ticks = np.unique(np.array([r[4] for r in rows] + [r[5] for r in rows]))
    df = pl.DataFrame([{"pos_id": r[0], "start_ts": r[1], "end_ts": r[2], "L": float(r[3]), "lower": r[4], "upper": r[5], "staked": r[6]} for r in rows],
                      schema={"pos_id": pl.Utf8, "start_ts": pl.Int64, "end_ts": pl.Int64, "L": pl.Float64, "lower": pl.Int64, "upper": pl.Int64, "staked": pl.Boolean})
    df = df.with_columns(pl.Series("a_lo", np.searchsorted(ticks, df["lower"].to_numpy(), side="right")),
                         pl.Series("a_hi", np.searchsorted(ticks, df["upper"].to_numpy(), side="right")))
    return df, ticks


def _path(points):
    return pl.DataFrame({"ts": [float(t) for t, _ in points], "tick": [k for _, k in points]})


def test_reward_sweep_pro_rata_and_conserved():
    # two staked positions over the same range, L 1 and 3, both in range the whole time: rate·T split 1:3
    seg, ticks = _seg([("a", 0, 100, 1, -10, 10, True), ("b", 0, 100, 3, -10, 10, True)])
    aero, usd, d = AP.reward_sweep(seg, _path([(0, 0)]), _sched(1.0), _prices(2.0), ticks, 100.0)
    assert aero == pytest.approx([25.0, 75.0])
    assert usd == pytest.approx([50.0, 150.0])  # valued at accrual
    assert d["aero_paid_to_staked"] == pytest.approx(100.0) and d["aero_unpaid_no_staked_in_range"] == 0


def test_reward_sweep_out_of_range_and_unstaked_earn_nothing():
    # price leaves the range at t=40: no staked liquidity in range → rewards roll over (unpaid), not attributed
    seg, ticks = _seg([("a", 0, 100, 2, -10, 10, True), ("u", 0, 100, 5, -10, 10, False)])
    aero, _, d = AP.reward_sweep(seg, _path([(0, 0), (40, 20)]), _sched(1.0), _prices(), ticks, 100.0)
    assert aero == pytest.approx([40.0, 0.0])
    assert d["aero_unpaid_no_staked_in_range"] == pytest.approx(60.0)


def test_reward_sweep_late_joiner_and_exit():
    # a alone for 50 s, then b (equal L) joins for 30 s, then b leaves: a = 50 + 15 + 20, b = 15
    seg, ticks = _seg([("a", 0, 100, 1, -10, 10, True), ("b", 50, 80, 1, -10, 10, True)])
    aero, _, _ = AP.reward_sweep(seg, _path([(0, 0)]), _sched(1.0), _prices(), ticks, 100.0)
    assert aero == pytest.approx([85.0, 15.0])


def test_reward_sweep_rate_schedule_boundaries():
    # rate 1 until t=30, then no emissions, then 2 from t=60 (schedule gap): a earns 30 + 2·40
    seg, ticks = _seg([("a", 0, 100, 1, -10, 10, True)])
    sched = pl.DataFrame({"start_ts": [0.0, 60.0], "end_ts": [30.0, 1_000.0], "rate_aero_s": [1.0, 2.0]})
    aero, _, _ = AP.reward_sweep(seg, _path([(0, 0)]), sched, _prices(), ticks, 100.0)
    assert aero == pytest.approx([110.0])


def test_staked_segments_depositor_from_transfer_into_gauge():
    seg = pl.DataFrame({"pos_id": ["p", "p", "p"], "start_ord": [10, 20, 30], "seg_owner": ["0xu", G, "0xu"]})
    tr = pl.DataFrame({"pos_id": ["p", "p", "p"], "ord": [5, 20, 30], "from": ["0x" + "0" * 40, "0xu", G], "to": ["0xu", G, "0xu"]})
    s = AP.staked_segments(seg, tr).sort("start_ord")
    assert s["staked"].to_list() == [False, True, False]
    assert s["depositor"].to_list() == [None, "0xu", None]
    assert s["beneficiary"].to_list() == ["0xu", "0xu", "0xu"]


def test_reward_schedule_leftover_and_epoch(monkeypatch):
    # CLGauge._notifyRewardAmount: first notify → amount / time-to-flip; a second notify in the same epoch adds the leftover
    wk = AS.WEEK
    t1 = 100 * wk + 1_000.0          # 1000 s after an epoch flip
    t2 = t1 + 10_000.0
    amt = lambda a: "0x" + format(int(a * 1e18), "064x")  # noqa: E731
    ev = pl.DataFrame({"ts": [t1, t2], "data": [amt(700.0), amt(300.0)]})
    monkeypatch.setattr(AS, "gauge_logs", lambda topics: ev)
    s = AS.reward_schedule()
    r1 = 700.0 / (101 * wk - t1)
    r2 = (300.0 + (101 * wk - t2) * r1) / (101 * wk - t2)
    assert s["rate_aero_s"].to_list() == pytest.approx([r1, r2])
    assert s["end_ts"].to_list() == pytest.approx([t2, 101 * wk])  # the first rate is superseded at t2
    assert AS.epoch_next(t1) == 101 * wk


def test_reward_sweep_ignores_segments_after_data_end():
    # c starts after the data end (an LP event after the last swap): it earns nothing and does not dilute or inflate a
    seg, ticks = _seg([("a", 0, None, 1, -10, 10, True), ("c", 150, None, 5, -10, 10, True)])
    aero, _, d = AP.reward_sweep(seg, _path([(0, 0)]), _sched(1.0), _prices(), ticks, 100.0)
    assert aero == pytest.approx([100.0, 0.0])
    assert sum(aero) == pytest.approx(d["aero_paid_to_staked"])
