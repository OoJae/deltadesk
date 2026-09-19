import { describe, expect, it } from "vitest";
import { etToEpochSec } from "../../../src/market/calendar.js";
import { createEngineSource } from "../../../src/sense/engine.js";
import { createRhFeed } from "../../../src/sense/robinhood.js";
import { fixedClock, LANE, memDb } from "../../helpers/fakes.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function fetchFrom(routes: Record<string, () => Response>): typeof fetch & { urls: string[] } {
  const urls: string[] = [];
  const f = (async (url: string) => {
    urls.push(url);
    const hit = Object.entries(routes).find(([k]) => url.endsWith(k));
    if (hit === undefined) return json({ error: "no route" }, 404);
    return hit[1]();
  }) as typeof fetch & { urls: string[] };
  f.urls = urls;
  return f;
}

// Live shapes captured 2026-09-19.
const NVDA_QUOTE = {
  quotes: [
    {
      tokenSymbol: "NVDA",
      bid: "222.48",
      ask: "223",
      currency: "USD",
      isTradingHalt: false,
      generatedAt: "2026-09-19T08:39:50.567795204Z",
    },
  ],
};
const CORP = {
  corpActions: [
    {
      id: "0x1",
      type: "CORPORATE_ACTION_TYPE_CASH_DIVIDEND",
      status: "CORPORATE_ACTION_STATUS_IN_PROGRESS",
      processDate: { year: 2026, month: 10, day: 1 },
      tokenSymbol: "NVDA",
    },
    {
      id: "0x2",
      type: "CORPORATE_ACTION_TYPE_CASH_DIVIDEND",
      status: "CORPORATE_ACTION_STATUS_COMPLETED",
      processDate: { year: 2026, month: 7, day: 1 },
      tokenSymbol: "NVDA",
    },
    {
      id: "0x3",
      type: "CORPORATE_ACTION_TYPE_CASH_DIVIDEND",
      status: "CORPORATE_ACTION_STATUS_IN_PROGRESS",
      processDate: { year: 2026, month: 9, day: 22 },
      tokenSymbol: "AMKR",
    },
  ],
};

describe("Robinhood feed", () => {
  it("parses /prices: bid, ask, halt flag and generation time", async () => {
    const clock = fixedClock();
    const rh = createRhFeed({
      apiUrl: "https://api.rh.test/rhj/",
      clock,
      fetchImpl: fetchFrom({ "/prices/NVDA": () => json(NVDA_QUOTE) }),
    });
    const q = await rh.quote("NVDA");
    expect(q).toMatchObject({
      symbol: "NVDA",
      bid: 222.48,
      ask: 223,
      isTradingHalt: false,
      receivedAtMs: clock.now(),
    });
    expect(q.mid).toBeCloseTo(222.74, 9);
    expect(q.generatedAtMs).toBe(Date.parse("2026-09-19T08:39:50.567Z"));
  });

  it("accepts an empty book only while halted; rejects malformed or failed answers", async () => {
    const clock = fixedClock();
    const q = (body: unknown, status = 200) =>
      createRhFeed({
        apiUrl: "https://api.rh.test/rhj",
        clock,
        fetchImpl: fetchFrom({ "/prices/NVDA": () => json(body, status) }),
      }).quote("NVDA");
    const halted = {
      quotes: [{ ...NVDA_QUOTE.quotes[0], bid: "0", ask: "0", isTradingHalt: true }],
    };
    await expect(q(halted)).resolves.toMatchObject({ isTradingHalt: true });
    await expect(q({ quotes: [{ ...NVDA_QUOTE.quotes[0], bid: "0", ask: "0" }] })).rejects.toThrow(
      /unusable/,
    );
    await expect(q({ quotes: [] })).rejects.toThrow();
    await expect(q({ quotes: [{ bid: 1, ask: 2, isTradingHalt: false }] })).rejects.toThrow();
    await expect(q(NVDA_QUOTE, 503)).rejects.toThrow(/503/);
  });

  it("corporate actions: pending unless completed; effective at 00:00 ET of the process date", async () => {
    const clock = fixedClock();
    const rh = createRhFeed({
      apiUrl: "https://api.rh.test/rhj",
      clock,
      fetchImpl: fetchFrom({ "/corporate-actions": () => json(CORP) }),
    });
    const s = await rh.corporateActions("NVDA");
    expect(s.items).toHaveLength(2);
    expect(s.pendingForSymbol).toBe(true);
    expect(s.nextEffectiveAtMs).toBe(etToEpochSec(2026, 10, 1, 0, 0) * 1000);
    expect(s.fetchedAtMs).toBe(clock.now());
    const none = await rh.corporateActions("TSLA");
    expect(none).toMatchObject({ pendingForSymbol: false, nextEffectiveAtMs: null, items: [] });
  });

  it("an unknown status counts as pending and an undated one has no effective time", async () => {
    const clock = fixedClock();
    const body = {
      corpActions: [
        {
          type: "CORPORATE_ACTION_TYPE_STOCK_SPLIT",
          status: "CORPORATE_ACTION_STATUS_SCHEDULED",
          tokenSymbol: "NVDA",
          processDate: null,
        },
      ],
    };
    const rh = createRhFeed({
      apiUrl: "https://api.rh.test/rhj",
      clock,
      fetchImpl: fetchFrom({ "/corporate-actions": () => json(body) }),
    });
    await expect(rh.corporateActions("NVDA")).resolves.toMatchObject({
      pendingForSymbol: true,
      nextEffectiveAtMs: null,
    });
  });
});

