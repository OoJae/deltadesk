"use client";

import Link from "next/link";
import { useState } from "react";
import type { Address } from "viem";
import { capsRows } from "@/lib/desk/caps";
import { CHAIN_ID, EXPLORER_URL, LANE_A, RPC_URL, addressUrl } from "@/lib/desk/chain";
import { DESK_FACTORY } from "@/lib/desk/config";
import { ago, fmtEth, fmtUnits, fmtUsd, isZeroAddr, positionAmounts, short } from "@/lib/desk/format";
import { ownerDecisionId } from "@/lib/desk/meta";
import { readEthBalances, readLane, type LaneState } from "@/lib/desk/reads";
import { fenceCodeLabel } from "@/lib/desk/tx";
import AgentPanel from "./AgentPanel";
import { useDeskSession } from "./context";
import { DYNAMIC_SLOW_HINT, usePoll, useSlow } from "./hooks";
import OwnerControls, { type OwnerSigner } from "./OwnerControls";
import RangeStrip from "./RangeStrip";
import type { DeskSession } from "./session";
import { Addr, Card, CopyButton, Meter, Notice, Pill, type Tone } from "./ui";
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
        <p className="text-sm">
          {/* The lane holds the positions, so its tearsheet reads it as the LP owner. No prefetch: the tearsheet is a paid API read. */}
          <Link href={`/tearsheet?chain=robinhood&wallet=${s.lane.toLowerCase()}&as=owner`} prefetch={false} className="text-ink-2 underline underline-offset-2 hover:text-ink">
            This lane&apos;s tearsheet →
          </Link>
        </p>
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

          <LastResort s={s} />
        </div>
      </div>
      <p className="text-xs text-muted tabular">
        Chain time {new Date(s.chainTime * 1000).toLocaleTimeString()} · refreshes every 5 s · NVDA {nvdaUsd?.toFixed(2) ?? "–"} USD (Chainlink{s.prices.nvdaUpdatedAt ? `, ${ago(s.chainTime - s.prices.nvdaUpdatedAt)} old` : ""})
      </p>
    </div>
  );
}

/**
 * The documented last resort (M2 plan, "Start a desk"): if this site, desk-agent or Dynamic's sign-in is unavailable, the
 * Vault owner calls the lane directly on the explorer after exporting the Vault's key from Dynamic.
 */
function LastResort({ s }: { s: LaneState }) {
  const [exampleId] = useState(() => ownerDecisionId());
  const ahead = s.caps?.maxDeadlineAhead ?? 120;
  const deadline = s.chainTime + Math.min(60, Math.max(1, ahead - 10));
  const explorer = addressUrl(s.lane);
  const code = "rounded bg-surface-2 px-1 font-mono text-xs";
  const held = s.slots.flatMap((id, slot) => (id > BigInt(0) ? [`slot ${slot}: NFT #${id.toString()}`] : []));
  return (
    <details className="card p-5">
      <summary className="cursor-pointer text-base font-semibold">If DeltaDesk is down</summary>
      <div className="mt-3 space-y-3 text-sm text-ink-2">
        <p>
          The owner controls on this page are signed by your Vault in the browser and don&apos;t need desk-agent. If this site or Dynamic&apos;s sign-in is unavailable too, the
          last resort is to call the lane contract yourself from the Vault:
        </p>
        <ol className="list-decimal space-y-2 pl-5">
          <li>
            Export the Vault&apos;s private key from Dynamic (Private Key Exports is enabled for the Vault; the Operator&apos;s export is blocked by its policy, and the Operator
            can&apos;t withdraw anyway). Import it into an EVM wallet and add Robinhood Chain: chain {CHAIN_ID}, RPC <span className="break-all font-mono text-xs">{RPC_URL}</span>.
          </li>
          <li>
            Open the lane&apos;s verified contract on the Robinhood Chain explorer,{" "}
            <a href={`${explorer}?tab=write_contract`} target="_blank" rel="noreferrer" className="break-all font-mono text-xs text-ink underline">
              {explorer.replace(/^https:\/\//, "")}
            </a>
            , go to the <strong>Write contract</strong> tab (Blockscout may list a clone&apos;s functions under <strong>Write proxy</strong>) and connect that wallet.
          </li>
          <li>
            Optional, to stop the agent first: <code className={code}>pause()</code>, then <code className={code}>revokeOperator()</code>.
          </li>
          <li>
            <code className={code}>exitAll(m)</code> unwinds every position into USDG and NVDA held by the lane. Fill <code className={code}>m</code> as:
            <dl className="mt-1 space-y-1 text-xs">
              <div className="flex flex-wrap items-center gap-x-2">
                <dt>decisionId</dt>
                <dd className="flex min-w-0 items-center gap-1">
                  <span className="break-all font-mono">{exampleId}</span> <CopyButton text={exampleId} />
                </dd>
                <dd className="w-full text-muted">any non-zero 32-byte value never used before; this one is fresh</dd>
              </div>
              <div className="flex flex-wrap items-center gap-x-2">
                <dt>deadline</dt>
                <dd className="font-mono">{deadline}</dd>
                <dd className="w-full text-muted">
                  a Unix time at most {ahead} s ahead of the chain (now {s.chainTime}); this value refreshes with the page, so send within a minute
                </dd>
              </div>
              <div className="flex flex-wrap gap-x-2">
                <dt>regime, gatesMask</dt>
                <dd className="font-mono">0, 0</dd>
              </div>
              <div className="flex flex-wrap gap-x-2">
                <dt>reasonHash</dt>
                <dd className="break-all font-mono">0x{"0".repeat(64)}</dd>
              </div>
            </dl>
          </li>
          <li>
            <code className={code}>withdrawAll()</code> sends every idle USDG and NVDA to the Vault.
          </li>
          <li>
            If a slot still holds a position after <code className={code}>exitAll</code>, <code className={code}>withdrawPosition(slot)</code> transfers that slot&apos;s
            position NFT to the Vault as it is, with no deadline to fill ({held.length ? held.join(", ") : "no slot holds a position right now"}). Remove its liquidity from
            the Vault afterwards. <code className={code}>exitAll</code> doesn&apos;t fail on a bad slot: when a token is paused or blocklists the lane, it still succeeds, but
            the lane emits <code className={code}>CollectFailed</code> for that position and leaves it in its slot.
          </li>
        </ol>
        <p>
          Only the Vault can call these, and the lane pays out only to the Vault. Explorer: <span className="font-mono text-xs">{EXPLORER_URL}</span>.
        </p>
      </div>
    </details>
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
