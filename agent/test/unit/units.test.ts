import { describe, expect, it } from "vitest";
import {
  bpsToTicksCeil,
  ceilToSpacing,
  divRoundingUp,
  floorToSpacing,
  formatUnits,
  gasCostUsd,
  getAmount0Delta,
  getAmount1Delta,
  getAmountsForLiquidity,
  getLiquidityForAmounts,
  getSqrtRatioAtTick,
  getTickAtSqrtRatio,
  isAligned,
  MAX_SQRT_RATIO,
  MAX_TICK,
  MIN_SQRT_RATIO,
  MIN_TICK,
  mulDiv,
  mulDivRoundingUp,
  parseUnits,
  priceToSqrtPriceX96,
  priceToTick,
  Q96,
  snapRangeOutward,
  sqrtPriceX96ToPrice,
  tickToPrice,
  usd6ToCentsCeil,
  usd6ToCentsFloor,
  usdToCents,
  valueUsd6,
} from "../../src/units.js";

/** Live NVDA/USDG slot0 read on 2026-09-19 (read-only cast call). */
const LIVE = { sqrtPriceX96: 5312783984510461862243962879021140n, tick: 222277 };

describe("TickMath", () => {
  it("matches the canonical boundary values", () => {
    expect(getSqrtRatioAtTick(MIN_TICK)).toBe(MIN_SQRT_RATIO);
    expect(getSqrtRatioAtTick(MAX_TICK)).toBe(MAX_SQRT_RATIO);
    expect(getSqrtRatioAtTick(0)).toBe(Q96);
    expect(getTickAtSqrtRatio(MIN_SQRT_RATIO)).toBe(MIN_TICK);
    expect(getTickAtSqrtRatio(MAX_SQRT_RATIO - 1n)).toBe(MAX_TICK - 1);
    expect(getTickAtSqrtRatio(Q96)).toBe(0);
  });

  it("matches known Uniswap values", () => {
    // From the v3-core TickMath test suite.
    expect(getSqrtRatioAtTick(50)).toBe(79426470787362580746886972461n);
    expect(getSqrtRatioAtTick(-50)).toBe(79030349367926598376800521322n);
    expect(getSqrtRatioAtTick(100)).toBe(79625275426524748796330556128n);
  });

  it("agrees with the float formula at every bit of the tick", () => {
    for (let bit = 0; bit < 20; bit++) {
      for (const sign of [1, -1]) {
        const tick = sign * (1 << bit);
        if (tick < MIN_TICK || tick > MAX_TICK) continue;
        const exact = Number(getSqrtRatioAtTick(tick)) / 2 ** 96;
        const float = Math.sqrt(1.0001 ** tick);
        expect(Math.abs(exact / float - 1)).toBeLessThan(1e-9);
      }
    }
  });

  it("reproduces the live pool's tick from its sqrt price", () => {
    expect(getTickAtSqrtRatio(LIVE.sqrtPriceX96)).toBe(LIVE.tick);
    expect(getSqrtRatioAtTick(LIVE.tick)).toBeLessThanOrEqual(LIVE.sqrtPriceX96);
    expect(getSqrtRatioAtTick(LIVE.tick + 1)).toBeGreaterThan(LIVE.sqrtPriceX96);
  });

  it("rejects out-of-range input", () => {
    expect(() => getSqrtRatioAtTick(MAX_TICK + 1)).toThrow(RangeError);
    expect(() => getSqrtRatioAtTick(1.5)).toThrow(RangeError);
    expect(() => getTickAtSqrtRatio(MIN_SQRT_RATIO - 1n)).toThrow(RangeError);
    expect(() => getTickAtSqrtRatio(MAX_SQRT_RATIO)).toThrow(RangeError);
  });
});

describe("prices for the 6/18 orientation (USDG token0, NVDA token1)", () => {
  it("prices the live pool at about $222 per NVDA", () => {
    const mid = sqrtPriceX96ToPrice(LIVE.sqrtPriceX96);
    expect(mid).toBeGreaterThan(200);
    expect(mid).toBeLessThan(250);
    expect(Math.abs(tickToPrice(LIVE.tick) / mid - 1)).toBeLessThan(1e-4);
  });

  it("a higher NVDA price is a lower tick", () => {
    expect(priceToTick(250)).toBeLessThan(priceToTick(200));
  });

  it("round-trips price and tick", () => {
    for (const p of [0.5, 1, 99.99, 222.39, 1_000, 12_345.6]) {
      const t = priceToTick(p);
      // p lies within one tick of tickToPrice(t) (in the right direction: raw P = 1/p grows with t)
      expect(tickToPrice(t + 1)).toBeLessThan(p * (1 + 1e-12));
      expect(tickToPrice(t)).toBeGreaterThanOrEqual(p * (1 - 1e-12));
    }
    expect(priceToTick(sqrtPriceX96ToPrice(LIVE.sqrtPriceX96))).toBe(LIVE.tick);
    const back = sqrtPriceX96ToPrice(priceToSqrtPriceX96(222.39));
    expect(Math.abs(back / 222.39 - 1)).toBeLessThan(1e-9);
  });
});

