"""M1 · Module D: would pulling liquidity when the pool is stale vs Hyperliquid fair value have kept the LP fees
while avoiding the informed flow, out of sample?

Pool-level counterfactual. For every swap an LP book is either PRESENT (earns the swap's LP fee, eats its picked-off)
or ABSENT (both excluded). A rule decides per swap from information available before the swap only:

    R0  always in (baseline)
    R1  fixed open window: absent Mon–Fri 09:00–10:59 ET
    R2  gap rule: absent if |gap_pre_bps| > φ(pool, regime group); groups REGULAR / EXTENDED / OVERNIGHT / DARK
        (DARK = WEEKEND_DARK + HOLIDAY). gap_pre_bps = 1e4·ln(F_pre / P_pool_before) from markout.hl_ref:
        F_pre = k·HL(latest point ≤ t), k from the last session closed before t, P_pool_before = previous swap's
        mid_after. No usable signal (stale HL point, k look-ahead, no previous swap) ⇒ present.
    R3  reopen guard: absent Sun 19:50–20:15 ET and Mon–Fri 09:20–09:45 ET
    R4  R2 ∪ R3            R5  R1 ∪ R2

φ is grid-searched per (pool, regime group) on TRAIN (ET dates 2026-07-28..08-31) maximising LP net vs HL at 1h
(fees kept − picked_hl_1h kept) and applied unchanged to TEST (2026-09-01..09-18). For R4/R5, φ is fitted jointly with
the fixed window (only swaps outside the window matter). Robustness: the whole protocol again with a decision lag
L ∈ {1 s, 5 s} (HL ≤ t−L, k as of t−L, pool state after the last swap with ts ≤ t−L), an in-sample ceiling R2*
(φ fitted on TEST itself), and a guarded variant R2g: a TRAIN-fitted φ cell is kept only if its TRAIN gain is at least
GUARD_MIN_GAIN and no single TRAIN day supplies more than GUARD_MAX_TOP_DAY of it (otherwise φ = ∞). The guard is fixed
before looking at TEST and reads TRAIN only.

Diagnostics for reading the result: Δ split by fixed window (inside R3 / inside R1 but not R3 / outside both), the best
ET hours per rule (bursts.parquet), the |gap| distribution per period and reference (gap_dist.parquet), and day
concentration for TRAIN as well as TEST.

Universe = swaps valid for both the HL 1h and M0's self 1h markout (the same swaps as hl_ref's comparison tables).
Metrics per rule × pool × period: fees kept %, picked-off avoided % (HL 1h, HL 5m, self 1h), edge = fees / picked,
net USD, net bp of volume, absent swaps, absent hours (time the book is out, replaying the pre-trade state as a step
function between swaps).

Caveat: this is a pool-level counterfactual. The LP's absence is assumed not to change prices or flow.

    uv run python -m backtest.gap_exclusion
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
import polars as pl

from markout import hl_ref as H
from markout.pools import DATA
from markout.study import regime_expr

ET_NAME = "America/New_York"
ET = ZoneInfo(ET_NAME)
SWAPS = DATA / "study" / "m0" / "swaps.parquet"
HL_MARKOUTS = DATA / "study" / "m1" / "hl_ref" / "hl_markouts.parquet"
OUT = DATA / "study" / "m1" / "backtest"
KEY = ["pool", "block", "tx_index", "log_index"]

PERIODS: dict[str, tuple[date, date]] = {"TRAIN": (date(2026, 7, 28), date(2026, 8, 31)),
                                         "TEST": (date(2026, 9, 1), date(2026, 9, 18))}
GROUPS = ["REGULAR", "EXTENDED", "OVERNIGHT", "DARK"]
GROUP_OF = {"REGULAR": "REGULAR", "EXTENDED": "EXTENDED", "OVERNIGHT": "OVERNIGHT", "WEEKEND_DARK": "DARK", "HOLIDAY": "DARK"}
PHI_GRID = [0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 8.0, 10.0, 12.0, 15.0, 20.0, 25.0, 30.0, 40.0, 50.0, 60.0, 80.0,
            100.0, 150.0, 200.0, math.inf]
GRID_S = 60.0                                            # timeline grid: every regime / window boundary is on a minute
PRE_COLS = ["pool", "ts", "grp", "gap_bps", "gap_ok"]    # the whole information set a decision may read
TIE_TOL = 1e-6
BOOT_B = 5000
RES_CLASSES = ["<=1m", "5m", "15m", "1h"]
POOL_ORDER = ["NVDA/USDG", "TSLA/USDG", "SPY/USDG", "QQQ/SPY", "ALL"]
GUARD_MIN_GAIN = 250.0          # USD: a fitted φ cell must gain at least this much over its TRAIN period ...
GUARD_MAX_TOP_DAY = 0.5         # ... and its single best TRAIN day may supply at most this share of that gain
FIXED_WIN_SLICES = ["in R3", "in R1 not R3", "outside both"]
HOLIDAYS = {date(2026, 9, 7): "Labor Day"}   # the only exchange holiday inside TRAIN ∪ TEST (M0 regime = HOLIDAY)


# ─────────────────────────────── pre-trade state variants & rules ───────────────────────────────

@dataclass(frozen=True)
class State:
    """One version of the pre-trade information set (the gap an LP could observe before a swap)."""
    key: str            # column suffix: gap_bps_<key>, gap_ok_<key>
    lag: float          # decision lag in seconds
    ref: str            # "fine" = hl_ref's finest-source HL reference; "15m" = 15m candles (1h before they start)
    suffix: str         # rule-name suffix
    label: str


STATES = [
    State("L0", 0.0, "fine", "", "spec: hl_ref F_pre / P_pool_before"),
    State("L1", 1.0, "fine", "@1s", "decision lag 1 s"),
    State("L5", 5.0, "fine", "@5s", "decision lag 5 s"),
    State("C15", 0.0, "15m", "/15m", "15m-or-coarser HL reference in TRAIN and TEST (like-for-like)"),
]
STATE = {s.key: s for s in STATES}


@dataclass(frozen=True)
class Rule:
    name: str
    window: str | None = None        # fixed calendar leg: "R1" | "R3" | None
    family: str | None = None        # gap leg: whose φ table ("R2" | "R4" | "R5"), None = no gap leg
    state: str = "L0"                # which pre-trade information set the gap leg reads
    fit_on: str = "TRAIN"            # "TRAIN" = out of sample on TEST; "TEST" = in-sample ceiling
    periods: tuple[str, ...] = ("TRAIN", "TEST")
    desc: str = ""

    @property
    def phi_key(self) -> tuple[str, str, str] | None:
        return (self.family, self.state, self.fit_on) if self.family else None


FAMILY_WINDOW = {"R2": None, "R4": "R3", "R5": "R1"}


def all_rules() -> list[Rule]:
    fixed = ("TRAIN", "TEST", "FULL")
    out = [Rule("R0", desc="always in", periods=fixed),
           Rule("R1", window="R1", desc="fixed: out Mon–Fri 09:00–10:59 ET", periods=fixed),
           Rule("R3", window="R3", desc="reopen guard: out Sun 19:50–20:15 + Mon–Fri 09:20–09:45 ET", periods=fixed)]
    for st in STATES:
        x = "" if st.key == "L0" else f" [{st.label}]"
        out += [Rule(f"R2{st.suffix}", family="R2", state=st.key, desc=f"gap: out if |gap| > φ(regime){x}"),
                Rule(f"R4{st.suffix}", window="R3", family="R4", state=st.key, desc=f"gap ∪ reopen guard{x}"),
                Rule(f"R5{st.suffix}", window="R1", family="R5", state=st.key, desc=f"gap ∪ fixed 09:00–10:59{x}")]
    guard = f"φ cells with TRAIN gain < ${GUARD_MIN_GAIN:,.0f} or > {GUARD_MAX_TOP_DAY:.0%} of it on one day set to ∞"
    out += [Rule("R2g", family="R2", state="L0", fit_on="TRAIN_GUARDED", desc=f"gap rule, {guard}"),
            Rule("R2g/15m", family="R2", state="C15", fit_on="TRAIN_GUARDED", desc=f"gap rule, {guard} [{STATE['C15'].label}]")]
    out.append(Rule("R2*", family="R2", fit_on="TEST", periods=("TEST",), desc="gap rule with φ fitted on TEST (in-sample ceiling)"))
    return out


# ─────────────────────────────── calendar (ET, DST aware) ───────────────────────────────

def _et(col: str = "ts") -> pl.Expr:
    return (pl.from_epoch((pl.col(col) * 1000).floor().cast(pl.Int64), time_unit="ms")
            .dt.replace_time_zone("UTC").dt.convert_time_zone(ET_NAME))


def _dow_mins(col: str = "ts") -> tuple[pl.Expr, pl.Expr]:
    et = _et(col)
    return et.dt.weekday(), et.dt.hour().cast(pl.Int32) * 60 + et.dt.minute().cast(pl.Int32)


def et_date_expr(col: str = "ts") -> pl.Expr:
    return _et(col).dt.date().alias("date_et")


def hour_et_expr(col: str = "ts") -> pl.Expr:
    return _et(col).dt.hour().cast(pl.Int32).alias("hour_et")


def r1_window_expr(col: str = "ts") -> pl.Expr:
    """Mon–Fri 09:00–10:59 ET (every weekday, holidays included: a fixed schedule)."""
    dow, m = _dow_mins(col)
    return (dow <= 5) & (m >= 9 * 60) & (m < 11 * 60)


def r3_window_expr(col: str = "ts") -> pl.Expr:
    """Sun 19:50–20:15 ET (Sunday reopen) and Mon–Fri 09:20–09:45 ET (cash open)."""
    dow, m = _dow_mins(col)
    return (((dow == 7) & (m >= 19 * 60 + 50) & (m < 20 * 60 + 15))
            | ((dow <= 5) & (m >= 9 * 60 + 20) & (m < 9 * 60 + 45)))


WINDOWS = {"R1": r1_window_expr, "R3": r3_window_expr}


def fixed_window_expr(col: str = "ts") -> pl.Expr:
    """Which fixed calendar window a swap falls in: 'in R3' (reopen guard), 'in R1 not R3', 'outside both'.
    Used to ask whether a gap rule's gain is schedule-like (it sits inside the fixed windows) or not."""
    return (pl.when(r3_window_expr(col)).then(pl.lit(FIXED_WIN_SLICES[0]))
            .when(r1_window_expr(col)).then(pl.lit(FIXED_WIN_SLICES[1]))
            .otherwise(pl.lit(FIXED_WIN_SLICES[2])).alias("fixed_win"))


def group_expr(regime_col: str = "regime") -> pl.Expr:
    return pl.col(regime_col).replace_strict(GROUP_OF, return_dtype=pl.String).alias("grp")


def period_expr(date_col: str = "date_et") -> pl.Expr:
    d = pl.col(date_col)
    e = pl.lit(None, pl.String)
    for name, (a, b) in reversed(list(PERIODS.items())):
        e = pl.when(d.is_between(pl.lit(a), pl.lit(b))).then(pl.lit(name)).otherwise(e)
    return e.alias("period")


def res_class_expr() -> pl.Expr:
    r = pl.col("ref_res_s")
    return (pl.when(r <= 60).then(pl.lit("<=1m")).when(r <= 300).then(pl.lit("5m")).when(r <= 900).then(pl.lit("15m"))
            .otherwise(pl.lit("1h")).alias("res_class"))


# ─────────────────────────────── pre-trade state (causal) ───────────────────────────────

def _gap_frame(k: pl.DataFrame, pre: pl.DataFrame, P: pl.Series, t: np.ndarray) -> pl.DataFrame:
    d = pl.DataFrame({"F": k["k"] * pre["px"], "P": P.cast(pl.Float64).rename("P"), "age": pl.Series(t) - pre["pt_ts"],
                      "res": pre["res"], "kla": k["k_lookahead"]})
    gap = 1e4 * (pl.col("F") / pl.col("P")).log()
    ok = ((pl.col("age") <= pl.max_horizontal(pl.col("res"), pl.lit(H.MIN_STALE_S))) & ~pl.col("kla") & gap.is_finite())
    return d.select(gap.alias("gap_bps"), ok.fill_null(False).alias("gap_ok"))


