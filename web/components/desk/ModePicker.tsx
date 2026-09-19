"use client";

import { useState } from "react";
import { getAddress, type Address } from "viem";
import { deskApi } from "@/lib/desk/api";
import type { EthereumWallet } from "@/lib/desk/tx";
import { MODES, type DeskMode } from "@/lib/desk/types";
import { useAction } from "./hooks";
import { TxLine } from "./ui";

/**
 * Mode changes are signed by the Vault (EIP-191 `DeltaDesk mode <lane> <mode> <nonce>`) so the agent can verify the
 * owner asked for them. Advisory is the default and never signs anything.
 */
export default function ModePicker({ lane, current, vault, jwt, onChanged }: { lane: Address; current?: string | null; vault: EthereumWallet | null; jwt: () => string | null; onChanged?: (m: DeskMode) => void }) {
  const [picked, setPicked] = useState<DeskMode | null>(null);
  const action = useAction();
  const mode = (picked ?? current ?? "advisory") as DeskMode;

  const choose = (m: DeskMode) =>
    action.run(`Sign “${m}” with your Vault…`, async () => {
      if (!vault) throw new Error("Sign in with the Vault first.");
      const nonce = Date.now().toString();
      const message = `DeltaDesk mode ${getAddress(lane)} ${m} ${nonce}`;
      const signature = await vault.signMessage(message);
      if (!signature) throw new Error("The Vault did not return a signature.");
      const r = await deskApi(`/${getAddress(lane)}/mode`, { method: "POST", body: { mode: m, signature, nonce }, jwt: jwt() });
      if (!r.ok) throw new Error(`Agent refused the mode change: ${r.error}`);
      setPicked(m);
      onChanged?.(m);
    });

  return (
    <div className="space-y-3">
      <div role="radiogroup" aria-label="Desk mode" className="grid gap-2 sm:grid-cols-3">
        {MODES.map((m) => {
          const on = m.mode === mode;
          return (
            <button
              key={m.mode}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={!m.enabled || action.busy || on}
              onClick={() => choose(m.mode)}
              className={`rounded-lg border p-3 text-left text-sm transition disabled:cursor-default ${on ? "border-[var(--accent)] bg-surface-2" : "border-[var(--ring)] hover:bg-surface-2"} ${!m.enabled ? "opacity-50" : ""}`}
            >
              <div className="flex items-center justify-between font-semibold">
                {m.label}
                {on && <span className="text-xs font-bold text-[var(--accent)]">✓ current</span>}
              </div>
              <div className="mt-1 text-xs text-ink-2">{m.note}</div>
            </button>
          );
        })}
      </div>
      <TxLine state={action.state.phase === "done" ? { phase: "done", note: `Mode set to ${mode}` } : action.state} />
    </div>
  );
}
