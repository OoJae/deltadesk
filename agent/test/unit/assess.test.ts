/**
 * The assess port must equal engine/api/app.py::assess on every golden case
 * (test/fixtures/assess_cases.json): verdict and the ordered reason levels.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assess, FEED_DEAD_S, GAP_CAUTION_BPS } from "../../src/market/assess.js";
import { regimeAt } from "../../src/market/calendar.js";
import type { HourRecord } from "../../src/types.js";

interface AssessCase {
  ts: number;
  gap_bps: number;
  hour: HourRecord | null;
  chainlink_age_s: number | null;
  verdict: string;
  levels: string[];
}
const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/assess_cases.json", import.meta.url), "utf8"),
) as {
  gap_caution_bps: Record<string, number>;
  cases: AssessCase[];
};

describe("assess golden fixtures", () => {
  it("uses the engine's gap thresholds", () => {
    expect(GAP_CAUTION_BPS).toEqual(fixture.gap_caution_bps);
    expect(FEED_DEAD_S).toBe(26 * 3600);
  });

  it(`matches every one of the ${fixture.cases.length} cases exactly`, () => {
    expect(fixture.cases.length).toBeGreaterThan(200);
    const mismatches: string[] = [];
    for (const [i, c] of fixture.cases.entries()) {
      const r = assess(c.gap_bps, regimeAt(c.ts), c.hour, c.chainlink_age_s);
      const got = { verdict: r.verdict, levels: r.reasons.map((x) => x.level) };
      const want = { verdict: c.verdict, levels: c.levels };
      if (JSON.stringify(got) !== JSON.stringify(want))
        mismatches.push(`#${i}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
    }
    expect(mismatches).toEqual([]);
  });

  it("exercises ALLOW, CAUTION and BLOCK", () => {
    expect(new Set(fixture.cases.map((c) => c.verdict))).toEqual(
      new Set(["ALLOW", "CAUTION", "BLOCK"]),
    );
  });
});

describe("assess semantics", () => {
  const regular = { name: "REGULAR" as const, reopenKind: null };

  it("never BLOCKs on the gap alone (the gap rule is unvalidated)", () => {
    const r = assess(500, regular, null, null);
    expect(r.verdict).toBe("CAUTION");
    expect(r.reasons[0]?.reason).toContain("unvalidated");
  });

  it("BLOCKs the validated weekday open and toxic hours", () => {
    expect(assess(0, { name: "REGULAR", reopenKind: "weekday_open" }, null, null).verdict).toBe(
      "BLOCK",
    );
    expect(assess(0, regular, { edge_1h: 0.3, picked_1h_usd: 50 }, null).verdict).toBe("BLOCK");
  });

  it("ignores the edge when takers lost on average (picked ≤ 0) and treats {} like None", () => {
    expect(assess(0, regular, { edge_1h: 0.1, picked_1h_usd: -40 }, null).verdict).toBe("ALLOW");
    expect(assess(0, regular, {}, null).verdict).toBe("ALLOW");
  });

  it("flags a dead feed only in an open session", () => {
    expect(assess(0, regular, null, 27 * 3600).verdict).toBe("CAUTION");
    expect(
      assess(0, { name: "WEEKEND_DARK", reopenKind: null }, null, 27 * 3600).reasons,
    ).toHaveLength(1);
  });
});