def pre_trade_state(sw: pl.DataFrame, ref: pl.DataFrame, sessions: pl.DataFrame, lag_s: float = 0.0) -> pl.DataFrame:
    """Gap the LP can observe before each swap of ONE pool (`sw` in chain order with ts, mid_after):
    HL points with ts ≤ t−L, k of the last session closed before t−L, and pool state
        L = 0: the previous swap's mid_after (P_pool_before, exactly markout.hl_ref's gap_pre_bps)
        L > 0: mid_after of the last swap with ts ≤ t−L (so same-second swaps cannot inform the decision).
    Returns gap_bps and gap_ok (fresh HL point, no k look-ahead, both prices known), in swap order."""
    t = sw["ts"].cast(pl.Float64).to_numpy() - lag_s
    k = H.k_at(t, sessions)
    pre = H.asof_lookup(ref, t)
    if lag_s == 0:
        P = sw["mid_after"].shift(1)
    else:
        pm = (sw.select(pl.col("ts").cast(pl.Float64).alias("tq"), pl.col("mid_after").alias("P"))
              .unique("tq", keep="last", maintain_order=True).sort("tq"))
        P = (pl.DataFrame({"row": np.arange(len(t)), "tq": t}).sort("tq")
             .join_asof(pm, on="tq", strategy="backward").sort("row")["P"])
    return _gap_frame(k, pre, P, t)


def timeline(sw: pl.DataFrame, ref: pl.DataFrame, sessions: pl.DataFrame, grid_s: float = GRID_S) -> pl.DataFrame:
    """The pre-trade state of ONE pool as a step function of time between its first and last swap. Change points:
    swap seconds (pool state after the last swap in that second), HL reference points, and a 60 s grid (every regime
    and window boundary is on a minute). Row i holds from `ts` for `dur` seconds."""
    pm = (sw.select(pl.col("ts").cast(pl.Float64), pl.col("mid_after").alias("P"))
          .unique("ts", keep="last", maintain_order=True).sort("ts"))
    t0, t1 = float(pm["ts"][0]), float(pm["ts"][-1])
    grid = np.arange(math.ceil(t0 / grid_s) * grid_s, t1, grid_s)
    taus = pl.concat([pm.select("ts"), pl.DataFrame({"ts": grid}),
                      ref.select(pl.col("ts").cast(pl.Float64)).filter(pl.col("ts").is_between(t0, t1))]).unique().sort("ts")
    tl = taus.join_asof(pm, on="ts", strategy="backward")
    t = tl["ts"].to_numpy()
    g = _gap_frame(H.k_at(t, sessions), H.asof_lookup(ref, t), tl["P"], t)
    return (tl.with_columns(g["gap_bps"], g["gap_ok"], (pl.col("ts").shift(-1) - pl.col("ts")).fill_null(0.0).alias("dur"))
            .with_columns(*regime_expr()).with_columns(group_expr(), period_expr()))


# ─────────────────────────────── decisions ───────────────────────────────

def _phi_expr(phi: pl.DataFrame | None) -> pl.Expr:
    if phi is None or phi.is_empty():
        return pl.lit(math.inf)
    mapping = {f"{r['pool']}|{r['grp']}": float(r["phi"]) for r in phi.iter_rows(named=True)}
    return (pl.concat_str([pl.col("pool"), pl.col("grp")], separator="|")
            .replace_strict(mapping, default=math.inf, return_dtype=pl.Float64))


def decide(pre: pl.DataFrame, window: str | None = None, phi: pl.DataFrame | None = None) -> pl.Series:
    """absent (bool) per row, reading ONLY the pre-trade information set PRE_COLS:
    fixed calendar window on ts (ET) ∪ (usable gap ∧ |gap_bps| > φ(pool, grp)). phi: (pool, grp, phi); missing = ∞."""
    pre = pre.select(PRE_COLS)
    m = WINDOWS[window]() if window else pl.lit(False)
    if phi is not None:
        m = m | (pl.col("gap_ok") & (pl.col("gap_bps").abs() > _phi_expr(phi))).fill_null(False)
    return pre.with_columns(m.fill_null(False).alias("absent"))["absent"]  # with_columns broadcasts a bare literal


def pre_view(df: pl.DataFrame, state: str) -> pl.DataFrame:
    """The pre-trade columns of one state variant (gap_bps_<key>, gap_ok_<key> → gap_bps, gap_ok)."""
    return df.select("pool", "ts", "grp", pl.col(f"gap_bps_{state}").alias("gap_bps"), pl.col(f"gap_ok_{state}").alias("gap_ok"))


# ─────────────────────────────── φ grid search ───────────────────────────────

def phi_curve(pre: pl.DataFrame, net: pl.Series, window: str | None, grid: list[float] = PHI_GRID) -> pl.DataFrame:
    """Σ net over kept swaps for every φ in the grid, per (pool, grp). `pre` = PRE_COLS frame of one period."""
    d = pre.select(PRE_COLS).with_columns(net.alias("net"), (WINDOWS[window]() if window else pl.lit(False)).alias("_w"))
    big = lambda phi: (pl.col("gap_ok") & (pl.col("gap_bps").abs() > phi)).fill_null(False)
    aggs = []
    for i, phi in enumerate(grid):
        keep = ~pl.col("_w") & ~big(phi)
        aggs += [pl.col("net").filter(keep).sum().alias(f"net_{i}"), (~keep).sum().alias(f"nabs_{i}")]
    wide = d.group_by("pool", "grp").agg(pl.len().alias("n"), *aggs)
    return pl.concat([wide.select("pool", "grp", "n", pl.lit(float(phi)).alias("phi"), pl.col(f"net_{i}").alias("net_kept"),
                                  pl.col(f"nabs_{i}").cast(pl.UInt32).alias("n_absent"))
                      for i, phi in enumerate(grid)]).sort("pool", "grp", "phi")


def choose_phi(curve: pl.DataFrame) -> pl.DataFrame:
    """argmax net_kept per (pool, grp); ties (within TIE_TOL) → the largest φ (least intervention)."""
    return (curve.with_columns(pl.col("net_kept").max().over("pool", "grp").alias("_best"))
            .filter(pl.col("net_kept") >= pl.col("_best") - TIE_TOL)
            .group_by("pool", "grp").agg(pl.col("phi").max()).sort("pool", "grp"))


def fit_phi(pre: pl.DataFrame, net: pl.Series, window: str | None, grid: list[float] = PHI_GRID) -> tuple[pl.DataFrame, pl.DataFrame]:
    curve = phi_curve(pre, net, window, grid)
    return choose_phi(curve), curve


def phi_guard(pre: pl.DataFrame, net: pl.Series, dates: pl.Series, window: str | None, phi: pl.DataFrame,
              min_gain: float = GUARD_MIN_GAIN, max_top_day: float = GUARD_MAX_TOP_DAY) -> pl.DataFrame:
    """How robust each fitted (pool, grp) cell is on the period it was fitted on. The cell's gain is the gap leg's gain
    over the window alone = −Σ net of the swaps that only the gap leg takes out (equal to phi_curve's
    net_kept(φ) − net_kept(∞)), split by ET day. guard_pass = gain ≥ min_gain and best day ≤ max_top_day of the gain.
    `pre`, `net`, `dates` must all come from the fitting period only."""
    d = pre.select(PRE_COLS).with_columns(
        net.alias("net"), dates.alias("date_et"), (WINDOWS[window]() if window else pl.lit(False)).alias("_w"),
        _phi_expr(phi).alias("_phi"))
    d = d.with_columns((~pl.col("_w") & (pl.col("gap_ok") & (pl.col("gap_bps").abs() > pl.col("_phi")))).fill_null(False).alias("_g"))
    n = d.group_by("pool", "grp").agg(pl.len().alias("n"), pl.col("_g").sum().cast(pl.UInt32).alias("n_gap_out"))
    daily = (d.filter(pl.col("_g")).group_by("pool", "grp", "date_et")
             .agg((-pl.col("net").sum()).alias("g"), pl.len().alias("k")))
    per = daily.sort("g", "date_et", descending=[True, False]).group_by("pool", "grp").agg(
        pl.col("g").sum().alias("gain"), pl.len().cast(pl.UInt32).alias("days_out"), (pl.col("g") > 0).sum().cast(pl.UInt32).alias("days_pos"),
        pl.col("date_et").first().alias("top_day"), pl.col("g").first().alias("top_day_gain"),
        pl.col("k").first().cast(pl.UInt32).alias("top_day_n_out"))
    out = (n.join(per, on=["pool", "grp"], how="left").join(phi.select("pool", "grp", "phi"), on=["pool", "grp"], how="left")
           .with_columns(pl.col("phi").fill_null(math.inf), pl.col("gain").fill_null(0.0),
                         pl.col("days_out").fill_null(0), pl.col("days_pos").fill_null(0)))
    out = out.with_columns(pl.when(pl.col("gain") > 0).then(pl.col("top_day_gain") / pl.col("gain")).alias("top_day_share"))
    ok = (pl.col("gain") >= min_gain) & (pl.col("top_day_share") <= max_top_day)
    return out.with_columns(ok.fill_null(False).alias("guard_pass")).sort("pool", "grp")


def guarded(guard: pl.DataFrame) -> pl.DataFrame:
    """φ table with every cell that fails the guard set to ∞ (no gap leg there)."""
    return guard.select("pool", "grp", pl.when(pl.col("guard_pass")).then(pl.col("phi")).otherwise(math.inf).alias("phi"))


# ─────────────────────────────── metrics ───────────────────────────────

def _agg_exprs(a: pl.Expr) -> list[pl.Expr]:
    keep = ~a
    v5 = pl.col("valid_hl_5m")
    s = lambda c, m=None: (pl.col(c) if m is None else pl.col(c).filter(m)).sum()
    return [
        pl.len().alias("n_swaps"), a.sum().alias("n_absent"),
        s("vol_usd").alias("vol"), s("vol_usd", keep).alias("vol_kept"),
        s("fee_usd").alias("fees"), s("fee_usd", keep).alias("fees_kept"),
        s("picked_hl_1h").alias("picked_hl_1h"), s("picked_hl_1h", keep).alias("picked_hl_1h_kept"),
        s("picked_usd_1h").alias("picked_self_1h"), s("picked_usd_1h", keep).alias("picked_self_1h_kept"),
        v5.sum().alias("n_5m"), s("fee_usd", v5).alias("fees_5m"), s("fee_usd", v5 & keep).alias("fees_5m_kept"),
        s("picked_hl_5m", v5).alias("picked_hl_5m"), s("picked_hl_5m", v5 & keep).alias("picked_hl_5m_kept"),
    ]


def _ratio(num: str, den: str) -> pl.Expr:
    """fees / picked; +inf when picked ≤ 0 (LPs earned fees and were not picked off)."""
    return pl.when(pl.col(den) > 0).then(pl.col(num) / pl.col(den)).when(pl.col(num) > 0).then(pl.lit(math.inf)).otherwise(None)


def _avoided(tot: str, kept: str) -> pl.Expr:
    return pl.when(pl.col(tot) > 0).then(1 - pl.col(kept) / pl.col(tot)).otherwise(None)


def finish_metrics(df: pl.DataFrame) -> pl.DataFrame:
    return df.with_columns(
        (pl.col("n_absent") / pl.col("n_swaps")).alias("absent_swap_pct"),
        (pl.col("fees_kept") / pl.col("fees")).alias("fees_kept_pct"),
        _avoided("picked_hl_1h", "picked_hl_1h_kept").alias("avoided_hl_1h_pct"),
        _avoided("picked_hl_5m", "picked_hl_5m_kept").alias("avoided_hl_5m_pct"),
        _avoided("picked_self_1h", "picked_self_1h_kept").alias("avoided_self_1h_pct"),
        _ratio("fees_kept", "picked_hl_1h_kept").alias("edge_hl_1h"),
        _ratio("fees", "picked_hl_1h").alias("edge_hl_1h_r0"),
        _ratio("fees_5m_kept", "picked_hl_5m_kept").alias("edge_hl_5m"),
        _ratio("fees_kept", "picked_self_1h_kept").alias("edge_self_1h"),
        (pl.col("fees_kept") - pl.col("picked_hl_1h_kept")).alias("net_hl_1h"),
        (pl.col("fees") - pl.col("picked_hl_1h")).alias("net_hl_1h_r0"),
        (pl.col("fees_5m_kept") - pl.col("picked_hl_5m_kept")).alias("net_hl_5m"),
        (pl.col("fees_5m") - pl.col("picked_hl_5m")).alias("net_hl_5m_r0"),
        (pl.col("fees_kept") - pl.col("picked_self_1h_kept")).alias("net_self_1h"),
        (pl.col("fees") - pl.col("picked_self_1h")).alias("net_self_1h_r0"),
    ).with_columns(
        (pl.col("net_hl_1h") - pl.col("net_hl_1h_r0")).alias("d_net_hl_1h"),
        (pl.col("net_hl_5m") - pl.col("net_hl_5m_r0")).alias("d_net_hl_5m"),
        (pl.col("net_self_1h") - pl.col("net_self_1h_r0")).alias("d_net_self_1h"),
        (pl.col("net_hl_1h") / pl.col("vol") * 1e4).alias("net_bps_vol"),
        (pl.col("net_hl_1h") / pl.col("vol_kept") * 1e4).alias("net_bps_kept_vol"),
    )


def evaluate(df: pl.DataFrame, absent: pl.Series, by: list[str]) -> pl.DataFrame:
    """Aggregate LP-book metrics over `df` (already restricted to the universe) for one rule's absent flags."""
    return finish_metrics(df.with_columns(absent.alias("_a")).group_by(by).agg(_agg_exprs(pl.col("_a"))))


