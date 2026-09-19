"""M1 truth layer · Module A: re-mark every swap against Hyperliquid trade.xyz 24/7 prices.

M0 marked each swap against the pool's OWN mid h later (self-markout). On weekends the pool is the only onchain price,
so a self-markout can only see what the pool itself later did. Here each swap is marked against an external fair value
F(t) = HL(t) · k(t) built from Hyperliquid trade.xyz perps, which trade around the clock.

Reference series (per HL coin), finest source available at each time:
    tape (~1 s: hl_bbo mid at HL ts, hl_ctx midPx at local receive time) > 1m > 5m > 15m > 1h candles.
A candle contributes one point: its close, stamped at the candle's END boundary (t_close_ms + 1 ms), so a point with
timestamp ≤ t never uses information from after t. Each point carries its resolution `res` (seconds).
Candles still forming when the file was fetched (t_close_ms ≥ file mtime) are dropped.

Pool → HL mapping: NVDA/USDG→xyz:NVDA, TSLA/USDG→xyz:TSLA, SPY/USDG→xyz:SP500 (index level; basis absorbs the ~1/10 scale),
QQQ/SPY→xyz:XYZ100 / xyz:SP500 (a ratio series: a point at every component update; res = the coarser component, age = the
older component).

Basis k (per pool): median over the HL reference points τ inside the most recent COMPLETED US regular session
(09:30–16:00 ET, trading days only) strictly before t of pool_mid(τ) / HL(τ), where pool_mid(τ) is the pool's state at τ
(mid_after of the latest swap ≤ τ). Pairing at HL point times keeps both prices contemporaneous even when HL is only
available at 15m/1h resolution; the per-swap variant (mid_after / HL_asof(ts)) is kept as the `k_swaps` diagnostic.
Swaps before the first completed session use the first session's k and are flagged `k_lookahead`.

Per swap (all prices quote per base, USD via M0's quote_usd):
    F_pre         = k · HL(latest point ≤ t)
    P_pool_before = previous swap's mid_after in the same pool
    gap_pre_bps   = 1e4 · ln(F_pre / P_pool_before)        (> 0: fair above pool → buying is informed)
    picked_hl_h   = s · q · (k · HL(latest point ≤ t+h) − p_ex) · quote_usd
    valid_hl_h    = res ≤ h  ∧  (t+h − point_ts) ≤ max(res, 60 s)  ∧  t+h ≤ last HL timestamp

    uv run python -m markout.hl_ref
"""

from __future__ import annotations

import io
import json
import math
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
import polars as pl

from markout.pools import DATA, POOLS
from markout.study import HOLIDAYS

ET = ZoneInfo("America/New_York")
SWAPS = DATA / "study" / "m0" / "swaps.parquet"
CANDLES = DATA / "raw" / "hl_candles"
TAPE = DATA / "tape"
OUT = DATA / "study" / "m1" / "hl_ref"

HORIZONS = {"1m": 60, "5m": 300, "1h": 3600}
INTERVALS = {"1m": 60, "5m": 300, "15m": 900, "1h": 3600}  # finest → coarsest
TAPE_RES = 1.0
MIN_STALE_S = 60.0
MIN_SESSION_POINTS = 5

# pool → (numerator coin, denominator coin | None)
POOL_REF: dict[str, tuple[str, str | None]] = {
    "NVDA/USDG": ("xyz:NVDA", None),
    "TSLA/USDG": ("xyz:TSLA", None),
    "SPY/USDG": ("xyz:SP500", None),
    "QQQ/SPY": ("xyz:XYZ100", "xyz:SP500"),
}
FEE_BPS = {p.key: p.lp_fee_pips / 100 for p in POOLS}  # headline fee tier in bps (NVDA 5, SPY 5, TSLA 30, QQQ/SPY 2)
SIZE_EDGES = [100.0, 1_000.0, 10_000.0, 100_000.0]
SIZE_LABELS = ["a <$100", "b $100-1k", "c $1k-10k", "d $10k-100k", "e >=$100k"]
REF_SCHEMA = {"ts": pl.Float64, "px": pl.Float64, "res": pl.Float64, "ts_old": pl.Float64}


# ─────────────────────────────── reference series ───────────────────────────────

def _empty_ref() -> pl.DataFrame:
    return pl.DataFrame(schema=REF_SCHEMA)


def load_candles(coin: str, interval: str, cutoff_ms: int | None = None, root: Path = CANDLES) -> pl.DataFrame:
    """Complete candles of one (coin, interval) as reference points (ts = candle end boundary, px = close)."""
    f = root / f"{coin.replace(':', '_')}_{interval}.parquet"
    if not f.exists():
        return _empty_ref()
    cutoff = cutoff_ms if cutoff_ms is not None else int(f.stat().st_mtime * 1000)
    df = pl.read_parquet(f, columns=["t_close_ms", "c"]).filter(pl.col("t_close_ms") < cutoff)
    return candles_to_ref(df, INTERVALS[interval])


def candles_to_ref(df: pl.DataFrame, res_s: float) -> pl.DataFrame:
    return df.select(
        ((pl.col("t_close_ms") + 1) / 1000.0).alias("ts"),
        pl.col("c").cast(pl.Float64).alias("px"),
        pl.lit(float(res_s)).alias("res"),
    ).with_columns(pl.col("ts").alias("ts_old")).sort("ts")


def _read_jsonl(path: Path, schema: dict) -> pl.DataFrame:
    raw = path.read_bytes()
    cut = raw.rfind(b"\n")  # the current hour's file is still being appended: drop a trailing partial line
    if cut < 0:
        return pl.DataFrame(schema=schema)
    raw = raw[: cut + 1]
    try:
        return pl.read_ndjson(io.BytesIO(raw), schema=schema)
    except Exception:  # a corrupt line somewhere: fall back to tolerant line-by-line parsing
        rows = []
        for line in raw.splitlines():
            try:
                rows.append(json.loads(line))
            except ValueError:
                continue
        return pl.DataFrame(rows, schema=schema, strict=False) if rows else pl.DataFrame(schema=schema)


