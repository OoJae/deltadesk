/**
 * createDaemon(deps): the dependency-injected tick loop (docs/m2-design-agent.md "Tick loop").
 *
 * Per lane, per tick:
 *    1 heartbeat the single-instance lock; LaneAction reconciliation if due; settle this signer's
 *      in-flight attempts (the resolver rebroadcasts stored bytes, never re-signs)
 *    2 sense (one block-pinned snapshot), insert a `ticks` row
 *    3 regime: freshness → gate triggers → gate machine (immediate on, dwell off) → risk mode
 *    4 strategy → a DeskPlan; a lone `hold` ends the tick with no decision row
 *    5 overlay (identity in M2; an LLM overlay is only ever tighten-only)
 *    6 plan critic (deterministic; a throw is a REJECT)
 *    7 build and simulate every step (executor.prepare)
 *    8 guard every step (pure, fail-closed; dry-run last) → decision row, reason hash
 *    9 approval (advisory / copilot / autopilot; risk-reducing never waits). The tick never waits
 *      for a human: an answer that is not already there leaves the decision pending, the tick
 *      returns, and later ticks keep sensing. A later tick executes it once approved, or a
 *      risk-reducing plan (HALT → exitAll) withdraws it and runs at once.
 *   10 execute, strictly in order: each step is re-prepared with its final Meta and re-guarded
 *      immediately before execute. A risk-adding step whose snapshot aged is re-sensed and the
 *      plan critic re-run on that snapshot, so "centre on F" holds when it signs, not only when it
 *      was planned.
 *   11 notify, 12 record
 *
 * Fail-closed choices, in one place:
 * - Nothing reaches an executor without a guard verdict of `execute` for that exact step (final
 *   Meta, fresh simulation). The executor then re-checks idempotency and single-in-flight atomically
 *   with its write-ahead row, re-encodes the call from config and verifies the signed bytes.
 * - A desk in `safe_mode` runs as advisory; `revoked` never executes; `disabled` is not ticked.
 *   The desk row is re-read before every step, so a foreign LaneAction or a revocation that lands
 *   mid-decision stops the remaining steps (and the executor re-reads it right before a
 *   risk-adding step signs and before it broadcasts).
 * - Deadlines follow the lane's on-chain maxDeadlineAhead: an owner who tightens it never locks
 *   the agent out of an exit; a cap with no valid window at all is alerted, not silently blocked.
 * - A decision that did not execute holds its risk class for a while (no re-proposal every 5 s);
 *   a human veto anchors a per-lane cooldown in the DB that survives restarts.
 * - Losing the daemon lock stops the loop: two daemons on one DB would mint separate decisionIds.
 */

import { keccak256, stringToBytes } from "viem";
import { planCritic as defaultPlanCritic } from "./agents/plan-critic.js";
import {
  type ApprovalDecision,
  decideApproval,
  effectiveMode,
  noopApprovalGate,
} from "./approval/gate.js";
import { canonicalJson, reasonHashOf } from "./canonical.js";
import { type AppConfig, effectiveRerangeLimits, guardLimitsFrom } from "./config.js";
import { OPERATOR_SELECTOR_SET } from "./executor/abi/DeskLane.js";
import { createDecisionUlidFactory, encodeDecisionId } from "./executor/decision-id.js";
import { createFeePolicy, gasLimitFor } from "./executor/fees.js";
import { checkGuard } from "./guard/guard.js";
import { riskModel as defaultRiskModel } from "./guard/risk.js";
import { resolveOverlay } from "./overlay/apply.js";
import type { AttemptResolver } from "./reconcile/startup.js";
import { computeRegime, defaultRegimeDeps, type RegimeDeps } from "./regime/index.js";
import { laneStrategy } from "./strategy/lanes.js";
import {
  type Address,
  type ApprovalGate,
  type ChainRead,
  type Clock,
  type CriticVerdict,
  type DecisionStatus,
  type DeskAction,
  type DeskDb,
  type DeskLogger,
  type DeskMode,
  type DeskNotification,
  type DeskPlan,
  type DeskSnapshot,
  type Executor,
  type GuardCheck,
  type GuardFn,
  type GuardInput,
  type GuardLimits,
  type GuardResult,
  type HedgeEngine,
  type Hex,
  HL_NVDA_COIN,
  type HourRecord,
  type Lane,
  type LaneCaps,
  type LaneState,
  type Meta,
  type Notifier,
  type OverlayApplier,
  type OverlayCritic,
  type OverlayPlanner,
  type PlanCritic,
  type PlanCriticResult,
  type PreparedStep,
  type RegimeState,
  type RiskClass,
  type RiskModel,
  riskClassOf,
  type Sensor,
  type StepOutcome,
  type StepRequest,
  type Strategy,
  type TxSigner,
} from "./types.js";

export type { Clock, DeskLogger, LaneState, Notifier, Sensor, Strategy } from "./types.js";

type ExecutableAction = Exclude<DeskAction, { kind: "hold" }>;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const ZERO_HASH: Hex = `0x${"0".repeat(64)}`;

/** One lane as the daemon runs it: the lane's operator signer, its sensor and its 4663 executor. */
export interface LaneRuntime {
  lane: Lane;
  laneAddress: Address;
  /** Reads snapshots with this lane's operator as the signer (provenance, eth_call `from`). */
  sensor: Sensor;
  /** The lane's OPERATOR (never its owner). */
  signer: TxSigner;
  /** Bound to this lane: the only `to` it can produce comes from config / the desks table. */
  executor: Executor;
}

export interface DaemonOptions {
  /** Hold a risk-adding proposal this long after one that did not execute. Default: the lane's
   * effective minimum rerange interval (config, clamped by the on-chain caps). */
  addingRetryMs?: number;
  /** Hold a risk-reducing proposal this long after one that did not execute. Default 30 s. */
  reducingRetryMs?: number;
  /** A human veto (denial, timeout, cancel) holds risk-adding this long. Default 15 min. */
  vetoCooldownMs?: number;
  /** Identical non-critical notifications are sent at most this often. Default 15 min. */
  notifyThrottleMs?: number;
  /** Alert after this many consecutive ticks without a snapshot. Default 3. */
  blindAlertTicks?: number;
  /** stop() waits this long for an in-flight tick. Default 20 s. */
  stopGraceMs?: number;
}

export interface DaemonDeps {
  config: AppConfig;
  db: DeskDb;
  /** The lanes to run, re-read every tick (desks registered through the web API appear here). */
  lanes: () => readonly LaneRuntime[];
  /** On-chain idempotency: IDeskLane.decisionUsedAt at the latest block. */
  decisionUsedAt: (laneAddress: Address, decisionId: Hex) => Promise<bigint>;
  notifier: Notifier;
  logger: DeskLogger;
  clock: Clock;
  strategy?: Strategy;
  planCritic?: PlanCritic;
  /** The LLM overlay (M3). Absent or disabled in config: the identity overlay. */
  overlay?: {
    planner: OverlayPlanner | null;
    critic: OverlayCritic | null;
    applier?: OverlayApplier;
  };
  guard?: GuardFn;
  risk?: RiskModel;
  regime?: RegimeDeps;
  approvalGate?: ApprovalGate;
  /** The engine's hour-of-week record for the cost hurdle. */
  hourRecord?: (how: number) => Promise<HourRecord | null>;
  /** Lane B's paper hedge (hedge/engine.ts) and the HL executor it runs through. */
  hedge?: HedgeEngine | null;
  hlExecutor?: Executor | null;
  /** Settles unresolved attempts (reconcile/startup.ts). Runs inside the tick, never beside it. */
  resolver?: Pick<AttemptResolver, "resolveAll"> | null;
  /** Tick step 1 "reconcile if due" (the same loop main.ts also runs on its own timer). */
  reconcile?: Pick<ReconcileLoop, "runIfDue"> | null;
  /** The daemon lock this process holds; heartbeated on its own timer and at every tick. */
  lock?: { ownerId: string; onLost?: () => void } | null;
  /** Uniform [0,1) for the strategy's rerange jitter. */
  random?: () => number;
  newDecisionId?: (nowMs: number) => string;
  options?: DaemonOptions;
}

