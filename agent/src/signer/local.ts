/**
 * Local signer (viem privateKeyToAccount): anvil / fork only. It refuses to exist unless the RPC it
 * will be used with is loopback, in addition to config.ts refusing SIGNER_KIND=local otherwise, so a
 * raw operator key can never sign for a remote chain even if a caller skips loadConfig.
 */

import { privateKeyToAccount } from "viem/accounts";
import { isLoopbackUrl } from "../config.js";
import { type Address, ConfigRefusedError, type Hex, type TxSigner } from "../types.js";
import { toViemTx } from "./types.js";

export type { TxSigner } from "../types.js";

export interface LocalSignerOptions {
  privateKey: Hex;
  /** The RPC the signed transactions are meant for (must be loopback). */
  rpcUrl: string;
}

export function createLocalSigner(opts: LocalSignerOptions): TxSigner {
  if (!isLoopbackUrl(opts.rpcUrl)) {
    throw new ConfigRefusedError(
      "the local signer only signs against a loopback RPC (anvil / fork)",
    );
  }
  const account = privateKeyToAccount(opts.privateKey);
  return {
    kind: "local",
    address: account.address.toLowerCase() as Address,
    signTransaction: (tx) => account.signTransaction(toViemTx(tx)),
    async ready() {
      return { ready: true, reason: null };
    },
  };
}
