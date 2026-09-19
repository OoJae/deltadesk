/**
 * Desk-level consequences of an execution outcome (shared by the executor, the reconcilers and the
 * webhook): safe mode (the daemon treats a desk in safe_mode as advisory until the owner re-signs a
 * mode change), revoked, and the alert that goes with each. Never throws into the caller.
 */

import type {
  Address,
  DeskDb,
  DeskLogger,
  DeskStatus,
  ExecError,
  Notifier,
  NotifySeverity,
} from "../types.js";

export interface DeskStatusDeps {
  db: Pick<DeskDb, "getDesk" | "setDeskStatus">;
  notifier?: Notifier | undefined;
  logger?: Pick<DeskLogger, "warn" | "error"> | undefined;
}

async function transition(
  deps: DeskStatusDeps,
  laneAddress: Address,
  status: DeskStatus,
  reason: string,
  nowMs: number,
  severity: NotifySeverity,
): Promise<void> {
  try {
    const desk = deps.db.getDesk(laneAddress);
    // A revoked desk stays revoked: safe mode never downgrades it.
    if (desk !== null && !(desk.status === "revoked" && status === "safe_mode")) {
      deps.db.setDeskStatus(laneAddress, status, reason, nowMs);
    }
  } catch (err) {
    deps.logger?.error(
      { lane: laneAddress, status, error: err instanceof Error ? err.message : String(err) },
      "failed to persist desk status",
    );
  }
  deps.logger?.warn({ lane: laneAddress, status, reason }, `desk → ${status}`);
  await deps.notifier?.notify({
    kind: "safe-mode",
    severity,
    lane: null,
    laneAddress,
    title: status === "revoked" ? "Desk revoked" : "Desk in SAFE MODE",
    lines: [reason],
  });
}

export function enterSafeMode(
  deps: DeskStatusDeps,
  laneAddress: Address,
  reason: string,
  nowMs: number,
  severity: NotifySeverity = "critical",
): Promise<void> {
  return transition(deps, laneAddress, "safe_mode", reason, nowMs, severity);
}

export function markRevoked(
  deps: DeskStatusDeps,
  laneAddress: Address,
  reason: string,
  nowMs: number,
): Promise<void> {
  return transition(deps, laneAddress, "revoked", reason, nowMs, "critical");
}

/** Apply the desk-level half of an error's outcome (the decision status is the daemon's). */
export async function applyErrorOutcome(
  deps: DeskStatusDeps,
  laneAddress: Address,
  err: ExecError,
  nowMs: number,
): Promise<void> {
  switch (err.outcome) {
    case "policy_denied":
      await enterSafeMode(deps, laneAddress, `signer policy denial: ${err.message}`, nowMs);
      return;
    case "safe_mode":
      await enterSafeMode(deps, laneAddress, `${err.code}: ${err.message}`, nowMs);
      return;
    case "critical":
      await enterSafeMode(deps, laneAddress, `CRITICAL ${err.code}: ${err.message}`, nowMs);
      return;
    case "revoked":
      await markRevoked(deps, laneAddress, err.message, nowMs);
      return;
    case "top_up_alert":
      await deps.notifier?.notify({
        kind: "alert",
        severity: "warn",
        lane: null,
        laneAddress,
        title: err.code === "GAS_CAP" ? "Gas above the configured cap" : "Operator needs ETH",
        lines: [err.message],
      });
      return;
    default:
      return;
  }
}
