import FlowXray, { type FlowRow } from "@/components/FlowXray";
import StudyView, { type PoolStudy } from "@/components/StudyView";
import { api, table, type Row } from "@/lib/api";
import { POOLS, ratio, usd } from "@/lib/format";

type AeroSummary = {
  swaps: number; vol_usd: number; fees_gross_usd: number; fees_to_voters_usd: number; fees_to_lps_usd: number; emissions_aero: number;
  emissions_usd: number; picked_hl_1h_usd: number; edge_gross_hl_1h: number | null; edge_lp_income_hl_1h: number | null; first_utc: string; last_utc: string;
};

export const dynamic = "force-dynamic";

const n = (v: Row[string]) => (typeof v === "number" && Number.isFinite(v) ? v : null);

export default async function StudyPage() {
  const [hlPool, hlRegime, hlHow, m0Pool, m0Regime, m0How, flowLabel, flowConc] = await Promise.all([
    table("hl_ref", "by_pool"), table("hl_ref", "by_regime"), table("hl_ref", "by_how"),
    table("m0", "by_pool"), table("m0", "by_regime"), table("m0", "by_how"),
    table("flow", "by_label"), table("flow", "concentration"),
  ]);
  const aeroRes = await api<AeroSummary>("/study/aero");
  const aero = aeroRes.ok ? aeroRes.data : null;
  if (!m0Pool.ok) {
    return <main className="mx-auto max-w-5xl p-8 text-ink-2">The study is still being computed ({m0Pool.error}). Try again in a few minutes.</main>;
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

  const flow: FlowRow[] = rowsOf(flowLabel).map((r) => ({
    label: String(r.label), takers: n(r.takers) ?? 0, feeShare: n(r.fee_share) ?? 0, pickedShare: n(r.picked_pos_share_hl_1h) ?? 0,
    fees: n(r.fee_usd) ?? 0, pickedNet: n(r.picked_hl_1h) ?? 0, edge: n(r.edge_hl_1h),
  }));
  const ops = rowsOf(flowConc).find((r) => r.scope === "NVDA/USDG" && r.horizon === "1h" && r.level === "operator");
  const arb = flow.find((r) => r.label === "HL-arb");

  return (
    <main className="mx-auto w-full max-w-5xl space-y-8 px-4 py-10">
      <header className="space-y-4">
        <p className="text-xs font-medium uppercase tracking-wider text-muted">The Truth Study · Robinhood Chain · every swap since each pool opened</p>
        <h1 className="max-w-3xl text-3xl font-semibold leading-tight md:text-4xl">Can LPs beat informed flow on tokenized stocks?</h1>
        <div className="card flex flex-col gap-2 p-6 md:flex-row md:items-end md:gap-8">
          <div>
            <div className="text-5xl font-semibold md:text-6xl">{usd(nvda.picked, 0)}</div>
            <div className="mt-1 text-sm text-ink-2">
              taken back from NVDA/USDG liquidity providers by traders who knew where the price was going, out of {usd(nvda.fees, 0)} in LP fees
            </div>
          </div>
          <p className="text-sm text-ink-2 md:max-w-sm">
            For every $80 LPs earned, about ${Math.round((80 * nvda.picked) / Math.max(nvda.fees, 1))} was picked off within an hour. The edge is
            real but thin, and it concentrates in a few hours of the week.
          </p>
        </div>
        <p className="text-xs text-muted tabular">
          {totalSwaps.toLocaleString()} swaps · {usd(totalVol, 0)} volume across NVDA, SPY, TSLA and QQQ/SPY pools. Markouts against Hyperliquid
          trade.xyz 24/7 prices where available; otherwise against the pool&apos;s own price one hour later.
        </p>
      </header>

      <StudyView pools={pools} />

      {flow.length > 0 && (
        <section className="card space-y-5 p-5">
          <div className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-wider text-muted">Flow X-ray · who takes LP money</p>
            {ops && n(ops.top3_net) != null && (
              <h2 className="max-w-3xl text-xl font-semibold leading-snug">
                Three bot operators account for {((n(ops.top3_net) ?? 0) * 100).toFixed(1)}% of what NVDA/USDG LPs lose, on net, to informed flow.
                The other {((n(ops.n) ?? 0) - 3).toLocaleString()} traders together took {(100 - (n(ops.top3_net) ?? 0) * 100).toFixed(1)}%.
              </h2>
            )}
            {arb && (
              <p className="max-w-3xl text-sm text-ink-2">
                Bots that trade the pool toward Hyperliquid&apos;s 24/7 price pay {(arb.feeShare * 100).toFixed(0)}% of LP fees but take{" "}
                {(arb.pickedShare * 100).toFixed(0)}% of all value picked off: for every $1 of fees they pay, they take ${arb.edge ? (1 / arb.edge).toFixed(2) : "–"}.
                Retail and aggregator flow does the opposite: it pays fees and, on net, loses on price too.
              </p>
            )}
          </div>
          <FlowXray rows={flow} />
          <p className="text-xs text-muted">
            Every swap is joined to the wallet that sent it; bot wallets that share a private router contract are grouped as one operator. Labels are deterministic
            rules (Hyperliquid lead, 5-minute win rate, frequency), not a model. Net shares are on the pool&apos;s own price 1 hour later.
          </p>
        </section>
      )}

      {aero && (
        <section className="card space-y-5 p-5">
          <div className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-wider text-muted">Base · Aerodrome NVDAc/USDC</p>
            <h2 className="max-w-3xl text-xl font-semibold leading-snug">
              On Aerodrome, swap fees alone don&apos;t pay for informed flow. Emissions do.
            </h2>
            <p className="max-w-3xl text-sm text-ink-2">
              Staked liquidity gives its fees to veAERO voters and earns AERO instead, and most liquidity here is staked. Of {usd(aero.fees_gross_usd, 0)} in
              swap fees, {usd(aero.fees_to_voters_usd, 0)} ({Math.round((100 * aero.fees_to_voters_usd) / Math.max(aero.fees_gross_usd, 1))}%) went to voters.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {[
              { k: "Swap fees (all liquidity)", v: usd(aero.fees_gross_usd, 0), d: `${usd(aero.vol_usd, 0)} volume` },
              { k: "Picked off by informed flow", v: usd(aero.picked_hl_1h_usd, 0), d: "vs Hyperliquid, 1h" },
              { k: "Fees kept by LPs", v: usd(aero.fees_to_lps_usd, 0), d: "unstaked liquidity, after the 10% cut" },
              { k: "AERO emissions", v: usd(aero.emissions_usd, 0), d: `${Math.round(aero.emissions_aero).toLocaleString()} AERO at accrual prices` },
            ].map((x) => (
              <div key={x.k} className="rounded-lg bg-surface-2 p-3">
                <div className="text-xs text-muted">{x.k}</div>
                <div className="mt-1 text-2xl font-semibold tabular">{x.v}</div>
                <div className="text-xs text-ink-2">{x.d}</div>
              </div>
            ))}
          </div>
          <p className="text-sm text-ink-2 tabular">
            Edge (income ÷ value picked off): swap fees alone <strong className="text-ink">{ratio(aero.edge_gross_hl_1h)}</strong>; what LPs actually receive,
            fees kept plus emissions, <strong className="text-ink">{ratio(aero.edge_lp_income_hl_1h)}</strong>. Pool-level, {aero.first_utc.slice(0, 10)} → {aero.last_utc.slice(0, 10)}.
          </p>
        </section>
      )}

      <section className="grid gap-4 text-sm text-ink-2 md:grid-cols-2">
        <div className="card space-y-2 p-5">
          <h3 className="font-semibold text-ink">Method</h3>
          <p>Every swap is split into the LP fee it paid and what the taker gained against a reference price h later: picked off = side × size × (reference − execution price). Edge = fees ÷ picked off; above 1 LPs keep money.</p>
          <p>Fees are LP fees only: the NVDA pool&apos;s 25% protocol cut and the v4 pools&apos; protocol fees are removed. Swap-derived fees reconcile to the pool&apos;s own fee accounting within 0.3%.</p>
        </div>
        <div className="card space-y-2 p-5">
          <h3 className="font-semibold text-ink">Caveats</h3>
          <p>Pool-level results: an individual tight-range LP earns and loses more than the average. Hyperliquid&apos;s weekend price is its own internal price (US markets are closed), so weekend figures carry more reference uncertainty.</p>
          <p>Informational analytics, not investment advice.</p>
        </div>
      </section>
    </main>
  );
}