def load_tape(coins: set[str], root: Path = TAPE) -> dict[str, pl.DataFrame]:
    """Live 1 s tape → reference points per coin: hl_bbo mid at HL ts, plus hl_ctx midPx at local receive time."""
    parts = []
    bbo_schema = {"coin": pl.String, "ts": pl.Int64, "bid": pl.Struct({"px": pl.String}), "ask": pl.Struct({"px": pl.String})}
    for f in sorted((root / "hl_bbo").glob("*.jsonl")):
        d = _read_jsonl(f, bbo_schema)
        if d.is_empty():
            continue
        parts.append(d.filter(pl.col("coin").is_in(list(coins))).select(
            "coin",
            (pl.col("ts") / 1000.0).alias("ts"),
            ((pl.col("bid").struct.field("px").cast(pl.Float64, strict=False)
              + pl.col("ask").struct.field("px").cast(pl.Float64, strict=False)) / 2).alias("px"),
        ))
    ctx_schema = {"t": pl.Int64, "coin": pl.String, "midPx": pl.String}
    for f in sorted((root / "hl_ctx").glob("*.jsonl")):
        d = _read_jsonl(f, ctx_schema)
        if d.is_empty():
            continue
        parts.append(d.filter(pl.col("coin").is_in(list(coins))).select(
            "coin", (pl.col("t") / 1000.0).alias("ts"), pl.col("midPx").cast(pl.Float64, strict=False).alias("px"),
        ))
    if not parts:
        return {}
    tape = pl.concat(parts).filter(pl.col("px").is_not_null() & (pl.col("px") > 0) & pl.col("ts").is_not_null())
    out = {}
    for coin in coins:
        d = tape.filter(pl.col("coin") == coin).drop("coin")
        if d.height:
            out[coin] = d.with_columns(pl.lit(TAPE_RES).alias("res")).with_columns(pl.col("ts").alias("ts_old")).sort("ts")
    return out


def merge_sources(sources: list[pl.DataFrame]) -> pl.DataFrame:
    """Merge sources ordered finest → coarsest: a coarser point is kept only outside every finer source's span."""
    covered: list[tuple[float, float]] = []
    parts = []
    for df in sources:
        if df.is_empty():
            continue
        keep = pl.lit(True)
        for a, b in covered:
            keep = keep & ~pl.col("ts").is_between(a, b, closed="both")
        parts.append(df.select(list(REF_SCHEMA)).filter(keep))
        covered.append((float(df["ts"].min()), float(df["ts"].max())))
    if not parts:
        return _empty_ref()
    return pl.concat(parts).sort("ts", maintain_order=True).unique("ts", keep="first", maintain_order=True)  # finer wins ties


def ratio_ref(num: pl.DataFrame, den: pl.DataFrame) -> pl.DataFrame:
    """num/den at every update of either component; res = coarser component, ts_old = older component's timestamp."""
    grid = pl.concat([num.select("ts"), den.select("ts")]).unique().sort("ts")

    def side(r: pl.DataFrame, tag: str) -> pl.DataFrame:
        return r.select("ts", pl.col("px").alias(f"px_{tag}"), pl.col("res").alias(f"res_{tag}"), pl.col("ts_old").alias(f"to_{tag}"))

    g = grid.join_asof(side(num, "a"), on="ts", strategy="backward").join_asof(side(den, "b"), on="ts", strategy="backward")
    return g.drop_nulls().select(
        "ts",
        (pl.col("px_a") / pl.col("px_b")).alias("px"),
        pl.max_horizontal("res_a", "res_b").alias("res"),
        pl.min_horizontal("to_a", "to_b").alias("ts_old"),
    )


def build_references(candle_root: Path = CANDLES, tape_root: Path = TAPE) -> tuple[dict[str, pl.DataFrame], pl.DataFrame]:
    """Per pool reference series + a per-coin source-span table."""
    coins = {c for pair in POOL_REF.values() for c in pair if c}
    tape = load_tape(coins, tape_root)
    per_coin, spans = {}, []
    for coin in sorted(coins):
        srcs = [("tape", tape.get(coin, _empty_ref()))] + [(iv, load_candles(coin, iv, root=candle_root)) for iv in INTERVALS]
        for name, d in srcs:
            if d.height:
                spans.append({"coin": coin, "source": name, "points": d.height,
                              "first_utc": _utc(d["ts"].min()), "last_utc": _utc(d["ts"].max())})
        per_coin[coin] = merge_sources([d for _, d in srcs])
    refs = {}
    for pool, (a, b) in POOL_REF.items():
        refs[pool] = per_coin[a] if b is None else ratio_ref(per_coin[a], per_coin[b])
    return refs, pl.DataFrame(spans)


def _utc(ts: float) -> str:
    return datetime.fromtimestamp(ts, ZoneInfo("UTC")).strftime("%Y-%m-%d %H:%M:%S")


def asof_lookup(ref: pl.DataFrame, times: np.ndarray | pl.Series) -> pl.DataFrame:
    """Latest reference point with ts ≤ each query time. Returns px, res, pt_ts (the point's (oldest) timestamp), in query order."""
    q = pl.DataFrame({"row": np.arange(len(times)), "tq": np.asarray(times, dtype=np.float64)}).sort("tq")
    r = ref.select(pl.col("ts").alias("tq"), "px", "res", pl.col("ts_old").alias("pt_ts"))
    return q.join_asof(r, on="tq", strategy="backward").sort("row").select("px", "res", "pt_ts")


def validity(t: pl.Expr, h: float, res: pl.Expr, pt_ts: pl.Expr, last_ts: float) -> pl.Expr:
    """valid only if resolution ≤ h, point not older than max(res, 60 s) at t+h, and t+h within the HL data."""
    th = t + h
    return (
        res.is_not_null()
        & (res <= h)
        & ((th - pt_ts) <= pl.max_horizontal(res, pl.lit(MIN_STALE_S)))
        & (th <= last_ts)
    ).fill_null(False)


# ─────────────────────────────── basis k ───────────────────────────────

