import { randomBytes } from "node:crypto";
import { keccak256, type TransactionSerializableEIP1559 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { storeServerWallet } from "../../../scripts/create-server-wallet.js";
import { loadConfig } from "../../../src/config.js";
import { createDelegatedSigner } from "../../../src/signer/dynamic-delegated.js";
import { createServerWalletSigner, walletMetadataFor } from "../../../src/signer/dynamic-server.js";
import { signerFromConfig } from "../../../src/signer/factory.js";
import { createLocalSigner } from "../../../src/signer/local.js";
import { signWithTimeout, verifySignedTx, withTimeout } from "../../../src/signer/types.js";
import { createVault, VAULT_PURPOSE } from "../../../src/signer/vault.js";
import {
  type Address,
  ConfigRefusedError,
  ExecError,
  type Hex,
  type UnsignedTx,
} from "../../../src/types.js";
import { memDb } from "../../helpers/fakes.js";
import {
  ANVIL_KEY_0,
  ANVIL_KEY_1,
  LANE,
  LOOPBACK,
  localSigner,
  OPERATOR_ADDR,
  T0,
} from "../executor/_fixtures.js";

const TX: UnsignedTx = {
  type: "eip1559",
  chainId: 4663,
  to: LANE,
  data: "0x8456cb59",
  value: 0n,
  nonce: 4,
  gas: 120_000n,
  maxFeePerGas: 20_000_000n,
  maxPriorityFeePerGas: 0n,
};

describe("verifySignedTx", () => {
  it("accepts exact bytes from the operator", async () => {
    const raw = await localSigner().signTransaction(TX);
    const v = await verifySignedTx(raw, TX, OPERATOR_ADDR);
    expect(v.hash).toBe(keccak256(raw));
    expect(v.recovered).toBe(OPERATOR_ADDR);
  });

  it.each([
    ["chainId", { chainId: 1 }],
    ["to", { to: "0x9999999999999999999999999999999999999999" as Address }],
    ["data", { data: "0x8456cb5900" as Hex }],
    ["value", { value: 1n }],
    ["nonce", { nonce: 5 }],
    ["gas", { gas: 120_001n }],
    ["maxFeePerGas", { maxFeePerGas: 20_000_001n }],
    ["maxPriorityFeePerGas", { maxPriorityFeePerGas: 1n }],
  ] as const)("rejects a signature over a different %s", async (_f, patch) => {
    const raw = await localSigner().signTransaction({ ...TX, ...patch });
    await expect(verifySignedTx(raw, TX, OPERATOR_ADDR)).rejects.toMatchObject({
      code: "SIGNER_MISMATCH",
    });
  });

  it("rejects the right transaction signed by the wrong key, garbage, and legacy types", async () => {
    const raw = await localSigner(ANVIL_KEY_1).signTransaction(TX);
    await expect(verifySignedTx(raw, TX, OPERATOR_ADDR)).rejects.toMatchObject({
      code: "SIGNER_MISMATCH",
    });
    await expect(verifySignedTx("0xdeadbeef", TX, OPERATOR_ADDR)).rejects.toMatchObject({
      code: "SIGNER_MISMATCH",
    });
    await expect(verifySignedTx(`0x02${"00".repeat(20)}`, TX, OPERATOR_ADDR)).rejects.toMatchObject(
      { code: "SIGNER_MISMATCH" },
    );
    const legacy = await privateKeyToAccount(ANVIL_KEY_0).signTransaction({
      type: "legacy",
      chainId: 4663,
      to: LANE,
      data: TX.data,
      nonce: 4,
      gas: 120_000n,
      gasPrice: 1n,
    });
    await expect(verifySignedTx(legacy, TX, OPERATOR_ADDR)).rejects.toMatchObject({
      code: "SIGNER_MISMATCH",
    });
  });

  it("withTimeout / signWithTimeout: a hung signer becomes SIGNER_UNAVAILABLE", async () => {
    await expect(withTimeout(new Promise(() => {}), 5, () => new Error("slow"))).rejects.toThrow(
      "slow",
    );
    expect(await withTimeout(Promise.resolve(7), 50, () => new Error("slow"))).toBe(7);
    const hung = { ...localSigner(), signTransaction: () => new Promise<Hex>(() => {}) };
    await expect(signWithTimeout(hung, TX, 5)).rejects.toMatchObject({
      code: "SIGNER_UNAVAILABLE",
    });
  });
});

describe("local signer", () => {
  it("refuses any non-loopback RPC", () => {
    for (const url of [
      "https://robinhood-mainnet.g.alchemy.com/v2/key",
      "http://10.0.0.5:8545",
      "https://rpc.mainnet.chain.robinhood.com",
    ]) {
      expect(() => createLocalSigner({ privateKey: ANVIL_KEY_0, rpcUrl: url })).toThrow(
        ConfigRefusedError,
      );
    }
    expect(createLocalSigner({ privateKey: ANVIL_KEY_0, rpcUrl: LOOPBACK }).address).toBe(
      OPERATOR_ADDR,
    );
  });
});

// ---------------------------------------------------------------------------------------------

const KEK = randomBytes(32).toString("base64");

function delegatedSetup() {
  const db = memDb();
  const vault = createVault({ kekB64: KEK, kekId: "k1" });
  const walletId = "wallet-op-1";
  const keyShare = { pubkey: "02ab", secretShare: "s3cr3t" };
  const sealed = vault.sealRow(
    {
      [VAULT_PURPOSE.keyShare]: Buffer.from(JSON.stringify(keyShare)),
      [VAULT_PURPOSE.apiKey]: Buffer.from("wallet-api-key"),
    },
    { walletId, address: OPERATOR_ADDR },
  );
  db.upsertDelegation({
    walletId,
    userId: "user-1",
    accountAddress: OPERATOR_ADDR,
    chain: "EVM",
    laneAddress: null,
    status: "active",
    keyShareCt: sealed.ciphertexts.keyShare ?? null,
    apiKeyCt: sealed.ciphertexts.apiKey ?? null,
    dekWrapped: sealed.dekWrapped,
    kekId: sealed.kekId,
    createdEventId: "evt-1",
    revokedEventId: null,
    createdAtMs: T0,
    updatedAtMs: T0,
    revokedAtMs: null,
  });
  const seen: Array<{
    walletId: string;
    walletApiKey: string;
    keyShare: unknown;
    transaction: TransactionSerializableEIP1559;
  }> = [];
  const account = privateKeyToAccount(ANVIL_KEY_0);
  let fail: unknown = null;
  const signer = createDelegatedSigner({
    address: OPERATOR_ADDR,
    db,
    vault,
    client: async () => ({ chainName: "EVM" }),
    sign: async (_c, args) => {
      seen.push(args);
      if (fail !== null) throw fail;
      return account.signTransaction(args.transaction);
    },
  });
  return { db, vault, signer, seen, keyShare, walletId, setFail: (e: unknown) => (fail = e) };
}

describe("dynamic-delegated signer", () => {
  it("opens the vault only to sign, passes Dynamic the share, the wallet API key and the viem tx", async () => {
    const s = delegatedSetup();
    expect(s.signer.kind).toBe("dynamic-delegated");
    expect(await s.signer.ready()).toEqual({ ready: true, reason: null });
    const raw = await s.signer.signTransaction(TX);
    expect(s.seen[0]?.walletId).toBe(s.walletId);
    expect(s.seen[0]?.walletApiKey).toBe("wallet-api-key");
    expect(s.seen[0]?.keyShare).toEqual(s.keyShare);
    expect(s.seen[0]?.transaction).toMatchObject({
      type: "eip1559",
      chainId: 4663,
      to: LANE,
      nonce: 4,
      maxPriorityFeePerGas: 0n,
    });
    await expect(verifySignedTx(raw, TX, OPERATOR_ADDR)).resolves.toBeDefined();
  });

  it("no delegation, or a revoked one → SIGNER_REVOKED before anything is sent to Dynamic", async () => {
    const s = delegatedSetup();
    s.db.revokeDelegation(s.walletId, "evt-revoke", T0 + 1);
    await expect(s.signer.signTransaction(TX)).rejects.toMatchObject({ code: "SIGNER_REVOKED" });
    expect(s.seen).toHaveLength(0);
    expect((await s.signer.ready()).ready).toBe(false);
  });

  it("a tampered ciphertext → SIGNER_UNAVAILABLE (fail closed), nothing sent", async () => {
    const s = delegatedSetup();
    const ct = s.db.getDelegation(s.walletId)?.apiKeyCt;
    if (typeof ct !== "string") throw new Error("no ciphertext stored");
    // Flip the FIRST char of the ciphertext segment: the last base64url char may carry only unused
    // padding bits, so changing it can decode to the very same bytes (a flaky "tamper").
    const [v, iv, tag, body = ""] = ct.split(".");
    const bad = [v, iv, tag, (body[0] === "A" ? "B" : "A") + body.slice(1)].join(".");
    s.db.sqlite
      .prepare("UPDATE delegations SET api_key_ct = ? WHERE wallet_id = ?")
      .run(bad, s.walletId);
    await expect(s.signer.signTransaction(TX)).rejects.toMatchObject({
      code: "SIGNER_UNAVAILABLE",
    });
    expect(s.seen).toHaveLength(0);
  });

  it("Dynamic's errors are classified: 403 policy → SIGNER_DENIED, network → SIGNER_UNAVAILABLE", async () => {
    const s = delegatedSetup();
    s.setFail(Object.assign(new Error("Forbidden"), { status: 403 }));
    await expect(s.signer.signTransaction(TX)).rejects.toMatchObject({ code: "SIGNER_DENIED" });
    s.setFail(Object.assign(new Error("Network error - no response received"), { status: 0 }));
    await expect(s.signer.signTransaction(TX)).rejects.toMatchObject({
      code: "SIGNER_UNAVAILABLE",
    });
  });
});

describe("dynamic-server signer (Plan B)", () => {
  it("stores sealed key shares and signs with walletMetadata TWO_OF_TWO", async () => {
    const db = memDb();
    const vault = createVault({ kekB64: KEK, kekId: "k1" });
    const shares = [{ share: "external-server-share" }];
    storeServerWallet(
      db,
      vault,
      { walletId: "srv-1", address: OPERATOR_ADDR, keyShares: shares },
      T0,
    );
    const row = db.getServerWallet(OPERATOR_ADDR);
    expect(row?.keySharesCt).not.toContain("external-server-share");
    const calls: unknown[] = [];
    const account = privateKeyToAccount(ANVIL_KEY_0);
    const signer = createServerWalletSigner({
      address: OPERATOR_ADDR,
      db,
      vault,
      client: async () => ({
        signTransaction: async (args) => {
          calls.push(args);
          return account.signTransaction(args.transaction);
        },
      }),
    });
    const raw = await signer.signTransaction(TX);
    await expect(verifySignedTx(raw, TX, OPERATOR_ADDR)).resolves.toBeDefined();
    expect(calls[0]).toMatchObject({
      walletMetadata: walletMetadataFor("srv-1", OPERATOR_ADDR),
      externalServerKeyShares: shares,
    });
    expect(walletMetadataFor("srv-1", OPERATOR_ADDR).thresholdSignatureScheme).toBe("TWO_OF_TWO");
  });

  it("an unknown server wallet → SIGNER_REVOKED", async () => {
    const signer = createServerWalletSigner({
      address: OPERATOR_ADDR,
      db: memDb(),
      vault: createVault({ kekB64: KEK, kekId: "k1" }),
      client: async () => {
        throw new Error("never called");
      },
    });
    await expect(signer.signTransaction(TX)).rejects.toBeInstanceOf(ExecError);
    expect((await signer.ready()).ready).toBe(false);
  });
});

describe("signerFromConfig", () => {
  it("local only against loopback; delegated needs the operator; Plan B needs its address", () => {
    const db = memDb();
    const local = signerFromConfig(
      loadConfig({
        RH_RPC_URL: LOOPBACK,
        SIGNER_KIND: "local",
        LOCAL_SIGNER_PRIVATE_KEY: ANVIL_KEY_0,
      }),
      db,
      undefined,
    );
    expect(local.address).toBe(OPERATOR_ADDR);
    const delegatedCfg = loadConfig({
      DYNAMIC_ENVIRONMENT_ID: "env",
      DYNAMIC_API_KEY: "dyn_x",
      DESK_VAULT_KEK_B64: KEK,
    });
    expect(() => signerFromConfig(delegatedCfg, db, undefined)).toThrow(/operator/);
    expect(signerFromConfig(delegatedCfg, db, OPERATOR_ADDR).kind).toBe("dynamic-delegated");
    expect(() => signerFromConfig(loadConfig({}), db, OPERATOR_ADDR)).toThrow(ConfigRefusedError);
    const serverCfg = loadConfig({
      SIGNER_KIND: "dynamic-server",
      DYNAMIC_ENVIRONMENT_ID: "env",
      DYNAMIC_API_KEY: "dyn_x",
      DESK_VAULT_KEK_B64: KEK,
    });
    expect(() => signerFromConfig(serverCfg, db, undefined)).toThrow(
      /DYNAMIC_SERVER_WALLET_ADDRESS/,
    );
  });
});