# ─────────────────────────────── inputs ───────────────────────────────

SW_COLS = [*KEY, "ts", "mid_after", "vol_usd", "fee_usd", "picked_usd_1h", "valid_1h", "regime", "date_et"]
HM_COLS = [*KEY, "gap_pre_bps", "valid_pre", "k_lookahead", "ref_res_s", "picked_hl_1h", "picked_hl_5m", "valid_hl_1h", "valid_hl_5m"]


def load_inputs(swaps: Path = SWAPS, markouts: Path = HL_MARKOUTS, pools: list[str] | None = None) -> pl.DataFrame:
    sw = pl.scan_parquet(swaps).select(SW_COLS)
    hm = pl.scan_parquet(markouts).select(HM_COLS)
    if pools is not None:
        sw, hm = sw.filter(pl.col("pool").is_in(pools)), hm.filter(pl.col("pool").is_in(pools))
    df = sw.join(hm, on=KEY, how="left").collect().sort(KEY)
    return df.with_columns(
        group_expr(), period_expr(), res_class_expr(),
        (pl.col("valid_hl_1h") & pl.col("valid_1h")).fill_null(False).alias("in_universe"),
        pl.col("valid_hl_5m").fill_null(False),
        (pl.col("fee_usd") - pl.col("picked_hl_1h")).alias("net"),
        # L0 = the spec's information set, straight from hl_ref
        pl.col("gap_pre_bps").alias("gap_bps_L0"),
        (pl.col("valid_pre") & ~pl.col("k_lookahead") & pl.col("gap_pre_bps").is_finite()).fill_null(False).alias("gap_ok_L0"),
    )


def coarse_references(candle_root: Path = H.CANDLES) -> dict[str, pl.DataFrame]:
    """Per pool HL reference from 15m candles only (1h candles where 15m do not reach): the reference quality TRAIN had."""
    per_coin = {}
    for coin in sorted({c for pair in H.POOL_REF.values() for c in pair if c}):
        per_coin[coin] = H.merge_sources([H.load_candles(coin, "15m", root=candle_root), H.load_candles(coin, "1h", root=candle_root)])
    return {pool: per_coin[a] if b is None else H.ratio_ref(per_coin[a], per_coin[b]) for pool, (a, b) in H.POOL_REF.items()}


def build_refs() -> dict[str, dict[str, pl.DataFrame]]:
    return {"fine": H.build_references()[0], "15m": coarse_references()}


def add_states(df: pl.DataFrame, refs: dict[str, dict[str, pl.DataFrame]]) -> tuple[pl.DataFrame, dict, dict]:
    """Per pool: recompute L0 (consistency check vs hl_ref), the other state variants, and one timeline per reference."""
    parts, tls, checks = [], {}, {}
    for pool in df["pool"].unique(maintain_order=True).to_list():
        p = df.filter(pl.col("pool") == pool)
        pm = p.select("ts", pl.col("mid_after").alias("mid"))
        sessions = {kind: H.calibrate_k(pm, r[pool]) for kind, r in refs.items()}
        extra = []
        for st in STATES:
            s = pre_trade_state(p, refs[st.ref][pool], sessions[st.ref], st.lag)
            if st.key == "L0":
                both = p.select("gap_bps_L0", "gap_ok_L0").with_columns(s["gap_bps"].alias("g"), s["gap_ok"].alias("o"))
                checks[pool] = {
                    "max_abs_gap_diff_bps": both.select((pl.col("g") - pl.col("gap_bps_L0")).abs().max()).item(),
                    "ok_flag_mismatches": int(both.select((pl.col("o") != pl.col("gap_ok_L0")).sum()).item()),
                }
                continue
            extra += [s["gap_bps"].alias(f"gap_bps_{st.key}"), s["gap_ok"].alias(f"gap_ok_{st.key}")]
        parts.append(p.with_columns(extra))
        for kind, r in refs.items():
            tls[(pool, kind)] = timeline(p.select("ts", "mid_after"), r[pool], sessions[kind]).with_columns(pl.lit(pool).alias("pool"))
    return pl.concat(parts), tls, checks


# ─────────────────────────────── run ───────────────────────────────

def _with_all_pools(d: pl.DataFrame, by: list[str]) -> pl.DataFrame:
    """Append pool = 'ALL' sums of the additive columns (USD, counts), then recompute ratios."""
    add = [c for c in ["n_swaps", "n_absent", "vol", "vol_kept", "fees", "fees_kept", "picked_hl_1h", "picked_hl_1h_kept",
                       "picked_self_1h", "picked_self_1h_kept", "n_5m", "fees_5m", "fees_5m_kept", "picked_hl_5m",
                       "picked_hl_5m_kept"] if c in d.columns]
    keys = [c for c in by if c != "pool"]
    tot = d.group_by(keys).agg([pl.col(c).sum() for c in add]).with_columns(pl.lit("ALL").alias("pool"))
    return pl.concat([d.select(by + add), tot.select(by + add)])


def fit_all(df: pl.DataFrame) -> tuple[dict[tuple, pl.DataFrame], pl.DataFrame, pl.DataFrame]:
    """φ tables per (family, state, fit_on), the full TRAIN / TEST φ curves, and the TRAIN robustness guard of every
    TRAIN fit. Only TRAIN data feeds the out-of-sample rules (fit_on TRAIN and TRAIN_GUARDED); the TEST curve feeds
    the in-sample ceiling R2* and the diagnostics."""
    phis, curves, guards = {}, [], []
    for period in ["TRAIN", "TEST"]:
        d = df.filter(pl.col("in_universe") & (pl.col("period") == period))
        dates = d["date_et"] if "date_et" in d.columns else d.select(et_date_expr()).to_series()
        for fam, win in FAMILY_WINDOW.items():
            for st in STATES:
                pre = pre_view(d, st.key)
                curve = phi_curve(pre, d["net"], win)
                curves.append(curve.with_columns(pl.lit(fam).alias("family"), pl.lit(st.key).alias("state"), pl.lit(period).alias("period")))
                if period == "TRAIN":
                    phis[(fam, st.key, period)] = choose_phi(curve)
                    gd = phi_guard(pre, d["net"], dates, win, phis[(fam, st.key, period)])
                    phis[(fam, st.key, "TRAIN_GUARDED")] = guarded(gd)
                    guards.append(gd.with_columns(pl.lit(fam).alias("family"), pl.lit(st.key).alias("state")))
                elif fam == "R2" and st.key == "L0":
                    phis[(fam, st.key, period)] = choose_phi(curve)
    return phis, pl.concat(curves), pl.concat(guards)


def run(out_dir: Path = OUT) -> dict[str, pl.DataFrame]:
    t_start = time.time()
    out_dir.mkdir(parents=True, exist_ok=True)
    df, tls, checks = add_states(load_inputs(), build_refs())
    print(f"inputs: {df.height:,} swaps; lag-0 recompute check {checks}  ({time.time() - t_start:.1f}s)")

    phis, grid, guards = fit_all(df)
    rules = all_rules()
    df = df.with_columns(hour_et_expr(), fixed_window_expr())     # diagnostics only; decisions never read them

    # decisions for every swap and every timeline row
    absent = {}
    for r in rules:
        absent[r.name] = decide(pre_view(df, r.state), r.window, phis[r.phi_key] if r.family else None)

    # metrics
    u = pl.col("in_universe")
    res_parts, daily_parts, hourly_parts = [], [], []
    for r in rules:
        for period in r.periods:
            m = u if period == "FULL" else (u & (pl.col("period") == period))
            mask = df.select(m.fill_null(False)).to_series()
            d, a = df.filter(mask), absent[r.name].filter(mask)
            if period != "FULL":
                hourly_parts.append(hourly_delta(d, a, r.state).with_columns(pl.lit(period).alias("period"), pl.lit(r.name).alias("rule")))
            for kind, by in [("all", []), ("regime_group", ["grp"]), ("ref_res", ["res_class"]), ("fixed_window", ["fixed_win"])]:
                e = evaluate(d, a, ["pool", *by])
                e = finish_metrics(_with_all_pools(e, ["pool", *by]))
                e = e.with_columns(pl.lit(kind).alias("slice_kind"),
                                   (pl.col(by[0]) if by else pl.lit("all")).cast(pl.String).alias("slice"))
                if by:
                    e = e.drop(by)
                res_parts.append(e.with_columns(pl.lit(period).alias("period"), pl.lit(r.name).alias("rule")))
            outside = pl.col("_a") & (pl.col("fixed_win") == FIXED_WIN_SLICES[2])
            dd = d.with_columns(a.alias("_a")).group_by("pool", "date_et").agg(
                pl.col("fee_usd").filter(~pl.col("_a")).sum().alias("fees_kept"),
                pl.col("picked_hl_1h").filter(~pl.col("_a")).sum().alias("picked_hl_1h_kept"),
                pl.col("_a").sum().alias("n_absent"), pl.len().alias("n_swaps"),
                (-pl.col("net").filter(outside).sum()).alias("delta_outside_fixed"))
            dd = pl.concat([dd, dd.group_by("date_et").agg(pl.col("fees_kept", "picked_hl_1h_kept", "n_absent", "n_swaps",
                                                                   "delta_outside_fixed").sum())
                           .with_columns(pl.lit("ALL").alias("pool")).select(dd.columns)])
            daily_parts.append(dd.with_columns((pl.col("fees_kept") - pl.col("picked_hl_1h_kept")).alias("net_kept"),
                                               pl.lit(period).alias("period"), pl.lit(r.name).alias("rule")))
    results = pl.concat(res_parts, how="diagonal_relaxed")
    daily = pl.concat(daily_parts).sort("period", "rule", "pool", "date_et")

    # absent hours from the timelines
    hours = absent_hours(tls, rules, phis)
    results = results.join(hours, on=["period", "pool", "rule", "slice_kind", "slice"], how="left")
    meta = pl.DataFrame([{"rule": r.name, "desc": r.desc, "window": r.window, "family": r.family, "state": r.state if r.family else None,
                          "lag_s": STATE[r.state].lag if r.family else None, "ref": STATE[r.state].ref if r.family else None,
                          "fit_on": r.fit_on if r.family else None, "out_of_sample_on_test": r.fit_on != "TEST"} for r in rules])
    results = results.join(meta, on="rule", how="left")
    order = {n: i for i, n in enumerate([r.name for r in rules])}
    results = (results.with_columns(pl.col("rule").replace_strict(order, return_dtype=pl.Int32).alias("_ro"),
                                    pl.col("pool").replace_strict({p: i for i, p in enumerate(POOL_ORDER)}, default=99, return_dtype=pl.Int32).alias("_po"))
               .sort("period", "_po", "_ro", "slice_kind", "slice").drop("_ro", "_po"))

    phi_tab = phi_table(phis, grid, guards)
    boot = bootstrap(daily)
    bursts = top_hours(pl.concat(hourly_parts))
    out = {"results": results, "phi": phi_tab, "grid": grid, "daily": daily, "bootstrap": boot, "bursts": bursts,
           "gap_dist": gap_distribution(df)}
    for n, t in out.items():
        t.write_parquet(out_dir / f"{n}.parquet")
    ctx = {"checks": checks, "coverage": coverage(df), "runtime_s": time.time() - t_start}
    (out_dir / "backtest.md").write_text(render_md(out, ctx))
    print(f"done in {time.time() - t_start:.1f}s → {out_dir}")
    return out


def absent_hours(tls: dict[tuple[str, str], pl.DataFrame], rules: list[Rule], phis: dict) -> pl.DataFrame:
    """Hours the book is out: each rule replayed on the step-function timeline of its reference (a lagged rule's
    absence is the same step function shifted by the lag, so it reuses the lag-0 timeline)."""
    parts = []
    for (pool, kind), tl in tls.items():
        periods = tl.filter(pl.col("period").is_not_null())
        full = tl.with_columns(pl.lit("FULL").alias("period"))
        for r in rules:
            if STATE[r.state].ref != kind:
                continue
            phi = phis[r.phi_key] if r.family else None
            for period in r.periods:
                d = full if period == "FULL" else periods.filter(pl.col("period") == period)
                if d.is_empty():
                    continue
                a = decide(d.select(PRE_COLS), r.window, phi)
                d = d.with_columns(a.alias("_a"))
                for slice_kind, by in [("all", []), ("regime_group", ["grp"])]:
                    g = d.group_by(by or pl.lit(1).alias("_k")).agg(
                        (pl.col("dur").filter(pl.col("_a")).sum() / 3600).alias("hours_absent"),
                        (pl.col("dur").sum() / 3600).alias("hours_span"))
                    g = g.with_columns(pl.lit(slice_kind).alias("slice_kind"),
                                       (pl.col(by[0]) if by else pl.lit("all")).cast(pl.String).alias("slice"))
                    parts.append(g.select("slice_kind", "slice", "hours_absent", "hours_span")
                                 .with_columns(pl.lit(period).alias("period"), pl.lit(pool).alias("pool"), pl.lit(r.name).alias("rule")))
    return pl.concat(parts).with_columns((pl.col("hours_absent") / pl.col("hours_span")).alias("hours_absent_pct"))


