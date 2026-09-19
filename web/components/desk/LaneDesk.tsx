"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import type { Address } from "viem";
import { Button } from "@/components/brand/Button";
import { Guilloche } from "@/components/brand/Guilloche";
import { Label } from "@/components/brand/Label";
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
import { Addr, Aside, Blank, Card, CopyButton, Disclosure, Meter, Notice, Pill, type Tone } from "./ui";
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

  if (!data) return <LaneLoading lane={lane} error={error} />;
  if (!data.s)
    return (
      <Notice tone="warning" title="No DeskLane at this address">
        Nothing answers as a DeltaDesk lane at <span className="break-all font-mono text-paper">{lane}</span> on Robinhood Chain.
        {!DESK_FACTORY && " The lane factory is not deployed yet."}{" "}
        <Link href="/desk" prefetch={false} className="text-paper underline decoration-rule-strong underline-offset-4 hover:decoration-paper">
          Start a desk
        </Link>
      </Notice>
    );

  return <LaneBody s={data.s} operatorEth={data.operatorEth} session={session} error={error} refresh={refresh} />;
}

/**
 * The certificate before the first chain read (it takes a few seconds): the same engraved frame, the address from the
 * URL and hatched blanks where the figures will be typed in. It holds the page's height, so the footer never sits in the
 * first viewport and jumps down when the read lands (a one-line shell measured CLS 0.32 at 1440 and 0.28 at 375). A
 * failed read keeps the frame: usePoll retries every 5 s and the lane can still arrive.
 */
