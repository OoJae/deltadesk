/**
 * Fork e2e: gate signals at the pinned Saturday block (FORK_BLOCK_SATURDAY, default 66_851_211 =
 * Sat 2026-09-19 06:00 UTC), with the REAL Chainlink feeds and the stock fence closed
 * (MARKET_CLOSED, 5). The real agent (sensor, regime, strategy, critic, guard, write-ahead executor,
 * local operator key on loopback) announces the lane's weekend state with signal(Meta): the lane
 * emits LaneAction(SIGNAL) with the announced regime / gatesMask and the reasonHash of the stored
 * preimage, the reconciler matches it as ours, and every risk-adding step stays refused.
 *
 * Run it alone on one anvil pinned there:
 *   FORK_BLOCK_NUMBER=66851211 FORK_PREFETCH_RADIUS=0 pnpm test:fork test/fork/signal.test.ts
 * Otherwise it launches its own anvil at the Saturday block (an archive FORK_RPC_URL is required).
 */

import type { Abi } from "viem";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { ADDRESSES_4663 } from "../../src/addresses.js";
import { deskLaneAbi } from "../../src/executor/abi/DeskLane.js";
import { createDecisionUlidFactory, encodeDecisionId } from "../../src/executor/decision-id.js";
import { silentLogger } from "../../src/log.js";
import { regimeAt } from "../../src/market/calendar.js";
import { createLaneActionReconciler } from "../../src/reconcile/lane-actions.js";
import { hashOfPreimage } from "../../src/regime/signal.js";
import {
  type Address,
  GATE_BITS,
  type Hex,
  LANE_ACTION_NAMES,
  REGIME_CODE,
} from "../../src/types.js";
import { cupsFromEnv, type LaunchedFork, launchFork } from "./anvil.js";
import {
  assertDbMatchesChain,
  assertNoViolationExecuted,
  type GuardRecord,
  recordingGuard,
} from "./checks.js";
import { addressOf, coldForkOnly, deskUnderTest, Fork, KEYS } from "./kit.js";

const sharedUrl = inject("forkRpcUrl");
const SATURDAY_BLOCK = BigInt(process.env.FORK_BLOCK_SATURDAY ?? 66_851_211);
const A = ADDRESSES_4663;
const SIGNAL = LANE_ACTION_NAMES.indexOf("SIGNAL");
const MARKET_CLOSED = 5;
const TIMEOUT = 15 * 60_000;

interface Env {
  fork: Fork;
  factory: Address;
  feedCode: Hex;
  own: LaunchedFork | null;
}

async function saturdayFork(): Promise<Env> {
  const shared = new Fork(sharedUrl as string);
  if ((await shared.forkBlockNumber()) === SATURDAY_BLOCK) {
    return {
      fork: shared,
      factory: inject("forkFactory") as Address,
      feedCode: inject("forkFeedCode") as Hex,
      own: null,
    };
  }
  const upstream = process.env.FORK_RPC_URL;
  if (upstream === undefined || upstream === "") throw new Error("FORK_RPC_URL is not set");
  const own = await launchFork({
    forkUrl: upstream,
    blockNumber: SATURDAY_BLOCK.toString(),
    prefetchRadius: 0,
    stagedDir: inject("forkStagedDir") ?? undefined,
    computeUnitsPerSecond: cupsFromEnv(),
  });
  return { fork: new Fork(own.url), factory: own.factory, feedCode: own.feedCode, own };
}

