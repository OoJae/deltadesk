import { describe, expect, it } from "vitest";
import {
  createHedgeEngine,
  formatHlPx,
  formatHlSz,
  laneDeltaNvda,
} from "../../../src/hedge/engine.js";
import { MOCK_NOW_MS, mockSnapshot } from "../../../src/sense/mock.js";
import type { DeskSnapshot } from "../../../src/types.js";

const engine = createHedgeEngine();

function laneB(nvda: bigint): DeskSnapshot {
  return mockSnapshot({ lane: "B", balances: { token0: 0n, token1: nvda } });
}

describe("lane B paper hedge", () => {
  it("delta is the lane's NVDA; the target shorts it", () => {
    const s = laneB(10n ** 18n);
    const { state, actions } = engine.step({ snapshot: s, paperPosition: 0, nowMs: MOCK_NOW_MS });
    expect(state.delta).toBeCloseTo(1, 12);
    expect(state.target).toBeCloseTo(-1, 12);
    expect(actions).toEqual([
      {
        kind: "hedge",
        lane: "B",
        coin: "xyz:NVDA",
        asset: 110002,
        isBuy: false,
        sz: "1",
        px: formatHlPx(s.hl?.ask ?? 0, 3),
        tif: "Alo",
        reduceOnly: false,
      },
    ]);
  });

  it("does nothing inside the tolerance τ", () => {
    const { state, actions } = engine.step({
      snapshot: laneB(10n ** 18n),
      paperPosition: -0.95,
      nowMs: MOCK_NOW_MS,
    });
    expect(state.tau).toBeGreaterThanOrEqual(0.1);
    expect(actions).toEqual([]);
  });

  it("shrinking an existing short is reduce-only and buys at the bid", () => {
    const s = laneB(0n);
    const { actions } = engine.step({ snapshot: s, paperPosition: -2, nowMs: MOCK_NOW_MS });
    expect(actions[0]).toMatchObject({
      isBuy: true,
      sz: "2",
      reduceOnly: true,
      px: formatHlPx(s.hl?.bid ?? 0, 3),
    });
  });

  it("lane A, a missing HL quote or a missing chain read emits nothing", () => {
    expect(
      engine.step({ snapshot: mockSnapshot(), paperPosition: 0, nowMs: MOCK_NOW_MS }).actions,
    ).toEqual([]);
    expect(
      engine.step({
        snapshot: { ...laneB(10n ** 18n), hl: null },
        paperPosition: 0,
        nowMs: MOCK_NOW_MS,
      }).actions,
    ).toEqual([]);
    expect(
      engine.step({
        snapshot: { ...laneB(10n ** 18n), chain: null },
        paperPosition: 0,
        nowMs: MOCK_NOW_MS,
      }).actions,
    ).toEqual([]);
  });

  it("formats HL prices to 5 significant figures and floors sizes", () => {
    expect(formatHlPx(222.4567, 3)).toBe("222.46");
    expect(formatHlPx(1234.567, 3)).toBe("1234.6");
    // at most 6 − szDecimals decimals: a tiny price with szDecimals 3 is unrepresentable ("0")
    expect(formatHlPx(0.000123456, 0)).toBe("0.000123");
    expect(formatHlPx(0.000123456, 3)).toBe("0");
    expect(formatHlSz(1.23456, 3)).toBe("1.234");
    expect(formatHlSz(0.0004, 3)).toBe("0");
    expect(formatHlSz(Number.NaN, 3)).toBe("0");
  });

  it("counts position NVDA at the pool price plus owed and idle NVDA", () => {
    const s = laneB(5n * 10n ** 17n);
    if (s.chain === null) throw new Error("chain");
    s.chain.lane.positions = [1n, 0n];
    s.chain.lane.positionDetails = [
      {
        tokenId: 1n,
        tickLower: 222000,
        tickUpper: 222100, // below the pool tick: all NVDA
        liquidity: 10n ** 15n,
        tokensOwed0: 0n,
        tokensOwed1: 10n ** 17n,
        feeGrowthInside0LastX128: 0n,
        feeGrowthInside1LastX128: 0n,
      },
      null,
    ];
    expect(laneDeltaNvda(s.chain)).toBeGreaterThan(0.6);
  });
});
