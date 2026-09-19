/**
 * Replay: the agent's OWN regime pipeline over a historical window, tick by tick at the live cadence
 * (5 s), on snapshots rebuilt from engine exports (src/replay/input.ts). Per tick:
 *
 *   calendar      market/calendar.ts regimeAt (the fixture-exact port)
 *   regime        regime/index.ts computeRegime: sense/freshness.ts → regime/gates.ts → the dwell
 *                 machine (regime/machine.ts, carried across ticks, startup hold included) → risk mode
 *   decision      lane-a:     strategy/lanes.ts (the real lane A v0 plan: trigger, fence, placement,
 *                             sizing, cost hurdle) on a simulated ~$50 lane (src/replay/lane.ts)
 *                 gates-only: the risk mode alone (pools the M2 strategy does not trade)
 *
 * What the snapshot models (and the output's `assumptions` repeats):
 *   - chain: a block-pinned read that always succeeds (FRESH); pool mid/tick/liquidity from swaps;
 *     the lane's riskAddingOpen / refTick from the ChainlinkFence rules applied to the recorded
 *     Chainlink rounds (FEED_DEAD past 26 h, CORP_ACTION_WINDOW within 2 h of effectiveAt,
 *     MARKET_CLOSED in the UTC Sat 00:00 → Mon 01:00 window); USDG's own feed is assumed sound.
 *   - hl: the latest closed candle's close; FRESH while that candle covers the tick (the live
 *     websocket would have been ticking), otherwise aged by the gap.
 *   - k: the engine's per-session basis (no look-ahead), fetched fresh; rh: fresh, no halt (RH
 *     halts were not recorded for these windows); corporate actions: none pending.
 *   - execution: a planned rerange / exitAll lands at once; approvals, guard and gas are not replayed.
 */

import { STRATEGY_DEFAULTS } from "../config.js";
import { etClock, regimeAt } from "../market/calendar.js";
import { fairValue } from "../market/fair-value.js";
import { fenceCodeName } from "../regime/gates.js";
import { computeRegime, defaultRegimeDeps } from "../regime/index.js";
import { createGateMachine, STUB_REASON } from "../regime/machine.js";
import { chainlinkRound, MOCK_LANE, MOCK_OPERATOR, mockChainRead } from "../sense/mock.js";
import { createLaneStrategy } from "../strategy/lanes.js";
import {
  type BasisK,
  type ChainRead,
  type DeskSnapshot,
  FENCE_CODES,
  GATE_IMPLEMENTED,
  GATE_NAMES,
  type GateName,
  type HourRecord,
  type LaneState,
  type RegimeName,
  type ReopenKind,
  type RiskMode,
  type SourceName,
  type SourceStatus,
} from "../types.js";
import { getTickAtSqrtRatio, priceToSqrtPriceX96, priceToTick } from "../units.js";
import { REPLAY_LABEL, type ReplayInput, type ReplayInputRow } from "./input.js";
import {
  agentRerangeAt,
  applyExitAll,
  applyRerange,
  budgetsAt,
  laneSlots,
  newSimLane,
  positionState,
  type SimLane,
} from "./lane.js";

export type ReplayAction = "hold" | "stay flat" | "exit" | "re-center";
export type ReplayMode = "lane-a" | "gates-only";

export interface ReplayRow {
  ts: number;
  regime: RegimeName;
  reopenKind: ReopenKind | null;
  activeGates: GateName[];
  gatesMask: number;
  riskMode: RiskMode;
  riskAddingAllowed: boolean;
  poolMid: number | null;
  hl: number | null;
  k: number | null;
  fair: number | null;
  gapBps: number | null;
  chainlink: { price: number | null; ageS: number | null; frozen: boolean };
  fenceCode: number;
  decision: { action: ReplayAction; reason: string; atTs: number };
  lane: { deployedUsd: number; inRange: boolean | null } | null;
}

export interface ReplayEvent {
  ts: number;
  kind: "gate_on" | "gate_off" | "action";
  gate?: GateName;
  action?: ReplayAction;
  reason: string;
  warmup: boolean;
}

