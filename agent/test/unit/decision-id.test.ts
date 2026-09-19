import fc from "fast-check";
import { decodeTime } from "ulid";
import { describe, expect, it } from "vitest";
import {
  bytesToUlid,
  createDecisionUlidFactory,
  decodeDecisionId,
  encodeDecisionId,
  isUlid,
  newDecisionUlid,
  tryDecodeDecisionId,
  ulidToBytes,
} from "../../src/executor/decision-id.js";

describe("decisionId codec", () => {
  it("lays out ULID ‖ 0x01 ‖ step ‖ 14 zero bytes", () => {
    const ulid = "01K5HZ3N8QW0000000000000AB";
    const id = encodeDecisionId(ulid, 3);
    expect(id).toHaveLength(66);
    expect(id.slice(2, 34)).toBe(Buffer.from(ulidToBytes(ulid)).toString("hex"));
    expect(id.slice(34, 36)).toBe("01");
    expect(id.slice(36, 38)).toBe("03");
    expect(id.slice(38)).toBe("0".repeat(28));
    expect(decodeDecisionId(id)).toEqual({ ulid, version: 1, step: 3 });
  });

  it("round-trips any ULID and step", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2 ** 48 - 1 }),
        fc.integer({ min: 0, max: 255 }),
        (ms, step) => {
          const ulid = createDecisionUlidFactory()(ms);
          expect(isUlid(ulid)).toBe(true);
          expect(bytesToUlid(ulidToBytes(ulid))).toBe(ulid);
          const decoded = decodeDecisionId(encodeDecisionId(ulid, step));
          expect(decoded.ulid).toBe(ulid);
          expect(decoded.step).toBe(step);
        },
      ),
    );
  });

  it("is time-sortable: byte order is creation order, even within one millisecond", () => {
    const next = createDecisionUlidFactory();
    const ids: string[] = [];
    for (let i = 0; i < 50; i++)
      ids.push(encodeDecisionId(next(1_758_000_000_000 + Math.floor(i / 10)), 0));
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
    expect(decodeTime(decodeDecisionId(ids[0] as `0x${string}`).ulid)).toBe(1_758_000_000_000);
  });

  it("never goes backward when the clock does", () => {
    const next = createDecisionUlidFactory();
    const a = next(1_758_000_000_500);
    const b = next(1_758_000_000_000);
    expect(b > a).toBe(true);
    expect(decodeTime(b)).toBe(1_758_000_000_500);
  });

  it("is never zero (the contract rejects decisionId 0)", () => {
    expect(BigInt(encodeDecisionId(newDecisionUlid(0), 0))).not.toBe(0n);
  });

  it("rejects malformed ids, versions and tails", () => {
    const ulid = newDecisionUlid(1_758_000_000_000);
    const good = encodeDecisionId(ulid, 1);
    expect(() => encodeDecisionId(ulid, 256)).toThrow(RangeError);
    expect(() => encodeDecisionId(ulid, -1)).toThrow(RangeError);
    expect(() => encodeDecisionId("not-a-ulid", 0)).toThrow(RangeError);
    expect(() =>
      decodeDecisionId(`${good.slice(0, 34)}02${good.slice(36)}` as `0x${string}`),
    ).toThrow(/version/);
    expect(() => decodeDecisionId(`${good.slice(0, 64)}01` as `0x${string}`)).toThrow(/zero/);
    expect(() => decodeDecisionId("0x1234")).toThrow(RangeError);
    // An owner acting directly uses an arbitrary id: it simply does not decode.
    expect(tryDecodeDecisionId(`0x${"ab".repeat(32)}`)).toBeNull();
  });
});