describe.skipIf(sharedUrl === null)("fork @ the pinned Saturday block: gate signals", () => {
  let env: Env;
  let outer: Hex;

  beforeAll(async () => {
    env = await saturdayFork();
    outer = await env.fork.snapshot();
  }, TIMEOUT);
  afterAll(async () => {
    await env?.fork.revert(outer).catch(() => {});
    await env?.own?.stop();
  });

  it(
    "the agent announces the weekend state with signal(Meta) while every rerange stays refused",
    async () => {
      const { fork } = env;
      expect(regimeAt(await fork.latestTs()).name).toBe("WEEKEND_DARK");
      const lane = await fork.createLane({
        factory: env.factory,
        owner: KEYS.owner,
        operator: addressOf(KEYS.operator),
        salt: 4665n,
      });
      const mid = await fork.poolMid();
      await fork.deal(A.USDG, lane, 25_000_000n);
      await fork.deal(A.NVDA, lane, BigInt(Math.round((25 / mid) * 1e18)));
      expect(
        await fork.pub.readContract({
          address: lane,
          abi: deskLaneAbi as Abi,
          functionName: "riskAddingOpen",
        }),
      ).toEqual([false, MARKET_CLOSED]);

      const guards: GuardRecord[] = [];
      const d = await deskUnderTest({
        fork,
        lane,
        feedCode: env.feedCode,
        deps: { guard: recordingGuard(guards) },
        env: { DESK_SIGNAL_GATES: "1" }, // copilot asks; the kit's gate approves
      });
      d.off.hl.mid = mid; // HL follows the pool: the references are fresh
      const operator = addressOf(KEYS.operator);

      // Past the startup hold the lane's first state goes out: one signal, executed.
      let executed: string | null = null;
      for (let i = 0; i < 10 && executed === null; i++) {
        const out = await d.tick();
        if (out.kind !== "decision") continue;
        if (out.status === "blocked" && coldForkOnly(d, out.decisionId)) continue;
        expect(out.status).toBe("executed");
        executed = out.decisionId;
      }
      if (executed === null) throw new Error("no signal executed");
      const g = d.db.getGateSignal(executed);
      if (g === null) throw new Error("no gate signal row");
      expect(g).toMatchObject({ initial: true, toRegime: "WEEKEND_DARK", status: "confirmed" });
      expect(g.gatesMask & GATE_BITS.CLOSED).toBe(GATE_BITS.CLOSED);
      expect(hashOfPreimage(g.preimageJson)).toBe(g.reasonHash);
      expect(d.db.getDecision(executed)).toMatchObject({
        riskMode: "reduce_only",
        approvalMode: "copilot",
        approvalOutcome: "approved",
      });

      // The lane logged it: SIGNAL, the operator, the announced state, the preimage's hash.
      const actions = await assertDbMatchesChain(fork, d, lane);
      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({
        action: SIGNAL,
        decisionId: encodeDecisionId(executed, 0),
        regime: REGIME_CODE.WEEKEND_DARK,
        gatesMask: g.gatesMask,
        reasonHash: g.reasonHash,
        caller: operator,
      });

      // The reconciler matches it as ours: the desk stays active.
      const forkBlock = await fork.forkBlockNumber();
      const report = await createLaneActionReconciler({
        db: d.db,
        chain: d.chain,
        lanes: () => [lane],
        clock: d.clock,
        logger: silentLogger,
        confirmations: 0,
        startBlock: () => forkBlock + 1n,
      }).run(d.clock.now());
      expect(report).toMatchObject({ matched: 1, foreign: 0 });
      expect(d.db.getDesk(lane)?.status).toBe("active");

      // Risk-adding stays refused: the lane reverts a rerange MarketClosed(5), nothing more signs.
      const rt = d.deps.lanes()[0];
      if (rt === undefined) throw new Error("no lane runtime");
      const now = d.clock.now();
      const ulid = createDecisionUlidFactory()(now);
      const { tick } = await fork.slot0();
      const c = Math.floor(tick / 10) * 10;
      const prepared = await rt.executor.prepare({
        decisionId: ulid,
        step: 0,
        lane: "A",
        laneAddress: lane,
        action: {
          kind: "rerange",
          lane: "A",
          ranges: [{ tickLower: c - 100, tickUpper: c + 110, share0Bps: 5_000, share1Bps: 5_000 }],
          expectedTick: tick,
          maxTickDelta: 10,
        },
        meta: {
          decisionId: encodeDecisionId(ulid, 0),
          deadline: BigInt(Math.floor(now / 1000) + 45),
          regime: 0,
          gatesMask: 0,
          reasonHash: `0x${"00".repeat(32)}`,
        },
        riskClass: "adding",
        notionalCents: 2_500,
      });
      expect(prepared.simulation?.error).toMatchObject({
        code: "SIM_POLICY",
        errorName: "MarketClosed",
      });
      for (let i = 0; i < 4; i++) await d.tick();
      expect(d.signer.requests).toHaveLength(1);
      expect(
        d.db.recentExecutions(100, lane).map((e) => [e.action, e.riskClass, e.status]),
      ).toEqual([["signal", "neutral", "confirmed"]]);
      assertNoViolationExecuted(d, lane, guards);
    },
    TIMEOUT,
  );
});