GUARD_COLS = ["days_out", "days_pos", "top_day", "top_day_gain", "top_day_share", "top_day_n_out", "guard_pass"]


def phi_table(phis: dict, grid: pl.DataFrame, guards: pl.DataFrame | None = None) -> pl.DataFrame:
    """Chosen φ per (family, state, fit_on, pool, grp) with the TRAIN / TEST net at that φ and with no gap leg (φ = ∞),
    plus the φ each period would have chosen for itself (`phi_best_here`). For TRAIN-fitted rows, `train_*` / `guard_pass`
    describe the robustness of the (unguarded) TRAIN fit of that cell: days with gap-leg exclusions, positive days, the best
    TRAIN day and its share of the TRAIN gain."""
    rows = []
    for (fam, state, fit_on), tab in phis.items():
        g = grid.filter((pl.col("family") == fam) & (pl.col("state") == state))
        for per in ["TRAIN", "TEST"]:
            gp = g.filter(pl.col("period") == per)
            at = tab.join(gp.select("pool", "grp", "phi", "net_kept", "n_absent", "n"), on=["pool", "grp", "phi"], how="left")
            inf = gp.filter(pl.col("phi") == math.inf).select("pool", "grp", pl.col("net_kept").alias("net_no_gap"))
            best = choose_phi(gp).rename({"phi": "phi_best_here"})
            at = at.join(inf, on=["pool", "grp"], how="left").join(best, on=["pool", "grp"], how="left")
            if guards is not None and fit_on != "TEST":
                gd = guards.filter((pl.col("family") == fam) & (pl.col("state") == state)).select(
                    "pool", "grp", pl.col("phi").alias("train_phi_unguarded"), pl.col("gain").alias("train_gain_unguarded"),
                    *[pl.col(c).alias(f"train_{c}" if c != "guard_pass" else c) for c in GUARD_COLS])
                at = at.join(gd, on=["pool", "grp"], how="left")
            rows.append(at.with_columns(
                pl.lit(fam).alias("family"), pl.lit(state).alias("state"), pl.lit(fit_on).alias("fit_on"), pl.lit(per).alias("period"),
                (pl.col("net_kept") - pl.col("net_no_gap")).alias("gain")))
    base = ["family", "state", "fit_on", "period", "pool", "grp", "phi", "n", "n_absent", "net_kept", "net_no_gap", "gain", "phi_best_here"]
    out = pl.concat(rows, how="diagonal_relaxed")
    extra = [c for c in out.columns if c not in base]
    return out.select(base + extra).sort("family", "state", "fit_on", "pool", "grp", "period")


def hourly_delta(d: pl.DataFrame, a: pl.Series, state: str = "L0") -> pl.DataFrame:
    """Δ vs R0 per (pool, ET date, ET hour) for one rule = −Σ net over the swaps it takes out (hours with no absent swap
    have Δ = 0 and are omitted), plus 'ALL'. Also: first / last absent swap, share of absent swaps inside the R3 window,
    and the median |gap| of the absent swaps under the rule's own reference and under the fine reference (L0)."""
    x = d.with_columns(a.alias("_a")).filter(pl.col("_a"))
    gs, okc = f"gap_bps_{state}", f"gap_ok_{state}"
    aggs = [(-pl.col("net").sum()).alias("delta"), pl.len().cast(pl.UInt32).alias("n_absent"),
            pl.col("ts").min().alias("t_first"), pl.col("ts").max().alias("t_last"),
            (pl.col("fixed_win") == FIXED_WIN_SLICES[0]).mean().alias("share_in_r3"),
            r1_window_expr().mean().alias("share_in_r1"),
            pl.col(gs).filter(pl.col(okc)).abs().median().alias("med_abs_gap_rule"),
            pl.col("gap_bps_L0").filter(pl.col("gap_ok_L0")).abs().median().alias("med_abs_gap_fine")]
    keys = ["date_et", "hour_et"]
    per_pool = x.group_by("pool", *keys).agg(aggs)
    allp = x.group_by(keys).agg(aggs).with_columns(pl.lit("ALL").alias("pool"))
    return pl.concat([per_pool, allp.select(per_pool.columns)])


def top_hours(hourly: pl.DataFrame, k: int = 3) -> pl.DataFrame:
    """The k best ET hours (largest Δ vs R0) per (period, pool, rule), with each hour's share of the period Δ."""
    tot = hourly.group_by("period", "pool", "rule").agg(pl.col("delta").sum().alias("delta_period"))
    return (hourly.join(tot, on=["period", "pool", "rule"])
            .sort("delta", "date_et", "hour_et", descending=[True, False, False])
            .with_columns(pl.int_range(1, pl.len() + 1).over("period", "pool", "rule").alias("rank"))
            .filter(pl.col("rank") <= k)
            .sort("period", "pool", "rule", "rank"))


def gap_distribution(df: pl.DataFrame) -> pl.DataFrame:
    """|gap| distribution of universe swaps with a usable signal, per period × reference × pool × regime group (and 'all').
    TRAIN's fine reference is the 15m candles, so TRAIN/L0 vs TEST/C15 compares like with like."""
    parts = []
    for per, st in [("TRAIN", "L0"), ("TEST", "C15"), ("TEST", "L0")]:
        x = df.filter(pl.col("in_universe") & (pl.col("period") == per) & pl.col(f"gap_ok_{st}")).select(
            "pool", "grp", pl.col(f"gap_bps_{st}").abs().alias("g"))
        aggs = [pl.len().alias("n"), pl.col("g").median().alias("median_abs_gap"), pl.col("g").quantile(0.9).alias("p90_abs_gap")]
        parts += [x.group_by("pool", "grp").agg(aggs),
                  x.group_by("pool").agg(aggs).with_columns(pl.lit("all").alias("grp"))]
        parts[-2:] = [p.with_columns(pl.lit(per).alias("period"), pl.lit(st).alias("state"), pl.lit(STATE[st].ref).alias("ref"))
                      for p in parts[-2:]]
    return pl.concat(parts, how="diagonal_relaxed").select(
        "period", "state", "ref", "pool", "grp", "n", "median_abs_gap", "p90_abs_gap").sort("period", "state", "pool", "grp")


def _boot_row(delta: np.ndarray, idx: np.ndarray) -> dict:
    sims = delta[idx].sum(axis=1)
    return {"delta": float(delta.sum()), "lo95": float(np.quantile(sims, 0.025)), "hi95": float(np.quantile(sims, 0.975)),
            "p_pos": float((sims > 0).mean())}


def bootstrap(daily: pl.DataFrame, b: int = BOOT_B, seed: int = 0) -> pl.DataFrame:
    """Day-block bootstrap of TEST Δnet (rule − R0, rule − R1): resample the TEST days with replacement.
    scope 'all swaps' = the whole book; scope 'outside fixed windows' = rule − R0 counting only the swaps the rule takes out
    outside both fixed windows (R1, R3): the part of a gap rule's Δ that a schedule could not have produced."""
    rng = np.random.default_rng(seed)
    d = daily.filter(pl.col("period") == "TEST")
    rows = []
    days = d["date_et"].unique().sort()
    idx = rng.integers(0, days.len(), size=(b, days.len()))
    if "delta_outside_fixed" in d.columns:
        for pool in d["pool"].unique().to_list():
            piv = (d.filter(pl.col("pool") == pool).pivot(on="rule", index="date_et", values="delta_outside_fixed")
                   .join(pl.DataFrame({"date_et": days}), on="date_et", how="right").fill_null(0.0).sort("date_et"))
            for rule in [c for c in piv.columns if c not in ("date_et", "R0")]:
                delta = piv[rule].to_numpy()
                best = int(np.argmax(delta))
                rows.append({"period": "TEST", "pool": pool, "rule": rule, "vs": "R0", "scope": "outside fixed windows",
                             **_boot_row(delta, idx), "days": int(days.len()), "best_day": piv["date_et"][best],
                             "best_delta": float(delta[best]), "days_pos": int((delta > 0.005).sum()), "days_neg": int((delta < -0.005).sum())})
    for pool in d["pool"].unique().to_list():
        piv = (d.filter(pl.col("pool") == pool).pivot(on="rule", index="date_et", values="net_kept")
               .join(pl.DataFrame({"date_et": days}), on="date_et", how="right").fill_null(0.0).sort("date_et"))
        for rule in [c for c in piv.columns if c != "date_et"]:
            for base in ["R0", "R1"]:
                if rule == base or base not in piv.columns:
                    continue
                delta = (piv[rule] - piv[base]).to_numpy()
                rows.append({"period": "TEST", "pool": pool, "rule": rule, "vs": base, "scope": "all swaps", **_boot_row(delta, idx),
                             "days": int(days.len())})
    return pl.DataFrame(rows).sort("scope", "pool", "rule", "vs")


def coverage(df: pl.DataFrame) -> pl.DataFrame:
    return (df.filter(pl.col("period").is_not_null() & pl.col("in_universe"))
            .group_by("period", "pool", "res_class").agg(pl.len().alias("swaps"), pl.col("fee_usd").sum().alias("fees"))
            .sort("period", "pool", "res_class"))


# ─────────────────────────────── report ───────────────────────────────

def _usd(v, signed: bool = False) -> str:
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return "–"
    s = ("+" if v > 0 else "−" if v < 0 else "") if signed else ("−" if v < 0 else "")
    a = abs(v)
    body = f"${a / 1e6:,.2f}M" if a >= 1e6 else (f"${a / 1e3:,.1f}k" if a >= 1e3 else f"${a:,.0f}")
    return s + body


def _pct(v, digits: int = 1) -> str:
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return "–"
    x = round(100 * v, digits)
    return f"{'−' if x < 0 else ''}{abs(x):.{digits}f}%"


def _num(v, digits: int = 2) -> str:
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return "–"
    return "∞" if math.isinf(v) else f"{v:,.{digits}f}"


def _int(v) -> str:
    return "–" if v is None else f"{int(v):,}"


def _tab(head: list[str], rows: list[list[str]]) -> str:
    return "\n".join(["| " + " | ".join(head) + " |", "|" + "---|" * len(head)] + ["| " + " | ".join(r) + " |" for r in rows]) + "\n"


def _after_holiday(d: date) -> str | None:
    """Name of the exchange holiday immediately before trading day d (skipping weekends), if any."""
    p = d - timedelta(days=1)
    while p.weekday() >= 5:
        p -= timedelta(days=1)
    return HOLIDAYS.get(p)


def _get(res: pl.DataFrame, period: str, pool: str, rule: str, slice_kind: str = "all", slc: str = "all") -> dict | None:
    d = res.filter((pl.col("period") == period) & (pl.col("pool") == pool) & (pl.col("rule") == rule)
                   & (pl.col("slice_kind") == slice_kind) & (pl.col("slice") == slc))
    return d.row(0, named=True) if d.height else None


