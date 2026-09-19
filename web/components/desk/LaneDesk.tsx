"use client";

import Link from "next/link";
import type { Address } from "viem";
import { capsRows } from "@/lib/desk/caps";
import { LANE_A, addressUrl } from "@/lib/desk/chain";
import { DESK_FACTORY } from "@/lib/desk/config";
import { ago, fmtEth, fmtUnits, fmtUsd, isZeroAddr, positionAmounts, short } from "@/lib/desk/format";
import { readEthBalances, readLane, type LaneState } from "@/lib/desk/reads";
import { fenceCodeLabel } from "@/lib/desk/tx";
import AgentPanel from "./AgentPanel";
import { useDeskSession } from "./context";
import { DYNAMIC_SLOW_HINT, usePoll, useSlow } from "./hooks";
import OwnerControls, { type OwnerSigner } from "./OwnerControls";
import RangeStrip from "./RangeStrip";
import type { DeskSession } from "./session";
import { Addr, Card, Meter, Notice, Pill, type Tone } from "./ui";
import VaultAlarm from "./VaultAlarm";

export default function LaneDesk({ lane }: { lane: Address }) {
  return <LaneView lane={lane} session={useDeskSession()} />;
}

type Snapshot = { s: LaneState | null; operatorEth: bigint | null };

function LaneView({ lane, session }: { lane: Address; session: DeskSession | null }) {
  const { data, error, refresh } = usePoll<Snapshot>(
    async () => {
      const s = await readLane(lane);
      const [operatorEth] = s && !isZeroAddr(s.operator) ? await readEthBalances([s.operator]) : [null];
      return { s, operatorEth };
    },
    5000,
    lane,
  );

  if (!data) return <p className="text-sm text-muted">{error ? `Chain read failed: ${error}` : "Reading the lane from Robinhood Chain…"}</p>;
  if (!data.s)
    return (
      <Notice tone="warning" title="No DeskLane at this address">
        Nothing answers as a DeltaDesk lane at <span className="font-mono">{lane}</span> on Robinhood Chain.
        {!DESK_FACTORY && " The lane factory is not deployed yet."} <Link href="/desk" className="underline">Start a desk</Link>
      </Notice>
    );

  return <LaneBody s={data.s} operatorEth={data.operatorEth} session={session} error={error} refresh={refresh} />;
}

