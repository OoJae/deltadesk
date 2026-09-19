/**
 * A fully valid GuardInput built from the real pipeline (mock snapshot → regime → strategy → plan
 * critic), so guard tests start from a step that EXECUTES and flip one fact at a time.
 */

import { encodeFunctionData } from "viem";
import { planCritic } from "../../../src/agents/plan-critic.js";
import { guardLimitsFrom, loadConfig, STRATEGY_DEFAULTS } from "../../../src/config.js";
import { deskLaneAbi, OPERATOR_SELECTOR_SET } from "../../../src/executor/abi/DeskLane.js";
import { createDecisionUlidFactory, encodeDecisionId } from "../../../src/executor/decision-id.js";
import { riskModel } from "../../../src/guard/risk.js";
import { identityOverlay } from "../../../src/overlay/apply.js";
import { computeRegime, defaultRegimeDeps } from "../../../src/regime/index.js";
import { createGateMachine } from "../../../src/regime/machine.js";
import { MOCK_NOW_MS, MOCK_OPERATOR, mockSnapshot } from "../../../src/sense/mock.js";
import { createLaneStrategy, type LanePlan } from "../../../src/strategy/lanes.js";
import type {
  AgentRerangeState,
  DeskAction,
  DeskPlan,
  DeskSnapshot,
  GuardInput,
  Hex,
  LaneState,
  Meta,
  RegimeState,
  SimulationResult,
  TxCall,
} from "../../../src/types.js";
import { riskClassOf } from "../../../src/types.js";

export const NOW_MS = MOCK_NOW_MS;
export const NOW_SEC = Math.floor(NOW_MS / 1000);
export const ZERO32 = `0x${"00".repeat(32)}` as Hex;

export function normalRegime(snapshot: DeskSnapshot, nowMs = NOW_MS): RegimeState {
  const machine = createGateMachine({ startActive: false });
  return computeRegime({ ...defaultRegimeDeps, machine }, snapshot, machine.initial(nowMs), nowMs);
}

export function laneState(
  snapshot: DeskSnapshot,
  regime: RegimeState,
  over: Partial<LaneState> = {},
): LaneState {
  return {
    lane: snapshot.lane,
    laneAddress: snapshot.laneAddress,
    gates: regime.gates,
    outsideInnerTicks: 0,
    rerangeNotBeforeMs: null,
    safeMode: null,
    lastTickAtMs: null,
    lastDecisionId: null,
    brain: "deterministic",
    ...over,
  };
}

export const FRESH_AGENT: AgentRerangeState = {
  lastRerangeAtMs: null,
  count1h: 0,
  count24h: 0,
  maxPerHour: 4,
  maxPerDay: 24,
  minIntervalMs: 300_000,
};

export function planFor(snapshot: DeskSnapshot, regime: RegimeState, nowMs = NOW_MS): LanePlan {
  return createLaneStrategy({ maxActionCents: 6_000 }).plan({
    lane: snapshot.lane,
    snapshot,
    regime,
    laneState: laneState(snapshot, regime),
    params: STRATEGY_DEFAULTS,
    agentRerange: FRESH_AGENT,
    hourRecord: { fees_usd: 6_164 },
    gasQuote: null,
    nowMs,
    random: () => 0,
  });
}

export function metaFor(
  ulid: string,
  step: number,
  regime: RegimeState,
  deadlineSec = NOW_SEC + 45,
): Meta {
  return {
    decisionId: encodeDecisionId(ulid, step),
    deadline: BigInt(deadlineSec),
    regime: regime.regimeCode,
    gatesMask: regime.gatesMask,
    reasonHash: ZERO32,
  };
}

export function encodeCall(action: DeskAction, meta: Meta, to: Hex = snapshotLane()): TxCall {
  let data: Hex;
  switch (action.kind) {
    case "rerange":
      data = encodeFunctionData({
        abi: deskLaneAbi,
        functionName: "rerange",
        args: [meta, action.ranges, action.expectedTick, action.maxTickDelta],
      });
      break;
    case "reduce":
      data = encodeFunctionData({
        abi: deskLaneAbi,
        functionName: "reduce",
        args: [meta, action.slot, action.liquidity],
      });
      break;
    case "collect":
    case "exitAll":
    case "signal":
      data = encodeFunctionData({ abi: deskLaneAbi, functionName: action.kind, args: [meta] });
      break;
    case "pause":
      data = encodeFunctionData({ abi: deskLaneAbi, functionName: "pause", args: [] });
      break;
    default:
      throw new Error(`no calldata for ${action.kind}`);
  }
  return { to, data, value: 0n, selector: data.slice(0, 10) as Hex };
}

