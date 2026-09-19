/**
 * The one market calendar for tokenized US stocks (Robinhood 24/5): a port of
 * engine/markout/calendar.py that must equal test/fixtures/calendar_cases.json on every case.
 * No date libraries: ET comes from Intl (America/New_York), civil-date arithmetic is integer math.
 *
 * Session model: a TRADING DAY D (a weekday that is not an NYSE holiday) has one 24/5 session from
 * 20:00 ET on the previous calendar day to 20:00 ET on D. A timestamp belongs to session
 *     S = (ET date) + 1 day  if the ET clock is ≥ 20:00, else (ET date)
 * and the regime follows from S:
 *     S not a trading day                                    → WEEKEND_DARK (Sat/Sun) or HOLIDAY
 *     S trading, ET date == S, 09:30 ≤ t < close              → REGULAR (close 16:00, early 13:00)
 *     S trading, ET date == S, 04:00 ≤ t < 09:30 or close ≤ t < 20:00 → EXTENDED
 *     otherwise                                               → OVERNIGHT
 * Reopen windows: weekday_open 09:20–09:45 ET on a trading day (validated out of sample), and wake
 * 19:50–20:15 ET when a session reopens after a closure (safety-only; never an edge claim).
 */

import type { CalendarRegime, EtClock, RegimeName, ReopenKind } from "../types.js";

// NYSE full-day closures and 13:00 ET early closes (https://www.nyse.com/markets/hours-calendars).
export const HOLIDAYS: ReadonlySet<string> = new Set([
  "2026-01-01",
  "2026-01-19",
  "2026-02-16",
  "2026-04-03",
  "2026-05-25",
  "2026-06-19",
  "2026-07-03",
  "2026-09-07",
  "2026-11-26",
  "2026-12-25",
  "2027-01-01",
  "2027-01-18",
  "2027-02-15",
  "2027-03-26",
  "2027-05-31",
  "2027-06-18",
  "2027-07-05",
  "2027-09-06",
  "2027-11-25",
  "2027-12-24",
]);
export const EARLY_CLOSES: ReadonlySet<string> = new Set([
  "2026-11-27",
  "2026-12-24",
  "2027-11-26",
]);

export const OPEN_MIN = 9 * 60 + 30;
export const REGULAR_CLOSE_MIN = 16 * 60;
export const EARLY_CLOSE_MIN = 13 * 60;
export const EXT_START_MIN = 4 * 60;
export const SESSION_ROLL_MIN = 20 * 60;
export const WEEKDAY_OPEN_GUARD: readonly [number, number] = [9 * 60 + 20, 9 * 60 + 45];
export const WAKE_GUARD: readonly [number, number] = [19 * 60 + 50, 20 * 60 + 15];

// ---------------------------------------------------------------------------------------------
// Civil dates as day numbers (days since 1970-01-01), Howard Hinnant's algorithms.

export function daysFromCivil(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

export function civilFromDays(z: number): { year: number; month: number; day: number } {
  const zz = z + 719468;
  const era = Math.floor(zz / 146097);
  const doe = zz - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp + (mp < 10 ? 3 : -9);
  return { year: yoe + era * 400 + (month <= 2 ? 1 : 0), month, day };
}

/** ISO weekday (Monday = 1 … Sunday = 7) of a day number; 1970-01-01 was a Thursday. */
export function isoWeekdayOfDays(days: number): number {
  return ((((days + 3) % 7) + 7) % 7) + 1;
}

export function isoDateOfDays(days: number): string {
  const { year, month, day } = civilFromDays(days);
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function daysOfIsoDate(iso: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (m === null) throw new RangeError(`not an ISO date: ${iso}`);
  return daysFromCivil(Number(m[1]), Number(m[2]), Number(m[3]));
}

export function isTradingDay(days: number): boolean {
  return isoWeekdayOfDays(days) <= 5 && !HOLIDAYS.has(isoDateOfDays(days));
}

// ---------------------------------------------------------------------------------------------
// ET clock via Intl

const ET_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hourCycle: "h23",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
});

