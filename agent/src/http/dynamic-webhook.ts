/**
 * POST /webhooks/dynamic: delegated-access material from Dynamic.
 *
 *   1. raw body ≤ 64 KB (413), HMAC-SHA256 over the RAW bytes against `x-dynamic-signature-256`
 *      (hex, optionally `sha256=`-prefixed), compared in constant time (401).
 *   2. envelope validated (400); an event for another environment is recorded and ignored.
 *   3. dedupe on eventId: a finished event is acknowledged without reprocessing; one that failed
 *      before (we answered 5xx) is processed again.
 *   4. wallet.delegation.created: decryptDelegatedWebhookData with our RSA key, seal the key share
 *      and wallet API key in the vault (AAD walletId|address|purpose), bind to the lane whose
 *      operator is this wallet. A wallet that owns a lane (a registered desk's owner, or a lane
 *      the factory LISTS under it: see factoryLaneOwnerProbe) is never decrypted nor stored; a
 *      chain-read failure answers 5xx so Dynamic retries.
 *      wallet.delegation.revoked: recorded per event even for a wallet we never stored (sticky),
 *      then null the ciphertexts and mark the desk revoked. A created event that is not newer than
 *      a recorded revoke never (re)activates the wallet.
 *   5. a DB or decryption failure answers 5xx so Dynamic retries.
 *
 * Events for one walletId are processed one at a time, so a revoke can never interleave with a
 * created event that is still decrypting.
 *
 * Plaintext credentials never reach a log line or a response body.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { secp256k1 } from "@noble/curves/secp256k1";
import { publicKeyToAddress } from "viem/accounts";
import { z } from "zod";
import { deskLaneFactoryAbi } from "../executor/abi/DeskLaneFactory.js";
import { readContract } from "../executor/chain.js";
import { markRevoked } from "../executor/safe-mode.js";
import {
  type EncryptedDelegatedPayload,
  loadNodeSdk,
  type NodeSdk,
} from "../signer/dynamic-sdk.js";
import { VAULT_PURPOSE } from "../signer/vault.js";
import type {
  Address,
  ChainClient,
  Clock,
  DeskDb,
  DeskLogger,
  DynamicWebhookEnvelope,
  Notifier,
  Vault,
  WebhookHandler,
  WebhookResult,
} from "../types.js";

export type { DynamicWebhookEnvelope, WebhookHandler, WebhookResult } from "../types.js";

export const SIGNATURE_HEADER = "x-dynamic-signature-256";
export const MAX_WEBHOOK_BYTES = 64 * 1024;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Constant-time check of `x-dynamic-signature-256` (hex HMAC-SHA256 of the raw body). */
export function verifyDynamicSignature(
  rawBody: Uint8Array,
  header: string | undefined,
  secret: string,
): boolean {
  if (header === undefined) return false;
  const presented = header.trim().replace(/^sha256=/i, "");
  if (!/^[0-9a-fA-F]{64}$/.test(presented)) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(presented, "hex"));
}

