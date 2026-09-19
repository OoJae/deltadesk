"""DeltaDesk API: the LP truth layer for tokenized stocks.

    uv run uvicorn api.app:app --port 8787

Endpoints (JSON):
  GET /health                   liveness + pipeline step status
  GET /pipeline                 full pipeline state with log tails (premium)
  GET /fair-value/{pool}        HL-derived fair value vs pool mid, gap in bp, Chainlink freshness
  GET /safe-to-lp/{pool}        ALLOW / CAUTION / BLOCK with reasons (gap vs fair value, regime, historical toxicity)
  GET /pool-toxicity/{pool}     historical LP edge by regime / hour-of-week, current hour's record
  GET /study                    headline tables of the Truth Study
  GET /tearsheet/{chain}/{addr} LP P&L decomposition for a wallet (needs positions module output)
  GET /lp-league                LP wallets ranked by net edge (needs positions module output)
Pools: NVDA, SPY, TSLA, QQQ-SPY (or the full key, e.g. NVDA-USDG).
"""

from __future__ import annotations

import hmac
import json
import os
import time
from datetime import datetime
from functools import lru_cache

import polars as pl
from fastapi import Depends, FastAPI, Header, HTTPException

from api import live

app = FastAPI(title="DeltaDesk", version="0.1.0", description="The open market-making desk for tokenized stocks: LP truth layer API.")

# Premium routes are sold over x402 (Bankr x402 Cloud proxies here with this key). If DELTADESK_API_KEY is unset
# (local dev) every route is open.
API_KEY = os.environ.get("DELTADESK_API_KEY", "")


def premium(x_deltadesk_key: str = Header(default="")):
    if API_KEY and not hmac.compare_digest(x_deltadesk_key, API_KEY):
        raise HTTPException(402, "premium endpoint: pay per call via x402 (see /health for the marketplace URL)")


DISCLAIMER = "Informational analytics, not investment advice. Self-markout and HL-referenced estimates; see /study for method."
STUDY = live.DATA / "study"

# Provisional gates (bp of |ln(F/P)|) until the backtest module publishes tuned values (data/study/m1/backtest/).
PHI_BLOCK = {"REGULAR": 15.0, "EXTENDED": 25.0, "OVERNIGHT": 25.0, "WEEKEND_DARK": 60.0, "HOLIDAY": 60.0}
PHI_CAUTION = {k: v / 2 for k, v in PHI_BLOCK.items()}


def _pool(name: str) -> live.Pool:
    try:
        return live.resolve_pool(name)
    except KeyError as e:
        raise HTTPException(404, str(e)) from e


def rows(df: pl.DataFrame) -> list[dict]:
    """to_dicts() with NaN/±inf → None (JSON has no NaN; edges are inf when nothing was picked off)."""
    floats = [c for c, t in df.schema.items() if t in (pl.Float32, pl.Float64)]
    if floats:
        df = df.with_columns([pl.when(pl.col(c).is_finite()).then(pl.col(c)).otherwise(None).alias(c) for c in floats])
    return df.to_dicts()


@lru_cache(maxsize=8)
def _table(name: str, mtime: float) -> pl.DataFrame:
    return pl.read_parquet(STUDY / "m0" / f"{name}.parquet")


def table(name: str) -> pl.DataFrame:
    f = STUDY / "m0" / f"{name}.parquet"
    if not f.exists():
        raise HTTPException(503, f"study table {name} not built yet")
    return _table(name, f.stat().st_mtime)


def hour_record(pool_key: str, how: int) -> dict | None:
    """This hour-of-week's historical LP record: HL-referenced (1h) when available, else self-markout (M0)."""
    hl = STUDY / "m1" / "hl_ref" / "by_how.parquet"
    if hl.exists():
        df = _scope_table(str(hl), hl.stat().st_mtime).filter((pl.col("pool") == pool_key) & (pl.col("how") == how))
        if not df.is_empty():
            r = rows(df)[0]
            fees, picked = r.get("fee_1h") or 0.0, r.get("picked_hl_1h")
            if picked is not None:
                return {"swaps": r.get("n_1h"), "fees_usd": fees, "picked_1h_usd": picked, "edge_1h": fees / picked if picked > 0 else None,
                        "lp_net_bps_1h": r.get("lp_net_hl_bps_1h"), "reference": "hyperliquid"}
    df = table("by_how").filter((pl.col("pool") == pool_key) & (pl.col("how") == how))
    if df.is_empty():
        return None
    r = rows(df)[0]
    picked = r["picked_1h"]
    return {"swaps": r["swaps"], "fees_usd": r["fee_usd"], "picked_1h_usd": picked,
            "edge_1h": r["fee_usd"] / picked if picked and picked > 0 else None, "lp_net_bps_1h": r["lp_net_bps_1h"], "reference": "self"}


