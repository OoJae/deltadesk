/**
 * Fork e2e at the pinned Saturday block (FORK_BLOCK_SATURDAY, default 66_851_211 = Sat 2026-09-19
 * 06:00:00 UTC, the contracts' fork suites use the same one) with the REAL Chainlink feeds: no
 * MockFeed, no warp. The stock fence is in its weekend window there (Sat 00:00 → Mon 01:00 UTC), so
 * it reports MARKET_CLOSED (5) for NVDA while the feed itself is alive (last round Fri 20:00 ET).
 *
 * The desk under test is the real agent (sensor, regime, strategy, critic, guard, write-ahead
 * executor, local operator key on loopback). What it must show, end to end:
 *   - every risk-adding step is refused, at every layer: the regime (CLOSED → reduce-only), the
 *     strategy even when the regime is forced open (lane closed, code 5), and the lane itself when
 *     a rerange is simulated through the executor (MarketClosed(5), decoded by name); nothing is
 *     ever signed for it;
 *   - exitAll still runs: a trading halt flattens a live position without asking anyone.
 *
 * A pinned Saturday block cannot mint (that is the point), so the lane's live position is planted:
 * an NPM position minted on the real pool with the lane as recipient, recorded in the lane's
 * position slot 0 (storage slot 13 of DeskLaneCore, checked through positions()). It stands in for
 * a position minted on Friday before the window closed.
 *
 * The second suite measures the gas of an initial mint and of a typical rerange (unwind one, mint
 * one) on the same fork, for agent/README.md "Economics at M2 size". It needs a weekday, so it warps
 * to Monday's session, where the real rounds are dead (> 26 h): it uses the kit's MockFeed, after
 * the weekend suite reverted every change.
 *
 * Run on its own with the shared fork pinned there (one anvil, no prefetch):
 *   FORK_BLOCK_NUMBER=66851211 FORK_PREFETCH_RADIUS=0 pnpm test:fork test/fork/weekend.test.ts
 * Otherwise it launches its own anvil at the Saturday block (an archive FORK_RPC_URL is required).
 */

import {
  type Abi,
  decodeEventLog,
  encodeFunctionData,
  maxUint256,
  parseAbi,
  parseAbiItem,
  toEventSelector,
} from "viem";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { ADDRESSES_4663 } from "../../src/addresses.js";
import { STRATEGY_DEFAULTS } from "../../src/config.js";
import { deskLaneAbi } from "../../src/executor/abi/DeskLane.js";
import { priceFenceAbi } from "../../src/executor/abi/PriceFence.js";
import { createCalldataBuilder } from "../../src/executor/calldata.js";
import { createDecisionUlidFactory, encodeDecisionId } from "../../src/executor/decision-id.js";
import { gasLimitFor } from "../../src/executor/fees.js";
import { regimeAt } from "../../src/market/calendar.js";
import { computeRegime, defaultRegimeDeps } from "../../src/regime/index.js";
import { createGateMachine } from "../../src/regime/machine.js";
import { createLaneStrategy } from "../../src/strategy/lanes.js";
import { type Address, type Hex, LANE_ACTION_NAMES, type RegimeState } from "../../src/types.js";
import { cupsFromEnv, type LaunchedFork, launchFork } from "./anvil.js";
import {
  assertDbMatchesChain,
  assertLaneInvariants,
  assertNoViolationExecuted,
  type GuardRecord,
  recordingGuard,
} from "./checks.js";
import {
  addressOf,
  coldForkOnly,
  type DeskUnderTest,
  deskUnderTest,
  Fork,
  KEYS,
  nextSessionTs,
} from "./kit.js";

const sharedUrl = inject("forkRpcUrl");
const SATURDAY_BLOCK = BigInt(process.env.FORK_BLOCK_SATURDAY ?? 66_851_211);
const A = ADDRESSES_4663;
const EXIT_ALL = LANE_ACTION_NAMES.indexOf("EXIT_ALL");
const MARKET_CLOSED = 5;
/** DeskLaneCore: _operator … _rr24h occupy slots 0–12, then uint256[2] _tokenIds. */
const TOKEN_IDS_SLOT = 13n;
const TIMEOUT = 15 * 60_000;

