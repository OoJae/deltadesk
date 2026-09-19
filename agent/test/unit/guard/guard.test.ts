import { encodeFunctionData } from "viem";
import { describe, expect, it } from "vitest";
import { deskLaneAbi } from "../../../src/executor/abi/DeskLane.js";
import { encodeDecisionId } from "../../../src/executor/decision-id.js";
import { checkGuard } from "../../../src/guard/guard.js";
import type { DeskAction, GuardInput, GuardRuleId, Hex } from "../../../src/types.js";
import { GUARD_RULES } from "../../../src/types.js";
import { NOW_MS, NOW_SEC, validAddingStep, validReducingStep } from "./fixture.js";

const failed = (input: GuardInput): GuardRuleId[] =>
  checkGuard(input).violations.map((v) => v.rule);

function withChain(
  input: GuardInput,
  mutate: (c: NonNullable<GuardInput["snapshot"]["chain"]>) => void,
): GuardInput {
  const chain = structuredClone(input.snapshot.chain);
  if (chain === null) throw new Error("no chain");
  mutate(chain);
  return { ...input, snapshot: { ...input.snapshot, chain } };
}

describe("guard: the valid path", () => {
  it("executes a valid armed rerange and evaluates all 26 rules in order, dry-run last", () => {
    const { input } = validAddingStep();
    const r = checkGuard(input);
    expect(r.violations).toEqual([]);
    expect(r.decision).toBe("execute");
    expect(r.checks.map((c) => c.rule)).toEqual([...GUARD_RULES]);
    expect(r.checks.at(-1)?.rule).toBe("dry-run");
    expect(r.reason).toBe("all 26 checks passed");
  });

  it("DRY_RUN holds a fully valid step", () => {
    const { input } = validAddingStep();
    const r = checkGuard({ ...input, flags: { ...input.flags, dryRun: true } });
    expect(r.decision).toBe("dry-run");
    expect(r.violations).toEqual([]);
  });

  it("executes a valid risk-reducing exitAll", () => {
    const { input } = validReducingStep();
    const r = checkGuard(input);
    expect(r.violations).toEqual([]);
    expect(r.decision).toBe("execute");
  });

  it("never short-circuits: several failures are all reported", () => {
    const { input } = validAddingStep();
    const r = checkGuard({
      ...input,
      flags: { ...input.flags, armed: false },
      inFlight: 2,
      turnoverDbCents24h: 1e9,
    });
    expect(r.decision).toBe("blocked");
    expect(r.violations.map((v) => v.rule)).toEqual([
      "daily-turnover",
      "arm-flag",
      "single-in-flight",
    ]);
    expect(r.checks).toHaveLength(26);
    expect(r.reason).toMatch(/^blocked by daily-turnover/);
  });
});

