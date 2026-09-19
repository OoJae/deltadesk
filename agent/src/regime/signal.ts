/**
 * Gate signals: every change of a lane's (calendar regime, active gates) state goes on-chain as one
 * delegated `signal(Meta)` LaneAction (agent/README.md "Gate signals"). Pure: the daemon feeds it
 * the regime, the state this process has watched and what the DB says was emitted.
 *
 * Meta of a signal: regime = REGIME_CODE of the announced calendar regime, gatesMask = the OR of
 * GATE_BITS of its active gates, reasonHash = keccak256(canonical JSON of the transition preimage
 * {lane, from, to, at, source}). regime / gatesMask / reasonHash are only logged by the lane.
 *
 * When a signal is planned (detectGateSignal), in order:
 *   - DESK_SIGNAL_GATES=1, and the desk may sign (not halted: safe mode, revoked, disabled, no desk
 *     row, a paused lane or no chain read all refuse), and no transaction is in flight;
 *   - the gate machine has settled: no gate is still held by the startup hold (a restart must not
 *     announce the startup posture);
 *   - the state differs from the last EMITTED one (a signed signal that is confirmed or may still
 *     land), so a restart never re-emits and never misses a change;
 *   - no signal of this lane is still pending or in flight;
 *   - one signal per actual transition: while the lane stays in a state whose signal the owner
 *     DENIED, or whose signed tx reverted (or was dropped after its nonce moved), it is not asked
 *     again; one that was never signed or never reached the chain (blocked, dry-run, advisory,
 *     timed out, expired unmined) is retried after `retryMs`. Once this process sees the lane
 *     hold another state for the dwell and come back, the re-entry is a new transition and is
 *     asked afresh (a shorter flap is not; a state a process only FINDS at startup counts as the
 *     same run, so a restart never re-asks);
 *   - flapping: the state has held for DESK_SIGNAL_MIN_DWELL_SEC (on top of the machine's own
 *     dwell-off), except the lane's very first planned signal, which announces the current state
 *     at once;
 *   - at most DESK_SIGNAL_MAX_PER_HOUR signed signals per lane per rolling hour.
 * A skipped intermediate state is never announced late: the next signal carries the state then.
 */

import { keccak256, stringToBytes } from "viem";
import { canonicalJson } from "../canonical.js";
import {
  type Address,
  GATE_BITS,
  GATE_NAMES,
  type GateMachineState,
  type GateName,
  type GateSignalStatus,
  type Hex,
  REGIME_CODE,
  type RegimeName,
  type RegimeState,
} from "../types.js";
import { STARTUP_REASON } from "./machine.js";

/** The preimage's `source`: the lane's first announcement or a change of state. */
export type GateSignalSource = "initial" | "transition";

/** What a signal announces: the calendar regime and the active (implemented) gates. */
export interface SignalState {
  regime: RegimeName;
  regimeCode: number;
  /** In GATE_NAMES order. */
  gates: GateName[];
  gatesMask: number;
}

export function signalStateOf(regime: RegimeState): SignalState {
  const gates = GATE_NAMES.filter((g) => regime.activeGates.includes(g));
  return {
    regime: regime.calendar.name,
    regimeCode: REGIME_CODE[regime.calendar.name] ?? 0,
    gates,
    gatesMask: gatesMaskOfNames(gates),
  };
}

export function gatesMaskOfNames(gates: readonly GateName[]): number {
  return gates.reduce((m, g) => m | GATE_BITS[g], 0);
}

/** The active gates a gatesMask encodes (unknown bits are ignored). */
export function gatesOfMask(mask: number): GateName[] {
  return GATE_NAMES.filter((g) => (mask & GATE_BITS[g]) !== 0);
}

export const signalKey = (s: Pick<SignalState, "regimeCode" | "gatesMask">): string =>
  `${s.regimeCode}:${s.gatesMask}`;

/** False while any gate is only active because of the machine's startup hold. */
export function gatesSettled(gates: GateMachineState): boolean {
  return Object.values(gates.gates).every((g) => !(g.active && g.reason === STARTUP_REASON));
}

/** The on-chain log's note, also the decision summary: never an address, never a secret. */
export function signalNote(from: SignalState | null, to: SignalState): string {
  const gates = (s: SignalState) => (s.gates.length === 0 ? "none" : s.gates.join("+"));
  if (from === null) return `gates ${gates(to)} · ${to.regime} (initial)`;
  const regime = from.regime === to.regime ? to.regime : `${from.regime} → ${to.regime}`;
  return `gates ${gates(from)} → ${gates(to)} · ${regime}`;
}

export interface SignalPreimageInput {
  lane: Address;
  from: SignalState | null;
  to: SignalState;
  atMs: number;
  source: GateSignalSource;
}

/**
 * The canonical preimage of a signal's Meta.reasonHash:
 *   {lane, from: {regime, gates} | null, to: {regime, gates}, at, source}
 * lane lowercase, regime the calendar regime NAME, gates in GATE_NAMES order, at in ms. Keys are
 * sorted by canonicalJson, so keccak256(utf8(json)) is reproducible from the stored JSON alone.
 */
