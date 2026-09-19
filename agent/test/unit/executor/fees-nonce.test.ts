import { describe, expect, it } from "vitest";
import { createFeePolicy, gasLimitFor } from "../../../src/executor/fees.js";
import { createNonceManager } from "../../../src/executor/nonce.js";
import { type BlockHeader, ExecError } from "../../../src/types.js";
import { memDb } from "../../helpers/fakes.js";
import { FakeChain, OPERATOR_ADDR, seedDecision, T0 } from "./_fixtures.js";

const block = (base: bigint | null): BlockHeader => ({
  number: 1n,
  timestamp: 1n,
  hash: "0x01",
  baseFeePerGas: base,
});
const gwei = (n: number) => BigInt(Math.round(n * 1e9));

describe("fees: max(2 × base, floor) ≤ cap, priority 0", () => {
  const fees = createFeePolicy({ floorWei: gwei(0.02), capWei: gwei(2) });

  it("uses 2 × base above the floor and the floor below it", () => {
    expect(fees.quote(block(gwei(0.1)))).toEqual({
      maxFeePerGas: gwei(0.2),
      maxPriorityFeePerGas: 0n,
    });
    expect(fees.quote(block(gwei(0.001)))).toEqual({
      maxFeePerGas: gwei(0.02),
      maxPriorityFeePerGas: 0n,
    });
    expect(fees.quote(block(null)).maxFeePerGas).toBe(gwei(0.02));
  });

  it("clamps to the cap, and a base fee above the cap is GAS_CAP", () => {
    expect(fees.quote(block(gwei(1.5))).maxFeePerGas).toBe(gwei(2));
    const err = (() => {
      try {
        fees.quote(block(gwei(3)));
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(ExecError);
    expect((err as ExecError).code).toBe("GAS_CAP");
    expect((err as ExecError).outcome).toBe("top_up_alert");
  });

  it("a re-sign bump never lowers the fee and stays within the cap", () => {
    expect(fees.bump(block(gwei(0.01)), gwei(0.1)).maxFeePerGas).toBe(gwei(0.125));
    expect(fees.bump(block(gwei(0.5)), gwei(0.1)).maxFeePerGas).toBe(gwei(1));
    expect(fees.bump(block(gwei(0.5)), gwei(1.9)).maxFeePerGas).toBe(gwei(2));
    expect(() => fees.bump(block(gwei(0.5)), gwei(2))).toThrow(/cap/);
  });

  it("gas limit is the estimate × 1.25, rounded up", () => {
    expect(gasLimitFor(400_000n)).toBe(500_000n);
    expect(gasLimitFor(1n)).toBe(2n);
  });

  it("rejects an unsafe policy", () => {
    expect(() => createFeePolicy({ floorWei: 0n, capWei: 1n })).toThrow();
    expect(() => createFeePolicy({ floorWei: 2n, capWei: 1n })).toThrow();
  });
});

describe("nonces: DB-backed, single in flight", () => {
  function setup() {
    const db = memDb();
    const chain = new FakeChain();
    const nonces = createNonceManager({ db, chain, chainId: 4663, now: () => T0 });
    return { db, chain, nonces };
  }

  it("a fresh signer uses the chain's pending count", async () => {
    const { chain, nonces } = setup();
    chain.count(OPERATOR_ADDR).pending = 7;
    expect(await nonces.next(OPERATOR_ADDR)).toBe(7);
  });

  it("uses pending when the DB is behind (a foreign use of the wallet is skipped over)", async () => {
    const { db, chain, nonces } = setup();
    db.advanceNonce(OPERATOR_ADDR, 4663, 3, T0);
    chain.count(OPERATOR_ADDR).pending = 9;
    expect(await nonces.next(OPERATOR_ADDR)).toBe(9);
  });

  it("DB ahead of the chain with an unresolved attempt → reconcile first (refuse)", async () => {
    const { db, chain, nonces } = setup();
    const id = seedDecision(db);
    const execId = db.insertExecution({
      decisionId: id,
      stepIndex: 0,
      onchainId: `0x${"ab".repeat(32)}`,
      laneAddress: "0x1111111111111111111111111111111111111111",
      venue: "rh",
      action: "collect",
      riskClass: "reducing",
      notionalCents: 0,
      signerAddress: OPERATOR_ADDR,
      status: "prepared",
      createdAtMs: T0,
      updatedAtMs: T0,
    });
    db.recordSignedAttempt(
      {
        executionId: execId,
        attempt: 1,
        signerKind: "local",
        fromAddress: OPERATOR_ADDR,
        toAddress: "0x1111111111111111111111111111111111111111",
        calldataHash: `0x${"cd".repeat(32)}`,
        nonce: 5,
        gasLimit: 1n,
        maxFeePerGas: 1n,
        maxPriorityFeePerGas: 0n,
        deadlineSec: 1,
        signedRawTx: "0x02",
        txHash: `0x${"ef".repeat(32)}`,
        simJson: null,
        createdAtMs: T0,
      },
      T0,
    );
    db.advanceNonce(OPERATOR_ADDR, 4663, 5, T0);
    chain.count(OPERATOR_ADDR).pending = 5;
    await expect(nonces.next(OPERATOR_ADDR)).rejects.toThrow(/reconcile first/);
  });

  it("DB ahead with every attempt final → the stored nonce is stale: reset and use pending", async () => {
    const { db, chain, nonces } = setup();
    db.advanceNonce(OPERATOR_ADDR, 4663, 5, T0);
    chain.count(OPERATOR_ADDR).pending = 5;
    expect(await nonces.next(OPERATOR_ADDR)).toBe(5);
    expect(db.getNonceState(OPERATOR_ADDR)?.lastNonce).toBe(4);
  });
});
