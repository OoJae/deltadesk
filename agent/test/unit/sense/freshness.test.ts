import { describe, expect, it } from "vitest";
import { classifySource, createFreshness, freshness } from "../../../src/sense/freshness.js";
import type { SourceName, SourceStatus } from "../../../src/types.js";

const all = (s: SourceStatus): Record<SourceName, SourceStatus> => ({
  chain: s,
  hl: s,
  rh: s,
  k: s,
  corpActions: s,
});

describe("freshness", () => {
  it("FRESH / STALE / UNAVAILABLE by age, per source", () => {
    const w = { freshMs: 10, staleMs: 100 };
    expect(classifySource({ ok: true, ageMs: 10, reason: null }, w)).toBe("FRESH");
    expect(classifySource({ ok: true, ageMs: 11, reason: null }, w)).toBe("STALE");
    expect(classifySource({ ok: true, ageMs: 101, reason: null }, w)).toBe("UNAVAILABLE");
    expect(classifySource({ ok: true, ageMs: null, reason: null }, w)).toBe("UNAVAILABLE");
    expect(classifySource({ ok: true, ageMs: Number.NaN, reason: null }, w)).toBe("UNAVAILABLE");
  });

  it("a source whose last read failed is never FRESH", () => {
    expect(
      classifySource({ ok: false, ageMs: 0, reason: "boom" }, { freshMs: 10, staleMs: 100 }),
    ).toBe("STALE");
  });

  it("tolerates small clock skew but not data from the future", () => {
    const w = { freshMs: 10, staleMs: 100 };
    expect(classifySource({ ok: true, ageMs: -2_000, reason: null }, w)).toBe("FRESH");
    expect(classifySource({ ok: true, ageMs: -60_000, reason: null }, w)).toBe("UNAVAILABLE");
  });

  it("uses wider windows while the market is closed", () => {
    const hl40s = { ok: true, ageMs: 40_000, reason: null };
    expect(freshness(all(hl40s), "REGULAR").hl).toBe("STALE");
    expect(freshness(all({ ok: true, ageMs: 20_000, reason: null }), "WEEKEND_DARK").hl).toBe(
      "FRESH",
    );
    expect(freshness(all(hl40s), "HOLIDAY").hl).toBe("STALE");
    // k is a slow parameter: an hour-old fetch is still FRESH
    expect(freshness(all({ ok: true, ageMs: 3_600_000, reason: null }), "REGULAR").k).toBe("FRESH");
  });

  it("a missing source is UNAVAILABLE", () => {
    const f = createFreshness();
    const partial = { chain: { ok: true, ageMs: 0, reason: null } } as unknown as Record<
      SourceName,
      SourceStatus
    >;
    expect(f(partial, "REGULAR")).toEqual({
      chain: "FRESH",
      hl: "UNAVAILABLE",
      rh: "UNAVAILABLE",
      k: "UNAVAILABLE",
      corpActions: "UNAVAILABLE",
    });
  });
});
