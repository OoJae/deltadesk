/**
 * Core domain types and the interfaces every subsystem implements.
 *
 * This file is the contract between modules: builders implement the interfaces here and never
 * redefine them. It depends on nothing but the language. The few runtime values it exports
 * (constants, error classes, riskClassOf) exist because they ARE the definitions: an action's risk
 * class, a gate's bit, an error code's outcome.
 *
 * Naming: `Lane` is the lane LETTER ("A" | "B" | "C"); the lane CONTRACT is always `laneAddress`.
 * Money is integer cents (`*Cents`) or on-chain usd6 (`*Usd6`, bigint). Chain quantities that the
 * ABI decodes as bigint stay bigint (mirrors viem's decoding); ticks and small ints are numbers.
 */

export type Address = `0x${string}`;
export type Hex = `0x${string}`;

// ---------------------------------------------------------------------------------------------
// Lanes, actions, meta

export type Lane = "A" | "B" | "C";
/** laneId as stored in the clone's immutable args (IDeskLaneFactory.CreateParams.laneId). */
export const LANE_IDS: Readonly<Record<Lane, number>> = { A: 0, B: 1, C: 2 };
export const LANE_BY_ID: Readonly<Record<number, Lane>> = { 0: "A", 1: "B", 2: "C" };

/**
 * adding: increases market exposure (needs fresh refs, every gate clear, approval).
 * reducing: removes exposure (bypasses freshness, gates, hurdle and approval windows; never bypasses
 * arm, dry-run, allowlist, idempotency, simulation or signer binding).
 * neutral: changes no exposure (signal); treated like reducing for gating, never counted as turnover.
 */
export type RiskClass = "adding" | "reducing" | "neutral";

/** One range of a rerange. Shares are bps of the lane's idle balances AFTER the unwind. */
export interface RangeSpec {
  tickLower: number;
  tickUpper: number;
  share0Bps: number;
  share1Bps: number;
}

export const HL_NVDA_COIN = "xyz:NVDA" as const;
export const HL_NVDA_ASSET = 110002 as const;

/**
 * Everything the agent can ever ask for. There is NO withdraw / unpause / setCaps / setOperator /
 * setGuardian / setClosedUntil: those are unrepresentable here, in the calldata builder and in
 * OPERATOR_SELECTORS (src/executor/abi/DeskLane.ts).
 */
export type DeskAction =
  | { kind: "hold"; lane: Lane; reason: string }
  /** adding; an EMPTY ranges array is unwind-and-hold, which is reducing. */
  | { kind: "rerange"; lane: Lane; ranges: RangeSpec[]; expectedTick: number; maxTickDelta: number }
  | { kind: "reduce"; lane: Lane; slot: 0 | 1; liquidity: bigint }
  | { kind: "collect"; lane: Lane }
  | { kind: "exitAll"; lane: Lane }
  | { kind: "pause"; lane: Lane }
  | { kind: "signal"; lane: Lane; note: string }
  /** Paper-only in M2 (HL_MODE=paper). */
  | {
      kind: "hedge";
      lane: "B";
      coin: typeof HL_NVDA_COIN;
      asset: typeof HL_NVDA_ASSET;
      isBuy: boolean;
      sz: string;
      px: string;
      tif: "Alo" | "Ioc";
      reduceOnly: boolean;
    };

export type DeskActionKind = DeskAction["kind"];
export type ExecutableActionKind = Exclude<DeskActionKind, "hold">;
export type ReducingAction = Extract<
  DeskAction,
  { kind: "reduce" | "collect" | "exitAll" | "pause" }
>;
export type HedgeAction = Extract<DeskAction, { kind: "hedge" }>;
export type RerangeAction = Extract<DeskAction, { kind: "rerange" }>;

/** The single definition of an action's risk class. */
export function riskClassOf(action: DeskAction): RiskClass {
  switch (action.kind) {
    case "rerange":
      return action.ranges.length > 0 ? "adding" : "reducing";
    case "reduce":
    case "collect":
    case "exitAll":
    case "pause":
      return "reducing";
    case "hedge":
      return action.reduceOnly ? "reducing" : "adding";
    case "hold":
    case "signal":
      return "neutral";
    default: {
      const unreachable: never = action;
      throw new Error(`riskClassOf: unknown action ${JSON.stringify(unreachable)}`);
    }
  }
}

/** IDeskTypes.Meta. regime, gatesMask and reasonHash are logged on-chain only (untrusted there). */
export interface Meta {
  decisionId: Hex;
  deadline: bigint;
  regime: number;
  gatesMask: number;
  reasonHash: Hex;
}

/** IDeskTypes.Action enum, by index. Append-only on-chain: never reorder. */
export const LANE_ACTION_NAMES = [
  "RERANGE",
  "REDUCE",
  "COLLECT",
  "EXIT_ALL",
  "WITHDRAW",
  "WITHDRAW_POSITION",
  "PAUSE",
  "UNPAUSE",
  "SIGNAL",
  "SET_OPERATOR",
  "SET_CAPS",
  "SET_CLOSED_UNTIL",
  "SET_GUARDIAN",
] as const;
export type LaneActionName = (typeof LANE_ACTION_NAMES)[number];

/** IPriceFence status codes, plus the lane's own riskAddingOpen() codes (100 paused, 101 closedUntil). */
export const FENCE_CODES = {
  OK: 0,
  UNKNOWN_TOKEN: 1,
  FEED_DEAD: 2,
  ORACLE_PAUSED: 3,
  CORP_ACTION_WINDOW: 4,
  MARKET_CLOSED: 5,
  DEPEG: 6,
  FEED_REVERTED: 7,
  LANE_PAUSED: 100,
  CLOSED_UNTIL: 101,
} as const;

// ---------------------------------------------------------------------------------------------
// Market calendar and assess (ports of engine/markout/calendar.py and engine/api/app.py::assess)

export type RegimeName = "REGULAR" | "EXTENDED" | "OVERNIGHT" | "WEEKEND_DARK" | "HOLIDAY";
export type ReopenKind = "weekday_open" | "wake";

/** Meta.regime codes (uint8). 0 is reserved for "unknown". */
export const REGIME_CODE: Readonly<Record<RegimeName, number>> = {
  REGULAR: 1,
  EXTENDED: 2,
  OVERNIGHT: 3,
  WEEKEND_DARK: 4,
  HOLIDAY: 5,
};

export interface EtClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** ISO weekday, Monday = 1 … Sunday = 7. */
  isoWeekday: number;
}

export interface CalendarRegime {
  name: RegimeName;
  reopenWindow: boolean;
  reopenKind: ReopenKind | null;
  /** Hour of week by the ET clock, Monday 00:00 = 0. */
  how: number;
  /** The 24/5 session this timestamp belongs to, YYYY-MM-DD. */
  sessionDate: string;
  et: EtClock;
}

export type AssessLevel = "ALLOW" | "CAUTION" | "BLOCK";
export interface AssessReason {
  level: AssessLevel;
  reason: string;
}
export interface AssessResult {
  verdict: AssessLevel;
  reasons: AssessReason[];
}

/** The engine's hour-of-week LP record (snake_case: it is the engine's JSON). */
export interface HourRecord {
  edge_1h?: number | null;
  picked_1h_usd?: number | null;
  fees_usd?: number | null;
  swaps?: number | null;
  lp_net_bps_1h?: number | null;
  reference?: string;
}

// ---------------------------------------------------------------------------------------------
// Sense

export type SourceName = "chain" | "hl" | "rh" | "k" | "corpActions";
export const SOURCE_NAMES: readonly SourceName[] = ["chain", "hl", "rh", "k", "corpActions"];

export interface SourceStatus {
  ok: boolean;
  /** Age of the newest datum; null when there has never been one. */
  ageMs: number | null;
  reason: string | null;
}

export type Freshness = "FRESH" | "STALE" | "UNAVAILABLE";
export type FreshnessMap = Record<SourceName, Freshness>;

/** IDeskTypes.Caps as viem decodes it (uint64 → bigint, smaller uints → number). */
export interface LaneCaps {
  maxDeployUsd6: bigint;
  turnoverUsd6PerDay: bigint;
  placeBandBps: number;
  maxTickDelta: number;
  minWidthTicks: number;
  maxWidthTicks: number;
  reranges1h: number;
  reranges24h: number;
  minRerangeInterval: number;
  maxDeadlineAhead: number;
  maxRanges: number;
}

/** IDeskLane.budgets() as viem decodes it. */
export interface LaneBudgets {
  turnoverAvailableUsd6: bigint;
  reranges1hLeft: bigint;
  reranges24hLeft: bigint;
  /** Unix seconds. */
  nextRerangeAt: bigint;
}

/** NonfungiblePositionManager.positions(tokenId), the fields the agent uses. */
export interface NpmPosition {
  tokenId: bigint;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  tokensOwed0: bigint;
  tokensOwed1: bigint;
  feeGrowthInside0LastX128: bigint;
  feeGrowthInside1LastX128: bigint;
}

export interface PoolState {
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
  unlocked: boolean;
}

export interface LaneOnchainState {
  laneAddress: Address;
  laneId: number;
  owner: Address;
  operator: Address;
  guardian: Address;
  paused: boolean;
  /** Unix seconds; 0 = none. */
  closedUntil: bigint;
  riskAddingOpen: { open: boolean; code: number };
  refTick: { tick: number; bandTicks: number; code: number };
  caps: LaneCaps;
  budgets: LaneBudgets;
  /** Token ids by slot (0 = empty). */
  positions: readonly [bigint, bigint];
  /** NPM details by slot; null for an empty slot. */
  positionDetails: readonly [NpmPosition | null, NpmPosition | null];
  /** Idle balances held by the lane (token0 USDG, token1 NVDA), base units. */
  balances: { token0: bigint; token1: bigint };
}