def trading_sessions(d0: date, d1: date) -> pl.DataFrame:
    rows = []
    d = d0
    while d <= d1:
        if d.weekday() < 5 and d not in HOLIDAYS:
            o = datetime(d.year, d.month, d.day, 9, 30, tzinfo=ET).timestamp()
            c = datetime(d.year, d.month, d.day, 16, 0, tzinfo=ET).timestamp()
            rows.append((d, float(o), float(c)))
        d += timedelta(days=1)
    return pl.DataFrame(rows, schema={"session": pl.Date, "open_ts": pl.Float64, "close_ts": pl.Float64}, orient="row")


def calibrate_k(pool_mid: pl.DataFrame, ref: pl.DataFrame, d0: date | None = None, d1: date | None = None) -> pl.DataFrame:
    """Per completed session: k = median over HL points τ in [09:30, 16:00] ET of pool_mid(τ)/HL(τ).

    pool_mid: (ts, mid) in chain order (several swaps may share a ts: the last one is the state at the end of that second).
    """
    pm = pool_mid.select(pl.col("ts").cast(pl.Float64), pl.col("mid").cast(pl.Float64)).unique("ts", keep="last", maintain_order=True).sort("ts")
    if d0 is None:
        d0 = datetime.fromtimestamp(pm["ts"].min(), ET).date()
    if d1 is None:
        d1 = datetime.fromtimestamp(pm["ts"].max(), ET).date()
    sess = trading_sessions(d0, d1)
    empty = sess.with_columns(pl.lit(None, pl.Float64).alias("k"), pl.lit(0, pl.UInt32).alias("n_points"))
    if sess.is_empty() or ref.is_empty():
        return empty
    pts = ref.select("ts", "px").filter(pl.col("ts").is_between(sess["open_ts"].min(), sess["close_ts"].max()))
    pts = pts.join_asof(sess.select("open_ts", "close_ts", "session").rename({"open_ts": "ts"}).with_columns(pl.col("ts").alias("open_ts")),
                        on="ts", strategy="backward")
    pts = pts.filter(pl.col("session").is_not_null() & (pl.col("ts") <= pl.col("close_ts")))
    pts = pts.join_asof(pm, on="ts", strategy="backward").filter(pl.col("mid").is_not_null())
    agg = pts.group_by("session").agg((pl.col("mid") / pl.col("px")).median().alias("k"), pl.len().alias("n_points"))
    return sess.join(agg, on="session", how="left").with_columns(pl.col("n_points").fill_null(0)).sort("close_ts")


def k_at(times: np.ndarray | pl.Series, sessions: pl.DataFrame) -> pl.DataFrame:
    """k of the most recent completed session strictly before each time; before the first one, the first session's k (flagged)."""
    good = sessions.filter(pl.col("k").is_not_null() & (pl.col("n_points") >= MIN_SESSION_POINTS)).sort("close_ts")
    n = len(times)
    if good.is_empty():
        return pl.DataFrame({"k": [None] * n, "k_session": [None] * n, "k_lookahead": [True] * n},
                            schema={"k": pl.Float64, "k_session": pl.Date, "k_lookahead": pl.Boolean})
    q = pl.DataFrame({"row": np.arange(n), "tq": np.asarray(times, dtype=np.float64)}).sort("tq")
    r = good.select(pl.col("close_ts").alias("tq"), "k", pl.col("session").alias("k_session"))
    j = q.join_asof(r, on="tq", strategy="backward", allow_exact_matches=False).sort("row")
    first = good.row(0, named=True)
    return j.select(
        pl.col("k").fill_null(first["k"]),
        pl.col("k_session").fill_null(first["session"]),
        pl.col("k").is_null().alias("k_lookahead"),
    )


# ─────────────────────────────── per-swap markouts ───────────────────────────────

SWAP_COLS = ["pool", "block", "tx_index", "log_index", "ts", "s", "q", "p_ex", "mid_after", "quote_usd", "vol_usd", "fee_usd",
             "picked_usd_1m", "picked_usd_5m", "picked_usd_1h", "valid_1m", "valid_5m", "valid_1h",
             "regime", "reopen_window", "how", "date_et"]
KEY = ["pool", "block", "tx_index", "log_index"]


def mark_swaps(sw: pl.DataFrame, ref: pl.DataFrame, sessions: pl.DataFrame) -> pl.DataFrame:
    """Add HL-referenced columns to one pool's swaps (sw must be in chain order).

    Besides the spec columns, `picked_selfm_h` re-marks the swap against the POOL's own mid at the exact HL point time
    used for `picked_hl_h` (pt_ts ∈ [t+h − max(res, 60 s), t+h]). With candles the HL point can be up to one candle older
    than t+h, so picked_selfm vs picked_hl isolates the reference effect from that horizon effect.
    """
    t = sw["ts"].to_numpy()
    last_ts = float(ref["ts"].max()) if ref.height else -math.inf
    k = k_at(t, sessions)
    pre = asof_lookup(ref, t)
    pool_mid = (sw.select(pl.col("ts").alias("tq"), pl.col("mid_after").alias("pm"))
                .unique("tq", keep="last", maintain_order=True).sort("tq"))
    out = sw.with_columns(
        k["k"], k["k_session"], k["k_lookahead"],
        pre["px"].alias("hl_pre"), pre["res"].alias("ref_res_s"), (pl.Series(t) - pre["pt_ts"]).alias("pre_age_s"),
        pl.col("mid_after").shift(1).alias("P_pool_before"),
    ).with_columns((pl.col("k") * pl.col("hl_pre")).alias("F_pre"))
    out = out.with_columns(
        (1e4 * (pl.col("F_pre") / pl.col("P_pool_before")).log()).alias("gap_pre_bps"),
        ((pl.col("pre_age_s") <= pl.max_horizontal(pl.col("ref_res_s"), pl.lit(MIN_STALE_S))) & pl.col("F_pre").is_not_null()).fill_null(False).alias("valid_pre"),
    )
    out = out.with_columns(demeaned_gap(out))
    for name, h in HORIZONS.items():
        r = asof_lookup(ref, t + h)
        q = pl.DataFrame({"row": np.arange(len(t)), "tq": r["pt_ts"].fill_null(-1.0)}).sort("tq")
        pm = q.join_asof(pool_mid, on="tq", strategy="backward").sort("row")["pm"]
        out = out.with_columns(
            (pl.col("k") * r["px"]).alias(f"F_{name}"),
            r["res"].alias("_res"), r["pt_ts"].alias("_pt"), pm.alias("_pm"),
        ).with_columns(
            (pl.col("s") * pl.col("q") * (pl.col(f"F_{name}") - pl.col("p_ex")) * pl.col("quote_usd")).alias(f"picked_hl_{name}"),
            (pl.col("s") * pl.col("q") * (pl.col("_pm") - pl.col("p_ex")) * pl.col("quote_usd")).alias(f"picked_selfm_{name}"),
            (pl.col("_pt") - pl.col("ts")).alias(f"hl_h_eff_{name}"),
            validity(pl.col("ts"), h, pl.col("_res"), pl.col("_pt"), last_ts).alias(f"valid_hl_{name}"),
        ).drop("_res", "_pt", "_pm")
    return out


