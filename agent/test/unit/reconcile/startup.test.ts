/**
 * Crash recovery: stored bytes are rebroadcast, never re-signed; unknown attempts resolve from the
 * chain; a nonce taken by someone else is a conflict (safe mode); a missed deadline is final.
 */

import { keccak256 } from "viem";
import { describe, expect, it } from "vitest";
import { createBroadcaster } from "../../../src/executor/broadcaster.js";
import { encodeDecisionId } from "../../../src/executor/decision-id.js";
import { silentLogger } from "../../../src/log.js";
import {
  createAttemptResolver,
  createStartupReconciler,
  feeUsdCents,
} from "../../../src/reconcile/startup.js";
import type { DeskDb, Hex } from "../../../src/types.js";
import { fixedClock, memDb } from "../../helpers/fakes.js";
import {
  deskRow,
  FakeChain,
  LANE,
  localSigner,
  OPERATOR_ADDR,
  seedDecision,
  T0,
} from "../executor/_fixtures.js";

const NOW_SEC = Math.floor(T0 / 1000);

async function seedSigned(
  db: DeskDb,
  opts: { nonce?: number; deadlineSec?: number; broadcast?: boolean } = {},
) {
  const decisionId = seedDecision(db);
  const executionId = db.insertExecution({
    decisionId,
    stepIndex: 0,
    onchainId: encodeDecisionId(decisionId, 0),
    laneAddress: LANE,
    venue: "rh",
    action: "collect",
    riskClass: "reducing",
    notionalCents: 0,
    signerAddress: OPERATOR_ADDR,
    status: "prepared",
    createdAtMs: T0,
    updatedAtMs: T0,
  });
  const raw = await localSigner().signTransaction({
    type: "eip1559",
    chainId: 4663,
    to: LANE,
    data: "0xa64dfc1f",
    value: 0n,
    nonce: opts.nonce ?? 0,
    gas: 200_000n,
    maxFeePerGas: 20_000_000n,
    maxPriorityFeePerGas: 0n,
  });
  const txHash = keccak256(raw);
  db.recordSignedAttempt(
    {
      executionId,
      attempt: 1,
      signerKind: "local",
      fromAddress: OPERATOR_ADDR,
      toAddress: LANE,
      calldataHash: keccak256("0xa64dfc1f"),
      nonce: opts.nonce ?? 0,
      gasLimit: 200_000n,
      maxFeePerGas: 20_000_000n,
      maxPriorityFeePerGas: 0n,
      deadlineSec: opts.deadlineSec ?? NOW_SEC + 45,
      signedRawTx: raw,
      txHash,
      simJson: null,
      createdAtMs: T0,
    },
    T0,
  );
  if (opts.broadcast) db.markAttemptBroadcast(txHash, T0);
  return { decisionId, executionId, raw, txHash };
}

function setup() {
  const db = memDb();
  db.insertDesk(deskRow());
  const chain = new FakeChain();
  const clock = fixedClock(T0);
  const broadcaster = createBroadcaster({ chain, clock });
  const deps = { db, chain, broadcaster, clock, logger: silentLogger, ethUsd: () => 2_630 };
  return {
    db,
    chain,
    clock,
    deps,
    resolver: createAttemptResolver(deps),
    startup: createStartupReconciler(deps),
  };
}

