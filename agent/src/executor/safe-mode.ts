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
  RiskClass,
} from "../types.js";

/** Reads a desk's status right now (the reconciler and the webhook change it concurrently). */
export type DeskStatusProbe = (laneAddress: Address) => DeskStatus | null;

/**
 * Why a transaction of this risk class may not be signed or sent for this lane right now, or null
 * when it may. Only risk-ADDING steps are held back, and only an active / registered desk sends
 * them; safe mode, revoked, disabled, a missing desk row or an unreadable status all refuse
 * (fail-closed). Risk-reducing steps are never held here: they only lower risk. The executor
 * (before signing and before each broadcast) and the attempt resolver (before sending stored bytes)
 * share this one probe.
 */
export function deskHaltedReason(
  deskStatus: DeskStatusProbe,
  laneAddress: Address,
  riskClass: RiskClass,
): string | null {
  if (riskClass !== "adding") return null;
  let status: DeskStatus | null;
  try {
    status = deskStatus(laneAddress);
  } catch (err) {
    return `desk status unreadable (${err instanceof Error ? err.message : String(err)})`;
  }
  if (status === "active" || status === "registered") return null;
  return status === null ? "no desk row for this lane" : `desk is ${status}`;
}

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