export interface ChainlinkRound {
  roundId: bigint;
  answer: bigint;
  decimals: number;
  /** Unix seconds. */
  updatedAt: bigint;
  /** answer / 10^decimals, for display and strategy math only. */
  price: number;
}

/** ERC-8056 views of the stock token (verified live on NVDA 2026-09-19). */
export interface StockTokenState {
  oraclePaused: boolean | null;
  uiMultiplier: bigint | null;
  newUiMultiplier: bigint | null;
  /** Unix seconds; 0 when none is scheduled. */
  effectiveAt: bigint | null;
}

/** One block-pinned read: getBlock first, then Multicall3 at that block. */
export interface ChainRead {
  blockNumber: bigint;
  /** Unix seconds (block.timestamp; block.number on Orbit is an L1 estimate). */
  blockTimestamp: bigint;
  blockHash: Hex;
  baseFeePerGas: bigint | null;
  pool: PoolState;
  lane: LaneOnchainState;
  chainlink: {
    nvda: ChainlinkRound | null;
    usdg: ChainlinkRound | null;
    eth: ChainlinkRound | null;
  };
  stockToken: StockTokenState;
  operatorEthWei: bigint;
}

export interface HlQuote {
  coin: string;
  bid: number;
  ask: number;
  mid: number;
  markPx: number | null;
  oraclePx: number | null;
  exchangeTimeMs: number | null;
  receivedAtMs: number;
  source: "ws" | "rest";
}

export interface RhQuote {
  symbol: string;
  bid: number;
  ask: number;
  mid: number;
  isTradingHalt: boolean;
  generatedAtMs: number | null;
  receivedAtMs: number;
}

export interface CorporateAction {
  symbol: string;
  kind: string;
  status: string;
  effectiveAtMs: number | null;
  raw?: unknown;
}

export interface CorpActionsState {
  /** A pending corporate action for the lane's stock. */
  pendingForSymbol: boolean;
  nextEffectiveAtMs: number | null;
  items: CorporateAction[];
  fetchedAtMs: number;
}

/** The fair-value basis k = poolMid / HL (engine-calibrated on the last completed regular session). */
export interface BasisK {
  k: number;
  source: "engine" | "cache" | "self";
  session: string | null;
  /** When this value was obtained (engine fetch, cache write or self computation). */
  fetchedAtMs: number;
}

export interface FairValue {
  /** HL · k, quote per base (USDG per NVDA). */
  F: number;
  hl: number;
  k: number;
  kSource: BasisK["source"];
  /** Pool mid, quote per base. */
  poolMid: number;
  /** 1e4 · ln(F / poolMid). */
  gapBps: number;
}

export interface DeskSnapshot {
  lane: Lane;
  laneAddress: Address;
  chainId: number;
  /** The operator key the agent would sign with (provenance and signer binding). */
  signerAddress: Address;
  takenAtMs: number;
  calendar: CalendarRegime;
  chain: ChainRead | null;
  hl: HlQuote | null;
  rh: RhQuote | null;
  k: BasisK | null;
  corpActions: CorpActionsState | null;
  fairValue: FairValue | null;
  /** ETH/USD for gas costing (HL or Chainlink 0x78F3…d3A9). */
  ethUsd: number | null;
  sources: Record<SourceName, SourceStatus>;
}

// ---------------------------------------------------------------------------------------------
// Regime and gates

export type GateName =
  | "CLOSED"
  | "HALT"
  | "CORP-ACTION"
  | "STALE-REF"
  | "REOPEN-GUARD"
  | "BOUND-PINNED"
  | "WRAPPER-PREMIUM"
  | "EVENT";

export const GATE_NAMES: readonly GateName[] = [
  "CLOSED",
  "HALT",
  "CORP-ACTION",
  "STALE-REF",
  "REOPEN-GUARD",
  "BOUND-PINNED",
  "WRAPPER-PREMIUM",
  "EVENT",
];

/** Meta.gatesMask bits (uint16). */
export const GATE_BITS: Readonly<Record<GateName, number>> = {
  CLOSED: 1 << 0,
  HALT: 1 << 1,
  "CORP-ACTION": 1 << 2,
  "STALE-REF": 1 << 3,
  "REOPEN-GUARD": 1 << 4,
  "BOUND-PINNED": 1 << 5,
  "WRAPPER-PREMIUM": 1 << 6,
  EVENT: 1 << 7,
};

export type GateEffect = "reduce_only" | "flat" | "none";

/** What an ACTIVE gate forces. Stubs (implemented: false) force nothing and show as "not armed". */
export const GATE_EFFECT: Readonly<Record<GateName, GateEffect>> = {
  CLOSED: "reduce_only",
  HALT: "flat",
  "CORP-ACTION": "reduce_only",
  "STALE-REF": "reduce_only",
  "REOPEN-GUARD": "reduce_only",
  "BOUND-PINNED": "none",
  "WRAPPER-PREMIUM": "none",
  EVENT: "none",
};

export const GATE_IMPLEMENTED: Readonly<Record<GateName, boolean>> = {
  CLOSED: true,
  HALT: true,
  "CORP-ACTION": true,
  "STALE-REF": true,
  "REOPEN-GUARD": true,
  "BOUND-PINNED": false,
  "WRAPPER-PREMIUM": false,
  EVENT: false,
};

/** A gate turns on immediately and off only after BOTH dwell conditions hold. */
export interface GateDwell {
  clearTicks: number;
  clearMs: number;
}

/** Raw per-tick trigger for one gate, from regime/gates.ts. */
export interface GateTrigger {
  gate: GateName;
  triggered: boolean;
  reason: string;
}

export interface GateState {
  name: GateName;
  implemented: boolean;
  active: boolean;
  activeSinceMs: number | null;
  /** Consecutive clear (untriggered) ticks while active. */
  clearTicks: number;
  /** When the current clear streak started; null while triggered. */
  clearSinceMs: number | null;
  reason: string;
  effect: GateEffect;
}

export interface GateMachineState {
  gates: Record<GateName, GateState>;
  updatedAtMs: number;
}

export interface GateTransition {
  gate: GateName;
  active: boolean;
  atMs: number;
  reason: string;
}

export type RiskMode = "normal" | "reduce_only" | "flat";

export interface RegimeState {
  calendar: CalendarRegime;
  regimeCode: number;
  freshness: FreshnessMap;
  gates: GateMachineState;
  activeGates: GateName[];
  gatesMask: number;
  riskMode: RiskMode;
  transitions: GateTransition[];
}

export interface SafeModeState {
  reason: string;
  sinceMs: number;
}

/** Per-lane daemon state carried across ticks (in memory; desks.status persists safe mode). */
export interface LaneState {
  lane: Lane;
  laneAddress: Address;
  gates: GateMachineState;
  /** Consecutive ticks the pool tick sat outside the inner fraction of the live range. */
  outsideInnerTicks: number;
  /** Jittered earliest time a scheduled rerange may be proposed; null when none is scheduled. */
  rerangeNotBeforeMs: number | null;
  safeMode: SafeModeState | null;
  lastTickAtMs: number | null;
  lastDecisionId: string | null;
  /** "deterministic" after an LLM 402 (LlmCreditsExhausted). */
  brain: "llm" | "deterministic";
}

// ---------------------------------------------------------------------------------------------
// Strategy, hurdle, gap, hedge

export interface StrategyParams {
  /** Straddle only if |poolMid − F| ≤ this. */
  straddleMaxGapBps: number;
  halfWidthTicks: number;
  tickSpacing: number;
  /** Rerange when the pool tick leaves this inner fraction of the range… */
  innerFraction: number;
  /** …for this many consecutive ticks. */
  outsideTicksToTrigger: number;
  /** Benefit must be ≥ this multiple of cost. */
  hurdleMultiple: number;
  jitterMaxMs: number;
  /** Gas units assumed for a full rerange before simulation. */
  rerangeGasUnits: bigint;
  /** maxTickDelta the agent sends (≤ caps.maxTickDelta). */
  maxTickDelta: number;
}

export interface AgentRerangeState {
  lastRerangeAtMs: number | null;
  count1h: number;
  count24h: number;
  maxPerHour: number;
  maxPerDay: number;
  minIntervalMs: number;
}

export interface GasQuote {
  gasUnits: bigint;
  maxFeePerGas: bigint;
  ethUsd: number;
}

export type RerangeTrigger = "outside_inner" | "out_of_range" | "initial_mint";

export interface HurdleInput {
  gasUnits: bigint;
  maxFeePerGas: bigint;
  ethUsd: number;
  /** Hour-of-week fee rate: USD earned per USD of active notional per hour. */
  feeRatePerHour: number;
  activeNotionalUsd: number;
  /** P(out of range within the hour without a rerange). */
  pOutOfRange: number;
  multiple: number;
}

export interface HurdleResult {
  costUsd: number;
  benefitUsd: number;
  multiple: number;
  passes: boolean;
  detail: string;
}

export interface PlanMetrics {
  F: number | null;
  poolMid: number | null;
  gapBps: number | null;
  poolTick: number | null;
  fTick: number | null;
  refTick: number | null;
  bandTicks: number | null;
}