export function signalPreimage(p: SignalPreimageInput): { json: string; hash: Hex } {
  const side = (s: SignalState) => ({ regime: s.regime, gates: [...s.gates] });
  const json = canonicalJson({
    lane: p.lane.toLowerCase(),
    from: p.from === null ? null : side(p.from),
    to: side(p.to),
    at: p.atMs,
    source: p.source,
  });
  return { json, hash: keccak256(stringToBytes(json)) };
}

/** Recompute a stored preimage's hash (the proof a verifier runs). */
export function hashOfPreimage(json: string): Hex {
  return keccak256(stringToBytes(json));
}

/** The state an emitted signal announced, from its stored columns. */
export function stateOfSignal(row: {
  toRegime: RegimeName;
  regimeCode: number;
  gatesMask: number;
}): SignalState {
  return {
    regime: row.toRegime,
    regimeCode: row.regimeCode,
    gates: gatesOfMask(row.gatesMask),
    gatesMask: row.gatesMask,
  };
}

/** A lane's current state and since when this process has seen it without a break. */
export interface SignalWatch {
  key: string;
  sinceMs: number;
  /** The gate machine was out of its startup hold on the latest tick of this state. */
  settled: boolean;
  /**
   * The last state this process saw really HELD (settled, for the dwell) and then leave, and when
   * it ended. A flap shorter than the dwell never replaces it. Null until one ended: the state a
   * process finds at startup may be the same run a previous process already signalled for.
   */
  away: { key: string; endMs: number } | null;
}

export function watchState(
  prev: SignalWatch | null,
  state: SignalState,
  nowMs: number,
  settled = true,
  minDwellMs = 0,
): SignalWatch {
  const key = signalKey(state);
  if (prev !== null && prev.key === key)
    return prev.settled === settled ? prev : { ...prev, settled };
  // The state just left becomes where the lane was "away" only if it really held (settled, dwell).
  const away =
    prev?.settled && nowMs - prev.sinceMs >= minDwellMs
      ? { key: prev.key, endMs: nowMs }
      : (prev?.away ?? null);
  return { key, sinceMs: nowMs, settled, away };
}

export interface GateSignalInput {
  enabled: boolean;
  /** Why this desk may not sign anything now (safe mode, revoked, paused, …); null: it may. */
  halted: string | null;
  /** Transactions in flight for this lane's signer. */
  inFlight: number;
  state: SignalState;
  settled: boolean;
  watch: SignalWatch;
  nowMs: number;
  lastEmitted: { toKey: string; state: SignalState } | null;
  latest: { toKey: string; status: GateSignalStatus; createdAtMs: number } | null;
  signed1h: number;
  maxPerHour: number;
  minDwellMs: number;
  retryMs: number;
}

export type GateSignalPlan =
  | { emit: false; reason: string }
  | {
      emit: true;
      initial: boolean;
      from: SignalState | null;
      to: SignalState;
      atMs: number;
      source: GateSignalSource;
    };

export function detectGateSignal(i: GateSignalInput): GateSignalPlan {
  const no = (reason: string): GateSignalPlan => ({ emit: false, reason });
  if (!i.enabled) return no("gate signals off (DESK_SIGNAL_GATES=0)");
  if (i.halted !== null) return no(`not signing: ${i.halted}`);
  if (i.inFlight > 0) return no(`${i.inFlight} transaction(s) in flight`);
  if (!i.settled) return no("gate machine still in its startup hold");
  const key = signalKey(i.state);
  if (i.lastEmitted?.toKey === key) return no("state already on-chain");
  const latest = i.latest;
  if (latest !== null) {
    if (latest.status === "pending") return no("a signal is pending");
    if (latest.status === "sent") return no("the previous signal is still in flight");
    // One per transition: suppressed while the lane has not really been elsewhere since this
    // state's signal was planned. Having held another state for the dwell since, this is a new
    // transition into it (a flap shorter than the dwell is not; nor is a state found at startup).
    const away = i.watch.away;
    const reentered = away !== null && away.key !== key && away.endMs > latest.createdAtMs;
    if (latest.toKey === key && !reentered) {
      if (latest.status === "declined")
        return no("the owner declined this state's signal; waiting for the next change");
      if (latest.status === "failed")
        return no("this state's signal was signed but did not land; one per transition");
      const wait = latest.createdAtMs + i.retryMs - i.nowMs;
      if (latest.status === "not_sent" && wait > 0)
        return no(`this state's signal was not sent; retry in ${Math.ceil(wait / 1000)} s`);
    }
  }
  // `initial` (from null) while nothing was ever emitted; but only the lane's very first planned
  // signal skips the dwell, so a denied or lost first signal does not let later states flap out.
  const initial = i.lastEmitted === null;
  const held = i.nowMs - i.watch.sinceMs;
  if (latest !== null && held < i.minDwellMs)
    return no(
      `state held ${Math.floor(held / 1000)} s < ${Math.round(i.minDwellMs / 1000)} s dwell`,
    );
  if (i.signed1h >= i.maxPerHour)
    return no(`signal rate limit: ${i.signed1h} signed in the last hour (max ${i.maxPerHour})`);
  return {
    emit: true,
    initial,
    from: i.lastEmitted?.state ?? null,
    to: i.state,
    atMs: i.watch.sinceMs,
    source: initial ? "initial" : "transition",
  };
}
