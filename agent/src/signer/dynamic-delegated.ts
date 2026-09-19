/**
 * Dynamic delegated signer (the M2 target): the user's OPERATOR embedded wallet, delegated to
 * DeltaDesk, signs through Dynamic's MPC with the key share and wallet API key that arrived in the
 * `wallet.delegation.created` webhook.
 *
 *   createDelegatedEvmWalletClient({ environmentId, apiKey })
 *   delegatedSignTransaction(client, { walletId, walletApiKey, keyShare, transaction }) → raw hex
 *
 * Credentials come from the vault, keyed by the operator address, and are opened only for the
 * duration of one sign. No active delegation (never delegated, or revoked) is SIGNER_REVOKED before
 * anything is sent; Dynamic's own failures are classified (policy denial → SIGNER_DENIED).
 *
 * The SDK is loaded lazily (it carries a native MPC addon), so importing this module is cheap and
 * tests inject the client and sign function.
 */

import type { TransactionSerializableEIP1559 } from "viem";
import { classifySignerError } from "../executor/errors.js";
import {
  type Address,
  type DelegationRow,
  type DeskDb,
  ExecError,
  type Hex,
  type TxSigner,
  type Vault,
} from "../types.js";
import {
  type DelegatedEvmWalletClient,
  loadNodeEvmSdk,
  type ServerKeyShare,
} from "./dynamic-sdk.js";
import { toViemTx } from "./types.js";
import { VAULT_PURPOSE, wipe } from "./vault.js";

export type { TxSigner } from "../types.js";

export type DelegatedSignFn = (
  client: DelegatedEvmWalletClient,
  args: {
    walletId: string;
    walletApiKey: string;
    keyShare: ServerKeyShare;
    transaction: TransactionSerializableEIP1559;
  },
) => Promise<string>;

export interface DelegatedSignerDeps {
  /** The operator wallet (the lane's on-chain operator; never the owner). */
  address: Address;
  db: Pick<DeskDb, "getActiveDelegationByAddress">;
  vault: Vault;
  client: () => Promise<DelegatedEvmWalletClient>;
  sign: DelegatedSignFn;
}

function activeCredentials(row: DelegationRow | null): row is DelegationRow & {
  keyShareCt: string;
  apiKeyCt: string;
  dekWrapped: string;
  kekId: string;
} {
  return (
    row !== null &&
    row.status === "active" &&
    row.keyShareCt !== null &&
    row.apiKeyCt !== null &&
    row.dekWrapped !== null &&
    row.kekId !== null
  );
}

export function createDelegatedSigner(deps: DelegatedSignerDeps): TxSigner {
  const address = deps.address.toLowerCase() as Address;
  return {
    kind: "dynamic-delegated",
    address,

    async signTransaction(tx) {
      const row = deps.db.getActiveDelegationByAddress(address);
      if (!activeCredentials(row)) {
        throw new ExecError(
          "SIGNER_REVOKED",
          `no active Dynamic delegation for operator ${address}`,
        );
      }
      const binding = { dekWrapped: row.dekWrapped, kekId: row.kekId };
      const aad = { walletId: row.walletId, address: row.accountAddress };
      let keyShareBytes: Uint8Array | null = null;
      let apiKeyBytes: Uint8Array | null = null;
      try {
        try {
          keyShareBytes = deps.vault.openField(binding, row.keyShareCt, {
            ...aad,
            purpose: VAULT_PURPOSE.keyShare,
          });
          apiKeyBytes = deps.vault.openField(binding, row.apiKeyCt, {
            ...aad,
            purpose: VAULT_PURPOSE.apiKey,
          });
        } catch (err) {
          throw new ExecError(
            "SIGNER_UNAVAILABLE",
            "the vault could not open this delegation (tampered row or wrong KEK)",
            { cause: err },
          );
        }
        const keyShare = JSON.parse(Buffer.from(keyShareBytes).toString("utf8")) as ServerKeyShare;
        const walletApiKey = Buffer.from(apiKeyBytes).toString("utf8");
        let raw: string;
        try {
          raw = await deps.sign(await deps.client(), {
            walletId: row.walletId,
            walletApiKey,
            keyShare,
            transaction: toViemTx(tx),
          });
        } catch (err) {
          throw classifySignerError(err);
        }
        return raw as Hex;
      } finally {
        wipe(keyShareBytes, apiKeyBytes);
      }
    },

    async ready() {
      const row = deps.db.getActiveDelegationByAddress(address);
      return activeCredentials(row)
        ? { ready: true, reason: null }
        : { ready: false, reason: `no active Dynamic delegation for ${address}` };
    },
  };
}

export interface DynamicDelegatedOptions {
  address: Address;
  environmentId: string;
  apiKey: string;
  baseApiUrl?: string | undefined;
  db: DelegatedSignerDeps["db"];
  vault: Vault;
}

/** Production wiring: loads @dynamic-labs-wallet/node-evm on first use. */
export function createDynamicDelegatedSigner(opts: DynamicDelegatedOptions): TxSigner {
  let client: Promise<DelegatedEvmWalletClient> | null = null;
  let signFn: DelegatedSignFn | null = null;
  const load = async () => {
    const sdk = await loadNodeEvmSdk();
    signFn = sdk.delegatedSignTransaction;
    return sdk.createDelegatedEvmWalletClient({
      environmentId: opts.environmentId,
      apiKey: opts.apiKey,
      ...(opts.baseApiUrl === undefined ? {} : { baseApiUrl: opts.baseApiUrl }),
    });
  };
  return createDelegatedSigner({
    address: opts.address,
    db: opts.db,
    vault: opts.vault,
    client: () => {
      client ??= load().catch((err: unknown) => {
        client = null;
        throw new ExecError("SIGNER_UNAVAILABLE", "the Dynamic SDK failed to load", {
          cause: err,
        });
      });
      return client;
    },
    sign: (c, args) => {
      if (signFn === null) throw new ExecError("SIGNER_UNAVAILABLE", "Dynamic SDK not loaded");
      return signFn(c, args);
    },
  });
}
