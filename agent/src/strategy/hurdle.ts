/**
 * Cost hurdle: a rerange must be worth at least `multiple` × its cost.
 *
 *   cost    = gas units × maxFeePerGas × ETH/USD                  (priority fee is 0 on Orbit)
 *   benefit = fee rate (USD per USD of active notional per hour) × active notional × 1 h
 *             × P(the current placement is out of range within the hour without a rerange)
 *
 * Every number returned is finite (plans are canonical JSON, which rejects NaN and ±∞). Invalid or
 * missing inputs never pass.
 */

import type { HourRecord, HurdleFn, HurdleInput, HurdleResult } from "../types.js";
import { gasCostUsd } from "../units.js";

export type { HurdleFn, HurdleInput, HurdleResult } from "../types.js";

const finiteNonNegative = (x: number): boolean => Number.isFinite(x) && x >= 0;

export const costHurdle = ((input: HurdleInput): HurdleResult => {
  const problems: string[] = [];
  if (input.gasUnits <= 0n) problems.push("gas units must be > 0");
  if (input.maxFeePerGas <= 0n) problems.push("maxFeePerGas must be > 0");
  if (!(Number.isFinite(input.ethUsd) && input.ethUsd > 0)) problems.push("ETH/USD must be > 0");
  if (!finiteNonNegative(input.feeRatePerHour)) problems.push("fee rate must be finite and ≥ 0");
  if (!finiteNonNegative(input.activeNotionalUsd)) problems.push("notional must be finite and ≥ 0");
  if (!(Number.isFinite(input.pOutOfRange) && input.pOutOfRange >= 0 && input.pOutOfRange <= 1)) {
    problems.push("P(out of range) must be in [0, 1]");
  }
  if (!(Number.isFinite(input.multiple) && input.multiple > 0))
    problems.push("multiple must be > 0");
  if (problems.length > 0) {
    return { costUsd: 0, benefitUsd: 0, multiple: 0, passes: false, detail: problems.join("; ") };
  }

  const costUsd = gasCostUsd(input.gasUnits, input.maxFeePerGas, input.ethUsd);
  const benefitUsd = input.feeRatePerHour * input.activeNotionalUsd * input.pOutOfRange;
  if (!(Number.isFinite(costUsd) && costUsd > 0) || !Number.isFinite(benefitUsd)) {
    return {
      costUsd: 0,
      benefitUsd: 0,
      multiple: 0,
      passes: false,
      detail: "cost or benefit not finite",
    };
  }
  const achieved = benefitUsd / costUsd;
  const passes = benefitUsd >= input.multiple * costUsd;
  return {
    costUsd,
    benefitUsd,
    multiple: achieved,
    passes,
    detail:
      `benefit $${benefitUsd.toFixed(4)} (fee rate ${(input.feeRatePerHour * 1e4).toFixed(3)} bp/h × $${input.activeNotionalUsd.toFixed(2)} × P(out) ${input.pOutOfRange.toFixed(3)}) ` +
      `${passes ? "≥" : "<"} ${input.multiple}× cost $${costUsd.toFixed(4)} (achieved ${achieved.toFixed(2)}×)`,
  };
}) satisfies HurdleFn;

/** Standard normal CDF (Abramowitz–Stegun 7.1.26 erf, |error| < 1.5e-7). */
export function normalCdf(x: number): number {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const poly =
    t *
    (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-z * z);
  return x >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/**
 * P(a driftless random walk with σ ticks per √hour travels `distanceTicks` to the nearer range edge
 * within `hours`): the reflection principle, 2 · (1 − Φ(d / (σ√h))). Already outside → 1.
 */
export function pOutOfRangeWithin(
  distanceTicks: number,
  sigmaTicksPerHour: number,
  hours = 1,
): number {
  if (!Number.isFinite(distanceTicks) || distanceTicks <= 0) return 1;
  if (!(sigmaTicksPerHour > 0) || !(hours > 0)) return 0;
  const p = 2 * (1 - normalCdf(distanceTicks / (sigmaTicksPerHour * Math.sqrt(hours))));
  return Math.min(1, Math.max(0, p));
}

/**
 * Fee rate per USD of in-range notional per hour, from the engine's hour-of-week record.
 * `fees_usd` is the pool's total for that hour of the week over the whole study sample, so it is
 * divided by the sample length in weeks. An LP's share of the pool's fees is L_ours / L_active, and
 * its notional is L_ours × (value per unit L over its range), so the rate is independent of size:
 *   rate = pool fees per hour / value of the pool's active liquidity spread over our range.
 * Null when the record or the liquidity value is missing (the hurdle then fails closed).
 */
export function feeRatePerHour(
  record: HourRecord | null,
  activeLiquidityUsd: number,
  sampleWeeks: number,
): number | null {
  const fees = record?.fees_usd;
  if (fees === null || fees === undefined || !Number.isFinite(fees) || fees < 0) return null;
  if (!(Number.isFinite(activeLiquidityUsd) && activeLiquidityUsd > 0)) return null;
  if (!(Number.isFinite(sampleWeeks) && sampleWeeks > 0)) return null;
  return fees / sampleWeeks / activeLiquidityUsd;
}
