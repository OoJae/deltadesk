"""Unit tests for the API's pure logic: market calendar and the /safe-to-lp decision (no network)."""

from datetime import datetime

from api import live
from api.app import PHI_BLOCK, assess


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


def test_reopen_windows_and_hour_of_week():
    assert live.regime_at(ts(2026, 9, 20, 19, 55)).reopen_window            # Sunday wake
    assert live.regime_at(ts(2026, 9, 21, 9, 25)).reopen_window             # Monday open
    assert not live.regime_at(ts(2026, 9, 21, 9, 50)).reopen_window
    assert live.regime_at(ts(2026, 9, 21, 9, 25)).how == 9                  # Mon 09:xx
    assert live.regime_at(ts(2026, 9, 20, 23)).how == 6 * 24 + 23           # Sun 23:xx


def test_assess_verdicts():
    regular = live.regime_at(ts(2026, 9, 16, 11))
    good_hour = {"edge_1h": 3.0}
    assert assess(1.0, regular, good_hour, 60)["verdict"] == "ALLOW"
    assert assess(PHI_BLOCK["REGULAR"] / 2 + 1, regular, good_hour, 60)["verdict"] == "CAUTION"
    assert assess(-(PHI_BLOCK["REGULAR"] + 1), regular, good_hour, 60)["verdict"] == "BLOCK"
    assert assess(1.0, regular, {"edge_1h": 0.3}, 60)["verdict"] == "BLOCK"   # historically toxic hour
    assert assess(1.0, regular, {"edge_1h": 0.8}, 60)["verdict"] == "CAUTION"
    weekend = live.regime_at(ts(2026, 9, 19, 12))
    assert assess(1.0, weekend, good_hour, 90_000)["verdict"] == "CAUTION"    # closed market, frozen oracle
    reopen = live.regime_at(ts(2026, 9, 21, 9, 25))
    assert assess(0.0, reopen, good_hour, 60)["verdict"] == "BLOCK"


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
