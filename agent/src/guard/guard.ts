/**
 * The Guard: the deterministic final authority over every step (tick step 8).
 *
 * PURE and synchronous: every I/O-derived fact is injected through GuardInput; the guard never
 * touches the db, env or network. EVERY rule in GUARD_RULES is evaluated, in order, into checks[];
 * every failure lands in violations[]. A rule that throws on malformed input FAILS (fail-closed).
 * Money is integer cents. dry-run is evaluated last and only decides the outcome when nothing
 * failed.
 *
 * Posture inversion. Risk-adding steps need fresh references, every gate clear, the cost hurdle,
 * an unpaused lane and the rate limits. Risk-reducing and neutral steps (reduce, collect, exitAll,
 * pause, unwind-and-hold, signal) BYPASS ref-freshness, regime-gate, cost-hurdle, rerange-rate and
 * lane-not-paused, and use a relaxed gas rule (they only need to afford their own gas). They NEVER
 * bypass the arm flag, dry-run, the allowlist, idempotency, simulation or signer binding.
 * The risk class is the stricter of the declared one and riskClassOf(action): a step claiming to
 * be reducing while its action adds risk is treated as adding (and fails the allowlist).
 */

import { CHAIN_ID_4663 } from "../addresses.js";
import { containsRawAddress } from "../agents/schemas.js";
import { canonicalJson } from "../canonical.js";
import { OPERATOR_SELECTORS } from "../executor/abi/DeskLane.js";
import { decodeDecisionId } from "../executor/decision-id.js";
import { tightenCheck } from "../overlay/apply.js";
import { fenceAllowsAcross, shapeOk } from "../strategy/bands.js";
import {
  type DeskAction,
  type GuardCheck,
  type GuardFn,
  type GuardInput,
  type GuardResult,
  type GuardRuleId,
  type GuardViolation,
  HL_NVDA_ASSET,
  HL_NVDA_COIN,
  type RiskClass,
  riskClassOf,
  type SourceName,
} from "../types.js";
import { usd6ToCentsCeil, usd6ToCentsFloor } from "../units.js";
import { postUnwindBalances, riskModeOf, stricterRiskMode } from "./risk.js";

export type { GuardFn, GuardInput, GuardLimits, GuardResult, GuardRuleId } from "../types.js";

type Outcome = readonly [passed: boolean, detail: string];

const BYPASS = "bypassed: risk-reducing (posture inversion)";

/** References a risk-adding step needs FRESH, by action kind. */
const REQUIRED_FRESH: Readonly<Record<"rerange" | "hedge", readonly SourceName[]>> = {
  rerange: ["chain", "hl", "k", "rh"],
  hedge: ["chain", "hl"],
};

const lower = (a: string | null | undefined): string => (a ?? "").toLowerCase();

function safeRiskClass(action: DeskAction): RiskClass | null {
  try {
    return riskClassOf(action);
  } catch {
    return null;
  }
}

function actionStrings(action: DeskAction): string[] {
  if (action.kind === "hold") return [action.reason];
  if (action.kind === "signal") return [action.note];
  return [];
}

function sameAction(a: DeskAction, b: DeskAction): boolean {
  try {
    return canonicalJson(a) === canonicalJson(b);
  } catch {
    return false;
  }
}

