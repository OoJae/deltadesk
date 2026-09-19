import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createVault, VAULT_PURPOSE, VaultError } from "../../../src/signer/vault.js";
import type { Address } from "../../../src/types.js";

const KEK = randomBytes(32).toString("base64");
const OTHER_KEK = randomBytes(32).toString("base64");
const WALLET = "4f6e6b2a-6d8e-4d1c-9a55-7b1f1e0c2a11";
const ADDR = "0x3333333333333333333333333333333333333333" as Address;
const aad = { walletId: WALLET, address: ADDR };
const enc = (s: string) => Buffer.from(s, "utf8");
const dec = (b: Uint8Array) => Buffer.from(b).toString("utf8");

function flip(blob: string, part: 1 | 2 | 3): string {
  const parts = blob.split(".");
  const buf = Buffer.from(parts[part] as string, "base64url");
  buf[0] = (buf[0] as number) ^ 0x01;
  parts[part] = buf.toString("base64url");
  return parts.join(".");
}

describe("vault: AES-256-GCM envelope", () => {
  const vault = createVault({ kekB64: KEK, kekId: "k1" });
  const row = vault.sealRow(
    { [VAULT_PURPOSE.keyShare]: enc('{"share":1}'), [VAULT_PURPOSE.apiKey]: enc("wk_secret") },
    aad,
  );
  const binding = { dekWrapped: row.dekWrapped, kekId: row.kekId };

  it("round-trips every field under its own purpose", () => {
    expect(row.kekId).toBe("k1");
    expect(
      dec(
        vault.openField(binding, row.ciphertexts.keyShare as string, {
          ...aad,
          purpose: "keyShare",
        }),
      ),
    ).toBe('{"share":1}');
    expect(
      dec(
        vault.openField(binding, row.ciphertexts.apiKey as string, { ...aad, purpose: "apiKey" }),
      ),
    ).toBe("wk_secret");
  });

  it("never stores plaintext, and two seals of the same data differ (random DEK and IV)", () => {
    expect(JSON.stringify(row)).not.toContain("wk_secret");
    const again = vault.sealRow({ apiKey: enc("wk_secret") }, aad);
    expect(again.ciphertexts.apiKey).not.toBe(row.ciphertexts.apiKey);
    expect(again.dekWrapped).not.toBe(row.dekWrapped);
  });

  it.each([1, 2, 3] as const)("tampering with blob part %i fails authentication", (part) => {
    expect(() =>
      vault.openField(binding, flip(row.ciphertexts.apiKey as string, part), {
        ...aad,
        purpose: "apiKey",
      }),
    ).toThrow(VaultError);
    expect(() =>
      vault.openField(
        { ...binding, dekWrapped: flip(row.dekWrapped, part) },
        row.ciphertexts.apiKey as string,
        { ...aad, purpose: "apiKey" },
      ),
    ).toThrow(VaultError);
  });

  it("the AAD binds wallet, address and purpose: moving a ciphertext fails", () => {
    const ct = row.ciphertexts.apiKey as string;
    expect(() => vault.openField(binding, ct, { ...aad, purpose: "keyShare" })).toThrow(VaultError);
    expect(() =>
      vault.openField(binding, ct, { ...aad, walletId: "another-wallet", purpose: "apiKey" }),
    ).toThrow(VaultError);
    expect(() =>
      vault.openField(binding, ct, {
        walletId: WALLET,
        address: "0x4444444444444444444444444444444444444444",
        purpose: "apiKey",
      }),
    ).toThrow(VaultError);
    // Address case does not matter (stored lowercase everywhere).
    expect(
      dec(
        vault.openField(binding, ct, {
          walletId: WALLET,
          address: ADDR.toUpperCase().replace("0X", "0x") as Address,
          purpose: "apiKey",
        }),
      ),
    ).toBe("wk_secret");
  });

  it("a wrapped DEK cannot be swapped between rows", () => {
    const other = vault.sealRow({ apiKey: enc("other") }, { walletId: "w2", address: ADDR });
    expect(() =>
      vault.openField(
        { dekWrapped: other.dekWrapped, kekId: "k1" },
        row.ciphertexts.apiKey as string,
        { ...aad, purpose: "apiKey" },
      ),
    ).toThrow(VaultError);
  });

  it("the wrong KEK, or an unknown KEK id, cannot open a row", () => {
    const wrong = createVault({ kekB64: OTHER_KEK, kekId: "k1" });
    expect(() =>
      wrong.openField(binding, row.ciphertexts.apiKey as string, { ...aad, purpose: "apiKey" }),
    ).toThrow(VaultError);
    expect(() =>
      vault.openField({ ...binding, kekId: "k9" }, row.ciphertexts.apiKey as string, {
        ...aad,
        purpose: "apiKey",
      }),
    ).toThrow(/unknown KEK/);
  });

  it("rotation: a retired KEK still opens its rows; new rows use the current one", () => {
    const rotated = createVault({ kekB64: OTHER_KEK, kekId: "k2", previous: { k1: KEK } });
    expect(
      dec(
        rotated.openField(binding, row.ciphertexts.apiKey as string, { ...aad, purpose: "apiKey" }),
      ),
    ).toBe("wk_secret");
    expect(rotated.sealRow({ apiKey: enc("x") }, aad).kekId).toBe("k2");
  });

  it("refuses a malformed blob, a short KEK and ambiguous AAD parts", () => {
    expect(() => vault.openField(binding, "v2.a.b.c", { ...aad, purpose: "apiKey" })).toThrow(
      /malformed/,
    );
    expect(() => vault.openField(binding, "garbage", { ...aad, purpose: "apiKey" })).toThrow(
      /malformed/,
    );
    expect(() => createVault({ kekB64: randomBytes(16).toString("base64"), kekId: "k1" })).toThrow(
      /32 bytes/,
    );
    expect(() => vault.sealRow({ apiKey: enc("x") }, { walletId: "a|b", address: ADDR })).toThrow(
      /\|/,
    );
  });
});