def render_md(t: dict[str, pl.DataFrame], ctx: dict) -> str:
    res, phi, boot, daily = t["results"], t["phi"], t["bootstrap"], t["daily"]
    NV, ALL = "NVDA/USDG", "ALL"
    g = lambda per, pool, rule, *a: _get(res, per, pool, rule, *a) or {}
    d = lambda per, pool, rule: g(per, pool, rule).get("d_net_hl_1h")
    L: list[str] = []
    A = L.append

    # ── headline numbers
    bursts, gdist = t.get("bursts"), t.get("gap_dist")
    r2_te_nv, r2_te_all = d("TEST", NV, "R2"), d("TEST", ALL, "R2")
    r2_tr_nv, r2_tr_all = d("TRAIN", NV, "R2"), d("TRAIN", ALL, "R2")
    r1_te_nv, r1_te_all, r1_tr_nv = d("TEST", NV, "R1"), d("TEST", ALL, "R1"), d("TRAIN", NV, "R1")
    r3_te_nv, r3_te_all = d("TEST", NV, "R3"), d("TEST", ALL, "R3")
    r5_te_nv, r4_te_nv = d("TEST", NV, "R5"), d("TEST", NV, "R4")
    c15_nv, c15_all = d("TEST", NV, "R2/15m"), d("TEST", ALL, "R2/15m")
    star_nv, star_all = d("TEST", NV, "R2*"), d("TEST", ALL, "R2*")
    ab = lambda per, rule: g(per, NV, rule).get("absent_swap_pct")
    win = lambda per, pool, rule, s: g(per, pool, rule, "fixed_window", s).get("d_net_hl_1h") or 0.0
    beats = (r2_te_all or 0) > (r1_te_all or 0) and (r2_te_nv or 0) > (r1_te_nv or 0)
    boot_all = boot.filter(pl.col("scope") == "all swaps")
    bt = boot_all.filter((pl.col("pool") == NV) & (pl.col("rule") == "R1") & (pl.col("vs") == "R0"))
    bt = bt.row(0, named=True) if bt.height else None
    conc, conc_tr = _concentration(daily, "TEST"), _concentration(daily, "TRAIN")

    def crow(c: pl.DataFrame, pool: str, rule: str) -> dict:
        x = c.filter((pl.col("pool") == pool) & (pl.col("rule") == rule))
        return x.row(0, named=True) if x.height else {}

    def burst(per: str, pool: str, rule: str, rank: int = 1) -> dict:
        if bursts is None:
            return {}
        x = bursts.filter((pl.col("period") == per) & (pl.col("pool") == pool) & (pl.col("rule") == rule) & (pl.col("rank") == rank))
        return x.row(0, named=True) if x.height else {}

    def gmed(per: str, st: str, pool: str, grp: str) -> float | None:
        if gdist is None:
            return None
        x = gdist.filter((pl.col("period") == per) & (pl.col("state") == st) & (pl.col("pool") == pool) & (pl.col("grp") == grp))
        return x["median_abs_gap"].item() if x.height else None

    def bci(pool: str, rule: str, vs: str = "R0") -> str:
        x = boot_all.filter((pl.col("pool") == pool) & (pl.col("rule") == rule) & (pl.col("vs") == vs))
        if not x.height:
            return ""
        x = x.row(0, named=True)
        return f"95% CI [{_usd(x['lo95'], True)}, {_usd(x['hi95'], True)}]"

    def outside(pool: str, rule: str) -> dict:
        x = boot.filter((pl.col("scope") == "outside fixed windows") & (pl.col("pool") == pool) & (pl.col("rule") == rule))
        return x.row(0, named=True) if x.height else {}

    def outside_txt(pool: str, rule: str) -> str:
        o = outside(pool, rule)
        if not o:
            return "–"
        return (f"{_usd(o['delta'], True)} (95% CI [{_usd(o['lo95'], True)}, {_usd(o['hi95'], True)}], positive on {o['days_pos']} of "
                f"{o['days']} days, best day {o['best_day']} {_usd(o['best_delta'], True)})")

    A("# M1 · Gap-exclusion backtest (module D: `backtest/gap_exclusion.py`)\n")
    A("**Question.** Would a rule that pulls LP liquidity when the pool is stale against Hyperliquid fair value have kept the "
      "LP fees while avoiding the informed flow, *out of sample*? Pool-level counterfactual: when the rule says *absent*, "
      "that swap's LP fee and its picked-off are both removed from the LP book. Money = LP net vs HL at 1h "
      "(fees − `picked_hl_1h`) unless stated; `Δ` = change vs always-in (R0).\n")
    A("## Answer\n")
    ctr = crow(conc_tr, NV, "R2")
    tr_conc = (f" Even in TRAIN that gain was concentrated: {ctr['best_day']} ({_usd(ctr['best_delta'], True)}) and {ctr['second_day']} "
               f"({_usd(ctr['second_delta'], True)}) supplied {_pct(ctr['top2_share'], 0)} of it." if ctr.get("top2_share") is not None else "")
    A(f"1. **{'Yes' if beats else 'No'}: as specified, the gap rule did {'' if beats else 'not '}beat the fixed rule out of sample.** "
      f"With φ fitted on TRAIN and applied unchanged to TEST (Sep 1–18), R2 moved TEST net by **{_usd(r2_te_nv, True)}** on NVDA/USDG "
      f"({_usd(r2_te_all, True)} all pools). The fixed 09:00–10:59 ET rule R1 did **{_usd(r1_te_nv, True)}** "
      f"({_usd(r1_te_all, True)}) and the reopen guard R3 {_usd(r3_te_nv, True)} ({_usd(r3_te_all, True)}). "
      f"In TRAIN the same gap rule looked like {_usd(r2_tr_nv, True)} on NVDA ({_usd(r2_tr_all, True)} all pools), and that did not survive." + tr_conc)

    o_tr, o_15, o_te = ab("TRAIN", "R2"), ab("TEST", "R2/15m"), ab("TEST", "R2")
    m_tr, m_15, m_te = gmed("TRAIN", "L0", NV, "REGULAR"), gmed("TEST", "C15", NV, "REGULAR"), gmed("TEST", "L0", NV, "REGULAR")
    if None not in (o_tr, o_15, o_te) and o_tr > o_te:
        frac = (o_tr - o_15) / (o_tr - o_te)
        shift = ("" if None in (m_tr, m_15) else
                 f" NVDA's gaps were {'smaller' if m_15 < m_tr else 'larger'} in TEST: median REGULAR |gap| {_num(m_tr, 1)} bp in TRAIN vs "
                 f"{_num(m_15, 1)} bp in TEST at the same 15m reference" + ("" if m_te is None else f" ({_num(m_te, 1)} bp on TEST's finer reference)") + ".")
        A(f"2. **Why it failed: the TRAIN-fitted φ almost stopped firing, and reference quality explains only part of that.** R2 is out for "
          f"{_pct(o_tr)} of NVDA swaps in TRAIN but {_pct(o_te)} in TEST. TRAIN only has 15m HL candles, while TEST has 5m (Sep 1–15) and "
          f"1m (Sep 15–18). But with TEST gaps rebuilt from the same 15m reference TRAIN had (R2/15m, same φ), the out-share already falls "
          f"to {_pct(o_15)}. So {_pct(frac, 0)} of the drop ({_pct(o_tr)} → {_pct(o_15)}) happens with reference quality held fixed, "
          f"which is a TRAIN/TEST distribution shift." + shift + f" The fresher reference accounts for the rest ({_pct(o_15)} → {_pct(o_te)}).")

    b1 = burst("TEST", NV, "R2/15m")
    tsla15, spy15 = d("TEST", "TSLA/USDG", "R2/15m"), d("TEST", "SPY/USDG", "R2/15m")
    if b1:
        bday = b1["date_et"]
        hol = _after_holiday(bday)
        t_a = datetime.fromtimestamp(b1["t_first"], ET).strftime("%H:%M:%S")
        t_b = datetime.fromtimestamp(b1["t_last"], ET).strftime("%H:%M:%S")
        span_min = (b1["t_last"] - b1["t_first"]) / 60
        A(f"3. **At matched reference quality, the out-of-sample gain is one opening burst. The evidence cannot tell a gap signal from an "
          f"opening-window effect.** R2/15m made {_usd(c15_nv, True)} on NVDA in TEST. Its best ET hour, {bday} {b1['hour_et']:02d}:00 "
          f"({bday.strftime('%a')}" + (f", the first session after {hol}" if hol else "") + f"), gave {_usd(b1['delta'], True)}: "
          f"{_int(b1['n_absent'])} swaps taken out between {t_a} and {t_b} ET (a {span_min:.0f}-minute burst), "
          f"{_pct(b1['share_in_r3'], 0)} of them inside the fixed R3 reopen-guard window and {_pct(b1['share_in_r1'], 0)} inside R1. "
          f"All other hours together: {_usd((c15_nv or 0) - b1['delta'], True)}"
          + (f", made of {_usd(win('TEST', NV, 'R2/15m', 'outside both'), True)} from swaps outside both fixed windows and "
             f"{_usd(win('TEST', NV, 'R2/15m', 'in R3') + win('TEST', NV, 'R2/15m', 'in R1 not R3') - b1['delta'], True)} from swaps "
             f"inside them on other days" if b1["share_in_r3"] == 1.0 else "")
          + f". By fixed window, R2/15m made "
          f"{_usd(win('TEST', NV, 'R2/15m', 'in R3'), True)} inside R3, {_usd(win('TEST', NV, 'R2/15m', 'in R1 not R3'), True)} in R1 "
          f"outside R3, and {_usd(win('TEST', NV, 'R2/15m', 'outside both'), True)} outside both. The burst's median gap was "
          f"{_num(b1['med_abs_gap_rule'], 0)} bp on the 15m reference but {_num(b1['med_abs_gap_fine'], 0)} bp on the fine one. "
          f"R2/15m lost money on TSLA ({_usd(tsla15, True)}) and SPY ({_usd(spy15, True)}, {bci('SPY/USDG', 'R2/15m')}). "
          f"The in-sample ceiling, with φ fitted on TEST itself (R2*), reaches {_usd(star_nv, True)} on NVDA ({_usd(star_all, True)} all pools), "
          + ("still below R1 on NVDA." if (star_nv or 0) < (r1_te_nv or 0) else "above R1 on NVDA."))

    jr = phi.filter(pl.col("family").is_in(["R4", "R5"]) & (pl.col("state") == "L0") & (pl.col("fit_on") == "TRAIN") & (pl.col("pool") == NV)
                    & (pl.col("grp") == "REGULAR") & (pl.col("period") == "TRAIN")).with_columns((pl.col("n_absent") / pl.col("n")).alias("out"))
    better = (r5_te_nv or 0) > (r1_te_nv or 0) or (r4_te_nv or 0) > (r3_te_nv or 0)
    A(f"4. **Gap + fixed window (R4, R5) {'partly beat' if better else 'did not beat'} the fixed window alone out of sample**: R5 {_usd(r5_te_nv, True)} vs R1 "
      f"{_usd(r1_te_nv, True)} on NVDA; R4 {_usd(r4_te_nv, True)} vs R3 {_usd(r3_te_nv, True)}. "
      + (f"The joint fits chose φ = {_num(jr['phi'].min(), 0)}–{_num(jr['phi'].max(), 0)} bp for NVDA REGULAR, taking the book out of "
         f"{_pct(jr['out'].min(), 0)}–{_pct(jr['out'].max(), 0)} of regular-hours swaps, " if jr.height else "")
      + f"because NVDA REGULAR lost {_usd(-(g('TRAIN', NV, 'R0', 'regime_group', 'REGULAR').get('net_hl_1h') or 0))} "
      f"in TRAIN. It then made {_usd(g('TEST', NV, 'R0', 'regime_group', 'REGULAR').get('net_hl_1h'), True)} in TEST.")

    c1 = crow(conc, NV, "R1")
    worst = (daily.filter((pl.col("period") == "TEST") & (pl.col("pool") == NV) & (pl.col("rule") == "R0"))
             .sort("net_kept").head(2)["date_et"].cast(pl.String).to_list())
    pos = conc.filter((pl.col("delta") > 1000) & pl.col("pool").is_in([NV, ALL])).sort("delta_ex_best", descending=True)
    best_days = sorted(set(pos["best_day"].to_list()))
    top = pos.row(0, named=True) if pos.height else None
    same = set(best_days) <= set(worst)
    sig = significant(boot)
    sig_focus, sig_other = sig.filter(pl.col("pool").is_in([NV, ALL])), sig.filter(~pl.col("pool").is_in([NV, ALL]))
    if bt and c1 and top:
        r1neg = sorted(set(sig_other.filter((pl.col("rule") == "R1") & (pl.col("vs") == "R0") & (pl.col("delta") < 0))["pool"].to_list()))
        other = ("" if sig_other.is_empty() else
                 " The only comparisons whose day-block 95% CI excludes zero are " + _sig_by_pool(sig_other) + "."
                 + (f" So the fixed rule R1 reliably lost money on {' and '.join(r1neg)}." if r1neg else ""))
        A(f"5. **{'No NVDA or all-pool gain is statistically solid' if sig_focus.is_empty() else 'Few NVDA or all-pool differences are statistically solid'}.** "
          f"For every rule that gained more than $1k on TEST (NVDA or all pools), the best "
          f"day was {' or '.join(best_days)}" + (", the always-in book's two worst NVDA days" if same else f" (the always-in book's two worst NVDA days: {' and '.join(sorted(worst))})")
          + f". Without its single best day, none of them keeps more than {_usd(top['delta_ex_best'], True)} ({top['rule']}, {top['pool']}). "
          f"R1's {_usd(r1_te_nv, True)} on NVDA is "
          f"{_usd(c1['best_delta'], True)} on {c1['best_day']} and {_usd(c1['delta_ex_best'], True)} on the other {c1['days'] - 1} days combined. "
          + (f"R1 also lost {_usd(abs(r1_tr_nv))} in TRAIN. " if (r1_tr_nv or 0) < 0 else "")
          + f"Day-block bootstrap 95% CI of R1's TEST gain on NVDA: [{_usd(bt['lo95'], True)}, {_usd(bt['hi95'], True)}]." + other)

    # R3: consistent vs HL 1h on NVDA / ALL? list every exception across pools, periods and the two 1h markouts
    r3 = {(per, pool, m): g(per, pool, "R3").get(f"d_net_{m}") for per in ["TRAIN", "TEST"] for pool in [NV, "TSLA/USDG", "SPY/USDG", ALL]
          for m in ["hl_1h", "self_1h"]}
    hl_pos = all((r3[(per, p, "hl_1h")] or 0) > 0 for per in ["TRAIN", "TEST"] for p in [NV, ALL])
    neg = [(per, p, m, v) for (per, p, m), v in r3.items() if v is not None and v < 0]
    lab = {"hl_1h": "HL 1h", "self_1h": "self 1h"}
    neg_by: dict[str, list[str]] = {}
    for per, p, m, v in neg:
        neg_by.setdefault("all pools" if p == ALL else p, []).append(f"{per} vs {lab[m]} {_usd(v, True)}")
    neg_txt = "; ".join(f"{p}: {', '.join(v)}" for p, v in neg_by.items())
    A(f"6. **The reopen guard R3 is the most consistent rule vs HL at 1h, but not across metrics or pools.** "
      + (f"Vs HL 1h it was positive in both periods on NVDA ({_usd(r3[('TRAIN', NV, 'hl_1h')], True)} TRAIN, {_usd(r3[('TEST', NV, 'hl_1h')], True)} TEST) "
         f"and across pools ({_usd(r3[('TRAIN', ALL, 'hl_1h')], True)}, {_usd(r3[('TEST', ALL, 'hl_1h')], True)}), giving up "
         f"{_pct(1 - (g('TEST', ALL, 'R3').get('fees_kept_pct') or 1))} of TEST fees. " if hl_pos else "It was not positive vs HL 1h in both periods. ")
      + (f"It was negative in: {neg_txt}. The self markout is the secondary metric, but a TRAIN loss under it means R3's TRAIN gain "
         "depends on which markout is used." if neg else "It was positive under both 1h markouts in every pool and period."))

    gr = phi.filter((pl.col("family") == "R2") & (pl.col("state") == "L0") & (pl.col("fit_on") == "TRAIN") & (pl.col("period") == "TRAIN")
                    & (pl.col("phi") < math.inf))
    if "guard_pass" in phi.columns and gr.height:
        passed = gr.filter(pl.col("guard_pass"))
        g_nv, g_all, g15_nv, g15_all = d("TEST", NV, "R2g"), d("TEST", ALL, "R2g"), d("TEST", NV, "R2g/15m"), d("TEST", ALL, "R2g/15m")
        verdict = "changes" if ((g_nv or 0) > (r1_te_nv or 0) and (g_all or 0) > (r1_te_all or 0)) else "does not change"
        A(f"7. **A robustness guard on φ {verdict} the verdict.** R2g keeps a TRAIN-fitted φ cell only if its TRAIN gain is at least "
          f"${GUARD_MIN_GAIN:,.0f} and no single TRAIN day supplies more than {GUARD_MAX_TOP_DAY:.0%} of it; the guard was fixed before "
          f"looking at TEST and reads TRAIN only. {passed.height} of the {gr.height} R2 cells with a finite φ "
          f"{'passes' if passed.height == 1 else 'pass'}"
          + (" (" + ", ".join(r["pool"] + " " + r["grp"] for r in passed.iter_rows(named=True)) + ")" if passed.height else "")
          + f". R2g moved TEST net by {_usd(g_nv, True)} on NVDA ({_usd(g_all, True)} all pools)"
          + (f", positive on {cg['days_pos']} of {cg['days']} TEST days and negative on {cg['days_neg']}" if (cg := crow(conc, NV, "R2g")) else "")
          + f"; on the 15m reference, R2g/15m {_usd(g15_nv, True)} ({_usd(g15_all, True)}). R1: {_usd(r1_te_nv, True)} "
          f"({_usd(r1_te_all, True)}). The guard removes the losses but also almost all of the rule: in TRAIN, R2g keeps "
          f"{_usd(d('TRAIN', NV, 'R2g'), True)} of R2's {_usd(r2_tr_nv, True)} on NVDA.")

    def excl(o: dict) -> bool:
        return bool(o) and (o["lo95"] > 0 or o["hi95"] < 0)

    o2, o15 = outside(NV, "R2"), outside(NV, "R2/15m")
    o15_t, o15_s = outside("TSLA/USDG", "R2/15m"), outside("SPY/USDG", "R2/15m")
    A(f"8. **For the product.** This backtest does not show that a staleness signal beats a schedule. The TRAIN gain was "
      f"concentrated in two days, the like-for-like out-of-sample gain is one opening burst inside the fixed windows, and the fixed "
      f"windows caught the same bad days. The part of a gap rule a schedule cannot copy is its gain *outside* the fixed windows. "
      f"On NVDA TEST that was {outside_txt(NV, 'R2/15m')} for R2/15m"
      + (" (the interval excludes zero)" if excl(o15) else "")
      + f" and {outside_txt(NV, 'R2')} for R2" + (" (the interval excludes zero)" if excl(o2) else " (the interval includes zero)") + ". "
      "That is the only evidence here for a staleness effect beyond the schedule, and it is weak. It is small next to R1's "
      f"{_usd(r1_te_nv, True)}, NVDA-only (R2/15m outside the windows: TSLA {_usd(o15_t.get('delta'), True)}, SPY "
      f"{_usd(o15_s.get('delta'), True)}), "
      + ("weaker on the fine reference the live system would use, " if (o2.get("delta") or 0) < (o15.get("delta") or 0) else "")
      + "and a post-hoc slice chosen after seeing the burst. Treat it as the hypothesis to test next, not a result. That test needs φ calibrated on the reference the "
      "live system will quote from (the 1 s tape / 1m candles; about 4 days of history so far, Sep 15 →), and enough days to hold "
      "out several opens and event days.\n")

    # ── setup
    A("## Setup\n")
    A(_tab(["rule", "absent when (ET, DST-aware)"], [
        ["R0", "never (baseline)"],
        ["R1", "Mon–Fri 09:00–10:59 (fixed; holidays included)"],
        ["R2", "abs(`gap_pre_bps`) > φ(pool, regime group); groups REGULAR / EXTENDED / OVERNIGHT / DARK (= WEEKEND_DARK + HOLIDAY)"],
        ["R3", "reopen guard: Sun 19:50–20:15 and Mon–Fri 09:20–09:45"],
        ["R4", "R2 ∪ R3 (φ fitted jointly with the window)"],
        ["R5", "R1 ∪ R2 (φ fitted jointly with the window)"],
        ["R2@1s, R2@5s (R4, R5 likewise)", "same, decision lag 1 s / 5 s: HL ≤ t−L, k as of t−L, pool state after the last swap with ts ≤ t−L"],
        ["R2/15m (R4, R5 likewise)", "same, but TEST gaps rebuilt from 15m candles (1h before they start): TRAIN's reference quality"],
        ["R2g, R2g/15m", f"R2 with a robustness guard fixed before looking at TEST: a TRAIN-fitted φ cell is kept only if its TRAIN "
                         f"gain ≥ ${GUARD_MIN_GAIN:,.0f} and its best TRAIN day supplies ≤ {GUARD_MAX_TOP_DAY:.0%} of that gain, else φ = ∞"],
        ["R2*", "R2 with φ fitted on TEST itself: in-sample ceiling, **not** out of sample"],
    ]))
    A("\n- `gap_pre_bps = 1e4·ln(F_pre / P_pool_before)` from `markout/hl_ref.py`: `F_pre = k·HL(latest point ≤ t)`, where k is the "
      "basis from the last session closed before t, and `P_pool_before` is the previous swap's `mid_after`. Recomputing it here "
      f"from hl_ref's own reference series reproduces it exactly (max |Δ| = {max(c['max_abs_gap_diff_bps'] for c in ctx['checks'].values()):.1g} bp, "
      f"{sum(c['ok_flag_mismatches'] for c in ctx['checks'].values())} flag mismatches over all pools). No usable signal "
      "(stale HL point, k look-ahead, no previous swap) ⇒ the LP stays **present**.")
    A("- Decisions read only `pool, ts, regime group, gap_bps, gap_ok` (`PRE_COLS`); the tests check that perturbing every HL point "
      "and pool price after a swap leaves its decision unchanged.")
    A(f"- **TRAIN** = ET dates {PERIODS['TRAIN'][0]}..{PERIODS['TRAIN'][1]}, **TEST** = {PERIODS['TEST'][0]}..{PERIODS['TEST'][1]}. "
      "Universe = swaps valid for both the HL 1h and M0's self 1h markouts, the same swaps as hl_ref's comparison tables "
      "(FULL-sample R0 below reproduces them). φ is grid-searched per (pool, regime group) on TRAIN, maximising net vs HL at 1h, "
      f"over {', '.join(_num(p, 0) for p in PHI_GRID)} bp; ties go to the larger φ. The grid includes 0 (\"out for the whole regime\").")
    A("- `absent hours` = wall-clock time the book is out: the pre-trade state is replayed as a step function (change points = swap "
      "seconds, HL points, a 1-minute grid) between each pool's first and last swap. Lagged rules reuse the lag-0 timeline.")
    A("- HL 5m markouts exist only from Sep 1 (5m candles), so every `HL 5m` column is TEST-only.\n")
    cov = ctx["coverage"]
    rows = []
    for per in ["TRAIN", "TEST"]:
        for pool in POOL_ORDER[:-1]:
            c = cov.filter((pl.col("period") == per) & (pl.col("pool") == pool))
            if c.is_empty():
                continue
            tot = c["swaps"].sum()
            share = {r["res_class"]: r["swaps"] / tot for r in c.iter_rows(named=True)}
            rows.append([per, pool, _int(tot)] + [_pct(share.get(k)) if k in share else "–" for k in RES_CLASSES])
    A("**HL reference resolution at the swap** (share of universe swaps; `<=1m` = 1m candles and the 1 s tape)\n")
    A(_tab(["period", "pool", "swaps", "<=1m", "5m", "15m", "1h"], rows))

    # ── main tables
    main_rules = ["R0", "R1", "R2", "R3", "R4", "R5", "R2/15m", "R2g", "R2g/15m", "R2*"]

    def big_table(per: str, rules: list[str], pools: list[str]) -> str:
        rows = []
        for pool in pools:
            for rule in rules:
                r = _get(res, per, pool, rule)
                if r is None:
                    continue
                rows.append([pool, rule, _int(r["n_absent"]), _num(r.get("hours_absent"), 1), _pct(r["fees_kept_pct"]),
                             _pct(r["avoided_hl_1h_pct"]), _pct(r["avoided_hl_5m_pct"]), _pct(r["avoided_self_1h_pct"]),
                             _num(r["edge_hl_1h"]), _usd(r["net_hl_1h"]), _usd(r["d_net_hl_1h"], True),
                             _usd(r["d_net_hl_5m"], True) if r["n_5m"] else "–", _usd(r["d_net_self_1h"], True),
                             _num(r["net_bps_vol"]), _num(r["net_bps_kept_vol"])])
        return _tab(["pool", "rule", "absent swaps", "absent h", "fees kept", "avoided HL 1h", "avoided HL 5m", "avoided self 1h",
                     "edge HL 1h", "net HL 1h", "Δ HL 1h", "Δ HL 5m", "Δ self 1h", "net bp vol", "net bp kept vol"], rows)

    A("\n## TEST (Sep 1–18): out of sample except R2*\n")
    A("`avoided` = share of the period's picked-off (total, both directions) the rule excluded; it can exceed 100% or go negative "
      "when excluded swaps had negative picked-off. `net bp vol` = net / all volume; `net bp kept vol` = net / volume the book "
      "actually served. `absent h` is per pool; it is blank for ALL. `Δ self 1h` = the same Δ under M0's self markout (secondary).\n")
    A(big_table("TEST", main_rules, POOL_ORDER))
    A("\n## TRAIN (Jul 28–Aug 31): in sample for R2, R4, R5 (R2g: the guard is also fitted here)\n")
    A("TRAIN reference is 15m candles, so R2/15m is identical to R2 here (and R2g/15m to R2g).\n")
    A(big_table("TRAIN", ["R0", "R1", "R2", "R3", "R4", "R5", "R2g"], POOL_ORDER))

    A("\n## Is the gap rule's gain schedule-like? Δ by fixed window\n")
    A("Each rule's Δ vs R0 split by where the excluded swaps sit: inside the R3 reopen-guard windows (Sun 19:50–20:15, "
      "Mon–Fri 09:20–09:45 ET), inside R1 (Mon–Fri 09:00–10:59) but not R3, or outside both. A staleness signal that a schedule "
      "cannot replicate should earn its money in the last column.\n")
    rows = []
    for per in ["TRAIN", "TEST"]:
        for pool in [NV, "TSLA/USDG", "SPY/USDG", ALL]:
            for rule in ["R2", "R2/15m", "R2g", "R2*"]:
                tot = g(per, pool, rule).get("d_net_hl_1h")
                if tot is None or (per == "TRAIN" and rule in ("R2/15m", "R2*")):
                    continue
                cells = [per, pool, rule, _usd(tot, True)]
                for s in FIXED_WIN_SLICES:
                    x = g(per, pool, rule, "fixed_window", s)
                    cells.append(f"{_usd(x.get('d_net_hl_1h') or 0, True)} ({_int(x.get('n_absent') or 0)} out)")
                rows.append(cells)
    A(_tab(["period", "pool", "rule", "Δ HL 1h", "in R3", "in R1 not R3", "outside both"], rows))
    A("\n**TEST, outside both fixed windows only**: day-block bootstrap of the Δ from swaps taken out outside R1 and R3 "
      "(the same 18-day resampling as below).\n")
    rows = []
    for pool in [NV, "TSLA/USDG", "SPY/USDG", ALL]:
        for rule in ["R2", "R2/15m", "R2g", "R2g/15m", "R2*", "R4", "R5"]:
            o = outside(pool, rule)
            if o:
                flag = " *" if (o["lo95"] > 0 or o["hi95"] < 0) else ""
                rows.append([pool, rule, _usd(o["delta"], True), f"[{_usd(o['lo95'], True)}, {_usd(o['hi95'], True)}]{flag}",
                             _pct(o["p_pos"], 0), f"{o['days_pos']}/{o['days']}", f"{o['days_neg']}/{o['days']}",
                             f"{o['best_day']} ({_usd(o['best_delta'], True)})"])
    A(_tab(["pool", "rule", "Δ outside windows", "95% CI (* excludes 0)", "P(Δ>0)", "days Δ>0", "days Δ<0", "best day"], rows))

    A("\n## Gap distribution: TRAIN vs TEST at the same reference\n")
    A("Median and 90th-percentile |gap| (bp) of universe swaps with a usable signal. TRAIN's reference is 15m candles, so "
      "`TRAIN` vs `TEST @15m` holds reference quality fixed; `TEST @fine` is what R2 actually saw.\n")
    rows = []
    if gdist is not None:
        for pool in [NV, "TSLA/USDG", "SPY/USDG"]:
            for grp in [*GROUPS, "all"]:
                cells = [pool, grp]
                for per, st in [("TRAIN", "L0"), ("TEST", "C15"), ("TEST", "L0")]:
                    x = gdist.filter((pl.col("period") == per) & (pl.col("state") == st) & (pl.col("pool") == pool) & (pl.col("grp") == grp))
                    cells.append(f"{_num(x['median_abs_gap'].item(), 1)} / {_num(x['p90_abs_gap'].item(), 1)}" if x.height else "–")
                rows.append(cells)
    A(_tab(["pool", "group", "TRAIN (15m) median / p90", "TEST @15m", "TEST @fine"], rows))
    ladder = [(per, rule, ab(per, rule)) for per, rule in [("TRAIN", "R2"), ("TEST", "R2/15m"), ("TEST", "R2")]]
    A("\nNVDA share of swaps R2 takes out, same TRAIN-fitted φ: " + " → ".join(f"{per} {rule} {_pct(v)}" for per, rule, v in ladder) + ".\n")

    A("\n## Gap rule vs fixed rule on TEST, with uncertainty\n")
    A(f"Day-block bootstrap: the {int(boot['days'].max())} TEST days are resampled with replacement ({BOOT_B:,} draws), and the table "
      "reports the 95% interval of the summed Δ and the share of draws above zero. " + significance_sentence(boot) + "\n")
    rows = []
    for pool in [NV, "TSLA/USDG", "SPY/USDG", ALL]:
        for a, b in BOOT_PAIRS:
            x = boot.filter((pl.col("pool") == pool) & (pl.col("rule") == a) & (pl.col("vs") == b) & (pl.col("scope") == "all swaps"))
            if x.height:
                x = x.row(0, named=True)
                flag = " *" if (x["lo95"] > 0 or x["hi95"] < 0) else ""
                rows.append([pool, f"{a} − {b}", _usd(x["delta"], True), f"[{_usd(x['lo95'], True)}, {_usd(x['hi95'], True)}]{flag}", _pct(x["p_pos"], 0)])
    A(_tab(["pool", "comparison", "Δ net HL 1h", "95% CI (* excludes 0)", "P(Δ>0)"], rows))

    def conc_table(c: pl.DataFrame, per: str, rules: list[str], with_hour: bool) -> str:
        rows = []
        for pool in [NV, ALL]:
            for rule in rules:
                x = crow(c, pool, rule)
                if not x:
                    continue
                cells = [pool, rule, _usd(x["delta"], True), f"{x['best_day']} ({_usd(x['best_delta'], True)})",
                         f"{x['second_day']} ({_usd(x['second_delta'], True)})" if x.get("second_day") else "–",
                         _pct(x["top2_share"], 0) if x.get("top2_share") is not None else "–",
                         _usd(x["delta_ex_best"], True), f"{x['days_pos']}/{x['days']}", f"{x['days_neg']}/{x['days']}"]
                if with_hour:
                    h = burst(per, pool, rule)
                    cells.append(f"{h['date_et']} {h['hour_et']:02d}:00 ({_usd(h['delta'], True)}, {_int(h['n_absent'])} out)" if h else "–")
                rows.append(cells)
        head = ["pool", "rule", f"Δ {per}", "best day", "2nd day", "top-2 share", "Δ without best day", "days Δ>0", "days Δ<0"]
        return _tab(head + (["best ET hour"] if with_hour else []), rows)

    A("\n## Where the gains come from (day and hour concentration)\n")
    A("Δ vs R0 per ET day; `top-2 share` = the two best days' share of the period Δ (when positive; above 100% means the other "
      "days lost money in total). On TEST, the gains are "
      "concentrated on the LP book's worst days; once the best day is removed, what remains is roughly zero or negative. On ordinary "
      "days, giving up fees usually cost more than the picked-off avoided. `best ET hour` = the single ET clock hour with the largest Δ "
      "(`bursts.parquet` has the top 3 per rule).\n")
    A("**TEST**\n")
    A(conc_table(conc, "TEST", ["R1", "R3", "R2", "R4", "R5", "R2/15m", "R2g", "R2g/15m", "R2*"], True))
    d0 = daily.filter((pl.col("period") == "TEST") & (pl.col("pool") == NV) & (pl.col("rule") == "R0")).sort("net_kept").head(2)
    if d0.height == 2:
        A(f"\nNVDA/USDG always-in net on the two worst TEST days: {d0['date_et'][0]} {_usd(d0['net_kept'][0], True)}, "
          f"{d0['date_et'][1]} {_usd(d0['net_kept'][1], True)} (whole TEST: {_usd(g('TEST', NV, 'R0').get('net_hl_1h'), True)}).\n")
    A("\n**TRAIN** (in sample for the gap rules)\n")
    A(conc_table(conc_tr, "TRAIN", ["R1", "R3", "R2", "R4", "R5", "R2g"], True))

    # ── φ
    A("\n## Chosen φ (R2, TRAIN) vs what TEST would have chosen\n")
    A(f"`n` = universe swaps in the cell; `out` = swaps the gap leg takes out. `top TRAIN day` = the TRAIN day with the largest "
      f"gain and its share of the cell's TRAIN gain. `guard` = passes R2g's guard (TRAIN gain ≥ ${GUARD_MIN_GAIN:,.0f} and top day ≤ "
      f"{GUARD_MAX_TOP_DAY:.0%} of it); a failing cell gets φ = ∞ in R2g.\n")
    p0 = phi.filter((pl.col("family") == "R2") & (pl.col("state") == "L0") & (pl.col("fit_on") == "TRAIN"))
    rows = []
    for pool in POOL_ORDER[:-1]:
        for grp in GROUPS:
            tr = p0.filter((pl.col("pool") == pool) & (pl.col("grp") == grp) & (pl.col("period") == "TRAIN"))
            te = p0.filter((pl.col("pool") == pool) & (pl.col("grp") == grp) & (pl.col("period") == "TEST"))
            if tr.is_empty() and te.is_empty():
                continue
            tr = tr.row(0, named=True) if tr.height else {}
            te = te.row(0, named=True) if te.height else {}
            phi_v = tr.get("phi", te.get("phi"))
            fin = phi_v is not None and not math.isinf(phi_v)
            top_day = (f"{tr['train_top_day']} ({_pct(tr['train_top_day_share'], 0)}, {_int(tr['train_top_day_n_out'])} out)"
                       if fin and tr.get("train_top_day") is not None and tr.get("train_top_day_share") is not None else "–")
            rows.append([pool, grp, _num(phi_v, 0) if phi_v is not None else "∞ (no TRAIN data)",
                         _int(tr.get("n")) if tr.get("n") else "–",
                         f"{_int(tr.get('n_absent') or 0)} ({_pct((tr.get('n_absent') or 0) / tr['n'])})" if tr.get("n") else "–",
                         _usd(tr.get("gain"), True), f"{tr.get('train_days_pos', 0)}/{tr.get('train_days_out', 0)}" if fin else "–",
                         top_day, ("pass" if tr.get("guard_pass") else "fail") if fin else "–",
                         f"{_int(te.get('n_absent') or 0)} ({_pct((te.get('n_absent') or 0) / te['n'])})" if te.get("n") else "–",
                         _usd(te.get("gain"), True), _num(te.get("phi_best_here"), 0)])
    A(_tab(["pool", "group", "φ (bp, TRAIN)", "n TRAIN", "out TRAIN", "gain TRAIN", "days gain>0 / days out", "top TRAIN day",
            "guard", "out TEST", "gain TEST", "φ TEST would pick"], rows))
    for fam in ["R4", "R5"]:
        x = phi.filter((pl.col("family") == fam) & (pl.col("state") == "L0") & (pl.col("fit_on") == "TRAIN") & (pl.col("pool") == NV)
                       & (pl.col("grp") == "REGULAR"))
        tr = x.filter(pl.col("period") == "TRAIN")
        te = x.filter(pl.col("period") == "TEST")
        if tr.height and te.height:
            tr, te = tr.row(0, named=True), te.row(0, named=True)
            A(f"- {fam} (window + gap), NVDA REGULAR: φ = {_num(tr['phi'], 0)} bp, so {_pct(tr['n_absent'] / tr['n'])} of REGULAR swaps "
              f"are out in TRAIN (gain {_usd(tr['gain'], True)} over the window alone; top TRAIN day {tr.get('train_top_day')} = "
              f"{_pct(tr.get('train_top_day_share'), 0)} of it) and {_pct(te['n_absent'] / te['n'])} in TEST (gain {_usd(te['gain'], True)}).")
    A("- Full φ tables for every rule family, lag and reference variant (with the same robustness columns): `phi.parquet`. "
      "Net-vs-φ curves for TRAIN and TEST: `grid.parquet`.\n")

    # ── by regime / resolution
    A("\n## NVDA/USDG TEST by regime group\n")
    rows = []
    for grp in GROUPS:
        for rule in ["R0", "R1", "R2", "R3", "R5", "R2/15m", "R2*"]:
            r = _get(res, "TEST", NV, rule, "regime_group", grp)
            if r:
                rows.append([grp, rule, _usd(r["fees"]), _int(r["n_absent"]), f"{_num(r.get('hours_absent'), 1)} / {_num(r.get('hours_span'), 0)}",
                             _usd(r["net_hl_1h"]), _usd(r["d_net_hl_1h"], True), _usd(r["d_net_hl_5m"], True)])
    A(_tab(["group", "rule", "fees", "absent swaps", "absent h / span h", "net HL 1h", "Δ HL 1h", "Δ HL 5m"], rows))
    A("\n## TEST by HL reference resolution at the swap\n")
    A("Does a fresher reference help the TRAIN-fitted gap rule? (`<=1m` = Sep 15–18 weekdays.)\n")
    rows = []
    for pool in [NV, "TSLA/USDG", "SPY/USDG", ALL]:
        for rc in ["<=1m", "5m", "15m"]:
            r0 = _get(res, "TEST", pool, "R0", "ref_res", rc)
            if not r0:
                continue
            cells = [pool, rc, _int(r0["n_swaps"]), _usd(r0["net_hl_1h"])]
            for rule in ["R2", "R2/15m", "R2*", "R1"]:
                r = _get(res, "TEST", pool, rule, "ref_res", rc) or {}
                cells.append(f"{_usd(r.get('d_net_hl_1h'), True)} ({_int(r.get('n_absent'))} out)")
            rows.append(cells)
    A(_tab(["pool", "reference", "swaps", "R0 net", "R2 Δ", "R2/15m Δ", "R2* Δ", "R1 Δ"], rows))

    # ── lag
    A("\n## Decision lag\n")
    A("The spec's information set lets the LP react to the swap immediately before, even inside the same block (63% of NVDA "
      "swaps share a second with the previous swap). With the whole protocol re-run at a lag (φ re-fitted on TRAIN):\n")
    rows = []
    for pool in [NV, ALL]:
        for rule in ["R2", "R2@1s", "R2@5s", "R5", "R5@1s", "R5@5s", "R4", "R4@1s", "R4@5s"]:
            tr, te = g("TRAIN", pool, rule), g("TEST", pool, rule)
            rows.append([pool, rule, _usd(tr.get("d_net_hl_1h"), True), _pct(tr.get("absent_swap_pct")),
                         _usd(te.get("d_net_hl_1h"), True), _pct(te.get("absent_swap_pct"))])
    A(_tab(["pool", "rule", "Δ TRAIN", "out TRAIN", "Δ TEST", "out TEST"], rows))
    lagphi = phi.filter(pl.col("family").is_in(["R4", "R5"]) & pl.col("state").is_in(["L1", "L5"]) & (pl.col("fit_on") == "TRAIN") & (pl.col("pool") == NV)
                        & (pl.col("grp") == "REGULAR") & (pl.col("period") == "TRAIN"))
    A("\nA lag does not change the out-of-sample picture. It *raises* the in-sample TRAIN gain, yet adds nothing on TEST, so a "
      "bigger in-sample gain is no guide here."
      + (f" At lags of 1 s and 5 s the R4/R5 fits pick φ ≤ {_num(lagphi['phi'].max(), 0)} bp for NVDA REGULAR (out for practically the "
         "whole regime), which costs money in TEST." if lagphi.height and lagphi["phi"].max() <= 2 else "") + "\n")

    # ── checks & caveats
    A("\n## Checks\n")
    f0 = g("FULL", NV, "R0")
    A(f"- FULL-sample R0 reproduces hl_ref's NVDA/USDG 1h row: {_int(f0.get('n_swaps'))} swaps, fees {_usd(f0.get('fees'))}, "
      f"picked HL {_usd(f0.get('picked_hl_1h'))}, picked self {_usd(f0.get('picked_self_1h'))}, edge HL {_num(f0.get('edge_hl_1h'))}. "
      "Equality with `hl_ref/by_pool.parquet` and `m0/by_pool.parquet` is asserted in `tests/test_backtest.py`.")
    fr = [f"{p} {_usd(g('FULL', p, 'R1').get('d_net_hl_1h'), True)}" for p in POOL_ORDER]
    A(f"- Fixed rules over the FULL sample (Jul 5 → Sep 18, no fitting involved), R1 Δ: {', '.join(fr)}.")
    A("- Look-ahead: decisions read only `PRE_COLS`. The tests perturb every HL point and pool price after a cutoff, on synthetic data "
      "and on real NVDA data at lags 0, 1 s and 5 s, and verify decisions before the cutoff are identical. They also verify the fitted φ "
      "ignores TEST outcomes and the calendar windows are DST-correct.")
    A("- The R2g guard reads TRAIN only (tested: scrambling TEST outcomes leaves it unchanged), and each cell's guard gain equals the "
      "φ-curve gain net_kept(φ) − net_kept(∞) (tested on the written outputs). Fixed-window slices add up to each rule's total.")
    A(f"- Runtime {ctx['runtime_s']:.0f} s.\n")
    A("\n## Caveats\n")
    A("- **Pool-level counterfactual:** the LP's absence is assumed not to change prices or flow. In reality, pulling liquidity "
      "moves the curve, so remaining swaps would get worse prices and some flow would route elsewhere. Treat Δ as the LP book's "
      "exposure, not a P&L forecast.")
    A(f"- **Short and lumpy TEST:** {int(boot['days'].max())} days; every rule that gained more than $1k on TEST (NVDA or all pools) "
      f"had its best day on {' or '.join(best_days) if best_days else '–'}. The 1h HL markout is noisy. " + significance_sentence(boot))
    A(f"- **Reference mismatch and distribution shift:** TRAIN gaps use 15m candles, TEST gaps 5m/1m. R2/15m is the like-for-like "
      f"check, and even at the same reference the TRAIN-fitted φ fires far less in TEST (NVDA out-share {_pct(o_tr)} → {_pct(o_15)}), so "
      "reference quality explains only part of R2's failure. A fresh-reference TRAIN period does not exist yet.")
    lowphi = phi.filter((pl.col("fit_on") == "TRAIN") & (pl.col("period") == "TRAIN") & (pl.col("phi") <= 2))
    low_txt = ", ".join(f"{r['family']}{STATE[r['state']].suffix} {r['pool']} {r['grp']} φ = {_num(r['phi'], 0)} "
                        f"({_pct(r['n_absent'] / r['n'], 0)} out)" for r in lowphi.sort("family", "state").iter_rows(named=True))
    spec = jr.sort("family")
    spec_txt = (" The spec R4/R5 fits chose " + " and ".join(f"{r['family']} φ = {_num(r['phi'], 0)} bp" for r in spec.iter_rows(named=True))
                + f" for NVDA REGULAR, out for {_pct(spec['out'].min(), 0)}–{_pct(spec['out'].max(), 0)} of REGULAR swaps in TRAIN." if spec.height else "")
    A(f"- **Near-zero φ:** the grid allows φ = 0 (out for a whole regime). "
      + (f"TRAIN fits at φ ≤ 2 bp: {low_txt} (the lagged variants only)." if lowphi.height and not lowphi["state"].is_in(["L0", "C15"]).any()
         else f"TRAIN fits at φ ≤ 2 bp: {low_txt}." if lowphi.height else "No TRAIN fit chose φ ≤ 2 bp.")
      + spec_txt + " Both are close to a regime-wide schedule, which exposes them to regime-level non-stationarity (NVDA REGULAR "
      f"went from {_usd(g('TRAIN', NV, 'R0', 'regime_group', 'REGULAR').get('net_hl_1h'), True)} in TRAIN to "
      f"{_usd(g('TEST', NV, 'R0', 'regime_group', 'REGULAR').get('net_hl_1h'), True)} in TEST).")
    if "guard_pass" in phi.columns:
        fails = p0.filter((pl.col("period") == "TRAIN") & (pl.col("phi") < math.inf) & ~pl.col("guard_pass").fill_null(False))
        f_txt = "; ".join(
            f"{r['pool']} {r['grp']} φ = {_num(r['phi'], 0)}: gain {_usd(r['gain'], True)}"
            + (f", {_pct(r['train_top_day_share'], 0)} of it on {r['train_top_day']} ({_int(r['train_top_day_n_out'])} of {_int(r['n_absent'])} out)"
               if r.get("train_top_day_share") is not None else "")
            for r in fails.iter_rows(named=True))
        A(f"- **Thin φ cells:** the spec's grid search has no minimum-gain or minimum-days guard, so some R2 cells are fitted to one "
          f"event or to noise. Cells that fail R2g's guard: {f_txt or 'none'}. R2g (reported separately, not the spec rule) sets these to ∞.")
    A("- R1 and R3 are fixed calendar windows, applied on Labor Day (Sep 7) too. QQQ/SPY has no TRAIN data (it starts Sep 17), so "
      "its gap rule is R0. SPY/USDG's TRAIN picked-off is small, so its avoided-% figures are unstable (SPY R2 TRAIN avoided "
      f"{_pct(g('TRAIN', 'SPY/USDG', 'R2').get('avoided_hl_1h_pct'), 0)} vs HL but {_pct(g('TRAIN', 'SPY/USDG', 'R2').get('avoided_self_1h_pct'), 0)} "
      "vs self).")
    A("\n## Outputs (`data/study/m1/backtest/`)\n")
    A("- `results.parquet`: period × pool (incl. ALL) × rule × slice (`all`, `regime_group`, `ref_res`, `fixed_window`), with all "
      "metrics and absent hours (hours only for `all` / `regime_group`).")
    A("- `phi.parquet`: chosen φ with TRAIN and TEST gain and the TRAIN robustness columns (`train_*`, `guard_pass`). "
      "`grid.parquet`: net vs φ curves. `daily.parquet`: per-day kept fees, picked-off and net.")
    A("- `bootstrap.parquet`: TEST day-block bootstrap of Δ vs R0 and vs R1. `bursts.parquet`: the 3 best ET hours per period × pool × "
      "rule. `gap_dist.parquet`: |gap| distribution per period × reference × pool × regime group.")
    return "\n".join(L) + "\n"


