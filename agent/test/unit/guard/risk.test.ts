import { describe, expect, it } from "vitest";
import {
  fencePriceE18,
  notionalUsd6,
  postUnwindBalances,
  riskModel,
  riskModeOf,
  stricterRiskMode,
} from "../../../src/guard/risk.js";
import { chainlinkRound, mockSnapshot } from "../../../src/sense/mock.js";
import type { DeskAction } from "../../../src/types.js";
import { okSimulation } from "./fixture.js";

describe("risk mode", () => {
  it("flat beats reduce_only beats normal; stubs force nothing", () => {
    expect(riskModeOf([])).toBe("normal");
    expect(riskModeOf(["EVENT", "BOUND-PINNED"])).toBe("normal");
    expect(riskModeOf(["STALE-REF"])).toBe("reduce_only");
    expect(riskModeOf(["STALE-REF", "HALT"])).toBe("flat");
    expect(stricterRiskMode("normal", "reduce_only")).toBe("reduce_only");
    expect(stricterRiskMode("flat", "reduce_only")).toBe("flat");
  });
});

describe("fence-valued notional (the contract's formula)", () => {
  it("fence price = answer · 1e18 / 10^decimals, decimals read live (18 → 8 on Jun 23)", () => {
    expect(fencePriceE18(chainlinkRound(222.42, 8))).toBe(222_420_000_000_000_000_000n);
    expect(fencePriceE18(chainlinkRound(222.42, 18))).toBe(222_420_000_000_000_000_000n);
    expect(fencePriceE18({ ...chainlinkRound(1, 8), answer: 0n })).toBeNull();
    expect(fencePriceE18(null)).toBeNull();
  });

  it("usd6 = amount · p / (10^dec · 1e12), rounded up per token", () => {
    const p = { p0: 10n ** 18n, p1: 222_420_000_000_000_000_000n };
    expect(notionalUsd6({ amount0: 25_000_000n, amount1: 0n }, p)).toBe(25_000_000n);
    expect(notionalUsd6({ amount0: 0n, amount1: 10n ** 18n }, p)).toBe(222_420_000n);
    expect(notionalUsd6({ amount0: 0n, amount1: 1n }, p)).toBe(1n); // dust rounds up
  });

  it("adding notional: upper bound before simulation, the simulated amounts after; 0 for reducing", () => {
    const s = mockSnapshot();
    const rr: DeskAction = {
      kind: "rerange",
      lane: "A",
      ranges: [{ tickLower: 222160, tickUpper: 222370, share0Bps: 10_000, share1Bps: 10_000 }],
      expectedTick: 222275,
      maxTickDelta: 10,
    };
    const upper = riskModel.notionalCents(rr, s, null);
    expect(upper).toBe(5_001); // $25 USDG + 0.1124 NVDA × $222.42
    const sim = okSimulation(rr);
    expect(riskModel.notionalCents(rr, s, sim)).toBe(4_847); // 24 USDG + 0.11 NVDA
    expect(riskModel.notionalCents({ kind: "exitAll", lane: "A" }, s, null)).toBe(0);
    expect(riskModel.notionalCents({ ...rr, ranges: [] }, s, null)).toBe(0); // unwind-and-hold
    expect(Number.isNaN(riskModel.notionalCents(rr, { ...s, chain: null }, null))).toBe(true);
  });

  it("post-unwind balances include position amounts and fees owed", () => {
    const s = mockSnapshot();
    if (s.chain === null) throw new Error("chain");
    const before = postUnwindBalances(s.chain);
    s.chain.lane.positions = [1n, 0n];
    s.chain.lane.positionDetails = [
      {
        tokenId: 1n,
        tickLower: 222300,
        tickUpper: 222400, // above the pool tick: all USDG
        liquidity: 10n ** 13n,
        tokensOwed0: 5n,
        tokensOwed1: 7n,
        feeGrowthInside0LastX128: 0n,
        feeGrowthInside1LastX128: 0n,
      },
      null,
    ];
    const after = postUnwindBalances(s.chain);
    expect(after.balance0).toBeGreaterThan(before.balance0 + 5n);
    expect(after.balance1).toBe(before.balance1 + 7n);
  });
});
