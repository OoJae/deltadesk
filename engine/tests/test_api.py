"""Unit tests for the API's pure logic: market calendar and the /safe-to-lp decision (no network)."""

from datetime import datetime

from api import live
from api.app import GAP_CAUTION, assess


def ts(y, mo, d, h, mi=0):
    return datetime(y, mo, d, h, mi, tzinfo=live.ET).timestamp()


def test_calendar_regimes():
    assert live.regime_at(ts(2026, 9, 16, 11)).name == "REGULAR"             # Wed 11:00
    assert live.regime_at(ts(2026, 9, 16, 17)).name == "EXTENDED"            # Wed 17:00
    assert live.regime_at(ts(2026, 9, 16, 22)).name == "OVERNIGHT"           # Wed 22:00
    assert live.regime_at(ts(2026, 9, 18, 20, 5)).name == "WEEKEND_DARK"     # Fri 20:05
    assert live.regime_at(ts(2026, 9, 20, 19, 59)).name == "WEEKEND_DARK"    # Sun 19:59
    assert live.regime_at(ts(2026, 9, 20, 20, 1)).name == "OVERNIGHT"        # Sun 20:01
    assert live.regime_at(ts(2026, 9, 7, 11)).name == "HOLIDAY"              # Labor Day
    # 24/5 sessions roll at 20:00 ET: no session opens the evening before a holiday, the next opens the holiday evening
    assert live.regime_at(ts(2026, 9, 6, 20, 30)).name == "HOLIDAY"          # Sun before Labor Day (was OVERNIGHT)
    assert live.regime_at(ts(2026, 9, 7, 20, 30)).name == "OVERNIGHT"        # Labor Day evening = Tue session
    assert live.regime_at(ts(2026, 7, 2, 21)).name == "HOLIDAY"              # Thu evening before Jul 3
    assert live.regime_at(ts(2026, 11, 27, 14)).name == "EXTENDED"           # early close 13:00


def test_reopen_windows_and_hour_of_week():
    assert live.regime_at(ts(2026, 9, 20, 19, 55)).reopen_kind == "wake"     # Sunday wake 19:50-20:15
    assert live.regime_at(ts(2026, 9, 20, 20, 10)).reopen_kind == "wake"
    assert not live.regime_at(ts(2026, 9, 20, 23)).reopen_window            # validated R3 window, not Sun->Mon 00:20
    assert not live.regime_at(ts(2026, 9, 21, 0, 10)).reopen_window
    assert live.regime_at(ts(2026, 9, 21, 9, 25)).reopen_kind == "weekday_open"
    assert not live.regime_at(ts(2026, 9, 21, 9, 50)).reopen_window
    assert live.regime_at(ts(2026, 9, 6, 19, 55)).reopen_kind is None       # no wake: Labor Day is closed
    assert live.regime_at(ts(2026, 9, 7, 19, 55)).reopen_kind == "wake"     # wake on the holiday evening
    assert live.regime_at(ts(2026, 9, 7, 9, 25)).reopen_kind is None        # no cash open on a holiday
    assert live.regime_at(ts(2026, 9, 21, 9, 25)).how == 9                  # Mon 09:xx
    assert live.regime_at(ts(2026, 9, 20, 23)).how == 6 * 24 + 23           # Sun 23:xx


def test_assess_verdicts():
    regular = live.regime_at(ts(2026, 9, 16, 11))
    good_hour = {"edge_1h": 3.0, "picked_1h_usd": 10.0}
    assert assess(1.0, regular, good_hour, 60)["verdict"] == "ALLOW"
    # the gap threshold is unvalidated (M1): a big gap is CAUTION, never BLOCK
    assert assess(GAP_CAUTION["REGULAR"] + 1, regular, good_hour, 60)["verdict"] == "CAUTION"
    assert assess(-(GAP_CAUTION["REGULAR"] * 5), regular, good_hour, 60)["verdict"] == "CAUTION"
    # Chainlink updates on 50 bp moves / ~24 h heartbeat: hours-old is normal, only >26 h in an open session is dead
    assert assess(1.0, regular, good_hour, 7 * 3600)["verdict"] == "ALLOW"
    assert assess(1.0, regular, good_hour, 27 * 3600)["verdict"] == "CAUTION"
    assert assess(1.0, regular, {"edge_1h": 0.3, "picked_1h_usd": 50.0}, 60)["verdict"] == "BLOCK"   # historically toxic hour
    assert assess(1.0, regular, {"edge_1h": 0.8, "picked_1h_usd": 50.0}, 60)["verdict"] == "CAUTION"
    # takers lost money this hour (picked < 0): good for LPs, never a reason to block
    assert assess(1.0, regular, {"edge_1h": None, "picked_1h_usd": -40.0}, 60)["verdict"] == "ALLOW"
    weekend = live.regime_at(ts(2026, 9, 19, 12))
    assert assess(1.0, weekend, good_hour, 90_000)["verdict"] == "CAUTION"    # closed market, frozen oracle
    reopen = live.regime_at(ts(2026, 9, 21, 9, 25))
    assert assess(0.0, reopen, good_hour, 60)["verdict"] == "BLOCK"          # validated weekday-open guard
    wake = live.regime_at(ts(2026, 9, 20, 20, 5))
    assert assess(0.0, wake, good_hour, 60)["verdict"] == "CAUTION"          # safety check only


