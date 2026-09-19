import { constants, createDecipheriv, privateDecrypt, randomBytes } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1";
import { decodeFunctionData, encodeFunctionResult } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { deskLaneFactoryAbi } from "../../../src/executor/abi/DeskLaneFactory.js";
import {
  createDynamicWebhookHandler,
  evmAddressFromPublicKey,
  factoryLaneOwnerProbe,
  signDynamicPayload,
  verifyDynamicSignature,
  type WebhookDeps,
} from "../../../src/http/dynamic-webhook.js";
import { silentLogger } from "../../../src/log.js";
import { createVault, VAULT_PURPOSE } from "../../../src/signer/vault.js";
import type { DeskDb, DeskNotification } from "../../../src/types.js";
import { fixedClock, memDb } from "../../helpers/fakes.js";
import { deskRow, LANE, OPERATOR_ADDR, OWNER } from "../executor/_fixtures.js";
import { ENV_ID, encryptForDynamic, rsaKeyPair } from "./_http.js";

const SECRET = "whsec_test_0123456789abcdef";
const KEK = randomBytes(32).toString("base64");
const rsa = rsaKeyPair();
const SHARE = { pubkey: { pubkey: "02abcdef" }, secretShare: "very-secret-share" };
const API_KEY = "dyn_wallet_api_key_secret";

function createdEvent(eventId = "evt-created-1", patch: Record<string, unknown> = {}) {
  return {
    eventId,
    eventName: "wallet.delegation.created",
    environmentId: ENV_ID,
    timestamp: "2026-09-21T14:00:00Z",
    userId: "user-1",
    data: {
      walletId: "wallet-op-1",
      chain: "EVM",
      publicKey: OPERATOR_ADDR,
      userId: "user-1",
      encryptedDelegatedShare: encryptForDynamic(rsa.publicKeyPem, JSON.stringify(SHARE)),
      encryptedWalletApiKey: encryptForDynamic(rsa.publicKeyPem, API_KEY),
      ...patch,
    },
  };
}

function setup(over: Partial<WebhookDeps> = {}) {
  const db = memDb();
  const vault = createVault({ kekB64: KEK, kekId: "k1" });
  const notes: DeskNotification[] = [];
  let decryptCalls = 0;
  const handler = createDynamicWebhookHandler({
    db,
    secret: SECRET,
    environmentId: ENV_ID,
    rsaPrivateKeyPem: () => rsa.privateKeyPem,
    vault,
    decrypt: (args) => {
      decryptCalls += 1;
      const plain = (p: typeof args.encryptedWalletApiKey) => {
        // Same algorithm as the SDK: RSA-OAEP-256 unwrap, then AES-256-GCM.
        const key = privateDecrypt(
          {
            key: args.privateKeyPem,
            oaepHash: "sha256",
            padding: constants.RSA_PKCS1_OAEP_PADDING,
          },
          Buffer.from(p.ek, "base64url"),
        );
        const d = createDecipheriv("aes-256-gcm", key, Buffer.from(p.iv, "base64url"));
        d.setAuthTag(Buffer.from(p.tag, "base64url"));
        return Buffer.concat([d.update(Buffer.from(p.ct, "base64url")), d.final()]).toString(
          "utf8",
        );
      };
      return {
        decryptedDelegatedShare: JSON.parse(plain(args.encryptedDelegatedKeyShare)) as Record<
          string,
          unknown
        >,
        decryptedWalletApiKey: plain(args.encryptedWalletApiKey),
      };
    },
    clock: fixedClock(),
    logger: silentLogger,
    notifier: { notify: async (n) => void notes.push(n) },
    ...over,
  });
  const post = (body: unknown, headers: Record<string, string> = {}) => {
    const raw = Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    return handler.handle(raw, {
      "x-dynamic-signature-256": signDynamicPayload(raw, SECRET),
      ...headers,
    });
  };
  return { db, vault, notes, handler, post, decryptCalls: () => decryptCalls };
}

