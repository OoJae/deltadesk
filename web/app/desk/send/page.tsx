"use client";

// Send an embedded wallet's balance to another address: the last step of "withdraw everything". The lane can only pay
// its Vault (withdrawAll on /desk/<lane>); from the Vault, and from the Operator's gas wallet, the owner moves funds
// wherever they like here. Every transfer is signed by the owner in Dynamic's own confirmation window.
import { useCallback, useEffect, useMemo, useState } from "react";
import { encodeFunctionData, erc20Abi, formatEther, formatUnits, getAddress, isAddress, type Address, type Hash } from "viem";
import { Button } from "@/components/brand/Button";
import { LedgerPanel } from "@/components/brand/LedgerPanel";
import { PageHeader } from "@/components/brand/PageHeader";
import { useDeskSession } from "@/components/desk/context";
import { ADDR, publicClient, txUrl } from "@/lib/desk/chain";
import { sendFromWallet, sendValueFromWallet, type EthereumWallet } from "@/lib/desk/tx";

type Balances = { eth: bigint; usdg: bigint; nvda: bigint };
type Log = { label: string; hash?: Hash; ok?: boolean; error?: string };

const TOKENS = [
  { key: "usdg", sym: "USDG", addr: ADDR.USDG as Address, dec: 6 },
  { key: "nvda", sym: "NVDA", addr: ADDR.NVDA as Address, dec: 18 },
] as const;

async function readBalances(a: Address): Promise<Balances> {
  const [eth, usdg, nvda] = await Promise.all([
    publicClient.getBalance({ address: a }),
    publicClient.readContract({ address: ADDR.USDG as Address, abi: erc20Abi, functionName: "balanceOf", args: [a] }),
    publicClient.readContract({ address: ADDR.NVDA as Address, abi: erc20Abi, functionName: "balanceOf", args: [a] }),
  ]);
  return { eth, usdg, nvda };
}

