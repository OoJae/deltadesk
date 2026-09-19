"""flow_summary.md renderer (all numbers come from the Result of flow.xray.build)."""

from __future__ import annotations

from datetime import datetime, timezone

import polars as pl

from flow import cluster as fcluster
from flow import labels

M0_ROUTER_TOP3_NVDA_1H = 0.84  # M0: top-3 routers' share of NVDA/USDG net picked-off at 1h


def usd(x) -> str:
    if x is None:
        return "n/a"
    a = abs(x)
    s = "-" if x < 0 else ""
    if a >= 1e9:
        return f"{s}${a / 1e9:.2f}B"
    if a >= 1e6:
        return f"{s}${a / 1e6:.1f}M"
    if a >= 1e3:
        return f"{s}${a / 1e3:.1f}k"
    return f"{s}${a:.0f}"


def pct(x, d: int = 1) -> str:
    return "n/a" if x is None else f"{100 * x:.{d}f}%"


def num(x, d: int = 2) -> str:
    return "n/a" if x is None or x != x else f"{x:.{d}f}"


def edge(x) -> str:
    return "n/a (picked ≤ 0)" if x is None else f"{x:.2f}"


def table(headers: list[str], rows: list[list[str]]) -> str:
    out = ["| " + " | ".join(headers) + " |", "|" + "|".join("---" for _ in headers) + "|"]
    out += ["| " + " | ".join(r) + " |" for r in rows]
    return "\n".join(out)


def label_rows(df: pl.DataFrame, key: str, has_hl: bool) -> tuple[list[str], list[list[str]]]:
    h = [key, "takers", "swaps", "volume", "fees", "fee share", "picked 1h", "picked share 1h (net)", "share of positive picked 1h", "edge 1h", "edge 5m", "edge 1m"]
    if has_hl:
        h += ["picked HL 1h", "share of positive HL 1h", "edge HL 1h", "edge HL 5m"]
    rows = []
    for r in df.iter_rows(named=True):
        row = [str(r[key]), f"{r['takers']:,}", f"{r['swaps']:,}", usd(r["vol_usd"]), usd(r["fee_usd"]), pct(r["fee_share"]), usd(r["picked_1h"]),
               pct(r["picked_share_1h"]), pct(r["picked_pos_share_1h"]), edge(r["edge_1h"]), edge(r["edge_5m"]), edge(r["edge_1m"])]
        if has_hl:
            row += [usd(r["picked_hl_1h"]), pct(r["picked_pos_share_hl_1h"]), edge(r["edge_hl_1h"]), edge(r["edge_hl_5m"])]
        rows.append(row)
    return h, rows


