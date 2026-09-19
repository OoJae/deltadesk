// `pnpm create-server-wallet --yes`: Plan B operator. Creates a 2-of-2 TSS wallet with the Dynamic
// server SDK (external server key shares NOT backed up to Dynamic), seals the key shares with the
// vault (AAD walletId|address|keyShares) into server_wallets, and prints the address to set as
// DYNAMIC_SERVER_WALLET_ADDRESS and to use as the lane's operator. Nothing secret is printed.
//
// This creates a real wallet in the configured Dynamic environment, hence the explicit --yes.

import { pathToFileURL } from "node:url";
import { getConfig } from "../src/config.js";
import type { ServerKeyShare } from "../src/signer/dynamic-sdk.js";
import { createServerWalletClient } from "../src/signer/dynamic-server.js";
import { vaultFromConfig } from "../src/signer/factory.js";
import { VAULT_PURPOSE } from "../src/signer/vault.js";
import { openDb } from "../src/state/db.js";
import type { Address, DeskDb, Vault } from "../src/types.js";

/** Seal and store one server wallet (exported for tests; no network). */
export function storeServerWallet(
  db: Pick<DeskDb, "upsertServerWallet">,
  vault: Vault,
  wallet: { walletId: string; address: Address; keyShares: ServerKeyShare[] },
  nowMs: number,
): void {
  const plaintext = Buffer.from(JSON.stringify(wallet.keyShares), "utf8");
  try {
    const sealed = vault.sealRow(
      { [VAULT_PURPOSE.keyShares]: plaintext },
      { walletId: wallet.walletId, address: wallet.address },
    );
    const ct = sealed.ciphertexts[VAULT_PURPOSE.keyShares];
    if (ct === undefined) throw new Error("vault produced no ciphertext");
    db.upsertServerWallet({
      address: wallet.address.toLowerCase() as Address,
      walletId: wallet.walletId,
      keySharesCt: ct,
      dekWrapped: sealed.dekWrapped,
      kekId: sealed.kekId,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    });
  } finally {
    plaintext.fill(0);
  }
}

async function main(argv: string[]): Promise<void> {
  if (!argv.includes("--yes")) {
    console.error("This creates a real wallet in your Dynamic environment. Re-run with --yes.");
    process.exit(2);
  }
  const cfg = await getConfig();
  const vault = vaultFromConfig(cfg);
  const { environmentId, apiKey } = cfg.dynamic;
  if (vault === null || environmentId === undefined || apiKey === undefined) {
    throw new Error("needs DYNAMIC_ENVIRONMENT_ID, DYNAMIC_API_KEY and DESK_VAULT_KEK_B64");
  }
  const client = await createServerWalletClient({
    environmentId,
    apiKey,
    baseApiUrl: cfg.dynamic.baseApiUrl,
  });
  const created = await client.createWalletAccount({
    thresholdSignatureScheme: "TWO_OF_TWO",
    backUpToDynamic: false,
  });
  const address = created.walletMetadata.accountAddress.toLowerCase() as Address;
  const db = openDb(cfg.paths.dbPath);
  try {
    storeServerWallet(
      db,
      vault,
      {
        walletId: created.walletMetadata.walletId,
        address,
        keyShares: created.externalServerKeyShares,
      },
      Date.now(),
    );
  } finally {
    db.close();
  }
  console.log(`server wallet: ${address}`);
  console.log(`wallet id:     ${created.walletMetadata.walletId}`);
  console.log(`key shares sealed under KEK "${vault.kekId}" in ${cfg.paths.dbPath}`);
  console.log(
    "Set DYNAMIC_SERVER_WALLET_ADDRESS to the address above; fund it with ~0.005 ETH on 4663.",
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
