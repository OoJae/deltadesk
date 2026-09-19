"use client";

import { getAddress } from "viem";
import { useAction } from "./hooks";
import type { DeskSession } from "./session";
import { Btn, Notice, TxLine } from "./ui";

/**
 * The Vault must never be delegated: Dynamic policies can't filter selectors, so a delegated Vault would let the agent
 * call owner-only functions. Two alarms: the environment is set to push delegation on every wallet (the wizard stops
 * until it's fixed), and Dynamic reports the Vault delegated (revoke now).
 */
export default function VaultAlarm({ session }: { session: DeskSession }) {
  const action = useAction();
  const vault = session.vault;
  const unsafe = session.unsafeDelegationSettings;
  const delegated = !!vault && session.delegationOf(vault.address) === "delegated";
  if (!unsafe.length && !delegated) return null;
  return (
    <>
      {unsafe.length > 0 && (
        <Notice tone="critical" title="This Dynamic environment pushes delegation on every wallet">
          <div className="space-y-2">
            <p>
              Delegated access has <strong>{unsafe.join(" and ")}</strong> turned on. That lets Dynamic push its own delegation dialog, which lists every wallet, the
              Vault included, and may offer no way to decline. One click there hands the Vault&apos;s key share to the server. DeltaDesk switches that dialog off in
              this browser and marks the Vault as denied, but that is not enough: turn these settings off in the Dynamic dashboard, then reload.
            </p>
            <p>Desk setup is paused until then. Owner controls on existing desks keep working. Never approve a Dynamic dialog that lists more than the Operator.</p>
          </div>
        </Notice>
      )}
      {delegated && (
        <Notice tone="critical" title="Your Vault is delegated to a server">
          <div className="space-y-2">
            <p>The Vault owns the desk and must stay with you. Revoke its delegation now; only the Operator should be delegated.</p>
            <Btn
              kind="danger"
              disabled={action.busy}
              onClick={() => action.run("Revoking the Vault's delegation…", async () => void (await session.revokeDynamicDelegation(getAddress(vault.address))))}
            >
              Revoke Vault delegation
            </Btn>
            <TxLine state={action.state} />
          </div>
        </Notice>
      )}
    </>
  );
}
