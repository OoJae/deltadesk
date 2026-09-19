/**
 * Interruptibility: advisory, copilot and autopilot, with the human reachable from the web, from
 * Telegram and from a file.
 *
 *   advisory  full pipeline, real alerts, never executes (recorded as 'advisory', not 'dry_run':
 *             DRY_RUN is a safety flag, advisory is a product mode).
 *   copilot   risk-ADDING steps wait for an explicit approve within the window; silence is no,
 *             recorded as 'declined'. Risk-reducing steps run without waiting: an unreachable owner
 *             must not keep a halted lane in the pool.
 *   autopilot acts, but announces a cancel window for risk-adding steps (M3). Without a cancel
 *             window (DESK_CANCEL_WINDOW_SEC=0) there is no human chance to stop it, so it runs as
 *             copilot (fail-closed), whatever the desk row says.
 * A veto (denial, timeout, cancel) anchors a per-lane cooldown that survives restarts (onVeto →
 * db.recordCooldownAnchor).
 *
 * Channels: the web API and the Telegram buttons write to the approvals table
 * (db.respondApproval); the file gate is `touch approve-<decisionId>` / `cancel-<decisionId>`.
 * createApprovalGate polls both, and the first explicit answer wins.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type {
  ApprovalAnswer,
  ApprovalChannel,
  ApprovalGate,
  ApprovalOutcome,
  ApprovalRequest,
  CancelAnswer,
  Clock,
  DeskDb,
  DeskMode,
  RiskClass,
  Sleep,
} from "../types.js";

const realSleep: Sleep = (ms) => new Promise<void>((r) => setTimeout(r, ms));
const systemClock: Clock = { now: () => Date.now() };

/** No channel configured: copilot cannot be satisfied, so it denies; the cancel window is a no-op. */
export const noopApprovalGate: ApprovalGate = {
  async requestApproval() {
    return { approved: false, outcome: "timeout", channel: null };
  },
  async awaitCancelWindow() {
    return { cancelled: false, channel: null };
  },
};

export interface ApprovalGateOptions {
  /** Web and Telegram answers land in the approvals table. */
  db?: Pick<DeskDb, "createApproval" | "getApproval" | "closeApproval">;
  /** File channel directory; omitted = no file channel. */
  dir?: string;
  clock?: Clock;
  sleep?: Sleep;
  pollMs?: number;
  /** Called once per request, e.g. to send the Telegram approve/deny buttons. */
  onPrompt?: (req: ApprovalRequest, files: { approve: string; cancel: string } | null) => void;
}

type Signal = { kind: "approve" | "cancel"; channel: ApprovalChannel } | null;