function snapshotLane(): Hex {
  return mockSnapshot().laneAddress;
}

export function okSimulation(action: DeskAction): SimulationResult {
  const rerange =
    action.kind === "rerange" && action.ranges.length > 0
      ? {
          tokenIds: [7n],
          liquidities: [10n ** 15n],
          amount0Used: 24_000_000n,
          amount1Used: 110_000_000_000_000_000n,
        }
      : null;
  return {
    ok: true,
    blockNumber: 1_000_000n,
    latestBlockNumber: 1_000_002n,
    from: MOCK_OPERATOR,
    returnData: "0x",
    rerange,
    error: null,
    gasEstimate: 900_000n,
  };
}

export interface Fixture {
  input: GuardInput;
  snapshot: DeskSnapshot;
  regime: RegimeState;
  plan: DeskPlan;
}

/** A valid, armed, live (DRY_RUN off) step: the guard says "execute". */
export function validAddingStep(): Fixture {
  const snapshot = mockSnapshot({ nowMs: NOW_MS, hlMid: 222.6 });
  const regime = normalRegime(snapshot);
  const plan = planFor(snapshot, regime);
  const action = plan.actions[0] as DeskAction;
  if (action.kind !== "rerange") throw new Error(`fixture expected a rerange, got ${action.kind}`);
  return { ...buildStep(snapshot, regime, plan, action), snapshot, regime, plan };
}

/** A valid risk-reducing step (exitAll of a lane holding one position). */
export function validReducingStep(kind: "exitAll" | "collect" | "pause" = "exitAll"): Fixture {
  const snapshot = mockSnapshot({ nowMs: NOW_MS });
  const chain = snapshot.chain;
  if (chain === null) throw new Error("mock chain missing");
  chain.lane.positions = [7n, 0n];
  chain.lane.positionDetails = [
    {
      tokenId: 7n,
      tickLower: 222160,
      tickUpper: 222370,
      liquidity: 10n ** 15n,
      tokensOwed0: 0n,
      tokensOwed1: 0n,
      feeGrowthInside0LastX128: 0n,
      feeGrowthInside1LastX128: 0n,
    },
    null,
  ];
  const regime = normalRegime(snapshot);
  const action: DeskAction = { kind, lane: "A" };
  const plan: DeskPlan = {
    lane: "A",
    laneAddress: snapshot.laneAddress,
    createdAtMs: NOW_MS,
    riskMode: regime.riskMode,
    actions: [action],
    rationale: ["test"],
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
  return { ...buildStep(snapshot, regime, plan, action), snapshot, regime, plan };
}

export function buildStep(
  snapshot: DeskSnapshot,
  regime: RegimeState,
  plan: DeskPlan,
  action: DeskAction,
): { input: GuardInput } {
  const ulid = createDecisionUlidFactory()(NOW_MS);
  const meta = metaFor(ulid, 0, regime);
  const simulation = action.kind === "hedge" ? null : okSimulation(action);
  const critic = planCritic.critique({
    snapshot,
    regime,
    plan,
    params: STRATEGY_DEFAULTS,
    nowMs: NOW_MS,
  });
  const cfg = loadConfig({});
  const caps = snapshot.chain?.lane.caps;
  if (caps === undefined) throw new Error("fixture needs a chain read");
  const input: GuardInput = {
    decisionId: ulid,
    step: 0,
    action,
    riskClass: riskClassOf(action),
    meta,
    expected: {
      lane: snapshot.lane,
      laneAddress: snapshot.laneAddress,
      chainId: 4663,
      signerAddress: MOCK_OPERATOR,
    },
    snapshot,
    regime,
    plans: { deterministic: plan, final: plan },
    planCritic: { verdict: critic.verdict, reason: critic.reason },
    overlay: identityOverlay(plan, "ov-1").record,
    llmStrings: [],
    tx: action.kind === "hedge" ? null : encodeCall(action, meta, snapshot.laneAddress),
    operatorSelectors: OPERATOR_SELECTOR_SET,
    notionalCents: riskModel.notionalCents(action, snapshot, simulation),
    limits: guardLimitsFrom(cfg, caps),
    flags: { armed: true, dryRun: false, hlMode: "paper", hlArmed: false },
    turnoverDbCents24h: 0,
    idempotency: { dbHasStep: false, onchainDecisionUsedAt: 0n },
    freshness: regime.freshness,
    agentRerange: FRESH_AGENT,
    hurdle: plan.hurdle,
    simulation,
    estimatedGasCostWei: 1_200_000n * 132_800_000n,
    inFlight: 0,
    nowMs: NOW_MS,
  };
  return { input };
}
