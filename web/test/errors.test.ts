// describeError's wording for the factory's CapsAboveCeiling(field): minWidthTicks and minRerangeInterval are floors
// (CapsLib.MIN_FIELDS), so a lane asking for less than them is below the factory's minimum, not above a ceiling.
import { BaseError, ContractFunctionRevertedError, RawContractError, encodeErrorResult } from "viem";
import { describe, expect, it } from "vitest";
import { deskLaneFactoryAbi } from "@/lib/desk/abi/DeskLaneFactory";
import { describeError } from "@/lib/desk/tx";

const capsAboveCeiling = (field: number) => encodeErrorResult({ abi: deskLaneFactoryAbi, errorName: "CapsAboveCeiling", args: [field] });

/** A revert as a wallet or RPC reports it: only the raw revert data, somewhere down the cause chain. */
const rawRevert = (field: number) => new BaseError("execution reverted", { cause: new RawContractError({ data: capsAboveCeiling(field) }) });

describe("CapsAboveCeiling", () => {
  it.each([
    [4, 'Cap "minWidthTicks" is below the factory\'s minimum. (CapsAboveCeiling)'],
    [8, 'Cap "minRerangeInterval" is below the factory\'s minimum. (CapsAboveCeiling)'],
    [0, 'Cap "maxDeployUsd6" is above the factory ceiling. (CapsAboveCeiling)'],
    [5, 'Cap "maxWidthTicks" is above the factory ceiling. (CapsAboveCeiling)'],
    [10, 'Cap "maxRanges" is above the factory ceiling. (CapsAboveCeiling)'],
  ])("field %i from raw revert data", (field, text) => {
    expect(describeError(rawRevert(field))).toBe(text);
  });

  it("from a decoded simulation revert", () => {
    const e = new BaseError("simulation failed", {
      cause: new ContractFunctionRevertedError({ abi: deskLaneFactoryAbi, data: capsAboveCeiling(8), functionName: "createLane" }),
    });
    expect(describeError(e)).toBe('Cap "minRerangeInterval" is below the factory\'s minimum. (CapsAboveCeiling)');
  });
});