export interface ReplayOptions {
  /** Internal tick (the live loop's cadence). Default 5 s. */
  tickMs?: number;
  /** One output row every this many seconds of the window. Default 300. */
  rowEveryS?: number;
  mode?: ReplayMode;
  /** Engine hour-of-week records (168, index = hour of week) for the cost hurdle; null: none. */
  hourRecords?: readonly HourRecord[] | null;
  /** Gas inputs of the cost hurdle (default: the README's measured 4663 figures, 2026-09-19). */
  gas?: { baseFeeWei: bigint; ethUsd: number };
  /** Simulated lane size (default $50, the M2 size). */
  laneUsd?: number;
  /** The stock token's ERC-8056 effectiveAt (unix s; 0 = none) and where that value comes from. */
  effectiveAtSec?: number;
  effectiveAtNote?: string;
  /** Max output rows (the last rows are dropped beyond it): keeps the web files small. */
  maxRows?: number;
}

export const REPLAY_GAS_DEFAULT = { baseFeeWei: 61_824_000n, ethUsd: 2_639.89 } as const;
const FEED_MAX_AGE_S = 26 * 3600;
const CORP_ACTION_GUARD_S = 2 * 3600;
const CLOSED_REGIMES: readonly RegimeName[] = ["WEEKEND_DARK", "HOLIDAY"];

/** ChainlinkFence.isClosedWindow: UTC Sat 00:00 → Mon 01:00. */
export function isFenceClosedWindow(tsSec: number): boolean {
  const dow = (Math.floor(tsSec / 86_400) + 4) % 7;
  return dow === 6 || dow === 0 || (dow === 1 && tsSec % 86_400 < 3_600);
}

/** The fence status of the stock token (ChainlinkFence._evaluate order), USDG assumed sound. */
export function fenceCodeAt(
  tsSec: number,
  chainlinkUpdatedAt: number | null,
  effectiveAtSec = 0,
): number {
  if (
    chainlinkUpdatedAt === null ||
    chainlinkUpdatedAt > tsSec ||
    tsSec - chainlinkUpdatedAt > FEED_MAX_AGE_S
  )
    return FENCE_CODES.FEED_DEAD;
  if (effectiveAtSec !== 0 && Math.abs(tsSec - effectiveAtSec) < CORP_ACTION_GUARD_S)
    return FENCE_CODES.CORP_ACTION_WINDOW;
  if (isFenceClosedWindow(tsSec)) return FENCE_CODES.MARKET_CLOSED;
  return FENCE_CODES.OK;
}

/** When the closure that contains `ms` began on the calendar (walked back by minute, 7 days at most). */
export function closedSinceMs(ms: number): number {
  let t = ms;
  for (let i = 0; i < 7 * 1440; i++) {
    if (!CLOSED_REGIMES.includes(regimeAt((t - 60_000) / 1000).name)) break;
    t -= 60_000;
  }
  return t;
}

const DOW = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const pad = (n: number) => String(n).padStart(2, "0");

/** "Sat 09-12 14:05 ET". */
export function etLabel(ms: number): string {
  const c = etClock(ms);
  return `${DOW[c.isoWeekday]} ${pad(c.month)}-${pad(c.day)} ${pad(c.hour)}:${pad(c.minute)} ET`;
}

const round = (x: number | null, d: number): number | null =>
  x === null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d;
const hours = (ms: number) => Math.round((ms / 3_600_000) * 100) / 100;

function rowAt(input: ReplayInput, ms: number): ReplayInputRow {
  const rows = input.rows;
  const i = Math.floor((ms / 1000 - (rows[0] as ReplayInputRow).ts) / input.cadenceS);
  return rows[Math.max(0, Math.min(rows.length - 1, i))] as ReplayInputRow;
}

const FRESH: SourceStatus = { ok: true, ageMs: 0, reason: null };

