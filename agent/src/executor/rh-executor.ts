/**
 * Robinhood Chain (4663) executor: the write-ahead pipeline of docs/m2-design-agent.md, per step.
 *
 *   prepare  encode (to from CONFIG) → eth_call from the signer at a pinned block (learn returns)
 *   execute  1 insert `prepared` (atomically: idempotency + single in flight)
 *            2 re-simulate at a fresh pinned block → `simulated`
 *            3 gas = estimateGas × 1.25; maxFee = max(2 × base, floor) ≤ cap; priority 0
 *            4 nonce (DB-backed; reconcile first when the DB is ahead)
 *            5 sign (15 s timeout, one retry when unavailable); a risk-adding step only while
 *              the desk is active
 *            6 VERIFY: parse == request field by field, recover == signer
 *            7 persist raw bytes + hash + `signed` (+ nonce) in ONE SQLite transaction
 *            8 broadcast only before the deadline; a risk-adding step only while the desk is still
 *              active (safe mode or a revocation that lands while signing drops the bytes unsent)
 *              (FEE_CAP_TOO_LOW → re-check, re-sign same nonce ≤ 2×)
 *
 * Risk-reducing steps are not stopped by the desk status here: they only lower risk, and the
 * human's own `pnpm desk-exit` must still flatten a desk that is in safe mode. The daemon does not
 * start any step on a desk that is not active (it runs a safe-mode desk as advisory).
 *            9 receipt: poll 250 ms / 15 s → confirmed | reverted (reason via eth_call at block−1)
 *              | unknown (the resolver may rebroadcast the same bytes once)
 *           10 gas, fee and USD recorded
 *
 * Nothing is ever broadcast that was not verified and persisted first, and nothing persisted is
 * ever re-signed: recovery rebroadcasts the stored bytes (reconcile/startup.ts).
 */

import { keccak256 } from "viem";
import { canonicalJson } from "../canonical.js";
import { type AttemptResolver, feeUsdCents, recordReceipt } from "../reconcile/startup.js";
import { signWithTimeout, verifySignedTx } from "../signer/types.js";
import {
  type Address,
  type Broadcaster,
  type ChainClient,
  type Clock,
  type DeskDb,
  type DeskLogger,
  type DeskStatus,
  ExecError,
  type Executor,
  type Hex,
  isExecError,
  type NonceManager,
  type Notifier,
  type PreparedStep,
  riskClassOf,
  type SimulationResult,
  type Simulator,
  type StepOutcome,
  type StepRequest,
  type TxCall,
  type TxSigner,
  type UnsignedTx,
} from "../types.js";
import { OPERATOR_SELECTOR_SET } from "./abi/DeskLane.js";
import type { LaneCalldataBuilder } from "./calldata.js";
import { encodeDecisionId } from "./decision-id.js";
import { classifyError, classifyRevert, classifySignerError, revertDataOf } from "./errors.js";
import { type DeskFeePolicy, gasLimitFor } from "./fees.js";
import { applyErrorOutcome, enterSafeMode } from "./safe-mode.js";

export type { Executor, PreparedStep, StepOutcome, StepRequest } from "../types.js";

export interface RhExecutorTiming {
  signTimeoutMs: number;
  receiptPollMs: number;
  receiptTimeoutMs: number;
  /** Do not broadcast when fewer than this many seconds remain before the Meta deadline. */
  broadcastMarginSec?: number;
}

export interface RhExecutorDeps {
  db: DeskDb;
  chain: ChainClient;
  signer: TxSigner;
  /** Bound to the configured lane: the only `to` this executor can produce. */
  calldata: LaneCalldataBuilder;
  simulator: Simulator;
  fees: DeskFeePolicy;
  nonces: NonceManager;
  broadcaster: Broadcaster;
  /** Resolves a timed-out attempt once (rebroadcast / drop / conflict). */
  resolver?: AttemptResolver | undefined;
  clock: Clock;
  logger: DeskLogger;
  notifier?: Notifier | undefined;
  chainId: number;
  timing: RhExecutorTiming;
  /** Refuse a step whose gas × maxFee would cost more than this (GAS_CAP). */
  maxGasCents?: number | null;
  ethUsd?: (() => number | null) | undefined;
  /**
   * The desk's status, read right before a risk-adding step signs and before each of its
   * broadcasts (the reconciler and the webhook change it concurrently). Default: the desks table.
   * Only active / registered desks send risk-adding transactions.
   */
  deskStatus?: ((laneAddress: Address) => DeskStatus | null) | undefined;
}