export interface DeskPlan {
  lane: Lane;
  laneAddress: Address;
  createdAtMs: number;
  riskMode: RiskMode;
  /** In execution order. A plan of one "hold" ends the tick with no decision row. */
  actions: DeskAction[];
  rationale: string[];
  trigger: RerangeTrigger | null;
  hurdle: HurdleResult | null;
  metrics: PlanMetrics;
  /** Estimated notional of the plan's ADDING actions, integer cents. */
  notionalCents: number;
}

export interface StrategyContext {
  lane: Lane;
  snapshot: DeskSnapshot;
  regime: RegimeState;
  laneState: LaneState;
  params: StrategyParams;
  agentRerange: AgentRerangeState;
  hourRecord: HourRecord | null;
  gasQuote: GasQuote | null;
  nowMs: number;
  /** Uniform [0,1) source for the 0–20 s jitter; injected so tests are deterministic. */
  random: () => number;
}

/** strategy/lanes.ts */
export interface Strategy {
  plan(ctx: StrategyContext): DeskPlan;
}

export interface BandPlacementInput {
  poolTick: number;
  fTick: number;
  gapBps: number;
  refTick: number;
  bandTicks: number;
  tickSpacing: number;
  halfWidthTicks: number;
  straddleMaxGapBps: number;
  minWidthTicks: number;
  maxWidthTicks: number;
  balance0: bigint;
  balance1: bigint;
}

export type BandPlacement =
  | {
      ok: true;
      shape: "straddle" | "single_sided_token0" | "single_sided_token1";
      ranges: RangeSpec[];
    }
  | { ok: false; reason: string };

/** strategy/bands.ts */
export type BandPlanner = (input: BandPlacementInput) => BandPlacement;
/** strategy/hurdle.ts */
export type HurdleFn = (input: HurdleInput) => HurdleResult;

export interface GapShadowInput {
  gapBps: number;
  regime: RegimeName;
  nowMs: number;
}
export interface GapSignal {
  gapBps: number;
  thresholdBps: number;
  wouldAct: boolean;
  /** Always "shadow" in M2: the gap rule failed out of sample and never drives execution. */
  mode: "shadow";
  detail: string;
}
/** strategy/gap.ts */
export type GapShadowFn = (input: GapShadowInput) => GapSignal;

export interface HedgeState {
  /** Lane delta in NVDA (position token1 exposure plus idle NVDA). */
  delta: number;
  /** Target hedge H*. */
  target: number;
  /** Rebalance tolerance τ. */
  tau: number;
  /** Current paper hedge position (negative = short). */
  position: number;
  atMs: number;
}
export interface HedgeContext {
  snapshot: DeskSnapshot;
  paperPosition: number;
  nowMs: number;
}
/** hedge/engine.ts (paper in M2). */
export interface HedgeEngine {
  step(ctx: HedgeContext): { state: HedgeState; actions: HedgeAction[] };
}

// ---------------------------------------------------------------------------------------------
// Critics and overlay

export type Verdict = "APPROVE" | "REJECT";

export interface CriticVerdict {
  verdict: Verdict;
  reason: string;
}

export interface CritiqueResult {
  verdict: CriticVerdict;
  /** Raw model output for the evidence trail; null for deterministic critics. */
  raw: string | null;
}

export interface PlanCriticInput {
  snapshot: DeskSnapshot;
  regime: RegimeState;
  plan: DeskPlan;
  params: StrategyParams;
  nowMs: number;
  /**
   * "plan" (default): the plan and the snapshot it was built from. "execution": an approved plan
   * re-checked on a LATER snapshot, right before it signs. The pool and F may each have moved by
   * up to the rerange's maxTickDelta (the slack the on-chain tick guard gives the pool): the
   * recomputed placement must still be contained up to that drift, and the plan's recorded
   * (plan-time) metrics are not compared.
   */
  stage?: "plan" | "execution";
}
export interface PlanCriticResult extends CriticVerdict {
  /** Every recomputed check and its outcome, for the evidence trail. */
  findings: string[];
}
/** agents/plan-critic.ts: deterministic, recomputes everything; a throw means REJECT. */
export interface PlanCritic {
  critique(input: PlanCriticInput): PlanCriticResult;
}

/**
 * The only thing the LLM may produce: a TIGHTEN-ONLY overlay on the deterministic plan.
 * notionalScaleBps ≤ 10_000; widenTicks ≥ 0 (wider = less dense); dropping adding actions and
 * adding reducing actions are the only structural edits.
 */
export interface OverlayProposal {
  notionalScaleBps: number;
  widenTicks: number;
  dropActionIndexes: number[];
  addReducing: ReducingAction[];
  rationale: string;
}

export interface TightenCheckResult {
  ok: boolean;
  violations: string[];
}

export interface OverlayRecord {
  overlayId: string;
  source: "identity" | "llm";
  proposal: OverlayProposal | null;
  critic: CriticVerdict | null;
  tighten: TightenCheckResult;
  /** true when the final plan includes this overlay's edits. */
  applied: boolean;
  raw: string | null;
  error: string | null;
}

export interface OverlayContext {
  snapshot: DeskSnapshot;
  regime: RegimeState;
  plan: DeskPlan;
}
/** agents/overlay-planner.ts */
export interface OverlayPlanner {
  propose(ctx: OverlayContext): Promise<{ proposal: OverlayProposal; raw: string | null }>;
}
/** agents/overlay-critic.ts */
export interface OverlayCritic {
  critique(ctx: OverlayContext, proposal: OverlayProposal): Promise<CritiqueResult>;
}
/** overlay/apply.ts: identity by default; tightenCheck is always enforced. */
export interface OverlayApplier {
  apply(plan: DeskPlan, proposal: OverlayProposal): DeskPlan;
  tightenCheck(deterministic: DeskPlan, final: DeskPlan): TightenCheckResult;
}

// ---------------------------------------------------------------------------------------------
// Guard

export type GuardDecision = "execute" | "dry-run" | "blocked";

export type GuardRuleId =
  // ported
  | "action-none"
  | "critic-approval"
  | "allowlist"
  | "amount-positive"
  | "max-action-usd"
  | "daily-turnover"
  | "idempotency"
  | "arm-flag"
  | "snapshot-provenance"
  // new
  | "ref-freshness"
  | "gas-reserve"
  | "lane-solvency"
  | "regime-gate"
  | "rerange-rate"
  | "cost-hurdle"
  | "tick-validity"
  | "fence-precheck"
  | "overlay-tighten-only"
  | "simulation-ok"
  | "signer-binding"
  | "lane-not-paused"
  | "single-in-flight"
  | "deadline-sane"
  | "hl-order"
  | "signal-policy"
  | "dry-run";

/** Evaluation order; dry-run is always last. */
export const GUARD_RULES: readonly GuardRuleId[] = [
  "action-none",
  "critic-approval",
  "allowlist",
  "amount-positive",
  "max-action-usd",
  "daily-turnover",
  "idempotency",
  "arm-flag",
  "snapshot-provenance",
  "ref-freshness",
  "gas-reserve",
  "lane-solvency",
  "regime-gate",
  "rerange-rate",
  "cost-hurdle",
  "tick-validity",
  "fence-precheck",
  "overlay-tighten-only",
  "simulation-ok",
  "signer-binding",
  "lane-not-paused",
  "single-in-flight",
  "deadline-sane",
  "hl-order",
  "signal-policy",
  "dry-run",
];

export interface GuardCheck {
  rule: GuardRuleId;
  passed: boolean;
  detail: string;
}

export interface GuardViolation {
  rule: GuardRuleId;
  detail: string;
}

export interface GuardResult {
  decision: GuardDecision;
  /** Every failed rule: all rules are evaluated, nothing short-circuits. */
  violations: GuardViolation[];
  /** Full evaluation trail, passing checks included. */
  checks: GuardCheck[];
  reason: string;
}

/** The encoded call the guard inspects (null for HL hedge steps). */
export interface TxCall {
  to: Address;
  data: Hex;
  value: bigint;
  /** First 4 bytes of data. */
  selector: Hex;
}

/** Static limits the guard enforces; built from AppConfig by the daemon. */
export interface GuardLimits {
  chainId: number;
  /** The lane pool's tick spacing (tick-validity). */
  tickSpacing: number;
  maxActionCents: number;
  dailyTurnoverCents: number;
  gasReserveWei: bigint;
  maxSnapshotAgeMs: number;
  maxSimBlockAge: number;
  deadlineMinAheadSec: number;
  deadlineMaxAheadSec: number;
  hurdleMultiple: number;
  agentReranges: { perHour: number; perDay: number; minIntervalSec: number };
}

/**
 * Everything the pure guard needs for ONE step. All I/O-derived facts are injected; the guard
 * never touches the db, env or network. Lane facts (operator, owner, paused, caps, budgets,
 * refTick, balances, positions, operator ETH) are read from `snapshot.chain`.
 */
