/**
 * Block-pinned chain read: getBlock("latest") first, then Multicall3.aggregate3 AT THAT BLOCK, so
 * every value in a ChainRead is from the same state. A second aggregate3 at the same block reads
 * the NPM details of the position NFTs the first one found.
 *
 * Reads: pool slot0 and liquidity; the lane's views (pool, laneId, owner, operator, guardian,
 * paused, closedUntil, riskAddingOpen, refTick, caps, budgets, positions); the lane's token
 * balances; Chainlink NVDA, USDG and ETH (decimals read live); the stock token's ERC-8056 views;
 * the operator's ETH balance.
 *
 * Fail-closed: a failing required call (pool, lane views, balances, operator ETH) fails the whole
 * read; the lane must be the configured pool's lane. Chainlink rounds and ERC-8056 views are
 * optional and come back null (the fence and the gates treat null as unusable).
 */

import { type Abi, decodeFunctionResult, encodeFunctionData } from "viem";
import { ADDRESSES_4663, NVDA_USDG_POOL, type PoolConfig } from "../addresses.js";
import { deskLaneAbi } from "../executor/abi/DeskLane.js";
import {
  aggregatorV3Abi,
  erc20Abi,
  erc8056Abi,
  multicall3Abi,
  npmAbi,
  uniswapV3PoolAbi,
} from "../executor/abi/external.js";
import type {
  Address,
  ChainClient,
  ChainlinkRound,
  ChainRead,
  ChainReader,
  Hex,
  LaneCaps,
  NpmPosition,
} from "../types.js";

export type { ChainRead, ChainReader, LaneOnchainState } from "../types.js";

export interface ChainReaderOptions {
  client: Pick<ChainClient, "getBlock" | "call">;
  pool?: Pick<PoolConfig, "address" | "token0" | "token1" | "chainlinkBase" | "chainlinkQuote">;
  multicall?: Address;
  npm?: Address;
  chainlinkEth?: Address;
}

interface Spec {
  key: string;
  target: Address;
  abi: Abi;
  fn: string;
  args?: readonly unknown[];
  required: boolean;
}

type EncodeArgs = Parameters<typeof encodeFunctionData>[0];
type DecodeArgs = Parameters<typeof decodeFunctionResult>[0];

function encode(abi: Abi, functionName: string, args: readonly unknown[] = []): Hex {
  return encodeFunctionData({ abi, functionName, args } as unknown as EncodeArgs);
}

function decode(abi: Abi, functionName: string, data: Hex): unknown {
  return decodeFunctionResult({ abi, functionName, data } as unknown as DecodeArgs);
}

