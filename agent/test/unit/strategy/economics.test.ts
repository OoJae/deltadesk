/**
 * Economics truth: the cost hurdle with the engine's REAL hour-of-week record at M2 size (~$50).
 *
 * test/fixtures/nvda_hour_records.json is the engine's hour_record() output for NVDA/USDG, all 168
 * hours of the week (data/study/m1/hl_ref/by_how.parquet: the pool's fees per hour-of-week bucket,
 * summed over the ~8.5-week M1 sample; the record GET /safe-to-lp serves as `current_hour`). The
 * fork kit fakes that record with fees_usd = 5e8 so its reranges always clear the hurdle; this
 * suite shows what the real one does. Chain inputs are the live 4663 figures measured for
 * agent/README.md "Economics at M2 size" (2026-09-19 13:19 UTC, block 67,112,851): base fee
 * 0.061824 gwei, no L1 component (NodeInterface gasEstimateL1Component = 0), ETH/USD 2,639.89
 * (Chainlink), pool liquidity 27.71e18 (≈ $4.11 M of active liquidity over the placement's 200-tick
 * span, the one the hurdle divides by; the held 210-tick position below spans ≈ $4.3 M). The
 * hurdle prices a rerange at STRATEGY_DEFAULTS.rerangeGasUnits (1.2 M) × 2 × base fee; the fork
 * measured ~654 k gas for a typical one (the README has both).
 *
 * What it demonstrates (the hurdle rule and its defaults are unchanged):
 *   - the initial mint, whose hurdle is waived, is planned and passes the guard, although the
 *     hurdle computed for it fails at every hour of the week;
 *   - every later rerange of a ~$50 lane is refused by the hurdle, at every hour of the week, both
 *     when the pool leaves the inner band and when a position is out of range;
 *   - property: a rerange is planned exactly when benefit ≥ 2 × cost, and those numbers are the
 *     independent recomputation cost = gas units × 2 × base fee × ETH/USD, benefit = fee rate ×
 *     notional × P(out of range);
 *   - the break-even notionals (a typical rerange clears 2x) are far above the $60 cap.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { STRATEGY_DEFAULTS } from "../../../src/config.js";
import { checkGuard } from "../../../src/guard/guard.js";
import { poolMidFromSqrt } from "../../../src/market/fair-value.js";
import { mockSnapshot } from "../../../src/sense/mock.js";
import { pOutOfRangeWithin } from "../../../src/strategy/hurdle.js";
import {
  activeLiquidityUsd,
  createLaneStrategy,
  type LanePlan,
} from "../../../src/strategy/lanes.js";
import type { DeskAction, DeskSnapshot, HourRecord } from "../../../src/types.js";
import { getSqrtRatioAtTick } from "../../../src/units.js";
import records from "../../fixtures/nvda_hour_records.json" with { type: "json" };
import { buildStep, FRESH_AGENT, laneState, normalRegime } from "../guard/fixture.js";

/** Live 4663 inputs (README "Economics at M2 size"). */
const LIVE = {
  baseFeeWei: 61_824_000n,
  ethUsd: 2_639.89,
  poolLiquidity: 27_711_028_099_174_812_542n,
};
const HOURS: HourRecord[] = records.records.map((r) => ({
  fees_usd: r.fees_usd,
  swaps: r.swaps,
  edge_1h: r.edge_1h,
}));
const WEEKS = 9; // the strategy's default hourRecordWeeks (the sample is 8.49 weeks: conservative)
const sortedFees = HOURS.map((h) => h.fees_usd ?? 0).sort((a, b) => a - b);
const MEDIAN_HOUR: HourRecord = { fees_usd: sortedFees[84] as number };
const BEST_HOUR: HourRecord = { fees_usd: sortedFees.at(-1) as number };

/** The live chain inputs on the mock lane A snapshot (≈ $25 USDG + ≈ $25 NVDA, empty lane). */
function live(snapshot: DeskSnapshot): DeskSnapshot {
  const chain = snapshot.chain;
  if (chain === null) throw new Error("chain");
  chain.baseFeePerGas = LIVE.baseFeeWei;
  chain.pool.liquidity = LIVE.poolLiquidity;
  return { ...snapshot, ethUsd: LIVE.ethUsd };
}

/** A lane holding one ~$50 position [tl, tu) with the pool at `tick` and F at the pool. */
function holding(tl: number, tu: number, tick: number): DeskSnapshot {
  const sqrt = getSqrtRatioAtTick(tick) + 1n;
  const mid = poolMidFromSqrt(sqrt);
  const s = mockSnapshot({ tick, sqrtPriceX96: sqrt, hlMid: mid, nvdaUsd: mid });
  if (s.chain === null) throw new Error("chain");
  s.chain.lane.positions = [42n, 0n];
  s.chain.lane.positionDetails = [
    {
      tokenId: 42n,
      tickLower: tl,
      tickUpper: tu,
      liquidity: 10n ** 12n,
      tokensOwed0: 0n,
      tokensOwed1: 0n,
      feeGrowthInside0LastX128: 0n,
      feeGrowthInside1LastX128: 0n,
    },
    null,
  ];
  // Post-unwind balances ≈ $25 + $25 (what the rerange redeploys).
  s.chain.lane.balances = { token0: 25_000_000n, token1: BigInt(Math.round((25 / mid) * 1e18)) };
  return live(s);
}

