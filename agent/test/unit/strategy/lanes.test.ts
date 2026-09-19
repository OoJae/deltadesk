import { describe, expect, it } from "vitest";
import { STRATEGY_DEFAULTS } from "../../../src/config.js";
import { poolMidFromSqrt } from "../../../src/market/fair-value.js";
import { MOCK_NOW_MS, mockSnapshot } from "../../../src/sense/mock.js";
import {
  createLaneStrategy,
  type LaneStrategyOptions,
  outsideInnerStreak,
  samePlacement,
} from "../../../src/strategy/lanes.js";
import type {
  DeskAction,
  DeskSnapshot,
  HourRecord,
  LaneState,
  RegimeState,
} from "../../../src/types.js";
import { getSqrtRatioAtTick } from "../../../src/units.js";
import { FRESH_AGENT, laneState, normalRegime } from "../guard/fixture.js";

const NOW = MOCK_NOW_MS;

interface Run {
  snapshot?: DeskSnapshot;
  regime?: RegimeState;
  lane?: Partial<LaneState>;
  random?: number;
  nowMs?: number;
  hourRecord?: HourRecord | null;
  agent?: Partial<typeof FRESH_AGENT>;
  opts?: LaneStrategyOptions;
}

function plan(r: Run = {}) {
  const snapshot = r.snapshot ?? mockSnapshot({ hlMid: 222.6 });
  const regime = r.regime ?? normalRegime(snapshot);
  return createLaneStrategy({ maxActionCents: 6_000, ...r.opts }).plan({
    lane: snapshot.lane,
    snapshot,
    regime,
    laneState: laneState(snapshot, regime, r.lane),
    params: STRATEGY_DEFAULTS,
    agentRerange: { ...FRESH_AGENT, ...r.agent },
    hourRecord: r.hourRecord === undefined ? { fees_usd: 6_164 } : r.hourRecord,
    gasQuote: null,
    nowMs: r.nowMs ?? NOW,
    random: () => r.random ?? 0,
  });
}

/**
 * A lane holding one position [tl, tu) with the pool at `tick`, F at the pool (gap 0) unless hlMid
 * is given, and the Chainlink reference at the pool.
 */
function holding(tl: number, tu: number, tick: number, hlMid?: number): DeskSnapshot {
  const sqrt = getSqrtRatioAtTick(tick) + 1n;
  const mid = poolMidFromSqrt(sqrt);
  const s = mockSnapshot({ tick, sqrtPriceX96: sqrt, hlMid: hlMid ?? mid, nvdaUsd: mid });
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
  return s;
}

const kinds = (actions: DeskAction[]) => actions.map((a) => a.kind);
const RICH_HOUR: HourRecord = { fees_usd: 1e9 };

describe("lane A strategy: initial mint", () => {
  it("mints a straddle centred on F from the funded, empty lane, and records the waived hurdle", () => {
    const p = plan();
    expect(p.trigger).toBe("initial_mint");
    expect(p.actions).toEqual([
      {
        kind: "rerange",
        lane: "A",
        ranges: [{ tickLower: 222160, tickUpper: 222370, share0Bps: 10_000, share1Bps: 10_000 }],
        expectedTick: 222275,
        maxTickDelta: 10,
      },
    ]);
    expect(p.notionalCents).toBeGreaterThan(4_900);
    expect(p.notionalCents).toBeLessThanOrEqual(5_880);
    expect(p.hurdle?.passes).toBe(false);
    expect(p.rationale.join(" ")).toMatch(/waived for the initial mint/);
  });

  it("enforces the hurdle on the initial mint when configured to", () => {
    const p = plan({ opts: { hurdleOnInitialMint: true } });
    expect(kinds(p.actions)).toEqual(["hold"]);
    expect(p.rationale.at(-1)).toMatch(/cost hurdle/);
  });

  it("an unfunded empty lane holds", () => {
    const p = plan({ snapshot: mockSnapshot({ balances: { token0: 1_000_000n, token1: 0n } }) });
    expect(p.rationale.at(-1)).toBe("lane empty and not funded");
  });
});