export interface GuardInput {
  decisionId: string;
  step: number;
  action: DeskAction;
  riskClass: RiskClass;
  meta: Meta | null;
  expected: { lane: Lane; laneAddress: Address; chainId: number; signerAddress: Address };
  snapshot: DeskSnapshot;
  regime: RegimeState;
  plans: { deterministic: DeskPlan; final: DeskPlan };
  planCritic: CriticVerdict;
  overlay: OverlayRecord;
  /** Every LLM-produced string that reached the final plan (rationales, notes). */
  llmStrings: string[];
  tx: TxCall | null;
  /** The OPERATOR_SELECTORS allowlist, injected so the guard stays pure. */
  operatorSelectors: ReadonlySet<Hex>;
  /** This step's notional (adding actions), integer cents. */
  notionalCents: number;
  limits: GuardLimits;
  flags: { armed: boolean; dryRun: boolean; hlMode: HlMode; hlArmed: boolean };
  /** Σ notional_cents of adding executions WITH a signature in the last 24 h (fail-closed). */
  turnoverDbCents24h: number;
  idempotency: { dbHasStep: boolean; onchainDecisionUsedAt: bigint | null };
  freshness: FreshnessMap;
  agentRerange: AgentRerangeState;
  hurdle: HurdleResult | null;
  simulation: SimulationResult | null;
  /** Estimated gas cost of this step (gas × maxFee). */
  estimatedGasCostWei: bigint | null;
  /** Transactions in flight for this signer (prepared / simulated / signed / broadcast / unknown). */
  inFlight: number;
  /**
   * Gate signals only (signal-policy): signal() transactions of this lane signed in the last
   * rolling hour, and DESK_SIGNAL_MAX_PER_HOUR. Missing for a signal step: blocked (fail-closed).
   */
  signalRate?: { count1h: number; maxPerHour: number } | null;
  nowMs: number;
}

/** guard/guard.ts */
export type GuardFn = (input: GuardInput) => GuardResult;

/** guard/risk.ts */
export interface RiskModel {
  riskMode(activeGates: readonly GateName[]): RiskMode;
  /** Adding notional of one action in integer cents (fence-valued; 0 for reducing/neutral). */
  notionalCents(
    action: DeskAction,
    snapshot: DeskSnapshot,
    simulation: SimulationResult | null,
  ): number;
}

// ---------------------------------------------------------------------------------------------
// Approval

export type DeskMode = "advisory" | "copilot" | "autopilot";
export type ApprovalChannel = "web" | "telegram" | "file";
export type ApprovalOutcome =
  | "approved"
  | "denied"
  | "timeout"
  | "cancelled"
  | "not_required"
  | "advisory";

export interface ApprovalRequest {
  decisionId: string;
  laneAddress: Address;
  /** One-line human summary. */
  summary: string;
  windowMs: number;
}

export interface ApprovalAnswer {
  approved: boolean;
  outcome: "approved" | "denied" | "timeout";
  channel: ApprovalChannel | null;
}

export interface CancelAnswer {
  cancelled: boolean;
  channel: ApprovalChannel | null;
}

export interface ApprovalGate {
  /** copilot: approved only on an explicit approve. Silence ⇒ timeout ⇒ not approved (fail-closed). */
  requestApproval(req: ApprovalRequest): Promise<ApprovalAnswer>;
  /** autopilot: proceeds unless cancelled within the window (fail-open by design). */
  awaitCancelWindow(req: ApprovalRequest): Promise<CancelAnswer>;
}

// ---------------------------------------------------------------------------------------------
// Executor

export type Venue = "rh" | "hl";

export type ExecutionStatus =
  | "prepared"
  | "simulated"
  | "signed"
  | "broadcast"
  | "confirmed"
  | "reverted"
  | "failed"
  | "declined"
  | "dropped"
  | "unknown";

export type TxAttemptStatus =
  | "signed"
  | "broadcast"
  | "confirmed"
  | "reverted"
  | "dropped"
  | "replaced"
  | "unknown";

export type DecisionStatus =
  | "observed"
  | "critic_rejected"
  | "blocked"
  | "dry_run"
  | "advisory"
  | "declined"
  | "policy_denied"
  | "executing"
  | "executed"
  | "partially_executed"
  | "failed";

export type ExecErrorCode =
  | "SIM_POLICY"
  | "SIM_TRANSIENT"
  | "SIM_DECISION_USED"
  | "GAS_CAP"
  | "INSUFFICIENT_GAS"
  | "SIGNER_UNAVAILABLE"
  | "SIGNER_DENIED"
  | "SIGNER_REVOKED"
  | "SIGNER_MISMATCH"
  | "FEE_CAP_TOO_LOW"
  | "NONCE_TOO_LOW"
  | "RPC_UNAVAILABLE"
  | "RECEIPT_TIMEOUT"
  | "REVERTED"
  | "NONCE_CONFLICT"
  | "DEADLINE_PASSED"
  | "DESK_HALTED"
  | "UNKNOWN";

export type ExecErrorOutcome =
  | "fail" // failed, no retry
  | "retry_next_tick"
  | "reconcile"
  | "top_up_alert"
  | "retry_once"
  | "policy_denied" // decision policy_denied, desk safe mode, alert
  | "revoked" // desk revoked
  | "critical"
  | "resign_same_nonce" // at most 2 times
  | "lookup_by_hash"
  | "unknown" // execution unknown → reconciler
  | "decode_alert"
  | "safe_mode";

/** The error taxonomy of docs/m2-design-agent.md, as data. */
export const EXEC_ERROR_OUTCOME: Readonly<Record<ExecErrorCode, ExecErrorOutcome>> = {
  SIM_POLICY: "fail",
  SIM_TRANSIENT: "retry_next_tick",
  SIM_DECISION_USED: "reconcile",
  GAS_CAP: "top_up_alert",
  INSUFFICIENT_GAS: "top_up_alert",
  SIGNER_UNAVAILABLE: "retry_once",
  SIGNER_DENIED: "policy_denied",
  SIGNER_REVOKED: "revoked",
  SIGNER_MISMATCH: "critical",
  FEE_CAP_TOO_LOW: "resign_same_nonce",
  NONCE_TOO_LOW: "lookup_by_hash",
  RPC_UNAVAILABLE: "unknown",
  RECEIPT_TIMEOUT: "unknown",
  REVERTED: "decode_alert",
  NONCE_CONFLICT: "safe_mode",
  DEADLINE_PASSED: "fail",
  // The desk left active/registered (safe mode, revoked) while the step was signing: never sent.
  DESK_HALTED: "fail",
  UNKNOWN: "unknown",
};

export class ExecError extends Error {
  readonly code: ExecErrorCode;
  readonly outcome: ExecErrorOutcome;
  readonly detail: unknown;

  constructor(
    code: ExecErrorCode,
    message: string,
    opts: { cause?: unknown; detail?: unknown } = {},
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "ExecError";
    this.code = code;
    this.outcome = EXEC_ERROR_OUTCOME[code];
    this.detail = opts.detail;
  }
}

export function isExecError(err: unknown): err is ExecError {
  return err instanceof ExecError;
}

/** Thrown by loadConfig and the startup hooks when a configuration is unsafe. */
export class ConfigRefusedError extends Error {
  constructor(message: string) {
    super(`Refusing to start: ${message}`);
    this.name = "ConfigRefusedError";
  }
}

/** An EIP-1559 transaction as the executor builds it (compatible with viem's serializable type). */
export interface UnsignedTx {
  type: "eip1559";
  chainId: number;
  to: Address;
  data: Hex;
  value: bigint;
  nonce: number;
  gas: bigint;
  maxFeePerGas: bigint;
  /** Always 0 on Robinhood Chain: Orbit FCFS ordering, tips buy nothing. */
  maxPriorityFeePerGas: bigint;
}

/** IDeskLane.rerange return values, learned from the first eth_call. */
export interface RerangeReturn {
  tokenIds: readonly bigint[];
  liquidities: readonly bigint[];
  amount0Used: bigint;
  amount1Used: bigint;
}

export interface SimulationError {
  code: ExecErrorCode;
  /** Decoded custom error name (e.g. "RangeOutsideFence"), when known. */
  errorName: string | null;
  args: readonly unknown[];
  message: string;
}

export interface SimulationResult {
  ok: boolean;
  /** The pinned block the eth_call ran at. */
  blockNumber: bigint;
  latestBlockNumber: bigint;
  from: Address;
  returnData: Hex | null;
  rerange: RerangeReturn | null;
  error: SimulationError | null;
  gasEstimate: bigint | null;
}

export interface StepRequest {
  /** The decision's ULID. */
  decisionId: string;
  step: number;
  lane: Lane;
  laneAddress: Address;
  action: Exclude<DeskAction, { kind: "hold" }>;
  meta: Meta;
  riskClass: RiskClass;
  notionalCents: number;
}

export interface PreparedStep extends StepRequest {
  venue: Venue;
  call: TxCall | null;
  simulation: SimulationResult | null;
  hlOrder: HlOrderRequest | null;
}

export interface StepOutcome {
  executionId: number;
  status: ExecutionStatus;
  txHash: Hex | null;
  error: { code: ExecErrorCode; message: string } | null;
  gasUsed: bigint | null;
  feeWei: bigint | null;
  feeUsdCents: number | null;
  blockNumber: bigint | null;
}

/** executor/rh-executor.ts and executor/hl-executor.ts */
export interface Executor {
  readonly venue: Venue;
  /** Tick step 7: encode and simulate. Writes nothing. */
  prepare(req: StepRequest): Promise<PreparedStep>;
  /** Tick step 10: the write-ahead pipeline for one approved step. */
  execute(step: PreparedStep): Promise<StepOutcome>;
}

export interface BlockHeader {
  number: bigint;
  timestamp: bigint;
  hash: Hex;
  baseFeePerGas: bigint | null;
}

export interface RawLog {
  address: Address;
  topics: Hex[];
  data: Hex;
  blockNumber: bigint;
  transactionHash: Hex;
  logIndex: number;
}

