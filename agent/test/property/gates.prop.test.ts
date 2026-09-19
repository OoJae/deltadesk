import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createGateMachine, DEFAULT_GATE_DWELL } from "../../src/regime/machine.js";
import type { GateName, GateTrigger } from "../../src/types.js";
import { GATE_IMPLEMENTED, GATE_NAMES } from "../../src/types.js";

const IMPLEMENTED = GATE_NAMES.filter((g) => GATE_IMPLEMENTED[g]);

/** A reference model of one gate: on at once, off after clearTicks untriggered ticks spanning ≥ clearMs. */
function reference(
  steps: Array<{ triggered: boolean; atMs: number }>,
  dwell: { clearTicks: number; clearMs: number },
): boolean[] {
  let active = false;
  let streak = 0;
  let since: number | null = null;
  return steps.map(({ triggered, atMs }) => {
    if (triggered) {
      active = true;
      streak = 0;
      since = null;
    } else if (active) {
      streak++;
      since ??= atMs;
      if (streak >= dwell.clearTicks && atMs - since >= dwell.clearMs) {
        active = false;
        streak = 0;
        since = null;
      }
    }
    return active;
  });
}

describe("gate machine properties", () => {
  it("respects immediate-on and dwell-off for every gate against a reference model", () => {
    const stepArb = fc.record({
      on: fc.subarray(IMPLEMENTED as GateName[]),
      dtMs: fc.integer({ min: 0, max: 60_000 }),
    });
    fc.assert(
      fc.property(fc.array(stepArb, { minLength: 1, maxLength: 60 }), (steps) => {
        const m = createGateMachine({ startActive: false });
        let t = 1_790_000_000_000;
        let state = m.initial(t);
        const timeline: Array<{ on: GateName[]; atMs: number }> = [];
        const observed: Record<string, boolean[]> = Object.fromEntries(
          GATE_NAMES.map((g) => [g, [] as boolean[]]),
        );
        for (const s of steps) {
          t += s.dtMs;
          const triggers: GateTrigger[] = GATE_NAMES.map((gate) => ({
            gate,
            triggered: s.on.includes(gate),
            reason: "prop",
          }));
          const { next, transitions } = m.step(state, triggers, t);
          for (const tr of transitions) expect(tr.active).toBe(next.gates[tr.gate].active);
          for (const g of GATE_NAMES) {
            observed[g]?.push(next.gates[g].active);
            if (s.on.includes(g) && GATE_IMPLEMENTED[g]) expect(next.gates[g].active).toBe(true); // immediate on
            if (!GATE_IMPLEMENTED[g]) expect(next.gates[g].active).toBe(false);
          }
          state = next;
          timeline.push({ on: s.on, atMs: t });
        }
        for (const g of IMPLEMENTED) {
          const expected = reference(
            timeline.map((x) => ({ triggered: x.on.includes(g), atMs: x.atMs })),
            DEFAULT_GATE_DWELL[g],
          );
          expect(observed[g]).toEqual(expected);
        }
      }),
      { numRuns: 1_000 },
    );
  });

  it("a gate that turned off always had a full clear dwell behind it", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.boolean(), fc.integer({ min: 1_000, max: 90_000 })), {
          minLength: 2,
          maxLength: 80,
        }),
        (seq) => {
          const m = createGateMachine({ startActive: false });
          let t = 0;
          let state = m.initial(t);
          const history: Array<{ triggered: boolean; atMs: number }> = [];
          for (const [halted, dt] of seq) {
            t += dt;
            const { next, transitions } = m.step(
              state,
              GATE_NAMES.map((gate) => ({
                gate,
                triggered: gate === "HALT" && halted,
                reason: "p",
              })),
              t,
            );
            history.push({ triggered: halted, atMs: t });
            const off = transitions.find((x) => x.gate === "HALT" && !x.active);
            if (off !== undefined) {
              const tail = history.slice(-DEFAULT_GATE_DWELL.HALT.clearTicks);
              expect(tail.every((h) => !h.triggered)).toBe(true);
              // the clear streak began after the last trigger; it must span the 2 min dwell
              const lastOn = [...history].reverse().findIndex((h) => h.triggered);
              const firstClear = history[history.length - lastOn];
              expect(firstClear).toBeDefined();
              expect(t - (firstClear?.atMs ?? t)).toBeGreaterThanOrEqual(120_000);
            }
            state = next;
          }
        },
      ),
      { numRuns: 1_000 },
    );
  });
});