/** The ET wall clock at an epoch-ms instant. */
export function etClock(epochMs: number): EtClock {
  const parts: Record<string, number> = {};
  for (const p of ET_FORMAT.formatToParts(new Date(epochMs))) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  const year = parts.year ?? Number.NaN;
  const month = parts.month ?? Number.NaN;
  const day = parts.day ?? Number.NaN;
  return {
    year,
    month,
    day,
    hour: (parts.hour ?? Number.NaN) % 24,
    minute: parts.minute ?? Number.NaN,
    second: parts.second ?? Number.NaN,
    isoWeekday: isoWeekdayOfDays(daysFromCivil(year, month, day)),
  };
}

/** Python's round() on a float: half to even. */
function roundHalfEven(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/**
 * The whole second Python's datetime.fromtimestamp(ts) lands on: it rounds the fraction to
 * microseconds (half to even) and carries into the next second, where JS Date would truncate.
 */
export function pythonWholeSecond(ts: number): number {
  const s = Math.floor(ts);
  return roundHalfEven((ts - s) * 1e6) >= 1_000_000 ? s + 1 : s;
}

/** Epoch seconds of an ET wall-clock time (for DST-gap times, the instant after the gap). */
export function etToEpochSec(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute) / 1000;
  const offsetAt = (t: number): number => {
    const c = etClock(t * 1000);
    return Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second) / 1000 - t;
  };
  let t = guess - offsetAt(guess);
  const second = guess - offsetAt(t);
  if (second !== t) t = second;
  return t;
}

// ---------------------------------------------------------------------------------------------

/** regime_at(ts): the calendar regime of a unix timestamp in SECONDS (fractions allowed). */
export function regimeAt(ts: number): CalendarRegime {
  const et = etClock(pythonWholeSecond(ts) * 1000);
  const d = daysFromCivil(et.year, et.month, et.day);
  const mins = et.hour * 60 + et.minute;
  const s = mins >= SESSION_ROLL_MIN ? d + 1 : d;

  let name: RegimeName;
  if (!isTradingDay(s)) {
    name = isoWeekdayOfDays(s) <= 5 ? "HOLIDAY" : "WEEKEND_DARK";
  } else {
    const close = EARLY_CLOSES.has(isoDateOfDays(s)) ? EARLY_CLOSE_MIN : REGULAR_CLOSE_MIN;
    if (d === s && OPEN_MIN <= mins && mins < close) name = "REGULAR";
    else if (
      d === s &&
      ((EXT_START_MIN <= mins && mins < OPEN_MIN) || (close <= mins && mins < SESSION_ROLL_MIN))
    )
      name = "EXTENDED";
    else name = "OVERNIGHT";
  }

  let kind: ReopenKind | null = null;
  if (isTradingDay(d) && WEEKDAY_OPEN_GUARD[0] <= mins && mins < WEEKDAY_OPEN_GUARD[1]) {
    kind = "weekday_open";
  } else if (
    WAKE_GUARD[0] <= mins &&
    mins < WAKE_GUARD[1] &&
    !isTradingDay(d) &&
    isTradingDay(d + 1)
  ) {
    kind = "wake";
  }

  return {
    name,
    reopenWindow: kind !== null,
    reopenKind: kind,
    how: (et.isoWeekday - 1) * 24 + et.hour,
    sessionDate: isoDateOfDays(s),
    et,
  };
}

/** [start, end) epoch seconds of the regular session of a trading day (09:30 → 16:00 or 13:00 ET). */
export function regularSessionBounds(sessionDate: string): { startSec: number; endSec: number } {
  const { year, month, day } = civilFromDays(daysOfIsoDate(sessionDate));
  const close = EARLY_CLOSES.has(sessionDate) ? EARLY_CLOSE_MIN : REGULAR_CLOSE_MIN;
  return {
    startSec: etToEpochSec(year, month, day, Math.floor(OPEN_MIN / 60), OPEN_MIN % 60),
    endSec: etToEpochSec(year, month, day, Math.floor(close / 60), close % 60),
  };
}

/** The most recent trading day whose regular session has fully closed at or before `nowSec`. */
export function lastCompletedRegularSession(nowSec: number): string {
  const et = etClock(pythonWholeSecond(nowSec) * 1000);
  let d = daysFromCivil(et.year, et.month, et.day);
  for (let i = 0; i < 15; i++, d--) {
    if (!isTradingDay(d)) continue;
    const iso = isoDateOfDays(d);
    if (regularSessionBounds(iso).endSec <= nowSec) return iso;
  }
  throw new Error(`no completed regular session in the 15 days before ${nowSec}`);
}
