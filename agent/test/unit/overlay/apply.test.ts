import { describe, expect, it } from "vitest";
import {
  IDENTITY_PROPOSAL,
  overlayApplier,
  resolveOverlay,
  tightenCheck,
} from "../../../src/overlay/apply.js";
import type {
  DeskAction,
  DeskPlan,
  OverlayContext,
  OverlayCritic,
  OverlayPlanner,
  OverlayProposal,
} from "../../../src/types.js";
import { LlmCreditsExhausted } from "../../../src/types.js";
import { validAddingStep } from "../guard/fixture.js";

function ctx(): OverlayContext & { plan: DeskPlan } {
  const { snapshot, regime, plan } = validAddingStep();
  return { snapshot, regime, plan };
}

const rerangeOf = (p: DeskPlan) =>
  p.actions.find((a) => a.kind === "rerange") as Extract<DeskAction, { kind: "rerange" }>;

const planner = (proposal: OverlayProposal | Error): OverlayPlanner => ({
  async propose() {
    if (proposal instanceof Error) throw proposal;
    return { proposal, raw: JSON.stringify({ ...proposal, addReducing: [] }) };
  },
});
const critic = (verdict: "APPROVE" | "REJECT" | Error): OverlayCritic => ({
  async critique() {
    if (verdict instanceof Error) throw verdict;
    return { verdict: { verdict, reason: `critic ${verdict}` }, raw: null };
  },
});

describe("overlay apply", () => {
  it("the identity proposal leaves the actions unchanged and passes the tighten-check", () => {
    const { plan } = ctx();
    const out = overlayApplier.apply(plan, IDENTITY_PROPOSAL);
    expect(out.actions).toEqual(plan.actions);
    expect(tightenCheck(plan, out)).toEqual({ ok: true, violations: [] });
  });

  it("scales shares and notional down, widens straddles outward on the spacing", () => {
    const { plan } = ctx();
    const out = overlayApplier.apply(plan, {
      ...IDENTITY_PROPOSAL,
      notionalScaleBps: 5_000,
      widenTicks: 15,
    });
    const before = rerangeOf(plan).ranges[0];
    const after = rerangeOf(out).ranges[0];
    expect(after).toEqual({
      tickLower: (before?.tickLower ?? 0) - 20,
      tickUpper: (before?.tickUpper ?? 0) + 20,
      share0Bps: 5_000,
      share1Bps: 5_000,
    });
    expect(out.notionalCents).toBe(Math.floor(plan.notionalCents / 2));
    expect(tightenCheck(plan, out).ok).toBe(true);
  });

  it("keeps a single-sided range single-sided when widening", () => {
    const { plan } = ctx();
    const asks: DeskPlan = {
      ...plan,
      actions: [
        {
          kind: "rerange",
          lane: "A",
          ranges: [{ tickLower: 222010, tickUpper: 222210, share0Bps: 0, share1Bps: 10_000 }],
          expectedTick: 222275,
          maxTickDelta: 10,
        },
      ],
    };
    const out = overlayApplier.apply(asks, { ...IDENTITY_PROPOSAL, widenTicks: 50 });
    expect(rerangeOf(out).ranges[0]).toMatchObject({ tickLower: 221960, tickUpper: 222210 });
  });

  it("dropping the adding action leaves a hold; adding exitAll or pause drops every adding action", () => {
    const { plan } = ctx();
    const dropped = overlayApplier.apply(plan, { ...IDENTITY_PROPOSAL, dropActionIndexes: [0] });
    expect(dropped.actions).toEqual([
      { kind: "hold", lane: "A", reason: "overlay dropped every action" },
    ]);
    expect(dropped.notionalCents).toBe(0);
    expect(tightenCheck(plan, dropped).ok).toBe(true);
    const exiting = overlayApplier.apply(plan, {
      ...IDENTITY_PROPOSAL,
      addReducing: [{ kind: "exitAll", lane: "A" }],
    });
    expect(exiting.actions).toEqual([{ kind: "exitAll", lane: "A" }]);
    expect(tightenCheck(plan, exiting).ok).toBe(true);
  });
});