def assess(gap_bps: float, regime: live.Regime, hour: dict | None, chainlink_age_s: float | None) -> dict:
    """Pure decision function (unit-tested). Returns verdict + reasons."""
    reasons, verdict = [], "ALLOW"

    def worsen(v: str, why: str):
        nonlocal verdict
        order = {"ALLOW": 0, "CAUTION": 1, "BLOCK": 2}
        if order[v] > order[verdict]:
            verdict = v
        reasons.append({"level": v, "reason": why})

    g = abs(gap_bps)
    if g > PHI_BLOCK[regime.name]:
        worsen("BLOCK", f"pool is {gap_bps:+.1f} bp from fair value (limit {PHI_BLOCK[regime.name]:.0f} bp in {regime.name}); liquidity here gets picked off")
    elif g > PHI_CAUTION[regime.name]:
        worsen("CAUTION", f"pool is {gap_bps:+.1f} bp from fair value (caution above {PHI_CAUTION[regime.name]:.0f} bp)")
    if regime.reopen_window:
        worsen("BLOCK", "reopen window (Sun 19:50–Mon 00:20 or weekday 09:20–09:45 ET): LP edge historically < 1")
    if regime.name in ("WEEKEND_DARK", "HOLIDAY"):
        worsen("CAUTION", "US market closed: fair value is Hyperliquid's internal price, Chainlink is frozen")
    # Toxic hour = informed flow took back more than the fees. edge is only defined when takers gained (picked > 0);
    # picked <= 0 means takers lost on average, which is good for LPs.
    if hour and hour.get("edge_1h") is not None and (hour.get("picked_1h_usd") or 0) > 0:
        e = hour["edge_1h"]
        if e < 0.5:
            worsen("BLOCK", f"this hour of the week informed flow historically took {1 / e:.1f}x what LPs earned in fees (edge {e:.2f})")
        elif e < 1.0:
            worsen("CAUTION", f"this hour of the week LPs historically lost money (edge {e:.2f})")
    if chainlink_age_s is not None and regime.name == "REGULAR" and chainlink_age_s > 3600:
        worsen("CAUTION", f"Chainlink feed is {chainlink_age_s / 3600:.1f} h old during regular hours")
    if not reasons:
        reasons.append({"level": "ALLOW", "reason": "pool is near fair value and this hour has a positive LP record"})
    return {"verdict": verdict, "reasons": reasons}


def _pipeline_state() -> dict:
    f = live.DATA / "pipeline_state.json"
    try:
        return json.loads(f.read_text()) if f.exists() else {}
    except (OSError, ValueError):
        return {}


@app.get("/health")
def health():
    steps = {k: {"ok": v.get("ok"), "ran_at": v.get("ran_at"), "secs": v.get("secs")} for k, v in _pipeline_state().items()}
    return {"ok": True, "time": time.time(), "pipeline_running": (live.DATA / "pipeline.lock").exists(), "pipeline": steps}


@app.get("/pipeline", dependencies=[Depends(premium)])
def pipeline():
    return _pipeline_state()


@app.get("/fair-value/{pool}")
def fair_value(pool: str):
    p = _pool(pool)
    fv = live.fair_value(p)
    cl = live.chainlink(p.base) if p.quote == "USDG" else None
    now = time.time()
    return {
        **fv,
        "regime": live.regime_at(now).name,
        "chainlink": cl and {**cl, "frozen_since_close": datetime.fromtimestamp(cl["updated_at"], live.ET).isoformat()},
        "disclaimer": DISCLAIMER,
    }


@app.get("/safe-to-lp/{pool}", dependencies=[Depends(premium)])
def safe_to_lp(pool: str):
    p = _pool(pool)
    now = time.time()
    fv = live.fair_value(p)
    reg = live.regime_at(now)
    hour = hour_record(p.key, reg.how)
    cl = live.chainlink(p.base) if p.quote == "USDG" else None
    out = assess(fv["gap_bps"], reg, hour, cl and cl["age_s"])
    return {
        "pool": p.key,
        **out,
        "gap_bps": fv["gap_bps"],
        "fair_value": fv["fair_value"],
        "pool_mid": fv["pool_mid"],
        "regime": reg.name,
        "reopen_window": reg.reopen_window,
        "hour_of_week_record": hour,
        "next_regime_change": live.next_regime_change(now),
        "thresholds": {"block_bps": PHI_BLOCK[reg.name], "caution_bps": PHI_CAUTION[reg.name], "source": "provisional"},
        "as_of": now,
        "disclaimer": DISCLAIMER,
    }