describe("lane A strategy: jitter", () => {
  it("schedules 0-20 s ahead, never revealing ticks, then proposes when due", () => {
    const first = plan({ random: 0.5 });
    expect(kinds(first.actions)).toEqual(["hold"]);
    expect(first.carry.rerangeNotBeforeMs).toBe(NOW + 10_000);
    expect(first.rationale.join(" ")).not.toMatch(/2221|2223/); // no tick numbers before execution
    const waiting = plan({ nowMs: NOW + 5_000, lane: { rerangeNotBeforeMs: NOW + 10_000 } });
    expect(kinds(waiting.actions)).toEqual(["hold"]);
    expect(waiting.carry.rerangeNotBeforeMs).toBe(NOW + 10_000);
    const due = plan({ nowMs: NOW + 10_000, lane: { rerangeNotBeforeMs: NOW + 10_000 } });
    expect(kinds(due.actions)).toEqual(["rerange"]);
    expect(due.carry.rerangeNotBeforeMs).toBeNull();
  });

  it("drops a pending schedule when the rerange is no longer due", () => {
    const s = holding(222160, 222370, 222265);
    const p = plan({ snapshot: s, lane: { rerangeNotBeforeMs: NOW + 5_000 } });
    expect(p.rationale.at(-1)).toBe("in range");
    expect(p.carry.rerangeNotBeforeMs).toBeNull();
  });
});

