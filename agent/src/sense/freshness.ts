/**
 * Freshness: map each source's SourceStatus to FRESH, STALE or UNAVAILABLE for the current regime.
 *
 * A source whose last read failed is never FRESH: its last good datum can be STALE at best. A
 * source that has never produced a datum (ageMs null) is UNAVAILABLE. Thresholds are wider while
 * the market is closed (weekend / holiday), when references legitimately slow down; that never
 * matters for risk-adding, which the CLOSED gate already blocks then.
 *
 * Ages: chain = since the last successful block-pinned read; hl = since the last quote was
 * received; rh = since the last /prices answer (the halt flag is as current as the answer); k =
 * since the basis was fetched or computed; corpActions = since the hourly fetch.
 */

import type {
  Freshness,
  FreshnessFn,
  FreshnessMap,
  RegimeName,
  SourceName,
  SourceStatus,
} from "../types.js";

export interface FreshnessWindow {
  /** Age at or below which a healthy source is FRESH. */
  freshMs: number;
  /** Age at or below which a source is at least STALE (above it: UNAVAILABLE). */
  staleMs: number;
}

export type FreshnessThresholds = Record<
  SourceName,
  { open: FreshnessWindow; closed: FreshnessWindow }
>;

const MIN = 60_000;
const HOUR = 60 * MIN;

export const FRESHNESS_THRESHOLDS: FreshnessThresholds = {
  chain: { open: { freshMs: 15_000, staleMs: MIN }, closed: { freshMs: 15_000, staleMs: MIN } },
  hl: { open: { freshMs: 10_000, staleMs: MIN }, closed: { freshMs: 30_000, staleMs: 5 * MIN } },
  rh: { open: { freshMs: 15_000, staleMs: MIN }, closed: { freshMs: 2 * MIN, staleMs: 15 * MIN } },
  k: {
    open: { freshMs: 6 * HOUR, staleMs: 96 * HOUR },
    closed: { freshMs: 6 * HOUR, staleMs: 96 * HOUR },
  },
  corpActions: {
    open: { freshMs: 2 * HOUR, staleMs: 6 * HOUR },
    closed: { freshMs: 2 * HOUR, staleMs: 6 * HOUR },
  },
};

/** Clock skew tolerated before a datum "from the future" is treated as unusable. */
const MAX_NEGATIVE_AGE_MS = 5_000;

export function isMarketClosed(regime: RegimeName): boolean {
  return regime === "WEEKEND_DARK" || regime === "HOLIDAY";
}

export function classifySource(status: SourceStatus, window: FreshnessWindow): Freshness {
  const age = status.ageMs;
  if (age === null || !Number.isFinite(age) || age < -MAX_NEGATIVE_AGE_MS) return "UNAVAILABLE";
  const a = Math.max(0, age);
  if (a > window.staleMs) return "UNAVAILABLE";
  if (!status.ok) return "STALE";
  return a <= window.freshMs ? "FRESH" : "STALE";
}

export function createFreshness(
  thresholds: FreshnessThresholds = FRESHNESS_THRESHOLDS,
): FreshnessFn {
  return (sources, regime) => {
    const side = isMarketClosed(regime) ? "closed" : "open";
    const out = {} as FreshnessMap;
    for (const name of Object.keys(thresholds) as SourceName[]) {
      const status = sources[name] ?? { ok: false, ageMs: null, reason: "missing" };
      out[name] = classifySource(status, thresholds[name][side]);
    }
    return out;
  };
}

export const freshness: FreshnessFn = createFreshness();