export interface TxReceipt {
  transactionHash: Hex;
  status: "success" | "reverted";
  blockNumber: bigint;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  logs: RawLog[];
}

export interface ChainTx {
  hash: Hex;
  from: Address;
  nonce: number;
  blockNumber: bigint | null;
}

/** executor/chain.ts: the RPC surface the executor, reconciler and watchdog use. */
export interface ChainClient {
  chainId(): Promise<number>;
  blockNumber(): Promise<bigint>;
  getBlock(tag: "latest" | bigint): Promise<BlockHeader>;
  call(req: {
    from: Address;
    to: Address;
    data: Hex;
    value?: bigint;
    blockNumber: bigint;
  }): Promise<Hex>;
  estimateGas(req: { from: Address; to: Address; data: Hex; value?: bigint }): Promise<bigint>;
  getTransactionCount(address: Address, blockTag: "pending" | "latest"): Promise<number>;
  getBalance(address: Address, blockNumber?: bigint): Promise<bigint>;
  sendRawTransaction(raw: Hex): Promise<Hex>;
  getTransaction(hash: Hex): Promise<ChainTx | null>;
  getTransactionReceipt(hash: Hex): Promise<TxReceipt | null>;
  getLogs(params: {
    address: Address;
    fromBlock: bigint;
    toBlock: bigint;
    topics?: (Hex | null)[];
  }): Promise<RawLog[]>;
}

/** executor/calldata.ts: `to` is always the configured lane, never an input. */
export interface CalldataBuilder {
  encode(action: Exclude<DeskAction, { kind: "hold" | "hedge" }>, meta: Meta): TxCall;
  decode(data: Hex): { functionName: string; args: readonly unknown[] };
}

/** executor/simulate.ts */
export interface Simulator {
  simulate(call: TxCall, from: Address, blockNumber: bigint): Promise<SimulationResult>;
}

export interface FeeQuote {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}
/** executor/fees.ts: maxFee = max(2 × baseFee, floor), priority 0, capped (GAS_CAP). */
export interface FeePolicy {
  quote(block: BlockHeader): FeeQuote;
}

/** executor/nonce.ts: DB-backed, single in flight per signer. */
export interface NonceManager {
  next(signer: Address): Promise<number>;
}

export type ReceiptOutcome =
  | { kind: "confirmed"; receipt: TxReceipt }
  | { kind: "reverted"; receipt: TxReceipt }
  | { kind: "timeout" };

/** executor/broadcaster.ts */
export interface Broadcaster {
  broadcast(raw: Hex): Promise<Hex>;
  waitForReceipt(hash: Hex, opts: { pollMs: number; timeoutMs: number }): Promise<ReceiptOutcome>;
}

/** executor/errors.ts: classify with viem's err.walk(). */
export type ErrorClassifier = (err: unknown) => ExecError;

// ---------------------------------------------------------------------------------------------
// Signers and vault

export type SignerKind = "local" | "dynamic-delegated" | "dynamic-server";

export interface SignerReadiness {
  ready: boolean;
  reason: string | null;
}

/** The Operator wallet, never the owner. */
export interface TxSigner {
  readonly kind: SignerKind;
  readonly address: Address;
  /** Returns the signed raw transaction. Must be verified (parse + recover) before it is persisted. */
  signTransaction(tx: UnsignedTx): Promise<Hex>;
  ready(): Promise<SignerReadiness>;
}

export interface VaultAad {
  walletId: string;
  address: Address;
  purpose: string;
}

export interface SealedRow {
  dekWrapped: string;
  kekId: string;
  ciphertexts: Record<string, string>;
}

/** signer/vault.ts: AES-256-GCM envelope encryption; one random DEK per row wrapped by the KEK. */
export interface Vault {
  readonly kekId: string;
  sealRow(fields: Record<string, Uint8Array>, aad: Omit<VaultAad, "purpose">): SealedRow;
  openField(
    row: { dekWrapped: string; kekId: string },
    ciphertext: string,
    aad: VaultAad,
  ): Uint8Array;
}

// ---------------------------------------------------------------------------------------------
// Hyperliquid

export type HlMode = "paper" | "live";

export interface HlBboLevel {
  px: string;
  sz: string;
  n: number;
}
export interface HlBbo {
  coin: string;
  time: number;
  bid: HlBboLevel | null;
  ask: HlBboLevel | null;
}
export interface HlAssetCtx {
  coin: string;
  funding: string;
  openInterest: string;
  oraclePx: string;
  markPx: string;
  midPx: string | null;
  premium: string | null;
  impactPxs: [string, string] | null;
}
export interface HlTrade {
  coin: string;
  side: "B" | "A";
  px: string;
  sz: string;
  time: number;
  hash: Hex;
  tid: number;
}

export interface HlOrderRequest {
  /** Client order id: 16 bytes hex. */
  cloid: Hex;
  coin: typeof HL_NVDA_COIN;
  asset: typeof HL_NVDA_ASSET;
  isBuy: boolean;
  sz: string;
  px: string;
  tif: "Alo" | "Ioc";
  reduceOnly: boolean;
}

export type HlOrderStatus = "open" | "filled" | "partially_filled" | "canceled" | "rejected";

export interface HlOrderResult {
  cloid: Hex;
  status: HlOrderStatus;
  oid: number | null;
  filledSz: string;
  avgPx: string | null;
  error: string | null;
}

/** hl/client.ts: the LIVE exchange. Paper mode must never call it. */
export interface HlExchangeClient {
  placeOrder(order: HlOrderRequest): Promise<HlOrderResult>;
  cancelByCloid(asset: number, cloid: Hex): Promise<void>;
}

export interface HlAssetMeta {
  name: string;
  assetId: number;
  szDecimals: number;
  maxLeverage: number;
}

/** hl/client.ts: read-only info endpoint. */
export interface HlInfoClient {
  allMids(dex: string): Promise<Record<string, string>>;
  assetMeta(coin: string): Promise<HlAssetMeta>;
}

/** hl/format.ts: HL tick/lot formatting (5 significant figures, szDecimals). */
export interface HlFormatter {
  formatPx(px: number, meta: HlAssetMeta): string;
  formatSz(sz: number, meta: HlAssetMeta): string;
}

// ---------------------------------------------------------------------------------------------
// Sense interfaces (builder B1)

/** sense/chain.ts */
export interface ChainReader {
  read(laneAddress: Address, operator: Address): Promise<ChainRead>;
}

/** sense/hyperliquid.ts: ws bbo + activeAssetCtx for xyz:NVDA, REST allMids fallback. */
export interface HlFeed {
  start(): void;
  stop(): Promise<void>;
  latest(): HlQuote | null;
  status(nowMs: number): SourceStatus;
  /** Trade tape subscription (paper fills). Returns an unsubscribe function. */
  onTrade(listener: (trade: HlTrade) => void): () => void;
}

/** sense/robinhood.ts: /rhj/prices (every tick) and /rhj/corporate-actions (hourly). */
export interface RhFeed {
  quote(symbol: string): Promise<RhQuote>;
  corporateActions(symbol: string): Promise<CorpActionsState>;
}

/** sense/engine.ts: slow parameters from the DeltaDesk API (k with TTL, hour-of-week record). */
export interface EngineSource {
  basis(): Promise<BasisK | null>;
  hourRecord(how: number): Promise<HourRecord | null>;
  status(nowMs: number): SourceStatus;
}

/** sense/freshness.ts */
export type FreshnessFn = (
  sources: Record<SourceName, SourceStatus>,
  regime: RegimeName,
) => FreshnessMap;

/** sense/index.ts: one snapshot per lane per tick. */
export interface Sensor {
  read(lane: Lane, laneAddress: Address): Promise<DeskSnapshot>;
}

/** regime/gates.ts */
export interface GateEvaluator {
  evaluate(input: {
    snapshot: DeskSnapshot;
    freshness: FreshnessMap;
    nowMs: number;
  }): GateTrigger[];
}

/** regime/machine.ts: pure; immediate on, dwell off. */
export interface GateMachine {
  initial(nowMs: number): GateMachineState;
  step(
    prev: GateMachineState,
    triggers: readonly GateTrigger[],
    nowMs: number,
  ): { next: GateMachineState; transitions: GateTransition[] };
}

// ---------------------------------------------------------------------------------------------
// Reconciliation

export interface LaneActionEvent {
  txHash: Hex;
  logIndex: number;
  blockNumber: bigint;
  laneAddress: Address;
  laneId: number;
  decisionId: Hex;
  action: number;
  ticks: number[];
  refPxE18: bigint;
  regime: number;
  gatesMask: number;
  reasonHash: Hex;
  caller: Address;
}

export interface ReconcileReport {
  fromBlock: bigint;
  toBlock: bigint;
  matched: number;
  foreign: number;
  pending: number;
}

/** reconcile/lane-actions.ts: every 30 s, getLogs(cursor+1 .. latest−20), match by decisionId. */
export interface LaneActionReconciler {
  run(nowMs: number): Promise<ReconcileReport>;
}

export interface StartupReport {
  /** Pending approvals closed because no waiter survived the restart. */
  approvalsClosed: number;
  failedUnsigned: number;
  rebroadcast: number;
  resolved: number;
  unknown: number;
  decisionsReconciled: number;
}

/** reconcile/startup.ts: rebroadcast stored bytes, never re-sign. */
export interface StartupReconciler {
  run(nowMs: number): Promise<StartupReport>;
}

// ---------------------------------------------------------------------------------------------
// HTTP