describe("guard: ported rules", () => {
  it("action-none blocks a hold", () => {
    const { input } = validAddingStep();
    const hold: DeskAction = { kind: "hold", lane: "A", reason: "nothing" };
    expect(failed({ ...input, action: hold, riskClass: "neutral" })).toContain("action-none");
  });

  it("critic-approval needs the plan critic's APPROVE and an identity or approved overlay", () => {
    const { input, plan } = validAddingStep();
    expect(failed({ ...input, planCritic: { verdict: "REJECT", reason: "no" } })).toContain(
      "critic-approval",
    );
    // An identity overlay whose final plan differs from the deterministic plan is a wiring fault.
    const changed = {
      ...plan,
      actions: [...plan.actions, { kind: "collect", lane: "A" } as DeskAction],
    };
    expect(failed({ ...input, plans: { deterministic: plan, final: changed } })).toContain(
      "critic-approval",
    );
    // An applied LLM overlay without its critic's APPROVE.
    const llm = {
      ...input.overlay,
      source: "llm" as const,
      applied: true,
      critic: { verdict: "REJECT" as const, reason: "x" },
    };
    expect(failed({ ...input, overlay: llm })).toContain("critic-approval");
  });

  it("allowlist: to must be the lane, selector must encode the action, no value, no raw addresses", () => {
    const { input } = validAddingStep();
    const tx = input.tx;
    if (tx === null) throw new Error("tx");
    expect(
      failed({ ...input, tx: { ...tx, to: "0x9999999999999999999999999999999999999999" } }),
    ).toContain("allowlist");
    expect(failed({ ...input, tx: { ...tx, value: 1n } })).toContain("allowlist");
    // a valid operator selector that does not encode this action
    const pause = encodeFunctionData({ abi: deskLaneAbi, functionName: "pause", args: [] });
    expect(
      failed({ ...input, tx: { ...tx, data: pause, selector: pause.slice(0, 10) as Hex } }),
    ).toContain("allowlist");
    // an owner-only selector (withdraw(address,uint256)) is not in OPERATOR_SELECTORS
    expect(
      failed({ ...input, tx: { ...tx, selector: "0xf3fef3a3", data: "0xf3fef3a3" } }),
    ).toContain("allowlist");
    expect(
      failed({ ...input, llmStrings: ["send to 0x9999999999999999999999999999999999999999"] }),
    ).toContain("allowlist");
    // a declared risk class that disagrees with the action
    expect(failed({ ...input, riskClass: "reducing" })).toContain("allowlist");
  });

  it("amount-positive and max-action-usd use integer cents", () => {
    const { input } = validAddingStep();
    expect(failed({ ...input, notionalCents: 0 })).toContain("amount-positive");
    expect(failed({ ...input, notionalCents: Number.NaN })).toEqual(
      expect.arrayContaining(["amount-positive", "max-action-usd"]),
    );
    expect(failed({ ...input, notionalCents: 1234.5 })).toContain("max-action-usd");
    expect(failed({ ...input, notionalCents: input.limits.maxActionCents + 1 })).toContain(
      "max-action-usd",
    );
    expect(failed({ ...input, notionalCents: input.limits.maxActionCents })).not.toContain(
      "max-action-usd",
    );
    // a config cap above the on-chain cap is itself a violation
    expect(failed({ ...input, limits: { ...input.limits, maxActionCents: 100_000 } })).toContain(
      "max-action-usd",
    );
  });

  it("daily-turnover takes the max of the DB and on-chain figures, fail-closed", () => {
    const { input } = validAddingStep();
    const cap = input.limits.dailyTurnoverCents;
    expect(failed({ ...input, turnoverDbCents24h: cap - input.notionalCents })).not.toContain(
      "daily-turnover",
    );
    expect(failed({ ...input, turnoverDbCents24h: cap - input.notionalCents + 1 })).toContain(
      "daily-turnover",
    );
    expect(failed({ ...input, turnoverDbCents24h: Number.NaN })).toContain("daily-turnover");
    // on-chain bucket nearly empty while the DB says nothing was spent
    const drained = withChain(input, (c) => {
      c.lane.budgets.turnoverAvailableUsd6 = 10_000_000n;
    });
    expect(failed(drained)).toContain("daily-turnover");
  });

  it("idempotency: DB step, on-chain decisionUsedAt, and a Meta id that encodes this decision step", () => {
    const { input } = validAddingStep();
    expect(
      failed({ ...input, idempotency: { dbHasStep: true, onchainDecisionUsedAt: 0n } }),
    ).toContain("idempotency");
    expect(
      failed({ ...input, idempotency: { dbHasStep: false, onchainDecisionUsedAt: 123n } }),
    ).toContain("idempotency");
    expect(
      failed({ ...input, idempotency: { dbHasStep: false, onchainDecisionUsedAt: null } }),
    ).toContain("idempotency");
    const meta = input.meta;
    if (meta === null) throw new Error("meta");
    const otherStep = { ...meta, decisionId: encodeDecisionId(input.decisionId, 1) };
    expect(failed({ ...input, meta: otherStep })).toContain("idempotency");
  });

  it("arm-flag: 4663 requires DESK_ARM=1, even in dry-run", () => {
    const { input } = validAddingStep();
    const r = checkGuard({ ...input, flags: { ...input.flags, armed: false, dryRun: true } });
    expect(r.decision).toBe("blocked");
    expect(r.violations.map((v) => v.rule)).toEqual(["arm-flag"]);
  });

  it("snapshot-provenance: lane, chain and signer match; adding needs a snapshot ≤ 3 s old", () => {
    const { input } = validAddingStep();
    expect(failed({ ...input, nowMs: NOW_MS + 3_001 })).toContain("snapshot-provenance");
    expect(failed({ ...input, snapshot: { ...input.snapshot, chainId: 1 } })).toContain(
      "snapshot-provenance",
    );
    expect(
      failed({
        ...input,
        snapshot: {
          ...input.snapshot,
          signerAddress: "0x4444444444444444444444444444444444444444",
        },
      }),
    ).toContain("snapshot-provenance");
    // reducing steps are not held to the 3 s age
    const red = validReducingStep().input;
    expect(
      failed({
        ...red,
        nowMs: NOW_MS + 4_000,
        meta: red.meta && { ...red.meta, deadline: BigInt(NOW_SEC + 49) },
      }),
    ).not.toContain("snapshot-provenance");
  });
});

