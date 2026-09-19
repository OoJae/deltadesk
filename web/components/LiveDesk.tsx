"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Label } from "@/components/brand/Label";
import { LINK, Notice, StatusIcon, StatusStamp, type StatusTone } from "@/components/ledger/ui";
import { REGIME_LABEL, bps, ratio } from "@/lib/format";

type Reason = { level: string; reason: string };
type HourRecord = { swaps: number; fees_usd: number; picked_1h_usd: number; edge_1h: number | null; lp_net_bps_1h: number | null; reference: string };
type PoolLive = {
  pool: string;
  error: string | null;
  fair: null | { fair_value: number; pool_mid: number; gap_bps: number; hl_price: number; basis_k: number; hl_ref: string | string[]; chainlink: null | { price: number; age_s: number } };
  safe: null | {
    verdict: "ALLOW" | "CAUTION" | "BLOCK";
    reasons: Reason[];
    regime: string;
    reopen_window: boolean;
    next_regime_change: null | { at: number; regime: string };
    // The API's gap rule only ever raises CAUTION (engine/api/app.py GAP_CAUTION: 15 bp regular … 60 bp weekend).
    thresholds: { gap_caution_bps: number; source?: string };
    hour_of_week_record?: HourRecord | null;
  };
};

const STATUS: Record<"ALLOW" | "CAUTION" | "BLOCK", { tone: StatusTone; label: string }> = {
  ALLOW: { tone: "good", label: "Allow" },
  CAUTION: { tone: "warning", label: "Caution" },
  BLOCK: { tone: "critical", label: "Block" },
};
const levelTone = (l: string): StatusTone => STATUS[l as keyof typeof STATUS]?.tone ?? "neutral";

function ago(s: number) {
  if (s < 90) return `${Math.round(s)} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  return `${(s / 3600).toFixed(1)} h`;
}
function until(atSec: number, now: number) {
  const s = Math.max(0, atSec - now / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m ${Math.floor(s % 60)}s`;
}
const px = (v: number) => v.toFixed(v < 10 ? 5 : 2);

export default function LiveDesk() {
  const [data, setData] = useState<{ at: number; pools: PoolLive[] } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        const r = await fetch("/api/live", { cache: "no-store" });
        const j = await r.json();
        if (!stop) { setData(j); setErr(null); }
      } catch (e) {
        if (!stop) setErr(e instanceof Error ? e.message : "failed");
      }
    };
    load();
    const a = setInterval(load, 5000), b = setInterval(() => setNow(Date.now()), 1000);
    return () => { stop = true; clearInterval(a); clearInterval(b); };
  }, []);

  if (!data) {
    if (!err) return <Notice>Loading live desk…</Notice>;
    return <Unavailable details={[{ pools: "Live feed", error: err }]} />;
  }
  const up = data.pools.filter(isLive);
  const down = data.pools.filter((p) => !isLive(p));
  const regime = up[0]?.safe;
  const updated = new Date(data.at).toLocaleTimeString();

  return (
    <div className={`space-y-10 transition-opacity duration-300 ${err ? "opacity-60" : ""}`}>
      {up.length === 0 ? (
        <Unavailable details={groupErrors(down)} />
      ) : (
        <>
          {regime && (
            <section data-demo="live-regime" aria-label="Market regime" className="grid gap-6 border-y border-rule py-6 md:grid-cols-12 md:items-end md:gap-8">
              <div className="space-y-2 md:col-span-7">
                <Label as="p">Market regime · now</Label>
                <p className="text-title text-paper">
                  {REGIME_LABEL[regime.regime] ?? regime.regime}
                  {regime.reopen_window && <span className="ml-3 align-middle text-base text-paper-dim">(reopen window)</span>}
                </p>
              </div>
              {regime.next_regime_change && (
                <div className="space-y-2 md:col-span-5 md:text-right">
                  <Label as="p">Next: {REGIME_LABEL[regime.next_regime_change.regime] ?? regime.next_regime_change.regime}</Label>
                  <p className="font-mono text-title leading-none text-paper tabular">
                    <span className="sr-only">in </span>
                    {until(regime.next_regime_change.at, now)}
                  </p>
                </div>
              )}
            </section>
          )}
          {down.length > 0 && (
            <Notice tone="warning">
              <p>
                No live reading for {down.map((p) => p.pool).join(", ")} right now; the other pools are current. This page retries every 5 seconds.
              </p>
              <ErrorDetails details={groupErrors(down)} />
            </Notice>
          )}
          <div className="grid gap-px border border-rule bg-rule md:grid-cols-2">
            {up.map((p) => (
              <PoolCard key={p.pool} p={p} />
            ))}
            {up.length % 2 === 1 && <div aria-hidden className="hidden bg-vault-2 md:block" />}
          </div>
        </>
      )}
      <p className="font-mono text-[0.72rem] leading-relaxed text-paper-mute tabular">
        {err ? `Couldn't refresh; showing the reading from ${updated}` : `Updated ${updated}`} · refreshes every 5 s · fair value = Hyperliquid trade.xyz price × basis
        calibrated on the last regular session.
      </p>
    </div>
  );
}

type ErrorLine = { pools: string; error: string };

/** Pools that failed with the same message share one line, so four identical errors read as one. */
function groupErrors(pools: PoolLive[]): ErrorLine[] {
  const by = new Map<string, string[]>();
  for (const p of pools) {
    const e = p.error ?? "no reading returned";
    by.set(e, [...(by.get(e) ?? []), p.pool]);
  }
  return [...by].map(([error, names]) => ({ pools: names.length === pools.length && pools.length > 1 ? "All pools" : names.join(", "), error }));
}