def _concentration(daily: pl.DataFrame, period: str = "TEST") -> pl.DataFrame:
    """Per (pool, rule): the period's Δ vs R0, the best and second-best day, Δ without the best day, the two best days'
    share of Δ (when Δ > 0), and how many days were positive / negative."""
    d = daily.filter(pl.col("period") == period)
    base = d.filter(pl.col("rule") == "R0").select("pool", "date_et", pl.col("net_kept").alias("r0"))
    x = d.filter(pl.col("rule") != "R0").join(base, on=["pool", "date_et"], how="left").with_columns(
        (pl.col("net_kept") - pl.col("r0")).alias("delta"))
    x = x.sort("delta", "date_et", descending=[True, False])
    out = x.group_by("pool", "rule").agg(
        pl.col("delta").sum().alias("delta"),
        pl.col("date_et").first().cast(pl.String).alias("best_day"),
        pl.col("delta").first().alias("best_delta"),
        pl.col("date_et").get(1).cast(pl.String).alias("second_day"),
        pl.col("delta").get(1).alias("second_delta"),
        (pl.col("delta").sum() - pl.col("delta").first()).alias("delta_ex_best"),
        (pl.col("delta") > 0.005).sum().alias("days_pos"),
        (pl.col("delta") < -0.005).sum().alias("days_neg"),
        pl.len().alias("days"),
    )
    return out.with_columns(pl.when(pl.col("delta") > 0).then((pl.col("best_delta") + pl.col("second_delta")) / pl.col("delta"))
                            .alias("top2_share"))


