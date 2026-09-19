/**
 * Fork property (fast-check, 50 runs): random price paths and timing against the real desk and the
 * real contracts. Every run starts from the same funded, empty lane (evm_snapshot / evm_revert), a
 * fresh DB and a fresh daemon, then walks 2–4 steps. Each step moves the pool with a real swap
 * (±120 ticks), lets HL drift from the pool (±40 bp, so single-sided placements occur), jitters the
 * Chainlink reference (±30 bp, so the fence bites), sometimes raises a trading halt, warps 20 s to
 * 15 min, and runs two ticks.
 *
 * After every step:
 *   - no guard violation was ever executed (a recording guard wraps the real checkGuard);
 *   - contract invariants: NFT bookkeeping == NPM, ≤ 2 positions, all owned by the lane, zero
 *     allowances left to the NPM, never paused by the agent;
 *   - DB == chain: every LaneAction is one of our confirmed executions (and vice versa), with the
 *     committed reasonHash, and the DB's fail-closed turnover covers the lane's spent bucket.
 */

import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import type { Address, Hex } from "../../src/types.js";
import {
  assertDbMatchesChain,
  assertLaneInvariants,
  assertNoViolationExecuted,
  type GuardRecord,
  recordingGuard,
} from "./checks.js";
import { deskUnderTest, Fork, setupLane } from "./kit.js";

const url = inject("forkRpcUrl");
const factory = inject("forkFactory") as Address | null;
const feedCode = inject("forkFeedCode") as Hex | null;
const RUNS = Number(process.env.FORK_PROPERTY_RUNS ?? 50);
const SEED = Number(process.env.FORK_PROPERTY_SEED ?? 4663);

const step = fc.record({
  dTick: fc.integer({ min: -120, max: 120 }),
  gapBps: fc.integer({ min: -40, max: 40 }),
  refNoiseBps: fc.integer({ min: -30, max: 30 }),
  dtSec: fc.integer({ min: 20, max: 900 }),
  halt: fc.integer({ min: 0, max: 9 }).map((n) => n === 0),
});
const path = fc.array(step, { minLength: 2, maxLength: 4 });

describe.skipIf(url === null)("fork property: price paths never execute a guard violation", () => {
  let fork: Fork;
  let lane: Address;
  let outer: Hex;
  let base: Hex;
  let baseTs: number;
  let startTick: number;

  beforeAll(async () => {
    fork = new Fork(url as string);
    outer = await fork.snapshot();
    lane = await setupLane(fork, { factory: factory as Address, feedCode: feedCode as Hex }, 2n);
    baseTs = await fork.latestTs();
    startTick = (await fork.slot0()).tick;
    base = await fork.snapshot();
  }, 300_000);
  afterAll(async () => {
    await fork?.revert(outer);
  });

  it(
    `${RUNS} runs: guard, contract invariants and DB == chain hold at every step`,
    async () => {
      const tally = { runs: 0, steps: 0, decisions: 0, executed: 0, blocked: 0, halts: 0 };
      const t0 = Date.now();
      await fc.assert(
        fc.asyncProperty(path, async (steps) => {
          await fork.assertUpstreamAlive(); // fail fast and plainly on an expired non-archive fork
          await fork.revert(base);
          base = await fork.snapshot();
          await fork.setNextTimestamp(baseTs + 1);
          const guards: GuardRecord[] = [];
          const d = await deskUnderTest({
            fork,
            lane,
            feedCode: feedCode as Hex,
            deps: { guard: recordingGuard(guards) },
          });
          await d.follow();
          for (let i = 0; i < 3; i++) await d.tick(); // dwell, then (usually) the initial mint
          const check = async () => {
            assertNoViolationExecuted(d, lane, guards);
            await assertLaneInvariants(fork, lane);
            await assertDbMatchesChain(fork, d, lane);
          };
          await check();
          for (const s of steps) {
            const { tick } = await fork.slot0();
            const target = Math.max(startTick - 250, Math.min(startTick + 250, tick + s.dTick));
            await fork.movePoolTo(target);
            await d.follow({ gapBps: s.gapBps, refNoiseBps: s.refNoiseBps });
            d.off.rh.halt = s.halt;
            await fork.warp(s.dtSec);
            await fork.warm(lane);
            await d.tick();
            await d.tick();
            await check();
            tally.steps += 1;
            if (s.halt) tally.halts += 1;
          }
          const decisions = d.db.recentDecisions(1_000, lane);
          tally.runs += 1;
          const executed = decisions.filter((x) => x.status === "executed").length;
          console.warn(
            `[fork] property run ${tally.runs}/${RUNS}: ${steps.length} steps, ${decisions.length} decisions (${executed} executed), ${Math.round((Date.now() - t0) / 1000)} s elapsed`,
          );
          tally.decisions += decisions.length;
          tally.executed += decisions.filter((x) => x.status === "executed").length;
          tally.blocked += decisions.filter((x) => x.status === "blocked").length;
        }),
        { numRuns: RUNS, seed: SEED, endOnFailure: true },
      );
      console.warn(`[fork] property tally ${JSON.stringify(tally)}`);
      // Not vacuous: the desk really traded on most paths.
      expect(tally.executed).toBeGreaterThanOrEqual(RUNS);
    },
    45 * 60_000,
  );
});
