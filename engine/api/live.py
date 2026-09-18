"""Live market state for the API: pool mids (RPC), Hyperliquid mids, Chainlink freshness, market calendar, basis.

Everything here is read-only and cached for a few seconds so the API can serve many callers without hammering
the RPC / HL. Fair value F = HL(t) · k, where k is the pool/HL basis calibrated on the last completed regular session
(absorbs Robinhood uiMultiplier and ETF-vs-index scale).
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from functools import lru_cache
from pathlib import Path
from zoneinfo import ZoneInfo

import httpx
import polars as pl

from markout.pools import POOLS, Pool

DATA = Path(__file__).resolve().parents[2] / "data"
ET = ZoneInfo("America/New_York")
RPCS = ["https://rpc.mainnet.chain.robinhood.com", "https://robinhood-rpc.publicnode.com"]
STATE_VIEW = "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b"
HL_INFO = "https://api.hyperliquid.xyz/info"

# NYSE full-day closures (2026). Early closes are ignored (conservative: treated as a normal day).
HOLIDAYS = {date(2026, 7, 3), date(2026, 9, 7), date(2026, 11, 26), date(2026, 12, 25)}

# Pool → HL reference: either one coin, or (numerator, denominator) for a ratio pool.
HL_REF = {"NVDA/USDG": "xyz:NVDA", "TSLA/USDG": "xyz:TSLA", "SPY/USDG": "xyz:SP500", "QQQ/SPY": ("xyz:XYZ100", "xyz:SP500")}
CHAINLINK = {  # Robinhood Chain proxies (per-token USD, 8 decimals, uiMultiplier included)
    "NVDA": "0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15",
    "SPY": "0x319724394D3A0e3669269846abE664Cd621f9f6A",
    "QQQ": "0x80901d846d5D7B030F26B480776EE3b29374C2ae",
    "TSLA": "0x4A1166a659A55625345e9515b32adECea5547C38",
}
POOL_BY_KEY = {p.key: p for p in POOLS}
POOL_ALIASES = {p.base.lower(): p.key for p in POOLS} | {"qqq-spy": "QQQ/SPY", "qqqspy": "QQQ/SPY"}

_client = httpx.Client(timeout=10, headers={"User-Agent": "deltadesk-api/0.1"})
_cache: dict[str, tuple[float, object]] = {}


def cached(key: str, ttl: float, fn):
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < ttl:
        return hit[1]
    val = fn()
    _cache[key] = (time.time(), val)
    return val


def resolve_pool(name: str) -> Pool:
    key = name.upper().replace("-", "/")
    if key in POOL_BY_KEY:
        return POOL_BY_KEY[key]
    alias = POOL_ALIASES.get(name.lower())
    if alias:
        return POOL_BY_KEY[alias]
    raise KeyError(f"unknown pool {name!r}; known: {sorted(POOL_BY_KEY)}")


# ---------------------------------------------------------------- market calendar
@dataclass(frozen=True)
class Regime:
    name: str          # REGULAR | EXTENDED | OVERNIGHT | WEEKEND_DARK | HOLIDAY
    reopen_window: bool
    how: int           # hour of week, Mon 00:00 ET = 0
    et: datetime


def regime_at(ts: float) -> Regime:
    """Same calendar as markout.study.regime_expr, for a single timestamp."""
    et = datetime.fromtimestamp(ts, ET)
    dow = et.isoweekday()  # 1=Mon … 7=Sun
    mins = et.hour * 60 + et.minute
    reopen = (dow == 7 and mins >= 19 * 60 + 50) or (dow == 1 and mins < 20) or (dow <= 5 and 9 * 60 + 20 <= mins < 9 * 60 + 45)
    if et.date() in HOLIDAYS:
        name = "HOLIDAY"
    elif (dow == 5 and mins >= 20 * 60) or dow == 6 or (dow == 7 and mins < 20 * 60):
        name = "WEEKEND_DARK"
    elif dow <= 5 and 9 * 60 + 30 <= mins < 16 * 60:
        name = "REGULAR"
    elif dow <= 5 and (4 * 60 <= mins < 9 * 60 + 30 or 16 * 60 <= mins < 20 * 60):
        name = "EXTENDED"
    else:
        name = "OVERNIGHT"
    return Regime(name, reopen, (dow - 1) * 24 + et.hour, et)


# ---------------------------------------------------------------- chain reads
def _eth_call(to: str, data: str) -> str:
    last = None
    for url in RPCS:
        try:
            j = _client.post(url, json={"jsonrpc": "2.0", "id": 1, "method": "eth_call", "params": [{"to": to, "data": data}, "latest"]}).json()
            if "result" in j:
                return j["result"]
            last = j.get("error")
        except (httpx.HTTPError, ValueError) as e:
            last = e
    raise RuntimeError(f"eth_call failed: {last}")


def _words(hexdata: str) -> list[int]:
    b = bytes.fromhex(hexdata[2:])
    return [int.from_bytes(b[i : i + 32], "big") for i in range(0, len(b), 32)]


def mid_from_sqrt(pool: Pool, sqrtp: int) -> float:
    raw_p = (sqrtp / 2**96) ** 2 * 10 ** (pool.dec0 - pool.dec1)  # human token1 per token0
    return raw_p if pool.base_is_0 else 1 / raw_p  # quote per base


def pool_mid(pool: Pool) -> dict:
    def fetch():
        if pool.venue == "v3":
            w = _words(_eth_call(pool.pool_id, "0x3850c7bd"))  # slot0()
        else:
            w = _words(_eth_call(STATE_VIEW, "0xc815641c" + pool.pool_id[2:]))  # getSlot0(bytes32)
        tick = w[1] - (1 << 256) if w[1] >= 1 << 255 else w[1]
        return {"mid": mid_from_sqrt(pool, w[0]), "tick": tick, "at": time.time()}

    return cached(f"pool:{pool.key}", 3, fetch)


def chainlink(sym: str) -> dict | None:
    proxy = CHAINLINK.get(sym)
    if not proxy:
        return None

    def fetch():
        w = _words(_eth_call(proxy, "0xfeaf968c"))  # latestRoundData()
        answer = w[1] - (1 << 256) if w[1] >= 1 << 255 else w[1]
        return {"price": answer / 1e8, "updated_at": w[3], "age_s": time.time() - w[3]}

    return cached(f"cl:{sym}", 15, fetch)


def hl_mids() -> dict[str, float]:
    def fetch():
        j = _client.post(HL_INFO, json={"type": "allMids", "dex": "xyz"}).json()
        return {k: float(v) for k, v in j.items()}

    return cached("hl:mids", 2, fetch)


def hl_ref_price(pool: Pool, mids: dict[str, float] | None = None) -> float:
    mids = mids or hl_mids()
    ref = HL_REF[pool.key]
    return mids[ref[0]] / mids[ref[1]] if isinstance(ref, tuple) else mids[ref]


# ---------------------------------------------------------------- basis calibration
@lru_cache(maxsize=1)
def _candles(coin: str) -> pl.DataFrame:
    frames = []
    for iv in ("1m", "5m", "15m", "1h"):
        f = DATA / "raw" / "hl_candles" / f"{coin.replace(':', '_')}_{iv}.parquet"
        if f.exists():
            frames.append(pl.read_parquet(f).select((pl.col("t_close_ms") / 1000).alias("ts"), pl.col("c"), pl.lit(iv).alias("iv")))
    df = pl.concat(frames)
    # finest resolution wins where intervals overlap
    order = {"1m": 0, "5m": 1, "15m": 2, "1h": 3}
    return df.with_columns(pl.col("iv").replace_strict(order).alias("rank")).sort(["ts", "rank"]).unique("ts", keep="first").sort("ts")


def _hl_series(pool: Pool) -> pl.DataFrame:
    ref = HL_REF[pool.key]
    if isinstance(ref, tuple):
        a, b = _candles(ref[0]), _candles(ref[1])
        j = a.join_asof(b.rename({"c": "c_b"}).select("ts", "c_b"), on="ts", strategy="backward")
        return j.select("ts", (pl.col("c") / pl.col("c_b")).alias("hl"))
    return _candles(ref).select("ts", pl.col("c").alias("hl"))


@lru_cache(maxsize=None)
def basis(pool_key: str) -> dict:
    """k = median(pool mid / HL) over the most recent completed regular session in the M0 swap table.
    Prefers the verified hl_ref module output when present."""
    hl_out = DATA / "study" / "m1" / "hl_ref" / "hl_markouts.parquet"
    if hl_out.exists():
        df = pl.read_parquet(hl_out, columns=["pool", "k", "block"]).filter(pl.col("pool") == pool_key).sort("block")
        if df.height:
            return {"k": float(df["k"][-1]), "source": "hl_ref"}
    pool = POOL_BY_KEY[pool_key]
    sw = pl.read_parquet(DATA / "study" / "m0" / "swaps.parquet", columns=["pool", "ts", "mid_after", "regime", "date_et"])
    reg = sw.filter((pl.col("pool") == pool_key) & (pl.col("regime") == "REGULAR"))
    last_day = reg["date_et"].max()
    day = reg.filter(pl.col("date_et") == last_day).sort("ts")
    j = day.join_asof(_hl_series(pool), on="ts", strategy="backward").drop_nulls("hl")
    k = float((j["mid_after"] / j["hl"]).median())
    return {"k": k, "source": f"m0 swaps, regular session {last_day}", "n": j.height}


def fair_value(pool: Pool) -> dict:
    mids = hl_mids()
    b = basis(pool.key)
    hl = hl_ref_price(pool, mids)
    pm = pool_mid(pool)
    f = hl * b["k"]
    return {
        "pool": pool.key,
        "hl_ref": HL_REF[pool.key],
        "hl_price": hl,
        "basis_k": b["k"],
        "basis_source": b["source"],
        "fair_value": f,
        "pool_mid": pm["mid"],
        "pool_tick": pm["tick"],
        "gap_bps": 1e4 * math.log(f / pm["mid"]),
        "as_of": time.time(),
    }


def next_regime_change(ts: float, horizon_h: int = 72) -> dict | None:
    cur = regime_at(ts)
    t = ts
    for _ in range(horizon_h * 12):
        t += 300
        r = regime_at(t)
        if r.name != cur.name or r.reopen_window != cur.reopen_window:
            return {"at": t, "regime": r.name, "reopen_window": r.reopen_window, "in_s": t - ts}
    return None


def last_completed_session_end(ts: float) -> datetime:
    """Most recent 16:00 ET close of a trading day before ts (used for 'oracle frozen since' messaging)."""
    et = datetime.fromtimestamp(ts, ET)
    d = et.date()
    for _ in range(10):
        close = datetime(d.year, d.month, d.day, 16, 0, tzinfo=ET)
        if close.timestamp() <= ts and d.isoweekday() <= 5 and d not in HOLIDAYS:
            return close
        d -= timedelta(days=1)
    return et
