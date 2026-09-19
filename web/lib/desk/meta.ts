// Meta for owner-signed risk-reducing calls (exitAll) made straight from the web, independent of the agent.
// decisionId uses the agent's layout: ULID (48-bit ms time ‖ 80 random bits) ‖ 0x01 version ‖ step ‖ 14 zero bytes.
// The agent sees these as foreign LaneActions (caller = owner) and drops to safe mode, which is intended.
import { bytesToHex, keccak256, stringToBytes, type Hex } from "viem";
import { publicClient } from "./chain";

export type Meta = { decisionId: Hex; deadline: bigint; regime: number; gatesMask: number; reasonHash: Hex };

export function ownerDecisionId(nowMs = Date.now()): Hex {
  const b = new Uint8Array(32);
  for (let i = 0; i < 6; i++) b[i] = Math.floor(nowMs / 2 ** (8 * (5 - i))) % 256;
  crypto.getRandomValues(b.subarray(6, 16));
  b[16] = 0x01;
  b[17] = 0; // step
  return bytesToHex(b);
}

/**
 * Deadline from the chain clock, not the browser's: the lane checks block.timestamp <= deadline <= now + maxDeadlineAhead.
 * Leaves slack under the cap and gives the Vault up to 90 s to confirm before the call would revert with Expired.
 */
export async function ownerMeta(action: string, maxDeadlineAhead: number): Promise<Meta> {
  const block = await publicClient.getBlock({ blockTag: "latest" });
  const slack = maxDeadlineAhead > 25 ? 10 : 1;
  const ahead = BigInt(Math.min(90, Math.max(1, maxDeadlineAhead - slack)));
  return {
    decisionId: ownerDecisionId(),
    deadline: block.timestamp + ahead,
    regime: 0,
    gatesMask: 0,
    reasonHash: keccak256(stringToBytes(`DeltaDesk owner ${action} via web`)),
  };
}
