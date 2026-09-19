/**
 * Fork e2e: the desk-agent against DeskLane contracts deployed with Deploy.s.sol on an anvil fork of
 * Robinhood Chain, signing as a local operator key (loopback only). Skips cleanly without
 * FORK_RPC_URL, anvil or forge (see global-setup.ts).
 *
 * Scenarios: initial mint; price move → rerange; HALT → exitAll; a crash between sign and
 * broadcast recovered with exactly one LaneAction; a wrong or tampered signer never broadcasts.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { createBroadcaster } from "../../src/executor/broadcaster.js";
import { silentLogger } from "../../src/log.js";
import { createAttemptResolver, createStartupReconciler } from "../../src/reconcile/startup.js";
import { createLocalSigner } from "../../src/signer/local.js";
import { openDb } from "../../src/state/db.js";
import { type Address, type ChainClient, type Hex, LANE_ACTION_NAMES } from "../../src/types.js";
import {
  assertDbMatchesChain,
  assertLaneInvariants,
  assertNoViolationExecuted,
  type GuardRecord,
  recordingGuard,
} from "./checks.js";
import { addressOf, deskUnderTest, Fork, KEYS, setupLane, untilDecision } from "./kit.js";

const url = inject("forkRpcUrl");
const factory = inject("forkFactory") as Address | null;
const feedCode = inject("forkFeedCode") as Hex | null;
const RERANGE = LANE_ACTION_NAMES.indexOf("RERANGE");
const EXIT_ALL = LANE_ACTION_NAMES.indexOf("EXIT_ALL");
/** Generous: a cold, non-archive upstream answers each first-touch storage read in about a second. */
const TIMEOUT = 15 * 60_000;

