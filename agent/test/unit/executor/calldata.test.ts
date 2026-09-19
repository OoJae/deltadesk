import { encodeFunctionData, parseAbi, toFunctionSelector } from "viem";
import { describe, expect, it } from "vitest";
import { OPERATOR_SELECTOR_SET, OPERATOR_SELECTORS } from "../../../src/executor/abi/DeskLane.js";
import { createCalldataBuilder, type LaneCallAction } from "../../../src/executor/calldata.js";
import type { Address, Meta } from "../../../src/types.js";
import { LANE, metaFor, OTHER_ADDR, testUlid } from "./_fixtures.js";

const meta: Meta = metaFor(testUlid(), 0, 1_758_470_445);
const builder = createCalldataBuilder("0x1111111111111111111111111111111111111111");

const actions: LaneCallAction[] = [
  {
    kind: "rerange",
    lane: "A",
    ranges: [
      { tickLower: -222_400, tickUpper: -222_200, share0Bps: 5_000, share1Bps: 5_000 },
      { tickLower: -222_600, tickUpper: -222_400, share0Bps: 0, share1Bps: 5_000 },
    ],
    expectedTick: -222_277,
    maxTickDelta: 10,
  },
  { kind: "rerange", lane: "A", ranges: [], expectedTick: -222_277, maxTickDelta: 10 },
  { kind: "reduce", lane: "A", slot: 1, liquidity: 123_456_789n },
  { kind: "collect", lane: "A" },
  { kind: "exitAll", lane: "B" },
  { kind: "signal", lane: "A", note: "gate change" },
  { kind: "pause", lane: "A" },
];

describe("calldata builder", () => {
  it.each(actions.map((a) => [a.kind, a] as const))(
    "%s round-trips and targets only the configured lane",
    (_k, action) => {
      const call = builder.encode(action, meta);
      expect(call.to).toBe(LANE);
      expect(call.value).toBe(0n);
      expect(OPERATOR_SELECTOR_SET.has(call.selector)).toBe(true);
      expect(call.selector).toBe(OPERATOR_SELECTORS[action.kind]);
      const decoded = builder.decode(call.data);
      expect(decoded.functionName).toBe(action.kind);
      if (action.kind !== "pause") {
        const m = decoded.args[0] as Meta;
        expect(m.decisionId).toBe(meta.decisionId);
        expect(m.deadline).toBe(meta.deadline);
        expect(m.reasonHash).toBe(meta.reasonHash);
      }
      if (action.kind === "rerange") {
        expect(decoded.args[1]).toEqual(action.ranges);
        expect(decoded.args[2]).toBe(action.expectedTick);
        expect(decoded.args[3]).toBe(action.maxTickDelta);
      }
      if (action.kind === "reduce") expect(decoded.args.slice(1)).toEqual([1, 123_456_789n]);
    },
  );

  it("`to` is fixed at construction: no action or meta can change it", () => {
    const other = createCalldataBuilder(OTHER_ADDR);
    for (const a of actions) expect(other.encode(a, meta).to).toBe(OTHER_ADDR);
    expect(() => createCalldataBuilder("0x1234" as Address)).toThrow(/not an address/);
  });

  it("refuses to decode anything outside the operator surface", () => {
    const owner = parseAbi([
      "function withdraw(address token, uint256 amount)",
      "function unpause()",
      "function setCaps((uint64,uint64,uint16,uint24,uint24,uint24,uint16,uint16,uint32,uint32,uint8) caps)",
    ]);
    const withdraw = encodeFunctionData({
      abi: owner,
      functionName: "withdraw",
      args: [OTHER_ADDR, 1n],
    });
    expect(() => builder.decode(withdraw)).toThrow(/not an operator function/);
    expect(() => builder.decode(toFunctionSelector("unpause()"))).toThrow(
      /not an operator function/,
    );
  });

  it("range-checks values instead of truncating them", () => {
    const bad =
      (a: LaneCallAction, m: Meta = meta) =>
      () =>
        builder.encode(a, m);
    expect(
      bad({
        kind: "rerange",
        lane: "A",
        ranges: [{ tickLower: -900_000, tickUpper: 0, share0Bps: 1, share1Bps: 1 }],
        expectedTick: 0,
        maxTickDelta: 10,
      }),
    ).toThrow(RangeError);
    expect(
      bad({
        kind: "rerange",
        lane: "A",
        ranges: [{ tickLower: 0, tickUpper: 10, share0Bps: 10_001, share1Bps: 0 }],
        expectedTick: 0,
        maxTickDelta: 10,
      }),
    ).toThrow(RangeError);
    expect(
      bad({
        kind: "rerange",
        lane: "A",
        ranges: [{ tickLower: 0.5, tickUpper: 10, share0Bps: 1, share1Bps: 0 }],
        expectedTick: 0,
        maxTickDelta: 10,
      }),
    ).toThrow(RangeError);
    expect(bad({ kind: "reduce", lane: "A", slot: 1, liquidity: 0n })).toThrow(RangeError);
    expect(bad({ kind: "reduce", lane: "A", slot: 2 as 0, liquidity: 1n })).toThrow(RangeError);
    expect(
      bad({ kind: "collect", lane: "A" }, { ...meta, decisionId: `0x${"0".repeat(64)}` }),
    ).toThrow(/nonzero/);
    expect(bad({ kind: "collect", lane: "A" }, { ...meta, deadline: 0n })).toThrow(/deadline/);
    expect(bad({ kind: "collect", lane: "A" }, { ...meta, regime: 256 })).toThrow(/regime/);
    expect(bad({ kind: "collect", lane: "A" }, { ...meta, gatesMask: 70_000 })).toThrow(
      /gatesMask/,
    );
  });
});
