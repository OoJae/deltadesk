/**
 * Gate machine: pure. A gate turns ON the tick it is triggered and turns OFF only after its dwell:
 * `clearTicks` consecutive untriggered ticks AND `clearMs` since the clear streak began (HALT: 2 min).
 * Any trigger during the dwell resets the streak.
 *
 * Fail-closed choices:
 * - An implemented gate with no trigger in a step is treated as triggered ("not evaluated").
 * - By default every implemented reduce-only gate STARTS active, so a restart cannot skip a dwell
 *   that was in progress; the first clear dwell re-arms. HALT never starts active: its effect is
 *   "flat" (exitAll), and a restart must not flatten the lane.
 * - A clock that steps backwards never completes a dwell.
 * Stub gates (implemented: false) are never active; they show as "not armed".
 */

import {
  GATE_EFFECT,
  GATE_IMPLEMENTED,
  GATE_NAMES,
  type GateDwell,
  type GateMachine,
  type GateMachineState,
  type GateName,
  type GateState,
  type GateTransition,
  type GateTrigger,
} from "../types.js";

export type {
  GateDwell,
  GateMachine,
  GateMachineState,
  GateState,
  GateTransition,
} from "../types.js";

export const DEFAULT_GATE_DWELL: Readonly<Record<GateName, GateDwell>> = {
  CLOSED: { clearTicks: 3, clearMs: 0 },
  HALT: { clearTicks: 3, clearMs: 120_000 },
  "CORP-ACTION": { clearTicks: 3, clearMs: 0 },
  "STALE-REF": { clearTicks: 3, clearMs: 0 },
  "REOPEN-GUARD": { clearTicks: 3, clearMs: 0 },
  "BOUND-PINNED": { clearTicks: 3, clearMs: 0 },
  "WRAPPER-PREMIUM": { clearTicks: 3, clearMs: 0 },
  EVENT: { clearTicks: 3, clearMs: 0 },
};

export const STUB_REASON = "not armed (stub, implemented: false)";
export const STARTUP_REASON = "startup: held until the first clear dwell";

export interface GateMachineOptions {
  dwell?: Partial<Record<GateName, GateDwell>>;
  /** Start implemented reduce-only gates active (default true). */
  startActive?: boolean;
}

function inactive(name: GateName, reason: string): GateState {
  return {
    name,
    implemented: GATE_IMPLEMENTED[name],
    active: false,
    activeSinceMs: null,
    clearTicks: 0,
    clearSinceMs: null,
    reason,
    effect: GATE_EFFECT[name],
  };
}

export function createGateMachine(opts: GateMachineOptions = {}): GateMachine {
  const dwell: Record<GateName, GateDwell> = { ...DEFAULT_GATE_DWELL, ...opts.dwell };
  const startActive = opts.startActive ?? true;

  function initial(nowMs: number): GateMachineState {
    const gates = {} as Record<GateName, GateState>;
    for (const name of GATE_NAMES) {
      if (!GATE_IMPLEMENTED[name]) {
        gates[name] = inactive(name, STUB_REASON);
      } else if (startActive && GATE_EFFECT[name] === "reduce_only") {
        gates[name] = { ...inactive(name, STARTUP_REASON), active: true, activeSinceMs: nowMs };
      } else {
        gates[name] = inactive(name, "clear");
      }
    }
    return { gates, updatedAtMs: nowMs };
  }

  function step(
    prev: GateMachineState,
    triggers: readonly GateTrigger[],
    nowMs: number,
  ): { next: GateMachineState; transitions: GateTransition[] } {
    const byGate = new Map<GateName, GateTrigger>();
    for (const t of triggers) {
      const seen = byGate.get(t.gate);
      // Two triggers for one gate: any positive one wins.
      if (seen === undefined || (!seen.triggered && t.triggered)) byGate.set(t.gate, t);
    }

    const gates = {} as Record<GateName, GateState>;
    const transitions: GateTransition[] = [];

    for (const name of GATE_NAMES) {
      const before = prev.gates[name] ?? inactive(name, "clear");
      if (!GATE_IMPLEMENTED[name]) {
        gates[name] = inactive(name, byGate.get(name)?.reason ?? STUB_REASON);
        continue;
      }
      const trigger = byGate.get(name) ?? {
        gate: name,
        triggered: true,
        reason: "no trigger evaluated (fail-closed)",
      };

      if (trigger.triggered) {
        if (!before.active) {
          transitions.push({ gate: name, active: true, atMs: nowMs, reason: trigger.reason });
        }
        gates[name] = {
          ...before,
          active: true,
          activeSinceMs: before.active ? before.activeSinceMs : nowMs,
          clearTicks: 0,
          clearSinceMs: null,
          reason: trigger.reason,
        };
        continue;
      }

      if (!before.active) {
        gates[name] = inactive(name, trigger.reason);
        continue;
      }

      const clearTicks = before.clearTicks + 1;
      const clearSinceMs = before.clearSinceMs ?? nowMs;
      const elapsed = nowMs - clearSinceMs;
      const d = dwell[name];
      if (clearTicks >= d.clearTicks && elapsed >= d.clearMs && elapsed >= 0) {
        const reason = `cleared after ${clearTicks} clear tick(s) and ${Math.round(elapsed / 1000)} s`;
        transitions.push({ gate: name, active: false, atMs: nowMs, reason });
        gates[name] = inactive(name, reason);
      } else {
        // Still active: keep the reason that switched it on; clearTicks shows the dwell progress.
        gates[name] = { ...before, clearTicks, clearSinceMs };
      }
    }

    return { next: { gates, updatedAtMs: nowMs }, transitions };
  }

  return { initial, step };
}

export const gateMachine: GateMachine = createGateMachine();
