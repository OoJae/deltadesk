import { Button } from "@/components/brand/Button";
import { CONTAINER } from "@/components/brand/Container";
import { Label } from "@/components/brand/Label";
import { PageHeader } from "@/components/brand/PageHeader";
import { Stat } from "@/components/brand/Stat";
import { table, type Row } from "@/lib/api";
import { POOLS, num, usd } from "@/lib/format";

const n = (v: Row[string] | undefined) => (typeof v === "number" && Number.isFinite(v) ? v : null);

type PoolLine = { pool: string; swaps: number; vol: number; fees: number; picked: number; edge: number | null; reference: "Hyperliquid" | "Pool, 1 h later" };

/** The study's headline numbers, live from the engine API (same tables and the same reference rule as /study). */
async function load(): Promise<PoolLine[] | null> {
  const [m0, hl] = await Promise.all([table("m0", "by_pool"), table("hl_ref", "by_pool")]);
  if (!m0.ok) return null;
  const hlRows = hl.ok ? hl.data.rows : [];
  return POOLS.map((pool): PoolLine | null => {
    const m = m0.data.rows.find((r) => r.pool === pool);
    if (!m) return null;
    const h = hlRows.find((r) => r.pool === pool);
    const useHl = !!h && n(h.edge_hl_1h) != null;
    return {
      pool,
      swaps: n(m.swaps) ?? 0,
      vol: n(m.vol_usd) ?? 0,
      fees: n(useHl ? h!.fee_1h : m.fee_usd) ?? 0,
      picked: n(useHl ? h!.picked_hl_1h : m.picked_1h) ?? 0,
      edge: useHl ? n(h!.edge_hl_1h) : n(m.edge_1h),
      reference: useHl ? "Hyperliquid" : "Pool, 1 h later",
    };
  }).filter((p): p is PoolLine => p != null);
}

export async function TheBooks() {
  const pools = await load();
  const nvda = pools?.find((p) => p.pool === "NVDA/USDG") ?? null;
  const cents = nvda && nvda.fees > 0 ? Math.round((100 * nvda.picked) / nvda.fees) : null;

  return (
    <section aria-label="The books" className="border-t border-rule">
      <div className={`${CONTAINER} py-20 md:py-32`}>
        <div className="grid gap-12 lg:grid-cols-12 lg:gap-8">
          <div className="min-w-0 lg:col-span-5">
            <PageHeader
              as="h2"
              label="The books · Robinhood Chain"
              title="Where the fees went."
              italic="went"
              lede={
                <p>
                  Every swap in Robinhood Chain&apos;s four stock pools, split into the fee it paid liquidity providers and what its trader gained
                  against Hyperliquid&apos;s 24/7 price an hour later.
                  {cents != null ? (
                    <>
                      {" "}
                      On NVDA/USDG, informed traders took back about <span className="num text-paper">{cents}¢</span> of every fee dollar.
                    </>
                  ) : null}
                </p>
              }
              actions={
                <Button href="/study" variant="ghost" trailing="→">
                  Read the study
                </Button>
              }
            />
          </div>

          <div className="min-w-0 lg:col-span-7 lg:pt-2">
            {nvda ? (
              <>
                <div className="grid grid-cols-1 gap-x-6 gap-y-8 border-y border-rule py-8 sm:grid-cols-2 md:grid-cols-3">
                  <Stat size="lg" label="NVDA/USDG volume" value={usd(nvda.vol, 0)} caption={`${num(nvda.swaps)} swaps since the pool opened`} />
                  <Stat size="lg" label="Fees to LPs" value={usd(nvda.fees, 0)} caption="LP share only; protocol cut removed" />
                  <Stat
                    size="lg"
                    label="Taken by informed flow"
                    value={usd(nvda.picked, 0)}
                    caption="What takers gained on LPs, marked to Hyperliquid 1 h later"
                    className="sm:col-span-2 md:col-span-1"
                  />
                </div>
                {/* Phones drop the Volume column (NVDA's is the headline stat above), so the conclusion columns stay on screen. */}
                <div className="mt-8 overflow-x-auto overscroll-x-contain" data-lenis-prevent role="region" tabIndex={0} aria-label="Fees and value taken, per pool">
                  <table className="ledger-table sm:min-w-[36rem]">
                    <caption className="sr-only">Fees and value taken by informed flow, per pool</caption>
                    <thead>
                      <tr>
                        <th scope="col">Pool</th>
                        <th scope="col" className="n hidden sm:table-cell">
                          Volume
                        </th>
                        <th scope="col" className="n">
                          LP fees
                        </th>
                        <th scope="col" className="n">
                          Taken
                        </th>
                        <th scope="col" className="n">
                          Fees ÷ taken
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {pools!.map((p) => (
                        <tr key={p.pool}>
                          <th scope="row" className="font-mono text-[0.85rem] font-normal normal-case tracking-normal text-paper">
                            {p.pool}
                          </th>
                          <td className="n hidden sm:table-cell">{usd(p.vol, 1)}</td>
                          <td className="n">{usd(p.fees, 1)}</td>
                          <td className="n">{usd(p.picked, 1)}</td>
                          <td className="n">{p.edge == null ? "–" : p.edge.toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="mt-4 max-w-[62ch] text-sm leading-relaxed text-paper-mute">
                  Above 1.00, LPs kept more in fees than informed flow took. Taken = side × size × (reference price − execution price), against
                  Hyperliquid where it lists the stock, otherwise the pool&apos;s own price an hour later. Informational analytics, not investment advice.
                </p>
              </>
            ) : (
              <div className="border border-rule p-8">
                <Label as="p">The engine is recomputing</Label>
                <p className="mt-3 max-w-[48ch] text-paper-dim">
                  The study&apos;s numbers are refreshed every ten minutes and aren&apos;t reachable right now. The full study has the same books.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

export function TheBooksFallback() {
  return (
    <section aria-label="The books" className="border-t border-rule">
      <div className={`${CONTAINER} py-20 md:py-32`}>
        <Label as="p">The books · loading the study&apos;s numbers</Label>
        <div aria-hidden="true" className="mt-8 h-72 border border-rule hatch opacity-40" />
      </div>
    </section>
  );
}
