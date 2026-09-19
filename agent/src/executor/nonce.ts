/**
 * Nonces: DB-backed, one transaction in flight per signer.
 *
 *   pending = eth_getTransactionCount(signer, "pending")
 *   dbNext  = nonce_state.last_nonce + 1
 *
 * - dbNext ≤ pending: use `pending` (anything the node already counts is taken, including a foreign
 *   use of the operator wallet).
 * - dbNext > pending: we signed a nonce the node no longer sees. If one of our attempts is still
 *   unresolved (signed / broadcast / unknown) it may yet land, so refuse and let the reconciler
 *   resolve it first. If every attempt is final (a dropped tx after its deadline), the stored nonce
 *   is stale: reset it and use `pending`.
 *
 * The executor advances nonce_state in the same SQLite transaction that records the signed bytes.
 */

import {
  type Address,
  type ChainClient,
  type DeskDb,
  ExecError,
  type NonceManager,
} from "../types.js";

export type { NonceManager, NonceStateRow } from "../types.js";

export interface NonceManagerDeps {
  db: Pick<DeskDb, "getNonceState" | "resetNonce" | "unresolvedAttempts">;
  chain: Pick<ChainClient, "getTransactionCount">;
  chainId: number;
  now: () => number;
}

export function createNonceManager(deps: NonceManagerDeps): NonceManager {
  return {
    async next(signer: Address): Promise<number> {
      const pending = await deps.chain.getTransactionCount(signer, "pending");
      const state = deps.db.getNonceState(signer);
      const dbNext = state === null ? 0 : state.lastNonce + 1;
      if (dbNext <= pending) return pending;

      const s = signer.toLowerCase();
      const open = deps.db.unresolvedAttempts().filter((a) => a.fromAddress.toLowerCase() === s);
      if (open.length > 0) {
        throw new ExecError(
          "UNKNOWN",
          `nonce ${dbNext} is ahead of the chain's pending count ${pending} while attempt ${open[0]?.txHash} is unresolved; reconcile first`,
          { detail: { dbNext, pending, unresolved: open.map((a) => a.txHash) } },
        );
      }
      // Every attempt is final (e.g. dropped after its deadline): the stored nonce is stale.
      deps.db.resetNonce(signer, deps.chainId, pending - 1, deps.now());
      return pending;
    },
  };
}
