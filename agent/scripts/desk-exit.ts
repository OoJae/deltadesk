// `pnpm desk-exit [--lane 0x…]`: an operator exitAll for one lane, outside the tick loop (the
// human's "flatten now" when the daemon is down). Risk-REDUCING, so no freshness, regime, hurdle or
// approval gate applies; the non-bypassable rules still do: arm flag, dry-run, allowlist (to = the
// configured lane, selector = exitAll), idempotency (DB + on-chain decisionUsedAt), simulation,
// signer binding (operator, never owner), single in flight and a sane deadline. It goes through the
// same write-ahead executor as the daemon and leaves a full decision row.
//
// With DRY_RUN=true (the default) it simulates and records a `dry_run` decision, and signs nothing.
// The owner's own exit needs no agent at all: /desk signs exitAll + withdrawAll with the Vault.

import { pathToFileURL } from "node:url";
import { canonicalJson, keccakJson, reasonHashOf } from "../src/canonical.js";
import { assertSignerBinding, getConfig } from "../src/config.js";
import { OPERATOR_SELECTORS } from "../src/executor/abi/DeskLane.js";
import { createChainClient, createLaneViews } from "../src/executor/chain.js";
import { encodeDecisionId, newDecisionUlid } from "../src/executor/decision-id.js";
import { rhExecutorFromConfig } from "../src/executor/wire.js";
import { createLogger } from "../src/log.js";
import { regimeAt } from "../src/market/calendar.js";
import { signerFromConfig } from "../src/signer/factory.js";
import { openDb } from "../src/state/db.js";
import {
  type Address,
  type ChainClient,
  type Clock,
  type DeskDb,
  type Executor,
  type GuardCheck,
  LANE_BY_ID,
  REGIME_CODE,
  type StepOutcome,
  type StepRequest,
  type TxSigner,
} from "../src/types.js";

export interface DeskExitDeps {
  db: DeskDb;
  chain: ChainClient;
  executor: Executor;
  signer: TxSigner;
  lane: Address;
  chainId: number;
  armed: boolean;
  dryRun: boolean;
  deadlineSec: number;
  clock: Clock;
}

export interface DeskExitReport {
  decisionId: string;
  status: "dry_run" | "blocked" | "executed" | "failed";
  checks: GuardCheck[];
  outcome: StepOutcome | null;
}

