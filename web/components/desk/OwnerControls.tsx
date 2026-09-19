"use client";

import { encodeFunctionData, parseEventLogs, type Address, type Log } from "viem";
import { deskLaneAbi } from "@/lib/desk/abi/DeskLane";
import { LANE_A } from "@/lib/desk/chain";
import { fmtUnits, isZeroAddr } from "@/lib/desk/format";
import { ownerMeta } from "@/lib/desk/meta";
import type { LaneState } from "@/lib/desk/reads";
import { sendFromWallet, type EthereumWallet, type SentTx } from "@/lib/desk/tx";
import { useAction } from "./hooks";
import { Btn, Card, ConfirmButton, Status, TxLine } from "./ui";

export type OwnerSigner = {
  /** The signed-in wallet whose address is lane.owner(), or null. */
  vault: EthereumWallet | null;
  /** Why the controls are disabled (not signed in, wrong wallet, Dynamic not configured). */
  blocked: string | null;
  signIn?: () => void;
  /** Revokes the Dynamic delegation of the Operator when it is one of this user's embedded wallets. */
  revokeDynamic?: (operator: Address) => Promise<boolean>;
  operatorDelegated?: boolean;
};

/**
 * What exitAll did to the positions. It never reverts on one bad slot: a position it can't unwind (a paused or
 * blocklisting token makes the position manager's collect, decrease or burn fail) stays in its slot, and the lane emits
 * CollectFailed(tokenId) for it instead. `slots` is the lane's slots before the exit, to name the slot.
 */
export function exitAllNote(logs: readonly Log[], lane: Address, slots: readonly bigint[]): string {
  const own = logs.filter((l) => l.address.toLowerCase() === lane.toLowerCase());
  const kept = [...new Set(parseEventLogs({ abi: deskLaneAbi, eventName: "CollectFailed", logs: own }).map((e) => e.args.tokenId))];
  if (!kept.length) return "All positions unwound";
  const names = kept.map((id) => `NFT #${id.toString()}${slots.includes(id) ? ` (slot ${slots.indexOf(id)})` : ""}`);
  const one = kept.length === 1;
  return (
    `Exited, but ${names.join(" and ")} could not be unwound (the lane emitted CollectFailed: a token transfer failed, e.g. a paused token) and ` +
    `${one ? "stays in its slot" : "stay in their slots"}. Withdraw ${one ? "it" : "them"} to your Vault as ${one ? "it is" : "they are"} with the Withdraw NFT button.`
  );
}

/**
 * Vault-signed, on-chain, and independent of desk-agent: these work even when the agent is down or compromised.
 * None of them reads the price fence, so they also work on weekends and while NVDA is paused.
 */