describe("spacing", () => {
  it("snaps outward, including negative ticks", () => {
    expect(floorToSpacing(-15, 10)).toBe(-20);
    expect(ceilToSpacing(-15, 10)).toBe(-10);
    expect(snapRangeOutward(222_177, 222_377, 10)).toEqual([222_170, 222_380]);
    expect(isAligned(222_170, 10)).toBe(true);
    expect(isAligned(222_175, 10)).toBe(false);
    expect(bpsToTicksCeil(100)).toBe(100);
    expect(bpsToTicksCeil(100.2)).toBe(101);
  });
});

describe("FullMath and liquidity amounts", () => {
  it("mulDiv floors and mulDivRoundingUp ceils", () => {
    expect(mulDiv(7n, 3n, 2n)).toBe(10n);
    expect(mulDivRoundingUp(7n, 3n, 2n)).toBe(11n);
    expect(mulDivRoundingUp(6n, 3n, 2n)).toBe(9n);
    expect(divRoundingUp(10n, 3n)).toBe(4n);
    expect(() => mulDiv(1n, 1n, 0n)).toThrow(RangeError);
    expect(() => mulDiv(-1n, 1n, 1n)).toThrow(RangeError);
  });

  it("holds only token0 above the range and only token1 below it", () => {
    const a = getSqrtRatioAtTick(222_000);
    const b = getSqrtRatioAtTick(222_500);
    const L = 10n ** 15n;
    const below = getAmountsForLiquidity(getSqrtRatioAtTick(221_000), a, b, L);
    expect(below.amount1).toBe(0n);
    expect(below.amount0).toBeGreaterThan(0n);
    const above = getAmountsForLiquidity(getSqrtRatioAtTick(223_000), a, b, L);
    expect(above.amount0).toBe(0n);
    expect(above.amount1).toBeGreaterThan(0n);
    const inside = getAmountsForLiquidity(LIVE.sqrtPriceX96, a, b, L);
    expect(inside.amount0).toBeGreaterThan(0n);
    expect(inside.amount1).toBeGreaterThan(0n);
  });

  it("rounding up never returns less than rounding down", () => {
    const a = getSqrtRatioAtTick(-1000);
    const b = getSqrtRatioAtTick(1000);
    const L = 123_456_789_012_345n;
    expect(getAmount0Delta(a, b, L, true)).toBeGreaterThanOrEqual(getAmount0Delta(a, b, L, false));
    expect(getAmount1Delta(a, b, L, true)).toBeGreaterThanOrEqual(getAmount1Delta(a, b, L, false));
  });

  it("liquidity from amounts needs no more than the amounts given", () => {
    const a = getSqrtRatioAtTick(222_170);
    const b = getSqrtRatioAtTick(222_380);
    const amount0 = 25_000_000n; // $25 USDG
    const amount1 = 112_000_000_000_000_000n; // 0.112 NVDA
    const L = getLiquidityForAmounts(LIVE.sqrtPriceX96, a, b, amount0, amount1);
    expect(L).toBeGreaterThan(0n);
    const need = getAmountsForLiquidity(LIVE.sqrtPriceX96, a, b, L);
    expect(need.amount0).toBeLessThanOrEqual(amount0);
    expect(need.amount1).toBeLessThanOrEqual(amount1);
  });
});

describe("money", () => {
  it("converts USD to cents exactly once and refuses non-finite amounts", () => {
    expect(usdToCents(49.995)).toBe(5000);
    expect(usdToCents(60)).toBe(6000);
    expect(() => usdToCents(Number.NaN)).toThrow(RangeError);
    expect(() => usdToCents(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it("rounds caps down and spend up", () => {
    expect(usd6ToCentsFloor(60_009_999n)).toBe(6000);
    expect(usd6ToCentsCeil(60_000_001n)).toBe(6001);
    expect(usd6ToCentsCeil(60_000_000n)).toBe(6000);
  });

  it("values amounts like the contract (usd6 = a·p / (10^dec · 1e12))", () => {
    // 0.1 NVDA at $222.39 = $22.239
    expect(valueUsd6(10n ** 17n, 18, 222_390_000_000_000_000_000n, false)).toBe(22_239_000n);
    // 25 USDG at $1 = $25
    expect(valueUsd6(25_000_000n, 6, 10n ** 18n, true)).toBe(25_000_000n);
  });

  it("parses decimal strings without floats", () => {
    expect(parseUnits("0.001", 18)).toBe(10n ** 15n);
    expect(parseUnits("2", 9)).toBe(2_000_000_000n);
    expect(parseUnits("0.02", 9)).toBe(20_000_000n);
    expect(() => parseUnits("1e-3", 18)).toThrow(RangeError);
    expect(() => parseUnits("0.0000000001", 9)).toThrow(RangeError);
    expect(formatUnits(1_500_000n, 6)).toBe("1.5");
    expect(formatUnits(-(10n ** 18n), 18)).toBe("-1");
  });

  it("costs gas in USD", () => {
    // 1M gas at 0.1 gwei and $2,630 ETH ≈ $0.263
    expect(gasCostUsd(1_000_000n, 100_000_000n, 2_630)).toBeCloseTo(0.263, 6);
  });
});
