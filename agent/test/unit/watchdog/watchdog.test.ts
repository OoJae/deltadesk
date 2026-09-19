import { decodeFunctionData, keccak256, parseTransaction } from "viem";
import { describe, expect, it } from "vitest";
import { loadWatchdogConfig } from "../../../src/config.js";
import { deskLaneAbi, OPERATOR_SELECTORS } from "../../../src/executor/abi/DeskLane.js";
import { encodeDecisionId } from "../../../src/executor/decision-id.js";
import { silentLogger } from "../../../src/log.js";
import {
  type DeskNotification,
  type HealthView,
  type Hex,
  LANE_ACTION_NAMES,
  type WatchdogInput,
  type WatchdogThresholds,
} from "../../../src/types.js";
import {
  type ActionChecker,
  createActionChecker,
  createWatchdog,
  FIRST_LOOK_BACK_BLOCKS,
  guardianFromKey,
  type LaneReading,
  nearestScheduledAction,
  watchdogStartupWarnings,
} from "../../../src/watchdog/main.js";
import {
  evaluateWatchdog,
  HEARTBEAT_STALE_MS,
  plannedActions,
} from "../../../src/watchdog/rules.js";
import { fixedClock, memDb } from "../../helpers/fakes.js";
import {
  ANVIL_KEY_2,
  FakeChain,
  LANE,
  laneActionLog,
  OPERATOR_ADDR,
  OWNER,
  seedSignedExecution,
  T0,
  testUlid,
} from "../executor/_fixtures.js";

