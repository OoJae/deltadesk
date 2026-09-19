import { describe, expect, it } from "vitest";
import { createGateMachine, STARTUP_REASON } from "../../../src/regime/machine.js";
import type { GateMachineState, GateName, GateTrigger } from "../../../src/types.js";
import { GATE_NAMES } from "../../../src/types.js";

const T0 = 1_790_000_000_000;

function triggers(on: readonly GateName[]): GateTrigger[] {
  return GATE_NAMES.map((gate) => ({
    gate,
    triggered: on.includes(gate),
    reason: on.includes(gate) ? `${gate} on` : "clear",
  }));
}

describe("gate machine", () => {
  it("starts reduce-only gates active (fail-closed) but never HALT or the stubs", () => {
    const s = createGateMachine().initial(T0);
    expect(s.gates.CLOSED.active).toBe(true);
    expect(s.gates.CLOSED.reason).toBe(STARTUP_REASON);
    expect(s.gates["STALE-REF"].active).toBe(true);
    expect(s.gates.HALT.active).toBe(false);
    expect(s.gates["BOUND-PINNED"].active).toBe(false);
    expect(s.gates.EVENT.implemented).toBe(false);
    const off = createGateMachine({ startActive: false }).initial(T0);
    expect(GATE_NAMES.every((g) => !off.gates[g].active)).toBe(true);
  });

  it("turns a gate on the tick it triggers and emits one transition", () => {
    const m = createGateMachine({ startActive: false });
    const { next, transitions } = m.step(m.initial(T0), triggers(["REOPEN-GUARD"]), T0 + 5_000);
    expect(next.gates["REOPEN-GUARD"].active).toBe(true);
    expect(next.gates["REOPEN-GUARD"].activeSinceMs).toBe(T0 + 5_000);
    expect(transitions).toEqual([
      { gate: "REOPEN-GUARD", active: true, atMs: T0 + 5_000, reason: "REOPEN-GUARD on" },
    ]);
    // staying triggered emits nothing new
    expect(m.step(next, triggers(["REOPEN-GUARD"]), T0 + 10_000).transitions).toEqual([]);
  });

  it("turns off only after the dwell of 3 clear ticks; a trigger resets the streak", () => {
    const m = createGateMachine({ startActive: false });
    let s: GateMachineState = m.step(m.initial(T0), triggers(["STALE-REF"]), T0).next;
    s = m.step(s, triggers([]), T0 + 5_000).next;
    s = m.step(s, triggers([]), T0 + 10_000).next;
    expect(s.gates["STALE-REF"].active).toBe(true);
    expect(s.gates["STALE-REF"].clearTicks).toBe(2);
    s = m.step(s, triggers(["STALE-REF"]), T0 + 15_000).next; // relapse
    expect(s.gates["STALE-REF"].clearTicks).toBe(0);
    s = m.step(s, triggers([]), T0 + 20_000).next;
    s = m.step(s, triggers([]), T0 + 25_000).next;
    const last = m.step(s, triggers([]), T0 + 30_000);
    expect(last.next.gates["STALE-REF"].active).toBe(false);
    expect(last.transitions.map((t) => [t.gate, t.active])).toEqual([["STALE-REF", false]]);
  });

  it("HALT needs 2 minutes of clear, not just 3 ticks", () => {
    const m = createGateMachine({ startActive: false });
    let s = m.step(m.initial(T0), triggers(["HALT"]), T0).next;
    for (let i = 1; i <= 10; i++) s = m.step(s, triggers([]), T0 + i * 5_000).next;
    expect(s.gates.HALT.active).toBe(true); // 45 s of clear
    s = m.step(s, triggers([]), T0 + 5_000 + 120_000).next;
    expect(s.gates.HALT.active).toBe(false);
  });

  it("an implemented gate with no trigger this step fails closed (treated as triggered)", () => {
    const m = createGateMachine({ startActive: false });
    const only = triggers([]).filter((t) => t.gate !== "HALT");
    const { next } = m.step(m.initial(T0), only, T0);
    expect(next.gates.HALT.active).toBe(true);
    expect(next.gates.HALT.reason).toMatch(/fail-closed/);
  });

  it("stub gates never activate, even if something claims they triggered", () => {
    const m = createGateMachine({ startActive: false });
    const { next } = m.step(
      m.initial(T0),
      triggers(["EVENT", "BOUND-PINNED", "WRAPPER-PREMIUM"]),
      T0,
    );
    expect(next.gates.EVENT.active).toBe(false);
    expect(next.gates["BOUND-PINNED"].active).toBe(false);
  });

  it("a clock stepping backwards never completes a dwell", () => {
    const m = createGateMachine({
      startActive: false,
      dwell: { HALT: { clearTicks: 1, clearMs: 60_000 } },
    });
    let s = m.step(m.initial(T0), triggers(["HALT"]), T0).next;
    s = m.step(s, triggers([]), T0 + 1_000).next;
    s = m.step(s, triggers([]), T0 - 3_600_000).next;
    expect(s.gates.HALT.active).toBe(true);
  });
});
