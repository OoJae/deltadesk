import { describe, expect, it } from "vitest";
import {
  createHlExecutor,
  createPaperFillEngine,
  hlCloid,
} from "../../../src/executor/hl-executor.js";
import {
  apiBaseFromInfoUrl,
  createHlExchangeClient,
  createHlInfoClient,
  type HlTransport,
  hip3AssetId,
  orderResultOf,
} from "../../../src/hl/client.js";
import {
  decAdd,
  decCmp,
  decSub,
  decVwap,
  formatPassivePx,
  hlFormatter,
} from "../../../src/hl/format.js";
import { silentLogger } from "../../../src/log.js";
import {
  ConfigRefusedError,
  type HedgeAction,
  type HlAssetMeta,
  type HlExchangeClient,
  type HlQuote,
  type HlTrade,
  type StepRequest,
} from "../../../src/types.js";
import { fixedClock, memDb } from "../../helpers/fakes.js";
import { ANVIL_KEY_0, LANE, seedDecision, T0 } from "../executor/_fixtures.js";

const META: HlAssetMeta = { name: "xyz:NVDA", assetId: 110002, szDecimals: 3, maxLeverage: 10 };

describe("HL formatting", () => {
  it("prices: 5 significant figures, ≤ 6 − szDecimals decimals, integers always allowed", () => {
    expect(hlFormatter.formatPx(222.456789, META)).toBe("222.45");
    expect(hlFormatter.formatPx(123456, META)).toBe("123456");
    expect(hlFormatter.formatPx(123456.7, META)).toBe("123450");
    expect(hlFormatter.formatPx(0.0123456, { ...META, szDecimals: 0 })).toBe("0.012345");
    expect(hlFormatter.formatSz(1.23456, META)).toBe("1.234");
    expect(() => hlFormatter.formatSz(0.0001, META)).toThrow();
  });

  it("post-only prices never move toward the touch because of rounding", () => {
    expect(formatPassivePx(222.456, META, true)).toBe("222.45");
    expect(formatPassivePx(222.456, META, false)).toBe("222.46");
    expect(formatPassivePx(222.45, META, false)).toBe("222.45");
  });

  it("exact decimal-string arithmetic", () => {
    expect(decAdd("0.1", "0.2")).toBe("0.3");
    expect(decSub("1", "0.001")).toBe("0.999");
    expect(decCmp("222.45", "222.450")).toBe(0);
    expect(decVwap(null, "0", "222", "1")).toBe("222");
    expect(decVwap("222", "1", "224", "1")).toBe("223");
  });
});

describe("HL clients over @nktkas/hyperliquid (fake transport)", () => {
  function transport(responses: Record<string, unknown>) {
    const seen: Array<{ endpoint: string; payload: Record<string, unknown> }> = [];
    const t: HlTransport = {
      isTestnet: false,
      async request<T>(endpoint: "info" | "exchange" | "explorer", payload: unknown): Promise<T> {
        const p = payload as Record<string, unknown>;
        seen.push({ endpoint, payload: p });
        const key =
          endpoint === "exchange"
            ? `exchange:${(p.action as { type: string }).type}`
            : String(p.type);
        if (!(key in responses)) throw new Error(`no fake response for ${key}`);
        return responses[key] as T;
      },
    };
    return { t, seen };
  }

  it("allMids for the xyz dex, and HIP-3 asset metadata (xyz:NVDA → 110002)", async () => {
    const { t, seen } = transport({
      allMids: { "xyz:NVDA": "222.5" },
      meta: {
        universe: [
          { name: "xyz:AAPL", szDecimals: 3, maxLeverage: 10, marginTableId: 1 },
          { name: "xyz:TSLA", szDecimals: 3, maxLeverage: 10, marginTableId: 1 },
          { name: "xyz:NVDA", szDecimals: 3, maxLeverage: 10, marginTableId: 1 },
        ],
        marginTables: [],
        collateralToken: 0,
      },
      perpDexs: [
        null,
        {
          name: "xyz",
          fullName: "XYZ",
          deployer: `0x${"1".repeat(40)}`,
          oracleUpdater: null,
          feeRecipient: null,
          assetToStreamingOiCap: [],
        },
      ],
    });
    const info = createHlInfoClient(t);
    expect(await info.allMids("xyz")).toEqual({ "xyz:NVDA": "222.5" });
    expect(seen[0]?.payload).toEqual({ type: "allMids", dex: "xyz" });
    expect(await info.assetMeta("xyz:NVDA")).toEqual(META);
    expect(hip3AssetId(1, 2)).toBe(110002);
    expect(hip3AssetId(0, 5)).toBe(5);
    expect(apiBaseFromInfoUrl("https://api.hyperliquid.xyz/info")).toBe(
      "https://api.hyperliquid.xyz",
    );
  });

  it("the LIVE exchange client refuses to exist unless HL_MODE=live + HL_ARM=1 + a key", () => {
    const { t } = transport({});
    expect(() =>
      createHlExchangeClient({
        mode: "paper",
        armed: true,
        agentPrivateKey: ANVIL_KEY_0,
        transport: t,
      }),
    ).toThrow(ConfigRefusedError);
    expect(() =>
      createHlExchangeClient({
        mode: "live",
        armed: false,
        agentPrivateKey: ANVIL_KEY_0,
        transport: t,
      }),
    ).toThrow(ConfigRefusedError);
    expect(() =>
      createHlExchangeClient({
        mode: "live",
        armed: true,
        agentPrivateKey: undefined,
        transport: t,
      }),
    ).toThrow(ConfigRefusedError);
  });

  it("places one signed ALO order with the cloid and maps the status", async () => {
    const { t, seen } = transport({
      "exchange:order": {
        status: "ok",
        response: { type: "order", data: { statuses: [{ resting: { oid: 42 } }] } },
      },
    });
    const ex = createHlExchangeClient({
      mode: "live",
      armed: true,
      agentPrivateKey: ANVIL_KEY_0,
      transport: t,
    });
    const cloid = hlCloid("01K5HZ3N8QW000000000000001", 0);
    const r = await ex.placeOrder({
      cloid,
      coin: "xyz:NVDA",
      asset: 110002,
      isBuy: true,
      sz: "0.1",
      px: "222.45",
      tif: "Alo",
      reduceOnly: false,
    });
    expect(r).toEqual({ cloid, status: "open", oid: 42, filledSz: "0", avgPx: null, error: null });
    const action = seen[0]?.payload.action as { orders: Array<Record<string, unknown>> };
    expect(action.orders[0]).toMatchObject({
      a: 110002,
      b: true,
      p: "222.45",
      s: "0.1",
      r: false,
      t: { limit: { tif: "Alo" } },
      c: cloid,
    });
    expect(
      orderResultOf(cloid, { error: "Post only order would have immediately matched" }).status,
    ).toBe("rejected");
    expect(
      orderResultOf(cloid, { filled: { totalSz: "0.1", avgPx: "222.4", oid: 1 } }).status,
    ).toBe("filled");
  });
});