describe("tightenCheck", () => {
  it("rejects every loosening edit", () => {
    const { plan } = ctx();
    const rr = rerangeOf(plan);
    const r0 = rr.ranges[0];
    if (r0 === undefined) throw new Error("range");
    const variants: Array<[string, DeskPlan]> = [
      ["more notional", { ...plan, notionalCents: plan.notionalCents + 1 }],
      [
        "narrower",
        { ...plan, actions: [{ ...rr, ranges: [{ ...r0, tickLower: r0.tickLower + 10 }] }] },
      ],
      [
        "bigger share",
        { ...plan, actions: [{ ...rr, ranges: [{ ...r0, share0Bps: r0.share0Bps + 1 }] }] },
      ],
      [
        "extra range",
        { ...plan, actions: [{ ...rr, ranges: [r0, { ...r0, tickLower: r0.tickLower - 100 }] }] },
      ],
      ["moved expected tick", { ...plan, actions: [{ ...rr, expectedTick: rr.expectedTick + 1 }] }],
      ["looser delta", { ...plan, actions: [{ ...rr, maxTickDelta: rr.maxTickDelta + 1 }] }],
      [
        "added signal",
        { ...plan, actions: [...plan.actions, { kind: "signal", lane: "A", note: "x" }] },
      ],
      ["another lane", { ...plan, actions: [...plan.actions, { kind: "collect", lane: "B" }] }],
      ["risk mode", { ...plan, riskMode: "reduce_only" }],
      ["lane address", { ...plan, laneAddress: "0x9999999999999999999999999999999999999999" }],
    ];
    for (const [name, final] of variants) {
      expect(tightenCheck(plan, final).ok, name).toBe(false);
    }
  });

  it("a reducing action of the deterministic plan cannot be removed", () => {
    const { plan } = ctx();
    const det: DeskPlan = {
      ...plan,
      actions: [{ kind: "collect", lane: "A" }, ...plan.actions],
      notionalCents: plan.notionalCents,
    };
    const out = overlayApplier.apply(det, { ...IDENTITY_PROPOSAL, dropActionIndexes: [0] });
    expect(tightenCheck(det, out).ok).toBe(false);
  });
});

describe("resolveOverlay (the stage)", () => {
  const good: OverlayProposal = {
    ...IDENTITY_PROPOSAL,
    notionalScaleBps: 8_000,
    rationale: "be smaller",
  };

  it("disabled (M2 default): identity, no LLM call", async () => {
    const c = ctx();
    let called = false;
    const p: OverlayPlanner = {
      async propose() {
        called = true;
        throw new Error("never");
      },
    };
    const out = await resolveOverlay(
      { enabled: false, planner: p, critic: critic("APPROVE"), newId: () => "id" },
      c,
    );
    expect(called).toBe(false);
    expect(out.record).toMatchObject({ overlayId: "id", source: "identity", applied: false });
    expect(out.finalPlan).toBe(c.plan);
  });

  it("approved and tighter: applied, and its strings are reported for the guard's address scan", async () => {
    const c = ctx();
    const out = await resolveOverlay(
      { enabled: true, planner: planner(good), critic: critic("APPROVE") },
      c,
    );
    expect(out.record).toMatchObject({ source: "llm", applied: true, tighten: { ok: true } });
    expect(out.finalPlan.notionalCents).toBe(Math.floor(c.plan.notionalCents * 0.8));
    expect(out.llmStrings).toEqual(["be smaller", "critic APPROVE"]);
  });

  it("a loosening overlay is dropped even when the critic approves it", async () => {
    const c = ctx();
    const loose: OverlayProposal = { ...good, addReducing: [{ kind: "collect", lane: "B" }] };
    const out = await resolveOverlay(
      { enabled: true, planner: planner(loose), critic: critic("APPROVE") },
      c,
    );
    expect(out.record.applied).toBe(false);
    expect(out.record.tighten.ok).toBe(false);
    expect(out.finalPlan).toBe(c.plan);
  });

  it("critic REJECT or a throwing critic: not applied", async () => {
    const c = ctx();
    for (const v of ["REJECT" as const, new Error("down")]) {
      const out = await resolveOverlay(
        { enabled: true, planner: planner(good), critic: critic(v) },
        c,
      );
      expect(out.record.applied).toBe(false);
      expect(out.finalPlan).toBe(c.plan);
    }
  });

  it("an LLM 402 anywhere drops to the deterministic plan and flags credits exhausted", async () => {
    const c = ctx();
    const p402 = await resolveOverlay(
      { enabled: true, planner: planner(new LlmCreditsExhausted()), critic: critic("APPROVE") },
      c,
    );
    expect(p402.creditsExhausted).toBe(true);
    expect(p402.record.source).toBe("identity");
    expect(p402.record.error).toMatch(/credits exhausted/);
    const c402 = await resolveOverlay(
      { enabled: true, planner: planner(good), critic: critic(new LlmCreditsExhausted()) },
      c,
    );
    expect(c402.creditsExhausted).toBe(true);
    expect(c402.finalPlan).toBe(c.plan);
  });

  it("a plan without adding actions never calls the LLM", async () => {
    const c = ctx();
    const exit: DeskPlan = {
      ...c.plan,
      actions: [{ kind: "exitAll", lane: "A" }],
      notionalCents: 0,
    };
    const out = await resolveOverlay(
      { enabled: true, planner: planner(new Error("never")), critic: critic("APPROVE") },
      { ...c, plan: exit },
    );
    expect(out.record.source).toBe("identity");
    expect(out.record.error).toBeNull();
  });
});
