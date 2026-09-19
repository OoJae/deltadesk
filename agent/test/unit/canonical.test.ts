import { keccak256, stringToBytes } from "viem";
import { describe, expect, it } from "vitest";
import { canonicalJson, keccakJson, reasonHashOf } from "../../src/canonical.js";

describe("canonicalJson", () => {
  it("sorts keys at every depth, encodes bigints as strings and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: 2n, c: undefined, b: [3, undefined] } })).toBe(
      '{"a":{"b":[3,null],"d":"2"},"b":1}',
    );
    expect(canonicalJson({ x: 1, y: 2 })).toBe(canonicalJson({ y: 2, x: 1 }));
    expect(canonicalJson(new Uint8Array([1, 255]))).toBe('"0x01ff"');
  });

  it("rejects values that have no canonical JSON", () => {
    expect(() => canonicalJson({ x: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalJson({ x: new Map() })).toThrow(TypeError);
    expect(() => canonicalJson({ x: () => 1 })).toThrow(TypeError);
  });

  it("hashes the stored preimage (anyone can recompute Meta.reasonHash)", () => {
    const { hash, preimage } = reasonHashOf({
      finalPlan: { actions: [{ kind: "exitAll", lane: "A" }] },
      guardChecks: [{ rule: "arm-flag", passed: true, detail: "armed" }],
      snapshotDigest: keccakJson({ lane: "A" }),
    });
    expect(hash).toBe(keccak256(stringToBytes(preimage)));
    expect(JSON.parse(preimage).guardChecks[0].rule).toBe("arm-flag");
  });
});