function hlStatus(row: ReplayInputRow, nowSec: number): SourceStatus {
  if (row.hl === null || row.hlPointTs === null)
    return { ok: false, ageMs: null, reason: "no HL candle" };
  const age = nowSec - row.hlPointTs;
  const covered = (row.hlResS ?? 0) + 60;
  return age <= covered
    ? FRESH
    : { ok: true, ageMs: (age - (row.hlResS ?? 0)) * 1000, reason: "HL candle gap" };
}

interface BuildArgs {
  input: ReplayInput;
  row: ReplayInputRow;
  nowMs: number;
  lane: SimLane | null;
  gas: { baseFeeWei: bigint; ethUsd: number };
  effectiveAtSec: number;
  fenceCode: number;
}

/** A DeskSnapshot of lane A at nowMs from the replay row (see the module note for what is modeled). */
export function replaySnapshot(a: BuildArgs): DeskSnapshot {
  const { row, nowMs, lane } = a;
  const nowSec = Math.floor(nowMs / 1000);
  const mid = row.poolMid;
  let chain: ChainRead | null = null;
  if (mid !== null) {
    const c = mockChainRead({ nowSec });
    const sqrt = priceToSqrtPriceX96(mid);
    c.pool = {
      sqrtPriceX96: sqrt,
      tick: getTickAtSqrtRatio(sqrt),
      liquidity: BigInt(Math.round(row.poolLiquidity ?? 0)),
      unlocked: true,
    };
    const refPrice = row.chainlinkPrice ?? mid;
    c.lane.riskAddingOpen = { open: a.fenceCode === FENCE_CODES.OK, code: a.fenceCode };
    c.lane.refTick = { tick: priceToTick(refPrice), bandTicks: 100, code: a.fenceCode };
    if (lane !== null) {
      const slots = laneSlots(lane);
      c.lane.positions = slots.positions;
      c.lane.positionDetails = slots.positionDetails;
      c.lane.balances = { token0: lane.balance0, token1: lane.balance1 };
      c.lane.budgets = budgetsAt(lane, nowMs, c.lane.caps);
    }
    c.chainlink.nvda =
      row.chainlinkPrice === null
        ? null
        : chainlinkRound(row.chainlinkPrice, 8, BigInt(row.chainlinkUpdatedAt ?? 0));
    c.baseFeePerGas = a.gas.baseFeeWei;
    c.stockToken.effectiveAt = BigInt(a.effectiveAtSec);
    chain = c;
  }
  const basis: BasisK | null =
    row.k === null
      ? null
      : { k: row.k, source: "engine", session: row.kSession, fetchedAtMs: nowMs };
  const sources: Record<SourceName, SourceStatus> = {
    chain: chain === null ? { ok: false, ageMs: null, reason: "no pool price" } : FRESH,
    hl: hlStatus(row, nowSec),
    rh: FRESH,
    k: basis === null ? { ok: false, ageMs: null, reason: "no k" } : FRESH,
    corpActions: FRESH,
  };
  const fv =
    mid !== null && row.hl !== null && basis !== null ? fairValue(row.hl, basis, mid) : null;
  return {
    lane: "A",
    laneAddress: MOCK_LANE,
    chainId: 4663,
    signerAddress: MOCK_OPERATOR,
    takenAtMs: nowMs,
    calendar: regimeAt(nowMs / 1000),
    chain,
    hl:
      row.hl === null
        ? null
        : {
            coin: a.input.hlCoin,
            bid: row.hl,
            ask: row.hl,
            mid: row.hl,
            markPx: row.hl,
            oraclePx: row.hl,
            exchangeTimeMs: row.hlPointTs === null ? null : row.hlPointTs * 1000,
            receivedAtMs: nowMs,
            source: "rest",
          },
    rh: {
      symbol: a.input.pool.split("/")[0] ?? "NVDA",
      bid: mid ?? 0,
      ask: mid ?? 0,
      mid: mid ?? 0,
      isTradingHalt: false,
      generatedAtMs: nowMs,
      receivedAtMs: nowMs,
    },
    k: basis,
    corpActions: {
      pendingForSymbol: false,
      nextEffectiveAtMs: null,
      items: [],
      fetchedAtMs: nowMs,
    },
    fairValue: fv,
    ethUsd: a.gas.ethUsd,
    sources,
  };
}

