/**
 * Web API authentication.
 *
 * 1. The shared agent key (x-desk-agent-key): the web's server-side route handlers add it, so only
 *    DeltaDesk's own web service can reach the API. Required whenever DESK_AGENT_API_KEY is set;
 *    compared in constant time.
 * 2. The user's Dynamic JWT (Authorization: Bearer …), verified with jose against the environment
 *    JWKS: RS256 only, expiry enforced, the environment must be ours, and a token still waiting on
 *    MFA (scope `requiresAdditionalAuth`) is refused. The verified wallets are the JWT's blockchain
 *    `verified_credentials`; the routes then require the lane's OWNER (the Vault) among them (the
 *    delegation status route: the OPERATOR among them).
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, type JWTPayload, type JWTVerifyGetKey, jwtVerify } from "jose";
import type { Address, JwtVerifier, VerifiedUser } from "../types.js";

export type { JwtVerifier, VerifiedUser } from "../types.js";

export const AGENT_KEY_HEADER = "x-desk-agent-key";

export class AuthError extends Error {
  readonly status: 401 | 403;
  constructor(message: string, status: 401 | 403 = 401) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

/** Constant-time string equality (hash both sides so lengths never leak through timing). */
export function safeEqual(a: string, b: string): boolean {
  const x = createHash("sha256").update(a, "utf8").digest();
  const y = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(x, y) && a.length === b.length;
}

export function checkAgentKey(expected: string | undefined, presented: string | undefined): void {
  if (expected === undefined) return;
  if (presented === undefined || !safeEqual(expected, presented))
    throw new AuthError("missing or invalid agent key");
}

export function bearerToken(header: string | undefined): string {
  const m = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*)$/.exec(header ?? "");
  if (m === null) throw new AuthError("missing bearer token");
  return m[1] as string;
}

interface DynamicClaims extends JWTPayload {
  environment_id?: string;
  verified_credentials?: Array<{
    address?: string;
    chain?: string;
    format?: string;
  }>;
  scope?: string;
  scopes?: string[];
}

export interface JwtVerifierOptions {
  environmentId: string;
  jwksUrl: string;
  /** Test seam: a local key set (jose createLocalJWKSet). */
  keys?: JWTVerifyGetKey;
  /** Seconds of clock skew tolerated. Default 30. */
  clockToleranceSec?: number;
  /** Seconds since the epoch (tests). */
  currentDate?: () => Date;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function createJwtVerifier(opts: JwtVerifierOptions): JwtVerifier {
  const keys = opts.keys ?? createRemoteJWKSet(new URL(opts.jwksUrl), { cooldownDuration: 30_000 });
  return {
    async verify(token): Promise<VerifiedUser> {
      let payload: DynamicClaims;
      try {
        const r = await jwtVerify<DynamicClaims>(token, keys, {
          algorithms: ["RS256"],
          clockTolerance: opts.clockToleranceSec ?? 30,
          requiredClaims: ["sub", "exp"],
          ...(opts.currentDate === undefined ? {} : { currentDate: opts.currentDate() }),
        });
        payload = r.payload;
      } catch (err) {
        throw new AuthError(
          `invalid token: ${err instanceof Error ? err.name : "verification failed"}`,
        );
      }
      const env =
        payload.environment_id ??
        (typeof payload.iss === "string" ? payload.iss.split("/").pop() : undefined);
      if (env !== opts.environmentId)
        throw new AuthError("token is for another Dynamic environment");
      const scopes = [...(payload.scopes ?? []), ...(payload.scope ?? "").split(" ")];
      if (scopes.includes("requiresAdditionalAuth"))
        throw new AuthError("token requires additional authentication (MFA)", 403);
      const wallets = (payload.verified_credentials ?? [])
        .filter(
          (c) =>
            (c.format === undefined || c.format === "blockchain") &&
            typeof c.address === "string" &&
            ADDRESS_RE.test(c.address),
        )
        .map((c) => (c.address as string).toLowerCase() as Address);
      return {
        userId: payload.sub as string,
        wallets: [...new Set(wallets)],
        environmentId: env,
        expiresAtSec: payload.exp as number,
      };
    },
  };
}

/** `address` must be one of the user's verified wallets (403 otherwise). */
export function requireWallet(user: VerifiedUser, address: Address, message: string): void {
  if (!user.wallets.includes(address.toLowerCase() as Address)) throw new AuthError(message, 403);
}

/** The verified wallet must be the lane's owner (the Vault). */
export function requireOwner(user: VerifiedUser, owner: Address): void {
  requireWallet(user, owner, "the signed-in wallet is not this lane's owner");
}
