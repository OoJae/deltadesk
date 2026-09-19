"""LP tearsheet for one wallet (M1 · module C, step 5).

    uv run python -m positions.tearsheet 0xOWNER            # text report
    uv run python -m positions.tearsheet 0xOWNER --json     # the dict tearsheet() returns
    uv run python -m positions.tearsheet 0xOWNER --limit 50 # more position rows

A wallet's positions are those where the address is the position owner (NFT holder at the end / direct pool owner),
the operator (most frequent tx.from of the position's LP txs), or the NFT holder of any segment (accrual time).
Reads data/study/m1/positions/{positions,segments,attribution}.parquet (build with `uv run python -m positions.attribute`).

Per position and in total: fees, LVR (self-markout 1h and Hyperliquid-referenced 1h), IL vs HODL, price P&L, gas,
net, vs-HODL (= IL + fees − gas), residual vs onchain collected fees (v3 closed positions), each also per $1k of
time-weighted average notional and per active day; LP edge = fees / LVR (fees restricted to swaps whose markout is
valid, so the ratio is like-for-like); flags: JIT, weekend presence / share, in-range share, range width.
"""

from __future__ import annotations

import argparse
import json
import math
import re
from datetime import datetime, timezone

import numpy as np
import polars as pl

from positions.reconstruct import OUT

REGIME_ORDER = ["REGULAR", "EXTENDED", "OVERNIGHT", "WEEKEND_DARK", "HOLIDAY"]


def _clean(x):
    if isinstance(x, float) and (math.isnan(x) or math.isinf(x)):
        return None
    if isinstance(x, (np.floating,)):
        return _clean(float(x))
    if isinstance(x, (np.integer,)):
        return int(x)
    if isinstance(x, np.bool_):
        return bool(x)
    return x


def _ratio(a: float, b: float) -> float | None:
    return a / b if b and b > 0 else None


def _iso(ts) -> str | None:
    return None if ts is None else datetime.fromtimestamp(float(ts), timezone.utc).isoformat(timespec="seconds")


def width_class(width_ticks: int) -> str:
    if width_ticks >= 1_700_000:
        return "full-range"
    if width_ticks <= 50:
        return "tight (≤0.5%)"
    if width_ticks <= 500:
        return "narrow (≤5%)"
    if width_ticks <= 5000:
        return "medium (≤65%)"
    return "wide"


def union_seconds(a: np.ndarray, b: np.ndarray) -> float:
    """Total length of the union of intervals [a_i, b_i)."""
    if len(a) == 0:
        return 0.0
    o = np.argsort(a)
    a, b = a[o], b[o]
    tot, cur_a, cur_b = 0.0, a[0], b[0]
    for x, y in zip(a[1:], b[1:]):
        if x > cur_b:
            tot += cur_b - cur_a
            cur_a, cur_b = x, y
        else:
            cur_b = max(cur_b, y)
    return tot + (cur_b - cur_a)


def load(root=OUT) -> tuple[pl.DataFrame, pl.DataFrame, pl.DataFrame]:
    return (pl.read_parquet(root / "positions.parquet"), pl.read_parquet(root / "segments.parquet"),
            pl.read_parquet(root / "attribution.parquet"))


