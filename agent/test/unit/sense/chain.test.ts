import { type Abi, decodeFunctionData, encodeFunctionResult, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { ADDRESSES_4663, NVDA_USDG_POOL } from "../../../src/addresses.js";
import { deskLaneAbi } from "../../../src/executor/abi/DeskLane.js";
import {
  aggregatorV3Abi,
  erc20Abi,
  erc8056Abi,
  multicall3Abi,
  npmAbi,
  uniswapV3PoolAbi,
} from "../../../src/executor/abi/external.js";
import { ChainReadError, createChainReader } from "../../../src/sense/chain.js";
import {
  DEFAULT_LANE_CAPS,
  MOCK_LANE,
  MOCK_OPERATOR,
  MOCK_OWNER,
} from "../../../src/sense/mock.js";
import type { Address, BlockHeader, ChainClient } from "../../../src/types.js";

type Handler = Record<string, ((args: readonly unknown[]) => unknown) | undefined>;

const BLOCK: BlockHeader = {
  number: 123_456n,
  timestamp: 1_790_000_000n,
  hash: `0x${"cd".repeat(32)}`,
  baseFeePerGas: 66_400_000n,
};

function world() {
  const lane: Handler = {
    pool: () => NVDA_USDG_POOL.address,
    laneId: () => 0,
    owner: () => MOCK_OWNER,
    operator: () => MOCK_OPERATOR,
    guardian: () => "0x0000000000000000000000000000000000000000",
    paused: () => false,
    closedUntil: () => 0n,
    riskAddingOpen: () => [true, 0],
    refTick: () => [222277, 100, 0],
    caps: () => DEFAULT_LANE_CAPS,
    budgets: () => [150_000_000n, 4n, 24n, 0n],
    positions: () => [77n, 0n],
  };
  const contracts: Record<string, { abi: Abi; h: Handler }> = {
    [MOCK_LANE.toLowerCase()]: { abi: deskLaneAbi as unknown as Abi, h: lane },
    [NVDA_USDG_POOL.address.toLowerCase()]: {
      abi: uniswapV3PoolAbi,
      h: {
        slot0: () => [5312359905924111789169988187832333n, 222275, 1, 1, 1, 0, true],
        liquidity: () => 28490635125232108064n,
      },
    },
    [ADDRESSES_4663.USDG.toLowerCase()]: { abi: erc20Abi, h: { balanceOf: () => 25_000_000n } },
    [ADDRESSES_4663.NVDA.toLowerCase()]: {
      abi: [...erc20Abi, ...erc8056Abi],
      h: {
        balanceOf: () => 10n ** 17n,
        oraclePaused: () => false,
        uiMultiplier: () => 10n ** 18n,
        newUIMultiplier: () => 10n ** 18n,
        effectiveAt: () => 0n,
      },
    },
    [ADDRESSES_4663.CL_NVDA_USD.toLowerCase()]: {
      abi: aggregatorV3Abi,
      h: {
        decimals: () => 8,
        latestRoundData: () => [5n, 22_242_000_000n, 0n, 1_789_999_000n, 5n],
      },
    },
    [ADDRESSES_4663.CL_USDG_USD.toLowerCase()]: {
      abi: aggregatorV3Abi,
      h: { decimals: () => 8, latestRoundData: () => [1n, 100_000_000n, 0n, 1_789_990_000n, 1n] },
    },
    [ADDRESSES_4663.CL_ETH_USD.toLowerCase()]: { abi: aggregatorV3Abi, h: {} }, // reverts: optional
    [ADDRESSES_4663.NPM.toLowerCase()]: {
      abi: npmAbi,
      h: {
        positions: ([id]) =>
          [
            0n,
            MOCK_LANE,
            ADDRESSES_4663.USDG,
            ADDRESSES_4663.NVDA,
            500,
            222160,
            222370,
            10n ** 15n,
            1n,
            2n,
            3n,
            4n,
          ].map((x, i) => (i === 0 && id !== 77n ? 0n : x)),
      },
    },
    [ADDRESSES_4663.MULTICALL3.toLowerCase()]: {
      abi: multicall3Abi as Abi,
      h: { getEthBalance: () => 5n * 10n ** 15n },
    },
  };
  const calls: Array<{ blockNumber: bigint; to: Address; from: Address }> = [];
  const client: Pick<ChainClient, "getBlock" | "call"> = {
    async getBlock() {
      return BLOCK;
    },
    async call(req) {
      calls.push({ blockNumber: req.blockNumber, to: req.to, from: req.from });
      const { args } = decodeFunctionData({ abi: multicall3Abi, data: req.data });
      const sub = (args?.[0] ?? []) as ReadonlyArray<{ target: Address; callData: Hex }>;
      const results = sub.map(({ target, callData }) => {
        const c = contracts[target.toLowerCase()];
        if (c === undefined) return { success: false, returnData: "0x" as Hex };
        const d = decodeFunctionData({ abi: c.abi, data: callData });
        const fn = c.h[d.functionName];
        if (fn === undefined) return { success: false, returnData: "0x" as Hex };
        const result = fn(d.args ?? []);
        return {
          success: true,
          returnData: encodeFunctionResult({
            abi: c.abi,
            functionName: d.functionName,
            result,
          } as never),
        };
      });
      return encodeFunctionResult({
        abi: multicall3Abi,
        functionName: "aggregate3",
        result: results,
      });
    },
  };
  return { client, calls, lane, contracts };
}

describe("block-pinned chain read", () => {
  it("reads every value through Multicall3 at the block getBlock returned", async () => {
    const w = world();
    const read = await createChainReader({ client: w.client }).read(MOCK_LANE, MOCK_OPERATOR);
    expect(w.calls).toHaveLength(2); // lane state, then the NPM details of the live slot
    expect(
      w.calls.every(
        (c) =>
          c.blockNumber === BLOCK.number &&
          c.to === ADDRESSES_4663.MULTICALL3 &&
          c.from === MOCK_OPERATOR,
      ),
    ).toBe(true);
    expect(read.blockNumber).toBe(BLOCK.number);
    expect(read.blockTimestamp).toBe(BLOCK.timestamp);
    expect(read.pool).toEqual({
      sqrtPriceX96: 5312359905924111789169988187832333n,
      tick: 222275,
      liquidity: 28490635125232108064n,
      unlocked: true,
    });
    expect(read.lane.caps).toEqual(DEFAULT_LANE_CAPS);
    expect(read.lane.refTick).toEqual({ tick: 222277, bandTicks: 100, code: 0 });
    expect(read.lane.budgets).toEqual({
      turnoverAvailableUsd6: 150_000_000n,
      reranges1hLeft: 4n,
      reranges24hLeft: 24n,
      nextRerangeAt: 0n,
    });
    expect(read.lane.positions).toEqual([77n, 0n]);
    expect(read.lane.positionDetails[0]).toMatchObject({
      tokenId: 77n,
      tickLower: 222160,
      tickUpper: 222370,
      liquidity: 10n ** 15n,
      tokensOwed0: 3n,
      tokensOwed1: 4n,
    });
    expect(read.lane.positionDetails[1]).toBeNull();
    expect(read.lane.balances).toEqual({ token0: 25_000_000n, token1: 10n ** 17n });
    expect(read.chainlink.nvda).toMatchObject({
      answer: 22_242_000_000n,
      decimals: 8,
      price: 222.42,
    });
    expect(read.chainlink.eth).toBeNull(); // optional feed reverted
    expect(read.stockToken).toEqual({
      oraclePaused: false,
      uiMultiplier: 10n ** 18n,
      newUiMultiplier: 10n ** 18n,
      effectiveAt: 0n,
    });
    expect(read.operatorEthWei).toBe(5n * 10n ** 15n);
  });

  it("a failing required view fails the whole read (fail-closed)", async () => {
    const w = world();
    w.lane.refTick = undefined;
    await expect(
      createChainReader({ client: w.client }).read(MOCK_LANE, MOCK_OPERATOR),
    ).rejects.toBeInstanceOf(ChainReadError);
  });

  it("refuses a lane that trades another pool", async () => {
    const w = world();
    w.lane.pool = () => "0x9999999999999999999999999999999999999999";
    await expect(
      createChainReader({ client: w.client }).read(MOCK_LANE, MOCK_OPERATOR),
    ).rejects.toThrow(/not the configured/);
  });

  it("skips the NPM batch for an empty lane", async () => {
    const w = world();
    w.lane.positions = () => [0n, 0n];
    const read = await createChainReader({ client: w.client }).read(MOCK_LANE, MOCK_OPERATOR);
    expect(w.calls).toHaveLength(1);
    expect(read.lane.positionDetails).toEqual([null, null]);
  });
});
