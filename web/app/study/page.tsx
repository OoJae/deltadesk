import Link from "next/link";
import { Guilloche } from "@/components/brand/Guilloche";
import { Label } from "@/components/brand/Label";
import { PageHeader } from "@/components/brand/PageHeader";
import { Reveal } from "@/components/brand/Reveal";
import { Stat } from "@/components/brand/Stat";
import { DataSection, SectionHead } from "@/components/ledger/SectionHead";
import { LINK, Marginalia, N, Notice, PAGE } from "@/components/ledger/ui";
import FlowXray, { type FlowRow } from "@/components/FlowXray";
import StudyView, { type PoolStudy } from "@/components/StudyView";
import { api, table, type Row } from "@/lib/api";
import { POOLS, ratio, usd } from "@/lib/format";

type AeroSummary = {
  swaps: number; vol_usd: number; fees_gross_usd: number; fees_to_voters_usd: number; fees_to_lps_usd: number; emissions_aero: number;
  emissions_usd: number; picked_hl_1h_usd: number; edge_gross_hl_1h: number | null; edge_lp_income_hl_1h: number | null; first_utc: string; last_utc: string;
  aero_distributed?: number; aero_forfeited?: number; aero_received_usd?: number; lp_vs_hodl_usd?: number; positions?: number;
};

export const dynamic = "force-dynamic";
export const metadata = { title: "The Truth Study · DeltaDesk" };

const n = (v: Row[string]) => (typeof v === "number" && Number.isFinite(v) ? v : null);

// Row heads in the headline account read as prose, not as the ledger's mono column labels.
const ROW_HEAD = "border-rule font-body text-[0.95rem] font-normal normal-case tracking-normal";

const TITLE = "Can LPs beat informed flow on tokenized stocks?";

