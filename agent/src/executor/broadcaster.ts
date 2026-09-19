/**
 * Broadcast stored bytes and poll for the receipt.
 *
 * - `broadcast` sends exactly the bytes it is given (recovery rebroadcasts the SAME bytes, never a
 *   re-signature) and returns keccak256(raw). A node that already holds those bytes ("already
 *   known") counts as success; a node returning a different hash is a critical mismatch.
 * - `waitForReceipt` polls every `pollMs` until `timeoutMs`; transient RPC errors keep polling. A
 *   timeout is not a failure, it is an unknown state for the reconciler.
 * The deadline check lives in the executor (it owns the Meta); this module never decides to skip.
 */

import { keccak256 } from "viem";
import {
  type Broadcaster,
  type ChainClient,
  type Clock,
  ExecError,
  type Hex,
  type ReceiptOutcome,
  type Sleep,
} from "../types.js";
import { classifyError } from "./errors.js";

export type { Broadcaster, ReceiptOutcome } from "../types.js";

const ALREADY_KNOWN = /already known|known transaction|transaction already imported/i;

const realSleep: Sleep = (ms) => new Promise<void>((r) => setTimeout(r, ms));

export interface BroadcasterDeps {
  chain: Pick<ChainClient, "sendRawTransaction" | "getTransactionReceipt">;
  clock: Clock;
  sleep?: Sleep;
}

export function txHashOf(raw: Hex): Hex {
  return keccak256(raw);
}

export function createBroadcaster(deps: BroadcasterDeps): Broadcaster {
  const sleep = deps.sleep ?? realSleep;
  return {
    async broadcast(raw: Hex): Promise<Hex> {
      const expected = txHashOf(raw);
      let returned: Hex;
      try {
        returned = await deps.chain.sendRawTransaction(raw);
      } catch (err) {
        const text =
          err instanceof Error
            ? `${err.message} ${String((err as { details?: unknown }).details ?? "")}`
            : String(err);
        if (ALREADY_KNOWN.test(text)) return expected;
        throw classifyError(err);
      }
      if (returned.toLowerCase() !== expected.toLowerCase()) {
        throw new ExecError(
          "SIGNER_MISMATCH",
          `node returned hash ${returned} for bytes hashing to ${expected}`,
          { detail: { returned, expected } },
        );
      }
      return expected;
    },

    async waitForReceipt(hash, opts): Promise<ReceiptOutcome> {
      const start = deps.clock.now();
      for (;;) {
        try {
          const r = await deps.chain.getTransactionReceipt(hash);
          if (r !== null) {
            return r.status === "success"
              ? { kind: "confirmed", receipt: r }
              : { kind: "reverted", receipt: r };
          }
        } catch {
          // transient: keep polling until the timeout
        }
        if (deps.clock.now() - start >= opts.timeoutMs) return { kind: "timeout" };
        await sleep(opts.pollMs);
      }
    },
  };
}