export type LaneTickOutcome =
  | { kind: "skipped"; reason: string }
  | { kind: "blind"; reason: string }
  | { kind: "hold"; reason: string }
  | { kind: "awaiting_approval"; decisionId: string; reason: string }
  | { kind: "decision"; decisionId: string; status: DecisionStatus; detail: string | null };

export interface TickReport {
  atMs: number;
  lanes: Array<{ lane: Lane; laneAddress: Address; outcome: LaneTickOutcome }>;
}

export interface Daemon {
  /** One pass over every lane. Never throws for a lane failure (logged, the next lane runs). */
  runTick(): Promise<TickReport>;
  start(): void;
  stop(): Promise<void>;
  laneState(laneAddress: Address): LaneState | null;
}

// ---------------------------------------------------------------------------------------------
// Helpers

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const lower = (a: string): Address => a.toLowerCase() as Address;

/** Deep copy with non-finite numbers replaced by null (canonical JSON rejects them). */
function finiteOnly(value: unknown): unknown {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(finiteOnly);
  if (value !== null && typeof value === "object" && !(value instanceof Uint8Array)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = finiteOnly(v);
    return out;
  }
  return value;
}

/** Canonical JSON for the evidence columns, never throwing on a stray NaN. */
export function evidenceJson(value: unknown): string {
  try {
    return canonicalJson(value);
  } catch {
    return canonicalJson(finiteOnly(value));
  }
}

const finiteOrNull = (x: number | null | undefined): number | null =>
  x === null || x === undefined || !Number.isFinite(x) ? null : x;

/** The DeskPlan fields of a strategy plan (a LanePlan also carries tick-to-tick state). */
function deskPlanOf(plan: DeskPlan): DeskPlan {
  return {
    lane: plan.lane,
    laneAddress: plan.laneAddress,
    createdAtMs: plan.createdAtMs,
    riskMode: plan.riskMode,
    actions: plan.actions,
    rationale: plan.rationale,
    trigger: plan.trigger,
    hurdle: plan.hurdle,
    metrics: plan.metrics,
    notionalCents: plan.notionalCents,
  };
}

function carryOf(
  plan: DeskPlan,
): { outsideInnerTicks: number; rerangeNotBeforeMs: number | null } | null {
  const c = (plan as { carry?: unknown }).carry;
  if (c === null || typeof c !== "object") return null;
  const { outsideInnerTicks, rerangeNotBeforeMs } = c as Record<string, unknown>;
  if (typeof outsideInnerTicks !== "number") return null;
  return {
    outsideInnerTicks,
    rerangeNotBeforeMs: typeof rerangeNotBeforeMs === "number" ? rerangeNotBeforeMs : null,
  };
}

const executable = (plan: DeskPlan): ExecutableAction[] =>
  plan.actions.filter((a): a is ExecutableAction => a.kind !== "hold");

function summarize(actions: readonly DeskAction[], notionalCents: number): string {
  const usd = Number.isFinite(notionalCents) ? ` ≈ $${(notionalCents / 100).toFixed(2)}` : "";
  return actions
    .map((a) => {
      switch (a.kind) {
        case "rerange":
          // Never the ticks: placements are not published ahead of execution.
          return a.ranges.length === 0
            ? "unwind and hold"
            : `rerange into ${a.ranges.length} range(s)${usd}`;
        case "reduce":
          return `reduce slot ${a.slot}`;
        case "collect":
          return "collect fees";
        case "exitAll":
          return "exit every position";
        case "pause":
          return "pause the lane";
        case "signal":
          return "signal";
        case "hedge":
          return `paper hedge ${a.isBuy ? "buy" : "sell"} ${a.sz} ${a.coin} @ ${a.px}`;
        case "hold":
          return `hold (${a.reason})`;
        default: {
          const unreachable: never = a;
          return String(unreachable);
        }
      }
    })
    .join(", ");
}

/** The guard's static limits; without a chain read, config alone (every on-chain rule fails anyway). */
export function limitsFor(cfg: AppConfig, caps: LaneCaps | null): GuardLimits {
  if (caps !== null) return guardLimitsFrom(cfg, caps);
  return {
    chainId: cfg.chainId,
    tickSpacing: cfg.strategy.tickSpacing,
    maxActionCents: cfg.limits.maxActionCents,
    dailyTurnoverCents: cfg.limits.dailyTurnoverCents,
    gasReserveWei: cfg.limits.gasReserveWei,
    maxSnapshotAgeMs: cfg.timing.snapshotMaxAgeMs,
    maxSimBlockAge: cfg.timing.simMaxBlockAge,
    deadlineMinAheadSec: cfg.timing.deadlineMinAheadSec,
    deadlineMaxAheadSec: cfg.timing.deadlineMaxAheadSec,
    hurdleMultiple: cfg.strategy.hurdleMultiple,
    agentReranges: { ...cfg.reranges },
  };
}

function blockedResult(detail: string): GuardResult {
  return {
    decision: "blocked",
    violations: [{ rule: "action-none", detail }],
    checks: [{ rule: "action-none", passed: false, detail }],
    reason: `blocked by action-none: ${detail}`,
  };
}

// ---------------------------------------------------------------------------------------------
// Reconcile loop (LaneAction reconciliation every 30 s; main.ts starts it, the tick may run it)

export interface ReconcileTask {
  name: string;
  run(nowMs: number): Promise<unknown>;
}

export interface ReconcileLoop {
  /** Run every task if the interval has passed; joins a run already in progress. */
  runIfDue(nowMs: number): Promise<void>;
  runNow(): Promise<void>;
  start(): void;
  stop(): Promise<void>;
}

export function createReconcileLoop(deps: {
  tasks: readonly ReconcileTask[];
  intervalMs: number;
  clock: Clock;
  logger: DeskLogger;
}): ReconcileLoop {
  let lastRunMs: number | null = null;
  let running: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopping = false;

  function runAll(): Promise<void> {
    if (running !== null) return running;
    const nowMs = deps.clock.now();
    lastRunMs = nowMs;
    running = (async () => {
      for (const t of deps.tasks) {
        try {
          await t.run(nowMs);
        } catch (err) {
          deps.logger.warn({ task: t.name, error: errText(err) }, "reconcile task failed");
        }
      }
    })().finally(() => {
      running = null;
    });
    return running;
  }

  const loop: ReconcileLoop = {
    async runIfDue(nowMs) {
      if (running !== null) return running;
      if (lastRunMs !== null && nowMs - lastRunMs < deps.intervalMs) return;
      return runAll();
    },
    runNow: runAll,
    start() {
      if (timer !== null || stopping) return;
      const next = () => {
        timer = setTimeout(() => {
          void runAll().finally(() => {
            if (!stopping) next();
          });
        }, deps.intervalMs);
      };
      void runAll().finally(() => {
        if (!stopping) next();
      });
    },
    async stop() {
      stopping = true;
      if (timer !== null) clearTimeout(timer);
      if (running !== null) await running;
    },
  };
  return loop;
}

// ---------------------------------------------------------------------------------------------
// The daemon

interface LaneExtra {
  addingHoldUntilMs: number;
  reducingHoldUntilMs: number;
  holdReason: string;
  blindTicks: number;
}

interface BuiltStep {
  index: number;
  action: ExecutableAction;
  riskClass: RiskClass;
  executor: Executor;
  request: StepRequest;
  prepared: PreparedStep | null;
  prepareError: string | null;
  notionalCents: number;
  guard: GuardResult;
}

