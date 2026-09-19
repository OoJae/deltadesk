"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { Button } from "@/components/brand/Button";

const CHAINS = [
  { id: "robinhood", label: "Robinhood Chain", note: "NVDA, SPY, TSLA, QQQ/SPY pools" },
  { id: "base", label: "Base · Aerodrome", note: "NVDAc/USDC, staked or not" },
] as const;

const WALLET = /^0x[0-9a-fA-F]{40}$/;

/** Wallet → /tearsheet?chain=…&wallet=… (the tearsheet's own query params). Validates before navigating. */
export function LedgerForm() {
  const router = useRouter();
  const id = useId();
  const [chain, setChain] = useState<(typeof CHAINS)[number]["id"]>("robinhood");
  const [wallet, setWallet] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const w = wallet.trim();
    if (!WALLET.test(w)) {
      setError(w ? "That isn't a 0x wallet address: 0x followed by 40 hex characters." : "Paste the wallet that holds your LP position.");
      return;
    }
    setError(null);
    setPending(true);
    router.push(`/tearsheet?chain=${chain}&wallet=${w.toLowerCase()}`);
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-5" aria-label="Check your LP position">
      <fieldset>
        <legend className="label text-paper-mute">Chain</legend>
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {CHAINS.map((c) => (
            <label
              key={c.id}
              className="flex cursor-pointer items-start gap-3 border border-rule px-4 py-3 transition-colors duration-200 hover:border-rule-strong has-[:checked]:border-paper-dim has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-serial"
            >
              <input
                type="radio"
                name="chain"
                value={c.id}
                checked={chain === c.id}
                onChange={() => setChain(c.id)}
                className="peer sr-only"
              />
              <span
                aria-hidden="true"
                className="mt-1 grid h-3.5 w-3.5 shrink-0 place-items-center rounded-full border border-paper-dim after:h-1.5 after:w-1.5 after:rounded-full after:bg-paper after:opacity-0 peer-checked:after:opacity-100"
              />
              <span>
                <span className="block text-[0.95rem] text-paper">{c.label}</span>
                <span className="block text-sm text-paper-mute">{c.note}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <div>
        <label htmlFor={`${id}-wallet`} className="label text-paper-mute">
          LP wallet
        </label>
        <div className="mt-3 flex flex-col gap-3 sm:flex-row">
          <input
            id={`${id}-wallet`}
            name="wallet"
            value={wallet}
            onChange={(e) => {
              setWallet(e.target.value);
              if (error) setError(null);
            }}
            inputMode="text"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="0x…"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${id}-error` : `${id}-hint`}
            className="h-14 w-full min-w-0 border sm:w-auto sm:flex-1 border-rule-strong bg-vault-3 px-4 font-mono text-[0.95rem] text-paper placeholder:text-paper-mute focus-visible:border-paper-dim aria-[invalid=true]:border-serial"
          />
          <Button type="submit" size="lg" trailing="→" disabled={pending} className="sm:w-auto">
            {pending ? "Opening" : "Check your LP"}
          </Button>
        </div>
        {error ? (
          <p id={`${id}-error`} role="alert" className="mt-2.5 flex items-baseline gap-2 text-sm text-paper">
            <span aria-hidden="true" className="font-mono text-serial">
              ✕
            </span>
            {error}
          </p>
        ) : (
          <p id={`${id}-hint`} className="mt-2.5 text-sm text-paper-mute">
            Read-only: we look up public on-chain positions. Nothing to sign.
          </p>
        )}
      </div>
    </form>
  );
}
