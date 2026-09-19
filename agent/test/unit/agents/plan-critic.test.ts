import { describe, expect, it } from "vitest";
import { createPlanCritic, critiquePlan } from "../../../src/agents/plan-critic.js";
import { STRATEGY_DEFAULTS } from "../../../src/config.js";
import { poolMidFromSqrt } from "../../../src/market/fair-value.js";
import { IDENTITY_PROPOSAL, overlayApplier } from "../../../src/overlay/apply.js";
import { MOCK_POOL_TICK, MOCK_SQRT_PRICE_X96, mockSnapshot } from "../../../src/sense/mock.js";
import type { DeskAction, DeskPlan, PlanCriticInput } from "../../../src/types.js";
import {
  NOW_MS,
  normalRegime,
  planFor,
  validAddingStep,
  validReducingStep,
} from "../guard/fixture.js";

function input(over: Partial<PlanCriticInput> = {}): PlanCriticInput {
  const { snapshot, regime, plan } = validAddingStep();
  return { snapshot, regime, plan, params: STRATEGY_DEFAULTS, nowMs: NOW_MS, ...over };
}

const rerangeOf = (p: DeskPlan) => p.actions[0] as Extract<DeskAction, { kind: "rerange" }>;

describe("plan critic (deterministic)", () => {
  it("approves the strategy's own plan and an approved overlay's tighter version", () => {
    const i = input();
    expect(critiquePlan(i).verdict).toBe("APPROVE");
    const tighter = overlayApplier.apply(i.plan, {
      ...IDENTITY_PROPOSAL,
      notionalScaleBps: 5_000,
      widenTicks: 30,
    });
    expect(critiquePlan({ ...i, plan: tighter }).verdict).toBe("APPROVE");
  });

  it("approves a risk-reducing exitAll of a lane that holds a position", () => {
    const { snapshot, regime, plan } = validReducingStep();
    expect(
      critiquePlan({ snapshot, regime, plan, params: STRATEGY_DEFAULTS, nowMs: NOW_MS }).verdict,
    ).toBe("APPROVE");
  });

  it("rejects an adding plan in a gated regime, and anything but exits when flat", () => {
    const i = input();
    const gated = {
      ...i.regime,
      activeGates: ["STALE-REF" as const],
      riskMode: "reduce_only" as const,
    };
    expect(
      critiquePlan({ ...i, regime: gated, plan: { ...i.plan, riskMode: "reduce_only" } }).verdict,
    ).toBe("REJECT");
    // a plan claiming normal while the regime says otherwise
    expect(critiquePlan({ ...i, regime: gated }).reason).toMatch(/risk mode/);
  });

  it("rejects ranges that break the spacing, the shares or the recomputed placement", () => {
    const i = input();
    const rr = rerangeOf(i.plan);
    const r0 = rr.ranges[0];
    if (r0 === undefined) throw new Error("range");
    const mk = (r: typeof r0): DeskPlan => ({ ...i.plan, actions: [{ ...rr, ranges: [r] }] });
    expect(critiquePlan({ ...i, plan: mk({ ...r0, tickLower: r0.tickLower + 3 }) }).verdict).toBe(
      "REJECT",
    );
    expect(
      critiquePlan({ ...i, plan: mk({ ...r0, tickLower: r0.tickLower + 50 }) }).reason,
    ).toMatch(/recomputed placement/);
    expect(critiquePlan({ ...i, plan: mk({ ...r0, share0Bps: 12_000 }) }).verdict).toBe("REJECT");
  });

  it("rejects NVDA asks placed between the pool and F (single-sided must sit beyond F)", () => {
    // F ≈ 60 bp above the pool: the strategy places asks at ticks ≤ F's tick
    const snapshot = mockSnapshot({ hlMid: 222.4253 * Math.exp(60e-4) });
    const regime = normalRegime(snapshot);
    const plan = planFor(snapshot, regime);
    const rr = rerangeOf(plan);
    expect(rr.ranges[0]).toMatchObject({ share0Bps: 0, share1Bps: 10_000 });
    const base = { snapshot, regime, params: STRATEGY_DEFAULTS, nowMs: NOW_MS };
    expect(critiquePlan({ ...base, plan }).verdict).toBe("APPROVE");
    const cheap: DeskPlan = {
      ...plan,
      actions: [
        {
          ...rr,
          ranges: [{ tickLower: 222060, tickUpper: 222260, share0Bps: 0, share1Bps: 10_000 }],
        },
      ],
    };
    const r = critiquePlan({ ...base, plan: cheap });
    expect(r.verdict).toBe("REJECT");
    expect(r.findings.join(" ")).toMatch(/offers NVDA below fair value/);
  });

  it("rejects a plan whose metrics are not the snapshot's, and an expected tick that is not the pool's", () => {
    const i = input();
    expect(
      critiquePlan({ ...i, plan: { ...i.plan, metrics: { ...i.plan.metrics, F: 1 } } }).reason,
    ).toMatch(/F does not match/);
    const rr = rerangeOf(i.plan);
    expect(
      critiquePlan({
        ...i,
        plan: { ...i.plan, actions: [{ ...rr, expectedTick: rr.expectedTick + 1 }] },
      }).verdict,
    ).toBe("REJECT");
  });

  it("rejects notional above the lane's caps and exhausted rate limits", () => {
    const i = input();
    const chain = structuredClone(i.snapshot.chain);
    if (chain === null) throw new Error("chain");
    chain.lane.caps.maxDeployUsd6 = 10_000_000n;
    expect(critiquePlan({ ...i, snapshot: { ...i.snapshot, chain } }).reason).toMatch(/maxDeploy/);
    const later = structuredClone(i.snapshot.chain);
    if (later === null) throw new Error("chain");
    later.lane.budgets.nextRerangeAt = BigInt(Math.floor(NOW_MS / 1000) + 10);
    expect(critiquePlan({ ...i, snapshot: { ...i.snapshot, chain: later } }).reason).toMatch(
      /interval/,
    );
  });

  it("rejects hold-only plans, reduces of empty slots, and exits of an empty lane", () => {
    const i = input();
    expect(
      critiquePlan({
        ...i,
        plan: { ...i.plan, actions: [{ kind: "hold", lane: "A", reason: "x" }] },
      }).verdict,
    ).toBe("REJECT");
    expect(
      critiquePlan({
        ...i,
        plan: {
          ...i.plan,
          actions: [{ kind: "reduce", lane: "A", slot: 0, liquidity: 1n }],
          notionalCents: 0,
        },
      }).reason,
    ).toMatch(/slot 0/);
    expect(
      critiquePlan({
        ...i,
        plan: { ...i.plan, actions: [{ kind: "exitAll", lane: "A" }], notionalCents: 0 },
      }).reason,
    ).toMatch(/no position/);
  });

  it("a throw inside is a REJECT", () => {
    const i = input();
    const r = createPlanCritic().critique({
      ...i,
      snapshot: { ...i.snapshot, chain: undefined as never },
    });
    expect(r.verdict).toBe("REJECT");
  });
});

