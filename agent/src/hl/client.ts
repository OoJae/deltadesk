/**
 * Hyperliquid clients over @nktkas/hyperliquid 0.33.3 (method names checked against the installed
 * package: InfoClient.allMids({dex}), meta({dex}), perpDexs(); ExchangeClient.order({orders,
 * grouping}), cancelByCloid({cancels})).
 *
 * - Info (read-only) is always available: allMids for the `xyz` dex and asset metadata. HIP-3 asset
 *   ids are 100000 + dexIndex × 10000 + index-in-universe (xyz:NVDA → 110002).
 * - Exchange (LIVE) is refused unless HL_MODE=live AND HL_ARM=1 AND an agent key is present; the
 *   paper path never constructs it. It is unused in M2.
 */

import { ExchangeClient, HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import { privateKeyToAccount } from "viem/accounts";
import {
  ConfigRefusedError,
  type Hex,
  type HlAssetMeta,
  type HlExchangeClient,
  type HlInfoClient,
  type HlMode,
  type HlOrderRequest,
  type HlOrderResult,
} from "../types.js";

export type { HlAssetMeta, HlExchangeClient, HlInfoClient } from "../types.js";

/** Minimal transport seam (the SDK's IRequestTransport), so tests never touch the network. */
export interface HlTransport {
  isTestnet: boolean;
  request<T>(
    endpoint: "info" | "exchange" | "explorer",
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<T>;
}

/** HL_INFO_URL is `…/info`; the SDK wants the API base. */
export function apiBaseFromInfoUrl(infoUrl: string): string {
  return infoUrl.replace(/\/+$/, "").replace(/\/info$/, "");
}

export function httpTransport(infoUrl: string, timeoutMs = 10_000): HlTransport {
  return new HttpTransport({ apiUrl: apiBaseFromInfoUrl(infoUrl), timeout: timeoutMs });
}

export function hip3AssetId(dexIndex: number, universeIndex: number): number {
  return dexIndex === 0 ? universeIndex : 100_000 + dexIndex * 10_000 + universeIndex;
}

export function createHlInfoClient(transport: HlTransport): HlInfoClient {
  const info = new InfoClient({ transport });
  const metaCache = new Map<string, HlAssetMeta>();
  return {
    async allMids(dex) {
      return dex === "" ? info.allMids() : info.allMids({ dex });
    },
    async assetMeta(coin) {
      const hit = metaCache.get(coin);
      if (hit !== undefined) return hit;
      const dex = coin.includes(":") ? (coin.split(":")[0] as string) : "";
      const meta = dex === "" ? await info.meta() : await info.meta({ dex });
      const idx = meta.universe.findIndex((u) => u.name === coin);
      if (idx < 0) throw new Error(`hyperliquid: ${coin} is not in the ${dex || "main"} universe`);
      let dexIndex = 0;
      if (dex !== "") {
        const dexs = await info.perpDexs();
        dexIndex = dexs.findIndex((d) => d !== null && d.name === dex);
        if (dexIndex <= 0) throw new Error(`hyperliquid: perp dex "${dex}" not found`);
      }
      const u = meta.universe[idx] as (typeof meta.universe)[number];
      const out: HlAssetMeta = {
        name: coin,
        assetId: hip3AssetId(dexIndex, idx),
        szDecimals: u.szDecimals,
        maxLeverage: u.maxLeverage,
      };
      metaCache.set(coin, out);
      return out;
    },
  };
}

export interface HlExchangeOptions {
  mode: HlMode;
  armed: boolean;
  agentPrivateKey: Hex | undefined;
  transport: HlTransport;
}

type OrderStatus =
  | { resting: { oid: number; cloid?: Hex } }
  | { filled: { totalSz: string; avgPx: string; oid: number; cloid?: Hex } }
  | { error: string }
  | "waitingForFill"
  | "waitingForTrigger";

export function orderResultOf(cloid: Hex, status: OrderStatus | undefined): HlOrderResult {
  if (status === undefined)
    return {
      cloid,
      status: "rejected",
      oid: null,
      filledSz: "0",
      avgPx: null,
      error: "no status returned",
    };
  if (typeof status === "string")
    return { cloid, status: "open", oid: null, filledSz: "0", avgPx: null, error: null };
  if ("resting" in status)
    return {
      cloid,
      status: "open",
      oid: status.resting.oid,
      filledSz: "0",
      avgPx: null,
      error: null,
    };
  if ("filled" in status) {
    return {
      cloid,
      status: "filled",
      oid: status.filled.oid,
      filledSz: status.filled.totalSz,
      avgPx: status.filled.avgPx,
      error: null,
    };
  }
  return { cloid, status: "rejected", oid: null, filledSz: "0", avgPx: null, error: status.error };
}

/** The LIVE exchange client. Refuses to exist unless HL_MODE=live + HL_ARM=1 + an agent key. */
export function createHlExchangeClient(opts: HlExchangeOptions): HlExchangeClient {
  if (opts.mode !== "live" || !opts.armed || opts.agentPrivateKey === undefined) {
    throw new ConfigRefusedError(
      "the Hyperliquid exchange client needs HL_MODE=live, HL_ARM=1 and HL_AGENT_PRIVATE_KEY",
    );
  }
  const exchange = new ExchangeClient({
    transport: opts.transport,
    wallet: privateKeyToAccount(opts.agentPrivateKey),
  });
  return {
    async placeOrder(order: HlOrderRequest): Promise<HlOrderResult> {
      try {
        const res = await exchange.order({
          orders: [
            {
              a: order.asset,
              b: order.isBuy,
              p: order.px,
              s: order.sz,
              r: order.reduceOnly,
              t: { limit: { tif: order.tif } },
              c: order.cloid,
            },
          ],
          grouping: "na",
        });
        return orderResultOf(order.cloid, res.response.data.statuses[0] as OrderStatus | undefined);
      } catch (err) {
        return {
          cloid: order.cloid,
          status: "rejected",
          oid: null,
          filledSz: "0",
          avgPx: null,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
    async cancelByCloid(asset, cloid) {
      await exchange.cancelByCloid({ cancels: [{ asset, cloid }] });
    },
  };
}
