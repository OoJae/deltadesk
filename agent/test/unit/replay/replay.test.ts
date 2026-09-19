/**
 * The replay runs the agent's own regime machine, gates and lane A strategy over synthetic minute
 * rows: labels, the calendar's CLOSED gate at Fri 20:00 ET, the fence rules, the startup hold and
 * the strategy's initial placement, and the gates-only mode for pools the M2 strategy does not trade.
 */

import { describe, expect, it } from "vitest";
import { etToEpochSec } from "../../../src/market/calendar.js";
import {
  parseReplayInput,
  REPLAY_LABEL,
  type ReplayInput,
  type ReplayInputRow,
} from "../../../src/replay/input.js";
import {
  closedSinceMs,
  fenceCodeAt,
  isFenceClosedWindow,
  runReplay,
} from "../../../src/replay/replay.js";
import { FENCE_CODES } from "../../../src/types.js";

const FRI_1600 = etToEpochSec(2026, 9, 11, 16, 0);
const FRI_1900 = etToEpochSec(2026, 9, 11, 19, 0);
const FRI_2100 = etToEpochSec(2026, 9, 11, 21, 0);
const FRI_2000 = etToEpochSec(2026, 9, 11, 20, 0);

function input(
  over: Partial<ReplayInput> = {},
  row: (ts: number) => Partial<ReplayInputRow> = () => ({}),
): ReplayInput {
  const startTs = over.window?.startTs ?? FRI_1900;
  const endTs = over.window?.endTs ?? FRI_2100;
  const warmupS = over.warmupS ?? 600;
  const rows: ReplayInputRow[] = [];
  for (let ts = startTs - warmupS; ts <= endTs; ts += 60) {
    rows.push({
      ts,
      poolMid: 220,
      poolTick: null,
      poolLiquidity: 3e19,
      lastSwapTs: ts,
      hl: 220,
      hlResS: 300,
      hlPointTs: ts - (ts % 300),
      k: 1,
      kSession: "2026-09-10",
      kLookahead: false,
      chainlinkPrice: 220,
      chainlinkUpdatedAt: FRI_1600,
      ...row(ts),
    });
  }
  return parseReplayInput({
    label: REPLAY_LABEL,
    kind: "deltadesk-replay-input",
    version: 1,
    id: "test-window",
    title: "test",
    note: "synthetic",
    pool: "NVDA/USDG",
    hlCoin: "xyz:NVDA",
    cadenceS: 60,
    warmupS,
    sources: ["synthetic"],
    coverage: {},
    lvr: null,
    ...over,
    window: { startTs, endTs, startUtc: "", endUtc: "", ...over.window },
    rows,
  });
}

describe("fence model (ChainlinkFence rules)", () => {
  it("MARKET_CLOSED in the UTC Sat 00:00 → Mon 01:00 window only", () => {
    expect(isFenceClosedWindow(Date.UTC(2026, 8, 12, 0, 0) / 1000)).toBe(true); // Sat 00:00 UTC
    expect(isFenceClosedWindow(Date.UTC(2026, 8, 14, 0, 59) / 1000)).toBe(true); // Mon 00:59 UTC
    expect(isFenceClosedWindow(Date.UTC(2026, 8, 14, 1, 0) / 1000)).toBe(false);
    expect(isFenceClosedWindow(Date.UTC(2026, 8, 11, 23, 59) / 1000)).toBe(false); // Fri
  });

  it("FEED_DEAD past 26 h beats everything; the corp-action window beats MARKET_CLOSED", () => {
    const sat = Date.UTC(2026, 8, 12, 12, 0) / 1000;
    expect(fenceCodeAt(sat, sat - 26 * 3600 - 1)).toBe(FENCE_CODES.FEED_DEAD);
    expect(fenceCodeAt(sat, null)).toBe(FENCE_CODES.FEED_DEAD);
    expect(fenceCodeAt(sat, sat + 10)).toBe(FENCE_CODES.FEED_DEAD); // from the future
    expect(fenceCodeAt(sat, sat - 3600)).toBe(FENCE_CODES.MARKET_CLOSED);
    expect(fenceCodeAt(sat, sat - 3600, sat + 3600)).toBe(FENCE_CODES.CORP_ACTION_WINDOW);
    const tue = Date.UTC(2026, 8, 15, 15, 0) / 1000;
    expect(fenceCodeAt(tue, tue - 60)).toBe(FENCE_CODES.OK);
  });
});

