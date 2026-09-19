import { describe, expect, it } from "vitest";
import { etToEpochSec } from "../../src/market/calendar.js";
import {
  createBasisSource,
  fairValue,
  gapBps,
  median,
  poolMidFromSqrt,
} from "../../src/market/fair-value.js";
import type { TickRow } from "../../src/types.js";
import { fixedClock, LANE, memDb } from "../helpers/fakes.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("fair value math", () => {
  it("gapBps = 1e4·ln(F/poolMid): positive when fair value is above the pool", () => {
    expect(gapBps(101, 100)).toBeCloseTo(1e4 * Math.log(1.01), 9);
    expect(gapBps(100, 101)).toBeLessThan(0);
    expect(gapBps(100, 100)).toBe(0);
    expect(() => gapBps(0, 100)).toThrow(RangeError);
    expect(() => gapBps(100, Number.NaN)).toThrow(RangeError);
  });

  it("F = HL · k", () => {
    const fv = fairValue(
      220,
      { k: 1.01, source: "engine", session: "2026-09-18", fetchedAtMs: 0 },
      222.2,
    );
    expect(fv.F).toBeCloseTo(222.2, 9);
    expect(fv.gapBps).toBeCloseTo(0, 6);
    expect(fv.kSource).toBe("engine");
    expect(() => fairValue(-1, { k: 1, source: "self", session: null, fetchedAtMs: 0 }, 1)).toThrow(
      RangeError,
    );
  });

  it("reads the pool mid in USDG per NVDA", () => {
    expect(poolMidFromSqrt(5312783984510461862243962879021140n)).toBeCloseTo(222.39, 0);
  });

  it("median handles odd and even lengths", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(() => median([])).toThrow(RangeError);
  });
});

describe("createBasisSource", () => {
  const base = {
    apiUrl: "https://engine.test/",
    pool: "NVDA",
    laneAddress: LANE,
    ttlMs: 600_000,
  };

  it("fetches k with the premium header, caches it for the TTL, and persists the last good value", async () => {
    const db = memDb();
    const clock = fixedClock();
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, headers: init?.headers as Record<string, string> });
      return json({ pool: "NVDA/USDG", k: 1.0123, session: "2026-09-18", source: "hl_ref" });
    }) as typeof fetch;
    const src = createBasisSource({ ...base, apiKey: "premium-key", db, clock, fetchImpl });

    const k1 = await src.getK();
    expect(k1).toMatchObject({ k: 1.0123, source: "engine", session: "2026-09-18" });
    expect(calls[0]?.url).toBe("https://engine.test/basis/NVDA");
    expect(calls[0]?.headers["x-deltadesk-key"]).toBe("premium-key");

    clock.advance(60_000);
    await src.getK();
    expect(calls).toHaveLength(1); // within TTL: no refetch
    expect(JSON.parse(db.getParam("basis:NVDA")?.valueJson ?? "{}").k).toBe(1.0123);

    clock.advance(600_000);
    await src.getK();
    expect(calls).toHaveLength(2);
    expect(src.status(clock.now()).ok).toBe(true);
  });

  it("falls back to the cached last good value when the engine is down", async () => {
    const db = memDb();
    const clock = fixedClock();
    db.setParam(
      "basis:NVDA",
      JSON.stringify({ k: 1.02, session: "2026-09-17", engineSource: "hl_ref" }),
      {
        source: "engine",
        fetchedAtMs: clock.now() - 3_600_000,
        ttlMs: 600_000,
      },
    );
    const fetchImpl = (async () => json({ detail: "down" }, 503)) as unknown as typeof fetch;
    const src = createBasisSource({ ...base, apiKey: undefined, db, clock, fetchImpl });
    const k = await src.getK();
    expect(k).toMatchObject({ k: 1.02, source: "cache", session: "2026-09-17" });
    expect(src.status(clock.now()).reason).toContain("503");
  });

  it("rejects an implausible k and ignores a too-old cache, then self-computes from ticks", async () => {
    const db = memDb();
    const clock = fixedClock(); // Mon Sep 21 10:00 ET → last completed session Fri Sep 18
    db.setParam(
      "basis:NVDA",
      JSON.stringify({ k: 1.02, session: "2026-09-10", engineSource: null }),
      {
        source: "engine",
        fetchedAtMs: clock.now() - 10 * 24 * 3_600_000,
        ttlMs: 600_000,
      },
    );
    const start = etToEpochSec(2026, 9, 18, 10, 0) * 1000;
    for (let i = 0; i < 40; i++) {
      const row: Omit<TickRow, "id"> = {
        laneAddress: LANE,
        atMs: start + i * 60_000,
        blockNumber: null,
        blockTs: null,
        poolTick: null,
        sqrtPriceX96: null,
        poolMid: 222 + (i % 3) * 0.1,
        hlMid: 220,
        k: null,
        kSource: null,
        fairValue: null,
        gapBps: null,
        refTick: null,
        bandTicks: null,
        fenceCode: null,
        regime: "REGULAR",
        reopenKind: null,
        sessionDate: "2026-09-18",
        gatesMask: 0,
        activeGatesJson: "[]",
        riskMode: "normal",
        sourcesJson: "{}",
      };
      db.insertTick(row);
    }
    const fetchImpl = (async () => json({ k: 50 })) as unknown as typeof fetch;
    const src = createBasisSource({ ...base, apiKey: undefined, db, clock, fetchImpl });
    const k = await src.getK();
    expect(k?.source).toBe("self");
    expect(k?.session).toBe("2026-09-18");
    expect(k?.k).toBeCloseTo(222.1 / 220, 9);
  });

  it("returns null (and a failing status) when nothing is available", async () => {
    const db = memDb();
    const clock = fixedClock();
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const src = createBasisSource({ ...base, apiKey: undefined, db, clock, fetchImpl });
    expect(await src.getK()).toBeNull();
    const s = src.status(clock.now());
    expect(s.ok).toBe(false);
    expect(s.reason).toContain("ECONNREFUSED");
  });
});