/** The whole grid is down (API unreachable, or the premium feed refused): one notice, the raw detail folded away. */
function Unavailable({ details }: { details: ErrorLine[] }) {
  return (
    <div className="max-w-3xl">
      <Notice tone="warning">
        <p className="text-paper">Live readings are unavailable right now.</p>
        <p className="mt-1">
          This page retries every 5 seconds. The{" "}
          <Link className={LINK} href="/study">
            Truth Study
          </Link>{" "}
          is historical and doesn&apos;t depend on this feed.
        </p>
        <ErrorDetails details={details} />
      </Notice>
    </div>
  );
}

function ErrorDetails({ details }: { details: ErrorLine[] }) {
  return (
    <details className="mt-3">
      <summary className="label cursor-pointer text-paper-mute transition-colors hover:text-paper">Technical detail</summary>
      <ul className="mt-2 space-y-1 font-mono text-[0.72rem] leading-relaxed text-paper-mute">
        {details.map((d) => (
          <li key={d.pools + d.error} className="break-words">
            {d.pools}: {d.error}
          </li>
        ))}
      </ul>
    </details>
  );
}

type LivePool = PoolLive & { fair: NonNullable<PoolLive["fair"]>; safe: NonNullable<PoolLive["safe"]> };
const isLive = (p: PoolLive): p is LivePool => p.fair != null && p.safe != null;

function PoolCard({ p }: { p: LivePool }) {
  const st = STATUS[p.safe.verdict];
  const gap = p.fair.gap_bps;
  const lim = p.safe.thresholds?.gap_caution_bps || 60; // the scale's ends: the regime's caution band
  const w = Math.min(Math.abs(gap) / lim, 1) * 50;
  const cl = p.fair.chainlink;
  const rec = p.safe.hour_of_week_record;
  return (
    <article data-demo="live-pool" data-pool={p.pool} className="space-y-7 bg-vault-2 px-5 py-6 md:px-7 md:py-8" aria-label={`${p.pool}: ${st.label}`}>
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <Label as="h3" tone="paper">{p.pool}</Label>
          <p className="font-mono text-[clamp(2rem,3.2vw,2.75rem)] leading-none tracking-[-0.03em] text-paper tabular">{px(p.fair.pool_mid)}</p>
          <p className="text-xs text-paper-dim">pool mid</p>
        </div>
        <StatusStamp tone={st.tone}>{st.label}</StatusStamp>
      </div>

      {/* The gap: the pool against fair value (serial), on a scale that ends at the regime's caution band. */}
      <div data-demo="live-gap" className="space-y-2.5">
        <div className="flex items-baseline justify-between gap-3 text-xs text-paper-dim">
          <span>gap to fair value</span>
          <strong className="font-mono text-[0.95rem] font-medium text-serial tabular">{bps(gap)}</strong>
        </div>
        <div className="relative h-5" aria-hidden>
          <div className="absolute inset-x-0 top-1/2 h-px bg-rule-strong" />
          <div className="absolute left-0 top-1/2 h-2.5 w-px -translate-y-1/2 bg-paper-mute" />
          <div className="absolute right-0 top-1/2 h-2.5 w-px -translate-y-1/2 bg-paper-mute" />
          <div className="absolute top-1/2 h-1.5 -translate-y-1/2 bg-serial" style={{ width: `${w}%`, left: gap >= 0 ? "50%" : `${50 - w}%` }} />
          <div className="absolute left-1/2 top-0 h-full w-px bg-serial" />
        </div>
        <div className="flex justify-between font-mono text-[0.65rem] text-paper-mute tabular">
          <span>−{lim} bp</span>
          <span>fair · caution beyond ±{lim} bp</span>
          <span>+{lim} bp</span>
        </div>
      </div>

      <dl className="grid grid-cols-3 gap-4 border-t border-rule pt-5">
        <div className="space-y-1">
          <Label as="dt">Fair (HL)</Label>
          <dd className="font-mono text-sm text-paper tabular">{px(p.fair.fair_value)}</dd>
        </div>
        <div className="space-y-1">
          <Label as="dt">Chainlink</Label>
          <dd className="font-mono text-sm text-paper tabular">{cl ? cl.price.toFixed(2) : "–"}</dd>
        </div>
        <div data-demo="live-oracle-age" className="space-y-1">
          <Label as="dt">Oracle age</Label>
          <dd className="font-mono text-sm text-paper tabular">
            {cl ? (
              <>
                <span className="whitespace-nowrap">{ago(cl.age_s)}</span>
                {cl.age_s > 3600 && <span className="ml-1.5 inline-block border border-rule-strong px-1 py-px text-[0.62rem] uppercase tracking-[0.08em] text-paper-dim">frozen</span>}
              </>
            ) : (
              "–"
            )}
          </dd>
        </div>
      </dl>

      {rec && (
        <p className="text-xs leading-relaxed text-paper-dim">
          <span className="label mr-2 text-paper-mute">This hour of the week</span>
          edge <span className="font-mono text-paper">{ratio(rec.edge_1h)}</span> · LP net <span className="font-mono text-paper">{bps(rec.lp_net_bps_1h)}</span> ·{" "}
          <span className="font-mono">{rec.swaps.toLocaleString()}</span> swaps
        </p>
      )}

      <ul data-demo="live-reasons" className="space-y-2 text-xs leading-relaxed text-paper-dim">
        {p.safe.reasons.slice(0, 3).map((r, i) => (
          <li key={i} className="flex gap-2.5">
            <StatusIcon tone={levelTone(r.level)} size="sm" className="mt-px" />
            <span>
              <span className="sr-only">{r.level}: </span>
              {r.reason}
            </span>
          </li>
        ))}
      </ul>
    </article>
  );
}