describe("plan critic, stage execution: the approved plan on the snapshot it signs on", () => {
  const MID = poolMidFromSqrt(MOCK_SQRT_PRICE_X96);
  const LATER = NOW_MS + 60_000;
  /** A snapshot with F `bps` away from the pool mid (the pool at `tick`). */
  const at = (bps: number, nowMs = LATER, tick = MOCK_POOL_TICK) => {
    const snapshot = mockSnapshot({ nowMs, tick, hlMid: MID * Math.exp(bps / 1e4) });
    return { snapshot, regime: normalRegime(snapshot, nowMs) };
  };
  const planned = at(0, NOW_MS);
  const plan = planFor(planned.snapshot, planned.regime);
  const run = (s: ReturnType<typeof at>, stage?: "execution") =>
    critiquePlan({
      ...s,
      plan,
      params: STRATEGY_DEFAULTS,
      nowMs: LATER,
      ...(stage ? { stage } : {}),
    });

  it("the plan is a straddle around F, approved on its own snapshot", () => {
    expect(rerangeOf(plan).ranges[0]).toMatchObject({ share0Bps: 10_000, share1Bps: 10_000 });
    expect(
      critiquePlan({ ...planned, plan, params: STRATEGY_DEFAULTS, nowMs: NOW_MS }).verdict,
    ).toBe("APPROVE");
  });

  it("F drift within maxTickDelta (8 bp): approved at execution (plan-stage metrics would not match)", () => {
    expect(run(at(8)).verdict).toBe("REJECT");
    expect(run(at(8), "execution")).toMatchObject({ verdict: "APPROVE" });
  });

  it("F moved 80 bp: the straddle centred on the old F is rejected at execution", () => {
    const r = run(at(80), "execution");
    expect(r.verdict).toBe("REJECT");
    expect(r.reason).toMatch(/does not contain the recomputed placement/);
  });

  it("the pool drifting beyond expectedTick ± maxTickDelta is rejected; within it, approved", () => {
    const beyond = run(at(0, LATER, MOCK_POOL_TICK + 11), "execution");
    expect(beyond.verdict).toBe("REJECT");
    expect(beyond.findings.some((f) => /drifted beyond expectedTick/.test(f))).toBe(true);
    expect(run(at(0, LATER, MOCK_POOL_TICK + 5), "execution").verdict).toBe("APPROVE");
  });
});