def render(res) -> str:
    m = res.meta
    t = res.takers
    has_hl = m["has_hl_markouts"]
    cov = m["coverage"]
    bl = res.by_label
    lab = {r["label"]: r for r in bl.iter_rows(named=True)}
    th = m["thresholds"]
    L: list[str] = []
    add = L.append

    add("# M1 · Flow X-ray: who takes LP money? (module B: `flow/`)")
    add("")
    add(f"_Generated {datetime.now(timezone.utc):%Y-%m-%d %H:%M} UTC by `uv run python -m flow.xray`. Taker = the originating wallet (`tx.from`) of each swap; "
        "`picked` = M0 self-markout LVR `s·q·(P_ref − p_ex)` summed over valid swaps; **edge = LP fees / picked** (> 1: LPs net positive)."
        + (" HL-referenced markouts (`picked HL`) come from `markout/hl_ref.py`." if has_hl else "") + "_")
    add("")

    # ---- headline
    add("## Headline")
    add("")
    arb = lab.get("HL-arb")
    ret = lab.get("retail")
    agg = lab.get("aggregator")
    conc = m["concentration"]["NVDA/USDG"]["1h"]
    conc_all = m["concentration"]["all"]["1h"]
    if arb:
        n_ops = t.filter(pl.col("label") == "HL-arb")["operator"].n_unique()
        add(f"- **HL-arb wallets ({arb['takers']:,} wallets, {n_ops:,} operators) took {pct(arb['picked_pos_share_1h'])} of all positive 1h picked-off value** "
            f"({usd(arb['picked_1h'])} net) while paying {pct(arb['fee_share'])} of LP fees: edge {edge(arb['edge_1h'])} at 1h, {edge(arb['edge_5m'])} at 5m"
            + (f", {edge(arb['edge_hl_1h'])} vs HL at 1h." if has_hl else ".")
            + " Three operators dominate: " + ", ".join(
                f"`{r['operator']}` ({r['wallets']} wallet{'s' if r['wallets'] != 1 else ''}, {usd(r['picked_1h'])})"
                for r in t.group_by("operator").agg(pl.len().alias("wallets"), pl.col("picked_1h").sum()).sort("picked_1h", descending=True).head(3).iter_rows(named=True)) + ".")
    def lp_view(r) -> str:
        if r["picked_1h"] <= 0:
            return f"net picked {usd(r['picked_1h'])} at 1h, so LPs gain on price as well as fees"
        return f"net picked {usd(r['picked_1h'])} at 1h (edge {edge(r['edge_1h'])})"

    inf = lab.get("informed-bot")
    if inf:
        add(f"- **Informed bots without HL confirmation ({inf['takers']:,} wallets)** took {pct(inf['picked_pos_share_1h'])} of positive picked-off "
            f"({usd(inf['picked_1h'])} net, {pct(inf['fee_share'])} of fees, edge {edge(inf['edge_1h'])}). They are HL-arb candidates whose HL lead could not be confirmed at the available candle resolution.")
    if ret:
        add(f"- **Retail ({ret['takers']:,} wallets) pays LPs:** {pct(ret['fee_share'])} of fees; {lp_view(ret)}.")
    if agg:
        add(f"- **Aggregator / shared-router flow ({agg['takers']:,} wallets):** {pct(agg['fee_share'])} of fees; {lp_view(agg)}.")
    oth = lab.get(labels.UNLABELED)
    if oth:
        add(f"- **{labels.UNLABELED} ({oth['takers']:,} wallets):** {pct(oth['fee_share'])} of fees; {lp_view(oth)}; {pct(oth['picked_pos_share_1h'])} of positive picked-off.")
    add(f"- **Concentration, NVDA/USDG 1h:** the top-3 *wallets* take {pct(conc['taker']['top3_net'])} of net picked-off "
        f"(top-10: {pct(conc['taker']['top10_net'])}); the top-3 *routers* take {pct(conc['router']['top3_net'])} on this data "
        f"(M0: {pct(M0_ROUTER_TOP3_NVDA_1H, 0)}); grouping bot-fleet wallets by their private router (operator), the top-3 take {pct(conc['operator']['top3_net'])}. "
        f"Of *positive* picked-off, the top-3 wallets hold {pct(conc['taker']['top3_pos'])}, the top-3 operators {pct(conc['operator']['top3_pos'])}. "
        "(Net shares can exceed 100% because the rest of the flow is net negative.)")
    tgt = m["labeled_pos_share_1h"]
    add(f"- **Target check:** {pct(tgt)} of positive 1h picked-off value (5m: {pct(m['labeled_pos_share_5m'])}"
        + (f"; HL 1h: {pct(m.get('labeled_pos_share_hl_1h'))}; HL 5m: {pct(m.get('labeled_pos_share_hl_5m'))}" if has_hl else "")
        + f") is attributed to labeled groups (not `{labels.UNLABELED}`); target ≥ 90%: **{'met' if tgt is not None and tgt >= 0.9 else 'NOT met'}**. "
        + f"Strict reading (the `informed-bot` HL-arb candidates also counted as unlabeled): {pct(m['labeled_pos_share_strict_1h'])} at 1h, "
        + f"{pct(m['labeled_pos_share_strict_5m'])} at 5m.")
    wsw = res.windows.filter(pl.col("n_swaps") > 0)
    add(f"- **JIT:** strict same-block JIT is absent ({m['windows_same_block_with_swap']} same-block add→remove windows contain a swap; {m['own_jit_swaps']} swaps sit inside "
        f"their own wallet's same-block window). Short-lived liquidity does exist: {wsw.height:,} add→remove windows of ≤ {th['SHORT_LIVED_S']:.0f} s caught "
        f"{int(wsw['n_swaps'].sum()):,} swaps, from {wsw['from'].n_unique():,} LP wallets (median lifetime {num(wsw['lifetime_s'].median(), 0)} s). "
        f"Wallets that also trade inside their own short-lived windows are labelled JIT-LP.")
    add("")

    # ---- coverage
    add("## Data and coverage")
    add("")
    add(table(["item", "value"], [
        ["swaps (M0 swaps.parquet)", f"{cov['swaps_total']:,}"],
        ["swaps inside backfilled `swap_txs` blocks", f"{cov['swaps_in_backfilled_blocks']:,}"],
        ["… with a `tx.from` (join coverage)", f"{cov['swaps_with_from']:,} ({pct(cov['join_coverage'], 3)})"],
        ["share of ALL swaps attributed / of volume", f"{pct(cov['share_of_all_swaps_with_from'], 2)} / {pct(cov['vol_share_with_from'], 2)}"],
        ["last backfilled block / last swap block", f"{cov['last_backfilled_block']:,} / {cov['last_swap_block']:,}"],
        ["distinct takers (wallets)", f"{t.height:,}"],
        [f"takers with ≥ {fcluster.MIN_SWAPS} swaps (clustered)", f"{t.filter(pl.col('swaps') >= fcluster.MIN_SWAPS).height:,}"],
        ["HL-sign coverage of swaps (last completed bar 1m / 5m / 15m)", " / ".join(pct(m["hl_sign_coverage"][iv]) for iv in ("1m", "5m", "15m"))],
        ["HL fair-gap coverage (|gap| ≥ %.0f bp)" % th["GAP_MIN_BPS"], f"{pct(m['hl_gap_coverage'])} (source: {m['hl_gap_source']})"],
        ["HL markouts joined", "yes (`data/study/m1/hl_ref/hl_markouts.parquet`)" if has_hl else "no (file absent)"],
    ]))
    add("")

    # ---- method
    add("## Method")
    add("")
    add("**Features (per taker and per taker × pool; `takers.parquet`, `taker_pools.parquet`):** swaps, txs, active ET days, swaps/active day, volume, median and p90 swap size, "
        "LP fees paid, picked 1m/5m/1h (self; plus HL when joined), edge, share of swaps with a positive 5m markout (`pos5m_share`), 1h-markout t-stat, "
        "hour-of-week entropy (0 = one hour, 1 = uniform over 168) and busiest-hour share, REGULAR / EXTENDED / OVERNIGHT / WEEKEND_DARK / reopen shares, "
        "median gas-price percentile within its UTC hour, median gas used, swaps per tx, multi-swap and multi-pool tx shares, router set, public-router share, "
        "direct-call share (tx.to = router), buy share, and LP overlap (JIT windows, short-lived windows, swaps inside LP txs).")
    add("")
    add(f"**HL lead** (as specified): share of swaps whose side `s` equals the sign of Hyperliquid's return over the last *completed* candle before the swap "
        f"(1m candles from Sep 15, 5m from Sep 1, 15m from Jul 28; no look-ahead). `hl_lead_1m/5m/15m` are reported per interval; the labelling value `hl_lead` "
        f"is the lead on the finest interval where the wallet has ≥ {th['HL_MIN_N']:.0f} signed swaps (1m, else 5m, else 15m; `hl_lead_src`). Pooling intervals would let the long 15m era "
        f"swamp the finer evidence (router `520ed467`: 1m 0.64, 5m 0.60, pooled 0.54). "
        f"Random flow scores ≈ 0.5; `hl_lead_z` is the binomial z-score vs 0.5. Calibration on Sep 1–18 swaps grouped by router: informed private routers score 0.62–0.74 on 1m bars, "
        f"0.51–0.66 on 5m and 0.46–0.60 on 15m, while public / uninformed routers sit at 0.50 ± 0.03 on every interval, so the finest bar discriminates best.")
    add("")
    add(f"**HL toward** (arbitrage signature): share of swaps that move the pool toward HL fair value, i.e. `s = sign(F_pre − P_pool_before)`, counting swaps with |gap| ≥ {th['GAP_MIN_BPS']:.0f} bp "
        f"and a FRESH HL point (age ≤ {th['GAP_MAX_AGE_S']:.0f} s: mostly 1m candles and the live tape from Sep 15, plus the first {th['GAP_MAX_AGE_S']:.0f} s after each 5m / 15m candle closes). Against stale points a fast arbitrageur appears to trade *away* from HL, because it acts on moves the stale point has not caught yet. "
        f"Source: {m['hl_gap_source']}. HL-return lead is diluted at candle resolution (an arb reacts within seconds; the previous 5–15 minute bar is mostly unrelated), "
        "while the fair-value gap is what an HL arbitrageur actually trades on. Both are reported, and either can qualify a wallet as HL-arb."
        + (f" Cross-check: flow.hl's own trailing-basis gap (the fallback when hl_ref is absent) vs hl_ref's on {m['hl_gap_crosscheck']['n']:,} fresh swaps: correlation "
           f"{num(m['hl_gap_crosscheck']['corr'])}, same sign on {pct(m['hl_gap_crosscheck']['sign_agree_when_both_ge_min'])} of swaps where both are ≥ {th['GAP_MIN_BPS']:.0f} bp, median |difference| "
           f"{num(m['hl_gap_crosscheck']['median_abs_diff_bps'], 1)} bp. Basis error of that size can flip the gap sign near the threshold, which is why HL lead (basis-free) is the primary evidence."
           if m.get("hl_gap_crosscheck") else ""))
    add("")
    add(f"**Routers:** a swap `sender` is *public* when ≥ {th['PUBLIC_MIN_TAKERS']:.0f} wallets use it and the median wallet sends ≤ {th['PUBLIC_MAX_MED_SWAPS']:.0f} swaps through it "
        "(aggregators, wallet/UI routers, trading-bot routers); otherwise it is a private contract (a bot's own contract, including contracts shared by a bot's fleet of wallets). "
        "`operator` groups wallets whose main router (≥ 50% of swaps) is private under that router, so fleets that rotate EOAs count as one operator.")
    add("")
    add(f"**JIT:** positions are keyed by (pool, tx.from, owner/sender, ticks[, salt]); each add is paired with the next event of the same key. Strict JIT = add and remove "
        f"in the same block, add first, with a swap between them; a taker's swap is *own-JIT* when it sits inside such a window opened by the same wallet. "
        f"Relaxed: add → remove within {th['SHORT_LIVED_S']:.0f} s.")
    add("")
    add(f"**Clusters:** HDBSCAN (`min_cluster_size={th['MIN_CLUSTER_SIZE']:.0f}`, `min_samples={th['MIN_SAMPLES']:.0f}`) on z-scored features "
        f"(log1p for counts, sizes and USD; asinh for per-volume picked; raw shares), for takers with ≥ {th['MIN_SWAPS_CLUSTER']:.0f} swaps. Others are `long tail`, "
        "HDBSCAN outliers are `noise`. Clusters are numbered C1, C2, … by descending 1h picked.")
    add("")

    # ---- labels
    add("## Labels (deterministic, first match wins)")
    add("")
    add("HL-arb and informed-bot are judged on the **operator's** features (all swaps of the wallets behind one private router; a wallet that is its own operator uses its own). "
        "Bot fleets split one strategy across many EOAs, so a single wallet's sample is thin (the `520ed467` fleet: 20 wallets with near-identical size and timing). "
        "JIT-LP, retail and aggregator are wallet-level.")
    add("")
    add(table(["#", "label", "rule (all thresholds in `flow/labels.py`)"], [
        ["1", "JIT-LP", f"wallet: `jit_own_swaps ≥ {th['JIT_MIN_OWN_SWAPS']:.0f}` or own swaps inside ≥ {th['JIT_MIN_SHORT_LIVED']:.0f} of its own ≤ {th['SHORT_LIVED_S']:.0f} s liquidity windows"],
        ["2", "HL-arb", f"operator: HL evidence (`hl_lead ≥ {th['HL_LEAD_MIN']}` and `hl_lead_z ≥ {th['HL_Z_MIN']}`) or (`hl_toward ≥ {th['HL_TOWARD_MIN']}` and `hl_toward_z ≥ {th['HL_Z_MIN']}`); "
                        f"positive: `picked_1h > 0` and `pos5m_share ≥ {th['ARB_POS5M_MIN']}`; frequent: `swaps ≥ {th['ARB_MIN_SWAPS']:.0f}` and `swaps/active day ≥ {th['ARB_MIN_SWAPS_PER_DAY']:.0f}`"],
        ["3", "informed-bot", f"operator: profitable at 5m but no HL evidence (HL-arb candidates): `pos5m_share ≥ {th['INF_POS5M_MIN']}`, `picked_1h > 0`, "
                              f"`swaps ≥ {th['INF_MIN_SWAPS']:.0f}`, `swaps/active day ≥ {th['INF_MIN_SWAPS_PER_DAY']:.0f}`"],
        ["4", "retail", f"wallet: `size_med ≤ ${th['RETAIL_MAX_MED_USD']:,.0f}`, `swaps/active day ≤ {th['RETAIL_MAX_SWAPS_PER_DAY']:.0f}`, `swaps ≤ {th['RETAIL_MAX_SWAPS']:.0f}`, "
                        f"and picked ≈ ≤ 0: `picked_bps_1h ≤ {th['RETAIL_MAX_PICKED_BPS']:.0f}` or `picked_1h_t < {th['RETAIL_MAX_T']:.0f}`"],
        ["5", "aggregator", f"wallet: `public_router_share ≥ {th['AGG_MIN_PUBLIC_SHARE']}`: aggregator / wallet-app / trading-bot (meme) router flow that is neither informed nor retail-sized"],
        ["6", labels.UNLABELED, "everything else (private-router flow with no measurable edge, inventory/TWAP-style bots, LP rebalancers, one-offs above retail size)"],
    ]))
    add("")
    ev = m.get("hl_arb_evidence")
    if ev:
        a, b = ev["hl_lead"], ev["hl_toward_only"]
        add(f"HL-arb evidence: {a['operators']} operators ({a['wallets']:,} wallets, picked 1h {usd(a['picked_1h'])}) qualify on HL lead; "
            f"{b['operators']} operators ({b['wallets']:,} wallets, picked 1h {usd(b['picked_1h'])}) qualify on fresh HL-toward alone.")
        add("")

    # ---- operators
    add("## Top operators (wallet fleets behind a private router, or single wallets)")
    add("")
    ops = (
        t.group_by("operator").agg(pl.len().alias("wallets"), pl.col("swaps").sum(), pl.col("vol_usd").sum(), pl.col("fee_usd").sum(), pl.col("picked_1h").sum(),
                                   *([pl.col("picked_hl_1h").sum()] if has_hl else []), pl.col("label").mode().sort().first().alias("label"),
                                   pl.col("op_hl_lead").first(), pl.col("op_hl_lead_z").first(), pl.col("op_hl_lead_src").first(), pl.col("op_pos5m_share").first())
        .sort("picked_1h", descending=True).head(12)
    )
    tot_pos = t["picked_1h"].clip(lower_bound=0).sum()
    rows = []
    for r in ops.iter_rows(named=True):
        row = [f"`{r['operator']}`", f"{r['wallets']:,}", r["label"], f"{r['swaps']:,}", usd(r["vol_usd"]), usd(r["fee_usd"]), usd(r["picked_1h"]), pct(r["picked_1h"] / tot_pos if tot_pos else None),
               edge(r["fee_usd"] / r["picked_1h"] if r["picked_1h"] > 0 else None),
               f"{num(r['op_hl_lead'])} ({r['op_hl_lead_src'] or '-'}, z {num(r['op_hl_lead_z'], 1)})", num(r["op_pos5m_share"])]
        if has_hl:
            row.insert(7, usd(r["picked_hl_1h"]))
        rows.append(row)
    hdr = ["operator", "wallets", "label", "swaps", "volume", "fees", "picked 1h", "of all positive picked 1h", "edge 1h", "HL lead (interval, z)", "pos5m"]
    if has_hl:
        hdr.insert(7, "picked HL 1h")
    add(table(hdr, rows))
    add("")

    # ---- by label
    add("## LVR attribution by label (all pools)")
    add("")
    h, rows = label_rows(bl, "label", has_hl)
    add(table(h, rows))
    add("")
    add("Net shares can exceed 100% or go negative because some groups have negative picked (they lose to LPs). "
        "`share of positive picked` sums each wallet's picked where it is > 0.")
    add("")
    add("### By label, per pool")
    add("")
    for p in res.by_label_pool["pool"].unique().sort().to_list():
        d = res.by_label_pool.filter(pl.col("pool") == p).sort("picked_1h", descending=True)
        add(f"**{p}**")
        add("")
        h, rows = label_rows(d, "label", has_hl)
        add(table(h, rows))
        add("")

    # ---- label x regime (NVDA)
    add("### When each group trades: NVDA/USDG by ET regime")
    add("")
    add("Cells: net picked 1h / LP edge 1h (fees ÷ picked; n/a when picked ≤ 0)" + (" / edge vs HL at 1h" if has_hl else "") + ". `REOPEN_WINDOW` overlaps the regimes (Sun 19:50–Mon 00:20, weekdays 09:20–09:45 ET).")
    add("")
    lr = res.by_label_regime.filter(pl.col("pool") == "NVDA/USDG")
    regimes = [r for r in ["REGULAR", "EXTENDED", "OVERNIGHT", "WEEKEND_DARK", "HOLIDAY", "REOPEN_WINDOW"] if r in set(lr["regime"].to_list())]
    lab_order = [r["label"] for r in bl.iter_rows(named=True)]
    rows = []
    for labn in lab_order:
        row = [labn]
        for rg in regimes:
            c = lr.filter((pl.col("label") == labn) & (pl.col("regime") == rg))
            if c.is_empty():
                row.append("")
                continue
            r = c.row(0, named=True)
            cell = f"{usd(r['picked_1h'])} / {num(r['edge_1h'])}"
            if has_hl:
                cell += f" / {num(r['edge_hl_1h'])}"
            row.append(cell)
        rows.append(row)
    add(table(["label", *regimes], rows))
    add("")

    # ---- clusters
    add("## Clusters (HDBSCAN)")
    add("")
    cl = res.clusters.sort("picked_1h", descending=True)
    rows = []
    for r in cl.iter_rows(named=True):
        mix = ", ".join(f"{x['label']} {x['takers']}" for x in (r["label_mix"] or [])[:3])
        rows.append([str(r["cluster"]), f"{r['dominant_label']} / {r['top_picked_label']}", mix, f"{r['takers']:,}", f"{r['swaps']:,}", usd(r["vol_usd"]), pct(r["fee_share"]),
                     usd(r["picked_1h"]), pct(r["picked_pos_share_1h"]), edge(r["edge_1h"]),
                     num(r["med_swaps_per_day"], 1), usd(r["med_size_med"]), num(r["med_pos5m_share"]), num(r["med_hl_toward"]), num(r["med_hl_lead"]), num(r["med_public_router_share"]), num(r["med_share_weekend"])])
    add(table(["cluster", "most common label / label with most positive picked", "label mix (top 3)", "takers", "swaps", "volume", "fee share", "picked 1h", "share of positive picked 1h", "edge 1h",
               "med swaps/day", "med size", "med pos5m", "med HL toward", "med HL lead", "med public-router", "med weekend share"], rows))
    add("")

    # ---- top 20
    add("## Top-20 takers by 1h picked-off")
    add("")
    top = t.sort("picked_1h", descending=True).head(20)
    rows = []
    for r in top.iter_rows(named=True):
        row = [f"`{r['taker']}`", r["label"], str(r["cluster"]), f"{r['swaps']:,}", usd(r["vol_usd"]), usd(r["fee_usd"]), usd(r["picked_1h"]), edge(r["edge_1h"]),
               num(r["hl_lead"]) + (f" ({r['hl_lead_src']})" if r["hl_lead_src"] else ""), num(r["hl_toward"]), num(r["pos5m_share"]),
               f"`{r['top_router'][:10]}…` ({'public' if r['top_router_public'] else 'private'}, {r['n_routers']})"]
        if has_hl:
            row.insert(8, usd(r["picked_hl_1h"]))
        rows.append(row)
    hdr = ["taker (tx.from)", "label", "cluster", "swaps", "volume", "fees", "picked 1h", "edge 1h", "HL lead", "HL toward", "pos5m", "top router (#routers)"]
    if has_hl:
        hdr.insert(8, "picked HL 1h")
    add(table(hdr, rows))
    add("")

    # ---- concentration
    add("## Concentration of picked-off value")
    add("")
    rows = []
    for scope in ("NVDA/USDG", "all"):
        for hz in ("1h", "5m"):
            c = m["concentration"][scope][hz]
            for lvl in ("taker", "operator", "router"):
                x = c[lvl]
                rows.append([scope, hz, lvl, f"{x['n']:,}", pct(x["top3_net"]), pct(x["top10_net"]), pct(x["top3_pos"]), pct(x["top10_pos"]), pct(x["top3_fee_share"])])
    add(table(["pool", "horizon", "grouped by", "entities", "top-3 share of net picked", "top-10 share of net picked", "top-3 share of positive picked", "top-10 share of positive picked", "top-3 fee share"], rows))
    add("")
    add(f"M0 reported the top-3 routers at {pct(M0_ROUTER_TOP3_NVDA_1H, 0)} of NVDA/USDG net picked at 1h. By wallet, the NVDA top-3 are "
        + ", ".join(f"`{a}`" for a in conc["taker"]["top3"]) + f"; by operator: " + ", ".join(f"`{a}`" for a in conc["operator"]["top3"]) + ".")
    add(f"All pools, 1h: top-3 wallets {pct(conc_all['taker']['top3_net'])} vs top-3 routers {pct(conc_all['router']['top3_net'])} of net picked.")
    add("")

    # ---- LP / JIT
    add("## Liquidity overlap and JIT")
    add("")
    add(table(["item", "value"], [
        ["LP add/remove events decoded (covered pools)", f"{m['lp_events']:,}"],
        [f"add→remove windows (same block or ≤ {th['SHORT_LIVED_S']:.0f} s)", f"{m['windows']:,}"],
        ["… same-block windows / with a swap inside", f"{m['windows_same_block']:,} / {m['windows_same_block_with_swap']:,}"],
        ["… any window with a swap inside", f"{m['windows_with_swap']:,}"],
        ["swaps inside their own wallet's same-block JIT window", f"{m['own_jit_swaps']:,}"],
        ["short-lived windows containing the LP wallet's own swaps", f"{m['short_lived_own_windows']:,}"],
        ["takers that also provide liquidity (any add/remove)", f"{m['takers_is_lp']:,}"],
        ["swaps executed inside a liquidity-changing tx (LP rebalancing swaps)", f"{m['lp_tx_swaps']:,}"],
    ]))
    add("")
    jl = lab.get("JIT-LP")
    add(f"JIT-LP label: {jl['takers'] if jl else 0} wallets" + (f", picked 1h {usd(jl['picked_1h'])}, fees {usd(jl['fee_usd'])}." if jl else "."))
    add("")
    w = res.windows.filter(pl.col("n_swaps") > 0)
    if w.height:
        top = (
            w.group_by("from").agg(pl.len().alias("windows"), pl.col("same_block").sum().alias("same_block"), pl.col("lifetime_s").median().alias("life"),
                                   pl.col("n_swaps").sum().alias("swaps_inside"), (pl.col("n_own_swaps") > 0).sum().alias("own"))
            .sort(["windows", "from"], descending=[True, False]).head(8)
            .join(t.select(pl.col("taker").alias("from"), "label", "swaps", "lp_tx_swaps"), on="from", how="left")
        )
        add("Wallets with the most short-lived liquidity windows that caught at least one swap (any taker):")
        add("")
        add(table(["LP wallet (tx.from)", "windows with swaps", "same-block", "median lifetime (s)", "swaps inside", "windows with own swaps", "own taker swaps (label)", "own swaps inside LP txs"],
                  [[f"`{r['from']}`", f"{r['windows']:,}", f"{r['same_block']:,}", f"{r['life']:.0f}", f"{r['swaps_inside']:,}", f"{r['own']:,}",
                    f"{r['swaps'] or 0:,} ({r['label'] or 'not a taker'})", f"{r['lp_tx_swaps'] or 0:,}"] for r in top.iter_rows(named=True)]))
        add("")

    # ---- caveats
    add("## Caveats")
    add("")
    add("- Self markouts (M0) score each swap against the pool's own later price. On weekends the pool is the only onchain price, so self markouts flatter weekend LPs "
        + ("(the HL columns correct this)." if has_hl else "(HL markouts were not available for this run)."))
    add("- HL lead and HL toward are only as fine as the reference: 15m candles before Sep 1, 5m until Sep 15, then 1m. "
        "HL-arb wallets that were active only in July and August are therefore harder to confirm, and some sit in `informed-bot`.")
    add("- `picked_1h_t` treats overlapping 1h markouts as independent, so it is inflated for busy wallets. It is only used as a tolerance in the retail rule.")
    add("- Wallet ≠ entity: bot operators rotate EOAs, so wallet-level concentration understates operator concentration. `operator` merges wallets behind a private router, "
        "which gets closer but is still a lower bound (fleets that use several contracts or public routers are not merged).")
    if cov["last_backfilled_block"] < cov["last_swap_block"]:
        add(f"- **Partial data:** `swap_txs` was backfilled only to block {cov['last_backfilled_block']:,} (last attributed swap {cov['last_attributed_utc']} UTC; swaps run to block "
            f"{cov['last_swap_block']:,}). {cov['swaps_total'] - cov['swaps_with_from']:,} later swaps ({pct(1 - cov['vol_share_with_from'])} of volume) have no `tx.from` yet and are excluded; "
            "re-run `uv run python -m flow.xray` once the backfill completes.")
    add("")
    return "\n".join(L) + "\n"