export async function runDeskExit(d: DeskExitDeps): Promise<DeskExitReport> {
  const rpcChainId = await d.chain.chainId();
  if (rpcChainId !== d.chainId)
    throw new Error(`RPC reports chain ${rpcChainId}, expected ${d.chainId}`);
  const lane = d.lane.toLowerCase() as Address;
  const block = await d.chain.getBlock("latest");
  const views = createLaneViews(d.chain);
  const id = await views.identity(lane, block.number);
  assertSignerBinding(d.signer.address, id);

  const now = d.clock.now();
  const nowSec = Math.floor(now / 1000);
  const ulid = newDecisionUlid(now);
  const onchainId = encodeDecisionId(ulid, 0);
  const regime = regimeAt(now / 1000);
  const letter = LANE_BY_ID[id.laneId] ?? "A";
  const action = { kind: "exitAll" as const, lane: letter };
  const plan = { source: "desk-exit", lane, actions: [action] };
  const snapshot = {
    lane,
    blockNumber: block.number,
    blockTimestamp: block.timestamp,
    owner: id.owner,
    operator: id.operator,
    paused: id.paused,
  };
  const reason = reasonHashOf({
    finalPlan: plan,
    guardChecks: [],
    snapshotDigest: keccakJson(snapshot),
  });
  const deadline = BigInt(nowSec + d.deadlineSec);
  const req: StepRequest = {
    decisionId: ulid,
    step: 0,
    lane: letter,
    laneAddress: lane,
    action,
    meta: {
      decisionId: onchainId,
      deadline,
      regime: REGIME_CODE[regime.name],
      gatesMask: 0,
      reasonHash: reason.hash,
    },
    riskClass: "reducing",
    notionalCents: 0,
  };
  d.db.insertDecision({
    decisionId: ulid,
    laneAddress: lane,
    lane: letter,
    createdAtMs: now,
    updatedAtMs: now,
    regime: regime.name,
    regimeCode: REGIME_CODE[regime.name],
    gatesMask: 0,
    riskMode: "flat",
    snapshotJson: canonicalJson(snapshot),
    planJson: canonicalJson(plan),
    overlayId: null,
    finalPlanJson: canonicalJson(plan),
    reasonHash: reason.hash,
    reasonPreimage: reason.preimage,
    planCriticVerdict: "APPROVE",
    planCriticReason: "operator exit requested by a human (scripts/desk-exit.ts)",
    guardDecision: null,
    guardViolationsJson: null,
    guardChecksJson: null,
    approvalMode: null,
    approvalOutcome: "not_required",
    approvalChannel: null,
    status: "observed",
    statusDetail: null,
  });

  const prepared = await d.executor.prepare(req);
  const usedAt = await views.decisionUsedAt(lane, onchainId, block.number).catch(() => null);
  const check = (rule: GuardCheck["rule"], passed: boolean, detail: string): GuardCheck => ({
    rule,
    passed,
    detail,
  });
  const checks: GuardCheck[] = [
    check(
      "allowlist",
      prepared.call?.to === lane && prepared.call.selector === OPERATOR_SELECTORS.exitAll,
      `to ${prepared.call?.to}, selector ${prepared.call?.selector}`,
    ),
    check(
      "idempotency",
      !d.db.hasExecutionStep(ulid, 0) && usedAt === 0n,
      `db step free, decisionUsedAt=${usedAt}`,
    ),
    check("arm-flag", d.armed, d.armed ? "DESK_ARM=1" : "DESK_ARM=0"),
    check(
      "simulation-ok",
      prepared.simulation?.ok === true,
      prepared.simulation?.error?.message ?? "eth_call ok",
    ),
    check("signer-binding", true, `signer ${d.signer.address} is the operator, not the owner`),
    check(
      "single-in-flight",
      d.db.inFlightCount(d.signer.address) === 0,
      `${d.db.inFlightCount(d.signer.address)} in flight`,
    ),
    check(
      "deadline-sane",
      deadline >= BigInt(nowSec + 5) && deadline <= BigInt(nowSec + 60),
      `deadline now+${d.deadlineSec}s`,
    ),
    check("dry-run", !d.dryRun, d.dryRun ? "DRY_RUN=true" : "live"),
  ];
  const violations = checks.filter((c) => !c.passed);
  // Under DRY_RUN nothing can be signed, so an unarmed dry run is still a preview (both recorded).
  const onlyDryRun =
    d.dryRun && violations.every((v) => v.rule === "dry-run" || v.rule === "arm-flag");
  const guardDecision = violations.length === 0 ? "execute" : onlyDryRun ? "dry-run" : "blocked";
  const base = {
    guardDecision,
    guardChecksJson: canonicalJson(checks),
    guardViolationsJson: canonicalJson(violations.map((v) => ({ rule: v.rule, detail: v.detail }))),
    updatedAtMs: d.clock.now(),
  } as const;
  if (violations.length > 0) {
    const status = onlyDryRun ? "dry_run" : "blocked";
    d.db.updateDecision(ulid, {
      ...base,
      status,
      statusDetail: violations.map((v) => v.rule).join(", "),
    });
    return { decisionId: ulid, status, checks, outcome: null };
  }
  d.db.updateDecision(ulid, { ...base, status: "executing" });
  const outcome = await d.executor.execute(prepared);
  const status = outcome.status === "confirmed" ? "executed" : "failed";
  d.db.updateDecision(ulid, {
    status,
    statusDetail: outcome.error?.message ?? outcome.txHash,
    updatedAtMs: d.clock.now(),
  });
  return { decisionId: ulid, status, checks, outcome };
}

async function main(argv: string[]): Promise<number> {
  const cfg = await getConfig();
  const i = argv.indexOf("--lane");
  const lane = ((i >= 0 ? argv[i + 1] : undefined) ?? cfg.lanes.A)?.toLowerCase() as
    | Address
    | undefined;
  if (lane === undefined) throw new Error("pass --lane 0x… or set DESK_LANE_A");
  const logger = createLogger({ level: cfg.logLevel, service: "desk-exit" });
  const chain = createChainClient({
    rpcUrl: cfg.rpcUrl,
    fallbackUrl: cfg.rpcFallbackUrl,
    chainId: cfg.chainId,
  });
  const db = openDb(cfg.paths.dbPath);
  const clock = { now: () => Date.now() };
  try {
    const { operator } = await createLaneViews(chain).identity(lane, await chain.blockNumber());
    const signer = signerFromConfig(cfg, db, operator);
    const executor = rhExecutorFromConfig({
      cfg,
      laneAddress: lane,
      db,
      chain,
      signer,
      clock,
      logger,
    });
    const r = await runDeskExit({
      db,
      chain,
      executor,
      signer,
      lane,
      chainId: cfg.chainId,
      armed: cfg.safety.armed,
      dryRun: cfg.safety.dryRun,
      deadlineSec: cfg.timing.deadlineSec,
      clock,
    });
    for (const c of r.checks) console.log(`${c.passed ? "ok  " : "FAIL"} ${c.rule}: ${c.detail}`);
    console.log(
      `decision ${r.decisionId}: ${r.status}${r.outcome?.txHash ? ` tx ${r.outcome.txHash}` : ""}`,
    );
    return r.status === "executed" || r.status === "dry_run" ? 0 : 1;
  } finally {
    db.close();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}
