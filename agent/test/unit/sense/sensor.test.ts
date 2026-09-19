import { describe, expect, it } from "vitest";
import { createSensor, type SensorDeps } from "../../../src/sense/index.js";
import {
  createMockSensor,
  MOCK_LANE,
  MOCK_OPERATOR,
  mockChainRead,
} from "../../../src/sense/mock.js";
import type { BasisK, CorpActionsState, HlQuote, RhQuote } from "../../../src/types.js";
import { fixedClock } from "../../helpers/fakes.js";

function deps(over: Partial<SensorDeps> = {}) {
  const clock = fixedClock();
  let corpCalls = 0;
  let chainFails = false;
  const hl: HlQuote = {
    coin: "xyz:NVDA",
    bid: 222.5,
    ask: 222.7,
    mid: 222.6,
    markPx: null,
    oraclePx: null,
    exchangeTimeMs: null,
    receivedAtMs: clock.now(),
    source: "ws",
  };
  const d: SensorDeps = {
    clock,
    chainId: 4663,
    signerAddress: MOCK_OPERATOR,
    chain: {
      async read(laneAddress, operator) {
        if (chainFails) throw new Error("rpc down");
        expect(operator).toBe(MOCK_OPERATOR);
        return { ...mockChainRead(), lane: { ...mockChainRead().lane, laneAddress } };
      },
    },
    hl: {
      start() {},
      async stop() {},
      latest: () => hl,
      status: (now) => ({ ok: true, ageMs: now - hl.receivedAtMs, reason: null }),
      onTrade: () => () => {},
    },
    rh: {
      async quote(symbol): Promise<RhQuote> {
        return {
          symbol,
          bid: 222.4,
          ask: 222.6,
          mid: 222.5,
          isTradingHalt: false,
          generatedAtMs: null,
          receivedAtMs: clock.now(),
        };
      },
      async corporateActions(): Promise<CorpActionsState> {
        corpCalls++;
        return {
          pendingForSymbol: false,
          nextEffectiveAtMs: null,
          items: [],
          fetchedAtMs: clock.now(),
        };
      },
    },
    engine: {
      async basis(): Promise<BasisK> {
        return { k: 1, source: "engine", session: "2026-09-18", fetchedAtMs: clock.now() };
      },
      async hourRecord() {
        return null;
      },
      status: () => ({ ok: true, ageMs: 0, reason: null }),
    },
    ...over,
  };
  return { d, clock, corp: () => corpCalls, failChain: (v: boolean) => (chainFails = v) };
}

describe("sensor", () => {
  it("composes one snapshot: F = HL · k against the pool mid, ETH/USD from Chainlink, all sources healthy", async () => {
    const { d, clock } = deps();
    const s = await createSensor(d).read("A", MOCK_LANE);
    expect(s).toMatchObject({
      lane: "A",
      laneAddress: MOCK_LANE,
      chainId: 4663,
      signerAddress: MOCK_OPERATOR,
      takenAtMs: clock.now(),
      ethUsd: 2630,
    });
    expect(s.calendar.name).toBe("REGULAR");
    expect(s.fairValue?.F).toBeCloseTo(222.6, 9);
    expect(s.fairValue?.gapBps).toBeCloseTo(1e4 * Math.log(222.6 / (s.fairValue?.poolMid ?? 1)), 9);
    expect(Object.values(s.sources).every((x) => x.ok)).toBe(true);
  });

  it("a failed chain read is null (never stale data dressed as current) and ages from the last success", async () => {
    const { d, clock, failChain } = deps();
    const sensor = createSensor(d);
    await sensor.read("A", MOCK_LANE);
    failChain(true);
    clock.advance(7_000);
    const s = await sensor.read("A", MOCK_LANE);
    expect(s.chain).toBeNull();
    expect(s.fairValue).toBeNull();
    expect(s.sources.chain).toEqual({ ok: false, ageMs: 7_000, reason: "rpc down" });
  });

  it("fetches corporate actions hourly, keeps the last good state, retries failures sooner", async () => {
    const { d, clock, corp } = deps();
    const sensor = createSensor(d);
    await sensor.read("A", MOCK_LANE);
    clock.advance(30 * 60_000);
    const s = await sensor.read("A", MOCK_LANE);
    expect(corp()).toBe(1);
    expect(s.sources.corpActions.ageMs).toBe(30 * 60_000);
    clock.advance(31 * 60_000);
    await sensor.read("A", MOCK_LANE);
    expect(corp()).toBe(2);
  });

  it("an RH failure leaves rh null and the source unhealthy", async () => {
    const { d } = deps();
    const s = await createSensor({
      ...d,
      rh: {
        ...d.rh,
        async quote() {
          throw new Error("403");
        },
      },
    }).read("A", MOCK_LANE);
    expect(s.rh).toBeNull();
    expect(s.sources.rh).toMatchObject({ ok: false, ageMs: null, reason: "403" });
  });

  it("the mock sensor answers for any lane address at the clock's time", async () => {
    const clock = fixedClock();
    const s = await createMockSensor(clock).read("A", "0x5555555555555555555555555555555555555555");
    expect(s.laneAddress).toBe("0x5555555555555555555555555555555555555555");
    expect(s.chain?.lane.laneAddress).toBe("0x5555555555555555555555555555555555555555");
    expect(s.takenAtMs).toBe(clock.now());
  });
});