export interface VerifiedUser {
  userId: string;
  /** Verified wallet addresses of the Dynamic user (lowercase). */
  wallets: Address[];
  environmentId: string;
  expiresAtSec: number;
}

/** http/auth.ts: Dynamic JWT verified with jose against the environment JWKS. */
export interface JwtVerifier {
  verify(token: string): Promise<VerifiedUser>;
}

export interface DynamicWebhookEnvelope {
  eventId: string;
  eventName: string;
  environmentId?: string;
  timestamp?: string;
  data: unknown;
}

export type WebhookResult = {
  status: 200 | 202 | 400 | 401 | 413 | 500;
  body: Record<string, unknown>;
};

/** http/dynamic-webhook.ts */
export interface WebhookHandler {
  handle(rawBody: Uint8Array, headers: Record<string, string | undefined>): Promise<WebhookResult>;
}

/** GET /desks/:lane/status (bigints as decimal strings). */
export interface DeskStatusView {
  lane: Address;
  owner: Address;
  operator: Address;
  laneId: number;
  mode: DeskMode;
  status: DeskStatus;
  delegation: { status: DelegationStatus | "none" };
  caps: Record<string, string | number> | null;
  budgets: Record<string, string> | null;
  positions: Array<{
    slot: number;
    tokenId: string;
    tickLower: number;
    tickUpper: number;
    liquidity: string;
  }>;
  balances: { token0: string; token1: string } | null;
  lastTick: {
    atMs: number;
    regime: RegimeName;
    reopenKind: ReopenKind | null;
    gates: GateName[];
    F: number | null;
    poolMid: number | null;
    gapBps: number | null;
    refTick: number | null;
    band: number | null;
  } | null;
  lastDecision: {
    decisionId: string;
    status: DecisionStatus;
    createdAtMs: number;
    summary: string | null;
  } | null;
  pendingApprovals: Array<{ decisionId: string; summary: string; expiresAtMs: number }>;
  /** The lane's latest gate signal (the full preimage: GET /desks/:lane/signals/:decisionId). */
  lastSignal?: {
    decisionId: Hex;
    status: GateSignalStatus;
    regime: RegimeName;
    gates: GateName[];
    gatesMask: number;
    reasonHash: Hex;
    txHash: Hex | null;
    createdAtMs: number;
  } | null;
}

export interface HealthView {
  ok: boolean;
  lastTickAgeMs: number | null;
  lockHeld: boolean;
  pendingExecutions: number;
  nowMs: number;
}

