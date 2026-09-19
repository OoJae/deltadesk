import { describe, expect, it } from "vitest";
import {
  fenceAllows,
  fenceAllowsAcross,
  planBands,
  rangeNeeds,
  shapeOk,
} from "../../../src/strategy/bands.js";
import type { BandPlacementInput } from "../../../src/types.js";

const base: BandPlacementInput = {
  poolTick: 222275,
  fTick: 222267,
  gapBps: 7.9,
  refTick: 222277,
  bandTicks: 100,
  tickSpacing: 10,
  halfWidthTicks: 100,
  straddleMaxGapBps: 25,
  minWidthTicks: 20,
  maxWidthTicks: 2000,
  balance0: 25_000_000n,
  balance1: 112_400_000_000_000_000n,
};

/**
 * Brute-force holdings model (the contract's RangeRules notice and RangeRules.t.sol): with the pool at tc, tick
 * bucket [t, t+1) holds token1 when t < tc, token0 when t > tc, and BOTH when t == tc (tl == tc included). No bucket
 * may offer token0 below ref − band or bid above ref + band; the current bucket's bid gets the one-tick slack.
 */
function bruteFence(tl: number, tu: number, tc: number, ref: number, band: number): boolean {
  for (let t = tl; t < tu; t++) {
    if (t >= tc && t < ref - band) return false; // token0 offered too cheap
    if (t < tc && t + 1 > ref + band) return false; // token1 bid too high
    if (t === tc && t > ref + band) return false; // the current bucket's token1 bid too high
  }
  return true;
}

