/** HTTP test helpers: a local JWKS, Dynamic-style JWTs, and Dynamic-style webhook encryption. */

import {
  createCipheriv,
  generateKeyPairSync,
  publicEncrypt,
  randomBytes,
  constants as rsa,
} from "node:crypto";
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";
import type { EncryptedDelegatedPayload } from "../../../src/signer/dynamic-sdk.js";

export const ENV_ID = "env-sandbox-1";

export async function jwtKit() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const keys = createLocalJWKSet({ keys: [jwk] });
  async function token(
    claims: Record<string, unknown> = {},
    opts: { sub?: string; exp?: string | number } = {},
  ) {
    return new SignJWT({
      environment_id: ENV_ID,
      verified_credentials: [],
      ...claims,
    })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setSubject(opts.sub ?? "user-1")
      .setIssuer(`app.dynamicauth.com/${ENV_ID}`)
      .setIssuedAt()
      .setExpirationTime(opts.exp ?? "1h")
      .sign(privateKey);
  }
  return { keys, token };
}

export function walletsClaim(...addresses: string[]) {
  return {
    verified_credentials: addresses.map((address) => ({
      address,
      chain: "eip155",
      format: "blockchain",
    })),
  };
}

export function rsaKeyPair(bits = 2048) {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: bits,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { publicKeyPem: publicKey, privateKeyPem: privateKey };
}

/** Encrypt the way Dynamic does for delegated webhooks: AES-256-GCM, key wrapped by RSA-OAEP-256. */
export function encryptForDynamic(
  publicKeyPem: string,
  plaintext: string,
): EncryptedDelegatedPayload {
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  const ek = publicEncrypt(
    { key: publicKeyPem, oaepHash: "sha256", padding: rsa.RSA_PKCS1_OAEP_PADDING },
    key,
  );
  return {
    alg: "HYBRID-RSA-AES-256",
    iv: iv.toString("base64url"),
    ct: ct.toString("base64url"),
    tag: c.getAuthTag().toString("base64url"),
    ek: ek.toString("base64url"),
  };
}