const MAX_FEE_RESIGNS = 2;

function simSummary(sim: SimulationResult): string {
  return canonicalJson({
    ok: sim.ok,
    blockNumber: sim.blockNumber,
    latestBlockNumber: sim.latestBlockNumber,
    gasEstimate: sim.gasEstimate,
    rerange: sim.rerange,
    error: sim.error,
  });
}

export function createRhExecutor(deps: RhExecutorDeps): Executor {
  const { db, chain, signer, calldata, clock, logger } = deps;
  const signerAddress = signer.address.toLowerCase() as `0x${string}`;
  const margin = deps.timing.broadcastMarginSec ?? 2;
  const statusDeps = { db, notifier: deps.notifier, logger };
  const deskStatus = deps.deskStatus ?? ((lane: Address) => db.getDesk(lane)?.status ?? null);

  /** Why this step may not be sent right now, or null when it may (fail-closed on a read error). */
  function haltedReason(step: PreparedStep): string | null {
    if (step.riskClass !== "adding") return null;
    let status: DeskStatus | null;
    try {
      status = deskStatus(step.laneAddress);
    } catch (err) {
      return `desk status unreadable (${err instanceof Error ? err.message : String(err)})`;
    }
    if (status === "active" || status === "registered") return null;
    return status === null ? "no desk row for this lane" : `desk is ${status}`;
  }

  function assertLaneStep(req: StepRequest): asserts req is StepRequest & {
    action: Exclude<StepRequest["action"], { kind: "hedge" }>;
  } {
    if (req.action.kind === "hedge")
      throw new Error("rh executor: hedge steps belong to the HL executor");
    if (req.laneAddress.toLowerCase() !== calldata.laneAddress) {
      throw new Error(
        `rh executor: step lane ${req.laneAddress} is not the configured lane ${calldata.laneAddress}`,
      );
    }
    const expectedId = encodeDecisionId(req.decisionId, req.step);
    if (req.meta.decisionId.toLowerCase() !== expectedId) {
      throw new Error(`rh executor: Meta.decisionId is not step ${req.step} of ${req.decisionId}`);
    }
    if (riskClassOf(req.action) !== req.riskClass) {
      throw new Error(`rh executor: risk class ${req.riskClass} does not match the action`);
    }
  }

  function outcomeOf(executionId: number): StepOutcome {
    const e = db.getExecution(executionId);
    if (e === null) throw new Error(`rh executor: execution ${executionId} vanished`);
    const last = db.latestAttempt(executionId);
    return {
      executionId,
      status: e.status,
      txHash: e.txHash,
      error:
        e.errorCode === null ? null : { code: e.errorCode, message: e.statusDetail ?? e.errorCode },
      gasUsed: e.gasUsed,
      feeWei: e.feeWei,
      feeUsdCents: e.feeUsdCents,
      blockNumber: last?.blockNumber === null || last === null ? null : BigInt(last.blockNumber),
    };
  }

  /** Sign (timeout, one retry if unavailable), verify, then persist bytes + nonce atomically. */
  async function signVerifyPersist(
    executionId: number,
    tx: UnsignedTx,
    attempt: number,
    deadlineSec: number,
    sim: SimulationResult,
  ): Promise<{ raw: Hex; hash: Hex }> {
    let raw: Hex | null = null;
    for (let i = 0; raw === null; i++) {
      try {
        raw = await signWithTimeout(signer, tx, deps.timing.signTimeoutMs);
      } catch (err) {
        const e = classifySignerError(err);
        if (e.code === "SIGNER_UNAVAILABLE" && i === 0) {
          logger.warn({ executionId, error: e.message }, "signer unavailable; retrying once");
          continue;
        }
        throw e;
      }
    }
    const { hash } = await verifySignedTx(raw, tx, signerAddress);
    const now = clock.now();
    db.transaction(() => {
      db.recordSignedAttempt(
        {
          executionId,
          attempt,
          signerKind: signer.kind,
          fromAddress: signerAddress,
          toAddress: tx.to,
          calldataHash: keccak256(tx.data),
          nonce: tx.nonce,
          gasLimit: tx.gas,
          maxFeePerGas: tx.maxFeePerGas,
          maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
          deadlineSec,
          signedRawTx: raw,
          txHash: hash,
          simJson: simSummary(sim),
          createdAtMs: now,
        },
        now,
      );
      db.advanceNonce(signerAddress, deps.chainId, tx.nonce, now);
    });
    return { raw, hash };
  }

  function finalize(
    executionId: number,
    txHash: Hex | null,
    status: "dropped" | "failed" | "unknown",
    code: ExecError["code"],
    detail: string,
  ) {
    const now = clock.now();
    db.transaction(() => {
      if (txHash !== null) {
        db.updateTxAttempt(txHash, {
          status: status === "unknown" ? "unknown" : "dropped",
          updatedAtMs: now,
        });
      }
      db.updateExecution(executionId, {
        status,
        errorCode: code,
        statusDetail: detail,
        updatedAtMs: now,
        ...(status === "unknown" ? {} : { finalizedAtMs: now }),
      });
    });
  }

  async function run(executionId: number, step: PreparedStep, call: TxCall): Promise<StepOutcome> {
    // 2. Re-simulate at a fresh pinned block: time has passed since prepare (approval windows).
    const block = await chain.getBlock("latest");
    const sim = await deps.simulator.simulate(call, signerAddress, block.number);
    if (!sim.ok || sim.error !== null || sim.gasEstimate === null) {
      const err = sim.error;
      throw new ExecError(
        err?.code ?? "SIM_TRANSIENT",
        `re-simulation failed: ${err?.message ?? "no gas estimate"}`,
        {
          detail: err,
        },
      );
    }
    db.updateExecution(executionId, {
      status: "simulated",
      simulatedAtMs: clock.now(),
      resultJson: simSummary(sim),
      updatedAtMs: clock.now(),
    });

    // 3. Gas and fees.
    const gas = gasLimitFor(sim.gasEstimate);
    const fee = deps.fees.quote(block);
    if (deps.maxGasCents !== undefined && deps.maxGasCents !== null) {
      const cents = feeUsdCents(gas * fee.maxFeePerGas, deps.ethUsd?.() ?? null);
      if (cents !== null && cents > deps.maxGasCents) {
        throw new ExecError(
          "GAS_CAP",
          `worst-case gas ${cents}¢ exceeds the ${deps.maxGasCents}¢ cap`,
        );
      }
    }

    // 4. Nonce (only for a desk that may still act: nothing is signed for a halted desk).
    const halted = haltedReason(step);
    if (halted !== null) throw new ExecError("DESK_HALTED", `${halted}: not signing`);
    const nonce = await deps.nonces.next(signerAddress);
    const deadlineSec = Number(step.meta.deadline);
    let tx: UnsignedTx = {
      type: "eip1559",
      chainId: deps.chainId,
      to: call.to,
      data: call.data,
      value: 0n,
      nonce,
      gas,
      maxFeePerGas: fee.maxFeePerGas,
      maxPriorityFeePerGas: 0n,
    };

    // 5–7. Sign, verify, persist.
    let attempt = 1;
    let signed = await signVerifyPersist(executionId, tx, attempt, deadlineSec, sim);

    // 8. Broadcast (deadline and desk status permitting).
    for (let resigns = 0; ; ) {
      // Safe mode or a revocation may have landed while this step was signing.
      const haltedNow = haltedReason(step);
      if (haltedNow !== null) {
        finalize(
          executionId,
          signed.hash,
          "dropped",
          "DESK_HALTED",
          `${haltedNow} before broadcast; signed bytes never sent`,
        );
        return outcomeOf(executionId);
      }
      if (Math.floor(clock.now() / 1000) + margin >= deadlineSec) {
        finalize(
          executionId,
          signed.hash,
          "dropped",
          "DEADLINE_PASSED",
          "deadline passed before broadcast; never sent",
        );
        return outcomeOf(executionId);
      }
      try {
        await deps.broadcaster.broadcast(signed.raw);
        db.markAttemptBroadcast(signed.hash, clock.now());
        break;
      } catch (err) {
        const e = classifyError(err);
        if (e.code === "FEE_CAP_TOO_LOW" && resigns < MAX_FEE_RESIGNS) {
          // The node rejected these bytes outright: retire them and re-sign at the SAME nonce,
          // unless the desk stopped in the meantime.
          const haltedResign = haltedReason(step);
          if (haltedResign !== null) {
            finalize(
              executionId,
              signed.hash,
              "dropped",
              "DESK_HALTED",
              `${haltedResign}: not re-signing after FEE_CAP_TOO_LOW; nothing sent`,
            );
            return outcomeOf(executionId);
          }
          db.updateTxAttempt(signed.hash, { status: "replaced", updatedAtMs: clock.now() });
          const b = await chain.getBlock("latest");
          const q = deps.fees.bump(b, tx.maxFeePerGas);
          tx = { ...tx, maxFeePerGas: q.maxFeePerGas };
          resigns += 1;
          attempt += 1;
          logger.warn(
            { executionId, nonce, maxFeePerGas: String(q.maxFeePerGas) },
            "fee cap too low; re-signing at the same nonce",
          );
          signed = await signVerifyPersist(executionId, tx, attempt, deadlineSec, sim);
          continue;
        }
        if (e.code === "NONCE_TOO_LOW") {
          const known =
            (await chain.getTransaction(signed.hash)) ??
            (await chain.getTransactionReceipt(signed.hash));
          if (known !== null) {
            db.markAttemptBroadcast(signed.hash, clock.now());
            break;
          }
          finalize(
            executionId,
            signed.hash,
            "dropped",
            "NONCE_CONFLICT",
            `nonce ${nonce} already used by a transaction that is not ours`,
          );
          await enterSafeMode(
            statusDeps,
            step.laneAddress,
            `NONCE_CONFLICT on nonce ${nonce}`,
            clock.now(),
          );
          return outcomeOf(executionId);
        }
        if (e.code === "RPC_UNAVAILABLE" || e.code === "UNKNOWN") {
          // The bytes may have reached a node: unknown, for the resolver. Never re-sign.
          finalize(
            executionId,
            signed.hash,
            "unknown",
            e.code,
            `broadcast outcome unknown: ${e.message}`,
          );
          return outcomeOf(executionId);
        }
        // Refused by the node (not in any pool): final for this step.
        finalize(executionId, signed.hash, "dropped", e.code, `broadcast refused: ${e.message}`);
        await applyErrorOutcome(statusDeps, step.laneAddress, e, clock.now());
        return outcomeOf(executionId);
      }
    }

    // 9. Receipt.
    const r = await deps.broadcaster.waitForReceipt(signed.hash, {
      pollMs: deps.timing.receiptPollMs,
      timeoutMs: deps.timing.receiptTimeoutMs,
    });
    const attemptRow = db.getAttemptByHash(signed.hash);
    if (attemptRow === null) throw new Error(`rh executor: attempt ${signed.hash} vanished`);
    if (r.kind === "confirmed") {
      recordReceipt({ db, ethUsd: deps.ethUsd }, attemptRow, r.receipt, clock.now());
      return outcomeOf(executionId);
    }
    if (r.kind === "reverted") {
      let errorName: string | null = null;
      try {
        await chain.call({
          from: signerAddress,
          to: call.to,
          data: call.data,
          blockNumber: r.receipt.blockNumber - 1n,
        });
      } catch (err) {
        const decoded = classifyRevert(revertDataOf(err), err);
        const d = decoded.detail as { errorName?: string | null } | undefined;
        errorName = d?.errorName ?? null;
      }
      recordReceipt({ db, ethUsd: deps.ethUsd }, attemptRow, r.receipt, clock.now(), errorName);
      await deps.notifier?.notify({
        kind: "execution",
        severity: "warn",
        lane: step.lane,
        laneAddress: step.laneAddress,
        title: `Reverted: ${step.action.kind}`,
        lines: [errorName === null ? "revert reason unknown" : `reason: ${errorName}`],
        decisionId: step.decisionId,
        txHash: signed.hash,
      });
      return outcomeOf(executionId);
    }
    finalize(
      executionId,
      signed.hash,
      "unknown",
      "RECEIPT_TIMEOUT",
      "no receipt within the timeout",
    );
    if (deps.resolver !== undefined) {
      const cur = db.getAttemptByHash(signed.hash);
      if (cur !== null) {
        try {
          await deps.resolver.resolve(cur, clock.now());
        } catch (err) {
          logger.warn(
            { executionId, error: classifyError(err).message },
            "attempt resolution failed; left for the reconciler",
          );
        }
      }
    }
    return outcomeOf(executionId);
  }

  return {
    venue: "rh",

    async prepare(req): Promise<PreparedStep> {
      assertLaneStep(req);
      const call = calldata.encode(req.action, req.meta);
      const block = await chain.getBlock("latest");
      const simulation = await deps.simulator.simulate(call, signerAddress, block.number);
      return { ...req, venue: "rh", call, simulation, hlOrder: null };
    },

    async execute(step): Promise<StepOutcome> {
      if (step.venue !== "rh" || step.call === null) throw new Error("rh executor: not an rh step");
      assertLaneStep(step);
      // Defence in depth: the call must be exactly what config + action + meta encode to.
      const call = calldata.encode(step.action, step.meta);
      if (
        call.to !== step.call.to.toLowerCase() ||
        call.data.toLowerCase() !== step.call.data.toLowerCase() ||
        step.call.value !== 0n ||
        !OPERATOR_SELECTOR_SET.has(call.selector)
      ) {
        throw new Error("rh executor: the prepared call differs from a fresh encode from config");
      }
      if (step.simulation === null || !step.simulation.ok) {
        throw new ExecError(
          step.simulation?.error?.code ?? "SIM_TRANSIENT",
          "refusing to execute a step whose simulation failed",
        );
      }

      // 1. Write-ahead row, atomically with idempotency and single-in-flight.
      const onchainId = encodeDecisionId(step.decisionId, step.step);
      const now = clock.now();
      const executionId = db.transaction(() => {
        if (
          db.hasExecutionStep(step.decisionId, step.step) ||
          db.getExecutionByOnchainId(onchainId) !== null
        ) {
          throw new ExecError(
            "SIM_DECISION_USED",
            `step ${step.step} of ${step.decisionId} already has an execution`,
          );
        }
        const inFlight = db.inFlightCount(signerAddress);
        if (inFlight > 0) {
          throw new ExecError(
            "SIM_TRANSIENT",
            `${inFlight} transaction(s) already in flight for ${signerAddress}`,
          );
        }
        return db.insertExecution({
          decisionId: step.decisionId,
          stepIndex: step.step,
          onchainId,
          laneAddress: step.laneAddress,
          venue: "rh",
          action: step.action.kind,
          riskClass: step.riskClass,
          notionalCents: step.notionalCents,
          signerAddress,
          status: "prepared",
          createdAtMs: now,
          updatedAtMs: now,
        });
      });

      try {
        return await run(executionId, step, call);
      } catch (err) {
        const e = isExecError(err) ? err : classifyError(err);
        const exec = db.getExecution(executionId);
        const nowMs = clock.now();
        if (exec !== null && exec.signedAtMs === null) {
          db.updateExecution(executionId, {
            status: "failed",
            errorCode: e.code,
            statusDetail: e.message,
            finalizedAtMs: nowMs,
            updatedAtMs: nowMs,
          });
        } else if (exec !== null) {
          // Signed at least once: settle from the attempts, never assume nothing landed.
          const open = db
            .attemptsForExecution(executionId)
            .filter(
              (a) => a.status === "signed" || a.status === "broadcast" || a.status === "unknown",
            );
          const everSent = db.attemptsForExecution(executionId).some((a) => a.broadcastCount > 0);
          db.updateExecution(executionId, {
            status: open.length > 0 || everSent ? "unknown" : "dropped",
            errorCode: e.code,
            statusDetail: e.message,
            updatedAtMs: nowMs,
            ...(open.length > 0 || everSent ? {} : { finalizedAtMs: nowMs }),
          });
        }
        logger.warn({ executionId, code: e.code, error: e.message }, "execution step failed");
        await applyErrorOutcome(statusDeps, step.laneAddress, e, nowMs);
        return outcomeOf(executionId);
      }
    },
  };
}
