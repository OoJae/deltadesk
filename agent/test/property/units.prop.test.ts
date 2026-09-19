import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  getAmountsForLiquidity,
  getLiquidityForAmounts,
  getSqrtRatioAtTick,
  getTickAtSqrtRatio,
  MAX_TICK,
  MIN_TICK,
  mulDiv,
  mulDivRoundingUp,
  snapRangeOutward,
} from "../../src/units.js";

const tickArb = fc.integer({ min: MIN_TICK, max: MAX_TICK - 1 });

describe("TickMath properties", () => {
  it("getTickAtSqrtRatio inverts getSqrtRatioAtTick, and the tick is the floor", () => {
    fc.assert(
      fc.property(tickArb, (tick) => {
        const s = getSqrtRatioAtTick(tick);
        expect(getTickAtSqrtRatio(s)).toBe(tick);
        const next = getSqrtRatioAtTick(tick + 1);
        if (next - 1n > s) expect(getTickAtSqrtRatio(next - 1n)).toBe(tick);
      }),
      { numRuns: 2_000 },
    );
  });

  it("the sqrt ratio is strictly increasing in the tick", () => {
    fc.assert(
      fc.property(tickArb, (tick) => {
        expect(getSqrtRatioAtTick(tick + 1)).toBeGreaterThan(getSqrtRatioAtTick(tick));
      }),
      { numRuns: 1_000 },
    );
  });
});

describe("FullMath properties", () => {
  it("mulDiv brackets the exact quotient", () => {
    const u = fc.bigInt({ min: 0n, max: (1n << 200n) - 1n });
    fc.assert(
      fc.property(u, u, fc.bigInt({ min: 1n, max: (1n << 200n) - 1n }), (a, b, d) => {
        const lo = mulDiv(a, b, d);
        const hi = mulDivRoundingUp(a, b, d);
        expect(lo * d <= a * b).toBe(true);
        expect(hi * d >= a * b).toBe(true);
        expect(hi - lo === 0n || hi - lo === 1n).toBe(true);
      }),
    );
  });
});

describe("liquidity properties", () => {
  it("minting liquidity from amounts never needs more than those amounts", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 200_000, max: 240_000 }),
        fc.integer({ min: 2, max: 200 }),
        fc.integer({ min: -300, max: 300 }),
        fc.bigInt({ min: 1n, max: 10n ** 12n }),
        fc.bigInt({ min: 1n, max: 10n ** 24n }),
        (lowerRaw, widthSteps, offset, amount0, amount1) => {
          const [lower, upper] = snapRangeOutward(lowerRaw, lowerRaw + widthSteps * 10, 10);
          const price = getSqrtRatioAtTick(lower + Math.floor((upper - lower) / 2) + offset);
          const a = getSqrtRatioAtTick(lower);
          const b = getSqrtRatioAtTick(upper);
          const L = getLiquidityForAmounts(price, a, b, amount0, amount1);
          const need = getAmountsForLiquidity(price, a, b, L);
          expect(need.amount0 <= amount0).toBe(true);
          expect(need.amount1 <= amount1).toBe(true);
        },
      ),
      { numRuns: 500 },
    );
  });
});