// ---------------------------------------------------------------------------------------------

const hedge = (p: Partial<HedgeAction> = {}): HedgeAction => ({
  kind: "hedge",
  lane: "B",
  coin: "xyz:NVDA",
  asset: 110002,
  isBuy: true,
  sz: "1",
  px: "222",
  tif: "Alo",
  reduceOnly: false,
  ...p,
});

function hlSetup(mode: "paper" | "live", armed = false, quote: HlQuote | null = null) {
  const db = memDb();
  const clock = fixedClock(T0);
  const placed: unknown[] = [];
  const exchange: HlExchangeClient = {
    placeOrder: async (o) => {
      placed.push(o);
      return { cloid: o.cloid, status: "open", oid: 9, filledSz: "0", avgPx: null, error: null };
    },
    cancelByCloid: async () => {
      placed.push("cancel");
    },
  };
  const executor = createHlExecutor({
    db,
    mode,
    armed,
    exchange,
    quote: () => quote,
    clock,
    logger: silentLogger,
  });
  const engine = createPaperFillEngine({ db, clock, iocWindowMs: 2_000 });
  const req = (action: HedgeAction): StepRequest => ({
    decisionId: seedDecision(db, { lane: "B" }),
    step: 0,
    lane: "B",
    laneAddress: LANE,
    action,
    meta: {
      decisionId: `0x${"0".repeat(63)}1`,
      deadline: 1n,
      regime: 1,
      gatesMask: 0,
      reasonHash: `0x${"0".repeat(64)}`,
    },
    riskClass: action.reduceOnly ? "reducing" : "adding",
    notionalCents: 22_200,
  });
  return { db, clock, placed, executor, engine, req };
}

const trade = (px: string, sz: string, tid: number, time = T0 + 1_000): HlTrade => ({
  coin: "xyz:NVDA",
  side: "A",
  px,
  sz,
  time,
  hash: `0x${"0".repeat(64)}`,
  tid,
});