export function signDynamicPayload(rawBody: Uint8Array | string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

/** Dynamic sends absent fields as null (e.g. a top-level `"userId": null` on delegation events). */
const optStr = z
  .string()
  .nullish()
  .transform((v) => v ?? undefined);

const EnvelopeSchema = z.object({
  eventId: z.string().min(1).max(200),
  eventName: z.string().min(1).max(200),
  environmentId: optStr,
  timestamp: optStr,
  userId: optStr,
  data: z.unknown(),
});

const EncryptedSchema = z.object({
  alg: z.string(),
  iv: z.string(),
  ct: z.string(),
  tag: z.string(),
  ek: z.string(),
  kid: z.string().optional(),
});

const CreatedSchema = z.object({
  walletId: z.string().min(1).max(200),
  userId: optStr,
  chain: optStr,
  accountAddress: optStr,
  walletAddress: optStr,
  address: optStr,
  publicKey: optStr,
  encryptedDelegatedShare: EncryptedSchema.optional(),
  encryptedDelegatedKeyShare: EncryptedSchema.optional(),
  encryptedWalletApiKey: EncryptedSchema,
});

const RevokedSchema = z.object({
  walletId: z.string().min(1).max(200),
});

class PayloadError extends Error {}

export interface WebhookDeps {
  db: DeskDb;
  secret: string;
  environmentId: string | undefined;
  /** Our RSA private key (PEM), read lazily. */
  rsaPrivateKeyPem: () => string;
  vault: Vault;
  /** Test seam; production loads @dynamic-labs-wallet/node on first use. */
  decrypt?: NodeSdk["decryptDelegatedWebhookData"];
  /**
   * Does this wallet own a lane on-chain (factoryLaneOwnerProbe: a lane the factory lists under
   * it)? Catches a delegated Vault before its desk is registered. A throw answers 5xx (Dynamic
   * retries). Absent: registered desks only.
   */
  isLaneOwner?: ((address: Address) => Promise<boolean>) | undefined;
  clock: Clock;
  logger: DeskLogger;
  notifier?: Notifier | undefined;
  maxBytes?: number;
}

/**
 * Is this wallet a lane owner the factory LISTS: some lane in factory.lanesOf(wallet) with
 * factory.listed(lane) true, read at one pinned block.
 *
 * Listing semantics: createLane is permissionless and anyone may deploy a lane NAMING any owner,
 * but a lane enters lanesOf(owner) (and listed(lane) turns true, event LaneListed) only when the
 * owner itself sends createLane, or later confirms a lane someone else deployed for it by sending
 * createLane with the same params. So a listed lane proves the wallet acted as a Vault, and a
 * stranger cannot make an Operator look like an owner (which would get its delegation refused)
 * by deploying a lane in its name. listed(lane) is checked per lane so the probe relies on that
 * rule, not on the shape of lanesOf.
 *
 * What it does NOT see: an UNLISTED lane, deployed by a third party with owner = wallet and never
 * confirmed by the wallet. A Vault whose only lane is unlisted passes this probe, and its
 * delegation is stored. Two purges cover it: POST /desks deletes our copy of the lane OWNER's
 * delegation when that lane is registered (http/desks.ts), and a delegation that no registration
 * has bound within 24 h is revoked by the unbound-delegation purge (main.ts,
 * db.purgeUnboundDelegations). The signer only ever opens the delegation of a registered lane's
 * operator, and the factory refuses operator == owner, so it is never used to sign meanwhile.
 */
export function factoryLaneOwnerProbe(
  chain: Pick<ChainClient, "call" | "blockNumber">,
  factory: Address,
): (address: Address) => Promise<boolean> {
  return async (address) => {
    const blockNumber = await chain.blockNumber();
    const lanes = await readContract(chain, {
      address: factory,
      abi: deskLaneFactoryAbi,
      functionName: "lanesOf",
      args: [address],
      blockNumber,
    });
    for (const lane of lanes) {
      const listed = await readContract(chain, {
        address: factory,
        abi: deskLaneFactoryAbi,
        functionName: "listed",
        args: [lane],
        blockNumber,
      });
      if (listed) return true;
    }
    return false;
  };
}

/** The RSA private key from DYNAMIC_RSA_PRIVATE_KEY_PEM or DYNAMIC_RSA_PRIVATE_KEY_PATH. */
export function rsaKeyLoader(cfg: {
  rsaPrivateKeyPem: string | undefined;
  rsaPrivateKeyPath: string | undefined;
}): () => string {
  let cached: string | undefined = cfg.rsaPrivateKeyPem;
  return () => {
    if (cached === undefined) {
      if (cfg.rsaPrivateKeyPath === undefined) throw new Error("no RSA private key configured");
      cached = readFileSync(cfg.rsaPrivateKeyPath, "utf8");
    }
    return cached;
  };
}

function header(headers: Record<string, string | undefined>, name: string): string | undefined {
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === name) return v;
  return undefined;
}