const npmAbi = parseAbi([
  "struct MintParams { address token0; address token1; uint24 fee; int24 tickLower; int24 tickUpper; uint256 amount0Desired; uint256 amount1Desired; uint256 amount0Min; uint256 amount1Min; address recipient; uint256 deadline; }",
  "function mint(MintParams params) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
  "function balanceOf(address) view returns (uint256)",
]);
const erc20 = parseAbi(["function approve(address,uint256) returns (bool)"]);
const transferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
);

interface Env {
  fork: Fork;
  factory: Address;
  feedCode: Hex;
  own: LaunchedFork | null;
}

/** The shared fork when it is pinned at the Saturday block, else a fork of our own there. */
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

/** A lane created now (no warp) and funded with ≈ $25 of each token at the pool price. */
async function createFundedLane(env: Env, salt: bigint): Promise<Address> {
  const { fork } = env;
  const lane = await fork.createLane({
    factory: env.factory,
    owner: KEYS.owner,
    operator: addressOf(KEYS.operator),
    salt,
  });
  const mid = await fork.poolMid();
  await fork.deal(A.USDG, lane, 25_000_000n);
  await fork.deal(A.NVDA, lane, BigInt(Math.round((25 / mid) * 1e18)));
  return lane;
}

/**
 * Plant a live position: mint ≈ $10 + $10 on the real pool around the current tick with the lane
 * as the NFT recipient, then record it in the lane's slot 0 (verified through positions()).
 */
async function plantPosition(fork: Fork, lane: Address): Promise<bigint> {
  const minter = addressOf(KEYS.swapper);
  const { tick } = await fork.slot0();
  const mid = await fork.poolMid();
  const amount0 = 10_000_000n;
  const amount1 = BigInt(Math.round((10 / mid) * 1e18));
  await fork.deal(A.USDG, minter, amount0);
  await fork.deal(A.NVDA, minter, amount1);
  for (const token of [A.USDG, A.NVDA] as const)
    await fork.send(
      KEYS.swapper,
      token,
      encodeFunctionData({ abi: erc20, functionName: "approve", args: [A.NPM, maxUint256] }),
    );
  const r = await fork.send(
    KEYS.swapper,
    A.NPM,
    encodeFunctionData({
      abi: npmAbi,
      functionName: "mint",
      args: [
        {
          token0: A.USDG,
          token1: A.NVDA,
          fee: 500,
          tickLower: Math.floor((tick - 100) / 10) * 10,
          tickUpper: Math.ceil((tick + 100) / 10) * 10,
          amount0Desired: amount0,
          amount1Desired: amount1,
          amount0Min: 0n,
          amount1Min: 0n,
          recipient: lane,
          deadline: BigInt((await fork.latestTs()) + 600),
        },
      ],
    }),
  );
  const minted = r.logs.find(
    (l) =>
      l.address.toLowerCase() === A.NPM.toLowerCase() &&
      l.topics[0] === toEventSelector(transferEvent),
  );
  if (minted === undefined) throw new Error("NPM mint emitted no Transfer");
  const { args } = decodeEventLog({
    abi: [transferEvent],
    data: minted.data,
    topics: minted.topics as [Hex, ...Hex[]],
  });
  await fork.setStorage(lane, `0x${TOKEN_IDS_SLOT.toString(16).padStart(64, "0")}`, args.tokenId);
  const ids = (await fork.pub.readContract({
    address: lane,
    abi: deskLaneAbi,
    functionName: "positions",
  })) as readonly bigint[];
  if (ids[0] !== args.tokenId)
    throw new Error(
      `DeskLaneCore storage layout changed: _tokenIds is not at slot ${TOKEN_IDS_SLOT}`,
    );
  return args.tokenId;
}

