import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { critiquePlan } from "../../src/agents/plan-critic.js";
import { STRATEGY_DEFAULTS } from "../../src/config.js";
import {
  fencePrices,
  notionalUsd6,
  postUnwindBalances,
  rerangeUpperAmounts,
} from "../../src/guard/risk.js";
import { poolMidFromSqrt } from "../../src/market/fair-value.js";
import { mockSnapshot } from "../../src/sense/mock.js";
import { fenceAllowsAcross, rangeNeeds, shapeOk } from "../../src/strategy/bands.js";
import { createLaneStrategy } from "../../src/strategy/lanes.js";
import type { DeskAction } from "../../src/types.js";
import { getSqrtRatioAtTick, usd6ToCentsCeil } from "../../src/units.js";
import { FRESH_AGENT, laneState, NOW_MS, normalRegime } from "../unit/guard/fixture.js";

const scenario = fc.record({
  dTick: fc.integer({ min: -400, max: 400 }),
  gapBps: fc.double({ min: -200, max: 200, noNaN: true }),
  refBps: fc.double({ min: -200, max: 200, noNaN: true }),
  band: fc.integer({ min: 0, max: 300 }),
  capDelta: fc.integer({ min: 0, max: 60 }),
  bal0: fc.bigInt({ min: 0n, max: 10_000n * 10n ** 6n }),
  bal1: fc.bigInt({ min: 0n, max: 50n * 10n ** 18n }),
  maxDeploy: fc.bigInt({ min: 1_000_000n, max: 5_000_000_000n }),
  maxActionCents: fc.integer({ min: 100, max: 100_000 }),
  minWidth: fc.constantFrom(2, 20, 100),
  maxWidth: fc.constantFrom(200, 2_000, 20_000),
});

describe("strategy properties", () => {
  it("every rerange is aligned, inside the fence across the execution window, inside balances and caps, and the critic approves it", () => {
    let reranges = 0;
    fc.assert(
      fc.property(scenario, (sc) => {
        const tick = 222_275 + sc.dTick;
        const sqrt = getSqrtRatioAtTick(tick) + 1n;
        const mid = poolMidFromSqrt(sqrt);
        const snapshot = mockSnapshot({
          nowMs: NOW_MS,
          tick,
          sqrtPriceX96: sqrt,
          hlMid: mid * Math.exp(sc.gapBps / 1e4),
          nvdaUsd: mid * Math.exp(sc.refBps / 1e4),
          balances: { token0: sc.bal0, token1: sc.bal1 },
        });
        const chain = snapshot.chain;
        if (chain === null) throw new Error("chain");
        chain.lane.refTick = { ...chain.lane.refTick, bandTicks: sc.band };
        chain.lane.caps = {
          ...chain.lane.caps,
          maxTickDelta: sc.capDelta,
          maxDeployUsd6: sc.maxDeploy,
          minWidthTicks: sc.minWidth,
          maxWidthTicks: sc.maxWidth,
        };
        const regime = normalRegime(snapshot);
        const plan = createLaneStrategy({ maxActionCents: sc.maxActionCents }).plan({
          lane: "A",
          snapshot,
          regime,
          laneState: laneState(snapshot, regime),
          params: STRATEGY_DEFAULTS,
          agentRerange: FRESH_AGENT,
          hourRecord: { fees_usd: 6_164 },
          gasQuote: null,
          nowMs: NOW_MS,
          random: () => 0,
        });
        const rr = plan.actions.find(
          (a): a is Extract<DeskAction, { kind: "rerange" }> => a.kind === "rerange",
        );
        if (rr === undefined) {
          expect(plan.actions.map((a) => a.kind)).toEqual(["hold"]);
          return;
        }
        reranges++;
        const ref = chain.lane.refTick.tick;
        const delta = rr.maxTickDelta;
        expect(delta).toBeLessThanOrEqual(Math.min(STRATEGY_DEFAULTS.maxTickDelta, sc.capDelta));
        expect(rr.expectedTick).toBe(tick);
        const balances = postUnwindBalances(chain);
        let s0 = 0;
        let s1 = 0;
        for (const r of rr.ranges) {
          expect(shapeOk(r, 10, sc.minWidth, sc.maxWidth)).toBe(true);
          expect(fenceAllowsAcross(r, tick, delta, ref, sc.band)).toBe(true);
          s0 += r.share0Bps;
          s1 += r.share1Bps;
          // single-sided ranges never sit between the pool and F
          const fTick = plan.metrics.fTick ?? 0;
          const needs = rangeNeeds(r, tick);
          if (needs.token1 && !needs.token0) expect(r.tickUpper).toBeLessThanOrEqual(fTick);
          if (needs.token0 && !needs.token1) expect(r.tickLower).toBeGreaterThanOrEqual(fTick);
        }
        expect(s0).toBeLessThanOrEqual(10_000);
        expect(s1).toBeLessThanOrEqual(10_000);
        if (s0 > 0) expect(balances.balance0 > 0n).toBe(true);
        if (s1 > 0) expect(balances.balance1 > 0n).toBe(true);
        const prices = fencePrices(chain);
        if (prices === null) throw new Error("prices");
        const usd6 = notionalUsd6(rerangeUpperAmounts(rr.ranges, balances), prices);
        expect(usd6 <= sc.maxDeploy).toBe(true);
        expect(usd6ToCentsCeil(usd6)).toBeLessThanOrEqual(sc.maxActionCents);
        expect(plan.notionalCents).toBe(usd6ToCentsCeil(usd6));
        const verdict = critiquePlan({
          snapshot,
          regime,
          plan,
          params: STRATEGY_DEFAULTS,
          nowMs: NOW_MS,
        });
        expect(verdict.reason).toContain("consistent");
      }),
      { numRuns: 1_000 },
    );
    expect(reranges).toBeGreaterThan(100); // the property is not vacuous
  });
});