DM_WINDOW_S = 3600


def demeaned_gap(df: pl.DataFrame) -> pl.Series:
    """gap_pre_bps minus the trailing (strictly earlier) 1 h median of fresh gaps in the same pool: a causal correction
    for slow basis drift (e.g. a weekend premium that the previous session's k cannot know about)."""
    v = df.select(pl.int_range(pl.len()).alias("row"), (pl.col("ts") * 1e6).cast(pl.Int64).alias("t_us"), "gap_pre_bps", "valid_pre")
    fresh = v.filter(pl.col("valid_pre") & pl.col("gap_pre_bps").is_finite())
    med = fresh.with_columns(pl.col("gap_pre_bps").rolling_median_by("t_us", window_size=f"{DM_WINDOW_S * 1_000_000}i", closed="left").alias("_m"))
    j = v.join(med.select("row", "_m"), on="row", how="left").sort("row")
    return (j["gap_pre_bps"] - j["_m"]).alias("gap_pre_dm_bps")


def how_expr() -> pl.Expr:
    """Hour of week in ET, Mon 00:00 = 0 … Sun 23:00 = 167. (Recomputed here: M0's `how` overflows Int8 on Sundays.)"""
    et = pl.from_epoch(pl.col("ts").cast(pl.Int64), time_unit="s").dt.replace_time_zone("UTC").dt.convert_time_zone("America/New_York")
    return ((et.dt.weekday().cast(pl.Int32) - 1) * 24 + et.dt.hour().cast(pl.Int32)).alias("how")


def reopen_kind_expr() -> pl.Expr:
    et = pl.from_epoch(pl.col("ts").cast(pl.Int64), time_unit="s").dt.replace_time_zone("UTC").dt.convert_time_zone("America/New_York")
    dow = et.dt.weekday()
    mins = et.dt.hour().cast(pl.Int32) * 60 + et.dt.minute().cast(pl.Int32)
    sun = ((dow == 7) & (mins >= 19 * 60 + 50)) | ((dow == 1) & (mins < 20))
    open_ = (dow <= 5) & (mins >= 9 * 60 + 20) & (mins < 9 * 60 + 45)
    return pl.when(sun).then(pl.lit("SUN_REOPEN 19:50-00:20")).when(open_).then(pl.lit("OPEN 09:20-09:45")).otherwise(pl.lit("none")).alias("reopen_kind")


def res_class_expr() -> pl.Expr:
    r = pl.col("ref_res_s")
    return (pl.when(r <= 60).then(pl.lit("<=1m")).when(r <= 300).then(pl.lit("5m")).when(r <= 900).then(pl.lit("15m"))
            .otherwise(pl.lit("1h")).alias("res_class"))


def weekend_expr() -> pl.Expr:
    """Saturday (ET date) of the weekend a WEEKEND_DARK swap belongs to."""
    dow = pl.col("date_et").dt.weekday()
    return (pl.col("date_et") + pl.duration(days=pl.when(dow == 5).then(1).when(dow == 7).then(-1).otherwise(0))).alias("weekend")


def size_bucket_expr() -> pl.Expr:
    return pl.col("vol_usd").cut(SIZE_EDGES, labels=SIZE_LABELS, left_closed=True).cast(pl.String).alias("size_bucket")


# ─────────────────────────────── summaries ───────────────────────────────

def edge_table(df: pl.DataFrame, by: list[str]) -> pl.DataFrame:
    """edge_self vs edge_hl on the SAME swaps: only swaps valid for both the self and the HL markout at horizon h."""
    exprs = [pl.len().alias("swaps"), pl.col("vol_usd").sum(), pl.col("fee_usd").sum()]
    for h in HORIZONS:
        m = pl.col(f"valid_hl_{h}") & pl.col(f"valid_{h}")
        exprs += [
            m.sum().alias(f"n_{h}"),
            pl.col("vol_usd").filter(m).sum().alias(f"vol_{h}"),
            pl.col("fee_usd").filter(m).sum().alias(f"fee_{h}"),
            pl.col(f"picked_usd_{h}").filter(m).sum().alias(f"picked_self_{h}"),
            pl.col(f"picked_hl_{h}").filter(m).sum().alias(f"picked_hl_{h}"),
            pl.col(f"picked_selfm_{h}").filter(m).sum().alias(f"picked_selfm_{h}"),
            pl.col(f"hl_h_eff_{h}").filter(m).median().alias(f"h_eff_med_{h}"),
            # $ change of picked_hl_h if k were 1 bp higher (net-flow exposure to basis error)
            (1e-4 * pl.col("s") * pl.col("q") * pl.col(f"F_{h}") * pl.col("quote_usd")).filter(m).sum().alias(f"k_sens_per_bp_{h}"),
        ]
    out = df.group_by(by).agg(exprs)
    post = []
    for h in HORIZONS:
        post += [
            (pl.col(f"fee_{h}") / pl.col(f"fee_usd")).alias(f"fee_cov_{h}"),
            (pl.col(f"fee_{h}") / pl.col(f"picked_self_{h}")).alias(f"edge_self_{h}"),
            (pl.col(f"fee_{h}") / pl.col(f"picked_selfm_{h}")).alias(f"edge_selfm_{h}"),
            (pl.col(f"fee_{h}") / pl.col(f"picked_hl_{h}")).alias(f"edge_hl_{h}"),
            ((pl.col(f"fee_{h}") - pl.col(f"picked_self_{h}")) / pl.col(f"vol_{h}") * 1e4).alias(f"lp_net_self_bps_{h}"),
            ((pl.col(f"fee_{h}") - pl.col(f"picked_hl_{h}")) / pl.col(f"vol_{h}") * 1e4).alias(f"lp_net_hl_bps_{h}"),
        ]
    return out.with_columns(post).sort(by)