interface DecisionContext {
  rt: LaneRuntime;
  decisionId: string;
  snapshot: DeskSnapshot;
  regime: RegimeState;
  deterministic: DeskPlan;
  final: DeskPlan;
  critic: CriticVerdict;
  overlay: Awaited<ReturnType<typeof resolveOverlay>>;
}

/** A guarded decision between its approval request and the answer (or its withdrawal). */
interface PendingDecision {
  ctx: DecisionContext;
  built: BuiltStep[];
  reasonHash: Hex;
  adding: boolean;
  summary: string;
  mode: DeskMode;
  safeMode: boolean;
  safeModeDetail: string | null;
  /** The daemon's own backstop: past this, silence is a timeout even if the gate never answers. */
  expiresAtMs: number;
  answer: ApprovalDecision | null;
  /** Withdrawn (preempted, expired, stopped): the gate's late answer is ignored, never a veto. */
  withdrawn: boolean;
  log: DeskLogger;
}

/** The snapshot and regime a later tick sensed; the execution step starts from them. */
interface FreshView {
  snapshot: DeskSnapshot;
  regime: RegimeState;
}

/** Resolves after the current macrotask: an approval answer is taken only if already there. */
const nextTurn = (): Promise<null> => new Promise((r) => setImmediate(() => r(null)));

const FAIL_CLOSED_ANSWER: ApprovalDecision = {
  execute: false,
  outcome: "timeout",
  channel: null,
  status: "declined",
};