describe("lane A strategy: risk modes", () => {
  it("flat (HALT) exits every position, holds when flat already", () => {
    const s = holding(222160, 222370, 222265);
    const halted = normalRegime({ ...s, rh: s.rh && { ...s.rh, isTradingHalt: true } });
    expect(halted.riskMode).toBe("flat");
    expect(plan({ snapshot: s, regime: halted }).actions).toEqual([{ kind: "exitAll", lane: "A" }]);
    const empty = mockSnapshot();
    expect(kinds(plan({ snapshot: empty, regime: { ...halted } }).actions)).toEqual(["hold"]);
  });

  it("reduce-only holds positions and adds nothing", () => {
    const s = mockSnapshot({ nowMs: Date.UTC(2026, 8, 19, 18, 0, 0) }); // Saturday
    const r = normalRegime(s, s.takenAtMs);
    expect(r.riskMode).toBe("reduce_only");
    const p = plan({ snapshot: s, regime: r, nowMs: s.takenAtMs });
    expect(kinds(p.actions)).toEqual(["hold"]);
    expect(p.rationale[0]).toMatch(/reduce-only \(CLOSED/);
  });

  it("lanes B and C hold in M2", () => {
    const s = mockSnapshot({ lane: "B" });
    expect(kinds(plan({ snapshot: s }).actions)).toEqual(["hold"]);
  });

  it("holds without a chain read", () => {
    const s = mockSnapshot({ chain: null });
    expect(plan({ snapshot: s, regime: normalRegime(mockSnapshot()) }).rationale).toEqual([
      "no chain read this tick",
    ]);
  });
});

describe("lane A strategy: triggers and hysteresis", () => {
  it("in range: hold", () => {
    expect(plan({ snapshot: holding(222160, 222370, 222265) }).rationale.at(-1)).toBe("in range");
  });

  it("outside the inner 60 % needs 2 consecutive ticks", () => {
    const s = holding(222160, 222370, 222340, undefined); // inner band is [222202, 222328]
    const once = plan({ snapshot: s, hourRecord: RICH_HOUR });
    expect(once.carry.outsideInnerTicks).toBe(1);
    expect(once.rationale.at(-1)).toMatch(/1\/2/);
    const twice = plan({ snapshot: s, hourRecord: RICH_HOUR, lane: { outsideInnerTicks: 1 } });
    expect(twice.trigger).toBe("outside_inner");
    expect(kinds(twice.actions)).toEqual(["rerange"]);
    expect(twice.hurdle?.passes).toBe(true);
  });

  it("centres on F, never the pool: F within the hysteresis of the live range means no rerange", () => {
    // the pool left the inner band (> 222328) but F moved only 40 ticks: the new straddle
    // [222200, 222410) is within the 40-tick tolerance of the live [222160, 222370)
    const f = (t: number) => poolMidFromSqrt(getSqrtRatioAtTick(t));
    const s = holding(222160, 222370, 222329, f(222305));
    const p = plan({ snapshot: s, hourRecord: RICH_HOUR, lane: { outsideInnerTicks: 5 } });
    expect(p.trigger).toBe("outside_inner");
    expect(p.rationale.at(-1)).toBe("placement unchanged (within hysteresis)");
    // F moved further: rerange
    const moved = plan({
      snapshot: holding(222160, 222370, 222329, f(222315)),
      hourRecord: RICH_HOUR,
      lane: { outsideInnerTicks: 5 },
    });
    expect(kinds(moved.actions)).toEqual(["rerange"]);
  });

  it("the pool far from F: single-sided beyond F", () => {
    const f = poolMidFromSqrt(getSqrtRatioAtTick(222265));
    const p = plan({
      snapshot: holding(222160, 222370, 222340, f),
      hourRecord: RICH_HOUR,
      lane: { outsideInnerTicks: 5 },
    });
    const rr = p.actions[0];
    expect(rr?.kind).toBe("rerange");
    if (rr?.kind === "rerange")
      expect(rr.ranges[0]).toMatchObject({ share0Bps: 0, tickUpper: 222260 });
  });

  it("out of range triggers at once; the hurdle then decides", () => {
    const s = holding(222160, 222370, 222400);
    const cheap = plan({ snapshot: s });
    expect(cheap.trigger).toBe("out_of_range");
    expect(cheap.rationale.at(-1)).toMatch(/^cost hurdle/);
    const rich = plan({ snapshot: s, hourRecord: RICH_HOUR });
    expect(kinds(rich.actions)).toEqual(["rerange"]);
    expect(plan({ snapshot: s, hourRecord: null }).rationale.at(-1)).toMatch(/no fee rate/);
  });

  it("samePlacement tolerates edges within the outer band of the range", () => {
    const s = holding(222160, 222370, 222265);
    const live = [
      { slot: 0 as const, tokenId: 42n, detail: s.chain?.lane.positionDetails[0] ?? null },
    ];
    const near = [{ tickLower: 222200, tickUpper: 222400, share0Bps: 1, share1Bps: 1 }];
    const far = [{ tickLower: 222220, tickUpper: 222420, share0Bps: 1, share1Bps: 1 }];
    expect(samePlacement(near, live, STRATEGY_DEFAULTS)).toBe(true);
    expect(samePlacement(far, live, STRATEGY_DEFAULTS)).toBe(false);
  });

  it("outsideInnerStreak counts consecutive ticks and resets inside", () => {
    const out = holding(222160, 222370, 222340).chain;
    const inside = holding(222160, 222370, 222265).chain;
    expect(outsideInnerStreak(3, out, STRATEGY_DEFAULTS)).toBe(4);
    expect(outsideInnerStreak(3, inside, STRATEGY_DEFAULTS)).toBe(0);
    expect(outsideInnerStreak(3, null, STRATEGY_DEFAULTS)).toBe(0);
  });
});

describe("lane A strategy: rate limits and caps", () => {
  it("respects the contract interval and buckets and the agent's own limits", () => {
    const s = mockSnapshot({ hlMid: 222.6 });
    if (s.chain === null) throw new Error("chain");
    s.chain.lane.budgets.nextRerangeAt = BigInt(Math.floor(NOW / 1000) + 30);
    expect(plan({ snapshot: s }).rationale.at(-1)).toBe("contract rerange interval not elapsed");
    s.chain.lane.budgets.nextRerangeAt = 0n;
    s.chain.lane.budgets.reranges1hLeft = 0n;
    expect(plan({ snapshot: s }).rationale.at(-1)).toBe("contract rerange budget exhausted");
    expect(plan({ agent: { count24h: 24 } }).rationale.at(-1)).toBe(
      "agent rerange budget exhausted",
    );
    expect(plan({ agent: { lastRerangeAtMs: NOW - 60_000 } }).rationale.at(-1)).toBe(
      "agent rerange interval not elapsed",
    );
  });

  it("scales shares so the fence-valued notional fits the smallest cap with margin", () => {
    const rich = mockSnapshot({
      hlMid: 222.6,
      balances: { token0: 500_000_000n, token1: 2_248_000_000_000_000_000n },
    });
    const p = plan({ snapshot: rich });
    const rr = p.actions[0];
    expect(rr?.kind).toBe("rerange");
    expect(p.notionalCents).toBeLessThanOrEqual(5_880);
    expect(p.notionalCents).toBeGreaterThan(5_800);
    if (rr?.kind === "rerange") expect(rr.ranges[0]?.share0Bps).toBeLessThan(700);
    const tighter = plan({ snapshot: rich, opts: { maxActionCents: 2_000 } });
    expect(tighter.notionalCents).toBeLessThanOrEqual(1_960);
  });

  it("an almost empty turnover bucket caps the deploy, below the minimum it holds", () => {
    const s = mockSnapshot({ hlMid: 222.6 });
    if (s.chain === null) throw new Error("chain");
    s.chain.lane.budgets.turnoverAvailableUsd6 = 20_000_000n;
    expect(plan({ snapshot: s }).notionalCents).toBeLessThanOrEqual(1_960);
    s.chain.lane.budgets.turnoverAvailableUsd6 = 3_000_000n;
    expect(plan({ snapshot: s }).rationale.at(-1)).toMatch(/below the \$5.00 minimum/);
  });
});