describe("HMAC x-dynamic-signature-256", () => {
  const body = Buffer.from('{"a":1}');
  const sig = signDynamicPayload(body, SECRET);

  it("accepts the hex HMAC, with or without `sha256=`, any case", () => {
    expect(verifyDynamicSignature(body, sig, SECRET)).toBe(true);
    expect(verifyDynamicSignature(body, `sha256=${sig}`, SECRET)).toBe(true);
    expect(verifyDynamicSignature(body, sig.toUpperCase(), SECRET)).toBe(true);
  });

  it("rejects a wrong secret, a modified body, a missing or malformed header", () => {
    expect(
      verifyDynamicSignature(body, signDynamicPayload(body, "other-secret-xxxx"), SECRET),
    ).toBe(false);
    expect(verifyDynamicSignature(Buffer.from('{"a":2}'), sig, SECRET)).toBe(false);
    expect(verifyDynamicSignature(body, undefined, SECRET)).toBe(false);
    expect(verifyDynamicSignature(body, "sha256=zz", SECRET)).toBe(false);
    expect(verifyDynamicSignature(body, sig.slice(0, 63), SECRET)).toBe(false);
  });
});

describe("POST /webhooks/dynamic handler", () => {
  it("wallet.delegation.created: stores the credentials sealed, bound to the lane whose operator it is", async () => {
    const s = setup();
    s.db.insertDesk(deskRow());
    const r = await s.post(createdEvent());
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      ok: true,
      walletId: "wallet-op-1",
      address: OPERATOR_ADDR,
      lane: LANE,
    });
    const row = s.db.getDelegation("wallet-op-1");
    expect(row).toMatchObject({
      status: "active",
      accountAddress: OPERATOR_ADDR,
      laneAddress: LANE,
      userId: "user-1",
      kekId: "k1",
    });
    expect(JSON.stringify(row)).not.toContain(API_KEY);
    expect(JSON.stringify(row)).not.toContain("very-secret-share");
    const aad = { walletId: "wallet-op-1", address: OPERATOR_ADDR };
    const binding = { dekWrapped: row?.dekWrapped as string, kekId: "k1" };
    expect(
      JSON.parse(
        Buffer.from(
          s.vault.openField(binding, row?.keyShareCt as string, {
            ...aad,
            purpose: VAULT_PURPOSE.keyShare,
          }),
        ).toString(),
      ),
    ).toEqual(SHARE);
    expect(
      Buffer.from(
        s.vault.openField(binding, row?.apiKeyCt as string, {
          ...aad,
          purpose: VAULT_PURPOSE.apiKey,
        }),
      ).toString(),
    ).toBe(API_KEY);
    expect(s.db.getWebhookEvent("evt-created-1")?.status).toBe("processed");
    expect(JSON.stringify(r.body)).not.toContain(API_KEY);
  });

  it("invalid or missing signature → 401 and nothing recorded", async () => {
    const s = setup();
    const raw = Buffer.from(JSON.stringify(createdEvent()));
    expect(
      (
        await s.handler.handle(raw, {
          "x-dynamic-signature-256": signDynamicPayload(raw, "wrong-secret-12345"),
        })
      ).status,
    ).toBe(401);
    expect((await s.handler.handle(raw, {})).status).toBe(401);
    expect(s.db.getWebhookEvent("evt-created-1")).toBeNull();
    expect(s.decryptCalls()).toBe(0);
  });

  it("the header name is matched case-insensitively and may carry sha256=", async () => {
    const s = setup();
    const raw = Buffer.from(JSON.stringify(createdEvent()));
    const r = await s.handler.handle(raw, {
      "X-Dynamic-Signature-256": `sha256=${signDynamicPayload(raw, SECRET)}`,
    });
    expect(r.status).toBe(200);
  });

  it("dedupes on eventId: a processed event is acknowledged, never reprocessed", async () => {
    const s = setup();
    const ev = createdEvent();
    expect((await s.post(ev)).status).toBe(200);
    const again = await s.post(ev);
    expect(again).toEqual({ status: 200, body: { ok: true, duplicate: true } });
    expect(s.decryptCalls()).toBe(1);
  });

  it("> 64 KB → 413; not JSON or no envelope → 400", async () => {
    const s = setup();
    expect((await s.post("x".repeat(64 * 1024 + 1))).status).toBe(413);
    expect((await s.post("{not json")).status).toBe(400);
    expect((await s.post({ hello: "world" })).status).toBe(400);
  });

  it("a malformed created payload → 400 (recorded failed); unknown events and other environments are ignored", async () => {
    const s = setup();
    expect((await s.post(createdEvent("evt-bad", { publicKey: "nope" }))).status).toBe(400);
    expect(s.db.getWebhookEvent("evt-bad")?.status).toBe("failed");
    const other = await s.post({ ...createdEvent("evt-other"), environmentId: "another-env" });
    expect(other.body).toMatchObject({ ignored: "other environment" });
    expect(s.db.getDelegation("wallet-op-1")).toBeNull();
    const unknown = await s.post({ eventId: "evt-x", eventName: "user.created", data: {} });
    expect(unknown).toMatchObject({ status: 200, body: { ignored: "user.created" } });
    expect(s.db.getWebhookEvent("evt-x")?.status).toBe("ignored");
  });

  it("a delegated lane OWNER (the Vault) is never stored", async () => {
    const s = setup();
    s.db.insertDesk(deskRow());
    const r = await s.post(
      createdEvent("evt-owner", { publicKey: OWNER, walletId: "wallet-vault" }),
    );
    expect(r.body).toMatchObject({ ignored: "wallet is a lane owner" });
    expect(s.db.getDelegation("wallet-vault")).toBeNull();
    expect(s.decryptCalls()).toBe(0);
    expect(s.notes.some((n) => n.severity === "critical")).toBe(true);
  });

  it("a DB failure answers 5xx; Dynamic's retry of the same event then succeeds", async () => {
    const s = setup();
    const real = s.db.upsertDelegation.bind(s.db);
    let fail = true;
    s.db.upsertDelegation = (row) => {
      if (fail) throw new Error("SQLITE_BUSY");
      real(row);
    };
    const ev = createdEvent("evt-retry");
    expect((await s.post(ev)).status).toBe(500);
    expect(s.db.getWebhookEvent("evt-retry")?.status).toBe("failed");
    fail = false;
    expect((await s.post(ev)).status).toBe(200);
    expect(s.db.getDelegation("wallet-op-1")?.status).toBe("active");
  });

  it("a decryption failure answers 5xx (so a fixed key can be retried)", async () => {
    const s = setup({
      decrypt: () => {
        throw new Error("oaep decoding error");
      },
    });
    const r = await s.post(createdEvent("evt-dec"));
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).not.toContain("oaep");
  });

  it("wallet.delegation.revoked: nulls the ciphertexts and marks the desk revoked", async () => {
    const s = setup();
    s.db.insertDesk(deskRow());
    await s.post(createdEvent());
    const r = await s.post({
      eventId: "evt-rev",
      eventName: "wallet.delegation.revoked",
      environmentId: ENV_ID,
      timestamp: "2026-09-21T14:05:00Z",
      data: { walletId: "wallet-op-1", chain: "EVM", publicKey: OPERATOR_ADDR },
    });
    expect(r).toMatchObject({ status: 200, body: { revoked: true } });
    expect(s.db.getDelegation("wallet-op-1")).toMatchObject({
      status: "revoked",
      keyShareCt: null,
      apiKeyCt: null,
      dekWrapped: null,
    });
    expect(s.db.getDesk(LANE)?.status).toBe("revoked");
    // A later re-delegation reactivates the desk.
    await s.post({ ...createdEvent("evt-created-2"), timestamp: "2026-09-21T14:10:00Z" });
    expect(s.db.getDelegation("wallet-op-1")?.status).toBe("active");
    expect(s.db.getDesk(LANE)?.status).toBe("active");
  });

  it("decrypts a Dynamic-format payload with the real SDK (decryptDelegatedWebhookData)", async () => {
    const s = setup({ decrypt: undefined });
    const r = await s.post(createdEvent("evt-sdk"));
    expect(r.status).toBe(200);
    const row = s.db.getDelegation("wallet-op-1") as NonNullable<
      ReturnType<DeskDb["getDelegation"]>
    >;
    const apiKey = s.vault.openField(
      { dekWrapped: row.dekWrapped as string, kekId: "k1" },
      row.apiKeyCt as string,
      { walletId: row.walletId, address: OPERATOR_ADDR, purpose: VAULT_PURPOSE.apiKey },
    );
    expect(Buffer.from(apiKey).toString()).toBe(API_KEY);
  }, 20_000);
});

