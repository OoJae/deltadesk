/**
 * Typed shim over the Dynamic SDKs (@dynamic-labs-wallet/node and node-evm, pinned 1.1.14).
 *
 * Their published .d.ts files re-export `./src/index` without an extension, which NodeNext cannot
 * resolve, so the packages type-check as empty modules. This file declares exactly the surface the
 * agent uses (verified against node_modules/@dynamic-labs-wallet/{node,node-evm}/src/*.d.ts and the
 * esm bundles) and loads the packages lazily: they pull in a native MPC addon, which only the
 * processes that actually sign or decrypt should load.
 */

import type { TransactionSerializable } from "viem";

/** An MPC key share (EcdsaKeygenResult et al.): opaque JSON to us, sealed by the vault. */
export type ServerKeyShare = Record<string, unknown>;

export type ThresholdSignatureScheme = "TWO_OF_TWO" | "TWO_OF_THREE" | "THREE_OF_FIVE";

export interface WalletMetadata {
  walletId: string;
  accountAddress: string;
  chainName: string;
  thresholdSignatureScheme: ThresholdSignatureScheme;
  derivationPath?: string;
}

/** DelegatedEvmWalletClient: opaque, only ever passed back into the SDK. */
export interface DelegatedEvmWalletClient {
  readonly chainName: "EVM";
}

/** EncryptedDelegatedPayload of the `wallet.delegation.created` webhook (RSA-OAEP-256 + AES-256-GCM). */
export interface EncryptedDelegatedPayload {
  alg: string;
  iv: string;
  ct: string;
  tag: string;
  ek: string;
  kid?: string;
}

export interface NodeSdk {
  decryptDelegatedWebhookData(args: {
    privateKeyPem: string;
    encryptedDelegatedKeyShare: EncryptedDelegatedPayload;
    encryptedWalletApiKey: EncryptedDelegatedPayload;
  }): { decryptedDelegatedShare: ServerKeyShare; decryptedWalletApiKey: string };
}

export interface DynamicEvmWalletClientInstance {
  authenticateApiToken(authToken: string): Promise<void>;
  signTransaction(args: {
    walletMetadata: WalletMetadata;
    transaction: TransactionSerializable;
    externalServerKeyShares?: ServerKeyShare[];
  }): Promise<string>;
  createWalletAccount(args: {
    thresholdSignatureScheme: ThresholdSignatureScheme;
    backUpToDynamic?: boolean;
  }): Promise<{
    walletMetadata: WalletMetadata;
    externalServerKeyShares: ServerKeyShare[];
  }>;
}

export interface NodeEvmSdk {
  createDelegatedEvmWalletClient(cfg: {
    environmentId: string;
    apiKey: string;
    baseApiUrl?: string;
  }): DelegatedEvmWalletClient;
  delegatedSignTransaction(
    client: DelegatedEvmWalletClient,
    args: {
      walletId: string;
      walletApiKey: string;
      keyShare: ServerKeyShare;
      transaction: TransactionSerializable;
    },
  ): Promise<string>;
  DynamicEvmWalletClient: new (cfg: {
    environmentId: string;
    baseApiUrl?: string;
  }) => DynamicEvmWalletClientInstance;
}

export async function loadNodeSdk(): Promise<NodeSdk> {
  return (await import("@dynamic-labs-wallet/node")) as unknown as NodeSdk;
}

export async function loadNodeEvmSdk(): Promise<NodeEvmSdk> {
  return (await import("@dynamic-labs-wallet/node-evm")) as unknown as NodeEvmSdk;
}