function oneLine(parts: readonly string[], max = 220): string {
  const s = parts.filter((p) => p.length > 0).join("; ");
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export interface ReplayTimeline {
  label: typeof REPLAY_LABEL;
  kind: "deltadesk-replay";
  version: 1;
  id: string;
  title: string;
  note: string;
  pool: string;
  mode: ReplayMode;
  generatedAt: string;
  window: ReplayInput["window"] & { startEt: string; endEt: string };
  tickMs: number;
  rowEveryS: number;
  engine: string[];
  sources: string[];
  assumptions: string[];
  notArmed: Record<string, string>;
  summary: Record<string, unknown>;
  headline: string[];
  lvr: (Record<string, unknown> & { statement?: string }) | null;
  events: ReplayEvent[];
  rows: ReplayRow[];
}

export function runReplay(input: ReplayInput, opts: ReplayOptions = {}): ReplayTimeline {
  const tickMs = opts.tickMs ?? 5_000;
  const rowEveryMs = (opts.rowEveryS ?? 300) * 1000;
  const mode: ReplayMode = opts.mode ?? (input.pool === "NVDA/USDG" ? "lane-a" : "gates-only");
  const gas = opts.gas ?? REPLAY_GAS_DEFAULT;
  const effectiveAtSec = opts.effectiveAtSec ?? 0;
  const laneUsd = opts.laneUsd ?? 50;
  const hourRecords = opts.hourRecords ?? null;
  const startMs = input.window.startTs * 1000;
  const endMs = input.window.endTs * 1000;
  const t0Ms = (input.rows[0] as ReplayInputRow).ts * 1000;
  if ((startMs - t0Ms) % tickMs !== 0 || rowEveryMs % tickMs !== 0)
    throw new Error("the window start and the row cadence must be on the tick grid");

  const machine = createGateMachine();
  const deps = { ...defaultRegimeDeps, machine };
  const strategy = createLaneStrategy({ maxActionCents: 6_000 });
  let gates = machine.initial(t0Ms);
  const firstMid = input.rows.find((r) => r.poolMid !== null)?.poolMid ?? null;
  let lane: SimLane | null =
    mode === "lane-a" && firstMid !== null ? newSimLane(laneUsd, firstMid) : null;
  let carry = { outsideInnerTicks: 0, rerangeNotBeforeMs: null as number | null };

  const rows: ReplayRow[] = [];
  const events: ReplayEvent[] = [];
  let pendingAction: ReplayRow["decision"] | null = null;

  // window accumulators (ms)
  const regimeMs: Partial<Record<RegimeName, number>> = {};
  const gateMs: Partial<Record<GateName, number>> = {};
  const fenceMs: Record<string, number> = {};
  let allowedMs = 0;
  let blockedMs = 0;
  let frozenMs = 0;
  let maxClAgeS = 0;
  let closedFrom: number | null = null;
  let closedTo: number | null = null;
  let firstAllowedAfterClose: number | null = null;
  let closedInRangeMs = 0;
  let closedWithPositionMs = 0;
  let closedAdding = 0;
  let maxAbsGap: { bps: number; ts: number } | null = null;
  let closedMaxAbsGap: { bps: number; ts: number } | null = null;
  let peakPremium: { bps: number; ts: number } | null = null;
  let premiumOver25Ms = 0;
  const closedAbsGaps: number[] = [];
  const openAbsGaps: number[] = [];
  let actionsInWindow = { reCenter: 0, exit: 0 };
  let actionsWarmup = { reCenter: 0, exit: 0 };

  for (let t = t0Ms; t <= endMs; t += tickMs) {
    const row = rowAt(input, t);
    const nowSec = Math.floor(t / 1000);
    const fenceCode = fenceCodeAt(nowSec, row.chainlinkUpdatedAt, effectiveAtSec);
    const snapshot = replaySnapshot({ input, row, nowMs: t, lane, gas, effectiveAtSec, fenceCode });
    const regime = computeRegime(deps, snapshot, gates, t);
    gates = regime.gates;
    const warmup = t < startMs;
    for (const tr of regime.transitions) {
      events.push({
        ts: Math.floor(tr.atMs / 1000),
        kind: tr.active ? "gate_on" : "gate_off",
        gate: tr.gate,
        reason: tr.reason,
        warmup,
      });
    }

    // ---- decision
    let action: ReplayAction;
    let reason: string;
    const chain = snapshot.chain;
    if (mode === "lane-a" && lane !== null && chain !== null) {
      const laneState: LaneState = {
        lane: "A",
        laneAddress: snapshot.laneAddress,
        gates: regime.gates,
        outsideInnerTicks: carry.outsideInnerTicks,
        rerangeNotBeforeMs: carry.rerangeNotBeforeMs,
        safeMode: null,
        lastTickAtMs: t - tickMs,
        lastDecisionId: null,
        brain: "deterministic",
      };
      const plan = strategy.plan({
        lane: "A",
        snapshot,
        regime,
        laneState,
        params: STRATEGY_DEFAULTS,
        agentRerange: agentRerangeAt(lane, t),
        hourRecord: hourRecords?.[snapshot.calendar.how] ?? null,
        gasQuote: null,
        nowMs: t,
        random: () => 0,
      });
      carry = plan.carry;
      const rerange = plan.actions.find((a) => a.kind === "rerange");
      if (rerange !== undefined && rerange.kind === "rerange") {
        lane = applyRerange(lane, rerange.ranges, chain.pool.sqrtPriceX96, t, plan.notionalCents);
        carry = { outsideInnerTicks: 0, rerangeNotBeforeMs: null };
        action = "re-center";
        reason = oneLine([
          `re-center on F ($${(plan.notionalCents / 100).toFixed(2)})`,
          ...plan.rationale,
        ]);
      } else if (plan.actions.some((a) => a.kind === "exitAll")) {
        lane = applyExitAll(lane, chain.pool.sqrtPriceX96);
        action = "exit";
        reason = oneLine(plan.rationale);
      } else {
        action = lane.positions.length > 0 ? "hold" : "stay flat";
        reason = oneLine(plan.rationale);
      }
    } else {
      action = regime.riskMode === "flat" ? "exit" : "stay flat";
      reason =
        regime.riskMode === "normal"
          ? `every gate clear: risk-adding allowed (no ${input.pool} lane in M2: lane A trades NVDA/USDG)`
          : regime.riskMode === "flat"
            ? `flat (${regime.activeGates.join(", ")}): exit`
            : `reduce-only (${regime.activeGates.join(", ")}): nothing added`;
    }
    if (action === "re-center" || action === "exit") {
      events.push({ ts: nowSec, kind: "action", action, reason, warmup });
      if (!warmup) pendingAction = { action, reason, atTs: nowSec };
      if (warmup) actionsWarmup = bump(actionsWarmup, action);
      else actionsInWindow = bump(actionsInWindow, action);
    }

    // ---- accumulate over the window [start, end)
    const cal = snapshot.calendar;
    const gap = snapshot.fairValue?.gapBps ?? null;
    const clAgeS = row.chainlinkUpdatedAt === null ? null : nowSec - row.chainlinkUpdatedAt;
    const closed = CLOSED_REGIMES.includes(cal.name);
    const frozen = clAgeS !== null && (clAgeS > FEED_MAX_AGE_S || (closed && clAgeS > 3_600));
    const pos =
      lane !== null && chain !== null && row.poolMid !== null
        ? positionState(lane, chain.pool.sqrtPriceX96, chain.pool.tick, row.poolMid)
        : null;
    if (!warmup && t < endMs) {
      regimeMs[cal.name] = (regimeMs[cal.name] ?? 0) + tickMs;
      for (const g of regime.activeGates) gateMs[g] = (gateMs[g] ?? 0) + tickMs;
      const fname = fenceCodeName(fenceCode);
      fenceMs[fname] = (fenceMs[fname] ?? 0) + tickMs;
      if (regime.riskMode === "normal") allowedMs += tickMs;
      else blockedMs += tickMs;
      if (frozen) frozenMs += tickMs;
      if (clAgeS !== null) maxClAgeS = Math.max(maxClAgeS, clAgeS);
      if (closed) {
        closedFrom ??= t;
        closedTo = t + tickMs;
        if (regime.riskMode === "normal") closedAdding += 1;
        if (pos !== null && pos.inRange !== null) {
          closedWithPositionMs += tickMs;
          if (pos.inRange) closedInRangeMs += tickMs;
        }
      } else if (
        closedTo !== null &&
        firstAllowedAfterClose === null &&
        regime.riskMode === "normal"
      ) {
        firstAllowedAfterClose = t;
      }
      if (gap !== null) {
        const abs = Math.abs(gap);
        if (maxAbsGap === null || abs > Math.abs(maxAbsGap.bps))
          maxAbsGap = { bps: gap, ts: nowSec };
        if (closed) {
          closedAbsGaps.push(abs);
          if (closedMaxAbsGap === null || abs > Math.abs(closedMaxAbsGap.bps))
            closedMaxAbsGap = { bps: gap, ts: nowSec };
        } else openAbsGaps.push(abs);
        if (peakPremium === null || -gap > peakPremium.bps) peakPremium = { bps: -gap, ts: nowSec };
        if (-gap > 25) premiumOver25Ms += tickMs;
      }
    }

    // ---- emit a row on the output grid
    if (!warmup && (t - startMs) % rowEveryMs === 0) {
      const current = { action, reason, atTs: nowSec };
      rows.push({
        ts: nowSec,
        regime: cal.name,
        reopenKind: cal.reopenKind,
        activeGates: regime.activeGates,
        gatesMask: regime.gatesMask,
        riskMode: regime.riskMode,
        riskAddingAllowed: regime.riskMode === "normal",
        poolMid: round(row.poolMid, 4),
        hl: round(row.hl, 4),
        k: round(row.k, 6),
        fair: round(snapshot.fairValue?.F ?? null, 4),
        gapBps: round(gap, 2),
        chainlink: { price: round(row.chainlinkPrice, 4), ageS: clAgeS, frozen },
        fenceCode,
        decision: pendingAction ?? current,
        lane:
          pos === null
            ? null
            : { deployedUsd: round(pos.deployedUsd, 2) ?? 0, inRange: pos.inRange },
      });
      pendingAction = null;
    }
  }

  const median = (xs: number[]) => {
    if (xs.length === 0) return null;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)] as number;
  };
  const gateHours: Record<string, number> = {};
  for (const g of GATE_NAMES) if (GATE_IMPLEMENTED[g]) gateHours[g] = hours(gateMs[g] ?? 0);
  const regimeHours: Record<string, number> = {};
  for (const [k, v] of Object.entries(regimeMs)) regimeHours[k] = hours(v);
  const fenceHours: Record<string, number> = {};
  for (const [k, v] of Object.entries(fenceMs)) fenceHours[k] = hours(v);
  const notArmed: Record<string, string> = {};
  for (const g of GATE_NAMES) if (!GATE_IMPLEMENTED[g]) notArmed[g] = STUB_REASON;
  // A window that opens inside the closure replays only its tail: say when the market really closed.
  const startedClosed = closedFrom === startMs;
  const closedSince = startedClosed ? closedSinceMs(startMs) : closedFrom;

  const summary: Record<string, unknown> = {
    hours: hours(endMs - startMs),
    regimeHours,
    riskAdding: {
      allowedHours: hours(allowedMs),
      blockedHours: hours(blockedMs),
      blockedShare: round(blockedMs / Math.max(1, allowedMs + blockedMs), 4),
    },
    gateHours,
    fenceHours,
    closedWindow:
      closedFrom === null || closedTo === null || closedSince === null
        ? null
        : {
            from: etLabel(closedFrom),
            to: etLabel(closedTo),
            hours: hours(closedTo - closedFrom),
            startedBeforeWindow: startedClosed,
            closedSince: etLabel(closedSince),
            closedHours: hours(closedTo - closedSince),
            riskAddingTicksWhileClosed: closedAdding,
            firstRiskAddingAfter:
              firstAllowedAfterClose === null ? null : etLabel(firstAllowedAfterClose),
          },
    gap: {
      maxAbsBps: round(maxAbsGap?.bps ?? null, 1),
      maxAbsAt: maxAbsGap === null ? null : etLabel(maxAbsGap.ts * 1000),
      closedMaxAbsBps: round(closedMaxAbsGap?.bps ?? null, 1),
      closedMaxAbsAt: closedMaxAbsGap === null ? null : etLabel(closedMaxAbsGap.ts * 1000),
      closedMedianAbsBps: round(median(closedAbsGaps), 1),
      openMedianAbsBps: round(median(openAbsGaps), 1),
    },
    chainlink: { maxAgeHours: round(maxClAgeS / 3600, 1), frozenHours: hours(frozenMs) },
    actions: { window: actionsInWindow, warmup: actionsWarmup },
    ...(mode === "lane-a"
      ? {
          lane: {
            usd: laneUsd,
            closedInRangeShare:
              closedWithPositionMs === 0 ? null : round(closedInRangeMs / closedWithPositionMs, 3),
            closedWithPositionHours: hours(closedWithPositionMs),
          },
        }
      : {
          premium: {
            peakBps: round(peakPremium?.bps ?? null, 1),
            peakAt: peakPremium === null ? null : etLabel(peakPremium.ts * 1000),
            hoursAbove25Bps: hours(premiumOver25Ms),
            gate: `WRAPPER-PREMIUM: ${STUB_REASON}`,
          },
        }),
  };

  const lvr =
    input.lvr === null
      ? null
      : { ...input.lvr, statement: lvrStatement(input.lvr, closedAdding, mode, startedClosed) };
  const headline = headlines(summary, lvr, mode);

  return {
    label: REPLAY_LABEL,
    kind: "deltadesk-replay",
    version: 1,
    id: input.id,
    title: input.title,
    note: input.note,
    pool: input.pool,
    mode,
    generatedAt: new Date().toISOString(),
    window: { ...input.window, startEt: etLabel(startMs), endEt: etLabel(endMs) },
    tickMs,
    rowEveryS: rowEveryMs / 1000,
    engine: [
      "agent/src/market/calendar.ts regimeAt (calendar port)",
      "agent/src/regime/index.ts computeRegime: sense/freshness.ts, regime/gates.ts, regime/machine.ts (dwell and startup hold carried across ticks)",
      mode === "lane-a"
        ? `agent/src/strategy/lanes.ts lane A v0 on a simulated $${laneUsd} lane (agent/src/replay/lane.ts)`
        : "gates only: the M2 lane strategy trades NVDA/USDG, so this pool gets the risk mode, not a plan",
    ],
    sources: [...input.sources],
    assumptions: [
      "chain reads always succeed (FRESH); pool mid/tick/liquidity are the latest swap's",
      "HL: latest closed candle, FRESH while the candle covers the tick (the live websocket would be ticking)",
      "k: the engine's last completed regular session (no look-ahead); RH fresh with no halt (RH halts were not recorded for these windows); no corporate action pending",
      "lane riskAddingOpen: ChainlinkFence rules on the recorded Chainlink rounds (FEED_DEAD > 26 h, MARKET_CLOSED UTC Sat 00:00 → Mon 01:00); USDG feed assumed sound",
      `stock token effectiveAt = ${effectiveAtSec}${opts.effectiveAtNote === undefined ? "" : ` (${opts.effectiveAtNote})`}`,
      "planned reranges / exits land instantly; approvals, the guard and gas are not replayed",
      `cost hurdle gas: base fee ${Number(gas.baseFeeWei) / 1e9} gwei, ETH/USD ${gas.ethUsd} (agent/README.md "Economics at M2 size")`,
    ],
    notArmed,
    summary,
    headline,
    lvr,
    events,
    rows: opts.maxRows !== undefined ? rows.slice(0, opts.maxRows) : rows,
  };
}

