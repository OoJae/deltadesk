import { api, type Row } from "@/lib/api";
import { usd } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "LP League · DeltaDesk" };

export default async function LeaguePage() {
  const res = await api<{ rows: Row[] }>("/lp-league?limit=100", { premium: true });
  const rows = res.ok ? res.data.rows : [];
  const cols = rows[0] ? Object.keys(rows[0]).slice(0, 9) : [];
  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 px-4 py-10">
      <header className="space-y-2">
        <p className="text-xs font-medium uppercase tracking-wider text-muted">LP League</p>
        <h1 className="text-3xl font-semibold">Who actually makes money making markets?</h1>
        <p className="max-w-2xl text-sm text-ink-2">LP wallets in Robinhood Chain stock pools ranked by net edge per $1k per day, after the value informed flow picked off.</p>
      </header>
      {!res.ok ? (
        <p className="text-sm text-ink-2">{res.status === 503 ? "The League is still being computed. Try again shortly." : `Couldn't load: ${res.error}`}</p>
      ) : (
        <section className="card overflow-x-auto p-2">
          <table className="w-full text-xs tabular">
            <thead className="text-muted"><tr><th className="p-2 text-left">#</th>{cols.map((c) => <th key={c} className="p-2 text-left">{c.replaceAll("_", " ")}</th>)}</tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-t border-grid">
                  <td className="p-2 text-muted">{i + 1}</td>
                  {cols.map((c) => {
                    const v = r[c];
                    return <td key={c} className="p-2">{typeof v === "number" ? (/usd|net|notional/i.test(c) ? usd(v, 2) : v.toFixed(2)) : typeof v === "string" && v.startsWith("0x") ? <a className="font-mono text-[var(--accent)]" href={`/tearsheet?wallet=${v}`}>{v.slice(0, 10)}…</a> : String(v ?? "–")}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </main>
  );
}
