/**
 * Vault: AES-256-GCM envelope encryption of delegated credentials.
 *
 * - One random 32-byte DEK per row. Each field (key share, wallet API key, …) is encrypted under the
 *   DEK with AAD `walletId|address|purpose`, so a ciphertext cannot be moved to another wallet,
 *   address or field without failing authentication.
 * - The DEK is wrapped by the KEK (DESK_VAULT_KEK_B64, a sealed Railway variable) with AAD
 *   `kek|kekId|walletId|address`, so a wrapped DEK cannot be swapped between rows either.
 * - kek_id is stored per row; older KEKs can be kept in `previous` for rotation (open-only).
 * - Plaintext exists only in the caller's hands during a sign; DEK buffers are zeroed after use.
 *   Nothing here logs.
 *
 * Wire format of every blob: `v1.<iv b64url>.<tag b64url>.<ciphertext b64url>`.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { SealedRow, Vault, VaultAad } from "../types.js";

export type { SealedRow, Vault, VaultAad } from "../types.js";

/** Field purposes (the third AAD component). */
export const VAULT_PURPOSE = {
  keyShare: "keyShare",
  apiKey: "apiKey",
  keyShares: "keyShares",
} as const;

export class VaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultError";
  }
}

const VERSION = "v1";
const PART_RE = /^[A-Za-z0-9_-]+$/;

function parseKek(b64: string, id: string): Buffer {
  const key = Buffer.from(b64, "base64");
  if (key.length !== 32) throw new VaultError(`KEK ${id} must decode to exactly 32 bytes`);
  return key;
}

function aadPart(name: string, v: string): string {
  if (v.length === 0 || v.includes("|"))
    throw new VaultError(`AAD ${name} must be non-empty and contain no "|"`);
  return v;
}

function fieldAad(a: VaultAad): Buffer {
  return Buffer.from(
    `${aadPart("walletId", a.walletId)}|${aadPart("address", a.address.toLowerCase())}|${aadPart("purpose", a.purpose)}`,
    "utf8",
  );
}

function wrapAad(kekId: string, a: Omit<VaultAad, "purpose">): Buffer {
  return Buffer.from(
    `kek|${aadPart("kekId", kekId)}|${aadPart("walletId", a.walletId)}|${aadPart("address", a.address.toLowerCase())}`,
    "utf8",
  );
}

function seal(key: Buffer, plaintext: Uint8Array, aad: Buffer): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(aad);
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  const tag = c.getAuthTag();
  return [
    VERSION,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ct.toString("base64url"),
  ].join(".");
}

function open(key: Buffer, blob: string, aad: Buffer): Buffer {
  const parts = blob.split(".");
  if (
    parts.length !== 4 ||
    parts[0] !== VERSION ||
    !parts.slice(1).every((p) => PART_RE.test(p) || p === "")
  )
    throw new VaultError("malformed vault blob");
  const [, ivB64, tagB64, ctB64] = parts as [string, string, string, string];
  const iv = Buffer.from(ivB64, "base64url");
  const tag = Buffer.from(tagB64, "base64url");
  if (iv.length !== 12 || tag.length !== 16) throw new VaultError("malformed vault blob");
  try {
    const d = createDecipheriv("aes-256-gcm", key, iv);
    d.setAAD(aad);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(Buffer.from(ctB64, "base64url")), d.final()]);
  } catch {
    // Never echo crypto internals: one message for wrong key, wrong AAD and tampering alike.
    throw new VaultError("vault authentication failed (tampered, wrong key or wrong binding)");
  }
}

export interface VaultOptions {
  kekB64: string;
  kekId: string;
  /** Retired KEKs by id: rows sealed under them can still be opened (never sealed with). */
  previous?: Readonly<Record<string, string>>;
}

export function createVault(opts: VaultOptions): Vault {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(opts.kekId)) throw new VaultError("invalid KEK id");
  const ring = new Map<string, Buffer>();
  for (const [id, b64] of Object.entries(opts.previous ?? {})) ring.set(id, parseKek(b64, id));
  ring.set(opts.kekId, parseKek(opts.kekB64, opts.kekId));
  const current = ring.get(opts.kekId) as Buffer;

  return {
    kekId: opts.kekId,

    sealRow(fields, aad): SealedRow {
      const dek = randomBytes(32);
      try {
        const ciphertexts: Record<string, string> = {};
        for (const [purpose, plaintext] of Object.entries(fields)) {
          ciphertexts[purpose] = seal(dek, plaintext, fieldAad({ ...aad, purpose }));
        }
        return {
          dekWrapped: seal(current, dek, wrapAad(opts.kekId, aad)),
          kekId: opts.kekId,
          ciphertexts,
        };
      } finally {
        dek.fill(0);
      }
    },

    openField(row, ciphertext, aad): Uint8Array {
      const kek = ring.get(row.kekId);
      if (kek === undefined) throw new VaultError(`unknown KEK id "${row.kekId}"`);
      const dek = open(kek, row.dekWrapped, wrapAad(row.kekId, aad));
      try {
        if (dek.length !== 32) throw new VaultError("wrapped DEK has the wrong length");
        return open(dek, ciphertext, fieldAad(aad));
      } finally {
        dek.fill(0);
      }
    },
  };
}

/** Best-effort zeroing of plaintext buffers after use. */
export function wipe(...bufs: Array<Uint8Array | null | undefined>): void {
  for (const b of bufs) b?.fill(0);
}
