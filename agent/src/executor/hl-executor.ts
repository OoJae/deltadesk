/**
 * Hyperliquid executor (lane B's hedge; PAPER in M2).
 *
 * - paper (default): the order is recorded in hl_orders and filled only from the public ws trade
 *   tape (PaperFillEngine). It never constructs or calls an exchange client.
 * - live: only with HL_MODE=live AND HL_ARM=1 and an exchange client; one ALO/IOC order per step.
 *   Unused in M2.
 *
 * Paper fill rules (conservative for queue position):
 *   ALO rests at its limit; a tape trade strictly THROUGH the limit fills min(remaining, trade size)
 *       at the limit. A post-only order that would cross the current quote is rejected.
 *   IOC matches the first tape trade at or better than its limit within `iocWindowMs` of placement,
 *       at the trade price; any remainder is cancelled.
 */

import { keccak256, stringToBytes } from "viem";
import { canonicalJson } from "../canonical.js";
import { decAdd, decCmp, decMin, decSub, decToScaled, decVwap } from "../hl/format.js";
import {
  type Clock,
  type DeskDb,
  type DeskLogger,
  ExecError,
  type Executor,
  type Hex,
  type HlExchangeClient,
  type HlMode,
  type HlOrderRequest,
  type HlOrderRow,
  type HlQuote,
  type HlTrade,
  type PreparedStep,
  riskClassOf,
  type StepOutcome,
} from "../types.js";

export type { Executor, HlOrderRequest, HlOrderResult } from "../types.js";

/** Client order id: the first 16 bytes of keccak256("<ulid>:<step>") (deterministic per step). */
export function hlCloid(decisionUlid: string, step: number): Hex {
  return keccak256(stringToBytes(`${decisionUlid}:${step}`)).slice(0, 34) as Hex;
}

const DEC_RE = /^\d+(\.\d+)?$/;

export interface PaperFillEngineDeps {
  db: Pick<DeskDb, "openHlOrders" | "insertHlFill" | "updateHlOrder" | "transaction">;
  clock: Clock;
  logger?: Pick<DeskLogger, "info" | "warn">;
  iocWindowMs?: number;
}

export interface PaperFillEngine {
  onTrade(trade: HlTrade): number;
  /** Cancel IOC orders whose window has passed. Returns how many. */
  expire(nowMs: number): number;
  /** Subscribe to a trade tape (HlFeed.onTrade); returns the unsubscribe function. */
  attach(tape: { onTrade(listener: (t: HlTrade) => void): () => void }): () => void;
}

export function createPaperFillEngine(deps: PaperFillEngineDeps): PaperFillEngine {
  const iocWindowMs = deps.iocWindowMs ?? 2_000;

  function crosses(o: HlOrderRow, t: HlTrade): boolean {
    const c = decCmp(t.px, o.px);
    if (o.tif === "Alo") return o.isBuy ? c < 0 : c > 0;
    if (t.time > o.createdAtMs + iocWindowMs) return false;
    return o.isBuy ? c <= 0 : c >= 0;
  }

  function fill(o: HlOrderRow, t: HlTrade): boolean {
    const remaining = decSub(o.sz, o.filledSz);
    if (decToScaled(remaining) <= 0n) return false;
    const sz = decMin(remaining, t.sz);
    const px = o.tif === "Alo" ? o.px : t.px;
    const now = deps.clock.now();
    return deps.db.transaction(() => {
      const inserted = deps.db.insertHlFill({
        cloid: o.cloid,
        tid: String(t.tid),
        coin: o.coin,
        px,
        sz,
        side: o.isBuy ? "B" : "A",
        feeUsd: null,
        timeMs: t.time,
        paper: true,
        rawJson: canonicalJson(t),
      });
      if (!inserted) return false;
      const filledSz = decAdd(o.filledSz, sz);
      const full = decCmp(filledSz, o.sz) >= 0;
      deps.db.updateHlOrder(o.cloid, {
        filledSz,
        avgPx: decVwap(o.avgPx, o.filledSz, px, sz),
        status: full ? "filled" : o.tif === "Ioc" ? "canceled" : "partially_filled",
        updatedAtMs: now,
      });
      return true;
    });
  }

  const engine: PaperFillEngine = {
    onTrade(trade) {
      let fills = 0;
      for (const o of deps.db.openHlOrders("paper")) {
        if (o.coin !== trade.coin || trade.time < o.createdAtMs) continue;
        if (crosses(o, trade) && fill(o, trade)) fills += 1;
      }
      return fills;
    },
    expire(nowMs) {
      let n = 0;
      for (const o of deps.db.openHlOrders("paper")) {
        if (o.tif === "Ioc" && nowMs > o.createdAtMs + iocWindowMs) {
          deps.db.updateHlOrder(o.cloid, { status: "canceled", updatedAtMs: nowMs });
          n += 1;
        }
      }
      return n;
    },
    attach(tape) {
      return tape.onTrade((t) => {
        try {
          engine.onTrade(t);
        } catch (err) {
          deps.logger?.warn(
            { error: err instanceof Error ? err.message : String(err) },
            "paper fill failed",
          );
        }
      });
    },
  };
  return engine;
}