@app.get("/pool-toxicity/{pool}", dependencies=[Depends(premium)])
def pool_toxicity(pool: str):
    p = _pool(pool)
    reg = live.regime_at(time.time())
    cols = ["regime", "swaps", "vol_usd", "fee_usd", "picked_1h", "edge_1h", "lp_net_bps_1h"]
    by_regime = table("by_regime").filter(pl.col("pool") == p.key).select(cols)
    by_how = table("by_how").filter(pl.col("pool") == p.key).select("how", "fee_usd", "picked_1h", "edge_1h").sort("picked_1h", descending=True)
    return {
        "pool": p.key,
        "method": "self-markout vs pool mid 1h later (M0); HL-referenced version pending",
        "by_regime": rows(by_regime),
        "worst_hours_of_week": rows(by_how.head(8)),
        "current_hour": {"how": reg.how, **(hour_record(p.key, reg.how) or {})},
        "disclaimer": DISCLAIMER,
    }


@app.get("/study")
def study():
    by_pool = table("by_pool").select("pool", "swaps", "vol_usd", "fee_usd", "picked_1h", "edge_1h", "lp_net_bps_1h")
    by_regime = table("by_regime").select("pool", "regime", "fee_usd", "picked_1h", "edge_1h", "lp_net_bps_1h")
    return {"title": "Can LPs beat LVR on tokenized stocks?", "by_pool": rows(by_pool), "by_regime": rows(by_regime), "disclaimer": DISCLAIMER}


STUDY_SCOPES = {"m0": STUDY / "m0", "hl_ref": STUDY / "m1" / "hl_ref", "flow": STUDY / "m1" / "flow",
                "positions": STUDY / "m1" / "positions", "backtest": STUDY / "m1" / "backtest"}
NOT_PUBLIC = {"swaps", "hl_markouts", "segments", "attribution"}  # row-level tables: too large / served via premium routes


@lru_cache(maxsize=64)
def _scope_table(path: str, mtime: float) -> pl.DataFrame:
    return pl.read_parquet(path)


@app.get("/study/table/{scope}/{name}")
def study_table(scope: str, name: str, pool: str | None = None):
    """Public study tables (aggregates only), e.g. /study/table/hl_ref/by_regime?pool=NVDA."""
    base = STUDY_SCOPES.get(scope)
    if base is None or not name.replace("_", "").isalnum() or name in NOT_PUBLIC:
        raise HTTPException(404, "unknown table")
    f = base / f"{name}.parquet"
    if not f.exists():
        raise HTTPException(503, f"{scope}/{name} not built yet")
    df = _scope_table(str(f), f.stat().st_mtime)
    if pool and "pool" in df.columns:
        df = df.filter(pl.col("pool") == _pool(pool).key)
    return {"scope": scope, "name": name, "rows": rows(df)}


@app.get("/study/tables")
def study_tables():
    out = {}
    for scope, base in STUDY_SCOPES.items():
        if base.exists():
            out[scope] = sorted(f.stem for f in base.glob("*.parquet") if f.stem not in NOT_PUBLIC)
    return out


@app.get("/tearsheet/{chain}/{wallet}", dependencies=[Depends(premium)])
def tearsheet(chain: str, wallet: str, role: str = "auto"):
    if chain not in ("robinhood", "4663"):
        raise HTTPException(501, "only Robinhood Chain (4663) for now; Base/Aerodrome coming in M1.3")
    try:
        from positions.tearsheet import tearsheet as build  # built by the positions module
    except ImportError as e:
        raise HTTPException(503, "positions module not built yet") from e
    if role not in ("auto", "owner", "operator"):
        raise HTTPException(400, "role must be auto, owner or operator")
    return {**build(wallet.lower(), role=role), "disclaimer": DISCLAIMER}


@app.get("/lp-league", dependencies=[Depends(premium)])
def lp_league(limit: int = 50, pool: str | None = None):
    """LP managers (the wallet sending the LP txs) ranked by LP result vs holding, per $1k of capital per day."""
    f = STUDY / "m1" / "league" / "league.parquet"
    if not f.exists():
        raise HTTPException(503, "LP League not built yet")
    df = _scope_table(str(f), f.stat().st_mtime)
    if pool:
        df = df.filter(pl.col("pools").str.contains(_pool(pool).key, literal=True))
    cols = ["rank", "manager", "positions", "pools", "capital_days_usd", "span_days", "vs_hodl_per_1k_day", "fees_per_1k_day",
            "picked_off_per_1k_day", "edge_hl", "fees_usd", "picked_off_hl_usd", "vs_hodl_usd", "median_width_ticks",
            "positions_per_day", "weekend_share", "jit_share", "nft_holders"]
    return {
        "method": "Managers = wallet sending the LP transactions. Score = LP result vs holding the deposited tokens (fees − impermanent loss, "
                  "incl. value picked off by informed flow) per $1k of capital per day. Qualifies with ≥ $1.5k·days and ≥ 3 days.",
        "count": df.height,
        "rows": rows(df.select([c for c in cols if c in df.columns]).head(min(max(limit, 1), 500))),
        "disclaimer": DISCLAIMER,
    }