describe.skipIf(url === null)("fork e2e: the desk against DeskLane on anvil", () => {
  let fork: Fork;
  let lane: Address;
  let outer: Hex;
  let base: Hex;
  const env = () => ({ factory: factory as Address, feedCode: feedCode as Hex });

  beforeAll(async () => {
    fork = new Fork(url as string);
    outer = await fork.snapshot();
    lane = await setupLane(fork, env(), 1n);
    base = await fork.snapshot();
  }, TIMEOUT);
  afterEach(async () => {
    // anvil consumes a snapshot on revert: take a fresh one each time.
    await fork.revert(base);
    base = await fork.snapshot();
  });
  afterAll(async () => {
    await fork?.revert(outer);
  });

  it(
    "initial mint: the funded lane gets its first straddle around F",
    async () => {
      const guards: GuardRecord[] = [];
      const d = await deskUnderTest({
        fork,
        lane,
        feedCode: feedCode as Hex,
        deps: { guard: recordingGuard(guards) },
      });
      await d.follow();
      const out = await untilDecision(d, fork, lane);
      expect(out.status).toBe("executed");

      const facts = await assertLaneInvariants(fork, lane);
      expect(facts.tokenIds).toHaveLength(1);
      const actions = await assertDbMatchesChain(fork, d, lane);
      expect(actions.map((a) => a.action)).toEqual([RERANGE]);
      const { tick } = await fork.slot0();
      const [tl, tu] = actions[0]?.ticks ?? [];
      expect(tl).toBeLessThanOrEqual(tick);
      expect(tu).toBeGreaterThan(tick);
      assertNoViolationExecuted(d, lane, guards);
      // The next tick holds: the placement is live and the agent's interval has not elapsed.
      expect((await d.tick()).kind).toBe("hold");
    },
    TIMEOUT,
  );

  it(
    "price move → rerange: the pool leaves the inner band and the desk follows F",
    async () => {
      const guards: GuardRecord[] = [];
      const d = await deskUnderTest({
        fork,
        lane,
        feedCode: feedCode as Hex,
        deps: { guard: recordingGuard(guards) },
      });
      await d.follow();
      expect((await untilDecision(d, fork, lane)).status).toBe("executed");
      const first = (await fork.laneFacts(lane)).tokenIds[0];

      const { tick } = await fork.slot0();
      const moved = await fork.movePoolTo(tick + 90); // outside the inner 60% of ±100
      expect(Math.abs(moved - (tick + 90))).toBeLessThanOrEqual(1);
      await d.follow();
      await fork.warp(360); // past the lane's and the agent's 300 s minimum interval
      await fork.warm(lane);
      const out = await untilDecision(d, fork, lane);
      expect(out.status).toBe("executed");

      const facts = await assertLaneInvariants(fork, lane);
      expect(facts.tokenIds).toHaveLength(1);
      expect(facts.tokenIds[0]).not.toBe(first);
      const actions = await assertDbMatchesChain(fork, d, lane);
      expect(actions.map((a) => a.action)).toEqual([RERANGE, RERANGE]);
      const [tl, tu] = actions[1]?.ticks ?? [];
      expect(tl).toBeLessThanOrEqual(moved);
      expect(tu).toBeGreaterThan(moved);
      assertNoViolationExecuted(d, lane, guards);
    },
    TIMEOUT,
  );

  it(
    "HALT → exitAll: a trading halt flattens the lane without asking anyone",
    async () => {
      const d = await deskUnderTest({ fork, lane, feedCode: feedCode as Hex });
      await d.follow();
      expect((await untilDecision(d, fork, lane)).status).toBe("executed");
      expect((await fork.laneFacts(lane)).tokenIds).toHaveLength(1);

      d.off.rh.halt = true;
      const out = await d.tick(); // HALT is immediate: flat → exitAll, risk-reducing, no approval
      expect(out.kind).toBe("decision");
      if (out.kind === "decision") expect(out.status).toBe("executed");
      const decision = d.db.recentDecisions(1)[0];
      expect(decision?.riskMode).toBe("flat");
      expect(decision?.approvalOutcome).toBe("not_required");

      const facts = await assertLaneInvariants(fork, lane);
      expect(facts.tokenIds).toHaveLength(0);
      expect(facts.balances.usdg + facts.balances.nvda).toBeGreaterThan(0n); // idle in the lane
      const actions = await assertDbMatchesChain(fork, d, lane);
      expect(actions.map((a) => a.action)).toEqual([RERANGE, EXIT_ALL]);
    },
    TIMEOUT,
  );

  it(
    "crash between sign and broadcast: recovery rebroadcasts the stored bytes, one LaneAction",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "deltadesk-crash-"));
      const dbPath = join(dir, "desk.sqlite");
      // The first broadcast never reaches the node and never returns: the process "dies" there.
      let hang = true;
      const hanging = (c: ChainClient): ChainClient => ({
        ...c,
        sendRawTransaction: (raw) =>
          hang ? new Promise<Hex>(() => {}) : c.sendRawTransaction(raw),
      });
      const operator = addressOf(KEYS.operator);
      const nonce0 = await fork.pub.getTransactionCount({ address: operator });
      const d = await deskUnderTest({
        fork,
        lane,
        feedCode: feedCode as Hex,
        dbPath,
        wrapChain: hanging,
      });
      await d.follow();
      for (let i = 0; i < 2; i++) expect((await d.tick()).kind).toBe("hold"); // gate dwell
      void d.tick(); // the decision tick: sign → persist → broadcast (hangs)
      await vi.waitFor(() => expect(d.db.unresolvedAttempts()).toHaveLength(1), {
        timeout: 90_000,
        interval: 100,
      });
      const stored = d.db.unresolvedAttempts()[0];
      expect(stored?.status).toBe("signed");
      expect(d.signer.requests).toHaveLength(1);
      expect((await fork.laneActions(lane)).length).toBe(0);
      hang = false;

      // Restart on the same database file.
      const db = openDb(dbPath);
      const deps = {
        db,
        chain: d.chain,
        broadcaster: createBroadcaster({ chain: d.chain, clock: d.clock }),
        clock: d.clock,
        logger: silentLogger,
      };
      const report = await createStartupReconciler(deps).run(d.clock.now());
      expect(report.rebroadcast).toBe(1);
      // The node mines it asynchronously; the resolver (next tick) then records the receipt.
      await fork.pub.waitForTransactionReceipt({
        hash: stored?.txHash as Hex,
        pollingInterval: 50,
        timeout: 300_000,
      });
      await createAttemptResolver(deps).resolveAll(d.clock.now());
      expect(db.getExecution(stored?.executionId ?? -1)?.status).toBe("confirmed");

      const restarted = await deskUnderTest({ fork, lane, feedCode: feedCode as Hex, dbPath });
      await restarted.follow();
      for (let i = 0; i < 4; i++) expect((await restarted.tick()).kind).toBe("hold");
      expect(restarted.signer.requests).toHaveLength(0); // never re-signed

      const actions = await fork.laneActions(lane);
      expect(actions).toHaveLength(1);
      expect(actions[0]?.decisionId).toBe(db.getExecution(stored?.executionId ?? -1)?.onchainId);
      expect(await fork.pub.getTransactionCount({ address: operator })).toBe(nonce0 + 1);
      await assertDbMatchesChain(fork, restarted, lane);
    },
    TIMEOUT,
  );

  it(
    "wrong signer: preflight refuses it; forced past preflight, nothing is ever broadcast",
    async () => {
      const intruder = addressOf(KEYS.intruder);
      const nonce0 = await fork.pub.getTransactionCount({ address: intruder });
      await expect(
        deskUnderTest({ fork, lane, feedCode: feedCode as Hex, signerKey: KEYS.intruder }),
      ).rejects.toThrow(/not the lane's on-chain operator/);

      const d = await deskUnderTest({
        fork,
        lane,
        feedCode: feedCode as Hex,
        signerKey: KEYS.intruder,
        skipPreflight: true,
      });
      await d.follow();
      const out = await untilDecision(d, fork, lane);
      expect(out.status).toBe("blocked");
      expect(d.db.recentDecisions(1)[0]?.guardViolationsJson).toContain("signer-binding");
      expect(d.signer.requests).toHaveLength(0);

      // A signer that claims the operator's address but signs with another key.
      const other = createLocalSigner({ privateKey: KEYS.intruder, rpcUrl: fork.url });
      const t = await deskUnderTest({
        fork,
        lane,
        feedCode: feedCode as Hex,
        sign: (tx) => other.signTransaction(tx),
      });
      await t.follow();
      const tampered = await untilDecision(t, fork, lane);
      expect(tampered.status).toBe("failed");
      expect(t.db.recentExecutions(1)[0]?.errorCode).toBe("SIGNER_MISMATCH");

      expect(await fork.pub.getTransactionCount({ address: intruder })).toBe(nonce0);
      expect(await fork.laneActions(lane)).toHaveLength(0);
      await assertLaneInvariants(fork, lane);
    },
    TIMEOUT,
  );
});