def gap_pctl_table(df: pl.DataFrame, by: list[str]) -> pl.DataFrame:
    g = pl.col("gap_pre_bps")
    qs = [0.01, 0.05, 0.25, 0.5, 0.75, 0.95, 0.99]
    return (df.filter(pl.col("valid_pre") & g.is_not_null() & g.is_finite())
            .group_by(by).agg(pl.len().alias("n"), *[g.quantile(q).alias(f"p{int(q * 100):02d}") for q in qs],
                              g.abs().mean().alias("mean_abs"), g.abs().median().alias("median_abs"),
                              pl.col("gap_pre_dm_bps").abs().median().alias("median_abs_dm"),
                              (g.abs() > pl.col("fee_bps")).mean().alias("share_abs_gt_fee"))
            .sort(by))


def informed_table(df: pl.DataFrame, by: list[str]) -> pl.DataFrame:
    g = pl.col("gap_pre_bps")
    d = df.filter(pl.col("valid_pre") & g.is_not_null() & g.is_finite() & (g != 0)).with_columns(
        (g.sign().cast(pl.Int64) == pl.col("s")).alias("toward"),
        (g.abs() > pl.col("fee_bps")).alias("big"),
        (pl.col("gap_pre_dm_bps").sign().cast(pl.Int64) == pl.col("s")).alias("toward_dm"),
    )
    m5 = pl.col("valid_hl_5m") & pl.col("valid_5m")
    return (d.group_by(by).agg(
        pl.len().alias("n"),
        pl.col("toward").mean().alias("share_toward"),
        ((pl.col("toward").cast(pl.Float64) * pl.col("vol_usd")).sum() / pl.col("vol_usd").sum()).alias("vw_share_toward"),
        pl.col("big").sum().alias("n_gap_gt_fee"),
        pl.col("toward").filter(pl.col("big")).mean().alias("share_toward_gap_gt_fee"),
        pl.col("toward_dm").mean().alias("share_toward_dm"),
        pl.col("toward_dm").filter(pl.col("gap_pre_dm_bps").abs() > pl.col("fee_bps")).mean().alias("share_toward_dm_gt_fee"),
        pl.col("picked_hl_5m").filter(m5 & pl.col("toward")).sum().alias("picked_hl_5m_toward"),
        pl.col("picked_hl_5m").filter(m5 & ~pl.col("toward")).sum().alias("picked_hl_5m_against"),
        pl.col("fee_usd").filter(m5 & pl.col("toward")).sum().alias("fee_5m_toward"),
        pl.col("fee_usd").filter(m5 & ~pl.col("toward")).sum().alias("fee_5m_against"),
    ).sort(by))


def load_pool_swaps(pool: str) -> pl.DataFrame:
    return (pl.scan_parquet(SWAPS).filter(pl.col("pool") == pool).select(SWAP_COLS).collect()
            .sort(["block", "tx_index", "log_index"]))


def run(out_dir: Path = OUT) -> dict[str, pl.DataFrame]:
    out_dir.mkdir(parents=True, exist_ok=True)
    refs, spans = build_references()
    parts, tables = [], {n: [] for n in ["by_pool", "by_regime", "by_reopen", "by_reopen_kind", "by_how", "k_sessions",
                                          "gap_by_regime", "informed_by_regime", "informed_by_size", "coverage", "by_weekend"]}
    for pool in POOL_REF:
        ref = refs[pool]
        sw = load_pool_swaps(pool)
        if sw.is_empty():
            continue
        sessions = calibrate_k(sw.select("ts", pl.col("mid_after").alias("mid")), ref)
        m = mark_swaps(sw, ref, sessions).with_columns(
            how_expr(), reopen_kind_expr(), res_class_expr(), size_bucket_expr(), pl.lit(FEE_BPS[pool]).alias("fee_bps"))
        # per-swap k diagnostic (mid_after / HL_asof(ts) over the session's swaps; fine only where HL is fine)
        ks = (m.select("ts", "mid_after", "hl_pre").join_asof(sessions.select(pl.col("open_ts").alias("ts"), "session", "close_ts").sort("ts"), on="ts", strategy="backward")
              .filter(pl.col("session").is_not_null() & (pl.col("ts") < pl.col("close_ts")))
              .group_by("session").agg((pl.col("mid_after") / pl.col("hl_pre")).median().alias("k_swaps"), pl.len().alias("n_swaps")))
        tables["k_sessions"].append(sessions.join(ks, on="session", how="left").with_columns(pl.lit(pool).alias("pool")))
        part = out_dir / f"_part_{pool.replace('/', '_')}.parquet"
        m.select(*KEY, "ts", "F_pre", "P_pool_before", "gap_pre_bps", "ref_res_s", "pre_age_s", "valid_pre",
                 "k", "k_session", "k_lookahead", "F_1m", "F_5m", "F_1h",
                 "picked_hl_1m", "picked_hl_5m", "picked_hl_1h", "valid_hl_1m", "valid_hl_5m", "valid_hl_1h",
                 "gap_pre_dm_bps", "picked_selfm_1m", "picked_selfm_5m", "picked_selfm_1h",
                 "hl_h_eff_1m", "hl_h_eff_5m", "hl_h_eff_1h").write_parquet(part)
        parts.append(part)
        tables["by_pool"].append(edge_table(m, ["pool"]))
        tables["by_regime"].append(edge_table(m, ["pool", "regime"]))
        tables["by_reopen"].append(edge_table(m, ["pool", "reopen_window"]))
        tables["by_reopen_kind"].append(edge_table(m, ["pool", "regime", "reopen_kind"]))
        if pool == "NVDA/USDG":
            tables["by_how"].append(edge_table(m, ["pool", "how"]))
        tables["by_weekend"].append(edge_table(m.filter(pl.col("regime") == "WEEKEND_DARK").with_columns(weekend_expr()), ["pool", "weekend"]))
        tables["gap_by_regime"].append(gap_pctl_table(m, ["pool", "res_class", "regime"]))
        tables["informed_by_regime"].append(informed_table(m, ["pool", "res_class", "regime"]))
        tables["informed_by_size"].append(informed_table(m, ["pool", "res_class", "size_bucket"]))
        tables["coverage"].append(m.group_by("pool", "res_class").agg(
            pl.len().alias("swaps"), pl.col("vol_usd").sum(), pl.col("fee_usd").sum(),
            pl.col("valid_pre").mean().alias("valid_pre_share"),
            *[pl.col(f"valid_hl_{h}").mean().alias(f"valid_hl_{h}_share") for h in HORIZONS],
            pl.col("k_lookahead").mean().alias("k_lookahead_share"),
            pl.col("ts").min().alias("t_first"), pl.col("ts").max().alias("t_last"),
        ).sort("pool", "t_first"))
        print(f"{pool}: {m.height:,} swaps marked; HL ref points {ref.height:,}; sessions with k {sessions.filter(pl.col('k').is_not_null()).height}")
        del m, sw

    pl.concat([pl.scan_parquet(p) for p in parts]).sink_parquet(out_dir / "hl_markouts.parquet")
    for p in parts:
        p.unlink()
    res = {n: pl.concat(v, how="diagonal_relaxed") for n, v in tables.items() if v}
    res["ref_sources"] = spans
    for n, df in res.items():
        df.write_parquet(out_dir / f"{n}.parquet")
    (out_dir / "hl_summary.md").write_text(render_md(res))
    return res