def tearsheet(owner: str, data: tuple[pl.DataFrame, pl.DataFrame, pl.DataFrame] | None = None, role: str = "auto") -> dict:
    """role: "owner" (positions whose NFT/pool position the address holds at the end), "operator" (positions the address
    manages, i.e. sends the LP transactions for; this is how the LP League groups wallets), or "auto" (owner if the address
    owns any position, else operator). One role per tearsheet, so the same position is never counted twice."""
    addr = owner.strip().lower()
    pos, seg, att = data if data is not None else load()
    by_owner = pos.filter(pl.col("owner") == addr)
    by_operator = pos.filter(pl.col("operator") == addr)
    if role == "auto":
        role = "owner" if by_owner.height else "operator"
    sel = by_owner if role == "owner" else by_operator
    out: dict = {"owner": addr, "role": role, "generated_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                 "match": {"as_owner": by_owner.height, "as_operator": by_operator.height}}
    if sel.is_empty():
        out.update({"summary": None, "by_regime": [], "by_pool": [], "positions": []})
        return out

    ids = sel["pos_id"].to_list()
    ss = seg.filter(pl.col("pos_id").is_in(ids)).join(sel.select("pos_id", "ts_end"), on="pos_id")
    a = ss["start_ts"].cast(pl.Float64).to_numpy()
    b = ss["end_ts"].cast(pl.Float64).fill_null(float("nan")).to_numpy()
    b = np.where(np.isnan(b), ss["ts_end"].to_numpy(), b)
    active_s = union_seconds(a, b)
    active_days = active_s / 86400.0
    notional = float(sel["notional_seconds"].sum()) / active_s if active_s > 0 else float(sel["avg_notional_usd"].sum())
    tot = {c: float(sel[c].fill_null(0.0).sum()) for c in ("deposits_usd", "withdrawals_usd", "end_value_usd", "fee_usd", "fee_usd_v1h",
                                                         "fee_usd_hlv1h", "picked_1h", "picked_hl_1h", "picked_5m", "il_usd", "price_pnl_usd",
                                                         "gas_usd", "net_usd", "vs_hodl_usd", "vol_usd")}
    aero = "aero_usd" in sel.columns  # Aerodrome (Base): fee_usd = fees the LP kept; AERO emissions are extra income
    # Only fully collected closed positions can be reconciled (NPM.burn requires tokensOwed == 0; or collected after close).
    rec = sel.filter(pl.col("residual_usd").is_not_null() & pl.col("closed") & (pl.col("nft_burned").fill_null(False) | pl.col("collected_after_close").fill_null(False)))
    per_k = 1000.0 / notional if notional > 0 else float("nan")
    per_day = per_k / active_days if active_days > 0 else float("nan")
    summary = {
        "n_positions": sel.height, "n_open": int((~sel["closed"]).sum()), "pools": sorted(sel["pool"].unique().to_list()),
        "first_utc": _iso(sel["ts_open"].min()), "last_utc": _iso(sel["ts_end"].max()),
        "active_days": active_days, "avg_notional_usd": notional,
        "deposits_usd": tot["deposits_usd"], "withdrawals_usd": tot["withdrawals_usd"], "end_value_usd": tot["end_value_usd"],
        "fees_usd": tot["fee_usd"], "lvr_self_1h_usd": tot["picked_1h"], "lvr_hl_1h_usd": tot["picked_hl_1h"],
        "edge_self_1h": _ratio(tot["fee_usd_v1h"], tot["picked_1h"]), "edge_hl_1h": _ratio(tot["fee_usd_hlv1h"], tot["picked_hl_1h"]),
        "il_usd": tot["il_usd"], "price_pnl_usd": tot["price_pnl_usd"], "gas_usd": tot["gas_usd"], "net_usd": tot["net_usd"],
        "vs_hodl_usd": tot["vs_hodl_usd"], "volume_traded_against_usd": tot["vol_usd"],
        "residual": {"reconciled_positions": rec.height, "residual_usd": float(rec["residual_usd"].sum()) if rec.height else None,
                     "fees_usd_reconciled": float(rec["fee_usd"].sum()) if rec.height else None,
                     "max_abs_residual_bp": float(rec["residual_bp"].abs().max()) if rec.height else None},
        "per_1k": {"fees": tot["fee_usd"] * per_k, "lvr_self_1h": tot["picked_1h"] * per_k, "lvr_hl_1h": tot["picked_hl_1h"] * per_k,
                   "il": tot["il_usd"] * per_k, "price_pnl": tot["price_pnl_usd"] * per_k, "gas": tot["gas_usd"] * per_k,
                   "net": tot["net_usd"] * per_k, "vs_hodl": tot["vs_hodl_usd"] * per_k},
        "per_1k_per_day": {"fees": tot["fee_usd"] * per_day, "lvr_self_1h": tot["picked_1h"] * per_day, "lvr_hl_1h": tot["picked_hl_1h"] * per_day,
                           "net": tot["net_usd"] * per_day, "vs_hodl": tot["vs_hodl_usd"] * per_day},
        "flags": {
            "jit_positions": int(sel["is_jit"].sum()), "jit_fee_share": _ratio(float(sel.filter(pl.col("is_jit"))["fee_usd"].sum()), tot["fee_usd"]),
            "weekend_share": _ratio(float((sel["notional_seconds"] * sel["weekend_share"]).sum()), float(sel["notional_seconds"].sum())),
            "weekend_presence": bool(sel["weekend_presence"].any()),
            "in_range_share": _ratio(float((sel["notional_seconds"] * sel["in_range_share"].fill_null(0.0)).sum()), float(sel["notional_seconds"].sum())),
            "median_width_ticks": float(sel["width_ticks"].median()), "median_width_bps": float(sel["width_bps"].median()),
            "rebalances_per_day": (sel.height - 1) / max(active_days, 1.0),
        },
    }
    by_regime = (att.filter(pl.col("pos_id").is_in(ids)).group_by("regime")
                 .agg(pl.col("fee_usd", "fee_usd_v1h", "fee_usd_hlv1h", "picked_1h", "picked_hl_1h", "vol_usd").sum()))
    regimes = []
    for r in sorted(by_regime.iter_rows(named=True), key=lambda r: REGIME_ORDER.index(r["regime"]) if r["regime"] in REGIME_ORDER else 99):
        regimes.append({"regime": r["regime"], "fees_usd": r["fee_usd"], "lvr_self_1h_usd": r["picked_1h"], "lvr_hl_1h_usd": r["picked_hl_1h"],
                        "edge_self_1h": _ratio(r["fee_usd_v1h"], r["picked_1h"]), "edge_hl_1h": _ratio(r["fee_usd_hlv1h"], r["picked_hl_1h"]),
                        "volume_usd": r["vol_usd"]})
    by_pool = []
    for r in (sel.group_by("pool").agg(pl.len().alias("n"), pl.col("fee_usd", "fee_usd_v1h", "fee_usd_hlv1h", "picked_1h", "picked_hl_1h", "il_usd",
                                                                    "price_pnl_usd", "gas_usd", "net_usd", "vs_hodl_usd").sum()).sort("pool").iter_rows(named=True)):
        by_pool.append({"pool": r["pool"], "n_positions": r["n"], "fees_usd": r["fee_usd"], "lvr_self_1h_usd": r["picked_1h"],
                        "lvr_hl_1h_usd": r["picked_hl_1h"], "edge_self_1h": _ratio(r["fee_usd_v1h"], r["picked_1h"]),
                        "edge_hl_1h": _ratio(r["fee_usd_hlv1h"], r["picked_hl_1h"]), "il_usd": r["il_usd"], "price_pnl_usd": r["price_pnl_usd"],
                        "gas_usd": r["gas_usd"], "net_usd": r["net_usd"], "vs_hodl_usd": r["vs_hodl_usd"]})
    rows = []
    for r in sel.sort("fee_usd", descending=True).iter_rows(named=True):
        rows.append({
            "pos_id": r["pos_id"], "pool": r["pool"], "kind": r["kind"], "token_id": r["token_id"], "owner": r["owner"], "operator": r["operator"],
            "status": "closed" if r["closed"] else "open", "opened_utc": _iso(r["ts_open"]), "closed_utc": _iso(r["ts_end"]) if r["closed"] else None,
            "lifetime_days": r["lifetime_days"], "active_days": r["active_seconds"] / 86400.0 if r["active_seconds"] is not None else None,
            "tick_lower": r["lower"], "tick_upper": r["upper"], "width_ticks": r["width_ticks"], "width_bps": r["width_bps"],
            "avg_notional_usd": r["avg_notional_usd"], "deposits_usd": r["deposits_usd"], "withdrawals_usd": r["withdrawals_usd"],
            "end_value_usd": r["end_value_usd"], "fees_usd": r["fee_usd"], "lvr_self_1h_usd": r["picked_1h"], "lvr_hl_1h_usd": r["picked_hl_1h"],
            "edge_self_1h": _ratio(r["fee_usd_v1h"], r["picked_1h"]), "edge_hl_1h": _ratio(r["fee_usd_hlv1h"], r["picked_hl_1h"]),
            "il_usd": r["il_usd"], "price_pnl_usd": r["price_pnl_usd"], "gas_usd": r["gas_usd"], "net_usd": r["net_usd"], "vs_hodl_usd": r["vs_hodl_usd"],
            "residual_usd": r["residual_usd"] if r["closed"] else None, "residual_bp": r["residual_bp"] if r["closed"] else None,
            "per_1k": {"fees": r["fees_per_1k"], "lvr_self_1h": r["lvr_self_1h_per_1k"], "net": r["net_per_1k"]},
            "per_1k_per_day": {"fees": r["fees_per_1k_per_day"], "lvr_self_1h": r["lvr_self_1h_per_1k_per_day"],
                               "lvr_hl_1h": r["lvr_hl_1h_per_1k_per_day"], "net": r["net_per_1k_per_day"], "vs_hodl": r["vs_hodl_per_1k_per_day"]},
            "flags": {"jit": r["is_jit"], "same_block": r["same_block"], "short_lived": r["short_lived"], "weekend_presence": r["weekend_presence"],
                      "weekend_share": r["weekend_share"], "in_range_share": r["in_range_share"], "range_width": width_class(r["width_ticks"]),
                      "nft_burned": r["nft_burned"], "nft_transfers": r["n_transfers"]},
        })
    if aero:
        ns = sel["notional_seconds"].fill_null(0.0)
        a_usd = float(sel["aero_usd"].fill_null(0.0).sum())
        summary["aerodrome"] = {
            "aero_earned": float(sel["aero_earned"].fill_null(0.0).sum()), "aero_forfeited": float(sel["aero_forfeited"].fill_null(0.0).sum()),
            "aero_usd": a_usd, "fees_gross_usd": float(sel["fee_usd_gross"].fill_null(0.0).sum()),
            "fees_to_voters_usd": float(sel["fees_to_voters_usd"].fill_null(0.0).sum()),
            "staked_share": _ratio(float((ns * sel["staked_share"].fill_null(0.0)).sum()), float(ns.sum())),
            "early_withdrawals": int(sel["n_early_withdrawals"].fill_null(0).sum()),
            "edge_hl_1h_incl_aero": _ratio(tot["fee_usd_hlv1h"] + a_usd, tot["picked_hl_1h"]),
        }
        summary["per_1k"]["aero"] = a_usd * per_k
        summary["per_1k_per_day"]["aero"] = a_usd * per_day
        by_id = {r["pos_id"]: r for r in sel.select("pos_id", "aero_earned", "aero_usd", "aero_forfeited", "staked_share", "fees_to_voters_usd").iter_rows(named=True)}
        for row in rows:
            x = by_id[row["pos_id"]]
            row.update({"aero_earned": x["aero_earned"], "aero_usd": x["aero_usd"], "aero_forfeited": x["aero_forfeited"],
                        "staked_share": x["staked_share"], "fees_to_voters_usd": x["fees_to_voters_usd"]})
    out.update({"summary": summary, "by_regime": regimes, "by_pool": by_pool, "positions": rows})
    return _deep_clean(out)


def _deep_clean(x):
    if isinstance(x, dict):
        return {k: _deep_clean(v) for k, v in x.items()}
    if isinstance(x, list):
        return [_deep_clean(v) for v in x]
    return _clean(x)


def short_id(pos_id: str) -> str:
    """NVDA/USDG:v3:0x4da212…bf18:221880:221940#1 → NVDA/USDG:v3:0x4da2…bf18:221880:221940#1"""
    return re.sub(r"0x([0-9a-f]{4})[0-9a-f]{32}([0-9a-f]{4})", r"0x\1…\2", pos_id)


def _f(x, nd=0, sign=False):
    if x is None:
        return "–"
    return f"{x:+,.{nd}f}" if sign else f"{x:,.{nd}f}"


def render(ts: dict, limit: int = 25) -> str:
    s = ts["summary"]
    if s is None:
        return f"no positions for {ts['owner']}"
    fl = s["flags"]
    L = [f"LP tearsheet · {ts['owner']}   ({s['n_positions']} positions, {s['n_open']} open; pools {', '.join(s['pools'])})",
         f"  role {ts['role']} · matched as owner {ts['match']['as_owner']}, as operator {ts['match']['as_operator']}",
         f"  active {s['active_days']:.1f} days ({s['first_utc']} → {s['last_utc']}), avg notional ${_f(s['avg_notional_usd'])}", "",
         f"  {'':<16}{'USD':>12}{'per $1k':>10}{'per $1k/day':>13}",
         ]
    rows = [("fees", s["fees_usd"], s["per_1k"]["fees"], s["per_1k_per_day"]["fees"]),
            ("LVR self 1h", -s["lvr_self_1h_usd"], -s["per_1k"]["lvr_self_1h"], -s["per_1k_per_day"]["lvr_self_1h"]),
            ("LVR HL 1h", -s["lvr_hl_1h_usd"], -s["per_1k"]["lvr_hl_1h"], -s["per_1k_per_day"]["lvr_hl_1h"]),
            ("IL vs HODL", s["il_usd"], s["per_1k"]["il"], None), ("price P&L", s["price_pnl_usd"], s["per_1k"]["price_pnl"], None),
            ("gas", -s["gas_usd"], -s["per_1k"]["gas"], None), ("vs HODL", s["vs_hodl_usd"], s["per_1k"]["vs_hodl"], s["per_1k_per_day"]["vs_hodl"]),
            ("NET", s["net_usd"], s["per_1k"]["net"], s["per_1k_per_day"]["net"])]
    for name, usd, k, kd in rows:
        L.append(f"  {name:<16}{_f(usd, 0, True):>12}{_f(k, 2, True):>10}{_f(kd, 3, True):>13}")
    res = s["residual"]
    L += ["", f"  LP edge (fees/LVR 1h): self {_f(s['edge_self_1h'], 2)} · HL {_f(s['edge_hl_1h'], 2)}   "
              f"residual vs onchain collects: {res['reconciled_positions']} closed v3 positions, ${_f(res['residual_usd'], 4, True)} "
              f"(max |{_f(res['max_abs_residual_bp'], 4)}| bp)",
          f"  flags: JIT {fl['jit_positions']} ({_f((fl['jit_fee_share'] or 0) * 100, 1)}% of fees) · weekend share {_f((fl['weekend_share'] or 0) * 100, 1)}% · "
          f"in range {_f((fl['in_range_share'] or 0) * 100, 1)}% · median width {_f(fl['median_width_ticks'])} ticks ({_f(fl['median_width_bps'])} bp) · "
          f"rebalances/day {_f(fl['rebalances_per_day'], 2)}", "", "  by regime:"]
    for r in ts["by_regime"]:
        L.append(f"    {r['regime']:<13} fees {_f(r['fees_usd']):>9}  LVR self {_f(r['lvr_self_1h_usd']):>9}  HL {_f(r['lvr_hl_1h_usd']):>9}  "
                 f"edge {_f(r['edge_self_1h'], 2):>5} / {_f(r['edge_hl_1h'], 2):<5}")
    L += ["", f"  positions (top {min(limit, len(ts['positions']))} by fees):",
          f"    {'position':<48}{'status':>7}{'days':>6}{'width':>7}{'notional':>11}{'fees':>9}{'LVR s':>9}{'LVR HL':>9}{'IL':>9}{'net':>9}{'net/1k/d':>9}{'resid bp':>9}  flags"]
    for p in ts["positions"][:limit]:
        flags = ",".join(f for f, on in [("JIT", p["flags"]["jit"]), ("wknd", p["flags"]["weekend_presence"])] if on)
        L.append(f"    {short_id(p['pos_id'])[:48]:<48}{p['status']:>7}{_f(p['lifetime_days'], 1):>6}{p['width_ticks']:>7}{_f(p['avg_notional_usd']):>11}"
                 f"{_f(p['fees_usd']):>9}{_f(p['lvr_self_1h_usd']):>9}{_f(p['lvr_hl_1h_usd']):>9}{_f(p['il_usd']):>9}{_f(p['net_usd']):>9}"
                 f"{_f(p['per_1k_per_day']['net'], 2):>9}{_f(p['residual_bp'], 3):>9}  {flags}")
    return "\n".join(L)


def main():
    ap = argparse.ArgumentParser(description="LP tearsheet for one wallet")
    ap.add_argument("owner")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--limit", type=int, default=25)
    ap.add_argument("--as", dest="role", choices=["auto", "owner", "operator"], default="auto")
    a = ap.parse_args()
    ts = tearsheet(a.owner, role=a.role)
    print(json.dumps(ts, indent=1) if a.json else render(ts, a.limit))


if __name__ == "__main__":
    main()
