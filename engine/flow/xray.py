"""Flow X-ray CLI: who takes LP money?

    uv run python -m flow.xray

Steps
  1. swaps (M0) -> tx.from via tx_hash (raw/swap_txs). Taker = tx.from; its router set = swap `sender`s.
  2. per-swap context: HL lead signs (flow.hl), HL fair gap (hl_ref if present, else flow.hl), router class,
     gas percentile, swaps per tx, own-JIT flag (flow.jit); optional HL markouts (picked_hl_*).
  3. per taker and per taker x pool features (flow.features).
  4. deterministic labels (flow.labels) and HDBSCAN clusters for takers with >= 20 swaps (flow.cluster).
  5. outputs in data/study/m1/flow/: takers.parquet, taker_pools.parquet, clusters.parquet, by_label.parquet,
     by_label_pool.parquet, swap_flow.parquet, liquidity_windows.parquet, flow_summary.md.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone

import polars as pl

from flow import cluster as fcluster
from flow import features, hl, io, jit, labels
from flow.io import HORIZONS

PICKED_HL = [f"picked_hl_{h}" for h in HORIZONS]


@dataclass
class Result:
    swaps: pl.DataFrame            # enriched, joined swaps (only those with a taker)
    takers: pl.DataFrame
    taker_pools: pl.DataFrame
    clusters: pl.DataFrame
    by_label: pl.DataFrame
    by_label_pool: pl.DataFrame
    windows: pl.DataFrame
    routers: pl.DataFrame
    by_label_regime: pl.DataFrame
    meta: dict = field(default_factory=dict)


def coverage_stats(sw_all: pl.DataFrame, joined: pl.DataFrame, chunks) -> dict:
    covered = joined.filter(io.covered_block(pl.col("block"), chunks))
    n_cov = covered.height
    n_from = covered["taker"].is_not_null().sum()
    return {
        "swaps_total": sw_all.height,
        "swaps_in_backfilled_blocks": n_cov,
        "swaps_with_from": int(n_from),
        "join_coverage": (n_from / n_cov) if n_cov else None,
        "share_of_all_swaps_with_from": int(n_from) / sw_all.height if sw_all.height else None,
        "vol_share_with_from": float(joined.filter(pl.col("taker").is_not_null())["vol_usd"].sum() / sw_all["vol_usd"].sum()),
        "tx_chunks": [f"{lo}-{hi}" for lo, hi, _ in chunks],
        "last_backfilled_block": max(hi for _, hi, _ in chunks),
        "last_swap_block": int(sw_all["block"].max()),
        "last_attributed_utc": f"{datetime.fromtimestamp(float(joined.filter(pl.col('taker').is_not_null())['ts'].max()), timezone.utc):%Y-%m-%d %H:%M}",
    }


def summarize(df: pl.DataFrame, by: list[str], totals: dict[str, float], has_hl: bool) -> pl.DataFrame:
    """LVR attribution table: sums, shares of totals, edge = fees / picked (null when picked <= 0)."""
    hs = list(HORIZONS) + ([f"hl_{h}" for h in HORIZONS] if has_hl else [])
    exprs = [pl.len().alias("takers"), pl.col("swaps").sum(), pl.col("vol_usd").sum(), pl.col("fee_usd").sum()]
    for h in hs:
        exprs += [pl.col(f"picked_{h}").sum().alias(f"picked_{h}"), pl.col(f"picked_{h}").clip(lower_bound=0).sum().alias(f"picked_pos_{h}")]
    if has_hl:
        exprs += [pl.col(f"fee_on_picked_hl_{h}").sum().alias(f"fee_on_picked_hl_{h}") for h in HORIZONS]
    g = df.group_by(by).agg(exprs)
    out = [
        (pl.col("fee_usd") / totals["fee_usd"]).alias("fee_share"),
        (pl.col("vol_usd") / totals["vol_usd"]).alias("vol_share"),
        (pl.col("swaps") / totals["swaps"]).alias("swap_share"),
    ]
    for h in hs:
        fee = pl.col(f"fee_on_picked_{h}") if h.startswith("hl_") else pl.col("fee_usd")
        out += [
            (pl.col(f"picked_{h}") / totals[f"picked_{h}"] if totals[f"picked_{h}"] else pl.lit(None, pl.Float64)).alias(f"picked_share_{h}"),
            (pl.col(f"picked_pos_{h}") / totals[f"picked_pos_{h}"] if totals[f"picked_pos_{h}"] else pl.lit(None, pl.Float64)).alias(f"picked_pos_share_{h}"),
            pl.when(pl.col(f"picked_{h}") > 0).then(fee / pl.col(f"picked_{h}")).alias(f"edge_{h}"),
        ]
    return g.with_columns(out).sort(f"picked_{HORIZONS[-1]}", descending=True)


def totals_of(t: pl.DataFrame, has_hl: bool) -> dict[str, float]:
    hs = list(HORIZONS) + ([f"hl_{h}" for h in HORIZONS] if has_hl else [])
    d = {"fee_usd": t["fee_usd"].sum(), "vol_usd": t["vol_usd"].sum(), "swaps": t["swaps"].sum()}
    for h in hs:
        d[f"picked_{h}"] = t[f"picked_{h}"].sum()
        d[f"picked_pos_{h}"] = t[f"picked_{h}"].clip(lower_bound=0).sum()
    return d


def concentration(t: pl.DataFrame, sw: pl.DataFrame, pool: str | None, col: str) -> dict:
    """Top-3 / top-10 share of NET picked (M0 definition) and of positive picked, by taker, operator and router."""
    def shares(df: pl.DataFrame, key: str) -> dict:
        tot = df[col].sum()
        pos = df[col].clip(lower_bound=0).sum()
        s = df.sort(col, descending=True)
        return {
            "n": df.height,
            "top3_net": s[col].head(3).sum() / tot if tot else None,
            "top10_net": s[col].head(10).sum() / tot if tot else None,
            "top3_pos": s[col].head(3).sum() / pos if pos else None,
            "top10_pos": s[col].head(10).sum() / pos if pos else None,
            "top3_fee_share": s["fee_usd"].head(3).sum() / df["fee_usd"].sum(),
            "top3": s[key].head(3).to_list(),
        }
    h = col.replace("picked_", "")
    x = sw if pool is None else sw.filter(pl.col("pool") == pool)
    val = pl.col(f"picked_usd_{h}").filter(pl.col(f"valid_{h}")).sum().alias(col)
    by_taker = x.group_by("taker").agg(val, pl.col("fee_usd").sum())
    by_router = x.group_by("sender").agg(val, pl.col("fee_usd").sum())
    op = t.select("taker", "operator")
    by_op = x.join(op, on="taker", how="left").group_by("operator").agg(val, pl.col("fee_usd").sum())
    return {"taker": shares(by_taker, "taker"), "operator": shares(by_op, "operator"), "router": shares(by_router, "sender")}


STRICT_UNLABELED = (labels.UNLABELED, "informed-bot")


OP_FEATURES = ["swaps", "active_days", "swaps_per_day", "vol_usd", "fee_usd", "picked_1h", "picked_5m", "pos5m_share",
               "hl_lead", "hl_lead_z", "hl_lead_n", "hl_lead_src", "hl_toward", "hl_toward_z", "hl_gap_n"]


def operator_features(sw: pl.DataFrame, t: pl.DataFrame, hl_cols: list[str]) -> pl.DataFrame:
    """Operator-level features (`op_*`) aggregated over all swaps of the operator's wallets, plus op_wallets."""
    op_map = t.select("taker", "operator")
    f = features.aggregate(sw.select(pl.exclude("operator")).join(op_map, on="taker", how="left"), ["operator"], hl_cols)
    n = op_map.group_by("operator").agg(pl.len().alias("op_wallets"))
    return f.select("operator", *[pl.col(c).alias(f"op_{c}") for c in OP_FEATURES]).join(n, on="operator", how="left")


