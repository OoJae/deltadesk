import { api, type Row } from "@/lib/api";
import { ratio, usd } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "LP League · DeltaDesk" };

type League = { count: number; method: string; rows: Row[] };

const num = (v: Row[string]) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const perK = (v: Row[string]) => {
  const x = num(v);
  return x == null ? "–" : `${x < 0 ? "−" : "+"}$${Math.abs(x).toFixed(2)}`;
};

export default async function LeaguePage() {
  const res = await api<League>("/lp-league?limit=100", { premium: true });
  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 px-4 py-10">
      <header className="space-y-2">
        <p className="text-xs font-medium uppercase tracking-wider text-muted">LP League</p>
        <h1 className="text-3xl font-semibold">Who actually makes money making markets?</h1>
        <p className="max-w-2xl text-sm text-ink-2">
          Every wallet that managed liquidity in Robinhood Chain&apos;s stock pools, ranked by how much better its liquidity did than simply holding
          the same tokens, per $1k of capital per day. That strips out stock-price moves and leaves market-making skill: fees earned minus what
          informed flow picked off.
        </p>
      </header>
      {!res.ok ? (
        <p className="text-sm text-ink-2">{res.status === 503 ? "The League is still being computed. Try again shortly." : `Couldn't load: ${res.error}`}</p>
      ) : (
        <>
          <p className="text-xs text-muted tabular">{res.data.count.toLocaleString()} qualifying managers (≥ $1.5k·days of capital over ≥ 3 days). Top 100 shown.</p>
          <section className="card overflow-x-auto p-2">
            <table className="w-full min-w-[760px] text-xs tabular">
              <thead className="text-muted">
                <tr>
                  <th className="p-2 text-left">#</th>
                  <th className="p-2 text-left">Manager</th>
                  <th className="p-2 text-left">Pools</th>
                  <th className="p-2 text-right" title="LP value vs holding, per $1k of capital per day">vs holding / $1k·day</th>
                  <th className="p-2 text-right">Fees / $1k·day</th>
                  <th className="p-2 text-right">Picked off / $1k·day</th>
                  <th className="p-2 text-right">Edge</th>
                  <th className="p-2 text-right">Range width</th>
                  <th className="p-2 text-right">Positions</th>
                  <th className="p-2 text-right">Capital·days</th>
                </tr>
              </thead>
              <tbody>
                {res.data.rows.map((r) => (
                  <tr key={String(r.manager)} className="border-t border-grid">
                    <td className="p-2 text-muted">{String(r.rank)}</td>
                    <td className="p-2">
                      <a className="font-mono text-[var(--accent)] hover:underline" href={`/tearsheet?wallet=${r.manager}`}>{String(r.manager).slice(0, 10)}…</a>
                    </td>
                    <td className="p-2 text-ink-2">{String(r.pools).replaceAll("/USDG", "")}</td>
                    <td className="p-2 text-right font-semibold">{perK(r.vs_hodl_per_1k_day)}</td>
                    <td className="p-2 text-right">{perK(r.fees_per_1k_day)}</td>
                    <td className="p-2 text-right">{num(r.picked_off_per_1k_day) == null ? "–" : `$${(num(r.picked_off_per_1k_day) ?? 0).toFixed(2)}`}</td>
                    <td className="p-2 text-right">{ratio(num(r.edge_hl))}</td>
                    <td className="p-2 text-right">{num(r.median_width_ticks) != null ? `${((num(r.median_width_ticks) ?? 0) / 100).toFixed(1)}%` : "–"}</td>
                    <td className="p-2 text-right">{String(r.positions)}</td>
                    <td className="p-2 text-right">{usd(num(r.capital_days_usd), 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <p className="text-xs text-muted">Edge = fees ÷ value picked off (vs Hyperliquid, 1h). Range width ≈ ticks/100 as a percent of price. Very tight, high-turnover ranges earn and lose the most per dollar.</p>
        </>
      )}
    </main>
  );
}
