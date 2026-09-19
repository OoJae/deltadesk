/**
 * Fees on Robinhood Chain (Arbitrum Orbit, FCFS ordering): the priority fee is always 0 (a tip buys
 * nothing), and maxFeePerGas = max(2 × baseFee, floor), clamped to the configured cap. A base fee
 * already above the cap is GAS_CAP (top-up / wait alert): we never chase fees.
 *
 * Re-signs after FEE_CAP_TOO_LOW go through `bump`, which never lowers the previous attempt's fee.
 */

import { ExecError, type FeePolicy, type FeeQuote } from "../types.js";

export type { FeePolicy, FeeQuote } from "../types.js";

export interface FeePolicyOptions {
  floorWei: bigint;
  capWei: bigint;
}

export interface DeskFeePolicy extends FeePolicy {
  /** A re-sign quote at the same nonce: at least 125% of the previous maxFee, still within the cap. */
  bump(block: Parameters<FeePolicy["quote"]>[0], previousMaxFee: bigint): FeeQuote;
}

export function createFeePolicy(opts: FeePolicyOptions): DeskFeePolicy {
  if (opts.floorWei <= 0n) throw new RangeError("fees: floor must be positive");
  if (opts.floorWei > opts.capWei) throw new RangeError("fees: floor exceeds cap");

  const quote: FeePolicy["quote"] = (block) => {
    const base = block.baseFeePerGas ?? 0n;
    if (base > opts.capWei) {
      throw new ExecError(
        "GAS_CAP",
        `base fee ${base} wei exceeds the configured max fee ${opts.capWei} wei`,
        { detail: { baseFeePerGas: base, capWei: opts.capWei } },
      );
    }
    const target = 2n * base > opts.floorWei ? 2n * base : opts.floorWei;
    return { maxFeePerGas: target > opts.capWei ? opts.capWei : target, maxPriorityFeePerGas: 0n };
  };

  return {
    quote,
    bump(block, previousMaxFee) {
      const q = quote(block);
      const bumped = (previousMaxFee * 125n + 99n) / 100n;
      const next = q.maxFeePerGas > bumped ? q.maxFeePerGas : bumped;
      if (next > opts.capWei && previousMaxFee >= opts.capWei) {
        throw new ExecError("GAS_CAP", "cannot bump the fee: already at the configured cap", {
          detail: { previousMaxFee, capWei: opts.capWei },
        });
      }
      return { maxFeePerGas: next > opts.capWei ? opts.capWei : next, maxPriorityFeePerGas: 0n };
    },
  };
}

/** estimateGas × 1.25, rounded up (the estimate includes Orbit's L1 component). */
export function gasLimitFor(estimate: bigint): bigint {
  return (estimate * 125n + 99n) / 100n;
}
