/**
 * Simulation: eth_call FROM the signer AT a pinned block, then decode the return values (rerange's
 * tokenIds / liquidities / amounts) or the lane's custom error. A successful call is followed by an
 * estimateGas (latest state, so it includes Orbit's L1 component) for the executor's gas limit.
 *
 * Writes nothing and never throws for a revert: the result carries the classified error, so the
 * guard's simulation-ok rule and the evidence trail see exactly why.
 */

import { decodeFunctionResult } from "viem";
import type {
  Address,
  ChainClient,
  ExecError,
  RerangeReturn,
  SimulationError,
  SimulationResult,
  Simulator,
  TxCall,
} from "../types.js";
import { deskLaneAbi, OPERATOR_SELECTORS } from "./abi/DeskLane.js";
import { classifySimulationError } from "./errors.js";

export type { RerangeReturn, SimulationError, SimulationResult, Simulator } from "../types.js";

export function decodeRerangeReturn(data: `0x${string}`): RerangeReturn {
  const [tokenIds, liquidities, amount0Used, amount1Used] = decodeFunctionResult({
    abi: deskLaneAbi,
    functionName: "rerange",
    data,
  });
  return { tokenIds, liquidities, amount0Used, amount1Used };
}

export function simulationErrorOf(e: ExecError): SimulationError {
  const detail = (e.detail ?? {}) as { errorName?: unknown; args?: unknown };
  return {
    code: e.code,
    errorName: typeof detail.errorName === "string" ? detail.errorName : null,
    args: Array.isArray(detail.args) ? detail.args : [],
    message: e.message,
  };
}

export interface SimulatorDeps {
  chain: Pick<ChainClient, "call" | "estimateGas" | "blockNumber">;
}

export function createSimulator(deps: SimulatorDeps): Simulator {
  const { chain } = deps;
  return {
    async simulate(call: TxCall, from: Address, blockNumber: bigint): Promise<SimulationResult> {
      const base = {
        blockNumber,
        from,
        returnData: null,
        rerange: null,
        gasEstimate: null,
      } as const;
      let latestBlockNumber = blockNumber;
      try {
        latestBlockNumber = await chain.blockNumber();
      } catch {
        // The pinned block is the best we know; the guard's block-age rule then reads 0.
      }
      let returnData: `0x${string}`;
      try {
        returnData = await chain.call({
          from,
          to: call.to,
          data: call.data,
          value: call.value,
          blockNumber,
        });
      } catch (err) {
        return {
          ...base,
          ok: false,
          latestBlockNumber,
          error: simulationErrorOf(classifySimulationError(err)),
        };
      }
      let rerange: RerangeReturn | null = null;
      if (call.selector === OPERATOR_SELECTORS.rerange) {
        try {
          rerange = decodeRerangeReturn(returnData);
        } catch (err) {
          return {
            ...base,
            ok: false,
            latestBlockNumber,
            returnData,
            error: {
              code: "SIM_POLICY",
              errorName: null,
              args: [],
              message: `rerange returned undecodable data: ${err instanceof Error ? err.message : String(err)}`,
            },
          };
        }
      }
      let gasEstimate: bigint;
      try {
        gasEstimate = await chain.estimateGas({
          from,
          to: call.to,
          data: call.data,
          value: call.value,
        });
      } catch (err) {
        return {
          ...base,
          ok: false,
          latestBlockNumber,
          returnData,
          rerange,
          error: simulationErrorOf(classifySimulationError(err)),
        };
      }
      return {
        ok: true,
        blockNumber,
        latestBlockNumber,
        from,
        returnData,
        rerange,
        error: null,
        gasEstimate,
      };
    },
  };
}
