"""Real-data tests for positions/ (golden reconciliation, conservation, reconstruction, accounting identities).

Rebuilds data/study/m1/positions/ with `positions.attribute.run_all()` (~10 s) when the outputs are missing or older
than the code; otherwise reads them. Skips if the raw data / M0 swaps are not on this machine."""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # engine/ on the path (no shared conftest / pytest pythonpath yet)

import duckdb
import polars as pl
import pytest

from positions.reconstruct import NPM, OUT, RAW, T_NPM_COLLECT, T_NPM_DEC

ENGINE = Path(__file__).resolve().parents[1]
SWAPS = RAW.parent / "study" / "m0" / "swaps.parquet"
DIRECT_GOLDEN_OWNER = "0x4da212efc0d513b00680a6cf66f97d508452bf18"
FILES = ["positions.parquet", "segments.parquet", "attribution.parquet", "owners.parquet", "golden.json", "reconciliation.md", "diagnostics.json"]

pytestmark = pytest.mark.skipif(not (SWAPS.exists() and (RAW / "lp_txs").exists()), reason="raw data / M0 swaps not available")


@pytest.fixture(scope="session")
def out():
    code_mtime = max(p.stat().st_mtime for p in (ENGINE / "positions").glob("*.py"))
    stale = any(not (OUT / f).exists() or (OUT / f).stat().st_mtime < code_mtime for f in FILES)
    if stale:
        from positions.attribute import run_all
        run_all()
    return {
        "pos": pl.read_parquet(OUT / "positions.parquet"), "seg": pl.read_parquet(OUT / "segments.parquet"),
        "att": pl.read_parquet(OUT / "attribution.parquet"), "owners": pl.read_parquet(OUT / "owners.parquet"),
        "golden": json.loads((OUT / "golden.json").read_text()), "diag": json.loads((OUT / "diagnostics.json").read_text()),
    }


# -------------------------------------------------------------------------------------------------------- golden set
def test_golden_set_composition(out):
    g = out["golden"]["positions"]
    assert len(g) == 4
    assert sum(p["kind"] == "v3_npm" for p in g) == 3
    direct = [p for p in g if p["kind"] == "v3_direct"]
    assert len(direct) == 1 and direct[0]["owner"] == DIRECT_GOLDEN_OWNER
    pos = out["pos"].filter(pl.col("pos_id").is_in([p["pos_id"] for p in g]))
    assert pos["closed"].all() and (~pos["is_jit"]).all() and (pos["lifetime_days"] >= 1.0).all()
    assert pos.filter(pl.col("kind") == "v3_npm")["nft_burned"].all()          # fully collected by construction
    assert pos.filter(pl.col("kind") == "v3_direct")["collected_after_close"].all()
    assert (pos["avg_notional_usd"] > 1000).all()


@pytest.mark.parametrize("i", range(4))
def test_golden_residual_under_1bp(out, i):
    p = out["golden"]["positions"][i]
    assert abs(p["residual_bp"]) < 1.0, p
    # per token, too: realized vs attributed within 1 bp of notional each
    assert abs(p["residual0"]) / 1e6 < 1e-4 * p["avg_notional_usd"]
    assert abs(p["residual1"]) / 1e18 * 250 < 1e-4 * p["avg_notional_usd"]  # NVDA < $250 over the sample


def test_golden_npm_realized_fees_recomputed_from_raw_logs(out):
    """Independent path: read NPM Collect / DecreaseLiquidity for the golden tokenIds straight from raw lp_txs."""
    npm = [p for p in out["golden"]["positions"] if p["kind"] == "v3_npm"]
    ids = {"0x" + format(int(p["pos_id"].split(":")[-1]), "064x"): p for p in npm}
    q = f"""select topic0, topic1, data from read_parquet('{RAW / "lp_txs"}/hs_*.parquet')
            where address = '{NPM}' and topic0 in ('{T_NPM_COLLECT}', '{T_NPM_DEC}') and topic1 in ({",".join(f"'{h}'" for h in ids)})"""
    tot = {h: [0, 0] for h in ids}
    for t0, t1, data in duckdb.sql(q).fetchall():
        b = bytes.fromhex(data[2:])
        w = [int.from_bytes(b[k: k + 32], "big") for k in range(0, len(b), 32)]
        sgn = 1 if t0 == T_NPM_COLLECT else -1           # data: Collect(recipient, a0, a1) / Decrease(liquidity, a0, a1)
        tot[t1][0] += sgn * w[1]
        tot[t1][1] += sgn * w[2]
    for h, p in ids.items():
        r0, r1 = tot[h]
        assert r0 == pytest.approx(p["realized_fee0"], abs=1) and r1 == pytest.approx(p["realized_fee1"], rel=1e-12)
        assert r0 > 0 and r1 > 0
        usd = (r0 - p["fee0"]) / 1e6 + (r1 - p["fee1"]) / 1e18 * 250
        assert abs(usd) / p["avg_notional_usd"] * 1e4 < 1.0


def test_fully_collected_v3_positions_reconcile(out):
    """Beyond the golden set: every NFT-burned v3 position with ≥ $1k notional reconciles within 1 bp."""
    c = out["pos"].filter(pl.col("closed") & pl.col("nft_burned") & (pl.col("pool") == "NVDA/USDG") & (pl.col("avg_notional_usd") >= 1000))
    assert c.height > 1000
    assert (c["residual_bp"].abs() < 1.0).all()