function LaneLoading({ lane, error }: { lane: Address; error: string | null }) {
  const blank = "hatch block motion-safe:animate-pulse";
  return (
    <div className="min-h-[70svh] space-y-8">
      <section aria-label="Lane" aria-busy={!error} className="relative border border-rule bg-vault-2">
        <Guilloche variant="border" width={12} opacity={0.34} />
        <div className="relative space-y-8 px-5 py-7 sm:px-9 sm:py-9">
          <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
            <div className="min-w-0 space-y-2.5">
              <Label as="p">Desk · NVDA/USDG</Label>
              <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <a
                  href={addressUrl(lane)}
                  target="_blank"
                  rel="noreferrer"
                  title={lane}
                  className="break-all font-mono text-[clamp(1rem,1.9vw,1.55rem)] leading-tight text-paper underline decoration-transparent underline-offset-[0.2em] transition-colors hover:decoration-rule-strong"
                >
                  {lane}
                </a>
                <CopyButton text={lane} />
              </p>
            </div>
            <div role="status" className="flex flex-wrap gap-2">
              <Pill tone={error ? "warning" : "neutral"}>{error ? "Chain read failed" : "Reading the lane from Robinhood Chain…"}</Pill>
            </div>
          </div>
          {error && <p className="break-words text-[0.9rem] text-paper-dim">Trying again every 5 s. Last error: {error}</p>}

          <div aria-hidden className="space-y-8">
            <div className="grid gap-x-10 gap-y-3.5 md:grid-cols-3">
              {["Vault (owner)", "Operator (agent)", "Guardian"].map((r) => (
                <div key={r} className="flex items-end gap-3">
                  <span className="label shrink-0 pb-1 text-paper-mute">{r}</span>
                  <span className="flex min-w-0 flex-1 justify-end border-b border-dotted border-rule-strong pb-1">
                    <span className={`${blank} my-1 h-4 w-24`} />
                  </span>
                </div>
              ))}
            </div>
            <div className="grid grid-cols-2 border-t border-rule-strong lg:grid-cols-4">
              {["Lane value", `Idle ${LANE_A.sym0}`, `Idle ${LANE_A.sym1}`, "Operator gas"].map((f, i) => (
                <div key={f} className="min-w-0 space-y-2 border-b border-rule py-4 pr-3 odd:pr-4 even:border-l even:pl-4 lg:border-b-0 lg:border-l lg:pl-5 lg:first:border-l-0 lg:first:pl-0">
                  <span className="label block text-paper-mute">{f}</span>
                  <span className={`${blank} h-[1.4375rem] w-3/4 max-w-40 sm:h-[1.75rem]`} />
                  {i === 0 && <span className={`${blank} my-[3px] h-3 w-2/3 max-w-28`} />}
                </div>
              ))}
            </div>
          </div>
          <Button href={`/tearsheet?chain=robinhood&wallet=${lane.toLowerCase()}&as=owner`} prefetch={false} variant="link" trailing="→">
            This lane&apos;s tearsheet
          </Button>
        </div>
      </section>

      <div aria-hidden className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,23rem)] xl:gap-12">
        <div className="order-first self-start border border-rule bg-vault-2 p-5 lg:order-last md:p-6">
          <span className="label block text-paper-mute">Owner controls</span>
          <span className={`${blank} mt-5 h-56`} />
        </div>
        <div className="min-w-0 space-y-8">
          {["Positions", "Budgets"].map((t, i) => (
            <div key={t} className="border border-rule bg-vault-2 p-5 md:p-6">
              <span className="label block text-paper-mute">{t}</span>
              <span className={`${blank} mt-5 ${i ? "h-32" : "h-48"}`} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
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

  const letter = "ABC"[s.laneId] ?? String(s.laneId);
  return (
    <div className={`space-y-8 transition-opacity duration-300 ${error ? "opacity-70" : ""}`}>
      {/* The lane as a certificate: its address is the certificate number, the roles are the blanks filled in. */}
      <section aria-label={`Lane ${letter}`} className="relative border border-rule bg-vault-2">
        <Guilloche variant="border" width={12} opacity={0.34} />
        <div className="relative space-y-8 px-5 py-7 sm:px-9 sm:py-9">
          <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
            <div className="min-w-0 space-y-2.5">
              <Label as="p">Desk · lane {letter} · NVDA/USDG</Label>
              <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <a
                  href={addressUrl(s.lane)}
                  target="_blank"
                  rel="noreferrer"
                  title={s.lane}
                  className="break-all font-mono text-[clamp(1rem,1.9vw,1.55rem)] leading-tight text-paper underline decoration-transparent underline-offset-[0.2em] transition-colors hover:decoration-rule-strong"
                >
                  {s.lane}
                </a>
                <CopyButton text={s.lane} />
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Pill tone={risk.tone}>{risk.label}</Pill>
              {isZeroAddr(s.operator) && <Pill tone="critical">Agent revoked</Pill>}
            </div>
          </div>

          <dl className="grid gap-x-10 gap-y-3.5 md:grid-cols-3">
            <Role label="Vault (owner)" address={s.owner} />
            <Role label="Operator (agent)" address={isZeroAddr(s.operator) ? null : s.operator} />
            <Role label="Guardian" address={isZeroAddr(s.guardian) ? null : s.guardian} />
          </dl>

          <dl className="grid grid-cols-2 border-t border-rule-strong lg:grid-cols-4">
            <Figure label="Lane value" value={fmtUsd(totalUsd)} sub={posUsd != null && posUsd > 0 ? `${fmtUsd(posUsd)} in positions` : "Chainlink-valued"} />
            <Figure label={`Idle ${LANE_A.sym0}`} value={fmtUnits(s.bal0, LANE_A.dec0, 2)} />
            <Figure label={`Idle ${LANE_A.sym1}`} value={fmtUnits(s.bal1, LANE_A.dec1, 5)} />
            <Figure label="Operator gas" value={fmtEth(operatorEth)} sub={isZeroAddr(s.operator) ? "no operator" : undefined} />
          </dl>

          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
            {/* The lane holds the positions, so its tearsheet reads it as the LP owner. No prefetch: the tearsheet is a paid API read. */}
            <Button href={`/tearsheet?chain=robinhood&wallet=${s.lane.toLowerCase()}&as=owner`} prefetch={false} variant="link" trailing="→">
              This lane&apos;s tearsheet
            </Button>
            {error && <p className="text-[0.8rem] text-paper-mute">Last refresh failed ({error}); showing the previous read.</p>}
          </div>
        </div>
      </section>

      {session && <VaultAlarm session={session} />}
      {s.pendingOperator && (
        <Notice tone="serious" title="Operator change pending">
          <span className="font-mono text-paper">{short(s.pendingOperator.operator)}</span> can become the operator after {new Date(s.pendingOperator.eta * 1000).toLocaleString()}.
          Only the Vault can propose this; if it wasn&apos;t you, pause and revoke now.
        </Notice>
      )}
      {s.closedUntil > s.chainTime && <Notice tone="warning" title={`Closed until ${new Date(s.closedUntil * 1000).toLocaleString()}`}>Risk-adding is blocked by the closed-until flag (e.g. a market holiday).</Notice>}

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,23rem)] xl:gap-12">
        <aside aria-label="Owner controls" className="order-first lg:order-last">
          <div className="space-y-4 lg:sticky lg:top-24">
            <OwnerControls s={s} signer={signer} onDone={refresh} />
          </div>
        </aside>

        <div className="min-w-0 space-y-8">
          <Card title="Positions" label="Ranges against the pool" aside={<Aside>USDG per NVDA</Aside>}>
            <RangeStrip s={s} />
          </Card>

          <Card title="Budgets" label="On-chain rate limits" aside={<Aside>refill with time</Aside>}>
            <Budgets s={s} />
          </Card>

          {session ? <AgentPanel lane={s.lane} vault={vault} jwt={session.jwt} isOwner={!!vault} /> : <AgentPanel lane={s.lane} vault={null} jwt={() => null} isOwner={false} />}

          {s.caps && (
            <Disclosure label="Fixed in the contract" title="Caps (loosening is timelocked 24 h)">
              <dl className="border-t border-rule-strong">
                {capsRows(s.caps).map((r) => (
                  <div key={r.label} className="flex flex-wrap justify-between gap-x-4 border-b border-rule py-2.5 text-[0.9rem]" title={r.note}>
                    <dt className="text-paper-dim">{r.label}</dt>
                    <dd className="font-mono tabular text-paper">{r.value}</dd>
                  </div>
                ))}
              </dl>
            </Disclosure>
          )}

          <LastResort s={s} />
        </div>
      </div>
      <p className="font-mono text-[0.75rem] leading-relaxed tabular text-paper-mute">
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
  const code = "bg-vault-3 px-1 py-px font-mono text-[0.82rem] text-paper";
  const held = s.slots.flatMap((id, slot) => (id > BigInt(0) ? [`slot ${slot}: NFT #${id.toString()}`] : []));
  return (
    <Disclosure label="Last resort" title="If DeltaDesk is down">
      <div className="max-w-[72ch] space-y-4 text-[0.9rem] leading-relaxed text-paper-dim [&_strong]:font-medium [&_strong]:text-paper">
        <p>
          The owner controls on this page are signed by your Vault in the browser and don&apos;t need desk-agent. If this site or Dynamic&apos;s sign-in is unavailable too, the
          last resort is to call the lane contract yourself from the Vault:
        </p>
        <ol className="list-decimal space-y-3 pl-5 marker:font-mono marker:text-[0.8rem] marker:text-paper-mute">
          <li>
            Export the Vault&apos;s private key from Dynamic (Private Key Exports is enabled for the Vault; the Operator&apos;s export is blocked by its policy, and the Operator
            can&apos;t withdraw anyway). Import it into an EVM wallet and add Robinhood Chain: chain <span className="font-mono text-paper">{CHAIN_ID}</span>, RPC{" "}
            <span className="break-all font-mono text-[0.82rem] text-paper">{RPC_URL}</span>.
          </li>
          <li>
            Open the lane&apos;s verified contract on the Robinhood Chain explorer,{" "}
            <a
              href={`${explorer}?tab=write_contract`}
              target="_blank"
              rel="noreferrer"
              className="break-all font-mono text-[0.82rem] text-paper underline decoration-rule-strong underline-offset-4 hover:decoration-paper"
            >
              {explorer.replace(/^https:\/\//, "")}
            </a>
            , go to the <strong>Write contract</strong> tab (Blockscout may list a clone&apos;s functions under <strong>Write proxy</strong>) and connect that wallet.
          </li>
          <li>
            Optional, to stop the agent first: <code className={code}>pause()</code>, then <code className={code}>revokeOperator()</code>.
          </li>
          <li>
            <code className={code}>exitAll(m)</code> unwinds every position into USDG and NVDA held by the lane. Fill <code className={code}>m</code> as:
            <dl className="mt-2 space-y-2 border-l border-rule-strong pl-3 text-[0.82rem]">
              <div className="flex flex-wrap items-center gap-x-2">
                <dt className="font-mono text-paper">decisionId</dt>
                <dd className="flex min-w-0 items-center gap-1">
                  <span className="break-all font-mono text-paper">{exampleId}</span> <CopyButton text={exampleId} />
                </dd>
                <dd className="w-full text-paper-mute">any non-zero 32-byte value never used before; this one is fresh</dd>
              </div>
              <div className="flex flex-wrap items-center gap-x-2">
                <dt className="font-mono text-paper">deadline</dt>
                <dd className="font-mono text-paper">{deadline}</dd>
                <dd className="w-full text-paper-mute">
                  a Unix time at most {ahead} s ahead of the chain (now {s.chainTime}); this value refreshes with the page, so send within a minute
                </dd>
              </div>
              <div className="flex flex-wrap gap-x-2">
                <dt className="font-mono text-paper">regime, gatesMask</dt>
                <dd className="font-mono text-paper">0, 0</dd>
              </div>
              <div className="flex flex-wrap gap-x-2">
                <dt className="font-mono text-paper">reasonHash</dt>
                <dd className="break-all font-mono text-paper">0x{"0".repeat(64)}</dd>
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
          Only the Vault can call these, and the lane pays out only to the Vault. Explorer: <span className="break-all font-mono text-[0.82rem] text-paper">{EXPLORER_URL}</span>.
        </p>
      </div>
    </Disclosure>
  );
}

function Role({ label, address }: { label: string; address: string | null }) {
  return <Blank label={label}>{address ? <Addr address={address} /> : <span className="text-sm text-paper-dim">none</span>}</Blank>;
}

/** One figure of the lane's books: mono label, the number in Plex Mono, one line of context. */
function Figure({ label, value, sub }: { label: string; value: string; sub?: ReactNode }) {
  return (
    <div className="min-w-0 space-y-2 border-b border-rule py-4 pr-3 odd:pr-4 even:border-l even:pl-4 lg:border-b-0 lg:border-l lg:pl-5 lg:first:border-l-0 lg:first:pl-0">
      <Label as="dt">{label}</Label>
      <dd className="break-words font-mono text-[1.15rem] leading-tight tracking-[-0.02em] tabular text-paper sm:text-[1.75rem] sm:leading-none">{value}</dd>
      {sub && <dd className="truncate text-[0.8rem] text-paper-mute">{sub}</dd>}
    </div>
  );
}

function Budgets({ s }: { s: LaneState }) {
  if (!s.budgets || !s.caps) return <p className="text-[0.9rem] text-paper-dim">Budgets unavailable.</p>;
  const b = s.budgets, c = s.caps;
  const wait = b.nextRerangeAt - s.chainTime;
  const rows = [
    { label: "Turnover left today", value: Number(b.turnoverUsd6) / 1e6, max: Number(c.turnoverUsd6PerDay) / 1e6, fmt: (v: number) => fmtUsd(v) },
    { label: "Reranges left this hour", value: b.rr1h, max: c.reranges1h, fmt: (v: number) => String(v) },
    { label: "Reranges left today", value: b.rr24h, max: c.reranges24h, fmt: (v: number) => String(v) },
  ];
  return (
    <div className="space-y-5">
      {rows.map((r) => {
        const frac = r.max > 0 ? r.value / r.max : 0;
        return (
          <div key={r.label} className="space-y-2">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-[0.9rem]">
              <span className="text-paper-dim">{r.label}</span>
              <span className="font-mono tabular">
                <strong className="font-medium text-paper">{r.fmt(r.value)}</strong> <span className="text-paper-mute">/ {r.fmt(r.max)}</span>
              </span>
            </div>
            <Meter value={r.value} max={r.max} tone={frac < 0.15 ? "warning" : undefined} label={r.label} />
          </div>
        );
      })}
      <p className="border-t border-rule pt-4 text-[0.9rem] text-paper-dim">{wait > 0 ? `Next rerange allowed in ${ago(wait)}.` : "A rerange is allowed now (if the agent's own gates agree)."}</p>
    </div>
  );
}