/** The lane view for one chain snapshot. Pure apart from the owner controls and the agent panel. */
export function LaneBody({ s, operatorEth, session, error, refresh }: { s: LaneState; operatorEth: bigint | null; session: DeskSession | null; error: string | null; refresh: () => void }) {
  const slow = useSlow(!!session && !session.sdkHasLoaded);
  const vault = session?.walletFor(s.owner) ?? null;
  const operatorWallet = session?.walletFor(s.operator) ?? null;
  const signer: OwnerSigner = {
    vault,
    blocked: !session
      ? "Dynamic is not configured (NEXT_PUBLIC_DYNAMIC_ENV_ID), so the Vault cannot sign here."
      : !session.sdkHasLoaded
        ? slow
          ? DYNAMIC_SLOW_HINT
          : "Loading your wallets…"
        : !session.loggedIn
          ? "Sign in with this lane's Vault to use these controls."
          : !vault
            ? `The signed-in account does not hold this lane's owner (${short(s.owner)}).`
            : null,
    signIn: session && !session.loggedIn ? session.signIn : undefined,
    revokeDynamic: session && operatorWallet ? session.revokeDynamicDelegation : undefined,
    operatorDelegated: !!operatorWallet && session?.delegationOf(s.operator) === "delegated",
  };

  const risk: { tone: Tone; label: string } = s.paused
    ? { tone: "critical", label: "Paused" }
    : s.riskAdding == null
      ? { tone: "neutral", label: "Risk state unknown" }
      : s.riskAdding.open
        ? { tone: "good", label: "Risk-adding open" }
        : { tone: "warning", label: `Risk-adding closed: ${fenceCodeLabel(s.riskAdding.code)}` };

  const { nvdaUsd, usdgUsd } = s.prices;
  const posAmt = s.positions.reduce(
    (acc, p) => {
      if (s.poolTick == null) return acc;
      const a = positionAmounts(p.liquidity, p.tickLower, p.tickUpper, s.poolTick);
      return { a0: acc.a0 + a.a0, a1: acc.a1 + a.a1 };
    },
    { a0: 0, a1: 0 },
  );
  const usd = (a0: number, a1: number) => (nvdaUsd != null && usdgUsd != null ? (a0 / 10 ** LANE_A.dec0) * usdgUsd + (a1 / 10 ** LANE_A.dec1) * nvdaUsd : null);
  const idleUsd = usd(Number(s.bal0), Number(s.bal1));
  const posUsd = s.poolTick != null ? usd(posAmt.a0, posAmt.a1) : null;
  const totalUsd = idleUsd != null ? idleUsd + (posUsd ?? 0) : null;

  return (
    <div className={`space-y-6 transition-opacity ${error ? "opacity-70" : ""}`}>
      <header className="space-y-3">
        <p className="text-xs font-medium uppercase tracking-wider text-muted">Desk · lane {"ABC"[s.laneId] ?? s.laneId} · NVDA/USDG</p>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-mono text-2xl font-semibold sm:text-3xl">
            <a href={addressUrl(s.lane)} target="_blank" rel="noreferrer" className="hover:underline" title={s.lane}>
              {short(s.lane)}
            </a>
          </h1>
          <Pill tone={risk.tone}>{risk.label}</Pill>
          {isZeroAddr(s.operator) && <Pill tone="critical">Agent revoked</Pill>}
        </div>
        <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
          <Role label="Vault (owner)" address={s.owner} />
          <Role label="Operator (agent)" address={isZeroAddr(s.operator) ? null : s.operator} />
          <Role label="Guardian" address={isZeroAddr(s.guardian) ? null : s.guardian} />
        </dl>
        {error && <p className="text-xs text-muted">Last refresh failed ({error}); showing the previous read.</p>}
      </header>

      {session && <VaultAlarm session={session} />}
      {s.pendingOperator && (
        <Notice tone="serious" title="Operator change pending">
          {short(s.pendingOperator.operator)} can become the operator after {new Date(s.pendingOperator.eta * 1000).toLocaleString()}. Only the Vault can propose this; if it wasn&apos;t you, pause and revoke now.
        </Notice>
      )}
      {s.closedUntil > s.chainTime && <Notice tone="warning" title={`Closed until ${new Date(s.closedUntil * 1000).toLocaleString()}`}>Risk-adding is blocked by the closed-until flag (e.g. a market holiday).</Notice>}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <aside className="order-first lg:order-last">
          <div className="space-y-4 lg:sticky lg:top-20">
            <OwnerControls s={s} signer={signer} onDone={refresh} />
          </div>
        </aside>

        <div className="min-w-0 space-y-6">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Tile label="Lane value" value={fmtUsd(totalUsd)} sub={posUsd != null && posUsd > 0 ? `${fmtUsd(posUsd)} in positions` : "Chainlink-valued"} />
            <Tile label={`Idle ${LANE_A.sym0}`} value={fmtUnits(s.bal0, LANE_A.dec0, 2)} />
            <Tile label={`Idle ${LANE_A.sym1}`} value={fmtUnits(s.bal1, LANE_A.dec1, 5)} />
            <Tile label="Operator gas" value={fmtEth(operatorEth)} sub={isZeroAddr(s.operator) ? "no operator" : undefined} />
          </div>

          <Card title="Positions" aside={<span className="text-xs text-muted">USDG per NVDA</span>}>
            <RangeStrip s={s} />
          </Card>

          <Card title="Budgets" aside={<span className="text-xs text-muted">on-chain rate limits</span>}>
            <Budgets s={s} />
          </Card>

          {session ? <AgentPanel lane={s.lane} vault={vault} jwt={session.jwt} isOwner={!!vault} /> : <AgentPanel lane={s.lane} vault={null} jwt={() => null} isOwner={false} />}

          {s.caps && (
            <details className="card p-5">
              <summary className="cursor-pointer text-base font-semibold">Caps (loosening is timelocked 24 h)</summary>
              <dl className="mt-3 divide-y divide-[var(--grid)] text-sm">
                {capsRows(s.caps).map((r) => (
                  <div key={r.label} className="flex flex-wrap justify-between gap-x-4 py-2">
                    <dt className="text-ink-2">{r.label}</dt>
                    <dd className="font-semibold">{r.value}</dd>
                  </div>
                ))}
              </dl>
            </details>
          )}
        </div>
      </div>
      <p className="text-xs text-muted tabular">
        Chain time {new Date(s.chainTime * 1000).toLocaleTimeString()} · refreshes every 5 s · NVDA {nvdaUsd?.toFixed(2) ?? "–"} USD (Chainlink{s.prices.nvdaUpdatedAt ? `, ${ago(s.chainTime - s.prices.nvdaUpdatedAt)} old` : ""})
      </p>
    </div>
  );
}

function Role({ label, address }: { label: string; address: string | null }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <dt className="text-muted">{label}</dt>
      <dd>{address ? <Addr address={address} /> : <span className="text-ink-2">none</span>}</dd>
    </div>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card p-4">
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-1 truncate text-xl font-semibold">{value}</div>
      {sub && <div className="truncate text-xs text-ink-2">{sub}</div>}
    </div>
  );
}

function Budgets({ s }: { s: LaneState }) {
  if (!s.budgets || !s.caps) return <p className="text-sm text-ink-2">Budgets unavailable.</p>;
  const b = s.budgets, c = s.caps;
  const wait = b.nextRerangeAt - s.chainTime;
  const rows = [
    { label: "Turnover left today", value: Number(b.turnoverUsd6) / 1e6, max: Number(c.turnoverUsd6PerDay) / 1e6, fmt: (v: number) => fmtUsd(v) },
    { label: "Reranges left this hour", value: b.rr1h, max: c.reranges1h, fmt: (v: number) => String(v) },
    { label: "Reranges left today", value: b.rr24h, max: c.reranges24h, fmt: (v: number) => String(v) },
  ];
  return (
    <div className="space-y-4">
      {rows.map((r) => {
        const frac = r.max > 0 ? r.value / r.max : 0;
        return (
          <div key={r.label} className="space-y-1">
            <div className="flex justify-between text-sm">
              <span className="text-ink-2">{r.label}</span>
              <span className="tabular">
                <strong>{r.fmt(r.value)}</strong> <span className="text-muted">/ {r.fmt(r.max)}</span>
              </span>
            </div>
            <Meter value={r.value} max={r.max} tone={frac < 0.15 ? "warning" : undefined} label={r.label} />
          </div>
        );
      })}
      <p className="text-sm text-ink-2">{wait > 0 ? `Next rerange allowed in ${ago(wait)}.` : "A rerange is allowed now (if the agent's own gates agree)."}</p>
    </div>
  );
}
