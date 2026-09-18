import { api } from "@/lib/api";
import { usd } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "LP tearsheet · DeltaDesk" };

type Json = Record<string, unknown>;

function Value({ k, v }: { k: string; v: unknown }) {
  if (typeof v === "number") return <span className="tabular">{/usd|fee|lvr|pnl|gas|net|value|il|picked/i.test(k) ? usd(v, 2) : Number.isInteger(v) ? v.toLocaleString() : v.toFixed(3)}</span>;
  if (v == null) return <span className="text-muted">–</span>;
  if (typeof v === "object") return <span className="text-xs text-muted">{Array.isArray(v) ? `${v.length} items` : "…"}</span>;
  return <span>{String(v)}</span>;
}

export default async function TearsheetPage({ searchParams }: { searchParams: Promise<{ wallet?: string }> }) {
  const wallet = ((await searchParams).wallet ?? "").trim().toLowerCase();
  const valid = /^0x[0-9a-f]{40}$/.test(wallet);
  const res = valid ? await api<Json>(`/tearsheet/robinhood/${wallet}`, { premium: true }) : null;
  const data = res?.ok ? res.data : null;
  const totals = (data?.totals ?? data?.total ?? null) as Json | null;
  const positions = (data?.positions ?? []) as Json[];
  const cols = positions[0] ? Object.keys(positions[0]).filter((c) => typeof positions[0][c] !== "object").slice(0, 10) : [];

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 px-4 py-10">
      <header className="space-y-2">
        <p className="text-xs font-medium uppercase tracking-wider text-muted">LP tearsheet</p>
        <h1 className="text-3xl font-semibold">What did your liquidity actually earn?</h1>
        <p className="max-w-2xl text-sm text-ink-2">Fees, value picked off by informed flow, impermanent loss vs holding, price P&amp;L and gas, reconciled against the fees you actually collected on-chain.</p>
      </header>
      <form className="card flex gap-2 p-3" action="/tearsheet">
        <input name="wallet" defaultValue={wallet} placeholder="0x… LP wallet on Robinhood Chain" className="w-full rounded-lg bg-surface-2 px-3 py-2 font-mono text-sm outline-none focus:ring-2 focus:ring-[var(--accent)]" />
        <button className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white">Analyze</button>
      </form>
      {wallet && !valid && <p className="text-sm text-ink-2">That isn&apos;t a 0x wallet address.</p>}
      {res && !res.ok && <p className="text-sm text-ink-2">{res.status === 503 ? "Tearsheets are still being computed. Try again shortly." : `Couldn't load: ${res.error}`}</p>}
      {totals && (
        <section className="card grid grid-cols-2 gap-4 p-5 md:grid-cols-4">
          {Object.entries(totals).filter(([, v]) => typeof v === "number").slice(0, 12).map(([k, v]) => (
            <div key={k}><div className="text-xs text-muted">{k.replaceAll("_", " ")}</div><div className="text-lg font-semibold"><Value k={k} v={v} /></div></div>
          ))}
        </section>
      )}
      {positions.length > 0 && (
        <section className="card overflow-x-auto p-2">
          <table className="w-full text-xs tabular">
            <thead className="text-muted"><tr>{cols.map((c) => <th key={c} className="p-2 text-left">{c.replaceAll("_", " ")}</th>)}</tr></thead>
            <tbody>{positions.slice(0, 200).map((p, i) => <tr key={i} className="border-t border-grid">{cols.map((c) => <td key={c} className="p-2"><Value k={c} v={p[c]} /></td>)}</tr>)}</tbody>
          </table>
        </section>
      )}
    </main>
  );
}
