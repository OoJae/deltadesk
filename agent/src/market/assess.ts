/**
 * Port of engine/api/app.py::assess, the "Safe to LP?" decision function. Must equal
 * test/fixtures/assess_cases.json (verdict and reason levels) on every case.
 *
 * The gap leg is CAUTION only and labelled unvalidated (the M1 gap rule failed out of sample);
 * the weekday 09:20–09:45 reopen is the one validated BLOCK.
 */

import type {
  AssessLevel,
  AssessReason,
  AssessResult,
  CalendarRegime,
  HourRecord,
  RegimeName,
} from "../types.js";

/** |ln(F/P)| above this (bp) is CAUTION. Unvalidated: never BLOCK on it. */
export const GAP_CAUTION_BPS: Readonly<Record<RegimeName, number>> = {
  REGULAR: 15,
  EXTENDED: 25,
  OVERNIGHT: 25,
  WEEKEND_DARK: 60,
  HOLIDAY: 60,
};

/** Chainlink stock feeds update on 50 bp moves or a ~24 h heartbeat: only > 26 h means dead. */
export const FEED_DEAD_S = 26 * 3600;

const ORDER: Readonly<Record<AssessLevel, number>> = { ALLOW: 0, CAUTION: 1, BLOCK: 2 };

const signed1 = (x: number): string => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;

export function assess(
  gapBps: number,
  regime: Pick<CalendarRegime, "name" | "reopenKind">,
  hour: HourRecord | null | undefined,
  chainlinkAgeS: number | null | undefined,
): AssessResult {
  const reasons: AssessReason[] = [];
  let verdict: AssessLevel = "ALLOW";
  const worsen = (level: AssessLevel, reason: string): void => {
    if (ORDER[level] > ORDER[verdict]) verdict = level;
    reasons.push({ level, reason });
  };

  const threshold = GAP_CAUTION_BPS[regime.name];
  if (Math.abs(gapBps) > threshold) {
    worsen(
      "CAUTION",
      `pool is ${signed1(gapBps)} bp from fair value (above ${threshold.toFixed(0)} bp in ${regime.name}); ` +
        "this threshold is unvalidated (the gap rule failed out of sample)",
    );
  }
  if (regime.reopenKind === "weekday_open") {
    worsen(
      "BLOCK",
      "first minutes after the cash open (09:20–09:45 ET): the one gate validated out of sample, LP edge < 1",
    );
  } else if (regime.reopenKind === "wake") {
    worsen(
      "CAUTION",
      "session reopening after a closure (19:50–20:15 ET): the wake print is unconfirmed (safety check, not an edge claim)",
    );
  }
  const closed = regime.name === "WEEKEND_DARK" || regime.name === "HOLIDAY";
  if (closed) {
    worsen(
      "CAUTION",
      "US market closed: fair value is Hyperliquid's internal price, Chainlink is frozen",
    );
  }
  // Toxic hour = informed flow took back more than the fees. edge is only defined when takers
  // gained (picked > 0); picked ≤ 0 means takers lost on average, which is good for LPs.
  // (Python truthiness: a missing or empty record is skipped.)
  const hasRecord = hour !== null && hour !== undefined && Object.keys(hour).length > 0;
  const edge = hour?.edge_1h;
  if (hasRecord && edge !== null && edge !== undefined && (hour.picked_1h_usd || 0) > 0) {
    if (edge < 0.5) {
      worsen(
        "BLOCK",
        `this hour of the week informed flow historically took ${(1 / edge).toFixed(1)}x what LPs earned in fees (edge ${edge.toFixed(2)})`,
      );
    } else if (edge < 1.0) {
      worsen(
        "CAUTION",
        `this hour of the week LPs historically lost money (edge ${edge.toFixed(2)})`,
      );
    }
  }
  if (
    chainlinkAgeS !== null &&
    chainlinkAgeS !== undefined &&
    !closed &&
    chainlinkAgeS > FEED_DEAD_S
  ) {
    worsen(
      "CAUTION",
      `Chainlink feed looks dead: no update for ${(chainlinkAgeS / 3600).toFixed(1)} h in an open session`,
    );
  }
  if (reasons.length === 0) {
    reasons.push({
      level: "ALLOW",
      reason: "pool is near fair value and this hour has a positive LP record",
    });
  }
  return { verdict, reasons };
}
