"""DeltaDesk API: the LP truth layer for tokenized stocks.

    uv run uvicorn api.app:app --port 8787

Endpoints (JSON):
  GET /health
  GET /fair-value/{pool}        HL-derived fair value vs pool mid, gap in bp, Chainlink freshness
  GET /safe-to-lp/{pool}        ALLOW / CAUTION / BLOCK with reasons (gap vs fair value, regime, historical toxicity)
  GET /pool-toxicity/{pool}     historical LP edge by regime / hour-of-week, current hour's record
  GET /study                    headline tables of the Truth Study
  GET /tearsheet/{chain}/{addr} LP P&L decomposition for a wallet (needs positions module output)
  GET /lp-league                LP wallets ranked by net edge (needs positions module output)
Pools: NVDA, SPY, TSLA, QQQ-SPY (or the full key, e.g. NVDA-USDG).
"""

from __future__ import annotations

import time
from datetime import datetime
from functools import lru_cache

import polars as pl
from fastapi import FastAPI, HTTPException

from api import live

app = FastAPI(title="DeltaDesk", version="0.1.0", description="The open market-making desk for tokenized stocks: LP truth layer API.")

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


@lru_cache(maxsize=8)
def _table(name: str, mtime: float) -> pl.DataFrame:
    return pl.read_parquet(STUDY / "m0" / f"{name}.parquet")


def table(name: str) -> pl.DataFrame:
    f = STUDY / "m0" / f"{name}.parquet"
    if not f.exists():
        raise HTTPException(503, f"study table {name} not built yet")
    return _table(name, f.stat().st_mtime)


def hour_record(pool_key: str, how: int) -> dict | None:
    df = table("by_how").filter((pl.col("pool") == pool_key) & (pl.col("how") == how))
    if df.is_empty():
        return None
    r = df.row(0, named=True)
    return {"swaps": r["swaps"], "fees_usd": r["fee_usd"], "picked_1h_usd": r["picked_1h"], "edge_1h": r["edge_1h"], "lp_net_bps_1h": r["lp_net_bps_1h"]}


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
    if hour and hour["edge_1h"] is not None:
        if hour["edge_1h"] < 0.5:
            worsen("BLOCK", f"this hour of the week LPs historically lost {1 / max(hour['edge_1h'], 1e-9):.1f}x their fees (edge {hour['edge_1h']:.2f})")
        elif hour["edge_1h"] < 1.0:
            worsen("CAUTION", f"this hour of the week LPs historically lost money (edge {hour['edge_1h']:.2f})")
    if chainlink_age_s is not None and regime.name == "REGULAR" and chainlink_age_s > 3600:
        worsen("CAUTION", f"Chainlink feed is {chainlink_age_s / 3600:.1f} h old during regular hours")
    if not reasons:
        reasons.append({"level": "ALLOW", "reason": "pool is near fair value and this hour has a positive LP record"})
    return {"verdict": verdict, "reasons": reasons}


@app.get("/health")
def health():
    return {"ok": True, "time": time.time()}


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


@app.get("/safe-to-lp/{pool}")
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


@app.get("/pool-toxicity/{pool}")
def pool_toxicity(pool: str):
    p = _pool(pool)
    reg = live.regime_at(time.time())
    cols = ["regime", "swaps", "vol_usd", "fee_usd", "picked_1h", "edge_1h", "lp_net_bps_1h"]
    by_regime = table("by_regime").filter(pl.col("pool") == p.key).select(cols)
    by_how = table("by_how").filter(pl.col("pool") == p.key).select("how", "fee_usd", "picked_1h", "edge_1h").sort("picked_1h", descending=True)
    return {
        "pool": p.key,
        "method": "self-markout vs pool mid 1h later (M0); HL-referenced version pending",
        "by_regime": by_regime.to_dicts(),
        "worst_hours_of_week": by_how.head(8).to_dicts(),
        "current_hour": {"how": reg.how, **(hour_record(p.key, reg.how) or {})},
        "disclaimer": DISCLAIMER,
    }


@app.get("/study")
def study():
    by_pool = table("by_pool").select("pool", "swaps", "vol_usd", "fee_usd", "picked_1h", "edge_1h", "lp_net_bps_1h")
    by_regime = table("by_regime").select("pool", "regime", "fee_usd", "picked_1h", "edge_1h", "lp_net_bps_1h")
    return {"title": "Can LPs beat LVR on tokenized stocks?", "by_pool": by_pool.to_dicts(), "by_regime": by_regime.to_dicts(), "disclaimer": DISCLAIMER}


@app.get("/tearsheet/{chain}/{wallet}")
def tearsheet(chain: str, wallet: str):
    if chain not in ("robinhood", "4663"):
        raise HTTPException(501, "only Robinhood Chain (4663) for now; Base/Aerodrome coming in M1.3")
    try:
        from positions.tearsheet import tearsheet as build  # built by the positions module
    except ImportError as e:
        raise HTTPException(503, "positions module not built yet") from e
    return {**build(wallet.lower()), "disclaimer": DISCLAIMER}


@app.get("/lp-league")
def lp_league(limit: int = 50):
    f = STUDY / "m1" / "positions" / "owners.parquet"
    if not f.exists():
        raise HTTPException(503, "LP League not built yet")
    df = pl.read_parquet(f)
    return {"rows": df.head(limit).to_dicts(), "disclaimer": DISCLAIMER}