/** The walletId an event is about (for per-wallet ordering), before full validation. */
function walletIdOf(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const id = (data as { walletId?: unknown }).walletId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function walletAddressOf(d: z.infer<typeof CreatedSchema>): Address | null {
  for (const c of [d.accountAddress, d.walletAddress, d.address, d.publicKey]) {
    if (c !== undefined && ADDRESS_RE.test(c)) return c.toLowerCase() as Address;
  }
  // Dynamic's documented wallet.delegation.created carries only { walletId, chain, publicKey, userId,
  // encryptedDelegatedShare, encryptedWalletApiKey }: derive the EVM address from the public key.
  return d.publicKey === undefined ? null : evmAddressFromPublicKey(d.publicKey);
}

/**
 * EVM address of a secp256k1 public key given as hex (with or without 0x) or base64: 65-byte
 * uncompressed (0x04…), 64-byte raw X‖Y, or 33-byte compressed (0x02/0x03…, decompressed on the curve).
 * Anything else, or a point not on the curve: null.
 */
export function evmAddressFromPublicKey(publicKey: string): Address | null {
  const t = publicKey.trim();
  let bytes: Uint8Array | null = null;
  const hex = t.replace(/^0x/i, "");
  if (/^[0-9a-fA-F]+$/.test(hex) && hex.length % 2 === 0) bytes = Buffer.from(hex, "hex");
  else if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(t)) bytes = Buffer.from(t, "base64");
  if (bytes === null) return null;
  try {
    let uncompressed: Uint8Array;
    if (bytes.length === 65 && bytes[0] === 0x04) uncompressed = bytes;
    else if (bytes.length === 64) uncompressed = Uint8Array.from([0x04, ...bytes]);
    else if (bytes.length === 33 && (bytes[0] === 0x02 || bytes[0] === 0x03))
      uncompressed = secp256k1.ProjectivePoint.fromHex(bytes).toRawBytes(false);
    else return null;
    secp256k1.ProjectivePoint.fromHex(uncompressed).assertValidity();
    return publicKeyToAddress(
      `0x${Buffer.from(uncompressed).toString("hex")}`,
    ).toLowerCase() as Address;
  } catch {
    return null;
  }
}

