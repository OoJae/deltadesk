// The "Create the lane" step's chain logic, kept out of the component so it can be exercised against an anvil fork.
// createLane is permissionless and its CREATE2 salt commits to every parameter, so the only lane that can sit at the
// predicted address is exactly the one the Vault asked for; lanesOf(Vault) lists it only once the Vault itself sent
// createLane (factory.listed). The wizard therefore always sends createLane from the Vault unless the lane is already
// listed, then verifies the result on-chain before it lets the Operator be delegated.
import { encodeFunctionData, getAddress, parseEventLogs, type Address, type Hash } from "viem";
import { deskLaneFactoryAbi } from "./abi/DeskLaneFactory";
import { short } from "./format";
import { laneMismatches, predictLane, readFactory, readLaneCheck, type CreateParams, type LaneCheck, type LaneWant, type PendingImplementation } from "./reads";
import { describeError, sendFromWallet, type EthereumWallet } from "./tx";

const same = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** Why a pending implementation replacement blocks setup (a lane's address is derived from the implementation). */
export function pendingText(p: PendingImplementation): string {
  if ("unreadable" in p)
    return "The factory did not answer pendingImplementation(1), so the wizard can't confirm that your predicted lane address will hold. Setup stays paused until it can.";
  return (
    `The factory admin has proposed a new DeskLaneV3 implementation (${short(p.implementation)}) that can take effect after ${new Date(p.eta * 1000).toLocaleString()}. ` +
    "A lane's address is derived from the implementation, so the address predicted now would change once the replacement applies, and a Dynamic policy " +
    "allowlist set for it would name the wrong contract. Setup continues once the replacement is applied or cancelled; your address is then predicted again."
  );
}

export type Preflight = { lane: LaneCheck; fresh: Address | Error; pending: PendingImplementation | null };

/** The chain facts the create step decides on, read together. */
export async function preflight(factory: Address, params: CreateParams, predicted: Address): Promise<Preflight> {
  const [lane, fresh, f] = await Promise.all([
    readLaneCheck(factory, predicted, params.owner),
    predictLane(factory, params).catch((e: unknown) => (e instanceof Error ? e : new Error(String(e)))),
    readFactory(factory, params.owner),
  ]);
  return { lane, fresh, pending: f.pending };
}

export type Verdict =
  /** The lane exists, the factory lists it for this Vault and it is exactly what was asked for: nothing to send. */
  | { kind: "ready" }
  /** A lane is there but differs from what the Vault asked for: refuse it. */
  | { kind: "wrong"; problems: string[] }
  /** createLane must not be sent now. `repredict`: the prediction is stale. */
  | { kind: "blocked"; reason: string; repredict?: boolean }
  /** Send createLane: it deploys the lane, or (`frontRun`) lists the one already deployed with these exact params. */
  | { kind: "create"; frontRun: boolean };

export const wantOf = (p: CreateParams): LaneWant => ({ owner: p.owner, operator: p.operator, guardian: p.guardian, caps: p.caps });

export function judge(pf: Preflight, params: CreateParams, predicted: Address): Verdict {
  const c = pf.lane;
  if (c.code && (c.listed || c.inOwnerList)) {
    const problems = laneMismatches(c, wantOf(params), { requireListed: true });
    return problems.length ? { kind: "wrong", problems } : { kind: "ready" };
  }
  if (pf.pending) return { kind: "blocked", reason: pendingText(pf.pending) };
  if (pf.fresh instanceof Error) return { kind: "blocked", reason: `predictLane failed: ${describeError(pf.fresh)}` };
  if (!same(pf.fresh, predicted))
    return {
      kind: "blocked",
      reason: `The factory now predicts ${pf.fresh} for your settings, not ${predicted}: its lane implementation changed since step 4. Predict again and update the Operator's policy allowlist before creating the lane.`,
      repredict: true,
    };
  if (c.code) {
    // Deployed by someone else with these exact params (the salt commits to all of them), so only the roles the owner
    // could have changed since can differ; check anyway before listing it.
    const problems = laneMismatches(c, wantOf(params), { requireListed: false });
    return problems.length ? { kind: "wrong", problems } : { kind: "create", frontRun: true };
  }
  return { kind: "create", frontRun: false };
}

export type CreateOutcome =
  /** Already created and listed for the Vault, and verified; nothing was sent. */
  | { kind: "ready"; lane: Address }
  /** createLane landed, the lane is listed for the Vault and verified. `frontRun`: it listed an existing lane. */
  | { kind: "created"; lane: Address; frontRun: boolean }
  /** createLane landed somewhere other than `predicted`: the policy allowlist no longer matches. Not verified. */
  | { kind: "moved"; lane: Address };

/**
 * Re-checks the predicted address, sends createLane from the Vault when needed (it deploys the lane, or lists the one
 * deployed with these exact params) and verifies the result: listed for the Vault, owner, operator, guardian and caps
 * exactly as asked. Throws with the reason on anything else, so the caller never advances on a mismatch.
 */
export async function createOrList(wallet: EthereumWallet, factory: Address, params: CreateParams, predicted: Address, onHash?: (h: Hash) => void): Promise<CreateOutcome> {
  const v = judge(await preflight(factory, params, predicted), params, predicted);
  if (v.kind === "ready") return { kind: "ready", lane: predicted };
  if (v.kind === "wrong") throw new Error(`The lane at ${predicted} does not match what you chose: ${v.problems.join("; ")}.`);
  if (v.kind === "blocked") throw new Error(v.reason);

  const data = encodeFunctionData({ abi: deskLaneFactoryAbi, functionName: "createLane", args: [params] });
  const { receipt } = await sendFromWallet(wallet, factory, data, onHash);
  const logs = receipt.logs.filter((l) => same(l.address, factory));
  const ev = parseEventLogs({ abi: deskLaneFactoryAbi, eventName: "LaneListed", logs }).find((e) => same(e.args.owner, params.owner));
  if (!ev) throw new Error("createLane confirmed without listing a lane for your Vault. Open the transaction in the explorer before going on.");
  const lane = getAddress(ev.args.lane);
  if (!same(lane, predicted)) return { kind: "moved", lane };
  const problems = laneMismatches(await readLaneCheck(factory, lane, params.owner), wantOf(params), { requireListed: true });
  if (problems.length) throw new Error(`The lane at ${lane} does not match what you chose: ${problems.join("; ")}. Do not delegate the Operator or fund it.`);
  return { kind: "created", lane, frontRun: v.frontRun };
}
