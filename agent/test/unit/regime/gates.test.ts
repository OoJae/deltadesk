import { describe, expect, it } from "vitest";
import { etToEpochSec } from "../../../src/market/calendar.js";
import { createGateEvaluator, fenceCodeName } from "../../../src/regime/gates.js";
import { computeRegime, defaultRegimeDeps } from "../../../src/regime/index.js";
import { createGateMachine } from "../../../src/regime/machine.js";
import { freshness } from "../../../src/sense/freshness.js";
import { MOCK_NOW_MS, mockSnapshot } from "../../../src/sense/mock.js";
import type { DeskSnapshot, FreshnessMap, GateName } from "../../../src/types.js";

const ev = createGateEvaluator();
const FRESH: FreshnessMap = {
  chain: "FRESH",
  hl: "FRESH",
  rh: "FRESH",
  k: "FRESH",
  corpActions: "FRESH",
};

function on(
  snapshot: DeskSnapshot,
  f: FreshnessMap = FRESH,
  nowMs = snapshot.takenAtMs,
): GateName[] {
  return ev
    .evaluate({ snapshot, freshness: f, nowMs })
    .filter((t) => t.triggered)
    .map((t) => t.gate);
}

describe("gate triggers", () => {
  it("a regular-session mock with fresh references triggers nothing; stubs report not armed", () => {
    const s = mockSnapshot();
    expect(on(s)).toEqual([]);
    const stubs = ev
      .evaluate({ snapshot: s, freshness: FRESH, nowMs: s.takenAtMs })
      .filter((t) => t.gate === "EVENT");
    expect(stubs[0]?.reason).toMatch(/not armed/);
  });

  it("CLOSED: weekend or holiday calendar, or the lane's riskAddingOpen false", () => {
    const sat = mockSnapshot({ nowMs: Date.UTC(2026, 8, 19, 18, 0, 0) });
    expect(sat.calendar.name).toBe("WEEKEND_DARK");
    expect(on(sat)).toContain("CLOSED");
    const s = mockSnapshot();
    if (s.chain === null) throw new Error("chain");
    s.chain.lane.riskAddingOpen = { open: false, code: 5 };
    const t = ev
      .evaluate({ snapshot: s, freshness: FRESH, nowMs: s.takenAtMs })
      .find((x) => x.gate === "CLOSED");
    expect(t?.triggered).toBe(true);
    expect(t?.reason).toMatch(/MARKET_CLOSED/);
    expect(fenceCodeName(100)).toBe("LANE_PAUSED");
  });

  it("HALT follows Robinhood's isTradingHalt; an unknown RH state is STALE-REF, not HALT", () => {
    const s = mockSnapshot();
    expect(on({ ...s, rh: s.rh && { ...s.rh, isTradingHalt: true } })).toContain("HALT");
    const noRh = on({ ...s, rh: null }, { ...FRESH, rh: "UNAVAILABLE" });
    expect(noRh).not.toContain("HALT");
    expect(noRh).toContain("STALE-REF");
  });

  it("CORP-ACTION: pending action within 24 h, an undated pending action, a multiplier change, or an unknown feed", () => {
    const s = mockSnapshot();
    const now = s.takenAtMs;
    const ca = (next: number | null, pending = true) => ({
      ...s,
      corpActions: {
        pendingForSymbol: pending,
        nextEffectiveAtMs: next,
        items: [],
        fetchedAtMs: now,
      },
    });
    // the live NVDA dividend on Oct 1 is 10 days away: no gate on Sep 21
    const oct1 = etToEpochSec(2026, 10, 1, 0, 0) * 1000;
    expect(on(ca(oct1))).not.toContain("CORP-ACTION");
    expect(on(ca(now + 23 * 3_600_000))).toContain("CORP-ACTION");
    expect(on(ca(now - 3_600_000))).toContain("CORP-ACTION"); // past its date, not completed
    expect(on(ca(null))).toContain("CORP-ACTION");
    expect(on(ca(now, false))).not.toContain("CORP-ACTION");
    expect(on({ ...s, corpActions: null })).toContain("CORP-ACTION");
    expect(on(s, { ...FRESH, corpActions: "UNAVAILABLE" })).toContain("CORP-ACTION");
    if (s.chain === null) throw new Error("chain");
    const mult = structuredClone(s);
    if (mult.chain === null) throw new Error("chain");
    mult.chain.stockToken.effectiveAt = BigInt(Math.floor(now / 1000) + 20 * 3600);
    expect(on(mult)).toContain("CORP-ACTION");
    mult.chain.stockToken.effectiveAt = BigInt(Math.floor(now / 1000) - 30 * 3600);
    expect(on(mult)).not.toContain("CORP-ACTION");
  });

  it("STALE-REF: any of chain, HL, k or RH not FRESH, or no fair value", () => {
    const s = mockSnapshot();
    for (const src of ["chain", "hl", "k", "rh"] as const) {
      expect(on(s, { ...FRESH, [src]: "STALE" })).toContain("STALE-REF");
    }
    expect(on({ ...s, fairValue: null })).toContain("STALE-REF");
  });

  it("REOPEN-GUARD: weekday_open (09:20-09:45 ET) and wake", () => {
    const open = mockSnapshot({ nowMs: etToEpochSec(2026, 9, 21, 9, 30) * 1000 });
    expect(open.calendar.reopenKind).toBe("weekday_open");
    expect(on(open)).toContain("REOPEN-GUARD");
    const wake = mockSnapshot({ nowMs: etToEpochSec(2026, 9, 20, 20, 0) * 1000 });
    expect(wake.calendar.reopenKind).toBe("wake");
    expect(on(wake)).toContain("REOPEN-GUARD");
  });
});