export function createDynamicWebhookHandler(deps: WebhookDeps): WebhookHandler {
  const { db, logger } = deps;
  const maxBytes = deps.maxBytes ?? MAX_WEBHOOK_BYTES;
  let decryptFn = deps.decrypt ?? null;
  const walletQueues = new Map<string, Promise<unknown>>();

  /** One event at a time per walletId: a revoke waits for a created that is still decrypting. */
  function perWallet<T>(walletId: string | null, fn: () => Promise<T>): Promise<T> {
    if (walletId === null) return fn();
    const prev = walletQueues.get(walletId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    walletQueues.set(walletId, tail);
    void tail.then(() => {
      if (walletQueues.get(walletId) === tail) walletQueues.delete(walletId);
    });
    return run;
  }

  /** The event's own time: the envelope timestamp, else when we first received it. */
  function eventAtMs(env: DynamicWebhookEnvelope, nowMs: number): number {
    const raw = env.timestamp?.trim();
    const t =
      raw === undefined
        ? Number.NaN
        : /^\d{13}$/.test(raw)
          ? Number(raw) // epoch ms
          : /^\d{10}$/.test(raw)
            ? Number(raw) * 1000 // epoch s
            : Date.parse(raw);
    if (Number.isFinite(t)) return t;
    return db.getWebhookEvent(env.eventId)?.receivedAtMs ?? nowMs;
  }

  /** A recorded revoke at or after this created event: it must not (re)activate the wallet. */
  function revokedSince(walletId: string, createdAtMs: number): boolean {
    const at = db.latestDelegationRevocationAt(walletId);
    return at !== null && at >= createdAtMs;
  }

  async function decrypt(args: Parameters<NodeSdk["decryptDelegatedWebhookData"]>[0]) {
    decryptFn ??= (await loadNodeSdk()).decryptDelegatedWebhookData;
    return decryptFn(args);
  }

  async function created(
    env: DynamicWebhookEnvelope,
    envUserId: string | undefined,
    nowMs: number,
  ) {
    const parsed = CreatedSchema.safeParse(env.data);
    if (!parsed.success) throw new PayloadError("delegation.created payload is malformed");
    const d = parsed.data;
    if (d.chain !== undefined && !/^(evm|eip155)$/i.test(d.chain)) {
      return { status: "ignored" as const, body: { ok: true, ignored: `chain ${d.chain}` } };
    }
    const address = walletAddressOf(d);
    if (address === null) throw new PayloadError("delegation.created carries no wallet address");
    const userId = d.userId ?? envUserId;
    if (userId === undefined) throw new PayloadError("delegation.created carries no userId");
    const share: EncryptedDelegatedPayload | undefined =
      d.encryptedDelegatedShare ?? d.encryptedDelegatedKeyShare;
    if (share === undefined)
      throw new PayloadError("delegation.created carries no encrypted key share");

    const createdAtMs = eventAtMs(env, nowMs);
    if (revokedSince(d.walletId, createdAtMs)) {
      logger.warn({ walletId: d.walletId }, "delegation.created older than a recorded revoke");
      return {
        status: "ignored" as const,
        body: { ok: true, ignored: "revoked at or after this delegation" },
      };
    }

    const desks = db.listDesks();
    // A chain-read failure throws: 5xx, and Dynamic retries.
    const ownsLane =
      desks.some((k) => k.owner === address) ||
      (deps.isLaneOwner !== undefined && (await deps.isLaneOwner(address)));
    if (ownsLane) {
      // The Vault must never be delegated: refuse to hold its credentials at all.
      await deps.notifier?.notify({
        kind: "alert",
        severity: "critical",
        lane: null,
        laneAddress: null,
        title: "A lane OWNER wallet was delegated: credentials discarded",
        lines: [
          `wallet ${address} owns a lane; only the Operator may be delegated`,
          "Revoke this wallet's delegation in Dynamic: it is still delegated on Dynamic's side.",
        ],
      });
      return { status: "ignored" as const, body: { ok: true, ignored: "wallet is a lane owner" } };
    }

    let plain: { decryptedDelegatedShare: unknown; decryptedWalletApiKey: string };
    try {
      plain = await decrypt({
        privateKeyPem: deps.rsaPrivateKeyPem(),
        encryptedDelegatedKeyShare: share,
        encryptedWalletApiKey: d.encryptedWalletApiKey,
      });
    } catch {
      throw new Error("could not decrypt the delegated credentials (RSA key mismatch?)");
    }
    const keyShareBytes = Buffer.from(JSON.stringify(plain.decryptedDelegatedShare), "utf8");
    const apiKeyBytes = Buffer.from(plain.decryptedWalletApiKey, "utf8");
    let sealed: ReturnType<Vault["sealRow"]>;
    try {
      sealed = deps.vault.sealRow(
        { [VAULT_PURPOSE.keyShare]: keyShareBytes, [VAULT_PURPOSE.apiKey]: apiKeyBytes },
        { walletId: d.walletId, address },
      );
    } finally {
      keyShareBytes.fill(0);
      apiKeyBytes.fill(0);
    }
    const lane = desks.find((k) => k.operator === address) ?? null;
    const stored = db.transaction(() => {
      // Re-checked atomically with the write: nothing may reactivate a revoked wallet.
      if (revokedSince(d.walletId, createdAtMs)) return false;
      db.upsertDelegation({
        walletId: d.walletId,
        userId,
        accountAddress: address,
        chain: "EVM",
        laneAddress: lane?.laneAddress ?? null,
        status: "active",
        keyShareCt: sealed.ciphertexts[VAULT_PURPOSE.keyShare] ?? null,
        apiKeyCt: sealed.ciphertexts[VAULT_PURPOSE.apiKey] ?? null,
        dekWrapped: sealed.dekWrapped,
        kekId: sealed.kekId,
        createdEventId: env.eventId,
        revokedEventId: null,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
        revokedAtMs: null,
      });
      if (lane !== null && lane.status === "revoked") {
        db.setDeskStatus(lane.laneAddress, "active", "operator re-delegated", nowMs);
      }
      return true;
    });
    if (!stored) {
      return {
        status: "ignored" as const,
        body: { ok: true, ignored: "revoked at or after this delegation" },
      };
    }
    logger.info(
      { walletId: d.walletId, address, lane: lane?.laneAddress ?? null },
      "delegation stored",
    );
    await deps.notifier?.notify({
      kind: "alert",
      severity: "info",
      lane: null,
      laneAddress: lane?.laneAddress ?? null,
      title: "Operator delegation received",
      lines: [
        `operator ${address}`,
        lane === null ? "bound at registration" : `bound to ${lane.laneAddress}`,
      ],
    });
    return {
      status: "processed" as const,
      body: { ok: true, walletId: d.walletId, address, lane: lane?.laneAddress ?? null },
    };
  }

  async function revoked(env: DynamicWebhookEnvelope, nowMs: number) {
    const parsed = RevokedSchema.safeParse(env.data);
    if (!parsed.success) throw new PayloadError("delegation.revoked payload is malformed");
    const walletId = parsed.data.walletId;
    // Sticky: recorded even for a wallet we never stored (its created event may be late or retried).
    db.recordDelegationRevocation({
      eventId: env.eventId,
      walletId,
      eventAtMs: eventAtMs(env, nowMs),
      recordedAtMs: nowMs,
    });
    const row = db.getDelegation(walletId);
    if (row === null) {
      logger.info({ walletId }, "revoke recorded for a wallet with no stored delegation");
      return {
        status: "processed" as const,
        body: { ok: true, walletId, revoked: false, recorded: true },
      };
    }
    const changed = db.revokeDelegation(row.walletId, env.eventId, nowMs);
    const lanes = db
      .listDesks()
      .filter((k) => k.operator === row.accountAddress || k.laneAddress === row.laneAddress);
    for (const k of lanes) {
      await markRevoked(
        { db, notifier: deps.notifier, logger },
        k.laneAddress,
        `Dynamic delegation revoked (${env.eventId})`,
        nowMs,
      );
    }
    logger.info({ walletId: row.walletId, changed, lanes: lanes.length }, "delegation revoked");
    return {
      status: "processed" as const,
      body: { ok: true, walletId: row.walletId, revoked: changed },
    };
  }

  return {
    async handle(rawBody, headers): Promise<WebhookResult> {
      if (rawBody.byteLength > maxBytes)
        return { status: 413, body: { error: "payload too large" } };
      if (!verifyDynamicSignature(rawBody, header(headers, SIGNATURE_HEADER), deps.secret)) {
        return { status: 401, body: { error: "invalid signature" } };
      }
      let env: z.infer<typeof EnvelopeSchema>;
      try {
        const r = EnvelopeSchema.safeParse(JSON.parse(Buffer.from(rawBody).toString("utf8")));
        if (!r.success) return { status: 400, body: { error: "malformed event envelope" } };
        env = r.data;
      } catch {
        return { status: 400, body: { error: "body is not JSON" } };
      }
      const nowMs = deps.clock.now();
      let record: ReturnType<DeskDb["recordWebhookEvent"]>;
      try {
        record = db.recordWebhookEvent({
          eventId: env.eventId,
          eventName: env.eventName,
          receivedAtMs: nowMs,
          payloadSha256: createHash("sha256").update(rawBody).digest("hex"),
        });
      } catch (err) {
        logger.error(
          { eventId: env.eventId, error: err instanceof Error ? err.message : String(err) },
          "webhook: db failure",
        );
        return { status: 500, body: { error: "storage unavailable" } };
      }
      if (record === "duplicate") return { status: 200, body: { ok: true, duplicate: true } };

      const finish = (status: "processed" | "ignored" | "failed", error: string | null) => {
        try {
          db.finishWebhookEvent(env.eventId, status, error, deps.clock.now());
        } catch (err) {
          logger.error(
            { eventId: env.eventId, error: err instanceof Error ? err.message : String(err) },
            "webhook: could not finish event",
          );
        }
      };

      if (
        deps.environmentId !== undefined &&
        env.environmentId !== undefined &&
        env.environmentId !== deps.environmentId
      ) {
        finish("ignored", "other environment");
        return { status: 200, body: { ok: true, ignored: "other environment" } };
      }
      try {
        const r = await perWallet(walletIdOf(env.data), async () =>
          env.eventName === "wallet.delegation.created"
            ? await created(env as DynamicWebhookEnvelope, env.userId, nowMs)
            : env.eventName === "wallet.delegation.revoked"
              ? await revoked(env as DynamicWebhookEnvelope, nowMs)
              : { status: "ignored" as const, body: { ok: true, ignored: env.eventName } },
        );
        finish(r.status, null);
        return { status: 200, body: r.body };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        finish("failed", message);
        if (err instanceof PayloadError) {
          const keys =
            env.data !== null && typeof env.data === "object" ? Object.keys(env.data).sort() : [];
          logger.warn(
            { eventId: env.eventId, eventName: env.eventName, dataKeys: keys, error: message },
            "webhook payload rejected",
          );
          return { status: 400, body: { error: message } };
        }
        logger.error(
          { eventId: env.eventId, eventName: env.eventName, error: message },
          "webhook processing failed",
        );
        return { status: 500, body: { error: "processing failed; retry" } };
      }
    },
  };
}
