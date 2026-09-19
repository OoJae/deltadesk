import { api } from "@/lib/api";
import { REGIME_LABEL, ratio, usd } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "LP tearsheet · DeltaDesk" };

type Num = number | null;
type Summary = {
  n_positions: number; n_open: number; pools: string[]; first_utc: string; last_utc: string; active_days: number; avg_notional_usd: number;
  fees_usd: number; lvr_self_1h_usd: number; lvr_hl_1h_usd: number; edge_self_1h: Num; edge_hl_1h: Num; il_usd: number; price_pnl_usd: number;
  gas_usd: number; net_usd: number; vs_hodl_usd: number;
  residual: { reconciled_positions: number; residual_usd: Num; max_abs_residual_bp: Num };
  per_1k: Record<string, number>;
  aerodrome?: { aero_earned: number; aero_forfeited: number; aero_usd: number; fees_gross_usd: number; fees_to_voters_usd: number;
                staked_share: Num; early_withdrawals: number; edge_hl_1h_incl_aero: Num };
  flags: { jit_positions: number; weekend_share: Num; in_range_share: Num; median_width_ticks: number; rebalances_per_day: number };
};
type Tearsheet = {
  owner: string; role: string; chain?: string; match: { as_owner: number; as_operator: number }; summary: Summary | null;
  by_regime: { regime: string; fees_usd: number; lvr_hl_1h_usd?: number; picked_hl_1h?: number; edge_hl_1h?: Num }[];
  positions: Record<string, unknown>[];
};

const signed = (x: number) => `${x < 0 ? "−" : "+"}${usd(Math.abs(x), 2).replace("−", "")}`;

const CHAINS = [
  { id: "robinhood", label: "Robinhood Chain", pools: "NVDA, SPY, TSLA or QQQ/SPY pools" },
  { id: "base", label: "Base · Aerodrome", pools: "the Aerodrome NVDAc/USDC pool" },
] as const;

