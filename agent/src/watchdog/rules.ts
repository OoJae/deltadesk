/**
 * Watchdog rules (pure). The watchdog holds only the GUARDIAN key: it can pause and flatten
 * (exitAll), never unpause, never move value, never change config.
 *
 *   nav-drop        fence-valued NAV fell more than X% below the baseline re-valued at today's
 *                   fence prices (i.e. not explained by the market)          → pause + exit
 *   rerange-cap     reranges left in the 1 h or 24 h bucket ≤ headroom        → pause
 *   revert-streak   ≥ N operator transactions reverted in a row               → pause
 *   foreign-action  the operator key acted outside the agent                  → pause
 *   operator-gas    operator ETH below the reserve (the agent could not exit) → pause + exit
 *   dead-man        agent heartbeat missing within ±15 min of a scheduled action → pause + exit
 *   telegram-pause  a human asked on Telegram                                 → pause
 *
 * "exit" only happens when the lane still has positions. The verdict is advisory to main.ts, which
 * skips a pause for a lane that is already paused.
 */

import type {
  WatchdogInput,
  WatchdogRules,
  WatchdogThresholds,
  WatchdogTriggerName,
  WatchdogVerdict,
} from "../types.js";

export type {
  WatchdogInput,
  WatchdogRules,
  WatchdogTriggerName,
  WatchdogVerdict,
} from "../types.js";

/** An agent whose newest tick is older than this is not alive (the tick is 5 s). */
export const HEARTBEAT_STALE_MS = 120_000;

const EXITING: ReadonlySet<WatchdogTriggerName> = new Set(["nav-drop", "operator-gas", "dead-man"]);

export const evaluateWatchdog: WatchdogRules = (
  input: WatchdogInput,
  t: WatchdogThresholds,
): WatchdogVerdict => {
  const triggers: WatchdogVerdict["triggers"] = [];

  if (input.navUsd !== null && input.navBaselineUsd !== null && input.navBaselineUsd > 0) {
    const expected = input.navBaselineUsd + (input.navMarketMoveUsd ?? 0);
    const dropPct = ((expected - input.navUsd) / input.navBaselineUsd) * 100;
    if (dropPct > t.navDropPct) {
      triggers.push({
        trigger: "nav-drop",
        detail: `NAV $${input.navUsd.toFixed(2)} is ${dropPct.toFixed(2)}% below the market-explained $${expected.toFixed(2)} (limit ${t.navDropPct}%)`,
      });
    }
  }

  if (input.budgets !== null) {
    const h = BigInt(t.rerangeHeadroom);
    const left1h = input.budgets.reranges1hLeft;
    const left24h = input.budgets.reranges24hLeft;
    if (left1h <= h || left24h <= h) {
      triggers.push({
        trigger: "rerange-cap",
        detail: `reranges left: ${left1h} (1 h), ${left24h} (24 h); headroom ${t.rerangeHeadroom}`,
      });
    }
  }

  if (input.consecutiveReverts >= t.revertStreak) {
    triggers.push({
      trigger: "revert-streak",
      detail: `${input.consecutiveReverts} operator transactions reverted in a row (limit ${t.revertStreak})`,
    });
  }

  if (input.foreignActions > 0) {
    triggers.push({
      trigger: "foreign-action",
      detail: `${input.foreignActions} lane action(s) by the operator key that the agent did not produce`,
    });
  }

  if (input.operatorEthWei !== null && input.operatorEthWei < t.operatorReserveWei) {
    triggers.push({
      trigger: "operator-gas",
      detail: `operator has ${input.operatorEthWei} wei, reserve ${t.operatorReserveWei} wei`,
    });
  }

  if (
    input.scheduledActionAtMs !== null &&
    Math.abs(input.nowMs - input.scheduledActionAtMs) <= t.deadManMs
  ) {
    const h = input.agentHealth;
    const alive =
      h?.lockHeld === true && h.lastTickAgeMs !== null && h.lastTickAgeMs <= HEARTBEAT_STALE_MS;
    if (!alive) {
      triggers.push({
        trigger: "dead-man",
        detail:
          h === null
            ? "agent /health unreachable around a scheduled action"
            : `agent heartbeat stale (last tick ${h.lastTickAgeMs ?? "never"} ms ago, lock ${h.lockHeld ? "held" : "free"}) around a scheduled action`,
      });
    }
  }

  if (input.telegramPauseRequested) {
    triggers.push({ trigger: "telegram-pause", detail: "pause requested on Telegram" });
  }

  if (triggers.length === 0) return { action: "none", triggers };
  const exit = input.hasPositions && triggers.some((x) => EXITING.has(x.trigger));
  return { action: exit ? "pause_and_exit" : "pause", triggers };
};

/** The transactions a verdict implies for a lane in a given state (pause first, then exit). */
export function plannedActions(
  verdict: WatchdogVerdict,
  lane: { paused: boolean; hasPositions: boolean },
): Array<"pause" | "exitAll"> {
  if (verdict.action === "none") return [];
  const out: Array<"pause" | "exitAll"> = [];
  if (!lane.paused) out.push("pause");
  if (verdict.action === "pause_and_exit" && lane.hasPositions) out.push("exitAll");
  return out;
}
