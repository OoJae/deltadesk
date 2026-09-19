import { describe, expect, it } from "vitest";
import {
  buildOverlayCriticPrompt,
  buildOverlayPlannerPrompt,
  renderAction,
} from "../../src/agents/prompts.js";
import { containsRawAddress } from "../../src/agents/schemas.js";
import {
  type DeskPlan,
  GATE_NAMES,
  type GateMachineState,
  type GateName,
  type GateState,
  type RegimeState,
} from "../../src/types.js";
import { LANE } from "../helpers/fakes.js";

const plan: DeskPlan = {
  lane: "A",
  laneAddress: LANE,
  createdAtMs: 0,
  riskMode: "normal",
  actions: [
    {
      kind: "rerange",
      lane: "A",
      ranges: [{ tickLower: 222_170, tickUpper: 222_380, share0Bps: 10_000, share1Bps: 10_000 }],
      expectedTick: 222_277,
      maxTickDelta: 10,
    },
  ],
  rationale: ["pool left the inner 60% for 2 ticks"],
  trigger: "outside_inner",
  hurdle: null,
  metrics: {
    F: 222.3,
    poolMid: 222.4,
    gapBps: -4.5,
    poolTick: 222_277,
    fTick: 222_281,
    refTick: 222_280,
    bandTicks: 100,
  },
  notionalCents: 5_000,
};

const gate = (name: GateName): GateState => ({
  name,
  implemented: true,
  active: false,
  activeSinceMs: null,
  clearTicks: 0,
  clearSinceMs: null,
  reason: "",
  effect: "none",
});
const regime: RegimeState = {
  calendar: {
    name: "REGULAR",
    reopenWindow: false,
    reopenKind: null,
    how: 34,
    sessionDate: "2026-09-21",
    et: { year: 2026, month: 9, day: 21, hour: 10, minute: 0, second: 0, isoWeekday: 1 },
  },
  regimeCode: 1,
  freshness: { chain: "FRESH", hl: "FRESH", rh: "FRESH", k: "FRESH", corpActions: "FRESH" },
  gates: {
    gates: Object.fromEntries(GATE_NAMES.map((g) => [g, gate(g)])) as GateMachineState["gates"],
    updatedAtMs: 0,
  },
  activeGates: [],
  gatesMask: 0,
  riskMode: "normal",
  transitions: [],
};

describe("overlay prompts", () => {
  it("carry the verified figures and the plan, but never an address", () => {
    const p = buildOverlayPlannerPrompt(plan, regime);
    expect(p.user).toContain("VERIFIED FIGURES");
    expect(p.user).toContain("222.3000");
    expect(p.user).toContain("[222170, 222380)");
    expect(containsRawAddress(p.system + p.user)).toBe(false);
    const c = buildOverlayCriticPrompt(plan, regime, {
      notionalScaleBps: 5_000,
      widenTicks: 0,
      dropActionIndexes: [],
      addReducing: [{ kind: "collect", lane: "A" }],
      rationale: "thin book",
    });
    expect(c.user).toContain("PROPOSED OVERLAY (untrusted)");
    expect(containsRawAddress(c.system + c.user)).toBe(false);
  });

  it("renders every action kind on one line", () => {
    expect(
      renderAction(
        { kind: "rerange", lane: "A", ranges: [], expectedTick: 0, maxTickDelta: 10 },
        0,
      ),
    ).toContain("unwind all and hold");
    expect(renderAction({ kind: "reduce", lane: "A", slot: 1, liquidity: 5n }, 1)).toBe(
      "1. reduce slot 1 by 5 liquidity",
    );
    expect(renderAction({ kind: "exitAll", lane: "A" }, 2)).toBe("2. exitAll");
  });
});