describe("the placement fence mirror", () => {
  it("equals the brute-force per-tick holdings model", () => {
    let checked = 0;
    for (let tl = -60; tl <= 40; tl += 10) {
      for (let tu = tl + 10; tu <= 80; tu += 10) {
        for (const tc of [tl, tu, ...Array.from({ length: 54 }, (_, i) => -70 + 3 * i)]) {
          for (const [ref, band] of [
            [0, 10],
            [5, 20],
            [-30, 0],
          ] as const) {
            expect(fenceAllows({ tickLower: tl, tickUpper: tu }, tc, ref, band)).toBe(
              bruteFence(tl, tu, tc, ref, band),
            );
            checked++;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(2_000);
  });

  it("bids at the pool tick when tickLower == tc (the RangeRules tl == tc fix)", () => {
    // Pool parked far above the band at the range's lower tick: [tc, tc + 20) holds token1 in tc's bucket.
    expect(fenceAllows({ tickLower: 4000, tickUpper: 4020 }, 4000, 0, 100)).toBe(false);
    expect(fenceAllows({ tickLower: 100, tickUpper: 120 }, 100, 0, 100)).toBe(true);
    expect(fenceAllows({ tickLower: 110, tickUpper: 130 }, 100, 0, 100)).toBe(true); // token0 only
  });

  it("a straddle is allowed iff |tc − ref| ≤ band, whatever its width", () => {
    const r = { tickLower: -500, tickUpper: 500 };
    expect(fenceAllows(r, 100, 0, 100)).toBe(true);
    expect(fenceAllows(r, 101, 0, 100)).toBe(false);
    expect(fenceAllows(r, -101, 0, 100)).toBe(false);
    expect(fenceAllowsAcross(r, 90, 10, 0, 100)).toBe(true);
    expect(fenceAllowsAcross(r, 91, 10, 0, 100)).toBe(false);
  });

  it("shape rules and token needs", () => {
    expect(shapeOk({ tickLower: 0, tickUpper: 20 }, 10, 20, 2000)).toBe(true);
    expect(shapeOk({ tickLower: 0, tickUpper: 10 }, 10, 20, 2000)).toBe(false);
    expect(shapeOk({ tickLower: 5, tickUpper: 25 }, 10, 20, 2000)).toBe(false);
    expect(shapeOk({ tickLower: 20, tickUpper: 20 }, 10, 0, 2000)).toBe(false);
    expect(shapeOk({ tickLower: -887280, tickUpper: 0 }, 10, 0, 10_000_000)).toBe(false);
    // tc == tickLower is in range in v3: the current bucket holds token1 too.
    expect(rangeNeeds({ tickLower: 0, tickUpper: 100 }, 0)).toEqual({
      token0: true,
      token1: true,
    });
    expect(rangeNeeds({ tickLower: 0, tickUpper: 100 }, -1)).toEqual({
      token0: true,
      token1: false,
    });
    expect(rangeNeeds({ tickLower: 0, tickUpper: 100 }, 100)).toEqual({
      token0: false,
      token1: true,
    });
    expect(rangeNeeds({ tickLower: 0, tickUpper: 100 }, 50)).toEqual({
      token0: true,
      token1: true,
    });
  });
});

describe("planBands", () => {
  it("near F with both tokens: one straddle [F − w, F + w] snapped outward, fence-safe over the execution window", () => {
    const p = planBands({ ...base, executionTickMargin: 10 });
    expect(p).toEqual({
      ok: true,
      shape: "straddle",
      ranges: [{ tickLower: 222160, tickUpper: 222370, share0Bps: 10_000, share1Bps: 10_000 }],
    });
  });

  it("skips a straddle outside the fence (no tick freedom there)", () => {
    const p = planBands({ ...base, refTick: base.poolTick + 95, executionTickMargin: 10 });
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.reason).toMatch(/fence/);
    expect(planBands({ ...base, refTick: base.poolTick + 90, executionTickMargin: 10 }).ok).toBe(
      true,
    );
  });

  it("F above the pool (gap > 25 bp): NVDA asks at prices ≥ F, i.e. ticks ≤ fTick", () => {
    const fTick = base.poolTick - 60; // F ≈ 60 bp above the pool
    const p = planBands({ ...base, fTick, gapBps: 60, executionTickMargin: 10 });
    expect(p.ok && p.shape).toBe("single_sided_token1");
    if (!p.ok) return;
    const r = p.ranges[0];
    expect(r).toEqual({ tickLower: 222010, tickUpper: 222210, share0Bps: 0, share1Bps: 10_000 });
    expect(r && r.tickUpper <= fTick).toBe(true);
  });

  it("F below the pool: USDG bids at prices ≤ F, i.e. ticks ≥ fTick", () => {
    const fTick = base.poolTick + 60;
    const p = planBands({ ...base, fTick, gapBps: -60, executionTickMargin: 10 });
    expect(p.ok && p.shape).toBe("single_sided_token0");
    if (!p.ok) return;
    expect(p.ranges[0]).toEqual({
      tickLower: 222340,
      tickUpper: 222540,
      share0Bps: 10_000,
      share1Bps: 0,
    });
  });

  it("pushes a single-sided range further from the pool when the fence requires it, never inward", () => {
    // Chainlink says NVDA is much dearer than F: asks must sit at ≤ ref + band.
    const fTick = base.poolTick - 60;
    const p = planBands({
      ...base,
      fTick,
      gapBps: 60,
      refTick: base.poolTick - 250,
      executionTickMargin: 10,
    });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    const r = p.ranges[0];
    if (r === undefined) throw new Error("range");
    expect(r.tickUpper).toBe(222120); // floor10(ref + band), below F's 222210
    expect(fenceAllowsAcross(r, base.poolTick, 10, base.poolTick - 250, 100)).toBe(true);
  });

  it("near F with one token: that token on its own side, starting at F", () => {
    const only0 = planBands({ ...base, balance1: 0n, executionTickMargin: 10 });
    expect(only0.ok && only0.shape).toBe("single_sided_token0");
    if (only0.ok) expect(only0.ranges[0]?.tickLower).toBe(222290); // max(F, pool + margin) → up to 10
    const only1 = planBands({ ...base, balance0: 0n, executionTickMargin: 10 });
    expect(only1.ok && only1.shape).toBe("single_sided_token1");
    if (only1.ok) expect(only1.ranges[0]?.tickUpper).toBe(222260);
  });

  it("refuses when the far side's token is missing, when nothing is held, or on bad input", () => {
    expect(planBands({ ...base, fTick: base.poolTick - 60, gapBps: 60, balance1: 0n }).ok).toBe(
      false,
    );
    expect(planBands({ ...base, balance0: 0n, balance1: 0n }).ok).toBe(false);
    expect(planBands({ ...base, gapBps: Number.NaN }).ok).toBe(false);
    expect(planBands({ ...base, fTick: 1.5 }).ok).toBe(false);
    expect(planBands({ ...base, halfWidthTicks: 5000 }).ok).toBe(false); // wider than maxWidth
  });
});