describe("startup reconciliation", () => {
  it("a crash after `signed` rebroadcasts the STORED bytes (never re-signs) and resolves them", async () => {
    const { db, chain, startup } = setup();
    const s = await seedSigned(db);
    const unsignedDecision = seedDecision(db);
    db.insertExecution({
      decisionId: unsignedDecision,
      stepIndex: 0,
      onchainId: encodeDecisionId(unsignedDecision, 0),
      laneAddress: LANE,
      venue: "rh",
      action: "exitAll",
      riskClass: "reducing",
      notionalCents: 0,
      signerAddress: OPERATOR_ADDR,
      status: "prepared",
      createdAtMs: T0,
      updatedAtMs: T0,
    });
    const report = await startup.run(T0 + 1_000);
    expect(report.failedUnsigned).toBe(1);
    expect(report.rebroadcast).toBe(1);
    expect(chain.sent).toEqual([s.raw]);
    expect(db.getAttemptByHash(s.txHash)?.broadcastCount).toBe(1);
    expect(db.getExecution(s.executionId)?.status).toBe("broadcast");

    // Next pass: the (auto-mined) receipt resolves it; the orphaned decision follows.
    const again = await startup.run(T0 + 2_000);
    expect(again.resolved).toBe(1);
    expect(db.getExecution(s.executionId)?.status).toBe("confirmed");
    expect(db.getDecision(s.decisionId)?.status).toBe("executed");
    expect(db.getDecision(unsignedDecision)?.status).toBe("failed");
  });

  it("records gas, fee and USD from the receipt", async () => {
    const { db, chain, resolver } = setup();
    const s = await seedSigned(db, { broadcast: true });
    chain.mine(s.txHash, OPERATOR_ADDR, 0);
    expect(
      await resolver.resolve(
        db.getAttemptByHash(s.txHash) as NonNullable<ReturnType<DeskDb["getAttemptByHash"]>>,
        T0,
      ),
    ).toBe("confirmed");
    const e = db.getExecution(s.executionId);
    expect(e?.feeWei).toBe(300_000n * 10_000_000n);
    expect(e?.feeUsdCents).toBe(feeUsdCents(3_000_000_000_000n, 2_630));
    expect(db.getAttemptByHash(s.txHash)?.gasUsed).toBe(300_000n);
  });

  it("a tx still in the node's pool is left pending", async () => {
    const { db, chain, resolver } = setup();
    const s = await seedSigned(db, { broadcast: true });
    chain.mempool.set(s.txHash, {
      hash: s.txHash,
      from: OPERATOR_ADDR,
      nonce: 0,
      blockNumber: null,
    });
    const a = db.getAttemptByHash(s.txHash);
    expect(await resolver.resolve(a as NonNullable<typeof a>, T0)).toBe("pending");
    expect(chain.sent).toHaveLength(0);
  });

  it("our nonce consumed by a foreign tx → NONCE_CONFLICT: dropped + safe mode", async () => {
    const { db, chain, resolver } = setup();
    const s = await seedSigned(db, { nonce: 4, broadcast: true });
    chain.count(OPERATOR_ADDR).latest = 5;
    const a = db.getAttemptByHash(s.txHash);
    expect(await resolver.resolve(a as NonNullable<typeof a>, T0)).toBe("conflict");
    expect(db.getExecution(s.executionId)).toMatchObject({
      status: "dropped",
      errorCode: "NONCE_CONFLICT",
    });
    expect(db.getDesk(LANE)?.status).toBe("safe_mode");
  });

  it("past the deadline and nowhere to be found → dropped (final), never rebroadcast", async () => {
    const { db, chain, resolver } = setup();
    const s = await seedSigned(db, { deadlineSec: NOW_SEC + 10, broadcast: true });
    const a = db.getAttemptByHash(s.txHash);
    expect(await resolver.resolve(a as NonNullable<typeof a>, T0 + 11_000)).toBe("dropped");
    expect(db.getExecution(s.executionId)).toMatchObject({
      status: "dropped",
      errorCode: "DEADLINE_PASSED",
    });
    expect(chain.sent).toHaveLength(0);
  });

  it("rebroadcasts are bounded", async () => {
    const { db, chain, deps } = setup();
    chain.autoMine = false;
    chain.mempoolKeeps = false;
    const resolver = createAttemptResolver({ ...deps, maxBroadcasts: 2 });
    const s = await seedSigned(db);
    const get = () =>
      db.getAttemptByHash(s.txHash) as NonNullable<ReturnType<DeskDb["getAttemptByHash"]>>;
    expect(await resolver.resolve(get(), T0)).toBe("rebroadcast");
    expect(await resolver.resolve(get(), T0)).toBe("rebroadcast");
    expect(await resolver.resolve(get(), T0)).toBe("pending");
    expect(new Set(chain.sent)).toEqual(new Set([s.raw]));
  });

  it("a fee re-sign sibling that landed resolves the other attempt as replaced", async () => {
    const { db, chain, resolver } = setup();
    const s = await seedSigned(db, { nonce: 2, broadcast: true });
    const raw2 = await localSigner().signTransaction({
      type: "eip1559",
      chainId: 4663,
      to: LANE,
      data: "0xa64dfc1f",
      value: 0n,
      nonce: 2,
      gas: 200_000n,
      maxFeePerGas: 30_000_000n,
      maxPriorityFeePerGas: 0n,
    });
    const hash2 = keccak256(raw2) as Hex;
    db.recordSignedAttempt(
      {
        executionId: s.executionId,
        attempt: 2,
        signerKind: "local",
        fromAddress: OPERATOR_ADDR,
        toAddress: LANE,
        calldataHash: keccak256("0xa64dfc1f"),
        nonce: 2,
        gasLimit: 200_000n,
        maxFeePerGas: 30_000_000n,
        maxPriorityFeePerGas: 0n,
        deadlineSec: NOW_SEC + 45,
        signedRawTx: raw2,
        txHash: hash2,
        simJson: null,
        createdAtMs: T0,
      },
      T0,
    );
    chain.mine(hash2, OPERATOR_ADDR, 2);
    const a = db.getAttemptByHash(s.txHash);
    expect(await resolver.resolve(a as NonNullable<typeof a>, T0)).toBe("replaced");
    expect(db.getAttemptByHash(hash2)?.status).toBe("confirmed");
    expect(db.getExecution(s.executionId)?.status).toBe("confirmed");
  });

  it("feeUsdCents is exact enough and null without a price", () => {
    expect(feeUsdCents(10n ** 18n, 2_630)).toBe(263_000);
    expect(feeUsdCents(10n ** 15n, 2_630.5)).toBe(263);
    expect(feeUsdCents(1n, null)).toBeNull();
  });
});
