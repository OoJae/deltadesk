import { describe, expect, it } from "vitest";
import { createHlFeed, type Timers, type WebSocketLike } from "../../../src/sense/hyperliquid.js";
import type { HlTrade } from "../../../src/types.js";
import { fixedClock } from "../../helpers/fakes.js";

class FakeWs implements WebSocketLike {
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  sent: string[] = [];
  closed = false;
  constructor(readonly url: string) {}
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({});
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  push(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

function manualTimers() {
  const intervals: Array<{ fn: () => void; ms: number; live: boolean }> = [];
  const timeouts: Array<{ fn: () => void; ms: number; live: boolean }> = [];
  const timers: Timers = {
    setInterval: (fn, ms) => {
      const h = { fn, ms, live: true };
      intervals.push(h);
      return h;
    },
    clearInterval: (h) => {
      (h as { live: boolean }).live = false;
    },
    setTimeout: (fn, ms) => {
      const h = { fn, ms, live: true };
      timeouts.push(h);
      return h;
    },
    clearTimeout: (h) => {
      (h as { live: boolean }).live = false;
    },
  };
  return { timers, intervals, timeouts };
}

function setup(allMids?: () => Promise<Record<string, string>>) {
  const clock = fixedClock();
  const sockets: FakeWs[] = [];
  const t = manualTimers();
  let restCalls = 0;
  const feed = createHlFeed({
    wsUrl: "wss://hl.test/ws",
    infoUrl: "https://hl.test/info",
    clock,
    timers: t.timers,
    wsFactory: (url) => {
      const s = new FakeWs(url);
      sockets.push(s);
      return s;
    },
    allMids: async () => {
      restCalls++;
      return allMids ? allMids() : { "xyz:NVDA": "222.10" };
    },
  });
  return { feed, clock, sockets, t, rest: () => restCalls };
}

const bbo = (bid: string, ask: string, coin = "xyz:NVDA") => ({
  channel: "bbo",
  data: {
    coin,
    time: 1,
    bbo: [
      { px: bid, sz: "1", n: 1 },
      { px: ask, sz: "1", n: 1 },
    ],
  },
});

describe("Hyperliquid feed", () => {
  it("subscribes to bbo, activeAssetCtx and trades for xyz:NVDA as the tape recorder does", () => {
    const { feed, sockets } = setup();
    feed.start();
    sockets[0]?.open();
    expect(sockets[0]?.sent.map((s) => JSON.parse(s))).toEqual(
      ["bbo", "activeAssetCtx", "trades"].map((type) => ({
        method: "subscribe",
        subscription: { type, coin: "xyz:NVDA" },
      })),
    );
  });

  it("serves the ws touch with mark and oracle, ignoring other coins and crossed books", () => {
    const { feed, sockets, clock } = setup();
    feed.start();
    const ws = sockets[0] as FakeWs;
    ws.open();
    ws.push(bbo("222.00", "222.10"));
    ws.push({
      channel: "activeAssetCtx",
      data: { coin: "xyz:NVDA", ctx: { markPx: "222.04", oraclePx: "222.07" } },
    });
    ws.push(bbo("1", "2", "xyz:TSLA"));
    ws.push(bbo("222.20", "222.10")); // crossed: ignored
    const q = feed.latest();
    expect(q).toMatchObject({
      bid: 222.0,
      ask: 222.1,
      markPx: 222.04,
      oraclePx: 222.07,
      source: "ws",
      receivedAtMs: clock.now(),
    });
    expect(q?.mid).toBeCloseTo(222.05, 9);
    expect(feed.status(clock.now())).toEqual({ ok: true, ageMs: 0, reason: null });
  });

  it("falls back to REST allMids when the ws quote goes stale", async () => {
    const { feed, sockets, clock, t, rest } = setup();
    feed.start();
    await Promise.resolve();
    const ws = sockets[0] as FakeWs;
    ws.open();
    ws.push(bbo("222.00", "222.10"));
    const before = rest();
    clock.advance(6_000);
    t.intervals[0]?.fn(); // the REST poller
    await new Promise((r) => setTimeout(r, 0));
    expect(rest()).toBe(before + 1);
    expect(feed.latest()).toMatchObject({ source: "rest", mid: 222.1 });
    expect(feed.status(clock.now()).reason).toMatch(/REST allMids fallback/);
  });

  it("does not poll REST while the ws is fresh", async () => {
    const { feed, sockets, t, rest } = setup();
    feed.start();
    await new Promise((r) => setTimeout(r, 0));
    const ws = sockets[0] as FakeWs;
    ws.open();
    ws.push(bbo("222.00", "222.10"));
    const n = rest();
    t.intervals[0]?.fn();
    await new Promise((r) => setTimeout(r, 0));
    expect(rest()).toBe(n);
  });

  it("reports an unhealthy source when both ws and REST fail", async () => {
    const { feed, clock, t } = setup(async () => {
      throw new Error("HL down");
    });
    feed.start();
    await new Promise((r) => setTimeout(r, 0));
    expect(feed.latest()).toBeNull();
    expect(feed.status(clock.now())).toMatchObject({ ok: false, ageMs: null });
    expect(feed.status(clock.now()).reason).toMatch(/HL down/);
    t.intervals[0]?.fn();
  });

  it("delivers trades to listeners and unsubscribes", () => {
    const { feed, sockets } = setup();
    feed.start();
    const ws = sockets[0] as FakeWs;
    ws.open();
    const got: HlTrade[] = [];
    const off = feed.onTrade((tr) => got.push(tr));
    const trade = {
      coin: "xyz:NVDA",
      side: "B",
      px: "222.05",
      sz: "0.5",
      time: 9,
      hash: "0xab",
      tid: 42,
    };
    ws.push({ channel: "trades", data: [trade, { ...trade, coin: "xyz:TSLA" }] });
    off();
    ws.push({ channel: "trades", data: [trade] });
    expect(got).toEqual([
      { coin: "xyz:NVDA", side: "B", px: "222.05", sz: "0.5", time: 9, hash: "0xab", tid: 42 },
    ]);
  });

  it("reconnects with backoff after a close, and stop() ends it", async () => {
    const { feed, sockets, t } = setup();
    feed.start();
    (sockets[0] as FakeWs).close();
    expect(t.timeouts).toHaveLength(1);
    expect(t.timeouts[0]?.ms).toBe(1_000);
    t.timeouts[0]?.fn();
    expect(sockets).toHaveLength(2);
    (sockets[1] as FakeWs).close();
    expect(t.timeouts[1]?.ms).toBe(2_000);
    await feed.stop();
    expect(t.intervals.every((h) => !h.live)).toBe(true);
    expect(t.timeouts[1]?.live).toBe(false);
  });
});