describe("HL executor: paper mode", () => {
  it("never calls the exchange; records a resting paper order", async () => {
    const s = hlSetup("paper");
    const prepared = await s.executor.prepare(s.req(hedge()));
    expect(prepared.venue).toBe("hl");
    expect(prepared.hlOrder?.cloid).toMatch(/^0x[0-9a-f]{32}$/);
    const out = await s.executor.execute(prepared);
    expect(out.status).toBe("confirmed");
    expect(s.placed).toHaveLength(0);
    expect(s.db.getHlOrder(prepared.hlOrder?.cloid as `0x${string}`)).toMatchObject({
      mode: "paper",
      status: "open",
    });
  });

  it("ALO fills only on a trade THROUGH the limit, at the limit, partially, deduped", async () => {
    const s = hlSetup("paper");
    const prepared = await s.executor.prepare(s.req(hedge({ sz: "1", px: "222" })));
    await s.executor.execute(prepared);
    const cloid = prepared.hlOrder?.cloid as `0x${string}`;
    expect(s.engine.onTrade(trade("222", "5", 1))).toBe(0); // at the limit: queue position unknown
    expect(s.engine.onTrade(trade("221.9", "0.4", 2))).toBe(1);
    expect(s.engine.onTrade(trade("221.9", "0.4", 2))).toBe(0); // same tid
    expect(s.db.getHlOrder(cloid)).toMatchObject({
      status: "partially_filled",
      filledSz: "0.4",
      avgPx: "222",
    });
    expect(s.engine.onTrade(trade("221.5", "5", 3))).toBe(1);
    expect(s.db.getHlOrder(cloid)).toMatchObject({ status: "filled", filledSz: "1" });
    expect(s.db.hlFillsForOrder(cloid).map((f) => f.sz)).toEqual(["0.4", "0.6"]);
    expect(s.db.hlFillsByCoin("xyz:NVDA", true)).toHaveLength(2);
  });

  it("trades before the order was placed never fill it", async () => {
    const s = hlSetup("paper");
    const prepared = await s.executor.prepare(s.req(hedge()));
    await s.executor.execute(prepared);
    expect(s.engine.onTrade(trade("200", "5", 1, T0 - 1))).toBe(0);
  });

  it("IOC matches at the trade price within its window, otherwise it is cancelled", async () => {
    const s = hlSetup("paper");
    const a = await s.executor.prepare(
      s.req(hedge({ tif: "Ioc", isBuy: false, px: "222", sz: "2" })),
    );
    await s.executor.execute(a);
    expect(s.engine.onTrade(trade("222.3", "1", 1))).toBe(1);
    expect(s.db.getHlOrder(a.hlOrder?.cloid as `0x${string}`)).toMatchObject({
      status: "canceled",
      filledSz: "1",
      avgPx: "222.3",
    });
    const b = await s.executor.prepare(s.req(hedge({ tif: "Ioc" })));
    await s.executor.execute(b);
    expect(s.engine.expire(T0 + 3_000)).toBe(1);
    expect(s.db.getHlOrder(b.hlOrder?.cloid as `0x${string}`)?.status).toBe("canceled");
  });

  it("a post-only order that would cross the current quote is rejected", async () => {
    const quote: HlQuote = {
      coin: "xyz:NVDA",
      bid: 221.9,
      ask: 222.1,
      mid: 222,
      markPx: null,
      oraclePx: null,
      exchangeTimeMs: null,
      receivedAtMs: T0,
      source: "ws",
    };
    const s = hlSetup("paper", false, quote);
    const out = await s.executor.execute(await s.executor.prepare(s.req(hedge({ px: "222.2" }))));
    expect(out.status).toBe("failed");
  });

  it("attach() wires the tape; the unsubscribe function is returned", async () => {
    const s = hlSetup("paper");
    let listener: ((t: HlTrade) => void) | null = null;
    const off = s.engine.attach({
      onTrade: (l) => {
        listener = l;
        return () => {
          listener = null;
        };
      },
    });
    await s.executor.execute(await s.executor.prepare(s.req(hedge())));
    (listener as unknown as (t: HlTrade) => void)(trade("200", "1", 1));
    expect(s.db.openHlOrders("paper")).toHaveLength(0);
    off();
    expect(listener).toBeNull();
  });
});

describe("HL executor: live mode", () => {
  it("not armed → failed without touching the exchange", async () => {
    const s = hlSetup("live", false);
    const out = await s.executor.execute(await s.executor.prepare(s.req(hedge())));
    expect(out.status).toBe("failed");
    expect(s.placed).toHaveLength(0);
  });

  it("armed → one order to the exchange, recorded", async () => {
    const s = hlSetup("live", true);
    const prepared = await s.executor.prepare(s.req(hedge()));
    const out = await s.executor.execute(prepared);
    expect(out.status).toBe("confirmed");
    expect(s.placed).toHaveLength(1);
    expect(s.db.getHlOrder(prepared.hlOrder?.cloid as `0x${string}`)).toMatchObject({
      mode: "live",
      status: "open",
      oid: 9,
    });
  });

  it("rejects non-hedge steps and bad sizes; the same step cannot run twice", async () => {
    const s = hlSetup("paper");
    await expect(
      s.executor.prepare({
        ...s.req(hedge()),
        action: { kind: "collect", lane: "B" },
        riskClass: "reducing",
      }),
    ).rejects.toThrow(/only hedge/);
    await expect(s.executor.prepare(s.req(hedge({ sz: "0" })))).rejects.toThrow(/bad size/);
    const p = await s.executor.prepare(s.req(hedge()));
    await s.executor.execute(p);
    await expect(s.executor.execute(p)).rejects.toMatchObject({ code: "SIM_DECISION_USED" });
    expect(hlCloid("01K5HZ3N8QW000000000000001", 1)).not.toBe(
      hlCloid("01K5HZ3N8QW000000000000001", 0),
    );
  });
});