export default function OwnerControls({ s, signer, onDone }: { s: LaneState; signer: OwnerSigner; onDone: () => void }) {
  const action = useAction();
  const vault = signer.vault;
  const disabled = !vault || action.busy;
  const hasPositions = s.positions.length > 0 || s.slots.some((x) => x > BigInt(0));
  const operatorLive = !isZeroAddr(s.operator);

  const send = (note: string, doneNote: string | ((r: SentTx) => string), data: () => Promise<`0x${string}`> | `0x${string}`) =>
    action.run(note, async (onHash, done) => {
      if (!vault) throw new Error("Sign in with this lane's Vault first.");
      const r = await sendFromWallet(vault, s.lane, await data(), onHash);
      onDone();
      done(typeof doneNote === "string" ? doneNote : doneNote(r));
      return r;
    });

  const revoke = () =>
    action.run("Revoking the agent…", async (onHash, done) => {
      if (!vault) throw new Error("Sign in with this lane's Vault first.");
      const notes: string[] = [];
      if (operatorLive) {
        await sendFromWallet(vault, s.lane, encodeFunctionData({ abi: deskLaneAbi, functionName: "revokeOperator" }), onHash);
        notes.push("operator revoked on-chain");
      }
      if (signer.revokeDynamic) {
        try {
          if (await signer.revokeDynamic(s.operator)) notes.push("Dynamic delegation revoked");
        } catch (e) {
          notes.push(`Dynamic revoke failed (${e instanceof Error ? e.message : "error"})${operatorLive ? "; the on-chain revoke already cut the agent off" : ""}`);
        }
      }
      onDone();
      done(notes.join(" · ") || "Nothing to revoke");
    });

  return (
    <Card title="Owner controls" aside={<span className="text-xs text-muted">signed by your Vault · no agent needed</span>}>
      {signer.blocked && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-surface-2 p-3 text-sm">
          <Status tone="warning">{signer.blocked}</Status>
          {signer.signIn && (
            <Btn kind="primary" onClick={signer.signIn}>
              Sign in
            </Btn>
          )}
        </div>
      )}

      <div className="grid gap-2">
        {s.paused ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--ring)] p-3">
            <Status tone="critical">Lane paused: nothing can add risk</Status>
            <ConfirmButton
              label="Unpause"
              confirm="Unpausing lets the Operator add liquidity again, within the caps."
              disabled={disabled}
              onConfirm={() => send("Unpausing…", "Unpaused", () => encodeFunctionData({ abi: deskLaneAbi, functionName: "unpause" }))}
            />
          </div>
        ) : (
          <ConfirmButton
            label="Pause"
            kind="danger"
            confirm="Pausing blocks every risk-adding action immediately. Exits and withdrawals still work."
            disabled={disabled}
            onConfirm={() => send("Pausing…", "Paused", () => encodeFunctionData({ abi: deskLaneAbi, functionName: "pause" }))}
          />
        )}

        <ConfirmButton
          label="Exit all"
          kind="danger"
          confirm={hasPositions ? "Unwinds every position into idle USDG and NVDA held by the lane; one whose token is paused stays in its slot. Nothing leaves the lane." : "There are no open positions; this only records an exit."}
          disabled={disabled}
          onConfirm={() =>
            send(
              "Exiting all positions…",
              (r) => exitAllNote(r.receipt.logs, s.lane, s.slots),
              async () => encodeFunctionData({ abi: deskLaneAbi, functionName: "exitAll", args: [await ownerMeta("exitAll", s.caps?.maxDeadlineAhead ?? 120)] }),
            )
          }
        />

        <ConfirmButton
          label="Withdraw all to Vault"
          confirm={`Sends ${fmtUnits(s.bal0, LANE_A.dec0, 2)} ${LANE_A.sym0} and ${fmtUnits(s.bal1, LANE_A.dec1, 6)} ${LANE_A.sym1} to your Vault.${hasPositions ? " Open positions stay in the lane: exit all first to include them." : ""}`}
          disabled={disabled}
          onConfirm={() => send("Withdrawing to the Vault…", "Withdrawn to the Vault", () => encodeFunctionData({ abi: deskLaneAbi, functionName: "withdrawAll" }))}
        />

        <div className="grid grid-cols-2 gap-2">
          {([0, 1] as const).map((slot) => {
            const id = s.slots[slot];
            const empty = id === BigInt(0);
            return (
              <ConfirmButton
                key={slot}
                label={empty ? `Slot ${slot} empty` : `Withdraw NFT #${id.toString()}`}
                confirm={`Transfers position NFT #${id.toString()} (slot ${slot}) to your Vault. The escape hatch that works even if a token is paused.`}
                disabled={disabled || empty}
                onConfirm={() => send(`Withdrawing position NFT #${id.toString()}…`, `NFT #${id.toString()} sent to the Vault`, () => encodeFunctionData({ abi: deskLaneAbi, functionName: "withdrawPosition", args: [slot] }))}
              />
            );
          })}
        </div>

        <ConfirmButton
          label="Revoke agent"
          kind="danger"
          confirm="Removes the Operator on-chain at once (the agent can no longer act on this lane) and revokes its Dynamic delegation. A new operator takes a 24 h timelock."
          disabled={disabled || (!operatorLive && !signer.operatorDelegated)}
          onConfirm={revoke}
        />
      </div>

      <TxLine state={action.state} />
    </Card>
  );
}