export default function SendPage() {
  const s = useDeskSession();
  const wallets = useMemo(() => {
    if (!s?.vault) return [] as { role: string; w: EthereumWallet }[];
    return [{ role: "Vault", w: s.vault as unknown as EthereumWallet }, ...s.others.map((o) => ({ role: "Operator / other", w: o as unknown as EthereumWallet }))];
  }, [s?.vault, s?.others]);
  const [from, setFrom] = useState<string>("");
  const [to, setTo] = useState<string>("");
  const [bal, setBal] = useState<Balances | null>(null);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<Log[]>([]);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("to");
    if (q && isAddress(q)) setTo(getAddress(q));
  }, []);
  useEffect(() => {
    if (!from && wallets[0]) setFrom(wallets[0].w.address);
  }, [from, wallets]);

  const refresh = useCallback(async () => {
    if (from && isAddress(from)) setBal(await readBalances(getAddress(from)));
  }, [from]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const wallet = wallets.find((x) => x.w.address.toLowerCase() === from.toLowerCase())?.w;
  const dest = isAddress(to) ? getAddress(to) : null;
  const self = dest && wallets.some((x) => x.w.address.toLowerCase() === dest.toLowerCase());

  const run = async (label: string, fn: (onHash: (h: Hash) => void) => Promise<unknown>) => {
    setBusy(true);
    const i = log.length;
    setLog((l) => [...l, { label }]);
    try {
      await fn((h) => setLog((l) => l.map((x, k) => (k === i ? { ...x, hash: h } : x))));
      setLog((l) => l.map((x, k) => (k === i ? { ...x, ok: true } : x)));
    } catch (e) {
      setLog((l) => l.map((x, k) => (k === i ? { ...x, error: e instanceof Error ? e.message : String(e) } : x)));
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  const sendToken = (t: (typeof TOKENS)[number]) => {
    if (!wallet || !dest || !bal) return;
    const amt = bal[t.key];
    const data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [dest, amt] });
    void run(`${formatUnits(amt, t.dec)} ${t.sym} → ${dest}`, (onHash) => sendFromWallet(wallet, t.addr, data, onHash));
  };

  const sendEth = async () => {
    if (!wallet || !dest || !bal) return;
    const fees = await publicClient.estimateFeesPerGas();
    const reserve = (fees.maxFeePerGas ?? BigInt(0)) * BigInt(21000) * BigInt(3); // 3x headroom for the fee to move
    const amt = bal.eth - reserve;
    if (amt <= BigInt(0)) return;
    void run(`${formatEther(amt)} ETH → ${dest}`, (onHash) => sendValueFromWallet(wallet, dest, amt, onHash));
  };

  if (!s) return <main className="mx-auto max-w-3xl px-5 py-16 text-paper-dim">Wallet sign-in is not configured.</main>;
  if (!s.loggedIn) {
    return (
      <main id="content" className="mx-auto max-w-3xl px-5 py-16">
        <PageHeader label="Desk · withdraw" title="Send your funds" italic="out" lede="Sign in with the email you used for your desk. Every transfer is signed by you in Dynamic's window." />
        <div className="mt-8">
          <Button onClick={s.signIn}>Sign in with email</Button>
        </div>
      </main>
    );
  }

  return (
    <main id="content" className="mx-auto max-w-3xl px-5 py-16">
      <PageHeader
        label="Desk · withdraw"
        title="Send your funds"
        italic="out"
        lede="The lane can only pay its Vault. Use Withdraw all to Vault on the lane page first, then send each balance from the Vault and from the Operator's gas wallet to an address you control. Send ETH last: it pays the gas."
      />
      <LedgerPanel className="mt-10" label="From" title="Wallet">
        <div className="grid gap-3">
          {wallets.map(({ role, w }) => (
            <label key={w.address} className="flex cursor-pointer items-center gap-3 font-mono text-sm">
              <input type="radio" name="from" checked={from.toLowerCase() === w.address.toLowerCase()} onChange={() => setFrom(w.address)} />
              <span className="text-paper-dim">{role}</span> {w.address}
            </label>
          ))}
        </div>
        {bal && (
          <dl className="mt-6 grid grid-cols-3 gap-4 font-mono text-sm">
            <div><dt className="label">ETH</dt><dd>{formatEther(bal.eth)}</dd></div>
            <div><dt className="label">USDG</dt><dd>{formatUnits(bal.usdg, 6)}</dd></div>
            <div><dt className="label">NVDA</dt><dd>{formatUnits(bal.nvda, 18)}</dd></div>
          </dl>
        )}
      </LedgerPanel>
      <LedgerPanel className="mt-6" label="To" title="Destination on Robinhood Chain">
        <input
          className="w-full border border-rule bg-transparent px-3 py-3 font-mono text-sm text-paper focus:outline-none focus:ring-2 focus:ring-serial"
          placeholder="0x…"
          value={to}
          onChange={(e) => setTo(e.target.value.trim())}
          aria-label="Destination address"
        />
        {to && !dest && <p className="mt-2 text-sm text-serial">Not a valid address.</p>}
        {self && <p className="mt-2 text-sm text-serial">That is one of your own desk wallets. Pick an outside address.</p>}
      </LedgerPanel>
      <div className="mt-6 flex flex-wrap gap-3">
        {TOKENS.map((t) => (
          <Button key={t.key} disabled={busy || !wallet || !dest || !!self || !bal || bal[t.key] === BigInt(0)} onClick={() => sendToken(t)}>
            Send all {t.sym}
          </Button>
        ))}
        <Button variant="ghost" disabled={busy || !wallet || !dest || !!self || !bal || bal.eth === BigInt(0)} onClick={() => void sendEth()}>
          Send ETH (last)
        </Button>
      </div>
      {log.length > 0 && (
        <LedgerPanel className="mt-8" label="Transfers" title="This session" ruled>
          <ul className="grid gap-2 font-mono text-sm">
            {log.map((l, i) => (
              <li key={i}>
                {l.ok ? "✓" : l.error ? "✗" : "…"} {l.label}{" "}
                {l.hash && <a className="underline" href={txUrl(l.hash)} target="_blank" rel="noreferrer">tx</a>}
                {l.error && <span className="text-serial"> {l.error}</span>}
              </li>
            ))}
          </ul>
        </LedgerPanel>
      )}
    </main>
  );
}