export function checkGuard(input: GuardInput): GuardResult {
  const checks: GuardCheck[] = [];
  const violations: GuardViolation[] = [];

  const run = (rule: GuardRuleId, fn: () => Outcome): void => {
    let passed: boolean;
    let detail: string;
    try {
      [passed, detail] = fn();
    } catch (err) {
      passed = false;
      detail = `rule threw on malformed input: ${err instanceof Error ? err.message : String(err)} (fail-closed)`;
    }
    checks.push({ rule, passed, detail });
    if (!passed) violations.push({ rule, detail });
  };

  const action = input.action;
  const kind = action?.kind;
  const derived = action === undefined || action === null ? null : safeRiskClass(action);
  // Fail-closed: adding if either the declared or the derived class says so, or either is unknown.
  const adding = input.riskClass === "adding" || derived === "adding" || derived === null;
  const isHedge = kind === "hedge";
  const onchain = !isHedge && kind !== "hold" && kind !== undefined;
  const isAddingRerange = action?.kind === "rerange" && action.ranges.length > 0;
  const chain = input.snapshot?.chain ?? null;
  const lane = chain?.lane ?? null;
  const nowSec = Math.floor(input.nowMs / 1000);
  const notional = input.notionalCents;
  const validNotional = Number.isInteger(notional) && notional >= 0;

  // 1. action-none
  run("action-none", () =>
    kind === undefined || kind === "hold"
      ? [false, `no executable action (${kind ?? "missing"})`]
      : [true, `action ${kind} (${adding ? "risk-adding" : `risk-${derived}`})`],
  );

  // 2. critic-approval: the plan critic says APPROVE, and the overlay is identity or LLM-approved.
  run("critic-approval", () => {
    const problems: string[] = [];
    const pc = input.planCritic;
    if (pc?.verdict !== "APPROVE") {
      problems.push(
        `plan critic verdict ${JSON.stringify(pc?.verdict)} is not APPROVE (${pc?.reason ?? "no reason"})`,
      );
    }
    const ov = input.overlay;
    const unchanged =
      canonicalJson(input.plans.final.actions) === canonicalJson(input.plans.deterministic.actions);
    if (ov?.source === "identity" || (ov?.source === "llm" && ov.applied !== true)) {
      if (!unchanged)
        problems.push(
          `overlay ${ov.source} not applied, but the final plan differs from the deterministic plan`,
        );
    } else if (ov?.source === "llm") {
      if (ov.critic?.verdict !== "APPROVE")
        problems.push("LLM overlay applied without an overlay-critic APPROVE");
      if (ov.tighten?.ok !== true)
        problems.push("LLM overlay applied although its tighten-check failed");
    } else {
      problems.push(`unknown overlay source ${JSON.stringify(ov?.source)}`);
    }
    return problems.length === 0
      ? [
          true,
          `plan critic APPROVE (${pc.reason}); overlay ${ov.source}${ov.source === "llm" ? " approved" : ""}`,
        ]
      : [false, problems.join("; ")];
  });

  // 3. allowlist: to = this lane, selector ∈ OPERATOR_SELECTORS and matching the action, no value,
  // no raw addresses in LLM strings, declared risk class consistent.
  run("allowlist", () => {
    const problems: string[] = [];
    if (derived === null) problems.push("action risk class cannot be derived");
    else if (input.riskClass !== derived)
      problems.push(`declared risk class ${input.riskClass} ≠ derived ${derived}`);
    if (action !== undefined && action !== null && action.lane !== input.expected.lane) {
      problems.push(`action lane ${action.lane} ≠ expected ${input.expected.lane}`);
    }
    if (onchain && action !== undefined && action !== null) {
      const tx = input.tx;
      if (tx === null) problems.push("no encoded call");
      else {
        if (lower(tx.to) !== lower(input.expected.laneAddress))
          problems.push(`to ${tx.to} is not the configured lane`);
        if (tx.value !== 0n) problems.push(`value ${tx.value} ≠ 0`);
        const sel = lower(tx.selector);
        if (
          !input.operatorSelectors.has(tx.selector) &&
          ![...input.operatorSelectors].some((s) => lower(s) === sel)
        ) {
          problems.push(`selector ${tx.selector} not in OPERATOR_SELECTORS`);
        }
        if (sel !== lower(OPERATOR_SELECTORS[action.kind])) {
          problems.push(`selector ${tx.selector} does not encode ${action.kind}`);
        }
        if (!lower(tx.data).startsWith(sel) || sel.length !== 10)
          problems.push("calldata does not start with its selector");
      }
    } else if (isHedge && action?.kind === "hedge") {
      if (input.tx !== null) problems.push("an HL order carries no on-chain call");
      if (action.coin !== HL_NVDA_COIN || action.asset !== HL_NVDA_ASSET)
        problems.push("hedge market not allowlisted");
      if (action.lane !== "B") problems.push("hedges belong to lane B");
    }
    const strings = [...(input.llmStrings ?? []), ...(action ? actionStrings(action) : [])];
    if (strings.some((s) => typeof s !== "string" || containsRawAddress(s))) {
      problems.push("raw address in LLM or action strings: addresses come only from config");
    }
    return problems.length === 0
      ? [
          true,
          onchain
            ? `call to the lane via ${kind} selector; no raw addresses`
            : `${kind}: no on-chain call; no raw addresses`,
        ]
      : [false, problems.join("; ")];
  });

  // 4. amount-positive
  run("amount-positive", () => {
    if (action?.kind === "reduce") {
      return action.liquidity > 0n
        ? [true, `reduce liquidity ${action.liquidity}`]
        : [false, "reduce liquidity must be > 0"];
    }
    if (action?.kind === "hedge") {
      const sz = Number(action.sz);
      return Number.isFinite(sz) && sz > 0
        ? [true, `hedge size ${action.sz}`]
        : [false, `hedge size ${action.sz} not > 0`];
    }
    if (!adding) return [true, `${kind}: no amount`];
    if (!(validNotional && notional > 0))
      return [false, `adding notional ${notional} is not a positive integer of cents`];
    if (
      isAddingRerange &&
      action?.kind === "rerange" &&
      action.ranges.every((r) => r.share0Bps <= 0 && r.share1Bps <= 0)
    ) {
      return [false, "every range share is zero"];
    }
    return [true, `adding notional ${notional} cents`];
  });

  // 5. max-action-usd: ≤ the config cap, which must itself be ≤ the on-chain cap.
  run("max-action-usd", () => {
    if (!adding) return [true, "not risk-adding"];
    if (!validNotional) return [false, `notional ${notional} is not integer cents`];
    if (isHedge) {
      return notional <= input.limits.maxActionCents
        ? [true, `hedge ${notional} ≤ cap ${input.limits.maxActionCents} cents`]
        : [false, `hedge ${notional} > cap ${input.limits.maxActionCents} cents`];
    }
    if (lane === null) return [false, "no lane caps (no chain read)"];
    const onchainCap = usd6ToCentsFloor(lane.caps.maxDeployUsd6);
    if (input.limits.maxActionCents > onchainCap) {
      return [
        false,
        `config cap ${input.limits.maxActionCents} cents exceeds the on-chain maxDeploy ${onchainCap} cents`,
      ];
    }
    return notional <= input.limits.maxActionCents
      ? [true, `${notional} ≤ cap ${input.limits.maxActionCents} cents (on-chain ${onchainCap})`]
      : [false, `${notional} exceeds the cap ${input.limits.maxActionCents} cents`];
  });

  // 6. daily-turnover: fail-closed, max(DB signed turnover, on-chain used) + this ≤ the cap.
  run("daily-turnover", () => {
    if (!adding) return [true, "not risk-adding"];
    const db = input.turnoverDbCents24h;
    if (!(Number.isInteger(db) && db >= 0))
      return [false, `DB turnover ${db} unknown (fail-closed)`];
    if (!validNotional) return [false, `notional ${notional} is not integer cents`];
    let used = db;
    let detail = `DB ${db}`;
    if (!isHedge) {
      if (lane === null) return [false, "no lane budgets (no chain read)"];
      const cap = lane.caps.turnoverUsd6PerDay;
      const avail = lane.budgets.turnoverAvailableUsd6;
      const onchainUsed = usd6ToCentsCeil(cap > avail ? cap - avail : 0n);
      used = Math.max(db, onchainUsed);
      detail = `max(DB ${db}, on-chain ${onchainUsed})`;
      const availCents = usd6ToCentsFloor(avail);
      if (notional > availCents)
        return [false, `${notional} cents exceeds the on-chain turnover bucket ${availCents}`];
    }
    const projected = used + notional;
    return projected <= input.limits.dailyTurnoverCents
      ? [true, `${detail} + ${notional} = ${projected} ≤ ${input.limits.dailyTurnoverCents} cents`]
      : [
          false,
          `${detail} + ${notional} = ${projected} exceeds ${input.limits.dailyTurnoverCents} cents`,
        ];
  });

  // 7. idempotency: DB UNIQUE(decision_id, step) and on-chain decisionUsedAt == 0.
  run("idempotency", () => {
    const problems: string[] = [];
    if (input.idempotency?.dbHasStep !== false)
      problems.push("the DB already has this (decision, step)");
    if (onchain && kind !== "pause") {
      if (input.meta === null) problems.push("no Meta");
      else {
        const id = decodeDecisionId(input.meta.decisionId);
        if (id.ulid !== input.decisionId || id.step !== input.step) {
          problems.push(
            `Meta.decisionId encodes ${id.ulid}/${id.step}, not ${input.decisionId}/${input.step}`,
          );
        }
      }
      const used = input.idempotency?.onchainDecisionUsedAt;
      if (used === null || used === undefined)
        problems.push("on-chain decisionUsedAt unknown (fail-closed)");
      else if (used !== 0n) problems.push(`decisionId already used on-chain at ${used}`);
    }
    return problems.length === 0
      ? [true, "fresh decision step (DB and on-chain)"]
      : [false, problems.join("; ")];
  });

  // 8. arm-flag: DESK_ARM=1 is required on 4663.
  run("arm-flag", () => {
    const mainnet =
      input.limits.chainId === CHAIN_ID_4663 || input.expected.chainId === CHAIN_ID_4663;
    if (!mainnet) return [true, `chain ${input.limits.chainId} (loopback fork) needs no arm`];
    return input.flags.armed === true
      ? [true, "4663 explicitly armed"]
      : [false, "4663 requires DESK_ARM=1: not armed"];
  });

  // 9. snapshot-provenance: lane, chainId and signer match; snapshot age ≤ 3 s (adding).
  run("snapshot-provenance", () => {
    const s = input.snapshot;
    const e = input.expected;
    const problems: string[] = [];
    if (s.lane !== e.lane) problems.push(`snapshot lane ${s.lane} ≠ ${e.lane}`);
    if (lower(s.laneAddress) !== lower(e.laneAddress))
      problems.push("snapshot lane address mismatch");
    if (s.chainId !== e.chainId || e.chainId !== input.limits.chainId) {
      problems.push(
        `chainId snapshot ${s.chainId} / expected ${e.chainId} / config ${input.limits.chainId}`,
      );
    }
    if (lower(s.signerAddress) !== lower(e.signerAddress))
      problems.push("snapshot signer mismatch");
    if (onchain) {
      if (chain === null) problems.push("no chain read");
      else if (lower(chain.lane.laneAddress) !== lower(e.laneAddress))
        problems.push("chain read is of another lane");
    }
    for (const p of [input.plans.deterministic, input.plans.final]) {
      if (p.lane !== e.lane || lower(p.laneAddress) !== lower(e.laneAddress))
        problems.push("plan is for another lane");
    }
    const age = input.nowMs - s.takenAtMs;
    if (!Number.isFinite(age) || age < -1_000) problems.push(`snapshot age ${age} ms is invalid`);
    else if (adding && age > input.limits.maxSnapshotAgeMs) {
      problems.push(`snapshot ${age} ms old > ${input.limits.maxSnapshotAgeMs} ms`);
    }
    return problems.length === 0
      ? [true, `snapshot of lane ${e.lane} on ${e.chainId}, ${age} ms old`]
      : [false, problems.join("; ")];
  });

  // 10. ref-freshness (adding only)
  run("ref-freshness", () => {
    if (!adding) return [true, BYPASS];
    const required = REQUIRED_FRESH[isHedge ? "hedge" : "rerange"];
    const stale = required.filter((src) => input.freshness?.[src] !== "FRESH");
    return stale.length === 0
      ? [true, `${required.join(", ")} FRESH`]
      : [
          false,
          `not FRESH: ${stale.map((s) => `${s} ${input.freshness?.[s] ?? "unknown"}`).join(", ")}`,
        ];
  });

  // 11. gas-reserve: adding keeps the reserve after gas; reducing only needs its own gas.
  run("gas-reserve", () => {
    if (isHedge) return [true, "HL order: no chain gas"];
    if (chain === null) return [false, "operator ETH unknown (no chain read)"];
    const eth = chain.operatorEthWei;
    const cost = input.estimatedGasCostWei;
    if (adding) {
      if (cost === null || cost <= 0n) return [false, "gas cost unknown for a risk-adding step"];
      return eth - cost >= input.limits.gasReserveWei
        ? [true, `ETH ${eth} − gas ${cost} ≥ reserve ${input.limits.gasReserveWei} wei`]
        : [false, `ETH ${eth} − gas ${cost} < reserve ${input.limits.gasReserveWei} wei`];
    }
    if (cost === null)
      return eth > 0n
        ? [true, `reducing: ETH ${eth} wei, gas unknown`]
        : [false, "no operator ETH"];
    return eth >= cost
      ? [true, `reducing: ETH ${eth} ≥ gas ${cost} wei`]
      : [false, `ETH ${eth} < gas ${cost} wei`];
  });

  // 12. lane-solvency
  run("lane-solvency", () => {
    if (action?.kind === "reduce") {
      const p = lane?.positionDetails[action.slot] ?? null;
      if (lane === null || lane.positions[action.slot] === 0n || p === null)
        return [false, `no position in slot ${action.slot}`];
      return action.liquidity <= p.liquidity
        ? [true, `slot ${action.slot} holds ${p.liquidity} ≥ ${action.liquidity}`]
        : [false, `slot ${action.slot} holds ${p.liquidity} < ${action.liquidity}`];
    }
    if (!isAddingRerange || action?.kind !== "rerange") return [true, `${kind}: nothing to fund`];
    if (chain === null) return [false, "no balances (no chain read)"];
    const b = postUnwindBalances(chain);
    const s0 = action.ranges.reduce((acc, r) => acc + r.share0Bps, 0);
    const s1 = action.ranges.reduce((acc, r) => acc + r.share1Bps, 0);
    const problems: string[] = [];
    if (s0 > 10_000 || s1 > 10_000) problems.push(`shares ${s0}/${s1} exceed 10000`);
    if (s0 > 0 && b.balance0 === 0n) problems.push("token0 share with no token0");
    if (s1 > 0 && b.balance1 === 0n) problems.push("token1 share with no token1");
    return problems.length === 0
      ? [true, `post-unwind balances ${b.balance0}/${b.balance1} fund shares ${s0}/${s1}`]
      : [false, problems.join("; ")];
  });

  // 13. regime-gate (adding only)
  run("regime-gate", () => {
    if (!adding) return [true, BYPASS];
    const r = input.regime;
    const mode = stricterRiskMode(r.riskMode, riskModeOf(r.activeGates));
    return mode === "normal"
      ? [true, "no gate forces reduce-only or flat"]
      : [false, `risk mode ${mode} (${r.activeGates.join(", ")})`];
  });

  // 14. rerange-rate: the stricter of the agent's and the contract's limits.
  run("rerange-rate", () => {
    if (!isAddingRerange) return [true, adding ? "not a rerange" : BYPASS];
    if (lane === null) return [false, "no lane budgets"];
    const ar = input.agentRerange;
    const lim = input.limits.agentReranges;
    const problems: string[] = [];
    const minMs = Math.max(lim.minIntervalSec * 1000, ar.minIntervalMs);
    if (ar.lastRerangeAtMs !== null && input.nowMs - ar.lastRerangeAtMs < minMs)
      problems.push("agent interval not elapsed");
    if (ar.count1h >= Math.min(lim.perHour, ar.maxPerHour))
      problems.push(`agent 1 h count ${ar.count1h} at its limit`);
    if (ar.count24h >= Math.min(lim.perDay, ar.maxPerDay))
      problems.push(`agent 24 h count ${ar.count24h} at its limit`);
    const b = lane.budgets;
    if (b.nextRerangeAt > BigInt(nowSec))
      problems.push(`contract interval: next at ${b.nextRerangeAt}`);
    if (b.reranges1hLeft < 1n) problems.push("contract 1 h bucket empty");
    if (b.reranges24hLeft < 1n) problems.push("contract 24 h bucket empty");
    return problems.length === 0
      ? [
          true,
          `agent ${ar.count1h}/${lim.perHour} h, ${ar.count24h}/${lim.perDay} d; contract ${b.reranges1hLeft}/${b.reranges24hLeft} left`,
        ]
      : [false, problems.join("; ")];
  });

  // 15. cost-hurdle (non-safety only). The initial mint of an empty lane is waived (reported deviation).
  run("cost-hurdle", () => {
    if (!adding) return [true, BYPASS];
    if (isHedge) return [true, "hedge: no rerange cost hurdle"];
    const emptyLane = lane !== null && lane.positions[0] === 0n && lane.positions[1] === 0n;
    if (input.plans.deterministic.trigger === "initial_mint" && emptyLane) {
      return [true, "waived for the initial mint of an empty lane"];
    }
    const h = input.hurdle;
    if (h === null) return [false, "no hurdle computed"];
    const ok =
      h.passes === true &&
      Number.isFinite(h.benefitUsd) &&
      Number.isFinite(h.costUsd) &&
      h.costUsd > 0 &&
      h.benefitUsd >= input.limits.hurdleMultiple * h.costUsd;
    return ok
      ? [
          true,
          `benefit $${h.benefitUsd.toFixed(4)} ≥ ${input.limits.hurdleMultiple}× cost $${h.costUsd.toFixed(4)}`,
        ]
      : [
          false,
          `benefit $${h.benefitUsd} < ${input.limits.hurdleMultiple}× cost $${h.costUsd} (${h.detail})`,
        ];
  });

  // 16. tick-validity: spacing, bounds, width, count, shares, expected tick.
  run("tick-validity", () => {
    if (action?.kind !== "rerange" || action.ranges.length === 0)
      return [true, `${kind}: no ticks`];
    if (lane === null || chain === null) return [false, "no lane caps"];
    const caps = lane.caps;
    const problems: string[] = [];
    if (action.ranges.length > caps.maxRanges)
      problems.push(`${action.ranges.length} ranges > ${caps.maxRanges}`);
    const seen = new Set<string>();
    for (const r of action.ranges) {
      const label = `[${r.tickLower}, ${r.tickUpper})`;
      if (!shapeOk(r, input.limits.tickSpacing, caps.minWidthTicks, caps.maxWidthTicks))
        problems.push(`${label} bad shape`);
      if (seen.has(label)) problems.push(`${label} duplicated`);
      seen.add(label);
      for (const s of [r.share0Bps, r.share1Bps])
        if (!Number.isInteger(s) || s < 0 || s > 10_000) problems.push(`${label} share ${s}`);
    }
    const d = action.maxTickDelta;
    if (!Number.isInteger(d) || d < 0 || d > caps.maxTickDelta)
      problems.push(`maxTickDelta ${d} not in [0, ${caps.maxTickDelta}]`);
    if (!Number.isInteger(action.expectedTick)) problems.push("expectedTick not an integer");
    else if (Math.abs(action.expectedTick - chain.pool.tick) > d) {
      problems.push(
        `pool tick ${chain.pool.tick} already outside expected ${action.expectedTick} ± ${d}`,
      );
    }
    return problems.length === 0
      ? [true, `${action.ranges.length} range(s) aligned to ${input.limits.tickSpacing}, widths ok`]
      : [false, problems.join("; ")];
  });

  // 17. fence-precheck: the contract's placement fence at every tick the contract could see.
  run("fence-precheck", () => {
    if (action?.kind !== "rerange" || action.ranges.length === 0)
      return [true, `${kind}: no placement`];
    if (lane === null) return [false, "no fence reference"];
    const { tick: ref, bandTicks: band, code } = lane.refTick;
    if (code !== 0) return [false, `refTick code ${code}`];
    if (!lane.riskAddingOpen.open)
      return [false, `riskAddingOpen false (code ${lane.riskAddingOpen.code})`];
    const bad = action.ranges.filter(
      (r) => !fenceAllowsAcross(r, action.expectedTick, action.maxTickDelta, ref, band),
    );
    return bad.length === 0
      ? [
          true,
          `inside the fence ${ref} ± ${band} for ticks ${action.expectedTick} ± ${action.maxTickDelta}`,
        ]
      : [
          false,
          `outside the fence ${ref} ± ${band}: ${bad.map((r) => `[${r.tickLower}, ${r.tickUpper})`).join(", ")}`,
        ];
  });

  // 18. overlay-tighten-only: final ≤ deterministic, and this step belongs to the final plan.
  run("overlay-tighten-only", () => {
    const t = tightenCheck(input.plans.deterministic, input.plans.final);
    const problems = [...t.violations];
    if (
      input.overlay.source === "llm" &&
      input.overlay.applied &&
      input.overlay.tighten?.ok !== true
    ) {
      problems.push("overlay record says its tighten-check failed");
    }
    if (
      action !== undefined &&
      action !== null &&
      !input.plans.final.actions.some((a) => sameAction(a, action))
    ) {
      problems.push("this step is not in the final plan");
    }
    return problems.length === 0
      ? [true, "final plan ≤ deterministic plan"]
      : [false, problems.join("; ")];
  });

  // 19. simulation-ok: eth_call from the signer at a block ≤ 20 blocks old.
  run("simulation-ok", () => {
    if (!onchain) return [true, `${kind}: no on-chain simulation`];
    const sim = input.simulation;
    if (sim === null) return [false, "not simulated"];
    const problems: string[] = [];
    if (sim.ok !== true || sim.error !== null)
      problems.push(
        `simulation failed: ${sim.error?.errorName ?? sim.error?.message ?? "unknown"}`,
      );
    if (lower(sim.from) !== lower(input.expected.signerAddress))
      problems.push(`simulated from ${sim.from}, not the signer`);
    const age = sim.latestBlockNumber - sim.blockNumber;
    if (age < 0n || age > BigInt(input.limits.maxSimBlockAge))
      problems.push(`simulated block is ${age} blocks old`);
    if (isAddingRerange && sim.rerange === null) problems.push("rerange return values missing");
    return problems.length === 0
      ? [true, `eth_call ok at block ${sim.blockNumber} (${age} behind)`]
      : [false, problems.join("; ")];
  });

  // 20. signer-binding: signer == on-chain operator(), never the owner.
  run("signer-binding", () => {
    if (!onchain) return [true, `${kind}: no lane signer`];
    if (lane === null) return [false, "operator unknown (no chain read)"];
    const signer = lower(input.expected.signerAddress);
    const problems: string[] = [];
    if (lower(lane.operator) !== signer)
      problems.push(`signer is not the lane operator ${lane.operator}`);
    if (lower(lane.owner) === signer) problems.push("signer is the lane OWNER");
    if (lower(input.snapshot.signerAddress) !== signer) problems.push("snapshot signer differs");
    return problems.length === 0
      ? [true, "signer is the lane's operator, not its owner"]
      : [false, problems.join("; ")];
  });

  // 21. lane-not-paused (adding only)
  run("lane-not-paused", () => {
    if (!adding) return [true, BYPASS];
    if (isHedge) return [true, "hedge: HL venue"];
    if (lane === null) return [false, "pause state unknown"];
    return lane.paused ? [false, "lane is paused"] : [true, "lane not paused"];
  });

  // 22. single-in-flight
  run("single-in-flight", () => {
    if (!onchain) return [true, `${kind}: not a lane transaction`];
    const n = input.inFlight;
    return Number.isInteger(n) && n === 0
      ? [true, "no transaction in flight"]
      : [false, `${n} transaction(s) in flight for this signer`];
  });

  // 23. deadline-sane: now + 5 ≤ deadline ≤ now + 60 (and ≤ the lane's maxDeadlineAhead).
  run("deadline-sane", () => {
    if (!onchain) return [true, `${kind}: no deadline`];
    if (kind === "pause") return [true, "pause takes no Meta"];
    if (input.meta === null) return [false, "no Meta deadline"];
    const d = input.meta.deadline;
    const lo = BigInt(nowSec + input.limits.deadlineMinAheadSec);
    let maxAhead = input.limits.deadlineMaxAheadSec;
    if (lane !== null) maxAhead = Math.min(maxAhead, lane.caps.maxDeadlineAhead);
    const hi = BigInt(nowSec + maxAhead);
    return d >= lo && d <= hi
      ? [true, `deadline ${d} in [${lo}, ${hi}]`]
      : [false, `deadline ${d} outside [${lo}, ${hi}]`];
  });

  // 24. hl-order: paper, or live with both arms.
  run("hl-order", () => {
    if (!isHedge || action?.kind !== "hedge") return [true, "not an HL order"];
    const problems: string[] = [];
    if (action.tif !== "Alo" && action.tif !== "Ioc") problems.push(`tif ${action.tif}`);
    if (!/^\d+(\.\d+)?$/.test(action.px) || !/^\d+(\.\d+)?$/.test(action.sz))
      problems.push("px/sz are not decimal strings");
    if (input.flags.hlMode === "live") {
      if (!input.flags.hlArmed) problems.push("HL_MODE=live without HL_ARM=1");
      if (!input.flags.armed) problems.push("HL_MODE=live without DESK_ARM=1");
    } else if (input.flags.hlMode !== "paper")
      problems.push(`unknown HL mode ${input.flags.hlMode}`);
    return problems.length === 0
      ? [true, `HL ${input.flags.hlMode} order`]
      : [false, problems.join("; ")];
  });

  // 25. dry-run: always last; decides only when everything else passed.
  const dryRun = input.flags.dryRun !== false;
  checks.push({
    rule: "dry-run",
    passed: true,
    detail:
      violations.length > 0
        ? `DRY_RUN=${dryRun}; moot: blocked by ${violations.length} violation(s)`
        : dryRun
          ? "DRY_RUN held fire: every check passed, nothing signed"
          : "DRY_RUN off: execution authorised",
  });

  const decision: GuardResult["decision"] =
    violations.length > 0 ? "blocked" : dryRun ? "dry-run" : "execute";
  const first = violations[0];
  return {
    decision,
    violations,
    checks,
    reason:
      first !== undefined
        ? `blocked by ${first.rule}: ${first.detail}`
        : `all ${checks.length} checks passed`,
  };
}

export const guard: GuardFn = checkGuard;