export class ChainReadError extends Error {
  constructor(message: string, opts: { cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "ChainReadError";
  }
}

/** One aggregate3 at `blockNumber`; returns decoded values by key (undefined for failed optional calls). */
async function aggregateAt(
  client: Pick<ChainClient, "call">,
  multicall: Address,
  from: Address,
  blockNumber: bigint,
  specs: readonly Spec[],
): Promise<Map<string, unknown>> {
  const calls = specs.map((s) => ({
    target: s.target,
    allowFailure: true,
    callData: encode(s.abi, s.fn, s.args),
  }));
  const data = encode(multicall3Abi as Abi, "aggregate3", [calls]);
  const raw = await client.call({ from, to: multicall, data, blockNumber });
  const results = decode(multicall3Abi as Abi, "aggregate3", raw) as ReadonlyArray<{
    success: boolean;
    returnData: Hex;
  }>;
  if (results.length !== specs.length) {
    throw new ChainReadError(
      `aggregate3 returned ${results.length} results for ${specs.length} calls`,
    );
  }
  const out = new Map<string, unknown>();
  specs.forEach((s, i) => {
    const r = results[i] as { success: boolean; returnData: Hex };
    let value: unknown;
    if (r.success && r.returnData !== "0x") {
      try {
        value = decode(s.abi, s.fn, r.returnData);
      } catch (err) {
        if (s.required)
          throw new ChainReadError(`${s.key}: undecodable return data`, { cause: err });
      }
    } else if (s.required) {
      throw new ChainReadError(`${s.key} reverted at block ${blockNumber}`);
    }
    if (value !== undefined) out.set(s.key, value);
  });
  return out;
}

function round(latest: unknown, decimals: unknown): ChainlinkRound | null {
  if (!Array.isArray(latest) || typeof decimals !== "number") return null;
  const [roundId, answer, , updatedAt] = latest as [bigint, bigint, bigint, bigint, bigint];
  if (typeof answer !== "bigint" || typeof updatedAt !== "bigint") return null;
  return { roundId, answer, decimals, updatedAt, price: Number(answer) / 10 ** decimals };
}

export function createChainReader(opts: ChainReaderOptions): ChainReader {
  const pool = opts.pool ?? NVDA_USDG_POOL;
  const multicall = opts.multicall ?? ADDRESSES_4663.MULTICALL3;
  const npm = opts.npm ?? ADDRESSES_4663.NPM;
  const clEth = opts.chainlinkEth ?? ADDRESSES_4663.CL_ETH_USD;
  const laneAbi = deskLaneAbi as unknown as Abi;

  return {
    async read(laneAddress: Address, operator: Address): Promise<ChainRead> {
      const block = await opts.client.getBlock("latest");
      const at = block.number;
      const lane = (fn: string): Spec => ({
        key: `lane.${fn}`,
        target: laneAddress,
        abi: laneAbi,
        fn,
        required: true,
      });
      const cl = (key: string, target: Address): Spec[] => [
        {
          key: `${key}.latest`,
          target,
          abi: aggregatorV3Abi,
          fn: "latestRoundData",
          required: false,
        },
        { key: `${key}.decimals`, target, abi: aggregatorV3Abi, fn: "decimals", required: false },
      ];
      const stock = (fn: string): Spec => ({
        key: `stock.${fn}`,
        target: pool.token1,
        abi: erc8056Abi,
        fn,
        required: false,
      });

      const v = await aggregateAt(opts.client, multicall, operator, at, [
        {
          key: "pool.slot0",
          target: pool.address,
          abi: uniswapV3PoolAbi,
          fn: "slot0",
          required: true,
        },
        {
          key: "pool.liquidity",
          target: pool.address,
          abi: uniswapV3PoolAbi,
          fn: "liquidity",
          required: true,
        },
        ...[
          "pool",
          "laneId",
          "owner",
          "operator",
          "guardian",
          "paused",
          "closedUntil",
          "riskAddingOpen",
          "refTick",
          "caps",
          "budgets",
          "positions",
        ].map(lane),
        {
          key: "bal0",
          target: pool.token0,
          abi: erc20Abi,
          fn: "balanceOf",
          args: [laneAddress],
          required: true,
        },
        {
          key: "bal1",
          target: pool.token1,
          abi: erc20Abi,
          fn: "balanceOf",
          args: [laneAddress],
          required: true,
        },
        ...cl("nvda", pool.chainlinkBase),
        ...cl("usdg", pool.chainlinkQuote),
        ...cl("eth", clEth),
        stock("oraclePaused"),
        stock("uiMultiplier"),
        stock("newUIMultiplier"),
        stock("effectiveAt"),
        {
          key: "operatorEth",
          target: multicall,
          abi: multicall3Abi as Abi,
          fn: "getEthBalance",
          args: [operator],
          required: true,
        },
      ]);

      const lanePool = v.get("lane.pool") as Address;
      if (lanePool.toLowerCase() !== pool.address.toLowerCase()) {
        throw new ChainReadError(
          `lane ${laneAddress} trades pool ${lanePool}, not the configured ${pool.address}`,
        );
      }
      const tokenIds = v.get("lane.positions") as readonly [bigint, bigint];
      const live = ([0, 1] as const).filter((slot) => tokenIds[slot] !== 0n);
      const details: [NpmPosition | null, NpmPosition | null] = [null, null];
      if (live.length > 0) {
        const pv = await aggregateAt(
          opts.client,
          multicall,
          operator,
          at,
          live.map((slot) => ({
            key: `npm.${slot}`,
            target: npm,
            abi: npmAbi,
            fn: "positions",
            args: [tokenIds[slot]],
            required: false,
          })),
        );
        for (const slot of live) {
          const p = pv.get(`npm.${slot}`) as readonly unknown[] | undefined;
          if (p === undefined) continue;
          details[slot] = {
            tokenId: tokenIds[slot],
            tickLower: p[5] as number,
            tickUpper: p[6] as number,
            liquidity: p[7] as bigint,
            feeGrowthInside0LastX128: p[8] as bigint,
            feeGrowthInside1LastX128: p[9] as bigint,
            tokensOwed0: p[10] as bigint,
            tokensOwed1: p[11] as bigint,
          };
        }
      }

      const slot0 = v.get("pool.slot0") as readonly [
        bigint,
        number,
        number,
        number,
        number,
        number,
        boolean,
      ];
      const [open, openCode] = v.get("lane.riskAddingOpen") as readonly [boolean, number];
      const [refTick, bandTicks, refCode] = v.get("lane.refTick") as readonly [
        number,
        number,
        number,
      ];
      const [turnover, rr1h, rr24h, nextAt] = v.get("lane.budgets") as readonly [
        bigint,
        bigint,
        bigint,
        bigint,
      ];
      const opt = <T>(key: string): T | null => (v.has(key) ? (v.get(key) as T) : null);

      return {
        blockNumber: block.number,
        blockTimestamp: block.timestamp,
        blockHash: block.hash,
        baseFeePerGas: block.baseFeePerGas,
        pool: {
          sqrtPriceX96: slot0[0],
          tick: slot0[1],
          liquidity: v.get("pool.liquidity") as bigint,
          unlocked: slot0[6],
        },
        lane: {
          laneAddress,
          laneId: v.get("lane.laneId") as number,
          owner: v.get("lane.owner") as Address,
          operator: v.get("lane.operator") as Address,
          guardian: v.get("lane.guardian") as Address,
          paused: v.get("lane.paused") as boolean,
          closedUntil: v.get("lane.closedUntil") as bigint,
          riskAddingOpen: { open, code: openCode },
          refTick: { tick: refTick, bandTicks, code: refCode },
          caps: v.get("lane.caps") as LaneCaps,
          budgets: {
            turnoverAvailableUsd6: turnover,
            reranges1hLeft: rr1h,
            reranges24hLeft: rr24h,
            nextRerangeAt: nextAt,
          },
          positions: [tokenIds[0], tokenIds[1]],
          positionDetails: details,
          balances: { token0: v.get("bal0") as bigint, token1: v.get("bal1") as bigint },
        },
        chainlink: {
          nvda: round(v.get("nvda.latest"), v.get("nvda.decimals")),
          usdg: round(v.get("usdg.latest"), v.get("usdg.decimals")),
          eth: round(v.get("eth.latest"), v.get("eth.decimals")),
        },
        stockToken: {
          oraclePaused: opt<boolean>("stock.oraclePaused"),
          uiMultiplier: opt<bigint>("stock.uiMultiplier"),
          newUiMultiplier: opt<bigint>("stock.newUIMultiplier"),
          effectiveAt: opt<bigint>("stock.effectiveAt"),
        },
        operatorEthWei: v.get("operatorEth") as bigint,
      };
    },
  };
}