def label_regime(sw: pl.DataFrame, t: pl.DataFrame, has_hl: bool) -> pl.DataFrame:
    """Per pool x ET regime (plus a reopen-window row) x label: swaps, fees, picked (self; HL when joined), edge."""
    x = sw.join(t.select("taker", "label"), on="taker", how="left")
    hs = list(HORIZONS)
    exprs = [pl.len().alias("swaps"), pl.col("vol_usd").sum(), pl.col("fee_usd").sum()]
    exprs += [pl.col(f"picked_usd_{h}").filter(pl.col(f"valid_{h}")).sum().alias(f"picked_{h}") for h in hs]
    if has_hl:
        exprs += [pl.col(f"picked_hl_{h}").sum().alias(f"picked_hl_{h}") for h in hs]
        exprs += [pl.col("fee_usd").filter(pl.col(f"picked_hl_{h}").is_not_null()).sum().alias(f"fee_on_picked_hl_{h}") for h in hs]
    by_regime = x.group_by("pool", "regime", "label").agg(exprs)
    reopen = x.filter(pl.col("reopen_window")).group_by("pool", "label").agg(exprs).with_columns(pl.lit("REOPEN_WINDOW").alias("regime"))
    out = pl.concat([by_regime, reopen.select(by_regime.columns)])
    out = out.with_columns(
        *[pl.when(pl.col(f"picked_{h}") > 0).then(pl.col("fee_usd") / pl.col(f"picked_{h}")).alias(f"edge_{h}") for h in hs],
        *([pl.when(pl.col(f"picked_hl_{h}") > 0).then(pl.col(f"fee_on_picked_hl_{h}") / pl.col(f"picked_hl_{h}")).alias(f"edge_hl_{h}") for h in hs] if has_hl else []),
        (pl.col("fee_usd") / pl.col("fee_usd").sum().over("pool", "regime")).alias("fee_share_in_regime"),
        (pl.col("picked_1h").clip(lower_bound=0) / pl.col("picked_1h").clip(lower_bound=0).sum().over("pool", "regime")).alias("pos_picked_share_in_regime_1h"),
    )
    return out.sort(["pool", "regime", "picked_1h"], descending=[False, False, True])