describe("a Dynamic revoke is sticky, whatever the delivery order", () => {
  const revokeEvent = (eventId: string, timestamp?: string) => ({
    eventId,
    eventName: "wallet.delegation.revoked",
    environmentId: ENV_ID,
    ...(timestamp === undefined ? {} : { timestamp }),
    data: { walletId: "wallet-op-1", chain: "EVM", publicKey: OPERATOR_ADDR },
  });

  it("a revoke arriving while the created event is still in flight wins (per-wallet order)", async () => {
    let release: () => void = () => {};
    const inFlight = new Promise<void>((r) => {
      release = r;
    });
    // The created event is parked on an await before its write (the owner check's chain read;
    // the SDK load before the first decrypt is another such window).
    const s = setup({
      isLaneOwner: async () => {
        await inFlight;
        return false;
      },
    });
    s.db.insertDesk(deskRow());
    const created = s.post(createdEvent()); // stuck in decrypt
    const revoked = s.post(revokeEvent("evt-rev", "2026-09-21T14:00:05Z"));
    release();
    expect((await created).status).toBe(200);
    expect((await revoked).status).toBe(200);
    expect(s.db.getDelegation("wallet-op-1")).toMatchObject({
      status: "revoked",
      keyShareCt: null,
      apiKeyCt: null,
    });
    expect(s.db.getActiveDelegationByAddress(OPERATOR_ADDR)).toBeNull();
    expect(s.db.getDesk(LANE)?.status).toBe("revoked");
  });

  it("a revoke for a wallet we never stored is recorded; the retried older created is refused", async () => {
    const s = setup();
    s.db.insertDesk(deskRow());
    const real = s.db.upsertDelegation.bind(s.db);
    let fail = true;
    s.db.upsertDelegation = (row) => {
      if (fail) throw new Error("SQLITE_BUSY");
      real(row);
    };
    const created = createdEvent("evt-created-1"); // 14:00:00
    expect((await s.post(created)).status).toBe(500);
    const rev = await s.post(revokeEvent("evt-rev", "2026-09-21T14:00:30Z"));
    expect(rev).toMatchObject({ status: 200, body: { recorded: true, revoked: false } });
    fail = false;
    const retried = await s.post(created); // Dynamic's retry of the SAME (older) event
    expect(retried).toMatchObject({
      status: 200,
      body: { ignored: expect.stringMatching(/revoked/) },
    });
    expect(s.db.getDelegation("wallet-op-1")).toBeNull();
    expect(s.db.getActiveDelegationByAddress(OPERATOR_ADDR)).toBeNull();
  });

  it("epoch timestamps (seconds or ms) order events like ISO ones", async () => {
    const s = setup();
    const at = Date.UTC(2026, 8, 21, 14, 0, 30);
    await s.post(revokeEvent("evt-rev-s", String(at / 1000)));
    expect(s.db.latestDelegationRevocationAt("wallet-op-1")).toBe(at);
    await s.post(revokeEvent("evt-rev-ms", String(at + 5_000)));
    expect(s.db.latestDelegationRevocationAt("wallet-op-1")).toBe(at + 5_000);
    // The 14:00:00 created event is older than both: refused.
    expect((await s.post(createdEvent())).body).toMatchObject({
      ignored: expect.stringMatching(/revoked/),
    });
  });

  it("a revoke without a timestamp dates from its first receipt", async () => {
    const s = setup();
    expect((await s.post(revokeEvent("evt-rev-nots"))).status).toBe(200); // clock: 14:00:00
    // A created event from the same instant is not newer than the revoke: refused.
    expect((await s.post(createdEvent("evt-c-same"))).body).toMatchObject({
      ignored: expect.stringMatching(/revoked/),
    });
    expect(s.db.getDelegation("wallet-op-1")).toBeNull();
  });

  it("positive path: a genuinely later re-delegation is stored and reactivates the desk", async () => {
    const s = setup();
    s.db.insertDesk(deskRow());
    await s.post(createdEvent());
    await s.post(revokeEvent("evt-rev", "2026-09-21T14:01:00Z"));
    expect(s.db.getDesk(LANE)?.status).toBe("revoked");
    await s.post({ ...createdEvent("evt-created-2"), timestamp: "2026-09-21T14:02:00Z" });
    expect(s.db.getDelegation("wallet-op-1")?.status).toBe("active");
    expect(s.db.getDesk(LANE)?.status).toBe("active");
  });
});