function plan(snapshot: DeskSnapshot, hourRecord: HourRecord, outsideInnerTicks = 0): LanePlan {
  const regime = normalRegime(snapshot);
  return createLaneStrategy({ maxActionCents: 6_000 }).plan({
    lane: "A",
    snapshot,
    regime,
    laneState: laneState(snapshot, regime, { outsideInnerTicks }),
    params: STRATEGY_DEFAULTS,
    agentRerange: FRESH_AGENT,
    hourRecord,
    gasQuote: null,
    nowMs: snapshot.takenAtMs,
    random: () => 0,
  });
}

const kinds = (actions: DeskAction[]) => actions.map((a) => a.kind);
/** The hurdle's cost, recomputed: gas units × maxFee (2 × base fee) × ETH/USD. */
const hurdleCostUsd = (baseFeeWei: bigint, ethUsd = LIVE.ethUsd) =>
  (Number(STRATEGY_DEFAULTS.rerangeGasUnits * 2n * baseFeeWei) / 1e18) * ethUsd;
// The position [222160, 222370) (inner 60 %: [222202, 222328]). A typical rerange: the pool has
// just left the inner band, 40 ticks from the edge (P(out within 1 h) ≈ 0.505 at σ 60 ticks/√h).
const TL = 222_160;
const TU = 222_370;
const OUTSIDE_INNER_TICK = 222_330;