def labeled_positive_share(t: pl.DataFrame, col: str, unlabeled: tuple[str, ...] = (labels.UNLABELED,)) -> float | None:
    """Share of positive picked-off value (sum over takers with col > 0) held by takers whose label is not in `unlabeled`."""
    pos = t.filter(pl.col(col) > 0)
    tot = pos[col].sum()
    return float(pos.filter(~pl.col("label").is_in(list(unlabeled)))[col].sum() / tot) if tot else None


def build(verbose: bool = True) -> Result:
    t0 = time.time()
    log = (lambda *a: print(f"[{time.time() - t0:6.1f}s]", *a)) if verbose else (lambda *a: None)

    sw_all = features.add_mid_before(io.load_swaps())
    chunks = io.tx_chunks()
    txs = io.load_txs()
    joined = features.join_takers(sw_all, txs)
    cov = coverage_stats(sw_all, joined, chunks)
    log(f"swaps {cov['swaps_total']:,}; in backfilled blocks {cov['swaps_in_backfilled_blocks']:,}; with from {cov['swaps_with_from']:,} "
        f"(join coverage {cov['join_coverage']:.4%}); last tx chunk ends at block {cov['last_backfilled_block']:,}")
    sw = joined.filter(pl.col("taker").is_not_null())
    del joined, txs

    sw = hl.add_hl_signs(sw)
    hm = io.load_hl_markouts()
    has_hl = hm is not None
    if has_hl:
        sw = sw.join(hm, on=io.HL_KEYS, how="left")
        log(f"joined HL markouts ({io.HL_MARKOUTS.name}): {sw['picked_hl_1h'].is_not_null().sum():,} swaps with valid picked_hl_1h")
    else:
        log("no HL markouts file; self markouts only")
    log("HL signs: " + ", ".join(f"{iv} {sw[f'hl_sign_{iv}'].is_not_null().mean():.1%}" for iv in hl.INTERVALS))

    ev = jit.decode_lp_events(io.load_lp_logs(), io.load_lp_txs())
    win = jit.liquidity_windows(ev, sw.select("pool", "block", "log_index", "ts", "taker"))
    own = jit.own_jit_swaps(win, sw.select("pool", "block", "log_index", "ts", "taker"))
    sw = sw.join(own.with_columns(pl.lit(True).alias("jit_own")), on=["pool", "block", "log_index"], how="left").with_columns(pl.col("jit_own").fill_null(False))
    lpf = jit.taker_lp_features(ev, win, sw.select("taker", "pool", "block", "log_index", "tx_hash"))
    log(f"LP events {ev.height:,}; add->remove windows <= {jit.SHORT_LIVED_S}s or same block: {win.height:,} "
        f"(same block {win['same_block'].sum()}, with a swap inside {(win['n_swaps'] > 0).sum()}); own-JIT swaps {own.height}")

    sw = features.enrich_swaps(sw)
    routers = features.router_stats(sw)
    hl_cols = PICKED_HL if has_hl else []
    t = features.aggregate(sw, ["taker"], hl_cols).join(lpf, on="taker", how="left")
    tp = features.aggregate(sw, ["taker", "pool"], hl_cols)
    log(f"takers {t.height:,} ({t.filter(pl.col('swaps') >= fcluster.MIN_SWAPS).height:,} with >= {fcluster.MIN_SWAPS} swaps); taker x pool rows {tp.height:,}")

    # operator: wallets whose main router is a PRIVATE contract are grouped under that contract (bot fleets)
    t = t.join(routers.select(pl.col("sender").alias("top_router"), pl.col("router_public").alias("top_router_public"), pl.col("router_takers").alias("top_router_takers")), on="top_router", how="left")
    t = t.with_columns(
        pl.when(~pl.col("top_router_public") & (pl.col("top_router_share") >= 0.5)).then(pl.lit("router:0x") + pl.col("top_router")).otherwise(pl.col("taker")).alias("operator")
    )
    t = t.join(operator_features(sw, t, hl_cols), on="operator", how="left")
    t = labels.label_takers(t)
    t = fcluster.cluster_takers(t)
    tp = tp.join(t.select("taker", "label", "cluster", "operator"), on="taker", how="left")
    log("labels: " + ", ".join(f"{r['label']} {r['len']:,}" for r in t.group_by("label").len().sort("len", descending=True).iter_rows(named=True)))

    tot = totals_of(t, has_hl)
    by_label = summarize(t, ["label"], tot, has_hl)
    by_cluster = summarize(t, ["cluster"], tot, has_hl)
    mix = t.group_by("cluster", "label").agg(pl.col("picked_1h").clip(lower_bound=0).sum().alias("_p"), pl.len().alias("_n"))
    dom = mix.sort(["cluster", "_n", "label"], descending=[False, True, False]).group_by("cluster", maintain_order=True).first().select("cluster", pl.col("label").alias("dominant_label"))
    dom_p = mix.sort(["cluster", "_p", "label"], descending=[False, True, False]).group_by("cluster", maintain_order=True).first().select("cluster", pl.col("label").alias("top_picked_label"))
    dom = dom.join(dom_p, on="cluster", how="left")
    label_mix = mix.group_by("cluster").agg(pl.struct(pl.col("label"), pl.col("_n").alias("takers")).sort_by("_n", descending=True).alias("label_mix"))
    med = t.group_by("cluster").agg(
        *[pl.col(c).median().alias(f"med_{c}") for c in ["swaps", "swaps_per_day", "size_med", "pos5m_share", "hl_lead", "hl_toward", "public_router_share", "how_entropy", "share_weekend", "picked_bps_1h"]]
    )
    clusters = by_cluster.join(dom, on="cluster", how="left").join(label_mix, on="cluster", how="left").join(med, on="cluster", how="left")
    by_label_pool = pl.concat([
        summarize(tp.filter(pl.col("pool") == p), ["label"], totals_of(tp.filter(pl.col("pool") == p), has_hl), has_hl).with_columns(pl.lit(p).alias("pool"))
        for p in tp["pool"].unique().sort()
    ], how="diagonal_relaxed")

    by_label_regime = label_regime(sw, t, has_hl)
    gap_check = None
    if has_hl and "hl_gap_bps" in sw.columns:  # cross-check flow.hl's fallback gap against hl_ref's (both fresh)
        g_own, g_ref = -pl.col("hl_gap_bps"), pl.col("hl_ref_gap_bps")
        both = sw.filter((pl.col("hl_gap_age_s") <= hl.GAP_MAX_AGE_S) & (pl.col("hl_ref_gap_age_s") <= hl.GAP_MAX_AGE_S) & g_own.is_not_null() & g_ref.is_not_null())
        sig = both.filter((g_own.abs() >= hl.GAP_MIN_BPS) & (g_ref.abs() >= hl.GAP_MIN_BPS))
        gap_check = {"n": both.height, "corr": both.select(pl.corr(g_own, g_ref)).item() if both.height > 2 else None,
                     "sign_agree_when_both_ge_min": sig.select((g_own.sign() == g_ref.sign()).mean()).item() if sig.height else None,
                     "median_abs_diff_bps": both.select((g_own - g_ref).abs().median()).item() if both.height else None}

    meta = {
        "coverage": cov,
        "has_hl_markouts": has_hl,
        "hl_gap_source": "markout/hl_ref gap_pre_bps" if has_hl else "flow.hl trailing-basis gap",
        "hl_sign_coverage": {iv: float(sw[f"hl_sign_{iv}"].is_not_null().mean()) for iv in hl.INTERVALS},
        "hl_gap_coverage": float(sw["hl_gap_has"].mean()),
        "hl_gap_crosscheck": gap_check,
        "lp_events": ev.height,
        "windows": win.height,
        "windows_same_block": int(win["same_block"].sum()),
        "windows_with_swap": int((win["n_swaps"] > 0).sum()),
        "windows_same_block_with_swap": int((win["same_block"] & (win["n_swaps"] > 0)).sum()),
        "own_jit_swaps": own.height,
        "short_lived_own_windows": int(((win["n_own_swaps"] > 0)).sum()),
        "lp_tx_swaps": int(t["lp_tx_swaps"].sum()),
        "takers_is_lp": int(t["is_lp"].sum()),
        "totals": tot,
        "concentration": {
            "NVDA/USDG": {h: concentration(t, sw, "NVDA/USDG", f"picked_{h}") for h in ("1h", "5m")},
            "all": {h: concentration(t, sw, None, f"picked_{h}") for h in ("1h", "5m")},
        },
        "thresholds": {**labels.thresholds(), "PUBLIC_MIN_TAKERS": features.PUBLIC_MIN_TAKERS, "PUBLIC_MAX_MED_SWAPS": features.PUBLIC_MAX_MED_SWAPS,
                       "HL_MIN_N": features.HL_MIN_N, "GAP_MIN_BPS": hl.GAP_MIN_BPS, "GAP_MAX_AGE_S": hl.GAP_MAX_AGE_S, "MIN_SWAPS_CLUSTER": fcluster.MIN_SWAPS,
                       "MIN_CLUSTER_SIZE": fcluster.MIN_CLUSTER_SIZE, "MIN_SAMPLES": fcluster.MIN_SAMPLES, "SHORT_LIVED_S": jit.SHORT_LIVED_S},
    }
    arb = t.filter(pl.col("label") == "HL-arb").with_columns(
        ((pl.col("op_hl_lead").fill_null(0) >= labels.HL_LEAD_MIN) & (pl.col("op_hl_lead_z").fill_null(0) >= labels.HL_Z_MIN)).alias("_lead"))
    meta["hl_arb_evidence"] = {
        k: {"wallets": d.height, "operators": d["operator"].n_unique(), "picked_1h": float(d["picked_1h"].sum()), "fee_usd": float(d["fee_usd"].sum())}
        for k, d in (("hl_lead", arb.filter(pl.col("_lead"))), ("hl_toward_only", arb.filter(~pl.col("_lead"))))
    }
    for c in ["picked_1h", "picked_5m", *(["picked_hl_1h", "picked_hl_5m"] if has_hl else [])]:
        meta["labeled_pos_share_" + c.removeprefix("picked_")] = labeled_positive_share(t, c)
        meta["labeled_pos_share_strict_" + c.removeprefix("picked_")] = labeled_positive_share(t, c, STRICT_UNLABELED)
    log(f"positive picked attributed to labeled groups: 1h {meta['labeled_pos_share_1h']:.1%}, 5m {meta['labeled_pos_share_5m']:.1%} "
        f"(strict, informed-bot counted as unlabeled: 1h {meta['labeled_pos_share_strict_1h']:.1%}, 5m {meta['labeled_pos_share_strict_5m']:.1%})")
    return Result(sw, t, tp, clusters, by_label, by_label_pool, win, routers, by_label_regime, meta)