# -------------------------------------------------------------------------------------------------------- conservation
def test_conservation_against_swaps(out):
    sw = duckdb.sql(f"select pool, sum(fee_usd) f, sum(case when valid_1h then picked_usd_1h else 0 end) p from '{SWAPS}' group by pool").fetchall()
    agg = {r[0]: r for r in out["pos"].group_by("pool").agg(pl.col("fee_usd").sum(), pl.col("picked_1h").sum()).iter_rows()}
    for pool, f, p in sw:
        flash = out["diag"][pool]["fee_usd_flash"]
        assert abs(agg[pool][1] / (f + flash) - 1) < 0.005, pool
        assert abs(agg[pool][1] - (f + flash)) < 0.01, pool           # in fact exact to the cent
        assert agg[pool][2] == pytest.approx(p, rel=1e-9), pool
        assert out["diag"][pool]["fee_usd_unattributed"] == 0


def test_attribution_regimes_and_segments_add_up(out):
    pos = out["pos"].select("pos_id", "fee_usd", "picked_hl_1h")
    a = out["att"].group_by("pos_id").agg(pl.col("fee_usd").sum().alias("fa"), pl.col("picked_hl_1h").sum().alias("ha"))
    s = out["seg"].group_by("pos_id").agg(pl.col("fee_usd").sum().alias("fs"))
    j = pos.join(a, on="pos_id", how="left").join(s, on="pos_id", how="left").fill_null(0.0)
    assert (j["fee_usd"] - j["fa"]).abs().max() < 1e-6
    assert (j["fee_usd"] - j["fs"]).abs().max() < 1e-6
    assert (j["picked_hl_1h"] - j["ha"]).abs().max() < 1e-6


# ----------------------------------------------------------------------------------------------------- reconstruction
def test_reconstructed_liquidity_matches_swap_events(out):
    for pool, d in out["diag"].items():
        assert d["liq_match_share_1e-6"] > 0.999, pool
        assert d["final_liquidity_reconstructed"] == d["final_liquidity_event"], pool
    v3 = out["diag"]["NVDA/USDG"]
    assert v3["npm_mints_linked"] == v3["npm_pool_mints"] and v3["npm_burns_linked"] == v3["npm_pool_burns_nonzero"]


def test_segments_are_contiguous_and_positive(out):
    s = out["seg"].sort(["pos_id", "seg"])
    assert (s["L"] > 0).all()
    nxt = s.with_columns(pl.col("start_ord").shift(-1).over("pos_id").alias("nxt")).filter(pl.col("nxt").is_not_null())
    assert (nxt["end_ord"] <= nxt["nxt"]).all()
    open_ = out["pos"].filter(~pl.col("closed"))["pos_id"]
    last = s.group_by("pos_id").agg(pl.col("end_ord").last().is_null().alias("open_end"))
    assert set(last.filter(pl.col("open_end"))["pos_id"]) == set(open_)


# ------------------------------------------------------------------------------------------------------- accounting
def test_net_identities(out):
    p = out["pos"]
    lhs = p["end_value_usd"] + p["withdrawals_usd"] + p["fee_usd"] - p["deposits_usd"] - p["gas_usd"]
    assert ((lhs - p["net_usd"]).abs() <= 1e-6 * (1 + p["deposits_usd"].abs())).all()
    assert ((p["price_pnl_usd"] + p["il_usd"] + p["fee_usd"] - p["gas_usd"] - p["net_usd"]).abs() <= 1e-6 * (1 + p["deposits_usd"].abs())).all()
    assert (p.filter(pl.col("closed"))["end_value_usd"] == 0).all()
    assert (p["gas_usd"] >= 0).all() and p["gas_usd"].sum() > 0
    assert p["txs_missing_gas"].sum() == 0


def test_owners_table_consistent(out):
    o, p = out["owners"], out["pos"]
    assert o["fee_usd"].sum() == pytest.approx(p["fee_usd"].sum(), rel=1e-9)
    assert o["n_positions"].sum() == p.height
    row = o.filter(pl.col("owner") == DIRECT_GOLDEN_OWNER).row(0, named=True)
    assert row["n_positions"] == p.filter(pl.col("owner") == DIRECT_GOLDEN_OWNER).height
    for c in ("avg_notional_usd", "active_days", "net_per_1k_per_day", "edge_self_1h", "median_width_ticks", "rebalances_per_day",
              "weekend_share", "jit_fee_share"):
        assert row[c] is not None and not math.isnan(row[c]), c


def test_tearsheet_matches_positions(out):
    from positions.tearsheet import render, tearsheet
    ts = tearsheet(DIRECT_GOLDEN_OWNER, (out["pos"], out["seg"], out["att"]))
    sel = out["pos"].filter(pl.col("owner") == DIRECT_GOLDEN_OWNER)
    s = ts["summary"]
    assert s["n_positions"] == sel.height == len(ts["positions"])
    assert s["fees_usd"] == pytest.approx(sel["fee_usd"].sum())
    assert s["net_usd"] == pytest.approx(sel["net_usd"].sum())
    assert s["residual"]["max_abs_residual_bp"] < 1.0
    assert sum(r["fees_usd"] for r in ts["by_regime"]) == pytest.approx(s["fees_usd"], rel=1e-9)
    json.dumps(ts)                                     # JSON-serializable (NaN → None)
    assert "LP tearsheet" in render(ts)
    assert tearsheet("0x" + "0" * 40, (out["pos"], out["seg"], out["att"]))["summary"] is None
