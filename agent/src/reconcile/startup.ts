/**
 * Startup reconciliation, and the attempt resolver the executor and the reconcile loop share.
 *
 * On startup (before the first tick):
 *   1. executions that never got a signature (prepared / simulated) → failed: nothing can land.
 *   2. every unresolved attempt (signed / broadcast / unknown) is resolved from the chain with its
 *      STORED bytes: a crash after `signed` rebroadcasts those exact bytes and never re-signs.
 *   3. decisions stranded in `executing` are resolved from their executions.
 *
 * Resolving one attempt ("stuck or unknown transactions"):
 *   - a receipt exists → confirmed / reverted (gas, fee and USD recorded; same-nonce siblings
 *     become `replaced`).
 *   - the node still has the tx → pending, leave it.
 *   - getTransactionCount(latest) > nonce and none of our same-nonce attempts has a receipt → the
 *     nonce was consumed by someone else: NONCE_CONFLICT → dropped + safe mode.
 *   - deadline passed and the tx is nowhere → dropped (final: the lane rejects it after its
 *     deadline, so it can never take effect).
 *   - latest == nonce, before the deadline → rebroadcast the same bytes (bounded).
 */

import { canonicalJson } from "../canonical.js";
import { txHashOf } from "../executor/broadcaster.js";
import { classifyError } from "../executor/errors.js";
import { enterSafeMode } from "../executor/safe-mode.js";
import type {
  Broadcaster,
  ChainClient,
  Clock,
  DeskDb,
  DeskLogger,
  Notifier,
  StartupReconciler,
  StartupReport,
  TxAttemptRow,
  TxReceipt,
} from "../types.js";

export type { StartupReconciler, StartupReport } from "../types.js";

export type AttemptResolution =
  | "confirmed"
  | "reverted"
  | "pending"
  | "rebroadcast"
  | "dropped"
  | "conflict"
  | "replaced";

export interface AttemptResolverDeps {
  db: DeskDb;
  chain: Pick<
    ChainClient,
    "getTransactionReceipt" | "getTransaction" | "getTransactionCount" | "sendRawTransaction"
  >;
  broadcaster: Pick<Broadcaster, "broadcast">;
  clock: Clock;
  logger: DeskLogger;
  notifier?: Notifier | undefined;
  /** ETH/USD for the fee in cents; null when unknown. */
  ethUsd?: (() => number | null) | undefined;
  /** Total broadcasts of one signed attempt (initial + rebroadcasts). Default 3. */
  maxBroadcasts?: number;
}

export interface AttemptResolver {
  resolve(attempt: TxAttemptRow, nowMs: number): Promise<AttemptResolution>;
  /** Every unresolved attempt, oldest first. */
  resolveAll(nowMs: number): Promise<Record<AttemptResolution, number>>;
}

export function feeUsdCents(feeWei: bigint, ethUsd: number | null): number | null {
  if (ethUsd === null || !Number.isFinite(ethUsd) || ethUsd <= 0) return null;
  // wei → ETH at 1e-18, → cents; computed in integers down to 1e-6 cent before rounding.
  const microCents = (feeWei * BigInt(Math.round(ethUsd * 1e8))) / 10n ** 18n;
  return Math.round(Number(microCents) / 1e6);
}

function receiptJson(r: TxReceipt): string {
  return canonicalJson({
    transactionHash: r.transactionHash,
    status: r.status,
    blockNumber: r.blockNumber,
    gasUsed: r.gasUsed,
    effectiveGasPrice: r.effectiveGasPrice,
    logs: r.logs.length,
  });
}

/** Record a receipt on the attempt and its execution (and retire same-nonce siblings). */
export function recordReceipt(
  deps: Pick<AttemptResolverDeps, "db" | "ethUsd">,
  attempt: TxAttemptRow,
  receipt: TxReceipt,
  nowMs: number,
  errorName: string | null = null,
): "confirmed" | "reverted" {
  const status = receipt.status === "success" ? "confirmed" : "reverted";
  const feeWei = receipt.gasUsed * receipt.effectiveGasPrice;
  const cents = feeUsdCents(feeWei, deps.ethUsd?.() ?? null);
  deps.db.transaction(() => {
    deps.db.updateTxAttempt(attempt.txHash, {
      status,
      blockNumber: Number(receipt.blockNumber),
      gasUsed: receipt.gasUsed,
      feeWei,
      receiptJson: receiptJson(receipt),
      updatedAtMs: nowMs,
    });
    for (const sib of deps.db.attemptsForExecution(attempt.executionId)) {
      if (sib.txHash !== attempt.txHash && sib.nonce === attempt.nonce && !isFinal(sib)) {
        deps.db.updateTxAttempt(sib.txHash, { status: "replaced", updatedAtMs: nowMs });
      }
    }
    deps.db.updateExecution(attempt.executionId, {
      status,
      txHash: attempt.txHash,
      gasUsed: receipt.gasUsed,
      feeWei,
      feeUsdCents: cents,
      finalizedAtMs: nowMs,
      updatedAtMs: nowMs,
      ...(status === "reverted"
        ? {
            errorCode: "REVERTED" as const,
            statusDetail: `reverted on-chain${errorName === null ? "" : `: ${errorName}`}`,
          }
        : { errorCode: null, statusDetail: null }),
    });
  });
  return status;
}

function isFinal(a: TxAttemptRow): boolean {
  return (
    a.status === "confirmed" ||
    a.status === "reverted" ||
    a.status === "dropped" ||
    a.status === "replaced"
  );
}