export interface HttpServerHandle {
  port: number;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// Watchdog

export type WatchdogTriggerName =
  | "nav-drop"
  | "rerange-cap"
  | "revert-streak"
  | "foreign-action"
  | "unverified-action"
  | "unverified-stale"
  | "operator-gas"
  | "dead-man"
  | "telegram-pause";

export interface WatchdogThresholds {
  navDropPct: number;
  revertStreak: number;
  /** Trigger when reranges left in the 1 h or 24 h bucket are at or below this. */
  rerangeHeadroom: number;
  operatorReserveWei: bigint;
  deadManMs: number;
  /** An operator action unverified this long while the agent is down → pause (once per action). */
  unverifiedMaxMs: number;
}

export interface WatchdogInput {
  nowMs: number;
  laneAddress: Address;
  paused: boolean;
  hasPositions: boolean;
  /** Fence-valued NAV now and at the last healthy baseline, USD. */
  navUsd: number | null;
  navBaselineUsd: number | null;
  /** NAV change explained by the market (fence price move) since the baseline, USD. */
  navMarketMoveUsd: number | null;
  budgets: LaneBudgets | null;
  consecutiveReverts: number;
  /** Operator LaneActions the agent did not produce (bad decisionId layout, or unknown to its DB). */
  foreignActions: number;
  /** Operator LaneActions the agent could not be asked about (unreachable, 5xx, not configured). */
  unverifiedActions: number;
  /** How long the oldest of them that has not paused the lane yet has waited, ms (null: none). */
  unverifiedForMs: number | null;
  operatorEthWei: bigint | null;
  agentHealth: HealthView | null;
  /** A scheduled action within ±15 min makes the dead-man switch live. */
  scheduledActionAtMs: number | null;
  telegramPauseRequested: boolean;
}

export interface WatchdogVerdict {
  /** "alert": a critical alert and no transaction (only alert-only triggers fired). */
  action: "none" | "alert" | "pause" | "pause_and_exit";
  triggers: Array<{ trigger: WatchdogTriggerName; detail: string }>;
}

/** watchdog/rules.ts: pure. The watchdog can pause and flatten, never unpause. */
export type WatchdogRules = (
  input: WatchdogInput,
  thresholds: WatchdogThresholds,
) => WatchdogVerdict;

// ---------------------------------------------------------------------------------------------
// LLM

export interface LlmRequest {
  system: string;
  user: string;
  maxTokens?: number;
}

/** Minimal LLM seam: production wraps the Anthropic SDK (Bankr gateway); tests inject a fake. */
export interface LlmClient {
  complete(req: LlmRequest): Promise<string>;
}

/** The gateway answered 402: the agent drops to deterministic mode (identity overlay). */
export class LlmCreditsExhausted extends Error {
  constructor(message = "LLM credits exhausted (HTTP 402)", opts: { cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "LlmCreditsExhausted";
  }
}

// ---------------------------------------------------------------------------------------------
// Notifier, clock, logger

export type NotifySeverity = "info" | "warn" | "critical";
export type NotificationKind =
  | "gate-change"
  | "decision"
  | "approval-request"
  | "execution"
  | "safe-mode"
  | "alert"
  | "watchdog"
  | "error";

export interface DeskNotification {
  kind: NotificationKind;
  severity: NotifySeverity;
  lane: Lane | null;
  laneAddress: Address | null;
  title: string;
  lines?: string[];
  decisionId?: string;
  txHash?: Hex;
  dryRun?: boolean;
  /** approval-request only: renders approve / deny buttons. */
  approval?: { decisionId: string; windowSec: number };
}

export interface Notifier {
  /** Never throws into the control loop. */
  notify(n: DeskNotification): Promise<void>;
}

export interface Clock {
  /** Epoch milliseconds. */
  now(): number;
}

export type Sleep = (ms: number) => Promise<void>;

export type LogFn = (obj: unknown, msg?: string) => void;

/** Structural logger: pino satisfies it; tests inject a recorder. */
export interface DeskLogger {
  child(bindings: Record<string, unknown>): DeskLogger;
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
}

// ---------------------------------------------------------------------------------------------
// State (SQLite, schema v2). Row fields are camelCase; `laneAddress` maps to the `lane` column.

export type DeskStatus = "registered" | "active" | "safe_mode" | "revoked" | "disabled";
export type DelegationStatus = "active" | "revoked";
export type WebhookEventStatus = "received" | "processed" | "ignored" | "failed";
export type LaneActionMatch = "matched" | "foreign" | "pending";
export type ApprovalRowStatus = "pending" | "approved" | "denied" | "expired" | "cancelled";

export interface DeskRow {
  laneAddress: Address;
  chainId: number;
  laneId: number;
  owner: Address;
  operator: Address;
  ownerUserId: string | null;
  signerKind: SignerKind;
  mode: DeskMode;
  /** Last accepted nonce of an owner-signed mode change (replay protection). */
  modeNonce: number;
  status: DeskStatus;
  statusDetail: string | null;
  capsJson: string;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface DelegationRow {
  walletId: string;
  userId: string;
  accountAddress: Address;
  chain: string;
  laneAddress: Address | null;
  status: DelegationStatus;
  keyShareCt: string | null;
  apiKeyCt: string | null;
  dekWrapped: string | null;
  kekId: string | null;
  createdEventId: string;
  revokedEventId: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  revokedAtMs: number | null;
}

export interface DelegationRevocationRow {
  eventId: string;
  walletId: string;
  /** The event's own time (envelope timestamp; our first receipt when it carries none). */
  eventAtMs: number;
  recordedAtMs: number;
}

export interface WebhookEventRow {
  eventId: string;
  eventName: string;
  receivedAtMs: number;
  processedAtMs: number | null;
  status: WebhookEventStatus;
  error: string | null;
  payloadSha256: string;
}

/** "new": first delivery; "retry": seen before but never finished (process again); "duplicate": done. */
export type WebhookRecordResult = "new" | "retry" | "duplicate";

export interface TickRow {
  id?: number;
  laneAddress: Address;
  atMs: number;
  blockNumber: number | null;
  blockTs: number | null;
  poolTick: number | null;
  sqrtPriceX96: bigint | null;
  poolMid: number | null;
  hlMid: number | null;
  k: number | null;
  kSource: string | null;
  fairValue: number | null;
  gapBps: number | null;
  refTick: number | null;
  bandTicks: number | null;
  fenceCode: number | null;
  regime: RegimeName;
  reopenKind: ReopenKind | null;
  sessionDate: string;
  gatesMask: number;
  activeGatesJson: string;
  riskMode: RiskMode;
  sourcesJson: string;
}

export interface OverlayRow {
  overlayId: string;
  decisionId: string | null;
  laneAddress: Address;
  createdAtMs: number;
  source: "identity" | "llm";
  proposalJson: string | null;
  criticVerdict: Verdict | null;
  criticReason: string | null;
  tightenOk: boolean;
  tightenDetail: string | null;
  applied: boolean;
  raw: string | null;
  error: string | null;
}

export interface DecisionRow {
  /** The decision's ULID (the on-chain bytes32 id is per step, on the execution row). */
  decisionId: string;
  laneAddress: Address;
  lane: Lane;
  createdAtMs: number;
  updatedAtMs: number;
  regime: RegimeName;
  regimeCode: number;
  gatesMask: number;
  riskMode: RiskMode;
  snapshotJson: string;
  planJson: string;
  overlayId: string | null;
  finalPlanJson: string | null;
  reasonHash: Hex | null;
  reasonPreimage: string | null;
  planCriticVerdict: Verdict | null;
  planCriticReason: string | null;
  guardDecision: GuardDecision | null;
  guardViolationsJson: string | null;
  guardChecksJson: string | null;
  approvalMode: DeskMode | null;
  approvalOutcome: ApprovalOutcome | null;
  approvalChannel: ApprovalChannel | null;
  status: DecisionStatus;
  statusDetail: string | null;
}

export interface ExecutionRow {
  executionId: number;
  decisionId: string;
  stepIndex: number;
  /** bytes32 decisionId of this step (rh venue); null for hl. */
  onchainId: Hex | null;
  laneAddress: Address;
  venue: Venue;
  action: ExecutableActionKind;
  riskClass: RiskClass;
  notionalCents: number;
  signerAddress: Address | null;
  status: ExecutionStatus;
  statusDetail: string | null;
  errorCode: ExecErrorCode | null;
  createdAtMs: number;
  simulatedAtMs: number | null;
  /** Immutable once set (a DB trigger enforces it): turnover counts every signed execution. */
  signedAtMs: number | null;
  broadcastAtMs: number | null;
  finalizedAtMs: number | null;
  updatedAtMs: number;
  txHash: Hex | null;
  gasUsed: bigint | null;
  feeWei: bigint | null;
  feeUsdCents: number | null;
  resultJson: string | null;
}

export type NewExecution = Omit<
  ExecutionRow,
  | "executionId"
  | "simulatedAtMs"
  | "signedAtMs"
  | "broadcastAtMs"
  | "finalizedAtMs"
  | "txHash"
  | "gasUsed"
  | "feeWei"
  | "feeUsdCents"
  | "resultJson"
  | "statusDetail"
  | "errorCode"
> &
  Partial<Pick<ExecutionRow, "statusDetail" | "errorCode" | "resultJson">>;

export interface TxAttemptRow {
  attemptId: number;
  executionId: number;
  attempt: number;
  signerKind: SignerKind;
  fromAddress: Address;
  toAddress: Address;
  calldataHash: Hex;
  nonce: number;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  deadlineSec: number;
  /** Immutable (DB trigger): recovery rebroadcasts these exact bytes and never re-signs. */
  signedRawTx: Hex;
  txHash: Hex;
  status: TxAttemptStatus;
  broadcastCount: number;
  blockNumber: number | null;
  gasUsed: bigint | null;
  feeWei: bigint | null;
  receiptJson: string | null;
  simJson: string | null;
  createdAtMs: number;
  broadcastAtMs: number | null;
  updatedAtMs: number;
}

export type NewTxAttempt = Omit<
  TxAttemptRow,
  | "attemptId"
  | "status"
  | "broadcastCount"
  | "blockNumber"
  | "gasUsed"
  | "feeWei"
  | "receiptJson"
  | "broadcastAtMs"
  | "updatedAtMs"
>;

export interface NonceStateRow {
  signerAddress: Address;
  chainId: number;
  lastNonce: number;
  updatedAtMs: number;
}

export interface HlOrderRow {
  cloid: Hex;
  decisionId: string | null;
  stepIndex: number | null;
  executionId: number | null;
  laneAddress: Address | null;
  coin: string;
  asset: number;
  isBuy: boolean;
  sz: string;
  px: string;
  tif: "Alo" | "Ioc";
  reduceOnly: boolean;
  mode: HlMode;
  status: HlOrderStatus;
  oid: number | null;
  filledSz: string;
  avgPx: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  responseJson: string | null;
}

export interface HlFillRow {
  fillId: number;
  cloid: Hex;
  tid: string;
  coin: string;
  px: string;
  sz: string;
  side: "B" | "A";
  feeUsd: string | null;
  timeMs: number;
  paper: boolean;
  rawJson: string | null;
}

export interface LaneActionRow {
  txHash: Hex;
  logIndex: number;
  laneAddress: Address;
  blockNumber: number;
  blockTs: number | null;
  decisionId: Hex;
  action: number;
  actionName: string;
  ticksJson: string;
  refPxE18: bigint;
  regime: number;
  gatesMask: number;
  reasonHash: Hex;
  caller: Address;
  matchedExecutionId: number | null;
  matchStatus: LaneActionMatch;
  seenAtMs: number;
  matchedAtMs: number | null;
}

export interface ApprovalRow {
  decisionId: string;
  laneAddress: Address;
  summary: string;
  requestedAtMs: number;
  expiresAtMs: number;
  status: ApprovalRowStatus;
  channel: ApprovalChannel | null;
  respondedAtMs: number | null;
  respondedBy: string | null;
  /** Why it was closed without an answer (expired / cancelled); null while pending or answered. */
  closeReason: string | null;
}

/**
 * One gate signal (signal(Meta) LaneAction) the agent planned: the state it announces, and the
 * canonical preimage of its Meta.reasonHash, keyed by the decision ULID (step 0 carries it).
 */
export interface GateSignalRow {
  decisionId: string;
  laneAddress: Address;
  /** The on-chain decisionId (bytes32, step 0). */
  onchainId: Hex;
  /** True while no state was emitted before (from null, source "initial"). Only the lane's very
   * first planned signal skips the minimum dwell. */
  initial: boolean;
  /** `${regimeCode}:${gatesMask}` of the last emitted state; null for the initial signal. */
  fromKey: string | null;
  toKey: string;
  toRegime: RegimeName;
  regimeCode: number;
  gatesMask: number;
  /** The announced active gates (GateName[], canonical JSON). */
  gatesJson: string;
  /** When the announced state began (as observed by this process), ms. */
  atMs: number;
  reasonHash: Hex;
  /** canonical JSON {lane, from, to, at, source}; keccak256(preimageJson) == reasonHash. */
  preimageJson: string;
  createdAtMs: number;
}

/**
 * pending: planned, not settled yet · sent: signed, may still land · confirmed: mined ·
 * failed: signed but reverted, or dropped for a consumed nonce · declined: the owner denied it ·
 * not_sent: never reached the chain (blocked, dry-run, advisory, withdrawn, timed out, or signed
 * bytes that were never sent or expired unmined).
 */
export type GateSignalStatus =
  | "pending"
  | "sent"
  | "confirmed"
  | "failed"
  | "declined"
  | "not_sent";

export interface GateSignalView extends GateSignalRow {
  status: GateSignalStatus;
  decisionStatus: DecisionStatus | null;
  txHash: Hex | null;
}

export interface ParamCacheRow {
  key: string;
  valueJson: string;
  source: string | null;
  fetchedAtMs: number;
  expiresAtMs: number;
}

/** Plan B: a DeltaDesk-held Dynamic server wallet (2-of-2); key shares sealed by the vault. */
export interface ServerWalletRow {
  address: Address;
  walletId: string;
  keySharesCt: string;
  dekWrapped: string;
  kekId: string;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface LockAcquisition {
  acquired: boolean;
  tookOverStaleOwner?: string;
  holderOwner?: string;
  heartbeatAgeMs?: number;
}

export interface LockStatus {
  ownerId: string;
  pid: number;
  host: string;
  acquiredAtMs: number;
  heartbeatMs: number;
}

/** Ticks of one lane in one session, for the self-computed k fallback. */
export interface SessionTickSample {
  atMs: number;
  poolMid: number;
  hlMid: number;
}

type Patch<T, Immutable extends keyof T> = Partial<Omit<T, Immutable>>;

/**
 * The typed repository over the SQLite store. Every method is synchronous (better-sqlite3).
 * Addresses are stored lowercase; lookups normalise their inputs.
 */
export interface DeskDb {
  /** Run `fn` in one SQLite transaction (nested calls become savepoints). */
  transaction<T>(fn: () => T): T;
  schemaVersion(): number;

  // desks
  insertDesk(row: DeskRow): void;
  getDesk(laneAddress: Address): DeskRow | null;
  listDesks(): DeskRow[];
  updateDesk(laneAddress: Address, patch: Patch<DeskRow, "laneAddress" | "createdAtMs">): void;
  /** Owner-signed mode change: applies only if nonce > the stored modeNonce. Returns whether it applied. */
  setDeskMode(laneAddress: Address, mode: DeskMode, nonce: number, nowMs: number): boolean;
  setDeskStatus(
    laneAddress: Address,
    status: DeskStatus,
    detail: string | null,
    nowMs: number,
  ): void;

  // delegations (Dynamic webhook)
  /** delegation.created: insert, or re-activate a previously revoked wallet with fresh ciphertexts. */
  upsertDelegation(row: DelegationRow): void;
  getDelegation(walletId: string): DelegationRow | null;
  /** The active delegation for a wallet address (the Operator), if any. */
  getActiveDelegationByAddress(address: Address): DelegationRow | null;
  /** The most recently updated delegation for a wallet address, active or revoked, if any. */
  latestDelegationByAddress(address: Address): DelegationRow | null;
  listDelegationsByUser(userId: string): DelegationRow[];
  bindDelegationLane(walletId: string, laneAddress: Address, nowMs: number): void;
  /** delegation.revoked: null every ciphertext and mark revoked. Returns whether a row changed. */
  revokeDelegation(walletId: string, revokedEventId: string, nowMs: number): boolean;
  /**
   * A revoke is sticky: recorded per event (even for a wallet we never stored), so a delegation
   * event that is not newer than it can never (re)activate the wallet. Idempotent per eventId.
   */
  recordDelegationRevocation(row: DelegationRevocationRow): void;
  /** The event time of the latest revoke recorded for a wallet, or null. */
  latestDelegationRevocationAt(walletId: string): number | null;
  /** Revoke every active delegation still bound to no lane and created before `beforeMs`. */
  purgeUnboundDelegations(beforeMs: number, nowMs: number): DelegationRow[];