function bump(c: { reCenter: number; exit: number }, a: ReplayAction) {
  return a === "re-center" ? { ...c, reCenter: c.reCenter + 1 } : { ...c, exit: c.exit + 1 };
}

const money = (x: unknown) =>
  typeof x === "number" && Number.isFinite(x)
    ? `${x < 0 ? "−" : ""}$${Math.abs(x).toFixed(2)}`
    : "–";

function lvrStatement(
  lvr: Record<string, unknown>,
  closedAdding: number,
  mode: ReplayMode,
  startedClosed: boolean,
): string | undefined {
  if (lvr.derivable !== true) return undefined;
  const c = lvr.controlLane as Record<string, unknown> | undefined;
  const w = lvr.closedWindow as Record<string, unknown> | undefined;
  if (c === undefined || w === undefined) return undefined;
  const desk =
    closedAdding !== 0
      ? `DeltaDesk's gates allowed risk-adding on ${closedAdding} tick(s) while closed`
      : mode === "lane-a"
        ? "DeltaDesk added no risk while closed (every risk-adding step was gated; a position placed before the close is held, not exited, in M2)"
        : "DeltaDesk's gates blocked risk-adding on every closed tick (M2 runs no lane on this pool)";
  const span = startedClosed
    ? `${w.hours} h of the closed window replayed`
    : `${w.hours} h closed window`;
  return `A control lane in range all through the ${span} ($1k, ±100 ticks) paid ${money(c.pickedOffUsd)} to informed flow and earned ${money(c.feesUsd)} in fees (net ${money(c.netUsd)}). ${desk}.`;
}