# ─────────────────────────────── report ───────────────────────────────

def _fmt(v, kind: str = "num") -> str:
    if v is None or (isinstance(v, float) and (math.isnan(v) or math.isinf(v))):
        return "–"
    if kind == "usd":
        return f"${v / 1e6:,.2f}M" if abs(v) >= 1e6 else (f"${v / 1e3:,.1f}k" if abs(v) >= 1e3 else f"${v:,.0f}")
    if kind == "pct":
        return f"{100 * v:.1f}%"
    if kind == "k":
        return f"{v:.6g}"
    if kind == "int":
        return f"{int(v):,}"
    if isinstance(v, float):
        return f"{v:,.2f}"
    return str(v)


def _edge(fee, picked) -> str:
    if picked is None or not fee:
        return "–"
    if picked <= 0:
        return "∞ (picked≤0)"
    return f"{fee / picked:.2f}"


def _md(df: pl.DataFrame, cols: list[tuple[str, str, str]]) -> str:
    """cols: (header, column or 'edge:<h>:<self|hl>', format)."""
    head = "| " + " | ".join(h for h, _, _ in cols) + " |\n|" + "---|" * len(cols) + "\n"
    lines = []
    for r in df.iter_rows(named=True):
        cells = []
        for _, c, f in cols:
            if c.startswith("edge:"):
                _, h, which = c.split(":")
                cells.append(_edge(r[f"fee_{h}"], r[f"picked_{which}_{h}"]))
            else:
                cells.append(_fmt(r[c], f))
        lines.append("| " + " | ".join(cells) + " |")
    return head + "\n".join(lines) + "\n"


def _edge_cols(h: str, short: bool = False) -> list[tuple[str, str, str]]:
    cols = [(f"swaps", f"n_{h}", "int"), (f"fees", f"fee_{h}", "usd"),
            (f"picked self", f"picked_self_{h}", "usd"), (f"picked HL", f"picked_hl_{h}", "usd"),
            (f"edge self", f"edge:{h}:self", ""), (f"edge self@HL-time", f"edge:{h}:selfm", ""), (f"edge HL", f"edge:{h}:hl", "")]
    if not short:
        cols += [(f"HL h_eff (s)", f"h_eff_med_{h}", "int"), (f"$/bp k err", f"k_sens_per_bp_{h}", "usd")]
    return cols


HOW_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]


def weekend_table(t: dict[str, pl.DataFrame]) -> pl.DataFrame | None:
    return t.get("by_weekend")


def _row(df: pl.DataFrame, **eq) -> dict | None:
    d = df
    for c, v in eq.items():
        d = d.filter(pl.col(c) == v)
    return d.row(0, named=True) if d.height else None


def _e(r: dict | None, h: str, which: str) -> float | None:
    if r is None or not r.get(f"fee_{h}") or r.get(f"picked_{which}_{h}") is None:
        return None
    p = r[f"picked_{which}_{h}"]
    return r[f"fee_{h}"] / p if p > 0 else math.inf


