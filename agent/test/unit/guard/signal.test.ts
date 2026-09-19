/**
 * The guard on gate signals: neutral (no funds, no regime / rate / hurdle gating of reranges), but
 * never exempt from the arm flag, dry-run, the allowlist, idempotency, simulation, the signer
 * binding, single-in-flight or the deadline caps; and held to MORE than a reducing step: the gas
 * reserve, an unpaused lane and the hourly signal cap (signal-policy).
 */

import { describe, expect, it } from "vitest";
import { planCritic } from "../../../src/agents/plan-critic.js";
import { STRATEGY_DEFAULTS } from "../../../src/config.js";
import { checkGuard } from "../../../src/guard/guard.js";
import { mockSnapshot } from "../../../src/sense/mock.js";
import type {
  DeskAction,
  DeskPlan,
  GuardInput,
  GuardRuleId,
  RegimeState,
} from "../../../src/types.js";
import { GUARD_RULES } from "../../../src/types.js";
import { buildStep, encodeCall, NOW_MS, NOW_SEC, normalRegime } from "./fixture.js";

const failed = (input: GuardInput): GuardRuleId[] =>
  checkGuard(input).violations.map((v) => v.rule);

const SIGNAL: DeskAction = { kind: "signal", lane: "A", note: "gates none → CLOSED · REGULAR" };

function signalStep(regime?: (r: RegimeState) => RegimeState): GuardInput {
  const snapshot = mockSnapshot({ nowMs: NOW_MS });
  const base = normalRegime(snapshot);
  const r = regime === undefined ? base : regime(base);
  const plan: DeskPlan = {
    lane: "A",
    laneAddress: snapshot.laneAddress,
    createdAtMs: NOW_MS,
    riskMode: r.riskMode,
    actions: [SIGNAL],
    rationale: ["gate signal"],
    trigger: null,
    hurdle: null,
    metrics: {
      F: null,
      poolMid: null,
      gapBps: null,
      poolTick: null,
      fTick: null,
      refTick: null,
      bandTicks: null,
    },
    notionalCents: 0,
  };
  const { input } = buildStep(snapshot, r, plan, SIGNAL);
  return { ...input, signalRate: { count1h: 0, maxPerHour: 6 } };
}

function withLane(
  input: GuardInput,
  mutate: (l: NonNullable<GuardInput["snapshot"]["chain"]>["lane"]) => void,
) {
  const chain = structuredClone(input.snapshot.chain);
  if (chain === null) throw new Error("no chain");
  mutate(chain.lane);
  return { ...input, snapshot: { ...input.snapshot, chain } };
}

describe("guard: gate signals", () => {
  it("a valid armed signal executes: all 26 rules, signal-policy included", () => {
    const input = signalStep();
    const r = checkGuard(input);
    expect(r.violations).toEqual([]);
    expect(r.decision).toBe("execute");
    expect(r.checks.map((c) => c.rule)).toEqual([...GUARD_RULES]);
    expect(r.checks.find((c) => c.rule === "signal-policy")?.detail).toMatch(/0\/6/);
  });

  it("is neutral: it goes out in reduce-only and flat (HALT) modes, no funds, no hurdle", () => {
    const flat = signalStep((r) => ({
      ...r,
      activeGates: ["HALT"],
      gatesMask: 2,
      riskMode: "flat",
    }));
    const plan = flat.plans.final;
    const critic = planCritic.critique({
      snapshot: flat.snapshot,
      regime: flat.regime,
      plan,
      params: STRATEGY_DEFAULTS,
      nowMs: NOW_MS,
    });
    expect(critic.verdict).toBe("APPROVE"); // the critic lets a signal announce a flat state
    expect(checkGuard({ ...flat, planCritic: critic }).decision).toBe("execute");
    const closed = signalStep((r) => ({
      ...r,
      activeGates: ["CLOSED"],
      gatesMask: 1,
      riskMode: "reduce_only",
    }));
    expect(checkGuard(closed).decision).toBe("execute");
    expect(checkGuard(closed).checks.find((c) => c.rule === "regime-gate")?.detail).toMatch(
      /bypassed/,
    );
  });

  it("never bypasses DESK_ARM, DRY_RUN, single-in-flight, idempotency or the deadline cap", () => {
    const input = signalStep();
    expect(failed({ ...input, flags: { ...input.flags, armed: false } })).toEqual(["arm-flag"]);
    expect(checkGuard({ ...input, flags: { ...input.flags, dryRun: true } }).decision).toBe(
      "dry-run",
    );
    expect(failed({ ...input, inFlight: 1 })).toEqual(["single-in-flight"]);
    expect(
      failed({ ...input, idempotency: { dbHasStep: false, onchainDecisionUsedAt: 123n } }),
    ).toEqual(["idempotency"]);
    // The lane's maxDeadlineAhead (120 s in the mock) caps the deadline too.
    const late = {
      ...input,
      meta: { ...(input.meta ?? ({} as never)), deadline: BigInt(NOW_SEC + 61) },
    };
    expect(failed(late)).toContain("deadline-sane");
    const capped = withLane(input, (l) => {
      l.caps = { ...l.caps, maxDeadlineAhead: 30 };
    });
    expect(failed(capped)).toContain("deadline-sane");
  });

  it("moves no funds: a value or a foreign selector is refused by the allowlist", () => {
    const input = signalStep();
    if (input.tx === null || input.meta === null) throw new Error("no call");
    expect(failed({ ...input, tx: { ...input.tx, value: 1n } })).toContain("allowlist");
    const exit = encodeCall({ kind: "exitAll", lane: "A" }, input.meta, input.tx.to);
    expect(failed({ ...input, tx: exit })).toContain("allowlist");
  });

  it("signal-policy: a paused lane, the hourly cap or an unknown count block it", () => {
    const input = signalStep();
    const paused = withLane(input, (l) => {
      l.paused = true;
    });
    expect(failed(paused)).toEqual(["signal-policy"]);
    expect(failed({ ...input, signalRate: { count1h: 6, maxPerHour: 6 } })).toEqual([
      "signal-policy",
    ]);
    expect(failed({ ...input, signalRate: null })).toEqual(["signal-policy"]);
    expect(failed({ ...input, signalRate: undefined })).toEqual(["signal-policy"]);
    // Other steps are not signals: the rule passes for them whatever the count.
    const other = { ...input, action: { kind: "exitAll", lane: "A" } as DeskAction };
    expect(checkGuard(other).checks.find((c) => c.rule === "signal-policy")).toMatchObject({
      passed: true,
      detail: "not a signal",
    });
  });

  it("keeps the operator's gas reserve (an exit may need it), unlike a risk-reducing step", () => {
    const input = signalStep();
    const poor = withLane(input, () => {});
    const chain = poor.snapshot.chain;
    if (chain === null) throw new Error("no chain");
    // 0.0011 ETH: enough for the step's gas, not for gas + the 0.001 ETH reserve.
    chain.operatorEthWei = 1_100_000_000_000_000n;
    expect(failed(poor)).toEqual(["gas-reserve"]);
    expect(failed({ ...poor, estimatedGasCostWei: null })).toEqual(["gas-reserve"]);
  });
});
