/**
 * The agent's write surface is exactly the six operator functions. Owner-only, admin and config
 * functions are absent from OPERATOR_SELECTORS AND from the generated ABI itself, so they cannot be
 * encoded at all. The generated modules must match contracts/abi (the frozen interfaces).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Abi,
  type AbiFunction,
  encodeFunctionData,
  toFunctionSelector,
  toFunctionSignature,
} from "viem";
import { describe, expect, it } from "vitest";
import {
  CONTRACTS_ABI_DIR,
  FORBIDDEN_FACTORY_FUNCTIONS,
  FORBIDDEN_LANE_FUNCTIONS,
  filterAbi,
  OUT_DIR,
  renderModules,
} from "../../scripts/abi-sync.js";
import {
  deskLaneAbi,
  OPERATOR_SELECTOR_SET,
  OPERATOR_SELECTORS,
} from "../../src/executor/abi/DeskLane.js";
import { deskLaneFactoryAbi } from "../../src/executor/abi/DeskLaneFactory.js";
import { priceFenceAbi } from "../../src/executor/abi/PriceFence.js";

const fullLaneAbi = JSON.parse(
  readFileSync(join(CONTRACTS_ABI_DIR, "IDeskLane.json"), "utf8"),
) as Abi;
const fullFunctions = fullLaneAbi.filter((i): i is AbiFunction => i.type === "function");
const selectorOf = (name: string): `0x${string}` => {
  const fn = fullFunctions.find((f) => f.name === name);
  if (fn === undefined) throw new Error(`no ${name} in the frozen IDeskLane ABI`);
  return toFunctionSelector(fn);
};

describe("OPERATOR_SELECTORS", () => {
  it("is exactly rerange, reduce, collect, exitAll, signal and pause", () => {
    expect(Object.keys(OPERATOR_SELECTORS).sort()).toEqual([
      "collect",
      "exitAll",
      "pause",
      "reduce",
      "rerange",
      "signal",
    ]);
    expect(OPERATOR_SELECTOR_SET.size).toBe(6);
    for (const [name, sel] of Object.entries(OPERATOR_SELECTORS))
      expect(sel).toBe(selectorOf(name));
  });

  it("never contains an owner, admin or config selector", () => {
    const forbidden = [
      "withdraw",
      "withdrawAll",
      "withdrawPosition",
      "unpause",
      "setCaps",
      "proposeOperator",
      "applyOperator",
      "setGuardian",
      "setClosedUntil",
      "revokeOperator",
      "applyCaps",
      "cancelCaps",
      "initialize",
    ];
    for (const name of forbidden) {
      expect(OPERATOR_SELECTOR_SET.has(selectorOf(name)), name).toBe(false);
    }
    // Spot-check against hand-written signatures, independent of the ABI JSON.
    for (const sig of [
      "withdraw(address,uint256)",
      "withdrawAll()",
      "withdrawPosition(uint8)",
      "unpause()",
      "setCaps((uint64,uint64,uint16,uint24,uint24,uint24,uint16,uint16,uint32,uint32,uint8))",
      "proposeOperator(address)",
      "applyOperator()",
      "setGuardian(address)",
      "setClosedUntil(uint64)",
    ]) {
      expect(OPERATOR_SELECTOR_SET.has(toFunctionSelector(sig)), sig).toBe(false);
      expect(
        fullFunctions.some((f) => toFunctionSignature(f) === sig),
        `${sig} exists in the frozen ABI`,
      ).toBe(true);
    }
  });
});

describe("generated ABIs", () => {
  it("strip every forbidden function (unrepresentable in the agent)", () => {
    const laneFns = deskLaneAbi.filter((i) => i.type === "function").map((f) => f.name);
    for (const name of FORBIDDEN_LANE_FUNCTIONS) expect(laneFns, name).not.toContain(name);
    const factoryFns = deskLaneFactoryAbi.filter((i) => i.type === "function").map((f) => f.name);
    for (const name of FORBIDDEN_FACTORY_FUNCTIONS) expect(factoryFns, name).not.toContain(name);
    expect(() =>
      encodeFunctionData({
        abi: deskLaneAbi,
        functionName: "withdrawAll" as never,
        args: [] as never,
      }),
    ).toThrow();
  });

  it("keep the views, events and errors the agent reads", () => {
    const names = new Set<string>(deskLaneAbi.map((i) => ("name" in i ? i.name : "")));
    for (const n of [
      "operator",
      "owner",
      "caps",
      "budgets",
      "refTick",
      "riskAddingOpen",
      "decisionUsedAt",
      "positions",
    ]) {
      expect(names.has(n), n).toBe(true);
    }
    for (const n of [
      "LaneAction",
      "PositionMinted",
      "CollectFailed",
      "RangeOutsideFence",
      "DecisionUsed",
      "BucketEmpty",
    ]) {
      expect(names.has(n), n).toBe(true);
    }
    expect(priceFenceAbi.map((i) => ("name" in i ? i.name : ""))).toEqual(
      expect.arrayContaining(["status", "usdPrice"]),
    );
  });

  it("encodes the operator calls", () => {
    const meta = {
      decisionId: `0x${"11".repeat(32)}` as `0x${string}`,
      deadline: 1_758_000_060n,
      regime: 1,
      gatesMask: 0,
      reasonHash: `0x${"22".repeat(32)}` as `0x${string}`,
    };
    const data = encodeFunctionData({
      abi: deskLaneAbi,
      functionName: "rerange",
      args: [
        meta,
        [{ tickLower: 222_170, tickUpper: 222_380, share0Bps: 10_000, share1Bps: 10_000 }],
        222_277,
        10,
      ],
    });
    expect(data.slice(0, 10)).toBe(OPERATOR_SELECTORS.rerange);
    expect(
      encodeFunctionData({ abi: deskLaneAbi, functionName: "exitAll", args: [meta] }).slice(0, 10),
    ).toBe(OPERATOR_SELECTORS.exitAll);
  });

  it("are in sync with contracts/abi (run `pnpm abi:sync` after an interface change)", () => {
    const modules = renderModules();
    for (const [file, content] of Object.entries(modules)) {
      expect(readFileSync(join(OUT_DIR, file), "utf8"), file).toBe(content);
    }
  });

  it("refuse to generate when a mutating function is unclassified", () => {
    const abi = [
      { type: "function", name: "sweep", inputs: [], outputs: [], stateMutability: "nonpayable" },
    ] as unknown as Abi;
    expect(() => filterAbi(abi, [], [], "Test")).toThrow(/classify it/);
  });
});