def render_md(t: dict[str, pl.DataFrame]) -> str:
    reg = t["by_regime"]
    L = ["# M1 · HL-referenced markouts (module A: `markout/hl_ref.py`)\n",
         "Every swap re-marked against Hyperliquid trade.xyz 24/7 prices: `picked_hl_h = s·q·(F(t+h) − p_ex)·quote_usd` with "
         "`F = HL·k`. **edge = LP fees / picked-off** (> 1: LPs net positive). Every comparison uses the *same swaps*: those "
         "valid for both M0's self markout and the HL markout at that horizon.\n",
         "- `edge self` = M0 self markout (pool's own mid at t+h).\n"
         "- `edge self@HL-time` = pool's own mid at the exact time of the HL point used (candles make that up to one candle "
         "earlier than t+h; `HL h_eff` is its median horizon in seconds). `self@HL-time` → `HL` is the pure reference effect.\n"
         "- `edge HL` = marked against HL·k.\n"
         "- `$/bp k err` = how much `picked HL` moves if the basis k is off by 1 bp (net-flow exposure to basis error).\n"]
    # ── headline
    L.append("## Headline: is the weekend-dark edge real?\n")
    nv = _row(reg, pool="NVDA/USDG", regime="WEEKEND_DARK")
    nv_reg = _row(reg, pool="NVDA/USDG", regime="REGULAR")
    if nv:
        e1s, e1m, e1h = _e(nv, "1h", "self"), _e(nv, "1h", "selfm"), _e(nv, "1h", "hl")
        e5s, e5m, e5h = _e(nv, "5m", "self"), _e(nv, "5m", "selfm"), _e(nv, "5m", "hl")
        verdict = ("**Yes, but smaller than M0 said.**" if (e1h or 0) >= 2 and (e5h or 0) >= 2 else
                   "**Partly.**" if (e1h or 0) >= 1 else "**No.**")
        L.append(f"{verdict} NVDA/USDG weekend-dark (Fri 20:00 → Sun 20:00 ET), same swaps:\n")
        L.append(f"- **1h, all weekends** ({nv['n_1h']:,} swaps, {_fmt(nv['fee_1h'], 'usd')} fees): edge self **{e1s:.2f}** → "
                 f"self@HL-time {e1m:.2f} → **HL {e1h:.2f}**. LPs keep "
                 f"{_fmt(nv['fee_1h'] - nv['picked_hl_1h'], 'usd')} net vs HL (M0 self: {_fmt(nv['fee_1h'] - nv['picked_self_1h'], 'usd')}).")
        L.append(f"- **5m, Sep 1 → (5m candles; 2 weekends)** ({nv['n_5m']:,} swaps, {_fmt(nv['fee_5m'], 'usd')} fees): edge self "
                 f"**{e5s:.2f}** → self@HL-time {e5m:.2f} → **HL {e5h:.2f}**: the self markout overstates the 5m weekend edge "
                 f"{e5s / e5h:.1f}×, because the pool itself lags HL over the weekend.")
        if nv_reg:
            L.append(f"- For contrast, REGULAR hours: HL edge {_e(nv_reg, '1h', 'hl'):.2f} at 1h and {_e(nv_reg, '5m', 'hl'):.2f} at 5m "
                     f"(self {_e(nv_reg, '1h', 'self'):.2f} / {_e(nv_reg, '5m', 'self'):.2f}). The weekend is still the NVDA pool's "
                     f"best regime against HL.")
        bw0 = t.get("by_weekend")
        if bw0 is not None and bw0.filter(pl.col("pool") == "NVDA/USDG").height:
            w = bw0.filter(pl.col("pool") == "NVDA/USDG").sort("picked_hl_1h", descending=True)
            top = w.row(0, named=True)
            rest = w.slice(1)
            e_rest = rest["fee_1h"].sum() / rest["picked_hl_1h"].sum() if rest["picked_hl_1h"].sum() > 0 else math.inf
            L.append(f"- **It is lumpy.** The weekend of {top['weekend']} alone accounts for "
                     f"{top['picked_hl_1h'] / nv['picked_hl_1h']:.0%} of the weekend `picked HL@1h` (edge HL {_e(top, '1h', 'hl'):.2f} "
                     f"that weekend); the other {rest.height} weekends together run at edge HL {e_rest:.2f}. Quiet weekends are very "
                     f"profitable; a weekend where HL trends leaves the pool behind (see the gap table).")
        L.append(f"- Basis risk is small: a 1 bp error in k moves weekend `picked HL@1h` by {_fmt(abs(nv['k_sens_per_bp_1h']), 'usd')} "
                 f"(net flow nearly balanced), vs {_fmt(nv['picked_hl_1h'], 'usd')} picked.\n")
    wk = reg.filter(pl.col("regime") == "WEEKEND_DARK")
    for h in ["1h", "5m"]:
        L.append(f"**All pools, weekend-dark, horizon {h}**\n")
        L.append(_md(wk, [("pool", "pool", "")] + _edge_cols(h)))
    bw = t.get("by_weekend")
    if bw is not None:
        L.append("\n**NVDA/USDG weekend by weekend** (Saturday date; 1h all weekends, 5m where 5m candles exist)\n")
        L.append(_md(bw.filter(pl.col("pool") == "NVDA/USDG"),
                     [("weekend (Sat)", "weekend", "")] + _edge_cols("1h", short=True) + [("edge self@5m", "edge:5m:self", ""), ("edge HL@5m", "edge:5m:hl", "")]))
    L.append("\n## By pool\n")
    for h in HORIZONS:
        L.append(f"**{h}**\n")
        L.append(_md(t["by_pool"], [("pool", "pool", "")] + _edge_cols(h)))
    L.append("\n## Pool × regime\n")
    for h in ["5m", "1h"]:
        L.append(f"**{h}**\n")
        L.append(_md(reg, [("pool", "pool", ""), ("regime", "regime", "")] + _edge_cols(h)))
    L.append("\n## Reopen windows\n")
    rk = t["by_reopen_kind"].filter(pl.col("reopen_kind") != "none")
    for h in ["5m", "1h"]:
        L.append(f"**{h}** (Sunday reopen Sun 19:50 → Mon 00:20 ET; weekday cash open 09:20–09:45 ET)\n")
        L.append(_md(rk, [("pool", "pool", ""), ("regime", "regime", ""), ("window", "reopen_kind", "")] + _edge_cols(h, short=True)))
    L.append("\n**M0 reopen flag (pool × reopen_window)**, 1h\n")
    L.append(_md(t["by_reopen"], [("pool", "pool", ""), ("reopen", "reopen_window", "")] + _edge_cols("1h", short=True)))
    if "by_how" in t:
        how = t["by_how"].with_columns(
            pl.format("{} {}:00", pl.col("how").floordiv(24).map_elements(lambda d: HOW_NAMES[d], return_dtype=pl.String),
                      pl.col("how").mod(24).cast(pl.String).str.zfill(2)).alias("hour_et"))
        L.append("\n## NVDA/USDG hour-of-week (ET)\n")
        L.append("The 10 hours with the lowest HL edge at 1h (≥ $1k fees valid), plus the M0 call-outs Mon 09 and Wed 17. "
                 "Full 168-hour table: `by_how.parquet`.\n")
        pick = how.filter(pl.col("fee_1h") >= 1000).with_columns(
            pl.when(pl.col("picked_hl_1h") > 0).then(pl.col("fee_1h") / pl.col("picked_hl_1h")).otherwise(1e9).alias("_e")).sort("_e").head(10)
        extra = how.filter(pl.col("how").is_in([9, 65]))
        sel = pl.concat([pick.drop("_e"), extra]).unique("how", maintain_order=True)
        L.append(_md(sel, [("hour", "hour_et", "")] + _edge_cols("1h", short=True) + [("edge self@5m", "edge:5m:self", ""), ("edge HL@5m", "edge:5m:hl", "")]))
        wk_how = how.filter(pl.col("how").is_between(4 * 24 + 20, 6 * 24 + 19))
        L.append("\nWeekend-dark hours (Fri 20:00 → Sun 19:00 ET) at 1h:\n")
        L.append(_md(wk_how, [("hour", "hour_et", "")] + _edge_cols("1h", short=True)))
    L.append("\n## Pre-trade gap `gap_pre_bps = 1e4·ln(F_pre / P_pool_before)` by regime\n")
    L.append("Swaps whose HL point is fresh (age ≤ max(res, 60 s)). `<=1m` = 1m candles + live tape (Sep 15 →, weekdays only), "
             "`5m` = Sep 1–15 (includes 2 weekends + Labor Day). With candles the reference is up to one candle old, so the spread of "
             "the gap is partly reference staleness. `|dm|` = median |gap − trailing-1h median gap| (causal de-meaning of basis drift). "
             "Coarser classes are in `gap_by_regime.parquet` only.\n")
    g = t["gap_by_regime"].filter(pl.col("res_class").is_in(["<=1m", "5m"]))
    L.append(_md(g, [("pool", "pool", ""), ("res", "res_class", ""), ("regime", "regime", ""), ("n", "n", "int"),
                     ("p01", "p01", ""), ("p05", "p05", ""), ("p25", "p25", ""), ("p50", "p50", ""), ("p75", "p75", ""),
                     ("p95", "p95", ""), ("p99", "p99", ""), ("mean |gap|", "mean_abs", ""), ("|dm|", "median_abs_dm", ""),
                     ("|gap|>fee", "share_abs_gt_fee", "pct")]))
    L.append("\n## Informed-flow indicator: share of swaps trading toward HL fair value (sign(gap_pre) = s)\n")
    L.append("50% = no information. `>fee` = swaps where |gap| exceeds the pool's fee tier. `dm` = same with the de-meaned gap. "
             "`picked HL@5m` split by direction (toward vs against).\n")
    icols = [("n", "n", "int"), ("toward", "share_toward", "pct"), ("vol-wtd", "vw_share_toward", "pct"),
             ("n |gap|>fee", "n_gap_gt_fee", "int"), ("toward, |gap|>fee", "share_toward_gap_gt_fee", "pct"),
             ("toward dm", "share_toward_dm", "pct"), ("toward dm, >fee", "share_toward_dm_gt_fee", "pct"),
             ("picked HL@5m toward", "picked_hl_5m_toward", "usd"), ("against", "picked_hl_5m_against", "usd")]
    ir = t["informed_by_regime"].filter(pl.col("res_class").is_in(["<=1m", "5m"]))
    L.append(_md(ir, [("pool", "pool", ""), ("res", "res_class", ""), ("regime", "regime", "")] + icols))
    L.append("\n**By size bucket (vol_usd)**\n")
    isz = t["informed_by_size"].filter(pl.col("res_class").is_in(["<=1m", "5m"]))
    L.append(_md(isz, [("pool", "pool", ""), ("res", "res_class", ""), ("size", "size_bucket", "")] + icols))
    # ── method
    L.append("\n## Reference data & basis\n")
    L.append("Reference points per source actually used after the finest-source merge are fewer; this is what was loaded "
             "(candles still forming at fetch time dropped; tape = hl_bbo mid + hl_ctx midPx).\n")
    L.append(_md(t["ref_sources"], [("coin", "coin", ""), ("source", "source", ""), ("points", "points", "int"),
                                    ("first (UTC)", "first_utc", ""), ("last (UTC)", "last_utc", "")]))
    ks = t["k_sessions"].filter(pl.col("k").is_not_null())
    kstat = ks.group_by("pool").agg(pl.len().alias("sessions"), pl.col("k").min().alias("k_min"), pl.col("k").median().alias("k_med"),
                                    pl.col("k").max().alias("k_max"),
                                    ((pl.col("k_swaps") / pl.col("k")).log().abs() * 1e4).median().alias("k_swaps_vs_k_bps"),
                                    (pl.col("k").log().diff().abs() * 1e4).median().alias("day_to_day_bps")).sort("pool")
    L.append("\n**Basis k per pool**: median of pool_mid(τ)/HL(τ) over HL points τ in each completed 09:30–16:00 ET session, "
             "applied to swaps after that session closes. `k_swaps vs k` = median |ln(k_swaps/k)| in bp for the per-swap variant "
             "(mid_after / HL as of the swap); `day-to-day` = median |Δ ln k| between consecutive sessions, in bp.\n")
    L.append(_md(kstat, [("pool", "pool", ""), ("sessions", "sessions", "int"), ("k min", "k_min", "k"), ("k median", "k_med", "k"),
                         ("k max", "k_max", "k"), ("k_swaps vs k (bp)", "k_swaps_vs_k_bps", ""), ("day-to-day (bp)", "day_to_day_bps", "")]))
    cov = t["coverage"]
    L.append("\n**Coverage by reference resolution at the swap** (`k look-ahead` = swaps before the pool's first completed session)\n")
    L.append(_md(cov, [("pool", "pool", ""), ("res", "res_class", ""), ("swaps", "swaps", "int"), ("fees", "fee_usd", "usd"),
                       ("valid pre", "valid_pre_share", "pct"), ("valid 1m", "valid_hl_1m_share", "pct"),
                       ("valid 5m", "valid_hl_5m_share", "pct"), ("valid 1h", "valid_hl_1h_share", "pct"),
                       ("k look-ahead", "k_lookahead_share", "pct")]))
    return "\n".join(L)


def main():
    pl.Config.set_tbl_rows(40)
    pl.Config.set_tbl_cols(20)
    res = run()
    show = ["pool", "regime", "n_1h", "fee_1h", "picked_self_1h", "picked_hl_1h", "edge_self_1h", "edge_hl_1h", "edge_self_5m", "edge_hl_5m"]
    print("\n=== by pool ===")
    print(res["by_pool"].select([c for c in show if c != "regime"]))
    print("\n=== by pool × regime ===")
    print(res["by_regime"].select(show))
    print(f"\nwrote {OUT}")


if __name__ == "__main__":
    main()