export interface HlExecutorDeps {
  db: DeskDb;
  mode: HlMode;
  armed: boolean;
  /** LIVE only. Never called in paper mode (a wiring proof checks it). */
  exchange: HlExchangeClient | null;
  /** Current HL quote, for the post-only would-cross check in paper mode. */
  quote?: (() => HlQuote | null) | undefined;
  clock: Clock;
  logger: DeskLogger;
}

export function createHlExecutor(deps: HlExecutorDeps): Executor {
  const { db, clock } = deps;

  function outcomeOf(executionId: number): StepOutcome {
    const e = db.getExecution(executionId);
    if (e === null) throw new Error(`hl executor: execution ${executionId} vanished`);
    return {
      executionId,
      status: e.status,
      txHash: null,
      error:
        e.errorCode === null ? null : { code: e.errorCode, message: e.statusDetail ?? e.errorCode },
      gasUsed: null,
      feeWei: null,
      feeUsdCents: null,
      blockNumber: null,
    };
  }

  function settle(executionId: number, ok: boolean, detail: string, result: unknown) {
    const now = clock.now();
    db.updateExecution(executionId, {
      status: ok ? "confirmed" : "failed",
      statusDetail: detail,
      errorCode: ok ? null : "SIM_POLICY",
      resultJson: canonicalJson(result),
      finalizedAtMs: now,
      updatedAtMs: now,
    });
  }

  return {
    venue: "hl",

    async prepare(req): Promise<PreparedStep> {
      if (req.action.kind !== "hedge") throw new Error("hl executor: only hedge steps");
      if (riskClassOf(req.action) !== req.riskClass)
        throw new Error("hl executor: risk class mismatch");
      const a = req.action;
      if (!DEC_RE.test(a.sz) || decToScaled(a.sz) <= 0n)
        throw new RangeError(`hl executor: bad size ${a.sz}`);
      if (!DEC_RE.test(a.px) || decToScaled(a.px) <= 0n)
        throw new RangeError(`hl executor: bad price ${a.px}`);
      const hlOrder: HlOrderRequest = {
        cloid: hlCloid(req.decisionId, req.step),
        coin: a.coin,
        asset: a.asset,
        isBuy: a.isBuy,
        sz: a.sz,
        px: a.px,
        tif: a.tif,
        reduceOnly: a.reduceOnly,
      };
      return { ...req, venue: "hl", call: null, simulation: null, hlOrder };
    },

    async execute(step): Promise<StepOutcome> {
      if (step.venue !== "hl" || step.hlOrder === null)
        throw new Error("hl executor: not an hl step");
      const order = step.hlOrder;
      const now = clock.now();
      const executionId = db.transaction(() => {
        if (db.hasExecutionStep(step.decisionId, step.step)) {
          throw new ExecError(
            "SIM_DECISION_USED",
            `step ${step.step} of ${step.decisionId} already has an execution`,
          );
        }
        return db.insertExecution({
          decisionId: step.decisionId,
          stepIndex: step.step,
          onchainId: null,
          laneAddress: step.laneAddress,
          venue: "hl",
          action: "hedge",
          riskClass: step.riskClass,
          notionalCents: step.notionalCents,
          signerAddress: null,
          status: "prepared",
          createdAtMs: now,
          updatedAtMs: now,
        });
      });
      const row: HlOrderRow = {
        cloid: order.cloid,
        decisionId: step.decisionId,
        stepIndex: step.step,
        executionId,
        laneAddress: step.laneAddress,
        coin: order.coin,
        asset: order.asset,
        isBuy: order.isBuy,
        sz: order.sz,
        px: order.px,
        tif: order.tif,
        reduceOnly: order.reduceOnly,
        mode: deps.mode,
        status: "open",
        oid: null,
        filledSz: "0",
        avgPx: null,
        createdAtMs: now,
        updatedAtMs: now,
        responseJson: null,
      };

      if (deps.mode === "paper") {
        const q = deps.quote?.() ?? null;
        const wouldCross =
          order.tif === "Alo" &&
          q !== null &&
          (order.isBuy ? Number(order.px) >= q.ask : Number(order.px) <= q.bid);
        db.insertHlOrder({ ...row, status: wouldCross ? "rejected" : "open" });
        settle(
          executionId,
          !wouldCross,
          wouldCross
            ? "paper ALO would cross the book; rejected"
            : "paper order resting on the tape",
          { paper: true, cloid: order.cloid, status: wouldCross ? "rejected" : "open" },
        );
        return outcomeOf(executionId);
      }

      if (!deps.armed || deps.exchange === null) {
        db.insertHlOrder({ ...row, status: "rejected" });
        settle(executionId, false, "HL live path is not armed (HL_ARM=1 required)", {
          paper: false,
        });
        return outcomeOf(executionId);
      }
      db.insertHlOrder(row);
      const res = await deps.exchange.placeOrder(order);
      db.updateHlOrder(order.cloid, {
        status: res.status,
        oid: res.oid,
        filledSz: res.filledSz,
        avgPx: res.avgPx,
        responseJson: canonicalJson(res),
        updatedAtMs: clock.now(),
      });
      settle(executionId, res.status !== "rejected", res.error ?? `live order ${res.status}`, res);
      return outcomeOf(executionId);
    },
  };
}
