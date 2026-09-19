import { custom, decodeFunctionData, encodeFunctionResult, toHex } from "viem";
import { describe, expect, it } from "vitest";
import { deskLaneAbi } from "../../../src/executor/abi/DeskLane.js";
import { createChainClient, createLaneViews, scrubErrorUrls } from "../../../src/executor/chain.js";
import type { Hex } from "../../../src/types.js";
import { FakeChain, LANE, OPERATOR_ADDR, OWNER } from "./_fixtures.js";

const HASH = `0x${"ab".repeat(32)}` as Hex;

function rpc(handlers: Record<string, (params: unknown[]) => unknown>) {
  const seen: Array<{ method: string; params: unknown[] }> = [];
  const transport = custom({
    async request({ method, params }: { method: string; params: unknown[] }) {
      seen.push({ method, params });
      const h = handlers[method];
      if (h === undefined) throw new Error(`unexpected ${method}`);
      return h(params);
    },
  });
  return { transport, seen };
}

describe("chain client (viem)", () => {
  it("maps blocks, block-pinned calls, receipts, transactions and raw logs", async () => {
    const { transport, seen } = rpc({
      eth_chainId: () => toHex(4663),
      eth_blockNumber: () => toHex(1234),
      eth_getBlockByNumber: () => ({
        number: toHex(1234),
        timestamp: toHex(1_790_000_000),
        hash: HASH,
        baseFeePerGas: toHex(10_000_000),
        transactions: [],
        parentHash: HASH,
        logsBloom: `0x${"0".repeat(512)}`,
        miner: OPERATOR_ADDR,
        difficulty: "0x0",
        totalDifficulty: "0x0",
        extraData: "0x",
        size: "0x1",
        gasLimit: "0x1",
        gasUsed: "0x1",
        sha3Uncles: HASH,
        stateRoot: HASH,
        transactionsRoot: HASH,
        receiptsRoot: HASH,
        uncles: [],
        nonce: "0x0000000000000000",
        mixHash: HASH,
      }),
      eth_call: () => "0x1234",
      eth_getTransactionReceipt: (p) =>
        p[0] === HASH
          ? {
              transactionHash: HASH,
              status: "0x0",
              blockNumber: toHex(9),
              gasUsed: toHex(21_000),
              effectiveGasPrice: toHex(5),
              logs: [
                {
                  address: LANE,
                  topics: [HASH],
                  data: "0x",
                  blockNumber: toHex(9),
                  transactionHash: HASH,
                  logIndex: "0x2",
                  blockHash: HASH,
                  transactionIndex: "0x0",
                  removed: false,
                },
              ],
              blockHash: HASH,
              contractAddress: null,
              cumulativeGasUsed: "0x1",
              from: OPERATOR_ADDR,
              to: LANE,
              logsBloom: `0x${"0".repeat(512)}`,
              transactionIndex: "0x0",
              type: "0x2",
            }
          : null,
      eth_getTransactionByHash: () => null,
      eth_getLogs: () => [
        {
          address: LANE.toUpperCase().replace("0X", "0x"),
          topics: [HASH],
          data: "0x01",
          blockNumber: toHex(7),
          transactionHash: HASH,
          logIndex: "0x3",
        },
      ],
      eth_sendRawTransaction: () => HASH,
    });
    const c = createChainClient({ rpcUrl: "http://127.0.0.1:8545", chainId: 4663, transport });
    expect(await c.chainId()).toBe(4663);
    expect(await c.blockNumber()).toBe(1234n);
    expect(await c.getBlock("latest")).toEqual({
      number: 1234n,
      timestamp: 1_790_000_000n,
      hash: HASH,
      baseFeePerGas: 10_000_000n,
    });
    expect(
      await c.call({ from: OPERATOR_ADDR, to: LANE, data: "0x8456cb59", blockNumber: 1200n }),
    ).toBe("0x1234");
    const call = seen.find((s) => s.method === "eth_call");
    if (call === undefined) throw new Error("no eth_call was made");
    expect(call.params[1]).toBe(toHex(1200));
    expect((call.params[0] as { from: string }).from.toLowerCase()).toBe(OPERATOR_ADDR);
    const r = await c.getTransactionReceipt(HASH);
    expect(r).toMatchObject({
      status: "reverted",
      blockNumber: 9n,
      gasUsed: 21_000n,
      effectiveGasPrice: 5n,
    });
    expect(r?.logs[0]).toMatchObject({ address: LANE, logIndex: 2, blockNumber: 9n });
    expect(await c.getTransactionReceipt(`0x${"cd".repeat(32)}`)).toBeNull();
    expect(await c.getTransaction(HASH)).toBeNull();
    expect(await c.getLogs({ address: LANE, fromBlock: 1n, toBlock: 10n, topics: [HASH] })).toEqual(
      [
        {
          address: LANE,
          topics: [HASH],
          data: "0x01",
          blockNumber: 7n,
          transactionHash: HASH,
          logIndex: 3,
        },
      ],
    );
    expect(seen.find((s) => s.method === "eth_getLogs")?.params[0]).toEqual({
      address: LANE,
      fromBlock: "0x1",
      toBlock: "0xa",
      topics: [HASH],
    });
    expect(await c.sendRawTransaction("0x02")).toBe(HASH);
  });

  it("scrubs the key-bearing RPC URL out of errors, keeping their class", async () => {
    const url = "http://127.0.0.1:1/v2/SUPERSECRETKEY123";
    const c = createChainClient({ rpcUrl: url, chainId: 4663, timeoutMs: 2_000 });
    const err = await c.blockNumber().then(
      () => {
        throw new Error("expected the unreachable RPC to fail");
      },
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect(`${err.message} ${err.stack ?? ""} ${JSON.stringify(err)}`).not.toContain(
      "SUPERSECRETKEY123",
    );
    expect(err.name).toBe("HttpRequestError");
    const e2 = scrubErrorUrls(
      Object.assign(new Error(`boom at ${url}`), { cause: new Error(`inner ${url}`) }),
      [url],
    );
    expect(e2.message).not.toContain("SUPERSECRETKEY123");
    expect((e2.cause as Error).message).not.toContain("SUPERSECRETKEY123");
  }, 15_000);
});

describe("lane views (block-pinned)", () => {
  it("reads identity, caps, budgets, positions and decisionUsedAt at the given block", async () => {
    const chain = new FakeChain();
    chain.callImpl = async (req) => {
      const { functionName } = decodeFunctionData({ abi: deskLaneAbi, data: req.data });
      const out: Record<string, unknown> = {
        owner: OWNER,
        operator: OPERATOR_ADDR,
        guardian: "0x0000000000000000000000000000000000000000",
        laneId: 1,
        pool: LANE,
        token0: LANE,
        token1: LANE,
        fence: LANE,
        paused: true,
        caps: {
          maxDeployUsd6: 60_000_000n,
          turnoverUsd6PerDay: 150_000_000n,
          placeBandBps: 100,
          maxTickDelta: 10,
          minWidthTicks: 20,
          maxWidthTicks: 2_000,
          reranges1h: 4,
          reranges24h: 24,
          minRerangeInterval: 300,
          maxDeadlineAhead: 120,
          maxRanges: 2,
        },
        budgets: [100n, 3n, 20n, 1_790_000_300n],
        positions: [7n, 0n],
        decisionUsedAt: 0n,
      };
      return encodeFunctionResult({
        abi: deskLaneAbi,
        functionName: functionName as "owner",
        result: out[functionName] as never,
      });
    };
    const v = createLaneViews(chain);
    expect(await v.identity(LANE, 55n)).toMatchObject({
      owner: OWNER,
      operator: OPERATOR_ADDR,
      laneId: 1,
      paused: true,
    });
    expect((await v.caps(LANE, 55n)).maxDeployUsd6).toBe(60_000_000n);
    expect(await v.budgets(LANE, 55n)).toEqual({
      turnoverAvailableUsd6: 100n,
      reranges1hLeft: 3n,
      reranges24hLeft: 20n,
      nextRerangeAt: 1_790_000_300n,
    });
    expect(await v.positions(LANE, 55n)).toEqual([7n, 0n]);
    expect(await v.decisionUsedAt(LANE, HASH, 55n)).toBe(0n);
    expect(chain.calls.every((c) => c.blockNumber === 55n)).toBe(true);
  });
});
