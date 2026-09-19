import { decodeFunctionData, keccak256, parseTransaction } from "viem";
import { describe, expect, it } from "vitest";
import { loadWatchdogConfig } from "../../../src/config.js";
import { deskLaneAbi, OPERATOR_SELECTORS } from "../../../src/executor/abi/DeskLane.js";
import { encodeDecisionId } from "../../../src/executor/decision-id.js";
import { silentLogger } from "../../../src/log.js";
import {
  type HealthView,
  type Hex,
  LANE_ACTION_NAMES,
  type WatchdogInput,
  type WatchdogThresholds,
} from "../../../src/types.js";
import {
  createWatchdog,
  guardianFromKey,
  type LaneReading,
  nearestScheduledAction,
} from "../../../src/watchdog/main.js";
import {
  evaluateWatchdog,
  HEARTBEAT_STALE_MS,
  plannedActions,
} from "../../../src/watchdog/rules.js";
import { fixedClock } from "../../helpers/fakes.js";
import {
  ANVIL_KEY_2,
  FakeChain,
  LANE,
  laneActionLog,
  OPERATOR_ADDR,
  OWNER,
  T0,
  testUlid,
} from "../executor/_fixtures.js";

const T: WatchdogThresholds = {
  navDropPct: 3,
  revertStreak: 3,
  rerangeHeadroom: 1,
  operatorReserveWei: 10n ** 15n,
  deadManMs: 15 * 60_000,
};
const healthy: HealthView = {
  ok: true,
  lastTickAgeMs: 5_000,
  lockHeld: true,
  pendingExecutions: 0,
  nowMs: T0,
};
const calm: WatchdogInput = {
  nowMs: T0,
  laneAddress: LANE,
  paused: false,
  hasPositions: true,
  navUsd: 50,
  navBaselineUsd: 50,
  navMarketMoveUsd: 0,
  budgets: {
    turnoverAvailableUsd6: 100_000_000n,
    reranges1hLeft: 4n,
    reranges24hLeft: 24n,
    nextRerangeAt: 0n,
  },
  consecutiveReverts: 0,
  foreignActions: 0,
  operatorEthWei: 5n * 10n ** 15n,
  agentHealth: healthy,
  scheduledActionAtMs: null,
  telegramPauseRequested: false,
};
const triggersOf = (i: Partial<WatchdogInput>) =>
  evaluateWatchdog({ ...calm, ...i }, T).triggers.map((t) => t.trigger);

