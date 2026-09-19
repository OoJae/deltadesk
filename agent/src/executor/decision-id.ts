/**
 * On-chain decisionId (bytes32) = ULID (16 bytes) ‖ version 0x01 ‖ step (uint8) ‖ 14 zero bytes.
 *
 * Reversible (the bytes32 decodes back to the decision's ULID and step) and time-sortable (the
 * ULID's 48-bit timestamp leads, so byte order is creation order). ULIDs come from a monotonic
 * factory, so two decisions minted in the same millisecond still sort in creation order. A
 * decisionId is single-use across all functions of a lane (decisionUsedAt), so every step of a
 * multi-step decision gets its own id through the step byte.
 */

import { monotonicFactory } from "ulid";
import type { Hex } from "../types.js";

export const DECISION_ID_VERSION = 1;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

/**
 * A fresh monotonic ULID source. Monotonic means it never goes backward: if the clock steps back,
 * new ids keep the last timestamp and increment, so creation order is preserved. Inject one per
 * daemon (and per test) rather than sharing process state.
 */
export function createDecisionUlidFactory(): (nowMs: number) => string {
  const next = monotonicFactory();
  return (nowMs) => next(nowMs);
}

const defaultFactory = createDecisionUlidFactory();

/** A new decision ULID from the process-wide monotonic factory. */
export function newDecisionUlid(nowMs: number): string {
  return defaultFactory(nowMs);
}

export function isUlid(s: string): boolean {
  return ULID_RE.test(s);
}

/** ULID (26 Crockford base32 chars, 128 bits) → 16 bytes, big-endian. */
export function ulidToBytes(ulid: string): Uint8Array {
  if (!isUlid(ulid)) throw new RangeError(`not a canonical ULID: ${ulid}`);
  let v = 0n;
  for (const ch of ulid) v = (v << 5n) | BigInt(CROCKFORD.indexOf(ch));
  const out = new Uint8Array(16);
  for (let i = 15; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

export function bytesToUlid(bytes: Uint8Array): string {
  if (bytes.length !== 16) throw new RangeError(`a ULID is 16 bytes, got ${bytes.length}`);
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  let s = "";
  for (let i = 0; i < 26; i++) {
    s = (CROCKFORD[Number(v & 31n)] as string) + s;
    v >>= 5n;
  }
  return s;
}

export function encodeDecisionId(ulid: string, step: number): Hex {
  if (!Number.isInteger(step) || step < 0 || step > 255)
    throw new RangeError(`step must be a uint8, got ${step}`);
  const out = new Uint8Array(32);
  out.set(ulidToBytes(ulid), 0);
  out[16] = DECISION_ID_VERSION;
  out[17] = step;
  return `0x${Buffer.from(out).toString("hex")}`;
}

export function decodeDecisionId(id: Hex): { ulid: string; version: number; step: number } {
  if (!/^0x[0-9a-fA-F]{64}$/.test(id))
    throw new RangeError(`decisionId must be bytes32 hex, got ${id}`);
  const bytes = Buffer.from(id.slice(2), "hex");
  const version = bytes[16] as number;
  if (version !== DECISION_ID_VERSION)
    throw new RangeError(`unknown decisionId version ${version}`);
  for (let i = 18; i < 32; i++) {
    if (bytes[i] !== 0) throw new RangeError("decisionId tail must be 14 zero bytes");
  }
  return { ulid: bytesToUlid(bytes.subarray(0, 16)), version, step: bytes[17] as number };
}

/** A decisionId from anyone else (an owner acting directly, a foreign tool) fails to decode. */
export function tryDecodeDecisionId(
  id: Hex,
): { ulid: string; version: number; step: number } | null {
  try {
    return decodeDecisionId(id);
  } catch {
    return null;
  }
}