BOOT_PAIRS = [("R1", "R0"), ("R3", "R0"), ("R2", "R0"), ("R2/15m", "R0"), ("R2g", "R0"), ("R2*", "R0"), ("R2", "R1"),
              ("R5", "R1"), ("R4", "R1"), ("R2/15m", "R1"), ("R2g", "R1"), ("R2*", "R1")]


def significant(boot: pl.DataFrame, pairs: list[tuple[str, str]] = BOOT_PAIRS) -> pl.DataFrame:
    """Bootstrap rows (restricted to `pairs`) whose 95% interval excludes zero."""
    keep = pl.lit(False)
    for a, b in pairs:
        keep = keep | ((pl.col("rule") == a) & (pl.col("vs") == b))
    if "scope" in boot.columns:
        keep = keep & (pl.col("scope") == "all swaps")
    return boot.filter(keep & ((pl.col("lo95") > 0) | (pl.col("hi95") < 0)))


def _sig_by_pool(sig: pl.DataFrame) -> str:
    """'on POOL, A − B Δ [lo, hi], …; on POOL2, …' for significant bootstrap rows."""
    by_pool: dict[str, list[str]] = {}
    for r in sig.iter_rows(named=True):
        by_pool.setdefault(r["pool"], []).append(f"{r['rule']} − {r['vs']} {_usd(r['delta'], True)} "
                                                 f"[{_usd(r['lo95'], True)}, {_usd(r['hi95'], True)}]")
    return "; ".join(f"on {'all pools' if p == 'ALL' else p}: {', '.join(v)}" for p, v in by_pool.items())