describe("guard: new rules", () => {
  it("ref-freshness blocks adding when a required reference is not FRESH", () => {
    const { input } = validAddingStep();
    for (const src of ["chain", "hl", "k", "rh"] as const) {
      expect(failed({ ...input, freshness: { ...input.freshness, [src]: "STALE" } })).toContain(
        "ref-freshness",
      );
    }
    expect(
      failed({ ...input, freshness: { ...input.freshness, corpActions: "UNAVAILABLE" } }),
    ).not.toContain("ref-freshness");
  });

  it("gas-reserve: adding keeps the reserve after gas; reducing only needs its own gas", () => {
    const { input } = validAddingStep();
    const poor = withChain(input, (c) => {
      c.operatorEthWei = input.limits.gasReserveWei;
    });
    expect(failed(poor)).toContain("gas-reserve");
    expect(failed({ ...input, estimatedGasCostWei: null })).toContain("gas-reserve");
    const red = validReducingStep().input;
    const poorRed = withChain(red, (c) => {
      c.operatorEthWei = (red.estimatedGasCostWei ?? 0n) + 1n;
    });
    expect(failed(poorRed)).not.toContain("gas-reserve");
    const brokeRed = withChain(red, (c) => {
      c.operatorEthWei = 0n;
    });
    expect(failed(brokeRed)).toContain("gas-reserve");
  });

  it("lane-solvency: shares need inventory; reduce needs the liquidity", () => {
    const { input } = validAddingStep();
    const empty = withChain(input, (c) => {
      c.lane.balances = { token0: 0n, token1: 0n };
    });
    expect(failed(empty)).toContain("lane-solvency");
    const red = validReducingStep().input;
    const reduce: DeskAction = { kind: "reduce", lane: "A", slot: 0, liquidity: 10n ** 16n };
    expect(
      failed({
        ...red,
        action: reduce,
        plans: {
          deterministic: { ...red.plans.final, actions: [reduce] },
          final: { ...red.plans.final, actions: [reduce] },
        },
      }),
    ).toContain("lane-solvency");
  });

  it("regime-gate, rerange-rate, cost-hurdle and lane-not-paused block adding", () => {
    const { input } = validAddingStep();
    const gated = {
      ...input.regime,
      activeGates: ["REOPEN-GUARD" as const],
      riskMode: "reduce_only" as const,
    };
    expect(failed({ ...input, regime: gated })).toContain("regime-gate");
    // a regime that claims normal while a reduce-only gate is active is recomputed
    expect(failed({ ...input, regime: { ...gated, riskMode: "normal" } })).toContain("regime-gate");
    expect(failed({ ...input, agentRerange: { ...input.agentRerange, count1h: 4 } })).toContain(
      "rerange-rate",
    );
    expect(
      failed({
        ...input,
        agentRerange: { ...input.agentRerange, lastRerangeAtMs: NOW_MS - 1_000 },
      }),
    ).toContain("rerange-rate");
    const soon = withChain(input, (c) => {
      c.lane.budgets.nextRerangeAt = BigInt(NOW_SEC + 60);
    });
    expect(failed(soon)).toContain("rerange-rate");
    const paused = withChain(input, (c) => {
      c.lane.paused = true;
    });
    expect(failed(paused)).toContain("lane-not-paused");
  });

  it("cost-hurdle: waived only for the initial mint of an empty lane; otherwise ≥ 2x", () => {
    const { input, plan } = validAddingStep();
    expect(checkGuard(input).checks.find((c) => c.rule === "cost-hurdle")?.detail).toMatch(
      /waived/,
    );
    // a lane that already holds a position cannot claim the initial-mint waiver
    const held = withChain(input, (c) => {
      c.lane.positions = [9n, 0n];
    });
    expect(failed(held)).toContain("cost-hurdle");
    const later = { ...plan, trigger: "out_of_range" as const };
    const plans = { deterministic: later, final: later };
    expect(failed({ ...input, plans, hurdle: null })).toContain("cost-hurdle");
    const pass = { costUsd: 0.4, benefitUsd: 0.8, multiple: 2, passes: true, detail: "ok" };
    expect(failed({ ...input, plans, hurdle: pass })).not.toContain("cost-hurdle");
    // a hurdle that claims to pass but does not clear the configured multiple
    expect(failed({ ...input, plans, hurdle: { ...pass, benefitUsd: 0.79 } })).toContain(
      "cost-hurdle",
    );
  });

  it("tick-validity and fence-precheck mirror the contract", () => {
    const { input, plan } = validAddingStep();
    const rr = plan.actions[0] as Extract<DeskAction, { kind: "rerange" }>;
    const r0 = rr.ranges[0];
    if (r0 === undefined) throw new Error("range");
    const misaligned: DeskAction = { ...rr, ranges: [{ ...r0, tickLower: r0.tickLower + 5 }] };
    expect(failed({ ...input, action: misaligned })).toContain("tick-validity");
    const tooWide: DeskAction = { ...rr, ranges: [{ ...r0, tickLower: r0.tickLower - 3000 }] };
    expect(failed({ ...input, action: tooWide })).toContain("tick-validity");
    // the fence reference far from the pool: a straddle is outside the fence
    const off = withChain(input, (c) => {
      c.lane.refTick = { ...c.lane.refTick, tick: c.pool.tick + 200 };
    });
    expect(failed(off)).toContain("fence-precheck");
    const dead = withChain(input, (c) => {
      c.lane.refTick = { ...c.lane.refTick, code: 2 };
    });
    expect(failed(dead)).toContain("fence-precheck");
  });

  it("overlay-tighten-only: a looser final plan, or a step outside the final plan, is blocked", () => {
    const { input, plan } = validAddingStep();
    const rr = plan.actions[0] as Extract<DeskAction, { kind: "rerange" }>;
    const looser = { ...plan, notionalCents: plan.notionalCents + 1 };
    const llm = {
      ...input.overlay,
      source: "llm" as const,
      applied: true,
      critic: { verdict: "APPROVE" as const, reason: "ok" },
    };
    expect(
      failed({ ...input, overlay: llm, plans: { deterministic: plan, final: looser } }),
    ).toContain("overlay-tighten-only");
    const narrower: DeskAction = {
      ...rr,
      ranges: rr.ranges.map((r) => ({ ...r, tickLower: r.tickLower + 10 })),
    };
    expect(failed({ ...input, action: narrower })).toContain("overlay-tighten-only");
  });

  it("simulation-ok, signer-binding, single-in-flight and deadline-sane apply to reducing steps too", () => {
    const { input } = validReducingStep();
    expect(failed({ ...input, simulation: null })).toContain("simulation-ok");
    const sim = input.simulation;
    if (sim === null) throw new Error("sim");
    expect(
      failed({ ...input, simulation: { ...sim, latestBlockNumber: sim.blockNumber + 21n } }),
    ).toContain("simulation-ok");
    expect(
      failed({
        ...input,
        simulation: { ...sim, from: "0x4444444444444444444444444444444444444444" },
      }),
    ).toContain("simulation-ok");
    const ownerSigner = withChain(input, (c) => {
      c.lane.owner = c.lane.operator;
    });
    expect(failed(ownerSigner)).toContain("signer-binding");
    const notOperator = withChain(input, (c) => {
      c.lane.operator = "0x4444444444444444444444444444444444444444";
    });
    expect(failed(notOperator)).toContain("signer-binding");
    expect(failed({ ...input, inFlight: 1 })).toContain("single-in-flight");
    const meta = input.meta;
    if (meta === null) throw new Error("meta");
    expect(failed({ ...input, meta: { ...meta, deadline: BigInt(NOW_SEC + 4) } })).toContain(
      "deadline-sane",
    );
    expect(failed({ ...input, meta: { ...meta, deadline: BigInt(NOW_SEC + 61) } })).toContain(
      "deadline-sane",
    );
    expect(failed({ ...input, meta: { ...meta, deadline: BigInt(NOW_SEC + 60) } })).not.toContain(
      "deadline-sane",
    );
  });

  it("posture inversion: reducing bypasses freshness, gates, hurdle, rate and pause; never arm or dry-run", () => {
    const { input } = validReducingStep();
    const hostile = withChain(
      {
        ...input,
        freshness: {
          chain: "UNAVAILABLE",
          hl: "UNAVAILABLE",
          rh: "UNAVAILABLE",
          k: "UNAVAILABLE",
          corpActions: "UNAVAILABLE",
        },
        regime: { ...input.regime, activeGates: ["HALT", "STALE-REF", "CLOSED"], riskMode: "flat" },
        agentRerange: { ...input.agentRerange, count1h: 99, count24h: 99, lastRerangeAtMs: NOW_MS },
        hurdle: null,
      },
      (c) => {
        c.lane.paused = true;
        c.lane.budgets.reranges1hLeft = 0n;
      },
    );
    expect(checkGuard(hostile).decision).toBe("execute");
    expect(failed({ ...hostile, flags: { ...hostile.flags, armed: false } })).toEqual(["arm-flag"]);
    expect(checkGuard({ ...hostile, flags: { ...hostile.flags, dryRun: true } }).decision).toBe(
      "dry-run",
    );
  });

  it("pause carries no Meta: no deadline, no on-chain decision id", () => {
    const { input } = validReducingStep("pause");
    const r = checkGuard({
      ...input,
      meta: null,
      idempotency: { dbHasStep: false, onchainDecisionUsedAt: null },
    });
    expect(r.violations).toEqual([]);
  });

  it("hl-order: paper hedges pass; live needs HL_ARM and DESK_ARM", () => {
    const { input } = validReducingStep();
    const hedge: DeskAction = {
      kind: "hedge",
      lane: "B",
      coin: "xyz:NVDA",
      asset: 110002,
      isBuy: false,
      sz: "0.1",
      px: "222.5",
      tif: "Alo",
      reduceOnly: false,
    };
    const planB = { ...input.plans.final, lane: "B" as const, actions: [hedge] };
    const base: GuardInput = {
      ...input,
      action: hedge,
      riskClass: "adding",
      tx: null,
      meta: null,
      simulation: null,
      notionalCents: 2_225,
      expected: { ...input.expected, lane: "B" },
      snapshot: { ...input.snapshot, lane: "B" },
      plans: { deterministic: planB, final: planB },
    };
    expect(failed(base)).toEqual([]);
    expect(failed({ ...base, flags: { ...base.flags, hlMode: "live" } })).toContain("hl-order");
    expect(
      failed({ ...base, flags: { ...base.flags, hlMode: "live", hlArmed: true } }),
    ).not.toContain("hl-order");
  });

  it("a rule that throws on malformed input fails closed instead of crashing the guard", () => {
    const { input } = validAddingStep();
    const broken = { ...input, snapshot: { ...input.snapshot, chain: null } } as GuardInput;
    const r = checkGuard(broken);
    expect(r.decision).toBe("blocked");
    expect(r.checks).toHaveLength(26);
    const weird = {
      ...input,
      meta: { ...input.meta, decisionId: "0xnothex" },
    } as unknown as GuardInput;
    expect(checkGuard(weird).violations.find((v) => v.rule === "idempotency")?.detail).toMatch(
      /fail-closed|bytes32/,
    );
  });
});