export function createAttemptResolver(deps: AttemptResolverDeps): AttemptResolver {
  const maxBroadcasts = deps.maxBroadcasts ?? 3;
  const { db, chain, logger } = deps;

  function drop(
    attempt: TxAttemptRow,
    code: "DEADLINE_PASSED" | "NONCE_CONFLICT",
    detail: string,
    nowMs: number,
  ) {
    db.transaction(() => {
      db.updateTxAttempt(attempt.txHash, { status: "dropped", updatedAtMs: nowMs });
      const siblingsOpen = db
        .attemptsForExecution(attempt.executionId)
        .some((s) => s.txHash !== attempt.txHash && !isFinal(s));
      if (!siblingsOpen) {
        db.updateExecution(attempt.executionId, {
          status: "dropped",
          errorCode: code,
          statusDetail: detail,
          finalizedAtMs: nowMs,
          updatedAtMs: nowMs,
        });
      }
    });
  }

  async function resolve(attempt: TxAttemptRow, nowMs: number): Promise<AttemptResolution> {
    if (isFinal(attempt))
      return attempt.status === "replaced" ? "replaced" : (attempt.status as AttemptResolution);
    const receipt = await chain.getTransactionReceipt(attempt.txHash);
    if (receipt !== null) return recordReceipt(deps, attempt, receipt, nowMs);

    const inPool = await chain.getTransaction(attempt.txHash);
    if (inPool !== null) return "pending";

    const latest = await chain.getTransactionCount(attempt.fromAddress, "latest");
    if (latest > attempt.nonce) {
      // Our nonce is used. Was it one of our own same-nonce attempts (a fee re-sign)?
      for (const sib of db.attemptsForExecution(attempt.executionId)) {
        if (sib.txHash === attempt.txHash || sib.nonce !== attempt.nonce) continue;
        const r = await chain.getTransactionReceipt(sib.txHash);
        if (r !== null) {
          recordReceipt(deps, sib, r, nowMs);
          db.updateTxAttempt(attempt.txHash, { status: "replaced", updatedAtMs: nowMs });
          return "replaced";
        }
      }
      const exec = db.getExecution(attempt.executionId);
      drop(
        attempt,
        "NONCE_CONFLICT",
        `nonce ${attempt.nonce} was consumed by a transaction that is not ours`,
        nowMs,
      );
      if (exec !== null) {
        await enterSafeMode(
          { db, notifier: deps.notifier, logger },
          exec.laneAddress,
          `NONCE_CONFLICT: operator nonce ${attempt.nonce} used by a foreign transaction (ours: ${attempt.txHash})`,
          nowMs,
        );
      }
      return "conflict";
    }

    const nowSec = Math.floor(nowMs / 1000);
    if (nowSec >= attempt.deadlineSec) {
      drop(
        attempt,
        "DEADLINE_PASSED",
        "not mined before its deadline; the lane would reject it now",
        nowMs,
      );
      return "dropped";
    }
    if (latest < attempt.nonce) return "pending"; // an earlier nonce is still outstanding

    if (attempt.broadcastCount >= maxBroadcasts) return "pending";
    if (txHashOf(attempt.signedRawTx).toLowerCase() !== attempt.txHash.toLowerCase()) {
      logger.error(
        { txHash: attempt.txHash },
        "stored bytes do not hash to the stored tx hash; not rebroadcasting",
      );
      return "pending";
    }
    try {
      await deps.broadcaster.broadcast(attempt.signedRawTx);
      db.markAttemptBroadcast(attempt.txHash, nowMs);
      logger.info({ txHash: attempt.txHash, nonce: attempt.nonce }, "rebroadcast stored bytes");
      return "rebroadcast";
    } catch (err) {
      const e = classifyError(err);
      logger.warn({ txHash: attempt.txHash, code: e.code, error: e.message }, "rebroadcast failed");
      return "pending";
    }
  }

  return {
    resolve,
    async resolveAll(nowMs) {
      const tally: Record<AttemptResolution, number> = {
        confirmed: 0,
        reverted: 0,
        pending: 0,
        rebroadcast: 0,
        dropped: 0,
        conflict: 0,
        replaced: 0,
      };
      for (const a of db.unresolvedAttempts()) {
        // Re-read: resolving an earlier sibling may have finalised this one.
        const cur = db.getAttemptByHash(a.txHash) ?? a;
        try {
          tally[await resolve(cur, nowMs)] += 1;
        } catch (err) {
          const e = classifyError(err);
          logger.warn(
            { txHash: a.txHash, code: e.code, error: e.message },
            "could not resolve attempt",
          );
          if (cur.status === "signed" || cur.status === "broadcast") {
            db.updateTxAttempt(cur.txHash, { status: "unknown", updatedAtMs: nowMs });
          }
          tally.pending += 1;
        }
      }
      return tally;
    },
  };
}

export interface StartupReconcilerDeps extends AttemptResolverDeps {}

export function createStartupReconciler(deps: StartupReconcilerDeps): StartupReconciler {
  const resolver = createAttemptResolver(deps);
  return {
    async run(nowMs): Promise<StartupReport> {
      const failedUnsigned = deps.db.failUnsignedExecutions(
        "process restarted before a signature was recorded",
        nowMs,
      );
      const t = await resolver.resolveAll(nowMs);
      const decisionsReconciled = deps.db.reconcileOrphanedDecisions(nowMs);
      const report: StartupReport = {
        failedUnsigned,
        rebroadcast: t.rebroadcast,
        resolved: t.confirmed + t.reverted + t.dropped + t.conflict + t.replaced,
        unknown: t.pending,
        decisionsReconciled,
      };
      deps.logger.info({ ...report }, "startup reconciliation done");
      return report;
    },
  };
}