def write(res: Result) -> None:
    from flow.report import render

    io.OUT.mkdir(parents=True, exist_ok=True)
    res.takers.sort("picked_1h", descending=True).write_parquet(io.OUT / "takers.parquet")
    res.taker_pools.sort(["pool", "picked_1h"], descending=[False, True]).write_parquet(io.OUT / "taker_pools.parquet")
    res.clusters.write_parquet(io.OUT / "clusters.parquet")
    res.by_label.write_parquet(io.OUT / "by_label.parquet")
    res.by_label_pool.write_parquet(io.OUT / "by_label_pool.parquet")
    res.windows.write_parquet(io.OUT / "liquidity_windows.parquet")
    res.routers.sort("router_swaps", descending=True).write_parquet(io.OUT / "routers.parquet")
    res.by_label_regime.write_parquet(io.OUT / "by_label_regime.parquet")
    (res.swaps.select("pool", "block", "tx_index", "log_index", "taker", "sender", "hl_sign_1m", "hl_sign_5m", "hl_sign_15m", "hl_fair_gap_bps", "hl_toward", "jit_own")
     .join(res.takers.select("taker", "label", "cluster", "operator"), on="taker", how="left")
     .sort(["pool", "block", "log_index"])
     .write_parquet(io.OUT / "swap_flow.parquet"))
    (io.OUT / "meta.json").write_text(json.dumps(res.meta, indent=2, default=str))
    (io.OUT / "flow_summary.md").write_text(render(res))


def main() -> None:
    res = build()
    write(res)
    pl.Config.set_tbl_rows(40)
    pl.Config.set_tbl_cols(16)
    pl.Config.set_tbl_width_chars(200)
    pl.Config.set_fmt_str_lengths(44)
    cols = ["label", "takers", "swaps", "vol_usd", "fee_usd", "picked_1h", "picked_share_1h", "picked_pos_share_1h", "fee_share", "edge_1h", "edge_5m"]
    if res.meta["has_hl_markouts"]:
        cols += ["picked_hl_1h", "edge_hl_1h", "edge_hl_5m"]
    print("\n=== by label ===")
    print(res.by_label.select(cols))
    print("\n=== by cluster ===")
    print(res.clusters.select(["cluster", "dominant_label", *cols[1:]]))
    print(f"\nwrote {io.OUT}")


if __name__ == "__main__":
    main()