export function createDaemon(deps: DaemonDeps): Daemon {
  const { config: cfg, db, logger, clock } = deps;
  const strategy = deps.strategy ?? laneStrategy;
  const critic = deps.planCritic ?? defaultPlanCritic;
  const guard = deps.guard ?? checkGuard;
  const risk = deps.risk ?? defaultRiskModel;
  const regimeDeps = deps.regime ?? defaultRegimeDeps;
  const gate = deps.approvalGate ?? noopApprovalGate;
  const random = deps.random ?? Math.random;
  const newDecisionId = deps.newDecisionId ?? createDecisionUlidFactory();
  const opts = deps.options ?? {};
  const reducingRetryMs = opts.reducingRetryMs ?? 30_000;
  const vetoCooldownMs = opts.vetoCooldownMs ?? 15 * 60_000;
  const throttleMs = opts.notifyThrottleMs ?? 15 * 60_000;
  const blindAlertTicks = opts.blindAlertTicks ?? 3;
  const stopGraceMs = opts.stopGraceMs ?? 20_000;
  const fees = createFeePolicy({
    floorWei: cfg.limits.feeFloorWei,
    capWei: cfg.limits.maxFeePerGasWei,
  });
  const overlayWired =
    cfg.llm.overlayEnabled &&
    cfg.capabilities.llm &&
    deps.overlay?.planner !== null &&
    deps.overlay?.planner !== undefined &&
    deps.overlay.critic !== null &&
    deps.overlay.critic !== undefined;

  const states = new Map<string, LaneState>();
  const extras = new Map<string, LaneExtra>();
  /** At most one decision per lane awaiting a human answer. */
  const pendings = new Map<string, PendingDecision>();
  const lastNotified = new Map<string, number>();
  let lastPruneMs = 0;
  let lockLost = false;
  let stopping = false;
  let started = false;
  let inFlight: Promise<unknown> | null = null;
  let tickTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;

  const flags = {
    armed: cfg.safety.armed,
    dryRun: cfg.safety.dryRun,
    hlMode: cfg.hl.mode,
    hlArmed: cfg.hl.armed,
  } as const;

  async function safeNotify(n: DeskNotification): Promise<void> {
    try {
      await deps.notifier.notify(n);
    } catch (err) {
      logger.warn({ error: errText(err), kind: n.kind }, "notifier failed");
    }
  }

  /** Identical non-critical notifications at most once per throttle window (`always`: critical too). */
  async function notifyOnce(
    key: string,
    n: DeskNotification,
    throttle: "non-critical" | "always" = "non-critical",
  ): Promise<void> {
    const now = clock.now();
    const last = lastNotified.get(key);
    const throttled = throttle === "always" || n.severity !== "critical";
    if (throttled && last !== undefined && now - last < throttleMs) return;
    lastNotified.set(key, now);
    await safeNotify(n);
  }

  function heartbeat(): boolean {
    if (deps.lock === null || deps.lock === undefined || lockLost) return !lockLost;
    let ok = false;
    try {
      ok = db.refreshDaemonLock(deps.lock.ownerId, clock.now());
    } catch (err) {
      logger.error({ error: errText(err) }, "daemon lock heartbeat failed");
    }
    if (!ok) {
      lockLost = true;
      stopping = true;
      logger.error({}, "daemon lock lost: another instance holds it; stopping the loop");
      void safeNotify({
        kind: "error",
        severity: "critical",
        lane: null,
        laneAddress: null,
        title: "Daemon lock lost: this instance stopped acting",
        lines: ["Another desk-agent took the single-instance lock. Check for a second process."],
      });
      deps.lock.onLost?.();
    }
    return ok;
  }

  function stateOf(rt: LaneRuntime, nowMs: number): LaneState {
    const key = lower(rt.laneAddress);
    let s = states.get(key);
    if (s === undefined) {
      s = {
        lane: rt.lane,
        laneAddress: key,
        gates: regimeDeps.machine.initial(nowMs),
        outsideInnerTicks: 0,
        rerangeNotBeforeMs: null,
        safeMode: null,
        lastTickAtMs: null,
        lastDecisionId: null,
        brain: overlayWired ? "llm" : "deterministic",
      };
      states.set(key, s);
    }
    return s;
  }

  function extraOf(laneAddress: Address): LaneExtra {
    const key = lower(laneAddress);
    let e = extras.get(key);
    if (e === undefined) {
      e = { addingHoldUntilMs: 0, reducingHoldUntilMs: 0, holdReason: "", blindTicks: 0 };
      extras.set(key, e);
    }
    return e;
  }

  function agentRerange(laneAddress: Address, caps: LaneCaps | null, nowMs: number) {
    const lim = caps === null ? cfg.reranges : effectiveRerangeLimits(cfg, caps);
    return {
      lastRerangeAtMs: db.lastSignedAddingRerangeAt(laneAddress),
      count1h: db.countSignedAddingReranges(laneAddress, nowMs - HOUR_MS),
      count24h: db.countSignedAddingReranges(laneAddress, nowMs - DAY_MS),
      maxPerHour: lim.perHour,
      maxPerDay: lim.perDay,
      minIntervalMs: lim.minIntervalSec * 1000,
    };
  }

  function addingRetryMs(caps: LaneCaps | null): number {
    if (opts.addingRetryMs !== undefined) return opts.addingRetryMs;
    const lim = caps === null ? cfg.reranges : effectiveRerangeLimits(cfg, caps);
    return lim.minIntervalSec * 1000;
  }

  function recordTick(snapshot: DeskSnapshot, regime: RegimeState): void {
    const chain = snapshot.chain;
    const fv = snapshot.fairValue;
    try {
      db.insertTick({
        laneAddress: snapshot.laneAddress,
        atMs: snapshot.takenAtMs,
        blockNumber: chain === null ? null : Number(chain.blockNumber),
        blockTs: chain === null ? null : Number(chain.blockTimestamp),
        poolTick: chain?.pool.tick ?? null,
        sqrtPriceX96: chain?.pool.sqrtPriceX96 ?? null,
        poolMid: finiteOrNull(fv?.poolMid),
        hlMid: finiteOrNull(snapshot.hl?.mid),
        k: finiteOrNull(snapshot.k?.k),
        kSource: snapshot.k?.source ?? null,
        fairValue: finiteOrNull(fv?.F),
        gapBps: finiteOrNull(fv?.gapBps),
        refTick: chain?.lane.refTick.tick ?? null,
        bandTicks: chain?.lane.refTick.bandTicks ?? null,
        fenceCode: chain?.lane.riskAddingOpen.code ?? null,
        regime: snapshot.calendar.name,
        reopenKind: snapshot.calendar.reopenKind,
        sessionDate: snapshot.calendar.sessionDate,
        gatesMask: regime.gatesMask,
        activeGatesJson: canonicalJson(regime.activeGates),
        riskMode: regime.riskMode,
        sourcesJson: evidenceJson(snapshot.sources),
      });
    } catch (err) {
      logger.warn({ lane: snapshot.laneAddress, error: errText(err) }, "tick row not recorded");
    }
    const now = clock.now();
    if (now - lastPruneMs > HOUR_MS) {
      lastPruneMs = now;
      try {
        db.pruneTicks(now - cfg.timing.tickRetentionMs);
      } catch (err) {
        logger.warn({ error: errText(err) }, "tick pruning failed");
      }
    }
  }

  function estimatedGasCostWei(step: PreparedStep | null, chain: ChainRead | null): bigint | null {
    const est = step?.simulation?.gasEstimate ?? null;
    if (est === null || chain === null) return null;
    try {
      const q = fees.quote({
        number: chain.blockNumber,
        timestamp: chain.blockTimestamp,
        hash: chain.blockHash,
        baseFeePerGas: chain.baseFeePerGas,
      });
      return gasLimitFor(est) * q.maxFeePerGas;
    } catch {
      return null; // GAS_CAP: unknown cost fails a risk-adding step's gas rule
    }
  }

  async function usedAtOf(action: ExecutableAction, laneAddress: Address, meta: Meta) {
    if (action.kind === "hedge") return null;
    if (action.kind === "pause") return 0n; // pause() takes no Meta
    try {
      return await deps.decisionUsedAt(laneAddress, meta.decisionId);
    } catch (err) {
      logger.warn({ error: errText(err) }, "decisionUsedAt read failed (fail-closed)");
      return null;
    }
  }

  /** Seconds ahead for Meta.deadline: config, clamped by the lane's on-chain maxDeadlineAhead. */
  function deadlineAheadSec(caps: LaneCaps | null): number {
    const cap = Math.min(cfg.timing.deadlineMaxAheadSec, caps?.maxDeadlineAhead ?? Infinity);
    return Math.min(cfg.timing.deadlineSec, cap);
  }

  function metaFor(
    ctx: DecisionContext,
    index: number,
    reasonHash: Hex,
    nowMs: number,
    caps: LaneCaps | null,
  ): Meta {
    return {
      decisionId: encodeDecisionId(ctx.decisionId, index),
      deadline: BigInt(Math.floor(nowMs / 1000) + deadlineAheadSec(caps)),
      regime: ctx.regime.regimeCode,
      gatesMask: ctx.regime.gatesMask,
      reasonHash,
    };
  }

  /** The plan critic on the snapshot an approved plan will actually sign on (a throw is a REJECT). */
  function critiqueAtExecution(
    ctx: DecisionContext,
    snapshot: DeskSnapshot,
    regime: RegimeState,
  ): CriticVerdict {
    try {
      const r = critic.critique({
        snapshot,
        regime,
        plan: ctx.final,
        params: cfg.strategy,
        nowMs: clock.now(),
        stage: "execution",
      });
      return { verdict: r.verdict, reason: `at execution: ${r.reason}` };
    } catch (err) {
      return {
        verdict: "REJECT",
        reason: `plan critic threw at execution: ${errText(err)} (fail-closed)`,
      };
    }
  }

  async function guardStep(
    ctx: DecisionContext,
    index: number,
    action: ExecutableAction,
    prepared: PreparedStep | null,
    meta: Meta,
    snapshot: DeskSnapshot,
    regime: RegimeState,
    planCritic: CriticVerdict = ctx.critic,
  ): Promise<{ result: GuardResult; notionalCents: number }> {
    const { rt } = ctx;
    const chain = snapshot.chain;
    const nowMs = clock.now();
    let notionalCents = Number.NaN;
    try {
      notionalCents = risk.notionalCents(action, snapshot, prepared?.simulation ?? null);
    } catch (err) {
      logger.warn({ error: errText(err) }, "notional valuation threw (fail-closed)");
    }
    const input: GuardInput = {
      decisionId: ctx.decisionId,
      step: index,
      action,
      riskClass: riskClassOf(action),
      meta: action.kind === "hedge" ? null : meta,
      expected: {
        lane: rt.lane,
        laneAddress: rt.laneAddress,
        chainId: cfg.chainId,
        signerAddress: rt.signer.address,
      },
      snapshot,
      regime,
      plans: { deterministic: ctx.deterministic, final: ctx.final },
      planCritic,
      overlay: ctx.overlay.record,
      llmStrings: ctx.overlay.llmStrings,
      tx: prepared?.call ?? null,
      operatorSelectors: OPERATOR_SELECTOR_SET,
      notionalCents,
      limits: limitsFor(cfg, chain?.lane.caps ?? null),
      flags,
      turnoverDbCents24h: db.turnoverCentsSince(rt.laneAddress, nowMs - DAY_MS),
      idempotency: {
        dbHasStep: db.hasExecutionStep(ctx.decisionId, index),
        onchainDecisionUsedAt: await usedAtOf(action, rt.laneAddress, meta),
      },
      freshness: regime.freshness,
      agentRerange: agentRerange(rt.laneAddress, chain?.lane.caps ?? null, nowMs),
      hurdle: ctx.final.hurdle,
      simulation: prepared?.simulation ?? null,
      estimatedGasCostWei: estimatedGasCostWei(prepared, chain),
      inFlight: action.kind === "hedge" ? 0 : db.inFlightCount(rt.signer.address),
      nowMs,
    };
    let result: GuardResult;
    try {
      result = guard(input);
    } catch (err) {
      result = blockedResult(`guard threw: ${errText(err)} (fail-closed)`);
    }
    return { result, notionalCents };
  }

  function executorFor(rt: LaneRuntime, action: ExecutableAction): Executor | null {
    return action.kind === "hedge" ? (deps.hlExecutor ?? null) : rt.executor;
  }

  async function prepareStep(
    executor: Executor,
    req: StepRequest,
  ): Promise<{ prepared: PreparedStep | null; error: string | null }> {
    try {
      return { prepared: await executor.prepare(req), error: null };
    } catch (err) {
      return { prepared: null, error: errText(err) };
    }
  }

  /** Lane B: a paper hedge plan when the lane otherwise holds and no paper order is resting. */
  function hedgePlan(rt: LaneRuntime, plan: DeskPlan, snapshot: DeskSnapshot, nowMs: number) {
    if (rt.lane !== "B" || deps.hedge == null || deps.hlExecutor == null) return plan;
    if (executable(plan).length > 0) return plan;
    const resting = db
      .openHlOrders(cfg.hl.mode)
      .some((o) => o.laneAddress !== null && lower(o.laneAddress) === lower(rt.laneAddress));
    if (resting) return plan;
    const position = db
      .hlFillsByCoin(HL_NVDA_COIN, cfg.hl.mode === "paper")
      .reduce((p, f) => p + (f.side === "B" ? 1 : -1) * Number(f.sz), 0);
    const step = deps.hedge.step({ snapshot, paperPosition: position, nowMs });
    const state = step.state;
    // Outside `normal` only a hedge that shrinks the paper position may go out.
    const actions = step.actions.filter(
      (a) => plan.riskMode === "normal" || riskClassOf(a) !== "adding",
    );
    if (actions.length === 0) return plan;
    let notionalCents = 0;
    for (const a of actions) notionalCents += risk.notionalCents(a, snapshot, null) || 0;
    return {
      ...deskPlanOf(plan),
      actions,
      rationale: [
        ...plan.rationale,
        `paper hedge: Δ ${state.delta.toFixed(4)}, H* ${state.target.toFixed(4)}, position ${state.position.toFixed(4)}, τ ${state.tau.toFixed(4)}`,
      ],
      notionalCents,
    };
  }

  function finish(
    ctx: DecisionContext,
    status: DecisionStatus,
    detail: string | null,
  ): LaneTickOutcome {
    try {
      db.updateDecision(ctx.decisionId, { status, statusDetail: detail, updatedAtMs: clock.now() });
    } catch (err) {
      logger.error({ decisionId: ctx.decisionId, error: errText(err) }, "decision update failed");
    }
    return { kind: "decision", decisionId: ctx.decisionId, status, detail };
  }

  /** Hold this risk class for a while after a decision that did not execute. */
  function holdAfter(
    rt: LaneRuntime,
    adding: boolean,
    status: DecisionStatus,
    caps: LaneCaps | null,
  ) {
    const e = extraOf(rt.laneAddress);
    const now = clock.now();
    if (adding) e.addingHoldUntilMs = now + addingRetryMs(caps);
    else e.reducingHoldUntilMs = now + reducingRetryMs;
    e.holdReason = status;
  }

  async function laneTick(rt: LaneRuntime): Promise<LaneTickOutcome> {
    const key = lower(rt.laneAddress);
    const desk = db.getDesk(rt.laneAddress);
    if (desk?.status === "disabled") return { kind: "skipped", reason: "desk disabled" };
    const log = logger.child({ lane: rt.lane, laneAddress: key });
    const extra = extraOf(rt.laneAddress);

    // 1. Settle this signer's in-flight attempts first: an unknown tx blocks every step anyway.
    if (deps.resolver != null && db.inFlightCount(rt.signer.address) > 0) {
      try {
        await deps.resolver.resolveAll(clock.now());
        db.reconcileOrphanedDecisions(clock.now());
      } catch (err) {
        log.warn({ error: errText(err) }, "in-flight resolution failed");
      }
    }

    // 2. Sense
    let snapshot: DeskSnapshot;
    try {
      snapshot = await rt.sensor.read(rt.lane, rt.laneAddress);
    } catch (err) {
      extra.blindTicks += 1;
      log.error({ error: errText(err), blindTicks: extra.blindTicks }, "sensor read failed");
      if (extra.blindTicks === blindAlertTicks) {
        await safeNotify({
          kind: "alert",
          severity: "critical",
          lane: rt.lane,
          laneAddress: rt.laneAddress,
          title: `Blind for ${extra.blindTicks} ticks: the lane is unwatched`,
          lines: [errText(err)],
        });
      }
      return { kind: "blind", reason: errText(err) };
    }
    extra.blindTicks = 0;
    const nowMs = clock.now();
    const state = stateOf(rt, nowMs);

    // 3. Regime
    const regime = computeRegime(regimeDeps, snapshot, state.gates, nowMs);
    state.gates = regime.gates;
    state.lastTickAtMs = nowMs;
    state.safeMode =
      desk?.status === "safe_mode"
        ? { reason: desk.statusDetail ?? "safe mode", sinceMs: desk.updatedAtMs }
        : null;
    recordTick(snapshot, regime);
    if (regime.transitions.length > 0) {
      const on = regime.transitions.filter((t) => t.active);
      await safeNotify({
        kind: "gate-change",
        severity: on.some((t) => t.gate === "HALT") ? "critical" : on.length > 0 ? "warn" : "info",
        lane: rt.lane,
        laneAddress: rt.laneAddress,
        title: `Gates: ${regime.transitions.map((t) => `${t.gate} ${t.active ? "on" : "off"}`).join(", ")}`,
        lines: [
          ...regime.transitions.map((t) => `${t.gate}: ${t.reason}`),
          `risk mode ${regime.riskMode}`,
        ],
      });
    }

    // 4. Strategy
    let hourRecord: HourRecord | null = null;
    if (deps.hourRecord !== undefined) {
      try {
        hourRecord = await deps.hourRecord(snapshot.calendar.how);
      } catch (err) {
        log.debug({ error: errText(err) }, "hour-of-week record unavailable");
      }
    }
    let plan: DeskPlan;
    try {
      plan = strategy.plan({
        lane: rt.lane,
        snapshot,
        regime,
        laneState: state,
        params: cfg.strategy,
        agentRerange: agentRerange(rt.laneAddress, snapshot.chain?.lane.caps ?? null, nowMs),
        hourRecord,
        gasQuote: null,
        nowMs,
        random,
      });
    } catch (err) {
      log.error({ error: errText(err) }, "strategy threw; holding");
      return { kind: "hold", reason: `strategy threw: ${errText(err)}` };
    }
    const carry = carryOf(plan);
    if (carry !== null) {
      state.outsideInnerTicks = carry.outsideInnerTicks;
      state.rerangeNotBeforeMs = carry.rerangeNotBeforeMs;
    }
    plan = hedgePlan(rt, deskPlanOf(plan), snapshot, nowMs);
    const awaiting = await pendingTick(rt, plan, { snapshot, regime }, nowMs);
    if (awaiting !== null) return awaiting;
    const steps0 = executable(plan);
    if (steps0.length === 0) {
      return { kind: "hold", reason: plan.rationale.at(-1) ?? "hold" };
    }
    const addingPlan = steps0.some((a) => riskClassOf(a) === "adding");
    const vetoAnchor = db.lastCooldownAnchor(rt.laneAddress);
    const holdUntil = addingPlan
      ? Math.max(extra.addingHoldUntilMs, vetoAnchor === null ? 0 : vetoAnchor + vetoCooldownMs)
      : extra.reducingHoldUntilMs;
    if (nowMs < holdUntil) {
      const why =
        addingPlan && vetoAnchor !== null && vetoAnchor + vetoCooldownMs > nowMs
          ? "a human veto"
          : `a ${extra.holdReason} decision`;
      return {
        kind: "hold",
        reason: `cooling down after ${why} (${Math.ceil((holdUntil - nowMs) / 1000)} s)`,
      };
    }

    // 5. Overlay (identity in M2)
    const decisionId = newDecisionId(nowMs);
    const overlay = await resolveOverlay(
      {
        enabled: overlayWired && state.brain === "llm",
        planner: deps.overlay?.planner ?? null,
        critic: deps.overlay?.critic ?? null,
        ...(deps.overlay?.applier === undefined ? {} : { applier: deps.overlay.applier }),
      },
      { snapshot, regime, plan },
    );
    if (overlay.creditsExhausted && state.brain === "llm") {
      state.brain = "deterministic";
      log.warn({}, "LLM credits exhausted (402): deterministic mode, identity overlay");
      await safeNotify({
        kind: "alert",
        severity: "warn",
        lane: rt.lane,
        laneAddress: rt.laneAddress,
        title: "LLM credits exhausted: deterministic mode",
        lines: ["The overlay is off (identity) until the agent restarts with credits."],
      });
    }
    const finalPlan = deskPlanOf(overlay.finalPlan);

    // 6. Plan critic (deterministic; a throw is a REJECT)
    let criticResult: PlanCriticResult;
    try {
      criticResult = critic.critique({
        snapshot,
        regime,
        plan: finalPlan,
        params: cfg.strategy,
        nowMs,
      });
    } catch (err) {
      const reason = `plan critic threw: ${errText(err)} (fail-closed)`;
      criticResult = { verdict: "REJECT", reason, findings: [`REJECT: ${reason}`] };
    }

    const ctx: DecisionContext = {
      rt,
      decisionId,
      snapshot,
      regime,
      deterministic: plan,
      final: finalPlan,
      critic: { verdict: criticResult.verdict, reason: criticResult.reason },
      overlay,
    };
    state.lastDecisionId = decisionId;
    // A decision row that cannot be written means no evidence trail: abort the tick (fail-closed).
    db.insertDecision({
      decisionId,
      laneAddress: rt.laneAddress,
      lane: rt.lane,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
      regime: snapshot.calendar.name,
      regimeCode: regime.regimeCode,
      gatesMask: regime.gatesMask,
      riskMode: regime.riskMode,
      snapshotJson: evidenceJson(snapshot),
      planJson: evidenceJson(plan),
      overlayId: overlay.record.overlayId,
      finalPlanJson: evidenceJson(finalPlan),
      reasonHash: null,
      reasonPreimage: null,
      planCriticVerdict: criticResult.verdict,
      planCriticReason: criticResult.reason,
      guardDecision: null,
      guardViolationsJson: null,
      guardChecksJson: null,
      approvalMode: null,
      approvalOutcome: null,
      approvalChannel: null,
      status: "observed",
      statusDetail: null,
    });
    try {
      db.insertOverlay({
        overlayId: overlay.record.overlayId,
        decisionId,
        laneAddress: rt.laneAddress,
        createdAtMs: nowMs,
        source: overlay.record.source,
        proposalJson:
          overlay.record.proposal === null ? null : evidenceJson(overlay.record.proposal),
        criticVerdict: overlay.record.critic?.verdict ?? null,
        criticReason: overlay.record.critic?.reason ?? null,
        tightenOk: overlay.record.tighten.ok,
        tightenDetail:
          overlay.record.tighten.violations.length === 0
            ? null
            : overlay.record.tighten.violations.join("; "),
        applied: overlay.record.applied,
        raw: overlay.record.raw,
        error: overlay.record.error,
      });
    } catch (err) {
      log.warn({ error: errText(err) }, "overlay row not recorded");
    }

    return decide(ctx, log);
  }

  async function decide(ctx: DecisionContext, log: DeskLogger): Promise<LaneTickOutcome> {
    const { rt, snapshot, regime, final } = ctx;
    const actions = executable(final);
    const caps = snapshot.chain?.lane.caps ?? null;
    const plannedAtMs = clock.now();
    if (caps !== null && deadlineAheadSec(caps) < cfg.timing.deadlineMinAheadSec) {
      // Every step (exitAll included) will fail deadline-sane: say so loudly, once per window.
      await notifyOnce(
        `${rt.laneAddress}:no-deadline-window`,
        {
          kind: "alert",
          severity: "critical",
          lane: rt.lane,
          laneAddress: rt.laneAddress,
          title: "The lane's maxDeadlineAhead leaves no valid deadline: the agent cannot act",
          lines: [
            `on-chain maxDeadlineAhead ${caps.maxDeadlineAhead} s < the ${cfg.timing.deadlineMinAheadSec} s minimum`,
            "Not even exitAll can be sent. Exit from /desk with the Vault, or loosen the cap.",
          ],
        },
        "always",
      );
    }

    // 7-8. Build, simulate and guard every step (placeholder reasonHash: it commits to these checks).
    const built: BuiltStep[] = [];
    for (const [index, action] of actions.entries()) {
      const riskClass = riskClassOf(action);
      const executor = executorFor(rt, action);
      const meta = metaFor(ctx, index, ZERO_HASH, plannedAtMs, caps);
      const request: StepRequest = {
        decisionId: ctx.decisionId,
        step: index,
        lane: rt.lane,
        laneAddress: rt.laneAddress,
        action,
        meta,
        riskClass,
        notionalCents: 0,
      };
      if (executor === null) {
        built.push({
          index,
          action,
          riskClass,
          executor: rt.executor,
          request,
          prepared: null,
          prepareError: "no executor for this venue",
          notionalCents: 0,
          guard: blockedResult(`no executor for ${action.kind}`),
        });
        continue;
      }
      const { prepared, error } = await prepareStep(executor, request);
      const { result, notionalCents } = await guardStep(
        ctx,
        index,
        action,
        prepared,
        meta,
        snapshot,
        regime,
      );
      built.push({
        index,
        action,
        riskClass,
        executor,
        request,
        prepared,
        prepareError: error,
        notionalCents,
        guard: result,
      });
    }

    const multi = built.length > 1;
    const checks: GuardCheck[] = built.flatMap((s) =>
      s.guard.checks.map((c) => (multi ? { ...c, detail: `step ${s.index}: ${c.detail}` } : c)),
    );
    const violations = built.flatMap((s) =>
      s.guard.violations.map((v) => (multi ? { ...v, detail: `step ${s.index}: ${v.detail}` } : v)),
    );
    const decision = built.some((s) => s.guard.decision === "blocked")
      ? "blocked"
      : built.some((s) => s.guard.decision === "dry-run")
        ? "dry-run"
        : "execute";
    const reason = reasonHashOf({
      finalPlan: finiteOnly(final),
      guardChecks: checks,
      snapshotDigest: keccak256(stringToBytes(evidenceJson(snapshot))),
    });
    const adding = built.some((s) => s.riskClass === "adding");
    const notional = built.reduce(
      (acc, s) => acc + (s.riskClass === "adding" ? s.notionalCents : 0),
      0,
    );
    const summary = summarize(actions, notional);
    const firstBlock = built.find((s) => s.guard.decision === "blocked");
    const guardReason =
      firstBlock === undefined
        ? (built[0]?.guard.reason ?? "")
        : `${multi ? `step ${firstBlock.index}: ` : ""}${firstBlock.guard.reason}${firstBlock.prepareError === null ? "" : ` (prepare: ${firstBlock.prepareError})`}`;
    db.updateDecision(ctx.decisionId, {
      reasonHash: reason.hash,
      reasonPreimage: reason.preimage,
      guardDecision: decision,
      guardChecksJson: evidenceJson(checks),
      guardViolationsJson: evidenceJson(violations),
      updatedAtMs: clock.now(),
    });
    log.info(
      { decisionId: ctx.decisionId, guard: decision, violations: violations.length, summary },
      "guard evaluated",
    );

    if (decision === "blocked") {
      const status: DecisionStatus =
        ctx.critic.verdict === "REJECT" ? "critic_rejected" : "blocked";
      holdAfter(rt, adding, status, caps);
      await notifyOnce(`${rt.laneAddress}:${status}:${violations[0]?.rule ?? ""}`, {
        kind: "decision",
        severity: "warn",
        lane: rt.lane,
        laneAddress: rt.laneAddress,
        title: `${status === "critic_rejected" ? "Critic rejected" : "Blocked"}: ${summary}`,
        lines: [guardReason],
        decisionId: ctx.decisionId,
      });
      return finish(ctx, status, guardReason);
    }
    if (decision === "dry-run") {
      holdAfter(rt, adding, "dry_run", caps);
      await notifyOnce(`${rt.laneAddress}:dry_run:${adding}`, {
        kind: "decision",
        severity: "info",
        lane: rt.lane,
        laneAddress: rt.laneAddress,
        title: `Would ${summary}`,
        lines: final.rationale.slice(-3),
        decisionId: ctx.decisionId,
        dryRun: true,
      });
      return finish(ctx, "dry_run", "DRY_RUN held fire: every check passed, nothing signed");
    }

    // 9. Approval. The tick never waits for a human: it takes an answer only if one is already
    // there; otherwise the decision stays pending and a later tick settles it (pendingTick).
    const desk = db.getDesk(rt.laneAddress);
    if (desk?.status === "revoked") {
      holdAfter(rt, adding, "blocked", caps);
      return finish(ctx, "blocked", `desk revoked: ${desk.statusDetail ?? "delegation withdrawn"}`);
    }
    const safeMode = desk?.status === "safe_mode";
    const configured: DeskMode = safeMode ? "advisory" : (desk?.mode ?? cfg.safety.defaultMode);
    const mode = effectiveMode(configured, cfg.timing.cancelWindowMs);
    if (mode !== configured) {
      await notifyOnce(`${rt.laneAddress}:autopilot-no-window`, {
        kind: "alert",
        severity: "warn",
        lane: rt.lane,
        laneAddress: rt.laneAddress,
        title: "Autopilot without a cancel window runs as copilot",
        lines: ["DESK_CANCEL_WINDOW_SEC is 0: risk-adding waits for an explicit approve."],
      });
    }
    const paperOnly = built.every((s) => s.action.kind === "hedge") && cfg.hl.mode === "paper";
    const riskClass: RiskClass = adding ? "adding" : "reducing";
    const request = {
      decisionId: ctx.decisionId,
      laneAddress: rt.laneAddress,
      summary,
      windowMs: cfg.timing.approvalWindowMs,
    };
    if (mode === "copilot" && adding && !paperOnly) {
      await safeNotify({
        kind: "approval-request",
        severity: "warn",
        lane: rt.lane,
        laneAddress: rt.laneAddress,
        title: `Approve: ${summary}?`,
        lines: final.rationale.slice(-3),
        decisionId: ctx.decisionId,
        approval: {
          decisionId: ctx.decisionId,
          windowSec: Math.round(cfg.timing.approvalWindowMs / 1000),
        },
      });
    }
    const pending: PendingDecision = {
      ctx,
      built,
      reasonHash: reason.hash,
      adding,
      summary,
      mode,
      safeMode,
      safeModeDetail: desk?.statusDetail ?? null,
      expiresAtMs:
        clock.now() +
        Math.max(cfg.timing.approvalWindowMs, cfg.timing.cancelWindowMs) +
        2 * cfg.timing.tickMs,
      answer: null,
      withdrawn: false,
      log,
    };
    const answer = decideApproval({
      mode,
      // A paper order moves no money: it never waits for a human.
      riskClass: paperOnly ? "reducing" : riskClass,
      gate,
      request,
      cancelWindowMs: cfg.timing.cancelWindowMs,
      onVeto: () => {
        if (!pending.withdrawn) anchorVeto(rt, log);
      },
    }).catch((err: unknown): ApprovalDecision => {
      log.warn({ error: errText(err) }, "approval gate failed (fail-closed: declined)");
      return FAIL_CLOSED_ANSWER;
    });
    void answer.then((a) => {
      pending.answer = a;
    });
    const ready = await Promise.race([answer, nextTurn()]);
    if (ready === null) {
      pendings.set(lower(rt.laneAddress), pending);
      db.updateDecision(ctx.decisionId, {
        approvalMode: mode,
        statusDetail: "awaiting approval",
        updatedAtMs: clock.now(),
      });
      log.info(
        { decisionId: ctx.decisionId, summary },
        "awaiting approval; the loop keeps ticking",
      );
      return {
        kind: "awaiting_approval",
        decisionId: ctx.decisionId,
        reason: `awaiting approval: ${summary}`,
      };
    }
    return settle(pending, ready, null);
  }

  function anchorVeto(rt: LaneRuntime, log: DeskLogger): void {
    try {
      db.recordCooldownAnchor(rt.laneAddress, clock.now());
    } catch (err) {
      log.warn({ error: errText(err) }, "cooldown anchor not recorded");
    }
  }

  /** Record the approval answer; execute on yes, otherwise finish as advisory / declined. */
  async function settle(
    p: PendingDecision,
    approval: ApprovalDecision,
    fresh: FreshView | null,
  ): Promise<LaneTickOutcome> {
    const { ctx, adding, summary } = p;
    const { rt } = ctx;
    const caps = (fresh?.snapshot ?? ctx.snapshot).chain?.lane.caps ?? null;
    db.updateDecision(ctx.decisionId, {
      approvalMode: p.mode,
      approvalOutcome: approval.outcome,
      approvalChannel: approval.channel,
      updatedAtMs: clock.now(),
    });
    if (!approval.execute) {
      const status: DecisionStatus = approval.status ?? "declined";
      holdAfter(rt, adding, status, caps);
      const detail =
        status === "advisory"
          ? p.safeMode
            ? `safe mode (advisory): ${p.safeModeDetail ?? ""}`.trim()
            : "advisory mode: recommended, not executed"
          : `not approved (${approval.outcome})`;
      await notifyOnce(`${rt.laneAddress}:${status}:${adding}`, {
        kind: "decision",
        severity: "info",
        lane: rt.lane,
        laneAddress: rt.laneAddress,
        title: `${status === "advisory" ? "Advisory" : "Declined"}: ${summary}`,
        lines: [detail],
        decisionId: ctx.decisionId,
      });
      return finish(ctx, status, detail);
    }
    return executeSteps(p, fresh);
  }

  /**
   * A pending decision gives way: a risk-reducing plan preempts it, its window ran out without the
   * gate answering, or the daemon stops. Its approval row is closed so no channel can still answer.
   */
  async function withdraw(
    p: PendingDecision,
    outcome: "cancelled" | "timeout",
    why: string,
  ): Promise<LaneTickOutcome> {
    const { ctx } = p;
    p.withdrawn = true;
    pendings.delete(lower(ctx.rt.laneAddress));
    try {
      db.closeApproval(
        ctx.decisionId,
        outcome === "timeout" ? "expired" : "cancelled",
        clock.now(),
        why,
      );
    } catch (err) {
      p.log.warn({ error: errText(err) }, "approval row not closed");
    }
    if (outcome === "timeout") anchorVeto(ctx.rt, p.log); // silence is no
    const caps = ctx.snapshot.chain?.lane.caps ?? null;
    db.updateDecision(ctx.decisionId, {
      approvalMode: p.mode,
      approvalOutcome: outcome,
      approvalChannel: null,
      updatedAtMs: clock.now(),
    });
    holdAfter(ctx.rt, p.adding, "declined", caps);
    p.log.info({ decisionId: ctx.decisionId, why }, "pending decision withdrawn");
    await safeNotify({
      kind: "decision",
      severity: "info",
      lane: ctx.rt.lane,
      laneAddress: ctx.rt.laneAddress,
      title: `Withdrawn: ${p.summary}`,
      lines: [why],
      decisionId: ctx.decisionId,
    });
    return finish(ctx, "declined", `withdrawn before approval: ${why}`);
  }

  /** A lane with a pending decision: settle it, withdraw it, or keep waiting (null = go on). */
  async function pendingTick(
    rt: LaneRuntime,
    plan: DeskPlan,
    fresh: FreshView,
    nowMs: number,
  ): Promise<LaneTickOutcome | null> {
    const p = pendings.get(lower(rt.laneAddress));
    if (p === undefined) return null;
    // Risk-reducing actions never wait behind a human: withdraw the adding request and go on.
    const reducing = executable(plan).some(
      (a) => a.kind !== "hedge" && riskClassOf(a) === "reducing",
    );
    if (reducing) {
      await withdraw(p, "cancelled", `a risk-reducing plan preempted it (${plan.riskMode})`);
      return null;
    }
    if (p.answer !== null) {
      pendings.delete(lower(rt.laneAddress));
      return settle(p, p.answer, fresh);
    }
    if (nowMs > p.expiresAtMs) return withdraw(p, "timeout", "no answer within the window");
    return {
      kind: "awaiting_approval",
      decisionId: p.ctx.decisionId,
      reason: `awaiting approval: ${p.summary}`,
    };
  }

  /** 10. Execute, strictly in order (from the tick that decided it, or a later one). */
  async function executeSteps(
    p: PendingDecision,
    fresh: FreshView | null,
  ): Promise<LaneTickOutcome> {
    const { ctx, built } = p;
    const { rt } = ctx;
    const log = p.log;
    const base: FreshView = fresh ?? { snapshot: ctx.snapshot, regime: ctx.regime };
    const caps = base.snapshot.chain?.lane.caps ?? null;
    db.updateDecision(ctx.decisionId, {
      status: "executing",
      statusDetail: null,
      updatedAtMs: clock.now(),
    });
    let confirmed = 0;
    for (const step of built) {
      const stop = (status: DecisionStatus, detail: string): LaneTickOutcome => {
        const settled =
          confirmed > 0 && (status === "blocked" || status === "failed")
            ? "partially_executed"
            : status;
        holdAfter(rt, step.riskClass === "adding", settled, caps);
        return finish(ctx, settled, detail);
      };
      if (!heartbeat()) return stop("blocked", "daemon lock lost before execution");
      const current = db.getDesk(rt.laneAddress);
      if (current !== null && current.status !== "active" && current.status !== "registered") {
        return stop("blocked", `desk became ${current.status} before step ${step.index}`);
      }
      if (step.action.kind !== "hedge") {
        let ready: { ready: boolean; reason: string | null };
        try {
          ready = await rt.signer.ready();
        } catch (err) {
          ready = { ready: false, reason: errText(err) };
        }
        if (!ready.ready) {
          return stop("blocked", `signer not ready: ${ready.reason ?? "unknown"}`);
        }
      }

      // Final Meta (fresh deadline, the committed reasonHash), fresh simulation, fresh guard.
      const execAt = clock.now();
      const meta = metaFor(ctx, step.index, p.reasonHash, execAt, caps);
      const { prepared, error } = await prepareStep(step.executor, { ...step.request, meta });
      if (prepared === null) return stop("failed", `prepare failed: ${error ?? "unknown"}`);
      let snap = base.snapshot;
      let reg = base.regime;
      if (
        step.riskClass === "adding" &&
        clock.now() - snap.takenAtMs > cfg.timing.snapshotMaxAgeMs
      ) {
        try {
          snap = await rt.sensor.read(rt.lane, rt.laneAddress);
        } catch (err) {
          return stop("blocked", `re-sense before execution failed: ${errText(err)}`);
        }
        // Peek: the gate machine state is only advanced by the tick itself.
        reg = computeRegime(regimeDeps, snap, stateOf(rt, execAt).gates, clock.now());
      }
      // The plan was criticised on the snapshot it was built from; a risk-adding step that signs
      // on a later one (an approval wait) is criticised again there.
      const verdict =
        step.riskClass === "adding" && snap !== ctx.snapshot
          ? critiqueAtExecution(ctx, snap, reg)
          : ctx.critic;
      const { result, notionalCents } = await guardStep(
        ctx,
        step.index,
        step.action,
        prepared,
        meta,
        snap,
        reg,
        verdict,
      );
      if (result.decision !== "execute") {
        log.warn(
          { decisionId: ctx.decisionId, step: step.index, reason: result.reason },
          "pre-execution guard refused",
        );
        return stop("blocked", `pre-execution guard: ${result.reason}`);
      }

      let outcome: StepOutcome;
      try {
        outcome = await step.executor.execute({ ...prepared, notionalCents });
      } catch (err) {
        log.error({ decisionId: ctx.decisionId, error: errText(err) }, "execute threw");
        await safeNotify({
          kind: "execution",
          severity: "warn",
          lane: rt.lane,
          laneAddress: rt.laneAddress,
          title: `Failed: ${summarize([step.action], notionalCents)}`,
          lines: [errText(err)],
          decisionId: ctx.decisionId,
        });
        return stop("failed", `execute threw: ${errText(err)}`);
      }
      const ok = outcome.status === "confirmed";
      const denied = outcome.error?.code === "SIGNER_DENIED";
      await safeNotify({
        kind: "execution",
        severity: ok ? "info" : denied ? "critical" : "warn",
        lane: rt.lane,
        laneAddress: rt.laneAddress,
        title: `${ok ? "Executed" : denied ? "POLICY DENIED" : `Not confirmed (${outcome.status})`}: ${summarize([step.action], notionalCents)}`,
        lines: outcome.error === null ? [] : [`${outcome.error.code}: ${outcome.error.message}`],
        decisionId: ctx.decisionId,
        ...(outcome.txHash === null ? {} : { txHash: outcome.txHash }),
      });
      if (ok) {
        confirmed += 1;
        continue;
      }
      if (denied) return stop("policy_denied", outcome.error?.message ?? "signer policy denial");
      if (
        outcome.status === "unknown" ||
        outcome.status === "broadcast" ||
        outcome.status === "signed"
      ) {
        // The tx may still land: the resolver and the LaneAction reconciler settle it.
        holdAfter(rt, step.riskClass === "adding", "executing", caps);
        return finish(
          ctx,
          "executing",
          `step ${step.index} ${outcome.status}: awaiting reconciliation`,
        );
      }
      return stop(
        "failed",
        `step ${step.index} ${outcome.status}${outcome.error === null ? "" : `: ${outcome.error.code} ${outcome.error.message}`}`,
      );
    }
    return finish(ctx, "executed", `${confirmed} step(s) confirmed`);
  }

  async function runTick(): Promise<TickReport> {
    const atMs = clock.now();
    const report: TickReport = { atMs, lanes: [] };
    if (!heartbeat()) return report;
    if (deps.reconcile != null) {
      try {
        await deps.reconcile.runIfDue(atMs);
      } catch (err) {
        logger.warn({ error: errText(err) }, "reconcile failed");
      }
    }
    let lanes: readonly LaneRuntime[];
    try {
      lanes = deps.lanes();
    } catch (err) {
      logger.error({ error: errText(err) }, "lane registry failed");
      return report;
    }
    for (const rt of lanes) {
      if (lockLost) break;
      let outcome: LaneTickOutcome;
      try {
        outcome = await laneTick(rt);
      } catch (err) {
        logger.error({ lane: rt.laneAddress, error: errText(err) }, "lane tick crashed");
        outcome = { kind: "skipped", reason: `crashed: ${errText(err)}` };
      }
      report.lanes.push({ lane: rt.lane, laneAddress: rt.laneAddress, outcome });
    }
    return report;
  }

  function scheduleHeartbeat(): void {
    if (deps.lock == null || stopping) return;
    heartbeatTimer = setTimeout(() => {
      heartbeat();
      scheduleHeartbeat();
    }, cfg.timing.lockHeartbeatMs);
  }

  return {
    runTick,
    start() {
      if (started) return;
      started = true;
      scheduleHeartbeat();
      const loop = (): void => {
        if (stopping) return;
        inFlight = runTick()
          .catch((err) => logger.error({ error: errText(err) }, "tick crashed"))
          .finally(() => {
            inFlight = null;
            if (!stopping) tickTimer = setTimeout(loop, cfg.timing.tickMs);
          });
      };
      loop();
    },
    async stop() {
      stopping = true;
      if (tickTimer !== null) clearTimeout(tickTimer);
      if (heartbeatTimer !== null) clearTimeout(heartbeatTimer);
      if (inFlight !== null) {
        let grace: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          inFlight,
          new Promise<void>((r) => {
            grace = setTimeout(r, stopGraceMs);
          }),
        ]);
        clearTimeout(grace);
      }
      // Nobody will act on a later answer: close the requests so no channel can still approve.
      for (const p of [...pendings.values()]) {
        try {
          await withdraw(p, "cancelled", "the agent stopped before an answer");
        } catch (err) {
          logger.warn({ error: errText(err) }, "pending decision not withdrawn on stop");
        }
      }
    },
    laneState(laneAddress) {
      return states.get(lower(laneAddress)) ?? null;
    },
  };
}
