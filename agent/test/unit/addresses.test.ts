import { readFileSync } from "node:fs";
import { getAddress } from "viem";
import { describe, expect, it } from "vitest";
import { ADDRESSES_4663, CHAIN_ID_4663, NVDA_USDG_POOL } from "../../src/addresses.js";

const SOL = readFileSync(
  new URL("../../../contracts/script/Addresses4663.sol", import.meta.url),
  "utf8",
);

describe("addresses mirror contracts/script/Addresses4663.sol", () => {
  const constants: Array<[string, string]> = [
    ...SOL.matchAll(/address internal constant (\w+) = (0x[0-9a-fA-F]{40});/g),
  ].map((m) => [m[1] as string, m[2] as string]);

  it("has every Solidity constant with the same checksummed value", () => {
    expect(constants.length).toBeGreaterThan(15);
    const ts = ADDRESSES_4663 as Record<string, string>;
    for (const [name, addr] of constants) expect(ts[name], name).toBe(addr);
    expect(Object.keys(ts).sort()).toEqual(constants.map(([n]) => n).sort());
  });

  it("uses valid EIP-55 checksums and the chain id", () => {
    for (const a of Object.values(ADDRESSES_4663)) expect(getAddress(a)).toBe(a);
    expect(SOL).toContain(`CHAIN_ID = ${CHAIN_ID_4663};`);
  });

  it("describes the NVDA/USDG pool orientation", () => {
    expect(NVDA_USDG_POOL).toMatchObject({
      token0: ADDRESSES_4663.USDG,
      token1: ADDRESSES_4663.NVDA,
      dec0: 6,
      dec1: 18,
    });
    expect(NVDA_USDG_POOL.tickSpacing).toBe(10);
    expect(NVDA_USDG_POOL.fee).toBe(500);
  });
});