describe("computeRegime", () => {
  it("maps active gates to the risk mode and the Meta gatesMask", () => {
    const machine = createGateMachine({ startActive: false });
    const deps = { ...defaultRegimeDeps, machine };
    const s = mockSnapshot();
    const normal = computeRegime(deps, s, machine.initial(MOCK_NOW_MS), MOCK_NOW_MS);
    expect(normal.riskMode).toBe("normal");
    expect(normal.gatesMask).toBe(0);
    expect(normal.regimeCode).toBe(1);

    const halted = computeRegime(
      deps,
      { ...s, rh: s.rh && { ...s.rh, isTradingHalt: true } },
      normal.gates,
      MOCK_NOW_MS + 5_000,
    );
    expect(halted.riskMode).toBe("flat");
    expect(halted.activeGates).toEqual(["HALT"]);
    expect(halted.gatesMask).toBe(1 << 1);
    expect(halted.transitions).toHaveLength(1);

    const stale = computeRegime(
      deps,
      { ...s, sources: { ...s.sources, hl: { ok: false, ageMs: null, reason: "down" } } },
      machine.initial(MOCK_NOW_MS),
      MOCK_NOW_MS,
    );
    expect(stale.freshness.hl).toBe("UNAVAILABLE");
    expect(stale.riskMode).toBe("reduce_only");
  });

  it("the default machine starts reduce-only until the first dwell clears", () => {
    const s = mockSnapshot();
    const deps = defaultRegimeDeps;
    let g = deps.machine.initial(MOCK_NOW_MS);
    const modes: string[] = [];
    for (let i = 0; i < 4; i++) {
      const r = computeRegime(deps, s, g, MOCK_NOW_MS + i * 5_000);
      g = r.gates;
      modes.push(r.riskMode);
    }
    expect(modes).toEqual(["reduce_only", "reduce_only", "normal", "normal"]);
  });

  it("uses the injected freshness function", () => {
    const s = mockSnapshot();
    const r = computeRegime(
      {
        ...defaultRegimeDeps,
        machine: createGateMachine({ startActive: false }),
        freshness: (src, reg) => ({ ...freshness(src, reg), k: "STALE" }),
      },
      s,
      createGateMachine({ startActive: false }).initial(MOCK_NOW_MS),
      MOCK_NOW_MS,
    );
    expect(r.activeGates).toEqual(["STALE-REF"]);
  });
});
