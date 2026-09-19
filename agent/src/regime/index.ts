/**
 * One regime step per lane per tick: freshness → gate triggers → gate machine → risk mode.
 * Pure given its dependencies; the daemon carries `gates` (GateMachineState) across ticks.
 */

import { riskModeOf, stricterRiskMode } from "../guard/risk.js";
import { freshness as defaultFreshness } from "../sense/freshness.js";
import {
  type DeskSnapshot,
  type FreshnessFn,
  GATE_BITS,
  GATE_IMPLEMENTED,
  GATE_NAMES,
  type GateEvaluator,
  type GateMachine,
  type GateMachineState,
  type GateName,
  REGIME_CODE,
  type RegimeState,
  type RiskModel,
} from "../types.js";
import { gateEvaluator as defaultEvaluator } from "./gates.js";
import { gateMachine as defaultMachine } from "./machine.js";

export interface RegimeDeps {
  freshness: FreshnessFn;
  gates: GateEvaluator;
  machine: GateMachine;
  risk: Pick<RiskModel, "riskMode">;
}

export const defaultRegimeDeps: RegimeDeps = {
  freshness: defaultFreshness,
  gates: defaultEvaluator,
  machine: defaultMachine,
  risk: { riskMode: riskModeOf },
};

export function activeGatesOf(state: GateMachineState): GateName[] {
  return GATE_NAMES.filter((g) => GATE_IMPLEMENTED[g] && state.gates[g]?.active === true);
}

export function gatesMaskOf(gates: readonly GateName[]): number {
  return gates.reduce((mask, g) => mask | GATE_BITS[g], 0);
}

export function computeRegime(
  deps: RegimeDeps,
  snapshot: DeskSnapshot,
  prev: GateMachineState,
  nowMs: number,
): RegimeState {
  const fresh = deps.freshness(snapshot.sources, snapshot.calendar.name);
  const triggers = deps.gates.evaluate({ snapshot, freshness: fresh, nowMs });
  const { next, transitions } = deps.machine.step(prev, triggers, nowMs);
  const activeGates = activeGatesOf(next);
  // An injected risk model can only tighten the canonical mapping, never loosen it.
  const riskMode = stricterRiskMode(deps.risk.riskMode(activeGates), riskModeOf(activeGates));
  return {
    calendar: snapshot.calendar,
    regimeCode: REGIME_CODE[snapshot.calendar.name] ?? 0,
    freshness: fresh,
    gates: next,
    activeGates,
    gatesMask: gatesMaskOf(activeGates),
    riskMode,
    transitions,
  };
}
