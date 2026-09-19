/**
 * LaneAction reconciliation (every 30 s): read the lane's LaneAction logs from `cursor + 1` to
 * `latest − 20` and match each to one of our executions.
 *
 * Matching: by decisionId (executions.onchain_id), else by transaction hash (pause() carries no
 * Meta). A match also requires the same lane and the operator as caller. Anything else is FOREIGN,
 * including the owner acting directly from the web or the explorer, the guardian (watchdog), or a
 * second agent instance: the desk goes to safe mode (advisory) and an alert is sent. An event that
 * proves an `unknown` execution landed marks it confirmed.
 *
 * The cursor only advances past a chunk once every log in it is stored, so a crash replays at most
 * one chunk, and lane_actions dedupes on (tx_hash, log_index).
 */

import { decodeEventLog, toEventSelector } from "viem";
import { canonicalJson } from "../canonical.js";
import { deskLaneAbi } from "../executor/abi/DeskLane.js";
import { enterSafeMode } from "../executor/safe-mode.js";
import type {
  Address,
  ChainClient,
  Clock,
  DeskDb,
  DeskLogger,
  ExecutionRow,
  Hex,
  LaneActionEvent,
  LaneActionReconciler,
  Notifier,
  RawLog,
  ReconcileReport,
} from "../types.js";
import { LANE_ACTION_NAMES } from "../types.js";

export type { LaneActionEvent, LaneActionReconciler, ReconcileReport } from "../types.js";

const laneActionEvent = deskLaneAbi.find(
  (i): i is Extract<(typeof deskLaneAbi)[number], { type: "event"; name: "LaneAction" }> =>
    i.type === "event" && i.name === "LaneAction",
);
if (laneActionEvent === undefined) throw new Error("LaneAction event missing from the lane ABI");

export const LANE_ACTION_TOPIC: Hex = toEventSelector(laneActionEvent);

export function decodeLaneAction(log: RawLog): LaneActionEvent {
  const { args } = decodeEventLog({
    abi: deskLaneAbi,
    eventName: "LaneAction",
    data: log.data,
    topics: log.topics as [Hex, ...Hex[]],
  });
  return {
    txHash: log.transactionHash.toLowerCase() as Hex,
    logIndex: log.logIndex,
    blockNumber: log.blockNumber,
    laneAddress: log.address.toLowerCase() as Address,
    laneId: Number(args.lane),
    decisionId: args.decisionId.toLowerCase() as Hex,
    action: Number(args.action),
    ticks: args.ticks.map(Number),
    refPxE18: args.refPxE18,
    regime: Number(args.regime),
    gatesMask: Number(args.gatesMask),
    reasonHash: args.reasonHash.toLowerCase() as Hex,
    caller: args.caller.toLowerCase() as Address,
  };
}

export function actionName(action: number): string {
  return LANE_ACTION_NAMES[action] ?? `ACTION_${action}`;
}

export interface LaneActionReconcilerDeps {
  db: DeskDb;
  chain: Pick<ChainClient, "blockNumber" | "getLogs">;
  /** The lanes to watch (config lanes plus registered desks). */
  lanes: () => readonly Address[];
  clock: Clock;
  logger: DeskLogger;
  notifier?: Notifier | undefined;
  /** Blocks behind latest considered final. Default 20. */
  confirmations?: number;
  /** Max blocks per eth_getLogs. Default 5_000. */
  chunkBlocks?: bigint;
  /** First block to scan for a lane without a cursor (e.g. its creation block). */
  startBlock?: (lane: Address, safeHead: bigint) => bigint;
}

export function cursorName(lane: Address): string {
  return `lane_actions:${lane.toLowerCase()}`;
}

