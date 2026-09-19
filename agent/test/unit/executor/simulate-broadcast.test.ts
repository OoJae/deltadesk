import {
  ExecutionRevertedError,
  encodeErrorResult,
  encodeFunctionResult,
  HttpRequestError,
  keccak256,
  RpcRequestError,
} from "viem";
import { describe, expect, it } from "vitest";
import { deskLaneAbi } from "../../../src/executor/abi/DeskLane.js";
import { createBroadcaster } from "../../../src/executor/broadcaster.js";
import { createCalldataBuilder } from "../../../src/executor/calldata.js";
import { createSimulator } from "../../../src/executor/simulate.js";
import { ExecError, type Hex } from "../../../src/types.js";
import { fixedClock } from "../../helpers/fakes.js";
import { FakeChain, LANE, localSigner, metaFor, OPERATOR_ADDR, testUlid } from "./_fixtures.js";

const builder = createCalldataBuilder(LANE);
const meta = metaFor(testUlid(), 0, 1_758_470_445);
const rerange = builder.encode(
  {
    kind: "rerange",
    lane: "A",
    ranges: [{ tickLower: -222_400, tickUpper: -222_200, share0Bps: 5_000, share1Bps: 5_000 }],
    expectedTick: -222_277,
    maxTickDelta: 10,
  },
  meta,
);

function reverting(data: Hex) {
  return new ExecutionRevertedError({
    cause: new RpcRequestError({
      body: {},
      error: { code: 3, message: "execution reverted", data },
      url: "http://127.0.0.1:8545",
    }),
    message: "execution reverted",
  });
}

describe("simulator", () => {
  it("calls FROM the signer AT the pinned block and decodes rerange's return values", async () => {
    const chain = new FakeChain();
    chain.head = 1_010n;
    chain.callImpl = async () =>
      encodeFunctionResult({
        abi: deskLaneAbi,
        functionName: "rerange",
        result: [[7n], [1_000n], 25_000_000n, 10n ** 17n],
      });
    const sim = await createSimulator({ chain }).simulate(rerange, OPERATOR_ADDR, 1_000n);
    expect(chain.calls[0]).toMatchObject({
      from: OPERATOR_ADDR,
      to: LANE,
      data: rerange.data,
      blockNumber: 1_000n,
    });
    expect(sim.ok).toBe(true);
    expect(sim.blockNumber).toBe(1_000n);
    expect(sim.latestBlockNumber).toBe(1_010n);
    expect(sim.rerange).toEqual({
      tokenIds: [7n],
      liquidities: [1_000n],
      amount0Used: 25_000_000n,
      amount1Used: 10n ** 17n,
    });
    expect(sim.gasEstimate).toBe(400_000n);
    expect(sim.error).toBeNull();
  });

  it("a lane custom error is a failed simulation with the decoded name", async () => {
    const chain = new FakeChain();
    const data = encodeErrorResult({
      abi: deskLaneAbi,
      errorName: "PoolTickMoved",
      args: [-222_300, -222_277, 10],
    });
    chain.callImpl = async () => {
      throw reverting(data);
    };
    const sim = await createSimulator({ chain }).simulate(rerange, OPERATOR_ADDR, 1_000n);
    expect(sim.ok).toBe(false);
    expect(sim.error).toMatchObject({
      code: "SIM_POLICY",
      errorName: "PoolTickMoved",
      args: [-222_300, -222_277, 10],
    });
    expect(sim.gasEstimate).toBeNull();
  });

  it("DecisionUsed → SIM_DECISION_USED; RPC trouble → SIM_TRANSIENT", async () => {
    const chain = new FakeChain();
    chain.callImpl = async () => {
      throw reverting(
        encodeErrorResult({ abi: deskLaneAbi, errorName: "DecisionUsed", args: [meta.decisionId] }),
      );
    };
    expect(
      (await createSimulator({ chain }).simulate(rerange, OPERATOR_ADDR, 1n)).error?.code,
    ).toBe("SIM_DECISION_USED");
    chain.callImpl = async () => {
      throw new HttpRequestError({ url: "http://127.0.0.1:8545", status: 502 });
    };
    expect(
      (await createSimulator({ chain }).simulate(rerange, OPERATOR_ADDR, 1n)).error?.code,
    ).toBe("SIM_TRANSIENT");
  });

  it("a failing gas estimate fails the simulation", async () => {
    const chain = new FakeChain();
    chain.callImpl = async () =>
      encodeFunctionResult({ abi: deskLaneAbi, functionName: "rerange", result: [[], [], 0n, 0n] });
    chain.estimateImpl = async () => {
      throw reverting(encodeErrorResult({ abi: deskLaneAbi, errorName: "TooSoon", args: [123n] }));
    };
    const sim = await createSimulator({ chain }).simulate(rerange, OPERATOR_ADDR, 1n);
    expect(sim.ok).toBe(false);
    expect(sim.error?.errorName).toBe("TooSoon");
  });
});