/** Multi-channel gate: polls the approvals table and the file channel until an answer or the window ends. */
export function createApprovalGate(opts: ApprovalGateOptions): ApprovalGate {
  const sleep = opts.sleep ?? realSleep;
  const clock = opts.clock ?? systemClock;
  const pollMs = opts.pollMs ?? 1_000;
  if (opts.dir !== undefined) mkdirSync(opts.dir, { recursive: true });

  const files = (decisionId: string) =>
    opts.dir === undefined
      ? null
      : {
          approve: join(opts.dir, `approve-${decisionId}`),
          cancel: join(opts.dir, `cancel-${decisionId}`),
        };

  function poll(req: ApprovalRequest): Signal {
    const f = files(req.decisionId);
    if (f !== null) {
      // Cancel wins over approve when both exist; both files are consumed so a stale answer can
      // never authorise a later decision.
      if (existsSync(f.cancel)) {
        rmSync(f.cancel, { force: true });
        rmSync(f.approve, { force: true });
        return { kind: "cancel", channel: "file" };
      }
      if (existsSync(f.approve)) {
        rmSync(f.approve, { force: true });
        return { kind: "approve", channel: "file" };
      }
    }
    const row = opts.db?.getApproval(req.decisionId) ?? null;
    if (row !== null && row.status !== "pending") {
      const channel = row.channel ?? "web";
      if (row.status === "approved") return { kind: "approve", channel };
      if (row.status === "denied" || row.status === "cancelled") return { kind: "cancel", channel };
    }
    return null;
  }

  async function watch(req: ApprovalRequest): Promise<{ signal: Signal; timedOut: boolean }> {
    const start = clock.now();
    opts.db?.createApproval({
      decisionId: req.decisionId,
      laneAddress: req.laneAddress,
      summary: req.summary,
      requestedAtMs: start,
      expiresAtMs: start + req.windowMs,
    });
    opts.onPrompt?.(req, files(req.decisionId));
    let waited = 0;
    for (;;) {
      const signal = poll(req);
      if (signal !== null) return { signal, timedOut: false };
      if (waited >= req.windowMs) {
        opts.db?.closeApproval(
          req.decisionId,
          "expired",
          clock.now(),
          "no answer within the window",
        );
        return { signal: null, timedOut: true };
      }
      const step = Math.min(pollMs, req.windowMs - waited);
      await sleep(step);
      waited += step;
    }
  }

  return {
    // Fail-CLOSED: no explicit approval means no execution.
    async requestApproval(req): Promise<ApprovalAnswer> {
      const { signal } = await watch(req);
      if (signal?.kind === "approve")
        return { approved: true, outcome: "approved", channel: signal.channel };
      if (signal?.kind === "cancel")
        return { approved: false, outcome: "denied", channel: signal.channel };
      return { approved: false, outcome: "timeout", channel: null };
    },
    // Fail-OPEN: silence means proceed. That is what autopilot means.
    async awaitCancelWindow(req): Promise<CancelAnswer> {
      const { signal } = await watch(req);
      if (signal?.kind === "cancel") return { cancelled: true, channel: signal.channel };
      // An explicit approve inside the window just ends it early.
      return { cancelled: false, channel: signal?.channel ?? null };
    },
  };
}

/** The Ripcord file gate: `touch approve-<id>` / `cancel-<id>` in a directory, nothing else. */
export function createFileApprovalGate(
  opts: Omit<ApprovalGateOptions, "db"> & { dir: string },
): ApprovalGate {
  return createApprovalGate(opts);
}

// ---------------------------------------------------------------------------------------------

export interface ApprovalDecisionInput {
  mode: DeskMode;
  riskClass: RiskClass;
  gate: ApprovalGate;
  request: ApprovalRequest;
  /** autopilot's cancel window; 0 = no window. */
  cancelWindowMs?: number;
  /** A human veto: anchor the per-lane cooldown (db.recordCooldownAnchor). */
  onVeto?: () => void;
}

export interface ApprovalDecision {
  execute: boolean;
  outcome: ApprovalOutcome;
  channel: ApprovalChannel | null;
  /** The decision status to record when the step does not execute. */
  status: "advisory" | "declined" | null;
}

/** The mode a desk actually runs in: autopilot without a cancel window is copilot (fail-closed). */
export function effectiveMode(mode: DeskMode, cancelWindowMs: number | undefined): DeskMode {
  return mode === "autopilot" && !((cancelWindowMs ?? 0) > 0) ? "copilot" : mode;
}

/** Mode × risk class → execute or not, and what to record. */
export async function decideApproval(input: ApprovalDecisionInput): Promise<ApprovalDecision> {
  const { riskClass, gate, request } = input;
  const mode = effectiveMode(input.mode, input.cancelWindowMs);
  if (mode === "advisory") {
    return { execute: false, outcome: "advisory", channel: null, status: "advisory" };
  }
  if (riskClass !== "adding") {
    return { execute: true, outcome: "not_required", channel: null, status: null };
  }
  if (mode === "copilot") {
    const answer = await gate.requestApproval(request);
    if (answer.approved)
      return { execute: true, outcome: "approved", channel: answer.channel, status: null };
    input.onVeto?.();
    return { execute: false, outcome: answer.outcome, channel: answer.channel, status: "declined" };
  }
  // autopilot (with a cancel window: effectiveMode guarantees it is > 0)
  const windowMs = input.cancelWindowMs ?? 0;
  const answer = await gate.awaitCancelWindow({ ...request, windowMs });
  if (answer.cancelled) {
    input.onVeto?.();
    return { execute: false, outcome: "cancelled", channel: answer.channel, status: "declined" };
  }
  return { execute: true, outcome: "not_required", channel: answer.channel, status: null };
}
