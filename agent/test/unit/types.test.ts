import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type DeskAction,
  EXEC_ERROR_OUTCOME,
  ExecError,
  GATE_BITS,
  GATE_EFFECT,
  GATE_IMPLEMENTED,
  GATE_NAMES,
  GUARD_RULES,
  LANE_ACTION_NAMES,
  LANE_IDS,
  REGIME_CODE,
  riskClassOf,
} from "../../src/types.js";

describe("riskClassOf", () => {
  const A = "A" as const;
  it("classifies every action kind", () => {
    const cases: Array<[DeskAction, string]> = [
      [
        {
          kind: "rerange",
          lane: A,
          ranges: [{ tickLower: 0, tickUpper: 10, share0Bps: 1, share1Bps: 1 }],
          expectedTick: 5,
          maxTickDelta: 10,
        },
        "adding",
      ],
      [{ kind: "rerange", lane: A, ranges: [], expectedTick: 5, maxTickDelta: 10 }, "reducing"],
      [{ kind: "reduce", lane: A, slot: 0, liquidity: 1n }, "reducing"],
      [{ kind: "collect", lane: A }, "reducing"],
      [{ kind: "exitAll", lane: A }, "reducing"],
      [{ kind: "pause", lane: A }, "reducing"],
      [{ kind: "signal", lane: A, note: "x" }, "neutral"],
      [{ kind: "hold", lane: A, reason: "x" }, "neutral"],
      [
        {
          kind: "hedge",
          lane: "B",
          coin: "xyz:NVDA",
          asset: 110002,
          isBuy: false,
          sz: "0.1",
          px: "222",
          tif: "Alo",
          reduceOnly: false,
        },
        "adding",
      ],
      [
        {
          kind: "hedge",
          lane: "B",
          coin: "xyz:NVDA",
          asset: 110002,
          isBuy: true,
          sz: "0.1",
          px: "222",
          tif: "Ioc",
          reduceOnly: true,
        },
        "reducing",
      ],
    ];
    for (const [action, cls] of cases) expect(riskClassOf(action), action.kind).toBe(cls);
  });
});

describe("constants", () => {
  it("LANE_ACTION_NAMES follow the IDeskTypes.Action enum order", () => {
    const sol = readFileSync(
      new URL("../../../contracts/src/interfaces/IDeskTypes.sol", import.meta.url),
      "utf8",
    );
    const body = /enum Action \{([\s\S]*?)\}/.exec(sol)?.[1] ?? "";
    const names = body
      .split("\n")
      .map((l) =>
        l
          .replace(/\/\/.*$/, "")
          .trim()
          .replace(/,$/, ""),
      )
      .filter((l) => l.length > 0);
    expect(names).toEqual([...LANE_ACTION_NAMES]);
  });

  it("gate bits are unique powers of two inside uint16, and stubs force nothing", () => {
    const bits = GATE_NAMES.map((g) => GATE_BITS[g]);
    expect(new Set(bits).size).toBe(GATE_NAMES.length);
    for (const b of bits) expect(b > 0 && b < 65536 && (b & (b - 1)) === 0).toBe(true);
    for (const g of GATE_NAMES) if (!GATE_IMPLEMENTED[g]) expect(GATE_EFFECT[g]).toBe("none");
    expect(GATE_EFFECT.HALT).toBe("flat");
  });

  it("the guard has 25 unique rules with dry-run last", () => {
    expect(GUARD_RULES).toHaveLength(25);
    expect(new Set(GUARD_RULES).size).toBe(25);
    expect(GUARD_RULES.at(-1)).toBe("dry-run");
  });

  it("regime codes and lane ids are distinct and fit their uint8", () => {
    const codes = Object.values(REGIME_CODE);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes.every((c) => c > 0 && c < 256)).toBe(true);
    expect(LANE_IDS).toEqual({ A: 0, B: 1, C: 2 });
  });

  it("the error taxonomy maps as designed", () => {
    expect(EXEC_ERROR_OUTCOME.SIGNER_DENIED).toBe("policy_denied");
    expect(EXEC_ERROR_OUTCOME.SIGNER_REVOKED).toBe("revoked");
    expect(EXEC_ERROR_OUTCOME.NONCE_CONFLICT).toBe("safe_mode");
    expect(EXEC_ERROR_OUTCOME.FEE_CAP_TOO_LOW).toBe("resign_same_nonce");
    expect(EXEC_ERROR_OUTCOME.RECEIPT_TIMEOUT).toBe("unknown");
    const e = new ExecError("SIM_POLICY", "RangeOutsideFence", { detail: { index: 0 } });
    expect(e.outcome).toBe("fail");
    expect(e).toBeInstanceOf(Error);
  });
});