describe("economics at M2 size: the engine's real hour-of-week record", () => {
  it("the fixture is the engine's full week (168 hours, ~8.5 weeks of NVDA/USDG fees)", () => {
    expect(HOURS).toHaveLength(168);
    expect(records.sample.weeks).toBeGreaterThan(8);
    expect(records.sample.weeks).toBeLessThan(9);
    expect(MEDIAN_HOUR.fees_usd).toBeGreaterThan(1_000);
    expect(BEST_HOUR.fees_usd).toBeGreaterThan(10_000);
  });

  it("the initial mint (hurdle waived) is planned and passes the guard at every hour of the week", () => {
    for (const hour of HOURS) {
      const snapshot = live(mockSnapshot({ hlMid: 222.6 }));
      const p = plan(snapshot, hour);
      expect(p.trigger).toBe("initial_mint");
      expect(kinds(p.actions)).toEqual(["rerange"]);
      expect(p.notionalCents).toBeGreaterThan(4_900);
      expect(p.notionalCents).toBeLessThanOrEqual(5_880);
      expect(p.hurdle?.passes).toBe(false); // it would never clear 2x on its own
      expect(p.rationale.join(" ")).toMatch(/cost hurdle waived for the initial mint/);
    }
    // …and the guard lets it execute (its cost-hurdle rule waives an empty lane's first mint).
    const snapshot = live(mockSnapshot({ hlMid: 222.6 }));
    const regime = normalRegime(snapshot);
    const p = plan(snapshot, MEDIAN_HOUR);
    const { input } = buildStep(snapshot, regime, p, p.actions[0] as DeskAction);
    const verdict = checkGuard(input);
    expect(verdict.violations).toEqual([]);
    expect(verdict.decision).toBe("execute");
    expect(verdict.checks.find((c) => c.rule === "cost-hurdle")?.detail).toMatch(
      /waived for the initial mint/,
    );
  });

  it("every later rerange of a ~$50 lane is refused by the hurdle, at every hour of the week", () => {
    let best = 0;
    for (const hour of HOURS) {
      const inner = plan(holding(TL, TU, OUTSIDE_INNER_TICK), hour, 1);
      expect(inner.trigger).toBe("outside_inner");
      expect(kinds(inner.actions)).toEqual(["hold"]);
      expect(inner.rationale.at(-1)).toMatch(/^cost hurdle: benefit \$[\d.]+ .* < 2× cost/);
      const out = plan(holding(TL, TU, TU + 30), hour);
      expect(out.trigger).toBe("out_of_range");
      expect(kinds(out.actions)).toEqual(["hold"]);
      expect(out.hurdle?.passes).toBe(false);
      best = Math.max(best, out.hurdle?.multiple ?? 0);
    }
    // Even the best hour of the week, with P(out of range) = 1, earns a small fraction of 2x.
    expect(best).toBeLessThan(0.1);
  });

  it("the guard refuses such a rerange too, if a plan ever carried one", () => {
    const snapshot = holding(TL, TU, OUTSIDE_INNER_TICK);
    const regime = normalRegime(snapshot);
    const rich = plan(snapshot, { fees_usd: 1e9 }, 1); // plans the rerange…
    expect(kinds(rich.actions)).toEqual(["rerange"]);
    const real = plan(snapshot, BEST_HOUR, 1); // …whose real hurdle fails
    const forced = { ...rich, hurdle: real.hurdle };
    const { input } = buildStep(snapshot, regime, forced, forced.actions[0] as DeskAction);
    const verdict = checkGuard(input);
    expect(verdict.decision).toBe("blocked");
    expect(verdict.violations.map((v) => v.rule)).toContain("cost-hurdle");
  });

  it("property: a rerange is planned exactly when benefit ≥ 2 × cost (independently recomputed)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 167 }),
        // A fee scale up to 400x crosses the threshold from both sides.
        fc.double({ min: 0.1, max: 400, noNaN: true }),
        fc.bigInt({ min: 20_000_000n, max: 200_000_000n }), // base fee 0.02–0.2 gwei
        fc.boolean(),
        (how, scale, baseFee, outOfRange) => {
          const fees = (HOURS[how]?.fees_usd ?? 0) * scale;
          const snapshot = holding(TL, TU, outOfRange ? TU + 30 : OUTSIDE_INNER_TICK);
          if (snapshot.chain === null) return false;
          snapshot.chain.baseFeePerGas = baseFee;
          const streak = outOfRange ? 0 : 1;
          const p = plan(snapshot, { fees_usd: fees }, streak);
          // The same placement and size, planned with a fee record rich enough to clear any hurdle.
          const probe = plan(snapshot, { fees_usd: 1e12 }, streak);
          const r = probe.actions[0];
          if (p.hurdle === null || r?.kind !== "rerange") return false;
          const liq = activeLiquidityUsd(snapshot.chain, {
            tickLower: Math.min(...r.ranges.map((x) => x.tickLower)),
            tickUpper: Math.max(...r.ranges.map((x) => x.tickUpper)),
          });
          if (liq === null) return false;
          const pOut = outOfRange ? 1 : pOutOfRangeWithin(TU - OUTSIDE_INNER_TICK, 60);
          const cost = hurdleCostUsd(baseFee);
          const benefit = (fees / WEEKS / liq) * (probe.notionalCents / 100) * pOut;
          expect(p.hurdle.costUsd).toBeCloseTo(cost, 9);
          expect(p.hurdle.benefitUsd).toBeCloseTo(benefit, 9);
          const clears = benefit >= 2 * cost;
          expect(p.hurdle.passes).toBe(clears);
          expect(kinds(p.actions)).toEqual([clears ? "rerange" : "hold"]);
          return true;
        },
      ),
      { numRuns: 300, seed: 4663 },
    );
  });

  it("break-even: the lane size at which a typical rerange clears 2x is far above the $60 cap", () => {
    // The fee rate per $ of notional per hour, from the strategy's own hurdle at the median hour.
    const probe = plan(holding(TL, TU, OUTSIDE_INNER_TICK), { fees_usd: 1e12 }, 1);
    const p = plan(holding(TL, TU, OUTSIDE_INNER_TICK), MEDIAN_HOUR, 1);
    const notional = probe.notionalCents / 100;
    const pOutTypical = pOutOfRangeWithin(TU - OUTSIDE_INNER_TICK, 60);
    const medianRate = (p.hurdle?.benefitUsd ?? 0) / notional / pOutTypical;
    const bestRate = medianRate * ((BEST_HOUR.fees_usd ?? 0) / (MEDIAN_HOUR.fees_usd ?? 1));
    const cost = hurdleCostUsd(LIVE.baseFeeWei);
    const breakEven = (rate: number, pOut: number) => (2 * cost) / (rate * pOut);
    // The README's figures (rounded there), recomputed from the fixture and the live inputs.
    expect(cost).toBeCloseTo(0.3917, 4);
    expect(pOutTypical).toBeCloseTo(0.505, 3);
    expect(medianRate * 1e4).toBeCloseTo(0.42, 1); // ≈ 0.42 bp of notional per hour
    expect(bestRate * 1e4).toBeCloseTo(3.59, 1); // ≈ 3.59 bp at the best hour of the week
    expect(breakEven(medianRate, pOutTypical)).toBeGreaterThan(30_000); // README: ≈ $36.7 k
    expect(breakEven(bestRate, pOutTypical)).toBeGreaterThan(4_000); // README: ≈ $4.3 k
    expect(breakEven(bestRate, 1)).toBeGreaterThan(2_000); // README: ≈ $2.2 k
    for (const n of [breakEven(medianRate, pOutTypical), breakEven(bestRate, 1)])
      expect(n).toBeGreaterThan(60 * 30); // 30x the $60 per-rerange cap and more
  });
});