describe("watchdog rules (pure)", () => {
  it("a calm lane → none", () => {
    expect(evaluateWatchdog(calm, T)).toEqual({ action: "none", triggers: [] });
  });

  it("an unexplained NAV drop pauses and exits; a market-explained one does not", () => {
    expect(evaluateWatchdog({ ...calm, navUsd: 48 }, T)).toMatchObject({
      action: "pause_and_exit",
      triggers: [{ trigger: "nav-drop" }],
    });
    expect(triggersOf({ navUsd: 48, navMarketMoveUsd: -2 })).toEqual([]);
    expect(triggersOf({ navUsd: 48.6 })).toEqual([]); // 2.8% < 3%
    expect(triggersOf({ navUsd: null })).toEqual([]);
  });

  it("rerange budget at or near the cap pauses", () => {
    expect(
      triggersOf({
        budgets: { ...(calm.budgets as NonNullable<WatchdogInput["budgets"]>), reranges1hLeft: 1n },
      }),
    ).toEqual(["rerange-cap"]);
    expect(
      triggersOf({
        budgets: {
          ...(calm.budgets as NonNullable<WatchdogInput["budgets"]>),
          reranges24hLeft: 0n,
        },
      }),
    ).toEqual(["rerange-cap"]);
    expect(
      evaluateWatchdog(
        {
          ...calm,
          budgets: {
            ...(calm.budgets as NonNullable<WatchdogInput["budgets"]>),
            reranges1hLeft: 0n,
          },
        },
        T,
      ).action,
    ).toBe("pause");
  });

  it("revert streak, foreign action and a Telegram request pause", () => {
    expect(triggersOf({ consecutiveReverts: 3 })).toEqual(["revert-streak"]);
    expect(triggersOf({ consecutiveReverts: 2 })).toEqual([]);
    expect(triggersOf({ foreignActions: 1 })).toEqual(["foreign-action"]);
    expect(triggersOf({ telegramPauseRequested: true })).toEqual(["telegram-pause"]);
    expect(evaluateWatchdog({ ...calm, foreignActions: 2 }, T).action).toBe("pause");
  });

  it("operator gas below the reserve pauses and exits (the agent could not)", () => {
    expect(evaluateWatchdog({ ...calm, operatorEthWei: 10n ** 14n }, T).action).toBe(
      "pause_and_exit",
    );
    expect(
      evaluateWatchdog({ ...calm, operatorEthWei: 10n ** 14n, hasPositions: false }, T).action,
    ).toBe("pause");
  });

  it("dead-man: only around a scheduled action, and only when the heartbeat is missing", () => {
    const soon = T0 + 5 * 60_000;
    expect(triggersOf({ scheduledActionAtMs: soon })).toEqual([]);
    expect(triggersOf({ scheduledActionAtMs: soon, agentHealth: null })).toEqual(["dead-man"]);
    expect(
      triggersOf({
        scheduledActionAtMs: soon,
        agentHealth: { ...healthy, lastTickAgeMs: HEARTBEAT_STALE_MS + 1 },
      }),
    ).toEqual(["dead-man"]);
    expect(
      triggersOf({ scheduledActionAtMs: soon, agentHealth: { ...healthy, lockHeld: false } }),
    ).toEqual(["dead-man"]);
    expect(triggersOf({ scheduledActionAtMs: T0 + 16 * 60_000, agentHealth: null })).toEqual([]);
  });

  it("plannedActions: pause first unless already paused; exit only with positions; never anything else", () => {
    const exit = evaluateWatchdog({ ...calm, navUsd: 40 }, T);
    expect(plannedActions(exit, { paused: false, hasPositions: true })).toEqual([
      "pause",
      "exitAll",
    ]);
    expect(plannedActions(exit, { paused: true, hasPositions: true })).toEqual(["exitAll"]);
    expect(plannedActions(exit, { paused: true, hasPositions: false })).toEqual([]);
    expect(
      plannedActions(evaluateWatchdog(calm, T), { paused: false, hasPositions: true }),
    ).toEqual([]);
  });

  it("finds calendar boundaries: the 09:30 ET open on a weekday", () => {
    const open = Date.UTC(2026, 8, 21, 13, 30); // 09:30 ET (EDT)
    expect(nearestScheduledAction(open - 2 * 60_000, 15 * 60_000)).toBe(open);
    // 09:20 ET (the reopen guard starting) is a boundary too.
    expect(nearestScheduledAction(open - 9 * 60_000, 15 * 60_000)).toBe(open - 10 * 60_000);
    expect(nearestScheduledAction(Date.UTC(2026, 8, 21, 17, 0), 15 * 60_000)).toBeNull(); // 13:00 ET, mid-session
  });
});

// ---------------------------------------------------------------------------------------------

function reading(p: Partial<LaneReading> = {}): LaneReading {
  return {
    blockNumber: 1_000n,
    paused: false,
    owner: OWNER,
    operator: OPERATOR_ADDR,
    guardian: guardianFromKey(ANVIL_KEY_2).address,
    hasPositions: true,
    budgets: {
      turnoverAvailableUsd6: 1n,
      reranges1hLeft: 4n,
      reranges24hLeft: 24n,
      nextRerangeAt: 0n,
    },
    operatorEthWei: 10n ** 16n,
    amount0: 25_000_000n,
    amount1: 10n ** 17n,
    navUsd: 47.2,
    p0: 10n ** 18n,
    p1: 222n * 10n ** 18n,
    dec0: 6,
    dec1: 18,
    ...p,
  };
}

function wd(env: Record<string, string>, read: () => LaneReading, chain = new FakeChain()) {
  const cfg = loadWatchdogConfig({
    RH_RPC_URL: "http://127.0.0.1:8545",
    DESK_LANE_A: LANE,
    ...env,
  });
  const clock = fixedClock(T0);
  const notes: string[] = [];
  const w = createWatchdog({
    cfg,
    chain,
    guardian: cfg.guardianPrivateKey === undefined ? null : guardianFromKey(cfg.guardianPrivateKey),
    fetchHealth: async () => healthy,
    clock,
    logger: silentLogger,
    notifier: { notify: async (n) => void notes.push(n.title) },
    sleep: async (ms) => clock.advance(ms),
    scheduledActionAt: () => null,
    readLane: async () => read(),
  });
  return { w, chain, notes, clock };
}

