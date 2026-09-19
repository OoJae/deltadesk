/**
 * Calldata builder over the generated lane ABI (operator functions only).
 *
 * SAFETY
 * - `to` is fixed at construction from CONFIG (a configured or registered lane address); no action,
 *   plan or LLM string can carry a destination. The action union has no withdraw / unpause /
 *   setCaps / setOperator, and the generated ABI does not even contain them.
 * - Every encoded selector is re-checked against OPERATOR_SELECTORS, and `decode` refuses anything
 *   else, so a tampered or foreign payload cannot be round-tripped as ours.
 * - Values are range-checked before encoding (int24 ticks, uint16 shares, uint128 liquidity, …) so a
 *   bad plan fails here, loudly, instead of being silently truncated.
 */

import { decodeFunctionData, encodeFunctionData, isAddress, zeroHash } from "viem";
import type { Address, CalldataBuilder, DeskAction, Hex, Meta, TxCall } from "../types.js";
import { MAX_TICK, MAX_UINT128, MIN_TICK } from "../units.js";
import { deskLaneAbi, OPERATOR_SELECTOR_SET, type OperatorFunction } from "./abi/DeskLane.js";

export type { CalldataBuilder, Meta, TxCall } from "../types.js";

export type LaneCallAction = Exclude<DeskAction, { kind: "hold" | "hedge" }>;

const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;

function assertInt(name: string, v: number, min: number, max: number): void {
  if (!Number.isInteger(v) || v < min || v > max)
    throw new RangeError(`calldata: ${name} must be an integer in [${min}, ${max}], got ${v}`);
}

function metaTuple(meta: Meta) {
  if (!BYTES32_RE.test(meta.decisionId) || meta.decisionId === zeroHash)
    throw new RangeError(`calldata: decisionId must be a nonzero bytes32, got ${meta.decisionId}`);
  if (!BYTES32_RE.test(meta.reasonHash))
    throw new RangeError(`calldata: reasonHash must be bytes32, got ${meta.reasonHash}`);
  if (meta.deadline <= 0n || meta.deadline >= 1n << 64n)
    throw new RangeError(`calldata: deadline must be a positive uint64, got ${meta.deadline}`);
  assertInt("regime", meta.regime, 0, 255);
  assertInt("gatesMask", meta.gatesMask, 0, 65_535);
  return {
    decisionId: meta.decisionId,
    deadline: meta.deadline,
    regime: meta.regime,
    gatesMask: meta.gatesMask,
    reasonHash: meta.reasonHash,
  };
}

function encodeFor(action: LaneCallAction, meta: Meta): { fn: OperatorFunction; data: Hex } {
  switch (action.kind) {
    case "rerange": {
      for (const [i, r] of action.ranges.entries()) {
        assertInt(`ranges[${i}].tickLower`, r.tickLower, MIN_TICK, MAX_TICK);
        assertInt(`ranges[${i}].tickUpper`, r.tickUpper, MIN_TICK, MAX_TICK);
        assertInt(`ranges[${i}].share0Bps`, r.share0Bps, 0, 10_000);
        assertInt(`ranges[${i}].share1Bps`, r.share1Bps, 0, 10_000);
      }
      assertInt("expectedTick", action.expectedTick, MIN_TICK, MAX_TICK);
      assertInt("maxTickDelta", action.maxTickDelta, 0, 16_777_215);
      return {
        fn: "rerange",
        data: encodeFunctionData({
          abi: deskLaneAbi,
          functionName: "rerange",
          args: [
            metaTuple(meta),
            action.ranges.map((r) => ({
              tickLower: r.tickLower,
              tickUpper: r.tickUpper,
              share0Bps: r.share0Bps,
              share1Bps: r.share1Bps,
            })),
            action.expectedTick,
            action.maxTickDelta,
          ],
        }),
      };
    }
    case "reduce":
      if (action.slot !== 0 && action.slot !== 1)
        throw new RangeError(`calldata: slot must be 0 or 1, got ${String(action.slot)}`);
      if (action.liquidity <= 0n || action.liquidity > MAX_UINT128)
        throw new RangeError(`calldata: liquidity must be a positive uint128`);
      return {
        fn: "reduce",
        data: encodeFunctionData({
          abi: deskLaneAbi,
          functionName: "reduce",
          args: [metaTuple(meta), action.slot, action.liquidity],
        }),
      };
    case "collect":
    case "exitAll":
    case "signal":
      return {
        fn: action.kind,
        data: encodeFunctionData({
          abi: deskLaneAbi,
          functionName: action.kind,
          args: [metaTuple(meta)],
        }),
      };
    case "pause":
      // pause() takes no Meta: the execution row still carries the step's decisionId.
      return { fn: "pause", data: encodeFunctionData({ abi: deskLaneAbi, functionName: "pause" }) };
    default: {
      const unreachable: never = action;
      throw new Error(`calldata: unsupported action ${JSON.stringify(unreachable)}`);
    }
  }
}

export function selectorOf(data: Hex): Hex {
  return data.slice(0, 10).toLowerCase() as Hex;
}

export interface LaneCalldataBuilder extends CalldataBuilder {
  /** The one destination this builder can produce (from config). */
  readonly laneAddress: Address;
}

/** `laneAddress` must come from config (DESK_LANE_*) or the registered desks table, never a plan. */
export function createCalldataBuilder(laneAddress: Address): LaneCalldataBuilder {
  if (!isAddress(laneAddress, { strict: false }))
    throw new TypeError(`calldata: lane address ${laneAddress} is not an address`);
  const to = laneAddress.toLowerCase() as Address;
  return {
    laneAddress: to,
    encode(action, meta): TxCall {
      const { data } = encodeFor(action, meta);
      const selector = selectorOf(data);
      if (!OPERATOR_SELECTOR_SET.has(selector))
        throw new Error(`calldata: selector ${selector} is not an operator function`);
      return { to, data, value: 0n, selector };
    },
    decode(data) {
      const selector = selectorOf(data);
      if (!OPERATOR_SELECTOR_SET.has(selector))
        throw new Error(`calldata: selector ${selector} is not an operator function`);
      const r = decodeFunctionData({ abi: deskLaneAbi, data });
      return { functionName: r.functionName, args: (r.args ?? []) as readonly unknown[] };
    },
  };
}