const T: WatchdogThresholds = {
  navDropPct: 3,
  revertStreak: 3,
  rerangeHeadroom: 1,
  operatorReserveWei: 10n ** 15n,
  deadManMs: 15 * 60_000,
  unverifiedMaxMs: 15 * 60_000,
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
  unverifiedActions: 0,
  unverifiedForMs: null,
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

  it("an operator action the agent could not vouch for alerts, never pauses on its own", () => {
    expect(evaluateWatchdog({ ...calm, unverifiedActions: 2 }, T)).toMatchObject({
      action: "alert",
      triggers: [{ trigger: "unverified-action" }],
    });
    expect(
      plannedActions(evaluateWatchdog({ ...calm, unverifiedActions: 1 }, T), {
        paused: false,
        hasPositions: true,
      }),
    ).toEqual([]);
    // With a pausing trigger next to it, the pausing trigger decides.
    expect(evaluateWatchdog({ ...calm, unverifiedActions: 1, foreignActions: 1 }, T).action).toBe(
      "pause",
    );
  });

  it("unverified for WATCHDOG_UNVERIFIED_MIN with the agent down → pause; alive, or younger → alert", () => {
    const old = { unverifiedActions: 3, unverifiedForMs: 15 * 60_000 };
    expect(evaluateWatchdog({ ...calm, ...old, agentHealth: null }, T)).toMatchObject({
      action: "pause",
      triggers: [{ trigger: "unverified-stale" }],
    });
    const staleBeat = { ...healthy, lastTickAgeMs: HEARTBEAT_STALE_MS + 1 };
    expect(triggersOf({ ...old, agentHealth: staleBeat })).toEqual(["unverified-stale"]);
    expect(triggersOf({ ...old, agentHealth: { ...healthy, lockHeld: false } })).toEqual([
      "unverified-stale",
    ]);
    // An alive agent that cannot answer (a key mismatch): a critical alert, never a pause on this alone.
    expect(evaluateWatchdog({ ...calm, ...old, unverifiedForMs: 10 * 3_600_000 }, T).action).toBe(
      "alert",
    );
    expect(triggersOf({ ...old, unverifiedForMs: 15 * 60_000 - 1, agentHealth: null })).toEqual([
      "unverified-action",
    ]);
    // Every action already escalated (null age): alert only, however long it has been.
    expect(triggersOf({ ...old, unverifiedForMs: null, agentHealth: null })).toEqual([
      "unverified-action",
    ]);
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

/** A live (armed) watchdog: the guardian key, and the agent to cross-check with. */
const LIVE = {
  WATCHDOG_DRY_RUN: "false",
  WATCHDOG_ARM: "1",
  WATCHDOG_GUARDIAN_PRIVATE_KEY: ANVIL_KEY_2,
  WATCHDOG_AGENT_URL: "http://127.0.0.1:9",
  WATCHDOG_AGENT_KEY: "watchdog-key-0123456789abcdef0123456789",
};

function wd(
  env: Record<string, string>,
  read: () => LaneReading,
  chain = new FakeChain(),
  checkAction?: ActionChecker,
  fetchHealth: () => Promise<HealthView | null> = async () => healthy,
) {
  const cfg = loadWatchdogConfig({
    RH_RPC_URL: "http://127.0.0.1:8545",
    DESK_LANE_A: LANE,
    ...env,
  });
  const clock = fixedClock(T0);
  const notes: string[] = [];
  const alerts: DeskNotification[] = [];
  const w = createWatchdog({
    cfg,
    chain,
    guardian: cfg.guardianPrivateKey === undefined ? null : guardianFromKey(cfg.guardianPrivateKey),
    fetchHealth,
    clock,
    logger: silentLogger,
    notifier: {
      notify: async (n) => {
        notes.push(n.title);
        alerts.push(n);
      },
    },
    sleep: async (ms) => clock.advance(ms),
    scheduledActionAt: () => null,
    readLane: async () => read(),
    ...(checkAction === undefined ? {} : { checkAction }),
  });
  return { w, chain, notes, alerts, clock };
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
      LIVE,
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
      LIVE,
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

// ---------------------------------------------------------------------------------------------
// Foreign-action detection: the ULID layout is a first filter only; the agent's DB decides.

describe("watchdog cross-checks every operator LaneAction with the agent", () => {
  const COLLECT = LANE_ACTION_NAMES.indexOf("COLLECT");
  const PAUSE = LANE_ACTION_NAMES.indexOf("PAUSE");
  let seq = 0;
  /** One operator LaneAction in the next block range, with an agent-layout id unless given. */
  function act(chain: FakeChain, p: { decisionId?: Hex; action?: number } = {}) {
    seq += 1;
    chain.head += 10n;
    const txHash = keccak256(`0x${seq.toString(16).padStart(4, "0")}`);
    const decisionId = p.decisionId ?? encodeDecisionId(testUlid(), 0);
    chain.logs.push(
      laneActionLog({
        decisionId,
        action: p.action ?? COLLECT,
        caller: OPERATOR_ADDR,
        txHash,
        blockNumber: chain.head - 5n,
      }),
    );
    return { decisionId, txHash };
  }
  /** A checker scripted per call; records what it was asked. */
  function agent(answer: (decisionId: Hex) => { known: boolean } | Error) {
    const asked: Array<{ lane: string; decisionId: Hex; txHash: Hex }> = [];
    const check: ActionChecker = async (lane, decisionId, txHash) => {
      asked.push({ lane, decisionId, txHash });
      const a = answer(decisionId);
      if (a instanceof Error) throw a;
      return a;
    };
    return { asked, check };
  }
  const setupWd = (check: ActionChecker) => {
    const chain = new FakeChain();
    const r = wd({}, () => reading({ navUsd: null }), chain, check);
    return { ...r, chain };
  };

  it("an action the agent knows passes; it is asked with the lane, decisionId and tx hash", async () => {
    const a = agent(() => ({ known: true }));
    const { w, chain } = setupWd(a.check);
    await w.runOnce(); // baseline cursor
    const { decisionId, txHash } = act(chain);
    const [r] = await w.runOnce();
    expect(r?.verdict.action).toBe("none");
    expect(a.asked).toEqual([{ lane: LANE, decisionId, txHash }]);
  });

  it("a well-formed id the agent does NOT know (a stolen key forging the layout) → pause + critical alert", async () => {
    const a = agent(() => ({ known: false }));
    const { w, chain, alerts } = setupWd(a.check);
    await w.runOnce();
    act(chain);
    const [r] = await w.runOnce();
    expect(r?.verdict.action).toBe("pause");
    expect(r?.verdict.triggers.map((t) => t.trigger)).toEqual(["foreign-action"]);
    expect(r?.actions.map((x) => x.kind)).toEqual(["pause"]);
    expect(alerts.at(-1)?.severity).toBe("critical");
  });

  it("a forged layout is foreign without asking; the operator's own pause() is never counted", async () => {
    const a = agent(() => ({ known: true }));
    const { w, chain } = setupWd(a.check);
    await w.runOnce();
    act(chain, { decisionId: keccak256("0x99") });
    act(chain, { decisionId: `0x${"00".repeat(32)}`, action: PAUSE });
    const [r] = await w.runOnce();
    expect(r?.verdict.triggers.map((t) => t.trigger)).toEqual(["foreign-action"]);
    expect(a.asked).toEqual([]);
  });

  it("agent unreachable or 5xx → critical alert, NO pause; re-asked every tick until it answers", async () => {
    let down = true;
    const a = agent(() => (down ? new Error("agent answered HTTP 503") : { known: true }));
    const { w, chain, alerts } = setupWd(a.check);
    await w.runOnce();
    act(chain);
    const [r] = await w.runOnce();
    expect(r?.verdict.action).toBe("alert");
    expect(r?.verdict.triggers.map((t) => t.trigger)).toEqual(["unverified-action"]);
    expect(r?.actions).toEqual([]);
    expect(chain.sent).toHaveLength(0);
    expect(alerts.at(-1)).toMatchObject({
      severity: "critical",
      title: "Watchdog: alert (DRY RUN)",
    });
    const [again] = await w.runOnce(); // still down: still unverified (the cursor moved on)
    expect(again?.verdict.action).toBe("alert");
    expect(a.asked).toHaveLength(2);
    down = false;
    const [back] = await w.runOnce();
    expect(back?.verdict.action).toBe("none");
    expect(a.asked).toHaveLength(3);
    expect((await w.runOnce())[0]?.verdict.action).toBe("none");
    expect(a.asked).toHaveLength(3); // resolved: never asked again
  });

  it("an unverified action the agent later disowns turns into a pause", async () => {
    let down = true;
    const a = agent(() => (down ? new Error("fetch failed") : { known: false }));
    const { w, chain } = setupWd(a.check);
    await w.runOnce();
    act(chain);
    expect((await w.runOnce())[0]?.verdict.action).toBe("alert");
    down = false;
    const [r] = await w.runOnce();
    expect(r?.verdict.action).toBe("pause");
  });

  it("without WATCHDOG_AGENT_URL there is no one to ask: every well-formed action alerts", async () => {
    const chain = new FakeChain();
    const { w } = wd({}, () => reading({ navUsd: null }), chain);
    await w.runOnce();
    act(chain);
    const [r] = await w.runOnce();
    expect(r?.verdict.triggers.map((t) => t.trigger)).toEqual(["unverified-action"]);
  });
});

// ---------------------------------------------------------------------------------------------
// A detection is never lost: every chain read happens before anything is consumed, a foreign
// action (and a Telegram /pause) stays pending until the lane is paused, and the pause is re-sent.

describe("watchdog: a detection survives a failed read and a failed pause", () => {
  const COLLECT = LANE_ACTION_NAMES.indexOf("COLLECT");
  let seq = 0x10_000;
  function act(chain: FakeChain, decisionId: Hex = encodeDecisionId(testUlid(), 0), at?: bigint) {
    seq += 1;
    if (at === undefined) chain.head += 10n;
    chain.logs.push(
      laneActionLog({
        decisionId,
        action: COLLECT,
        caller: OPERATOR_ADDR,
        txHash: keccak256(`0x${seq.toString(16).padStart(8, "0")}`),
        blockNumber: at ?? chain.head - 5n,
      }),
    );
  }
  /** The operator nonce read fails `n` times (an upstream 429), then answers. */
  function flakyNonce(chain: FakeChain, n = 1) {
    const real = chain.getTransactionCount.bind(chain);
    let left = n;
    chain.getTransactionCount = async (address, tag) => {
      if (left > 0) {
        left -= 1;
        throw new Error("upstream answered HTTP 429");
      }
      return real(address, tag);
    };
  }
  const disowning: ActionChecker = async () => ({ known: false });

  it.each([
    ["disowned by the agent (known=false)", () => encodeDecisionId(testUlid(), 0)],
    ["not in the agent's layout", () => keccak256("0x99")],
  ])(
    "an action %s, then a later read in the same tick fails → paused on the next tick",
    async (_, id) => {
      const chain = new FakeChain();
      const { w, alerts } = wd({}, () => reading({ navUsd: null }), chain, disowning);
      await w.runOnce();
      act(chain, id());
      flakyNonce(chain);
      expect(await w.runOnce()).toEqual([]); // the lane read failed: no verdict this tick
      const [r] = await w.runOnce();
      expect(r?.verdict.action).toBe("pause");
      expect(r?.verdict.triggers.map((t) => t.trigger)).toEqual(["foreign-action"]);
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({ severity: "critical", title: "Watchdog: pause (DRY RUN)" });
    },
  );

  it("an armed pause that fails is re-sent every tick until it lands; then the detection settles", async () => {
    const chain = new FakeChain();
    const { w, alerts } = wd(LIVE, () => reading({ navUsd: null }), chain, disowning);
    await w.runOnce();
    act(chain);
    chain.sendErrors.push(new Error("upstream answered HTTP 503"));
    const [first] = await w.runOnce();
    expect(first?.verdict.action).toBe("pause");
    expect(first?.actions).toMatchObject([{ kind: "pause", txHash: null }]);
    expect(first?.actions[0]?.error).toMatch(/503/);
    const [second] = await w.runOnce();
    expect(second?.verdict.triggers.map((t) => t.trigger)).toEqual(["foreign-action"]);
    expect(second?.actions).toMatchObject([{ kind: "pause", error: null }]);
    const landed = second?.actions[0]?.txHash;
    expect(landed).toMatch(/^0x[0-9a-f]{64}$/);
    expect(chain.receipts.get(landed as Hex)?.status).toBe("success");
    expect((await w.runOnce())[0]?.verdict.action).toBe("none"); // landed: settled
    // The failure and the retry that landed are both reported (not deduplicated into one).
    expect(alerts).toHaveLength(2);
    expect(alerts[1]?.lines).toContain(`pause: ${landed}`);
  });

  it("a lane seen paused settles the detection (the owner's unpause is not undone)", async () => {
    const chain = new FakeChain();
    let paused = false;
    const { w } = wd(LIVE, () => reading({ navUsd: null, paused }), chain, disowning);
    await w.runOnce();
    paused = true; // the owner paused first
    act(chain);
    const [r] = await w.runOnce();
    expect(r?.verdict.action).toBe("pause");
    expect(r?.actions).toEqual([]); // already paused: nothing to send
    paused = false; // the owner reviewed and unpaused
    expect((await w.runOnce())[0]?.verdict.action).toBe("none");
    expect(chain.sent).toEqual([]);
  });

  it("a Telegram /pause whose transaction fails is retried until it lands ('*' included)", async () => {
    const chain = new FakeChain();
    const { w } = wd(LIVE, () => reading({ navUsd: null }), chain);
    w.requestPause("*");
    chain.sendErrors.push(new Error("upstream answered HTTP 503"));
    const [a] = await w.runOnce();
    expect(a?.actions[0]?.error).toMatch(/503/);
    const [b] = await w.runOnce();
    expect(b?.verdict.triggers.map((t) => t.trigger)).toEqual(["telegram-pause"]);
    expect(b?.actions[0]).toMatchObject({ kind: "pause", error: null });
    expect((await w.runOnce())[0]?.verdict.action).toBe("none");
  });

  it("a fresh (restarted) watchdog looks back FIRST_LOOK_BACK_BLOCKS on its first tick", async () => {
    const chain = new FakeChain();
    chain.head = 10_000n;
    act(chain, keccak256("0x99"), 10_000n - FIRST_LOOK_BACK_BLOCKS + 1n); // inside the window
    act(chain, keccak256("0x98"), 10_000n - FIRST_LOOK_BACK_BLOCKS - 1n); // before it: not read
    const { w } = wd({}, () => reading({ navUsd: null }), chain);
    const [r] = await w.runOnce();
    expect(r?.verdict.triggers).toEqual([
      { trigger: "foreign-action", detail: expect.stringMatching(/^1 lane action/) },
    ]);
    expect(chain.getLogsCalls[0]?.fromBlock).toBe(10_000n - FIRST_LOOK_BACK_BLOCKS);
  });

  it("a long gap (an RPC outage) is read in bounded chunks, nothing skipped", async () => {
    const chain = new FakeChain();
    const { w } = wd({}, () => reading({ navUsd: null }), chain);
    await w.runOnce();
    chain.head = 13_000n;
    act(chain, keccak256("0x99"), 12_500n);
    chain.getLogsCalls = [];
    const [r] = await w.runOnce();
    expect(r?.verdict.triggers.map((t) => t.trigger)).toEqual(["foreign-action"]);
    expect(chain.getLogsCalls).toEqual([
      { fromBlock: 1_001n, toBlock: 6_000n },
      { fromBlock: 6_001n, toBlock: 11_000n },
      { fromBlock: 11_001n, toBlock: 13_000n },
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// Unverified actions (the agent cannot be asked): a critical alert; a pause only when one stays
// unverified for WATCHDOG_UNVERIFIED_MIN while the agent is down. Never a count-based pause.

describe("watchdog: unverified actions escalate on time with the agent down, never on a count", () => {
  const COLLECT = LANE_ACTION_NAMES.indexOf("COLLECT");
  let seq = 0x20_000;
  function act(chain: FakeChain, n = 1) {
    chain.head += 10n;
    for (let i = 0; i < n; i++) {
      seq += 1;
      chain.logs.push(
        laneActionLog({
          decisionId: encodeDecisionId(testUlid(), 0),
          action: COLLECT,
          caller: OPERATOR_ADDR,
          txHash: keccak256(`0x${seq.toString(16).padStart(8, "0")}`),
          blockNumber: chain.head - 5n,
          logIndex: i,
        }),
      );
    }
  }

  it("an alive agent that refuses (a key mismatch): 300 honest actions and an hour → alert, never pause", async () => {
    let refusing = true;
    const chain = new FakeChain();
    const { w, alerts, clock } = wd(
      {},
      () => reading({ navUsd: null }),
      chain,
      async () => {
        if (refusing) throw new Error("agent answered HTTP 401");
        return { known: true };
      },
    );
    await w.runOnce();
    act(chain, 300); // past the 256 re-ask cap
    const [r] = await w.runOnce();
    expect(r?.verdict.action).toBe("alert");
    expect(r?.verdict.triggers[0]?.detail).toMatch(/^300 operator lane action/);
    clock.advance(60 * 60_000);
    act(chain);
    expect((await w.runOnce())[0]?.verdict.action).toBe("alert");
    expect(alerts.map((a) => a.title)).toEqual(["Watchdog: alert (DRY RUN)"]);
    refusing = false; // fixed: every tracked action is answered, the uncounted rest is let go
    expect((await w.runOnce())[0]?.verdict.action).toBe("none");
    expect(chain.sent).toEqual([]);
  });

  it("the agent down: unverified for WATCHDOG_UNVERIFIED_MIN → pause, once per action", async () => {
    const chain = new FakeChain();
    const { w, clock } = wd(
      {},
      () => reading({ navUsd: null }),
      chain,
      async () => {
        throw new Error("fetch failed");
      },
      async () => null,
    );
    await w.runOnce();
    act(chain);
    expect((await w.runOnce())[0]?.verdict.action).toBe("alert");
    clock.advance(15 * 60_000 - 1);
    expect((await w.runOnce())[0]?.verdict.action).toBe("alert");
    clock.advance(1);
    const [r] = await w.runOnce();
    expect(r?.verdict).toMatchObject({
      action: "pause",
      triggers: [{ trigger: "unverified-stale" }],
    });
    expect(r?.actions.map((a) => a.kind)).toEqual(["pause"]);
    // The pause went out (a dry run's "would send" counts): that action never pauses again…
    clock.advance(60 * 60_000);
    expect((await w.runOnce())[0]?.verdict.action).toBe("alert");
    // …and a new one runs its own clock.
    act(chain);
    expect((await w.runOnce())[0]?.verdict.action).toBe("alert");
    clock.advance(15 * 60_000);
    expect((await w.runOnce())[0]?.verdict.triggers.map((t) => t.trigger)).toEqual([
      "unverified-stale",
    ]);
  });

  it("a watchdog without WATCHDOG_AGENT_URL (dry run only) says so at startup", () => {
    const base = { RH_RPC_URL: "http://127.0.0.1:8545", DESK_LANE_A: LANE };
    expect(watchdogStartupWarnings(loadWatchdogConfig(base)).join(" ")).toMatch(
      /WATCHDOG_AGENT_URL is unset/,
    );
    expect(watchdogStartupWarnings(loadWatchdogConfig({ ...base, ...LIVE }))).toEqual([]);
  });
});

describe("createActionChecker ↔ the agent's GET /lanes/:lane/actions/:decisionId", () => {
  const KEY = "watchdog-key-0123456789abcdef0123456789";

  async function agentServer(key: string | undefined) {
    const { createHttpApp, startHttpServer } = await import("../../../src/http/server.js");
    const db = memDb();
    const app = createHttpApp({
      health: () => ({
        ok: true,
        lastTickAgeMs: 0,
        lockHeld: true,
        pendingExecutions: 0,
        nowMs: 0,
      }),
      webhook: null,
      desks: null,
      watchdog: { db, key, logger: silentLogger },
      logger: silentLogger,
    });
    const handle = await startHttpServer(app, { port: 0, host: "127.0.0.1" });
    return { db, handle, url: `http://127.0.0.1:${handle.port}` };
  }

  it("known / unknown over real HTTP; a wrong key, a missing key and a dead agent throw", async () => {
    const s = await agentServer(KEY);
    try {
      const signed = await seedSignedExecution(s.db);
      const check = createActionChecker(s.url, KEY);
      expect(await check(LANE, signed.onchainId, signed.txHash)).toEqual({
        known: true,
        status: "signed",
      });
      expect(await check(LANE, encodeDecisionId(testUlid(), 0), signed.txHash)).toEqual({
        known: false,
        status: undefined,
      });
      await expect(
        createActionChecker(s.url, `${KEY}-wrong`)(LANE, signed.onchainId, signed.txHash),
      ).rejects.toThrow(/HTTP 401/);
      await expect(
        createActionChecker(s.url, undefined)(LANE, signed.onchainId, signed.txHash),
      ).rejects.toThrow(/no agent to ask/);
    } finally {
      await s.handle.close();
    }
    await expect(
      createActionChecker(s.url, KEY, 1_000)(LANE, keccak256("0x01"), keccak256("0x02")),
    ).rejects.toThrow();
  });

  it("an agent without WATCHDOG_AGENT_KEY refuses (503): the checker throws, never 'known'", async () => {
    const s = await agentServer(undefined);
    try {
      await expect(
        createActionChecker(s.url, KEY)(LANE, keccak256("0x01"), keccak256("0x02")),
      ).rejects.toThrow(/HTTP 503/);
    } finally {
      await s.handle.close();
    }
  });
});