export default async function StudyPage() {
  const [hlPool, hlRegime, hlHow, m0Pool, m0Regime, m0How, flowLabel, flowConc] = await Promise.all([
    table("hl_ref", "by_pool"), table("hl_ref", "by_regime"), table("hl_ref", "by_how"),
    table("m0", "by_pool"), table("m0", "by_regime"), table("m0", "by_how"),
    table("flow", "by_label"), table("flow", "concentration"),
  ]);
  const aeroRes = await api<AeroSummary>("/study/aero");
  const aero = aeroRes.ok ? aeroRes.data : null;
  if (!m0Pool.ok) {
    return (
      <main className={PAGE}>
        <PageHeader label="The Truth Study · Robinhood Chain" title={TITLE} italic="informed flow" />
        <div className="mt-12 max-w-2xl">
          <Notice tone="warning">The study is still being computed ({m0Pool.error}). Try again in a few minutes.</Notice>
        </div>
      </main>
    );
  }
  const rowsOf = (r: typeof hlPool) => (r.ok ? r.data.rows : []);

  const pools: PoolStudy[] = POOLS.map((pool) => {
    const hl = rowsOf(hlPool).find((r) => r.pool === pool);
    const m0 = rowsOf(m0Pool).find((r) => r.pool === pool)!;
    const useHl = !!hl && n(hl.edge_hl_1h) != null;
    const regimes = (useHl ? rowsOf(hlRegime) : rowsOf(m0Regime))
      .filter((r) => r.pool === pool)
      .map((r) => ({
        regime: String(r.regime),
        hl: useHl ? n(r.lp_net_hl_bps_1h) : null,
        self: useHl ? n(r.lp_net_self_bps_1h) : n(r.lp_net_bps_1h),
        edgeHl: useHl ? n(r.edge_hl_1h) : null,
        edgeSelf: useHl ? n(r.edge_self_1h) : n(r.edge_1h),
        fees: n(useHl ? r.fee_1h : r.fee_usd) ?? 0,
        swaps: n(useHl ? r.n_1h : r.swaps) ?? 0,
      }));
    const hlHeat = rowsOf(hlHow).filter((r) => r.pool === pool);
    const heat =
      hlHeat.length > 0
        ? hlHeat.map((r) => {
            const fees = n(r.fee_1h) ?? 0, picked = n(r.picked_hl_1h) ?? 0, vol = n(r.vol_1h) ?? 0;
            return { how: Number(r.how), value: vol > 0 ? ((fees - picked) / vol) * 1e4 : null, fees, picked, edge: picked > 0 ? fees / picked : null, swaps: n(r.n_1h) ?? 0 };
          })
        : rowsOf(m0How).filter((r) => r.pool === pool).map((r) => ({
            how: Number(r.how), value: n(r.lp_net_bps_1h), fees: n(r.fee_usd) ?? 0, picked: n(r.picked_1h) ?? 0, edge: n(r.edge_1h), swaps: n(r.swaps) ?? 0,
          }));
    return {
      pool,
      swaps: n(m0.swaps) ?? 0,
      vol: n(m0.vol_usd) ?? 0,
      fees: n(useHl ? hl!.fee_1h : m0.fee_usd) ?? 0,
      picked: n(useHl ? hl!.picked_hl_1h : m0.picked_1h) ?? 0,
      edge: useHl ? n(hl!.edge_hl_1h) : n(m0.edge_1h),
      edgeSelf: useHl ? n(hl!.edge_self_1h) : n(m0.edge_1h),
      netBps: useHl ? n(hl!.lp_net_hl_bps_1h) : n(m0.lp_net_bps_1h),
      reference: useHl ? "hl" : "self",
      regimes,
      heat,
      heatReference: hlHeat.length > 0 ? "hl" : "self",
    };
  });

  const nvda = pools[0];
  const totalVol = pools.reduce((a, p) => a + p.vol, 0);
  const totalSwaps = pools.reduce((a, p) => a + p.swaps, 0);
  const per80 = Math.round((80 * nvda.picked) / Math.max(nvda.fees, 1));

  const flow: FlowRow[] = rowsOf(flowLabel).map((r) => ({
    label: String(r.label), takers: n(r.takers) ?? 0, feeShare: n(r.fee_share) ?? 0, pickedShare: n(r.picked_pos_share_hl_1h) ?? 0,
    fees: n(r.fee_usd) ?? 0, pickedNet: n(r.picked_hl_1h) ?? 0, edge: n(r.edge_hl_1h),
  }));
  const ops = rowsOf(flowConc).find((r) => r.scope === "NVDA/USDG" && r.horizon === "1h" && r.level === "operator");
  const arb = flow.find((r) => r.label === "HL-arb");
  const top3 = ops ? n(ops.top3_net) : null;

  return (
    <main className={PAGE}>
      <div className="grid gap-12 lg:grid-cols-12 lg:gap-x-8">
        <PageHeader
          className="lg:col-span-8"
          label="The Truth Study · Robinhood Chain · every swap since each pool opened"
          title={TITLE}
          italic="informed flow"
          lede={
            <p>
              Every swap is split into the fee it paid liquidity providers and what its taker gained against the price an hour later. Markouts are
              against Hyperliquid trade.xyz 24/7 prices where available; otherwise against the pool&apos;s own price one hour later.
            </p>
          }
        />
        <Marginalia
          className="lg:col-span-3 lg:col-start-10 lg:self-end"
          items={[
            { k: "Swaps", v: <N>{totalSwaps.toLocaleString()}</N> },
            { k: "Volume", v: <N>{usd(totalVol, 0)}</N> },
            { k: "Pools", v: "NVDA, SPY, TSLA, QQQ/SPY" },
            { k: "Horizon", v: "1 hour markout" },
          ]}
        />
      </div>

      {/* The headline: one number, in its own engraved frame. */}
      <section data-demo="study-headline" aria-labelledby="study-headline" className="relative mt-16 md:mt-24">
        <Guilloche variant="border" width={12} opacity={0.4} />
        <div className="grid gap-12 px-7 py-10 md:px-14 md:py-16 lg:grid-cols-12 lg:gap-x-8">
          <div className="lg:col-span-7">
            <Label as="h2" id="study-headline">Picked off · NVDA/USDG · within an hour of the swap</Label>
            <Reveal mode="block">
              <p data-demo="study-picked" className="mt-5 font-mono text-[clamp(3.75rem,10.5vw,9.5rem)] leading-[0.9] tracking-[-0.045em] text-paper">{usd(nvda.picked, 0)}</p>
            </Reveal>
            <p className="mt-6 max-w-[44ch] text-body text-paper-dim">
              taken back from NVDA/USDG liquidity providers by traders who knew where the price was going, out of <N>{usd(nvda.fees, 0)}</N> in LP fees.
            </p>
          </div>
          <div className="flex flex-col justify-end gap-8 lg:col-span-5">
            <table className="ledger-table text-sm">
              <caption className="sr-only">NVDA/USDG liquidity providers&apos; account, 1 hour markout</caption>
              <tbody>
                <tr>
                  <th scope="row" className={`${ROW_HEAD} text-paper-dim`}>LP fees earned</th>
                  <td className="n whitespace-nowrap text-paper">{usd(nvda.fees)}</td>
                </tr>
                <tr>
                  <th scope="row" className={`${ROW_HEAD} text-paper-dim`}>Picked off by informed flow</th>
                  <td className="n whitespace-nowrap text-paper">{usd(-nvda.picked)}</td>
                </tr>
                <tr className="[&>*]:border-b-[3px] [&>*]:border-double [&>*]:border-rule-strong">
                  <th scope="row" className={`${ROW_HEAD} text-paper`}>Left with LPs</th>
                  <td className="n whitespace-nowrap font-medium text-paper">{usd(nvda.fees - nvda.picked)}</td>
                </tr>
              </tbody>
            </table>
            <p className="text-body text-paper-dim">
              For every <N>$80</N> LPs earned, about <N>${per80}</N> was picked off within an hour. The edge is real but thin, and it concentrates in a few
              hours of the week.
            </p>
          </div>
        </div>
      </section>

      <DataSection labelledBy="study-pools">
        <SectionHead
          id="study-pools"
          label="Pool by pool · edge = fees ÷ value picked off"
          title="The edge is real, but thin."
          italic="thin"
          lede={<p>Above 1, LPs keep money. Choose a pool to see what its liquidity keeps in each market regime and in each hour of the week.</p>}
        />
        <div className="mt-12 md:mt-16">
          <StudyView pools={pools} />
        </div>
      </DataSection>

      {flow.length > 0 && (
        <DataSection labelledBy="study-flow">
          <SectionHead
            id="study-flow"
            label="Flow X-ray · who takes LP money"
            title={top3 != null && top3 >= 0.8 ? "A few bots take almost all of it." : "Who takes the LP money."}
            italic={top3 != null && top3 >= 0.8 ? "almost all" : "LP money"}
            lede={
              <>
                {ops && top3 != null && (
                  <p data-demo="flow-top3" className="text-paper">
                    Three bot operators account for <N>{(top3 * 100).toFixed(1)}%</N> of what NVDA/USDG LPs lose, on net, to informed flow. The other{" "}
                    <N>{((n(ops.n) ?? 0) - 3).toLocaleString()}</N> traders together took <N>{(100 - top3 * 100).toFixed(1)}%</N>.
                  </p>
                )}
                {arb && (
                  <p>
                    Bots that trade the pool toward Hyperliquid&apos;s 24/7 price pay <N>{(arb.feeShare * 100).toFixed(0)}%</N> of LP fees but take{" "}
                    <N>{(arb.pickedShare * 100).toFixed(0)}%</N> of all value picked off: for every <N>$1</N> of fees they pay, they take{" "}
                    <N>${arb.edge ? (1 / arb.edge).toFixed(2) : "–"}</N>. Retail and aggregator flow does the opposite: it pays fees and, on net, loses on price too.
                  </p>
                )}
              </>
            }
          />
          <div data-demo="flow-xray" className="mt-12 border border-rule bg-vault-2 px-5 py-6 md:mt-16 md:px-8 md:py-8">
            <FlowXray rows={flow} />
          </div>
          <p className="mt-5 max-w-[80ch] text-sm leading-relaxed text-paper-mute">
            Every swap is joined to the wallet that sent it; bot wallets that share a private router contract are grouped as one operator. Labels are
            deterministic rules (Hyperliquid lead, 5-minute win rate, frequency), not a model. Net shares are on the pool&apos;s own price 1 hour later.
          </p>
        </DataSection>
      )}

      {aero && (
        <DataSection labelledBy="study-aero">
          <SectionHead
            id="study-aero"
            label="Base · Aerodrome NVDAc/USDC"
            title="On Aerodrome, swap fees alone don't pay for informed flow. Emissions do."
            italic="Emissions do."
            lede={
              <p>
                Staked liquidity gives its fees to veAERO voters and earns AERO instead, and most liquidity here is staked. Of <N>{usd(aero.fees_gross_usd, 0)}</N>{" "}
                in swap fees, <N>{usd(aero.fees_to_voters_usd, 0)}</N> (<N>{Math.round((100 * aero.fees_to_voters_usd) / Math.max(aero.fees_gross_usd, 1))}%</N>) went to
                voters.
              </p>
            }
          />
          <div className="mt-12 grid grid-cols-1 gap-px border border-rule bg-rule sm:grid-cols-2 md:mt-16 lg:grid-cols-4">
            {[
              { k: "Swap fees (all liquidity)", v: usd(aero.fees_gross_usd, 0), d: `${usd(aero.vol_usd, 0)} volume` },
              { k: "Picked off by informed flow", v: usd(aero.picked_hl_1h_usd, 0), d: "vs Hyperliquid, 1h" },
              { k: "Fees kept by LPs", v: usd(aero.fees_to_lps_usd, 0), d: "unstaked liquidity, after the 10% cut" },
              aero.aero_received_usd != null
                ? {
                    k: "AERO received by LPs",
                    v: usd(aero.aero_received_usd, 0),
                    d: `${Math.round(aero.aero_distributed ?? 0).toLocaleString()} AERO paid, ${Math.round(aero.aero_forfeited ?? 0).toLocaleString()} forfeited by exits < 5 min`,
                  }
                : { k: "AERO emissions", v: usd(aero.emissions_usd, 0), d: `${Math.round(aero.emissions_aero).toLocaleString()} AERO at accrual prices` },
            ].map((x) => (
              <div key={x.k} className="bg-vault-2 px-5 py-6 md:px-6 md:py-7">
                <Stat label={x.k} value={x.v} caption={x.d} size="lg" />
              </div>
            ))}
          </div>
          <p className="mt-6 max-w-[80ch] text-body text-paper-dim">
            Edge (income ÷ value picked off): swap fees alone <N>{ratio(aero.edge_gross_hl_1h)}</N>; what LPs actually receive, fees kept plus AERO
            received, <N>{ratio(aero.edge_lp_income_hl_1h)}</N>.
            {aero.lp_vs_hodl_usd != null && (
              <>
                {" "}Across <N>{aero.positions?.toLocaleString()}</N> positions, LPs ended <N>{usd(aero.lp_vs_hodl_usd, 0)}</N> vs simply holding.
              </>
            )}{" "}
            <span className="num text-paper-mute">
              {aero.first_utc.slice(0, 10)} → {aero.last_utc.slice(0, 10)}
            </span>
            .
          </p>
          <p className="mt-3 text-sm text-paper-mute">
            Check a Base wallet on the{" "}
            <Link className={LINK} href="/tearsheet?chain=base">
              Aerodrome tearsheet
            </Link>
            .
          </p>
        </DataSection>
      )}

      <DataSection labelledBy="study-notes">
        <h2 id="study-notes" className="sr-only">
          Method and caveats
        </h2>
        <div className="grid gap-12 md:grid-cols-2 md:gap-x-8 lg:grid-cols-12">
          <div className="space-y-4 lg:col-span-5">
            <Label as="h3" tone="dim">Method</Label>
            <div className="space-y-3 text-[0.95rem] leading-relaxed text-paper-dim">
              <p>
                Every swap is split into the LP fee it paid and what the taker gained against a reference price h later: picked off = side × size ×
                (reference − execution price). Edge = fees ÷ picked off; above 1 LPs keep money.
              </p>
              <p>
                Fees are LP fees only: the NVDA pool&apos;s 25% protocol cut and the v4 pools&apos; protocol fees are removed. Swap-derived fees reconcile
                to the pool&apos;s own fee accounting within 0.3%.
              </p>
            </div>
          </div>
          <div className="space-y-4 lg:col-span-5 lg:col-start-8">
            <Label as="h3" tone="dim">Caveats</Label>
            <div className="space-y-3 text-[0.95rem] leading-relaxed text-paper-dim">
              <p>
                Pool-level results: an individual tight-range LP earns and loses more than the average. Hyperliquid&apos;s weekend price is its own
                internal price (US markets are closed), so weekend figures carry more reference uncertainty.
              </p>
              <p className="text-paper">Informational analytics, not investment advice.</p>
            </div>
          </div>
        </div>
      </DataSection>
    </main>
  );
}
