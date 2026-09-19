"""The one market calendar for tokenized US stocks (Robinhood 24/5), shared by the study, the API and (via golden
fixtures) the TypeScript desk agent.

Session model: a TRADING DAY D (a weekday that is not an NYSE holiday) has one 24/5 session running from 20:00 ET on
the previous calendar day to 20:00 ET on D. Every timestamp therefore belongs to a session date
    S = (ET date) + 1 day   if ET clock >= 20:00   else (ET date)
and the regime follows from S:
    S not a trading day               -> WEEKEND_DARK (S is Sat/Sun) or HOLIDAY (S is a weekday holiday)
    S trading, ET date == S, 09:30 <= t < close (16:00, early close 13:00)  -> REGULAR
    S trading, ET date == S, 04:00 <= t < 09:30 or close <= t < 20:00        -> EXTENDED
    otherwise                                                               -> OVERNIGHT
So the evening before a holiday is closed (Labor Day: Sun Sep 6 20:00 -> Mon Sep 7 20:00 is HOLIDAY), which the old
date-only rule mislabelled as OVERNIGHT.

Reopen windows (the M1 backtest's R3 rule; only the weekday open is validated out of sample):
    weekday_open  09:20-09:45 ET on a trading day (validated: positive in TRAIN and TEST)
    wake          19:50-20:15 ET when a session reopens after a closure (weekend or holiday); a safety-only window
                  (the Sunday part lost money in the backtest: never claim edge from it)
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

import polars as pl

ET = ZoneInfo("America/New_York")

# NYSE full-day closures and 13:00 ET early closes (https://www.nyse.com/markets/hours-calendars).
HOLIDAYS: frozenset[date] = frozenset({
    date(2026, 1, 1), date(2026, 1, 19), date(2026, 2, 16), date(2026, 4, 3), date(2026, 5, 25), date(2026, 6, 19),
    date(2026, 7, 3), date(2026, 9, 7), date(2026, 11, 26), date(2026, 12, 25),
    date(2027, 1, 1), date(2027, 1, 18), date(2027, 2, 15), date(2027, 3, 26), date(2027, 5, 31), date(2027, 6, 18),
    date(2027, 7, 5), date(2027, 9, 6), date(2027, 11, 25), date(2027, 12, 24),
})
EARLY_CLOSES: frozenset[date] = frozenset({date(2026, 11, 27), date(2026, 12, 24), date(2027, 11, 26)})

OPEN_MIN, REGULAR_CLOSE_MIN, EARLY_CLOSE_MIN = 9 * 60 + 30, 16 * 60, 13 * 60
EXT_START_MIN, SESSION_ROLL_MIN = 4 * 60, 20 * 60
WEEKDAY_OPEN_GUARD = (9 * 60 + 20, 9 * 60 + 45)
WAKE_GUARD = (19 * 60 + 50, 20 * 60 + 15)


def is_trading_day(d: date) -> bool:
    return d.isoweekday() <= 5 and d not in HOLIDAYS


@dataclass(frozen=True)
class Regime:
    name: str                 # REGULAR | EXTENDED | OVERNIGHT | WEEKEND_DARK | HOLIDAY
    reopen_window: bool
    reopen_kind: str | None   # "weekday_open" | "wake" | None
    how: int                  # hour of week by ET clock, Mon 00:00 = 0
    session_date: date        # the 24/5 session this timestamp belongs to
    et: datetime


def regime_at(ts: float) -> Regime:
    et = datetime.fromtimestamp(ts, ET)
    d = et.date()
    mins = et.hour * 60 + et.minute
    s = d + timedelta(days=1) if mins >= SESSION_ROLL_MIN else d
    if not is_trading_day(s):
        name = "HOLIDAY" if s.isoweekday() <= 5 else "WEEKEND_DARK"
    else:
        close = EARLY_CLOSE_MIN if s in EARLY_CLOSES else REGULAR_CLOSE_MIN
        if d == s and OPEN_MIN <= mins < close:
            name = "REGULAR"
        elif d == s and (EXT_START_MIN <= mins < OPEN_MIN or close <= mins < SESSION_ROLL_MIN):
            name = "EXTENDED"
        else:
            name = "OVERNIGHT"
    kind = None
    if is_trading_day(d) and WEEKDAY_OPEN_GUARD[0] <= mins < WEEKDAY_OPEN_GUARD[1]:
        kind = "weekday_open"
    elif WAKE_GUARD[0] <= mins < WAKE_GUARD[1] and not is_trading_day(d) and is_trading_day(d + timedelta(days=1)):
        kind = "wake"
    return Regime(name, kind is not None, kind, (et.isoweekday() - 1) * 24 + et.hour, s, et)


def regime_expr(ts_col: str = "ts") -> list[pl.Expr]:
    """Vectorised regime_at over a unix-seconds column: regime, reopen_window, reopen_kind, how, date_et."""
    et = pl.from_epoch(pl.col(ts_col).cast(pl.Int64), time_unit="s").dt.replace_time_zone("UTC").dt.convert_time_zone("America/New_York")
    d = et.dt.date()
    mins = et.dt.hour().cast(pl.Int32) * 60 + et.dt.minute().cast(pl.Int32)
    s = pl.when(mins >= SESSION_ROLL_MIN).then(d + pl.duration(days=1)).otherwise(d)
    hol = list(HOLIDAYS)

    def trading(x: pl.Expr) -> pl.Expr:
        return (x.dt.weekday() <= 5) & ~x.is_in(hol)

    close = pl.when(s.is_in(list(EARLY_CLOSES))).then(EARLY_CLOSE_MIN).otherwise(REGULAR_CLOSE_MIN)
    same = d == s
    regime = (
        pl.when(~trading(s)).then(pl.when(s.dt.weekday() <= 5).then(pl.lit("HOLIDAY")).otherwise(pl.lit("WEEKEND_DARK")))
        .when(same & (mins >= OPEN_MIN) & (mins < close)).then(pl.lit("REGULAR"))
        .when(same & (((mins >= EXT_START_MIN) & (mins < OPEN_MIN)) | ((mins >= close) & (mins < SESSION_ROLL_MIN)))).then(pl.lit("EXTENDED"))
        .otherwise(pl.lit("OVERNIGHT"))
    )
    weekday_open = trading(d) & (mins >= WEEKDAY_OPEN_GUARD[0]) & (mins < WEEKDAY_OPEN_GUARD[1])
    wake = (mins >= WAKE_GUARD[0]) & (mins < WAKE_GUARD[1]) & ~trading(d) & trading(d + pl.duration(days=1))
    kind = pl.when(weekday_open).then(pl.lit("weekday_open")).when(wake).then(pl.lit("wake")).otherwise(pl.lit(None, pl.Utf8))
    return [
        regime.alias("regime"),
        (weekday_open | wake).alias("reopen_window"),
        kind.alias("reopen_kind"),
        ((et.dt.weekday().cast(pl.Int32) - 1) * 24 + et.dt.hour().cast(pl.Int32)).alias("how"),  # Int8 would overflow on Sundays
        d.alias("date_et"),
    ]
