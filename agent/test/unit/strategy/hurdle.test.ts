import { describe, expect, it } from "vitest";
import { gapShadow } from "../../../src/strategy/gap.js";
import {
  costHurdle,
  feeRatePerHour,
  normalCdf,
  pOutOfRangeWithin,
} from "../../../src/strategy/hurdle.js";

const input = {
  gasUnits: 1_000_000n,
  maxFeePerGas: 100_000_000n, // 0.1 gwei → 1e14 wei = 1e-4 ETH
  ethUsd: 2_500, // cost $0.25
  feeRatePerHour: 0.001,
  activeNotionalUsd: 1_000,
  pOutOfRange: 1,
  multiple: 2,
};

describe("cost hurdle", () => {
  it("benefit = fee rate × notional × P(out); passes at ≥ multiple × gas cost", () => {
    const r = costHurdle(input); // benefit $1 vs cost $0.25
    expect(r.costUsd).toBeCloseTo(0.25, 12);
    expect(r.benefitUsd).toBeCloseTo(1, 12);
    expect(r.multiple).toBeCloseTo(4, 9);
    expect(r.passes).toBe(true);
    expect(costHurdle({ ...input, pOutOfRange: 0.51 }).passes).toBe(true);
    expect(costHurdle({ ...input, pOutOfRange: 0.49 }).passes).toBe(false);
  });

  it("never passes on invalid input, and every number stays finite (plans are canonical JSON)", () => {
    for (const bad of [
      { ...input, gasUnits: 0n },
      { ...input, maxFeePerGas: 0n },
      { ...input, ethUsd: 0 },
      { ...input, ethUsd: Number.NaN },
      { ...input, feeRatePerHour: Number.POSITIVE_INFINITY },
      { ...input, activeNotionalUsd: -1 },
      { ...input, pOutOfRange: 1.5 },
      { ...input, multiple: 0 },
    ]) {
      const r = costHurdle(bad);
      expect(r.passes).toBe(false);
      expect([r.costUsd, r.benefitUsd, r.multiple].every(Number.isFinite)).toBe(true);
    }
  });

  it("the ~$50 live mint does not clear a 1 h hurdle (why the initial mint is waived)", () => {
    // live pool 2026-09-19: ~$4.2M of active liquidity over ±100 ticks, ~$685/h of fees at the best hour
    const rate = feeRatePerHour({ fees_usd: 6_164 }, 4_238_256, 9);
    expect(rate).not.toBeNull();
    const r = costHurdle({
      gasUnits: 1_200_000n,
      maxFeePerGas: 132_800_000n,
      ethUsd: 2_630,
      feeRatePerHour: rate ?? 0,
      activeNotionalUsd: 50,
      pOutOfRange: 1,
      multiple: 2,
    });
    expect(r.passes).toBe(false);
    expect(r.multiple).toBeLessThan(0.05);
  });
});

describe("P(out of range) and the fee rate", () => {
  it("normalCdf is accurate", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 7);
    expect(normalCdf(1.959964)).toBeCloseTo(0.975, 6);
    expect(normalCdf(-1)).toBeCloseTo(0.158655, 6);
  });

  it("reflection principle: 1 at the edge, falling with distance, 0 without volatility", () => {
    expect(pOutOfRangeWithin(0, 60)).toBe(1);
    expect(pOutOfRangeWithin(-5, 60)).toBe(1);
    expect(pOutOfRangeWithin(60, 60)).toBeCloseTo(2 * (1 - normalCdf(1)), 9);
    expect(pOutOfRangeWithin(30, 60)).toBeGreaterThan(pOutOfRangeWithin(90, 60));
    expect(pOutOfRangeWithin(30, 0)).toBe(0);
  });

  it("fee rate = weekly-bucket fees / weeks / value of active liquidity; null when unknown", () => {
    expect(feeRatePerHour({ fees_usd: 900 }, 1_000_000, 9)).toBeCloseTo(1e-4, 12);
    expect(feeRatePerHour(null, 1_000_000, 9)).toBeNull();
    expect(feeRatePerHour({ fees_usd: null }, 1_000_000, 9)).toBeNull();
    expect(feeRatePerHour({ fees_usd: 900 }, 0, 9)).toBeNull();
    expect(feeRatePerHour({ fees_usd: 900 }, Number.NaN, 9)).toBeNull();
  });
});

describe("gap rule (shadow)", () => {
  it("is always shadow; would act above the regime threshold", () => {
    expect(gapShadow({ gapBps: 20, regime: "REGULAR", nowMs: 0 })).toMatchObject({
      wouldAct: true,
      mode: "shadow",
      thresholdBps: 15,
    });
    expect(gapShadow({ gapBps: -20, regime: "OVERNIGHT", nowMs: 0 })).toMatchObject({
      wouldAct: false,
      thresholdBps: 25,
    });
    expect(gapShadow({ gapBps: Number.NaN, regime: "REGULAR", nowMs: 0 }).wouldAct).toBe(false);
  });
});