def significance_sentence(boot: pl.DataFrame, pairs: list[tuple[str, str]] = BOOT_PAIRS, focus: tuple[str, ...] = ("NVDA/USDG", "ALL")) -> str:
    """One sentence, generated from the bootstrap table, on which rule differences have a 95% CI that excludes zero."""
    sig = significant(boot, pairs)
    tested = boot.filter(pl.any_horizontal([(pl.col("rule") == a) & (pl.col("vs") == b) for a, b in pairs]))
    if "scope" in tested.columns:
        tested = tested.filter(pl.col("scope") == "all swaps")
    f = sig.filter(pl.col("pool").is_in(list(focus)))
    head = (f"no {' or '.join('all-pool' if p == 'ALL' else p for p in focus)} difference excludes zero" if f.is_empty() else
            _sig_by_pool(f) + " exclude zero")
    rest = sig.filter(~pl.col("pool").is_in(list(focus)))
    tail = "; no other pool's comparison does either" if rest.is_empty() else "; " + _sig_by_pool(rest) + " exclude zero"
    return f"Of {tested.height} bootstrapped comparisons, {sig.height} have a 95% CI excluding zero: {head}{tail}."


def main():
    pl.Config.set_tbl_rows(80)
    pl.Config.set_tbl_cols(24)
    pl.Config.set_tbl_width_chars(260)
    out = run()
    r = out["results"].filter(pl.col("slice_kind") == "all")
    show = ["period", "pool", "rule", "n_absent", "fees_kept_pct", "avoided_hl_1h_pct", "avoided_hl_5m_pct", "edge_hl_1h",
            "net_hl_1h", "d_net_hl_1h", "d_net_hl_5m", "hours_absent"]
    print(r.filter(pl.col("pool").is_in(["NVDA/USDG", "ALL"])).select(show))


if __name__ == "__main__":
    main()
