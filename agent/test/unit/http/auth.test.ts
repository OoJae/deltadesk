import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import {
  AuthError,
  bearerToken,
  checkAgentKey,
  createJwtVerifier,
  requireOwner,
  safeEqual,
} from "../../../src/http/auth.js";
import type { Address } from "../../../src/types.js";
import { ENV_ID, jwtKit, walletsClaim } from "./_http.js";

const VAULT = "0xAbCdEf0000000000000000000000000000000001";

describe("Dynamic JWT verification (jose + JWKS)", () => {
  it("verifies RS256, our environment, and returns the lowercase blockchain wallets", async () => {
    const kit = await jwtKit();
    const v = createJwtVerifier({
      environmentId: ENV_ID,
      jwksUrl: "https://unused.invalid",
      keys: kit.keys,
    });
    const user = await v.verify(
      await kit.token({
        ...walletsClaim(VAULT, "0x2222222222222222222222222222222222222222"),
        verified_credentials: [
          ...walletsClaim(VAULT).verified_credentials,
          { address: "alice@example.com", format: "email" },
          { address: "not-an-address", format: "blockchain" },
        ],
      }),
    );
    expect(user.userId).toBe("user-1");
    expect(user.environmentId).toBe(ENV_ID);
    expect(user.wallets).toEqual([VAULT.toLowerCase()]);
    expect(user.expiresAtSec).toBeGreaterThan(Date.now() / 1000);
  });

  it("refuses expired tokens, other environments, other keys and HS256", async () => {
    const kit = await jwtKit();
    const other = await jwtKit();
    const v = createJwtVerifier({
      environmentId: ENV_ID,
      jwksUrl: "https://unused.invalid",
      keys: kit.keys,
    });
    await expect(
      v.verify(await kit.token({}, { exp: Math.floor(Date.now() / 1000) - 120 })),
    ).rejects.toBeInstanceOf(AuthError);
    await expect(v.verify(await kit.token({ environment_id: "someone-else" }))).rejects.toThrow(
      /another Dynamic environment/,
    );
    await expect(v.verify(await other.token())).rejects.toBeInstanceOf(AuthError);
    const hs = await new SignJWT({ environment_id: ENV_ID })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("u")
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode("x".repeat(32)));
    await expect(v.verify(hs)).rejects.toBeInstanceOf(AuthError);
  });

  it("a token still waiting on MFA is 403", async () => {
    const kit = await jwtKit();
    const v = createJwtVerifier({
      environmentId: ENV_ID,
      jwksUrl: "https://unused.invalid",
      keys: kit.keys,
    });
    await expect(
      v.verify(await kit.token({ scopes: ["requiresAdditionalAuth"] })),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("falls back to the issuer for the environment id", async () => {
    const kit = await jwtKit();
    const v = createJwtVerifier({
      environmentId: ENV_ID,
      jwksUrl: "https://unused.invalid",
      keys: kit.keys,
    });
    const t = await kit.token({ environment_id: undefined });
    expect((await v.verify(t)).environmentId).toBe(ENV_ID);
  });
});

describe("request auth helpers", () => {
  it("bearer tokens", () => {
    expect(bearerToken("Bearer aaa.bbb.ccc")).toBe("aaa.bbb.ccc");
    expect(() => bearerToken(undefined)).toThrow(AuthError);
    expect(() => bearerToken("Basic xyz")).toThrow(AuthError);
  });

  it("the agent key is compared in constant time and required only when configured", () => {
    expect(safeEqual("a".repeat(30), "a".repeat(30))).toBe(true);
    expect(safeEqual("a".repeat(30), "a".repeat(29))).toBe(false);
    expect(() => checkAgentKey(undefined, undefined)).not.toThrow();
    expect(() => checkAgentKey("k".repeat(30), undefined)).toThrow(AuthError);
    expect(() => checkAgentKey("k".repeat(30), "x".repeat(30))).toThrow(AuthError);
    expect(() => checkAgentKey("k".repeat(30), "k".repeat(30))).not.toThrow();
  });

  it("requireOwner: the verified wallets must include the lane owner", () => {
    const user = {
      userId: "u",
      wallets: [VAULT.toLowerCase() as Address],
      environmentId: ENV_ID,
      expiresAtSec: 0,
    };
    expect(() => requireOwner(user, VAULT as Address)).not.toThrow();
    expect(() => requireOwner(user, "0x9999999999999999999999999999999999999999")).toThrow(
      AuthError,
    );
  });
});