describe("engine source: hour-of-week record", () => {
  const hour = (how: number) => ({
    current_hour: {
      how,
      swaps: 27184,
      fees_usd: 6164.69,
      picked_1h_usd: 24654.6,
      edge_1h: 0.25,
      lp_net_bps_1h: -11.2,
      reference: "hyperliquid",
    },
  });

  it("fetches /pool-toxicity with the premium key, memoises per hour of week, and persists it", async () => {
    const db = memDb();
    const clock = fixedClock();
    const f = fetchFrom({ "/pool-toxicity/NVDA": () => json(hour(9)) });
    const engine = createEngineSource({
      apiUrl: "https://engine.test",
      apiKey: "k",
      pool: "NVDA",
      laneAddress: LANE,
      db,
      clock,
      fetchImpl: f,
      ttlMs: 600_000,
    });
    const r = await engine.hourRecord(9);
    expect(r).toEqual({
      fees_usd: 6164.69,
      swaps: 27184,
      picked_1h_usd: 24654.6,
      edge_1h: 0.25,
      lp_net_bps_1h: -11.2,
      reference: "hyperliquid",
    });
    await engine.hourRecord(9);
    expect(f.urls.filter((u) => u.includes("pool-toxicity"))).toHaveLength(1);
    expect(JSON.parse(db.getParam("how:NVDA:9")?.valueJson ?? "{}").fees_usd).toBe(6164.69);
  });

  it("a different current hour or an engine outage falls back to the persisted record", async () => {
    const db = memDb();
    const clock = fixedClock();
    db.setParam("how:NVDA:10", JSON.stringify({ fees_usd: 3876.8 }), {
      source: "engine",
      fetchedAtMs: clock.now(),
      ttlMs: 1,
    });
    const other = createEngineSource({
      apiUrl: "https://engine.test",
      apiKey: undefined,
      pool: "NVDA",
      laneAddress: LANE,
      db,
      clock,
      fetchImpl: fetchFrom({ "/pool-toxicity/NVDA": () => json(hour(9)) }),
      ttlMs: 600_000,
    });
    expect(await other.hourRecord(10)).toEqual({ fees_usd: 3876.8 });
    const down = createEngineSource({
      apiUrl: "https://engine.test",
      apiKey: undefined,
      pool: "NVDA",
      laneAddress: LANE,
      db,
      clock,
      fetchImpl: fetchFrom({}),
      ttlMs: 600_000,
    });
    expect(await down.hourRecord(10)).toEqual({ fees_usd: 3876.8 });
    expect(await down.hourRecord(11)).toBeNull();
  });

  it("delegates k to the basis source (TTL + param_cache)", async () => {
    const db = memDb();
    const clock = fixedClock();
    const engine = createEngineSource({
      apiUrl: "https://engine.test",
      apiKey: "k",
      pool: "NVDA",
      laneAddress: LANE,
      db,
      clock,
      fetchImpl: fetchFrom({ "/basis/NVDA": () => json({ k: 1.0012, session: "2026-09-18" }) }),
      ttlMs: 600_000,
    });
    expect(await engine.basis()).toMatchObject({ k: 1.0012, source: "engine" });
    expect(engine.status(clock.now())).toEqual({ ok: true, ageMs: 0, reason: null });
  });
});
