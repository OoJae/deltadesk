/**
 * Dynamic server-wallet signer (Plan B, when the environment cannot delegate a second embedded
 * wallet): a DeltaDesk-held 2-of-2 TSS wallet is the lane's operator.
 *
 *   new DynamicEvmWalletClient({ environmentId }); await client.authenticateApiToken(apiKey)
 *   client.signTransaction({ walletMetadata, transaction, externalServerKeyShares }) → raw hex
 *
 * The external server key shares are sealed by the vault in `server_wallets`
 * (scripts/create-server-wallet.ts), opened only for one sign.
 */

import type { TransactionSerializableEIP1559 } from "viem";
import { classifySignerError } from "../executor/errors.js";
import {
  type Address,
  type DeskDb,
  ExecError,
  type Hex,
  type TxSigner,
  type Vault,
} from "../types.js";
import { loadNodeEvmSdk, type ServerKeyShare, type WalletMetadata } from "./dynamic-sdk.js";
import { toViemTx } from "./types.js";
import { VAULT_PURPOSE, wipe } from "./vault.js";

export type { TxSigner } from "../types.js";

/** The slice of DynamicEvmWalletClient this signer uses. */
export interface ServerWalletClient {
  signTransaction(args: {
    walletMetadata: WalletMetadata;
    transaction: TransactionSerializableEIP1559;
    externalServerKeyShares?: ServerKeyShare[];
  }): Promise<string>;
}

export interface ServerSignerDeps {
  address: Address;
  db: Pick<DeskDb, "getServerWallet">;
  vault: Vault;
  client: () => Promise<ServerWalletClient>;
}

export function walletMetadataFor(walletId: string, address: Address): WalletMetadata {
  return {
    walletId,
    accountAddress: address,
    chainName: "EVM",
    thresholdSignatureScheme: "TWO_OF_TWO",
  };
}

export function createServerWalletSigner(deps: ServerSignerDeps): TxSigner {
  const address = deps.address.toLowerCase() as Address;
  return {
    kind: "dynamic-server",
    address,

    async signTransaction(tx) {
      const row = deps.db.getServerWallet(address);
      if (row === null) {
        throw new ExecError("SIGNER_REVOKED", `no server wallet stored for operator ${address}`);
      }
      let sharesBytes: Uint8Array | null = null;
      try {
        try {
          sharesBytes = deps.vault.openField(
            { dekWrapped: row.dekWrapped, kekId: row.kekId },
            row.keySharesCt,
            { walletId: row.walletId, address, purpose: VAULT_PURPOSE.keyShares },
          );
        } catch (err) {
          throw new ExecError(
            "SIGNER_UNAVAILABLE",
            "the vault could not open the server wallet's key shares",
            { cause: err },
          );
        }
        const shares = JSON.parse(Buffer.from(sharesBytes).toString("utf8")) as ServerKeyShare[];
        try {
          const client = await deps.client();
          return (await client.signTransaction({
            walletMetadata: walletMetadataFor(row.walletId, address),
            transaction: toViemTx(tx),
            externalServerKeyShares: shares,
          })) as Hex;
        } catch (err) {
          throw classifySignerError(err);
        }
      } finally {
        wipe(sharesBytes);
      }
    },

    async ready() {
      return deps.db.getServerWallet(address) === null
        ? { ready: false, reason: `no server wallet stored for ${address}` }
        : { ready: true, reason: null };
    },
  };
}

export interface DynamicServerOptions {
  address: Address;
  environmentId: string;
  apiKey: string;
  baseApiUrl?: string | undefined;
  db: ServerSignerDeps["db"];
  vault: Vault;
}

/** An authenticated DynamicEvmWalletClient (loads the SDK on first use). */
export async function createServerWalletClient(opts: {
  environmentId: string;
  apiKey: string;
  baseApiUrl?: string | undefined;
}) {
  const { DynamicEvmWalletClient } = await loadNodeEvmSdk();
  const client = new DynamicEvmWalletClient({
    environmentId: opts.environmentId,
    ...(opts.baseApiUrl === undefined ? {} : { baseApiUrl: opts.baseApiUrl }),
  });
  await client.authenticateApiToken(opts.apiKey);
  return client;
}

/** Production wiring (Plan B). */
export function createDynamicServerSigner(opts: DynamicServerOptions): TxSigner {
  let client: Promise<ServerWalletClient> | null = null;
  return createServerWalletSigner({
    address: opts.address,
    db: opts.db,
    vault: opts.vault,
    client: () => {
      client ??= createServerWalletClient(opts).catch((err: unknown) => {
        client = null;
        throw classifySignerError(err);
      });
      return client;
    },
  });
}
