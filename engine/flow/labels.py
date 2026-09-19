"""Deterministic taker labels. Every label is a pure function of features (flow/features.py); rules are applied in
priority order and the first match wins. Thresholds live here and are echoed in flow_summary.md.

HL-arb and informed-bot are judged on the OPERATOR's features (`op_*` columns): wallets whose main router is a
private contract are grouped under that contract (bot fleets split one strategy over many EOAs, so per-wallet samples
are thin), and a wallet that is its own operator uses its own features. JIT-LP, retail and aggregator are
wallet-level. Without `op_*` columns every rule uses the wallet's own features.

  1. JIT-LP      the wallet's own swaps sit inside a same-block add -> remove liquidity window it opened
                 (jit_own_swaps >= JIT_MIN_OWN_SWAPS), or inside its own short-lived (<= 60 s) windows at least
                 JIT_MIN_SHORT_LIVED times.
  2. HL-arb      trades WITH Hyperliquid, profitably, often:
                   HL evidence   (hl_toward >= HL_TOWARD_MIN and hl_toward_z >= HL_Z_MIN)   [moves pool toward HL]
                              or (hl_lead >= HL_LEAD_MIN and hl_lead_z >= HL_Z_MIN)         [follows HL's last move]
                   positive      picked_1h > 0 and pos5m_share >= ARB_POS5M_MIN
                   frequent      swaps >= ARB_MIN_SWAPS and swaps_per_day >= ARB_MIN_SWAPS_PER_DAY
  3. informed-bot  automated flow that is robustly profitable at 5 minutes but did not pass the HL test:
                 pos5m_share >= INF_POS5M_MIN, picked_1h > 0, swaps >= INF_MIN_SWAPS, swaps_per_day >= INF_MIN_SWAPS_PER_DAY.
                 These are HL-arb *candidates*: their HL signal could not be measured finely enough (HL 5m candles start
                 Sep 1, 1m Sep 15) or they arbitrage against another reference. Reported separately from HL-arb.
  4. retail      small and infrequent and not informed:
                   size_med <= RETAIL_MAX_MED_USD and swaps_per_day <= RETAIL_MAX_SWAPS_PER_DAY
                   and swaps <= RETAIL_MAX_SWAPS
                   and picked ~<= 0: picked_bps_1h <= RETAIL_MAX_PICKED_BPS or picked_1h_t < RETAIL_MAX_T
  5. aggregator  most swaps go through PUBLIC routers (public_router_share >= AGG_MIN_PUBLIC_SHARE): wallets using
                 shared aggregator / wallet / trading-bot ("meme") routers that are not retail-sized and not informed.
  6. bot/other   everything else (private-router flow with no measurable edge, LP rebalancers, ...).
"""

from __future__ import annotations

import polars as pl

JIT_MIN_OWN_SWAPS = 1
JIT_MIN_SHORT_LIVED = 3

HL_TOWARD_MIN = 0.60
HL_LEAD_MIN = 0.55
HL_Z_MIN = 3.0
ARB_POS5M_MIN = 0.55
ARB_MIN_SWAPS = 100
ARB_MIN_SWAPS_PER_DAY = 10.0

RETAIL_MAX_MED_USD = 2_000.0
RETAIL_MAX_SWAPS_PER_DAY = 5.0
RETAIL_MAX_SWAPS = 200
RETAIL_MAX_PICKED_BPS = 10.0
RETAIL_MAX_T = 2.0

AGG_MIN_PUBLIC_SHARE = 0.5

INF_POS5M_MIN = 0.60
INF_MIN_SWAPS = 50
INF_MIN_SWAPS_PER_DAY = 5.0

LABELS = ["JIT-LP", "HL-arb", "informed-bot", "retail", "aggregator", "bot/other"]
UNLABELED = "bot/other"


def _f(c: str, default: float) -> pl.Expr:
    return pl.col(c).fill_null(default).fill_nan(default)


def rule_exprs(op: str = "") -> dict[str, pl.Expr]:
    """op = "op_" to judge HL-arb / informed-bot on operator-level columns, "" for wallet-level."""
    jit = (pl.col("jit_own_swaps") >= JIT_MIN_OWN_SWAPS) | (pl.col("short_lived_own_windows") >= JIT_MIN_SHORT_LIVED)
    hl_ev = ((_f(op + "hl_toward", 0.5) >= HL_TOWARD_MIN) & (_f(op + "hl_toward_z", 0.0) >= HL_Z_MIN)) | (
        (_f(op + "hl_lead", 0.5) >= HL_LEAD_MIN) & (_f(op + "hl_lead_z", 0.0) >= HL_Z_MIN)
    )
    positive = (pl.col(op + "picked_1h") > 0) & (_f(op + "pos5m_share", 0.0) >= ARB_POS5M_MIN)
    frequent = (pl.col(op + "swaps") >= ARB_MIN_SWAPS) & (pl.col(op + "swaps_per_day") >= ARB_MIN_SWAPS_PER_DAY)
    not_informed = (_f("picked_bps_1h", 0.0) <= RETAIL_MAX_PICKED_BPS) | (_f("picked_1h_t", 0.0) < RETAIL_MAX_T)
    retail = (
        (pl.col("size_med") <= RETAIL_MAX_MED_USD)
        & (pl.col("swaps_per_day") <= RETAIL_MAX_SWAPS_PER_DAY)
        & (pl.col("swaps") <= RETAIL_MAX_SWAPS)
        & not_informed
    )
    agg = _f("public_router_share", 0.0) >= AGG_MIN_PUBLIC_SHARE
    informed = (
        (_f(op + "pos5m_share", 0.0) >= INF_POS5M_MIN) & (pl.col(op + "picked_1h") > 0)
        & (pl.col(op + "swaps") >= INF_MIN_SWAPS) & (pl.col(op + "swaps_per_day") >= INF_MIN_SWAPS_PER_DAY)
    )
    return {"JIT-LP": jit, "HL-arb": hl_ev & positive & frequent, "informed-bot": informed, "retail": retail, "aggregator": agg}


def label_takers(t: pl.DataFrame) -> pl.DataFrame:
    """Add `label` (first matching rule in LABELS order) and one boolean column per rule (`is_<rule>`).
    Uses operator-level `op_*` columns for HL-arb / informed-bot when present."""
    rules = rule_exprs("op_" if "op_swaps" in t.columns else "")
    expr = pl.when(rules["JIT-LP"]).then(pl.lit("JIT-LP"))
    for name in LABELS[1:-1]:
        expr = expr.when(rules[name]).then(pl.lit(name))
    expr = expr.otherwise(pl.lit(UNLABELED))
    flags = [r.fill_null(False).alias("is_" + n.lower().replace("-", "_").replace("/", "_")) for n, r in rules.items()]
    return t.with_columns(*flags, expr.alias("label"))


def thresholds() -> dict[str, float]:
    return {k: v for k, v in globals().items() if k.isupper() and isinstance(v, (int, float)) and not isinstance(v, bool)}
