import Link from "next/link";
import { Button } from "@/components/brand/Button";
import { Label } from "@/components/brand/Label";
import { LedgerPanel } from "@/components/brand/LedgerPanel";
import { PageHeader } from "@/components/brand/PageHeader";
import { Stat } from "@/components/brand/Stat";
import { LINK, Marginalia, N, Notice, PAGE, ScrollX } from "@/components/ledger/ui";
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
  { id: "robinhood", label: "Robinhood Chain", sub: "Uniswap v3 / v4", pools: "NVDA, SPY, TSLA or QQQ/SPY pools" },
  { id: "base", label: "Base · Aerodrome", sub: "NVDAc/USDC", pools: "the Aerodrome NVDAc/USDC pool" },
] as const;

// The statement's lines, explained. Result vs holding = fees (+ AERO) + impermanent loss − gas; net adds the price P&L.
const SPECIMEN = [
  { k: "Fees earned", d: "LP fees your positions earned, with protocol cuts removed." },
  { k: "AERO emissions received", d: "Base only: gauge rewards for staked liquidity, which gives its fees to veAERO voters instead." },
  { k: "Picked off by informed flow", d: "What takers gained against your liquidity, marked to Hyperliquid's price one hour later." },
  { k: "Impermanent loss vs holding", d: "Your LP value against simply holding the tokens you deposited. It includes the value picked off." },
  { k: "Gas", d: "What your LP transactions cost to send." },
  { k: "Result vs simply holding", d: "Fees and AERO, less impermanent loss and gas: the market-making result, with stock moves stripped out." },
  { k: "Stock price P&L", d: "What the tokens' price moves did to you; holding them would have done the same." },
  { k: "Net", d: "Everything together, in dollars and per $1k of capital." },
];

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
    <main className={PAGE}>
      <div className="grid gap-12 lg:grid-cols-12 lg:gap-x-8">
        <PageHeader
          className="lg:col-span-8"
          label="LP tearsheet · Robinhood Chain and Base"
          title="What did your liquidity actually earn?"
          italic="actually"
          lede={
            <p>
              Fees, AERO emissions, value picked off by informed flow, impermanent loss vs holding, price P&amp;L and gas for tokenized-stock LPs on
              Robinhood Chain (Uniswap) and Base (Aerodrome), reconciled against what was actually collected on-chain.
            </p>
          }
        />
        <Marginalia
          className="lg:col-span-3 lg:col-start-10 lg:self-end"
          items={[
            { k: "Reference", v: "Hyperliquid, 1h" },
            { k: "Reconciled", v: "fees collected on-chain" },
            { k: "Read-only", v: "no wallet connection" },
          ]}
        />
      </div>

      {/* The request slip: chain, wallet, analyze. */}
      <section aria-label="Look up a wallet" className="mt-14 border border-rule bg-vault-2 md:mt-20">
        <nav aria-label="Chain" className="grid grid-cols-2 border-b border-rule">
          {CHAINS.map((c) => {
            const on = c.id === chain.id;
            return (
              <Link
                key={c.id}
                href={href(c.id)}
                aria-current={on ? "page" : undefined}
                className={[
                  "relative flex flex-col gap-1 px-5 py-4 transition-colors md:px-7",
                  on ? "bg-vault-3 text-paper" : "text-paper-dim hover:bg-vault-3/60 hover:text-paper",
                  c.id !== CHAINS[0].id ? "border-l border-rule" : "",
                ].join(" ")}
              >
                <span aria-hidden className={["absolute inset-x-0 top-0 h-[2px] bg-paper transition-opacity", on ? "opacity-100" : "opacity-0"].join(" ")} />
                <span className="text-[0.95rem] font-medium">{c.label}</span>
                <span className="font-mono text-[0.68rem] text-paper-mute">{c.sub}</span>
              </Link>
            );
          })}
        </nav>
        <form className="flex flex-col gap-4 px-5 py-6 md:flex-row md:items-end md:gap-4 md:px-7 md:py-7" action="/tearsheet">
          <label className="min-w-0 flex-1 space-y-2.5">
            <Label as="span" className="block">LP wallet on {chain.label}</Label>
            <input
              name="wallet"
              defaultValue={wallet}
              placeholder="0x…"
              spellCheck={false}
              autoComplete="off"
              className="h-14 w-full border border-rule-strong bg-vault px-4 font-mono text-[0.9rem] text-paper transition-colors placeholder:text-paper-mute hover:border-paper-mute focus-visible:outline-offset-0"
            />
          </label>
          <input type="hidden" name="chain" value={chain.id} />
          {role !== "auto" && <input type="hidden" name="as" value={role} />}
          <Button type="submit" size="lg" trailing="→" className="md:w-auto">
            Analyze
          </Button>
        </form>
      </section>

      <div className="mt-6 max-w-3xl space-y-3" aria-live="polite">
        {!wallet && (
          <p className="text-sm text-paper-mute">
            Paste the wallet that owns or manages the positions. No wallet to hand? Open any manager from the{" "}
            <Link className={LINK} href="/league">
              LP League
            </Link>
            .
          </p>
        )}
        {wallet && !valid && <Notice tone="warning">That isn&apos;t a 0x wallet address.</Notice>}
        {res && !res.ok && (
          <Notice tone="warning">{res.status === 503 ? "Tearsheets are still being computed. Try again shortly." : `Couldn't load: ${res.error}`}</Notice>
        )}
        {t && !s && <Notice>No LP positions found for this wallet in {chain.pools}.</Notice>}
      </div>

      {!s && (
        // Before a lookup: a specimen of the statement, so the reader knows what each line will mean.
        <LedgerPanel
          className="mt-14 md:mt-20"
          tone="flat"
          label="Specimen"
          title="What the statement shows"
          actions={<span className="label border border-rule-strong px-2 py-1 text-paper-dim">Specimen · no values</span>}
          inset={false}
        >
          <dl className="grid md:grid-cols-2">
            {SPECIMEN.map((x, i) => (
              <div
                key={x.k}
                className={`space-y-1.5 border-rule px-5 py-4 md:px-6 ${i > 0 ? "border-t" : ""} ${i === 1 ? "md:border-t-0" : ""} ${i % 2 === 1 ? "md:border-l" : ""}`}
              >
                <dt className="flex items-baseline justify-between gap-4 text-[0.95rem] text-paper">
                  {x.k}
                  <span aria-hidden className="font-mono text-paper-mute">
                    $ ––––
                  </span>
                </dt>
                <dd className="text-sm leading-relaxed text-paper-dim">{x.d}</dd>
              </div>
            ))}
          </dl>
        </LedgerPanel>
      )}

      {t && s && (
        <>
          {/* The statement: the headline result and the account it comes from. */}
          <section data-demo="ts-statement" aria-labelledby="ts-statement" className="mt-14 grid gap-px border border-rule bg-rule md:mt-20 lg:grid-cols-12">
            <div className="flex min-w-0 flex-col gap-8 bg-vault-2 px-5 py-7 md:px-8 md:py-9 lg:col-span-5">
              <div className="space-y-2">
                <Label as="h2" id="ts-statement">Statement · {chain.label}</Label>
                <p className="break-all font-mono text-[0.78rem] text-paper-dim">{t.owner}</p>
              </div>
              <div>
                <p data-demo="ts-result" className="font-mono text-[clamp(2.75rem,5.5vw,4.75rem)] leading-[0.95] tracking-[-0.04em] text-paper">{signed(s.vs_hodl_usd)}</p>
                <p className="mt-3 text-body text-paper-dim">vs simply holding the same tokens</p>
              </div>
              <div className="grid grid-cols-2 gap-x-6 gap-y-6 border-t border-rule pt-6">
                <Stat size="md" label={ae ? "Edge incl. AERO" : "LP edge vs HL"} value={ratio(ae ? ae.edge_hl_1h_incl_aero : s.edge_hl_1h)} />
                <Stat size="md" label="Positions" value={s.n_positions} unit={s.n_open ? `${s.n_open} open` : undefined} />
                <Stat size="md" label="Avg notional" value={usd(s.avg_notional_usd, 0)} />
                <Stat size="md" label="Median range" value={`${(s.flags.median_width_ticks / 100).toFixed(1)}%`} />
              </div>
              <p className="mt-auto text-xs leading-relaxed text-paper-mute">
                Viewed as {t.role} (<N tone="dim">{t.match.as_owner}</N> positions owned, <N tone="dim">{t.match.as_operator}</N> managed) · {s.pools.join(", ")} ·{" "}
                <span className="num">
                  {s.first_utc.slice(0, 10)} → {s.last_utc.slice(0, 10)}
                </span>
              </p>
            </div>
            <div className="min-w-0 bg-vault-2 px-2 py-4 md:px-5 md:py-6 lg:col-span-7">
              <ScrollX label="Account">
                <table className="ledger-table text-[0.82rem] md:min-w-[30rem] md:text-sm">
                  <caption className="sr-only">Account, in USD and per $1k of capital</caption>
                  <thead>
                    <tr>
                      <th scope="col">Line</th>
                      <th scope="col" className="n">USD</th>
                      <th scope="col" className="n">per $1k</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((l, i) => (
                      <tr
                        key={l.k}
                        className={
                          l.strong
                            ? `text-paper [&>*]:border-t [&>*]:border-t-rule-strong ${i === lines.length - 1 ? "[&>*]:border-b-[3px] [&>*]:border-double [&>*]:border-b-rule-strong" : ""}`
                            : "text-paper-dim"
                        }
                      >
                        <td className={l.strong ? "font-medium" : ""}>{l.k}</td>
                        <td className={`n whitespace-nowrap ${l.strong ? "font-medium" : ""}`}>{signed(l.v)}</td>
                        <td className="n whitespace-nowrap">{signed(l.p)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </ScrollX>
            </div>
            {ae && (
              <p className="bg-vault-2 px-5 py-5 text-sm leading-relaxed text-paper-dim md:px-8 lg:col-span-12">
                Staked in the Aerodrome gauge <N>{ae.staked_share != null ? `${(ae.staked_share * 100).toFixed(0)}%` : "–"}</N> of the time. Staked liquidity
                earns AERO instead of fees: <N>{usd(ae.fees_to_voters_usd)}</N> of this wallet&apos;s <N>{usd(ae.fees_gross_usd)}</N> fee share went to veAERO
                voters.
                {ae.aero_forfeited > 0 && (
                  <>
                    {" "}Withdrawing within 5 minutes of staking forfeits the reward: <N>{ae.aero_forfeited.toFixed(1)}</N> AERO forfeited over{" "}
                    <N>{ae.early_withdrawals}</N> early withdrawals.
                  </>
                )}
              </p>
            )}
          </section>

          <div className="mt-8 grid gap-8 md:grid-cols-2">
            <LedgerPanel className="min-w-0" label="By market regime" title="Where the fees came from" inset={false}>
              <ScrollX label="By market regime">
                <table className="ledger-table min-w-[20rem] text-xs">
                  <thead>
                    <tr>
                      <th scope="col" className="pl-5 md:pl-6">Regime</th>
                      <th scope="col" className="n">Fees</th>
                      <th scope="col" className="n">Picked off (HL)</th>
                      <th scope="col" className="n pr-5 md:pr-6">Edge</th>
                    </tr>
                  </thead>
                  <tbody>
                    {t.by_regime.map((r) => {
                      const picked = (r.lvr_hl_1h_usd ?? r.picked_hl_1h ?? 0) as number;
                      return (
                        <tr key={r.regime}>
                          <td className="pl-5 text-paper-dim md:pl-6">{REGIME_LABEL[r.regime] ?? r.regime}</td>
                          <td className="n">{usd(r.fees_usd)}</td>
                          <td className="n">{usd(picked)}</td>
                          <td className="n pr-5 md:pr-6">{picked > 0 ? ratio(r.fees_usd / picked) : "–"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </ScrollX>
            </LedgerPanel>
            <LedgerPanel id="ts-reconciliation" className="min-w-0" label="Reconciliation" title="Checked against the chain" bodyClassName="space-y-4 text-sm leading-relaxed text-paper-dim">
              {s.residual.reconciled_positions > 0 ? (
                <p data-demo="ts-reconciled">
                  <N>{s.residual.reconciled_positions}</N> fully collected positions reconcile to the fees actually collected on-chain within{" "}
                  <N>{(s.residual.max_abs_residual_bp ?? 0).toFixed(4)} bp</N> of notional (total difference <N>{usd(s.residual.residual_usd ?? 0, 4)}</N>).
                </p>
              ) : (
                <p data-demo="ts-reconciled">No fully collected closed v3 positions to reconcile (v4 settles fees inside liquidity changes, with no fee event).</p>
              )}
              <dl className="grid grid-cols-2 gap-x-6 gap-y-4 border-t border-rule pt-4">
                {[
                  { k: "Weekend share of capital", v: s.flags.weekend_share != null ? `${(s.flags.weekend_share * 100).toFixed(0)}%` : "–" },
                  { k: "In range", v: s.flags.in_range_share != null ? `${(s.flags.in_range_share * 100).toFixed(0)}%` : "–" },
                  { k: "Re-ranges per day", v: s.flags.rebalances_per_day.toFixed(1) },
                  { k: "JIT positions", v: String(s.flags.jit_positions) },
                ].map((x) => (
                  <div key={x.k} className="space-y-1">
                    <Label as="dt">{x.k}</Label>
                    <dd className="font-mono text-paper tabular">{x.v}</dd>
                  </div>
                ))}
              </dl>
            </LedgerPanel>
          </div>

          {t.positions.length > 0 && (
            <LedgerPanel
              className="mt-8"
              label={`Positions · ${Math.min(t.positions.length, 100)} of ${t.positions.length}`}
              title="Every position, one line each"
              inset={false}
            >
              <ScrollX label="Positions">
                <table className="ledger-table min-w-[56rem] text-xs">
                  <thead>
                    <tr>
                      {["Position", "Status", "Width", "Notional", "Fees", "Picked off (HL)", "IL", "Net", "Residual"].map((h, i) => (
                        <th key={h} scope="col" className={[i >= 2 ? "n" : "", i === 0 ? "pl-5 md:pl-6" : "", i === 8 ? "pr-5 md:pr-6" : ""].join(" ")}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {t.positions.slice(0, 100).map((p, i) => (
                      <tr key={i}>
                        <td className="whitespace-nowrap pl-5 font-mono text-paper-dim md:pl-6">{String(p.pos_id ?? p.position ?? "")}</td>
                        <td className="text-paper-dim">{String(p.status ?? "–")}</td>
                        <td className="n">{String(p.width_ticks ?? "–")}</td>
                        <td className="n">{usd(Number(p.avg_notional_usd ?? 0), 0)}</td>
                        <td className="n">{usd(Number(p.fees_usd ?? 0))}</td>
                        <td className="n">{usd(Number(p.lvr_hl_1h_usd ?? 0))}</td>
                        <td className="n">{usd(Number(p.il_usd ?? 0))}</td>
                        <td className="n">{usd(Number(p.net_usd ?? 0))}</td>
                        <td className="n whitespace-nowrap pr-5 md:pr-6">{p.residual_bp != null ? `${Number(p.residual_bp).toFixed(3)} bp` : "–"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </ScrollX>
            </LedgerPanel>
          )}
          {t.positions.length > 0 && (
            <p className="mt-5 max-w-[90ch] text-xs leading-relaxed text-paper-mute">
              Picked off = what informed takers gained against this liquidity, marked to Hyperliquid 1h later. Negative means takers lost to this position.
              Residual = on-chain collected fees − attributed fees (only for fully collected v3 positions).
            </p>
          )}
          <p className="mt-10 text-sm text-paper-mute">Informational analytics, not investment advice.</p>
        </>
      )}
    </main>
  );
}