  // webhook events (dedupe on eventId)
  recordWebhookEvent(
    row: Pick<WebhookEventRow, "eventId" | "eventName" | "receivedAtMs" | "payloadSha256">,
  ): WebhookRecordResult;
  finishWebhookEvent(
    eventId: string,
    status: Exclude<WebhookEventStatus, "received">,
    error: string | null,
    nowMs: number,
  ): void;
  getWebhookEvent(eventId: string): WebhookEventRow | null;

  // ticks
  insertTick(row: Omit<TickRow, "id">): number;
  lastTick(laneAddress: Address): TickRow | null;
  /** Ticks with both pool and HL mids for one session date and regime (default REGULAR). */
  sessionTickSamples(
    laneAddress: Address,
    sessionDate: string,
    regime?: RegimeName,
  ): SessionTickSample[];
  pruneTicks(beforeMs: number): number;

  // overlays
  insertOverlay(row: OverlayRow): void;
  getOverlay(overlayId: string): OverlayRow | null;

  // decisions
  insertDecision(row: DecisionRow): void;
  updateDecision(decisionId: string, patch: Patch<DecisionRow, "decisionId" | "createdAtMs">): void;
  getDecision(decisionId: string): DecisionRow | null;
  recentDecisions(n: number, laneAddress?: Address): DecisionRow[];
  decisionsByStatus(statuses: readonly DecisionStatus[]): DecisionRow[];
  /** Crash recovery: resolve decisions stranded in 'executing' from their executions. */
  reconcileOrphanedDecisions(nowMs: number): number;

  // executions (write-ahead)
  /** Throws on a duplicate (decisionId, stepIndex) or onchainId: idempotency is a DB constraint. */
  insertExecution(row: NewExecution): number;
  getExecution(executionId: number): ExecutionRow | null;
  getExecutionByStep(decisionId: string, stepIndex: number): ExecutionRow | null;
  getExecutionByOnchainId(onchainId: Hex): ExecutionRow | null;
  hasExecutionStep(decisionId: string, stepIndex: number): boolean;
  executionsForDecision(decisionId: string): ExecutionRow[];
  executionsByStatus(statuses: readonly ExecutionStatus[]): ExecutionRow[];
  updateExecution(
    executionId: number,
    patch: Patch<ExecutionRow, "executionId" | "decisionId" | "stepIndex" | "createdAtMs">,
  ): void;
  /** Crash recovery: executions that never got a signature (prepared/simulated) become failed. */
  failUnsignedExecutions(detail: string, nowMs: number): number;
  /** FAIL-CLOSED turnover: Σ notional of ADDING executions with signed_at_ms ≥ sinceMs, any status. */
  turnoverCentsSince(laneAddress: Address, sinceMs: number): number;
  /** Adding reranges with a signature since sinceMs (the agent's own rate limit). */
  countSignedAddingReranges(laneAddress: Address, sinceMs: number): number;
  lastSignedAddingRerangeAt(laneAddress: Address): number | null;
  /** Executions of this signer that are in flight (prepared, simulated, signed, broadcast, unknown). */
  inFlightCount(signerAddress: Address): number;
  /** All executions not in a terminal status (for /health). */
  pendingExecutionsCount(): number;
  recentExecutions(n: number, laneAddress?: Address): ExecutionRow[];

  // tx attempts
  /** ONE transaction: insert the attempt (raw bytes, hash) and mark the execution signed. */
  recordSignedAttempt(attempt: NewTxAttempt, nowMs: number): number;
  getAttemptByHash(txHash: Hex): TxAttemptRow | null;
  attemptsForExecution(executionId: number): TxAttemptRow[];
  latestAttempt(executionId: number): TxAttemptRow | null;
  /** Attempts not yet final (signed, broadcast, unknown). */
  unresolvedAttempts(): TxAttemptRow[];
  updateTxAttempt(
    txHash: Hex,
    patch: Patch<
      TxAttemptRow,
      "attemptId" | "executionId" | "attempt" | "signedRawTx" | "txHash" | "nonce" | "createdAtMs"
    >,
  ): void;
  markAttemptBroadcast(txHash: Hex, nowMs: number): void;

  // nonces
  getNonceState(signerAddress: Address): NonceStateRow | null;
  /** Monotonic: never moves the stored nonce backward. Returns the stored value. */
  advanceNonce(signerAddress: Address, chainId: number, nonce: number, nowMs: number): number;
  /** Explicit reset after reconciliation (may move backward). */
  resetNonce(signerAddress: Address, chainId: number, nonce: number, nowMs: number): void;

  // hyperliquid
  insertHlOrder(row: HlOrderRow): void;
  updateHlOrder(cloid: Hex, patch: Patch<HlOrderRow, "cloid" | "createdAtMs">): void;
  getHlOrder(cloid: Hex): HlOrderRow | null;
  openHlOrders(mode: HlMode): HlOrderRow[];
  /** Deduped on (cloid, tid). Returns whether a row was inserted. */
  insertHlFill(row: Omit<HlFillRow, "fillId">): boolean;
  hlFillsForOrder(cloid: Hex): HlFillRow[];
  /** Every fill of one coin in one mode, oldest first (the paper hedge position is their sum). */
  hlFillsByCoin(coin: string, paper: boolean): HlFillRow[];

  // lane actions (reconciler)
  /** Deduped on (txHash, logIndex). Returns whether a row was inserted. */
  insertLaneAction(row: LaneActionRow): boolean;
  setLaneActionMatch(
    txHash: Hex,
    logIndex: number,
    match: LaneActionMatch,
    executionId: number | null,
    nowMs: number,
  ): void;
  laneActionsByMatch(match: LaneActionMatch, laneAddress?: Address): LaneActionRow[];
  recentLaneActions(laneAddress: Address, n: number): LaneActionRow[];

  // approvals (web / telegram / file)
  createApproval(
    row: Pick<
      ApprovalRow,
      "decisionId" | "laneAddress" | "summary" | "requestedAtMs" | "expiresAtMs"
    >,
  ): void;
  getApproval(decisionId: string): ApprovalRow | null;
  /** Applies only while pending and before expiry. Returns whether it applied. */
  respondApproval(
    decisionId: string,
    approved: boolean,
    channel: ApprovalChannel,
    respondedBy: string | null,
    nowMs: number,
  ): boolean;
  /** Pending → expired (or cancelled), with an optional reason. Returns the final row. */
  closeApproval(
    decisionId: string,
    status: "expired" | "cancelled",
    nowMs: number,
    reason?: string,
  ): ApprovalRow | null;
  /**
   * Startup: close EVERY pending approval (no in-memory waiter survives a restart, so none may be
   * answered later): past its window → expired, else cancelled, both with `reason`. The decision
   * still waiting on it (status observed) becomes declined; any other decision still observed
   * (the dead process was building or settling it, nothing signed) becomes failed. Returns the
   * closed rows.
   */
  closeOrphanedApprovals(reason: string, nowMs: number): ApprovalRow[];
  pendingApprovals(laneAddress: Address, nowMs: number): ApprovalRow[];

  // param cache, cursors, cooldowns
  getParam(key: string): ParamCacheRow | null;
  setParam(
    key: string,
    valueJson: string,
    opts: { source: string | null; fetchedAtMs: number; ttlMs: number },
  ): void;
  getCursor(name: string): number | null;
  /** Monotonic: never moves a cursor backward. */
  setCursor(name: string, blockNumber: number, nowMs: number): void;
  /** A veto anchors a per-lane cooldown that survives restarts (monotonic). */
  recordCooldownAnchor(laneAddress: Address, atMs: number): void;
  lastCooldownAnchor(laneAddress: Address): number | null;

  // gate signals (signal(Meta) of a regime / gate change; the reasonHash preimage per decisionId)
  insertGateSignal(row: GateSignalRow): void;
  /** One signal by its decision ULID, with its status derived from the decision and execution. */
  getGateSignal(decisionId: string): GateSignalView | null;
  /** Newest first. */
  recentGateSignals(laneAddress: Address, n: number): GateSignalView[];
  /** The newest signal whose transaction is confirmed or may still land (signed, broadcast, unknown). */
  lastEmittedGateSignal(laneAddress: Address): GateSignalView | null;
  /** signal() executions of this lane with a signature at or after sinceMs (the hourly cap). */
  countSignedSignals(laneAddress: Address, sinceMs: number): number;

  // server wallets (Plan B)
  upsertServerWallet(row: ServerWalletRow): void;
  getServerWallet(address: Address): ServerWalletRow | null;

  // single-instance lock
  acquireDaemonLock(
    owner: { ownerId: string; pid: number; host: string },
    nowMs: number,
    staleMs: number,
  ): LockAcquisition;
  refreshDaemonLock(ownerId: string, nowMs: number): boolean;
  releaseDaemonLock(ownerId: string): void;
  lockStatus(): LockStatus | null;

  close(): void;
}