def test_calendar_scalar_matches_vectorised():
    import random

    import polars as pl

    from markout.calendar import regime_at, regime_expr

    random.seed(11)
    xs = [random.uniform(1.7815e9, 1.8e9) for _ in range(3000)]
    base = ts(2026, 9, 6, 0)
    xs += [base + m * 60 for m in range(0, 3 * 1440, 5)]   # Labor Day weekend, every 5 min
    df = pl.DataFrame({"ts": xs}).with_columns(*regime_expr())
    for t, r, rw, rk, how in df.select("ts", "regime", "reopen_window", "reopen_kind", "how").iter_rows():
        x = regime_at(t)
        assert (x.name, x.reopen_window, x.reopen_kind, x.how) == (r, rw, rk, how), t
    assert df["how"].min() >= 0 and df["how"].max() <= 167    # Sundays used to overflow Int8 to negative hours


def test_premium_fails_closed_on_railway(monkeypatch):
    from fastapi.testclient import TestClient

    from api import app as appmod

    monkeypatch.setattr(appmod, "API_KEY", "")
    monkeypatch.setattr(appmod, "REQUIRE_KEY", True)
    c = TestClient(appmod.app)
    closed = "premium routes disabled: the server key is not configured"
    r = c.get("/lp-league")
    assert r.status_code == 503 and r.json()["detail"] == closed   # misconfigured server: closed, not open
    monkeypatch.setattr(appmod, "REQUIRE_KEY", False)
    # Local dev without a key stays open. Without a built data/ the route still 503s ("LP League not built yet"), so
    # assert on the reason, not the status: the two 503s mean opposite things.
    assert c.get("/lp-league").json().get("detail") != closed


def test_mid_from_sqrt_orientation():
    nvda = live.POOL_BY_KEY["NVDA/USDG"]  # token0 USDG(6), token1 NVDA(18): base is token1
    # choose sqrtP so that 1 NVDA = 220 USDG: raw token1/token0 = (1e18/220) / 1e6
    raw = (1e18 / 220) / 1e6
    sqrtp = int((raw ** 0.5) * 2**96)
    assert abs(live.mid_from_sqrt(nvda, sqrtp) - 220) < 1e-6
    spy = live.POOL_BY_KEY["SPY/USDG"]  # currency0 SPY(18), currency1 USDG(6): base is token0
    raw = 760 * 1e6 / 1e18
    sqrtp = int((raw ** 0.5) * 2**96)
    assert abs(live.mid_from_sqrt(spy, sqrtp) - 760) < 1e-6


def test_public_study_tables_are_aggregates_only(tmp_path, monkeypatch):
    """Row-level tables (per swap / wallet / position) never leak through /study/table, by name or by size."""
    import polars as pl
    from fastapi.testclient import TestClient

    from api import app as appmod

    scope = tmp_path / "flow"
    scope.mkdir()
    pl.DataFrame({"label": ["hl_arb", "retail"], "fee_usd": [1.0, 2.0]}).write_parquet(scope / "by_label.parquet")
    pl.DataFrame({"taker": ["0xa"], "fee_usd": [1.0]}).write_parquet(scope / "takers.parquet")                  # listed
    pl.DataFrame({"x": range(appmod.MAX_PUBLIC_ROWS + 1)}).write_parquet(scope / "new_rowlevel.parquet")     # too big
    monkeypatch.setitem(appmod.STUDY_SCOPES, "flow", scope)
    c = TestClient(appmod.app)
    assert c.get("/study/table/flow/by_label").status_code == 200
    assert c.get("/study/table/flow/takers").status_code == 404
    assert c.get("/study/table/flow/new_rowlevel").status_code == 404
    assert c.get("/study/tables").json()["flow"] == ["by_label"]


def test_hl_candles_merge_keeps_history_and_prefers_fresh():
    import polars as pl

    from indexer.hl_candles import merge

    old = pl.DataFrame({"t_open_ms": [1, 2, 3], "c": [10.0, 20.0, 30.0]})
    new = pl.DataFrame({"t_open_ms": [3, 4], "c": [31.0, 40.0]})     # candle 3 was still forming in the old fetch
    m = merge(old, new)
    assert m["t_open_ms"].to_list() == [1, 2, 3, 4]                   # old history (1, 2) survives
    assert m.filter(pl.col("t_open_ms") == 3)["c"].item() == 31.0     # fresh value wins


def test_raw_download_is_gated_and_confined(tmp_path, monkeypatch):
    import polars as pl
    from fastapi.testclient import TestClient

    from api import app as appmod

    (tmp_path / "base_npm").mkdir()
    pl.DataFrame({"x": [1]}).write_parquet(tmp_path / "base_npm" / "hs_1_2.parquet")
    monkeypatch.setattr(appmod, "RAW_DIR", tmp_path)
    monkeypatch.setattr(appmod, "API_KEY", "k")
    c = TestClient(appmod.app)
    assert c.get("/admin/raw/base_npm").status_code == 402                                    # key required
    h = {"x-deltadesk-key": "k"}
    assert c.get("/admin/raw/base_npm", headers=h).json() == [{"name": "hs_1_2.parquet", "bytes": (tmp_path / "base_npm" / "hs_1_2.parquet").stat().st_size}]
    assert c.get("/admin/raw/base_npm/hs_1_2.parquet", headers=h).status_code == 200
    for bad in ("/admin/raw/..%2F..%2Fetc/passwd", "/admin/raw/base_npm/..%2F..%2F.env", "/admin/raw/base_npm/notes.txt"):
        assert c.get(bad, headers=h).status_code == 404
