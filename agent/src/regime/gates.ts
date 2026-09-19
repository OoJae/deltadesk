/**
 * Gate triggers (M2). Raw, per tick; the machine (machine.ts) adds the immediate-on / dwell-off.
 *
 *   CLOSED        calendar WEEKEND_DARK or HOLIDAY, or the lane's riskAddingOpen() is false
 *   HALT          Robinhood isTradingHalt (the machine holds it 2 min after it clears)
 *   CORP-ACTION   a pending corporate action for the stock within the horizon (24 h), or an ERC-8056
 *                 uiMultiplier effectiveAt within 24 h, or the corporate-actions feed is unavailable
 *   STALE-REF     a reference lane A needs (pool, HL, k, and RH for halt detection) is not FRESH,
 *                 or there is no fair value
 *   REOPEN-GUARD  weekday_open (validated) or wake (safety-only)
 *   BOUND-PINNED, WRAPPER-PREMIUM, EVENT: stubs, never triggered ("not armed")
 *
 * Unknown state fails closed: a missing corporate-actions feed or a missing reference triggers.
 */

import {
  type DeskSnapshot,
  FENCE_CODES,
  type FreshnessMap,
  type GateEvaluator,
  type GateName,
  type GateTrigger,
  type SourceName,
} from "../types.js";

export type { GateEvaluator, GateName, GateTrigger } from "../types.js";

const HOUR = 3_600_000;

export interface GateEvaluatorOptions {
  /** A pending corporate action triggers from this long before its effective time. */
  corpActionHorizonMs?: number;
  /** An ERC-8056 multiplier change triggers within this window around effectiveAt. */
  multiplierWindowMs?: number;
  /** References that must be FRESH for risk-adding. */
  requiredSources?: readonly SourceName[];
}

export const DEFAULT_REQUIRED_SOURCES: readonly SourceName[] = ["chain", "hl", "k", "rh"];

const FENCE_CODE_NAMES: Readonly<Record<number, string>> = Object.fromEntries(
  Object.entries(FENCE_CODES).map(([name, code]) => [code, name]),
);

export function fenceCodeName(code: number): string {
  return FENCE_CODE_NAMES[code] ?? `code ${code}`;
}

const STUB = (gate: GateName): GateTrigger => ({
  gate,
  triggered: false,
  reason: "not armed (stub, implemented: false)",
});

export function createGateEvaluator(opts: GateEvaluatorOptions = {}): GateEvaluator {
  const horizonMs = opts.corpActionHorizonMs ?? 24 * HOUR;
  const multiplierWindowMs = opts.multiplierWindowMs ?? 24 * HOUR;
  const required = opts.requiredSources ?? DEFAULT_REQUIRED_SOURCES;

  function closed(snapshot: DeskSnapshot): GateTrigger {
    const reasons: string[] = [];
    const cal = snapshot.calendar.name;
    if (cal === "WEEKEND_DARK" || cal === "HOLIDAY") reasons.push(`calendar ${cal}`);
    const open = snapshot.chain?.lane.riskAddingOpen;
    if (open !== undefined && !open.open) {
      reasons.push(`lane riskAddingOpen false (${fenceCodeName(open.code)})`);
    }
    return {
      gate: "CLOSED",
      triggered: reasons.length > 0,
      reason: reasons.length > 0 ? reasons.join("; ") : "market open and lane open",
    };
  }

  function halt(snapshot: DeskSnapshot): GateTrigger {
    const rh = snapshot.rh;
    if (rh?.isTradingHalt === true) {
      return {
        gate: "HALT",
        triggered: true,
        reason: `Robinhood reports a trading halt on ${rh.symbol}`,
      };
    }
    // An unknown halt state is STALE-REF's job (RH is a required reference), not a halt.
    return {
      gate: "HALT",
      triggered: false,
      reason: rh === null ? "RH quote unavailable" : "no halt",
    };
  }

  function corpAction(snapshot: DeskSnapshot, freshness: FreshnessMap, nowMs: number): GateTrigger {
    const reasons: string[] = [];
    const ca = snapshot.corpActions;
    if (ca === null || freshness.corpActions === "UNAVAILABLE") {
      reasons.push("corporate-actions feed unavailable (fail-closed)");
    } else if (ca.pendingForSymbol) {
      const at = ca.nextEffectiveAtMs;
      if (at === null) reasons.push("pending corporate action with no effective date");
      else if (at - nowMs <= horizonMs) {
        reasons.push(`pending corporate action effective ${new Date(at).toISOString()}`);
      }
    }
    const eff = snapshot.chain?.stockToken.effectiveAt ?? null;
    if (eff !== null && eff !== 0n) {
      const distance = Math.abs(nowMs - Number(eff) * 1000);
      if (distance < multiplierWindowMs) {
        reasons.push(
          `uiMultiplier change effectiveAt ${new Date(Number(eff) * 1000).toISOString()}`,
        );
      }
    }
    return {
      gate: "CORP-ACTION",
      triggered: reasons.length > 0,
      reason: reasons.length > 0 ? reasons.join("; ") : "no corporate action within the horizon",
    };
  }

  function staleRef(snapshot: DeskSnapshot, freshness: FreshnessMap): GateTrigger {
    const reasons: string[] = [];
    for (const source of required) {
      if (freshness[source] !== "FRESH") reasons.push(`${source} ${freshness[source]}`);
    }
    if (snapshot.fairValue === null) reasons.push("no fair value F");
    return {
      gate: "STALE-REF",
      triggered: reasons.length > 0,
      reason: reasons.length > 0 ? reasons.join("; ") : "references fresh",
    };
  }

  function reopenGuard(snapshot: DeskSnapshot): GateTrigger {
    const kind = snapshot.calendar.reopenKind;
    return {
      gate: "REOPEN-GUARD",
      triggered: kind !== null,
      reason:
        kind === "weekday_open"
          ? "weekday open window 09:20-09:45 ET (validated)"
          : kind === "wake"
            ? "wake window 19:50-20:15 ET (safety-only)"
            : "outside reopen windows",
    };
  }

  return {
    evaluate({ snapshot, freshness, nowMs }) {
      return [
        closed(snapshot),
        halt(snapshot),
        corpAction(snapshot, freshness, nowMs),
        staleRef(snapshot, freshness),
        reopenGuard(snapshot),
        STUB("BOUND-PINNED"),
        STUB("WRAPPER-PREMIUM"),
        STUB("EVENT"),
      ];
    },
  };
}

export const gateEvaluator: GateEvaluator = createGateEvaluator();