describe("a lane OWNER is never stored, registered desk or not", () => {
  it("factory.lanesOf(wallet) non-empty → refused before decryption, critical alert", async () => {
    const asked: string[] = [];
    const s = setup({
      isLaneOwner: async (a) => {
        asked.push(a);
        return a === OWNER;
      },
    });
    // No desk registered yet: the wizard delegates before POST /desks.
    const r = await s.post(
      createdEvent("evt-vault", { publicKey: OWNER, walletId: "wallet-vault" }),
    );
    expect(r.body).toMatchObject({ ignored: "wallet is a lane owner" });
    expect(asked).toEqual([OWNER]);
    expect(s.decryptCalls()).toBe(0);
    expect(s.db.getDelegation("wallet-vault")).toBeNull();
    const alert = s.notes.find((n) => n.severity === "critical");
    expect((alert?.lines ?? []).join(" ")).toMatch(/Revoke this wallet's delegation in Dynamic/);
  });

  it("a chain-read failure answers 5xx (Dynamic retries) and stores nothing", async () => {
    let down = true;
    const s = setup({
      isLaneOwner: async () => {
        if (down) throw new Error("RPC unavailable");
        return false;
      },
    });
    const ev = createdEvent("evt-op");
    expect((await s.post(ev)).status).toBe(500);
    expect(s.decryptCalls()).toBe(0);
    expect(s.db.getDelegation("wallet-op-1")).toBeNull();
    down = false;
    expect((await s.post(ev)).status).toBe(200); // positive path: the retry stores the operator
    expect(s.db.getDelegation("wallet-op-1")?.status).toBe("active");
  });

  it("factoryLaneOwnerProbe: a lane listed under the wallet (lanesOf + listed, one pinned block)", async () => {
    const FACTORY = "0x5555555555555555555555555555555555555555" as const;
    const OTHER_LANE = "0x6666666666666666666666666666666666666666" as const;
    const calls: Array<{ to: string; fn: string; block: bigint | undefined }> = [];
    // lanesOf(OWNER) = [LANE] (listed); lanesOf(OPERATOR) = [OTHER_LANE] whose listed() is false
    // (a factory whose lanesOf is not trustworthy on its own: the probe checks listed too).
    const probe = factoryLaneOwnerProbe(
      {
        blockNumber: async () => 7n,
        call: async (req) => {
          const { functionName, args } = decodeFunctionData({
            abi: deskLaneFactoryAbi,
            data: req.data,
          });
          calls.push({ to: req.to, fn: functionName, block: req.blockNumber });
          const arg = String(args?.[0] ?? "").toLowerCase();
          if (functionName === "listed")
            return encodeFunctionResult({
              abi: deskLaneFactoryAbi,
              functionName,
              result: arg === LANE,
            });
          return encodeFunctionResult({
            abi: deskLaneFactoryAbi,
            functionName: "lanesOf",
            result: arg === OWNER ? [LANE] : arg === OPERATOR_ADDR ? [OTHER_LANE] : [],
          });
        },
      },
      FACTORY,
    );
    expect(await probe(OWNER)).toBe(true);
    expect(await probe(OPERATOR_ADDR)).toBe(false);
    expect(await probe("0x7777777777777777777777777777777777777777")).toBe(false);
    expect(calls.every((c) => c.to.toLowerCase() === FACTORY && c.block === 7n)).toBe(true);
    expect(calls.filter((c) => c.fn === "listed")).toHaveLength(2);
  });
});

describe("Dynamic's documented payload carries a publicKey, not an address", () => {
  // ANVIL_KEY_0's account is OPERATOR_ADDR (the lane's operator in deskRow()).
  const account = privateKeyToAccount(
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  );
  const uncompressed = account.publicKey; // 0x04 ‖ X ‖ Y
  const point = secp256k1.ProjectivePoint.fromHex(uncompressed.slice(2));
  const compressed = `0x${Buffer.from(point.toRawBytes(true)).toString("hex")}`;

  it("derives the EVM address from uncompressed, raw X‖Y, compressed and base64 public keys", () => {
    expect(account.address.toLowerCase()).toBe(OPERATOR_ADDR);
    expect(evmAddressFromPublicKey(uncompressed)).toBe(OPERATOR_ADDR);
    expect(evmAddressFromPublicKey(uncompressed.slice(2))).toBe(OPERATOR_ADDR);
    expect(evmAddressFromPublicKey(`0x${uncompressed.slice(4)}`)).toBe(OPERATOR_ADDR);
    expect(evmAddressFromPublicKey(compressed)).toBe(OPERATOR_ADDR);
    expect(
      evmAddressFromPublicKey(Buffer.from(uncompressed.slice(2), "hex").toString("base64")),
    ).toBe(OPERATOR_ADDR);
  });

  it("refuses anything that is not a point on the curve", () => {
    expect(evmAddressFromPublicKey("0x04" + "00".repeat(64))).toBeNull();
    expect(evmAddressFromPublicKey("0x02" + "ff".repeat(32))).toBeNull();
    expect(evmAddressFromPublicKey("0x1234")).toBeNull();
    expect(evmAddressFromPublicKey("not a key!")).toBeNull();
  });

  it("wallet.delegation.created with only { walletId, chain, publicKey, userId, encrypted… } binds to the lane", async () => {
    const s = setup();
    s.db.insertDesk(deskRow());
    const r = await s.post(createdEvent("evt-pubkey-1", { publicKey: compressed }));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, address: OPERATOR_ADDR, lane: LANE });
    expect(s.db.getDelegation("wallet-op-1")).toMatchObject({ accountAddress: OPERATOR_ADDR });
  });
});

describe("the real Dynamic envelope (observed 2026-09-19)", () => {
  it("accepts a top-level userId: null, extra fields (messageId, webhookId, environmentName, shareSetId) and publicKey = address", async () => {
    const s = setup();
    s.db.insertDesk(deskRow());
    const ev = createdEvent("evt-real-1", { shareSetId: "set-1" });
    const real = {
      ...ev,
      userId: null,
      messageId: "msg-1",
      webhookId: "wh-1",
      environmentName: "sandbox",
    };
    const r = await s.post(real);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, address: OPERATOR_ADDR, lane: LANE });
  });
});
