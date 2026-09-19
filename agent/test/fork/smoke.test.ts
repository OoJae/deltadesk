import { describe, expect, inject, it } from "vitest";

const forkRpcUrl = inject("forkRpcUrl");

describe.skipIf(forkRpcUrl === null)("fork: anvil over Robinhood Chain", () => {
  it("serves chain 4663", async () => {
    const res = await fetch(forkRpcUrl as string, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    });
    const body = (await res.json()) as { result: string };
    expect(Number.parseInt(body.result, 16)).toBe(4663);
  });
});
