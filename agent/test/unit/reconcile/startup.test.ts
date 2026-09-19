/**
 * Crash recovery: stored bytes are rebroadcast, never re-signed; unknown attempts resolve from the
 * chain; a nonce taken by someone else is a conflict (safe mode); a missed deadline is final.
 */

import { keccak256 } from "viem";
import { describe, expect, it } from "vitest";
import { createBroadcaster } from "../../../src/executor/broadcaster.js";
import { encodeDecisionId } from "../../../src/executor/decision-id.js";
import { createNonceManager } from "../../../src/executor/nonce.js";
import { silentLogger } from "../../../src/log.js";
import {
  createAttemptResolver,
  createStartupReconciler,
  feeUsdCents,
  ORPHANED_APPROVAL_REASON,
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
  seedSignedExecution,
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

describe("crash window: stored risk-adding bytes for a desk that left `active` meanwhile", () => {
  const attemptOf = (db: DeskDb, hash: Hex) =>
    db.getAttemptByHash(hash) as NonNullable<ReturnType<DeskDb["getAttemptByHash"]>>;

  it.each([["safe_mode"], ["revoked"], ["disabled"]] as const)(
    "no broadcast recorded + desk %s → held (never sent, never finalized); dropped at its deadline",
    async (status) => {
      const { db, chain, startup } = setup();
      const s = await seedSignedExecution(db, { riskClass: "adding" });
      db.setDeskStatus(LANE, status, "foreign LaneAction", T0);
      const report = await startup.run(T0 + 1_000);
      expect(report.rebroadcast).toBe(0);
      expect(report.resolved).toBe(0);
      expect(report.unknown).toBe(1);
      expect(chain.sent).toEqual([]);
      expect(db.getAttemptByHash(s.txHash)?.status).toBe("signed");
      // Past the deadline the lane rejects the bytes: only now is the attempt final.
      expect((await startup.run(T0 + 46_000)).resolved).toBe(1);
      expect(chain.sent).toEqual([]);
      expect(db.getExecution(s.executionId)).toMatchObject({
        status: "dropped",
        errorCode: "DEADLINE_PASSED",
      });
      expect(db.getDecision(s.decisionId)?.status).toBe("failed");
    },
  );

  it("no desk row, or an unreadable status: held the same way (fail closed, nothing sent)", async () => {
    const { db, chain, deps } = setup();
    const s = await seedSignedExecution(db, { riskClass: "adding" });
    const throwing = createAttemptResolver({
      ...deps,
      deskStatus: () => {
        throw new Error("db locked");
      },
    });
    expect(await throwing.resolve(attemptOf(db, s.txHash), T0)).toBe("pending");
    const t = await seedSignedExecution(db, {
      riskClass: "adding",
      nonce: 1,
      lane: "0x9999999999999999999999999999999999999999",
    });
    chain.count(OPERATOR_ADDR).latest = 1;
    const resolver = createAttemptResolver(deps);
    expect(await resolver.resolve(attemptOf(db, t.txHash), T0)).toBe("pending");
    expect(chain.sent).toEqual([]);
    expect(db.getExecution(s.executionId)?.status).toBe("signed");
    expect(db.getExecution(t.executionId)?.status).toBe("signed");
  });

  it("an ambiguous send (RPC_UNAVAILABLE, broadcastCount 0) is never finalized while the bytes may land", async () => {
    const { db, chain, resolver } = setup();
    chain.autoMine = false;
    chain.mempoolKeeps = false; // a lagging fallback node: no tx, no receipt yet
    const s = await seedSignedExecution(db, { riskClass: "adding", nonce: 0 });
    db.advanceNonce(OPERATOR_ADDR, 4663, 0, T0);
    // What the executor leaves after broadcast() threw RPC_UNAVAILABLE: 'unknown', never marked.
    db.updateTxAttempt(s.txHash, { status: "unknown", updatedAtMs: T0 });
    db.updateExecution(s.executionId, {
      status: "unknown",
      errorCode: "RPC_UNAVAILABLE",
      statusDetail: "broadcast outcome unknown: fetch failed",
      updatedAtMs: T0,
    });
    db.setDeskStatus(LANE, "safe_mode", "x", T0);
    expect(attemptOf(db, s.txHash).broadcastCount).toBe(0);
    expect(await resolver.resolve(attemptOf(db, s.txHash), T0 + 5_000)).toBe("pending");
    expect(chain.sent).toEqual([]);
    // The nonce stays taken: nothing else is signed at it while those bytes may still land.
    const nonces = createNonceManager({ db, chain, chainId: 4663, now: () => T0 });
    await expect(nonces.next(OPERATOR_ADDR)).rejects.toThrow(/reconcile first/);
    // …and they do land: the DB follows the chain.
    chain.mine(s.txHash, OPERATOR_ADDR, 0);
    expect(await resolver.resolve(attemptOf(db, s.txHash), T0 + 10_000)).toBe("confirmed");
    expect(db.getExecution(s.executionId)?.status).toBe("confirmed");
    expect(await nonces.next(OPERATOR_ADDR)).toBe(1);
  });

  it("the nonce is freed once the deadline makes the held bytes impossible", async () => {
    const { db, chain, resolver } = setup();
    const s = await seedSignedExecution(db, { riskClass: "adding", nonce: 0 });
    db.advanceNonce(OPERATOR_ADDR, 4663, 0, T0);
    db.setDeskStatus(LANE, "safe_mode", "x", T0);
    const nonces = createNonceManager({ db, chain, chainId: 4663, now: () => T0 });
    expect(await resolver.resolve(attemptOf(db, s.txHash), T0)).toBe("pending");
    await expect(nonces.next(OPERATOR_ADDR)).rejects.toThrow(/reconcile first/);
    expect(await resolver.resolve(attemptOf(db, s.txHash), T0 + 46_000)).toBe("dropped");
    expect(await nonces.next(OPERATOR_ADDR)).toBe(0);
  });

  it("bytes broadcast before the crash are never RE-sent for a halted desk; they expire", async () => {
    const { db, chain, resolver } = setup();
    chain.autoMine = false;
    chain.mempoolKeeps = false; // the node forgot them
    const s = await seedSignedExecution(db, {
      riskClass: "adding",
      broadcast: true,
      deadlineSec: Math.floor(T0 / 1000) + 30,
    });
    db.setDeskStatus(LANE, "safe_mode", "x", T0);
    expect(await resolver.resolve(attemptOf(db, s.txHash), T0)).toBe("pending");
    expect(chain.sent).toEqual([]);
    expect(await resolver.resolve(attemptOf(db, s.txHash), T0 + 31_000)).toBe("dropped");
    expect(db.getExecution(s.executionId)?.errorCode).toBe("DEADLINE_PASSED");
  });

  it("risk-REDUCING stored bytes still go out for a halted desk (an exit must land)", async () => {
    const { db, chain, resolver } = setup();
    const s = await seedSignedExecution(db, { riskClass: "reducing" });
    db.setDeskStatus(LANE, "safe_mode", "x", T0);
    expect(await resolver.resolve(attemptOf(db, s.txHash), T0)).toBe("rebroadcast");
    expect(chain.sent).toEqual([s.raw]);
  });

  it("positive path: an active desk's stored risk-adding bytes are rebroadcast", async () => {
    const { db, chain, resolver } = setup();
    const s = await seedSignedExecution(db, { riskClass: "adding" });
    expect(await resolver.resolve(attemptOf(db, s.txHash), T0)).toBe("rebroadcast");
    expect(chain.sent).toEqual([s.raw]);
  });
});

describe("crash window: approvals left pending by a restart", () => {
  it("startup closes them with a reason; no channel can answer them afterwards", async () => {
    const { db, startup } = setup();
    const decisionId = seedDecision(db, { status: "observed", statusDetail: "awaiting approval" });
    db.createApproval({
      decisionId,
      laneAddress: LANE,
      summary: "rerange $50",
      requestedAtMs: T0,
      expiresAtMs: T0 + 120_000,
    });
    const report = await startup.run(T0 + 5_000); // restarted inside the old window
    expect(report.approvalsClosed).toBe(1);
    expect(db.getApproval(decisionId)).toMatchObject({
      status: "cancelled",
      closeReason: ORPHANED_APPROVAL_REASON,
    });
    expect(db.respondApproval(decisionId, true, "web", "0xowner", T0 + 6_000)).toBe(false);
    expect(db.respondApproval(decisionId, true, "telegram", "bob", T0 + 6_000)).toBe(false);
    expect(db.pendingApprovals(LANE, T0 + 6_000)).toEqual([]);
    expect(db.getDecision(decisionId)).toMatchObject({
      status: "declined",
      approvalOutcome: "cancelled",
    });
    expect((await startup.run(T0 + 7_000)).approvalsClosed).toBe(0);
  });
});