describe("watchdog service", () => {
  it("dry-run by default: evaluates, alerts, sends nothing", async () => {
    let nav = 50;
    const { w, chain, notes } = wd({}, () =>
      reading({ navUsd: nav, amount0: 25_000_000n, amount1: 112_612_612_612_612_612n }),
    );
    expect((await w.runOnce())[0]?.verdict.action).toBe("none");
    nav = 40;
    const [r] = await w.runOnce();
    expect(r?.verdict.action).toBe("pause_and_exit");
    expect(r?.actions.map((a) => [a.kind, a.dryRun])).toEqual([
      ["pause", true],
      ["exitAll", true],
    ]);
    expect(chain.sent).toHaveLength(0);
    expect(notes[0]).toMatch(/DRY RUN/);
  });

  it("armed with the guardian key: pauses (then exits) with verified guardian transactions only", async () => {
    const chain = new FakeChain();
    let nav = 50;
    const { w } = wd(
      { WATCHDOG_DRY_RUN: "false", WATCHDOG_ARM: "1", WATCHDOG_GUARDIAN_PRIVATE_KEY: ANVIL_KEY_2 },
      () => reading({ navUsd: nav, amount0: 25_000_000n, amount1: 112_612_612_612_612_612n }),
      chain,
    );
    await w.runOnce();
    nav = 40;
    const [r] = await w.runOnce();
    expect(r?.actions.map((a) => a.kind)).toEqual(["pause", "exitAll"]);
    expect(r?.actions.every((a) => a.error === null && a.txHash !== null)).toBe(true);
    const selectors = chain.sent.map((raw) => parseTransaction(raw).data?.slice(0, 10));
    expect(selectors).toEqual([OPERATOR_SELECTORS.pause, OPERATOR_SELECTORS.exitAll]);
    for (const raw of chain.sent) {
      const tx = parseTransaction(raw);
      expect(tx.to?.toLowerCase()).toBe(LANE);
      expect(decodeFunctionData({ abi: deskLaneAbi, data: tx.data as Hex }).functionName).toMatch(
        /^(pause|exitAll)$/,
      );
    }
  });

  it("refuses to act on a lane where it is not the guardian", async () => {
    const chain = new FakeChain();
    const { w } = wd(
      { WATCHDOG_DRY_RUN: "false", WATCHDOG_ARM: "1", WATCHDOG_GUARDIAN_PRIVATE_KEY: ANVIL_KEY_2 },
      () =>
        reading({
          guardian: "0x0000000000000000000000000000000000000000",
          budgets: {
            turnoverAvailableUsd6: 1n,
            reranges1hLeft: 0n,
            reranges24hLeft: 0n,
            nextRerangeAt: 0n,
          },
        }),
      chain,
    );
    const [r] = await w.runOnce();
    expect(r?.actions[0]?.error).toMatch(/not the lane's guardian/);
    expect(chain.sent).toHaveLength(0);
  });

  it("derives the revert streak from Δnonce − Δsuccessful operator actions, and foreign operator actions", async () => {
    const chain = new FakeChain();
    const { w } = wd({}, () => reading({ navUsd: null }), chain);
    await w.runOnce(); // baseline: cursor + nonce
    chain.count(OPERATOR_ADDR).latest = 3; // 3 mined txs, none emitted a LaneAction → 3 reverts
    chain.head = 1_010n;
    const [a] = await w.runOnce();
    expect(a?.verdict.triggers.map((t) => t.trigger)).toContain("revert-streak");

    chain.count(OPERATOR_ADDR).latest = 5;
    chain.head = 1_020n;
    chain.logs.push(
      laneActionLog({
        decisionId: encodeDecisionId(testUlid(), 0),
        action: LANE_ACTION_NAMES.indexOf("COLLECT"),
        caller: OPERATOR_ADDR,
        txHash: keccak256("0x01"),
        blockNumber: 1_015n,
      }),
      laneActionLog({
        decisionId: keccak256("0x99"),
        action: LANE_ACTION_NAMES.indexOf("EXIT_ALL"),
        caller: OPERATOR_ADDR,
        txHash: keccak256("0x02"),
        blockNumber: 1_016n,
        logIndex: 1,
      }),
    );
    const [b] = await w.runOnce();
    const names = b?.verdict.triggers.map((t) => t.trigger);
    expect(names).toContain("foreign-action");
    expect(names).not.toContain("revert-streak");
  });

  it("Telegram can request a pause (all lanes or one), never anything else", async () => {
    const { w } = wd({}, () => reading({ navUsd: null }));
    w.requestPause("*");
    const [r] = await w.runOnce();
    expect(r?.verdict.triggers.map((t) => t.trigger)).toEqual(["telegram-pause"]);
    expect(r?.actions.map((a) => a.kind)).toEqual(["pause"]);
    expect((await w.runOnce())[0]?.verdict.action).toBe("none");
  });
});
