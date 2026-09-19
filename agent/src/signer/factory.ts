/**
 * The operator signer and vault from config (SIGNER_KIND). Used by the entry points and scripts;
 * the modules themselves stay dependency-injected.
 *
 * The delegated signer needs the OPERATOR address (the lane's on-chain operator, whose delegation
 * the webhook stored); Plan B uses DYNAMIC_SERVER_WALLET_ADDRESS; local derives it from the key.
 */

import type { AppConfig } from "../config.js";
import {
  type Address,
  ConfigRefusedError,
  type DeskDb,
  type TxSigner,
  type Vault,
} from "../types.js";
import { createDynamicDelegatedSigner } from "./dynamic-delegated.js";
import { createDynamicServerSigner } from "./dynamic-server.js";
import { createLocalSigner } from "./local.js";
import { createVault } from "./vault.js";

export function vaultFromConfig(cfg: AppConfig): Vault | null {
  if (cfg.vault.kekB64 === undefined) return null;
  return createVault({ kekB64: cfg.vault.kekB64, kekId: cfg.vault.kekId });
}

export function signerFromConfig(
  cfg: AppConfig,
  db: Pick<DeskDb, "getActiveDelegationByAddress" | "getServerWallet">,
  operator: Address | undefined,
): TxSigner {
  switch (cfg.signer.kind) {
    case "local":
      if (cfg.signer.localPrivateKey === undefined)
        throw new ConfigRefusedError("SIGNER_KIND=local requires LOCAL_SIGNER_PRIVATE_KEY");
      return createLocalSigner({ privateKey: cfg.signer.localPrivateKey, rpcUrl: cfg.rpcUrl });
    case "dynamic-delegated": {
      const vault = vaultFromConfig(cfg);
      const { environmentId, apiKey } = cfg.dynamic;
      if (vault === null || environmentId === undefined || apiKey === undefined)
        throw new ConfigRefusedError(
          "SIGNER_KIND=dynamic-delegated needs DYNAMIC_ENVIRONMENT_ID, DYNAMIC_API_KEY and DESK_VAULT_KEK_B64",
        );
      if (operator === undefined)
        throw new ConfigRefusedError("the delegated signer needs the lane's operator address");
      return createDynamicDelegatedSigner({
        address: operator,
        environmentId,
        apiKey,
        baseApiUrl: cfg.dynamic.baseApiUrl,
        db,
        vault,
      });
    }
    case "dynamic-server": {
      const vault = vaultFromConfig(cfg);
      const { environmentId, apiKey } = cfg.dynamic;
      const address = cfg.signer.serverWalletAddress;
      if (
        vault === null ||
        environmentId === undefined ||
        apiKey === undefined ||
        address === undefined
      )
        throw new ConfigRefusedError(
          "SIGNER_KIND=dynamic-server needs DYNAMIC_ENVIRONMENT_ID, DYNAMIC_API_KEY, DESK_VAULT_KEK_B64 and DYNAMIC_SERVER_WALLET_ADDRESS",
        );
      return createDynamicServerSigner({
        address,
        environmentId,
        apiKey,
        baseApiUrl: cfg.dynamic.baseApiUrl,
        db,
        vault,
      });
    }
    default: {
      const unreachable: never = cfg.signer.kind;
      throw new ConfigRefusedError(`unknown SIGNER_KIND ${String(unreachable)}`);
    }
  }
}
