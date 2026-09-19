import Link from "next/link";
import { Label } from "@/components/brand/Label";
import { LedgerPanel } from "@/components/brand/LedgerPanel";
import { PageHeader } from "@/components/brand/PageHeader";
import { LINK, Marginalia, N, Notice, PAGE, ScrollX } from "@/components/ledger/ui";
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
const tearsheet = (manager: Row[string]) => `/tearsheet?wallet=${manager}&as=operator`;
const width = (v: Row[string]) => (num(v) != null ? `${((num(v) ?? 0) / 100).toFixed(1)}%` : "–");

const COLS: { h: string; n?: boolean; title?: string }[] = [
  { h: "#" },
  { h: "Manager" },
  { h: "Pools" },
  { h: "vs holding / $1k·day", n: true, title: "LP value vs holding, per $1k of capital per day" },
  { h: "Fees / $1k·day", n: true },
  { h: "Picked off / $1k·day", n: true },
  { h: "Edge", n: true },
  { h: "Range width", n: true },
  { h: "Positions", n: true },
  { h: "Capital·days", n: true },
];

export default async function LeaguePage() {
  const res = await api<League>("/lp-league?limit=100", { premium: true });
  const top = res.ok ? res.data.rows.slice(0, 3) : [];
  return (
    <main className={PAGE}>
      <div className="grid gap-12 lg:grid-cols-12 lg:gap-x-8">
        <PageHeader
          className="lg:col-span-8"
          label="LP League · Robinhood Chain"
          title="Who actually makes money making markets?"
          italic="making markets"
          lede={
            <p>
              Every wallet that managed liquidity in Robinhood Chain&apos;s stock pools, ranked by how much better its liquidity did than simply holding the
              same tokens, per $1k of capital per day. That strips out stock-price moves and leaves market-making skill: fees earned minus what informed flow
              picked off.
            </p>
          }
        />
        <Marginalia
          className="lg:col-span-3 lg:col-start-10 lg:self-end"
          items={[
            { k: "Managers", v: res.ok ? <N>{res.data.count.toLocaleString()}</N> : "–" },
            { k: "Score", v: "vs holding, per $1k·day" },
            { k: "Qualifies", v: <span className="num">≥ $1.5k·days, ≥ 3 days</span> },
          ]}
        />
      </div>

      {!res.ok ? (
        <div className="mt-14 max-w-2xl">
          <Notice tone="warning">{res.status === 503 ? "The League is still being computed. Try again shortly." : `Couldn't load: ${res.error}`}</Notice>
        </div>
      ) : (
        <>
          {top.length > 0 && (
            <section aria-labelledby="league-top" className="mt-16 md:mt-24">
              <Label as="h2" id="league-top" className="mb-5">
                The top of the table
              </Label>
              <ol data-demo="league-top" className="grid gap-px border border-rule bg-rule md:grid-cols-3">
                {top.map((r) => (
                  <li key={String(r.manager)} className="flex flex-col gap-6 bg-vault-2 px-5 py-6 md:px-7 md:py-8">
                    <div className="flex items-baseline justify-between gap-4">
                      <span className="font-mono text-[0.78rem] text-paper-mute">#{String(r.rank)}</span>
                      <Link className={`${LINK} font-mono text-[0.85rem]`} href={tearsheet(r.manager)}>
                        {String(r.manager).slice(0, 10)}…{String(r.manager).slice(-4)}
                      </Link>
                    </div>
                    <div className="space-y-2">
                      <p data-demo="league-result" className="font-mono text-[clamp(2.25rem,4vw,3.5rem)] leading-none tracking-[-0.035em] text-paper">{perK(r.vs_hodl_per_1k_day)}</p>
                      <p className="text-xs text-paper-dim">vs holding, per $1k of capital per day</p>
                    </div>
                    <dl className="grid grid-cols-3 gap-3 border-t border-rule pt-4">
                      <div className="space-y-1">
                        <Label as="dt">Edge</Label>
                        <dd className="font-mono text-sm text-paper tabular">{ratio(num(r.edge_hl))}</dd>
                      </div>
                      <div className="space-y-1">
                        <Label as="dt">Width</Label>
                        <dd className="font-mono text-sm text-paper tabular">{width(r.median_width_ticks)}</dd>
                      </div>
                      <div className="space-y-1">
                        <Label as="dt">Pools</Label>
                        <dd className="font-mono text-sm text-paper">{String(r.pools).replaceAll("/USDG", "")}</dd>
                      </div>
                    </dl>
                  </li>
                ))}
              </ol>
            </section>
          )}

          <LedgerPanel
            className="mt-12 md:mt-16"
            label={`Top ${res.data.rows.length} of ${res.data.count.toLocaleString()} qualifying managers`}
            title="The full table"
            inset={false}
            actions={<span className="hidden font-mono text-[0.7rem] text-paper-mute md:inline">≥ $1.5k·days of capital over ≥ 3 days</span>}
          >
            <ScrollX label="LP League table">
              <table data-demo="league-table" className="ledger-table min-w-[64rem] text-xs">
                <thead>
                  <tr>
                    {COLS.map((c, i) => (
                      <th key={c.h} scope="col" title={c.title} className={[c.n ? "n" : "", i === 0 ? "pl-5 md:pl-6" : "", i === COLS.length - 1 ? "pr-5 md:pr-6" : ""].join(" ")}>
                        {c.h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {res.data.rows.map((r) => (
                    <tr key={String(r.manager)}>
                      <td className="pl-5 font-mono text-paper-mute md:pl-6">{String(r.rank)}</td>
                      <td>
                        <Link className={`${LINK} font-mono`} href={tearsheet(r.manager)}>
                          {String(r.manager).slice(0, 10)}…
                        </Link>
                      </td>
                      <td className="whitespace-nowrap text-paper-dim">{String(r.pools).replaceAll("/USDG", "")}</td>
                      <td className="n font-medium text-paper">{perK(r.vs_hodl_per_1k_day)}</td>
                      <td className="n">{perK(r.fees_per_1k_day)}</td>
                      <td className="n">{num(r.picked_off_per_1k_day) == null ? "–" : `$${(num(r.picked_off_per_1k_day) ?? 0).toFixed(2)}`}</td>
                      <td className="n">{ratio(num(r.edge_hl))}</td>
                      <td className="n">{width(r.median_width_ticks)}</td>
                      <td className="n">{String(r.positions)}</td>
                      <td className="n pr-5 md:pr-6">{usd(num(r.capital_days_usd), 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollX>
          </LedgerPanel>
          <p className="mt-5 max-w-[90ch] text-xs leading-relaxed text-paper-mute">
            Edge = fees ÷ value picked off (vs Hyperliquid, 1h). Range width ≈ ticks/100 as a percent of price. Very tight, high-turnover ranges earn and lose
            the most per dollar. Open any manager for its full tearsheet. Informational analytics, not investment advice.
          </p>
        </>
      )}
    </main>
  );
}