describe("runReplay (lane-a)", () => {
  const t = runReplay(input());

  it("labels every output as a replay and lists its sources", () => {
    expect(t.label).toBe("REPLAY (historical data, not live)");
    expect(t.kind).toBe("deltadesk-replay");
    expect(t.mode).toBe("lane-a");
    expect(t.sources.length).toBeGreaterThan(0);
    expect(t.notArmed).toHaveProperty("WRAPPER-PREMIUM");
    expect(t.notArmed["WRAPPER-PREMIUM"]).toMatch(/not armed/);
  });

  it("emits one row per 5 min of the window, warm-up excluded", () => {
    expect(t.rows).toHaveLength(25); // 19:00 … 21:00 inclusive
    expect(t.rows[0]?.ts).toBe(FRI_1900);
    expect(t.rows.at(-1)?.ts).toBe(FRI_2100);
  });

  it("places the lane once the startup hold clears (warm-up), then holds it", () => {
    const placed = t.events.filter((e) => e.kind === "action");
    expect(placed).toHaveLength(1);
    expect(placed[0]).toMatchObject({ action: "re-center", warmup: true });
    expect(placed[0]?.reason).toMatch(/initial_mint/);
    const offs = t.events.filter((e) => e.kind === "gate_off" && e.warmup);
    expect(offs.map((e) => e.gate)).toContain("CLOSED"); // the startup hold, not a real clear
    const first = t.rows[0];
    expect(first?.regime).toBe("EXTENDED");
    expect(first?.riskAddingAllowed).toBe(true);
    expect(first?.decision.action).toBe("hold");
    expect(first?.lane?.inRange).toBe(true);
    expect(first?.lane?.deployedUsd).toBeGreaterThan(40);
  });

  it("turns CLOSED on at Fri 20:00 ET: reduce-only, the position held, nothing added", () => {
    const closed = t.rows.filter((r) => r.ts >= FRI_2000);
    expect(closed.length).toBe(13);
    for (const r of closed) {
      expect(r.regime).toBe("WEEKEND_DARK");
      expect(r.activeGates).toContain("CLOSED");
      expect(r.riskAddingAllowed).toBe(false);
      expect(r.fenceCode).toBe(FENCE_CODES.MARKET_CLOSED); // Sat 00:00 UTC = Fri 20:00 EDT
      expect(r.decision.action).toBe("hold");
      expect(r.decision.reason).toMatch(/reduce-only \(CLOSED\)/);
    }
    expect(t.events).toContainEqual(
      expect.objectContaining({ kind: "gate_on", gate: "CLOSED", ts: FRI_2000, warmup: false }),
    );
    expect(t.summary.closedWindow).toMatchObject({ riskAddingTicksWhileClosed: 0, hours: 1 });
    expect(t.summary.actions).toEqual({
      window: { reCenter: 0, exit: 0 },
      warmup: { reCenter: 1, exit: 0 },
    });
  });

  it("marks the Chainlink round frozen while closed and the gap from F = HL · k", () => {
    const r = t.rows.at(-1);
    expect(r?.chainlink.frozen).toBe(true);
    expect(r?.chainlink.ageS).toBe(FRI_2100 - FRI_1600);
    expect(r?.fair).toBe(220);
    expect(r?.gapBps).toBe(0);
  });

  it("an HL candle gap makes STALE-REF block risk-adding (fail-closed), before the close too", () => {
    const stale = runReplay(
      input({}, (ts) => ({ hlPointTs: ts < FRI_1900 ? ts - (ts % 300) : FRI_1900 - 3600 })),
    );
    const r = stale.rows.find((x) => x.ts === FRI_1900 + 600);
    expect(r?.activeGates).toContain("STALE-REF");
    expect(r?.riskAddingAllowed).toBe(false);
  });
});