export function createLaneActionReconciler(deps: LaneActionReconcilerDeps): LaneActionReconciler {
  const confirmations = BigInt(deps.confirmations ?? 20);
  const chunk = deps.chunkBlocks ?? 5_000n;
  const { db, logger } = deps;

  function matchExecution(ev: LaneActionEvent): ExecutionRow | null {
    const byId = db.getExecutionByOnchainId(ev.decisionId);
    const exec =
      byId ??
      (() => {
        const a = db.getAttemptByHash(ev.txHash);
        return a === null ? null : db.getExecution(a.executionId);
      })();
    if (exec === null) return null;
    if (exec.laneAddress.toLowerCase() !== ev.laneAddress) return null;
    if (exec.signerAddress === null || exec.signerAddress.toLowerCase() !== ev.caller) return null;
    return exec;
  }

  async function processLog(log: RawLog, nowMs: number): Promise<"matched" | "foreign"> {
    const ev = decodeLaneAction(log);
    db.insertLaneAction({
      txHash: ev.txHash,
      logIndex: ev.logIndex,
      laneAddress: ev.laneAddress,
      blockNumber: Number(ev.blockNumber),
      blockTs: null,
      decisionId: ev.decisionId,
      action: ev.action,
      actionName: actionName(ev.action),
      ticksJson: canonicalJson(ev.ticks),
      refPxE18: ev.refPxE18,
      regime: ev.regime,
      gatesMask: ev.gatesMask,
      reasonHash: ev.reasonHash,
      caller: ev.caller,
      matchedExecutionId: null,
      matchStatus: "pending",
      seenAtMs: nowMs,
      matchedAtMs: null,
    });
    const exec = matchExecution(ev);
    if (exec !== null) {
      db.transaction(() => {
        db.setLaneActionMatch(ev.txHash, ev.logIndex, "matched", exec.executionId, nowMs);
        if (exec.status === "unknown" || exec.status === "broadcast" || exec.status === "signed") {
          const attempt = db.getAttemptByHash(ev.txHash);
          if (attempt !== null && attempt.executionId === exec.executionId) {
            db.updateTxAttempt(ev.txHash, {
              status: "confirmed",
              blockNumber: Number(ev.blockNumber),
              updatedAtMs: nowMs,
            });
          }
          db.updateExecution(exec.executionId, {
            status: "confirmed",
            txHash: ev.txHash,
            statusDetail: "confirmed by its LaneAction log",
            finalizedAtMs: nowMs,
            updatedAtMs: nowMs,
          });
        }
      });
      return "matched";
    }
    db.setLaneActionMatch(ev.txHash, ev.logIndex, "foreign", null, nowMs);
    logger.warn(
      { lane: ev.laneAddress, txHash: ev.txHash, action: actionName(ev.action), caller: ev.caller },
      "foreign LaneAction",
    );
    await enterSafeMode(
      { db, notifier: deps.notifier, logger },
      ev.laneAddress,
      `foreign LaneAction ${actionName(ev.action)} by ${ev.caller} in ${ev.txHash}`,
      nowMs,
    );
    return "foreign";
  }

  return {
    async run(nowMs): Promise<ReconcileReport> {
      const latest = await deps.chain.blockNumber();
      const safeHead = latest - confirmations;
      const report: ReconcileReport = {
        fromBlock: safeHead,
        toBlock: safeHead,
        matched: 0,
        foreign: 0,
        pending: 0,
      };
      if (safeHead < 0n) return report;
      let minFrom: bigint | null = null;
      for (const lane of deps.lanes()) {
        const name = cursorName(lane);
        const cursor = db.getCursor(name);
        let from =
          cursor === null
            ? (deps.startBlock?.(lane, safeHead) ?? (safeHead > 1_000n ? safeHead - 1_000n : 0n))
            : BigInt(cursor) + 1n;
        if (minFrom === null || from < minFrom) minFrom = from;
        while (from <= safeHead) {
          const to = from + chunk - 1n < safeHead ? from + chunk - 1n : safeHead;
          const logs = await deps.chain.getLogs({
            address: lane,
            fromBlock: from,
            toBlock: to,
            topics: [LANE_ACTION_TOPIC],
          });
          logs.sort((a, b) =>
            a.blockNumber === b.blockNumber
              ? a.logIndex - b.logIndex
              : a.blockNumber < b.blockNumber
                ? -1
                : 1,
          );
          for (const log of logs) {
            if (log.address.toLowerCase() !== lane.toLowerCase()) continue;
            if ((log.topics[0] ?? "").toLowerCase() !== LANE_ACTION_TOPIC) continue;
            const r = await processLog(log, nowMs);
            report[r] += 1;
          }
          db.setCursor(name, Number(to), nowMs);
          from = to + 1n;
        }
      }
      report.fromBlock = minFrom ?? safeHead;
      report.pending = db.laneActionsByMatch("pending").length;
      return report;
    },
  };
}