function headlines(
  s: Record<string, unknown>,
  lvr: (Record<string, unknown> & { statement?: string }) | null,
  mode: ReplayMode,
): string[] {
  const out: string[] = [];
  const cw = s.closedWindow as Record<string, unknown> | null;
  const ra = s.riskAdding as Record<string, number>;
  const gap = s.gap as Record<string, unknown>;
  if (cw !== null) {
    const adding = cw.riskAddingTicksWhileClosed as number;
    const span =
      cw.startedBeforeWindow === true
        ? `Market closed ${cw.closedSince} → ${cw.to} (${cw.closedHours} h; the window opens inside it at ${cw.from}, so ${cw.hours} h of it are replayed)`
        : `Market closed ${cw.from} → ${cw.to} (${cw.hours} h)`;
    out.push(
      `${span}: ${adding === 0 ? "risk-adding blocked on every tick" : `risk-adding allowed on ${adding} tick(s)`}; first allowed again ${cw.firstRiskAddingAfter ?? "not within the window"}.`,
    );
  }
  const g = gap.maxAbsBps as number | null;
  const largest =
    g === null
      ? "no fair value"
      : `${Math.abs(g)} bp, pool ${g < 0 ? "above" : "below"} fair (${gap.maxAbsAt})`;
  out.push(
    `Risk-adding blocked ${ra.blockedHours} h of ${s.hours} h; largest pool-vs-fair gap ${largest}; median |gap| ${gap.closedMedianAbsBps ?? "–"} bp closed vs ${gap.openMedianAbsBps ?? "–"} bp open.`,
  );
  if (mode === "lane-a") {
    const a = s.actions as {
      window: { reCenter: number; exit: number };
      warmup: { reCenter: number };
    };
    const l = s.lane as { closedInRangeShare: number | null };
    out.push(
      `Lane A ($50): ${a.warmup.reCenter} initial placement before the window, ${a.window.reCenter} re-centers and ${a.window.exit} exits in it; its position was in range ${l.closedInRangeShare === null ? "–" : `${Math.round(l.closedInRangeShare * 100)}%`} of the closed window (held, not exited: reduce-only in M2).`,
    );
  } else {
    const p = s.premium as Record<string, unknown>;
    out.push(
      `Pool premium over fair peaked at ${p.peakBps} bp (${p.peakAt}); above 25 bp for ${p.hoursAbove25Bps} h. WRAPPER-PREMIUM is a stub in M2: not armed.`,
    );
  }
  if (lvr?.statement !== undefined) out.push(lvr.statement);
  return out;
}