describe("runReplay (gates-only)", () => {
  it("reports the pool premium and says WRAPPER-PREMIUM is not armed", () => {
    // pool 1 % above fair value all along
    const t = runReplay(
      input({ pool: "SPY/USDG", hlCoin: "xyz:SP500" }, () => ({ poolMid: 222.2 })),
    );
    expect(t.mode).toBe("gates-only");
    for (const r of t.rows) {
      expect(r.decision.action).toBe("stay flat");
      expect(r.activeGates).not.toContain("WRAPPER-PREMIUM");
      expect(r.lane).toBeNull();
    }
    const premium = t.summary.premium as { peakBps: number; gate: string };
    expect(premium.peakBps).toBeCloseTo(99.5, 0);
    expect(premium.gate).toMatch(/WRAPPER-PREMIUM: not armed/);
    expect(t.headline.join(" ")).toMatch(/not armed/);
  });
});

describe("runReplay (window opening inside the closure)", () => {
  // The SPY window started Sat 00:00 ET: the headline called that the close and the 44 h replayed
  // "the closed window", though the market had closed Fri 20:00 ET (48 h).
  const SAT_0000 = etToEpochSec(2026, 9, 12, 0, 0);
  const SUN_2100 = etToEpochSec(2026, 9, 13, 21, 0);
  const lvr = {
    derivable: true,
    closedWindow: { hours: 44 },
    controlLane: { pickedOffUsd: 1, feesUsd: 2, netUsd: 1 },
  };
  const t = runReplay(
    input(
      {
        pool: "SPY/USDG",
        hlCoin: "xyz:SP500",
        window: { startTs: SAT_0000, endTs: SUN_2100, startUtc: "", endUtc: "" },
        lvr,
      },
      () => ({ chainlinkUpdatedAt: SAT_0000 - 3600 }),
    ),
  );

  it("dates the close from the calendar, not from the window start", () => {
    expect(closedSinceMs(SAT_0000 * 1000)).toBe(FRI_2000 * 1000);
    expect(closedSinceMs(FRI_1900 * 1000)).toBe(FRI_1900 * 1000); // open: nothing to walk back
    expect(t.summary.closedWindow).toMatchObject({
      from: "Sat 09-12 00:00 ET",
      to: "Sun 09-13 20:00 ET",
      hours: 44,
      startedBeforeWindow: true,
      closedSince: "Fri 09-11 20:00 ET",
      closedHours: 48,
    });
    expect(t.headline[0]).toMatch(
      /^Market closed Fri 09-11 20:00 ET → Sun 09-13 20:00 ET \(48 h; /,
    );
    expect(t.headline[0]).toMatch(/44 h of it are replayed/);
    expect(t.headline.join(" ")).not.toMatch(/Market closed Sat/);
  });

  it("calls the control lane's span the replayed part of the closed window", () => {
    expect(t.lvr?.statement).toMatch(/all through the 44 h of the closed window replayed/);
  });

  it("keeps the plain wording when the window opens before the close", () => {
    const open = runReplay(input());
    expect(open.summary.closedWindow).toMatchObject({
      startedBeforeWindow: false,
      closedSince: "Fri 09-11 20:00 ET",
    });
    expect(open.headline[0]).toMatch(
      /^Market closed Fri 09-11 20:00 ET → Fri 09-11 21:00 ET \(1 h\): /,
    );
    expect(open.lvr).toBeNull();
  });
});

describe("parseReplayInput", () => {
  it("refuses a missing label or rows off the grid", () => {
    const good = input();
    expect(() => parseReplayInput({ ...good, label: "LIVE" })).toThrow();
    const rows = [...good.rows];
    rows[3] = { ...(rows[3] as ReplayInputRow), ts: (rows[3] as ReplayInputRow).ts + 1 };
    expect(() => parseReplayInput({ ...good, rows })).toThrow(/grid/);
  });
});
