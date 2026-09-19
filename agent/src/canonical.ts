/**
 * Canonical JSON and the decision reason hash.
 *
 * reason_hash = keccak256(canonicalJson({finalPlan, guardChecks, snapshotDigest})); the preimage is
 * stored next to it so anyone can recompute the on-chain Meta.reasonHash from the evidence trail.
 * Canonical means: object keys sorted, bigints as decimal strings, undefined properties dropped,
 * non-finite numbers rejected. The same function serialises every *_json column.
 */

import { keccak256, stringToBytes } from "viem";
import type { DeskSnapshot, GuardCheck, Hex } from "./types.js";

function normalise(value: unknown, path: string): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case "bigint":
      return value.toString();
    case "number":
      if (!Number.isFinite(value))
        throw new TypeError(`canonicalJson: non-finite number at ${path}`);
      return value;
    case "string":
    case "boolean":
      return value;
    case "undefined":
      return undefined;
    case "object": {
      if (Array.isArray(value)) {
        return value.map((v, i) => {
          const n = normalise(v, `${path}[${i}]`);
          return n === undefined ? null : n;
        });
      }
      if (value instanceof Uint8Array) {
        return `0x${Buffer.from(value).toString("hex")}`;
      }
      if (value instanceof Map || value instanceof Set) {
        throw new TypeError(`canonicalJson: Map/Set at ${path} is not serialisable`);
      }
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value).sort()) {
        const n = normalise((value as Record<string, unknown>)[key], `${path}.${key}`);
        if (n !== undefined) out[key] = n;
      }
      return out;
    }
    default:
      throw new TypeError(`canonicalJson: unsupported ${typeof value} at ${path}`);
  }
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalise(value, "$"));
}

export function keccakJson(value: unknown): Hex {
  return keccak256(stringToBytes(canonicalJson(value)));
}

/** keccak256 of the canonical snapshot: the snapshot's identity inside the reason preimage. */
export function snapshotDigest(snapshot: DeskSnapshot): Hex {
  return keccakJson(snapshot);
}

export interface ReasonPreimage {
  finalPlan: unknown;
  guardChecks: readonly GuardCheck[];
  snapshotDigest: Hex;
}

export function reasonHashOf(preimage: ReasonPreimage): { hash: Hex; preimage: string } {
  const json = canonicalJson(preimage);
  return { hash: keccak256(stringToBytes(json)), preimage: json };
}