describe("broadcaster", () => {
  async function signed(): Promise<Hex> {
    return localSigner().signTransaction({
      type: "eip1559",
      chainId: 4663,
      to: LANE,
      data: rerange.data,
      value: 0n,
      nonce: 0,
      gas: 500_000n,
      maxFeePerGas: 20_000_000n,
      maxPriorityFeePerGas: 0n,
    });
  }

  it("sends exactly the given bytes and returns their hash", async () => {
    const chain = new FakeChain();
    const raw = await signed();
    const hash = await createBroadcaster({ chain, clock: fixedClock() }).broadcast(raw);
    expect(hash).toBe(keccak256(raw));
    expect(chain.sent).toEqual([raw]);
  });

  it("'already known' is success; a node returning another hash is SIGNER_MISMATCH", async () => {
    const chain = new FakeChain();
    const raw = await signed();
    chain.sendErrors.push(
      new RpcRequestError({
        body: {},
        error: { code: -32000, message: "already known" },
        url: "x",
      }),
    );
    expect(await createBroadcaster({ chain, clock: fixedClock() }).broadcast(raw)).toBe(
      keccak256(raw),
    );
    const liar = {
      ...chain,
      sendRawTransaction: async () => `0x${"99".repeat(32)}` as Hex,
      getTransactionReceipt: chain.getTransactionReceipt.bind(chain),
    };
    await expect(
      createBroadcaster({ chain: liar, clock: fixedClock() }).broadcast(raw),
    ).rejects.toMatchObject({ code: "SIGNER_MISMATCH" });
  });

  it("classifies a refusal", async () => {
    const chain = new FakeChain();
    chain.sendErrors.push(
      new RpcRequestError({
        body: {},
        error: { code: -32000, message: "nonce too low" },
        url: "x",
      }),
    );
    await expect(
      createBroadcaster({ chain, clock: fixedClock() }).broadcast(await signed()),
    ).rejects.toBeInstanceOf(ExecError);
  });

  it("polls for the receipt until the timeout, riding out transient errors", async () => {
    const chain = new FakeChain();
    const clock = fixedClock();
    const b = createBroadcaster({ chain, clock, sleep: async (ms) => clock.advance(ms) });
    const hash = `0x${"77".repeat(32)}` as Hex;
    let polls = 0;
    const flaky = {
      sendRawTransaction: chain.sendRawTransaction.bind(chain),
      getTransactionReceipt: async (h: Hex) => {
        polls += 1;
        if (polls === 1) throw new Error("socket hang up");
        if (polls < 4) return null;
        return {
          transactionHash: h,
          status: "success" as const,
          blockNumber: 5n,
          gasUsed: 1n,
          effectiveGasPrice: 1n,
          logs: [],
        };
      },
    };
    const ok = await createBroadcaster({
      chain: flaky,
      clock,
      sleep: async (ms) => clock.advance(ms),
    }).waitForReceipt(hash, { pollMs: 250, timeoutMs: 15_000 });
    expect(ok.kind).toBe("confirmed");
    expect(polls).toBe(4);
    const start = clock.now();
    const none = await b.waitForReceipt(hash, { pollMs: 250, timeoutMs: 15_000 });
    expect(none.kind).toBe("timeout");
    expect(clock.now() - start).toBe(15_000);
  });

  it("a reverted receipt is reported as reverted", async () => {
    const chain = new FakeChain();
    const hash = `0x${"78".repeat(32)}` as Hex;
    chain.receipts.set(hash, {
      transactionHash: hash,
      status: "reverted",
      blockNumber: 9n,
      gasUsed: 1n,
      effectiveGasPrice: 1n,
      logs: [],
    });
    const r = await createBroadcaster({ chain, clock: fixedClock() }).waitForReceipt(hash, {
      pollMs: 250,
      timeoutMs: 1_000,
    });
    expect(r.kind).toBe("reverted");
  });
});