/** HL follows the pool (the regime needs a fresh reference); the Chainlink feeds are never touched. */
async function followPoolOnly(d: DeskUnderTest, fork: Fork) {
  d.off.hl.mid = await fork.poolMid();
}

describe.skipIf(sharedUrl === null)("fork @ the pinned Saturday block", () => {
  let env: Env;

  beforeAll(async () => {
    env = await saturdayFork();
  }, TIMEOUT);
  afterAll(async () => {
    await env?.own?.stop();
  });

  describe("real Chainlink feeds", () => {
    let outer: Hex;
    beforeAll(async () => {
      outer = await env.fork.snapshot();
    });
    afterAll(async () => {
      await env.fork.revert(outer);
    });

    it(
      "the fence reports MARKET_CLOSED (5); the agent refuses every risk-adding step and still exits",
      async () => {
        const { fork } = env;
        const ts = await fork.latestTs();
        expect(regimeAt(ts).name).toBe("WEEKEND_DARK");
        // The real feeds: no MockFeed anywhere; the fence is closed for the stock only.
        for (const feed of [A.CL_NVDA_USD, A.CL_USDG_USD]) {
          const code = await fork.pub.getCode({ address: feed });
          expect(code?.toLowerCase()).not.toBe(env.feedCode.toLowerCase());
        }
        const lane = await createFundedLane(env, 4663n);
        const views = (functionName: "fence" | "riskAddingOpen" | "refTick"): Promise<unknown> =>
          fork.pub.readContract({ address: lane, abi: deskLaneAbi as Abi, functionName });
        const fence = (await views("fence")) as Address;
        const fenceStatus = (token: Address) =>
          fork.pub.readContract({
            address: fence,
            abi: priceFenceAbi,
            functionName: "status",
            args: [token],
          });
        expect(await fenceStatus(A.NVDA)).toBe(MARKET_CLOSED);
        expect(await fenceStatus(A.USDG)).toBe(0);
        expect(await views("riskAddingOpen")).toEqual([false, MARKET_CLOSED]);
        const [, , refCode] = (await views("refTick")) as readonly [number, number, number];
        expect(refCode).toBe(MARKET_CLOSED);

        const guards: GuardRecord[] = [];
        const d = await deskUnderTest({
          fork,
          lane,
          feedCode: env.feedCode,
          deps: { guard: recordingGuard(guards) },
        });
        await followPoolOnly(d, fork);
        const operator = addressOf(KEYS.operator);
        const nonce0 = await fork.pub.getTransactionCount({ address: operator });
        const rt = d.deps.lanes()[0];
        if (rt === undefined) throw new Error("no lane runtime");

        // 1. The regime: CLOSED (the calendar and the lane) → reduce-only; the funded, empty lane
        //    is never minted.
        for (let i = 0; i < 4; i++) {
          const out = await d.tick();
          expect(out.kind === "decision" && out.status === "executed").toBe(false);
        }
        const tick = d.db.lastTick(lane);
        expect(tick?.fenceCode).toBe(MARKET_CLOSED);
        expect(tick?.riskMode).toBe("reduce_only");
        expect(JSON.parse(tick?.activeGatesJson ?? "[]")).toContain("CLOSED");
        expect(d.signer.requests).toHaveLength(0);

        // 2. The strategy with the regime forced open: the initial mint is due, the lane is closed.
        const snapshot = await rt.sensor.read("A", lane);
        expect(snapshot.chain?.lane.riskAddingOpen).toEqual({ open: false, code: MARKET_CLOSED });
        expect(snapshot.chain?.chainlink.nvda?.price).toBeGreaterThan(0); // the real round, alive
        const now = d.clock.now();
        const machine = createGateMachine({ startActive: false });
        const computed = computeRegime(
          { ...defaultRegimeDeps, machine },
          snapshot,
          machine.initial(now),
          now,
        );
        const open: RegimeState = { ...computed, riskMode: "normal", activeGates: [] };
        const forced = createLaneStrategy({ maxActionCents: 6_000 }).plan({
          lane: "A",
          snapshot,
          regime: open,
          laneState: {
            lane: "A",
            laneAddress: lane,
            gates: open.gates,
            outsideInnerTicks: 0,
            rerangeNotBeforeMs: null,
            safeMode: null,
            lastTickAtMs: null,
            lastDecisionId: null,
            brain: "deterministic",
          },
          params: STRATEGY_DEFAULTS,
          agentRerange: {
            lastRerangeAtMs: null,
            count1h: 0,
            count24h: 0,
            maxPerHour: 4,
            maxPerDay: 24,
            minIntervalMs: 300_000,
          },
          hourRecord: { fees_usd: 1e9 },
          gasQuote: null,
          nowMs: now,
          random: () => 0,
        });
        expect(forced.trigger).toBe("initial_mint");
        expect(forced.actions.map((a) => a.kind)).toEqual(["hold"]);
        expect(forced.rationale.at(-1)).toBe(`lane closed to risk-adding (code ${MARKET_CLOSED})`);

        // 3. The lane: a rerange simulated through the agent's executor reverts MarketClosed(5),
        //    decoded by name; nothing is signed.
        const ulid = createDecisionUlidFactory()(now);
        const { tick: poolTick } = await fork.slot0();
        const c = Math.floor(poolTick / 10) * 10;
        const prepared = await rt.executor.prepare({
          decisionId: ulid,
          step: 0,
          lane: "A",
          laneAddress: lane,
          action: {
            kind: "rerange",
            lane: "A",
            ranges: [
              { tickLower: c - 100, tickUpper: c + 110, share0Bps: 5_000, share1Bps: 5_000 },
            ],
            expectedTick: poolTick,
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
        expect(prepared.simulation?.ok).toBe(false);
        expect(prepared.simulation?.error).toMatchObject({
          code: "SIM_POLICY",
          errorName: "MarketClosed",
          args: [MARKET_CLOSED],
        });
        expect(prepared.simulation?.error?.message).toMatch(/^lane reverted: MarketClosed \(/);
        expect(d.signer.requests).toHaveLength(0);

        // 4. exitAll still runs: a trading halt flattens a live position, no approval asked.
        const tokenId = await plantPosition(fork, lane);
        const exitCall = createCalldataBuilder(lane).encode(
          { kind: "exitAll", lane: "A" },
          {
            decisionId: `0x${"fe".repeat(32)}`,
            deadline: BigInt((await fork.latestTs()) + 60),
            regime: 0,
            gatesMask: 0,
            reasonHash: `0x${"00".repeat(32)}`,
          },
        );
        await fork.pub.call({ account: operator, to: lane, data: exitCall.data }); // warm the path
        await d.tick(); // the planted position is sensed (reduce-only: held)
        expect(d.signer.requests).toHaveLength(0);
        d.off.rh.halt = true;
        let exited = false;
        for (let i = 0; i < 6 && !exited; i++) {
          const out = await d.tick();
          if (out.kind !== "decision") continue;
          if (out.status === "blocked" && coldForkOnly(d, out.decisionId)) {
            await fork.warp(31);
            continue;
          }
          expect(out.status).toBe("executed");
          exited = true;
        }
        expect(exited).toBe(true);
        const decision = d.db.recentDecisions(1, lane)[0];
        expect(decision?.riskMode).toBe("flat");
        expect(decision?.approvalOutcome).toBe("not_required");
        const facts = await assertLaneInvariants(fork, lane);
        expect(facts.tokenIds).toEqual([]);
        expect(
          await fork.pub.readContract({
            address: A.NPM,
            abi: npmAbi,
            functionName: "balanceOf",
            args: [lane],
          }),
        ).toBe(0n);
        expect(facts.balances.usdg).toBeGreaterThan(25_000_000n); // the position's USDG, idle
        const actions = await assertDbMatchesChain(fork, d, lane);
        expect(actions.map((a) => a.action)).toEqual([EXIT_ALL]);
        assertNoViolationExecuted(d, lane, guards);
        expect(tokenId).toBeGreaterThan(0n);

        // Halt cleared, still the weekend: nothing more is ever signed.
        d.off.rh.halt = false;
        for (let i = 0; i < 3; i++) await d.tick();
        expect(d.signer.requests).toHaveLength(1); // the exitAll, and only it
        expect(
          d.db.recentExecutions(100, lane).map((e) => [e.action, e.riskClass, e.status]),
        ).toEqual([["exitAll", "reducing", "confirmed"]]);
        expect(await fork.pub.getTransactionCount({ address: operator })).toBe(nonce0 + 1);
      },
      TIMEOUT,
    );
  });

  describe("rerange gas (README economics)", () => {
    let outer: Hex;
    beforeAll(async () => {
      outer = await env.fork.snapshot();
    });
    afterAll(async () => {
      await env.fork.revert(outer);
    });

    it(
      "an initial mint and a typical rerange (unwind one, mint one) fit the strategy's gas budget",
      async () => {
        const { fork } = env;
        // A weekday session: the real rounds are frozen since Friday and dead after 26 h, so the
        // kit's always-fresh MockFeed stands in for them here (and only here).
        await fork.setNextTimestamp(nextSessionTs(await fork.latestTs()));
        await fork.pinBaseFee();
        await fork.setFeeds(env.feedCode, await fork.poolMid());
        const lane = await createFundedLane(env, 4664n);
        const operator = addressOf(KEYS.operator);
        const nextId = createDecisionUlidFactory();
        const rerange = async (lo: number, hi: number) => {
          const { tick } = await fork.slot0();
          const now = await fork.latestTs();
          const call = createCalldataBuilder(lane).encode(
            {
              kind: "rerange",
              lane: "A",
              ranges: [{ tickLower: lo, tickUpper: hi, share0Bps: 10_000, share1Bps: 10_000 }],
              expectedTick: tick,
              maxTickDelta: 10,
            },
            {
              decisionId: encodeDecisionId(nextId(now * 1000), 0),
              deadline: BigInt(now + 60),
              regime: 1,
              gatesMask: 0,
              reasonHash: `0x${"00".repeat(32)}`,
            },
          );
          const estimate = await fork.pub.estimateGas({
            account: operator,
            to: lane,
            data: call.data,
          });
          const receipt = await fork.send(KEYS.operator, lane, call.data);
          return { estimate, gasUsed: receipt.gasUsed, bytes: (call.data.length - 2) / 2 };
        };
        const { tick } = await fork.slot0();
        const c = Math.floor(tick / 10) * 10;
        const mint = await rerange(c - 100, c + 110);
        await fork.warp(301); // the lane's minimum rerange interval
        await fork.setFeeds(env.feedCode, await fork.poolMid());
        const typical = await rerange(c - 80, c + 130);
        const facts = await assertLaneInvariants(fork, lane);
        expect(facts.tokenIds).toHaveLength(1);
        console.warn(
          `[fork] rerange gas @ fork block ${await fork.forkBlockNumber()}: initial mint ${mint.gasUsed} (estimate ${mint.estimate}), typical rerange ${typical.gasUsed} (estimate ${typical.estimate}, agent gas limit ${gasLimitFor(typical.estimate)}), calldata ${typical.bytes} bytes`,
        );
        // The strategy's cost hurdle prices a rerange at STRATEGY_DEFAULTS.rerangeGasUnits (L2
        // execution + Orbit's L1 component); the L2 part measured here must sit well inside it.
        expect(typical.gasUsed).toBeLessThan(STRATEGY_DEFAULTS.rerangeGasUnits);
        expect(mint.gasUsed).toBeLessThan(STRATEGY_DEFAULTS.rerangeGasUnits);
      },
      TIMEOUT,
    );
  });
});