export default async function TearsheetPage({ searchParams }: { searchParams: Promise<{ wallet?: string; as?: string; chain?: string }> }) {
  const sp = await searchParams;
  const wallet = (sp.wallet ?? "").trim().toLowerCase();
  const role = ["owner", "operator"].includes(sp.as ?? "") ? sp.as! : "auto";
  const chain = CHAINS.find((c) => c.id === sp.chain) ?? CHAINS[0];
  const valid = /^0x[0-9a-f]{40}$/.test(wallet);
  const res = valid ? await api<Tearsheet>(`/tearsheet/${chain.id}/${wallet}?role=${role}`, { premium: true }) : null;
  const t = res?.ok ? res.data : null;
  const s = t?.summary ?? null;
  const ae = s?.aerodrome;
  const href = (c: string) => `/tearsheet?chain=${c}${wallet ? `&wallet=${wallet}` : ""}${role !== "auto" ? `&as=${role}` : ""}`;

  const lines = s
    ? [
        { k: ae ? "Fees earned (kept by you)" : "Fees earned", v: s.fees_usd, p: s.per_1k.fees, strong: false },
        ...(ae ? [{ k: "AERO emissions received", v: ae.aero_usd, p: s.per_1k.aero ?? 0, strong: false }] : []),
        { k: "Picked off by informed flow (vs Hyperliquid, 1h)", v: -s.lvr_hl_1h_usd, p: -s.per_1k.lvr_hl_1h, strong: false },
        { k: "Impermanent loss vs holding (includes the above)", v: s.il_usd, p: s.per_1k.il, strong: false },
        { k: "Gas", v: -s.gas_usd, p: -s.per_1k.gas, strong: false },
        { k: "Result vs simply holding the tokens", v: s.vs_hodl_usd, p: s.per_1k.vs_hodl, strong: true },
        { k: "Stock price P&L (market exposure)", v: s.price_pnl_usd, p: s.per_1k.price_pnl, strong: false },
        { k: "Net", v: s.net_usd, p: s.per_1k.net, strong: true },
      ]
    : [];

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 px-4 py-10">
      <header className="space-y-2">
        <p className="text-xs font-medium uppercase tracking-wider text-muted">LP tearsheet</p>
        <h1 className="text-3xl font-semibold">What did your liquidity actually earn?</h1>
        <p className="max-w-2xl text-sm text-ink-2">Fees, AERO emissions, value picked off by informed flow, impermanent loss vs holding, price P&amp;L and gas for tokenized-stock LPs on Robinhood Chain (Uniswap) and Base (Aerodrome), reconciled against what was actually collected on-chain.</p>
      </header>
      <nav className="flex gap-2 text-sm" aria-label="Chain">
        {CHAINS.map((c) => (
          <a key={c.id} href={href(c.id)} aria-current={c.id === chain.id ? "page" : undefined}
             className={`rounded-lg px-3 py-1.5 ${c.id === chain.id ? "bg-[var(--accent)] text-white" : "bg-surface-2 text-ink-2 hover:text-ink"}`}>{c.label}</a>
        ))}
      </nav>
      <form className="card flex gap-2 p-3" action="/tearsheet">
        <input name="wallet" defaultValue={wallet} placeholder={`0x… LP wallet on ${chain.label}`} className="w-full rounded-lg bg-surface-2 px-3 py-2 font-mono text-sm outline-none focus:ring-2 focus:ring-[var(--accent)]" />
        <input type="hidden" name="chain" value={chain.id} />
        {role !== "auto" && <input type="hidden" name="as" value={role} />}
        <button className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white">Analyze</button>
      </form>
      {wallet && !valid && <p className="text-sm text-ink-2">That isn&apos;t a 0x wallet address.</p>}
      {res && !res.ok && <p className="text-sm text-ink-2">{res.status === 503 ? "Tearsheets are still being computed. Try again shortly." : `Couldn't load: ${res.error}`}</p>}
      {t && !s && <p className="text-sm text-ink-2">No LP positions found for this wallet in {chain.pools}.</p>}

      {t && s && (
        <>
          <section className="card grid gap-6 p-6 md:grid-cols-[1fr_1.4fr]">
            <div className="space-y-3">
              <div className="font-mono text-xs text-muted">{t.owner}</div>
              <div>
                <div className={`text-5xl font-semibold ${s.vs_hodl_usd >= 0 ? "" : ""}`}>{signed(s.vs_hodl_usd)}</div>
                <div className="mt-1 text-sm text-ink-2">vs simply holding the same tokens</div>
              </div>
              <dl className="grid grid-cols-2 gap-3 text-xs">
                <div><dt className="text-muted">{ae ? "Edge incl. AERO" : "LP edge vs HL"}</dt><dd className="text-lg font-semibold">{ratio(ae ? ae.edge_hl_1h_incl_aero : s.edge_hl_1h)}</dd></div>
                <div><dt className="text-muted">Positions</dt><dd className="text-lg font-semibold">{s.n_positions}{s.n_open ? ` (${s.n_open} open)` : ""}</dd></div>
                <div><dt className="text-muted">Avg notional</dt><dd className="text-lg font-semibold">{usd(s.avg_notional_usd, 0)}</dd></div>
                <div><dt className="text-muted">Median range</dt><dd className="text-lg font-semibold">{(s.flags.median_width_ticks / 100).toFixed(1)}%</dd></div>
              </dl>
              <p className="text-xs text-muted">
                Viewed as {t.role} ({t.match.as_owner} positions owned, {t.match.as_operator} managed) · {s.pools.join(", ")} ·{" "}
                {s.first_utc.slice(0, 10)} → {s.last_utc.slice(0, 10)}
              </p>
            </div>
            <table className="w-full self-start text-sm tabular">
              <thead className="text-xs text-muted"><tr><th className="pb-2 text-left font-normal">Line</th><th className="pb-2 text-right font-normal">USD</th><th className="pb-2 text-right font-normal">per $1k</th></tr></thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.k} className={`border-t border-grid ${l.strong ? "font-semibold" : "text-ink-2"}`}>
                    <td className="py-2 pr-2">{l.k}</td><td className="py-2 text-right">{signed(l.v)}</td><td className="py-2 text-right">{signed(l.p)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {ae && (
              <p className="text-xs text-ink-2 md:col-span-2">
                Staked in the Aerodrome gauge {ae.staked_share != null ? `${(ae.staked_share * 100).toFixed(0)}%` : "–"} of the time. Staked liquidity earns AERO
                instead of fees: {usd(ae.fees_to_voters_usd)} of this wallet&apos;s {usd(ae.fees_gross_usd)} fee share went to veAERO voters.
                {ae.aero_forfeited > 0 && <> Withdrawing within 5 minutes of staking forfeits the reward: {ae.aero_forfeited.toFixed(1)} AERO forfeited over {ae.early_withdrawals} early withdrawals.</>}
              </p>
            )}
          </section>

          <section className="grid gap-4 md:grid-cols-2">
            <div className="card p-5 text-sm">
              <h2 className="mb-3 font-semibold">By market regime</h2>
              <table className="w-full text-xs tabular">
                <thead className="text-muted"><tr><th className="pb-1 text-left font-normal">Regime</th><th className="pb-1 text-right font-normal">Fees</th><th className="pb-1 text-right font-normal">Picked off (HL)</th><th className="pb-1 text-right font-normal">Edge</th></tr></thead>
                <tbody>
                  {t.by_regime.map((r) => {
                    const picked = (r.lvr_hl_1h_usd ?? r.picked_hl_1h ?? 0) as number;
                    return (
                      <tr key={r.regime} className="border-t border-grid">
                        <td className="py-1.5">{REGIME_LABEL[r.regime] ?? r.regime}</td><td className="py-1.5 text-right">{usd(r.fees_usd)}</td>
                        <td className="py-1.5 text-right">{usd(picked)}</td><td className="py-1.5 text-right">{picked > 0 ? ratio(r.fees_usd / picked) : "–"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="card space-y-2 p-5 text-sm text-ink-2">
              <h2 className="font-semibold text-ink">Reconciliation</h2>
              {s.residual.reconciled_positions > 0 ? (
                <p>
                  {s.residual.reconciled_positions} fully collected positions reconcile to the fees actually collected on-chain within{" "}
                  <strong className="text-ink">{(s.residual.max_abs_residual_bp ?? 0).toFixed(4)} bp</strong> of notional (total difference {usd(s.residual.residual_usd ?? 0, 4)}).
                </p>
              ) : (
                <p>No fully collected closed v3 positions to reconcile (v4 settles fees inside liquidity changes, with no fee event).</p>
              )}
              <p className="text-xs text-muted">Weekend share of capital {s.flags.weekend_share != null ? `${(s.flags.weekend_share * 100).toFixed(0)}%` : "–"} · in range {s.flags.in_range_share != null ? `${(s.flags.in_range_share * 100).toFixed(0)}%` : "–"} · {s.flags.rebalances_per_day.toFixed(1)} re-ranges/day · JIT positions {s.flags.jit_positions}</p>
            </div>
          </section>

          {t.positions.length > 0 && (
            <section className="card overflow-x-auto p-2">
              <table className="w-full min-w-[720px] text-xs tabular">
                <thead className="text-muted"><tr>{["Position", "Status", "Width", "Notional", "Fees", "Picked off (HL)", "IL", "Net", "Residual"].map((h) => <th key={h} className="p-2 text-left font-normal">{h}</th>)}</tr></thead>
                <tbody>
                  {t.positions.slice(0, 100).map((p, i) => (
                    <tr key={i} className="border-t border-grid">
                      <td className="p-2 font-mono">{String(p.pos_id ?? p.position ?? "")}</td>
                      <td className="p-2">{String(p.status ?? "–")}</td>
                      <td className="p-2">{String(p.width_ticks ?? "–")}</td>
                      <td className="p-2">{usd(Number(p.avg_notional_usd ?? 0), 0)}</td>
                      <td className="p-2">{usd(Number(p.fees_usd ?? 0))}</td>
                      <td className="p-2">{usd(Number(p.lvr_hl_1h_usd ?? 0))}</td>
                      <td className="p-2">{usd(Number(p.il_usd ?? 0))}</td>
                      <td className="p-2">{usd(Number(p.net_usd ?? 0))}</td>
                      <td className="p-2">{p.residual_bp != null ? `${Number(p.residual_bp).toFixed(3)} bp` : "–"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
          {t.positions.length > 0 && (
            <p className="text-xs text-muted">Picked off = what informed takers gained against this liquidity, marked to Hyperliquid 1h later. Negative means takers lost to this position. Residual = on-chain collected fees − attributed fees (only for fully collected v3 positions).</p>
          )}
        </>
      )}
    </main>
  );
}
