"use client";

import { useState } from "react";
import { getAddress, type Address } from "viem";
import { deskApi } from "@/lib/desk/api";
import { short } from "@/lib/desk/format";
import type { EthereumWallet } from "@/lib/desk/tx";
import { MODES, type DeskMode } from "@/lib/desk/types";
import { useAction } from "./hooks";
import { useDeskStamp } from "./stamp";
import { TxLine } from "./ui";

/**
 * Mode changes are signed by the Vault (EIP-191 `DeltaDesk mode <lane> <mode> <nonce>`) so the agent can verify the
 * owner asked for them. Advisory is the default and never signs anything.
 */
export default function ModePicker({ lane, current, vault, jwt, onChanged }: { lane: Address; current?: string | null; vault: EthereumWallet | null; jwt: () => string | null; onChanged?: (m: DeskMode) => void }) {
  const [picked, setPicked] = useState<DeskMode | null>(null);
  const action = useAction();
  const { stamp } = useDeskStamp();
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
      stamp({ kind: "signed", title: `Mode set to ${m}`, detail: `Signed by your Vault · lane ${short(lane)}`, serial: nonce });
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
              className={`group relative border px-3.5 py-3 text-left text-sm transition-[transform,background-color,border-color] duration-200 ease-out active:scale-[0.98] disabled:cursor-default disabled:active:scale-100 ${on ? "border-paper-dim bg-vault-3" : "border-rule-strong bg-vault enabled:hover:border-paper-dim enabled:hover:bg-vault-3"} ${!m.enabled ? "opacity-50" : ""}`}
            >
              <span className="flex items-center justify-between gap-2 font-medium text-paper">
                {m.label}
                {on ? (
                  <span className="label inline-flex items-center gap-1.5 text-paper">
                    <span aria-hidden className="inline-block h-2 w-2 bg-paper" />
                    current
                  </span>
                ) : (
                  <span aria-hidden className="inline-block h-2 w-2 border border-paper-mute" />
                )}
              </span>
              <span className="mt-1.5 block text-[0.8rem] leading-snug text-paper-dim">{m.note}</span>
            </button>
          );
        })}
      </div>
      <TxLine state={action.state.phase === "done" ? { phase: "done", note: `Mode set to ${mode}` } : action.state} />
    </div>
  );
}
